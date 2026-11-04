/**
 * In-memory stand-in for the Postgres schema, mirroring the unique constraints
 * and the lease logic of the SQL functions. It exists so the idempotency and
 * Zoho-outage guarantees can be proven in milliseconds, with no project, no
 * credentials and no network.
 */
import type {
  ClientRow,
  CrmSyncDueRow,
  CrmSyncResult,
  DocumentRow,
  EntitlementDownloadRow,
  EventStatus,
  GrantInput,
  PurchaseForSync,
  Repository,
} from '../../src/db/repository.js';

export type EventLogRow = {
  eventId: string;
  type: string;
  status: 'received' | EventStatus;
  error?: string;
  purchaseId?: string;
};

export type EntitlementRow = { clientId: string; documentId: string; purchaseId: string; revokedAt: string | null };

export type MemoryState = {
  clients: Map<string, ClientRow>;
  documents: Map<string, DocumentRow>;
  events: Map<string, EventLogRow>;
  purchases: Map<string, { id: string; clientId: string; documentId: string; sessionId: string; paymentIntentId: string; amountCents: number; currency: string; paidAt: string; refundedAt: string | null }>;
  entitlements: EntitlementRow[];
  crm: Map<string, { purchaseId: string; zohoDealId: string; status: CrmSyncDueRow['status']; attempts: number; lastError: string | null; lastAttemptAt: number }>;
};

export type MemoryRepository = Repository & {
  state: MemoryState;
  /** Make the next grantPurchase throw, to prove the 500/retry path. */
  failNextGrant(error: Error): void;
  /** Rewind the lease so a 'syncing' row looks stale, like a crashed worker. */
  expireLeases(): void;
};

const LEASE_MS = 2 * 60_000;

