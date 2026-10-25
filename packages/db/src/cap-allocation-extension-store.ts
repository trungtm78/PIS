import { randomUUID } from 'node:crypto';
import { DomainError, MAX_DECISION_REASON, MIN_DECISION_REASON, addDecimal, assertFourEyes, compareDecimal, extensionIssues, undisbursedVnd, versionConflict, vietnamDateOf } from '@machvon/kernel';
import type { ExtensionIssue } from '@machvon/kernel';
import { CapAppropriationStore } from './cap-appropriation-store.ts';
import type { AppropriationInput } from './cap-appropriation-store.ts';
import type { PlanAuthorizer } from './cap-plan-approval-store.ts';
import { assertYearsNotLocked, assertYearsOpen } from './cap-fiscal-year-guard.ts';
import { unitOf, writeAllocatedTotals } from './cap-plan-locks.ts';
import { BalanceDriftError, CapPlanPublicationStore } from './cap-plan-publication-store.ts';
import { timestampKey } from './keyset.ts';
import { debitBalance, lockLedgerRows } from './ledger-lock.ts';
import type { TenantTx } from './tenant-database.ts';

export type ExtensionStatus = 'REQUESTED' | 'APPROVED' | 'APPLIED' | 'REJECTED' | 'LAPSED';
export type ExtensionDecision = 'approve' | 'reject';

export interface ExtensionRow {
  id: string;
  allocationLineId: string;
  projectId: string;
  fromPlanYear: number;
  /** The last day the carried-over capital may be disbursed, `YYYY-MM-DD`. */
  extendedTo: string;
  amountVnd: string;
  reasonCode: string;
  justification: string | null;
  approvingDocumentId: string | null;
  status: ExtensionStatus;
  newAllocationLineId: string | null;
  newAppropriationId: string | null;
  createdBy: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  version: number;
  /** Creation time to the microsecond (UTC): the ordering key of the list and its cursor. */
  createdAtKey: string;
}

export interface RequestExtensionInput {
  allocationLineId: string;
  amountVnd: string;
  extendedTo: string;
  reasonCode: string;
  justification?: string | undefined;
  requestedBy: string;
}

export interface DecideExtensionInput {
  extensionId: string;
  decision: ExtensionDecision;
  decidedBy: string;
  reason: string;
  /** The document that allows the extension: required to approve. */
  approvingDocumentId?: string | undefined;
  expectedVersion: number;
}

/** What an approval made: the extension as it ended, the carry-over line and appropriation of the next year, and the two ledger entries. */
export interface ExtensionApplied {
  row: ExtensionRow;
  toPlanYear: number;
  newAllocationLineId: string;
  newAppropriationId: string;
  carryOverPlanId: string;
  /** The ledger entry that took the capital out of the line of the plan year, and the one that put it into the line of the next year. */
  extendOutEntryId: string;
  extendInEntryId: string;
  /** The appropriation of the next year was revised (it already held capital of the same decision) rather than registered. */
  revisedAppropriation: boolean;
}

export interface ExtensionFilter {
  status?: ExtensionStatus | undefined;
  allocationLineId?: string | undefined;
}

interface SqlRow {
  id: string;
  allocation_line_id: string;
  project_id: string;
  from_plan_year: number;
  extended_to: string;
  amount_vnd: string;
  reason_code: string;
  justification: string | null;
  approving_document_id: string | null;
  status: ExtensionStatus;
  new_allocation_line_id: string | null;
  new_appropriation_id: string | null;
  created_by: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  version: string;
  created_at_key: string;
}

const COLUMNS = `e.id, e.allocation_line_id, e.project_id, e.from_plan_year, e.extended_to::text as extended_to, e.amount_vnd::text as amount_vnd, e.reason_code, e.justification,
  e.approving_document_id, e.status, e.new_allocation_line_id, e.new_appropriation_id, e.created_by, e.decided_by,
  to_char(e.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as decided_at, e.decision_reason, e.version::text as version, ${timestampKey('e.created_at')} as created_at_key`;

const toRow = (row: SqlRow): ExtensionRow => ({
  id: row.id,
  allocationLineId: row.allocation_line_id,
  projectId: row.project_id,
  fromPlanYear: row.from_plan_year,
  extendedTo: row.extended_to,
  amountVnd: row.amount_vnd,
  reasonCode: row.reason_code,
  justification: row.justification,
  approvingDocumentId: row.approving_document_id,
  status: row.status,
  newAllocationLineId: row.new_allocation_line_id,
  newAppropriationId: row.new_appropriation_id,
  createdBy: row.created_by,
  decidedBy: row.decided_by,
  decidedAt: row.decided_at,
  decisionReason: row.decision_reason,
  version: Number(row.version),
  createdAtKey: row.created_at_key,
});

