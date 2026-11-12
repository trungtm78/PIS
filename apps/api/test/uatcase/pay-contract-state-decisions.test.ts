import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { APP_FILTER } from '@nestjs/core';
import { CtrContractLifecycleStore, EffectiveAccessStore, InMemoryAuthzCache, PayClaimStore, PayPaymentStore, TenantDatabase } from '@machvon/db';
import type { ContractScopes } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AdvanceController } from '../../src/modules/pay/advance.controller';
import { PaymentClaimController } from '../../src/modules/pay/payment-claim.controller';
import { PaymentRequestController, PaymentRequestReadsController } from '../../src/modules/pay/payment-request.controller';
import { ProjectSettlementController, ProjectSettlementReadsController } from '../../src/modules/pay/project-settlement.controller';
import { TENANT_A, memberId } from '../../../../packages/db/test/support/authz-fixtures';
import { AcceptanceWorld } from '../../../../packages/db/test/support/acceptance-fixtures';
import type { ApprovedAcceptance, SeededContract } from '../../../../packages/db/test/support/acceptance-fixtures';
import { settledPayment } from '../../../../packages/db/test/support/settled-payment';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';
import { assertStatus, expectCheckFails } from '../uat/uat-kit';

jest.setTimeout(900_000);

const SIGNING_KEY = randomBytes(32);
const ROOT = 1;
const MAKER = 11; // payment.create, payment.document.attach, payment.submit, payment_request.read, advance.request
const OPENER = 51; // settlement.open, settlement.submit, settlement.verify, settlement_revision.read
const SENDER = 52; // the same role: another officer
const VERIFIER = 53; // the same role: a third
const MATCHER = 54; // makes the Treasury match of the fixture payment; holds nothing here
const MEMBERS = [MAKER, OPENER, SENDER, VERIFIER, MATCHER];
const TODAY = '2026-07-25';
const everything: ContractScopes = { update: () => ({ sql: 'true', params: [] }), read: () => ({ sql: 'true', params: [] }) };

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('payment requests and settlements against the state of the contract and of the capital line (PAY decisions)', () => {
  const fixtures = new AcceptanceWorld();
  const harness = fixtures.harness;
  const payments = new PayPaymentStore();
  const claims = new PayClaimStore();
  const lifecycle = new CtrContractLifecycleStore();
  let app: RunningApp;
  let counter = 0;

  const tokenOf = (member: number): string => signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function call(method: string, url: string, options: { member: number; body?: unknown; ifMatch?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => fixtures.owner<R>(sql, params);
  const audits = (resourceId: string, action: string) => rows<{ actor_id: string; reason: string | null }>('select actor_id, reason from machvon.audit_event where resource_id = $1 and action = $2 order by seq', [resourceId, action]);
  const requestsOf = (contractId: string) => rows<{ id: string; status: string; request_kind: string }>('select id, status, request_kind from machvon.payment_request where contract_id = $1::uuid order by created_at, id', [contractId]);
  const ledgerEntries = async (contractId: string): Promise<number> => (await rows('select 1 from machvon.cumulative_ledger_entry where contract_id = $1::uuid', [contractId])).length;

  /** Runs a statement as the superuser with the triggers off, to put a row in a state that only another story could. */
  async function admin(sql: string, params: unknown[] = []): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  /** A project of its own with a line of capital of the year given and what is allocated to it. */
  const line = (options: { year?: number; allocated?: string } = {}) =>
    fixtures.world.publishedLine({ allocated: options.allocated ?? '10000000000000', appropriationAmount: '20000000000000', ...(options.year === undefined ? {} : { year: options.year }) });

  /** A contract of the project of the line, its party's work worth 10bn, with an advance of 2bn paid (also on the header). */
  async function advancedContract(target: { projectId: string; lineId: string }): Promise<SeededContract> {
    const contract = await fixtures.seedContract({ projectId: target.projectId, lineId: target.lineId });
    await rows('update machvon.contract_party set work_value_vnd = 10000000000 where contract_id = $1::uuid', [contract.contractId]);
    await rows('update machvon.contract set advance_paid_vnd = 2000000000 where id = $1::uuid', [contract.contractId]);
    const advanceId = randomUUID();
    await rows(
      `insert into machvon.contract_advance (tenant_id, id, contract_id, party_id, tranche_no, kind, amount_vnd, cap_vnd, status, paid_vnd, paid_on, recovery_threshold_pct, recovery_deadline, created_by, updated_by)
       values ($1, $5::uuid, $2, $3, 1, 'GPMB', 2000000000, 2000000000, 'PAID', 2000000000, date '2026-06-01', 80, date '2026-12-31', $4, $4)`,
      [TENANT_A, contract.contractId, contract.partyId, memberId(MAKER), advanceId],
    );
    // The journal of the advance: the money went out on 1 June (the fixture sets the tranche as paid without the entry that records it).
    await admin(
      `insert into machvon.advance_ledger_entry (tenant_id, id, contract_id, payment_request_id, entry_kind, amount_vnd, posted_at, advance_id, party_id, outstanding_after_vnd, request_id)
       values ($1, gen_random_uuid(), $2::uuid, null, 'DISBURSE', 2000000000, timestamptz '2026-06-01T03:00:00Z', $3::uuid, $4::uuid, 2000000000, gen_random_uuid())`,
      [TENANT_A, contract.contractId, advanceId, contract.partyId],
    );
    return contract;
  }
  /** The day an acceptance was approved is stamped by the command and never changes: a test that needs an approval on a day of the past writes it past the guard that keeps it. */
  const approvedOn = (approved: ApprovedAcceptance, instant: string) => admin('update machvon.acceptance set approved_at = $2::timestamptz where id = $1::uuid', [approved.acceptance.id, instant]);

  const versionOfContract = async (id: string): Promise<number> => Number((await rows<{ version: string }>('select version::text as version from machvon.contract where id = $1::uuid', [id]))[0]?.version);
  const requestNo = (): string => `DNTT-${String((counter += 1)).padStart(4, '0')}`;
  const create = (target: { contract: SeededContract; lineId: string }, acceptanceId: string, overrides: Record<string, unknown> = {}) =>
    call('POST', '/payment-requests', { member: MAKER, body: { contract_id: target.contract.contractId, request_kind: 'INTERIM', acceptance_id: acceptanceId, allocation_line_id: target.lineId, request_no: requestNo(), ...overrides } });
  const versionOf = async (id: string): Promise<string> => (await rows<{ version: string }>('select version::text as version from machvon.payment_request where id = $1::uuid', [id]))[0]?.version ?? '0';
  /** The invoice a request needs before it is sent, and the sending with the figures the draft showed. */
  async function sendDraft(draft: Reply): Promise<Reply> {
    const id = draft.json.resource_id as string;
    const invoice = { document_version_id: (await fixtures.documentVersion()).id, doc_kind: 'INVOICE', invoice_no: `INV-${randomUUID().slice(0, 8)}`, invoice_date: '2026-07-01' };
    expect((await call('POST', `/payment-requests/${id}/documents`, { member: MAKER, body: invoice })).status).toBe(200);
    return call('POST', `/payment-requests/${id}/submit`, { member: MAKER, ifMatch: `"${await versionOf(id)}"`, body: { expected_gross_vnd: draft.json.gross_vnd, expected_net_vnd: draft.json.net_vnd } });
  }
  const askAdvance = (contract: SeededContract, lineId: string, amount: string) =>
    call('POST', `/contracts/${contract.contractId}/advances`, { member: MAKER, body: { party_id: contract.partyId, kind: 'CONTRACT', amount_vnd: amount, allocation_line_id: lineId } });
  const documentOfDecision = async (): Promise<string> => (await fixtures.documentVersion()).id;

  beforeAll(async () => {
    await fixtures.start();
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedRole(TENANT_A, 101, 'PAY_MAKER', ['payment.create', 'payment.document.attach', 'payment.submit', 'payment_request.read', 'advance.request', 'advance.read'], 30);
    await harness.seedRole(TENANT_A, 401, 'SETTLEMENT_OFFICER', ['settlement.open', 'settlement.submit', 'settlement.verify', 'settlement_revision.read'], 30);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MAKER, role: 101, kind: 'TENANT' },
      { n: 2, member: OPENER, role: 401, kind: 'TENANT' },
      { n: 3, member: SENDER, role: 401, kind: 'TENANT' },
      { n: 4, member: VERIFIER, role: 401, kind: 'TENANT' },
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [PaymentRequestController, PaymentRequestReadsController, PaymentClaimController, AdvanceController, ProjectSettlementController, ProjectSettlementReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 900_000);

  afterAll(async () => {
    if (app) await app.close();
    await fixtures.stop();
  }, 120_000);

  it('UAT-AC338: a terminated contract takes the final request of an approved acceptance and nothing else, and what is owed on the advance stays until the settlement', async () => {
    const target = await line();
    const contract = await advancedContract(target);
    const owner = { contract, lineId: target.lineId };
    // NT-A-001 (3bn) was sent while the contract was performed: the advance of 2bn has 750m recovered and 1.25bn outstanding.
    const first = await fixtures.approve(contract, [
      { item: 0, quantity: '2000' },
      { item: 1, quantity: '500' },
    ]);
    const sent = await sendDraft(await create(owner, first.acceptance.id));
    assertStatus(sent, 200);
    expect(sent.json.status).toBe('SUBMITTED');
    // NT-A-005 (500m) is approved before the contract ends and not paid; NT-A-006 is still a draft.
    const fifth = await fixtures.approve(contract, [{ item: 0, quantity: '500' }]);
    const sixth = await fixtures.draft(contract, [{ item: 1, quantity: '10' }]);
    const paper = await documentOfDecision();
    await rows("update machvon.contract set status = 'TERMINATED', status_reason = 'Ended by decision.', status_decision_document_version_id = $2::uuid, terminated_on = date '2099-01-01' where id = $1::uuid", [contract.contractId, paper]);
    // The settlement the termination opens (SR-A-T1), through the command of PAY, for a project that is being built.
    await admin('update machvon.project set status = $2 where id = $1::uuid', [target.projectId, 'IMPLEMENTATION']);
    const opened = await call('POST', '/settlements', { member: OPENER, body: { project_id: target.projectId, settlement_scope: 'CONTRACT', contract_id: contract.contractId } });
    assertStatus(opened, 200);
    const settlementId = opened.json.resource_id as string;
    const standing = () => rows<{ paid: string; recovered: string; outstanding: string }>('select advance_paid_vnd::text as paid, advance_recovered_vnd::text as recovered, (advance_paid_vnd - advance_recovered_vnd)::text as outstanding from machvon.contract where id = $1::uuid', [contract.contractId]);
    const tranches = () => rows('select status, paid_vnd::text, recovered_vnd::text from machvon.contract_advance where contract_id = $1::uuid order by tranche_no', [contract.contractId]);
    const beforeRows = (await requestsOf(contract.contractId)).length;
    const beforeAdvances = await tranches();
    expect(await standing()).toEqual([{ paid: '2000000000', recovered: '750000000', outstanding: '1250000000' }]);

    // 1: an interim request is refused whatever the acceptance.
    const interim = await create(owner, fifth.acceptance.id);
    assertStatus(interim, 409, 'CONTRACT_STATE_INVALID');
    expect(interim.json).toMatchObject({ contract_status: 'TERMINATED', request_kind: 'INTERIM', reason: 'KIND_NOT_ALLOWED_AFTER_TERMINATION' });
    // 2: the final request of NT-A-005 is a draft whose recovery is the formula on the cumulative gross of 3.5bn less the 750m already recovered.
    const final = await create(owner, fifth.acceptance.id, { request_kind: 'FINAL', settlement_revision_id: settlementId });
    assertStatus(final, 200);
    expect(final.json).toMatchObject({ status: 'DRAFT', gross_vnd: '500000000', advance_recovery_vnd: '125000000', retention_vnd: '25000000', net_vnd: '350000000' });
    // 3: a new advance is refused.
    const advance = await askAdvance(contract, target.lineId, '100000000');
    assertStatus(advance, 422, 'ADVANCE_CONTRACT_NOT_EFFECTIVE');
    // 4: the final request of an acceptance that is not approved is refused.
    const unapproved = await create(owner, sixth.id, { request_kind: 'FINAL', settlement_revision_id: settlementId });
    assertStatus(unapproved, 422, 'ACCEPTANCE_NOT_APPROVED');

    // Only the draft of NT-A-005 was written; the advance owed is what it was.
    expect((await requestsOf(contract.contractId)).slice(beforeRows)).toEqual([{ id: final.json.resource_id, status: 'DRAFT', request_kind: 'FINAL' }]);
    expect(await standing()).toEqual([{ paid: '2000000000', recovered: '750000000', outstanding: '1250000000' }]);
    expect(await tranches()).toEqual(beforeAdvances);
    expect(await rows('select 1 from machvon.advance_ledger_entry where payment_request_id = $1::uuid', [final.json.resource_id])).toEqual([]);
    expect(await rows('select 1 from machvon.contract_advance where contract_id = $1::uuid and tranche_no > 1', [contract.contractId])).toEqual([]);
  });

  it('UAT-AC344: a suspended contract takes the request of an acceptance approved before the day it stopped, refuses the later one and a new advance, and takes it again once resumed', async () => {
    const target = await line();
    const contract = await fixtures.seedContract({ projectId: target.projectId, lineId: target.lineId });
    await rows('update machvon.contract_party set work_value_vnd = 10000000000 where contract_id = $1::uuid', [contract.contractId]);
    const owner = { contract, lineId: target.lineId };
    const second = await fixtures.approve(contract, [{ item: 0, quantity: '1000' }]);
    const third = await fixtures.approve(contract, [{ item: 1, quantity: '100' }]);
    await approvedOn(second, '2026-07-05T03:00:00Z');
    await approvedOn(third, '2026-07-12T03:00:00Z');
    const decision = await documentOfDecision();
    const suspendAt = await versionOfContract(contract.contractId);
    const suspend = await fixtures.as((tx) => lifecycle.suspend(tx, contract.contractId, suspendAt, { reason: 'The site is closed by decision DOC-TD-001.', decisionDocumentVersionId: decision, suspendedFrom: '2026-07-10' }, memberId(1), everything, TODAY));
    expect(suspend).toMatchObject({ status: 'SUSPENDED', suspendedFrom: '2026-07-10' });

    // 1: NT-A-002, approved on 5 July, is created and sent.
    const sentSecond = await sendDraft(await create(owner, second.acceptance.id));
    assertStatus(sentSecond, 200);
    expect(sentSecond.json.status).toBe('SUBMITTED');
    // 2: NT-A-003, approved on 12 July, after the stop, is refused and nothing is written for it.
    const refused = await create(owner, third.acceptance.id);
    assertStatus(refused, 409, 'CONTRACT_STATE_INVALID');
    expect(refused.json).toMatchObject({ contract_status: 'SUSPENDED', reason: 'ACCEPTED_AFTER_SUSPENSION' });
    expect(await rows('select 1 from machvon.payment_request where acceptance_id = $1::uuid', [third.acceptance.id])).toEqual([]);
    // 3: a new advance is refused.
    assertStatus(await askAdvance(contract, target.lineId, '100000000'), 422, 'ADVANCE_CONTRACT_NOT_EFFECTIVE');
    expect(await rows('select 1 from machvon.contract_advance where contract_id = $1::uuid', [contract.contractId])).toEqual([]);
    // 4: resumed on a document, NT-A-003 can be drawn up.
    const resumeAt = await versionOfContract(contract.contractId);
    const resumed = await fixtures.as((tx) => lifecycle.resume(tx, contract.contractId, resumeAt, { reason: 'The site is open again.', decisionDocumentVersionId: decision, resumedOn: '2026-07-20' }, memberId(1), everything, TODAY));
    expect(resumed).toMatchObject({ status: 'ACTIVE', resumedOn: '2026-07-20' });
    const later = await create(owner, third.acceptance.id);
    assertStatus(later, 200);
    expect(later.json.status).toBe('DRAFT');
    expect(await rows('select from_status, to_status, reason, decision_document_version_id, effective_on::text as effective_on from machvon.contract_status_change where contract_id = $1::uuid order by created_at, id', [contract.contractId])).toEqual([
      { from_status: 'ACTIVE', to_status: 'SUSPENDED', reason: 'The site is closed by decision DOC-TD-001.', decision_document_version_id: decision, effective_on: '2026-07-10' },
      { from_status: 'SUSPENDED', to_status: 'ACTIVE', reason: 'The site is open again.', decision_document_version_id: decision, effective_on: '2026-07-20' },
    ]);
  });

  it('UAT-AC342: the capital line of an earlier year is 422 PLAN_YEAR_MISMATCH, a line with too little left cannot take the send and leaves no entry, and a line of 2026 with room is sent with its plan year', async () => {
    const build = async (target: { projectId: string; lineId: string }) => {
      const contract = await advancedContract(target);
      const approved = await fixtures.approve(contract, [
        { item: 0, quantity: '2000' },
        { item: 1, quantity: '500' },
      ]);
      return { contract, approved, lineId: target.lineId };
    };
    const draft = (held: Awaited<ReturnType<typeof build>>) =>
      fixtures.as((tx) => payments.create(tx, { contractId: held.contract.contractId, requestKind: 'INTERIM', acceptanceId: held.approved.acceptance.id, allocationLineId: held.lineId, requestNo: requestNo() }, memberId(MAKER), everything, TODAY), MAKER);
    const submitIt = async (held: Awaited<ReturnType<typeof build>>, made: Awaited<ReturnType<typeof draft>>) => {
      const document = await fixtures.documentVersion();
      await fixtures.as((tx) => payments.attachDocument(tx, made.id, { documentVersionId: document.id, docKind: 'INVOICE', invoiceNo: `HD-${randomUUID().slice(0, 8)}`, invoiceDate: '2026-07-01' }, memberId(MAKER), everything, { mayOverride: () => false }), MAKER);
      return fixtures.as((tx) => claims.submit(tx, made.id, made.version, { expectedGrossVnd: made.grossVnd, expectedNetVnd: made.netVnd, requestId: randomUUID() }, memberId(MAKER), everything, TODAY), MAKER);
    };
    const refusal = async (work: Promise<unknown>): Promise<{ code: string; status: number; extensions?: Record<string, unknown> }> => {
      try {
        await work;
      } catch (error) {
        return error as { code: string; status: number; extensions?: Record<string, unknown> };
      }
      throw new Error('expected a refusal');
    };
    const appropriation = await fixtures.world.appropriation({ planYear: 2026, amountVnd: '20000000000000' });
    const planned = (allocated: string) => fixtures.world.publishedLine({ allocated, appropriationId: appropriation.id, year: 2026 });

    // 1: AL-A-2025-NSDP, a line of the year before the acceptance.
    const old = await build(await fixtures.world.publishedLine({ year: 2025, allocated: '5000000000', appropriationAmount: '20000000000000' }));
    expect(await refusal(draft(old))).toMatchObject({ code: 'PLAN_YEAR_MISMATCH', status: 422, extensions: { reason: 'BEFORE_ACCEPTANCE', plan_year: 2025, acceptance_year: 2026 } });
    expect(await requestsOf(old.contract.contractId)).toEqual([]);
    // 2: AL-A-2026-LOW holds 1bn: the draft is made, the send is refused for the net of 2.1bn and puts nothing on the ledger.
    const low = await build(await planned('1000000000'));
    const lowDraft = await draft(low);
    expect(lowDraft).toMatchObject({ status: 'DRAFT', netVnd: '2100000000', planYear: 2026 });
    expect(await refusal(submitIt(low, lowDraft))).toMatchObject({ code: 'ALLOCATION_UNAVAILABLE', status: 422, extensions: { reason: 'INSUFFICIENT', available_vnd: '1000000000' } });
    expect(await ledgerEntries(low.contract.contractId)).toBe(0);
    expect(await requestsOf(low.contract.contractId)).toEqual([{ id: lowDraft.id, status: 'DRAFT', request_kind: 'INTERIM' }]);
    // 3: AL-A-2026-NSDP holds 5bn: the request is sent and carries the plan year.
    const nsdp = await build(await planned('5000000000'));
    const nsdpDraft = await draft(nsdp);
    expect(await submitIt(nsdp, nsdpDraft)).toMatchObject({ status: 'SUBMITTED' });
    expect(await rows('select status, plan_year from machvon.payment_request where id = $1::uuid', [nsdpDraft.id])).toEqual([{ status: 'SUBMITTED', plan_year: 2026 }]);
  });

  it('a project without a national code is refused under the strict rule of the day (422 NATIONAL_CODE_REQUIRED) and drafted with a warning under the lenient one', async () => {
    const target = await line();
    const contract = await advancedContract(target);
    const approved = await fixtures.approve(contract, [{ item: 0, quantity: '2000' }]);
    const owner = { contract, lineId: target.lineId };
    await rows('update machvon.project set national_project_code = null where id = $1::uuid', [target.projectId]);
    const refused = await create(owner, approved.acceptance.id);
    assertStatus(refused, 422, 'NATIONAL_CODE_REQUIRED');
    expect(refused.json).toMatchObject({ detail: 'national_project_code' });
    expect(await requestsOf(contract.contractId)).toEqual([]);
    const modeOf = (mode: string) =>
      admin(
        `update machvon.master_record_version v set attributes = jsonb_set(attributes, '{mode}', to_jsonb($1::text)) from machvon.master_record r where r.id = v.master_record_id and r.master_type = 'NATIONAL_CODE_REQUIRED'`,
        [mode],
      );
    await modeOf('WARN');
    try {
      const lenient = await create(owner, approved.acceptance.id);
      assertStatus(lenient, 200);
      expect(lenient.json).toMatchObject({ status: 'DRAFT', warnings: [{ code: 'NATIONAL_CODE_MISSING' }] });
    } finally {
      await modeOf('BLOCK');
    }
  });

  it('UAT-PLAN-21: reading the figures again is allowed on a draft and a returned settlement and equals the ledger sums, and a sent settlement is 409 with its figures untouched', async () => {
    const paid = await settledPayment(fixtures, { maker: OPENER, sender: SENDER, checker: VERIFIER, matcher: MATCHER });
    await admin('update machvon.project set status = $2, project_group = $3 where id = $1::uuid', [fixtures.projectId, 'COMPLETED', 'B']);
    const year = new Date().getFullYear();
    const open = async (body: Record<string, unknown>): Promise<string> => {
      const reply = await call('POST', '/settlements', { member: OPENER, body: { project_id: fixtures.projectId, ...body } });
      assertStatus(reply, 200);
      return reply.json.resource_id as string;
    };
    const stored = async (id: string) =>
      (await rows<{ status: string; version: string; settled: string; outstanding: string; unrecovered: string }>(
        'select status, version::text as version, settled_amount_vnd::text as settled, outstanding_vnd::text as outstanding, unrecovered_advance_vnd::text as unrecovered from machvon.settlement_revision where id = $1::uuid',
        [id],
      ))[0];
    const command = async (member: number, id: string, action: string, body: Record<string, unknown>): Promise<Reply> => call('POST', `/settlements/${id}/${action}`, { member, body, ifMatch: `"${(await stored(id))?.version}"` });
    const sums = async () => {
      const [ledger] = await rows<{ paid: string; owed: string }>(
        'select coalesce(sum(paid_vnd), 0)::text as paid, coalesce(sum(accepted_vnd - paid_vnd + retention_held_vnd), 0)::text as owed from machvon.cumulative_ledger where contract_id = $1::uuid',
        [paid.contractId],
      );
      const [advance] = await rows<{ unrecovered: string }>('select (advance_paid_vnd - advance_recovered_vnd)::text as unrecovered from machvon.contract where id = $1::uuid', [paid.contractId]);
      return { settled: ledger?.paid, outstanding: ledger?.owed, unrecovered: advance?.unrecovered };
    };
    const ledger = await sums();
    expect(ledger).toEqual({ settled: '3000000000', outstanding: '150000000', unrecovered: '1250000000' });
    const advanceRecovered = await rows<{ recovered: string }>("select coalesce(sum(amount_vnd), 0)::text as recovered from machvon.advance_ledger_entry where contract_id = $1::uuid and entry_kind = 'RECOVER'", [paid.contractId]);
    expect(advanceRecovered).toEqual([{ recovered: '750000000' }]);

    // S1: a draft of the whole project (PROJECT scope).
    const s1 = await open({ settlement_scope: 'PROJECT' });
    assertStatus(await command(OPENER, s1, 'refresh', { note: 'After July.' }), 200);
    expect(await stored(s1)).toMatchObject({ status: 'DRAFT', settled: ledger.settled, outstanding: ledger.outstanding, unrecovered: ledger.unrecovered });
    // S2: the settlement of the contract, sent and returned.
    const s2 = await open({ settlement_scope: 'CONTRACT', contract_id: paid.contractId });
    assertStatus(await command(SENDER, s2, 'submit', { submitted_on: '2026-07-01' }), 200);
    assertStatus(await command(VERIFIER, s2, 'verification', { outcome: 'RETURNED', findings: 'The report is missing.' }), 200);
    expect((await stored(s2))?.status).toBe('RETURNED');
    const again = await command(OPENER, s2, 'refresh', { note: 'With the report.' });
    assertStatus(again, 200);
    expect(again.json.status).toBe('DRAFT');
    expect(await stored(s2)).toMatchObject({ status: 'DRAFT', settled: ledger.settled, outstanding: ledger.outstanding, unrecovered: ledger.unrecovered });
    // S3: the settlement of the year, sent and not given back.
    const s3 = await open({ settlement_scope: 'ANNUAL', fiscal_year: year });
    assertStatus(await command(SENDER, s3, 'submit', { submitted_on: '2026-07-01' }), 200);
    const before = await stored(s3);
    expect(before).toMatchObject({ status: 'SUBMITTED', settled: ledger.settled, outstanding: ledger.outstanding, unrecovered: ledger.unrecovered });
    const refreshed = await audits(s3, 'settlement_revision.figures_refreshed');
    const refusedRefresh = await command(OPENER, s3, 'refresh', { note: 'Too late.' });
    assertStatus(refusedRefresh, 409, 'SETTLEMENT_STATE_INVALID');
    expect(await stored(s3)).toEqual(before);
    expect(await audits(s3, 'settlement_revision.figures_refreshed')).toEqual(refreshed);
  });

  it('a check of this suite goes red when it is fed a wrong answer (negative control)', () => {
    expectCheckFails(() => assertStatus({ status: 200, json: {} }, 409, 'CONTRACT_STATE_INVALID'));
    expectCheckFails(() => assertStatus({ status: 409, json: { code: 'VALUE_EXCEEDED' } }, 409, 'CONTRACT_STATE_INVALID'));
  });
});
