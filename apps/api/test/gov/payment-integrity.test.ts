import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, PayIntegrityAlertSource, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { payModule } from '../../src/modules/pay';
import { PaymentClaimController } from '../../src/modules/pay/payment-claim.controller';
import { PaymentIntegrityController, PaymentIntegrityReadsController } from '../../src/modules/pay/payment-integrity.controller';
import { PaymentRequestController, PaymentRequestReadsController } from '../../src/modules/pay/payment-request.controller';
import { TENANT_A, memberId } from '../../../../packages/db/test/support/authz-fixtures';
import { AcceptanceWorld } from '../../../../packages/db/test/support/acceptance-fixtures';
import type { ApprovedAcceptance } from '../../../../packages/db/test/support/acceptance-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(480_000);

const SIGNING_KEY = randomBytes(32);
const ROOT = 1;
const MAKER = 11; // draws up, sends, checks the request before sending and asks for an exception
const CHECKER = 12; // reads the checks, decides exceptions (not the ones of requests he drew up or sent)
const READER = 13; // payment_request.read only
const SENDER = 14; // draws up, sends and may also decide an exception: not on a request he drew up or sent, and not one he asked for
const AUDITOR = 15; // reads the findings of every run
const MEMBERS = [MAKER, CHECKER, READER, SENDER, AUDITOR];

interface Reply {
  status: number;
  json: Record<string, unknown>;
}
type Item = Record<string, unknown>;

const dayPlus = (days: number): string => new Date(Date.now() + 7 * 3_600_000 + days * 86_400_000).toISOString().slice(0, 10);

