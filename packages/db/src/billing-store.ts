import { DomainError, ISSUE_MAX_ATTEMPTS, ISSUE_WINDOW_MS, addDays, billingPeriodAt, daysInPeriod, invoiceCodeOf, invoiceTotals, isBillingPeriod, nextIssueAttempt, priceForDays, priceLine, suspensionProposed, usageLine, versionConflict, vietnamDateOf } from '@machvon/kernel';
import type { BillingPeriod, InvoiceLineDraft, MeteredFeature, PlanBillingCycle, PricedInvoiceLine, VatCategory } from '@machvon/kernel';
import type { ApprovalEffects } from './approval-store.ts';
import { EInvoiceProviderUnavailable } from './einvoice-provider.ts';
import type { EInvoiceIssueRequest, EInvoiceProviderPort } from './einvoice-provider.ts';
import type { TenantTx } from './tenant-database.ts';

export type InvoiceStatus = 'Draft' | 'Discarded' | 'PendingIssue' | 'IssueFailed' | 'Issued' | 'Sent' | 'PartiallyPaid' | 'Paid' | 'Overdue' | 'Adjusted' | 'Replaced';

export interface InvoiceRow {
  id: string;
  subscriptionId: string;
  invoiceCode: string;
  periodStart: string;
  periodEnd: string;
  kind: 'ORIGINAL' | 'ADJUSTMENT' | 'REPLACEMENT';
  status: InvoiceStatus;
  subtotalVnd: string;
  vatVnd: string;
  totalVnd: string;
  buyer: { code: string; name: string };
  provider: string | null;
  templateCode: string | null;
  series: string | null;
  number: string | null;
  taxAuthorityCode: string | null;
  lookupCode: string | null;
  providerRef: string | null;
  issuedAt: Date | null;
  dueAt: string | null;
  issueAttempts: number;
  nextAttemptAt: Date | null;
  issueError: string | null;
  version: number;
}

export interface InvoiceLineRow {
  id: string;
  invoiceId: string;
  lineNo: number;
  kind: string;
  description: string;
  amountVnd: string;
  vatCategory: VatCategory;
  vatVnd: string;
  meter: string | null;
  quantity: string | null;
  unitPriceVnd: string | null;
}

/** What one run of the billing did for a tenant. */
export interface BillingRunResult {
  created: InvoiceRow[];
  /** Invoices the period already had: a second run finds them and makes none. */
  existing: InvoiceRow[];
  /** Subscriptions that were due and had nothing to bill (a plan that costs nothing and no use beyond its limits). */
  nothingToBill: number;
}

export type IssueOutcome = 'ISSUED' | 'PENDING' | 'FAILED';

/** What the sweep for the clock did: the invoices past their due day and the subscriptions that went with them. */
export interface BillingOverdueResult {
  overdue: InvoiceRow[];
  pastDue: string[];
  suspensionProposed: string[];
}

interface InvoiceDbRow {
  id: string;
  subscription_id: string;
  invoice_code: string;
  period_start: string;
  period_end: string;
  kind: InvoiceRow['kind'];
  status: InvoiceStatus;
  subtotal_vnd: string;
  vat_vnd: string;
  total_vnd: string;
  buyer_snapshot: { code: string; name: string };
  einvoice_provider: string | null;
  einvoice_template_code: string | null;
  einvoice_series: string | null;
  einvoice_number: string | null;
  tax_authority_code: string | null;
  lookup_code: string | null;
  provider_ref: string | null;
  issued_at: Date | null;
  due_at: string | null;
  issue_attempts: number;
  next_attempt_at: Date | null;
  issue_error: string | null;
  version: string;
}

interface LineDbRow {
  id: string;
  invoice_id: string;
  line_no: number;
  line_kind: string;
  description: string;
  amount_vnd: string;
  vat_category: VatCategory;
  vat_vnd: string;
  meter: string | null;
  quantity: string | null;
  unit_price: string | null;
}

interface SubscriptionDbRow {
  id: string;
  plan_version_id: string;
  cycle: PlanBillingCycle;
  billing_anchor: string;
  status: string;
  trial_ends_at: Date | null;
  payment_terms: { due_days?: number };
  past_due_since: Date | null;
  current_period_end: string;
  cancel_at_period_end: boolean;
  version: string;
}

