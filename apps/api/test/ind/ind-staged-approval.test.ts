import { randomUUID } from 'node:crypto';
import { ApprovalCommandsController, ApprovalTaskReadsController, WorkflowInstanceReadsController } from '../../src/modules/adm/approval.controller';
import { APPROVAL_PUSH_SOURCES, ApprovalPushSources } from '../../src/modules/adm/approval-hold.service';
import { APPROVAL_FINAL_COMMANDS, FinalCommandRegistry } from '../../src/modules/adm/approval.service';
import { IndEntryController } from '../../src/modules/ind/entry.controller';
import { IndEntryApprovalBinding } from '../../src/modules/ind/entry-approval.binding';
import { CLAIMS_HEADER, TENANT_HEADER } from '../isolation/test-auth.guard';
import { DisFlow, ROOT, TENANT_A, id, memberId, unitId } from '../dis/support/dis-flow-app';
import type { Reply } from '../dis/support/dis-flow-app';

jest.setTimeout(300_000);

const ENTERER = 10; // enters indicator figures and hands them in as a batch
const LEADER = 11; // approves as the unit approver
const PUSHER = 12; // names the last step
const WRITER = 13; // proposes the rule
const CHECKER = 14; // approves the rule
const DECIDING = ['approval.decide', 'approval_task.read', 'workflow_instance.read', 'ind.read'] as const;
const REGISTRY = new FinalCommandRegistry();
const SOURCES = new ApprovalPushSources();

const step = (stepId: string, kind: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id: stepId, kind, name: `Step ${stepId}`, assignee_type: 'DOA', min_approvals: 1, sla_working_hours: 24, on_timeout: 'REMIND', ...extra });
const CHAIN = [step('unit-approver', 'UNIT_APPROVER'), step('push', 'PUSH', { assignee_type: 'SPECIFIC', membership_ids: [memberId(PUSHER)], sla_working_hours: 8 })];

