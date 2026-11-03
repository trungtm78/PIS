import { randomUUID } from 'node:crypto';
import { DomainError, MAX_STEPS_PER_PASS, freezeOver, mayPurgeSource, reconcileCopy, verificationReport, workerStep } from '@machvon/kernel';
import type { TenantContext, VerificationReport } from '@machvon/kernel';
import type { ApprovalEffects } from './approval-store.ts';
import type { AuditWriter } from './audit-writer.ts';
import type { ControlDatabase } from './control-database.ts';
import { enqueueOutbox } from './outbox.ts';
import { PlacementMigrationStore } from './placement-migration-store.ts';
import type { MigrationPressure, MigrationRow } from './placement-migration-store.ts';
import { measureTenantTables } from './placement-measure.ts';
import type { MeasuredTenant } from './placement-measure.ts';
import type { MoveRef, MoveSource, PlacementMover } from './placement-mover.ts';
import type { TenantDatabase, TenantTx } from './tenant-database.ts';

export interface PlacementMigrationRunnerDeps {
  control: ControlDatabase;
  /** The tenant plane: the original is measured through it, as the tenant, in one snapshot. */
  tenants: TenantDatabase;
  mover: PlacementMover;
  audit: Pick<AuditWriter, 'recordInTx'>;
  /** The clock for the instants that decide a switch (the freeze may not be over when the routing changes); defaults to the time of the pass. */
  clock?: () => Date;
}

/** The code a failure is recorded as: a registered code, an error `code` string, else a generic one. Messages never leave: they may hold data. */
export function failureCodeOf(error: unknown): string {
  if (error instanceof DomainError) return error.code;
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? code : 'STEP_FAILED';
}

export const moveOf = (row: MigrationRow): MoveRef => ({ migrationId: row.id, tenantId: row.tenantId, fromPlacementId: row.fromPlacementId, toPlacementId: row.toPlacementId });

/** Whether nothing was written to the silo since the comparison that let the routing switch: the copy still holds what the last comparison saw (rows, the checksum of the content of every column of every row, and the money), so an update of any column shows. Only then may a switched migration be rolled back without losing data. */
export async function targetIntact(mover: PlacementMover, row: MigrationRow): Promise<boolean> {
  if (row.report === null) return false;
  return reconcileCopy(row.report.target, await mover.measureTarget(moveOf(row))).match;
}

/**
 * The work of the worker on the promotions of a tenant (SAS.md 3.3, `PlacementMigrationWorkflow`). A pass takes each migration of the tenant that has something to do and moves it as far as it can, at most `MAX_STEPS_PER_PASS`
 * steps: the copy begins at its window, the copy is made, compared with the original (rows, checksum of the content of every row, sums of money) and kept in step while the cutover waits for approval; once the cutover is approved the last
 * difference is sent, the copy is compared again with writes frozen, and the routing is switched, or the migration is rolled back when the freeze ran out or the comparison disagreed; 24 hours later it is Completed.
 * A migration that ended has its copy destroyed, and a completed one has the old data deleted after its 30 days unless a legal hold is in force. A step that fails leaves the migration where it is with the class of the failure
 * and is tried again at the next pass; every step is idempotent.
 */
export class PlacementMigrationRunner {
  private readonly store = new PlacementMigrationStore();
  private readonly deps: PlacementMigrationRunnerDeps;

  constructor(deps: PlacementMigrationRunnerDeps) {
    this.deps = deps;
  }

  async run(ctx: TenantContext, now: Date): Promise<MigrationPressure> {
    const items = await this.deps.control.withTenantOf(ctx.tenantId, (tx) => this.store.workItems(tx));
    for (const item of items) await this.advance(ctx, item.id, now);
    return this.deps.control.withTenantOf(ctx.tenantId, (tx) => this.store.pressure(tx, now));
  }

  private effects(tx: TenantTx, actor: string): ApprovalEffects {
    const correlationId = randomUUID();
    return {
      actor,
      audit: (entry) => this.deps.audit.recordInTx(tx, actor, { ...entry, correlationId, requestId: randomUUID() }),
      emit: (event) => enqueueOutbox(tx, { ...event, correlationId }),
    };
  }

  private inTenant<T>(ctx: TenantContext, work: (tx: TenantTx, effects: ApprovalEffects) => Promise<T>): Promise<T> {
    return this.deps.control.withTenantOf(ctx.tenantId, (tx) => work(tx, this.effects(tx, ctx.membershipId)));
  }

  private source(ctx: TenantContext): MoveSource {
    return { measure: () => this.measureOriginal(ctx) };
  }

  private measureOriginal(ctx: TenantContext): Promise<MeasuredTenant> {
    return this.deps.tenants.withSnapshot(ctx, (tx) => measureTenantTables(tx));
  }

  /** The original and the copy, measured now, and what they conclude. */
  private async compare(ctx: TenantContext, move: MoveRef, at: Date): Promise<{ report: VerificationReport; unreadable: string[] }> {
    const original = await this.measureOriginal(ctx);
    const copy = await this.deps.mover.measureTarget(move);
    return { report: verificationReport(original.tables, copy, at), unreadable: original.unreadable };
  }

