import { SeedContext } from './context.ts';
import { seedAiDemo } from './ai-demo.ts';

/**
 * Standalone runner of the DEMO-ONLY AI registry seed (ai-demo.ts); it is not a group of the dataset. From apps/web:
 *   E2E_STACK_INFO=<stack dir>\stack-info.json E2E_SESSION_KEY=<the key of the stack> node --experimental-strip-types e2e/hdsd/seed/ai-demo-run.ts
 */
try {
  const ctx = new SeedContext();
  await ctx.syncClock();
  const made = await seedAiDemo(ctx);
  process.stdout.write(`\nai-demo done in ${ctx.callCount} calls\n  public document version: ${made.documentVersionId}\n`);
  process.stdout.write(`  open LLM-22 with ?subject_kind=DOCUMENT_VERSION&subject_id=${made.documentVersionId}\n`);
  if (ctx.warnings.length > 0) process.stdout.write(`${ctx.warnings.length} refusals tolerated:\n${ctx.warnings.map((line) => `  ${line}`).join('\n')}\n`);
} catch (error) {
  process.stderr.write(`\nai-demo FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
