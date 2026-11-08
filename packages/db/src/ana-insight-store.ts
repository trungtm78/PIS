import { INSIGHT_RULE_CODE, INSIGHT_RULE_TYPE, insightParamsOf } from '@machvon/kernel';
import type { HeatInputCell, InsightParams, WeekScore } from '@machvon/kernel';
import { AnalyticsRagStore } from './analytics-rag-store.ts';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import { policyVersionOf } from './home-work-policy.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export interface InsightPolicyReading {
  params: InsightParams;
  version: string;
  unverified: boolean;
}
export interface HeatLabel {
  key: string;
  code: string | null;
  label: string;
}
export interface HeatSource {
  cells: HeatInputCell[];
  rows: HeatLabel[];
  cols: HeatLabel[];
  /** The snapshot (a frozen close snapshot of DIS, or the contract fact frozen with it) and its day. */
  snapshotId: string | null;
  asOfDate: string | null;
}
export const NO_FUND_KEY = 'NONE';

interface UnitFundSql {
  unit_id: string;
  unit_code: string | null;
  unit_name: string;
  fund_id: string | null;
  fund_code: string | null;
  fund_label: string | null;
  projects: string;
  plan: string;
  treasury: string | null;
}
interface ContractorSql {
  contractor_id: string;
  contractor_name: string;
  col_id: string | null;
  col_code: string | null;
  col_label: string | null;
  contracts: string;
  paid: string;
  accepted: string;
}

const labelsOf = (entries: Iterable<HeatLabel>): HeatLabel[] => [...new Map([...entries].map((entry) => [entry.key, entry])).values()].sort((left, right) => ((left.code ?? left.label) < (right.code ?? right.label) ? -1 : (left.code ?? left.label) > (right.code ?? right.label) ? 1 : left.key < right.key ? -1 : 1));

/**
 * What the heat-map, the back-test and the trend ranking read (G3-10, G3-11): the lines of the latest frozen snapshot of DIS grouped by unit and fund source, the contract fact frozen with it grouped by contractor and
 * unit or fund source, and the weekly scores of the units. Everything is read in the scope of the reader and nothing is written; the cells are the kernel's to colour, hide and add up.
 */
export class AnaInsightStore {
  private readonly rag = new AnalyticsRagStore();

  constructor(private readonly port: GovernancePolicyPort = new GovernancePolicyPort()) {}

  async policy(tx: TenantTx, asOf: string | Date): Promise<InsightPolicyReading> {
    const rule = await this.port.require(tx, INSIGHT_RULE_TYPE, INSIGHT_RULE_CODE, asOf);
    return { params: insightParamsOf(rule.params), version: policyVersionOf(rule), unverified: rule.unverified };
  }

  /** The units against the fund sources: the Treasury and the plan of the Prime Minister of each pair, and how many projects stand under it. */
  async unitFund(tx: TenantTx, scope: ScopeBuilder, snapshotId: string, asOfDate: string): Promise<HeatSource> {
    const visible = scope(2);
    const rows = await tx.query<UnitFundSql>(
      `select l.unit_id, u.code as unit_code, u.name as unit_name, l.fund_source_version_id as fund_id, fv.code as fund_code, fv.label as fund_label, count(distinct l.project_id)::text as projects,
              coalesce(sum(l.plan_pm_assigned_vnd), 0)::text as plan, sum(l.disbursed_treasury_vnd)::text as treasury
         from machvon.period_snapshot_line l
         join ${SCOPE_FROM} on p.tenant_id = l.tenant_id and p.id = l.project_id
         left join machvon.organization_unit u on u.tenant_id = l.tenant_id and u.id = l.unit_id
         left join machvon.master_record_version fv on fv.tenant_id = l.tenant_id and fv.id = l.fund_source_version_id
        where l.snapshot_id = $1::uuid and l.bucket = 'CURRENT_YEAR' and ${visible.sql}
        group by l.unit_id, u.code, u.name, l.fund_source_version_id, fv.code, fv.label`,
      [snapshotId, ...visible.params],
    );
    return {
      cells: rows.map((row) => ({ rowKey: row.unit_id, colKey: row.fund_id ?? NO_FUND_KEY, numeratorVnd: row.treasury, denominatorVnd: row.plan, count: Number(row.projects) })),
      rows: labelsOf(rows.map((row) => ({ key: row.unit_id, code: row.unit_code, label: row.unit_name }))),
      cols: labelsOf(rows.map((row) => ({ key: row.fund_id ?? NO_FUND_KEY, code: row.fund_code, label: row.fund_label ?? '' }))),
      snapshotId,
      asOfDate,
    };
  }

