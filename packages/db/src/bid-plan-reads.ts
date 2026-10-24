import { activeGrants, permissionMatches } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import type { BiddingForm, PackageContractType } from './bid-plan-input.ts';
import type { PlanStatus } from './bid-plan-store.ts';
import { timestampKey } from './keyset.ts';
import { SCOPE_FROM, projectScope } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/** What a reader who does not plan or approve sees of the plans: the one in force and the ones it replaced. */
const READER_STATUSES: readonly string[] = ['APPROVED', 'SUPERSEDED'];
/** Holding any of these (on any scope) makes a person part of the circle that plans and approves, who see the plans in work and their words too. */
const PLANNING_PERMISSIONS: readonly string[] = ['bid.plan.manage', 'bid.plan.approve'];

/** What a caller reads of the plans: the projects in the scope of the read permission, and the plans in work only when the caller plans or approves. */
export interface BidReadScope {
  projects: ScopeBuilder;
  circle: boolean;
}

/** The scope of a read under `permission` for this caller at this moment. */
export function bidReadScope(access: EffectiveAccess, permission: string, now: Date): BidReadScope {
  const circle = activeGrants(access, now).some((grant) => grant.permissions.some((held) => PLANNING_PERMISSIONS.some((required) => permissionMatches(held, required))));
  return { projects: projectScope(access, permission, now), circle };
}

export interface ProjectLabel {
  id: string;
  code: string;
  name: string;
  status: string;
}

export interface LastDecision {
  kind: 'APPROVED' | 'REJECTED' | 'RETURNED';
  comment: string | null;
  decidedAt: string;
}

export interface PlanLine {
  id: string;
  project: ProjectLabel;
  revision: number;
  title: string;
  legalBasis: string;
  totalVnd: string;
  status: PlanStatus;
  supersedesId: string | null;
  decisionDocument: { id: string; symbol: string | null; issuedOn: string | null } | null;
  approvedAt: string | null;
  packageCount: number;
  lastDecision: LastDecision | null;
  version: number;
  createdAtKey: string;
}

export interface PackageLine {
  id: string;
  code: string;
  title: string | null;
  project: ProjectLabel;
  plan: { id: string; revision: number; status: PlanStatus } | null;
  budgetVnd: string;
  method: string;
  contractType: PackageContractType | null;
  biddingForm: BiddingForm | null;
  allocationLineId: string | null;
  fundSource: { businessKey: string; label: string } | null;
  plannedStartPeriod: string | null;
  durationDays: number | null;
  status: string;
  approvedDecisionId: string | null;
  version: number;
  createdAtKey: string;
}

export interface PlanFilter {
  projectId?: string | undefined;
  status?: PlanStatus | undefined;
}

export interface Page {
  limit: number;
  after: { code: string; id: string } | undefined;
}

interface PlanSql {
  id: string;
  project_id: string;
  project_code: string;
  project_name: string;
  project_status: string;
  revision: number;
  title: string;
  legal_basis: string;
  total_value_vnd: string;
  status: PlanStatus;
  supersedes_id: string | null;
  decision_document_id: string | null;
  decision_symbol: string | null;
  decision_issued_on: string | null;
  approved_at: string | null;
  package_count: string;
  last_kind: LastDecision['kind'] | null;
  last_comment: string | null;
  last_at: string | null;
  version: string;
  created_at_key: string;
}

interface PackageSql {
  id: string;
  code: string;
  title: string | null;
  project_id: string;
  project_code: string;
  project_name: string;
  project_status: string;
  plan_id: string | null;
  plan_revision: number | null;
  plan_status: PlanStatus | null;
  budget_vnd: string;
  method: string;
  contract_type: PackageContractType | null;
  bidding_form: BiddingForm | null;
  allocation_line_id: string | null;
  fund_key: string | null;
  fund_label: string | null;
  planned_start_period: string | null;
  duration_days: number | null;
  status: string;
  approved_decision_id: string | null;
  version: string;
  created_at_key: string;
}