  private async advance(ctx: TenantContext, migrationId: string, now: Date): Promise<void> {
    const at = (): Date => this.deps.clock?.() ?? now;
    for (let step = 0; step < MAX_STEPS_PER_PASS; step += 1) {
      const row = await this.deps.control.withTenantOf(ctx.tenantId, (tx) => this.store.find(tx, migrationId));
      if (row === undefined) return;
      const move = moveOf(row);
      const next = workerStep(
        {
          status: row.status,
          plannedWindowStart: row.plannedWindowStart,
          writeFreezeStartedAt: row.writeFreezeStartedAt,
          writeFreezeMaxMinutes: row.writeFreezeMaxMinutes,
          switchedAt: row.switchedAt,
          targetDiscarded: row.targetDiscardedAt !== null,
          sourcePurgeDueAt: row.sourcePurgeDueAt,
          sourcePurged: row.sourcePurgedAt !== null,
        },
        now,
      );
      try {
        if (!(await this.perform(ctx, row, move, next, now, at))) return;
      } catch (error) {
        // Somebody moved the migration while the step ran (an approval, an abort): the next pass looks at it again.
        if (error instanceof DomainError && error.code === 'MIGRATION_STATE_INVALID') return;
        // The step failed outside the database or against a guard: the migration stays where it is, with the class of the failure, and the next pass tries again.
        await this.inTenant(ctx, (tx) => this.store.recordError(tx, row.id, failureCodeOf(error)));
        return;
      }
    }
  }

  /** Carries out one step; true when the migration may be looked at again in this pass. */
  private async perform(ctx: TenantContext, row: MigrationRow, move: MoveRef, next: ReturnType<typeof workerStep>, now: Date, at: () => Date): Promise<boolean> {
    switch (next) {
      case 'wait':
        return false;
      case 'start':
        await this.inTenant(ctx, (tx, effects) => this.store.beginCopy(tx, effects, row.id));
        return true;
      case 'copy':
        await this.deps.mover.copy(move, this.source(ctx));
        await this.inTenant(ctx, (tx) => this.store.copied(tx, row.id));
        return true;
      case 'verify': {
        const { report, unreadable } = await this.compare(ctx, move, at());
        await this.inTenant(ctx, (tx, effects) => this.store.recordVerification(tx, effects, row.id, report, unreadable));
        return false;
      }
      case 'refresh': {
        // The copy goes on catching up with the original while the cutover waits; the comparison that follows is what an approval relies on.
        await this.deps.mover.sync(move, this.source(ctx));
        const { report, unreadable } = await this.compare(ctx, move, at());
        await this.inTenant(ctx, (tx, effects) => this.store.recordVerification(tx, effects, row.id, report, unreadable));
        return false;
      }
      case 'freeze-expired':
        await this.inTenant(ctx, (tx, effects) => this.store.rollBack(tx, effects, row.id, 'FREEZE_EXPIRED', now));
        return true;
      case 'finalize':
        return this.finalize(ctx, row, move, at);
      case 'complete':
        await this.inTenant(ctx, (tx, effects) => this.store.complete(tx, effects, row.id, now));
        return true;
      case 'discard-target':
        await this.deps.mover.discardTarget(move);
        await this.inTenant(ctx, (tx, effects) => this.store.targetDiscarded(tx, effects, row.id, now));
        return false;
      case 'purge-source': {
        const holds = await this.inTenant(ctx, (tx) => this.store.legalHoldsActive(tx, row.tenantId));
        if (!mayPurgeSource(holds)) return false;
        await this.deps.mover.purgeSource(move);
        await this.inTenant(ctx, (tx, effects) => this.store.sourcePurged(tx, effects, row.id, now));
        return false;
      }
    }
  }

  // Writes are frozen: the last difference is sent, the copy is compared again, and the routing is switched only if it agrees and the freeze is not over.
  private async finalize(ctx: TenantContext, row: MigrationRow, move: MoveRef, at: () => Date): Promise<boolean> {
    await this.deps.mover.sync(move, this.source(ctx));
    const { report, unreadable } = await this.compare(ctx, move, at());
    if (!report.match) {
      await this.inTenant(ctx, (tx, effects) => this.store.rollBack(tx, effects, row.id, 'FINAL_VERIFICATION_FAILED', at(), { report, unreadable }));
      return true;
    }
    const switchAt = at();
    if (row.writeFreezeStartedAt === null || freezeOver(row.writeFreezeStartedAt, row.writeFreezeMaxMinutes, switchAt)) {
      await this.inTenant(ctx, (tx, effects) => this.store.rollBack(tx, effects, row.id, 'FREEZE_EXPIRED', switchAt));
      return true;
    }
    await this.inTenant(ctx, (tx, effects) => this.store.switch(tx, effects, row.id, report, unreadable, switchAt));
    return true;
  }
}
