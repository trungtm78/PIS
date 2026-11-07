import { runSeed } from './index.ts';
import { SeedContext } from './context.ts';

/**
 * The standalone runner of the seeds, against the stack named by E2E_STACK_INFO (the default stack when it is not set), signed with E2E_SESSION_KEY:
 *   node --experimental-strip-types e2e/hdsd/seed/run.ts --groups base,capital      (from apps/web)
 * Without --groups every group of the registry runs. Exit code 0 when all went through, 1 at the first failing step (its message names the step).
 */
function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const groups = argument('groups')
  ?.split(',')
  .map((name) => name.trim())
  .filter((name) => name !== '');

try {
  const ctx = new SeedContext();
  const summary = await runSeed(ctx, groups);
  process.stdout.write(`\nseed done in ${(summary.ms / 1000).toFixed(1)} s, ${summary.calls} calls\n`);
  for (const group of summary.groups) process.stdout.write(`  ${group.name}: ${(group.ms / 1000).toFixed(1)} s, ledger ${group.ledger}\n`);
  if (summary.warnings.length > 0) process.stdout.write(`${summary.warnings.length} refusals the seeds tolerated:\n${summary.warnings.map((line) => `  ${line}`).join('\n')}\n`);
} catch (error) {
  process.stderr.write(`\nseed FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
