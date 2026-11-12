import { DomainError, canonicalJson, pwfKpi, processCore } from '@machvon/kernel';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import type { ResolvedGovernanceRule } from '@machvon/kernel';
import { PwfKpiStore, scoreBundle } from './pwf-kpi-store.ts';
import { computeFigures, previewHashOf, snapshotHashOf, snapshotOf, verifySnapshot } from './pwf-score-compute.ts';
import type { PeriodFigures, PeriodSnapshot, SnapshotInputs, SnapshotKpi, SnapshotTask } from './pwf-score-compute.ts';
import { dayOfInstant, loadCalendars, loadKpiSets, loadTaskBundles, readingOf, yearSpanOf } from './pwf-score-facts.ts';
import type { CalendarSet, TaskBundle } from './pwf-score-facts.ts';
import { SYSTEM_SCORE_SCOPE, checkVersion, lockPeriod, lockPeriodKey, notFound, scoreIdOf, unitReached, withScoreScope } from './pwf-score-support.ts';
import type { ScoreUnits } from './pwf-score-support.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The scoring period of the staff of a unit (PWF-3, docs PWF 3 F9, 4, 5 BR-PWF-34 to 39, R34, R43). `compute` reads the tasks the people of the unit held (the ledger of assignments, the results of the KPIs, the open
 * tasks read in memory as of the end of the period) and writes the lines and the signals of a DRAFT that can be computed again; `lock` reads them once more, takes the snapshot of everything the figures came from and
 * its hash, and no way back opens; `officialize` ends the window of response; `verify` computes the lines of a locked period again from its snapshot. A command that reaches the period takes the lock of the period, so a
 * lock and an adjustment never read each other half done. Who may do what is judged by the caller (the permission and the units); the tables of scores answer through the policy of the database as well.
 */

const MAX_PERIOD_DAYS = 400;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const POLICY_CODE = /^[A-Z][A-Z0-9_]{1,39}$/;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export interface PeriodRow {
  id: string;
  scopeUnitId: string;
  periodKind: 'MONTH' | 'QUARTER' | 'YEAR';
  periodFrom: string;
  periodTo: string;
  status: 'DRAFT' | 'LOCKED' | 'OFFICIAL';
  policyCode: string;
  policyRuleId: string | null;
  policyVersion: number;
  previewHash: string | null;
  snapshotHash: string | null;
  summary: PeriodFigures['summary'];
  lockedBy: string | null;
  lockedAt: string | null;
  responseUntil: string | null;
  officialAt: string | null;
  supersedesPeriodId: string | null;
  version: number;
}

interface PeriodSql {
  id: string;
  scope_unit_id: string;
  period_kind: PeriodRow['periodKind'];
  period_from: string;
  period_to: string;
  status: PeriodRow['status'];
  policy_code: string;
  policy_rule_id: string | null;
  policy_version: number;
  preview_hash: string | null;
  snapshot_hash: string | null;
  summary: PeriodFigures['summary'];
  locked_by: string | null;
  locked_at: string | null;
  response_until: string | null;
  official_at: string | null;
  supersedes_period_id: string | null;
  version: number;
}

export const PERIOD_COLUMNS = `p.id, p.scope_unit_id, p.period_kind, p.period_from::text as period_from, p.period_to::text as period_to, p.status, p.policy_code, p.policy_rule_id, p.policy_version, p.preview_hash, p.snapshot_hash,
  p.summary, p.locked_by, to_char(p.locked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as locked_at, p.response_until::text as response_until,
  to_char(p.official_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as official_at, p.supersedes_period_id, p.version`;

export const toPeriod = (row: PeriodSql): PeriodRow => ({
  id: row.id,
  scopeUnitId: row.scope_unit_id,
  periodKind: row.period_kind,
  periodFrom: row.period_from,
  periodTo: row.period_to,
  status: row.status,
  policyCode: row.policy_code,
  policyRuleId: row.policy_rule_id,
  policyVersion: row.policy_version,
  previewHash: row.preview_hash,
  snapshotHash: row.snapshot_hash,
  summary: row.summary,
  lockedBy: row.locked_by,
  lockedAt: row.locked_at,
  responseUntil: row.response_until,
  officialAt: row.official_at,
  supersedesPeriodId: row.supersedes_period_id,
  version: row.version,
});

