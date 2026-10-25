import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { addCalendarDays } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import { AuditWriter } from '../src/audit-writer';
import { PayClaimStore } from '../src/pay-claim-store';
import { PayLedgerStore } from '../src/pay-ledger-store';
import { PayPaymentStore } from '../src/pay-payment-store';
import { PayProjectSettlementStore, settlementRefusal } from '../src/pay-project-settlement-store';
import type { CloseSettlementInput, SettlementChange, SettlementView } from '../src/pay-project-settlement-store';
import { PaySettlementDeadlineJob, SETTLEMENT_DEADLINE_EVENT, SETTLEMENT_OVERDUE_EVENT } from '../src/pay-settlement-deadline-job';
import { PaySettlementStore } from '../src/pay-settlement-store';
import type { ContractScopes } from '../src/ctr-contract-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AcceptanceWorld } from './support/acceptance-fixtures';
import { TENANT_A, memberId } from './support/authz-fixtures';

jest.setTimeout(600_000);

const fixtures = new AcceptanceWorld();
const world = fixtures.world;
const settlements = new PayProjectSettlementStore();
const payments = new PayPaymentStore();
const claims = new PayClaimStore();
const treasury = new PaySettlementStore();
const ledgers = new PayLedgerStore();

// The people of the settlement: OPENER prepared it, SENDER sent the payments, VERIFIER verifies, EXCEPTION_APPROVER and CLOSER decide.
const OPENER = 1;
const SENDER = 2;
const VERIFIER = 3;
const MATCHER = 4;
const EXCEPTION_APPROVER = 6;
const CLOSER = 7;
const SETTLER = 8;
/** Noon in Vietnam on 26 October 2026. */
const NOW = new Date('2026-10-26T05:00:00Z');
const TODAY = '2026-10-26';
const SUBMITTED_ON = '2026-10-01';
const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });
const nothing: ScopeBuilder = () => ({ sql: 'false', params: [] });
const allContracts: ContractScopes = { update: everything, read: everything };

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = OPENER): Promise<T> => fixtures.as(work, member);
const owner = fixtures.owner.bind(fixtures);

interface Refusal {
  code: string;
  status: number;
  detail?: string;
  extensions?: Record<string, unknown>;
}

async function refusal(work: Promise<unknown>): Promise<Refusal> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

/** The error the database raised, as it came. */
async function raised(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error('expected the database to refuse');
}

async function databaseRefusal(work: Promise<unknown>): Promise<{ message: string; sqlstate: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { message: string; code?: string };
    return { message: e.message, sqlstate: e.code ?? '' };
  }
  throw new Error('expected the database to refuse');
}

