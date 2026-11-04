import type { SupabaseClient } from '@supabase/supabase-js';

import type {
  ClientRow,
  CrmSyncDueRow,
  DocumentRow,
  EntitlementDownloadRow,
  EventStatus,
  GrantInput,
  Repository,
  StoragePort,
} from './repository.js';

/** Postgres unique-violation: the event id was already in the ledger. */
const UNIQUE_VIOLATION = '23505';

function fail(context: string, error: { message?: string; code?: string } | null): void {
  if (!error) return;
  throw new Error(`${context}: ${error.code ?? ''} ${error.message ?? 'unknown error'}`.trim());
}

type Db = SupabaseClient;

export function createSupabaseRepository(db: Db): Repository {
  const clientFromRow = (row: Record<string, unknown>): ClientRow => ({
    id: String(row.id),
    email: String(row.email),
    zohoDealId: row.zoho_deal_id == null ? null : String(row.zoho_deal_id),
    stripeCustomerId: row.stripe_customer_id == null ? null : String(row.stripe_customer_id),
  });

  return {
    async recordEvent({ eventId, type }) {
      const { error } = await db
        .from('stripe_events')
        .insert({ event_id: eventId, type, status: 'received' });
      if (!error) return 'new';
      if (error.code !== UNIQUE_VIOLATION) fail('recordEvent', error);

      // Already in the ledger: only a completed or quarantined verdict may stop
      // us from working again, so a crashed delivery can still be finished.
      const { data, error: lookup } = await db
        .from('stripe_events')
        .select('status')
        .eq('event_id', eventId)
        .maybeSingle();
      fail('recordEvent lookup', lookup);
      const status = (data as { status?: string } | null)?.status;
      return status === 'processed' || status === 'quarantined' ? 'done' : 'retry';
    },

    async markEvent({ eventId, status, error, purchaseId }) {
      const { error: q } = await db
        .from('stripe_events')
        .update({
          status: status satisfies EventStatus,
          processed_at: new Date().toISOString(),
          error: error ?? null,
          purchase_id: purchaseId ?? null,
        })
        .eq('event_id', eventId);
      fail('markEvent', q);
    },

    async findClientByAuthUserId(authUserId) {
      const { data, error } = await db
        .from('clients')
        .select('id, email, zoho_deal_id, stripe_customer_id')
        .eq('auth_user_id', authUserId)
        .maybeSingle();
      fail('findClientByAuthUserId', error);
      return data ? clientFromRow(data as Record<string, unknown>) : null;
    },

    async findClientById(clientId) {
      const { data, error } = await db
        .from('clients')
        .select('id, email, zoho_deal_id, stripe_customer_id')
        .eq('id', clientId)
        .maybeSingle();
      fail('findClientById', error);
      return data ? clientFromRow(data as Record<string, unknown>) : null;
    },

    async findDocumentById(documentId) {
      const { data, error } = await db
        .from('documents')
        .select('id, title, price_cents, currency')
        .eq('id', documentId)
        .maybeSingle();
      fail('findDocumentById', error);
      if (!data) return null;
      return {
        id: String(data.id),
        title: String(data.title),
        priceCents: Number(data.price_cents),
        currency: String(data.currency),
      } satisfies DocumentRow;
    },

    async setStripeCustomerId(clientId, stripeCustomerId) {
      const { error } = await db
        .from('clients')
        .update({ stripe_customer_id: stripeCustomerId })
        .eq('id', clientId);
      fail('setStripeCustomerId', error);
    },

    async hasActiveEntitlement(clientId, documentId) {
      const { data, error } = await db
        .from('entitlements')
        .select('id')
        .eq('client_id', clientId)
        .eq('document_id', documentId)
        .is('revoked_at', null)
        .limit(1);
      fail('hasActiveEntitlement', error);
      return (data?.length ?? 0) > 0;
    },

    async findEntitlementForDownload(clientId, documentId) {
      const { data, error } = await db
        .from('entitlements')
        .select('revoked_at, documents(storage_path, title)')
        .eq('client_id', clientId)
        .eq('document_id', documentId)
        .is('revoked_at', null)
        .maybeSingle();
      fail('findEntitlementForDownload', error);
      const doc = data?.documents as unknown as { storage_path?: string; title?: string } | null;
      if (!data || !doc?.storage_path) return null;
      return { storagePath: doc.storage_path, title: String(doc.title ?? '') } satisfies EntitlementDownloadRow;
    },

    async grantPurchase(input: GrantInput) {
      const { data, error } = await db.rpc('grant_purchase', {
        p_client_id: input.clientId,
        p_document_id: input.documentId,
        p_stripe_session_id: input.stripeSessionId,
        p_stripe_payment_intent_id: input.stripePaymentIntentId,
        p_amount_cents: input.amountCents,
        p_currency: input.currency,
        p_paid_at: input.paidAt.toISOString(),
        p_zoho_deal_id: input.zohoDealId,
        p_event_id: input.eventId,
      });
      fail('grant_purchase', error);
      const row = data as { purchase_id: string; is_new: boolean } | null;
      if (!row?.purchase_id) throw new Error('grant_purchase returned no purchase id');
      return { purchaseId: String(row.purchase_id), isNew: Boolean(row.is_new) };
    },

    async claimCrmSync(purchaseId) {
      const { data, error } = await db.rpc('claim_crm_sync', { p_purchase_id: purchaseId });
      fail('claim_crm_sync', error);
      const rows = (data ?? []) as Array<{ zoho_deal_id: string; attempts: number }>;
      const first = rows[0];
      if (!first) return null;
      return { zohoDealId: String(first.zoho_deal_id), attempts: Number(first.attempts) };
    },

    async findPurchaseForSync(purchaseId) {
      const { data, error } = await db
        .from('purchases')
        .select('stripe_session_id, stripe_payment_intent_id, amount_cents, currency, paid_at, crm_sync(zoho_deal_id)')
        .eq('id', purchaseId)
        .maybeSingle();
      fail('findPurchaseForSync', error);
      if (!data) return null;
      const crm = data.crm_sync as unknown as { zoho_deal_id?: string } | null;
      if (!crm?.zoho_deal_id) return null;
      return {
        zohoDealId: String(crm.zoho_deal_id),
        amountCents: Number(data.amount_cents),
        currency: String(data.currency),
        paidAt: String(data.paid_at),
        stripePaymentIntentId: String(data.stripe_payment_intent_id),
        stripeSessionId: String(data.stripe_session_id),
      };
    },

    async finishCrmSync(purchaseId, result, errorText) {
      const { error } = await db.rpc('finish_crm_sync', {
        p_purchase_id: purchaseId,
        p_result: result,
        p_error: errorText ?? null,
      });
      fail('finish_crm_sync', error);
    },

    async listCrmSyncDue(limit) {
      const { data, error } = await db.rpc('list_crm_sync_due', { p_limit: limit });
      fail('list_crm_sync_due', error);
      return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
        purchaseId: String(r.purchase_id),
        zohoDealId: String(r.zoho_deal_id),
        status: r.status as CrmSyncDueRow['status'],
        attempts: Number(r.attempts),
        lastError: r.last_error == null ? null : String(r.last_error),
      }));
    },

    async revokeAccess(paymentIntentId, eventId, reason) {
      const { data, error } = await db.rpc('revoke_access_for_payment_intent', {
        p_stripe_payment_intent_id: paymentIntentId,
        p_event_id: eventId,
        p_reason: reason,
      });
      fail('revoke_access_for_payment_intent', error);
      return Number(data ?? 0);
    },
  };
}

export function createSupabaseStorage(db: Db, bucket: string): StoragePort {
  return {
    async createDownloadUrl(storagePath, ttlSeconds) {
      const { data, error } = await db.storage.from(bucket).createSignedUrl(storagePath, ttlSeconds);
      fail('createSignedUrl', error);
      if (!data?.signedUrl) throw new Error('signed url unavailable');
      return data.signedUrl;
    },
  };
}
