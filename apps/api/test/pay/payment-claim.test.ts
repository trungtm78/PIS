import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { payModule } from '../../src/modules/pay';
import { PaymentClaimController } from '../../src/modules/pay/payment-claim.controller';
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
const MAKER = 11; // payment.create, payment.document.attach, payment.submit, payment_request.read
const CHECKER = 12; // payment.verify, payment.return, payment_request.read
const READER = 13; // payment_request.read
const SENDER = 14; // payment.create, payment.document.attach, payment.submit, payment.verify: may also check, but not what they drew up or sent
const MEMBERS = [MAKER, CHECKER, READER, SENDER];

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('sending, checking and returning a payment request over HTTP (ST-PAY-003)', () => {
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
  const audits = (resourceId: string, action: string) => rows<{ safe_diff: Record<string, unknown>; actor_id: string; reason: string | null }>('select safe_diff, actor_id, reason from machvon.audit_event where resource_id = $1 and action = $2 order by occurred_at, id', [resourceId, action]);
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown>; aggregate_version: string }>('select payload, aggregate_version::text as aggregate_version from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at, id', [aggregateId, type]);
  const ledger = async (contractId: string) => {
    const [row] = await rows<{ requested: string; kinds: string[] }>(
      `select coalesce((select sum(requested_vnd) from machvon.cumulative_ledger where contract_id = $1::uuid), 0)::text as requested,
              coalesce((select array_agg(entry_kind order by created_at, id) from machvon.cumulative_ledger_entry where contract_id = $1::uuid), '{}') as kinds`,
      [contractId],
    );
    return row as { requested: string; kinds: string[] };
  };

  /** A contract with an approved acceptance worth 3bn, a party whose work is worth 10bn and an advance of 2bn paid, so a request is worth gross 3bn, recovery 750m, retention 150m, net 2.1bn. */
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
  /** A draft with its invoice, ready to send; the answer of the draft carries its id and version. */
  async function drafted(member = MAKER, target?: ApprovedAcceptance): Promise<{ target: ApprovedAcceptance; id: string }> {
    const world = target ?? (await approved());
    counter += 1;
    const made = await call('POST', '/payment-requests', {
      member,
      body: { contract_id: world.contract.contractId, request_kind: 'INTERIM', acceptance_id: world.acceptance.id, allocation_line_id: fixtures.lineId, request_no: `DNTT-C-${String(counter).padStart(4, '0')}` },
    });
    expect(made.status).toBe(200);
    const id = made.json.resource_id as string;
    const invoice = { document_version_id: (await fixtures.documentVersion()).id, doc_kind: 'INVOICE', invoice_no: `INV-${randomUUID().slice(0, 8)}`, invoice_date: '2026-07-01' };
    expect((await call('POST', `/payment-requests/${id}/documents`, { member, body: invoice })).status).toBe(200);
    return { target: world, id };
  }
  /** The version a command is made against: a number as given, or the one the row has now (the figures a person saw). */
  const versionOf = async (id: string, version: number | string): Promise<string> => (version === 'current' ? ((await rows<{ version: string }>('select version::text as version from machvon.payment_request where id = $1::uuid', [id]))[0]?.version ?? '0') : String(version));
  const submit = async (member: number, id: string, version: number | string, extra: Record<string, unknown> = {}, key?: string) =>
    call('POST', `/payment-requests/${id}/submit`, { member, ifMatch: `"${await versionOf(id, version)}"`, ...(key === undefined ? {} : { key }), body: { expected_gross_vnd: '3000000000', expected_net_vnd: '2100000000', ...extra } });
  const verify = async (member: number, id: string, version: number | string, note?: string) => call('POST', `/payment-requests/${id}/verify`, { member, ifMatch: `"${await versionOf(id, version)}"`, body: note === undefined ? {} : { note } });
  const giveBack = async (member: number, id: string, version: number | string, body: Record<string, unknown> = { reason: 'The invoice does not match the acceptance.' }) => call('POST', `/payment-requests/${id}/return`, { member, ifMatch: `"${await versionOf(id, version)}"`, body });
  const statusOf = async (id: string) => (await rows<{ status: string; claims_acceptance: boolean }>('select status, claims_acceptance from machvon.payment_request where id = $1::uuid', [id]))[0];

  beforeAll(async () => {
    await fixtures.start();
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedRole(TENANT_A, 101, 'PAY_MAKER', ['payment.create', 'payment.document.attach', 'payment.submit', 'payment_request.read'], 30);
    await harness.seedRole(TENANT_A, 102, 'PAY_CHECKER', ['payment.verify', 'payment.return', 'payment_request.read'], 40);
    await harness.seedRole(TENANT_A, 103, 'PAY_READER', ['payment_request.read'], 10);
    await harness.seedRole(TENANT_A, 104, 'PAY_BOTH', ['payment.create', 'payment.document.attach', 'payment.submit', 'payment.verify', 'payment.return', 'payment_request.read'], 50);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MAKER, role: 101, kind: 'TENANT' },
      { n: 2, member: CHECKER, role: 102, kind: 'TENANT' },
      { n: 3, member: READER, role: 103, kind: 'TENANT' },
      { n: 4, member: SENDER, role: 104, kind: 'TENANT' },
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [PaymentRequestController, PaymentClaimController, PaymentRequestReadsController],
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
    expect(payModule.controllers).toEqual(expect.arrayContaining([PaymentClaimController]));
  });

  it('AC-ST-PAY-003-6, UAT-AC399: sends the request, takes the claim and puts it on the books; the same key answers the same, audited and told once', async () => {
    const { target, id } = await drafted();
    const before = await versionOf(id, 'current');
    const sent = await submit(MAKER, id, before, {}, 'submit-once-for-this-key');
    expect(sent).toMatchObject({ status: 200, json: { status: 'SUBMITTED', gross_vnd: '3000000000', advance_recovery_vnd: '750000000', retention_vnd: '150000000', net_vnd: '2100000000' } });
    expect(await submit(MAKER, id, before, {}, 'submit-once-for-this-key')).toEqual(sent);
    expect(await statusOf(id)).toEqual({ status: 'SUBMITTED', claims_acceptance: true });
    expect(await ledger(target.contract.contractId)).toMatchObject({ requested: '3000000000' });
    expect((await ledger(target.contract.contractId)).kinds.filter((kind) => kind === 'CLAIM')).toHaveLength(2);
    expect(await audits(id, 'payment_request.submitted')).toHaveLength(1);
    const told = await events(id, 'pay.payment_request.submitted.v1');
    expect(told).toHaveLength(1);
    expect(told[0]?.payload).toMatchObject({ payment_request_id: id, status: 'SUBMITTED', from_status: 'DRAFT', gross_vnd: '3000000000', net_vnd: '2100000000', actor_id: memberId(MAKER) });
    // The same key with other figures is not the same command.
    expect(await submit(MAKER, id, before, { expected_net_vnd: '1' }, 'submit-once-for-this-key')).toMatchObject({ status: 409, json: { code: 'IDEMPOTENCY_CONFLICT' } });
  });

  it('refuses a request that is stale, has no invoice or is not a draft, and puts nothing on the books', async () => {
    const { target, id } = await drafted();
    expect(await submit(MAKER, id, 'current', { expected_net_vnd: '2000000000' })).toMatchObject({ status: 422, json: { code: 'PAYMENT_NET_MISMATCH' } });
    expect(await submit(MAKER, id, 2)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    expect(await submit(MAKER, id, 'current', { expected_gross_vnd: '-1' })).toMatchObject({ status: 422 });
    const bare = await call('POST', '/payment-requests', {
      member: MAKER,
      body: { contract_id: target.contract.contractId, request_kind: 'INTERIM', acceptance_id: target.acceptance.id, allocation_line_id: fixtures.lineId, request_no: 'DNTT-NO-INVOICE' },
    });
    expect(await submit(MAKER, bare.json.resource_id as string, 1)).toMatchObject({ status: 422, json: { code: 'INVOICE_REQUIRED' } });
    expect(await ledger(target.contract.contractId)).toMatchObject({ requested: '0' });
    expect(await statusOf(id)).toEqual({ status: 'DRAFT', claims_acceptance: false });
  });

  it('AC-ST-PAY-003-1, UAT-AC320: of two requests for one acceptance sent together under two keys, one is sent and the other is told the acceptance is claimed', async () => {
    const world = await approved();
    const first = await drafted(MAKER, world);
    const second = await drafted(SENDER, world);
    const replies = await Promise.all([submit(MAKER, first.id, 'current'), submit(SENDER, second.id, 'current')]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
    expect(replies.find((reply) => reply.status === 409)?.json).toMatchObject({ code: 'ACCEPTANCE_ALREADY_CLAIMED' });
    expect(await rows('select id from machvon.payment_request where acceptance_id = $1::uuid and claims_acceptance', [world.acceptance.id])).toHaveLength(1);
    // Nothing is counted twice: the contract is requested once.
    expect(await ledger(world.contract.contractId)).toMatchObject({ requested: '3000000000' });
  });

  it('AC-ST-PAY-003-5, UAT-AC332: the one who drew a request up or sent it does not check it; another with the right does, and the checking is audited', async () => {
    const { id } = await drafted(SENDER);
    expect((await submit(SENDER, id, 'current')).status).toBe(200);
    expect(await verify(SENDER, id, 'current')).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
    const approvedByOther = await drafted(MAKER);
    expect((await submit(MAKER, approvedByOther.id, 'current')).status).toBe(200);
    expect(await verify(MAKER, approvedByOther.id, 'current')).toMatchObject({ status: 403 });
    expect(await verify(READER, approvedByOther.id, 'current')).toMatchObject({ status: 403 });
    expect(await verify(SENDER, approvedByOther.id, 'current')).toMatchObject({ status: 200, json: { status: 'VERIFIED' } });
    const checked = await verify(CHECKER, id, 'current', 'The documents are complete.');
    expect(checked).toMatchObject({ status: 200, json: { status: 'VERIFIED', resource_version: 3 } });
    const [audit] = await audits(id, 'payment_request.verified');
    expect(audit).toMatchObject({ actor_id: memberId(CHECKER), reason: 'The documents are complete.', safe_diff: { from_status: 'SUBMITTED', to_status: 'VERIFIED' } });
    expect((await events(id, 'pay.payment_request.verified.v1'))[0]?.payload).toMatchObject({ status: 'VERIFIED', actor_id: memberId(CHECKER) });
    expect(await verify(CHECKER, id, 'current')).toMatchObject({ status: 409, json: { code: 'PAYMENT_STATE_INVALID' } });
    const read = await call('GET', `/resources/payment_request/${id}`, { member: CHECKER });
    expect(read.json).toMatchObject({ status: 'VERIFIED', submitted_by: memberId(SENDER), verified_by: memberId(CHECKER), verification_note: 'The documents are complete.' });
  });

  it('AC-ST-PAY-003-3, UAT-AC322: giving a request back releases the claim, the retention and the recovery with entries that reverse them, and it can be sent again', async () => {
    const { target, id } = await drafted();
    expect((await submit(MAKER, id, 'current')).status).toBe(200);
    expect(await giveBack(READER, id, 'current')).toMatchObject({ status: 403 });
    expect(await giveBack(CHECKER, id, 'current', { reason: '  ' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    const returned = await giveBack(CHECKER, id, 'current');
    expect(returned).toMatchObject({ status: 200, json: { status: 'RETURNED' } });
    expect(await statusOf(id)).toEqual({ status: 'RETURNED', claims_acceptance: false });
    expect(await ledger(target.contract.contractId)).toMatchObject({ requested: '0' });
    const [audit] = await audits(id, 'payment_request.returned');
    expect(audit).toMatchObject({ actor_id: memberId(CHECKER), reason: 'The invoice does not match the acceptance.' });
    expect((await events(id, 'pay.payment_request.returned.v1'))[0]?.payload).toMatchObject({ status: 'RETURNED', from_status: 'SUBMITTED' });
    expect(await giveBack(CHECKER, id, 'current')).toMatchObject({ status: 409, json: { code: 'PAYMENT_STATE_INVALID' } });
    // Back in the drafter's hands: corrected, it is a draft again, and sent again it takes the claim again.
    expect(await call('POST', `/payment-requests/${id}/draft`, { member: MAKER, ifMatch: `"${await versionOf(id, 'current')}"`, body: { request_no: `DNTT-C-AGAIN-${id.slice(0, 6)}` } })).toMatchObject({ status: 200, json: { status: 'DRAFT' } });
    expect((await submit(MAKER, id, 'current')).status).toBe(200);
    expect(await ledger(target.contract.contractId)).toMatchObject({ requested: '3000000000' });
    // A request the Treasury sent back is given back only as the Treasury's.
    expect((await verify(CHECKER, id, 'current')).status).toBe(200);
    await fixtures.sendToTreasury(id);
    expect(await giveBack(CHECKER, id, 'current')).toMatchObject({ status: 409, json: { code: 'PAYMENT_STATE_INVALID' } });
    expect(await giveBack(CHECKER, id, 'current', { reason: 'Rejected by the Treasury.', returned_by_treasury: true })).toMatchObject({ status: 200, json: { status: 'RETURNED' } });
    expect(await ledger(target.contract.contractId)).toMatchObject({ requested: '0' });
  });

  it('shows the buttons the caller may press and no other, and never to a stranger', async () => {
    const { id } = await drafted();
    const actions = async (member: number) => (await call('GET', `/resources/payment_request/${id}`, { member })).json.actions;
    expect(await actions(MAKER)).toMatchObject({ submit: true, verify: false, return: false });
    expect(await actions(READER)).toMatchObject({ submit: false, verify: false, return: false });
    expect((await submit(MAKER, id, 'current')).status).toBe(200);
    expect(await actions(MAKER)).toMatchObject({ submit: false, verify: false, return: false });
    expect(await actions(CHECKER)).toMatchObject({ submit: false, verify: true, return: true });
    expect(await actions(READER)).toMatchObject({ verify: false, return: false });
    const unknown = randomUUID();
    expect(await submit(MAKER, unknown, 1)).toMatchObject({ status: 404 });
    expect(await verify(CHECKER, unknown, 1)).toMatchObject({ status: 404 });
    expect(await giveBack(CHECKER, unknown, 1)).toMatchObject({ status: 404 });
  });
});
