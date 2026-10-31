import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { AuditWriter, DgvProductExpiryJob, EffectiveAccessStore, InMemoryAuthzCache, NotificationStore, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import type { OutboxDelivery } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import { NotificationConsumer } from '../../src/notifications/consumer';
import { PayloadValidator } from '../../src/notifications/payload-validator';
import type { EventTypeCatalog, EventTypeDefinition } from '../../src/notifications/payload-validator';
import { PermissionResourceAccess } from '../../src/notifications/resource-access-port';
import { CommandModule } from '../../src/command.module';
import { dgvModule } from '../../src/modules/dgv';
import { DgvProductController } from '../../src/modules/dgv/dgv-product.controller';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const CERTIFIER = 1; // data.product.certify and data.catalog.read
const PRODUCT_OWNER = 2; // owns the products and the datasets; may certify (but not their own)
const READER = 3; // data.catalog.read only
const NOBODY = 4; // no right over the catalogue
const UNIT_CERTIFIER = 5; // may certify on one unit subtree only
const B_CERTIFIER = 6; // of tenant B
const REASON = 'The contract is published and the latest run passed.';

class Counters implements MetricsSink {
  readonly counters = new Map<string, number>();
  increment(name: string, labels?: Record<string, string>): void {
    const key = labels === undefined ? name : `${name}{${Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(',')}}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }
  gauge(): void {
    return undefined;
  }
}

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

interface ProductView {
  id: string;
  code: string;
  datasets: Array<{ id: string; dataset_code: string; contract_published: boolean; quality_badge: string }>;
  datasets_hidden: number;
  certification_status: string;
  certified_by: { membership_id: string } | null;
  certification_expires_on: string | null;
  evidence_count: number;
  revoke_reason: string | null;
  version: number;
}

describe('the certification of data products (ST-DGV-009, DGV 3.1 F9, DGV-18)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let today = '';
  let sequence = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const certify = (member: number, product: string, version: number, body: Record<string, unknown>, tenantId?: string): Promise<Reply> =>
    call('POST', `/dgv/data-products/${product}/certification`, { member, body, ifMatch: `"${version}"`, ...(tenantId === undefined ? {} : { tenantId }) });
  const products = async (member: number, tenantId?: string): Promise<ProductView[]> => (await call('GET', '/dgv/data-products', { member, ...(tenantId === undefined ? {} : { tenantId }) })).json.items as ProductView[];
  const productOf = async (id: string, member = CERTIFIER): Promise<ProductView> => {
    const found = (await products(member)).find((product) => product.id === id);
    if (found === undefined) throw new Error('the product is not listed');
    return found;
  };
  const day = async (offset: number): Promise<string> => (await rows<{ d: string }>('select ($1::date + $2::int)::text as d', [today, offset]))[0]?.d ?? '';
  const certifying = async (expiresInDays = 200): Promise<Record<string, unknown>> => ({ decision: 'CERTIFIED', reason: REASON, evidence_refs: [{ kind: 'quality_run', ref: 'run-1' }], certification_expires_on: await day(expiresInDays) });

  async function seedDataset(classification = 'INTERNAL', freshness = 86400): Promise<string> {
    const id = randomUUID();
    sequence += 1;
    await rows(
      `insert into machvon.dataset (tenant_id, id, dataset_code, title, domain, grain, producer_module, owner_user_id, steward_user_id, classification, is_critical, freshness_slo_seconds, status, created_by, updated_by)
       values ($1, $2, $3, $3, 'TREASURY', 'one row per payment order', 'PAY', $4, $4, $5, false, $6, 'DRAFT', $4, $4)`,
      [TENANT_A, id, `DS-PRODUCT-${sequence}`, memberId(PRODUCT_OWNER), classification, freshness],
    );
    return id;
  }

  async function seedContract(datasetId: string, status: string): Promise<string> {
    const id = randomUUID();
    await rows(
      `insert into machvon.dataset_contract (tenant_id, id, dataset_code, revision, owner_id, schema_json, quality_json, freshness_seconds, classification, status, dataset_id)
       values ($1, $2, (select dataset_code from machvon.dataset where id = $3::uuid), $4, $5, '{}'::jsonb, '{}'::jsonb, 86400, 'INTERNAL', $6, $3::uuid)`,
      [TENANT_A, id, datasetId, (await rows('select 1 from machvon.dataset_contract where dataset_id = $1::uuid', [datasetId])).length + 1, memberId(PRODUCT_OWNER), status],
    );
    return id;
  }

  /** A finished run of the dataset: how long ago it finished (hours) and its verdict. */
  async function seedRun(datasetId: string, contractId: string, hoursAgo: number, verdict: 'PASSED' | 'FAILED'): Promise<void> {
    await rows(
      `insert into machvon.quality_run
         (tenant_id, id, dataset_contract_id, snapshot_id, rule_version_ids, passed_count, failed_count, quarantined_count, started_at, finished_at, dataset_id, trigger, status, overall_result, score, hard_fail, certified_blocked)
       values ($1, $2, $3, gen_random_uuid(), jsonb_build_array('r'), 1, 0, 0, now() - make_interval(hours => $4::int), now() - make_interval(hours => $4::int), $5::uuid, 'MANUAL', 'COMPLETED', $6, $7, false, false)`,
      [TENANT_A, randomUUID(), contractId, hoursAgo, datasetId, verdict, verdict === 'PASSED' ? 100 : 40],
    );
  }

  /** A dataset that is ready: a published contract and a run that passed an hour ago. */
  async function seedReadyDataset(): Promise<string> {
    const dataset = await seedDataset();
    await seedRun(dataset, await seedContract(dataset, 'PUBLISHED'), 1, 'PASSED');
    return dataset;
  }

  async function seedProduct(datasetIds: string[], owner = PRODUCT_OWNER): Promise<string> {
    const id = randomUUID();
    sequence += 1;
    await rows(
      `insert into machvon.data_product (tenant_id, id, code, title, dataset_ids, owner_user_id, created_by, updated_by)
       values ($1, $2, $3, 'Actual Kho bac', $4::jsonb, $5, $5, $5)`,
      [TENANT_A, id, `PRODUCT-${sequence}`, JSON.stringify(datasetIds), memberId(owner)],
    );
    return id;
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }]);
    for (const n of [CERTIFIER, PRODUCT_OWNER, READER, NOBODY, UNIT_CERTIFIER]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedMembership(TENANT_B, B_CERTIFIER, 1);
    await harness.seedRole(TENANT_A, 1, 'DATA_OWNER', ['data.product.certify', 'data.catalog.read'], 40);
    await harness.seedRole(TENANT_A, 2, 'DATA_READER', ['data.catalog.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'DATA_OWNER', ['data.product.certify', 'data.catalog.read'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: CERTIFIER, role: 1, kind: 'TENANT' },
      { n: 2, member: PRODUCT_OWNER, role: 1, kind: 'TENANT' },
      { n: 3, member: READER, role: 2, kind: 'TENANT' },
      { n: 4, member: UNIT_CERTIFIER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(1)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_CERTIFIER, role: 1, kind: 'TENANT' }]);
    today = (await rows<{ d: string }>("select (now() at time zone 'Asia/Ho_Chi_Minh')::date::text as d"))[0]?.d ?? '';
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [DgvProductController],
      providers: [{ provide: TenantDatabase, useValue: tenants }, { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) }],
    });
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered in the module of DGV', () => {
    expect(dgvModule.controllers).toContain(DgvProductController);
  });

  it('UAT-AC495: the owner cannot certify (403), a run that failed is 422 QUALITY_NOT_PASSED, and after a run that passed the product is CERTIFIED with the day it runs out', async () => {
    const dataset = await seedDataset();
    const contract = await seedContract(dataset, 'PUBLISHED');
    await seedRun(dataset, contract, 5, 'FAILED');
    const product = await seedProduct([dataset]);
    const body = await certifying();
    const own = await certify(PRODUCT_OWNER, product, 1, body);
    expect([own.status, own.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
    const failed = await certify(CERTIFIER, product, 1, body);
    expect([failed.status, failed.json.code]).toEqual([422, 'QUALITY_NOT_PASSED']);
    expect((await productOf(product)).certification_status).toBe('NOT_ASSESSED');
    await seedRun(dataset, contract, 1, 'PASSED');
    const done = await certify(CERTIFIER, product, 1, body);
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ resource_id: product, status: 'CERTIFIED', resource_version: 2 });
    expect(await productOf(product)).toMatchObject({
      certification_status: 'CERTIFIED',
      certification_expires_on: body.certification_expires_on,
      certified_by: { membership_id: memberId(CERTIFIER) },
      evidence_count: 1,
      version: 2,
    });
  });

  it('refuses a certification while a dataset of the product has no published contract (422), before it looks at the runs', async () => {
    const draft = await seedDataset();
    await seedRun(draft, await seedContract(draft, 'DRAFT'), 1, 'PASSED');
    const none = await seedDataset();
    const ready = await seedReadyDataset();
    for (const datasets of [[draft], [none], [ready, draft]]) {
      const product = await seedProduct(datasets);
      const refused = await certify(CERTIFIER, product, 1, await certifying());
      expect([refused.status, refused.json.code]).toEqual([422, 'CONTRACT_NOT_PUBLISHED']);
      expect((await productOf(product)).certification_status).toBe('NOT_ASSESSED');
    }
  });

  it('wants a run for every dataset: none yet, one older than the freshness the dataset promises, or one that passed for only one of two datasets, is 422 QUALITY_NOT_PASSED naming none of them', async () => {
    const unrun = await seedDataset();
    await seedContract(unrun, 'PUBLISHED');
    const stale = await seedDataset('INTERNAL', 3600);
    await seedRun(stale, await seedContract(stale, 'PUBLISHED'), 30, 'PASSED');
    const ready = await seedReadyDataset();
    for (const datasets of [[unrun], [stale], [ready, stale]]) {
      const product = await seedProduct(datasets);
      const refused = await certify(CERTIFIER, product, 1, await certifying());
      expect([refused.status, refused.json.code]).toEqual([422, 'QUALITY_NOT_PASSED']);
      expect(JSON.stringify(refused.json)).not.toMatch(/DS-PRODUCT/);
    }
    const together = await seedProduct([ready, await seedReadyDataset()]);
    expect((await certify(CERTIFIER, together, 1, await certifying())).status).toBe(200);
  });

  it('wants what a certification names: evidence, a reason, a day after today and none for the other decisions (422 naming the field), and writes nothing when it refuses', async () => {
    const product = await seedProduct([await seedReadyDataset()]);
    const good = await certifying();
    const cases: Array<[string, Record<string, unknown>]> = [
      ['evidence_refs', { ...good, evidence_refs: [] }],
      ['evidence_refs', { ...good, evidence_refs: [{ blob: 'x'.repeat(5000) }] }],
      ['reason', { ...good, reason: 'short' }],
      ['certification_expires_on', { ...good, certification_expires_on: today }],
      ['certification_expires_on', { ...good, certification_expires_on: await day(-3) }],
      ['certification_expires_on', { ...good, certification_expires_on: '2027-02-30' }],
      ['certification_expires_on', { decision: 'PROVISIONAL', reason: REASON, evidence_refs: [], certification_expires_on: await day(30) }],
    ];
    for (const [field, body] of cases) {
      const reply = await certify(CERTIFIER, product, 1, body);
      expect([reply.status, reply.json.code, reply.json.detail ?? reply.json.field]).toEqual([422, 'VALIDATION_FAILED', field]);
    }
    const missing = { decision: 'CERTIFIED', reason: REASON };
    expect((await certify(CERTIFIER, product, 1, missing)).status).toBe(400);
    expect(await productOf(product)).toMatchObject({ certification_status: 'NOT_ASSESSED', version: 1 });
  });

  it('moves the status along the lines of the design: provisional first without any gate, certified after, revoked with a reason by anybody who may, and a revoked product is final (409 PRODUCT_STATE_INVALID)', async () => {
    const product = await seedProduct([await seedDataset()]);
    const revokeAtStart = await certify(CERTIFIER, product, 1, { decision: 'REVOKED', reason: REASON, evidence_refs: [] });
    expect([revokeAtStart.status, revokeAtStart.json.code]).toEqual([409, 'PRODUCT_STATE_INVALID']);
    const provisional = await certify(CERTIFIER, product, 1, { decision: 'PROVISIONAL', reason: 'Waiting for the first run of the quality rules.', evidence_refs: [] });
    expect([provisional.status, provisional.json.status, provisional.json.resource_version]).toEqual([200, 'PROVISIONAL', 2]);
    const again = await certify(CERTIFIER, product, 2, { decision: 'PROVISIONAL', reason: 'Waiting for the first run of the quality rules.', evidence_refs: [] });
    expect([again.status, again.json.code]).toEqual([409, 'PRODUCT_STATE_INVALID']);
    // The datasets of this product have no contract: it is still provisional, and the certification is refused for it.
    expect((await certify(CERTIFIER, product, 2, await certifying())).json.code).toBe('CONTRACT_NOT_PUBLISHED');
    const ready = await seedProduct([await seedReadyDataset()]);
    expect((await certify(CERTIFIER, ready, 1, await certifying())).status).toBe(200);
    expect((await certify(CERTIFIER, ready, 2, await certifying(300))).json.resource_version).toBe(3);
    const revoked = await certify(PRODUCT_OWNER, ready, 3, { decision: 'REVOKED', reason: 'The source was withdrawn by the Treasury.', evidence_refs: [] });
    expect([revoked.status, revoked.json.status]).toEqual([200, 'REVOKED']);
    expect(await productOf(ready)).toMatchObject({ certification_status: 'REVOKED', revoke_reason: 'The source was withdrawn by the Treasury.', evidence_count: 1 });
    for (const decision of ['CERTIFIED', 'PROVISIONAL', 'REVOKED']) {
      const final = await certify(CERTIFIER, ready, 4, { ...(await certifying()), decision, ...(decision === 'CERTIFIED' ? {} : { certification_expires_on: undefined }) });
      expect([final.status, final.json.code]).toEqual([409, 'PRODUCT_STATE_INVALID']);
    }
  });

  it('is decided against the version that was read: a stale one is 409 VERSION_CONFLICT and nothing changes', async () => {
    const product = await seedProduct([await seedReadyDataset()]);
    const stale = await certify(CERTIFIER, product, 7, await certifying());
    expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
    expect((await productOf(product)).version).toBe(1);
  });

  it('writes one audit row and one event for a decision, with the reason, and none for a refusal', async () => {
    const product = await seedProduct([await seedReadyDataset()]);
    expect((await certify(PRODUCT_OWNER, product, 1, await certifying())).status).toBe(403);
    expect(await rows(`select 1 from machvon.audit_event where action = 'dgv.product_certification_decided' and resource_id = $1`, [product])).toHaveLength(0);
    const done = await certify(CERTIFIER, product, 1, await certifying());
    expect(done.status).toBe(200);
    const audit = await rows<{ safe_diff: Record<string, unknown>; actor_id: string; reason: string | null }>(
      `select safe_diff, actor_id, reason from machvon.audit_event where action = 'dgv.product_certification_decided' and resource_id = $1`,
      [product],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor_id).toBe(memberId(CERTIFIER));
    expect(audit[0]?.safe_diff).toMatchObject({ from: 'NOT_ASSESSED', to: 'CERTIFIED', evidence_count: 1 });
    const events = await rows<{ payload: Record<string, unknown> }>(`select payload from machvon.outbox_event where type = 'dgv.product.certified.v1' and aggregate_id = $1`, [product]);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ product_id: product, status: 'CERTIFIED', previous_status: 'NOT_ASSESSED' });
  });

  it('lets only those who hold the right decide, and those who read the catalogue see the products: the datasets they may not see are counted and never named', async () => {
    const open = await seedReadyDataset();
    const secret = await seedDataset('CONFIDENTIAL');
    const product = await seedProduct([open, secret]);
    expect((await certify(READER, product, 1, await certifying())).status).toBe(403);
    expect((await certify(NOBODY, product, 1, await certifying())).status).toBe(403);
    // The datasets belong to no unit: a grant on a unit subtree does not reach them.
    expect(await certify(UNIT_CERTIFIER, product, 1, await certifying())).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
    expect((await call('GET', '/dgv/data-products', { member: NOBODY })).status).toBe(403);
    const seen = await productOf(product, READER);
    expect(seen).toMatchObject({ datasets_hidden: 1, certification_status: 'NOT_ASSESSED' });
    expect(seen.datasets).toEqual([expect.objectContaining({ id: open, contract_published: true, quality_badge: 'PASSED' })]);
    expect(JSON.stringify(seen)).not.toContain(secret);
    // The owner of the datasets sees them all.
    expect((await productOf(product, PRODUCT_OWNER)).datasets_hidden).toBe(0);
  });

  it('shows what stands between a product and its certification: each dataset with its contract and its badge', async () => {
    const draft = await seedDataset();
    await seedRun(draft, await seedContract(draft, 'DRAFT'), 2, 'FAILED');
    const product = await seedProduct([draft]);
    expect((await productOf(product)).datasets).toEqual([expect.objectContaining({ id: draft, contract_published: false, quality_badge: 'FAILED' })]);
  });

  it('shows nothing of another tenant, and decides nothing on its products (404)', async () => {
    const product = await seedProduct([await seedReadyDataset()]);
    expect(await products(B_CERTIFIER, TENANT_B)).toEqual([]);
    const foreign = await certify(B_CERTIFIER, product, 1, await certifying(), TENANT_B);
    expect(foreign.status).toBe(404);
    expect((await productOf(product)).version).toBe(1);
  });

  it('is kept by the database as well: a product is never deleted, a revoked one never changes, the status moves only along the design, and a certification has its certifier, evidence and last day', async () => {
    const product = await seedProduct([await seedReadyDataset()]);
    await expect(rows('update machvon.data_product set certification_status = $2 where id = $1::uuid', [product, 'REVOKED'])).rejects.toThrow();
    await expect(rows('update machvon.data_product set code = $2 where id = $1::uuid', [product, 'OTHER-CODE'])).rejects.toThrow(/never change/);
    await expect(
      rows(`update machvon.data_product set certification_status = 'CERTIFIED', certified_by = owner_user_id, certified_at = now(), certification_expires_on = current_date + 5, evidence_refs = '[{}]' where id = $1::uuid`, [product]),
    ).rejects.toThrow();
    await expect(
      rows(`update machvon.data_product set certification_status = 'CERTIFIED', certified_by = $2::uuid, certified_at = now(), certification_expires_on = current_date + 5, evidence_refs = '[]' where id = $1::uuid`, [product, memberId(CERTIFIER)]),
    ).rejects.toThrow();
    await certify(CERTIFIER, product, 1, { decision: 'PROVISIONAL', reason: 'Waiting for the first run of the quality rules.', evidence_refs: [] });
    await rows(
      `update machvon.data_product set certification_status = 'CERTIFIED', certified_by = $2::uuid, certified_at = now(), certification_expires_on = current_date + 5, evidence_refs = '[{}]' where id = $1::uuid`,
      [product, memberId(CERTIFIER)],
    );
    await rows(`update machvon.data_product set certification_status = 'REVOKED', revoke_reason = 'The source was withdrawn by the Treasury.' where id = $1::uuid`, [product]);
    await expect(rows(`update machvon.data_product set title = 'Renamed' where id = $1::uuid`, [product])).rejects.toThrow(/revoked/);
    await expect(rows(`update machvon.data_product set certification_status = 'REVOKED', revoke_reason = null where id = $1::uuid`, [product])).rejects.toThrow();
    const asApplication = async (sql: string): Promise<string> =>
      harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(CERTIFIER), scopeVersion: 0 }, (tx) => tx.query(sql)).then(
        () => 'written',
        (error: { message: string }) => error.message,
      );
    expect(await asApplication('delete from machvon.data_product')).toContain('permission denied');
    expect(await rows('select 1 from machvon.data_product where id = $1::uuid', [product])).toHaveLength(1);
  });

  describe('the expiry (the job dgv-product-cert-expiry)', () => {
    const sweep = async (): Promise<number> => {
      const tenants = harness.tenants as TenantDatabase;
      const summary = await tenants.withTenant({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, (tx) => new DgvProductExpiryJob(new AuditWriter(tenants)).run(tx, WORKER_MEMBERSHIP_ID, new Date()));
      return summary.expired;
    };

    async function certified(expiresInDays: number, owner = PRODUCT_OWNER): Promise<string> {
      const product = await seedProduct([await seedReadyDataset()], owner);
      expect((await certify(CERTIFIER, product, 1, await certifying(30))).status).toBe(200);
      await rows('update machvon.data_product set certification_expires_on = ($2::date + $3::int) where id = $1::uuid', [product, today, expiresInDays]);
      return product;
    }

    it('makes a product whose last day has gone provisional again, once, keeps who certified it and tells its owner and BI', async () => {
      const lapsed = await certified(-1);
      const untouched = await certified(0);
      const later = await certified(40);
      const provisional = await seedProduct([await seedDataset()]);
      expect(await sweep()).toBe(1);
      expect(await productOf(lapsed)).toMatchObject({ certification_status: 'PROVISIONAL', certified_by: { membership_id: memberId(CERTIFIER) }, certification_expires_on: await day(-1), version: 3 });
      expect((await productOf(untouched)).certification_status).toBe('CERTIFIED');
      expect((await productOf(later)).certification_status).toBe('CERTIFIED');
      expect((await productOf(provisional)).certification_status).toBe('NOT_ASSESSED');
      const events = await rows<{ payload: Record<string, unknown> }>(`select payload from machvon.outbox_event where type = 'dgv.product.expired.v1' and aggregate_id = $1`, [lapsed]);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({ product_id: lapsed, status: 'PROVISIONAL', expired_on: await day(-1), notification: { recipients: [memberId(PRODUCT_OWNER)] } });
      expect(await rows(`select 1 from machvon.audit_event where action = 'dgv.product_certification_expired' and resource_id = $1`, [lapsed])).toHaveLength(1);
      // Running it again announces nothing twice.
      expect(await sweep()).toBe(0);
      expect(await rows(`select 1 from machvon.outbox_event where type = 'dgv.product.expired.v1' and aggregate_id = $1`, [lapsed])).toHaveLength(1);
    });

    it('reaches the owner through the notification service: the event is registered, the product is read with the right to read the catalogue, and an owner who may not read it is told nothing', async () => {
      const EVENT = 'dgv.product.expired.v1';
      const tenants = harness.tenants as TenantDatabase;
      const row = (await rows<{ payload_schema: unknown; allowed_purposes: string[]; status: 'Active' | 'Deprecated' }>('select payload_schema, allowed_purposes, status from machvon.notification_event_type where event_type = $1 and schema_version = 1', [EVENT]))[0];
      if (row === undefined) throw new Error(`${EVENT} is not registered by a migration`);
      const definition: EventTypeDefinition = { eventType: EVENT, schemaVersion: 1, payloadSchema: row.payload_schema, allowedPurposes: row.allowed_purposes, status: row.status };
      const catalog: EventTypeCatalog = { get: async (eventType, schemaVersion) => (eventType === EVENT && schemaVersion === 1 ? definition : undefined) };
      await rows(
        `insert into machvon.workflow_version (tenant_id, id, business_type, revision, definition_json, status, kind, event_type, created_by, definition_hash)
         values ($1, $2, 'NOTIFICATION', 1, $3::jsonb, 'Published', 'NOTIFICATION', $4, $5, repeat('a', 64))`,
        [TENANT_A, randomUUID(), JSON.stringify({ resolver: { kind: 'explicit' }, priority: 'HIGH', purpose: 'OPERATIONAL' }), EVENT, memberId(CERTIFIER)],
      );
      const metrics = new Counters();
      const consumer = new NotificationConsumer({
        database: tenants,
        store: new NotificationStore(),
        validator: new PayloadValidator(catalog),
        loadAccess: (ctx) => new EffectiveAccessStore(tenants, new InMemoryAuthzCache()).load(ctx),
        resourceAccess: new PermissionResourceAccess(),
        security: { signingKey: SIGNING_KEY, alerts: { raise: () => undefined } },
        metrics,
      });
      const told = await certified(-1);
      const unread = await certified(-1, NOBODY);
      await sweep();
      const deliver = async (product: string): Promise<{ result: unknown; recipients: string[] }> => {
        const event = (await rows<{ id: string; payload: Record<string, unknown>; aggregate_version: string; event_key: string }>(
            `select id, payload, aggregate_version::text as aggregate_version, event_key from machvon.outbox_event where type = $1 and aggregate_id = $2::uuid`,
            [EVENT, product],
          ))[0];
        if (event === undefined) throw new Error('an event was expected');
        const delivery: OutboxDelivery = {
          id: event.id,
          tenantId: TENANT_A,
          tenantContext: signTenantContext({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, SIGNING_KEY),
          type: EVENT,
          schemaVersion: 1,
          aggregateType: 'data_product',
          aggregateId: product,
          aggregateVersion: Number(event.aggregate_version),
          payload: event.payload,
          eventKey: event.event_key,
          correlationId: randomUUID(),
          attempts: 0,
        };
        const result = await consumer.handle(delivery);
        const found = await rows<{ recipient_id: string }>('select recipient_id from machvon.notification_instance where event_id = $1', [event.id]);
        return { result, recipients: found.map((item) => item.recipient_id) };
      };
      expect(await deliver(told)).toEqual({ result: 'processed', recipients: [memberId(PRODUCT_OWNER)] });
      expect((await deliver(unread)).recipients).toEqual([]);
      expect(metrics.counters.get('notification_suppressed_total{reason=no_access}')).toBe(1);
    });

    it('lets the product be certified again after it ran out, against the version the expiry left', async () => {
      const lapsed = await certified(-2);
      await sweep();
      const stale = await certify(CERTIFIER, lapsed, 2, await certifying());
      expect(stale.json.code).toBe('VERSION_CONFLICT');
      const renewed = await certify(CERTIFIER, lapsed, 3, await certifying());
      expect([renewed.status, renewed.json.status]).toEqual([200, 'CERTIFIED']);
    });
  });
});
