import { activeGrants, addDecimal, permissionMatches } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { timestampKey } from './keyset.ts';
import { projectScope } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export const PLAN_KINDS = ['ANNUAL', 'MEDIUM_TERM'] as const;
export type PlanKind = (typeof PLAN_KINDS)[number];
export const PLAN_STATUSES = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'PUBLISHED', 'SUPERSEDED', 'REJECTED'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export const LINE_BUCKETS = ['CURRENT_YEAR', 'CARRYOVER', 'OTHER'] as const;
export type LineBucket = (typeof LINE_BUCKETS)[number];

/** What a reader who cannot draft sees of the plans: the revisions in force and the ones that were replaced. */
const READER_STATUSES: readonly string[] = ['PUBLISHED', 'SUPERSEDED'];
/** Holding any of these (on any scope) makes a person part of the drafting and approving circle, who see the revisions in work too. */
const DRAFTING_PERMISSIONS: readonly string[] = ['capital.plan.draft', 'capital.plan.submit', 'capital.plan.approve', 'plan.publish'];

/**
 * What a caller reads of the plans: the lines of the projects in the scope of the read permission, and the revisions in work (DRAFT to
 * APPROVED, REJECTED) only when the caller drafts or approves plans (CAP 3.1 section 7, `x-exposure-reason` of the plan version reads).
 */
export interface PlanReadScope {
  lines: ScopeBuilder;
  drafts: boolean;
}

/** The scope of a read of the plans under `permission` for this caller at this moment. */
export function planReadScope(access: EffectiveAccess, permission: string, now: Date): PlanReadScope {
  const drafts = activeGrants(access, now).some((grant) => grant.permissions.some((held) => DRAFTING_PERMISSIONS.some((required) => permissionMatches(held, required))));
  return { lines: projectScope(access, permission, now), drafts };
}

export interface UnitLabel {
  id: string;
  name: string;
}

export interface FundSourceLabel {
  versionId: string;
  businessKey: string;
  label: string;
}

/** The header of a plan revision. */
export interface CapitalPlanRow {
  id: string;
  planCode: string;
  planKind: PlanKind;
  /** The plan year of an annual plan; null for a medium-term plan. */
  planYear: number | null;
  periodFromYear: number;
  periodToYear: number;
  scopeUnit: UnitLabel;
  revision: number;
  status: PlanStatus;
  decisionDocumentId: string | null;
  decisionSymbol: string | null;
  decisionIssuedOn: string | null;
  supersedesId: string | null;
  effectiveAt: string | null;
  publishedAt: string | null;
  /** When the revision was last submitted and last decided, and the reason of that decision (what a planner reads when a plan is returned). */
  submittedAt: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  version: number;
  /** Creation time to the microsecond (UTC): the ordering key of the list and its cursor. */
  createdAtKey: string;
}

/** What the plan holds in the scope of the caller, as exact decimal strings in whole VND. */
export interface PlanTotals {
  lineCount: number;
  /** The sum of the lines. The part that belongs to a national target programme (CTMTQG) is inside it, never added. */
  allocatedVnd: string;
  ctmtqgSubsetVnd: string;
  /** The sum of the appropriations the lines draw on, each counted once. */
  ceilingVnd: string;
}

export interface CapitalPlanListRow extends CapitalPlanRow {
  totals: PlanTotals;
  fundSources: FundSourceLabel[];
}

export interface PlanProjectRow {
  projectId: string;
  projectCode: string;
  projectName: string;
  lineCount: number;
  allocatedVnd: string;
}

export interface PlanFilter {
  planKind?: PlanKind | undefined;
  status?: PlanStatus | undefined;
  planYear?: number | undefined;
}

export interface LineFilter {
  id?: string | undefined;
  capitalPlanId?: string | undefined;
  projectId?: string | undefined;
  fundSourceVersionId?: string | undefined;
}

export interface Page {
  limit: number;
  after: { code: string; id: string } | undefined;
}

export interface AppropriationLabel {
  id: string;
  planYear: number;
  amountVnd: string;
  allocatedTotalVnd: string;
  remainingVnd: string;
}

/** One line of a plan: a project's share of one appropriation. */
export interface PlanLineRow {
  id: string;
  capitalPlanId: string;
  planCode: string;
  planStatus: PlanStatus;
  project: { id: string; code: string; name: string };
  fundSource: FundSourceLabel & { category: string | null };
  appropriation: AppropriationLabel | null;
  bucket: LineBucket;
  sourceYear: number;
  amountVnd: string;
  ctmtqgSubsetVnd: string;
  budgetLevel: string | null;
  origin: string | null;
  isExtended: boolean;
  extendedTo: string | null;
  extensionDocument: { id: string; symbol: string | null; issuedOn: string | null } | null;
  program: { versionId: string; businessKey: string; label: string } | null;
  previousLineId: string | null;
  /** The balance of the line once the plan is published; null until then. */
  committedVnd: string | null;
  reservedVnd: string | null;
  disbursedVnd: string | null;
  version: number;
  createdAtKey: string;
}

