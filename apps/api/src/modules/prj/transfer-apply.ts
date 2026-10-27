import type { PrjTransferApplyJob, TenantDatabase } from '@machvon/db';
import { SHARED_PIPELINE_CACHE } from './pipeline-cache';
import type { PipelineCache } from './pipeline-cache';

/**
 * The pass of the job `prj-transfer-apply` for one tenant, and what must follow it (ST-PRJ-007): the transfers that are due are made in one transaction, and when any was made the pages of the project bank of the
 * tenant are cleared after that transaction has committed, so no reader is given a page that still lists a project under the unit it has left.
 */
export async function applyDueTransfers(
  database: TenantDatabase,
  job: PrjTransferApplyJob,
  ctx: { tenantId: string; membershipId: string; scopeVersion: number },
  now: Date,
  cache: PipelineCache = SHARED_PIPELINE_CACHE,
): Promise<{ applied: number; closed: number }> {
  const done = await database.withTenant(ctx, (tx) => job.run(tx, ctx.tenantId, ctx.membershipId, now));
  if (done.applied > 0) await cache.invalidate(ctx.tenantId);
  return done;
}
