import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, PayClaimStore, PayPaymentStore, TenantDatabase } from '@machvon/db';
import type { ContractScopes } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { payModule } from '../../src/modules/pay';
import { ReconciliationController, ReconciliationReadsController } from '../../src/modules/pay/reconciliation.controller';
import { TreasuryMatchController } from '../../src/modules/pay/settlement.controller';
import { TENANT_A, memberId } from '../../../../packages/db/test/support/authz-fixtures';
import { AcceptanceWorld } from '../../../../packages/db/test/support/acceptance-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(480_000);

const SIGNING_KEY = randomBytes(32);
const ROOT = 1;
const MAKER = 31; // drafts and sends the requests of the fixtures (through the stores)
const CHECKER = 32;
const MATCHER = 21; // treasury.match, payment_request.read
const ASSIGNER = 22; // reconciliation.assign, reconciliation.read
const OWNER = 23; // reconciliation.resolve, reconciliation.read: the owner of the differences (u.ktt)
const APPROVER = 24; // reconciliation.resolve, reconciliation.read: the one who approves a write-off (u.lanhdao)
const READER = 25; // reconciliation.read, treasury_transaction.read
const NOBODY = 26;
const MEMBERS = [MAKER, CHECKER, MATCHER, ASSIGNER, OWNER, APPROVER, READER, NOBODY];
const everything: ContractScopes = { update: () => ({ sql: 'true', params: [] }), read: () => ({ sql: 'true', params: [] }) };
const TODAY = '2026-07-25';

interface Reply {
  status: number;
  json: Record<string, unknown>;
  headers: Headers;
}

