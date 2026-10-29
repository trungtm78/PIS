import { randomUUID } from 'node:crypto';
import { DomainError, QUALITY_DIMENSIONS, weightedScore } from '@machvon/kernel';
import type { ActionOnFail, QualityDimension, RuleResult, RuleSeverity } from '@machvon/kernel';
import { DATASET_VISIBLE, DgvDatasetStore } from './dgv-dataset-store.ts';
import type { DatasetRow, DatasetViewer } from './dgv-dataset-store.ts';
import { DgvQualityRuleStore } from './dgv-quality-rule-store.ts';
import { loadSnapshot, qualitySourceOf } from './dgv-quality-source.ts';
import { assertTimestampCursor } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';

const UNIQUE_VIOLATION = '23505';
/** What starts a run: the freezing of a snapshot, the application of an import batch, a schedule, or a person. */
export const QUALITY_RUN_TRIGGERS = ['SNAPSHOT_FROZEN', 'IMPORT_BATCH', 'SCHEDULE', 'MANUAL'] as const;
export type QualityRunTrigger = (typeof QUALITY_RUN_TRIGGERS)[number];
export type QualityRunStatus = 'RUNNING' | 'COMPLETED' | 'FAILED';

const TIME_SQL = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export interface QualityRunRow {
  id: string;
  datasetId: string;
  datasetCode: string;
  datasetContractId: string;
  snapshotId: string;
  trigger: QualityRunTrigger;
  status: QualityRunStatus;
  overallResult: 'PASSED' | 'WARNING' | 'FAILED' | null;
  score: string | null;
  hardFail: boolean;
  certifiedBlocked: boolean;
  failureCode: string | null;
  passedCount: number;
  failedCount: number;
  quarantinedCount: number;
  ruleCount: number;
  startedAt: string;
  finishedAt: string | null;
  triggeredBy: string | null;
  /** The ordering key of the list and its cursor: the start of the run to the microsecond. */
  startedKey: string;
}

interface RunSql {
  id: string;
  dataset_id: string;
  dataset_code: string;
  dataset_contract_id: string;
  snapshot_id: string;
  trigger: QualityRunTrigger;
  status: QualityRunStatus;
  overall_result: 'PASSED' | 'WARNING' | 'FAILED' | null;
  score: string | null;
  hard_fail: boolean;
  certified_blocked: boolean;
  failure_code: string | null;
  passed_count: string;
  failed_count: string;
  quarantined_count: string;
  rule_count: number;
  started_at: string;
  finished_at: string | null;
  triggered_by: string | null;
}

const RUN_SELECT = `select r.id, r.dataset_id, d.dataset_code, r.dataset_contract_id, r.snapshot_id, r.trigger, r.status, r.overall_result, r.score::text as score, r.hard_fail,
  r.certified_blocked, r.failure_code, r.passed_count::text as passed_count, r.failed_count::text as failed_count, r.quarantined_count::text as quarantined_count,
  jsonb_array_length(r.rule_version_ids) as rule_count, ${TIME_SQL('r.started_at')} as started_at, ${TIME_SQL('r.finished_at')} as finished_at, r.triggered_by
  from machvon.quality_run r join machvon.dataset d on d.tenant_id = r.tenant_id and d.id = r.dataset_id`;

const toRun = (row: RunSql): QualityRunRow => ({
  id: row.id,
  datasetId: row.dataset_id,
  datasetCode: row.dataset_code,
  datasetContractId: row.dataset_contract_id,
  snapshotId: row.snapshot_id,
  trigger: row.trigger,
  status: row.status,
  overallResult: row.overall_result,
  score: row.score,
  hardFail: row.hard_fail,
  certifiedBlocked: row.certified_blocked,
  failureCode: row.failure_code,
  passedCount: Number(row.passed_count),
  failedCount: Number(row.failed_count),
  quarantinedCount: Number(row.quarantined_count),
  ruleCount: row.rule_count,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  triggeredBy: row.triggered_by,
  startedKey: row.started_at,
});

export interface QualityRunFilter {
  datasetId?: string | undefined;
  status?: QualityRunStatus | undefined;
}

export interface RequestedQualityRun {
  id: string;
  datasetId: string;
  datasetCode: string;
  snapshotId: string;
  ruleCount: number;
  trigger: QualityRunTrigger;
}

interface ContractRow {
  dataset_id: string | null;
  dataset_code: string;
  producer_module: string;
  status: string;
}

export interface QualityScorecardRule {
  ruleVersionId: string;
  code: string;
  revision: number;
  dimension: QualityDimension;
  severity: RuleSeverity;
  actionOnFail: ActionOnFail;
  criticalityWeight: number;
  fieldPath: string | null;
  evaluatedCount: number;
  passedCount: number;
  failedCount: number;
  quarantinedCount: number;
  measuredValue: string | null;
  thresholdSnapshot: Record<string, unknown>;
  result: RuleResult;
  errorCode: string | null;
  incidentId: string | null;
}

