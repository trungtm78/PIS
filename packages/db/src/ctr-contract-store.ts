import { randomUUID } from 'node:crypto';
import { CONTRACT_STATUSES, DomainError, assertContractTransition, activeGrants, addDecimal, compareDecimal, permissionMatches, versionConflict } from '@machvon/kernel';
import type { ContractStatus, EffectiveAccess } from '@machvon/kernel';
import { BidContractorStore } from './bid-contractor-store.ts';
import { CtrContractSource } from './ctr-contract-source.ts';
import { projectScope } from './prj-project-store.ts';
import type { ScopeBuilder, ScopePredicate } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const UNIQUE_VIOLATION = '23505';
const CODE_CONSTRAINT = 'contract_code_uq';
const MAX_CODE = 50;
const MAX_TITLE = 500;
const MAX_REASON = 2000;
const MAX_MONEY_DIGITS = 24;
const MONEY = /^[0-9]+$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CANCEL_COMMAND = 'cancelContractDraft';

// The statuses and the edges between them live in the kernel (contract-lifecycle.ts); the register re-exports them for the readers that already import them from here.
export { CONTRACT_STATUSES };
export type { ContractStatus };
export const CONTRACT_TYPES = ['LUMP_SUM', 'UNIT_PRICE', 'ADJUSTABLE_PRICE', 'TIME_BASED', 'COST_PLUS_FEE', 'EPC', 'ESTIMATE_BASED'] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];
export const ADVANCE_CATEGORIES = ['CONSTRUCTION', 'EQUIPMENT', 'CONSULTING', 'EPC', 'LAND_CLEARANCE', 'OTHER'] as const;
export type AdvanceCategory = (typeof ADVANCE_CATEGORIES)[number];

/** Where a contract lies, so the permissions of a caller can be judged for it: its project, and the units that own and invest in the project. */
export interface ContractPlace {
  contractId: string;
  projectId: string;
  ownerUnit: { id: string; path: string };
  investorUnit: { id: string; path: string } | null;
}

/** One line of the register: what the list shows, and the base of the detail. */
export interface ContractLine {
  id: string;
  code: string;
  title: string | null;
  status: ContractStatus;
  type: ContractType;
  projectId: string;
  projectCode: string;
  projectName: string;
  packageId: string;
  contractorId: string;
  contractorName: string | null;
  ownerUnitId: string;
  isJointVenture: boolean;
  /** Exact decimal strings in VND. */
  contractValueVnd: string;
  estimateCeilingVnd: string | null;
  completionDue: string | null;
  version: number;
  reach: ContractPlace;
}

/** The totals the ledger keeps on the contract (exact decimal strings in VND); only the commands of the ledger write them. */
export interface ContractLedger {
  acceptedTotalVnd: string;
  requestedTotalVnd: string;
  paidTotalVnd: string;
  advancePaidVnd: string;
  advanceRecoveredVnd: string;
  advanceOutstandingVnd: string;
  retentionHeldVnd: string;
  retentionReleasedVnd: string;
}

export interface RevisionRow {
  id: string;
  contractId: string;
  contractCode: string;
  revision: number;
  kind: string;
  status: string;
  amountVnd: string;
  documentVersionId: string;
  validFrom: string;
  validUntil: string | null;
  retroactive: boolean;
  decidedAt: string | null;
  version: number;
  createdAt: string;
  /** What the lines of the BOQ add up to (an exact decimal string in VND) and how many there are: the screens compare it with `amountVnd` (BR-CTR-02). */
  boqTotalVnd: string;
  boqLineCount: number;
  /** The revision this one follows, and the change order that made it (a revision of kind CHANGE_ORDER); null for the first revision. */
  supersedesId: string | null;
  changeRequest: { id: string; code: string | null } | null;
  reach: ContractPlace;
}

export interface PartyRow {
  id: string;
  contractorId: string;
  contractorName: string | null;
  role: 'SOLE' | 'LEAD' | 'MEMBER';
  /** An exact decimal string with four digits after the point. */
  sharePct: string;
  workValueVnd: string;
  validFrom: string;
  validUntil: string | null;
  version: number;
}

/** What the members of a joint venture add up to against what the contract needs (BR-CTR-08). */
export interface PartiesCheck {
  shareTotal: string;
  workValueTotal: string;
  sharesComplete: boolean;
  workMatchesValue: boolean;
}

export interface StatusChangeRow {
  id: string;
  fromStatus: string;
  toStatus: string;
  reason: string;
  effectiveOn: string;
  command: string;
  createdAt: string;
  createdBy: string;
}

