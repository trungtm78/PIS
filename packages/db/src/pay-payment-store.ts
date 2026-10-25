import { randomUUID } from 'node:crypto';
import {
  DOCUMENT_KINDS,
  DomainError,
  PAYMENT_KINDS,
  ROUNDING_MODES,
  assertContractAllows,
  assertNotProposer,
  assertPlanYear,
  computeDraftMoney,
  isEditable,
  signedDong,
  versionConflict,
  wholeVnd,
} from '@machvon/kernel';
import type { AdvanceTranche, DocumentKind, DraftMoney, MoneyLine, PartyAdvance, PaymentKind, PaymentStatus, RoundingMode } from '@machvon/kernel';
import { CtrContractStore, SCOPE_FROM as CONTRACT_SCOPE_FROM, TIMESTAMP } from './ctr-contract-store.ts';
import type { ContractPlace, ContractScopes } from './ctr-contract-store.ts';
import { MasterRules } from './master-rules.ts';
import { nationalCodeReading } from './prj-stage-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 2000;
const MAX_REFERENCE = 100;
const TENANT = `nullif(current_setting('app.tenant_id', true), '')::uuid`;
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const NUMBER_CONSTRAINT = 'payment_request_no_uq';
const INVOICE_CONSTRAINT = 'payment_document_invoice_uq';
const VERSION_CONSTRAINT = 'payment_document_version_uq';
const MAX_PAGE = 200;

const invalid = (field: string, reason?: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field, reason === undefined ? undefined : { extensions: { reason } });
const idOf = (value: string, field: string): string => {
  if (!UUID.test(value)) throw invalid(field);
  return value.toLowerCase();
};
const textOf = (value: string, field: string, max = MAX_TEXT): string => {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > max) throw invalid(field);
  return trimmed;
};

/** A thing the caller should know about a request that was accepted: it is shown, never a refusal. */
export interface PaymentWarning {
  code: 'OTHER_DRAFTS_FOR_ACCEPTANCE' | 'NATIONAL_CODE_MISSING' | 'DUPLICATE_INVOICE_OTHER_CONTRACT';
  detail: Record<string, unknown>;
}

export interface CreatePaymentInput {
  contractId: string;
  requestKind: string;
  acceptanceId?: string | undefined;
  advanceId?: string | undefined;
  settlementRevisionId?: string | undefined;
  allocationLineId: string;
  requestNo: string;
  taxAdjustmentVnd?: string | undefined;
  taxAdjustmentBasis?: string | undefined;
  advanceRecoveryExtraVnd?: string | undefined;
}

export interface RevisePaymentInput {
  allocationLineId?: string | undefined;
  requestNo?: string | undefined;
  taxAdjustmentVnd?: string | undefined;
  taxAdjustmentBasis?: string | undefined;
  advanceRecoveryExtraVnd?: string | undefined;
}

export interface AttachDocumentInput {
  documentVersionId: string;
  docKind: string;
  invoiceNo?: string | undefined;
  invoiceDate?: string | undefined;
  signed?: boolean | undefined;
  duplicateOverrideReason?: string | undefined;
}

/** What the caller may do about a duplicate invoice: the permission of an approver of exceptions, judged by the controller against the scope of the contract. */
export interface OverrideAuthority {
  mayOverride: (place: ContractPlace) => boolean;
}

/** What a command answers: the request after it, with the figures the server computed. */
export interface PaymentResult {
  id: string;
  requestNo: string | null;
  requestKind: PaymentKind;
  status: PaymentStatus;
  fromStatus: PaymentStatus | null;
  version: number;
  contractId: string;
  contractCode: string;
  projectId: string;
  acceptanceId: string | null;
  allocationLineId: string | null;
  planYear: number | null;
  grossVnd: string;
  advanceRecoveryVnd: string;
  retentionVnd: string;
  taxAdjustmentVnd: string;
  netVnd: string;
  lineCount: number;
  warnings: PaymentWarning[];
}

export interface PaymentLineView {
  id: string;
  acceptanceLineId: string;
  boqItemId: string;
  boqItemKey: string;
  description: string;
  unitCode: string;
  partyId: string | null;
  quantity: string;
  unitPrice: string;
  retentionPct: string;
  grossVnd: string;
  advanceRecoveryVnd: string;
  retentionVnd: string;
  netVnd: string;
}

export interface PaymentDocumentView {
  id: string;
  documentVersionId: string;
  docKind: DocumentKind;
  checksum: string;
  invoiceNo: string | null;
  invoiceDate: string | null;
  signed: boolean;
  duplicateOverrideReason: string | null;
  duplicateOverrideBy: string | null;
  createdBy: string;
  createdAt: string;
}

export interface PaymentRequestView {
  id: string;
  requestNo: string | null;
  requestKind: PaymentKind;
  status: PaymentStatus;
  version: number;
  contract: { id: string; code: string; status: string };
  projectId: string;
  acceptance: { id: string; acceptanceNo: string; acceptedOn: string } | null;
  advanceId: string | null;
  settlementRevisionId: string | null;
  allocationLineId: string | null;
  planYear: number | null;
  grossVnd: string;
  advanceRecoveryVnd: string;
  retentionVnd: string;
  taxAdjustmentVnd: string;
  taxAdjustmentBasis: string | null;
  advanceRecoveryExtraVnd: string;
  netVnd: string;
  claimsAcceptance: boolean;
  otherDrafts: number;
  returnReason: string | null;
  cancelReason: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lines: PaymentLineView[];
  documents: PaymentDocumentView[];
  reach: ContractPlace;
}

export interface PaymentFilter {
  contractId?: string | undefined;
  status?: string | undefined;
  requestKind?: string | undefined;
  limit?: number | undefined;
  after?: { createdAt: string; id: string } | undefined;
}

