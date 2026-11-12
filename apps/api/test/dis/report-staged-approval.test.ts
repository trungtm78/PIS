import { randomUUID } from 'node:crypto';
import { ApprovalStore, enqueueOutbox } from '@machvon/db';
import { ApprovalCommandsController, ApprovalTaskReadsController, WorkflowInstanceReadsController } from '../../src/modules/adm/approval.controller';
import { APPROVAL_FINAL_COMMANDS, FinalCommandRegistry } from '../../src/modules/adm/approval.service';
import { DisReportApprovalBinding } from '../../src/modules/dis/report-approval.binding';
import { CLAIMS_HEADER, TENANT_HEADER } from '../isolation/test-auth.guard';
import { ReportWorkflowReadsController } from '../../src/modules/dis/report-workflow.controller';
import { B_MAKER, DisFlow, MAKER, READER, REVIEWER, ROOT, TENANT_A, TENANT_B, id, memberId, unitId } from './support/dis-flow-app';
import type { Reply } from './support/dis-flow-app';

jest.setTimeout(300_000);

const LEADER = 10; // approves as the unit approver (the band of the matrix of authority)
const PLANNER = 11; // the planning review: holds PLANNING_REVIEWER in the root unit
const CLOSER = 12; // names the closing of the period
const PUSHER = 13; // names the push of the figures
const WRITER = 14; // proposes the rule
const CHECKER = 15; // approves the rule
const DECIDING = ['report.review', 'report.read', 'report_revision.read', 'approval.decide', 'approval_task.read', 'workflow_instance.read'] as const;
const REGISTRY = new FinalCommandRegistry();
const CLOCK = new Date('2026-12-15T00:00:00Z');

const step = (stepId: string, kind: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id: stepId, kind, name: `Step ${stepId}`, assignee_type: 'DOA', min_approvals: 1, sla_working_hours: 24, on_timeout: 'REMIND', ...extra });
const CHAIN = [
  step('unit-approver', 'UNIT_APPROVER'),
  step('planning-review', 'PLANNING_REVIEW', { assignee_type: 'ROLE_IN_UNIT', role_code: 'PLANNING_REVIEWER', unit_id: unitId(ROOT), sla_working_hours: 16, on_timeout: 'ESCALATE', escalate_to: memberId(LEADER) }),
  step('period-close', 'PERIOD_CLOSE', { assignee_type: 'SPECIFIC', membership_ids: [memberId(CLOSER)], sla_working_hours: 8 }),
  step('push', 'PUSH', { assignee_type: 'SPECIFIC', membership_ids: [memberId(PUSHER)], sla_working_hours: 8 }),
];