export interface ContractDetail extends ContractLine {
  advanceCategory: AdvanceCategory;
  requiresQualityAcceptance: boolean;
  signedOn: string | null;
  effectiveFrom: string | null;
  statusReason: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  /** Who sent the contract to review, who signed it and activated it, on which document and under which decision about a conflict (ST-CTR-004). */
  submittedBy: string | null;
  signedBy: string | null;
  signedDocumentVersionId: string | null;
  conflictDecisionRef: string | null;
  activatedBy: string | null;
  ledger: ContractLedger;
  revisions: RevisionRow[];
  parties: PartyRow[];
  partiesCheck: PartiesCheck;
  statusChanges: StatusChangeRow[];
}

export interface NewContract {
  projectId: string;
  packageId: string;
  contractorId: string;
  code: string;
  title: string;
  type: ContractType;
  advanceCategory: AdvanceCategory;
  isJointVenture?: boolean | undefined;
  requiresQualityAcceptance?: boolean | undefined;
  contractValueVnd: string;
  estimateCeilingVnd?: string | undefined;
  completionDue?: string | undefined;
  documentVersionId: string;
}

/** The allowlist of a draft revision: no code, no status, no tenant, no project, no contractor, no ledger total (CTR section 7). */
export interface DraftChange {
  title?: string | undefined;
  completionDue?: string | undefined;
  contractValueVnd?: string | undefined;
  estimateCeilingVnd?: string | undefined;
  requiresQualityAcceptance?: boolean | undefined;
  documentVersionId?: string | undefined;
}

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface CreatedContract {
  id: string;
  revisionId: string;
  version: number;
  status: 'DRAFT';
  /** The code as stored (trimmed) and the value as stored (whole VND without leading zeros): what the audit trail and the event of the command carry. */
  code: string;
  contractValueVnd: string;
  estimateCeilingVnd: string;
}

export interface DraftUpdate {
  version: number;
  status: ContractStatus;
  changes: FieldChange[];
}

export interface Cancelled {
  version: number;
  status: 'CANCELLED';
  fromStatus: ContractStatus;
}

/** The scopes a command on a draft is judged by: the one of `contract.update` decides, the one of `contract.read` tells a refusal from a miss. */
export interface ContractScopes {
  update: ScopeBuilder;
  read: ScopeBuilder;
}

/** A contract held for update inside the scope of the caller. */
export interface LockedContract {
  id: string;
  version: number;
  status: ContractStatus;
  projectId: string;
  packageId: string;
  contractorId: string;
  isJointVenture: boolean;
  contractValueVnd: string;
  estimateCeilingVnd: string | null;
  title: string | null;
  completionDue: string | null;
  requiresQualityAcceptance: boolean;
}

interface LineSql {
  id: string;
  code: string;
  title: string | null;
  status: ContractStatus;
  type: ContractType;
  project_id: string;
  project_code: string;
  project_name: string;
  package_id: string;
  contractor_id: string;
  contractor_name: string | null;
  owner_unit_id: string;
  owner_unit_path: string;
  investor_unit_id: string | null;
  investor_unit_path: string | null;
  is_joint_venture: boolean;
  contract_value_vnd: string;
  estimate_ceiling_vnd: string | null;
  completion_due: string | null;
  version: string;
}

interface DetailSql extends LineSql {
  advance_category: AdvanceCategory;
  requires_quality_acceptance: boolean;
  signed_on: string | null;
  effective_from: string | null;
  status_reason: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  submitted_by: string | null;
  signed_by: string | null;
  signed_document_version_id: string | null;
  conflict_decision_ref: string | null;
  activated_by: string | null;
  accepted_total_vnd: string;
  requested_total_vnd: string;
  paid_total_vnd: string;
  advance_paid_vnd: string;
  advance_recovered_vnd: string;
  advance_outstanding_vnd: string;
  retention_held_vnd: string;
  retention_released_vnd: string;
}

interface RevisionSql {
  id: string;
  contract_id: string;
  contract_code: string;
  revision: number;
  kind: string;
  status: string;
  amount_vnd: string;
  document_version_id: string;
  valid_from: string;
  valid_until: string | null;
  retroactive: boolean;
  decided_at: string | null;
  version: string;
  created_at: string;
  boq_total_vnd: string;
  boq_line_count: number;
  supersedes_id: string | null;
  change_request_id: string | null;
  change_request_code: string | null;
  project_id: string;
  owner_unit_id: string;
  owner_unit_path: string;
  investor_unit_id: string | null;
  investor_unit_path: string | null;
}

interface PartySql {
  id: string;
  contractor_id: string;
  contractor_name: string | null;
  role: PartyRow['role'];
  share_pct: string;
  work_value_vnd: string;
  valid_from: string;
  valid_until: string | null;
  version: string;
}

