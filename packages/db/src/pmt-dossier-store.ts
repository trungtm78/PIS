import { randomUUID } from 'node:crypto';
import { DomainError, shiftDays, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { timestampKey } from './keyset.ts';
import { appliesTo } from './pmt-permit-applicability.ts';
import type { ProjectFacts } from './pmt-permit-applicability.ts';
import { projectScope } from './prj-project-store.ts';
import { scopePredicate } from './scope-version.ts';
import type { ScopeBuilder, ScopePredicate } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';
import { withUniqueClaim } from './unique-claim.ts';

export const PERMIT_STATUSES = ['PLANNED', 'SUBMITTED', 'IN_APPRAISAL', 'SUPPLEMENT_REQUESTED', 'ISSUED', 'REJECTED', 'EXPIRED', 'REVOKED', 'SUPERSEDED', 'EXEMPTED'] as const;
export type PermitStatus = (typeof PERMIT_STATUSES)[number];
export type DossierStatus = 'OPEN' | 'COMPLETE' | 'CLOSED';

/** Permits that expire within this many days are "expiring" on the dossier (the first alert level of BR-PMT-06). */
export const EXPIRING_WITHIN_DAYS = 60;

const DOSSIER_SCOPE_CONSTRAINT = 'permit_dossier_scope_uq';

/** A unit with the path its scope is judged by. */
export interface UnitPlace {
  id: string;
  path: string;
}

/** Where a dossier lies for the permission test: the project and the units that own and invest in it, and the unit that keeps the dossier. */
export interface DossierPlace {
  dossierId: string;
  projectId: string;
  projectCode: string;
  ownerUnit: UnitPlace;
  investorUnit: UnitPlace | null;
  dossierUnit: UnitPlace;
}

export interface PermitProjectPlace {
  projectId: string;
  projectCode: string;
  ownerUnit: UnitPlace;
  investorUnit: UnitPlace | null;
  facts: ProjectFacts;
}

export interface NewDossier {
  projectComponentId?: string | undefined;
  ownerUnitId: string;
  ownerMembershipId?: string | undefined;
}

/** One permit the opening of a dossier planned, from the permit type version in force that day. */
export interface PlannedPermit {
  permitId: string;
  permitTypeId: string;
  permitTypeCode: string;
  permitTypeRevision: number;
  awaitingConfirmation: boolean;
}

export interface OpenedDossier {
  id: string;
  projectId: string;
  projectComponentId: string | null;
  ownerUnitId: string;
  ownerMembershipId: string | null;
  status: 'OPEN';
  version: number;
  asOf: string;
  planned: PlannedPermit[];
}

/** The state of the readiness cache of a dossier after a recount. */
export interface Readiness {
  readinessPct: string;
  status: DossierStatus;
  required: number;
  satisfied: number;
  changed: boolean;
  version: number;
}

export interface DossierLine {
  id: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  projectComponentId: string | null;
  projectComponentCode: string | null;
  ownerUnitId: string;
  ownerUnitName: string;
  ownerMembership: { membershipId: string; displayName: string } | null;
  status: DossierStatus;
  readinessPct: string;
  /** Types the dossier must hold a permit of, and how many of them are covered by a valid permit or an exemption today. */
  requiredCount: number;
  satisfiedCount: number;
  /** Permits ISSUED and still valid today, and those among them that end within `EXPIRING_WITHIN_DAYS`. */
  issuedCount: number;
  expiringCount: number;
  /** Open or current permits whose type version still waits for its legal confirmation. */
  unconfirmedCount: number;
  version: number;
}

export interface PermitLine {
  id: string;
  dossierId: string;
  permitTypeId: string;
  permitTypeCode: string;
  permitTypeRevision: number;
  permitTypeName: string;
  /** The confirmation id the type version still waits for; null once confirmed. */
  cxnRef: string | null;
  exemptionAllowed: boolean;
  isRequired: boolean;
  status: PermitStatus;
  permitNo: string | null;
  authorityName: string | null;
  submittedOn: string | null;
  expectedDecisionOn: string | null;
  issuedOn: string | null;
  validFrom: string | null;
  validUntil: string | null;
  noExpiry: boolean;
  supersedesId: string | null;
  responsibleMembership: { membershipId: string; displayName: string } | null;
  version: number;
}

export interface MilestoneLine {
  id: string;
  stepCode: string;
  plannedOn: string | null;
  actualOn: string | null;
  note: string | null;
  documentVersionId: string | null;
  createdAt: string;
}

export interface DossierDetail extends DossierLine {
  permits: PermitLine[];
}

export interface PermitDetail extends PermitLine {
  projectId: string;
  projectCode: string;
  projectName: string;
  documentVersionId: string | null;
  exemptionBasis: string | null;
  exemptionDecisionDocumentVersionId: string | null;
  revokeReason: string | null;
  revocationDocumentVersionId: string | null;
  milestones: MilestoneLine[];
}

interface UnitSql {
  owner_unit_id: string;
  owner_unit_path: string;
  investor_unit_id: string | null;
  investor_unit_path: string | null;
}

interface PlaceSql extends UnitSql {
  dossier_id: string;
  project_id: string;
  project_code: string;
  dossier_unit_id: string;
  dossier_unit_path: string;
}

interface ProjectSql extends UnitSql {
  project_id: string;
  project_code: string;
  project_group: string | null;
  total_investment_vnd: string;
  type_key: string | null;
  sector_key: string | null;
}

interface DossierSql {
  id: string;
  project_id: string;
  project_code: string;
  project_name: string;
  project_component_id: string | null;
  project_component_code: string | null;
  owner_unit_id: string;
  owner_unit_name: string;
  owner_membership_id: string | null;
  owner_name: string | null;
  status: DossierStatus;
  readiness_pct: string;
  required_count: string;
  satisfied_count: string;
  issued_count: string;
  expiring_count: string;
  unconfirmed_count: string;
  version: string;
}

interface PermitSql {
  id: string;
  dossier_id: string;
  permit_type_id: string;
  permit_type_code: string;
  permit_type_revision: number;
  permit_type_name: string;
  cxn_ref: string | null;
  exemption_allowed: boolean;
  is_required: boolean;
  status: PermitStatus;
  permit_no: string | null;
  authority_name: string | null;
  submitted_on: string | null;
  expected_decision_on: string | null;
  issued_on: string | null;
  valid_from: string | null;
  valid_until: string | null;
  no_expiry: boolean;
  supersedes_id: string | null;
  responsible_membership_id: string | null;
  responsible_name: string | null;
  version: string;
}

interface PermitDetailSql extends PermitSql {
  project_id: string;
  project_code: string;
  project_name: string;
  document_version_id: string | null;
  exemption_basis: string | null;
  exemption_decision_document_version_id: string | null;
  revoke_reason: string | null;
  revocation_document_version_id: string | null;
}

interface MilestoneSql {
  id: string;
  step_code: string;
  planned_on: string | null;
  actual_on: string | null;
  note: string | null;
  document_version_id: string | null;
  created_at: string;
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

const unitOf = (id: string | null, path: string | null): UnitPlace | null => (id === null || path === null ? null : { id, path });

/** The permit as the dossier and the detail read it, with the type version it names and the member in charge. */
export const PERMIT_COLUMNS = `x.id, x.dossier_id, x.permit_type_id, coalesce(x.permit_type_code, t.code) as permit_type_code, t.revision as permit_type_revision, t.name as permit_type_name, t.cxn_ref,
  t.exemption_allowed, x.is_required, x.status, x.permit_no, x.authority_name, x.submitted_on::text as submitted_on,
  x.expected_decision_on::text as expected_decision_on, x.issued_on::text as issued_on, x.valid_from::text as valid_from, x.valid_until::text as valid_until,
  x.no_expiry, x.supersedes_id, x.responsible_membership_id, rm.display_name as responsible_name, x.version::text as version`;

export const PERMIT_FROM = `machvon.permit x
  join machvon.permit_type t on t.tenant_id = x.tenant_id and t.id = x.permit_type_id
  left join machvon.tenant_user_directory rm on rm.tenant_id = x.tenant_id and rm.membership_id = x.responsible_membership_id`;

/** What the scope of a dossier is judged by, joined to the dossier `d`: the project `p` and the units `ou`, `iu` and `du`. */
const SCOPE_JOINS = `join machvon.project p on p.tenant_id = d.tenant_id and p.id = d.project_id
  join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
  left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id
  join machvon.organization_unit du on du.tenant_id = d.tenant_id and du.id = d.owner_unit_id`;

const SCOPE_FROM = `machvon.permit_dossier d ${SCOPE_JOINS}`;

/** The same, reached from a permit `x`. */
const PERMIT_SCOPE_FROM = `machvon.permit x join machvon.permit_dossier d on d.tenant_id = x.tenant_id and d.id = x.dossier_id ${SCOPE_JOINS}`;

const DOSSIER_FROM = `${SCOPE_FROM}
  left join machvon.project_component pc on pc.tenant_id = d.tenant_id and pc.id = d.project_component_id
  left join machvon.tenant_user_directory om on om.tenant_id = d.tenant_id and om.membership_id = d.owner_membership_id`;

/** The counts of the dossier line: the parameter `$1` is the Vietnam date they are counted on, `$2` the last day of the expiring window. */
const DOSSIER_COLUMNS = `d.id, d.project_id, p.code as project_code, p.name as project_name, d.project_component_id, pc.code as project_component_code,
  d.owner_unit_id, du.name as owner_unit_name, d.owner_membership_id, om.display_name as owner_name, d.status, d.readiness_pct::text as readiness_pct,
  (select count(distinct x.permit_type_code) from machvon.permit x where x.tenant_id = d.tenant_id and x.dossier_id = d.id and x.is_required) as required_count,
  (select count(*) from (select x.permit_type_code from machvon.permit x where x.tenant_id = d.tenant_id and x.dossier_id = d.id and x.is_required
      group by x.permit_type_code
     having bool_or(${satisfiedSql('x')})) s) as satisfied_count,
  (select count(*) from machvon.permit x where x.tenant_id = d.tenant_id and x.dossier_id = d.id and ${validIssuedSql('x')}) as issued_count,
  (select count(*) from machvon.permit x where x.tenant_id = d.tenant_id and x.dossier_id = d.id and ${validIssuedSql('x')}
      and not x.no_expiry and x.valid_until <= $2::date) as expiring_count,
  (select count(*) from machvon.permit x join machvon.permit_type t on t.tenant_id = x.tenant_id and t.id = x.permit_type_id
    where x.tenant_id = d.tenant_id and x.dossier_id = d.id and t.cxn_ref is not null
      and x.status in ('PLANNED', 'SUBMITTED', 'IN_APPRAISAL', 'SUPPLEMENT_REQUESTED', 'ISSUED', 'EXEMPTED')) as unconfirmed_count,
  d.version::text as version`;

/** SQL: the permit `alias` is ISSUED and valid on the date `$1` (BR-PMT-01: the first and the last day both count). */
function validIssuedSql(alias: string): string {
  return `${alias}.status = 'ISSUED' and (${alias}.valid_from is null or ${alias}.valid_from <= $1::date) and (${alias}.no_expiry or ${alias}.valid_until >= $1::date)`;
}

/** SQL: the permit `alias` covers its type today: a valid issued permit, or an exemption. */
function satisfiedSql(alias: string): string {
  return `(${alias}.status = 'EXEMPTED' or (${validIssuedSql(alias)}))`;
}

const countOf = (value: string): number => Number(value);

const toPermitLine = (row: PermitSql): PermitLine => ({
  id: row.id,
  dossierId: row.dossier_id,
  permitTypeId: row.permit_type_id,
  permitTypeCode: row.permit_type_code,
  permitTypeRevision: row.permit_type_revision,
  permitTypeName: row.permit_type_name,
  cxnRef: row.cxn_ref,
  exemptionAllowed: row.exemption_allowed,
  isRequired: row.is_required,
  status: row.status,
  permitNo: row.permit_no,
  authorityName: row.authority_name,
  submittedOn: row.submitted_on,
  expectedDecisionOn: row.expected_decision_on,
  issuedOn: row.issued_on,
  validFrom: row.valid_from,
  validUntil: row.valid_until,
  noExpiry: row.no_expiry,
  supersedesId: row.supersedes_id,
  responsibleMembership: row.responsible_membership_id === null ? null : { membershipId: row.responsible_membership_id, displayName: row.responsible_name ?? '' },
  version: Number(row.version),
});

const toDossierLine = (row: DossierSql): DossierLine => ({
  id: row.id,
  projectId: row.project_id,
  projectCode: row.project_code,
  projectName: row.project_name,
  projectComponentId: row.project_component_id,
  projectComponentCode: row.project_component_code,
  ownerUnitId: row.owner_unit_id,
  ownerUnitName: row.owner_unit_name,
  ownerMembership: row.owner_membership_id === null ? null : { membershipId: row.owner_membership_id, displayName: row.owner_name ?? '' },
  status: row.status,
  readinessPct: row.readiness_pct,
  requiredCount: countOf(row.required_count),
  satisfiedCount: countOf(row.satisfied_count),
  issuedCount: countOf(row.issued_count),
  expiringCount: countOf(row.expiring_count),
  unconfirmedCount: countOf(row.unconfirmed_count),
  version: Number(row.version),
});

/**
 * A scope builder for a permission over dossiers: a dossier is in scope when the owner unit or the investor unit of its project, or the
 * unit that keeps the dossier, lies in a scope of a grant that carries the permission, or the grant names the project itself. Compiled over
 * the aliases `d`, `p`, `ou`, `iu` and `du`; the parameters are numbered from the first one given.
 */
export function dossierScope(access: EffectiveAccess, permission: string, now: Date): ScopeBuilder {
  const ofProject = projectScope(access, permission, now);
  return (first: number): ScopePredicate => {
    const base = ofProject(first);
    if (base.sql === 'true') return base;
    const own = scopePredicate(access, permission, now, { unitPath: 'du.path', unitId: 'du.id' }, first + base.params.length);
    if (own.sql === 'false') return base;
    return { sql: `(${base.sql} or ${own.sql})`, params: [...base.params, ...own.params] };
  };
}

/**
 * The project permit dossier (ST-PMT-002, PMT 3.1): one per project, or per component of it, opened with the permits the rules of the day
 * require. A permit is added to it, moved along and replaced by `PmtPermitStore`; this store opens the dossier, keeps its readiness and
 * reads dossiers and permits in the scope of the caller. The readiness is a cache (BR-PMT-01): the share of the required types that are
 * covered by a valid permit or an exemption, recounted by every command that changes a permit.
 */
export class PmtDossierStore {
  private readonly today: () => string;

  constructor(options: { today?: () => string } = {}) {
    this.today = options.today ?? (() => vietnamDateOf(new Date()));
  }

  /** The Vietnam date the dossier rules are read for. */
  currentDate(): string {
    return this.today();
  }

  // ---- places (the permission test is made by the caller) -------------------------------------------------------

  /** The project with the units it lies in and the facts the permit rules are read against; undefined when it does not exist in the tenant. */
  async projectPlace(tx: TenantTx, projectId: string): Promise<PermitProjectPlace | undefined> {
    const rows = await tx.query<ProjectSql>(
      `select p.id as project_id, p.code as project_code, p.project_group, p.total_investment_vnd::text as total_investment_vnd,
              ou.id as owner_unit_id, ou.path as owner_unit_path, iu.id as investor_unit_id, iu.path as investor_unit_path,
              tr.business_key as type_key, sr.business_key as sector_key
         from machvon.project p
         join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
         left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id
         left join machvon.master_record_version tv on tv.tenant_id = p.tenant_id and tv.id = p.project_type_master_version_id
         left join machvon.master_record tr on tr.tenant_id = tv.tenant_id and tr.id = tv.master_record_id
         left join machvon.master_record_version sv on sv.tenant_id = p.tenant_id and sv.id = p.sector_master_version_id
         left join machvon.master_record sr on sr.tenant_id = sv.tenant_id and sr.id = sv.master_record_id
        where p.id = $1::uuid`,
      [projectId],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    const workTypes = [row.type_key, row.sector_key].filter((key): key is string => key !== null).map((key) => key.toUpperCase());
    return {
      projectId: row.project_id,
      projectCode: row.project_code,
      ownerUnit: { id: row.owner_unit_id, path: row.owner_unit_path },
      investorUnit: unitOf(row.investor_unit_id, row.investor_unit_path),
      facts: { projectGroup: row.project_group, workTypes: [...new Set(workTypes)], totalInvestmentVnd: row.total_investment_vnd },
    };
  }

  /** The dossier with the units it lies in; undefined when it does not exist in the tenant. */
  async dossierPlace(tx: TenantTx, dossierId: string): Promise<DossierPlace | undefined> {
    const rows = await tx.query<PlaceSql>(
      `select d.id as dossier_id, p.id as project_id, p.code as project_code, ou.id as owner_unit_id, ou.path as owner_unit_path,
              iu.id as investor_unit_id, iu.path as investor_unit_path, du.id as dossier_unit_id, du.path as dossier_unit_path
         from ${SCOPE_FROM} where d.id = $1::uuid`,
      [dossierId],
    );
    return rows[0] === undefined ? undefined : placeOf(rows[0]);
  }

  /** The dossier a permit lies in, with the units; undefined when the permit does not exist in the tenant. */
  async permitPlace(tx: TenantTx, permitId: string): Promise<DossierPlace | undefined> {
    const rows = await tx.query<PlaceSql>(
      `select d.id as dossier_id, p.id as project_id, p.code as project_code, ou.id as owner_unit_id, ou.path as owner_unit_path,
              iu.id as investor_unit_id, iu.path as investor_unit_path, du.id as dossier_unit_id, du.path as dossier_unit_path
         from ${PERMIT_SCOPE_FROM}
        where x.id = $1::uuid`,
      [permitId],
    );
    return rows[0] === undefined ? undefined : placeOf(rows[0]);
  }

  // ---- opening ---------------------------------------------------------------------------------------------------

  /**
   * Opens the dossier of a project, or of one component of it, with a PLANNED permit for every type version in force today (inclusive
   * days) whose condition applies to the project. A type that still waits for its confirmation is planned and flagged, not left out
   * (PMT 3.1 step 1). One dossier per project and component: a second is 409 DOSSIER_EXISTS, also when two requests race.
   */
  async open(tx: TenantTx, project: PermitProjectPlace, input: NewDossier, actor: string): Promise<OpenedDossier> {
    const projectComponentId = input.projectComponentId?.toLowerCase() ?? null;
    const ownerUnitId = input.ownerUnitId.toLowerCase();
    const ownerMembershipId = input.ownerMembershipId?.toLowerCase() ?? null;
    const asOf = this.today();
    if (projectComponentId !== null) await this.assertComponent(tx, project.projectId, projectComponentId);
    await this.assertUnit(tx, ownerUnitId, asOf);
    if (ownerMembershipId !== null) await this.assertMember(tx, ownerMembershipId, 'owner_membership_id');
    if (await this.exists(tx, project.projectId, projectComponentId)) throw new DomainError('DOSSIER_EXISTS', 409);
    const id = randomUUID();
    await withUniqueClaim(tx, { constraint: DOSSIER_SCOPE_CONSTRAINT, code: 'DOSSIER_EXISTS' }, () =>
      tx.query(
        `insert into machvon.permit_dossier (tenant_id, id, project_id, project_component_id, owner_unit_id, owner_membership_id, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $6::uuid)`,
        [id, project.projectId, projectComponentId, ownerUnitId, ownerMembershipId, actor],
      ),
    );
    const planned: PlannedPermit[] = [];
    for (const type of await this.typesInForce(tx, asOf)) {
      if (!appliesTo(type.applies_to_rule, project.facts)) continue;
      const permitId = randomUUID();
      await tx.query(
        `insert into machvon.permit (tenant_id, id, dossier_id, permit_type_id, authority_name, is_required, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4, true, $5::uuid, $5::uuid)`,
        [permitId, id, type.id, type.authority_text, actor],
      );
      planned.push({ permitId, permitTypeId: type.id, permitTypeCode: type.code, permitTypeRevision: type.revision, awaitingConfirmation: type.cxn_ref !== null });
    }
    return { id, projectId: project.projectId, projectComponentId, ownerUnitId, ownerMembershipId, status: 'OPEN', version: 1, asOf, planned };
  }

  /**
   * Recounts the readiness of a dossier as of today and stores it when it changed (the version of the dossier moves only then). The
   * dossier is COMPLETE while every required type is covered, OPEN otherwise; a CLOSED dossier stays closed.
   */
  async refreshReadiness(tx: TenantTx, dossierId: string, actor: string): Promise<Readiness> {
    const asOf = this.today();
    const counts = await tx.query<{ required: string; satisfied: string }>(
      `select count(*) as required, count(*) filter (where covered) as satisfied
         from (select bool_or(${satisfiedSql('x')}) as covered
                 from machvon.permit x where x.dossier_id = $2::uuid and x.is_required and x.permit_type_code is not null
                group by x.permit_type_code) per_type`,
      [asOf, dossierId],
    );
    const required = countOf(counts[0]?.required ?? '0');
    const satisfied = countOf(counts[0]?.satisfied ?? '0');
    const dossier = (await tx.query<{ status: DossierStatus; readiness_pct: string; version: string }>('select status, readiness_pct::text as readiness_pct, version::text as version from machvon.permit_dossier where id = $1::uuid for update', [dossierId]))[0];
    if (dossier === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const percent = required === 0 ? '0.00' : ((satisfied * 100) / required).toFixed(2);
    const status: DossierStatus = dossier.status === 'CLOSED' ? 'CLOSED' : required > 0 && satisfied === required ? 'COMPLETE' : 'OPEN';
    if (Number(dossier.readiness_pct).toFixed(2) === percent && dossier.status === status) {
      return { readinessPct: percent, status, required, satisfied, changed: false, version: Number(dossier.version) };
    }
    await tx.query(
      `update machvon.permit_dossier set readiness_pct = $2::numeric, status = $3, updated_at = now(), updated_by = $4::uuid, version = version + 1 where id = $1::uuid`,
      [dossierId, percent, status, actor],
    );
    return { readinessPct: percent, status, required, satisfied, changed: true, version: Number(dossier.version) + 1 };
  }

  // ---- reads (a DTO is built by the caller) ---------------------------------------------------------------------

  /** The dossiers in the scope of the caller, ordered by project code; the cursor is the code key of the last line. */
  async list(
    tx: TenantTx,
    scope: ScopeBuilder,
    filter: { projectId?: string | undefined },
    request: { limit: number; after: { code: string; id: string } | undefined },
  ): Promise<DossierLine[]> {
    const asOf = this.today();
    const predicate = scope(7);
    const rows = await tx.query<DossierSql>(
      `select ${DOSSIER_COLUMNS} from ${DOSSIER_FROM}
        where ($3::text is null or (p.code, d.id) > ($3::text, $4::uuid)) and ($5::uuid is null or d.project_id = $5::uuid) and ${predicate.sql}
        order by p.code, d.id limit $6`,
      [asOf, shiftDays(asOf, EXPIRING_WITHIN_DAYS), request.after?.code ?? null, request.after?.id ?? null, filter.projectId?.toLowerCase() ?? null, request.limit, ...predicate.params],
    );
    return rows.map(toDossierLine);
  }

  /** One dossier with its permits (the current ones first), in the scope of the caller; undefined when it does not exist or lies outside the scope. */
  async find(tx: TenantTx, id: string, scope: ScopeBuilder): Promise<DossierDetail | undefined> {
    const asOf = this.today();
    const predicate = scope(4);
    const rows = await tx.query<DossierSql>(`select ${DOSSIER_COLUMNS} from ${DOSSIER_FROM} where d.id = $3::uuid and ${predicate.sql}`, [
      asOf,
      shiftDays(asOf, EXPIRING_WITHIN_DAYS),
      id,
      ...predicate.params,
    ]);
    const row = rows[0];
    if (row === undefined) return undefined;
    const permits = await tx.query<PermitSql>(
      `select ${PERMIT_COLUMNS} from ${PERMIT_FROM} where x.dossier_id = $1::uuid
        order by x.is_required desc, x.permit_type_code, x.created_at desc, x.id`,
      [id],
    );
    return { ...toDossierLine(row), permits: permits.map(toPermitLine) };
  }

  /** One permit with its milestones in the order they happened, in the scope of the caller; undefined when it does not exist or lies outside the scope. */
  async findPermit(tx: TenantTx, id: string, scope: ScopeBuilder): Promise<PermitDetail | undefined> {
    const predicate = scope(2);
    const rows = await tx.query<PermitDetailSql>(
      `select ${PERMIT_COLUMNS}, p.id as project_id, p.code as project_code, p.name as project_name, x.document_version_id, x.exemption_basis,
              x.exemption_decision_document_version_id, x.revoke_reason, x.revocation_document_version_id
         from machvon.permit x
         join machvon.permit_type t on t.tenant_id = x.tenant_id and t.id = x.permit_type_id
         left join machvon.tenant_user_directory rm on rm.tenant_id = x.tenant_id and rm.membership_id = x.responsible_membership_id
         join machvon.permit_dossier d on d.tenant_id = x.tenant_id and d.id = x.dossier_id ${SCOPE_JOINS}
        where x.id = $1::uuid and ${predicate.sql}`,
      [id, ...predicate.params],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    const milestones = await tx.query<MilestoneSql>(
      `select id, step_code, planned_on::text as planned_on, actual_on::text as actual_on, note, document_version_id, ${timestampKey('created_at')} as created_at
         from machvon.permit_milestone where permit_id = $1::uuid order by created_at, id`,
      [id],
    );
    return {
      ...toPermitLine(row),
      projectId: row.project_id,
      projectCode: row.project_code,
      projectName: row.project_name,
      documentVersionId: row.document_version_id,
      exemptionBasis: row.exemption_basis,
      exemptionDecisionDocumentVersionId: row.exemption_decision_document_version_id,
      revokeReason: row.revoke_reason,
      revocationDocumentVersionId: row.revocation_document_version_id,
      milestones: milestones.map((milestone) => ({
        id: milestone.id,
        stepCode: milestone.step_code,
        plannedOn: milestone.planned_on,
        actualOn: milestone.actual_on,
        note: milestone.note,
        documentVersionId: milestone.document_version_id,
        createdAt: milestone.created_at,
      })),
    };
  }

  // ---- checks --------------------------------------------------------------------------------------------------

  private async exists(tx: TenantTx, projectId: string, componentId: string | null): Promise<boolean> {
    const rows = await tx.query<{ found: boolean }>(
      'select exists (select 1 from machvon.permit_dossier where project_id = $1::uuid and project_component_id is not distinct from $2::uuid) as found',
      [projectId, componentId],
    );
    return rows[0]?.found === true;
  }

  private async assertComponent(tx: TenantTx, projectId: string, componentId: string): Promise<void> {
    const rows = await tx.query<{ found: boolean }>('select exists (select 1 from machvon.project_component where id = $1::uuid and project_id = $2::uuid) as found', [componentId, projectId]);
    if (rows[0]?.found !== true) throw invalid('project_component_id');
  }

  private async assertUnit(tx: TenantTx, unitId: string, asOf: string): Promise<void> {
    const rows = await tx.query<{ found: boolean }>(
      'select exists (select 1 from machvon.organization_unit where id = $1::uuid and valid_from <= $2::date and (valid_until is null or valid_until >= $2::date)) as found',
      [unitId, asOf],
    );
    if (rows[0]?.found !== true) throw invalid('owner_unit_id');
  }

  /** A member of the tenant who is active now: the person in charge of a dossier or of a permit. */
  async assertMember(tx: TenantTx, membershipId: string, field: string): Promise<void> {
    const rows = await tx.query<{ found: boolean }>(
      "select exists (select 1 from machvon.membership where id = $1::uuid and status = 'Active' and (valid_until is null or valid_until > now())) as found",
      [membershipId],
    );
    if (rows[0]?.found !== true) throw invalid(field);
  }

  private async typesInForce(
    tx: TenantTx,
    asOf: string,
  ): Promise<Array<{ id: string; code: string; revision: number; authority_text: string; cxn_ref: string | null; applies_to_rule: Record<string, unknown> }>> {
    return tx.query(
      `select id, code, revision, authority_text, cxn_ref, applies_to_rule from machvon.permit_type
        where status <> 'DRAFT' and effective_from <= $1::date and (effective_until is null or effective_until >= $1::date) order by code`,
      [asOf],
    );
  }
}

const placeOf = (row: PlaceSql): DossierPlace => ({
  dossierId: row.dossier_id,
  projectId: row.project_id,
  projectCode: row.project_code,
  ownerUnit: { id: row.owner_unit_id, path: row.owner_unit_path },
  investorUnit: unitOf(row.investor_unit_id, row.investor_unit_path),
  dossierUnit: { id: row.dossier_unit_id, path: row.dossier_unit_path },
});
