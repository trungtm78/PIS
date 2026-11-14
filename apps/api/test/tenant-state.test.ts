import { randomBytes, randomUUID } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  EffectiveAccessStore,
  InMemoryAuthzCache,
  InMemoryEntitlementCache,
  OutboxRelay,
  PLATFORM_TENANT_ID,
  WORKER_MEMBERSHIP_ID,
} from '@machvon/db';
import type { OutboxDelivery } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { AUTH_TOKEN_REQUEST_KEY } from '../src/auth/auth.guard';
import { TENANT_STATUS_CHANGED_EVENT, TenantStatusChangedConsumer } from '../src/modules/sas/tenant-status-consumer';
import { PRINCIPAL_REQUEST_KEY } from '../src/principal';
import { ReadOnlyModeGuard } from '../src/session/read-only-mode.guard';
import { DatabaseTenantRuntime } from '../src/session/tenant-runtime';
import { CLAIMS_HEADER, TENANT_HEADER } from './isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from './isolation/test-app';
import type { RunningApp } from './isolation/test-app';
import { CONTROL_OPERATIONS } from './authz/control-matrix';
import { ProvisioningHarness } from './provisioning/provisioning-fixtures';

const SIGNING_KEY = randomBytes(32);
const RELAY_KEY = randomBytes(32);
const CONTROL_MEMBER = '00000000-0000-4000-8000-0000000000c9';
const OTHER_TENANT = '00000000-0000-4000-8000-0000000000dd';
const REASON = 'The invoice of September is 45 days overdue.';

interface Reply {
  status: number;
  headers: Headers;
  json: Record<string, unknown>;
}