export interface ComputeRequest {
  scopeUnitId: string;
  periodFrom: string;
  periodTo: string;
  policyCode: string;
  actor: string;
  /** The units the caller may manage scores in (`staff_score.manage`). */
  units: ScoreUnits;
  now: Date;
}

export interface PeriodPreview {
  period: PeriodRow;
  ratedCount: number;
  smallSampleCount: number;
  notRatedCount: number;
  signalCount: number;
  excludedTaskCount: number;
  previewHash: string;
  /** Whether this call made the period (false: a draft of the same days was computed again). */
  created: boolean;
}

export interface PeriodCommandResult {
  id: string;
  scopeUnitId: string;
  fromStatus: string;
  status: string;
  version: number;
  facts: Record<string, unknown>;
}

interface Built {
  inputs: SnapshotInputs;
  figures: PeriodFigures;
  policy: pwfKpi.StaffScoringPolicy;
  rule: ResolvedGovernanceRule;
}

/** Whether `from` to `to` is a whole month, quarter or year, the way the policy says periods are. */
export function periodMatchesKind(kind: pwfKpi.StaffScoringPolicy['periodKind'], from: string, to: string): boolean {
  const [fromYear, fromMonth, fromDay] = from.split('-').map(Number) as [number, number, number];
  const [toYear, toMonth] = to.split('-').map(Number) as [number, number, number];
  const lastDay = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (fromDay !== 1 || fromYear !== toYear) return false;
  if (to !== `${toYear}-${String(toMonth).padStart(2, '0')}-${String(lastDay(toYear, toMonth)).padStart(2, '0')}`) return false;
  if (kind === 'MONTH') return fromMonth === toMonth;
  if (kind === 'QUARTER') return (fromMonth - 1) % 3 === 0 && toMonth === fromMonth + 2;
  return fromMonth === 1 && toMonth === 12;
}

export class PwfScoreStore {
  private readonly policies = new GovernancePolicyPort();
  private readonly kpis = new PwfKpiStore();

