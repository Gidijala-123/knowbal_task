import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { AppEnv } from '../env.js';

/**
 * The service-role client. It bypasses RLS, so it must never be constructed in
 * the browser and its key must never appear in a VITE_ variable.
 */
export function createSupabaseAdmin(env: AppEnv): SupabaseClient {
  return createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
