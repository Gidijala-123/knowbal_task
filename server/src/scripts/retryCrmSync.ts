/**
 * Re-attempt CRM syncs that never made it to Zoho.
 *
 *   npm run retry-crm-sync                     # every open row (max 50)
 *   npm run retry-crm-sync -- --purchase <id>  # one purchase
 *   npm run retry-crm-sync -- --list           # look, do not call Zoho
 *
 * Safe to run repeatedly: 'synced' rows are never claimed, and a Zoho PUT of
 * identical values is a no-op.
 */
import { loadEnv } from '../env.js';
import { createLogger } from '../logger.js';
import { createRuntime } from '../runtime.js';

function readFlag(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

const argv = process.argv.slice(2);
const purchaseId = readFlag(argv, '--purchase');
const listOnly = argv.includes('--list');
const limit = Number(readFlag(argv, '--limit') ?? '50');

const env = loadEnv();
const log = createLogger('retry-crm-sync');
const { repo, crm } = createRuntime(env, log);

async function main(): Promise<void> {
  if (listOnly) {
    const due = await repo.listCrmSyncDue(limit);
    if (due.length === 0) {
      process.stdout.write('nothing pending\n');
      return;
    }
    for (const row of due) {
      process.stdout.write(
        `${row.purchaseId}  deal=${row.zohoDealId}  ${row.status}  attempts=${row.attempts}  ${row.lastError ?? ''}\n`
      );
    }
    process.stdout.write(`\n${due.length} row(s) open. Run without --list to retry them.\n`);
    return;
  }

  const outcomes = await crm.retryDue({ purchaseId, limit });
  const counts = outcomes.reduce<Record<string, number>>((acc, o) => {
    acc[o.status] = (acc[o.status] ?? 0) + 1;
    return acc;
  }, {});

  outcomes.forEach((outcome, i) => {
    process.stdout.write(`  ${i + 1}. ${outcome.status}${outcome.detail ? ` - ${outcome.detail}` : ''}\n`);
  });
  process.stdout.write(`attempted=${outcomes.length} ${JSON.stringify(counts)}\n`);

  if (outcomes.some((o) => o.status === 'fatal')) {
    process.stdout.write('\nAt least one row needs a human: check the Zoho Deal id and the custom fields.\n');
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  log.error('retry failed', { error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