describe('suspending and resuming a tenant over HTTP (ST-SAS-004)', () => {
  const harness = new ProvisioningHarness();
  const entitlementCache = new InMemoryEntitlementCache();
  const authzCache = new InMemoryAuthzCache();
  const invalidated = { entitlements: [] as string[], authz: [] as string[] };
  let runtime: DatabaseTenantRuntime;
  let app: RunningApp;
  let relayPool: Pool;

  async function call(
    path: string,
    options: { roles?: string[]; audience?: string; payload?: unknown; key?: string; ifMatch?: string; tenant?: string } = {},
  ): Promise<Reply> {
    const token = signTenantContext({ tenantId: options.tenant ?? PLATFORM_TENANT_ID, membershipId: CONTROL_MEMBER, scopeVersion: 0 }, SIGNING_KEY);
    const headers: Record<string, string> = {
      [TENANT_HEADER]: token,
      [CLAIMS_HEADER]: JSON.stringify({ aud: options.audience ?? 'control', roles: options.roles ?? ['SystemAdmin'] }),
      'content-type': 'application/json',
      'idempotency-key': options.key ?? `key-${randomUUID()}`,
    };
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(options.payload ?? {}) });
    return { status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> };
  }

  const suspendBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    reason_code: 'NON_PAYMENT',
    reason: REASON,
    access_policy: 'READ_ONLY_EXPORT',
    ...overrides,
  });

  const suspend = (tenantId: string, options: Parameters<typeof call>[1] = {}): Promise<Reply> =>
    call(`/system/tenants/${tenantId}/suspend`, { payload: suspendBody(), ...options });

  const resume = (tenantId: string, options: Parameters<typeof call>[1] = {}): Promise<Reply> =>
    call(`/system/tenants/${tenantId}/resume`, { payload: { reason: 'The invoice was paid on 2026-10-20.' }, ...options });

  async function activeTenant(): Promise<{ tenantId: string; version: number }> {
    const created = await harness.request();
    await harness.registry.transition(created.tenantId, 'Requested', 'Provisioning');
    await harness.registry.transition(created.tenantId, 'Provisioning', 'Active');
    return { tenantId: created.tenantId, version: (await harness.registry.getTenant(created.tenantId))?.version ?? 0 };
  }

  const statusOf = async (tenantId: string): Promise<string | undefined> => (await harness.registry.getTenant(tenantId))?.status;

  beforeAll(async () => {
    await harness.start();
    relayPool = new Pool({ connectionString: harness.database.urlFor('machvon_outbox_relay'), max: 2 });
    relayPool.on('error', () => undefined);
    runtime = new DatabaseTenantRuntime(harness.tenants, { maxAgeMs: 600_000 });
    const entitlementInvalidate = entitlementCache.invalidate.bind(entitlementCache);
    entitlementCache.invalidate = (tenantId: string): Promise<void> => {
      invalidated.entitlements.push(tenantId);
      return entitlementInvalidate(tenantId);
    };
    const authzInvalidate = authzCache.invalidateTenant.bind(authzCache);
    authzCache.invalidateTenant = (tenantId: string): Promise<void> => {
      invalidated.authz.push(tenantId);
      return authzInvalidate(tenantId);
    };
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        AppModule.register({
          database: harness.tenants,
          registry: loadErrorRegistry(ERROR_CODES_PATH),
          policy: { database: harness.tenants, access: new EffectiveAccessStore(harness.tenants, authzCache) },
          control: { database: harness.control, registry: harness.registry },
          tenantState: { runtime, entitlementCache, authzCache },
        }),
      ],
    });
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    await relayPool?.end();
    await harness.stop();
  }, 60_000);

  describe('suspendTenant', () => {
    it('suspends an Active tenant: 200 with the new status and version, the ETag, the reason on the row and the read-only policy', async () => {
      const { tenantId, version } = await activeTenant();
      const reply = await suspend(tenantId, { ifMatch: `"${version}"` });
      expect(reply.status).toBe(200);
      expect(reply.json).toEqual({ tenant_id: tenantId, status: 'Suspended', version: version + 1 });
      expect(reply.headers.get('etag')).toBe(`"${version + 1}"`);
      expect(await statusOf(tenantId)).toBe('Suspended');
      const policy = await harness.admin((client) => client.query<{ access_policy: string }>('select access_policy from machvon.tenant_runtime($1::uuid)', [tenantId]));
      expect(policy.rows[0]?.access_policy).toBe('READ_ONLY_EXPORT');
    });

    it('writes one audit row on the suspended tenant, with the reason and the policy, in the transaction of the change', async () => {
      const { tenantId, version } = await activeTenant();
      await suspend(tenantId, { ifMatch: `"${version}"`, payload: suspendBody({ reason_code: 'LEGAL_ORDER' }) });
      const own = await harness.admin((client) =>
        client.query<{ reason: string; safe_diff: Record<string, unknown> }>("select reason, safe_diff from machvon.audit_event where tenant_id = $1 and action = 'tenant.suspended' and outcome = 'SUCCESS'", [tenantId]),
      );
      expect(own.rows).toHaveLength(1);
      expect(own.rows[0]?.reason).toBe(REASON);
      expect(own.rows[0]?.safe_diff).toMatchObject({ reason_code: 'LEGAL_ORDER', access_policy: 'READ_ONLY_EXPORT', from: 'Active', to: 'Suspended' });
    });

    it('emits sas.tenant.status_changed.v1 for the tenant with the transition and the reason code, once, and no personal text', async () => {
      const { tenantId, version } = await activeTenant();
      await suspend(tenantId, { ifMatch: `"${version}"` });
      const events = await harness.admin((client) =>
        client.query<{ payload: Record<string, unknown>; event_key: string }>("select payload, event_key from machvon.outbox_event where tenant_id = $1 and type = 'sas.tenant.status_changed.v1'", [tenantId]),
      );
      expect(events.rows).toHaveLength(1);
      expect(events.rows[0]?.payload).toEqual({ tenant_id: tenantId, from: 'Active', to: 'Suspended', reason_code: 'NON_PAYMENT' });
      expect(events.rows[0]?.event_key).toBe(`tenant:${tenantId}:status:${version + 1}`);
      expect(JSON.stringify(events.rows[0]?.payload)).not.toContain(REASON);
    });

    it('has dropped the live state, the entitlements and the effective access of the tenant when the answer arrives', async () => {
      const { tenantId, version } = await activeTenant();
      expect((await runtime.of(tenantId))?.accessPolicy).toBe('FULL');
      invalidated.entitlements.length = 0;
      invalidated.authz.length = 0;
      await suspend(tenantId, { ifMatch: `"${version}"` });
      expect(invalidated.entitlements).toContain(tenantId);
      expect(invalidated.authz).toContain(tenantId);
      // The runtime keeps an answer for ten minutes here, so only the command's own invalidation can make this true.
      expect(await runtime.of(tenantId)).toMatchObject({ status: 'Suspended', accessPolicy: 'READ_ONLY_EXPORT' });
    });

    it('refuses the very next tenant command of a session issued while the tenant was Active, and still lets it read and export (AC-ST-SAS-004-1)', async () => {
      const { tenantId, version } = await activeTenant();
      const guard = new ReadOnlyModeGuard(new Reflector(), runtime);
      const contextOf = (method: string): ExecutionContext =>
        ({
          getHandler: () => () => undefined,
          getClass: () => class Probe {},
          switchToHttp: () => ({
            getRequest: () => ({
              method,
              [AUTH_TOKEN_REQUEST_KEY]: { audience: 'tenant', roles: [], mode: 'FULL' },
              [PRINCIPAL_REQUEST_KEY]: { tenant: { tenantId, membershipId: tenantId, scopeVersion: 0 }, audience: 'tenant', assurance: 'aal1', sessionId: 's' },
            }),
          }),
        }) as unknown as ExecutionContext;
      expect(await guard.canActivate(contextOf('POST'))).toBe(true);
      await suspend(tenantId, { ifMatch: `"${version}"` });
      await expect(guard.canActivate(contextOf('POST'))).rejects.toMatchObject({ code: 'TENANT_SUSPENDED', status: 403 });
      expect(await guard.canActivate(contextOf('GET'))).toBe(true);
    });

    it('suspends for a security incident with no access at all: even a read is refused', async () => {
      const { tenantId, version } = await activeTenant();
      const reply = await suspend(tenantId, { ifMatch: `"${version}"`, payload: suspendBody({ reason_code: 'SECURITY_INCIDENT', access_policy: 'NO_ACCESS' }) });
      expect(reply.status).toBe(200);
      expect((await runtime.of(tenantId))?.accessPolicy).toBe('NO_ACCESS');
    });

    it.each([
      ['a reason code and a policy that disagree', { reason_code: 'SECURITY_INCIDENT' }, 422, 'VALIDATION_FAILED'],
      ['NO_ACCESS without a security incident', { access_policy: 'NO_ACCESS' }, 422, 'VALIDATION_FAILED'],
      ['a reason code that is not in the contract', { reason_code: 'BORED' }, 422, 'VALIDATION_FAILED'],
      ['a reason shorter than ten characters', { reason: 'too short' }, 422, 'VALIDATION_FAILED'],
      ['a field that is not in the contract', { surprise: true }, 400, 'FIELD_NOT_ALLOWED'],
    ] as const)('refuses %s with %s %s and leaves the tenant Active', async (_label, overrides, status, code) => {
      const { tenantId, version } = await activeTenant();
      const reply = await suspend(tenantId, { ifMatch: `"${version}"`, payload: suspendBody(overrides) });
      expect([reply.status, reply.json.code]).toEqual([status, code]);
      expect(await statusOf(tenantId)).toBe('Active');
    });

    it('answers 428 without If-Match, 409 VERSION_CONFLICT with the current version for a stale one, 409 TENANT_STATE_INVALID when the tenant is not Active and 404 for an unknown tenant (AC-ST-SAS-004-2)', async () => {
      const { tenantId, version } = await activeTenant();
      expect((await suspend(tenantId)).status).toBe(428);
      const stale = await suspend(tenantId, { ifMatch: `"${version - 1}"` });
      expect([stale.status, stale.json.code, stale.json.current_version]).toEqual([409, 'VERSION_CONFLICT', version]);
      expect(await statusOf(tenantId)).toBe('Active');

      await suspend(tenantId, { ifMatch: `"${version}"` });
      const again = await suspend(tenantId, { ifMatch: `"${version + 1}"` });
      expect([again.status, again.json.code]).toEqual([409, 'TENANT_STATE_INVALID']);

      const requested = await harness.request();
      const notActive = await suspend(requested.tenantId, { ifMatch: '"1"' });
      expect([notActive.status, notActive.json.code]).toEqual([409, 'TENANT_STATE_INVALID']);
      expect((await suspend(OTHER_TENANT, { ifMatch: '"1"' })).status).toBe(404);
    });

    it('replays the same key and body with the stored answer and suspends once', async () => {
      const { tenantId, version } = await activeTenant();
      const key = `key-${randomUUID()}`;
      const first = await suspend(tenantId, { ifMatch: `"${version}"`, key });
      const second = await suspend(tenantId, { ifMatch: `"${version}"`, key });
      expect(second.status).toBe(200);
      expect(second.json).toEqual(first.json);
      expect(second.headers.get('idempotency-replayed')).toBe('true');
      expect(await harness.count("select count(*) as n from machvon.outbox_event where tenant_id = $1 and type = 'sas.tenant.status_changed.v1'", [tenantId])).toBe(1);
    });

    it.each(['PlatformOperator', 'BillingOperator', 'SupportOperator'])('refuses the realm role %s with 403, writes a DENIED audit row on the platform tenant and changes nothing', async (role) => {
      const { tenantId, version } = await activeTenant();
      const before = await harness.count("select count(*) as n from machvon.audit_event where tenant_id = $1 and outcome = 'DENIED' and action = 'authz.denied:suspendTenant'", [PLATFORM_TENANT_ID]);
      const reply = await suspend(tenantId, { ifMatch: `"${version}"`, roles: [role] });
      expect([reply.status, reply.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect(await harness.count("select count(*) as n from machvon.audit_event where tenant_id = $1 and outcome = 'DENIED' and action = 'authz.denied:suspendTenant'", [PLATFORM_TENANT_ID])).toBe(before + 1);
      expect(await statusOf(tenantId)).toBe('Active');
    });

    it('refuses a tenant-plane token on the control plane with 403 SCOPE_DENIED', async () => {
      const { tenantId, version } = await activeTenant();
      const reply = await suspend(tenantId, { ifMatch: `"${version}"`, audience: 'tenant', roles: [], tenant: OTHER_TENANT });
      expect([reply.status, reply.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect(await statusOf(tenantId)).toBe('Active');
    });
  });

  describe('resumeTenant', () => {
    async function suspendedTenant(): Promise<{ tenantId: string; version: number }> {
      const { tenantId, version } = await activeTenant();
      await suspend(tenantId, { ifMatch: `"${version}"` });
      return { tenantId, version: version + 1 };
    }

    it('resumes a Suspended tenant: Active, full access at once, an audit row and an event with the transition (AC-ST-SAS-004-1)', async () => {
      const { tenantId, version } = await suspendedTenant();
      expect((await runtime.of(tenantId))?.accessPolicy).toBe('READ_ONLY_EXPORT');
      const reply = await resume(tenantId, { ifMatch: `"${version}"` });
      expect(reply.status).toBe(200);
      expect(reply.json).toEqual({ tenant_id: tenantId, status: 'Active', version: version + 1 });
      expect(reply.headers.get('etag')).toBe(`"${version + 1}"`);
      expect(await runtime.of(tenantId)).toMatchObject({ status: 'Active', accessPolicy: 'FULL' });
      expect(await harness.count("select count(*) as n from machvon.audit_event where tenant_id = $1 and action = 'tenant.resumed' and outcome = 'SUCCESS' and reason is not null", [tenantId])).toBe(1);
      const events = await harness.admin((client) =>
        client.query<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where tenant_id = $1 and type = 'sas.tenant.status_changed.v1' and (payload->>'to') = 'Active'", [tenantId]),
      );
      expect(events.rows[0]?.payload).toEqual({ tenant_id: tenantId, from: 'Suspended', to: 'Active' });
    });

    it('UAT-AC149: a suspended tenant is read-only when the answer arrives: a read passes, a write of a live session is 403 TENANT_SUSPENDED; after the resume it is Active and writes again; each transition leaves one audit row with its reason and one status event', async () => {
      const { tenantId, version } = await activeTenant();
      const guard = new ReadOnlyModeGuard(new Reflector(), runtime);
      const contextOf = (method: string): ExecutionContext =>
        ({
          getHandler: () => () => undefined,
          getClass: () => class Probe {},
          switchToHttp: () => ({
            getRequest: () => ({
              method,
              [AUTH_TOKEN_REQUEST_KEY]: { audience: 'tenant', roles: [], mode: 'FULL' },
              [PRINCIPAL_REQUEST_KEY]: { tenant: { tenantId, membershipId: tenantId, scopeVersion: 0 }, audience: 'tenant', assurance: 'aal1', sessionId: 's' },
            }),
          }),
        }) as unknown as ExecutionContext;
      const suspended = await suspend(tenantId, { ifMatch: `"${version}"` });
      expect(suspended.status).toBe(200);
      expect(suspended.json).toMatchObject({ tenant_id: tenantId, status: 'Suspended' });
      // No wait of 60 seconds is needed: the state every process reads is already the suspended one.
      expect(await runtime.of(tenantId)).toMatchObject({ status: 'Suspended', accessPolicy: 'READ_ONLY_EXPORT' });
      expect(await guard.canActivate(contextOf('GET'))).toBe(true);
      await expect(guard.canActivate(contextOf('POST'))).rejects.toMatchObject({ code: 'TENANT_SUSPENDED', status: 403 });
      const resumed = await resume(tenantId, { ifMatch: `"${version + 1}"` });
      expect(resumed.json).toMatchObject({ tenant_id: tenantId, status: 'Active' });
      expect(await guard.canActivate(contextOf('POST'))).toBe(true);
      for (const action of ['tenant.suspended', 'tenant.resumed']) {
        expect(await harness.count("select count(*) as n from machvon.audit_event where tenant_id = $1 and action = $2 and outcome = 'SUCCESS' and reason is not null and length(reason) > 0", [tenantId, action])).toBe(1);
      }
      const events = await harness.admin((client) => client.query<{ to: string }>("select payload->>'to' as to from machvon.outbox_event where tenant_id = $1 and type = 'sas.tenant.status_changed.v1'", [tenantId]));
      expect(events.rows.map((row) => row.to).sort()).toEqual(['Active', 'Suspended']);
    });

    it('answers 428 without If-Match, 409 VERSION_CONFLICT for a stale one, 409 TENANT_STATE_INVALID for an Active tenant and 404 for an unknown one (AC-ST-SAS-004-2)', async () => {
      const { tenantId, version } = await suspendedTenant();
      expect((await resume(tenantId)).status).toBe(428);
      const stale = await resume(tenantId, { ifMatch: `"${version - 1}"` });
      expect([stale.status, stale.json.code, stale.json.current_version]).toEqual([409, 'VERSION_CONFLICT', version]);
      const active = await activeTenant();
      const notSuspended = await resume(active.tenantId, { ifMatch: `"${active.version}"` });
      expect([notSuspended.status, notSuspended.json.code]).toEqual([409, 'TENANT_STATE_INVALID']);
      expect((await resume(OTHER_TENANT, { ifMatch: '"1"' })).status).toBe(404);
      expect(await statusOf(tenantId)).toBe('Suspended');
    });

    it('refuses a reason shorter than ten characters and a realm role without system.tenant.manage', async () => {
      const { tenantId, version } = await suspendedTenant();
      const short = await resume(tenantId, { ifMatch: `"${version}"`, payload: { reason: 'paid' } });
      expect([short.status, short.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      expect((await resume(tenantId, { ifMatch: `"${version}"`, roles: ['PlatformOperator'] })).status).toBe(403);
      expect(await statusOf(tenantId)).toBe('Suspended');
    });
  });

  describe('the status event reaches the other processes', () => {
    async function deliveryOf(tenantId: string, key: Buffer = RELAY_KEY): Promise<OutboxDelivery & { tenantContext: string }> {
      const rows = await harness.admin((client) =>
        client.query<{ id: string; payload: Record<string, unknown> }>("select id, payload from machvon.outbox_event where tenant_id = $1 and type = 'sas.tenant.status_changed.v1' order by created_at desc limit 1", [tenantId]),
      );
      const row = rows.rows[0];
      if (row === undefined) throw new Error('no status event');
      return {
        id: row.id,
        tenantId,
        tenantContext: signTenantContext({ tenantId, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, key),
        type: TENANT_STATUS_CHANGED_EVENT,
        payload: row.payload,
      } as unknown as OutboxDelivery & { tenantContext: string };
    }

    it('drops what another process holds about the tenant, once, however often the event is delivered', async () => {
      const { tenantId, version } = await activeTenant();
      await suspend(tenantId, { ifMatch: `"${version}"` });
      const dropped: string[] = [];
      const consumer = new TenantStatusChangedConsumer({
        database: harness.tenants,
        security: { signingKey: RELAY_KEY },
        effects: { invalidate: (id) => Promise.resolve(void dropped.push(id)) },
      });
      const delivery = await deliveryOf(tenantId);
      expect(await consumer.handle(delivery)).toBe('processed');
      expect(await consumer.handle(delivery)).toBe('duplicate');
      expect(await consumer.handle(delivery)).toBe('duplicate');
      expect(dropped).toEqual([tenantId]);
    });

    it('ignores other event types and a payload that names another tenant than the signed one', async () => {
      const { tenantId, version } = await activeTenant();
      await suspend(tenantId, { ifMatch: `"${version}"` });
      const dropped: string[] = [];
      const consumer = new TenantStatusChangedConsumer({
        database: harness.tenants,
        security: { signingKey: RELAY_KEY },
        effects: { invalidate: (id) => Promise.resolve(void dropped.push(id)) },
      });
      const delivery = await deliveryOf(tenantId);
      expect(await consumer.handle({ ...delivery, type: 'sas.tenant.requested.v1' })).toBe('ignored');
      expect(await consumer.handle({ ...delivery, payload: { ...delivery.payload, tenant_id: OTHER_TENANT } })).toBe('ignored');
      expect(dropped).toEqual([]);
    });

    it('is delivered by the outbox relay like any other event', async () => {
      const { tenantId, version } = await activeTenant();
      await suspend(tenantId, { ifMatch: `"${version}"` });
      const seen: string[] = [];
      const relay = new OutboxRelay(
        relayPool,
        (delivery: OutboxDelivery) => {
          if (delivery.tenantId === tenantId && delivery.type === TENANT_STATUS_CHANGED_EVENT) seen.push(String(delivery.payload.to));
          return Promise.resolve();
        },
        { signingKey: RELAY_KEY },
      );
      await relay.runOnce();
      expect(seen).toEqual(['Suspended']);
    });
  });

  describe('control matrix', () => {
    it('lists both commands with the manage permission, like the other tenant registry commands', () => {
      const listed = CONTROL_OPERATIONS.filter((operation) => ['suspendTenant', 'resumeTenant'].includes(operation.operationId));
      expect(listed.map((operation) => [operation.operationId, operation.permission, operation.path])).toEqual([
        ['suspendTenant', 'system.tenant.manage', '/system/tenants/{tenantId}/suspend'],
        ['resumeTenant', 'system.tenant.manage', '/system/tenants/{tenantId}/resume'],
      ]);
    });
  });
});
