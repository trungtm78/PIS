import { randomBytes, randomUUID } from 'node:crypto';
import { Controller, HttpCode, Post } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ApprovalStore, DelegationStore, EffectiveAccessStore, InMemoryAuthzCache, StandingRequestStore, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../src/command.decorator';
import { commandResult } from '../../src/command-result';
import type { CommandResult } from '../../src/command-result';
import type { CommandScope } from '../../src/command-scope';
import { CommandModule } from '../../src/command.module';
import { OperationId } from '../../src/operation-id.decorator';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { ActingCommandsController, ActingReadsController } from '../../src/modules/adm/acting.controller';
import { ApprovalCommandsController, ApprovalTaskReadsController, WorkflowInstanceReadsController, WorkflowVersionReadsController } from '../../src/modules/adm/approval.controller';
import { APPROVAL_FINAL_COMMANDS, FinalCommandRegistry } from '../../src/modules/adm/approval.service';
import { DelegationCommandsController, DelegationReadsController } from '../../src/modules/adm/delegation.controller';
import { PeriodScopeCommandsController, PeriodScopeReadsController } from '../../src/modules/adm/period-scope.controller';
import { StandingDelegationCommandsController, StandingDelegationReadsController } from '../../src/modules/adm/standing-delegation.controller';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, grantId, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { CLAIMS_HEADER, TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(300_000);

const SIGNING_KEY = randomBytes(32);
const ADMIN = 1; // asks to act on behalf of a person; runs the period limits
const APPROVER = 2; // approves acting grants and permanent delegations
const SUBJECT = 3; // the person acted for; holds a role for the reports
const MAKER = 4; // submits records
const LEADER_A = 5;
const LEADER_B = 6;
const DELEGATE = 7;
const OUTSIDER = 8;
const OTHER_TENANT = 9;
const PERIODIC = 10; // holds a role for the reports that the period limits are set on
const ROOT = 1;
const DAY = 86_400_000;
const HOUR = 3_600_000;
const REASON = 'The reporter is in hospital and the weekly report is due today.';
const WRITE_PERMISSION = 'test.record.write';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

/** A command a person who holds test.record.write can make: it stands for the data entry that an administrator does on behalf of someone. */
@Controller('test/acting')
class ActingProbeController {
  @Post()
  @HttpCode(200)
  @OperationId('test_acting_write')
  @Command({ operation: 'test_acting_write' })
  async write(@Scope() scope: CommandScope): Promise<CommandResult> {
    const id = randomUUID();
    await scope.audit({ action: 'probe.written', resourceType: 'probe', resourceId: id, diff: { note: 'data entry' } });
    return commandResult(scope, 'WRITTEN', 1, id);
  }
}

const definition = { steps: [{ id: 'review', name: 'Review', assignee_rule: { type: 'ROLE_IN_UNIT', role_code: 'LEADER', unit_id: unitId(ROOT) }, min_approvals: 1, sla_working_hours: 16, on_timeout: 'REMIND' }], terminal: { approved: 'acceptReport', returned: 'returnReport', rejected: 'rejectReport' } };

describe('IAM-2 over HTTP: the permanent delegation, acting on behalf of a person, the period scope and the loop check', () => {
  const harness = new AuthzHarness();
  const store = new ApprovalStore();
  const delegationStore = new DelegationStore();
  const requestStore = new StandingRequestStore();
  const registry = new FinalCommandRegistry();
  let app: RunningApp;
  let tenants: TenantDatabase;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string; aal2?: boolean; acting?: string }): Promise<Reply> {
    const claims = options.aal2 === true ? { aal: 'aal2', aal2At: new Date().toISOString() } : {};
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json', [CLAIMS_HEADER]: JSON.stringify(claims) };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    if (options.acting !== undefined) headers['x-acting-as'] = options.acting;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
  const rows = async <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);
  const scopeVersionOf = async (member: number): Promise<number> => Number((await rows<{ v: string }>('select scope_version::text as v from machvon.membership where id = $1', [memberId(member)]))[0]?.v);
  const auditOf = (resourceId: string, action: string) => rows<{ actor_id: string; on_behalf_of_id: string | null; safe_diff: Record<string, unknown>; reason: string | null }>('select actor_id, on_behalf_of_id, safe_diff, reason from machvon.audit_event where resource_id = $1 and action = $2', [resourceId, action]);

  const standingBody = (overrides: Record<string, unknown> = {}) => ({
    delegate_membership_id: memberId(DELEGATE),
    permissions: ['approval.decide'],
    scope_kind: 'UNIT_SUBTREE',
    scope_ref_ids: [unitId(ROOT)],
    valid_from: new Date().toISOString(),
    review_due_at: new Date(Date.now() + 180 * DAY).toISOString(),
    end_condition_kind: 'UNTIL_EVENT',
    end_condition_text: 'Until the deputy director is appointed.',
    reason: 'Standing handover of the approval of reports.',
    ...overrides,
  });
  const requestStanding = (member: number, overrides: Record<string, unknown> = {}) => call('POST', '/standing-delegation-requests', { member, body: standingBody(overrides) });
  const decideStanding = (id: string, version: number, member: number, body: Record<string, unknown> = { decision: 'approve' }) => call('POST', `/standing-delegation-requests/${id}/decision`, { member, ifMatch: `"${version}"`, body, aal2: true });
  /** A permanent delegation, requested by the delegator and approved by the second person. */
  async function standing(delegator = LEADER_A, delegate = DELEGATE, overrides: Record<string, unknown> = {}): Promise<{ requestId: string; delegationId: string }> {
    const asked = await requestStanding(delegator, { delegate_membership_id: memberId(delegate), ...overrides });
    expect(asked).toMatchObject({ status: 201, json: { status: 'PENDING' } });
    const decided = await decideStanding(asked.json.resource_id as string, 1, APPROVER);
    expect(decided).toMatchObject({ status: 200, json: { status: 'APPROVED' } });
    const [made] = await rows<{ delegation_id: string }>('select delegation_id from machvon.standing_delegation_request where id = $1', [asked.json.resource_id]);
    return { requestId: asked.json.resource_id as string, delegationId: (made as { delegation_id: string }).delegation_id };
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
  const taskOf = async (instanceId: string, member: number) => {
    const [task] = await rows<{ id: string; version: string }>("select id, version::text from machvon.approval_task where workflow_instance_id = $1 and assignee_id = $2 and status = 'Pending'", [instanceId, memberId(member)]);
    return task as { id: string; version: string };
  };
  const decideTask = (member: number, task: { id: string; version: string }) => call('POST', `/approval-tasks/${task.id}/decision`, { member, ifMatch: `"${task.version}"`, body: { decision: 'approve' }, aal2: true });

  const actingBody = (overrides: Record<string, unknown> = {}) => ({ subject_membership_id: memberId(SUBJECT), permissions: [WRITE_PERMISSION], hours: 4, reason: REASON, ...overrides });
  const requestActing = (member: number, overrides: Record<string, unknown> = {}) => call('POST', '/acting-requests', { member, body: actingBody(overrides) });
  const decideActing = (id: string, version: number, member: number, body: Record<string, unknown> = { decision: 'approve' }) => call('POST', `/acting-requests/${id}/decision`, { member, ifMatch: `"${version}"`, body, aal2: true });
  async function actingGrant(overrides: Record<string, unknown> = {}): Promise<string> {
    const asked = await requestActing(ADMIN, overrides);
    expect(asked).toMatchObject({ status: 201, json: { status: 'PENDING' } });
    const id = asked.json.resource_id as string;
    expect(await decideActing(id, 1, APPROVER)).toMatchObject({ status: 200, json: { status: 'APPROVED' } });
    return id;
  }
  const probe = (member: number, acting?: string) => call('POST', '/test/acting', { member, body: {}, ...(acting === undefined ? {} : { acting }) });

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
    for (const n of [ADMIN, APPROVER, SUBJECT, MAKER, LEADER_A, LEADER_B, DELEGATE, OUTSIDER, PERIODIC]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, OTHER_TENANT, ROOT);
    await harness.seedRole(TENANT_A, 1, 'LEADER', ['approval.decide', 'approval_task.read', 'workflow_instance.read', 'iam.delegation.create', 'iam.delegation.read', 'iam.delegation.approve'], 60);
    await harness.seedRole(TENANT_A, 2, 'ACTING_ADMIN', ['iam.acting.request', 'iam.acting.approve', 'iam.acting.read', 'iam.acting.revoke', 'iam.role.grant', 'role_grant.read', 'approval_task.read'], 89);
    await harness.seedRole(TENANT_A, 3, 'ACTING_APPROVER', ['iam.acting.approve', 'iam.acting.read', 'iam.acting.revoke', 'iam.delegation.approve', 'iam.delegation.read', 'approval_task.read'], 89);
    await harness.seedRole(TENANT_A, 4, 'REPORTER', [WRITE_PERMISSION, 'approval_task.read', 'iam.delegation.read'], 30);
    await harness.seedRole(TENANT_A, 5, 'DELEGATOR_ONLY', ['iam.delegation.create', 'iam.delegation.read', 'approval_task.read'], 20);
    await harness.seedRole(TENANT_A, 6, 'WORKFLOW_ADMIN', ['adm.workflow.manage', 'workflow_version.read'], 50);
    await harness.seedRole(TENANT_A, 7, 'WORKFLOW_PUBLISHER', ['adm.workflow.publish', 'workflow_version.read'], 50);
    await harness.seedRole(TENANT_A, 8, 'PERIOD_HOLDER', ['approval_task.read'], 10);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ADMIN, role: 2, kind: 'TENANT' },
      { n: 2, member: APPROVER, role: 3, kind: 'TENANT' },
      { n: 3, member: SUBJECT, role: 4, kind: 'TENANT' },
      { n: 4, member: MAKER, role: 1, kind: 'TENANT' },
      { n: 5, member: LEADER_A, role: 1, kind: 'TENANT' },
      { n: 6, member: LEADER_B, role: 1, kind: 'TENANT' },
      { n: 7, member: DELEGATE, role: 5, kind: 'UNIT_SUBTREE', refs: [unitId(ROOT)] },
      { n: 8, member: OUTSIDER, role: 5, kind: 'UNIT_SUBTREE', refs: [unitId(ROOT)] },
      { n: 9, member: MAKER, role: 6, kind: 'TENANT' },
      { n: 10, member: APPROVER, role: 7, kind: 'TENANT' },
      { n: 11, member: PERIODIC, role: 8, kind: 'TENANT' },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()), extraOperations: { test_acting_write: { permission: WRITE_PERMISSION, plane: 'tenant' } } }),
      ],
      controllers: [
        ActingProbeController,
        StandingDelegationCommandsController,
        StandingDelegationReadsController,
        ActingCommandsController,
        ActingReadsController,
        PeriodScopeCommandsController,
        PeriodScopeReadsController,
        DelegationCommandsController,
        DelegationReadsController,
        ApprovalCommandsController,
        WorkflowVersionReadsController,
        WorkflowInstanceReadsController,
        ApprovalTaskReadsController,
      ],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APPROVAL_FINAL_COMMANDS, useValue: registry },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
    const created = await call('POST', '/workflow-definitions', { member: MAKER, body: { business_type: 'report.accept', definition } });
    expect(created.status).toBe(200);
    expect(await call('POST', `/workflow-definitions/${created.json.resource_id as string}/publish`, { member: APPROVER, ifMatch: '"1"', body: { reason: 'Publish the new workflow of the department.' } })).toMatchObject({ status: 200 });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  describe('the permanent delegation', () => {
    it('is requested by the delegator, approved by a second person, and then lets the delegate decide with both identities in the trail (ADM-11)', async () => {
      const before = await scopeVersionOf(DELEGATE);
      const asked = await requestStanding(LEADER_A);
      expect(asked).toMatchObject({ status: 201, json: { status: 'PENDING', resource_version: 1 } });
      const requestId = asked.json.resource_id as string;
      expect((await auditOf(requestId, 'delegation.standing_requested')).map((row) => row.reason)).toEqual(['Standing handover of the approval of reports.']);
      // Nothing works before the second person approves.
      const instance = await startInstance();
      const task = await taskOf(instance, LEADER_A);
      expect(await decideTask(DELEGATE, task)).toMatchObject({ status: 403 });
      expect(await decideStanding(requestId, 1, APPROVER)).toMatchObject({ status: 200, json: { status: 'APPROVED', resource_version: 2 } });
      const [made] = await rows<{ id: string; kind: string; status: string; request_id: string; end_condition_kind: string }>("select id, kind, status, request_id, end_condition_kind from machvon.delegation_grant where request_id = $1", [requestId]);
      expect(made).toMatchObject({ kind: 'PERMANENT', status: 'Active', request_id: requestId, end_condition_kind: 'UNTIL_EVENT' });
      expect(await scopeVersionOf(DELEGATE)).toBeGreaterThan(before);
      // The delegate decides the task of the delegator; the trail names the delegate as the actor and the delegator as the person it was done for.
      expect(await decideTask(DELEGATE, task)).toMatchObject({ status: 200 });
      const [row] = await rows<{ actor_id: string; on_behalf_of_id: string | null; safe_diff: Record<string, unknown> }>("select actor_id, on_behalf_of_id, safe_diff from machvon.audit_event where action = 'approval.task_decided' and resource_id = $1", [task.id]);
      expect(row).toMatchObject({ actor_id: memberId(DELEGATE), on_behalf_of_id: memberId(LEADER_A) });
      expect(row?.safe_diff).toMatchObject({ delegation_id: (made as { id: string }).id });
      expect((await auditOf((made as { id: string }).id, 'delegation.created'))[0]?.safe_diff).toMatchObject({ kind: 'PERMANENT', request_id: requestId });
      // The other tests start from no delegation of this pair.
      expect(await call('POST', `/delegations/${(made as { id: string }).id}/revoke`, { member: LEADER_A, ifMatch: '"1"', body: { reason: 'The appointment was made, no longer needed.' } })).toMatchObject({ status: 200 });
    });

    it('is approved by someone who is neither the delegator nor the delegate: maker is not checker', async () => {
      const asked = await requestStanding(LEADER_A, { delegate_membership_id: memberId(LEADER_B) });
      const id = asked.json.resource_id as string;
      expect(await decideStanding(id, 1, LEADER_A)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect(await decideStanding(id, 1, LEADER_B)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect((await rows<{ status: string }>('select status from machvon.standing_delegation_request where id = $1', [id]))[0]?.status).toBe('Pending');
      // A person who cannot decide at all is refused at the door.
      expect(await decideStanding(id, 1, OUTSIDER)).toMatchObject({ status: 403 });
      expect(await decideStanding(id, 1, APPROVER, { decision: 'reject' })).toMatchObject({ status: 422, json: { detail: 'reason' } });
      expect(await decideStanding(id, 1, APPROVER, { decision: 'reject', reason: 'The delegate is on the list of the audit.' })).toMatchObject({ status: 200, json: { status: 'REJECTED' } });
      expect(await decideStanding(id, 2, APPROVER)).toMatchObject({ status: 409, json: { code: 'DELEGATION_STATE_INVALID' } });
      expect(await rows('select 1 from machvon.delegation_grant where request_id = $1', [id])).toEqual([]);
    });

    it('is refused when what is asked is not valid: no end condition, a review a year and a day away, an administrative permission, a fixed end before the review', async () => {
      const before = (await rows<{ n: string }>('select count(*)::text as n from machvon.standing_delegation_request'))[0]?.n;
      expect(await requestStanding(LEADER_A, { end_condition_text: 'soon' })).toMatchObject({ status: 422 });
      expect(await requestStanding(LEADER_A, { review_due_at: new Date(Date.now() + 366 * DAY).toISOString() })).toMatchObject({ status: 422, json: { code: 'DELEGATION_INVALID', detail: 'review_due_at' } });
      expect(await requestStanding(LEADER_A, { permissions: ['approval.decide', 'iam.role.grant'] })).toMatchObject({ status: 422, json: { code: 'DELEGATION_INVALID' } });
      expect(await requestStanding(LEADER_A, { end_condition_kind: 'UNTIL_DATE', end_on: new Date(Date.now() + 100 * DAY).toISOString() })).toMatchObject({ status: 422, json: { code: 'DELEGATION_INVALID', detail: 'review_due_at' } });
      expect(await requestStanding(LEADER_A, { period_codes: ['Q3-2026'] })).toMatchObject({ status: 422, json: { code: 'DELEGATION_INVALID' } });
      expect(await requestStanding(LEADER_A, { delegate_membership_id: memberId(LEADER_A) })).toMatchObject({ status: 403, json: { code: 'SELF_GRANT_DENIED' } });
      expect(await requestStanding(LEADER_A, { permissions: ['doc.outgoing.sign'] })).toMatchObject({ status: 403, json: { code: 'ROLE_ESCALATION_DENIED' } });
      expect(await requestStanding(LEADER_A, { delegate_membership_id: randomUUID() })).toMatchObject({ status: 404 });
      expect(await requestStanding(OUTSIDER, { permissions: ['approval.decide'] })).toMatchObject({ status: 403, json: { code: 'ROLE_ESCALATION_DENIED' } });
      expect((await rows<{ n: string }>('select count(*)::text as n from machvon.standing_delegation_request'))[0]?.n).toBe(before);
    });

    it('is not approved when the delegator no longer holds what it passes on', async () => {
      const asked = await requestStanding(LEADER_B, { delegate_membership_id: memberId(OUTSIDER) });
      const id = asked.json.resource_id as string;
      await rows("update machvon.role_grant set status = 'Revoked', revoked_at = now() where id = $1", [grantId(6)]);
      try {
        expect(await decideStanding(id, 1, APPROVER)).toMatchObject({ status: 403, json: { code: 'ROLE_ESCALATION_DENIED' } });
      } finally {
        await rows("update machvon.role_grant set status = 'Active', revoked_at = null where id = $1", [grantId(6)]);
      }
      expect((await rows<{ status: string }>('select status from machvon.standing_delegation_request where id = $1', [id]))[0]?.status).toBe('Pending');
    });

    it('is taken back by the delegator before it is decided, and by nobody else', async () => {
      const asked = await requestStanding(LEADER_A);
      const id = asked.json.resource_id as string;
      expect(await call('POST', `/standing-delegation-requests/${id}/cancel`, { member: APPROVER, ifMatch: '"1"', body: { reason: 'Not needed any more, sorry.' } })).toMatchObject({ status: 403 });
      expect(await call('POST', `/standing-delegation-requests/${id}/cancel`, { member: LEADER_A, ifMatch: '"1"', body: { reason: 'Not needed any more, sorry.' } })).toMatchObject({ status: 200, json: { status: 'CANCELLED' } });
      expect(await decideStanding(id, 2, APPROVER)).toMatchObject({ status: 409, json: { code: 'DELEGATION_STATE_INVALID' } });
    });

    it('is reviewed by its delegator, who moves the review date forward; nobody else, no time-boxed delegation, no date out of range', async () => {
      const { delegationId } = await standing();
      const next = new Date(Date.now() + 300 * DAY).toISOString();
      expect(await call('POST', `/delegations/${delegationId}/review`, { member: APPROVER, ifMatch: '"1"', body: { review_due_at: next } })).toMatchObject({ status: 403 });
      expect(await call('POST', `/delegations/${delegationId}/review`, { member: LEADER_A, ifMatch: '"1"', body: { review_due_at: new Date(Date.now() + 100 * DAY).toISOString() } })).toMatchObject({ status: 422, json: { code: 'DELEGATION_INVALID' } });
      expect(await call('POST', `/delegations/${delegationId}/review`, { member: LEADER_A, ifMatch: '"1"', body: { review_due_at: new Date(Date.now() + 400 * DAY).toISOString() } })).toMatchObject({ status: 422, json: { code: 'DELEGATION_INVALID' } });
      const reviewed = await call('POST', `/delegations/${delegationId}/review`, { member: LEADER_A, ifMatch: '"1"', body: { review_due_at: next, note: 'Still needed until the appointment.' } });
      expect(reviewed).toMatchObject({ status: 200, json: { status: 'ACTIVE', resource_version: 2 } });
      const [row] = await rows<{ valid_until: Date; review_count: number }>('select valid_until, review_count from machvon.delegation_grant where id = $1', [delegationId]);
      expect(new Date((row as { valid_until: Date }).valid_until).toISOString()).toBe(next);
      expect(row?.review_count).toBe(1);
      expect((await auditOf(delegationId, 'delegation.reviewed'))[0]).toMatchObject({ actor_id: memberId(LEADER_A), reason: 'Still needed until the appointment.' });
      const listed = await call('GET', '/resources/delegation_grant?kind=PERMANENT&role=given', { member: LEADER_A });
      const item = (listed.json.items as Array<Record<string, unknown>>).find((entry) => entry.id === delegationId);
      expect(item).toMatchObject({ kind: 'PERMANENT', review_due_at: expect.stringContaining(next.slice(0, 19)), review_count: 1, end_condition_kind: 'UNTIL_EVENT', actions: { review: true, revoke: true } });
      const timeBoxed = await call('POST', '/delegations', {
        member: LEADER_A,
        body: { delegate_membership_id: memberId(OUTSIDER), permissions: ['approval.decide'], scope_kind: 'UNIT_SUBTREE', scope_ref_ids: [unitId(ROOT)], valid_from: new Date().toISOString(), valid_until: new Date(Date.now() + 7 * DAY).toISOString(), reason: 'Away for a week of work.' },
      });
      expect(await call('POST', `/delegations/${timeBoxed.json.resource_id as string}/review`, { member: LEADER_A, ifMatch: '"1"', body: { review_due_at: next } })).toMatchObject({ status: 409, json: { code: 'DELEGATION_STATE_INVALID' } });
      expect(await call('POST', `/delegations/${delegationId}/revoke`, { member: LEADER_A, ifMatch: '"2"', body: { reason: 'The appointment was made, no longer needed.' } })).toMatchObject({ status: 200 });
    });

    it('stops working at once when it is revoked, and when its review date has passed', async () => {
      const revoked = await standing(LEADER_A, DELEGATE);
      const instance = await startInstance();
      const task = await taskOf(instance, LEADER_A);
      expect(await call('POST', `/delegations/${revoked.delegationId}/revoke`, { member: LEADER_A, ifMatch: '"1"', body: { reason: 'The appointment was made, no longer needed.' } })).toMatchObject({ status: 200, json: { status: 'REVOKED' } });
      expect(await decideTask(DELEGATE, task)).toMatchObject({ status: 403 });
      // One whose review date passed without a review: the window is over, whatever the job has or has not yet written.
      const lapsedRequest = await harness.tenants.withTenant(contextFor(TENANT_A, memberId(LEADER_B)), async (tx) => {
        const past = new Date(Date.now() - 30 * DAY);
        const input = { delegatorId: memberId(LEADER_B), delegateId: memberId(DELEGATE), permissions: ['approval.decide'], scopeKind: 'UNIT_SUBTREE', scopeRefIds: [unitId(ROOT)], periodCodes: undefined, startsAt: past, reviewDueAt: new Date(Date.now() - HOUR), endConditionKind: 'UNTIL_EVENT', endConditionText: 'Until the deputy director is appointed.', endOn: undefined, reason: 'Standing handover of the approval of reports.', legalBasisRef: undefined };
        const request = await requestStore.insert(tx, input);
        const made = await delegationStore.insertStanding(tx, { ...input, validFrom: past, requestId: request.id, now: past });
        await requestStore.approve(tx, request.id, memberId(APPROVER), made.id, undefined, past);
        return made;
      });
      expect(lapsedRequest.status).toBe('Active');
      const second = await taskOf(await startInstance(), LEADER_B);
      expect(await decideTask(DELEGATE, second)).toMatchObject({ status: 403 });
    });

    it('is limited to report periods when it says so: a task whose resource has no such period is out of its reach', async () => {
      await standing(LEADER_B, OUTSIDER, { period_codes: ['2026-Q3'] });
      const task = await taskOf(await startInstance(), LEADER_B);
      expect(await decideTask(OUTSIDER, task)).toMatchObject({ status: 403, json: { code: 'PERIOD_SCOPE_DENIED' } });
      expect((await rows<{ status: string }>('select status from machvon.approval_task where id = $1', [task.id]))[0]?.status).toBe('Pending');
    });

    it('is read by the two parties and by the approver, and not by a stranger', async () => {
      const asked = await requestStanding(LEADER_A, { delegate_membership_id: memberId(LEADER_B) });
      const id = asked.json.resource_id as string;
      expect(await call('GET', `/resources/standing_delegation_request/${id}`, { member: LEADER_A })).toMatchObject({ status: 200, json: { id, status: 'Pending', actions: { cancel: true, decide: false } } });
      expect(await call('GET', `/resources/standing_delegation_request/${id}`, { member: LEADER_B })).toMatchObject({ status: 200 });
      expect(await call('GET', `/resources/standing_delegation_request/${id}`, { member: APPROVER })).toMatchObject({ status: 200, json: { actions: { decide: true, cancel: false } } });
      expect(await call('GET', `/resources/standing_delegation_request/${id}`, { member: OUTSIDER })).toMatchObject({ status: 404 });
      const listed = await call('GET', '/resources/standing_delegation_request?status=Pending', { member: OUTSIDER });
      // The stranger sees only the requests of which they are a party (here, the ones that name them as delegate).
      expect((listed.json.items as Array<{ id: string; delegator: { id: string }; delegate: { id: string } }>).every((item) => item.delegate.id === memberId(OUTSIDER) || item.delegator.id === memberId(OUTSIDER))).toBe(true);
      expect((listed.json.items as Array<{ id: string }>).some((item) => item.id === id)).toBe(false);
    });
  });

  describe('no loop of delegations', () => {
    it('refuses a delegation that gives back what was given, to one who gave it, directly or through another, in both kinds', async () => {
      const body = (delegate: number) => ({ delegate_membership_id: memberId(delegate), permissions: ['approval.decide'], scope_kind: 'UNIT_SUBTREE', scope_ref_ids: [unitId(ROOT)], valid_from: new Date().toISOString(), valid_until: new Date(Date.now() + 7 * DAY).toISOString(), reason: 'Away for a week of work.' });
      const forward = await call('POST', '/delegations', { member: MAKER, body: body(LEADER_A) });
      expect(forward.status).toBe(201);
      expect(await call('POST', '/delegations', { member: LEADER_A, body: body(MAKER) })).toMatchObject({ status: 403, json: { code: 'DELEGATION_CYCLE_DENIED', cycle_length: 2 } });
      expect(await requestStanding(LEADER_A, { delegate_membership_id: memberId(MAKER) })).toMatchObject({ status: 403, json: { code: 'DELEGATION_CYCLE_DENIED' } });
      // Through another person: MAKER gives to LEADER_A (above), LEADER_A gives to LEADER_B, LEADER_B may not give to MAKER.
      expect((await call('POST', '/delegations', { member: LEADER_A, body: body(LEADER_B) })).status).toBe(201);
      expect(await call('POST', '/delegations', { member: LEADER_B, body: body(MAKER) })).toMatchObject({ status: 403, json: { code: 'DELEGATION_CYCLE_DENIED', cycle_length: 3 } });
      // Another permission is another thing: no loop.
      await call('POST', `/delegations/${forward.json.resource_id as string}/revoke`, { member: MAKER, ifMatch: '"1"', body: { reason: 'The week of work was cancelled.' } });
    });
  });

  describe('acting on behalf of a person', () => {
    it('is requested with a reason, approved by a second person, and then works for the administrator with both identities on every audit row', async () => {
      const asked = await requestActing(ADMIN);
      expect(asked).toMatchObject({ status: 201, json: { status: 'PENDING', resource_version: 1 } });
      const id = asked.json.resource_id as string;
      expect((await auditOf(id, 'acting.requested')).map((row) => row.reason)).toEqual([REASON]);
      // Nothing works before the approval.
      expect(await probe(ADMIN, id)).toMatchObject({ status: 403, json: { code: 'ACTING_NOT_LIVE' } });
      expect(await decideActing(id, 1, APPROVER)).toMatchObject({ status: 200, json: { status: 'APPROVED', resource_version: 2 } });
      const done = await probe(ADMIN, id);
      expect(done).toMatchObject({ status: 200, json: { status: 'WRITTEN' } });
      const written = (await rows<{ actor_id: string; on_behalf_of_id: string | null; safe_diff: Record<string, unknown> }>("select actor_id, on_behalf_of_id, safe_diff from machvon.audit_event where action = 'probe.written' and resource_id = $1", [done.json.resource_id]))[0];
      expect(written).toMatchObject({ actor_id: memberId(ADMIN), on_behalf_of_id: memberId(SUBJECT), safe_diff: { acting_as: { grant_id: id, subject_membership_id: memberId(SUBJECT) } } });
      const used = await auditOf(id, 'acting.used');
      expect(used.length).toBeGreaterThanOrEqual(1);
      expect(used[0]).toMatchObject({ actor_id: memberId(ADMIN), on_behalf_of_id: memberId(SUBJECT) });
      // Without the header the administrator is only the administrator: the person's right is not theirs.
      expect(await probe(ADMIN)).toMatchObject({ status: 403 });
    });

    it('judges the request on the person as listed and on nothing else: not the right of the administrator, not what the grant does not list', async () => {
      const id = await actingGrant();
      expect(await call('GET', '/resources/approval_task', { member: ADMIN, acting: id })).toMatchObject({ status: 403 });
      expect(await call('GET', '/resources/acting_grant', { member: ADMIN, acting: id })).toMatchObject({ status: 403 });
      expect(await call('GET', '/resources/acting_grant', { member: ADMIN })).toMatchObject({ status: 200 });
    });

    it('is refused when it is asked for oneself, for a decision, for administration, for a permission the person does not hold, or for too long', async () => {
      const before = (await rows<{ n: string }>('select count(*)::text as n from machvon.acting_grant'))[0]?.n;
      expect(await requestActing(ADMIN, { subject_membership_id: memberId(ADMIN) })).toMatchObject({ status: 403, json: { code: 'ACTING_SELF_DENIED' } });
      expect(await requestActing(ADMIN, { permissions: ['approval.decide'] })).toMatchObject({ status: 422, json: { code: 'ACTING_INVALID', detail: 'permissions[0]' } });
      expect(await requestActing(ADMIN, { permissions: ['doc.outgoing.sign'] })).toMatchObject({ status: 422, json: { code: 'ACTING_INVALID' } });
      expect(await requestActing(ADMIN, { permissions: ['iam.role.grant'] })).toMatchObject({ status: 422, json: { code: 'ACTING_INVALID' } });
      expect(await requestActing(ADMIN, { permissions: ['report.review'] })).toMatchObject({ status: 422, json: { code: 'ACTING_INVALID', detail: 'permissions[0]' } });
      expect(await requestActing(ADMIN, { permissions: ['test.record.delete'] })).toMatchObject({ status: 422, json: { code: 'ACTING_INVALID', detail: 'permissions[0]' } });
      expect(await requestActing(ADMIN, { hours: 9 })).toMatchObject({ status: 422 });
      expect(await requestActing(ADMIN, { reason: 'short' })).toMatchObject({ status: 422 });
      expect(await requestActing(ADMIN, { period_codes: ['nonsense'] })).toMatchObject({ status: 422, json: { code: 'ACTING_INVALID' } });
      expect(await requestActing(ADMIN, { subject_membership_id: randomUUID() })).toMatchObject({ status: 404 });
      expect(await requestActing(OUTSIDER)).toMatchObject({ status: 403 });
      expect((await rows<{ n: string }>('select count(*)::text as n from machvon.acting_grant'))[0]?.n).toBe(before);
    });

    it('is approved by someone who is neither the administrator nor the person: maker is not checker', async () => {
      const asked = await requestActing(ADMIN);
      const id = asked.json.resource_id as string;
      expect(await decideActing(id, 1, ADMIN)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect(await decideActing(id, 1, SUBJECT)).toMatchObject({ status: 403 });
      expect(await decideActing(id, 1, APPROVER, { decision: 'reject' })).toMatchObject({ status: 422, json: { detail: 'reason' } });
      expect(await decideActing(id, 1, APPROVER, { decision: 'reject', reason: 'The report can wait for the reporter.' })).toMatchObject({ status: 200, json: { status: 'REJECTED' } });
      expect(await decideActing(id, 2, APPROVER)).toMatchObject({ status: 409, json: { code: 'ACTING_STATE_INVALID' } });
      expect(await probe(ADMIN, id)).toMatchObject({ status: 403, json: { code: 'ACTING_NOT_LIVE' } });
    });

    it('stops at once when it is revoked, by the administrator or by the approver, and not for anyone else', async () => {
      const id = await actingGrant();
      expect(await probe(ADMIN, id)).toMatchObject({ status: 200 });
      expect(await call('POST', `/acting-requests/${id}/revoke`, { member: OUTSIDER, ifMatch: '"2"', body: { reason: 'Revoked by someone with no right to.' } })).toMatchObject({ status: 403 });
      expect(await call('POST', `/acting-requests/${id}/revoke`, { member: APPROVER, ifMatch: '"2"', body: { reason: 'The reporter is back at work.' } })).toMatchObject({ status: 200, json: { status: 'REVOKED' } });
      expect(await probe(ADMIN, id)).toMatchObject({ status: 403, json: { code: 'ACTING_NOT_LIVE' } });
      const own = await actingGrant();
      expect(await call('POST', `/acting-requests/${own}/revoke`, { member: ADMIN, ifMatch: '"2"', body: { reason: 'The data entry is done.' } })).toMatchObject({ status: 200 });
      expect((await auditOf(own, 'acting.revoked'))[0]).toMatchObject({ actor_id: memberId(ADMIN) });
    });

    it('stops when its window is over, and is not used by anyone but the one who asked, nor after the person stops being a member', async () => {
      const id = await actingGrant();
      expect(await probe(APPROVER, id)).toMatchObject({ status: 403 });
      await rows("update machvon.membership set status = 'Suspended' where id = $1", [memberId(SUBJECT)]);
      try {
        expect(await probe(ADMIN, id)).toMatchObject({ status: 403, json: { code: 'ACTING_NOT_LIVE' } });
      } finally {
        await rows("update machvon.membership set status = 'Active' where id = $1", [memberId(SUBJECT)]);
      }
      expect(await probe(ADMIN, id)).toMatchObject({ status: 200 });
      await rows("update machvon.acting_grant set window_start = now() - interval '5 hours', window_end = now() - interval '1 hour' where id = $1", [id]);
      expect(await probe(ADMIN, id)).toMatchObject({ status: 403, json: { code: 'ACTING_NOT_LIVE' } });
      expect(await probe(ADMIN, 'not-an-id')).toMatchObject({ status: 403, json: { code: 'ACTING_NOT_LIVE' } });
      expect(await probe(ADMIN, randomUUID())).toMatchObject({ status: 403, json: { code: 'ACTING_NOT_LIVE' } });
      expect((await rows<{ n: string }>("select count(*)::text as n from machvon.audit_event where action like 'authz.denied:%' and safe_diff->>'reason' = 'ACTING_GRANT'"))[0]?.n).not.toBe('0');
    });

    it('is read by the administrator and the approver (the right to read it), and by nobody else', async () => {
      const asked = await requestActing(ADMIN);
      const id = asked.json.resource_id as string;
      expect(await call('GET', `/resources/acting_grant/${id}`, { member: ADMIN })).toMatchObject({ status: 200, json: { id, status: 'Pending', phase: 'PENDING', actions: { cancel: true, decide: false } } });
      expect(await call('GET', `/resources/acting_grant/${id}`, { member: APPROVER })).toMatchObject({ status: 200, json: { actions: { decide: true } } });
      expect(await call('GET', `/resources/acting_grant/${id}`, { member: SUBJECT })).toMatchObject({ status: 403 });
      expect(await call('GET', `/resources/acting_grant/${id}`, { member: LEADER_A })).toMatchObject({ status: 403 });
      expect(await call('POST', `/acting-requests/${id}/cancel`, { member: APPROVER, ifMatch: '"1"', body: { reason: 'Cancelled by someone else.' } })).toMatchObject({ status: 403 });
      expect(await call('POST', `/acting-requests/${id}/cancel`, { member: ADMIN, ifMatch: '"1"', body: { reason: 'The report was filed already.' } })).toMatchObject({ status: 200, json: { status: 'CANCELLED' } });
    });

    it('does not cross tenants: a grant of this tenant is not found by a member of another', async () => {
      const id = await actingGrant();
      expect(await call('GET', `/resources/acting_grant/${id}`, { member: OTHER_TENANT, tenantId: TENANT_B })).toMatchObject({ status: 403 });
      expect(await probe(OTHER_TENANT, id)).toMatchObject({ status: 403 });
    });
  });

  describe('the limit of a role grant to report periods', () => {
    it('is set by someone who may grant the role, raises the scope version of the holder, and shows in the list; lifting it is judged the same way', async () => {
      const before = await scopeVersionOf(PERIODIC);
      const set = await call('POST', '/period-scopes', { member: ADMIN, body: { role_grant_id: grantId(11), period_codes: ['2026-Q3', '2026-Q4'], reason: 'The reporter covers the second half of the year only.' } });
      expect(set).toMatchObject({ status: 201, json: { status: 'ACTIVE', resource_version: 1 } });
      const id = set.json.resource_id as string;
      expect(await scopeVersionOf(PERIODIC)).toBe(before + 1);
      expect((await auditOf(id, 'period_scope.set'))[0]).toMatchObject({ actor_id: memberId(ADMIN), safe_diff: { period_codes: ['2026-Q3', '2026-Q4'], membership_id: memberId(PERIODIC) } });
      expect((await call('GET', `/resources/period_scope/${id}`, { member: ADMIN })).json).toMatchObject({ status: 'Active', role_code: 'PERIOD_HOLDER', period_codes: ['2026-Q3', '2026-Q4'], member: { id: memberId(PERIODIC) }, actions: { lift: true } });
      const listed = await call('GET', `/resources/period_scope?status=Active&membership_id=${memberId(PERIODIC)}`, { member: ADMIN });
      expect((listed.json.items as Array<Record<string, unknown>>).map((item) => item.id)).toContain(id);
      expect(await call('POST', '/period-scopes', { member: ADMIN, body: { role_grant_id: grantId(11), period_codes: ['2027'], reason: 'Another limit on the same grant.' } })).toMatchObject({ status: 409, json: { code: 'PERIOD_SCOPE_STATE_INVALID' } });
      expect(await call('POST', `/period-scopes/${id}/lift`, { member: OUTSIDER, ifMatch: '"1"', body: { reason: 'Lifted by someone with no right to.' } })).toMatchObject({ status: 403 });
      expect(await call('POST', `/period-scopes/${id}/lift`, { member: ADMIN, ifMatch: '"1"', body: { reason: 'The reporter covers every period again.' } })).toMatchObject({ status: 200, json: { status: 'LIFTED' } });
      expect(await scopeVersionOf(PERIODIC)).toBe(before + 2);
    });

    it('is refused for the holder of the grant themselves, for a malformed list, and for a grant that is not there', async () => {
      expect(await call('POST', '/period-scopes', { member: ADMIN, body: { role_grant_id: grantId(1), period_codes: ['2026'], reason: 'Limiting my own role to this year.' } })).toMatchObject({ status: 403, json: { code: 'SELF_GRANT_DENIED' } });
      expect(await call('POST', '/period-scopes', { member: ADMIN, body: { role_grant_id: grantId(11), period_codes: ['2026', '2026-Q3'], reason: 'The reporter covers the year and a quarter.' } })).toMatchObject({ status: 422, json: { code: 'PERIOD_SCOPE_INVALID' } });
      expect(await call('POST', '/period-scopes', { member: ADMIN, body: { role_grant_id: grantId(11), period_codes: ['Q3-2026'], reason: 'The reporter covers a quarter only.' } })).toMatchObject({ status: 422, json: { code: 'PERIOD_SCOPE_INVALID' } });
      expect(await call('POST', '/period-scopes', { member: ADMIN, body: { role_grant_id: randomUUID(), period_codes: ['2026'], reason: 'A grant that does not exist at all.' } })).toMatchObject({ status: 404 });
      expect(await call('POST', '/period-scopes', { member: LEADER_A, body: { role_grant_id: grantId(11), period_codes: ['2026'], reason: 'Not someone who grants roles at all.' } })).toMatchObject({ status: 403 });
    });
  });
});
