import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, SodGuard, TenantDatabase } from '@machvon/db';
import { SOD_ACTION_CODES, SOD_SCOPES, loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { SodAuditReadsController, SodExceptionsController, SodReadsController } from '../../src/modules/adm/sod.controller';
import { PaymentClaimController } from '../../src/modules/pay/payment-claim.controller';
import { PaymentRequestController, PaymentRequestReadsController } from '../../src/modules/pay/payment-request.controller';
import { TENANT_A, memberId } from '../../../../packages/db/test/support/authz-fixtures';
import { AcceptanceWorld } from '../../../../packages/db/test/support/acceptance-fixtures';
import type { ApprovedAcceptance } from '../../../../packages/db/test/support/acceptance-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(480_000);

/**
 * The separation of duties at commit (G4-1): the matrix and its register of exceptions over HTTP, the guard in the commands of PAY (the same guard serves CTR and BID), and the duty queries of every action against the tables of the modules.
 * The fixtures of the acceptance world say who did what: member 1 drew up the contract, the measurements and the acceptance, member 2 sent the acceptance, member 3 approved the measurements and the acceptance.
 */
const SIGNING_KEY = randomBytes(32);
const ROOT = 1;
const CREATOR = 1;
const SENDER = 2;
const APPROVER = 3;
const MAKER = 11; // payment.create, payment.document.attach, payment.submit, payment_request.read
const ASKER = 21; // adm.sod.exception.request, adm.sod.read
const APPROVE_1 = 22; // adm.sod.exception.approve, adm.sod.read
const APPROVE_2 = 23;
const APPROVE_3 = 24;
const REVOKER = 25; // adm.sod.exception.revoke, adm.sod.read
const AUDITOR = 26; // aud.sod.read
const NOBODY = 27;
const READER = 28; // adm.sod.read
const OTHER_CHECKER = 29; // payment.verify, holds no duty of the contracts of the tests
const BOTH = 30; // adm.sod.exception.request and adm.sod.exception.approve
const MEMBERS = [MAKER, ASKER, APPROVE_1, APPROVE_2, APPROVE_3, REVOKER, AUDITOR, NOBODY, READER, OTHER_CHECKER, BOTH];

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

const PAIR = { action_a: 'acceptance.approve', action_b: 'payment.verify' };
const day = (offset: number): string => new Date(Date.parse(`${vietnamDateOf(new Date())}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);

describe('the separation of duties at commit (G4-1)', () => {
  const fixtures = new AcceptanceWorld();
  const harness = fixtures.harness;
  const guard = new SodGuard();
  let app: RunningApp;
  let counter = 0;

  const tokenOf = (member: number): string => signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function call(method: string, url: string, options: { member: number; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }
  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => fixtures.owner<R>(sql, params);
  const countOf = async (sql: string, params: unknown[] = []): Promise<number> => Number(((await rows<{ n: string }>(sql, params))[0] as { n: string }).n);

  async function approved(): Promise<ApprovedAcceptance> {
    const contract = await fixtures.seedContract();
    await fixtures.owner('update machvon.contract_party set work_value_vnd = 10000000000 where contract_id = $1::uuid', [contract.contractId]);
    await fixtures.owner('update machvon.contract set advance_paid_vnd = 2000000000 where id = $1::uuid', [contract.contractId]);
    await fixtures.owner(
      `insert into machvon.contract_advance (tenant_id, id, contract_id, party_id, tranche_no, kind, amount_vnd, cap_vnd, status, paid_vnd, paid_on, recovery_threshold_pct, recovery_deadline, created_by, updated_by)
       values ($1, gen_random_uuid(), $2, $3, 1, 'GPMB', 2000000000, 2000000000, 'PAID', 2000000000, date '2026-06-01', 80, date '2026-12-31', $4, $4)`,
      [TENANT_A, contract.contractId, contract.partyId, memberId(MAKER)],
    );
    return fixtures.approve(contract, [
      { item: 0, quantity: '2000' },
      { item: 1, quantity: '500' },
    ]);
  }

  /** A request of the maker for the work of an approved acceptance, sent and waiting for a checker. */
  async function sent(): Promise<{ world: ApprovedAcceptance; id: string }> {
    const world = await approved();
    counter += 1;
    const made = await call('POST', '/payment-requests', {
      member: MAKER,
      body: { contract_id: world.contract.contractId, request_kind: 'INTERIM', acceptance_id: world.acceptance.id, allocation_line_id: fixtures.lineId, request_no: `DNTT-S-${String(counter).padStart(4, '0')}` },
    });
    expect(made.status).toBe(200);
    const id = made.json.resource_id as string;
    const invoice = { document_version_id: (await fixtures.documentVersion()).id, doc_kind: 'INVOICE', invoice_no: `INV-${randomUUID().slice(0, 8)}`, invoice_date: '2026-07-01' };
    expect((await call('POST', `/payment-requests/${id}/documents`, { member: MAKER, body: invoice })).status).toBe(200);
    const version = (await rows<{ version: string }>('select version::text as version from machvon.payment_request where id = $1::uuid', [id]))[0]?.version;
    const submitted = await call('POST', `/payment-requests/${id}/submit`, { member: MAKER, ifMatch: `"${version}"`, body: { expected_gross_vnd: '3000000000', expected_net_vnd: '2100000000' } });
    expect(submitted.status).toBe(200);
    return { world, id };
  }
  const verify = async (member: number, id: string, key?: string): Promise<Reply> => {
    const version = (await rows<{ version: string }>('select version::text as version from machvon.payment_request where id = $1::uuid', [id]))[0]?.version;
    return call('POST', `/payment-requests/${id}/verify`, { member, ifMatch: `"${version}"`, ...(key === undefined ? {} : { key }), body: { note: 'Checked against the acceptance.' } });
  };
  const statusOf = async (id: string): Promise<string> => (await rows<{ status: string }>('select status from machvon.payment_request where id = $1::uuid', [id]))[0]?.status as string;

  /** A matrix the tenant approved: the pair of the acceptance and the check of its payment is a BLOCK (14 days of exception at most). */
  async function approveMatrixWithBlock(): Promise<string> {
    const ruleId = randomUUID();
    await rows(
      `insert into machvon.governance_rule (tenant_id, id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at)
       values ($1, $2, 'SOD_MATRIX', 'DEFAULT', 1, 'APPROVED', $3::jsonb, date '2026-01-01', 'Pair of the acceptance and the payment is a block', $4, $4, now(), $5, now())`,
      [
        TENANT_A,
        ruleId,
        JSON.stringify({
          exception_approvers: 2,
          conflicts: [
            { ...PAIR, scope: 'SAME_CONTRACT', severity: 'BLOCK', exception_max_days: 14 },
            { action_a: 'payment.request', action_b: 'payment.verify', scope: 'SAME_RECORD', severity: 'BLOCK', exception_max_days: 0 },
          ],
        }),
        memberId(ASKER),
        memberId(APPROVE_1),
      ],
    );
    return ruleId;
  }
  const retireMatrix = (ruleId: string): Promise<unknown[]> => rows(`update machvon.governance_rule set status = 'RETIRED', retired_by = $2::uuid, retired_at = now(), retire_reason = 'End of the test', effective_to = current_date where id = $1::uuid`, [ruleId, memberId(READER)]);

  const request = (member: number, overrides: Record<string, unknown> = {}, key?: string): Promise<Reply> =>
    call('POST', '/sod-exceptions', { member, ...(key === undefined ? {} : { key }), body: { ...PAIR, scope: 'SAME_CONTRACT', subject_id: randomUUID(), member_id: memberId(APPROVER), reason: 'The only checker of the unit is on leave this week', valid_from: day(0), valid_to: day(6), ...overrides } });
  const versionOf = async (id: string): Promise<string> => `"${(await rows<{ version: string }>('select version::text as version from machvon.sod_exception where id = $1::uuid', [id]))[0]?.version}"`;
  const decide = async (what: 'approve' | 'reject' | 'revoke', member: number, id: string, body: Record<string, unknown> = {}): Promise<Reply> =>
    call('POST', `/sod-exceptions/${id}/${what}`, { member, ifMatch: await versionOf(id), body: what === 'approve' ? body : { reason: 'A reason in plain words', ...body } });
  const idOf = (reply: Reply): string => reply.json.resource_id as string;

  beforeAll(async () => {
    await fixtures.start();
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedRole(TENANT_A, 101, 'PAY_MAKER', ['payment.create', 'payment.document.attach', 'payment.submit', 'payment_request.read'], 30);
    await harness.seedRole(TENANT_A, 102, 'SOD_ASKER', ['adm.sod.exception.request', 'adm.sod.read'], 30);
    await harness.seedRole(TENANT_A, 103, 'SOD_APPROVER', ['adm.sod.exception.approve', 'adm.sod.read'], 30);
    await harness.seedRole(TENANT_A, 104, 'SOD_REVOKER', ['adm.sod.exception.revoke', 'adm.sod.read'], 30);
    await harness.seedRole(TENANT_A, 105, 'SOD_AUDITOR', ['aud.sod.read'], 30);
    await harness.seedRole(TENANT_A, 106, 'UNRELATED', ['adm.security.read'], 10);
    await harness.seedRole(TENANT_A, 107, 'SOD_READER', ['adm.sod.read'], 10);
    await harness.seedRole(TENANT_A, 108, 'PAY_CHECKER', ['payment.verify', 'payment.return', 'payment_request.read'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MAKER, role: 101, kind: 'TENANT' },
      { n: 2, member: ASKER, role: 102, kind: 'TENANT' },
      { n: 3, member: APPROVE_1, role: 103, kind: 'TENANT' },
      { n: 4, member: APPROVE_2, role: 103, kind: 'TENANT' },
      { n: 5, member: APPROVE_3, role: 103, kind: 'TENANT' },
      { n: 6, member: REVOKER, role: 104, kind: 'TENANT' },
      { n: 7, member: AUDITOR, role: 105, kind: 'TENANT' },
      { n: 8, member: NOBODY, role: 106, kind: 'TENANT' },
      { n: 9, member: READER, role: 107, kind: 'TENANT' },
      { n: 10, member: APPROVER, role: 108, kind: 'TENANT' },
      { n: 11, member: APPROVER, role: 103, kind: 'TENANT' },
      { n: 12, member: OTHER_CHECKER, role: 108, kind: 'TENANT' },
      { n: 13, member: BOTH, role: 102, kind: 'TENANT' },
      { n: 14, member: BOTH, role: 103, kind: 'TENANT' },
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [PaymentRequestController, PaymentClaimController, PaymentRequestReadsController, SodExceptionsController, SodReadsController, SodAuditReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 480_000);

  afterAll(async () => {
    if (app) await app.close();
    await fixtures.stop();
  }, 60_000);

  describe('the matrix in force', () => {
    it('is the built-in default with its formula, its source and the word that nobody confirmed it', async () => {
      const reply = await call('GET', '/sod-matrix', { member: READER });
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ rule_version: 0, source: 'DEFAULT', unverified: true, exception_approvers: 2 });
      expect(String(reply.json.formula).length).toBeGreaterThan(20);
      const conflicts = reply.json.conflicts as Array<{ action_a: string; action_b: string; scope: string; severity: string; exception_max_days: number }>;
      expect(conflicts.length).toBeGreaterThanOrEqual(11);
      expect(conflicts.filter((conflict) => conflict.severity === 'WARN').length).toBeGreaterThanOrEqual(3);
      expect((reply.json.actions as unknown[]).length).toBe(SOD_ACTION_CODES.length);
    });

    it('is read by a holder of the grant only: a caller without it is refused', async () => {
      for (const url of ['/sod-matrix', '/sod-exceptions', `/sod-exceptions/${randomUUID()}`, '/audit-sod/uses', '/audit-sod/exceptions']) expect((await call('GET', url, { member: NOBODY })).status).toBe(403);
      expect((await call('GET', `/sod-exceptions/${randomUUID()}`, { member: READER })).status).toBe(404);
    });
  });

  describe('the duties of every action are found in the tables of the modules', () => {
    it('answers every action in every scope without an error, and a stranger holds nothing', async () => {
      for (const action of SOD_ACTION_CODES) {
        for (const scope of SOD_SCOPES) {
          expect(await fixtures.as((tx) => guard.holds(tx, action, scope, randomUUID(), memberId(CREATOR)), CREATOR)).toBe(false);
        }
      }
      for (const kind of ['contract', 'measurement', 'acceptance', 'payment_request', 'bid_finding', 'bid_report', 'bid_result'] as const) {
        expect(await fixtures.as((tx) => guard.subject(tx, kind, randomUUID()), CREATOR)).toBeUndefined();
      }
    });

    it('reads who drafted, sent and approved the contract, the measurements and the acceptance, by record, contract and project', async () => {
      const world = await approved();
      const contractId = world.contract.contractId;
      const acceptanceId = world.acceptance.id;
      const holds = (action: string, scope: (typeof SOD_SCOPES)[number], key: string, member: number): Promise<boolean> => fixtures.as((tx) => guard.holds(tx, action, scope, key, memberId(member)), CREATOR);
      expect(await holds('contract.draft', 'SAME_CONTRACT', contractId, CREATOR)).toBe(true);
      expect(await holds('contract.draft', 'SAME_CONTRACT', contractId, APPROVER)).toBe(false);
      expect(await holds('contract.approve', 'SAME_CONTRACT', contractId, CREATOR)).toBe(false);
      expect(await holds('acceptance.record', 'SAME_RECORD', acceptanceId, CREATOR)).toBe(true);
      expect(await holds('acceptance.record', 'SAME_RECORD', acceptanceId, SENDER)).toBe(true);
      expect(await holds('acceptance.record', 'SAME_RECORD', acceptanceId, APPROVER)).toBe(false);
      expect(await holds('acceptance.approve', 'SAME_RECORD', acceptanceId, APPROVER)).toBe(true);
      expect(await holds('acceptance.approve', 'SAME_CONTRACT', contractId, APPROVER)).toBe(true);
      expect(await holds('acceptance.approve', 'SAME_CONTRACT', contractId, CREATOR)).toBe(false);
      expect(await holds('measurement.approve', 'SAME_CONTRACT', contractId, APPROVER)).toBe(true);
      expect(await holds('measurement.record', 'SAME_CONTRACT', contractId, CREATOR)).toBe(true);
      const subject = await fixtures.as((tx) => guard.subject(tx, 'acceptance', acceptanceId), CREATOR);
      expect(subject).toMatchObject({ record: acceptanceId, contract: contractId });
      expect(subject?.project).toBeTruthy();
      expect(subject?.package).toBeTruthy();
      const byProject = await fixtures.as((tx) => guard.holds(tx, 'acceptance.approve', 'SAME_PROJECT', subject?.project as string, memberId(APPROVER)), CREATOR);
      expect(byProject).toBe(true);
    });
  });

  describe('a pair that is only a warning', () => {
    it('lets the command go and keeps a use for the auditor', async () => {
      const { world, id } = await sent();
      const checked = await verify(APPROVER, id);
      expect(checked.status).toBe(200);
      expect(await statusOf(id)).toBe('VERIFIED');
      const uses = await rows<{ outcome: string; action_a: string; action_b: string; scope: string; command: string; member_id: string; exception_id: string | null; subject_id: string }>(
        `select outcome, action_a, action_b, scope, command, member_id, exception_id, subject_id from machvon.sod_exception_use where record_id = $1::uuid`,
        [id],
      );
      expect(uses).toEqual([{ outcome: 'WARNED', ...PAIR, scope: 'SAME_CONTRACT', command: 'verifyPaymentRequest', member_id: memberId(APPROVER), exception_id: null, subject_id: world.contract.contractId }]);
      const audit = await call('GET', '/audit-sod/uses?outcome=WARNED', { member: AUDITOR });
      expect(audit.status).toBe(200);
      expect((audit.json.items as Array<{ record_id: string }>).map((item) => item.record_id)).toContain(id);
    });

    it('leaves no trace when a person who holds no conflicting duty checks the request', async () => {
      const { id } = await sent();
      const checked = await verify(OTHER_CHECKER, id);
      expect(checked.status).toBe(200);
      expect(await countOf('select count(*) as n from machvon.sod_exception_use where record_id = $1::uuid', [id])).toBe(0);
    });
  });

  describe('a pair that blocks, an exception that two other people approve', () => {
    let ruleId = '';
    beforeAll(async () => {
      ruleId = await approveMatrixWithBlock();
    });
    afterAll(async () => {
      await retireMatrix(ruleId);
    });

    it('refuses 422 SOD_VIOLATION naming the two duties and never a person, rolls the command back and keeps the attempt', async () => {
      const { id } = await sent();
      const key = `key-${randomUUID()}`;
      const refused = await verify(APPROVER, id, key);
      expect(refused.status).toBe(422);
      expect(refused.json.code).toBe('SOD_VIOLATION');
      expect(refused.json).toMatchObject({ action_a: PAIR.action_a, action_b: PAIR.action_b, taking: 'payment.verify', held: 'acceptance.approve', scope: 'SAME_CONTRACT', exception_possible: true });
      const body = JSON.stringify(refused.json);
      for (const person of [APPROVER, MAKER, CREATOR, SENDER]) expect(body).not.toContain(memberId(person));
      expect(await statusOf(id)).toBe('SUBMITTED');
      expect(await countOf("select count(*) as n from machvon.sod_exception_use where record_id = $1::uuid and outcome = 'BLOCKED' and member_id = $2::uuid", [id, memberId(APPROVER)])).toBe(1);
      expect(await countOf("select count(*) as n from machvon.audit_event where action = 'sod.violation_blocked' and outcome = 'DENIED' and resource_id = $1::uuid", [id])).toBe(1);
      const again = await verify(APPROVER, id, key);
      expect(again.status).toBe(422);
      expect(again.json.code).toBe('SOD_VIOLATION');
      expect(await countOf("select count(*) as n from machvon.sod_exception_use where record_id = $1::uuid and outcome = 'BLOCKED'", [id])).toBe(1);
    });

    it('lets another checker through: the conflict is the person, not the request', async () => {
      const { id } = await sent();
      expect((await verify(OTHER_CHECKER, id)).status).toBe(200);
      expect(await statusOf(id)).toBe('VERIFIED');
      expect(await countOf('select count(*) as n from machvon.sod_exception_use where record_id = $1::uuid', [id])).toBe(0);
    });

    it('asks, is approved by two people who are neither the one who asked nor the one it covers, and then excuses the command once for each use', async () => {
      const { world, id } = await sent();
      const asked = await request(ASKER, { subject_id: world.contract.contractId });
      expect(asked.status).toBe(200);
      const exceptionId = idOf(asked);
      expect(asked.json).toMatchObject({ status: 'REQUESTED', resource_version: 1 });
      expect(await countOf("select count(*) as n from machvon.audit_event where action = 'sod_exception.requested' and resource_id = $1::uuid", [exceptionId])).toBe(1);
      expect(await countOf("select count(*) as n from machvon.outbox_event where aggregate_id = $1::uuid and type = 'adm.sod_exception.requested.v1'", [exceptionId])).toBe(1);

      // The person it covers and the person who asked have no say; neither has a person twice.
      // The person it covers holds the grant to approve and still has no say.
      const covered = await decide('approve', APPROVER, exceptionId);
      expect(covered.status).toBe(403);
      expect(covered.json.code).toBe('SELF_APPROVAL_DENIED');
      expect((await decide('approve', APPROVE_1, exceptionId)).json).toMatchObject({ status: 'REQUESTED' });
      const twice = await decide('approve', APPROVE_1, exceptionId);
      expect(twice.status).toBe(409);
      expect(twice.json.code).toBe('SOD_EXCEPTION_STATE_INVALID');
      // The exception is not in force yet: the command is still refused.
      expect((await verify(APPROVER, id)).status).toBe(422);
      const second = await decide('approve', APPROVE_2, exceptionId);
      expect(second.json).toMatchObject({ status: 'APPROVED', resource_version: 3 });
      expect(await countOf('select count(*) as n from machvon.sod_exception_approval where exception_id = $1::uuid and decision = $2', [exceptionId, 'APPROVE'])).toBe(2);

      const checked = await verify(APPROVER, id);
      expect(checked.status).toBe(200);
      expect(await statusOf(id)).toBe('VERIFIED');
      const use = await rows<{ outcome: string; exception_id: string | null }>('select outcome, exception_id from machvon.sod_exception_use where record_id = $1::uuid order by used_at, id', [id]);
      // The refusal before the exception was in force stays in the record, and the one use after it names the exception.
      expect(use).toEqual([
        { outcome: 'BLOCKED', exception_id: null },
        { outcome: 'EXCEPTION_USED', exception_id: exceptionId },
      ]);

      const detail = await call('GET', `/sod-exceptions/${exceptionId}`, { member: READER });
      expect(detail.json).toMatchObject({ status: 'APPROVED', approvals: 2, approvers_needed: 2, uses: 1, rule_version: 1 });
      expect((detail.json.decisions as unknown[]).length).toBe(2);
      const audit = await call('GET', `/audit-sod/exceptions?status=APPROVED`, { member: AUDITOR });
      expect((audit.json.items as Array<{ id: string; uses: number }>).find((item) => item.id === exceptionId)?.uses).toBe(1);
      const byException = await call('GET', `/audit-sod/uses?exception_id=${exceptionId}`, { member: AUDITOR });
      expect((byException.json.items as unknown[]).length).toBe(1);

      // Taken back at once: the next request of the same contract is refused again.
      const second2 = await sent();
      const other = await request(ASKER, { subject_id: second2.world.contract.contractId });
      await decide('approve', APPROVE_1, idOf(other));
      await decide('approve', APPROVE_3, idOf(other));
      expect((await decide('revoke', REVOKER, idOf(other))).json).toMatchObject({ status: 'REVOKED' });
      expect((await verify(APPROVER, second2.id)).status).toBe(422);
      expect((await decide('revoke', REVOKER, idOf(other))).status).toBe(409);
    });

    it('is bound to its person, its pair and its subject', async () => {
      const first = await sent();
      const other = await sent();
      const asked = await request(ASKER, { subject_id: first.world.contract.contractId });
      await decide('approve', APPROVE_1, idOf(asked));
      await decide('approve', APPROVE_2, idOf(asked));
      // The exception is for the contract of `first`: the same person is still refused on another contract.
      expect((await verify(APPROVER, other.id)).status).toBe(422);
      expect((await verify(APPROVER, first.id)).status).toBe(200);
    });

    it('ends by the calendar without a write: an exception whose last day has passed excuses nothing and reads as EXPIRED', async () => {
      const { world, id } = await sent();
      const asked = await request(ASKER, { subject_id: world.contract.contractId });
      await decide('approve', APPROVE_1, idOf(asked));
      await decide('approve', APPROVE_2, idOf(asked));
      await fixtures.owner(`update machvon.sod_exception set valid_from = current_date - 9, valid_to = current_date - 2 where id = $1::uuid`, [idOf(asked)]);
      expect((await verify(APPROVER, id)).status).toBe(422);
      const listed = await call('GET', '/sod-exceptions?status=EXPIRED', { member: READER });
      expect((listed.json.items as Array<{ id: string; status: string; stored_status: string }>).find((item) => item.id === idOf(asked))).toMatchObject({ status: 'EXPIRED', stored_status: 'APPROVED' });
      const live = await call('GET', '/sod-exceptions?status=APPROVED', { member: READER });
      expect((live.json.items as Array<{ id: string }>).some((item) => item.id === idOf(asked))).toBe(false);
    });

    it('is not asked for a pair that takes none, for days the pair does not allow or for a subject that is not there', async () => {
      const noException = await request(ASKER, { action_a: 'payment.request', action_b: 'payment.verify', scope: 'SAME_RECORD' });
      expect(noException.status).toBe(422);
      expect(noException.json.code).toBe('SOD_EXCEPTION_WINDOW_INVALID');
      const tooLong = await request(ASKER, { valid_to: day(14) });
      expect(tooLong.status).toBe(422);
      expect(tooLong.json.code).toBe('SOD_EXCEPTION_WINDOW_INVALID');
      expect((await request(ASKER, { valid_from: day(-1), valid_to: day(2) })).json.code).toBe('SOD_EXCEPTION_WINDOW_INVALID');
      expect((await request(ASKER, { action_a: 'payment.verify', action_b: 'acceptance.approve' })).status).toBe(422);
      expect((await request(ASKER, { scope: 'SAME_PLANET' })).status).toBeGreaterThanOrEqual(400);
      const missing = await request(ASKER, { subject_id: randomUUID() });
      expect(missing.status).toBe(404);
      expect(missing.json).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    });

    it('holds one live exception for a person, pair and subject at a time, and keeps the answer of a replayed key', async () => {
      const world = await approved();
      const key = `key-${randomUUID()}`;
      const first = await request(ASKER, { subject_id: world.contract.contractId }, key);
      expect(first.status).toBe(200);
      const replay = await request(ASKER, { subject_id: world.contract.contractId }, key);
      expect(idOf(replay)).toBe(idOf(first));
      const overlap = await request(ASKER, { subject_id: world.contract.contractId, valid_from: day(3), valid_to: day(8) });
      expect(overlap.status).toBe(409);
      expect(overlap.json.code).toBe('SOD_EXCEPTION_STATE_INVALID');
      expect(await countOf('select count(*) as n from machvon.sod_exception where subject_id = $1::uuid', [world.contract.contractId])).toBe(1);
    });

    it('does not let the person who asked approve or reject their own request', async () => {
      const world = await approved();
      const id = idOf(await request(BOTH, { subject_id: world.contract.contractId }));
      for (const what of ['approve', 'reject'] as const) {
        const own = await decide(what, BOTH, id);
        expect(own.status).toBe(403);
        expect(own.json.code).toBe('SELF_APPROVAL_DENIED');
      }
      expect(await countOf('select count(*) as n from machvon.sod_exception_approval where exception_id = $1::uuid', [id])).toBe(0);
    });

    it('is rejected by one eligible person and then takes no approval; a stale version is refused', async () => {
      const world = await approved();
      const asked = await request(ASKER, { subject_id: world.contract.contractId });
      const id = idOf(asked);
      const stale = await call('POST', `/sod-exceptions/${id}/approve`, { member: APPROVE_1, ifMatch: '"9"', body: {} });
      expect(stale.status).toBe(409);
      expect(stale.json.code).toBe('VERSION_CONFLICT');
      expect((await decide('reject', APPROVE_1, id)).json).toMatchObject({ status: 'REJECTED' });
      const after = await decide('approve', APPROVE_2, id);
      expect(after.status).toBe(409);
      expect(after.json.code).toBe('SOD_EXCEPTION_STATE_INVALID');
      expect(await countOf("select count(*) as n from machvon.audit_event where action = 'sod_exception.rejected' and resource_id = $1::uuid", [id])).toBe(1);
    });

    it('is decided only by a holder of the grant on the whole tenant', async () => {
      const world = await approved();
      const id = idOf(await request(ASKER, { subject_id: world.contract.contractId }));
      expect((await request(NOBODY)).status).toBe(403);
      expect((await request(READER)).status).toBe(403);
      for (const member of [NOBODY, READER, ASKER, REVOKER]) expect((await decide('approve', member, id)).status).toBe(403);
      for (const member of [NOBODY, READER, APPROVE_1]) expect((await decide('revoke', member, id)).status).toBe(403);
      // Reading the register is not reading the audit view: the grants are different.
      expect((await call('GET', '/audit-sod/uses', { member: READER })).status).toBe(403);
      expect((await call('GET', '/audit-sod/exceptions', { member: READER })).status).toBe(403);
      expect((await call('GET', '/sod-exceptions', { member: AUDITOR })).status).toBe(403);
    });
  });

  describe('a source that cannot be read', () => {
    it('is 503 SOD_CHECK_UNAVAILABLE and the command is refused, never passed as no conflict', async () => {
      const { id } = await sent();
      await fixtures.owner('alter table machvon.acceptance rename column decided_by to decided_by_unreadable');
      try {
        const refused = await verify(APPROVER, id);
        expect(refused.status).toBe(503);
        expect(refused.json.code).toBe('SOD_CHECK_UNAVAILABLE');
      } finally {
        await fixtures.owner('alter table machvon.acceptance rename column decided_by_unreadable to decided_by');
      }
      expect(await statusOf(id)).toBe('SUBMITTED');
      expect((await verify(APPROVER, id)).status).toBe(200);
    });
  });

  describe('the database says it again', () => {
    it('refuses an approver who asked or is covered, and an approval that the counter does not match', async () => {
      const world = await approved();
      const id = idOf(await request(ASKER, { subject_id: world.contract.contractId }));
      await expect(fixtures.as((tx) => tx.query(`insert into machvon.sod_exception_approval (tenant_id, exception_id, approver_id, decision) values ($1, $2::uuid, $3::uuid, 'APPROVE')`, [TENANT_A, id, memberId(ASKER)]), ASKER)).rejects.toThrow();
      await expect(fixtures.as((tx) => tx.query(`insert into machvon.sod_exception_approval (tenant_id, exception_id, approver_id, decision) values ($1, $2::uuid, $3::uuid, 'APPROVE')`, [TENANT_A, id, memberId(APPROVER)]), ASKER)).rejects.toThrow();
      await expect(fixtures.as((tx) => tx.query(`update machvon.sod_exception set status = 'APPROVED', approvals = 2, decided_at = now() where id = $1::uuid`, [id]), ASKER)).rejects.toThrow();
      await expect(fixtures.as((tx) => tx.query(`update machvon.sod_exception set reason = 'Another reason entirely' where id = $1::uuid`, [id]), ASKER)).rejects.toThrow();
      await expect(fixtures.as((tx) => tx.query(`delete from machvon.sod_exception where id = $1::uuid`, [id]), ASKER)).rejects.toThrow();
      await expect(fixtures.as((tx) => tx.query(`update machvon.sod_exception_approval set comment = 'x'`, []), ASKER)).rejects.toThrow();
    });
  });
});
