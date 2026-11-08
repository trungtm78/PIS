import type { SeedContext } from '../context.ts';
import { seedCapital } from '../capital.ts';
import { seedDoc } from '../platform-records/doc.ts';
import { ensureDoaMatrix } from './doa.ts';
import { seedClipBi } from './public-bi.ts';
import { clipPlan } from './plan.ts';

/**
 * The groups of the enterprise dataset that reuse the groups of the guide on the enterprise plan (`applyClipPlan` swaps the tables of the guide for the ones of the plan):
 * the capital of the year (assignments of equity and loan, the plan of the year, the projects it funds), the documents of the office in the words of the enterprise, and BI.
 * Procurement, tenders, contracts and the process tree are the groups of the public dataset run on the same plan.
 */

function enterprisePlanOnly(ctx: SeedContext): boolean {
  if (clipPlan()?.dataset === 'enterprise') return true;
  ctx.warn('no enterprise clip plan (CLIP_PLAN_FILE): the group has nothing to do');
  return false;
}

/** Capital: the projects of the plan go through the appraisal to the pipeline, the assignments and the plan of the year are published, then the funded ones are budgeted and started. */
export async function seedClipEnterpriseCapital(ctx: SeedContext): Promise<void> {
  if (!enterprisePlanOnly(ctx)) return;
  await seedCapital(ctx);
}

/** Documents: the delegation matrix, then the outgoing decisions and letters, the register of incoming letters and the dossiers (platform-records/doc.ts, enterprise texts). */
export async function seedClipEnterpriseDocuments(ctx: SeedContext): Promise<void> {
  if (!enterprisePlanOnly(ctx)) return;
  await ctx.step('ADM', 'delegation of authority matrix', () => ensureDoaMatrix(ctx));
  try {
    await seedDoc(ctx);
  } catch (error) {
    ctx.warn(`the document seed stopped: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
  }
}

/** BI: the metrics of the platform and the dashboards of the leader (the bundle of the repository, the dashboards of the plan). */
export async function seedClipEnterpriseBi(ctx: SeedContext): Promise<void> {
  if (!enterprisePlanOnly(ctx)) return;
  await seedClipBi(ctx);
}
