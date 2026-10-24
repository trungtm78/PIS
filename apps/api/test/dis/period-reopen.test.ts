import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { BASELINE_PACK, DIS_PERIOD_REOPEN_METRIC, DisPeriodStore, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, applyBaseline } from '@machvon/db';
import { CollectingTelemetry, loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { Client } from 'pg';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { PeriodReopenController } from '../../src/modules/dis/period-reopen.controller';
import { ReportingPeriodController, ReportingPeriodReadsController } from '../../src/modules/dis/reporting-period.controller';
import { DIS_CLOCK, DIS_METRICS } from '../../src/modules/dis/tokens';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const HOUR = 3_600_000;
const MAKER = 1; // period.reopen.request on the subtree of unit 2
const WIDE_MAKER = 2; // request and approve, on the whole tenant
const APPROVER = 3; // approve, on the whole tenant
const SECOND_APPROVER = 4; // approve, on the whole tenant
const UNIT_APPROVER = 5; // approve on the subtree of unit 2 only
const READER = 6; // reads the calendar only
const MANAGER = 7; // generates, closes and locks the periods
const NOBODY = 8;
const OTHER_TENANT_APPROVER = 1; // of tenant B
const PROJECT_ONE = '00000000-0000-4000-8000-0000000000c1'; // of unit 2
const PROJECT_TWO = '00000000-0000-4000-8000-0000000000c2'; // of unit 3, outside the subtree of the maker
const PROJECT_OF_B = '00000000-0000-4000-8000-0000000000c3';
const REASON = 'The Treasury returned the vouchers for a wrong source code';

interface Reply {
  status: number;
  json: Record<string, unknown>;
  etag: string | null;
}

describe('reopening of a locked period (ST-DIS-002, DIS-22)', () => {
  const harness = new AuthzHarness();
  const telemetry = new CollectingTelemetry();
  const periods = new DisPeriodStore();
  let app: RunningApp;
  let now = new Date('2026-09-01T00:00:00Z');
  let week39 = '';
  let week40 = '';
  let week41 = '';

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function send(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; key?: string; ifMatch?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId) };
    if (method === 'POST') {
      headers['content-type'] = 'application/json';
      headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    }
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, ...(method === 'POST' ? { body: JSON.stringify(options.body ?? {}) } : {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown>, etag: response.headers.get('etag') };
  }
  const post = (url: string, options: { member: number; tenantId?: string; body?: unknown; key?: string; ifMatch?: string }): Promise<Reply> => send('POST', url, options);
  const get = (url: string, member: number, tenantId?: string): Promise<Reply> => send('GET', url, { member, ...(tenantId === undefined ? {} : { tenantId }) });

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const periodId = async (code: string, tenant = TENANT_A): Promise<string> => (await rows<{ id: string }>('select id from machvon.reporting_period where code = $1', [code], tenant))[0]?.id as string;
  const clear = (): Promise<unknown> => harness.owner(TENANT_A, [['delete from machvon.period_reopen']]);

  const requestReopen = (member: number, period: string, body: Record<string, unknown>, extra: { key?: string; tenantId?: string } = {}): Promise<Reply> =>
    post(`/reporting-periods/${period}/reopen-requests`, { member, body: { scope_kind: 'PROJECTS', project_ids: [PROJECT_ONE], reason: REASON, window_hours: 72, ...body }, ...extra });
  const decide = (member: number, id: string, version: number, body: Record<string, unknown>, tenantId?: string): Promise<Reply> =>
    post(`/period-reopens/${id}/decision`, { member, body: { decision: 'approve', reason: 'The vouchers are documented', ...body }, ifMatch: `"${version}"`, ...(tenantId === undefined ? {} : { tenantId }) });
  const judge = (period: string, project: string, at: Date) =>
    (harness.tenants as TenantDatabase).withTenant({ tenantId: TENANT_A, membershipId: memberId(READER), scopeVersion: 1 }, (tx) => periods.judge(tx, period, project, at));
  const reopensOf = async (period: string, member: number): Promise<Array<Record<string, unknown>>> => ((await get(`/resources/reporting_period/${period}`, member)).json.reopens as Array<Record<string, unknown>>) ?? [];

  beforeAll(async () => {
    await harness.start();
    const tenants = harness.tenants as TenantDatabase;
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: 1, path: `/${unitId(1)}/` },
        { n: 2, path: `/${unitId(1)}/${unitId(2)}/` },
        { n: 3, path: `/${unitId(1)}/${unitId(3)}/` },
      ]);
      await tenants.withTenant({ tenantId: tenant, membershipId: '00000000-0000-4000-8000-000000000000', scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, '00000000-0000-4000-8000-000000000000'));
    }
    for (const n of [MAKER, WIDE_MAKER, APPROVER, SECOND_APPROVER, UNIT_APPROVER, READER, MANAGER, NOBODY]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedMembership(TENANT_B, OTHER_TENANT_APPROVER, 1);
    await harness.seedRole(TENANT_A, 1, 'REOPEN_MAKER', ['reporting_period.read', 'period.reopen.request'], 30);
    await harness.seedRole(TENANT_A, 2, 'REOPEN_WIDE_MAKER', ['reporting_period.read', 'period.reopen.request', 'period.reopen.approve'], 40);
    await harness.seedRole(TENANT_A, 3, 'REOPEN_APPROVER', ['reporting_period.read', 'period.reopen.approve'], 40);
    await harness.seedRole(TENANT_A, 4, 'PERIOD_READER', ['reporting_period.read'], 20);
    await harness.seedRole(TENANT_A, 5, 'PERIOD_MANAGER', ['period.manage', 'period.lock', 'reporting_period.read'], 40);
    await harness.seedRole(TENANT_B, 1, 'REOPEN_WIDE_MAKER', ['reporting_period.read', 'period.reopen.request', 'period.reopen.approve'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MAKER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 2, member: WIDE_MAKER, role: 2, kind: 'TENANT' },
      { n: 3, member: APPROVER, role: 3, kind: 'TENANT' },
      { n: 4, member: SECOND_APPROVER, role: 3, kind: 'TENANT' },
      { n: 5, member: UNIT_APPROVER, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 6, member: READER, role: 4, kind: 'TENANT' },
      { n: 7, member: MANAGER, role: 5, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT_APPROVER, role: 1, kind: 'TENANT' }]);
    // The reference data a project points at is not what is under test.
    const admin = new Client({ connectionString: harness.database.adminUrl });
    await admin.connect();
    try {
      await admin.query('set session_replication_role = replica');
      await admin.query(
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, 'P-A-001', 'Project one', $3, $4, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B'), ($1, $5, 'P-A-002', 'Project two', $6, $4, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B'),
                ($7, $8, 'P-B-001', 'Project of B', $3, $4, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, PROJECT_ONE, unitId(2), randomUUID(), PROJECT_TWO, unitId(3), TENANT_B, PROJECT_OF_B],
      );
    } finally {
      await admin.end();
    }
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [ReportingPeriodController, ReportingPeriodReadsController, PeriodReopenController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: DIS_CLOCK, useValue: () => now },
        { provide: DIS_METRICS, useValue: telemetry },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
    // Three weeks of 2026: the first two are soft closed and locked after their deadline, the third stays open.
    expect((await post('/reporting-periods/generate', { member: MANAGER, body: { calendar_code: 'DEFAULT', fiscal_year: 2026, period_type: 'WEEK' } })).status).toBe(200);
    week39 = await periodId('W2026-39');
    week40 = await periodId('W2026-40');
    week41 = await periodId('W2026-41');
    for (const [id, closeAt, lockAt] of [
      [week39, '2026-09-25T03:05:00Z', '2026-09-25T03:10:00Z'],
      [week40, '2026-10-02T03:05:00Z', '2026-10-02T03:10:00Z'],
    ]) {
      now = new Date(closeAt as string);
      expect((await post(`/reporting-periods/${id}/soft-close`, { member: MANAGER, body: { reason: 'The deadline has passed' }, ifMatch: '"1"' })).status).toBe(200);
      now = new Date(lockAt as string);
      expect((await post(`/reporting-periods/${id}/lock`, { member: MANAGER, body: { reason: 'Locked after the review' }, ifMatch: '"2"' })).status).toBe(200);
    }
  }, 240_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  beforeEach(async () => {
    now = new Date('2026-10-05T01:00:00Z');
    await clear();
  });

  describe('request, approval and window (AC-ST-DIS-002-1, UAT-AC246)', () => {
    it('refuses a short reason and a self-approval, then opens P-A-001 for 48 hours and closes it again after 49 (AC-ST-DIS-002-1)', async () => {
      const short = await requestReopen(MAKER, week39, { reason: 'sai' });
      expect([short.status, short.json.code, short.json.detail]).toEqual([422, 'REOPEN_REASON_REQUIRED', 'reason']);
      expect(await rows('select id from machvon.period_reopen')).toEqual([]);

      const asked = await requestReopen(WIDE_MAKER, week39, {});
      expect(asked.status).toBe(200);
      expect(asked.json).toMatchObject({ status: 'REQUESTED', resource_version: 1 });
      const id = asked.json.resource_id as string;
      const self = await decide(WIDE_MAKER, id, 1, {});
      expect([self.status, self.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      expect((await rows<{ status: string }>('select status from machvon.period_reopen where id = $1::uuid', [id]))[0]?.status).toBe('REQUESTED');

      const granted = await decide(APPROVER, id, 1, { window_hours: 48 });
      expect(granted.status).toBe(200);
      expect(granted.json).toMatchObject({ status: 'APPROVED', resource_version: 2, resource_id: id });
      expect(granted.etag).toBe('"2"');

      // P-A-001 may submit and P-A-002 may not; the period itself is still LOCKED.
      const during = new Date(now.getTime() + HOUR);
      expect((await judge(week39, PROJECT_ONE, during)).reopen).toMatchObject({ id });
      await expect(judge(week39, PROJECT_TWO, during)).rejects.toMatchObject({ code: 'PERIOD_LOCKED', status: 409 });
      await expect(judge(week40, PROJECT_ONE, during)).rejects.toMatchObject({ code: 'PERIOD_LOCKED', status: 409 });
      expect((await rows<{ status: string; version: string }>('select status, version::text from machvon.reporting_period where id = $1::uuid', [week39]))[0]).toEqual({ status: 'LOCKED', version: '3' });

      // 49 hours later the reopening is EXPIRED and P-A-001 is refused again.
      const after = new Date(now.getTime() + 49 * HOUR);
      await expect(judge(week39, PROJECT_ONE, after)).rejects.toMatchObject({ code: 'PERIOD_LOCKED', status: 409 });
      const clockBefore = now;
      now = after;
      expect((await reopensOf(week39, APPROVER))[0]).toMatchObject({ id, status: 'EXPIRED' });
      now = clockBefore;

      // Who asked, who approved and the window are kept in the audit trail, and the approval is announced.
      const audit = await rows<{ safe_diff: Record<string, unknown>; actor_id: string; reason: string }>(
        "select safe_diff, actor_id, reason from machvon.audit_event where resource_id = $1::uuid and action = 'dis.period_reopen_approved'",
        [id],
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_id: memberId(APPROVER), reason: 'The vouchers are documented' });
      expect(audit[0]?.safe_diff).toMatchObject({
        requested_by: memberId(WIDE_MAKER),
        approved_by: memberId(APPROVER),
        scope_kind: 'PROJECTS',
        project_ids: [PROJECT_ONE],
        requested_window_hours: 72,
        window_hours: 48,
        window_until: new Date(now.getTime() + 48 * HOUR).toISOString(),
        period_code: 'W2026-39',
      });
      const requestedAudit = await rows<{ reason: string; actor_id: string }>("select reason, actor_id from machvon.audit_event where resource_id = $1::uuid and action = 'dis.period_reopen_requested'", [id]);
      expect(requestedAudit).toEqual([{ reason: REASON, actor_id: memberId(WIDE_MAKER) }]);
      const events = await rows<{ type: string; payload: Record<string, unknown> }>('select type, payload from machvon.outbox_event where aggregate_id = $1::uuid', [id]);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'period.reopened.v1', payload: { reopen_id: id, period_id: week39, requested_by: memberId(WIDE_MAKER), approved_by: memberId(APPROVER), project_ids: [PROJECT_ONE] } });
      expect(JSON.stringify(events[0]?.payload)).not.toContain(REASON);
    });

    it('answers a retry with the same key with the first answer and writes once', async () => {
      const key = `key-${randomUUID()}`;
      const first = await requestReopen(MAKER, week39, {}, { key });
      const again = await requestReopen(MAKER, week39, {}, { key });
      expect([again.status, again.json.resource_id]).toEqual([200, first.json.resource_id]);
      expect(await rows('select id from machvon.period_reopen')).toHaveLength(1);
      const decisionKey = `key-${randomUUID()}`;
      const body = { decision: 'approve', reason: 'The vouchers are documented', window_hours: 24 };
      const decided = await post(`/period-reopens/${first.json.resource_id as string}/decision`, { member: APPROVER, body, ifMatch: '"1"', key: decisionKey });
      const replayed = await post(`/period-reopens/${first.json.resource_id as string}/decision`, { member: APPROVER, body, ifMatch: '"1"', key: decisionKey });
      expect([decided.status, replayed.status, replayed.json.resource_version]).toEqual([200, 200, 2]);
      expect(await rows("select id from machvon.outbox_event where type = 'period.reopened.v1' and aggregate_id = $1::uuid", [first.json.resource_id])).toHaveLength(1);
    });

    it('rejects with a reason: nothing opens, nothing is announced, and the request is closed for good', async () => {
      const asked = await requestReopen(MAKER, week39, {});
      const id = asked.json.resource_id as string;
      const rejected = await decide(APPROVER, id, 1, { decision: 'reject', reason: 'The vouchers are not documented' });
      expect(rejected.json).toMatchObject({ status: 'REJECTED', resource_version: 2 });
      await expect(judge(week39, PROJECT_ONE, new Date(now.getTime() + HOUR))).rejects.toMatchObject({ code: 'PERIOD_LOCKED' });
      expect(await rows("select id from machvon.outbox_event where aggregate_id = $1::uuid", [id])).toEqual([]);
      const audit = await rows<{ reason: string; safe_diff: Record<string, unknown> }>("select reason, safe_diff from machvon.audit_event where resource_id = $1::uuid and action = 'dis.period_reopen_rejected'", [id]);
      expect(audit[0]).toMatchObject({ reason: 'The vouchers are not documented', safe_diff: { decided_by: memberId(APPROVER), requested_by: memberId(MAKER) } });
      const again = await decide(SECOND_APPROVER, id, 2, {});
      expect([again.status, again.json.code]).toEqual([409, 'PERIOD_STATE_INVALID']);
    });

    it('opens the whole period for a request for the whole period, made by someone with the whole tenant', async () => {
      const asked = await requestReopen(WIDE_MAKER, week39, { scope_kind: 'PERIOD', project_ids: undefined, window_hours: 24 });
      expect(asked.status).toBe(200);
      expect((await decide(APPROVER, asked.json.resource_id as string, 1, {})).status).toBe(200);
      const during = new Date(now.getTime() + HOUR);
      expect((await judge(week39, PROJECT_TWO, during)).reopen).toMatchObject({ id: asked.json.resource_id });
      expect((await judge(week39, randomUUID(), during)).reopen).toMatchObject({ id: asked.json.resource_id });
      await expect(judge(week40, PROJECT_TWO, during)).rejects.toMatchObject({ code: 'PERIOD_LOCKED' });
    });

    it('lets one of two approvers at the same moment win and answers the other with a version conflict', async () => {
      const asked = await requestReopen(MAKER, week39, {});
      const id = asked.json.resource_id as string;
      const replies = await Promise.all([decide(APPROVER, id, 1, {}), decide(SECOND_APPROVER, id, 1, { decision: 'reject', reason: 'Rejected at once' })]);
      expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
      expect(replies.find((reply) => reply.status === 409)?.json.code).toBe('VERSION_CONFLICT');
    });

    it('counts a request, an approval and a rejection', async () => {
      const outcomes = (): Map<string, number> =>
        new Map(telemetry.snapshot().counters.filter((counter) => counter.name === DIS_PERIOD_REOPEN_METRIC).map((counter) => [counter.labels.outcome as string, counter.value]));
      const before = outcomes();
      const first = await requestReopen(MAKER, week39, {});
      await decide(APPROVER, first.json.resource_id as string, 1, {});
      const second = await requestReopen(MAKER, week40, {});
      await decide(APPROVER, second.json.resource_id as string, 1, { decision: 'reject', reason: 'The vouchers are not documented' });
      const after = outcomes();
      const delta = (outcome: string): number => (after.get(outcome) ?? 0) - (before.get(outcome) ?? 0);
      expect([delta('requested'), delta('approved'), delta('rejected')]).toEqual([2, 1, 1]);
    });
  });

  describe('what a request may ask for and who may ask', () => {
    it('refuses a body the contract does not allow, a window out of range and a scope that does not fit, naming the field', async () => {
      const extra = await requestReopen(MAKER, week39, { status: 'APPROVED' });
      expect([extra.status, extra.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      for (const window_hours of [0, 169]) {
        const reply = await requestReopen(MAKER, week39, { window_hours });
        expect([window_hours, reply.status, reply.json.code, reply.json.detail]).toEqual([window_hours, 422, 'VALIDATION_FAILED', 'window_hours']);
      }
      const named = await requestReopen(WIDE_MAKER, week39, { scope_kind: 'PERIOD' });
      expect([named.status, named.json.code, named.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'project_ids']);
      const none = await requestReopen(MAKER, week39, { project_ids: [] });
      expect([none.status, none.json.code, none.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'project_ids']);
      const missing = await post(`/reporting-periods/${week39}/reopen-requests`, { member: MAKER, body: { scope_kind: 'PERIOD', reason: REASON } });
      expect([missing.status, missing.json.code]).toEqual([400, 'INVALID_REQUEST']);
      const blank = await requestReopen(MAKER, week39, { reason: `${' '.repeat(30)}x` });
      expect([blank.status, blank.json.code]).toEqual([422, 'REOPEN_REASON_REQUIRED']);
      expect(await rows('select id from machvon.period_reopen')).toEqual([]);
    });

    it('is within the reach of the requester: a project of another branch and the whole period are 403 SCOPE_DENIED', async () => {
      const other = await requestReopen(MAKER, week39, { project_ids: [PROJECT_ONE, PROJECT_TWO] });
      expect([other.status, other.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const wholePeriod = await requestReopen(MAKER, week39, { scope_kind: 'PERIOD', project_ids: undefined });
      expect([wholePeriod.status, wholePeriod.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const wide = await requestReopen(WIDE_MAKER, week39, { project_ids: [PROJECT_ONE, PROJECT_TWO] });
      expect(wide.status).toBe(200);
      const unknown = await requestReopen(WIDE_MAKER, week39, { project_ids: [randomUUID()] });
      expect([unknown.status, unknown.json.code, unknown.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'project_ids']);
      const foreign = await requestReopen(WIDE_MAKER, week39, { project_ids: [PROJECT_OF_B] });
      expect([foreign.status, foreign.json.code, foreign.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'project_ids']);
      expect(await rows('select id from machvon.period_reopen')).toHaveLength(1);
    });

    it('keeps project ids as lower-case text in the table, the audit row and the event', async () => {
      const asked = await requestReopen(MAKER, week39, { project_ids: [PROJECT_ONE.toUpperCase()] });
      expect(asked.status).toBe(200);
      const id = asked.json.resource_id as string;
      expect((await rows<{ scope_project_ids: string[] }>('select scope_project_ids from machvon.period_reopen where id = $1::uuid', [id]))[0]?.scope_project_ids).toEqual([PROJECT_ONE]);
      expect((await decide(APPROVER, id, 1, {})).status).toBe(200);
      const audit = await rows<{ safe_diff: { project_ids: string[] } }>("select safe_diff from machvon.audit_event where resource_id = $1::uuid and action = 'dis.period_reopen_approved'", [id]);
      expect(audit[0]?.safe_diff.project_ids).toEqual([PROJECT_ONE]);
    });

    it('is refused for a period that is not locked and for a period that does not exist', async () => {
      const open = await requestReopen(MAKER, week41, {});
      expect([open.status, open.json.code, open.json.detail]).toEqual([409, 'PERIOD_STATE_INVALID', 'status']);
      expect((await requestReopen(MAKER, randomUUID(), {})).status).toBe(404);
    });

    it('needs period.reopen.request: a reader, a caller without grants and an approver are refused', async () => {
      for (const member of [READER, NOBODY, APPROVER]) {
        const reply = await requestReopen(member, week39, {});
        expect([member, reply.status]).toEqual([member, 403]);
      }
      expect(await rows('select id from machvon.period_reopen')).toEqual([]);
    });
  });

  describe('who decides', () => {
    it('lies with the whole tenant: an approver on a subtree is 403 SCOPE_DENIED and a caller without the permission is refused', async () => {
      const asked = await requestReopen(MAKER, week39, {});
      const id = asked.json.resource_id as string;
      const subtree = await decide(UNIT_APPROVER, id, 1, {});
      expect([subtree.status, subtree.json.code]).toEqual([403, 'SCOPE_DENIED']);
      for (const member of [READER, NOBODY, MAKER]) expect((await decide(member, id, 1, {})).status).toBe(403);
      expect((await rows<{ status: string }>('select status from machvon.period_reopen where id = $1::uuid', [id]))[0]?.status).toBe('REQUESTED');
    });

    it('needs the version the approver saw, a reason, and a window within 168 hours that a rejection does not take', async () => {
      const asked = await requestReopen(MAKER, week39, {});
      const id = asked.json.resource_id as string;
      const withoutVersion = await post(`/period-reopens/${id}/decision`, { member: APPROVER, body: { decision: 'approve', reason: 'The vouchers are documented' } });
      expect([withoutVersion.status, withoutVersion.json.code]).toEqual([428, 'PRECONDITION_REQUIRED']);
      const stale = await decide(APPROVER, id, 7, {});
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const terse = await decide(APPROVER, id, 1, { reason: 'ok' });
      expect([terse.status, terse.json.code, terse.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'reason']);
      const long = await decide(APPROVER, id, 1, { window_hours: 169 });
      expect([long.status, long.json.code, long.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'window_hours']);
      const taking = await decide(APPROVER, id, 1, { decision: 'reject', window_hours: 24 });
      expect([taking.status, taking.json.code, taking.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'window_hours']);
      const unknown = await decide(APPROVER, id, 1, { status: 'APPROVED' });
      expect([unknown.status, unknown.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      expect((await decide(APPROVER, randomUUID(), 1, {})).status).toBe(404);
      expect((await rows<{ status: string }>('select status from machvon.period_reopen where id = $1::uuid', [id]))[0]?.status).toBe('REQUESTED');
    });
  });

  describe('what the calendar shows of a request (DIS-14, DIS-22)', () => {
    it('shows the reason, the people, the window and the projects to the approvers and to the requester, and the scope and the window to everyone else', async () => {
      const asked = await requestReopen(MAKER, week39, {});
      const id = asked.json.resource_id as string;
      await decide(APPROVER, id, 1, { window_hours: 48 });
      const detail = {
        id,
        scope_kind: 'PROJECTS',
        status: 'APPROVED',
        version: 2,
        reason: REASON,
        requested_by: memberId(MAKER),
        requested_window_hours: 72,
        approved_by: memberId(APPROVER),
        decided_by: memberId(APPROVER),
        decision_reason: 'The vouchers are documented',
        projects: [{ id: PROJECT_ONE, code: 'P-A-001' }],
        window_until: new Date(now.getTime() + 48 * HOUR).toISOString(),
      };
      expect((await reopensOf(week39, APPROVER))[0]).toMatchObject(detail);
      expect((await reopensOf(week39, MAKER))[0]).toMatchObject(detail);
      const listed = (await get('/resources/reporting_period?fiscal_year=2026&limit=200', SECOND_APPROVER)).json.items as Array<{ id: string; reopens: Array<Record<string, unknown>> }>;
      expect(listed.find((item) => item.id === week39)?.reopens[0]).toMatchObject(detail);
      for (const member of [READER, WIDE_MAKER, UNIT_APPROVER]) {
        const [seen] = await reopensOf(week39, member);
        if (member === WIDE_MAKER) {
          // The wide maker also holds the approver permission on the whole tenant.
          expect(seen).toMatchObject({ reason: REASON });
        } else {
          expect(seen).toEqual({ id, scope_kind: 'PROJECTS', status: 'APPROVED', window_until: detail.window_until, requested_at: expect.stringMatching(/Z$/) });
        }
      }
    });
  });

  describe('tenant isolation', () => {
    it('does not let another tenant see, request or decide', async () => {
      const asked = await requestReopen(MAKER, week39, {});
      const id = asked.json.resource_id as string;
      const foreignRequest = await requestReopen(OTHER_TENANT_APPROVER, week39, {}, { tenantId: TENANT_B });
      expect([foreignRequest.status, foreignRequest.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      const foreignDecision = await decide(OTHER_TENANT_APPROVER, id, 1, {}, TENANT_B);
      expect([foreignDecision.status, foreignDecision.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect((await rows<{ status: string }>('select status from machvon.period_reopen where id = $1::uuid', [id]))[0]?.status).toBe('REQUESTED');
      expect((await get('/resources/reporting_period', OTHER_TENANT_APPROVER, TENANT_B)).json.items).toEqual([]);
    });
  });
});