/** ENT-3c: a batch of indicator entries goes through the staged approval; the figures reach the register only when the last step approves, and a return carries the warnings (BBH 43). */
describe('the staged approval of a batch of indicator entries (ENT-3c)', () => {
  const flow = new DisFlow();

  beforeAll(async () => {
    await flow.start({
      tmpPrefix: 'machvon-ind-staged-',
      extraRoles: [
        { n: 10, code: 'IND_ENTERER', permissions: ['ind.read', 'ind.entry'], rank: 20 },
        { n: 11, code: 'IND_LEADER', permissions: DECIDING, rank: 60 },
        { n: 12, code: 'IND_PUSHER', permissions: DECIDING, rank: 25 },
        { n: 13, code: 'RULE_WRITER', permissions: ['ind.read'], rank: 10 },
      ],
      extraMembers: [
        { n: ENTERER, roleNumber: 10 },
        { n: LEADER, roleNumber: 11 },
        { n: PUSHER, roleNumber: 12 },
        { n: WRITER, roleNumber: 13 },
        { n: CHECKER, roleNumber: 13 },
      ],
      controllers: [IndEntryController, ApprovalCommandsController, WorkflowInstanceReadsController, ApprovalTaskReadsController],
      providers: [{ provide: APPROVAL_FINAL_COMMANDS, useValue: REGISTRY }, { provide: APPROVAL_PUSH_SOURCES, useValue: SOURCES }, IndEntryApprovalBinding],
      afterSeed: async (fixture) => {
        const matrix = randomUUID();
        await fixture.harness.owner(TENANT_A, [
          [`insert into machvon.doa_matrix_version (tenant_id, id, revision, status, effective_from, legal_basis_ref, created_by, last_edited_by, version) values ($1, $2, 902, 'Draft', date '2020-01-01', 'Fixture regulation on approvals', $3, $3, 1)`, [TENANT_A, matrix, memberId(WRITER)]],
          [
            `insert into machvon.doa_rule (tenant_id, id, matrix_version_id, document_type, unit_id, include_subtree, amount_min_vnd, amount_max_vnd, approver_role_id, approval_levels, position)
             values ($1, $2, $3, 'IND_ENTRY_ACCEPT', $4, true, 0, null, $5, 1, 0)`,
            [TENANT_A, randomUUID(), matrix, unitId(ROOT), id(0x30, 11)],
          ],
          ["update machvon.doa_matrix_version set status = 'PendingApproval' where id = $1", [matrix]],
          ["update machvon.doa_matrix_version set status = 'Published', approved_by = $2, published_at = now() where id = $1", [matrix, memberId(CHECKER)]],
        ]);
      },
    });
  });

  afterAll(async () => {
    await flow.stop();
  });

  const approveRule = (steps: unknown[]): Promise<unknown[]> =>
    flow.rows(
      `insert into machvon.governance_rule (tenant_id, id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at, row_version)
       select $1, $2, 'APPROVAL_WORKFLOW_DEFINITION', 'IND_ENTRY_ACCEPT', coalesce(max(version), 0) + 1, 'APPROVED', $3::jsonb, date '2026-01-01', 'Steps of the entry', $4, $4, now(), $5, now(), 1
         from machvon.governance_rule where rule_type = 'APPROVAL_WORKFLOW_DEFINITION' and code = 'IND_ENTRY_ACCEPT'`,
      [TENANT_A, randomUUID(), JSON.stringify({ mode: 'STAGED', steps }), memberId(WRITER), memberId(CHECKER)],
    );
  const periodIds = async (): Promise<string[]> => (await flow.rows<{ id: string }>("select id from machvon.reporting_period where fiscal_year = 2027 and period_type = 'WEEK' and calendar_code = 'DEFAULT' order by start_date limit 3")).map((row) => row.id);
  const enter = (projectId: string, periodId: string, value: string): Promise<Reply> => flow.call('POST', '/indicator-figures', { member: ENTERER, body: { project_id: projectId, period_id: periodId, figures: [{ indicator_code: 'PLAN_YEAR', value }] } });
  const pendingTask = async (member: number): Promise<{ id: string; version: string }> => (await flow.rows<{ id: string; version: string }>("select id, version::text from machvon.approval_task where status = 'Pending' and assignee_id = $1", [memberId(member)]))[0] as { id: string; version: string };
  const decideTask = (task: { id: string; version: string }, member: number, body: Record<string, unknown>): Promise<Reply> =>
    fetch(`${flow.app.baseUrl}/approval-tasks/${task.id}/decision`, {
      method: 'POST',
      headers: { [TENANT_HEADER]: DisFlow.tokenOf(member), 'content-type': 'application/json', 'idempotency-key': `key-${randomUUID()}`, 'if-match': `"${task.version}"`, [CLAIMS_HEADER]: JSON.stringify({ aal: 'aal2', aal2At: new Date().toISOString() }) },
      body: JSON.stringify(body),
    }).then(async (response) => ({ status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> }));
  const figures = (projectId: string, periodId: string) => flow.rows<{ value: string; entered_by: string }>('select value::text, entered_by from machvon.ind_figure where project_id = $1 and period_id = $2', [projectId, periodId]);
  const batchOf = (projectId: string, periodId: string) => flow.rows<{ id: string; status: string; entered_by: string; decision_reason: string | null }>('select id, status, entered_by, decision_reason from machvon.ind_entry_batch where project_id = $1 and period_id = $2 order by revision desc', [projectId, periodId]);

  it('R14: IND binds the real final command of ind.entry.accept', () => {
    expect(REGISTRY.hasRealHandler('ind.entry.accept')).toBe(true);
  });

  it('keeps the direct entry as it was while no staged rule is approved', async () => {
    const { projectId } = await flow.seedProject();
    const [period] = await periodIds();
    const direct = await enter(projectId, period as string, '1000');
    expect(direct).toMatchObject({ status: 200, json: { status: 'ENTERED', created: 1 } });
    expect(await batchOf(projectId, period as string)).toEqual([]);
  });

  it('hands the entry in as a batch, writes the figures only when the last step approves, in the name of the person who entered them', async () => {
    await approveRule(CHAIN);
    const { projectId } = await flow.seedProject();
    const [, period] = await periodIds();
    const handed = await enter(projectId, period as string, '2500');
    expect(handed).toMatchObject({ status: 200, json: { status: 'SUBMITTED', created: 0, figures: [] } });
    expect(await figures(projectId, period as string)).toEqual([]);
    expect((await batchOf(projectId, period as string))[0]).toMatchObject({ status: 'SUBMITTED', entered_by: memberId(ENTERER) });
    // One batch waits at a time.
    expect(await enter(projectId, period as string, '2600')).toMatchObject({ status: 409, json: { code: 'IND_ENTRY_BATCH_STATE_INVALID' } });
    expect(await decideTask(await pendingTask(LEADER), LEADER, { decision: 'approve' })).toMatchObject({ status: 200 });
    expect(await figures(projectId, period as string)).toEqual([]);
    expect(await decideTask(await pendingTask(PUSHER), PUSHER, { decision: 'approve' })).toMatchObject({ status: 200 });
    expect(await figures(projectId, period as string)).toEqual([{ value: '2500.000000', entered_by: memberId(ENTERER) }]);
    expect((await batchOf(projectId, period as string))[0]).toMatchObject({ status: 'ACCEPTED' });
  });

  it('returns the batch with its reason and its warnings to the person who entered it and the approver, and writes nothing', async () => {
    const { projectId } = await flow.seedProject();
    const [, , period] = await periodIds();
    expect((await enter(projectId, period as string, '3100')).status).toBe(200);
    const returned = await decideTask(await pendingTask(LEADER), LEADER, { decision: 'return', reason: 'The plan figure is not the approved one' });
    expect(returned.status).toBe(200);
    expect(await figures(projectId, period as string)).toEqual([]);
    const [batch] = await batchOf(projectId, period as string);
    expect(batch).toMatchObject({ status: 'RETURNED', decision_reason: 'The plan figure is not the approved one' });
    const [event] = await flow.rows<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where aggregate_id = $1 and type = 'ind.entry_batch.returned.v1'", [batch?.id]);
    expect(event?.payload).toMatchObject({ entered_by: memberId(ENTERER), decided_by: memberId(LEADER), warnings: expect.any(Array) });
    // The person who entered the batch is not asked to decide it.
    expect(await flow.rows('select 1 from machvon.approval_task where assignee_id = $1', [memberId(ENTERER)])).toEqual([]);
    // A new batch can be handed in after the return.
    expect((await enter(projectId, period as string, '3200')).status).toBe(200);
  });
});
