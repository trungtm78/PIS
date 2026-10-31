import { randomBytes } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { ControlDatabase, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { seedSystemRoles } from '@machvon/db/src/system-roles';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { Client, Pool } from 'pg';
import { MyFeatureFlagsController } from '../src/entitlements/my-feature-flags.controller';
import { PolicyModule } from '../src/policy.module';
import { ProblemFilter } from '../src/problem.filter';
import { ACTOR, AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId } from '../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from './isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from './isolation/test-app';
import type { RunningApp } from './isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const USER = 1;
const PLACEMENT = '00000000-0000-4000-8000-0000000000b1';

describe('the release flags a tenant has on (ST-SAS-020, getMyFeatureFlags)', () => {
  const harness = new AuthzHarness();
  let controlPool: Pool;
  let app: RunningApp;

  async function admin(sql: string, params: unknown[] = []): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  async function mine(tenant: string): Promise<{ status: number; flags: Record<string, boolean> }> {
    const response = await fetch(`${app.baseUrl}/me/feature-flags`, { headers: { [TENANT_HEADER]: signTenantContext(contextFor(tenant, memberId(USER)), SIGNING_KEY) } });
    const json = (await response.json()) as { items?: Array<{ flag_key: string; enabled: boolean }> };
    return { status: response.status, flags: Object.fromEntries((json.items ?? []).map((item) => [item.flag_key, item.enabled])) };
  }

  beforeAll(async () => {
    await harness.start();
    controlPool = new Pool({ connectionString: harness.database.urlFor('machvon_control'), max: 3 });
    controlPool.on('error', () => undefined);
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: 1, path: '/u1/' }]);
      await harness.tenants.withTenant(contextFor(tenant, memberId(USER)), (tx) => seedSystemRoles(tx, ACTOR));
      await harness.seedMembership(tenant, USER, 1);
      await harness.seedRole(tenant, 70, 'SELF', ['session.self'], 10);
      await harness.seedGrants(tenant, [{ n: 1, member: USER, role: 70, kind: 'TENANT' }]);
    }
    await admin("insert into machvon.placement (id, kind, region, db_cluster_ref, kms_key_ref, status) values ($1, 'POOL', 'vn-north', 'pool-1', 'kms-1', 'Active')", [PLACEMENT]);
    await admin("insert into machvon.tenant (id, code, name, status, placement_id, region) values ($1, 'tenant-a', 'tenant-a', 'Active', $2, 'vn-pilot')", [TENANT_A, PLACEMENT]);
    await admin("insert into machvon.tenant (id, code, name, status, placement_id, region) values ($1, 'tenant-b', 'tenant-b', 'Active', $2, 'vn-other')", [TENANT_B, PLACEMENT]);
    const database = new TenantDatabase(harness.appPool);
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [PolicyModule.register({ database, access: new EffectiveAccessStore(database, new InMemoryAuthzCache()) })],
      controllers: [MyFeatureFlagsController],
      providers: [{ provide: ControlDatabase, useValue: new ControlDatabase(controlPool) }, { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) }],
    });
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await controlPool?.end();
    await harness.stop();
  }, 60_000);

  it('UAT-AC170: tells a tenant which flags are on for it, none while they are Off, and by the cohort of its region once rolled out', async () => {
    expect(await mine(TENANT_A)).toEqual({ status: 200, flags: { 'sas.silo_promotion': false, 'sas.tenant_restore_in_place': false } });
    await admin(
      `update machvon.feature_flag set status = 'Rollout', rollout_json = '{"tenant_cohorts": ["vn-pilot"], "tenant_ids": [], "percentage": 0}'::jsonb, revision = revision + 1, version = version + 1 where flag_key = 'sas.silo_promotion'`,
    );
    expect(await mine(TENANT_A)).toEqual({ status: 200, flags: { 'sas.silo_promotion': true, 'sas.tenant_restore_in_place': false } });
    expect(await mine(TENANT_B)).toEqual({ status: 200, flags: { 'sas.silo_promotion': false, 'sas.tenant_restore_in_place': false } });
    await admin(`update machvon.feature_flag set status = 'On', rollout_json = '{"tenant_cohorts": [], "tenant_ids": [], "percentage": 0}'::jsonb, revision = revision + 1, version = version + 1 where flag_key = 'sas.tenant_restore_in_place'`);
    expect((await mine(TENANT_B)).flags).toEqual({ 'sas.silo_promotion': false, 'sas.tenant_restore_in_place': true });
  });
});
