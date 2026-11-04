import type { SupabaseClient } from '@supabase/supabase-js';

import type { AuthPort } from '../db/repository.js';

export function createSupabaseAuth(db: SupabaseClient): AuthPort {
  return {
    async verifyAccessToken(accessToken) {
      // getUser() hits Supabase's auth endpoint: the JWT is verified server-side
      // against the real issuer, not decoded by us.
      const { data, error } = await db.auth.getUser(accessToken);
      if (error || !data.user) return null;
      return { userId: data.user.id, email: data.user.email ?? '' };
    },
  };
}
