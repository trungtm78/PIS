import { randomUUID } from 'node:crypto';
import { ApprovalStore } from '@machvon/db';
import type { TenantDatabase, TenantTx } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { PushStatus } from '@machvon/kernel';
import { ApprovalCommandsController, ApprovalTaskReadsController, WorkflowInstanceReadsController } from '../../src/modules/adm/approval.controller';
import { APPROVAL_PUSH_PORT, APPROVAL_PUSH_SOURCES, ApprovalHoldService, ApprovalPushSources } from '../../src/modules/adm/approval-hold.service';
import type { ApprovalPushCall, ApprovalPushPort, ApprovalPushResult } from '../../src/modules/adm/approval-hold.service';
import { APPROVAL_FINAL_COMMANDS, FinalCommandRegistry } from '../../src/modules/adm/approval.service';
import { DisReportApprovalBinding } from '../../src/modules/dis/report-approval.binding';
import { ReportWorkflowReadsController } from '../../src/modules/dis/report-workflow.controller';
import { DisFlow, READER, ROOT, TENANT_A, id, memberId, unitId } from './support/dis-flow-app';

jest.setTimeout(300_000);

const LEADER = 10; // approves as the unit approver (the band of the matrix of authority)
const PLANNER = 11; // the planning review: holds PLANNING_REVIEWER in the root unit
const CLOSER = 12; // names the closing of the period
const PUSHER = 13; // names the push of the figures
const WRITER = 14; // proposes the rule
const CHECKER = 15; // approves the rule
const DECIDING = ['report.review', 'report.read', 'report_revision.read', 'approval.decide', 'approval_task.read', 'workflow_instance.read'] as const;
const REGISTRY = new FinalCommandRegistry();
const SOURCES = new ApprovalPushSources();
let PUSH_ID = randomUUID();

/** A receiver that records what it was handed and answers as the test says: written (the default), failed, or a refusal of a stale revision. */
class FakeReceiver implements ApprovalPushPort {
  readonly calls: ApprovalPushCall[] = [];
  next: 'WRITTEN' | 'FAILED' | 'STALE' = 'WRITTEN';
  push(_tx: unknown, call: ApprovalPushCall): Promise<ApprovalPushResult> {
    this.calls.push(call);
    if (this.next === 'STALE') return Promise.reject(new DomainError('REPORT_OUT_OF_DATE', 409, 'revision', { extensions: { current_revision: call.revision + 1 } }));
    const status: PushStatus = this.next;
    return Promise.resolve({ pushId: PUSH_ID, key: `${call.tenantId}|${call.layoutCode}|${call.period}|r${call.revision}`, status, errorCode: status === 'FAILED' ? 'HPM_DELIVERY_FAILED' : null });
  }
}
const RECEIVER = new FakeReceiver();

const CLOCK = new Date('2026-12-15T00:00:00Z');

const step = (stepId: string, kind: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id: stepId, kind, name: `Step ${stepId}`, assignee_type: 'DOA', min_approvals: 1, sla_working_hours: 24, on_timeout: 'REMIND', ...extra });
const CHAIN = [
  step('unit-approver', 'UNIT_APPROVER'),
  step('planning-review', 'PLANNING_REVIEW', { assignee_type: 'ROLE_IN_UNIT', role_code: 'PLANNING_REVIEWER', unit_id: unitId(ROOT), sla_working_hours: 16, on_timeout: 'ESCALATE', escalate_to: memberId(LEADER) }),
  step('period-close', 'PERIOD_CLOSE', { assignee_type: 'SPECIFIC', membership_ids: [memberId(CLOSER)], sla_working_hours: 8 }),
  step('push', 'PUSH', { assignee_type: 'SPECIFIC', membership_ids: [memberId(PUSHER)], sla_working_hours: 8 }),
];

