import { randomUUID } from 'node:crypto';
import { TenantRestoreStore, enqueueOutbox } from '@machvon/db';
import type { ApprovalEffects, AuditWriter, RestorePassResult, RestoreRow, TenantDatabase, TenantRestoreEngine, TenantTx } from '@machvon/db';
import { DomainError, assertRestorable, verifyRestore } from '@machvon/kernel';
import type { TenantContext } from '@machvon/kernel';

/** The class of the failure of a restore whose copy did not match what the backup recorded. */
export const VERIFICATION_MISMATCH = 'VERIFICATION_MISMATCH';

/**
 * The job `tenant-restore` (SAS.md 3.11, the `TenantRestoreWorkflow`): for the tenant it is given, the restores a second System Admin approved are made one at a time. The restore engine restores the tenant to the recovery point
 * (into a sandbox, or over its data while it is still Suspended: the state is asked again, because it may have changed since the decision), the copy is measured against what the backup recorded (rows, checksum and money totals of every
 * table, no row of another tenant), and the restore is Completed with the report as the record of the drill only when everything matches; otherwise it ends as Failed with the report. A restore that fails ends as Failed with the
 * class of the failure and never its message. A restore lost with its process is ended as Failed (Stalled) by the pass that follows. The state of a tenant is never changed here: reopening a tenant after an in-place restore is the
 * System Admin's `resumeTenant`.
 */
export class TenantRestoreJob {
  private readonly store = new TenantRestoreStore();

  constructor(
    private readonly tenants: TenantDatabase,
    private readonly audit: Pick<AuditWriter, 'recordInTx'>,
    private readonly engine: TenantRestoreEngine,
    private readonly options: { clock?: () => Date } = {},
  ) {}

  async run(ctx: TenantContext, now: Date): Promise<RestorePassResult> {
    for (;;) {
      const restore = await this.tenants.withTenant(ctx, (tx) => this.store.claim(tx, now));
      if (restore === undefined) break;
      await this.make(ctx, restore);
    }
    return this.tenants.withTenant(ctx, async (tx) => {
      await this.store.sweepStalled(tx, this.effects(tx, ctx.membershipId), now);
      return this.store.counts(tx, now);
    });
  }

  private effects(tx: TenantTx, actor: string): ApprovalEffects {
    const correlationId = randomUUID();
    return {
      actor,
      audit: (entry) => this.audit.recordInTx(tx, actor, { ...entry, correlationId, requestId: randomUUID() }),
      emit: (event) => enqueueOutbox(tx, { ...event, correlationId }),
    };
  }

  private async make(ctx: TenantContext, restore: RestoreRow): Promise<void> {
    const clock = this.options.clock ?? (() => new Date());
    try {
      assertRestorable(restore.target, await this.tenants.withTenant(ctx, (tx) => this.store.tenantStatus(tx)));
      const outcome = await this.engine.restore({ tenantId: restore.tenantId, restoreId: restore.id, recoveryPoint: restore.recoveryPoint, target: restore.target });
      await this.tenants.withTenant(ctx, (tx) => this.store.restored(tx, restore.id, { restoredTo: outcome.restoredTo, sandboxRef: outcome.placement }));
      const verifiedAt = clock();
      const report = verifyRestore(outcome.expected, outcome.restored, { recoveryPoint: restore.recoveryPoint, restoredTo: outcome.restoredTo, approvedAt: restore.decidedAt ?? restore.requestedAt, verifiedAt });
      await this.tenants.withTenant(ctx, async (tx) => {
        const effects = this.effects(tx, ctx.membershipId);
        if (report.matched) await this.store.complete(tx, effects, restore.id, report, verifiedAt);
        else await this.store.fail(tx, effects, restore.id, VERIFICATION_MISMATCH, verifiedAt, report);
      });
    } catch (error) {
      // Only the class of the failure is kept: the message may hold data of the tenant.
      const code = error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'UnknownError';
      await this.tenants.withTenant(ctx, (tx) => this.store.fail(tx, this.effects(tx, ctx.membershipId), restore.id, code, clock()));
    }
  }
}