/** WF-1: the weekly report approved on the ADM engine, in the steps a tenant approved as a governance rule (regression contract R4, mandatory final command R14). */
describe('the staged approval of a weekly report (WF-1)', () => {
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
      providers: [{ provide: APPROVAL_FINAL_COMMANDS, useValue: REGISTRY }, DisReportApprovalBinding],
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
  const instanceOf = async (reportId: string) => (await flow.rows<{ id: string; status: string; outcome: string | null; current_step: number; version: string }>('select id, status, outcome, current_step, version::text from machvon.workflow_instance where resource_id = $1 order by started_at desc', [reportId]))[0];
  const pending = (instanceId: string) => flow.rows<{ id: string; step_id: string; assignee_id: string; due_at: string; version: string }>("select id, step_id, assignee_id, due_at::text, version::text from machvon.approval_task where workflow_instance_id = $1 and status = 'Pending' order by step_index, assignee_id", [instanceId]);
  const actions = async (reportId: string, instanceId: string) =>
    (
      await flow.rows<{ action: string }>(
        'select action from machvon.audit_event where resource_id::text = any($1::text[]) or resource_id::text in (select id::text from machvon.approval_task where workflow_instance_id = $2::uuid) order by occurred_at, id',
        [[reportId, instanceId], instanceId],
      )
    ).map((row) => row.action);
  const adm = (taskId: string, version: string, member: number, body: Record<string, unknown>): Promise<Reply> =>
    fetch(`${flow.app.baseUrl}/approval-tasks/${taskId}/decision`, {
      method: 'POST',
      headers: { [TENANT_HEADER]: DisFlow.tokenOf(member), 'content-type': 'application/json', 'idempotency-key': `key-${randomUUID()}`, 'if-match': `"${version}"`, [CLAIMS_HEADER]: JSON.stringify({ aal: 'aal2', aal2At: new Date().toISOString() }) },
      body: JSON.stringify(body),
    }).then(async (response) => ({ status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> }));

  it('R14: DIS binds the real final command of report.accept in place of the double', () => {
    expect(REGISTRY.hasRealHandler('report.accept')).toBe(true);
    expect(REGISTRY.hasRealHandler('plan.publish')).toBe(false);
  });

  it('R4: a report handed in before the staged rule is approved is decided as it always was, with no instance', async () => {
    const { reportId } = await flow.submitted();
    expect(await instanceOf(reportId)).toBeUndefined();
    await approveRule(CHAIN);
    const accepted = await flow.approve(reportId, 2);
    expect(accepted).toMatchObject({ status: 200, json: { status: 'ACCEPTED', resource_version: 3 } });
    expect(await instanceOf(reportId)).toBeUndefined();
  });

  it('runs the four steps in order, each with its deadline, and ends in the same acceptance as the single decision', async () => {
    const { reportId } = await flow.submitted();
    const instance = await instanceOf(reportId);
    expect(instance).toMatchObject({ status: 'Running', current_step: 0 });
    const first = await pending(instance?.id as string);
    expect(first.map((task) => [task.step_id, task.assignee_id])).toEqual([['unit-approver', memberId(LEADER)]]);
    // 24 working hours counted in days of 8 hours when no calendar is published: three days after the hand-in
    expect(first[0]?.due_at).toContain('2026-12-18');

    // The report is the reviewer's to review but not at this step: no task, no decision.
    expect(await flow.approve(reportId, 2, REVIEWER)).toMatchObject({ status: 403, json: { code: 'APPROVER_NOT_AUTHORIZED' } });
    // The maker is stopped before the engine is asked, with the code the single decision gives.
    expect(await flow.approve(reportId, 2, MAKER)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });

    expect(await flow.approve(reportId, 2, LEADER)).toMatchObject({ status: 200, json: { status: 'STEP_APPROVED', resource_version: 2 } });
    expect(await flow.state(reportId)).toMatchObject({ status: 'SUBMITTED', is_current: false, accepted_by: null });
    expect((await pending(instance?.id as string)).map((task) => [task.step_id, task.assignee_id])).toEqual([['planning-review', memberId(PLANNER)]]);
    expect(await flow.events(reportId, 'report.accepted.v1')).toHaveLength(0);

    expect(await flow.approve(reportId, 2, PLANNER)).toMatchObject({ status: 200, json: { status: 'STEP_APPROVED' } });
    expect(await flow.approve(reportId, 2, CLOSER)).toMatchObject({ status: 200, json: { status: 'STEP_APPROVED' } });
    expect(await flow.state(reportId)).toMatchObject({ status: 'SUBMITTED' });
    const last = await flow.approve(reportId, 2, PUSHER);
    expect(last).toMatchObject({ status: 200, json: { status: 'ACCEPTED', resource_version: 3, resource_id: reportId } });

    // The domain state, the trail and the events after the last step (R14).
    expect(await flow.state(reportId)).toMatchObject({ status: 'ACCEPTED', is_current: true, accepted_by: memberId(PUSHER), submitted_by: memberId(MAKER) });
    expect(await instanceOf(reportId)).toMatchObject({ status: 'Completed', outcome: 'APPROVED' });
    expect(await pending(instance?.id as string)).toEqual([]);
    const trail = await actions(reportId, instance?.id as string);
    expect(trail.filter((action) => action === 'approval.task_decided')).toHaveLength(4);
    expect(trail).toEqual(expect.arrayContaining(['workflow.instance_started', 'dis.report_submitted', 'dis.report_accepted']));
    expect(await flow.events(reportId, 'report.accepted.v1')).toHaveLength(1);
    expect(await flow.events(instance?.id as string, 'adm.workflow_instance.completed.v1')).toHaveLength(1);
    expect(await flow.events(instance?.id as string, 'adm.workflow_instance.started.v1')).toHaveLength(1);
    const decisions = (await flow.read(reportId)).json.decisions;
    expect(decisions).toEqual([expect.objectContaining({ decision: 'ACCEPTED', decided_by: memberId(PUSHER) })]);
  });

  it('shows the steps of the approval with their status and deadline to whoever reads the report, and nothing to another tenant', async () => {
    const { projectId, planId } = await flow.seedProject();
    const made = await flow.create(flow.draft(projectId, flow.week(), planId));
    const draftView = await flow.call('GET', `/reports/${flow.idOf(made)}/workflow`, { member: READER });
    expect(draftView).toMatchObject({ status: 200, json: { mode: 'STAGED', rule_source: 'RULE', instance: null } });
    expect((draftView.json.steps as Array<{ status: string }>).map((one) => one.status)).toEqual(['WAITING', 'WAITING', 'WAITING', 'WAITING']);

    expect(await flow.submit(flow.idOf(made), 1)).toMatchObject({ status: 200 });
    const reportId = flow.idOf(made);
    await flow.approve(reportId, 2, LEADER);
    const view = await flow.call('GET', `/reports/${reportId}/workflow`, { member: READER });
    expect(view.status).toBe(200);
    const steps = view.json.steps as Array<{ id: string; kind: string; status: string; due_at: string | null; overdue: boolean; tasks: Array<{ assignee: { id: string }; status: string; decision: string | null }> }>;
    expect(view.json.instance).toMatchObject({ status: 'Running', current_step: 1 });
    expect(steps.map((one) => [one.id, one.kind, one.status])).toEqual([
      ['unit-approver', 'UNIT_APPROVER', 'DONE'],
      ['planning-review', 'PLANNING_REVIEW', 'CURRENT'],
      ['period-close', 'PERIOD_CLOSE', 'WAITING'],
      ['push', 'PUSH', 'WAITING'],
    ]);
    expect(steps[0]?.tasks).toEqual([expect.objectContaining({ assignee: expect.objectContaining({ id: memberId(LEADER) }), status: 'Decided', decision: 'approve' })]);
    // 16 working hours counted in days of 8 hours: two days after the leader's approval
    expect(steps[1]?.due_at).toContain('2026-12-17');
    expect(steps[1]?.overdue).toBe(false);
    expect(steps[1]?.tasks[0]?.assignee.id).toBe(memberId(PLANNER));
    expect(steps[2]?.due_at).toBeNull();
    expect((await flow.call('GET', `/reports/${reportId}/workflow`, { member: B_MAKER, tenantId: TENANT_B })).status).toBe(404);
    expect((await flow.call('GET', `/reports/${randomUUID()}/workflow`, { member: READER })).status).toBe(404);
  });

  it('adopts the rule as the version in force once, and a new rule version supersedes it without touching a running instance', async () => {
    const before = await flow.rows<{ id: string; status: string; revision: number }>("select id, status, revision from machvon.workflow_version where business_type = 'report.accept' and kind = 'APPROVAL' order by revision");
    expect(before.filter((row) => row.status === 'Published')).toHaveLength(1);
    const { reportId } = await flow.submitted();
    const running = await instanceOf(reportId);
    await approveRule([CHAIN[0] as Record<string, unknown>, CHAIN[3] as Record<string, unknown>]);
    const next = await flow.submitted();
    const after = await flow.rows<{ id: string; status: string }>("select id, status from machvon.workflow_version where business_type = 'report.accept' and kind = 'APPROVAL' order by revision");
    expect(after.filter((row) => row.status === 'Published')).toHaveLength(1);
    expect(after.length).toBe(before.length + 1);
    const second = await instanceOf(next.reportId);
    const stillFirst = await flow.rows<{ workflow_version_id: string }>('select workflow_version_id from machvon.workflow_instance where id = $1', [running?.id]);
    const secondVersion = await flow.rows<{ workflow_version_id: string }>('select workflow_version_id from machvon.workflow_instance where id = $1', [second?.id]);
    expect(stillFirst[0]?.workflow_version_id).not.toBe(secondVersion[0]?.workflow_version_id);
    expect((await pending(second?.id as string)).map((task) => task.step_id)).toEqual(['unit-approver']);
    // the instance that started under the first version still runs its four steps
    expect((await pending(running?.id as string)).map((task) => task.step_id)).toEqual(['unit-approver']);
    expect(await flow.approve(reportId, 2, LEADER)).toMatchObject({ json: { status: 'STEP_APPROVED' } });
    expect((await pending(running?.id as string)).map((task) => task.step_id)).toEqual(['planning-review']);
    await approveRule(CHAIN);
  });

  it('a return at any step sends the report to its maker exactly as the single decision does and ends the instance', async () => {
    const { reportId } = await flow.submitted();
    const instance = await instanceOf(reportId);
    await flow.approve(reportId, 2, LEADER);
    const returned = await flow.giveBack(reportId, 2, {}, PLANNER);
    expect(returned).toMatchObject({ status: 200, json: { status: 'RETURNED', resource_version: 3 } });
    expect(await flow.state(reportId)).toMatchObject({ status: 'RETURNED', version: '3', is_current: false });
    expect((await flow.events(reportId, 'report.returned.v1'))[0]?.payload).toMatchObject({ decision: 'RETURNED', return_items: ['Fix the CTMTQG cell', 'Explain the fall'] });
    expect(await instanceOf(reportId)).toMatchObject({ status: 'Cancelled', outcome: 'CANCELLED' });
    expect(await pending(instance?.id as string)).toEqual([]);
    // the corrected revision is handed in again and starts an instance of its own
    const made = await flow.correct(reportId, 3, { amendment_reason: 'The Treasury corrected a payment of March.' });
    const second = flow.idOf(made);
    expect(await flow.submit(second, 1)).toMatchObject({ status: 200, json: { status: 'SUBMITTED' } });
    const again = await instanceOf(second);
    expect(again).toMatchObject({ status: 'Running', current_step: 0 });
    expect(again?.id).not.toBe(instance?.id);
  });

  it('a withdrawal ends the instance with the report', async () => {
    const { reportId } = await flow.submitted();
    const instance = await instanceOf(reportId);
    const withdrawn = await flow.call('POST', `/reports/${reportId}/withdrawal`, { member: MAKER, ifMatch: '"2"', body: { reason: 'The report was handed in by mistake, withdrawing it.' } });
    expect(withdrawn).toMatchObject({ status: 200 });
    expect(await instanceOf(reportId)).toMatchObject({ status: 'Cancelled' });
    expect(await pending(instance?.id as string)).toEqual([]);
  });

  it('R14: the last approval in the task inbox of ADM accepts the report through the real final command, with the state, the trail and the events', async () => {
    const { reportId } = await flow.submitted();
    const instance = await instanceOf(reportId);
    let last: Reply | undefined;
    for (const member of [LEADER, PLANNER, CLOSER, PUSHER]) {
      const [task] = (await pending(instance?.id as string)).filter((row) => row.assignee_id === memberId(member));
      expect(task).toBeDefined();
      last = await adm(task?.id as string, task?.version as string, member, { decision: 'approve' });
      expect(last.status).toBe(200);
    }
    expect(last?.json.status).toBe('APPROVED');
    expect(await flow.state(reportId)).toMatchObject({ status: 'ACCEPTED', is_current: true, accepted_by: memberId(PUSHER) });
    expect(await instanceOf(reportId)).toMatchObject({ status: 'Completed', outcome: 'APPROVED' });
    expect(await actions(reportId, instance?.id as string)).toEqual(expect.arrayContaining(['dis.report_accepted', 'approval.task_decided', 'workflow.instance_started']));
    expect(await flow.events(reportId, 'report.accepted.v1')).toHaveLength(1);
    expect(await flow.events(instance?.id as string, 'adm.workflow_instance.completed.v1')).toHaveLength(1);
    expect((await flow.read(reportId)).json.decisions).toEqual([expect.objectContaining({ decision: 'ACCEPTED', decided_by: memberId(PUSHER) })]);
  });

  it('a return in the task inbox of ADM returns the report with the reason as its item, and a rejection is refused by the table of states (GUARD_REJECTED) and leaves the report as it was', async () => {
    const returnedReport = await flow.submitted();
    const first = await instanceOf(returnedReport.reportId);
    const [task] = await pending(first?.id as string);
    const reply = await adm(task?.id as string, task?.version as string, LEADER, { decision: 'return', reason: 'The CTMTQG cell does not agree.' });
    expect(reply).toMatchObject({ status: 200, json: { status: 'RETURNED' } });
    expect(await flow.state(returnedReport.reportId)).toMatchObject({ status: 'RETURNED' });
    expect((await flow.events(returnedReport.reportId, 'report.returned.v1'))[0]?.payload).toMatchObject({ return_items: ['The CTMTQG cell does not agree.'] });

    const rejectedReport = await flow.submitted();
    const second = await instanceOf(rejectedReport.reportId);
    const [other] = await pending(second?.id as string);
    const rejected = await adm(other?.id as string, other?.version as string, LEADER, { decision: 'reject', reason: 'This report cannot be accepted.' });
    expect(rejected).toMatchObject({ status: 200, json: { status: 'GUARD_REJECTED' } });
    expect(await flow.state(rejectedReport.reportId)).toMatchObject({ status: 'SUBMITTED', version: '2' });
    expect(await instanceOf(rejectedReport.reportId)).toMatchObject({ status: 'Completed', outcome: 'GUARD_REJECTED' });
    expect(await flow.events(second?.id as string, 'adm.workflow_guard_rejected.v1')).toHaveLength(1);
    // the report is not stuck: with no running instance the reviewer decides it by the single decision
    expect(await flow.approve(rejectedReport.reportId, 2)).toMatchObject({ status: 200, json: { status: 'ACCEPTED' } });
  });

  it('UAT-AC133 an approval that reaches the final command after the maker withdrew the report: the owning module refuses (409), the instance is Completed GUARD_REJECTED, the report stays WITHDRAWN, the operators get one alert, and a retry with the same key changes nothing', async () => {
    await approveRule([step('unit-approver', 'UNIT_APPROVER')]);
    try {
      const { reportId } = await flow.submitted();
      const instance = await instanceOf(reportId);
      const [task] = await pending(instance?.id as string);
      // The withdrawal of the maker lands between the read of the approver and the final command of the engine. The command of the withdrawal cancels the instance in its own transaction, so only that race leaves a
      // Running instance behind a WITHDRAWN report: the test makes the same update the command makes (the table keeps the graph SUBMITTED to WITHDRAWN) and leaves the instance running.
      await flow.rows(
        "update machvon.report_revision set status = 'WITHDRAWN', withdrawn_by = $2::uuid, withdrawn_at = now(), withdrawn_reason = 'The maker took the report back', version = version + 1 where id = $1 and status = 'SUBMITTED'",
        [reportId, memberId(MAKER)],
      );
      const withdrawn = await flow.state(reportId);
      expect(withdrawn).toMatchObject({ status: 'WITHDRAWN', version: '3' });
      // What the final command asks of the domain: the single decision of the report answers 409 for a withdrawn report (the table of states is the guard, BR-ADM-07).
      expect(await flow.approve(reportId, 3)).toMatchObject({ status: 409, json: { code: 'REPORT_STATE_INVALID', report_status: 'WITHDRAWN' } });
      // The last approver approves the task: the engine calls the final command (key wf:<instance>:final:1) and the domain refuses.
      const key = `key-ac133-${randomUUID()}`;
      const send = (): Promise<Reply> =>
        fetch(`${flow.app.baseUrl}/approval-tasks/${task?.id}/decision`, {
          method: 'POST',
          headers: { [TENANT_HEADER]: DisFlow.tokenOf(LEADER), 'content-type': 'application/json', 'idempotency-key': key, 'if-match': `"${task?.version}"`, [CLAIMS_HEADER]: JSON.stringify({ aal: 'aal2', aal2At: new Date().toISOString() }) },
          body: JSON.stringify({ decision: 'approve' }),
        }).then(async (response) => ({ status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> }));
      const first = await send();
      expect(first).toMatchObject({ status: 200, json: { status: 'GUARD_REJECTED' } });
      expect(await instanceOf(reportId)).toMatchObject({ status: 'Completed', outcome: 'GUARD_REJECTED' });
      expect(await flow.state(reportId)).toEqual(withdrawn);
      expect(await flow.events(reportId, 'report.accepted.v1')).toHaveLength(0);
      expect(await flow.events(instance?.id as string, 'adm.workflow_guard_rejected.v1')).toHaveLength(1);
      // The same key again: the first answer is replayed, and nothing is raised a second time.
      const again = await send();
      expect(again.status).toBe(first.status);
      expect(again.json).toEqual(first.json);
      expect(await instanceOf(reportId)).toMatchObject({ status: 'Completed', outcome: 'GUARD_REJECTED' });
      expect(await flow.events(instance?.id as string, 'adm.workflow_guard_rejected.v1')).toHaveLength(1);
      // The negative control: a check that wants the report accepted must fail on this record.
      expect(() => expect(withdrawn).toMatchObject({ status: 'ACCEPTED' })).toThrow();
    } finally {
      await approveRule(CHAIN);
    }
  });

  it('reminds the approver at 80 percent of the time to the deadline and again when it is passed, through the engine clock', async () => {
    const { reportId } = await flow.submitted();
    const instance = await instanceOf(reportId);
    const [task] = await pending(instance?.id as string);
    const sweep = async (at: Date) =>
      flow.harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(LEADER), scopeVersion: 1 }, (tx) =>
        store.sweepSla(tx, { actor: memberId(LEADER), audit: () => Promise.resolve(), emit: (event) => enqueueOutbox(tx, { ...event, correlationId: randomUUID() }) }, at),
      );
    // The pass judges every open task of the tenant (the other tests left theirs open): this test reads the reminders of its own task.
    const remindersOfTask = () => flow.rows<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where type = 'adm.approval_task.reminded.v1' and payload->>'task_id' = $1 order by created_at", [task?.id]);
    await sweep(new Date('2026-12-15T01:00:00Z'));
    expect(await remindersOfTask()).toEqual([]);
    await sweep(new Date('2026-12-17T12:00:00Z'));
    expect((await remindersOfTask()).map((row) => [row.payload.kind, row.payload.assignee_id, row.payload.step_id])).toEqual([['BEFORE_DUE', memberId(LEADER), 'unit-approver']]);
    const late = await sweep(new Date('2026-12-19T00:00:00Z'));
    expect(late.overdueReminded).toBeGreaterThanOrEqual(1);
    expect((await remindersOfTask()).map((row) => row.payload.kind)).toEqual(['BEFORE_DUE', 'OVERDUE']);
    // a pass repeated at the same moment changes nothing
    await sweep(new Date('2026-12-19T00:00:00Z'));
    expect((await remindersOfTask()).map((row) => row.payload.kind)).toEqual(['BEFORE_DUE', 'OVERDUE']);
  });

  it('refuses a hand-in whose first step has no one who can approve (422 NO_ELIGIBLE_APPROVER) and leaves the report a draft', async () => {
    await approveRule([step('unit-approver', 'UNIT_APPROVER', { assignee_type: 'SPECIFIC', membership_ids: [memberId(MAKER)] })]);
    const { projectId, planId } = await flow.seedProject();
    const made = await flow.create(flow.draft(projectId, flow.week(), planId));
    const sent = await flow.submit(flow.idOf(made), 1);
    expect(sent).toMatchObject({ status: 422, json: { code: 'NO_ELIGIBLE_APPROVER' } });
    expect(await flow.state(flow.idOf(made))).toMatchObject({ status: 'DRAFT', version: '1' });
    expect(await instanceOf(flow.idOf(made))).toBeUndefined();
    await approveRule(CHAIN);
  });
});
