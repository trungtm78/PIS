import { randomUUID } from 'node:crypto';
import { INCIDENT_SLA_HOURS, NOOP_METRICS, formatRate, judgeRun, parseQualityThreshold, passRateMicro, ruleVerdict } from '@machvon/kernel';
import type { ActionOnFail, MetricsSink, QualityDimension, RuleOutcome, RuleResult, RuleSeverity, RunVerdict } from '@machvon/kernel';
import type { AuditWriter } from './audit-writer.ts';
import { WORKER_MEMBERSHIP_ID } from './consumer-inbox.ts';
import { LATEST_RUN_JOIN } from './dgv-dataset-store.ts';
import { countSnapshotRows, evaluateExpression, loadSnapshot, qualitySourceOf } from './dgv-quality-source.ts';
import type { Evaluation, QualitySource } from './dgv-quality-source.ts';
import { enqueueOutbox } from './outbox.ts';
import type { TenantDatabase, TenantTx } from './tenant-database.ts';

/** The gauges and counters of the quality job (DGV section 9). */
export const DGV_QUALITY_SCORE_GAUGE = 'dgv_quality_score';
export const DGV_HARD_FAIL_METRIC = 'dgv_hard_fail_total';
export const DGV_NOT_ASSESSED_GAUGE = 'dgv_not_assessed_datasets_gauge';
export const QUALITY_RUN_COMPLETED_EVENT = 'dgv.quality_run.completed.v1';
export const QUALITY_INCIDENT_OPENED_EVENT = 'dgv.incident.opened.v1';

const BATCH = 20;
/** How often the job takes a run up before it gives the run up as FAILED (EXECUTION_FAILED) instead of retrying it for ever. */
export const MAX_RUN_ATTEMPTS = 5;
const RUN_RESOURCE = 'quality_run';
const INCIDENT_RESOURCE = 'quality_incident';

type JobContext = { tenantId: string; membershipId: string; scopeVersion: number };
type FailureCode = 'SNAPSHOT_CHANGED' | 'SNAPSHOT_INCOMPLETE' | 'SOURCE_NOT_SUPPORTED' | 'NO_RULE_MEASURED' | 'EXECUTION_FAILED';

interface LockedRun {
  id: string;
  dataset_id: string;
  dataset_contract_id: string;
  snapshot_id: string;
  snapshot_sha256: string | null;
  rule_version_ids: string[];
  trigger: string;
  attempts: number;
  dataset_code: string;
  producer_module: string;
  owner_user_id: string;
  is_critical: boolean;
}

interface RuleDefinition {
  id: string;
  code: string;
  revision: number;
  dimension: QualityDimension;
  expression_ast: unknown;
  severity: RuleSeverity;
  threshold_json: unknown;
  action_on_fail: ActionOnFail;
  criticality_weight: number;
}

interface Measured {
  rule: RuleDefinition;
  result: RuleResult;
  errorCode: 'NO_ROWS_EVALUATED' | 'EVALUATION_FAILED' | null;
  evaluation: Evaluation | null;
  rateMicro: number | null;
  thresholdJson: unknown;
  quarantined: number;
  incidentId: string | null;
}

/** What one pass did, for the gauge and the logs. */
export interface QualityPassSummary {
  completed: number;
  failed: number;
  /** The datasets of the tenant that have no finished run at all. */
  notAssessed: number;
}

/**
 * The executor of the quality runs (ST-DGV-002, DGV 3.3 F3). A run is requested RUNNING by a person or by the event that a snapshot was frozen
 * and is executed here, once, in one transaction: every rule version the run names is measured over the rows of the one snapshot it names
 * (which must still be the frozen snapshot that was asked for), the results, the verdict, the incidents of the failed rules, the audit row and
 * the events are written together, or none of them are. A run that cannot be measured finishes FAILED with the reason; it never reads as a pass.
 */
export class DgvQualityRunJob {
  private readonly database: TenantDatabase;
  private readonly audit: AuditWriter;
  private readonly metrics: MetricsSink;

  constructor(database: TenantDatabase, audit: AuditWriter, options: { metrics?: MetricsSink } = {}) {
    this.database = database;
    this.audit = audit;
    this.metrics = options.metrics ?? NOOP_METRICS;
  }

