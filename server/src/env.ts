import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import dotenv from 'dotenv';
import { z } from 'zod';

/**
 * Walk up from this module until a `.env` is found. Needed because the file's
 * own location differs between `npm run dev` (server/src/env.ts) and
 * `npm start` (server/dist/env.js): a fixed number of `..` steps would resolve
 * one of the two outside the repo. On a hosted platform there is no `.env` at
 * all — the dashboard injects the real variables and dotenv no-ops.
 */
function findRootEnvPath(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let hops = 0; hops < 5; hops++) {
    const candidate = path.join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(process.cwd(), '.env');
}

dotenv.config({ path: findRootEnvPath() });

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  APP_BASE_URL: z.string().url(),
  ADMIN_API_KEY: z.string().min(8),

  STRIPE_SECRET_KEY: z.string().startsWith('sk_'),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith('whsec_'),
  STRIPE_PRICE_ID: z.string().optional().default(''),

  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(10),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(10),

  ZOHO_CLIENT_ID: z.string().min(1),
  ZOHO_CLIENT_SECRET: z.string().min(1),
  ZOHO_REFRESH_TOKEN: z.string().min(1),
  ZOHO_ACCOUNTS_URL: z.string().url().default('https://accounts.zoho.com'),
  // Full CRM base including the org id; code appends `/Deals/{id}`.
  ZOHO_API_URL: z.string().url(),
  ZOHO_PAID_STAGE: z.string().default('Closed Won'),
  // Must match, character for character, the redirect URI registered on the
  // Zoho self-client. Used only by `npm run zoho:bootstrap`.
  ZOHO_REDIRECT_URI: z.string().url().default('http://localhost:8790/zoho/callback'),
  ZOHO_SIMULATE_FAILURE: z.enum(['true', 'false']).default('false'),

  // How many proxy hops sit in front of this process. Express counts from the
  // left of `X-Forwarded-For`, so a hosted platform behind one reverse proxy
  // uses 1. Left at 0 the app trusts the socket peer only — correct when
  // exposed directly, where trusting a header would let anyone spoof `req.ip`
  // and walk past the per-IP rate limits.
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),

  SEED_CLIENT_PASSWORD: z.string().default('TestAccess!234'),
  ZOHO_DEAL_ID_CLIENT_A: z.string().default(''),
  ZOHO_DEAL_ID_CLIENT_B: z.string().default(''),
});

export type AppEnv = {
  port: number;
  appBaseUrl: string;
  adminApiKey: string;
  stripeSecretKey: string;
  stripeWebhookSecret: string;
  stripePriceId: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
  zohoClientId: string;
  zohoClientSecret: string;
  zohoRefreshToken: string;
  zohoAccountsUrl: string;
  zohoApiUrl: string;
  zohoPaidStage: string;
  zohoRedirectUri: string;
  zohoSimulateFailure: boolean;
  trustProxy: number;
  seedClientPassword: string;
  zohoDealIdClientA: string;
  zohoDealIdClientB: string;
};

/**
 * Fail fast on a missing or malformed variable. Error text names variables
 * only — values are never echoed, because this output ends up in logs.
 */
export function loadEnv(overrides: Record<string, string | undefined> = {}): AppEnv {
  const parsed = schema.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n  - ${problems.join('\n  - ')}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    appBaseUrl: e.APP_BASE_URL.replace(/\/$/, ''),
    adminApiKey: e.ADMIN_API_KEY,
    stripeSecretKey: e.STRIPE_SECRET_KEY,
    stripeWebhookSecret: e.STRIPE_WEBHOOK_SECRET,
    stripePriceId: e.STRIPE_PRICE_ID,
    supabaseUrl: e.SUPABASE_URL,
    supabaseAnonKey: e.SUPABASE_ANON_KEY,
    supabaseServiceRoleKey: e.SUPABASE_SERVICE_ROLE_KEY,
    zohoClientId: e.ZOHO_CLIENT_ID,
    zohoClientSecret: e.ZOHO_CLIENT_SECRET,
    zohoRefreshToken: e.ZOHO_REFRESH_TOKEN,
    zohoAccountsUrl: e.ZOHO_ACCOUNTS_URL.replace(/\/$/, ''),
    zohoApiUrl: e.ZOHO_API_URL.replace(/\/$/, ''),
    zohoPaidStage: e.ZOHO_PAID_STAGE,
    zohoRedirectUri: e.ZOHO_REDIRECT_URI,
    zohoSimulateFailure: e.ZOHO_SIMULATE_FAILURE === 'true',
    trustProxy: e.TRUST_PROXY,
    seedClientPassword: e.SEED_CLIENT_PASSWORD,
    zohoDealIdClientA: e.ZOHO_DEAL_ID_CLIENT_A,
    zohoDealIdClientB: e.ZOHO_DEAL_ID_CLIENT_B,
  };
}
