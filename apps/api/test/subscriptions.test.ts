import { randomBytes, randomUUID } from 'node:crypto';
import { EffectiveAccessStore, InMemoryAuthzCache, PLATFORM_TENANT_ID, SubscriptionStore, seedSystemRoles } from '@machvon/db';
import { addDays, loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';
import { CONTROL_OPERATIONS, controlCasesFor } from './authz/control-matrix';
import { CLAIMS_HEADER, TENANT_HEADER } from './isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from './isolation/test-app';
import type { RunningApp } from './isolation/test-app';
import { ProvisioningHarness } from './provisioning/provisioning-fixtures';

const SIGNING_KEY = randomBytes(32);
const OPERATOR = '00000000-0000-4000-8000-0000000000c9';
const REASON = 'The customer asked for the larger plan.';
const DAY_MS = 86_400_000;

interface Reply {
  status: number;
  headers: Headers;
  json: Record<string, unknown>;
}

interface Preview {
  preview_hash: string;
  proration_vnd: string;
  quota_violations: Array<{ feature_code: string; used: string; new_limit: string }>;
  effective_at: string;
}

const todayUtc = (): string => new Date().toISOString().slice(0, 10);

describe('subscriptions over HTTP (ST-SAS-008)', () => {
  const harness = new ProvisioningHarness();
  const store = new SubscriptionStore();
  let app: RunningApp;
  let counter = 0;

  const admin = async <T extends object = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> => harness.admin(async (client) => (await client.query(text, params)).rows as T[]);

  async function call(
    method: string,
    path: string,
    options: { roles?: string[]; audience?: string; payload?: unknown; key?: string; ifMatch?: string } = {},
  ): Promise<Reply> {
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

  /** A plan with a seat quota and a switch, published (or left a draft). */
  async function plan(code: string, price: string, options: { seats?: number; cycles?: string[]; status?: 'Published' | 'Draft' } = {}): Promise<string> {
    counter += 1;
    const id = randomUUID();
    await admin(
      `insert into machvon.product_plan_version (id, plan_code, revision, name, status, billing_cycles, base_price_vnd, vat_category, legal_terms_ref)
       values ($1, $2, 1, $3, 'Draft', $4::text[], $5::numeric, 'NOT_SUBJECT', 'TERMS-1')`,
      [id, `${code}-${counter}`, code, options.cycles ?? ['ANNUAL', 'MONTHLY'], price],
    );
    await admin(
      `insert into machvon.plan_feature (id, plan_version_id, feature_code, limit_kind, limit_value, grace_behavior, expired_behavior) values
         (gen_random_uuid(), $1, 'reporting', 'BOOLEAN', null, 'ALLOW', 'READ_ONLY'),
         (gen_random_uuid(), $1, 'member.seats', 'QUOTA', $2::numeric, 'READ_ONLY', 'DENY')`,
      [id, options.seats ?? 50],
    );
    if (options.status !== 'Draft') await admin("update machvon.product_plan_version set status = 'Published', published_by = $2, published_at = now() where id = $1", [id, OPERATOR]);
    return id;
  }

  /** An Active tenant with `staff` Active staff members (the first holds BILLING_VIEWER) and nothing else. */
  async function tenant(staff = 0): Promise<{ tenantId: string; viewer: string }> {
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
      for (let n = 0; n < Math.max(staff, 1); n += 1) {
        const id = n === 0 ? viewer : randomUUID();
        const userId = randomUUID();
        await owner.query("insert into machvon.user_account (id, idp_subject, email_normalized, display_name, status) values ($1, $2, $3, 'Member', 'Active')", [userId, `sub-${userId}`, `${userId}@example.test`]);
        await owner.query("insert into machvon.membership (tenant_id, id, user_id, organization_id, status, valid_from) values ($1, $2, $3, $4, 'Active', now())", [tenantId, id, userId, unitId]);
        if (n > 0) continue;
        const role = await owner.query<{ id: string }>("select id from machvon.role_definition where code = 'BILLING_VIEWER'");
        await owner.query(
          `insert into machvon.role_grant (tenant_id, id, membership_id, role_id, scope_json, effective_from, scope_kind, scope_ref_ids, status, granted_by, grant_reason)
           values ($1, $2, $3, $4, '{"kind":"TENANT","ref_ids":[]}'::jsonb, '2026-01-01T00:00:00Z', 'TENANT', '{}', 'Active', $5, 'test')`,
          [tenantId, randomUUID(), id, role.rows[0]?.id, OPERATOR],
        );
      }
    } finally {
      await owner.end();
    }
    return { tenantId, viewer };
  }

  const createBody = (planVersionId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    plan_version_id: planVersionId,
    cycle: 'ANNUAL',
    billing_anchor: addDays(todayUtc(), -45),
    payment_terms: { due_days: 30, method: 'BANK_TRANSFER' },
    ...overrides,
  });
  const create = (tenantId: string, planVersionId: string, overrides: Record<string, unknown> = {}, options: { roles?: string[]; audience?: string; key?: string } = {}): Promise<Reply> =>
    call('POST', `/system/tenants/${tenantId}/subscriptions`, { ...options, payload: createBody(planVersionId, overrides) });
  const previewOf = (subscriptionId: string, target: string, effective = 'NOW', options: { roles?: string[]; audience?: string } = {}): Promise<Reply> =>
    call('POST', `/system/subscriptions/${subscriptionId}/plan-change-previews`, { ...options, payload: { target_plan_version_id: target, effective } });
  const change = (subscriptionId: string, target: string, effective: string, hash: string, options: { ifMatch?: string; roles?: string[]; audience?: string; key?: string; reason?: string } = {}): Promise<Reply> =>
    call('POST', `/system/subscriptions/${subscriptionId}/plan-change`, {
      ...options,
      payload: { target_plan_version_id: target, effective, preview_hash: hash, reason: options.reason ?? REASON },
      ...(options.ifMatch === undefined ? {} : { ifMatch: options.ifMatch }),
    });
  const cancel = (subscriptionId: string, options: { ifMatch?: string; roles?: string[]; audience?: string } = {}): Promise<Reply> =>
    call('POST', `/system/subscriptions/${subscriptionId}/cancel`, { ...options, payload: { reason: REASON }, ...(options.ifMatch === undefined ? {} : { ifMatch: options.ifMatch }) });
  const subscriptionOf = (tenantId: string): Promise<Reply> => call('GET', `/system/tenants/${tenantId}/subscription`);

  /** What a plan change is worth today, worked out independently of the code under test: whole VND, rounded down. */
  const expectedProration = (oldPrice: bigint, newPrice: bigint, periodStart: string, periodEnd: string): string => {
    const [start, end, today] = [Date.parse(periodStart), Date.parse(periodEnd), Date.parse(todayUtc())];
    const total = BigInt((end - start) / DAY_MS + 1);
    const remaining = total - BigInt(Math.round((today - start) / DAY_MS));
    return (((newPrice - oldPrice) * remaining) / total).toString();
  };

  const versions = async (tenantId: string): Promise<number> => Number((await admin<{ n: string }>('select count(*) as n from machvon.entitlement_version where tenant_id = $1', [tenantId]))[0]?.n);
  const rowOf = async (id: string): Promise<{ plan_version_id: string; status: string; version: string; pending_plan_version_id: string | null; cancel_at_period_end: boolean; current_period_start: string; current_period_end: string } | undefined> =>
    (
      await admin<{ plan_version_id: string; status: string; version: string; pending_plan_version_id: string | null; cancel_at_period_end: boolean; current_period_start: string; current_period_end: string }>(
        'select plan_version_id, status, version::text as version, pending_plan_version_id, cancel_at_period_end, current_period_start::text as current_period_start, current_period_end::text as current_period_end from machvon.subscription where id = $1',
        [id],
      )
    )[0];
  const auditRows = (action: string, id: string): Promise<Array<{ tenant_id: string; reason: string | null; safe_diff: Record<string, unknown> }>> =>
    admin("select tenant_id, reason, safe_diff from machvon.audit_event where action = $1 and resource_id = $2 and outcome = 'SUCCESS'", [action, id]);

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

  describe('createSubscription', () => {
    it('answers 201 with the subscription, its period counted from the anchor, and the entitlements of the plan recorded as a new version', async () => {
      const { tenantId } = await tenant();
      const planId = await plan('create', '365000000');
      const before = await versions(tenantId);
      const reply = await create(tenantId, planId, { procurement_contract_ref: 'HD-2026/001' });
      expect(reply.status).toBe(201);
      expect(reply.json).toMatchObject({ status: 'ACTIVE', resource_version: 1 });
      const row = await rowOf(reply.json.resource_id as string);
      expect(row).toMatchObject({ plan_version_id: planId, status: 'Active', version: '1', current_period_start: addDays(todayUtc(), -45) });
      expect(await versions(tenantId)).toBe(before + 1);
      const view = await subscriptionOf(tenantId);
      expect(view.json.subscription).toMatchObject({ id: reply.json.resource_id, cycle: 'ANNUAL', procurement_contract_ref: 'HD-2026/001', payment_terms: { due_days: 30, method: 'BANK_TRANSFER' } });
    });

    it('starts a trial when trial_days is above zero', async () => {
      const { tenantId } = await tenant();
      const reply = await create(tenantId, await plan('trial', '0'), { trial_days: 30, billing_anchor: todayUtc() });
      expect(reply.json).toMatchObject({ status: 'TRIALING' });
      expect(await rowOf(reply.json.resource_id as string)).toMatchObject({ status: 'Trialing' });
    });

    it('refuses a second live subscription with 409 SUBSCRIPTION_EXISTS and writes nothing more', async () => {
      const { tenantId } = await tenant();
      const planId = await plan('twice', '1');
      await create(tenantId, planId);
      const before = await versions(tenantId);
      const again = await create(tenantId, planId);
      expect([again.status, again.json.code]).toEqual([409, 'SUBSCRIPTION_EXISTS']);
      expect(await versions(tenantId)).toBe(before);
    });

    it('refuses a plan that is a draft (409 PLAN_NOT_PUBLISHED), one that does not exist, a cycle the plan does not sell, and a tenant that is not working', async () => {
      const { tenantId } = await tenant();
      const draft = await plan('draft', '1', { status: 'Draft' });
      const annualOnly = await plan('annual-only', '1', { cycles: ['ANNUAL'] });
      const refused = await create(tenantId, draft);
      expect([refused.status, refused.json.code]).toEqual([409, 'PLAN_NOT_PUBLISHED']);
      const unknown = await create(tenantId, randomUUID());
      expect([unknown.status, unknown.json.code, unknown.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'plan_version_id']);
      const cycle = await create(tenantId, annualOnly, { cycle: 'MONTHLY' });
      expect([cycle.status, cycle.json.code, cycle.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'cycle']);
      const suspended = await tenant();
      await admin("update machvon.tenant set status = 'Suspended', lifecycle_reason = 'NON_PAYMENT' where id = $1", [suspended.tenantId]);
      const state = await create(suspended.tenantId, annualOnly);
      expect([state.status, state.json.code]).toEqual([409, 'TENANT_STATE_INVALID']);
      const missing = await create(randomUUID(), annualOnly);
      expect([missing.status, missing.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
    });

    it.each([
      ['a trial longer than 90 days', { trial_days: 91 }, 422],
      ['a due time longer than 180 days', { payment_terms: { due_days: 181, method: 'BANK_TRANSFER' } }, 422],
      ['a payment method nobody offers', { payment_terms: { due_days: 30, method: 'CASH' } }, 422],
      ['a billing anchor that is not a date', { billing_anchor: 'tomorrow' }, 422],
      ['a member the contract does not have', { surprise: 1 }, 400],
    ])('refuses %s as a malformed request', async (_name, overrides, status) => {
      const { tenantId } = await tenant();
      const reply = await create(tenantId, await plan('malformed', '1'), overrides);
      expect(reply.status).toBe(status);
      expect(await rowOf(randomUUID())).toBeUndefined();
    });

    it('writes an audit row on the tenant of the subscription, and replays the answer of the same idempotency key', async () => {
      const { tenantId } = await tenant();
      const planId = await plan('audited', '1');
      const key = `create-${randomUUID()}`;
      const first = await create(tenantId, planId, {}, { key });
      const replayed = await create(tenantId, planId, {}, { key });
      expect(replayed.json).toEqual(first.json);
      const rows = await auditRows('subscription.created', first.json.resource_id as string);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ tenant_id: tenantId });
      expect(rows[0]?.safe_diff).toMatchObject({ plan_version_id: planId, cycle: 'ANNUAL', status: 'Active' });
    });
  });

  describe('previewPlanChange (UAT-AC155)', () => {
    it('charges the proration of an upgrade on day 46 of the period, in whole VND rounded down, and lists no quota violation', async () => {
      const { tenantId } = await tenant();
      const from = await plan('from', '365000000');
      const to = await plan('to', '730000000', { seats: 100 });
      const subscriptionId = (await create(tenantId, from)).json.resource_id as string;
      const reply = await previewOf(subscriptionId, to);
      expect(reply.status).toBe(200);
      const row = await rowOf(subscriptionId);
      expect(reply.json).toMatchObject({ proration_vnd: expectedProration(365000000n, 730000000n, row?.current_period_start ?? '', row?.current_period_end ?? ''), quota_violations: [] });
      expect(String(reply.json.preview_hash)).toMatch(/^[0-9a-f]{64}$/);
      expect(new Date(String(reply.json.effective_at)).toISOString()).toBe(`${todayUtc()}T00:00:00.000Z`);
      expect(await auditRows('subscription.plan_change_previewed', subscriptionId)).toHaveLength(1);
    });

    it('charges nothing for a change at the next cycle, and says it takes effect the day after the period ends', async () => {
      const { tenantId } = await tenant();
      const from = await plan('from-next', '100');
      const to = await plan('to-next', '200');
      const subscriptionId = (await create(tenantId, from)).json.resource_id as string;
      const reply = await previewOf(subscriptionId, to, 'NEXT_CYCLE');
      const row = await rowOf(subscriptionId);
      expect(reply.json.proration_vnd).toBe('0');
      expect(new Date(String(reply.json.effective_at)).toISOString()).toBe(`${addDays(row?.current_period_end ?? '', 1)}T00:00:00.000Z`);
    });

    it('lists the seats of the tenant that the smaller plan no longer holds (AC-ST-SAS-008-2)', async () => {
      const { tenantId } = await tenant(5);
      const big = await plan('big', '300', { seats: 50 });
      const small = await plan('small', '100', { seats: 3 });
      const subscriptionId = (await create(tenantId, big)).json.resource_id as string;
      const reply = (await previewOf(subscriptionId, small, 'NEXT_CYCLE')).json as unknown as Preview;
      expect(reply.quota_violations).toEqual([{ feature_code: 'member.seats', used: '5', new_limit: '3' }]);
      expect(reply.proration_vnd).toBe('0');
    });

    it('refuses a downgrade now (422 on effective), the plan it is on, a draft plan (409 PLAN_NOT_PUBLISHED), and a subscription nobody has (404)', async () => {
      const { tenantId } = await tenant();
      const dear = await plan('dear', '500');
      const cheap = await plan('cheap', '100');
      const draft = await plan('draft-target', '900', { status: 'Draft' });
      const subscriptionId = (await create(tenantId, dear)).json.resource_id as string;
      const downgrade = await previewOf(subscriptionId, cheap, 'NOW');
      expect([downgrade.status, downgrade.json.code, downgrade.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'effective']);
      const same = await previewOf(subscriptionId, dear, 'NEXT_CYCLE');
      expect([same.status, same.json.detail]).toEqual([422, 'target_plan_version_id']);
      const notPublished = await previewOf(subscriptionId, draft, 'NOW');
      expect([notPublished.status, notPublished.json.code]).toEqual([409, 'PLAN_NOT_PUBLISHED']);
      const missing = await previewOf(randomUUID(), cheap, 'NEXT_CYCLE');
      expect([missing.status, missing.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
    });

    it('changes nothing: no plan change row, no entitlement version, no version bump', async () => {
      const { tenantId } = await tenant();
      const from = await plan('quiet-from', '100');
      const to = await plan('quiet-to', '200');
      const subscriptionId = (await create(tenantId, from)).json.resource_id as string;
      const before = await versions(tenantId);
      await previewOf(subscriptionId, to);
      expect(await versions(tenantId)).toBe(before);
      expect(await rowOf(subscriptionId)).toMatchObject({ version: '1', plan_version_id: from });
      expect(((await subscriptionOf(tenantId)).json.changes as unknown[]).length).toBe(0);
    });
  });

  describe('changeSubscriptionPlan (UAT-AC155, UAT-AC156)', () => {
    it('applies an upgrade against its preview: 200, the plan moved, one more entitlement version, the proration kept (AC-ST-SAS-008-1)', async () => {
      const { tenantId } = await tenant();
      const from = await plan('apply-from', '365000000');
      const to = await plan('apply-to', '730000000', { seats: 100 });
      const subscriptionId = (await create(tenantId, from)).json.resource_id as string;
      const preview = (await previewOf(subscriptionId, to)).json as unknown as Preview;
      const before = await versions(tenantId);
      const reply = await change(subscriptionId, to, 'NOW', preview.preview_hash, { ifMatch: '"1"' });
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ status: 'CHANGED', resource_version: 2, resource_id: subscriptionId });
      expect(reply.headers.get('etag')).toBe('"2"');
      expect(await rowOf(subscriptionId)).toMatchObject({ plan_version_id: to, version: '2' });
      expect(await versions(tenantId)).toBe(before + 1);
      const view = (await subscriptionOf(tenantId)).json as { changes: Array<Record<string, unknown>>; plan: { id: string } };
      expect(view.plan.id).toBe(to);
      expect(view.changes[0]).toMatchObject({ from_plan_version_id: from, to_plan_version_id: to, effective: 'NOW', proration_vnd: preview.proration_vnd, reason: REASON });
      const audit = await auditRows('subscription.plan_changed', subscriptionId);
      expect(audit[0]).toMatchObject({ tenant_id: tenantId, reason: REASON });
    });

    it('answers 409 PREVIEW_STALE to a preview that no longer matches (an override changed the entitlements), then 200 on the preview made again (UAT-AC155)', async () => {
      const { tenantId } = await tenant();
      const from = await plan('stale-from', '100');
      const to = await plan('stale-to', '200');
      const subscriptionId = (await create(tenantId, from)).json.resource_id as string;
      const old = (await previewOf(subscriptionId, to)).json as unknown as Preview;
      await admin(
        `insert into machvon.entitlement_version (tenant_id, id, version_no, plan_version_id, features_json, entitlements_hash, cause, effective_from)
         values ($1, $2, (select coalesce(max(version_no), 0) + 1 from machvon.entitlement_version where tenant_id = $1), $3, '[]'::jsonb, repeat('e', 64), 'OVERRIDE', now())`,
        [tenantId, randomUUID(), from],
      );
      const stale = await change(subscriptionId, to, 'NOW', old.preview_hash, { ifMatch: '"1"' });
      expect([stale.status, stale.json.code]).toEqual([409, 'PREVIEW_STALE']);
      expect(await rowOf(subscriptionId)).toMatchObject({ plan_version_id: from, version: '1' });
      const fresh = (await previewOf(subscriptionId, to)).json as unknown as Preview;
      expect((await change(subscriptionId, to, 'NOW', fresh.preview_hash, { ifMatch: '"1"' })).status).toBe(200);
    });

    it('answers 428 without If-Match and 409 VERSION_CONFLICT with a stale one', async () => {
      const { tenantId } = await tenant();
      const from = await plan('match-from', '100');
      const to = await plan('match-to', '200');
      const subscriptionId = (await create(tenantId, from)).json.resource_id as string;
      const preview = (await previewOf(subscriptionId, to)).json as unknown as Preview;
      const missing = await change(subscriptionId, to, 'NOW', preview.preview_hash);
      expect([missing.status, missing.json.code]).toEqual([428, 'PRECONDITION_REQUIRED']);
      const stale = await change(subscriptionId, to, 'NOW', preview.preview_hash, { ifMatch: '"9"' });
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      expect(await rowOf(subscriptionId)).toMatchObject({ plan_version_id: from });
    });

    it('sets a downgrade at the next cycle, which the cycle job applies when the day comes; nobody is taken away and no seat is free afterwards (AC-ST-SAS-008-2, UAT-AC156)', async () => {
      const { tenantId, viewer } = await tenant(5);
      const big = await plan('cycle-big', '300', { seats: 50 });
      const small = await plan('cycle-small', '100', { seats: 3 });
      const subscriptionId = (await create(tenantId, big)).json.resource_id as string;
      const preview = (await previewOf(subscriptionId, small, 'NEXT_CYCLE')).json as unknown as Preview;
      expect(preview.quota_violations).toHaveLength(1);
      const applied = await change(subscriptionId, small, 'NEXT_CYCLE', preview.preview_hash, { ifMatch: '"1"' });
      expect(applied.json).toMatchObject({ status: 'CHANGE_SCHEDULED', resource_version: 2 });
      expect(await rowOf(subscriptionId)).toMatchObject({ plan_version_id: big, pending_plan_version_id: small });
      const view = (await subscriptionOf(tenantId)).json as { pending_plan: { id: string }; subscription: { pending_plan_version_id: string } };
      expect([view.pending_plan.id, view.subscription.pending_plan_version_id]).toEqual([small, small]);
      // The day comes: the cycle job of the tenant applies it.
      const row = await rowOf(subscriptionId);
      const outcome = await harness.control.withTenantOf(tenantId, (tx) => store.runCycle(tx, new Date(`${addDays(row?.current_period_end ?? '', 1)}T00:00:01Z`)));
      expect(outcome).toMatchObject({ plansApplied: 1, periodsRolled: 1 });
      expect(await rowOf(subscriptionId)).toMatchObject({ plan_version_id: small, pending_plan_version_id: null });
      const usage = await member(tenantId, viewer, '/me/usage');
      expect(usage.json.seats).toEqual({ used: 5, limit: 3 });
      expect(Number((await admin<{ n: string }>("select count(*) as n from machvon.membership where tenant_id = $1 and status = 'Active'", [tenantId]))[0]?.n)).toBe(5);
    });

    it('refuses what the control plane alone may do to a tenant token, and to a role that does not manage billing', async () => {
      const { tenantId } = await tenant();
      const from = await plan('role-from', '100');
      const to = await plan('role-to', '200');
      const subscriptionId = (await create(tenantId, from)).json.resource_id as string;
      const preview = (await previewOf(subscriptionId, to)).json as unknown as Preview;
      const asTenant = await change(subscriptionId, to, 'NOW', preview.preview_hash, { ifMatch: '"1"', audience: 'tenant', roles: ['TENANT_ADMIN', 'SystemAdmin'] });
      expect([asTenant.status, asTenant.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const asOperator = await change(subscriptionId, to, 'NOW', preview.preview_hash, { ifMatch: '"1"', roles: ['PlatformOperator'] });
      expect([asOperator.status, asOperator.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect(await rowOf(subscriptionId)).toMatchObject({ plan_version_id: from, version: '1' });
    });
  });

  describe('cancelSubscription', () => {
    it('ends a trial at once', async () => {
      const { tenantId } = await tenant();
      const subscriptionId = (await create(tenantId, await plan('cancel-trial', '0'), { trial_days: 30, billing_anchor: todayUtc() })).json.resource_id as string;
      const reply = await cancel(subscriptionId, { ifMatch: '"1"' });
      expect(reply.json).toMatchObject({ status: 'CANCELLED', resource_version: 2 });
      expect(await rowOf(subscriptionId)).toMatchObject({ status: 'Cancelled' });
      expect((await subscriptionOf(tenantId)).json.subscription).toBeUndefined();
    });

    it('lets a paid subscription run to the end of its period, and refuses to cancel it twice (409 SUBSCRIPTION_STATE_INVALID)', async () => {
      const { tenantId } = await tenant();
      const subscriptionId = (await create(tenantId, await plan('cancel-active', '1'))).json.resource_id as string;
      const reply = await cancel(subscriptionId, { ifMatch: '"1"' });
      expect(reply.json).toMatchObject({ status: 'CANCEL_AT_PERIOD_END', resource_version: 2 });
      expect(await rowOf(subscriptionId)).toMatchObject({ status: 'Active', cancel_at_period_end: true });
      const again = await cancel(subscriptionId, { ifMatch: '"2"' });
      expect([again.status, again.json.code]).toEqual([409, 'SUBSCRIPTION_STATE_INVALID']);
      const audit = await auditRows('subscription.cancelled', subscriptionId);
      expect(audit[0]).toMatchObject({ tenant_id: tenantId, reason: REASON });
    });

    it('answers 428 without If-Match, 409 VERSION_CONFLICT with a stale one, and 404 for a subscription nobody has', async () => {
      const { tenantId } = await tenant();
      const subscriptionId = (await create(tenantId, await plan('cancel-errors', '1'))).json.resource_id as string;
      expect((await cancel(subscriptionId)).status).toBe(428);
      const stale = await cancel(subscriptionId, { ifMatch: '"7"' });
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const missing = await cancel(randomUUID(), { ifMatch: '"1"' });
      expect([missing.status, missing.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
    });
  });

  describe('getTenantSubscription', () => {
    it('shows no subscription for a tenant that has none, with an empty history', async () => {
      const { tenantId } = await tenant();
      const reply = await subscriptionOf(tenantId);
      expect([reply.status, reply.json]).toEqual([200, { changes: [] }]);
    });

    it('shows the live subscription with the plan it is on, the plan that waits, and the latest changes first', async () => {
      const { tenantId } = await tenant();
      const first = await plan('view-first', '100', { seats: 10 });
      const second = await plan('view-second', '200', { seats: 20 });
      const third = await plan('view-third', '150', { seats: 15 });
      const subscriptionId = (await create(tenantId, first)).json.resource_id as string;
      const up = (await previewOf(subscriptionId, second)).json as unknown as Preview;
      await change(subscriptionId, second, 'NOW', up.preview_hash, { ifMatch: '"1"' });
      const down = (await previewOf(subscriptionId, third, 'NEXT_CYCLE')).json as unknown as Preview;
      await change(subscriptionId, third, 'NEXT_CYCLE', down.preview_hash, { ifMatch: '"2"' });
      const view = (await subscriptionOf(tenantId)).json as {
        subscription: { plan_version_id: string; pending_plan_version_id: string; version: number };
        plan: { plan_code: string; base_price_vnd: string };
        pending_plan: { base_price_vnd: string };
        changes: Array<{ effective: string }>;
      };
      expect(view.subscription).toMatchObject({ plan_version_id: second, pending_plan_version_id: third, version: 3 });
      expect(view.plan).toMatchObject({ base_price_vnd: '200' });
      expect(view.pending_plan.base_price_vnd).toBe('150');
      expect(view.changes.map((entry) => entry.effective)).toEqual(['NEXT_CYCLE', 'NOW']);
    });

    it('answers 404 for a tenant that does not exist and refuses a tenant token and a support operator', async () => {
      const { tenantId } = await tenant();
      const missing = await subscriptionOf(randomUUID());
      expect([missing.status, missing.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      const asTenant = await call('GET', `/system/tenants/${tenantId}/subscription`, { audience: 'tenant', roles: ['SystemAdmin'] });
      expect(asTenant.status).toBe(403);
      const asSupport = await call('GET', `/system/tenants/${tenantId}/subscription`, { roles: ['SupportOperator'] });
      expect(asSupport.status).toBe(403);
    });
  });

  describe('the subscriptions of the tenant (get_resources_subscription)', () => {
    it('lists and reads the subscriptions of the tenant for the billing viewer, and answers 404 for one of another tenant', async () => {
      const a = await tenant();
      const b = await tenant();
      const planId = await plan('reads', '100');
      const mine = (await create(a.tenantId, planId)).json.resource_id as string;
      const theirs = (await create(b.tenantId, planId)).json.resource_id as string;
      const list = await member(a.tenantId, a.viewer, '/resources/subscription');
      expect(list.status).toBe(200);
      expect((list.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([mine]);
      const one = await member(a.tenantId, a.viewer, `/resources/subscription/${mine}`);
      expect([one.status, one.json.id, one.json.cycle]).toEqual([200, mine, 'ANNUAL']);
      const foreign = await member(a.tenantId, a.viewer, `/resources/subscription/${theirs}`);
      expect([foreign.status, foreign.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
    });
  });

  describe('generated matrix: every subscription operation against every realm role', () => {
    const operations = CONTROL_OPERATIONS.filter((operation) => operation.path.includes('ubscription'));
    const cases = controlCasesFor(operations);

    it('lists the five subscription operations of the registry', () => {
      expect(operations.map((operation) => operation.operationId).sort()).toEqual(['cancelSubscription', 'changeSubscriptionPlan', 'createSubscription', 'getTenantSubscription', 'previewPlanChange']);
    });

    it.each(cases.map((matrixCase) => [matrixCase.id, matrixCase] as const))('%s', async (_id, matrixCase) => {
      const operation = operations.find((candidate) => candidate.operationId === matrixCase.operationId);
      if (operation === undefined) throw new Error('operation of the case is not listed');
      const { tenantId } = await tenant();
      const from = await plan('matrix-from', '100');
      const to = await plan('matrix-to', '200');
      const subscriptionId = operation.operationId === 'createSubscription' ? undefined : ((await create(tenantId, from)).json.resource_id as string);
      const roles = [matrixCase.role];
      const reply =
        operation.operationId === 'createSubscription'
          ? await create(tenantId, from, {}, { roles })
          : operation.operationId === 'getTenantSubscription'
            ? await call('GET', `/system/tenants/${tenantId}/subscription`, { roles })
            : operation.operationId === 'previewPlanChange'
              ? await previewOf(subscriptionId ?? '', to, 'NOW', { roles })
              : operation.operationId === 'changeSubscriptionPlan'
                ? await change(subscriptionId ?? '', to, 'NOW', 'a'.repeat(64), { ifMatch: '"1"', roles })
                : await cancel(subscriptionId ?? '', { ifMatch: '"1"', roles });
      if (matrixCase.expected === 'allow') {
        // Allowed by the guard: whatever the command then says, it is not the refusal of the plane or the permission.
        expect(reply.json.code).not.toBe('SCOPE_DENIED');
        return;
      }
      expect([reply.status, reply.json.code]).toEqual([403, 'SCOPE_DENIED']);
      if (subscriptionId !== undefined) expect(await rowOf(subscriptionId)).toMatchObject({ plan_version_id: from, version: '1', status: 'Active' });
    });
  });
});
