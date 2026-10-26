import { randomUUID } from 'node:crypto';
import { DomainError, METRIC_SET_VERSION, buildLines, snapshotHash, versionConflict } from '@machvon/kernel';
import type { RateBasis, RateSums } from '@machvon/kernel';
import type { DefinitionStatus, HashedLine, PlanCell, ReportedCell, SnapshotKind, SnapshotLine, SnapshotProject, TreasuryEntry } from '@machvon/kernel';
import type { PeriodRow } from './dis-period-store.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/** The resource type of the audit rows and the events of a snapshot. */
export const SNAPSHOT_RESOURCE = 'period_snapshot';
export const DIS_SNAPSHOT_BUILD_METRIC = 'dis_snapshot_build_total';
export const DIS_SNAPSHOT_FREEZE_METRIC = 'dis_snapshot_freeze_total';
/** Counts each rate that was read and could not be computed, by the reason (ST-DIS-010). */
export const DIS_RATE_NULL_METRIC = 'dis_rate_null_total';

/** The glossary terms the formulas of the snapshot are defined by: the snapshot says its definitions are proposals until every one of them is published (DIS 3 F6, CXN-03). */
export const REQUIRED_GLOSSARY_TERMS: readonly string[] = ['DISBURSEMENT_CUMULATIVE', 'DISBURSEMENT_RATE_PM', 'DISBURSEMENT_RATE_TOTAL', 'TREASURY_CUTOFF', 'MEASUREMENT_BASIS'];
export const GLOSSARY_DOMAIN = 'DISBURSEMENT';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const iso = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export type SnapshotStatus = 'BUILDING' | 'FROZEN' | 'SUPERSEDED' | 'FAILED';

export interface SnapshotRow {
  id: string;
  periodId: string;
  snapshotKind: SnapshotKind;
  asOfAt: string;
  asOfDate: string;
  treasuryCutoffDate: string;
  status: SnapshotStatus;
  metricSetVersion: string;
  definitionStatus: DefinitionStatus;
  rowCount: number;
  payloadSha256: string | null;
  frozenBy: string | null;
  frozenAt: string | null;
  supersedesId: string | null;
  createdAt: string;
  createdBy: string;
  version: number;
}

interface SnapshotSql {
  id: string;
  period_id: string;
  snapshot_kind: SnapshotKind;
  as_of_at: string;
  as_of_date: string;
  treasury_cutoff_date: string;
  status: SnapshotStatus;
  metric_set_version: string;
  definition_status: DefinitionStatus;
  row_count: number;
  payload_sha256: string | null;
  frozen_by: string | null;
  frozen_at: string | null;
  supersedes_id: string | null;
  created_at: string;
  created_by: string;
  version: string;
}

const COLUMNS = `s.id, s.period_id, s.snapshot_kind, ${iso('s.as_of_at')} as as_of_at, s.as_of_date::text as as_of_date, s.treasury_cutoff_date::text as treasury_cutoff_date, s.status, s.metric_set_version,
  s.definition_status, s.row_count, s.payload_sha256, s.frozen_by, ${iso('s.frozen_at')} as frozen_at, s.supersedes_id, ${iso('s.created_at')} as created_at, s.created_by, s.version::text as version`;

const toSnapshot = (row: SnapshotSql): SnapshotRow => ({
  id: row.id,
  periodId: row.period_id,
  snapshotKind: row.snapshot_kind,
  asOfAt: row.as_of_at,
  asOfDate: row.as_of_date,
  treasuryCutoffDate: row.treasury_cutoff_date,
  status: row.status,
  metricSetVersion: row.metric_set_version,
  definitionStatus: row.definition_status,
  rowCount: row.row_count,
  payloadSha256: row.payload_sha256,
  frozenBy: row.frozen_by,
  frozenAt: row.frozen_at,
  supersedesId: row.supersedes_id,
  createdAt: row.created_at,
  createdBy: row.created_by,
  version: Number(row.version),
});

/** A line of a snapshot with the project and the unit it is about, as it is kept and read. */
export interface SnapshotLineRow extends SnapshotLine {
  id: string;
  projectId: string;
  projectCode: string;
  unitId: string;
}

