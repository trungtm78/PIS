import { randomUUID } from 'node:crypto';
import type { TreasuryCallbackFields } from '@machvon/db';
import { TreasuryTransactionController, TreasuryTransactionReadsController } from '../../src/modules/pay/treasury-transaction.controller';
import { TENANT_A, id } from '../../../../packages/db/test/support/authz-fixtures';
import { seedPaymentRequest } from '../../../../packages/db/test/support/pay-fixtures';
import { FAMILY, MEMBERS, PROVIDER, PayApp } from './pay-app';

const { CONFIRMER, BRANCH_CONFIRMER, SERVICE, BRANCH_SERVICE, BRANCH_READER, IMPORTER, NOBODY, MAKER } = MEMBERS;
const pay = new PayApp();
let counter = 0;

/** A payment request in SENT_TREASURY, drafted and sent by the maker, of project A (or B). */
async function request(options: { status?: string; netVnd?: string; projectB?: boolean } = {}): Promise<string> {
  counter += 1;
  const requestId = id(FAMILY, 500 + counter);
  const world = pay.worldA;
  await seedPaymentRequest(pay.harness.database.adminUrl, TENANT_A, {
    id: requestId,
    project: options.projectB === true ? world.projectB : world.projectA,
    contract: options.projectB === true ? world.contractB : world.contractA,
    acceptance: id(FAMILY, 700 + counter),
    netVnd: options.netVnd ?? '1000000',
    createdBy: MAKER,
    submittedBy: MAKER,
    ...(options.status === undefined ? {} : { status: options.status }),
  });
  return requestId;
}

