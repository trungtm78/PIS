import { randomUUID } from 'node:crypto';
import { ApprovalStore, WorkCalendarStore } from '@machvon/db';
import type { ApprovalEffects, FinalCommand } from '@machvon/db';
import type { TenantTx } from '@machvon/db';
import { AuthzHarness, TENANT_A, contextFor, memberId, roleId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { expectCheckFails } from '../uat/uat-kit';

/**
 * UAT cases of the approval engine on the platform fixture (ADM.md BR-ADM-03, BR-ADM-04, BR-ADM-08): the matrix of delegation of authority decides who approves a payment request
 * by its amount, the deadline of a task is counted in working time on the calendar of the tenant, and the matrix keeps one row of a band for a unit.
 */
jest.setTimeout(240_000);

const MAKER = 1; // u.maker: submits, holds no right to approve
const LEADER_BQLGT = 2;
const LEADER_STC = 3;
const LEADER_UBND_1 = 4;
const LEADER_UBND_2 = 5;
const TARGET = 6; // the person a late task is escalated to: holds the right to decide at a low rank
const PUBLISHER = 7;
const ADMIN = 8;

const A_ROOT = 1;
const A_BQLGT = 2;
const A_XA_AP = 3;
const A_BQLGT_PKT = 4;

const ROLE_BQLGT = 1;
const ROLE_STC = 2;
const ROLE_UBND = 3;
const ROLE_DEPUTY = 4;

const PAYMENT = 'payment.approve';
const REPORT = 'report.accept';
const paymentCommands = { approved: 'approvePaymentRequest', returned: 'returnPaymentRequest', rejected: 'rejectPaymentRequest' };
const reportCommands = { approved: 'acceptReport', returned: 'returnReport', rejected: 'rejectReport' };

const step = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  name: `Bước ${id}`,
  assignee_rule: { type: 'DOA' },
  min_approvals: 1,
  sla_working_hours: 16,
  on_timeout: 'REMIND',
  ...extra,
});
const definitionOf = (steps: unknown[], commands: Record<string, string>): Record<string, unknown> => ({ steps, terminal: commands });

const harness = new AuthzHarness();
const store = new ApprovalStore();
const calendars = new WorkCalendarStore();

const as = <T>(work: (tx: TenantTx) => Promise<T>, member: number): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

const effects = (member: number): ApprovalEffects => ({ actor: memberId(member), audit: () => Promise.resolve(), emit: () => Promise.resolve() });
const accept: FinalCommand = () => Promise.resolve('APPLIED');

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number };
    return { code: e.code ?? '', status: e.status ?? 0 };
  }
  throw new Error('expected a refusal');
}

async function publishDefinition(businessType: string, definition: unknown, now: Date): Promise<void> {
  const draft = await as((tx) => store.createDraft(tx, { businessType, definition }, memberId(ADMIN)), ADMIN);
  await as((tx) => store.publish(tx, draft.id, draft.version, memberId(PUBLISHER), now), PUBLISHER);
}

const startOf = (businessType: string, options: { unit: number; amount: string; now: Date }) =>
  as(
    (tx) =>
      store.start(tx, effects(MAKER), {
        resourceType: 'report',
        resourceId: randomUUID(),
        resourceVersion: 1,
        businessType,
        amountVnd: options.amount,
        unitId: unitId(options.unit),
        initiatorMembershipId: memberId(MAKER),
        now: options.now,
      }),
    MAKER,
  );

const pendingOf = async (instanceId: string): Promise<Array<{ id: string; assignee_id: string; version: string }>> =>
  owner("select id, assignee_id, version::text from machvon.approval_task where workflow_instance_id = $1 and status = 'Pending' order by assignee_id", [instanceId]);
const assigneesOf = async (instanceId: string): Promise<string[]> => (await pendingOf(instanceId)).map((task) => task.assignee_id).sort();
const members = (...people: number[]): string[] => people.map(memberId).sort();