interface LineSql {
  id: string;
  project_id: string;
  project_code: string;
  unit_id: string;
  fund_source_version_id: string | null;
  bucket: SnapshotLineRow['bucket'];
  budget_level: SnapshotLineRow['budgetLevel'];
  plan_pm_assigned_vnd: string;
  plan_local_added_vnd: string;
  plan_total_vnd: string;
  disbursed_treasury_vnd: string | null;
  disbursed_reported_vnd: string | null;
  period_delta_vnd: string | null;
  registered_month_vnd: string | null;
  forecast_eac_vnd: string | null;
  ctmtqg_subset_vnd: string | null;
  rate_pm_pct: string | null;
  rate_total_pct: string | null;
  rate_null_reason: SnapshotLine['rateNullReason'];
  treasury_coverage: SnapshotLine['treasuryCoverage'];
  report_revision_id: string | null;
  plan_version_id: string | null;
}

const LINE_COLUMNS = `l.id, l.project_id, p.code as project_code, l.unit_id, l.fund_source_version_id, l.bucket, l.budget_level, l.plan_pm_assigned_vnd::text as plan_pm_assigned_vnd,
  l.plan_local_added_vnd::text as plan_local_added_vnd, l.plan_total_vnd::text as plan_total_vnd, l.disbursed_treasury_vnd::text as disbursed_treasury_vnd, l.disbursed_reported_vnd::text as disbursed_reported_vnd,
  l.period_delta_vnd::text as period_delta_vnd, l.registered_month_vnd::text as registered_month_vnd, l.forecast_eac_vnd::text as forecast_eac_vnd, l.ctmtqg_subset_vnd::text as ctmtqg_subset_vnd,
  l.rate_pm_pct::text as rate_pm_pct, l.rate_total_pct::text as rate_total_pct, l.rate_null_reason, l.treasury_coverage, l.report_revision_id, l.plan_version_id`;

const toLine = (row: LineSql): SnapshotLineRow => ({
  id: row.id,
  projectId: row.project_id,
  projectCode: row.project_code,
  unitId: row.unit_id,
  fundSourceVersionId: row.fund_source_version_id,
  bucket: row.bucket,
  budgetLevel: row.budget_level,
  planPmAssignedVnd: row.plan_pm_assigned_vnd,
  planLocalAddedVnd: row.plan_local_added_vnd,
  planTotalVnd: row.plan_total_vnd,
  disbursedTreasuryVnd: row.disbursed_treasury_vnd,
  disbursedReportedVnd: row.disbursed_reported_vnd,
  periodDeltaVnd: row.period_delta_vnd,
  registeredMonthVnd: row.registered_month_vnd,
  forecastEacVnd: row.forecast_eac_vnd,
  ctmtqgSubsetVnd: row.ctmtqg_subset_vnd,
  ratePmPct: row.rate_pm_pct,
  rateTotalPct: row.rate_total_pct,
  rateNullReason: row.rate_null_reason,
  treasuryCoverage: row.treasury_coverage,
  reportRevisionId: row.report_revision_id,
  planVersionId: row.plan_version_id,
});

export interface BuildInput {
  period: PeriodRow;
  kind: SnapshotKind;
  treasuryCutoffDate: string;
  asOfAt: Date;
  actor: string;
  /** The projects the builder may see (the permission `snapshot.build`): a snapshot holds the whole tenant, so only a person who sees every project builds one. */
  scope: ScopeBuilder;
}

const cellKey = (bucket: string, level: string): string => `${bucket}/${level}`;

/**
 * The period snapshot (ST-DIS-009, DIS 3 F6): the executive figures of a period, built from the accepted report of each project (a report that was handed in and not yet accepted is not in it), the plan
 * version in force at the end of the period split by the origin of the capital, and the Treasury up to a cutoff; then frozen with the hash of what it holds, and replaced only by a newer one.
 */
export class DisSnapshotStore {
  async find(tx: TenantTx, id: string, lock = false): Promise<SnapshotRow | undefined> {
    const [row] = await tx.query<SnapshotSql>(`select ${COLUMNS} from machvon.period_snapshot s where s.id = $1::uuid${lock ? ' for update of s' : ''}`, [id]);
    return row === undefined ? undefined : toSnapshot(row);
  }

