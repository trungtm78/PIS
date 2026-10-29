import { randomBytes, randomUUID } from 'node:crypto';
import { AuditWriter, EffectiveAccessStore, InMemoryAuthzCache, PLATFORM_TENANT_ID, seedSystemRoles, sharedMockEInvoiceProvider } from '@machvon/db';
import { addDays, billingPeriod, loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';
import { BillingJob } from '../src/modules/sas/billing.job';
import { encodeCursor } from '../src/pagination';
import { CLAIMS_HEADER, TENANT_HEADER } from './isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from './isolation/test-app';
import type { RunningApp } from './isolation/test-app';
import { ProvisioningHarness } from './provisioning/provisioning-fixtures';

const SIGNING_KEY = randomBytes(32);
const OPERATOR = '00000000-0000-4000-8000-0000000000c9';
const ANCHOR = '2026-01-01';
const JANUARY = billingPeriod(ANCHOR, 'MONTHLY', 0);
const REASON = 'Issue the invoice of the period to the buyer.';

interface Reply {
  status: number;
  headers: Headers;
  json: Record<string, unknown>;
}

describe('the billing run and the e-invoice over HTTP (ST-SAS-011)', () => {
  const harness = new ProvisioningHarness();
  let app: RunningApp;
  let counter = 0;

  const admin = async <T extends object = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> => harness.admin(async (client) => (await client.query(text, params)).rows as T[]);

  async function call(method: string, path: string, options: { roles?: string[]; audience?: string; payload?: unknown; key?: string; ifMatch?: string } = {}): Promise<Reply> {
    const token = signTenantContext({ tenantId: PLATFORM_TENANT_ID, membershipId: OPERATOR, scopeVersion: 0 }, SIGNING_KEY);
    const headers: Record<string, string> = {
      [TENANT_HEADER]: token,
      [CLAIMS_HEADER]: JSON.stringify({ aud: options.audience ?? 'control', roles: options.roles ?? ['BillingOperator'] }),
      'content-type': 'application/json',
    };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${path}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.payload ?? {}) });
    return { status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> };
  }

  async function member(tenantId: string, membershipId: string, path: string): Promise<Reply> {
    const token = signTenantContext({ tenantId, membershipId, scopeVersion: 1 }, SIGNING_KEY);
    const response = await fetch(`${app.baseUrl}${path}`, { headers: { [TENANT_HEADER]: token, [CLAIMS_HEADER]: JSON.stringify({ aud: 'tenant' }) } });
    return { status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> };
  }

  async function plan(price: string): Promise<string> {
    counter += 1;
    const id = randomUUID();
    await admin(
      `insert into machvon.product_plan_version (id, plan_code, revision, name, status, billing_cycles, base_price_vnd, vat_category, legal_terms_ref)
       values ($1, $2, 1, $3, 'Draft', $4::text[], $5::numeric, 'VAT_10', 'TERMS-1')`,
      [id, `bill-${counter}`, `Plan ${counter}`, ['ANNUAL', 'MONTHLY'], price],
    );
    await admin("insert into machvon.plan_feature (id, plan_version_id, feature_code, limit_kind, limit_value, grace_behavior, expired_behavior) values (gen_random_uuid(), $1, 'member.seats', 'QUOTA', 50, 'READ_ONLY', 'DENY')", [id]);
    await admin("update machvon.product_plan_version set status = 'Published', published_by = $2, published_at = now() where id = $1", [id, OPERATOR]);
    return id;
  }

  /** An Active tenant whose first member holds BILLING_VIEWER, with a monthly subscription anchored on 1 January. */
  async function tenant(price = '1000000'): Promise<{ tenantId: string; viewer: string; subscriptionId: string }> {
    const created = await harness.request();
    const tenantId = created.tenantId;
    await harness.registry.transition(tenantId, 'Requested', 'Provisioning');
    await harness.registry.transition(tenantId, 'Provisioning', 'Active');
    counter += 1;
    const viewer = `00000000-0000-4000-8000-${(0xc000 + counter).toString(16).padStart(12, '0')}`;
    await harness.tenants.withTenant({ tenantId, membershipId: viewer, scopeVersion: 1 }, (tx) => seedSystemRoles(tx, OPERATOR));
    const owner = new Client({ connectionString: harness.database.urlFor('machvon_owner') });
    await owner.connect();
    try {
      await owner.query("select set_config('app.tenant_id', $1, false)", [tenantId]);
      const unitId = randomUUID();
      await owner.query("insert into machvon.organization_unit (tenant_id, id, code, name, valid_from, path, depth) values ($1, $2, 'U1', 'Unit 1', date '2026-01-01', '/u1/', 0)", [tenantId, unitId]);
      const userId = randomUUID();
      await owner.query("insert into machvon.user_account (id, idp_subject, email_normalized, display_name, status) values ($1, $2, $3, 'Member', 'Active')", [userId, `sub-${userId}`, `${userId}@example.test`]);
      await owner.query("insert into machvon.membership (tenant_id, id, user_id, organization_id, status, valid_from) values ($1, $2, $3, $4, 'Active', now())", [tenantId, viewer, userId, unitId]);
      const role = await owner.query<{ id: string }>("select id from machvon.role_definition where code = 'BILLING_VIEWER'");
      await owner.query(
        `insert into machvon.role_grant (tenant_id, id, membership_id, role_id, scope_json, effective_from, scope_kind, scope_ref_ids, status, granted_by, grant_reason)
         values ($1, $2, $3, $4, '{"kind":"TENANT","ref_ids":[]}'::jsonb, '2026-01-01T00:00:00Z', 'TENANT', '{}', 'Active', $5, 'test')`,
        [tenantId, randomUUID(), viewer, role.rows[0]?.id, OPERATOR],
      );
    } finally {
      await owner.end();
    }
    const subscription = await call('POST', `/system/tenants/${tenantId}/subscriptions`, {
      payload: { plan_version_id: await plan(price), cycle: 'MONTHLY', billing_anchor: ANCHOR, payment_terms: { due_days: 15, method: 'BANK_TRANSFER' } },
    });
    expect(subscription.status).toBe(201);
    return { tenantId, viewer, subscriptionId: subscription.json.resource_id as string };
  }

  const runBilling = (tenantIds: string[], options: { roles?: string[]; audience?: string; period?: { start: string; end: string } } = {}): Promise<Reply> =>
    call('POST', '/system/billing-runs', { ...options, payload: { period_start: (options.period ?? JANUARY).start, period_end: (options.period ?? JANUARY).end, tenant_ids: tenantIds } });
  const invoicesOf = async (tenantId: string): Promise<Array<Record<string, unknown>>> => ((await call('GET', `/system/tenants/${tenantId}/invoices`)).json.items as Array<Record<string, unknown>>) ?? [];
  const issue = (invoiceId: string, ifMatch: number, options: { roles?: string[]; audience?: string } = {}): Promise<Reply> => call('POST', `/system/invoices/${invoiceId}/issue`, { ...options, payload: { reason: REASON }, ifMatch: `"${ifMatch}"` });
  const countOriginals = async (tenantIds: string[]): Promise<number> =>
    Number((await admin<{ n: string }>("select count(*)::text as n from machvon.invoice where kind = 'ORIGINAL' and period_start = $1 and tenant_id = any($2::uuid[])", [JANUARY.start, tenantIds]))[0]?.n);
  const runJob = (tenantId: string, now: Date) =>
    harness.control.withTenantOf(tenantId, (tx) => new BillingJob(new AuditWriter(harness.tenants), sharedMockEInvoiceProvider()).run(tx, OPERATOR, now));

  beforeAll(async () => {
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
  }, 60_000);

  it('AC-ST-SAS-011-1 UAT-AC163: three subscriptions due and the billing run executed twice leave exactly three original invoices', async () => {
    const tenants = [await tenant(), await tenant(), await tenant()];
    const ids = tenants.map((entry) => entry.tenantId);
    const first = await runBilling(ids);
    expect(first.status).toBe(202);
    expect(first.json).toMatchObject({ status: 'BILLED' });
    expect(await countOriginals(ids)).toBe(3);
    const second = await runBilling(ids);
    expect(second.status).toBe(202);
    expect(await countOriginals(ids)).toBe(3);
    // The same key and the same body replay the stored answer; the run itself is idempotent by subscription and period.
    const invoices = await invoicesOf(ids[0] as string);
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ kind: 'ORIGINAL', status: 'Draft', period_start: JANUARY.start, period_end: JANUARY.end, subtotal_vnd: '1000000', vat_vnd: '100000', total_vnd: '1100000', actions: { issue: true } });
    const audits = await admin<{ n: string }>("select count(*)::text as n from machvon.audit_event where action = 'billing.run_started' and outcome = 'SUCCESS'");
    expect(Number(audits[0]?.n)).toBeGreaterThanOrEqual(2);
  });

  it('refuses a period that is backwards, has not begun, or is longer than a year with 422 BILLING_PERIOD_INVALID, and a tenant that does not exist with 404', async () => {
    const { tenantId } = await tenant();
    for (const period of [{ start: '2026-02-01', end: '2026-01-01' }, { start: addDays(new Date().toISOString().slice(0, 10), 5), end: addDays(new Date().toISOString().slice(0, 10), 30) }, { start: '2024-01-01', end: '2026-01-01' }]) {
      const reply = await runBilling([tenantId], { period });
      expect([reply.status, reply.json.code]).toEqual([422, 'BILLING_PERIOD_INVALID']);
    }
    expect((await runBilling([randomUUID()])).status).toBe(404);
    expect(await countOriginals([tenantId])).toBe(0);
  });

  it('AC-ST-SAS-011-2 UAT-AC164: issues a Draft once (Issued), refuses the second issue with 409 EINVOICE_STATE_INVALID, and the API has no operation that cancels an invoice', async () => {
    const { tenantId } = await tenant();
    await runBilling([tenantId]);
    const [draft] = await invoicesOf(tenantId);
    const stale = await issue(draft?.id as string, (draft?.version as number) + 7);
    expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
    const missing = await call('POST', `/system/invoices/${draft?.id}/issue`, { payload: { reason: REASON } });
    expect(missing.status).toBe(428);
    const first = await issue(draft?.id as string, draft?.version as number);
    expect(first.status).toBe(202);
    expect(first.json).toMatchObject({ status: 'ISSUED', resource_id: draft?.id });
    const [issued] = await invoicesOf(tenantId);
    expect(issued).toMatchObject({ status: 'Issued', actions: { issue: false }, einvoice: { provider: 'MOCK', template_code: '1', series: 'C26TMV' }, issue_attempts: 1 });
    const again = await issue(draft?.id as string, issued?.version as number);
    expect([again.status, again.json.code]).toEqual([409, 'EINVOICE_STATE_INVALID']);
    // The contract has no way to cancel an invoice, and neither has the database.
    const contract = (await import('../../../Design/MACHVON_Design/03_Engineering/openapi.json')) as unknown as { default: { paths: Record<string, Record<string, { operationId?: string }>> } };
    const cancelling = Object.entries(contract.default.paths).flatMap(([path, methods]) => Object.values(methods).flatMap((operation) => (/invoice/i.test(path + (operation.operationId ?? '')) && /cancel|void|delete/i.test(path + (operation.operationId ?? '')) ? [path] : [])));
    expect(cancelling).toEqual([]);
    const columns = await admin<{ n: string }>("select count(*)::text as n from information_schema.columns where table_schema = 'machvon' and table_name in ('invoice', 'invoice_line') and column_name ilike '%cancel%'");
    expect(columns[0]?.n).toBe('0');
  });

  it('AC-ST-SAS-011-3 UAT-AC166: a provider that answers 503 twice leaves one invoice at the provider after the retries, and the retries are the schedule of the job', async () => {
    const { tenantId } = await tenant();
    await runBilling([tenantId]);
    const [draft] = await invoicesOf(tenantId);
    const provider = sharedMockEInvoiceProvider();
    const before = provider.issuedCount;
    provider.failNext(2);
    const first = await issue(draft?.id as string, draft?.version as number);
    expect(first.status).toBe(202);
    expect(first.json).toMatchObject({ status: 'PENDING_ISSUE' });
    const [waiting] = await invoicesOf(tenantId);
    expect(waiting).toMatchObject({ status: 'PendingIssue', issue_attempts: 1, issue_error: 'EINVOICE_PROVIDER_UNAVAILABLE', actions: { issue: false } });
    expect(provider.issuedCount).toBe(before);
    // Ten minutes later the second attempt fails again; an hour after that the third succeeds.
    const firstAt = Date.parse(waiting?.next_attempt_at as string);
    const second = await runJob(tenantId, new Date(firstAt + 1000));
    expect(second).toMatchObject({ waiting: 1, issued: 0 });
    const third = await runJob(tenantId, new Date(firstAt + 2 * 3_600_000));
    expect(third).toMatchObject({ issued: 1, waiting: 0 });
    expect(provider.issuedCount).toBe(before + 1);
    // The job also made the Draft of the period that closed last, which the list shows first: the invoice of this test is found by its id.
    const done = (await invoicesOf(tenantId)).find((invoice) => invoice.id === draft?.id);
    // Issued by the third attempt, and in the same pass already past the due day of a period of January: the clock of the pass does the rest.
    expect(done).toMatchObject({ status: 'Overdue', issue_attempts: 3, einvoice: { provider: 'MOCK' } });
    // A pass that finds nothing waiting asks the provider nothing.
    const calls = provider.calls;
    await runJob(tenantId, new Date(firstAt + 3 * 3_600_000));
    expect(provider.calls).toBe(calls);
  });

  it('AC-ST-SAS-011-4 UAT-AC37: an overdue subscription is PastDue while the tenant and the license stay as they are, and a suspension is only proposed after thirty days', async () => {
    const { tenantId, subscriptionId } = await tenant();
    await runBilling([tenantId]);
    const [draft] = await invoicesOf(tenantId);
    await issue(draft?.id as string, draft?.version as number);
    // The due day is 15 days after the end of the period: the day after it, the invoice is late.
    const dueAt = (await invoicesOf(tenantId))[0]?.due_at as string;
    expect(dueAt).toBe(addDays(JANUARY.end, 15));
    const licensesBefore = await admin('select id, status from machvon.license_revision where tenant_id = $1 order by id', [tenantId]);
    const onTheDay = new Date(`${dueAt}T05:00:00Z`);
    expect((await runJob(tenantId, onTheDay)).overdue).toBe(0);
    const late = new Date(`${addDays(dueAt, 1)}T05:00:00Z`);
    expect(await runJob(tenantId, late)).toMatchObject({ overdue: 1, pastDue: 1, suspensionProposed: 0 });
    const state = await call('GET', `/system/tenants/${tenantId}/invoices`);
    expect(state.json).toMatchObject({ subscription_status: 'PastDue' });
    expect(state.json.past_due_since).toBe(late.toISOString());
    expect(state.json.suspension_proposed_at).toBeUndefined();
    const tenantRow = async (): Promise<string | undefined> => (await admin<{ status: string }>('select status from machvon.tenant where id = $1', [tenantId]))[0]?.status;
    expect(await tenantRow()).toBe('Active');
    // Thirty days past due the control plane is told, once; the tenant is still Active and the license unchanged.
    const proposal = new Date(late.getTime() + 30 * 86_400_000);
    expect(await runJob(tenantId, proposal)).toMatchObject({ suspensionProposed: 1 });
    expect(await runJob(tenantId, new Date(proposal.getTime() + 86_400_000))).toMatchObject({ suspensionProposed: 0 });
    const proposed = await call('GET', `/system/tenants/${tenantId}/invoices`);
    expect(proposed.json.suspension_proposed_at).toBe(proposal.toISOString());
    expect(await tenantRow()).toBe('Active');
    expect(await admin('select id, status from machvon.license_revision where tenant_id = $1 order by id', [tenantId])).toEqual(licensesBefore);
    expect((await admin<{ status: string }>('select status from machvon.subscription where id = $1', [subscriptionId]))[0]?.status).toBe('PastDue');
    expect((await admin<{ n: string }>("select count(*)::text as n from machvon.audit_event where action = 'billing.suspension_proposed' and resource_id = $1", [subscriptionId]))[0]?.n).toBe('1');
  });

  it('pages the invoices of a tenant, the latest period first, so that an older one stays within reach', async () => {
    const { tenantId } = await tenant();
    for (const month of ['2026-01', '2026-02', '2026-03']) {
      const [start, end] = month === '2026-02' ? ['2026-02-01', '2026-02-28'] : month === '2026-01' ? ['2026-01-01', '2026-01-31'] : ['2026-03-01', '2026-03-31'];
      expect((await runBilling([tenantId], { period: { start: start as string, end: end as string } })).status).toBe(202);
    }
    const first = await call('GET', `/system/tenants/${tenantId}/invoices?limit=2`);
    expect((first.json.items as Array<{ period_start: string }>).map((invoice) => invoice.period_start)).toEqual(['2026-03-01', '2026-02-01']);
    expect(typeof first.json.next_cursor).toBe('string');
    const second = await call('GET', `/system/tenants/${tenantId}/invoices?limit=2&cursor=${encodeURIComponent(first.json.next_cursor as string)}`);
    expect((second.json.items as Array<{ period_start: string }>).map((invoice) => invoice.period_start)).toEqual(['2026-01-01']);
    expect(second.json.next_cursor).toBeNull();
    expect((await call('GET', `/system/tenants/${tenantId}/invoices?limit=0`)).status).toBe(422);
    // A cursor that is well formed but is not a period of the list is refused, not a failure of the database.
    const stray = await call('GET', `/system/tenants/${tenantId}/invoices?cursor=${encodeURIComponent(encodeCursor({ code: 'not-a-date', id: randomUUID() }))}`);
    expect([stray.status, stray.json.code, stray.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'cursor']);
  });

  it('shows the invoice lines to the billing viewer of the tenant and to nobody of another tenant', async () => {
    const mine = await tenant();
    const other = await tenant();
    await runBilling([mine.tenantId, other.tenantId]);
    const lines = await member(mine.tenantId, mine.viewer, '/resources/invoice_line');
    expect(lines.status).toBe(200);
    const items = lines.json.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ line_no: 1, kind: 'SUBSCRIPTION', amount_vnd: '1000000', vat_category: 'VAT_10', vat_vnd: '100000' });
    expect((await member(mine.tenantId, mine.viewer, `/resources/invoice_line/${items[0]?.id}`)).status).toBe(200);
    const foreign = (await invoicesOf(other.tenantId))[0]?.lines as Array<{ id: string }>;
    expect((await member(mine.tenantId, mine.viewer, `/resources/invoice_line/${foreign[0]?.id}`)).status).toBe(404);
  });

  it('is for the control plane and for those who manage billing: a tenant member and an operator without the right are refused', async () => {
    const { tenantId, viewer } = await tenant();
    await runBilling([tenantId]);
    const [draft] = await invoicesOf(tenantId);
    expect((await runBilling([tenantId], { audience: 'tenant' })).status).toBe(403);
    expect((await runBilling([tenantId], { roles: ['Viewer'] })).status).toBe(403);
    expect((await issue(draft?.id as string, draft?.version as number, { roles: ['Viewer'] })).status).toBe(403);
    expect((await member(tenantId, viewer, `/system/tenants/${tenantId}/invoices`)).status).toBe(403);
    expect((await issue(randomUUID(), 1)).status).toBe(404);
  });
});