/** The line a request is about, with the plan it belongs to and the figures of its balance. */
interface LineContext {
  lineId: string;
  projectId: string;
  appropriationId: string | null;
  bucket: string;
  isExtended: boolean;
  budgetLevel: string | null;
  fundSourceVersionId: string;
  programMasterVersionId: string | null;
  versionStatus: string;
  planId: string | null;
  planStatus: string | null;
  planKind: string | null;
  planYear: number | null;
  scopeUnitId: string | null;
  balanceId: string | null;
  allocatedVnd: string | null;
  committedVnd: string | null;
  disbursedVnd: string | null;
}

interface LineSql {
  line_id: string;
  project_id: string | null;
  appropriation_id: string | null;
  bucket: string;
  is_extended: boolean;
  budget_level: string | null;
  fund_source_version_id: string;
  program_master_version_id: string | null;
  version_status: string;
  plan_id: string | null;
  plan_status: string | null;
  plan_kind: string | null;
  plan_year: number | null;
  scope_unit_id: string | null;
  balance_id: string | null;
  allocated_vnd: string | null;
  committed_vnd: string | null;
  disbursed_vnd: string | null;
}

const LINE_SELECT = `select al.id as line_id, al.project_id, al.appropriation_id, al.bucket, al.is_extended, al.budget_level, al.fund_source_version_id, al.program_master_version_id,
    pv.status as version_status, cp.id as plan_id, cp.status as plan_status, cp.plan_kind, cp.plan_year, cp.scope_unit_id, ab.id as balance_id,
    ab.allocated_vnd::text as allocated_vnd, ab.committed_vnd::text as committed_vnd, ab.disbursed_vnd::text as disbursed_vnd
  from machvon.allocation_line al
  join machvon.plan_version pv on pv.tenant_id = al.tenant_id and pv.id = al.plan_version_id
  left join machvon.capital_plan cp on cp.tenant_id = pv.tenant_id and cp.id = pv.capital_plan_id
  left join machvon.allocation_balance ab on ab.tenant_id = al.tenant_id and ab.allocation_line_id = al.id
 where al.id = $1::uuid`;

const toContext = (row: LineSql): LineContext => ({
  lineId: row.line_id,
  projectId: row.project_id ?? '',
  appropriationId: row.appropriation_id,
  bucket: row.bucket,
  isExtended: row.is_extended,
  budgetLevel: row.budget_level,
  fundSourceVersionId: row.fund_source_version_id,
  programMasterVersionId: row.program_master_version_id,
  versionStatus: row.version_status,
  planId: row.plan_id,
  planStatus: row.plan_status,
  planKind: row.plan_kind,
  planYear: row.plan_year,
  scopeUnitId: row.scope_unit_id,
  balanceId: row.balance_id,
  allocatedVnd: row.allocated_vnd,
  committedVnd: row.committed_vnd,
  disbursedVnd: row.disbursed_vnd,
});

const USABLE_DOCUMENT_STATUSES: readonly string[] = ['PENDING', 'EFFECTIVE', 'CORRECTED'];
const UNIQUE_VIOLATION = '23505';
const LINE_KEY_INDEX = 'allocation_line_key_uq';
const MAX_UNIT_CODE_IN_PLAN_CODE = 35;

const invalid = (field: string, reason?: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field, reason === undefined ? {} : { extensions: { reason } });

/** 422 for the first thing wrong with a request: VALIDATION_FAILED naming the field, every problem in `issues`. */
export function extensionInvalid(issues: readonly ExtensionIssue[]): DomainError {
  const first = issues[0];
  return new DomainError('VALIDATION_FAILED', 422, first?.field, { extensions: { reason: first?.reason, issues: issues.map((issue) => ({ field: issue.field, reason: issue.reason })) } });
}

const notAllowed = (reason: string): DomainError => new DomainError('EXTENSION_NOT_ALLOWED', 422, 'allocation_line_id', { extensions: { reason } });

