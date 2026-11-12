import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { AuditWriter } from '../src/audit-writer';
import { DisPeriodAutoclose } from '../src/dis-period-autoclose';
import { DisPeriodStore } from '../src/dis-period-store';
import { BASELINE_PACK, applyBaseline, sealPack } from '../src/master-baseline';
import type { BaselineEntry } from '../src/master-baseline';
import { SchedulePeriodLockGate } from '../src/period-lock-gate';
import { ReportingCalendarStore } from '../src/reporting-calendar-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, contextFor, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const periods = new DisPeriodStore();
const calendar = new ReportingCalendarStore();
const audit = new AuditWriter(harness.tenants);
const ACTOR = 1;
const APPROVER = 2;
const WORKER = '00000000-0000-4000-8000-000000000000';
const AREA = '00000000-0000-4000-8000-0000000000f1';
const PROJECT = '00000000-0000-4000-8000-000000000301';
const calendarEntry = BASELINE_PACK.entries.find((entry) => entry.masterType === 'CALENDAR') as BaselineEntry;
const at = (instant: string): Date => new Date(instant);

const as = <T>(work: (tx: TenantTx) => Promise<T>): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(ACTOR)), work);
const asWorker = <T>(work: (tx: TenantTx) => Promise<T>): Promise<T> => harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: WORKER, scopeVersion: 0 }, work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

async function seedReplica(statements: Array<[string, unknown[]]>): Promise<void> {
  const client = new Client({ connectionString: harness.database.adminUrl });
  await client.connect();
  try {
    // The staged approval is seeded in the state its engine leaves it in; the foreign keys to the other modules are switched off for this story, which only reads the facts.
    await client.query('set session_replication_role = replica');
    for (const [sql, params] of statements) await client.query(sql, params);
  } finally {
    await client.end();
  }
}

const reset = (): Promise<unknown[]> =>
  harness.owner(TENANT_A, [
    ['delete from machvon.reporting_reminder'],
    ['delete from machvon.period_reopen'],
    ['delete from machvon.approval_task'],
    ['delete from machvon.workflow_instance'],
    ['delete from machvon.ind_entry_batch'],
    ['delete from machvon.reporting_period'],
  ]);
const generateMonths = (): Promise<unknown> => as((tx) => periods.generate(tx, { calendarCode: 'DEFAULT', fiscalYear: 2027, periodType: 'MONTH' }, memberId(ACTOR), at('2027-01-02T00:00:00Z')));
const september = async (): Promise<{ id: string; status: string }> => (await owner<{ id: string; status: string }>(`select id, status from machvon.reporting_period where code = 'M2027-09'`))[0] as { id: string; status: string };
const progressOf = async (): Promise<Awaited<ReturnType<ReportingCalendarStore['stepProgress']>>> => {
  const row = await september();
  const period = (await as((tx) => calendar.period(tx, row.id))) as NonNullable<Awaited<ReturnType<ReportingCalendarStore['period']>>>;
  return as((tx) => calendar.stepProgress(tx, period));
};

const STEPS = [
  { id: 'unit-approver', name: 'Unit approver', tag: 'UNIT_APPROVER' },
  { id: 'planning-review', name: 'Planning review', tag: 'PLANNING_REVIEW' },
  { id: 'period-close', name: 'Period close', tag: 'PERIOD_CLOSE' },
  { id: 'push', name: 'Push', tag: 'PUSH' },
];
const VERSION = randomUUID();