/** ENT-3c: the PUSH step of the staged approval waits for the receipt of the receiver (R22, R17). */
describe('the PUSH step of the staged approval waits for the receipt (ENT-3c)', () => {
  const flow = new DisFlow();
  const store = new ApprovalStore();

  beforeAll(async () => {
    await flow.start({
      tmpPrefix: 'machvon-dis-staged-',
      extraRoles: [
        { n: 10, code: 'DIS_LEADER', permissions: DECIDING, rank: 60 },
        { n: 11, code: 'PLANNING_REVIEWER', permissions: DECIDING, rank: 30 },
        { n: 12, code: 'DIS_CLOSER', permissions: DECIDING, rank: 25 },
        { n: 13, code: 'RULE_WRITER', permissions: ['report.read'], rank: 10 },
      ],
      extraMembers: [
        { n: LEADER, roleNumber: 10 },
        { n: PLANNER, roleNumber: 11 },
        { n: CLOSER, roleNumber: 12 },
        { n: PUSHER, roleNumber: 12 },
        { n: WRITER, roleNumber: 13 },
        { n: CHECKER, roleNumber: 13 },
      ],
      controllers: [ApprovalCommandsController, WorkflowInstanceReadsController, ApprovalTaskReadsController, ReportWorkflowReadsController],
      providers: [{ provide: APPROVAL_FINAL_COMMANDS, useValue: REGISTRY }, { provide: APPROVAL_PUSH_SOURCES, useValue: SOURCES }, { provide: APPROVAL_PUSH_PORT, useValue: RECEIVER }, ApprovalHoldService, DisReportApprovalBinding],
      afterSeed: async (fixture) => {
        const matrix = randomUUID();
        await fixture.harness.owner(TENANT_A, [
          [`insert into machvon.doa_matrix_version (tenant_id, id, revision, status, effective_from, legal_basis_ref, created_by, last_edited_by, version) values ($1, $2, 901, 'Draft', date '2020-01-01', 'Fixture regulation on approvals', $3, $3, 1)`, [TENANT_A, matrix, memberId(WRITER)]],
          [
            `insert into machvon.doa_rule (tenant_id, id, matrix_version_id, document_type, unit_id, include_subtree, amount_min_vnd, amount_max_vnd, approver_role_id, approval_levels, position)
             values ($1, $2, $3, 'REPORT_ACCEPT', $4, true, 0, null, $5, 1, 0)`,
            [TENANT_A, randomUUID(), matrix, unitId(ROOT), id(0x30, 10)],
          ],
          ["update machvon.doa_matrix_version set status = 'PendingApproval' where id = $1", [matrix]],
          ["update machvon.doa_matrix_version set status = 'Published', approved_by = $2, published_at = now() where id = $1", [matrix, memberId(CHECKER)]],
        ]);
      },
    });
    flow.clockNow = CLOCK;
  });

  afterAll(async () => {
    await flow.stop();
  });

  /** A new approved version of the rule from the first day of the year: the one in force until now is ended on its first day, so it governs nothing and the two never overlap. */
  const approveRule = async (steps: unknown[], mode = 'STAGED', code = 'REPORT_ACCEPT'): Promise<unknown[]> => {
    await flow.rows("update machvon.governance_rule set effective_to = effective_from where rule_type = 'APPROVAL_WORKFLOW_DEFINITION' and code = $1 and effective_to is null", [code]);
    return flow.rows(
      `insert into machvon.governance_rule (tenant_id, id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at, row_version)
       select $1, $2, 'APPROVAL_WORKFLOW_DEFINITION', $3, coalesce(max(version), 0) + 1, 'APPROVED', $4::jsonb, date '2026-01-01', 'Steps of the review', $5, $5, now(), $6, now(), 1
         from machvon.governance_rule where rule_type = 'APPROVAL_WORKFLOW_DEFINITION' and code = $3`,
      [TENANT_A, randomUUID(), code, JSON.stringify({ mode, steps }), memberId(WRITER), memberId(CHECKER)],
    );
  };
  const holdOf = (reportId: string) =>
    flow.rows<{ state: string; push_status: string | null; attempts: number; held_by: string }>(
      'select h.state, h.push_status, h.attempts, h.held_by from machvon.approval_step_hold h join machvon.workflow_instance i on i.id = h.workflow_instance_id where i.resource_id = $1 order by h.created_at desc',
      [reportId],
    );
  const taskStatuses = (reportId: string) => flow.rows<{ step_id: string; status: string }>('select t.step_id, t.status from machvon.approval_task t join machvon.workflow_instance i on i.id = t.workflow_instance_id where i.resource_id = $1 order by t.step_index', [reportId]);
  /** Everything up to the PUSH step is approved; the next approval by the pusher is the one that hands the package over. */
  const atPush = async (): Promise<string> => {
    const { reportId } = await flow.submitted();
    for (const member of [LEADER, PLANNER, CLOSER]) expect(await flow.approve(reportId, 2, member)).toMatchObject({ status: 200, json: { status: 'STEP_APPROVED' } });
    return reportId;
  };
  const effectsOf = (member: number) => ({ actor: memberId(member), audit: () => Promise.resolve(undefined), emit: () => Promise.resolve(undefined) });
  const inTenant = <T>(member: number, run: (tx: TenantTx) => Promise<T>): Promise<T> => (flow.harness.tenants as TenantDatabase).withTenant({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 0 }, run);
  /** The receiver answers: the command that records the receipt calls this in its own transaction. */
  const receipt = (outcome: 'ACCEPTED' | 'REJECTED', by: number) =>
    inTenant(by, (tx) => store.answerHold(tx, effectsOf(by), { pushId: PUSH_ID, outcome, by: memberId(by), reference: 'HPM-REF-1', now: new Date(CLOCK), finish: REGISTRY.asFinalCommand() }));

  beforeEach(async () => {
    RECEIVER.calls.length = 0;
    RECEIVER.next = 'WRITTEN';
    // One push per test: a clock that stands still gives every hold the same time.
    PUSH_ID = randomUUID();
    await approveRule(CHAIN);
  });

  it('R22: the PUSH step hands the package over and waits: AWAITING_RECEIPT, the task pending, the report not accepted', async () => {
    const reportId = await atPush();
    const handed = await flow.approve(reportId, 2, PUSHER);
    expect(handed).toMatchObject({ status: 200, json: { status: 'AWAITING_RECEIPT' } });
    expect(RECEIVER.calls).toHaveLength(1);
    expect(RECEIVER.calls[0]).toMatchObject({ owner: 'REPORT', revision: 1, actor: memberId(PUSHER) });
    expect(RECEIVER.calls[0]?.layoutCode).toMatch(/^DIS_WEEKLY-/);
    expect(await holdOf(reportId)).toEqual([{ state: 'AWAITING_RECEIPT', push_status: 'WRITTEN', attempts: 1, held_by: memberId(PUSHER) }]);
    expect(await taskStatuses(reportId)).toEqual(expect.arrayContaining([{ step_id: 'push', status: 'Pending' }]));
    // Not done: the report is still waiting and the instance still runs.
    expect(await flow.state(reportId)).toMatchObject({ status: 'SUBMITTED', is_current: false, accepted_by: null });
    expect((await flow.rows<{ status: string }>('select status from machvon.workflow_instance where resource_id = $1', [reportId]))[0]?.status).toBe('Running');
    // A second approval while the package waits changes nothing and hands nothing over again.
    expect(await flow.approve(reportId, 2, PUSHER)).toMatchObject({ status: 200, json: { status: 'AWAITING_RECEIPT' } });
    expect(RECEIVER.calls).toHaveLength(1);
    // The steps screen reads the PUSH step as waiting for the receipt, not as done.
    const view = await flow.call('GET', `/reports/${reportId}/workflow`, { member: READER });
    const steps = view.json.steps as Array<{ id: string; status: string; receipt: { state: string; push_id: string } | null }>;
    expect(steps.find((one) => one.id === 'push')).toMatchObject({ status: 'AWAITING_RECEIPT', receipt: { state: 'AWAITING_RECEIPT', push_id: PUSH_ID } });
    expect(steps.find((one) => one.id === 'planning-review')?.receipt ?? null).toBeNull();
  });

  it('R22: only the receipt releases the step: the decision of the pusher is finished as theirs and the report is accepted once', async () => {
    const reportId = await atPush();
    await flow.approve(reportId, 2, PUSHER);
    expect(await receipt('ACCEPTED', CLOSER)).toMatchObject({ kind: 'RELEASED' });
    expect(await flow.state(reportId)).toMatchObject({ status: 'ACCEPTED', is_current: true, accepted_by: memberId(PUSHER) });
    expect((await holdOf(reportId))[0]).toMatchObject({ state: 'PUSHED' });
    expect((await flow.rows<{ status: string; outcome: string }>('select status, outcome from machvon.workflow_instance where resource_id = $1', [reportId]))[0]).toEqual({ status: 'Completed', outcome: 'APPROVED' });
    // The receipt of a push that nothing waits for changes nothing.
    expect(await receipt('ACCEPTED', CLOSER)).toBeUndefined();
  });

  it('R22: a rejection of the receiver ends the hold and leaves the report waiting; the usual return still sends it back', async () => {
    const reportId = await atPush();
    await flow.approve(reportId, 2, PUSHER);
    expect(await receipt('REJECTED', CLOSER)).toMatchObject({ kind: 'REJECTED' });
    expect((await holdOf(reportId))[0]).toMatchObject({ state: 'REJECTED' });
    expect(await flow.state(reportId)).toMatchObject({ status: 'SUBMITTED' });
    expect(await flow.giveBack(reportId, 2, {}, PUSHER)).toMatchObject({ status: 200, json: { status: 'RETURNED' } });
    expect(await flow.state(reportId)).toMatchObject({ status: 'RETURNED' });
  });

  it('a failed delivery is a state a person can retry with the same key: PUSH_FAILED, then AWAITING_RECEIPT on the next attempt', async () => {
    const reportId = await atPush();
    RECEIVER.next = 'FAILED';
    expect(await flow.approve(reportId, 2, PUSHER)).toMatchObject({ status: 200, json: { status: 'PUSH_FAILED' } });
    expect((await holdOf(reportId))[0]).toMatchObject({ state: 'PUSH_FAILED', push_status: 'FAILED', attempts: 1 });
    RECEIVER.next = 'WRITTEN';
    expect(await flow.approve(reportId, 2, PUSHER)).toMatchObject({ status: 200, json: { status: 'AWAITING_RECEIPT' } });
    expect(await holdOf(reportId)).toEqual([expect.objectContaining({ state: 'AWAITING_RECEIPT', attempts: 2 })]);
    expect(RECEIVER.calls.map((call) => call.revision)).toEqual([1, 1]);
  });

  it('R17: a revision the receiver already replaced is refused (409 REPORT_OUT_OF_DATE) and no hold is made', async () => {
    const reportId = await atPush();
    RECEIVER.next = 'STALE';
    expect(await flow.approve(reportId, 2, PUSHER)).toMatchObject({ status: 409, json: { code: 'REPORT_OUT_OF_DATE' } });
    expect(await holdOf(reportId)).toEqual([]);
    expect(await taskStatuses(reportId)).toEqual(expect.arrayContaining([{ step_id: 'push', status: 'Pending' }]));
  });

  it('keeps a task whose step waits for the receipt out of the SLA job: it is neither reminded nor expired', async () => {
    const reportId = await atPush();
    await flow.approve(reportId, 2, PUSHER);
    const swept = await inTenant(PUSHER, (tx) => store.sweepSla(tx, effectsOf(PUSHER), new Date('2030-01-01T00:00:00Z')));
    expect(swept.open).toBeGreaterThan(0);
    expect((await taskStatuses(reportId)).find((one) => one.step_id === 'push')?.status).toBe('Pending');
  });
});
