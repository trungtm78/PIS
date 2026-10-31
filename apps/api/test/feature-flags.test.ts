import { randomBytes, randomUUID } from 'node:crypto';
import { EffectiveAccessStore, FeatureFlagStore, InMemoryAuthzCache, PLATFORM_TENANT_ID } from '@machvon/db';
import { DECLARED_FLAGS, loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { AppModule } from '../src/app.module';
import { CLAIMS_HEADER, TENANT_HEADER } from './isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from './isolation/test-app';
import type { RunningApp } from './isolation/test-app';
import { CONTROL_OPERATIONS, controlCasesFor } from './authz/control-matrix';
import { ProvisioningHarness } from './provisioning/provisioning-fixtures';

const SIGNING_KEY = randomBytes(32);
const CONTROL_MEMBER = '00000000-0000-4000-8000-0000000000c9';
const REASON = 'Staged rollout to the pilot cohort of tenants.';
const FLAG = 'sas.silo_promotion';
const OTHER_FLAG = 'sas.tenant_restore_in_place';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

interface Flag {
  flag_key: string;
  status: string;
  rollout: { tenant_cohorts: string[]; tenant_ids: string[]; percentage: number };
  revision: number;
  version: number;
  updated_by: string;
}

describe('release flags over HTTP (ST-SAS-020, SAS 3.11, SAS-20)', () => {
  const harness = new ProvisioningHarness();
  const store = new FeatureFlagStore();
  let app: RunningApp;
  let tenantA = '';
  let tenantB = '';
  let regionA = '';

  async function call(method: string, path: string, options: { roles?: string[]; audience?: string; payload?: unknown; ifMatch?: string; tenant?: string; key?: string } = {}): Promise<Reply> {
    const tenantId = PLATFORM_TENANT_ID;
    const token = signTenantContext({ tenantId, membershipId: CONTROL_MEMBER, scopeVersion: 0 }, SIGNING_KEY);
    const headers: Record<string, string> = { [TENANT_HEADER]: token, 'content-type': 'application/json' };
    headers[CLAIMS_HEADER] = JSON.stringify({ aud: options.audience ?? 'control', roles: options.roles ?? ['SystemAdmin'] });
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${path}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.payload ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const flags = async (): Promise<Flag[]> => (await call('GET', '/system/feature-flags')).json.items as Flag[];
  const flagOf = async (key: string): Promise<Flag> => (await flags()).find((flag) => flag.flag_key === key) as Flag;
  const update = (key: string, payload: Record<string, unknown>, ifMatch: string | number, options: { roles?: string[] } = {}): Promise<Reply> =>
    call('PUT', `/system/feature-flags/${key}`, { payload: { reason: REASON, ...payload }, ifMatch: `"${ifMatch}"`, ...options });
  // What a tenant sees: the flags that are on for it (the route of the tenant plane, getMyFeatureFlags, is read in my-feature-flags.test.ts).
  const seen = async (tenant: string): Promise<Record<string, boolean>> => Object.fromEntries((await harness.control.withControl((tx) => store.enabledFor(tx, tenant))).map((flag) => [flag.key, flag.enabled]));
  const rows = async (sql: string, params: unknown[] = []) => (await harness.admin((client) => client.query(sql, params))).rows as Array<Record<string, unknown>>;

  beforeAll(async () => {
    await harness.start();
    const a = await harness.request();
    const b = await harness.request();
    tenantA = a.tenantId;
    tenantB = b.tenantId;
    await harness.registry.transition(tenantA, 'Requested', 'Provisioning');
    await harness.registry.transition(tenantA, 'Provisioning', 'Active');
    await harness.registry.transition(tenantB, 'Requested', 'Provisioning');
    await harness.registry.transition(tenantB, 'Provisioning', 'Active');
    // The two tenants are in different cohorts: a cohort is the region of the placement of the tenant.
    await harness.admin((client) => client.query("update machvon.tenant set region = 'vn-pilot' where id = $1", [tenantA]));
    await harness.admin((client) => client.query("update machvon.tenant set region = 'vn-other' where id = $1", [tenantB]));
    regionA = 'vn-pilot';
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

  it('holds the flags the code declares, all Off at revision 1, and the same keys as the migration wrote', async () => {
    const all = await flags();
    expect(all.map((flag) => flag.flag_key)).toEqual(DECLARED_FLAGS.map((flag) => flag.key).sort());
    expect(all.every((flag) => flag.status === 'Off' && flag.revision === 1 && flag.version === 1)).toBe(true);
    expect(all[0]).toMatchObject({ rollout: { tenant_cohorts: [], tenant_ids: [], percentage: 0 } });
    expect(await seen(tenantA)).toEqual({ [FLAG]: false, [OTHER_FLAG]: false });
  });

  it('UAT-AC170: after a rollout to the pilot cohort tenant A sees the feature and tenant B does not; a stale If-Match is 409 and changes nothing', async () => {
    const rolled = await update(FLAG, { status: 'Rollout', rollout: { tenant_cohorts: [regionA] } }, 1);
    expect(rolled.status).toBe(200);
    expect(rolled.json).toMatchObject({ status: 'Rollout', resource_version: 2 });
    expect(await flagOf(FLAG)).toMatchObject({ status: 'Rollout', revision: 2, version: 2, rollout: { tenant_cohorts: [regionA], tenant_ids: [], percentage: 0 }, updated_by: CONTROL_MEMBER });
    expect(await seen(tenantA)).toEqual({ [FLAG]: true, [OTHER_FLAG]: false });
    expect(await seen(tenantB)).toEqual({ [FLAG]: false, [OTHER_FLAG]: false });
    const stale = await update(FLAG, { status: 'On' }, 1);
    expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
    expect(await flagOf(FLAG)).toMatchObject({ status: 'Rollout', version: 2 });
    const missing = await call('PUT', `/system/feature-flags/${FLAG}`, { payload: { status: 'On', reason: REASON } });
    expect(missing.status).toBe(428);
    const audit = await rows("select safe_diff, reason, tenant_id from machvon.audit_event where action = 'feature_flag.updated' and outcome = 'SUCCESS' and resource_id = $1", [(await flagOf(FLAG)).flag_key === FLAG ? ((await rows('select id from machvon.feature_flag where flag_key = $1', [FLAG]))[0]?.id as string) : '']);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ reason: REASON, tenant_id: PLATFORM_TENANT_ID, safe_diff: { flag_key: FLAG, from_status: 'Off', to_status: 'Rollout', revision: 2, cohorts: [regionA], tenant_count: 0, percentage: 0 } });
    const events = await rows("select payload from machvon.outbox_event where type = 'sas.feature_flag.changed.v1'");
    expect(events.map((event) => event.payload)).toContainEqual(expect.objectContaining({ flag_key: FLAG, from_status: 'Off', to_status: 'Rollout', revision: 2 }));
  });

  it('rolls out to tenants named one by one and to a share by a stable bucket, and widens it on the next revision', async () => {
    const current = await flagOf(OTHER_FLAG);
    const named = await update(OTHER_FLAG, { status: 'Rollout', rollout: { tenant_ids: [tenantB] } }, current.version);
    expect(named.status).toBe(200);
    expect(await seen(tenantB)).toEqual({ [FLAG]: false, [OTHER_FLAG]: true });
    expect((await seen(tenantA))[OTHER_FLAG]).toBe(false);
    const share = await update(OTHER_FLAG, { status: 'Rollout', rollout: { percentage: 100 } }, 2);
    expect(share.json.resource_version).toBe(3);
    expect(await seen(tenantA)).toEqual({ [FLAG]: true, [OTHER_FLAG]: true });
    const nothing = await update(OTHER_FLAG, { status: 'Rollout', rollout: { percentage: 0 } }, 3);
    expect([nothing.status, nothing.json.code]).toEqual([422, 'FLAG_RULE_INVALID']);
    const on = await update(OTHER_FLAG, { status: 'On' }, 3);
    expect(on.status).toBe(200);
    expect(await flagOf(OTHER_FLAG)).toMatchObject({ status: 'On', revision: 4, rollout: { tenant_cohorts: [], tenant_ids: [], percentage: 0 } });
    expect((await seen(tenantB))[OTHER_FLAG]).toBe(true);
    const off = await update(OTHER_FLAG, { status: 'Off' }, 4);
    expect(off.status).toBe(200);
    expect(await seen(tenantA)).toEqual({ [FLAG]: true, [OTHER_FLAG]: false });
  });

  it('refuses a rule that is not one (422 FLAG_RULE_INVALID) and writes nothing', async () => {
    const before = await flagOf(FLAG);
    const bodies: Array<Record<string, unknown>> = [
      { status: 'Rollout' },
      { status: 'On', rollout: { tenant_cohorts: ['pilot'] } },
      { status: 'Rollout', rollout: { tenant_cohorts: ['Not A Cohort'] } },
    ];
    for (const body of bodies) {
      const reply = await update(FLAG, body, before.version);
      expect([JSON.stringify(body), reply.status, reply.json.code]).toEqual([JSON.stringify(body), 422, 'FLAG_RULE_INVALID']);
    }
    // What the schema of the request refuses never reaches the rule.
    for (const body of [{ status: 'Rollout', rollout: { tenant_ids: ['x'] } }, { status: 'Rollout', rollout: { percentage: 101 } }, { status: 'Rollout', rollout: { percentage: 5.5 } }, { status: 'On', reason: 'short' }]) {
      const malformed = await update(FLAG, body, before.version);
      expect([JSON.stringify(body), malformed.status >= 400 && malformed.status <= 422, ['VALIDATION_FAILED', 'INVALID_REQUEST'].includes(malformed.json.code as string)]).toEqual([JSON.stringify(body), true, true]);
    }
    expect((await update(FLAG, { status: 'Sometimes' }, before.version)).status).toBeGreaterThanOrEqual(400);
    expect(await flagOf(FLAG)).toEqual(before);
  });

  it('answers 404 for a flag the code does not declare, and treats a retired flag as final', async () => {
    expect((await update('sas.no_such_flag', { status: 'On' }, 1)).status).toBe(404);
    expect((await update('NOT A KEY', { status: 'On' }, 1)).status).toBe(404);
    const current = await flagOf(OTHER_FLAG);
    expect((await update(OTHER_FLAG, { status: 'Retired' }, current.version)).status).toBe(200);
    expect((await seen(tenantA))[OTHER_FLAG]).toBe(false);
    const retired = await flagOf(OTHER_FLAG);
    const again = await update(OTHER_FLAG, { status: 'On' }, retired.version);
    expect([again.status, again.json.code]).toEqual([422, 'FLAG_RULE_INVALID']);
    expect(await flagOf(OTHER_FLAG)).toEqual(retired);
  });

  it('is kept by the database as well: a flag keeps its key, moves one revision at a time, names whom a rollout is on for, is never deleted and a retired one never changes', async () => {
    const attempt = async (sql: string, params: unknown[] = []): Promise<string> => {
      try {
        await harness.admin((client) => client.query(sql, params));
        return 'written';
      } catch (error) {
        return (error as { message: string }).message;
      }
    };
    expect(await attempt("update machvon.feature_flag set flag_key = 'sas.renamed_flag' where flag_key = $1", [FLAG])).toContain('keeps its key');
    expect(await attempt('update machvon.feature_flag set revision = revision + 5 where flag_key = $1', [FLAG])).toContain('one revision at a time');
    expect(await attempt("update machvon.feature_flag set status = 'On', rollout_json = '{\"tenant_cohorts\": [\"pilot\"], \"tenant_ids\": [], \"percentage\": 0}'::jsonb, revision = revision + 1 where flag_key = $1", [FLAG])).toContain('feature_flag_names_chk');
    expect(await attempt("update machvon.feature_flag set rollout_json = '{}'::jsonb, revision = revision + 1 where flag_key = $1", [FLAG])).toContain('feature_flag_rollout_chk');
    expect(await attempt("update machvon.feature_flag set description = 'x', revision = revision + 1 where flag_key = $1", [OTHER_FLAG])).toContain('never changed');
    const control = await harness.admin((client) => client.query("select has_table_privilege('machvon_control', 'machvon.feature_flag', 'DELETE') as can_delete, has_table_privilege('machvon_control', 'machvon.feature_flag', 'INSERT') as can_insert"));
    expect(control.rows[0]).toEqual({ can_delete: false, can_insert: false });
  });

  describe('generated matrix: every flag operation against every realm role', () => {
    const operations = CONTROL_OPERATIONS.filter((operation) => operation.path.startsWith('/system/feature-flags'));
    const cases = controlCasesFor(operations);

    it('lists the two flag operations of the registry, which only the System Admin holds', () => {
      expect(operations.map((operation) => operation.operationId).sort()).toEqual(['listFeatureFlags', 'updateFeatureFlag']);
      expect(cases.filter((matrixCase) => matrixCase.expected === 'allow').map((matrixCase) => matrixCase.role)).toEqual(['SystemAdmin', 'SystemAdmin']);
    });

    it.each(cases.map((matrixCase) => [matrixCase.id, matrixCase] as const))('%s', async (_id, matrixCase) => {
      const operation = operations.find((candidate) => candidate.operationId === matrixCase.operationId);
      if (operation === undefined) throw new Error('operation of the case is not listed');
      const before = await flagOf(FLAG);
      const deniedBefore = Number((await rows("select count(*) as n from machvon.audit_event where tenant_id = $1 and outcome = 'DENIED' and action = $2", [PLATFORM_TENANT_ID, `authz.denied:${operation.operationId}`]))[0]?.n);
      const roles = [matrixCase.role];
      const reply = operation.operationId === 'listFeatureFlags' ? await call('GET', '/system/feature-flags', { roles }) : await update(FLAG, { status: 'On' }, before.version, { roles });
      if (matrixCase.expected === 'allow') {
        expect(reply.status).toBeLessThan(300);
        return;
      }
      expect([reply.status, reply.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect(await flagOf(FLAG)).toEqual(before);
      if (operation.method === 'PUT') {
        const deniedAfter = Number((await rows("select count(*) as n from machvon.audit_event where tenant_id = $1 and outcome = 'DENIED' and action = $2", [PLATFORM_TENANT_ID, `authz.denied:${operation.operationId}`]))[0]?.n);
        expect(deniedAfter).toBe(deniedBefore + 1);
      }
    });
  });
});
