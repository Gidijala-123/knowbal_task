import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, getDownloadUrl, startCheckout } from './api';
import { supabase } from './supabaseClient';

type DocumentRow = { id: string; title: string; price_cents: number; currency: string };
type EntitlementRow = { document_id: string; granted_at: string; revoked_at: string | null };
type PurchaseRow = { id: string; document_id: string; amount_cents: number; currency: string; paid_at: string; refunded_at: string | null };
type CrmRow = { purchase_id: string; status: 'pending' | 'syncing' | 'synced' | 'failed'; attempts: number; last_error: string | null; synced_at: string | null };

type Snapshot = {
  documents: DocumentRow[];
  entitlements: EntitlementRow[];
  purchases: PurchaseRow[];
  crm: CrmRow[];
};

const EMPTY: Snapshot = { documents: [], entitlements: [], purchases: [], crm: [] };
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 30;

export function Portal({ email }: { email: string }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyDocument, setBusyDocument] = useState<string | null>(null);
  const [waitingForWebhook, setWaitingForWebhook] = useState(false);
  const entitlementCountBeforePayment = useRef(0);

  // Every query here is answered by Postgres under RLS. The browser asks for
  // "my" rows and cannot ask for anyone else's, even with a forged filter.
  const refresh = useCallback(async (): Promise<Snapshot> => {
    const [documents, entitlements, purchases, crm] = await Promise.all([
      supabase.from('documents_public').select('id, title, price_cents, currency'),
      supabase.from('entitlements').select('document_id, granted_at, revoked_at'),
      supabase.from('purchases').select('id, document_id, amount_cents, currency, paid_at, refunded_at'),
      supabase.from('crm_sync').select('purchase_id, status, attempts, last_error, synced_at'),
    ]);

    const problems = [documents, entitlements, purchases, crm].filter((r) => r.error);
    if (problems.length > 0) {
      setLoadError(problems.map((p) => (p.error as { message: string }).message).join('; '));
      return snapshot;
    }
    setLoadError(null);
    const next: Snapshot = {
      documents: (documents.data ?? []) as DocumentRow[],
      entitlements: (entitlements.data ?? []) as EntitlementRow[],
      purchases: (purchases.data ?? []) as PurchaseRow[],
      crm: (crm.data ?? []) as CrmRow[],
    };
    setSnapshot(next);
    return next;
  }, [snapshot]);

  useEffect(() => {
    void refresh().finally(() => setLoading(false));
  }, [refresh]);

  // Stripe's success redirect only means "go and look". Access is granted by
  // the webhook, which may arrive after the browser has already bounced back.
  const justPaid = new URLSearchParams(window.location.search).get('payment') === 'completed';
  useEffect(() => {
    if (!justPaid) return;
    entitlementCountBeforePayment.current = snapshot.entitlements.length;
    setWaitingForWebhook(true);
    let attempts = 0;

    const timer = window.setInterval(async () => {
      attempts += 1;
      const next = await refresh();
      const unlocked = next.entitlements.length > entitlementCountBeforePayment.current;
      if (unlocked || attempts >= POLL_MAX_ATTEMPTS) {
        window.clearInterval(timer);
        setWaitingForWebhook(false);
        if (!unlocked) {
          setNotice('Payment looks complete but the receipt has not been processed yet. Refresh in a few seconds.');
        }
      }
    }, POLL_INTERVAL_MS);

    return () => window.clearInterval(timer);
    // snapshot is intentionally excluded: the baseline is captured once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [justPaid]);

  async function buy(documentId: string) {
    setBusyDocument(documentId);
    setNotice(null);
    try {
      const { checkoutUrl } = await startCheckout(documentId);
      window.location.assign(checkoutUrl);
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : 'Could not start the payment.');
    } finally {
      setBusyDocument(null);
    }
  }

  async function download(documentId: string) {
    setBusyDocument(documentId);
    setNotice(null);
    try {
      const { url } = await getDownloadUrl(documentId);
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : 'Could not open the download.');
    } finally {
      setBusyDocument(null);
    }
  }

  return (
    <main className="page">
      <header className="row spread">
        <div>
          <h1>Client portal</h1>
          <p className="muted">
            Signed in as <strong>{email}</strong>
          </p>
        </div>
        <div className="row">
          <button className="ghost" type="button" onClick={() => void refresh()}>
            Refresh
          </button>
          <button className="ghost" type="button" onClick={() => void supabase.auth.signOut()}>
            Sign out
          </button>
        </div>
      </header>

      {waitingForWebhook && <p className="notice">Waiting for Stripe to confirm your payment...</p>}
      {notice && <p className="notice">{notice}</p>}
      {loadError && <p className="error">Supabase refused the query: {loadError}</p>}

      {loading ? (
        <p className="muted">Loading your access status...</p>
      ) : (
        <ul className="cards">
          {snapshot.documents.map((document) => {
            const entitlement = snapshot.entitlements.find((e) => e.document_id === document.id && !e.revoked_at);
            const purchase = snapshot.purchases.find((p) => p.document_id === document.id && !p.refunded_at);
            const crm = purchase ? snapshot.crm.find((c) => c.purchase_id === purchase.id) : undefined;
            const busy = busyDocument === document.id;

            return (
              <li key={document.id} className="card">
                <div className="card-head">
                  <h2>{document.title}</h2>
                  <span className={entitlement ? 'badge unlocked' : 'badge locked'}>
                    {entitlement ? 'Unlocked' : 'Locked'}
                  </span>
                </div>

                <dl>
                  <div>
                    <dt>Price</dt>
                    <dd>{formatMoney(document.price_cents, document.currency)}</dd>
                  </div>
                  <div>
                    <dt>Purchase</dt>
                    <dd>
                      {purchase
                        ? `Paid ${formatMoney(purchase.amount_cents, purchase.currency)} on ${formatDate(purchase.paid_at)}`
                        : 'No payment recorded'}
                    </dd>
                  </div>
                  <div>
                    <dt>CRM sync</dt>
                    <dd>
                      <CrmStatus crm={crm} />
                    </dd>
                  </div>
                </dl>

                <div className="row">
                  {entitlement ? (
                    <button type="button" disabled={busy} onClick={() => void download(document.id)}>
                      {busy ? 'Preparing...' : 'Download document'}
                    </button>
                  ) : (
                    <button type="button" disabled={busy || waitingForWebhook} onClick={() => void buy(document.id)}>
                      {busy ? 'Redirecting...' : `Buy access for ${formatMoney(document.price_cents, document.currency)}`}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="footnote">
        Status comes straight from Supabase under Row Level Security. Stripe and Zoho secrets never reach this
        bundle; only the public anon key is present here.
      </p>
    </main>
  );
}

function CrmStatus({ crm }: { crm: CrmRow | undefined }) {
  if (!crm) return <span className="muted">Not applicable</span>;
  if (crm.status === 'synced') return <span className="ok">Synced to Zoho</span>;
  if (crm.status === 'failed') {
    return (
      <span className="error" title={crm.last_error ?? ''}>
        Failed after {crm.attempts} attempt(s): {crm.last_error ?? 'unknown reason'}
      </span>
    );
  }
  // 'pending' and 'syncing' both mean "not in the CRM yet" to the client.
  return (
    <span className="warn">
      Pending{crm.attempts > 0 ? ` (${crm.attempts} attempt(s))` : ''}
      {crm.last_error ? `: ${crm.last_error}` : ''}
    </span>
  );
}

function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}