  /** The inputs of the period read from the database: the tasks people of the unit held that are measured in the period, as of the end of it. */
  private async inputsOf(tx: TenantTx, request: { unitId: string; from: string; to: string; policyCode: string }, now: Date): Promise<Built> {
    const rule = await this.policies.get(tx, pwfKpi.STAFF_SCORING_POLICY_RULE_TYPE, request.policyCode, request.to);
    if (rule === undefined) throw new DomainError('GOVERNANCE_RULE_NOT_FOUND', 404, 'policy_code');
    const policy = pwfKpi.parseStaffScoringPolicy(rule.params);
    if (!periodMatchesKind(policy.periodKind, request.from, request.to)) throw invalid('period_to');
    const units = await tx.query<{ path: string }>('select path from machvon.organization_unit where id = $1::uuid', [request.unitId]);
    const unit = units[0];
    if (unit === undefined) throw notFound();
    const prefix = unit.path.endsWith('/') ? unit.path : `${unit.path}/`;
    const members = await tx.query<{ membership_id: string; unit_id: string }>(
      'select m.id as membership_id, m.organization_id as unit_id from machvon.membership m join machvon.organization_unit u on u.tenant_id = m.tenant_id and u.id = m.organization_id where starts_with(u.path, $1) order by m.id',
      [prefix],
    );
    const candidates = await tx.query<{ id: string }>(
      `select t.id from machvon.project_task t
        where t.tracked and not t.excluded and t.kind = 'TASK'
          and exists (select 1 from machvon.project_task_assignment a where a.tenant_id = t.tenant_id and a.task_id = t.id and a.membership_id = any($1::uuid[]))
          and (
               (t.status = 'DONE' and t.actual_finish between $2::date and $3::date)
            or (t.status = 'CANCELLED' and (t.cancelled_at at time zone 'Asia/Ho_Chi_Minh')::date between $2::date and $3::date)
            or (t.baseline_finish <= $3::date
                and not (t.status = 'DONE' and t.actual_finish <= $3::date)
                and not (t.status = 'CANCELLED' and (t.cancelled_at at time zone 'Asia/Ho_Chi_Minh')::date <= $3::date))
          )
        order by t.id`,
      [members.map((member) => member.membership_id), request.from, request.to],
    );
    const bundles = await loadTaskBundles(tx, candidates.map((row) => row.id));
    const ordered = [...bundles.values()].sort((left, right) => (left.row.id < right.row.id ? -1 : 1));
    const readings = new Map(ordered.map((bundle) => [bundle.row.id, readingOf(bundle.row, request.to)] as const));
    const finals = ordered.filter((bundle) => readings.get(bundle.row.id)?.final === true).map((bundle) => bundle.row.id);
    // A task closed by the end of the period has its results recorded (idempotently) before the period reads them; one whose results were evaluated at its present version is not read again (the job keeps them current).
    const behind = finals.filter((id) => {
      const row = (bundles.get(id) as TaskBundle).row;
      return row.kpiRecordedVersion !== row.version;
    });
    await this.kpis.record(tx, behind, now);
    const heads = await this.kpis.heads(tx, finals, false);
    const span = yearSpanOf(
      ordered.flatMap((bundle) => [bundle.row.baselineFirst, bundle.row.baselineCurrent, bundle.row.baselineStart, bundle.row.plannedStart, bundle.row.actualStart, bundle.row.actualFinish, bundle.row.cancelledOn]),
      request.to,
    );
    const calendars = await loadCalendars(tx, Math.min(span.from, Number(request.from.slice(0, 4))), span.to);
    const sets = await loadKpiSets(tx, this.policies, request.to);
    const usedSets = new Map<string, { code: string; rule_id: string | null; version: number }>();
    const tasks: SnapshotTask[] = [];
    for (const bundle of ordered) {
      const reading = readings.get(bundle.row.id) as ReturnType<typeof readingOf>;
      const resolved = sets.forTemplate(bundle.workflow.templateCode);
      let kpi: SnapshotKpi[];
      if (reading.final) {
        kpi = (heads.get(bundle.row.id) ?? []).map((one) => ({ kpi_code: one.kpiCode, operation: one.operation, state: one.state, value: one.value, score: one.score, weight: one.weight, inputs_hash: one.inputsHash, result_id: one.id }));
      } else {
        kpi = scoreBundle(bundle, reading, request.to, resolved, calendars).map(({ result }) => ({ kpi_code: result.kpiCode, operation: result.operation, state: result.state, value: result.value, score: result.score, weight: result.weight, inputs_hash: result.inputsHash, result_id: null }));
        usedSets.set(resolved.code, { code: resolved.code, rule_id: resolved.ruleId, version: resolved.version });
      }
      if (reading.final) usedSets.set(resolved.code, { code: resolved.code, rule_id: resolved.ruleId, version: resolved.version });
      tasks.push(taskOf(bundle, reading, kpi, request.from, request.to));
    }
    const workflowIds = [...new Set(tasks.map((task) => task.workflow_id))].sort();
    const baselines = workflowIds.length === 0 ? [] : await tx.query<{ workflow_id: string; version: number; taken_on: string }>(
      `select workflow_id, version, (taken_at at time zone 'Asia/Ho_Chi_Minh')::date::text as taken_on from machvon.project_workflow_baseline where workflow_id = any($1::uuid[]) order by workflow_id, version`,
      [workflowIds],
    );
    const inputs: SnapshotInputs = {
      version: 1,
      period: { unit_id: request.unitId, from: request.from, to: request.to, kind: policy.periodKind },
      policy: { code: request.policyCode, rule_id: rule.ruleId, version: rule.version, params: rule.params as Record<string, unknown> },
      kpi_sets: [...usedSets.values()].sort((left, right) => (left.code < right.code ? -1 : 1)),
      calendars: calendars.versions,
      workflows: workflowIds.map((workflowId) => {
        const own = baselines.filter((one) => one.workflow_id === workflowId);
        return { workflow_id: workflowId, baseline_locked_on: own.find((one) => one.version === 1)?.taken_on ?? null, baseline_revisions: own.filter((one) => one.version > 1).map((one) => one.taken_on) };
      }),
      members,
      tasks,
    };
    return { inputs, figures: computeFigures(inputs, policy, calendars.source), policy, rule };
  }

