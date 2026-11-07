import { SeedContext } from '../context.ts';

/**
 * Runs one module (or several) of the group `platform-records` by itself, against the stack named by E2E_STACK_INFO, signed with E2E_SESSION_KEY.
 * From apps/web:   node --experimental-strip-types e2e/hdsd/seed/platform-records/run-module.ts adm.ts:seedAdmFoundation doc.ts:seedDoc
 * Each argument is `<file>:<exported function>`; the functions take the context and run in the order given. Exit code 1 at the first failing step.
 */
const ctx = new SeedContext();
ctx.group = 'platform-records';
const started = Date.now();
try {
  for (const argument of process.argv.slice(2)) {
    const [file, name] = argument.split(':') as [string, string];
    const loaded = (await import(`./${file}`)) as Record<string, (context: SeedContext) => Promise<void>>;
    const run = loaded[name];
    if (run === undefined) throw new Error(`${file} does not export ${name}`);
    ctx.log(`module ${argument}`);
    await run(ctx);
  }
  const ledger = ctx.flushLedger('platform-records');
  process.stdout.write(`\ndone in ${((Date.now() - started) / 1000).toFixed(1)} s, ${ctx.callCount} calls, ledger ${ledger}\n`);
  if (ctx.warnings.length > 0) process.stdout.write(`${ctx.warnings.length} refusals tolerated:\n${ctx.warnings.map((line) => `  ${line}`).join('\n')}\n`);
} catch (error) {
  process.stderr.write(`\nFAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
