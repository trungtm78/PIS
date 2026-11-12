import { randomUUID } from 'node:crypto';
import type { TenantDatabase, TenantTx } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import { HpmFileWriter, ReportStoreIssuedReports, registerEnterpriseIntegrationRules } from '@machvon/edition-enterprise/src/server.ts';
import type { HpmFileSink, PeriodReopenPort } from '@machvon/edition-enterprise/src/server.ts';
import { HpmApprovalPush } from '../../src/editions/enterprise/approval-push';
import { HpmPushController } from '../../src/editions/enterprise/hpm.controller';
import { HPM_ISSUED_REPORTS, HPM_PERIOD_REOPEN, HPM_PORT } from '../../src/editions/enterprise/tokens';
import { ApprovalCommandsController, ApprovalTaskReadsController, WorkflowInstanceReadsController } from '../../src/modules/adm/approval.controller';
import { APPROVAL_PUSH_PORT, APPROVAL_PUSH_SOURCES, ApprovalHoldService, ApprovalPushSources } from '../../src/modules/adm/approval-hold.service';
import { APPROVAL_FINAL_COMMANDS, FinalCommandRegistry } from '../../src/modules/adm/approval.service';
import { ReportWorkflowReadsController } from '../../src/modules/dis/report-workflow.controller';
import { DisReportApprovalBinding } from '../../src/modules/dis/report-approval.binding';
import { FundingFigureController } from '../../src/modules/fnd/figure.controller';
import { FndFigureApprovalBinding } from '../../src/modules/fnd/figure-approval.binding';
import { FUNDING_PACK_CODE } from '../../src/modules/fnd/tokens';
import { IndEntryController } from '../../src/modules/ind/entry.controller';
import { IndEntryApprovalBinding } from '../../src/modules/ind/entry-approval.binding';
import { CLAIMS_HEADER, TENANT_HEADER } from '../isolation/test-auth.guard';
import { DisFlow, READER, ROOT, TENANT_A, id, memberId, unitId } from './support/dis-flow-app';
import type { Reply } from './support/dis-flow-app';

/**
 * ENT-3c, QT.01 and TH.01 on the workflow side, end to end with the real receiver of the enterprise edition (`HpmApprovalPush` over the HPM push log) instead of a double: the PUSH step of the staged approval hands the package
 * over under the key organisation | layout | period | revision (R8), waits as AWAITING_RECEIPT (R22) until somebody other than the pusher records the receipt of HPM, and then the final command of the owner runs once. The same chain
 * serves the weekly report, a batch of funding figures and a batch of indicator entries. A revision older than the newest one is refused (R17). The name ends in `.enterprise.test.ts`: it is one of the few sources that may name the
 * enterprise package; the file writer of HPM stands for the receiver behind its documented port and no call leaves the process.
 */
jest.setTimeout(300_000);

const LEADER = 10; // approves as the unit approver
const PLANNER = 11; // the planning review
const CLOSER = 12; // closes the period
const PUSHER = 13; // names the push
const WRITER = 14; // proposes the rules
const CHECKER = 15; // approves the rules
const RECEIVER = 16; // records the receipt of HPM
const PREPARER = 17; // prepares figures and indicator entries
const DECIDING = ['report.review', 'report.read', 'report_revision.read', 'approval.decide', 'approval_task.read', 'workflow_instance.read', 'funding.read', 'funding.figure.accept', 'ind.read'] as const;
const REGISTRY = new FinalCommandRegistry();
const SOURCES = new ApprovalPushSources();

/** The sink of the file writer: what HPM "received", and a switch that makes the next writes fail (a disk that is full). */
const written: Array<{ tenantId: string; name: string }> = [];
let failNext = 0;
const sink: HpmFileSink = (tenantId, name) => {
  if (failNext > 0) {
    failNext -= 1;
    return Promise.reject(new Error('the disk is full'));
  }
  written.push({ tenantId, name });
  return Promise.resolve(`${tenantId}/${name}`);
};
const reopen: PeriodReopenPort = { status: () => Promise.resolve('MISSING') };
const WRITER_PORT = new HpmFileWriter(sink);
const PUSH_PORT = new HpmApprovalPush(WRITER_PORT, reopen);