  /** The contractors against the units or the fund sources, from the contract fact frozen with the latest frozen snapshot: what was paid and what was accepted, and how many contracts stand under each pair. */
  async contractors(tx: TenantTx, scope: ScopeBuilder, column: 'UNIT' | 'FUND'): Promise<HeatSource> {
    const [latest] = await tx.query<{ id: string; as_of_date: string }>(
      `select s.id, ps.as_of_date::text as as_of_date from machvon.contract_fact_snapshot s join machvon.period_snapshot ps on ps.tenant_id = s.tenant_id and ps.id = s.period_snapshot_id
        where ps.status = 'FROZEN' order by ps.as_of_date desc, s.revision desc limit 1`,
    );
    if (latest === undefined) return { cells: [], rows: [], cols: [], snapshotId: null, asOfDate: null };
    const visible = scope(2);
    const col = column === 'UNIT' ? { id: 'cl.unit_id', code: 'cu.code', label: 'cu.name', join: 'left join machvon.organization_unit cu on cu.tenant_id = cl.tenant_id and cu.id = cl.unit_id' } : { id: 'cl.fund_source_version_id', code: 'fv.code', label: 'fv.label', join: 'left join machvon.master_record_version fv on fv.tenant_id = cl.tenant_id and fv.id = cl.fund_source_version_id' };
    const rows = await tx.query<ContractorSql>(
      `select cl.contractor_id, c.legal_name as contractor_name, ${col.id} as col_id, ${col.code} as col_code, ${col.label} as col_label, count(distinct cl.contract_id)::text as contracts,
              coalesce(sum(cl.paid_vnd), 0)::text as paid, coalesce(sum(cl.accepted_vnd), 0)::text as accepted
         from machvon.contract_fact_snapshot_line cl
         join ${SCOPE_FROM} on p.tenant_id = cl.tenant_id and p.id = cl.project_id
         join machvon.contractor c on c.tenant_id = cl.tenant_id and c.id = cl.contractor_id
         ${col.join}
        where cl.snapshot_id = $1::uuid and ${visible.sql}
        group by cl.contractor_id, c.legal_name, ${col.id}, ${col.code}, ${col.label}`,
      [latest.id, ...visible.params],
    );
    return {
      cells: rows.map((row) => ({ rowKey: row.contractor_id, colKey: row.col_id ?? NO_FUND_KEY, numeratorVnd: row.paid, denominatorVnd: row.accepted, count: Number(row.contracts) })),
      rows: labelsOf(rows.map((row) => ({ key: row.contractor_id, code: null, label: row.contractor_name }))),
      cols: labelsOf(rows.map((row) => ({ key: row.col_id ?? NO_FUND_KEY, code: row.col_code, label: row.col_label ?? '' }))),
      snapshotId: latest.id,
      asOfDate: latest.as_of_date,
    };
  }

  /** The stored weekly scores of the units the reader may read, the latest `weeks` weeks up to `latestWeek`, with the code and the name of each unit. */
  async scores(tx: TenantTx, unitScope: ScopeBuilder, latestWeek: string, weeks: number): Promise<{ scores: WeekScore[]; units: Map<string, { code: string; name: string }> }> {
    const history = await this.rag.history(tx, latestWeek, weeks, unitScope);
    const ids = [...new Set(history.map((row) => row.unitId))];
    const names = ids.length === 0 ? [] : await tx.query<{ id: string; code: string | null; name: string }>('select id, code, name from machvon.organization_unit where id = any($1::uuid[])', [ids]);
    return {
      scores: history.map((row) => ({ unitId: row.unitId, weekStart: row.weekStart, score: row.score, band: row.band })),
      units: new Map(names.map((row) => [row.id, { code: row.code ?? '', name: row.name }])),
    };
  }
}