export const TIMESTAMP = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** The contract with the project and the two units its scope is judged by: the aliases `c`, `p`, `ou` and `iu` are those of `projectScope`. */
export const SCOPE_FROM = `machvon.contract c
  join machvon.project p on p.tenant_id = c.tenant_id and p.id = c.project_id
  join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
  left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id`;

const LIST_FROM = `from ${SCOPE_FROM}
  left join machvon.contractor k on k.tenant_id = c.tenant_id and k.id = c.contractor_id`;

const LIST_COLUMNS = `c.id, c.code, c.title, c.status, c.type, c.project_id, p.code as project_code, p.name as project_name, c.package_id, c.contractor_id,
  k.legal_name as contractor_name, ou.id as owner_unit_id, ou.path as owner_unit_path, iu.id as investor_unit_id, iu.path as investor_unit_path,
  c.is_joint_venture, c.contract_value_vnd::text as contract_value_vnd, c.estimate_ceiling_vnd::text as estimate_ceiling_vnd,
  c.completion_due::text as completion_due, c.version::text as version`;

const DETAIL_COLUMNS = `${LIST_COLUMNS}, c.advance_category, c.requires_quality_acceptance, c.signed_on::text as signed_on, c.effective_from::text as effective_from,
  c.status_reason, ${TIMESTAMP('c.created_at')} as created_at, ${TIMESTAMP('c.updated_at')} as updated_at, c.created_by,
  c.submitted_by, c.signed_by, c.signed_document_version_id, c.conflict_decision_ref, c.activated_by,
  c.accepted_total_vnd::text as accepted_total_vnd, c.requested_total_vnd::text as requested_total_vnd, c.paid_total_vnd::text as paid_total_vnd,
  c.advance_paid_vnd::text as advance_paid_vnd, c.advance_recovered_vnd::text as advance_recovered_vnd, c.advance_outstanding_vnd::text as advance_outstanding_vnd,
  c.retention_held_vnd::text as retention_held_vnd, c.retention_released_vnd::text as retention_released_vnd`;

/** The revision with the contract it belongs to, over the same scope tables. */
const REVISION_FROM = `from machvon.contract_revision r
  join ${SCOPE_FROM} on c.tenant_id = r.tenant_id and c.id = r.contract_id`;
const REVISION_KEY = `(c.code || '#' || lpad(r.revision::text, 6, '0'))`;
const REVISION_COLUMNS = `r.id, r.contract_id, c.code as contract_code, r.revision, r.kind, r.status, r.amount_vnd::text as amount_vnd, r.document_version_id,
  r.valid_from::text as valid_from, r.valid_until::text as valid_until, r.retroactive, ${TIMESTAMP('r.decided_at')} as decided_at, r.version::text as version,
  ${TIMESTAMP('r.created_at')} as created_at, c.project_id, ou.id as owner_unit_id, ou.path as owner_unit_path, iu.id as investor_unit_id, iu.path as investor_unit_path,
  (select coalesce(sum(l.amount_vnd), 0)::text from machvon.boq_line l where l.tenant_id = r.tenant_id and l.contract_revision_id = r.id) as boq_total_vnd,
  (select count(*)::int from machvon.boq_line l where l.tenant_id = r.tenant_id and l.contract_revision_id = r.id) as boq_line_count,
  r.supersedes_id, r.change_request_id, (select q.code from machvon.change_request q where q.tenant_id = r.tenant_id and q.id = r.change_request_id) as change_request_code`;

const reachOf = (contractId: string, row: { project_id: string; owner_unit_id: string; owner_unit_path: string; investor_unit_id: string | null; investor_unit_path: string | null }): ContractPlace => ({
  contractId,
  projectId: row.project_id,
  ownerUnit: { id: row.owner_unit_id, path: row.owner_unit_path },
  investorUnit: row.investor_unit_id === null || row.investor_unit_path === null ? null : { id: row.investor_unit_id, path: row.investor_unit_path },
});

const toLine = (row: LineSql): ContractLine => ({
  id: row.id,
  code: row.code,
  title: row.title,
  status: row.status,
  type: row.type,
  projectId: row.project_id,
  projectCode: row.project_code,
  projectName: row.project_name,
  packageId: row.package_id,
  contractorId: row.contractor_id,
  contractorName: row.contractor_name,
  ownerUnitId: row.owner_unit_id,
  isJointVenture: row.is_joint_venture,
  contractValueVnd: row.contract_value_vnd,
  estimateCeilingVnd: row.estimate_ceiling_vnd,
  completionDue: row.completion_due,
  version: Number(row.version),
  reach: reachOf(row.id, row),
});