interface HeaderSql {
  id: string;
  request_no: string | null;
  request_kind: PaymentKind;
  status: PaymentStatus;
  version: string;
  contract_id: string;
  contract_code: string;
  contract_status: string;
  project_id: string;
  acceptance_id: string | null;
  acceptance_no: string | null;
  accepted_on: string | null;
  advance_id: string | null;
  settlement_revision_id: string | null;
  allocation_line_id: string | null;
  plan_year: number | null;
  gross_vnd: string;
  advance_recovery_vnd: string;
  retention_vnd: string;
  tax_adjustment_vnd: string;
  tax_adjustment_basis: string | null;
  advance_recovery_extra_vnd: string;
  net_vnd: string;
  claims_acceptance: boolean;
  other_drafts: string;
  return_reason: string | null;
  cancel_reason: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  owner_unit_id: string;
  owner_unit_path: string;
  investor_unit_id: string | null;
  investor_unit_path: string | null;
}

const SELECT = `select pr.id, pr.request_no, pr.request_kind, pr.status, pr.version::text as version, c.id as contract_id, c.code as contract_code, c.status as contract_status, c.project_id,
       pr.acceptance_id, a.acceptance_no, a.accepted_on::text as accepted_on, pr.advance_id, pr.settlement_revision_id, pr.allocation_line_id, pr.plan_year,
       pr.gross_vnd::text as gross_vnd, pr.advance_recovery_vnd::text as advance_recovery_vnd, pr.retention_vnd::text as retention_vnd, pr.tax_adjustment_vnd::text as tax_adjustment_vnd,
       pr.tax_adjustment_basis, pr.advance_recovery_extra_vnd::text as advance_recovery_extra_vnd, pr.net_vnd::text as net_vnd, pr.claims_acceptance,
       (select count(*)::text from machvon.payment_request o where o.tenant_id = pr.tenant_id and o.acceptance_id = pr.acceptance_id and o.id <> pr.id and o.status in ('DRAFT', 'RETURNED')) as other_drafts,
       pr.return_reason, pr.cancel_reason, pr.created_by, ${TIMESTAMP('pr.created_at')} as created_at, ${TIMESTAMP('pr.updated_at')} as updated_at,
       ou.id as owner_unit_id, ou.path as owner_unit_path, iu.id as investor_unit_id, iu.path as investor_unit_path
  from ${CONTRACT_SCOPE_FROM}
  join machvon.payment_request pr on pr.tenant_id = c.tenant_id and pr.contract_id = c.id
  left join machvon.acceptance a on a.tenant_id = pr.tenant_id and a.id = pr.acceptance_id`;

function toView(row: HeaderSql, lines: PaymentLineView[], documents: PaymentDocumentView[]): PaymentRequestView {
  return {
    id: row.id,
    requestNo: row.request_no,
    requestKind: row.request_kind,
    status: row.status,
    version: Number(row.version),
    contract: { id: row.contract_id, code: row.contract_code, status: row.contract_status },
    projectId: row.project_id,
    acceptance: row.acceptance_id === null || row.acceptance_no === null || row.accepted_on === null ? null : { id: row.acceptance_id, acceptanceNo: row.acceptance_no, acceptedOn: row.accepted_on },
    advanceId: row.advance_id,
    settlementRevisionId: row.settlement_revision_id,
    allocationLineId: row.allocation_line_id,
    planYear: row.plan_year,
    grossVnd: row.gross_vnd,
    advanceRecoveryVnd: row.advance_recovery_vnd,
    retentionVnd: row.retention_vnd,
    taxAdjustmentVnd: row.tax_adjustment_vnd,
    taxAdjustmentBasis: row.tax_adjustment_basis,
    advanceRecoveryExtraVnd: row.advance_recovery_extra_vnd,
    netVnd: row.net_vnd,
    claimsAcceptance: row.claims_acceptance,
    otherDrafts: Number(row.other_drafts),
    returnReason: row.return_reason,
    cancelReason: row.cancel_reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines,
    documents,
    reach: {
      contractId: row.contract_id,
      projectId: row.project_id,
      ownerUnit: { id: row.owner_unit_id, path: row.owner_unit_path },
      investorUnit: row.investor_unit_id === null || row.investor_unit_path === null ? null : { id: row.investor_unit_id, path: row.investor_unit_path },
    },
  };
}

interface LockSql {
  id: string;
  request_no: string | null;
  request_kind: PaymentKind;
  status: PaymentStatus;
  version: string;
  contract_id: string;
  project_id: string;
  acceptance_id: string | null;
  advance_id: string | null;
  settlement_revision_id: string | null;
  allocation_line_id: string | null;
  tax_adjustment_vnd: string;
  tax_adjustment_basis: string | null;
  advance_recovery_extra_vnd: string;
  claims_acceptance: boolean;
  created_by: string | null;
}

interface AcceptanceSql {
  id: string;
  contract_id: string;
  status: string;
  accepted_on: string;
  approved_on: string | null;
  accepted_amount_vnd: string;
}

interface ContractSql {
  id: string;
  code: string;
  status: string;
  project_id: string;
  suspended_from: string | null;
  terminated_on: string | null;
}

/** What a request is built from, once the inputs are in and the guards have passed. */
interface Build {
  money: DraftMoney;
  /** The party each line is stored with (the line of the acceptance as it is, not the sole party it was counted under). */
  partyOfLine: Map<string, string | null>;
  planYear: number | null;
  warnings: PaymentWarning[];
}

/**
 * The payment request in its draft (ST-PAY-002, PAY 3.1 steps 1 and 2, BR-PAY-03..09, BR-PAY-14, BR-PAY-17). The server computes every figure from the approved acceptance and the ledger (the
 * client sends only the number, the line of capital, the tax adjustment with its basis and an extra recovery), keeps the request a draft that can be revised, given documents and cancelled, and
 * takes no claim on the acceptance: that is the submission. The contract is locked first, the same lock every command of money on a contract takes, so a draft is built from a ledger nobody is
 * changing. Behind these checks the database holds the same rules (V1563): the amounts of a request that is no longer a draft cannot change, the lines add up to the header at every commit, and
 * a document is a clean file of the contract.
 */
export class PayPaymentStore {
  private readonly contracts = new CtrContractStore();
  private readonly rules = new MasterRules();

