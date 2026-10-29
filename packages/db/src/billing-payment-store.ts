import { DomainError, PAYABLE_INVOICE_STATUSES, autoMatch, invoiceCodesIn, judgeMatch, outstandingVnd, versionConflict } from '@machvon/kernel';
import type { BillingPaymentMethod, PaymentCandidate } from '@machvon/kernel';
import { actingAsTenant, tenantOfInvoice } from './acting-as.ts';
import type { ApprovalEffects } from './approval-store.ts';
import { BillingStore } from './billing-store.ts';
import type { InvoiceRow } from './billing-store.ts';
import type { TenantTx } from './tenant-database.ts';

export type PaymentStatus = 'Unmatched' | 'PendingReview' | 'Matched' | 'Reversed';

export interface PaymentRow {
  id: string;
  tenantId: string;
  invoiceId: string | null;
  provider: string;
  txnRef: string;
  amountVnd: string;
  method: BillingPaymentMethod;
  receivedAt: Date;
  status: PaymentStatus;
  matchedBy: string | null;
  matchedAt: Date | null;
  memo: string;
  version: number;
}

export interface RecordPaymentInput {
  provider: string;
  txnRef: string;
  amountVnd: string;
  method: BillingPaymentMethod;
  receivedAt: Date;
  memo: string;
  inboxEventId: string | null;
}

interface PaymentDbRow {
  id: string;
  tenant_id: string;
  invoice_id: string | null;
  provider: string;
  provider_txn_ref: string;
  amount_vnd: string;
  method: BillingPaymentMethod;
  received_at: Date;
  match_status: PaymentStatus;
  matched_by: string | null;
  matched_at: Date | null;
  memo: string;
  version: string;
}

const PAYMENT_COLUMNS = 'id, tenant_id, invoice_id, provider, provider_txn_ref, amount_vnd::text, method, received_at, match_status, matched_by, matched_at, memo, version::text';

const paymentOf = (row: PaymentDbRow): PaymentRow => ({
  id: row.id,
  tenantId: row.tenant_id,
  invoiceId: row.invoice_id,
  provider: row.provider,
  txnRef: row.provider_txn_ref,
  amountVnd: row.amount_vnd,
  method: row.method,
  receivedAt: row.received_at,
  status: row.match_status,
  matchedBy: row.matched_by,
  matchedAt: row.matched_at,
  memo: row.memo,
  version: Number(row.version),
});

export const PAYMENT_MATCHED_EVENT = 'sas.payment.matched.v1';
/** The gauge of the payments that wait for a person (Unmatched and PendingReview): the alert of the story. */
export const PAYMENT_UNMATCHED_GAUGE = 'payment_unmatched_total';
/** How many payments one pass of the matching worker looks at. */
export const MATCH_BATCH = 50;

export interface PassResult {
  matched: number;
  review: number;
  unmatched: number;
  /** All the payments that wait for a person after the pass. */
  waiting: number;
}

/**
 * The payments that come in and their reconciliation (ST-SAS-012, SAS.md 3.7 item 3). A payment is recorded once for each transaction of a provider and lives under the platform tenant until it is matched: the callback
 * does not know the tenant, the note of the transfer names an invoice. Matching moves it to the tenant of the invoice (`billing_payment_adopt`) as Matched and settles the invoice, in the transaction of the
 * control role that acts as that tenant. A payment settles an invoice only for exactly what is still to be paid; anything else is for a person.
 */
export class BillingPaymentStore {
  private readonly invoices = new BillingStore();

  /** Records a payment of the platform tenant (the transaction of the caller): a second callback for the same transaction finds the first and makes nothing. */
  async record(tx: TenantTx, input: RecordPaymentInput): Promise<{ payment: PaymentRow | undefined; created: boolean }> {
    const inserted = await tx.query<PaymentDbRow>(
      `insert into machvon.billing_payment (tenant_id, id, invoice_id, provider, provider_txn_ref, amount_vnd, method, received_at, match_status, source_inbox_event_id, memo)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), null, $1, $2, $3::numeric, $4, $5::timestamptz, 'Unmatched', $6::uuid, $7)
       on conflict (provider, provider_txn_ref) do nothing returning ${PAYMENT_COLUMNS}`,
      [input.provider, input.txnRef, input.amountVnd, input.method, input.receivedAt.toISOString(), input.inboxEventId, input.memo],
    );
    if (inserted[0] !== undefined) return { payment: paymentOf(inserted[0]), created: true };
    // The transaction was seen before: by this tenant (still waiting) or, when it has been matched since, by the tenant of an invoice, which this transaction cannot read. Either way it is one payment.
    const [existing] = await tx.query<PaymentDbRow>(`select ${PAYMENT_COLUMNS} from machvon.billing_payment where provider = $1 and provider_txn_ref = $2`, [input.provider, input.txnRef]);
    return { payment: existing === undefined ? undefined : paymentOf(existing), created: false };
  }

