import { API_BASE_URL, supabase } from './supabaseClient';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function call<T>(path: string, init: RequestInit): Promise<T> {
  const { data, error } = await supabase.auth.getSession();
  if (!data.session) throw new ApiError('You are signed out.', 401, 'no_session');

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${data.session.access_token}`,
      ...init.headers,
    },
  });

  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new ApiError(describe(response.status, body.error), response.status, body.error ?? 'error');
  return body as T;
}

function describe(status: number, code?: string): string {
  if (code === 'already_owned') return 'You already have access to this document.';
  if (code === 'client_not_provisioned') return 'This demo account has no Zoho Deal id yet (see the seed step).';
  if (code === 'not_entitled') return 'You do not have access to that document.';
  if (code === 'no_client_profile') return 'This login is not linked to a client record.';
  if (status === 429) return 'Too many requests - wait a moment and try again.';
  return `Request failed (${status}${code ? `, ${code}` : ''}).`;
}

export function startCheckout(documentId: string): Promise<{ checkoutUrl: string; sessionId: string }> {
  return call('/api/checkout', { method: 'POST', body: JSON.stringify({ documentId }) });
}

export function getDownloadUrl(documentId: string): Promise<{ url: string; expiresIn: number }> {
  return call(`/api/documents/${documentId}/download`, { method: 'GET' });
}
