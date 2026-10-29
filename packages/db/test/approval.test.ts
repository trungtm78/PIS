import { randomUUID } from 'node:crypto';
import { ApprovalStore } from '../src/approval-store';
import type { ApprovalEffects, FinalCommand } from '../src/approval-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, contextFor, memberId, roleId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const store = new ApprovalStore();
const ADMIN = 1; // writes definitions
const PUBLISHER = 2; // publishes them
const MAKER = 3; // submits the records
const LEADER_A = 4;
const LEADER_B = 5;
const LEADER_C = 6;
const LOW = 7; // holds approval.decide at a rank below the band
const DELEGATE = 8; // has no grant of their own, acts for a leader
const OFFICER = 9; // a member of nothing special
const LEADER_ROLE = 1;
const LOW_ROLE = 2;
const ROOT = 1;
// The grants of the fixtures run from now on, so the engine is asked at the real time.
let NOW = new Date();

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = ADMIN): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string; extensions?: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
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
const definitionOf = (steps: unknown[], commands = { approved: 'acceptReport', returned: 'returnReport', rejected: 'rejectReport' }) => ({ steps, terminal: commands });
const REPORT = 'report.accept';
const PLAN = 'plan.publish';
const PAYMENT = 'payment.approve';
const paymentCommands = { approved: 'approvePaymentRequest', returned: 'returnPaymentRequest', rejected: 'rejectPaymentRequest' };

/** A definition written by the admin and published by the publisher. */
async function publishDefinition(businessType: string, definition: unknown): Promise<string> {
  const draft = await as((tx) => store.createDraft(tx, { businessType, definition }, memberId(ADMIN)));
  const done = await as((tx) => store.publish(tx, draft.id, draft.version, memberId(PUBLISHER), NOW), PUBLISHER);
  return done.version.id;
}

const update = (tx: TenantTx, id: string, version: number, input: { businessType: string; definition: unknown }, editor = memberId(ADMIN)) => store.updateDraft(tx, id, version, input, editor);

const accept: FinalCommand = () => Promise.resolve('APPLIED');

async function start(businessType: string, options: { maker?: number; resourceId?: string; amount?: string | null } = {}) {
  const e = effects(options.maker ?? MAKER);
  const instance = await as(
    (tx) => store.start(tx, e, { resourceType: 'report', resourceId: options.resourceId ?? randomUUID(), resourceVersion: 1, businessType, amountVnd: options.amount ?? '1000000', unitId: unitId(ROOT), initiatorMembershipId: memberId(options.maker ?? MAKER), now: NOW }),
    options.maker ?? MAKER,
  );
  return { instance, e };
}

const pendingOf = (instanceId: string) => owner<{ id: string; assignee_id: string; step_id: string; version: string }>("select id, assignee_id, step_id, version::text from machvon.approval_task where workflow_instance_id = $1 and status = 'Pending' order by assignee_id", [instanceId]);
// Each decision is made a second after the one before, as it is in life: a step is entered at the moment of a decision and counts the approvals made after it.
let tick = 0;
const decide = (member: number, taskId: string, version: number, decision: 'approve' | 'return' | 'reject', extra: { reason?: string; returnTo?: string; finish?: FinalCommand } = {}) => {
  tick += 1;
  return as((tx) => store.decide(tx, effects(member), { taskId, expectedVersion: version, decision, reason: extra.reason, returnToStep: extra.returnTo, now: new Date(NOW.getTime() + tick * 1000), finish: extra.finish ?? accept }), member);
};
const taskOf = async (instanceId: string, member: number) => {
  const [task] = await owner<{ id: string; version: string }>("select id, version::text from machvon.approval_task where workflow_instance_id = $1 and assignee_id = $2 and status = 'Pending'", [instanceId, memberId(member)]);
  if (task === undefined) throw new Error(`no pending task of member ${member}`);
  return { id: task.id, version: Number(task.version) };
};

