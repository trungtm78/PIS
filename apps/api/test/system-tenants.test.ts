import { randomBytes, randomUUID } from 'node:crypto';
import { EffectiveAccessStore, InMemoryAuthzCache, OutboxRelay, PLATFORM_TENANT_ID, PROVISIONING_STEPS, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import type { OutboxDelivery, ProvisioningStep } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import type { AlertSink } from '@machvon/kernel';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { MockProvisioningPorts } from '../src/provisioning/mock-ports';
import { PROVISIONING_CONSUMER, ProvisioningConsumer, TENANT_REQUESTED_EVENT, resumeUnfinishedRuns } from '../src/provisioning/provisioning.consumer';
import type { ProvisioningDelivery } from '../src/provisioning/provisioning.consumer';
import { ProvisioningSaga } from '../src/provisioning/saga';
import { InProcessWorkflowRunner } from '../src/provisioning/workflow-runner';
import { CLAIMS_HEADER, TENANT_HEADER } from './isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from './isolation/test-app';
import type { RunningApp } from './isolation/test-app';
import { CONTROL_OPERATIONS, controlCasesFor } from './authz/control-matrix';
import { PLAN_DRAFT, PLAN_PUBLISHED, ProvisioningHarness } from './provisioning/provisioning-fixtures';

const SIGNING_KEY = randomBytes(32);
const RELAY_KEY = randomBytes(32);
const CONTROL_MEMBER = '00000000-0000-4000-8000-0000000000c9';
const OTHER_TENANT = '00000000-0000-4000-8000-0000000000dd';

interface Reply {
  status: number;
  headers: Headers;
  json: Record<string, unknown>;
}

class RecordingAlerts implements AlertSink {
  readonly raised: Array<{ code: string; context: Record<string, unknown> }> = [];

  raise(code: string, context: Record<string, unknown>): void {
    this.raised.push({ code, context });
  }
}

describe('control-plane tenant registry over HTTP (ST-SAS-001)', () => {
  const harness = new ProvisioningHarness();
  const alerts = new RecordingAlerts();
  const ports = new MockProvisioningPorts();
  const runner = new InProcessWorkflowRunner();
  let relayPool: Pool;
  let app: RunningApp;
  let saga: ProvisioningSaga;
  let consumer: ProvisioningConsumer;
  let counter = 0;

  const body = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
    counter += 1;
    return {
      code: `http-${counter}`,
      name: `Tenant over HTTP ${counter}`,
      governing_body_type: 'PROVINCE',
      region: 'vn-north',
      isolation_mode: 'POOL',
      plan_version_id: PLAN_PUBLISHED,
      root_unit_name: 'Root unit',
      initial_owner_email: `owner${counter}@example.org`,
      platform_subdomain: `http-${counter}`,
      ...overrides,
    };
  };

  async function call(
    method: string,
    path: string,
    options: { roles?: string[]; audience?: string; payload?: unknown; key?: string | null; ifMatch?: string; tenant?: string } = {},
  ): Promise<Reply> {
    const token = signTenantContext({ tenantId: options.tenant ?? PLATFORM_TENANT_ID, membershipId: CONTROL_MEMBER, scopeVersion: 0 }, SIGNING_KEY);
    const headers: Record<string, string> = {
      [TENANT_HEADER]: token,
      [CLAIMS_HEADER]: JSON.stringify({ aud: options.audience ?? 'control', roles: options.roles ?? ['SystemAdmin'] }),
      'content-type': 'application/json',
    };
    if (method !== 'GET' && options.key !== null) headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${path}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.payload ?? {}) });
    return { status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> };
  }

  const request = (payload: Record<string, unknown> = body(), options: { roles?: string[]; key?: string } = {}): Promise<Reply> =>
    call('POST', '/system/tenants', { ...options, payload });

  beforeAll(async () => {
    await harness.start();
    relayPool = new Pool({ connectionString: harness.database.urlFor('machvon_outbox_relay'), max: 2 });
    relayPool.on('error', () => undefined);
    saga = new ProvisioningSaga(harness.registry, ports, { delay: () => Promise.resolve() });
    consumer = new ProvisioningConsumer(harness.tenants, saga, runner, { signingKey: RELAY_KEY, alerts });
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
    await relayPool?.end();
    await harness.stop();
  }, 60_000);

  describe('requestTenantProvisioning', () => {
    it('answers 202, writes the tenant, the run, the audit row and the event for the new tenant in one transaction, and keeps the email out of the event', async () => {
      const payload = body();
      const reply = await request(payload);
      expect(reply.status).toBe(202);
      expect(reply.json).toMatchObject({ status: 'Requested', version: 1 });
      expect(reply.headers.get('etag')).toBe('"1"');
      const tenantId = reply.json.tenant_id as string;
      expect(await harness.count('select count(*) as n from machvon.tenant where id = $1', [tenantId])).toBe(1);
      expect(await harness.count("select count(*) as n from machvon.tenant_provisioning_run where tenant_id = $1 and attempt = 1 and status = 'Running'", [tenantId])).toBe(1);
      expect(await harness.count("select count(*) as n from machvon.audit_event where tenant_id = $1 and action = 'tenant.requested' and outcome = 'SUCCESS'", [tenantId])).toBe(1);
      const events = await harness.admin((client) =>
        client.query<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where tenant_id = $1 and type = 'sas.tenant.requested.v1'", [tenantId]),
      );
      expect(events.rows).toHaveLength(1);
      expect(events.rows[0]?.payload).toMatchObject({ tenant_id: tenantId, run_id: reply.json.provisioning_run_id, attempt: 1, plan_version_id: PLAN_PUBLISHED });
      expect(JSON.stringify(events.rows[0]?.payload)).not.toContain(String(payload.initial_owner_email));
      // The idempotency record and the pipeline's own bookkeeping belong to the platform tenant.
      expect(await harness.count('select count(*) as n from machvon.idempotency_record where tenant_id = $1 and operation = $2', [PLATFORM_TENANT_ID, 'requestTenantProvisioning'])).toBeGreaterThan(0);
    });

    it('replays the same key and body with the stored answer and creates one tenant (AC-ST-SAS-001-1)', async () => {
      const payload = body();
      const key = `key-${randomUUID()}`;
      const first = await request(payload, { key });
      const second = await request(payload, { key });
      expect(second.status).toBe(202);
      expect(second.json).toEqual(first.json);
      expect(second.headers.get('idempotency-replayed')).toBe('true');
      expect(await harness.count('select count(*) as n from machvon.tenant where code = $1', [payload.code])).toBe(1);
    });

    it('answers 409 TENANT_CODE_TAKEN for the same code under another key and creates no second tenant (AC-ST-SAS-001-1)', async () => {
      const payload = body();
      await request(payload);
      const again = await request({ ...payload, platform_subdomain: 'another-one' });
      expect(again.status).toBe(409);
      expect(again.json.code).toBe('TENANT_CODE_TAKEN');
      expect(await harness.count('select count(*) as n from machvon.tenant where lower(code) = $1', [payload.code])).toBe(1);
    });

    it.each([
      ['an upper-case code', { code: 'ACME' }, 422, 'VALIDATION_FAILED'],
      ['a code with a trailing space', { code: 'acme ' }, 422, 'VALIDATION_FAILED'],
      ['an unknown region', { region: 'us-east' }, 422, 'VALIDATION_FAILED'],
      ['a field that is not in the contract', { surprise: true }, 400, 'FIELD_NOT_ALLOWED'],
      ['a plan version that is not Published', { plan_version_id: PLAN_DRAFT }, 409, 'PLAN_NOT_PUBLISHED'],
      ['a silo with no placement', { isolation_mode: 'SILO' }, 422, 'PLACEMENT_UNAVAILABLE'],
    ] as const)('refuses %s with %s %s and creates nothing', async (_label, overrides, status, code) => {
      const before = await harness.count('select count(*) as n from machvon.tenant');
      const reply = await request(body(overrides));
      expect([reply.status, reply.json.code]).toEqual([status, code]);
      expect(await harness.count('select count(*) as n from machvon.tenant')).toBe(before);
    });

    it.each([['PlatformOperator'], ['BillingOperator'], ['SupportOperator']])('refuses the realm role %s with 403 and records a DENIED audit row on the platform tenant (AC-ST-SAS-001-3)', async (role) => {
      const before = await harness.count("select count(*) as n from machvon.audit_event where tenant_id = $1 and outcome = 'DENIED' and action = 'authz.denied:requestTenantProvisioning'", [PLATFORM_TENANT_ID]);
      const reply = await request(body(), { roles: [role] });
      expect(reply.status).toBe(403);
      expect(reply.json.code).toBe('SCOPE_DENIED');
      expect(await harness.count("select count(*) as n from machvon.audit_event where tenant_id = $1 and outcome = 'DENIED' and action = 'authz.denied:requestTenantProvisioning'", [PLATFORM_TENANT_ID])).toBe(before + 1);
    });

    it('refuses a tenant-plane token on the control plane with 403 SCOPE_DENIED', async () => {
      const reply = await call('POST', '/system/tenants', { audience: 'tenant', roles: [], payload: body(), tenant: OTHER_TENANT });
      expect(reply.status).toBe(403);
      expect(reply.json.code).toBe('SCOPE_DENIED');
    });
  });

  describe('reads', () => {
    it('lets a PlatformOperator list tenants by keyset pages and read one with its provisioning steps (AC-ST-SAS-001-3)', async () => {
      await request();
      await request();
      const first = await call('GET', '/system/tenants?limit=1', { roles: ['PlatformOperator'] });
      expect(first.status).toBe(200);
      expect(first.json.items).toHaveLength(1);
      expect(typeof first.json.next_cursor).toBe('string');
      const second = await call('GET', `/system/tenants?limit=1&cursor=${String(first.json.next_cursor)}`, { roles: ['PlatformOperator'] });
      expect((second.json.items as Array<{ id: string }>)[0]?.id).not.toBe((first.json.items as Array<{ id: string }>)[0]?.id);

      const id = (first.json.items as Array<{ id: string }>)[0]?.id ?? '';
      const detail = await call('GET', `/system/tenants/${id}`, { roles: ['PlatformOperator'] });
      expect(detail.status).toBe(200);
      expect(detail.json).toMatchObject({ id, status: 'Requested', version: 1 });
      const steps = (detail.json.provisioning as { steps: Array<{ step: string; status: string }> }).steps;
      expect(steps).toHaveLength(11);
      expect(steps[0]).toMatchObject({ step: 'IDP_ORG', status: 'PENDING' });
    });

    it('shows a run that failed in the final activation on its last step, with the code, although every step itself finished', async () => {
      const created = await harness.request();
      await harness.registry.transition(created.tenantId, 'Requested', 'Provisioning');
      const run = await harness.registry.loadRun(created.tenantId, 1);
      for (const step of PROVISIONING_STEPS) await harness.registry.updateStep(created.tenantId, run?.id ?? '', step, { status: 'DONE', attempts: 1 });
      await harness.registry.failRun(created.tenantId, run?.id ?? '', 'ACTIVATION_FAILED', PROVISIONING_STEPS[PROVISIONING_STEPS.length - 1] as ProvisioningStep);
      const detail = await call('GET', `/system/tenants/${created.tenantId}`, { roles: ['PlatformOperator'] });
      const steps = (detail.json.provisioning as { steps: Array<{ step: string; status: string; error_code?: string }> }).steps;
      expect(steps.filter((step) => step.status === 'FAILED')).toEqual([expect.objectContaining({ step: PROVISIONING_STEPS[PROVISIONING_STEPS.length - 1], error_code: 'ACTIVATION_FAILED' })]);
      expect(steps.filter((step) => step.status === 'DONE')).toHaveLength(PROVISIONING_STEPS.length - 1);
    });

    it('answers 404 for an unknown tenant, 403 for a role without system.tenant.read and a malformed cursor with 422', async () => {
      expect((await call('GET', `/system/tenants/${OTHER_TENANT}`)).status).toBe(404);
      expect((await call('GET', '/system/tenants', { roles: ['SupportOperator'] })).status).toBe(403);
      const bad = await call('GET', '/system/tenants?cursor=not-a-cursor');
      expect([bad.status, bad.json.code]).toEqual([422, 'VALIDATION_FAILED']);
    });
  });

  describe('retryTenantProvisioning', () => {
    async function failedTenant(): Promise<{ tenantId: string; version: number }> {
      const created = await harness.request();
      await harness.registry.transition(created.tenantId, 'Requested', 'Provisioning');
      await harness.registry.transition(created.tenantId, 'Provisioning', 'Failed');
      return { tenantId: created.tenantId, version: (await harness.registry.getTenant(created.tenantId))?.version ?? 0 };
    }

    const retry = (tenantId: string, options: { ifMatch?: string; roles?: string[] } = {}): Promise<Reply> =>
      call('POST', `/system/tenants/${tenantId}/provisioning/retry`, { payload: { reason: 'The DNS provider is back.' }, ...options });

    it('opens attempt 2 for a Failed tenant, moves it to Provisioning and emits the requested event for attempt 2', async () => {
      const { tenantId, version } = await failedTenant();
      const reply = await retry(tenantId, { ifMatch: `"${version}"` });
      expect(reply.status).toBe(202);
      expect(reply.json).toMatchObject({ tenant_id: tenantId, status: 'Provisioning', version: version + 1 });
      expect(await harness.count('select count(*) as n from machvon.tenant_provisioning_run where tenant_id = $1 and attempt = 2', [tenantId])).toBe(1);
      expect(await harness.count("select count(*) as n from machvon.outbox_event where tenant_id = $1 and type = 'sas.tenant.requested.v1' and (payload->>'attempt')::int = 2", [tenantId])).toBe(1);
      expect(await harness.count("select count(*) as n from machvon.audit_event where tenant_id = $1 and action = 'tenant.provisioning_retry' and reason is not null", [tenantId])).toBe(1);
    });

    it('answers 428 without If-Match, 409 VERSION_CONFLICT with the current version, 409 TENANT_STATE_INVALID for a tenant that is not Failed and 404 for an unknown tenant', async () => {
      const { tenantId, version } = await failedTenant();
      expect((await retry(tenantId)).status).toBe(428);
      const stale = await retry(tenantId, { ifMatch: `"${version - 1}"` });
      expect([stale.status, stale.json.code, stale.json.current_version]).toEqual([409, 'VERSION_CONFLICT', version]);
      const active = await harness.request();
      const notFailed = await retry(active.tenantId, { ifMatch: '"1"' });
      expect([notFailed.status, notFailed.json.code]).toEqual([409, 'TENANT_STATE_INVALID']);
      expect((await retry(OTHER_TENANT, { ifMatch: '"1"' })).status).toBe(404);
    });

    it('refuses a realm role without system.tenant.manage', async () => {
      const { tenantId, version } = await failedTenant();
      expect((await retry(tenantId, { ifMatch: `"${version}"`, roles: ['PlatformOperator'] })).status).toBe(403);
    });
  });

  describe('generated matrix: every control operation against every realm role', () => {
    // The license commands need a signing key and a license to name: apps/api/test/licenses.test.ts runs the matrix for them; the theme operations need a theme (apps/api/test/theme.test.ts), the plan operations a plan (apps/api/test/plans.test.ts), the subscription operations a subscription (apps/api/test/subscriptions.test.ts), the override operations an override (apps/api/test/entitlement-overrides.test.ts) and the owner assignment a provisioned tenant (apps/api/test/tenant-owner.test.ts).
    const tenantOperations = CONTROL_OPERATIONS.filter((operation) => !operation.path.includes('licenses') && !operation.path.includes('/theme/') && !operation.path.includes('/system/plans') && !operation.path.includes('ubscription') && !operation.path.includes('entitlement-overrides') && !operation.path.includes('/system/invoices') && !operation.path.includes('billing-runs') && !operation.path.includes('/system/payments') && !operation.path.startsWith('/support-access') && !operation.path.endsWith('/offboard') && !operation.path.endsWith('/archive') && !operation.path.endsWith('/exports') && !operation.path.endsWith('/owners'));
    const cases = controlCasesFor(tenantOperations);
    const matrixPayload = (operationId: string): Record<string, unknown> => {
      if (operationId === 'retryTenantProvisioning') return { reason: 'Matrix case, retry after a failure.' };
      if (operationId === 'suspendTenant') return { reason_code: 'NON_PAYMENT', reason: 'Matrix case, the invoice is overdue.', access_policy: 'READ_ONLY_EXPORT' };
      if (operationId === 'resumeTenant') return { reason: 'Matrix case, the invoice was paid.' };
      return body();
    };

    it.each(cases.map((matrixCase) => [matrixCase.id, matrixCase] as const))('%s', async (_id, matrixCase) => {
      const operation = tenantOperations.find((candidate) => candidate.operationId === matrixCase.operationId);
      if (operation === undefined) throw new Error('operation of the case is not listed');
      const created = await harness.request();
      await harness.registry.transition(created.tenantId, 'Requested', 'Provisioning');
      // The commands of the lifecycle need a tenant in the state they start from.
      const target = operation.operationId === 'retryTenantProvisioning' ? 'Failed' : 'Active';
      await harness.registry.transition(created.tenantId, 'Provisioning', target);
      if (operation.operationId === 'resumeTenant') {
        await harness.admin((client) =>
          client.query("update machvon.tenant set status = 'Suspended', lifecycle_reason = 'NON_PAYMENT', suspended_at = now(), version = version + 1 where id = $1", [created.tenantId]),
        );
      }
      const version = (await harness.registry.getTenant(created.tenantId))?.version ?? 0;
      const path = operation.path.replace('{tenantId}', created.tenantId);
      const deniedBefore = await harness.count("select count(*) as n from machvon.audit_event where tenant_id = $1 and outcome = 'DENIED' and action = $2", [PLATFORM_TENANT_ID, `authz.denied:${operation.operationId}`]);
      const reply = await call(operation.method, path, {
        roles: [matrixCase.role],
        payload: matrixPayload(operation.operationId),
        ifMatch: operation.operationId === 'requestTenantProvisioning' ? undefined : `"${version}"`,
      });
      if (matrixCase.expected === 'allow') {
        expect(reply.status).toBeLessThan(300);
        return;
      }
      expect([reply.status, reply.json.code]).toEqual([403, 'SCOPE_DENIED']);
      if (operation.method === 'POST') {
        expect(await harness.count("select count(*) as n from machvon.audit_event where tenant_id = $1 and outcome = 'DENIED' and action = $2", [PLATFORM_TENANT_ID, `authz.denied:${operation.operationId}`])).toBe(deniedBefore + 1);
      }
      const unchanged: Record<string, string> = { retryTenantProvisioning: 'Failed', suspendTenant: 'Active', resumeTenant: 'Suspended' };
      const expectedStatus = unchanged[operation.operationId];
      if (expectedStatus !== undefined) expect((await harness.registry.getTenant(created.tenantId))?.status).toBe(expectedStatus);
    });

    it('turns red when a role is allowed that the table does not allow (negative control)', () => {
      const wrong = cases.find((matrixCase) => matrixCase.operationId === 'requestTenantProvisioning' && matrixCase.role === 'SupportOperator');
      expect(wrong?.expected).toBe('deny');
    });
  });

  describe('the outbox event starts the saga exactly once', () => {
    function deliveryOf(row: { id: string; tenant_id: string; type: string; payload: Record<string, unknown> }, key: Buffer = RELAY_KEY, tenantOverride?: string): ProvisioningDelivery {
      return {
        id: row.id,
        tenantId: row.tenant_id,
        tenantContext: signTenantContext({ tenantId: tenantOverride ?? row.tenant_id, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, key),
        type: row.type,
        payload: row.payload,
      };
    }

    it('relays the event, delivers it three times, and runs the steps of the tenant once', async () => {
      const reply = await request(body({ platform_subdomain: 'via-relay' }));
      const tenantId = reply.json.tenant_id as string;
      const handled: string[] = [];
      const relay = new OutboxRelay(
        relayPool,
        async (delivery: OutboxDelivery) => {
          if (delivery.tenantId !== tenantId) return;
          // The relay hands the event over; the broker may repeat it, and so does this test.
          for (let times = 0; times < 3; times += 1) handled.push(await consumer.handle(delivery as unknown as ProvisioningDelivery));
        },
        { signingKey: RELAY_KEY },
      );
      await relay.runOnce();
      await runner.idle();

      expect(handled).toEqual(['processed', 'duplicate', 'duplicate']);
      const detail = await harness.registry.getDetail(tenantId);
      expect(detail?.tenant.status).toBe('Provisioning');
      expect(detail?.run?.steps.RLS_SEED.status).toBe('DONE');
      expect(ports.callsTo('idp.ensureOrganization')).toBeGreaterThanOrEqual(1);
      expect([...ports.organizations].filter((alias) => alias === detail?.tenant.code)).toHaveLength(1);
      expect(await harness.count("select count(*) as n from machvon.integration_event_inbox where tenant_id = $1 and provider = $2", [tenantId, `consumer:${PROVISIONING_CONSUMER}`])).toBe(1);
    });

    it('ignores other event types and a payload without a valid attempt', async () => {
      const created = await harness.request();
      const base = { id: randomUUID(), tenant_id: created.tenantId, type: TENANT_REQUESTED_EVENT, payload: { attempt: 1 } };
      expect(await consumer.handle(deliveryOf({ ...base, type: 'sas.tenant.status_changed.v1' }))).toBe('ignored');
      expect(await consumer.handle(deliveryOf({ ...base, payload: {} }))).toBe('ignored');
      expect(await consumer.handle(deliveryOf({ ...base, payload: { attempt: 0 } }))).toBe('ignored');
      expect(await consumer.handle(deliveryOf({ ...base, payload: { attempt: 'one' } }))).toBe('ignored');
      await runner.idle();
      expect((await harness.registry.getTenant(created.tenantId))?.status).toBe('Requested');
    });

    it('refuses a delivery whose tenant context is for another tenant and raises the tamper alert', async () => {
      const created = await harness.request();
      const row = { id: randomUUID(), tenant_id: created.tenantId, type: TENANT_REQUESTED_EVENT, payload: { attempt: 1 } };
      await expect(consumer.handle(deliveryOf(row, RELAY_KEY, OTHER_TENANT))).rejects.toMatchObject({ code: 'TENANT_CONTEXT_INVALID' });
      expect(alerts.raised.some((alert) => alert.code === 'OUTBOX_CONTEXT_TAMPERED')).toBe(true);
      await runner.idle();
      expect((await harness.registry.getTenant(created.tenantId))?.status).toBe('Requested');
    });

    it('resumes the unfinished runs after a restart, once, however often it is asked', async () => {
      const created = await harness.request({ platformSubdomain: 'resume-me' });
      const started = await resumeUnfinishedRuns(harness.registry, saga, runner);
      expect(started).toBeGreaterThanOrEqual(1);
      await resumeUnfinishedRuns(harness.registry, saga, runner);
      await runner.idle();
      const detail = await harness.registry.getDetail(created.tenantId);
      expect(detail?.run?.steps.RLS_SEED.status).toBe('DONE');
      expect(detail?.tenant.status).toBe('Provisioning');
    });
  });
});
