import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { APPROVER, APPROVER_SCOPED, BiApp, DASH_OTHER, DATASET, NOBODY, REQUESTER, TENANT_A, UNIT_A, UNIT_B, memberId, roleId, unitId } from './bi-app';
import type { Reply } from './bi-app';

jest.setTimeout(180_000);

const app = new BiApp();
let sequence = 0;
const field = (name: string) => ({ op: 'field', name });
const sum = (name: string) => ({ op: 'sum', args: [field(name)] });
const owner = <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => app.harness.owner<T>(TENANT_A, [[sql, params]]);
const sqlAs = (member: number, statement: string, params: unknown[] = []): Promise<unknown> => app.harness.tenants.withTenant(app.contextOf(member), (tx) => tx.query(statement, params));
const events = (id: string, type: string) => owner<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at', [id, type]);
const audits = (action: string, id: string) => owner<{ safe_diff: Record<string, unknown> }>('select safe_diff from machvon.audit_event where action = $1 and resource_id = $2 order by occurred_at', [action, id]);

/** A frozen version of the dataset over a snapshot with lines in two units; the snapshot says how many rows it has (the real number unless a test says otherwise). */
async function frozen(options: { stored?: number; lines?: number } = {}): Promise<{ snapshot: string; version: string }> {
  sequence += 1;
  const periodId = randomUUID();
  const snapshot = randomUUID();
  const version = randomUUID();
  const code = `2031-${String(sequence).padStart(2, '0')}`;
  const lines = options.lines ?? 3;
  const statements: Array<[string, unknown[]]> = [
    [
      `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
       values ($1, $2, $3, 1, date '2031-01-01' + $6::int * 40, date '2031-01-01' + $6::int * 40 + 30, now(), 'DEFAULT', 'MONTH', 2031, 'OPEN', $4, $5, $5)`,
      [TENANT_A, periodId, code, randomUUID(), WORKER_MEMBERSHIP_ID, sequence],
    ],
    [
      `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, payload_sha256, frozen_by, frozen_at, created_by, updated_by)
       values ($1, $2, $3, 'PERIOD_CLOSE', now(), date '2031-10-31', date '2031-10-31', 'FROZEN', 'DIS-METRICS-R1', 'SIGNED', $4, $5, $6::uuid, now(), $6::uuid, $6::uuid)`,
      [TENANT_A, snapshot, periodId, options.stored ?? lines, 'c'.repeat(64), WORKER_MEMBERSHIP_ID],
    ],
    [
      `insert into machvon.bi_dataset_version (tenant_id, id, dataset_id, as_of_period, reporting_period_id, source_snapshot_id, built_at, row_count, checksum_sha256, status, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, now() + $7::int * interval '1 minute', $8, repeat('a', 64), 'FROZEN', $9::uuid, $9::uuid)`,
      [TENANT_A, version, DATASET, code, periodId, snapshot, sequence, lines, WORKER_MEMBERSHIP_ID],
    ],
  ];
  for (let index = 0; index < lines; index += 1) {
    statements.push([
      `insert into machvon.period_snapshot_line (tenant_id, id, snapshot_id, project_id, unit_id, fund_source_version_id, bucket, budget_level, plan_pm_assigned_vnd, plan_local_added_vnd, plan_total_vnd, disbursed_treasury_vnd, rate_null_reason, treasury_coverage)
       values ($1, gen_random_uuid(), $2, gen_random_uuid(), $3, null, 'CURRENT_YEAR', 'CENTRAL', 100, 0, 100, $4::numeric, 'NO_DATA', 'COMPLETE')`,
      [TENANT_A, snapshot, unitId(index % 2 === 0 ? UNIT_A : UNIT_B), 40 + index],
    ]);
  }
  await app.seedReplica(statements);
  return { snapshot, version };
}

const draftMetric = (overrides: Record<string, unknown> = {}, member = REQUESTER): Promise<Reply> => {
  sequence += 1;
  return app.call('POST', '/bi/metric-definitions', {
    member,
    body: {
      code: `t_pub_${sequence}`,
      grain: 'project',
      aggregation_type: 'ratio',
      expression_ast: { op: 'div', args: [sum('GIAI_NGAN'), sum('KE_HOACH_TTG')] },
      numerator_ast: sum('GIAI_NGAN'),
      denominator_ast: sum('KE_HOACH_TTG'),
      unit: 'percent',
      null_policy: 'NULL_NOT_ZERO',
      dimension_codes: ['unit'],
      dataset_id: DATASET,
      effective_from: '2026-01-01',
      ...overrides,
    },
  });
};
const metricRow = async (id: string) => (await owner<{ status: string; certified_by: string | null; effective_until: string | null; version: string }>('select status, certified_by, effective_until::text, version::text from machvon.metric_definition where id = $1', [id]))[0];

