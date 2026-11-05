import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
  // The latest data, kept outside state so `refresh` has no reactive dependency.
  const snapshotRef = useRef<Snapshot>(EMPTY);
  const entitlementCountBeforePayment = useRef(0);

  // Every query here is answered by Postgres under RLS. The browser asks for
  // "my" rows and cannot ask for anyone else's, even with a forged filter.
  // The four run concurrently, so their cost is one round trip, not four.
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
      return snapshotRef.current;
    }
    setLoadError(null);
    const next: Snapshot = {
      documents: (documents.data ?? []) as DocumentRow[],
      entitlements: (entitlements.data ?? []) as EntitlementRow[],
      purchases: (purchases.data ?? []) as PurchaseRow[],
      crm: (crm.data ?? []) as CrmRow[],
    };
    snapshotRef.current = next;
    setSnapshot(next);
    return next;
  }, []);

  useEffect(() => {
    void refresh().finally(() => setLoading(false));
  }, [refresh]);

  // Stripe's success redirect only means "go and look". Access is granted by
  // the webhook, which may arrive after the browser has already bounced back.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const justPaid = params.get('payment') === 'completed';
    const sessionId = params.get('session_id') ?? '(none)';

    if (!justPaid) return;

    // Clear the query string immediately — must happen before any state update
    // so a sign-out/re-login never replays this banner.
    window.history.replaceState({}, '', window.location.pathname);
    console.log('[portal] payment=completed detected, session:', sessionId);
    console.log('[portal] current entitlement count at redirect:', snapshotRef.current.entitlements.filter((e) => !e.revoked_at).length);

    // Capture baseline AFTER the initial refresh has run (it's triggered by the
    // refresh useEffect above and runs before this one because effects fire in
    // declaration order). If the webhook already landed before the redirect came
    // back, the baseline will already include the new row — in that case the
    // poll finds 0 new rows and we do a full refresh to show the unlocked state.
    const baseline = snapshotRef.current.entitlements.filter((e) => !e.revoked_at).length;
    entitlementCountBeforePayment.current = baseline;

    setWaitingForWebhook(true);
    let attempts = 0;

    const timer = window.setInterval(async () => {
      attempts += 1;
      const { data, error } = await supabase
        .from('entitlements')
        .select('document_id, granted_at, revoked_at')
        .is('revoked_at', null);

      const currentCount = data?.length ?? 0;
      const unlocked = !error && currentCount > baseline;

      console.log(`[portal] poll attempt ${attempts}/${POLL_MAX_ATTEMPTS}: entitlements=${currentCount}, baseline=${baseline}, unlocked=${unlocked}, error=${error?.message ?? 'none'}`);

      if (error || unlocked || attempts >= POLL_MAX_ATTEMPTS) {
        window.clearInterval(timer);
        setWaitingForWebhook(false);
        console.log(`[portal] poll ended — unlocked=${unlocked}, error=${error?.message ?? 'none'}, attempts=${attempts}`);
        await refresh();
        if (!unlocked && !error) {
          setNotice('Payment looks complete but the receipt has not been processed yet. Refresh in a few seconds.');
        }
      }
    }, POLL_INTERVAL_MS);

    return () => {
      console.log('[portal] poll cleanup');
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once on mount — reads URL before replaceState clears it

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

  // One pass over each list per fetch, instead of three linear scans per card.
  // First match wins, which is what the previous `.find` calls did.
  const access = useMemo(() => {
    const entitlements = new Map<string, EntitlementRow>();
    for (const row of snapshot.entitlements) {
      if (!row.revoked_at && !entitlements.has(row.document_id)) entitlements.set(row.document_id, row);
    }
    const purchases = new Map<string, PurchaseRow>();
    for (const row of snapshot.purchases) {
      if (!row.refunded_at && !purchases.has(row.document_id)) purchases.set(row.document_id, row);
    }
    const crm = new Map<string, CrmRow>();
    for (const row of snapshot.crm) {
      if (!crm.has(row.purchase_id)) crm.set(row.purchase_id, row);
    }
    return { entitlements, purchases, crm };
  }, [snapshot]);

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

      {waitingForWebhook && (
        <div className="payment-banner payment-banner--processing anim-fade-in">
          <span className="spinner" aria-hidden="true" />
          <span>Waiting for Stripe to confirm your payment…</span>
        </div>
      )}
      {notice && (
        <div className={`payment-banner ${notice.toLowerCase().includes('complete') ? 'payment-banner--success' : 'payment-banner--warn'} anim-slide-down`}>
          {notice.toLowerCase().includes('complete') ? '✓' : '⚠'} {notice}
        </div>
      )}
      {loadError && (
        <div className="payment-banner payment-banner--error anim-shake">
          ✕ Supabase refused the query: {loadError}
        </div>
      )}

      {loading ? (
        <p className="muted">Loading your access status...</p>
      ) : (
        <ul className="cards">
          {snapshot.documents.map((document) => {
            const entitlement = access.entitlements.get(document.id);
            const purchase = access.purchases.get(document.id);
            const crm = purchase ? access.crm.get(purchase.id) : undefined;
            const busy = busyDocument === document.id;

            return (
              <li key={document.id} className={`card anim-fade-in${entitlement ? ' card--unlocked' : ''}`}>
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
