import { randomUUID } from 'node:crypto';
import { DomainError, compareDecimal, requirePositiveAmount, subtractDecimal } from '@machvon/kernel';
import { creditBalance, debitBalance, lockLedgerRows } from './ledger-lock.ts';
import type { TenantTx } from './tenant-database.ts';

/** What a posting did: `posted` entries were appended; `covered` (the contract already holds the commitment), `unchanged` (the fact was posted before) and `stale` (the request is no longer in the state the event reports) append none. */
export type PostingOutcome = 'posted' | 'covered' | 'unchanged' | 'stale';

export interface PostingResult {
  outcome: PostingOutcome;
  /** The entries appended, by type, in the order they were written. */
  entries: Array<{ id: string; type: 'COMMIT' | 'UNCOMMIT' | 'DISBURSE' | 'REVERSAL'; amountVnd: string }>;
}

/** The facts of a payment request every posting needs: whole VND of the net, the line it is drawn on and the year of the plan. */
export interface PaymentFacts {
  paymentRequestId: string;
  contractId: string;
  allocationLineId: string;
  /** The plan year of the event; the year of the appropriation of the line when the event names none. */
  planYear: number | undefined;
  /** Whole VND, above zero: the net the Treasury pays. */
  amountVnd: string;
}

export interface DisbursementFacts extends PaymentFacts {
  /** The Treasury transaction that settled the request. */
  transactionId: string;
  /** The moment the Treasury confirmed it (UTC): the entry is dated by it. */
  confirmedAt: string;
}

export interface ReversalFacts extends PaymentFacts {
  settledTransactionId: string;
  refundTransactionId: string;
  /** The moment the Treasury confirmed the refund (UTC). */
  refundConfirmedAt: string;
}

/** The statuses of a request that is on its way to the Treasury: the capital it needs is committed while it is in one of them. */
const IN_FLIGHT = ['SUBMITTED', 'VERIFIED', 'SENT_TREASURY'] as const;
const PAID = ['SETTLED', 'REVERSED'] as const;

const RETURN_REASON = 'The payment request was returned.';
const SETTLED_REASON = 'The Treasury confirmed the payment.';
const REVERSED_REASON = 'The payment was reversed.';

interface LineRow {
  line_id: string;
  balance_id: string;
  project_id: string;
  appropriation_id: string | null;
  plan_year: number | null;
}

interface EntryRow {
  id: string;
  entry_type: string;
  amount_vnd: string;
  source_ref_seq: number;
}

type EntryType = 'COMMIT' | 'UNCOMMIT' | 'DISBURSE' | 'REVERSAL';

/**
 * The postings of the capital ledger that come from payments (ST-CAP-006, CAP 3.4, BR-CAP-06). The contract commits its whole value to its line when it is activated, so a payment request is paid out of
 * that commitment and commits nothing again; only a request whose contract holds no commitment on the line commits its net while it is on its way, and gives it back when it is returned. The payment
 * the Treasury confirmed turns the commitment into a disbursement dated by the day the Treasury paid (`UNCOMMIT` and `DISBURSE`), and the refund of a reversal takes the disbursement back (`REVERSAL` of
 * the `DISBURSE`, and of the `UNCOMMIT` when the contract's own commitment paid it, so the amount is owed again). Every posting locks the balance of the line first, reads the figures under the lock,
 * moves the balance with its entry in the same transaction and refuses (409 `BALANCE_INSUFFICIENT`) what the balance cannot take, so two postings that together overspend a line never both succeed. A fact
 * is posted once whoever replays it (the key of the ledger entry names the request or the transaction), and a request is posted according to the state it is in now, not the order the events arrive in.
 */
export class CapPaymentLedgerStore {
  /** The request is sent: its net is committed unless the contract already holds the commitment. */
  async commit(tx: TenantTx, facts: PaymentFacts, actor: string): Promise<PostingResult> {
    requirePositiveAmount(facts.amountVnd, 0);
    const line = await this.lockLine(tx, facts);
    const status = await this.statusOf(tx, facts.paymentRequestId);
    if (!IN_FLIGHT.includes(status as (typeof IN_FLIGHT)[number])) return { outcome: 'stale', entries: [] };
    const own = await this.ownEntries(tx, facts);
    if (liveCommitOf(own) !== undefined) return { outcome: 'unchanged', entries: [] };
    if (await this.contractHoldsCommitment(tx, facts)) return { outcome: 'covered', entries: [] };
    const entry = await this.post(tx, line, { type: 'COMMIT', amount: facts.amountVnd, kind: 'PAYMENT_REQUEST', sourceId: facts.paymentRequestId, seq: countOf(own, 'COMMIT'), planYear: facts.planYear, reason: null }, actor);
    await this.addCommitted(tx, line, facts.amountVnd);
    return { outcome: 'posted', entries: [entry] };
  }