/** Runs a statement as the superuser with the triggers off: the way the tests put a row in a state that only a clock or another story could. */
async function admin(sql: string, params: unknown[] = []): Promise<void> {
  const client = new Client({ connectionString: world.harness.database.adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    await client.query(sql, params);
  } finally {
    await client.end();
  }
}

// ---- the world ------------------------------------------------------------------------------------------------------------------------------------------------------------------

let counter = 0;

/** A project of its own, in the status and the group asked for, with a line of capital: a settlement of it does not meet the settlements of another test. */
async function project(options: { status?: string; group?: string } = {}): Promise<{ projectId: string; lineId: string }> {
  const line = await world.publishedLine({ allocated: '10000000000000', appropriationAmount: '20000000000000', group: options.group ?? 'B' });
  await admin('update machvon.project set status = $2, project_group = $3 where id = $1::uuid', [line.projectId, options.status ?? 'COMPLETED', options.group ?? 'B']);
  return { projectId: line.projectId, lineId: line.lineId };
}

/** The settlement of a whole project that is complete, opened by OPENER. */
async function opened(target: { projectId: string }, extra: Partial<{ contractId: string; scope: string; fiscalYear: number }> = {}): Promise<SettlementView> {
  const done = await as((tx) => settlements.open(tx, { projectId: target.projectId, scope: extra.scope ?? 'PROJECT', ...(extra.contractId === undefined ? {} : { contractId: extra.contractId }), ...(extra.fiscalYear === undefined ? {} : { fiscalYear: extra.fiscalYear }) }, memberId(OPENER), everything));
  return done.view;
}

const submit = (view: { id: string; version: number }, submittedOn = SUBMITTED_ON, member = SENDER, now = NOW) =>
  as((tx) => settlements.submit(tx, view.id, view.version, { submittedOn }, memberId(member), everything, now), member);
const verify = (view: { id: string; version: number }, outcome: string, member = VERIFIER, extra: { findings?: string; refs?: string[] } = {}) =>
  as(
    (tx) => settlements.verify(tx, view.id, view.version, { outcome, findings: extra.findings ?? 'The figures agree with the ledgers.', ...(extra.refs === undefined ? {} : { auditFindingRefs: extra.refs }) }, memberId(member), everything, NOW),
    member,
  );
const approveException = (view: { id: string; version: number }, input: { reason?: string; document?: string | undefined } = {}, member = EXCEPTION_APPROVER) =>
  as((tx) => settlements.approveException(tx, view.id, view.version, { reason: input.reason ?? 'The debt waits for the warranty guarantee.', approvalDocumentVersionId: 'document' in input ? input.document : undefined }, memberId(member), everything, NOW), member);
const close = (view: { id: string; version: number }, input: Partial<CloseSettlementInput> = {}, member = CLOSER) =>
  as((tx) => settlements.close(tx, view.id, view.version, { decision: 'approve', reason: 'Approved by the decision.', evidenceIds: [], decisionDocumentVersionId: undefined, ...input }, memberId(member), everything, NOW), member);
const refresh = (view: { id: string; version: number }, note?: string) => as((tx) => settlements.refresh(tx, view.id, view.version, note, memberId(OPENER), everything));
const reload = async (id: string): Promise<SettlementView> => {
  const found = await as((tx) => settlements.find(tx, everything, id));
  if (found === undefined) throw new Error('no such settlement');
  return found;
};
const next = (change: SettlementChange): SettlementView => change.view;

/** A settlement that was sent and taken up and verified, owing what the project owes. */
async function verifiedSettlement(target: { projectId: string }, extra: Partial<{ contractId: string; scope: string }> = {}): Promise<SettlementView> {
  const draft = await opened(target, extra);
  const sent = next(await submit(draft));
  const taken = next(await verify(sent, 'VERIFYING'));
  return next(await verify(taken, 'VERIFIED'));
}

/** An acceptance that was approved and recognised on the ledger of its contract, as the consumer of the approval does. */
async function acceptAndRecognise(contract: Awaited<ReturnType<typeof fixtures.seedContract>>, measurements: Parameters<typeof fixtures.approve>[1]): Promise<void> {
  const approved = await fixtures.approve(contract, measurements);
  await as((tx) => ledgers.recognize(tx, { acceptanceId: approved.acceptance.id, requestId: randomUUID(), actor: memberId(OPENER) }));
}

// ---- a payment of 3bn that was settled: gross 3bn, advance recovery 750m, retention 150m, net 2.1bn ---------------------------------------------------------------------------

async function paidContract(): Promise<{ contractId: string }> {
  counter += 1;
  const contract = await fixtures.seedContract();
  await owner('update machvon.contract_party set work_value_vnd = 10000000000 where contract_id = $1::uuid', [contract.contractId]);
  await owner('update machvon.contract set advance_paid_vnd = 2000000000 where id = $1::uuid', [contract.contractId]);
  const advanceId = randomUUID();
  await owner(
    `insert into machvon.contract_advance (tenant_id, id, contract_id, party_id, tranche_no, kind, amount_vnd, cap_vnd, status, paid_vnd, paid_on, recovery_threshold_pct, recovery_deadline, created_by, updated_by)
     values ($1, $5::uuid, $2::uuid, $3::uuid, 1, 'GPMB', 2000000000, 2000000000, 'PAID', 2000000000, date '2026-06-01', 80, date '2026-12-31', $4::uuid, $4::uuid)`,
    [TENANT_A, contract.contractId, contract.partyId, memberId(OPENER), advanceId],
  );
  // The journal of the advance: the money went out on 1 June (the fixture sets the tranche as paid without the entry that records it).
  await admin(
    `insert into machvon.advance_ledger_entry (tenant_id, id, contract_id, payment_request_id, entry_kind, amount_vnd, posted_at, advance_id, party_id, outstanding_after_vnd, request_id)
     values ($1, gen_random_uuid(), $2::uuid, null, 'DISBURSE', 2000000000, timestamptz '2026-06-01T03:00:00Z', $3::uuid, $4::uuid, 2000000000, gen_random_uuid())`,
    [TENANT_A, contract.contractId, advanceId, contract.partyId],
  );
  const approved = await fixtures.approve(contract, [
    { item: 0, quantity: '2000' },
    { item: 1, quantity: '500' },
  ]);
  const made = await as((tx) =>
    payments.create(tx, { contractId: contract.contractId, requestKind: 'INTERIM', acceptanceId: approved.acceptance.id, allocationLineId: fixtures.lineId, requestNo: `DNTT-S-${counter}-${randomUUID().slice(0, 6)}` }, memberId(OPENER), allContracts, '2026-07-25'),
  );
  const document = await fixtures.documentVersion();
  await as((tx) => payments.attachDocument(tx, made.id, { documentVersionId: document.id, docKind: 'INVOICE', invoiceNo: `HD-S-${counter}-${randomUUID().slice(0, 6)}`, invoiceDate: '2026-07-01' }, memberId(OPENER), allContracts, { mayOverride: () => false }));
  const sent = await as((tx) => claims.submit(tx, made.id, made.version, { expectedGrossVnd: made.grossVnd, expectedNetVnd: made.netVnd, requestId: randomUUID() }, memberId(SENDER), allContracts, '2026-07-25'), SENDER);
  await as((tx) => claims.verify(tx, made.id, sent.version, undefined, memberId(VERIFIER), allContracts), VERIFIER);
  await fixtures.sendToTreasury(made.id);
  const transactionId = randomUUID();
  await owner(
    `insert into machvon.treasury_transaction
       (tenant_id, id, project_id, external_id, provider, amount_vnd, confirmed_at, source_hash, row_hash, direction, document_no, document_date, source_kind, provider_event_id, match_status)
     values ($1, $2::uuid, $3::uuid, $4, 'MOCKKB', 2100000000, timestamptz '2026-07-24T18:30:00Z', repeat('a', 64), repeat('a', 64), 'PAYMENT', $4, date '2026-07-30', 'CALLBACK_MOCK', $5, 'UNMATCHED')`,
    [TENANT_A, transactionId, fixtures.projectId, `CT-S-${counter}`, `EVT-S-${counter}`],
  );
  const done = await as((tx) => treasury.match(tx, { transactionId, paymentRequestId: made.id, actor: memberId(MATCHER), requestId: randomUUID(), scopes: allContracts, now: new Date('2026-07-25T05:00:00Z') }), MATCHER);
  if (done.kind !== 'SETTLED') throw new Error('the fixture was not settled');
  return { contractId: contract.contractId };
}

const audit = new AuditWriter(world.harness.tenants);
const gauges: Array<{ name: string; value: number }> = [];
const metrics: MetricsSink = { increment: () => undefined, gauge: (name, value) => void gauges.push({ name, value }) };
const deadlines = new PaySettlementDeadlineJob(audit, metrics);

describe('the settlement of a project, a year or a contract (ST-PAY-009)', () => {
  beforeAll(async () => {
    await fixtures.start();
    for (const member of [MATCHER, EXCEPTION_APPROVER, CLOSER, SETTLER]) await fixtures.harness.seedMembership(TENANT_A, member, 1);
  });
  afterAll(() => fixtures.stop(), 60_000);

  describe('opening a settlement and reading its figures from the ledgers (AC-ST-PAY-009-3, UAT-PLAN-21)', () => {
    it('opens a draft for a project that is complete, with the figures of the ledgers, and refuses a second one while it is worked on', async () => {
      const target = await project();
      const view = await opened(target);
      expect(view).toMatchObject({
        projectId: target.projectId,
        contractId: null,
        scope: 'PROJECT',
        fiscalYear: null,
        revision: 1,
        status: 'DRAFT',
        settledAmountVnd: '0',
        outstandingVnd: '0',
        unrecoveredAdvanceVnd: '0',
        submittedOn: null,
        verificationDueOn: null,
        supersedesId: null,
        createdBy: memberId(OPENER),
        version: 1,
      });
      expect(await refusal(as((tx) => settlements.open(tx, { projectId: target.projectId, scope: 'PROJECT' }, memberId(OPENER), everything)))).toMatchObject({
        code: 'SETTLEMENT_OPEN_EXISTS',
        status: 409,
        extensions: { settlement_id: view.id, status: 'DRAFT', revision: 1 },
      });
      // A settlement of another scope of the same project is another settlement.
      const annual = await opened(target, { scope: 'ANNUAL', fiscalYear: 2026 });
      expect(annual).toMatchObject({ scope: 'ANNUAL', fiscalYear: 2026, revision: 1 });
    });

    it('asks for what the scope needs and refuses what it does not take, a project that is not at the stage, and a project or a contract the caller does not reach', async () => {
      const target = await project();
      const open = (input: { projectId?: string; scope: string; contractId?: string; fiscalYear?: number }, scope: ScopeBuilder = everything) =>
        as((tx) => settlements.open(tx, { projectId: target.projectId, ...input }, memberId(OPENER), scope));
      expect(await refusal(open({ scope: 'CONTRACT' }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'contract_id', extensions: { reason: 'REQUIRED_FOR_SCOPE' } });
      expect(await refusal(open({ scope: 'PROJECT', contractId: randomUUID() }))).toMatchObject({ detail: 'contract_id', extensions: { reason: 'NOT_FOR_SCOPE' } });
      expect(await refusal(open({ scope: 'ANNUAL' }))).toMatchObject({ detail: 'fiscal_year', extensions: { reason: 'REQUIRED_FOR_SCOPE' } });
      expect(await refusal(open({ scope: 'PROJECT', fiscalYear: 2026 }))).toMatchObject({ detail: 'fiscal_year', extensions: { reason: 'NOT_FOR_SCOPE' } });
      expect(await refusal(open({ scope: 'ANNUAL', fiscalYear: 1999 }))).toMatchObject({ detail: 'fiscal_year', extensions: { reason: 'OUT_OF_RANGE' } });
      expect(await refusal(open({ scope: 'FOREVER' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'settlement_scope' });
      expect(await refusal(open({ projectId: 'not-an-id', scope: 'PROJECT' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'project_id' });
      expect(await refusal(open({ scope: 'CONTRACT', contractId: randomUUID() }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'contract_id', extensions: { reason: 'NOT_IN_PROJECT' } });
      expect(await refusal(open({ scope: 'PROJECT' }, nothing))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      // The settlement of the whole project is made when the project is complete; a year or a contract while it is being built or after it was stopped.
      const building = await project({ status: 'IMPLEMENTATION' });
      expect(await refusal(as((tx) => settlements.open(tx, { projectId: building.projectId, scope: 'PROJECT' }, memberId(OPENER), everything)))).toMatchObject({
        code: 'PROJECT_STAGE_INVALID',
        status: 422,
        extensions: { project_status: 'IMPLEMENTATION', settlement_scope: 'PROJECT' },
      });
      expect((await opened(building, { scope: 'ANNUAL', fiscalYear: 2026 })).status).toBe('DRAFT');
      const planned = await project({ status: 'BUDGETED' });
      expect(await refusal(as((tx) => settlements.open(tx, { projectId: planned.projectId, scope: 'ANNUAL', fiscalYear: 2026 }, memberId(OPENER), everything)))).toMatchObject({ code: 'PROJECT_STAGE_INVALID' });
    });

    it('reads the accepted work, the payment, the retention and the advance of the contracts: owed is accepted less paid plus the retention held, unrecovered is the advance paid less recovered', async () => {
      const target = { projectId: fixtures.projectId };
      await admin('update machvon.project set status = $2, project_group = $3 where id = $1::uuid', [fixtures.projectId, 'COMPLETED', 'B']);
      const paid = await paidContract();
      // The second contract of the project has accepted work and nothing paid.
      const idle = await fixtures.seedContract();
      await acceptAndRecognise(idle, [{ item: 0, quantity: '100' }]);

      const forContract = await opened(target, { scope: 'CONTRACT', contractId: paid.contractId });
      expect(forContract).toMatchObject({ scope: 'CONTRACT', contractId: paid.contractId, settledAmountVnd: '3000000000', outstandingVnd: '150000000', unrecoveredAdvanceVnd: '1250000000' });
      const accepted = (await owner<{ accepted: string }>('select coalesce(sum(accepted_vnd), 0)::text as accepted from machvon.cumulative_ledger where contract_id = $1::uuid', [idle.contractId]))[0]?.accepted ?? '0';
      expect(BigInt(accepted)).toBeGreaterThan(0n);
      const whole = await opened(target);
      expect(whole).toMatchObject({ scope: 'PROJECT', settledAmountVnd: '3000000000', outstandingVnd: (150000000n + BigInt(accepted)).toString(), unrecoveredAdvanceVnd: '1250000000' });
      expect(await refusal(as((tx) => settlements.open(tx, { projectId: fixtures.projectId, scope: 'CONTRACT', contractId: paid.contractId }, memberId(OPENER), everything)))).toMatchObject({ code: 'SETTLEMENT_OPEN_EXISTS' });
    });

    it('reads a year the way the year saw it: what was paid in it, and what was owed and unrecovered at its end', async () => {
      const paid = await paidContract();
      // The payment was made in 2025 and the retention is still held at the end of 2026.
      await admin("update machvon.cumulative_ledger_entry set posted_at = timestamptz '2025-07-25T03:00:00Z' where contract_id = $1::uuid", [paid.contractId]);
      await admin("update machvon.advance_ledger_entry set posted_at = timestamptz '2025-07-25T03:00:00Z' where contract_id = $1::uuid", [paid.contractId]);
      const figuresOf = (year: number) => as((tx) => settlements.figuresOf(tx, fixtures.projectId, paid.contractId, 'ANNUAL', year));
      expect(await figuresOf(2025)).toEqual({ settledVnd: '3000000000', outstandingVnd: '150000000', unrecoveredAdvanceVnd: '1250000000' });
      expect(await figuresOf(2026)).toEqual({ settledVnd: '0', outstandingVnd: '150000000', unrecoveredAdvanceVnd: '1250000000' });
      // Before anything was posted nothing was owed.
      expect(await figuresOf(2024)).toEqual({ settledVnd: '0', outstandingVnd: '0', unrecoveredAdvanceVnd: '0' });
    });

    it('reads the figures again while the settlement is a draft, and gives a returned one back as a draft; any other state is 409', async () => {
      const target = await project();
      const draft = await opened(target);
      const contract = await fixtures.seedContract({ projectId: target.projectId, lineId: target.lineId });
      await acceptAndRecognise(contract, [{ item: 0, quantity: '100' }]);
      const again = next(await refresh(draft, 'After the acceptance of July.'));
      expect(BigInt(again.outstandingVnd)).toBeGreaterThan(0n);
      expect(again).toMatchObject({ status: 'DRAFT', figuresNote: 'After the acceptance of July.', version: draft.version + 1 });
      expect(again.figuresRefreshedAt >= draft.figuresRefreshedAt).toBe(true);
      expect(await refusal(refresh(draft))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(as((tx) => settlements.refresh(tx, again.id, again.version, '   ', memberId(OPENER), everything)))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'note' });

      const sent = next(await submit(again));
      expect(await refusal(refresh(sent))).toMatchObject({ code: 'SETTLEMENT_STATE_INVALID', status: 409, extensions: { status: 'SUBMITTED' } });
      const returned = next(await verify(sent, 'RETURNED'));
      const back = next(await refresh(returned));
      expect(back).toMatchObject({ status: 'DRAFT', submittedOn: null, submittedBy: null, projectGroup: null, verificationDueOn: null, deadlineDays: null, deadlineRuleVersionId: null });
    });
  });

  describe('the verification deadline by project group (AC-ST-PAY-009-1, UAT-AC339)', () => {
    it('is the day of the submission plus the days of the group, kept with the rule version that gave them, and a later change of the rule does not move it', async () => {
      for (const [group, days] of [['QTQG', 270], ['A', 270], ['B', 180], ['C', 120]] as const) {
        const target = await project({ group });
        const sent = await submit(await opened(target));
        expect(sent.fromStatus).toBe('DRAFT');
        expect(sent.deadline).toMatchObject({ days, awaitingConfirmation: true });
        expect(sent.view).toMatchObject({
          status: 'SUBMITTED',
          projectGroup: group,
          submittedOn: SUBMITTED_ON,
          submittedBy: memberId(SENDER),
          deadlineDays: days,
          verificationDueOn: addCalendarDays(SUBMITTED_ON, days),
          deadlineRuleVersionId: sent.deadline?.ruleVersionId,
          deadlineRuleAwaitingConfirmation: true,
        });
      }
      const target = await project({ group: 'B' });
      const sent = next(await submit(await opened(target)));
      expect(sent.verificationDueOn).toBe('2027-03-30');
      // The rule changes afterwards (a new count of days on the same version of the fixture): the deadline that was given stays.
      await admin(
        `update machvon.master_record_version set attributes = jsonb_set(attributes, '{days_by_group}', '[{"project_group":"QTQG","days":10},{"project_group":"A","days":10},{"project_group":"B","days":10},{"project_group":"C","days":10}]'::jsonb)
          where id = $1::uuid`,
        [sent.deadlineRuleVersionId],
      );
      expect(await reload(sent.id)).toMatchObject({ verificationDueOn: '2027-03-30', deadlineDays: 180, deadlineRuleVersionId: sent.deadlineRuleVersionId });
      await admin(
        `update machvon.master_record_version set attributes = jsonb_set(attributes, '{days_by_group}', '[{"project_group":"QTQG","days":270},{"project_group":"A","days":270},{"project_group":"B","days":180},{"project_group":"C","days":120}]'::jsonb)
          where id = $1::uuid`,
        [sent.deadlineRuleVersionId],
      );
    });

    it('refuses a project with no group, a rule that is not in force or has no row for the group, a day that is not a day or is to come, and a settlement that was sent', async () => {
      // A project that is past its concept has a group (the table holds it); one that was stopped may have lost it, and a settlement of it cannot be sent.
      const noGroup = await project();
      const orphan = await opened(noGroup);
      await admin("update machvon.project set status = 'CANCELLED', project_group = null where id = $1::uuid", [noGroup.projectId]);
      expect(await refusal(submit(orphan))).toMatchObject({ code: 'PROJECT_GROUP_MISSING', status: 422, extensions: { project_id: noGroup.projectId } });

      const target = await project({ group: 'C' });
      const draft = await opened(target);
      for (const [day, reason] of [['2026-10-27', 'IN_THE_FUTURE']] as const) {
        expect(await refusal(submit(draft, day))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'submitted_on', extensions: { reason } });
      }
      expect(await refusal(submit(draft, '2026-02-30'))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'submitted_on' });
      expect(await refusal(submit(draft, 'yesterday'))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'submitted_on' });

      // The rule is switched off: no version of it is in force on the day of the submission.
      const [rule] = await owner<{ id: string }>(
        `select v.id from machvon.master_record_version v join machvon.master_record r on r.id = v.master_record_id where r.master_type = 'PAY_SETTLEMENT_DEADLINE' and r.business_key = 'VERIFY_DEADLINE' order by v.revision desc limit 1`,
      );
      await admin('update machvon.master_record_version set valid_until = valid_from + 1 where id = $1::uuid', [rule?.id]);
      expect(await refusal(submit(draft))).toMatchObject({ code: 'DEADLINE_RULE_UNCONFIRMED', status: 422, extensions: { reason: 'NO_RULE', project_group: 'C', submitted_on: SUBMITTED_ON } });
      await admin('update machvon.master_record_version set valid_until = null where id = $1::uuid', [rule?.id]);

      // The rule is in force and knows no row for the group.
      await admin(`update machvon.master_record_version set attributes = jsonb_set(attributes, '{days_by_group}', '[{"project_group":"A","days":270}]'::jsonb) where id = $1::uuid`, [rule?.id]);
      expect(await refusal(submit(draft))).toMatchObject({ code: 'DEADLINE_RULE_UNCONFIRMED', extensions: { reason: 'NO_ROW_FOR_GROUP', project_group: 'C', deadline_rule_version_id: rule?.id } });
      await admin(
        `update machvon.master_record_version set attributes = jsonb_set(attributes, '{days_by_group}', '[{"project_group":"QTQG","days":270},{"project_group":"A","days":270},{"project_group":"B","days":180},{"project_group":"C","days":120}]'::jsonb) where id = $1::uuid`,
        [rule?.id],
      );

      const sent = next(await submit(draft));
      expect(sent.verificationDueOn).toBe(addCalendarDays(SUBMITTED_ON, 120));
      expect(await refusal(submit(sent))).toMatchObject({ code: 'SETTLEMENT_STATE_INVALID', status: 409 });
    });
  });

  describe('verification (UAT-AC339 step 4, BR-PAY-16)', () => {
    it('takes the file up, verifies it or gives it back with the findings, by someone other than who sent it', async () => {
      const target = await project();
      const sent = next(await submit(await opened(target)));
      expect(await refusal(verify(sent, 'VERIFIED'))).toMatchObject({ code: 'SETTLEMENT_STATE_INVALID', status: 409 });
      expect(await refusal(verify(sent, 'VERIFYING', SENDER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(verify(sent, 'PASSED'))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'outcome' });
      expect(await refusal(as((tx) => settlements.verify(tx, sent.id, sent.version, { outcome: 'VERIFYING', findings: ' ' }, memberId(VERIFIER), everything, NOW), VERIFIER))).toMatchObject({ detail: 'findings' });
      expect(await refusal(verify(sent, 'VERIFYING', VERIFIER, { refs: ['nope'] }))).toMatchObject({ detail: 'audit_finding_refs' });
      expect(await refusal(verify(sent, 'VERIFYING', VERIFIER, { refs: Array.from({ length: 51 }, () => randomUUID()) }))).toMatchObject({ detail: 'audit_finding_refs', extensions: { reason: 'TOO_MANY' } });

      const taken = next(await verify(sent, 'VERIFYING'));
      expect(taken).toMatchObject({ status: 'VERIFYING', verificationFindings: 'The figures agree with the ledgers.', verifiedBy: null });
      const refs = [randomUUID(), randomUUID()];
      const done = next(await verify(taken, 'VERIFIED', VERIFIER, { refs, findings: 'No finding.' }));
      expect(done).toMatchObject({ status: 'VERIFIED', verifiedBy: memberId(VERIFIER), verifiedOn: TODAY, verificationFindings: 'No finding.', auditFindingRefs: refs });
      expect(await refusal(verify(done, 'RETURNED'))).toMatchObject({ code: 'SETTLEMENT_STATE_INVALID' });
    });

    it('gives a file back before or after it is taken up, and a returned settlement is read again and sent again with a deadline of its own', async () => {
      const target = await project({ group: 'A' });
      const sent = next(await submit(await opened(target)));
      const returned = next(await verify(sent, 'RETURNED', VERIFIER, { findings: 'The report of the auditors is missing.' }));
      expect(returned).toMatchObject({ status: 'RETURNED', verificationFindings: 'The report of the auditors is missing.', verifiedBy: null, submittedOn: SUBMITTED_ON });
      expect(await refusal(verify(returned, 'VERIFYING'))).toMatchObject({ code: 'SETTLEMENT_STATE_INVALID' });
      // A returned settlement can be sent again without being read again; the deadline runs from the new day.
      const again = next(await submit(returned, '2026-10-10'));
      expect(again).toMatchObject({ status: 'SUBMITTED', submittedOn: '2026-10-10', verificationDueOn: addCalendarDays('2026-10-10', 270) });
      const taken = next(await verify(again, 'VERIFYING'));
      expect(next(await verify(taken, 'RETURNED')).status).toBe('RETURNED');
    });
  });

  describe('the exception and the close of a settlement that still owes (AC-ST-PAY-009-2, UAT-AC66)', () => {
    it('closes only with the exception that someone else approved, and keeps the figures as they are', async () => {
      const target = { projectId: fixtures.projectId };
      const paid = await paidContract();
      const verified = await verifiedSettlement(target, { scope: 'CONTRACT', contractId: paid.contractId });
      expect(verified).toMatchObject({ status: 'VERIFIED', settledAmountVnd: '3000000000', outstandingVnd: '150000000', unrecoveredAdvanceVnd: '1250000000' });
      const decision = (await fixtures.documentVersion()).id;
      const paper = (await fixtures.documentVersion()).id;

      // 1: closing with something owed and no exception, with the decision in hand.
      expect(await refusal(close(verified, { decisionDocumentVersionId: decision }))).toMatchObject({
        code: 'SETTLEMENT_HAS_OUTSTANDING',
        status: 422,
        extensions: { outstanding_vnd: '150000000', unrecovered_advance_vnd: '1250000000' },
      });
      // 2: the person who opened it cannot approve the exception, nor can the one who sent it.
      expect(await refusal(approveException(verified, { document: paper }, OPENER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(approveException(verified, { document: paper }, SENDER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
      // The reason and the document are asked for.
      expect(await refusal(approveException(verified, { reason: ' ', document: paper }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason' });
      expect(await refusal(approveException(verified, {}))).toMatchObject({ code: 'APPROVAL_REQUIRED', status: 422 });
      expect(await refusal(approveException(verified, { document: randomUUID() }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'approval_document_version_id', extensions: { reason: 'NOT_FOUND' } });
      const infected = (await fixtures.documentVersion('INFECTED')).id;
      expect(await refusal(approveException(verified, { document: infected }))).toMatchObject({ code: 'DOCUMENT_NOT_CLEAN' });
      // 3: someone else approves it.
      const excepted = next(await approveException(verified, { reason: 'Công nợ chờ bảo lãnh bảo hành theo biên bản 05/BB', document: paper }));
      expect(excepted).toMatchObject({
        status: 'VERIFIED',
        exceptionReason: 'Công nợ chờ bảo lãnh bảo hành theo biên bản 05/BB',
        exceptionApprovedBy: memberId(EXCEPTION_APPROVER),
        exceptionApprovalDocumentVersionId: paper,
        outstandingVnd: '150000000',
      });
      expect(await refusal(approveException(excepted, { document: paper }))).toMatchObject({ code: 'SETTLEMENT_STATE_INVALID', extensions: { reason: 'EXCEPTION_ALREADY_APPROVED' } });

      // 4: the close. It asks for the decision, for the approve decision, and for someone who did not prepare the settlement.
      expect(await refusal(close(excepted, { decision: 'reject', decisionDocumentVersionId: decision }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'decision' });
      expect(await refusal(close(excepted, {}))).toMatchObject({ code: 'DECISION_DOCUMENT_REQUIRED', status: 422 });
      expect(await refusal(close(excepted, { decisionDocumentVersionId: decision, reason: ' ' }))).toMatchObject({ detail: 'reason' });
      expect(await refusal(close(excepted, { decisionDocumentVersionId: decision }, OPENER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(close(excepted, { decisionDocumentVersionId: decision, evidenceIds: ['nope'] }))).toMatchObject({ detail: 'evidence_ids' });
      expect(await refusal(close(excepted, { decisionDocumentVersionId: decision, evidenceIds: [randomUUID()] }))).toMatchObject({ detail: 'evidence_ids', extensions: { reason: 'NOT_FOUND' } });
      expect(await refusal(close(excepted, { decisionDocumentVersionId: decision, evidenceIds: [infected] }))).toMatchObject({ code: 'DOCUMENT_NOT_CLEAN' });
      const evidence = (await fixtures.documentVersion()).id;
      const closed = next(await close(excepted, { decisionDocumentVersionId: decision, evidenceIds: [evidence, evidence], reason: 'Approved by decision 10/QTDA.' }));
      expect(closed).toMatchObject({
        status: 'CLOSED',
        settledAmountVnd: '3000000000',
        outstandingVnd: '150000000',
        unrecoveredAdvanceVnd: '1250000000',
        decisionDocumentVersionId: decision,
        closedBy: memberId(CLOSER),
        closeReason: 'Approved by decision 10/QTDA.',
        closeEvidenceIds: [evidence],
        exceptionApprovedBy: memberId(EXCEPTION_APPROVER),
      });
      expect(closed.closedAt).not.toBeNull();
      expect(await refusal(close(closed, { decisionDocumentVersionId: decision }))).toMatchObject({ code: 'SETTLEMENT_STATE_INVALID' });
    });

    it('closes without an exception when nothing is owed, and asks for none then', async () => {
      const target = await project();
      const verified = await verifiedSettlement(target);
      expect(verified).toMatchObject({ outstandingVnd: '0', unrecoveredAdvanceVnd: '0' });
      const paper = (await fixtures.documentVersion()).id;
      expect(await refusal(approveException(verified, { document: paper }))).toMatchObject({ code: 'NO_OUTSTANDING_TO_EXCEPT', status: 422 });
      const decision = (await fixtures.documentVersion()).id;
      expect(next(await close(verified, { decisionDocumentVersionId: decision })).status).toBe('CLOSED');
    });

    it('closes only a verified settlement, and the next revision supersedes a closed one', async () => {
      const target = await project();
      const draft = await opened(target);
      const decision = (await fixtures.documentVersion()).id;
      expect(await refusal(close(draft, { decisionDocumentVersionId: decision }))).toMatchObject({ code: 'SETTLEMENT_STATE_INVALID', extensions: { status: 'DRAFT' } });
      expect(await refusal(approveException(draft, { document: decision }))).toMatchObject({ code: 'SETTLEMENT_STATE_INVALID' });
      const sent = next(await submit(draft));
      const taken = next(await verify(sent, 'VERIFYING'));
      const verified = next(await verify(taken, 'VERIFIED'));
      const closed = next(await close(verified, { decisionDocumentVersionId: decision }));
      const second = await opened(target);
      expect(second).toMatchObject({ revision: 2, status: 'DRAFT', supersedesId: closed.id });
      expect(await reload(closed.id)).toMatchObject({ status: 'SUPERSEDED' });
    });
  });

  describe('reading the settlements', () => {
    it('lists the settlements in the scope of the caller, newest first, by status and project, and pages them', async () => {
      const target = await project();
      const one = await opened(target);
      const two = await opened(target, { scope: 'ANNUAL', fiscalYear: 2030 });
      const three = await opened(target, { scope: 'ANNUAL', fiscalYear: 2031 });
      const list = (filter: { status?: string; projectId?: string; limit?: number; after?: { code: string; id: string } }, scope: ScopeBuilder = everything) =>
        as((tx) => settlements.list(tx, scope, { limit: 10, ...filter }));
      expect((await list({ projectId: target.projectId })).map((row) => row.id)).toEqual([three.id, two.id, one.id]);
      expect((await list({ projectId: target.projectId, status: 'SUBMITTED' })).map((row) => row.id)).toEqual([]);
      expect((await list({ projectId: target.projectId, status: 'DRAFT' })).length).toBe(3);
      expect(await list({ projectId: target.projectId }, nothing)).toEqual([]);
      const firstPage = await list({ projectId: target.projectId, limit: 2 });
      const last = firstPage[1];
      expect(firstPage.map((row) => row.id)).toEqual([three.id, two.id]);
      const secondPage = await list({ projectId: target.projectId, limit: 2, after: { code: (await owner<{ key: string }>(`select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as key from machvon.settlement_revision where id = $1::uuid`, [last?.id]))[0]?.key ?? '', id: last?.id ?? '' } });
      expect(secondPage.map((row) => row.id)).toEqual([one.id]);
      expect(await refusal(list({ status: 'DONE' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'status' });
      expect(await refusal(list({ projectId: 'x' }))).toMatchObject({ detail: 'project_id' });
      expect(await refusal(list({ limit: 0 }))).toMatchObject({ detail: 'limit' });
      expect(await refusal(list({ after: { code: 'not a time', id: randomUUID() } }))).toMatchObject({ detail: 'cursor' });
      expect((await as((tx) => settlements.find(tx, everything, one.id)))?.projectCode).toBe(one.projectCode);
      expect(await as((tx) => settlements.find(tx, nothing, one.id))).toBeUndefined();
      expect(await as((tx) => settlements.find(tx, everything, randomUUID()))).toBeUndefined();
      expect(await refusal(as((tx) => settlements.refresh(tx, randomUUID(), 1, undefined, memberId(OPENER), everything)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });
  });

  describe('what the database holds (V1569)', () => {
    it('keeps one settlement being worked, the moves of the status, the figures and the deadline of a settlement that was sent, and who may verify and close', async () => {
      const target = await project();
      const draft = await opened(target);
      const sent = next(await submit(draft));
      const update = (sql: string, params: unknown[] = []) => owner(`update machvon.settlement_revision set ${sql} where id = $1::uuid`, [sent.id, ...params]);
      expect((await databaseRefusal(update('settled_amount_vnd = 5'))).message).toContain('SETTLEMENT_STATE_INVALID');
      expect((await databaseRefusal(update("verification_due_on = date '2030-01-01'"))).message).toContain('SETTLEMENT_STATE_INVALID');
      expect((await databaseRefusal(update("status = 'VERIFIED'"))).message).toContain('SETTLEMENT_STATE_INVALID');
      expect((await databaseRefusal(update("status = 'DRAFT'"))).message).toContain('SETTLEMENT_STATE_INVALID');
      expect((await databaseRefusal(update("settlement_scope = 'ANNUAL', fiscal_year = 2026"))).message).toContain('never changes');
      expect((await databaseRefusal(update('verified_by = submitted_by, status = $2', ['VERIFYING']))).sqlstate).toBe('23514');
      // A second settlement being worked for the same project and scope, however it is written.
      expect((await databaseRefusal(owner(`insert into machvon.settlement_revision (tenant_id, id, project_id, revision, settled_amount_vnd, outstanding_vnd, unrecovered_advance_vnd, status) values ($1, gen_random_uuid(), $2::uuid, 9, 0, 0, 0, 'DRAFT')`, [TENANT_A, target.projectId]))).sqlstate).toBe('23505');
      expect((await databaseRefusal(owner(`insert into machvon.settlement_revision (tenant_id, id, project_id, revision, settled_amount_vnd, outstanding_vnd, unrecovered_advance_vnd, status, settlement_scope, fiscal_year) values ($1, gen_random_uuid(), $2::uuid, 1, 0, 0, 0, 'SUBMITTED', 'ANNUAL', 2040)`, [TENANT_A, target.projectId]))).message).toContain('SETTLEMENT_STATE_INVALID');
      // The application role may not delete a settlement.
      expect((await databaseRefusal(as((tx) => tx.query('delete from machvon.settlement_revision where id = $1::uuid', [sent.id])))).sqlstate).toBe('42501');

      // The close of a settlement that owes is the check of the table: the exception is what lets it close, nothing else.
      const paid = await paidContract();
      await admin('update machvon.project set status = $2 where id = $1::uuid', [fixtures.projectId, 'COMPLETED']);
      const owing = await verifiedSettlement({ projectId: fixtures.projectId }, { scope: 'CONTRACT', contractId: paid.contractId });
      const decision = (await fixtures.documentVersion()).id;
      const closing = (extra: string) =>
        admin(
          `update machvon.settlement_revision set status = 'CLOSED', decision_document_version_id = $2::uuid, closed_by = $3::uuid, closed_at = now(), close_reason = 'x' ${extra} where id = $1::uuid`,
          [owing.id, decision, memberId(CLOSER)],
        );
      // With the triggers off, the checks of the table still hold.
      const refused = await databaseRefusal(closing(''));
      expect(refused.message).toContain('settlement_revision_close_chk');
      expect(refused.sqlstate).toBe('23514');
      // The person who opened it cannot close it, whatever the application does.
      expect((await databaseRefusal(admin("update machvon.settlement_revision set exception_reason = 'x', exception_approved_by = created_by, exception_approved_at = now(), exception_approval_document_version_id = $2::uuid where id = $1::uuid", [owing.id, decision]))).message).toContain('settlement_revision_exception_chk');
    });
  });

  describe('what the database refused, in the words of the contract', () => {
    it('words a move of the status, a second settlement, a close that owes, the people kept apart, and gives anything else back as it came', async () => {
      const target = await project();
      const sent = next(await submit(await opened(target)));
      const update = (sql: string, params: unknown[] = []) => owner(`update machvon.settlement_revision set ${sql} where id = $1::uuid`, [sent.id, ...params]);
      expect(settlementRefusal(await raised(update("status = 'VERIFIED'")))).toMatchObject({ code: 'SETTLEMENT_STATE_INVALID', status: 409 });
      expect(settlementRefusal(await raised(update('verified_by = submitted_by, status = $2', ['VERIFYING'])))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(
        settlementRefusal(await raised(owner(`insert into machvon.settlement_revision (tenant_id, id, project_id, revision, settled_amount_vnd, outstanding_vnd, unrecovered_advance_vnd, status) values ($1, gen_random_uuid(), $2::uuid, 9, 0, 0, 0, 'DRAFT')`, [TENANT_A, target.projectId]))),
      ).toMatchObject({ code: 'SETTLEMENT_OPEN_EXISTS', status: 409 });
      // An error that is not a rule of the settlement is given back untouched.
      const about = await raised(update('revision = 0'));
      expect(settlementRefusal(about)).toBe(about);
      const missing = await raised(update('figures_refreshed_at = $2', [null]));
      expect(settlementRefusal(missing)).toBe(missing);
      const plain = new Error('boom');
      expect(settlementRefusal(plain)).toBe(plain);
      // A close of a settlement that owes is the check of the table.
      const paid = await paidContract();
      await admin('update machvon.project set status = $2 where id = $1::uuid', [fixtures.projectId, 'COMPLETED']);
      const owing = await verifiedSettlement({ projectId: fixtures.projectId }, { scope: 'CONTRACT', contractId: paid.contractId });
      const decision = (await fixtures.documentVersion()).id;
      const closing = await raised(
        admin("update machvon.settlement_revision set status = 'CLOSED', decision_document_version_id = $2::uuid, closed_by = $3::uuid, closed_at = now(), close_reason = 'x' where id = $1::uuid", [owing.id, decision, memberId(CLOSER)]),
      );
      expect(settlementRefusal(closing)).toMatchObject({ code: 'SETTLEMENT_HAS_OUTSTANDING', status: 422 });
    });
  });

  describe('the reminders of the deadline (TK-PAY-009-3)', () => {
    const run = (now: Date) => as((tx) => deadlines.run(tx, memberId(SETTLER), now), SETTLER);
    const events = (id: string) =>
      owner<{ type: string; payload: Record<string, unknown> }>("select type, payload from machvon.outbox_event where aggregate_id = $1::uuid and type like 'pay.settlement.%' order by created_at, type", [id]);
    const dueOn = (id: string, day: string) => admin('update machvon.settlement_revision set verification_due_on = $2::date where id = $1::uuid', [id, day]);

    it('reminds 30 days and 7 days before the last day and reports the settlement when the day has passed, each once, and an issue is asked for only for the late one', async () => {
      const target = await project({ group: 'C' });
      const sent = next(await submit(await opened(target)));
      await dueOn(sent.id, '2026-12-05');
      // 40 days before: nothing to say.
      expect((await run(NOW)).reminded).toEqual({ T30: 0, T7: 0, OVERDUE: 0 });
      // 30 days before: the first reminder.
      const t30 = await run(new Date('2026-11-05T05:00:00Z'));
      expect(t30.reminded).toEqual({ T30: 1, T7: 0, OVERDUE: 0 });
      expect((await run(new Date('2026-11-06T05:00:00Z'))).reminded).toEqual({ T30: 0, T7: 0, OVERDUE: 0 });
      const t7 = await run(new Date('2026-11-28T05:00:00Z'));
      expect(t7.reminded).toEqual({ T30: 0, T7: 1, OVERDUE: 0 });
      const last = await run(new Date('2026-12-05T05:00:00Z'));
      expect(last.reminded).toEqual({ T30: 0, T7: 0, OVERDUE: 0 });
      expect(last.overdue).toBe(0);
      const late = await run(new Date('2026-12-06T05:00:00Z'));
      expect(late.reminded).toEqual({ T30: 0, T7: 0, OVERDUE: 1 });
      expect(late.overdue).toBeGreaterThanOrEqual(1);
      expect(gauges.at(-1)).toMatchObject({ name: 'pay_settlement_overdue', value: late.overdue });
      expect((await run(new Date('2026-12-07T05:00:00Z'))).reminded).toEqual({ T30: 0, T7: 0, OVERDUE: 0 });

      const sentEvents = await events(sent.id);
      expect(sentEvents.map((event) => event.type)).toEqual([SETTLEMENT_DEADLINE_EVENT, SETTLEMENT_DEADLINE_EVENT, SETTLEMENT_OVERDUE_EVENT]);
      expect(sentEvents.map((event) => event.payload.stage ?? 'OVERDUE')).toEqual(['T30', 'T7', 'OVERDUE']);
      expect(sentEvents[0]?.payload).toMatchObject({ settlement_id: sent.id, project_id: target.projectId, verification_due_on: '2026-12-05', days_left: 30, project_group: 'C' });
      expect(sentEvents[2]?.payload).toMatchObject({ source_ref_id: sent.id, reference_code: `SR-${sent.id.slice(0, 8)}`, severity: 'HIGH', source_module: 'PAY', project_id: target.projectId });
      expect(JSON.stringify(sentEvents)).not.toMatch(/findings|reason|name/);
      const audits = await owner<{ action: string }>("select action from machvon.audit_event where resource_id = $1 and action like 'pay.settlement_%' order by seq", [sent.id]);
      expect(audits.map((row) => row.action)).toEqual(['pay.settlement_deadline_approaching', 'pay.settlement_deadline_approaching', 'pay.settlement_overdue']);
    });

    it('reports a settlement that is first found late without the reminders it missed, and leaves alone one that is verified or not sent', async () => {
      const target = await project({ group: 'A' });
      const sent = next(await submit(await opened(target)));
      await dueOn(sent.id, '2026-09-01');
      const verifying = next(await submit(await opened(await project({ group: 'A' }))));
      const taken = next(await verify(verifying, 'VERIFYING'));
      const verified = next(await verify(taken, 'VERIFIED'));
      await dueOn(verified.id, '2026-09-01');
      const draft = await opened(await project({ group: 'A' }));
      const result = await run(NOW);
      expect(result.reminded.OVERDUE).toBeGreaterThanOrEqual(1);
      const types = (await events(sent.id)).map((event) => event.type);
      expect(types).toEqual([SETTLEMENT_OVERDUE_EVENT]);
      expect(await events(verified.id)).toEqual([]);
      expect(await events(draft.id)).toEqual([]);
      const [flags] = await owner<{ t30: boolean; t7: boolean; overdue: boolean }>(
        'select deadline_t30_sent_at is not null as t30, deadline_t7_sent_at is not null as t7, deadline_overdue_sent_at is not null as overdue from machvon.settlement_revision where id = $1::uuid',
        [sent.id],
      );
      expect(flags).toEqual({ t30: true, t7: true, overdue: true });
    });
  });
});