const SUBSCRIPTION_COLUMNS = `id, plan_version_id, cycle, billing_anchor::text, status, trial_ends_at, payment_terms, past_due_since, current_period_end::text, cancel_at_period_end, version::text`;
/** The subscriptions that are billed: the live ones (Active, PastDue), and the ones that ended at the end of their period or of their term, whose last period is still to be billed. */
const BILLABLE_SQL = "(status in ('Active', 'PastDue') or (status = 'Cancelled' and cancel_at_period_end) or status = 'Expired')";

const INVOICE_COLUMNS = `id, subscription_id, invoice_code, period_start::text, period_end::text, kind, status, subtotal_vnd::text, vat_vnd::text, total_vnd::text, buyer_snapshot, einvoice_provider, einvoice_template_code,
  einvoice_series, einvoice_number, tax_authority_code, lookup_code, provider_ref, issued_at, due_at::text, issue_attempts, next_attempt_at, issue_error, version::text`;
const LINE_COLUMNS = 'id, invoice_id, line_no, line_kind, description, amount_vnd::text, vat_category, vat_vnd::text, meter, trim_scale(quantity)::text as quantity, trim_scale(unit_price)::text as unit_price';

const invoiceOf = (row: InvoiceDbRow): InvoiceRow => ({
  id: row.id,
  subscriptionId: row.subscription_id,
  invoiceCode: row.invoice_code,
  periodStart: row.period_start,
  periodEnd: row.period_end,
  kind: row.kind,
  status: row.status,
  subtotalVnd: row.subtotal_vnd,
  vatVnd: row.vat_vnd,
  totalVnd: row.total_vnd,
  buyer: row.buyer_snapshot,
  provider: row.einvoice_provider,
  templateCode: row.einvoice_template_code,
  series: row.einvoice_series,
  number: row.einvoice_number,
  taxAuthorityCode: row.tax_authority_code,
  lookupCode: row.lookup_code,
  providerRef: row.provider_ref,
  issuedAt: row.issued_at,
  dueAt: row.due_at,
  issueAttempts: row.issue_attempts,
  nextAttemptAt: row.next_attempt_at,
  issueError: row.issue_error,
  version: Number(row.version),
});

const lineOf = (row: LineDbRow): InvoiceLineRow => ({
  id: row.id,
  invoiceId: row.invoice_id,
  lineNo: row.line_no,
  kind: row.line_kind,
  description: row.description,
  amountVnd: row.amount_vnd,
  vatCategory: row.vat_category,
  vatVnd: row.vat_vnd,
  meter: row.meter,
  quantity: row.quantity,
  unitPriceVnd: row.unit_price,
});

const isLive = (subscription: Pick<SubscriptionDbRow, 'status'>): boolean => subscription.status === 'Active' || subscription.status === 'PastDue';

/** Days to pay when the subscription names none. */
export const DEFAULT_DUE_DAYS = 15;
export const INVOICE_DRAFTED_EVENT = 'sas.invoice.drafted.v1';
export const INVOICE_ISSUED_EVENT = 'sas.invoice.issued.v1';
export const INVOICE_ISSUE_FAILED_EVENT = 'sas.invoice.issue_failed.v1';
export const INVOICE_OVERDUE_EVENT = 'sas.invoice.overdue.v1';
export const SUBSCRIPTION_PAST_DUE_EVENT = 'sas.subscription.past_due.v1';
export const SUSPENSION_PROPOSED_EVENT = 'sas.billing.suspension_proposed.v1';
/** The gauge of the invoices that could not be issued (IssueFailed), per tenant: the alert of the story. */
export const EINVOICE_FAILED_GAUGE = 'einvoice_issue_failed_invoices';
const RESOURCE_TYPE = 'invoice';

/**
 * The billing run and the e-invoice of a tenant (ST-SAS-011, SAS.md 3.7): the invoice of a subscription for a period, one original however many times the run is made, its lines
 * (the plan, the use beyond the limits, the proration of a change of plan) with the VAT of each line rounded half up, and its issue through the port of the provider with the retries
 * of the day. The plan catalogue is a control-plane table, so every method runs in a transaction of the control role acting as the tenant. Money is whole VND.
 */
