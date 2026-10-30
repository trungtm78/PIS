import { resolve } from 'node:path';
import { DomainError } from '@machvon/kernel';
import { Client, Pool } from 'pg';
import { ControlDatabase, PLATFORM_TENANT_ID } from '../src/control-database';
import { startMigratedTestDatabase } from '../src/migrated-test-database';
import {
  INFRASTRUCTURE_STEPS,
  IsolationProbeError,
  PROVISIONING_STEPS,
  TENANT_STATUSES,
  TenantRegistry,
  assertTenantTransition,
  isTenantTransition,
} from '../src/tenant-registry';
import type { TenantRequestInput, TenantStatus } from '../src/tenant-registry';
import type { TestDatabase } from '../src/test-database';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const ADMIN_ID = '00000000-0000-4000-8000-0000000000a1';
// Own plan code and ids: the seed migrations create their own plans.
const PLAN_PUBLISHED = '00000000-0000-4000-9500-000000000001';
const PLAN_DRAFT = '00000000-0000-4000-9500-000000000002';
const PLAN_RETIRED = '00000000-0000-4000-9500-000000000003';
const PLACEMENT_NORTH = '00000000-0000-4000-8000-0000000000b1';
const PLACEMENT_NORTH_BUSY = '00000000-0000-4000-8000-0000000000b2';
const PLACEMENT_SOUTH_FULL = '00000000-0000-4000-8000-0000000000b3';

const ALLOWED: ReadonlyArray<readonly [TenantStatus, TenantStatus]> = [
  ['Requested', 'Provisioning'],
  ['Provisioning', 'Active'],
  ['Provisioning', 'Failed'],
  ['Failed', 'Provisioning'],
  ['Failed', 'Archived'],
  ['Active', 'Suspended'],
  ['Suspended', 'Active'],
  ['Active', 'Offboarding'],
  ['Suspended', 'Offboarding'],
  ['Offboarding', 'Archived'],
  ['Offboarding', 'Active'],
];

let counter = 0;
function input(overrides: Partial<TenantRequestInput> = {}): TenantRequestInput {
  counter += 1;
  return {
    code: `acme-${counter}`,
    name: `Tenant ${counter}`,
    governingBodyType: 'PROVINCE',
    region: 'vn-north',
    isolationMode: 'POOL',
    planVersionId: PLAN_PUBLISHED,
    rootUnitName: 'Root unit',
    initialOwnerEmail: `owner${counter}@example.org`,
    platformSubdomain: `acme-${counter}`,
    requestedBy: ADMIN_ID,
    ...overrides,
  };
}

describe('tenant lifecycle table (SAS section 4)', () => {
  it('allows exactly the listed transitions and refuses every other pair', () => {
    for (const from of TENANT_STATUSES) {
      for (const to of TENANT_STATUSES) {
        const listed = ALLOWED.some(([source, target]) => source === from && target === to);
        expect(isTenantTransition(from, to)).toBe(listed);
      }
    }
  });

  it.each([
    ['Active', 'Archived'],
    ['Archived', 'Active'],
    ['Archived', 'Requested'],
    ['Requested', 'Active'],
    ['Failed', 'Active'],
    ['Active', 'Active'],
  ] as const)('refuses %s to %s with 409 TENANT_STATE_INVALID', (from, to) => {
    expect(() => assertTenantTransition(from, to)).toThrow(expect.objectContaining({ code: 'TENANT_STATE_INVALID', status: 409 }));
  });

  it('lists eleven steps of which the first five are infrastructure', () => {
    expect(PROVISIONING_STEPS).toHaveLength(11);
    expect([...INFRASTRUCTURE_STEPS]).toEqual(['IDP_ORG', 'DNS_SUBDOMAIN', 'STORAGE_PREFIX', 'DB_PLACEMENT', 'RLS_SEED']);
  });
});

