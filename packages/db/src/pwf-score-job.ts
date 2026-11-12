import { randomUUID } from 'node:crypto';
import { DomainError } from '@machvon/kernel';
import type { AuditWriter } from './audit-writer.ts';
import { PwfKpiStore } from './pwf-kpi-store.ts';
import { PwfScoreStore } from './pwf-score-store.ts';
import { enqueueOutbox } from './outbox.ts';
import type { TenantTx } from './tenant-database.ts';

/** How many closed tasks one pass reads at most: a tenant with a backlog catches up over several passes and never holds the transaction long (R35). */
const KPI_BATCH = 500;
const MAX_BATCHES = 20;
const RESOURCE_TYPE = 'staff_score_period';

/** What one pass of the job did for a tenant. */
export interface ScoreMaintenanceResult {
  /** Closed tasks whose KPI results were evaluated, results written, results left because the facts had not changed. */
  tasks: number;
  results: number;
  unchanged: number;
  /** Locked periods that became official, periods whose personal data was anonymised at the end of the retention. */
  officialized: number;
  expired: number;
}

/**
 * The job `pwf-score-maintenance` (PWF 9): incremental and idempotent, once an hour for each tenant. It (1) writes the KPI results of the tasks that were done or cancelled since their results were last evaluated
 * (`PwfKpiStore.pendingTaskIds`), (2) makes official every locked period whose window of response ended or whose responses were all handled (the system turn of `officializeStaffScorePeriod`, R43), and (3) anonymises
 * the official periods whose retention ended (BR-PWF-42). A pass has no effect on a score that was locked: results are only added, and a period is only moved forward. Nothing here applies a consequence to a person.
 */
export class PwfScoreMaintenanceJob {
  private readonly kpis = new PwfKpiStore();
  private readonly periods = new PwfScoreStore();

  private readonly audit: Pick<AuditWriter, 'recordInTx'>;

  constructor(audit: Pick<AuditWriter, 'recordInTx'>) {
    this.audit = audit;
  }

  async run(tx: TenantTx, actor: string, now: Date): Promise<ScoreMaintenanceResult> {
    const result: ScoreMaintenanceResult = { tasks: 0, results: 0, unchanged: 0, officialized: 0, expired: 0 };
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const pending = await this.kpis.pendingTaskIds(tx, KPI_BATCH);
      if (pending.length === 0) break;
      const done = await this.kpis.record(tx, pending, now);
      result.tasks += done.tasks;
      result.results += done.written;
      result.unchanged += done.unchanged;
      // A task whose results were just evaluated is not pending any more; one that cannot be evaluated (no closing day) would come back for ever, so the loop ends when nothing moved.
      if (done.tasks === 0) break;
    }
    const locked = await tx.query<{ id: string; version: number }>("select id, version from machvon.staff_score_period where status = 'LOCKED' order by locked_at, id limit 200");
    for (const period of locked) {
      try {
        const officialized = await this.periods.officialize(tx, { periodId: period.id, expectedVersion: undefined, actor, units: '*', now });
        result.officialized += 1;
        await this.announce(tx, actor, officialized.id, officialized.version, officialized.facts, now);
      } catch (failure) {
        // A period that is not due yet (the window is open, a response is waiting) is left for a later pass; anything else is a fault of the pass.
        if (!(failure instanceof DomainError) || failure.code !== 'STAFF_SCORE_PERIOD_LOCKED') throw failure;
      }
    }
    for (const id of await this.periods.expiredPeriodIds(tx, now)) {
      if (await this.periods.expire(tx, id)) {
        result.expired += 1;
        await this.audit.recordInTx(tx, actor, { action: 'score.period_expired', resourceType: RESOURCE_TYPE, resourceId: id, classification: 'PERSONAL', diff: { retention: 'ended' }, correlationId: randomUUID(), requestId: randomUUID() });
      }
    }
    return result;
  }

  private async announce(tx: TenantTx, actor: string, id: string, version: number, facts: Record<string, unknown>, now: Date): Promise<void> {
    const correlationId = randomUUID();
    await this.audit.recordInTx(tx, actor, { action: 'score.period_officialized', resourceType: RESOURCE_TYPE, resourceId: id, classification: 'PERSONAL', diff: { from_status: 'LOCKED', to_status: 'OFFICIAL', ...facts, by: 'job' }, correlationId, requestId: randomUUID() });
    await enqueueOutbox(tx, {
      aggregateType: RESOURCE_TYPE,
      aggregateId: id,
      aggregateVersion: version,
      type: 'pwf.score.period.officialized.v1',
      schemaVersion: 1,
      payload: { id, status: 'OFFICIAL', from_status: 'LOCKED', version, actor_id: actor, occurred_at: now.toISOString(), snapshot_hash: facts.snapshot_hash ?? null },
      eventKey: `${RESOURCE_TYPE}:${id}:${version}:pwf.score.period.officialized.v1`,
      correlationId,
    });
  }
}
