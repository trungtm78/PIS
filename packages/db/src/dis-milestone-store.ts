import { createHash } from 'node:crypto';
import {
  ACCURACY_RULE_CODE,
  ACCURACY_RULE_TYPE,
  DomainError,
  MILESTONE_RULE_CODE,
  MILESTONE_RULE_TYPE,
  accuracyDefaults,
  accuracyPolicyOf,
  cutoffMonthOf,
  estimateYear,
  forecastAccuracy,
  mergeEstimates,
  milestoneDateOf,
  milestoneDefaults,
  milestonePolicyOf,
  readMilestones,
  summarizeMilestone,
} from '@machvon/kernel';
import type { AccuracyPair, AccuracyPolicy, AccuracyReport, Estimate, MilestonePolicy, MilestoneReading, MilestoneRow, MilestoneStatus, MilestoneSummary, Provenance } from '@machvon/kernel';
import { DisForecastStore } from './dis-forecast-store.ts';
import type { ForecastProject } from './dis-forecast-store.ts';
import { DisPeriodStore } from './dis-period-store.ts';
import { DisSnapshotStore } from './dis-snapshot-store.ts';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export const MILESTONE_RESOURCE = 'disbursement_milestone_forecast';
export const MILESTONE_RECORDED_EVENT = 'dis.milestone_forecast_recorded.v1';

const whole: ScopeBuilder = () => ({ sql: 'true', params: [] });
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const DAY_MS = 86_400_000;

/** A rule as a reader sees it: what decided, which version, and where its numbers come from. */
export interface RuleReading<P> {
  policy: P;
  code: string;
  version: number;
  source: 'RULE' | 'DEFAULT';
  unverified: boolean;
  provenance: Provenance | null;
}

export interface RecordResult {
  outcome: 'RECORDED' | 'NO_MILESTONES' | 'NO_PROJECTS' | 'ALREADY_RECORDED';
  snapshotId: string;
  units: number;
  milestones: number;
  rowsWritten: number;
  ruleVersion: number;
  ruleSource: 'RULE' | 'DEFAULT';
}

interface VintageSql {
  id: string;
  snapshot_id: string;
  plan_year: number;
  as_of_date: string;
  treasury_cutoff_date: string;
  unit_id: string;
  unit_code: string | null;
  unit_name: string | null;
  rule_version: number;
  rule_source: 'RULE' | 'DEFAULT';
  milestone_code: string;
  milestone_date: string;
  target_pct: string;
  margin_pct: string;
  target_vnd: string;
  plan_total_vnd: string;
  disbursed_vnd: string | null;
  projected_vnd: string | null;
  projected_pct: string | null;
  gap_pct: string | null;
  basis: 'ACTUAL' | 'FORECAST';
  coverage: 'COMPLETE' | 'PARTIAL' | 'NONE';
  status: MilestoneStatus;
  projects: number;
  created_at: string;
}

export interface MilestoneUnitRow {
  id: string;
  unit: { id: string; code: string; name: string };
  planTotalVnd: string;
  targetVnd: string;
  disbursedVnd: string | null;
  projectedVnd: string | null;
  projectedPct: string | null;
  gapPct: string | null;
  basis: 'ACTUAL' | 'FORECAST';
  coverage: 'COMPLETE' | 'PARTIAL' | 'NONE';
  status: MilestoneStatus;
  projects: number;
}

export interface MilestoneGroup {
  code: string;
  date: string;
  targetPct: string;
  marginPct: string;
  summary: MilestoneSummary;
  units: MilestoneUnitRow[];
}

export interface MilestoneBoard {
  snapshot: { id: string; asOfDate: string; treasuryCutoffDate: string; planYear: number } | null;
  /** Whether the milestone forecast ran for the snapshot: a snapshot nobody has read yet is told apart from one that has nothing to say. */
  run: { outcome: string; ruleVersion: number; ruleSource: 'RULE' | 'DEFAULT'; milestones: number; units: number; rowsWritten: number; recordedAt: string } | null;
  milestones: MilestoneGroup[];
  rule: RuleReading<MilestonePolicy>;
}

export interface AccuracyUnit {
  id: string | null;
  code: string | null;
  name: string | null;
}

export interface AccuracyView {
  planYear: number;
  lastMeasuredMonth: number;
  report: AccuracyReport;
  investors: Map<string, AccuracyUnit>;
  rule: RuleReading<AccuracyPolicy>;
  /** True when the schedule history held more project-months than a read judges. */
  truncated: boolean;
}