interface PlanSql {
  id: string;
  plan_code: string;
  plan_kind: PlanKind;
  plan_year: number | null;
  period_from_year: number;
  period_to_year: number;
  scope_unit_id: string;
  scope_unit_name: string;
  revision: number;
  status: PlanStatus;
  decision_document_id: string | null;
  decision_symbol: string | null;
  decision_issued_on: string | null;
  supersedes_id: string | null;
  effective_at: string | null;
  published_at: string | null;
  submitted_at: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  version: string;
  created_at_key: string;
}

const PLAN_SELECT = `select cp.id, cp.plan_code, cp.plan_kind, cp.plan_year, cp.period_from_year, cp.period_to_year, cp.scope_unit_id, su.name as scope_unit_name, cp.revision,
    cp.status, cp.decision_document_id, dd.symbol as decision_symbol, dd.issued_on::text as decision_issued_on, cp.supersedes_id,
    to_char(cp.effective_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as effective_at,
    to_char(cp.published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as published_at,
    to_char(cp.submitted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as submitted_at,
    to_char(cp.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as decided_at, cp.decision_reason, cp.version::text as version, ${timestampKey('cp.created_at')} as created_at_key
  from machvon.capital_plan cp
  join machvon.organization_unit su on su.tenant_id = cp.tenant_id and su.id = cp.scope_unit_id
  left join machvon.document dd on dd.tenant_id = cp.tenant_id and dd.id = cp.decision_document_id`;

const toPlan = (row: PlanSql): CapitalPlanRow => ({
  id: row.id,
  planCode: row.plan_code,
  planKind: row.plan_kind,
  planYear: row.plan_year,
  periodFromYear: row.period_from_year,
  periodToYear: row.period_to_year,
  scopeUnit: { id: row.scope_unit_id, name: row.scope_unit_name },
  revision: row.revision,
  status: row.status,
  decisionDocumentId: row.decision_document_id,
  decisionSymbol: row.decision_symbol,
  decisionIssuedOn: row.decision_issued_on,
  supersedesId: row.supersedes_id,
  effectiveAt: row.effective_at,
  publishedAt: row.published_at,
  submittedAt: row.submitted_at,
  decidedAt: row.decided_at,
  decisionReason: row.decision_reason,
  version: Number(row.version),
  createdAtKey: row.created_at_key,
});

/** A line with the project it belongs to, the unit that owns the project (the scope is judged by it) and the plan it is drafted in. */
const LINE_FROM = `machvon.allocation_line al
  join machvon.plan_version pv on pv.tenant_id = al.tenant_id and pv.id = al.plan_version_id
  join machvon.capital_plan cp on cp.tenant_id = pv.tenant_id and cp.id = pv.capital_plan_id
  join machvon.project p on p.tenant_id = al.tenant_id and p.id = al.project_id
  join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
  left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id`;

interface LineSql {
  id: string;
  capital_plan_id: string;
  plan_code: string;
  plan_status: PlanStatus;
  project_id: string;
  project_code: string;
  project_name: string;
  fund_source_version_id: string;
  fund_key: string;
  fund_label: string;
  fund_attributes: Record<string, unknown>;
  appropriation_id: string | null;
  appropriation_year: number | null;
  appropriation_amount: string | null;
  appropriation_allocated: string | null;
  appropriation_remaining: string | null;
  bucket: LineBucket;
  source_year: number;
  amount_vnd: string;
  ctmtqg_subset_vnd: string;
  budget_level: string | null;
  origin: string | null;
  is_extended: boolean;
  extended_to: string | null;
  extension_document_id: string | null;
  extension_symbol: string | null;
  extension_issued_on: string | null;
  program_master_version_id: string | null;
  program_key: string | null;
  program_label: string | null;
  previous_line_id: string | null;
  committed_vnd: string | null;
  reserved_vnd: string | null;
  disbursed_vnd: string | null;
  version: string;
  created_at_key: string;
}

