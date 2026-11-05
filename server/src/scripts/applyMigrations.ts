/**
 * Applies the SQL in supabase/migrations/ to a real Postgres, one file per
 * transaction, and remembers which ones it ran.
 *
 *   npm run db:migrate          # apply anything not yet recorded
 *   npm run db:migrate -- --status
 *   npm run db:migrate -- --seed   # also run supabase/seed.sql
 *
 * The target is SUPABASE_DB_URL (the dashboard's connection string or session
 * pooler URI). These files reference auth.users and auth.uid(), so they need a
 * Supabase project — pointing this at a plain Postgres fails on the first
 * migration, which is the expected answer rather than a bug to fix.
 *
 * Each migration is written to be re-runnable (if not exists / or replace), but
 * `create policy` has no if-not-exists form, so the ledger is what makes a
 * second run a no-op instead of an error.
 */
import '../env.js'; // side effect only: loads the repo .env
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const LEDGER = 'public.schema_migrations';

function migrationsDir(): string {
  // server/src/scripts (dev) and server/dist/scripts (compiled) both sit two
  // levels under the workspace, so one join works for both.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidate = path.resolve(here, '../../../supabase/migrations');
  if (!existsSync(candidate)) throw new Error(`no migrations directory at ${candidate}`);
  return candidate;
}

async function main() {
  const url = process.env.SUPABASE_DB_URL ?? '';
  const args = process.argv.slice(2);
  const wantSeed = args.includes('--seed');
  const statusOnly = args.includes('--status');

  const dir = migrationsDir();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (!url || /replace|your-project-ref/i.test(url)) {
    console.error('\nSUPABASE_DB_URL is not set. Copy it from the Supabase dashboard:\n');
    console.error('  Project Settings > Database > Connection string > URI');
    console.error('\nthen paste it into .env and re-run npm run db:migrate.');
    console.error('\nFiles it would apply:');
    for (const f of files) console.error(`  ${f}`);
    process.exit(1);
  }

  // Certificate verification stays on. `--insecure-tls` exists only for a local
  // stack with self-signed certificates (supabase start), never for a hosted
  // project: Supabase's own direct and pooler endpoints present valid certs.
  const client = new pg.Client({
    connectionString: url,
    ssl: args.includes('--insecure-tls') ? { rejectUnauthorized: false } : true,
  });
  await client.connect();
  try {
    await client.query(
      `create table if not exists ${LEDGER} (name text primary key, applied_at timestamptz not null default now())`
    );
    const { rows } = await client.query(`select name from ${LEDGER}`);
    const applied = new Set(rows.map((r) => r.name as string));

    if (statusOnly) {
      for (const f of files) console.log(`  ${applied.has(f) ? 'applied' : 'pending '} ${f}`);
      const pending = files.filter((f) => !applied.has(f)).length;
      console.log(`\n${pending} of ${files.length} migrations pending.\n`);
      return;
    }

    const targets = wantSeed ? [...files, path.resolve(dir, '../seed.sql')] : files;
    let ran = 0;

    for (const file of targets) {
      const key = path.basename(file);
      if (applied.has(key)) {
        console.log(`skip   ${key} (already recorded)`);
        continue;
      }
      const sql = readFileSync(file, 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query(`insert into ${LEDGER} (name) values ($1)`, [key]);
        await client.query('commit');
        applied.add(key);
        ran += 1;
        console.log(`applied ${key}`);
      } catch (err) {
        await client.query('rollback');
        const message = err instanceof Error ? err.message : String(err);
        console.error(`\nFAILED ${key}: ${message}`);
        console.error('Rolled back — nothing from this file is in the database, and earlier files stay applied.');
        if (/\bauth\.(users|uid)\b|relation "auth/.test(message)) {
          console.error('Hint: this file needs a Supabase project (the auth schema), not a plain Postgres.');
        }
        process.exitCode = 1;
        return;
      }
    }

    console.log(`\n${ran} applied, ${applied.size} recorded in total.`);
    console.log('Next: npm run seed   (creates the two auth users and links them to their client rows)');
  } finally {
    await client.end();
  }
}

void main();
