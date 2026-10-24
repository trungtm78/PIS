import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, WorkCalendarStore } from '@machvon/db';
import { addWorkingTime, loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../src/command.module';
import { PolicyModule } from '../src/policy.module';
import { ProblemFilter } from '../src/problem.filter';
import { WorkCalendarReadsController, WorkCalendarsController } from '../src/modules/adm/work-calendar.controller';
import { AuthzHarness, TENANT_A, memberId, unitId } from '../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from './isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from './isolation/test-app';
import type { RunningApp } from './isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const path = (...ns: number[]): string => `/${ns.map(unitId).join('/')}/`;

// Members of tenant A.
const AUTHOR = 1; // adm.calendar.manage on the whole tenant
const PUBLISHER = 2; // adm.calendar.manage on the whole tenant (a second person)
const UNIT_ADMIN = 3; // manage on the subtree of unit 2 only
const NOBODY = 4; // holds a role without the permission
const READER = 5; // adm.calendar.read on the whole tenant
const UNIT_READER = 6; // adm.calendar.read on the subtree of unit 2 only

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

const STD_2026 = {
  calendar_code: 'VN-STD',
  year: 2026,
  working_days: [1, 2, 3, 4, 5],
  holidays: [
    { date: '2026-04-30', name: 'Reunification Day', legal_basis_ref: 'Labour Code 2019 art. 112' },
    { date: '2026-05-01', name: 'Labour Day', legal_basis_ref: 'Labour Code 2019 art. 112' },
  ],
  compensated_workdays: [],
  legal_basis_ref: 'Labour Code 2019 art. 112; placeholder notice 2026',
};

describe('working calendar commands (ST-ADM-010)', () => {
  const harness = new AuthzHarness();
  const store = new WorkCalendarStore();
  let app: RunningApp;

  async function call(url: string, options: { member: number; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const token = signTenantContext({ tenantId: TENANT_A, membershipId: memberId(options.member), scopeVersion: 1 }, SIGNING_KEY);
    const headers: Record<string, string> = { [TENANT_HEADER]: token, 'content-type': 'application/json', 'idempotency-key': options.key ?? `key-${randomUUID()}` };
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method: 'POST', headers, body: JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  async function read(url: string, member: number): Promise<Reply> {
    const token = signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
    const response = await fetch(`${app.baseUrl}${url}`, { headers: { [TENANT_HEADER]: token } });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const draft = (member: number, body: Record<string, unknown> = STD_2026): Promise<Reply> => call('/work-calendars', { member, body });
  const publish = (member: number, calendarId: string, ifMatch = '"1"'): Promise<Reply> =>
    call(`/work-calendars/${calendarId}/publish`, { member, ifMatch, body: { reason: 'The notice of the year is signed' } });
  const idOf = (reply: Reply): string => reply.json.resource_id as string;
  const countOf = async (sql: string, params: unknown[] = []): Promise<number> => Number((await harness.owner<{ n: string }>(TENANT_A, [[sql, params]]))[0]?.n);
  const fieldsOf = (reply: Reply): string[] => (reply.json.errors as Array<{ field: string; code: string }>).map((entry) => `${entry.field}:${entry.code}`);
  const dueIn = async (start: string, hours: number): Promise<string> => {
    const tenants = harness.tenants as TenantDatabase;
    const source = await tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(AUTHOR), scopeVersion: 1 }, (tx) => store.source(tx, 'VN-STD', new Date(start).getUTCFullYear()));
    return addWorkingTime(source, new Date(start), { hours }).toISOString();
  };

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: 1, path: path(1) },
      { n: 2, path: path(1, 2), parent: 1 },
    ]);
    for (const n of [AUTHOR, PUBLISHER, UNIT_ADMIN, NOBODY, READER, UNIT_READER]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedRole(TENANT_A, 1, 'CALENDAR_ADMIN', ['adm.calendar.manage'], 60);
    await harness.seedRole(TENANT_A, 3, 'CALENDAR_READER', ['adm.calendar.read'], 20);
    await harness.seedRole(TENANT_A, 2, 'UNRELATED', ['adm.security.read'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: AUTHOR, role: 1, kind: 'TENANT' },
      { n: 2, member: PUBLISHER, role: 1, kind: 'TENANT' },
      { n: 3, member: UNIT_ADMIN, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 4, member: NOBODY, role: 2, kind: 'TENANT' },
      { n: 5, member: READER, role: 3, kind: 'TENANT' },
      { n: 6, member: UNIT_READER, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [WorkCalendarsController, WorkCalendarReadsController],
      providers: [{ provide: TenantDatabase, useValue: tenants }, { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) }],
    });
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  afterEach(async () => {
    await harness.owner(TENANT_A, [
      ['delete from machvon.work_calendar_version', []],
      ["delete from machvon.audit_event where resource_type = 'work_calendar_version'", []],
    ]);
  });

  describe('createWorkCalendarVersion', () => {
    it('creates a draft revision 1 and audits it, and a draft does not yet count deadlines', async () => {
      const reply = await draft(AUTHOR);
      expect(reply.status).toBe(201);
      expect(reply.json).toMatchObject({ status: 'DRAFTED', resource_version: 1 });
      expect(await countOf("select count(*) as n from machvon.work_calendar_version where id = $1 and status = 'Draft' and revision = 1", [idOf(reply)])).toBe(1);
      expect(await countOf("select count(*) as n from machvon.audit_event where action = 'work_calendar.create' and resource_id = $1", [idOf(reply)])).toBe(1);
      await expect(dueIn('2026-04-29T15:00:00+07:00', 8)).rejects.toMatchObject({ code: 'CALENDAR_NOT_EFFECTIVE' });
    });

    it('refuses a 2027 calendar with a date outside its year with 422 CALENDAR_INVALID, naming the field, and stores nothing (AC-ST-ADM-010-2)', async () => {
      const reply = await draft(AUTHOR, {
        ...STD_2026,
        year: 2027,
        compensated_workdays: [],
        holidays: [{ date: '2027-01-01', name: 'New Year' }, { date: '2026-12-31', name: 'The day before' }],
      });
      expect(reply.status).toBe(422);
      expect(reply.json.code).toBe('CALENDAR_INVALID');
      expect(fieldsOf(reply)).toEqual(['holidays[1]:OUT_OF_YEAR']);
      expect(await countOf('select count(*) as n from machvon.work_calendar_version')).toBe(0);
    });

    it.each([
      ['a holiday listed twice', { holidays: [STD_2026.holidays[0], STD_2026.holidays[0]] }, ['holidays[1]:DUPLICATE']],
      ['no working weekday', { working_days: [] }, ['working_days:NO_WORKING_DAYS']],
      ['a compensated day on a holiday', { compensated_workdays: ['2026-05-01'] }, ['compensated_workdays[0]:COMPENSATED_ON_HOLIDAY']],
      ['a compensated day on an ordinary working day', { compensated_workdays: ['2026-05-12'] }, ['compensated_workdays[0]:COMPENSATED_ALREADY_WORKING']],
      ['a blank legal basis', { legal_basis_ref: '   ' }, ['legal_basis_ref:LEGAL_BASIS_REQUIRED']],
    ])('refuses %s with 422 CALENDAR_INVALID', async (_label, change, expected) => {
      const reply = await draft(AUTHOR, { ...STD_2026, ...change });
      expect(reply.status).toBe(422);
      expect(reply.json.code).toBe('CALENDAR_INVALID');
      expect(fieldsOf(reply)).toEqual(expected);
    });

    it('refuses a body the schema rejects (a missing legal basis, an impossible date, a year outside 2020 to 2100)', async () => {
      const withoutBasis: Record<string, unknown> = { ...STD_2026 };
      delete withoutBasis.legal_basis_ref;
      expect((await draft(AUTHOR, withoutBasis)).status).toBe(400);
      expect((await draft(AUTHOR, { ...STD_2026, year: 2101 })).status).toBeGreaterThanOrEqual(400);
      expect((await draft(AUTHOR, { ...STD_2026, holidays: [{ date: '2026-02-30', name: 'Nowhere' }] })).status).toBe(422);
      expect(await countOf('select count(*) as n from machvon.work_calendar_version')).toBe(0);
    });

    it('numbers the revisions of a calendar year', async () => {
      await draft(AUTHOR);
      const second = await draft(AUTHOR, { ...STD_2026, holidays: [] });
      expect(await countOf('select revision as n from machvon.work_calendar_version where id = $1', [idOf(second)])).toBe(2);
    });

    it('refuses a caller without the permission and a caller who holds it only on a subtree (403, audited as DENIED)', async () => {
      expect((await draft(NOBODY)).status).toBe(403);
      const unitAdmin = await draft(UNIT_ADMIN);
      expect(unitAdmin.status).toBe(403);
      expect(unitAdmin.json.code).toBe('SCOPE_DENIED');
      expect(await countOf("select count(*) as n from machvon.audit_event where outcome = 'DENIED' and action like '%createWorkCalendarVersion%'")).toBeGreaterThanOrEqual(1);
      expect(await countOf('select count(*) as n from machvon.work_calendar_version')).toBe(0);
    });

    it('replays the answer of the same idempotency key without a second draft', async () => {
      const key = `key-${randomUUID()}`;
      const first = await call('/work-calendars', { member: AUTHOR, body: STD_2026, key });
      const again = await call('/work-calendars', { member: AUTHOR, body: STD_2026, key });
      expect(again.status).toBe(201);
      expect(idOf(again)).toBe(idOf(first));
      expect(await countOf('select count(*) as n from machvon.work_calendar_version')).toBe(1);
    });
  });

  describe('publishWorkCalendar', () => {
    it('publishes the calendar and a task created on 29 April 15:00 +07 for 8 working hours falls due on 4 May 15:00 +07 (AC-ST-ADM-010-1)', async () => {
      const calendarId = idOf(await draft(AUTHOR));
      const published = await publish(PUBLISHER, calendarId);
      expect(published.status).toBe(200);
      expect(published.json).toMatchObject({ status: 'PUBLISHED', resource_version: 2 });
      expect(await dueIn('2026-04-29T15:00:00+07:00', 8)).toBe(new Date('2026-05-04T15:00:00+07:00').toISOString());
      expect(await countOf("select count(*) as n from machvon.outbox_event where type = 'adm.work_calendar.published.v1' and aggregate_id = $1", [calendarId])).toBe(1);
      expect(await countOf("select count(*) as n from machvon.audit_event where action = 'work_calendar.publish' and resource_id = $1", [calendarId])).toBe(1);
    });

    it('lets the author publish: the calendar has no maker-checker rule (BR-ADM-01 does not list it)', async () => {
      const calendarId = idOf(await draft(AUTHOR));
      expect((await publish(AUTHOR, calendarId)).status).toBe(200);
    });

    it('changes the deadlines counted after the next publication only: the version in force is superseded and a deadline already stored does not move', async () => {
      const first = idOf(await draft(AUTHOR));
      await publish(PUBLISHER, first);
      const alreadyCounted = await dueIn('2026-04-29T15:00:00+07:00', 8);
      const second = idOf(await draft(AUTHOR, { ...STD_2026, holidays: [] }));
      await publish(PUBLISHER, second);
      expect(await countOf("select count(*) as n from machvon.work_calendar_version where status = 'Published'")).toBe(1);
      expect(await countOf("select count(*) as n from machvon.work_calendar_version where id = $1 and status = 'Superseded'", [first])).toBe(1);
      expect(await dueIn('2026-04-29T15:00:00+07:00', 8)).toBe(new Date('2026-04-30T15:00:00+07:00').toISOString());
      expect(alreadyCounted).toBe(new Date('2026-05-04T15:00:00+07:00').toISOString());
    });

    it('refuses to publish an older draft over a newer revision in force: the holidays of the newer one are not silently taken back', async () => {
      const older = idOf(await draft(AUTHOR));
      const newer = idOf(await draft(AUTHOR, { ...STD_2026, holidays: [] }));
      expect((await publish(PUBLISHER, newer)).status).toBe(200);
      const stale = await publish(PUBLISHER, older);
      expect([stale.status, stale.json.code]).toEqual([409, 'STAGE_TRANSITION_DENIED']);
      expect(await countOf("select count(*) as n from machvon.work_calendar_version where id = $1 and status = 'Draft'", [older])).toBe(1);
      expect(await countOf("select count(*) as n from machvon.work_calendar_version where id = $1 and status = 'Published'", [newer])).toBe(1);
      // A draft numbered after the revision in force still replaces it.
      const latest = idOf(await draft(AUTHOR));
      expect((await publish(PUBLISHER, latest)).status).toBe(200);
      expect(await countOf("select count(*) as n from machvon.work_calendar_version where id = $1 and status = 'Superseded'", [newer])).toBe(1);
    });

    it('answers 409 for a calendar already published and for a stale version, 404 for an unknown calendar, 428 without a version', async () => {
      const calendarId = idOf(await draft(AUTHOR));
      const stale = await publish(PUBLISHER, calendarId, '"7"');
      expect(stale.status).toBe(409);
      expect(stale.json.code).toBe('VERSION_CONFLICT');
      expect((await publish(PUBLISHER, calendarId)).status).toBe(200);
      const again = await publish(PUBLISHER, calendarId, '"2"');
      expect(again.status).toBe(409);
      expect(again.json.code).toBe('STAGE_TRANSITION_DENIED');
      expect((await publish(PUBLISHER, randomUUID())).status).toBe(404);
      expect((await call(`/work-calendars/${calendarId}/publish`, { member: PUBLISHER, body: { reason: 'The notice of the year is signed' } })).status).toBe(428);
    });

    it('refuses a caller without the permission on the whole tenant, and leaves the draft', async () => {
      const calendarId = idOf(await draft(AUTHOR));
      for (const member of [NOBODY, UNIT_ADMIN]) expect((await publish(member, calendarId)).status).toBe(403);
      expect(await countOf("select count(*) as n from machvon.work_calendar_version where status = 'Published'")).toBe(0);
    });
  });

  describe('the reads', () => {
    it('lists the versions newest year first with the content of each, and reads one by its id', async () => {
      const first = idOf(await draft(AUTHOR, { ...STD_2026, compensated_workdays: ['2026-05-09'] }));
      await publish(PUBLISHER, first);
      const second = idOf(await draft(AUTHOR, { ...STD_2026, year: 2027, compensated_workdays: [], holidays: [{ date: '2027-01-01', name: 'New Year' }] }));
      const page = await read('/resources/work_calendar_version', READER);
      expect(page.status).toBe(200);
      const items = page.json.items as Array<Record<string, unknown>>;
      expect(items.map((item) => item.id)).toEqual([second, first]);
      expect(items[1]).toEqual({
        id: first,
        calendar_code: 'VN-STD',
        year: 2026,
        revision: 1,
        working_days: [1, 2, 3, 4, 5],
        holidays: STD_2026.holidays,
        compensated_workdays: ['2026-05-09'],
        legal_basis_ref: STD_2026.legal_basis_ref,
        status: 'Published',
        created_by: memberId(AUTHOR),
        published_by: memberId(PUBLISHER),
        published_at: expect.any(String),
        version: 2,
      });
      expect(items[0]).toMatchObject({ status: 'Draft', published_by: null, published_at: null, version: 1 });
      expect((await read(`/resources/work_calendar_version/${first}`, READER)).json).toMatchObject({ id: first, status: 'Published' });
    });

    it('pages with a cursor', async () => {
      const ids = [idOf(await draft(AUTHOR)), idOf(await draft(AUTHOR)), idOf(await draft(AUTHOR, { ...STD_2026, year: 2027, holidays: [], compensated_workdays: [] }))];
      const page = await read('/resources/work_calendar_version?limit=2', READER);
      expect((page.json.items as Array<Record<string, unknown>>).map((item) => item.id)).toEqual([ids[2], ids[1]]);
      const rest = await read(`/resources/work_calendar_version?limit=2&cursor=${encodeURIComponent(page.json.next_cursor as string)}`, READER);
      expect((rest.json.items as Array<Record<string, unknown>>).map((item) => item.id)).toEqual([ids[0]]);
      expect(rest.json.next_cursor).toBeNull();
      expect((await read('/resources/work_calendar_version?cursor=nonsense', READER)).status).toBe(422);
    });

    it('shows nothing to a reader of a subtree only, 404 for one version, and refuses a caller without the permission', async () => {
      const id = idOf(await draft(AUTHOR));
      expect((await read('/resources/work_calendar_version', UNIT_READER)).json.items).toEqual([]);
      expect((await read(`/resources/work_calendar_version/${id}`, UNIT_READER)).status).toBe(404);
      expect((await read(`/resources/work_calendar_version/${randomUUID()}`, READER)).status).toBe(404);
      expect((await read('/resources/work_calendar_version', NOBODY)).status).toBe(403);
      expect((await read(`/resources/work_calendar_version/${id}`, NOBODY)).status).toBe(403);
    });
  });
});
