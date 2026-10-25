import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { payModule } from '../../src/modules/pay';
import { PaymentRequestController, PaymentRequestReadsController } from '../../src/modules/pay/payment-request.controller';
import { TENANT_A, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { AcceptanceWorld } from '../../../../packages/db/test/support/acceptance-fixtures';
import type { ApprovedAcceptance } from '../../../../packages/db/test/support/acceptance-fixtures';
import { seedContractor } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(480_000);

const SIGNING_KEY = randomBytes(32);
const ROOT = 1;
const MAKER = 11; // payment.create, payment.document.attach, payment.cancel, payment_request.read
const APPROVER = 12; // payment.verify, payment.document.attach, payment_request.read
const READER = 13; // payment_request.read
const NOBODY = 14;
const ELSEWHERE = 15; // the rights of MAKER over another branch
const MEMBERS = [MAKER, APPROVER, READER, NOBODY, ELSEWHERE];
const OTHER_BRANCH = 5;

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the draft of a payment request over HTTP (ST-PAY-002)', () => {
  const fixtures = new AcceptanceWorld();
  const harness = fixtures.harness;
  let app: RunningApp;
  let counter = 0;
  let guests = 30;
  let grants = 20;
  let contractor = '';

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

  const number = (): string => `DNTT-${String((counter += 1)).padStart(4, '0')}`;
  /** A contract with an approved acceptance worth 3bn, a party whose work is worth 10bn and an advance of 2bn paid, so a request is worth gross 3bn, recovery 750m, retention 150m. */
  async function approved(): Promise<ApprovedAcceptance> {
    const contract = await fixtures.seedContract();
    await fixtures.owner('update machvon.contract_party set work_value_vnd = 10000000000 where contract_id = $1::uuid', [contract.contractId]);
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
  const body = (target: ApprovedAcceptance, overrides: Record<string, unknown> = {}) => ({
    contract_id: target.contract.contractId,
    request_kind: 'INTERIM',
    acceptance_id: target.acceptance.id,
    allocation_line_id: fixtures.lineId,
    request_no: number(),
    ...overrides,
  });
  const create = (member: number, target: ApprovedAcceptance, overrides: Record<string, unknown> = {}, key?: string) => call('POST', '/payment-requests', { member, ...(key === undefined ? {} : { key }), body: body(target, overrides) });
  const revise = (member: number, id: string, version: number | string, payload: Record<string, unknown>) => call('POST', `/payment-requests/${id}/draft`, { member, ifMatch: `"${version}"`, body: payload });
  const attach = (member: number, id: string, payload: Record<string, unknown>) => call('POST', `/payment-requests/${id}/documents`, { member, body: payload });
  const cancel = (member: number, id: string, version: number | string, reason = 'The request was drawn up twice.') => call('POST', `/payment-requests/${id}/cancel`, { member, ifMatch: `"${version}"`, body: { reason } });

  /** A guest of the contractor with the right to read payment requests over one contract: the member number. */
  async function guestOf(contractId: string): Promise<number> {
    guests += 1;
    grants += 1;
    await harness.seedMembership(TENANT_A, guests, ROOT);
    await fixtures.owner("update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2::uuid, valid_until = now() + interval '1 year' where id = $1::uuid", [memberId(guests), contractor]);
    await harness.seedGrants(TENANT_A, [{ n: grants, member: guests, role: 103, kind: 'CONTRACT', refs: [contractId] }]);
    return guests;
  }

  beforeAll(async () => {
    await fixtures.start();
    await harness.seedUnits(TENANT_A, [{ n: OTHER_BRANCH, path: `/${unitId(OTHER_BRANCH)}/` }]);
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedRole(TENANT_A, 101, 'PAY_MAKER', ['payment.create', 'payment.document.attach', 'payment.cancel', 'payment_request.read'], 30);
    await harness.seedRole(TENANT_A, 102, 'PAY_APPROVER', ['payment.verify', 'payment.document.attach', 'payment_request.read'], 40);
    await harness.seedRole(TENANT_A, 103, 'PAY_READER', ['payment_request.read'], 10);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MAKER, role: 101, kind: 'TENANT' },
      { n: 2, member: APPROVER, role: 102, kind: 'TENANT' },
      { n: 3, member: READER, role: 103, kind: 'TENANT' },
      { n: 4, member: ELSEWHERE, role: 101, kind: 'UNIT_SUBTREE', refs: [unitId(OTHER_BRANCH)] },
    ]);
    contractor = await seedContractor(harness);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [PaymentRequestController, PaymentRequestReadsController],
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
    expect(payModule.controllers).toEqual(expect.arrayContaining([PaymentRequestController, PaymentRequestReadsController]));
  });

  it('AC-ST-PAY-002-1, UAT-AC323: the server computes gross, recovery, retention and net; the client cannot send them; the draft is audited and told to PAY once', async () => {
    const target = await approved();
    const made = await create(MAKER, target, { request_no: 'DNTT-ONCE' }, 'draft-once-for-this-key');
    expect(made).toMatchObject({
      status: 200,
      json: { status: 'DRAFT', resource_version: 1, gross_vnd: '3000000000', advance_recovery_vnd: '750000000', retention_vnd: '150000000', tax_adjustment_vnd: '0', net_vnd: '2100000000', warnings: [] },
    });
    expect(made.json.plan_year).toEqual(expect.any(Number));
    // The same key is the same answer, and nothing is drawn twice.
    expect(await create(MAKER, target, { request_no: 'DNTT-ONCE' }, 'draft-once-for-this-key')).toEqual(made);
    const id = made.json.resource_id as string;
    expect(await rows('select id from machvon.payment_request where contract_id = $1::uuid', [target.contract.contractId])).toHaveLength(1);
    // The fields the client may not send are refused by the allowlist of the request, whatever the value.
    for (const field of ['gross_vnd', 'net_vnd', 'status', 'claims_acceptance', 'advance_recovery_vnd']) {
      expect(await create(MAKER, target, { [field]: field === 'status' ? 'SETTLED' : field === 'claims_acceptance' ? true : '999' })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
    }
    const [audit] = await audits(id, 'payment_request.drafted');
    expect(audit).toMatchObject({ actor_id: memberId(MAKER), safe_diff: { from_status: null, to_status: 'DRAFT', contract_id: target.contract.contractId, gross_vnd: '3000000000', net_vnd: '2100000000', line_count: 2 } });
    const told = await events(id, 'pay.payment_request.drafted.v1');
    expect(told).toHaveLength(1);
    expect(told[0]?.payload).toMatchObject({ payment_request_id: id, gross_vnd: '3000000000', net_vnd: '2100000000', status: 'DRAFT', version: 1, actor_id: memberId(MAKER) });
    // A tax adjustment moves the net; it needs its basis.
    expect(await revise(MAKER, id, 1, { tax_adjustment_vnd: '-1000000' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    expect(await revise(MAKER, id, 1, { tax_adjustment_vnd: '-1000000', tax_adjustment_basis: 'Thông báo thuế' })).toMatchObject({ status: 200, json: { resource_version: 2, net_vnd: '2099000000', tax_adjustment_vnd: '-1000000' } });
    expect(await revise(MAKER, id, 1, {})).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    expect((await events(id, 'pay.payment_request.revised.v1'))[0]?.payload).toMatchObject({ net_vnd: '2099000000', version: 2 });
  });

  it('refuses in words what the guards refuse: the number, the claim, the acceptance, the year, the state of the contract', async () => {
    const target = await approved();
    const first = await create(MAKER, target, { request_no: 'DNTT-SAME' });
    expect(first.status).toBe(200);
    expect(await create(MAKER, target, { request_no: 'DNTT-SAME' })).toMatchObject({ status: 409, json: { code: 'PAYMENT_REFERENCE_DUPLICATE' } });
    // A second draft of the acceptance is allowed and says so.
    const second = await create(MAKER, target);
    expect(second.json.warnings).toEqual([{ code: 'OTHER_DRAFTS_FOR_ACCEPTANCE', detail: { payment_request_ids: [first.json.resource_id] } }]);
    expect(await create(MAKER, target, { acceptance_id: randomUUID() })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    expect(await create(MAKER, target, { allocation_line_id: randomUUID() })).toMatchObject({ status: 422, json: { code: 'ALLOCATION_UNAVAILABLE' } });
    expect(await create(MAKER, target, { request_kind: 'FINAL' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    await fixtures.owner("update machvon.payment_request set status = 'SUBMITTED', claims_acceptance = true where id = $1::uuid", [first.json.resource_id]);
    expect(await create(MAKER, target)).toMatchObject({ status: 409, json: { code: 'ACCEPTANCE_ALREADY_CLAIMED' } });
    const other = await approved();
    const paper = (await fixtures.documentVersion()).id;
    await fixtures.owner("update machvon.contract set status = 'SUSPENDED', status_reason = 'Stopped.', status_decision_document_version_id = $2::uuid, suspended_from = date '2026-01-01' where id = $1::uuid", [other.contract.contractId, paper]);
    expect(await create(MAKER, other)).toMatchObject({ status: 409, json: { code: 'CONTRACT_STATE_INVALID', reason: 'ACCEPTED_AFTER_SUSPENSION', contract_status: 'SUSPENDED' } });
  });

  it('keeps the people apart: who may draw up, who may read, who may not see (UAT-AC323 authorization)', async () => {
    const target = await approved();
    expect(await create(READER, target)).toMatchObject({ status: 403 });
    expect(await create(NOBODY, target)).toMatchObject({ status: 403 });
    expect(await create(ELSEWHERE, target)).toMatchObject({ status: 404 });
    const made = await create(MAKER, target);
    const id = made.json.resource_id as string;
    expect(await revise(READER, id, 1, {})).toMatchObject({ status: 403 });
    expect(await revise(ELSEWHERE, id, 1, {})).toMatchObject({ status: 404 });
    expect(await cancel(READER, id, 1)).toMatchObject({ status: 403 });
    expect(await rows<{ status: string }>('select status from machvon.payment_request where id = $1::uuid', [id])).toEqual([{ status: 'DRAFT' }]);
    // The reads follow payment_request.read over the contract.
    const read = await call('GET', `/resources/payment_request/${id}`, { member: READER });
    expect(read.status).toBe(200);
    expect(read.json).toMatchObject({
      id,
      status: 'DRAFT',
      request_kind: 'INTERIM',
      contract: { id: target.contract.contractId, code: target.contract.code, status: 'ACTIVE' },
      acceptance: { id: target.acceptance.id },
      gross_vnd: '3000000000',
      advance_recovery_vnd: '750000000',
      retention_vnd: '150000000',
      net_vnd: '2100000000',
      other_drafts: 0,
      created_by: memberId(MAKER),
      actions: { revise: false, attach_document: false, cancel: false, override_duplicate: false },
      version: 1,
    });
    const lines = read.json.lines as Array<Record<string, unknown>>;
    expect(lines.map((line) => [(line.boq_item as { business_key: string }).business_key, line.gross_vnd, line.advance_recovery_vnd, line.retention_vnd, line.net_vnd])).toEqual([
      ['B01', '2000000000', '500000000', '100000000', '1400000000'],
      ['B02', '1000000000', '250000000', '50000000', '700000000'],
    ]);
    expect((await call('GET', `/resources/payment_request/${id}`, { member: MAKER })).json.actions).toEqual({ revise: true, attach_document: true, cancel: true, override_duplicate: false });
    expect((await call('GET', `/resources/payment_request/${id}`, { member: APPROVER })).json.actions).toEqual({ revise: false, attach_document: true, cancel: false, override_duplicate: true });
    expect(await call('GET', `/resources/payment_request/${id}`, { member: NOBODY })).toMatchObject({ status: 403 });
    expect(await call('GET', `/resources/payment_request/${id}`, { member: ELSEWHERE })).toMatchObject({ status: 404 });
    expect(await call('GET', `/resources/payment_request/${randomUUID()}`, { member: READER })).toMatchObject({ status: 404 });
    // A guest of the contractor reads the figures and not who drew the request up.
    const guest = await guestOf(target.contract.contractId);
    const seen = await call('GET', `/resources/payment_request/${id}`, { member: guest });
    expect(seen.status).toBe(200);
    expect(seen.json).toMatchObject({ gross_vnd: '3000000000', net_vnd: '2100000000', created_by: null, other_drafts: null, actions: { revise: false } });
    expect(await create(guest, target)).toMatchObject({ status: 403 });
  });

  it('lists the requests of the scope with filters and a cursor, and the list carries no lines', async () => {
    const target = await approved();
    const ids: string[] = [];
    for (let n = 0; n < 3; n += 1) ids.push((await create(MAKER, target)).json.resource_id as string);
    await cancel(MAKER, ids[0]!, 1);
    const url = `/resources/payment_request?contract_id=${target.contract.contractId}`;
    const all = await call('GET', url, { member: READER });
    expect((all.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([...ids].reverse());
    expect((all.json.items as Array<{ lines: unknown[] }>)[0]?.lines).toEqual([]);
    const drafts = await call('GET', `${url}&status=DRAFT&request_kind=INTERIM`, { member: READER });
    expect((drafts.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([ids[2], ids[1]]);
    const first = await call('GET', `${url}&limit=2`, { member: READER });
    expect(first.json.items).toHaveLength(2);
    const next = await call('GET', `${url}&limit=2&cursor=${encodeURIComponent(first.json.next_cursor as string)}`, { member: READER });
    expect((next.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([ids[0]]);
    expect(next.json.next_cursor).toBeNull();
    expect(await call('GET', `${url}&status=NOPE`, { member: READER })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    expect(await call('GET', '/resources/payment_request?contract_id=x', { member: READER })).toMatchObject({ status: 422 });
    expect(await call('GET', url, { member: NOBODY })).toMatchObject({ status: 403 });
    expect((await call('GET', url, { member: ELSEWHERE })).json.items).toEqual([]);
  });

  it('AC-ST-PAY-002-4, UAT-AC60: an invoice used in the contract is blocked; an approver who did not draw the request up lets it through with a reason, which is audited; in another contract it is only a warning', async () => {
    const target = await approved();
    const first = (await create(MAKER, target)).json.resource_id as string;
    const second = (await create(MAKER, target)).json.resource_id as string;
    const invoiceNo = `HD-${randomUUID().slice(0, 8)}`;
    const invoice = async (overrides: Record<string, unknown> = {}) => ({ document_version_id: (await fixtures.documentVersion()).id, doc_kind: 'INVOICE', invoice_no: invoiceNo, invoice_date: '2026-07-01', ...overrides });
    expect(await attach(MAKER, first, await invoice())).toMatchObject({ status: 200, json: { status: 'DRAFT', warnings: [] } });
    expect(await attach(MAKER, second, await invoice())).toMatchObject({ status: 409, json: { code: 'INVOICE_DUPLICATE' } });
    const reason = 'Hóa đơn điều chỉnh theo thông báo 12/TB';
    // The person who drew the request up cannot let it through, and a person without the right to approve cannot either.
    expect(await attach(MAKER, second, await invoice({ duplicate_override_reason: reason }))).toMatchObject({ status: 403 });
    const through = await attach(APPROVER, second, await invoice({ duplicate_override_reason: reason }));
    expect(through).toMatchObject({ status: 200, json: { status: 'DRAFT' } });
    const [audit] = await audits(second, 'payment_request.document_attached');
    expect(audit).toMatchObject({ actor_id: memberId(APPROVER), reason, safe_diff: { doc_kind: 'INVOICE', invoice_no: invoiceNo, override_by: memberId(APPROVER) } });
    const kept = await rows<{ duplicate_override_by: string }>('select duplicate_override_by from machvon.payment_document where payment_request_id = $1::uuid', [second]);
    expect(kept).toEqual([{ duplicate_override_by: memberId(APPROVER) }]);
    // The same number in another contract is a warning that does not block.
    const elsewhere = await approved();
    const third = (await create(MAKER, elsewhere)).json.resource_id as string;
    const warned = await attach(MAKER, third, await invoice());
    expect(warned).toMatchObject({ status: 200, json: { warnings: [{ code: 'DUPLICATE_INVOICE_OTHER_CONTRACT', detail: { invoice_no: invoiceNo, contract_ids: [target.contract.contractId] } }] } });
    // A file that is not clean, and a request that is no longer a draft, are refused.
    expect(await attach(MAKER, third, { document_version_id: (await fixtures.documentVersion('INFECTED')).id, doc_kind: 'OTHER' })).toMatchObject({ status: 422, json: { code: 'DOCUMENT_NOT_CLEAN' } });
    expect(await attach(READER, third, { document_version_id: (await fixtures.documentVersion()).id, doc_kind: 'OTHER' })).toMatchObject({ status: 403 });
    const detail = await call('GET', `/resources/payment_request/${third}`, { member: READER });
    expect((detail.json.documents as Array<Record<string, unknown>>).map((document) => [document.doc_kind, document.invoice_no, document.duplicate_override_reason])).toEqual([['INVOICE', invoiceNo, null]]);
  });

  it('cancels a draft with a reason, once, and tells PAY; a cancelled request takes no more changes', async () => {
    const target = await approved();
    const id = (await create(MAKER, target)).json.resource_id as string;
    expect(await cancel(MAKER, id, 1, '  ')).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    expect(await cancel(MAKER, id, 7)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    const done = await cancel(MAKER, id, 1);
    expect(done).toMatchObject({ status: 200, json: { status: 'CANCELLED', resource_version: 2 } });
    expect((await audits(id, 'payment_request.cancelled'))[0]).toMatchObject({ reason: 'The request was drawn up twice.', safe_diff: { from_status: 'DRAFT', to_status: 'CANCELLED' } });
    expect(await events(id, 'pay.payment_request.cancelled.v1')).toHaveLength(1);
    expect(await cancel(MAKER, id, 2)).toMatchObject({ status: 409, json: { code: 'PAYMENT_STATE_INVALID' } });
    expect(await revise(MAKER, id, 2, { request_no: 'DNTT-NEW' })).toMatchObject({ status: 409, json: { code: 'PAYMENT_STATE_INVALID' } });
    expect(await attach(MAKER, id, { document_version_id: (await fixtures.documentVersion()).id, doc_kind: 'OTHER' })).toMatchObject({ status: 409, json: { code: 'PAYMENT_STATE_INVALID' } });
  });

  it('serialises thirty requests for one number at once over HTTP: exactly one is drawn up (UAT-AC320 spirit)', async () => {
    const target = await approved();
    const replies = await Promise.all(Array.from({ length: 30 }, () => create(MAKER, target, { request_no: 'DNTT-RACE' })));
    expect(replies.filter((reply) => reply.status === 200)).toHaveLength(1);
    expect(replies.filter((reply) => reply.status === 409 && reply.json.code === 'PAYMENT_REFERENCE_DUPLICATE')).toHaveLength(29);
  });
});
