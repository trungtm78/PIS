import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { ApprovalStore, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { ApprovalCommandsController, ApprovalTaskReadsController, WorkflowInstanceReadsController, WorkflowVersionReadsController } from '../../src/modules/adm/approval.controller';
import { APPROVAL_FINAL_COMMANDS, FinalCommandRegistry } from '../../src/modules/adm/approval.service';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, roleId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { CLAIMS_HEADER, TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const ADMIN = 1; // adm.workflow.manage
const PUBLISHER = 2; // adm.workflow.publish
const MAKER = 3; // a leader who submits records
const LEADER_A = 4;
const LEADER_B = 5;
const READER = 6; // reads definitions only
const NOBODY = 7;
const UNIT_ADMIN = 8; // manage on a unit subtree only
const DELEGATE = 10; // holds no right to decide, only to read
const OTHER_TENANT = 9;
const ROOT = 1;
const LEADER_ROLE = 1;

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

const definitionOf = (steps: unknown[]) => ({ steps, terminal: { approved: 'acceptReport', returned: 'returnReport', rejected: 'rejectReport' } });
const step = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: `Bước ${id}`, assignee_rule: { type: 'DOA' }, min_approvals: 1, sla_working_hours: 16, on_timeout: 'REMIND', ...extra });
const SECOND_FACTOR = { aal: 'aal2' };