const toRevision = (row: RevisionSql): RevisionRow => ({
  id: row.id,
  contractId: row.contract_id,
  contractCode: row.contract_code,
  revision: row.revision,
  kind: row.kind,
  status: row.status,
  amountVnd: row.amount_vnd,
  documentVersionId: row.document_version_id,
  validFrom: row.valid_from,
  validUntil: row.valid_until,
  retroactive: row.retroactive,
  decidedAt: row.decided_at,
  version: Number(row.version),
  createdAt: row.created_at,
  boqTotalVnd: row.boq_total_vnd,
  boqLineCount: row.boq_line_count,
  supersedesId: row.supersedes_id,
  changeRequest: row.change_request_id === null ? null : { id: row.change_request_id, code: row.change_request_code },
  reach: reachOf(row.contract_id, row),
});

const toParty = (row: PartySql): PartyRow => ({
  id: row.id,
  contractorId: row.contractor_id,
  contractorName: row.contractor_name,
  role: row.role,
  sharePct: row.share_pct,
  workValueVnd: row.work_value_vnd,
  validFrom: row.valid_from,
  validUntil: row.valid_until,
  version: Number(row.version),
});

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** A code or a title as it is stored: trimmed, within its length, without control characters. */
export function textOf(value: string, field: string, max: number): string {
  const text = value.trim();
  // eslint-disable-next-line no-control-regex
  if (text.length < 1 || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) throw invalid(field);
  return text;
}

/** The amount as the whole VND it is stored as: leading zeros go, and an amount that is not made of digits, or is too long, is refused. */
export function wholeAmount(value: string, field: string): string {
  if (!MONEY.test(value) || value.length > MAX_MONEY_DIGITS) throw invalid(field);
  return BigInt(value).toString();
}

/** A calendar date as `YYYY-MM-DD`; a date that does not exist (the 30th of February) is refused. */
export function calendarDate(value: string, field: string): string {
  const matched = DATE.exec(value);
  const [year, month, day] = matched === null ? [] : matched.slice(1, 4).map(Number);
  const date = matched === null ? undefined : new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
  if (date === undefined || date.getUTCFullYear() !== year || date.getUTCMonth() !== (month ?? 0) - 1 || date.getUTCDate() !== day) throw invalid(field);
  return value;
}

/**
 * A scope builder for a permission over contracts: a contract is in scope when the owner unit or the investor unit of its project lies in a
 * scope of a grant that carries the permission, or the grant names the project or the contract itself (a guest contractor holds the last).
 * Compiled over the aliases `c`, `p`, `ou` and `iu` of the register queries; the parameters are numbered from the first one given.
 */
export function contractScope(access: EffectiveAccess, permission: string, now: Date): ScopeBuilder {
  const ofProject = projectScope(access, permission, now);
  return (first: number): ScopePredicate => {
    const base = ofProject(first);
    if (base.sql === 'true') return base;
    const contractIds = new Set<string>();
    for (const grant of activeGrants(access, now)) {
      if (grant.scope.kind === 'CONTRACT' && grant.permissions.some((held) => permissionMatches(held, permission))) for (const id of grant.scope.refIds) contractIds.add(id);
    }
    if (contractIds.size === 0) return base;
    const params = [...base.params, [...contractIds].sort()];
    const own = `c.id = any($${first + params.length - 1}::uuid[])`;
    return { sql: `(${base.sql} or ${own})`, params };
  };
}

/**
 * The contract register (ST-CTR-001, CTR 3.1): a contract is drafted under a package that procurement awarded, below the price of the package,
 * for a contractor that is verified, and only when the capital plan of the project is approved. The draft is revised within an allowlist and
 * cancelled; its status, code, tenant, project, contractor and ledger totals have no write path here. Money is an exact decimal string.
 */
export class CtrContractStore {
  private readonly source: CtrContractSource;
  private readonly contractors: BidContractorStore;

  constructor(source: CtrContractSource = new CtrContractSource(), contractors: BidContractorStore = new BidContractorStore()) {
    this.source = source;
    this.contractors = contractors;
  }

  // ---- reads ---------------------------------------------------------------------------------------------------

  /** The register in the scope of the caller, ordered by code; the cursor is the code and the id of the last line. */
  async list(tx: TenantTx, scope: ScopeBuilder, request: { limit: number; after: { code: string; id: string } | undefined }): Promise<ContractLine[]> {
    const predicate = scope(4);
    const rows = await tx.query<LineSql>(
      `select ${LIST_COLUMNS} ${LIST_FROM}
        where ($1::text is null or (c.code, c.id) > ($1::text, $2::uuid)) and ${predicate.sql}
        order by c.code, c.id limit $3`,
      [request.after?.code ?? null, request.after?.id ?? null, request.limit, ...predicate.params],
    );
    return rows.map(toLine);
  }

