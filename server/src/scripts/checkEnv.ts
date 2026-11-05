/**
 * Tells you, in one screen, which configuration values are still placeholders
 * and where each real one comes from.
 *
 *   npm run env:check
 *   npm run env:check -- --strict    # same report, non-zero exit if incomplete
 *
 * Nothing here validates through the server's schema: `loadEnv()` refuses to
 * boot on the first bad value, which is correct for the server and useless for
 * a checklist that has to report all of them at once.
 */
import { readFileSync } from 'node:fs';

import '../env.js'; // side effect only: loads the repo .env without validating

type Stage = 'migrations' | 'portal' | 'payments' | 'crm' | 'optional';

type Status = 'real' | 'placeholder' | 'missing' | 'optional';

type Spec = {
  name: string;
  stage: Stage;
  /** Where to copy the value from, in the order the README uses. */
  source: string;
  /** Absence is a warning, not a failure. */
  optional?: boolean;
  looksReal?: (value: string) => boolean;
};

const PLACEHOLDER_PATTERN = /replace|placeholder|your-|change|xxx/i;

const SPECS: Spec[] = [
  {
    name: 'SUPABASE_DB_URL',
    stage: 'migrations',
    source: 'Project Settings > Database > Connection string > URI (or the session pooler). Also set "Allow connections from any IP" or add your IP.',
    looksReal: (v) => v.startsWith('postgres') && !PLACEHOLDER_PATTERN.test(v),
  },
  {
    name: 'SUPABASE_URL',
    stage: 'portal',
    source: 'Project Settings > API > Project URL.',
    looksReal: (v) => v.includes('.supabase.co') && !PLACEHOLDER_PATTERN.test(v),
  },
  {
    name: 'SUPABASE_ANON_KEY',
    stage: 'portal',
    source: 'Project Settings > API > keys > anon (public; web/.env.local needs the same value).',
    looksReal: (v) => v.length > 30 && !PLACEHOLDER_PATTERN.test(v),
  },
  {
    name: 'SUPABASE_SERVICE_ROLE_KEY',
    stage: 'portal',
    source: 'Same page > service_role. SECRET, server only, never in web/.',
    looksReal: (v) => v.length > 30 && !PLACEHOLDER_PATTERN.test(v),
  },
  {
    name: 'ADMIN_API_KEY',
    stage: 'portal',
    source: 'Generated locally. `npm run env:make-admin-key` writes one.',
    looksReal: (v) => v.length >= 8 && !PLACEHOLDER_PATTERN.test(v),
  },
  {
    name: 'STRIPE_SECRET_KEY',
    stage: 'payments',
    source: 'Stripe Dashboard (Test mode) > Developers > API keys > Secret key.',
    looksReal: (v) => /^sk_(test|live)/.test(v) && !PLACEHOLDER_PATTERN.test(v),
  },
  {
    name: 'STRIPE_WEBHOOK_SECRET',
    stage: 'payments',
    source: 'Printed by `npm run stripe:listen` (local) or the dashboard endpoint (deployed).',
    looksReal: (v) => v.startsWith('whsec_') && !PLACEHOLDER_PATTERN.test(v),
  },
  {
    name: 'STRIPE_PRICE_ID',
    stage: 'optional',
    optional: true,
    source: 'Optional. Empty prices each session from the documents row, which is the required behaviour.',
  },
  {
    name: 'ZOHO_CLIENT_ID',
    stage: 'crm',
    source: 'Zoho Setup > Developer Hub > API > Self client credentials.',
    looksReal: (v) => !PLACEHOLDER_PATTERN.test(v),
  },
  {
    name: 'ZOHO_CLIENT_SECRET',
    stage: 'crm',
    source: 'Same page as the client id.',
    looksReal: (v) => !PLACEHOLDER_PATTERN.test(v),
  },
  {
    name: 'ZOHO_REFRESH_TOKEN',
    stage: 'crm',
    source: 'Printed once by `npm run zoho:bootstrap`.',
    looksReal: (v) => !PLACEHOLDER_PATTERN.test(v),
  },
  {
    name: 'ZOHO_API_URL',
    stage: 'crm',
    source: 'www.zohoapis.com/crm/v2/<org id> — the digits in your own browser URL after signing in.',
    looksReal: (v) => !PLACEHOLDER_PATTERN.test(v),
  },
  {
    name: 'ZOHO_DEAL_ID_CLIENT_A',
    stage: 'crm',
    optional: true,
    source: 'A real Deal record id. Empty is allowed: /api/checkout then refuses with client_not_provisioned.',
    looksReal: (v) => !PLACEHOLDER_PATTERN.test(v),
  },
  {
    name: 'ZOHO_DEAL_ID_CLIENT_B',
    stage: 'crm',
    optional: true,
    source: 'Second Deal record id, same page.',
    looksReal: (v) => !PLACEHOLDER_PATTERN.test(v),
  },
  {
    name: 'ZOHO_ACCOUNTS_URL',
    stage: 'crm',
    optional: true,
    source: 'Data centre: accounts.zoho.com | .eu | .in | .com.au | .cn',
    looksReal: (v) => v.startsWith('https://accounts.zoho'),
  },
  {
    name: 'ZOHO_PAID_STAGE',
    stage: 'crm',
    optional: true,
    source: 'The Stage picklist value meaning paid in your org (default "Closed Won").',
  },
  {
    name: 'ZOHO_REDIRECT_URI',
    stage: 'crm',
    optional: true,
    source: 'Must match the self-client redirect URI character for character.',
  },
  {
    name: 'APP_BASE_URL',
    stage: 'portal',
    optional: true,
    source: 'Where the portal is served; Stripe success/cancel URLs are built from it.',
    looksReal: (v) => v.startsWith('http'),
  },
  {
    name: 'RUN_INTEGRATION',
    stage: 'optional',
    optional: true,
    source: 'Set to 1 to run the live RLS suite against your project.',
  },
];