export interface AlertMilestone {
  id: string;
  snapshotId: string;
  unitId: string;
  unitName: string;
  code: string;
  date: string;
  status: MilestoneStatus;
  targetPct: string;
  projectedPct: string | null;
  gapPct: string | null;
  createdAt: string;
}

const READ_PAIR_LIMIT = 200_000;

const toGroupRow = (row: VintageSql): MilestoneUnitRow => ({
  id: row.id,
  unit: { id: row.unit_id, code: row.unit_code ?? '', name: row.unit_name ?? '' },
  planTotalVnd: row.plan_total_vnd,
  targetVnd: row.target_vnd,
  disbursedVnd: row.disbursed_vnd,
  projectedVnd: row.projected_vnd,
  projectedPct: row.projected_pct,
  gapPct: row.gap_pct,
  basis: row.basis,
  coverage: row.coverage,
  status: row.status,
  projects: row.projects,
});

/**
 * The milestones of the directives and the accuracy of the forecasts (GOV-11a, G1-16). `record` writes the vintages when a snapshot is frozen (one row for a snapshot, a milestone and an investor unit, append-only,
 * with the version of the rule that decided); `board` reads them back by milestone with the totals of the scope; `accuracy` measures, from the history of the schedule that is never overwritten, how well the forecast
 * made before each month foretold what the Treasury paid in it. Nothing here edits a figure: a status is the judgement of the kernel over what was stored.
 */
export class DisMilestoneStore {
  private readonly port: GovernancePolicyPort;
  private readonly snapshots = new DisSnapshotStore();
  private readonly periods = new DisPeriodStore();
  private readonly forecasts = new DisForecastStore();

  constructor(port: GovernancePolicyPort = new GovernancePolicyPort()) {
    this.port = port;
  }

  async milestoneRule(tx: TenantTx, asOf: string | Date): Promise<RuleReading<MilestonePolicy>> {
    const found = await this.port.get(tx, MILESTONE_RULE_TYPE, MILESTONE_RULE_CODE, asOf);
    if (found === undefined) return { policy: milestonePolicyOf(milestoneDefaults()), code: MILESTONE_RULE_CODE, version: 0, source: 'DEFAULT', unverified: true, provenance: null };
    return { policy: milestonePolicyOf(found.params), code: found.code, version: found.version, source: found.source, unverified: found.unverified, provenance: found.provenance };
  }

  async accuracyRule(tx: TenantTx, asOf: string | Date): Promise<RuleReading<AccuracyPolicy>> {
    const found = await this.port.get(tx, ACCURACY_RULE_TYPE, ACCURACY_RULE_CODE, asOf);
    if (found === undefined) return { policy: accuracyPolicyOf(accuracyDefaults()), code: ACCURACY_RULE_CODE, version: 0, source: 'DEFAULT', unverified: true, provenance: null };
    return { policy: accuracyPolicyOf(found.params), code: found.code, version: found.version, source: found.source, unverified: found.unverified, provenance: found.provenance };
  }