const LINE_SELECT = `select al.id, pv.capital_plan_id, cp.plan_code, cp.status as plan_status, p.id as project_id, p.code as project_code, p.name as project_name,
    al.fund_source_version_id, fr.business_key as fund_key, fv.label as fund_label, fv.attributes as fund_attributes,
    al.appropriation_id, a.plan_year as appropriation_year, a.amount_vnd::text as appropriation_amount, a.allocated_total_vnd::text as appropriation_allocated,
    (a.amount_vnd - a.allocated_total_vnd)::text as appropriation_remaining, al.bucket, al.source_year, al.amount_vnd::text as amount_vnd,
    al.ctmtqg_subset_vnd::text as ctmtqg_subset_vnd, al.budget_level, al.origin, al.is_extended, al.extended_to::text as extended_to, al.extension_document_id,
    ed.symbol as extension_symbol, ed.issued_on::text as extension_issued_on, al.program_master_version_id, pr.business_key as program_key, pvv.label as program_label,
    al.previous_line_id, ab.committed_vnd::text as committed_vnd, ab.reserved_vnd::text as reserved_vnd, ab.disbursed_vnd::text as disbursed_vnd, al.version::text as version, ${timestampKey('al.created_at')} as created_at_key
  from ${LINE_FROM}
  join machvon.master_record_version fv on fv.tenant_id = al.tenant_id and fv.id = al.fund_source_version_id
  join machvon.master_record fr on fr.tenant_id = fv.tenant_id and fr.id = fv.master_record_id
  left join machvon.appropriation a on a.tenant_id = al.tenant_id and a.id = al.appropriation_id
  left join machvon.document ed on ed.tenant_id = al.tenant_id and ed.id = al.extension_document_id
  left join machvon.master_record_version pvv on pvv.tenant_id = al.tenant_id and pvv.id = al.program_master_version_id
  left join machvon.master_record pr on pr.tenant_id = pvv.tenant_id and pr.id = pvv.master_record_id
  left join machvon.allocation_balance ab on ab.tenant_id = al.tenant_id and ab.allocation_line_id = al.id`;

const toLine = (row: LineSql): PlanLineRow => ({
  id: row.id,
  capitalPlanId: row.capital_plan_id,
  planCode: row.plan_code,
  planStatus: row.plan_status,
  project: { id: row.project_id, code: row.project_code, name: row.project_name },
  fundSource: {
    versionId: row.fund_source_version_id,
    businessKey: row.fund_key,
    label: row.fund_label,
    category: typeof row.fund_attributes.category === 'string' ? row.fund_attributes.category : null,
  },
  appropriation:
    row.appropriation_id === null || row.appropriation_year === null
      ? null
      : {
          id: row.appropriation_id,
          planYear: row.appropriation_year,
          amountVnd: row.appropriation_amount ?? '0',
          allocatedTotalVnd: row.appropriation_allocated ?? '0',
          remainingVnd: row.appropriation_remaining ?? '0',
        },
  bucket: row.bucket,
  sourceYear: row.source_year,
  amountVnd: row.amount_vnd,
  ctmtqgSubsetVnd: row.ctmtqg_subset_vnd,
  budgetLevel: row.budget_level,
  origin: row.origin,
  isExtended: row.is_extended,
  extendedTo: row.extended_to,
  extensionDocument: row.extension_document_id === null ? null : { id: row.extension_document_id, symbol: row.extension_symbol, issuedOn: row.extension_issued_on },
  program: row.program_master_version_id === null ? null : { versionId: row.program_master_version_id, businessKey: row.program_key ?? '', label: row.program_label ?? '' },
  previousLineId: row.previous_line_id,
  committedVnd: row.committed_vnd,
  reservedVnd: row.reserved_vnd,
  disbursedVnd: row.disbursed_vnd,
  version: Number(row.version),
  createdAtKey: row.created_at_key,
});

/** Parameters numbered as they are added, so a query can be put together from optional parts. */
class SqlParams {
  readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }

  /** The predicate of a scope, its parameters numbered after the ones added so far. */
  scope(builder: ScopeBuilder): string {
    const predicate = builder(this.values.length + 1);
    this.values.push(...predicate.params);
    return predicate.sql;
  }
}

/** The predicate that hides the revisions in work from a reader who does not draft or approve. */
const visibility = (scope: PlanReadScope): string => (scope.drafts ? 'true' : `cp.status in ('${READER_STATUSES.join("', '")}')`);

interface AggregateSql {
  capital_plan_id: string;
  appropriation_id: string | null;
  appropriation_amount: string | null;
  fund_source_version_id: string;
  fund_key: string;
  fund_label: string;
  lines: string;
  amount: string;
  ctmtqg: string;
}

