import { randomBytes } from 'node:crypto';
import { Controller, Get } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ControlDatabase, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { seedSystemRoles } from '@machvon/db/src/system-roles';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { Client, Pool } from 'pg';
import { ControlFeatureFlagSource, FeatureFlagModule, NoFeatureFlags, RequiresFlag } from '../src/entitlements/feature-flag.guard';
import type { FeatureFlagSource } from '../src/entitlements/feature-flag.guard';
import { OperationId } from '../src/operation-id.decorator';
import { PolicyModule } from '../src/policy.module';
import { ProblemFilter } from '../src/problem.filter';
import { ACTOR, AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId } from '../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from './isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from './isolation/test-app';
import type { RunningApp } from './isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const PLACEMENT = '00000000-0000-4000-8000-0000000000b1';
const ALLOWED = 1; // holds session.self
const DENIED = 2; // holds nothing
const SILO = 'sas.silo_promotion';
const RESTORE = 'sas.tenant_restore_in_place';

const EXTRA_OPERATIONS = {
  test_flag_silo: { permission: 'session.self', plane: 'tenant' },
  test_flag_open: { permission: 'session.self', plane: 'tenant' },
  test_flag_whole_a: { permission: 'session.self', plane: 'tenant' },
  test_flag_whole_b: { permission: 'session.self', plane: 'tenant' },
} as const;

@Controller('flagged')
class FlaggedController {
  @Get('silo')
  @OperationId('test_flag_silo')
  @RequiresFlag(SILO)
  silo(): { ok: true } {
    return { ok: true };
  }

  @Get('open')
  @OperationId('test_flag_open')
  open(): { ok: true } {
    return { ok: true };
  }
}

@Controller('flagged-whole')
@RequiresFlag(RESTORE)
class WholeControllerBehindFlag {
  @Get('a')
  @OperationId('test_flag_whole_a')
  a(): { ok: true } {
    return { ok: true };
  }

  @Get('b')
  @OperationId('test_flag_whole_b')
  b(): { ok: true } {
    return { ok: true };
  }
}

/** Counts how often the guard asks, around the real source of the control plane. */
class CountingSource implements FeatureFlagSource {
  asked = 0;

  constructor(private readonly inner: FeatureFlagSource) {}

  isOn(tenantId: string, flagKey: string): Promise<boolean> {
    this.asked += 1;
    return this.inner.isOn(tenantId, flagKey);
  }
}