export function createMemoryRepository(options?: {
  clients?: ClientRow[];
  documents?: DocumentRow[];
  entitlements?: EntitlementRow[];
  /** auth user id -> client id, the link the real schema keeps in `clients`. */
  logins?: Record<string, string>;
}): MemoryRepository {
  const state: MemoryState = {
    clients: new Map((options?.clients ?? []).map((c) => [c.id, c])),
    documents: new Map((options?.documents ?? []).map((d) => [d.id, d])),
    events: new Map(),
    purchases: new Map(),
    entitlements: [...(options?.entitlements ?? [])],
    crm: new Map(),
  };

  let grantFailure: Error | null = null;
  let purchaseCounter = 0;

  const repo: MemoryRepository = {
    state,

    failNextGrant(error) {
      grantFailure = error;
    },

    expireLeases() {
      for (const row of state.crm.values()) {
        if (row.status === 'syncing') row.lastAttemptAt = Date.now() - LEASE_MS - 1;
      }
    },

    async recordEvent({ eventId, type }) {
      const existing = state.events.get(eventId);
      if (!existing) {
        state.events.set(eventId, { eventId, type, status: 'received' });
        return 'new';
      }
      return existing.status === 'processed' || existing.status === 'quarantined' ? 'done' : 'retry';
    },

    async markEvent({ eventId, status, error, purchaseId }) {
      const row = state.events.get(eventId);
      if (!row) throw new Error(`markEvent for unknown event ${eventId}`);
      state.events.set(eventId, { ...row, status, error, purchaseId });
    },

    async findClientByAuthUserId(authUserId) {
      const clientId = options?.logins?.[authUserId] ?? authUserId;
      return state.clients.get(clientId) ?? null;
    },

    async findClientById(clientId) {
      return state.clients.get(clientId) ?? null;
    },

    async findDocumentById(documentId) {
      return state.documents.get(documentId) ?? null;
    },

    async setStripeCustomerId(clientId, stripeCustomerId) {
      const client = state.clients.get(clientId);
      if (client) state.clients.set(clientId, { ...client, stripeCustomerId });
    },

    async hasActiveEntitlement(clientId, documentId) {
      return state.entitlements.some((e) => e.clientId === clientId && e.documentId === documentId && !e.revokedAt);
    },

    async findEntitlementForDownload(clientId, documentId) {
      const entitlement = state.entitlements.find(
        (e) => e.clientId === clientId && e.documentId === documentId && !e.revokedAt
      );
      if (!entitlement) return null;
      const document = state.documents.get(documentId);
      if (!document) return null;
      return { storagePath: `sample-document.pdf`, title: document.title } satisfies EntitlementDownloadRow;
    },

    async grantPurchase(input: GrantInput) {
      if (grantFailure) {
        const error = grantFailure;
        grantFailure = null;
        throw error;
      }

      // unique stripe_session_id
      const existing = [...state.purchases.values()].find((p) => p.sessionId === input.stripeSessionId);
      if (existing) {
        touchEvent(input.eventId, existing.id);
        return { purchaseId: existing.id, isNew: false };
      }

      purchaseCounter += 1;
      const purchaseId = `purchase-${purchaseCounter}`;
      state.purchases.set(purchaseId, {
        id: purchaseId,
        clientId: input.clientId,
        documentId: input.documentId,
        sessionId: input.stripeSessionId,
        paymentIntentId: input.stripePaymentIntentId,
        amountCents: input.amountCents,
        currency: input.currency,
        paidAt: input.paidAt.toISOString(),
        refundedAt: null,
      });

      // unique (client_id, document_id)
      const owns = state.entitlements.some((e) => e.clientId === input.clientId && e.documentId === input.documentId);
      if (!owns) {
        state.entitlements.push({ clientId: input.clientId, documentId: input.documentId, purchaseId, revokedAt: null });
      }

      // unique purchase_id in the outbox
      if (!state.crm.has(purchaseId)) {
        state.crm.set(purchaseId, {
          purchaseId,
          zohoDealId: input.zohoDealId,
          status: 'pending',
          attempts: 0,
          lastError: null,
          lastAttemptAt: 0,
        });
      }

      touchEvent(input.eventId, purchaseId);
      return { purchaseId, isNew: true };

      function touchEvent(eventId: string, id: string) {
        const row = state.events.get(eventId);
        if (row) state.events.set(eventId, { ...row, status: 'processed', purchaseId: id });
      }
    },

    async claimCrmSync(purchaseId) {
      const row = state.crm.get(purchaseId);
      if (!row) return null;
      const leaseIsStale = row.status === 'syncing' && row.lastAttemptAt < Date.now() - LEASE_MS;
      if (!(row.status === 'pending' || row.status === 'failed' || leaseIsStale)) return null;
      row.status = 'syncing';
      row.attempts += 1;
      row.lastAttemptAt = Date.now();
      return { zohoDealId: row.zohoDealId, attempts: row.attempts };
    },

    async finishCrmSync(purchaseId, result: CrmSyncResult, error) {
      const row = state.crm.get(purchaseId);
      if (!row || row.status !== 'syncing') return;
      row.status = result === 'synced' ? 'synced' : result === 'fatal' ? 'failed' : 'pending';
      row.lastError = result === 'synced' ? null : (error ?? 'unknown error');
      row.lastAttemptAt = Date.now();
    },

    async listCrmSyncDue(limit) {
      const rows = [...state.crm.values()].filter(
        (r) => r.status === 'pending' || r.status === 'failed' || (r.status === 'syncing' && r.lastAttemptAt < Date.now() - LEASE_MS)
      );
      return rows.slice(0, limit).map<CrmSyncDueRow>((r) => ({
        purchaseId: r.purchaseId,
        zohoDealId: r.zohoDealId,
        status: r.status,
        attempts: r.attempts,
        lastError: r.lastError,
      }));
    },

    async findPurchaseForSync(purchaseId): Promise<PurchaseForSync | null> {
      const purchase = state.purchases.get(purchaseId);
      const crm = state.crm.get(purchaseId);
      if (!purchase || !crm) return null;
      return {
        zohoDealId: crm.zohoDealId,
        amountCents: purchase.amountCents,
        currency: purchase.currency,
        paidAt: purchase.paidAt,
        stripePaymentIntentId: purchase.paymentIntentId,
        stripeSessionId: purchase.sessionId,
      };
    },

    async revokeAccess(paymentIntentId, eventId, reason) {
      const purchase = [...state.purchases.values()].find((p) => p.paymentIntentId === paymentIntentId);
      if (!purchase) return 0;
      purchase.refundedAt = new Date().toISOString();
      let revoked = 0;
      state.entitlements = state.entitlements.map((e) => {
        if (e.purchaseId !== purchase.id || e.revokedAt) return e;
        revoked += 1;
        return { ...e, revokedAt: new Date().toISOString() };
      });
      const row = state.events.get(eventId);
      if (row) state.events.set(eventId, { ...row, status: 'processed', error: reason });
      return revoked;
    },
  };

  return repo;
}