const submit = (kind: string, objectId: string, member = REQUESTER): Promise<Reply> => app.call('POST', '/bi/publication-requests', { member, body: { object_kind: kind, object_id: objectId } });
const decide = (id: string, version: number, body: Record<string, unknown>, member = APPROVER): Promise<Reply> =>
  app.call('POST', `/bi/publication-requests/${id}/decision`, { member, ifMatch: `"${version}"`, body });
const inbox = (query = '', member = APPROVER): Promise<Reply> => app.call('GET', `/bi/publication-requests${query}`, { member });
const requestRow = async (id: string) => (await owner<{ status: string; decision: string | null; decided_by: string | null; comment: string | null; version: string }>('select status, decision, decided_by, comment, version::text from machvon.bi_publication_request where id = $1', [id]))[0];

const widget = (id: string, metric: string) => ({ id, kind: 'BAR', metric_version_id: metric, dimension_code: 'unit', grid: { x: 0, y: 0, w: 12, h: 4 } });
const certifiedMetric = async (): Promise<string> => {
  const id = randomUUID();
  sequence += 1;
  await owner(
    `insert into machvon.metric_definition (tenant_id, id, code, revision, grain, aggregation_type, expression_ast, unit, owner_id, status, origin, created_by, certified_by, certified_at, version)
     values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, 1, 'project', 'additive', '{"op":"sum","args":[{"op":"field","name":"GIAI_NGAN"}]}'::jsonb, 'VND', $3::uuid, 'CERTIFIED', 'TENANT_UI', $3::uuid, $4::uuid, now(), 1)`,
    [id, `t_cert_${sequence}`, memberId(REQUESTER), memberId(NOBODY)],
  );
  return id;
};
const dashboardWithVersions = async (metrics: string[], versions = 1, code = `D-${(sequence += 1)}`): Promise<{ id: string; versionIds: string[] }> => {
  const made = await app.call('POST', '/bi/dashboards', { member: REQUESTER, body: { code, title: 'Dashboard giải ngân' } });
  const id = made.json.resource_id as string;
  let version = made.json.resource_version as number;
  const versionIds: string[] = [];
  for (let revision = 1; revision <= versions; revision += 1) {
    const saved = await app.call('POST', `/bi/dashboards/${id}/versions`, {
      member: REQUESTER,
      ifMatch: `"${version}"`,
      body: { layout_json: { widgets: metrics.map((metric, index) => widget(`w${index + 1}`, metric)) }, breakpoints: { sm: 640 }, metric_versions: metrics, filter_mappings: { period: 'bucket' }, dataset_version_policy: 'LATEST_FROZEN' },
    });
    expect(saved.status).toBe(200);
    version = saved.json.resource_version as number;
    versionIds.push(saved.json.version_id as string);
  }
  return { id, versionIds };
};
const dashboardRow = async (id: string) => (await owner<{ status: string; current_version_id: string | null; version: string }>('select status, current_version_id, version::text from machvon.dashboard where id = $1', [id]))[0];
const versionRow = async (id: string) => (await owner<{ status: string; published_by: string | null; layout_json: unknown }>('select status, published_by, layout_json from machvon.dashboard_version where id = $1', [id]))[0];

