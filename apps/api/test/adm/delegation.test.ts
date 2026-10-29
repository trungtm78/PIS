import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { ApprovalStore, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { ApprovalCommandsController, ApprovalTaskReadsController, WorkflowInstanceReadsController, WorkflowVersionReadsController } from '../../src/modules/adm/approval.controller';
import { APPROVAL_FINAL_COMMANDS, FinalCommandRegistry } from '../../src/modules/adm/approval.service';
import { DelegationCommandsController, DelegationReadsController } from '../../src/modules/adm/delegation.controller';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { CLAIMS_HEADER, TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const ADMIN = 1; // workflow definitions, and iam.delegation.create + read on the whole tenant
const PUBLISHER = 2;
const MAKER = 3; // a leader who submits records
const LEADER_A = 4; // a leader who may delegate
const LEADER_B = 5;
const DELEGATE = 6; // may delegate, but holds no right to decide of their own
const OTHER = 7; // may delegate, nothing else
const NOBODY = 8;
const SUSPENDED = 9;
const OTHER_TENANT = 10;
const ROOT = 1;
const SIDE = 2; // a unit outside the tree of the leaders
const LEADER_ROLE = 1;
const DAY = 86_400_000;

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

const definition = { steps: [{ id: 'review', name: 'Bước review', assignee_rule: { type: 'ROLE_IN_UNIT', role_code: 'LEADER', unit_id: unitId(ROOT) }, min_approvals: 1, sla_working_hours: 16, on_timeout: 'REMIND' }], terminal: { approved: 'acceptReport', returned: 'returnReport', rejected: 'rejectReport' } };
const REASON = 'Đi công tác dài ngày, ủy quyền duyệt hồ sơ.';

describe('the delegation of approval authority over HTTP (ST-ADM-014)', () => {
  const harness = new AuthzHarness();
  const store = new ApprovalStore();
  const registry = new FinalCommandRegistry();
  let app: RunningApp;
  let tenants: TenantDatabase;

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
  const scopeVersionOf = async (member: number): Promise<number> => Number((await rows<{ v: string }>('select scope_version::text as v from machvon.membership where id = $1', [memberId(member)]))[0]?.v);

  const body = (overrides: Record<string, unknown> = {}) => ({
    delegate_membership_id: memberId(DELEGATE),
    permissions: ['approval.decide'],
    scope_kind: 'UNIT_SUBTREE',
    scope_ref_ids: [unitId(ROOT)],
    valid_from: new Date().toISOString(),
    valid_until: new Date(Date.now() + 7 * DAY).toISOString(),
    reason: REASON,
    ...overrides,
  });
  const delegate = (member: number, overrides: Record<string, unknown> = {}, key?: string) => call('POST', '/delegations', { member, body: body(overrides), ...(key === undefined ? {} : { key }) });
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
  const taskOf = async (instanceId: string, member: number) => {
    const [task] = await rows<{ id: string; version: string }>("select id, version::text from machvon.approval_task where workflow_instance_id = $1 and assignee_id = $2 and status = 'Pending'", [instanceId, memberId(member)]);
    return task as { id: string; version: string };
  };
  const decide = (member: number, task: { id: string; version: string }) => call('POST', `/approval-tasks/${task.id}/decision`, { member, ifMatch: `"${task.version}"`, body: { decision: 'approve' }, claims: { aal: 'aal2' } });

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
    await harness.seedUnits(TENANT_A, [{ n: SIDE, path: `/${unitId(SIDE)}/` }]);
    for (const n of [ADMIN, PUBLISHER, MAKER, LEADER_A, LEADER_B, DELEGATE, OTHER, NOBODY, SUSPENDED]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, OTHER_TENANT, ROOT);
    await harness.seedRole(TENANT_A, LEADER_ROLE, 'LEADER', ['approval.decide', 'approval_task.read', 'workflow_instance.read', 'iam.delegation.create', 'iam.delegation.read'], 60);
    await harness.seedRole(TENANT_A, 2, 'WORKFLOW_ADMIN', ['adm.workflow.manage', 'workflow_version.read', 'iam.delegation.create', 'iam.delegation.read'], 50);
    await harness.seedRole(TENANT_A, 3, 'WORKFLOW_PUBLISHER', ['adm.workflow.publish', 'workflow_version.read'], 50);
    await harness.seedRole(TENANT_A, 4, 'DELEGATOR_ONLY', ['iam.delegation.create', 'iam.delegation.read', 'approval_task.read'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ADMIN, role: 2, kind: 'TENANT' },
      { n: 2, member: PUBLISHER, role: 3, kind: 'TENANT' },
      { n: 3, member: MAKER, role: LEADER_ROLE, kind: 'TENANT' },
      { n: 4, member: LEADER_A, role: LEADER_ROLE, kind: 'UNIT_SUBTREE', refs: [unitId(ROOT)] },
      { n: 5, member: LEADER_B, role: LEADER_ROLE, kind: 'TENANT' },
      { n: 6, member: DELEGATE, role: 4, kind: 'UNIT_SUBTREE', refs: [unitId(ROOT)] },
      { n: 7, member: OTHER, role: 4, kind: 'UNIT_SUBTREE', refs: [unitId(ROOT)] },
      { n: 8, member: SUSPENDED, role: 4, kind: 'TENANT' },
    ]);
    await harness.owner(TENANT_A, [["update machvon.membership set status = 'Suspended' where id = $1", [memberId(SUSPENDED)]]]);
    await harness.seedRole(TENANT_B, 1, 'DELEGATOR_ONLY', ['iam.delegation.create'], 10);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT, role: 1, kind: 'TENANT' }]);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [DelegationCommandsController, DelegationReadsController, ApprovalCommandsController, WorkflowVersionReadsController, WorkflowInstanceReadsController, ApprovalTaskReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APPROVAL_FINAL_COMMANDS, useValue: registry },
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

  it('AC-ST-ADM-014-1, UAT-AC116: a 7-day delegation lets the delegate approve with on_behalf_of recorded; the delegate cannot delegate it on (403 DELEGATION_CHAIN_DENIED); 91 days is 422', async () => {
    const created = await delegate(LEADER_A);
    expect(created).toMatchObject({ status: 201, json: { status: 'ACTIVE', resource_version: 1 } });
    const id = created.json.resource_id as string;
    // The delegate decides the task of the delegator, and the record says on whose behalf.
    const instance = await startInstance();
    const task = await taskOf(instance, LEADER_A);
    const done = await decide(DELEGATE, task);
    expect(done.status).toBe(200);
    expect((await rows<{ decided_by: string; on_behalf_of_id: string; delegation_id: string; status: string }>('select decided_by, on_behalf_of_id, delegation_id, status from machvon.approval_task where id = $1', [task.id]))[0]).toEqual({ decided_by: memberId(DELEGATE), on_behalf_of_id: memberId(LEADER_A), delegation_id: id, status: 'Decided' });
    // No chain: what the delegate holds through the delegation is not theirs to pass on.
    expect(await delegate(DELEGATE, { delegate_membership_id: memberId(OTHER) })).toMatchObject({ status: 403, json: { code: 'DELEGATION_CHAIN_DENIED' } });
    // At most 90 days.
    const long = await delegate(LEADER_A, { delegate_membership_id: memberId(OTHER), valid_until: new Date(Date.now() + 91 * DAY).toISOString() });
    expect(long).toMatchObject({ status: 422, json: { code: 'DELEGATION_INVALID', detail: 'valid_until' } });
    expect((long.json.defects as Array<{ field: string; code: string }>).map((defect) => [defect.field, defect.code])).toEqual([['valid_until', 'TOO_LONG']]);
    expect(await delegate(LEADER_A, { delegate_membership_id: memberId(OTHER), valid_until: new Date(Date.now() + 90 * DAY).toISOString() })).toMatchObject({ status: 201 });
  });

  it('AC-ST-ADM-014-2, UAT-AC117: a delegate who is the maker of the record is refused (403 SELF_APPROVAL_DENIED) and the task stays with the delegator', async () => {
    expect(await delegate(LEADER_B, { delegate_membership_id: memberId(DELEGATE) })).toMatchObject({ status: 201 });
    const instance = await startInstance(DELEGATE);
    const task = await taskOf(instance, LEADER_B);
    expect(await decide(DELEGATE, task)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
    expect((await rows<{ status: string; assignee_id: string }>('select status, assignee_id from machvon.approval_task where id = $1', [task.id]))[0]).toEqual({ status: 'Pending', assignee_id: memberId(LEADER_B) });
  });

  it('records the delegation: the audit row with the reason, the events, and the scope version of the delegate raised', async () => {
    const before = await scopeVersionOf(OTHER);
    const created = await delegate(LEADER_A, { delegate_membership_id: memberId(OTHER), legal_basis_ref: 'Quyết định 12/QĐ-UBND' });
    const id = created.json.resource_id as string;
    expect((await auditRows(id, 'delegation.created')).map((row) => row.reason)).toEqual([REASON]);
    expect((await outbox(id, 'iam.delegation.created.v1'))[0]?.payload).toMatchObject({ delegation_id: id, delegator_membership_id: memberId(LEADER_A), delegate_membership_id: memberId(OTHER), permissions: ['approval.decide'], scope_kind: 'UNIT_SUBTREE' });
    expect(await scopeVersionOf(OTHER)).toBe(before + 1);
    expect((await rows<{ legal_basis_ref: string }>('select legal_basis_ref from machvon.delegation_grant where id = $1', [id]))[0]?.legal_basis_ref).toBe('Quyết định 12/QĐ-UBND');
  });

  it('starts later when it is dated later (Scheduled)', async () => {
    const created = await delegate(LEADER_A, { valid_from: new Date(Date.now() + 3 * DAY).toISOString(), valid_until: new Date(Date.now() + 10 * DAY).toISOString() });
    expect(created).toMatchObject({ status: 201, json: { status: 'SCHEDULED' } });
  });

  it('refuses what the delegator may not pass on: to themself, a permission they do not hold, a scope they do not cover, the administration, a member who is not active or not staff, and changes nothing', async () => {
    const before = (await rows<{ n: string }>('select count(*)::text as n from machvon.delegation_grant'))[0]?.n;
    expect(await delegate(LEADER_A, { delegate_membership_id: memberId(LEADER_A) })).toMatchObject({ status: 403, json: { code: 'SELF_GRANT_DENIED' } });
    expect(await delegate(LEADER_A, { permissions: ['doc.outgoing.sign'] })).toMatchObject({ status: 403, json: { code: 'ROLE_ESCALATION_DENIED' } });
    // A permission nothing reads a delegation for is refused before it is recorded.
    expect(await delegate(LEADER_A, { permissions: ['payment.approve'] })).toMatchObject({ status: 422, json: { code: 'DELEGATION_INVALID', detail: 'permissions[0]' } });
    expect(await delegate(LEADER_A, { scope_ref_ids: [unitId(SIDE)] })).toMatchObject({ status: 403, json: { code: 'ROLE_ESCALATION_DENIED' } });
    expect(await delegate(LEADER_A, { scope_kind: 'UNIT_SUBTREE', scope_ref_ids: [randomUUID()] })).toMatchObject({ status: 422 });
    // A project scope would be accepted and never matched by the engine that reads delegations: it is refused.
    expect(await delegate(LEADER_A, { scope_kind: 'PROJECT', scope_ref_ids: [randomUUID()] })).toMatchObject({ status: 422, json: { code: 'DELEGATION_INVALID', detail: 'scope_kind' } });
    const administrative = await delegate(LEADER_A, { permissions: ['approval.decide', 'iam.role.grant'] });
    expect(administrative).toMatchObject({ status: 422, json: { code: 'DELEGATION_INVALID', detail: 'permissions[1]' } });
    expect(await delegate(LEADER_A, { permissions: ['*'] })).toMatchObject({ status: 422, json: { code: 'DELEGATION_INVALID' } });
    expect(await delegate(LEADER_A, { delegate_membership_id: memberId(SUSPENDED) })).toMatchObject({ status: 403, json: { code: 'MEMBERSHIP_INACTIVE' } });
    expect(await delegate(LEADER_A, { delegate_membership_id: randomUUID() })).toMatchObject({ status: 404 });
    expect(await delegate(LEADER_A, { reason: 'short' })).toMatchObject({ status: 422 });
    expect(await delegate(LEADER_A, { valid_until: new Date(Date.now() - DAY).toISOString(), valid_from: new Date(Date.now() - 2 * DAY).toISOString() })).toMatchObject({ status: 422, json: { code: 'DELEGATION_INVALID' } });
    expect(await delegate(NOBODY)).toMatchObject({ status: 403 });
    expect((await rows<{ n: string }>('select count(*)::text as n from machvon.delegation_grant'))[0]?.n).toBe(before);
  });

  it('a request re-sent with the same key replays the first answer and writes one delegation', async () => {
    const key = 'create-delegation-key-0001';
    const same = body({ delegate_membership_id: memberId(OTHER) });
    const first = await call('POST', '/delegations', { member: LEADER_A, body: same, key });
    const again = await call('POST', '/delegations', { member: LEADER_A, body: same, key });
    expect(first.status).toBe(201);
    expect(again).toEqual(first);
    expect((await rows<{ n: string }>('select count(*)::text as n from machvon.audit_event where resource_id = $1 and action = $2', [first.json.resource_id, 'delegation.created']))[0]?.n).toBe('1');
    // The same key with another body is not a replay.
    expect(await call('POST', '/delegations', { member: LEADER_A, body: { ...same, reason: 'Một lý do khác, đủ dài để hợp lệ.' }, key })).toMatchObject({ status: 409, json: { code: 'IDEMPOTENCY_CONFLICT' } });
  });

  describe('revoking', () => {
    it('the delegator takes the delegation back with a reason: Revoked, audited, announced, and the delegate can no longer decide', async () => {
      const created = await delegate(LEADER_B, { delegate_membership_id: memberId(OTHER) });
      const id = created.json.resource_id as string;
      const instance = await startInstance();
      const task = await taskOf(instance, LEADER_B);
      const before = await scopeVersionOf(OTHER);
      const revoked = await call('POST', `/delegations/${id}/revoke`, { member: LEADER_B, ifMatch: '"1"', body: { reason: 'Quay lại làm việc sớm hơn dự kiến.' } });
      expect(revoked).toMatchObject({ status: 200, json: { status: 'REVOKED', resource_version: 2 } });
      expect((await rows<{ status: string; revoked_by: string; revoke_reason: string }>('select status, revoked_by, revoke_reason from machvon.delegation_grant where id = $1', [id]))[0]).toEqual({ status: 'Revoked', revoked_by: memberId(LEADER_B), revoke_reason: 'Quay lại làm việc sớm hơn dự kiến.' });
      expect((await auditRows(id, 'delegation.revoked')).map((row) => row.reason)).toEqual(['Quay lại làm việc sớm hơn dự kiến.']);
      expect(await outbox(id, 'iam.delegation.revoked.v1')).toHaveLength(1);
      expect(await scopeVersionOf(OTHER)).toBe(before + 1);
      expect((await decide(OTHER, task)).status).toBe(403);
      expect((await rows<{ status: string }>('select status from machvon.approval_task where id = $1', [task.id]))[0]?.status).toBe('Pending');
    });

    it('is refused a second time (409 DELEGATION_STATE_INVALID), when stale (409 VERSION_CONFLICT), without If-Match (428), for someone else\'s delegation, across tenants (404), and without a reason (422)', async () => {
      const created = await delegate(LEADER_A, { delegate_membership_id: memberId(OTHER) });
      const id = created.json.resource_id as string;
      const reason = { reason: 'Quay lại làm việc sớm hơn dự kiến.' };
      expect(await call('POST', `/delegations/${id}/revoke`, { member: LEADER_A, body: reason })).toMatchObject({ status: 428 });
      expect(await call('POST', `/delegations/${id}/revoke`, { member: LEADER_A, ifMatch: '"7"', body: reason })).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect(await call('POST', `/delegations/${id}/revoke`, { member: LEADER_A, ifMatch: '"1"', body: { reason: 'short' } })).toMatchObject({ status: 422 });
      expect(await call('POST', `/delegations/${id}/revoke`, { member: DELEGATE, ifMatch: '"1"', body: reason })).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect(await call('POST', `/delegations/${id}/revoke`, { member: NOBODY, ifMatch: '"1"', body: reason })).toMatchObject({ status: 403 });
      expect(await call('POST', `/delegations/${id}/revoke`, { member: OTHER_TENANT, tenantId: TENANT_B, ifMatch: '"1"', body: reason })).toMatchObject({ status: 404 });
      // The one who runs delegations for the whole tenant can take it back.
      expect(await call('POST', `/delegations/${id}/revoke`, { member: ADMIN, ifMatch: '"1"', body: reason })).toMatchObject({ status: 200, json: { status: 'REVOKED' } });
      expect(await call('POST', `/delegations/${id}/revoke`, { member: LEADER_A, ifMatch: '"2"', body: reason })).toMatchObject({ status: 409, json: { code: 'DELEGATION_STATE_INVALID' } });
    });
  });

  describe('the reads (ADM-04)', () => {
    it('the delegator sees what they gave, the delegate what they received, an outsider nothing, and the one who may read them all sees all; another person\'s delegation is 404', async () => {
      const created = await delegate(LEADER_A, { delegate_membership_id: memberId(OTHER) });
      const id = created.json.resource_id as string;
      const ids = (reply: Reply) => (reply.json.items as Array<{ id: string }>).map((item) => item.id);
      const asLeader = await call('GET', '/resources/delegation_grant?role=given', { member: LEADER_A });
      expect(ids(asLeader)).toContain(id);
      expect((asLeader.json.items as Array<{ delegator: { id: string } }>).every((item) => item.delegator.id === memberId(LEADER_A))).toBe(true);
      expect((asLeader.json.items as Array<{ id: string; actions: { revoke: boolean } }>).find((item) => item.id === id)?.actions.revoke).toBe(true);
      expect(ids(await call('GET', '/resources/delegation_grant?role=received', { member: OTHER }))).toContain(id);
      const received = (await call('GET', '/resources/delegation_grant?role=received', { member: OTHER })).json.items as Array<{ delegate: { id: string }; actions: { revoke: boolean } }>;
      expect(received.every((item) => item.delegate.id === memberId(OTHER) && item.actions.revoke === false)).toBe(true);
      expect(ids(await call('GET', '/resources/delegation_grant', { member: DELEGATE }))).not.toContain(id);
      expect(ids(await call('GET', '/resources/delegation_grant?limit=200', { member: ADMIN }))).toContain(id);
      expect(await call('GET', `/resources/delegation_grant/${id}`, { member: LEADER_A })).toMatchObject({ status: 200, json: { id, status: 'Active', permissions: ['approval.decide'], scope_kind: 'UNIT_SUBTREE' } });
      expect(await call('GET', `/resources/delegation_grant/${id}`, { member: DELEGATE })).toMatchObject({ status: 404 });
      expect(await call('GET', `/resources/delegation_grant/${id}`, { member: ADMIN })).toMatchObject({ status: 200 });
      expect(await call('GET', `/resources/delegation_grant/${id}`, { member: OTHER_TENANT, tenantId: TENANT_B })).toMatchObject({ status: 403 });
    });

    it('filters by state and refuses a state it does not know', async () => {
      const revoked = await call('GET', '/resources/delegation_grant?status=Revoked&limit=200', { member: ADMIN });
      expect((revoked.json.items as Array<{ status: string }>).every((item) => item.status === 'Revoked')).toBe(true);
      expect(await call('GET', '/resources/delegation_grant?status=Gone', { member: ADMIN })).toMatchObject({ status: 422 });
      expect(await call('GET', '/resources/delegation_grant?role=everyone', { member: ADMIN })).toMatchObject({ status: 422 });
    });
  });
});
