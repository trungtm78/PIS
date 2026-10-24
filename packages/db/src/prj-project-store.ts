import { randomUUID } from 'node:crypto';
import { DomainError, activeGrants, permissionMatches, versionConflict } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { MasterRules } from './master-rules.ts';
import { scopePredicate } from './scope-version.ts';
import type { ScopeBuilder, ScopePredicate } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const UNIQUE_VIOLATION = '23505';
const CODE_CONSTRAINT = 'project_code_uq';
const MIN_NAME = 3;
const MAX_NAME = 500;
const MAX_CODE = 50;
const MIN_YEAR = 1990;
const MAX_YEAR = 2100;
const MAX_MONEY_DIGITS = 24;
const MONEY = /^(0|[1-9][0-9]*)(\.0+)?$/;
const INITIAL_REVISION_REASON = 'INITIAL_REGISTRATION';
const AREA_TYPES: readonly string[] = ['ADMIN_UNIT', 'AREA'];

export const PROJECT_STATUSES = ['CONCEPT', 'APPRAISAL', 'PIPELINE', 'BUDGETED', 'IMPLEMENTATION', 'SUSPENDED', 'COMPLETED', 'SETTLED', 'CLOSED', 'REJECTED', 'CANCELLED'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export type ProjectClassification = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL';
const CLASSIFICATIONS: readonly string[] = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL'];

/** The stages in which a project no longer changes at all: it is closed, rejected or cancelled. */
const FROZEN_STAGES: ReadonlySet<string> = new Set(['CLOSED', 'REJECTED', 'CANCELLED']);

/** The columns the list and the detail join over: `p` the project, `ou` its owner unit, `iu` its investor unit. */
export const PROJECT_OWNER_COLUMNS = { unitPath: 'ou.path', unitId: 'ou.id' } as const;
export const PROJECT_INVESTOR_COLUMNS = { unitPath: 'iu.path', unitId: 'iu.id' } as const;

export interface ProjectLeader {
  membershipId: string;
  displayName: string;
}

/** One line of the register: what the list shows, and the base of the detail. */
export interface ProjectListRow {
  id: string;
  code: string;
  name: string;
  ownerUnitId: string;
  ownerUnitName: string;
  investorUnitId: string | null;
  investorUnitName: string | null;
  projectGroup: string | null;
  status: ProjectStatus;
  nationalProjectCode: string | null;
  leader: ProjectLeader | null;
  version: number;
  /** Ordering key of the list and its cursor. */
  codeKey: string;
}

/** An entry of master data that a project refers to by the version that was in force when it was chosen. */
export interface MasterLabel {
  versionId: string;
  businessKey: string;
  label: string;
}

export interface ProjectDetail extends ProjectListRow {
  decisionAuthorityUnitId: string | null;
  decisionAuthorityUnitName: string | null;
  area: MasterLabel;
  sector: MasterLabel | null;
  projectType: MasterLabel | null;
  program: MasterLabel | null;
  classification: ProjectClassification;
  /** An exact decimal string in VND. */
  totalInvestmentVnd: string;
  startYear: number | null;
  endYear: number | null;
  appraisalScore: string | null;
  pipelinePriority: number | null;
  statusChangedAt: string;
  createdAt: string;
  /** The Vietnam calendar date the project was proposed on: the date the rule data is read for. */
  proposedOn: string;
}

/** The group the rule data suggests for a project, with the rule version it came from (BR-PRJ-05). */
export interface GroupSuggestion {
  groupKey: string;
  sectorKey: string | null;
  asOf: string;
  ruleVersionId: string;
  ruleRevision: number;
  legalBasis: string;
  awaitingConfirmation: boolean;
  cxn: string | null;
}

export interface NewProject {
  code: string;
  name: string;
  ownerUnitId: string;
  investorUnitId?: string | undefined;
  decisionAuthorityUnitId?: string | undefined;
  areaMasterVersionId: string;
  sectorMasterVersionId?: string | undefined;
  projectTypeMasterVersionId?: string | undefined;
  programMasterVersionId?: string | undefined;
  totalInvestmentVnd: string;
  startYear?: number | undefined;
  endYear?: number | undefined;
  classification?: ProjectClassification | undefined;
}

/** The allowlist of a profile update: no code, no status, no tenant, no money, no rights (BR-PRJ-13). */
export interface ProfileChange {
  name?: string | undefined;
  investorUnitId?: string | undefined;
  areaMasterVersionId?: string | undefined;
  sectorMasterVersionId?: string | undefined;
  projectTypeMasterVersionId?: string | undefined;
  programMasterVersionId?: string | undefined;
  startYear?: number | undefined;
  endYear?: number | undefined;
  classification?: ProjectClassification | undefined;
}

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface CreatedProject {
  id: string;
  /** The code as stored (trimmed): what the audit trail and the event of the command carry. */
  code: string;
  version: number;
  status: 'CONCEPT';
  classification: ProjectClassification;
  groupSuggestion: GroupSuggestion | null;
}

export interface ProfileUpdate {
  version: number;
  status: ProjectStatus;
  classification: ProjectClassification;
  changes: FieldChange[];
}

/** The scopes a profile update is judged by: the one of `project.update` decides, the one of `project.read` tells a refusal from a miss. */
export interface UpdateScopes {
  update: ScopeBuilder;
  read: ScopeBuilder;
}

interface ListSql {
  id: string;
  code: string;
  name: string;
  owner_unit_id: string;
  owner_unit_name: string;
  investor_unit_id: string | null;
  investor_unit_name: string | null;
  project_group: string | null;
  status: ProjectStatus;
  national_project_code: string | null;
  leader_membership_id: string | null;
  leader_name: string | null;
  version: string;
}

interface DetailSql extends ListSql {
  decision_authority_unit_id: string | null;
  decision_authority_unit_name: string | null;
  area_master_version_id: string;
  sector_master_version_id: string | null;
  project_type_master_version_id: string | null;
  program_master_version_id: string | null;
  classification: ProjectClassification;
  total_investment_vnd: string;
  start_year: number | null;
  end_year: number | null;
  appraisal_score: string | null;
  pipeline_priority: number | null;
  status_changed_at: string;
  created_at: string;
  proposed_on: string;
}

/** The project with the two units its scope is judged by. */
const SCOPE_FROM = `machvon.project p
  join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
  left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id`;

const LIST_FROM = `from ${SCOPE_FROM}
  left join machvon.project_accountability lead on lead.tenant_id = p.tenant_id and lead.project_id = p.id
    and lead.accountability_role = 'LEADER_IN_CHARGE' and lead.status = 'ACTIVE'
  left join machvon.tenant_user_directory lu on lu.tenant_id = p.tenant_id and lu.membership_id = lead.leader_membership_id`;

const LIST_COLUMNS = `p.id, p.code, p.name, p.owner_unit_id, ou.name as owner_unit_name, p.investor_unit_id, iu.name as investor_unit_name,
  p.project_group, p.status, p.national_project_code, lead.leader_membership_id, lu.display_name as leader_name, p.version::text as version`;

const DETAIL_COLUMNS = `${LIST_COLUMNS}, p.decision_authority_unit_id, du.name as decision_authority_unit_name, p.area_master_version_id, p.sector_master_version_id,
  p.project_type_master_version_id, p.program_master_version_id, p.classification, p.total_investment_vnd::text as total_investment_vnd,
  p.start_year, p.end_year, p.appraisal_score::text as appraisal_score, p.pipeline_priority,
  to_char(p.status_changed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as status_changed_at,
  to_char(p.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at,
  ((p.created_at at time zone 'Asia/Ho_Chi_Minh')::date)::text as proposed_on`;
const DETAIL_FROM = `${LIST_FROM}
  left join machvon.organization_unit du on du.tenant_id = p.tenant_id and du.id = p.decision_authority_unit_id`;

const toListRow = (row: ListSql): ProjectListRow => ({
  id: row.id,
  code: row.code,
  name: row.name,
  ownerUnitId: row.owner_unit_id,
  ownerUnitName: row.owner_unit_name,
  investorUnitId: row.investor_unit_id,
  investorUnitName: row.investor_unit_name,
  projectGroup: row.project_group,
  status: row.status,
  nationalProjectCode: row.national_project_code,
  leader: row.leader_membership_id === null || row.leader_name === null ? null : { membershipId: row.leader_membership_id, displayName: row.leader_name },
  version: Number(row.version),
  codeKey: row.code,
});

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** A name or a code as it is stored: trimmed, within its length, without control characters. */
function textOf(value: string, field: string, min: number, max: number): string {
  const text = value.trim();
  // eslint-disable-next-line no-control-regex
  if (text.length < min || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) throw invalid(field);
  return text;
}

/** The amount as the whole VND it is stored as: `1000` and `1000.00` are the same amount, `1000.5` is not an amount of dong. */
export function wholeVnd(value: string): string {
  const matched = MONEY.exec(value);
  const whole = matched?.[1];
  if (whole === undefined || whole.length > MAX_MONEY_DIGITS) throw invalid('total_investment_vnd');
  return whole;
}

function yearOf(value: number, field: string): number {
  if (!Number.isInteger(value) || value < MIN_YEAR || value > MAX_YEAR) throw invalid(field);
  return value;
}

function classificationOf(value: string): ProjectClassification {
  if (!CLASSIFICATIONS.includes(value)) throw invalid('classification');
  return value as ProjectClassification;
}

interface ProfileField {
  /** The name the contract and the problem details use. */
  field: string;
  column: string;
  /** Past the stage CONCEPT only a revision decided by the authority changes the field (PRJ 3.1 F6, kinds ADJUST_*). */
  governed: boolean;
  read(change: ProfileChange): unknown;
}

/** What a profile update may touch; every other column of the project has a command of its own or none. */
const PROFILE_FIELDS: readonly ProfileField[] = [
  { field: 'name', column: 'name', governed: false, read: (change) => change.name },
  { field: 'classification', column: 'classification', governed: false, read: (change) => change.classification },
  { field: 'investor_unit_id', column: 'investor_unit_id', governed: true, read: (change) => change.investorUnitId },
  { field: 'area_master_version_id', column: 'area_master_version_id', governed: true, read: (change) => change.areaMasterVersionId },
  { field: 'sector_master_version_id', column: 'sector_master_version_id', governed: true, read: (change) => change.sectorMasterVersionId },
  { field: 'project_type_master_version_id', column: 'project_type_master_version_id', governed: true, read: (change) => change.projectTypeMasterVersionId },
  { field: 'program_master_version_id', column: 'program_master_version_id', governed: true, read: (change) => change.programMasterVersionId },
  { field: 'start_year', column: 'start_year', governed: true, read: (change) => change.startYear },
  { field: 'end_year', column: 'end_year', governed: true, read: (change) => change.endYear },
];

const MASTER_TYPES: Readonly<Record<string, readonly string[]>> = {
  area_master_version_id: AREA_TYPES,
  sector_master_version_id: ['SECTOR'],
  project_type_master_version_id: ['PROJECT_TYPE'],
  program_master_version_id: ['PROGRAM'],
};

/**
 * A scope builder for a permission: the project is in scope when the owner unit or the investor unit lies in a scope of a grant that
 * carries the permission, or the grant names the project itself. Compiled over `PROJECT_OWNER_COLUMNS` and `PROJECT_INVESTOR_COLUMNS`
 * (the aliases `ou`, `iu` and `p` of the register queries). The parameters are numbered from `first`.
 */
export function projectScope(access: EffectiveAccess, permission: string, now: Date): ScopeBuilder {
  return (first: number): ScopePredicate => {
    const owner = scopePredicate(access, permission, now, PROJECT_OWNER_COLUMNS, first);
    if (owner.sql === 'true') return owner;
    const investor = scopePredicate(access, permission, now, PROJECT_INVESTOR_COLUMNS, first + owner.params.length);
    const projectIds = new Set<string>();
    for (const grant of activeGrants(access, now)) {
      if (grant.scope.kind === 'PROJECT' && grant.permissions.some((held) => permissionMatches(held, permission))) for (const id of grant.scope.refIds) projectIds.add(id);
    }
    const params = [...owner.params, ...investor.params];
    const alternatives = [owner.sql, investor.sql];
    if (projectIds.size > 0) {
      params.push([...projectIds].sort());
      alternatives.push(`p.id = any($${first + params.length - 1}::uuid[])`);
    }
    return { sql: `(${alternatives.join(' or ')})`, params };
  };
}

/**
 * The project register (ST-PRJ-001, PRJ 3.1 F1): a project is created in CONCEPT with its first revision, its profile is kept within an
 * allowlist, and it is read in the scope of the caller. Status, code, tenant, rights and money are not written here: each has a command
 * of its own (BR-PRJ-13). The rule data is read through the port of MDM, by the date the project was proposed on.
 */
export class PrjProjectStore {
  private readonly rules: MasterRules;

  constructor(rules: MasterRules = new MasterRules()) {
    this.rules = rules;
  }

  /** The register in the scope of the caller, ordered by internal code; the cursor is the code and the id of the last line. */
  async list(tx: TenantTx, scope: ScopeBuilder, request: { limit: number; after: { code: string; id: string } | undefined }): Promise<ProjectListRow[]> {
    const predicate = scope(4);
    const rows = await tx.query<ListSql>(
      `select ${LIST_COLUMNS} ${LIST_FROM}
        where ($1::text is null or (p.code, p.id) > ($1::text, $2::uuid)) and ${predicate.sql}
        order by p.code, p.id limit $3`,
      [request.after?.code ?? null, request.after?.id ?? null, request.limit, ...predicate.params],
    );
    return rows.map(toListRow);
  }

  /** One project in the scope of the caller, with everything the workspace shows; undefined when it does not exist or lies outside the scope. */
  async find(tx: TenantTx, id: string, scope: ScopeBuilder): Promise<ProjectDetail | undefined> {
    const predicate = scope(2);
    const rows = await tx.query<DetailSql>(`select ${DETAIL_COLUMNS} ${DETAIL_FROM} where p.id = $1::uuid and ${predicate.sql}`, [id, ...predicate.params]);
    const row = rows[0];
    if (row === undefined) return undefined;
    const labels = await this.labelsOf(tx, [row.area_master_version_id, row.sector_master_version_id, row.project_type_master_version_id, row.program_master_version_id]);
    const label = (versionId: string | null): MasterLabel | null => (versionId === null ? null : (labels.get(versionId) ?? null));
    const area = label(row.area_master_version_id);
    if (area === null) throw new Error('a project refers to a master version that cannot be read');
    return {
      ...toListRow(row),
      decisionAuthorityUnitId: row.decision_authority_unit_id,
      decisionAuthorityUnitName: row.decision_authority_unit_name,
      area,
      sector: label(row.sector_master_version_id),
      projectType: label(row.project_type_master_version_id),
      program: label(row.program_master_version_id),
      classification: row.classification,
      totalInvestmentVnd: row.total_investment_vnd,
      startYear: row.start_year,
      endYear: row.end_year,
      appraisalScore: row.appraisal_score,
      pipelinePriority: row.pipeline_priority,
      statusChangedAt: row.status_changed_at,
      createdAt: row.created_at,
      proposedOn: row.proposed_on,
    };
  }

  /** The organisation unit with the path its scope is judged by; undefined when it does not exist in the tenant. */
  async unitRef(tx: TenantTx, unitId: string): Promise<{ id: string; path: string } | undefined> {
    const rows = await tx.query<{ id: string; path: string }>('select id, path from machvon.organization_unit where id = $1::uuid', [unitId]);
    return rows[0];
  }

  /** How many projects of the tenant that are still open have no national project code (the figure the telemetry gauge reports). */
  async countMissingNationalCode(tx: TenantTx): Promise<number> {
    const rows = await tx.query<{ n: string }>(
      `select count(*)::text as n from machvon.project where national_project_code is null and status not in ('CLOSED', 'REJECTED', 'CANCELLED')`,
    );
    return Number(rows[0]?.n ?? 0);
  }

  /** The group the rule data in force on `asOf` gives a project of this sector and size; null when no rule or no band applies. */
  async suggestGroup(tx: TenantTx, sector: MasterLabel | null, totalInvestmentVnd: string, asOf: string): Promise<GroupSuggestion | null> {
    const suggested = await this.rules.suggestGroup(tx, { sectorKey: sector?.businessKey, totalInvestmentVnd }, asOf);
    if (suggested === undefined) return null;
    const { reading } = suggested;
    return {
      groupKey: suggested.groupKey,
      sectorKey: suggested.sectorKey,
      asOf,
      ruleVersionId: reading.versionId,
      ruleRevision: reading.revision,
      legalBasis: reading.legalBasis,
      awaitingConfirmation: reading.awaitingConfirmation,
      cxn: reading.cxn,
    };
  }

  /**
   * Creates a project in CONCEPT at version 1 with its first revision r1 INITIAL, which keeps the dossier as it was proposed and the group
   * the rule data suggested that day. The master data it names must be in force today; a second project with the same code is refused.
   */
  async create(tx: TenantTx, input: NewProject, actor: string, today: string): Promise<CreatedProject> {
    const code = textOf(input.code, 'code', 1, MAX_CODE);
    const name = textOf(input.name, 'name', MIN_NAME, MAX_NAME);
    const total = wholeVnd(input.totalInvestmentVnd);
    const classification = input.classification === undefined ? 'INTERNAL' : classificationOf(input.classification);
    const startYear = input.startYear === undefined ? undefined : yearOf(input.startYear, 'start_year');
    const endYear = input.endYear === undefined ? undefined : yearOf(input.endYear, 'end_year');
    if (startYear !== undefined && endYear !== undefined && startYear > endYear) throw invalid('end_year');
    await this.assertUnit(tx, input.ownerUnitId, 'owner_unit_id');
    if (input.investorUnitId !== undefined) await this.assertUnit(tx, input.investorUnitId, 'investor_unit_id');
    if (input.decisionAuthorityUnitId !== undefined) await this.assertUnit(tx, input.decisionAuthorityUnitId, 'decision_authority_unit_id');
    const versions = [
      ['area_master_version_id', input.areaMasterVersionId],
      ['sector_master_version_id', input.sectorMasterVersionId],
      ['project_type_master_version_id', input.projectTypeMasterVersionId],
      ['program_master_version_id', input.programMasterVersionId],
    ] as const;
    const chosen = new Map<string, MasterLabel>();
    for (const [field, versionId] of versions) {
      if (versionId !== undefined) chosen.set(field, await this.assertMasterInForce(tx, field, versionId, today));
    }
    const suggestion = await this.suggestGroup(tx, chosen.get('sector_master_version_id') ?? null, total, today);
    const id = randomUUID();
    try {
      await tx.query(
        `insert into machvon.project
           (tenant_id, id, code, name, owner_unit_id, investor_unit_id, decision_authority_unit_id, area_master_version_id, sector_master_version_id,
            project_type_master_version_id, program_master_version_id, classification, total_investment_vnd, status, version, start_year, end_year,
            status_changed_at, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::uuid, $9::uuid, $10::uuid,
            $11, $12::numeric, 'CONCEPT', 1, $13::integer, $14::integer, now(), $15::uuid, $15::uuid)`,
        [
          id,
          code,
          name,
          input.ownerUnitId,
          input.investorUnitId ?? null,
          input.decisionAuthorityUnitId ?? null,
          input.areaMasterVersionId,
          input.sectorMasterVersionId ?? null,
          input.projectTypeMasterVersionId ?? null,
          input.programMasterVersionId ?? null,
          classification,
          total,
          startYear ?? null,
          endYear ?? null,
          actor,
        ],
      );
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      if (failure.code === UNIQUE_VIOLATION && failure.constraint === CODE_CONSTRAINT) throw new DomainError('PROJECT_CODE_DUPLICATE', 409);
      throw error;
    }
    const dossier = {
      code,
      name,
      owner_unit_id: input.ownerUnitId.toLowerCase(),
      investor_unit_id: input.investorUnitId?.toLowerCase() ?? null,
      decision_authority_unit_id: input.decisionAuthorityUnitId?.toLowerCase() ?? null,
      area_master_version_id: input.areaMasterVersionId.toLowerCase(),
      sector_master_version_id: input.sectorMasterVersionId?.toLowerCase() ?? null,
      project_type_master_version_id: input.projectTypeMasterVersionId?.toLowerCase() ?? null,
      program_master_version_id: input.programMasterVersionId?.toLowerCase() ?? null,
      classification,
      total_investment_vnd: total,
      start_year: startYear ?? null,
      end_year: endYear ?? null,
      group_suggestion: suggestion === null ? null : { group_key: suggestion.groupKey, rule_version_id: suggestion.ruleVersionId, rule_revision: suggestion.ruleRevision, as_of: suggestion.asOf },
    };
    // The first revision is a draft: the decision that admits the dossier approves it (a revision is approved by a decision document).
    await tx.query(
      `insert into machvon.project_revision
         (tenant_id, id, project_id, revision, change_kind, before_json, after_json, total_investment_vnd, reason, status, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, 1, 'INITIAL', '{}'::jsonb, $3::jsonb, $4::numeric, $5, 'DRAFT', $6::uuid, $6::uuid)`,
      [randomUUID(), id, JSON.stringify(dossier), total, INITIAL_REVISION_REASON, actor],
    );
    return { id, code, version: 1, status: 'CONCEPT', classification, groupSuggestion: suggestion };
  }

  /**
   * Changes the descriptive fields of a project. The project must lie in the scope of `project.update`; one that the caller can read but
   * not update is 403, one that is out of sight is 404. The version must be the current one; a closed, rejected or cancelled project
   * takes no change, and the fields that belong to the dossier under appraisal change only while the project is a concept. A change
   * that changes nothing writes nothing.
   */
  async updateProfile(tx: TenantTx, id: string, expectedVersion: number, change: ProfileChange, actor: string, scopes: UpdateScopes, today: string): Promise<ProfileUpdate> {
    const locked = await this.lock(tx, id, scopes);
    if (locked.version !== expectedVersion) throw versionConflict(locked.version);
    const asked = PROFILE_FIELDS.filter((profile) => profile.read(change) !== undefined);
    if (asked.length === 0) throw invalid('body');
    if (FROZEN_STAGES.has(locked.status)) throw new DomainError('STAGE_LOCKED_FIELD', 422, asked[0]?.field);
    const governed = asked.find((profile) => profile.governed && locked.status !== 'CONCEPT');
    if (governed !== undefined) throw new DomainError('STAGE_LOCKED_FIELD', 422, governed.field);
    const current = locked.values;
    const changes: FieldChange[] = [];
    const assignments: string[] = [];
    const params: unknown[] = [id];
    for (const profile of asked) {
      const next = await this.checkedValue(tx, profile, change, today);
      const before = current[profile.field] ?? null;
      if (before === next) continue;
      changes.push({ field: profile.field, before, after: next });
      params.push(next);
      assignments.push(`${profile.column} = $${params.length}${profile.field.endsWith('_id') ? '::uuid' : ''}`);
    }
    const years = {
      start: changes.find((entry) => entry.field === 'start_year')?.after ?? current.start_year,
      end: changes.find((entry) => entry.field === 'end_year')?.after ?? current.end_year,
    };
    if (typeof years.start === 'number' && typeof years.end === 'number' && years.start > years.end) throw invalid(changes.some((entry) => entry.field === 'end_year') ? 'end_year' : 'start_year');
    const classification = (changes.find((entry) => entry.field === 'classification')?.after ?? current.classification) as ProjectClassification;
    if (changes.length === 0) return { version: locked.version, status: locked.status, classification, changes };
    params.push(actor);
    await tx.query(`update machvon.project set ${assignments.join(', ')}, updated_at = now(), updated_by = $${params.length}::uuid, version = version + 1 where id = $1::uuid`, params);
    return { version: locked.version + 1, status: locked.status, classification, changes };
  }

  /** Locks the project for update inside the scope of the caller; a project the caller can read but not update is a refusal, not a miss. */
  private async lock(tx: TenantTx, id: string, scopes: UpdateScopes): Promise<{ version: number; status: ProjectStatus; values: Record<string, unknown> }> {
    const predicate = scopes.update(2);
    const rows = await tx.query<{ version: string; status: ProjectStatus; name: string; classification: string; investor_unit_id: string | null; start_year: number | null; end_year: number | null; area_master_version_id: string; sector_master_version_id: string | null; project_type_master_version_id: string | null; program_master_version_id: string | null }>(
      `select p.version::text as version, p.status, p.name, p.classification, p.investor_unit_id, p.start_year, p.end_year, p.area_master_version_id,
              p.sector_master_version_id, p.project_type_master_version_id, p.program_master_version_id
         from ${SCOPE_FROM}
        where p.id = $1::uuid and ${predicate.sql}
        for update of p`,
      [id, ...predicate.params],
    );
    const row = rows[0];
    if (row === undefined) {
      const readable = scopes.read(2);
      const seen = await tx.query<{ id: string }>(
        `select p.id from ${SCOPE_FROM} where p.id = $1::uuid and ${readable.sql}`,
        [id, ...readable.params],
      );
      throw seen[0] === undefined ? new DomainError('RESOURCE_NOT_FOUND', 404) : new DomainError('SCOPE_DENIED', 403);
    }
    return { version: Number(row.version), status: row.status, values: row };
  }

  /** The value to store for one asked field, after the rules of the field; a master version must be in force today. */
  private async checkedValue(tx: TenantTx, profile: ProfileField, change: ProfileChange, today: string): Promise<unknown> {
    const asked = profile.read(change);
    switch (profile.field) {
      case 'name':
        return textOf(asked as string, 'name', MIN_NAME, MAX_NAME);
      case 'classification':
        return classificationOf(asked as string);
      case 'investor_unit_id':
        await this.assertUnit(tx, asked as string, profile.field);
        // An identifier is compared with the one stored as the lower-case text the database writes: a uuid in capitals is the same uuid.
        return (asked as string).toLowerCase();
      case 'start_year':
      case 'end_year':
        return yearOf(asked as number, profile.field);
      default:
        await this.assertMasterInForce(tx, profile.field, asked as string, today);
        return (asked as string).toLowerCase();
    }
  }

  private async assertUnit(tx: TenantTx, unitId: string, field: string): Promise<void> {
    const rows = await tx.query<{ status: string }>('select status from machvon.organization_unit where id = $1::uuid', [unitId]);
    // A unit of another tenant is indistinguishable from one that does not exist; a unit that is not active cannot own a project.
    if (rows[0] === undefined || rows[0].status !== 'Active') throw invalid(field);
  }

  /**
   * The entry a version belongs to, when the version is published, in force on `today`, of the type that the field takes and not retired or
   * merged away. A version that does not exist or is of another type is a fault of the request; one that is no longer in force is MASTER_NOT_EFFECTIVE.
   */
  private async assertMasterInForce(tx: TenantTx, field: string, versionId: string, today: string): Promise<MasterLabel> {
    const rows = await tx.query<{ master_type: string; business_key: string; label: string; record_status: string; status: string; published: boolean; in_range: boolean }>(
      `select r.master_type, r.business_key, v.label, r.status as record_status, v.status, (v.published_at is not null) as published,
              (v.valid_from <= $2::date and (v.valid_until is null or v.valid_until > $2::date)) as in_range
         from machvon.master_record_version v join machvon.master_record r on r.id = v.master_record_id
        where v.id = $1::uuid`,
      [versionId, today],
    );
    const row = rows[0];
    if (row === undefined || !(MASTER_TYPES[field] ?? []).includes(row.master_type)) throw invalid(field);
    const inForce = row.published && row.in_range && ['APPROVED', 'EFFECTIVE'].includes(row.status) && !['RETIRED', 'MERGED'].includes(row.record_status);
    if (!inForce) throw new DomainError('MASTER_NOT_EFFECTIVE', 422, field);
    return { versionId, businessKey: row.business_key, label: row.label };
  }

  private async labelsOf(tx: TenantTx, versionIds: ReadonlyArray<string | null>): Promise<Map<string, MasterLabel>> {
    const ids = versionIds.filter((versionId): versionId is string => versionId !== null);
    const labels = new Map<string, MasterLabel>();
    if (ids.length === 0) return labels;
    const rows = await tx.query<{ id: string; business_key: string; label: string }>(
      'select v.id, r.business_key, v.label from machvon.master_record_version v join machvon.master_record r on r.id = v.master_record_id where v.id = any($1::uuid[])',
      [ids],
    );
    for (const row of rows) labels.set(row.id, { versionId: row.id, businessKey: row.business_key, label: row.label });
    return labels;
  }
}
