import { addDirectiveDays, directiveDaysBetween, factsDefects } from '@machvon/kernel';
import type { ProvinceFacts, ProvinceFactsRequest, ProvinceFundLine, ProvinceProjectFact, ProvinceUnitReport } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

/**
 * The port of the committee workspace (lane BAN-1, docs/committee-workspace.md): where the facts of the whole province come from. The workspace never reads a table of another module itself; it asks a
 * `ProvinceFactsReader` for the facts of a day and judges them with the pure rules of the kernel. `CoreProvinceFactsReader` reads the real core tables (the latest frozen snapshot of the Disbursement module and the
 * registers of the projects, baselines, procurement workflows and reports); the feed of the Finance Department app (lane FEED-1) writes into the same core, so its records arrive here without a second reader.
 * `MemoryProvinceFactsReader` answers from facts a test hands it. A reader returns facts for the whole tenant (row-level security is the only bound): the caller has checked that the person holds the committee
 * permission over the whole tenant.
 */
export interface ProvinceFactsReader {
  /** The facts as of the latest frozen snapshot on or before `request.asOf`; empty facts (no record at all) when there is none. */
  read(tx: TenantTx, request: ProvinceFactsRequest): Promise<ProvinceFacts>;
}

const ZERO = '0';

export const emptyProvinceFacts = (asOf: string): ProvinceFacts => ({ asOf, fiscalYear: Number(asOf.slice(0, 4)), projects: [], lines: [], units: [], feed: { basis: 'DIS_SNAPSHOT', reference: null, lastDeliveredAt: null } });

/** Answers from facts it was given: for the tests of the workspace through the real stores and commands, where the rows of the core are not the subject. Each entry is the facts of one snapshot day. */
export class MemoryProvinceFactsReader implements ProvinceFactsReader {
  private readonly byDay: readonly ProvinceFacts[];

  constructor(byDay: readonly ProvinceFacts[]) {
    this.byDay = byDay;
    for (const facts of byDay) {
      const defects = factsDefects(facts);
      if (defects.length > 0) throw new Error(`province facts break the contract: ${defects[0]}`);
    }
  }

  async read(_tx: TenantTx, request: ProvinceFactsRequest): Promise<ProvinceFacts> {
    const usable = this.byDay.filter((facts) => facts.asOf <= request.asOf).sort((a, b) => (a.asOf < b.asOf ? 1 : a.asOf > b.asOf ? -1 : 0));
    return usable[0] ?? emptyProvinceFacts(request.asOf);
  }
}

interface SnapshotRow {
  id: string;
  as_of_date: string;
}

interface LineSql {
  project_id: string;
  fund_code: string;
  fund_name: string;
  plan: string;
  disbursed: string | null;
  eac: string | null;
}

interface PriorSql {
  project_id: string;
  fund_code: string;
  disbursed: string | null;
}

interface ProjectSql {
  id: string;
  code: string;
  name: string;
  status: string;
  unit_id: string;
  unit_name: string;
  sector_code: string | null;
  sector_name: string | null;
  area_code: string | null;
  area_name: string | null;
  total: string;
  planned_finish: string | null;
  stalled_days: number | null;
  stalled_step: string | null;
  last_reported_on: string | null;
  reported_in_period: boolean;
}

const UNSPECIFIED = 'UNSPECIFIED';

/**
 * The real reader. Plan, disbursed and the estimate at completion come from the lines of the latest frozen snapshot on or before the day (current-year bucket), by project and funding source; the same day of the
 * year before and the whole of the year before come from the frozen snapshots of the year before (a funding source or project with no line there is unknown, never zero). The delay is the days past the planned finish
 * of the baseline in force of a project that is under way; the stalled days are those of the longest idle open step of its procurement workflow; the last report is the latest submitted current report revision.
 * The reports a unit owes are one for each project it implements in the reporting period that is open on the day (the latest period that has started); with no period nothing is owed.
 */
