import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import type { ApprovalEffects } from '../src/approval-store';
import { BillingPaymentStore } from '../src/billing-payment-store';
import type { PaymentRow } from '../src/billing-payment-store';
import { BillingStore } from '../src/billing-store';
import type { InvoiceRow } from '../src/billing-store';
import { DomainError } from '@machvon/kernel';
import { actingAsTenant } from '../src/acting-as';
import { ControlDatabase, PLATFORM_TENANT_ID } from '../src/control-database';
import { MockEInvoiceProvider } from '../src/einvoice-provider';
import { SubscriptionStore } from '../src/subscription-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, memberId } from './support/authz-fixtures';

const billing = new BillingStore();
const payments = new BillingPaymentStore();
const subscriptions = new SubscriptionStore();
const OPERATOR = '00000000-0000-4000-8000-0000000000a1';
const WORKER = '00000000-0000-4000-8000-0000000000e9';
const TENANT_C = '00000000-0000-4000-8000-00000000000c';
const PLACEMENT = '00000000-0000-4000-8000-0000000000b1';
const NOW = new Date('2026-03-05T03:00:00Z');
const TODAY = '2026-03-05';
const FEBRUARY = { start: '2026-02-01', end: '2026-02-28' };

interface Recorded {
  audits: Array<{ action: string; resourceId: string }>;
  events: Array<{ type: string; eventKey: string }>;
}

function recorder(): ApprovalEffects & Recorded {
  const audits: Recorded['audits'] = [];
  const events: Recorded['events'] = [];
  return {
    actor: memberId(1),
    audits,
    events,
    audit: async (entry) => void audits.push({ action: entry.action, resourceId: entry.resourceId }),
    emit: async (event) => void events.push({ type: event.type, eventKey: event.eventKey }),
  };
}