function emptyTotals(): PlanTotals {
  return { lineCount: 0, allocatedVnd: '0', ctmtqgSubsetVnd: '0', ceilingVnd: '0' };
}

/**
 * The plans and their lines, read in the scope of the caller (CAP-01, CAP-03, CAP-06, the reads of the plan version and of the allocation
 * line). A line belongs to a project, so it is shown to a caller whose scope contains the project (its owner unit, its investor unit or the
 * project itself); a plan revision in work is shown only to the people who draft and approve plans. Money is a decimal string in whole VND.
 */
export class CapPlanReads {
  /** The plan revisions the caller may see, newest first, each with what it holds in the caller's scope. */
  async listPlans(tx: TenantTx, scope: PlanReadScope, filter: PlanFilter, page: Page): Promise<CapitalPlanListRow[]> {
    const params = new SqlParams();
    const where = [visibility(scope)];
    if (filter.planKind !== undefined) where.push(`cp.plan_kind = ${params.add(filter.planKind)}`);
    if (filter.status !== undefined) where.push(`cp.status = ${params.add(filter.status)}`);
    if (filter.planYear !== undefined) where.push(`${params.add(filter.planYear)}::integer between cp.period_from_year and cp.period_to_year`);
    if (page.after !== undefined) where.push(`(${timestampKey('cp.created_at')}, cp.id) < (${params.add(page.after.code)}::text, ${params.add(page.after.id)}::uuid)`);
    const rows = await tx.query<PlanSql>(`${PLAN_SELECT} where ${where.join(' and ')} order by cp.created_at desc, cp.id desc limit ${params.add(page.limit)}`, params.values);
    const aggregates = await this.aggregates(tx, rows.map((row) => row.id), scope);
    return rows.map((row) => {
      const found = aggregates.get(row.id);
      return { ...toPlan(row), totals: found?.totals ?? emptyTotals(), fundSources: found?.fundSources ?? [] };
    });
  }

  /** One plan revision with its totals in the scope of the caller; undefined when it does not exist or is a revision in work the caller does not see. */
  async findPlan(tx: TenantTx, id: string, scope: PlanReadScope): Promise<CapitalPlanListRow | undefined> {
    const params = new SqlParams();
    const rows = await tx.query<PlanSql>(`${PLAN_SELECT} where cp.id = ${params.add(id)}::uuid and ${visibility(scope)}`, params.values);
    const row = rows[0];
    if (row === undefined) return undefined;
    const found = (await this.aggregates(tx, [row.id], scope)).get(row.id);
    return { ...toPlan(row), totals: found?.totals ?? emptyTotals(), fundSources: found?.fundSources ?? [] };
  }

  /** The projects a plan has lines for, in the scope of the caller. */
  async planProjects(tx: TenantTx, planId: string, scope: PlanReadScope): Promise<PlanProjectRow[]> {
    const params = new SqlParams();
    const where = [`pv.capital_plan_id = ${params.add(planId)}::uuid`, visibility(scope), params.scope(scope.lines)];
    const rows = await tx.query<{ project_id: string; project_code: string; project_name: string; lines: string; amount: string }>(
      `select p.id as project_id, p.code as project_code, p.name as project_name, count(*)::text as lines, sum(al.amount_vnd)::text as amount
         from ${LINE_FROM} where ${where.join(' and ')} group by p.id, p.code, p.name order by p.code, p.id`,
      params.values,
    );
    return rows.map((row) => ({ projectId: row.project_id, projectCode: row.project_code, projectName: row.project_name, lineCount: Number(row.lines), allocatedVnd: row.amount }));
  }

  /** The lines in the scope of the caller, ordered by creation (the cursor is the creation time and the id of the last line). */
  async listLines(tx: TenantTx, filter: LineFilter, scope: PlanReadScope, page: Page): Promise<PlanLineRow[]> {
    const params = new SqlParams();
    const where = this.lineWhere(filter, scope, params);
    if (page.after !== undefined) where.push(`(${timestampKey('al.created_at')}, al.id) > (${params.add(page.after.code)}::text, ${params.add(page.after.id)}::uuid)`);
    const rows = await tx.query<LineSql>(`${LINE_SELECT} where ${where.join(' and ')} order by al.created_at, al.id limit ${params.add(page.limit)}`, params.values);
    return rows.map(toLine);
  }

  async findLine(tx: TenantTx, id: string, scope: PlanReadScope): Promise<PlanLineRow | undefined> {
    const params = new SqlParams();
    const rows = await tx.query<LineSql>(`${LINE_SELECT} where ${this.lineWhere({ id }, scope, params).join(' and ')}`, params.values);
    return rows[0] === undefined ? undefined : toLine(rows[0]);
  }

