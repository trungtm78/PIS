import { randomUUID } from 'node:crypto';
import { evaluateRag, ragFactorInputs, vietnamDateOf, weekStartOf } from '@machvon/kernel';
import type { RagEvaluation, RagModel, UnitFacts } from '@machvon/kernel';
import type { AuditWriter } from './audit-writer.ts';
import { AnalyticsGovernanceStore } from './analytics-governance-store.ts';
import { AnalyticsRagStore } from './analytics-rag-store.ts';
import type { UnitReadingInput } from './analytics-rag-store.ts';
import { DisSnapshotStore } from './dis-snapshot-store.ts';
import { enqueueOutbox } from './outbox.ts';
import type { TenantTx } from './tenant-database.ts';

/** The units that were scored, summed over the tenants by the sweep (gauge). */
export const EARLY_WARNING_SCORE_METRIC = 'early_warning_score_units';
export const EARLY_WARNING_SCORED_EVENT = 'home.early_warning_scored.v1';
const RESOURCE_TYPE = 'early_warning_score';
/** Every unit of the tenant (the job reads the whole tenant; a reader's scope is applied when the rows are read). */
const WHOLE_TENANT = (): { sql: string; params: unknown[] } => ({ sql: 'true', params: [] });

export interface UnitEvaluation {
  input: UnitReadingInput;
  evaluation: RagEvaluation;
}

/** The reading of each unit by the model: one rule for the job, the live endpoint and the tests, so the colour a leader sees is the colour that was stored. */
export function evaluateUnits(model: RagModel, readings: readonly UnitReadingInput[], asOfDay: string): UnitEvaluation[] {
  return readings.map((input) => ({ input, evaluation: evaluateRag(model, ragFactorInputs(input.facts as UnitFacts, asOfDay)) }));
}

export interface EarlyWarningScoreResult {
  /** How many rows this pass wrote (zero when the week was already scored). */
  written: number;
  weekStart: string | null;
  /** The snapshot the week was (or is) scored from. */
  snapshotId: string | null;
  skipped: 'NO_SNAPSHOT' | 'WEEK_SCORED' | null;
}

/**
 * The job `early-warning-score` (G3-2, HOME and BI): each pass looks at the latest frozen snapshot, and if the week it belongs to has not been scored, reads every unit, judges it by the rules in force
 * (`RAG_THRESHOLDS` through the governance store) and writes one row for each unit with the breakdown and the versions of the rules that decided. A week is written once: a second pass, or a second runner, writes nothing.
 */
export class EarlyWarningScoreJob {
  private readonly snapshots = new DisSnapshotStore();
  private readonly governance = new AnalyticsGovernanceStore();
  private readonly rag = new AnalyticsRagStore();

  private readonly audit: Pick<AuditWriter, 'recordInTx'>;

  constructor(audit: Pick<AuditWriter, 'recordInTx'>) {
    this.audit = audit;
  }

  async run(tx: TenantTx, actor: string, now: Date): Promise<EarlyWarningScoreResult> {
    const snapshot = await this.snapshots.latestFrozen(tx);
    if (snapshot === undefined || snapshot.asOfDate === '') return { written: 0, weekStart: null, snapshotId: null, skipped: 'NO_SNAPSHOT' };
    const weekStart = weekStartOf(snapshot.asOfDate);
    if (await this.rag.hasWeek(tx, weekStart)) return { written: 0, weekStart, snapshotId: snapshot.id, skipped: 'WEEK_SCORED' };
    const today = vietnamDateOf(now);
    const model = await this.governance.ragModel(tx, today);
    const readings = await this.rag.unitReadings(tx, snapshot.id, WHOLE_TENANT, now);
    const rows = evaluateUnits(model, readings, snapshot.asOfDate).map((one) => ({ unitId: one.input.unitId, evaluation: one.evaluation, facts: one.input.facts }));
    const written = await this.rag.saveScores(tx, { weekStart, snapshotId: snapshot.id, asOfDate: snapshot.asOfDate, computedBy: actor, versions: model.versions, unverified: model.unverified, rows });
    if (written > 0) {
      const correlationId = randomUUID();
      const bands = { GREEN: 0, AMBER: 0, RED: 0, NO_DATA: 0 };
      for (const row of rows) bands[row.evaluation.band] += 1;
      await this.audit.recordInTx(tx, actor, {
        action: 'home.early_warning_scored',
        resourceType: RESOURCE_TYPE,
        resourceId: snapshot.id,
        classification: 'INTERNAL',
        diff: { week_start: weekStart, snapshot_id: snapshot.id, as_of_date: snapshot.asOfDate, units: written, bands, rule_versions: model.versions },
        correlationId,
        requestId: randomUUID(),
      });
      await enqueueOutbox(tx, {
        aggregateType: RESOURCE_TYPE,
        aggregateId: snapshot.id,
        aggregateVersion: 1,
        type: EARLY_WARNING_SCORED_EVENT,
        schemaVersion: 1,
        payload: { week_start: weekStart, snapshot_id: snapshot.id, as_of_date: snapshot.asOfDate, units: written, bands, occurred_at: now.toISOString() },
        eventKey: `${RESOURCE_TYPE}:${snapshot.id}:${weekStart}`,
        correlationId,
      });
    }
    return { written, weekStart, snapshotId: snapshot.id, skipped: null };
  }
}