  /** The snapshots of a tenant, newest first, of a period and a kind when named. */
  async list(tx: TenantTx, filter: { periodId?: string | undefined; kind?: string | undefined; status?: string | undefined }, limit: number): Promise<SnapshotRow[]> {
    const rows = await tx.query<SnapshotSql>(
      `select ${COLUMNS} from machvon.period_snapshot s
        where ($1::uuid is null or s.period_id = $1::uuid) and ($2::text is null or s.snapshot_kind = $2) and ($3::text is null or s.status = $3)
        order by s.created_at desc, s.id desc limit $4`,
      [filter.periodId ?? null, filter.kind ?? null, filter.status ?? null, limit],
    );
    return rows.map(toSnapshot);
  }

  /** `SIGNED` when every term the formulas are defined by is published in the glossary of the tenant, otherwise the formulas are proposals (CXN-03). */
  async definitionStatus(tx: TenantTx): Promise<DefinitionStatus> {
    const [row] = await tx.query<{ n: string }>(
      `select count(distinct term_code)::text as n from machvon.glossary_term where domain = $1 and status = 'PUBLISHED' and term_code = any($2::text[])`,
      [GLOSSARY_DOMAIN, [...REQUIRED_GLOSSARY_TERMS]],
    );
    return Number((row as { n: string }).n) === REQUIRED_GLOSSARY_TERMS.length ? 'SIGNED' : 'PROPOSED_PENDING_SIGNOFF';
  }

