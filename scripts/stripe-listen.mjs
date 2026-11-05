/**
 * Wrapper around `stripe listen` that:
 *   1. Captures the whsec_ secret it prints on startup
 *   2. Patches STRIPE_WEBHOOK_SECRET in .env automatically
 *   3. Sets process.env.STRIPE_WEBHOOK_SECRET so a co-running server picks it
 *      up on the next request (no server restart needed)
 *
 * Usage: called by `npm run stripe:listen` in package.json
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = path.join(ROOT, '.env');
const FORWARD_TO = process.env.STRIPE_FORWARD_TO ?? 'localhost:8787/api/webhook';

// Patch a single KEY=value line in the .env file. Creates the line if missing.
function patchEnv(key, value) {
  if (!existsSync(ENV_PATH)) return;
  let content = readFileSync(ENV_PATH, 'utf8');
  const line = `${key}=${value}`;
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, line);
  } else {
    content += `\n${line}\n`;
  }
  writeFileSync(ENV_PATH, content, 'utf8');
}

console.log(`[stripe-listen] Forwarding webhooks to ${FORWARD_TO}`);
console.log('[stripe-listen] Will auto-patch STRIPE_WEBHOOK_SECRET in .env when secret is printed\n');

const child = spawn(
  'stripe',
  ['listen', '--forward-to', FORWARD_TO],
  { stdio: ['inherit', 'pipe', 'pipe'] }
);

let secretPatched = false;

function handleLine(line) {
  process.stdout.write(line + '\n');

  // Stripe CLI prints:  > Your webhook signing secret is whsec_xxx (^C to quit)
  // or:                 webhook signing secret is whsec_xxx
  const match = line.match(/whsec_[A-Za-z0-9]+/);
  if (match && !secretPatched) {
    const secret = match[0];
    secretPatched = true;
    process.env.STRIPE_WEBHOOK_SECRET = secret;
    patchEnv('STRIPE_WEBHOOK_SECRET', secret);
    console.log(`\n[stripe-listen] ✓ STRIPE_WEBHOOK_SECRET updated in .env: ${secret.slice(0, 12)}...\n`);
  }
}

let stdoutBuf = '';
child.stdout.on('data', (chunk) => {
  stdoutBuf += chunk.toString();
  const lines = stdoutBuf.split('\n');
  stdoutBuf = lines.pop() ?? '';
  lines.forEach(handleLine);
});

let stderrBuf = '';
child.stderr.on('data', (chunk) => {
  stderrBuf += chunk.toString();
  const lines = stderrBuf.split('\n');
  stderrBuf = lines.pop() ?? '';
  lines.forEach((l) => { process.stderr.write(l + '\n'); handleLine(l); });
});

child.on('close', (code) => {
  process.exit(code ?? 0);
});

process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
