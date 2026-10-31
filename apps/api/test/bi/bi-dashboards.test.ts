import { randomUUID } from 'node:crypto';
import { BiApp, DASH_MAKER, DASH_OTHER, DASH_VIEWER, DATASET, NOBODY, TENANT_A, TENANT_B, contextFor, memberId } from './bi-app';
import type { Reply } from './bi-app';

jest.setTimeout(120_000);

const app = new BiApp();
let sequence = 0;

const create = (overrides: Record<string, unknown> = {}, member = DASH_MAKER, tenantId?: string): Promise<Reply> =>
  app.call('POST', '/bi/dashboards', { member, body: { code: `D-${(sequence += 1)}`, title: 'Dashboard giải ngân', ...overrides }, ...(tenantId === undefined ? {} : { tenantId }) });
const widget = (id: string, metric: string, overrides: Record<string, unknown> = {}) => ({ id, kind: 'BAR', metric_version_id: metric, dimension_code: 'unit', grid: { x: 0, y: 0, w: 6, h: 4 }, ...overrides });
const draftOf = (metrics: string[], overrides: Record<string, unknown> = {}) => ({
  layout_json: { widgets: metrics.map((metric, index) => widget(`w${index + 1}`, metric, { grid: { x: 0, y: index * 4, w: 12, h: 4 } })) },
  breakpoints: { sm: 640, md: 1024 },
  metric_versions: metrics,
  filter_mappings: { period: 'bucket' },
  dataset_version_policy: 'LATEST_FROZEN',
  ...overrides,
});
const save = (id: string, version: number, body: Record<string, unknown>, member = DASH_MAKER, tenantId?: string): Promise<Reply> =>
  app.call('POST', `/bi/dashboards/${id}/versions`, { member, ifMatch: `"${version}"`, body, ...(tenantId === undefined ? {} : { tenantId }) });
