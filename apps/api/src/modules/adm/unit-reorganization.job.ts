import { randomUUID } from 'node:crypto';
import { REORGANIZATION_STEPS_PER_PASS, UnitReorganizationStore, enqueueOutbox } from '@machvon/db';
import type { ApprovalEffects, AuditWriter, ReorganizationProjectPort, TenantDatabase, TenantTx } from '@machvon/db';
import { DomainError, vietnamDateOf } from '@machvon/kernel';

/** What one pass did for a tenant, and the figures of the gauge of the sagas that stopped. */
export interface ReorganizationPassResult {
  applied: number;
  steps: number;
  /** Sagas this pass stopped because a step could not be done. */
  failed: number;
  waiting: number;
  /** All the sagas of the tenant that are Failed after the pass, those of earlier passes included. */
  stopped: number;
  applying: number;
}

/**
 * The job \`unit-reorganization\` (ADM 3.2): every minute it carries out the reorganisations that are Applying and whose effective date (Vietnam date) has come, the oldest first, one step at a time, each step in a transaction of its
 * own so that the steps done stay done. A step that cannot be done stops that reorganisation (Failed, with the step and the code); the others go on. A saga is carried on, after the cause is mended, by deciding it again.
 */
export class UnitReorganizationJob {
  private readonly store = new UnitReorganizationStore();

  constructor(
    private readonly tenants: TenantDatabase,
    private readonly audit: Pick<AuditWriter, 'recordInTx'>,
    private readonly port: ReorganizationProjectPort,
  ) {}

  private effectsOf(tx: TenantTx, actor: string): ApprovalEffects {
    const correlationId = randomUUID();
    return {
      actor,
      audit: (entry) => this.audit.recordInTx(tx, actor, { ...entry, correlationId, requestId: randomUUID() }),
      emit: (event) => enqueueOutbox(tx, { ...event, correlationId }),
    };
  }

  async run(ctx: { tenantId: string; membershipId: string; scopeVersion: number }, now: Date): Promise<ReorganizationPassResult> {
    const today = vietnamDateOf(now);
    const result: ReorganizationPassResult = { applied: 0, steps: 0, failed: 0, waiting: 0, stopped: 0, applying: 0 };
    const due = await this.tenants.withTenant(ctx, (tx) => this.store.dueIds(tx, today, 20));
    for (const id of due) {
      for (let taken = 0; taken < REORGANIZATION_STEPS_PER_PASS; taken += 1) {
        try {
          const outcome = await this.tenants.withTenant(ctx, (tx) => this.store.step(tx, this.effectsOf(tx, ctx.membershipId), id, today, now, this.port));
          if (outcome.kind === 'STEP') {
            result.steps += 1;
            continue;
          }
          if (outcome.kind === 'APPLIED') result.applied += 1;
          else result.waiting += 1;
          break;
        } catch (error) {
          // The step that failed rolled back; the saga is marked in a transaction of its own, with the step and the code, and goes on only when it is decided again.
          const step = (error as { reorganizationStep?: string }).reorganizationStep ?? `reorg:${id}`;
          const code = error instanceof DomainError ? error.code : 'STEP_FAILED';
          await this.tenants.withTenant(ctx, async (tx) => {
            await this.store.fail(tx, id, { step, code }, now);
            await this.effectsOf(tx, ctx.membershipId).audit({ action: 'org_unit.reorganization_failed', resourceType: 'unit_reorganization', resourceId: id, diff: { step, code } });
          });
          result.failed += 1;
          break;
        }
      }
    }
    const counts = await this.tenants.withTenant(ctx, (tx) => this.store.counts(tx));
    result.stopped = counts.failed;
    result.applying = counts.applying;
    return result;
  }
}