  /** Executes the runs of the tenant that are waiting, oldest first. A run that throws is taken up again by the next pass, up to five times. */
  async runPending(ctx: JobContext): Promise<QualityPassSummary> {
    const waiting = await this.database.withTenant(ctx, (tx) => tx.query<{ id: string }>("select id from machvon.quality_run where status = 'RUNNING' order by started_at, id limit $1", [BATCH]));
    const summary: QualityPassSummary = { completed: 0, failed: 0, notAssessed: 0 };
    let broken = 0;
    for (const { id } of waiting) {
      try {
        const outcome = await this.executeOne(ctx, id);
        if (outcome === 'COMPLETED') summary.completed += 1;
        else if (outcome === 'FAILED') summary.failed += 1;
      } catch {
        broken += 1;
      }
    }
    const open = await this.database.withTenant(ctx, (tx) =>
      tx.query<{ total: string }>(`select count(*)::text as total from machvon.dataset d ${LATEST_RUN_JOIN} where d.status <> 'RETIRED' and run.finished_at is null`),
    );
    summary.notAssessed = Number(open[0]?.total ?? 0);
    if (broken > 0) throw new QualityRunsBroken(broken);
    return summary;
  }

  private async executeOne(ctx: JobContext, runId: string): Promise<'COMPLETED' | 'FAILED' | 'SKIPPED'> {
    // The attempt is counted in a transaction of its own, so a run whose execution always fails still runs out of attempts.
    const counted = await this.database.withTenant(ctx, (tx) =>
      tx.query<{ attempts: number }>("update machvon.quality_run set attempts = attempts + 1 where id = $1::uuid and status = 'RUNNING' returning attempts", [runId]),
    );
    if (counted[0] === undefined) return 'SKIPPED';
    const emit: Array<() => void> = [];
    const outcome = await this.database.withTenant(ctx, async (tx) => {
      const locked = await tx.query<LockedRun>(
        `select r.id, r.dataset_id, r.dataset_contract_id, r.snapshot_id, r.snapshot_sha256, r.rule_version_ids, r.trigger, r.attempts, d.dataset_code, d.producer_module, d.owner_user_id, d.is_critical
           from machvon.quality_run r join machvon.dataset d on d.tenant_id = r.tenant_id and d.id = r.dataset_id
          where r.id = $1::uuid and r.status = 'RUNNING' for update of r skip locked`,
        [runId],
      );
      const run = locked[0];
      if (run === undefined) return 'SKIPPED' as const;
      if (run.attempts > MAX_RUN_ATTEMPTS) {
        await this.finishFailed(tx, run, 'EXECUTION_FAILED', []);
        return 'FAILED' as const;
      }
      return this.execute(tx, run, emit);
    });
    for (const publish of emit) publish();
    return outcome;
  }

  private async execute(tx: TenantTx, run: LockedRun, emit: Array<() => void>): Promise<'COMPLETED' | 'FAILED'> {
    const source = qualitySourceOf(run.producer_module);
    if (source === undefined) return this.fail(tx, run, 'SOURCE_NOT_SUPPORTED');
    const snapshot = await loadSnapshot(tx, source, run.snapshot_id);
    if (snapshot === undefined || !source.finalStatuses.includes(snapshot.status) || snapshot.payloadSha256 === null || snapshot.payloadSha256 !== run.snapshot_sha256) {
      return this.fail(tx, run, 'SNAPSHOT_CHANGED');
    }
    if ((await countSnapshotRows(tx, source, run.snapshot_id)) !== snapshot.rowCount) return this.fail(tx, run, 'SNAPSHOT_INCOMPLETE');

    const rules = await tx.query<RuleDefinition>(
      `select id, code, revision, dimension, expression_ast, severity, threshold_json, action_on_fail, criticality_weight
         from machvon.quality_rule_version where id = any($1::uuid[]) order by dimension, code, revision`,
      [run.rule_version_ids],
    );
    const measured: Measured[] = [];
    for (const rule of rules) measured.push(await this.measure(tx, source, run, rule));
    const outcomes: RuleOutcome[] = measured.map((item) => ({ dimension: item.rule.dimension, action: item.rule.action_on_fail, weight: item.rule.criticality_weight, result: item.result, rateMicro: item.rateMicro }));
    const verdict = judgeRun(outcomes, run.is_critical);

    for (const item of measured) {
      if (item.result === 'FAIL') item.incidentId = await this.openIncident(tx, run, item);
      await this.writeResult(tx, run.id, item);
    }
    if (verdict.overall === undefined) {
      await this.finishFailed(tx, run, 'NO_RULE_MEASURED', measured);
      return 'FAILED';
    }
    await this.complete(tx, run, measured, verdict, emit);
    return 'COMPLETED';
  }

  private async fail(tx: TenantTx, run: LockedRun, code: FailureCode): Promise<'FAILED'> {
    await this.finishFailed(tx, run, code, []);
    return 'FAILED';
  }

