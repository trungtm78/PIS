import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { FileService } from '../../src/modules/files/file.service';
import { FsObjectStorage } from '../../src/modules/files/fs-object-storage';
import { MockScanPort } from '../../src/modules/files/mock-scan';
import { MetricReadsController, MetricRegistryController, TenantMetricController } from '../../src/modules/bi/metric.controller';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
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
    ];
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, units);
    for (const n of [PIPELINE, ANALYST, READER, NOBODY, SCOPED]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, PIPELINE, ROOT);
    await harness.seedRole(TENANT_A, 1, 'BI_PIPELINE', ['bi.metric.sync', 'metric_definition.read'], 60);
    await harness.seedRole(TENANT_A, 2, 'BI_ANALYST', ['bi.metric.manage', 'metric_definition.read'], 50);
    await harness.seedRole(TENANT_A, 3, 'BI_READER', ['metric_definition.read'], 20);
    await harness.seedRole(TENANT_A, 4, 'BI_SCOPED', ['bi.metric.sync', 'bi.metric.manage', 'metric_definition.read'], 40);
    await harness.seedRole(TENANT_B, 1, 'BI_PIPELINE', ['bi.metric.sync', 'metric_definition.read'], 60);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: PIPELINE, role: 1, kind: 'TENANT' },
      { n: 2, member: ANALYST, role: 2, kind: 'TENANT' },
      { n: 3, member: READER, role: 3, kind: 'TENANT' },
      { n: 4, member: SCOPED, role: 4, kind: 'UNIT_SUBTREE', refs: [unitId(BRANCH)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: PIPELINE, role: 1, kind: 'TENANT' }]);
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
      controllers: [MetricRegistryController, TenantMetricController, MetricReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
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

  async call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; key?: string }): Promise<Reply> {
    const token = signTenantContext({ tenantId: options.tenantId ?? TENANT_A, membershipId: memberId(options.member), scopeVersion: 1 }, SIGNING_KEY);
    const headers: Record<string, string> = { [TENANT_HEADER]: token, 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    const response = await fetch(`${this.app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> };
  }

  async count(sql: string, params: unknown[] = [], tenantId: string = TENANT_A): Promise<number> {
    return Number((await this.harness.owner<{ n: string }>(tenantId, [[sql, params]]))[0]?.n);
  }

  /** Removes the metrics and the runs of a tenant so that a test starts from nothing. */
  reset(tenantId: string = TENANT_A): Promise<unknown[]> {
    return this.harness.owner(tenantId, [['delete from machvon.metric_definition'], ['delete from machvon.bi_metric_sync_run']]);
  }
}

export { TENANT_A, TENANT_B, memberId, unitId };