  /** The request is returned (or cancelled): the commitment it made is given back. */
  async release(tx: TenantTx, facts: PaymentFacts, actor: string): Promise<PostingResult> {
    requirePositiveAmount(facts.amountVnd, 0);
    const line = await this.lockLine(tx, facts);
    const status = await this.statusOf(tx, facts.paymentRequestId);
    if (IN_FLIGHT.includes(status as (typeof IN_FLIGHT)[number]) || PAID.includes(status as (typeof PAID)[number])) return { outcome: 'stale', entries: [] };
    const own = await this.ownEntries(tx, facts);
    const live = liveCommitOf(own);
    if (live === undefined) return { outcome: 'unchanged', entries: [] };
    const entry = await this.post(tx, line, { type: 'UNCOMMIT', amount: live.amount_vnd, kind: 'PAYMENT_REQUEST', sourceId: facts.paymentRequestId, seq: countOf(own, 'UNCOMMIT'), planYear: facts.planYear, reason: RETURN_REASON }, actor);
    await debitBalance(tx, ref(line, 'committed_vnd'), live.amount_vnd);
    return { outcome: 'posted', entries: [entry] };
  }

  /** The Treasury confirmed the payment: the commitment becomes a disbursement, dated by the day the Treasury paid. */
  async disburse(tx: TenantTx, facts: DisbursementFacts, actor: string): Promise<PostingResult> {
    requirePositiveAmount(facts.amountVnd, 0);
    const line = await this.lockLine(tx, facts);
    const status = await this.statusOf(tx, facts.paymentRequestId);
    if (!PAID.includes(status as (typeof PAID)[number])) return { outcome: 'stale', entries: [] };
    const earlier = await this.disbursementOf(tx, facts.transactionId, facts.allocationLineId);
    if (earlier !== undefined) {
      if (earlier.amount_vnd !== facts.amountVnd) throw new DomainError('IDEMPOTENCY_CONFLICT', 409, 'amount_vnd', { extensions: { disbursed_vnd: earlier.amount_vnd } });
      return { outcome: 'unchanged', entries: [] };
    }
    const entries: PostingResult['entries'] = [];
    const own = await this.ownEntries(tx, facts);
    const live = liveCommitOf(own);
    if (live !== undefined && live.amount_vnd !== facts.amountVnd) throw new DomainError('IDEMPOTENCY_CONFLICT', 409, 'amount_vnd', { extensions: { committed_vnd: live.amount_vnd } });
    if (live === undefined && !(await this.contractHoldsCommitment(tx, facts))) {
      // The event of the sending was not read yet: the capital is committed first, so the ledger tells the whole story and the balance never goes below nothing.
      entries.push(await this.post(tx, line, { type: 'COMMIT', amount: facts.amountVnd, kind: 'PAYMENT_REQUEST', sourceId: facts.paymentRequestId, seq: countOf(own, 'COMMIT'), planYear: facts.planYear, reason: null }, actor));
      await this.addCommitted(tx, line, facts.amountVnd);
    }
    entries.push(
      await this.post(tx, line, { type: 'UNCOMMIT', amount: facts.amountVnd, kind: 'PAYMENT_REQUEST', sourceId: facts.paymentRequestId, seq: countOf(own, 'UNCOMMIT'), planYear: facts.planYear, reason: SETTLED_REASON }, actor),
    );
    await debitBalance(tx, ref(line, 'committed_vnd'), facts.amountVnd);
    entries.push(
      await this.post(tx, line, { type: 'DISBURSE', amount: facts.amountVnd, kind: 'TREASURY_TRANSACTION', sourceId: facts.transactionId, seq: 0, planYear: facts.planYear, reason: SETTLED_REASON, postedAt: facts.confirmedAt }, actor),
    );
    await creditBalance(tx, ref(line, 'disbursed_vnd'), facts.amountVnd);
    return { outcome: 'posted', entries };
  }