  /** Measures one rule in a savepoint: a rule whose query fails is an ERROR result, and the other rules are still measured. */
  private async measure(tx: TenantTx, source: QualitySource, run: LockedRun, rule: RuleDefinition): Promise<Measured> {
    const base = { rule, evaluation: null, rateMicro: null, thresholdJson: rule.threshold_json, quarantined: 0, incidentId: null };
    let evaluation: Evaluation;
    await tx.query('savepoint quality_rule_eval');
    try {
      evaluation = await evaluateExpression(tx, source, rule.dimension, rule.expression_ast, run.snapshot_id);
      await tx.query('release savepoint quality_rule_eval');
    } catch (error) {
      await tx.query('rollback to savepoint quality_rule_eval');
      if (isConnectionFailure(error)) throw error;
      return { ...base, result: 'ERROR', errorCode: 'EVALUATION_FAILED' };
    }
    const rate = passRateMicro(evaluation.passed, evaluation.evaluated);
    // Nothing was evaluated: the rule says nothing about the snapshot, and an empty measurement is not a pass.
    if (rate === undefined) return { ...base, result: 'ERROR', errorCode: 'NO_ROWS_EVALUATED', evaluation };
    const threshold = parseQualityThreshold(rule.threshold_json, rule.dimension);
    const result = ruleVerdict(rate, threshold, rule.action_on_fail);
    const quarantined = rule.action_on_fail === 'QUARANTINE' && result !== 'PASS' ? evaluation.failed : 0;
    return { ...base, result, errorCode: null, evaluation, rateMicro: rate, quarantined };
  }

  /**
   * The incident of a failed rule: the one that is still open for the same rule code of the dataset when there is one (the failure goes on, it is
   * not a second problem), otherwise a new one owned by the owner of the dataset, due by the SLA of its severity. An integrity failure is CRITICAL.
   */
  private async openIncident(tx: TenantTx, run: LockedRun, item: Measured): Promise<string> {
    const open = await tx.query<{ id: string }>(
      `select i.id from machvon.quality_incident i
         join machvon.quality_run r on r.tenant_id = i.tenant_id and r.id = i.run_id
         join machvon.quality_rule_version v on v.tenant_id = i.tenant_id and v.id = i.rule_id
        where r.dataset_id = $1::uuid and v.contract_id = $2::uuid and v.code = $3 and i.status <> 'CLOSED'
        order by i.created_at, i.id limit 1`,
      [run.dataset_id, run.dataset_contract_id, item.rule.code],
    );
    if (open[0] !== undefined) return open[0].id;
    const severity: RuleSeverity = item.rule.dimension === 'INTEGRITY' ? 'CRITICAL' : item.rule.severity;
    const slaHours = INCIDENT_SLA_HOURS[severity];
    const id = randomUUID();
    const due = await tx.query<{ due_at: string }>(
      `insert into machvon.quality_incident
         (tenant_id, id, rule_id, dataset_version_id, affected_refs, severity, owner_id, status, due_at, title, run_id, sla_hours)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, '[]'::jsonb, $4, $5::uuid, 'OPEN', now() + $6::integer * interval '1 hour', $7, $8::uuid, $6::integer)
       returning to_char(due_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as due_at`,
      [id, item.rule.id, run.snapshot_id, severity, run.owner_user_id, slaHours, `${run.dataset_code} / ${item.rule.code}`, run.id],
    );
    await tx.query(
      "insert into machvon.quality_incident_event (tenant_id, id, incident_id, event_kind, actor_user_id, from_status, to_status, note) values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, 'CREATED', null, null, 'OPEN', null)",
      [id],
    );
    const correlationId = randomUUID();
    await this.audit.recordInTx(tx, WORKER_MEMBERSHIP_ID, {
      action: 'dgv.quality_incident_opened',
      resourceType: INCIDENT_RESOURCE,
      resourceId: id,
      diff: { dataset_id: run.dataset_id, run_id: run.id, rule_version_id: item.rule.id, severity, sla_hours: slaHours },
      correlationId,
      requestId: randomUUID(),
    });
    await enqueueOutbox(tx, {
      aggregateType: INCIDENT_RESOURCE,
      aggregateId: id,
      aggregateVersion: 1,
      type: QUALITY_INCIDENT_OPENED_EVENT,
      schemaVersion: 1,
      payload: { incident_id: id, dataset_id: run.dataset_id, run_id: run.id, rule_version_id: item.rule.id, rule_code: item.rule.code, severity, due_at: due[0]?.due_at ?? null },
      eventKey: `${INCIDENT_RESOURCE}:${id}:1`,
      correlationId,
      causationId: run.id,
    });
    return id;
  }

