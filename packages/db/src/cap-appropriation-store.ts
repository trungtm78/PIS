import { randomUUID } from 'node:crypto';
import { DomainError, FUNDING_TAXONOMY_RULE_TYPE, VND_SCALE, assertAppropriationForPack, assertFourEyes, compareDecimal, parseFundingPack, requirePositiveAmount, vietnamDateOf, versionConflict, hasControlChar } from '@machvon/kernel';
import { assertYearsOpen } from './cap-fiscal-year-guard.ts';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import { timestampKey } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';

const UNIQUE_VIOLATION = '23505';
const DECISION_LINE_INDEX = 'appropriation_decision_line_uq';
const LIVE_SUCCESSOR_INDEX = 'appropriation_live_successor_uq';
const MIN_YEAR = 1990;
const MAX_YEAR = 2100;
const MIN_AUTHORITY = 2;
const MAX_AUTHORITY = 300;
const MAX_AMOUNT_DIGITS = 24;
const REVERSAL_REASON = 'REVISED';
/** The transaction setting that the allocation command raises to change the allocated total (see V1360). */
const ALLOCATION_WRITE_SETTING = 'app.cap_allocation_write';
/** A document that has been recalled, replaced or has expired no longer backs an assignment of capital. */
const USABLE_DOCUMENT_STATUSES: readonly string[] = ['PENDING', 'EFFECTIVE', 'CORRECTED'];

/** Every origin a pack may list: the five of the public pack, then the two of the enterprise pack (ENT-3e); which of them an appropriation may take is the pack of the process (`assertAppropriationForPack`). */
export const APPROPRIATION_ORIGINS = ['PM_ASSIGNED', 'LOCAL_ADDED', 'CARRYOVER', 'CENTRAL_SUPPORT', 'REVENUE_INCREASE', 'GROUP_ASSIGNED', 'BOARD_APPROVED'] as const;
export type AppropriationOrigin = (typeof APPROPRIATION_ORIGINS)[number];
export const BUDGET_LEVELS = ['CENTRAL', 'LOCAL', 'ALL'] as const;
export type BudgetLevel = (typeof BUDGET_LEVELS)[number];
export const APPROPRIATION_STATUSES = ['DRAFT', 'APPROVED', 'PUBLISHED', 'SUPERSEDED', 'REJECTED'] as const;
export type AppropriationStatus = (typeof APPROPRIATION_STATUSES)[number];
export type AppropriationDecision = 'approve' | 'reject' | 'return';

/** The fund source an appropriation is drawn from, by the version that was in force when it was chosen. */
export interface FundSourceRef {
  versionId: string;
  businessKey: string;
  label: string;
  /** NSTW, NSDP, ODA, CTMTQG or OTHER (the attribute of the master data entry). */
  category: string | null;
  relation: string | null;
  /** Whether the ODA capital is on-lent; null for the other categories. */
  onLending: boolean | null;
  validFrom: string;
  validUntil: string | null;
}

export interface ProgramRef {
  versionId: string;
  businessKey: string;
  label: string;
}

export interface AppropriationRow {
  id: string;
  fundSource: FundSourceRef;
  program: ProgramRef | null;
  planYear: number;
  origin: AppropriationOrigin;
  budgetLevel: BudgetLevel;
  /** Exact decimal strings in whole VND. */
  amountVnd: string;
  allocatedTotalVnd: string;
  remainingVnd: string;
  decisionDocumentId: string;
  /** The legal citation of the decision document (its symbol and issue date), never its title. */
  decisionSymbol: string | null;
  decisionIssuedOn: string | null;
  issuingAuthority: string;
  /** The funding pack the appropriation is counted in (PUBLIC or ENTERPRISE) and, for the enterprise pack, the kind of the decision document that backs its origin. */
  taxonomyPack: string;
  decisionKind: string | null;
  sourceYear: number;
  isExtended: boolean;
  extendedTo: string | null;
  extensionDocumentId: string | null;
  revision: number;
  supersedesId: string | null;
  capitalPlanId: string | null;
  status: AppropriationStatus;
  createdBy: string;
  approvedBy: string | null;
  version: number;
  /** Creation time to the microsecond (UTC): the ordering key of the list and its cursor. */
  createdAtKey: string;
}