/**
 * The extension of the disbursement of capital to the next year (ST-CAP-007, CAP 3.1 F6, BR-CAP-04): a planner asks to carry the undisbursed part of a line of the plan of
 * year Y over to Y+1, and an approver who is not the planner decides it with the document that allows it. An approval is applied in the same transaction: the capital
 * leaves the line of year Y (ledger EXTEND_OUT, the balance falls, the capital of year Y is not increased and the ceiling of its appropriation keeps holding it) and enters a
 * new line of bucket CARRYOVER in the plan of year Y+1 with `source_year = Y`, `is_extended` and the last day of disbursement (ledger EXTEND_IN against an appropriation of
 * origin CARRYOVER that the decision registers, or revises when the same decision already carries capital of the same source and level), both entries with the extension as
 * their source. The balances and the ledger are compared before the transaction ends: if they disagree nothing of the approval stays.
 *
 * The carried-over lines live in a plan of their own for the year and the unit (`CARRYOVER-<year>-<unit>`), published by the approval, so no published plan of the year is
 * edited. Locks are taken in the order of the capital: the extension, the plan, the appropriations by id, then the balances in the order of `lockLedgerRows`.
 */
export class CapAllocationExtensionStore {
  private readonly appropriations: CapAppropriationStore;
  private readonly publication: CapPlanPublicationStore;

  constructor(appropriations: CapAppropriationStore = new CapAppropriationStore(), publication: CapPlanPublicationStore = new CapPlanPublicationStore()) {
    this.appropriations = appropriations;
    this.publication = publication;
  }

  /**
   * Asks to carry `amountVnd` of a line over. Refusals in order: 404 for a line that is not in the tenant, 422 EXTENSION_NOT_ALLOWED (the line is not in force in a
   * published annual plan, has no appropriation, or is itself capital carried over), 409 FISCAL_YEAR_LOCKED, 422 VALIDATION_FAILED naming the first field and 422
   * AMOUNT_EXCEEDS_UNDISBURSED when the amount is above what is allocated less committed, disbursed and promised by other open requests.
   */
  async request(tx: TenantTx, input: RequestExtensionInput, authorize: PlanAuthorizer): Promise<ExtensionRow> {
    const peek = await this.lineContext(tx, input.allocationLineId);
    if (peek.scopeUnitId !== null) authorize(await unitOf(tx, peek.scopeUnitId));
    const year = this.assertCarryable(peek);
    // The plan year may be soft-closed (the adjustment period is for carrying capital over); the next year must be open to take it.
    await assertYearsNotLocked(tx, [year]);
    await assertYearsOpen(tx, [year + 1]);
    const issues = extensionIssues({ amountVnd: input.amountVnd, extendedTo: input.extendedTo, reasonCode: input.reasonCode, justification: input.justification, fromPlanYear: year });
    if (issues.length > 0) throw extensionInvalid(issues);

    if (peek.balanceId === null) throw notAllowed('LINE_NOT_IN_FORCE');
    await lockLedgerRows(tx, [{ table: 'allocation_balance', id: peek.balanceId }]);
    const locked = await this.lineContext(tx, input.allocationLineId);
    const available = await this.availableOf(tx, locked, undefined);
    if (compareDecimal(input.amountVnd, available) > 0) throw new DomainError('AMOUNT_EXCEEDS_UNDISBURSED', 422, 'amount_vnd', { extensions: { undisbursed_vnd: available, requested_vnd: input.amountVnd } });

    const id = randomUUID();
    const [row] = await tx.query<SqlRow>(
      `with inserted as (
         insert into machvon.allocation_extension
           (tenant_id, id, allocation_line_id, project_id, from_plan_year, extended_to, amount_vnd, reason_code, justification, status, created_by, updated_by, version)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::integer, $5::date, $6::numeric, $7, $8, 'REQUESTED', $9::uuid, $9::uuid, 1)
         returning *
       ) select ${COLUMNS} from inserted e`,
      [id, locked.lineId, locked.projectId, year, input.extendedTo, input.amountVnd, input.reasonCode, input.justification?.trim() || null, input.requestedBy],
    );
    if (row === undefined) throw new Error('extension insert returned no row');
    return toRow(row);
  }

