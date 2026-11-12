import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, pwfKpi, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import { BASELINE_PACK, applyBaseline } from '../../../../packages/db/src/master-baseline';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { APPROVAL_FINAL_COMMANDS, FinalCommandRegistry } from '../../src/modules/adm/approval.service';
import { PwfKpiReadsController } from '../../src/modules/pwf/kpi.controller';
import { StaffScoreReadsController } from '../../src/modules/pwf/score-reads.controller';
import { PwfScoreResponseBinding } from '../../src/modules/pwf/score-response.binding';
import { StaffScoreController } from '../../src/modules/pwf/score.controller';
import { pwfModule } from '../../src/modules/pwf';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { ScoreFixtures } from '../../../../packages/db/test/support/pwf-score-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(300_000);

const SIGNING_KEY = randomBytes(32);
const TODAY = vietnamDateOf(new Date());
const Y = 2025;
const FROM = `${Y}-07-01`;
const TO = `${Y}-09-30`;
const PROVINCE = 1;
const DEPARTMENT = 2;
const SIBLING = 3;
const MAKER = 1; // owns the projects and the rules
const WORKER = 2; // the person scored: read_own only
const OTHER_STAFF = 3; // read_own only
const HR = 4; // the human resources: the whole tenant
const UNIT_MANAGER = 5; // reads and adjusts in the department; neither exports nor approves
const EXPORTER = 6; // reads and exports in the department
const SIBLING_MANAGER = 7; // reads, adjusts and exports in the sibling unit
const FORMER_MANAGER = 8; // had read_unit in the department, revoked
const APPROVER = 9; // approves in the department
const BOTH = 10; // adjusts and approves in the department
const OUTSIDE_PWF = 11; // read_own only, no pwf.read
const B_HR = 12;
const SYSTEM = '00000000-0000-4000-8000-000000000000';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the scores of staff over HTTP (PWF-3: periods, privacy in three roles, ADM-11, export, adjustments, responses)', () => {
  const harness = new AuthzHarness();
  const fixtures = new ScoreFixtures({ harness, maker: MAKER, unit: DEPARTMENT });
  let app: RunningApp;
  let periodId = '';
  let periodVersion = 0;
  let workerLine = '';
  let otherLine = '';
  let lateTask = '';

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [["select set_config('app.scope_units', '*', false)"], [sql, params]]);
  const views = async (action: string, member: number): Promise<number> => Number((await rows<{ n: string }>('select count(*)::text as n from machvon.audit_event where action = $1 and actor_id = $2', [action, memberId(member)]))[0]?.n ?? 0);

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: PROVINCE, path: `/${unitId(PROVINCE)}/` },
        { n: DEPARTMENT, path: `/${unitId(PROVINCE)}/${unitId(DEPARTMENT)}/`, parent: PROVINCE },
        { n: SIBLING, path: `/${unitId(PROVINCE)}/${unitId(SIBLING)}/`, parent: PROVINCE },
      ]);
      await harness.tenants.withTenant({ tenantId: tenant, membershipId: SYSTEM, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, SYSTEM, TODAY));
    }
    for (const n of [MAKER, HR, UNIT_MANAGER, EXPORTER, FORMER_MANAGER, APPROVER, BOTH, OUTSIDE_PWF]) await harness.seedMembership(TENANT_A, n, PROVINCE);
    for (const n of [WORKER, OTHER_STAFF]) await harness.seedMembership(TENANT_A, n, DEPARTMENT);
    await harness.seedMembership(TENANT_A, SIBLING_MANAGER, SIBLING);
    await harness.seedMembership(TENANT_B, B_HR, PROVINCE);
    const hrPermissions = ['staff_score.read_own', 'staff_score.read_unit', 'staff_score.read_hr', 'staff_score.export', 'staff_score.manage', 'staff_score.approve', 'staff_score.review', 'pwf.read'];
    await harness.seedRole(TENANT_A, 1, 'SCORE_HR', hrPermissions, 50);
    await harness.seedRole(TENANT_A, 2, 'SCORE_STAFF', ['staff_score.read_own'], 10);
    await harness.seedRole(TENANT_A, 3, 'SCORE_MANAGER', ['staff_score.read_own', 'staff_score.read_unit', 'staff_score.adjust', 'pwf.read'], 30);
    await harness.seedRole(TENANT_A, 4, 'SCORE_EXPORTER', ['staff_score.read_own', 'staff_score.read_unit', 'staff_score.export'], 30);
    await harness.seedRole(TENANT_A, 5, 'SCORE_SIBLING', ['staff_score.read_own', 'staff_score.read_unit', 'staff_score.adjust', 'staff_score.export'], 30);
    await harness.seedRole(TENANT_A, 6, 'SCORE_APPROVER', ['staff_score.read_own', 'staff_score.read_unit', 'staff_score.approve'], 30);
    await harness.seedRole(TENANT_A, 7, 'SCORE_BOTH', ['staff_score.read_own', 'staff_score.read_unit', 'staff_score.adjust', 'staff_score.approve'], 30);
    await harness.seedRole(TENANT_B, 1, 'SCORE_HR', hrPermissions, 50);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: HR, role: 1, kind: 'TENANT' },
      { n: 2, member: WORKER, role: 2, kind: 'TENANT' },
      { n: 3, member: OTHER_STAFF, role: 2, kind: 'TENANT' },
      { n: 4, member: UNIT_MANAGER, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 5, member: EXPORTER, role: 4, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 6, member: SIBLING_MANAGER, role: 5, kind: 'UNIT_SUBTREE', refs: [unitId(SIBLING)] },
      { n: 7, member: FORMER_MANAGER, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)], status: 'Revoked' },
      { n: 8, member: APPROVER, role: 6, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 9, member: BOTH, role: 7, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 10, member: OUTSIDE_PWF, role: 2, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_HR, role: 1, kind: 'TENANT' }]);
    await fixtures.seed({ maker: MAKER, submitter: WORKER, checker: HR }, { ...pwfKpi.DEFAULT_STAFF_SCORING_PARAMS, min_rated_tasks: 1, min_effective_weight: 0.5 });
    const wf = await fixtures.workflow();
    const onTime = await fixtures.task(wf, 'L1', { baselineFinish: `${Y}-08-15`, actualFinish: `${Y}-08-15` });
    lateTask = await fixtures.task(wf, 'L2', { baselineFinish: `${Y}-08-15`, actualFinish: `${Y}-08-22` });
    const other = await fixtures.task(wf, 'L3', { baselineFinish: `${Y}-08-15`, actualFinish: `${Y}-08-15`, returns: 1 });
    await fixtures.hold(onTime, WORKER);
    await fixtures.hold(lateTask, WORKER);
    await fixtures.hold(other, OTHER_STAFF);
    const tenants = harness.tenants as TenantDatabase;
    const registry = new FinalCommandRegistry();
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [StaffScoreController, StaffScoreReadsController, PwfKpiReadsController],
      providers: [{ provide: TenantDatabase, useValue: tenants }, { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) }, { provide: APPROVAL_FINAL_COMMANDS, useValue: registry }, PwfScoreResponseBinding],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered in the module of PWF', () => {
    expect(pwfModule.controllers).toEqual(expect.arrayContaining([StaffScoreController, StaffScoreReadsController, PwfKpiReadsController]));
    expect(pwfModule.providers).toContain(PwfScoreResponseBinding);
  });

  describe('the catalogue and the results of the KPIs', () => {
    it('lists the closed catalogue of the operations to whoever may read the workflows, and refuses a caller who may not', async () => {
      const listed = await call('GET', '/pwf/kpi-operations', { member: HR });
      expect(listed.status).toBe(200);
      const items = listed.json.items as Array<{ code: string; unit: string; good_direction: string; required_facts: string[]; params: unknown[] }>;
      expect(items.map((one) => one.code)).toEqual(['DAYS_DEVIATION', 'ON_TIME_RATE', 'AMOUNT_VARIANCE_PCT', 'RETURN_COUNT', 'EVIDENCE_COMPLETENESS', 'RESCHEDULE_COUNT']);
      expect(items[0]).toMatchObject({ unit: 'DAYS', good_direction: 'LOWER_IS_BETTER', required_facts: expect.arrayContaining(['baseline_due_first', 'actual_finish']) });
      expect((await call('GET', '/pwf/kpi-operations', { member: OTHER_STAFF })).status).toBe(403);
    });

    it('lists the results of the KPIs of a task with what each was computed from, in the scope of pwf.read, and never to a caller out of it', async () => {
      await harness.owner(TENANT_A, [['update machvon.project_task set version = version where id = $1::uuid', [lateTask]]]);
      const before = await call('GET', `/project-tasks/${lateTask}/kpi-results`, { member: HR });
      expect(before).toMatchObject({ status: 200, json: { items: [], next_cursor: null } });
    });
  });

  describe('compute and lock (BR-PWF-39)', () => {
    it('computes a draft once per key (the same key and request answer the same, another request with the key is 409), for the permission manage over the unit only', async () => {
      const body = { scope_unit_id: unitId(DEPARTMENT), period_from: FROM, period_to: TO, policy_code: 'TESTPOL' };
      const first = await call('POST', '/staff-score-periods', { member: HR, body, key: 'compute-the-third-quarter-key' });
      expect(first).toMatchObject({ status: 200, json: { rated_count: 2, small_sample_count: 0, not_rated_count: 0, period: { status: 'DRAFT', policy_code: 'TESTPOL', line_count: 2, period_kind: 'QUARTER' } } });
      expect(await call('POST', '/staff-score-periods', { member: HR, body, key: 'compute-the-third-quarter-key' })).toEqual(first);
      expect((await call('POST', '/staff-score-periods', { member: HR, body: { ...body, policy_code: 'OTHERPOL' }, key: 'compute-the-third-quarter-key' })).status).toBe(409);
      expect((await call('POST', '/staff-score-periods', { member: UNIT_MANAGER, body })).status).toBe(403);
      expect((await call('POST', '/staff-score-periods', { member: WORKER, body })).status).toBe(403);
      periodId = (first.json.period as { id: string }).id;
      periodVersion = (first.json.period as { version: number }).version;
      expect((await rows('select 1 from machvon.audit_event where action = $1 and resource_id = $2', ['score.period_computed', periodId])).length).toBeGreaterThanOrEqual(1);
    });

    it('does not show a draft to the person scored, and shows it to a manager of the unit', async () => {
      expect(await call('GET', '/me/staff-scores', { member: WORKER })).toMatchObject({ status: 200, json: { items: [] } });
      const lines = await call('GET', `/staff-score-periods/${periodId}/lines`, { member: UNIT_MANAGER });
      expect(lines).toMatchObject({ status: 200, json: { total: 2 } });
    });

    it('UAT-PWF-SEC-11: locks the draft in the version the screen read (a stale one is 409), with the audit row and an event with no score in it', async () => {
      expect((await call('POST', `/staff-score-periods/${periodId}/lock`, { member: HR, ifMatch: `"${periodVersion + 7}"` })).status).toBe(409);
      expect((await call('POST', `/staff-score-periods/${periodId}/lock`, { member: UNIT_MANAGER, ifMatch: `"${periodVersion}"` })).status).toBe(403);
      const locked = await call('POST', `/staff-score-periods/${periodId}/lock`, { member: HR, ifMatch: `"${periodVersion}"` });
      expect(locked).toMatchObject({ status: 200, json: { status: 'LOCKED', resource_id: periodId, resource_version: periodVersion + 1 } });
      periodVersion += 1;
      const [event] = await rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2', [periodId, 'pwf.score.period.locked.v1']);
      expect(event?.payload).toMatchObject({ id: periodId, status: 'LOCKED', from_status: 'DRAFT' });
      expect(JSON.stringify(event?.payload)).not.toMatch(/score|reason|name/);
      expect((await rows('select 1 from machvon.audit_event where action = $1 and resource_id = $2', ['score.period_locked', periodId])).length).toBe(1);
      expect((await call('POST', `/staff-score-periods/${periodId}/lock`, { member: HR, ifMatch: `"${periodVersion}"` })).status).toBe(409);
      const [row] = await rows<{ id: string }>('select id from machvon.staff_score_line where period_id = $1::uuid and membership_id = $2::uuid', [periodId, memberId(WORKER)]);
      workerLine = row?.id as string;
      otherLine = ((await rows<{ id: string }>('select id from machvon.staff_score_line where period_id = $1::uuid and membership_id = $2::uuid', [periodId, memberId(OTHER_STAFF)]))[0] as { id: string }).id;
    });
  });

  describe('privacy in three roles, and the trail of every view (BR-PWF-40, R33, ADM-11)', () => {
    it('shows the person their own points with every task, share and the basis of the figure, and no flags', async () => {
      const mine = await call('GET', '/me/staff-scores', { member: WORKER });
      expect(mine.status).toBe(200);
      const [item] = mine.json.items as Array<{ period: { id: string; status: string }; line: Record<string, unknown> }>;
      expect(item?.period).toMatchObject({ id: periodId, status: 'LOCKED' });
      expect(item?.line).toMatchObject({ score_computed: 71.88, score_adjusted: 71.88, rating: 'FAIR', state: 'RATED', can_respond: true, can_request_adjustment: false, basis: { policy_code: 'TESTPOL', policy_version: 1 } });
      expect((item?.line.contributions as unknown[]).length).toBe(2);
      expect((item?.line.contributions as Array<{ spans: unknown[]; task_id: string | null }>)[0]?.spans.length).toBe(1);
      expect(item?.line).not.toHaveProperty('flags');
      expect(await views('score.line_viewed', WORKER)).toBe(0);
    });

    it('UAT-PWF-SEC-02, UAT-PWF-SEC-03, UAT-PWF-SEC-04: answers 404 for the line of another person to a colleague, to the manager of a sibling unit and to someone who reads no scores of the unit, and never a 403 that tells it is there', async () => {
      for (const member of [OTHER_STAFF, SIBLING_MANAGER, APPROVER]) expect([member, (await call('GET', `/staff-score-lines/${workerLine}`, { member })).status]).toEqual([member, member === APPROVER ? 200 : 404]);
      expect((await call('GET', `/staff-score-periods/${periodId}/lines`, { member: SIBLING_MANAGER })).status).toBe(404);
      expect((await call('GET', `/staff-score-periods/${periodId}`, { member: SIBLING_MANAGER })).status).toBe(404);
      expect((await call('GET', `/staff-score-lines/${workerLine}`, { member: B_HR, tenantId: TENANT_B })).status).toBe(404);
      expect((await call('GET', `/staff-score-lines/${randomUUID()}`, { member: HR })).status).toBe(404);
    });

    it('UAT-PWF-13: refuses the former manager whose grant was revoked at the door, and a manager of the unit sees the line with the tasks of the projects they may read', async () => {
      expect((await call('GET', `/staff-score-periods/${periodId}/lines`, { member: FORMER_MANAGER })).status).toBe(403);
      expect((await call('GET', `/staff-score-lines/${workerLine}`, { member: FORMER_MANAGER })).status).toBe(403);
      const seen = await call('GET', `/staff-score-lines/${workerLine}`, { member: UNIT_MANAGER });
      expect(seen).toMatchObject({ status: 200, json: { score_computed: 71.88, can_request_adjustment: true, can_respond: false } });
      // The manager holds pwf.read over the department, which owns the projects: the tasks are shown. A reader of the scores who may not read the workflows keeps the points and loses the tasks.
      const contributions = seen.json.contributions as Array<{ task_id: string | null; name: string; task_code: string }>;
      expect(contributions.length).toBe(2);
      expect(contributions.every((one) => one.task_id !== null && one.name.startsWith('Task'))).toBe(true);
      const masked = (await call('GET', `/staff-score-lines/${workerLine}`, { member: APPROVER })).json.contributions as Array<{ task_id: string | null; name: string; task_code: string }>;
      expect(masked.every((one) => one.task_id === null && one.name === '' && one.task_code !== '')).toBe(true);
      const hr = await call('GET', `/staff-score-lines/${workerLine}`, { member: HR });
      expect((hr.json.contributions as Array<{ task_id: string | null }>).every((one) => one.task_id !== null)).toBe(true);
    });

    it('writes the audit row of every view of another person (who, which period, how many rows) and none for a person reading their own', async () => {
      expect(await views('score.line_viewed', UNIT_MANAGER)).toBe(1);
      expect(await views('score.line_viewed', HR)).toBe(1);
      await call('GET', `/staff-score-periods/${periodId}/lines`, { member: UNIT_MANAGER });
      expect(await views('score.lines_viewed', UNIT_MANAGER)).toBeGreaterThanOrEqual(2);
      const [audit] = await rows<{ diff: Record<string, unknown>; classification: string }>("select safe_diff as diff, classification from machvon.audit_event where action = 'score.lines_viewed' and actor_id = $1 order by occurred_at desc limit 1", [memberId(UNIT_MANAGER)]);
      expect(audit).toMatchObject({ classification: 'PERSONAL', diff: { rows: 2, total: 2, whole_tenant: false } });
      expect(JSON.stringify(audit?.diff)).not.toMatch(/71\.88|97\.5/);
      expect(await views('score.line_viewed', WORKER)).toBe(0);
    });

    it('keeps the lists to the units each caller reaches: the unit manager the department, the human resources the whole tenant, the periods by the lines in them', async () => {
      expect(await call('GET', '/staff-score-periods', { member: UNIT_MANAGER })).toMatchObject({ status: 200, json: { total: 1 } });
      expect(await call('GET', '/staff-score-periods', { member: SIBLING_MANAGER })).toMatchObject({ status: 200, json: { total: 0, items: [] } });
      expect(await call('GET', '/staff-score-periods', { member: HR })).toMatchObject({ status: 200, json: { total: 1 } });
      expect(await call('GET', '/staff-score-periods', { member: B_HR, tenantId: TENANT_B })).toMatchObject({ status: 200, json: { total: 0 } });
      expect((await call('GET', '/staff-score-periods', { member: WORKER })).status).toBe(403);
    });

    it('compares the periods of a person for the person and for a reader of their unit, and keeps a stranger out; a view of another person is audited', async () => {
      expect(await call('GET', '/staff-score-lines/compare', { member: WORKER })).toMatchObject({ status: 200, json: { membership_id: memberId(WORKER), sample_sizes_differ: false } });
      const asked = await call('GET', `/staff-score-lines/compare?membership_id=${memberId(WORKER)}`, { member: UNIT_MANAGER });
      expect(asked.status).toBe(200);
      expect((asked.json.points as unknown[]).length).toBe(1);
      expect(await views('score.comparison_viewed', UNIT_MANAGER)).toBe(1);
      expect((await call('GET', `/staff-score-lines/compare?membership_id=${memberId(WORKER)}`, { member: OTHER_STAFF })).status).toBe(404);
    });

    it('shows the overview by unit to the human resources alone, with no name and no score of a person', async () => {
      const overview = await call('GET', `/staff-score-periods/${periodId}/overview`, { member: HR });
      expect(overview).toMatchObject({ status: 200, json: { period_id: periodId } });
      expect(overview.json.units).toEqual([expect.objectContaining({ unit_id: unitId(DEPARTMENT), people: 2, rated: 2, mean_score: 84.69 })]);
      expect((await call('GET', `/staff-score-periods/${periodId}/overview`, { member: UNIT_MANAGER })).status).toBe(403);
      expect(JSON.stringify(overview.json)).not.toContain(memberId(WORKER));
    });

    it('UAT-PWF-SEC-10: shows the signals to the reviewer only and records the view', async () => {
      expect(await call('GET', `/staff-score-periods/${periodId}/signals`, { member: HR })).toMatchObject({ status: 200, json: { items: [] } });
      expect((await call('GET', `/staff-score-periods/${periodId}/signals`, { member: UNIT_MANAGER })).status).toBe(403);
      expect(await views('score.signals_viewed', HR)).toBe(1);
    });
  });

  describe('the export (R33: the file is made of what the caller may export and read, and every file is audited)', () => {
    it('UAT-PWF-SEC-05: refuses a caller with no export permission, hands a unit exporter the lines of their unit, and an exporter of another unit nothing', async () => {
      expect((await call('GET', `/staff-score-periods/${periodId}/export`, { member: UNIT_MANAGER })).status).toBe(403);
      const file = await call('GET', `/staff-score-periods/${periodId}/export?format=csv`, { member: EXPORTER });
      expect(file.status).toBe(200);
      const text = Buffer.from(file.json.content_base64 as string, 'base64').toString('utf8');
      expect(file.json).toMatchObject({ content_type: 'text/csv; charset=utf-8', size_bytes: Buffer.byteLength(text) });
      expect(text.split('\r\n').filter((line) => /^U\d+,/.test(line)).length).toBe(2);
      expect(text).toContain('71.88');
      expect((await call('GET', `/staff-score-periods/${periodId}/export`, { member: SIBLING_MANAGER })).status).toBe(404);
      expect((await call('GET', `/staff-score-periods/${periodId}/export`, { member: FORMER_MANAGER })).status).toBe(403);
      expect((await call('GET', `/staff-score-periods/${periodId}/export`, { member: B_HR, tenantId: TENANT_B })).status).toBe(404);
    });

    it('audits the file with its hash and the rows, and the human resources export the whole tenant in a workbook', async () => {
      const [audit] = await rows<{ diff: Record<string, unknown> }>("select safe_diff as diff from machvon.audit_event where action = 'score.period_exported' and actor_id = $1", [memberId(EXPORTER)]);
      expect(audit?.diff).toMatchObject({ rows: 2, format: 'csv', whole_tenant: false });
      expect(audit?.diff.sha256).toMatch(/^[0-9a-f]{64}$/);
      const workbook = await call('GET', `/staff-score-periods/${periodId}/export`, { member: HR });
      expect(workbook).toMatchObject({ status: 200, json: { content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } });
      expect(Buffer.from(workbook.json.content_base64 as string, 'base64').subarray(0, 2).toString()).toBe('PK');
      const [whole] = await rows<{ diff: Record<string, unknown> }>("select safe_diff as diff from machvon.audit_event where action = 'score.period_exported' and actor_id = $1", [memberId(HR)]);
      expect(whole?.diff).toMatchObject({ rows: 2, format: 'xlsx', whole_tenant: true });
      expect((await call('GET', `/staff-score-periods/${periodId}/export?format=pdf`, { member: HR })).status).toBe(422);
    });
  });

  describe('adjustments (BR-PWF-38: reason, bounds, a second approver who is neither the maker nor the person scored)', () => {
    it('UAT-PWF-BND-10: asks inside the bounds, refuses what the policy forbids and the person scored (no permission), and is decided by a second person who holds the permission', async () => {
      const ask = (body: Record<string, unknown>, member = UNIT_MANAGER) => call('POST', `/staff-score-lines/${workerLine}/adjustments`, { member, body });
      expect((await ask({ points: 5, reason: 'too short' })).status).toBe(422);
      expect((await ask({ points: 12, reason: 'The other agency answered late and the letter proves it.' })).status).toBe(422);
      expect((await ask({ points: 5, reason: 'The other agency answered late and the letter proves it.' }, WORKER)).status).toBe(403);
      expect((await ask({ points: 5, reason: 'The other agency answered late and the letter proves it.' }, SIBLING_MANAGER)).status).toBe(404);
      const asked = await ask({ points: 5, reason: 'The other agency answered late and the letter proves it.', evidence_ref: 'Letter 12/2025' });
      expect(asked).toMatchObject({ status: 200, json: { status: 'REQUESTED', resource_version: 1 } });
      const id = asked.json.resource_id as string;
      expect((await call('POST', `/staff-score-adjustments/${id}/decide`, { member: UNIT_MANAGER, body: { decision: 'APPROVE' }, ifMatch: '"1"' })).status).toBe(403);
      expect((await call('POST', `/staff-score-adjustments/${id}/decide`, { member: APPROVER, body: { decision: 'APPROVE', note: 'Evidence read' }, ifMatch: '"4"' })).status).toBe(409);
      const decided = await call('POST', `/staff-score-adjustments/${id}/decide`, { member: APPROVER, body: { decision: 'APPROVE', note: 'Evidence read' }, ifMatch: '"1"' });
      expect(decided).toMatchObject({ status: 200, json: { status: 'APPROVED', resource_version: 2 } });
      const line = await call('GET', `/staff-score-lines/${workerLine}`, { member: WORKER });
      expect(line.json).toMatchObject({ score_computed: 71.88, score_adjusted: 76.88 });
      expect((line.json.adjustments as Array<{ status: string; points: number }>).map((one) => [one.status, one.points])).toEqual([['APPROVED', 5]]);
      const [event] = await rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2', [id, 'pwf.score.adjustment.decided.v1']);
      expect(JSON.stringify(event?.payload)).not.toMatch(/points|reason|score/);
    });

    it('UAT-PWF-SEC-08: never lets a person approve what they asked for (403 SELF_APPROVAL_DENIED) even when they hold both permissions', async () => {
      const asked = await call('POST', `/staff-score-lines/${otherLine}/adjustments`, { member: BOTH, body: { points: -3, reason: 'The return of the task was recorded twice in the review.' } });
      expect(asked.status).toBe(200);
      const denied = await call('POST', `/staff-score-adjustments/${asked.json.resource_id as string}/decide`, { member: BOTH, body: { decision: 'APPROVE' }, ifMatch: '"1"' });
      expect(denied).toMatchObject({ status: 403 });
      expect(JSON.stringify(denied.json)).toContain('SELF_APPROVAL_DENIED');
    });
  });

  describe('the response of the person scored and the end of the window (BR-PWF-39, R43)', () => {
    let responseId = '';
    it('takes the response of the person scored only, starts its clock, and refuses a short one and anybody else', async () => {
      const body = { body: 'The delay came from the agency; here is the letter I sent them on the due day.' };
      expect((await call('POST', `/staff-score-lines/${workerLine}/responses`, { member: OTHER_STAFF, body })).status).toBe(404);
      expect((await call('POST', `/staff-score-lines/${workerLine}/responses`, { member: WORKER, body: { body: 'short' } })).status).toBe(422);
      const sent = await call('POST', `/staff-score-lines/${workerLine}/responses`, { member: WORKER, body, key: 'respond-once-key-for-the-test' });
      expect(sent).toMatchObject({ status: 200, json: { status: 'OPEN' } });
      expect(await call('POST', `/staff-score-lines/${workerLine}/responses`, { member: WORKER, body, key: 'respond-once-key-for-the-test' })).toEqual(sent);
      responseId = sent.json.resource_id as string;
      const clocks = await rows<{ status: string; owner_unit_id: string; subject_id: string }>("select status, owner_unit_id, subject_id from machvon.work_clock where clock_type = 'PWF_SCORE_RESPONSE'");
      expect(clocks).toEqual([{ status: 'RUNNING', owner_unit_id: unitId(DEPARTMENT), subject_id: responseId }]);
      expect((await rows('select 1 from machvon.workflow_instance where resource_id = $1', [responseId])).length).toBe(0);
      const [event] = await rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2', [responseId, 'pwf.score.response.submitted.v1']);
      expect(JSON.stringify(event?.payload)).not.toContain('letter');
    });

    it('keeps the period from becoming official while the response is open, then handles it by someone else and makes the period official', async () => {
      expect((await call('POST', `/staff-score-periods/${periodId}/officialize`, { member: HR, ifMatch: `"${periodVersion}"` })).status).toBe(409);
      const line = await call('GET', `/staff-score-lines/${workerLine}`, { member: APPROVER });
      const version = line.json.version as number;
      expect((await call('POST', `/staff-score-responses/${responseId}/handle`, { member: WORKER, body: { outcome: 'KEEP', conclusion: 'No' }, ifMatch: `"${version}"` })).status).toBe(403);
      expect((await call('POST', `/staff-score-responses/${responseId}/handle`, { member: APPROVER, body: { outcome: 'KEEP', conclusion: 'The score stands: the letter is after the due day.' }, ifMatch: `"${version + 5}"` })).status).toBe(409);
      expect((await call('POST', `/staff-score-responses/${responseId}/handle`, { member: APPROVER, body: { outcome: 'ADJUST', conclusion: 'Adjust it please.' }, ifMatch: `"${version}"` })).status).toBe(422);
      const handled = await call('POST', `/staff-score-responses/${responseId}/handle`, { member: APPROVER, body: { outcome: 'KEEP', conclusion: 'The score stands: the letter is after the due day.' }, ifMatch: `"${version}"` });
      expect(handled).toMatchObject({ status: 200, json: { status: 'HANDLED' } });
      expect((await rows<{ status: string }>("select status from machvon.work_clock where clock_type = 'PWF_SCORE_RESPONSE'"))[0]?.status).toBe('MET');
      const refresh = await call('GET', `/staff-score-periods/${periodId}`, { member: HR });
      const official = await call('POST', `/staff-score-periods/${periodId}/officialize`, { member: HR, ifMatch: `"${refresh.json.version as number}"` });
      expect(official).toMatchObject({ status: 200, json: { status: 'OFFICIAL' } });
      expect((await call('POST', `/staff-score-lines/${workerLine}/responses`, { member: WORKER, body: { body: 'A new answer after the period became official.' } })).status).toBe(409);
      const [event] = await rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2', [periodId, 'pwf.score.period.officialized.v1']);
      expect(event?.payload).toMatchObject({ status: 'OFFICIAL' });
    });
  });
});