export interface AppropriationInput {
  fundSourceVersionId: string;
  planYear: number;
  origin: AppropriationOrigin;
  budgetLevel: BudgetLevel;
  programMasterVersionId?: string | undefined;
  amountVnd: string;
  decisionDocumentId: string;
  issuingAuthority: string;
  /** The kind of the decision document (a code of the legal-document catalogue); the pack of the process says whether it is required, which kinds fit the origin, or that there is none. */
  decisionKind?: string | undefined;
  sourceYear: number;
  extendedTo?: string | undefined;
  extensionDocumentId?: string | undefined;
  supersedesId?: string | undefined;
  capitalPlanId?: string | undefined;
}

export interface AppropriationFilter {
  planYear?: number | undefined;
  origin?: AppropriationOrigin | undefined;
  budgetLevel?: BudgetLevel | undefined;
}

export interface RegisteredAppropriation {
  id: string;
  version: number;
  status: 'DRAFT';
  revision: number;
}

export interface AppropriationDecided {
  /** The appropriation as it was decided (with the status it has now). */
  row: AppropriationRow;
  status: AppropriationStatus;
  version: number;
  /** The appropriation a published revision replaced. */
  supersededId: string | null;
  /** The allocation lines that were moved to the revision with the allocated total they hold. */
  movedLines: number;
  /** The ledger entries posted by the publication, the reversal of the replaced amount first. */
  ledgerEntryIds: string[];
}

interface SqlRow {
  id: string;
  fund_source_version_id: string;
  fund_key: string;
  fund_label: string;
  fund_attributes: Record<string, unknown>;
  fund_valid_from: string;
  fund_valid_until: string | null;
  program_master_version_id: string | null;
  program_key: string | null;
  program_label: string | null;
  plan_year: number;
  origin: AppropriationOrigin;
  budget_level: BudgetLevel;
  amount_vnd: string;
  allocated_total_vnd: string;
  remaining_vnd: string;
  decision_document_id: string;
  decision_symbol: string | null;
  decision_issued_on: string | null;
  issuing_authority: string;
  taxonomy_pack: string;
  decision_kind: string | null;
  source_year: number;
  is_extended: boolean;
  extended_to: string | null;
  extension_document_id: string | null;
  revision: number;
  supersedes_id: string | null;
  capital_plan_id: string | null;
  status: AppropriationStatus;
  created_by: string;
  approved_by: string | null;
  version: string;
  created_at_key: string;
}

const SELECT = `select a.id, a.fund_source_version_id, fr.business_key as fund_key, fv.label as fund_label, fv.attributes as fund_attributes,
    fv.valid_from::text as fund_valid_from, fv.valid_until::text as fund_valid_until, a.program_master_version_id, pr.business_key as program_key, pv.label as program_label,
    a.plan_year, a.origin, a.budget_level, a.amount_vnd::text as amount_vnd, a.allocated_total_vnd::text as allocated_total_vnd,
    (a.amount_vnd - a.allocated_total_vnd)::text as remaining_vnd, a.decision_document_id, dd.symbol as decision_symbol, dd.issued_on::text as decision_issued_on,
    a.issuing_authority, a.taxonomy_pack, a.decision_kind, a.source_year, a.is_extended, a.extended_to::text as extended_to, a.extension_document_id, a.revision, a.supersedes_id, a.capital_plan_id,
    a.status, a.created_by, a.approved_by, a.version::text as version, ${timestampKey('a.created_at')} as created_at_key
  from machvon.appropriation a
  join machvon.master_record_version fv on fv.tenant_id = a.tenant_id and fv.id = a.fund_source_version_id
  join machvon.master_record fr on fr.tenant_id = fv.tenant_id and fr.id = fv.master_record_id
  left join machvon.master_record_version pv on pv.tenant_id = a.tenant_id and pv.id = a.program_master_version_id
  left join machvon.master_record pr on pr.tenant_id = pv.tenant_id and pr.id = pv.master_record_id
  left join machvon.document dd on dd.tenant_id = a.tenant_id and dd.id = a.decision_document_id`;