  /** Reads what the build needs of every project in scope, with a query for each kind of data and not for each project. */
  private async projectsOf(tx: TenantTx, input: BuildInput): Promise<SnapshotProject[]> {
    const visible = input.scope(1);
    const visibleRows = await tx.query<{ id: string; unit_id: string }>(`select p.id, p.owner_unit_id as unit_id from ${SCOPE_FROM} where ${visible.sql}`, visible.params);
    const units = new Map(visibleRows.map((row) => [row.id, row.unit_id]));
    const { period, treasuryCutoffDate } = input;

    // The plan version in force at the end of the period: the newest one published up to that day, in the fiscal year of the period, and what it allocated to each cell.
    const plans = await tx.query<{ project_id: string; plan_version_id: string; bucket: PlanCell['bucket']; budget_level: PlanCell['budgetLevel'] | null; amount: string; origin: string | null; fund_source_version_id: string | null }>(
      `select pv.project_id, pv.id as plan_version_id, al.bucket, al.budget_level, al.amount_vnd::text as amount, al.origin, al.fund_source_version_id
         from (select distinct on (project_id) id, project_id from machvon.plan_version
                where fiscal_year = $1 and status in ('PUBLISHED', 'SUPERSEDED') and (effective_at at time zone 'Asia/Ho_Chi_Minh')::date <= $2::date
                order by project_id, effective_at desc, revision desc) pv
         join machvon.allocation_line al on al.tenant_id = ${TENANT} and al.plan_version_id = pv.id`,
      [period.fiscalYear, period.endDate],
    );
    const planVersions = new Map<string, string>();
    const planCells = new Map<string, PlanCell[]>();
    for (const row of plans) {
      planVersions.set(row.project_id, row.plan_version_id);
      if (row.budget_level === null) continue;
      planCells.set(row.project_id, [...(planCells.get(row.project_id) ?? []), { bucket: row.bucket, budgetLevel: row.budget_level, amountVnd: row.amount, origin: row.origin, fundSourceVersionId: row.fund_source_version_id }]);
    }

    // The accepted report of the period of each project: only the one that is current counts; a report that was handed in and is not accepted is shown apart.
    const reports = await tx.query<{ project_id: string; id: string; bucket: ReportedCell['bucket']; budget_level: ReportedCell['budgetLevel']; cumulative: string; ctmtqg: string | null; next_month: string }>(
      `select r.project_id, r.id, l.bucket, l.budget_level, l.disbursed_cumulative_vnd::text as cumulative, l.ctmtqg_subset_vnd::text as ctmtqg, l.next_month_registered_vnd::text as next_month
         from machvon.report_revision r join machvon.funding_snapshot_line l on l.tenant_id = r.tenant_id and l.report_revision_id = r.id
        where r.period_id = $1::uuid and r.is_current and r.status in ('ACCEPTED', 'AMENDMENT_REQUESTED')`,
      [period.id],
    );
    const reported = new Map<string, { reportRevisionId: string; cells: ReportedCell[] }>();
    for (const row of reports) {
      const held = reported.get(row.project_id) ?? { reportRevisionId: row.id, cells: [] };
      held.cells.push({ bucket: row.bucket, budgetLevel: row.budget_level, cumulativeVnd: row.cumulative, ctmtqgVnd: row.ctmtqg, nextMonthVnd: row.next_month });
      reported.set(row.project_id, held);
    }

    // The accepted report of the latest earlier period of the same type and year: what the change of the period is taken against (BR-DIS-03).
    const earlier = await tx.query<{ project_id: string; bucket: string; budget_level: string; cumulative: string }>(
      `select r.project_id, l.bucket, l.budget_level, l.disbursed_cumulative_vnd::text as cumulative
         from (select distinct on (r.project_id) r.id, r.project_id
                 from machvon.report_revision r join machvon.reporting_period rp on rp.tenant_id = r.tenant_id and rp.id = r.period_id
                where r.is_current and r.status in ('ACCEPTED', 'AMENDMENT_REQUESTED') and rp.period_type = $1 and rp.fiscal_year = $2 and rp.end_date < $3::date
                order by r.project_id, rp.end_date desc, r.revision desc) r
         join machvon.funding_snapshot_line l on l.tenant_id = ${TENANT} and l.report_revision_id = r.id`,
      [period.periodType, period.fiscalYear, period.startDate],
    );
    const previous = new Map<string, Map<string, string>>();
    for (const row of earlier) {
      const held = previous.get(row.project_id) ?? new Map<string, string>();
      held.set(cellKey(row.bucket, row.budget_level), row.cumulative);
      previous.set(row.project_id, held);
    }

    // What the Treasury paid, by the day (Vietnam time), up to the cutoff and from the first day of the year; a refund is a transaction that takes another back.
    const from = `${period.fiscalYear}-01-01`;
    const paid = await tx.query<{ project_id: string; amount: string; reversal: boolean; paid_on: string }>(
      `select t.project_id, t.amount_vnd::text as amount, (t.reversal_of_id is not null) as reversal, ((t.confirmed_at at time zone 'Asia/Ho_Chi_Minh')::date)::text as paid_on
         from machvon.treasury_transaction t
        where (t.confirmed_at at time zone 'Asia/Ho_Chi_Minh')::date <= $1::date and (t.confirmed_at at time zone 'Asia/Ho_Chi_Minh')::date >= $2::date`,
      [treasuryCutoffDate, from],
    );
    const treasury = new Map<string, TreasuryEntry[]>();
    for (const row of paid) treasury.set(row.project_id, [...(treasury.get(row.project_id) ?? []), { amountVnd: row.amount, reversal: row.reversal, paidOn: row.paid_on }]);

    const involved = new Set<string>([...planCells.keys(), ...reported.keys(), ...treasury.keys()]);
    return [...involved]
      .filter((projectId) => units.has(projectId))
      .sort()
      .map((projectId) => ({
        projectId,
        unitId: units.get(projectId) as string,
        planVersionId: planVersions.get(projectId) ?? null,
        plans: planCells.get(projectId) ?? [],
        reported: reported.get(projectId) ?? null,
        previous: previous.get(projectId) ?? null,
        treasury: treasury.get(projectId) ?? [],
        treasuryFrom: from,
      }));
  }