const STAGES: { id: Stage; label: string }[] = [
  { id: 'migrations', label: 'Apply the SQL (npm run db:migrate)' },
  { id: 'portal', label: 'Sign in and read the portal' },
  { id: 'payments', label: 'Buy with a test card' },
  { id: 'crm', label: 'See a Zoho Deal flip to paid' },
  { id: 'optional', label: 'Optional switches' },
];

function statusFor(spec: Spec): 'real' | 'placeholder' | 'missing' | 'optional' {
  const value = process.env[spec.name];
  if (value === undefined || value === '') return spec.optional ? 'optional' : 'missing';
  if (spec.looksReal && !spec.looksReal(value)) return 'placeholder';
  if (PLACEHOLDER_PATTERN.test(value)) return 'placeholder';
  return 'real';
}

const MARK: Record<Status, string> = { real: 'ok ', missing: 'MISSING', placeholder: 'DUMMY', optional: '   -' };

/**
 * The portal reads its own three variables out of web/.env.local, and Vite
 * inlines them at build time — so a portal that "signs in but shows nothing" is
 * usually this file disagreeing with the root .env. Checked here so one command
 * covers both files.
 */
function readWebEnv(): Record<string, string> {
  const file = new URL('../../../web/.env.local', import.meta.url);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] && match[2] !== undefined) values[match[1]] = match[2].trim();
  }
  return values;
}

const WEB_SPECS: { name: string; source: string; looksReal: (v: string) => boolean }[] = [
  {
    name: 'VITE_SUPABASE_URL',
    source: 'Same Project URL as SUPABASE_URL in the root .env.',
    looksReal: (v) => v.includes('.supabase.co') && !PLACEHOLDER_PATTERN.test(v),
  },
  {
    name: 'VITE_SUPABASE_ANON_KEY',
    source: 'Project Settings > API > keys > anon. Public by design; never the service_role key.',
    looksReal: (v) => v.length > 30 && !PLACEHOLDER_PATTERN.test(v),
  },
  {
    name: 'VITE_API_BASE_URL',
    source: 'http://localhost:8787 locally; the deployed server origin in production.',
    looksReal: (v) => v.startsWith('http'),
  },
];

const webEnv = readWebEnv();
const webResults = WEB_SPECS.map((spec) => {
  const value = webEnv[spec.name];
  const status: Status = value === undefined || value === '' ? 'missing' : spec.looksReal(value) ? 'real' : 'placeholder';
  return { spec, status };
});

console.log('\nConfiguration state (values are never printed, only their status)\n');
const results = SPECS.map((spec) => ({ spec, status: statusFor(spec) }));
const width = Math.max(...SPECS.map((s) => s.name.length));

for (const { spec, status } of results) {
  console.log(`  ${spec.name.padEnd(width)}  ${MARK[status].padEnd(9)}`);
}

console.log('\nPortal bundle (web/.env.local — Vite inlines it at build time, so restart `npm run dev` after editing)\n');
for (const { spec, status } of webResults) {
  console.log(`  ${spec.name.padEnd(width)}  ${MARK[status].padEnd(9)}`);
}

const serverUrl = process.env.SUPABASE_URL ?? '';
const portalUrl = webEnv.VITE_SUPABASE_URL ?? '';
if (
  !PLACEHOLDER_PATTERN.test(serverUrl) &&
  !PLACEHOLDER_PATTERN.test(portalUrl) &&
  serverUrl !== portalUrl
) {
  console.log('\n  WARNING  SUPABASE_URL and VITE_SUPABASE_URL name different projects: the server would');
  console.log('           write entitlements to one database while the browser reads another.');
}

console.log('\nWhat each stage still needs:\n');
for (const stage of STAGES) {
  const blocked = results.filter((r) => r.spec.stage === stage.id && (r.status === 'missing' || r.status === 'placeholder'));
  const portalBlocked = stage.id === 'portal' ? webResults.filter((r) => r.status !== 'real') : [];
  const every = [...blocked, ...portalBlocked];
  if (every.length === 0) {
    console.log(`  READY     ${stage.label}`);
    continue;
  }
  console.log(`  blocked   ${stage.label}  <- ${every.map((b) => b.spec.name).join(', ')}`);
  for (const b of every) console.log(`              ${b.spec.source}`);
}

const required = [...results.filter((r) => !r.spec.optional), ...webResults];
const ready = required.filter((r) => r.status === 'real').length;
const missing = required.length - ready;
console.log(`\n${ready}/${required.length} required values are real.\n`);

// A human reads this screen, so the default exit is 0. `--strict` turns the same
// report into a gate for a script or a CI step.
if (missing > 0) console.log(`${missing} still to fill in. Add --strict to exit non-zero on that.\n`);
if (process.argv.includes('--strict') && missing > 0) process.exit(1);