const textAttribute = (attributes: Record<string, unknown>, key: string): string | null => (typeof attributes[key] === 'string' ? attributes[key] : null);

const toRow = (row: SqlRow): AppropriationRow => ({
  id: row.id,
  fundSource: {
    versionId: row.fund_source_version_id,
    businessKey: row.fund_key,
    label: row.fund_label,
    category: textAttribute(row.fund_attributes, 'category'),
    relation: textAttribute(row.fund_attributes, 'relation'),
    onLending: typeof row.fund_attributes.onlending === 'boolean' ? row.fund_attributes.onlending : null,
    validFrom: row.fund_valid_from,
    validUntil: row.fund_valid_until,
  },
  program: row.program_master_version_id === null ? null : { versionId: row.program_master_version_id, businessKey: row.program_key ?? '', label: row.program_label ?? '' },
  planYear: row.plan_year,
  origin: row.origin,
  budgetLevel: row.budget_level,
  amountVnd: row.amount_vnd,
  allocatedTotalVnd: row.allocated_total_vnd,
  remainingVnd: row.remaining_vnd,
  decisionDocumentId: row.decision_document_id,
  decisionSymbol: row.decision_symbol,
  decisionIssuedOn: row.decision_issued_on,
  issuingAuthority: row.issuing_authority,
  taxonomyPack: row.taxonomy_pack,
  decisionKind: row.decision_kind,
  sourceYear: row.source_year,
  isExtended: row.is_extended,
  extendedTo: row.extended_to,
  extensionDocumentId: row.extension_document_id,
  revision: row.revision,
  supersedesId: row.supersedes_id,
  capitalPlanId: row.capital_plan_id,
  status: row.status,
  createdBy: row.created_by,
  approvedBy: row.approved_by,
  version: Number(row.version),
  createdAtKey: row.created_at_key,
});

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

function yearOf(value: number, field: string): number {
  if (!Number.isInteger(value) || value < MIN_YEAR || value > MAX_YEAR) throw invalid(field);
  return value;
}

/** An amount of whole VND above zero that the column holds: the digits of the string are exactly what is stored, nothing is rounded. */
function amountOf(value: string): string {
  try {
    const amount = requirePositiveAmount(value, VND_SCALE);
    if (amount.length <= MAX_AMOUNT_DIGITS) return amount;
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
  }
  throw invalid('amount_vnd');
}

function authorityOf(value: string): string {
  const text = value.trim();
  if (text.length < MIN_AUTHORITY || text.length > MAX_AUTHORITY || hasControlChar(text)) throw invalid('issuing_authority');
  return text;
}

function dateOf(value: string, field: string): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw invalid(field);
  return value;
}

export interface MasterDetail {
  versionId: string;
  recordId: string;
  attributes: Record<string, unknown>;
}

interface Locked {
  id: string;
  version: number;
  status: AppropriationStatus;
  createdBy: string;
  planYear: number;
  sourceYear: number;
  origin: AppropriationOrigin;
  budgetLevel: BudgetLevel;
  amountVnd: string;
  allocatedTotalVnd: string;
  revision: number;
  supersedesId: string | null;
  fundSourceVersionId: string;
  programMasterVersionId: string | null;
  decisionDocumentId: string;
  extensionDocumentId: string | null;
}