  /** One contract in the scope of the caller with everything the screens show; undefined when it does not exist or lies outside the scope. */
  async find(tx: TenantTx, id: string, scope: ScopeBuilder): Promise<ContractDetail | undefined> {
    const predicate = scope(2);
    const rows = await tx.query<DetailSql>(`select ${DETAIL_COLUMNS} ${LIST_FROM} where c.id = $1::uuid and ${predicate.sql}`, [id, ...predicate.params]);
    const row = rows[0];
    if (row === undefined) return undefined;
    const line = toLine(row);
    const revisions = await tx.query<RevisionSql>(`select ${REVISION_COLUMNS} ${REVISION_FROM} where r.contract_id = $1::uuid order by r.revision`, [id]);
    const parties = await this.partiesOf(tx, id);
    const changes = await tx.query<{ id: string; from_status: string; to_status: string; reason: string; effective_on: string; command: string; created_at: string; created_by: string }>(
      `select id, from_status, to_status, reason, effective_on::text as effective_on, command, ${TIMESTAMP('created_at')} as created_at, created_by
         from machvon.contract_status_change where contract_id = $1::uuid order by created_at, id`,
      [id],
    );
    return {
      ...line,
      advanceCategory: row.advance_category,
      requiresQualityAcceptance: row.requires_quality_acceptance,
      signedOn: row.signed_on,
      effectiveFrom: row.effective_from,
      statusReason: row.status_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createdBy: row.created_by,
      submittedBy: row.submitted_by,
      signedBy: row.signed_by,
      signedDocumentVersionId: row.signed_document_version_id,
      conflictDecisionRef: row.conflict_decision_ref,
      activatedBy: row.activated_by,
      ledger: {
        acceptedTotalVnd: row.accepted_total_vnd,
        requestedTotalVnd: row.requested_total_vnd,
        paidTotalVnd: row.paid_total_vnd,
        advancePaidVnd: row.advance_paid_vnd,
        advanceRecoveredVnd: row.advance_recovered_vnd,
        advanceOutstandingVnd: row.advance_outstanding_vnd,
        retentionHeldVnd: row.retention_held_vnd,
        retentionReleasedVnd: row.retention_released_vnd,
      },
      revisions: revisions.map(toRevision),
      parties,
      partiesCheck: partiesCheck(parties, row.contract_value_vnd),
      statusChanges: changes.map((change) => ({
        id: change.id,
        fromStatus: change.from_status,
        toStatus: change.to_status,
        reason: change.reason,
        effectiveOn: change.effective_on,
        command: change.command,
        createdAt: change.created_at,
        createdBy: change.created_by,
      })),
    };
  }

  /** The revisions of the contracts in the scope of the caller, ordered by contract code and revision number. */
  async listRevisions(tx: TenantTx, scope: ScopeBuilder, request: { limit: number; after: { code: string; id: string } | undefined }): Promise<Array<RevisionRow & { key: string }>> {
    const predicate = scope(4);
    const rows = await tx.query<RevisionSql & { key: string }>(
      `select ${REVISION_COLUMNS}, ${REVISION_KEY} as key ${REVISION_FROM}
        where ($1::text is null or (${REVISION_KEY}, r.id) > ($1::text, $2::uuid)) and ${predicate.sql}
        order by ${REVISION_KEY}, r.id limit $3`,
      [request.after?.code ?? null, request.after?.id ?? null, request.limit, ...predicate.params],
    );
    return rows.map((row) => ({ ...toRevision(row), key: row.key }));
  }

  async findRevision(tx: TenantTx, id: string, scope: ScopeBuilder): Promise<RevisionRow | undefined> {
    const predicate = scope(2);
    const rows = await tx.query<RevisionSql>(`select ${REVISION_COLUMNS} ${REVISION_FROM} where r.id = $1::uuid and ${predicate.sql}`, [id, ...predicate.params]);
    return rows[0] === undefined ? undefined : toRevision(rows[0]);
  }

  /** The active members of the contract with the contractors' names, the lead first. */
  async partiesOf(tx: TenantTx, contractId: string): Promise<PartyRow[]> {
    const rows = await tx.query<PartySql>(
      `select m.id, m.contractor_id, k.legal_name as contractor_name, m.role, m.share_pct::text as share_pct, m.work_value_vnd::text as work_value_vnd,
              m.valid_from::text as valid_from, m.valid_until::text as valid_until, m.version::text as version
         from machvon.contract_party m
         left join machvon.contractor k on k.tenant_id = m.tenant_id and k.id = m.contractor_id
        where m.contract_id = $1::uuid and m.status = 'ACTIVE'
        order by case m.role when 'LEAD' then 0 when 'SOLE' then 1 else 2 end, k.legal_name, m.id`,
      [contractId],
    );
    return rows.map(toParty);
  }

