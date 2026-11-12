import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { monthlyPeriods } from '@machvon/kernel';
import type { CalendarDefinition } from '@machvon/kernel';
import { DisPeriodStore } from '../src/dis-period-store';
import { BASELINE_PACK, applyBaseline, sealPack } from '../src/master-baseline';
import type { BaselineEntry } from '../src/master-baseline';
import { runCalendarReminders } from '../src/reporting-calendar-reminders';
import { ReportingCalendarStore, WHOLE_TENANT } from '../src/reporting-calendar-store';
import { ReportingScheduleReader } from '../src/reporting-schedule-reader';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const periods = new DisPeriodStore();
const calendar = new ReportingCalendarStore();
const schedules = new ReportingScheduleReader();
const ACTOR = 1;
const APPROVER = 2;
const WORKER = '00000000-0000-4000-8000-000000000000';
const AREA = '00000000-0000-4000-8000-0000000000f1';
const PLAN = '00000000-0000-4000-8000-0000000000f2';
const projectId = (n: number): string => `00000000-0000-4000-8000-00000000020${n}`;
const calendarEntry = BASELINE_PACK.entries.find((entry) => entry.masterType === 'CALENDAR') as BaselineEntry;
const CALENDAR: CalendarDefinition = { weekStartsOn: 'SATURDAY', deadlineWeekday: 'FRIDAY', deadlineTime: '10:00', timezone: 'Asia/Ho_Chi_Minh' };

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(ACTOR)), work);
const asWorker = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant({ tenantId: tenant, membershipId: WORKER, scopeVersion: 0 }, work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
const generate = (fiscalYear: number, periodType: 'MONTH' | 'QUARTER' | 'YEAR', now: string) =>
  as((tx) => periods.generate(tx, { calendarCode: 'DEFAULT', fiscalYear, periodType }, memberId(ACTOR), new Date(now)));

async function seedReplica(statements: Array<[string, unknown[]]>): Promise<void> {
  const client = new Client({ connectionString: harness.database.adminUrl });
  await client.connect();
  try {
    // The tables this story only reads (projects, reports) are seeded with the foreign keys they have to other modules switched off.
    await client.query('set session_replication_role = replica');
    for (const [sql, params] of statements) await client.query(sql, params);
  } finally {
    await client.end();
  }
}

describe('the reporting calendar: schedule rule, periods of every kind, board facts and reminders (QT.02, ENT-4c)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: 1, path: '/u1/' },
        { n: 2, path: '/u1/u2/', parent: 1 },
        { n: 3, path: '/u1/u3/', parent: 1 },
      ]);
      await harness.seedMembership(tenant, ACTOR, 1);
      await harness.seedMembership(tenant, APPROVER, 1);
    }
    await asWorker((tx) => applyBaseline(tx, sealPack('CAL-A-1', [calendarEntry]), WORKER));
    await seedReplica([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, 'PRJ-1', 'Bridge', $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B'), ($1, $3, 'PRJ-2', 'Road', $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B'), ($1, $4, 'PRJ-3', 'Port', $7, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId(1), projectId(2), projectId(3), unitId(2), AREA, unitId(3)],
      ],
    ]);
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  it('reads the built-in schedule when the tenant approved no rule, and says it is not confirmed', async () => {
    const monthly = await as((tx) => schedules.get(tx, 'MONTH', '2027-06-01'));
    expect(monthly).toMatchObject({ code: 'MONTH', version: 0, source: 'DEFAULT', unverified: true });
    expect(monthly.policy.steps.map((step) => step.offsetDays)).toEqual([5, 7, 10, 12, 15]);
  });

  it('generates the months with the deadline the constant gave, then the quarters and the year from the schedule', async () => {
    const months = await generate(2027, 'MONTH', '2027-01-01T00:00:00Z');
    expect(months.periods).toHaveLength(12);
    expect(months.periods.map((period) => period.deadlineAt)).toEqual(monthlyPeriods(CALENDAR, 2027).map((period) => period.deadlineAt));
    expect(months.periods[8]?.deadlineAt).toBe('2027-10-05T03:00:00.000Z');
    const quarters = await generate(2027, 'QUARTER', '2027-01-01T00:00:00Z');
    expect(quarters.periods.map((period) => period.code)).toEqual(['Q2027-1', 'Q2027-2', 'Q2027-3', 'Q2027-4']);
    expect(quarters.periods[0]?.deadlineAt).toBe('2027-04-10T03:00:00.000Z');
    const year = await generate(2027, 'YEAR', '2027-01-01T00:00:00Z');
    expect(year.periods[0]).toMatchObject({ code: 'Y2027', deadlineAt: '2028-01-20T03:00:00.000Z' });
    expect((await as((tx) => calendar.periods(tx, [2027]))).map((period) => period.periodType)).toContain('QUARTER');
  });

  it('judges a report on a month by the deadline the period was generated with', async () => {
    const [september] = await owner<{ id: string }>(`select id from machvon.reporting_period where code = 'M2027-09'`);
    const judged = await as((tx) => periods.judge(tx, (september as { id: string }).id, projectId(1), new Date('2027-10-05T03:00:01Z')));
    expect(judged).toMatchObject({ late: true, deadlineAt: '2027-10-05T03:00:00.000Z' });
    expect((await as((tx) => periods.judge(tx, (september as { id: string }).id, projectId(1), new Date('2027-10-05T03:00:00Z')))).late).toBe(false);
  });

  it('moves the deadline of the periods generated after an approved rule and none that exist', async () => {
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.governance_rule (tenant_id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at)
         values ($1, 'REPORTING_SCHEDULE', 'MONTH', 1, 'APPROVED', $2::jsonb, '2028-01-01', 'Deadline moved by the planning board', $3, $3, now(), $4, now())`,
        [
          TENANT_A,
          JSON.stringify({
            steps: [{ kind: 'ENTRY', offset_days: 8 }, { kind: 'UNIT_APPROVAL', offset_days: 9 }, { kind: 'PLANNING_REVIEW', offset_days: 11 }, { kind: 'PERIOD_CLOSE', offset_days: 13 }, { kind: 'PUSH', offset_days: 15, time: '16:00' }],
            reminder_days_before: [2],
            overdue_repeat_days: 2,
            overdue_max_reminders: 3,
            escalate_after_overdue_days: 0,
          }),
          memberId(ACTOR),
          memberId(APPROVER),
        ],
      ],
    ]);
    expect(await as((tx) => schedules.get(tx, 'MONTH', '2027-12-31'))).toMatchObject({ version: 0, source: 'DEFAULT' });
    expect(await as((tx) => schedules.get(tx, 'MONTH', '2028-01-01'))).toMatchObject({ version: 1, source: 'RULE', unverified: false });
    const generated = await generate(2028, 'MONTH', '2028-01-02T00:00:00Z');
    expect(generated.periods[8]?.deadlineAt).toBe('2028-10-08T03:00:00.000Z');
    const [old] = await owner<{ deadline_at: string }>(`select to_char(deadline_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as deadline_at from machvon.reporting_period where code = 'M2027-09'`);
    expect(old?.deadline_at).toBe('2027-10-05T03:00:00.000Z');
  });

  it('counts the projects of each unit that handed figures in and had them approved', async () => {
    const [september] = await owner<{ id: string }>(`select id from machvon.reporting_period where code = 'M2027-09'`);
    const period = (await as((tx) => calendar.period(tx, (september as { id: string }).id))) as NonNullable<Awaited<ReturnType<ReportingCalendarStore['period']>>>;
    expect((await as((tx) => calendar.unitFacts(tx, WHOLE_TENANT, period))).map((unit) => [unit.unitId, unit.projects, unit.entered, unit.approved])).toEqual([
      [unitId(2), 2, 0, 0],
      [unitId(3), 1, 0, 0],
    ]);
    await seedReplica([
      [
        `insert into machvon.report_revision (tenant_id, id, project_id, period_id, plan_version_id, revision, status, is_current, version, submitted_at, accepted_at, payload_hash, submitted_by, accepted_by)
         values ($1, $2, $3, $4, $5, 1, 'ACCEPTED', true, 1, '2027-10-01T01:00:00Z', '2027-10-02T01:00:00Z', repeat('a', 64), $10, $11), ($1, $6, $7, $4, $5, 1, 'SUBMITTED', false, 1, '2027-10-01T02:00:00Z', null, repeat('b', 64), $10, null), ($1, $8, $9, $4, $5, 1, 'DRAFT', false, 1, null, null, repeat('c', 64), null, null)`,
        [TENANT_A, randomUUID(), projectId(1), period.id, PLAN, randomUUID(), projectId(3), randomUUID(), projectId(2), memberId(ACTOR), memberId(APPROVER)],
      ],
    ]);
    expect((await as((tx) => calendar.unitFacts(tx, WHOLE_TENANT, period))).map((unit) => [unit.unitId, unit.projects, unit.entered, unit.approved, unit.enteredAt, unit.approvedAt])).toEqual([
      [unitId(2), 2, 1, 1, '2027-10-01T01:00:00.000Z', '2027-10-02T01:00:00.000Z'],
      [unitId(3), 1, 1, 0, '2027-10-01T02:00:00.000Z', null],
    ]);
  });

  it('reads the review of the planning board and the push from the staged approval chain of the reports of the period, and nothing where no chain runs', async () => {
    const [september] = await owner<{ id: string }>(`select id from machvon.reporting_period where code = 'M2027-09'`);
    const period = (await as((tx) => calendar.period(tx, (september as { id: string }).id))) as NonNullable<Awaited<ReturnType<ReportingCalendarStore['period']>>>;
    // No instance yet: a single decision tenant has no chain, so the platform has no fact about the two steps.
    expect(await as((tx) => calendar.chainFacts(tx, WHOLE_TENANT, period))).toEqual({});

    const reports = await owner<{ id: string; project_id: string }>(`select id, project_id from machvon.report_revision where period_id = $1 and status <> 'DRAFT' order by project_id`, [period.id]);
    const reportOf = (project: string): string => (reports.find((report) => report.project_id === project) as { id: string }).id;
    const definition = { steps: ['UNIT_APPROVER', 'PLANNING_REVIEW', 'PERIOD_CLOSE', 'PUSH'].map((tag) => ({ id: tag.toLowerCase(), tag })), terminal: {} };
    const versionId = randomUUID();
    const instance = (resource: string, status: string, outcome: string | null, step: number, endedAt: string | null): { id: string; sql: [string, unknown[]] } => {
      const id = randomUUID();
      return {
        id,
        sql: [
          `insert into machvon.workflow_instance (tenant_id, id, workflow_version_id, resource_type, resource_id, resource_version, status, started_at, temporal_workflow_id, initiator_membership_id, initiator_user_id, document_type, unit_id, outcome, ended_at, current_step, business_type)
           values ($1, $2::uuid, $3, 'report_revision', $4, 1, $5, '2027-10-01T01:00:00Z', $2::uuid::text, $6, $6, 'REPORT', $7, $8, $9::timestamptz, $10, 'report.accept')`,
          [TENANT_A, id, versionId, resource, status, memberId(ACTOR), unitId(2), outcome, endedAt, step],
        ],
      };
    };
    const task = (instanceId: string, step: number, decidedAt: string | null): [string, unknown[]] => [
      `insert into machvon.approval_task (tenant_id, id, workflow_instance_id, assignee_id, due_at, step_id, step_index, status, decision, decided_at, decided_by)
       values ($1, gen_random_uuid(), $2, $3, '2027-10-20T00:00:00Z', 'x', $4, $5, $6, $7::timestamptz, $8)`,
      [TENANT_A, instanceId, memberId(APPROVER), step, decidedAt === null ? 'Pending' : 'Decided', decidedAt === null ? null : 'approve', decidedAt, decidedAt === null ? null : memberId(APPROVER)],
    ];
    const finished = instance(reportOf(projectId(1)), 'Completed', 'APPROVED', 3, '2027-10-06T03:00:00Z');
    const running = instance(reportOf(projectId(3)), 'Running', null, 1, null);
    await seedReplica([
      [
        `insert into machvon.workflow_version (tenant_id, id, business_type, revision, definition_json, status, kind, created_by, definition_hash) values ($1, $2, 'report.accept', 1, $3::jsonb, 'Published', 'APPROVAL', $4, repeat('e', 64))`,
        [TENANT_A, versionId, JSON.stringify(definition), memberId(ACTOR)],
      ],
      finished.sql,
      task(finished.id, 1, '2027-10-04T02:00:00Z'),
      task(finished.id, 3, '2027-10-06T03:00:00Z'),
      running.sql,
      task(running.id, 1, null),
    ]);
    // One report went through every step, the other waits at the review: the review is open and the push as well, nothing is shown done.
    expect(await as((tx) => calendar.chainFacts(tx, WHOLE_TENANT, period))).toEqual({ planningReviewAt: null, pushedAt: null });
    // Seen only through the project that finished, the two steps are done at the instant of the last decision.
    const onlyFirst = (first: number) => ({ sql: `p.id = $${first}::uuid`, params: [projectId(1)] });
    expect(await as((tx) => calendar.chainFacts(tx, onlyFirst, period))).toEqual({ planningReviewAt: '2027-10-04T02:00:00.000Z', pushedAt: '2027-10-06T03:00:00.000Z' });
    // The second report passes the review: the review of the period is done at the later instant; the push still waits for the receipt.
    await seedReplica([
      [`update machvon.workflow_instance set current_step = 2 where id = $1`, [running.id]],
      [`update machvon.approval_task set status = 'Decided', decision = 'approve', decided_at = '2027-10-07T01:00:00Z', decided_by = $2 where workflow_instance_id = $1 and step_index = 1`, [running.id, memberId(APPROVER)]],
    ]);
    expect(await as((tx) => calendar.chainFacts(tx, WHOLE_TENANT, period))).toEqual({ planningReviewAt: '2027-10-07T01:00:00.000Z', pushedAt: null });
    expect(await as((tx) => calendar.chainFacts(tx, WHOLE_TENANT, period), TENANT_B)).toEqual({});
  });

  it('reminds the unit that has not finished, once, then again after the deadline, and tells the leader once when it is days overdue', async () => {
    const [september] = await owner<{ id: string }>(`select id from machvon.reporting_period where code = 'M2027-09'`);
    const key = (september as { id: string }).id;
    const events = async (): Promise<Array<{ type: string; payload: Record<string, unknown> }>> =>
      owner<{ type: string; payload: Record<string, unknown> }>(`select type, payload from machvon.outbox_event where payload ->> 'item_key' = $1 order by created_at, id`, [key]);
    const run = (now: string) => asWorker((tx) => runCalendarReminders(tx, TENANT_A, new Date(now)));

    // Three days before the entry deadline: the unit with a project that has not handed in is reminded (unit 2 has one of two in); unit 3 is done.
    const before = await run('2027-10-02T04:00:00Z');
    expect(before.reminders).toBeGreaterThanOrEqual(1);
    const first = (await events()).filter((event) => event.payload.step === 'ENTRY');
    expect(first.map((event) => [event.type, event.payload.kind, event.payload.ordinal, event.payload.unit_id])).toEqual([['dis.calendar_step.reminded.v1', 'BEFORE_DUE', 1, unitId(2)]]);
    expect(first[0]?.payload).toMatchObject({ alert_type: 'REPORTING_STEP_DUE_SOON', period_code: 'M2027-09', notification: { resource: { type: 'report', id: key, ownerUnitId: unitId(2), ownerUnitPath: '/u1/u2/' } } });

    // The same pass again records nothing new for the period, and another process at the same moment cannot double it either.
    // (Earlier months that are already overdue are reminded on their own series: a pass sends the escalation first and the overdue reminder on the next one.)
    await run('2027-10-02T04:30:00Z');
    expect((await events()).filter((event) => event.payload.step === 'ENTRY')).toHaveLength(1);

    // After the deadline: the overdue reminder, and three days later the escalation to the leader (its own event type).
    await run('2027-10-05T04:00:00Z');
    await run('2027-10-08T04:00:00Z');
    const ENTRY_KINDS = (await events()).filter((event) => event.payload.step === 'ENTRY').map((event) => [event.type, event.payload.kind, event.payload.ordinal]);
    expect(ENTRY_KINDS).toEqual(expect.arrayContaining([['dis.calendar_step.reminded.v1', 'BEFORE_DUE', 1], ['dis.calendar_step.reminded.v1', 'OVERDUE', 1], ['dis.calendar_step.escalated.v1', 'ESCALATED', 1]]));
    const rows = await owner<{ n: string }>(`select count(*)::text as n from machvon.reporting_reminder where item_key = $1 and unit_id = $2 and step = 'ENTRY'`, [key, unitId(3)]);
    expect(rows[0]?.n).toBe('0');
  });

  it('reminds the steps of the period that the approval chain keeps only while they are open, and sends nothing for a step that is done or has no fact', async () => {
    const [september] = await owner<{ id: string }>(`select id from machvon.reporting_period where code = 'M2027-09'`);
    const key = (september as { id: string }).id;
    const steps = async (): Promise<Array<{ step: unknown; kind: unknown; unit: unknown }>> =>
      (await owner<{ payload: Record<string, unknown> }>(`select payload from machvon.outbox_event where payload ->> 'item_key' = $1 and payload ->> 'step' in ('PLANNING_REVIEW', 'PUSH') order by created_at, id`, [key])).map((row) => ({ step: row.payload.step, kind: row.payload.kind, unit: row.payload.unit_id }));
    // The review passed on the 7th (the chain test above), the push waits for its receipt: only the push is reminded, for the period and not for a unit.
    await asWorker((tx) => runCalendarReminders(tx, TENANT_A, new Date('2027-10-14T04:00:00Z')));
    expect(await steps()).toEqual([{ step: 'PUSH', kind: 'BEFORE_DUE', unit: undefined }]);
    // A period with no report on a chain has no fact for either step, so there is nothing to remind however late it is.
    const [august] = await owner<{ id: string }>(`select id from machvon.reporting_period where code = 'M2027-08'`);
    expect(await owner(`select 1 from machvon.outbox_event where payload ->> 'item_key' = $1 and payload ->> 'step' in ('PLANNING_REVIEW', 'PUSH')`, [(august as { id: string }).id])).toEqual([]);
  });

  it('keeps the tenants apart', async () => {
    expect(await as((tx) => calendar.periods(tx, [2027]), TENANT_B)).toEqual([]);
    expect(await owner<{ n: string }>('select count(*)::text as n from machvon.reporting_reminder', [], TENANT_B)).toEqual([{ n: '0' }]);
  });
});