  /**
   * Builds a snapshot: the lines of every project are computed and written under a new snapshot that is BUILDING, with the formulas it was made with and whether their definitions are signed.
   * Nothing is frozen: a person looks at it first, then freezes it.
   */
  async build(tx: TenantTx, input: BuildInput): Promise<{ snapshot: SnapshotRow; projects: number; discardedId: string | null }> {
    // A snapshot holds the whole tenant and a new build replaces the pending one of every other person: a person who sees only a part of the projects builds none.
    if (input.scope(1).sql !== 'true') throw new DomainError('SCOPE_DENIED', 403, 'scope');
    // One build of a period and a kind at a time: a second one that arrives while the first holds its turn is told so (409), it does not wait and does not race.
    const [turn] = await tx.query<{ taken: boolean }>(`select pg_try_advisory_xact_lock(hashtextextended(current_setting('app.tenant_id', true) || ':snapshot:' || $1 || ':' || $2, 0)) as taken`, [input.period.id, input.kind]);
    if (turn?.taken !== true) throw new DomainError('SNAPSHOT_BUILD_IN_PROGRESS', 409, 'period_id');
    // A build that was never frozen is replaced by the new one (FAILED: it is not an official figure and nobody can freeze it any more).
    const [discarded] = await tx.query<{ id: string }>(
      `update machvon.period_snapshot set status = 'FAILED', updated_at = now(), updated_by = $3::uuid, version = version + 1
        where period_id = $1::uuid and snapshot_kind = $2 and status = 'BUILDING' returning id`,
      [input.period.id, input.kind, input.actor],
    );
    const id = randomUUID();
    const definition = await this.definitionStatus(tx);
    const projects = await this.projectsOf(tx, input);
    const rows = projects.flatMap((project) => buildLines(project, input.treasuryCutoffDate).map((line) => ({ ...line, project_id: project.projectId, unit_id: project.unitId })));
    await tx.query(
      `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, created_by, updated_by, version)
       values (${TENANT}, $1::uuid, $2::uuid, $3, $4::timestamptz, $5::date, $6::date, 'BUILDING', $7, $8, $9::int, $10::uuid, $10::uuid, 1)`,
      [id, input.period.id, input.kind, input.asOfAt.toISOString(), input.period.endDate, input.treasuryCutoffDate, METRIC_SET_VERSION, definition, rows.length, input.actor],
    );
    if (rows.length > 0) {
      await tx.query(
        `insert into machvon.period_snapshot_line
           (tenant_id, id, snapshot_id, project_id, unit_id, fund_source_version_id, bucket, budget_level, plan_pm_assigned_vnd, plan_local_added_vnd, plan_total_vnd, disbursed_treasury_vnd, disbursed_reported_vnd,
            period_delta_vnd, registered_month_vnd, forecast_eac_vnd, ctmtqg_subset_vnd, rate_pm_pct, rate_total_pct, rate_null_reason, treasury_coverage, report_revision_id, plan_version_id)
         select ${TENANT}, gen_random_uuid(), $1::uuid, x.project_id, x.unit_id, x."fundSourceVersionId", x.bucket, x."budgetLevel", x."planPmAssignedVnd", x."planLocalAddedVnd", x."planTotalVnd",
                x."disbursedTreasuryVnd", x."disbursedReportedVnd", x."periodDeltaVnd", x."registeredMonthVnd", x."forecastEacVnd", x."ctmtqgSubsetVnd", x."ratePmPct", x."rateTotalPct", x."rateNullReason",
                x."treasuryCoverage", x."reportRevisionId", x."planVersionId"
           from jsonb_to_recordset($2::jsonb) as x(project_id uuid, unit_id uuid, "fundSourceVersionId" uuid, bucket text, "budgetLevel" text, "planPmAssignedVnd" numeric, "planLocalAddedVnd" numeric, "planTotalVnd" numeric,
                "disbursedTreasuryVnd" numeric, "disbursedReportedVnd" numeric, "periodDeltaVnd" numeric, "registeredMonthVnd" numeric, "forecastEacVnd" numeric, "ctmtqgSubsetVnd" numeric,
                "ratePmPct" numeric, "rateTotalPct" numeric, "rateNullReason" text, "treasuryCoverage" text, "reportRevisionId" uuid, "planVersionId" uuid)`,
        [id, JSON.stringify(rows)],
      );
    }
    const snapshot = (await this.find(tx, id)) as SnapshotRow;
    return { snapshot, projects: projects.length, discardedId: discarded?.id ?? null };
  }