  async find(tx: TenantTx, id: string, forUpdate = false): Promise<PaymentRow | undefined> {
    const rows = await tx.query<PaymentDbRow>(`select ${PAYMENT_COLUMNS} from machvon.billing_payment where id = $1::uuid${forUpdate ? ' for update' : ''}`, [id]);
    return rows[0] === undefined ? undefined : paymentOf(rows[0]);
  }

  /** The payments of the tenant of the transaction, the latest first, optionally of one status; `after` is the last of the page before. */
  async list(tx: TenantTx, filter: { status?: PaymentStatus | undefined; limit: number; after?: { receivedAt: string; id: string } | undefined }): Promise<PaymentRow[]> {
    const rows = await tx.query<PaymentDbRow>(
      `select ${PAYMENT_COLUMNS} from machvon.billing_payment where ($1::text is null or match_status = $1) and ($3::timestamptz is null or (received_at, id) < ($3::timestamptz, $4::uuid)) order by received_at desc, id desc limit $2::int`,
      [filter.status ?? null, filter.limit, filter.after?.receivedAt ?? null, filter.after?.id ?? null],
    );
    return rows.map(paymentOf);
  }

  /** The payments that matched each invoice (the tenant of the transaction). */
  async ofInvoices(tx: TenantTx, invoiceIds: readonly string[]): Promise<PaymentRow[]> {
    if (invoiceIds.length === 0) return [];
    const rows = await tx.query<PaymentDbRow>(`select ${PAYMENT_COLUMNS} from machvon.billing_payment where invoice_id = any($1::uuid[]) order by received_at, id`, [invoiceIds]);
    return rows.map(paymentOf);
  }

  /** How many payments of the platform tenant wait for a person. */
  async waitingCount(tx: TenantTx): Promise<number> {
    const [row] = await tx.query<{ n: string }>("select count(*)::text as n from machvon.billing_payment where match_status in ('Unmatched', 'PendingReview')");
    return Number(row?.n ?? 0);
  }

  /**
   * What is still owed on an invoice (the one definition of the database: `invoice_outstanding`): its total and the adjustments of it that were issued (one waiting for the provider is not yet a credit), less what was paid
   * on it and on the invoices it replaced, back along the chain (a replacement is the whole invoice again).
   */
  private async outstandingOf(tx: TenantTx, invoiceId: string): Promise<string> {
    const [row] = await tx.query<{ outstanding: string }>('select machvon.invoice_outstanding($1::uuid)::text as outstanding', [invoiceId]);
    return row?.outstanding ?? '0';
  }

  /** The invoices a payment's note names, in any tenant, with what is still to be paid of each. */
  async candidates(tx: TenantTx, memo: string): Promise<PaymentCandidate[]> {
    const found = new Map<string, PaymentCandidate>();
    for (const code of invoiceCodesIn(memo)) {
      const rows = await tx.query<{ tenant_id: string; invoice_id: string; kind: string; status: string; total_vnd: string; paid_vnd: string }>('select tenant_id, invoice_id, kind, status, total_vnd::text, paid_vnd::text from machvon.invoice_by_code($1)', [code]);
      for (const row of rows) found.set(row.invoice_id, { tenantId: row.tenant_id, invoiceId: row.invoice_id, kind: row.kind, status: row.status, outstandingVnd: outstandingVnd(row.total_vnd, row.paid_vnd) });
    }
    return [...found.values()];
  }