  /** What the filtered lines add up to: the whole filter, not one page. The part of a line that is CTMTQG is shown apart and never added to the total. */
  async lineTotals(tx: TenantTx, filter: LineFilter, scope: PlanReadScope): Promise<{ lineCount: number; allocatedVnd: string; ctmtqgSubsetVnd: string }> {
    const params = new SqlParams();
    const rows = await tx.query<{ lines: string; amount: string; ctmtqg: string }>(
      `select count(*)::text as lines, coalesce(sum(al.amount_vnd), 0)::text as amount, coalesce(sum(al.ctmtqg_subset_vnd), 0)::text as ctmtqg
         from ${LINE_FROM} where ${this.lineWhere(filter, scope, params).join(' and ')}`,
      params.values,
    );
    const row = rows[0];
    return { lineCount: Number(row?.lines ?? 0), allocatedVnd: row?.amount ?? '0', ctmtqgSubsetVnd: row?.ctmtqg ?? '0' };
  }

  private lineWhere(filter: LineFilter, scope: PlanReadScope, params: SqlParams): string[] {
    const where = [visibility(scope), params.scope(scope.lines)];
    if (filter.id !== undefined) where.push(`al.id = ${params.add(filter.id)}::uuid`);
    if (filter.capitalPlanId !== undefined) where.push(`pv.capital_plan_id = ${params.add(filter.capitalPlanId)}::uuid`);
    if (filter.projectId !== undefined) where.push(`al.project_id = ${params.add(filter.projectId)}::uuid`);
    if (filter.fundSourceVersionId !== undefined) where.push(`al.fund_source_version_id = ${params.add(filter.fundSourceVersionId)}::uuid`);
    return where;
  }

  /** The totals, the sources and the ceiling of some plans in the scope of the caller, in one read. */
  private async aggregates(tx: TenantTx, planIds: readonly string[], scope: PlanReadScope): Promise<Map<string, { totals: PlanTotals; fundSources: FundSourceLabel[] }>> {
    const found = new Map<string, { totals: PlanTotals; fundSources: FundSourceLabel[] }>();
    if (planIds.length === 0) return found;
    const params = new SqlParams();
    const where = [`pv.capital_plan_id = any(${params.add([...planIds])}::uuid[])`, visibility(scope), params.scope(scope.lines)];
    const rows = await tx.query<AggregateSql>(
      `select pv.capital_plan_id, al.appropriation_id, a.amount_vnd::text as appropriation_amount, al.fund_source_version_id, fr.business_key as fund_key, fv.label as fund_label,
              count(*)::text as lines, sum(al.amount_vnd)::text as amount, sum(al.ctmtqg_subset_vnd)::text as ctmtqg
         from ${LINE_FROM}
         join machvon.master_record_version fv on fv.tenant_id = al.tenant_id and fv.id = al.fund_source_version_id
         join machvon.master_record fr on fr.tenant_id = fv.tenant_id and fr.id = fv.master_record_id
         left join machvon.appropriation a on a.tenant_id = al.tenant_id and a.id = al.appropriation_id
        where ${where.join(' and ')}
        group by pv.capital_plan_id, al.appropriation_id, a.amount_vnd, al.fund_source_version_id, fr.business_key, fv.label
        order by fr.business_key, al.fund_source_version_id`,
      params.values,
    );
    const counted = new Set<string>();
    for (const row of rows) {
      const entry = found.get(row.capital_plan_id) ?? { totals: emptyTotals(), fundSources: [] };
      entry.totals.lineCount += Number(row.lines);
      entry.totals.allocatedVnd = addDecimal(entry.totals.allocatedVnd, row.amount);
      entry.totals.ctmtqgSubsetVnd = addDecimal(entry.totals.ctmtqgSubsetVnd, row.ctmtqg);
      // An appropriation is a ceiling once for the plan, however many lines or sources draw on it.
      const ceilingKey = `${row.capital_plan_id}:${row.appropriation_id ?? ''}`;
      if (row.appropriation_id !== null && row.appropriation_amount !== null && !counted.has(ceilingKey)) {
        counted.add(ceilingKey);
        entry.totals.ceilingVnd = addDecimal(entry.totals.ceilingVnd, row.appropriation_amount);
      }
      if (!entry.fundSources.some((source) => source.versionId === row.fund_source_version_id)) {
        entry.fundSources.push({ versionId: row.fund_source_version_id, businessKey: row.fund_key, label: row.fund_label });
      }
      found.set(row.capital_plan_id, entry);
    }
    return found;
  }
}