  /** Computes the draft of a period of the unit (the same days again compute the draft again), or refuses: the unit is out of the reach of the caller, the days do not match the kind of the policy, the days overlap another period. */
  async compute(tx: TenantTx, request: ComputeRequest): Promise<PeriodPreview> {
    const unitId = scoreIdOf(request.scopeUnitId, 'scope_unit_id');
    for (const [field, value] of [['period_from', request.periodFrom], ['period_to', request.periodTo]] as const) if (!DAY.test(value) || !processCore.isWorkflowDay(value)) throw invalid(field);
    if (request.periodTo < request.periodFrom || processCore.workflowDaysBetween(request.periodFrom, request.periodTo) >= MAX_PERIOD_DAYS) throw invalid('period_to');
    if (!POLICY_CODE.test(request.policyCode)) throw invalid('policy_code');
    if (!unitReached(request.units, unitId)) throw notFound();
    await lockPeriodKey(tx, unitId, request.periodFrom, request.periodTo);
    const overlapping = await tx.query<PeriodSql>(
      `select ${PERIOD_COLUMNS} from machvon.staff_score_period p where p.scope_unit_id = $1::uuid and p.supersedes_period_id is null and daterange(p.period_from, p.period_to, '[]') && daterange($2::date, $3::date, '[]') for update`,
      [unitId, request.periodFrom, request.periodTo],
    );
    const same = overlapping.find((row) => row.period_from === request.periodFrom && row.period_to === request.periodTo);
    if (overlapping.length > 0 && same === undefined) throw new DomainError('STAFF_SCORE_PERIOD_OVERLAP', 409, 'period_from');
    if (same !== undefined) await lockPeriod(tx, same.id);
    if (same !== undefined && same.status !== 'DRAFT') throw new DomainError('STAFF_SCORE_PERIOD_LOCKED', 409, 'status', { extensions: { period_status: same.status } });
    const built = await withScoreScope(tx, SYSTEM_SCORE_SCOPE, async () => {
      const result = await this.inputsOf(tx, { unitId, from: request.periodFrom, to: request.periodTo, policyCode: request.policyCode }, request.now);
      const previewHash = previewHashOf(result.inputs, result.figures);
      let id: string;
      if (same === undefined) {
        const rows = await tx.query<{ id: string }>(
          `insert into machvon.staff_score_period (tenant_id, scope_unit_id, period_kind, period_from, period_to, policy_code, policy_rule_id, policy_version, preview_hash, computed_by, summary, created_by, updated_by)
           values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3::date, $4::date, $5, $6::uuid, $7, $8, $9::uuid, $10::jsonb, $9::uuid, $9::uuid) returning id`,
          [unitId, result.policy.periodKind, request.periodFrom, request.periodTo, request.policyCode, result.rule.ruleId, result.rule.version, previewHash, request.actor, JSON.stringify(result.figures.summary)],
        );
        id = (rows[0] as { id: string }).id;
      } else {
        id = same.id;
        await tx.query('delete from machvon.staff_score_signal where period_id = $1::uuid', [id]);
        await tx.query('delete from machvon.staff_score_line where period_id = $1::uuid', [id]);
        await tx.query(
          `update machvon.staff_score_period set policy_code = $2, policy_rule_id = $3::uuid, policy_version = $4, preview_hash = $5, computed_at = now(), computed_by = $6::uuid, summary = $7::jsonb,
                  version = version + 1, updated_at = now(), updated_by = $6::uuid where id = $1::uuid`,
          [id, request.policyCode, result.rule.ruleId, result.rule.version, previewHash, request.actor, JSON.stringify(result.figures.summary)],
        );
      }
      await this.writeFigures(tx, id, result.figures);
      return { id, previewHash, result };
    });
    const [row] = await tx.query<PeriodSql>(`select ${PERIOD_COLUMNS} from machvon.staff_score_period p where p.id = $1::uuid`, [built.id]);
    const { summary } = built.result.figures;
    return {
      period: toPeriod(row as PeriodSql),
      ratedCount: summary.rated,
      smallSampleCount: summary.small_sample,
      notRatedCount: summary.not_rated,
      signalCount: summary.signals,
      excludedTaskCount: summary.excluded_tasks,
      previewHash: built.previewHash,
      created: same === undefined,
    };
  }

