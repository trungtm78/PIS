import { randomUUID } from 'node:crypto';
import { DomainError, assertSubcontractApproval, assertSubcontractPayment, assessSubcontract, hasControlChar, moveSubcontract, paidExcess, paymentConfirmationState, vietnamDateOf, versionConflict } from '@machvon/kernel';
import type { PaymentConfirmationState, SubcontractAssessment, SubcontractPolicy, SubcontractState } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';
import { VendorGate } from './vendor-gate.ts';
import { VendorPolicyReader } from './vendor-policy.ts';
import type { Policy } from './vendor-policy.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const iso = (column: string): string => `to_char(${column} at time zone 'UTC', ${ISO})`;
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const CLOSED_CONTRACT = ['CANCELLED', 'TERMINATED', 'CLOSED', 'COMPLETED'];
const SHARE = /^\d{1,3}(\.\d{1,4})?$/;

export interface SubcontractRow {
  id: string;
  contractId: string;
  contractCode: string;
  subcontractorId: string;
  subcontractorName: string;
  scope: string;
  value: number;
  sharePct: number;
  declaredInBid: boolean;
  state: SubcontractState;
  proposedBy: string;
  proposedAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  exceptionReason: string | null;
  exceptionApproved: boolean;
  assessment: { findings: string[]; total_share_pct: number; prime_share_pct: number } | null;
  ruleVersion: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  version: number;
}

export interface SubcontractPaymentRow {
  id: string;
  subcontractId: string;
  paymentRequestId: string | null;
  paidAmount: number;
  paidOn: string;
  reference: string;
  recordedBy: string;
  recordedAt: string;
  confirmedBySubcontractor: boolean;
  subcontractorConfirmedAt: string | null;
  /** MET or MET_LATE by the day the prime recorded it against the due day of its payment request; NOT_REQUIRED when the record is not tied to a payment request. */
  clock: PaymentConfirmationState;
}

/** A payment request of the prime that was paid and has no record of what it paid one of its approved subcontractors. */
export interface PendingConfirmation {
  subcontractId: string;
  contractId: string;
  contractCode: string;
  subcontractorId: string;
  subcontractorName: string;
  paymentRequestId: string;
  paidOn: string;
  clock: PaymentConfirmationState;
}

export interface DeclarationRow {
  id: string;
  packageId: string;
  contractorId: string;
  declaredSharePct: number;
  subcontractorIds: string[];
  documentId: string | null;
  declaredBy: string;
  declaredAt: string;
}

export interface SubcontractListing {
  contractId: string;
  contractCode: string;
  contractValue: number;
  primeContractorId: string;
  items: Array<SubcontractRow & { payments: SubcontractPaymentRow[]; paidTotal: number; overPaid: number }>;
  totalSharePct: number;
  primeSharePct: number;
  declaration: DeclarationRow | null;
  pending: PendingConfirmation[];
  policy: Policy<SubcontractPolicy>;
}

export interface NewSubcontract {
  contractId: string;
  subcontractorId: string;
  scope: string;
  value: number;
  sharePct: string;
}

interface Sql {
  id: string;
  contract_id: string;
  contract_code: string;
  subcontractor_id: string;
  subcontractor_name: string;
  scope: string;
  value: string;
  share_pct: string;
  declared_in_bid: boolean;
  state: SubcontractState;
  proposed_by: string;
  proposed_at: string;
  approved_by: string | null;
  approved_at: string | null;
  exception_reason: string | null;
  exception_approved: boolean;
  assessment: SubcontractRow['assessment'];
  rule_version: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  version: string;
}

const SELECT = `select s.id, s.contract_id, k.code as contract_code, s.subcontractor_id, c.legal_name as subcontractor_name, s.scope, s.value::text as value, s.share_pct::text as share_pct, s.declared_in_bid, s.state, s.proposed_by,
  ${iso('s.proposed_at')} as proposed_at, s.approved_by, ${iso('s.approved_at')} as approved_at, s.exception_reason, s.exception_approved, s.assessment, s.rule_version, s.decided_by, ${iso('s.decided_at')} as decided_at,
  s.decision_reason, s.version::text as version
  from machvon.vendor_subcontract s
  join machvon.contract k on k.tenant_id = s.tenant_id and k.id = s.contract_id
  join machvon.contractor c on c.tenant_id = s.tenant_id and c.id = s.subcontractor_id`;

