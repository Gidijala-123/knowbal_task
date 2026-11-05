import type { Logger } from '../logger.js';

export type FetchLike = typeof fetch;

/** fatal = a human must intervene (revoked refresh token); retry = transient. */
export class ZohoAuthError extends Error {
  constructor(
    message: string,
    readonly fatal: boolean
  ) {
    super(message);
    this.name = 'ZohoAuthError';
  }
}

export type ZohoTokenProvider = {
  getAccessToken(options?: { forceRefresh?: boolean }): Promise<string>;
};

export type ZohoAuthConfig = {
  accountsUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

/**
 * OAuth2 refresh-token flow with an in-memory cache.
 *
 * Two details worth knowing for the walkthrough:
 *  - the cache expires 60s early, so a token that is about to die mid-request
 *    is never used;
 *  - concurrent callers share one in-flight refresh (singleflight), because a
 *    burst of duplicate webhooks would otherwise stampede the token endpoint
 *    and Zoho invalidates tokens that are refreshed too aggressively.
 */
export function createZohoTokenProvider(
  cfg: ZohoAuthConfig,
  fetchImpl: FetchLike,
  log: Logger,
  timeoutMs = 10_000
): ZohoTokenProvider {
  let cache: { accessToken: string; expiresAt: number } | null = null;
  let inflight: Promise<string> | null = null;

  async function refresh(): Promise<string> {
    // Read refresh token dynamically so updating .env takes effect without
    // restarting the server. The token provider is created once at startup,
    // but the refresh token can be rotated by updating the env variable.
    const refreshToken = process.env.ZOHO_REFRESH_TOKEN ?? cfg.refreshToken;
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: refreshToken,
    });

    let response: Response;
    try {
      response = await fetchImpl(`${cfg.accountsUrl}/oauth/v2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new ZohoAuthError(`zoho token endpoint unreachable: ${describe(err)}`, false);
    }

    const json = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
    };

    if (!response.ok || typeof json.access_token !== 'string') {
      cache = null; // clear stale cache so the next attempt forces a fresh fetch
      throw new ZohoAuthError(
        `zoho token refresh rejected (http ${response.status}${json.error ? `, ${json.error}` : ''})`,
        json.error === 'invalid_grant'
      );
    }

    const expiresIn = Number(json.expires_in ?? 3600);
    cache = { accessToken: json.access_token, expiresAt: Date.now() + (expiresIn - 60) * 1000 };
    log.info('zoho access token refreshed', { expiresInSeconds: expiresIn });
    return cache.accessToken;
  }

  return {
    async getAccessToken(options) {
      if (!options?.forceRefresh && cache && cache.expiresAt > Date.now()) return cache.accessToken;
      inflight ??= refresh().finally(() => {
        inflight = null;
      });
      return inflight;
    },
  };
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.name === 'TimeoutError' ? 'timeout' : err.message;
  return String(err);
}