export interface QualityScorecardDimension {
  dimension: QualityDimension;
  /** False while no rule of the dimension was measured: the dimension has no score, which is not a score of 0. */
  assessed: boolean;
  score: string | null;
  rulesTotal: number;
  rulesFailed: number;
}

export interface QualityScorecard {
  dataset: DatasetRow;
  latestRun: (QualityRunRow & { snapshotAsOf: string | null; definitionStatus: string | null }) | null;
  /** A run after the latest finished one that has no result (still RUNNING, or FAILED to be measured), so that a failure to measure is never silent. */
  pendingAttempt: QualityRunRow | null;
  rules: QualityScorecardRule[];
  dimensions: QualityScorecardDimension[];
  openIncidents: number;
  overdueIncidents: number;
  /** Seconds since the latest finished run, null without one. */
  ageSeconds: number | null;
}

interface RuleResultSql {
  rule_version_id: string;
  code: string;
  revision: number;
  dimension: QualityDimension;
  severity: RuleSeverity;
  action_on_fail: ActionOnFail;
  criticality_weight: number;
  field_path: string | null;
  evaluated_count: string;
  passed_count: string;
  failed_count: string;
  quarantined_count: string;
  measured_value: string | null;
  threshold_snapshot: Record<string, unknown>;
  result: RuleResult;
  error_code: string | null;
  incident_id: string | null;
}

/**
 * The runs of the quality rules (ST-DGV-002, DGV 3.3 F3) and the scorecards they feed. A run is requested against one frozen snapshot and the
 * approved rule versions of a contract, and says so; it is executed by the quality job (`DgvQualityRunJob`). A scorecard shows only what was
 * measured: a dataset with no finished run is NOT_ASSESSED with no score, and a dimension no rule measured has no score.
 */
export class DgvQualityRunStore {
  private readonly datasets = new DgvDatasetStore();
  private readonly rules = new DgvQualityRuleStore();

  /**
   * Requests a run of the approved rules of a contract on a frozen snapshot: the run starts RUNNING, with the rule versions and the digest of
   * the snapshot it applies. A snapshot that does not exist is 404 SNAPSHOT_NOT_FOUND, one that is not frozen is 409; a snapshot of the dataset
   * that already has a run in progress is 409 RUN_ALREADY_RUNNING.
   */
  async request(tx: TenantTx, input: { datasetContractId: string; snapshotId: string; trigger: 'MANUAL' | 'SCHEDULE' }, viewer: DatasetViewer): Promise<RequestedQualityRun> {
    // A contract of the tenant that is bound to a dataset the requester may see; anything else is a contract that does not exist for them.
    const contracts = await tx.query<ContractRow>(
      `select c.dataset_id, d.dataset_code, d.producer_module, d.status
         from machvon.dataset_contract c join machvon.dataset d on d.tenant_id = c.tenant_id and d.id = c.dataset_id
        where c.id = $3::uuid and ${DATASET_VISIBLE}`,
      [viewer.membershipId, [...viewer.roleCodes], input.datasetContractId],
    );
    const contract = contracts[0];
    if (contract === undefined || contract.dataset_id === null) throw invalid('dataset_contract_id');
    if (contract.status === 'RETIRED') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    return this.insert(tx, { datasetId: contract.dataset_id, datasetCode: contract.dataset_code, producerModule: contract.producer_module, contractId: input.datasetContractId, snapshotId: input.snapshotId, trigger: input.trigger, actor: viewer.membershipId });
  }

  /**
   * Starts the runs that a frozen snapshot calls for: one for every dataset of the producing module that has approved rules (the contract with the
   * highest revision among those that have). The delivery of the event twice, or two events for one snapshot, start one run per dataset. A
   * snapshot that is not frozen, or that no module of ours produced, starts none. Returns the runs started now.
   */
  async requestForFrozenSnapshot(tx: TenantTx, snapshotId: string, actor: string): Promise<RequestedQualityRun[]> {
    const started: RequestedQualityRun[] = [];
    const candidates = await tx.query<{ dataset_id: string; dataset_code: string; producer_module: string; contract_id: string }>(
      `select distinct on (d.id) d.id as dataset_id, d.dataset_code, d.producer_module, c.id as contract_id
         from machvon.dataset d
         join machvon.dataset_contract c on c.tenant_id = d.tenant_id and c.dataset_id = d.id
        where d.status <> 'RETIRED'
          and exists (select 1 from machvon.quality_rule_version v where v.tenant_id = c.tenant_id and v.contract_id = c.id and v.status = 'APPROVED')
        order by d.id, c.revision desc`,
    );
    for (const candidate of candidates) {
      const source = qualitySourceOf(candidate.producer_module);
      if (source === undefined) continue;
      const snapshot = await loadSnapshot(tx, source, snapshotId);
      if (snapshot === undefined || snapshot.status !== 'FROZEN') continue;
      try {
        started.push(await this.insert(tx, { datasetId: candidate.dataset_id, datasetCode: candidate.dataset_code, producerModule: candidate.producer_module, contractId: candidate.contract_id, snapshotId, trigger: 'SNAPSHOT_FROZEN', actor }, snapshot));
      } catch (error) {
        // A run for this snapshot and dataset exists already (this delivery is a repeat, or a person asked first): nothing more to start.
        if (!(error instanceof DomainError) || error.code !== 'RUN_ALREADY_RUNNING') throw error;
      }
    }
    return started;
  }