const toRow = (row: Sql): SubcontractRow => ({
  id: row.id,
  contractId: row.contract_id,
  contractCode: row.contract_code,
  subcontractorId: row.subcontractor_id,
  subcontractorName: row.subcontractor_name,
  scope: row.scope,
  value: Number(row.value),
  sharePct: Number(row.share_pct),
  declaredInBid: row.declared_in_bid,
  state: row.state,
  proposedBy: row.proposed_by,
  proposedAt: row.proposed_at,
  approvedBy: row.approved_by,
  approvedAt: row.approved_at,
  exceptionReason: row.exception_reason,
  exceptionApproved: row.exception_approved,
  assessment: row.assessment,
  ruleVersion: row.rule_version,
  decidedBy: row.decided_by,
  decidedAt: row.decided_at,
  decisionReason: row.decision_reason,
  version: Number(row.version),
});

const reasoned = (value: string, field: string, min: number): string => {
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > 2000 || hasControlChar(trimmed)) throw new DomainError('REASON_REQUIRED', 422, field);
  return trimmed;
};

interface ContractFacts {
  id: string;
  code: string;
  packageId: string;
  contractorId: string;
  status: string;
  value: number;
}

/**
 * Subcontracts and what the prime paid them (VND-2, V11; docs/vendor-controls-security-subcontract.md). The assessment against the declaration of the bid and the limits of the rule is the kernel's
 * (`assessSubcontract`); an approval runs it again on the day (the declaration may have been replaced), asks the gate SUBCONTRACT of VND-1 about the subcontractor and the contract, and keeps the assessment and the
 * rule version on the row. The approver is a person other than the proposer (the database holds that too). A payment record is written once; its clock is counted from the day the payment request was paid.
 */
export class VendorSubcontractStore {
  private readonly policies: VendorPolicyReader;
  private readonly gate: VendorGate;

  constructor(policies: VendorPolicyReader = new VendorPolicyReader(), gate: VendorGate = new VendorGate(policies)) {
    this.policies = policies;
    this.gate = gate;
  }