  /**
   * The refund of a reversed payment: the disbursement is taken back, dated by the day the Treasury confirmed the refund. When the contract's own commitment paid it, the amount is committed again
   * (the acceptance can be claimed again); a request that committed capital of its own is finished, so nothing is committed for it.
   */
  async reverse(tx: TenantTx, facts: ReversalFacts, actor: string): Promise<PostingResult> {
    requirePositiveAmount(facts.amountVnd, 0);
    const line = await this.lockLine(tx, facts);
    const disbursed = await this.disbursementOf(tx, facts.settledTransactionId, facts.allocationLineId);
    // The refund can be read before the payment it undoes: the delivery is tried again until the disbursement is there.
    if (disbursed === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'settled_transaction_id');
    if (disbursed.amount_vnd !== facts.amountVnd) throw new DomainError('IDEMPOTENCY_CONFLICT', 409, 'amount_vnd', { extensions: { disbursed_vnd: disbursed.amount_vnd } });
    if ((await this.reversalOf(tx, disbursed.id)) !== undefined) return { outcome: 'unchanged', entries: [] };
    const entries: PostingResult['entries'] = [];
    entries.push(
      await this.post(
        tx,
        line,
        { type: 'REVERSAL', amount: facts.amountVnd, kind: 'TREASURY_TRANSACTION', sourceId: facts.refundTransactionId, seq: 0, planYear: facts.planYear, reason: REVERSED_REASON, postedAt: facts.refundConfirmedAt, reversalOfId: disbursed.id },
        actor,
      ),
    );
    await debitBalance(tx, ref(line, 'disbursed_vnd'), facts.amountVnd);
    const own = await this.ownEntries(tx, facts);
    if (countOf(own, 'COMMIT') === 0) {
      const paidOut = lastOf(own, 'UNCOMMIT');
      if (paidOut !== undefined && (await this.reversalOf(tx, paidOut.id)) === undefined) {
        entries.push(
          await this.post(
            tx,
            line,
            { type: 'REVERSAL', amount: paidOut.amount_vnd, kind: 'PAYMENT_REQUEST', sourceId: facts.paymentRequestId, seq: 0, planYear: facts.planYear, reason: REVERSED_REASON, postedAt: facts.refundConfirmedAt, reversalOfId: paidOut.id },
            actor,
          ),
        );
        await this.addCommitted(tx, line, paidOut.amount_vnd);
      }
    }
    return { outcome: 'posted', entries };
  }

  /** The line and its balance, the balance locked: everything after it is read under the lock. */
  private async lockLine(tx: TenantTx, facts: PaymentFacts): Promise<LineRow> {
    const [peek] = await tx.query<LineRow>(
      `select al.id as line_id, ab.id as balance_id, al.project_id, al.appropriation_id, a.plan_year
         from machvon.allocation_line al
         join machvon.allocation_balance ab on ab.tenant_id = al.tenant_id and ab.allocation_line_id = al.id
         left join machvon.appropriation a on a.tenant_id = al.tenant_id and a.id = al.appropriation_id
        where al.id = $1::uuid`,
      [facts.allocationLineId],
    );
    if (peek === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'allocation_line_id');
    if (peek.appropriation_id === null) throw new DomainError('VALIDATION_FAILED', 422, 'allocation_line_id', { extensions: { reason: 'LINE_WITHOUT_APPROPRIATION' } });
    await lockLedgerRows(tx, [{ table: 'allocation_balance', id: peek.balance_id }]);
    return peek;
  }

  private async statusOf(tx: TenantTx, paymentRequestId: string): Promise<string> {
    const [row] = await tx.query<{ status: string }>('select status from machvon.payment_request where id = $1::uuid', [paymentRequestId]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'payment_request_id');
    return row.status;
  }

  private ownEntries(tx: TenantTx, facts: PaymentFacts): Promise<EntryRow[]> {
    return tx.query<EntryRow>(
      `select id, entry_type, amount_vnd::text as amount_vnd, source_ref_seq::int as source_ref_seq from machvon.capital_ledger_entry
        where source_ref_kind = 'PAYMENT_REQUEST' and source_ref_id = $1::uuid and allocation_line_id = $2::uuid order by source_ref_seq, posted_at, id`,
      [facts.paymentRequestId, facts.allocationLineId],
    );
  }

