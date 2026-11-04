import type { Repository } from '../db/repository.js';
import type { Logger } from '../logger.js';
import type { ZohoDealClient } from '../zoho/deals.js';

export type SyncOutcome = { status: 'synced' | 'retry' | 'fatal' | 'skipped'; detail?: string };

export type CrmSyncService = {
  syncPurchase(purchaseId: string): Promise<SyncOutcome>;
  retryDue(options?: { purchaseId?: string; limit?: number }): Promise<SyncOutcome[]>;
};

/**
 * The only place that talks to Zoho. It never throws: the webhook needs to
 * return 200 regardless, and the retry command needs a per-row verdict.
 */
export function createCrmSyncService(deps: {
  repo: Repository;
  zoho: ZohoDealClient;
  log: Logger;
}): CrmSyncService {
  const { repo, zoho, log } = deps;

  async function syncPurchase(purchaseId: string): Promise<SyncOutcome> {
    // The claim is the concurrency gate: a row already 'synced', or 'syncing'
    // with a live lease, returns null and nothing reaches Zoho twice.
    const claim = await repo.claimCrmSync(purchaseId);
    if (!claim) {
      log.info('crm sync skipped', { purchaseId });
      return { status: 'skipped', detail: 'already synced, or another attempt holds the lease' };
    }

    const purchase = await repo.findPurchaseForSync(purchaseId);
    if (!purchase) {
      await repo.finishCrmSync(purchaseId, 'fatal', 'purchase row disappeared');
      return { status: 'fatal', detail: 'purchase row disappeared' };
    }

    const outcome = await zoho.markDealPaid(claim.zohoDealId, {
      stripePaymentIntentId: purchase.stripePaymentIntentId,
      paidAmount: purchase.amountCents,
      paidAt: purchase.paidAt,
    });

    if (outcome.kind === 'synced') {
      await repo.finishCrmSync(purchaseId, 'synced');
      log.info('zoho deal marked paid', { dealId: claim.zohoDealId, attempts: claim.attempts });
      return { status: 'synced', detail: outcome.detail };
    }

    if (outcome.kind === 'fatal') {
      await repo.finishCrmSync(purchaseId, 'fatal', outcome.reason);
      log.warn('zoho rejected the deal update permanently', { dealId: claim.zohoDealId, reason: outcome.reason });
      return { status: 'fatal', detail: outcome.reason };
    }

    // Transient: back to pending with the reason stored, so the portal shows
    // "Pending" and the retry command picks it up later.
    await repo.finishCrmSync(purchaseId, 'retry', outcome.reason);
    log.warn('zoho sync deferred', { dealId: claim.zohoDealId, attempts: claim.attempts, reason: outcome.reason });
    return { status: 'retry', detail: outcome.reason };
  }

  async function retryDue(options: { purchaseId?: string; limit?: number } = {}): Promise<SyncOutcome[]> {
    if (options.purchaseId) return [await syncPurchase(options.purchaseId)];
    const due = await repo.listCrmSyncDue(options.limit ?? 50);
    log.info('retrying crm sync rows', { count: due.length });
    const outcomes: SyncOutcome[] = [];
    // Sequential on purpose: a burst of parallel PUTs is the quickest way to a
    // Zoho 429, and this job is not latency sensitive.
    for (const row of due) outcomes.push(await syncPurchase(row.purchaseId));
    return outcomes;
  }

  return { syncPurchase, retryDue };
}
