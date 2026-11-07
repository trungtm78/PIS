import { expect, test } from '@playwright/test';
import { SeedContext } from './seed/context.ts';
import { runSeed } from './seed/index.ts';

/**
 * Step 04 of the guide run: the business data. It records no clip. Clips 01 to 03 made the decision, the wards and three projects through the
 * screens; this step makes everything else the tours show (capital plans, reports, contracts, bids, assets, audits...) through the real API
 * commands of the stack, as the people of the guide, so that no screen the tours film is empty. The groups are in e2e/hdsd/seed/index.ts.
 */
test('step 04: the business data of the guide is made through the commands of the product', async () => {
  test.setTimeout(3_600_000);
  const ctx = new SeedContext();
  const summary = await runSeed(ctx);
  // The refusals the seeds tolerated are listed, not hidden: a seed that cannot do its step says so.
  if (summary.warnings.length > 0) process.stdout.write(`${summary.warnings.length} refusals tolerated:\n${summary.warnings.join('\n')}\n`);
  expect(summary.groups.length).toBeGreaterThan(0);
});