describe('matching a Treasury transaction and working on a difference over HTTP (ST-PAY-007)', () => {
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
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown>; schema_version: number; event_key: string }>('select payload, schema_version, event_key from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at, id', [aggregateId, type]);
  const requestRow = async (id: string) => (await rows<{ status: string; paid_on: string | null }>('select status, treasury_paid_on::text as paid_on from machvon.payment_request where id = $1::uuid', [id]))[0];
  const contractRow = async (id: string) => (await rows<{ paid_total: string }>('select paid_total_vnd::text as paid_total from machvon.contract where id = $1::uuid', [id]))[0];
  const paymentEntries = (requestId: string) => rows<{ paid: string }>("select paid_delta_vnd::text as paid from machvon.cumulative_ledger_entry where payment_request_id = $1::uuid and entry_kind = 'PAYMENT' order by paid_delta_vnd", [requestId]);
  const itemsOf = (requestId: string) =>
    rows<{ id: string; status: string; internal: string; confirmed: string; difference: string; owner: string }>(
      'select id, status, internal_amount_vnd::text as internal, confirmed_amount_vnd::text as confirmed, difference_vnd::text as difference, owner_membership_id as owner from machvon.reconciliation_item where payment_request_id = $1::uuid',
      [requestId],
    );

  /** A request that is with the Treasury: gross 3bn on two balances, recovery 750m, retention 150m, net 2.1bn. */
  async function sentToTreasury(): Promise<{ id: string; contractId: string }> {
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
    const made = await fixtures.as((tx) => payments.create(tx, { contractId: contract.contractId, requestKind: 'INTERIM', acceptanceId: approved.acceptance.id, allocationLineId: fixtures.lineId, requestNo: `DNTT-M-${counter}-${randomUUID().slice(0, 6)}` }, memberId(MAKER), everything, TODAY), MAKER);
    const document = await fixtures.documentVersion();
    await fixtures.as((tx) => payments.attachDocument(tx, made.id, { documentVersionId: document.id, docKind: 'INVOICE', invoiceNo: `HD-M-${counter}-${randomUUID().slice(0, 6)}`, invoiceDate: '2026-07-01' }, memberId(MAKER), everything, { mayOverride: () => false }), MAKER);
    const sent = await fixtures.as((tx) => claims.submit(tx, made.id, made.version, { expectedGrossVnd: made.grossVnd, expectedNetVnd: made.netVnd, requestId: randomUUID() }, memberId(MAKER), everything, TODAY), MAKER);
    await fixtures.as((tx) => claims.verify(tx, made.id, sent.version, undefined, memberId(CHECKER), everything), CHECKER);
    await fixtures.sendToTreasury(made.id);
    return { id: made.id, contractId: contract.contractId };
  }

  async function transaction(amount: string): Promise<string> {
    counter += 1;
    const id = randomUUID();
    await fixtures.owner(
      `insert into machvon.treasury_transaction
         (tenant_id, id, project_id, external_id, provider, amount_vnd, confirmed_at, source_hash, row_hash, direction, document_no, document_date, source_kind, provider_event_id, match_status)
       values ($1, $2::uuid, $3::uuid, $4, 'MOCKKB', $5::numeric, timestamptz '2026-07-24T18:30:00Z', repeat('a', 64), repeat('a', 64), 'PAYMENT', $4, date '2026-07-24', 'CALLBACK_MOCK', $6, 'UNMATCHED')`,
      [TENANT_A, id, fixtures.projectId, `CT-H-${counter}`, amount, `EVT-H-${counter}`],
    );
    return id;
  }

  const match = (member: number, transactionId: string, body: Record<string, unknown>, key?: string) => call('POST', `/treasury-transactions/${transactionId}/match`, { member, body, ...(key === undefined ? {} : { key }) });
  const versionOf = async (id: string) => (await rows<{ version: string }>('select version::text as version from machvon.reconciliation_item where id = $1::uuid', [id]))[0]?.version ?? '0';
  const assign = async (member: number, id: string, body: Record<string, unknown>, version?: string) => call('POST', `/reconciliation-items/${id}/assign`, { member, body, ifMatch: `"${version ?? (await versionOf(id))}"` });
  const resolve = async (member: number, id: string, body: Record<string, unknown>, version?: string) => call('POST', `/reconciliation-items/${id}/resolve`, { member, body, ifMatch: `"${version ?? (await versionOf(id))}"` });

  beforeAll(async () => {
    await fixtures.start();
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedRole(TENANT_A, 201, 'PAY_MATCHER', ['treasury.match', 'payment_request.read', 'treasury_transaction.read'], 30);
    await harness.seedRole(TENANT_A, 202, 'PAY_ASSIGNER', ['reconciliation.assign', 'reconciliation.read'], 30);
    await harness.seedRole(TENANT_A, 203, 'PAY_RESOLVER', ['reconciliation.resolve', 'reconciliation.read'], 40);
    await harness.seedRole(TENANT_A, 204, 'PAY_RECON_READER', ['reconciliation.read', 'treasury_transaction.read'], 10);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MATCHER, role: 201, kind: 'TENANT' },
      { n: 2, member: ASSIGNER, role: 202, kind: 'TENANT' },
      { n: 3, member: OWNER, role: 203, kind: 'TENANT' },
      { n: 4, member: APPROVER, role: 203, kind: 'TENANT' },
      { n: 5, member: READER, role: 204, kind: 'TENANT' },
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [TreasuryMatchController, ReconciliationController, ReconciliationReadsController],
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
    expect(payModule.controllers).toEqual(expect.arrayContaining([TreasuryMatchController, ReconciliationController, ReconciliationReadsController]));
  });

  describe('an amount that is the net settles the request (UAT-AC335, AC-ST-PAY-007-1)', () => {
    it('answers the settlement, moves the books once and tells CAP, DIS and MNE once with the minimum they need; the same key answers the same', async () => {
      const target = await sentToTreasury();
      const confirmed = await transaction('2100000000');
      const done = await match(MATCHER, confirmed, { payment_request_id: target.id, note: 'Matched to the statement of 24 July' }, 'match-once-for-this-key');
      expect(done).toMatchObject({
        status: 200,
        json: { status: 'SETTLED', resource_id: target.id, payment_request_id: target.id, transaction_id: confirmed, amount_vnd: '2100000000', treasury_paid_on: '2026-07-25' },
      });
      expect(await requestRow(target.id)).toEqual({ status: 'SETTLED', paid_on: '2026-07-25' });
      expect(await contractRow(target.contractId)).toEqual({ paid_total: '3000000000' });
      expect(await paymentEntries(target.id)).toEqual([{ paid: '1000000000' }, { paid: '2000000000' }]);

      const settled = await events(target.id, 'pay.payment.settled.v1');
      expect(settled).toHaveLength(1);
      expect(Object.keys(settled[0]?.payload ?? {}).sort()).toEqual(['actor_id', 'allocation_line_id', 'amount_vnd', 'confirmed_at', 'contract_id', 'occurred_at', 'payment_request_id', 'plan_year', 'project_id', 'tenant_id']);
      expect(settled[0]?.payload).toMatchObject({ payment_request_id: target.id, contract_id: target.contractId, amount_vnd: '2100000000', allocation_line_id: fixtures.lineId, confirmed_at: '2026-07-24T18:30:00.000000Z' });
      const second = await events(target.id, 'pay.payment.settled.v2');
      expect(second).toHaveLength(1);
      expect(second[0]).toMatchObject({ schema_version: 2, payload: { treasury_paid_on: '2026-07-25', request_kind: 'INTERIM', transaction_id: confirmed, amount_vnd: '2100000000' } });
      const matched = await events(confirmed, 'pay.treasury_transaction.matched.v1');
      expect(matched).toHaveLength(1);
      expect(matched[0]?.payload).toMatchObject({ payment_request_id: target.id, transaction_id: confirmed, amount_vnd: '2100000000' });
      const trail = await audits(target.id, 'payment_request.settled');
      expect(trail).toHaveLength(1);
      expect(trail[0]).toMatchObject({ actor_id: memberId(MATCHER), reason: 'Matched to the statement of 24 July', safe_diff: { from_status: 'SENT_TREASURY', to_status: 'SETTLED', treasury_paid_on: '2026-07-25', ledger_entries: 2 } });

      expect(await match(MATCHER, confirmed, { payment_request_id: target.id, note: 'Matched to the statement of 24 July' }, 'match-once-for-this-key')).toMatchObject({ status: 200, json: done.json });
      expect(await events(target.id, 'pay.payment.settled.v1')).toHaveLength(1);
      expect(await paymentEntries(target.id)).toHaveLength(2);
      // The same key with another request is not the same command.
      expect(await match(MATCHER, confirmed, { payment_request_id: randomUUID() }, 'match-once-for-this-key')).toMatchObject({ status: 409, json: { code: 'IDEMPOTENCY_CONFLICT' } });
    });

    it('answers 409 TRANSACTION_ALREADY_MATCHED when the transaction is matched again, and 409 PAYMENT_STATE_INVALID for a request that is not with the Treasury', async () => {
      const target = await sentToTreasury();
      const other = await sentToTreasury();
      const confirmed = await transaction('2100000000');
      expect((await match(MATCHER, confirmed, { payment_request_id: target.id })).status).toBe(200);
      expect(await match(MATCHER, confirmed, { payment_request_id: other.id })).toMatchObject({ status: 409, json: { code: 'TRANSACTION_ALREADY_MATCHED' } });
      expect(await match(MATCHER, await transaction('2100000000'), { payment_request_id: target.id })).toMatchObject({ status: 409, json: { code: 'PAYMENT_STATE_INVALID' } });
      expect(await requestRow(other.id)).toMatchObject({ status: 'SENT_TREASURY' });
      expect(await events(other.id, 'pay.payment.settled.v1')).toHaveLength(0);
      expect(await match(MATCHER, randomUUID(), { payment_request_id: target.id })).toMatchObject({ status: 404 });
      expect(await match(MATCHER, confirmed, { payment_request_id: 'x' })).toMatchObject({ status: 422 });
      expect(await match(MATCHER, confirmed, { payment_request_id: target.id, amount_vnd: '1' })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
    });
  });

  describe('an amount that is not the net opens a difference and answers 422 (UAT-AC12, AC-ST-PAY-007-2)', () => {
    it('commits the difference with both figures and the signed difference, keeps the request with the Treasury, and answers the same refusal to the same key', async () => {
      const target = await sentToTreasury();
      const confirmed = await transaction('2090000000');
      const refused = await match(MATCHER, confirmed, { payment_request_id: target.id }, 'mismatch-once-for-this-key');
      expect(refused).toMatchObject({ status: 422, json: { code: 'AMOUNT_MISMATCH_OPENED', internal_amount_vnd: '2100000000', confirmed_amount_vnd: '2090000000', difference_vnd: '-10000000', owner_membership_id: memberId(MATCHER) } });
      const items = await itemsOf(target.id);
      expect(items).toEqual([{ id: refused.json.reconciliation_item_id, status: 'OPEN', internal: '2100000000', confirmed: '2090000000', difference: '-10000000', owner: memberId(MATCHER) }]);
      expect(await requestRow(target.id)).toEqual({ status: 'SENT_TREASURY', paid_on: null });
      expect(await contractRow(target.contractId)).toEqual({ paid_total: '0' });
      expect(await events(target.id, 'pay.payment.settled.v1')).toHaveLength(0);
      expect(await audits(items[0]?.id as string, 'treasury_transaction.mismatch_opened')).toHaveLength(1);
      const again = await match(MATCHER, confirmed, { payment_request_id: target.id }, 'mismatch-once-for-this-key');
      expect(again).toMatchObject({ status: 422, json: { code: 'AMOUNT_MISMATCH_OPENED', reconciliation_item_id: refused.json.reconciliation_item_id } });
      expect(again.headers.get('idempotency-replayed')).toBe('true');
      expect(await itemsOf(target.id)).toHaveLength(1);
    });

    it('shows both columns and the difference on the board and on the item, and resolves it only with a note', async () => {
      const target = await sentToTreasury();
      const refused = await match(MATCHER, await transaction('2090000000'), { payment_request_id: target.id });
      const itemId = refused.json.reconciliation_item_id as string;
      const board = await call('GET', '/reconciliation-items?status=OPEN&limit=200', { member: READER });
      expect(board.status).toBe(200);
      const shown = (board.json.items as Array<Record<string, unknown>>).find((row) => row.id === itemId);
      expect(shown).toMatchObject({
        kind: 'AMOUNT_MISMATCH',
        status: 'OPEN',
        internal_amount_vnd: '2100000000',
        confirmed_amount_vnd: '2090000000',
        difference_vnd: '-10000000',
        payment_request_id: target.id,
        owner_membership_id: memberId(MATCHER),
        overdue: false,
        issue_id: null,
        actions: { assign: true, explain: true, resolve: false, write_off: true },
      });
      expect(board.json.summary).toMatchObject({ waiting: expect.any(Number), overdue: expect.any(Number), waiting_difference_vnd: expect.stringMatching(/^-?\d+$/) });
      expect(await call('GET', `/reconciliation-items/${itemId}`, { member: READER })).toMatchObject({ status: 200, json: { id: itemId, difference_vnd: '-10000000', version: 1 } });

      expect(await resolve(OWNER, itemId, { resolution: 'EXPLAINED' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await resolve(OWNER, itemId, { resolution: 'EXPLAINED', note: '   ' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      const explained = await resolve(OWNER, itemId, { resolution: 'EXPLAINED', note: 'Kho bạc trừ phí 10.000.000 theo thông báo TB-77' });
      expect(explained).toMatchObject({ status: 200, json: { status: 'EXPLAINED', resource_version: 2, difference_vnd: '-10000000', owner_membership_id: memberId(MATCHER) } });
      const trail = await audits(itemId, 'reconciliation_item.resolved');
      expect(trail).toHaveLength(1);
      expect(trail[0]).toMatchObject({ actor_id: memberId(OWNER), reason: 'Kho bạc trừ phí 10.000.000 theo thông báo TB-77', safe_diff: { from_status: 'OPEN', to_status: 'EXPLAINED', resolution: 'EXPLAINED' } });
      expect(await requestRow(target.id)).toMatchObject({ status: 'SENT_TREASURY' });
      expect((await events(itemId, 'pay.reconciliation.resolved.v1'))[0]?.payload).not.toHaveProperty('note');
    });
  });

  describe('giving an item to an owner and writing it off (UAT-AC336, AC-ST-PAY-007-3)', () => {
    async function openItem(): Promise<string> {
      const target = await sentToTreasury();
      const refused = await match(MATCHER, await transaction('2090000000'), { payment_request_id: target.id });
      return refused.json.reconciliation_item_id as string;
    }

    it('gives the item to an owner with a day, tells ISS-facing consumers once, and refuses a day that is past, an owner who is not a member and a stale version', async () => {
      const itemId = await openItem();
      const done = await assign(ASSIGNER, itemId, { owner_membership_id: memberId(OWNER), due_at: '2026-12-31T10:00:00Z' });
      expect(done).toMatchObject({ status: 200, json: { status: 'OPEN', resource_version: 2, owner_membership_id: memberId(OWNER), difference_vnd: '-10000000' } });
      expect(Date.parse(done.json.due_at as string)).toBe(Date.parse('2026-12-31T10:00:00Z'));
      expect(await audits(itemId, 'reconciliation_item.assigned')).toHaveLength(1);
      expect((await events(itemId, 'pay.reconciliation.assigned.v1'))[0]?.payload).toMatchObject({ owner_membership_id: memberId(OWNER), reconciliation_item_id: itemId });
      expect(await assign(ASSIGNER, itemId, { owner_membership_id: memberId(OWNER), due_at: '2020-01-01T00:00:00Z' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await assign(ASSIGNER, itemId, { owner_membership_id: randomUUID(), due_at: '2026-12-31T10:00:00Z' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await assign(ASSIGNER, itemId, { owner_membership_id: memberId(OWNER), due_at: '2026-12-31T10:00:00Z' }, '1')).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect(await assign(ASSIGNER, itemId, { owner_membership_id: memberId(OWNER) })).toMatchObject({ status: 400 });
    });

    it('writes the difference off only with the approving document and by someone other than its owner, and keeps the figures', async () => {
      const itemId = await openItem();
      await assign(ASSIGNER, itemId, { owner_membership_id: memberId(OWNER), due_at: '2026-12-31T10:00:00Z' });
      const paper = (await fixtures.documentVersion()).id;
      expect(await resolve(OWNER, itemId, { resolution: 'WRITTEN_OFF', note: 'Cannot be recovered' })).toMatchObject({ status: 422, json: { code: 'APPROVAL_REQUIRED' } });
      expect(await resolve(OWNER, itemId, { resolution: 'WRITTEN_OFF', note: 'Cannot be recovered', approval_document_version_id: paper })).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect((await audits(itemId, 'reconciliation_item.resolved')).length).toBe(0);
      const done = await resolve(APPROVER, itemId, { resolution: 'WRITTEN_OFF', note: 'Cannot be recovered', approval_document_version_id: paper });
      expect(done).toMatchObject({ status: 200, json: { status: 'WRITTEN_OFF_APPROVED', difference_vnd: '-10000000' } });
      const read = await call('GET', `/reconciliation-items/${itemId}`, { member: READER });
      expect(read.json).toMatchObject({
        status: 'WRITTEN_OFF_APPROVED',
        internal_amount_vnd: '2100000000',
        confirmed_amount_vnd: '2090000000',
        difference_vnd: '-10000000',
        resolved_by: memberId(APPROVER),
        approval_document_version_id: paper,
        resolution_note: 'Cannot be recovered',
        actions: { assign: false, explain: false, resolve: false, write_off: false },
      });
      expect(read.json.resolved_at).not.toBeNull();
      expect(await resolve(APPROVER, itemId, { resolution: 'RESOLVED', note: 'again' })).toMatchObject({ status: 409, json: { code: 'RECONCILIATION_STATE_INVALID' } });
      expect(await assign(ASSIGNER, itemId, { owner_membership_id: memberId(OWNER), due_at: '2027-01-31T10:00:00Z' })).toMatchObject({ status: 409, json: { code: 'RECONCILIATION_STATE_INVALID' } });
    });
  });

  describe('who may do what', () => {
    it('refuses each command to a caller who lacks its permission and each read to one who lacks the right to read', async () => {
      const target = await sentToTreasury();
      const confirmed = await transaction('2100000000');
      expect(await match(ASSIGNER, confirmed, { payment_request_id: target.id })).toMatchObject({ status: 403 });
      expect(await match(NOBODY, confirmed, { payment_request_id: target.id })).toMatchObject({ status: 403 });
      const itemId = (await match(MATCHER, await transaction('2090000000'), { payment_request_id: (await sentToTreasury()).id })).json.reconciliation_item_id as string;
      expect(await assign(READER, itemId, { owner_membership_id: memberId(OWNER), due_at: '2026-12-31T10:00:00Z' })).toMatchObject({ status: 403 });
      expect(await resolve(ASSIGNER, itemId, { resolution: 'EXPLAINED', note: 'x' })).toMatchObject({ status: 403 });
      expect(await call('GET', '/reconciliation-items', { member: NOBODY })).toMatchObject({ status: 403 });
      expect(await call('GET', `/reconciliation-items/${itemId}`, { member: NOBODY })).toMatchObject({ status: 403 });
      expect(await call('GET', '/treasury-tracking', { member: NOBODY })).toMatchObject({ status: 403 });
      expect(await requestRow(target.id)).toMatchObject({ status: 'SENT_TREASURY' });
    });

    it('refuses a filter that is not one and an item that is not there', async () => {
      expect(await call('GET', '/reconciliation-items?status=DONE', { member: READER })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await call('GET', '/reconciliation-items?owner_membership_id=x', { member: READER })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await call('GET', `/reconciliation-items/${randomUUID()}`, { member: READER })).toMatchObject({ status: 404 });
      expect(await call('GET', '/reconciliation-items/x', { member: READER })).toMatchObject({ status: 422 });
    });

    it('pages the items by the day they are due', async () => {
      await openMany();
      const first = await call('GET', '/reconciliation-items?limit=2', { member: READER });
      expect((first.json.items as unknown[]).length).toBe(2);
      expect(typeof first.json.next_cursor).toBe('string');
      const second = await call('GET', `/reconciliation-items?limit=2&cursor=${encodeURIComponent(first.json.next_cursor as string)}`, { member: READER });
      const ids = [...(first.json.items as Array<{ id: string }>), ...(second.json.items as Array<{ id: string }>)].map((row) => row.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('where the projects stand with the Treasury (PAY-09)', () => {
    it('counts what is with the Treasury, what is settled, what was confirmed and what is in difference, for the project', async () => {
      const first = await sentToTreasury();
      const second = await sentToTreasury();
      await match(MATCHER, await transaction('2100000000'), { payment_request_id: first.id });
      await match(MATCHER, await transaction('2090000000'), { payment_request_id: second.id });
      const tracked = await call('GET', '/treasury-tracking?limit=200', { member: READER });
      expect(tracked.status).toBe(200);
      const mine = (tracked.json.items as Array<Record<string, unknown>>).find((row) => row.project_id === fixtures.projectId);
      expect(mine).toMatchObject({
        project_id: fixtures.projectId,
        sent: { count: expect.any(Number), amount_vnd: expect.stringMatching(/^\d+$/) },
        settled: { count: expect.any(Number), amount_vnd: expect.stringMatching(/^\d+$/) },
        confirmed: { count: expect.any(Number), amount_vnd: expect.stringMatching(/^\d+$/) },
        differences: { count: expect.any(Number), amount_vnd: expect.stringMatching(/^-?\d+$/) },
        last_import_at: null,
      });
      expect((mine?.settled as { count: number }).count).toBeGreaterThanOrEqual(1);
      expect((mine?.differences as { count: number }).count).toBeGreaterThanOrEqual(1);
      expect(typeof mine?.last_confirmed_at).toBe('string');
      expect(await call('GET', '/treasury-tracking?limit=0', { member: READER })).toMatchObject({ status: 422 });
      const page = await call('GET', '/treasury-tracking?limit=1', { member: READER });
      expect(page.status).toBe(200);
      expect(page.json).toHaveProperty('next_cursor');
    });
  });

  async function openMany(): Promise<void> {
    for (let n = 0; n < 3; n += 1) {
      const target = await sentToTreasury();
      await match(MATCHER, await transaction('2090000000'), { payment_request_id: target.id });
    }
  }
});
