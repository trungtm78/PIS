import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { MyWorkController } from '../../src/modules/home/my-work.controller';
import { runWorkReminders } from '../../src/modules/home/work-reminder.job';
import { PwfDeadlineReadsController } from '../../src/modules/pwf/deadline.controller';
import { PwfPreferenceController } from '../../src/modules/pwf/preference.controller';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedRow } from '../../../../packages/db/test/support/seed-rows';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(300_000);

const SIGNING_KEY = randomBytes(32);
const NOW = new Date();
const TODAY = vietnamDateOf(NOW);
const YEAR = Number(TODAY.slice(0, 4));
const MANAGER = 1; // reads the portfolio and the work of the whole tenant
const WORKER = 2; // does tasks, sets their own days
const PEER = 3; // does tasks
const READER = 4; // pwf.read only
const OTHER_TENANT = 1;
const ROOT = 1;
const DEPARTMENT = 2;
const day = (offset: number): string => new Date(Date.parse(`${TODAY}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

/**
 * The tier of the person in the three colours of a deadline over HTTP, the tasks of a workflow in the alert centre, and the reminders at several points (PWF-2, R30, R40): what a person sets changes their own list and reminders, never the official
 * colour, the alert centre or the board of the manager.
 */
describe('the personal deadline preference, my tasks and the reminders of the tasks of a workflow (PWF-2)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let projectId = '';
  let workflowId = '';
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

  async function seedSql(sql: string, params: unknown[]): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  /** A task due `due` days from today, given to a person by the ledger. */
  async function task(due: number, assignee: number | null = WORKER, status = 'NOT_STARTED'): Promise<string> {
    counter += 1;
    const id = randomUUID();
    await seedSql(
      `insert into machvon.project_task (tenant_id, id, workflow_id, project_id, task_code, name, phase_code, sort_order, kind, required, responsible_role, priority, duration_working_days, status, state, planned_start, planned_finish, baseline_start, baseline_finish, committed_start, committed_finish, schedule_version, actual_start, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, 'P1', $7, 'TASK', true, 'ROLE_A', 'NORMAL', 2, $8, 'SCHEDULED', $9::date, $10::date, $9::date, $10::date, $9::date, $10::date, 1, $11::date, $12, $12)`,
      [TENANT_A, id, workflowId, projectId, `T${String(counter).padStart(4, '0')}`, `Task ${counter}`, counter, status, day(due - 2), day(due), status === 'NOT_STARTED' ? null : day(-5), memberId(MANAGER)],
    );
    if (assignee !== null) {
      await seedSql(`insert into machvon.project_task_assignment (tenant_id, task_id, membership_id, role, valid_from, share_pct, reason, assigned_by) values ($1, $2, $3, 'RESPONSIBLE', $4::date, 100, 'Given by the test', $5)`, [TENANT_A, id, memberId(assignee), day(-60), memberId(MANAGER)]);
    }
    return id;
  }

  const clear = async (): Promise<void> => {
    await seedSql('delete from machvon.work_action', []);
    await rows('delete from machvon.work_reminder');
    await rows('delete from machvon.project_task_reminder');
    await rows('delete from machvon.project_task_assignment');
    await rows('delete from machvon.project_task');
    await rows('delete from machvon.alert_notification_profile');
    await rows('delete from machvon.outbox_event');
  };

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
      ]);
    }
    for (const n of [MANAGER, WORKER, PEER, READER]) await harness.seedMembership(TENANT_A, n, DEPARTMENT);
    await harness.seedMembership(TENANT_B, OTHER_TENANT, ROOT);
    await harness.seedRole(TENANT_A, 1, 'PWF_MANAGER', ['home.read', 'pwf.read', 'pwf.task.work', 'pwf.preference.own'], 40);
    await harness.seedRole(TENANT_A, 2, 'PWF_WORKER', ['home.read', 'pwf.read', 'pwf.task.work', 'pwf.preference.own'], 20);
    await harness.seedRole(TENANT_A, 3, 'PWF_READER', ['pwf.read'], 10);
    await harness.seedRole(TENANT_B, 1, 'PWF_WORKER', ['home.read', 'pwf.read', 'pwf.task.work', 'pwf.preference.own'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MANAGER, role: 1, kind: 'TENANT' },
      { n: 2, member: WORKER, role: 2, kind: 'TENANT' },
      { n: 3, member: PEER, role: 2, kind: 'TENANT' },
      { n: 4, member: READER, role: 3, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT, role: 1, kind: 'TENANT' }]);
    // Every day is a working day, so that the days left of a task are the days of the calendar.
    await rows(
      `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
       select $1, gen_random_uuid(), 'WORKDAY_VN', y, 1, '[1,2,3,4,5,6,7]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019', 'Published', $2, $2, now() from generate_series($3::int, $4::int) y`,
      [TENANT_A, memberId(MANAGER), YEAR - 1, YEAR + 2],
    );
    projectId = randomUUID();
    workflowId = randomUUID();
    await seedSql(
      `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group, planned_start_date)
       values ($1, $2, 'PRJ-PREF', 'Preference project', $3, $4, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B', date '${YEAR}-01-05')`,
      [TENANT_A, projectId, unitId(DEPARTMENT), randomUUID()],
    );
    await seedSql(
      `insert into machvon.project_workflow (tenant_id, id, project_id, template_code, template_rule_version, template_hash, template, planned_start_date, schedule_version, created_by, updated_by)
       values ($1, $2, $3, 'PREF', 0, repeat('a', 64), '{}'::jsonb, date '${YEAR}-01-05', 1, $4, $4)`,
      [TENANT_A, workflowId, projectId, memberId(MANAGER)],
    );
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [PwfPreferenceController, PwfDeadlineReadsController, MyWorkController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  beforeEach(clear);

  describe('getDeadlinePreference and setDeadlinePreference', () => {
    const SAVED = { green_days: 7, yellow_days: 3, red_days: 1, reminder_days: [7, 3] };

    it('reads the official ladder when nothing is saved, saves a ladder that is earlier under the version the person read, and keeps it', async () => {
      const first = await call('GET', '/me/deadline-preference', { member: WORKER });
      expect(first).toMatchObject({ status: 200, json: { green_days: null, yellow_days: null, red_days: null, reminder_days: [], official: { green_days: 5, yellow_days: 2, red_days: 0 }, clamped: [], version: 0 } });
      const saved = await call('PUT', '/me/deadline-preference', { member: WORKER, ifMatch: '"0"', body: SAVED });
      expect(saved).toMatchObject({ status: 200, json: { resource_version: 1 } });
      expect(await call('GET', '/me/deadline-preference', { member: WORKER })).toMatchObject({ json: { ...SAVED, version: 1 } });
      // The audit and the event keep days only, in the row of the person.
      const [audit] = await rows<{ diff: Record<string, unknown>; classification: string }>(`select safe_diff as diff, classification from machvon.audit_event where action = 'pwf.deadline_preference_set' and resource_id = $1`, [memberId(WORKER)]);
      expect(audit).toMatchObject({ classification: 'PERSONAL', diff: { green_days: 7, yellow_days: 3, red_days: 1, reminder_days: [7, 3], cleared: false, version: 1 } });
      expect((await rows(`select 1 from machvon.outbox_event where type = 'pwf.deadline_preference.set.v1' and aggregate_id = $1`, [memberId(WORKER)])).length).toBe(1);
    });

    it('UAT-PWF-NEG-06: refuses a level that starts later than the official one and one that breaks the order, naming the field', async () => {
      const later = await call('PUT', '/me/deadline-preference', { member: WORKER, ifMatch: '"0"', body: { green_days: 4, yellow_days: null, red_days: null, reminder_days: [] } });
      expect([later.status, later.json.code]).toEqual([422, 'DEADLINE_PERSONAL_NOT_EARLIER']);
      expect(JSON.stringify(later.json)).toContain('green_days');
      const disordered = await call('PUT', '/me/deadline-preference', { member: WORKER, ifMatch: '"0"', body: { green_days: null, yellow_days: 6, red_days: null, reminder_days: [] } });
      expect([disordered.status, disordered.json.code]).toEqual([422, 'DEADLINE_BAND_THRESHOLDS_INVALID']);
      const fraction = await call('PUT', '/me/deadline-preference', { member: WORKER, ifMatch: '"0"', body: { green_days: 7.5, yellow_days: null, red_days: null, reminder_days: [] } });
      // Not whole days: the contract refuses it before it reaches the rule.
      expect(fraction.status).toBe(400);
      const reminders = await call('PUT', '/me/deadline-preference', { member: WORKER, ifMatch: '"0"', body: { green_days: null, yellow_days: null, red_days: null, reminder_days: [2, 3] } });
      expect([reminders.status, reminders.json.code]).toEqual([422, 'DEADLINE_BAND_THRESHOLDS_INVALID']);
      expect((await call('GET', '/me/deadline-preference', { member: WORKER })).json.version).toBe(0);
    });

    it('is refused when the version is stale, answers the same to the same key, and clears to the official ladder', async () => {
      expect((await call('PUT', '/me/deadline-preference', { member: WORKER, ifMatch: '"0"', body: SAVED })).status).toBe(200);
      const stale = await call('PUT', '/me/deadline-preference', { member: WORKER, ifMatch: '"0"', body: { ...SAVED, green_days: 8 } });
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const key = 'clear-the-preference-with-this-key';
      const cleared = await call('PUT', '/me/deadline-preference', { member: WORKER, ifMatch: '"1"', key, body: { green_days: null, yellow_days: null, red_days: null, reminder_days: [] } });
      expect(cleared).toMatchObject({ status: 200, json: { resource_version: 2 } });
      expect(await call('PUT', '/me/deadline-preference', { member: WORKER, ifMatch: '"1"', key, body: { green_days: null, yellow_days: null, red_days: null, reminder_days: [] } })).toEqual(cleared);
      expect(await call('GET', '/me/deadline-preference', { member: WORKER })).toMatchObject({ json: { green_days: null, reminder_days: [], version: 2 } });
    });

    it('is the preference of the person only: another person, another tenant and a person without the permission do not see or change it', async () => {
      await call('PUT', '/me/deadline-preference', { member: WORKER, ifMatch: '"0"', body: SAVED });
      expect(await call('GET', '/me/deadline-preference', { member: PEER })).toMatchObject({ json: { green_days: null, version: 0 } });
      expect(await call('GET', '/me/deadline-preference', { member: OTHER_TENANT, tenantId: TENANT_B })).toMatchObject({ json: { green_days: null, version: 0 } });
      expect((await call('GET', '/me/deadline-preference', { member: READER })).status).toBe(403);
      expect((await call('PUT', '/me/deadline-preference', { member: READER, ifMatch: '"0"', body: SAVED })).status).toBe(403);
      expect((await rows('select count(*)::int as n from machvon.alert_notification_profile where deadline_green_days is not null'))[0]).toEqual({ n: 1 });
    });
  });

  describe('previewDeadlineBand', () => {
    it('says what a ladder does at the days that matter ("5 days: green, 2 days: yellow, under 1 day: red") and refuses one that is not ordered', async () => {
      const preview = await call('GET', '/pwf/deadline-band/preview?yellow_days=2&red_days=0&green_days=5&unit=WORKING&remaining_days=9', { member: READER });
      expect(preview.status).toBe(200);
      expect(preview.json).toMatchObject({ unit: 'WORKING', thresholds: { green_days: 5, yellow_days: 2, red_days: 0 } });
      const bands = Object.fromEntries((preview.json.examples as Array<{ remaining_days: number; band: string }>).map((one) => [one.remaining_days, one.band]));
      expect(bands).toMatchObject({ 9: 'NONE', 6: 'NONE', 5: 'GREEN', 3: 'GREEN', 2: 'YELLOW', 1: 'YELLOW', 0: 'RED', '-1': 'RED' });
      const bad = await call('GET', '/pwf/deadline-band/preview?yellow_days=2&red_days=2', { member: READER });
      expect([bad.status, bad.json.code]).toEqual([422, 'DEADLINE_BAND_THRESHOLDS_INVALID']);
      expect((await call('GET', '/pwf/deadline-band/preview?yellow_days=x&red_days=0', { member: READER })).status).toBe(422);
    });
  });

  describe('getMyTasks and the alert centre: the official colour is the same for everybody, the personal colour is the person\'s own', () => {
    it('lists my tasks with the official colour and the real day, and with the colour of my own ladder only when I set one; the others never see mine', async () => {
      await task(6);
      await task(3);
      await task(0);
      await task(2, PEER);
      const plain = await call('GET', '/me/project-tasks', { member: WORKER });
      expect(plain.status).toBe(200);
      const items = plain.json.items as Array<{ due_date: string; official_band: { band: string }; personal_band: { band: string } | null }>;
      expect(plain.json.total).toBe(3);
      // The block "tasks by deadline" of a home screen reads the same operation with a small page: the counts by official colour are exact whatever the page.
      expect((await call('GET', '/me/project-tasks?limit=1', { member: WORKER })).json).toMatchObject({ total: 3, counts_by_band: { RED: 1, YELLOW: 0, GREEN: 1, NONE: 1, UNKNOWN: 0 }, overdue_count: 0 });
      expect(items.map((one) => [one.due_date, one.official_band.band, one.personal_band])).toEqual([[day(0), 'RED', null], [day(3), 'GREEN', null], [day(6), 'NONE', null]]);
      await call('PUT', '/me/deadline-preference', { member: WORKER, ifMatch: '"0"', body: { green_days: 8, yellow_days: 4, red_days: 1, reminder_days: [] } });
      const mine = (await call('GET', '/me/project-tasks', { member: WORKER })).json.items as Array<{ due_date: string; official_band: { band: string }; personal_band: { band: string } | null }>;
      expect(mine.map((one) => [one.due_date, one.official_band.band, one.personal_band?.band])).toEqual([[day(0), 'RED', 'RED'], [day(3), 'GREEN', 'YELLOW'], [day(6), 'NONE', 'GREEN']]);
      // The peer, the manager and the portfolio board have the official colour only, with no sign of the setting of somebody else.
      const peers = (await call('GET', '/me/project-tasks', { member: PEER })).json.items as Array<{ personal_band: unknown }>;
      expect(peers).toHaveLength(1);
      expect(peers.every((one) => one.personal_band === null)).toBe(true);
      const portfolio = await call('GET', '/pwf/deadlines', { member: MANAGER });
      expect(portfolio.status).toBe(200);
      expect(portfolio.json).toMatchObject({ official_only: true, total: 4 });
      expect(JSON.stringify(portfolio.json)).not.toContain('personal');
      expect((await call('GET', '/me/project-tasks?band=PURPLE', { member: WORKER })).status).toBe(422);
      expect((await call('GET', '/me/project-tasks', { member: READER })).status).toBe(403);
    });

    it('puts the tasks in the alert centre by the official colour, and a personal ladder changes nothing of it', async () => {
      await task(5);
      await task(2);
      await task(0);
      await task(-1);
      await task(-4);
      await task(7);
      type Item = { kind: string; severity: string; source: string; due_on: string; id: string; title: string; consequence: string | null };
      // What the alert centre says, without the moment each answer was made.
      const mineOf = async (member: number): Promise<Item[]> => {
        const reply = await call('GET', '/home/my-work', { member });
        expect(reply.status).toBe(200);
        return (reply.json.items as Item[]).filter((one) => one.source === 'PROJECT_TASK').map((one) => ({ kind: one.kind, severity: one.severity, source: one.source, due_on: one.due_on, id: one.id, title: one.title, consequence: one.consequence }));
      };
      const before = await mineOf(WORKER);
      expect(before.map((one) => [one.kind, one.severity, one.due_on])).toEqual([
        ['PWF_TASK_OVERDUE', 'URGENT', day(-4)],
        ['PWF_TASK_OVERDUE', 'ACTION', day(-1)],
        ['PWF_TASK_DUE_SOON', 'ACTION', day(0)],
        ['PWF_TASK_DUE_SOON', 'WATCH', day(2)],
        ['PWF_TASK_DUE_SOON', 'WATCH', day(5)],
      ]);
      expect(await mineOf(PEER)).toEqual([]);
      // A person who warns themselves earlier sees the same alert centre; the official escalation and severity are not theirs to move.
      await call('PUT', '/me/deadline-preference', { member: WORKER, ifMatch: '"0"', body: { green_days: 9, yellow_days: 5, red_days: 2, reminder_days: [9] } });
      expect(await mineOf(WORKER)).toEqual(before);
      const counts = (await call('GET', '/home/my-work', { member: WORKER })).json.counts as Record<string, number>;
      expect(counts).toMatchObject({ PWF_TASK_OVERDUE: 2, PWF_TASK_DUE_SOON: 3 });
    });

    it('UAT-PWF-IDM-03: leaves the list by itself when a task is done, paused or cancelled, and moves to one item when it is rescheduled', async () => {
      const id = await task(1);
      const ids = async (): Promise<string[]> => ((await call('GET', '/home/my-work', { member: WORKER })).json.items as Array<{ id: string; source: string }>).filter((one) => one.source === 'PROJECT_TASK').map((one) => one.id);
      expect(await ids()).toEqual([`${id}:1`]);
      await rows(`update machvon.project_task set planned_finish = $2::date, planned_start = $2::date, committed_finish = $2::date, committed_start = $2::date, schedule_version = 2 where id = $1::uuid`, [id, day(2)]);
      expect(await ids()).toEqual([`${id}:2`]);
      await rows(`update machvon.project_task set status = 'ON_HOLD', actual_start = $2::date where id = $1::uuid`, [id, day(-3)]);
      expect(await ids()).toEqual([]);
      await rows(`update machvon.project_task set status = 'IN_PROGRESS' where id = $1::uuid`, [id]);
      expect(await ids()).toEqual([`${id}:2`]);
      await rows(`update machvon.project_task set status = 'DONE', actual_finish = $2::date where id = $1::uuid`, [id, day(0)]);
      expect(await ids()).toEqual([]);
    });
  });

  describe('the reminders at several points', () => {
    const run = (at: Date = NOW): ReturnType<typeof runWorkReminders> => runWorkReminders(harness.tenants as TenantDatabase, { tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 1 }, at);
    const later = (days: number): Date => new Date(NOW.getTime() + days * 86_400_000);
    const reminderRows = (): Promise<Array<{ series_key: string; recipient_membership_id: string; severity: string; ordinal: number; source: string }>> =>
      rows('select series_key, recipient_membership_id, severity, ordinal, source from machvon.work_reminder where source = \'PROJECT_TASK\' order by created_at, series_key');

    it('UAT-PWF-IDM-02: reminds the person of a task at each point of the rule once, in the same transaction as the key of the point, and a replay of the job makes none', async () => {
      const id = await task(5);
      const first = await run();
      expect(first).toMatchObject({ pointReminders: 1, pointsFailed: false, failed: 0 });
      expect(await reminderRows()).toEqual([{ series_key: `REMINDER:PROJECT_TASK:${id}:1:${memberId(WORKER)}:D5`, recipient_membership_id: memberId(WORKER), severity: 'WATCH', ordinal: 1, source: 'PROJECT_TASK' }]);
      // The cadence of the severity does not remind the same person of the same task again: the points are its reminders.
      expect(await run()).toMatchObject({ pointReminders: 0 });
      expect(await run(later(0.4))).toMatchObject({ pointReminders: 0 });
      expect((await reminderRows()).length).toBe(1);
      expect((await rows('select count(*)::int as n from machvon.project_task_reminder'))[0]).toEqual({ n: 1 });
      const [event] = await rows<{ payload: Record<string, unknown> }>(`select payload from machvon.outbox_event where type = 'home.work_reminder.v1'`);
      expect(event?.payload).toMatchObject({ source: 'PROJECT_TASK', source_id: `${id}:1`, point: 5, remaining_days: 5, recipient_membership_id: memberId(WORKER), reminder_audience: 'OFFICIAL' });
      expect(JSON.stringify(event?.payload)).not.toContain('Task ');
      // Three days on, the point of 2 days; five days on, the day itself; six, the day after: one reminder each, never two for a point.
      expect(await run(later(3))).toMatchObject({ pointReminders: 1 });
      expect(await run(later(3))).toMatchObject({ pointReminders: 0 });
      expect(await run(later(5))).toMatchObject({ pointReminders: 1 });
      expect(await run(later(6))).toMatchObject({ pointReminders: 1 });
      expect((await reminderRows()).map((one) => [one.series_key.split(':').pop(), one.severity])).toEqual([['D5', 'WATCH'], ['D2', 'WATCH'], ['D0', 'ACTION'], ['D-1', 'ACTION']]);
    });

    it('adds the days a person asked for to that person only, and the official points of the rule do not change with them', async () => {
      await call('PUT', '/me/deadline-preference', { member: WORKER, ifMatch: '"0"', body: { green_days: null, yellow_days: null, red_days: null, reminder_days: [8, 5, 1] } });
      const id = await task(8);
      await task(8, PEER);
      expect(await run()).toMatchObject({ pointReminders: 1 });
      expect((await reminderRows()).map((one) => [one.series_key, one.ordinal])).toEqual([[`REMINDER:PROJECT_TASK:${id}:1:${memberId(WORKER)}:D8`, 101]]);
      expect(await run()).toMatchObject({ pointReminders: 0 });
      // At 5 days the rule's point reaches both people, the person's own 5 is not a second reminder, and their own 1 comes at its day.
      expect(await run(later(3))).toMatchObject({ pointReminders: 2 });
      // At 1 day left the person is told once, of the nearest of the two lists (their own 1), and the other one of the rule's point of 2.
      expect(await run(later(7))).toMatchObject({ pointReminders: 2 });
    });

    it('does not remind a person of a task they put off with a snooze that has not come back, and reminds when it has', async () => {
      const id = await task(5);
      const snoozed = new Date(NOW.getTime() + 36 * 3_600_000).toISOString();
      await seedRow(harness.database.adminUrl, 'work_action', TENANT_A, { source: 'PROJECT_TASK', source_id: `${id}:1`, action: 'SNOOZE', actor_membership_id: memberId(WORKER), snooze_until: snoozed, reason_code: 'WAITING_INFORMATION', snooze_ordinal: 1, snooze_final: false, policy_version: 'builtin', created_at: NOW.toISOString() });
      expect(await run()).toMatchObject({ pointReminders: 0 });
      expect(await reminderRows()).toEqual([]);
      // The point was spent while the item was put off; the next point comes at its day, after the snooze is over.
      expect(await run(later(3))).toMatchObject({ pointReminders: 1 });
    });

    it('does not remind a person who no longer reads the project or is not an active member, and keeps the point for later', async () => {
      const id = await task(5, READER);
      expect(await run()).toMatchObject({ pointReminders: 0 });
      expect((await rows('select count(*)::int as n from machvon.project_task_reminder'))[0]).toEqual({ n: 0 });
      expect(await reminderRows()).toEqual([]);
      await seedSql(`update machvon.project_task_assignment set membership_id = $2 where task_id = $1::uuid`, [id, memberId(WORKER)]);
      await rows(`update machvon.membership set status = 'Suspended' where id = $1::uuid`, [memberId(WORKER)]);
      expect(await run()).toMatchObject({ pointReminders: 0 });
      await rows(`update machvon.membership set status = 'Active' where id = $1::uuid`, [memberId(WORKER)]);
      expect(await run()).toMatchObject({ pointReminders: 1 });
    });

    it('does not remind of a task that is done, on hold or cancelled, and not of a person who is nobody\'s to be told', async () => {
      await task(2, WORKER, 'IN_PROGRESS');
      const quiet = await task(2, WORKER, 'IN_PROGRESS');
      await task(2, null);
      await rows(`update machvon.project_task set status = 'ON_HOLD' where id = $1::uuid`, [quiet]);
      const result = await run();
      expect(result.pointReminders).toBe(1);
      expect((await reminderRows()).length).toBe(1);
    });
  });
});