const confirmBody = (paymentRequestId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => {
  counter += 1;
  return {
    payment_request_id: paymentRequestId,
    document_no: `CT-API-${counter}`,
    document_date: '2026-10-15',
    amount_vnd: '1000000',
    confirmed_at: '2026-10-16T02:00:00Z',
    evidence_document_version_id: pay.worldA.evidence,
    ...extra,
  };
};

const fieldsOf = (extra: Partial<TreasuryCallbackFields> = {}): TreasuryCallbackFields => {
  counter += 1;
  return {
    providerEventId: `evt-api-${counter}-${randomUUID().slice(0, 8)}`,
    provider: PROVIDER,
    documentNo: `CT-CB-${counter}`,
    documentDate: '2026-10-15',
    projectCode: pay.worldA.projectCodeA,
    amountVnd: '4200000',
    direction: 'PAYMENT',
    confirmedAt: '2026-10-16T02:00:00.000Z',
    ...extra,
  };
};

describe('confirmTreasuryManually, receiveTreasuryCallback and the reads of the transactions (ST-PAY-006)', () => {
  beforeAll(async () => {
    await pay.start();
  }, 240_000);

  afterAll(async () => {
    await pay.stop();
  }, 60_000);

  it('is registered in the PAY module with the controllers of the transactions', () => {
    expect([...pay.app.implementedOperations]).toEqual(expect.arrayContaining(['confirmTreasuryManually', 'receiveTreasuryCallback', 'get_resources_treasury_transaction', 'get_resources_treasury_transaction_id']));
    expect(TreasuryTransactionController).toBeDefined();
    expect(TreasuryTransactionReadsController).toBeDefined();
  });

  describe('confirmTreasuryManually', () => {
    it('records the confirmation with its evidence, audits it and tells the world once; the amount that is the net waits for the match', async () => {
      const requestId = await request();
      const body = confirmBody(requestId);
      const reply = await pay.call('POST', '/treasury-transactions', { member: CONFIRMER, body });
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ status: 'UNMATCHED', resource_version: 1, reconciliation_item_id: null });
      const transactionId = reply.json.resource_id as string;
      expect(await pay.rows('select source_kind, match_status, payment_request_id, amount_vnd::text as amount_vnd from machvon.treasury_transaction where id = $1', [transactionId])).toEqual([
        { source_kind: 'MANUAL_CONFIRMED', match_status: 'UNMATCHED', payment_request_id: requestId, amount_vnd: '1000000' },
      ]);
      expect(await pay.rows('select action from machvon.audit_event where resource_id = $1', [transactionId])).toEqual([{ action: 'pay.treasury_transaction_confirmed' }]);
      expect(await pay.rows('select type from machvon.outbox_event where aggregate_id = $1', [transactionId])).toEqual([{ type: 'pay.treasury_transaction.confirmed.v1' }]);
      // The audit says what was confirmed and nothing personal.
      const [audit] = await pay.rows<{ safe_diff: Record<string, unknown> }>('select safe_diff from machvon.audit_event where resource_id = $1', [transactionId]);
      expect(audit?.safe_diff).toMatchObject({ payment_request_id: requestId, document_no: body.document_no, amount_vnd: '1000000', net_vnd: '1000000', source_kind: 'MANUAL_CONFIRMED', match_status: 'UNMATCHED' });
    });

    it('records a different amount in EXCEPTION, opens the item with both figures, and does not call it an error', async () => {
      const requestId = await request({ netVnd: '2000000' });
      const reply = await pay.call('POST', '/treasury-transactions', { member: CONFIRMER, body: confirmBody(requestId, { amount_vnd: '2000500' }) });
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ status: 'EXCEPTION', reconciliation_item_id: expect.any(String) });
      expect(await pay.rows('select kind, internal_amount_vnd::text as internal, confirmed_amount_vnd::text as confirmed, difference_vnd::text as difference, status from machvon.reconciliation_item where id = $1', [reply.json.reconciliation_item_id])).toEqual([
        { kind: 'AMOUNT_MISMATCH', internal: '2000000', confirmed: '2000500', difference: '500', status: 'OPEN' },
      ]);
    });

    it('refuses the maker (403 SELF_APPROVAL_DENIED), a request that was not sent (409), a duplicate (409) and a request out of scope (404)', async () => {
      const requestId = await request();
      // The maker holds the permission here only to prove the rule: the grant is added and removed around the call.
      await pay.harness.seedRole(TENANT_A, 9, 'MAKER_CONFIRMS', ['treasury.confirm_manual'], 30);
      await pay.harness.seedGrants(TENANT_A, [{ n: 9, member: MAKER, role: 9, kind: 'TENANT' }]);
      const self = await pay.call('POST', '/treasury-transactions', { member: MAKER, body: confirmBody(requestId) });
      expect([self.status, self.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      await pay.rows("update machvon.role_grant set status = 'Revoked', revoked_at = now() where id = $1", [id(0x40, 9)]);

      const draft = await request({ status: 'DRAFT' });
      expect(await pay.call('POST', '/treasury-transactions', { member: CONFIRMER, body: confirmBody(draft) })).toMatchObject({ status: 409, json: { code: 'PAYMENT_STATE_INVALID' } });

      const body = confirmBody(requestId);
      expect((await pay.call('POST', '/treasury-transactions', { member: CONFIRMER, body })).status).toBe(200);
      expect(await pay.call('POST', '/treasury-transactions', { member: CONFIRMER, body: confirmBody(requestId) })).toMatchObject({ status: 409, json: { code: 'TREASURY_TRANSACTION_DUPLICATE' } });

      const elsewhere = await request({ projectB: true });
      expect((await pay.call('POST', '/treasury-transactions', { member: BRANCH_CONFIRMER, body: confirmBody(elsewhere) })).status).toBe(404);
      expect((await pay.call('POST', '/treasury-transactions', { member: BRANCH_CONFIRMER, body: confirmBody(await request()) })).status).toBe(200);
      expect((await pay.call('POST', '/treasury-transactions', { member: NOBODY, body: confirmBody(await request()) })).status).toBe(403);
    });

    it('refuses evidence that is infected or unknown, and a request the contract does not allow', async () => {
      const requestId = await request();
      expect(await pay.call('POST', '/treasury-transactions', { member: CONFIRMER, body: confirmBody(requestId, { evidence_document_version_id: pay.worldA.infectedEvidence }) })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect((await pay.call('POST', '/treasury-transactions', { member: CONFIRMER, body: confirmBody(requestId, { evidence_document_version_id: randomUUID() }) })).status).toBe(422);
      expect((await pay.call('POST', '/treasury-transactions', { member: CONFIRMER, body: confirmBody(requestId, { surprise: 1 }) })).status).toBe(400);
      expect((await pay.call('POST', '/treasury-transactions', { member: CONFIRMER, body: confirmBody(requestId, { amount_vnd: '-5' }) })).status).toBe(422);
      expect((await pay.call('POST', '/treasury-transactions', { member: CONFIRMER, body: confirmBody(requestId, { amount_vnd: '0' }) })).status).toBe(422);
      expect((await pay.call('POST', '/treasury-transactions', { member: CONFIRMER, body: confirmBody(requestId, { payment_request_id: 'x' }) })).status).toBe(422);
      expect(await pay.count('select count(*)::text as n from machvon.treasury_transaction where payment_request_id = $1', [requestId])).toBe(0);
    });
  });

  describe('receiveTreasuryCallback (adapter MOCK) (AC-ST-PAY-006-3)', () => {
    it('creates exactly one transaction when the same event is delivered twice with signature check, and the second answers the first (AC-ST-PAY-006-3)', async () => {
      const fields = fieldsOf();
      const body = pay.signedCallback(fields);
      const first = await pay.call('POST', '/integrations/treasury/callbacks', { member: SERVICE, body });
      const second = await pay.call('POST', '/integrations/treasury/callbacks', { member: SERVICE, body });
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({ status: 'UNMATCHED', resource_version: 1, duplicate: false });
      expect(second.status).toBe(200);
      expect(second.json).toMatchObject({ status: 'UNMATCHED', resource_id: first.json.resource_id, duplicate: true });
      expect(await pay.count('select count(*)::text as n from machvon.treasury_transaction where provider_event_id = $1', [fields.providerEventId])).toBe(1);
      expect(await pay.rows('select action from machvon.audit_event where resource_id = $1 order by occurred_at, id', [first.json.resource_id])).toEqual([
        { action: 'pay.treasury_callback_received' },
        { action: 'pay.treasury_callback_repeated' },
      ]);
      expect(await pay.rows('select type from machvon.outbox_event where aggregate_id = $1', [first.json.resource_id])).toEqual([{ type: 'pay.treasury_transaction.confirmed.v1' }]);
      // The signed body is kept by reference, and the inbox holds its hash, not its content.
      const [inbox] = await pay.rows<{ status: string; payload_reference: string; signature_key_id: string }>('select status, payload_reference, signature_key_id from machvon.integration_event_inbox where event_key = $1', [fields.providerEventId]);
      expect(inbox).toMatchObject({ status: 'PROCESSED', signature_key_id: 'mock-1' });
      expect(inbox?.payload_reference).toMatch(/^tenants\/[^/]+\/webhook\//);
    });

    it('UAT-AC10: the same callback sent twice with the same Idempotency-Key makes one transaction of 2,100,000,000 (source CALLBACK_MOCK) and the second answer is the first one, byte for byte; another event that claims the same voucher with other figures is 409 TREASURY_TRANSACTION_DUPLICATE and the count stays 1', async () => {
      const fields = fieldsOf({ providerEventId: `EVT-KB-0001-${randomUUID().slice(0, 8)}`, documentNo: `CT-0001-${randomUUID().slice(0, 8)}`, documentDate: '2026-07-02', amountVnd: '2100000000' });
      const body = pay.signedCallback(fields);
      const key = `callback-evt-kb-0001-${randomUUID()}`;
      const countOf = (): Promise<number> => pay.count('select count(*)::text as n from machvon.treasury_transaction where document_no = $1 and document_date = $2::date', [fields.documentNo, fields.documentDate]);
      const first = await pay.call('POST', '/integrations/treasury/callbacks', { member: SERVICE, body, key });
      expect(first.status).toBe(200);
      expect(await pay.rows('select amount_vnd::text as amount, source_kind from machvon.treasury_transaction where id = $1::uuid', [first.json.resource_id])).toEqual([{ amount: '2100000000', source_kind: 'CALLBACK_MOCK' }]);
      const second = await pay.call('POST', '/integrations/treasury/callbacks', { member: SERVICE, body, key });
      expect(second.status).toBe(200);
      expect(second.json).toEqual(first.json);
      expect(await countOf()).toBe(1);
      // EVT-KB-0002 claims the voucher CT-0001 of the same day and project with another amount: refused, and nothing is added (the paid total cannot double).
      const other = await pay.call('POST', '/integrations/treasury/callbacks', { member: SERVICE, body: pay.signedCallback({ ...fields, providerEventId: `EVT-KB-0002-${randomUUID().slice(0, 8)}`, amountVnd: '2100000001' }) });
      expect([other.status, other.json.code]).toEqual([409, 'TREASURY_TRANSACTION_DUPLICATE']);
      expect(await countOf()).toBe(1);
      expect(await pay.rows('select type from machvon.outbox_event where aggregate_id = $1', [first.json.resource_id])).toEqual([{ type: 'pay.treasury_transaction.confirmed.v1' }]);
    });

    it('answers the first result for the same voucher under another event id, and refuses the same voucher with other content (409)', async () => {
      const fields = fieldsOf();
      const first = await pay.call('POST', '/integrations/treasury/callbacks', { member: SERVICE, body: pay.signedCallback(fields) });
      const resent = await pay.call('POST', '/integrations/treasury/callbacks', { member: SERVICE, body: pay.signedCallback({ ...fields, providerEventId: `resent-${randomUUID().slice(0, 8)}` }) });
      expect(resent.json).toMatchObject({ resource_id: first.json.resource_id, duplicate: true });
      const other = await pay.call('POST', '/integrations/treasury/callbacks', { member: SERVICE, body: pay.signedCallback({ ...fields, providerEventId: `other-${randomUUID().slice(0, 8)}`, amountVnd: '1' }) });
      expect([other.status, other.json.code]).toEqual([409, 'TREASURY_TRANSACTION_DUPLICATE']);
    });

    it('refuses an event that is not signed by the Treasury as 401 SIGNATURE_INVALID and stores nothing', async () => {
      const fields = fieldsOf();
      const forged = pay.signedCallback(fields, Buffer.from('not-the-treasury'));
      const reply = await pay.call('POST', '/integrations/treasury/callbacks', { member: SERVICE, body: forged });
      expect([reply.status, reply.json.code]).toEqual([401, 'SIGNATURE_INVALID']);
      const tampered = { ...pay.signedCallback(fields), amount_vnd: '1' };
      expect((await pay.call('POST', '/integrations/treasury/callbacks', { member: SERVICE, body: tampered })).status).toBe(401);
      // A provider whose keys the process does not hold is refused too: nothing is accepted unsigned.
      const stranger = fieldsOf({ provider: 'OTHER_BANK' });
      expect((await pay.call('POST', '/integrations/treasury/callbacks', { member: SERVICE, body: pay.signedCallback(stranger) })).status).toBe(401);
      expect(await pay.count('select count(*)::text as n from machvon.integration_event_inbox where event_key = any($1::text[])', [[fields.providerEventId, stranger.providerEventId]])).toBe(0);
      expect(await pay.count('select count(*)::text as n from machvon.treasury_transaction where provider_event_id = $1', [fields.providerEventId])).toBe(0);
    });

    it('is for the Treasury service principal of the whole tenant: a branch grant or no grant is refused (403)', async () => {
      const body = pay.signedCallback(fieldsOf());
      const branch = await pay.call('POST', '/integrations/treasury/callbacks', { member: BRANCH_SERVICE, body });
      expect([branch.status, branch.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect((await pay.call('POST', '/integrations/treasury/callbacks', { member: NOBODY, body })).status).toBe(403);
    });

    it('refuses a project that does not exist, a refund, a reserved provider and a field the contract does not allow', async () => {
      const unknown = await pay.call('POST', '/integrations/treasury/callbacks', { member: SERVICE, body: pay.signedCallback(fieldsOf({ projectCode: 'NO-SUCH' })) });
      expect([unknown.status, unknown.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      expect((await pay.call('POST', '/integrations/treasury/callbacks', { member: SERVICE, body: pay.signedCallback(fieldsOf({ direction: 'REFUND' })) })).status).toBe(422);
      expect((await pay.call('POST', '/integrations/treasury/callbacks', { member: SERVICE, body: { ...pay.signedCallback(fieldsOf()), surprise: true } })).status).toBe(400);
      expect((await pay.call('POST', '/integrations/treasury/callbacks', { member: SERVICE, body: { ...pay.signedCallback(fieldsOf()), amount_vnd: 'abc' } })).status).toBe(422);
    });
  });

  describe('the reads of the transactions', () => {
    it('lists the transactions in the scope of the caller and finds one only there; a transaction of another project is not found', async () => {
      const a = await pay.call('POST', '/integrations/treasury/callbacks', { member: SERVICE, body: pay.signedCallback(fieldsOf({ confirmedAt: '2027-01-01T01:00:00.000Z' })) });
      const b = await pay.call('POST', '/integrations/treasury/callbacks', { member: SERVICE, body: pay.signedCallback(fieldsOf({ projectCode: pay.worldA.projectCodeB, confirmedAt: '2027-01-01T02:00:00.000Z' })) });
      const all = await pay.call('GET', '/resources/treasury_transaction?limit=2', { member: IMPORTER });
      expect(all.status).toBe(200);
      expect((all.json.items as Array<Record<string, unknown>>).map((item) => item.id)).toEqual([b.json.resource_id, a.json.resource_id]);
      expect(all.json.next_cursor).not.toBeNull();
      const next = await pay.call('GET', `/resources/treasury_transaction?limit=200&cursor=${String(all.json.next_cursor)}`, { member: IMPORTER });
      expect((next.json.items as unknown[]).length).toBeGreaterThan(0);

      const branch = await pay.call('GET', '/resources/treasury_transaction?limit=200', { member: BRANCH_READER });
      const ids = (branch.json.items as Array<Record<string, unknown>>).map((item) => item.id);
      expect(ids).toContain(a.json.resource_id);
      expect(ids).not.toContain(b.json.resource_id);
      expect((await pay.call('GET', `/resources/treasury_transaction/${String(a.json.resource_id)}`, { member: BRANCH_READER })).status).toBe(200);
      expect((await pay.call('GET', `/resources/treasury_transaction/${String(b.json.resource_id)}`, { member: BRANCH_READER })).status).toBe(404);
      expect((await pay.call('GET', `/resources/treasury_transaction/${String(a.json.resource_id)}`, { member: NOBODY })).status).toBe(403);
      expect((await pay.call('GET', '/resources/treasury_transaction?limit=0', { member: IMPORTER })).status).toBe(422);
    });

    it('shows an allowlist of fields: no deduplication key, hash, evidence or account', async () => {
      const created = await pay.call('POST', '/integrations/treasury/callbacks', { member: SERVICE, body: pay.signedCallback(fieldsOf()) });
      const one = await pay.call('GET', `/resources/treasury_transaction/${String(created.json.resource_id)}`, { member: IMPORTER });
      expect(Object.keys(one.json).sort()).toEqual(
        ['amount_vnd', 'confirmed_at', 'direction', 'document_date', 'document_no', 'id', 'import_id', 'match_status', 'payment_request_id', 'plan_year', 'project_code', 'project_id', 'provider', 'reversal_of_id', 'source_kind'].sort(),
      );
      expect(one.json).toMatchObject({ source_kind: 'CALLBACK_MOCK', provider: PROVIDER, direction: 'PAYMENT', match_status: 'UNMATCHED', amount_vnd: '4200000', project_code: pay.worldA.projectCodeA });
    });
  });
});
