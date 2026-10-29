import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApprovalStore } from '../src/approval-store';
import type { ApprovalEffects, FinalCommand } from '../src/approval-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, contextFor, memberId, roleId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const store = new ApprovalStore();
const ADMIN = 1;
const PUBLISHER = 2;
const MAKER = 3;
const LEADER_A = 4;
const LEADER_B = 5;
const LEADER_C = 6;
const OPERATOR = 7;
const OFFICER = 8; // holds nothing
const SPARE = 9; // gets the leader role after the approvals were started: holds no task
const EXTRA = 10; // another who gets the leader role later
const LOW = 11; // may decide, at a rank below the leaders
const FREE = 12; // gets the leader role in the middle of a test: holds no task
const LEADER_ROLE = 1;
const ROOT = 1;
let NOW = new Date();

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = OPERATOR): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);
const later = (seconds: number): Date => new Date(Date.now() + seconds * 1000);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; extensions?: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

interface Recorded {
  audits: string[];
  events: Array<{ type: string; payload: Record<string, unknown> }>;
}
const effects = (member: number, recorded: Recorded = { audits: [], events: [] }): ApprovalEffects & { recorded: Recorded } => ({
  actor: memberId(member),
  audit: (entry) => {
    recorded.audits.push(entry.action);
    return Promise.resolve();
  },
  emit: (event) => {
    recorded.events.push({ type: event.type, payload: event.payload });
    return Promise.resolve();
  },
  recorded,
});

const step = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: `Bước ${id}`, assignee_rule: { type: 'DOA' }, min_approvals: 1, sla_working_hours: 16, on_timeout: 'REMIND', ...extra });
const specific = (...members: number[]) => ({ type: 'SPECIFIC', membership_ids: members.map((member) => memberId(member)) });
const roleLeaders = { type: 'ROLE_IN_UNIT', role_code: 'LEADER', unit_id: unitId(ROOT) };
const definitionOf = (steps: unknown[], commands = { approved: 'acceptReport', returned: 'returnReport', rejected: 'rejectReport' }) => ({ steps, terminal: commands });
const REPORT = 'report.accept';
const PLAN = 'plan.publish';
const PAYMENT = 'payment.approve';
const planCommands = { approved: 'publishPlan', returned: 'returnPlan', rejected: 'rejectPlan' };
const paymentCommands = { approved: 'approvePaymentRequest', returned: 'returnPaymentRequest', rejected: 'rejectPaymentRequest' };

async function publishDefinition(businessType: string, definition: unknown): Promise<string> {
  const draft = await as((tx) => store.createDraft(tx, { businessType, definition }, memberId(ADMIN)), ADMIN);
  const done = await as((tx) => store.publish(tx, draft.id, draft.version, memberId(PUBLISHER), NOW), PUBLISHER);
  return done.version.id;
}

const accept: FinalCommand = () => Promise.resolve('APPLIED');

async function start(businessType: string, maker = MAKER) {
  const e = effects(maker);
  const instance = await as(
    (tx) => store.start(tx, e, { resourceType: 'record', resourceId: randomUUID(), resourceVersion: 1, businessType, amountVnd: '1000000', unitId: unitId(ROOT), initiatorMembershipId: memberId(maker), now: NOW }),
    maker,
  );
  return { instance, e };
}

interface TaskRow {
  id: string;
  assignee_id: string;
  status: string;
  version: string;
  due_at: string;
  remind_at: string | null;
  reminded_at: string | null;
  next_reminder_at: string | null;
  escalated_at: string | null;
  escalated_from_task_id: string | null;
  reassigned_from_task_id: string | null;
  overdue_reminders: number;
  reason: string | null;
}
const ISO = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const tasksOf = (instanceId: string) =>
  owner<TaskRow>(
    `select id, assignee_id, status, version::text, ${ISO('due_at')} as due_at, ${ISO('remind_at')} as remind_at, ${ISO('reminded_at')} as reminded_at, ${ISO('next_reminder_at')} as next_reminder_at, ${ISO('escalated_at')} as escalated_at, escalated_from_task_id, reassigned_from_task_id, overdue_reminders, reason
       from machvon.approval_task where workflow_instance_id = $1 order by created_at, id`,
    [instanceId],
  );
