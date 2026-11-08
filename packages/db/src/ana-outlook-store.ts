import { FORECAST_RULE_CODE, FORECAST_RULE_TYPE, forecastParamsOf, outlookOf } from '@machvon/kernel';
import type { ForecastParams, Outlook, ResolvedGovernanceRule, OutlookPoint } from '@machvon/kernel';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import { policyVersionOf } from './home-work-policy.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export type OutlookPlanBasis = 'PM' | 'TOTAL';

export interface OutlookSeries {
  /** The fund source version of the lines (null for the whole scope, or for the lines that name no fund source). */
  fundSourceVersionId: string | null;
  fundCode: string | null;
  fundLabel: string | null;
  points: OutlookPoint[];
  planTotalVnd: string | null;
  /** The snapshot the plan was read from (the latest of the series). */
  planSnapshotId: string | null;
  /** How many projects the latest snapshot holds for the series. */
  projects: number;
}

export interface OutlookPolicy {
  params: ForecastParams;
  version: string;
  unverified: boolean;
}

interface Row {
  snapshot_id: string;
  as_of_date: string;
  fund_id: string | null;
  fund_code: string | null;
  fund_label: string | null;
  projects: string;
  plan: string;
  treasury: string | null;
}

/**
 * The weekly series behind the year-end outlook (G3-5): the frozen snapshots of a year (one for each day, the latest official one), each added up in the scope of the reader, whole or by fund source. A snapshot in
 * which the Treasury booked nothing for the series gives no point (no data is not 0). It reads only; the arithmetic of the outlook is the kernel's.
 */
export class AnaOutlookStore {
  constructor(private readonly port: GovernancePolicyPort = new GovernancePolicyPort()) {}

  /** The parameters in force on a day: the approved rule of the tenant, else the built-in default, with the version that decided. */
  async policy(tx: TenantTx, asOf: string | Date): Promise<OutlookPolicy> {
    const rule: ResolvedGovernanceRule = await this.port.require(tx, FORECAST_RULE_TYPE, FORECAST_RULE_CODE, asOf);
    return { params: forecastParamsOf(rule.params), version: policyVersionOf(rule), unverified: rule.unverified };
  }

  /** The frozen snapshots of the year, one for each day, in day order (the official figure of a day is the one that is frozen now). */
  async frozenOfYear(tx: TenantTx, year: number): Promise<Array<{ id: string; asOfDate: string }>> {
    const rows = await tx.query<{ id: string; as_of_date: string }>(
      `select distinct on (s.as_of_date) s.id, s.as_of_date::text as as_of_date
         from machvon.period_snapshot s
        where s.status = 'FROZEN' and s.snapshot_kind = 'PERIOD_CLOSE' and s.as_of_date >= make_date($1::int, 1, 1) and s.as_of_date <= make_date($1::int, 12, 31)
        order by s.as_of_date, s.frozen_at desc, s.id desc`,
      [year],
    );
    return rows.map((row) => ({ id: row.id, asOfDate: row.as_of_date }));
  }

  /** The latest frozen snapshot day at or before `day` (the year of the outlook is the year of it), if any. */
  async latestFrozenDay(tx: TenantTx, onOrBefore: string): Promise<string | undefined> {
    const [row] = await tx.query<{ day: string }>(
      `select s.as_of_date::text as day from machvon.period_snapshot s where s.status = 'FROZEN' and s.snapshot_kind = 'PERIOD_CLOSE' and s.as_of_date <= $1::date order by s.as_of_date desc limit 1`,
      [onOrBefore],
    );
    return row?.day;
  }