describe('TenantRegistry on a migrated database', () => {
  let database: TestDatabase;
  let controlPool: Pool;
  let control: ControlDatabase;
  let registry: TenantRegistry;

  async function asAdmin<T>(work: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: database.adminUrl });
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  }

  const request = (overrides: Partial<TenantRequestInput> = {}, whileActing: (current: string) => void = () => undefined) =>
    control.withTenantOf(PLATFORM_TENANT_ID, (tx) =>
      registry.requestTenant(tx, input(overrides), PLATFORM_TENANT_ID, async () => {
        const [row] = await tx.query<{ tenant: string }>("select current_setting('app.tenant_id') as tenant");
        whileActing(row?.tenant ?? '');
      }),
    );

  const count = (sql: string, params: unknown[] = []): Promise<number> =>
    asAdmin(async (client) => Number((await client.query<{ n: string }>(sql, params)).rows[0]?.n));

  beforeAll(async () => {
    database = await startMigratedTestDatabase(REPO_ROOT);
    controlPool = new Pool({ connectionString: database.urlFor('machvon_control'), max: 3 });
    controlPool.on('error', () => undefined);
    control = new ControlDatabase(controlPool);
    registry = new TenantRegistry(control);
    await asAdmin(async (client) => {
      for (const [id, status, revision] of [[PLAN_PUBLISHED, 'Published', 1], [PLAN_DRAFT, 'Draft', 2], [PLAN_RETIRED, 'Retired', 3]] as const) {
        await client.query(
          `insert into machvon.product_plan_version (id, plan_code, revision, name, status, billing_cycles, base_price_vnd, vat_category, legal_terms_ref)
           values ($1, 'REGISTRY_TEST', $2, 'Registry test', $3, '{MONTHLY}', 0, 'VAT_10', 'terms-1')`,
          [id, revision, status],
        );
      }
      await client.query(
        `insert into machvon.placement (id, kind, region, db_cluster_ref, kms_key_ref, status, max_tenants) values
           ($1, 'POOL', 'vn-north', 'north-1', 'kms-1', 'Active', null),
           ($2, 'POOL', 'vn-north', 'north-2', 'kms-2', 'Draining', null),
           ($3, 'POOL', 'vn-south', 'south-1', 'kms-3', 'Active', 1)`,
        [PLACEMENT_NORTH, PLACEMENT_NORTH_BUSY, PLACEMENT_SOUTH_FULL],
      );
    });
  }, 180_000);

  afterAll(async () => {
    await controlPool?.end();
    if (database) await database.stop();
  }, 60_000);

  it('writes the tenant as Requested with attempt 1 Running, all steps pending, and acts as the tenant while the hook runs', async () => {
    const seen: string[] = [];
    const created = await request({}, (current) => seen.push(current));
    expect(seen).toEqual([created.tenantId]);
    const tenant = await registry.getTenant(created.tenantId);
    expect(tenant).toMatchObject({ status: 'Requested', placementId: PLACEMENT_NORTH, region: 'vn-north', isolationMode: 'POOL', version: 1 });
    const run = await registry.loadRun(created.tenantId, 1);
    expect(run).toMatchObject({ id: created.runId, status: 'Running', attempt: 1, currentStep: 'IDP_ORG', requestedBy: ADMIN_ID });
    expect(Object.values(run?.steps ?? {}).every((step) => step.status === 'PENDING' && step.attempts === 0)).toBe(true);
    expect(run?.request).toMatchObject({ plan_version_id: PLAN_PUBLISHED, root_unit_name: 'Root unit' });
  });

  it('returns the transaction to the platform tenant after the hook', async () => {
    const after = await control.withTenantOf(PLATFORM_TENANT_ID, async (tx) => {
      await registry.requestTenant(tx, input(), PLATFORM_TENANT_ID, () => Promise.resolve());
      const [row] = await tx.query<{ tenant: string }>("select current_setting('app.tenant_id') as tenant");
      return row?.tenant;
    });
    expect(after).toBe(PLATFORM_TENANT_ID);
  });

  it('refuses a taken code in any case and creates no second tenant, also while the first is Failed', async () => {
    const first = await request({ code: 'taken-code' });
    const before = await count('select count(*) as n from machvon.tenant');
    for (const code of ['taken-code', 'TAKEN-CODE']) {
      await expect(request({ code })).rejects.toMatchObject({ code: 'TENANT_CODE_TAKEN', status: 409 });
    }
    await registry.transition(first.tenantId, 'Requested', 'Provisioning');
    await registry.transition(first.tenantId, 'Provisioning', 'Failed');
    await expect(request({ code: 'taken-code' })).rejects.toMatchObject({ code: 'TENANT_CODE_TAKEN' });
    expect(await count('select count(*) as n from machvon.tenant')).toBe(before);
  });

  it.each([PLAN_DRAFT, PLAN_RETIRED, '00000000-0000-4000-9500-0000000000ff'])('refuses plan version %s that is not Published with 409 PLAN_NOT_PUBLISHED', async (planVersionId) => {
    await expect(request({ planVersionId })).rejects.toMatchObject({ code: 'PLAN_NOT_PUBLISHED', status: 409 });
  });

  it('refuses a region without an Active placement that has room with 422 PLACEMENT_UNAVAILABLE and picks the least loaded one', async () => {
    await expect(request({ isolationMode: 'SILO' })).rejects.toMatchObject({ code: 'PLACEMENT_UNAVAILABLE', status: 422 });
    const south = await request({ region: 'vn-south' });
    expect(south.placementId).toBe(PLACEMENT_SOUTH_FULL);
    await expect(request({ region: 'vn-south' })).rejects.toMatchObject({ code: 'PLACEMENT_UNAVAILABLE' });
    // The draining placement of the north is never chosen.
    expect((await request({ region: 'vn-north' })).placementId).toBe(PLACEMENT_NORTH);
  });

  it('moves along the lifecycle once, repeats a move that already happened, and refuses a move from the wrong state', async () => {
    const created = await request();
    await registry.transition(created.tenantId, 'Requested', 'Provisioning');
    expect((await registry.getTenant(created.tenantId))?.version).toBe(2);
    await registry.transition(created.tenantId, 'Requested', 'Provisioning');
    expect((await registry.getTenant(created.tenantId))?.version).toBe(2);
    await expect(registry.transition(created.tenantId, 'Provisioning', 'Archived')).rejects.toMatchObject({ code: 'TENANT_STATE_INVALID' });
    await expect(registry.transition(created.tenantId, 'Active', 'Suspended')).rejects.toMatchObject({ code: 'TENANT_STATE_INVALID' });
    await expect(registry.transition('00000000-0000-4000-8000-0000000000ee', 'Requested', 'Provisioning')).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    await registry.transition(created.tenantId, 'Provisioning', 'Active');
    expect((await asAdmin((client) => client.query<{ activated_at: Date | null }>('select activated_at from machvon.tenant where id = $1', [created.tenantId]))).rows[0]?.activated_at).not.toBeNull();
  });

  it('records steps and the end of a run and reads them back with the tenant', async () => {
    const created = await request();
    await registry.updateStep(created.tenantId, created.runId, 'IDP_ORG', { status: 'DONE', attempts: 1, finished_at: '2026-10-23T10:00:00.000Z' }, 'DNS_SUBDOMAIN');
    await registry.updateStep(created.tenantId, created.runId, 'DNS_SUBDOMAIN', { status: 'FAILED', attempts: 4, error_code: 'DNS_DOWN' });
    await registry.finishRun(created.tenantId, created.runId, 'Failed', 'DNS_DOWN', 'DNS_SUBDOMAIN');
    const detail = await registry.getDetail(created.tenantId);
    expect(detail?.run).toMatchObject({ status: 'Failed', errorCode: 'DNS_DOWN', currentStep: 'DNS_SUBDOMAIN' });
    expect(detail?.run?.steps.IDP_ORG).toMatchObject({ status: 'DONE', attempts: 1 });
    expect(detail?.run?.steps.DNS_SUBDOMAIN).toMatchObject({ status: 'FAILED', attempts: 4, error_code: 'DNS_DOWN' });
    expect(detail?.run?.steps.STORAGE_PREFIX.status).toBe('PENDING');
    expect(await registry.getDetail('00000000-0000-4000-8000-0000000000ee')).toBeUndefined();
  });

  it('lists tenants by keyset pages of (code, id)', async () => {
    const all: string[] = [];
    let cursor: { code: string; id: string } | undefined;
    for (;;) {
      const page = await registry.listTenants(2, cursor);
      all.push(...page.items.map((item) => item.code));
      if (page.next === null) break;
      cursor = page.next;
    }
    expect(all).toEqual([...all].sort());
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(await count('select count(*) as n from machvon.tenant'));
  });

  it('opens a retry run from the failed step, keeps DONE steps, and refuses a stale version or a tenant that is not Failed', async () => {
    const created = await request();
    await registry.updateStep(created.tenantId, created.runId, 'IDP_ORG', { status: 'DONE', attempts: 1 });
    await registry.updateStep(created.tenantId, created.runId, 'DNS_SUBDOMAIN', { status: 'FAILED', attempts: 4, error_code: 'DNS_DOWN' });
    await registry.finishRun(created.tenantId, created.runId, 'Failed', 'DNS_DOWN', 'DNS_SUBDOMAIN');
    await expect(control.withTenantOf(PLATFORM_TENANT_ID, (tx) => registry.startRetryRun(tx, created.tenantId, 1, ADMIN_ID, PLATFORM_TENANT_ID, () => Promise.resolve()))).rejects.toMatchObject({
      code: 'TENANT_STATE_INVALID',
    });
    await registry.transition(created.tenantId, 'Requested', 'Provisioning');
    await registry.transition(created.tenantId, 'Provisioning', 'Failed');
    const failedVersion = (await registry.getTenant(created.tenantId))?.version ?? 0;
    await expect(control.withTenantOf(PLATFORM_TENANT_ID, (tx) => registry.startRetryRun(tx, created.tenantId, failedVersion - 1, ADMIN_ID, PLATFORM_TENANT_ID, () => Promise.resolve()))).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      extensions: { current_version: failedVersion },
    });
    const retry = await control.withTenantOf(PLATFORM_TENANT_ID, (tx) =>
      registry.startRetryRun(tx, created.tenantId, failedVersion, ADMIN_ID, PLATFORM_TENANT_ID, () => Promise.resolve()),
    );
    expect(retry).toMatchObject({ attempt: 2, version: failedVersion + 1 });
    const second = await registry.loadRun(created.tenantId, 2);
    expect(second).toMatchObject({ status: 'Running', currentStep: 'DNS_SUBDOMAIN' });
    expect(second?.steps.IDP_ORG.status).toBe('DONE');
    expect(second?.steps.DNS_SUBDOMAIN).toEqual({ status: 'PENDING', attempts: 0 });
    expect((await registry.getTenant(created.tenantId))?.status).toBe('Provisioning');
    expect((await registry.loadRun(created.tenantId, 1))?.status).toBe('Failed');
  });

  it('finds the unfinished runs of tenants that are Requested or Provisioning', async () => {
    const created = await request();
    const unfinished = await registry.unfinishedRuns();
    expect(unfinished.map((run) => run.tenantId)).toContain(created.tenantId);
    await registry.transition(created.tenantId, 'Requested', 'Provisioning');
    await registry.transition(created.tenantId, 'Provisioning', 'Failed');
    expect((await registry.unfinishedRuns()).map((run) => run.tenantId)).not.toContain(created.tenantId);
  });

  it('registers a platform subdomain once per tenant and answers DOMAIN_TAKEN when another tenant holds it', async () => {
    const one = await request();
    const two = await request();
    const hostname = registry.hostnameOf('shared-name');
    await registry.ensureDomain(one.tenantId, hostname);
    await registry.ensureDomain(one.tenantId, hostname);
    expect(await count('select count(*) as n from machvon.tenant_domain where tenant_id = $1', [one.tenantId])).toBe(1);
    await expect(registry.ensureDomain(two.tenantId, hostname.toUpperCase())).rejects.toMatchObject({ code: 'DOMAIN_TAKEN', status: 409 });
    await registry.revokeDomain(one.tenantId, hostname);
    // A name released less than 90 days ago is held against the other tenants (ST-SAS-017); the tenant that released it, a provisioning run again, takes it back.
    await expect(registry.ensureDomain(two.tenantId, hostname)).rejects.toMatchObject({ code: 'DOMAIN_TAKEN', status: 409, extensions: { reason: 'RESERVED' } });
    await registry.ensureDomain(one.tenantId, hostname);
    expect(await count("select count(*) as n from machvon.tenant_domain where tenant_id = $1 and status <> 'Revoked'", [one.tenantId])).toBe(1);
  });

  it('tells whether a revoked hostname belonged to the tenant, so a caller never removes DNS that another tenant owns', async () => {
    const one = await request();
    const two = await request();
    const hostname = registry.hostnameOf('owned-by-one');
    await registry.ensureDomain(one.tenantId, hostname);
    expect(await registry.revokeDomain(two.tenantId, hostname)).toBe(false);
    expect(await registry.revokeDomain(one.tenantId, hostname)).toBe(true);
    // The row stays as Revoked, so a compensation that crashed before removing the record can be repeated.
    expect(await registry.revokeDomain(one.tenantId, hostname)).toBe(true);
    expect(await registry.revokeDomain(one.tenantId, registry.hostnameOf('never-registered'))).toBe(false);
  });

  it('fails the run and the tenant in one transaction', async () => {
    const created = await request();
    await registry.transition(created.tenantId, 'Requested', 'Provisioning');
    await registry.failRun(created.tenantId, created.runId, 'PORT_UNAVAILABLE', 'DNS_SUBDOMAIN');
    const detail = await registry.getDetail(created.tenantId);
    expect(detail?.tenant.status).toBe('Failed');
    expect(detail?.run).toMatchObject({ status: 'Failed', errorCode: 'PORT_UNAVAILABLE', currentStep: 'DNS_SUBDOMAIN' });
  });

  it('leaves the run Running when the tenant cannot move to Failed, so the two never disagree', async () => {
    const created = await request();
    // A tenant that is still Requested cannot fail: Requested only moves to Provisioning.
    await expect(registry.failRun(created.tenantId, created.runId, 'PORT_UNAVAILABLE', 'IDP_ORG')).rejects.toMatchObject({ code: 'TENANT_STATE_INVALID' });
    const detail = await registry.getDetail(created.tenantId);
    expect(detail?.tenant.status).toBe('Requested');
    expect(detail?.run?.status).toBe('Running');
  });

  it('never gives the last slot of a placement to two concurrent requests', async () => {
    const tiny = '00000000-0000-4000-8000-0000000000b4';
    await asAdmin((client) =>
      client.query(
        `insert into machvon.placement (id, kind, region, db_cluster_ref, kms_key_ref, status, max_tenants) values ('${tiny}', 'POOL', 'vn-tiny', 'tiny-1', 'kms-4', 'Active', 1)`,
      ),
    );
    // The first request keeps its transaction open after it has taken the slot; the second starts meanwhile.
    let holding: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      holding = resolve;
    });
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = control.withTenantOf(PLATFORM_TENANT_ID, (tx) =>
      registry.requestTenant(tx, input({ region: 'vn-tiny' }), PLATFORM_TENANT_ID, async () => {
        holding();
        await released;
      }),
    );
    await held;
    const second = request({ region: 'vn-tiny' }).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    );
    // The second request either finishes at once (it did not see the slot as taken) or waits for a lock held by the first.
    let settled = false;
    void second.then(() => {
      settled = true;
    });
    const waiting = async (): Promise<boolean> =>
      (await count("select count(*) as n from pg_locks where locktype = 'advisory' and not granted")) > 0;
    while (!settled && !(await waiting())) await new Promise((resolve) => setImmediate(resolve));
    release();
    const results = await Promise.allSettled([first, second]);
    const secondResult = await second;
    expect(results[0]?.status).toBe('fulfilled');
    expect(secondResult.status).toBe('rejected');
    expect(secondResult).toMatchObject({ reason: { code: 'PLACEMENT_UNAVAILABLE', status: 422 } });
    expect(await count(`select count(*) as n from machvon.tenant where placement_id = '${tiny}'`)).toBe(1);
  });

  it('passes the isolation probe, and fails it when row-level security is switched off (negative control)', async () => {
    const created = await request();
    await registry.probeIsolation(created.tenantId);
    await asAdmin(async (client) => {
      await client.query('alter table machvon.tenant_provisioning_run no force row level security');
      await client.query('alter table machvon.tenant_provisioning_run disable row level security');
    });
    try {
      await expect(registry.probeIsolation(created.tenantId)).rejects.toBeInstanceOf(IsolationProbeError);
    } finally {
      await asAdmin(async (client) => {
        await client.query('alter table machvon.tenant_provisioning_run enable row level security');
        await client.query('alter table machvon.tenant_provisioning_run force row level security');
      });
    }
    await registry.probeIsolation(created.tenantId);
  });

  it('does not leak a DomainError class mismatch: errors are DomainError instances', async () => {
    await expect(request({ planVersionId: PLAN_DRAFT })).rejects.toBeInstanceOf(DomainError);
  });
});