const taskOf = async (instanceId: string, member: number, status = 'Pending'): Promise<TaskRow> => {
  const found = (await tasksOf(instanceId)).find((task) => task.assignee_id === memberId(member) && task.status === status);
  if (found === undefined) throw new Error(`no ${status} task of member ${member}`);
  return found;
};
const instanceRow = async (instanceId: string) => (await owner<{ status: string; outcome: string | null; version: string; workflow_version_id: string; current_step: number }>('select status, outcome, version::text, workflow_version_id, current_step from machvon.workflow_instance where id = $1', [instanceId]))[0];

let tick = 0;
const decide = (member: number, task: { id: string; version: string | number }, decision: 'approve' | 'return' | 'reject', finish: FinalCommand = accept, e = effects(member)) => {
  tick += 1;
  return as((tx) => store.decide(tx, e, { taskId: task.id, expectedVersion: Number(task.version), decision, reason: decision === 'approve' ? undefined : 'a reason that is long enough', returnToStep: undefined, now: new Date(NOW.getTime() + tick * 1000), finish }), member);
};
const reassign = (task: { id: string; version: string | number }, to: number, reason = 'the assignee is on leave this week', e = effects(OPERATOR)) =>
  as((tx) => store.reassignTask(tx, e, { taskId: task.id, expectedVersion: Number(task.version), newAssignee: memberId(to), reason, now: later(2) }));
const sweep = (at: Date, e = effects(OPERATOR)) => as((tx) => store.sweepSla(tx, e, at));
const at = (iso: string | null): Date => new Date(iso as string);