  /**
   * Judges every investor unit of a frozen snapshot against every milestone of the rule in force on the day of the snapshot and writes the vintages once. A snapshot that was judged already is left alone
   * (`ALREADY_RECORDED`); one with nothing to judge leaves its run row all the same, so a screen can say "nothing to project" and never "not read yet".
   */
  async record(tx: TenantTx, snapshotId: string, actor: string, now: Date): Promise<RecordResult> {
    const snapshot = await this.snapshots.find(tx, snapshotId);
    if (snapshot === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'snapshot_id');
    if (snapshot.status !== 'FROZEN') throw new DomainError('SNAPSHOT_NOT_FROZEN', 422, 'snapshot_id');
    const rule = await this.milestoneRule(tx, snapshot.asOfDate);
    const done = await tx.query<{ id: string }>('select id from machvon.disbursement_milestone_run where snapshot_id = $1::uuid', [snapshotId]);
    const base = { snapshotId, ruleVersion: rule.version, ruleSource: rule.source };
    if (done.length > 0) return { ...base, outcome: 'ALREADY_RECORDED', units: 0, milestones: 0, rowsWritten: 0 };
    const period = await this.periods.find(tx, snapshot.periodId);
    if (period === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'snapshot_id');
    const planYear = period.fiscalYear;
    const cutoffMonth = cutoffMonthOf(planYear, snapshot.treasuryCutoffDate);
    const data = await this.forecasts.read(tx, whole, { snapshotId, planYear, cutoffDate: snapshot.treasuryCutoffDate });
    const groups = new Map<string, ForecastProject[]>();
    for (const project of data.projects) groups.set(project.investorUnitId, [...(groups.get(project.investorUnitId) ?? []), project]);
    const policy = rule.policy;
    const milestones = policy.milestones.length;
    const units = groups.size;
    let rowsWritten = 0;
    const outcome: RecordResult['outcome'] = milestones === 0 ? 'NO_MILESTONES' : units === 0 ? 'NO_PROJECTS' : 'RECORDED';
    if (outcome === 'RECORDED') {
      const actuals = await this.actualsToDates(tx, data.projects, policy, planYear, snapshot.treasuryCutoffDate);
      for (const [unitId, projects] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const estimate = mergeEstimates(projects.map((project) => estimateYear({ disbursedVnd: project.disbursedVnd, cutoffMonth, forecasts: project.forecasts, registered: project.registered, planTotalVnd: project.planTotalVnd })));
        const readings = readMilestones(
          policy,
          {
            planYear,
            cutoffDate: snapshot.treasuryCutoffDate,
            disbursedVnd: estimate.disbursedVnd,
            planTotalVnd: estimate.planTotalVnd,
            months: estimate.months.map((month) => ({ month: month.month, amountVnd: month.amountVnd, complete: month.complete })),
          },
          (date) => actuals.get(`${unitId}|${date}`) ?? null,
        );
        for (const reading of readings) {
          await this.insert(tx, snapshot, planYear, unitId, rule, reading, estimate, projects.length, actor);
          rowsWritten += 1;
        }
      }
    }
    await tx.query(
      `insert into machvon.disbursement_milestone_run (tenant_id, snapshot_id, outcome, rule_code, rule_version, rule_source, milestones, units, rows_written, created_by, created_at)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::uuid, $10::timestamptz)`,
      [snapshotId, outcome, rule.code, rule.version, rule.source, outcome === 'RECORDED' ? milestones : 0, outcome === 'RECORDED' ? units : 0, rowsWritten, actor, now.toISOString()],
    );
    return { ...base, outcome, units: outcome === 'RECORDED' ? units : 0, milestones: outcome === 'RECORDED' ? milestones : 0, rowsWritten };
  }

  private async insert(tx: TenantTx, snapshot: { id: string; asOfDate: string; treasuryCutoffDate: string }, planYear: number, unitId: string, rule: RuleReading<MilestonePolicy>, reading: MilestoneReading, estimate: Estimate, projects: number, actor: string): Promise<void> {
    const milestone = rule.policy.milestones.find((entry) => entry.code === reading.code);
    if (milestone === undefined) return;
    await tx.query(
      `insert into machvon.disbursement_milestone_forecast
         (tenant_id, snapshot_id, plan_year, as_of_date, treasury_cutoff_date, unit_id, rule_code, rule_version, rule_source, milestone_code, milestone_date, target_pct, margin_pct, target_vnd, plan_total_vnd,
          disbursed_vnd, projected_vnd, projected_pct, gap_pct, basis, coverage, status, projects, created_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3::date, $4::date, $5::uuid, $6, $7, $8, $9, $10::date, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23::uuid)
       on conflict (tenant_id, snapshot_id, milestone_code, unit_id) do nothing`,
      [
        snapshot.id,
        planYear,
        snapshot.asOfDate,
        snapshot.treasuryCutoffDate,
        unitId,
        rule.code,
        rule.version,
        rule.source,
        reading.code,
        reading.date,
        milestone.targetPct,
        rule.policy.atRiskMarginPct,
        reading.targetVnd,
        estimate.planTotalVnd,
        estimate.disbursedVnd,
        reading.projectedVnd,
        reading.projectedPct,
        reading.gapPct,
        reading.basis,
        reading.coverage,
        reading.status,
        projects,
        actor,
      ],
    );
  }