  /** Whether the contract committed its value to this line when it was activated (CTR): a payment is paid out of that commitment. */
  private async contractHoldsCommitment(tx: TenantTx, facts: PaymentFacts): Promise<boolean> {
    const rows = await tx.query(
      "select 1 from machvon.capital_ledger_entry where source_ref_kind = 'CONTRACT' and source_ref_id = $1::uuid and entry_type = 'COMMIT' and allocation_line_id = $2::uuid limit 1",
      [facts.contractId, facts.allocationLineId],
    );
    return rows.length > 0;
  }

  private async disbursementOf(tx: TenantTx, transactionId: string, allocationLineId: string): Promise<EntryRow | undefined> {
    const [row] = await tx.query<EntryRow>(
      `select id, entry_type, amount_vnd::text as amount_vnd, source_ref_seq::int as source_ref_seq from machvon.capital_ledger_entry
        where source_ref_kind = 'TREASURY_TRANSACTION' and source_ref_id = $1::uuid and entry_type = 'DISBURSE' and allocation_line_id = $2::uuid`,
      [transactionId, allocationLineId],
    );
    return row;
  }

  private async reversalOf(tx: TenantTx, entryId: string): Promise<EntryRow | undefined> {
    const [row] = await tx.query<EntryRow>('select id, entry_type, amount_vnd::text as amount_vnd, source_ref_seq::int as source_ref_seq from machvon.capital_ledger_entry where reversal_of_id = $1::uuid', [entryId]);
    return row;
  }

  /** Commits `amount` more on the balance: what the line was allocated minus what is committed and disbursed is all it can take, and more answers 409 before anything is written. */
  private async addCommitted(tx: TenantTx, line: LineRow, amount: string): Promise<void> {
    const [row] = await tx.query<{ allocated: string; committed: string; disbursed: string }>(
      'select allocated_vnd::text as allocated, committed_vnd::text as committed, disbursed_vnd::text as disbursed from machvon.allocation_balance where id = $1::uuid',
      [line.balance_id],
    );
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const room = subtractDecimal(subtractDecimal(row.allocated, row.committed), row.disbursed);
    if (compareDecimal(room, amount) < 0) throw new DomainError('BALANCE_INSUFFICIENT', 409, 'amount', { extensions: { available_vnd: room } });
    await creditBalance(tx, ref(line, 'committed_vnd'), amount);
  }

  private async post(
    tx: TenantTx,
    line: LineRow,
    entry: { type: EntryType; amount: string; kind: 'PAYMENT_REQUEST' | 'TREASURY_TRANSACTION'; sourceId: string; seq: number; planYear: number | undefined; reason: string | null; postedAt?: string; reversalOfId?: string },
    actor: string,
  ): Promise<PostingResult['entries'][number]> {
    const planYear = entry.planYear ?? line.plan_year;
    if (planYear === null || planYear === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'plan_year');
    const id = randomUUID();
    await tx.query(
      `insert into machvon.capital_ledger_entry
         (tenant_id, id, appropriation_id, allocation_line_id, project_id, entry_type, amount_vnd, plan_year, source_ref_kind, source_ref_id, source_ref_seq, reversal_of_id, reason, posted_at, posted_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::numeric, $7::integer, $8, $9::uuid, $10::smallint, $11::uuid, $12, coalesce($13::timestamptz, now()), $14::uuid)`,
      [id, line.appropriation_id, line.line_id, line.project_id, entry.type, entry.amount, planYear, entry.kind, entry.sourceId, entry.seq, entry.reversalOfId ?? null, entry.reason, entry.postedAt ?? null, actor],
    );
    return { id, type: entry.type, amountVnd: entry.amount };
  }
}

const ref = (line: LineRow, column: 'committed_vnd' | 'disbursed_vnd') => ({ table: 'allocation_balance', id: line.balance_id, column });

const countOf = (rows: readonly EntryRow[], type: string): number => rows.filter((row) => row.entry_type === type).length;
const lastOf = (rows: readonly EntryRow[], type: string): EntryRow | undefined => [...rows].reverse().find((row) => row.entry_type === type);

/** The commitment a request holds now: its last COMMIT when the UNCOMMITs after it are fewer than the COMMITs. */
function liveCommitOf(rows: readonly EntryRow[]): EntryRow | undefined {
  return countOf(rows, 'COMMIT') > countOf(rows, 'UNCOMMIT') ? lastOf(rows, 'COMMIT') : undefined;
}