const step = (stepId: string, kind: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id: stepId, kind, name: `Step ${stepId}`, assignee_type: 'DOA', min_approvals: 1, sla_working_hours: 24, on_timeout: 'REMIND', ...extra });
const REPORT_CHAIN = [
  step('unit-approver', 'UNIT_APPROVER'),
  step('planning-review', 'PLANNING_REVIEW', { assignee_type: 'ROLE_IN_UNIT', role_code: 'PLANNING_REVIEWER', unit_id: unitId(ROOT), sla_working_hours: 16, on_timeout: 'ESCALATE', escalate_to: memberId(LEADER) }),
  step('period-close', 'PERIOD_CLOSE', { assignee_type: 'SPECIFIC', membership_ids: [memberId(CLOSER)], sla_working_hours: 8 }),
  step('push', 'PUSH', { assignee_type: 'SPECIFIC', membership_ids: [memberId(PUSHER)], sla_working_hours: 8 }),
];
const SHORT_CHAIN = [step('unit-approver', 'UNIT_APPROVER'), step('push', 'PUSH', { assignee_type: 'SPECIFIC', membership_ids: [memberId(PUSHER)], sla_working_hours: 8 })];

describe('the PUSH step of the staged approval with the real HPM receiver (ENT-3c, R22, R8, R17)', () => {
  const flow = new DisFlow();

  beforeAll(async () => {
    // The process of the enterprise edition registers its rules when it loads (load-enterprise.ts).
    registerEnterpriseIntegrationRules();
    await flow.start({
      tmpPrefix: 'machvon-approval-hpm-',
      extraRoles: [
        { n: 10, code: 'DIS_LEADER', permissions: DECIDING, rank: 60 },
        { n: 11, code: 'PLANNING_REVIEWER', permissions: DECIDING, rank: 30 },
        { n: 12, code: 'DIS_CLOSER', permissions: DECIDING, rank: 25 },
        { n: 13, code: 'RULE_WRITER', permissions: ['report.read'], rank: 10 },
        { n: 14, code: 'HPM_RECEIVER', permissions: ['hpm.read', 'hpm.receipt'], rank: 30 },
        { n: 15, code: 'FIGURE_PREPARER', permissions: ['funding.read', 'funding.figure.prepare', 'ind.read', 'ind.entry'], rank: 30 },
      ],
      extraMembers: [
        { n: LEADER, roleNumber: 10 },
        { n: PLANNER, roleNumber: 11 },
        { n: CLOSER, roleNumber: 12 },
        { n: PUSHER, roleNumber: 12 },
        { n: WRITER, roleNumber: 13 },
        { n: CHECKER, roleNumber: 13 },
        { n: RECEIVER, roleNumber: 14 },
        { n: PREPARER, roleNumber: 15 },
      ],
      controllers: [ApprovalCommandsController, WorkflowInstanceReadsController, ApprovalTaskReadsController, ReportWorkflowReadsController, HpmPushController, FundingFigureController, IndEntryController],
      providers: [
        { provide: APPROVAL_FINAL_COMMANDS, useValue: REGISTRY },
        { provide: APPROVAL_PUSH_SOURCES, useValue: SOURCES },
        { provide: APPROVAL_PUSH_PORT, useValue: PUSH_PORT },
        { provide: HPM_PORT, useValue: WRITER_PORT },
        { provide: HPM_PERIOD_REOPEN, useValue: reopen },
        { provide: HPM_ISSUED_REPORTS, useValue: new ReportStoreIssuedReports() },
        { provide: FUNDING_PACK_CODE, useValue: 'ENTERPRISE' },
        ApprovalHoldService,
        DisReportApprovalBinding,
        FndFigureApprovalBinding,
        IndEntryApprovalBinding,
      ],
      afterSeed: async (fixture) => {
        const matrix = randomUUID();
        const rule = (documentType: string, position: number): [string, unknown[]] => [
          `insert into machvon.doa_rule (tenant_id, id, matrix_version_id, document_type, unit_id, include_subtree, amount_min_vnd, amount_max_vnd, approver_role_id, approval_levels, position)
           values ($1, $2, $3, $4, $5, true, 0, null, $6, 1, $7)`,
          [TENANT_A, randomUUID(), matrix, documentType, unitId(ROOT), id(0x30, 10), position],
        ];
        await fixture.harness.owner(TENANT_A, [
          [`insert into machvon.doa_matrix_version (tenant_id, id, revision, status, effective_from, legal_basis_ref, created_by, last_edited_by, version) values ($1, $2, 903, 'Draft', date '2020-01-01', 'Fixture regulation on approvals', $3, $3, 1)`, [TENANT_A, matrix, memberId(WRITER)]],
          rule('REPORT_ACCEPT', 0),
          rule('FND_FIGURE_ACCEPT', 1),
          rule('IND_ENTRY_ACCEPT', 2),
          ["update machvon.doa_matrix_version set status = 'PendingApproval' where id = $1", [matrix]],
          ["update machvon.doa_matrix_version set status = 'Published', approved_by = $2, published_at = now() where id = $1", [matrix, memberId(CHECKER)]],
        ]);
      },
    });
    flow.clockNow = new Date('2026-12-15T00:00:00Z');
    await approveRule('REPORT_ACCEPT', REPORT_CHAIN);
    await approveRule('FND_FIGURE_ACCEPT', SHORT_CHAIN);
    await approveRule('IND_ENTRY_ACCEPT', SHORT_CHAIN);
  });

  afterAll(async () => {
    await flow.stop();
  });

  const approveRule = (code: string, steps: unknown[]): Promise<unknown[]> =>
    flow.rows(
      `insert into machvon.governance_rule (tenant_id, id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at, row_version)
       select $1, $2, 'APPROVAL_WORKFLOW_DEFINITION', $3, coalesce(max(version), 0) + 1, 'APPROVED', $4::jsonb, date '2026-01-01', 'Steps of the review', $5, $5, now(), $6, now(), 1
         from machvon.governance_rule where rule_type = 'APPROVAL_WORKFLOW_DEFINITION' and code = $3`,
      [TENANT_A, randomUUID(), code, JSON.stringify({ mode: 'STAGED', steps }), memberId(WRITER), memberId(CHECKER)],
    );
  const pushes = (layoutLike: string) => flow.rows<{ id: string; key: string; status: string; version: string; attempts: number; revision: number; layout_code: string; period: string }>('select id, idempotency_key as key, status, version::text as version, attempts, revision, layout_code, period from machvon.hpm_push where layout_code like $1 order by created_at', [layoutLike]);
  const holdOf = (resourceId: string) =>
    flow.rows<{ state: string; push_status: string | null; push_id: string | null; attempts: number; held_by: string }>(
      'select h.state, h.push_status, h.push_id, h.attempts, h.held_by from machvon.approval_step_hold h join machvon.workflow_instance i on i.id = h.workflow_instance_id where i.resource_id = $1 order by h.created_at desc',
      [resourceId],
    );
  const instanceOf = async (resourceId: string): Promise<{ status: string; outcome: string | null }> => (await flow.rows<{ status: string; outcome: string | null }>('select status, outcome from machvon.workflow_instance where resource_id = $1', [resourceId]))[0] as { status: string; outcome: string | null };
  const receipt = (member: number, pushId: string, version: string, body: Record<string, unknown> = { outcome: 'ACCEPTED', reference: 'HPM-REF-1' }): Promise<Reply> => flow.call('POST', `/hpm/pushes/${pushId}/receipt`, { member, ifMatch: `"${version}"`, body });
  const inTenant = <T>(member: number, run: (tx: TenantTx) => Promise<T>): Promise<T> => (flow.harness.tenants as TenantDatabase).withTenant({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 0 }, run);

  describe('the weekly report (REPORT, layout DIS_WEEKLY)', () => {
    const atPush = async (): Promise<string> => {
      const { reportId } = await flow.submitted();
      for (const member of [LEADER, PLANNER, CLOSER]) expect(await flow.approve(reportId, 2, member)).toMatchObject({ status: 200, json: { status: 'STEP_APPROVED' } });
      return reportId;
    };

    it('R22, R8: the PUSH step writes one push under the key organisation | layout | period | revision, waits as AWAITING_RECEIPT and does not accept the report', async () => {
      const before = written.length;
      const reportId = await atPush();
      const handed = await flow.approve(reportId, 2, PUSHER);
      expect(handed).toMatchObject({ status: 200, json: { status: 'AWAITING_RECEIPT' } });
      const [push] = await pushes('DIS_WEEKLY-%');
      expect(push).toMatchObject({ status: 'WRITTEN', attempts: 1, revision: 1 });
      expect(push?.key).toBe(`${TENANT_A}|${push?.layout_code}|${push?.period}|r1`);
      expect(written).toHaveLength(before + 1);
      expect(await holdOf(reportId)).toEqual([{ state: 'AWAITING_RECEIPT', push_status: 'WRITTEN', push_id: push?.id, attempts: 1, held_by: memberId(PUSHER) }]);
      expect(await flow.state(reportId)).toMatchObject({ status: 'SUBMITTED', accepted_by: null });
      expect(await instanceOf(reportId)).toEqual({ status: 'Running', outcome: null });
      // Approving again while the package waits is the same key: no second push and no second file.
      expect(await flow.approve(reportId, 2, PUSHER)).toMatchObject({ status: 200, json: { status: 'AWAITING_RECEIPT' } });
      expect(await pushes('DIS_WEEKLY-%')).toHaveLength(1);
      expect(written).toHaveLength(before + 1);
      const view = await flow.call('GET', `/reports/${reportId}/workflow`, { member: READER });
      const steps = view.json.steps as Array<{ id: string; status: string; receipt: { state: string; push_id: string } | null }>;
      expect(steps.find((one) => one.id === 'push')).toMatchObject({ status: 'AWAITING_RECEIPT', receipt: { state: 'AWAITING_RECEIPT', push_id: push?.id } });
    });

    it('the pusher cannot record the receipt of their own push (403); the receipt of somebody else accepts the report once and the step becomes PUSHED', async () => {
      const reportId = await atPush();
      await flow.approve(reportId, 2, PUSHER);
      const push = (await pushes('DIS_WEEKLY-%')).at(-1) as { id: string; version: string };
      expect((await receipt(PUSHER, push.id, push.version)).status).toBe(403);
      expect(await flow.state(reportId)).toMatchObject({ status: 'SUBMITTED' });
      const done = await receipt(RECEIVER, push.id, push.version);
      expect(done).toMatchObject({ status: 200, json: { status: 'ACCEPTED' } });
      expect(await flow.state(reportId)).toMatchObject({ status: 'ACCEPTED', is_current: true, accepted_by: memberId(PUSHER) });
      expect((await holdOf(reportId))[0]).toMatchObject({ state: 'PUSHED' });
      expect(await instanceOf(reportId)).toEqual({ status: 'Completed', outcome: 'APPROVED' });
      expect(await flow.rows("select 1 from machvon.audit_event where resource_id = $1 and action = 'hpm.receipt_accepted'", [push.id])).toHaveLength(1);
    });

    it('a rejection of the receiver ends the hold and leaves the report with the approvers; the usual return still sends it back', async () => {
      const reportId = await atPush();
      await flow.approve(reportId, 2, PUSHER);
      const push = (await pushes('DIS_WEEKLY-%')).at(-1) as { id: string; version: string };
      expect(await receipt(RECEIVER, push.id, push.version, { outcome: 'REJECTED', reference: 'HPM-REF-2', note: 'The layout does not match' })).toMatchObject({ status: 200, json: { status: 'REJECTED' } });
      expect((await holdOf(reportId))[0]).toMatchObject({ state: 'REJECTED' });
      expect(await flow.state(reportId)).toMatchObject({ status: 'SUBMITTED' });
      expect(await flow.giveBack(reportId, 2, {}, PUSHER)).toMatchObject({ status: 200, json: { status: 'RETURNED' } });
    });

    it('a failed delivery is a state a person can retry under the same key: PUSH_FAILED, then AWAITING_RECEIPT with the attempt counted on the one push', async () => {
      const reportId = await atPush();
      failNext = 1;
      expect(await flow.approve(reportId, 2, PUSHER)).toMatchObject({ status: 200, json: { status: 'PUSH_FAILED' } });
      expect((await holdOf(reportId))[0]).toMatchObject({ state: 'PUSH_FAILED', push_status: 'FAILED', attempts: 1 });
      expect(await flow.approve(reportId, 2, PUSHER)).toMatchObject({ status: 200, json: { status: 'AWAITING_RECEIPT' } });
      const [push] = (await pushes('DIS_WEEKLY-%')).slice(-1);
      expect(push).toMatchObject({ status: 'WRITTEN', attempts: 2 });
      expect((await pushes(push?.layout_code as string)).length).toBe(1);
    });

    it('R17: a revision older than the newest is refused with 409 REPORT_OUT_OF_DATE, writes no push and no file', async () => {
      const before = written.length;
      const layout = 'DIS_WEEKLY-STALE';
      const count = (await pushes(`${layout}%`)).length;
      const refused = await inTenant(PUSHER, (tx) =>
        PUSH_PORT.push(tx, {
          tenantId: TENANT_A,
          actor: memberId(PUSHER),
          now: new Date('2026-12-15T00:00:00Z'),
          effects: { actor: memberId(PUSHER), audit: () => Promise.resolve(undefined), emit: () => Promise.resolve(undefined) },
          owner: 'REPORT',
          layoutCode: layout,
          period: '2027-01-10',
          revision: 1,
          headRevision: 2,
          facts: { project_code: 'STALE' },
        }).then(
          () => undefined,
          (error: unknown) => error,
        ),
      );
      expect(refused).toBeInstanceOf(DomainError);
      expect(refused).toMatchObject({ status: 409, code: 'REPORT_OUT_OF_DATE' });
      expect(await pushes(`${layout}%`)).toHaveLength(count);
      expect(written).toHaveLength(before);
    });
  });

  describe('a batch of funding figures (FND_FIGURE, layout FND_FIGURES)', () => {
    const estimate = (projectId: string, month: number): Record<string, unknown> => ({ project_id: projectId, class_code: 'EQUITY', tier_code: 'ALL', measure: 'DISBURSED', figure_kind: 'ESTIMATE', period_grain: 'MONTH', plan_year: 2026, as_of_date: '2026-03-10', entries: [{ period_ordinal: month, amount_vnd: '5000' }] });
    const handedIn = async (): Promise<{ batchId: string; version: number }> => {
      const { projectId } = await flow.seedProject();
      const drafted = await flow.call('POST', '/funding-figures/batches', { member: PREPARER, body: estimate(projectId, 3) });
      expect(drafted.status).toBe(200);
      const batchId = drafted.json.resource_id as string;
      const submitted = await flow.call('POST', `/funding-figures/batches/${batchId}/submission`, { member: PREPARER, ifMatch: `"${drafted.json.resource_version as number}"` });
      expect(submitted.json).toMatchObject({ status: 'SUBMITTED' });
      return { batchId, version: submitted.json.resource_version as number };
    };
    const accept = (batchId: string, version: number, member: number): Promise<Reply> => flow.call('POST', `/funding-figures/batches/${batchId}/acceptance`, { member, ifMatch: `"${version}"` });
    const status = async (batchId: string): Promise<{ status: string; approved_by: string | null }> => (await flow.rows<{ status: string; approved_by: string | null }>('select status, approved_by from machvon.plan_figure_revision where batch_id = $1::uuid limit 1', [batchId]))[0] as { status: string; approved_by: string | null };

    it('the unit approver moves it to the PUSH step; the pusher hands the package over and the batch waits; the receipt of HPM accepts it, by the pusher, once', async () => {
      const { batchId, version } = await handedIn();
      expect(await accept(batchId, version, LEADER)).toMatchObject({ status: 200, json: { status: 'STEP_APPROVED' } });
      expect(await status(batchId)).toMatchObject({ status: 'SUBMITTED' });
      const handed = await accept(batchId, version, PUSHER);
      expect({ status: handed.status, body: handed.json }).toMatchObject({ status: 200, body: { status: 'AWAITING_RECEIPT' } });
      const [push] = await pushes('FND_FIGURES-%');
      expect(push).toMatchObject({ status: 'WRITTEN', attempts: 1 });
      expect(push?.key).toBe(`${TENANT_A}|${push?.layout_code}|${push?.period}|r1`);
      expect(push?.period).toBe('2026-M03');
      expect(await status(batchId)).toMatchObject({ status: 'SUBMITTED' });
      expect((await holdOf(batchId))[0]).toMatchObject({ state: 'AWAITING_RECEIPT', push_id: push?.id });
      expect((await receipt(PUSHER, push?.id as string, push?.version as string)).status).toBe(403);
      expect(await receipt(RECEIVER, push?.id as string, push?.version as string)).toMatchObject({ status: 200, json: { status: 'ACCEPTED' } });
      expect(await status(batchId)).toEqual({ status: 'ACCEPTED', approved_by: memberId(PUSHER) });
      expect(await instanceOf(batchId)).toEqual({ status: 'Completed', outcome: 'APPROVED' });
    });

    it('a return mid-chain sends the batch back to the preparer and ends the instance; nothing was pushed for it', async () => {
      const before = (await pushes('FND_FIGURES-%')).length;
      const { batchId, version } = await handedIn();
      const returned = await flow.call('POST', `/funding-figures/batches/${batchId}/return`, { member: LEADER, ifMatch: `"${version}"`, body: { reason: 'The estimate does not match the books' } });
      expect(returned.status).toBe(200);
      expect((await status(batchId)).status).not.toBe('ACCEPTED');
      expect((await instanceOf(batchId)).status).toBe('Cancelled');
      expect(await pushes('FND_FIGURES-%')).toHaveLength(before);
    });
  });

  describe('a batch of indicator entries (IND_ENTRY, layout IND_ENTRIES)', () => {
    const periodIds = async (): Promise<string[]> => (await flow.rows<{ id: string }>("select id from machvon.reporting_period where fiscal_year = 2027 and period_type = 'WEEK' and calendar_code = 'DEFAULT' order by start_date limit 3")).map((row) => row.id);
    const pendingTask = async (member: number, resourceId: string): Promise<{ id: string; version: string }> =>
      (await flow.rows<{ id: string; version: string }>("select t.id, t.version::text from machvon.approval_task t join machvon.workflow_instance i on i.id = t.workflow_instance_id where t.status = 'Pending' and t.assignee_id = $1 and i.resource_id = $2", [memberId(member), resourceId]))[0] as { id: string; version: string };
    const decideTask = (task: { id: string; version: string }, member: number, body: Record<string, unknown>): Promise<Reply> =>
      fetch(`${flow.app.baseUrl}/approval-tasks/${task.id}/decision`, {
        method: 'POST',
        headers: { [TENANT_HEADER]: DisFlow.tokenOf(member), 'content-type': 'application/json', 'idempotency-key': `key-${randomUUID()}`, 'if-match': `"${task.version}"`, [CLAIMS_HEADER]: JSON.stringify({ aal: 'aal2', aal2At: new Date().toISOString() }) },
        body: JSON.stringify(body),
      }).then(async (response) => ({ status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> }));

    it('is written to the register only after the receipt of HPM: PUSH holds the batch as AWAITING_RECEIPT, the receipt of somebody else finishes the last step', async () => {
      const { projectId } = await flow.seedProject();
      const [period] = await periodIds();
      const handed = await flow.call('POST', '/indicator-figures', { member: PREPARER, body: { project_id: projectId, period_id: period, figures: [{ indicator_code: 'PLAN_YEAR', value: '4200' }] } });
      expect(handed).toMatchObject({ status: 200, json: { status: 'SUBMITTED' } });
      const batchId = ((await flow.rows<{ id: string }>('select id from machvon.ind_entry_batch where project_id = $1 and period_id = $2', [projectId, period]))[0] as { id: string }).id;
      expect(await decideTask(await pendingTask(LEADER, batchId), LEADER, { decision: 'approve' })).toMatchObject({ status: 200 });
      expect(await decideTask(await pendingTask(PUSHER, batchId), PUSHER, { decision: 'approve' })).toMatchObject({ status: 200, json: { status: 'AWAITING_RECEIPT' } });
      const [push] = await pushes('IND_ENTRIES-%');
      expect(push).toMatchObject({ status: 'WRITTEN', attempts: 1 });
      expect(await flow.rows('select 1 from machvon.ind_figure where project_id = $1 and period_id = $2', [projectId, period])).toEqual([]);
      expect(await receipt(RECEIVER, push?.id as string, push?.version as string)).toMatchObject({ status: 200, json: { status: 'ACCEPTED' } });
      expect(await flow.rows<{ value: string; entered_by: string }>('select value::text, entered_by from machvon.ind_figure where project_id = $1 and period_id = $2', [projectId, period])).toEqual([{ value: '4200.000000', entered_by: memberId(PREPARER) }]);
    });
  });
});