  private async contractOf(tx: TenantTx, contractId: string): Promise<ContractFacts> {
    const [row] = await tx.query<{ id: string; code: string; package_id: string; contractor_id: string; status: string; value: string | null }>(
      `select k.id, k.code, k.package_id, k.contractor_id, k.status, coalesce((select r.amount_vnd::text from machvon.contract_revision r where r.id = k.current_revision_id), (select r.amount_vnd::text from machvon.contract_revision r where r.contract_id = k.id order by r.revision desc limit 1)) as value from machvon.contract k where k.id = $1::uuid`,
      [contractId],
    );
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'contract_id');
    return { id: row.id, code: row.code, packageId: row.package_id, contractorId: row.contractor_id, status: row.status, value: Number(row.value ?? 0) };
  }

  // -- The declaration of the bid ----------------------------------------------------------------------------------------------------------------------------------------------------------

  async declaration(tx: TenantTx, packageId: string, contractorId: string): Promise<DeclarationRow | null> {
    const [row] = await tx.query<{ id: string; package_id: string; contractor_id: string; declared_share_pct: string; document_id: string | null; declared_by: string; declared_at: string }>(
      `select id, package_id, contractor_id, declared_share_pct::text as declared_share_pct, document_id, declared_by, ${iso('declared_at')} as declared_at from machvon.vendor_bid_declaration where package_id = $1::uuid and contractor_id = $2::uuid and superseded_at is null`,
      [packageId, contractorId],
    );
    if (row === undefined) return null;
    const subs = await tx.query<{ subcontractor_id: string }>('select subcontractor_id from machvon.vendor_bid_declaration_subcontractor where declaration_id = $1::uuid order by subcontractor_id', [row.id]);
    return { id: row.id, packageId: row.package_id, contractorId: row.contractor_id, declaredSharePct: Number(row.declared_share_pct), subcontractorIds: subs.map((one) => one.subcontractor_id), documentId: row.document_id, declaredBy: row.declared_by, declaredAt: row.declared_at };
  }

  /** Records what the bid of a contractor declared about subcontracting; a new declaration supersedes the one before (it stays as what the bid once said). */
  async declare(tx: TenantTx, input: { packageId: string; contractorId: string; declaredSharePct: string; subcontractorIds: readonly string[]; documentId?: string | undefined }, actor: string): Promise<DeclarationRow> {
    if (!SHARE.test(input.declaredSharePct) || Number(input.declaredSharePct) > 100) throw invalid('declared_share_pct');
    if ((await tx.query('select 1 from machvon.procurement_package where id = $1::uuid', [input.packageId])).length === 0) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'package_id');
    if ((await tx.query('select 1 from machvon.contractor where id = $1::uuid', [input.contractorId])).length === 0) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'contractor_id');
    const unique = [...new Set(input.subcontractorIds)];
    if (unique.length !== input.subcontractorIds.length || unique.includes(input.contractorId) || unique.length > 50) throw invalid('subcontractor_ids');
    if (unique.length > 0 && (await tx.query<{ id: string }>('select id from machvon.contractor where id = any($1::uuid[])', [unique])).length !== unique.length) throw invalid('subcontractor_ids');
    if (Number(input.declaredSharePct) > 0 && unique.length === 0) throw invalid('subcontractor_ids');
    if (input.documentId !== undefined && (await tx.query('select 1 from machvon.document where id = $1::uuid', [input.documentId])).length === 0) throw invalid('document_id');
    const id = randomUUID();
    await tx.query('update machvon.vendor_bid_declaration set superseded_at = now(), superseded_by = $3::uuid where package_id = $1::uuid and contractor_id = $2::uuid and superseded_at is null', [input.packageId, input.contractorId, id]);
    await tx.query(
      `insert into machvon.vendor_bid_declaration (tenant_id, id, package_id, contractor_id, declared_share_pct, document_id, declared_by) values (${TENANT}, $1::uuid, $2::uuid, $3::uuid, $4::numeric, $5::uuid, $6::uuid)`,
      [id, input.packageId, input.contractorId, input.declaredSharePct, input.documentId ?? null, actor],
    );
    for (const one of unique) await tx.query(`insert into machvon.vendor_bid_declaration_subcontractor (tenant_id, declaration_id, subcontractor_id) values (${TENANT}, $1::uuid, $2::uuid)`, [id, one]);
    return (await this.declaration(tx, input.packageId, input.contractorId)) as DeclarationRow;
  }

  // -- Subcontracts ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  async find(tx: TenantTx, id: string, lock = false): Promise<SubcontractRow | undefined> {
    const rows = await tx.query<Sql>(`${SELECT} where s.id = $1::uuid${lock ? ' for update of s' : ''}`, [id]);
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  private async locked(tx: TenantTx, id: string, expectedVersion: number): Promise<SubcontractRow> {
    const row = await this.find(tx, id, true);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (row.version !== expectedVersion) throw versionConflict(row.version);
    return row;
  }

  /** The assessment of a subcontract on a day against the contract, the approved ones next to it, the declaration of the bid and the rule. */
  async assess(tx: TenantTx, subcontract: Pick<SubcontractRow, 'id' | 'contractId' | 'subcontractorId' | 'value' | 'sharePct'>, today: string): Promise<{ assessment: SubcontractAssessment; policy: Policy<SubcontractPolicy>; declaration: DeclarationRow | null }> {
    const contract = await this.contractOf(tx, subcontract.contractId);
    const parties = await tx.query<{ contractor_id: string }>("select contractor_id from machvon.contract_party where contract_id = $1::uuid and status = 'ACTIVE'", [contract.id]);
    const approved = (await tx.query<Sql>(`${SELECT} where s.contract_id = $1::uuid and s.state = 'APPROVED' and s.id <> $2::uuid`, [contract.id, subcontract.id])).map(toRow);
    const declaration = await this.declaration(tx, contract.packageId, contract.contractorId);
    const policy = await this.policies.subcontract(tx, today);
    const assessment = assessSubcontract(
      {
        contractValue: contract.value,
        primeContractorIds: [...new Set([contract.contractorId, ...parties.map((row) => row.contractor_id)])],
        approved: approved.map((row) => ({ id: row.id, contractorId: row.subcontractorId, value: row.value, sharePct: row.sharePct, state: row.state, exceptionApproved: row.exceptionApproved })),
        proposal: { contractorId: subcontract.subcontractorId, value: subcontract.value, sharePct: subcontract.sharePct },
        declaration: declaration === null ? null : { declaredContractorIds: declaration.subcontractorIds, declaredSharePct: declaration.declaredSharePct },
      },
      policy.value,
    );
    return { assessment, policy, declaration };
  }

  async propose(tx: TenantTx, input: NewSubcontract, actor: string): Promise<SubcontractRow> {
    const contract = await this.contractOf(tx, input.contractId);
    if (CLOSED_CONTRACT.includes(contract.status)) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'contract_id');
    if ((await tx.query('select 1 from machvon.contractor where id = $1::uuid', [input.subcontractorId])).length === 0) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'subcontractor_id');
    if (!SHARE.test(input.sharePct) || Number(input.sharePct) <= 0 || Number(input.sharePct) > 100) throw invalid('share_pct');
    if (!Number.isSafeInteger(input.value) || input.value <= 0) throw invalid('value');
    const scope = input.scope.trim();
    if (scope.length < 5 || scope.length > 2000 || hasControlChar(scope)) throw invalid('scope');
    const declaration = await this.declaration(tx, contract.packageId, contract.contractorId);
    const named = declaration?.subcontractorIds.includes(input.subcontractorId) ?? false;
    const id = randomUUID();
    const clash = await tx.query("select 1 from machvon.vendor_subcontract where contract_id = $1::uuid and subcontractor_id = $2::uuid and state in ('PROPOSED', 'APPROVED')", [input.contractId, input.subcontractorId]);
    if (clash.length > 0) throw new DomainError('SUBCONTRACT_LIMIT_EXCEEDED', 422, 'subcontractor_id', { extensions: { findings: ['DUPLICATE_SUBCONTRACTOR'] } });
    await tx.query(
      `insert into machvon.vendor_subcontract (tenant_id, id, contract_id, subcontractor_id, scope, value, share_pct, declared_in_bid, proposed_by) values (${TENANT}, $1::uuid, $2::uuid, $3::uuid, $4, $5::numeric, $6::numeric, $7, $8::uuid)`,
      [id, input.contractId, input.subcontractorId, scope, input.value, input.sharePct, named, actor],
    );
    return (await this.find(tx, id)) as SubcontractRow;
  }

  /** Approves a proposal: another person than the proposer; the assessment is run again, an exception needs its reason, a blocked one is 422 `SUBCONTRACT_LIMIT_EXCEEDED`, and the gate SUBCONTRACT of VND-1 is asked about the subcontractor. */
  async approve(tx: TenantTx, id: string, expectedVersion: number, exceptionReason: string | undefined, actor: string, now: Date): Promise<SubcontractRow> {
    const current = await this.locked(tx, id, expectedVersion);
    moveSubcontract(current.state, 'APPROVE', actor, current.proposedBy);
    const today = vietnamDateOf(now);
    const { assessment, policy } = await this.assess(tx, current, today);
    try {
      assertSubcontractApproval(assessment, exceptionReason);
    } catch (failure) {
      if (failure instanceof DomainError && failure.code === 'SUBCONTRACT_LIMIT_EXCEEDED') throw new DomainError('SUBCONTRACT_LIMIT_EXCEEDED', 422, 'share_pct', { extensions: { findings: assessment.findings, total_share_pct: assessment.totalSharePct, prime_share_pct: assessment.primeSharePct } });
      throw failure;
    }
    const contract = await this.contractOf(tx, current.contractId);
    await this.gate.assertAllowed(tx, 'SUBCONTRACT', { contractorId: current.subcontractorId, contractId: current.contractId, packageId: contract.packageId, now, today });
    const exception = assessment.needsException;
    await tx.query(
      `update machvon.vendor_subcontract set state = 'APPROVED', approved_by = $2::uuid, approved_at = now(), exception_approved = $3, exception_reason = $4, assessment = $5::jsonb, rule_version = $6, updated_at = now(), version = version + 1 where id = $1::uuid`,
      [id, actor, exception, exception ? reasoned(exceptionReason ?? '', 'exception_reason', 20) : null, JSON.stringify({ findings: assessment.findings, total_share_pct: assessment.totalSharePct, prime_share_pct: assessment.primeSharePct }), policy.version],
    );
    return (await this.find(tx, id)) as SubcontractRow;
  }

  /** Rejects a proposal with a reason; the person who proposed it withdraws it the same way (the machine tells the two apart). */
  async reject(tx: TenantTx, id: string, expectedVersion: number, reason: string, actor: string): Promise<SubcontractRow> {
    const why = reasoned(reason, 'reason', 5);
    const current = await this.locked(tx, id, expectedVersion);
    const to = moveSubcontract(current.state, actor === current.proposedBy ? 'WITHDRAW' : 'REJECT', actor, current.proposedBy);
    await tx.query('update machvon.vendor_subcontract set state = $2, decided_by = $3::uuid, decided_at = now(), decision_reason = $4, updated_at = now(), version = version + 1 where id = $1::uuid', [id, to, actor, why]);
    return (await this.find(tx, id)) as SubcontractRow;
  }

  async terminate(tx: TenantTx, id: string, expectedVersion: number, reason: string, actor: string): Promise<SubcontractRow> {
    const why = reasoned(reason, 'reason', 5);
    const current = await this.locked(tx, id, expectedVersion);
    const to = moveSubcontract(current.state, 'TERMINATE', actor, current.proposedBy);
    await tx.query('update machvon.vendor_subcontract set state = $2, decided_by = $3::uuid, decided_at = now(), decision_reason = $4, updated_at = now(), version = version + 1 where id = $1::uuid', [id, to, actor, why]);
    return (await this.find(tx, id)) as SubcontractRow;
  }

  // -- What the prime paid ------------------------------------------------------------------------------------------------------------------------------------------------------------------

  private paymentsOf(rows: Array<{ id: string; subcontract_id: string; payment_request_id: string | null; paid_amount: string; paid_on: string; reference: string; recorded_by: string; recorded_at: string; confirmed_by_subcontractor: boolean; subcontractor_confirmed_at: string | null; request_paid_on: string | null }>, policy: SubcontractPolicy, now: Date): SubcontractPaymentRow[] {
    return rows.map((row) => ({
      id: row.id,
      subcontractId: row.subcontract_id,
      paymentRequestId: row.payment_request_id,
      paidAmount: Number(row.paid_amount),
      paidOn: row.paid_on,
      reference: row.reference,
      recordedBy: row.recorded_by,
      recordedAt: row.recorded_at,
      confirmedBySubcontractor: row.confirmed_by_subcontractor,
      subcontractorConfirmedAt: row.subcontractor_confirmed_at,
      clock: paymentConfirmationState({ requestPaidOn: row.request_paid_on, recordedAt: new Date(row.recorded_at), now, subcontractApproved: true }, policy),
    }));
  }

  private async paymentRows(tx: TenantTx, subcontractIds: readonly string[]) {
    if (subcontractIds.length === 0) return [];
    return tx.query<{ id: string; subcontract_id: string; payment_request_id: string | null; paid_amount: string; paid_on: string; reference: string; recorded_by: string; recorded_at: string; confirmed_by_subcontractor: boolean; subcontractor_confirmed_at: string | null; request_paid_on: string | null }>(
      `select p.id, p.subcontract_id, p.payment_request_id, p.paid_amount::text as paid_amount, p.paid_on::text as paid_on, p.reference, p.recorded_by, ${iso('p.recorded_at')} as recorded_at, p.confirmed_by_subcontractor,
              ${iso('p.subcontractor_confirmed_at')} as subcontractor_confirmed_at, r.treasury_paid_on::text as request_paid_on
         from machvon.vendor_subcontract_payment p left join machvon.payment_request r on r.tenant_id = p.tenant_id and r.id = p.payment_request_id
        where p.subcontract_id = any($1::uuid[]) order by p.paid_on, p.id`,
      [subcontractIds],
    );
  }

  /** Records what the prime paid a subcontractor (an approved one): the amount, the day, the reference of the transfer, and the payment request it follows (it must be one of the contract). */
  async recordPayment(tx: TenantTx, subcontractId: string, input: { paymentRequestId?: string | undefined; paidAmount: number; paidOn: string; reference: string }, actor: string, now: Date): Promise<SubcontractPaymentRow> {
    assertSubcontractPayment({ paidAmount: input.paidAmount, paidOn: input.paidOn, reference: input.reference });
    const current = await this.find(tx, subcontractId, true);
    if (current === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (current.state !== 'APPROVED') throw new DomainError('SUBCONTRACT_STATE_INVALID', 409, 'status', { extensions: { status: current.state } });
    if (input.paymentRequestId !== undefined) {
      if ((await tx.query('select 1 from machvon.payment_request where id = $1::uuid and contract_id = $2::uuid', [input.paymentRequestId, current.contractId])).length === 0) throw invalid('payment_request_id');
      if ((await tx.query('select 1 from machvon.vendor_subcontract_payment where subcontract_id = $1::uuid and payment_request_id = $2::uuid', [subcontractId, input.paymentRequestId])).length > 0) throw invalid('payment_request_id');
    }
    const id = randomUUID();
    await tx.query(
      `insert into machvon.vendor_subcontract_payment (tenant_id, id, subcontract_id, payment_request_id, paid_amount, paid_on, reference, recorded_by) values (${TENANT}, $1::uuid, $2::uuid, $3::uuid, $4::numeric, $5::date, $6, $7::uuid)`,
      [id, subcontractId, input.paymentRequestId ?? null, input.paidAmount, input.paidOn, input.reference.trim(), actor],
    );
    const policy = (await this.policies.subcontract(tx, vietnamDateOf(now))).value;
    return this.paymentsOf((await this.paymentRows(tx, [subcontractId])).filter((row) => row.id === id), policy, now)[0] as SubcontractPaymentRow;
  }

  // -- Reads -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  /** Payment requests of the contract that were paid after the subcontract was approved and have no record for it. */
  private async pendingFor(tx: TenantTx, contractId: string | null, now: Date, policy: SubcontractPolicy): Promise<PendingConfirmation[]> {
    const rows = await tx.query<{ subcontract_id: string; contract_id: string; contract_code: string; subcontractor_id: string; subcontractor_name: string; payment_request_id: string; paid_on: string }>(
      `select s.id as subcontract_id, s.contract_id, k.code as contract_code, s.subcontractor_id, c.legal_name as subcontractor_name, r.id as payment_request_id, r.treasury_paid_on::text as paid_on
         from machvon.vendor_subcontract s
         join machvon.contract k on k.tenant_id = s.tenant_id and k.id = s.contract_id
         join machvon.contractor c on c.tenant_id = s.tenant_id and c.id = s.subcontractor_id
         join machvon.payment_request r on r.tenant_id = s.tenant_id and r.contract_id = s.contract_id and r.status = 'SETTLED' and r.treasury_paid_on is not null
        where s.state = 'APPROVED' and ($1::uuid is null or s.contract_id = $1::uuid) and r.treasury_paid_on >= (s.approved_at at time zone 'Asia/Ho_Chi_Minh')::date
          and not exists (select 1 from machvon.vendor_subcontract_payment p where p.subcontract_id = s.id and p.payment_request_id = r.id)
        order by r.treasury_paid_on, s.id limit 500`,
      [contractId],
    );
    return rows.map((row) => ({
      subcontractId: row.subcontract_id,
      contractId: row.contract_id,
      contractCode: row.contract_code,
      subcontractorId: row.subcontractor_id,
      subcontractorName: row.subcontractor_name,
      paymentRequestId: row.payment_request_id,
      paidOn: row.paid_on,
      clock: paymentConfirmationState({ requestPaidOn: row.paid_on, recordedAt: null, now, subcontractApproved: true }, policy),
    }));
  }

  /** The subcontracts of a contract with the totals, the declaration of the bid, what was paid and what is still to be recorded. */
  async list(tx: TenantTx, contractId: string, now: Date): Promise<SubcontractListing> {
    const contract = await this.contractOf(tx, contractId);
    const policy = await this.policies.subcontract(tx, vietnamDateOf(now));
    const rows = (await tx.query<Sql>(`${SELECT} where s.contract_id = $1::uuid order by s.proposed_at, s.id`, [contractId])).map(toRow);
    const payments = this.paymentsOf(await this.paymentRows(tx, rows.map((row) => row.id)), policy.value, now);
    const items = rows.map((row) => {
      const own = payments.filter((payment) => payment.subcontractId === row.id);
      const paidTotal = own.reduce((sum, payment) => sum + payment.paidAmount, 0);
      return { ...row, payments: own, paidTotal, overPaid: paidExcess(row.value, own.map((payment) => payment.paidAmount)) };
    });
    const total = Math.round(rows.filter((row) => row.state === 'APPROVED').reduce((sum, row) => sum + row.sharePct * 10_000, 0)) / 10_000;
    return {
      contractId,
      contractCode: contract.code,
      contractValue: contract.value,
      primeContractorId: contract.contractorId,
      items,
      totalSharePct: total,
      primeSharePct: Math.round((100 - total) * 10_000) / 10_000,
      declaration: await this.declaration(tx, contract.packageId, contract.contractorId),
      pending: await this.pendingFor(tx, contractId, now, policy.value),
      policy,
    };
  }

  async pending(tx: TenantTx, now: Date): Promise<PendingConfirmation[]> {
    const policy = (await this.policies.subcontract(tx, vietnamDateOf(now))).value;
    return this.pendingFor(tx, null, now, policy);
  }

  /** Breaches the alert centre shows: an approval that went past the declaration by exception, a subcontractor paid more than its value, an approved subcontractor under a restriction in force. */
  async breaches(tx: TenantTx, today: string): Promise<Array<{ id: string; contractId: string; contractCode: string; subcontractorName: string; kind: 'EXCEPTION' | 'OVER_PAID' | 'RESTRICTED'; since: string }>> {
    const rows = await tx.query<{ id: string; contract_id: string; contract_code: string; name: string; kind: 'EXCEPTION' | 'OVER_PAID' | 'RESTRICTED'; since: string }>(
      `select s.id, s.contract_id, k.code as contract_code, c.legal_name as name, x.kind, x.since
         from machvon.vendor_subcontract s
         join machvon.contract k on k.tenant_id = s.tenant_id and k.id = s.contract_id
         join machvon.contractor c on c.tenant_id = s.tenant_id and c.id = s.subcontractor_id
         join lateral (
           select 'EXCEPTION' as kind, (s.approved_at at time zone 'Asia/Ho_Chi_Minh')::date::text as since where s.exception_approved
           union all
           select 'OVER_PAID', $1::text where (select coalesce(sum(p.paid_amount), 0) from machvon.vendor_subcontract_payment p where p.subcontract_id = s.id) > s.value
           union all
           select 'RESTRICTED', min(r.effective_from)::text from machvon.contractor_restriction r
            where r.contractor_id = s.subcontractor_id and r.lifted_at is null and r.effective_from <= $1::date and (r.effective_until is null or r.effective_until >= $1::date) having count(*) > 0
         ) x on true
        where s.state = 'APPROVED' order by s.id, x.kind limit 500`,
      [today],
    );
    return rows.map((row) => ({ id: row.id, contractId: row.contract_id, contractCode: row.contract_code, subcontractorName: row.name, kind: row.kind, since: row.since }));
  }

  /** The breaches of the contracts a contractor holds as the prime (a factor of its risk grade). */
  async breachCount(tx: TenantTx, contractorId: string, today: string): Promise<number> {
    const all = await this.breaches(tx, today);
    if (all.length === 0) return 0;
    const own = await tx.query<{ id: string }>('select id from machvon.contract where contractor_id = $1::uuid and id = any($2::uuid[])', [contractorId, [...new Set(all.map((row) => row.contractId))]]);
    const ids = new Set(own.map((row) => row.id));
    return all.filter((row) => ids.has(row.contractId)).length;
  }

  /** The figure of the register: records of what the prime paid made in time over those made and those that are overdue and not made. */
  async figure(tx: TenantTx, now: Date): Promise<{ code: string; numerator: number; denominator: number; asOf: string }> {
    const policy = (await this.policies.subcontract(tx, vietnamDateOf(now))).value;
    const rows = await tx.query<{ subcontract_id: string; recorded_at: string; request_paid_on: string }>(
      `select p.subcontract_id, ${iso('p.recorded_at')} as recorded_at, r.treasury_paid_on::text as request_paid_on from machvon.vendor_subcontract_payment p join machvon.payment_request r on r.tenant_id = p.tenant_id and r.id = p.payment_request_id where r.status = 'SETTLED' and r.treasury_paid_on is not null`,
    );
    const states = rows.map((row) => paymentConfirmationState({ requestPaidOn: row.request_paid_on, recordedAt: new Date(row.recorded_at), now, subcontractApproved: true }, policy));
    const inTime = states.filter((state) => state === 'MET').length;
    const late = states.filter((state) => state === 'MET_LATE').length;
    const overdue = (await this.pending(tx, now)).filter((row) => row.clock === 'OVERDUE').length;
    return { code: 'VENDOR_SUB_PAYMENT_CONFIRMED', numerator: inTime, denominator: inTime + late + overdue, asOf: vietnamDateOf(now) };
  }
}

export const subcontractFigures = async (tx: TenantTx, now: Date): Promise<Array<{ code: string; numerator: number; denominator: number; asOf: string }>> => [await new VendorSubcontractStore().figure(tx, now)];
export const subcontractBreachCount = (tx: TenantTx, contractorId: string, today: string): Promise<number> => new VendorSubcontractStore().breachCount(tx, contractorId, today);
