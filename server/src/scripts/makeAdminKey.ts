/**
 * Generates a real ADMIN_API_KEY and writes it into the repo .env, so the admin
 * retry endpoint is not left on a placeholder that anyone could guess.
 *
 *   npm run env:make-admin-key
 *
 * The value is never printed. It lives in .env, which .gitignore covers.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(here, '../../../.env');

if (!existsSync(envPath)) {
  console.error(`No ${envPath}. Copy .env.example to .env first.`);
  process.exit(1);
}

const key = randomBytes(24).toString('base64url');
const text = readFileSync(envPath, 'utf8');
const line = /^ADMIN_API_KEY=.*$/m;

if (!line.test(text)) {
  writeFileSync(envPath, `${text.trimEnd()}\nADMIN_API_KEY=${key}\n`, 'utf8');
  console.log('ADMIN_API_KEY was absent; appended to .env.');
} else {
  writeFileSync(envPath, text.replace(line, `ADMIN_API_KEY=${key}`), 'utf8');
  console.log('ADMIN_API_KEY replaced in .env (old value gone, nothing printed).');
}

console.log('Admin endpoints need the value in .env sent as the x-admin-key header.');
