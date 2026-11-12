import { randomBytes } from 'node:crypto';
import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ControlDatabase, EffectiveAccessStore, EntitlementStore, InMemoryAuthzCache, InMemoryEntitlementCache, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { seedSystemRoles } from '@machvon/db/src/system-roles';
import { STANDARD_FEATURES, TenantRateLimiter, entitlementsHash, loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import type { FeatureEntry } from '@machvon/kernel';
import { Client, Pool } from 'pg';
import { EntitlementChangedConsumer } from '../src/entitlements/entitlement-consumer';
import { StoreEntitlementGate } from '../src/entitlements/entitlement-gate';
import { InProcessEntitlementPush } from '../src/entitlements/entitlement-push';
import { EntitlementsController } from '../src/entitlements/entitlements.controller';
import { TENANT_RATE_LIMITER, TenantRateLimitGuard } from '../src/entitlements/tenant-rate-limit.guard';
import { OperationId } from '../src/operation-id.decorator';
import { PolicyModule } from '../src/policy.module';
import { ProblemFilter } from '../src/problem.filter';
import { AuthzHarness, ACTOR, TENANT_A, TENANT_B, contextFor, memberId } from '../../../packages/db/test/support/authz-fixtures';
import { CLAIMS_HEADER, TENANT_HEADER } from './isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from './isolation/test-app';
import type { RunningApp } from './isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const RELAY_KEY = randomBytes(32);
const PLAN = '00000000-0000-4000-9000-000000000001';

const USER = 1; // holds REPORT_USER on the whole tenant
const CONTROL_MEMBER = 2; // no grants: control requests carry realm roles instead

const EXTRA_OPERATIONS = {
  test_report_read: { permission: 'report.read', plane: 'tenant' },
  test_report_edit: { permission: 'report.edit', plane: 'tenant' },
  test_export: { permission: 'report.export', plane: 'tenant' },
  test_invite: { permission: 'iam.member.invite', plane: 'tenant' },
  test_ai: { permission: 'ai.invoke', plane: 'tenant' },
} as const;

@Controller('ent')
class GatedController {
  @Get('report')
  @OperationId('test_report_read')
  read(): { ok: true } {
    return { ok: true };
  }

  @Post('report')
  @HttpCode(200)
  @OperationId('test_report_edit')
  edit(): { ok: true } {
    return { ok: true };
  }

  @Post('export')
  @HttpCode(200)
  @OperationId('test_export')
  exportReport(): { ok: true } {
    return { ok: true };
  }

  @Post('invite')
  @HttpCode(200)
  @OperationId('test_invite')
  invite(): { ok: true } {
    return { ok: true };
  }

  @Post('ai')
  @HttpCode(200)
  @OperationId('test_ai')
  ai(): { ok: true } {
    return { ok: true };
  }
}

@Controller('limited')
class LimitedController {
  @Get()
  ping(): { ok: true } {
    return { ok: true };
  }
}

interface Reply {
  status: number;
  json: Record<string, unknown>;
  headers: Headers;
}

describe('entitlements through the API (ST-SAS-002)', () => {
  const harness = new AuthzHarness();
  const cache = new InMemoryEntitlementCache();
  const authzCache = new InMemoryAuthzCache();
  const push = new InProcessEntitlementPush();
  const pushed: Array<[string, string]> = [];
  let controlPool: Pool;
  let store: EntitlementStore;
  let consumer: EntitlementChangedConsumer;
  let app: RunningApp;
  let limited: RunningApp;

  async function call(method: string, path: string, options: { tenant?: string; member?: number; claims?: Record<string, unknown> } = {}): Promise<Reply> {
    const token = signTenantContext(contextFor(options.tenant ?? TENANT_A, memberId(options.member ?? USER)), SIGNING_KEY);
    const headers: Record<string, string> = { [TENANT_HEADER]: token };
    if (options.claims !== undefined) headers[CLAIMS_HEADER] = JSON.stringify(options.claims);
    const response = await fetch(`${app.baseUrl}${path}`, { method, headers });
    return { status: response.status, json: (await response.json()) as Record<string, unknown>, headers: response.headers };
  }

  const record = (tenant: string, features: readonly FeatureEntry[], cause: 'PROVISIONING' | 'OVERRIDE' = 'PROVISIONING'): Promise<{ versionNo: number; hash: string }> =>
    harness.tenants.withTenant(contextFor(tenant, memberId(USER)), (tx) => store.record(tx, { cause, planVersionId: PLAN, features }));

  async function deliveryOf(tenant: string, versionNo: number): Promise<{ id: string; tenantId: string; tenantContext: string; type: string; payload: Record<string, unknown> }> {
    const rows = await harness.owner<{ id: string; payload: Record<string, unknown> }>(tenant, [
      ["select id, payload from machvon.outbox_event where type = 'sas.entitlement.changed.v1' and (payload->>'version_no')::int = $1", [versionNo]],
    ]);
    const row = rows[0];
    if (row === undefined) throw new Error('no change event for the version');
    return {
      id: row.id,
      tenantId: tenant,
      tenantContext: signTenantContext({ tenantId: tenant, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, RELAY_KEY),
      type: 'sas.entitlement.changed.v1',
      payload: row.payload,
    };
  }

  beforeAll(async () => {
    await harness.start();
    controlPool = new Pool({ connectionString: harness.database.urlFor('machvon_control'), max: 3 });
    controlPool.on('error', () => undefined);
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: 1, path: '/u1/' }]);
      await harness.tenants.withTenant(contextFor(tenant, memberId(USER)), (tx) => seedSystemRoles(tx, ACTOR));
      await harness.seedMembership(tenant, USER, 1);
      await harness.seedRole(tenant, 70, 'REPORT_USER', ['report.read', 'report.edit', 'report.export', 'iam.member.invite', 'ai.invoke', 'session.self'], 10);
      await harness.seedGrants(tenant, [{ n: 1, member: USER, role: 70, kind: 'TENANT' }]);
    }
    await harness.seedMembership(TENANT_A, CONTROL_MEMBER, 1);
    const admin = new Client({ connectionString: harness.database.adminUrl });
    await admin.connect();
    try {
      await admin.query("insert into machvon.placement (id, kind, region, db_cluster_ref, kms_key_ref, status) values ('00000000-0000-4000-8000-0000000000b1', 'POOL', 'vn-north', 'pool-1', 'kms-1', 'Active')");
      for (const [tenant, code] of [[TENANT_A, 'tenant-a'], [TENANT_B, 'tenant-b']] as const) {
        await admin.query("insert into machvon.tenant (id, code, name, status, placement_id, region) values ($1, $2, $2, 'Active', '00000000-0000-4000-8000-0000000000b1', 'vn-north')", [tenant, code]);
      }
    } finally {
      await admin.end();
    }

    const database = new TenantDatabase(harness.appPool);
    store = new EntitlementStore(database, cache);
    await record(TENANT_A, STANDARD_FEATURES);
    await record(TENANT_B, STANDARD_FEATURES);
    consumer = new EntitlementChangedConsumer({ database, cache, authzCache, push, security: { signingKey: RELAY_KEY } });
    push.subscribe((tenantId, hash) => pushed.push([tenantId, hash]));

    const access = new EffectiveAccessStore(database, authzCache);
    const filter = { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) };
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [PolicyModule.register({ database, access, entitlements: new StoreEntitlementGate(store), extraOperations: EXTRA_OPERATIONS })],
      controllers: [GatedController, EntitlementsController],
      providers: [{ provide: EntitlementStore, useValue: store }, { provide: ControlDatabase, useValue: new ControlDatabase(controlPool) }, filter],
    });
    limited = await startTestApp({
      signingKey: SIGNING_KEY,
      controllers: [LimitedController],
      providers: [
        { provide: TENANT_RATE_LIMITER, useValue: new TenantRateLimiter({ limit: 3, windowSeconds: 60 }) },
        { provide: APP_GUARD, useClass: TenantRateLimitGuard },
        filter,
      ],
    });
  }, 300_000);

  afterAll(async () => {
    await Promise.all([app?.close(), limited?.close()]);
    await controlPool?.end();
    await harness.stop();
  }, 60_000);

  it('answers getMyEntitlements with the version, the hash and what each feature allows', async () => {
    const reply = await call('GET', '/me/entitlements');
    expect(reply.status).toBe(200);
    expect(reply.json).toMatchObject({ version_no: 1, entitlements_hash: entitlementsHash(STANDARD_FEATURES), license_status: 'FULL' });
    const features = reply.json.features as Array<Record<string, unknown>>;
    expect(features.find((feature) => feature.feature_code === 'reporting')).toEqual({ feature_code: 'reporting', allowed: true, source: 'PLAN', mode: 'FULL' });
    expect(features.find((feature) => feature.feature_code === 'member.invite')).toEqual({ feature_code: 'member.invite', allowed: false, limit: '0', source: 'PLAN', mode: 'DENIED' });
  });

  it('lets the plan features through and refuses a disabled one with ENTITLEMENT_DENIED and the reason', async () => {
    expect((await call('GET', '/ent/report')).status).toBe(200);
    expect((await call('POST', '/ent/report')).status).toBe(200);
    expect((await call('POST', '/ent/export')).status).toBe(200);
    const denied = await call('POST', '/ent/invite');
    expect(denied.status).toBe(403);
    expect(denied.json).toMatchObject({ code: 'ENTITLEMENT_DENIED', detail: 'FEATURE_OFF' });
  });

  it('decides a risky feature on the database: an override applies at once even with a warm cache', async () => {
    await call('GET', '/me/entitlements');
    expect((await call('POST', '/ent/ai')).status).toBe(403);
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.entitlement_override (tenant_id, id, feature_code, enabled, reason, valid_from, valid_until, status, requested_by, approved_by)
         values ($1, '00000000-0000-4000-a000-0000000000a1', 'ai.analysis', true, 'pilot of the analysis feature', now() - interval '1 day', now() + interval '30 days', 'Active', $2, $3)`,
        [TENANT_A, ACTOR, memberId(9)],
      ],
    ]);
    expect((await call('POST', '/ent/ai')).status).toBe(200);
    expect((await call('POST', '/ent/ai', { tenant: TENANT_B })).status).toBe(403);
  });

  it('applies a new entitlement version after its change event is consumed, once, and only for that tenant (AC-ST-SAS-002-1, AC-ST-SAS-002-2)', async () => {
    const enabled = STANDARD_FEATURES.map((entry) => (entry.featureCode === 'member.invite' ? { ...entry, limitValue: undefined } : entry));
    const second = await record(TENANT_A, enabled, 'OVERRIDE');
    expect(second.versionNo).toBe(2);
    // The cache still holds version 1 until the event is consumed.
    await call('GET', '/me/entitlements', { tenant: TENANT_B });
    expect((await call('GET', '/me/entitlements')).json.version_no).toBe(1);
    expect((await call('POST', '/ent/invite')).status).toBe(403);
    expect(cache.keys().filter((key) => key.includes(TENANT_B))).toHaveLength(1);

    const delivery = await deliveryOf(TENANT_A, 2);
    expect(await consumer.handle(delivery)).toBe('processed');
    expect(await consumer.handle(delivery)).toBe('duplicate');
    expect(pushed).toEqual([[TENANT_A, second.hash]]);

    const after = await call('GET', '/me/entitlements');
    expect(after.json).toMatchObject({ version_no: 2, entitlements_hash: second.hash });
    expect((await call('POST', '/ent/invite')).status).toBe(200);
    // Tenant B kept its cache entry and its answer.
    expect(cache.keys().filter((key) => key.includes(TENANT_B))).toHaveLength(1);
    expect((await call('GET', '/me/entitlements', { tenant: TENANT_B })).json.version_no).toBe(1);
  });

  it('ignores deliveries of other event types and deliveries whose payload names another tenant', async () => {
    const delivery = await deliveryOf(TENANT_A, 2);
    expect(await consumer.handle({ ...delivery, type: 'sas.tenant.requested.v1' })).toBe('ignored');
    expect(await consumer.handle({ ...delivery, payload: { ...delivery.payload, tenant_id: TENANT_B } })).toBe('ignored');
    expect(pushed).toHaveLength(1);
  });

  describe('getTenantEntitlements on the control plane', () => {
    const control = (roles: string[]): Record<string, unknown> => ({ aud: 'control', roles });

    it('shows a tenant its entitlements to a platform operator, with the tenant it names', async () => {
      const reply = await call('GET', `/system/tenants/${TENANT_B}/entitlements`, { member: CONTROL_MEMBER, claims: control(['PlatformOperator']) });
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ version_no: 1, entitlements_hash: entitlementsHash(STANDARD_FEATURES) });
    });

    it('names the current entitlement version by its id on the control plane only', async () => {
      const rows = await harness.owner<{ id: string }>(TENANT_B, [['select id from machvon.entitlement_version order by version_no desc limit 1']]);
      const reply = await call('GET', `/system/tenants/${TENANT_B}/entitlements`, { member: CONTROL_MEMBER, claims: control(['SystemAdmin']) });
      expect(reply.json.version_id).toBe(rows[0]?.id);
      expect((await call('GET', '/me/entitlements')).json).not.toHaveProperty('version_id');
    });

    it('refuses a tenant-plane token, a realm role without system.tenant.read and control claims without roles', async () => {
      const path = `/system/tenants/${TENANT_B}/entitlements`;
      expect((await call('GET', path)).json.code).toBe('SCOPE_DENIED');
      expect((await call('GET', path, { member: CONTROL_MEMBER, claims: control(['SupportOperator']) })).status).toBe(403);
      expect((await call('GET', path, { member: CONTROL_MEMBER, claims: { aud: 'control' } })).status).toBe(403);
    });

    it('answers 404 for a tenant that does not exist', async () => {
      const reply = await call('GET', '/system/tenants/00000000-0000-4000-8000-0000000000ee/entitlements', { member: CONTROL_MEMBER, claims: control(['SystemAdmin']) });
      expect(reply.status).toBe(404);
      expect(reply.json.code).toBe('RESOURCE_NOT_FOUND');
    });
  });

  it('refuses a tenant over its quota with 429 RATE_LIMIT while another tenant keeps its own (AC-ST-SAS-002-3)', async () => {
    const hit = async (tenant: string): Promise<Response> =>
      fetch(`${limited.baseUrl}/limited`, { headers: { [TENANT_HEADER]: signTenantContext(contextFor(tenant, memberId(USER)), SIGNING_KEY) } });
    for (let n = 0; n < 3; n += 1) expect((await hit(TENANT_A)).status).toBe(200);
    const refused = await hit(TENANT_A);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(((await refused.json()) as { code: string }).code).toBe('RATE_LIMIT');
    expect((await hit(TENANT_B)).status).toBe(200);
  });

  it('UAT-PLAN-46 a change of the plan records entitlement version 3 and its sas.entitlement.changed.v1 event in one transaction, the cache entry of the tenant is cleared once the event is consumed, and /me/entitlements gives the new hash that the clients holding the old one are told about', async () => {
    const heldBefore = await call('GET', '/me/entitlements');
    expect(cache.keys().filter((key) => key.includes(TENANT_A))).toHaveLength(1);
    const pushedBefore = pushed.length;
    const changed = STANDARD_FEATURES.map((entry) => (entry.featureCode === 'member.invite' ? { ...entry, limitValue: 5 } : entry));
    const next = await record(TENANT_A, changed, 'OVERRIDE');
    expect(next.hash).not.toBe(heldBefore.json.entitlements_hash);
    // The version and the event are written by one transaction: the same transaction id on both rows.
    const [pair] = await harness.owner<{ version_tx: string; event_tx: string }>(TENANT_A, [
      [
        `select v.xmin::text as version_tx, e.xmin::text as event_tx
           from machvon.entitlement_version v, machvon.outbox_event e
          where v.version_no = $1 and e.type = 'sas.entitlement.changed.v1' and (e.payload->>'version_no')::int = $1`,
        [next.versionNo],
      ],
    ]);
    expect(pair?.version_tx).toBeDefined();
    expect(pair?.event_tx).toBe(pair?.version_tx);
    // The event is consumed: the cache entry of the tenant is gone (the cache of the other tenant is left alone) and the clients are told the new hash.
    expect(await consumer.handle(await deliveryOf(TENANT_A, next.versionNo))).toBe('processed');
    expect(cache.keys().filter((key) => key.includes(TENANT_A))).toHaveLength(0);
    expect(pushed.slice(pushedBefore)).toEqual([[TENANT_A, next.hash]]);
    const after = await call('GET', '/me/entitlements');
    expect(after.json).toMatchObject({ version_no: next.versionNo, entitlements_hash: next.hash });
    expect(after.json.entitlements_hash).not.toBe(heldBefore.json.entitlements_hash);
    // The negative control: a check that wants the old hash after the change must fail on this answer.
    expect(() => expect(after.json.entitlements_hash).toBe(heldBefore.json.entitlements_hash)).toThrow();
  });
});
