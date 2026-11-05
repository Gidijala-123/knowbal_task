import type { Logger } from '../logger.js';
import { ZohoAuthError, type FetchLike, type ZohoTokenProvider } from './oauth.js';

export type ZohoOutcome =
  | { kind: 'synced'; detail?: string }
  | { kind: 'retry'; reason: string }
  | { kind: 'fatal'; reason: string };

export type PaidDealFields = {
  stripePaymentIntentId: string;
  paidAmount: number;
  paidAt: string;
};

export type ZohoDealClient = {
  markDealPaid(dealId: string, fields: PaidDealFields): Promise<ZohoOutcome>;
};

/**
 * Zoho answers a bad record with HTTP 200 and a per-record `code`, so the body
 * has to be inspected as well as the status. Codes not listed here are treated
 * as retryable: a permanently odd code then shows up in the retry list with its
 * text in `last_error`, which is a visible failure rather than a silent one.
 */
const FATAL_CODES = new Set([
  'INVALID_DATA',
  'MISSING_REQUIRED_FIELDS',
  'INVALID_FIELD',
  'FIELD_NOT_FOUND',
  'INVALID_MODULE',
  'CANNOT_MODIFY',
  'DELETED_RECORD',
]);

const RETRYABLE_CODES = new Set([
  'INTERNAL_ERROR',
  'RATE_LIMIT_EXCEEDED',
  'MAINTENANCE',
  'MODULE_NOT_AVAILABLE',
  'RECORD_IN_QUEUE',
]);

export type ZohoDealConfig = {
  apiUrl: string;
  paidStage: string;
  simulateFailure: boolean;
};

export function createZohoDealClient(
  cfg: ZohoDealConfig,
  tokens: ZohoTokenProvider,
  fetchImpl: FetchLike,
  log: Logger,
  timeoutMs = 15_000
): ZohoDealClient {
  return {
    async markDealPaid(dealId, fields) {
      if (cfg.simulateFailure) {
        return { kind: 'retry', reason: 'simulated outage (ZOHO_SIMULATE_FAILURE=true)' };
      }

      let outcome: ZohoOutcome;
      try {
        outcome = await attempt(dealId, fields, false);
      } catch (err) {
        outcome = classifyThrown(err);
      }

      // One automatic refresh, then one retry — the standard response to an
      // expired access token, which is the most common 401 cause.
      if (outcome.kind === 'retry' && outcome.reason === 'http_401') {
        log.info('zoho rejected the cached token, refreshing once');
        try {
          outcome = await attempt(dealId, fields, true);
        } catch (err) {
          outcome = classifyThrown(err);
        }
        if (outcome.kind === 'retry' && outcome.reason === 'http_401') {
          return {
            kind: 'fatal',
            reason: 'zoho kept rejecting the token after a refresh (check client credentials and scopes)',
          };
        }
      }
      return outcome;
    },
  };

  async function attempt(dealId: string, fields: PaidDealFields, forceRefresh: boolean): Promise<ZohoOutcome> {
    const accessToken = await tokens.getAccessToken({ forceRefresh });
    const record = {
      id: dealId,
      Stage: cfg.paidStage,
      Payment_Status: 'Paid',
      Stripe_Payment_ID: fields.stripePaymentIntentId,
      Paid_Amount: roundTo2(fields.paidAmount / 100),
      Paid_At: fields.paidAt,
    };

    const response = await fetchImpl(`${cfg.apiUrl}/Deals/${encodeURIComponent(dealId)}`, {
      method: 'PUT',
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ data: [record] }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const payload = (await response.json().catch(() => null)) as ZohoBody | null;
    log.info('zoho deal update response', { status: response.status, code: payload?.data?.[0]?.code, message: payload?.data?.[0]?.message ?? payload?.message });
    return classify(response.status, payload);
  }
}

type ZohoBody = {
  data?: Array<{ code?: string; message?: string; details?: { id?: string } }>;
  info?: Record<string, unknown>;
  message?: string;
};

function classify(status: number, body: ZohoBody | null): ZohoOutcome {
  if (status === 401) return { kind: 'retry', reason: 'http_401' };
  if (status === 429) return { kind: 'retry', reason: 'http_429 rate limited' };
  if (status === 404) return { kind: 'fatal', reason: 'http_404 deal not found in this org' };
  if (status === 400 || status === 403) {
    return { kind: 'fatal', reason: `http_${status} ${body?.data?.[0]?.message ?? body?.message ?? 'rejected by zoho'}` };
  }
  if (status >= 500) return { kind: 'retry', reason: `http_${status} zoho server error` };

  const code = (body?.data?.[0]?.code ?? '').toUpperCase();
  const message = body?.data?.[0]?.message ?? '';
  if (code === 'SUCCESS' || code === 'DUPLICATE_DATA' || code === 'SAVING') {
    // DUPLICATE_DATA means the record already held these values, which is
    // exactly what a replayed sync should report: nothing more to do.
    return { kind: 'synced', detail: code.toLowerCase() };
  }
  if (FATAL_CODES.has(code)) return { kind: 'fatal', reason: `${code} ${message}`.trim() };
  if (RETRYABLE_CODES.has(code)) return { kind: 'retry', reason: `${code} ${message}`.trim() };
  return { kind: 'retry', reason: `unexpected zoho code "${code || 'none'}" ${message}`.trim() };
}

function classifyThrown(err: unknown): ZohoOutcome {
  if (err instanceof ZohoAuthError) {
    return err.fatal
      ? { kind: 'fatal', reason: `${err.message} — re-run \`npm run zoho:bootstrap\` to mint a refresh token` }
      : { kind: 'retry', reason: err.message };
  }
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return { kind: 'retry', reason: 'zoho request timed out' };
  }
  return { kind: 'retry', reason: `network error: ${err instanceof Error ? err.message : String(err)}` };
}

function roundTo2(value: number): number {
  return Math.round(value * 100) / 100;
}
