import { randomBytes, randomUUID } from 'node:crypto';
import { EffectiveAccessStore, InMemoryAuthzCache, PLATFORM_TENANT_ID, seedSystemRoles } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';
import { CLAIMS_HEADER, TENANT_HEADER } from './isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from './isolation/test-app';
import type { RunningApp } from './isolation/test-app';
import { ProvisioningHarness } from './provisioning/provisioning-fixtures';

const SIGNING_KEY = randomBytes(32);
const ACTOR = '00000000-0000-4000-8000-0000000000c9';
const PLAN = '00000000-0000-4000-9000-000000000001';

interface Reply {
  status: number;
  headers: Headers;
  json: Record<string, unknown>;
}

interface Members {
  tenantId: string;
  service: string;
  serviceWithoutRole: string;
  billing: string;
  owner: string;
  plain: string;
}

interface UsageMeterView {
  counter: string;
  unit: string;
  used: string;
  limit?: string;
}

describe('usage metering over HTTP (ST-SAS-010)', () => {
  const harness = new ProvisioningHarness();
  let app: RunningApp;
  let counter = 0;

  const admin = async <T extends object = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> => harness.admin(async (client) => (await client.query(text, params)).rows as T[]);

  async function send(tenantId: string, membershipId: string, audience: string, method: string, path: string, options: { payload?: unknown; key?: string } = {}): Promise<Reply> {
    const token = signTenantContext({ tenantId, membershipId, scopeVersion: 1 }, SIGNING_KEY);
    const headers: Record<string, string> = { [TENANT_HEADER]: token, [CLAIMS_HEADER]: JSON.stringify({ aud: audience }), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    const response = await fetch(`${app.baseUrl}${path}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.payload ?? {}) });
    return { status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> };
  }

  async function control(tenantId: string, method: string, path: string, roles: string[] = ['SystemAdmin'], audience = 'control'): Promise<Reply> {
    const token = signTenantContext({ tenantId: PLATFORM_TENANT_ID, membershipId: ACTOR, scopeVersion: 0 }, SIGNING_KEY);
    const response = await fetch(`${app.baseUrl}${path.replace('{tenantId}', tenantId)}`, { method, headers: { [TENANT_HEADER]: token, [CLAIMS_HEADER]: JSON.stringify({ aud: audience, roles }) } });
    return { status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> };
  }

  /** An Active tenant with: a service account that may meter (a role of its own holding `internal.usage.write`), one that holds nothing, a billing viewer, an owner and a plain member. */
  async function tenant(): Promise<Members> {
    counter += 1;
    const created = await harness.request();
    const tenantId = created.tenantId;
    await harness.registry.transition(tenantId, 'Requested', 'Provisioning');
    await harness.registry.transition(tenantId, 'Provisioning', 'Active');
    const ids = Array.from({ length: 5 }, (_value, n) => `00000000-0000-4000-8000-${(0xb000 + counter * 16 + n).toString(16).padStart(12, '0')}`);
    const [service, serviceWithoutRole, billing, owner, plain] = ids as [string, string, string, string, string];
    await harness.tenants.withTenant({ tenantId, membershipId: owner, scopeVersion: 1 }, (tx) => seedSystemRoles(tx, ACTOR));
    const client = new Client({ connectionString: harness.database.urlFor('machvon_owner') });
    await client.connect();
    try {
      await client.query("select set_config('app.tenant_id', $1, false)", [tenantId]);
      const unitId = randomUUID();
      await client.query("insert into machvon.organization_unit (tenant_id, id, code, name, valid_from, path, depth) values ($1, $2, 'U1', 'Unit 1', date '2026-01-01', '/u1/', 0)", [tenantId, unitId]);
      const serviceRole = randomUUID();
      await client.query(
        "insert into machvon.role_definition (tenant_id, id, code, name, permissions, rank, is_system, guest_allowed, status, created_by) values ($1, $2, 'USAGE_WRITER', 'Usage writer', $3, 15, false, false, 'Active', $4)",
        [tenantId, serviceRole, ['internal.usage.write'], ACTOR],
      );
      const roleOf = async (code: string): Promise<string> => (await client.query<{ id: string }>('select id from machvon.role_definition where code = $1', [code])).rows[0]?.id ?? '';
      const members: Array<[string, string, string | undefined]> = [
        [service, 'SERVICE_ACCOUNT', serviceRole],
        [serviceWithoutRole, 'SERVICE_ACCOUNT', undefined],
        [billing, 'STAFF', await roleOf('BILLING_VIEWER')],
        [owner, 'STAFF', await roleOf('TENANT_OWNER')],
        [plain, 'STAFF', await roleOf('MEMBER')],
      ];
      for (const [id, type, role] of members) {
        const userId = randomUUID();
        await client.query("insert into machvon.user_account (id, idp_subject, email_normalized, display_name, status) values ($1, $2, $3, 'Member', 'Active')", [userId, `sub-${userId}`, `${userId}@example.test`]);
        await client.query("insert into machvon.membership (tenant_id, id, user_id, organization_id, status, valid_from, membership_type) values ($1, $2, $3, $4, 'Active', now(), $5)", [tenantId, id, userId, unitId, type]);
        if (role === undefined) continue;
        await client.query(
          `insert into machvon.role_grant (tenant_id, id, membership_id, role_id, scope_json, effective_from, scope_kind, scope_ref_ids, status, granted_by, grant_reason)
           values ($1, $2, $3, $4, '{"kind":"TENANT","ref_ids":[]}'::jsonb, '2026-01-01T00:00:00Z', 'TENANT', '{}', 'Active', $5, 'test')`,
          [tenantId, randomUUID(), id, role, ACTOR],
        );
      }
    } finally {
      await client.end();
    }
    return { tenantId, service, serviceWithoutRole, billing, owner, plain };
  }

  const eventBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
    counter += 1;
    return { meter: 'notification.zns', external_event_key: `da-${counter}`, quantity: '1', occurred_at: new Date().toISOString(), source_reference: 'campaign:42', ...overrides };
  };
  const record = (m: Members, body: Record<string, unknown>, options: { key?: string; as?: string; audience?: string } = {}): Promise<Reply> =>
    send(m.tenantId, options.as ?? m.service, options.audience ?? 'internal', 'POST', '/internal/usage-events', { payload: body, ...(options.key === undefined ? {} : { key: options.key }) });
  const usage = (m: Members, member = m.billing): Promise<Reply> => send(m.tenantId, member, 'tenant', 'GET', '/me/usage');
  const meterOf = (reply: Reply, name: string): UsageMeterView | undefined => (reply.json.meters as UsageMeterView[]).find((entry) => entry.counter === name);

  const eventCount = async (tenantId: string, meter: string, key: string): Promise<number> =>
    Number((await admin<{ n: string }>('select count(*) as n from machvon.usage_meter_event where tenant_id = $1 and meter = $2 and external_event_key = $3', [tenantId, meter, key]))[0]?.n);
  const counterOf = async (tenantId: string, feature: string): Promise<string | undefined> =>
    (await admin<{ used: string }>('select trim_scale(used_value)::text as used from machvon.usage_counter where tenant_id = $1 and feature_code = $2 order by window_start desc limit 1', [tenantId, feature]))[0]?.used;

  async function entitle(tenantId: string, features: unknown[], override?: { feature: string; limit: number }): Promise<void> {
    const [{ next } = { next: '1' }] = await admin<{ next: string }>('select (coalesce(max(version_no), 0) + 1)::text as next from machvon.entitlement_version where tenant_id = $1', [tenantId]);
    await harness.admin((client) =>
      client.query(
        `insert into machvon.entitlement_version (tenant_id, id, version_no, plan_version_id, features_json, entitlements_hash, cause, effective_from)
         values ($1, $2, $3, $4, $5::jsonb, $6, 'SUBSCRIPTION_CHANGE', now())`,
        [tenantId, randomUUID(), Number(next), PLAN, JSON.stringify(features), next.padStart(64, '0')],
      ),
    );
    if (override === undefined) return;
    await harness.admin((client) =>
      client.query(
        `insert into machvon.entitlement_override (tenant_id, id, feature_code, enabled, limit_value, reason, valid_from, valid_until, status, requested_by, approved_by)
         values ($1, $2, $3, true, $4, 'a reason of ten letters', now() - interval '1 hour', now() + interval '1 day', 'Active', $5, $6)`,
        [tenantId, randomUUID(), override.feature, override.limit, ACTOR, randomUUID()],
      ),
    );
  }

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

  describe('recordUsageEvent (UAT-AC168)', () => {
    it('answers 201 for the event that was recorded and says what it is', async () => {
      const m = await tenant();
      const body = eventBody({ external_event_key: 'first-event', quantity: '100' });
      const reply = await record(m, body);
      expect(reply.status).toBe(201);
      expect(reply.json).toMatchObject({ status: 'RECORDED', resource_version: 1 });
      const [row] = await admin<{ meter: string; quantity: string; unit: string; source_reference: string }>(
        'select meter, trim_scale(quantity)::text as quantity, unit, source_reference from machvon.usage_meter_event where id = $1',
        [reply.json.resource_id],
      );
      expect(row).toEqual({ meter: 'notification.zns', quantity: '100', unit: 'message', source_reference: 'campaign:42' });
      expect(await counterOf(m.tenantId, 'notification.messages')).toBe('100');
    });

    it('records the same external_event_key once: 200 with the id of the first event, the counter 101 and not 102, one row (AC-ST-SAS-010-1)', async () => {
      const m = await tenant();
      expect((await record(m, eventBody({ external_event_key: 'seed', quantity: '100' }))).status).toBe(201);
      const first = await record(m, eventBody({ external_event_key: 'da-1001', quantity: '1' }), { key: 'k-168-1-aaaaaaaa' });
      const again = await record(m, eventBody({ external_event_key: 'da-1001', quantity: '1' }), { key: 'k-168-2-bbbbbbbb' });
      expect([first.status, again.status]).toEqual([201, 200]);
      expect(again.json).toMatchObject({ status: 'DEDUPLICATED', resource_id: first.json.resource_id });
      expect(await eventCount(m.tenantId, 'notification.zns', 'da-1001')).toBe(1);
      expect(await counterOf(m.tenantId, 'notification.messages')).toBe('101');
      expect(meterOf(await usage(m), 'notification.messages')?.used).toBe('101');
    });

    it('replays the answer of the same idempotency key without touching the counter', async () => {
      const m = await tenant();
      const body = eventBody({ quantity: '5' });
      const first = await record(m, body, { key: 'idempotent-key-0001' });
      const replayed = await record(m, body, { key: 'idempotent-key-0001' });
      expect(replayed.headers.get('x-idempotent-replayed') ?? replayed.headers.get('idempotency-replayed')).not.toBeNull();
      expect(replayed.json).toEqual(first.json);
      expect(await counterOf(m.tenantId, 'notification.messages')).toBe('5');
    });

    it('keeps one event and one count when the same key is sent by many at once', async () => {
      const m = await tenant();
      const body = eventBody({ external_event_key: 'racing', quantity: '2' });
      const replies = await Promise.all(Array.from({ length: 6 }, () => record(m, body)));
      expect(replies.map((reply) => reply.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
      expect(new Set(replies.map((reply) => reply.json.resource_id)).size).toBe(1);
      expect(await eventCount(m.tenantId, 'notification.zns', 'racing')).toBe(1);
      expect(await counterOf(m.tenantId, 'notification.messages')).toBe('2');
    });

    it('takes a correction away from the counter, and refuses one the counter cannot bear', async () => {
      const m = await tenant();
      await record(m, eventBody({ meter: 'notification.sms', quantity: '10' }));
      const fixed = await record(m, eventBody({ meter: 'notification.sms_correction', quantity: '4' }));
      expect(fixed.status).toBe(201);
      expect(await counterOf(m.tenantId, 'notification.messages')).toBe('6');
      const refused = await record(m, eventBody({ meter: 'notification.sms_correction', quantity: '7' }));
      expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'quantity']);
      expect(await counterOf(m.tenantId, 'notification.messages')).toBe('6');
    });

    it('refuses a meter nobody knows with 422 METER_UNKNOWN, and writes nothing', async () => {
      const m = await tenant();
      const reply = await record(m, eventBody({ meter: 'notification.pigeon', external_event_key: 'unknown-meter' }));
      expect([reply.status, reply.json.code, reply.json.detail]).toEqual([422, 'METER_UNKNOWN', 'meter']);
      expect(await eventCount(m.tenantId, 'notification.pigeon', 'unknown-meter')).toBe(0);
    });

    it.each([
      ['a quantity with a sign', { quantity: '-1' }, 422, 'VALIDATION_FAILED'],
      ['a quantity of zero', { quantity: '0' }, 422, 'VALIDATION_FAILED'],
      ['an event from the future', { occurred_at: '2999-01-01T00:00:00Z' }, 422, 'VALIDATION_FAILED'],
      ['a unit that is not the unit of the meter', { unit: 'token' }, 422, 'VALIDATION_FAILED'],
      ['a key that is too long', { external_event_key: 'k'.repeat(201) }, 422, 'VALIDATION_FAILED'],
      ['a member the contract does not have', { surprise: true }, 400, 'FIELD_NOT_ALLOWED'],
    ])('refuses %s', async (_name, overrides, status, code) => {
      const m = await tenant();
      const reply = await record(m, eventBody(overrides));
      expect([reply.status, reply.json.code]).toEqual([status, code]);
    });

    it('leaves an audit row for the event and one for a repeat, with the meter and no personal data', async () => {
      const m = await tenant();
      const body = eventBody({ external_event_key: 'audited', quantity: '3' });
      const first = await record(m, body);
      await record(m, body);
      const rows = await admin<{ action: string; safe_diff: Record<string, unknown> }>("select action, safe_diff from machvon.audit_event where tenant_id = $1 and resource_id = $2 and outcome = 'SUCCESS' order by occurred_at", [m.tenantId, first.json.resource_id]);
      expect(rows.map((row) => row.action)).toEqual(['usage.event_recorded', 'usage.event_deduplicated']);
      expect(rows[0]?.safe_diff).toEqual({ meter: 'notification.zns', counter: 'notification.messages', quantity: '3' });
      expect(rows[1]?.safe_diff).toEqual({ meter: 'notification.zns', counter: 'notification.messages' });
    });

    it('is the internal plane: a tenant token is refused whatever it holds, and so is a service account that holds nothing', async () => {
      const m = await tenant();
      const asOwner = await record(m, eventBody(), { as: m.owner, audience: 'tenant' });
      expect([asOwner.status, asOwner.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const asPlain = await record(m, eventBody(), { as: m.plain, audience: 'tenant' });
      expect(asPlain.status).toBe(403);
      const asEmpty = await record(m, eventBody(), { as: m.serviceWithoutRole });
      expect([asEmpty.status, asEmpty.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const asControl = await send(m.tenantId, m.service, 'control', 'POST', '/internal/usage-events', { payload: eventBody() });
      expect(asControl.status).toBe(403);
      expect(await counterOf(m.tenantId, 'notification.messages')).toBeUndefined();
    });

    it('writes to the tenant of the token, and no other', async () => {
      const a = await tenant();
      const b = await tenant();
      await record(a, eventBody({ external_event_key: 'shared-key', quantity: '4' }));
      await record(b, eventBody({ external_event_key: 'shared-key', quantity: '9' }));
      expect([await counterOf(a.tenantId, 'notification.messages'), await counterOf(b.tenantId, 'notification.messages')]).toEqual(['4', '9']);
    });
  });

  describe('getMyUsage (SAS-11)', () => {
    it('shows every counter of the month, 0 where nothing was counted, with the unit', async () => {
      const m = await tenant();
      const reply = await usage(m);
      expect(reply.status).toBe(200);
      expect((reply.json.meters as UsageMeterView[]).map((entry) => [entry.counter, entry.unit, entry.used])).toEqual([
        ['notification.messages', 'message', '0'],
        ['ai.tokens', 'token', '0'],
        ['storage.gb_day', 'gb_day', '0'],
        ['bi.queries', 'query', '0'],
      ]);
      const start = new Date(reply.json.window_start as string);
      expect([start.getUTCDate(), start.getUTCHours()]).toEqual([1, 0]);
      expect(new Date(reply.json.window_end as string).getTime()).toBeGreaterThan(Date.now());
      expect(reply.json.recent_events).toBeUndefined();
    });

    it('counts the events of this month, and not those of the months before', async () => {
      const m = await tenant();
      await record(m, eventBody({ meter: 'ai.tokens', quantity: '500' }));
      await record(m, eventBody({ meter: 'ai.tokens', quantity: '250.5' }));
      await record(m, eventBody({ meter: 'ai.tokens', quantity: '9000', occurred_at: '2020-01-15T00:00:00Z' }));
      expect(meterOf(await usage(m), 'ai.tokens')?.used).toBe('750.5');
    });

    it('holds a counter against the plan: the limit of a metered feature, replaced by an override in force, and none for a switch', async () => {
      const m = await tenant();
      await entitle(m.tenantId, [
        { featureCode: 'notification.campaign', limitKind: 'METERED', limitValue: 1000, graceBehavior: 'DENY', expiredBehavior: 'DENY' },
        { featureCode: 'ai.analysis', limitKind: 'BOOLEAN', limitValue: 0, graceBehavior: 'DENY', expiredBehavior: 'DENY' },
      ]);
      const plan = await usage(m);
      expect(meterOf(plan, 'notification.messages')?.limit).toBe('1000');
      expect(meterOf(plan, 'ai.tokens')?.limit).toBeUndefined();
      expect(meterOf(plan, 'bi.queries')?.limit).toBeUndefined();
      await entitle(m.tenantId, [{ featureCode: 'notification.campaign', limitKind: 'METERED', limitValue: 1000, graceBehavior: 'DENY', expiredBehavior: 'DENY' }], { feature: 'notification.campaign', limit: 5000 });
      expect(meterOf(await usage(m), 'notification.messages')?.limit).toBe('5000');
    });

    it('shows the seats against the lower of the licence and the plan, and counts a service account as no seat (AC-ST-SAS-010-2)', async () => {
      const m = await tenant();
      const before = await usage(m);
      expect(before.json.seats).toEqual({ used: 3 });
      expect(before.json.guest_seats).toEqual({ used: 0 });
      await entitle(m.tenantId, [{ featureCode: 'member.seats', limitKind: 'QUOTA', limitValue: 2, graceBehavior: 'READ_ONLY', expiredBehavior: 'DENY' }]);
      expect((await usage(m)).json.seats).toEqual({ used: 3, limit: 2 });
    });

    it('is for a member who may read the subscription: the billing viewer and the owner, not a plain member', async () => {
      const m = await tenant();
      expect((await usage(m, m.billing)).status).toBe(200);
      expect((await usage(m, m.owner)).status).toBe(200);
      const plain = await usage(m, m.plain);
      expect([plain.status, plain.json.code]).toEqual([403, 'SCOPE_DENIED']);
    });

    it("shows a tenant its own counters only", async () => {
      const a = await tenant();
      const b = await tenant();
      await record(a, eventBody({ meter: 'bi.query', quantity: '11' }));
      expect(meterOf(await usage(a), 'bi.queries')?.used).toBe('11');
      expect(meterOf(await usage(b), 'bi.queries')?.used).toBe('0');
    });
  });

  describe('get_resources_usage_meter_event', () => {
    it('lists the events of the tenant, the latest to happen first, for the owner, and reads one by id', async () => {
      const m = await tenant();
      await record(m, eventBody({ external_event_key: 'old', occurred_at: '2026-01-02T00:00:00Z' }));
      const newest = await record(m, eventBody({ external_event_key: 'new', occurred_at: '2026-01-03T00:00:00Z' }));
      const list = await send(m.tenantId, m.owner, 'tenant', 'GET', '/resources/usage_meter_event?limit=10');
      expect(list.status).toBe(200);
      const items = list.json.items as Array<Record<string, unknown>>;
      expect(items.map((item) => item.external_event_key)).toEqual(['new', 'old']);
      expect(items[0]).toMatchObject({ id: newest.json.resource_id, meter: 'notification.zns', quantity: '1', unit: 'message', source_reference: 'campaign:42' });
      const one = await send(m.tenantId, m.owner, 'tenant', 'GET', `/resources/usage_meter_event/${String(newest.json.resource_id)}`);
      expect([one.status, one.json.external_event_key]).toEqual([200, 'new']);
    });

    it('pages with a cursor that neither repeats nor skips an event', async () => {
      const m = await tenant();
      for (let n = 0; n < 5; n += 1) await record(m, eventBody({ external_event_key: `page-${n}`, occurred_at: `2026-02-0${n + 1}T00:00:00Z` }));
      const seen: unknown[] = [];
      let cursor: string | null = null;
      do {
        const page: Reply = await send(m.tenantId, m.owner, 'tenant', 'GET', `/resources/usage_meter_event?limit=2${cursor === null ? '' : `&cursor=${cursor}`}`);
        seen.push(...(page.json.items as Array<Record<string, unknown>>).map((item) => item.external_event_key));
        cursor = page.json.next_cursor as string | null;
      } while (cursor !== null);
      expect(seen).toEqual(['page-4', 'page-3', 'page-2', 'page-1', 'page-0']);
    });

    it('refuses what holds no right to read the events, and answers 404 for the event of another tenant', async () => {
      const a = await tenant();
      const b = await tenant();
      const foreign = await record(b, eventBody({ external_event_key: 'theirs' }));
      expect((await send(a.tenantId, a.billing, 'tenant', 'GET', '/resources/usage_meter_event')).status).toBe(403);
      const notFound = await send(a.tenantId, a.owner, 'tenant', 'GET', `/resources/usage_meter_event/${String(foreign.json.resource_id)}`);
      expect([notFound.status, notFound.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      const listed = await send(a.tenantId, a.owner, 'tenant', 'GET', '/resources/usage_meter_event');
      expect(listed.json.items).toEqual([]);
    });

    it.each([['limit', '?limit=0'], ['cursor', '?cursor=nonsense']])('refuses a malformed %s', async (field, query) => {
      const m = await tenant();
      const reply = await send(m.tenantId, m.owner, 'tenant', 'GET', `/resources/usage_meter_event${query}`);
      expect([reply.status, reply.json.code, reply.json.detail]).toEqual([422, 'VALIDATION_FAILED', field]);
    });
  });

  describe('getTenantUsage (control plane)', () => {
    it('shows the Billing Operator the counters, the seats and the latest events of a tenant', async () => {
      const m = await tenant();
      await record(m, eventBody({ meter: 'bi.query', external_event_key: 'seen-by-billing', quantity: '3' }));
      const reply = await control(m.tenantId, 'GET', '/system/tenants/{tenantId}/usage', ['BillingOperator']);
      expect(reply.status).toBe(200);
      expect(meterOf(reply, 'bi.queries')?.used).toBe('3');
      expect(reply.json.seats).toEqual({ used: 3 });
      expect((reply.json.recent_events as Array<Record<string, unknown>>).map((event) => event.external_event_key)).toEqual(['seen-by-billing']);
    });

    it('shows the plan limits of the tenant it names, not those of the platform', async () => {
      const m = await tenant();
      await entitle(m.tenantId, [
        { featureCode: 'member.seats', limitKind: 'QUOTA', limitValue: 40, graceBehavior: 'READ_ONLY', expiredBehavior: 'DENY' },
        { featureCode: 'ai.analysis', limitKind: 'QUOTA', limitValue: 2000, graceBehavior: 'DENY', expiredBehavior: 'DENY' },
      ]);
      const reply = await control(m.tenantId, 'GET', '/system/tenants/{tenantId}/usage');
      expect(reply.json.seats).toEqual({ used: 3, limit: 40 });
      expect(meterOf(reply, 'ai.tokens')?.limit).toBe('2000');
    });

    it('lists no more than the latest events', async () => {
      const m = await tenant();
      for (let n = 0; n < 22; n += 1) await record(m, eventBody({ external_event_key: `many-${n}`, occurred_at: new Date(Date.now() - n * 60_000).toISOString() }));
      const reply = await control(m.tenantId, 'GET', '/system/tenants/{tenantId}/usage');
      expect(reply.json.recent_events).toHaveLength(20);
    });

    it('answers 404 for a tenant that does not exist, and refuses a tenant token and a support operator', async () => {
      const m = await tenant();
      const missing = await control(randomUUID(), 'GET', '/system/tenants/{tenantId}/usage');
      expect([missing.status, missing.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      const tenantToken = await control(m.tenantId, 'GET', '/system/tenants/{tenantId}/usage', ['SystemAdmin'], 'tenant');
      expect([tenantToken.status, tenantToken.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const support = await control(m.tenantId, 'GET', '/system/tenants/{tenantId}/usage', ['SupportOperator']);
      expect(support.status).toBe(403);
    });
  });
});
