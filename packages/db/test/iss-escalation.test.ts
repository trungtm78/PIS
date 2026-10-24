import { randomUUID } from 'node:crypto';
import { AuditWriter } from '../src/audit-writer';
import { ESCALATION_ACCEPT_HOURS, IssEscalationStore } from '../src/iss-escalation-store';
import { IssIssueClosure } from '../src/iss-issue-closure';
import type { CreatedIssue } from '../src/iss-issue-store';
import { IssSlaJob, SLA_BREACH_METRIC } from '../src/iss-sla-job';
import type { SlaPassResult } from '../src/iss-sla-job';
import { TaskForceDirectory } from '../src/iss-task-force-directory';
import type { MetricsSink } from '@machvon/kernel';
import { DOCUMENT_CLEAN, FAMILY, IssWorld, NOW, PEOPLE, PROJECT, PROJECT_OTHER, TENANT_A, UNIT_1, UNIT_2, UNIT_3 as ELSEWHERE_UNIT, id, memberId, unitId } from './support/iss-fixtures';

const world = new IssWorld();
const { as, owner, refusal, sqlRefusal } = world;

class Counters implements MetricsSink {
  readonly counts = new Map<string, number>();
  increment(name: string, labels?: Record<string, string>): void {
    const key = labels === undefined ? name : `${name}{${Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(',')}}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }
  gauge(): void {
    return undefined;
  }
}

const TASK_FORCE = id(FAMILY, 40);
const TASK_FORCE_OLD = id(FAMILY, 41);
const TASK_FORCE_ELSEWHERE = id(FAMILY, 42);
const SYSTEM = memberId(PEOPLE.SYSTEM);

// The issue is opened on Monday 10 August 2026 09:00 (Vietnam) and falls due on Tuesday 11 August 15:30 (08:30 UTC), 16 working hours of 07:30 to 17:00.
const BEFORE_DUE = new Date('2026-08-11T08:00:00Z');
const AFTER_DUE = new Date('2026-08-11T08:31:00Z');
// 150 percent of 16 hours is 8 more working hours after the deadline: Wednesday 12 August 14:00 (07:00 UTC).
const BEFORE_L3 = new Date('2026-08-12T06:59:00Z');
const AT_L3 = new Date('2026-08-12T07:00:00Z');

let metrics = new Counters();
let audit: AuditWriter;
const jobOf = (): IssSlaJob => new IssSlaJob(audit, { metrics, deadlines: world.deadlines });
const escalations = (): IssEscalationStore => new IssEscalationStore(world.issues, world.deadlines);
const forces = new TaskForceDirectory();

const run = (now: Date): Promise<SlaPassResult> => as((tx) => jobOf().run(tx, SYSTEM, now));
const escalationsOf = (issueId: string) =>
  owner<{ level: number; status: string; trigger: string; target_unit_id: string | null; task_force_id: string | null; reason: string; due_at: Date }>(
    'select level, status, "trigger", target_unit_id, task_force_id, reason, due_at from machvon.issue_escalation where issue_id = $1::uuid order by level',
    [issueId],
  );
const outboxOf = (issueId: string) => owner<{ type: string; payload: Record<string, unknown> }>('select type, payload from machvon.outbox_event where aggregate_id = $1::uuid and type = $2 order by (payload ->> $3)::int', [issueId, 'iss.issue.escalated.v1', 'level']);
const auditOf = (issueId: string) => owner<{ action: string; safe_diff: Record<string, unknown> }>('select action, safe_diff from machvon.audit_event where resource_id = $1::uuid order by seq', [issueId]);

async function working(extra: Partial<Parameters<IssWorld['request']>[0]> = {}): Promise<CreatedIssue> {
  const created = await world.open(world.request(extra));
  await world.inProgress(created);
  return created;
}

describe('escalation of an issue by the SLA and by hand (ST-ISS-004)', () => {
  beforeAll(async () => {
    await world.start();
    audit = new AuditWriter(world.harness.tenants);
    await world.seedReplica([
      [
        `insert into machvon.task_force (tenant_id, id, code, name, purpose, lead_membership_id, scope_unit_id, valid_from, valid_until, status, created_by, updated_by)
         values ($1, $2, 'TF-A-01', 'Task force A', 'Clear the plots', $5, $6, date '2026-01-01', null, 'ACTIVE', $5, $5),
                ($1, $3, 'TF-OLD', 'Dissolved task force', 'Old', $5, $6, date '2025-01-01', date '2026-06-30', 'DISSOLVED', $5, $5),
                ($1, $4, 'TF-ELSE', 'Task force of another branch', 'Elsewhere', $5, $7, date '2026-01-01', null, 'ACTIVE', $5, $5)`,
        [TENANT_A, TASK_FORCE, TASK_FORCE_OLD, TASK_FORCE_ELSEWHERE, memberId(PEOPLE.TF_LEAD), UNIT_1, ELSEWHERE_UNIT],
      ],
      [
        `insert into machvon.task_force_member (tenant_id, id, task_force_id, membership_id, member_role, project_id, valid_from, valid_until, created_by, updated_by)
         values ($1, $2, $3, $4, 'MEMBER', null, date '2026-01-01', null, $5, $5), ($1, $6, $3, $7, 'MEMBER', $8, date '2026-01-01', date '2026-06-30', $5, $5)`,
        [TENANT_A, id(FAMILY, 43), TASK_FORCE, memberId(PEOPLE.TF_MEMBER), memberId(PEOPLE.TF_LEAD), id(FAMILY, 44), memberId(PEOPLE.OUTSIDER), PROJECT],
      ],
      [
        `insert into machvon.project_accountability (tenant_id, id, project_id, leader_membership_id, accountability_role, valid_from, status, created_by, updated_by)
         values ($1, $2, $3, $4, 'LEADER_IN_CHARGE', date '2026-01-01', 'ACTIVE', $4, $4)`,
        [TENANT_A, id(FAMILY, 45), PROJECT, memberId(PEOPLE.UNIT_HEAD)],
      ],
    ]);
  }, 300_000);

  beforeEach(() => {
    metrics = new Counters();
  });

  afterAll(async () => {
    await world.stop();
  }, 60_000);

  describe('the job issue-sla (UAT-AC352)', () => {
    it('AC-ST-ISS-004-1: escalates to the unit at 100 percent and to the task force at 150 percent, once each, and the original issue stays open', async () => {
      const created = await working();
      expect(created.dueAt).toBe('2026-08-11T08:30:00.000Z');
      const early = await run(BEFORE_DUE);
      expect(early.escalated).toEqual({ 2: 0, 3: 0 });
      expect(await escalationsOf(created.id)).toEqual([]);

      // Past the deadline: the day it became overdue is written, and the unit is told (level 2, to the owner unit).
      const first = await run(AFTER_DUE);
      expect(first.overdueMarked).toBeGreaterThanOrEqual(1);
      expect(first.escalated[2]).toBeGreaterThanOrEqual(1);
      const afterL2 = await world.row(created.id);
      expect(afterL2).toMatchObject({ status: 'ESCALATED', escalation_level: 2, escalated_task_force_id: null, version: '4' });
      expect((afterL2.overdue_since as Date).toISOString()).toBe(created.dueAt);
      const [l2, ...restL2] = await escalationsOf(created.id);
      expect(restL2).toEqual([]);
      expect(l2).toMatchObject({ level: 2, status: 'OPEN', trigger: 'SLA_AUTO', target_unit_id: UNIT_1, task_force_id: null, reason: 'SLA_L2_THRESHOLD_REACHED' });
      // The receiver has eight working hours from the pass: Tuesday 08:31Z is 15:31 Vietnam time, so 1.5 hours that day and 6.5 on Wednesday.
      expect(l2?.due_at.toISOString()).toBe('2026-08-12T07:01:00.000Z');
      expect(ESCALATION_ACCEPT_HOURS).toBe(8);

      // The same pass again and a pass a minute later change nothing (no duplicate escalation, no second day overdue).
      await run(AFTER_DUE);
      await run(BEFORE_L3);
      expect(await escalationsOf(created.id)).toHaveLength(1);
      expect((await world.events(created.id)).filter((event) => event.event_kind === 'SLA_BREACHED')).toHaveLength(1);

      // At 150 percent the task force that answers for the project is told (level 3).
      const second = await run(AT_L3);
      expect(second.escalated[3]).toBeGreaterThanOrEqual(1);
      const levels = await escalationsOf(created.id);
      expect(levels.map((row) => row.level)).toEqual([2, 3]);
      expect(levels[1]).toMatchObject({ status: 'OPEN', trigger: 'SLA_AUTO', task_force_id: TASK_FORCE, reason: 'SLA_L3_THRESHOLD_REACHED' });
      expect(await world.row(created.id)).toMatchObject({ status: 'ESCALATED', escalation_level: 3, escalated_task_force_id: TASK_FORCE });
      await run(new Date(AT_L3.getTime() + 3_600_000));
      expect(await escalationsOf(created.id)).toHaveLength(2);

      // The original issue is never closed by the job, and the timeline says what happened in order.
      expect((await world.row(created.id)).status).not.toBe('CLOSED');
      expect((await world.events(created.id)).map((event) => event.event_kind)).toEqual(['CREATED', 'SLA_BREACHED', 'ESCALATED', 'ESCALATED']);
      expect(metrics.counts.get(`${SLA_BREACH_METRIC}{level=2}`)).toBeGreaterThanOrEqual(1);
      expect(metrics.counts.get(`${SLA_BREACH_METRIC}{level=3}`)).toBeGreaterThanOrEqual(1);
      expect(metrics.counts.get(`${SLA_BREACH_METRIC}{level=overdue}`)).toBeGreaterThanOrEqual(1);
    });

    it('leaves the audit rows and the events for the receivers: ids, the level and the dates, the people who answer, and no text', async () => {
      const created = await working({ title: 'Plot 12 handover blocked by Nguyen Van A', description: 'Citizen id 079000000001' });
      await run(AT_L3);
      const trail = await auditOf(created.id);
      expect(trail.map((entry) => entry.action)).toEqual(['iss.issue_overdue_marked', 'iss.issue_escalated', 'iss.issue_escalated']);
      expect(trail[1]?.safe_diff).toMatchObject({ level: 2, trigger: 'SLA_AUTO', from_status: 'IN_PROGRESS', to_status: 'ESCALATED', target_unit_id: UNIT_1 });
      const events = await outboxOf(created.id);
      expect(events).toHaveLength(2);
      expect(events[0]?.payload).toMatchObject({ issue_id: created.id, level: 2, trigger: 'SLA_AUTO', status: 'ESCALATED', severity: 'HIGH', notification: { resource: { type: 'issue', id: created.id }, recipients: [memberId(PEOPLE.UNIT_HEAD)] } });
      // The task force is told through its lead and its members, each once.
      const recipients = (events[1]?.payload.notification as { recipients: string[] }).recipients;
      expect(recipients).toEqual([memberId(PEOPLE.TF_LEAD), memberId(PEOPLE.TF_MEMBER)].sort());
      const everything = JSON.stringify([trail, events]);
      for (const secret of ['Nguyen Van A', '079000000001', 'handover', 'Citizen']) expect(everything).not.toContain(secret);
    });

    it('records the escalation of an issue nobody has taken up and leaves it where it is (the machine has no edge from OPEN), and skips the one that waits for its verification', async () => {
      const unassigned = await world.open();
      const waiting = await working();
      await owner("update machvon.issue set status = 'PENDING_VERIFICATION' where id = $1::uuid", [waiting.id]);
      await run(AFTER_DUE);
      expect(await world.row(unassigned.id)).toMatchObject({ status: 'OPEN', escalation_level: 2 });
      expect((await escalationsOf(unassigned.id)).map((row) => row.level)).toEqual([2]);
      expect(await escalationsOf(waiting.id)).toEqual([]);
      expect((await world.row(waiting.id)).overdue_since).toBeNull();
    });

    it('waits when no task force answers for the issue, and counts it', async () => {
      const elsewhere = await working({ projectId: PROJECT_OTHER, ownerUnitId: UNIT_2 });
      const pass = await run(AT_L3);
      expect(pass.withoutTaskForce).toBeGreaterThanOrEqual(1);
      expect((await escalationsOf(elsewhere.id)).map((row) => row.level)).toEqual([2]);
      expect(await world.row(elsewhere.id)).toMatchObject({ escalation_level: 2, escalated_task_force_id: null });
      // Once a task force answers for the project the next pass raises it.
      await world.seedReplica([
        [
          `insert into machvon.task_force_member (tenant_id, id, task_force_id, membership_id, member_role, project_id, valid_from, created_by, updated_by)
           values ($1, $2, $3, $4, 'MEMBER', $5, date '2026-01-01', $4, $4)`,
          [TENANT_A, randomUUID(), TASK_FORCE, memberId(PEOPLE.TF_MEMBER), PROJECT_OTHER],
        ],
      ]);
      await run(AT_L3);
      expect((await escalationsOf(elsewhere.id)).map((row) => row.level)).toEqual([2, 3]);
      await owner('delete from machvon.task_force_member where project_id = $1::uuid', [PROJECT_OTHER]);
    });

    it('moves the thresholds with an extension of the deadline (100 percent is the current deadline)', async () => {
      const created = await working();
      const closure = new IssIssueClosure(world.issues, world.deadlines);
      // Granted on Tuesday morning: the longest extension from 15:30 is Thursday 12:30.
      const morning = new Date('2026-08-11T03:00:00Z');
      await as((tx) => closure.extend(tx, created.id, 3, { newDueAt: '2026-08-13T05:30:00.000Z', reason: 'More time' }, memberId(PEOPLE.EXTENDER), world.everything('issue.extend', PEOPLE.EXTENDER), morning), TENANT_A, PEOPLE.EXTENDER);
      await run(AFTER_DUE);
      expect(await escalationsOf(created.id)).toEqual([]);
      expect((await world.row(created.id)).overdue_since).toBeNull();
      await run(new Date('2026-08-13T05:31:00Z'));
      expect((await escalationsOf(created.id)).map((row) => row.level)).toEqual([2]);
    });

    it('counts the threshold below 100 percent from the day the issue was opened', async () => {
      const category = await world.seedCategory(TENANT_A, 'ISSUE_CATEGORY', 'EARLY');
      await as((tx) =>
        world.policies.publish(tx, { code: 'SLA-EARLY', categoryVersionId: category, severity: 'HIGH', calendarCode: 'WORKDAY_VN', responseHours: 4, resolveHours: 16, escalateL2Pct: 50, escalateL3Pct: 150, validFrom: '2026-08-05' }, SYSTEM),
      );
      const created = await world.open(world.request({ categoryVersionId: category }));
      await world.inProgress(created);
      // 50 percent of 16 hours is 8 working hours after Monday 09:00: Tuesday 07:30 + 0 = Monday 17:00 (10:00Z).
      await run(new Date('2026-08-10T09:59:00Z'));
      expect(await escalationsOf(created.id)).toEqual([]);
      await run(new Date('2026-08-10T10:00:00Z'));
      expect((await escalationsOf(created.id)).map((row) => row.level)).toEqual([2]);
      expect((await world.row(created.id)).overdue_since).toBeNull();
    });

    it('leaves the escalation to a later pass when the calendar year it needs is not published, and does not guess', async () => {
      // A calendar published for 2027 only: an issue opened on the last Friday of 2027 is due that day, and the eight working hours of the receiver run into 2028.
      await owner(
        `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
         values ($1, gen_random_uuid(), 'SHORT_CAL', 2027, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019, Article 112', 'Published', $2, $2, now())`,
        [TENANT_A, SYSTEM],
      );
      const category = await world.seedCategory(TENANT_A, 'ISSUE_CATEGORY', 'SHORT');
      await as((tx) =>
        world.policies.publish(tx, { code: 'SLA-SHORT', categoryVersionId: category, severity: 'HIGH', calendarCode: 'SHORT_CAL', responseHours: 4, resolveHours: 8, validFrom: '2027-12-01' }, SYSTEM),
      );
      const created = await world.open(world.request({ categoryVersionId: category }), new Date('2027-12-31T02:00:00Z'));
      await world.inProgress(created);
      expect(created.dueAt).toBe('2027-12-31T10:00:00.000Z');
      const pass = await run(new Date('2027-12-31T10:30:00Z'));
      expect(pass.withoutCalendar).toBeGreaterThanOrEqual(1);
      expect(await escalationsOf(created.id)).toEqual([]);
      // The day it became overdue needs no calendar.
      expect(((await world.row(created.id)).overdue_since as Date).toISOString()).toBe(created.dueAt);
    });

    it('leaves the issue a command is acting on at that moment to the next pass', async () => {
      const created = await working();
      const client = await world.harness.appPool.connect();
      try {
        await client.query('begin');
        await client.query("select set_config('app.tenant_id', $1, true)", [TENANT_A]);
        await client.query('select id from machvon.issue where id = $1::uuid for update', [created.id]);
        await run(AFTER_DUE);
        expect(await escalationsOf(created.id)).toEqual([]);
      } finally {
        await client.query('rollback');
        client.release();
      }
      await run(AFTER_DUE);
      expect(await escalationsOf(created.id)).toHaveLength(1);
    });

    it('reports the issues that are open and the escalations that wait', async () => {
      const pass = await run(AT_L3);
      expect(pass.open.HIGH).toBeGreaterThan(0);
      expect(pass.pending).toBeGreaterThan(0);
      expect(Object.keys(pass.open).sort()).toEqual(['CRITICAL', 'HIGH', 'LOW', 'MEDIUM']);
    });
  });

  describe('accepting an escalation (UAT-PLAN-24)', () => {
    async function escalated(): Promise<{ issue: CreatedIssue; l2: string; l3: string }> {
      const issue = await working();
      await run(AT_L3);
      const rows = await owner<{ id: string; level: number }>('select id, level from machvon.issue_escalation where issue_id = $1::uuid order by level', [issue.id]);
      return { issue, l2: rows[0]?.id as string, l3: rows[1]?.id as string };
    }
    const memberAccess = (member: number) => world.accessOf(['issue.escalation.accept'], { kind: 'TENANT' }, member);
    const noRead = () => world.scopesOf('issue.read', world.subtree(3), PEOPLE.OUTSIDER).read;
    const accept = (escalationId: string, member: number, access = memberAccess(member), reads = world.everything('issue.read', member).read, at: Date = AT_L3) =>
      as((tx) => escalations().accept(tx, escalationId, { note: 'We take it up' }, memberId(member), access, reads, at), TENANT_A, member);

    it('AC-ST-ISS-004-2: refuses a person outside the task force, accepts a member, and sets the escalation to ACCEPTED while the issue goes back to work', async () => {
      const { issue, l3 } = await escalated();
      expect(await refusal(accept(l3, PEOPLE.OUTSIDER))).toEqual({ code: 'SCOPE_DENIED', status: 403 });
      // Someone who cannot even read the issue does not learn that it exists.
      expect(await refusal(accept(l3, PEOPLE.OUTSIDER, memberAccess(PEOPLE.OUTSIDER), noRead()))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect((await escalationsOf(issue.id))[1]?.status).toBe('OPEN');
      const accepted = await accept(l3, PEOPLE.TF_MEMBER);
      expect(accepted).toMatchObject({ status: 'IN_PROGRESS', previousStatus: 'ESCALATED', level: 3, escalationId: l3, version: 6 });
      const rows = await owner<{ status: string; accepted_by: string; accepted_at: Date; version: string }>('select status, accepted_by, accepted_at, version::text as version from machvon.issue_escalation where id = $1::uuid', [l3]);
      expect(rows[0]).toMatchObject({ status: 'ACCEPTED', accepted_by: memberId(PEOPLE.TF_MEMBER), version: '2' });
      expect(rows[0]?.accepted_at.toISOString()).toBe(AT_L3.toISOString());
      expect(await world.row(issue.id)).toMatchObject({ status: 'IN_PROGRESS', escalation_level: 3 });
      expect((await world.events(issue.id)).at(-1)).toMatchObject({ event_kind: 'ESCALATION_ACCEPTED', from_status: 'ESCALATED', to_status: 'IN_PROGRESS', note: 'We take it up' });
      expect(await refusal(accept(l3, PEOPLE.TF_MEMBER))).toEqual({ code: 'ESCALATION_STATE_INVALID', status: 409 });
      // The lead of the task force is a member too; a member whose own term has ended is not.
      const second = await escalated();
      expect((await accept(second.l3, PEOPLE.TF_LEAD)).level).toBe(3);
      const third = await escalated();
      expect(await refusal(accept(third.l3, PEOPLE.OUTSIDER))).toEqual({ code: 'SCOPE_DENIED', status: 403 });
    });

    it('accepts the escalation to the unit for the person who answers for that unit, and not for one who answers for another', async () => {
      const { issue, l2, l3 } = await escalated();
      const head = world.accessOf(['issue.escalation.accept'], world.subtree(1), PEOPLE.UNIT_HEAD);
      const other = world.accessOf(['issue.escalation.accept'], world.subtree(2), PEOPLE.WORKER_U2);
      expect(await refusal(accept(l2, PEOPLE.WORKER_U2, other, world.everything('issue.read', PEOPLE.WORKER_U2).read))).toEqual({ code: 'SCOPE_DENIED', status: 403 });
      expect(await refusal(accept(l2, PEOPLE.UNIT_HEAD, world.accessOf(['issue.read'], world.subtree(1), PEOPLE.UNIT_HEAD)))).toEqual({ code: 'SCOPE_DENIED', status: 403 });
      const accepted = await accept(l2, PEOPLE.UNIT_HEAD, head);
      expect(accepted).toMatchObject({ level: 2, escalationId: l2, status: 'IN_PROGRESS' });
      expect((await escalationsOf(issue.id))[0]?.status).toBe('ACCEPTED');
      // The level 3 escalation is still open: its own receiver accepts it, and the issue stays at work.
      expect((await accept(l3, PEOPLE.TF_MEMBER)).status).toBe('IN_PROGRESS');
    });

    it('does not know an escalation that is not there, and refuses a note that is empty', async () => {
      expect(await refusal(accept(randomUUID(), PEOPLE.TF_MEMBER))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      const { l3 } = await escalated();
      expect(await refusal(as((tx) => escalations().accept(tx, l3, { note: ' ' }, memberId(PEOPLE.TF_MEMBER), memberAccess(PEOPLE.TF_MEMBER), world.everything('issue.read', PEOPLE.TF_MEMBER).read, AT_L3), TENANT_A, PEOPLE.TF_MEMBER))).toEqual({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: 'note',
      });
    });
  });

  describe('escalating by hand', () => {
    const escalate = (issueId: string, version: number, input: { level: number; targetUnitId?: string; taskForceId?: string; reason?: string }, member: number = PEOPLE.UNIT_HEAD, at: Date = NOW) =>
      as((tx) => escalations().escalate(tx, issueId, version, { reason: 'The owner has not answered', ...input }, memberId(member), world.everything('issue.escalate', member), at), TENANT_A, member);

    it('raises a working issue to a unit and then to the task force, keeps its deadline, and refuses a level that is not above the one reached', async () => {
      const created = await working();
      const first = await escalate(created.id, 3, { level: 1, targetUnitId: UNIT_2 });
      expect(first).toMatchObject({ status: 'ESCALATED', escalationLevel: 1, level: 1, trigger: 'MANUAL', targetUnitId: UNIT_2, version: 4, dueAt: created.dueAt, previousStatus: 'IN_PROGRESS' });
      expect(first.acceptDueAt).toBe('2026-08-10T10:00:00.000Z');
      expect(await escalationsOf(created.id)).toMatchObject([{ level: 1, status: 'OPEN', trigger: 'MANUAL', target_unit_id: UNIT_2, reason: 'The owner has not answered' }]);
      // The issue is ESCALATED now: the state machine has no edge to escalate it again until the receiver accepts.
      expect(await refusal(escalate(created.id, 4, { level: 2 }))).toEqual({ code: 'ISSUE_STATE_INVALID', status: 409 });
      await as(
        (tx) => escalations().accept(tx, first.escalationId, {}, memberId(PEOPLE.WORKER_U2), world.accessOf(['issue.escalation.accept'], world.subtree(2), PEOPLE.WORKER_U2), world.everything('issue.read', PEOPLE.WORKER_U2).read, NOW),
        TENANT_A,
        PEOPLE.WORKER_U2,
      );
      expect(await refusal(escalate(created.id, 5, { level: 1 }))).toEqual({ code: 'ESCALATION_LEVEL_INVALID', status: 422 });
      const second = await escalate(created.id, 5, { level: 2 });
      expect(second).toMatchObject({ escalationLevel: 2, targetUnitId: UNIT_1, recipients: [memberId(PEOPLE.UNIT_HEAD)] });
      expect(await escalationsOf(created.id)).toHaveLength(2);
    });

    it('AC-ST-ISS-004-1: level 3 needs an active task force that answers for the issue, and says which rule it broke', async () => {
      const created = await working();
      expect(await refusal(escalate(created.id, 3, { level: 3 }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'task_force_id' });
      expect(await refusal(escalate(created.id, 3, { level: 3, taskForceId: TASK_FORCE_OLD }))).toEqual({ code: 'TASK_FORCE_NOT_ACTIVE', status: 422 });
      expect(await refusal(escalate(created.id, 3, { level: 3, taskForceId: TASK_FORCE_ELSEWHERE }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'task_force_id' });
      expect(await refusal(escalate(created.id, 3, { level: 3, taskForceId: randomUUID() }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'task_force_id' });
      expect(await refusal(escalate(created.id, 3, { level: 3, taskForceId: 'not-a-uuid' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'task_force_id' });
      expect(await refusal(escalate(created.id, 3, { level: 1, taskForceId: TASK_FORCE }))).toEqual({ code: 'ESCALATION_LEVEL_INVALID', status: 422 });
      expect(await refusal(escalate(created.id, 3, { level: 4 }))).toEqual({ code: 'ESCALATION_LEVEL_INVALID', status: 422 });
      expect(await refusal(escalate(created.id, 3, { level: 0 }))).toEqual({ code: 'ESCALATION_LEVEL_INVALID', status: 422 });
      expect(await escalationsOf(created.id)).toEqual([]);
      const raised = await escalate(created.id, 3, { level: 3, taskForceId: TASK_FORCE });
      expect(raised).toMatchObject({ level: 3, taskForceId: TASK_FORCE, escalationLevel: 3, recipients: [memberId(PEOPLE.TF_LEAD), memberId(PEOPLE.TF_MEMBER)].sort() });
      expect(await world.row(created.id)).toMatchObject({ escalated_task_force_id: TASK_FORCE, escalation_level: 3 });
    });

    it('refuses an issue in a state the machine does not escalate, a stale version, an empty reason, a unit of another tenant and a caller outside the scope', async () => {
      const open = await world.open();
      expect(await refusal(escalate(open.id, 1, { level: 1 }))).toEqual({ code: 'ISSUE_STATE_INVALID', status: 409 });
      const created = await working();
      expect((await refusal(escalate(created.id, 2, { level: 1 }))).code).toBe('VERSION_CONFLICT');
      expect(await refusal(escalate(created.id, 3, { level: 1, reason: ' ' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'reason' });
      expect(await refusal(escalate(created.id, 3, { level: 1, targetUnitId: id(0x10, 99) }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'target_unit_id' });
      expect(await refusal(escalate(created.id, 3, { level: 1, targetUnitId: 'x' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'target_unit_id' });
      const readerOfOthers = { act: world.scopesOf('issue.escalate', world.subtree(2), PEOPLE.WORKER_U2).act, read: world.everything('issue.escalate', PEOPLE.WORKER_U2).read };
      expect(await refusal(as((tx) => escalations().escalate(tx, created.id, 3, { level: 1, reason: 'Why not' }, memberId(PEOPLE.WORKER_U2), readerOfOthers, NOW), TENANT_A, PEOPLE.WORKER_U2))).toEqual({
        code: 'SCOPE_DENIED',
        status: 403,
      });
      expect(await escalationsOf(created.id)).toEqual([]);
    });

    it('turns a lost race for the same level into a refusal and not a database error', async () => {
      const created = await working();
      const store = escalations();
      await owner(
        `insert into machvon.issue_escalation (tenant_id, id, issue_id, level, "trigger", target_unit_id, reason, due_at, created_by, updated_by)
         values ($1::uuid, gen_random_uuid(), $2::uuid, 1, 'MANUAL', $3::uuid, 'Race', now(), $4::uuid, $4::uuid)`,
        [TENANT_A, created.id, UNIT_1, SYSTEM],
      );
      expect(
        await refusal(as((tx) => store.escalate(tx, created.id, 3, { level: 1, reason: 'Race' }, memberId(PEOPLE.UNIT_HEAD), world.everything('issue.escalate', PEOPLE.UNIT_HEAD), NOW), TENANT_A, PEOPLE.UNIT_HEAD)),
      ).toEqual({ code: 'ESCALATION_LEVEL_INVALID', status: 422 });
    });
  });

  describe('the board (listIssueSlaBreaches)', () => {
    it('lists the escalations of the issues in the scope of the caller, and the ones addressed to them whether or not their grants reach the issue', async () => {
      const issue = await working();
      await run(AT_L3);
      const all = world.everything('issue.read', PEOPLE.ASSIGNER);
      const asker = (member: number, access: ReturnType<IssWorld['accessOf']>, reads = all.read, options: { level?: number; limit?: number } = {}) =>
        as((tx) => escalations().breaches(tx, { limit: options.limit ?? 50, after: undefined, ...(options.level === undefined ? {} : { level: options.level }) }, reads, access, AT_L3), TENANT_A, member);

      const staff = await asker(PEOPLE.ASSIGNER, world.accessOf(['issue.read'], { kind: 'TENANT' }, PEOPLE.ASSIGNER));
      const mine = staff.filter((line) => line.issueCode === issue.code);
      expect(mine.map((line) => line.level).sort()).toEqual([2, 3]);
      expect(mine.every((line) => !line.acceptable)).toBe(true);
      const l3 = mine.find((line) => line.level === 3);
      expect(l3).toMatchObject({ status: 'OPEN', taskForceCode: 'TF-A-01', trigger: 'SLA_AUTO', issueStatus: 'ESCALATED', projectCode: expect.any(String) as string });
      expect(l3?.overdueSince).toBe(issue.dueAt);

      // The member of the task force reads the escalation to it without any grant that reaches the issue, and may accept it.
      const member = await asker(PEOPLE.TF_MEMBER, world.accessOf(['issue.escalation.accept'], world.subtree(3), PEOPLE.TF_MEMBER), world.scopesOf('issue.read', world.subtree(3), PEOPLE.TF_MEMBER).read);
      expect(member.map((line) => line.level)).toContain(3);
      expect(member.filter((line) => line.taskForceCode === null)).toEqual([]);
      expect(member.every((line) => line.acceptable === (line.status === 'OPEN'))).toBe(true);
      // The head of the unit sees the escalations to the unit and may accept them, and not the ones to the task force.
      const head = await asker(PEOPLE.UNIT_HEAD, world.accessOf(['issue.escalation.accept'], world.subtree(1), PEOPLE.UNIT_HEAD), world.scopesOf('issue.read', world.subtree(3), PEOPLE.UNIT_HEAD).read);
      expect(head.length).toBeGreaterThan(0);
      expect(head.every((line) => line.taskForceId === null && line.acceptable === (line.status === 'OPEN'))).toBe(true);
      expect(head.some((line) => line.level === 2)).toBe(true);
      // A caller with no reach sees nothing; the level filters.
      expect(await asker(PEOPLE.OUTSIDER, world.accessOf(['issue.read'], world.subtree(3), PEOPLE.OUTSIDER), world.scopesOf('issue.read', world.subtree(3), PEOPLE.OUTSIDER).read)).toEqual([]);
      expect((await asker(PEOPLE.ASSIGNER, world.accessOf(['issue.read'], { kind: 'TENANT' }, PEOPLE.ASSIGNER), all.read, { level: 3 })).every((line) => line.level === 3)).toBe(true);
    });

    it('pages by creation time and refuses a cursor that is not a time', async () => {
      const all = world.everything('issue.read', PEOPLE.ASSIGNER);
      const access = world.accessOf(['issue.read'], { kind: 'TENANT' }, PEOPLE.ASSIGNER);
      const first = await as((tx) => escalations().breaches(tx, { limit: 2, after: undefined }, all.read, access, AT_L3), TENANT_A, PEOPLE.ASSIGNER);
      expect(first).toHaveLength(2);
      const last = first[1] as (typeof first)[number];
      const next = await as((tx) => escalations().breaches(tx, { limit: 2, after: { code: last.createdKey, id: last.id } }, all.read, access, AT_L3), TENANT_A, PEOPLE.ASSIGNER);
      expect(next.map((line) => line.id)).not.toContain(first[0]?.id);
      expect(await refusal(as((tx) => escalations().breaches(tx, { limit: 2, after: { code: 'yesterday', id: last.id } }, all.read, access, AT_L3), TENANT_A, PEOPLE.ASSIGNER))).toEqual({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: 'cursor',
      });
    });

    it('reads the escalations of one issue and the task force that answers for it today', async () => {
      const created = await working();
      await run(AT_L3);
      const rows = await as((tx) => escalations().forIssue(tx, created.id));
      expect(rows.map((row) => row.level)).toEqual([3, 2]);
      expect(rows[0]).toMatchObject({ taskForceCode: 'TF-A-01', status: 'OPEN', reason: 'SLA_L3_THRESHOLD_REACHED' });
      expect(rows[1]).toMatchObject({ targetUnitName: 'Unit 1' });
      const force = await as((tx) => escalations().activeTaskForceOf(tx, { projectId: PROJECT, ownerUnitPath: '/u1/' }, AT_L3));
      expect(force).toMatchObject({ code: 'TF-A-01', leadMembershipId: memberId(PEOPLE.TF_LEAD) });
      expect(await as((tx) => escalations().activeTaskForceOf(tx, { projectId: PROJECT_OTHER, ownerUnitPath: '/u2/' }, AT_L3))).toBeUndefined();
    });
  });

  describe('the task forces that answer for an issue', () => {
    it('prefers the one with a member on the project, then the deepest scope unit, and counts the end day of a term as a day in force', async () => {
      const place = { projectId: PROJECT, ownerUnitPath: '/u1/', on: '2026-08-12' };
      expect((await as((tx) => forces.activeFor(tx, place)))?.code).toBe('TF-A-01');
      expect((await as((tx) => forces.activeFor(tx, { ...place, on: '2025-12-31' })))).toBeUndefined();
      // The dissolved task force and the one of another branch never answer; the term of a member ended on 30 June.
      expect((await as((tx) => forces.judge(tx, TASK_FORCE_OLD, place))).verdict).toBe('NOT_ACTIVE');
      expect((await as((tx) => forces.judge(tx, TASK_FORCE_ELSEWHERE, place))).verdict).toBe('UNRELATED');
      expect((await as((tx) => forces.judge(tx, randomUUID(), place))).verdict).toBe('UNKNOWN');
      expect((await as((tx) => forces.judge(tx, TASK_FORCE, place))).force?.memberIds).toEqual([memberId(PEOPLE.TF_LEAD), memberId(PEOPLE.TF_MEMBER)].sort());
      const outsider = await as((tx) => forces.membershipsOf(tx, memberId(PEOPLE.OUTSIDER), '2026-06-30'));
      expect([...outsider]).toEqual([TASK_FORCE]);
      expect([...(await as((tx) => forces.membershipsOf(tx, memberId(PEOPLE.OUTSIDER), '2026-07-01')))]).toEqual([]);
      expect(await as((tx) => forces.leadersOf(tx, PROJECT, '2026-08-12'))).toEqual([memberId(PEOPLE.UNIT_HEAD)]);
      expect(await as((tx) => forces.leadersOf(tx, PROJECT, '2025-12-31'))).toEqual([]);
    });

    it('chooses by project member first and then by the deepest scope unit', async () => {
      await world.seedReplica([
        [
          `insert into machvon.task_force (tenant_id, id, code, name, purpose, lead_membership_id, scope_unit_id, valid_from, status, created_by, updated_by)
           values ($1, $2, 'TF-DEEP', 'Deeper', 'Deeper scope', $3, $4, date '2026-01-01', 'ACTIVE', $3, $3)`,
          [TENANT_A, id(FAMILY, 46), memberId(PEOPLE.TF_LEAD), unitId(2)],
        ],
      ]);
      const sub = id(FAMILY, 47);
      await world.seedReplica([
        [`insert into machvon.organization_unit (tenant_id, id, code, name, parent_id, valid_from, path, depth) values ($1, $2, 'U9', 'Unit 9', $3, date '2026-01-01', $4, 2)`, [TENANT_A, sub, UNIT_2, `/u2/${sub}/`]],
      ]);
      const place = { projectId: PROJECT_OTHER, ownerUnitPath: `/u2/${sub}/`, on: '2026-08-12' };
      expect((await as((tx) => forces.activeFor(tx, place)))?.code).toBe('TF-DEEP');
      // A member on the project outweighs the depth of the scope.
      await world.seedReplica([
        [
          `insert into machvon.task_force_member (tenant_id, id, task_force_id, membership_id, member_role, project_id, valid_from, created_by, updated_by)
           values ($1, $2, $3, $4, 'MEMBER', $5, date '2026-01-01', $4, $4)`,
          [TENANT_A, id(FAMILY, 48), TASK_FORCE, memberId(PEOPLE.TF_MEMBER), PROJECT_OTHER],
        ],
      ]);
      expect((await as((tx) => forces.activeFor(tx, { ...place, ownerUnitPath: '/u1/' })))?.code).toBe('TF-A-01');
      expect((await as((tx) => forces.activeFor(tx, place)))?.code).toBe('TF-A-01');
      await owner('delete from machvon.task_force_member where project_id = $1::uuid', [PROJECT_OTHER]);
    });
  });

  describe('what the database holds whatever the application did', () => {
    const insert = (issueId: string, level: number, extra: { force?: string | null; status?: string } = {}) =>
      as((tx) =>
        tx.query(
          `insert into machvon.issue_escalation (tenant_id, id, issue_id, level, "trigger", target_unit_id, task_force_id, reason, due_at, status, created_by, updated_by)
           values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::smallint, 'MANUAL', $3::uuid, $4::uuid, 'Reason', now(), $5, $6::uuid, $6::uuid)`,
          [issueId, level, UNIT_1, extra.force ?? null, extra.status ?? 'OPEN', SYSTEM],
        ),
      );

    it('refuses an escalation of a closed issue, to a task force that is not active, at the wrong level for its target, or one that begins accepted; and an issue whose level falls', async () => {
      const created = await working();
      expect((await sqlRefusal(insert(created.id, 3, { force: TASK_FORCE_OLD }))).message).toContain('task force is not active');
      expect((await sqlRefusal(insert(created.id, 3))).message).toContain('issue_escalation_force_chk');
      expect((await sqlRefusal(insert(created.id, 1, { force: TASK_FORCE }))).message).toContain('issue_escalation_force_chk');
      expect((await sqlRefusal(insert(created.id, 1, { status: 'ACCEPTED' }))).message).toContain('begins open');
      await run(AT_L3);
      expect((await sqlRefusal(as((tx) => tx.query('update machvon.issue set escalation_level = 0 where id = $1::uuid', [created.id])))).message).toContain('falls only when it is reopened');
      const done = await working();
      await owner("update machvon.issue set status = 'PENDING_VERIFICATION' where id = $1::uuid", [done.id]);
      await owner(
        `insert into machvon.issue_event (tenant_id, id, issue_id, event_kind, payload, created_by) values ($1::uuid, gen_random_uuid(), $2::uuid, 'VERIFICATION_REQUESTED', $3::jsonb, $4::uuid)`,
        [TENANT_A, done.id, JSON.stringify({ evidence_document_version_ids: [DOCUMENT_CLEAN] }), SYSTEM],
      );
      await owner("update machvon.issue set status = 'CLOSED', closed_at = now(), closed_by = $2::uuid, verifier_id = $2::uuid where id = $1::uuid", [done.id, memberId(PEOPLE.VERIFIER)]);
      expect((await sqlRefusal(insert(done.id, 2))).message).toContain('closed issue');
    });

    it('keeps what an escalation says, lets its status move forward only, and lets nobody delete it', async () => {
      const created = await working();
      await run(AT_L3);
      const [l2] = await owner<{ id: string }>('select id from machvon.issue_escalation where issue_id = $1::uuid and level = 2', [created.id]);
      const touch = (set: string) => as((tx) => tx.query(`update machvon.issue_escalation set ${set} where id = $1::uuid`, [l2?.id]));
      for (const set of ["reason = 'Rewritten'", 'level = 1', "due_at = due_at + interval '1 day'", "\"trigger\" = 'MANUAL'", 'target_unit_id = null']) {
        expect((await sqlRefusal(touch(set))).sqlstate).toBe('23514');
      }
      await touch("status = 'CANCELLED'");
      expect((await sqlRefusal(touch("status = 'OPEN'"))).message).toContain('does not move from CANCELLED to OPEN');
      expect((await sqlRefusal(as((tx) => tx.query('delete from machvon.issue_escalation where id = $1::uuid', [l2?.id])))).sqlstate).toBe('42501');
      expect((await sqlRefusal(as((tx) => tx.query('truncate machvon.issue_escalation')))).sqlstate).toBe('42501');
    });
  });
});