describe('a route behind a release flag (ST-KERNEL-014 AC-3, FeatureFlagGuard)', () => {
  const harness = new AuthzHarness();
  let controlPool: Pool;
  let app: RunningApp;
  let closedApp: RunningApp;
  let counting: CountingSource;

  async function admin<T extends object = object>(sql: string, params: unknown[] = []): Promise<T[]> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      return (await client.query(sql, params)).rows as T[];
    } finally {
      await client.end();
    }
  }

  const setFlag = (key: string, status: 'Off' | 'Rollout' | 'On' | 'Retired', cohorts: string[] = []): Promise<unknown[]> =>
    admin(
      'update machvon.feature_flag set status = $2, rollout_json = $3::jsonb, revision = revision + 1, version = version + 1 where flag_key = $1',
      [key, status, JSON.stringify({ tenant_cohorts: cohorts, tenant_ids: [], percentage: 0 })],
    );

  async function call(path: string, options: { tenant?: string; member?: number; on?: RunningApp } = {}): Promise<{ status: number; json: Record<string, unknown> }> {
    const token = signTenantContext(contextFor(options.tenant ?? TENANT_A, memberId(options.member ?? ALLOWED)), SIGNING_KEY);
    const response = await fetch(`${(options.on ?? app).baseUrl}${path}`, { headers: { [TENANT_HEADER]: token } });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  /** The columns of every table, view and the migrations applied: a release that changes the schema changes this. */
  async function schemaFingerprint(): Promise<{ columns: string; migrations: string }> {
    const [columns] = await admin<{ digest: string }>(
      "select md5(string_agg(table_name || '.' || column_name || ':' || data_type || ':' || is_nullable, ',' order by table_name, column_name)) as digest from information_schema.columns where table_schema = 'machvon'",
    );
    const [migrations] = await admin<{ digest: string }>("select md5(string_agg(version || checksum, ',' order by version)) as digest from machvon.schema_migration");
    return { columns: columns?.digest ?? '', migrations: migrations?.digest ?? '' };
  }

  beforeAll(async () => {
    await harness.start();
    controlPool = new Pool({ connectionString: harness.database.urlFor('machvon_control'), max: 3 });
    controlPool.on('error', () => undefined);
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: 1, path: '/u1/' }]);
      await harness.tenants.withTenant(contextFor(tenant, memberId(ALLOWED)), (tx) => seedSystemRoles(tx, ACTOR));
      await harness.seedMembership(tenant, ALLOWED, 1);
      await harness.seedMembership(tenant, DENIED, 1);
      await harness.seedRole(tenant, 70, 'SELF', ['session.self'], 10);
      await harness.seedGrants(tenant, [{ n: 1, member: ALLOWED, role: 70, kind: 'TENANT' }]);
    }
    await admin("insert into machvon.placement (id, kind, region, db_cluster_ref, kms_key_ref, status) values ($1, 'POOL', 'vn-north', 'pool-1', 'kms-1', 'Active')", [PLACEMENT]);
    await admin("insert into machvon.tenant (id, code, name, status, placement_id, region) values ($1, 'tenant-a', 'tenant-a', 'Active', $2, 'vn-pilot')", [TENANT_A, PLACEMENT]);
    await admin("insert into machvon.tenant (id, code, name, status, placement_id, region) values ($1, 'tenant-b', 'tenant-b', 'Active', $2, 'vn-other')", [TENANT_B, PLACEMENT]);
    const database = new TenantDatabase(harness.appPool);
    const filter = { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) };
    const policy = (): ReturnType<typeof PolicyModule.register> =>
      PolicyModule.register({ database, access: new EffectiveAccessStore(database, new InMemoryAuthzCache()), extraOperations: EXTRA_OPERATIONS });
    counting = new CountingSource(new ControlFeatureFlagSource(new ControlDatabase(controlPool)));
    app = await startTestApp({ signingKey: SIGNING_KEY, imports: [policy(), FeatureFlagModule.register(counting)], controllers: [FlaggedController, WholeControllerBehindFlag], providers: [filter] });
    closedApp = await startTestApp({ signingKey: SIGNING_KEY, imports: [policy(), FeatureFlagModule.register(new NoFeatureFlags())], controllers: [FlaggedController], providers: [filter] });
  }, 300_000);

  afterAll(async () => {
    await Promise.all([app?.close(), closedApp?.close()]);
    await controlPool?.end();
    await harness.stop();
  }, 60_000);

  beforeEach(async () => {
    await setFlag(SILO, 'Off');
    await setFlag(RESTORE, 'Off');
    counting.asked = 0;
  });

  it('AC-ST-KERNEL-014-3 (UAT-NFR-OPERABILITY-03) answers unavailable while the flag is off, and serves the route once it is on, with no schema change between', async () => {
    const before = await schemaFingerprint();
    const off = await call('/flagged/silo');
    expect(off.status).toBe(503);
    expect(off.json).toMatchObject({ code: 'FEATURE_UNAVAILABLE', status: 503 });
    await setFlag(SILO, 'On');
    expect(await call('/flagged/silo')).toEqual({ status: 200, json: { ok: true } });
    await setFlag(SILO, 'Off');
    expect((await call('/flagged/silo')).status).toBe(503);
    expect(await schemaFingerprint()).toEqual(before);
    expect(before.columns).not.toBe('');
    expect(before.migrations).not.toBe('');
  });

  it('AC-ST-KERNEL-014-3 (UAT-NFR-OPERABILITY-03) turns the route on for a cohort of tenants first', async () => {
    await setFlag(SILO, 'Rollout', ['vn-pilot']);
    expect((await call('/flagged/silo', { tenant: TENANT_A })).status).toBe(200);
    expect((await call('/flagged/silo', { tenant: TENANT_B })).status).toBe(503);
  });

  it('AC-ST-KERNEL-014-3 (UAT-NFR-OPERABILITY-03) puts every route of a controller behind its flag, and each flag decides only its own routes', async () => {
    await setFlag(SILO, 'On');
    expect([(await call('/flagged-whole/a')).status, (await call('/flagged-whole/b')).status]).toEqual([503, 503]);
    await setFlag(RESTORE, 'On');
    expect([(await call('/flagged-whole/a')).status, (await call('/flagged-whole/b')).status]).toEqual([200, 200]);
    await setFlag(SILO, 'Off');
    expect((await call('/flagged-whole/a')).status).toBe(200);
    expect((await call('/flagged/silo')).status).toBe(503);
  });

  it('AC-ST-KERNEL-014-3 (UAT-NFR-OPERABILITY-03) leaves a route with no flag alone and reads no flag for it', async () => {
    expect(await call('/flagged/open')).toEqual({ status: 200, json: { ok: true } });
    expect(counting.asked).toBe(0);
    await call('/flagged/silo');
    expect(counting.asked).toBe(1);
  });

  it('AC-ST-KERNEL-014-3 (UAT-NFR-OPERABILITY-03) tells a caller without the permission 403 and nothing about the flag', async () => {
    await setFlag(SILO, 'On');
    for (const state of ['On', 'Off'] as const) {
      await setFlag(SILO, state);
      const denied = await call('/flagged/silo', { member: DENIED });
      expect(denied.status).toBe(403);
      expect(denied.json.code).not.toBe('FEATURE_UNAVAILABLE');
    }
    expect(counting.asked).toBe(0);
  });

  it('AC-ST-KERNEL-014-3 (UAT-NFR-OPERABILITY-03) keeps the route closed where there is no control plane to read the flag from', async () => {
    await setFlag(SILO, 'On');
    expect((await call('/flagged/silo', { on: closedApp })).status).toBe(503);
    expect((await call('/flagged/open', { on: closedApp })).status).toBe(200);
  });

  it('AC-ST-KERNEL-014-3 (UAT-NFR-OPERABILITY-03) refuses to start with a flag the code does not declare', () => {
    expect(() => RequiresFlag('sas.not_declared')).toThrow('not a declared release flag');
    expect(() => RequiresFlag(SILO)).not.toThrow();
  });

  // Last: a retired flag is final (the database refuses any later change), so no test after this one can set a flag.
  it('AC-ST-KERNEL-014-3 (UAT-NFR-OPERABILITY-03) closes the route for good once its flag is retired', async () => {
    await setFlag(RESTORE, 'On');
    expect((await call('/flagged-whole/a')).status).toBe(200);
    await setFlag(RESTORE, 'Retired');
    expect((await call('/flagged-whole/a')).status).toBe(503);
  });
});
