import { randomUUID } from 'node:crypto';
import {
  DomainError,
  NOOP_METRICS,
  assertContractAllows,
  assertNotProposer,
  groupForLedger,
  recoverFromTranches,
  requiredNote,
  signedDong,
  versionConflict,
  wholeVnd,
} from '@machvon/kernel';
import type { MetricsSink, PaymentKind, PaymentStatus } from '@machvon/kernel';
import { CtrContractStore } from './ctr-contract-store.ts';
import { normalizeUuid } from './file-import-item-store.ts';
import type { ContractScopes } from './ctr-contract-store.ts';
import { PAY_LEDGER_LOCK_WAIT_METRIC, PayLedgerStore, valueExceeded } from './pay-ledger-store.ts';
import { PayAdvanceRecoveryReads } from './pay-advance-recovery-reads.ts';
import { PayDisbursementCheck } from './pay-disbursement-check.ts';
import { VendorGate } from './vendor-gate.ts';
import { PayPaymentStore } from './pay-payment-store.ts';
import type { PaymentResult } from './pay-payment-store.ts';
import { lockLedgerRows } from './ledger-lock.ts';
import type { TenantTx } from './tenant-database.ts';

/** How many requests were sent, by outcome and by the code of the refusal (a counter). */
export const PAY_SUBMIT_METRIC = 'pay_submit_total';
/** Requests that met another one already holding the claim on their acceptance (a counter). */
export const PAY_CLAIM_CONFLICT_METRIC = 'pay_claim_conflict_total';

const MAX_TEXT = 2000;
const UNIQUE_VIOLATION = '23505';
const CLAIM_CONSTRAINT = 'payment_request_active_acceptance_uq';
const ADVANCE_CONSTRAINT = 'payment_request_active_advance_uq';
const DEFAULT_RELEASE_CONDITION = 'COMPLETION';
/** What the entries that undo a payment say: a fixed sentence, never the words of the person (those stay on the request and in the audit trail). */
const REVERSAL_ENTRY_REASON = 'The payment was reversed.';

const invalid = (field: string, reason?: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field, reason === undefined ? undefined : { extensions: { reason } });
const textOf = (value: string, field: string): string => {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > MAX_TEXT) throw invalid(field);
  return trimmed;
};

export interface ReversePaymentInput {
  reason: string | undefined;
  approvalDocumentVersionId: string | undefined;
  refundTransactionId: string | undefined;
  /** The identifier of the command, kept on the entries it posts. */
  requestId: string;
}

/** What a reversal did: the request as it stands, the refund it stood on and the day the Treasury first confirmed the payment. */
export interface Reversed {
  result: PaymentResult;
  refundTransactionId: string;
  /** The time the Treasury confirmed the refund (UTC, microseconds). */
  refundConfirmedAt: string;
  originalPaidOn: string;
  /** The Treasury transaction that settled the payment the refund undoes. */
  settledTransactionId: string;
  paymentEntries: number;
  advanceId: string | null;
}

export interface SubmitPaymentInput {
  /** The gross and the net the person saw on the screen: the request is sent only if they are still what it is worth (a stale screen is refused). */
  expectedGrossVnd: string;
  expectedNetVnd: string;
  /** The identifier of the command, kept on the entries it posts. */
  requestId: string;
  /** Lane D (G4-2): what an approved exception for the capital plan line lets this request go over the room of the line by, in whole dong; absent when no exception was used (the check of the line is then exact). */
  planWaiverVnd?: string | undefined;
}

interface HeldSql {
  id: string;
  request_no: string | null;
  request_kind: PaymentKind;
  status: PaymentStatus;
  version: string;
  contract_id: string;
  project_id: string;
  acceptance_id: string | null;
  advance_id: string | null;
  allocation_line_id: string | null;
  gross_vnd: string;
  advance_recovery_vnd: string;
  retention_vnd: string;
  net_vnd: string;
  created_by: string | null;
  submitted_by: string | null;
  returned_by_treasury: boolean;
}

const LOCK_SELECT = `select pr.id, pr.request_no, pr.request_kind, pr.status, pr.version::text as version, pr.contract_id, pr.project_id, pr.acceptance_id, pr.advance_id, pr.allocation_line_id, pr.gross_vnd::text as gross_vnd,
       pr.advance_recovery_vnd::text as advance_recovery_vnd, pr.retention_vnd::text as retention_vnd, pr.net_vnd::text as net_vnd, pr.created_by, pr.submitted_by, pr.returned_by_treasury
  from machvon.payment_request pr`;

/**
 * Sending, checking and returning a payment request (ST-PAY-003, PAY 3.1 step 3 and the branches, BR-PAY-02, BR-PAY-16). Sending is the one place a request takes the claim on its acceptance and
 * moves the money on the books, in one transaction in the lock order of the product: the contract, the balances of the ledger by identifier, the tranches of the advance. Two people sending two
 * requests for one acceptance at once are serialised by the lock of the contract; the second sees the claim of the first and is refused, and behind that check the unique index of the claim and the
 * CHECKs of the ledger hold the same rules (`applicationChecks: false` turns the checks of the application off in a test build to prove it). Returning gives it all back by entries that are the
 * opposite of the ones they undo, so the ledger tells the whole story and no entry is ever changed.
 */
