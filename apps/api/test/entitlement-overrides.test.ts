import { randomBytes, randomUUID } from 'node:crypto';
import { EffectiveAccessStore, EntitlementStore, InMemoryAuthzCache, InMemoryEntitlementCache, PLATFORM_TENANT_ID, recordEntitlementVersion } from '@machvon/db';
import { STANDARD_FEATURES, loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { AppModule } from '../src/app.module';
import { CONTROL_OPERATIONS, controlCasesFor } from './authz/control-matrix';
import { CLAIMS_HEADER, TENANT_HEADER } from './isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from './isolation/test-app';
import type { RunningApp } from './isolation/test-app';
import { ProvisioningHarness } from './provisioning/provisioning-fixtures';

const SIGNING_KEY = randomBytes(32);
// Two different administrators: the one who asks and the one who decides (four eyes).
const REQUESTER = '00000000-0000-4000-8000-0000000000c9';
const APPROVER = '00000000-0000-4000-8000-0000000000ca';
const PLAN = '00000000-0000-4000-9000-000000000001';
const REASON = 'Tạm dừng do vượt ngân sách AI';
const DAY_MS = 86_400_000;

interface Reply {
  status: number;
  headers: Headers;
  json: Record<string, unknown>;
}

interface CallOptions {
  operator?: string;
  roles?: string[];
  audience?: string;
  payload?: unknown;
  key?: string;
  ifMatch?: string;
}

const isoIn = (days: number): string => new Date(Date.now() + days * DAY_MS).toISOString();

describe('entitlement overrides over HTTP (ST-SAS-009)', () => {
  const harness = new ProvisioningHarness();
  let app: RunningApp;
  let gate: EntitlementStore;

  const admin = async <T extends object = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> => harness.admin(async (client) => (await client.query(text, params)).rows as T[]);

  async function call(method: string, path: string, options: CallOptions = {}): Promise<Reply> {
    const token = signTenantContext({ tenantId: PLATFORM_TENANT_ID, membershipId: options.operator ?? REQUESTER, scopeVersion: 0 }, SIGNING_KEY);
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

  /** An Active tenant that already has its first entitlement version (the STANDARD plan). */
  async function tenant(): Promise<string> {
    const created = await harness.request();
    await harness.registry.transition(created.tenantId, 'Requested', 'Provisioning');
    await harness.registry.transition(created.tenantId, 'Provisioning', 'Active');
    await harness.tenants.withTenant({ tenantId: created.tenantId, membershipId: REQUESTER, scopeVersion: 1 }, (tx) =>
      recordEntitlementVersion(tx, { cause: 'PROVISIONING', planVersionId: PLAN, features: STANDARD_FEATURES }),
    );
    return created.tenantId;
  }

  const body = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ feature_code: 'reporting', enabled: false, valid_from: isoIn(-1), valid_until: isoIn(30), reason: REASON, ...overrides });
  const ask = (tenantId: string, overrides: Record<string, unknown> = {}, options: CallOptions = {}): Promise<Reply> =>
    call('POST', `/system/tenants/${tenantId}/entitlement-overrides`, { ...options, payload: body(overrides) });
  const decide = (id: string, decision: string, options: CallOptions = {}): Promise<Reply> =>
    call('POST', `/system/entitlement-overrides/${id}/decision`, { operator: APPROVER, ifMatch: '"1"', ...options, payload: { decision, reason: 'Đã kiểm tra ngân sách AI', evidence_ids: [] } });
  const revoke = (id: string, options: CallOptions = {}): Promise<Reply> => call('POST', `/system/entitlement-overrides/${id}/revoke`, { ifMatch: '"1"', ...options, payload: { reason: 'Không còn cần ghi đè' } });
  const listOf = (tenantId: string, query = ''): Promise<Reply> => call('GET', `/system/tenants/${tenantId}/entitlement-overrides${query}`);

  const rowOf = async (id: string): Promise<{ status: string; version: string; approved_by: string | null; requested_by: string; tenant_id: string } | undefined> =>
    (await admin<{ status: string; version: string; approved_by: string | null; requested_by: string; tenant_id: string }>('select status, version::text as version, approved_by, requested_by, tenant_id from machvon.entitlement_override where id = $1', [id]))[0];
  const versions = async (tenantId: string): Promise<Array<{ cause: string }>> =>
    admin<{ cause: string }>('select cause from machvon.entitlement_version where tenant_id = $1 order by machvon.entitlement_version.version_no', [tenantId]);
  const auditRows = (action: string, id: string): Promise<Array<{ tenant_id: string; reason: string | null; safe_diff: Record<string, unknown> }>> =>
    admin("select tenant_id, reason, safe_diff from machvon.audit_event where action = $1 and resource_id = $2 and outcome = 'SUCCESS'", [action, id]);
  const allowed = (tenantId: string, feature: string): Promise<{ allowed: boolean }> => gate.allowedFromDatabase({ tenantId, membershipId: REQUESTER, scopeVersion: 1 }, feature, 'read');

  beforeAll(async () => {
    await harness.start();
    gate = new EntitlementStore(harness.tenants, new InMemoryEntitlementCache());
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

  describe('requestEntitlementOverride', () => {
    it('answers 201 PENDING_APPROVAL, writes the request on the tenant with its requester and tells nobody yet', async () => {
      const tenantId = await tenant();
      const before = await versions(tenantId);
      const reply = await ask(tenantId);
      expect(reply.status).toBe(201);
      expect(reply.json).toMatchObject({ status: 'PENDING_APPROVAL', resource_version: 1 });
      const id = reply.json.resource_id as string;
      expect(await rowOf(id)).toMatchObject({ status: 'PendingApproval', version: '1', approved_by: null, requested_by: REQUESTER, tenant_id: tenantId });
      expect(await versions(tenantId)).toHaveLength(before.length);
      expect(await allowed(tenantId, 'reporting')).toEqual({ allowed: true });
      const rows = await auditRows('entitlement_override.requested', id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ tenant_id: tenantId, reason: REASON });
      expect(rows[0]?.safe_diff).toMatchObject({ feature_code: 'reporting', enabled: false });
    });

    it('replays the answer of the same idempotency key without writing a second request', async () => {
      const tenantId = await tenant();
      const key = `ask-${randomUUID()}`;
      // The same body, so the same window: the default one is worked out from the clock at each call.
      const window = { valid_from: isoIn(-1), valid_until: isoIn(30) };
      const first = await ask(tenantId, window, { key });
      const replayed = await ask(tenantId, window, { key });
      expect(replayed.json).toEqual(first.json);
      expect((await listOf(tenantId)).json.items).toHaveLength(1);
    });

    it('refuses a feature no plan sells with 422 FEATURE_UNKNOWN, and every other fault with 422 VALIDATION_FAILED naming the field', async () => {
      const tenantId = await tenant();
      const unknown = await ask(tenantId, { feature_code: 'ai.magic' });
      expect([unknown.status, unknown.json.code, unknown.json.detail]).toEqual([422, 'FEATURE_UNKNOWN', 'feature_code']);
      const short = await ask(tenantId, { reason: 'short' });
      expect([short.status, short.json.code, short.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'reason']);
      const over = await ask(tenantId, { valid_from: isoIn(-5), valid_until: isoIn(-1) });
      expect([over.status, over.json.code, over.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'valid_until']);
      const inverted = await ask(tenantId, { valid_from: isoIn(3), valid_until: isoIn(2) });
      expect([inverted.status, inverted.json.code, inverted.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'valid_until']);
      const long = await ask(tenantId, { valid_from: isoIn(0), valid_until: isoIn(400) });
      expect([long.status, long.json.code, long.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'valid_until']);
      const limit = await ask(tenantId, { enabled: false, limit_value: '5' });
      expect([limit.status, limit.json.code, limit.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'limit_value']);
      expect((await listOf(tenantId)).json.items).toEqual([]);
    });

    it('refuses a member the contract does not have (400) and a tenant that does not exist (404)', async () => {
      const tenantId = await tenant();
      expect((await ask(tenantId, { surprise: 1 })).status).toBe(400);
      expect((await ask(tenantId, { valid_until: 'soon' })).status).toBeGreaterThanOrEqual(400);
      const missing = await ask(randomUUID());
      expect([missing.status, missing.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
    });
  });

  describe('decideEntitlementOverride (UAT-AC157, UAT-AC158)', () => {
    it('puts the override in force once a second administrator approves it: the entitlement gate denies the feature at once and the tenant gets a new version (AC-ST-SAS-009-1)', async () => {
      const tenantId = await tenant();
      const asked = await ask(tenantId, { feature_code: 'reporting', enabled: false });
      const id = asked.json.resource_id as string;
      expect(await allowed(tenantId, 'reporting')).toEqual({ allowed: true });
      const before = await versions(tenantId);
      const reply = await decide(id, 'approve');
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ status: 'ACTIVE', resource_version: 2, resource_id: id });
      expect(await rowOf(id)).toMatchObject({ status: 'Active', version: '2', approved_by: APPROVER, requested_by: REQUESTER });
      const after = await versions(tenantId);
      expect(after).toHaveLength(before.length + 1);
      expect(after[after.length - 1]?.cause).toBe('OVERRIDE');
      expect(await allowed(tenantId, 'reporting')).toMatchObject({ allowed: false });
      const events = await admin<{ n: string }>("select count(*) as n from machvon.outbox_event where tenant_id = $1 and type = 'sas.entitlement.changed.v1'", [tenantId]);
      expect(Number(events[0]?.n)).toBe(after.length);
      const rows = await auditRows('entitlement_override.approved', id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ tenant_id: tenantId });
      expect(rows[0]?.safe_diff).toMatchObject({ status: 'Active', requested_by: REQUESTER, approved_by: APPROVER });
    });

    it('refuses the person who asked: 403 SELF_APPROVAL_DENIED, the request still waits and no version is recorded (AC-ST-SAS-009-2)', async () => {
      const tenantId = await tenant();
      const id = (await ask(tenantId)).json.resource_id as string;
      const before = await versions(tenantId);
      const reply = await decide(id, 'approve', { operator: REQUESTER });
      expect([reply.status, reply.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      const rejection = await decide(id, 'reject', { operator: REQUESTER });
      expect([rejection.status, rejection.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      expect(await rowOf(id)).toMatchObject({ status: 'PendingApproval', version: '1', approved_by: null });
      expect(await versions(tenantId)).toHaveLength(before.length);
      expect(await allowed(tenantId, 'reporting')).toEqual({ allowed: true });
    });

    it('holds the same rule in the database, whatever the application checked first: no approver who is the requester', async () => {
      const tenantId = await tenant();
      const id = (await ask(tenantId)).json.resource_id as string;
      await expect(admin("update machvon.entitlement_override set status = 'Active', approved_by = requested_by where id = $1", [id])).rejects.toMatchObject({ code: '23514' });
      expect((await rowOf(id))?.status).toBe('PendingApproval');
    });

    it('turns a request down without telling the tenant anything', async () => {
      const tenantId = await tenant();
      const id = (await ask(tenantId)).json.resource_id as string;
      const before = await versions(tenantId);
      const reply = await decide(id, 'reject');
      expect([reply.status, reply.json.status, reply.json.resource_version]).toEqual([200, 'REJECTED', 2]);
      expect(await rowOf(id)).toMatchObject({ status: 'Rejected', approved_by: null });
      expect(await versions(tenantId)).toHaveLength(before.length);
      expect(await auditRows('entitlement_override.rejected', id)).toHaveLength(1);
    });

    it('has no "return for rework": 422 for it, and a change of mind is a new request', async () => {
      const tenantId = await tenant();
      const id = (await ask(tenantId)).json.resource_id as string;
      const reply = await decide(id, 'return');
      expect([reply.status, reply.json.code, reply.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'decision']);
      expect(await rowOf(id)).toMatchObject({ status: 'PendingApproval', version: '1' });
    });

    it('answers 428 without If-Match, 409 VERSION_CONFLICT with a stale one, 409 STAGE_TRANSITION_DENIED for one already decided and 404 for none', async () => {
      const tenantId = await tenant();
      const id = (await ask(tenantId)).json.resource_id as string;
      const missing = await call('POST', `/system/entitlement-overrides/${id}/decision`, { operator: APPROVER, payload: { decision: 'approve', reason: 'Đã kiểm tra', evidence_ids: [] } });
      expect([missing.status, missing.json.code]).toEqual([428, 'PRECONDITION_REQUIRED']);
      const stale = await decide(id, 'approve', { ifMatch: '"7"' });
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      expect((await decide(id, 'approve')).status).toBe(200);
      const again = await decide(id, 'approve', { ifMatch: '"2"' });
      expect([again.status, again.json.code]).toEqual([409, 'STAGE_TRANSITION_DENIED']);
      const none = await decide(randomUUID(), 'approve');
      expect([none.status, none.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
    });

    it('refuses a request whose window ended while it waited: 422, it still waits', async () => {
      const tenantId = await tenant();
      const id = (await ask(tenantId, { valid_from: isoIn(-1), valid_until: isoIn(1) })).json.resource_id as string;
      await admin("alter table machvon.entitlement_override disable trigger entitlement_override_guard");
      try {
        await admin("update machvon.entitlement_override set valid_from = now() - interval '3 days', valid_until = now() - interval '1 day' where id = $1", [id]);
      } finally {
        await admin('alter table machvon.entitlement_override enable trigger entitlement_override_guard');
      }
      const reply = await decide(id, 'approve');
      expect([reply.status, reply.json.code, reply.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'valid_until']);
      expect((await rowOf(id))?.status).toBe('PendingApproval');
    });
  });

  describe('revokeEntitlementOverride', () => {
    it('ends an override in force at once, keeps its approver, and gives the feature back with a new entitlement version', async () => {
      const tenantId = await tenant();
      const id = (await ask(tenantId)).json.resource_id as string;
      await decide(id, 'approve');
      expect(await allowed(tenantId, 'reporting')).toMatchObject({ allowed: false });
      const before = await versions(tenantId);
      const reply = await revoke(id, { ifMatch: '"2"', operator: APPROVER });
      expect([reply.status, reply.json.status, reply.json.resource_version]).toEqual([200, 'REVOKED', 3]);
      expect(await rowOf(id)).toMatchObject({ status: 'Revoked', approved_by: APPROVER });
      expect(await versions(tenantId)).toHaveLength(before.length + 1);
      expect(await allowed(tenantId, 'reporting')).toEqual({ allowed: true });
      expect(await auditRows('entitlement_override.revoked', id)).toHaveLength(1);
    });

    it('lets the requester withdraw a request that waits, and answers 428, 409 and 404 as the other commands do', async () => {
      const tenantId = await tenant();
      const id = (await ask(tenantId)).json.resource_id as string;
      expect((await call('POST', `/system/entitlement-overrides/${id}/revoke`, { payload: { reason: 'Không còn cần ghi đè' } })).status).toBe(428);
      const stale = await revoke(id, { ifMatch: '"9"' });
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const before = await versions(tenantId);
      const reply = await revoke(id);
      expect([reply.status, reply.json.status]).toEqual([200, 'REVOKED']);
      expect(await versions(tenantId)).toHaveLength(before.length);
      const over = await revoke(id, { ifMatch: '"2"' });
      expect([over.status, over.json.code]).toEqual([409, 'STAGE_TRANSITION_DENIED']);
      const none = await revoke(randomUUID());
      expect([none.status, none.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
    });
  });

  describe('listTenantEntitlementOverrides', () => {
    it('lists the overrides of the tenant, the latest to start first, by keyset, and none of another tenant', async () => {
      const tenantId = await tenant();
      const other = await tenant();
      const first = (await ask(tenantId, { feature_code: 'export', valid_from: isoIn(1), valid_until: isoIn(20) })).json.resource_id as string;
      const second = (await ask(tenantId, { feature_code: 'reporting', valid_from: isoIn(2), valid_until: isoIn(20) })).json.resource_id as string;
      const third = (await ask(tenantId, { feature_code: 'ai.analysis', valid_from: isoIn(3), valid_until: isoIn(20) })).json.resource_id as string;
      const foreign = (await ask(other, { valid_from: isoIn(4), valid_until: isoIn(20) })).json.resource_id as string;
      const page = await listOf(tenantId, '?limit=2');
      expect(page.status).toBe(200);
      const items = page.json.items as Array<{ id: string }>;
      expect(items.map((item) => item.id)).toEqual([third, second]);
      expect(typeof page.json.next_cursor).toBe('string');
      const rest = await listOf(tenantId, `?limit=2&cursor=${encodeURIComponent(page.json.next_cursor as string)}`);
      expect((rest.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([first]);
      expect(rest.json.next_cursor).toBeNull();
      expect((await listOf(other)).json.items).toEqual([expect.objectContaining({ id: foreign })]);
    });

    it('shows who asked, who approved, the window and the version to decide against', async () => {
      const tenantId = await tenant();
      const id = (await ask(tenantId, { feature_code: 'member.seats', enabled: true, limit_value: '150.500' })).json.resource_id as string;
      await decide(id, 'approve');
      const [item] = (await listOf(tenantId)).json.items as Array<Record<string, unknown>>;
      expect(item).toMatchObject({ id, feature_code: 'member.seats', enabled: true, limit_value: '150.5', reason: REASON, status: 'Active', requested_by: REQUESTER, approved_by: APPROVER, version: 2 });
      expect(typeof item?.valid_from).toBe('string');
      expect(typeof item?.valid_until).toBe('string');
    });

    it('answers 404 for a tenant that does not exist, and refuses the tenant plane and the roles without the read', async () => {
      const tenantId = await tenant();
      const missing = await listOf(randomUUID());
      expect([missing.status, missing.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect((await call('GET', `/system/tenants/${tenantId}/entitlement-overrides`, { audience: 'tenant', roles: ['SystemAdmin'] })).status).toBe(403);
      expect((await call('GET', `/system/tenants/${tenantId}/entitlement-overrides`, { roles: ['SupportOperator'] })).status).toBe(403);
    });
  });

  describe('generated matrix: every override operation against every realm role', () => {
    const operations = CONTROL_OPERATIONS.filter((operation) => operation.path.includes('entitlement-overrides'));
    const cases = controlCasesFor(operations);

    it('lists the four override operations of the registry', () => {
      expect(operations.map((operation) => operation.operationId).sort()).toEqual(['decideEntitlementOverride', 'listTenantEntitlementOverrides', 'requestEntitlementOverride', 'revokeEntitlementOverride']);
    });

    it.each(cases.map((matrixCase) => [matrixCase.id, matrixCase] as const))('%s', async (_id, matrixCase) => {
      const tenantId = await tenant();
      const id = (await ask(tenantId)).json.resource_id as string;
      const roles = [matrixCase.role];
      const reply =
        matrixCase.operationId === 'requestEntitlementOverride'
          ? await ask(tenantId, {}, { roles })
          : matrixCase.operationId === 'listTenantEntitlementOverrides'
            ? await call('GET', `/system/tenants/${tenantId}/entitlement-overrides`, { roles })
            : matrixCase.operationId === 'decideEntitlementOverride'
              ? await decide(id, 'approve', { roles })
              : await revoke(id, { roles });
      if (matrixCase.expected === 'allow') {
        // Allowed by the guard: whatever the command then says, it is not the refusal of the plane or the permission.
        expect(reply.json.code).not.toBe('SCOPE_DENIED');
        return;
      }
      expect([reply.status, reply.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect(await rowOf(id)).toMatchObject({ status: 'PendingApproval', version: '1' });
    });
  });
});