  /** What the Treasury paid to each milestone day that is not after the cutoff, for each investor unit: `<unit>|<date>` to whole dong. */
  private async actualsToDates(tx: TenantTx, projects: readonly ForecastProject[], policy: MilestonePolicy, planYear: number, cutoffDate: string): Promise<Map<string, string>> {
    const past = policy.milestones.map((milestone) => milestoneDateOf(planYear, milestone.monthDay)).filter((date) => date < cutoffDate);
    const result = new Map<string, string>();
    if (past.length === 0 || projects.length === 0) return result;
    const rows = await tx.query<{ project_id: string; day: string; amount: string }>(
      `select t.project_id, d.day::text as day,
              sum(case when t.reversal_of_id is not null then -t.amount_vnd else t.amount_vnd end)::text as amount
         from machvon.treasury_transaction t
         join unnest($3::date[]) as d(day) on (t.confirmed_at at time zone 'Asia/Ho_Chi_Minh')::date <= d.day
        where t.project_id = any($1::uuid[]) and (t.confirmed_at at time zone 'Asia/Ho_Chi_Minh')::date >= make_date($2::int, 1, 1)
        group by t.project_id, d.day`,
      [projects.map((project) => project.projectId), planYear, past],
    );
    const unitOf = new Map(projects.map((project) => [project.projectId, project.investorUnitId]));
    const sums = new Map<string, bigint>();
    for (const row of rows) {
      const unit = unitOf.get(row.project_id);
      if (unit === undefined) continue;
      const key = `${unit}|${row.day}`;
      sums.set(key, (sums.get(key) ?? 0n) + BigInt(row.amount));
    }
    // A unit whose projects were paid nothing up to a day is "paid nothing", not "unknown": the Treasury booked its other days.
    for (const unit of new Set(unitOf.values())) for (const day of past) result.set(`${unit}|${day}`, (sums.get(`${unit}|${day}`) ?? 0n).toString());
    return result;
  }

  /** The vintages of a snapshot (the latest frozen one when none is given) in the scope of the caller, grouped by milestone with the totals of the scope. */
  async board(tx: TenantTx, scope: ScopeBuilder, filter: { snapshotId?: string | undefined; unitId?: string | undefined }, now: Date): Promise<MilestoneBoard> {
    const rule = await this.milestoneRule(tx, now);
    const snapshot = filter.snapshotId === undefined ? await this.snapshots.latestFrozen(tx) : await this.snapshots.find(tx, filter.snapshotId);
    if (filter.snapshotId !== undefined && snapshot === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'snapshot_id');
    if (snapshot === undefined) return { snapshot: null, run: null, milestones: [], rule };
    if (snapshot.status !== 'FROZEN' && snapshot.status !== 'SUPERSEDED') throw new DomainError('SNAPSHOT_NOT_FROZEN', 422, 'snapshot_id');
    const period = await this.periods.find(tx, snapshot.periodId);
    const planYear = period?.fiscalYear ?? Number(snapshot.treasuryCutoffDate.slice(0, 4));
    const run = (
      await tx.query<{ outcome: string; rule_version: number; rule_source: 'RULE' | 'DEFAULT'; milestones: number; units: number; rows_written: number; created_at: string }>(
        `select outcome, rule_version, rule_source, milestones, units, rows_written, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at
           from machvon.disbursement_milestone_run where snapshot_id = $1::uuid`,
        [snapshot.id],
      )
    )[0];
    const visible = scope(3);
    const rows = await tx.query<VintageSql>(
      `select m.id, m.snapshot_id, m.plan_year, m.as_of_date::text as as_of_date, m.treasury_cutoff_date::text as treasury_cutoff_date, m.unit_id, u.code as unit_code, u.name as unit_name, m.rule_version, m.rule_source,
              m.milestone_code, m.milestone_date::text as milestone_date, m.target_pct::text as target_pct, m.margin_pct::text as margin_pct, m.target_vnd::text as target_vnd, m.plan_total_vnd::text as plan_total_vnd,
              m.disbursed_vnd::text as disbursed_vnd, m.projected_vnd::text as projected_vnd, m.projected_pct::text as projected_pct, m.gap_pct::text as gap_pct, m.basis, m.coverage, m.status, m.projects,
              m.created_at::text as created_at
         from machvon.disbursement_milestone_forecast m
         left join machvon.organization_unit u on u.tenant_id = m.tenant_id and u.id = m.unit_id
        where m.snapshot_id = $1::uuid and ($2::uuid is null or m.unit_id = $2::uuid)
          and exists (select 1 from machvon.period_snapshot_line l join ${SCOPE_FROM} on p.tenant_id = l.tenant_id and p.id = l.project_id
                       where l.snapshot_id = m.snapshot_id and coalesce(p.investor_unit_id, l.unit_id) = m.unit_id and ${visible.sql})
        order by m.milestone_date, u.code nulls last, m.unit_id`,
      [snapshot.id, filter.unitId ?? null, ...visible.params],
    );
    const byCode = new Map<string, VintageSql[]>();
    for (const row of rows) byCode.set(row.milestone_code, [...(byCode.get(row.milestone_code) ?? []), row]);
    const milestones: MilestoneGroup[] = [...byCode.values()].map((group) => {
      const first = group[0] as VintageSql;
      const summaryRows: MilestoneRow[] = group.map((row) => ({ planTotalVnd: row.plan_total_vnd, targetVnd: row.target_vnd, projectedVnd: row.projected_vnd, coverage: row.coverage, status: row.status, basis: row.basis }));
      return {
        code: first.milestone_code,
        date: first.milestone_date,
        targetPct: first.target_pct,
        marginPct: first.margin_pct,
        summary: summarizeMilestone(summaryRows, Number(first.target_pct), Number(first.margin_pct)),
        units: group.map(toGroupRow),
      };
    });
    return {
      snapshot: { id: snapshot.id, asOfDate: snapshot.asOfDate, treasuryCutoffDate: snapshot.treasuryCutoffDate, planYear },
      run: run === undefined ? null : { outcome: run.outcome, ruleVersion: run.rule_version, ruleSource: run.rule_source, milestones: run.milestones, units: run.units, rowsWritten: run.rows_written, recordedAt: run.created_at },
      milestones,
      rule,
    };
  }