const PLAN_SELECT = `select pl.id, p.id as project_id, p.code as project_code, p.name as project_name, p.status as project_status, pl.revision, pl.title, pl.legal_basis,
  pl.total_value_vnd::text as total_value_vnd, pl.status, pl.supersedes_id, pl.decision_document_id, d.symbol as decision_symbol, d.issued_on::text as decision_issued_on,
  ${timestampKey('pl.approved_at')} as approved_at,
  (select count(*) from machvon.procurement_package k where k.tenant_id = pl.tenant_id and k.plan_id = pl.id)::text as package_count,
  ld.event_kind as last_kind, ld.comment as last_comment, ${timestampKey('ld.occurred_at')} as last_at,
  pl.version::text as version, ${timestampKey('pl.created_at')} as created_at_key
  from ${SCOPE_FROM}
  join machvon.procurement_plan pl on pl.tenant_id = p.tenant_id and pl.project_id = p.id
  left join machvon.document d on d.tenant_id = pl.tenant_id and d.id = pl.decision_document_id
  left join lateral (
    select e.event_kind, e.comment, e.occurred_at from machvon.procurement_plan_event e
     where e.tenant_id = pl.tenant_id and e.plan_id = pl.id and e.event_kind in ('APPROVED', 'REJECTED', 'RETURNED')
     order by e.occurred_at desc, e.id desc limit 1
  ) ld on true`;

const PACKAGE_SELECT = `select k.id, k.code, k.title, p.id as project_id, p.code as project_code, p.name as project_name, p.status as project_status,
  pl.id as plan_id, pl.revision as plan_revision, pl.status as plan_status, k.budget_vnd::text as budget_vnd, k.method, k.contract_type, k.bidding_form,
  k.allocation_line_id, fr.business_key as fund_key, fv.label as fund_label, k.planned_start_period, k.duration_days, k.status, k.approved_decision_id,
  k.version::text as version, ${timestampKey('k.created_at')} as created_at_key
  from ${SCOPE_FROM}
  join machvon.procurement_package k on k.tenant_id = p.tenant_id and k.project_id = p.id
  left join machvon.procurement_plan pl on pl.tenant_id = k.tenant_id and pl.id = k.plan_id
  left join machvon.allocation_line al on al.tenant_id = k.tenant_id and al.id = k.allocation_line_id
  left join machvon.master_record_version fv on fv.tenant_id = al.tenant_id and fv.id = al.fund_source_version_id
  left join machvon.master_record fr on fr.tenant_id = fv.tenant_id and fr.id = fv.master_record_id`;

const projectOf = (row: { project_id: string; project_code: string; project_name: string; project_status: string }): ProjectLabel => ({
  id: row.project_id,
  code: row.project_code,
  name: row.project_name,
  status: row.project_status,
});

const toPlan = (row: PlanSql, circle: boolean): PlanLine => ({
  id: row.id,
  project: projectOf(row),
  revision: row.revision,
  title: row.title,
  legalBasis: row.legal_basis,
  totalVnd: row.total_value_vnd,
  status: row.status,
  supersedesId: row.supersedes_id,
  decisionDocument: row.decision_document_id === null ? null : { id: row.decision_document_id, symbol: row.decision_symbol, issuedOn: row.decision_issued_on },
  approvedAt: row.approved_at,
  packageCount: Number(row.package_count),
  // The words of a decision belong to the circle that plans and approves.
  lastDecision: row.last_kind === null || row.last_at === null ? null : { kind: row.last_kind, comment: circle ? row.last_comment : null, decidedAt: row.last_at },
  version: Number(row.version),
  createdAtKey: row.created_at_key,
});

