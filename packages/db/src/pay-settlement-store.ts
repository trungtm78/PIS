import { randomUUID } from 'node:crypto';
import { DomainError, NOOP_METRICS, amountsAgree, gpmbDeadline, groupForLedger, reconciliationDifference } from '@machvon/kernel';
import type { MetricsSink, PaymentKind } from '@machvon/kernel';
import { CtrContractStore } from './ctr-contract-store.ts';
import type { ContractScopes } from './ctr-contract-store.ts';
import { DEFAULT_ITEM_DUE_SECONDS } from './file-import-item-store.ts';
import { lockLedgerRows } from './ledger-lock.ts';
import { ADVANCE_GPMB_RULE } from './pay-advance-store.ts';
import { MasterRules } from './master-rules.ts';
import { PayClockStore } from './pay-clock-store.ts';
import { PAY_LEDGER_LOCK_WAIT_METRIC, PayLedgerStore, valueExceeded } from './pay-ledger-store.ts';
import { PayPaymentStore } from './pay-payment-store.ts';
import type { PaymentResult } from './pay-payment-store.ts';
import type { TenantTx } from './tenant-database.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT = `nullif(current_setting('app.tenant_id', true), '')::uuid`;
const CHECK_VIOLATION = '23514';

/** The matches that ended, by outcome (a counter): `settled` or `mismatch`. */
export const PAY_MATCH_METRIC = 'pay_treasury_match_total';

const invalid = (field: string, reason?: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field, reason === undefined ? undefined : { extensions: { reason } });
const idOf = (value: string, field: string): string => {
  if (!UUID.test(value)) throw invalid(field);
  return value.toLowerCase();
};

export interface MatchInput {
  transactionId: string;
  paymentRequestId: string;
  actor: string;
  /** The identifier of the command, kept on the entries it posts. */
  requestId: string;
  scopes: ContractScopes;
  now: Date;
}

/** What the match changed on the books when the amounts agreed. */
export interface Settled {
  kind: 'SETTLED';
  result: PaymentResult;
  transactionId: string;
  documentNo: string | null;
  amountVnd: string;
  /** The time the Treasury confirmed the payment (UTC, microseconds): when the disbursement counts from. */
  confirmedAt: string;
  /** The day of `confirmedAt` in Vietnam: the day the disbursement is counted on (CXN-03). */
  treasuryPaidOn: string;
  ledgerEntries: number;
  advanceId: string | null;
}

/** The amounts did not agree: nothing was settled, and a difference with an owner and a due day was opened (or found open) for the two figures. */
export interface Mismatch {
  kind: 'MISMATCH';
  result: PaymentResult;
  transactionId: string;
  itemId: string;
  itemOpened: boolean;
  internalVnd: string;
  confirmedVnd: string;
  differenceVnd: string;
  ownerMembershipId: string;
  dueAt: string;
}

export type MatchOutcome = Settled | Mismatch;

interface RequestSql {
  id: string;
  status: string;
  request_kind: PaymentKind;
  contract_id: string;
  project_id: string;
  acceptance_id: string | null;
  advance_id: string | null;
  allocation_line_id: string | null;
  plan_year: number | null;
  gross_vnd: string;
  net_vnd: string;
}

interface TransactionSql {
  id: string;
  project_id: string;
  contract_id: string | null;
  payment_request_id: string | null;
  direction: string;
  amount_vnd: string;
  document_no: string | null;
  match_status: string;
  confirmed_at: string;
  paid_on: string;
}

/**
 * Matching a Treasury transaction to a payment request (ST-PAY-007, PAY 3.3 step 4, CXN-03). When the amount the Treasury confirmed is the net of the request, to the dong, the request is
 * SETTLED: the money paid goes on the cumulative ledger by an entry per balance (the gross of each, since the part that was recovered and held was booked when the request was sent), the paid total
 * of the contract moves once, an advance is paid, and the day the Treasury confirmed it is kept as the day the payment counts from. When it is not, the request does not move: the transaction is put
 * in exception and a difference opens with both figures, the signed difference, an owner and a due day; the larger figure is never taken. Everything runs in one transaction under the lock of the
 * contract, in the order of the product: the contract, the balances of the ledger, then the capital; the database refuses what the application missed (V1567).
 */
export class PaySettlementStore {
  private readonly contracts = new CtrContractStore();
  private readonly payments = new PayPaymentStore();
  private readonly rules = new MasterRules();
  private readonly clocks = new PayClockStore();
  private readonly ledger: PayLedgerStore;
  private readonly metrics: MetricsSink;