/** One batch of indicator entries of September 2027 in the staged approval, as the engine leaves it at a given step. */
async function seedStagedRecord(input: { status?: string; outcome?: string | null; currentStep: number; decided?: Array<{ step: number; at: string }>; batchStatus?: string }): Promise<string> {
  const batch = randomUUID();
  const instance = randomUUID();
  const [sep] = await owner<{ id: string }>(`select id from machvon.reporting_period where code = 'M2027-09'`);
  await seedReplica([
    [
      `insert into machvon.ind_entry_batch (tenant_id, id, project_id, period_id, revision, status, figures, figure_count, entered_by, version)
       values ($1, $2, $3, $4, (select coalesce(max(revision), 0) + 1 from machvon.ind_entry_batch where project_id = $3 and period_id = $4), $5, '[{"code":"X"}]'::jsonb, 1, $6, 1)`,
      [TENANT_A, batch, PROJECT, (sep as { id: string }).id, input.batchStatus ?? 'SUBMITTED', memberId(ACTOR)],
    ],
    [
      `insert into machvon.workflow_instance (tenant_id, id, workflow_version_id, resource_type, resource_id, resource_version, status, started_at, temporal_workflow_id, initiator_membership_id, initiator_user_id, document_type, unit_id, business_type, current_step, outcome, ended_at)
       values ($1, $2, $3, 'ind_entry_batch', $4, 1, $5, '2027-10-04T01:00:00Z', $6, $7, $7, 'ind.entry', $8, 'ind.entry.accept', $9, $10, $11)`,
      [TENANT_A, instance, VERSION, batch, input.status ?? 'Running', `wf-${instance}`, memberId(ACTOR), unitId(2), input.currentStep, input.outcome ?? null, input.status === 'Completed' ? '2027-10-09T01:00:00Z' : null],
    ],
    ...(input.decided ?? []).map(
      (task): [string, unknown[]] => [
        `insert into machvon.approval_task (tenant_id, id, workflow_instance_id, assignee_id, due_at, step_id, step_index, status, decision, decided_at, decided_by)
         values ($1, $2, $3, $4, '2027-10-20T00:00:00Z', $5, $6, 'Decided', 'approve', $7::timestamptz, $4)`,
        [TENANT_A, randomUUID(), instance, memberId(APPROVER), (STEPS[task.step] as { id: string }).id, task.step, task.at],
      ],
    ),
  ]);
  return instance;
}