const toPackage = (row: PackageSql): PackageLine => ({
  id: row.id,
  code: row.code,
  title: row.title,
  project: projectOf(row),
  plan: row.plan_id === null || row.plan_revision === null || row.plan_status === null ? null : { id: row.plan_id, revision: row.plan_revision, status: row.plan_status },
  budgetVnd: row.budget_vnd,
  method: row.method,
  contractType: row.contract_type,
  biddingForm: row.bidding_form,
  allocationLineId: row.allocation_line_id,
  fundSource: row.fund_key === null || row.fund_label === null ? null : { businessKey: row.fund_key, label: row.fund_label },
  plannedStartPeriod: row.planned_start_period,
  durationDays: row.duration_days,
  status: row.status,
  approvedDecisionId: row.approved_decision_id,
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

const readerStatuses = READER_STATUSES.map((status) => `'${status}'`).join(', ');

/**
 * The plans and the packages, read in the scope of the caller (BID-03, BID-15, BID-16). A plan and its packages belong to a project, so they
 * are shown to a caller whose scope contains the project (its owner unit, its investor unit or the project itself); a plan in work (a draft,
 * one in review, one rejected) is shown only to the people who plan and approve. A package without a plan is one that procurement awarded
 * outside a plan; it is shown like a plan in force. Money is a decimal string in whole VND.
 */
export class BidPlanReads {
  /** The plans the caller may see, the newest first. */
  async listPlans(tx: TenantTx, scope: BidReadScope, filter: PlanFilter, page: Page): Promise<PlanLine[]> {
    const params = new SqlParams();
    const where = [this.planVisibility(scope), params.scope(scope.projects)];
    if (filter.projectId !== undefined) where.push(`pl.project_id = ${params.add(filter.projectId)}::uuid`);
    if (filter.status !== undefined) where.push(`pl.status = ${params.add(filter.status)}`);
    if (page.after !== undefined) where.push(`(${timestampKey('pl.created_at')}, pl.id) < (${params.add(page.after.code)}::text, ${params.add(page.after.id)}::uuid)`);
    const rows = await tx.query<PlanSql>(`${PLAN_SELECT} where ${where.join(' and ')} order by pl.created_at desc, pl.id desc limit ${params.add(page.limit)}`, params.values);
    return rows.map((row) => toPlan(row, scope.circle));
  }

  /** The packages the caller may see, the newest first (the cursor is the creation time and the id of the last one). */
  async listPackages(tx: TenantTx, scope: BidReadScope, page: Page): Promise<PackageLine[]> {
    const params = new SqlParams();
    const where = [this.packageVisibility(scope), params.scope(scope.projects)];
    if (page.after !== undefined) where.push(`(${timestampKey('k.created_at')}, k.id) < (${params.add(page.after.code)}::text, ${params.add(page.after.id)}::uuid)`);
    const rows = await tx.query<PackageSql>(`${PACKAGE_SELECT} where ${where.join(' and ')} order by k.created_at desc, k.id desc limit ${params.add(page.limit)}`, params.values);
    return rows.map(toPackage);
  }

  /** One package in the scope of the caller; undefined when it does not exist, lies outside the scope or belongs to a plan in work the caller does not see. */
  async findPackage(tx: TenantTx, id: string, scope: BidReadScope): Promise<PackageLine | undefined> {
    const params = new SqlParams();
    const where = [`k.id = ${params.add(id)}::uuid`, this.packageVisibility(scope), params.scope(scope.projects)];
    const rows = await tx.query<PackageSql>(`${PACKAGE_SELECT} where ${where.join(' and ')}`, params.values);
    return rows[0] === undefined ? undefined : toPackage(rows[0]);
  }

  private planVisibility(scope: BidReadScope): string {
    return scope.circle ? 'true' : `pl.status in (${readerStatuses})`;
  }

  private packageVisibility(scope: BidReadScope): string {
    return scope.circle ? 'true' : `(k.plan_id is null or pl.status in (${readerStatuses}))`;
  }
}