  /** Draws up a request from an approved acceptance (or from a planned advance), priced by the server. */
  async create(tx: TenantTx, input: CreatePaymentInput, actor: string, scopes: ContractScopes, today: string): Promise<PaymentResult> {
    const contractId = idOf(input.contractId, 'contract_id');
    const kind = PAYMENT_KINDS.find((candidate) => candidate === input.requestKind);
    if (kind === undefined) throw invalid('request_kind');
    const requestNo = textOf(input.requestNo, 'request_no', MAX_REFERENCE);
    const allocationLineId = idOf(input.allocationLineId, 'allocation_line_id');
    const tax = this.tax(input.taxAdjustmentVnd, input.taxAdjustmentBasis);
    const extra = this.extra(input.advanceRecoveryExtraVnd);
    const advanceId = input.advanceId === undefined ? null : idOf(input.advanceId, 'advance_id');
    const settlementId = input.settlementRevisionId === undefined ? null : idOf(input.settlementRevisionId, 'settlement_revision_id');
    const acceptanceId = input.acceptanceId === undefined ? null : idOf(input.acceptanceId, 'acceptance_id');
    if (kind === 'ADVANCE' ? advanceId === null || acceptanceId !== null || settlementId !== null : acceptanceId === null || advanceId !== null) throw invalid(kind === 'ADVANCE' ? 'advance_id' : 'acceptance_id');
    if (kind === 'FINAL' ? settlementId === null : settlementId !== null) throw invalid('settlement_revision_id');

    await this.contracts.lock(tx, contractId, scopes);
    const contract = await this.contractFacts(tx, contractId);
    const built = await this.build(tx, { contract, kind, acceptanceId, advanceId, settlementId, allocationLineId, requestNo, tax, extra, today, exceptId: null });

    const id = randomUUID();
    try {
      await tx.query(
        `insert into machvon.payment_request
           (tenant_id, id, project_id, contract_id, acceptance_id, currency, gross_vnd, advance_recovery_vnd, retention_vnd, tax_adjustment_vnd, net_vnd, status, version, request_kind, request_no, advance_id,
            settlement_revision_id, allocation_line_id, plan_year, claims_acceptance, tax_adjustment_basis, advance_recovery_extra_vnd, created_by, updated_by)
         values (${TENANT}, $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'VND', $5::numeric, $6::numeric, $7::numeric, $8::numeric, $9::numeric, 'DRAFT', 1, $10, $11, $12::uuid, $13::uuid, $14::uuid, $15, false, $16,
                 $17::numeric, $18::uuid, $18::uuid)`,
        [
          id,
          contract.project_id,
          contractId,
          acceptanceId,
          built.money.grossVnd,
          built.money.advanceRecoveryVnd,
          built.money.retentionVnd,
          built.money.taxAdjustmentVnd,
          built.money.netVnd,
          kind,
          requestNo,
          advanceId,
          settlementId,
          allocationLineId,
          built.planYear,
          tax.basis,
          extra,
          actor,
        ],
      );
      await this.writeLines(tx, id, built, actor);
    } catch (error) {
      throw this.mapDatabaseRefusal(error);
    }
    return this.resultOf(tx, id, null, built.warnings);
  }

  /** Changes what the client decides of a draft (the number, the line of capital, the tax adjustment and the extra recovery) and computes the money again. A returned request becomes a draft. */
  async revise(tx: TenantTx, id: string, expectedVersion: number, input: RevisePaymentInput, actor: string, scopes: ContractScopes, today: string): Promise<PaymentResult> {
    const held = await this.lock(tx, id, expectedVersion, scopes);
    this.assertEditable(held.status);
    const requestNo = input.requestNo === undefined ? (held.request_no as string) : textOf(input.requestNo, 'request_no', MAX_REFERENCE);
    const allocationLineId = input.allocationLineId === undefined ? (held.allocation_line_id as string) : idOf(input.allocationLineId, 'allocation_line_id');
    const taxAmount = input.taxAdjustmentVnd ?? held.tax_adjustment_vnd;
    const tax = this.tax(taxAmount, input.taxAdjustmentBasis ?? (input.taxAdjustmentVnd === undefined ? held.tax_adjustment_basis ?? undefined : undefined));
    const extra = this.extra(input.advanceRecoveryExtraVnd ?? held.advance_recovery_extra_vnd);
    const contract = await this.contractFacts(tx, held.contract_id);
    const built = await this.build(tx, {
      contract,
      kind: held.request_kind,
      acceptanceId: held.acceptance_id,
      advanceId: held.advance_id,
      settlementId: held.settlement_revision_id,
      allocationLineId,
      requestNo,
      tax,
      extra,
      today,
      exceptId: held.id,
    });
    try {
      await tx.query('delete from machvon.payment_request_line where payment_request_id = $1::uuid', [id]);
      await tx.query(
        `update machvon.payment_request
            set status = 'DRAFT', request_no = $2, allocation_line_id = $3::uuid, plan_year = $4, gross_vnd = $5::numeric, advance_recovery_vnd = $6::numeric, retention_vnd = $7::numeric,
                tax_adjustment_vnd = $8::numeric, tax_adjustment_basis = $9, net_vnd = $10::numeric, advance_recovery_extra_vnd = $11::numeric, updated_at = now(), updated_by = $12::uuid, version = version + 1
          where id = $1::uuid`,
        [
          id,
          requestNo,
          allocationLineId,
          built.planYear,
          built.money.grossVnd,
          built.money.advanceRecoveryVnd,
          built.money.retentionVnd,
          built.money.taxAdjustmentVnd,
          tax.basis,
          built.money.netVnd,
          extra,
          actor,
        ],
      );
      await this.writeLines(tx, id, built, actor);
    } catch (error) {
      throw this.mapDatabaseRefusal(error);
    }
    return this.resultOf(tx, id, held.status, built.warnings);
  }