describe('the payments that come in and their reconciliation (ST-SAS-012, SAS.md 3.7 item 3)', () => {
  const harness = new AuthzHarness();
  let control: ControlDatabase;
  let controlPool: Pool;
  let counter = 0;
  let txn = 0;
  const inTenant = <T>(tenant: string, work: (tx: TenantTx) => Promise<T>): Promise<T> => control.withTenantOf(tenant, work);
  const asPlatform = <T>(work: (tx: TenantTx) => Promise<T>): Promise<T> => control.withTenantOf(PLATFORM_TENANT_ID, work);

  const admin = async <T extends object = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> => {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      return (await client.query(text, params)).rows as T[];
    } finally {
      await client.end();
    }
  };
  const sqlError = async (text: string, params: unknown[] = []): Promise<{ code: string | undefined; message: string } | undefined> => {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query(text, params);
      return undefined;
    } catch (error) {
      return { code: (error as { code?: string }).code, message: (error as Error).message };
    } finally {
      await client.end();
    }
  };

  async function plan(price: string): Promise<string> {
    counter += 1;
    const id = randomUUID();
    await admin(
      `insert into machvon.product_plan_version (id, plan_code, revision, name, status, billing_cycles, base_price_vnd, vat_category, legal_terms_ref)
       values ($1, $2, 1, $3, 'Draft', $4::text[], $5::numeric, 'NOT_SUBJECT', 'TERMS-1')`,
      [id, `pay-${counter}`, `Plan ${counter}`, ['ANNUAL', 'MONTHLY'], price],
    );
    await admin("insert into machvon.plan_feature (id, plan_version_id, feature_code, limit_kind, limit_value, grace_behavior, expired_behavior) values (gen_random_uuid(), $1, 'member.seats', 'QUOTA', 50, 'READ_ONLY', 'DENY')", [id]);
    await admin("update machvon.product_plan_version set status = 'Published', published_by = $2, published_at = now() where id = $1", [id, OPERATOR]);
    return id;
  }

  /** An issued invoice of the tenant for February with the given total, on a subscription of its own (the older one of the tenant is cancelled first). */
  async function issuedInvoice(tenant: string, price = '1000000'): Promise<InvoiceRow> {
    await admin("update machvon.subscription set status = 'Cancelled' where tenant_id = $1 and status <> 'Cancelled'", [tenant]);
    const created = await inTenant(tenant, async (tx) =>
      subscriptions.create(tx, { planVersionId: await plan(price), cycle: 'MONTHLY', billingAnchor: '2026-01-01', trialDays: 0, paymentTerms: { dueDays: 15, method: 'BANK_TRANSFER' }, now: new Date('2026-01-01T03:00:00Z') }),
    );
    expect(created.status).toBe('Active');
    const made = (await inTenant(tenant, (tx) => billing.runPeriod(tx, recorder(), FEBRUARY, TODAY))).created[0] as InvoiceRow;
    return (await inTenant(tenant, (tx) => billing.issue(tx, recorder(), new MockEInvoiceProvider(), made.id, made.version, NOW))).invoice;
  }

  /** A payment of the platform tenant for the amount, with the note. */
  async function arrived(amountVnd: string, memo: string, method: 'BANK_TRANSFER' | 'GATEWAY' = 'BANK_TRANSFER'): Promise<PaymentRow> {
    txn += 1;
    return (await asPlatform((tx) => payments.record(tx, { provider: 'mock-bank', txnRef: `TXN-${txn}-${randomUUID()}`, amountVnd, method, receivedAt: new Date('2026-03-04T02:00:00Z'), memo, inboxEventId: null }))).payment as PaymentRow;
  }

  const matchBy = (payment: PaymentRow, invoice: InvoiceRow, effects = recorder()) =>
    asPlatform((tx) => payments.match(tx, effects, { platformTenantId: PLATFORM_TENANT_ID, paymentId: payment.id, invoiceId: invoice.id, matchedBy: OPERATOR, reason: 'The payer wrote no code.', now: NOW }));
  const passOf = (effects = recorder()) => payments.pass(asPlatform, () => effects, { platformTenantId: PLATFORM_TENANT_ID, workerMembershipId: WORKER, now: NOW });
  const count = async (provider: string, txnRef: string): Promise<number> => Number((await admin<{ n: string }>('select count(*)::text as n from machvon.billing_payment where provider = $1 and provider_txn_ref = $2', [provider, txnRef]))[0]?.n);
  const invoiceOf = (tenant: string, id: string) => inTenant(tenant, (tx) => billing.find(tx, id)) as Promise<InvoiceRow>;

  beforeAll(async () => {
    await harness.start();
    controlPool = new Pool({ connectionString: harness.database.urlFor('machvon_control'), max: 4 });
    controlPool.on('error', () => undefined);
    control = new ControlDatabase(controlPool);
    await admin("insert into machvon.placement (id, kind, region, db_cluster_ref, kms_key_ref, status) values ($1, 'POOL', 'vn-north', 'cluster-1', 'kms-1', 'Active') on conflict do nothing", [PLACEMENT]);
    for (const [tenant, code] of [[TENANT_A, 'tenant-a'], [TENANT_B, 'tenant-b'], [TENANT_C, 'tenant-c'], [PLATFORM_TENANT_ID, 'platform']] as const) {
      await admin("insert into machvon.tenant (id, code, name, status, placement_id, region) values ($1, $2, $2, 'Active', $3, 'vn-north') on conflict (id) do nothing", [tenant, code, PLACEMENT]);
    }
    for (const tenant of [TENANT_A, TENANT_B, TENANT_C]) await harness.seedUnits(tenant, [{ n: 1, path: '/u1/' }]);
  }, 180_000);

  afterAll(async () => {
    await controlPool?.end();
    await harness.stop();
  }, 60_000);

  // The payments that wait are the platform's, whatever a test before left behind: each test starts from none.
  beforeEach(async () => {
    await admin("alter table machvon.billing_payment disable trigger billing_payment_guard");
    await admin('delete from machvon.billing_payment where tenant_id = $1', [PLATFORM_TENANT_ID]);
    await admin("alter table machvon.billing_payment enable trigger billing_payment_guard");
  });

  describe('a payment that comes in', () => {
    it('is recorded once for each transaction of a provider, under the platform tenant, however often it is told', async () => {
      const input = { provider: 'mock-bank', txnRef: 'TXN-SAME', amountVnd: '1100000', method: 'BANK_TRANSFER' as const, receivedAt: new Date('2026-03-04T02:00:00Z'), memo: 'INV-20260201-AAAA1111', inboxEventId: null };
      const results = [];
      for (let n = 0; n < 4; n += 1) results.push(await asPlatform((tx) => payments.record(tx, input)));
      expect(results.map((result) => result.created)).toEqual([true, false, false, false]);
      expect(new Set(results.map((result) => result.payment?.id)).size).toBe(1);
      expect(results[0]?.payment).toMatchObject({ tenantId: PLATFORM_TENANT_ID, status: 'Unmatched', invoiceId: null, amountVnd: '1100000', method: 'BANK_TRANSFER', memo: 'INV-20260201-AAAA1111', version: 1 });
      expect((await admin<{ n: string }>("select count(*)::text as n from machvon.billing_payment where provider = 'mock-bank' and provider_txn_ref = 'TXN-SAME'"))[0]?.n).toBe('1');
      // Another transaction is another payment.
      const other = await asPlatform((tx) => payments.record(tx, { ...input, txnRef: 'TXN-OTHER' }));
      expect(other.created).toBe(true);
    });

    it('names the event it came from without being bound to it: the retention of the inbox can remove an old event while the payment stays', async () => {
      const gone = randomUUID();
      const { payment } = await asPlatform((tx) => payments.record(tx, { provider: 'mock-bank', txnRef: `TXN-${randomUUID()}`, amountVnd: '10', method: 'BANK_TRANSFER', receivedAt: new Date('2026-03-04T02:00:00Z'), memo: '', inboxEventId: gone }));
      const row = (await admin<{ source_inbox_event_id: string | null; inbox_event_id: string | null }>('select source_inbox_event_id, inbox_event_id from machvon.billing_payment where id = $1', [payment?.id]))[0];
      expect(row).toEqual({ source_inbox_event_id: gone, inbox_event_id: null });
    });

    it('is told the same by one provider only: the transaction of another provider with the same reference is another payment', async () => {
      const common = { txnRef: 'SHARED-REF', amountVnd: '10', method: 'GATEWAY' as const, receivedAt: new Date('2026-03-04T02:00:00Z'), memo: '', inboxEventId: null };
      expect((await asPlatform((tx) => payments.record(tx, { ...common, provider: 'mock-bank' }))).created).toBe(true);
      expect((await asPlatform((tx) => payments.record(tx, { ...common, provider: 'mock-gateway' }))).created).toBe(true);
    });
  });

  describe('the match by a person', () => {
    it('refuses an invoice whose outstanding amount is not the payment (422 AMOUNT_MISMATCH, nothing moves) and settles the right one: the payment goes to the tenant of the invoice, Matched, and the invoice is Paid', async () => {
      const right = await issuedInvoice(TENANT_A, '1000000');
      const wrong = await issuedInvoice(TENANT_B, '2500000');
      const payment = await arrived('1000000', 'chuyen khoan');
      await expect(matchBy(payment, wrong)).rejects.toMatchObject({ code: 'AMOUNT_MISMATCH', status: 422, extensions: { outstanding_vnd: '2500000', payment_vnd: '1000000' } });
      expect((await asPlatform((tx) => payments.find(tx, payment.id)))?.status).toBe('Unmatched');
      expect((await invoiceOf(TENANT_B, wrong.id)).status).toBe('Issued');
      const effects = recorder();
      const done = await matchBy(payment, right, effects);
      expect(done.payment).toMatchObject({ tenantId: TENANT_A, status: 'Matched', invoiceId: right.id, matchedBy: OPERATOR, amountVnd: '1000000', provider: payment.provider, txnRef: payment.txnRef });
      expect(done.invoice.status).toBe('Paid');
      expect(effects.audits.map((entry) => entry.action)).toEqual(['billing.payment_matched']);
      expect(effects.events.map((event) => event.type)).toEqual(['sas.payment.matched.v1']);
      // One payment for the transaction, and it is the tenant's now.
      const rows = await admin<{ tenant_id: string; match_status: string }>('select tenant_id, match_status from machvon.billing_payment where provider = $1 and provider_txn_ref = $2', [payment.provider, payment.txnRef]);
      expect(rows).toEqual([{ tenant_id: TENANT_A, match_status: 'Matched' }]);
      expect(await asPlatform((tx) => payments.find(tx, payment.id))).toBeUndefined();
      expect((await inTenant(TENANT_A, (tx) => payments.ofInvoices(tx, [right.id]))).map((row) => row.status)).toEqual(['Matched']);
    });

    it('refuses a payment that is not waiting (409 PAYMENT_STATE_INVALID), an invoice that is not payable (409 EINVOICE_STATE_INVALID) and an invoice that does not exist (404)', async () => {
      const invoice = await issuedInvoice(TENANT_A, '700000');
      const payment = await arrived('700000', '');
      await matchBy(payment, invoice);
      // It is the tenant's now: the platform finds nothing to match any more.
      await expect(matchBy(payment, invoice)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      const paid = await arrived('700000', '');
      await expect(matchBy(paid, invoice)).rejects.toMatchObject({ code: 'EINVOICE_STATE_INVALID', status: 409 });
      await expect(matchBy(paid, { ...invoice, id: randomUUID() })).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      await admin("update machvon.billing_payment set match_status = 'PendingReview' where id = $1", [paid.id]);
      const review = await asPlatform((tx) => payments.find(tx, paid.id));
      expect(review?.status).toBe('PendingReview');
    });

    it('settles a payment that waits for review too, and leaves the subscription past due while another invoice of it is overdue', async () => {
      const first = await issuedInvoice(TENANT_C, '400000');
      await admin("alter table machvon.invoice disable trigger invoice_guard");
      await admin("update machvon.invoice set status = 'Overdue' where id = $1", [first.id]);
      await admin("alter table machvon.invoice enable trigger invoice_guard");
      await admin("update machvon.subscription set status = 'PastDue', past_due_since = now(), suspension_proposed_at = now() where id = $1", [first.subscriptionId]);
      const payment = await arrived('400000', '');
      await admin("update machvon.billing_payment set match_status = 'PendingReview' where id = $1", [payment.id]);
      // Another invoice of the same subscription is overdue too: the subscription stays past due.
      await admin(
        `insert into machvon.invoice (tenant_id, id, subscription_id, invoice_code, period_start, period_end, kind, status, subtotal_vnd, vat_vnd, total_vnd, buyer_snapshot, einvoice_provider, einvoice_number, provider_ref, issued_at, due_at)
         values ($1, gen_random_uuid(), $2, 'INV-OLD', '2026-01-01', '2026-01-31', 'ORIGINAL', 'Overdue', 5, 0, 5, '{}', 'MOCK', 'N1', 'R1', now(), '2026-02-15')`,
        [TENANT_C, first.subscriptionId],
      );
      await matchBy(payment, first);
      expect((await admin<{ status: string }>('select status from machvon.subscription where id = $1', [first.subscriptionId]))[0]?.status).toBe('PastDue');
    });

    it('gives the subscription back its Active state when its last two overdue invoices are settled at the same moment', async () => {
      const first = await issuedInvoice(TENANT_B, '200000');
      const subscriptionId = first.subscriptionId;
      // A second invoice of the same subscription, for another period, issued with the table owner (the run makes one for each period of its own).
      const secondId = randomUUID();
      await admin(
        `insert into machvon.invoice (tenant_id, id, subscription_id, invoice_code, period_start, period_end, kind, status, subtotal_vnd, vat_vnd, total_vnd, buyer_snapshot, einvoice_provider, einvoice_number, provider_ref, issued_at, due_at)
         values ($1, $2, $3, 'INV-20260101-CONCURR1', '2026-01-01', '2026-01-31', 'ORIGINAL', 'Issued', 300000, 0, 300000, '{}', 'MOCK', 'N-CONC', 'R-CONC', now(), '2026-02-15')`,
        [TENANT_B, secondId, subscriptionId],
      );
      await admin('alter table machvon.invoice disable trigger invoice_guard');
      await admin("update machvon.invoice set status = 'Overdue' where subscription_id = $1", [subscriptionId]);
      await admin('alter table machvon.invoice enable trigger invoice_guard');
      await admin("update machvon.subscription set status = 'PastDue', past_due_since = now(), suspension_proposed_at = now() where id = $1", [subscriptionId]);
      const [one, other] = [await arrived('200000', ''), await arrived('300000', '')];
      await Promise.all([matchBy(one, first), matchBy(other, { ...first, id: secondId })]);
      expect((await admin<{ status: string }>('select status from machvon.subscription where id = $1', [subscriptionId]))[0]?.status).toBe('Active');
      expect((await admin<{ n: string }>("select count(*)::text as n from machvon.invoice where subscription_id = $1 and status = 'Paid'", [subscriptionId]))[0]?.n).toBe('2');
    });

    it('lets a pass of the worker and a person settle two payments of one subscription together without either being undone', async () => {
      const first = await issuedInvoice(TENANT_C, '210000');
      const secondId = randomUUID();
      await admin(
        `insert into machvon.invoice (tenant_id, id, subscription_id, invoice_code, period_start, period_end, kind, status, subtotal_vnd, vat_vnd, total_vnd, buyer_snapshot, einvoice_provider, einvoice_number, provider_ref, issued_at, due_at)
         values ($1, $2, $3, 'INV-20260101-CONCURR2', '2026-01-01', '2026-01-31', 'ORIGINAL', 'Issued', 310000, 0, 310000, '{}', 'MOCK', 'N-CONC2', 'R-CONC2', now(), '2026-02-15')`,
        [TENANT_C, secondId, first.subscriptionId],
      );
      const [byCode, byPerson] = [await arrived('210000', `CK ${first.invoiceCode}`), await arrived('310000', 'no code')];
      const [pass] = await Promise.all([passOf(), matchBy(byPerson, { ...first, id: secondId })]);
      expect(pass.matched).toBe(1);
      expect(await asPlatform((tx) => payments.find(tx, byCode.id))).toBeUndefined();
      expect((await admin<{ n: string }>("select count(*)::text as n from machvon.invoice where subscription_id = $1 and status = 'Paid'", [first.subscriptionId]))[0]?.n).toBe('2');
    });

    it('lets the overdue sweep of the billing job and a settlement of the same subscription run together, whichever comes first', async () => {
      const invoice = await issuedInvoice(TENANT_A, '95000');
      await admin("alter table machvon.invoice disable trigger invoice_guard");
      await admin("update machvon.invoice set due_at = '2026-03-01' where id = $1", [invoice.id]);
      await admin("alter table machvon.invoice enable trigger invoice_guard");
      const payment = await arrived('95000', '');
      await Promise.all([inTenant(TENANT_A, (tx) => billing.sweepOverdue(tx, recorder(), '2026-03-05', NOW)), matchBy(payment, invoice)]);
      expect((await invoiceOf(TENANT_A, invoice.id)).status).toBe('Paid');
      expect((await admin<{ status: string }>('select status from machvon.subscription where id = $1', [invoice.subscriptionId]))[0]?.status).toBe('Active');
    });

    it('gives a subscription back its Active state when the last overdue invoice is paid, and takes back the proposal to suspend it', async () => {
      const invoice = await issuedInvoice(TENANT_A, '300000');
      await admin("alter table machvon.invoice disable trigger invoice_guard");
      await admin("update machvon.invoice set status = 'Overdue' where id = $1", [invoice.id]);
      await admin("alter table machvon.invoice enable trigger invoice_guard");
      await admin("update machvon.subscription set status = 'PastDue', past_due_since = now(), suspension_proposed_at = now() where id = $1", [invoice.subscriptionId]);
      const effects = recorder();
      await matchBy(await arrived('300000', ''), invoice, effects);
      const row = (await admin<{ status: string; past_due_since: string | null; suspension_proposed_at: string | null }>('select status, past_due_since, suspension_proposed_at from machvon.subscription where id = $1', [invoice.subscriptionId]))[0];
      expect(row).toEqual({ status: 'Active', past_due_since: null, suspension_proposed_at: null });
      expect(effects.audits.map((entry) => entry.action)).toEqual(['billing.payment_matched', 'subscription.recovered']);
      expect((await admin<{ status: string }>('select status from machvon.tenant where id = $1', [TENANT_A]))[0]?.status).toBe('Active');
    });
  });

  describe('the matching worker', () => {
    it('settles the payment whose note names one payable invoice for exactly what is outstanding, sends the others to review and leaves a note without a code', async () => {
      const exact = await issuedInvoice(TENANT_A, '1000000');
      const other = await issuedInvoice(TENANT_B, '2000000');
      const byCode = await arrived('1000000', `Thanh toan ${exact.invoiceCode.toLowerCase()} thang 2`);
      const wrongAmount = await arrived('1999999', `CK ${other.invoiceCode}`);
      const noCode = await arrived('42', 'khong ghi ma');
      const unknownCode = await arrived('42', 'INV-20260201-FFFFFFFF');
      const effects = recorder();
      const result = await passOf(effects);
      expect(result).toEqual({ matched: 1, review: 1, unmatched: 2, waiting: 3 });
      expect((await invoiceOf(TENANT_A, exact.id)).status).toBe('Paid');
      expect((await invoiceOf(TENANT_B, other.id)).status).toBe('Issued');
      const status = async (id: string) => (await asPlatform((tx) => payments.find(tx, id)))?.status;
      expect([await status(byCode.id), await status(wrongAmount.id), await status(noCode.id), await status(unknownCode.id)]).toEqual([undefined, 'PendingReview', 'Unmatched', 'Unmatched']);
      expect((await inTenant(TENANT_A, (tx) => payments.ofInvoices(tx, [exact.id])))[0]).toMatchObject({ status: 'Matched', matchedBy: WORKER });
      // A second pass has nothing new to settle.
      expect(await passOf()).toEqual({ matched: 0, review: 0, unmatched: 2, waiting: 3 });
    });

    it('sends to review a payment whose note names two invoice codes of which only one is an invoice, and leaves one whose code is not whole', async () => {
      const only = await issuedInvoice(TENANT_A, '520000');
      const named = await arrived('520000', `${only.invoiceCode} INV-20260101-FFFFFFFE`);
      const partial = await arrived('520000', `${only.invoiceCode}0`);
      const result = await passOf();
      expect(result.matched).toBe(0);
      expect((await asPlatform((tx) => payments.find(tx, named.id)))?.status).toBe('PendingReview');
      expect((await asPlatform((tx) => payments.find(tx, partial.id)))?.status).toBe('Unmatched');
      expect((await invoiceOf(TENANT_A, only.id)).status).toBe('Issued');
    });

    it('sends a payment whose note names two invoices to review, and one whose invoice was paid meanwhile', async () => {
      const first = await issuedInvoice(TENANT_A, '500000');
      const second = await issuedInvoice(TENANT_B, '500000');
      const both = await arrived('500000', `${first.invoiceCode} ${second.invoiceCode}`);
      expect((await passOf()).review).toBe(1);
      expect((await asPlatform((tx) => payments.find(tx, both.id)))?.status).toBe('PendingReview');
      expect((await invoiceOf(TENANT_A, first.id)).status).toBe('Issued');
    });
  });

  describe('what the worker does not let starve', () => {
    it('looks at the payments it could not settle after the others: fifty-one payments that name an unknown invoice do not keep one that names a real one from being matched', async () => {
      const invoice = await issuedInvoice(TENANT_A, '640000');
      // The fifty-one are older than the real one, so a pass that took the oldest first and never moved on would never reach it.
      for (let n = 0; n < 51; n += 1) {
        await asPlatform((tx) =>
          payments.record(tx, { provider: 'mock-bank', txnRef: `OLD-${n}-${randomUUID()}`, amountVnd: '10', method: 'BANK_TRANSFER', receivedAt: new Date(Date.UTC(2026, 2, 1, 0, 0, n)), memo: `INV-20260101-${n.toString(16).toUpperCase().padStart(8, '0')} no such invoice`, inboxEventId: null }),
        );
      }
      const real = await arrived('640000', `CK ${invoice.invoiceCode}`);
      const first = await passOf();
      expect(first.matched).toBe(0);
      const second = await passOf();
      expect(second.matched).toBe(1);
      expect((await invoiceOf(TENANT_A, invoice.id)).status).toBe('Paid');
      expect(await asPlatform((tx) => payments.find(tx, real.id))).toBeUndefined();
    });

    it('does not look at a payment whose note names no invoice code at all, and counts it as waiting', async () => {
      const quiet = await arrived('5', 'no code here');
      const result = await passOf();
      expect(result).toMatchObject({ matched: 0, review: 0, unmatched: 1, waiting: 1 });
      expect((await admin<{ match_attempted_at: string | null }>('select match_attempted_at from machvon.billing_payment where id = $1', [quiet.id]))[0]?.match_attempted_at).toBeNull();
    });

    it('tells a payment of a transaction that was matched since as one payment already, without failing', async () => {
      const invoice = await issuedInvoice(TENANT_A, '88000');
      const payment = await arrived('88000', '');
      await matchBy(payment, invoice);
      const again = await asPlatform((tx) => payments.record(tx, { provider: payment.provider, txnRef: payment.txnRef, amountVnd: '88000', method: 'BANK_TRANSFER', receivedAt: new Date('2026-03-04T02:00:00Z'), memo: '', inboxEventId: null }));
      expect(again).toEqual({ payment: undefined, created: false });
      expect(await count(payment.provider, payment.txnRef)).toBe(1);
    });
  });

  describe('acting as a tenant', () => {
    it('puts the caller back in its own tenant when the work is refused, so that the transaction can go on', async () => {
      const after = await asPlatform(async (tx) => {
        await actingAsTenant(tx, TENANT_A, PLATFORM_TENANT_ID, async () => {
          throw new DomainError('RESOURCE_NOT_FOUND', 404);
        }).catch(() => undefined);
        return (await tx.query<{ tenant: string }>("select current_setting('app.tenant_id') as tenant"))[0]?.tenant;
      });
      expect(after).toBe(PLATFORM_TENANT_ID);
    });
  });

  describe('the invoices a note names', () => {
    it('are found in any tenant by their code, without the discarded ones, with what is outstanding of each', async () => {
      const invoice = await issuedInvoice(TENANT_A, '900000');
      const found = await asPlatform((tx) => payments.candidates(tx, `x ${invoice.invoiceCode} y`));
      expect(found).toEqual([{ tenantId: TENANT_A, invoiceId: invoice.id, status: 'Issued', outstandingVnd: '900000' }]);
      expect(await asPlatform((tx) => payments.candidates(tx, 'nothing here'))).toEqual([]);
    });
  });

  describe('what the table keeps', () => {
    it('never edits what a payment says, never deletes it, and moves its status forward only', async () => {
      const payment = await arrived('100', 'note');
      for (const statement of ['update machvon.billing_payment set amount_vnd = 1 where id = $1', "update machvon.billing_payment set memo = 'x' where id = $1", "update machvon.billing_payment set provider_txn_ref = 'x' where id = $1", 'delete from machvon.billing_payment where id = $1']) {
        expect((await sqlError(statement, [payment.id]))?.code).toBe('23514');
      }
      expect((await sqlError("update machvon.billing_payment set match_status = 'Reversed' where id = $1", [payment.id]))?.code).toBe('23514');
      expect(await sqlError("update machvon.billing_payment set match_status = 'PendingReview', version = version + 1 where id = $1", [payment.id])).toBeUndefined();
      expect(await sqlError("update machvon.billing_payment set match_status = 'Unmatched', version = version + 1 where id = $1", [payment.id])).toBeUndefined();
    });

    it('is Matched exactly when it names an invoice and who matched it, and a transaction is one payment across tenants', async () => {
      const payment = await arrived('100', '');
      expect((await sqlError("update machvon.billing_payment set match_status = 'Matched' where id = $1", [payment.id]))?.code).toBe('23514');
      const duplicate = await sqlError(
        "insert into machvon.billing_payment (tenant_id, id, provider, provider_txn_ref, amount_vnd, method, received_at, match_status) values ($1, gen_random_uuid(), $2, $3, 5, 'BANK_TRANSFER', now(), 'Unmatched')",
        [TENANT_A, payment.provider, payment.txnRef],
      );
      expect(duplicate?.code).toBe('23505');
    });
  });

  describe('the answer of a provider that came later', () => {
    const issued = { providerRef: 'R', templateCode: '1', series: 'C26TMV', number: '0000099', taxAuthorityCode: 'CQT99', lookupCode: 'LK99' };

    async function waiting(tenant: string): Promise<InvoiceRow> {
      await admin("update machvon.subscription set status = 'Cancelled' where tenant_id = $1 and status <> 'Cancelled'", [tenant]);
      await inTenant(tenant, async (tx) =>
        subscriptions.create(tx, { planVersionId: await plan('10'), cycle: 'MONTHLY', billingAnchor: '2026-01-01', trialDays: 0, paymentTerms: { dueDays: 15, method: 'BANK_TRANSFER' }, now: new Date('2026-01-01T03:00:00Z') }),
      );
      const made = (await inTenant(tenant, (tx) => billing.runPeriod(tx, recorder(), FEBRUARY, TODAY))).created[0] as InvoiceRow;
      const provider = new MockEInvoiceProvider();
      provider.failNext(1);
      return (await inTenant(tenant, (tx) => billing.issue(tx, recorder(), provider, made.id, made.version, NOW))).invoice;
    }

    it('issues the invoice that waited for it, once: the same answer again changes nothing, another number is refused', async () => {
      const invoice = await waiting(TENANT_A);
      expect(invoice.status).toBe('PendingIssue');
      const effects = recorder();
      const first = await inTenant(TENANT_A, (tx) => billing.completeIssue(tx, effects, invoice.id, issued, 'MOCK', NOW));
      expect(first.changed).toBe(true);
      expect(first.invoice).toMatchObject({ status: 'Issued', number: '0000099', series: 'C26TMV', taxAuthorityCode: 'CQT99', lookupCode: 'LK99', provider: 'MOCK' });
      expect(effects.audits.map((entry) => entry.action)).toEqual(['invoice.issued']);
      const again = await inTenant(TENANT_A, (tx) => billing.completeIssue(tx, recorder(), invoice.id, issued, 'MOCK', NOW));
      expect(again.changed).toBe(false);
      await expect(inTenant(TENANT_A, (tx) => billing.completeIssue(tx, recorder(), invoice.id, { ...issued, number: '0000100' }, 'MOCK', NOW))).rejects.toMatchObject({ code: 'EINVOICE_STATE_INVALID', status: 409 });
    });

    it('issues an invoice that could not be issued, and refuses a draft and an invoice that does not exist', async () => {
      const invoice = await waiting(TENANT_B);
      await admin("update machvon.invoice set status = 'IssueFailed', next_attempt_at = null where id = $1", [invoice.id]);
      expect((await inTenant(TENANT_B, (tx) => billing.completeIssue(tx, recorder(), invoice.id, { ...issued, number: '0000098' }, 'MOCK', NOW))).invoice.status).toBe('Issued');
      await expect(inTenant(TENANT_B, (tx) => billing.completeIssue(tx, recorder(), randomUUID(), issued, 'MOCK', NOW))).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      const march = (await inTenant(TENANT_B, (tx) => billing.runPeriod(tx, recorder(), { start: '2026-03-01', end: '2026-03-31' }, TODAY))).created[0] as InvoiceRow;
      await expect(inTenant(TENANT_B, (tx) => billing.completeIssue(tx, recorder(), march.id, issued, 'MOCK', NOW))).rejects.toMatchObject({ code: 'EINVOICE_STATE_INVALID', status: 409 });
    });
  });
});
