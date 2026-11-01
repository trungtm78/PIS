import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_FILTER } from '@nestjs/core';
import { BiDatasetStore, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, odcsSha256, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { dgvModule } from '../../src/modules/dgv';
import { DataContractVersionReadsController, DatasetContractReadsController, DgvContractCommandsController } from '../../src/modules/dgv/dgv-contract.controller';
import { FileService } from '../../src/modules/files/file.service';
import { FsObjectStorage } from '../../src/modules/files/fs-object-storage';
import { MockScanPort } from '../../src/modules/files/mock-scan';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(180_000);

const SIGNING_KEY = randomBytes(32);
const STEWARD = 1; // drafts the revisions (data.contract.manage)
const OWNER = 2; // owns the datasets and publishes (data.contract.approve and data.contract.publish)
const BI_OWNER = 3; // answers for the dataset of BI built on the dataset
const HOME_OWNER = 4; // answers for the module HOME
const EXPORT_OWNER = 5; // answers for the export MNE-07
const READER = 6; // reads the contracts and the catalogue
const NOBODY = 7; // no right over the contracts
const UNIT_STEWARD = 8; // may draft on one unit subtree only
const DUAL = 9; // may draft and publish
const B_STEWARD = 10; // of tenant B
const REASON = 'The change was read and agreed.';

interface Reply {
  status: number;
  json: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const property = (name: string, overrides: Record<string, unknown> = {}) => ({ name, logicalType: 'string', ...overrides });
const AMOUNT = (physicalType: string) => property('amount', { logicalType: 'number', physicalType, customProperties: [{ property: 'unit', value: 'VND' }] });

describe('the data contracts with the approval of the consumers for a breaking change (ST-DGV-005, DGV 3.1 F2, DGV-13, DGV-19, UAT-AC50)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let files: FileService;
  let root = '';
  let sequence = 0;
  let retentionPolicy = '';

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const asApp = (member: number, sql: string, params: unknown[] = []): Promise<unknown> =>
    harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, (tx) => tx.query(sql, params));

  /** A document of the pinned version, with the consumers it declares. */
  const odcs = (properties: unknown[], consumers: Array<{ kind: string; ref: string; owner: number }> = [], extra: Record<string, unknown> = {}) => ({
    apiVersion: 'v3.0.2',
    kind: 'DataContract',
    id: 'ds-disb',
    version: '1.0.0',
    status: 'active',
    schema: [{ name: 'disbursement', properties }],
    customProperties: consumers.map((consumer) => ({ property: 'consumer', value: { kind: consumer.kind, ref: consumer.ref, owner_user_id: memberId(consumer.owner) } })),
    ...extra,
  });
  const R1 = (
    consumers = [
      { kind: 'MODULE', ref: 'HOME', owner: HOME_OWNER },
      { kind: 'EXPORT', ref: 'MNE-07', owner: EXPORT_OWNER },
    ],
  ) => odcs([property('unit_code', { required: true, primaryKey: true }), AMOUNT('numeric(24,0)'), property('note')], consumers);

  const draft = (member: number, datasetId: string, document: unknown, effectiveFrom = '2030-01-01', tenantId?: string): Promise<Reply> =>
    call('POST', '/dgv/dataset-contracts', {
      member,
      body: { dataset_id: datasetId, odcs_version: 'v3.0.2', odcs_json: document, effective_from: effectiveFrom },
      ...(tenantId === undefined ? {} : { tenantId }),
    });
  const publish = (member: number, contract: string, version: number, body: Record<string, unknown> = {}, tenantId?: string): Promise<Reply> =>
    call('POST', `/dgv/dataset-contracts/${contract}/publish`, { member, body, ifMatch: `"${version}"`, ...(tenantId === undefined ? {} : { tenantId }) });
  const decide = (member: number, approval: string, version: number, decision = 'APPROVED', comment?: string): Promise<Reply> =>
    call('POST', `/dgv/contract-consumer-approvals/${approval}/decision`, { member, body: { decision, ...(comment === undefined ? {} : { comment }) }, ifMatch: `"${version}"` });
  const baseline = (member: number, contract: string, version: number, decision: string, evidence: string[] = []): Promise<Reply> =>
    call('POST', `/data-contracts/${contract}/publish`, { member, body: { decision, reason: REASON, evidence_ids: evidence }, ifMatch: `"${version}"` });
  const contract = (id: string, member = READER): Promise<Reply> => call('GET', `/resources/dataset_contract/${id}`, { member });
  const events = (id: string, type: string) =>
    rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at', [id, type]);
  const audits = (action: string) =>
    rows<{ resource_id: string; safe_diff: Record<string, any> }>('select resource_id, safe_diff from machvon.audit_event where action = $1 order by occurred_at', [action]); // eslint-disable-line @typescript-eslint/no-explicit-any

  async function seedDataset(options: { classification?: string; allowedRoles?: string[]; retention?: boolean } = {}): Promise<string> {
    const id = randomUUID();
    sequence += 1;
    await rows(
      `insert into machvon.dataset (tenant_id, id, dataset_code, title, domain, grain, producer_module, owner_user_id, steward_user_id, classification, is_critical, freshness_slo_seconds, retention_policy_id, allowed_role_codes, status, created_by, updated_by)
       values ($1, $2, $3, $3, 'TREASURY', 'one row per disbursement', 'DIS', $4, $5, $6, false, 86400, $7, $8::text[], 'DRAFT', $5, $5)`,
      [
        TENANT_A,
        id,
        `DS-CONTRACT-${sequence}`,
        memberId(OWNER),
        memberId(STEWARD),
        options.classification ?? 'INTERNAL',
        options.retention === false ? null : retentionPolicy,
        options.allowedRoles ?? [],
      ],
    );
    return id;
  }

  async function seedBiDataset(datasetId: string, code: string): Promise<void> {
    await rows(
      `insert into machvon.bi_dataset (tenant_id, id, dataset_code, title, source_kind, grain, join_paths, dgv_dataset_id, owner_user_id, created_by, updated_by, status)
       values ($1, gen_random_uuid(), $2, $2, 'PERIOD_SNAPSHOT', 'project', '{"dimensions":["unit"]}'::jsonb, $3::uuid, $4, $4, $4, 'ACTIVE')`,
      [TENANT_A, code, datasetId, memberId(BI_OWNER)],
    );
  }

  /** The first revision of a dataset: drafted by the steward, published by the owner. */
  async function published(datasetId: string, document: unknown = R1(), effectiveFrom = '2030-01-01'): Promise<{ contract: string; version: string }> {
    const made = await draft(STEWARD, datasetId, document, effectiveFrom);
    expect(made.status).toBe(200);
    const done = await publish(OWNER, made.json.resource_id, made.json.resource_version);
    expect([done.status, done.json.status]).toEqual([200, 'PUBLISHED']);
    return { contract: made.json.resource_id, version: done.json.data_contract_version_id };
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }]);
    for (const n of [STEWARD, OWNER, BI_OWNER, HOME_OWNER, EXPORT_OWNER, READER, NOBODY, UNIT_STEWARD, DUAL]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedMembership(TENANT_B, B_STEWARD, 1);
    await harness.seedRole(TENANT_A, 1, 'DATA_STEWARD', ['data.contract.manage', 'data.catalog.read'], 30);
    await harness.seedRole(TENANT_A, 2, 'DATA_OWNER', ['data.contract.approve', 'data.contract.publish', 'data.catalog.read'], 40);
    await harness.seedRole(TENANT_A, 3, 'CONSUMER', ['data.contract.consume'], 20);
    await harness.seedRole(TENANT_A, 4, 'CONTRACT_READER', ['dataset_contract.read', 'data_contract_version.read', 'data.catalog.read'], 20);
    await harness.seedRole(TENANT_A, 5, 'DATA_DUAL', ['data.contract.manage', 'data.contract.approve', 'data.contract.publish', 'data.catalog.read'], 40);
    await harness.seedRole(TENANT_B, 1, 'DATA_STEWARD', ['data.contract.manage', 'data.catalog.read'], 30);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: STEWARD, role: 1, kind: 'TENANT' },
      { n: 2, member: OWNER, role: 2, kind: 'TENANT' },
      { n: 3, member: BI_OWNER, role: 3, kind: 'TENANT' },
      { n: 4, member: HOME_OWNER, role: 3, kind: 'TENANT' },
      { n: 5, member: EXPORT_OWNER, role: 3, kind: 'TENANT' },
      { n: 6, member: READER, role: 4, kind: 'TENANT' },
      { n: 7, member: UNIT_STEWARD, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(1)] },
      { n: 8, member: DUAL, role: 5, kind: 'TENANT' },
      { n: 9, member: OWNER, role: 4, kind: 'TENANT' },
      { n: 10, member: STEWARD, role: 4, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_STEWARD, role: 1, kind: 'TENANT' }]);
    retentionPolicy = randomUUID();
    await rows(
      `insert into machvon.data_retention_policy (tenant_id, id, record_class, revision, retention_years, retention_basis, legal_basis_ref, end_action, effective_from, status, created_by)
       values ($1, $2, 'data_contract', 1, 10, 'FROM_CREATED', 'Law on Data 60/2024/QH15', 'REVIEW_FOR_DESTRUCTION', date '2026-01-01', 'Draft', $3)`,
      [TENANT_A, retentionPolicy, memberId(OWNER)],
    );
    root = await mkdtemp(join(tmpdir(), 'machvon-dgv-contract-'));
    files = new FileService({ storage: new FsObjectStorage(root), scanner: new MockScanPort(), urlSecret: randomBytes(32), now: () => new Date() });
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [DgvContractCommandsController, DatasetContractReadsController, DataContractVersionReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: FileService, useValue: files },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
    if (root !== '') await rm(root, { recursive: true, force: true });
  }, 60_000);

  it('is registered in the module of DGV', () => {
    for (const controller of [DgvContractCommandsController, DatasetContractReadsController, DataContractVersionReadsController]) expect(dgvModule.controllers).toContain(controller);
  });

  it('UAT-AC50: a breaking revision waits for every consumer (409 listing who), then for a window (422), and is then published as an immutable version with its hash while the version before it serves to the end of the window; an optional column is backward compatible', async () => {
    const dataset = await seedDataset();
    await seedBiDataset(dataset, 'DS-DISB-BI');
    const first = await published(dataset);
    expect((await rows<{ status: string; current_contract_version_id: string }>('select status, current_contract_version_id from machvon.dataset where id = $1', [dataset]))[0]).toMatchObject({
      status: 'ACTIVE',
      current_contract_version_id: first.version,
    });
    // r2 changes the scale of the amount and renames the unit column.
    const breaking = await draft(
      STEWARD,
      dataset,
      odcs(
        [property('org_unit_code', { required: true, primaryKey: true }), AMOUNT('numeric(24,2)'), property('note')],
        [
          { kind: 'MODULE', ref: 'HOME', owner: HOME_OWNER },
          { kind: 'EXPORT', ref: 'MNE-07', owner: EXPORT_OWNER },
        ],
      ),
      '2030-11-01',
    );
    expect(breaking.status).toBe(200);
    expect(breaking.json).toMatchObject({ status: 'IN_REVIEW', compatibility: 'BREAKING', revision: 2, resource_version: 1 });
    const approvals = breaking.json.consumer_approvals as Array<{ id: string; consumer_kind: string; consumer_ref: string; decision: string; version: number }>;
    expect(approvals.map((approval) => `${approval.consumer_kind}:${approval.consumer_ref}:${approval.decision}`)).toEqual([
      'BI_DATASET:DS-DISB-BI:PENDING',
      'EXPORT:MNE-07:PENDING',
      'MODULE:HOME:PENDING',
    ]);
    const byRef = (ref: string) => approvals.find((approval) => approval.consumer_ref === ref) as { id: string; version: number };
    const id = breaking.json.resource_id as string;
    // BI and HOME approve; MNE-07 is still waiting.
    expect((await decide(BI_OWNER, byRef('DS-DISB-BI').id, 1)).status).toBe(200);
    expect((await decide(HOME_OWNER, byRef('HOME').id, 1, 'APPROVED', 'HOME moves to the new column on 2030-11-15')).status).toBe(200);
    const waiting = await publish(OWNER, id, 1, { migration_window_until: '2030-12-31' });
    expect([waiting.status, waiting.json.code]).toEqual([409, 'CONSUMER_APPROVAL_PENDING']);
    expect(waiting.json.consumers).toEqual([{ kind: 'EXPORT', ref: 'MNE-07', decision: 'PENDING' }]);
    // MNE-07 approves; no window.
    expect((await decide(EXPORT_OWNER, byRef('MNE-07').id, 1)).status).toBe(200);
    const bare = await publish(OWNER, id, 1);
    expect([bare.status, bare.json.code, bare.json.detail]).toEqual([422, 'MIGRATION_WINDOW_REQUIRED', 'migration_window_until']);
    // A window that ends before the thirty days are over is no window.
    const short = await publish(OWNER, id, 1, { migration_window_until: '2030-11-30' });
    expect([short.status, short.json.code]).toEqual([422, 'MIGRATION_WINDOW_REQUIRED']);
    const done = await publish(OWNER, id, 1, { migration_window_until: '2030-12-31' });
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ status: 'PUBLISHED', compatibility: 'BREAKING', revision: 2, migration_window_until: '2030-12-31' });
    const document = (await contract(id)).json.odcs_json;
    expect(done.json.odcs_sha256).toBe(odcsSha256(document));
    // The version is immutable, has the hash and the stored document; the version before it serves to the end of the window.
    const newest = await call('GET', `/resources/data_contract_version/${done.json.data_contract_version_id}`, { member: READER });
    expect(newest.status).toBe(200);
    expect(newest.json).toMatchObject({
      revision: 2,
      compatibility: 'BREAKING',
      odcs_sha256: done.json.odcs_sha256,
      supersedes_id: first.version,
      migration_window_until: '2030-12-31',
      serving: true,
      serving_until: null,
    });
    expect(typeof newest.json.odcs_object_key).toBe('string');
    const stored = await files.readStored({ tenantId: TENANT_A, membershipId: memberId(OWNER), scopeVersion: 1 } as never, newest.json.odcs_object_key);
    expect(odcsSha256(JSON.parse(Buffer.from(stored.bytes).toString('utf8')))).toBe(done.json.odcs_sha256);
    const older = await call('GET', `/resources/data_contract_version/${first.version}`, { member: READER });
    expect(older.json).toMatchObject({ revision: 1, serving: true, serving_until: '2030-12-31', compatibility: 'INITIAL' });
    expect((await contract(first.contract)).json.status).toBe('SUPERSEDED');
    expect((await contract(id)).json).toMatchObject({ status: 'PUBLISHED', approved_by: memberId(OWNER) });
    expect((await rows<{ current_contract_version_id: string }>('select current_contract_version_id from machvon.dataset where id = $1', [dataset]))[0]?.current_contract_version_id).toBe(
      done.json.data_contract_version_id,
    );
    // r3 adds an optional column: backward compatible, no consumer is asked, and no window is taken.
    const optional = await draft(
      STEWARD,
      dataset,
      odcs([property('org_unit_code', { required: true, primaryKey: true }), AMOUNT('numeric(24,2)'), property('note'), property('remark')], [{ kind: 'MODULE', ref: 'HOME', owner: HOME_OWNER }]),
      '2031-01-01',
    );
    expect(optional.json).toMatchObject({ compatibility: 'BACKWARD_COMPATIBLE', consumer_approvals: [], revision: 3 });
    const withWindow = await publish(OWNER, optional.json.resource_id, 1, { migration_window_until: '2031-03-01' });
    expect([withWindow.status, withWindow.json.code, withWindow.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'migration_window_until']);
    const plain = await publish(OWNER, optional.json.resource_id, 1);
    expect(plain.status).toBe(200);
    // A backward compatible revision replaces the one before it at once: r2 serves no more (its window was for r1), and r3 serves.
    expect((await call('GET', `/resources/data_contract_version/${done.json.data_contract_version_id}`, { member: READER })).json).toMatchObject({ serving: false, serving_until: null });
    expect((await call('GET', `/resources/data_contract_version/${plain.json.data_contract_version_id}`, { member: READER })).json).toMatchObject({
      serving: true,
      compatibility: 'BACKWARD_COMPATIBLE',
      migration_window_until: null,
    });
  });

  it('records the draft, the decisions and the publication on the audit trail and as events, with the compatibility and the hash', async () => {
    const dataset = await seedDataset();
    const first = await published(dataset);
    const made = await draft(
      STEWARD,
      dataset,
      odcs([property('unit_code', { required: true, primaryKey: true }), AMOUNT('numeric(24,2)'), property('note')], [{ kind: 'MODULE', ref: 'HOME', owner: HOME_OWNER }]),
      '2030-02-01',
    );
    expect(made.json.compatibility).toBe('BREAKING');
    const approvals = made.json.consumer_approvals as Array<{ id: string; consumer_ref: string }>;
    const approval = approvals.find((candidate) => candidate.consumer_ref === 'HOME') as { id: string };
    expect((await decide(EXPORT_OWNER, (approvals.find((candidate) => candidate.consumer_ref === 'MNE-07') as { id: string }).id, 1)).status).toBe(200);
    expect((await decide(HOME_OWNER, approval.id, 1)).status).toBe(200);
    const done = await publish(OWNER, made.json.resource_id, 1, { migration_window_until: '2030-03-15' });
    expect(done.status).toBe(200);
    expect((await events(made.json.resource_id, 'dgv.contract.drafted.v1'))[0]?.payload).toMatchObject({ compatibility: 'BREAKING', revision: 2, consumer_count: 2 });
    expect((await events(approval.id, 'dgv.contract.consumer_decided.v1'))[0]?.payload).toMatchObject({ consumer_kind: 'MODULE', consumer_ref: 'HOME', decision: 'APPROVED' });
    expect((await events(made.json.resource_id, 'dgv.contract.published.v1'))[0]?.payload).toMatchObject({
      compatibility: 'BREAKING',
      odcs_sha256: done.json.odcs_sha256,
      migration_window_until: '2030-03-15',
    });
    expect((await audits('dgv.contract_drafted')).some((entry) => entry.resource_id === made.json.resource_id && entry.safe_diff.compatibility === 'BREAKING')).toBe(true);
    expect((await audits('dgv.contract_consumer_decided')).some((entry) => entry.resource_id === approval.id && entry.safe_diff.to === 'APPROVED')).toBe(true);
    expect((await audits('dgv.contract_published')).some((entry) => entry.resource_id === made.json.resource_id && entry.safe_diff.supersedes_id === first.version)).toBe(true);
  });

  describe('the document', () => {
    it.each([
      ['a version the platform does not pin', { odcs_version: 'v2.2.2' }, 'odcs_version'],
      ['a document of another version than the one named', { odcs_version: 'v3.0.1' }, 'apiVersion'],
    ])('refuses %s as 422 ODCS_SCHEMA_INVALID', async (_name, override, path) => {
      const dataset = await seedDataset();
      const reply = await call('POST', '/dgv/dataset-contracts', {
        member: STEWARD,
        body: { dataset_id: dataset, odcs_json: R1(), effective_from: '2030-01-01', ...{ odcs_version: 'v3.0.2' }, ...override },
      });
      expect([reply.status, reply.json.code, reply.json.detail]).toEqual([422, 'ODCS_SCHEMA_INVALID', path]);
    });

    it('refuses a document that is not one, naming the path, and a consumer whose owner is not a person of the tenant', async () => {
      const dataset = await seedDataset();
      const bad = await draft(STEWARD, dataset, odcs([property('a', { logicalType: 'decimal' })]));
      expect([bad.status, bad.json.code, bad.json.detail]).toEqual([422, 'ODCS_SCHEMA_INVALID', 'schema[0].properties[0].logicalType']);
      const stranger = await draft(STEWARD, dataset, odcs([property('a')], [{ kind: 'MODULE', ref: 'HOME', owner: B_STEWARD }]));
      expect([stranger.status, stranger.json.code, stranger.json.detail]).toEqual([422, 'ODCS_SCHEMA_INVALID', 'customProperties']);
      expect(await rows('select 1 from machvon.dataset_contract where dataset_id = $1', [dataset])).toEqual([]);
    });

    it('refuses an effective day that is not a day, and a body that has more than the contract has', async () => {
      const dataset = await seedDataset();
      expect((await draft(STEWARD, dataset, R1(), '2030-13-45')).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'effective_from' });
      expect((await draft(STEWARD, dataset, R1(), 'soon')).status).toBeGreaterThanOrEqual(400);
      expect(
        (await call('POST', '/dgv/dataset-contracts', { member: STEWARD, body: { dataset_id: dataset, odcs_version: 'v3.0.2', odcs_json: R1(), effective_from: '2030-01-01', status: 'PUBLISHED' } }))
          .status,
      ).toBe(400);
    });

    it('takes the freshness the document declares, and the freshness of the dataset when it declares none', async () => {
      const dataset = await seedDataset();
      const declared = await draft(STEWARD, dataset, odcs([property('a')], [], { slaProperties: [{ property: 'freshness', value: 6, unit: 'h' }] }));
      expect((await rows<{ freshness_seconds: string }>('select freshness_seconds::text from machvon.dataset_contract where id = $1', [declared.json.resource_id]))[0]?.freshness_seconds).toBe(
        '21600',
      );
      await baseline(DUAL, declared.json.resource_id, 1, 'reject');
      const plain = await draft(STEWARD, dataset, odcs([property('a')]));
      expect((await rows<{ freshness_seconds: string }>('select freshness_seconds::text from machvon.dataset_contract where id = $1', [plain.json.resource_id]))[0]?.freshness_seconds).toBe('86400');
    });
  });

  describe('one revision is open at a time', () => {
    it('is 409 CONTRACT_REVISION_OPEN for a second draft while one is in review, also when two are drafted together, and free again once the open one is closed', async () => {
      const dataset = await seedDataset();
      const [one, two] = await Promise.all([draft(STEWARD, dataset, odcs([property('a')])), draft(STEWARD, dataset, odcs([property('b')]))]);
      expect([one.status, two.status].sort()).toEqual([200, 409]);
      const open = one.status === 200 ? one : two;
      const refused = one.status === 200 ? two : one;
      expect(refused.json).toMatchObject({ code: 'CONTRACT_REVISION_OPEN' });
      expect((await baseline(DUAL, open.json.resource_id, 1, 'return')).json).toMatchObject({ status: 'RETURNED' });
      const next = await draft(STEWARD, dataset, odcs([property('c')]));
      expect(next.status).toBe(200);
      expect(next.json.revision).toBe(2);
    });

    it('closes a revision by rejecting it, when a consumer rejects or the owner decides so: the producer drafts another', async () => {
      const dataset = await seedDataset();
      await published(dataset);
      const made = await draft(
        STEWARD,
        dataset,
        odcs(
          [property('org_unit_code', { required: true, primaryKey: true }), AMOUNT('numeric(24,0)'), property('note')],
          [
            { kind: 'MODULE', ref: 'HOME', owner: HOME_OWNER },
            { kind: 'EXPORT', ref: 'MNE-07', owner: EXPORT_OWNER },
          ],
        ),
      );
      expect(made.json.compatibility).toBe('BREAKING');
      const asked = made.json.consumer_approvals as Array<{ id: string; consumer_ref: string }>;
      const home = asked.find((approval) => approval.consumer_ref === 'HOME') as { id: string };
      const mne = asked.find((approval) => approval.consumer_ref === 'MNE-07') as { id: string };
      expect((await decide(HOME_OWNER, home.id, 1, 'REJECTED', 'We cannot move before the year end')).status).toBe(200);
      expect((await decide(EXPORT_OWNER, mne.id, 1)).status).toBe(200);
      const blocked = await publish(OWNER, made.json.resource_id, 1, { migration_window_until: '2031-01-01' });
      expect([blocked.status, blocked.json.code]).toEqual([409, 'CONSUMER_APPROVAL_PENDING']);
      expect(blocked.json.consumers).toEqual([{ kind: 'MODULE', ref: 'HOME', decision: 'REJECTED' }]);
      const rejected = await baseline(OWNER, made.json.resource_id, 1, 'reject', [randomUUID()]);
      expect(rejected.json).toMatchObject({ status: 'REJECTED', revision: 2 });
      expect((await audits('dgv.contract_rejected')).some((entry) => entry.resource_id === made.json.resource_id)).toBe(true);
      expect((await draft(STEWARD, dataset, odcs([property('x')]))).status).toBe(200);
    });
  });

  describe('the consumers', () => {
    async function breakingRevision(): Promise<{ id: string; approvals: Array<{ id: string; consumer_ref: string; version: number }> }> {
      const dataset = await seedDataset();
      await published(dataset);
      const made = await draft(
        STEWARD,
        dataset,
        odcs(
          [property('org_unit_code', { required: true, primaryKey: true }), AMOUNT('numeric(24,0)'), property('note')],
          [
            { kind: 'MODULE', ref: 'HOME', owner: HOME_OWNER },
            { kind: 'EXPORT', ref: 'MNE-07', owner: EXPORT_OWNER },
          ],
        ),
      );
      return { id: made.json.resource_id, approvals: made.json.consumer_approvals };
    }

    it('are answered for by their owner only (403 NOT_CONSUMER_OWNER), once, against the version that was read', async () => {
      const { approvals } = await breakingRevision();
      const home = approvals.find((approval) => approval.consumer_ref === 'HOME') as { id: string };
      expect((await decide(EXPORT_OWNER, home.id, 1)).json).toMatchObject({ code: 'NOT_CONSUMER_OWNER' });
      expect((await decide(OWNER, home.id, 1)).status).toBe(403);
      const stale = await decide(HOME_OWNER, home.id, 7);
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const done = await decide(HOME_OWNER, home.id, 1, 'APPROVED', '  agreed  ');
      expect(done.json).toMatchObject({ status: 'APPROVED', resource_version: 2 });
      expect((await rows<{ decided_by: string; comment: string }>('select decided_by, comment from machvon.contract_consumer_approval where id = $1', [home.id]))[0]).toEqual({
        decided_by: memberId(HOME_OWNER),
        comment: 'agreed',
      });
      const again = await decide(HOME_OWNER, home.id, 2, 'REJECTED');
      expect([again.status, again.json.code]).toEqual([409, 'STAGE_TRANSITION_DENIED']);
      expect((await decide(HOME_OWNER, randomUUID(), 1)).status).toBe(404);
    });

    it('waits for a revision that is being closed: a decision that meets it is refused as the revision is no longer in review', async () => {
      const { id, approvals } = await breakingRevision();
      const home = approvals.find((approval) => approval.consumer_ref === 'HOME') as { id: string };
      let release!: () => void;
      let locked!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const isLocked = new Promise<void>((resolve) => (locked = resolve));
      // The revision is locked and closed by another command, which has not committed yet.
      const closing = harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(OWNER), scopeVersion: 1 }, async (tx) => {
        await tx.query('select 1 from machvon.dataset_contract where id = $1::uuid for update', [id]);
        locked();
        await held;
        await tx.query("update machvon.dataset_contract set status = 'REJECTED', version = version + 1 where id = $1::uuid", [id]);
      });
      await isLocked;
      const deciding = decide(HOME_OWNER, home.id, 1);
      await new Promise((resolve) => setTimeout(resolve, 400));
      release();
      await closing;
      const late = await deciding;
      expect([late.status, late.json.code]).toEqual([409, 'STAGE_TRANSITION_DENIED']);
      expect((await rows<{ decision: string }>('select decision from machvon.contract_consumer_approval where id = $1', [home.id]))[0]?.decision).toBe('PENDING');
    });

    it('refuses a window that has ended by the day of the publication, whatever the day the revision takes effect', async () => {
      const dataset = await seedDataset();
      await published(dataset, R1([]), '2019-01-01');
      const made = await draft(STEWARD, dataset, odcs([property('org_unit_code', { required: true, primaryKey: true }), AMOUNT('numeric(24,0)'), property('note')], []), '2020-01-01');
      expect([made.status, made.json.compatibility]).toEqual([200, 'BREAKING']);
      const expired = await publish(OWNER, made.json.resource_id, 1, { migration_window_until: '2020-03-01' });
      expect([expired.status, expired.json.code]).toEqual([422, 'MIGRATION_WINDOW_REQUIRED']);
    });

    it('refuses a decision that is neither, and a comment that is too long', async () => {
      const { approvals } = await breakingRevision();
      const home = approvals.find((approval) => approval.consumer_ref === 'HOME') as { id: string };
      expect((await decide(HOME_OWNER, home.id, 1, 'PENDING')).status).toBeGreaterThanOrEqual(400);
      expect((await decide(HOME_OWNER, home.id, 1, 'APPROVED', 'x'.repeat(2001))).status).toBeGreaterThanOrEqual(400);
      expect((await decide(HOME_OWNER, home.id, 1)).status).toBe(200);
    });

    it('cannot decide for a revision that is not in review any more', async () => {
      const { id, approvals } = await breakingRevision();
      await baseline(DUAL, id, 1, 'reject');
      const home = approvals.find((approval) => approval.consumer_ref === 'HOME') as { id: string };
      const late = await decide(HOME_OWNER, home.id, 1);
      expect([late.status, late.json.code]).toEqual([409, 'STAGE_TRANSITION_DENIED']);
    });

    it('are the consumers of the published contract and the datasets of BI built on the dataset, whatever the revision declares: leaving one out does not spare its owner', async () => {
      const dataset = await seedDataset();
      await seedBiDataset(dataset, 'DS-BI-ONE');
      await published(dataset);
      const made = await draft(STEWARD, dataset, odcs([property('org_unit_code', { required: true, primaryKey: true }), AMOUNT('numeric(24,0)'), property('note')], []));
      expect((made.json.consumer_approvals as Array<{ consumer_kind: string; consumer_ref: string }>).map((approval) => `${approval.consumer_kind}:${approval.consumer_ref}`)).toEqual([
        'BI_DATASET:DS-BI-ONE',
        'EXPORT:MNE-07',
        'MODULE:HOME',
      ]);
    });

    it('are answered for by the owner the platform knows for a dataset of BI, whoever the document names', async () => {
      const dataset = await seedDataset();
      await seedBiDataset(dataset, 'DS-BI-CLAIMED');
      await published(dataset, R1([]));
      const made = await draft(
        STEWARD,
        dataset,
        odcs([property('org_unit_code', { required: true, primaryKey: true }), AMOUNT('numeric(24,0)'), property('note')], [{ kind: 'BI_DATASET', ref: 'DS-BI-CLAIMED', owner: HOME_OWNER }]),
      );
      const asked = made.json.consumer_approvals as Array<{ id: string; consumer_kind: string; consumer_ref: string }>;
      expect(asked.map((approval) => `${approval.consumer_kind}:${approval.consumer_ref}`)).toEqual(['BI_DATASET:DS-BI-CLAIMED']);
      const only = asked[0] as { id: string };
      expect((await rows<{ consumer_owner_user_id: string }>('select consumer_owner_user_id from machvon.contract_consumer_approval where id = $1', [only.id]))[0]?.consumer_owner_user_id).toBe(
        memberId(BI_OWNER),
      );
      // The person the document names cannot answer for it.
      expect((await decide(HOME_OWNER, only.id, 1)).json).toMatchObject({ code: 'NOT_CONSUMER_OWNER' });
      expect((await decide(BI_OWNER, only.id, 1)).status).toBe(200);
    });

    it('are not answered for by the owner the document named when the platform comes to know the consumer under another owner: the publication is refused and the approval is not reassigned', async () => {
      const dataset = await seedDataset();
      const claimed = [{ kind: 'BI_DATASET', ref: 'DS-BI-MISPLACED', owner: HOME_OWNER }];
      await published(dataset, R1(claimed));
      const made = await draft(STEWARD, dataset, odcs([property('org_unit_code', { required: true, primaryKey: true }), AMOUNT('numeric(24,0)'), property('note')], claimed));
      const only = (made.json.consumer_approvals as Array<{ id: string }>)[0] as { id: string };
      expect((await decide(HOME_OWNER, only.id, 1)).status).toBe(200);
      await seedBiDataset(dataset, 'DS-BI-MISPLACED');
      const refused = await publish(OWNER, made.json.resource_id, 1, { migration_window_until: '2030-12-31' });
      expect([refused.status, refused.json.code]).toEqual([409, 'CONSUMER_APPROVAL_PENDING']);
      expect(refused.json.consumers).toEqual([{ kind: 'BI_DATASET', ref: 'DS-BI-MISPLACED', decision: 'PENDING' }]);
      expect((await rows<{ status: string }>('select status from machvon.dataset_contract where id = $1', [made.json.resource_id]))[0]?.status).toBe('IN_REVIEW');
      // Another revision can be drafted once this one is closed, and asks the owner the platform knows.
      expect((await baseline(DUAL, made.json.resource_id, 1, 'reject')).status).toBe(200);
      const again = await draft(STEWARD, dataset, odcs([property('org_unit_code', { required: true, primaryKey: true }), AMOUNT('numeric(24,0)'), property('note')], claimed));
      expect(
        (await rows<{ consumer_owner_user_id: string }>('select consumer_owner_user_id from machvon.contract_consumer_approval where contract_id = $1', [again.json.resource_id]))[0]
          ?.consumer_owner_user_id,
      ).toBe(memberId(BI_OWNER));
    });

    it('are read after the dataset is locked: a dataset of BI that is being built on it is seen by the publication, which waits for its owner', async () => {
      const { id, approvals } = await breakingRevision();
      for (const approval of approvals) expect((await decide(approval.consumer_ref === 'HOME' ? HOME_OWNER : EXPORT_OWNER, approval.id, 1)).status).toBe(200);
      const dataset = (await rows<{ dataset_id: string }>('select dataset_id from machvon.dataset_contract where id = $1', [id]))[0]?.dataset_id as string;
      let release!: () => void;
      let built!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const isBuilt = new Promise<void>((resolve) => (built = resolve));
      // The dataset of BI is built on the dataset by a command that has not committed yet.
      const building = harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(BI_OWNER), scopeVersion: 1 }, async (tx) => {
        await tx.query('select id from machvon.dataset where id = $1::uuid for share', [dataset]);
        await tx.query(
          `insert into machvon.bi_dataset (tenant_id, id, dataset_code, title, source_kind, grain, join_paths, dgv_dataset_id, owner_user_id, created_by, updated_by, status)
           values ($1, gen_random_uuid(), 'DS-BI-RACE', 'DS-BI-RACE', 'PERIOD_SNAPSHOT', 'project', '{"dimensions":["unit"]}'::jsonb, $2::uuid, $3, $3, $3, 'ACTIVE')`,
          [TENANT_A, dataset, memberId(BI_OWNER)],
        );
        built();
        await held;
      });
      await isBuilt;
      const publishing = publish(OWNER, id, 1, { migration_window_until: '2030-12-31' });
      await new Promise((resolve) => setTimeout(resolve, 400));
      release();
      await building;
      const reply = await publishing;
      expect([reply.status, reply.json.code]).toEqual([409, 'CONSUMER_APPROVAL_PENDING']);
      expect(reply.json.consumers).toEqual([{ kind: 'BI_DATASET', ref: 'DS-BI-RACE', decision: 'PENDING' }]);
    });

    it('are asked again at the publication when a dataset of BI was built on the dataset after the draft: the publication waits for its owner and the question is kept', async () => {
      const { id, approvals } = await breakingRevision();
      for (const approval of approvals) expect((await decide(approval.consumer_ref === 'HOME' ? HOME_OWNER : EXPORT_OWNER, approval.id, 1)).status).toBe(200);
      const dataset = (await rows<{ dataset_id: string }>('select dataset_id from machvon.dataset_contract where id = $1', [id]))[0]?.dataset_id as string;
      await seedBiDataset(dataset, 'DS-BI-LATE');
      const asked = await publish(OWNER, id, 1, { migration_window_until: '2030-12-31' });
      expect([asked.status, asked.json.code]).toEqual([409, 'CONSUMER_APPROVAL_PENDING']);
      expect(asked.json.consumers).toEqual([{ kind: 'BI_DATASET', ref: 'DS-BI-LATE', decision: 'PENDING' }]);
      // What was written stays: the revision is still in review, with the owner of the dataset asked, and nothing is published.
      expect((await rows<{ status: string }>('select status from machvon.dataset_contract where id = $1', [id]))[0]?.status).toBe('IN_REVIEW');
      expect((await rows<{ n: string }>('select count(*)::text as n from machvon.data_contract_version where contract_id = $1', [id]))[0]?.n).toBe('0');
      const late = await rows<{ id: string; consumer_owner_user_id: string; decision: string }>(
        "select id, consumer_owner_user_id, decision from machvon.contract_consumer_approval where contract_id = $1 and consumer_ref = 'DS-BI-LATE'",
        [id],
      );
      expect(late.map((row) => [row.consumer_owner_user_id, row.decision])).toEqual([[memberId(BI_OWNER), 'PENDING']]);
      expect((await audits('dgv.contract_consumers_added')).some((entry) => entry.resource_id === id)).toBe(true);
      // The owner answers, and the publication goes through.
      expect((await decide(BI_OWNER, (late[0] as { id: string }).id, 1)).status).toBe(200);
      const done = await publish(OWNER, id, 1, { migration_window_until: '2030-12-31' });
      expect([done.status, done.json.status]).toEqual([200, 'PUBLISHED']);
    });

    it('are told to their owner by a list of their own, whether or not the owner may see the dataset or read the contracts', async () => {
      const { id, approvals } = await breakingRevision();
      const mine = await call('GET', '/dgv/contract-consumer-approvals', { member: HOME_OWNER });
      expect(mine.status).toBe(200);
      const items = mine.json.items as Array<{
        id: string;
        consumer_ref: string;
        decision: string;
        version: number;
        contract: { id: string; dataset_code: string; revision: number; status: string; compatibility: string; effective_from: string };
      }>;
      const home = approvals.find((approval) => approval.consumer_ref === 'HOME') as { id: string };
      const found = items.find((item) => item.id === home.id);
      expect(found).toMatchObject({
        consumer_ref: 'HOME',
        decision: 'PENDING',
        version: 1,
        contract: { id, status: 'IN_REVIEW', compatibility: 'BREAKING', revision: 2, effective_from: '2030-01-01' },
      });
      // The owner is told what changes, whether or not they may read the contract.
      const told = (found as unknown as { contract: { changes: Array<{ kind: string; breaking: boolean }> } }).contract.changes;
      expect(told.map((change) => change.kind)).toEqual(expect.arrayContaining(['COLUMN_REMOVED', 'GRAIN_CHANGED']));
      expect(told.some((change) => change.breaking)).toBe(true);
      // Nobody else's approval is in it.
      expect(items.every((item) => item.id !== approvals.find((approval) => approval.consumer_ref === 'MNE-07')?.id)).toBe(true);
      expect((await call('GET', '/dgv/contract-consumer-approvals', { member: EXPORT_OWNER })).json.items.some((item: { id: string }) => item.id === home.id)).toBe(false);
      // The owner has no right over the catalogue and none to read the contracts: the contracts are not theirs to read, the approval is.
      expect((await call('GET', '/resources/dataset_contract', { member: HOME_OWNER })).status).toBe(403);
      expect((await decide(HOME_OWNER, home.id, 1)).status).toBe(200);
      const decided = await call('GET', '/dgv/contract-consumer-approvals?decision=APPROVED', { member: HOME_OWNER });
      expect((decided.json.items as Array<{ id: string }>).some((item) => item.id === home.id)).toBe(true);
      const pending = await call('GET', '/dgv/contract-consumer-approvals?decision=PENDING', { member: HOME_OWNER });
      expect((pending.json.items as Array<{ id: string }>).some((item) => item.id === home.id)).toBe(false);
    });

    it('page through the approvals of a person, and refuse a filter that is none or a person with no right to consume', async () => {
      const first = await breakingRevision();
      const second = await breakingRevision();
      const wanted = [first, second].map((made) => (made.approvals.find((approval) => approval.consumer_ref === 'HOME') as { id: string }).id);
      const seen: string[] = [];
      let cursor = '';
      for (let page = 0; page < 20; page += 1) {
        const reply = await call('GET', `/dgv/contract-consumer-approvals?limit=1${cursor}`, { member: HOME_OWNER });
        seen.push(...(reply.json.items as Array<{ id: string }>).map((item) => item.id));
        if (reply.json.next_cursor === null) break;
        cursor = `&cursor=${reply.json.next_cursor as string}`;
      }
      for (const id of wanted) expect(seen).toContain(id);
      expect(new Set(seen).size).toBe(seen.length);
      for (const query of ['?decision=MAYBE', '?limit=0', '?limit=201', '?cursor=bad'])
        expect((await call('GET', `/dgv/contract-consumer-approvals${query}`, { member: HOME_OWNER })).status).toBe(422);
      expect((await call('GET', '/dgv/contract-consumer-approvals', { member: NOBODY })).status).toBe(403);
    });

    it('are none for a first revision, and a breaking one with no consumer needs the window only', async () => {
      const dataset = await seedDataset();
      await published(dataset, odcs([property('a', { required: true })]));
      const made = await draft(STEWARD, dataset, odcs([property('b')]), '2030-05-01');
      expect(made.json).toMatchObject({ compatibility: 'BREAKING', consumer_approvals: [] });
      expect((await publish(OWNER, made.json.resource_id, 1)).json).toMatchObject({ code: 'MIGRATION_WINDOW_REQUIRED' });
      expect((await publish(OWNER, made.json.resource_id, 1, { migration_window_until: '2030-05-31' })).status).toBe(200);
    });
  });

  describe('the quality the document declares', () => {
    it('is kept in the version that is published, as it was in the revision', async () => {
      const dataset = await seedDataset();
      const rules = [
        { rule: 'nullCheck', column: 'amount' },
        { rule: 'range', column: 'amount', min: 0 },
      ];
      const made = await draft(STEWARD, dataset, odcs([property('a')], [], { quality: rules }));
      expect((await rows<{ quality_json: unknown }>('select quality_json from machvon.dataset_contract where id = $1', [made.json.resource_id]))[0]?.quality_json).toEqual({ rules });
      const done = await publish(OWNER, made.json.resource_id, 1);
      expect((await rows<{ quality_rules: unknown }>('select quality_rules from machvon.data_contract_version where id = $1', [done.json.data_contract_version_id]))[0]?.quality_rules).toEqual({
        rules,
      });
    });
  });

  describe('the publication', () => {
    it('is refused to the person who drafted the revision (403 SELF_APPROVAL_DENIED), for both commands, and nothing is stored', async () => {
      const dataset = await seedDataset();
      const made = await draft(DUAL, dataset, odcs([property('a')]));
      const own = await publish(DUAL, made.json.resource_id, 1);
      expect([own.status, own.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      expect((await baseline(DUAL, made.json.resource_id, 1, 'approve')).json).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
      expect((await baseline(DUAL, made.json.resource_id, 1, 'return')).json).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
      expect(await rows('select 1 from machvon.data_contract_version where dataset_id = $1', [dataset])).toEqual([]);
      expect((await rows<{ status: string }>('select status from machvon.dataset_contract where id = $1', [made.json.resource_id]))[0]?.status).toBe('IN_REVIEW');
    });

    it('judges the version first (409 VERSION_CONFLICT), then the state (409 STAGE_TRANSITION_DENIED), and leaves no file of a refused publication', async () => {
      const dataset = await seedDataset();
      const made = await draft(STEWARD, dataset, odcs([property('a')]));
      const stale = await publish(OWNER, made.json.resource_id, 9);
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const kept = await files.listKind({ tenantId: TENANT_A } as never, 'dgv_contract');
      expect((await publish(OWNER, made.json.resource_id, 1)).status).toBe(200);
      const again = await publish(OWNER, made.json.resource_id, 2);
      expect([again.status, again.json.code]).toEqual([409, 'STAGE_TRANSITION_DENIED']);
      expect((await files.listKind({ tenantId: TENANT_A } as never, 'dgv_contract')).length).toBe(kept.length + 1);
    });

    it('is one publication when two come together: the other is refused, and one version is written', async () => {
      const dataset = await seedDataset();
      const made = await draft(STEWARD, dataset, odcs([property('a')]));
      const [one, two] = await Promise.all([publish(OWNER, made.json.resource_id, 1), publish(OWNER, made.json.resource_id, 1)]);
      expect([one.status, two.status].sort()).toEqual([200, 409]);
      expect(await rows('select 1 from machvon.data_contract_version where dataset_id = $1', [dataset])).toHaveLength(1);
    });

    it('needs the dataset to have a retention policy, as the version it makes does (422), and the revision stays in review', async () => {
      const dataset = await seedDataset({ retention: false });
      const made = await draft(STEWARD, dataset, odcs([property('a')]));
      const refused = await publish(OWNER, made.json.resource_id, 1);
      expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'retention_policy_id']);
      expect((await rows<{ status: string }>('select status from machvon.dataset_contract where id = $1', [made.json.resource_id]))[0]?.status).toBe('IN_REVIEW');
    });

    it('approves with the baseline command as it publishes with the other, and a breaking one needs the window only the other takes', async () => {
      const dataset = await seedDataset();
      await published(dataset, odcs([property('a', { required: true })]));
      const breaking = await draft(STEWARD, dataset, odcs([property('b')]));
      const refused = await baseline(OWNER, breaking.json.resource_id, 1, 'approve', [randomUUID()]);
      expect([refused.status, refused.json.code]).toEqual([422, 'MIGRATION_WINDOW_REQUIRED']);
      expect((await baseline(OWNER, breaking.json.resource_id, 1, 'return')).json).toMatchObject({ status: 'RETURNED' });
      const plain = await draft(STEWARD, dataset, odcs([property('a', { required: true }), property('c')]));
      const done = await baseline(OWNER, plain.json.resource_id, 1, 'approve', [randomUUID()]);
      expect(done.json).toMatchObject({ status: 'PUBLISHED', compatibility: 'BACKWARD_COMPATIBLE' });
      expect((await audits('dgv.contract_published')).some((entry) => entry.resource_id === plain.json.resource_id)).toBe(true);
    });

    it('refuses a baseline decision that is none of the three, and a reason that is blank', async () => {
      const dataset = await seedDataset();
      const made = await draft(STEWARD, dataset, odcs([property('a')]));
      expect((await baseline(OWNER, made.json.resource_id, 1, 'maybe')).status).toBeGreaterThanOrEqual(400);
      const blank = await call('POST', `/data-contracts/${made.json.resource_id}/publish`, { member: OWNER, body: { decision: 'approve', reason: '   ', evidence_ids: [] }, ifMatch: '"1"' });
      expect(blank.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('who may', () => {
    it('is refused to a person with no right over the contracts, and to a right over one unit only (403)', async () => {
      const dataset = await seedDataset();
      expect((await draft(NOBODY, dataset, R1())).status).toBe(403);
      const unit = await draft(UNIT_STEWARD, dataset, R1());
      expect([unit.status, unit.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const made = await draft(STEWARD, dataset, odcs([property('a')]));
      expect((await publish(NOBODY, made.json.resource_id, 1)).status).toBe(403);
      expect((await publish(STEWARD, made.json.resource_id, 1)).status).toBe(403);
      expect((await baseline(NOBODY, made.json.resource_id, 1, 'reject')).status).toBe(403);
      expect((await decide(NOBODY, randomUUID(), 1)).status).toBe(403);
    });

    it('does not draft for a dataset the person may not see (404), nor for one of another tenant', async () => {
      const hidden = await seedDataset({ classification: 'CONFIDENTIAL', allowedRoles: ['SOMEONE_ELSE'] });
      // A person with the right over the whole tenant who is neither the owner, the steward nor the registrant of the dataset does not see it.
      const unseen = await draft(DUAL, hidden, R1());
      expect([unseen.status, unseen.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      const foreign = await draft(B_STEWARD, hidden, R1(), '2030-01-01', TENANT_B);
      expect([foreign.status, foreign.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect((await draft(STEWARD, randomUUID(), R1())).status).toBe(404);
      expect(await rows('select 1 from machvon.dataset_contract where dataset_id = $1', [hidden])).toEqual([]);
    });

    it('reads the contracts of the datasets the person may see only', async () => {
      const visible = await seedDataset();
      const hidden = await seedDataset({ classification: 'CONFIDENTIAL', allowedRoles: ['SOMEONE_ELSE'] });
      const one = await draft(STEWARD, visible, odcs([property('a')]));
      const two = await draft(STEWARD, hidden, odcs([property('a')]));
      const asReader = await call('GET', `/resources/dataset_contract?limit=200`, { member: READER });
      const ids = (asReader.json.items as Array<{ id: string }>).map((item) => item.id);
      expect(ids).toContain(one.json.resource_id);
      expect(ids).not.toContain(two.json.resource_id);
      expect((await contract(two.json.resource_id)).status).toBe(404);
      expect((await call('GET', `/resources/dataset_contract/${randomUUID()}`, { member: READER })).status).toBe(404);
      expect((await call('GET', '/resources/dataset_contract', { member: NOBODY })).status).toBe(403);
      expect((await call('GET', `/resources/dataset_contract/${one.json.resource_id}`, { member: B_STEWARD, tenantId: TENANT_B })).status).toBe(403);
    });
  });

  describe('the reads', () => {
    it('list the revisions newest first, by dataset and by state, a page at a time, with the consumers of those in review', async () => {
      const dataset = await seedDataset();
      await published(dataset);
      const second = await draft(
        STEWARD,
        dataset,
        odcs([property('org_unit_code', { required: true, primaryKey: true }), AMOUNT('numeric(24,0)'), property('note')], [{ kind: 'MODULE', ref: 'HOME', owner: HOME_OWNER }]),
      );
      const all = await call('GET', `/resources/dataset_contract?dataset_id=${dataset}`, { member: READER });
      expect((all.json.items as Array<{ revision: number }>).map((item) => item.revision)).toEqual([2, 1]);
      const review = await call('GET', `/resources/dataset_contract?dataset_id=${dataset}&status=IN_REVIEW`, { member: READER });
      expect((review.json.items as Array<{ id: string; consumer_approvals: unknown[] }>).map((item) => [item.id, item.consumer_approvals.length])).toEqual([[second.json.resource_id, 2]]);
      const first = await call('GET', `/resources/dataset_contract?dataset_id=${dataset}&limit=1`, { member: READER });
      expect(first.json.items).toHaveLength(1);
      expect(typeof first.json.next_cursor).toBe('string');
      const next = await call('GET', `/resources/dataset_contract?dataset_id=${dataset}&limit=1&cursor=${first.json.next_cursor}`, { member: READER });
      expect((next.json.items as Array<{ revision: number }>)[0]?.revision).toBe(1);
      expect(next.json.next_cursor).toBeNull();
      for (const query of ['?status=LOST', '?dataset_id=x', '?limit=0', '?limit=201', '?cursor=bad', '?limit=abc'])
        expect((await call('GET', `/resources/dataset_contract${query}`, { member: READER })).status).toBe(422);
    });

    it('page through revisions and versions made together, without losing one at the edge of a page: the cursor keeps the time as the database wrote it', async () => {
      const dataset = await seedDataset();
      // Three revisions and three versions written by one statement have one time to the microsecond.
      await rows(
        `insert into machvon.dataset_contract (tenant_id, id, dataset_code, revision, owner_id, schema_json, quality_json, freshness_seconds, classification, status, dataset_id, odcs_version, odcs_json, producer_module, compatibility, effective_from, created_by)
         select $1, gen_random_uuid(), (select dataset_code from machvon.dataset where id = $2), g, $3, '{"columns":[]}'::jsonb, '{}'::jsonb, 3600, 'INTERNAL', 'REJECTED', $2, 'v3.0.2', '{"apiVersion":"v3.0.2"}'::jsonb, 'DIS', 'INITIAL', date '2030-01-01', $3 from generate_series(1, 3) g`,
        [TENANT_A, dataset, memberId(STEWARD)],
      );
      await rows(
        `insert into machvon.data_contract_version (tenant_id, id, dataset_id, revision, grain, schema_json, owner_id, quality_rules, retention_policy_id, status, contract_id, odcs_sha256, compatibility, published_by, published_at)
         select $1, gen_random_uuid(), $2, g, 'g', '{"columns":[]}'::jsonb, $3, '{}'::jsonb, $4, 'PUBLISHED', null, null, null, null, now() from generate_series(1, 3) g`,
        [TENANT_A, dataset, memberId(OWNER), retentionPolicy],
      );
      const walk = async (path: string): Promise<string[]> => {
        const seen: string[] = [];
        let cursor = '';
        for (let page = 0; page < 5; page += 1) {
          const reply = await call('GET', `${path}?dataset_id=${dataset}&limit=1${cursor}`, { member: READER });
          seen.push(...(reply.json.items as Array<{ id: string }>).map((item) => item.id));
          if (reply.json.next_cursor === null) break;
          cursor = `&cursor=${reply.json.next_cursor as string}`;
        }
        return seen;
      };
      for (const path of ['/resources/dataset_contract', '/resources/data_contract_version']) {
        const seen = await walk(path);
        expect(seen).toHaveLength(3);
        expect(new Set(seen).size).toBe(3);
      }
    });

    it('page through versions that were published before the contracts had a time of publication: they are listed after the others, none is lost', async () => {
      const dataset = await seedDataset();
      await rows(
        `insert into machvon.data_contract_version (tenant_id, id, dataset_id, revision, grain, schema_json, owner_id, quality_rules, retention_policy_id, status, contract_id, odcs_sha256, compatibility, published_by, published_at)
         select $1, gen_random_uuid(), $2, g, 'g', '{"columns":[]}'::jsonb, $3, '{}'::jsonb, $4, 'PUBLISHED', null, null, null, null, case when g <= 2 then null else now() end from generate_series(1, 5) g`,
        [TENANT_A, dataset, memberId(OWNER), retentionPolicy],
      );
      const seen: string[] = [];
      let cursor = '';
      for (let page = 0; page < 8; page += 1) {
        const reply = await call('GET', `/resources/data_contract_version?dataset_id=${dataset}&limit=2${cursor}`, { member: READER });
        expect(reply.status).toBe(200);
        seen.push(...(reply.json.items as Array<{ id: string }>).map((item) => item.id));
        if (reply.json.next_cursor === null) break;
        cursor = `&cursor=${reply.json.next_cursor as string}`;
      }
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
    });

    it('numbers the first revision above the versions that were published before the contracts, so that it can be published', async () => {
      const dataset = await seedDataset();
      await rows(
        `insert into machvon.data_contract_version (tenant_id, id, dataset_id, revision, grain, schema_json, owner_id, quality_rules, retention_policy_id, status, published_at)
         values ($1, gen_random_uuid(), $2, 3, 'g', '{"columns":[]}'::jsonb, $3, '{}'::jsonb, $4, 'PUBLISHED', now())`,
        [TENANT_A, dataset, memberId(OWNER), retentionPolicy],
      );
      const made = await draft(STEWARD, dataset, odcs([property('note')]));
      expect([made.status, made.json.revision]).toEqual([200, 4]);
      const done = await publish(OWNER, made.json.resource_id, made.json.resource_version);
      expect([done.status, done.json.status, done.json.revision]).toEqual([200, 'PUBLISHED', 4]);
    });

    it('show a revision with its document, its columns and what changed from the published version', async () => {
      const dataset = await seedDataset();
      await published(dataset);
      const made = await draft(STEWARD, dataset, odcs([property('org_unit_code', { required: true, primaryKey: true }), AMOUNT('numeric(24,2)'), property('note')]));
      const shown = await contract(made.json.resource_id);
      expect(shown.status).toBe(200);
      expect(shown.json).toMatchObject({ compatibility: 'BREAKING', odcs_version: 'v3.0.2', status: 'IN_REVIEW', created_by: memberId(STEWARD) });
      expect(shown.json.odcs_json.apiVersion).toBe('v3.0.2');
      expect((shown.json.columns as Array<{ name: string }>).map((column) => column.name)).toEqual(['amount', 'note', 'org_unit_code']);
      expect((shown.json.changes as Array<{ kind: string; column: string }>).map((change) => `${change.kind}:${change.column}`).sort()).toEqual([
        'COLUMN_REMOVED:unit_code',
        'GRAIN_CHANGED:org_unit_code',
        'TYPE_CHANGED:amount',
      ]);
    });

    it('list the published versions of a dataset, newest first, and show one with its columns', async () => {
      const dataset = await seedDataset();
      const first = await published(dataset);
      const second = await draft(
        STEWARD,
        dataset,
        odcs([property('unit_code', { required: true, primaryKey: true }), AMOUNT('numeric(24,0)'), property('note'), property('remark')], [{ kind: 'MODULE', ref: 'HOME', owner: HOME_OWNER }]),
        '2030-06-01',
      );
      const done = await publish(OWNER, second.json.resource_id, 1);
      const list = await call('GET', `/resources/data_contract_version?dataset_id=${dataset}`, { member: READER });
      expect((list.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([done.json.data_contract_version_id, first.version]);
      const paged = await call('GET', `/resources/data_contract_version?dataset_id=${dataset}&limit=1`, { member: READER });
      expect(paged.json.items).toHaveLength(1);
      const next = await call('GET', `/resources/data_contract_version?dataset_id=${dataset}&limit=1&cursor=${paged.json.next_cursor}`, { member: READER });
      expect((next.json.items as Array<{ id: string }>)[0]?.id).toBe(first.version);
      const one = await call('GET', `/resources/data_contract_version/${first.version}`, { member: READER });
      expect(one.json).toMatchObject({ revision: 1, grain: 'one row per disbursement', contract_id: first.contract, serving: false, serving_until: null });
      expect((one.json.columns as unknown[]).length).toBe(3);
      expect((await call('GET', `/resources/data_contract_version/${randomUUID()}`, { member: READER })).status).toBe(404);
      expect((await call('GET', '/resources/data_contract_version?limit=0', { member: READER })).status).toBe(422);
      expect((await call('GET', '/resources/data_contract_version', { member: NOBODY })).status).toBe(403);
    });
  });

  describe('the database', () => {
    it('never changes what a revision says, deletes it, or moves it wrongly; and writes a published version once', async () => {
      const dataset = await seedDataset();
      const first = await published(dataset);
      const made = await draft(
        STEWARD,
        dataset,
        odcs([property('unit_code', { required: true, primaryKey: true }), AMOUNT('numeric(24,0)'), property('note'), property('extra')], [{ kind: 'MODULE', ref: 'HOME', owner: HOME_OWNER }]),
      );
      const id = made.json.resource_id as string;
      await expect(asApp(OWNER, "update machvon.dataset_contract set odcs_json = '{}'::jsonb where id = $1", [id])).rejects.toMatchObject({ code: '42501' });
      await expect(asApp(OWNER, "update machvon.dataset_contract set compatibility = 'BREAKING' where id = $1", [id])).rejects.toMatchObject({ code: '42501' });
      await expect(asApp(OWNER, 'delete from machvon.dataset_contract where id = $1', [id])).rejects.toMatchObject({ code: '42501' });
      await expect(asApp(OWNER, "update machvon.dataset_contract set status = 'SUPERSEDED' where id = $1", [id])).rejects.toMatchObject({ code: '42501' });
      await expect(asApp(OWNER, "update machvon.dataset_contract set status = 'PUBLISHED' where id = $1", [id])).rejects.toMatchObject({ code: '23514' });
      await expect(asApp(OWNER, 'update machvon.dataset_contract set status = $2 where id = $1', [first.contract, 'IN_REVIEW'])).rejects.toMatchObject({ code: '42501' });
      await expect(asApp(OWNER, "update machvon.data_contract_version set grain = 'x' where id = $1", [first.version])).rejects.toMatchObject({ code: '42501' });
      await expect(asApp(OWNER, 'delete from machvon.data_contract_version where id = $1', [first.version])).rejects.toMatchObject({ code: '42501' });
      await expect(asApp(OWNER, 'truncate machvon.data_contract_version')).rejects.toMatchObject({ code: '42501' });
    });

    it('does not hold a published version without its hash, or a breaking one without a window, or a revision with a document and no compatibility', async () => {
      const dataset = await seedDataset();
      const insert = (compatibility: string | null, window: string | null, sha: string | null) =>
        rows(
          `insert into machvon.data_contract_version (tenant_id, id, dataset_id, revision, grain, schema_json, owner_id, quality_rules, retention_policy_id, status, contract_id, odcs_sha256, compatibility, published_by, published_at, migration_window_until)
           values ($1, gen_random_uuid(), $2, $3, 'g', '{}'::jsonb, $4, '{}'::jsonb, $5, 'PUBLISHED', gen_random_uuid(), $6, $7, $4, now(), $8::date)`,
          [TENANT_A, dataset, ++sequence, memberId(OWNER), retentionPolicy, sha, compatibility, window],
        );
      await expect(insert('BREAKING', null, 'a'.repeat(64))).rejects.toMatchObject({ code: '23514' });
      await expect(insert('INITIAL', null, null)).rejects.toMatchObject({ code: '23514' });
      await expect(
        rows(
          `insert into machvon.dataset_contract (tenant_id, id, dataset_code, revision, owner_id, schema_json, quality_json, freshness_seconds, classification, status, dataset_id, odcs_version, odcs_json)
           values ($1, gen_random_uuid(), 'DS-X', 99, $2, '{}'::jsonb, '{}'::jsonb, 1, 'INTERNAL', 'IN_REVIEW', $3, 'v3.0.2', '{}'::jsonb)`,
          [TENANT_A, memberId(OWNER), dataset],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('writes a consumer decision once, by the owner of the consumer, and never deletes an approval', async () => {
      const dataset = await seedDataset();
      await published(dataset);
      const made = await draft(STEWARD, dataset, odcs([property('b')], [{ kind: 'MODULE', ref: 'HOME', owner: HOME_OWNER }]));
      const approval = (made.json.consumer_approvals as Array<{ id: string; consumer_ref: string }>).find((candidate) => candidate.consumer_ref === 'HOME') as { id: string };
      await expect(
        asApp(HOME_OWNER, "update machvon.contract_consumer_approval set decision = 'APPROVED', decided_by = $2, decided_at = now() where id = $1", [approval.id, memberId(STEWARD)]),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(asApp(HOME_OWNER, "update machvon.contract_consumer_approval set consumer_ref = 'OTHER' where id = $1", [approval.id])).rejects.toMatchObject({ code: '42501' });
      expect((await decide(HOME_OWNER, approval.id, 1)).status).toBe(200);
      await expect(asApp(HOME_OWNER, "update machvon.contract_consumer_approval set decision = 'REJECTED' where id = $1", [approval.id])).rejects.toMatchObject({ code: '42501' });
      await expect(asApp(HOME_OWNER, 'delete from machvon.contract_consumer_approval where id = $1', [approval.id])).rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('the dataset of BI built on a dataset (shared with the publication)', () => {
    it('is built after a publication that holds the dataset has ended, so that the publication has seen the consumers it had', async () => {
      const oldest = (await rows<{ id: string }>("select id from machvon.dataset where producer_module = 'DIS' and status <> 'RETIRED' order by created_at limit 1"))[0]?.id as string;
      let release!: () => void;
      let locked!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const isLocked = new Promise<void>((resolve) => (locked = resolve));
      const publishing = harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(OWNER), scopeVersion: 1 }, async (tx) => {
        await tx.query('select id from machvon.dataset where id = $1::uuid for update', [oldest]);
        locked();
        await held;
      });
      await isLocked;
      let done = false;
      const building = harness.tenants
        .withTenant({ tenantId: TENANT_A, membershipId: memberId(BI_OWNER), scopeVersion: 1 }, (tx) => new BiDatasetStore().ensureDisbursementDataset(tx, memberId(BI_OWNER)))
        .then((id) => {
          done = true;
          return id;
        });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(done).toBe(false);
      release();
      await publishing;
      const id = await building;
      expect((await rows<{ dgv_dataset_id: string }>('select dgv_dataset_id from machvon.bi_dataset where id = $1', [id]))[0]?.dgv_dataset_id).toBe(oldest);
    });
  });
});