export class PayClaimStore {
  private readonly contracts = new CtrContractStore();
  private readonly payments = new PayPaymentStore();
  private readonly advanceRecovery = new PayAdvanceRecoveryReads();
  private readonly disbursement = new PayDisbursementCheck();
  private readonly vendorGate = new VendorGate();
  private readonly ledger: PayLedgerStore;
  private readonly metrics: MetricsSink;
  private readonly applicationChecks: boolean;

  constructor(metrics: MetricsSink = NOOP_METRICS, options: { applicationChecks?: boolean } = {}) {
    this.metrics = metrics;
    this.applicationChecks = options.applicationChecks ?? true;
    this.ledger = new PayLedgerStore(metrics, { applicationChecks: this.applicationChecks });
  }

  /** Sends a draft: takes the claim on the acceptance and puts the request on the ledger and on the contract. */
  async submit(tx: TenantTx, id: string, expectedVersion: number, input: SubmitPaymentInput, actor: string, scopes: ContractScopes, today: string): Promise<PaymentResult> {
    try {
      const done = await this.send(tx, id, expectedVersion, input, actor, scopes, today);
      this.metrics.increment(PAY_SUBMIT_METRIC, { outcome: 'ok', problem_code: 'NONE' });
      return done;
    } catch (error) {
      const code = error instanceof DomainError ? error.code : 'ERROR';
      this.metrics.increment(PAY_SUBMIT_METRIC, { outcome: 'refused', problem_code: code });
      if (code === 'ACCEPTANCE_ALREADY_CLAIMED') this.metrics.increment(PAY_CLAIM_CONFLICT_METRIC);
      throw error;
    }
  }

  /** Checks a request that was sent: by someone other than whoever drew it up and whoever sent it (403 `SELF_APPROVAL_DENIED`). */
  async verify(tx: TenantTx, id: string, expectedVersion: number, note: string | undefined, actor: string, scopes: ContractScopes): Promise<PaymentResult> {
    const text = note === undefined ? null : textOf(note, 'note');
    const held = await this.lock(tx, id, expectedVersion, scopes);
    if (held.status !== 'SUBMITTED') throw new DomainError('PAYMENT_STATE_INVALID', 409, 'id', { extensions: { status: held.status } });
    assertNotProposer(actor, [held.created_by, held.submitted_by]);
    await tx.query(
      "update machvon.payment_request set status = 'VERIFIED', verified_by = $2::uuid, verified_at = now(), verification_note = $3, updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid",
      [id, actor, text],
    );
    return this.payments.resultOf(tx, id, held.status, []);
  }

  /**
   * Returns a request that was sent, with the reason: the claim on the acceptance is released, the advance it recovered is given back, the retention it held is let go and the totals of the
   * contract are brought back, each by the opposite of the entry that made it. A request already with the Treasury is returned only by the Treasury (`returned_by_treasury`).
   */
  async returnRequest(tx: TenantTx, id: string, expectedVersion: number, input: { reason: string; returnedByTreasury?: boolean | undefined; requestId: string }, actor: string, scopes: ContractScopes): Promise<PaymentResult> {
    const reason = textOf(input.reason, 'reason');
    const held = await this.lock(tx, id, expectedVersion, scopes);
    const byTreasury = input.returnedByTreasury === true;
    const open = held.status === 'SUBMITTED' || held.status === 'VERIFIED' || (held.status === 'SENT_TREASURY' && byTreasury);
    if (!open) throw new DomainError('PAYMENT_STATE_INVALID', 409, 'id', { extensions: { status: held.status } });
    await tx.query(
      `update machvon.payment_request
          set status = 'RETURNED', claims_acceptance = false, return_reason = $2, returned_by = $3::uuid, returned_at = now(), returned_by_treasury = $4, updated_at = now(), updated_by = $3::uuid, version = version + 1
        where id = $1::uuid`,
      [id, reason, actor, byTreasury],
    );
    // The forms drawn for the figures of this request are no longer the forms of the request that comes back: they are superseded, and drawn again when it has been corrected and checked.
    await tx.query("update machvon.payment_form_instance set status = 'SUPERSEDED', updated_at = now(), updated_by = $2::uuid, version = version + 1 where payment_request_id = $1::uuid and status = 'GENERATED'", [id, actor]);
    if (held.request_kind !== 'ADVANCE') {
      const outstanding = await this.moveTotals(tx, held, -1, actor);
      await this.ledger.releaseRequest(tx, { paymentRequestId: id, requestId: input.requestId, actor, advanceOutstandingVnd: outstanding });
      await this.giveBackAdvance(tx, held, input.requestId, actor);
      await tx.query('delete from machvon.retention_hold where payment_request_id = $1::uuid', [id]);
    } else if (held.advance_id !== null) {
      // The advance is no longer asked for: it is planned again, and may be asked for again or cancelled.
      await tx.query("update machvon.contract_advance set status = 'PLANNED', updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid and status = 'REQUESTED'", [held.advance_id, actor]);
    }
    return this.payments.resultOf(tx, id, held.status, []);
  }