  /** The series of the snapshots: one for the whole scope, or one for each fund source (and one for the lines with none) when `byFund`. Fund sources are in code order, the lines with none last. */
  async series(
    tx: TenantTx,
    scope: ScopeBuilder,
    input: { snapshots: ReadonlyArray<{ id: string; asOfDate: string }>; basis: OutlookPlanBasis; underUnitId?: string | undefined; fundSourceVersionId?: string | undefined; byFund: boolean },
  ): Promise<OutlookSeries[]> {
    if (input.snapshots.length === 0) return [];
    const visible = scope(4);
    const plan = input.basis === 'PM' ? 'l.plan_pm_assigned_vnd' : '(l.plan_pm_assigned_vnd + l.plan_local_added_vnd)';
    const fund = input.byFund ? { select: 'l.fund_source_version_id as fund_id, fv.code as fund_code, fv.label as fund_label', group: 'l.fund_source_version_id, fv.code, fv.label', order: 'fv.code nulls last, l.fund_source_version_id nulls last, ' } : { select: 'null::uuid as fund_id, null::text as fund_code, null::text as fund_label', group: '', order: '' };
    const rows = await tx.query<Row>(
      `select l.snapshot_id, s.as_of_date::text as as_of_date, ${fund.select}, count(distinct l.project_id)::text as projects,
              coalesce(sum(${plan}), 0)::text as plan, sum(l.disbursed_treasury_vnd)::text as treasury
         from machvon.period_snapshot_line l
         join machvon.period_snapshot s on s.tenant_id = l.tenant_id and s.id = l.snapshot_id
         join ${SCOPE_FROM} on p.tenant_id = l.tenant_id and p.id = l.project_id
         left join machvon.organization_unit u on u.tenant_id = l.tenant_id and u.id = l.unit_id
         left join machvon.master_record_version fv on fv.tenant_id = l.tenant_id and fv.id = l.fund_source_version_id
        where l.snapshot_id = any($1::uuid[]) and l.bucket = 'CURRENT_YEAR' and ($2::uuid is null or l.fund_source_version_id = $2::uuid)
          and ($3::uuid is null or exists (select 1 from machvon.organization_unit su where su.tenant_id = l.tenant_id and su.id = $3::uuid and u.path is not null and starts_with(u.path, su.path)))
          and ${visible.sql}
        group by l.snapshot_id, s.as_of_date${fund.group === '' ? '' : `, ${fund.group}`}
        order by ${fund.order}s.as_of_date`,
      [input.snapshots.map((one) => one.id), input.fundSourceVersionId ?? null, input.underUnitId ?? null, ...visible.params],
    );
    const bySeries = new Map<string, OutlookSeries & { lastDay: string }>();
    for (const row of rows) {
      const key = row.fund_id ?? '';
      const held = bySeries.get(key) ?? { fundSourceVersionId: row.fund_id, fundCode: row.fund_code, fundLabel: row.fund_label, points: [], planTotalVnd: null, planSnapshotId: null, projects: 0, lastDay: '' };
      if (row.treasury !== null) held.points.push({ asOfDate: row.as_of_date, cumulativeVnd: row.treasury });
      if (row.as_of_date >= held.lastDay) {
        held.lastDay = row.as_of_date;
        held.planTotalVnd = row.plan;
        held.planSnapshotId = row.snapshot_id;
        held.projects = Number(row.projects);
      }
      bySeries.set(key, held);
    }
    return [...bySeries.values()].map((held) => ({ fundSourceVersionId: held.fundSourceVersionId, fundCode: held.fundCode, fundLabel: held.fundLabel, points: held.points, planTotalVnd: held.planTotalVnd, planSnapshotId: held.planSnapshotId, projects: held.projects }));
  }

  /** The outlook of a series (this year's points against the plan and the points of the year before). */
  outlook(series: Pick<OutlookSeries, 'points' | 'planTotalVnd'>, prior: readonly OutlookPoint[], year: number, params: ForecastParams): Outlook {
    return outlookOf({ planTotalVnd: series.planTotalVnd === null || BigInt(series.planTotalVnd) === 0n ? null : series.planTotalVnd, points: series.points, priorPoints: prior, planYearEnd: `${year}-12-31`, params });
  }
}