  /**
   * Attaches a document to a draft (BR-PAY-08): a clean version of a file, whose checksum is kept with it. An invoice number already used in the same contract is 409 `INVOICE_DUPLICATE`; it is
   * let through with a reason by someone the contract trusts with exceptions who is not the person who drafted the request (403 `SCOPE_DENIED`, 403 `SELF_APPROVAL_DENIED`), and the same
   * number in another contract of the tenant is only a warning.
   */
  async attachDocument(tx: TenantTx, id: string, input: AttachDocumentInput, actor: string, scopes: ContractScopes, authority: OverrideAuthority): Promise<PaymentResult> {
    const documentVersionId = idOf(input.documentVersionId, 'document_version_id');
    const docKind = DOCUMENT_KINDS.find((candidate) => candidate === input.docKind);
    if (docKind === undefined) throw invalid('doc_kind');
    const peek = await tx.query<{ contract_id: string }>('select contract_id from machvon.payment_request where id = $1::uuid', [id]);
    if (peek[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await this.contracts.lock(tx, peek[0].contract_id, scopes);
    const [held] = await tx.query<LockSql>(`${LOCK_SELECT} where pr.id = $1::uuid for update of pr`, [id]);
    if (held === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    this.assertEditable(held.status);

    const invoiceNo = docKind === 'INVOICE' ? (input.invoiceNo === undefined ? undefined : textOf(input.invoiceNo, 'invoice_no', MAX_REFERENCE)) : undefined;
    if (docKind === 'INVOICE' && (invoiceNo === undefined || input.invoiceDate === undefined)) throw invalid(invoiceNo === undefined ? 'invoice_no' : 'invoice_date');
    if (docKind !== 'INVOICE' && (input.invoiceNo !== undefined || input.invoiceDate !== undefined || input.duplicateOverrideReason !== undefined)) throw invalid('doc_kind', 'NOT_AN_INVOICE');
    const overrideReason = input.duplicateOverrideReason === undefined ? undefined : textOf(input.duplicateOverrideReason, 'duplicate_override_reason');

    const [version] = await tx.query<{ scan_status: string; checksum: string }>('select scan_status, checksum from machvon.document_version where id = $1::uuid', [documentVersionId]);
    if (version === undefined) throw invalid('document_version_id', 'NOT_FOUND');
    if (version.scan_status !== 'CLEAN') throw new DomainError('DOCUMENT_NOT_CLEAN', 422, 'document_version_id');
    if ((await tx.query('select 1 from machvon.payment_document where payment_request_id = $1::uuid and document_version_id = $2::uuid', [id, documentVersionId])).length > 0) throw invalid('document_version_id', 'ALREADY_ATTACHED');

    const warnings: PaymentWarning[] = [];
    let overrideBy: string | null = null;
    if (docKind === 'INVOICE' && invoiceNo !== undefined) {
      const same = await tx.query<{ id: string; payment_request_id: string }>(
        "select id, payment_request_id from machvon.payment_document where contract_id = $1::uuid and doc_kind = 'INVOICE' and invoice_no = $2 order by created_at, id",
        [held.contract_id, invoiceNo],
      );
      if (same[0] !== undefined) {
        if (overrideReason === undefined) throw new DomainError('INVOICE_DUPLICATE', 409, 'invoice_no', { extensions: { payment_request_id: same[0].payment_request_id, document_id: same[0].id } });
        if (!authority.mayOverride(await this.placeOf(tx, held.contract_id))) throw new DomainError('SCOPE_DENIED', 403, 'duplicate_override_reason');
        assertNotProposer(actor, [held.created_by]);
        overrideBy = actor;
      } else if (overrideReason !== undefined) {
        throw invalid('duplicate_override_reason', 'NO_DUPLICATE');
      }
      const elsewhere = await tx.query<{ contract_id: string }>(
        "select distinct contract_id from machvon.payment_document where doc_kind = 'INVOICE' and invoice_no = $2 and contract_id <> $1::uuid order by contract_id",
        [held.contract_id, invoiceNo],
      );
      if (elsewhere.length > 0) warnings.push({ code: 'DUPLICATE_INVOICE_OTHER_CONTRACT', detail: { invoice_no: invoiceNo, contract_ids: elsewhere.map((row) => row.contract_id) } });
    }
    try {
      await tx.query(
        `insert into machvon.payment_document
           (tenant_id, id, payment_request_id, contract_id, document_version_id, doc_kind, checksum, invoice_no, invoice_date, signed, duplicate_override_reason, duplicate_override_by, created_by, updated_by)
         values (${TENANT}, gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::date, $8, $9, $10::uuid, $11::uuid, $11::uuid)`,
        [id, held.contract_id, documentVersionId, docKind, version.checksum, invoiceNo ?? null, input.invoiceDate ?? null, input.signed === true, overrideReason ?? null, overrideBy, actor],
      );
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      if (failure.code === UNIQUE_VIOLATION && failure.constraint === INVOICE_CONSTRAINT) throw new DomainError('INVOICE_DUPLICATE', 409, 'invoice_no');
      if (failure.code === UNIQUE_VIOLATION && failure.constraint === VERSION_CONSTRAINT) throw invalid('document_version_id', 'ALREADY_ATTACHED');
      throw this.mapDatabaseRefusal(error);
    }
    return this.resultOf(tx, id, held.status, warnings);
  }

  /** Cancels a draft or a returned request, with a reason; a request that holds the claim on its acceptance is not cancelled but returned (409 `PAYMENT_STATE_INVALID`). */
  async cancel(tx: TenantTx, id: string, expectedVersion: number, reason: string, actor: string, scopes: ContractScopes): Promise<PaymentResult> {
    const text = textOf(reason, 'reason');
    const held = await this.lock(tx, id, expectedVersion, scopes);
    this.assertEditable(held.status);
    if (held.claims_acceptance) throw new DomainError('PAYMENT_STATE_INVALID', 409, 'id', { extensions: { reason: 'HOLDS_CLAIM', status: held.status } });
    await tx.query("update machvon.payment_request set status = 'CANCELLED', cancel_reason = $2, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid", [id, text, actor]);
    return this.resultOf(tx, id, held.status, []);
  }

  /** The requests in the scope of the caller, newest first, narrowed by contract, status and kind; the lines and documents are those of the detail. */
  async list(tx: TenantTx, scope: ScopeBuilder, filter: PaymentFilter): Promise<PaymentRequestView[]> {
    const contractId = filter.contractId === undefined ? null : idOf(filter.contractId, 'contract_id');
    const status = filter.status === undefined ? null : this.statusFilter(filter.status);
    const kind = filter.requestKind === undefined ? null : (PAYMENT_KINDS.find((candidate) => candidate === filter.requestKind) ?? this.badFilter('request_kind'));
    const predicate = scope(6);
    const rows = await tx.query<HeaderSql>(
      `${SELECT}
        where ${predicate.sql} and ($1::uuid is null or pr.contract_id = $1::uuid) and ($2::text is null or pr.status = $2) and ($3::text is null or pr.request_kind = $3)
          and ($4::text is null or (${TIMESTAMP('pr.created_at')}, pr.id) < ($4::text, $5::uuid))
        order by pr.created_at desc, pr.id desc limit ${Math.min(Math.max(filter.limit ?? 50, 1), MAX_PAGE)}`,
      [contractId, status, kind, filter.after?.createdAt ?? null, filter.after?.id ?? null, ...predicate.params],
    );
    return rows.map((row) => toView(row, [], []));
  }

  async find(tx: TenantTx, id: string, scope: ScopeBuilder): Promise<PaymentRequestView | undefined> {
    const predicate = scope(2);
    const [row] = await tx.query<HeaderSql>(`${SELECT} where pr.id = $1::uuid and ${predicate.sql}`, [id, ...predicate.params]);
    if (row === undefined) return undefined;
    const lines = await tx.query<{
      id: string;
      acceptance_line_id: string;
      boq_item_id: string;
      business_key: string;
      description: string;
      unit_code: string;
      party_id: string | null;
      quantity: string;
      unit_price: string;
      retention_pct: string;
      gross_vnd: string;
      advance_recovery_vnd: string;
      retention_vnd: string;
      net_vnd: string;
    }>(
      `select pl.id, pl.acceptance_line_id, pl.boq_item_id, i.business_key, i.description, i.unit_code, pl.party_id, al.quantity::text as quantity, al.unit_price_snapshot::text as unit_price,
              al.retention_pct_snapshot::text as retention_pct, pl.gross_vnd::text as gross_vnd, pl.advance_recovery_vnd::text as advance_recovery_vnd, pl.retention_vnd::text as retention_vnd,
              pl.net_vnd::text as net_vnd
         from machvon.payment_request_line pl
         join machvon.boq_item i on i.tenant_id = pl.tenant_id and i.id = pl.boq_item_id
         join machvon.acceptance_line al on al.tenant_id = pl.tenant_id and al.id = pl.acceptance_line_id
        where pl.payment_request_id = $1::uuid order by i.business_key, pl.id`,
      [id],
    );
    const documents = await tx.query<{
      id: string;
      document_version_id: string;
      doc_kind: DocumentKind;
      checksum: string;
      invoice_no: string | null;
      invoice_date: string | null;
      signed: boolean;
      duplicate_override_reason: string | null;
      duplicate_override_by: string | null;
      created_by: string;
      created_at: string;
    }>(
      `select id, document_version_id, doc_kind, checksum, invoice_no, invoice_date::text as invoice_date, signed, duplicate_override_reason, duplicate_override_by, created_by,
              ${TIMESTAMP('created_at')} as created_at
         from machvon.payment_document where payment_request_id = $1::uuid order by created_at, id`,
      [id],
    );
    return toView(
      row,
      lines.map((line) => ({
        id: line.id,
        acceptanceLineId: line.acceptance_line_id,
        boqItemId: line.boq_item_id,
        boqItemKey: line.business_key,
        description: line.description,
        unitCode: line.unit_code,
        partyId: line.party_id,
        quantity: line.quantity,
        unitPrice: line.unit_price,
        retentionPct: line.retention_pct,
        grossVnd: line.gross_vnd,
        advanceRecoveryVnd: line.advance_recovery_vnd,
        retentionVnd: line.retention_vnd,
        netVnd: line.net_vnd,
      })),
      documents.map((document) => ({
        id: document.id,
        documentVersionId: document.document_version_id,
        docKind: document.doc_kind,
        checksum: document.checksum,
        invoiceNo: document.invoice_no,
        invoiceDate: document.invoice_date,
        signed: document.signed,
        duplicateOverrideReason: document.duplicate_override_reason,
        duplicateOverrideBy: document.duplicate_override_by,
        createdBy: document.created_by,
        createdAt: document.created_at,
      })),
    );
  }

  // ---- internals ------------------------------------------------------------------------------------------------------------

  private badFilter(field: string): never {
    throw invalid(field);
  }

  private statusFilter(value: string): string {
    return (['DRAFT', 'SUBMITTED', 'VERIFIED', 'SENT_TREASURY', 'SETTLED', 'RETURNED', 'CANCELLED', 'REVERSED'] as const).find((candidate) => candidate === value) ?? this.badFilter('status');
  }

  private assertEditable(status: PaymentStatus): void {
    if (!isEditable(status)) throw new DomainError('PAYMENT_STATE_INVALID', 409, 'id', { extensions: { status } });
  }

  /** A tax adjustment (whole dong, signed) with the basis it rests on, which is required when it is not nothing. */
  private tax(amount: string | undefined, basis: string | undefined): { amount: string; basis: string | null } {
    const value = signedDong(amount ?? '0', 'tax_adjustment_vnd');
    const text = basis === undefined ? null : textOf(basis, 'tax_adjustment_basis');
    if (value !== 0n && text === null) throw invalid('tax_adjustment_basis', 'REQUIRED');
    return { amount: value.toString(), basis: value === 0n ? null : text };
  }

  private extra(amount: string | undefined): string {
    return wholeVnd(amount ?? '0', 'advance_recovery_extra_vnd').toString();
  }

  /** Where the contract lies (the units that own and invest in its project), for the permissions that depend on it. */
  private async placeOf(tx: TenantTx, contractId: string): Promise<ContractPlace> {
    const [row] = await tx.query<{ project_id: string; owner_unit_id: string; owner_unit_path: string; investor_unit_id: string | null; investor_unit_path: string | null }>(
      `select c.project_id, ou.id as owner_unit_id, ou.path as owner_unit_path, iu.id as investor_unit_id, iu.path as investor_unit_path from ${CONTRACT_SCOPE_FROM} where c.id = $1::uuid`,
      [contractId],
    );
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return {
      contractId,
      projectId: row.project_id,
      ownerUnit: { id: row.owner_unit_id, path: row.owner_unit_path },
      investorUnit: row.investor_unit_id === null || row.investor_unit_path === null ? null : { id: row.investor_unit_id, path: row.investor_unit_path },
    };
  }

  private async contractFacts(tx: TenantTx, contractId: string): Promise<ContractSql> {
    const [row] = await tx.query<ContractSql>('select id, code, status, project_id, suspended_from::text as suspended_from, terminated_on::text as terminated_on from machvon.contract where id = $1::uuid', [contractId]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return row;
  }

  /** The request locked for update inside the scope of the command, its contract locked first; one the caller cannot see does not exist, and a stale version is 409 `VERSION_CONFLICT`. */
  private async lock(tx: TenantTx, id: string, expectedVersion: number, scopes: ContractScopes): Promise<LockSql> {
    const peek = await tx.query<{ contract_id: string }>('select contract_id from machvon.payment_request where id = $1::uuid', [id]);
    if (peek[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await this.contracts.lock(tx, peek[0].contract_id, scopes);
    const [row] = await tx.query<LockSql>(`${LOCK_SELECT} where pr.id = $1::uuid for update of pr`, [id]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    return row;
  }

  /** The guards that come before the money, and the money. */
  private async build(
    tx: TenantTx,
    input: {
      contract: ContractSql;
      kind: PaymentKind;
      acceptanceId: string | null;
      advanceId: string | null;
      settlementId: string | null;
      allocationLineId: string;
      requestNo: string;
      tax: { amount: string; basis: string | null };
      extra: string;
      today: string;
      exceptId: string | null;
    },
  ): Promise<Build> {
    const warnings: PaymentWarning[] = [];
    const acceptance = input.acceptanceId === null ? undefined : await this.acceptanceOf(tx, input.acceptanceId, input.contract.id);
    assertContractAllows({ status: input.contract.status, suspendedFrom: input.contract.suspended_from, terminatedOn: input.contract.terminated_on }, input.kind, acceptance?.approved_on ?? null);
    if (input.settlementId !== null) await this.assertSettlement(tx, input.settlementId, input.contract.id);
    await this.assertNumberFree(tx, input.contract.id, input.requestNo, input.exceptId);
    const missingCode = await this.assertNationalCode(tx, input.contract.project_id, input.today);
    if (missingCode) warnings.push({ code: 'NATIONAL_CODE_MISSING', detail: { project_id: input.contract.project_id } });
    const planYear = await this.assertAllocation(tx, input.allocationLineId, input.contract.project_id, acceptance === undefined ? null : Number(acceptance.accepted_on.slice(0, 4)), input.today);

    if (input.kind === 'ADVANCE') {
      const money = await this.advanceMoney(tx, input.advanceId as string, input.contract.id, input.tax.amount);
      return { money, partyOfLine: new Map(), planYear, warnings };
    }
    const held = acceptance as AcceptanceSql;
    const claim = await tx.query<{ id: string }>('select id from machvon.payment_request where acceptance_id = $1::uuid and claims_acceptance order by id limit 1', [held.id]);
    if (claim[0] !== undefined) throw new DomainError('ACCEPTANCE_ALREADY_CLAIMED', 409, 'acceptance_id', { extensions: { payment_request_id: claim[0].id } });
    const others = await tx.query<{ id: string }>("select id from machvon.payment_request where acceptance_id = $1::uuid and status in ('DRAFT', 'RETURNED') and ($2::uuid is null or id <> $2::uuid) order by id", [held.id, input.exceptId]);
    if (others.length > 0) warnings.push({ code: 'OTHER_DRAFTS_FOR_ACCEPTANCE', detail: { payment_request_ids: others.map((row) => row.id) } });

    const loaded = await this.moneyInputs(tx, input.contract.id, held.id);
    const money = computeDraftMoney({ lines: loaded.lines, parties: loaded.parties, taxAdjustmentVnd: input.tax.amount, extraRecoveryVnd: input.extra });
    if (money.grossVnd !== held.accepted_amount_vnd) throw invalid('acceptance_id', 'GROSS_NOT_ACCEPTED_AMOUNT');
    return { money, partyOfLine: loaded.partyOfLine, planYear, warnings };
  }

  private async acceptanceOf(tx: TenantTx, id: string, contractId: string): Promise<AcceptanceSql> {
    const [row] = await tx.query<AcceptanceSql>(
      `select id, contract_id, status, accepted_on::text as accepted_on, (approved_at at time zone 'Asia/Ho_Chi_Minh')::date::text as approved_on, accepted_amount_vnd::text as accepted_amount_vnd
         from machvon.acceptance where id = $1::uuid`,
      [id],
    );
    if (row === undefined || row.contract_id !== contractId) throw invalid('acceptance_id', 'NOT_OF_THIS_CONTRACT');
    if (row.status !== 'APPROVED') throw new DomainError('ACCEPTANCE_NOT_APPROVED', 422, 'acceptance_id', { extensions: { acceptance_status: row.status } });
    return row;
  }

  private async assertSettlement(tx: TenantTx, id: string, contractId: string): Promise<void> {
    const [row] = await tx.query<{ contract_id: string | null }>('select contract_id from machvon.settlement_revision where id = $1::uuid', [id]);
    if (row === undefined || row.contract_id !== contractId) throw invalid('settlement_revision_id', 'NOT_OF_THIS_CONTRACT');
  }

  private async assertNumberFree(tx: TenantTx, contractId: string, requestNo: string, exceptId: string | null): Promise<void> {
    const same = await tx.query<{ id: string }>('select id from machvon.payment_request where contract_id = $1::uuid and request_no = $2 and ($3::uuid is null or id <> $3::uuid) limit 1', [contractId, requestNo, exceptId]);
    if (same[0] !== undefined) throw new DomainError('PAYMENT_REFERENCE_DUPLICATE', 409, 'request_no', { extensions: { payment_request_id: same[0].id } });
  }

  /** The rule on the national project code of the day (CXN-01): a project of the stage of the payment without a code of the right form is refused where the rule blocks and warned where it warns. */
  private async assertNationalCode(tx: TenantTx, projectId: string, today: string): Promise<boolean> {
    const rule = await this.rules.nationalCode(tx, today);
    const [project] = await tx.query<{ status: string; national_project_code: string | null }>('select status, national_project_code from machvon.project where id = $1::uuid', [projectId]);
    if (rule === undefined || project === undefined) return false;
    const reading = nationalCodeReading(rule, project.status as Parameters<typeof nationalCodeReading>[1], project.national_project_code);
    if (reading.state === 'UNMET' && reading.refusal !== undefined) throw new DomainError(reading.refusal.code, reading.refusal.status, reading.refusal.detail);
    return reading.state === 'WARNING';
  }

  /** The line of capital: of the project of the contract, in force (it has a balance), of a year the acceptance may be paid from and still open for payment (BR-PAY-14). Gives its plan year. */
  private async assertAllocation(tx: TenantTx, lineId: string, projectId: string, acceptanceYear: number | null, today: string): Promise<number> {
    const [row] = await tx.query<{ project_id: string | null; plan_year: number | null; extended_to: string | null; balanced: boolean }>(
      `select al.project_id, a.plan_year, a.extended_to::text as extended_to,
              exists (select 1 from machvon.allocation_balance b where b.tenant_id = al.tenant_id and b.allocation_line_id = al.id) as balanced
         from machvon.allocation_line al left join machvon.appropriation a on a.tenant_id = al.tenant_id and a.id = al.appropriation_id
        where al.id = $1::uuid`,
      [lineId],
    );
    if (row === undefined) throw new DomainError('ALLOCATION_UNAVAILABLE', 422, 'allocation_line_id', { extensions: { reason: 'NOT_FOUND' } });
    if (row.project_id !== projectId) throw new DomainError('ALLOCATION_UNAVAILABLE', 422, 'allocation_line_id', { extensions: { reason: 'OTHER_PROJECT' } });
    if (!row.balanced || row.plan_year === null) throw new DomainError('ALLOCATION_UNAVAILABLE', 422, 'allocation_line_id', { extensions: { reason: 'NOT_IN_FORCE' } });
    assertPlanYear(row.plan_year, acceptanceYear, row.extended_to, today);
    return row.plan_year;
  }

  private async advanceMoney(tx: TenantTx, advanceId: string, contractId: string, tax: string): Promise<DraftMoney> {
    const [row] = await tx.query<{ contract_id: string; status: string; amount_vnd: string }>('select contract_id, status, amount_vnd::text as amount_vnd from machvon.contract_advance where id = $1::uuid', [advanceId]);
    if (row === undefined || row.contract_id !== contractId) throw invalid('advance_id', 'NOT_OF_THIS_CONTRACT');
    if (row.status !== 'PLANNED') throw new DomainError('PAYMENT_STATE_INVALID', 409, 'advance_id', { extensions: { advance_status: row.status } });
    const net = BigInt(row.amount_vnd) + BigInt(tax);
    return { grossVnd: row.amount_vnd, advanceRecoveryVnd: '0', retentionVnd: '0', taxAdjustmentVnd: tax, netVnd: net.toString(), lines: [], formulaRecoveryVnd: '0' };
  }

  /** What the money is made from: the lines of the acceptance with their retention and rounding, the parties with their advances, and what each has asked to be paid before. */
  private async moneyInputs(tx: TenantTx, contractId: string, acceptanceId: string): Promise<{ lines: MoneyLine[]; parties: PartyAdvance[]; partyOfLine: Map<string, string | null> }> {
    const lines = await tx.query<{ id: string; boq_item_id: string; party_id: string | null; amount_vnd: string; retention_pct: string; rounding_rule: string | null }>(
      `select l.id, l.boq_item_id, l.party_id, l.amount_vnd::text as amount_vnd, l.retention_pct_snapshot::text as retention_pct, bl.rounding_rule
         from machvon.acceptance_line l
         left join machvon.boq_line bl on bl.tenant_id = l.tenant_id and bl.contract_revision_id = l.contract_revision_id and bl.boq_item_id = l.boq_item_id
        where l.acceptance_id = $1::uuid order by l.boq_item_id, l.id`,
      [acceptanceId],
    );
    if (lines.length === 0) throw invalid('acceptance_id', 'NO_LINES');
    const parties = await tx.query<{ id: string; work_value_vnd: string }>("select id, work_value_vnd::text as work_value_vnd from machvon.contract_party where contract_id = $1::uuid and status = 'ACTIVE' order by id", [contractId]);
    const sole = parties.length === 1 ? parties[0]?.id : undefined;
    const partyOfLine = new Map<string, string | null>();
    const moneyLines: MoneyLine[] = lines.map((line) => {
      const rounding = ROUNDING_MODES.find((mode) => mode === line.rounding_rule) as RoundingMode | undefined;
      if (rounding === undefined) throw invalid('acceptance_id', 'NO_ROUNDING_RULE');
      const counted = line.party_id ?? sole;
      if (counted === undefined) throw invalid('acceptance_id', 'PARTY_REQUIRED');
      partyOfLine.set(line.id, line.party_id);
      return { acceptanceLineId: line.id, boqItemId: line.boq_item_id, partyId: counted, grossVnd: line.amount_vnd, retentionPct: line.retention_pct, rounding };
    });
    const tranches = await tx.query<{ id: string; party_id: string; paid_vnd: string; recovered_vnd: string; recovery_threshold_pct: string }>(
      `select id, party_id, paid_vnd::text as paid_vnd, recovered_vnd::text as recovered_vnd, recovery_threshold_pct::text as recovery_threshold_pct
         from machvon.contract_advance where contract_id = $1::uuid and status in ('PAID', 'RECOVERING') and paid_vnd > 0 order by party_id, tranche_no`,
      [contractId],
    );
    const requested = await tx.query<{ party_id: string | null; gross: string }>('select party_id, sum(requested_vnd)::text as gross from machvon.cumulative_ledger where contract_id = $1::uuid group by party_id', [contractId]);
    const before = new Map<string, bigint>();
    for (const row of requested) {
      const key = row.party_id ?? sole;
      if (key !== undefined) before.set(key, (before.get(key) ?? 0n) + BigInt(row.gross));
    }
    const inDraft = [...new Set(moneyLines.map((line) => line.partyId as string))].sort();
    const advances: PartyAdvance[] = inDraft.map((partyId) => ({
      partyId,
      workValueVnd: parties.find((party) => party.id === partyId)?.work_value_vnd ?? '0',
      previousGrossVnd: (before.get(partyId) ?? 0n).toString(),
      tranches: tranches
        .filter((tranche) => tranche.party_id === partyId)
        .map((tranche): AdvanceTranche => ({ id: tranche.id, paidVnd: tranche.paid_vnd, recoveredVnd: tranche.recovered_vnd, thresholdPct: tranche.recovery_threshold_pct })),
    }));
    return { lines: moneyLines, parties: advances, partyOfLine };
  }

  private async writeLines(tx: TenantTx, requestId: string, built: Build, actor: string): Promise<void> {
    for (const line of built.money.lines) {
      await tx.query(
        `insert into machvon.payment_request_line
           (tenant_id, id, payment_request_id, acceptance_line_id, boq_item_id, party_id, gross_vnd, advance_recovery_vnd, retention_vnd, net_vnd, created_by, updated_by)
         values (${TENANT}, gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::numeric, $6::numeric, $7::numeric, $8::numeric, $9::uuid, $9::uuid)`,
        [requestId, line.acceptanceLineId, line.boqItemId, built.partyOfLine.get(line.acceptanceLineId) ?? null, line.grossVnd, line.advanceRecoveryVnd, line.retentionVnd, line.netVnd, actor],
      );
    }
  }

  /** What the database refused, in the words of the contract; anything else is not ours to explain. */
  private mapDatabaseRefusal(error: unknown): unknown {
    const failure = error as { code?: string; constraint?: string; message?: string };
    if (failure.code === UNIQUE_VIOLATION && failure.constraint === NUMBER_CONSTRAINT) return new DomainError('PAYMENT_REFERENCE_DUPLICATE', 409, 'request_no');
    if (failure.code === CHECK_VIOLATION && typeof failure.message === 'string') {
      if (failure.message.startsWith('PAYMENT_NET_MISMATCH')) return new DomainError('PAYMENT_NET_MISMATCH', 422, 'net_vnd');
      if (failure.message.startsWith('PAYMENT_STATE_INVALID')) return new DomainError('PAYMENT_STATE_INVALID', 409, 'id');
      if (failure.message.startsWith('ACCEPTANCE_NOT_APPROVED')) return new DomainError('ACCEPTANCE_NOT_APPROVED', 422, 'acceptance_id');
      if (failure.message.startsWith('DOCUMENT_NOT_CLEAN')) return new DomainError('DOCUMENT_NOT_CLEAN', 422, 'document_version_id');
    }
    return error;
  }

  private async resultOf(tx: TenantTx, id: string, fromStatus: PaymentStatus | null, warnings: PaymentWarning[]): Promise<PaymentResult> {
    const [row] = await tx.query<{
      id: string;
      request_no: string | null;
      request_kind: PaymentKind;
      status: PaymentStatus;
      version: string;
      contract_id: string;
      contract_code: string;
      project_id: string;
      acceptance_id: string | null;
      allocation_line_id: string | null;
      plan_year: number | null;
      gross_vnd: string;
      advance_recovery_vnd: string;
      retention_vnd: string;
      tax_adjustment_vnd: string;
      net_vnd: string;
      line_count: string;
    }>(
      `select pr.id, pr.request_no, pr.request_kind, pr.status, pr.version::text as version, c.id as contract_id, c.code as contract_code, c.project_id, pr.acceptance_id, pr.allocation_line_id, pr.plan_year,
              pr.gross_vnd::text as gross_vnd, pr.advance_recovery_vnd::text as advance_recovery_vnd, pr.retention_vnd::text as retention_vnd, pr.tax_adjustment_vnd::text as tax_adjustment_vnd,
              pr.net_vnd::text as net_vnd, (select count(*)::text from machvon.payment_request_line pl where pl.payment_request_id = pr.id) as line_count
         from machvon.payment_request pr join machvon.contract c on c.tenant_id = pr.tenant_id and c.id = pr.contract_id where pr.id = $1::uuid`,
      [id],
    );
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return {
      id: row.id,
      requestNo: row.request_no,
      requestKind: row.request_kind,
      status: row.status,
      fromStatus,
      version: Number(row.version),
      contractId: row.contract_id,
      contractCode: row.contract_code,
      projectId: row.project_id,
      acceptanceId: row.acceptance_id,
      allocationLineId: row.allocation_line_id,
      planYear: row.plan_year,
      grossVnd: row.gross_vnd,
      advanceRecoveryVnd: row.advance_recovery_vnd,
      retentionVnd: row.retention_vnd,
      taxAdjustmentVnd: row.tax_adjustment_vnd,
      netVnd: row.net_vnd,
      lineCount: Number(row.line_count),
      warnings,
    };
  }
}

const LOCK_SELECT = `select pr.id, pr.request_no, pr.request_kind, pr.status, pr.version::text as version, pr.contract_id, pr.project_id, pr.acceptance_id, pr.advance_id, pr.settlement_revision_id, pr.allocation_line_id,
       pr.tax_adjustment_vnd::text as tax_adjustment_vnd, pr.tax_adjustment_basis, pr.advance_recovery_extra_vnd::text as advance_recovery_extra_vnd, pr.claims_acceptance, pr.created_by
  from machvon.payment_request pr`;