describe('the approval workflows over HTTP (ST-ADM-012)', () => {
  const harness = new AuthzHarness();
  const store = new ApprovalStore();
  const registry = new FinalCommandRegistry();
  let app: RunningApp;
  let tenants: TenantDatabase;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function call(method: 'GET' | 'POST' | 'PUT', url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; claims?: Record<string, unknown> }): Promise<Reply> {
    const claims = options.claims === undefined ? {} : { ...options.claims, ...(options.claims.aal === 'aal2' ? { aal2At: new Date().toISOString() } : {}) };
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json', [CLAIMS_HEADER]: JSON.stringify(claims) };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
  const rows = async <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

  const draft = (member: number, businessType: string, definition: unknown) => call('POST', '/workflow-definitions', { member, body: { business_type: businessType, definition } });
  async function publish(businessType: string, definition: unknown): Promise<string> {
    const created = await draft(ADMIN, businessType, definition);
    expect(created.status).toBe(200);
    const id = created.json.resource_id as string;
    const done = await call('POST', `/workflow-definitions/${id}/publish`, { member: PUBLISHER, ifMatch: '"1"', body: { reason: 'Công bố quy trình mới theo quy chế nội bộ.' } });
    expect(done).toMatchObject({ status: 200, json: { status: 'PUBLISHED' } });
    return id;
  }
  async function startInstance(maker = MAKER): Promise<string> {
    const instance = await harness.tenants.withTenant(contextFor(TENANT_A, memberId(maker)), (tx) =>
      store.start(
        tx,
        { actor: memberId(maker), audit: () => Promise.resolve(), emit: () => Promise.resolve() },
        { resourceType: 'report', resourceId: randomUUID(), resourceVersion: 1, businessType: 'report.accept', amountVnd: '1000000', unitId: unitId(ROOT), initiatorMembershipId: memberId(maker), now: new Date() },
      ),
    );
    return instance.id;
  }
  const taskOf = async (instanceId: string, member: number) => (await rows<{ id: string; version: string }>("select id, version::text from machvon.approval_task where workflow_instance_id = $1 and assignee_id = $2 and status = 'Pending'", [instanceId, memberId(member)]))[0];
  const outbox = (id: string, type: string) => rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2', [id, type]);

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
    for (const n of [ADMIN, PUBLISHER, MAKER, LEADER_A, LEADER_B, READER, NOBODY, UNIT_ADMIN, DELEGATE]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, OTHER_TENANT, ROOT);
    await harness.seedRole(TENANT_A, LEADER_ROLE, 'LEADER', ['approval.decide', 'approval_task.read', 'workflow_instance.read'], 60);
    await harness.seedRole(TENANT_A, 2, 'WORKFLOW_ADMIN', ['adm.workflow.manage', 'workflow_version.read', 'workflow_instance.read', 'approval_task.read', 'adm.workflow.operate'], 50);
    await harness.seedRole(TENANT_A, 3, 'WORKFLOW_PUBLISHER', ['adm.workflow.publish', 'workflow_version.read'], 50);
    await harness.seedRole(TENANT_A, 4, 'WORKFLOW_READER', ['workflow_version.read', 'workflow_instance.read', 'approval_task.read'], 10);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ADMIN, role: 2, kind: 'TENANT' },
      { n: 2, member: PUBLISHER, role: 3, kind: 'TENANT' },
      { n: 3, member: MAKER, role: LEADER_ROLE, kind: 'TENANT' },
      { n: 4, member: LEADER_A, role: LEADER_ROLE, kind: 'TENANT' },
      { n: 5, member: LEADER_B, role: LEADER_ROLE, kind: 'TENANT' },
      { n: 6, member: READER, role: 4, kind: 'TENANT' },
      { n: 7, member: UNIT_ADMIN, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(ROOT)] },
      { n: 8, member: DELEGATE, role: 4, kind: 'TENANT' },
    ]);
    await harness.seedRole(TENANT_B, 1, 'WORKFLOW_READER', ['workflow_version.read', 'workflow_instance.read'], 10);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT, role: 1, kind: 'TENANT' }]);
    const matrix = randomUUID();
    await harness.owner(TENANT_A, [
      [`insert into machvon.doa_matrix_version (tenant_id, id, revision, status, effective_from, legal_basis_ref, created_by, last_edited_by, version) values ($1, $2, 901, 'Draft', date '2020-01-01', 'Fixture regulation on approvals', $3, $3, 1)`, [TENANT_A, matrix, memberId(ADMIN)]],
      [`insert into machvon.doa_rule (tenant_id, id, matrix_version_id, document_type, unit_id, include_subtree, amount_min_vnd, amount_max_vnd, approver_role_id, approval_levels, position) values ($1, $2, $3, 'REPORT_ACCEPT', $4, true, 0, null, $5, 1, 0)`, [TENANT_A, randomUUID(), matrix, unitId(ROOT), roleId(LEADER_ROLE)]],
      ["update machvon.doa_matrix_version set status = 'PendingApproval' where id = $1", [matrix]],
      ["update machvon.doa_matrix_version set status = 'Published', approved_by = $2, published_at = now() where id = $1", [matrix, memberId(PUBLISHER)]],
    ]);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [ApprovalCommandsController, WorkflowVersionReadsController, WorkflowInstanceReadsController, ApprovalTaskReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APPROVAL_FINAL_COMMANDS, useValue: registry },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 240_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('AC-ST-ADM-012-4, UAT-PLAN-45: an invalid definition is 422 with the path of each defect, and the stored definition is unchanged', async () => {
    const bad = await draft(ADMIN, 'report.accept', definitionOf([step('review', { min_approvals: 0, sla_working_hours: 0 })]));
    expect(bad).toMatchObject({ status: 422, json: { code: 'WORKFLOW_DEFINITION_INVALID', detail: '$.steps[0].min_approvals' } });
    expect((bad.json.defects as Array<{ path: string; code: string }>).map((defect) => [defect.path, defect.code])).toEqual([['$.steps[0].min_approvals', 'MIN_APPROVALS_INVALID'], ['$.steps[0].sla_working_hours', 'SLA_INVALID']]);
    const created = await draft(ADMIN, 'report.accept', definitionOf([step('review')]));
    expect(created).toMatchObject({ status: 200, json: { status: 'DRAFT', resource_version: 1 } });
    const id = created.json.resource_id as string;
    const invalid = await call('PUT', `/workflow-definitions/${id}`, { member: ADMIN, ifMatch: '"1"', body: { business_type: 'report.accept', definition: definitionOf([step('review'), step('review')]) } });
    expect(invalid).toMatchObject({ status: 422, json: { code: 'WORKFLOW_DEFINITION_INVALID', detail: '$.steps[1].id' } });
    expect((await rows<{ definition_json: unknown; version: string }>('select definition_json, version::text from machvon.workflow_version where id = $1', [id]))[0]).toMatchObject({ definition_json: definitionOf([step('review')]), version: '1' });
    expect(await call('PUT', `/workflow-definitions/${id}`, { member: ADMIN, body: { business_type: 'report.accept', definition: definitionOf([step('review')]) } })).toMatchObject({ status: 428 });
    expect(await call('PUT', `/workflow-definitions/${id}`, { member: ADMIN, ifMatch: '"5"', body: { business_type: 'report.accept', definition: definitionOf([step('review')]) } })).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    expect(await call('PUT', `/workflow-definitions/${id}`, { member: ADMIN, ifMatch: '"1"', body: { business_type: 'report.accept', definition: definitionOf([step('review'), step('chief', { allow_return_to: 'review' })]) } })).toMatchObject({ status: 200, json: { resource_version: 2 } });
  });

  it('publishes a definition by someone other than its author, with the right to publish on the whole tenant, and announces it', async () => {
    const created = await draft(ADMIN, 'plan.publish', { steps: [step('review')], terminal: { approved: 'publishPlan', returned: 'returnPlan', rejected: 'rejectPlan' } });
    const id = created.json.resource_id as string;
    const body = { reason: 'Công bố quy trình mới theo quy chế nội bộ.' };
    expect(await call('POST', `/workflow-definitions/${id}/publish`, { member: ADMIN, ifMatch: '"1"', body })).toMatchObject({ status: 403 });
    expect(await call('POST', `/workflow-definitions/${id}/publish`, { member: NOBODY, ifMatch: '"1"', body })).toMatchObject({ status: 403 });
    expect(await call('POST', `/workflow-definitions/${id}/publish`, { member: PUBLISHER, ifMatch: '"7"', body })).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    expect(await call('POST', `/workflow-definitions/${id}/publish`, { member: PUBLISHER, ifMatch: '"1"', body })).toMatchObject({ status: 200, json: { status: 'PUBLISHED', resource_version: 2 } });
    expect((await outbox(id, 'adm.workflow_version.published.v1'))[0]?.payload).toMatchObject({ workflow_version_id: id, business_type: 'plan.publish' });
    expect(await call('PUT', `/workflow-definitions/${id}`, { member: ADMIN, ifMatch: '"2"', body: { business_type: 'plan.publish', definition: { steps: [step('review')], terminal: { approved: 'publishPlan', returned: 'returnPlan', rejected: 'rejectPlan' } } } })).toMatchObject({ status: 409, json: { code: 'WORKFLOW_NOT_DRAFT' } });
    // The right to write is held on the whole tenant: a manager of one unit does not write the rules of the tenant.
    expect(await draft(UNIT_ADMIN, 'report.accept', definitionOf([step('review')]))).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
  });

  it('AC-ST-ADM-012-3, UAT-AC121: a leader on a first factor only is refused with MFA_REQUIRED until the second factor, then decides', async () => {
    await publish('report.accept', definitionOf([step('review')]));
    const instanceId = await startInstance();
    const task = await taskOf(instanceId, LEADER_A);
    const ifMatch = `"${task?.version}"`;
    const body = { decision: 'approve' };
    expect(await call('POST', `/approval-tasks/${task?.id}/decision`, { member: LEADER_A, ifMatch, body, claims: { aal: 'aal1' } })).toMatchObject({ status: 403, json: { code: 'MFA_REQUIRED' } });
    expect((await rows<{ status: string }>('select status from machvon.approval_task where id = $1', [task?.id]))[0]?.status).toBe('Pending');
    const done = await call('POST', `/approval-tasks/${task?.id}/decision`, { member: LEADER_A, ifMatch, body, claims: SECOND_FACTOR });
    expect(done).toMatchObject({ status: 200, json: { status: 'APPROVED', resource_id: task?.id } });
    expect((await rows<{ status: string; outcome: string }>('select status, outcome from machvon.workflow_instance where id = $1', [instanceId]))[0]).toEqual({ status: 'Completed', outcome: 'APPROVED' });
    expect((await outbox(task?.id as string, 'adm.approval_task.decided.v1'))[0]?.payload).toMatchObject({ decision: 'approve', decided_by: memberId(LEADER_A), instance_id: instanceId });
    expect((await outbox(instanceId, 'adm.workflow_instance.completed.v1'))[0]?.payload).toMatchObject({ outcome: 'APPROVED', command: 'acceptReport', idempotency_key: `wf:${instanceId}:final:1` });
    expect(await rows("select id from machvon.audit_event where action = 'approval.task_decided' and resource_id = $1", [task?.id])).toHaveLength(1);
    // Again: the task is decided.
    expect(await call('POST', `/approval-tasks/${task?.id}/decision`, { member: LEADER_A, ifMatch: '"2"', body, claims: SECOND_FACTOR })).toMatchObject({ status: 409, json: { code: 'TASK_ALREADY_DECIDED' } });
  });

  it('AC-ST-ADM-012-1, UAT-AC129: a maker who holds the task is refused with SELF_APPROVAL_DENIED, and the task is given to another eligible person', async () => {
    await publish('report.accept', definitionOf([step('review')]));
    const instanceId = await startInstance();
    // Only LEADER_A has a task; the maker is given one.
    await rows("update machvon.approval_task set status = 'Cancelled' where workflow_instance_id = $1 and assignee_id = $2", [instanceId, memberId(LEADER_B)]);
    const [given] = await rows<{ id: string }>(
      `insert into machvon.approval_task (tenant_id, id, workflow_instance_id, assignee_id, due_at, step_id, step_index, status)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2, now() + interval '1 day', 'review', 0, 'Pending') returning id`,
      [instanceId, memberId(MAKER)],
    );
    const refused = await call('POST', `/approval-tasks/${given?.id}/decision`, { member: MAKER, ifMatch: '"1"', body: { decision: 'approve' }, claims: SECOND_FACTOR });
    expect(refused).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
    // The refusal is answered after the reassignment was committed.
    const states = await rows<{ assignee_id: string; status: string }>('select assignee_id, status from machvon.approval_task where workflow_instance_id = $1 order by created_at, id', [instanceId]);
    expect(states.find((row) => row.assignee_id === memberId(MAKER))?.status).toBe('Reassigned');
    expect(states.filter((row) => row.assignee_id === memberId(LEADER_B) && row.status === 'Pending')).toHaveLength(1);
    expect(await rows("select id from machvon.audit_event where action = 'approval.self_approval_refused' and resource_id = $1", [given?.id])).toHaveLength(1);
    expect((await rows<{ status: string }>('select status from machvon.workflow_instance where id = $1', [instanceId]))[0]?.status).toBe('Running');
  });

  it('lets a delegate who holds no right to decide through the door of the decision with the delegation alone, and nobody else without a grant', async () => {
    await publish('report.accept', definitionOf([step('review')]));
    const instanceId = await startInstance();
    const task = await taskOf(instanceId, LEADER_B);
    const ifMatch = `"${task?.version}"`;
    const body = { decision: 'approve' };
    expect(await call('POST', `/approval-tasks/${task?.id}/decision`, { member: DELEGATE, ifMatch, body, claims: SECOND_FACTOR })).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
    await rows(
      `insert into machvon.delegation_grant (tenant_id, id, delegator_membership_id, delegate_membership_id, permissions, scope_json, valid_from, valid_until, reason, status)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2, array['approval.decide'], '{"kind":"TENANT","ref_ids":[]}'::jsonb, now() - interval '1 day', now() + interval '10 days', 'Đi công tác', 'Active')`,
      [memberId(LEADER_B), memberId(DELEGATE)],
    );
    // The door is the delegation, and the second factor is still asked for.
    expect(await call('POST', `/approval-tasks/${task?.id}/decision`, { member: DELEGATE, ifMatch, body, claims: { aal: 'aal1' } })).toMatchObject({ status: 403, json: { code: 'MFA_REQUIRED' } });
    // The delegation covers the task of the delegator only: another leader's task is refused by the command.
    const other = await taskOf(instanceId, LEADER_A);
    expect(await call('POST', `/approval-tasks/${other?.id}/decision`, { member: DELEGATE, ifMatch: `"${other?.version}"`, body, claims: SECOND_FACTOR })).toMatchObject({ status: 403, json: { code: 'APPROVER_NOT_AUTHORIZED' } });
    expect(await call('POST', `/approval-tasks/${task?.id}/decision`, { member: DELEGATE, ifMatch, body, claims: SECOND_FACTOR })).toMatchObject({ status: 200, json: { status: 'APPROVED' } });
    expect((await rows<{ decided_by: string; on_behalf_of_id: string }>('select decided_by, on_behalf_of_id from machvon.approval_task where id = $1', [task?.id]))[0]).toEqual({ decided_by: memberId(DELEGATE), on_behalf_of_id: memberId(LEADER_B) });
    // They still see the task they decided once the delegation has ended.
    await rows("update machvon.delegation_grant set status = 'Ended', ended_at = now(), end_reason = 'EXPIRED' where delegate_membership_id = $1", [memberId(DELEGATE)]);
    expect(await call('GET', `/resources/approval_task/${task?.id}`, { member: DELEGATE })).toMatchObject({ status: 200, json: { id: task?.id, status: 'Decided' } });
  });

  it('BR-ADM-07: when the domain refuses the end, the instance says GUARD_REJECTED and the answer is still 200', async () => {
    await publish('report.accept', definitionOf([step('review')]));
    registry.register('report.accept', () => Promise.resolve('GUARD_REJECTED'));
    try {
      const instanceId = await startInstance();
      const task = await taskOf(instanceId, LEADER_B);
      expect(await call('POST', `/approval-tasks/${task?.id}/decision`, { member: LEADER_B, ifMatch: `"${task?.version}"`, body: { decision: 'approve' }, claims: SECOND_FACTOR })).toMatchObject({ status: 200, json: { status: 'GUARD_REJECTED' } });
      expect((await rows<{ outcome: string }>('select outcome from machvon.workflow_instance where id = $1', [instanceId]))[0]?.outcome).toBe('GUARD_REJECTED');
      expect(await outbox(instanceId, 'adm.workflow_guard_rejected.v1')).toHaveLength(1);
    } finally {
      registry.register('report.accept', () => Promise.resolve('APPLIED'));
    }
  });

  it('refuses a decision that is not valid: an unknown decision, a return or a rejection with no reason', async () => {
    await publish('report.accept', definitionOf([step('review')]));
    const instanceId = await startInstance();
    const task = await taskOf(instanceId, LEADER_A);
    const ifMatch = `"${task?.version}"`;
    expect(await call('POST', `/approval-tasks/${task?.id}/decision`, { member: LEADER_A, ifMatch, body: { decision: 'maybe' }, claims: SECOND_FACTOR })).toMatchObject({ status: 422, json: { detail: 'decision' } });
    expect(await call('POST', `/approval-tasks/${task?.id}/decision`, { member: LEADER_A, ifMatch, body: { decision: 'reject' }, claims: SECOND_FACTOR })).toMatchObject({ status: 422, json: { detail: 'reason' } });
    expect(await call('POST', `/approval-tasks/${task?.id}/decision`, { member: LEADER_A, ifMatch, body: { decision: 'reject', reason: 'Số liệu chưa khớp với báo cáo quý.' }, claims: SECOND_FACTOR })).toMatchObject({ status: 200, json: { status: 'REJECTED' } });
    // A person who holds no task of it is not the assignee.
    const other = await startInstance();
    const theirs = await taskOf(other, LEADER_A);
    expect(await call('POST', `/approval-tasks/${theirs?.id}/decision`, { member: READER, ifMatch: `"${theirs?.version}"`, body: { decision: 'approve' }, claims: SECOND_FACTOR })).toMatchObject({ status: 403 });
    expect(await call('POST', `/approval-tasks/${randomUUID()}/decision`, { member: LEADER_A, ifMatch: '"1"', body: { decision: 'approve' }, claims: SECOND_FACTOR })).toMatchObject({ status: 404 });
  });

  it('reads the definitions, the instances and the tasks in the scope of the reader, and another tenant sees none', async () => {
    const id = await publish('report.accept', definitionOf([step('review')]));
    const versions = await call('GET', '/resources/workflow_version?business_type=report.accept&status=Published', { member: READER });
    expect((versions.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([id]);
    expect(await call('GET', `/resources/workflow_version/${id}`, { member: READER })).toMatchObject({ status: 200, json: { id, status: 'Published', business_type: 'report.accept' } });
    expect(await call('GET', `/resources/workflow_version/${id}`, { member: OTHER_TENANT, tenantId: TENANT_B })).toMatchObject({ status: 404 });
    const instanceId = await startInstance();
    const mine = await call('GET', '/resources/approval_task?mine=true&status=Pending', { member: LEADER_A });
    const ours = (mine.json.items as Array<{ workflow_instance_id: string; actions: { decide: boolean }; assignee: { id: string } }>).filter((item) => item.workflow_instance_id === instanceId);
    expect(ours).toHaveLength(1);
    expect(ours[0]).toMatchObject({ actions: { decide: true }, assignee: { id: memberId(LEADER_A) } });
    // The reader sees no task that is not theirs; the administrator who runs workflows sees them all.
    expect(((await call('GET', `/resources/approval_task?workflow_instance_id=${instanceId}`, { member: READER })).json.items as unknown[]).length).toBe(0);
    expect(((await call('GET', `/resources/approval_task?workflow_instance_id=${instanceId}`, { member: ADMIN })).json.items as unknown[]).length).toBeGreaterThanOrEqual(2);
    const taskId = (await taskOf(instanceId, LEADER_A))?.id;
    expect(await call('GET', `/resources/approval_task/${taskId}`, { member: READER })).toMatchObject({ status: 404 });
    expect(await call('GET', `/resources/approval_task/${taskId}`, { member: LEADER_A })).toMatchObject({ status: 200, json: { id: taskId, status: 'Pending', business_type: 'report.accept' } });
    expect(await call('GET', `/resources/workflow_instance/${instanceId}`, { member: MAKER })).toMatchObject({ status: 200, json: { id: instanceId, status: 'Running', initiator_id: memberId(MAKER) } });
    expect(await call('GET', `/resources/workflow_instance/${instanceId}`, { member: READER })).toMatchObject({ status: 404 });
    expect(await call('GET', `/resources/workflow_instance/${instanceId}`, { member: OTHER_TENANT, tenantId: TENANT_B })).toMatchObject({ status: 404 });
    expect(await call('GET', '/resources/approval_task?status=Bogus', { member: LEADER_A })).toMatchObject({ status: 422, json: { detail: 'status' } });
    expect(await call('GET', '/resources/workflow_instance?resource_id=nope', { member: ADMIN })).toMatchObject({ status: 422, json: { detail: 'resource_id' } });
  });
});