describe('the approval engine on the platform fixture (BR-ADM-03, BR-ADM-04, BR-ADM-08)', () => {
  let matrixV1 = '';
  const since = '2026-01-01T00:00:00Z';

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: A_ROOT, path: `/${unitId(A_ROOT)}/` },
      { n: A_BQLGT, path: `/${unitId(A_ROOT)}/${unitId(A_BQLGT)}/`, parent: A_ROOT },
      { n: A_XA_AP, path: `/${unitId(A_ROOT)}/${unitId(A_XA_AP)}/`, parent: A_ROOT },
      { n: A_BQLGT_PKT, path: `/${unitId(A_ROOT)}/${unitId(A_BQLGT)}/${unitId(A_BQLGT_PKT)}/`, parent: A_BQLGT },
    ]);
    for (const member of [MAKER, LEADER_BQLGT, LEADER_STC, LEADER_UBND_1, LEADER_UBND_2, TARGET, PUBLISHER, ADMIN]) await harness.seedMembership(TENANT_A, member, A_ROOT, { validFrom: since });
    await harness.seedRole(TENANT_A, ROLE_BQLGT, 'LEADER_BQLGT', ['approval.decide'], 50);
    await harness.seedRole(TENANT_A, ROLE_STC, 'LEADER_STC', ['approval.decide'], 60);
    await harness.seedRole(TENANT_A, ROLE_UBND, 'LEADER_UBND', ['approval.decide'], 70);
    await harness.seedRole(TENANT_A, ROLE_DEPUTY, 'DEPUTY', ['approval.decide'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: LEADER_BQLGT, role: ROLE_BQLGT, kind: 'TENANT' },
      { n: 2, member: LEADER_STC, role: ROLE_STC, kind: 'TENANT' },
      { n: 3, member: LEADER_UBND_1, role: ROLE_UBND, kind: 'TENANT' },
      { n: 4, member: LEADER_UBND_2, role: ROLE_UBND, kind: 'TENANT' },
      { n: 5, member: TARGET, role: ROLE_DEPUTY, kind: 'TENANT' },
    ]);
    // DoA v1, Published: payments of A-BQLGT and the units under it go to the leader of the band of the amount; reports of any amount go to the lowest band.
    matrixV1 = randomUUID();
    const rule = (documentType: string, unit: number, min: string, max: string | null, role: number, levels: number, position: number): [string, unknown[]] => [
      `insert into machvon.doa_rule (tenant_id, id, matrix_version_id, document_type, unit_id, include_subtree, amount_min_vnd, amount_max_vnd, approver_role_id, approval_levels, position)
       values ($1, $2, $3, $4, $5, true, $6, $7, $8, $9, $10)`,
      [TENANT_A, randomUUID(), matrixV1, documentType, unitId(unit), min, max, roleId(role), levels, position],
    ];
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.doa_matrix_version (tenant_id, id, revision, status, effective_from, legal_basis_ref, created_by, last_edited_by, version)
         values ($1, $2, 1, 'Draft', date '2020-01-01', 'Internal regulation 12/QD-2026', $3, $3, 1)`,
        [TENANT_A, matrixV1, memberId(ADMIN)],
      ],
      rule('PAYMENT_APPROVE', A_BQLGT, '0', '5000000000', ROLE_BQLGT, 1, 0),
      rule('PAYMENT_APPROVE', A_BQLGT, '5000000000', '20000000000', ROLE_STC, 1, 1),
      rule('PAYMENT_APPROVE', A_BQLGT, '20000000000', null, ROLE_UBND, 2, 2),
      rule('REPORT_ACCEPT', A_ROOT, '0', null, ROLE_BQLGT, 1, 3),
      ["update machvon.doa_matrix_version set status = 'PendingApproval' where id = $1", [matrixV1]],
      ["update machvon.doa_matrix_version set status = 'Published', approved_by = $2, published_at = $3::timestamptz where id = $1", [matrixV1, memberId(PUBLISHER), since]],
    ]);
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  it('UAT-AC126: a payment request under 5,000,000,000 VND goes to the band of LEADER_BQLGT, from that amount to LEADER_STC, and from 20,000,000,000 to LEADER_UBND on two distinct approvers; every instance is pinned to DoA v1', async () => {
    const now = new Date();
    await publishDefinition(PAYMENT, definitionOf([step('treasury')], paymentCommands), now);

    const prA = await startOf(PAYMENT, { unit: A_BQLGT_PKT, amount: '4999999999', now });
    expect(prA).toMatchObject({ status: 'Running', documentType: 'PAYMENT_APPROVE', doaApproverRoleId: roleId(ROLE_BQLGT), doaLevels: 1, doaMatrixVersionId: matrixV1 });
    // The band asks for rank 50: every leader of that rank or above holds the task, the maker does not.
    expect(await assigneesOf(prA.id)).toEqual(members(LEADER_BQLGT, LEADER_STC, LEADER_UBND_1, LEADER_UBND_2));

    const prB = await startOf(PAYMENT, { unit: A_BQLGT_PKT, amount: '5000000000', now });
    expect(prB).toMatchObject({ doaApproverRoleId: roleId(ROLE_STC), doaLevels: 1, doaMatrixVersionId: matrixV1 });
    expect(await assigneesOf(prB.id)).toEqual(members(LEADER_STC, LEADER_UBND_1, LEADER_UBND_2));

    const prC = await startOf(PAYMENT, { unit: A_BQLGT_PKT, amount: '25000000000', now });
    expect(prC).toMatchObject({ doaApproverRoleId: roleId(ROLE_UBND), doaLevels: 2, doaMatrixVersionId: matrixV1 });
    expect(await assigneesOf(prC.id)).toEqual(members(LEADER_UBND_1, LEADER_UBND_2));

    // Two levels, two different people: the first approval leaves the request open for the other leader, and the first leader has nothing left to decide.
    const first = (await pendingOf(prC.id)).find((task) => task.assignee_id === memberId(LEADER_UBND_1));
    const decideAt = new Date(now.getTime() + 2_000);
    await as((tx) => store.decide(tx, effects(LEADER_UBND_1), { taskId: first?.id as string, expectedVersion: Number(first?.version), decision: 'approve', reason: undefined, returnToStep: undefined, now: decideAt, finish: accept }), LEADER_UBND_1);
    expect((await owner<{ status: string }>('select status from machvon.workflow_instance where id = $1', [prC.id]))[0]?.status).toBe('Running');
    expect(await assigneesOf(prC.id)).toEqual(members(LEADER_UBND_2));
    expect(await refusal(as((tx) => store.decide(tx, effects(LEADER_UBND_1), { taskId: first?.id as string, expectedVersion: Number(first?.version) + 1, decision: 'approve', reason: undefined, returnToStep: undefined, now: new Date(decideAt.getTime() + 1_000), finish: accept }), LEADER_UBND_1))).toMatchObject({ status: 409 });
    const second = (await pendingOf(prC.id))[0];
    await as((tx) => store.decide(tx, effects(LEADER_UBND_2), { taskId: second?.id as string, expectedVersion: Number(second?.version), decision: 'approve', reason: undefined, returnToStep: undefined, now: new Date(decideAt.getTime() + 2_000), finish: accept }), LEADER_UBND_2);
    expect((await owner<{ status: string; outcome: string }>('select status, outcome from machvon.workflow_instance where id = $1', [prC.id]))[0]).toEqual({ status: 'Completed', outcome: 'APPROVED' });
    expect(await owner<{ doa_matrix_version_id: string }>('select doa_matrix_version_id from machvon.workflow_instance where id = any($1::uuid[])', [[prA.id, prB.id, prC.id]])).toEqual([
      { doa_matrix_version_id: matrixV1 },
      { doa_matrix_version_id: matrixV1 },
      { doa_matrix_version_id: matrixV1 },
    ]);
  });

  it('a contract change of a commune with no rule in the matrix fails the start with 422 DOA_RULE_NOT_FOUND and writes no instance', async () => {
    const now = new Date();
    await publishDefinition('contract.change', definitionOf([step('legal')], { approved: 'approveContractChange', returned: 'returnContractChange', rejected: 'rejectContractChange' }), now);
    const before = Number((await owner<{ n: string }>('select count(*)::text as n from machvon.workflow_instance'))[0]?.n);
    expect(await refusal(startOf('contract.change', { unit: A_XA_AP, amount: '1000000000', now }))).toEqual({ code: 'DOA_RULE_NOT_FOUND', status: 422 });
    expect(Number((await owner<{ n: string }>('select count(*)::text as n from machvon.workflow_instance'))[0]?.n)).toBe(before);
  });

  it('UAT-AC134: a task made on 29 April 15:00 +07 for 8 working hours falls due on 4 May 15:00 +07, is reminded at 80 percent (13:24) and escalated to the named person at 100 percent', async () => {
    // The calendar of the tenant for 2026: working days Monday to Friday, 30 April and 1 May off.
    const draft = await as((tx) =>
      calendars.createDraft(
        tx,
        {
          calendar_code: 'WORKDAY_VN',
          year: 2026,
          working_days: [1, 2, 3, 4, 5],
          holidays: [
            { date: '2026-04-30', name: 'Reunification Day', legal_basis_ref: 'Labour Code 2019 art. 112' },
            { date: '2026-05-01', name: 'Labour Day', legal_basis_ref: 'Labour Code 2019 art. 112' },
          ],
          compensated_workdays: [],
          legal_basis_ref: 'Labour Code 2019 art. 112; notice 2026',
        },
        memberId(ADMIN),
      ),
    ADMIN);
    await as(async (tx) => calendars.publish(tx, await calendars.lockDraft(tx, draft.id, draft.version), memberId(PUBLISHER)), PUBLISHER);

    const created = new Date('2026-04-29T15:00:00+07:00');
    await publishDefinition(REPORT, definitionOf([step('review', { sla_working_hours: 8, on_timeout: 'ESCALATE', escalate_to: memberId(TARGET) })], reportCommands), created);
    const instance = await startOf(REPORT, { unit: A_ROOT, amount: '1000000', now: created });
    const tasks = await owner<{ id: string; due_at: Date; remind_at: Date }>('select id, due_at, remind_at from machvon.approval_task where workflow_instance_id = $1', [instance.id]);
    // The band of reports asks for rank 50: the four leaders each hold a task, and the clock of every one is the same.
    expect(tasks).toHaveLength(4);
    for (const task of tasks) {
      expect(task.due_at.toISOString()).toBe(new Date('2026-05-04T15:00:00+07:00').toISOString());
      expect(task.remind_at.toISOString()).toBe(new Date('2026-05-04T13:24:00+07:00').toISOString());
    }

    // The timer at 80 percent: one reminder, no escalation. A minute earlier nothing is due.
    expect(await as((tx) => store.sweepSla(tx, effects(MAKER), new Date('2026-05-04T13:23:00+07:00')), MAKER)).toMatchObject({ reminded: 0, escalated: 0 });
    expect(await as((tx) => store.sweepSla(tx, effects(MAKER), new Date('2026-05-04T13:24:00+07:00')), MAKER)).toMatchObject({ reminded: 4, escalated: 0 });
    // The timer at 100 percent: the step names one person to escalate to, and the late tasks of the step give it to them once.
    expect(await as((tx) => store.sweepSla(tx, effects(MAKER), new Date('2026-05-04T15:00:00+07:00')), MAKER)).toMatchObject({ escalated: 1 });
    expect(await assigneesOf(instance.id)).toEqual(members(LEADER_BQLGT, LEADER_STC, LEADER_UBND_1, LEADER_UBND_2, TARGET));
    expect(await owner<{ n: string }>('select count(*)::text as n from machvon.approval_task where workflow_instance_id = $1 and escalated_from_task_id is not null', [instance.id])).toEqual([{ n: '1' }]);
  });

  it('UAT-AC127: the table of rules also refuses two bands of one document type and unit that overlap, whatever the service says', async () => {
    const draft = randomUUID();
    const band = (min: string, max: string | null): [string, unknown[]] => [
      `insert into machvon.doa_rule (tenant_id, id, matrix_version_id, document_type, unit_id, include_subtree, amount_min_vnd, amount_max_vnd, approver_role_id, approval_levels, position)
       values ($1, $2, $3, 'PAYMENT_APPROVE', $4, true, $5, $6, $7, 1, 0)`,
      [TENANT_A, randomUUID(), draft, unitId(A_BQLGT), min, max, roleId(ROLE_BQLGT)],
    ];
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.doa_matrix_version (tenant_id, id, revision, status, effective_from, legal_basis_ref, created_by, last_edited_by, version)
         values ($1, $2, 2, 'Draft', date '2027-01-01', 'Internal regulation 12/QD-2027', $3, $3, 1)`,
        [TENANT_A, draft, memberId(ADMIN)],
      ],
      band('0', '6000000000'),
    ]);
    await expect(harness.owner(TENANT_A, [band('5000000000', '20000000000')])).rejects.toThrow(/doa_rule_no_overlap/);
    expect(Number((await owner<{ n: string }>('select count(*)::text as n from machvon.doa_rule where matrix_version_id = $1', [draft]))[0]?.n)).toBe(1);
  });

  it('the checks of this suite can go red: a check fed the wrong answer throws', () => {
    expectCheckFails(() => expect(members(LEADER_BQLGT)).toEqual(members(LEADER_STC)));
    expectCheckFails(() => expect(new Date('2026-05-04T14:00:00+07:00').toISOString()).toBe(new Date('2026-05-04T15:00:00+07:00').toISOString()));
  });
});