describe('certification and publication approval (ST-BI-006, BI 3 F5)', () => {
  beforeAll(() => app.start(), 300_000);
  afterAll(() => app.stop(), 60_000);

  it('AC-ST-BI-006-1: UAT-AC474 publishes the version of dashboard D-3 when someone other than who asked approves, after a refused self-approval, and keeps the earlier revision intact', async () => {
    await frozen();
    const metric = await certifiedMetric();
    const board = await dashboardWithVersions([metric], 2, 'D-3');
    const [first, second] = board.versionIds as [string, string];
    const layoutOfFirst = (await versionRow(first))?.layout_json;

    // Revision 1 is asked for and approved: it is the published one.
    const one = await submit('DASHBOARD', first);
    expect(one).toMatchObject({ status: 200, json: { status: 'PENDING', resource_version: 1 } });
    expect((await decide(one.json.resource_id as string, 1, { decision: 'APPROVED' })).status).toBe(200);
    expect(await versionRow(first)).toMatchObject({ status: 'PUBLISHED', published_by: memberId(APPROVER) });

    // Revision 2: the requester cannot approve it, and nothing moves; someone else can.
    const two = await submit('DASHBOARD', second);
    expect(two.status).toBe(200);
    const request = two.json.resource_id as string;
    expect(two.json.checks).toEqual([
      { code: 'METRICS_CERTIFIED', passed: true },
      { code: 'DATASET_VERSIONS_FROZEN', passed: true },
    ]);
    expect(await decide(request, 1, { decision: 'APPROVED' }, REQUESTER)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
    expect(await requestRow(request)).toMatchObject({ status: 'PENDING', decision: null });
    expect(await versionRow(second)).toMatchObject({ status: 'DRAFT', published_by: null });

    const approved = await decide(request, 1, { decision: 'APPROVED', comment: 'Đạt' });
    expect(approved).toMatchObject({ status: 200, json: { status: 'DECIDED', resource_version: 2 } });
    expect(await versionRow(second)).toMatchObject({ status: 'PUBLISHED', published_by: memberId(APPROVER) });
    // The earlier revision is still whole: superseded, with its layout and who published it unchanged.
    expect(await versionRow(first)).toMatchObject({ status: 'SUPERSEDED', published_by: memberId(APPROVER), layout_json: layoutOfFirst });
    expect(await dashboardRow(board.id)).toMatchObject({ status: 'PUBLISHED', current_version_id: second });
    expect(await requestRow(request)).toMatchObject({ status: 'DECIDED', decision: 'APPROVED', decided_by: memberId(APPROVER), comment: 'Đạt' });
    expect((await events(request, 'bi.publication.requested.v1'))[0]?.payload).toMatchObject({ object_kind: 'DASHBOARD', object_id: second, requested_by: memberId(REQUESTER) });
    expect((await events(request, 'bi.publication.decided.v1'))[0]?.payload).toMatchObject({ decision: 'APPROVED', actor_id: memberId(APPROVER) });
    expect((await events(board.id, 'bi.dashboard.published.v1')).map((event) => event.payload.revision)).toEqual([1, 2]);
    expect((await audits('bi.dashboard.publish', board.id)).map((row) => row.safe_diff.revision)).toEqual([1, 2]);
    expect((await audits('bi.publication.decide', request))[0]?.safe_diff).toMatchObject({ decision: 'APPROVED', object_kind: 'DASHBOARD' });
  });

  it('AC-ST-BI-006-2: UAT-AC471 refuses a metric whose rerun on the latest snapshot differs from what the snapshot stores, names the check that failed and makes no request', async () => {
    await frozen({ stored: 5, lines: 3 });
    const metric = (await draftMetric()).json.resource_id as string;
    const refused = await submit('METRIC', metric);
    expect(refused).toMatchObject({ status: 422, json: { code: 'REPRODUCIBILITY_CHECK_FAILED', detail: 'ROWS_MATCH_SNAPSHOT' } });
    expect(refused.json.checks).toEqual([
      { code: 'FORMULA_COMPUTABLE', passed: true },
      { code: 'FROZEN_VERSION_EXISTS', passed: true },
      { code: 'ROWS_MATCH_SNAPSHOT', passed: false },
      { code: 'GROUPS_ADD_UP', passed: true },
    ]);
    expect(await app.count('select count(*)::text as n from machvon.bi_publication_request where object_id = $1', [metric])).toBe(0);
    expect((await metricRow(metric))?.status).toBe('DRAFT');

    // A newer frozen version that is whole is the one the metric is rerun on.
    await frozen();
    const asked = await submit('METRIC', metric);
    expect(asked).toMatchObject({ status: 200, json: { status: 'PENDING' } });
    expect((asked.json.checks as Array<{ passed: boolean }>).every((check) => check.passed)).toBe(true);
  });

  it('certifies a metric on the decision of someone other than its author, supersedes the revision that was certified and keeps the definition fixed', async () => {
    await frozen();
    const code = `t_rev_${(sequence += 1)}`;
    const first = (await draftMetric({ code })).json.resource_id as string;
    const one = await submit('METRIC', first);
    expect((await decide(one.json.resource_id as string, 1, { decision: 'APPROVED' })).status).toBe(200);
    expect(await metricRow(first)).toMatchObject({ status: 'CERTIFIED', certified_by: memberId(APPROVER) });
    const second = (await draftMetric({ code, effective_from: '2026-07-01' })).json.resource_id as string;
    const two = await submit('METRIC', second);
    expect((await decide(two.json.resource_id as string, 1, { decision: 'APPROVED' })).status).toBe(200);
    expect(await metricRow(second)).toMatchObject({ status: 'CERTIFIED', certified_by: memberId(APPROVER) });
    expect(await metricRow(first)).toMatchObject({ status: 'SUPERSEDED', effective_until: '2026-07-01' });
    expect((await audits('bi.metric.certify', second))[0]?.safe_diff).toMatchObject({ code, revision: 2 });
    // A certified revision is not asked for again.
    expect(await submit('METRIC', second)).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
    // The definition of a certified revision is fixed, in the database too.
    await expect(sqlAs(REQUESTER, "update machvon.metric_definition set expression_ast = '{}'::jsonb where id = $1", [second])).rejects.toThrow(/keeps its definition|never changes/);
    await expect(sqlAs(REQUESTER, "update machvon.metric_definition set status = 'DRAFT' where id = $1", [second])).rejects.toThrow(/cannot move from CERTIFIED to DRAFT/);
    await expect(sqlAs(REQUESTER, 'update machvon.metric_definition set certified_by = null where id = $1', [second])).rejects.toThrow(/written once|metric_definition_certified_chk/);
    await expect(sqlAs(REQUESTER, 'delete from machvon.metric_definition where id = $1', [second])).rejects.toThrow(/permission denied|never deleted/);
  });

  it('refuses a metric that cannot be rerun: a formula over a field the dataset does not have, a dataset with no frozen version', async () => {
    await app.seedReplica([['delete from machvon.bi_dataset_version', []]]);
    const metric = (await draftMetric()).json.resource_id as string;
    expect(await submit('METRIC', metric)).toMatchObject({ status: 422, json: { code: 'REPRODUCIBILITY_CHECK_FAILED', detail: 'FROZEN_VERSION_EXISTS' } });
    await frozen();
    const unknown = (await draftMetric({ numerator_ast: sum('NOT_A_FIELD'), expression_ast: { op: 'div', args: [sum('NOT_A_FIELD'), sum('KE_HOACH_TTG')] } })).json.resource_id as string;
    const refused = await submit('METRIC', unknown);
    expect(refused).toMatchObject({ status: 422, json: { code: 'REPRODUCIBILITY_CHECK_FAILED', detail: 'FORMULA_COMPUTABLE' } });
    expect((refused.json.checks as Array<{ passed: boolean }>).every((check) => !check.passed)).toBe(true);
  });

  it('runs the checks again at the decision: a metric whose snapshot changed after it was asked for is not certified, and the request stays pending', async () => {
    const { snapshot } = await frozen();
    const metric = (await draftMetric()).json.resource_id as string;
    const request = (await submit('METRIC', metric)).json.resource_id as string;
    await app.seedReplica([['update machvon.period_snapshot set row_count = row_count + 1 where id = $1', [snapshot]]]);
    expect(await decide(request, 1, { decision: 'APPROVED' })).toMatchObject({ status: 422, json: { code: 'REPRODUCIBILITY_CHECK_FAILED', detail: 'ROWS_MATCH_SNAPSHOT' } });
    expect(await requestRow(request)).toMatchObject({ status: 'PENDING', decision: null });
    expect((await metricRow(metric))?.status).toBe('DRAFT');
    // Rejecting needs no rerun: the reason is the decision.
    expect(await decide(request, 1, { decision: 'REJECTED', comment: 'Số liệu chưa khớp' })).toMatchObject({ status: 200, json: { status: 'DECIDED' } });
  });

  it('asks the reason of a rejection, leaves the object as it was, and allows a new request for it', async () => {
    await frozen();
    const metric = (await draftMetric()).json.resource_id as string;
    const request = (await submit('METRIC', metric)).json.resource_id as string;
    expect(await submit('METRIC', metric)).toMatchObject({ status: 409, json: { code: 'PUBLICATION_ALREADY_PENDING' } });
    expect(await decide(request, 1, { decision: 'REJECTED' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'comment' } });
    expect(await decide(request, 1, { decision: 'REJECTED', comment: '   ' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    expect(await decide(request, 7, { decision: 'REJECTED', comment: 'Sai mẫu số' })).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    expect(await decide(request, 1, { decision: 'REJECTED', comment: 'Sai mẫu số' })).toMatchObject({ status: 200, json: { status: 'DECIDED', resource_version: 2 } });
    expect(await requestRow(request)).toMatchObject({ status: 'DECIDED', decision: 'REJECTED', comment: 'Sai mẫu số', decided_by: memberId(APPROVER) });
    expect((await metricRow(metric))?.status).toBe('DRAFT');
    // Decided once.
    expect(await decide(request, 2, { decision: 'APPROVED' })).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
    expect((await audits('bi.publication.decide', request))[0]?.safe_diff).toMatchObject({ decision: 'REJECTED', reason: 'Sai mẫu số' });
    // Asked again, it can be approved.
    const again = await submit('METRIC', metric);
    expect(again.status).toBe(200);
    expect(await decide(again.json.resource_id as string, 1, { decision: 'APPROVED' })).toMatchObject({ status: 200 });
    expect((await metricRow(metric))?.status).toBe('CERTIFIED');
  });

  it('refuses the version of a dashboard over a metric that is not certified, one that is not a draft and a dashboard that is not the asker\'s', async () => {
    await frozen();
    const certified = await certifiedMetric();
    const board = await dashboardWithVersions([certified], 1);
    const [version] = board.versionIds as [string];
    // The metric is withdrawn after the version was saved: the version is not published over it.
    await owner("update machvon.metric_definition set status = 'RETIRED' where id = $1", [certified]);
    expect(await submit('DASHBOARD', version)).toMatchObject({ status: 422, json: { code: 'METRIC_NOT_CERTIFIED', detail: 'metric_versions' } });
    await owner("update machvon.metric_definition set status = 'CERTIFIED' where id = $1", [certified]);
    // Someone else's dashboard is not found; a version that is published is not asked for again.
    expect(await app.call('POST', '/bi/publication-requests', { member: APPROVER_SCOPED, body: { object_kind: 'DASHBOARD', object_id: version } })).toMatchObject({ status: 403 });
    const other = await app.call('POST', '/bi/dashboards', { member: DASH_OTHER, body: { code: `D-O-${(sequence += 1)}`, title: 'Của người khác' } });
    expect(other.status).toBe(200);
    expect(await submit('DASHBOARD', randomUUID())).toMatchObject({ status: 404 });
    const asked = await submit('DASHBOARD', version);
    expect(asked.status).toBe(200);
    expect((await decide(asked.json.resource_id as string, 1, { decision: 'APPROVED' })).status).toBe(200);
    expect(await submit('DASHBOARD', version)).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
    // The metric is withdrawn after the request: the decision checks again.
    const board2 = await dashboardWithVersions([certified], 1);
    const request = (await submit('DASHBOARD', board2.versionIds[0] as string)).json.resource_id as string;
    await owner("update machvon.metric_definition set status = 'RETIRED' where id = $1", [certified]);
    expect(await decide(request, 1, { decision: 'APPROVED' })).toMatchObject({ status: 422, json: { code: 'METRIC_NOT_CERTIFIED' } });
    expect(await requestRow(request)).toMatchObject({ status: 'PENDING' });
  });

  it('makes a draft policy ACTIVE on the decision of someone other than its author, and not on its own approval', async () => {
    const draft = await app.call('POST', '/bi/access-policies', { member: REQUESTER, body: { dataset_id: DATASET, grantee_kind: 'ROLE', grantee_ref_id: roleId(6), row_predicate_ast: { op: 'unit_in_scope' }, column_masks: {} } });
    expect(draft.status).toBe(200);
    const policy = draft.json.resource_id as string;
    const asked = await submit('ACCESS_POLICY', policy);
    expect(asked).toMatchObject({ status: 200, json: { checks: [{ code: 'POLICY_IS_DRAFT', passed: true }, { code: 'DATASET_ACTIVE', passed: true }] } });
    const request = asked.json.resource_id as string;
    expect(await decide(request, 1, { decision: 'APPROVED' }, REQUESTER)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
    expect(await decide(request, 1, { decision: 'APPROVED' })).toMatchObject({ status: 200 });
    expect((await owner<{ status: string; approved_by: string }>('select status, approved_by from machvon.bi_access_policy where id = $1', [policy]))[0]).toEqual({ status: 'ACTIVE', approved_by: memberId(APPROVER) });
    expect((await events(policy, 'bi.policy.activated.v1'))[0]?.payload).toMatchObject({ policy_id: policy, actor_id: memberId(APPROVER) });
    expect(await submit('ACCESS_POLICY', policy)).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
  });

  it('is the approver\'s over the whole tenant: a holder of the right on one unit, and a member with no right, are refused', async () => {
    await frozen();
    const metric = (await draftMetric()).json.resource_id as string;
    expect(await submit('METRIC', metric, NOBODY)).toMatchObject({ status: 403 });
    expect(await submit('METRIC', metric, APPROVER_SCOPED)).toMatchObject({ status: 403 });
    const request = (await submit('METRIC', metric)).json.resource_id as string;
    expect(await decide(request, 1, { decision: 'APPROVED' }, APPROVER_SCOPED)).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
    expect(await decide(request, 1, { decision: 'APPROVED' }, NOBODY)).toMatchObject({ status: 403 });
    expect(await inbox('', APPROVER_SCOPED)).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
    expect(await decide(randomUUID(), 1, { decision: 'APPROVED' })).toMatchObject({ status: 404 });
    expect(await app.call('POST', '/bi/publication-requests', { member: REQUESTER, body: { object_kind: 'METRIC', object_id: 'not-a-uuid' } })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'object_id' } });
    expect(await app.call('POST', '/bi/publication-requests', { member: REQUESTER, body: { object_kind: 'METRIC', object_id: metric, unknown: 1 } })).toMatchObject({ status: 400 });
    expect(await app.call('POST', '/bi/publication-requests', { member: REQUESTER, body: { object_kind: 'REPORT', object_id: metric } })).toMatchObject({ status: 422 });
  });

  it('approves the layout of a dashboard under the baseline operation: by someone other than who saved it, deciding the pending request in the same act', async () => {
    await frozen();
    const certified = await certifiedMetric();
    const board = await dashboardWithVersions([certified], 1);
    const [version] = board.versionIds as [string];
    const publish = (member: number, decision: string, ifMatch: number) =>
      app.call('POST', `/dashboards/${board.id}/publish`, { member, ifMatch: `"${ifMatch}"`, body: { decision, reason: 'Layout đúng phạm vi', evidence_ids: [randomUUID()] } });
    const current = async () => Number((await dashboardRow(board.id))?.version);
    expect(await publish(REQUESTER, 'approve', await current())).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
    expect(await publish(APPROVER, 'approve', 99)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    expect(await publish(APPROVER, 'reject', await current())).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
    const request = (await submit('DASHBOARD', version)).json.resource_id as string;
    expect(await publish(REQUESTER, 'approve', await current())).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
    expect(await publish(APPROVER_SCOPED, 'approve', await current())).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
    const returned = await publish(APPROVER, 'return', await current());
    expect(returned.status).toBe(200);
    expect(await requestRow(request)).toMatchObject({ status: 'DECIDED', decision: 'REJECTED', comment: 'Layout đúng phạm vi' });
    expect((await versionRow(version))?.status).toBe('DRAFT');
    const second = (await submit('DASHBOARD', version)).json.resource_id as string;
    const published = await publish(APPROVER, 'approve', await current());
    expect(published).toMatchObject({ status: 200, json: { status: 'PUBLISHED' } });
    expect(await requestRow(second)).toMatchObject({ status: 'DECIDED', decision: 'APPROVED', decided_by: memberId(APPROVER) });
    expect(await versionRow(version)).toMatchObject({ status: 'PUBLISHED', published_by: memberId(APPROVER) });
    expect(await publish(APPROVER, 'approve', await current())).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });

    // With no request, the approval stands on the checks alone.
    const direct = await dashboardWithVersions([certified], 1);
    const approved = await app.call('POST', `/dashboards/${direct.id}/publish`, { member: APPROVER, ifMatch: `"${Number((await dashboardRow(direct.id))?.version)}"`, body: { decision: 'approve', reason: 'Đạt', evidence_ids: [] } });
    expect(approved.status).toBe(200);
    expect(await versionRow(direct.versionIds[0] as string)).toMatchObject({ status: 'PUBLISHED', published_by: memberId(APPROVER) });
    // A dashboard with no saved version has nothing to publish.
    const empty = await app.call('POST', '/bi/dashboards', { member: REQUESTER, body: { code: `D-E-${(sequence += 1)}`, title: 'Chưa có phiên bản' } });
    expect(await app.call('POST', `/dashboards/${empty.json.resource_id}/publish`, { member: APPROVER, ifMatch: '"1"', body: { decision: 'approve', reason: 'x', evidence_ids: [] } })).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
    expect(await app.call('POST', `/dashboards/${randomUUID()}/publish`, { member: APPROVER, ifMatch: '"1"', body: { decision: 'approve', reason: 'x', evidence_ids: [] } })).toMatchObject({ status: 404 });
  });

  it('lists the requests for the approver, the newest first, with what they are about, who asked and the checks, a page at a time', async () => {
    await frozen();
    await app.seedReplica([['delete from machvon.bi_publication_request', []]]);
    const kinds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const metric = (await draftMetric()).json.resource_id as string;
      expect((await submit('METRIC', metric)).status).toBe(200);
      kinds.push(metric);
    }
    const certified = await certifiedMetric();
    const board = await dashboardWithVersions([certified], 1);
    const dash = await submit('DASHBOARD', board.versionIds[0] as string);
    const all = await inbox('?status=PENDING');
    expect(all.status).toBe(200);
    const items = all.json.items as Array<Record<string, unknown>>;
    expect(items.map((item) => item.object_id)).toEqual([board.versionIds[0], ...kinds.slice().reverse()]);
    expect(items[0]).toMatchObject({ id: dash.json.resource_id, object_kind: 'DASHBOARD', object_revision: 1, status: 'PENDING', decision: null, decided_by: null, requested_by: { id: memberId(REQUESTER) }, version: 1 });
    expect(items[0]?.object_code).toMatch(/^D-/);
    expect(items[1]).toMatchObject({ object_kind: 'METRIC', object_revision: 1, checks: [{ code: 'FORMULA_COMPUTABLE', passed: true }, { code: 'FROZEN_VERSION_EXISTS', passed: true }, { code: 'ROWS_MATCH_SNAPSHOT', passed: true }, { code: 'GROUPS_ADD_UP', passed: true }] });
    expect(items[1]?.object_code).toMatch(/^t_pub_/);
    const first = await inbox('?limit=2');
    expect((first.json.items as unknown[]).length).toBe(2);
    expect(first.json.next_cursor).not.toBeNull();
    const rest = await inbox(`?limit=2&cursor=${first.json.next_cursor as string}`);
    expect((rest.json.items as unknown[]).length).toBe(2);
    expect(rest.json.next_cursor).toBeNull();
    expect((await inbox('?object_kind=DASHBOARD')).json.items).toHaveLength(1);
    expect((await inbox('?status=DECIDED')).json.items).toHaveLength(0);
    expect(await inbox('?status=NOPE')).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'status' } });
    expect(await inbox('?object_kind=NOPE')).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'object_kind' } });
    expect(await inbox('?cursor=zzz')).toMatchObject({ status: 422 });
    expect(await inbox('', NOBODY)).toMatchObject({ status: 403 });
  });

  it('keeps the requests as they were made, in the database: the object, the asker and the checks never change, the decision is written once, nothing is deleted', async () => {
    await frozen();
    const metric = (await draftMetric()).json.resource_id as string;
    const request = (await submit('METRIC', metric)).json.resource_id as string;
    await expect(sqlAs(REQUESTER, "update machvon.bi_publication_request set object_id = gen_random_uuid() where id = $1", [request])).rejects.toThrow(/never change/);
    await expect(sqlAs(REQUESTER, "update machvon.bi_publication_request set requested_by = $2::uuid where id = $1", [request, memberId(NOBODY)])).rejects.toThrow(/never change/);
    await expect(sqlAs(REQUESTER, "update machvon.bi_publication_request set checks_json = '{}'::jsonb where id = $1", [request])).rejects.toThrow(/never change/);
    await expect(sqlAs(APPROVER, "update machvon.bi_publication_request set status = 'DECIDED', decision = 'APPROVED', decided_by = requested_by, decided_at = now() where id = $1", [request])).rejects.toThrow(/bi_publication_request_sod_chk/);
    await expect(sqlAs(APPROVER, "update machvon.bi_publication_request set status = 'DECIDED' where id = $1", [request])).rejects.toThrow(/bi_publication_request_state_chk/);
    await expect(sqlAs(APPROVER, "update machvon.bi_publication_request set status = 'DECIDED', decision = 'REJECTED', decided_by = $2::uuid, decided_at = now() where id = $1", [request, memberId(APPROVER)])).rejects.toThrow(/bi_publication_request_reason_chk/);
    await expect(sqlAs(APPROVER, "update machvon.bi_publication_request set status = 'DECIDED', decision = 'REJECTED', decided_by = $2::uuid, decided_at = now(), comment = 'x' where id = $1", [request, memberId(APPROVER)])).resolves.toBeDefined();
    await expect(sqlAs(APPROVER, "update machvon.bi_publication_request set comment = 'y' where id = $1", [request])).rejects.toThrow(/written once/);
    await expect(sqlAs(APPROVER, "update machvon.bi_publication_request set status = 'PENDING', decision = null, decided_by = null, decided_at = null where id = $1", [request])).rejects.toThrow(/cannot move from DECIDED to PENDING/);
    await expect(sqlAs(APPROVER, 'delete from machvon.bi_publication_request where id = $1', [request])).rejects.toThrow(/permission denied|never deleted/);
    await expect(sqlAs(APPROVER, 'truncate machvon.bi_publication_request', [])).rejects.toThrow(/permission denied/);
    const privileges = await owner<{ requests: boolean; metrics: boolean }>("select has_table_privilege('machvon_app', 'machvon.bi_publication_request', 'DELETE') as requests, has_table_privilege('machvon_app', 'machvon.metric_definition', 'DELETE') as metrics");
    expect(privileges[0]).toEqual({ requests: false, metrics: false });
  });

  /** Holds a transaction open with the statements given, runs `during`, and lets the transaction go: what a command waits for, a test can hold. */
  async function holding(statements: Array<[string, unknown[]]>, during: () => Promise<void>): Promise<void> {
    const client = new Client({ connectionString: app.harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('begin');
      for (const [statement, params] of statements) await client.query(statement, params);
      await during();
      await client.query('commit');
    } finally {
      await client.end();
    }
  }
  const settled = async (reply: Promise<Reply>): Promise<'waiting' | Reply> => Promise.race([reply, new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 800))]);

  it('waits for the lock of the metric code before it certifies a revision, so two approvals of one code are taken one after the other', async () => {
    await frozen();
    const code = `t_lock_${(sequence += 1)}`;
    const metric = (await draftMetric({ code })).json.resource_id as string;
    const request = (await submit('METRIC', metric)).json.resource_id as string;
    let reply: Promise<Reply> | undefined;
    await holding([["select pg_advisory_xact_lock(hashtextextended('bi_metric:' || $1 || ':' || $2, 0))", [TENANT_A, code]]], async () => {
      reply = decide(request, 1, { decision: 'APPROVED' });
      expect(await settled(reply)).toBe('waiting');
    });
    expect(((await reply) as Reply).status).toBe(200);
    expect((await metricRow(metric))?.status).toBe('CERTIFIED');
  });

  it('locks the dashboard and its version before the request, as the approval of the layout does, so the two ways to approve cannot wait for each other', async () => {
    await frozen();
    const certified = await certifiedMetric();
    const board = await dashboardWithVersions([certified], 1);
    const request = (await submit('DASHBOARD', board.versionIds[0] as string)).json.resource_id as string;
    let reply: Promise<Reply> | undefined;
    await holding([['select id from machvon.dashboard where id = $1 for update', [board.id]]], async () => {
      reply = decide(request, 1, { decision: 'APPROVED' });
      expect(await settled(reply)).toBe('waiting');
      // The decision is waiting for the dashboard and holds nothing of the request: whoever takes the request first is not made to wait for it.
      const probe = new Client({ connectionString: app.harness.database.adminUrl });
      await probe.connect();
      try {
        await probe.query('begin');
        await expect(probe.query('select id from machvon.bi_publication_request where id = $1 for update nowait', [request])).resolves.toBeDefined();
        await probe.query('rollback');
      } finally {
        await probe.end();
      }
    });
    expect(((await reply) as Reply).status).toBe(200);
  });

  it('takes two approvals of revisions of one metric one after the other, so the code never has two certified revisions', async () => {
    await frozen();
    const code = `t_race_${(sequence += 1)}`;
    const first = (await draftMetric({ code })).json.resource_id as string;
    const second = (await draftMetric({ code, effective_from: '2026-07-01' })).json.resource_id as string;
    const one = (await submit('METRIC', first)).json.resource_id as string;
    const two = (await submit('METRIC', second)).json.resource_id as string;
    const replies = await Promise.all([decide(one, 1, { decision: 'APPROVED' }), decide(two, 1, { decision: 'APPROVED' })]);
    expect(replies.map((reply) => reply.status)).toEqual([200, 200]);
    const states = await owner<{ status: string }>('select status from machvon.metric_definition where code = $1 order by revision', [code]);
    expect(states.filter((row) => row.status === 'CERTIFIED')).toHaveLength(1);
    expect(states.filter((row) => row.status === 'SUPERSEDED')).toHaveLength(1);
  });

  it('takes the two ways to approve a dashboard in one order: one wins, the other is refused as a conflict, and none fails for a deadlock', async () => {
    await frozen();
    const certified = await certifiedMetric();
    for (let round = 0; round < 5; round += 1) {
      const board = await dashboardWithVersions([certified], 1);
      const request = (await submit('DASHBOARD', board.versionIds[0] as string)).json.resource_id as string;
      const dashboardVersion = Number((await dashboardRow(board.id))?.version);
      const replies = await Promise.all([
        decide(request, 1, { decision: 'APPROVED' }),
        app.call('POST', `/dashboards/${board.id}/publish`, { member: APPROVER, ifMatch: `"${dashboardVersion}"`, body: { decision: 'approve', reason: 'Đạt', evidence_ids: [] } }),
      ]);
      expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
      expect(await versionRow(board.versionIds[0] as string)).toMatchObject({ status: 'PUBLISHED', published_by: memberId(APPROVER) });
      expect(await requestRow(request)).toMatchObject({ status: 'DECIDED', decision: 'APPROVED' });
    }
  });
});