describe('the lock of a period of the enterprise calendar waits for the review and the close (INT-2, QT.02)', () => {
  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: 1, path: '/u1/' },
      { n: 2, path: '/u1/u2/', parent: 1 },
    ]);
    await harness.seedMembership(TENANT_A, ACTOR, 1);
    await harness.seedMembership(TENANT_A, APPROVER, 1);
    await asWorker((tx) => applyBaseline(tx, sealPack('LOCK-A-1', [calendarEntry]), WORKER));
    await harness.owner(TENANT_A, [
      ...[2027].map((year): [string, unknown[]] => [
        `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
         values ($1, $2, 'WORKDAY_VN', $3, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019, Article 112', 'Published', $4, $4, now())`,
        [TENANT_A, randomUUID(), year, memberId(ACTOR)],
      ]),
    ]);
    await seedReplica([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, 'PRJ-1', 'Plant', $3, $4, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, PROJECT, unitId(2), AREA],
      ],
      [
        `insert into machvon.workflow_version (tenant_id, id, business_type, revision, definition_json, status, kind, created_by, definition_hash, published_by)
         values ($1, $2, 'ind.entry.accept', 1, $3::jsonb, 'Published', 'APPROVAL', $4, repeat('d', 64), $5)`,
        [TENANT_A, VERSION, JSON.stringify({ steps: STEPS, terminal: { approved: 'a', returned: 'b', rejected: 'c' } }), memberId(ACTOR), memberId(APPROVER)],
      ],
    ]);
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the job without a gate (the public edition)', () => {
    beforeAll(async () => {
      await reset();
      await generateMonths();
    });
    afterAll(reset);

    it('keeps the rule of three working days alone: September is locked on 8 October, before the review of 10 October', async () => {
      const result = await asWorker((tx) => new DisPeriodAutoclose(audit).run(tx, WORKER, at('2027-10-08T04:00:00Z')));
      expect(result).toEqual({ softClosed: 9, locked: 9, skipped: 0 });
      expect((await september()).status).toBe('LOCKED');
    });
  });

  describe('the job with the gate of the enterprise edition, the steps without a fact', () => {
    const job = new DisPeriodAutoclose(audit, { lockGate: new SchedulePeriodLockGate() });
    const run = (now: string) => asWorker((tx) => job.run(tx, WORKER, at(now)));
    beforeAll(async () => {
      await reset();
      await generateMonths();
    });
    afterAll(reset);

    it('holds September past its three working days until the review is due, and then until the close is due, and locks the months whose steps are long past', async () => {
      // Friday 8 October 10:00 local: the three working days after the entry deadline of 5 October. January to August are long past their review and close.
      expect(await run('2027-10-08T04:00:00Z')).toEqual({ softClosed: 9, locked: 8, skipped: 0, held: 1 });
      expect((await september()).status).toBe('SOFT_CLOSED');
      // Sunday 10 October 10:00 local: the review is due, the close (12 October) is not.
      expect(await run('2027-10-10T02:59:00Z')).toMatchObject({ locked: 0, held: 1 });
      expect(await run('2027-10-10T04:00:00Z')).toMatchObject({ locked: 0, held: 1 });
      expect(await run('2027-10-12T02:59:00Z')).toMatchObject({ locked: 0, held: 1 });
      expect((await september()).status).toBe('SOFT_CLOSED');
      expect(await run('2027-10-12T03:00:00Z')).toEqual({ softClosed: 0, locked: 1, skipped: 0, held: 0 });
      expect((await september()).status).toBe('LOCKED');
    });
  });

  describe('the job with the gate, the steps with a fact (the staged approval of the records)', () => {
    const job = new DisPeriodAutoclose(audit, { lockGate: new SchedulePeriodLockGate() });
    const run = (now: string) => asWorker((tx) => job.run(tx, WORKER, at(now)));
    beforeAll(async () => {
      await reset();
      await generateMonths();
    });
    afterAll(reset);

    it('has no fact for the review, the close and the push while no record runs the staged approval', async () => {
      expect(await progressOf()).toEqual({ planningReviewAt: undefined, periodCloseAt: undefined, pushedAt: undefined });
    });

    it('holds the lock for as long as a record waits for the review, whatever the deadlines say', async () => {
      const waiting = await seedStagedRecord({ currentStep: 1, decided: [{ step: 0, at: '2027-10-04T02:00:00Z' }] });
      expect(await progressOf()).toEqual({ planningReviewAt: null, periodCloseAt: null, pushedAt: null });
      // A month later: the deadlines of the schedule are long past and the period is still not locked, because the review has not finished.
      expect(await run('2027-11-30T04:00:00Z')).toMatchObject({ locked: 9, held: 1 });
      expect((await september()).status).toBe('SOFT_CLOSED');
      expect(waiting).toBeDefined();
    });

    it('holds it again for the close once the review is done, and a returned record is not waited for', async () => {
      await owner(`update machvon.workflow_instance set current_step = 2 where status = 'Running'`);
      await seedReplica([
        [
          `insert into machvon.approval_task (tenant_id, id, workflow_instance_id, assignee_id, due_at, step_id, step_index, status, decision, decided_at, decided_by)
           select tenant_id, gen_random_uuid(), id, $2, '2027-10-20T00:00:00Z', 'planning-review', 1, 'Decided', 'approve', '2027-10-07T03:00:00Z', $2 from machvon.workflow_instance where tenant_id = $1 and status = 'Running'`,
          [TENANT_A, memberId(APPROVER)],
        ],
      ]);
      await seedStagedRecord({ status: 'Completed', outcome: 'RETURNED', currentStep: 1, batchStatus: 'WITHDRAWN' });
      expect(await progressOf()).toEqual({ planningReviewAt: '2027-10-07T03:00:00.000Z', periodCloseAt: null, pushedAt: null });
      expect(await run('2027-11-30T04:00:00Z')).toMatchObject({ locked: 0, held: 1 });
    });

    it('lets the period go on the next run once every record passed the close, before the deadline of the close', async () => {
      await owner(`update machvon.workflow_instance set current_step = 3 where status = 'Running'`);
      await seedReplica([
        [
          `insert into machvon.approval_task (tenant_id, id, workflow_instance_id, assignee_id, due_at, step_id, step_index, status, decision, decided_at, decided_by)
           select tenant_id, gen_random_uuid(), id, $2, '2027-10-20T00:00:00Z', 'period-close', 2, 'Decided', 'approve', '2027-10-08T01:00:00Z', $2 from machvon.workflow_instance where tenant_id = $1 and status = 'Running'`,
          [TENANT_A, memberId(APPROVER)],
        ],
      ]);
      expect(await progressOf()).toEqual({ planningReviewAt: '2027-10-07T03:00:00.000Z', periodCloseAt: '2027-10-08T01:00:00.000Z', pushedAt: null });
      expect(await run('2027-11-30T04:00:00Z')).toMatchObject({ locked: 1, held: 0 });
      expect((await september()).status).toBe('LOCKED');
    });

    it('shows the push as a fact once the instance ended approved, at the instant it ended', async () => {
      await owner(`update machvon.workflow_instance set status = 'Completed', outcome = 'APPROVED', ended_at = '2027-10-14T05:00:00Z' where status = 'Running'`);
      expect(await progressOf()).toEqual({ planningReviewAt: '2027-10-07T03:00:00.000Z', periodCloseAt: '2027-10-08T01:00:00.000Z', pushedAt: '2027-10-14T05:00:00.000Z' });
    });
  });
});
