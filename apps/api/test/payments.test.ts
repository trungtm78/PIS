import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EffectiveAccessStore, InMemoryAuthzCache, PLATFORM_TENANT_ID, seedSystemRoles, sharedMockEInvoiceProvider } from '@machvon/db';
import { billingPeriod, loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { AppModule } from '../src/app.module';
import { CLAIMS_HEADER, TENANT_HEADER } from './isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from './isolation/test-app';
import type { RunningApp } from './isolation/test-app';
import { ProvisioningHarness } from './provisioning/provisioning-fixtures';
import { paymentCallbackHandler } from '../src/modules/sas/payment-webhook.controller';
import { defaultWebhookProviders } from '../src/modules/sas/webhook-providers';

const SIGNING_KEY = randomBytes(32);
const OPERATOR = '00000000-0000-4000-8000-0000000000c9';
const BANK_SECRET = 'bank-secret-0001';
const EINVOICE_SECRET = 'einvoice-secret-0001';
const ANCHOR = '2026-01-01';
const JANUARY = billingPeriod(ANCHOR, 'MONTHLY', 0);
const REASON = 'The payer wrote the code in the wrong place.';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the payment and e-invoice webhooks and the reconciliation over HTTP (ST-SAS-012)', () => {
  const harness = new ProvisioningHarness();
  const environment = { ...process.env };
  let app: RunningApp;
  let counter = 0;

  const admin = async <T extends object = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> => harness.admin(async (client) => (await client.query(text, params)).rows as T[]);

  async function call(method: string, path: string, options: { roles?: string[]; audience?: string; payload?: unknown; ifMatch?: string } = {}): Promise<Reply> {
    const token = signTenantContext({ tenantId: PLATFORM_TENANT_ID, membershipId: OPERATOR, scopeVersion: 0 }, SIGNING_KEY);
    const headers: Record<string, string> = {
      [TENANT_HEADER]: token,
      [CLAIMS_HEADER]: JSON.stringify({ aud: options.audience ?? 'control', roles: options.roles ?? ['BillingOperator'] }),
      'content-type': 'application/json',
    };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${path}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.payload ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  /** A callback as a provider sends it: signed over `timestamp.rawBody` with the secret of that provider, unless the case says otherwise. */
  async function webhook(kind: 'payments' | 'einvoice', provider: string, body: Record<string, unknown> | string, options: { secret?: string; timestamp?: number; signed?: boolean; tamper?: boolean } = {}): Promise<Reply> {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-timestamp': String(timestamp) };
    const secret = options.secret ?? (kind === 'payments' ? BANK_SECRET : EINVOICE_SECRET);
    if (options.signed !== false) headers['x-signature'] = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
    const sent = options.tamper === true ? raw.replace('"amount_vnd"', '"amount_vnd" ') : raw;
    const response = await fetch(`${app.baseUrl}/webhooks/${kind}/${provider}`, { method: 'POST', headers, body: sent });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const paymentBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    event_id: `evt-${randomUUID()}`,
    type: 'payment.received',
    txn_ref: `TXN-${randomUUID()}`,
    amount_vnd: '1100000',
    received_at: new Date().toISOString(),
    memo: 'chuyen khoan',
    ...overrides,
  });
  const count = async (text: string, params: unknown[] = []): Promise<number> => Number((await admin<{ n: string }>(text, params))[0]?.n);

  async function plan(price: string): Promise<string> {
    counter += 1;
    const id = randomUUID();
    await admin(
      `insert into machvon.product_plan_version (id, plan_code, revision, name, status, billing_cycles, base_price_vnd, vat_category, legal_terms_ref)
       values ($1, $2, 1, $3, 'Draft', $4::text[], $5::numeric, 'VAT_10', 'TERMS-1')`,
      [id, `pay-${counter}`, `Plan ${counter}`, ['ANNUAL', 'MONTHLY'], price],
    );
    await admin("insert into machvon.plan_feature (id, plan_version_id, feature_code, limit_kind, limit_value, grace_behavior, expired_behavior) values (gen_random_uuid(), $1, 'member.seats', 'QUOTA', 50, 'READ_ONLY', 'DENY')", [id]);
    await admin("update machvon.product_plan_version set status = 'Published', published_by = $2, published_at = now() where id = $1", [id, OPERATOR]);
    return id;
  }

  /** An Active tenant with a monthly subscription and its January invoice, issued (or left waiting for the provider): the amounts are the plan price plus 10 percent VAT. */
  async function invoiceOf(price = '1000000', options: { providerDown?: boolean } = {}): Promise<{ tenantId: string; invoiceId: string; code: string; total: string; viewer: string }> {
    const created = await harness.request();
    const tenantId = created.tenantId;
    await harness.registry.transition(tenantId, 'Requested', 'Provisioning');
    await harness.registry.transition(tenantId, 'Provisioning', 'Active');
    counter += 1;
    const viewer = `00000000-0000-4000-8000-${(0xd000 + counter).toString(16).padStart(12, '0')}`;
    await harness.tenants.withTenant({ tenantId, membershipId: viewer, scopeVersion: 1 }, (tx) => seedSystemRoles(tx, OPERATOR));
    const subscription = await call('POST', `/system/tenants/${tenantId}/subscriptions`, { payload: { plan_version_id: await plan(price), cycle: 'MONTHLY', billing_anchor: ANCHOR, payment_terms: { due_days: 15, method: 'BANK_TRANSFER' } } });
    expect(subscription.status).toBe(201);
    expect((await call('POST', '/system/billing-runs', { payload: { period_start: JANUARY.start, period_end: JANUARY.end, tenant_ids: [tenantId] } })).status).toBe(202);
    const [draft] = (await call('GET', `/system/tenants/${tenantId}/invoices`)).json.items as Array<{ id: string; version: number; invoice_code: string; total_vnd: string }>;
    if (options.providerDown === true) sharedMockEInvoiceProvider().failNext(1);
    const issued = await call('POST', `/system/invoices/${draft?.id}/issue`, { payload: { reason: 'Issue the invoice of the period.' }, ifMatch: `"${draft?.version}"` });
    expect(issued.status).toBe(202);
    return { tenantId, invoiceId: draft?.id as string, code: draft?.invoice_code as string, total: draft?.total_vnd as string, viewer };
  }

  /** Waits for something that happens after the answer (the matching runs on its own), a few seconds at most. */
  async function eventually(condition: () => Promise<boolean>): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await condition()) return;
      await new Promise((wait) => setTimeout(wait, 100));
    }
    throw new Error('it did not happen');
  }

  const invoicesOf = async (tenantId: string): Promise<Array<Record<string, unknown>>> => (await call('GET', `/system/tenants/${tenantId}/invoices`)).json.items as Array<Record<string, unknown>>;

  beforeAll(async () => {
    process.env.MACHVON_ENVIRONMENT = 'test';
    process.env.MACHVON_OBJECT_ROOT = mkdtempSync(join(tmpdir(), 'machvon-payments-'));
    process.env.MACHVON_SECRET_PLATFORM_WEBHOOKS_MOCK_BANK = `k1:${BANK_SECRET}`;
    process.env.MACHVON_SECRET_PLATFORM_WEBHOOKS_MOCK_EINVOICE = `k1:${EINVOICE_SECRET}`;
    await harness.start();
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        AppModule.register({
          database: harness.tenants,
          registry: loadErrorRegistry(ERROR_CODES_PATH),
          policy: { database: harness.tenants, access: new EffectiveAccessStore(harness.tenants, new InMemoryAuthzCache()) },
          control: { database: harness.control, registry: harness.registry },
        }),
      ],
    });
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
    for (const key of ['MACHVON_ENVIRONMENT', 'MACHVON_OBJECT_ROOT', 'MACHVON_SECRET_PLATFORM_WEBHOOKS_MOCK_BANK', 'MACHVON_SECRET_PLATFORM_WEBHOOKS_MOCK_EINVOICE']) {
      if (environment[key] === undefined) delete process.env[key];
      else process.env[key] = environment[key];
    }
  }, 60_000);

  it('AC-ST-SAS-012-1 UAT-AC36: the same payment webhook sent four times answers 200 duplicate false and then three times duplicate true, with one inbox row and one payment', async () => {
    const body = paymentBody();
    const replies = [];
    for (let n = 0; n < 4; n += 1) replies.push(await webhook('payments', 'mock-bank', body));
    expect(replies.map((reply) => [reply.status, reply.json])).toEqual([[200, { received: true, duplicate: false }], ...Array(3).fill([200, { received: true, duplicate: true }])]);
    expect(await count("select count(*)::text as n from machvon.integration_event_inbox where provider = 'mock-bank' and event_key = $1", [body.event_id])).toBe(1);
    expect(await count("select count(*)::text as n from machvon.billing_payment where provider = 'mock-bank' and provider_txn_ref = $1", [body.txn_ref])).toBe(1);
    const row = (await admin<{ tenant_id: string; match_status: string; amount_vnd: string }>("select tenant_id, match_status, amount_vnd::text from machvon.billing_payment where provider_txn_ref = $1", [body.txn_ref]))[0];
    expect(row).toEqual({ tenant_id: PLATFORM_TENANT_ID, match_status: 'Unmatched', amount_vnd: '1100000' });
    // The inbox row is the platform's and was processed.
    expect((await admin<{ tenant_id: string; status: string }>("select tenant_id, status from machvon.integration_event_inbox where event_key = $1", [body.event_id]))[0]).toEqual({ tenant_id: PLATFORM_TENANT_ID, status: 'PROCESSED' });
  });

  it('records one payment when the same webhook arrives at the same moment', async () => {
    const body = paymentBody();
    const replies = await Promise.all([0, 1, 2, 3].map(() => webhook('payments', 'mock-bank', body)));
    expect(replies.every((reply) => reply.status === 200)).toBe(true);
    expect(replies.filter((reply) => reply.json.duplicate === false)).toHaveLength(1);
    expect(await count("select count(*)::text as n from machvon.billing_payment where provider_txn_ref = $1", [body.txn_ref])).toBe(1);
  });

  it('refuses a tampered body, a stale timestamp, an unsigned callback and a wrong secret with 401, and stores nothing', async () => {
    const body = paymentBody();
    const before = await count("select count(*)::text as n from machvon.integration_event_inbox where provider = 'mock-bank'");
    const tampered = await webhook('payments', 'mock-bank', body, { tamper: true });
    expect([tampered.status, tampered.json.code]).toEqual([401, 'SIGNATURE_INVALID']);
    const stale = await webhook('payments', 'mock-bank', body, { timestamp: Math.floor(Date.now() / 1000) - 3600 });
    expect([stale.status, stale.json.code]).toEqual([401, 'REPLAY_WINDOW_EXCEEDED']);
    const unsigned = await webhook('payments', 'mock-bank', body, { signed: false });
    expect([unsigned.status, unsigned.json.code]).toEqual([401, 'SIGNATURE_INVALID']);
    const wrong = await webhook('payments', 'mock-bank', body, { secret: ['not', 'the', 'secret'].join('-') });
    expect([wrong.status, wrong.json.code]).toEqual([401, 'SIGNATURE_INVALID']);
    expect(await count("select count(*)::text as n from machvon.integration_event_inbox where provider = 'mock-bank'")).toBe(before);
    expect(await count("select count(*)::text as n from machvon.billing_payment where provider_txn_ref = $1", [body.txn_ref])).toBe(0);
  });

  it('records the body the inbox accepted when two bodies of one event id arrive together', async () => {
    const eventId = `evt-${randomUUID()}`;
    const [one, other] = [paymentBody({ event_id: eventId, amount_vnd: '111' }), paymentBody({ event_id: eventId, amount_vnd: '222' })];
    const replies = await Promise.all([webhook('payments', 'mock-bank', one), webhook('payments', 'mock-bank', other)]);
    expect(replies.map((reply) => reply.status)).toEqual([200, 200]);
    const inbox = (await admin<{ payload_hash: string; status: string }>("select payload_hash, status from machvon.integration_event_inbox where provider = 'mock-bank' and event_key = $1", [eventId]));
    expect(inbox).toHaveLength(1);
    const accepted = [one, other].find((body) => createHash('sha256').update(JSON.stringify(body)).digest('hex') === inbox[0]?.payload_hash);
    expect(accepted).toBeDefined();
    // The payment is the one of the accepted body, and the event did not end up failed for want of the bytes it accepted.
    await eventually(async () => (await count('select count(*)::text as n from machvon.billing_payment where provider_txn_ref = any($1::text[])', [[one.txn_ref, other.txn_ref]])) === 1);
    expect((await admin<{ provider_txn_ref: string }>('select provider_txn_ref from machvon.billing_payment where provider_txn_ref = any($1::text[])', [[one.txn_ref, other.txn_ref]]))[0]?.provider_txn_ref).toBe(accepted?.txn_ref);
    expect(inbox[0]?.status).toBe('PROCESSED');
  });

  it('records only the body the inbox accepted: a stored body of another hash is never applied', async () => {
    const accepted = paymentBody();
    await webhook('payments', 'mock-bank', accepted);
    const inbox = (await admin<{ id: string }>("select id from machvon.integration_event_inbox where provider = 'mock-bank' and event_key = $1", [accepted.event_id]))[0];
    const impostor = paymentBody({ txn_ref: `IMPOSTOR-${randomUUID()}`, amount_vnd: '999' });
    const handler = paymentCallbackHandler(defaultWebhookProviders('test'), { put: async () => 'x', read: async () => Buffer.from(JSON.stringify(impostor)) });
    await expect(harness.tenants.withTenant({ tenantId: PLATFORM_TENANT_ID, membershipId: OPERATOR, scopeVersion: 0 }, (tx) => handler({ id: inbox?.id as string, provider: 'mock-bank', eventKey: accepted.event_id as string, eventType: 'payment.received', payloadReference: 'x', attempts: 0 }, tx))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await count('select count(*)::text as n from machvon.billing_payment where provider_txn_ref = $1', [impostor.txn_ref])).toBe(0);
  });

  it('refuses a provider nobody registered (404), a callback of another kind of provider, and a signed body that is not a payment (400)', async () => {
    expect((await webhook('payments', 'no-such-bank', paymentBody())).status).toBe(404);
    expect((await webhook('payments', 'mock-einvoice', paymentBody())).status).toBe(404);
    expect((await webhook('einvoice', 'mock-bank', paymentBody())).status).toBe(404);
    // A body that is not JSON never reaches the controller (the framework refuses it, 400 or 422 by how the application parses bodies); either way nothing is stored.
    expect([400, 422]).toContain((await webhook('payments', 'mock-bank', 'not json')).status);
    expect((await webhook('payments', 'mock-bank', paymentBody({ amount_vnd: '-5' }))).status).toBe(400);
    expect((await webhook('payments', 'mock-bank', paymentBody({ type: 'payment.refunded' }))).status).toBe(400);
  });

  it('matches a payment whose note names the invoice and whose amount is what is outstanding: it goes to the tenant, the invoice is Paid', async () => {
    const invoice = await invoiceOf();
    const body = paymentBody({ amount_vnd: invoice.total, memo: `Thanh toan ${invoice.code.toLowerCase()} thang 1` });
    expect((await webhook('payments', 'mock-bank', body)).json).toEqual({ received: true, duplicate: false });
    // The answer did not wait for the matching: it follows within moments.
    await eventually(async () => (await invoicesOf(invoice.tenantId))[0]?.status === 'Paid');
    const [paid] = await invoicesOf(invoice.tenantId);
    expect(paid).toMatchObject({ id: invoice.invoiceId, status: 'Paid' });
    expect(paid?.payments).toEqual([expect.objectContaining({ txn_ref: body.txn_ref, match_status: 'Matched', amount_vnd: invoice.total, invoice_id: invoice.invoiceId, actions: { match: false } })]);
    expect(await count('select count(*)::text as n from machvon.billing_payment where provider_txn_ref = $1', [body.txn_ref])).toBe(1);
    expect((await admin<{ tenant_id: string }>('select tenant_id from machvon.billing_payment where provider_txn_ref = $1', [body.txn_ref]))[0]?.tenant_id).toBe(invoice.tenantId);
    // The queue of the platform no longer has it.
    const queue = (await call('GET', '/system/payments')).json.items as Array<{ txn_ref: string }>;
    expect(queue.map((payment) => payment.txn_ref)).not.toContain(body.txn_ref);
    // And the audit trail says who: the worker, for the tenant of the invoice.
    expect(await count("select count(*)::text as n from machvon.audit_event where action = 'billing.payment_matched' and tenant_id = $1", [invoice.tenantId])).toBe(1);
  });

  it('AC-ST-SAS-012-2 UAT-AC167: an Unmatched payment matched with an invoice of another amount is 422 AMOUNT_MISMATCH, and with the right invoice it is Matched', async () => {
    const wrong = await invoiceOf('2500000');
    const right = await invoiceOf('1000000');
    const body = paymentBody({ amount_vnd: right.total, memo: 'khong ghi ma hoa don' });
    expect((await webhook('payments', 'mock-bank', body)).status).toBe(200);
    const queue = (await call('GET', '/system/payments?status=Unmatched')).json.items as Array<{ id: string; txn_ref: string; match_status: string; version: number; memo: string; actions: { match: boolean } }>;
    const waiting = queue.find((payment) => payment.txn_ref === body.txn_ref);
    expect(waiting).toMatchObject({ match_status: 'Unmatched', memo: 'khong ghi ma hoa don', actions: { match: true } });
    const attempt = (invoiceId: string, ifMatch = `"${waiting?.version}"`): Promise<Reply> => call('POST', `/system/payments/${waiting?.id}/match`, { payload: { invoice_id: invoiceId, reason: REASON }, ifMatch });
    const refused = await attempt(wrong.invoiceId);
    expect([refused.status, refused.json.code]).toEqual([422, 'AMOUNT_MISMATCH']);
    expect((await invoicesOf(wrong.tenantId))[0]).toMatchObject({ status: 'Issued', payments: [] });
    expect((await call('POST', `/system/payments/${waiting?.id}/match`, { payload: { invoice_id: right.invoiceId, reason: REASON } })).status).toBe(428);
    expect((await attempt(right.invoiceId, '"99"')).json.code).toBe('VERSION_CONFLICT');
    const matched = await attempt(right.invoiceId);
    expect(matched.status).toBe(200);
    expect(matched.json).toMatchObject({ status: 'MATCHED' });
    expect((await invoicesOf(right.tenantId))[0]).toMatchObject({ status: 'Paid', payments: [expect.objectContaining({ match_status: 'Matched', txn_ref: body.txn_ref })] });
    // It is the tenant's now: matching it again finds nothing of the platform's.
    expect((await attempt(right.invoiceId)).status).toBe(404);
    const audit = await admin<{ reason: string | null }>("select reason from machvon.audit_event where action = 'billing.payment_matched' and tenant_id = $1", [right.tenantId]);
    expect(audit[0]?.reason).toBe(REASON);
  });

  it('UAT-PLAN-48 an issued invoice is read with its number, the code of the tax authority the provider gave and the payment that matched it (Matched), and a bank line that does not fit is Unmatched and is refused with the amount that is outstanding and the amount paid, so the difference in VND is known', async () => {
    const invoice = await invoiceOf('1000000', { providerDown: true });
    // The provider answers late with the number and the code of the tax authority.
    const issued = await webhook('einvoice', 'mock-einvoice', { event_id: `evt-${randomUUID()}`, type: 'einvoice.issued', reference_key: invoice.invoiceId, template_code: '1', series: 'C26TMV', number: '000000007', tax_authority_code: 'TAX-8812', lookup_code: 'LOOKUP-7' });
    expect(issued.json).toEqual({ received: true, duplicate: false });
    // A bank line that names the invoice and the amount that is outstanding matches it.
    const exact = paymentBody({ amount_vnd: invoice.total, memo: `CK ${invoice.code}` });
    expect((await webhook('payments', 'mock-bank', exact)).status).toBe(200);
    await eventually(async () => (await invoicesOf(invoice.tenantId))[0]?.status === 'Paid');
    const [row] = await invoicesOf(invoice.tenantId);
    expect(row).toMatchObject({ id: invoice.invoiceId, invoice_code: invoice.code, status: 'Paid', einvoice: { tax_authority_code: 'TAX-8812', number: '000000007' } });
    expect(row?.payments).toEqual([expect.objectContaining({ txn_ref: exact.txn_ref, match_status: 'Matched', amount_vnd: invoice.total })]);
    // A bank line of 600,000 VND less than the invoice, with no code in its note, stays Unmatched; matching it by hand is refused with the two amounts.
    const open = await invoiceOf('1000000');
    const short = paymentBody({ amount_vnd: String(Number(open.total) - 600000), memo: 'khong ghi ma hoa don' });
    expect((await webhook('payments', 'mock-bank', short)).status).toBe(200);
    const queued = ((await call('GET', '/system/payments?status=Unmatched')).json.items as Array<{ id: string; txn_ref: string; match_status: string; version: number; amount_vnd: string }>).find((payment) => payment.txn_ref === short.txn_ref);
    expect(queued).toMatchObject({ match_status: 'Unmatched', amount_vnd: short.amount_vnd });
    const refused = await call('POST', `/system/payments/${queued?.id}/match`, { payload: { invoice_id: open.invoiceId, reason: REASON }, ifMatch: `"${queued?.version}"` });
    expect([refused.status, refused.json.code]).toEqual([422, 'AMOUNT_MISMATCH']);
    expect(Number(refused.json.outstanding_vnd) - Number(refused.json.payment_vnd)).toBe(600000);
    // The negative control: a check that wants the short line Matched must fail on this record.
    expect(() => expect(queued).toMatchObject({ match_status: 'Matched' })).toThrow();
  });

  it('keeps a payment whose amount is not the invoice at PendingReview for a person, and shows it in the queue', async () => {
    const invoice = await invoiceOf();
    const body = paymentBody({ amount_vnd: '500000', memo: `CK ${invoice.code}` });
    await webhook('payments', 'mock-bank', body);
    const reviewOf = async () => ((await call('GET', '/system/payments?status=PendingReview')).json.items as Array<{ txn_ref: string; match_status: string }>).find((payment) => payment.txn_ref === body.txn_ref);
    await eventually(async () => (await reviewOf()) !== undefined);
    expect((await reviewOf())?.match_status).toBe('PendingReview');
    expect((await invoicesOf(invoice.tenantId))[0]).toMatchObject({ status: 'Issued' });
  });

  it('pages the queue, the latest first, and refuses a status or a cursor that is not one', async () => {
    for (let n = 0; n < 3; n += 1) await webhook('payments', 'mock-bank', paymentBody({ memo: `no code ${n}`, received_at: new Date(Date.now() + n * 1000).toISOString() }));
    const first = await call('GET', '/system/payments?limit=2');
    expect((first.json.items as unknown[]).length).toBe(2);
    expect(typeof first.json.next_cursor).toBe('string');
    const second = await call('GET', `/system/payments?limit=2&cursor=${encodeURIComponent(first.json.next_cursor as string)}`);
    const firstIds = (first.json.items as Array<{ id: string }>).map((payment) => payment.id);
    expect((second.json.items as Array<{ id: string }>).some((payment) => firstIds.includes(payment.id))).toBe(false);
    expect((await call('GET', '/system/payments?status=Matched')).status).toBe(422);
    expect((await call('GET', '/system/payments?limit=0')).status).toBe(422);
  });

  it('is for the control plane and those who manage billing: a tenant caller and a role without the right are refused', async () => {
    const body = paymentBody();
    await webhook('payments', 'mock-bank', body);
    const [payment] = (await call('GET', '/system/payments')).json.items as Array<{ id: string; version: number }>;
    const invoice = await invoiceOf();
    const match = (options: { roles?: string[]; audience?: string }): Promise<Reply> => call('POST', `/system/payments/${payment?.id}/match`, { ...options, payload: { invoice_id: invoice.invoiceId, reason: REASON }, ifMatch: `"${payment?.version}"` });
    expect((await match({ audience: 'tenant' })).status).toBe(403);
    expect((await match({ roles: ['Viewer'] })).status).toBe(403);
    expect((await call('GET', '/system/payments', { audience: 'tenant' })).status).toBe(403);
  });

  describe('the answer of the e-invoice provider (receiveEInvoiceWebhook)', () => {
    const einvoiceBody = (invoiceId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      event_id: `evt-${randomUUID()}`,
      type: 'einvoice.issued',
      reference_key: invoiceId,
      template_code: '1',
      series: 'C26TMV',
      number: `${Math.floor(Math.random() * 1e9)}`.padStart(9, '0'),
      tax_authority_code: 'CQT-ABC-123',
      lookup_code: 'LOOKUP-0001',
      ...overrides,
    });

    it('issues the invoice that waited for the provider with the number and the code of the tax authority, once, and refuses another number for it', async () => {
      const invoice = await invoiceOf('1000000', { providerDown: true });
      expect((await invoicesOf(invoice.tenantId))[0]).toMatchObject({ status: 'PendingIssue' });
      const body = einvoiceBody(invoice.invoiceId);
      expect((await webhook('einvoice', 'mock-einvoice', body)).json).toEqual({ received: true, duplicate: false });
      // The event is kept once it was applied, and kept as processed: nothing of this provider waits in the inbox for a worker to acknowledge.
      expect((await admin<{ status: string; tenant_id: string }>('select status, tenant_id from machvon.integration_event_inbox where provider = $1 and event_key = $2', ['mock-einvoice', body.event_id]))).toEqual([{ status: 'PROCESSED', tenant_id: PLATFORM_TENANT_ID }]);
      expect((await invoicesOf(invoice.tenantId))[0]).toMatchObject({ status: 'Issued', einvoice: { provider: 'MOCK', series: 'C26TMV', number: body.number, tax_authority_code: 'CQT-ABC-123', lookup_code: 'LOOKUP-0001' } });
      // Told again, it changes nothing; another number for an issued invoice is refused and nothing is rewritten.
      expect((await webhook('einvoice', 'mock-einvoice', body)).json).toEqual({ received: true, duplicate: true });
      const other = await webhook('einvoice', 'mock-einvoice', einvoiceBody(invoice.invoiceId, { number: '000000001' }));
      expect([other.status, other.json.code]).toEqual([409, 'EINVOICE_STATE_INVALID']);
      expect(((await invoicesOf(invoice.tenantId))[0]?.einvoice as { number: string }).number).toBe(body.number);
    });

    it('applies an event once: a second delivery of the same event id for another invoice is told as a duplicate and changes nothing', async () => {
      const first = await invoiceOf('1000000', { providerDown: true });
      const second = await invoiceOf('1000000', { providerDown: true });
      const body = einvoiceBody(first.invoiceId);
      expect((await webhook('einvoice', 'mock-einvoice', body)).json).toEqual({ received: true, duplicate: false });
      const reused = await webhook('einvoice', 'mock-einvoice', { ...einvoiceBody(second.invoiceId), event_id: body.event_id });
      expect([reused.status, reused.json]).toEqual([200, { received: true, duplicate: true }]);
      expect((await invoicesOf(second.tenantId))[0]).toMatchObject({ status: 'PendingIssue' });
      expect((await invoicesOf(first.tenantId))[0]).toMatchObject({ status: 'Issued' });
    });

    it('applies an event once even when two deliveries of its id arrive together for different invoices', async () => {
      const first = await invoiceOf('1000000', { providerDown: true });
      const second = await invoiceOf('1000000', { providerDown: true });
      const eventId = `evt-${randomUUID()}`;
      const replies = await Promise.all([
        webhook('einvoice', 'mock-einvoice', { ...einvoiceBody(first.invoiceId), event_id: eventId }),
        webhook('einvoice', 'mock-einvoice', { ...einvoiceBody(second.invoiceId), event_id: eventId }),
      ]);
      expect(replies.map((reply) => reply.status)).toEqual([200, 200]);
      expect(replies.filter((reply) => reply.json.duplicate === false)).toHaveLength(1);
      const states = await Promise.all([first, second].map(async (invoice) => (await invoicesOf(invoice.tenantId))[0]?.status));
      expect(states.sort()).toEqual(['Issued', 'PendingIssue']);
    });

    it('refuses an invoice nobody knows (404), a callback that is not signed or is tampered (401) and one that is not an issue (400)', async () => {
      const invoice = await invoiceOf('1000000', { providerDown: true });
      const unknown = einvoiceBody(randomUUID());
      expect((await webhook('einvoice', 'mock-einvoice', unknown)).status).toBe(404);
      // A callback that could not be applied is not kept: the provider sends it again, and nothing is left for a worker to take for done.
      expect(await count("select count(*)::text as n from machvon.integration_event_inbox where provider = 'mock-einvoice' and event_key = $1", [unknown.event_id])).toBe(0);
      expect((await webhook('einvoice', 'mock-einvoice', einvoiceBody(invoice.invoiceId), { signed: false })).json.code).toBe('SIGNATURE_INVALID');
      expect((await webhook('einvoice', 'mock-einvoice', einvoiceBody(invoice.invoiceId), { secret: 'nope' })).status).toBe(401);
      expect((await webhook('einvoice', 'mock-einvoice', einvoiceBody(invoice.invoiceId, { type: 'einvoice.rejected' }))).status).toBe(400);
      expect((await webhook('einvoice', 'mock-einvoice', einvoiceBody('invoice-123'))).status).toBe(400);
      expect((await invoicesOf(invoice.tenantId))[0]).toMatchObject({ status: 'PendingIssue' });
    });
  });

  it('keeps the same payment of the same transaction from being told as a new one by another provider key: one transaction, one payment', async () => {
    const txnRef = `TXN-${randomUUID()}`;
    await webhook('payments', 'mock-bank', paymentBody({ txn_ref: txnRef }));
    // The provider sends the same transaction again under a new event id (a resend): one payment, and the second event is recorded as processed without making another.
    const second = await webhook('payments', 'mock-bank', paymentBody({ txn_ref: txnRef }));
    expect(second.status).toBe(200);
    expect(await count('select count(*)::text as n from machvon.billing_payment where provider_txn_ref = $1', [txnRef])).toBe(1);
  });
});