  /** Writes the lines and the signals of a draft: one statement each, whatever the number of people. */
  private async writeFigures(tx: TenantTx, periodId: string, figures: PeriodFigures): Promise<void> {
    if (figures.lines.length > 0) {
      await tx.query(
        `insert into machvon.staff_score_line (tenant_id, period_id, membership_id, unit_id_at_period, score_computed, score_adjusted, rating, state, rated_task_count, effective_weight, contributions, excluded)
         select nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, x.membership_id, x.unit_id, x.score, x.score, x.rating, x.state, x.rated_task_count, x.effective_weight, x.contributions, x.excluded
           from jsonb_to_recordset($2::jsonb) as x(membership_id uuid, unit_id uuid, score numeric, rating text, state text, rated_task_count integer, effective_weight numeric, contributions jsonb, excluded jsonb)`,
        [
          periodId,
          JSON.stringify(figures.lines.map((line) => ({ membership_id: line.membership_id, unit_id: line.unit_id, score: line.score_computed, rating: line.rating, state: line.state, rated_task_count: line.rated_task_count, effective_weight: line.effective_weight, contributions: line.contributions, excluded: line.excluded }))),
        ],
      );
    }
    if (figures.signals.length > 0) {
      await tx.query(
        `insert into machvon.staff_score_signal (tenant_id, period_id, membership_id, unit_id_at_period, code, task_codes)
         select nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, x.membership_id, x.unit_id, x.code, x.task_codes
           from jsonb_to_recordset($2::jsonb) as x(membership_id uuid, unit_id uuid, code text, task_codes jsonb)`,
        [periodId, JSON.stringify(figures.signals.map((signal) => ({ membership_id: signal.membership_id, unit_id: signal.unit_id, code: signal.code, task_codes: signal.task_codes })))],
      );
    }
  }

  private async locate(tx: TenantTx, periodId: string, units: ScoreUnits): Promise<PeriodRow> {
    const rows = await tx.query<PeriodSql>(`select ${PERIOD_COLUMNS} from machvon.staff_score_period p where p.id = $1::uuid for update`, [periodId]);
    const row = rows[0];
    if (row === undefined || !unitReached(units, row.scope_unit_id)) throw notFound();
    return toPeriod(row);
  }

  /**
   * Locks a draft period: the figures are read once more as of now (a task done since the draft is in), the snapshot of everything they came from is taken and hashed, and the period is LOCKED with the window of
   * response open. A period that is not a draft is 409 `STAFF_SCORE_PERIOD_LOCKED`; a stale version is 409 `VERSION_CONFLICT`. No way back opens.
   */
  async lock(tx: TenantTx, request: { periodId: string; expectedVersion: number; actor: string; units: ScoreUnits; now: Date }): Promise<PeriodCommandResult> {
    const periodId = scoreIdOf(request.periodId, 'id');
    await lockPeriod(tx, periodId);
    const period = await this.locate(tx, periodId, request.units);
    checkVersion(period.version, request.expectedVersion);
    if (period.status !== 'DRAFT') throw new DomainError('STAFF_SCORE_PERIOD_LOCKED', 409, 'status', { extensions: { period_status: period.status } });
    const today = dayOfInstant(request.now);
    const built = await withScoreScope(tx, SYSTEM_SCORE_SCOPE, async () => {
      const result = await this.inputsOf(tx, { unitId: period.scopeUnitId, from: period.periodFrom, to: period.periodTo, policyCode: period.policyCode }, request.now);
      await tx.query('delete from machvon.staff_score_signal where period_id = $1::uuid', [periodId]);
      await tx.query('delete from machvon.staff_score_line where period_id = $1::uuid', [periodId]);
      await this.writeFigures(tx, periodId, result.figures);
      return result;
    });
    const snapshot = snapshotOf(built.inputs, built.figures, request.now.toISOString());
    const hash = snapshotHashOf(snapshot);
    const responseUntil = processCore.workflowAddDays(today, built.policy.responseWindowDays);
    await tx.query(
      `update machvon.staff_score_period set status = 'LOCKED', policy_rule_id = $2::uuid, policy_version = $3, preview_hash = $4, snapshot = $5::jsonb, snapshot_hash = $6, summary = $7::jsonb, locked_by = $8::uuid, locked_at = $9::timestamptz,
              response_until = $10::date, version = version + 1, updated_at = now(), updated_by = $8::uuid where id = $1::uuid`,
      [periodId, built.rule.ruleId, built.rule.version, previewHashOf(built.inputs, built.figures), canonicalJson(snapshot), hash, JSON.stringify(built.figures.summary), request.actor, request.now.toISOString(), responseUntil],
    );
    return { id: periodId, scopeUnitId: period.scopeUnitId, fromStatus: 'DRAFT', status: 'LOCKED', version: period.version + 1, facts: { period_from: period.periodFrom, period_to: period.periodTo, policy_code: period.policyCode, policy_version: built.rule.version, snapshot_hash: hash, response_until: responseUntil, people: built.figures.summary.people } };
  }