interface LockedSql {
  id: string;
  version: string;
  status: AppropriationStatus;
  created_by: string;
  plan_year: number;
  source_year: number;
  origin: AppropriationOrigin;
  budget_level: BudgetLevel;
  amount_vnd: string;
  allocated_total_vnd: string;
  revision: number;
  supersedes_id: string | null;
  fund_source_version_id: string;
  program_master_version_id: string | null;
  decision_document_id: string;
  extension_document_id: string | null;
}

const toLocked = (row: LockedSql): Locked => ({
  id: row.id,
  version: Number(row.version),
  status: row.status,
  createdBy: row.created_by,
  planYear: row.plan_year,
  sourceYear: row.source_year,
  origin: row.origin,
  budgetLevel: row.budget_level,
  amountVnd: row.amount_vnd,
  allocatedTotalVnd: row.allocated_total_vnd,
  revision: row.revision,
  supersedesId: row.supersedes_id,
  fundSourceVersionId: row.fund_source_version_id,
  programMasterVersionId: row.program_master_version_id,
  decisionDocumentId: row.decision_document_id,
  extensionDocumentId: row.extension_document_id,
});

const LOCK_COLUMNS = `a.id, a.version::text as version, a.status, a.created_by, a.plan_year, a.source_year, a.origin, a.budget_level, a.amount_vnd::text as amount_vnd,
  a.allocated_total_vnd::text as allocated_total_vnd, a.revision, a.supersedes_id, a.fund_source_version_id, a.program_master_version_id, a.decision_document_id, a.extension_document_id`;

/**
 * The appropriation register (ST-CAP-001, CAP 3.1 F1): the capital assigned to the province by decision, by fund source, plan year, origin
 * (Prime Minister assigned, local added, carried over, central support, revenue increase) and budget level. A planner registers a draft, an
 * approver who is not the planner publishes it and the ledger posts APPROPRIATE; a change of the amount is a new revision that replaces the
 * published one (reversal and new entry), never below what is already allocated (BR-CAP-02). The allocated total is read here and written only
 * by the allocation command (V1360 guards it). Fund sources and programs are named by the master data version in force; the documents are
 * documents of the tenant.
 */
export class CapAppropriationStore {
  /** The register in the tenant: drafts waiting for a decision and published appropriations, the newest first. */
  async list(tx: TenantTx, filter: AppropriationFilter, request: { limit: number; after: { code: string; id: string } | undefined }): Promise<AppropriationRow[]> {
    const rows = await tx.query<SqlRow>(
      `${SELECT}
        where a.status in ('DRAFT', 'PUBLISHED') and ($1::integer is null or a.plan_year = $1) and ($2::text is null or a.origin = $2) and ($3::text is null or a.budget_level = $3)
          and ($4::text is null or (${timestampKey('a.created_at')}, a.id) < ($4::text, $5::uuid))
        order by a.created_at desc, a.id desc limit $6`,
      [filter.planYear ?? null, filter.origin ?? null, filter.budgetLevel ?? null, request.after?.code ?? null, request.after?.id ?? null, request.limit],
    );
    return rows.map(toRow);
  }

