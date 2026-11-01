import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { FileService } from '../../src/modules/files/file.service';
import { FsObjectStorage } from '../../src/modules/files/fs-object-storage';
import { MockScanPort } from '../../src/modules/files/mock-scan';
import { DatasetBuildController, DatasetReadsController } from '../../src/modules/bi/dataset.controller';
import { DashboardController, DashboardReadsController, DashboardVersionReadsController } from '../../src/modules/bi/dashboard.controller';
import { PolicyController } from '../../src/modules/bi/policy.controller';
import { DashboardPublishController, PublicationController } from '../../src/modules/bi/publication.controller';
import { DashboardShareController } from '../../src/modules/bi/share.controller';
import { BiQueryController } from '../../src/modules/bi/query.controller';
import { BI_CLOCK, BI_DRILL_KEY } from '../../src/modules/bi/tokens';
import { MetricReadsController, MetricRegistryController, TenantMetricController } from '../../src/modules/bi/metric.controller';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, roleId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

export const SIGNING_KEY = randomBytes(32);

/** Members of tenant A: the pipeline that syncs, the data owner who drafts tenant metrics, a reader of the catalogue, and a few who hold less. */
export const PIPELINE = 1; // syncs the metrics of the platform, over the whole tenant
export const ANALYST = 2; // drafts the metrics of the tenant
export const READER = 3; // reads the catalogue
export const NOBODY = 4; // no grant
export const SCOPED = 5; // holds the sync and the draft on one unit only: the registry is the tenant's, so it is refused
export const BUILDER = 6; // builds the versions of the datasets, and queries
export const QUERIER = 7; // reads the datasets and their versions
export const POLICY_ADMIN = 8; // drafts and lists the access policies
export const POLICY_SCOPED = 9; // holds the same right over one unit only: the policies are the tenant's, so it is refused
export const ANALYST_ALL = 10; // queries the whole tenant
export const ANALYST_BRANCH = 11; // queries the branch (units 3, 4 and 6 under it) only
export const ANALYST_NONE = 12; // may query, but no policy opens the dataset for them
export const DASH_MAKER = 13; // makes and saves dashboards
export const DASH_OTHER = 14; // makes dashboards too: what the first makes is not theirs
export const DASH_VIEWER = 15; // reads dashboards and queries, and makes none
export const REQUESTER = 16; // makes dashboards, drafts metrics and policies, asks to publish them, and holds the right to decide (never on what they asked)
export const APPROVER = 17; // decides on the requests to publish, over the whole tenant
export const APPROVER_SCOPED = 18; // holds the right to decide over one unit only: the requests are the tenant's, so it is refused
export const UNIT_A = 3; // under the branch
export const UNIT_B = 4; // under the branch
export const UNIT_OUT = 5; // outside the branch
export const UNIT_C = 6; // under the branch
export const DRILL_KEY = randomBytes(32);
export const CLOCK = { now: new Date() };
export const ROOT = 1;
export const BRANCH = 2;

/** The dataset of the tenant that offers the dimensions `unit` and `fund`. */
export const DATASET = '00000000-0000-4000-8000-0000000000d1';
export const DEPRECATED_DATASET = '00000000-0000-4000-8000-0000000000d2';

export interface Reply {
  status: number;
  headers: Headers;
  json: Record<string, unknown>;
}

export class BiApp {
  readonly harness = new AuthzHarness();
  app!: RunningApp;
  objects!: FileService;
  private root = '';