  // ---- commands ------------------------------------------------------------------------------------------------

  /**
   * Creates a contract in DRAFT at version 1 with its first revision (BASE, DRAFT) that holds the value and the document. The package must
   * be awarded to the contractor, the value must not exceed the ceiling (the price of the package, or a lower one the request names), the
   * capital plan of the project must be approved and the contractor verified and free of restrictions. A second contract with the same code
   * is refused. The caller has judged the scope of the project.
   */
  async create(tx: TenantTx, input: NewContract, actor: string, today: string): Promise<CreatedContract> {
    const code = textOf(input.code, 'code', MAX_CODE);
    const title = textOf(input.title, 'title', MAX_TITLE);
    const value = this.positiveValue(input.contractValueVnd);
    const completionDue = input.completionDue === undefined ? null : calendarDate(input.completionDue, 'completion_due');
    const requested = input.estimateCeilingVnd === undefined ? undefined : wholeAmount(input.estimateCeilingVnd, 'estimate_ceiling_vnd');
    // Identifiers are compared as the lower-case text the database writes: a uuid in capitals is the same uuid.
    const { projectId, packageId, contractorId, documentVersionId } = {
      projectId: input.projectId.toLowerCase(),
      packageId: input.packageId.toLowerCase(),
      contractorId: input.contractorId.toLowerCase(),
      documentVersionId: input.documentVersionId.toLowerCase(),
    };
    const facts = await this.source.packageFacts(tx, packageId);
    if (facts === undefined || facts.projectId !== projectId) throw invalid('package_id');
    if (facts.award === null) throw new DomainError('PACKAGE_NOT_AWARDED', 422, 'package_id');
    if (facts.award.contractorId !== contractorId) throw invalid('contractor_id');
    const ceiling = this.ceilingOf(facts.budgetVnd, requested);
    this.assertWithinCeiling(value, ceiling);
    if (!(await this.source.hasApprovedCapitalPlan(tx, projectId))) throw new DomainError('CAPITAL_PLAN_NOT_APPROVED', 422, 'project_id');
    await this.assertContractorMayContract(tx, contractorId, today);
    await this.assertDocument(tx, documentVersionId);
    const id = randomUUID();
    const revisionId = randomUUID();
    try {
      await tx.query(
        `insert into machvon.contract
           (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture,
            requires_quality_acceptance, contract_value_vnd, estimate_ceiling_vnd, completion_due, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, 'VND', 'DRAFT', 1, $7, $8, $9::boolean,
            $10::boolean, $11::numeric, $12::numeric, $13::date, $14::uuid, $14::uuid)`,
        [
          id,
          projectId,
          packageId,
          contractorId,
          code,
          input.type,
          title,
          input.advanceCategory,
          input.isJointVenture ?? false,
          input.requiresQualityAcceptance ?? true,
          value,
          ceiling,
          completionDue,
          actor,
        ],
      );
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      if (failure.code === UNIQUE_VIOLATION && failure.constraint === CODE_CONSTRAINT) throw new DomainError('CONTRACT_CODE_DUPLICATE', 409, 'code');
      throw error;
    }
    // The first revision is the draft of the terms; it becomes the effective one when the contract is activated, which sets its dates again.
    await tx.query(
      `insert into machvon.contract_revision
         (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, 1, $3::numeric, $4::uuid, $5::date, 'DRAFT', 'BASE', 1, $6::uuid, $6::uuid)`,
      [revisionId, id, value, documentVersionId, today, actor],
    );
    return { id, revisionId, version: 1, status: 'DRAFT', code, contractValueVnd: value, estimateCeilingVnd: ceiling };
  }

