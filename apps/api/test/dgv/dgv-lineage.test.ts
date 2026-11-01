import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { DgvLineageStore, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { DgvLineageController } from '../../src/modules/dgv/dgv-lineage.controller';
import { dgvModule } from '../../src/modules/dgv';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(180_000);

const SIGNING_KEY = randomBytes(32);
const PIPELINE = 1; // data.lineage.write over the whole tenant
const LEAD = 2; // reads the lineage and the metrics over the whole tenant
const STC = 3; // reads over the unit U-STC (the projects of it)
const OTHER = 4; // reads over another unit
const NOBODY = 5; // no right over the lineage
const B_PIPELINE = 6; // of tenant B
const B_LEAD = 7; // of tenant B
const LINEAGE_ONLY = 8; // reads the lineage over the whole tenant and has no right over the projects
const ROOT = 1;
const U_STC = 2;
const U_OTHER = 3;

interface Reply {
  status: number;
  json: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

describe('the lineage graph with a check on each node (ST-DGV-006, DGV 3 F5, DGV-05)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  const metricId = randomUUID();
  const datasetVersionId = randomUUID();
  const datasetId = randomUUID();
  const batchId = randomUUID();
  const dashboardId = randomUUID();
  const dashboardVersionId = randomUUID();
  const projectId = randomUUID();
  const otherProjectId = randomUUID();
  const catalogueDatasetId = randomUUID();
  const openDatasetId = randomUUID();
  const loneDashboardId = randomUUID();
  const loneVersionId = randomUUID();
  const run = randomUUID();

  const call = async (method: 'GET' | 'POST', url: string, member: number, body?: unknown, tenantId = TENANT_A): Promise<Reply> => {
    const headers: Record<string, string> = { [TENANT_HEADER]: signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const rows = <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const batch = (member: number, edges: unknown[], overrides: Record<string, unknown> = {}, tenantId = TENANT_A): Promise<Reply> =>
    call('POST', '/dgv/lineage-batches', member, { run_id: run, transform_version: 'dis-snapshot-v1', edges, ...overrides }, tenantId);
  const graph = (member: number, kind: string, ref: string, extra = '', tenantId = TENANT_A): Promise<Reply> =>
    call('GET', `/dgv/lineage?node_kind=${kind}&ref_id=${ref}${extra}`, member, undefined, tenantId);
  const described = (node_kind: string, ref_module: string, display_name: string, ids: { ref_id?: string; ref_key?: string }, classification?: string) => ({
    node_kind,
    ref_module,
    display_name,
    ...ids,
    ...(classification === undefined ? {} : { classification }),
  });

  // The chain of the KPI cell: a source system, an import batch, a table, a record of a project of U-STC, the version of the dataset, the version of the metric and the version of the dashboard.
  const source = described('SOURCE_SYSTEM', 'MDM', 'Kho bạc nhà nước', { ref_key: 'KBNN' });
  const importBatch = described('IMPORT_BATCH', 'DIS', 'Lô nhập IB-7', { ref_id: batchId });
  const table = described('TABLE', 'DIS', 'period_snapshot_line', { ref_key: 'period_snapshot_line' });
  const record = described('RECORD', 'PRJ', 'Dự án U-STC', { ref_id: projectId });
  const version = described('DATASET_VERSION', 'BI', 'Bản dữ liệu giải ngân 2026-10', { ref_id: datasetVersionId });
  const metric = described('METRIC_VERSION', 'BI', 'Tỷ lệ giải ngân U-STC', { ref_id: metricId });
  const dashboard = described('DASHBOARD_VERSION', 'BI', 'Dashboard giải ngân bản 1', { ref_id: dashboardVersionId });
  const chain = [
    { from: source, to: importBatch },
    { from: importBatch, to: table },
    { from: table, to: record },
    { from: record, to: version },
    { from: version, to: metric },
    { from: metric, to: dashboard },
  ];

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: U_STC, path: `/${unitId(ROOT)}/${unitId(U_STC)}/`, parent: ROOT },
        { n: U_OTHER, path: `/${unitId(ROOT)}/${unitId(U_OTHER)}/`, parent: ROOT },
      ]);
    }
    for (const n of [PIPELINE, LEAD, STC, OTHER, NOBODY, LINEAGE_ONLY]) await harness.seedMembership(TENANT_A, n, ROOT);
    for (const n of [B_PIPELINE, B_LEAD]) await harness.seedMembership(TENANT_B, n, ROOT);
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedRole(tenant, 1, 'DATA_PIPELINE', ['data.lineage.write'], 50);
      await harness.seedRole(tenant, 3, 'LINEAGE_ONLY', ['data.lineage.read', 'metric_definition.read'], 30);
      await harness.seedRole(tenant, 2, 'LINEAGE_READER', ['data.lineage.read', 'metric_definition.read', 'project.read', 'data.catalog.read', 'bi.query'], 30);
    }
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: PIPELINE, role: 1, kind: 'TENANT' },
      { n: 2, member: LEAD, role: 2, kind: 'TENANT' },
      { n: 3, member: STC, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(U_STC)] },
      { n: 4, member: OTHER, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(U_OTHER)] },
      { n: 5, member: LINEAGE_ONLY, role: 3, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [
      { n: 1, member: B_PIPELINE, role: 1, kind: 'TENANT' },
      { n: 2, member: B_LEAD, role: 2, kind: 'TENANT' },
    ]);
    // The project of the record: the rows it points to (the master data of its area) are not what this test is about, so the foreign keys are out of the way for this one row.
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      await client.query(
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
       values ($1, $2, 'P-STC', 'P-STC', $3, $4, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, unitId(U_STC), randomUUID()],
      );
      await client.query(
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, 'P-OTHER', 'P-OTHER', $3, $4, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, otherProjectId, unitId(U_OTHER), randomUUID()],
      );
    } finally {
      await client.end();
    }
    await rows(`insert into machvon.dashboard (tenant_id, id, code, title, owner_user_id, audience, status, created_by, updated_by) values ($1, $2, 'D-KPI', 'KPI', $3, 'PRIVATE', 'DRAFT', $3, $3)`, [
      TENANT_A,
      dashboardId,
      memberId(LEAD),
    ]);
    await rows(
      `insert into machvon.dashboard_version (tenant_id, id, dashboard_id, revision, layout_json, metric_versions, filter_mappings, breakpoints, dataset_version_policy, status, created_by)
       values ($1, $2, $3, 1, '{"columns":12,"widgets":[]}'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, 'LATEST_FROZEN', 'DRAFT', $4)`,
      [TENANT_A, dashboardVersionId, dashboardId, memberId(LEAD)],
    );
    // The version of the dataset the chain passes through is one that is still BUILDING (the node is judged by the policy over its dataset, whatever state the version is in), and only the lead is opened it.
    await rows(
      `insert into machvon.bi_dataset (tenant_id, id, dataset_code, title, source_kind, grain, join_paths, owner_user_id, created_by, updated_by, status)
       values ($1, $2, 'DS-LINEAGE', 'Dataset', 'PERIOD_SNAPSHOT', 'project', '{"dimensions":["unit"]}'::jsonb, $3, $3, $3, 'ACTIVE')`,
      [TENANT_A, datasetId, memberId(LEAD)],
    );
    await rows(
      `insert into machvon.bi_dataset_version (tenant_id, id, dataset_id, as_of_period, built_at, row_count, checksum_sha256, status, created_by, updated_by)
       values ($1, $2, $3, '2026-10', now(), 0, repeat('a', 64), 'BUILDING', $4, $4)`,
      [TENANT_A, datasetVersionId, datasetId, memberId(LEAD)],
    );
    await rows(
      `insert into machvon.bi_access_policy (tenant_id, id, dataset_id, revision, grantee_kind, grantee_ref_id, row_predicate_ast, column_masks, status, approved_by, created_by, updated_by)
       values ($1, gen_random_uuid(), $2, 1, 'MEMBERSHIP', $3, '{"op":"unit_in_scope"}'::jsonb, '{}'::jsonb, 'ACTIVE', $4, $5, $4)`,
      [TENANT_A, datasetId, memberId(LEAD), memberId(PIPELINE), memberId(OTHER)],
    );
    // A dataset of the catalogue of DGV that only its owner and its steward may see.
    await rows(
      `insert into machvon.dataset (tenant_id, id, dataset_code, title, domain, grain, producer_module, owner_user_id, steward_user_id, classification, is_critical, freshness_slo_seconds, status, created_by, updated_by)
       values ($1, $2, 'DS-CATALOGUE', 'DS-CATALOGUE', 'TREASURY', 'one row', 'PAY', $3, $4, 'CONFIDENTIAL', false, 3600, 'DRAFT', $4, $4)`,
      [TENANT_A, catalogueDatasetId, memberId(LEAD), memberId(PIPELINE)],
    );
    await rows(
      `insert into machvon.dataset (tenant_id, id, dataset_code, title, domain, grain, producer_module, owner_user_id, steward_user_id, classification, is_critical, freshness_slo_seconds, status, created_by, updated_by)
       values ($1, $2, 'DS-OPEN', 'DS-OPEN', 'TREASURY', 'one row', 'PAY', $3, $3, 'INTERNAL', false, 3600, 'DRAFT', $3, $3)`,
      [TENANT_A, openDatasetId, memberId(PIPELINE)],
    );
    // A dashboard of the person who reads the lineage and has no right to read the dashboards.
    await rows(
      `insert into machvon.dashboard (tenant_id, id, code, title, owner_user_id, audience, status, created_by, updated_by) values ($1, $2, 'D-LONE', 'LONE', $3, 'PRIVATE', 'DRAFT', $3, $3)`,
      [TENANT_A, loneDashboardId, memberId(LINEAGE_ONLY)],
    );
    await rows(
      `insert into machvon.dashboard_version (tenant_id, id, dashboard_id, revision, layout_json, metric_versions, filter_mappings, breakpoints, dataset_version_policy, status, created_by)
       values ($1, $2, $3, 1, '{"columns":12,"widgets":[]}'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, 'LATEST_FROZEN', 'DRAFT', $4)`,
      [TENANT_A, loneVersionId, loneDashboardId, memberId(LINEAGE_ONLY)],
    );
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [DgvLineageController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered in the module of DGV', () => {
    expect(dgvModule.controllers).toEqual(expect.arrayContaining([DgvLineageController]));
  });

  it('AC-ST-DGV-006-2: UAT-AC489 records the edges of a batch once however often it is posted, and refuses a node of another tenant with 422 LINEAGE_NODE_INVALID', async () => {
    const first = await batch(PIPELINE, chain);
    expect(first).toMatchObject({ status: 200, json: { status: 'RECORDED', edges: 6, edges_created: 6, nodes_created: 7 } });
    const again = await batch(PIPELINE, chain);
    expect(again).toMatchObject({ status: 200, json: { edges: 6, edges_created: 0, nodes_created: 0 } });
    expect(await rows<{ n: string }>('select count(*)::text as n from machvon.lineage_edge')).toEqual([{ n: '6' }]);
    expect(await rows<{ n: string }>('select count(*)::text as n from machvon.lineage_node')).toEqual([{ n: '7' }]);
    // The same pair of nodes under another version of the transform is another edge, and a node described again (even a node that names a key only) is the node there is.
    expect(await batch(PIPELINE, [{ from: source, to: importBatch }], { transform_version: 'dis-snapshot-v2' })).toMatchObject({ status: 200, json: { edges_created: 1, nodes_created: 0 } });
    // A node of tenant B, named by its id, is not a node of tenant A.
    expect((await batch(B_PIPELINE, [{ from: source, to: importBatch }], {}, TENANT_B)).status).toBe(200);
    const foreign = (await rows<{ id: string }>("select id from machvon.lineage_node where ref_key = 'KBNN'", [], TENANT_B))[0]?.id as string;
    expect(await batch(PIPELINE, [{ from: { node_id: foreign }, to: described('TABLE', 'DIS', 'x', { ref_key: 'x' }) }])).toMatchObject({
      status: 422,
      json: { code: 'LINEAGE_NODE_INVALID', detail: 'edges[0].from' },
    });
    expect(await rows<{ n: string }>("select count(*)::text as n from machvon.lineage_node where ref_key = 'x'")).toEqual([{ n: '0' }]);
    // A node that does not exist is the same refusal, and so is a node of its own tenant by its id.
    expect(await batch(PIPELINE, [{ from: { node_id: randomUUID() }, to: source }])).toMatchObject({ status: 422, json: { code: 'LINEAGE_NODE_INVALID' } });
    const own = (await rows<{ id: string }>("select id from machvon.lineage_node where ref_key = 'KBNN'"))[0]?.id as string;
    expect(await batch(PIPELINE, [{ from: { node_id: own }, to: described('TABLE', 'DIS', 'bảng khác', { ref_key: 'other_table' }) }])).toMatchObject({
      status: 200,
      json: { edges_created: 1, nodes_created: 1 },
    });
    // The edges are the tenant's own: nothing was written for tenant B beyond its own batch.
    expect(await rows<{ n: string }>('select count(*)::text as n from machvon.lineage_edge', [], TENANT_B)).toEqual([{ n: '1' }]);
  });

  it.each([
    ['an edge with no nodes', [{}], 'edges[0].from'],
    ['an edge with a field of its own', [{ from: { node_id: randomUUID() }, to: { node_id: randomUUID() }, sql: 'x' }], 'edges[0].sql'],
    ['a node id that is not an id', [{ from: { node_id: 'nope' }, to: { node_id: randomUUID() } }], 'edges[0].from.node_id'],
    ['a node with a field of its own', [{ from: { node_id: randomUUID(), name: 'x' }, to: { node_id: randomUUID() } }], 'edges[0].from.node_id'],
    ['a kind that does not exist', [{ from: { node_kind: 'PLANET', ref_module: 'DIS', ref_key: 'a', display_name: 'a' }, to: { node_id: randomUUID() } }], 'edges[0].from.node_kind'],
    ['a module that is not a module', [{ from: { node_kind: 'TABLE', ref_module: 'dis', ref_key: 'a', display_name: 'a' }, to: { node_id: randomUUID() } }], 'edges[0].from.ref_module'],
    ['a node that names neither an id nor a key', [{ from: { node_kind: 'TABLE', ref_module: 'DIS', display_name: 'a' }, to: { node_id: randomUUID() } }], 'edges[0].from.ref_id'],
    ['an id that is not an id', [{ from: { node_kind: 'TABLE', ref_module: 'DIS', ref_id: 'nope', display_name: 'a' }, to: { node_id: randomUUID() } }], 'edges[0].from.ref_id'],
    ['a key that is empty', [{ from: { node_kind: 'TABLE', ref_module: 'DIS', ref_key: '', display_name: 'a' }, to: { node_id: randomUUID() } }], 'edges[0].from.ref_key'],
    ['a key that is only blanks', [{ from: { node_kind: 'TABLE', ref_module: 'DIS', ref_key: '   ', display_name: 'a' }, to: { node_id: randomUUID() } }], 'edges[0].from.ref_key'],
    ['a node with no name', [{ from: { node_kind: 'TABLE', ref_module: 'DIS', ref_key: 'a', display_name: '  ' }, to: { node_id: randomUUID() } }], 'edges[0].from.display_name'],
    [
      'a classification that does not exist',
      [{ from: { node_kind: 'TABLE', ref_module: 'DIS', ref_key: 'a', display_name: 'a', classification: 'SECRET' }, to: { node_id: randomUUID() } }],
      'edges[0].from.classification',
    ],
    ['a moment that is not one', [{ from: { node_id: randomUUID() }, to: { node_id: randomUUID() }, observed_at: 'yesterday' }], 'edges[0].observed_at'],
  ])('refuses %s as 422 LINEAGE_NODE_INVALID naming the field', async (_name, edges, detail) => {
    expect(await batch(PIPELINE, edges)).toMatchObject({ status: 422, json: { code: 'LINEAGE_NODE_INVALID', detail } });
  });

  it('refuses a batch that is not one: an edge to itself, no edges, too many, a run that is not an id, a transform with no name', async () => {
    const node = described('TABLE', 'DIS', 'bảng', { ref_key: 'self' });
    expect(await batch(PIPELINE, [{ from: node, to: node }])).toMatchObject({ status: 422, json: { code: 'LINEAGE_NODE_INVALID', detail: 'edges[0]' } });
    // An edge that is not even an object is refused before the batch is read (the contract names the edges as objects).
    expect(await batch(PIPELINE, ['x'])).toMatchObject({ status: 400 });
    expect(await batch(PIPELINE, [])).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'edges' } });
    expect(
      await batch(
        PIPELINE,
        Array.from({ length: 501 }, () => ({})),
      ),
    ).toMatchObject({ status: 422 });
    expect(await batch(PIPELINE, [{ from: node, to: source }], { run_id: 'nope' })).toMatchObject({ status: 422, json: { detail: 'run_id' } });
    expect(await batch(PIPELINE, [{ from: node, to: source }], { transform_version: '   ' })).toMatchObject({ status: 422, json: { detail: 'transform_version' } });
    expect(await batch(LEAD, [{ from: node, to: source }])).toMatchObject({ status: 403 });
    expect(await batch(NOBODY, [{ from: node, to: source }])).toMatchObject({ status: 403 });
  });

  it('AC-ST-DGV-006-1: UAT-AC52 tells everything of the chain to the person who may read it, run and transform on each edge, and shows the others restricted nodes with no name, id or kind', async () => {
    const full = await graph(LEAD, 'DASHBOARD_VERSION', dashboardVersionId, '&depth=6');
    expect(full.status).toBe(200);
    expect(full.json).toMatchObject({ start: expect.any(String), direction: 'upstream', depth: 6, truncated: false });
    const nodes = full.json.nodes as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(nodes.every((node) => node.restricted === false)).toBe(true);
    expect(nodes.map((node) => [node.level, node.node_kind])).toEqual([
      [0, 'DASHBOARD_VERSION'],
      [1, 'METRIC_VERSION'],
      [2, 'DATASET_VERSION'],
      [3, 'RECORD'],
      [4, 'TABLE'],
      [5, 'IMPORT_BATCH'],
      [6, 'SOURCE_SYSTEM'],
    ]);
    expect(nodes.find((node) => node.node_kind === 'METRIC_VERSION')).toMatchObject({ display_name: 'Tỷ lệ giải ngân U-STC', ref_id: metricId, classification: 'INTERNAL' });
    const edges = full.json.edges as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(edges).toHaveLength(7);
    expect(edges.filter((edge) => edge.transform_version === 'dis-snapshot-v1' && edge.run_id === run)).toHaveLength(6);

    // A person with no right over the record sees it, and what only the whole tenant sees, as restricted; the metric they read is told.
    const partial = await graph(OTHER, 'METRIC_VERSION', metricId, '&depth=6');
    expect(partial.status).toBe(200);
    const seen = partial.json.nodes as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const restricted = seen.filter((node) => node.restricted);
    expect(restricted.length).toBeGreaterThanOrEqual(2);
    for (const node of restricted) expect(Object.keys(node).sort()).toEqual(['key', 'level', 'restricted']);
    expect(restricted.every((node) => /^restricted-\d+$/.test(node.key as string))).toBe(true);
    expect(seen.find((node) => node.level === 0)).toMatchObject({ restricted: false, node_kind: 'METRIC_VERSION' });
    const text = JSON.stringify(partial.json);
    expect(text).not.toContain(projectId);
    expect(text).not.toContain('Dự án U-STC');
    expect(text).not.toContain(datasetVersionId);
    // An edge that touches a restricted node says nothing of its run or its transform.
    const shown = partial.json.edges as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const touching = shown.filter((edge) => /^restricted-/.test(edge.from as string) || /^restricted-/.test(edge.to as string));
    expect(touching.length).toBeGreaterThan(0);
    for (const edge of touching) expect(edge).toMatchObject({ run_id: null, transform_version: null, observed_at: null });
    // The person of the unit sees the record (of a project of their unit) as the others do not.
    const unit = await graph(STC, 'METRIC_VERSION', metricId, '&depth=6');
    expect((unit.json.nodes as Array<Record<string, any>>).find((node) => node.node_kind === 'RECORD')).toMatchObject({ restricted: false, display_name: 'Dự án U-STC' }); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((partial.json.nodes as Array<Record<string, any>>).find((node) => node.node_kind === 'RECORD')).toBeUndefined(); // eslint-disable-line @typescript-eslint/no-explicit-any
    // Downward from the metric reaches the dashboard version, which only its owner sees.
    const down = await graph(STC, 'METRIC_VERSION', metricId, '&direction=downstream');
    expect(down.json.nodes).toEqual([expect.objectContaining({ level: 0, restricted: false }), expect.objectContaining({ level: 1, restricted: true })]);
    expect((await graph(LEAD, 'METRIC_VERSION', metricId, '&direction=downstream')).json.nodes[1]).toMatchObject({ level: 1, restricted: false, node_kind: 'DASHBOARD_VERSION' });
  });

  it('takes the writes of the lineage of the tenant one batch after the other, so two batches that share nodes in another order cannot wait for each other', async () => {
    const nodes = Array.from({ length: 6 }, (_, index) => described('TABLE', 'DIS', `bảng ${index}`, { ref_key: `lock_${index}` }));
    const forward = nodes.slice(0, -1).map((from, index) => ({ from, to: nodes[index + 1] }));
    const backward = [...forward].reverse().map((edge) => ({ from: edge.to, to: edge.from }));
    const replies = await Promise.all(Array.from({ length: 6 }, (_, index) => batch(PIPELINE, index % 2 === 0 ? forward : backward, { transform_version: `lock-v${index}` })));
    expect(replies.map((reply) => reply.status)).toEqual([200, 200, 200, 200, 200, 200]);
    // And the batch waits for the lock of the tenant before it writes anything.
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('begin');
      await client.query("select pg_advisory_xact_lock(hashtextextended('lineage:' || $1, 0))", [TENANT_A]);
      const waiting = batch(PIPELINE, [{ from: nodes[0], to: nodes[2] }], { transform_version: 'lock-wait' });
      const outcome = await Promise.race([waiting, new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 800))]);
      expect(outcome).toBe('waiting');
      await client.query('commit');
      expect((await waiting).status).toBe(200);
    } finally {
      await client.end();
    }
  });

  it('reads the edges of a graph up to a cap, and says when it was cut: a node with very many edges, or a pair of nodes under very many versions of a transform', async () => {
    const store = new DgvLineageStore();
    const hub = described('METRIC_VERSION', 'BI', 'Chỉ tiêu trung tâm', { ref_id: randomUUID() });
    const spokes = Array.from({ length: 5 }, (_, index) => described('TABLE', 'DIS', `nguồn ${index}`, { ref_key: `spoke_${index}` }));
    expect(
      (
        await batch(
          PIPELINE,
          spokes.map((from) => ({ from, to: hub })),
          { transform_version: 'hub-v1' },
        )
      ).status,
    ).toBe(200);
    for (let version = 2; version <= 4; version += 1) expect((await batch(PIPELINE, [{ from: spokes[0], to: hub }], { transform_version: `hub-v${version}` })).status).toBe(200);
    const start = (await rows<{ id: string }>('select id from machvon.lineage_node where ref_id = $1', [hub.ref_id]))[0]?.id as string;
    const walk = (limits?: { nodes: number; edges: number }) =>
      harness.tenants.withTenant(contextFor(TENANT_A, memberId(LEAD)), async (tx) => store.traverse(tx, (await store.node(tx, start)) as never, 'upstream', 3, limits));
    const whole = await walk();
    expect(whole).toMatchObject({ truncated: false });
    expect(whole.edges).toHaveLength(8);
    expect(whole.nodes).toHaveLength(6);
    const cut = await walk({ nodes: 100, edges: 3 });
    expect(cut.truncated).toBe(true);
    expect(cut.edges).toHaveLength(3);
    expect(cut.nodes.length).toBeLessThanOrEqual(4);
    const exact = await walk({ nodes: 100, edges: 8 });
    expect(exact.truncated).toBe(false);
    const nodesCut = await walk({ nodes: 3, edges: 100 });
    expect(nodesCut.truncated).toBe(true);
    expect(nodesCut.nodes).toHaveLength(3);
  });

  it('hides a dataset version that cannot be resolved to a dataset of the tenant, even from the person who reads the whole lineage', async () => {
    const ghost = randomUUID();
    const orphan = described('DATASET_VERSION', 'BI', 'Bản dữ liệu không rõ', { ref_id: ghost });
    expect((await batch(PIPELINE, [{ from: orphan, to: metric }], { transform_version: 'ghost-v1' })).status).toBe(200);
    const lead = await graph(LEAD, 'METRIC_VERSION', metricId, '&depth=1');
    const nodes = lead.json.nodes as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(JSON.stringify(lead.json)).not.toContain('Bản dữ liệu không rõ');
    expect(JSON.stringify(lead.json)).not.toContain(ghost);
    // The version that does resolve (still BUILDING) is told to the person a policy opens the dataset to, and to nobody else.
    expect(nodes.find((node) => node.node_kind === 'DATASET_VERSION')).toMatchObject({ restricted: false, display_name: 'Bản dữ liệu giải ngân 2026-10' });
    const stc = await graph(STC, 'METRIC_VERSION', metricId, '&depth=1');
    expect(JSON.stringify(stc.json)).not.toContain('Bản dữ liệu giải ngân 2026-10');
  });

  it('tells a record only to the person who may read the project it is of, whatever the right over the lineage: the lineage never tells what the source would refuse', async () => {
    const lead = await graph(LEAD, 'METRIC_VERSION', metricId, '&depth=6');
    expect((lead.json.nodes as Array<Record<string, any>>).find((node) => node.node_kind === 'RECORD')).toMatchObject({ restricted: false, display_name: 'Dự án U-STC' }); // eslint-disable-line @typescript-eslint/no-explicit-any
    // The person who reads the lineage over the whole tenant and has no right over the projects is not told the record.
    const blind = await graph(LINEAGE_ONLY, 'METRIC_VERSION', metricId, '&depth=6');
    expect(blind.status).toBe(200);
    const nodes = blind.json.nodes as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(nodes.some((node) => node.restricted === true)).toBe(true);
    expect(nodes.find((node) => node.node_kind === 'RECORD')).toBeUndefined();
    expect(JSON.stringify(blind.json)).not.toContain('Dự án U-STC');
  });

  it('sees a dataset of the catalogue of DGV as the catalogue shows it: its owner sees it, the others read it as restricted', async () => {
    const dataset = described('DATASET', 'DGV', 'Bộ dữ liệu kho bạc', { ref_id: catalogueDatasetId });
    expect((await batch(PIPELINE, [{ from: dataset, to: metric }], { transform_version: 'catalogue-v1' })).status).toBe(200);
    const owner = await graph(LEAD, 'METRIC_VERSION', metricId, '&depth=1');
    expect((owner.json.nodes as Array<Record<string, any>>).some((node) => node.display_name === 'Bộ dữ liệu kho bạc' && node.restricted === false)).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
    const other = await graph(OTHER, 'METRIC_VERSION', metricId, '&depth=1');
    expect(JSON.stringify(other.json)).not.toContain('Bộ dữ liệu kho bạc');
  });

  it('tells a dashboard or a dataset of the catalogue only to whoever may read what the source endpoint gives: the lineage never tells what the source would refuse', async () => {
    const lone = described('DASHBOARD_VERSION', 'BI', 'Dashboard của người chỉ đọc lineage', { ref_id: loneVersionId });
    const open = described('DATASET', 'DGV', 'Bộ dữ liệu nội bộ', { ref_id: openDatasetId }, 'INTERNAL');
    expect(
      (
        await batch(
          PIPELINE,
          [
            { from: lone, to: metric },
            { from: open, to: metric },
          ],
          { transform_version: 'sources-v1' },
        )
      ).status,
    ).toBe(200);
    // The catalogue shows an internal dataset to every reader of the catalogue, and the dashboard is its owner's.
    const lead = JSON.stringify((await graph(LEAD, 'METRIC_VERSION', metricId, '&depth=1')).json);
    expect(lead).toContain('Bộ dữ liệu nội bộ');
    const blind = JSON.stringify((await graph(LINEAGE_ONLY, 'METRIC_VERSION', metricId, '&depth=1')).json);
    expect(blind).not.toContain('Bộ dữ liệu nội bộ');
    expect(blind).not.toContain('Dashboard của người chỉ đọc lineage');
  });

  it('is not asked of a node the person may not see, nor by one with no right over the lineage: as good as none', async () => {
    // The dashboard version is its owner's: another reader of the lineage cannot ask the graph of it.
    expect(await graph(STC, 'DASHBOARD_VERSION', dashboardVersionId)).toMatchObject({ status: 404 });
    expect(await graph(NOBODY, 'METRIC_VERSION', metricId)).toMatchObject({ status: 403 });
    expect(await graph(LEAD, 'METRIC_VERSION', randomUUID())).toMatchObject({ status: 404 });
    expect(await graph(PIPELINE, 'METRIC_VERSION', metricId)).toMatchObject({ status: 403 });
  });

  it('AC-ST-DGV-006-3: UAT-AC496 is 404 for tenant B asking for a node of tenant A, and tenant B sees only its own graph', async () => {
    expect(await graph(B_LEAD, 'METRIC_VERSION', metricId, '', TENANT_B)).toMatchObject({ status: 404 });
    expect(await graph(B_LEAD, 'DASHBOARD_VERSION', dashboardVersionId, '', TENANT_B)).toMatchObject({ status: 404 });
    // Its own nodes are its own: the source system of tenant B has an edge to a batch, and nothing of A.
    const own = await graph(B_LEAD, 'SOURCE_SYSTEM', randomUUID(), '', TENANT_B);
    expect(own.status).toBe(404);
  });

  it('judges what is asked: the kind, the id, the direction and the depth', async () => {
    expect(await graph(LEAD, 'PLANET', metricId)).toMatchObject({ status: 422, json: { detail: 'node_kind' } });
    expect(await graph(LEAD, 'METRIC_VERSION', 'nope')).toMatchObject({ status: 422, json: { detail: 'ref_id' } });
    expect(await graph(LEAD, 'METRIC_VERSION', metricId, '&direction=sideways')).toMatchObject({ status: 422, json: { detail: 'direction' } });
    expect(await graph(LEAD, 'METRIC_VERSION', metricId, '&depth=0')).toMatchObject({ status: 422, json: { detail: 'depth' } });
    expect(await graph(LEAD, 'METRIC_VERSION', metricId, '&depth=7')).toMatchObject({ status: 422, json: { detail: 'depth' } });
    expect(await graph(LEAD, 'METRIC_VERSION', metricId, '&depth=x')).toMatchObject({ status: 422, json: { detail: 'depth' } });
    // One step reaches the nodes next to the metric and no further (the chain goes on to the record, the table and the batch).
    const near = (await graph(LEAD, 'METRIC_VERSION', metricId, '&depth=1')).json.nodes as Array<{ level: number }>;
    expect(near.filter((item) => item.level === 0)).toHaveLength(1);
    expect(near.every((item) => item.level <= 1)).toBe(true);
    expect(near.length).toBeGreaterThanOrEqual(2);
    expect((await graph(LEAD, 'METRIC_VERSION', metricId)).json).toMatchObject({ depth: 3, direction: 'upstream' });
  });

  it('shows a node classified as personal or core data only to the person who holds the right over the whole tenant', async () => {
    const personal = otherProjectId;
    const posted = await batch(PIPELINE, [{ from: described('RECORD', 'PRJ', 'Hồ sơ cá nhân', { ref_id: personal }, 'PERSONAL'), to: metric }], { transform_version: 'pii-v1' });
    expect(posted.status).toBe(200);
    const lead = await graph(LEAD, 'METRIC_VERSION', metricId, '&depth=1');
    expect((lead.json.nodes as Array<Record<string, any>>).some((node) => node.display_name === 'Hồ sơ cá nhân' && node.classification === 'PERSONAL')).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
    const stc = await graph(STC, 'METRIC_VERSION', metricId, '&depth=1');
    expect(JSON.stringify(stc.json)).not.toContain('Hồ sơ cá nhân');
    expect((stc.json.nodes as Array<Record<string, any>>).filter((node) => node.restricted).length).toBeGreaterThan(0); // eslint-disable-line @typescript-eslint/no-explicit-any
  });

  it('keeps the graph as a record, in the database: no node and no edge is changed or deleted, and a node with no id or key is refused', async () => {
    const asApp = (statement: string, params: unknown[] = []) => harness.tenants.withTenant(contextFor(TENANT_A, memberId(PIPELINE)), (tx) => tx.query(statement, params));
    await expect(asApp("update machvon.lineage_node set display_name = 'x' where ref_key = 'KBNN'")).rejects.toThrow(/permission denied|is a record/);
    await expect(asApp("update machvon.lineage_edge set transform_version = 'x'")).rejects.toThrow(/permission denied|is a record/);
    await expect(asApp('delete from machvon.lineage_edge')).rejects.toThrow(/permission denied|is a record/);
    await expect(asApp('delete from machvon.lineage_node')).rejects.toThrow(/permission denied|is a record/);
    await expect(asApp('truncate machvon.lineage_edge')).rejects.toThrow(/permission denied/);
    await expect(
      rows(
        `insert into machvon.lineage_node (tenant_id, id, node_kind, ref_module, display_name) values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), 'TABLE', 'DIS', 'no ref')`,
      ),
    ).rejects.toThrow(/lineage_node_ref_chk/);
    const insert = () =>
      rows(
        `insert into machvon.lineage_node (tenant_id, id, node_kind, ref_module, ref_key, display_name) values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), 'TABLE', 'DIS', 'twin', 'twin')`,
      );
    await insert();
    await expect(insert()).rejects.toThrow(/lineage_node_identity_uq|duplicate/);
    const privileges = await rows<{ node: boolean; edge: boolean }>(
      "select has_table_privilege('machvon_app', 'machvon.lineage_node', 'UPDATE') as node, has_table_privilege('machvon_app', 'machvon.lineage_edge', 'DELETE') as edge",
    );
    expect(privileges[0]).toEqual({ node: false, edge: false });
  });
});
