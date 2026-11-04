/**
 * The single data port used by every server route and the webhook handler.
 *
 * Having one interface (instead of sprinkling supabase-js calls through the
 * handlers) is what lets the idempotency tests run against an in-memory
 * database in milliseconds, with no project and no credentials.
 */

export type ClientRow = {
  id: string;
  email: string;
  zohoDealId: string | null;
  stripeCustomerId: string | null;
};

export type DocumentRow = {
  id: string;
  title: string;
  priceCents: number;
  currency: string;
};

export type GrantInput = {
  clientId: string;
  documentId: string;
  stripeSessionId: string;
  stripePaymentIntentId: string;
  amountCents: number;
  currency: string;
  paidAt: Date;
  zohoDealId: string;
  eventId: string;
};

export type EventStatus = 'processed' | 'quarantined' | 'failed';

export type CrmSyncResult = 'synced' | 'retry' | 'fatal';

export type CrmSyncDueRow = {
  purchaseId: string;
  zohoDealId: string;
  status: 'pending' | 'syncing' | 'synced' | 'failed';
  attempts: number;
  lastError: string | null;
};

export type EntitlementDownloadRow = {
  storagePath: string;
  title: string;
};

/** Everything Zoho needs about a payment, read only after the row is claimed. */
export type PurchaseForSync = {
  zohoDealId: string;
  amountCents: number;
  currency: string;
  paidAt: string;
  stripePaymentIntentId: string;
  stripeSessionId: string;
};

export interface Repository {
  /**
   * Ledger gate, three-way on purpose:
   *   'new'   first delivery of this event id
   *   'retry' we recorded it before but never finished (crash, DB failure) —
   *           Stripe will redeliver the SAME event id, so this must proceed or
   *           a paid customer stays locked out forever
   *   'done'  already processed or quarantined — stop, do nothing again
   */
  recordEvent(input: { eventId: string; type: string }): Promise<'new' | 'retry' | 'done'>;
  markEvent(input: { eventId: string; status: EventStatus; error?: string; purchaseId?: string }): Promise<void>;

  findClientByAuthUserId(authUserId: string): Promise<ClientRow | null>;
  findClientById(clientId: string): Promise<ClientRow | null>;
  findDocumentById(documentId: string): Promise<DocumentRow | null>;
  setStripeCustomerId(clientId: string, stripeCustomerId: string): Promise<void>;

  /** Entitlement that has not been revoked — used to block duplicate checkout. */
  hasActiveEntitlement(clientId: string, documentId: string): Promise<boolean>;
  /** Path is only ever returned to the server, never to the browser. */
  findEntitlementForDownload(clientId: string, documentId: string): Promise<EntitlementDownloadRow | null>;

  /** One transaction: purchase + entitlement + crm_sync(pending). Throws on failure. */
  grantPurchase(input: GrantInput): Promise<{ purchaseId: string; isNew: boolean }>;

  /** Atomic claim; null means already synced or another worker holds the lease. */
  claimCrmSync(purchaseId: string): Promise<{ zohoDealId: string; attempts: number } | null>;
  findPurchaseForSync(purchaseId: string): Promise<PurchaseForSync | null>;
  finishCrmSync(purchaseId: string, result: CrmSyncResult, error?: string): Promise<void>;
  listCrmSyncDue(limit: number): Promise<CrmSyncDueRow[]>;

  revokeAccess(paymentIntentId: string, eventId: string, reason: string): Promise<number>;
}

export interface StoragePort {
  /** Short-lived signed URL for a private bucket object. */
  createDownloadUrl(storagePath: string, ttlSeconds: number): Promise<string>;
}

export interface AuthPort {
  /** Verify a Supabase access token and return the authenticated user id. */
  verifyAccessToken(accessToken: string): Promise<{ userId: string; email: string } | null>;
}