export class CoreProvinceFactsReader implements ProvinceFactsReader {
  async read(tx: TenantTx, request: ProvinceFactsRequest): Promise<ProvinceFacts> {
    const snapshots = await tx.query<SnapshotRow>(
      `select id, as_of_date::text as as_of_date from machvon.period_snapshot where status = 'FROZEN' and as_of_date <= $1::date order by as_of_date desc, frozen_at desc nulls last, id limit 1`,
      [request.asOf],
    );
    const snapshot = snapshots[0];
    if (snapshot === undefined) return emptyProvinceFacts(request.asOf);
    const asOf = snapshot.as_of_date;
    const year = Number(asOf.slice(0, 4));
    const lines = await tx.query<LineSql>(
      `select l.project_id, coalesce(f.code, '${UNSPECIFIED}') as fund_code, coalesce(f.label, '${UNSPECIFIED}') as fund_name,
              sum(l.plan_total_vnd)::text as plan, sum(l.disbursed_treasury_vnd)::text as disbursed, sum(l.forecast_eac_vnd)::text as eac
         from machvon.period_snapshot_line l
         left join machvon.master_record_version f on f.tenant_id = l.tenant_id and f.id = l.fund_source_version_id
        where l.snapshot_id = $1 and l.bucket = 'CURRENT_YEAR'
        group by l.project_id, coalesce(f.code, '${UNSPECIFIED}'), coalesce(f.label, '${UNSPECIFIED}')
        order by l.project_id, 2`,
      [snapshot.id],
    );
    const sameDayLastYear = addDirectiveDays(asOf, -365);
    const prior = await tx.query<SnapshotRow>(
      `select id, as_of_date::text as as_of_date from machvon.period_snapshot where status = 'FROZEN' and as_of_date <= $1::date and as_of_date > $1::date - 40 order by as_of_date desc, frozen_at desc nulls last, id limit 1`,
      [sameDayLastYear],
    );
    const fullYear = await tx.query<SnapshotRow>(
      `select id, as_of_date::text as as_of_date from machvon.period_snapshot where status = 'FROZEN' and as_of_date >= make_date($1::int - 1, 12, 1) and as_of_date <= make_date($1::int - 1, 12, 31) order by as_of_date desc, frozen_at desc nulls last, id limit 1`,
      [year],
    );
    const priorSums = async (row: SnapshotRow | undefined): Promise<Map<string, string | null> | null> => {
      if (row === undefined) return null;
      const rows = await tx.query<PriorSql>(
        `select l.project_id, coalesce(f.code, '${UNSPECIFIED}') as fund_code, sum(l.disbursed_treasury_vnd)::text as disbursed
           from machvon.period_snapshot_line l
           left join machvon.master_record_version f on f.tenant_id = l.tenant_id and f.id = l.fund_source_version_id
          where l.snapshot_id = $1 and l.bucket = 'CURRENT_YEAR'
          group by l.project_id, coalesce(f.code, '${UNSPECIFIED}')`,
        [row.id],
      );
      return new Map(rows.map((one) => [`${one.project_id}|${one.fund_code}`, one.disbursed]));
    };
    const [samePeriod, whole] = [await priorSums(prior[0]), await priorSums(fullYear[0])];
    const fundLines: ProvinceFundLine[] = lines.map((row) => {
      const key = `${row.project_id}|${row.fund_code}`;
      return {
        projectId: row.project_id,
        fundSourceCode: row.fund_code,
        fundSourceName: row.fund_name,
        planVnd: row.plan,
        disbursedVnd: row.disbursed,
        // A snapshot of the year before that exists but holds no line of this project is a project that had no plan then: zero. No snapshot is unknown.
        lastYearSamePeriodVnd: samePeriod === null ? null : samePeriod.has(key) ? (samePeriod.get(key) ?? null) : ZERO,
        lastYearFullYearVnd: whole === null ? null : whole.has(key) ? (whole.get(key) ?? null) : ZERO,
      };
    });
    const projectIds = [...new Set(lines.map((row) => row.project_id))];
    const today = request.asOf;
    const projectRows =
      projectIds.length === 0
        ? []
        : await tx.query<ProjectSql>(
            `select p.id, p.code, p.name, p.status, coalesce(p.investor_unit_id, p.owner_unit_id) as unit_id, u.name as unit_name,
                    s.code as sector_code, s.label as sector_name, a.code as area_code, a.label as area_name, p.total_investment_vnd::text as total,
                    (select b.planned_finish::text from machvon.project_baseline b where b.tenant_id = p.tenant_id and b.project_id = p.id order by b.version desc limit 1) as planned_finish,
                    (select max($2::date - w.last_activity_on)::int from machvon.package_workflow w join machvon.procurement_package k on k.tenant_id = w.tenant_id and k.id = w.package_id
                      where w.tenant_id = p.tenant_id and k.project_id = p.id and w.status in ('IN_PROGRESS', 'ON_HOLD')) as stalled_days,
                    (select w.current_step_code from machvon.package_workflow w join machvon.procurement_package k on k.tenant_id = w.tenant_id and k.id = w.package_id
                      where w.tenant_id = p.tenant_id and k.project_id = p.id and w.status in ('IN_PROGRESS', 'ON_HOLD') order by w.last_activity_on, w.id limit 1) as stalled_step,
                    (select max((r.submitted_at at time zone 'Asia/Ho_Chi_Minh')::date)::text from machvon.report_revision r where r.tenant_id = p.tenant_id and r.project_id = p.id and r.is_current and r.submitted_at is not null) as last_reported_on,
                    exists (select 1 from machvon.report_revision r where r.tenant_id = p.tenant_id and r.project_id = p.id and r.is_current and r.submitted_at is not null
                              and r.period_id = (select rp.id from machvon.reporting_period rp where rp.start_date <= $2::date order by rp.end_date desc limit 1)) as reported_in_period
               from machvon.project p
               join machvon.organization_unit u on u.tenant_id = p.tenant_id and u.id = coalesce(p.investor_unit_id, p.owner_unit_id)
               left join machvon.master_record_version s on s.tenant_id = p.tenant_id and s.id = p.sector_master_version_id
               left join machvon.master_record_version a on a.tenant_id = p.tenant_id and a.id = p.area_master_version_id
              where p.id = any($1::uuid[])
              order by p.code`,
            [projectIds, today],
          );
    const period = await tx.query<{ id: string }>(`select id from machvon.reporting_period where start_date <= $1::date order by end_date desc limit 1`, [today]);
    const projects: ProvinceProjectFact[] = projectRows.map((row) => {
      const eac = lines.filter((one) => one.project_id === row.id && one.eac !== null).reduce<bigint | null>((sum, one) => (sum ?? 0n) + BigInt(one.eac as string), null);
      const underway = row.status === 'IMPLEMENTATION';
      return {
        projectId: row.id,
        code: row.code,
        name: row.name,
        status: row.status,
        investorUnitId: row.unit_id,
        investorName: row.unit_name,
        sectorCode: row.sector_code ?? UNSPECIFIED,
        sectorName: row.sector_name ?? UNSPECIFIED,
        districtCode: row.area_code ?? UNSPECIFIED,
        districtName: row.area_name ?? UNSPECIFIED,
        totalInvestmentVnd: row.total,
        eacVnd: eac === null ? null : eac.toString(),
        delayDays: underway && row.planned_finish !== null ? Math.max(0, directiveDaysBetween(row.planned_finish, today)) : null,
        stalledDays: row.stalled_days,
        stalledStep: row.stalled_days === null ? null : row.stalled_step,
        lastReportedOn: row.last_reported_on,
      };
    });
    const owed = new Map<string, { name: string; expected: number; received: number; last: string | null }>();
    for (const [index, row] of projectRows.entries()) {
      const unit = owed.get(row.unit_id) ?? { name: row.unit_name, expected: 0, received: 0, last: null };
      if (period.length > 0 && row.status === 'IMPLEMENTATION') {
        unit.expected += 1;
        if (row.reported_in_period) unit.received += 1;
      }
      const reported = projects[index]?.lastReportedOn ?? null;
      if (reported !== null && (unit.last === null || reported > unit.last)) unit.last = reported;
      owed.set(row.unit_id, unit);
    }
    const units: ProvinceUnitReport[] = [...owed.entries()].map(([unitId, one]) => ({ unitId, unitName: one.name, expected: one.expected, received: one.received, lastReportedOn: one.last }));
    // The financial cut-off is the day of the snapshot; the age of reports is judged on the day that was asked for.
    return { asOf, evaluatedOn: request.asOf, fiscalYear: year, projects, lines: fundLines, units, feed: { basis: 'DIS_SNAPSHOT', reference: snapshot.id, lastDeliveredAt: null } };
  }
}