  /**
   * Changes the terms of a draft within the allowlist and keeps the first revision in step. Only a DRAFT takes a change; the value must stay
   * within the ceiling, and the ceiling may be lowered or raised back up to the price of the package, never above it. A request that
   * changes nothing writes nothing.
   */
  async reviseDraft(tx: TenantTx, id: string, expectedVersion: number, change: DraftChange, actor: string, scopes: ContractScopes): Promise<DraftUpdate> {
    const locked = await this.lock(tx, id, scopes);
    if (locked.version !== expectedVersion) throw versionConflict(locked.version);
    const asked = Object.values(change).some((value) => value !== undefined);
    if (!asked) throw invalid('body');
    if (locked.status !== 'DRAFT') throw new DomainError('CONTRACT_STATE_INVALID', 409);
    const changes: FieldChange[] = [];
    const assignments: string[] = [];
    const params: unknown[] = [id];
    const set = (field: string, column: string, before: unknown, after: unknown, cast = ''): void => {
      if (before === after) return;
      changes.push({ field, before, after });
      params.push(after);
      assignments.push(`${column} = $${params.length}${cast}`);
    };
    if (change.title !== undefined) set('title', 'title', locked.title, textOf(change.title, 'title', MAX_TITLE));
    if (change.completionDue !== undefined) set('completion_due', 'completion_due', locked.completionDue, calendarDate(change.completionDue, 'completion_due'), '::date');
    if (change.requiresQualityAcceptance !== undefined) set('requires_quality_acceptance', 'requires_quality_acceptance', locked.requiresQualityAcceptance, change.requiresQualityAcceptance, '::boolean');
    let value = locked.contractValueVnd;
    let ceiling = locked.estimateCeilingVnd;
    if (change.contractValueVnd !== undefined) value = this.positiveValue(change.contractValueVnd);
    if (change.estimateCeilingVnd !== undefined) {
      const facts = await this.source.packageFacts(tx, locked.packageId);
      if (facts === undefined) throw invalid('package_id');
      ceiling = this.ceilingOf(facts.budgetVnd, wholeAmount(change.estimateCeilingVnd, 'estimate_ceiling_vnd'));
    }
    if (ceiling !== null) this.assertWithinCeiling(value, ceiling);
    set('contract_value_vnd', 'contract_value_vnd', locked.contractValueVnd, value, '::numeric');
    set('estimate_ceiling_vnd', 'estimate_ceiling_vnd', locked.estimateCeilingVnd, ceiling, '::numeric');
    const documentVersionId = change.documentVersionId?.toLowerCase();
    if (documentVersionId !== undefined) {
      const draft = await this.draftRevision(tx, id);
      if (draft.documentVersionId !== documentVersionId) {
        await this.assertDocument(tx, documentVersionId);
        changes.push({ field: 'document_version_id', before: draft.documentVersionId, after: documentVersionId });
      }
    }
    if (changes.length === 0) return { version: locked.version, status: locked.status, changes };
    params.push(actor);
    assignments.push('updated_at = now()', `updated_by = $${params.length}::uuid`, 'version = version + 1');
    await tx.query(`update machvon.contract set ${assignments.join(', ')} where id = $1::uuid`, params);
    await this.syncDraftRevision(tx, id, value, documentVersionId, actor);
    return { version: locked.version + 1, status: locked.status, changes };
  }

  /** Cancels a draft or a contract in review: the history keeps the reason, the revision is rejected, and nothing is deleted. */
  async cancelDraft(tx: TenantTx, id: string, expectedVersion: number, reason: string, actor: string, scopes: ContractScopes, today: string): Promise<Cancelled> {
    const text = textOf(reason, 'reason', MAX_REASON);
    const locked = await this.lock(tx, id, scopes);
    if (locked.version !== expectedVersion) throw versionConflict(locked.version);
    assertContractTransition('cancelContractDraft', locked.status);
    await tx.query(
      `update machvon.contract set status = 'CANCELLED', status_reason = $2, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid`,
      [id, text, actor],
    );
    await tx.query(
      `update machvon.contract_revision set status = 'REJECTED', updated_at = now(), updated_by = $2::uuid, version = version + 1 where contract_id = $1::uuid and status = 'DRAFT'`,
      [id, actor],
    );
    await tx.query(
      `insert into machvon.contract_status_change (tenant_id, id, contract_id, from_status, to_status, reason, effective_on, command, created_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, 'CANCELLED', $4, $5::date, $6, $7::uuid)`,
      [randomUUID(), id, locked.status, text, today, CANCEL_COMMAND, actor],
    );
    return { version: locked.version + 1, status: 'CANCELLED', fromStatus: locked.status };
  }