describe('the operations on a running approval and its SLA (ST-ADM-013, ADM 3.7)', () => {
  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
    for (const member of [ADMIN, PUBLISHER, MAKER, LEADER_A, LEADER_B, LEADER_C, OPERATOR, OFFICER, SPARE, EXTRA, LOW, FREE]) await harness.seedMembership(TENANT_A, member, ROOT);
    await harness.seedRole(TENANT_A, LEADER_ROLE, 'LEADER', ['approval.decide'], 60);
    await harness.seedRole(TENANT_A, 2, 'DEPUTY', ['approval.decide'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 7, member: LOW, role: 2, kind: 'TENANT' },
      { n: 1, member: MAKER, role: LEADER_ROLE, kind: 'TENANT' },
      { n: 2, member: LEADER_A, role: LEADER_ROLE, kind: 'TENANT' },
      { n: 3, member: LEADER_B, role: LEADER_ROLE, kind: 'TENANT' },
      { n: 4, member: LEADER_C, role: LEADER_ROLE, kind: 'TENANT' },
    ]);
    const matrix = randomUUID();
    await harness.owner(TENANT_A, [
      [`insert into machvon.doa_matrix_version (tenant_id, id, revision, status, effective_from, legal_basis_ref, created_by, last_edited_by, version) values ($1, $2, 900, 'Draft', date '2020-01-01', 'Fixture regulation on approvals', $3, $3, 1)`, [TENANT_A, matrix, memberId(ADMIN)]],
      [`insert into machvon.doa_rule (tenant_id, id, matrix_version_id, document_type, unit_id, include_subtree, amount_min_vnd, amount_max_vnd, approver_role_id, approval_levels, position) values ($1, $2, $3, 'REPORT_ACCEPT', $4, true, 0, null, $5, 1, 0)`, [TENANT_A, randomUUID(), matrix, unitId(ROOT), roleId(LEADER_ROLE)]],
      ["update machvon.doa_matrix_version set status = 'PendingApproval' where id = $1", [matrix]],
      ["update machvon.doa_matrix_version set status = 'Published', approved_by = $2, published_at = now() where id = $1", [matrix, memberId(PUBLISHER)]],
    ]);
    NOW = new Date(Date.now() + 1000);
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the engine under the acceptance criteria', () => {
    it('AC-ST-ADM-013-1, UAT-AC130: two attempts to decide one task at the same time are one decision and one refusal, and one event reaches the consumers', async () => {
      await publishDefinition(REPORT, definitionOf([step('review', { assignee_rule: roleLeaders })]));
      const { instance } = await start(REPORT);
      const task = await taskOf(instance.id, LEADER_A);
      const first = effects(LEADER_A);
      const second = effects(LEADER_A);
      const outcomes = await Promise.allSettled([decide(LEADER_A, task, 'approve', accept, first), decide(LEADER_A, task, 'approve', accept, second)]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const rejected = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toMatchObject({ code: 'TASK_ALREADY_DECIDED', status: 409 });
      const decided = [...first.recorded.events, ...second.recorded.events].filter((event) => event.type === 'adm.approval_task.decided.v1');
      expect(decided).toHaveLength(1);
      expect((await instanceRow(instance.id))?.status).toBe('Completed');
    });

    it('AC-ST-ADM-013-2, UAT-AC132: an instance runs to its end by the version it started on, and the one that starts after a publication runs by the new one', async () => {
      const first = await publishDefinition(PAYMENT, definitionOf([step('only', { assignee_rule: specific(LEADER_A) })], paymentCommands));
      const { instance: older } = await start(PAYMENT);
      const second = await publishDefinition(PAYMENT, definitionOf([step('first', { assignee_rule: specific(LEADER_A) }), step('second', { assignee_rule: specific(LEADER_B) })], paymentCommands));
      const { instance: newer } = await start(PAYMENT);
      expect((await instanceRow(older.id))?.workflow_version_id).toBe(first);
      expect((await instanceRow(newer.id))?.workflow_version_id).toBe(second);
      // The older one completes after one approval, as its version says; the newer one moves to the second step.
      await decide(LEADER_A, await taskOf(older.id, LEADER_A), 'approve');
      expect(await instanceRow(older.id)).toMatchObject({ status: 'Completed', outcome: 'APPROVED' });
      await decide(LEADER_A, await taskOf(newer.id, LEADER_A), 'approve');
      expect(await instanceRow(newer.id)).toMatchObject({ status: 'Running', current_step: 1 });
    });

    it('AC-ST-ADM-013-3, UAT-AC133: a record the module refuses at the end of the approval ends the instance as GUARD_REJECTED with an alert event, and the final command is asked once', async () => {
      await publishDefinition(PLAN, definitionOf([step('only', { assignee_rule: specific(LEADER_A) })], planCommands));
      const { instance } = await start(PLAN);
      const asked: string[] = [];
      const withdrawn: FinalCommand = ({ idempotencyKey }) => {
        asked.push(idempotencyKey);
        return Promise.resolve('GUARD_REJECTED');
      };
      const e = effects(LEADER_A);
      await decide(LEADER_A, await taskOf(instance.id, LEADER_A), 'approve', withdrawn, e);
      expect(await instanceRow(instance.id)).toMatchObject({ status: 'Completed', outcome: 'GUARD_REJECTED' });
      expect(e.recorded.events.map((event) => event.type)).toContain('adm.workflow_guard_rejected.v1');
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatch(/^wf:[0-9a-f-]+:final:1$/);
    });
  });

  describe('reassignApprovalTask (ADM 3.7 item 8)', () => {
    it('gives a pending task to a person who can decide it: the old task is Reassigned, the new one is Pending with the same deadline, and the new assignee decides', async () => {
      await publishDefinition(REPORT, definitionOf([step('review', { assignee_rule: roleLeaders })]));
      const { instance } = await start(REPORT);
      await harness.seedGrants(TENANT_A, [{ n: 40, member: SPARE, role: LEADER_ROLE, kind: 'TENANT' }]);
      const old = await taskOf(instance.id, LEADER_A);
      const e = effects(OPERATOR);
      const done = await reassign(old, SPARE, 'the assignee is on leave this week', e);
      expect(done.from).toMatchObject({ id: old.id, status: 'Reassigned' });
      expect(done.task).toMatchObject({ assigneeId: memberId(SPARE), status: 'Pending', dueAt: done.from.dueAt, reassignedFromId: old.id });
      expect(e.recorded.audits).toEqual(['approval.reassigned']);
      expect(e.recorded.events).toEqual([expect.objectContaining({ type: 'adm.approval_task.reassigned.v1', payload: expect.objectContaining({ task_id: old.id, new_task_id: done.task.id, from_membership_id: memberId(LEADER_A), to_membership_id: memberId(SPARE), reason: 'OPERATOR' }) })]);
      expect((await tasksOf(instance.id)).find((task) => task.id === old.id)?.reason).toBe('the assignee is on leave this week');
      // The old assignee can no longer decide; the new one can.
      expect(await refusal(decide(LEADER_A, old, 'approve'))).toMatchObject({ code: 'TASK_ALREADY_DECIDED', status: 409 });
      await decide(SPARE, { id: done.task.id, version: done.task.version }, 'approve');
      expect(await instanceRow(instance.id)).toMatchObject({ status: 'Completed', outcome: 'APPROVED' });
    });

    it('refuses a new assignee who is the maker, one who is already in the step, one who cannot decide, one who is unknown and the same person, and changes nothing', async () => {
      await publishDefinition(REPORT, definitionOf([step('review', { assignee_rule: roleLeaders })]));
      const { instance } = await start(REPORT);
      const old = await taskOf(instance.id, LEADER_A);
      const before = await tasksOf(instance.id);
      expect(await refusal(reassign(old, MAKER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(reassign(old, LEADER_B))).toMatchObject({ code: 'APPROVER_NOT_AUTHORIZED', status: 403, extensions: { cause: 'IN_STEP' } });
      expect(await refusal(reassign(old, OFFICER))).toMatchObject({ code: 'APPROVER_NOT_AUTHORIZED', status: 403, extensions: { cause: 'NOT_AUTHORISED' } });
      expect(await refusal(reassign(old, LEADER_A))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
      const unknown = await refusal(as((tx) => store.reassignTask(tx, effects(OPERATOR), { taskId: old.id, expectedVersion: Number(old.version), newAssignee: randomUUID(), reason: 'a reason that is long enough', now: later(2) })));
      expect(unknown).toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
      expect(await tasksOf(instance.id)).toEqual(before);
    });

    it('refuses a task that was decided (409 TASK_ALREADY_DECIDED), a stale version (409 VERSION_CONFLICT) and a task that is not there (404)', async () => {
      await publishDefinition(REPORT, definitionOf([step('review', { assignee_rule: roleLeaders, min_approvals: 2 })]));
      const { instance } = await start(REPORT);
      await harness.seedGrants(TENANT_A, [{ n: 41, member: EXTRA, role: LEADER_ROLE, kind: 'TENANT' }]);
      const task = await taskOf(instance.id, LEADER_B);
      const stale = { id: task.id, version: Number(task.version) - 1 };
      expect(await refusal(reassign(stale, EXTRA))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      await decide(LEADER_B, task, 'approve');
      expect(await refusal(reassign({ id: task.id, version: Number(task.version) + 1 }, EXTRA))).toMatchObject({ code: 'TASK_ALREADY_DECIDED', status: 409 });
      expect(await refusal(reassign({ id: randomUUID(), version: 1 }, EXTRA))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });
  });

  describe('cancelWorkflowInstance (ADM 3.7 item 7)', () => {
    it('ends a running instance with a reason: its open tasks are Cancelled, the audit row and the event are written, and no one decides afterwards', async () => {
      await publishDefinition(REPORT, definitionOf([step('review', { assignee_rule: roleLeaders })]));
      const { instance } = await start(REPORT);
      const task = await taskOf(instance.id, LEADER_C);
      const e = effects(OPERATOR);
      const cancelled = await as((tx) => store.cancelInstance(tx, e, { instanceId: instance.id, expectedVersion: instance.version, reason: 'the record was withdrawn by its owner', now: NOW }));
      expect(cancelled).toMatchObject({ status: 'Cancelled', outcome: 'CANCELLED' });
      expect((await tasksOf(instance.id)).every((row) => row.status === 'Cancelled')).toBe(true);
      expect(e.recorded.audits).toEqual(['workflow.instance_cancelled']);
      expect(e.recorded.events).toEqual([expect.objectContaining({ type: 'adm.workflow_instance.cancelled.v1', payload: expect.objectContaining({ instance_id: instance.id, outcome: 'CANCELLED', by: 'OPERATOR' }) })]);
      expect(await refusal(decide(LEADER_C, task, 'approve'))).toMatchObject({ code: 'TASK_ALREADY_DECIDED', status: 409 });
    });

    it('refuses an instance that is not running (409 WORKFLOW_STATE_INVALID), a stale version (409 VERSION_CONFLICT) and one that is not there (404)', async () => {
      await publishDefinition(REPORT, definitionOf([step('review', { assignee_rule: roleLeaders })]));
      const { instance } = await start(REPORT);
      expect(await refusal(as((tx) => store.cancelInstance(tx, effects(OPERATOR), { instanceId: instance.id, expectedVersion: instance.version + 5, reason: 'a reason that is long enough', now: NOW })))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      await decide(LEADER_A, await taskOf(instance.id, LEADER_A), 'approve');
      const done = await instanceRow(instance.id);
      expect(await refusal(as((tx) => store.cancelInstance(tx, effects(OPERATOR), { instanceId: instance.id, expectedVersion: Number(done?.version), reason: 'a reason that is long enough', now: NOW })))).toMatchObject({ code: 'WORKFLOW_STATE_INVALID', status: 409 });
      expect(await refusal(as((tx) => store.cancelInstance(tx, effects(OPERATOR), { instanceId: randomUUID(), expectedVersion: 1, reason: 'a reason that is long enough', now: NOW })))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('the module cancelling a withdrawn record uses the same ending, and with nothing running it does nothing', async () => {
      await publishDefinition(REPORT, definitionOf([step('review', { assignee_rule: roleLeaders })]));
      const resourceId = randomUUID();
      const e = effects(MAKER);
      const instance = await as((tx) => store.start(tx, e, { resourceType: 'record', resourceId, resourceVersion: 1, businessType: REPORT, amountVnd: '1', unitId: unitId(ROOT), initiatorMembershipId: memberId(MAKER), now: NOW }), MAKER);
      expect(await as((tx) => store.cancel(tx, effects(MAKER), { resourceType: 'record', resourceId, reason: 'withdrawn by the owner', now: NOW }), MAKER)).toBe(true);
      expect((await instanceRow(instance.id))?.status).toBe('Cancelled');
      expect(await as((tx) => store.cancel(tx, effects(MAKER), { resourceType: 'record', resourceId, reason: 'withdrawn by the owner', now: NOW }), MAKER)).toBe(false);
    });
  });

  describe('the SLA of the open tasks (ADM 3.7 item 4)', () => {
    // A pass looks at every open task of the tenant: the tasks the other tests left open are closed, so that the counts below are those of the test.
    beforeEach(async () => {
      await harness.owner(TENANT_A, [
        ["update machvon.approval_task set status = 'Cancelled' where status = 'Pending'", []],
        ["update machvon.workflow_instance set status = 'Cancelled', outcome = 'CANCELLED', ended_at = now() where status = 'Running'", []],
      ]);
    });

    it('a task gets its reminder point at 80 percent of the working time to its deadline when it is created', async () => {
      await publishDefinition(PLAN, definitionOf([step('only', { assignee_rule: specific(LEADER_A), sla_working_hours: 9 })], planCommands));
      const { instance } = await start(PLAN);
      const [task] = await tasksOf(instance.id);
      const due = at(task?.due_at ?? null).getTime();
      const remind = at(task?.remind_at ?? null).getTime();
      expect(remind).toBeLessThan(due);
      expect(remind).toBeGreaterThan(NOW.getTime());
      // With no calendar published a 9 hour SLA is due in two days; the reminder is at 80 percent of that, not at a whole day (50 percent).
      const share = (remind - NOW.getTime()) / (due - NOW.getTime());
      expect(share).toBeGreaterThan(0.79);
      expect(share).toBeLessThan(0.81);
    });

    it('the migration gives the tasks that were open before it a reminder point, so that they are reminded before their deadline too', async () => {
      await publishDefinition(PLAN, definitionOf([step('only', { assignee_rule: specific(LEADER_A) })], planCommands));
      const { instance } = await start(PLAN);
      await harness.owner(TENANT_A, [['update machvon.approval_task set remind_at = null where workflow_instance_id = $1', [instance.id]]]);
      const migration = readFileSync(join(__dirname, '../../../db/migrations/V1306__adm1_approval_sla_operations.sql'), 'utf8');
      const backfill = /^(UPDATE machvon.approval_task SET remind_at[^;]*);$/m.exec(migration)?.[1];
      expect(backfill).toBeDefined();
      await harness.owner(TENANT_A, [[backfill as string, []]]);
      const [task] = await tasksOf(instance.id);
      const created = (await owner<{ at: string }>(`select ${ISO('created_at')} as at from machvon.approval_task where id = $1`, [task?.id]))[0]?.at;
      const share = (at(task?.remind_at ?? null).getTime() - at(created ?? null).getTime()) / (at(task?.due_at ?? null).getTime() - at(created ?? null).getTime());
      expect(share).toBeGreaterThan(0.79);
      expect(share).toBeLessThan(0.81);
      const e = effects(OPERATOR);
      // The backfilled point has the microseconds of the creation: the pass is a second after it.
      expect(await sweep(new Date(at(task?.remind_at ?? null).getTime() + 1000), e)).toMatchObject({ reminded: 1 });
    });

    it('reminds once at the reminder point, not before it and not twice', async () => {
      await publishDefinition(PLAN, definitionOf([step('only', { assignee_rule: specific(LEADER_A) })], planCommands));
      const { instance } = await start(PLAN);
      const [task] = await tasksOf(instance.id);
      const remindAt = at(task?.remind_at ?? null);
      const before = effects(OPERATOR);
      expect(await sweep(new Date(remindAt.getTime() - 60_000), before)).toMatchObject({ reminded: 0, overdueReminded: 0 });
      expect(before.recorded.events).toEqual([]);
      const due = effects(OPERATOR);
      expect(await sweep(remindAt, due)).toMatchObject({ reminded: 1, breached: 0 });
      expect(due.recorded.events).toEqual([expect.objectContaining({ type: 'adm.approval_task.reminded.v1', payload: expect.objectContaining({ task_id: task?.id, kind: 'BEFORE_DUE', assignee_id: memberId(LEADER_A) }) })]);
      const again = effects(OPERATOR);
      await sweep(new Date(remindAt.getTime() + 60_000), again);
      expect(again.recorded.events).toEqual([]);
    });

    it('REMIND: at the deadline the first overdue reminder is the breach, and the next one comes a working day later', async () => {
      await publishDefinition(PLAN, definitionOf([step('only', { assignee_rule: specific(LEADER_A), on_timeout: 'REMIND' })], planCommands));
      const { instance } = await start(PLAN);
      const [task] = await tasksOf(instance.id);
      const dueAt = at(task?.due_at ?? null);
      const first = effects(OPERATOR);
      expect(await sweep(dueAt, first)).toMatchObject({ overdueReminded: 1, breached: 1 });
      expect(first.recorded.events.map((event) => [event.type, event.payload.kind])).toEqual([['adm.approval_task.reminded.v1', 'OVERDUE']]);
      expect((await tasksOf(instance.id))[0]).toMatchObject({ overdue_reminders: 1 });
      const nextAt = at((await tasksOf(instance.id))[0]?.next_reminder_at ?? null);
      expect(nextAt.getTime()).toBeGreaterThan(dueAt.getTime());
      // Swept again in the same minute it does nothing; a working day later it reminds again, and that is not a new breach.
      expect(await sweep(new Date(dueAt.getTime() + 60_000))).toMatchObject({ overdueReminded: 0, breached: 0 });
      expect(await sweep(nextAt)).toMatchObject({ overdueReminded: 1, breached: 0 });
      // The task is still open and can still be decided.
      await decide(LEADER_A, (await tasksOf(instance.id))[0] as TaskRow, 'approve');
      expect((await instanceRow(instance.id))?.status).toBe('Completed');
    });

    it('ESCALATE: at the deadline the task is also given to the escalation target, once; the target decides and the step is done', async () => {
      await publishDefinition(PLAN, definitionOf([step('only', { assignee_rule: specific(LEADER_A), on_timeout: 'ESCALATE', escalate_to: memberId(LEADER_B) })], planCommands));
      const { instance } = await start(PLAN);
      const [task] = await tasksOf(instance.id);
      const e = effects(OPERATOR);
      expect(await sweep(at(task?.due_at ?? null), e)).toMatchObject({ escalated: 1, breached: 1, escalationFailed: 0 });
      expect(e.recorded.audits).toEqual(['approval.escalated']);
      expect(e.recorded.events.map((event) => event.type)).toEqual(['adm.approval_task.escalated.v1']);
      const tasks = await tasksOf(instance.id);
      expect(tasks).toHaveLength(2);
      const escalated = tasks.find((row) => row.assignee_id === memberId(LEADER_B));
      expect(escalated).toMatchObject({ status: 'Pending', escalated_from_task_id: task?.id });
      expect(tasks.find((row) => row.assignee_id === memberId(LEADER_A))?.status).toBe('Pending');
      // The task they were given is a task of its own: when its deadline passes it is the breach of that task, counted once.
      expect(await sweep(at(escalated?.due_at ?? null))).toMatchObject({ breached: 1 });
      expect(await sweep(at(escalated?.due_at ?? null))).toMatchObject({ breached: 0 });
      // Once: the same pass again does not give it to anyone else.
      expect(await sweep(at(task?.due_at ?? null))).toMatchObject({ escalated: 0 });
      expect(await tasksOf(instance.id)).toHaveLength(2);
      // The target, who is not in the list of the step, decides the task they were given.
      await decide(LEADER_B, escalated as TaskRow, 'approve');
      expect(await instanceRow(instance.id)).toMatchObject({ status: 'Completed', outcome: 'APPROVED' });
    });

    it('ESCALATE to a person who cannot hold the task is said, the task stays with its assignee and goes on being reminded', async () => {
      await publishDefinition(PLAN, definitionOf([step('only', { assignee_rule: specific(LEADER_A), on_timeout: 'ESCALATE', escalate_to: memberId(OFFICER) })], planCommands));
      const { instance } = await start(PLAN);
      const [task] = await tasksOf(instance.id);
      const e = effects(OPERATOR);
      expect(await sweep(at(task?.due_at ?? null), e)).toMatchObject({ escalated: 0, escalationFailed: 1 });
      expect(e.recorded.audits).toEqual(['approval.escalation_failed']);
      expect(await tasksOf(instance.id)).toHaveLength(1);
      expect((await tasksOf(instance.id))[0]?.next_reminder_at).not.toBeNull();
    });

    it('ESCALATE does not lower the DoA band: the escalation target is not given the task when the step opens nor by a reassignment, only by the escalation, and then decides it', async () => {
      await publishDefinition(REPORT, definitionOf([step('review', { on_timeout: 'ESCALATE', escalate_to: memberId(LOW) })]));
      const { instance } = await start(REPORT);
      // The target holds the right to decide but not the rank of the band: no task at the start, and no reassignment of an ordinary task to them.
      expect((await tasksOf(instance.id)).some((task) => task.assignee_id === memberId(LOW))).toBe(false);
      const ordinary = await taskOf(instance.id, LEADER_A);
      expect(await refusal(reassign(ordinary, LOW))).toMatchObject({ code: 'APPROVER_NOT_AUTHORIZED', status: 403, extensions: { cause: 'NOT_AUTHORISED' } });
      const e = effects(OPERATOR);
      expect(await sweep(at(ordinary.due_at), e)).toMatchObject({ escalated: 1, escalationFailed: 0 });
      const given = await taskOf(instance.id, LOW);
      expect(given.escalated_from_task_id).not.toBeNull();
      await decide(LOW, given, 'approve');
      expect(await instanceRow(instance.id)).toMatchObject({ status: 'Completed', outcome: 'APPROVED' });
    });

    it('a reassigned task keeps the reminder history of the task it replaces: no second reminder at once and no second breach', async () => {
      await publishDefinition(REPORT, definitionOf([step('review', { assignee_rule: roleLeaders, on_timeout: 'REMIND' })]));
      const { instance } = await start(REPORT);
      const old = await taskOf(instance.id, LEADER_A);
      const dueAt = at(old.due_at);
      expect(await sweep(dueAt)).toMatchObject({ breached: expect.any(Number) });
      await harness.seedGrants(TENANT_A, [{ n: 60, member: FREE, role: LEADER_ROLE, kind: 'TENANT' }]);
      const reminded = await taskOf(instance.id, LEADER_A);
      expect(reminded.overdue_reminders).toBe(1);
      const done = await reassign(reminded, FREE);
      const clone = (await tasksOf(instance.id)).find((task) => task.id === done.task.id);
      expect(clone).toMatchObject({ overdue_reminders: 1, reassigned_from_task_id: old.id });
      expect(clone?.next_reminder_at).toBe(reminded.next_reminder_at);
      const again = effects(OPERATOR);
      await sweep(new Date(dueAt.getTime() + 60_000), again);
      expect(again.recorded.events.filter((event) => event.payload.task_id === done.task.id)).toEqual([]);
    });

    it('EXPIRE: the task at its deadline expires; the instance ends as EXPIRED only when the step can no longer reach the approvals it needs', async () => {
      await publishDefinition(PLAN, definitionOf([step('only', { assignee_rule: specific(LEADER_A, LEADER_B, LEADER_C), min_approvals: 2, on_timeout: 'EXPIRE' })], planCommands));
      const { instance } = await start(PLAN);
      await decide(LEADER_A, await taskOf(instance.id, LEADER_A), 'approve');
      const tasks = await tasksOf(instance.id);
      const dueAt = at(tasks[0]?.due_at ?? null);
      const e = effects(OPERATOR);
      const result = await sweep(dueAt, e);
      expect(result).toMatchObject({ expired: 2, instancesExpired: 1 });
      expect(await instanceRow(instance.id)).toMatchObject({ status: 'Completed', outcome: 'EXPIRED' });
      expect(e.recorded.audits).toEqual(['approval.task_expired', 'approval.task_expired', 'workflow.instance_expired']);
      expect(e.recorded.events.filter((event) => event.type === 'adm.workflow_instance.completed.v1')).toEqual([expect.objectContaining({ payload: expect.objectContaining({ outcome: 'EXPIRED', command: null }) })]);
    });

    it('a pass leaves alone the tasks that are decided or cancelled and the instance that a command holds', async () => {
      await publishDefinition(PLAN, definitionOf([step('only', { assignee_rule: specific(LEADER_A) })], planCommands));
      const { instance } = await start(PLAN);
      const [task] = await tasksOf(instance.id);
      const dueAt = at(task?.due_at ?? null);
      // A command holds the lock of the instance: the pass skips the task and does it in the next pass.
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      let locked: () => void = () => undefined;
      const lockTaken = new Promise<void>((resolve) => (locked = resolve));
      const holder = as(async (tx) => {
        await tx.query('select id from machvon.workflow_instance where id = $1::uuid for update', [instance.id]);
        locked();
        await held;
      });
      await lockTaken;
      const e = effects(OPERATOR);
      expect(await sweep(dueAt, e)).toMatchObject({ overdueReminded: 0, breached: 0 });
      expect(e.recorded.events).toEqual([]);
      release();
      await holder;
      expect(await sweep(dueAt)).toMatchObject({ overdueReminded: 1 });
      await decide(LEADER_A, (await tasksOf(instance.id))[0] as TaskRow, 'approve');
      expect(await sweep(new Date(dueAt.getTime() + 3 * 24 * 3_600_000))).toMatchObject({ overdueReminded: 0, expired: 0, open: expect.any(Number) });
    });
  });
});