  private async writeResult(tx: TenantTx, runId: string, item: Measured): Promise<void> {
    const evaluation = item.evaluation;
    await tx.query(
      `insert into machvon.quality_rule_result
         (tenant_id, id, run_id, rule_version_id, evaluated_count, passed_count, failed_count, quarantined_count, measured_value, threshold_snapshot, result, sample_refs, incident_id, error_code)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5, $6, $7::numeric, $8::jsonb, $9, $10::jsonb, $11::uuid, $12)`,
      [
        runId,
        item.rule.id,
        evaluation?.evaluated ?? 0,
        evaluation?.passed ?? 0,
        evaluation?.failed ?? 0,
        item.quarantined,
        item.rateMicro === null ? null : formatRate(item.rateMicro),
        JSON.stringify(item.thresholdJson),
        item.result,
        JSON.stringify((evaluation?.sampleIds ?? []).map((rowId) => ({ row_id: rowId }))),
        item.incidentId,
        item.errorCode,
      ],
    );
  }

  private async complete(tx: TenantTx, run: LockedRun, measured: Measured[], verdict: RunVerdict, emit: Array<() => void>): Promise<void> {
    const passed = measured.filter((item) => item.result === 'PASS').length;
    const failed = measured.filter((item) => item.result === 'FAIL').length;
    const quarantined = measured.reduce((total, item) => total + item.quarantined, 0);
    await tx.query(
      `update machvon.quality_run set status = 'COMPLETED', finished_at = now(), overall_result = $2, score = $3::numeric, hard_fail = $4, certified_blocked = $5,
              passed_count = $6, failed_count = $7, quarantined_count = $8 where id = $1::uuid`,
      [run.id, verdict.overall, verdict.score, verdict.hardFail, verdict.certifiedBlocked, passed, failed, quarantined],
    );
    const correlationId = randomUUID();
    const summary = { dataset_id: run.dataset_id, snapshot_id: run.snapshot_id, overall_result: verdict.overall, score: verdict.score, hard_fail: verdict.hardFail, certified_blocked: verdict.certifiedBlocked, quarantined_count: quarantined };
    await this.audit.recordInTx(tx, WORKER_MEMBERSHIP_ID, {
      action: 'dgv.quality_run_completed',
      resourceType: RUN_RESOURCE,
      resourceId: run.id,
      diff: { ...summary, trigger: run.trigger, rules_passed: passed, rules_failed: failed, rules_total: measured.length },
      correlationId,
      requestId: randomUUID(),
    });
    await enqueueOutbox(tx, {
      aggregateType: RUN_RESOURCE,
      aggregateId: run.id,
      aggregateVersion: 1,
      type: QUALITY_RUN_COMPLETED_EVENT,
      schemaVersion: 1,
      payload: { run_id: run.id, ...summary },
      eventKey: `${RUN_RESOURCE}:${run.id}:completed`,
      correlationId,
    });
    emit.push(() => {
      this.metrics.gauge(DGV_QUALITY_SCORE_GAUGE, Number(verdict.score), { dataset: run.dataset_code });
      if (verdict.hardFail) this.metrics.increment(DGV_HARD_FAIL_METRIC, { dataset: run.dataset_code });
    });
  }

  /** Finishes a run that could not be measured: no verdict, no score, the reason, and an audit row. The results already measured are kept. */
  private async finishFailed(tx: TenantTx, run: LockedRun, code: FailureCode, measured: readonly Measured[]): Promise<void> {
    await tx.query("update machvon.quality_run set status = 'FAILED', finished_at = now(), failure_code = $2 where id = $1::uuid", [run.id, code]);
    await this.audit.recordInTx(tx, WORKER_MEMBERSHIP_ID, {
      action: 'dgv.quality_run_failed',
      resourceType: RUN_RESOURCE,
      resourceId: run.id,
      diff: { dataset_id: run.dataset_id, snapshot_id: run.snapshot_id, failure_code: code, trigger: run.trigger, rules_total: measured.length },
      correlationId: randomUUID(),
      requestId: randomUUID(),
    });
  }
}

/** Some runs threw while they were executed; they stay RUNNING and are taken up again (the others of the pass were finished). */
export class QualityRunsBroken extends Error {
  readonly broken: number;

  constructor(broken: number) {
    super(`${broken} quality run(s) could not be executed`);
    this.name = 'QualityRunsBroken';
    this.broken = broken;
  }
}

/** A failure of the connection itself: the savepoint cannot be trusted and the whole run is retried. */
function isConnectionFailure(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return typeof code === 'string' && (code.startsWith('08') || code === '57P01' || code === '57P02' || code === '57P03' || code === '25P02');
}