  /**
   * Freezes a snapshot that was built: the hash of what it holds is kept, the snapshot that was frozen before for the same period and kind is SUPERSEDED (with its own hash, which does not change), and
   * this one takes its place. A snapshot that is frozen already is 409 `SNAPSHOT_FROZEN`; one that is not BUILDING any more (superseded, failed) 409 `SNAPSHOT_NOT_BUILT`.
   */
  async freeze(tx: TenantTx, id: string, expectedVersion: number, actor: string, at: Date): Promise<{ snapshot: SnapshotRow; supersededId: string | null }> {
    const current = await this.find(tx, id, true);
    if (current === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (current.version !== expectedVersion) throw versionConflict(current.version);
    if (current.status === 'FROZEN' || current.status === 'SUPERSEDED') throw new DomainError('SNAPSHOT_FROZEN', 409, 'status', { extensions: { snapshot_status: current.status, payload_sha256: current.payloadSha256 } });
    if (current.status !== 'BUILDING') throw new DomainError('SNAPSHOT_NOT_BUILT', 409, 'status', { extensions: { snapshot_status: current.status } });
    const lines = await tx.query<LineSql>(`select ${LINE_COLUMNS} from machvon.period_snapshot_line l join machvon.project p on p.tenant_id = l.tenant_id and p.id = l.project_id where l.snapshot_id = $1::uuid`, [id]);
    if (lines.length !== current.rowCount) throw new DomainError('SNAPSHOT_NOT_BUILT', 409, 'row_count');
    const hashed: HashedLine[] = lines.map((row) => {
      const { id: _id, projectCode: _code, ...line } = toLine(row);
      void _id;
      void _code;
      return line;
    });
    const hash = snapshotHash(
      { periodId: current.periodId, snapshotKind: current.snapshotKind, asOfDate: current.asOfDate, treasuryCutoffDate: current.treasuryCutoffDate, metricSetVersion: current.metricSetVersion, definitionStatus: current.definitionStatus },
      hashed,
    );
    const [previous] = await tx.query<{ id: string }>(
      `update machvon.period_snapshot set status = 'SUPERSEDED', updated_at = now(), updated_by = $3::uuid, version = version + 1
        where period_id = $1::uuid and snapshot_kind = $2 and status = 'FROZEN' and id <> $4::uuid returning id`,
      [current.periodId, current.snapshotKind, actor, id],
    );
    const [frozen] = await tx.query<SnapshotSql>(
      `with updated as (
         update machvon.period_snapshot
            set status = 'FROZEN', payload_sha256 = $2, frozen_by = $3::uuid, frozen_at = $4::timestamptz, supersedes_id = $5::uuid, updated_at = now(), updated_by = $3::uuid, version = version + 1
          where id = $1::uuid and status = 'BUILDING' returning *)
       select ${COLUMNS} from updated s`,
      [id, hash, actor, at.toISOString(), previous?.id ?? null],
    );
    if (frozen === undefined) throw new DomainError('SNAPSHOT_NOT_BUILT', 409, 'status');
    return { snapshot: toSnapshot(frozen), supersededId: previous?.id ?? null };
  }

  /** The most recent snapshot that was frozen (the official figure that a screen opens on when none is named), of a kind when named. */
  async latestFrozen(tx: TenantTx, kind: SnapshotKind = 'PERIOD_CLOSE'): Promise<SnapshotRow | undefined> {
    const [row] = await tx.query<SnapshotSql>(`select ${COLUMNS} from machvon.period_snapshot s where s.status = 'FROZEN' and s.snapshot_kind = $1 order by s.frozen_at desc, s.created_at desc, s.id desc limit 1`, [kind]);
    return row === undefined ? undefined : toSnapshot(row);
  }

  /**
   * What the lines of a snapshot add up to, in the scope of the caller, for the year plan (the Treasury over the plan) or the capital carried over (what was reported over its plan), whole or by unit or
   * by project: the sums only, so that a rate is made from them and never from the rates of the parts (BR-DIS-04). The coverage flags say whether the Treasury booked nothing for every line, and whether it agreed with the report on every one.
   */
  async rateSums(
    tx: TenantTx,
    snapshotId: string,
    scope: ScopeBuilder,
    filter: { basis: RateBasis; projectId?: string | undefined; unitId?: string | undefined; fundSourceVersionId?: string | undefined; groupBy: 'NONE' | 'UNIT' | 'PROJECT' },
  ): Promise<Array<{ id: string | null; code: string | null; name: string | null; sums: RateSums }>> {
    const visible = scope(6);
    const key =
      filter.groupBy === 'PROJECT'
        ? { select: 'l.project_id as id, p.code as code, p.name as name', group: 'l.project_id, p.code, p.name', order: 'p.code, l.project_id' }
        : filter.groupBy === 'UNIT'
          ? { select: 'l.unit_id as id, u.code as code, u.name as name', group: 'l.unit_id, u.code, u.name', order: 'u.code nulls last, l.unit_id' }
          : { select: 'null::uuid as id, null::text as code, null::text as name', group: '', order: '1' };
    const rows = await tx.query<{
      id: string | null;
      code: string | null;
      name: string | null;
      projects: string;
      plan_pm: string;
      plan_local: string;
      treasury: string | null;
      reported: string | null;
      ctmtqg: string | null;
      all_none: boolean;
      all_complete: boolean;
    }>(
      `select ${key.select}, count(distinct l.project_id)::text as projects,
              coalesce(sum(l.plan_pm_assigned_vnd), 0)::text as plan_pm, coalesce(sum(l.plan_local_added_vnd), 0)::text as plan_local,
              sum(l.disbursed_treasury_vnd)::text as treasury, sum(l.disbursed_reported_vnd)::text as reported, sum(l.ctmtqg_subset_vnd)::text as ctmtqg,
              coalesce(bool_and(l.treasury_coverage = 'NONE'), true) as all_none, coalesce(bool_and(l.treasury_coverage = 'COMPLETE'), false) as all_complete
         from machvon.period_snapshot_line l
         join ${SCOPE_FROM} on p.tenant_id = l.tenant_id and p.id = l.project_id
         left join machvon.organization_unit u on u.tenant_id = l.tenant_id and u.id = l.unit_id
        where l.snapshot_id = $1::uuid and l.bucket = $2 and ($3::uuid is null or l.project_id = $3::uuid) and ($4::uuid is null or l.unit_id = $4::uuid)
          and ($5::uuid is null or l.fund_source_version_id = $5::uuid) and ${visible.sql}
        ${key.group === '' ? '' : `group by ${key.group}`}
        order by ${key.order}`,
      [snapshotId, filter.basis, filter.projectId ?? null, filter.unitId ?? null, filter.fundSourceVersionId ?? null, ...visible.params],
    );
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      sums: {
        projects: Number(row.projects),
        planPmVnd: row.plan_pm,
        planLocalVnd: row.plan_local,
        treasuryVnd: row.treasury,
        reportedVnd: row.reported,
        ctmtqgVnd: row.ctmtqg,
        allNone: row.all_none,
        allComplete: row.all_complete,
      },
    }));
  }

  /** The lines of a snapshot in the scope of the caller, by project and cell, a page at a time: the cursor is the project code and the cell of the last line. */
  async lines(
    tx: TenantTx,
    id: string,
    scope: ScopeBuilder,
    filter: { projectId?: string | undefined; unitId?: string | undefined },
    request: { limit: number; after: string | undefined },
  ): Promise<SnapshotLineRow[]> {
    const visible = scope(6);
    const rows = await tx.query<LineSql>(
      `select ${LINE_COLUMNS}
         from machvon.period_snapshot_line l join ${SCOPE_FROM} on p.tenant_id = l.tenant_id and p.id = l.project_id
        where l.snapshot_id = $1::uuid and ($2::uuid is null or l.project_id = $2::uuid) and ($3::uuid is null or l.unit_id = $3::uuid)
          and ($4::text is null or (p.code || '|' || l.bucket || '|' || l.budget_level) > $4) and ${visible.sql}
        order by (p.code || '|' || l.bucket || '|' || l.budget_level) limit $5`,
      [id, filter.projectId ?? null, filter.unitId ?? null, request.after ?? null, request.limit, ...visible.params],
    );
    return rows.map(toLine);
  }

  /** Reports that were handed in for a period and are not accepted: what a snapshot leaves out, shown apart as "waiting" (DIS-21). */
  async pendingReports(tx: TenantTx, periodId: string, scope: ScopeBuilder): Promise<Array<{ id: string; projectId: string; projectCode: string; revision: number; status: string }>> {
    const visible = scope(2);
    const rows = await tx.query<{ id: string; project_id: string; project_code: string; revision: number; status: string }>(
      `select r.id, r.project_id, p.code as project_code, r.revision, r.status
         from machvon.report_revision r join ${SCOPE_FROM} on p.tenant_id = r.tenant_id and p.id = r.project_id
        where r.period_id = $1::uuid and r.status in ('SUBMITTED', 'UNDER_REVIEW') and r.deleted_at is null and ${visible.sql}
        order by p.code`,
      [periodId, ...visible.params],
    );
    return rows.map((row) => ({ id: row.id, projectId: row.project_id, projectCode: row.project_code, revision: row.revision, status: row.status }));
  }
}