  /**
   * Makes a locked period official once the window of response has ended or every response was handled, and never while a response is open (R43). Before that it is 409 `STAFF_SCORE_PERIOD_LOCKED` with the reason
   * (`WINDOW_OPEN`, `RESPONSES_OPEN`); an official period stays as it is.
   */
  async officialize(tx: TenantTx, request: { periodId: string; expectedVersion: number | undefined; actor: string; units: ScoreUnits; now: Date }): Promise<PeriodCommandResult> {
    const periodId = scoreIdOf(request.periodId, 'id');
    await lockPeriod(tx, periodId);
    const period = await this.locate(tx, periodId, request.units);
    if (request.expectedVersion !== undefined) checkVersion(period.version, request.expectedVersion);
    if (period.status !== 'LOCKED') throw new DomainError('STAFF_SCORE_PERIOD_LOCKED', 409, 'status', { extensions: { period_status: period.status } });
    const policy = await this.policyOf(tx, periodId);
    const responses = await withScoreScope(tx, SYSTEM_SCORE_SCOPE, () =>
      tx.query<{ status: 'OPEN' | 'HANDLED' }>('select r.status from machvon.staff_score_response r join machvon.staff_score_line l on l.tenant_id = r.tenant_id and l.id = r.line_id where l.period_id = $1::uuid', [periodId]),
    );
    const today = dayOfInstant(request.now);
    const verdict = pwfKpi.canOfficialize({ lockedAt: dayOfInstant(new Date(period.lockedAt as string)), responseWindowDays: policy.responseWindowDays, responses, today });
    if (!verdict.official) throw new DomainError('STAFF_SCORE_PERIOD_LOCKED', 409, 'status', { extensions: { period_status: period.status, reason: verdict.reason } });
    await tx.query(`update machvon.staff_score_period set status = 'OFFICIAL', official_at = $2::timestamptz, official_by = $3::uuid, version = version + 1, updated_at = now(), updated_by = $3::uuid where id = $1::uuid`, [periodId, request.now.toISOString(), request.actor]);
    return { id: periodId, scopeUnitId: period.scopeUnitId, fromStatus: 'LOCKED', status: 'OFFICIAL', version: period.version + 1, facts: { period_from: period.periodFrom, period_to: period.periodTo, snapshot_hash: period.snapshotHash, reason: verdict.reason } };
  }

  /** The policy a locked period was computed by, from its snapshot (never the policy in force now: the rules of a period are the ones it was locked under). */
  async policyOf(tx: TenantTx, periodId: string): Promise<pwfKpi.StaffScoringPolicy> {
    const rows = await tx.query<{ params: Record<string, unknown> | null }>("select snapshot #> '{policy,params}' as params from machvon.staff_score_period where id = $1::uuid", [periodId]);
    const params = rows[0]?.params;
    if (params === null || params === undefined) throw notFound();
    return pwfKpi.parseStaffScoringPolicy(params);
  }