  async start(): Promise<void> {
    const { harness } = this;
    await harness.start();
    const units = [
      { n: ROOT, path: `/${unitId(ROOT)}/` },
      { n: BRANCH, path: `/${unitId(BRANCH)}/`, parent: ROOT },
      ...[UNIT_A, UNIT_B, UNIT_C].map((n) => ({ n, path: `/${unitId(BRANCH)}/${unitId(n)}/`, parent: BRANCH })),
      { n: UNIT_OUT, path: `/${unitId(UNIT_OUT)}/`, parent: ROOT },
    ];
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, units);
    for (const n of [PIPELINE, ANALYST, READER, NOBODY, SCOPED, BUILDER, QUERIER, POLICY_ADMIN, POLICY_SCOPED, ANALYST_ALL, ANALYST_NONE, DASH_MAKER, DASH_OTHER, DASH_VIEWER, REQUESTER, APPROVER, APPROVER_SCOPED]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_A, ANALYST_BRANCH, BRANCH);
    await harness.seedMembership(TENANT_B, PIPELINE, ROOT);
    await harness.seedRole(TENANT_A, 1, 'BI_PIPELINE', ['bi.metric.sync', 'metric_definition.read'], 60);
    await harness.seedRole(TENANT_A, 2, 'BI_ANALYST', ['bi.metric.manage', 'metric_definition.read'], 50);
    await harness.seedRole(TENANT_A, 3, 'BI_READER', ['metric_definition.read'], 20);
    await harness.seedRole(TENANT_A, 4, 'BI_SCOPED', ['bi.metric.sync', 'bi.metric.manage', 'metric_definition.read'], 40);
    await harness.seedRole(TENANT_A, 5, 'BI_BUILDER', ['bi.dataset.build', 'bi.query'], 50);
    await harness.seedRole(TENANT_A, 6, 'BI_QUERIER', ['bi.query'], 20);
    await harness.seedRole(TENANT_A, 7, 'BI_POLICY_ADMIN', ['bi.policy.manage', 'bi.query'], 50);
    await harness.seedRole(TENANT_A, 8, 'BI_POLICY_SCOPED', ['bi.policy.manage', 'bi.query'], 40);
    await harness.seedRole(TENANT_A, 9, 'BI_ANALYST_QUERY', ['bi.query', 'drill_context.read'], 30);
    await harness.seedRole(TENANT_A, 10, 'BI_ANALYST_NONE', ['bi.query'], 30);
    await harness.seedRole(TENANT_A, 11, 'BI_DASH_MAKER', ['bi.dashboard.manage', 'bi.dashboard.share', 'bi.query', 'dashboard_version.read'], 40);
    await harness.seedRole(TENANT_A, 12, 'BI_DASH_VIEWER', ['bi.query', 'dashboard_version.read'], 20);
    await harness.seedRole(TENANT_A, 13, 'BI_REQUESTER', ['bi.publish.request', 'bi.publish', 'bi.dashboard.manage', 'bi.dashboard.share', 'bi.metric.manage', 'bi.policy.manage', 'bi.query', 'dashboard_version.read'], 40);
    await harness.seedRole(TENANT_A, 14, 'BI_APPROVER', ['bi.publish', 'bi.query', 'dashboard_version.read'], 50);
    await harness.seedRole(TENANT_A, 15, 'BI_APPROVER_SCOPED', ['bi.publish'], 40);
    await harness.seedRole(TENANT_B, 1, 'BI_PIPELINE', ['bi.metric.sync', 'metric_definition.read'], 60);
    await harness.seedRole(TENANT_B, 2, 'BI_BUILDER', ['bi.dataset.build', 'bi.query'], 50);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: PIPELINE, role: 1, kind: 'TENANT' },
      { n: 2, member: ANALYST, role: 2, kind: 'TENANT' },
      { n: 3, member: READER, role: 3, kind: 'TENANT' },
      { n: 4, member: SCOPED, role: 4, kind: 'UNIT_SUBTREE', refs: [unitId(BRANCH)] },
      { n: 5, member: BUILDER, role: 5, kind: 'TENANT' },
      { n: 6, member: QUERIER, role: 6, kind: 'TENANT' },
      { n: 7, member: POLICY_ADMIN, role: 7, kind: 'TENANT' },
      { n: 8, member: POLICY_SCOPED, role: 8, kind: 'UNIT_SUBTREE', refs: [unitId(BRANCH)] },
      { n: 9, member: ANALYST_ALL, role: 9, kind: 'TENANT' },
      { n: 11, member: ANALYST_NONE, role: 10, kind: 'TENANT' },
      { n: 41, member: DASH_MAKER, role: 11, kind: 'TENANT' },
      { n: 42, member: DASH_OTHER, role: 11, kind: 'TENANT' },
      { n: 43, member: DASH_VIEWER, role: 12, kind: 'TENANT' },
      { n: 44, member: REQUESTER, role: 13, kind: 'TENANT' },
      { n: 45, member: APPROVER, role: 14, kind: 'TENANT' },
      { n: 46, member: APPROVER_SCOPED, role: 15, kind: 'UNIT_SUBTREE', refs: [unitId(BRANCH)] },
      { n: 12, member: ANALYST_BRANCH, role: 9, kind: 'UNIT_SUBTREE', refs: [unitId(UNIT_A)] },
      { n: 13, member: ANALYST_BRANCH, role: 9, kind: 'UNIT_SUBTREE', refs: [unitId(UNIT_B)] },
      { n: 14, member: ANALYST_BRANCH, role: 9, kind: 'UNIT_SUBTREE', refs: [unitId(UNIT_C)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: PIPELINE, role: 1, kind: 'TENANT' }]);
    await harness.seedMembership(TENANT_B, BUILDER, ROOT);
    await harness.seedGrants(TENANT_B, [{ n: 2, member: BUILDER, role: 2, kind: 'TENANT' }]);
    await this.seedDatasets();
    const tenants = harness.tenants as TenantDatabase;
    this.root = await mkdtemp(join(tmpdir(), 'machvon-bi-'));
    this.objects = new FileService({ storage: new FsObjectStorage(this.root), scanner: new MockScanPort(), urlSecret: randomBytes(32), now: () => new Date() });
    this.app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [MetricRegistryController, TenantMetricController, MetricReadsController, DatasetBuildController, DatasetReadsController, PolicyController, BiQueryController, DashboardController, DashboardReadsController, DashboardVersionReadsController, PublicationController, DashboardPublishController, DashboardShareController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: BI_DRILL_KEY, useValue: DRILL_KEY },
        { provide: BI_CLOCK, useValue: () => new Date(CLOCK.now) },
        { provide: FileService, useValue: this.objects },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }

  private async seedDatasets(): Promise<void> {
    const insert = `insert into machvon.bi_dataset (tenant_id, id, dataset_code, title, source_kind, grain, join_paths, owner_user_id, created_by, updated_by, status)
      values ($1::uuid, $2::uuid, $3, 'Dataset', 'PERIOD_SNAPSHOT', 'project', $4::jsonb, $5::uuid, $5::uuid, $5::uuid, $6)`;
    const owner = memberId(PIPELINE);
    await this.harness.owner(TENANT_A, [
      [insert, [TENANT_A, DATASET, 'DS-DISB', JSON.stringify({ dimensions: ['unit', 'fund'] }), owner, 'ACTIVE']],
      [insert, [TENANT_A, DEPRECATED_DATASET, 'DS-OLD', JSON.stringify({ dimensions: ['unit'] }), owner, 'DEPRECATED']],
    ]);
  }

  async stop(): Promise<void> {
    if (this.app) await this.app.close();
    await this.harness.stop();
    if (this.root !== '') await rm(this.root, { recursive: true, force: true });
  }

  /** Stores a bundle of metrics as the pipeline does, and answers its key and the hash of its bytes. */
  async bundle(metrics: unknown[], tenantId: string = TENANT_A): Promise<{ key: string; sha256: string }> {
    const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, metrics }));
    const stored = await this.objects.upload(contextFor(tenantId, memberId(PIPELINE)), { purpose: 'document', declaredType: 'text/plain', bytes });
    const object = await this.objects.open(contextFor(tenantId, memberId(PIPELINE)), stored.key);
    return { key: stored.key, sha256: object.sha256 };
  }

  /** The context of a member of a tenant, for what a test asks of the database as the application does. */
  contextOf(member: number, tenantId: string = TENANT_A) {
    return contextFor(tenantId, memberId(member));
  }

  /** The version of the scope of a member the requests are made with: a revocation moves it, as the next request of the member would carry it. */
  readonly scopeVersions = new Map<number, number>();

  async call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; key?: string; ifMatch?: string }): Promise<Reply> {
    const token = signTenantContext({ tenantId: options.tenantId ?? TENANT_A, membershipId: memberId(options.member), scopeVersion: this.scopeVersions.get(options.member) ?? 1 }, SIGNING_KEY);
    const headers: Record<string, string> = { [TENANT_HEADER]: token, 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${this.app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> };
  }

  async count(sql: string, params: unknown[] = [], tenantId: string = TENANT_A): Promise<number> {
    return Number((await this.harness.owner<{ n: string }>(tenantId, [[sql, params]]))[0]?.n);
  }

  /** Runs statements with the foreign keys and the triggers off, as the fixtures of other modules do: the rows of DIS and DGV are given the few columns BI reads. */
  async seedReplica(statements: Array<[string, unknown[]]>): Promise<void> {
    const client = new Client({ connectionString: this.harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  /** Removes the datasets, their versions and the snapshots and runs behind them so that a test starts from nothing. */
  resetDatasets(tenantId: string = TENANT_A): Promise<unknown[]> {
    return this.harness.owner(tenantId, [
      ['delete from machvon.bi_dataset_version'],
      ["delete from machvon.bi_dataset where dataset_code not in ('DS-DISB', 'DS-OLD')"],
      ['delete from machvon.quality_run'],
      ['delete from machvon.period_snapshot'],
      ['delete from machvon.reporting_period'],
      ['delete from machvon.dataset'],
    ]);
  }

  /** Removes the policies of a tenant so that a test starts from nothing. */
  resetPolicies(tenantId: string = TENANT_A): Promise<unknown[]> {
    return this.harness.owner(tenantId, [['delete from machvon.bi_access_policy']]);
  }

  /** Removes the metrics and the runs of a tenant so that a test starts from nothing. */
  reset(tenantId: string = TENANT_A): Promise<unknown[]> {
    return this.harness.owner(tenantId, [['delete from machvon.metric_definition'], ['delete from machvon.bi_metric_sync_run']]);
  }
}

export { TENANT_A, TENANT_B, contextFor, memberId, roleId, unitId };
