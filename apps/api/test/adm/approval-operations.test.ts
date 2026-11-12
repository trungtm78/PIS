import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { ApprovalStore, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { ApprovalCommandsController, ApprovalTaskReadsController, WorkflowInstanceReadsController, WorkflowVersionReadsController } from '../../src/modules/adm/approval.controller';
import { APPROVAL_FINAL_COMMANDS, FinalCommandRegistry } from '../../src/modules/adm/approval.service';
import { ADM_METRICS } from '../../src/modules/adm/tokens';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { CLAIMS_HEADER, TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const ADMIN = 1; // writes definitions, operates the approvals on the whole tenant
const PUBLISHER = 2;
const MAKER = 3; // a leader who submits records
const LEADER_A = 4;
const LEADER_B = 5;
const SPARE = 6; // gets the leader role after the approval started
const NOBODY = 7;
const UNIT_OPERATOR = 8; // operates on a unit subtree only
const OTHER_TENANT = 9;
const ROOT = 1;
const LEADER_ROLE = 1;
const OPERATE_ROLE = 2;

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

const definition = { steps: [{ id: 'review', name: 'Bước review', assignee_rule: { type: 'ROLE_IN_UNIT', role_code: 'LEADER', unit_id: unitId(ROOT) }, min_approvals: 1, sla_working_hours: 16, on_timeout: 'REMIND' }], terminal: { approved: 'acceptReport', returned: 'returnReport', rejected: 'rejectReport' } };
const REASON = 'Hồ sơ được chủ sở hữu rút lại trước khi duyệt.';

describe('cancelWorkflowInstance, reassignApprovalTask and the monitor reads over HTTP (ST-ADM-013)', () => {
  const harness = new AuthzHarness();
  const store = new ApprovalStore();
  const registry = new FinalCommandRegistry();
  let app: RunningApp;
  let tenants: TenantDatabase;
  const increments: Array<[string, Record<string, string> | undefined]> = [];

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function call(method: 'GET' | 'POST' | 'PUT', url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string; claims?: Record<string, unknown> }): Promise<Reply> {
    const claims = options.claims === undefined ? {} : { ...options.claims, ...(options.claims.aal === 'aal2' ? { aal2At: new Date().toISOString() } : {}) };
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json', [CLAIMS_HEADER]: JSON.stringify(claims) };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
  const rows = async <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);
  const outbox = (id: string, type: string) => rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2', [id, type]);
  const auditRows = (resourceId: string, action: string) => rows<{ reason: string | null }>('select reason from machvon.audit_event where resource_id = $1 and action = $2', [resourceId, action]);

  async function startInstance(): Promise<{ id: string; version: number }> {
    const instance = await harness.tenants.withTenant(contextFor(TENANT_A, memberId(MAKER)), (tx) =>
      store.start(
        tx,
        { actor: memberId(MAKER), audit: () => Promise.resolve(), emit: () => Promise.resolve() },
        { resourceType: 'report', resourceId: randomUUID(), resourceVersion: 1, businessType: 'report.accept', amountVnd: '1000000', unitId: unitId(ROOT), initiatorMembershipId: memberId(MAKER), now: new Date() },
      ),
    );
    return { id: instance.id, version: instance.version };
  }
  const taskOf = async (instanceId: string, member: number) => {
    const [task] = await rows<{ id: string; version: string }>("select id, version::text from machvon.approval_task where workflow_instance_id = $1 and assignee_id = $2 and status = 'Pending'", [instanceId, memberId(member)]);
    return task as { id: string; version: string };
  };

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
    for (const n of [ADMIN, PUBLISHER, MAKER, LEADER_A, LEADER_B, SPARE, NOBODY, UNIT_OPERATOR]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, OTHER_TENANT, ROOT);
    await harness.seedRole(TENANT_A, LEADER_ROLE, 'LEADER', ['approval.decide', 'approval_task.read', 'workflow_instance.read'], 60);
    await harness.seedRole(TENANT_A, OPERATE_ROLE, 'WORKFLOW_OPERATOR', ['adm.workflow.manage', 'adm.workflow.operate', 'workflow_version.read', 'workflow_instance.read', 'approval_task.read'], 50);
    await harness.seedRole(TENANT_A, 3, 'WORKFLOW_PUBLISHER', ['adm.workflow.publish', 'workflow_version.read'], 50);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ADMIN, role: OPERATE_ROLE, kind: 'TENANT' },
      { n: 2, member: PUBLISHER, role: 3, kind: 'TENANT' },
      { n: 3, member: MAKER, role: LEADER_ROLE, kind: 'TENANT' },
      { n: 4, member: LEADER_A, role: LEADER_ROLE, kind: 'TENANT' },
      { n: 5, member: LEADER_B, role: LEADER_ROLE, kind: 'TENANT' },
      { n: 6, member: UNIT_OPERATOR, role: OPERATE_ROLE, kind: 'UNIT_SUBTREE', refs: [unitId(ROOT)] },
    ]);
    await harness.seedRole(TENANT_B, 1, 'WORKFLOW_OPERATOR', ['workflow_instance.read', 'adm.workflow.operate'], 10);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT, role: 1, kind: 'TENANT' }]);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [ApprovalCommandsController, WorkflowVersionReadsController, WorkflowInstanceReadsController, ApprovalTaskReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APPROVAL_FINAL_COMMANDS, useValue: registry },
        { provide: ADM_METRICS, useValue: { increment: (name: string, labels?: Record<string, string>) => void increments.push([name, labels]), gauge: () => undefined } },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
    const created = await call('POST', '/workflow-definitions', { member: ADMIN, body: { business_type: 'report.accept', definition } });
    expect(created.status).toBe(200);
    expect(await call('POST', `/workflow-definitions/${created.json.resource_id as string}/publish`, { member: PUBLISHER, ifMatch: '"1"', body: { reason: 'Công bố quy trình mới theo quy chế nội bộ.' } })).toMatchObject({ status: 200 });
  }, 240_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  describe('cancelWorkflowInstance', () => {
    it('ends a running instance for an operator with a reason: 202, the tasks Cancelled, the audit row with the reason and the event', async () => {
      const instance = await startInstance();
      const done = await call('POST', `/workflow-instances/${instance.id}/cancel`, { member: ADMIN, ifMatch: `"${instance.version}"`, body: { reason: REASON } });
      expect(done).toMatchObject({ status: 202, json: { status: 'CANCELLED', resource_id: instance.id } });
      expect((await rows<{ status: string; outcome: string }>('select status, outcome from machvon.workflow_instance where id = $1', [instance.id]))[0]).toEqual({ status: 'Cancelled', outcome: 'CANCELLED' });
      expect((await rows<{ status: string }>('select status from machvon.approval_task where workflow_instance_id = $1', [instance.id])).every((task) => task.status === 'Cancelled')).toBe(true);
      expect((await auditRows(instance.id, 'workflow.instance_cancelled')).map((row) => row.reason)).toEqual([REASON]);
      expect((await outbox(instance.id, 'adm.workflow_instance.cancelled.v1'))[0]?.payload).toMatchObject({ instance_id: instance.id, outcome: 'CANCELLED', by: 'OPERATOR' });
    });

    it('is refused without the right to operate on the whole tenant, without a reason, without If-Match, when stale, when it is not running and across tenants', async () => {
      const instance = await startInstance();
      const url = `/workflow-instances/${instance.id}/cancel`;
      const ifMatch = `"${instance.version}"`;
      expect(await call('POST', url, { member: LEADER_A, ifMatch, body: { reason: REASON } })).toMatchObject({ status: 403 });
      expect(await call('POST', url, { member: NOBODY, ifMatch, body: { reason: REASON } })).toMatchObject({ status: 403 });
      expect(await call('POST', url, { member: UNIT_OPERATOR, ifMatch, body: { reason: REASON } })).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect(await call('POST', url, { member: ADMIN, ifMatch, body: { reason: 'short' } })).toMatchObject({ status: 422 });
      expect(await call('POST', url, { member: ADMIN, body: { reason: REASON } })).toMatchObject({ status: 428 });
      expect(await call('POST', url, { member: ADMIN, ifMatch: '"99"', body: { reason: REASON } })).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect(await call('POST', url, { member: OTHER_TENANT, tenantId: TENANT_B, ifMatch, body: { reason: REASON } })).toMatchObject({ status: 404 });
      expect((await rows<{ status: string }>('select status from machvon.workflow_instance where id = $1', [instance.id]))[0]?.status).toBe('Running');
      expect(await call('POST', url, { member: ADMIN, ifMatch, body: { reason: REASON } })).toMatchObject({ status: 202 });
      const ended = (await rows<{ version: string }>('select version::text from machvon.workflow_instance where id = $1', [instance.id]))[0];
      expect(await call('POST', url, { member: ADMIN, ifMatch: `"${ended?.version}"`, body: { reason: REASON } })).toMatchObject({ status: 409, json: { code: 'WORKFLOW_STATE_INVALID' } });
    });
  });

  describe('reassignApprovalTask', () => {
    it('gives a pending task to a person who can decide it: the new task is returned, the old one Reassigned, the audit row and the event written', async () => {
      const instance = await startInstance();
      await harness.seedGrants(TENANT_A, [{ n: 40, member: SPARE, role: LEADER_ROLE, kind: 'TENANT' }]);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const task = await taskOf(instance.id, LEADER_A);
      const done = await call('POST', `/approval-tasks/${task.id}/reassign`, { member: ADMIN, ifMatch: `"${task.version}"`, body: { new_assignee_membership_id: memberId(SPARE), reason: REASON } });
      expect(done).toMatchObject({ status: 200, json: { status: 'REASSIGNED' } });
      const created = done.json.resource_id as string;
      expect(created).not.toBe(task.id);
      expect((await rows<{ status: string }>('select status from machvon.approval_task where id = $1', [task.id]))[0]?.status).toBe('Reassigned');
      expect((await rows<{ assignee_id: string; status: string }>('select assignee_id, status from machvon.approval_task where id = $1', [created]))[0]).toEqual({ assignee_id: memberId(SPARE), status: 'Pending' });
      expect((await auditRows(task.id, 'approval.reassigned')).map((row) => row.reason)).toEqual([REASON]);
      expect((await outbox(task.id, 'adm.approval_task.reassigned.v1'))[0]?.payload).toMatchObject({ new_task_id: created, to_membership_id: memberId(SPARE), reason: 'OPERATOR' });
    });

    it('is refused for the maker, for a person who is in the step already, for one who cannot decide, and without the right to operate', async () => {
      const instance = await startInstance();
      const task = await taskOf(instance.id, LEADER_A);
      const url = `/approval-tasks/${task.id}/reassign`;
      const ifMatch = `"${task.version}"`;
      const body = (to: number) => ({ new_assignee_membership_id: memberId(to), reason: REASON });
      expect(await call('POST', url, { member: ADMIN, ifMatch, body: body(MAKER) })).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect(await call('POST', url, { member: ADMIN, ifMatch, body: body(LEADER_B) })).toMatchObject({ status: 403, json: { code: 'APPROVER_NOT_AUTHORIZED' } });
      expect(await call('POST', url, { member: ADMIN, ifMatch, body: body(NOBODY) })).toMatchObject({ status: 403, json: { code: 'APPROVER_NOT_AUTHORIZED' } });
      expect(await call('POST', url, { member: LEADER_B, ifMatch, body: body(NOBODY) })).toMatchObject({ status: 403 });
      expect(await call('POST', url, { member: UNIT_OPERATOR, ifMatch, body: body(NOBODY) })).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect(await call('POST', url, { member: ADMIN, ifMatch, body: { new_assignee_membership_id: memberId(NOBODY), reason: 'short' } })).toMatchObject({ status: 422 });
      expect(await call('POST', url, { member: ADMIN, body: body(NOBODY) })).toMatchObject({ status: 428 });
      expect(await call('POST', url, { member: ADMIN, ifMatch: '"99"', body: body(NOBODY) })).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect((await rows<{ status: string }>('select status from machvon.approval_task where id = $1', [task.id]))[0]?.status).toBe('Pending');
    });
  });

  describe('the decision re-sent, and the reads of the monitor', () => {
    it('AC-ST-ADM-013-4, UAT-AC131: a decision re-sent with the same key replays the first result and leaves one audit row', async () => {
      const instance = await startInstance();
      const task = await taskOf(instance.id, LEADER_B);
      const send = () => call('POST', `/approval-tasks/${task.id}/decision`, { member: LEADER_B, ifMatch: `"${task.version}"`, key: 'replayed-decision-key-0001', body: { decision: 'approve' }, claims: { aal: 'aal2' } });
      const first = await send();
      const again = await send();
      expect(first.status).toBe(200);
      expect(again).toEqual(first);
      expect(await auditRows(task.id, 'approval.task_decided')).toHaveLength(1);
      expect(await outbox(task.id, 'adm.approval_task.decided.v1')).toHaveLength(1);
      // The same key with another body is not a replay.
      expect(await call('POST', `/approval-tasks/${task.id}/decision`, { member: LEADER_B, ifMatch: `"${task.version}"`, key: 'replayed-decision-key-0001', body: { decision: 'reject', reason: REASON }, claims: { aal: 'aal2' } })).toMatchObject({ status: 409, json: { code: 'IDEMPOTENCY_CONFLICT' } });
    });

    it('UAT-AC130 two people of the group decide at the same moment, with two different keys and the first version of the task: exactly one answer is 200, the other is 409 TASK_ALREADY_DECIDED or VERSION_CONFLICT, and one decision, one audit row and one event come of it', async () => {
      const instance = await startInstance();
      const taskA = await taskOf(instance.id, LEADER_A);
      const taskB = await taskOf(instance.id, LEADER_B);
      const decide = (member: number, task: { id: string; version: string }, key: string): Promise<Reply> =>
        call('POST', `/approval-tasks/${task.id}/decision`, { member, ifMatch: `"${task.version}"`, key, body: { decision: 'approve' }, claims: { aal: 'aal2' } });
      // The group has two members who are both entitled; the step needs one approval. The two hand their decision in at the same moment.
      const answers = await Promise.all([decide(LEADER_A, taskA, 'uat-ac130-a-0000000001'), decide(LEADER_B, taskB, 'uat-ac130-b-0000000002')]);
      expect(answers.filter((answer) => answer.status === 200)).toHaveLength(1);
      const refused = answers.find((answer) => answer.status !== 200) as Reply;
      expect(refused.status).toBe(409);
      expect(['TASK_ALREADY_DECIDED', 'VERSION_CONFLICT']).toContain(refused.json.code);
      // One decision is recorded: the instance is Completed once, one audit row of the decision and one decided event reach the consumers (the engine runs in the database, so its signal is that event).
      expect(await rows<{ status: string; outcome: string }>('select status, outcome from machvon.workflow_instance where id = $1', [instance.id])).toEqual([{ status: 'Completed', outcome: 'APPROVED' }]);
      const audits = await Promise.all([taskA.id, taskB.id].map((id) => auditRows(id, 'approval.task_decided')));
      expect(audits.flat()).toHaveLength(1);
      const events = await Promise.all([taskA.id, taskB.id].map((id) => outbox(id, 'adm.approval_task.decided.v1')));
      expect(events.flat()).toHaveLength(1);
      // The same person with two keys at the same moment on one task is the same race: one 200 and one refusal.
      const second = await startInstance();
      const task = await taskOf(second.id, LEADER_A);
      const pair = await Promise.all([decide(LEADER_A, task, 'uat-ac130-c-0000000003'), decide(LEADER_A, task, 'uat-ac130-d-0000000004')]);
      expect(pair.filter((answer) => answer.status === 200)).toHaveLength(1);
      expect(['TASK_ALREADY_DECIDED', 'VERSION_CONFLICT']).toContain((pair.find((answer) => answer.status !== 200) as Reply).json.code);
      expect((await auditRows(task.id, 'approval.task_decided')).length).toBe(1);
      expect((await outbox(task.id, 'adm.approval_task.decided.v1')).length).toBe(1);
      // The negative control: a check that wants both answers to be 200 must fail on what was seen.
      expect(() => expect(answers.filter((answer) => answer.status === 200)).toHaveLength(2)).toThrow();
    });

    it('AC-ST-ADM-013-5: the monitor reads the pending tasks with the figures, the step, the version it runs by and what the viewer may do; a leader sees only their own and no operations', async () => {
      const instance = await startInstance();
      const operator = await call('GET', `/resources/approval_task?status=Pending&workflow_instance_id=${instance.id}`, { member: ADMIN });
      expect(operator.status).toBe(200);
      const items = operator.json.items as Array<Record<string, unknown>>;
      expect(items.length).toBeGreaterThanOrEqual(2);
      expect(items[0]).toMatchObject({
        step_name: 'Bước review',
        overdue: false,
        instance: { id: instance.id, version: instance.version, status: 'Running', document_type: 'REPORT_ACCEPT', amount_vnd: '1000000', workflow_revision: expect.any(Number) },
        actions: { reassign: true, cancel: true },
      });
      const leader = await call('GET', `/resources/approval_task?status=Pending&workflow_instance_id=${instance.id}`, { member: LEADER_A });
      const own = leader.json.items as Array<{ assignee: { id: string }; actions: Record<string, boolean> }>;
      expect(own.length).toBeGreaterThanOrEqual(1);
      expect(own.every((item) => item.assignee.id === memberId(LEADER_A) || item.actions.reassign === false)).toBe(true);
      expect(own.every((item) => item.actions.reassign === false && item.actions.cancel === false)).toBe(true);
    });

    it('AC-ST-ADM-013-3: an approval the owning module refuses at its end is counted for the operators, with the event, and the instance says so', async () => {
      registry.register('report.accept', () => Promise.resolve('GUARD_REJECTED'));
      try {
        const instance = await startInstance();
        const task = await taskOf(instance.id, LEADER_A);
        const done = await call('POST', `/approval-tasks/${task.id}/decision`, { member: LEADER_A, ifMatch: `"${task.version}"`, body: { decision: 'approve' }, claims: { aal: 'aal2' } });
        expect(done).toMatchObject({ status: 200, json: { status: 'GUARD_REJECTED' } });
        expect(increments).toContainEqual(['workflow_guard_rejected_total', { business_type: 'report.accept' }]);
        expect(await outbox(instance.id, 'adm.workflow_guard_rejected.v1')).toHaveLength(1);
        expect((await rows<{ outcome: string }>('select outcome from machvon.workflow_instance where id = $1', [instance.id]))[0]?.outcome).toBe('GUARD_REJECTED');
      } finally {
        registry.register('report.accept', () => Promise.resolve('APPLIED'));
      }
    });

    it('a task past its deadline is read as overdue', async () => {
      const instance = await startInstance();
      // The guard keeps the deadline of a task from being moved; the test moves it to have a task that is late.
      await harness.owner(TENANT_A, [
        ['alter table machvon.approval_task disable trigger approval_task_guard', []],
        ["update machvon.approval_task set due_at = now() - interval '2 hours', remind_at = now() - interval '5 hours' where workflow_instance_id = $1", [instance.id]],
        ['alter table machvon.approval_task enable trigger approval_task_guard', []],
      ]);
      const operator = await call('GET', `/resources/approval_task?status=Pending&workflow_instance_id=${instance.id}`, { member: ADMIN });
      const items = operator.json.items as Array<{ overdue: boolean }>;
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((item) => item.overdue)).toBe(true);
    });
  });
});