  /** Computes the lines of a locked period again from its snapshot and compares them, and the hash, with what was stored: whether the period is reproducible. */
  async verify(tx: TenantTx, periodId: string): Promise<{ reproducible: boolean; hashMatches: boolean; figuresMatch: boolean }> {
    const id = scoreIdOf(periodId, 'id');
    const rows = await tx.query<{ snapshot: PeriodSnapshot | null; snapshot_hash: string | null }>('select snapshot, snapshot_hash from machvon.staff_score_period where id = $1::uuid', [id]);
    const row = rows[0];
    if (row === undefined || row.snapshot === null || row.snapshot_hash === null || (row.snapshot as { erased?: boolean }).erased === true) throw notFound();
    const policy = pwfKpi.parseStaffScoringPolicy(row.snapshot.policy.params);
    const pins = row.snapshot.calendars;
    let source: CalendarSet['source'];
    if (pins.length > 0) {
      const found = await tx.query<{ year: number; revision: number; working_days: number[]; holidays: Array<{ date: string; name?: string }>; compensated_workdays: string[] | null; legal_basis_ref: string }>(
        `select year, revision, working_days, holidays, compensated_workdays, legal_basis_ref from machvon.work_calendar_version where calendar_code = 'WORKDAY_VN' and (year, revision) in (select * from unnest($1::int[], $2::int[]))`,
        [pins.map((pin) => pin.year), pins.map((pin) => pin.version)],
      );
      const byYear = new Map(found.map((one) => [one.year, one] as const));
      source = { forYear: (year) => { const one = byYear.get(year); return one === undefined ? undefined : { calendar_code: 'WORKDAY_VN', year: one.year, working_days: one.working_days, holidays: one.holidays as never, compensated_workdays: one.compensated_workdays ?? [], legal_basis_ref: one.legal_basis_ref }; } };
    }
    return verifySnapshot(row.snapshot, row.snapshot_hash, policy, source);
  }

  /** The periods whose personal data has outlived the retention of their policy, official ones only (the job anonymises them one by one). */
  async expiredPeriodIds(tx: TenantTx, now: Date): Promise<string[]> {
    const rows = await tx.query<{ id: string }>(
      `select p.id from machvon.staff_score_period p
        where p.status = 'OFFICIAL' and p.erased_at is null and p.period_to < ($1::date - make_interval(months => coalesce((p.snapshot #>> '{policy,params,retention_months}')::int, 60)))::date
        order by p.period_to, p.id limit 100`,
      [dayOfInstant(now)],
    );
    return rows.map((row) => row.id);
  }

  /** Anonymises one official period whose retention ended (V3033): the person, the words and the tasks are gone, the hash and the figures without a name stay. */
  async expire(tx: TenantTx, periodId: string): Promise<boolean> {
    const rows = await tx.query<{ done: number }>('select machvon.pwf_expire_staff_scores($1::uuid) as done', [scoreIdOf(periodId, 'id')]);
    return rows[0]?.done === 1;
  }
}

/** The task of the snapshot: its state for the score, its window (the whole life of the task, from its start to its end or to the end of the period), the results of its KPIs and the ledger. */
function taskOf(bundle: TaskBundle, reading: ReturnType<typeof readingOf>, kpi: SnapshotKpi[], periodFrom: string, periodTo: string): SnapshotTask {
  const { row } = bundle;
  const end = reading.final ? (reading.closedOn as string) : periodTo;
  let start = row.actualStart ?? row.baselineStart ?? row.plannedStart ?? periodFrom;
  if (start > end) start = end;
  const responsible = bundle.assignments.filter((one) => one.role === 'RESPONSIBLE').map((one) => one.membershipId);
  let state: pwfKpi.StaffTaskState = 'RATED';
  if (reading.status === 'CANCELLED') state = row.cancelledBy !== null && !responsible.includes(row.cancelledBy) ? 'CANCELLED_APPROVED' : 'CANCELLED_UNAPPROVED';
  return {
    task_id: row.id,
    workflow_id: row.workflowId,
    project_id: row.projectId,
    code: row.code,
    name: row.name,
    state,
    priority: row.priority,
    planned_working_days: row.plannedWorkingDays,
    window_from: start,
    window_to: end,
    kpi,
    assignments: bundle.assignments.map((one) => ({ membership_id: one.membershipId, role: one.role, from: one.from, to: one.to, share_pct: one.sharePct })),
    created_on: row.createdOn,
    parent_key: row.ownTask ? row.phase : null,
    baseline_due: row.baselineFirst,
    finished_on: reading.status === 'DONE' ? reading.actualFinish : null,
  };
}