  constructor(metrics: MetricsSink = NOOP_METRICS) {
    this.metrics = metrics;
    this.ledger = new PayLedgerStore(metrics);
  }

  async match(tx: TenantTx, input: MatchInput): Promise<MatchOutcome> {
    const transactionId = idOf(input.transactionId, 'id');
    const requestId = idOf(input.paymentRequestId, 'payment_request_id');
    const actor = idOf(input.actor, 'actor');
    const peek = await tx.query<{ contract_id: string }>('select contract_id from machvon.payment_request where id = $1::uuid', [requestId]);
    // A request that does not exist, or lies outside the scope of the caller, is not found.
    if (peek[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const waitStarted = performance.now();
    await this.contracts.lock(tx, peek[0].contract_id, input.scopes);
    this.metrics.gauge(PAY_LEDGER_LOCK_WAIT_METRIC, (performance.now() - waitStarted) / 1000);
    const [request] = await tx.query<RequestSql>(
      `select id, status, request_kind, contract_id, project_id, acceptance_id, advance_id, allocation_line_id, plan_year, gross_vnd::text as gross_vnd, net_vnd::text as net_vnd
         from machvon.payment_request where id = $1::uuid for update`,
      [requestId],
    );
    if (request === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const [transaction] = await tx.query<TransactionSql>(
      `select id, project_id, contract_id, payment_request_id, direction, amount_vnd::text as amount_vnd, document_no, match_status,
              to_char(confirmed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as confirmed_at, (confirmed_at at time zone 'Asia/Ho_Chi_Minh')::date::text as paid_on
         from machvon.treasury_transaction where id = $1::uuid for update`,
      [transactionId],
    );
    // A transaction of another project is, for this caller, a transaction that is not there.
    if (transaction === undefined || transaction.project_id !== request.project_id) throw new DomainError('RESOURCE_NOT_FOUND', 404);

    if (transaction.match_status === 'MATCHED') throw new DomainError('TRANSACTION_ALREADY_MATCHED', 409, 'id', { extensions: { reason: 'MATCHED' } });
    if (transaction.payment_request_id !== null && transaction.payment_request_id !== request.id) throw new DomainError('TRANSACTION_ALREADY_MATCHED', 409, 'id', { extensions: { reason: 'TIED_TO_ANOTHER_REQUEST' } });
    if (transaction.direction !== 'PAYMENT') throw invalid('id', 'NOT_A_PAYMENT');
    if (request.status !== 'SENT_TREASURY') throw new DomainError('PAYMENT_STATE_INVALID', 409, 'payment_request_id', { extensions: { status: request.status } });

    const outcome = amountsAgree(request.net_vnd, transaction.amount_vnd) ? await this.settle(tx, request, transaction, actor, input) : await this.openMismatch(tx, request, transaction, actor, input.now);
    this.metrics.increment(PAY_MATCH_METRIC, { outcome: outcome.kind === 'SETTLED' ? 'settled' : 'mismatch' });
    return outcome;
  }

  /** The two figures do not agree: the transaction is put in exception and tied to the request, and one difference stays open for the pair. */
  private async openMismatch(tx: TenantTx, request: RequestSql, transaction: TransactionSql, actor: string, now: Date): Promise<Mismatch> {
    await tx.query(
      `update machvon.treasury_transaction
          set match_status = 'EXCEPTION', payment_request_id = $2::uuid, contract_id = $3::uuid, allocation_line_id = $4::uuid, plan_year = $5
        where id = $1::uuid and match_status <> 'EXCEPTION'`,
      [transaction.id, request.id, request.contract_id, request.allocation_line_id, request.plan_year],
    );
    const standing = await tx.query<{ id: string; owner_membership_id: string; due_at: string }>(
      `select id, owner_membership_id, to_char(due_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as due_at
         from machvon.reconciliation_item where treasury_transaction_id = $1::uuid and kind = 'AMOUNT_MISMATCH' and status in ('OPEN', 'EXPLAINED')`,
      [transaction.id],
    );
    let item = standing[0];
    const opened = item === undefined;
    if (item === undefined) {
      const [created] = await tx.query<{ id: string; owner_membership_id: string; due_at: string }>(
        `insert into machvon.reconciliation_item
           (tenant_id, id, project_id, contract_id, payment_request_id, treasury_transaction_id, kind, internal_amount_vnd, confirmed_amount_vnd, owner_membership_id, due_at, status, created_by, updated_by)
         values (${TENANT}, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'AMOUNT_MISMATCH', $6::numeric, $7::numeric, $8::uuid, $9::timestamptz + make_interval(secs => $10), 'OPEN', $8::uuid, $8::uuid)
         returning id, owner_membership_id, to_char(due_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as due_at`,
        [randomUUID(), request.project_id, request.contract_id, request.id, transaction.id, request.net_vnd, transaction.amount_vnd, actor, now.toISOString(), DEFAULT_ITEM_DUE_SECONDS],
      );
      if (created === undefined) throw new Error('the difference was not written');
      item = created;
    }
    return {
      kind: 'MISMATCH',
      result: await this.payments.resultOf(tx, request.id, 'SENT_TREASURY', []),
      transactionId: transaction.id,
      itemId: item.id,
      itemOpened: opened,
      internalVnd: request.net_vnd,
      confirmedVnd: transaction.amount_vnd,
      differenceVnd: reconciliationDifference(request.net_vnd, transaction.amount_vnd),
      ownerMembershipId: item.owner_membership_id,
      dueAt: item.due_at,
    };
  }

  private async settle(tx: TenantTx, request: RequestSql, transaction: TransactionSql, actor: string, input: MatchInput): Promise<Settled> {
    let entries = 0;
    let advanceId: string | null = null;
    try {
      // The transaction first (the request is still with the Treasury), then the books, then the request, which the database lets through only once all three agree.
      await tx.query(
        `update machvon.treasury_transaction
            set match_status = 'MATCHED', payment_request_id = $2::uuid, contract_id = $3::uuid, allocation_line_id = $4::uuid, plan_year = $5, matched_at = now(), matched_by = $6::uuid
          where id = $1::uuid`,
        [transaction.id, request.id, request.contract_id, request.allocation_line_id, request.plan_year, actor],
      );
      if (request.request_kind === 'ADVANCE') {
        advanceId = await this.payOutAdvance(tx, request, transaction, actor, input.requestId);
      } else {
        entries = await this.putPaymentOnTheBooks(tx, request, actor, input.requestId);
      }
      await tx.query(
        `update machvon.payment_request
            set status = 'SETTLED', treasury_paid_on = $2::date, settled_transaction_id = $3::uuid, settled_by = $4::uuid, settled_at = now(), updated_at = now(), updated_by = $4::uuid, version = version + 1
          where id = $1::uuid`,
        [request.id, transaction.paid_on, transaction.id, actor],
      );
      // G1-17: the Treasury has paid, so the clock of this attempt ends here (in time or late, judged when read).
      await this.clocks.end(tx, { requestId: request.id, endKind: 'SETTLED', actor, now: new Date() });
    } catch (error) {
      throw this.mapRefusal(error);
    }
    return {
      kind: 'SETTLED',
      result: await this.payments.resultOf(tx, request.id, 'SENT_TREASURY', []),
      transactionId: transaction.id,
      documentNo: transaction.document_no,
      amountVnd: transaction.amount_vnd,
      confirmedAt: transaction.confirmed_at,
      treasuryPaidOn: transaction.paid_on,
      ledgerEntries: entries,
      advanceId,
    };
  }

  /** The gross of each balance the request stood on is paid, and the paid total of the contract moves once by the gross of the request. */
  private async putPaymentOnTheBooks(tx: TenantTx, request: RequestSql, actor: string, requestId: string): Promise<number> {
    const lines = await tx.query<{ boq_item_id: string; party_id: string | null; gross_vnd: string; advance_recovery_vnd: string; retention_vnd: string }>(
      'select boq_item_id, party_id, gross_vnd::text as gross_vnd, advance_recovery_vnd::text as advance_recovery_vnd, retention_vnd::text as retention_vnd from machvon.payment_request_line where payment_request_id = $1::uuid',
      [request.id],
    );
    const groups = groupForLedger(lines.map((line) => ({ boqItemId: line.boq_item_id, partyId: line.party_id, grossVnd: line.gross_vnd, advanceRecoveryVnd: line.advance_recovery_vnd, retentionVnd: line.retention_vnd })));
    const balances: Array<{ id: string; grossVnd: string }> = [];
    for (const group of groups) {
      const [row] = await tx.query<{ id: string }>(
        'select id from machvon.cumulative_ledger where contract_id = $1::uuid and acceptance_id = $2::uuid and boq_item_id = $3::uuid and party_id is not distinct from $4::uuid',
        [request.contract_id, request.acceptance_id, group.boqItemId, group.partyId],
      );
      if (row === undefined) throw new DomainError('PAYMENT_STATE_INVALID', 409, 'id', { extensions: { reason: 'NOT_ON_THE_LEDGER', boq_item_id: group.boqItemId } });
      balances.push({ id: row.id, grossVnd: group.grossVnd });
    }
    await lockLedgerRows(tx, balances.map((balance) => ({ table: 'cumulative_ledger', id: balance.id })));
    const [contract] = await tx.query<{ outstanding: string }>(
      `update machvon.contract set paid_total_vnd = paid_total_vnd + $2::numeric, updated_at = now(), updated_by = $3::uuid, version = version + 1
        where id = $1::uuid returning (advance_paid_vnd - advance_recovered_vnd)::text as outstanding`,
      [request.contract_id, request.gross_vnd, actor],
    );
    for (const balance of balances) {
      await this.ledger.post(tx, {
        ledgerId: balance.id,
        kind: 'PAYMENT',
        delta: { accepted: '0', requested: '0', paid: balance.grossVnd, advanceRecovery: '0', retention: '0' },
        paymentRequestId: request.id,
        requestId,
        actor,
        advanceOutstandingVnd: contract?.outstanding ?? '0',
      });
    }
    return balances.length;
  }

  /** The advance asked for is paid: it keeps what was paid and the day, a land clearance advance its last day of recovery from the rule of that day, and the contract the money out. */
  private async payOutAdvance(tx: TenantTx, request: RequestSql, transaction: TransactionSql, actor: string, requestId: string): Promise<string> {
    if (request.advance_id === null) throw new DomainError('ADVANCE_STATE_INVALID', 409, 'advance_id');
    const [advance] = await tx.query<{ id: string; party_id: string; kind: string; status: string }>('select id, party_id, kind, status from machvon.contract_advance where id = $1::uuid for update', [request.advance_id]);
    if (advance === undefined || advance.status !== 'REQUESTED') throw new DomainError('ADVANCE_STATE_INVALID', 409, 'advance_id', { extensions: { status: advance?.status ?? null } });
    let deadline: string | null = null;
    if (advance.kind === 'GPMB') {
      const rule = await this.rules.read(tx, ADVANCE_GPMB_RULE, 'GPMB', transaction.paid_on);
      // Without the rule the last day is not made up: the advance is paid and the job that chases the overdue has nothing to chase until the rule is read.
      if (rule !== undefined) deadline = gpmbDeadline(transaction.paid_on, Number(rule.attributes.recovery_days));
    }
    await tx.query(
      `update machvon.contract_advance set status = 'PAID', paid_vnd = $2::numeric, paid_on = $3::date, recovery_deadline = $4::date, updated_at = now(), updated_by = $5::uuid, version = version + 1 where id = $1::uuid`,
      [advance.id, request.gross_vnd, transaction.paid_on, deadline, actor],
    );
    await tx.query('update machvon.contract set advance_paid_vnd = advance_paid_vnd + $2::numeric, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid', [request.contract_id, request.gross_vnd, actor]);
    await tx.query(
      `insert into machvon.advance_ledger_entry
         (tenant_id, id, contract_id, payment_request_id, entry_kind, amount_vnd, posted_at, advance_id, party_id, outstanding_after_vnd, posted_by, request_id)
       values (${TENANT}, gen_random_uuid(), $1::uuid, $2::uuid, 'DISBURSE', $3::numeric, now(), $4::uuid, $5::uuid, $3::numeric, $6::uuid, $7::uuid)`,
      [request.contract_id, request.id, request.gross_vnd, advance.id, advance.party_id, actor, requestId],
    );
    return advance.id;
  }

  /** What the database refused, in the words of the contract; anything else is not ours to explain. */
  private mapRefusal(error: unknown): unknown {
    const broken = valueExceeded(error, this.metrics);
    if (broken !== undefined) return broken;
    const failure = error as { code?: string; message?: string };
    if (failure.code !== CHECK_VIOLATION) return error;
    const message = failure.message ?? '';
    if (message.includes('PLAN_YEAR_MISMATCH')) return new DomainError('PLAN_YEAR_MISMATCH', 422, 'allocation_line_id');
    if (message.includes('TRANSACTION_ALREADY_MATCHED')) return new DomainError('TRANSACTION_ALREADY_MATCHED', 409, 'id');
    if (message.includes('TRANSACTION_NOT_MATCHABLE')) return new DomainError('PAYMENT_STATE_INVALID', 409, 'payment_request_id', { extensions: { reason: 'TRANSACTION_NOT_MATCHABLE' } });
    if (message.includes('ADVANCE_STATE_INVALID')) return new DomainError('ADVANCE_STATE_INVALID', 409, 'advance_id');
    return error;
  }
}