describe('the approval engine (ST-ADM-012, ADM 3.7)', () => {
  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
    for (const member of [ADMIN, PUBLISHER, MAKER, LEADER_A, LEADER_B, LEADER_C, LOW, DELEGATE, OFFICER]) await harness.seedMembership(TENANT_A, member, ROOT);
    await harness.seedRole(TENANT_A, LEADER_ROLE, 'LEADER', ['approval.decide'], 60);
    await harness.seedRole(TENANT_A, LOW_ROLE, 'DEPUTY', ['approval.decide'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MAKER, role: LEADER_ROLE, kind: 'TENANT' },
      { n: 2, member: LEADER_A, role: LEADER_ROLE, kind: 'TENANT' },
      { n: 3, member: LEADER_B, role: LEADER_ROLE, kind: 'TENANT' },
      { n: 4, member: LEADER_C, role: LEADER_ROLE, kind: 'TENANT' },
      { n: 5, member: LOW, role: LOW_ROLE, kind: 'TENANT' },
    ]);
    // The matrix in force: reports and plans of any amount go to a LEADER; payments need two levels.
    const matrix = randomUUID();
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.doa_matrix_version (tenant_id, id, revision, status, effective_from, legal_basis_ref, created_by, last_edited_by, version)
         values ($1, $2, 900, 'Draft', date '2020-01-01', 'Fixture regulation on approvals', $3, $3, 1)`,
        [TENANT_A, matrix, memberId(ADMIN)],
      ],
      [
        `insert into machvon.doa_rule (tenant_id, id, matrix_version_id, document_type, unit_id, include_subtree, amount_min_vnd, amount_max_vnd, approver_role_id, approval_levels, position)
         values ($1, $2, $3, 'REPORT_ACCEPT', $4, true, 0, null, $5, 1, 0), ($1, $6, $3, 'PAYMENT_APPROVE', $4, true, 0, null, $5, 2, 1)`,
        [TENANT_A, randomUUID(), matrix, unitId(ROOT), roleId(LEADER_ROLE), randomUUID()],
      ],
      ["update machvon.doa_matrix_version set status = 'PendingApproval' where id = $1", [matrix]],
      ["update machvon.doa_matrix_version set status = 'Published', approved_by = $2, published_at = now() where id = $1", [matrix, memberId(PUBLISHER)]],
    ]);
    // The memberships and grants were seeded just now: the engine is asked from here on.
    NOW = new Date(Date.now() + 1000);
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the definitions', () => {
    it('AC-ST-ADM-012-4, UAT-PLAN-45: refuses an invalid definition with a path for each defect and stores nothing', async () => {
      const before = await owner('select id from machvon.workflow_version');
      const bad = await refusal(as((tx) => store.createDraft(tx, { businessType: REPORT, definition: definitionOf([step('first', { min_approvals: 0, sla_working_hours: -2 })]) }, memberId(ADMIN))));
      expect(bad).toMatchObject({ code: 'WORKFLOW_DEFINITION_INVALID', status: 422, detail: '$.steps[0].min_approvals' });
      expect((bad.extensions as { defects: Array<{ path: string }> }).defects.map((defect) => defect.path)).toEqual(['$.steps[0].min_approvals', '$.steps[0].sla_working_hours']);
      expect(await owner('select id from machvon.workflow_version')).toHaveLength(before.length);
      // The stored definition of a draft is unchanged by an invalid update.
      const draft = await as((tx) => store.createDraft(tx, { businessType: REPORT, definition: definitionOf([step('first')]) }, memberId(ADMIN)));
      const refused = await refusal(as((tx) => update(tx, draft.id, draft.version, { businessType: REPORT, definition: definitionOf([step('first'), step('first')]) })));
      expect(refused).toMatchObject({ code: 'WORKFLOW_DEFINITION_INVALID', detail: '$.steps[1].id' });
      expect((await as((tx) => store.findVersion(tx, draft.id)))?.definition).toEqual(definitionOf([step('first')]));
    });

    it('numbers the drafts of a business type, edits a draft at the version read, and keeps the business type of a draft', async () => {
      const first = await as((tx) => store.createDraft(tx, { businessType: 'contract.change', definition: definitionOf([step('legal')], { approved: 'approveContractChange', returned: 'returnContractChange', rejected: 'rejectContractChange' }) }, memberId(ADMIN)));
      const second = await as((tx) => store.createDraft(tx, { businessType: 'contract.change', definition: definitionOf([step('legal')], { approved: 'approveContractChange', returned: 'returnContractChange', rejected: 'rejectContractChange' }) }, memberId(ADMIN)));
      expect([first.revision, second.revision]).toEqual([1, 2]);
      const commands = { approved: 'approveContractChange', returned: 'returnContractChange', rejected: 'rejectContractChange' };
      expect(await refusal(as((tx) => update(tx, first.id, 9, { businessType: 'contract.change', definition: definitionOf([step('legal')], commands) })))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(as((tx) => update(tx, first.id, first.version, { businessType: REPORT, definition: definitionOf([step('legal')]) })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'business_type' });
      const edited = await as((tx) => update(tx, first.id, first.version, { businessType: 'contract.change', definition: definitionOf([step('legal'), step('chief', { allow_return_to: 'legal' })], commands) }));
      expect(edited).toMatchObject({ version: first.version + 1, status: 'Draft' });
    });

    it('is published by someone other than its author, supersedes the one in force, and is not edited afterwards', async () => {
      const draft = await as((tx) => store.createDraft(tx, { businessType: PLAN, definition: definitionOf([step('review')], { approved: 'publishPlan', returned: 'returnPlan', rejected: 'rejectPlan' }) }, memberId(ADMIN)));
      expect(await refusal(as((tx) => store.publish(tx, draft.id, draft.version, memberId(ADMIN), NOW)))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(as((tx) => store.publish(tx, draft.id, 9, memberId(PUBLISHER), NOW), PUBLISHER))).toMatchObject({ code: 'VERSION_CONFLICT' });
      const done = await as((tx) => store.publish(tx, draft.id, draft.version, memberId(PUBLISHER), NOW), PUBLISHER);
      expect(done).toMatchObject({ supersededId: null, version: { status: 'Published', publishedBy: memberId(PUBLISHER) } });
      expect(await refusal(as((tx) => update(tx, draft.id, done.version.version, { businessType: PLAN, definition: definitionOf([step('review')], { approved: 'publishPlan', returned: 'returnPlan', rejected: 'rejectPlan' }) })))).toMatchObject({ code: 'WORKFLOW_NOT_DRAFT', status: 409 });
      expect(await refusal(as((tx) => store.publish(tx, draft.id, done.version.version, memberId(PUBLISHER), NOW), PUBLISHER))).toMatchObject({ code: 'WORKFLOW_NOT_DRAFT', status: 409 });
      const next = await as((tx) => store.createDraft(tx, { businessType: PLAN, definition: definitionOf([step('review'), step('chief')], { approved: 'publishPlan', returned: 'returnPlan', rejected: 'rejectPlan' }) }, memberId(ADMIN)));
      const second = await as((tx) => store.publish(tx, next.id, next.version, memberId(PUBLISHER), NOW), PUBLISHER);
      expect(second.supersededId).toBe(draft.id);
      expect((await as((tx) => store.findVersion(tx, draft.id)))?.status).toBe('Superseded');
      // The database says the same: a published definition is not edited and an author does not publish.
      await expect(owner('update machvon.workflow_version set definition_json = \'{}\'::jsonb where id = $1', [next.id])).rejects.toThrow(/not edited/);
      await expect(owner("update machvon.workflow_version set status = 'Published', published_by = created_by where id = $1", [(await as((tx) => store.createDraft(tx, { businessType: PLAN, definition: definitionOf([step('x1')], { approved: 'publishPlan', returned: 'returnPlan', rejected: 'rejectPlan' }) }, memberId(ADMIN)))).id])).rejects.toThrow();
    });
  });

  describe('the other kind of definition', () => {
    it('is never edited, published or listed by the approval commands: a notification workflow of the same table is not found', async () => {
      const id = randomUUID();
      await owner(
        `insert into machvon.workflow_version (tenant_id, id, business_type, revision, definition_json, status, kind, event_type, created_by, definition_hash)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, 'report.accept', 1, '{}'::jsonb, 'Draft', 'NOTIFICATION', 'dis.report.accepted.v1', $2, repeat('d', 64))`,
        [id, memberId(ADMIN)],
      );
      expect(await refusal(as((tx) => update(tx, id, 1, { businessType: REPORT, definition: definitionOf([step('review')]) })))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => store.publish(tx, id, 1, memberId(PUBLISHER), NOW), PUBLISHER))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await as((tx) => store.findVersion(tx, id))).toBeUndefined();
      expect((await as((tx) => store.listVersions(tx, { businessType: REPORT }, { limit: 50, after: undefined }))).map((row) => row.id)).not.toContain(id);
      expect((await owner<{ status: string; definition_json: unknown }>('select status, definition_json from machvon.workflow_version where id = $1', [id]))[0]).toEqual({ status: 'Draft', definition_json: {} });
    });
  });

  describe('the checker of a definition', () => {
    it('is neither the author of the draft nor the last to edit it', async () => {
      const commands = { approved: 'approveContractChange', returned: 'returnContractChange', rejected: 'rejectContractChange' };
      const draft = await as((tx) => store.createDraft(tx, { businessType: 'contract.change', definition: definitionOf([step('review')], commands) }, memberId(ADMIN)));
      // The publisher edits the draft: they wrote it now, and do not publish it.
      const edited = await as((tx) => update(tx, draft.id, draft.version, { businessType: 'contract.change', definition: definitionOf([step('review'), step('chief')], commands) }, memberId(PUBLISHER)), PUBLISHER);
      expect(edited.lastEditedBy).toBe(memberId(PUBLISHER));
      expect(await refusal(as((tx) => store.publish(tx, edited.id, edited.version, memberId(PUBLISHER), NOW), PUBLISHER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(as((tx) => store.publish(tx, edited.id, edited.version, memberId(ADMIN), NOW)))).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
      const done = await as((tx) => store.publish(tx, edited.id, edited.version, memberId(LEADER_A), NOW), LEADER_A);
      expect(done.version).toMatchObject({ status: 'Published', publishedBy: memberId(LEADER_A), lastEditedBy: memberId(PUBLISHER) });
      await expect(owner("update machvon.workflow_version set last_edited_by = created_by where id = $1", [edited.id])).rejects.toThrow(/not edited/);
    });
  });

  describe('starting an approval (ApprovalService.start)', () => {
    it('AC-ST-ADM-012-2, UAT-AC128: a business type with no DoA rule fails the start, and nothing is written', async () => {
      // plan.publish has a published definition with a DoA step and the matrix has no rule for CAPITAL_PLAN_PUBLISH.
      const resourceId = randomUUID();
      const before = await owner<{ n: string }>('select count(*)::text as n from machvon.workflow_instance');
      expect(await refusal(start(PLAN, { resourceId }))).toMatchObject({ code: 'DOA_RULE_NOT_FOUND', status: 422 });
      expect((await owner<{ n: string }>('select count(*)::text as n from machvon.workflow_instance'))[0]?.n).toBe(before[0]?.n);
      expect(await owner('select id from machvon.workflow_instance where resource_id = $1', [resourceId])).toEqual([]);
    });

    it('is refused when no workflow is published for the business type, and for a business type nobody registered', async () => {
      expect(await refusal(start('period.reopen'))).toMatchObject({ code: 'WORKFLOW_NOT_CONFIGURED', status: 422 });
      expect(await refusal(start('invoice.pay'))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'business_type' });
    });

    it('writes the instance pinned to the version and the matrix, with a task for each eligible leader but not for the maker, and refuses a second start of the record', async () => {
      const versionId = await publishDefinition(REPORT, definitionOf([step('review')]));
      const resourceId = randomUUID();
      const { instance, e } = await start(REPORT, { resourceId });
      expect(instance).toMatchObject({ status: 'Running', workflowVersionId: versionId, businessType: REPORT, documentType: 'REPORT_ACCEPT', currentStep: 0, initiatorId: memberId(MAKER), doaLevels: 1 });
      expect(instance.doaMatrixVersionId).not.toBeNull();
      const tasks = await pendingOf(instance.id);
      // The maker holds the role of the band and is left out; the leaders are asked, a lower rank and the officer are not.
      expect(tasks.map((task) => task.assignee_id).sort()).toEqual([memberId(LEADER_A), memberId(LEADER_B), memberId(LEADER_C)].sort());
      expect(e.recorded.events.map((event) => event.type)).toEqual(['adm.workflow_instance.started.v1']);
      expect(e.recorded.events[0]?.payload).toMatchObject({ instance_id: instance.id, resource_id: resourceId, workflow_version_id: versionId });
      expect(await refusal(start(REPORT, { resourceId }))).toMatchObject({ code: 'WORKFLOW_ALREADY_RUNNING', status: 409 });
      // A running instance keeps its version when a new one is published.
      const next = await as((tx) => store.createDraft(tx, { businessType: REPORT, definition: definitionOf([step('review'), step('chief')]) }, memberId(ADMIN)));
      await as((tx) => store.publish(tx, next.id, next.version, memberId(PUBLISHER), NOW), PUBLISHER);
      expect((await as((tx) => store.findInstance(tx, instance.id)))?.workflowVersionId).toBe(versionId);
      await expect(owner("update machvon.workflow_instance set resource_id = gen_random_uuid() where id = $1", [instance.id])).rejects.toThrow(/not changed/);
    });

    it('asks for a distinct approver per level and says so when there are too few', async () => {
      await publishDefinition(PAYMENT, definitionOf([step('treasury')], paymentCommands));
      const { instance } = await start(PAYMENT);
      expect(instance.doaLevels).toBe(2);
      expect((await pendingOf(instance.id)).length).toBe(3);
      // With a step that names two approvers but asks for three approvals the definition is refused outright.
      expect(await refusal(as((tx) => store.createDraft(tx, { businessType: PAYMENT, definition: definitionOf([step('sp', { assignee_rule: { type: 'SPECIFIC', membership_ids: [memberId(LEADER_A)] }, min_approvals: 2 })], paymentCommands) }, memberId(ADMIN))))).toMatchObject({ detail: '$.steps[0].min_approvals' });
    });
  });

  describe('deciding a task (decideApprovalTask)', () => {
    it('approves, completes the instance as approved and calls the final command once, with a key that names the instance', async () => {
      await publishDefinition(REPORT, definitionOf([step('review')]));
      const { instance } = await start(REPORT);
      const task = await taskOf(instance.id, LEADER_A);
      const calls: Array<{ command: string; key: string; outcome: string }> = [];
      const finish: FinalCommand = (call) => {
        calls.push({ command: call.command, key: call.idempotencyKey, outcome: call.outcome });
        return Promise.resolve('APPLIED');
      };
      const result = await decide(LEADER_A, task.id, task.version, 'approve', { finish });
      expect(result).toMatchObject({ kind: 'DECIDED', step: 'COMPLETED', outcome: 'APPROVED', finalCommand: 'acceptReport' });
      expect(calls).toEqual([{ command: 'acceptReport', key: `wf:${instance.id}:final:1`, outcome: 'APPROVED' }]);
      expect(await as((tx) => store.findInstance(tx, instance.id))).toMatchObject({ status: 'Completed', outcome: 'APPROVED', decisionSeq: 1 });
      // The other leaders' tasks end with the instance; a second decision of the same task is 409.
      expect(await pendingOf(instance.id)).toEqual([]);
      expect(await refusal(decide(LEADER_A, task.id, task.version + 1, 'approve'))).toMatchObject({ code: 'TASK_ALREADY_DECIDED', status: 409 });
      const other = (await owner<{ id: string }>("select id from machvon.approval_task where workflow_instance_id = $1 and assignee_id = $2", [instance.id, memberId(LEADER_B)]))[0];
      expect(await refusal(decide(LEADER_B, other?.id as string, 1, 'approve'))).toMatchObject({ code: 'TASK_ALREADY_DECIDED' });
      await expect(owner("update machvon.approval_task set decision = 'reject' where id = $1", [task.id])).rejects.toThrow(/written once/);
    });

    it('needs a reason to return or reject, ends them as returned and rejected, and refuses a stale version', async () => {
      await publishDefinition(REPORT, definitionOf([step('review')]));
      const first = await start(REPORT);
      const task = await taskOf(first.instance.id, LEADER_A);
      expect(await refusal(decide(LEADER_A, task.id, task.version, 'reject', { reason: 'no' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason' });
      expect(await refusal(decide(LEADER_A, task.id, 9, 'approve'))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await decide(LEADER_A, task.id, task.version, 'reject', { reason: 'Số liệu không đúng quy định.' })).toMatchObject({ step: 'COMPLETED', outcome: 'REJECTED', finalCommand: 'rejectReport' });
      const second = await start(REPORT);
      const again = await taskOf(second.instance.id, LEADER_B);
      expect(await decide(LEADER_B, again.id, again.version, 'return', { reason: 'Bổ sung hồ sơ còn thiếu.' })).toMatchObject({ step: 'COMPLETED', outcome: 'RETURNED', finalCommand: 'returnReport' });
    });

    it('BR-ADM-07: when the domain refuses the end, the instance says GUARD_REJECTED and an alert event is written', async () => {
      await publishDefinition(REPORT, definitionOf([step('review')]));
      const { instance } = await start(REPORT);
      const task = await taskOf(instance.id, LEADER_C);
      const e = effects(LEADER_C);
      const result = await as((tx) => store.decide(tx, e, { taskId: task.id, expectedVersion: task.version, decision: 'approve', reason: undefined, returnToStep: undefined, now: NOW, finish: () => Promise.resolve('GUARD_REJECTED') }), LEADER_C);
      expect(result).toMatchObject({ kind: 'DECIDED', outcome: 'GUARD_REJECTED' });
      expect(await as((tx) => store.findInstance(tx, instance.id))).toMatchObject({ status: 'Completed', outcome: 'GUARD_REJECTED' });
      expect(e.recorded.events.map((event) => event.type)).toEqual(['adm.approval_task.decided.v1', 'adm.workflow_instance.completed.v1', 'adm.workflow_guard_rejected.v1']);
    });

    it('moves through the steps: the approvals of a step are counted, then the next step opens for its own approvers', async () => {
      await publishDefinition(PAYMENT, definitionOf([step('officer', { assignee_rule: { type: 'SPECIFIC', membership_ids: [memberId(LEADER_A), memberId(LEADER_B)] }, min_approvals: 2, on_timeout: 'EXPIRE' }), step('chief', { assignee_rule: { type: 'SPECIFIC', membership_ids: [memberId(LEADER_C)] } })], paymentCommands));
      const { instance } = await start(PAYMENT);
      const a = await taskOf(instance.id, LEADER_A);
      expect(await decide(LEADER_A, a.id, a.version, 'approve')).toMatchObject({ step: 'STAYED' });
      expect((await as((tx) => store.findInstance(tx, instance.id)))?.currentStep).toBe(0);
      const b = await taskOf(instance.id, LEADER_B);
      const moved = await decide(LEADER_B, b.id, b.version, 'approve');
      expect(moved).toMatchObject({ step: 'NEXT_STEP' });
      expect((await pendingOf(instance.id)).map((task) => [task.assignee_id, task.step_id])).toEqual([[memberId(LEADER_C), 'chief']]);
      const c = await taskOf(instance.id, LEADER_C);
      expect(await decide(LEADER_C, c.id, c.version, 'approve')).toMatchObject({ step: 'COMPLETED', outcome: 'APPROVED', finalCommand: 'approvePaymentRequest' });
    });

    it('is refused, and nothing moves, when the next step has too few eligible approvers: the decision is rolled back with it', async () => {
      // Step 2 is a DoA step with two levels: the two who approved step 1 are left out, so only LEADER_C could be asked.
      await publishDefinition(PAYMENT, definitionOf([step('officer', { assignee_rule: { type: 'SPECIFIC', membership_ids: [memberId(LEADER_A), memberId(LEADER_B)] }, min_approvals: 2 }), step('leader')], paymentCommands));
      const { instance } = await start(PAYMENT);
      const a = await taskOf(instance.id, LEADER_A);
      expect(await decide(LEADER_A, a.id, a.version, 'approve')).toMatchObject({ step: 'STAYED' });
      const b = await taskOf(instance.id, LEADER_B);
      expect(await refusal(decide(LEADER_B, b.id, b.version, 'approve'))).toMatchObject({ code: 'NO_ELIGIBLE_APPROVER', status: 422, detail: 'leader' });
      expect((await as((tx) => store.findInstance(tx, instance.id)))?.currentStep).toBe(0);
      expect((await pendingOf(instance.id)).map((task) => task.assignee_id)).toEqual([memberId(LEADER_B)]);
    });

    it('goes back to the step a step allows, and asks the approvers of that step again', async () => {
      await publishDefinition(REPORT, definitionOf([step('review', { assignee_rule: { type: 'SPECIFIC', membership_ids: [memberId(LEADER_A)] } }), step('chief', { assignee_rule: { type: 'SPECIFIC', membership_ids: [memberId(LEADER_B)] }, allow_return_to: 'review' })]));
      const { instance } = await start(REPORT);
      const a = await taskOf(instance.id, LEADER_A);
      expect(await decide(LEADER_A, a.id, a.version, 'approve')).toMatchObject({ step: 'NEXT_STEP' });
      const b = await taskOf(instance.id, LEADER_B);
      expect(await refusal(decide(LEADER_B, b.id, b.version, 'return', { reason: 'Cần xem lại số liệu ở bước trước.', returnTo: 'nowhere' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'return_to_step' });
      expect(await decide(LEADER_B, b.id, b.version, 'return', { reason: 'Cần xem lại số liệu ở bước trước.', returnTo: 'review' })).toMatchObject({ step: 'RETURNED_TO_STEP' });
      expect(await as((tx) => store.findInstance(tx, instance.id))).toMatchObject({ status: 'Running', currentStep: 0 });
      const again = await taskOf(instance.id, LEADER_A);
      expect(again.id).not.toBe(a.id);
    });

    it('AC-ST-ADM-012-1, UAT-AC129: a maker who holds the task is refused and the task goes to another eligible person', async () => {
      await publishDefinition(REPORT, definitionOf([step('review')]));
      const { instance } = await start(REPORT);
      // The maker holds a task (given to them by an operator): they may not decide it.
      const [given] = await owner<{ id: string }>(
        `insert into machvon.approval_task (tenant_id, id, workflow_instance_id, assignee_id, due_at, step_id, step_index, status)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2, now() + interval '1 day', 'review', 0, 'Pending') returning id`,
        [instance.id, memberId(MAKER)],
      );
      const result = await decide(MAKER, given?.id as string, 1, 'approve');
      expect(result.kind).toBe('SELF_APPROVAL');
      expect(result.kind === 'SELF_APPROVAL' ? result.reassignedTo : null).toBeNull();
      // Every other leader already has a task of this step, so there is nobody to give it to; the task stays with the maker.
      expect((await owner<{ status: string }>('select status from machvon.approval_task where id = $1', [given?.id]))[0]?.status).toBe('Pending');
      // With a leader who has none yet, the task is given to them, with the same due time.
      const second = await start(REPORT, { resourceId: randomUUID() });
      await owner("update machvon.approval_task set status = 'Cancelled' where workflow_instance_id = $1 and assignee_id = $2", [second.instance.id, memberId(LEADER_C)]);
      const [madeBy] = await owner<{ id: string; due_at: string }>(
        `insert into machvon.approval_task (tenant_id, id, workflow_instance_id, assignee_id, due_at, step_id, step_index, status)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2, now() + interval '2 days', 'review', 0, 'Pending') returning id, due_at::text`,
        [second.instance.id, memberId(MAKER)],
      );
      const moved = await decide(MAKER, madeBy?.id as string, 1, 'approve');
      expect(moved).toMatchObject({ kind: 'SELF_APPROVAL', reassignedTo: memberId(LEADER_C) });
      const rows = await owner<{ status: string; assignee_id: string; due_at: string }>('select status, assignee_id, due_at::text from machvon.approval_task where workflow_instance_id = $1 and step_id = $2 and assignee_id in ($3, $4) order by created_at', [second.instance.id, 'review', memberId(MAKER), memberId(LEADER_C)]);
      expect(rows.find((row) => row.assignee_id === memberId(MAKER))?.status).toBe('Reassigned');
      expect(rows.filter((row) => row.assignee_id === memberId(LEADER_C)).map((row) => row.status)).toContain('Pending');
      expect(rows.find((row) => row.assignee_id === memberId(LEADER_C) && row.status === 'Pending')?.due_at).toBe(madeBy?.due_at);
    });

    it('lets a delegate decide for the assignee and records on whose behalf, and refuses anyone who is neither', async () => {
      await publishDefinition(REPORT, definitionOf([step('review')]));
      const { instance } = await start(REPORT);
      const task = await taskOf(instance.id, LEADER_A);
      expect(await refusal(decide(DELEGATE, task.id, task.version, 'approve'))).toMatchObject({ code: 'APPROVER_NOT_AUTHORIZED', status: 403 });
      expect(await refusal(decide(OFFICER, task.id, task.version, 'approve'))).toMatchObject({ code: 'APPROVER_NOT_AUTHORIZED' });
      await owner(
        `insert into machvon.delegation_grant (tenant_id, id, delegator_membership_id, delegate_membership_id, permissions, scope_json, valid_from, valid_until, reason, status)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2, array['approval.decide'], '{"kind":"TENANT","ref_ids":[]}'::jsonb, now() - interval '1 day', now() + interval '10 days', 'Đi công tác', 'Active')`,
        [memberId(LEADER_A), memberId(DELEGATE)],
      );
      // The delegate decides under the authority of the leader: the band is judged on the leader's grants.
      const result = await as((tx) => store.decide(tx, effects(DELEGATE), { taskId: task.id, expectedVersion: task.version, decision: 'approve', reason: undefined, returnToStep: undefined, now: new Date(), finish: accept }), DELEGATE);
      expect(result).toMatchObject({ kind: 'DECIDED', step: 'COMPLETED' });
      expect(await owner<{ decided_by: string; on_behalf_of_id: string; delegation_id: string | null }>('select decided_by, on_behalf_of_id, delegation_id from machvon.approval_task where id = $1', [task.id])).toMatchObject([{ decided_by: memberId(DELEGATE), on_behalf_of_id: memberId(LEADER_A) }]);
    });

    it('takes a delegation only where its scope reaches the unit of the approval, and shows the delegate the task they may decide', async () => {
      await publishDefinition(REPORT, definitionOf([step('review')]));
      const { instance } = await start(REPORT);
      const task = await taskOf(instance.id, LEADER_B);
      const other = unitId(ROOT + 5);
      await owner('delete from machvon.delegation_grant where delegator_membership_id = $1', [memberId(LEADER_B)]).catch(() => undefined);
      const [grant] = await owner<{ id: string }>(
        `insert into machvon.delegation_grant (tenant_id, id, delegator_membership_id, delegate_membership_id, permissions, scope_json, valid_from, valid_until, reason, status)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2, array['approval.decide'], jsonb_build_object('kind', 'UNIT_ONLY', 'ref_ids', jsonb_build_array($3::text)), now() - interval '1 day', now() + interval '10 days', 'Đi công tác', 'Active') returning id`,
        [memberId(LEADER_B), memberId(DELEGATE), other],
      );
      // The delegation reaches another unit: the delegate cannot decide here, and the task is not theirs to see as one they may decide.
      const mineOf = async () => (await as((tx) => store.listTasks(tx, { membershipId: memberId(DELEGATE), all: false }, { instanceId: instance.id }, { limit: 10, after: undefined }), DELEGATE)).filter((row) => row.assigneeId === memberId(LEADER_B));
      expect(await mineOf()).toEqual([]);
      expect(await refusal(decide(DELEGATE, task.id, task.version, 'approve'))).toMatchObject({ code: 'APPROVER_NOT_AUTHORIZED', status: 403 });
      // The same delegation, widened to the unit of the approval.
      // What a delegation grants never changes in life (a guard trigger says so); the fixture widens it as a record from before the rule.
      await harness.owner(TENANT_A, [
        ['alter table machvon.delegation_grant disable trigger delegation_grant_guard', []],
        ["update machvon.delegation_grant set scope_json = jsonb_build_object('kind', 'UNIT_ONLY', 'ref_ids', jsonb_build_array($2::text)) where id = $1", [grant?.id, unitId(ROOT)]],
        ['alter table machvon.delegation_grant enable trigger delegation_grant_guard', []],
      ]);
      const seen = await mineOf();
      expect(seen.map((row) => [row.assigneeId, row.delegatedToMe])).toEqual([[memberId(LEADER_B), true]]);
      expect((await as((tx) => store.findTask(tx, task.id, memberId(DELEGATE)), DELEGATE))?.delegatedToMe).toBe(true);
      expect((await as((tx) => store.findTask(tx, task.id, memberId(OFFICER)), OFFICER))?.delegatedToMe).toBe(false);
      expect(await decide(DELEGATE, task.id, task.version, 'approve')).toMatchObject({ kind: 'DECIDED', step: 'COMPLETED' });
    });

    it('lets the delegate, and whoever decided, read the approval they are handling: the instance is theirs to see', async () => {
      await publishDefinition(REPORT, definitionOf([step('review')]));
      const { instance } = await start(REPORT);
      const viewer = { membershipId: memberId(OFFICER), all: false };
      const seen = async (member = viewer) => (await as((tx) => store.listInstances(tx, member, { id: instance.id }, { limit: 1, after: undefined }), OFFICER)).length;
      expect(await seen()).toBe(0);
      await owner(
        `insert into machvon.delegation_grant (tenant_id, id, delegator_membership_id, delegate_membership_id, permissions, scope_json, valid_from, valid_until, reason, status)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2, array['approval.decide'], '{"kind":"TENANT","ref_ids":[]}'::jsonb, now() - interval '1 day', now() + interval '10 days', 'Đi công tác', 'Active')`,
        [memberId(LEADER_C), memberId(OFFICER)],
      );
      expect(await seen()).toBe(1);
      // Whoever decided keeps seeing it after the delegation ended.
      const task = await taskOf(instance.id, LEADER_C);
      expect(await decide(OFFICER, task.id, task.version, 'approve')).toMatchObject({ kind: 'DECIDED' });
      await owner("update machvon.delegation_grant set status = 'Ended', ended_at = now(), end_reason = 'EXPIRED' where delegate_membership_id = $1", [memberId(OFFICER)]);
      expect(await seen()).toBe(1);
    });

    it('keeps the task of the one who decided it in view after a delegation ended, and asks again only those who did not approve the earlier steps when it returns to a later DoA step', async () => {
      await publishDefinition(REPORT, definitionOf([step('review'), step('chief', { allow_return_to: 'review' }), step('sign', { allow_return_to: 'chief' })]));
      const { instance } = await start(REPORT);
      // Step 1 (DoA, one level): LEADER_A approves; step 2: LEADER_B approves; step 3: LEADER_C returns to step 2.
      const a = await taskOf(instance.id, LEADER_A);
      await decide(LEADER_A, a.id, a.version, 'approve');
      const b = await taskOf(instance.id, LEADER_B);
      await decide(LEADER_B, b.id, b.version, 'approve');
      const c = await taskOf(instance.id, LEADER_C);
      expect(await decide(LEADER_C, c.id, c.version, 'return', { reason: 'Cần xem lại ở bước hai.', returnTo: 'chief' })).toMatchObject({ step: 'RETURNED_TO_STEP' });
      // The step reopens for the people who did not approve the step before it: LEADER_A approved step 1 and is not asked again for step 2.
      expect((await pendingOf(instance.id)).map((task) => task.assignee_id).sort()).toEqual([memberId(LEADER_B), memberId(LEADER_C)].sort());
      const after = await as((tx) => store.listTasks(tx, { membershipId: memberId(LEADER_A), all: false }, { id: a.id }, { limit: 1, after: undefined }), LEADER_A);
      expect(after.map((task) => task.id)).toEqual([a.id]);
    });

    it('counts one person once in a step: someone who decided one task does not decide another of the same step through a delegation', async () => {
      await publishDefinition(PAYMENT, definitionOf([step('treasury')], paymentCommands));
      const { instance } = await start(PAYMENT);
      const a = await taskOf(instance.id, LEADER_A);
      expect(await decide(LEADER_A, a.id, a.version, 'approve')).toMatchObject({ step: 'STAYED' });
      await owner(
        `insert into machvon.delegation_grant (tenant_id, id, delegator_membership_id, delegate_membership_id, permissions, scope_json, valid_from, valid_until, reason, status)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2, array['approval.decide'], '{"kind":"TENANT","ref_ids":[]}'::jsonb, now() - interval '1 day', now() + interval '10 days', 'Đi công tác', 'Active')`,
        [memberId(LEADER_B), memberId(LEADER_A)],
      );
      const b = await taskOf(instance.id, LEADER_B);
      expect(await refusal(decide(LEADER_A, b.id, b.version, 'approve'))).toMatchObject({ code: 'APPROVER_NOT_AUTHORIZED', status: 403, detail: 'already_decided' });
      expect((await as((tx) => store.findInstance(tx, instance.id)))?.status).toBe('Running');
      // Two different people finish it.
      expect(await decide(LEADER_B, b.id, b.version, 'approve')).toMatchObject({ step: 'COMPLETED', outcome: 'APPROVED' });
    });

    it('leaves out, for a step that opens again after a return, only the people who approved the steps before it in the current traversal', async () => {
      await publishDefinition(PAYMENT, definitionOf([step('officer', { assignee_rule: { type: 'SPECIFIC', membership_ids: [memberId(LEADER_A)] } }), step('leader', { allow_return_to: 'officer' })], paymentCommands));
      const { instance } = await start(PAYMENT);
      const a = await taskOf(instance.id, LEADER_A);
      expect(await decide(LEADER_A, a.id, a.version, 'approve')).toMatchObject({ step: 'NEXT_STEP' });
      const first = await taskOf(instance.id, LEADER_B);
      expect(await decide(LEADER_B, first.id, first.version, 'approve')).toMatchObject({ step: 'STAYED' });
      const c = await taskOf(instance.id, LEADER_C);
      expect(await decide(LEADER_C, c.id, c.version, 'return', { reason: 'Cần xem lại ở bước trước.', returnTo: 'officer' })).toMatchObject({ step: 'RETURNED_TO_STEP' });
      const again = await taskOf(instance.id, LEADER_A);
      // The step "leader" opens again for two levels: LEADER_B and LEADER_C approved it before and are asked again; only LEADER_A (the earlier step) is left out.
      const moved = await decide(LEADER_A, again.id, again.version, 'approve');
      expect(moved).toMatchObject({ step: 'NEXT_STEP' });
      expect((await pendingOf(instance.id)).map((task) => task.assignee_id).sort()).toEqual([memberId(LEADER_B), memberId(LEADER_C)].sort());
    });

    it('counts the decisions by their number and not by the clock: a decision made at the very moment the step opened still counts', async () => {
      await publishDefinition(REPORT, definitionOf([step('review', { assignee_rule: { type: 'SPECIFIC', membership_ids: [memberId(LEADER_A)] } })]));
      const { instance } = await start(REPORT);
      const a = await taskOf(instance.id, LEADER_A);
      // The clock of the node that decides is the clock of the node that started: the decision is no earlier and no later than the start.
      const result = await as((tx) => store.decide(tx, effects(LEADER_A), { taskId: a.id, expectedVersion: a.version, decision: 'approve', reason: undefined, returnToStep: undefined, now: NOW, finish: accept }), LEADER_A);
      expect(result).toMatchObject({ kind: 'DECIDED', step: 'COMPLETED', outcome: 'APPROVED' });
    });

    it('gives a task only to someone who may use the decision endpoint: a named member without approval.decide is not an approver', async () => {
      await publishDefinition(REPORT, definitionOf([step('review', { assignee_rule: { type: 'SPECIFIC', membership_ids: [memberId(OFFICER)] } })]));
      expect(await refusal(start(REPORT))).toMatchObject({ code: 'NO_ELIGIBLE_APPROVER', status: 422, detail: 'review' });
    });

    it('publishes two drafts of one business type one after the other when they are published at the same moment, the second superseding the first', async () => {
      const commands = { approved: 'approvePaymentRequest', returned: 'returnPaymentRequest', rejected: 'rejectPaymentRequest' };
      const first = await as((tx) => store.createDraft(tx, { businessType: PAYMENT, definition: definitionOf([step('one')], commands) }, memberId(ADMIN)));
      const second = await as((tx) => store.createDraft(tx, { businessType: PAYMENT, definition: definitionOf([step('two')], commands) }, memberId(ADMIN)));
      const results = await Promise.allSettled([
        as((tx) => store.publish(tx, first.id, first.version, memberId(PUBLISHER), NOW), PUBLISHER),
        as((tx) => store.publish(tx, second.id, second.version, memberId(LEADER_A), NOW), LEADER_A),
      ]);
      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
      const states = await owner<{ id: string; status: string }>("select id, status from machvon.workflow_version where id = any($1::uuid[])", [[first.id, second.id]]);
      expect(states.filter((row) => row.status === 'Published')).toHaveLength(1);
      expect(states.filter((row) => row.status === 'Superseded')).toHaveLength(1);
    });

    it('makes two drafts of a business type written at the same moment two revisions, and not an error', async () => {
      const commands = { approved: 'reopenPeriod', returned: 'returnPeriodReopen', rejected: 'rejectPeriodReopen' };
      const results = await Promise.all([1, 2, 3].map(() => as((tx) => store.createDraft(tx, { businessType: 'period.reopen', definition: definitionOf([step('review')], commands) }, memberId(ADMIN)))));
      expect(results.map((draft) => draft.revision).sort()).toEqual([1, 2, 3]);
    });

    it('judges the band again on the grants as they are now: an approver who lost the role is refused', async () => {
      await publishDefinition(REPORT, definitionOf([step('review')]));
      const { instance } = await start(REPORT);
      const task = await taskOf(instance.id, LEADER_B);
      await owner('update machvon.role_grant set effective_until = now() - interval \'1 minute\' where membership_id = $1', [memberId(LEADER_B)]);
      expect(await refusal(decide(LEADER_B, task.id, task.version, 'approve'))).toMatchObject({ code: 'APPROVER_NOT_AUTHORIZED', status: 403 });
      expect((await as((tx) => store.findInstance(tx, instance.id)))?.status).toBe('Running');
      await owner('update machvon.role_grant set effective_until = null where membership_id = $1', [memberId(LEADER_B)]);
    });

    it('lets one of two simultaneous decisions of a task through and refuses the other', async () => {
      await publishDefinition(REPORT, definitionOf([step('review')]));
      const { instance } = await start(REPORT);
      const task = await taskOf(instance.id, LEADER_A);
      const calls: string[] = [];
      const finish: FinalCommand = (call) => {
        calls.push(call.idempotencyKey);
        return Promise.resolve('APPLIED');
      };
      const results = await Promise.allSettled([decide(LEADER_A, task.id, task.version, 'approve', { finish }), decide(LEADER_A, task.id, task.version, 'approve', { finish })]);
      expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason as { code: string }).code).toBe('TASK_ALREADY_DECIDED');
      expect(calls).toEqual([`wf:${instance.id}:final:1`]);
    });
  });

  describe('cancelling', () => {
    it('ends the running instance and its open tasks, once, and does nothing when there is none', async () => {
      await publishDefinition(REPORT, definitionOf([step('review')]));
      const resourceId = randomUUID();
      const { instance } = await start(REPORT, { resourceId });
      const e = effects(MAKER);
      expect(await as((tx) => store.cancel(tx, e, { resourceType: 'report', resourceId, reason: 'Hồ sơ đã được rút lại.', now: NOW }), MAKER)).toBe(true);
      expect(await as((tx) => store.findInstance(tx, instance.id))).toMatchObject({ status: 'Cancelled', outcome: 'CANCELLED' });
      expect(await pendingOf(instance.id)).toEqual([]);
      expect(e.recorded.events.map((event) => event.type)).toEqual(['adm.workflow_instance.cancelled.v1']);
      expect(await as((tx) => store.cancel(tx, effects(MAKER), { resourceType: 'report', resourceId, reason: 'Hồ sơ đã được rút lại.', now: NOW }), MAKER)).toBe(false);
      await expect(owner("update machvon.workflow_instance set status = 'Running', outcome = null, ended_at = null where id = $1", [instance.id])).rejects.toThrow(/ended is not changed/);
      // The record can be submitted again after it was withdrawn.
      expect((await start(REPORT, { resourceId })).instance.status).toBe('Running');
    });
  });

  describe('the reads', () => {
    it('lists the tasks of the approver, and those of the tenant for who runs workflows, a page at a time', async () => {
      await publishDefinition(REPORT, definitionOf([step('review')]));
      const { instance } = await start(REPORT, { resourceId: randomUUID() });
      const mine = await as((tx) => store.listTasks(tx, { membershipId: memberId(LEADER_A), all: false }, { status: 'Pending', mine: true, instanceId: instance.id }, { limit: 10, after: undefined }), LEADER_A);
      expect(mine.map((task) => [task.assigneeId, task.status, task.stepId])).toEqual([[memberId(LEADER_A), 'Pending', 'review']]);
      expect(mine[0]).toMatchObject({ businessType: REPORT, resourceType: 'report' });
      const everything = await as((tx) => store.listTasks(tx, { membershipId: memberId(ADMIN), all: true }, { instanceId: instance.id }, { limit: 10, after: undefined }));
      expect(everything.length).toBeGreaterThanOrEqual(3);
      expect(await as((tx) => store.listTasks(tx, { membershipId: memberId(OFFICER), all: false }, { instanceId: instance.id }, { limit: 10, after: undefined }), OFFICER)).toEqual([]);
      const firstPage = await as((tx) => store.listTasks(tx, { membershipId: memberId(ADMIN), all: true }, { instanceId: instance.id }, { limit: 2, after: undefined }));
      const secondPage = await as((tx) => store.listTasks(tx, { membershipId: memberId(ADMIN), all: true }, { instanceId: instance.id }, { limit: 2, after: { code: (firstPage[1] as { sortKey: string }).sortKey, id: (firstPage[1] as { id: string }).id } }));
      expect(secondPage.map((task) => task.id).filter((id) => firstPage.some((row) => row.id === id))).toEqual([]);
      const instances = await as((tx) => store.listInstances(tx, { membershipId: memberId(MAKER), all: false }, { resourceType: 'report', status: 'Running' }, { limit: 50, after: undefined }), MAKER);
      expect(instances.some((row) => row.id === instance.id)).toBe(true);
      expect(await as((tx) => store.listInstances(tx, { membershipId: memberId(OFFICER), all: false }, { status: 'Running' }, { limit: 50, after: undefined }), OFFICER)).toEqual([]);
      const versions = await as((tx) => store.listVersions(tx, { businessType: REPORT, status: 'Published' }, { limit: 10, after: undefined }));
      expect(versions).toHaveLength(1);
    });
  });
});