  private async insert(
    tx: TenantTx,
    run: { datasetId: string; datasetCode: string; producerModule: string; contractId: string; snapshotId: string; trigger: QualityRunTrigger; actor: string },
    known?: { status: string; payloadSha256: string | null },
  ): Promise<RequestedQualityRun> {
    const source = qualitySourceOf(run.producerModule);
    if (source === undefined) throw invalid('dataset_contract_id');
    const snapshot = known ?? (await loadSnapshot(tx, source, run.snapshotId));
    if (snapshot === undefined) throw new DomainError('SNAPSHOT_NOT_FOUND', 404, 'snapshot_id');
    // Only a frozen snapshot is measured: the figures of one that is still being built, or that failed, are not final.
    if (!source.finalStatuses.includes(snapshot.status) || snapshot.payloadSha256 === null) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'snapshot_id');
    const approved = await this.rules.approvedOfContract(tx, run.contractId);
    if (approved.length === 0) throw invalid('dataset_contract_id');
    const id = randomUUID();
    await tx.query('savepoint quality_run_start');
    try {
      await tx.query(
        `insert into machvon.quality_run
           (tenant_id, id, dataset_contract_id, snapshot_id, rule_version_ids, passed_count, failed_count, quarantined_count, finished_at, dataset_id, trigger, started_at, status, hard_fail, certified_blocked, triggered_by, snapshot_sha256, attempts)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::jsonb, 0, 0, 0, null, $5::uuid, $6, now(), 'RUNNING', false, false, $7::uuid, $8, 0)`,
        [id, run.contractId, run.snapshotId, JSON.stringify(approved.map((rule) => rule.id)), run.datasetId, run.trigger, run.actor, snapshot.payloadSha256],
      );
      await tx.query('release savepoint quality_run_start');
    } catch (error) {
      await tx.query('rollback to savepoint quality_run_start');
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new DomainError('RUN_ALREADY_RUNNING', 409, 'snapshot_id');
      throw error;
    }
    return { id, datasetId: run.datasetId, datasetCode: run.datasetCode, snapshotId: run.snapshotId, ruleCount: approved.length, trigger: run.trigger };
  }

  /** The run with this id when the viewer may see its dataset. */
  async find(tx: TenantTx, id: string, viewer: DatasetViewer): Promise<QualityRunRow | undefined> {
    const rows = await tx.query<RunSql>(`${RUN_SELECT} where r.id = $3::uuid and ${DATASET_VISIBLE}`, [viewer.membershipId, [...viewer.roleCodes], id]);
    return rows[0] === undefined ? undefined : toRun(rows[0]);
  }

  /** The runs of the datasets the viewer may see, newest first; the page after `after` (the start of a run and its id) when given. */
  async list(tx: TenantTx, viewer: DatasetViewer, filter: QualityRunFilter, request: { limit: number; after: { code: string; id: string } | undefined }): Promise<QualityRunRow[]> {
    assertTimestampCursor(request.after?.code);
    const rows = await tx.query<RunSql>(
      `${RUN_SELECT}
        where ${DATASET_VISIBLE} and ($3::uuid is null or r.dataset_id = $3::uuid) and ($4::text is null or r.status = $4)
          and ($5::text is null or (${TIME_SQL('r.started_at')}, r.id) < ($5::text, $6::uuid))
        order by ${TIME_SQL('r.started_at')} desc, r.id desc limit $7`,
      [viewer.membershipId, [...viewer.roleCodes], filter.datasetId ?? null, filter.status ?? null, request.after?.code ?? null, request.after?.id ?? null, request.limit],
    );
    return rows.map(toRun);
  }

  /**
   * The scorecard of a dataset the viewer may see (DGV-01, DGV-07): the badge and the score of the latest finished run - NOT_ASSESSED with no
   * score when there is none, STALE when it is older than the freshness SLO - the result of each rule that run applied, the score of each
   * dimension that was measured, and the incidents still open. Undefined when the dataset does not exist for the viewer.
   */
  async scorecard(tx: TenantTx, datasetId: string, viewer: DatasetViewer): Promise<QualityScorecard | undefined> {
    const dataset = await this.datasets.find(tx, datasetId, viewer);
    if (dataset === undefined) return undefined;
    const latest = await tx.query<RunSql>(`${RUN_SELECT} where r.dataset_id = $1::uuid and r.status = 'COMPLETED' order by r.finished_at desc, r.id desc limit 1`, [datasetId]);
    const latestRun = latest[0] === undefined ? undefined : toRun(latest[0]);
    const attempts = await tx.query<RunSql>(`${RUN_SELECT} where r.dataset_id = $1::uuid order by r.started_at desc, r.id desc limit 1`, [datasetId]);
    const attempt = attempts[0] === undefined ? undefined : toRun(attempts[0]);
    const pendingAttempt = attempt !== undefined && attempt.id !== latestRun?.id && attempt.status !== 'COMPLETED' ? attempt : null;
    let results: QualityScorecardRule[] = [];
    let snapshotAsOf: string | null = null;
    let definitionStatus: string | null = null;
    if (latestRun !== undefined) {
      const rows = await tx.query<RuleResultSql>(
        `select res.rule_version_id, v.code, v.revision, v.dimension, v.severity, v.action_on_fail, v.criticality_weight, v.field_path,
                res.evaluated_count::text as evaluated_count, res.passed_count::text as passed_count, res.failed_count::text as failed_count,
                res.quarantined_count::text as quarantined_count, res.measured_value::text as measured_value, res.threshold_snapshot, res.result, res.error_code, res.incident_id
           from machvon.quality_rule_result res join machvon.quality_rule_version v on v.tenant_id = res.tenant_id and v.id = res.rule_version_id
          where res.run_id = $1::uuid order by v.dimension, v.code, v.revision`,
        [latestRun.id],
      );
      results = rows.map((row) => ({
        ruleVersionId: row.rule_version_id,
        code: row.code,
        revision: row.revision,
        dimension: row.dimension,
        severity: row.severity,
        actionOnFail: row.action_on_fail,
        criticalityWeight: row.criticality_weight,
        fieldPath: row.field_path,
        evaluatedCount: Number(row.evaluated_count),
        passedCount: Number(row.passed_count),
        failedCount: Number(row.failed_count),
        quarantinedCount: Number(row.quarantined_count),
        measuredValue: row.measured_value,
        thresholdSnapshot: row.threshold_snapshot,
        result: row.result,
        errorCode: row.error_code,
        incidentId: row.incident_id,
      }));
      const source = qualitySourceOf(dataset.producerModule);
      const snapshot = source === undefined ? undefined : await loadSnapshot(tx, source, latestRun.snapshotId);
      snapshotAsOf = snapshot?.asOf ?? null;
      definitionStatus = snapshot?.definitionStatus ?? null;
    }
    const incidents = await tx.query<{ open: string; overdue: string }>(
      `select (count(*) filter (where i.status <> 'CLOSED'))::text as open, (count(*) filter (where i.status <> 'CLOSED' and i.due_at < now()))::text as overdue
         from machvon.quality_incident i left join machvon.quality_run r on r.tenant_id = i.tenant_id and r.id = i.run_id left join machvon.reconciliation_run c on c.tenant_id = i.tenant_id and c.id = i.reconciliation_id
        where coalesce(r.dataset_id, c.dataset_id) = $1::uuid`,
      [datasetId],
    );
    let ageSeconds: number | null = null;
    if (latestRun?.finishedAt != null) {
      const age = await tx.query<{ age: string }>('select floor(extract(epoch from now() - $1::timestamptz))::text as age', [latestRun.finishedAt]);
      ageSeconds = Number(age[0]?.age ?? 0);
    }
    return {
      dataset,
      latestRun: latestRun === undefined ? null : { ...latestRun, snapshotAsOf, definitionStatus },
      pendingAttempt,
      rules: results,
      dimensions: dimensionsOf(results),
      openIncidents: Number(incidents[0]?.open ?? 0),
      overdueIncidents: Number(incidents[0]?.overdue ?? 0),
      ageSeconds,
    };
  }
}

/** The seven dimensions with the score of each that was measured: the weighted mean of its rules' pass rates, none measured meaning no score. */
export function dimensionsOf(results: readonly QualityScorecardRule[]): QualityScorecardDimension[] {
  return QUALITY_DIMENSIONS.map((dimension) => {
    const own = results.filter((rule) => rule.dimension === dimension);
    const measured = own.filter((rule) => rule.measuredValue !== null);
    const score = weightedScore(measured.map((rule) => ({ weight: rule.criticalityWeight, rateMicro: Number((rule.measuredValue as string).replace('.', '')) })));
    return { dimension, assessed: measured.length > 0, score, rulesTotal: own.length, rulesFailed: own.filter((rule) => rule.result === 'FAIL').length };
  });
}