describe('payment integrity checks and the exceptions to the ceilings of disbursement over HTTP (G4-2, G4-5)', () => {
  const fixtures = new AcceptanceWorld();
  const harness = fixtures.harness;
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
  const audits = (resourceId: string, action: string) => rows<{ safe_diff: Record<string, unknown> }>('select safe_diff from machvon.audit_event where resource_id = $1 and action = $2 order by occurred_at, id', [resourceId, action]);
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at, id', [aggregateId, type]);
  const runsOf = (requestId: string) =>
    rows<{ id: string; trigger_kind: string; outcome: string; rule_version: number; rule_source: string; rule_unverified: boolean; invariant_count: number; signal_count: number; excused_count: number; unavailable: string[] }>(
      'select id, trigger_kind, outcome, rule_version, rule_source, rule_unverified, invariant_count, signal_count, excused_count, unavailable from machvon.payment_integrity_run where payment_request_id = $1::uuid order by created_at, id',
      [requestId],
    );
  const findingsOf = (requestId: string) =>
    rows<{ code: string; kind: string; severity: string; excused: boolean; exception_id: string | null; params: Item }>(
      'select code, kind, severity, excused, exception_id, params from machvon.payment_integrity_finding where payment_request_id = $1::uuid order by created_at, code, id',
      [requestId],
    );
  /** A fixture that the commands would never allow (an accepted value or a price changed behind the back of the rules): written with the triggers of the table off, on its own connection. */
  const tamper = (table: string, sql: string, params: unknown[] = []) => harness.owner(TENANT_A, [[`alter table machvon.${table} disable trigger user`], [sql, params], [`alter table machvon.${table} enable trigger user`]]);
  const statusOf = async (id: string) => (await rows<{ status: string; claims_acceptance: boolean }>('select status, claims_acceptance from machvon.payment_request where id = $1::uuid', [id]))[0];
  const ledgerRequested = async (contractId: string) => (await rows<{ requested: string }>('select coalesce(sum(requested_vnd), 0)::text as requested from machvon.cumulative_ledger where contract_id = $1::uuid', [contractId]))[0]?.requested;
  const versionOf = async (table: string, id: string): Promise<string> => (await rows<{ version: string }>(`select version::text as version from machvon.${table} where id = $1::uuid`, [id]))[0]?.version ?? '0';

  /** An approved acceptance worth 3bn on a contract of 9bn, a party whose work is worth 10bn and an advance of 2bn paid, so a request is gross 3bn, recovery 750m, retention 150m, net 2.1bn. */
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
  /** A draft with its invoice, ready to send. */
  async function drafted(member = MAKER, invoiceNo?: string, target?: ApprovedAcceptance): Promise<{ target: ApprovedAcceptance; id: string }> {
    const world = target ?? (await approved());
    counter += 1;
    const made = await call('POST', '/payment-requests', {
      member,
      body: { contract_id: world.contract.contractId, request_kind: 'INTERIM', acceptance_id: world.acceptance.id, allocation_line_id: fixtures.lineId, request_no: `DNTT-I-${String(counter).padStart(4, '0')}` },
    });
    expect(made.status).toBe(200);
    const id = made.json.resource_id as string;
    const invoice = { document_version_id: (await fixtures.documentVersion()).id, doc_kind: 'INVOICE', invoice_no: invoiceNo ?? `INV-${randomUUID().slice(0, 8)}`, invoice_date: `2026-08-${String(1 + (counter % 27)).padStart(2, '0')}` };
    expect((await call('POST', `/payment-requests/${id}/documents`, { member, body: invoice })).status).toBe(200);
    return { target: world, id };
  }
  const submit = async (member: number, id: string, key?: string) =>
    call('POST', `/payment-requests/${id}/submit`, { member, ifMatch: `"${await versionOf('payment_request', id)}"`, ...(key === undefined ? {} : { key }), body: { expected_gross_vnd: '3000000000', expected_net_vnd: '2100000000' } });
  const preview = (member: number, id: string) => call('POST', `/payment-requests/${id}/integrity-checks`, { member, body: {} });
  const askException = (member: number, id: string, body: Record<string, unknown>) => call('POST', `/payment-requests/${id}/disbursement-exceptions`, { member, body });
  const decide = async (member: number, id: string, move: 'approve' | 'reject' | 'revoke', body: Record<string, unknown> = {}) =>
    call('POST', `/disbursement-exceptions/${id}/${move}`, { member, ifMatch: `"${await versionOf('disbursement_exception', id)}"`, body });

  beforeAll(async () => {
    await fixtures.start();
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedRole(TENANT_A, 111, 'PAY_MAKER_G', ['payment.create', 'payment.document.attach', 'payment.submit', 'payment_request.read', 'payment.integrity.check', 'payment.integrity.read', 'disbursement.exception.request', 'disbursement.exception.read'], 30);
    await harness.seedRole(TENANT_A, 112, 'PAY_CHECKER_G', ['payment.verify', 'payment_request.read', 'payment.integrity.read', 'disbursement.exception.read', 'disbursement.exception.approve', 'disbursement.exception.reject', 'disbursement.exception.revoke'], 40);
    await harness.seedRole(TENANT_A, 113, 'PAY_READER_G', ['payment_request.read'], 10);
    await harness.seedRole(
      TENANT_A,
      114,
      'PAY_BOTH_G',
      ['payment.create', 'payment.document.attach', 'payment.submit', 'payment_request.read', 'payment.integrity.read', 'disbursement.exception.read', 'disbursement.exception.approve', 'disbursement.exception.reject', 'disbursement.exception.revoke'],
      50,
    );
    await harness.seedRole(TENANT_A, 115, 'AUDITOR_G', ['payment.integrity.audit.read'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MAKER, role: 111, kind: 'TENANT' },
      { n: 2, member: CHECKER, role: 112, kind: 'TENANT' },
      { n: 3, member: READER, role: 113, kind: 'TENANT' },
      { n: 4, member: SENDER, role: 114, kind: 'TENANT' },
      { n: 5, member: AUDITOR, role: 115, kind: 'TENANT' },
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [PaymentRequestController, PaymentClaimController, PaymentRequestReadsController, PaymentIntegrityController, PaymentIntegrityReadsController],
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

  it('is registered in the module of PAY', () => {
    expect(payModule.controllers).toEqual(expect.arrayContaining([PaymentIntegrityController, PaymentIntegrityReadsController]));
  });

  it('a request with nothing wrong is sent as before; the run is kept with the rule that decided, and a source that cannot be read is told, never passed', async () => {
    const { id } = await drafted();
    expect((await submit(MAKER, id)).status).toBe(200);
    expect(await statusOf(id)).toMatchObject({ status: 'SUBMITTED' });
    const [run] = await runsOf(id);
    // The built-in default of the rule, flagged as not confirmed; the working calendar of the diary is not published in this world, so the diary was not read and the run is not PASSED.
    expect(run).toMatchObject({ trigger_kind: 'SUBMIT', outcome: 'PARTIAL', rule_version: 0, rule_source: 'DEFAULT', rule_unverified: true, invariant_count: 0, signal_count: 0, unavailable: ['DIARY'] });
    const read = await call('GET', `/payment-requests/${id}/integrity-checks`, { member: CHECKER });
    expect(read.status).toBe(200);
    expect(read.json).toMatchObject({ payment_request_id: id, request_status: 'SUBMITTED', run: { outcome: 'PARTIAL', unavailable: ['DIARY'], rule: { type: 'PAYMENT_INTEGRITY', code: 'DEFAULT', version: 0, source: 'DEFAULT', unverified: true } } });
    expect((read.json.run as Item).rule).toMatchObject({ formula: expect.any(String), origin: expect.any(String), as_of: expect.any(String) });
    expect(await audits(id, 'payment_request.integrity_signals')).toHaveLength(1);
  });

  it('the same invoice of the same supplier for the same amount is a duplicate: refused 422 with the findings kept for the auditor, the request left a draft, the same key answering the same', async () => {
    const first = await drafted(MAKER, 'INV-DUP-001');
    expect((await submit(MAKER, first.id)).status).toBe(200);
    const second = await drafted(MAKER, 'inv dup 001');
    const before = await ledgerRequested(second.target.contract.contractId);
    const refused = await submit(MAKER, second.id, 'duplicate-key-once-1234');
    expect(refused).toMatchObject({ status: 422, json: { code: 'DUPLICATE_CLAIM' } });
    expect(JSON.stringify(refused.json)).not.toContain(first.id);
    expect(await statusOf(second.id)).toEqual({ status: 'DRAFT', claims_acceptance: false });
    expect(await ledgerRequested(second.target.contract.contractId)).toBe(before);
    const [run] = await runsOf(second.id);
    expect(run).toMatchObject({ trigger_kind: 'SUBMIT', outcome: 'BLOCKED', invariant_count: 1, excused_count: 0 });
    const found = (await findingsOf(second.id)).find((one) => one.kind === 'INVARIANT');
    expect(found).toMatchObject({ code: 'DUPLICATE_CLAIM', kind: 'INVARIANT', severity: 'BLOCK', excused: false, params: { matched: ['NUMBER', 'SUPPLIER', 'AMOUNT'] } });
    expect(await audits(second.id, 'payment_request.integrity_blocked')).toHaveLength(1);
    expect(await events(second.id, 'pay.payment_request.integrity_blocked.v1')).toHaveLength(1);
    // The same key is the same answer and writes nothing more; a new key is a new attempt with a new run.
    const replayed = await submit(MAKER, second.id, 'duplicate-key-once-1234');
    expect({ status: replayed.status, json: { ...replayed.json, correlationId: undefined } }).toEqual({ status: refused.status, json: { ...refused.json, correlationId: undefined } });
    expect(await runsOf(second.id)).toHaveLength(1);
    expect(await submit(MAKER, second.id)).toMatchObject({ status: 422, json: { code: 'DUPLICATE_CLAIM' } });
    expect(await runsOf(second.id)).toHaveLength(2);
    // The approver who reads the checks of the draft sees the twin only when the twin is in his scope (here it is).
    const read = await call('GET', `/payment-requests/${second.id}/integrity-checks`, { member: CHECKER });
    expect(((read.json.run as Item).findings as Item[])[0]).toMatchObject({ code: 'DUPLICATE_CLAIM', subject: { other_request_id: first.id } });
  });

  it('asking for the checks of a draft keeps a run of its own (PREVIEW) and changes nothing else', async () => {
    const { id } = await drafted();
    const answered = await preview(MAKER, id);
    expect(answered).toMatchObject({ status: 200, json: { outcome: 'PARTIAL', invariant_count: 0, signal_count: 0, unavailable: ['DIARY'], resource_id: id } });
    expect(await runsOf(id)).toMatchObject([{ trigger_kind: 'PREVIEW' }]);
    expect(await statusOf(id)).toMatchObject({ status: 'DRAFT' });
    expect(await events(id, 'pay.payment_request.integrity_checked.v1')).toHaveLength(1);
    expect((await preview(READER, id)).status).toBe(403);
    expect((await preview(MAKER, randomUUID())).status).toBe(404);
  });

  it('what is asked for above the accepted value is refused and has no exception', async () => {
    const { id } = await drafted();
    const row = (await rows<{ acceptance_id: string }>('select acceptance_id from machvon.payment_request where id = $1::uuid', [id]))[0];
    await tamper('acceptance', 'update machvon.acceptance set accepted_amount_vnd = 2000000000 where id = $1::uuid', [row?.acceptance_id]);
    expect(await submit(MAKER, id)).toMatchObject({ status: 422, json: { code: 'EXCEEDS_ACCEPTED' } });
    expect(await findingsOf(id)).toMatchObject([{ code: 'EXCEEDS_ACCEPTED', kind: 'INVARIANT', params: { accepted_vnd: '2000000000', projected_claimed_vnd: '3000000000', over_by_vnd: '1000000000' } }]);
    // The schema of the request does not know the ceiling of the accepted value: there is no way to ask for one.
    expect((await askException(MAKER, id, { ceiling: 'EXCEEDS_ACCEPTED', allowed_amount_vnd: '1000000000', valid_to: dayPlus(5), reason: 'Please.' })).status).toBeGreaterThanOrEqual(400);
  });

  describe('the ceiling of the contract: cash out with the advances not yet recovered', () => {
    it('is refused, and the exception is asked, approved by someone else, used once and then gone', async () => {
      const { id, target } = await drafted();
      // The advances that are out but not recovered: with this request the cash out would be 250m above the price.
      await fixtures.owner('update machvon.contract set advance_paid_vnd = 7000000000 where id = $1::uuid', [target.contract.contractId]);
      expect(await submit(MAKER, id)).toMatchObject({ status: 422, json: { code: 'EXCEEDS_CONTRACT' } });
      const [blocked] = await findingsOf(id);
      expect(blocked).toMatchObject({ code: 'EXCEEDS_CONTRACT', kind: 'INVARIANT', params: { basis: 'CASH_OUT', price_vnd: '9000000000', over_by_vnd: '250000000' } });
      expect(await statusOf(id)).toEqual({ status: 'DRAFT', claims_acceptance: false });

      // An exception that does not cover how far over it is is not asked for; neither is one beyond the days the rule allows, or in the past, or for a ceiling that does not stand.
      const ask = (over: Record<string, unknown> = {}) => askException(MAKER, id, { ceiling: 'EXCEEDS_CONTRACT', allowed_amount_vnd: '250000000', valid_to: dayPlus(10), reason: 'The works must go on while the advance is recovered.', ...over });
      expect(await ask({ allowed_amount_vnd: '249999999' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await ask({ valid_to: dayPlus(31) })).toMatchObject({ status: 422, json: { code: 'DISBURSEMENT_EXCEPTION_WINDOW_INVALID' } });
      expect(await ask({ valid_to: dayPlus(-1) })).toMatchObject({ status: 422, json: { code: 'DISBURSEMENT_EXCEPTION_WINDOW_INVALID' } });
      expect(await ask({ ceiling: 'EXCEEDS_PLAN' })).toMatchObject({ status: 422, json: { code: 'DISBURSEMENT_EXCEPTION_NOT_NEEDED' } });
      expect((await ask({ reason: '   ' })).status).toBe(422);
      expect((await askException(READER, id, { ceiling: 'EXCEEDS_CONTRACT', allowed_amount_vnd: '1', valid_to: dayPlus(1), reason: 'x' })).status).toBe(403);

      const asked = await ask();
      expect(asked).toMatchObject({ status: 200, json: { status: 'REQUESTED', resource_version: 1 } });
      const exceptionId = asked.json.resource_id as string;
      // One live exception for a request and a ceiling.
      expect(await ask()).toMatchObject({ status: 409, json: { code: 'DISBURSEMENT_EXCEPTION_STATE_INVALID' } });
      expect(await audits(exceptionId, 'disbursement_exception.requested')).toHaveLength(1);
      expect(await events(exceptionId, 'pay.disbursement_exception.requested.v1')).toHaveLength(1);

      // A request that was asked for but not decided covers nothing: still refused, with a run of its own.
      expect(await submit(MAKER, id)).toMatchObject({ status: 422, json: { code: 'EXCEEDS_CONTRACT' } });
      // Two people: not the one who asked (no right either), and not the one who drew up the request.
      expect((await decide(MAKER, exceptionId, 'approve')).status).toBe(403);
      expect((await decide(READER, exceptionId, 'approve')).status).toBe(403);
      const approvedByOther = await decide(CHECKER, exceptionId, 'approve', { note: 'The advance is recovered in the next period.' });
      expect(approvedByOther).toMatchObject({ status: 200, json: { status: 'APPROVED', resource_version: 2 } });
      expect(await decide(CHECKER, exceptionId, 'approve')).toMatchObject({ status: 409, json: { code: 'DISBURSEMENT_EXCEPTION_STATE_INVALID' } });

      const listed = await call('GET', `/disbursement-exceptions?payment_request_id=${id}`, { member: CHECKER });
      expect((listed.json.items as Item[])[0]).toMatchObject({ id: exceptionId, status: 'APPROVED', ceiling: 'EXCEEDS_CONTRACT', allowed_amount_vnd: '250000000', decided_by: memberId(CHECKER) });

      // Sent under the exception: it goes, the finding is kept as covered, the exception is used once.
      const sent = await submit(MAKER, id);
      expect(sent).toMatchObject({ status: 200, json: { status: 'SUBMITTED' } });
      const runs = await runsOf(id);
      const last = runs[runs.length - 1];
      expect(last).toMatchObject({ outcome: 'SIGNALS', invariant_count: 1, excused_count: 1 });
      const lastFindings = (await findingsOf(id)).filter((one) => one.excused);
      expect(lastFindings).toMatchObject([{ code: 'EXCEEDS_CONTRACT', excused: true, exception_id: exceptionId }]);
      expect((await rows<{ status: string; used_run_id: string }>('select status, used_run_id from machvon.disbursement_exception where id = $1::uuid', [exceptionId]))[0]).toMatchObject({ status: 'USED', used_run_id: last?.id });
      expect(await decide(CHECKER, exceptionId, 'revoke', { reason: 'Too late.' })).toMatchObject({ status: 409, json: { code: 'DISBURSEMENT_EXCEPTION_STATE_INVALID' } });
    });

    it('an exception is not valid after its day, and a revoked one covers nothing', async () => {
      const { id, target } = await drafted();
      await fixtures.owner('update machvon.contract set advance_paid_vnd = 7000000000 where id = $1::uuid', [target.contract.contractId]);
      const asked = await askException(MAKER, id, { ceiling: 'EXCEEDS_CONTRACT', allowed_amount_vnd: '300000000', valid_to: dayPlus(3), reason: 'For a few days.' });
      const exceptionId = asked.json.resource_id as string;
      expect((await decide(CHECKER, exceptionId, 'approve')).status).toBe(200);
      // The table itself keeps an exception from ending before it was asked for.
      await expect(fixtures.owner("update machvon.disbursement_exception set valid_to = date '2000-01-01' where id = $1::uuid", [exceptionId])).rejects.toThrow(/disbursement_exception_window_chk/);
      // Its day goes by: the register says EXPIRED and the request is blocked again.
      await fixtures.owner("update machvon.disbursement_exception set requested_at = timestamptz '2019-12-01T00:00:00Z', valid_to = date '2020-01-01' where id = $1::uuid", [exceptionId]);
      expect(await submit(MAKER, id)).toMatchObject({ status: 422, json: { code: 'EXCEEDS_CONTRACT' } });
      const expired = await call('GET', `/disbursement-exceptions?status=EXPIRED&payment_request_id=${id}`, { member: CHECKER });
      expect((expired.json.items as Item[]).map((item) => item.status)).toEqual(['EXPIRED']);

      const other = await drafted(MAKER, undefined, undefined);
      await fixtures.owner('update machvon.contract set advance_paid_vnd = 7000000000 where id = $1::uuid', [other.target.contract.contractId]);
      const second = await askException(MAKER, other.id, { ceiling: 'EXCEEDS_CONTRACT', allowed_amount_vnd: '300000000', valid_to: dayPlus(3), reason: 'Again.' });
      const secondId = second.json.resource_id as string;
      expect((await decide(CHECKER, secondId, 'reject', { reason: '  ' })).status).toBe(422);
      expect((await decide(CHECKER, secondId, 'approve')).status).toBe(200);
      expect(await decide(CHECKER, secondId, 'revoke', { reason: 'The advance was recovered after all.' })).toMatchObject({ status: 200, json: { status: 'REVOKED' } });
      expect(await submit(MAKER, other.id)).toMatchObject({ status: 422, json: { code: 'EXCEEDS_CONTRACT' } });
      // A rejected one is no way through either, and may be asked for again.
      const third = await askException(MAKER, other.id, { ceiling: 'EXCEEDS_CONTRACT', allowed_amount_vnd: '300000000', valid_to: dayPlus(3), reason: 'Third try.' });
      expect(third.status).toBe(200);
      expect(await decide(CHECKER, third.json.resource_id as string, 'reject', { reason: 'No.' })).toMatchObject({ status: 200, json: { status: 'REJECTED' } });
      expect(await submit(MAKER, other.id)).toMatchObject({ status: 422, json: { code: 'EXCEEDS_CONTRACT' } });
    });

    it('whoever drew up the request does not decide the exception, and neither does the one who asked', async () => {
      const { id, target } = await drafted(SENDER);
      await fixtures.owner('update machvon.contract set advance_paid_vnd = 7000000000 where id = $1::uuid', [target.contract.contractId]);
      const asked = await askException(MAKER, id, { ceiling: 'EXCEEDS_CONTRACT', allowed_amount_vnd: '250000000', valid_to: dayPlus(2), reason: 'Four eyes.' });
      expect(asked.status).toBe(200);
      const exceptionId = asked.json.resource_id as string;
      // SENDER holds the right to decide, but drew the request up.
      expect(await decide(SENDER, exceptionId, 'approve')).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect((await rows<{ status: string }>('select status from machvon.disbursement_exception where id = $1::uuid', [exceptionId]))[0]?.status).toBe('REQUESTED');
      expect(await decide(CHECKER, exceptionId, 'approve', undefined)).toMatchObject({ status: 200 });
    });
  });

  describe('the ceiling of the capital plan line', () => {
    it('is refused with how much the line has left, and an approved exception lets the request go through the check of the line once', async () => {
      const { id } = await drafted();
      const balance = (await rows<{ id: string; allocated: string; committed: string; disbursed: string }>('select id, allocated_vnd::text as allocated, committed_vnd::text as committed, disbursed_vnd::text as disbursed from machvon.allocation_balance where allocation_line_id = $1::uuid', [fixtures.lineId]))[0];
      expect(balance).toBeDefined();
      const inFlight = BigInt((await rows<{ net: string }>("select coalesce(sum(net_vnd), 0)::text as net from machvon.payment_request where allocation_line_id = $1::uuid and status in ('SUBMITTED', 'VERIFIED', 'SENT_TREASURY')", [fixtures.lineId]))[0]?.net ?? '0');
      // The line is left with 1bn: the net of the request, 2.1bn, is 1.1bn above it.
      const room = 1_000_000_000n;
      await fixtures.owner('update machvon.allocation_balance set allocated_vnd = $2::numeric where id = $1::uuid', [balance?.id, (BigInt(balance?.committed ?? '0') + BigInt(balance?.disbursed ?? '0') + inFlight + room).toString()]);
      try {
        expect(await submit(MAKER, id)).toMatchObject({ status: 422, json: { code: 'EXCEEDS_PLAN' } });
        const [found] = await findingsOf(id);
        expect(found).toMatchObject({ code: 'EXCEEDS_PLAN', kind: 'INVARIANT', params: { available_vnd: room.toString(), net_vnd: '2100000000', over_by_vnd: '1100000000' } });
        const asked = await askException(MAKER, id, { ceiling: 'EXCEEDS_PLAN', allowed_amount_vnd: '1100000000', valid_to: dayPlus(14), reason: 'The reallocation of the line is with the approver.' });
        expect(asked.status).toBe(200);
        const exceptionId = asked.json.resource_id as string;
        expect((await decide(CHECKER, exceptionId, 'approve')).status).toBe(200);
        expect(await submit(MAKER, id)).toMatchObject({ status: 200, json: { status: 'SUBMITTED' } });
        expect(await statusOf(id)).toMatchObject({ status: 'SUBMITTED' });
        expect((await rows<{ status: string }>('select status from machvon.disbursement_exception where id = $1::uuid', [exceptionId]))[0]?.status).toBe('USED');
      } finally {
        await fixtures.owner('update machvon.allocation_balance set allocated_vnd = $2::numeric where id = $1::uuid', [balance?.id, balance?.allocated]);
      }
    });
  });

  it('a price far from the contract is a signal for the approver: the request is sent all the same and the signal is kept', async () => {
    const { id, target } = await drafted();
    // The price of one item of the contract is 25% above what the acceptance says (tolerance 15%).
    await tamper('boq_line', 'update machvon.boq_line set unit_price = 2666666, amount_vnd = 1333333000 where contract_id = $1::uuid and business_key = $2', [target.contract.contractId, 'B02']);
    expect((await submit(MAKER, id)).status).toBe(200);
    const [run] = await runsOf(id);
    expect(run).toMatchObject({ outcome: 'SIGNALS', invariant_count: 0, signal_count: 1 });
    const [found] = await findingsOf(id);
    expect(found).toMatchObject({ code: 'UNIT_PRICE_OUTLIER', kind: 'SIGNAL', severity: 'WARN', excused: false });
    expect(found?.params.reasons).toEqual(['CONTRACT_PRICE']);
    const read = await call('GET', `/payment-requests/${id}/integrity-checks`, { member: CHECKER });
    expect(((read.json.run as Item).findings as Item[])[0]).toMatchObject({ code: 'UNIT_PRICE_OUTLIER', kind: 'SIGNAL' });
    expect(await audits(id, 'payment_request.integrity_signals')).toHaveLength(1);
  });

  it('is read by the approver with the right and by nobody without it; a stranger finds nothing', async () => {
    const { id } = await drafted();
    expect((await call('GET', `/payment-requests/${id}/integrity-checks`, { member: READER })).status).toBe(403);
    const none = await call('GET', `/payment-requests/${id}/integrity-checks`, { member: CHECKER });
    expect(none).toMatchObject({ status: 200, json: { run: null, request_status: 'DRAFT' } });
    expect((await call('GET', `/payment-requests/${randomUUID()}/integrity-checks`, { member: CHECKER })).status).toBe(404);
    expect((await call('GET', '/payment-integrity/findings', { member: CHECKER })).status).toBe(403);
    expect((await call('GET', '/disbursement-exceptions', { member: READER })).status).toBe(403);
  });

  it('the alert centre has the three alert types of the checks: a draft that is blocked, a request sent with signals, an exception about to lapse; and nothing for what was settled', async () => {
    const alerts = new PayIntegrityAlertSource();
    const everything = () => ({ sql: 'true', params: [] as unknown[] });
    const now = new Date();
    const today = new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
    const items = await fixtures.as((tx) => alerts.items(tx, everything, today, 14), CHECKER);
    const kinds = new Set(items.map((item) => item.alertType));
    expect(kinds.has('PAYMENT_INTEGRITY_BLOCKED') && kinds.has('PAYMENT_INTEGRITY_SIGNAL')).toBe(true);
    const blocked = items.find((item) => item.alertType === 'PAYMENT_INTEGRITY_BLOCKED');
    expect(blocked?.detail.codes).toEqual(expect.arrayContaining([expect.stringMatching(/^(DUPLICATE_CLAIM|EXCEEDS_[A-Z]+)$/)]));
    expect((await statusOf(blocked?.paymentRequestId ?? ''))?.status).toBe('DRAFT');
    const signal = items.find((item) => item.alertType === 'PAYMENT_INTEGRITY_SIGNAL');
    expect((await statusOf(signal?.paymentRequestId ?? ''))?.status).toBe('SUBMITTED');
    // An exception that is approved and lapses within the window is the third alert type.
    const { id, target } = await drafted();
    await fixtures.owner('update machvon.contract set advance_paid_vnd = 7000000000 where id = $1::uuid', [target.contract.contractId]);
    const asked = await askException(MAKER, id, { ceiling: 'EXCEEDS_CONTRACT', allowed_amount_vnd: '250000000', valid_to: dayPlus(5), reason: 'About to lapse.' });
    expect((await decide(CHECKER, asked.json.resource_id as string, 'approve')).status).toBe(200);
    const again = await fixtures.as((tx) => alerts.items(tx, everything, today, 7), CHECKER);
    expect(again.find((item) => item.alertType === 'DISBURSEMENT_EXCEPTION_EXPIRING' && item.itemId === asked.json.resource_id)).toMatchObject({ itemId: asked.json.resource_id, paymentRequestId: id, detail: { ceiling: 'EXCEEDS_CONTRACT', days_left: 5 } });
    expect((await fixtures.as((tx) => alerts.items(tx, everything, today, 3), CHECKER)).some((item) => item.alertType === 'DISBURSEMENT_EXCEPTION_EXPIRING' && item.itemId === asked.json.resource_id)).toBe(false);
    // A scope that reaches nothing sees nothing.
    expect(await fixtures.as((tx) => alerts.items(tx, () => ({ sql: 'false', params: [] }), today, 14), CHECKER)).toEqual([]);
  });

  it('the auditor reads the findings of every run, filtered and in pages, and nobody can rewrite or delete one', async () => {
    const all = await call('GET', '/payment-integrity/findings?limit=200', { member: AUDITOR });
    expect(all.status).toBe(200);
    const items = all.json.items as Item[];
    expect(items.length).toBeGreaterThanOrEqual(5);
    expect(new Set(items.map((item) => item.code))).toEqual(expect.objectContaining(new Set(['DUPLICATE_CLAIM', 'EXCEEDS_ACCEPTED', 'EXCEEDS_CONTRACT', 'EXCEEDS_PLAN', 'UNIT_PRICE_OUTLIER'])));
    expect(items[0]).toMatchObject({ contract_code: expect.any(String), project_code: expect.any(String), trigger: expect.any(String), rule_version: 0 });
    const dup = await call('GET', '/payment-integrity/findings?code=DUPLICATE_CLAIM&kind=INVARIANT', { member: AUDITOR });
    expect((dup.json.items as Item[]).every((item) => item.code === 'DUPLICATE_CLAIM' && item.kind === 'INVARIANT')).toBe(true);
    const first = await call('GET', '/payment-integrity/findings?limit=1', { member: AUDITOR });
    expect((first.json.items as Item[]).length).toBe(1);
    expect(first.json.next_cursor).toEqual(expect.any(String));
    const second = await call('GET', `/payment-integrity/findings?limit=1&cursor=${first.json.next_cursor as string}`, { member: AUDITOR });
    expect((second.json.items as Item[])[0]?.id).not.toBe((first.json.items as Item[])[0]?.id);
    expect((await call('GET', '/payment-integrity/findings?code=NOPE', { member: AUDITOR })).status).toBe(422);
    expect((await call('GET', '/payment-integrity/findings?from=2026-13-40', { member: AUDITOR })).status).toBe(422);
    const sample = items[0] as Item;
    await expect(fixtures.owner('update machvon.payment_integrity_finding set kind = $2 where id = $1::uuid', [sample.id, 'SIGNAL'])).rejects.toThrow(/kept as they were written/);
    await expect(fixtures.owner('delete from machvon.payment_integrity_run where id = $1::uuid', [sample.run_id])).rejects.toThrow(/kept as they were written/);
  });
});