  /**
   * How well the forecasts of each investor foretold the payments in the plan year: for every project and month that has ended, the last forecast made before the month (the lead of the rule, the history of the
   * schedule is never overwritten) against what the Treasury paid in it. The year is the one of the latest frozen snapshot unless one is given.
   */
  async accuracy(tx: TenantTx, scope: ScopeBuilder, filter: { planYear?: number | undefined; investorId?: string | undefined }, now: Date): Promise<AccuracyView> {
    const rule = await this.accuracyRule(tx, now);
    const latest = await this.snapshots.latestFrozen(tx);
    const period = latest === undefined ? undefined : await this.periods.find(tx, latest.periodId);
    const planYear = filter.planYear ?? period?.fiscalYear ?? Number(new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 4));
    const today = new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
    const limitDay = latest !== undefined && period?.fiscalYear === planYear && latest.treasuryCutoffDate < today ? latest.treasuryCutoffDate : today;
    const lastMeasuredMonth = lastFullMonth(planYear, limitDay);
    const empty = (): AccuracyView => ({ planYear, lastMeasuredMonth, report: forecastAccuracy([], rule.policy), investors: new Map(), rule, truncated: false });
    if (lastMeasuredMonth < 1) return empty();
    const visible = scope(5);
    const forecasts = await tx.query<{ project_id: string; investor_id: string | null; month: number; amount: string }>(
      `select s.project_id, p.investor_unit_id as investor_id, s.month::int as month, sum(s.amount_vnd)::text as amount
         from (select distinct on (x.project_id, x.bucket, x.budget_level, x.month) x.project_id, x.month, x.amount_vnd
                 from machvon.disbursement_schedule_line x
                where x.plan_year = $1::int and x.kind = 'FORECAST' and x.granularity = 'MONTH' and x.month between 1 and $2::int
                  and x.created_at < ((make_date($1::int, 1, 1) + make_interval(months => x.month - $3::int))::timestamp at time zone 'Asia/Ho_Chi_Minh')
                order by x.project_id, x.bucket, x.budget_level, x.month, x.revision desc) s
         join ${SCOPE_FROM} on p.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid and p.id = s.project_id
        where ($4::uuid is null or p.investor_unit_id = $4::uuid) and ${visible.sql}
        group by s.project_id, p.investor_unit_id, s.month
        limit ${READ_PAIR_LIMIT + 1}`,
      [planYear, lastMeasuredMonth, rule.policy.leadMonths, filter.investorId ?? null, ...visible.params],
    );
    const truncated = forecasts.length > READ_PAIR_LIMIT;
    const kept = forecasts.slice(0, READ_PAIR_LIMIT);
    if (kept.length === 0) return empty();
    const ids = [...new Set(kept.map((row) => row.project_id))];
    const paid = await tx.query<{ project_id: string; month: number; amount: string }>(
      `select t.project_id, extract(month from (t.confirmed_at at time zone 'Asia/Ho_Chi_Minh')::date)::int as month,
              sum(case when t.reversal_of_id is not null then -t.amount_vnd else t.amount_vnd end)::text as amount
         from machvon.treasury_transaction t
        where t.project_id = any($1::uuid[]) and (t.confirmed_at at time zone 'Asia/Ho_Chi_Minh')::date between make_date($2::int, 1, 1) and make_date($2::int, 12, 31)
        group by t.project_id, 2`,
      [ids, planYear],
    );
    const actual = new Map(paid.map((row) => [`${row.project_id}|${row.month}`, row.amount]));
    const pairs: AccuracyPair[] = kept.map((row) => ({ investorId: row.investor_id, projectId: row.project_id, month: row.month, forecastVnd: row.amount, actualVnd: actual.get(`${row.project_id}|${row.month}`) ?? '0' }));
    const report = forecastAccuracy(pairs, rule.policy);
    const unitIds = [...new Set(pairs.map((pair) => pair.investorId).filter((id): id is string => id !== null))];
    const names = unitIds.length === 0 ? [] : await tx.query<{ id: string; code: string; name: string }>('select id, code, name from machvon.organization_unit where id = any($1::uuid[])', [unitIds]);
    return { planYear, lastMeasuredMonth, report, investors: new Map(names.map((row) => [row.id, { id: row.id, code: row.code, name: row.name }])), rule, truncated };
  }

  /** The milestones of the latest frozen snapshot that are below the target (at risk or off track) for the units in the scope: what the alert centre lists, with the day of the vintage it rests on. */
  async atRisk(tx: TenantTx, scope: ScopeBuilder, limit = 100): Promise<AlertMilestone[]> {
    const latest = await this.snapshots.latestFrozen(tx);
    if (latest === undefined) return [];
    const visible = scope(3);
    const rows = await tx.query<{ id: string; snapshot_id: string; unit_id: string; unit_name: string | null; milestone_code: string; milestone_date: string; status: MilestoneStatus; target_pct: string; projected_pct: string | null; gap_pct: string | null; created_at: string }>(
      `select m.id, m.snapshot_id, m.unit_id, u.name as unit_name, m.milestone_code, m.milestone_date::text as milestone_date, m.status, m.target_pct::text as target_pct, m.projected_pct::text as projected_pct,
              m.gap_pct::text as gap_pct, m.created_at::text as created_at
         from machvon.disbursement_milestone_forecast m left join machvon.organization_unit u on u.tenant_id = m.tenant_id and u.id = m.unit_id
        where m.snapshot_id = $1::uuid and m.status in ('AT_RISK', 'OFF_TRACK') and m.milestone_date >= $2::date
          and exists (select 1 from machvon.period_snapshot_line l join ${SCOPE_FROM} on p.tenant_id = l.tenant_id and p.id = l.project_id
                       where l.snapshot_id = m.snapshot_id and coalesce(p.investor_unit_id, l.unit_id) = m.unit_id and ${visible.sql})
        order by m.milestone_date, m.unit_id
        limit ${limit}`,
      [latest.id, latest.treasuryCutoffDate, ...visible.params],
    );
    return rows.map((row) => ({ id: row.id, snapshotId: row.snapshot_id, unitId: row.unit_id, unitName: row.unit_name ?? '', code: row.milestone_code, date: row.milestone_date, status: row.status, targetPct: row.target_pct, projectedPct: row.projected_pct, gapPct: row.gap_pct, createdAt: row.created_at }));
  }
}

/** The last month of the plan year that has ended on the day (Vietnam time): the whole year after the year, none before it. */
export function lastFullMonth(planYear: number, day: string): number {
  const year = Number(day.slice(0, 4));
  if (year > planYear) return 12;
  if (year < planYear) return 0;
  const month = Number(day.slice(5, 7));
  const ends = new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).getUTCMonth() + 1 !== month;
  return ends ? month : month - 1;
}

/** The audit row of a record: ids, counts and the version of the rule, never the figures. */
export function milestoneRecord(result: RecordResult, digest: unknown) {
  return {
    action: 'dis.milestone_forecast_recorded',
    resourceType: MILESTONE_RESOURCE,
    resourceId: result.snapshotId,
    diff: { snapshot_id: result.snapshotId, outcome: result.outcome, units: result.units, milestones: result.milestones, rows_written: result.rowsWritten, rule_version: result.ruleVersion, rule_source: result.ruleSource, digest: hash(digest) },
  };
}

