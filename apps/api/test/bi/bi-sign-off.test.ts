import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { BiPublicationStore, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { APPROVER, APPROVER_SCOPED, BiApp, DATASET, NOBODY, REQUESTER, ROOT, TENANT_A, memberId } from './bi-app';
import type { Reply } from './bi-app';

jest.setTimeout(180_000);

/**
 * The check step of a publication and the block of three signatures of a dashboard (BC.02, lane AUD3): the person who prepared the version, the person who checked the request, the person who approved it. The check
 * is optional (a tenant that never checks publishes with the two people it always had) and is never invented: the block says the step was not taken.
 */
const app = new BiApp();
const CHECKER = 30;
let sequence = 0;
const owner = <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => app.harness.owner<T>(TENANT_A, [[sql, params]]);
const sqlAs = (member: number, statement: string, params: unknown[] = []): Promise<unknown> => app.harness.tenants.withTenant(app.contextOf(member), (tx) => tx.query(statement, params));
const audits = (action: string, id: string) => owner<{ safe_diff: Record<string, unknown> }>('select safe_diff from machvon.audit_event where action = $1 and resource_id = $2 order by occurred_at', [action, id]);

const widget = (id: string, metric: string) => ({ id, kind: 'BAR', metric_version_id: metric, dimension_code: 'unit', grid: { x: 0, y: 0, w: 12, h: 4 } });
const certifiedMetric = async (): Promise<string> => {
  const id = randomUUID();
  sequence += 1;
  await owner(
    `insert into machvon.metric_definition (tenant_id, id, code, revision, grain, aggregation_type, expression_ast, unit, owner_id, status, origin, created_by, certified_by, certified_at, version)
     values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, 1, 'project', 'additive', '{"op":"sum","args":[{"op":"field","name":"GIAI_NGAN"}]}'::jsonb, 'VND', $3::uuid, 'CERTIFIED', 'TENANT_UI', $3::uuid, $4::uuid, now(), 1)`,
    [id, `t_so_${sequence}`, memberId(REQUESTER), memberId(NOBODY)],
  );
  return id;
};

async function dashboardWithVersion(metric: string): Promise<{ id: string; versionId: string }> {
  sequence += 1;
  const made = await app.call('POST', '/bi/dashboards', { member: REQUESTER, body: { code: `SO-${sequence}`, title: 'Dashboard giải ngân' } });
  const id = made.json.resource_id as string;
  const saved = await app.call('POST', `/bi/dashboards/${id}/versions`, {
    member: REQUESTER,
    ifMatch: `"${made.json.resource_version as number}"`,
    body: { layout_json: { widgets: [widget('w1', metric)] }, breakpoints: { sm: 640 }, metric_versions: [metric], filter_mappings: { period: 'bucket' }, dataset_version_policy: 'LATEST_FROZEN' },
  });
  expect(saved.status).toBe(200);
  return { id, versionId: saved.json.version_id as string };
}

async function frozenSnapshot(): Promise<void> {
  const periodId = randomUUID();
  const snapshot = randomUUID();
  const version = randomUUID();
  const code = `2032-${String((sequence += 1)).padStart(2, '0')}`;
  const client = new Client({ connectionString: app.harness.database.adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    await client.query(
      `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
       values ($1, $2, $3, 1, date '2032-01-01' + $6::int * 40, date '2032-01-01' + $6::int * 40 + 30, now(), 'DEFAULT', 'MONTH', 2032, 'OPEN', $4, $5, $5)`,
      [TENANT_A, periodId, code, randomUUID(), WORKER_MEMBERSHIP_ID, sequence],
    );
    await client.query(
      `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, payload_sha256, frozen_by, frozen_at, created_by, updated_by)
       values ($1, $2, $3, 'PERIOD_CLOSE', now(), date '2032-10-31', date '2032-10-31', 'FROZEN', 'DIS-METRICS-R1', 'SIGNED', 1, $4, $5::uuid, now(), $5::uuid, $5::uuid)`,
      [TENANT_A, snapshot, periodId, 'c'.repeat(64), WORKER_MEMBERSHIP_ID],
    );
    await client.query(
      `insert into machvon.bi_dataset_version (tenant_id, id, dataset_id, as_of_period, reporting_period_id, source_snapshot_id, built_at, row_count, checksum_sha256, status, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, now(), 1, repeat('a', 64), 'FROZEN', $7::uuid, $7::uuid)`,
      [TENANT_A, version, DATASET, code, periodId, snapshot, WORKER_MEMBERSHIP_ID],
    );
  } finally {
    await client.end();
  }
}

const submit = (objectId: string, member = REQUESTER): Promise<Reply> => app.call('POST', '/bi/publication-requests', { member, body: { object_kind: 'DASHBOARD', object_id: objectId } });
const check = (id: string, version: number, body: Record<string, unknown> = {}, member = CHECKER): Promise<Reply> => app.call('POST', `/bi/publication-requests/${id}/check`, { member, ifMatch: `"${version}"`, body });
const decide = (id: string, version: number, member = APPROVER): Promise<Reply> => app.call('POST', `/bi/publication-requests/${id}/decision`, { member, ifMatch: `"${version}"`, body: { decision: 'APPROVED' } });
const getDashboard = (id: string, member = REQUESTER): Promise<Reply> => app.call('GET', `/bi/dashboards/${id}`, { member });
const requestRow = async (id: string) =>
  (await owner<{ status: string; checked_by: string | null; check_comment: string | null; version: string }>('select status, checked_by, check_comment, version::text from machvon.bi_publication_request where id = $1', [id]))[0];

describe('the check step of a publication and the three signatures of a dashboard (BC.02)', () => {
  beforeAll(async () => {
    await app.start();
    await app.harness.seedMembership(TENANT_A, CHECKER, ROOT);
    await app.harness.seedRole(TENANT_A, 16, 'BI_CHECKER', ['bi.publish', 'bi.query', 'dashboard_version.read'], 45);
    await app.harness.seedGrants(TENANT_A, [{ n: 70, member: CHECKER, role: 16, kind: 'TENANT' }]);
    await frozenSnapshot();
  }, 300_000);
  afterAll(() => app.stop(), 60_000);

  it('records a check by a third person, leaves the request pending and audits it', async () => {
    const board = await dashboardWithVersion(await certifiedMetric());
    const request = (await submit(board.versionId)).json;
    const checked = await check(request.resource_id as string, 1, { comment: ' Đã đối chiếu số liệu ' });
    expect(checked).toMatchObject({ status: 200, json: { status: 'PENDING', resource_version: 2 } });
    expect(await requestRow(request.resource_id as string)).toMatchObject({ status: 'PENDING', checked_by: memberId(CHECKER), check_comment: 'Đã đối chiếu số liệu', version: '2' });
    const [audit] = await audits('bi.publication.check', request.resource_id as string);
    expect(audit?.safe_diff).toMatchObject({ object_kind: 'DASHBOARD', object_id: board.versionId });
  });

  it('refuses the one who asked, a second check, a stale version, a scoped holder, and a request that is decided', async () => {
    const board = await dashboardWithVersion(await certifiedMetric());
    const request = (await submit(board.versionId)).json.resource_id as string;
    expect(await check(request, 1, {}, REQUESTER)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
    expect(await check(request, 1, {}, APPROVER_SCOPED)).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
    expect(await check(request, 7)).toMatchObject({ status: 409 });
    expect((await check(request, 1)).status).toBe(200);
    expect(await check(request, 2, {}, APPROVER)).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
    expect(await check(randomUUID(), 1)).toMatchObject({ status: 404 });
    expect((await decide(request, 2)).status).toBe(200);
    expect(await check(request, 3, {}, NOBODY)).toMatchObject({ status: 403 });
    expect(await check(request, 3)).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
  });

  it('refuses the author of a metric as its checker, whoever asked for the publication', async () => {
    const id = randomUUID();
    sequence += 1;
    await owner(
      `insert into machvon.metric_definition (tenant_id, id, code, revision, grain, aggregation_type, expression_ast, unit, owner_id, status, origin, created_by, version)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, 1, 'project', 'additive', '{"op":"sum","args":[{"op":"field","name":"GIAI_NGAN"}]}'::jsonb, 'VND', $3::uuid, 'DRAFT', 'TENANT_UI', $3::uuid, 1)`,
      [id, `t_so_author_${sequence}`, memberId(CHECKER)],
    );
    // The request is written as the submit would have left it: the checks of the submit are not what is tested here.
    const request = randomUUID();
    await owner(
      `insert into machvon.bi_publication_request (tenant_id, id, object_kind, object_id, requested_by, checks_json, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, 'METRIC', $2::uuid, $3::uuid, '{}'::jsonb, $3::uuid, $3::uuid)`,
      [request, id, memberId(REQUESTER)],
    );
    expect(await check(request, 1, {}, CHECKER)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
    expect((await check(request, 1, {}, APPROVER)).status).toBe(200);
  });

  it('refuses the checker as the approver, and lets a third person approve', async () => {
    const board = await dashboardWithVersion(await certifiedMetric());
    const request = (await submit(board.versionId)).json.resource_id as string;
    expect((await check(request, 1)).status).toBe(200);
    expect(await decide(request, 2, CHECKER)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
    expect((await decide(request, 2)).status).toBe(200);
  });

  it('shows the dashboard with the three signatures once it is checked and approved', async () => {
    const board = await dashboardWithVersion(await certifiedMetric());
    const draft = (await getDashboard(board.id)).json;
    expect((draft.sign_off as Record<string, unknown>).state).toBe('PREPARED');
    expect((draft.sign_off as Record<string, unknown>).complete).toBe(false);
    const request = (await submit(board.versionId)).json.resource_id as string;
    await check(request, 1);
    const pending = (await getDashboard(board.id)).json.sign_off as Record<string, Record<string, unknown> | null>;
    expect(pending.checked_by).toMatchObject({ id: memberId(CHECKER) });
    expect(pending.approved_by).toBeNull();
    expect(pending.state).toBe('CHECKED');
    await decide(request, 2);
    const done = (await getDashboard(board.id)).json;
    const block = done.sign_off as Record<string, unknown>;
    expect(block).toMatchObject({ version_id: board.versionId, revision: 1, state: 'APPROVED', complete: true });
    expect(block.prepared_by).toMatchObject({ id: memberId(REQUESTER) });
    expect(block.checked_by).toMatchObject({ id: memberId(CHECKER) });
    expect(block.approved_by).toMatchObject({ id: memberId(APPROVER) });
    const [version] = done.versions as Array<Record<string, unknown>>;
    expect(version?.sign_off).toEqual(block);
  });

  it('shows a dashboard published without the check as approved but not complete, with nobody invented as the checker', async () => {
    const board = await dashboardWithVersion(await certifiedMetric());
    const request = (await submit(board.versionId)).json.resource_id as string;
    expect((await decide(request, 1)).status).toBe(200);
    const block = (await getDashboard(board.id)).json.sign_off as Record<string, unknown>;
    expect(block).toMatchObject({ state: 'APPROVED', complete: false, checked_by: null });
    expect(block.approved_by).toMatchObject({ id: memberId(APPROVER) });
  });

  it('keeps the check of a rejected request out of the signatures of a later publication', async () => {
    const board = await dashboardWithVersion(await certifiedMetric());
    const first = (await submit(board.versionId)).json.resource_id as string;
    await check(first, 1);
    const rejected = await app.call('POST', `/bi/publication-requests/${first}/decision`, { member: APPROVER, ifMatch: '"2"', body: { decision: 'REJECTED', comment: 'Sai bố cục' } });
    expect(rejected.status).toBe(200);
    const second = (await submit(board.versionId)).json.resource_id as string;
    expect((await decide(second, 1)).status).toBe(200);
    expect((await getDashboard(board.id)).json.sign_off).toMatchObject({ state: 'APPROVED', checked_by: null, complete: false });
  });

  it('is held by the database: the check cannot name the requester or the decider, is written once, and is not changed after the decision', async () => {
    const board = await dashboardWithVersion(await certifiedMetric());
    const request = (await submit(board.versionId)).json.resource_id as string;
    const write = (member: number, by: number) => sqlAs(member, 'update machvon.bi_publication_request set checked_by = $2::uuid, checked_at = now() where id = $1::uuid', [request, memberId(by)]);
    await expect(write(REQUESTER, REQUESTER)).rejects.toMatchObject({ code: '23514' });
    await expect(sqlAs(CHECKER, 'update machvon.bi_publication_request set checked_by = $2::uuid where id = $1::uuid', [request, memberId(CHECKER)])).rejects.toMatchObject({ code: '23514' });
    await expect(sqlAs(CHECKER, 'update machvon.bi_publication_request set check_comment = $2 where id = $1::uuid', [request, 'x'])).rejects.toMatchObject({ code: '23514' });
    await write(CHECKER, CHECKER);
    await expect(write(CHECKER, NOBODY)).rejects.toMatchObject({ code: '42501' });
    await expect(sqlAs(CHECKER, "update machvon.bi_publication_request set status = 'DECIDED', decision = 'APPROVED', decided_by = checked_by, decided_at = now() where id = $1::uuid", [request])).rejects.toMatchObject({ code: '23514' });
    await decide(request, 1, APPROVER);
    await expect(sqlAs(CHECKER, 'update machvon.bi_publication_request set check_comment = $2 where id = $1::uuid', [request, 'later'])).rejects.toMatchObject({ code: '42501' });
  });

  it('gives an export the signatures of the certification of its metric: the person it is made for prepared it, the checker of the request checked it, the certifier approved it', async () => {
    const metric = await certifiedMetric();
    const store = new BiPublicationStore();
    const preparer = { id: memberId(NOBODY), at: new Date('2026-11-05T01:00:00Z') };
    const read = () => app.harness.tenants.withTenant(app.contextOf(APPROVER), (tx) => store.signOffOfMetric(tx, metric, preparer));
    // A metric whose certification had no request has no checker; nobody is made up.
    expect(await read()).toMatchObject({ state: 'APPROVED', complete: false, checked: null, prepared: { id: memberId(NOBODY), at: '2026-11-05T01:00:00.000Z' }, approved: { id: memberId(NOBODY) } });
    await owner(
      `insert into machvon.bi_publication_request (tenant_id, id, object_kind, object_id, requested_by, checks_json, decision, decided_by, decided_at, status, checked_by, checked_at, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), 'METRIC', $1::uuid, $2::uuid, '{"checks":[]}'::jsonb, 'APPROVED', $3::uuid, now(), 'DECIDED', $4::uuid, now(), $2::uuid, $2::uuid)`,
      [metric, memberId(REQUESTER), memberId(APPROVER), memberId(CHECKER)],
    );
    expect(await read()).toMatchObject({ state: 'APPROVED', complete: true, checked: { id: memberId(CHECKER) } });
  });

  it('shows the request in the inbox with who checked it', async () => {
    const board = await dashboardWithVersion(await certifiedMetric());
    const request = (await submit(board.versionId)).json.resource_id as string;
    await check(request, 1, { comment: 'ok' });
    const listed = await app.call('GET', '/bi/publication-requests?status=PENDING', { member: APPROVER });
    const row = (listed.json.items as Array<Record<string, unknown>>).find((item) => item.id === request);
    expect(row).toMatchObject({ checked_by: { id: memberId(CHECKER) }, check_comment: 'ok' });
  });
});