  /**
   * Matches a payment of the platform tenant (the transaction of the caller: the control role acting as the platform) with an invoice, which is settled in the tenant of the invoice. The payment must be
   * waiting (409 PAYMENT_STATE_INVALID) and the invoice payable (409 EINVOICE_STATE_INVALID); the amount must be exactly what is still to be paid (422 AMOUNT_MISMATCH). When the last overdue invoice of a
   * subscription that was past due is settled, the subscription is Active again and the proposal to suspend it falls away.
   */
  async match(tx: TenantTx, effects: ApprovalEffects, input: { platformTenantId: string; paymentId: string; invoiceId: string; matchedBy: string; reason?: string | undefined; expectedVersion?: number | undefined; now: Date }): Promise<{ payment: PaymentRow; invoice: InvoiceRow }> {
    const waiting = await this.find(tx, input.paymentId, true);
    if (waiting === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (input.expectedVersion !== undefined && input.expectedVersion !== waiting.version) throw versionConflict(waiting.version);
    if (waiting.status !== 'Unmatched' && waiting.status !== 'PendingReview') throw new DomainError('PAYMENT_STATE_INVALID', 409, 'status', { extensions: { status: waiting.status } });
    const tenantId = await tenantOfInvoice(tx, input.invoiceId);
    if (tenantId === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'invoice_id');
    return actingAsTenant(tx, tenantId, input.platformTenantId, async () => {
      // The locks are taken in the order of the billing job: the subscription first, then its invoice (the invoice is read without a lock to find the subscription).
      const unlocked = await this.invoices.find(tx, input.invoiceId);
      if (unlocked === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'invoice_id');
      // The subscription is the lock of the settlements of its invoices: two payments that settle its last two overdue invoices at the same moment take turns, so the second finds the first and the subscription recovers.
      await tx.query('select id from machvon.subscription where id = $1::uuid for update', [unlocked.subscriptionId]);
      const invoice = await this.invoices.find(tx, input.invoiceId, true);
      if (invoice === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'invoice_id');
      if (!PAYABLE_INVOICE_STATUSES.includes(invoice.status)) throw new DomainError('EINVOICE_STATE_INVALID', 409, 'invoice_id', { extensions: { status: invoice.status } });
      // An adjustment is folded into the invoice it adjusts and is never paid by itself.
      if (invoice.kind === 'ADJUSTMENT') throw new DomainError('EINVOICE_STATE_INVALID', 409, 'invoice_id', { extensions: { status: invoice.status, kind: invoice.kind } });
      const outstanding = await this.outstandingOf(tx, invoice.id);
      if (judgeMatch(waiting.amountVnd, outstanding) !== 'MATCH') throw new DomainError('AMOUNT_MISMATCH', 422, 'invoice_id', { extensions: { outstanding_vnd: outstanding, payment_vnd: waiting.amountVnd } });
      const [adopted] = await tx.query<{ id: string }>('select machvon.billing_payment_adopt($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid) as id', [input.platformTenantId, waiting.id, tenantId, invoice.id, input.matchedBy]);
      const payment = (await this.find(tx, (adopted as { id: string }).id)) as PaymentRow;
      // An adjusted invoice stays Adjusted (the table lets it go to Replaced only): what was paid says it is settled.
      if (invoice.status !== 'Adjusted') await tx.query("update machvon.invoice set status = 'Paid', version = version + 1 where id = $1::uuid", [invoice.id]);
      else await tx.query('update machvon.invoice set overdue_since = null, version = version + 1 where id = $1::uuid', [invoice.id]);
      const settled = (await this.invoices.find(tx, invoice.id)) as InvoiceRow;
      await effects.audit({ action: 'billing.payment_matched', resourceType: 'billing_payment', resourceId: payment.id, ...(input.reason === undefined ? {} : { reason: input.reason }), diff: { invoice_id: invoice.id, amount_vnd: payment.amountVnd, provider: payment.provider } });
      await effects.emit({
        aggregateType: 'billing_payment',
        aggregateId: payment.id,
        aggregateVersion: payment.version,
        eventKey: `billing_payment:${payment.id}:matched`,
        type: PAYMENT_MATCHED_EVENT,
        schemaVersion: 1,
        payload: { payment_id: payment.id, invoice_id: invoice.id, subscription_id: invoice.subscriptionId, amount_vnd: payment.amountVnd },
      });
      await this.invoices.reconcile(tx, effects, invoice.subscriptionId);
      return { payment, invoice: settled };
    });
  }

  /**
   * The matching worker over the payments that wait: the one whose note names a single payable invoice for exactly what is still to be paid is matched, one whose note and amount do not agree goes to
   * PendingReview, the others stay Unmatched. Each payment is looked at in a transaction of its own (`transact`, the control role acting as the platform tenant), so the locks of a settlement (the payment, the
   * subscription, the invoice) are held for that payment only and never while the next one is waited for: a person matching another payment of the same subscription cannot be caught in a cycle with the batch.
   * Only the payments whose note names an invoice code are looked at, the ones looked at longest ago first, so that a payment that cannot be settled is looked at again only after the others. A pass changes nothing it
   * already settled.
   */
  async pass(
    transact: <T>(work: (tx: TenantTx) => Promise<T>) => Promise<T>,
    effectsOf: (tx: TenantTx) => ApprovalEffects,
    input: { platformTenantId: string; workerMembershipId: string; now: Date },
  ): Promise<PassResult> {
    const result: PassResult = { matched: 0, review: 0, unmatched: 0, waiting: 0 };
    const ids = await transact(async (tx) => {
      const found = await tx.query<{ id: string }>(
        "select id from machvon.billing_payment where match_status = 'Unmatched' and memo ~* 'INV-[0-9]{8}-[0-9A-F]{8}' order by match_attempted_at nulls first, received_at, id limit $1::int",
        [MATCH_BATCH],
      );
      const [noCode] = await tx.query<{ n: string }>("select count(*)::text as n from machvon.billing_payment where match_status = 'Unmatched' and memo !~* 'INV-[0-9]{8}-[0-9A-F]{8}'");
      result.unmatched += Number(noCode?.n ?? 0);
      return found.map((row) => row.id);
    });
    for (const id of ids) {
      const verdict = await transact((tx) => this.scanOne(tx, effectsOf(tx), { ...input, paymentId: id }));
      if (verdict === 'MATCHED') result.matched += 1;
      else if (verdict === 'REVIEW') result.review += 1;
      else if (verdict === 'UNMATCHED') result.unmatched += 1;
    }
    result.waiting = await transact((tx) => this.waitingCount(tx));
    return result;
  }

  /** One payment of the pass, in the transaction of the caller. A payment that someone else holds (a person is matching it) or that is no longer waiting is left alone. */
  private async scanOne(tx: TenantTx, effects: ApprovalEffects, input: { platformTenantId: string; workerMembershipId: string; now: Date; paymentId: string }): Promise<'MATCHED' | 'REVIEW' | 'UNMATCHED' | 'SKIPPED'> {
    const [row] = await tx.query<PaymentDbRow>(`select ${PAYMENT_COLUMNS} from machvon.billing_payment where id = $1::uuid and match_status = 'Unmatched' for update skip locked`, [input.paymentId]);
    if (row === undefined) return 'SKIPPED';
    const payment = paymentOf(row);
    await tx.query('update machvon.billing_payment set match_attempted_at = $2::timestamptz where id = $1::uuid', [payment.id, input.now.toISOString()]);
    const decision = autoMatch(payment.amountVnd, await this.candidates(tx, payment.memo), invoiceCodesIn(payment.memo).length);
    let verdict: 'MATCH' | 'UNMATCHED' | 'REVIEW' = decision.verdict;
    if (decision.verdict === 'MATCH') {
      try {
        await this.match(tx, effects, { platformTenantId: input.platformTenantId, paymentId: payment.id, invoiceId: decision.candidate.invoiceId, matchedBy: input.workerMembershipId, now: input.now });
        return 'MATCHED';
      } catch (error) {
        // The invoice moved between the look and the settlement (paid by another payment, changed): a person decides. Only a refusal of the rules lands here, nothing was written.
        if (!(error instanceof DomainError)) throw error;
        verdict = 'REVIEW';
      }
    }
    if (verdict === 'REVIEW') {
      await tx.query("update machvon.billing_payment set match_status = 'PendingReview', version = version + 1 where id = $1::uuid and match_status = 'Unmatched'", [payment.id]);
      return 'REVIEW';
    }
    return 'UNMATCHED';
  }
}
