import { randomUUID } from 'node:crypto';
import { ApprovalStore, AuditWriter, PwfScoreAdjustmentStore, PwfScoreStore, enqueueOutbox } from '@machvon/db';
import type { ApprovalEffects, TenantTx } from '@machvon/db';
import { BUSINESS_TYPES, pwfKpi } from '@machvon/kernel';
import { BASELINE_PACK, applyBaseline } from '../../../../packages/db/src/master-baseline';
import { FinalCommandRegistry } from '../../src/modules/adm/approval.service';
import { PwfScoreResponseBinding } from '../../src/modules/pwf/score-response.binding';
import { ScoreResponseFlow } from '../../src/modules/pwf/score-response.flow';
import { AuthzHarness, TENANT_A, contextFor, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { ScoreFixtures } from '../../../../packages/db/test/support/pwf-score-fixtures';

jest.setTimeout(300_000);

const Y = 2025;
const TODAY = new Date().toISOString().slice(0, 10);
const ROOT = 1;
const MAKER = 1;
const WORKER = 2;
const REVIEWER = 3;
const AUTHOR = 4;
const SYSTEM = '00000000-0000-4000-8000-000000000000';

describe('the response to a score handled by the approval engine of ADM (R43, R14: a real final command, a clock, the trail)', () => {
  const harness = new AuthzHarness();
  const fixtures = new ScoreFixtures({ harness, maker: MAKER, unit: ROOT });
  const approvals = new ApprovalStore();
  const adjustments = new PwfScoreAdjustmentStore();
  const periods = new PwfScoreStore();
  const registry = new FinalCommandRegistry();
  const flow = new ScoreResponseFlow(registry);
  const audit = new AuditWriter(harness.tenants);
  let lineId = '';

  const as = <T>(member: number, work: (tx: TenantTx) => Promise<T>): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
  const effectsOf = (tx: TenantTx, actor: number): ApprovalEffects => ({
    actor: memberId(actor),
    audit: (entry) => audit.recordInTx(tx, memberId(actor), { ...entry, correlationId: randomUUID(), requestId: randomUUID() }),
    emit: (event) => enqueueOutbox(tx, { ...event, correlationId: randomUUID() }),
  });
  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

  /** Sends a response of the person scored and starts what handles it, in one transaction, as the command does. */
  const respond = (body = 'The delay came from the agency; here is the letter I sent on the due day.') =>
    as(WORKER, async (tx) => {
      const result = await adjustments.submit(tx, { lineId, body, actor: memberId(WORKER), today: TODAY });
      const instanceId = await flow.start(tx, effectsOf(tx, WORKER), result, new Date());
      return { result, instanceId };
    });
  const pendingTask = async (instanceId: string): Promise<{ id: string; version: string; assignee_id: string }> =>
    (await rows<{ id: string; version: string; assignee_id: string }>("select id, version::text, assignee_id from machvon.approval_task where workflow_instance_id = $1 and status = 'Pending'", [instanceId]))[0] as never;
  const decide = (member: number, task: { id: string; version: string }, decision: 'approve' | 'return' | 'reject', reason?: string) =>
    as(member, (tx) => approvals.decide(tx, effectsOf(tx, member), { taskId: task.id, expectedVersion: Number(task.version), decision, reason, returnToStep: undefined, now: new Date(), finish: registry.asFinalCommand() }));
  const responseOf = async (id: string): Promise<{ status: string; outcome: string | null; handled_by: string | null; conclusion: string | null; approval_instance_id: string | null }> =>
    (await rows<{ status: string; outcome: string | null; handled_by: string | null; conclusion: string | null; approval_instance_id: string | null }>('select status, outcome, handled_by, conclusion, approval_instance_id from machvon.staff_score_response where id = $1::uuid', [id]))[0] as never;

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
    for (const n of [MAKER, WORKER, REVIEWER, AUTHOR]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: SYSTEM, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, SYSTEM, TODAY));
    await fixtures.seed({ maker: MAKER, submitter: AUTHOR, checker: REVIEWER }, { ...pwfKpi.DEFAULT_STAFF_SCORING_PARAMS, min_rated_tasks: 1, min_effective_weight: 0.5 });
    const wf = await fixtures.workflow();
    const task = await fixtures.task(wf, 'W1', { baselineFinish: `${Y}-08-15`, actualFinish: `${Y}-08-22` });
    await fixtures.hold(task, WORKER);
    const draft = await as(MAKER, (tx) => periods.compute(tx, { scopeUnitId: unitId(ROOT), periodFrom: `${Y}-07-01`, periodTo: `${Y}-09-30`, policyCode: 'TESTPOL', actor: memberId(MAKER), units: '*', now: new Date() }));
    await as(MAKER, (tx) => periods.lock(tx, { periodId: draft.period.id, expectedVersion: draft.period.version, actor: memberId(MAKER), units: '*', now: new Date() }));
    lineId = ((await rows<{ id: string }>('select id from machvon.staff_score_line where membership_id = $1::uuid', [memberId(WORKER)]))[0] as { id: string }).id;
  }, 300_000);

  afterAll(() => harness.stop(), 60_000);

  it('is a business type of PWF that the registry can end only once the module bound its real command (R14)', () => {
    expect(BUSINESS_TYPES.find((type) => type.code === 'score.response')).toMatchObject({ ownerModule: 'PWF', documentType: 'STAFF_SCORE_RESPONSE', enabledByDefault: false });
    expect(registry.hasRealHandler('score.response')).toBe(false);
    new PwfScoreResponseBinding(registry);
    expect(registry.hasRealHandler('score.response')).toBe(true);
    expect(registry.missingHandlers(['score.response'])).toEqual([]);
  });

  it('handles the response directly while the tenant has published no workflow: a clock runs, no instance starts', async () => {
    const sent = await respond();
    expect(sent.instanceId).toBeUndefined();
    expect((await rows<{ status: string; owner_unit_id: string }>("select status, owner_unit_id from machvon.work_clock where subject_id = $1 and clock_type = 'PWF_SCORE_RESPONSE'", [sent.result.id]))[0]).toEqual({ status: 'RUNNING', owner_unit_id: unitId(ROOT) });
    const line = ((await rows<{ version: number }>('select version from machvon.staff_score_line where id = $1::uuid', [lineId]))[0] as { version: number }).version;
    await as(REVIEWER, (tx) => adjustments.handle(tx, { responseId: sent.result.id, expectedVersion: line, outcome: 'KEEP', conclusion: 'The score stands.', actor: memberId(REVIEWER), units: '*' }));
    expect(await responseOf(sent.result.id)).toMatchObject({ status: 'HANDLED', outcome: 'KEEP', handled_by: memberId(REVIEWER), approval_instance_id: null });
  });

  describe('with a published workflow of approval for the business type', () => {
    beforeAll(async () => {
      const definition = {
        steps: [{ id: 'review', name: 'Review of the response', assignee_rule: { type: 'SPECIFIC', membership_ids: [memberId(REVIEWER)] }, min_approvals: 1, sla_working_hours: 24, on_timeout: 'REMIND' }],
        terminal: { approved: 'upholdStaffScoreResponse', returned: 'returnStaffScoreResponse', rejected: 'keepStaffScore' },
      };
      await as(MAKER, (tx) => approvals.adopt(tx, effectsOf(tx, MAKER), { businessType: 'score.response', definition, proposedBy: memberId(AUTHOR), approvedBy: memberId(REVIEWER), ruleVersion: 1, now: new Date() }));
    });

    it('starts an instance for the response, pinned to the unit of the person at the period, and keeps its reference on the response; nobody handles it by hand while it runs', async () => {
      const sent = await respond();
      expect(sent.instanceId).toBeDefined();
      const task = await pendingTask(sent.instanceId as string);
      expect(task.assignee_id).toBe(memberId(REVIEWER));
      expect((await rows<{ business_type: string; resource_type: string; unit_id: string; status: string }>('select business_type, resource_type, unit_id, status from machvon.workflow_instance where id = $1::uuid', [sent.instanceId]))[0]).toEqual({ business_type: 'score.response', resource_type: 'staff_score_response', unit_id: unitId(ROOT), status: 'Running' });
      expect((await responseOf(sent.result.id)).approval_instance_id).toBe(sent.instanceId);
      const line = ((await rows<{ version: number }>('select version from machvon.staff_score_line where id = $1::uuid', [lineId]))[0] as { version: number }).version;
      const refused = await as(REVIEWER, (tx) => adjustments.handle(tx, { responseId: sent.result.id, expectedVersion: line, outcome: 'KEEP', conclusion: 'By hand.', actor: memberId(REVIEWER), units: '*' })).catch((error: { code?: string }) => error.code);
      expect(refused).toBe('WORKFLOW_ALREADY_RUNNING');
      expect((await rows<{ status: string }>("select status from machvon.work_clock where subject_id = $1", [sent.result.id]))[0]?.status).toBe('RUNNING');
    });

    it('ends in the final command: an approval upholds the response with the reason, the clock is met, and the audit row and the event follow the decision', async () => {
      const sent = await respond('Please look at my task again: the letter is dated before the due day.');
      const task = await pendingTask(sent.instanceId as string);
      const decided = await decide(REVIEWER, task, 'approve', 'The letter is dated before the due day; upheld.');
      expect(decided).toMatchObject({ kind: 'DECIDED', step: 'COMPLETED', outcome: 'APPROVED' });
      expect(await responseOf(sent.result.id)).toMatchObject({ status: 'HANDLED', outcome: 'UPHELD', handled_by: memberId(REVIEWER), conclusion: 'The letter is dated before the due day; upheld.' });
      expect((await rows<{ status: string }>('select status from machvon.work_clock where subject_id = $1', [sent.result.id]))[0]?.status).toBe('MET');
      expect((await rows<{ safe_diff: Record<string, unknown>; classification: string }>("select safe_diff, classification from machvon.audit_event where action = 'score.response_handled' and resource_id = $1::uuid", [sent.result.id]))[0]).toMatchObject({ classification: 'PERSONAL', safe_diff: { outcome: 'UPHELD', instance_id: sent.instanceId } });
      const [event] = await rows<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where aggregate_id = $1::uuid and type = 'pwf.score.response.handled.v1'", [sent.result.id]);
      expect(event?.payload).toMatchObject({ outcome: 'UPHELD', instance_id: sent.instanceId });
      expect(JSON.stringify(event?.payload)).not.toMatch(/letter|conclusion|upheld\./);
    });

    it('keeps the score when an approver rejects and ends the response when an approver returns it, each with its reason', async () => {
      const rejected = await respond('A second response: I contest the number of days of delay in the table.');
      await decide(REVIEWER, await pendingTask(rejected.instanceId as string), 'reject', 'The days are those of the baseline; the score is kept.');
      expect(await responseOf(rejected.result.id)).toMatchObject({ status: 'HANDLED', outcome: 'KEPT', conclusion: 'The days are those of the baseline; the score is kept.' });
      const returned = await respond('A third response: the evidence of the agency letter is attached.');
      await decide(REVIEWER, await pendingTask(returned.instanceId as string), 'return', 'Send the evidence of the letter in a document first.');
      expect(await responseOf(returned.result.id)).toMatchObject({ status: 'HANDLED', outcome: 'RETURNED' });
    });

    it('never ends a response for the person scored or for one that is not open: the engine answers GUARD_REJECTED and the response stays as it was', async () => {
      const call = (instanceResource: string, actor: number) =>
        as(actor, async (tx) => {
          const finish = registry.asFinalCommand();
          return finish({ tx, instance: { businessType: 'score.response', resourceType: 'staff_score_response', resourceId: instanceResource, id: randomUUID(), decisionSeq: 0 } as never, outcome: 'APPROVED', command: 'upholdStaffScoreResponse', idempotencyKey: 'k', effects: effectsOf(tx, actor) });
        }).then((answer) => ({ answer: answer as string }));
      const sent = await respond('A fourth response: please look at the table again, line by line.');
      expect(await call(sent.result.id, WORKER)).toEqual({ answer: 'GUARD_REJECTED' });
      expect(await responseOf(sent.result.id)).toMatchObject({ status: 'OPEN' });
      expect(await call(randomUUID(), REVIEWER)).toEqual({ answer: 'GUARD_REJECTED' });
    });
  });
});