  /** Locks the contract for update inside the scope of the caller; a contract the caller can read but not update is a refusal, not a miss. */
  async lock(tx: TenantTx, id: string, scopes: ContractScopes): Promise<LockedContract> {
    const predicate = scopes.update(2);
    const rows = await tx.query<{
      version: string;
      status: ContractStatus;
      project_id: string;
      package_id: string;
      contractor_id: string;
      is_joint_venture: boolean;
      contract_value_vnd: string;
      estimate_ceiling_vnd: string | null;
      title: string | null;
      completion_due: string | null;
      requires_quality_acceptance: boolean;
    }>(
      `select c.version::text as version, c.status, c.project_id, c.package_id, c.contractor_id, c.is_joint_venture, c.contract_value_vnd::text as contract_value_vnd,
              c.estimate_ceiling_vnd::text as estimate_ceiling_vnd, c.title, c.completion_due::text as completion_due, c.requires_quality_acceptance
         from ${SCOPE_FROM}
        where c.id = $1::uuid and ${predicate.sql}
        for update of c`,
      [id, ...predicate.params],
    );
    const row = rows[0];
    if (row === undefined) {
      const readable = scopes.read(2);
      const seen = await tx.query<{ id: string }>(`select c.id from ${SCOPE_FROM} where c.id = $1::uuid and ${readable.sql}`, [id, ...readable.params]);
      throw seen[0] === undefined ? new DomainError('RESOURCE_NOT_FOUND', 404) : new DomainError('SCOPE_DENIED', 403);
    }
    return {
      id,
      version: Number(row.version),
      status: row.status,
      projectId: row.project_id,
      packageId: row.package_id,
      contractorId: row.contractor_id,
      isJointVenture: row.is_joint_venture,
      contractValueVnd: row.contract_value_vnd,
      estimateCeilingVnd: row.estimate_ceiling_vnd,
      title: row.title,
      completionDue: row.completion_due,
      requiresQualityAcceptance: row.requires_quality_acceptance,
    };
  }

  /** Raises the version of a locked contract by one (a change of its members is a change of the contract). */
  async touch(tx: TenantTx, id: string, actor: string): Promise<void> {
    await tx.query('update machvon.contract set updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid', [id, actor]);
  }

  /** Checks a contractor for a contract: a restriction in force is CONTRACTOR_RESTRICTED, an unverified tax id is CONTRACTOR_NOT_VERIFIED, a stranger is a fault of the request. */
  async assertContractorMayContract(tx: TenantTx, contractorId: string, on: string, field = 'contractor_id'): Promise<void> {
    try {
      await this.contractors.assertMayTakePart(tx, contractorId, on);
    } catch (error) {
      if ((error as { code?: string }).code === 'RESOURCE_NOT_FOUND') throw invalid(field);
      throw error;
    }
  }

  // ---- rules ---------------------------------------------------------------------------------------------------

  private positiveValue(value: string): string {
    const whole = wholeAmount(value, 'contract_value_vnd');
    if (whole === '0') throw invalid('contract_value_vnd');
    return whole;
  }

  /** The ceiling a contract keeps: the price of the package, or a lower figure the request names (a higher one is not the price that was approved). */
  private ceilingOf(budget: string, requested: string | undefined): string {
    if (requested === undefined) return budget;
    if (compareDecimal(requested, budget) > 0) throw invalid('estimate_ceiling_vnd');
    return requested;
  }

  private assertWithinCeiling(value: string, ceiling: string): void {
    if (compareDecimal(value, ceiling) > 0) throw new DomainError('CONTRACT_VALUE_EXCEEDS_CEILING', 422, 'contract_value_vnd', { extensions: { ceiling_vnd: ceiling } });
  }

  private async assertDocument(tx: TenantTx, documentVersionId: string): Promise<void> {
    if (!(await this.source.documentVersionExists(tx, documentVersionId))) throw invalid('document_version_id');
  }

  private async draftRevision(tx: TenantTx, contractId: string): Promise<{ id: string; documentVersionId: string }> {
    const rows = await tx.query<{ id: string; document_version_id: string }>(
      `select id, document_version_id from machvon.contract_revision where contract_id = $1::uuid and status = 'DRAFT' order by revision desc limit 1 for update`,
      [contractId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('a draft contract has no draft revision');
    return { id: row.id, documentVersionId: row.document_version_id };
  }

  private async syncDraftRevision(tx: TenantTx, contractId: string, value: string, documentVersionId: string | undefined, actor: string): Promise<void> {
    await tx.query(
      `update machvon.contract_revision
          set amount_vnd = $2::numeric, document_version_id = coalesce($3::uuid, document_version_id), updated_at = now(), updated_by = $4::uuid, version = version + 1
        where contract_id = $1::uuid and status = 'DRAFT'`,
      [contractId, value, documentVersionId ?? null, actor],
    );
  }
}

/** The shares and the work of the members against 100 percent and the value of the contract; a contract without members has nothing to add up. */
export function partiesCheck(parties: readonly Pick<PartyRow, 'sharePct' | 'workValueVnd'>[], contractValueVnd: string): PartiesCheck {
  const share = parties.reduce((total, party) => addDecimal(total, party.sharePct), '0');
  const work = parties.reduce((total, party) => addDecimal(total, party.workValueVnd), '0');
  return {
    shareTotal: share,
    workValueTotal: work,
    sharesComplete: compareDecimal(share, '100') === 0,
    workMatchesValue: compareDecimal(work, contractValueVnd) === 0,
  };
}
