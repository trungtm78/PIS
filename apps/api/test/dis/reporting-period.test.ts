import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { BASELINE_PACK, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, applyBaseline } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { ReportingPeriodController, ReportingPeriodReadsController } from '../../src/modules/dis/reporting-period.controller';
import { DIS_CLOCK } from '../../src/modules/dis/tokens';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const WORKER = '00000000-0000-4000-8000-000000000000';
const MANAGER = 1; // period.manage, period.lock, reporting_period.read
const PLANNER = 2; // period.manage and reporting_period.read, not period.lock
const READER = 3; // reporting_period.read only
const NOBODY = 4;
const OTHER_TENANT_MANAGER = 1; // of tenant B
const MAKER = 5; // a maker of reports: reads the calendar, manages nothing

interface Reply {
  status: number;
  json: Record<string, unknown>;
  etag: string | null;
}

describe('reporting period calendar (ST-DIS-001, DIS-14)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let now = new Date('2026-12-15T00:00:00Z');

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
  const reset = (tenant = TENANT_A): Promise<unknown> => harness.owner(tenant, [['delete from machvon.period_reopen'], ['delete from machvon.reporting_period']]);

  const generate = (member: number, fiscalYear: number, extra: Record<string, unknown> = {}, tenantId?: string): Promise<Reply> =>
    post('/reporting-periods/generate', { member, body: { calendar_code: 'DEFAULT', fiscal_year: fiscalYear, period_type: 'WEEK', ...extra }, ...(tenantId === undefined ? {} : { tenantId }) });
  const softClose = (member: number, id: string, version: number, reason = 'The deadline has passed'): Promise<Reply> => post(`/reporting-periods/${id}/soft-close`, { member, body: { reason }, ifMatch: `"${version}"` });
  const lock = (member: number, id: string, version: number, reason = 'Locked after the review'): Promise<Reply> => post(`/reporting-periods/${id}/lock`, { member, body: { reason }, ifMatch: `"${version}"` });
  const periodId = async (code: string, tenant = TENANT_A): Promise<string> => (await rows<{ id: string }>('select id from machvon.reporting_period where code = $1', [code], tenant))[0]?.id as string;

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }]);
      const tenants = harness.tenants as TenantDatabase;
      await tenants.withTenant({ tenantId: tenant, membershipId: WORKER, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, WORKER));
    }
    for (const n of [MANAGER, PLANNER, READER, NOBODY, MAKER]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedMembership(TENANT_B, OTHER_TENANT_MANAGER, 1);
    await harness.seedRole(TENANT_A, 1, 'PERIOD_MANAGER', ['period.manage', 'period.lock', 'reporting_period.read'], 40);
    await harness.seedRole(TENANT_A, 2, 'PERIOD_PLANNER', ['period.manage', 'reporting_period.read'], 30);
    await harness.seedRole(TENANT_A, 3, 'PERIOD_READER', ['reporting_period.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'PERIOD_MANAGER', ['period.manage', 'period.lock', 'reporting_period.read'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MANAGER, role: 1, kind: 'TENANT' },
      { n: 2, member: PLANNER, role: 2, kind: 'TENANT' },
      { n: 3, member: READER, role: 3, kind: 'TENANT' },
      { n: 4, member: MAKER, role: 3, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT_MANAGER, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [ReportingPeriodController, ReportingPeriodReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: DIS_CLOCK, useValue: () => now },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  describe('generateReportingPeriods', () => {
    beforeEach(async () => {
      now = new Date('2026-12-15T00:00:00Z');
      await reset();
    });

    it('generates the weeks of 2027 once, due on Friday at 03:00 UTC, and answers a repeat with 409 PERIOD_OVERLAP (AC-ST-DIS-001-3)', async () => {
      const first = await generate(MANAGER, 2027);
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({ status: 'OPEN', resource_version: 1 });
      const stored = await rows<{ n: string; fridays: string; at_three: string; bound: string; revisions: string }>(
        `select count(*)::text as n, count(*) filter (where extract(dow from deadline_at at time zone 'UTC') = 5)::text as fridays,
                count(*) filter (where to_char(deadline_at at time zone 'UTC', 'HH24:MI:SS') = '03:00:00')::text as at_three,
                count(distinct calendar_version_id)::text as bound, string_agg(distinct calendar_version::text, ',') as revisions
           from machvon.reporting_period where fiscal_year = 2027`,
      );
      expect(stored[0]).toEqual({ n: '53', fridays: '53', at_three: '53', bound: '1', revisions: '1' });
      const audit = await rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where action = 'dis.periods_generated' and resource_id = $1::uuid", [first.json.resource_id]);
      expect(audit).toHaveLength(1);
      expect(audit[0]?.safe_diff).toMatchObject({ calendar_code: 'DEFAULT', period_type: 'WEEK', fiscal_year: 2027, count: 53, first_code: 'W2027-01', last_code: 'W2027-53', calendar_revision: 1 });

      const again = await generate(MANAGER, 2027);
      expect([again.status, again.json.code, again.json.detail]).toEqual([409, 'PERIOD_OVERLAP', 'fiscal_year']);
      expect((await rows<{ n: string }>('select count(*)::text as n from machvon.reporting_period'))[0]).toEqual({ n: '53' });
    });

    it('answers a retry with the same key with the first answer and writes once', async () => {
      const key = `key-${randomUUID()}`;
      const body = { calendar_code: 'DEFAULT', fiscal_year: 2028, period_type: 'WEEK' };
      const first = await post('/reporting-periods/generate', { member: MANAGER, body, key });
      const again = await post('/reporting-periods/generate', { member: MANAGER, body, key });
      expect([again.status, again.json.resource_id]).toEqual([200, first.json.resource_id]);
      expect((await rows<{ n: string }>('select count(*)::text as n from machvon.reporting_period where fiscal_year = 2028'))[0]?.n).toBe('52');
    });

    it('refuses what the contract and the rules do not allow, naming the field', async () => {
      const unknown = await generate(MANAGER, 2027, { tenant_id: TENANT_A });
      expect([unknown.status, unknown.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      const month = await generate(MANAGER, 2027, { period_type: 'MONTH' });
      expect([month.status, month.json.code, month.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'period_type']);
      const other = await generate(MANAGER, 2027, { calendar_code: 'OTHER' });
      expect([other.status, other.json.code, other.json.detail]).toEqual([422, 'CALENDAR_NOT_EFFECTIVE', 'calendar_code']);
      const early = await generate(MANAGER, 1969);
      expect([early.status, early.json.code, early.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'fiscal_year']);
      expect(await rows('select id from machvon.reporting_period')).toEqual([]);
    });

    it('needs period.manage: a reader, a caller without grants and a manager of another tenant are refused', async () => {
      for (const member of [READER, NOBODY]) expect((await generate(member, 2027)).status).toBe(403);
      expect((await generate(PLANNER, 2027)).status).toBe(200);
      await reset();
      // The manager of tenant B generates for tenant B only.
      expect((await generate(OTHER_TENANT_MANAGER, 2027, {}, TENANT_B)).status).toBe(200);
      expect(await rows('select id from machvon.reporting_period')).toEqual([]);
      expect((await rows<{ n: string }>('select count(*)::text as n from machvon.reporting_period', [], TENANT_B))[0]?.n).toBe('53');
      await reset(TENANT_B);
    });
  });

  describe('softCloseReportingPeriod and lockReportingPeriod (AC-ST-DIS-001-1)', () => {
    beforeAll(async () => {
      now = new Date('2026-09-01T00:00:00Z');
      await reset();
      expect((await generate(MANAGER, 2026)).status).toBe(200);
    });
    afterAll(async () => {
      await reset();
    });

    it('soft closes after the deadline, locks, and never answers with a "Closed" status; every step is audited and announced', async () => {
      const id = await periodId('W2026-40');
      const detail = await get(`/resources/reporting_period/${id}`, READER);
      expect(detail.json).toMatchObject({ code: 'W2026-40', status: 'OPEN', deadline_at: '2026-10-02T03:00:00.000Z', version: 1, locked_at: null, reopens: [] });

      // Before the deadline nothing is closed.
      now = new Date('2026-10-02T02:59:00Z');
      const early = await softClose(MANAGER, id, 1);
      expect([early.status, early.json.code, early.json.detail]).toEqual([409, 'PERIOD_STATE_INVALID', 'deadline_at']);

      now = new Date('2026-10-02T03:05:00Z');
      const stale = await softClose(MANAGER, id, 9);
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const closed = await softClose(PLANNER, id, 1);
      expect(closed.status).toBe(200);
      expect(closed.json).toMatchObject({ status: 'SOFT_CLOSED', resource_version: 2, resource_id: id });
      expect(closed.etag).toBe('"2"');
      expect((await get(`/resources/reporting_period/${id}`, READER)).json).toMatchObject({ status: 'SOFT_CLOSED', soft_closed_at: '2026-10-02T03:05:00.000Z', locked_at: null });

      // A planner who may manage the periods may not lock them.
      expect((await lock(PLANNER, id, 2)).status).toBe(403);
      const repeated = await softClose(MANAGER, id, 2);
      expect([repeated.status, repeated.json.code]).toEqual([409, 'PERIOD_STATE_INVALID']);

      now = new Date('2026-10-02T03:10:00Z');
      const locked = await lock(MANAGER, id, 2);
      expect(locked.status).toBe(200);
      expect(locked.json).toMatchObject({ status: 'LOCKED', resource_version: 3 });
      const after = await get(`/resources/reporting_period/${id}`, READER);
      expect(after.json).toMatchObject({ status: 'LOCKED', locked_at: '2026-10-02T03:10:00.000Z', locked_by: memberId(MANAGER), version: 3 });
      expect(JSON.stringify(after.json)).not.toContain('"Closed"');
      const again = await lock(MANAGER, id, 3);
      expect([again.status, again.json.code]).toEqual([409, 'PERIOD_STATE_INVALID']);

      const audit = await rows<{ action: string; reason: string }>("select action, reason from machvon.audit_event where resource_id = $1::uuid and action like 'dis.period_%' order by occurred_at", [id]);
      expect(audit).toEqual([
        { action: 'dis.period_soft_closed', reason: 'The deadline has passed' },
        { action: 'dis.period_locked', reason: 'Locked after the review' },
      ]);
      const events = await rows<{ type: string }>("select type from machvon.outbox_event where aggregate_id = $1::uuid order by aggregate_version", [id]);
      expect(events.map((event) => event.type)).toEqual(['period.soft_closed.v1', 'period.locked.v1']);
    });

    it('needs a version, a reason and the permission of the step, and the lock needs the period to be soft closed first', async () => {
      const id = await periodId('W2026-41');
      now = new Date('2026-12-31T00:00:00Z');
      const withoutVersion = await post(`/reporting-periods/${id}/soft-close`, { member: MANAGER, body: { reason: 'The deadline has passed' } });
      expect([withoutVersion.status, withoutVersion.json.code]).toEqual([428, 'PRECONDITION_REQUIRED']);
      const blank = await softClose(MANAGER, id, 1, '      ');
      expect([blank.status, blank.json.code, blank.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'reason']);
      const short = await softClose(MANAGER, id, 1, 'no');
      expect([short.status, short.json.code, short.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'reason']);
      const extra = await post(`/reporting-periods/${id}/soft-close`, { member: MANAGER, body: { reason: 'The deadline has passed', status: 'LOCKED' }, ifMatch: '"1"' });
      expect([extra.status, extra.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      expect((await softClose(READER, id, 1)).status).toBe(403);
      const direct = await lock(MANAGER, id, 1);
      expect([direct.status, direct.json.code]).toEqual([409, 'PERIOD_STATE_INVALID']);
      expect(await rows('select status from machvon.reporting_period where id = $1::uuid and status <> \'OPEN\'', [id])).toEqual([]);
    });

    it('does not reach a period of another tenant, and an unknown id is 404', async () => {
      const id = await periodId('W2026-42');
      now = new Date('2026-12-31T00:00:00Z');
      const foreign = await post(`/reporting-periods/${id}/soft-close`, { member: OTHER_TENANT_MANAGER, tenantId: TENANT_B, body: { reason: 'The deadline has passed' }, ifMatch: '"1"' });
      expect([foreign.status, foreign.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect((await softClose(MANAGER, randomUUID(), 1)).status).toBe(404);
      expect((await get(`/resources/reporting_period/${id}`, OTHER_TENANT_MANAGER, TENANT_B)).status).toBe(404);
    });
  });

  describe('reads for DIS-14 (AC-ST-DIS-001-4)', () => {
    beforeAll(async () => {
      now = new Date('2026-12-15T00:00:00Z');
      await reset();
      expect((await generate(MANAGER, 2027)).status).toBe(200);
    });
    afterAll(async () => {
      await reset();
    });

    it('lists the periods with their status, deadline and calendar version, the latest first, in pages', async () => {
      const first = await get('/resources/reporting_period?limit=2&fiscal_year=2027', MAKER);
      expect(first.status).toBe(200);
      const items = first.json.items as Array<Record<string, unknown>>;
      expect(items.map((item) => item.code)).toEqual(['W2027-53', 'W2027-52']);
      expect(items[0]).toMatchObject({ status: 'OPEN', period_type: 'WEEK', calendar_code: 'DEFAULT', calendar_version: 1, deadline_at: expect.stringMatching(/T03:00:00\.000Z$/), reopens: [] });
      expect(typeof items[0]?.calendar_version_id).toBe('string');
      const next = await get(`/resources/reporting_period?limit=2&fiscal_year=2027&cursor=${first.json.next_cursor as string}`, MAKER);
      expect((next.json.items as Array<Record<string, unknown>>).map((item) => item.code)).toEqual(['W2027-51', 'W2027-50']);
      const all = await get('/resources/reporting_period?limit=200&status=OPEN&period_type=WEEK&calendar_code=DEFAULT', READER);
      expect(all.json.next_cursor).toBeNull();
      expect((all.json.items as unknown[]).length).toBe(53);
      expect(typeof all.json.as_of).toBe('string');
    });

    it('shows the history of reopening requests with the period', async () => {
      const id = await periodId('W2027-10');
      const requestId = randomUUID();
      await rows(
        `insert into machvon.period_reopen (tenant_id, id, period_id, scope_kind, reason, requested_by, status, created_by, updated_by)
         values ($1, $2, $3, 'PERIOD', 'Correction of the figures after the lock', $4, 'REQUESTED', $4, $4)`,
        [TENANT_A, requestId, id, memberId(MAKER)],
      );
      const detail = await get(`/resources/reporting_period/${id}`, MAKER);
      expect(detail.json.reopens).toEqual([{ id: requestId, scope_kind: 'PERIOD', status: 'REQUESTED', window_until: null, requested_at: expect.stringMatching(/Z$/) }]);
      const listed = await get('/resources/reporting_period?fiscal_year=2027&limit=200', MAKER);
      expect((listed.json.items as Array<{ id: string; reopens: unknown[] }>).find((item) => item.id === id)?.reopens).toHaveLength(1);
    });

    it('refuses a malformed filter or cursor, a caller without reporting_period.read and another tenant', async () => {
      for (const query of ['fiscal_year=20x7', 'fiscal_year=', 'status=Closed', 'period_type=DAY', 'calendar_code=', 'limit=0', 'cursor=!!!']) {
        const reply = await get(`/resources/reporting_period?${query}`, READER);
        expect([query, reply.status, reply.json.code]).toEqual([query, 422, 'VALIDATION_FAILED']);
      }
      const forged = Buffer.from(JSON.stringify(['not-a-date', randomUUID()])).toString('base64url');
      expect((await get(`/resources/reporting_period?cursor=${forged}`, READER)).status).toBe(422);
      expect((await get('/resources/reporting_period', NOBODY)).status).toBe(403);
      expect((await get(`/resources/reporting_period/${randomUUID()}`, READER)).status).toBe(404);
      const theirs = await get('/resources/reporting_period', OTHER_TENANT_MANAGER, TENANT_B);
      expect(theirs.json.items).toEqual([]);
    });
  });
});
