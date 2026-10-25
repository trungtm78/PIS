import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, PayClaimStore, PayPaymentStore, TenantDatabase } from '@machvon/db';
import type { ContractScopes } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { payModule } from '../../src/modules/pay';
import { PaymentReversalController } from '../../src/modules/pay/payment-reversal.controller';
import { TreasuryMatchController } from '../../src/modules/pay/settlement.controller';
import { TENANT_A, memberId } from '../../../../packages/db/test/support/authz-fixtures';
import { AcceptanceWorld } from '../../../../packages/db/test/support/acceptance-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(480_000);

const SIGNING_KEY = randomBytes(32);
const ROOT = 1;
const MAKER = 41; // drafts and sends the requests of the fixtures (through the stores)
const CHECKER = 42;
const MATCHER = 43; // treasury.match, payment_request.read, and payment.reverse (so the four-eyes rule is what stops them)
const REVERSER = 44; // payment.reverse, payment_request.read: the chief accountant
const READER = 45; // payment_request.read only
const MEMBERS = [MAKER, CHECKER, MATCHER, REVERSER, READER];
const everything: ContractScopes = { update: () => ({ sql: 'true', params: [] }), read: () => ({ sql: 'true', params: [] }) };
const TODAY = '2026-07-25';

interface Reply {
  status: number;
  json: Record<string, unknown>;
  headers: Headers;
}