  /**
   * Reverses a payment that was settled (PAY 3.4, UAT-AC331): only against a refund the Treasury confirmed, with the reason and the document that approves it, and by someone other than whoever
   * matched the payment or sent the file. Every effect of the payment is undone by new entries that name the ones they undo (the payment, the recovery of the advance, the hold of retention, the
   * claim on the acceptance), once each; the totals of the contract come back; the claim on the acceptance is let go, so it can be claimed again; and the refund is matched to the request. Nothing is
   * updated or deleted but the balances that follow the entries. A payment request for an advance gives the advance back to planned, when nothing of it was recovered.
   */
  async reverse(tx: TenantTx, id: string, expectedVersion: number, input: ReversePaymentInput, actor: string, scopes: ContractScopes): Promise<Reversed> {
    const reason = requiredNote(input.reason, 'reason');
    const held = await this.lock(tx, id, expectedVersion, scopes);
    if (held.status !== 'SETTLED') throw new DomainError('PAYMENT_STATE_INVALID', 409, 'id', { extensions: { status: held.status } });
    const [settlement] = await tx.query<{ settled_transaction_id: string; paid_on: string; settled_by: string; sent_by: string | null }>(
      'select settled_transaction_id, treasury_paid_on::text as paid_on, settled_by, treasury_sent_by as sent_by from machvon.payment_request where id = $1::uuid',
      [held.id],
    );
    if (settlement === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const refund = await this.confirmedRefund(tx, held, settlement.settled_transaction_id, input.refundTransactionId);
    const approval = await this.approvalDocument(tx, input.approvalDocumentVersionId);
    // Four eyes on the money that goes back: not the person who matched the payment, nor the one who sent the file to the Treasury.
    assertNotProposer(actor, [settlement.settled_by, settlement.sent_by]);
    let paymentEntries = 0;
    let advanceId: string | null = null;
    try {
      if (held.request_kind === 'ADVANCE') {
        advanceId = await this.takeAdvanceBack(tx, held, input.requestId, actor);
      } else {
        const outstanding = await this.moveTotals(tx, held, -1, actor, true);
        paymentEntries = await this.ledger.reversePayments(tx, { paymentRequestId: held.id, requestId: input.requestId, actor, advanceOutstandingVnd: outstanding, reason: REVERSAL_ENTRY_REASON });
        await this.ledger.releaseRequest(tx, { paymentRequestId: held.id, requestId: input.requestId, actor, advanceOutstandingVnd: outstanding, reason: REVERSAL_ENTRY_REASON });
        await this.giveBackAdvance(tx, held, input.requestId, actor, REVERSAL_ENTRY_REASON);
      }
      await tx.query(
        `update machvon.treasury_transaction
            set match_status = 'MATCHED', payment_request_id = $2::uuid, contract_id = $3::uuid, allocation_line_id = $4::uuid, plan_year = $5, matched_at = now(), matched_by = $6::uuid
          where id = $1::uuid`,
        [refund.id, held.id, held.contract_id, held.allocation_line_id, refund.planYear, actor],
      );
      await tx.query(
        `update machvon.payment_request
            set status = 'REVERSED', claims_acceptance = false, reversed_by = $2::uuid, reversed_at = now(), reversal_reason = $3, reversal_approval_document_version_id = $4::uuid, refund_transaction_id = $5::uuid,
                updated_at = now(), updated_by = $2::uuid, version = version + 1
          where id = $1::uuid`,
        [held.id, actor, reason, approval, refund.id],
      );
      // What was held back goes with the payment, now that the request is reversed (the database lets it go only then, and only while none of it was released).
      if (held.request_kind !== 'ADVANCE') await tx.query('delete from machvon.retention_hold where payment_request_id = $1::uuid', [held.id]);
    } catch (error) {
      throw this.mapReversalRefusal(error);
    }
    return { result: await this.payments.resultOf(tx, held.id, 'SETTLED', []), refundTransactionId: refund.id, refundConfirmedAt: refund.confirmedAt, originalPaidOn: settlement.paid_on, settledTransactionId: settlement.settled_transaction_id, paymentEntries, advanceId };
  }

  /** The refund the reversal stands on: a refund of the very payment that settled the request, for the same amount, confirmed by the Treasury and not yet used (422 `REFUND_NOT_CONFIRMED`, with the reason). */
  private async confirmedRefund(tx: TenantTx, held: HeldSql, settledTransactionId: string, refundId: string | undefined): Promise<{ id: string; confirmedAt: string; planYear: number | null }> {
    const refusal = (reason: string, extensions: Record<string, unknown> = {}): DomainError => new DomainError('REFUND_NOT_CONFIRMED', 422, 'refund_treasury_transaction_id', { extensions: { reason, ...extensions } });
    if (refundId === undefined) throw refusal('MISSING');
    const id = normalizeUuid(refundId, 'refund_treasury_transaction_id');
    const [row] = await tx.query<{ id: string; project_id: string; direction: string; reversal_of_id: string | null; amount_vnd: string; match_status: string; confirmed_at: string; plan_year: number | null }>(
      `select id, project_id, direction, reversal_of_id, amount_vnd::text as amount_vnd, match_status, to_char(confirmed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as confirmed_at, plan_year
         from machvon.treasury_transaction where id = $1::uuid for update`,
      [id],
    );
    if (row === undefined || row.project_id !== held.project_id) throw refusal('NOT_FOUND');
    if (row.direction !== 'REFUND') throw refusal('NOT_A_REFUND');
    if (row.reversal_of_id !== settledTransactionId) throw refusal('OTHER_PAYMENT');
    if (row.amount_vnd !== held.net_vnd) throw refusal('AMOUNT', { refund_vnd: row.amount_vnd, net_vnd: held.net_vnd });
    if (row.match_status !== 'UNMATCHED') throw refusal('ALREADY_USED');
    return { id: row.id, confirmedAt: row.confirmed_at, planYear: row.plan_year };
  }

  /** The document that approves the reversal: needed (422 `APPROVAL_REQUIRED`), and scanned clean. */
  private async approvalDocument(tx: TenantTx, value: string | undefined): Promise<string> {
    if (value === undefined) throw new DomainError('APPROVAL_REQUIRED', 422, 'approval_document_version_id');
    const id = normalizeUuid(value, 'approval_document_version_id');
    const [document] = await tx.query<{ scan_status: string }>('select scan_status from machvon.document_version where id = $1::uuid', [id]);
    if (document === undefined) throw invalid('approval_document_version_id', 'NOT_FOUND');
    if (document.scan_status !== 'CLEAN') throw new DomainError('DOCUMENT_NOT_CLEAN', 422, 'approval_document_version_id');
    return id;
  }

  /** The advance of a reversed payment request goes back to planned: what was paid is taken back by an entry that undoes the payment, and the contract no longer shows the money out. Nothing of it may have been recovered. */
  private async takeAdvanceBack(tx: TenantTx, held: HeldSql, requestId: string, actor: string): Promise<string> {
    if (held.advance_id === null) throw new DomainError('ADVANCE_STATE_INVALID', 409, 'advance_id');
    const [advance] = await tx.query<{ id: string; party_id: string; status: string; paid_vnd: string; recovered_vnd: string }>(
      'select id, party_id, status, paid_vnd::text as paid_vnd, recovered_vnd::text as recovered_vnd from machvon.contract_advance where id = $1::uuid for update',
      [held.advance_id],
    );
    if (advance === undefined || advance.status !== 'PAID' || advance.recovered_vnd !== '0') {
      throw new DomainError('ADVANCE_STATE_INVALID', 409, 'advance_id', { extensions: { status: advance?.status ?? null, recovered_vnd: advance?.recovered_vnd ?? null } });
    }
    const [disbursed] = await tx.query<{ id: string }>(
      `select e.id from machvon.advance_ledger_entry e
        where e.payment_request_id = $1::uuid and e.entry_kind = 'DISBURSE' and not exists (select 1 from machvon.advance_ledger_entry r where r.tenant_id = e.tenant_id and r.reversal_of_id = e.id)`,
      [held.id],
    );
    if (disbursed === undefined) throw new DomainError('ADVANCE_STATE_INVALID', 409, 'advance_id', { extensions: { reason: 'NOT_DISBURSED' } });
    await tx.query(
      `insert into machvon.advance_ledger_entry (tenant_id, id, contract_id, payment_request_id, entry_kind, amount_vnd, reversal_of_id, posted_at, advance_id, party_id, outstanding_after_vnd, reason, posted_by, request_id)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, 'REVERSE_DISBURSE', $4::numeric, $5::uuid, now(), $6::uuid, $7::uuid, 0, $8, $9::uuid, $10::uuid)`,
      [randomUUID(), held.contract_id, held.id, advance.paid_vnd, disbursed.id, advance.id, advance.party_id, REVERSAL_ENTRY_REASON, actor, requestId],
    );
    await tx.query("update machvon.contract_advance set status = 'PLANNED', paid_vnd = 0, paid_on = null, recovery_deadline = null, last_alert_level = 0, overdue_since = null, alert_note = null, alert_plan_due_on = null, alert_acknowledged_by = null, alert_acknowledged_at = null, updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid", [advance.id, actor]);
    await tx.query('update machvon.contract set advance_paid_vnd = advance_paid_vnd - $2::numeric, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid', [held.contract_id, advance.paid_vnd, actor]);
    return advance.id;
  }

  /** What the database refused, in the words of the contract; anything else is not ours to explain. */
  private mapReversalRefusal(error: unknown): unknown {
    const broken = valueExceeded(error, this.metrics);
    if (broken !== undefined) return broken;
    const failure = error as { code?: string; message?: string };
    if (failure.code === UNIQUE_VIOLATION) return new DomainError('REFUND_NOT_CONFIRMED', 422, 'refund_treasury_transaction_id', { extensions: { reason: 'ALREADY_USED' } });
    if (failure.code !== '23514') return error;
    const message = failure.message ?? '';
    if (message.includes('REFUND_NOT_CONFIRMED')) return new DomainError('REFUND_NOT_CONFIRMED', 422, 'refund_treasury_transaction_id');
    if (message.includes('ADVANCE_STATE_INVALID')) return new DomainError('ADVANCE_STATE_INVALID', 409, 'advance_id');
    if (message.includes('PAYMENT_STATE_INVALID')) return new DomainError('PAYMENT_STATE_INVALID', 409, 'id');
    if (message.includes('a hold of retention')) return new DomainError('PAYMENT_STATE_INVALID', 409, 'id', { extensions: { reason: 'RETENTION_RELEASED' } });
    return error;
  }

  // ---- internals ------------------------------------------------------------------------------------------------------------

  private async lock(tx: TenantTx, id: string, expectedVersion: number, scopes: ContractScopes): Promise<HeldSql> {
    const peek = await tx.query<{ contract_id: string }>('select contract_id from machvon.payment_request where id = $1::uuid', [id]);
    if (peek[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const waitStarted = performance.now();
    await this.contracts.lock(tx, peek[0].contract_id, scopes);
    // How long the command waited for the contract: another writer of the same contract held it that long.
    this.metrics.gauge(PAY_LEDGER_LOCK_WAIT_METRIC, (performance.now() - waitStarted) / 1000);
    const [row] = await tx.query<HeldSql>(`${LOCK_SELECT} where pr.id = $1::uuid for update of pr`, [id]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    return row;
  }

  private async send(tx: TenantTx, id: string, expectedVersion: number, input: SubmitPaymentInput, actor: string, scopes: ContractScopes, today: string): Promise<PaymentResult> {
    const gross = wholeVnd(input.expectedGrossVnd, 'expected_gross_vnd');
    const net = signedDong(input.expectedNetVnd, 'expected_net_vnd');
    const held = await this.lock(tx, id, expectedVersion, scopes);
    if (held.status !== 'DRAFT') throw new DomainError('PAYMENT_STATE_INVALID', 409, 'id', { extensions: { status: held.status } });
    // A screen that is out of date is refused with what the request is worth now, so the person can look again before anything moves.
    if (gross !== BigInt(held.gross_vnd) || net !== BigInt(held.net_vnd)) {
      throw new DomainError('PAYMENT_NET_MISMATCH', 422, 'expected_net_vnd', { extensions: { gross_vnd: held.gross_vnd, net_vnd: held.net_vnd } });
    }
    const contract = await this.payments.contractFacts(tx, held.contract_id);
    const acceptance = held.acceptance_id === null ? undefined : await this.payments.acceptanceOf(tx, held.acceptance_id, held.contract_id);
    assertContractAllows({ status: contract.status, suspendedFrom: contract.suspended_from, terminatedOn: contract.terminated_on }, held.request_kind, acceptance?.approved_on ?? null);
    if (held.request_kind !== 'ADVANCE') {
      const invoices = await tx.query("select 1 from machvon.payment_document where payment_request_id = $1::uuid and doc_kind = 'INVOICE' limit 1", [id]);
      if (invoices.length === 0) throw new DomainError('INVOICE_REQUIRED', 422, 'documents');
    }
    // The claim comes first: of two requests for one acceptance, the one that comes second is told the acceptance is claimed, not that the money is short.
    if (this.applicationChecks && held.acceptance_id !== null) {
      const claim = await tx.query<{ id: string }>('select id from machvon.payment_request where acceptance_id = $1::uuid and claims_acceptance and id <> $2::uuid limit 1', [held.acceptance_id, id]);
      if (claim[0] !== undefined) throw new DomainError('ACCEPTANCE_ALREADY_CLAIMED', 409, 'acceptance_id', { extensions: { payment_request_id: claim[0].id } });
    }
    // G1-2: a request is sent only for a project that is still on the list and still holds an approved amount on the system (the stage or the plan may have changed since the draft).
    await this.disbursement.assertAllowed(tx, contract.project_id, today);
    // VND-1: asked again when the request is sent, as the payee may have changed since the draft.
    await this.vendorGate.assertAllowed(tx, 'PAYMENT', { contractId: held.contract_id, now: new Date(), today });
    if (held.allocation_line_id === null) throw new DomainError('ALLOCATION_UNAVAILABLE', 422, 'allocation_line_id', { extensions: { reason: 'NOT_FOUND' } });
    await this.payments.assertAllocation(tx, held.allocation_line_id, contract.project_id, acceptance === undefined ? null : Number(acceptance.accepted_on.slice(0, 4)), today);

    try {
      await tx.query(
        `update machvon.payment_request set status = 'SUBMITTED', claims_acceptance = $4, submitted_by = $2::uuid, submitted_at = now(), updated_at = now(), updated_by = $2::uuid, version = version + 1
          where id = $1::uuid and status = $3`,
        [id, actor, 'DRAFT', held.request_kind !== 'ADVANCE'],
      );
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      if (failure.code === UNIQUE_VIOLATION && failure.constraint === CLAIM_CONSTRAINT) throw new DomainError('ACCEPTANCE_ALREADY_CLAIMED', 409, 'acceptance_id');
      // Another request for the same advance is already sent: the advance is not there to be asked for twice.
      if (failure.code === UNIQUE_VIOLATION && failure.constraint === ADVANCE_CONSTRAINT) throw new DomainError('PAYMENT_STATE_INVALID', 409, 'advance_id', { extensions: { reason: 'ADVANCE_NOT_PLANNED' } });
      throw error;
    }
    if (held.request_kind === 'ADVANCE') await this.askForAdvance(tx, held, actor);
    else await this.putOnTheBooks(tx, held, input.requestId, actor);
    // G1-11: the final payment does not go while an advance of the contract is still owed after the recovery this very request makes (the policy of the day says whether it must be recovered in full).
    if (held.request_kind === 'FINAL') await this.advanceRecovery.assertFinalPaymentClears(tx, held.contract_id, today);
    // The line of capital comes last in the order of the locks: what it has left, less what other requests in flight are already worth, must carry this one.
    await this.assertLineHasRoom(tx, held.allocation_line_id, net, id, input.planWaiverVnd === undefined ? 0n : wholeVnd(input.planWaiverVnd, 'plan_waiver_vnd'));
    return this.payments.resultOf(tx, id, held.status, []);
  }

  /** 422 `ALLOCATION_UNAVAILABLE` (naming what is available) unless the line of capital, locked, has room for the net of the request over what it holds disbursed and what requests in flight are worth. */
  private async assertLineHasRoom(tx: TenantTx, lineId: string, net: bigint, requestId: string, waiver = 0n): Promise<void> {
    const [balance] = await tx.query<{ allocated: string; disbursed: string }>(
      'select allocated_vnd::text as allocated, disbursed_vnd::text as disbursed from machvon.allocation_balance where allocation_line_id = $1::uuid for update',
      [lineId],
    );
    if (balance === undefined) throw new DomainError('ALLOCATION_UNAVAILABLE', 422, 'allocation_line_id', { extensions: { reason: 'NOT_IN_FORCE' } });
    const [flight] = await tx.query<{ net: string }>(
      "select coalesce(sum(net_vnd), 0)::text as net from machvon.payment_request where allocation_line_id = $1::uuid and id <> $2::uuid and status in ('SUBMITTED', 'VERIFIED', 'SENT_TREASURY')",
      [lineId, requestId],
    );
    const room = BigInt(balance.allocated) - BigInt(balance.disbursed) - BigInt(flight?.net ?? '0');
    if (net > room + waiver) throw new DomainError('ALLOCATION_UNAVAILABLE', 422, 'allocation_line_id', { extensions: { reason: 'INSUFFICIENT', available_vnd: (room < 0n ? 0n : room).toString() } });
  }

  /** The advance a request of the ADVANCE kind is for goes from planned to asked for; one that is not planned any more (another request holds it, or it was cancelled) cannot be asked for twice. */
  private async askForAdvance(tx: TenantTx, held: HeldSql, actor: string): Promise<void> {
    const moved = await tx.query("update machvon.contract_advance set status = 'REQUESTED', updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid and status = 'PLANNED' returning id", [held.advance_id, actor]);
    if (moved.length === 0) throw new DomainError('PAYMENT_STATE_INVALID', 409, 'advance_id', { extensions: { reason: 'ADVANCE_NOT_PLANNED' } });
  }

  /** The totals of the contract moved by a request (sign +1 when it is sent, -1 when it is returned); gives the advance still to recover after. */
  private async moveTotals(tx: TenantTx, held: HeldSql, sign: 1 | -1, actor: string, paid = false): Promise<string> {
    try {
      const [row] = await tx.query<{ outstanding: string }>(
        `update machvon.contract
            set requested_total_vnd = requested_total_vnd + $2::numeric, advance_recovered_vnd = advance_recovered_vnd + $3::numeric, retention_held_vnd = retention_held_vnd + $4::numeric,
                paid_total_vnd = paid_total_vnd + $6::numeric, updated_at = now(), updated_by = $5::uuid, version = version + 1
          where id = $1::uuid returning (advance_paid_vnd - advance_recovered_vnd)::text as outstanding`,
        [held.contract_id, (BigInt(held.gross_vnd) * BigInt(sign)).toString(), (BigInt(held.advance_recovery_vnd) * BigInt(sign)).toString(), (BigInt(held.retention_vnd) * BigInt(sign)).toString(), actor, paid ? (BigInt(held.gross_vnd) * BigInt(sign)).toString() : '0'],
      );
      return row?.outstanding ?? '0';
    } catch (error) {
      throw valueExceeded(error, this.metrics) ?? error;
    }
  }

  private async soleParty(tx: TenantTx, contractId: string): Promise<string | undefined> {
    const parties = await tx.query<{ id: string }>("select id from machvon.contract_party where contract_id = $1::uuid and status = 'ACTIVE' order by id", [contractId]);
    return parties.length === 1 ? parties[0]?.id : undefined;
  }

  /** The request on the books: the totals of the contract, the entries of the ledger, the tranches of the advance and the holds of retention. */
  private async putOnTheBooks(tx: TenantTx, held: HeldSql, requestId: string, actor: string): Promise<void> {
    const acceptanceId = held.acceptance_id as string;
    // The acceptance is on the ledger before the claim is laid on it, whether or not the consumer of its approval has run yet (it posts nothing a second time).
    const recognised = await this.ledger.recognize(tx, { acceptanceId, requestId: held.id, actor });
    if (recognised.outcome === 'skipped') throw new DomainError('ACCEPTANCE_NOT_APPROVED', 422, 'acceptance_id');
    const lines = await tx.query<{ boq_item_id: string; party_id: string | null; gross_vnd: string; advance_recovery_vnd: string; retention_vnd: string }>(
      'select boq_item_id, party_id, gross_vnd::text as gross_vnd, advance_recovery_vnd::text as advance_recovery_vnd, retention_vnd::text as retention_vnd from machvon.payment_request_line where payment_request_id = $1::uuid',
      [held.id],
    );
    const groups = groupForLedger(lines.map((line) => ({ boqItemId: line.boq_item_id, partyId: line.party_id, grossVnd: line.gross_vnd, advanceRecoveryVnd: line.advance_recovery_vnd, retentionVnd: line.retention_vnd })));
    const rows = new Map<string, string>();
    for (const group of groups) {
      const [row] = await tx.query<{ id: string }>(
        'select id from machvon.cumulative_ledger where contract_id = $1::uuid and acceptance_id = $2::uuid and boq_item_id = $3::uuid and party_id is not distinct from $4::uuid',
        [held.contract_id, acceptanceId, group.boqItemId, group.partyId],
      );
      if (row === undefined) throw new DomainError('PAYMENT_STATE_INVALID', 409, 'id', { extensions: { reason: 'NOT_ON_THE_LEDGER', boq_item_id: group.boqItemId } });
      rows.set(`${group.boqItemId}|${group.partyId ?? ''}`, row.id);
    }
    // The order of the locks: the contract (held), the balances of the ledger, then the tranches of the advance.
    await lockLedgerRows(tx, [...new Set(rows.values())].map((ledgerId) => ({ table: 'cumulative_ledger', id: ledgerId })));
    await this.takeFromAdvances(tx, held, groups, requestId, actor);
    const outstanding = await this.moveTotals(tx, held, 1, actor);
    for (const group of groups) {
      const ledgerId = rows.get(`${group.boqItemId}|${group.partyId ?? ''}`) as string;
      const post = (kind: 'CLAIM' | 'ADVANCE_RECOVERY' | 'RETENTION_HOLD', delta: { requested?: string; advanceRecovery?: string; retention?: string }) =>
        this.ledger.post(tx, {
          ledgerId,
          kind,
          delta: { accepted: '0', requested: delta.requested ?? '0', paid: '0', advanceRecovery: delta.advanceRecovery ?? '0', retention: delta.retention ?? '0' },
          paymentRequestId: held.id,
          requestId,
          actor,
          advanceOutstandingVnd: outstanding,
        });
      await post('CLAIM', { requested: group.grossVnd });
      if (BigInt(group.advanceRecoveryVnd) > 0n) await post('ADVANCE_RECOVERY', { advanceRecovery: group.advanceRecoveryVnd });
      if (BigInt(group.retentionVnd) > 0n) await post('RETENTION_HOLD', { retention: group.retentionVnd });
    }
    for (const group of groups) {
      if (BigInt(group.retentionVnd) === 0n) continue;
      await tx.query(
        `insert into machvon.retention_hold (tenant_id, id, contract_id, boq_item_id, acceptance_id, payment_request_id, party_id, held_vnd, release_condition, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::numeric, $8, $9::uuid, $9::uuid)`,
        [randomUUID(), held.contract_id, group.boqItemId, acceptanceId, held.id, group.partyId, group.retentionVnd, DEFAULT_RELEASE_CONDITION, actor],
      );
    }
  }

  /** The recovery of each party comes out of its tranches, the earliest first; more than they hold outstanding is 422 `ADVANCE_RECOVERY_EXCEEDED`. */
  private async takeFromAdvances(tx: TenantTx, held: HeldSql, groups: ReturnType<typeof groupForLedger>, requestId: string, actor: string): Promise<void> {
    const sole = await this.soleParty(tx, held.contract_id);
    const byParty = new Map<string, bigint>();
    for (const group of groups) {
      const party = group.partyId ?? sole;
      if (BigInt(group.advanceRecoveryVnd) === 0n) continue;
      if (party === undefined) throw invalid('party_id', 'PARTY_REQUIRED');
      byParty.set(party, (byParty.get(party) ?? 0n) + BigInt(group.advanceRecoveryVnd));
    }
    for (const [party, wanted] of [...byParty].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const tranches = await tx.query<{ id: string; paid_vnd: string; recovered_vnd: string }>(
        `select id, paid_vnd::text as paid_vnd, recovered_vnd::text as recovered_vnd from machvon.contract_advance
          where contract_id = $1::uuid and party_id = $2::uuid and status in ('PAID', 'RECOVERING') order by tranche_no for update`,
        [held.contract_id, party],
      );
      const split = recoverFromTranches(
        tranches.map((tranche) => (BigInt(tranche.paid_vnd) - BigInt(tranche.recovered_vnd)).toString()),
        wanted.toString(),
      );
      if (BigInt(split.left) > 0n) throw new DomainError('ADVANCE_RECOVERY_EXCEEDED', 422, 'advance_recovery_vnd', { extensions: { party_id: party, short_by_vnd: split.left } });
      for (const [index, tranche] of tranches.entries()) {
        const take = BigInt(split.taken[index] as string);
        if (take === 0n) continue;
        const after = BigInt(tranche.recovered_vnd) + take;
        try {
          await tx.query(
            "update machvon.contract_advance set recovered_vnd = $2::numeric, status = case when $2::numeric = paid_vnd then 'FULLY_RECOVERED' else 'RECOVERING' end, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid",
            [tranche.id, after.toString(), actor],
          );
        } catch (error) {
          const failure = error as { code?: string };
          if (failure.code === '23514') throw new DomainError('ADVANCE_RECOVERY_EXCEEDED', 422, 'advance_recovery_vnd', { extensions: { party_id: party } });
          throw error;
        }
        await tx.query(
          `insert into machvon.advance_ledger_entry (tenant_id, id, contract_id, payment_request_id, entry_kind, amount_vnd, posted_at, advance_id, party_id, outstanding_after_vnd, posted_by, request_id)
           values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, 'RECOVER', $4::numeric, now(), $5::uuid, $6::uuid, $7::numeric, $8::uuid, $9::uuid)`,
          [randomUUID(), held.contract_id, held.id, take.toString(), tranche.id, party, (BigInt(tranche.paid_vnd) - after).toString(), actor, requestId],
        );
      }
    }
  }

  /** Gives back what a returned request recovered from the advance, tranche by tranche, by the opposite of each entry that took it. */
  private async giveBackAdvance(tx: TenantTx, held: HeldSql, requestId: string, actor: string, reason = 'The payment request was returned.'): Promise<void> {
    const taken = await tx.query<{ id: string; advance_id: string; party_id: string; amount: string }>(
      `select e.id, e.advance_id, e.party_id, e.amount_vnd::text as amount from machvon.advance_ledger_entry e
        where e.payment_request_id = $1::uuid and e.entry_kind = 'RECOVER' and not exists (select 1 from machvon.advance_ledger_entry r where r.tenant_id = e.tenant_id and r.reversal_of_id = e.id)
        order by e.advance_id, e.id`,
      [held.id],
    );
    for (const entry of taken) {
      const [tranche] = await tx.query<{ paid_vnd: string; recovered_vnd: string }>('select paid_vnd::text as paid_vnd, recovered_vnd::text as recovered_vnd from machvon.contract_advance where id = $1::uuid for update', [entry.advance_id]);
      if (tranche === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const after = BigInt(tranche.recovered_vnd) - BigInt(entry.amount);
      await tx.query("update machvon.contract_advance set recovered_vnd = $2::numeric, status = case when $2::numeric = 0 then 'PAID' else 'RECOVERING' end, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid", [
        entry.advance_id,
        after.toString(),
        actor,
      ]);
      await tx.query(
        `insert into machvon.advance_ledger_entry (tenant_id, id, contract_id, payment_request_id, entry_kind, amount_vnd, reversal_of_id, posted_at, advance_id, party_id, outstanding_after_vnd, reason, posted_by, request_id)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, 'REVERSE_RECOVER', $4::numeric, $5::uuid, now(), $6::uuid, $7::uuid, $8::numeric, $11, $9::uuid, $10::uuid)`,
        [randomUUID(), held.contract_id, held.id, entry.amount, entry.id, entry.advance_id, entry.party_id, (BigInt(tranche.paid_vnd) - after).toString(), actor, requestId, reason],
      );
    }
  }
}