export class BillingStore {
  async buyerOf(tx: TenantTx): Promise<{ code: string; name: string }> {
    const [tenant] = await tx.query<{ code: string; name: string }>("select code, name from machvon.tenant where id = nullif(current_setting('app.tenant_id', true), '')::uuid");
    if (tenant === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return tenant;
  }

  async find(tx: TenantTx, invoiceId: string, forUpdate = false): Promise<InvoiceRow | undefined> {
    const rows = await tx.query<InvoiceDbRow>(`select ${INVOICE_COLUMNS} from machvon.invoice where id = $1::uuid${forUpdate ? ' for update' : ''}`, [invoiceId]);
    return rows[0] === undefined ? undefined : invoiceOf(rows[0]);
  }

  /** The invoices, the latest period first; `after` is the last one of the page before (keyset on the period and the id). */
  async list(tx: TenantTx, filter: { subscriptionId?: string | undefined; limit: number; after?: { periodStart: string; id: string } | undefined }): Promise<InvoiceRow[]> {
    const rows = await tx.query<InvoiceDbRow>(
      `select ${INVOICE_COLUMNS} from machvon.invoice where ($1::uuid is null or subscription_id = $1::uuid) and ($3::date is null or (period_start, id) < ($3::date, $4::uuid)) order by period_start desc, id desc limit $2::int`,
      [filter.subscriptionId ?? null, filter.limit, filter.after?.periodStart ?? null, filter.after?.id ?? null],
    );
    return rows.map(invoiceOf);
  }

  async linesOf(tx: TenantTx, invoiceIds: readonly string[]): Promise<InvoiceLineRow[]> {
    if (invoiceIds.length === 0) return [];
    const rows = await tx.query<LineDbRow>(`select ${LINE_COLUMNS} from machvon.invoice_line where invoice_id = any($1::uuid[]) order by invoice_id, line_no`, [invoiceIds]);
    return rows.map(lineOf);
  }

  async listLines(tx: TenantTx, filter: { limit: number; after?: string | undefined }): Promise<InvoiceLineRow[]> {
    const rows = await tx.query<LineDbRow>(`select ${LINE_COLUMNS} from machvon.invoice_line where ($1::uuid is null or id > $1::uuid) order by id limit $2::int`, [filter.after ?? null, filter.limit]);
    return rows.map(lineOf);
  }

  async findLine(tx: TenantTx, id: string): Promise<InvoiceLineRow | undefined> {
    const rows = await tx.query<LineDbRow>(`select ${LINE_COLUMNS} from machvon.invoice_line where id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : lineOf(rows[0]);
  }

  /**
   * Bills the subscriptions of the tenant whose billing period is exactly `period`: for each, the original invoice of the period as a Draft, or the one the period already has. A period that
   * has not begun, or that is longer than a year, is BILLING_PERIOD_INVALID.
   */
  async runPeriod(tx: TenantTx, effects: ApprovalEffects, period: BillingPeriod, today: string): Promise<BillingRunResult> {
    if (!isBillingPeriod(period, today)) throw new DomainError('BILLING_PERIOD_INVALID', 422, 'period_start');
    const result: BillingRunResult = { created: [], existing: [], nothingToBill: 0 };
    const due = await this.billableSubscriptions(tx);
    for (const subscription of due) {
      const own = billingPeriodAt(subscription.billing_anchor, subscription.cycle, period.start);
      if (own === undefined || own.start !== period.start || own.end !== period.end) continue;
      // A subscription that ended is billed up to the end of its last period, not beyond.
      if (!isLive(subscription) && period.end > subscription.current_period_end) continue;
      await this.billOne(tx, effects, subscription.id, period, result);
    }
    return result;
  }

  /** The daily pass: for each live subscription the period that closed last; for one that ended, its last period once it has closed. */
  async runClosedPeriods(tx: TenantTx, effects: ApprovalEffects, today: string): Promise<BillingRunResult> {
    const result: BillingRunResult = { created: [], existing: [], nothingToBill: 0 };
    for (const subscription of await this.billableSubscriptions(tx)) {
      if (!isLive(subscription)) {
        // The last period of a subscription that ended is found from the end it was left with, so that a pass made days late (or after the cycle job cancelled it) still bills it.
        const last = billingPeriodAt(subscription.billing_anchor, subscription.cycle, subscription.current_period_end);
        if (last !== undefined && last.end < today) await this.billOne(tx, effects, subscription.id, last, result);
        continue;
      }
      const current = billingPeriodAt(subscription.billing_anchor, subscription.cycle, today);
      if (current === undefined || current.start === subscription.billing_anchor) continue;
      const closed = billingPeriodAt(subscription.billing_anchor, subscription.cycle, addDays(current.start, -1));
      if (closed !== undefined) await this.billOne(tx, effects, subscription.id, closed, result);
    }
    return result;
  }

  private async billableSubscriptions(tx: TenantTx): Promise<SubscriptionDbRow[]> {
    return tx.query<SubscriptionDbRow>(`select ${SUBSCRIPTION_COLUMNS} from machvon.subscription where ${BILLABLE_SQL} order by id`);
  }

  private async billOne(tx: TenantTx, effects: ApprovalEffects, subscriptionId: string, period: BillingPeriod, result: BillingRunResult): Promise<void> {
    // The row of the subscription is the lock of its billing: two runs for one period do not both make the invoice.
    const [subscription] = await tx.query<SubscriptionDbRow>(`select ${SUBSCRIPTION_COLUMNS} from machvon.subscription where id = $1::uuid and ${BILLABLE_SQL} for update`, [subscriptionId]);
    if (subscription === undefined) return;
    if (!isLive(subscription) && period.end > subscription.current_period_end) return;
    const [held] = await tx.query<InvoiceDbRow>(`select ${INVOICE_COLUMNS} from machvon.invoice where subscription_id = $1::uuid and kind = 'ORIGINAL' and period_start = $2::date and period_end = $3::date and status <> 'Discarded'`, [subscriptionId, period.start, period.end]);
    if (held !== undefined) {
      result.existing.push(invoiceOf(held));
      return;
    }
    // The days of a trial are not sold: a period that ended inside it is not billed, and one that the trial ended in is billed from the day the trial ended (the plan for those days, the use from that day).
    const trialEnd = subscription.trial_ends_at === null ? undefined : vietnamDateOf(subscription.trial_ends_at);
    const paidFrom = trialEnd !== undefined && trialEnd > period.start ? trialEnd : period.start;
    if (paidFrom > period.end) {
      result.nothingToBill += 1;
      return;
    }
    const lines = await this.linesFor(tx, subscription, period, paidFrom, trialEnd);
    if (lines.drafts.length === 0) {
      result.nothingToBill += 1;
      return;
    }
    const priced: PricedInvoiceLine[] = lines.drafts.map(priceLine);
    const totals = invoiceTotals(priced);
    const buyer = await this.buyerOf(tx);
    const id = await this.insertDraft(tx, subscription, period, totals, buyer);
    for (const [index, line] of priced.entries()) {
      await tx.query(
        `insert into machvon.invoice_line (tenant_id, id, invoice_id, line_no, line_kind, description, amount_vnd, vat_category, vat_vnd, meter, quantity, unit_price)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::int, $3, $4, $5::numeric, $6, $7::numeric, $8, $9::numeric, $10::numeric)`,
        [id, index + 1, line.kind, line.description, line.amountVnd, line.vatCategory, line.vatVnd, line.meter ?? null, line.quantity ?? null, line.unitPriceVnd ?? null],
      );
    }
    if (lines.planChangeIds.length > 0) await tx.query('update machvon.subscription_plan_change set invoiced_invoice_id = $2::uuid where id = any($1::uuid[])', [lines.planChangeIds, id]);
    const invoice = (await this.find(tx, id)) as InvoiceRow;
    await effects.audit({ action: 'invoice.drafted', resourceType: RESOURCE_TYPE, resourceId: id, diff: { subscription_id: subscription.id, period_start: period.start, period_end: period.end, total_vnd: invoice.totalVnd, lines: priced.length } });
    await effects.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: id,
      aggregateVersion: invoice.version,
      eventKey: `invoice:${id}:drafted`,
      type: INVOICE_DRAFTED_EVENT,
      schemaVersion: 1,
      payload: { invoice_id: id, subscription_id: subscription.id, period_start: period.start, period_end: period.end, total_vnd: invoice.totalVnd },
    });
    result.created.push(invoice);
  }

  private async insertDraft(tx: TenantTx, subscription: SubscriptionDbRow, period: BillingPeriod, totals: { subtotalVnd: string; vatVnd: string; totalVnd: string }, buyer: { code: string; name: string }): Promise<string> {
    const dueDays = subscription.payment_terms.due_days ?? DEFAULT_DUE_DAYS;
    // The code of a period is kept unique for ever: a draft that was discarded keeps its code, and the invoice that takes its place has the next revision.
    const [earlier] = await tx.query<{ n: string }>("select count(*)::text as n from machvon.invoice where subscription_id = $1::uuid and kind = 'ORIGINAL' and period_start = $2::date and period_end = $3::date", [subscription.id, period.start, period.end]);
    const code = invoiceCodeOf(subscription.id, period.start, Number(earlier?.n ?? 0) + 1);
    const [row] = await tx.query<{ id: string }>(
      `insert into machvon.invoice (tenant_id, id, subscription_id, invoice_code, period_start, period_end, kind, status, subtotal_vnd, vat_vnd, total_vnd, buyer_snapshot, due_at)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2, $3::date, $4::date, 'ORIGINAL', 'Draft', $5::numeric, $6::numeric, $7::numeric, $8::jsonb, $9::date) returning id`,
      [subscription.id, code, period.start, period.end, totals.subtotalVnd, totals.vatVnd, totals.totalVnd, JSON.stringify(buyer), addDays(period.end, dueDays)],
    );
    return (row as { id: string }).id;
  }

  /** The lines of the period: the plan, each metered feature used beyond its limit in the period, and the proration of the changes of plan that were applied and not yet charged. */
  /**
   * The proration that was worked out from the day of the change to the end of the period it was made in, less the days of a trial that were still to run: the free days are not charged for, so the share
   * of the days after the trial ended is what is owed (all of it for a change made after the trial, nothing for one whose period ended inside the trial).
   */
  private paidShareOfProration(subscription: SubscriptionDbRow, prorationVnd: string, effectiveDay: string, trialEnd: string | undefined): string {
    if (trialEnd === undefined || effectiveDay >= trialEnd) return prorationVnd;
    const own = billingPeriodAt(subscription.billing_anchor, subscription.cycle, effectiveDay);
    if (own === undefined || trialEnd > own.end) return '0';
    return priceForDays(prorationVnd, daysInPeriod({ start: trialEnd, end: own.end }), daysInPeriod({ start: effectiveDay, end: own.end }));
  }

  private async linesFor(tx: TenantTx, subscription: SubscriptionDbRow, period: BillingPeriod, paidFrom: string, trialEnd: string | undefined): Promise<{ drafts: InvoiceLineDraft[]; planChangeIds: string[] }> {
    // The plan the period was sold on is the one the subscription was on when the period began: a change that took effect after that day (inside the period, or after it) is the proration of the period, not its price. An
    // immediate change on the first day is the same (its proration is the whole difference of the period), while one for the next cycle that took effect on that day is what the period began on.
    const [later] = await tx.query<{ from_plan_version_id: string }>(
      "select from_plan_version_id from machvon.subscription_plan_change where subscription_id = $1::uuid and applied_at is not null and ((effective_at at time zone 'Asia/Ho_Chi_Minh')::date > $2::date or (effective = 'NOW' and (effective_at at time zone 'Asia/Ho_Chi_Minh')::date = $2::date)) order by effective_at, requested_at, id limit 1",
      [subscription.id, period.start],
    );
    const planId = later?.from_plan_version_id ?? subscription.plan_version_id;
    const [plan] = await tx.query<{ plan_code: string; name: string; base_price_vnd: string; vat_category: VatCategory }>('select plan_code, name, base_price_vnd::text, vat_category from machvon.product_plan_version where id = $1::uuid', [planId]);
    if (plan === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const drafts: InvoiceLineDraft[] = [];
    const planAmount = paidFrom === period.start ? plan.base_price_vnd : priceForDays(plan.base_price_vnd, daysInPeriod({ start: paidFrom, end: period.end }), daysInPeriod(period));
    if (BigInt(planAmount) > 0n) drafts.push({ kind: 'SUBSCRIPTION', description: `${plan.name} (${plan.plan_code}), ${paidFrom} - ${period.end}`, amountVnd: planAmount, vatCategory: plan.vat_category });
    const features = await tx.query<{ feature_code: string; meter: string; limit_value: string; overage_price_vnd: string | null }>(
      "select feature_code, meter, limit_value::text, overage_price_vnd::text from machvon.plan_feature where plan_version_id = $1::uuid and limit_kind = 'METERED' and meter is not null and limit_value is not null and overage_price_vnd is not null order by feature_code",
      [planId],
    );
    for (const feature of features) {
      const [used] = await tx.query<{ used: string }>(
        "select coalesce(sum(quantity), 0)::text as used from machvon.usage_meter_event where meter = $1 and (occurred_at at time zone 'Asia/Ho_Chi_Minh')::date between $2::date and $3::date",
        [feature.meter, paidFrom, period.end],
      );
      const metered: MeteredFeature = { featureCode: feature.feature_code, meter: feature.meter, limit: feature.limit_value, overagePriceVnd: feature.overage_price_vnd };
      const line = usageLine(metered, (used as { used: string }).used, plan.vat_category);
      if (line !== undefined) drafts.push(line);
    }
    // A change of plan that took effect by the end of the period, with a proration to pay that nobody charged yet.
    const changes = await tx.query<{ id: string; proration_vnd: string; to_name: string; to_vat: VatCategory; effective_at: Date }>(
      `select c.id, c.proration_vnd::text, p.name as to_name, p.vat_category as to_vat, c.effective_at from machvon.subscription_plan_change c
         join machvon.product_plan_version p on p.id = c.to_plan_version_id
        where c.subscription_id = $1::uuid and c.applied_at is not null and (c.invoiced_invoice_id is null or c.invoiced_invoice_id in (select id from machvon.invoice where status = 'Discarded')) and c.proration_vnd > 0 and (c.effective_at at time zone 'Asia/Ho_Chi_Minh')::date <= $2::date order by c.requested_at, c.id`,
      [subscription.id, period.end],
    );
    const charged: string[] = [];
    for (const change of changes) {
      const amount = this.paidShareOfProration(subscription, change.proration_vnd, vietnamDateOf(change.effective_at), trialEnd);
      if (BigInt(amount) <= 0n) continue;
      charged.push(change.id);
      drafts.push({ kind: 'ADJUSTMENT', description: `Proration of the change to ${change.to_name} from ${vietnamDateOf(change.effective_at)}`, amountVnd: amount, vatCategory: change.to_vat });
    }
    return { drafts, planChangeIds: charged };
  }

  /**
   * Sends a Draft (or an IssueFailed invoice, again) to the provider: PendingIssue, then the first attempt at once. Any other status is EINVOICE_STATE_INVALID, so a second command on an invoice that
   * went out finds it Issued (or on its way) and is refused. `expectedVersion` is the ETag of the command.
   */
  async issue(tx: TenantTx, effects: ApprovalEffects, provider: EInvoiceProviderPort, invoiceId: string, expectedVersion: number | undefined, now: Date): Promise<{ invoice: InvoiceRow; outcome: IssueOutcome }> {
    const invoice = await this.find(tx, invoiceId, true);
    if (invoice === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (invoice.status !== 'Draft' && invoice.status !== 'IssueFailed') throw new DomainError('EINVOICE_STATE_INVALID', 409, 'status', { extensions: { status: invoice.status } });
    if (expectedVersion !== undefined && expectedVersion !== invoice.version) throw versionConflict(invoice.version);
    await tx.query("update machvon.invoice set status = 'PendingIssue', issue_attempts = 0, issue_started_at = $2::timestamptz, next_attempt_at = null, issue_error = null, version = version + 1 where id = $1::uuid", [invoiceId, now.toISOString()]);
    return this.attempt(tx, effects, provider, (await this.find(tx, invoiceId)) as InvoiceRow, now);
  }

  /** One attempt at the provider for an invoice that is PendingIssue; the answer, a failure that will be tried again, or the end of the tries, is recorded. */
  async attempt(tx: TenantTx, effects: ApprovalEffects, provider: EInvoiceProviderPort, invoice: InvoiceRow, now: Date): Promise<{ invoice: InvoiceRow; outcome: IssueOutcome }> {
    const lines = await this.linesOf(tx, [invoice.id]);
    const request: EInvoiceIssueRequest = {
      referenceKey: invoice.id,
      invoiceCode: invoice.invoiceCode,
      periodStart: invoice.periodStart,
      periodEnd: invoice.periodEnd,
      issueDate: vietnamDateOf(now),
      buyer: invoice.buyer,
      lines: lines.map((line) => ({ kind: line.kind, description: line.description, amountVnd: line.amountVnd, vatCategory: line.vatCategory, vatVnd: line.vatVnd })),
      subtotalVnd: invoice.subtotalVnd,
      vatVnd: invoice.vatVnd,
      totalVnd: invoice.totalVnd,
    };
    const attempts = invoice.issueAttempts + 1;
    // The tries are over after 24 hours from the first: a worker that comes back later does not ask the provider (an answer then would issue an invoice outside the window that was promised); the invoice is IssueFailed and a person issues it.
    const [first] = await tx.query<{ issue_started_at: Date | null }>('select issue_started_at from machvon.invoice where id = $1::uuid', [invoice.id]);
    if (invoice.issueAttempts >= 1 && first?.issue_started_at != null && now.getTime() - first.issue_started_at.getTime() > ISSUE_WINDOW_MS) return this.giveUp(tx, effects, invoice, invoice.issueAttempts);
    try {
      const issued = await provider.issue(request);
      await tx.query(
        `update machvon.invoice set status = 'Issued', einvoice_provider = $2, einvoice_template_code = $3, einvoice_series = $4, einvoice_number = $5, tax_authority_code = $6, lookup_code = $7, provider_ref = $8,
           issued_at = $9::timestamptz, issue_attempts = $10, next_attempt_at = null, issue_error = null, version = version + 1 where id = $1::uuid`,
        [invoice.id, provider.name, issued.templateCode, issued.series, issued.number, issued.taxAuthorityCode, issued.lookupCode, issued.providerRef, now.toISOString(), attempts],
      );
      const done = (await this.find(tx, invoice.id)) as InvoiceRow;
      await effects.audit({ action: 'invoice.issued', resourceType: RESOURCE_TYPE, resourceId: invoice.id, diff: { number: issued.number, series: issued.series, template: issued.templateCode, attempts } });
      await effects.emit({
        aggregateType: RESOURCE_TYPE,
        aggregateId: invoice.id,
        aggregateVersion: done.version,
        eventKey: `invoice:${invoice.id}:issued`,
        type: INVOICE_ISSUED_EVENT,
        schemaVersion: 1,
        payload: { invoice_id: invoice.id, subscription_id: invoice.subscriptionId, einvoice_number: issued.number, series: issued.series, total_vnd: invoice.totalVnd },
      });
      return { invoice: done, outcome: 'ISSUED' };
    } catch (error) {
      if (!(error instanceof EInvoiceProviderUnavailable)) throw error;
      const started = (await tx.query<{ issue_started_at: Date }>('select issue_started_at from machvon.invoice where id = $1::uuid', [invoice.id]))[0]?.issue_started_at ?? now;
      const next = nextIssueAttempt(attempts, started, now);
      if (next === null) return this.giveUp(tx, effects, invoice, attempts);
      await tx.query("update machvon.invoice set issue_attempts = $2, next_attempt_at = $3::timestamptz, issue_error = 'EINVOICE_PROVIDER_UNAVAILABLE', version = version + 1 where id = $1::uuid", [invoice.id, attempts, next.toISOString()]);
      return { invoice: (await this.find(tx, invoice.id)) as InvoiceRow, outcome: 'PENDING' };
    }
  }

  /** The end of the tries: the invoice is IssueFailed, once, and says so. */
  private async giveUp(tx: TenantTx, effects: ApprovalEffects, invoice: InvoiceRow, attempts: number): Promise<{ invoice: InvoiceRow; outcome: IssueOutcome }> {
    await tx.query("update machvon.invoice set status = 'IssueFailed', issue_attempts = $2, next_attempt_at = null, issue_error = 'EINVOICE_PROVIDER_UNAVAILABLE', version = version + 1 where id = $1::uuid", [invoice.id, attempts]);
    const failed = (await this.find(tx, invoice.id)) as InvoiceRow;
    await effects.audit({ action: 'invoice.issue_failed', resourceType: RESOURCE_TYPE, resourceId: invoice.id, diff: { attempts, max_attempts: ISSUE_MAX_ATTEMPTS } });
    await effects.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: invoice.id,
      aggregateVersion: failed.version,
      eventKey: `invoice:${invoice.id}:issue_failed:${failed.version}`,
      type: INVOICE_ISSUE_FAILED_EVENT,
      schemaVersion: 1,
      payload: { invoice_id: invoice.id, subscription_id: invoice.subscriptionId, attempts },
    });
    return { invoice: failed, outcome: 'FAILED' };
  }

  /** The invoices waiting for another attempt whose time has come, the oldest first. */
  async retryDue(tx: TenantTx, effects: ApprovalEffects, provider: EInvoiceProviderPort, now: Date, limit = 50): Promise<Array<{ invoice: InvoiceRow; outcome: IssueOutcome }>> {
    const due = await tx.query<InvoiceDbRow>(`select ${INVOICE_COLUMNS} from machvon.invoice where status = 'PendingIssue' and next_attempt_at <= $1::timestamptz order by next_attempt_at, id limit $2::int for update skip locked`, [now.toISOString(), limit]);
    const outcomes: Array<{ invoice: InvoiceRow; outcome: IssueOutcome }> = [];
    for (const row of due) outcomes.push(await this.attempt(tx, effects, provider, invoiceOf(row), now));
    return outcomes;
  }

  /** The live subscription of the tenant as billing sees it: its status, since when it is past due and whether a suspension was proposed. */
  async subscriptionState(tx: TenantTx): Promise<{ status: string; pastDueSince: Date | null; suspensionProposedAt: Date | null } | undefined> {
    const [row] = await tx.query<{ status: string; past_due_since: Date | null; suspension_proposed_at: Date | null }>(
      "select status, past_due_since, suspension_proposed_at from machvon.subscription where status in ('Trialing', 'Active', 'PastDue', 'Paused') order by id limit 1",
    );
    return row === undefined ? undefined : { status: row.status, pastDueSince: row.past_due_since, suspensionProposedAt: row.suspension_proposed_at };
  }

  /** How many invoices of the tenant are IssueFailed after the pass (the gauge of the alert). */
  async failedCount(tx: TenantTx): Promise<number> {
    const [row] = await tx.query<{ n: string }>("select count(*)::text as n from machvon.invoice where status = 'IssueFailed'");
    return Number(row?.n ?? 0);
  }

  /**
   * The clock: an invoice that was issued and whose due day is past is Overdue, and the subscription it belongs to is PastDue from then (the day is kept). Nothing else changes: the tenant and the
   * license stay as they are (BR-SAS-04); after 30 days past due the subscription only records that a suspension could be proposed, and says so once; a System Admin decides.
   */
  async sweepOverdue(tx: TenantTx, effects: ApprovalEffects, today: string, now: Date): Promise<BillingOverdueResult> {
    const result: BillingOverdueResult = { overdue: [], pastDue: [], suspensionProposed: [] };
    const late = await tx.query<InvoiceDbRow>(`select ${INVOICE_COLUMNS} from machvon.invoice where status in ('Issued', 'Sent', 'PartiallyPaid') and due_at < $1::date order by due_at, id for update`, [today]);
    for (const row of late) {
      await tx.query("update machvon.invoice set status = 'Overdue', version = version + 1 where id = $1::uuid", [row.id]);
      const invoice = (await this.find(tx, row.id)) as InvoiceRow;
      result.overdue.push(invoice);
      await effects.audit({ action: 'invoice.overdue', resourceType: RESOURCE_TYPE, resourceId: row.id, diff: { due_at: row.due_at, total_vnd: row.total_vnd } });
      await effects.emit({ aggregateType: RESOURCE_TYPE, aggregateId: row.id, aggregateVersion: invoice.version, eventKey: `invoice:${row.id}:overdue`, type: INVOICE_OVERDUE_EVENT, schemaVersion: 1, payload: { invoice_id: row.id, subscription_id: row.subscription_id, due_at: row.due_at, total_vnd: row.total_vnd } });
      const moved = await tx.query<{ id: string; version: string }>("update machvon.subscription set status = 'PastDue', past_due_since = coalesce(past_due_since, $2::timestamptz), version = version + 1 where id = $1::uuid and status = 'Active' returning id, version::text", [row.subscription_id, now.toISOString()]);
      if (moved[0] !== undefined) {
        result.pastDue.push(moved[0].id);
        await effects.audit({ action: 'subscription.past_due', resourceType: 'subscription', resourceId: moved[0].id, diff: { invoice_id: row.id, tenant_status_unchanged: true } });
        await effects.emit({ aggregateType: 'subscription', aggregateId: moved[0].id, aggregateVersion: Number(moved[0].version), eventKey: `subscription:${moved[0].id}:past_due:${moved[0].version}`, type: SUBSCRIPTION_PAST_DUE_EVENT, schemaVersion: 1, payload: { subscription_id: moved[0].id, invoice_id: row.id } });
      }
    }
    const pastDue = await tx.query<{ id: string; past_due_since: Date; version: string }>("select id, past_due_since, version::text from machvon.subscription where status = 'PastDue' and past_due_since is not null and suspension_proposed_at is null for update");
    for (const subscription of pastDue) {
      if (!suspensionProposed(subscription.past_due_since, now)) continue;
      await tx.query('update machvon.subscription set suspension_proposed_at = $2::timestamptz, version = version + 1 where id = $1::uuid', [subscription.id, now.toISOString()]);
      result.suspensionProposed.push(subscription.id);
      await effects.audit({ action: 'billing.suspension_proposed', resourceType: 'subscription', resourceId: subscription.id, diff: { past_due_since: subscription.past_due_since.toISOString(), decided_by: 'SYSTEM_ADMIN_ONLY' } });
      await effects.emit({ aggregateType: 'subscription', aggregateId: subscription.id, aggregateVersion: Number(subscription.version) + 1, eventKey: `subscription:${subscription.id}:suspension_proposed`, type: SUSPENSION_PROPOSED_EVENT, schemaVersion: 1, payload: { subscription_id: subscription.id, past_due_since: subscription.past_due_since.toISOString() } });
    }
    return result;
  }
}
