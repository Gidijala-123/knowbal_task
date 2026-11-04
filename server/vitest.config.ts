import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The offline suite must pass with no credentials at all; the RLS test
    // opts in by setting SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY.
    testTimeout: 20_000,
  },
});