const show = (id: string, member = DASH_MAKER, tenantId?: string): Promise<Reply> => app.call('GET', `/bi/dashboards/${id}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });
const list = (query = '', member = DASH_MAKER): Promise<Reply> => app.call('GET', `/bi/dashboards${query}`, { member });
const owner = <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => app.harness.owner<T>(TENANT_A, [[sql, params]]);
const events = (id: string, type: string) => owner<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at', [id, type]);

/** A metric of the tenant in the state given, as the data owner writes it. */
async function metric(status: string): Promise<string> {
  const id = randomUUID();
  sequence += 1;
  await owner(
    `insert into machvon.metric_definition (tenant_id, id, code, revision, grain, aggregation_type, expression_ast, unit, owner_id, status, origin, created_by, certified_by, version)
     values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, 1, 'project', 'sum', '{"op":"sum","field":"amount_vnd"}'::jsonb, 'VND', $3::uuid, $4, 'TENANT_UI', $3::uuid, case when $4 = 'CERTIFIED' then $5::uuid end, 1)`,
    [id, `t_dash_${sequence}`, memberId(DASH_MAKER), status, memberId(NOBODY)],
  );
  return id;
}

/** A version of the dataset of the tenant in the state given. */
async function datasetVersion(status: string): Promise<string> {
  const id = randomUUID();
  sequence += 1;
  await owner(
    `insert into machvon.bi_dataset_version (tenant_id, id, dataset_id, as_of_period, built_at, row_count, checksum_sha256, status, created_by, updated_by)
     values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, now(), 0, repeat('a', 64), $4, $5::uuid, $5::uuid)`,
    [id, DATASET, `2026-${String(sequence).padStart(2, '0')}`, status, memberId(DASH_MAKER)],
  );
  return id;
}

const stored = async (id: string) => (await owner<{ version: string; current_version_id: string | null; status: string; audience: string }>('select version::text, current_version_id, status, audience from machvon.dashboard where id = $1', [id]))[0];

describe('dashboards and their versions (ST-BI-005, BI 3 F5)', () => {
  beforeAll(() => app.start(), 240_000);
  afterAll(() => app.stop(), 60_000);

  it('AC-ST-BI-005-1: UAT-AC474 refuses a version over a metric that is not certified, and saves it once the metric is, revision after revision', async () => {
    const made = await create({ code: 'D-3' });
    expect(made).toMatchObject({ status: 200, json: { status: 'DRAFT', resource_version: 1, code: 'D-3' } });
    const id = made.json.resource_id as string;
    expect(await stored(id)).toMatchObject({ status: 'DRAFT', audience: 'PRIVATE', current_version_id: null });
    expect((await events(id, 'bi.dashboard.created.v1'))[0]?.payload).toMatchObject({ code: 'D-3', owner_id: memberId(DASH_MAKER), tenant_id: TENANT_A });
    expect(await app.count("select count(*)::text as n from machvon.audit_event where resource_id = $1 and action = 'bi.dashboard.create'", [id])).toBe(1);

    const m7 = await metric('DRAFT');
    const m1 = await metric('CERTIFIED');
    const refused = await save(id, 1, draftOf([m1, m7]));
    expect(refused).toMatchObject({ status: 422, json: { code: 'METRIC_NOT_CERTIFIED', detail: 'metric_versions' } });
    expect(await app.count('select count(*)::text as n from machvon.dashboard_version where dashboard_id = $1', [id])).toBe(0);
    for (const state of ['IN_REVIEW', 'SUPERSEDED', 'RETIRED']) {
      await owner('update machvon.metric_definition set status = $2 where id = $1', [m7, state]);
      expect([state, (await save(id, 1, draftOf([m7]))).json.code]).toEqual([state, 'METRIC_NOT_CERTIFIED']);
    }
    await owner("update machvon.metric_definition set status = 'CERTIFIED', certified_by = $2::uuid where id = $1", [m7, memberId(NOBODY)]);
    const first = await save(id, 1, draftOf([m1, m7]));
    expect(first).toMatchObject({ status: 200, json: { status: 'DRAFT', resource_version: 2, revision: 1 } });
    const second = await save(id, 2, draftOf([m1], { breakpoints: { md: 900 } }));
    expect(second).toMatchObject({ status: 200, json: { resource_version: 3, revision: 2 } });
    expect(await stored(id)).toMatchObject({ version: '3', current_version_id: second.json.version_id });
    const rows = await owner<{ revision: number; status: string; metric_versions: string[]; created_by: string; layout_json: { columns: number; widgets: Array<Record<string, unknown>> } }>(
      'select revision, status, metric_versions, created_by, layout_json from machvon.dashboard_version where dashboard_id = $1 order by revision',
      [id],
    );
    expect(rows.map((row) => [row.revision, row.status, row.metric_versions.length, row.created_by])).toEqual([[1, 'DRAFT', 2, memberId(DASH_MAKER)], [2, 'DRAFT', 1, memberId(DASH_MAKER)]]);
    expect(rows[0]?.layout_json.columns).toBe(12);
    expect(rows[0]?.layout_json.widgets[0]).toEqual({ id: 'w1', kind: 'BAR', metric_version_id: m1, dimension_code: 'unit', grid: { x: 0, y: 0, w: 12, h: 4 } });
    expect((await events(id, 'bi.dashboard.version_saved.v1')).map((event) => event.payload.revision)).toEqual([1, 2]);
    expect(await app.count("select count(*)::text as n from machvon.audit_event where resource_id = $1 and action = 'bi.dashboard.save_version'", [id])).toBe(2);
  });

  it('refuses a draft that is not well made, a metric that is not in the tenant, and the versions of datasets that are not frozen', async () => {
    const id = (await create()).json.resource_id as string;
    const m1 = await metric('CERTIFIED');
    let version = 1;
    const refusal = async (body: Record<string, unknown>): Promise<[number, unknown, unknown]> => {
      const reply = await save(id, version, body);
      return [reply.status, reply.json.code, reply.json.detail];
    };
    expect(await refusal(draftOf([randomUUID()]))).toEqual([422, 'VALIDATION_FAILED', 'metric_versions']);
    expect(await refusal(draftOf([m1], { layout_json: { widgets: [widget('w1', m1, { kind: 'RADAR' })] } }))).toEqual([422, 'VALIDATION_FAILED', 'layout_json.widgets[0].kind']);
    expect(await refusal(draftOf([m1], { breakpoints: { sm: 100 } }))).toEqual([422, 'VALIDATION_FAILED', 'breakpoints.sm']);
    expect(await refusal(draftOf([m1], { dataset_version_policy: 'PINNED' }))).toEqual([422, 'VALIDATION_FAILED', 'pinned_dataset_version_ids']);
    expect(await refusal(draftOf([m1], { dataset_version_policy: 'LATEST_FROZEN', pinned_dataset_version_ids: [randomUUID()] }))).toEqual([422, 'VALIDATION_FAILED', 'pinned_dataset_version_ids']);
    expect(await refusal(draftOf([m1], { dataset_version_policy: 'PINNED', pinned_dataset_version_ids: [randomUUID()] }))).toEqual([422, 'VALIDATION_FAILED', 'pinned_dataset_version_ids']);
    const building = await datasetVersion('BUILDING');
    const superseded = await datasetVersion('SUPERSEDED');
    const frozen = await datasetVersion('FROZEN');
    const unfrozen = await save(id, version, draftOf([m1], { dataset_version_policy: 'PINNED', pinned_dataset_version_ids: [frozen, building, superseded] }));
    expect(unfrozen).toMatchObject({ status: 422, json: { code: 'DATASET_VERSION_NOT_FROZEN', detail: 'pinned_dataset_version_ids' } });
    const pinned = await save(id, version, draftOf([m1], { dataset_version_policy: 'PINNED', pinned_dataset_version_ids: [frozen.toUpperCase()] }));
    expect(pinned).toMatchObject({ status: 200, json: { revision: 1 } });
    version = 2;
    expect((await owner<{ dataset_version_policy: string; pinned_dataset_version_ids: string[] }>('select dataset_version_policy, pinned_dataset_version_ids from machvon.dashboard_version where id = $1', [pinned.json.version_id]))[0]).toEqual({ dataset_version_policy: 'PINNED', pinned_dataset_version_ids: [frozen] });
    // Nothing of the refusals was kept: one revision, one step of the dashboard.
    expect(await app.count('select count(*)::text as n from machvon.dashboard_version where dashboard_id = $1', [id])).toBe(1);
    expect(await app.count('select version::text as n from machvon.dashboard where id = $1', [id])).toBe(2);
    expect((await save(id, version, { ...draftOf([m1]), css: 'x' })).status).toBe(400);
    expect((await save(id, version, { layout_json: {} })).status).toBe(400);
  });

  it('judges who may make and save: the right, the owner, the tenant, the version, the state and the code', async () => {
    const id = (await create({ code: 'D-OWNER' })).json.resource_id as string;
    const m1 = await metric('CERTIFIED');
    expect((await create({ code: 'D-OWNER' })).json).toMatchObject({ code: 'DASHBOARD_CODE_DUPLICATE' });
    expect((await create({ code: 'D-OWNER' }, DASH_OTHER)).status).toBe(409);
    for (const bad of [{ code: '-x' }, { code: 'a b' }, { code: 'x'.repeat(81) }, { title: 'x' }, { title: 'x'.repeat(301) }, { code: 'a' }]) expect([JSON.stringify(bad), (await create(bad)).status]).toEqual([JSON.stringify(bad), 422]);
    expect((await create({}, DASH_VIEWER)).status).toBe(403);
    expect((await create({}, NOBODY)).status).toBe(403);
    expect((await create({}, DASH_MAKER, TENANT_B)).status).toBe(403);
    // The right to save is the right to make; the dashboard of another is not seen (404), and one in the library is seen and not theirs (403).
    expect((await save(id, 1, draftOf([m1]), DASH_VIEWER)).status).toBe(403);
    expect((await save(id, 1, draftOf([m1]), DASH_OTHER)).status).toBe(404);
    expect((await save(id, 1, draftOf([m1]), DASH_MAKER, TENANT_B)).status).toBe(403);
    expect((await save(randomUUID(), 1, draftOf([m1]))).status).toBe(404);
    expect(await save(id, 7, draftOf([m1]))).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    await owner("update machvon.dashboard set audience = 'TENANT_LIBRARY', status = 'PUBLISHED' where id = $1", [id]);
    expect((await save(id, 1, draftOf([m1]), DASH_OTHER)).status).toBe(403);
    expect((await save(id, 1, draftOf([m1]))).status).toBe(200);
    await owner("update machvon.dashboard set status = 'ARCHIVED', audience = 'PRIVATE' where id = $1", [id]);
    expect(await save(id, 2, draftOf([m1]))).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
  });

  it('shows the library of the caller: their own dashboards and those the tenant published, with the state of the version, and pages them', async () => {
    const mine = (await create({ code: 'L-MINE' })).json.resource_id as string;
    await create({ code: 'L-THEIRS' }, DASH_OTHER);
    const library = (await create({ code: 'L-LIBRARY' }, DASH_OTHER)).json.resource_id as string;
    await owner("update machvon.dashboard set audience = 'TENANT_LIBRARY', status = 'PUBLISHED' where id = $1", [library]);
    const m1 = await metric('CERTIFIED');
    expect((await save(mine, 1, draftOf([m1]))).status).toBe(200);
    const seen = (await list('?limit=200')).json.items as Array<Record<string, unknown>>;
    const codes = seen.map((item) => item.code);
    expect(codes).toContain('L-MINE');
    expect(codes).toContain('L-LIBRARY');
    expect(codes).not.toContain('L-THEIRS');
    expect(seen.find((item) => item.code === 'L-MINE')).toMatchObject({
      id: mine,
      owner: { id: memberId(DASH_MAKER) },
      audience: 'PRIVATE',
      status: 'DRAFT',
      mine: true,
      may_edit: true,
      current_version: { revision: 1, status: 'DRAFT', metric_count: 1, metrics_certified: true },
      version: 2,
    });
    expect(seen.find((item) => item.code === 'L-LIBRARY')).toMatchObject({ mine: false, may_edit: false, current_version: null, status: 'PUBLISHED' });
    // A metric that is no longer certified shows on the card.
    await owner("update machvon.metric_definition set status = 'SUPERSEDED' where id = $1", [m1]);
    expect(((await list('?limit=200')).json.items as Array<Record<string, unknown>>).find((item) => item.code === 'L-MINE')).toMatchObject({ current_version: { metrics_certified: false } });
    const published = (await list('?status=PUBLISHED&limit=200')).json.items as Array<Record<string, unknown>>;
    expect(published.every((item) => item.status === 'PUBLISHED')).toBe(true);
    expect(((await list('', DASH_OTHER)).json.items as Array<Record<string, unknown>>).map((item) => item.code)).toEqual(expect.arrayContaining(['L-THEIRS', 'L-LIBRARY']));
    expect(((await list('', DASH_OTHER)).json.items as Array<Record<string, unknown>>).map((item) => item.code)).not.toContain('L-MINE');
    // Pages follow the code, none repeated.
    const walked: string[] = [];
    let cursor = '';
    for (let pages = 0; pages < 30; pages += 1) {
      const page = (await list(`?limit=2${cursor}`)).json;
      walked.push(...(page.items as Array<{ id: string }>).map((item) => item.id));
      if (page.next_cursor === null) break;
      cursor = `&cursor=${page.next_cursor as string}`;
    }
    expect(walked).toEqual(seen.map((item) => item.id));
    expect(new Set(walked).size).toBe(walked.length);
    for (const bad of ['status=NOPE', 'limit=0', 'cursor=bad']) expect([bad, (await list(`?${bad}`)).status]).toEqual([bad, 422]);
    expect((await list('', NOBODY)).status).toBe(403);
    expect((await app.call('GET', '/bi/dashboards', { member: DASH_MAKER, tenantId: TENANT_B })).status).toBe(403);
  });

  it('shows one dashboard with its versions, newest first, and the versions through the scaffold read of the family', async () => {
    const id = (await create({ code: 'V-ONE' })).json.resource_id as string;
    const m1 = await metric('CERTIFIED');
    const first = await save(id, 1, draftOf([m1]));
    const second = await save(id, 2, draftOf([m1], { filter_mappings: { period: 'bucket', fund: 'fund_source' } }));
    const shown = await show(id);
    expect(shown).toMatchObject({ status: 200, json: { id, code: 'V-ONE', version: 3, current_version: { revision: 2 } } });
    const versions = shown.json.versions as Array<Record<string, unknown>>;
    expect(versions.map((version) => version.revision)).toEqual([2, 1]);
    expect(versions[0]).toMatchObject({ id: second.json.version_id, dashboard_id: id, status: 'DRAFT', dataset_version_policy: 'LATEST_FROZEN', pinned_dataset_version_ids: [], metric_versions: [m1], filter_mappings: { period: 'bucket', fund: 'fund_source' }, breakpoints: { sm: 640, md: 1024 }, created_by: memberId(DASH_MAKER), published_by: null, published_at: null });
    expect((versions[0]?.layout_json as { widgets: unknown[] }).widgets).toHaveLength(1);
    // Another member sees neither the dashboard nor its versions; a viewer of the library sees a published one.
    expect((await show(id, DASH_OTHER)).status).toBe(404);
    expect((await show(randomUUID())).status).toBe(404);
    expect((await show(id, DASH_MAKER, TENANT_B)).status).toBe(403);
    expect((await show(id, NOBODY)).status).toBe(403);
    expect((await app.call('GET', `/resources/dashboard_version/${first.json.version_id as string}`, { member: DASH_MAKER })).json).toMatchObject({ id: first.json.version_id, revision: 1 });
    expect((await app.call('GET', `/resources/dashboard_version/${first.json.version_id as string}`, { member: DASH_OTHER })).status).toBe(404);
    expect((await app.call('GET', `/resources/dashboard_version/${randomUUID()}`, { member: DASH_MAKER })).status).toBe(404);
    expect((await app.call('GET', `/resources/dashboard_version/${first.json.version_id as string}`, { member: NOBODY })).status).toBe(403);
    await owner("update machvon.dashboard set audience = 'TENANT_LIBRARY', status = 'PUBLISHED' where id = $1", [id]);
    expect((await show(id, DASH_VIEWER)).status).toBe(200);
    const all: string[] = [];
    let cursor = '';
    for (let pages = 0; pages < 40; pages += 1) {
      const page = (await app.call('GET', `/resources/dashboard_version?limit=1${cursor}`, { member: DASH_VIEWER })).json;
      all.push(...(page.items as Array<{ id: string }>).map((item) => item.id));
      if (page.next_cursor === null) break;
      cursor = `&cursor=${encodeURIComponent(page.next_cursor as string)}`;
    }
    expect(all).toEqual(expect.arrayContaining([first.json.version_id, second.json.version_id]));
    expect(new Set(all).size).toBe(all.length);
    expect((await app.call('GET', '/resources/dashboard_version?cursor=bad', { member: DASH_VIEWER })).status).toBe(422);
    expect((await app.call('GET', '/resources/dashboard_version', { member: NOBODY })).status).toBe(403);
  });

  it('keeps a saved version as it was written: the database refuses to change it, to take it out, to move it wrongly, or to point a dashboard at another one', async () => {
    const id = (await create({ code: 'GUARD' })).json.resource_id as string;
    const other = (await create({ code: 'GUARD-2' })).json.resource_id as string;
    const m1 = await metric('CERTIFIED');
    const saved = await save(id, 1, draftOf([m1]));
    const versionId = saved.json.version_id as string;
    const otherVersion = (await save(other, 1, draftOf([m1]))).json.version_id as string;
    // The application role (the data owner is exempt from the guards, as for the other governed tables).
    const sql = (statement: string, params: unknown[]): Promise<unknown> => app.harness.tenants.withTenant(contextFor(TENANT_A, memberId(DASH_MAKER)), (tx) => tx.query(statement, params));
    await expect(sql("update machvon.dashboard_version set layout_json = '{}'::jsonb where id = $1", [versionId])).rejects.toThrow(/never changes/);
    await expect(sql("update machvon.dashboard_version set metric_versions = '[]'::jsonb where id = $1", [versionId])).rejects.toThrow(/never changes/);
    await expect(sql("update machvon.dashboard_version set breakpoints = '{}'::jsonb where id = $1", [versionId])).rejects.toThrow(/never changes/);
    await expect(sql('update machvon.dashboard_version set revision = 9 where id = $1', [versionId])).rejects.toThrow(/never changes/);
    await expect(sql('delete from machvon.dashboard_version where id = $1', [versionId])).rejects.toThrow(/permission denied|never deleted/);
    await expect(sql("update machvon.dashboard_version set status = 'SUPERSEDED' where id = $1", [versionId])).rejects.toThrow(/cannot move from DRAFT to SUPERSEDED|published_chk/);
    await expect(sql("update machvon.dashboard_version set status = 'PUBLISHED' where id = $1", [versionId])).rejects.toThrow(/dashboard_version_published_chk/);
    await expect(sql("update machvon.dashboard_version set status = 'PUBLISHED', published_at = now() where id = $1", [versionId])).rejects.toThrow(/dashboard_version_published_chk/);
    await expect(sql("update machvon.dashboard_version set status = 'PUBLISHED', published_by = $2::uuid where id = $1", [versionId, memberId(NOBODY)])).rejects.toThrow(/dashboard_version_published_chk/);
    await expect(sql("update machvon.dashboard_version set status = 'PUBLISHED', published_by = created_by, published_at = now() where id = $1", [versionId])).rejects.toThrow(/dashboard_version_sod_chk/);
    await expect(sql("update machvon.dashboard_version set status = 'PUBLISHED', published_by = $2::uuid, published_at = now() where id = $1", [versionId, memberId(NOBODY)])).resolves.toBeDefined();
    await expect(sql("update machvon.dashboard_version set published_by = created_by where id = $1", [versionId])).rejects.toThrow(/written once|dashboard_version_sod_chk/);
    await expect(sql("update machvon.dashboard_version set status = 'DRAFT', published_by = null, published_at = null where id = $1", [versionId])).rejects.toThrow(/cannot move from PUBLISHED to DRAFT/);
    await expect(sql("update machvon.dashboard_version set status = 'SUPERSEDED' where id = $1", [versionId])).resolves.toBeDefined();
    await expect(sql('update machvon.dashboard set code = $2 where id = $1', [id, 'RENAMED'])).rejects.toThrow(/fixed when it is made/);
    await expect(sql('update machvon.dashboard set owner_user_id = $2::uuid where id = $1', [id, memberId(NOBODY)])).rejects.toThrow(/fixed when it is made/);
    await expect(sql('update machvon.dashboard set current_version_id = $2::uuid where id = $1', [id, otherVersion])).rejects.toThrow(/one of its own/);
    await expect(sql('delete from machvon.dashboard where id = $1', [id])).rejects.toThrow(/permission denied|never deleted/);
    await expect(sql('truncate machvon.dashboard_version', [])).rejects.toThrow(/permission denied/);
    // The shape of a version is a constraint too: the policy and the pinned versions agree, the revision is once, the dashboard is one of the tenant.
    const insert = (revision: number, policy: string, pinned: string | null, dashboard: string = id) =>
      owner(
        `insert into machvon.dashboard_version (tenant_id, id, dashboard_id, revision, layout_json, metric_versions, filter_mappings, breakpoints, dataset_version_policy, pinned_dataset_version_ids, status, created_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::int, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, $3, $4::jsonb, 'DRAFT', $5::uuid)`,
        [dashboard, revision, policy, pinned, memberId(DASH_MAKER)],
      );
    await expect(insert(1, 'LATEST_FROZEN', null)).rejects.toThrow(/dashboard_version_rev_uq|duplicate/);
    await expect(insert(2, 'PINNED', null)).rejects.toThrow(/dashboard_version_pinned_chk/);
    await expect(insert(2, 'PINNED', '[]')).rejects.toThrow(/dashboard_version_pinned_chk/);
    await expect(insert(2, 'LATEST_FROZEN', `["${randomUUID()}"]`)).rejects.toThrow(/dashboard_version_pinned_chk/);
    await expect(insert(0, 'LATEST_FROZEN', null)).rejects.toThrow(/dashboard_version_revision_chk/);
    await expect(insert(2, 'LATEST_FROZEN', null, randomUUID())).rejects.toThrow(/foreign key/);
    const privileges = await owner<{ dashboard: boolean; version: boolean }>("select has_table_privilege('machvon_app', 'machvon.dashboard', 'DELETE') as dashboard, has_table_privilege('machvon_app', 'machvon.dashboard_version', 'DELETE') as version");
    expect(privileges[0]).toEqual({ dashboard: false, version: false });
  });
});
