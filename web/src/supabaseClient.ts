import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!url || !anonKey) {
  throw new Error('Copy web/.env.example to web/.env.local and fill in the two VITE_SUPABASE_ values.');
}

export const supabase = createClient(url, anonKey);
export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:8787';

/**
 * Both origins are only known from the env at runtime, so the warm-up cannot be
 * a static <link> in index.html. Resolving DNS + TLS for the Supabase host while
 * React mounts and the user types their email is time the first query never pays.
 */
function preconnect(origin: string) {
  if (typeof document === 'undefined') return;
  const link = document.createElement('link');
  link.rel = 'preconnect';
  link.href = origin;
  document.head.appendChild(link);
}

for (const endpoint of [url, API_BASE_URL]) {
  try {
    preconnect(new URL(endpoint).origin);
  } catch {
    // A malformed value is already rejected by createClient or the fetch itself.
  }
}