describe('reversing a settled payment over HTTP (ST-PAY-008)', () => {
  const fixtures = new AcceptanceWorld();
  const harness = fixtures.harness;
  const payments = new PayPaymentStore();
  const claims = new PayClaimStore();
  let app: RunningApp;
  let counter = 0;

  const tokenOf = (member: number): string => signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function call(method: string, url: string, options: { member: number; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>), headers: response.headers };
  }

  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => fixtures.owner<R>(sql, params);
  const audits = (resourceId: string, action: string) => rows<{ safe_diff: Record<string, unknown>; actor_id: string; reason: string | null }>('select safe_diff, actor_id, reason from machvon.audit_event where resource_id = $1 and action = $2 order by occurred_at, id', [resourceId, action]);
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown>; event_key: string }>('select payload, event_key from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at, id', [aggregateId, type]);
  const requestRow = async (id: string) => (await rows<{ status: string; claims: boolean; version: string }>('select status, claims_acceptance as claims, version::text from machvon.payment_request where id = $1::uuid', [id]))[0];
  const contractRow = async (id: string) => (await rows<{ requested: string; paid: string; recovered: string }>('select requested_total_vnd::text as requested, paid_total_vnd::text as paid, advance_recovered_vnd::text as recovered from machvon.contract where id = $1::uuid', [id]))[0];
  const kindsOf = async (requestId: string) => (await rows<{ kind: string }>('select entry_kind as kind from machvon.cumulative_ledger_entry where payment_request_id = $1::uuid order by entry_kind', [requestId])).map((row) => row.kind);

  /** A request that was settled over the API: gross 3bn, recovery 750m, retention 150m, net 2.1bn, paid by a transaction of 2.1bn. */
  async function settled(): Promise<{ id: string; contractId: string; transactionId: string }> {
    counter += 1;
    const contract = await fixtures.seedContract();
    await fixtures.owner('update machvon.contract_party set work_value_vnd = 10000000000 where contract_id = $1::uuid', [contract.contractId]);
    await fixtures.owner('update machvon.contract set advance_paid_vnd = 2000000000 where id = $1::uuid', [contract.contractId]);
    await fixtures.owner(
      `insert into machvon.contract_advance (tenant_id, id, contract_id, party_id, tranche_no, kind, amount_vnd, cap_vnd, status, paid_vnd, paid_on, recovery_threshold_pct, recovery_deadline, created_by, updated_by)
       values ($1, gen_random_uuid(), $2, $3, 1, 'GPMB', 2000000000, 2000000000, 'PAID', 2000000000, date '2026-06-01', 80, date '2026-12-31', $4, $4)`,
      [TENANT_A, contract.contractId, contract.partyId, memberId(MAKER)],
    );
    const approved = await fixtures.approve(contract, [
      { item: 0, quantity: '2000' },
      { item: 1, quantity: '500' },
    ]);
    const made = await fixtures.as((tx) => payments.create(tx, { contractId: contract.contractId, requestKind: 'INTERIM', acceptanceId: approved.acceptance.id, allocationLineId: fixtures.lineId, requestNo: `DNTT-W-${counter}-${randomUUID().slice(0, 6)}` }, memberId(MAKER), everything, TODAY), MAKER);
    const document = await fixtures.documentVersion();
    await fixtures.as((tx) => payments.attachDocument(tx, made.id, { documentVersionId: document.id, docKind: 'INVOICE', invoiceNo: `HD-W-${counter}-${randomUUID().slice(0, 6)}`, invoiceDate: '2026-07-01' }, memberId(MAKER), everything, { mayOverride: () => false }), MAKER);
    const sent = await fixtures.as((tx) => claims.submit(tx, made.id, made.version, { expectedGrossVnd: made.grossVnd, expectedNetVnd: made.netVnd, requestId: randomUUID() }, memberId(MAKER), everything, TODAY), MAKER);
    await fixtures.as((tx) => claims.verify(tx, made.id, sent.version, undefined, memberId(CHECKER), everything), CHECKER);
    await fixtures.sendToTreasury(made.id);
    const transactionId = await transaction('2100000000');
    const matched = await call('POST', `/treasury-transactions/${transactionId}/match`, { member: MATCHER, body: { payment_request_id: made.id } });
    expect(matched.status).toBe(200);
    return { id: made.id, contractId: contract.contractId, transactionId };
  }

  async function transaction(amount: string, options: { reversalOf?: string } = {}): Promise<string> {
    counter += 1;
    const id = randomUUID();
    await fixtures.owner(
      `insert into machvon.treasury_transaction
         (tenant_id, id, project_id, external_id, provider, amount_vnd, confirmed_at, source_hash, row_hash, direction, reversal_of_id, document_no, document_date, source_kind, provider_event_id, match_status)
       values ($1, $2::uuid, $3::uuid, $4, 'MOCKKB', $5::numeric, $6::timestamptz, repeat('a', 64), repeat('a', 64), $7, $8::uuid, $4, date '2026-07-24', 'CALLBACK_MOCK', $9, 'UNMATCHED')`,
      [TENANT_A, id, fixtures.projectId, `CT-X-${counter}`, amount, options.reversalOf === undefined ? '2026-07-24T18:30:00Z' : '2026-07-30T03:00:00Z', options.reversalOf === undefined ? 'PAYMENT' : 'REFUND', options.reversalOf ?? null, `EVT-X-${counter}`],
    );
    return id;
  }

  const reverse = async (member: number, id: string, body: Record<string, unknown>, options: { version?: string; key?: string } = {}) =>
    call('POST', `/payment-requests/${id}/reverse`, { member, body, ifMatch: `"${options.version ?? (await requestRow(id))?.version}"`, ...(options.key === undefined ? {} : { key: options.key }) });

  beforeAll(async () => {
    await fixtures.start();
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedRole(TENANT_A, 301, 'PAY_MATCHER_REVERSER', ['treasury.match', 'payment_request.read', 'payment.reverse'], 30);
    await harness.seedRole(TENANT_A, 302, 'PAY_CHIEF', ['payment.reverse', 'payment_request.read'], 40);
    await harness.seedRole(TENANT_A, 303, 'PAY_ONLY_READ', ['payment_request.read'], 10);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MATCHER, role: 301, kind: 'TENANT' },
      { n: 2, member: REVERSER, role: 302, kind: 'TENANT' },
      { n: 3, member: READER, role: 303, kind: 'TENANT' },
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [TreasuryMatchController, PaymentReversalController],
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
    expect(payModule.controllers).toEqual(expect.arrayContaining([PaymentReversalController]));
  });

  it('UAT-AC331: asks for the reason, the refund and the document in that order, refuses the person who matched the payment, and reverses it with every effect undone by new entries', async () => {
    const target = await settled();
    const refund = await transaction('2100000000', { reversalOf: target.transactionId });
    const paper = (await fixtures.documentVersion()).id;
    expect(await kindsOf(target.id)).toEqual(['ADVANCE_RECOVERY', 'ADVANCE_RECOVERY', 'CLAIM', 'CLAIM', 'PAYMENT', 'PAYMENT', 'RETENTION_HOLD', 'RETENTION_HOLD']);

    expect(await reverse(REVERSER, target.id, {})).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    expect(await reverse(REVERSER, target.id, { reason: 'Kho bạc hoàn trả do sai số tài khoản' })).toMatchObject({ status: 422, json: { code: 'REFUND_NOT_CONFIRMED', reason: 'MISSING' } });
    expect(await reverse(REVERSER, target.id, { reason: 'Kho bạc hoàn trả', refund_treasury_transaction_id: refund })).toMatchObject({ status: 422, json: { code: 'APPROVAL_REQUIRED' } });
    expect(await reverse(MATCHER, target.id, { reason: 'Kho bạc hoàn trả', refund_treasury_transaction_id: refund, approval_document_version_id: paper })).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
    expect(await requestRow(target.id)).toMatchObject({ status: 'SETTLED' });

    const body = { reason: 'Kho bạc hoàn trả do sai số tài khoản', refund_treasury_transaction_id: refund, approval_document_version_id: paper };
    const done = await reverse(REVERSER, target.id, body, { key: 'reverse-once-for-this-key' });
    expect(done).toMatchObject({ status: 200, json: { status: 'REVERSED', resource_id: target.id, refund_transaction_id: refund, treasury_paid_on: '2026-07-25', payment_entries: 2 } });
    expect(await requestRow(target.id)).toMatchObject({ status: 'REVERSED', claims: false });
    expect(await contractRow(target.contractId)).toEqual({ requested: '0', paid: '0', recovered: '0' });
    expect(await kindsOf(target.id)).toEqual([
      'ADVANCE_RECOVERY',
      'ADVANCE_RECOVERY',
      'ADVANCE_RECOVERY_REVERSAL',
      'ADVANCE_RECOVERY_REVERSAL',
      'CLAIM',
      'CLAIM',
      'CLAIM_RELEASE',
      'CLAIM_RELEASE',
      'PAYMENT',
      'PAYMENT',
      'PAYMENT_REVERSAL',
      'PAYMENT_REVERSAL',
      'RETENTION_HOLD',
      'RETENTION_HOLD',
      'RETENTION_RELEASE',
      'RETENTION_RELEASE',
    ]);

    const told = await events(target.id, 'pay.payment.reversed.v1');
    expect(told).toHaveLength(1);
    expect(told[0]?.event_key).toBe(`payment_request:${target.id}:reversed`);
    expect(told[0]?.payload).toMatchObject({
      payment_request_id: target.id,
      contract_id: target.contractId,
      amount_vnd: '2100000000',
      allocation_line_id: fixtures.lineId,
      refund_transaction_id: refund,
      treasury_paid_on: '2026-07-25',
      refund_confirmed_at: '2026-07-30T03:00:00.000000Z',
      approval_document_version_id: paper,
      actor_id: memberId(REVERSER),
    });
    expect(JSON.stringify(told[0]?.payload)).not.toContain('Kho bạc');
    const trail = await audits(target.id, 'payment_request.reversed');
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ actor_id: memberId(REVERSER), reason: 'Kho bạc hoàn trả do sai số tài khoản', safe_diff: { from_status: 'SETTLED', to_status: 'REVERSED', refund_transaction_id: refund, payment_entries: 2 } });

    // The same key with another If-Match is another command; and a request made after the reversal is refused, as the payment is no longer settled.
    expect(await reverse(REVERSER, target.id, body, { key: 'reverse-once-for-this-key', version: '9' })).toMatchObject({ status: 409 });
    expect(await events(target.id, 'pay.payment.reversed.v1')).toHaveLength(1);
    expect(await reverse(REVERSER, target.id, body)).toMatchObject({ status: 409, json: { code: 'PAYMENT_STATE_INVALID' } });
  });

  it('replays the answer of the same key with the same body', async () => {
    const target = await settled();
    const refund = await transaction('2100000000', { reversalOf: target.transactionId });
    const paper = (await fixtures.documentVersion()).id;
    const body = { reason: 'Hoàn trả', refund_treasury_transaction_id: refund, approval_document_version_id: paper };
    const version = (await requestRow(target.id))?.version;
    const first = await reverse(REVERSER, target.id, body, { key: 'replay-this-reversal-key', version });
    expect(first.status).toBe(200);
    const again = await reverse(REVERSER, target.id, body, { key: 'replay-this-reversal-key', version });
    expect(again).toMatchObject({ status: 200, json: first.json });
    expect(again.headers.get('idempotency-replayed')).toBe('true');
    expect(await events(target.id, 'pay.payment.reversed.v1')).toHaveLength(1);
  });

  it('refuses a caller who lacks the permission, a stale version and a request that is not settled', async () => {
    const target = await settled();
    const refund = await transaction('2100000000', { reversalOf: target.transactionId });
    const paper = (await fixtures.documentVersion()).id;
    const body = { reason: 'Hoàn trả', refund_treasury_transaction_id: refund, approval_document_version_id: paper };
    expect(await reverse(READER, target.id, body)).toMatchObject({ status: 403 });
    expect(await reverse(REVERSER, target.id, body, { version: '1' })).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    expect(await reverse(REVERSER, target.id, { ...body, amount_vnd: '1' })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
    expect(await reverse(REVERSER, randomUUID(), body, { version: '1' })).toMatchObject({ status: 404 });
    expect(await requestRow(target.id)).toMatchObject({ status: 'SETTLED' });
  });
});
