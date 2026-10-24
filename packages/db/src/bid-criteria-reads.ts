import { activeGrants, permissionMatches } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { SqlParams } from './bid-plan-reads.ts';
import type { Page, ProjectLabel } from './bid-plan-reads.ts';
import type { CriteriaStatus } from './bid-criteria-store.ts';
import { timestampKey } from './keyset.ts';
import { SCOPE_FROM, projectScope } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/** What a reader who does not draft or approve criteria sees of them: the version in force and the ones it replaced. */
const READER_STATUSES: readonly string[] = ['APPROVED', 'SUPERSEDED'];
/** Holding any of these (on any scope) makes a person part of the circle that drafts and approves, who see the drafts too. */
const CRITERIA_PERMISSIONS: readonly string[] = ['bid.criteria.manage', 'bid.criteria.approve'];

export interface CriteriaReadScope {
  projects: ScopeBuilder;
  circle: boolean;
}

/** The scope of a read under `permission` for this caller at this moment. */
export function criteriaReadScope(access: EffectiveAccess, permission: string, now: Date): CriteriaReadScope {
  const circle = activeGrants(access, now).some((grant) => grant.permissions.some((held) => CRITERIA_PERMISSIONS.some((required) => permissionMatches(held, required))));
  return { projects: projectScope(access, permission, now), circle };
}

export interface CriteriaLine {
  id: string;
  package: { id: string; code: string; title: string | null; status: string; project: ProjectLabel };
  revision: number;
  status: CriteriaStatus;
  criteria: unknown;
  weightsSum: number | null;
  legalBasis: string | null;
  approvedAt: string | null;
  version: number;
  createdAtKey: string;
}

export interface CriteriaFilter {
  packageId?: string | undefined;
  status?: CriteriaStatus | undefined;
}

interface CriteriaSql {
  id: string;
  package_id: string;
  package_code: string;
  package_title: string | null;
  package_status: string;
  project_id: string;
  project_code: string;
  project_name: string;
  project_status: string;
  revision: number;
  status: CriteriaStatus;
  criteria_json: unknown;
  weights_sum: number | null;
  legal_basis: string | null;
  approved_at: string | null;
  version: string;
  created_at_key: string;
}

const SELECT = `select cv.id, k.id as package_id, k.code as package_code, k.title as package_title, k.status as package_status,
  p.id as project_id, p.code as project_code, p.name as project_name, p.status as project_status,
  cv.revision, cv.status, cv.criteria_json, cv.weights_sum, cv.legal_basis, ${timestampKey('cv.effective_at')} as approved_at,
  cv.version::text as version, ${timestampKey('cv.created_at')} as created_at_key
  from ${SCOPE_FROM}
  join machvon.procurement_package k on k.tenant_id = p.tenant_id and k.project_id = p.id
  join machvon.criteria_version cv on cv.tenant_id = k.tenant_id and cv.package_id = k.id`;

const toLine = (row: CriteriaSql): CriteriaLine => ({
  id: row.id,
  package: {
    id: row.package_id,
    code: row.package_code,
    title: row.package_title,
    status: row.package_status,
    project: { id: row.project_id, code: row.project_code, name: row.project_name, status: row.project_status },
  },
  revision: row.revision,
  status: row.status,
  criteria: row.criteria_json,
  weightsSum: row.weights_sum,
  legalBasis: row.legal_basis,
  approvedAt: row.approved_at,
  version: Number(row.version),
  createdAtKey: row.created_at_key,
});

const readerStatuses = READER_STATUSES.map((status) => `'${status}'`).join(', ');

/**
 * The criteria for reading (BID-04): the versions of the packages of the projects in the scope of the caller, the newest first. A draft is shown to
 * the people who draft and approve criteria only; the version in force and the ones it replaced are shown to every reader of the scope.
 */
export class BidCriteriaReads {
  async list(tx: TenantTx, scope: CriteriaReadScope, filter: CriteriaFilter, page: Page): Promise<CriteriaLine[]> {
    const params = new SqlParams();
    const where = [this.visibility(scope), params.scope(scope.projects)];
    if (filter.packageId !== undefined) where.push(`k.id = ${params.add(filter.packageId)}::uuid`);
    if (filter.status !== undefined) where.push(`cv.status = ${params.add(filter.status)}`);
    if (page.after !== undefined) where.push(`(${timestampKey('cv.created_at')}, cv.id) < (${params.add(page.after.code)}::text, ${params.add(page.after.id)}::uuid)`);
    const rows = await tx.query<CriteriaSql>(`${SELECT} where ${where.join(' and ')} order by cv.created_at desc, cv.id desc limit ${params.add(page.limit)}`, params.values);
    return rows.map(toLine);
  }

  /** One version in the scope of the caller; undefined when it does not exist, lies outside the scope or is a draft the caller does not see. */
  async find(tx: TenantTx, id: string, scope: CriteriaReadScope): Promise<CriteriaLine | undefined> {
    const params = new SqlParams();
    const where = [`cv.id = ${params.add(id)}::uuid`, this.visibility(scope), params.scope(scope.projects)];
    const rows = await tx.query<CriteriaSql>(`${SELECT} where ${where.join(' and ')}`, params.values);
    return rows[0] === undefined ? undefined : toLine(rows[0]);
  }

  private visibility(scope: CriteriaReadScope): string {
    return scope.circle ? 'true' : `cv.status in (${readerStatuses})`;
  }
}