  async find(tx: TenantTx, id: string): Promise<AppropriationRow | undefined> {
    const rows = await tx.query<SqlRow>(`${SELECT} where a.id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  /**
   * Registers a draft. The fund source and the program must be entries of master data in force today, the fund source one that adds to the
   * others (a subset such as CTMTQG is part of its parent, so it is never a second source of the same capital); the documents must be documents
   * of the tenant; a carry-over names its extension document and the day the extension ends. A revision names the published appropriation it
   * replaces, keeps its fund source, program, year, origin and level, and is refused below what is already allocated.
   */
  async register(tx: TenantTx, input: AppropriationInput, actor: string, today: string = vietnamDateOf(new Date()), packCode = 'PUBLIC'): Promise<RegisteredAppropriation> {
    await this.assertPack(tx, packCode, input, today);
    const amount = amountOf(input.amountVnd);
    const authority = authorityOf(input.issuingAuthority);
    const planYear = yearOf(input.planYear, 'plan_year');
    const sourceYear = yearOf(input.sourceYear, 'source_year');
    const extendedTo = this.assertOriginRules(input, planYear, sourceYear);
    await assertYearsOpen(tx, [planYear]);
    const fund = await this.masterInForce(tx, 'fund_source_version_id', input.fundSourceVersionId, ['FUND_SOURCE'], today);
    if (fund.attributes.relation === 'SUBSET_OF') throw new DomainError('SUBSET_SOURCE_NOT_ADDITIVE', 422, 'fund_source_version_id');
    const program = input.programMasterVersionId === undefined ? undefined : await this.masterInForce(tx, 'program_master_version_id', input.programMasterVersionId, ['PROGRAM'], today);
    await this.assertDocument(tx, input.decisionDocumentId, 'DECISION_REQUIRED', 'decision_document_id');
    if (input.extensionDocumentId !== undefined) await this.assertDocument(tx, input.extensionDocumentId, 'EXTENSION_DOCUMENT_REQUIRED', 'extension_document_id');
    if (input.capitalPlanId !== undefined) await this.assertCapitalPlan(tx, input.capitalPlanId);
    let revision = 1;
    if (input.supersedesId !== undefined) {
      const previous = await this.lockOne(tx, input.supersedesId);
      await this.assertRevisionOf(tx, previous, { fund, program, planYear, sourceYear, input });
      if (compareDecimal(amount, previous.allocatedTotalVnd) < 0) throw new DomainError('APPROPRIATION_BELOW_ALLOCATED', 422, 'amount_vnd');
      revision = previous.revision + 1;
    }
    const id = randomUUID();
    try {
      await tx.query(
        `insert into machvon.appropriation
           (tenant_id, id, capital_plan_id, fund_source_version_id, plan_year, origin, budget_level, program_master_version_id, amount_vnd, allocated_total_vnd,
            decision_document_id, issuing_authority, is_extended, extended_to, extension_document_id, source_year, revision, supersedes_id, status, created_by, updated_by, version, taxonomy_pack, decision_kind)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::integer, $5, $6, $7::uuid, $8::numeric, 0,
            $9::uuid, $10, $11::boolean, $12::date, $13::uuid, $14::integer, $15::integer, $16::uuid, 'DRAFT', $17::uuid, $17::uuid, 1, $18, $19)`,
        [
          id,
          input.capitalPlanId ?? null,
          input.fundSourceVersionId,
          planYear,
          input.origin,
          input.budgetLevel,
          input.programMasterVersionId ?? null,
          amount,
          input.decisionDocumentId,
          authority,
          extendedTo !== null,
          extendedTo,
          input.extensionDocumentId ?? null,
          sourceYear,
          revision,
          input.supersedesId ?? null,
          actor,
          packCode,
          input.decisionKind ?? null,
        ],
      );
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      if (failure.code === UNIQUE_VIOLATION && failure.constraint === DECISION_LINE_INDEX) throw new DomainError('APPROPRIATION_DUPLICATE', 409);
      if (failure.code === UNIQUE_VIOLATION && failure.constraint === LIVE_SUCCESSOR_INDEX) throw new DomainError('REVISION_PENDING_EXISTS', 409);
      throw error;
    }
    return { id, version: 1, status: 'DRAFT', revision };
  }

  /**
   * The decision on a draft. The registrant never decides (SELF_APPROVAL_DENIED). Approving publishes it and posts APPROPRIATE to the ledger;
   * a revision also reverses the amount of the appropriation it replaces and moves the allocation lines and the allocated total to itself, in
   * one transaction, with both rows locked in the order of their ids. Rejecting ends the draft. A return has no meaning here: a draft is not
   * edited, a mistake is rejected and registered again.
   */
  async decide(
    tx: TenantTx,
    id: string,
    expectedVersion: number,
    decision: AppropriationDecision,
    decider: string,
    today: string = vietnamDateOf(new Date()),
  ): Promise<AppropriationDecided> {
    if (decision === 'return') throw invalid('decision');
    const peek = await this.find(tx, id);
    if (peek === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const locked = await this.lockMany(tx, peek.supersedesId === null ? [id] : [id, peek.supersedesId]);
    const draft = locked.find((candidate) => candidate.id === id);
    if (draft === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (draft.version !== expectedVersion) throw versionConflict(draft.version);
    assertFourEyes(draft.createdBy, decider);
    if (draft.status !== 'DRAFT') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    if (decision === 'reject') {
      await this.move(tx, id, "status = 'REJECTED', updated_by = $2::uuid", [decider]);
      return { row: peek, status: 'REJECTED', version: draft.version + 1, supersededId: null, movedLines: 0, ledgerEntryIds: [] };
    }
    await assertYearsOpen(tx, [draft.planYear]);
    await this.masterInForce(tx, 'fund_source_version_id', draft.fundSourceVersionId, ['FUND_SOURCE'], today);
    if (draft.programMasterVersionId !== null) await this.masterInForce(tx, 'program_master_version_id', draft.programMasterVersionId, ['PROGRAM'], today);
    await this.assertDocument(tx, draft.decisionDocumentId, 'DECISION_REQUIRED', 'decision_document_id');
    if (draft.extensionDocumentId !== null) await this.assertDocument(tx, draft.extensionDocumentId, 'EXTENSION_DOCUMENT_REQUIRED', 'extension_document_id');
    const previous = locked.find((candidate) => candidate.id === draft.supersedesId);
    if (draft.supersedesId !== null && (previous === undefined || previous.status !== 'PUBLISHED')) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'supersedes_id');
    // What is allocated may have grown since the revision was registered: the ceiling is judged again under the lock.
    if (previous !== undefined && compareDecimal(draft.amountVnd, previous.allocatedTotalVnd) < 0) throw new DomainError('APPROPRIATION_BELOW_ALLOCATED', 422, 'amount_vnd');
    const carried = previous?.allocatedTotalVnd ?? '0';
    await this.setAllocationWrite(tx, true);
    await this.move(tx, id, "status = 'PUBLISHED', approved_by = $2::uuid, updated_by = $2::uuid, allocated_total_vnd = $3::numeric", [decider, carried]);
    await this.setAllocationWrite(tx, false);
    const ledgerEntryIds: string[] = [];
    let movedLines = 0;
    if (previous !== undefined) {
      await this.move(tx, previous.id, "status = 'SUPERSEDED', updated_by = $2::uuid", [decider]);
      movedLines = await this.moveLines(tx, previous.id, id, decider);
      ledgerEntryIds.push(await this.postReversal(tx, previous, id, decider));
    }
    ledgerEntryIds.push(await this.postAppropriate(tx, draft, decider));
    return { row: peek, status: 'PUBLISHED', version: draft.version + 1, supersededId: previous?.id ?? null, movedLines, ledgerEntryIds };
  }

  /**
   * The origin, the budget level and the kind of decision against the pack of the process on the day (the approved rule of the tenant or the built-in default): the public pack lists five origins, two levels and
   * binds no kind; the enterprise pack lists the resolution of the group and the decision of the company and binds each to its own kinds of document (ENT-3e, CN.01).
   */
  private async assertPack(tx: TenantTx, packCode: string, input: AppropriationInput, today: string): Promise<void> {
    const resolved = await new GovernancePolicyPort().require(tx, FUNDING_TAXONOMY_RULE_TYPE, packCode, today);
    assertAppropriationForPack(parseFundingPack(packCode, resolved.params), { origin: input.origin, budgetLevel: input.budgetLevel, decisionKind: input.decisionKind });
  }

  /** What an appropriation may be, judged by its origin: the carry-over fields belong to a carry-over only. Returns the day the extension ends. */
  private assertOriginRules(input: AppropriationInput, planYear: number, sourceYear: number): string | null {
    if (input.origin !== 'CARRYOVER') {
      if (sourceYear !== planYear) throw invalid('source_year');
      if (input.extendedTo !== undefined) throw invalid('extended_to');
      if (input.extensionDocumentId !== undefined) throw invalid('extension_document_id');
      return null;
    }
    if (sourceYear >= planYear) throw invalid('source_year');
    if (input.extensionDocumentId === undefined) throw new DomainError('EXTENSION_DOCUMENT_REQUIRED', 422, 'extension_document_id');
    if (input.extendedTo === undefined) throw invalid('extended_to');
    const extendedTo = dateOf(input.extendedTo, 'extended_to');
    if (extendedTo < `${planYear}-01-01`) throw invalid('extended_to');
    return extendedTo;
  }

  private async assertDocument(tx: TenantTx, documentId: string, code: string, field: string): Promise<void> {
    const rows = await tx.query<{ effect_status: string }>('select effect_status from machvon.document where id = $1::uuid', [documentId]);
    // A document of another tenant is indistinguishable from one that does not exist.
    if (rows[0] === undefined || !USABLE_DOCUMENT_STATUSES.includes(rows[0].effect_status)) throw new DomainError(code, 422, field);
  }

  private async assertCapitalPlan(tx: TenantTx, capitalPlanId: string): Promise<void> {
    const rows = await tx.query('select 1 from machvon.capital_plan where id = $1::uuid', [capitalPlanId]);
    if (rows.length === 0) throw invalid('capital_plan_id');
  }

  /**
   * The entry a version belongs to, when the version is published, in force on `today`, of one of the types and not retired or merged away. A
   * version that does not exist or is of another type is a fault of the request; one that is no longer in force is MASTER_NOT_EFFECTIVE.
   */
  async masterInForce(tx: TenantTx, field: string, versionId: string, masterTypes: readonly string[], today: string): Promise<MasterDetail> {
    const rows = await tx.query<{ master_type: string; record_id: string; record_status: string; attributes: Record<string, unknown>; status: string; published: boolean; in_range: boolean }>(
      `select r.master_type, r.id as record_id, r.status as record_status, v.attributes, v.status, (v.published_at is not null) as published,
              (v.valid_from <= $2::date and (v.valid_until is null or v.valid_until > $2::date)) as in_range
         from machvon.master_record_version v join machvon.master_record r on r.id = v.master_record_id
        where v.id = $1::uuid`,
      [versionId, today],
    );
    const row = rows[0];
    if (row === undefined || !masterTypes.includes(row.master_type)) throw invalid(field);
    const inForce = row.published && row.in_range && ['APPROVED', 'EFFECTIVE'].includes(row.status) && !['RETIRED', 'MERGED'].includes(row.record_status);
    if (!inForce) throw new DomainError('MASTER_NOT_EFFECTIVE', 422, field);
    return { versionId, recordId: row.record_id, attributes: row.attributes };
  }

  /** The record a version belongs to: a revision may name a newer version of the same fund source or program. */
  private async recordOf(tx: TenantTx, versionId: string | null): Promise<string | null> {
    if (versionId === null) return null;
    const rows = await tx.query<{ master_record_id: string }>('select master_record_id from machvon.master_record_version where id = $1::uuid', [versionId]);
    return rows[0]?.master_record_id ?? null;
  }

  /** A revision replaces a published appropriation and keeps what identifies it: its fund source and program (as entries), year, origin and level. */
  private async assertRevisionOf(
    tx: TenantTx,
    previous: Locked,
    candidate: { fund: MasterDetail; program: MasterDetail | undefined; planYear: number; sourceYear: number; input: AppropriationInput },
  ): Promise<void> {
    if (previous.status !== 'PUBLISHED') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'supersedes_id');
    const sameLine =
      previous.planYear === candidate.planYear &&
      previous.sourceYear === candidate.sourceYear &&
      previous.origin === candidate.input.origin &&
      previous.budgetLevel === candidate.input.budgetLevel &&
      (await this.recordOf(tx, previous.fundSourceVersionId)) === candidate.fund.recordId &&
      (await this.recordOf(tx, previous.programMasterVersionId)) === (candidate.program?.recordId ?? null);
    if (!sameLine) throw invalid('supersedes_id');
  }

  private async lockOne(tx: TenantTx, id: string): Promise<Locked> {
    const [row] = await this.lockMany(tx, [id]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return row;
  }

  /** Locks the rows in the order of their ids, whichever order they are named in, so two decisions on a pair never wait for each other in a cycle. */
  private async lockMany(tx: TenantTx, ids: readonly string[]): Promise<Locked[]> {
    const rows = await tx.query<LockedSql>(`select ${LOCK_COLUMNS} from machvon.appropriation a where a.id = any($1::uuid[]) order by a.id for update`, [[...ids]]);
    return rows.map(toLocked);
  }

  private async move(tx: TenantTx, id: string, assignments: string, params: unknown[]): Promise<void> {
    await tx.query(`update machvon.appropriation set ${assignments}, updated_at = now(), version = version + 1 where id = $1::uuid`, [id, ...params]);
  }

  /** Raises or drops the transaction setting that lets the allocated total change (V1360 guard); only the lines of this store set it. */
  private async setAllocationWrite(tx: TenantTx, on: boolean): Promise<void> {
    await tx.query('select set_config($1, $2, true)', [ALLOCATION_WRITE_SETTING, on ? 'on' : 'off']);
  }

  /** The allocation lines follow the appropriation to its revision, so the lines of the published appropriation add up to its allocated total. */
  private async moveLines(tx: TenantTx, fromId: string, toId: string, actor: string): Promise<number> {
    const moved = await tx.query(
      'update machvon.allocation_line set appropriation_id = $2::uuid, updated_at = now(), updated_by = $3::uuid, version = version + 1 where appropriation_id = $1::uuid returning id',
      [fromId, toId, actor],
    );
    return moved.length;
  }

  private async postReversal(tx: TenantTx, previous: Locked, causeId: string, actor: string): Promise<string> {
    const original = await tx.query<{ id: string }>(
      "select id from machvon.capital_ledger_entry where appropriation_id = $1::uuid and entry_type = 'APPROPRIATE' and source_ref_kind = 'APPROPRIATION'",
      [previous.id],
    );
    const originalId = original[0]?.id;
    if (originalId === undefined) throw new Error('a published appropriation has no ledger entry to reverse');
    return this.postEntry(tx, { appropriationId: previous.id, type: 'REVERSAL', amount: previous.amountVnd, planYear: previous.planYear, sourceRefId: causeId, reversalOfId: originalId, reason: REVERSAL_REASON }, actor);
  }

  private postAppropriate(tx: TenantTx, row: Locked, actor: string): Promise<string> {
    return this.postEntry(tx, { appropriationId: row.id, type: 'APPROPRIATE', amount: row.amountVnd, planYear: row.planYear, sourceRefId: row.id }, actor);
  }

  private async postEntry(
    tx: TenantTx,
    entry: { appropriationId: string; type: 'APPROPRIATE' | 'REVERSAL'; amount: string; planYear: number; sourceRefId: string; reversalOfId?: string; reason?: string },
    actor: string,
  ): Promise<string> {
    const id = randomUUID();
    await tx.query(
      `insert into machvon.capital_ledger_entry
         (tenant_id, id, appropriation_id, entry_type, amount_vnd, plan_year, source_ref_kind, source_ref_id, reversal_of_id, reason, posted_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4::numeric, $5::integer, 'APPROPRIATION', $6::uuid, $7::uuid, $8, $9::uuid)`,
      [id, entry.appropriationId, entry.type, entry.amount, entry.planYear, entry.sourceRefId, entry.reversalOfId ?? null, entry.reason ?? null, actor],
    );
    return id;
  }
}