  /**
   * Decides a request. 404 for none, 409 VERSION_CONFLICT for a stale version, 409 STAGE_TRANSITION_DENIED for one that is no longer waiting, 403 SELF_APPROVAL_DENIED for the
   * person who asked, 422 VALIDATION_FAILED for a reason outside 5 to 2000 characters. Rejecting ends the request. Approving needs the document (422
   * EXTENSION_DOCUMENT_REQUIRED, also for one that is recalled, replaced or expired), a last day that has not passed, years that are not locked and an amount that is still
   * undisbursed (422 AMOUNT_EXCEEDS_UNDISBURSED), and then applies the extension.
   */
  async decide(tx: TenantTx, input: DecideExtensionInput, authorize: PlanAuthorizer, today: string = vietnamDateOf(new Date())): Promise<{ row: ExtensionRow; applied: ExtensionApplied | undefined }> {
    const reason = input.reason.trim();
    if (reason.length < MIN_DECISION_REASON || reason.length > MAX_DECISION_REASON) throw invalid('reason', 'REASON_LENGTH');
    const peek = await this.findRow(tx, input.extensionId);
    if (peek === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const context = await this.lineContext(tx, peek.allocationLineId);
    if (context.scopeUnitId !== null) authorize(await unitOf(tx, context.scopeUnitId));

    const [locked] = await tx.query<SqlRow>(`select ${COLUMNS} from machvon.allocation_extension e where e.id = $1::uuid for update`, [input.extensionId]);
    if (locked === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const current = toRow(locked);
    if (current.version !== input.expectedVersion) throw versionConflict(current.version, { status: current.status });
    if (current.status !== 'REQUESTED') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    assertFourEyes(current.createdBy, input.decidedBy);

    if (input.decision === 'reject') {
      const rejected = await this.settle(tx, current.id, "status = 'REJECTED', decided_by = $2::uuid, decided_at = now(), decision_reason = $3, updated_by = $2::uuid", [input.decidedBy, reason]);
      return { row: rejected, applied: undefined };
    }
    if (input.approvingDocumentId === undefined) throw new DomainError('EXTENSION_DOCUMENT_REQUIRED', 422, 'approving_document_id');
    await this.assertDocument(tx, input.approvingDocumentId);
    if (current.extendedTo < today) throw invalid('extended_to', 'ALREADY_ENDED');
    const year = current.fromPlanYear;
    // The plan year may be soft-closed (the adjustment period is for carrying capital over); the next year must be open to take it.
    await assertYearsNotLocked(tx, [year]);
    await assertYearsOpen(tx, [year + 1]);
    const applied = await this.apply(tx, current, context, { ...input, reason }, today);
    return { row: applied.row, applied };
  }

  /** Lets the requests that nobody decided lapse once their last day has passed (the daily job): they can no longer be approved. Returns how many. */
  async lapseDue(tx: TenantTx, today: string, actor: string): Promise<number> {
    const rows = await tx.query(
      "update machvon.allocation_extension set status = 'LAPSED', updated_at = now(), updated_by = $2::uuid, version = version + 1 where status in ('REQUESTED', 'APPROVED') and extended_to < $1::date returning id",
      [today, actor],
    );
    return rows.length;
  }

  async find(tx: TenantTx, id: string): Promise<ExtensionRow | undefined> {
    return this.findRow(tx, id);
  }

  /** The requests of the tenant, the latest first; keyset by the creation time and the id of the last one of the page before. */
  async list(tx: TenantTx, filter: ExtensionFilter, request: { limit: number; after: { code: string; id: string } | undefined }): Promise<ExtensionRow[]> {
    const rows = await tx.query<SqlRow>(
      `select ${COLUMNS} from machvon.allocation_extension e
        where ($1::text is null or e.status = $1) and ($2::uuid is null or e.allocation_line_id = $2::uuid)
          and ($3::text is null or (${timestampKey('e.created_at')}, e.id) < ($3::text, $4::uuid))
        order by e.created_at desc, e.id desc limit $5`,
      [filter.status ?? null, filter.allocationLineId ?? null, request.after?.code ?? null, request.after?.id ?? null, request.limit],
    );
    return rows.map(toRow);
  }

  // ---- the approval ----------------------------------------------------------------------------------------------------------

  private async apply(tx: TenantTx, current: ExtensionRow, peek: LineContext, input: DecideExtensionInput & { reason: string }, today: string): Promise<ExtensionApplied> {
    const documentId = input.approvingDocumentId as string;
    const fromYear = current.fromPlanYear;
    const toYear = fromYear + 1;
    if (peek.appropriationId === null || peek.balanceId === null || peek.planId === null || peek.scopeUnitId === null) throw notAllowed('LINE_NOT_IN_FORCE');
    const source = await this.sourceAppropriation(tx, peek.appropriationId);
    const unit = await unitOf(tx, peek.scopeUnitId);
    const planCode = await this.carryOverPlanCode(tx, toYear, unit.id);

    // The plan of the carried-over capital is created or found first (its row is the first lock of the capital), then the appropriations by id, then the balances.
    const carryOverPlanId = await this.carryOverPlan(tx, planCode, toYear, unit.id, documentId, current.createdBy, input.decidedBy);
    const existing = await this.liveCarryOver(tx, { documentId, toYear, fromYear, budgetLevel: source.budgetLevel, fundSourceVersionId: source.fundSourceVersionId, programMasterVersionId: source.programMasterVersionId });
    await tx.query('select 1 from machvon.appropriation where id = any($1::uuid[]) order by id for update', [[source.id, ...(existing === undefined ? [] : [existing.id])]]);
    await lockLedgerRows(tx, [{ table: 'allocation_balance', id: peek.balanceId }]);

    const line = await this.lineContext(tx, peek.lineId);
    const available = await this.availableOf(tx, line, current.id);
    if (compareDecimal(current.amountVnd, available) > 0) throw new DomainError('AMOUNT_EXCEEDS_UNDISBURSED', 422, 'amount_vnd', { extensions: { undisbursed_vnd: available, requested_vnd: current.amountVnd } });

    const issuingAuthority = await this.issuingAuthority(tx, documentId, source.issuingAuthority);
    const fundVersion = await this.inForceVersion(tx, existing?.fundSourceVersionId ?? source.fundSourceVersionId, today);
    const programOf = existing === undefined ? source.programMasterVersionId : existing.programMasterVersionId;
    const programVersion = programOf === null ? null : await this.inForceVersion(tx, programOf, today);
    // One appropriation holds the capital of a decision: it is carried to the latest last day of the lines it holds.
    const previousEnd = existing?.extendedTo ?? null;
    const extendedTo = previousEnd !== null && previousEnd > current.extendedTo ? previousEnd : current.extendedTo;
    const registration: AppropriationInput = {
      fundSourceVersionId: fundVersion,
      planYear: toYear,
      origin: 'CARRYOVER',
      budgetLevel: source.budgetLevel,
      ...(programVersion === null ? {} : { programMasterVersionId: programVersion }),
      amountVnd: existing === undefined ? current.amountVnd : addDecimal(existing.amountVnd, current.amountVnd),
      decisionDocumentId: documentId,
      issuingAuthority,
      sourceYear: fromYear,
      extendedTo,
      extensionDocumentId: documentId,
      ...(existing === undefined ? {} : { supersedesId: existing.id }),
    };
    const draft = await this.appropriations.register(tx, registration, current.createdBy, today);
    const decided = await this.appropriations.decide(tx, draft.id, draft.version, 'approve', input.decidedBy, today);
    const newAppropriationId = draft.id;
    // What the revision carried is the allocated total of the one it replaced; this extension adds its own amount to it.
    const carried = existing?.allocatedTotalVnd ?? '0';
    await writeAllocatedTotals(tx, [{ id: newAppropriationId, amountVnd: current.amountVnd, allocatedBeforeVnd: carried, allocatedAfterVnd: addDecimal(carried, current.amountVnd) }], input.decidedBy);

    const planVersionId = await this.carryOverVersion(tx, carryOverPlanId, peek.projectId, toYear, documentId, current.createdBy, input.decidedBy);
    const newLineId = await this.insertLine(tx, {
      planVersionId,
      fundSourceVersionId: fundVersion,
      appropriationId: newAppropriationId,
      projectId: peek.projectId,
      budgetLevel: source.budgetLevel,
      programMasterVersionId: programVersion,
      sourceYear: fromYear,
      amountVnd: current.amountVnd,
      extendedTo: current.extendedTo,
      documentId,
      createdBy: current.createdBy,
      updatedBy: input.decidedBy,
    });
    await tx.query(
      `insert into machvon.allocation_balance (tenant_id, id, allocation_line_id, allocated_vnd, reserved_vnd, committed_vnd, disbursed_vnd)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::numeric, 0, 0, 0)`,
      [randomUUID(), newLineId, current.amountVnd],
    );
    await debitBalance(tx, { table: 'allocation_balance', id: peek.balanceId, column: 'allocated_vnd' }, current.amountVnd);

    const extendOutEntryId = await this.postEntry(tx, { type: 'EXTEND_OUT', appropriationId: source.id, lineId: peek.lineId, projectId: peek.projectId, planYear: fromYear, amountVnd: current.amountVnd, extensionId: current.id, actor: input.decidedBy });
    const extendInEntryId = await this.postEntry(tx, { type: 'EXTEND_IN', appropriationId: newAppropriationId, lineId: newLineId, projectId: peek.projectId, planYear: toYear, amountVnd: current.amountVnd, extensionId: current.id, actor: input.decidedBy });

    // The ledger and the balances were written together: if they disagree now, nothing of the approval may stay.
    const drift = await this.publication.balanceDrift(tx, [peek.projectId]);
    if (drift.length > 0) throw new BalanceDriftError(drift);

    const row = await this.settle(
      tx,
      current.id,
      `status = 'APPLIED', approved_by = $2::uuid, decided_by = $2::uuid, decided_at = now(), decision_reason = $3, approving_document_id = $4::uuid,
       new_allocation_line_id = $5::uuid, new_appropriation_id = $6::uuid, updated_by = $2::uuid`,
      [input.decidedBy, input.reason, documentId, newLineId, newAppropriationId],
    );
    return { row, toPlanYear: toYear, newAllocationLineId: newLineId, newAppropriationId, carryOverPlanId, extendOutEntryId, extendInEntryId, revisedAppropriation: decided.supersededId !== null };
  }

  /** The figures of the line that may still be carried over, other open requests on it taken off (the one being decided excluded). */
  private async availableOf(tx: TenantTx, line: LineContext, exceptId: string | undefined): Promise<string> {
    if (line.allocatedVnd === null || line.committedVnd === null || line.disbursedVnd === null) throw notAllowed('LINE_NOT_IN_FORCE');
    const [open] = await tx.query<{ total: string }>(
      "select coalesce(sum(amount_vnd), 0)::text as total from machvon.allocation_extension where allocation_line_id = $1::uuid and status in ('REQUESTED', 'APPROVED') and ($2::uuid is null or id <> $2::uuid)",
      [line.lineId, exceptId ?? null],
    );
    return undisbursedVnd({ allocatedVnd: line.allocatedVnd, committedVnd: line.committedVnd, disbursedVnd: line.disbursedVnd }, open?.total ?? '0');
  }

  /** The year of the plan the line is in, when the line may be carried over; the refusal otherwise. */
  private assertCarryable(line: LineContext): number {
    if (line.planStatus !== 'PUBLISHED' || line.versionStatus !== 'PUBLISHED' || line.balanceId === null) throw notAllowed('LINE_NOT_IN_FORCE');
    if (line.isExtended || line.bucket === 'CARRYOVER') throw notAllowed('ALREADY_EXTENDED');
    if (line.planKind !== 'ANNUAL' || line.planYear === null) throw notAllowed('PLAN_NOT_ANNUAL');
    if (line.appropriationId === null || line.projectId === '') throw notAllowed('NO_APPROPRIATION');
    return line.planYear;
  }

  private async lineContext(tx: TenantTx, lineId: string): Promise<LineContext> {
    const [row] = await tx.query<LineSql>(LINE_SELECT, [lineId]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return toContext(row);
  }

  private async findRow(tx: TenantTx, id: string): Promise<ExtensionRow | undefined> {
    const [row] = await tx.query<SqlRow>(`select ${COLUMNS} from machvon.allocation_extension e where e.id = $1::uuid`, [id]);
    return row === undefined ? undefined : toRow(row);
  }

  private async settle(tx: TenantTx, id: string, assignments: string, params: unknown[]): Promise<ExtensionRow> {
    const [row] = await tx.query<SqlRow>(
      `with updated as (update machvon.allocation_extension e set ${assignments}, updated_at = now(), version = e.version + 1 where e.id = $1::uuid returning e.*) select ${COLUMNS} from updated e`,
      [id, ...params],
    );
    if (row === undefined) throw new Error('extension update returned no row');
    return toRow(row);
  }

  private async assertDocument(tx: TenantTx, documentId: string): Promise<void> {
    const rows = await tx.query<{ effect_status: string }>('select effect_status from machvon.document where id = $1::uuid', [documentId]);
    // A document of another tenant is indistinguishable from one that does not exist.
    if (rows[0] === undefined || !USABLE_DOCUMENT_STATUSES.includes(rows[0].effect_status)) throw new DomainError('EXTENSION_DOCUMENT_REQUIRED', 422, 'approving_document_id');
  }

  private async sourceAppropriation(tx: TenantTx, appropriationId: string): Promise<{ id: string; budgetLevel: 'CENTRAL' | 'LOCAL'; fundSourceVersionId: string; programMasterVersionId: string | null; issuingAuthority: string }> {
    const [row] = await tx.query<{ id: string; budget_level: 'CENTRAL' | 'LOCAL'; fund_source_version_id: string; program_master_version_id: string | null; issuing_authority: string }>(
      'select id, budget_level, fund_source_version_id, program_master_version_id, issuing_authority from machvon.appropriation where id = $1::uuid',
      [appropriationId],
    );
    if (row === undefined) throw notAllowed('NO_APPROPRIATION');
    return { id: row.id, budgetLevel: row.budget_level, fundSourceVersionId: row.fund_source_version_id, programMasterVersionId: row.program_master_version_id, issuingAuthority: row.issuing_authority };
  }

  /** The authority that issued the approving document, as the register wants it written; the authority of the source capital when the document does not name one. */
  private async issuingAuthority(tx: TenantTx, documentId: string, fallback: string): Promise<string> {
    const [row] = await tx.query<{ issuer_name: string | null }>('select issuer_name from machvon.document where id = $1::uuid', [documentId]);
    const name = row?.issuer_name?.trim();
    // eslint-disable-next-line no-control-regex
    return name !== undefined && name.length >= 2 && name.length <= 300 && !/[\u0000-\u001f\u007f]/.test(name) ? name : fallback;
  }

  /** The version of a master entry that is in force today: the one given when it is, else the latest published version of the same entry. */
  private async inForceVersion(tx: TenantTx, versionId: string, today: string): Promise<string> {
    const [row] = await tx.query<{ id: string }>(
      `select v2.id from machvon.master_record_version v join machvon.master_record_version v2 on v2.tenant_id = v.tenant_id and v2.master_record_id = v.master_record_id
        where v.id = $1::uuid and v2.published_at is not null and v2.valid_from <= $2::date and (v2.valid_until is null or v2.valid_until > $2::date) and v2.status in ('APPROVED', 'EFFECTIVE')
        order by (v2.id = v.id) desc, v2.valid_from desc, v2.revision desc limit 1`,
      [versionId, today],
    );
    return row?.id ?? versionId;
  }

  /** The published appropriation of the next year that already carries capital of this decision, source year, fund source, program and level (its revision is made, not a second registration). */
  private async liveCarryOver(
    tx: TenantTx,
    key: { documentId: string; toYear: number; fromYear: number; budgetLevel: string; fundSourceVersionId: string; programMasterVersionId: string | null },
  ): Promise<{ id: string; amountVnd: string; allocatedTotalVnd: string; extendedTo: string | null; fundSourceVersionId: string; programMasterVersionId: string | null } | undefined> {
    const [row] = await tx.query<{ id: string; amount_vnd: string; allocated_total_vnd: string; extended_to: string | null; fund_source_version_id: string; program_master_version_id: string | null }>(
      `select a.id, a.amount_vnd::text as amount_vnd, a.allocated_total_vnd::text as allocated_total_vnd, a.extended_to::text as extended_to, a.fund_source_version_id, a.program_master_version_id
         from machvon.appropriation a
         join machvon.master_record_version fv on fv.tenant_id = a.tenant_id and fv.id = a.fund_source_version_id
         join machvon.master_record_version wanted on wanted.tenant_id = a.tenant_id and wanted.id = $5::uuid
         left join machvon.master_record_version pv on pv.tenant_id = a.tenant_id and pv.id = a.program_master_version_id
         left join machvon.master_record_version wp on wp.tenant_id = a.tenant_id and wp.id = $6::uuid
        where a.status = 'PUBLISHED' and a.origin = 'CARRYOVER' and a.decision_document_id = $1::uuid and a.plan_year = $2::integer and a.source_year = $3::integer and a.budget_level = $4
          and fv.master_record_id = wanted.master_record_id and pv.master_record_id is not distinct from wp.master_record_id
        order by a.id limit 1`,
      [key.documentId, key.toYear, key.fromYear, key.budgetLevel, key.fundSourceVersionId, key.programMasterVersionId],
    );
    return row === undefined
      ? undefined
      : { id: row.id, amountVnd: row.amount_vnd, allocatedTotalVnd: row.allocated_total_vnd, extendedTo: row.extended_to, fundSourceVersionId: row.fund_source_version_id, programMasterVersionId: row.program_master_version_id };
  }

  /** `CARRYOVER-<year>-<unit code>` (50 characters at most): the plan the carried-over lines of a year and a unit live in. */
  private async carryOverPlanCode(tx: TenantTx, toYear: number, unitId: string): Promise<string> {
    const [row] = await tx.query<{ code: string }>('select code from machvon.organization_unit where id = $1::uuid', [unitId]);
    const code = row?.code ?? '';
    // eslint-disable-next-line no-control-regex
    const suffix = code.length > 0 && code.length <= MAX_UNIT_CODE_IN_PLAN_CODE && !/[\u0000-\u001f\u007f]/.test(code) ? code : unitId.slice(0, 8);
    return `CARRYOVER-${toYear}-${suffix}`;
  }

  /** The published plan of a code, created by the first approval that needs it (published at once: the decision document of the extension is its decision). */
  private async carryOverPlan(tx: TenantTx, planCode: string, toYear: number, unitId: string, documentId: string, requester: string, approver: string): Promise<string> {
    await tx.query(
      `insert into machvon.capital_plan
         (tenant_id, id, plan_code, plan_kind, plan_year, period_from_year, period_to_year, scope_unit_id, revision, status, decision_document_id, effective_at, submitted_by, approved_by,
          published_at, published_by, created_by, updated_by, version)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, 'ANNUAL', $3::integer, $3::integer, $3::integer, $4::uuid, 1, 'PUBLISHED', $5::uuid, now(), $6::uuid, $7::uuid,
               now(), $7::uuid, $6::uuid, $7::uuid, 1)
       on conflict (tenant_id, plan_code, revision) do nothing`,
      [randomUUID(), planCode, toYear, unitId, documentId, requester, approver],
    );
    const [row] = await tx.query<{ id: string }>("select id from machvon.capital_plan where plan_code = $1 and status = 'PUBLISHED' order by revision desc limit 1 for update", [planCode]);
    if (row === undefined) throw new DomainError('PLAN_CHANGED_SINCE_PROPOSAL', 409, 'plan_code');
    return row.id;
  }

  /** The version of the carried-over plan for a project: one per project, its lines added as extensions are approved. */
  private async carryOverVersion(tx: TenantTx, planId: string, projectId: string, toYear: number, documentId: string, requester: string, approver: string): Promise<string> {
    const [existing] = await tx.query<{ id: string }>('select id from machvon.plan_version where capital_plan_id = $1::uuid and project_id = $2::uuid', [planId, projectId]);
    if (existing !== undefined) return existing.id;
    const id = randomUUID();
    await tx.query(
      `insert into machvon.plan_version
         (tenant_id, id, project_id, fiscal_year, revision, decision_id, status, effective_at, capital_plan_id, approved_by, published_at, created_by, updated_by, version)
       select nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::integer, cp.revision, $4::uuid, 'PUBLISHED', coalesce(cp.effective_at, now()), cp.id, $6::uuid, now(), $5::uuid, $6::uuid, 1
         from machvon.capital_plan cp where cp.id = $7::uuid`,
      [id, projectId, toYear, documentId, requester, approver, planId],
    );
    return id;
  }

  private async insertLine(
    tx: TenantTx,
    line: {
      planVersionId: string;
      fundSourceVersionId: string;
      appropriationId: string;
      projectId: string;
      budgetLevel: string;
      programMasterVersionId: string | null;
      sourceYear: number;
      amountVnd: string;
      extendedTo: string;
      documentId: string;
      createdBy: string;
      updatedBy: string;
    },
  ): Promise<string> {
    const id = randomUUID();
    await tx.query('savepoint allocation_extension_line');
    try {
      await tx.query(
        `insert into machvon.allocation_line
           (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, appropriation_id, project_id, budget_level, origin,
            is_extended, extended_to, extension_document_id, program_master_version_id, created_by, updated_by, version)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, 'CARRYOVER', $4::integer, $5::numeric, 0, $6::uuid, $7::uuid, $8, 'CARRYOVER',
                 true, $9::date, $10::uuid, $11::uuid, $12::uuid, $13::uuid, 1)`,
        [id, line.planVersionId, line.fundSourceVersionId, line.sourceYear, line.amountVnd, line.appropriationId, line.projectId, line.budgetLevel, line.extendedTo, line.documentId, line.programMasterVersionId, line.createdBy, line.updatedBy],
      );
      await tx.query('release savepoint allocation_extension_line');
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      if (failure.code === UNIQUE_VIOLATION && failure.constraint === LINE_KEY_INDEX) {
        await tx.query('rollback to savepoint allocation_extension_line');
        // The project already has a carried-over line on this appropriation for this source year: a line of a published plan is not edited, so a second one cannot be added.
        throw new DomainError('APPROPRIATION_DUPLICATE', 409, 'allocation_line_id', { extensions: { reason: 'CARRYOVER_LINE_EXISTS' } });
      }
      throw error;
    }
    return id;
  }

  private async postEntry(
    tx: TenantTx,
    entry: { type: 'EXTEND_OUT' | 'EXTEND_IN'; appropriationId: string; lineId: string; projectId: string; planYear: number; amountVnd: string; extensionId: string; actor: string },
  ): Promise<string> {
    const id = randomUUID();
    await tx.query(
      `insert into machvon.capital_ledger_entry
         (tenant_id, id, appropriation_id, allocation_line_id, project_id, entry_type, amount_vnd, plan_year, source_ref_kind, source_ref_id, posted_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::numeric, $7::integer, 'EXTENSION', $8::uuid, $9::uuid)`,
      [id, entry.appropriationId, entry.lineId, entry.projectId, entry.type, entry.amountVnd, entry.planYear, entry.extensionId, entry.actor],
    );
    return id;
  }
}
