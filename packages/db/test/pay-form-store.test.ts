import { randomUUID } from 'node:crypto';
import { PAYMENT_FORM_CODES } from '@machvon/kernel';
import type { PaymentFormCode } from '@machvon/kernel';
import { PayClaimStore } from '../src/pay-claim-store';
import { PayFormStore } from '../src/pay-form-store';
import type { RecordFormInput } from '../src/pay-form-store';
import { PayPaymentStore } from '../src/pay-payment-store';
import type { ContractScopes } from '../src/ctr-contract-store';
import type { TenantTx } from '../src/tenant-database';
import { TENANT_A, memberId } from './support/authz-fixtures';
import { AcceptanceWorld } from './support/acceptance-fixtures';

jest.setTimeout(600_000);

const fixtures = new AcceptanceWorld();
const payments = new PayPaymentStore();
const claims = new PayClaimStore();
const forms = new PayFormStore();
const MAKER = 1;
const SENDER = 2;
const CHECKER = 3;
const TODAY = '2026-07-25';
const everything: ContractScopes = { update: () => ({ sql: 'true', params: [] }), read: () => ({ sql: 'true', params: [] }) };
const readOnly: ContractScopes = { update: () => ({ sql: 'false', params: [] }), read: () => ({ sql: 'true', params: [] }) };

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = MAKER): Promise<T> => fixtures.as(work, member);
const owner = fixtures.owner.bind(fixtures);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string; extensions?: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
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

interface Request {
  id: string;
  contractId: string;
  version: number;
}

let counter = 0;
/** A payment request that has been drawn up, sent and checked: gross 3bn, recovery 750m, retention 150m, net 2.1bn. */
async function checked(): Promise<Request> {
  counter += 1;
  const contract = await fixtures.seedContract();
  await owner('update machvon.contract_party set work_value_vnd = 10000000000 where contract_id = $1::uuid', [contract.contractId]);
  await owner('update machvon.contract set advance_paid_vnd = 2000000000 where id = $1::uuid', [contract.contractId]);
  await owner(
    `insert into machvon.contract_advance (tenant_id, id, contract_id, party_id, tranche_no, kind, amount_vnd, cap_vnd, status, paid_vnd, paid_on, recovery_threshold_pct, recovery_deadline, created_by, updated_by)
     values ($1, gen_random_uuid(), $2::uuid, $3::uuid, 1, 'GPMB', 2000000000, 2000000000, 'PAID', 2000000000, date '2026-06-01', 80, date '2026-12-31', $4::uuid, $4::uuid)`,
    [TENANT_A, contract.contractId, contract.partyId, memberId(MAKER)],
  );
  const approved = await fixtures.approve(contract, [
    { item: 0, quantity: '2000' },
    { item: 1, quantity: '500' },
  ]);
  const made = await as((tx) => payments.create(tx, { contractId: contract.contractId, requestKind: 'INTERIM', acceptanceId: approved.acceptance.id, allocationLineId: fixtures.lineId, requestNo: `DNTT-F-${counter}-${randomUUID().slice(0, 6)}` }, memberId(MAKER), everything, TODAY));
  const document = await fixtures.documentVersion();
  await as((tx) => payments.attachDocument(tx, made.id, { documentVersionId: document.id, docKind: 'INVOICE', invoiceNo: `HD-F-${counter}-${randomUUID().slice(0, 6)}`, invoiceDate: '2026-07-01' }, memberId(MAKER), everything, { mayOverride: () => false }));
  const sent = await as((tx) => claims.submit(tx, made.id, made.version, { expectedGrossVnd: made.grossVnd, expectedNetVnd: made.netVnd, requestId: randomUUID() }, memberId(SENDER), everything, TODAY), SENDER);
  const verified = await as((tx) => claims.verify(tx, made.id, sent.version, undefined, memberId(CHECKER), everything), CHECKER);
  return { id: made.id, contractId: contract.contractId, version: verified.version };
}

/** The proof a form leaves: the file DOC stored, the template revision it came from and the hashes. */
async function proof(requestId: string, formCode: PaymentFormCode, overrides: Partial<RecordFormInput> = {}): Promise<RecordFormInput> {
  const version = await fixtures.documentVersion();
  const [row] = await owner<{ document_id: string }>('select document_id from machvon.document_version where id = $1::uuid', [version.id]);
  return {
    requestId,
    formCode,
    template: { id: randomUUID(), code: `PAY-ND254-${formCode.slice(0, 4).replace(/\W/g, '')}`, revision: 1, legalBasis: 'Decree 254/2025/ND-CP, appendix (fixture)' },
    document: { documentId: row?.document_id as string, versionId: version.id, checksum: version.checksum.slice(0, 64) },
    payloadSha256: 'b'.repeat(64),
    inputSha256: 'c'.repeat(64),
    actor: memberId(MAKER),
    ...overrides,
  };
}
const draw = async (requestId: string, formCode: PaymentFormCode) => as(async (tx) => forms.record(tx, await proof(requestId, formCode)));
const drawAll = async (requestId: string) => {
  const drawn = [];
  for (const code of PAYMENT_FORM_CODES) drawn.push(await draw(requestId, code));
  return drawn;
};
const send = (requestId: string, version: number, ids: string[], overrides: { sentOn?: string; ref?: string | undefined; scopes?: ContractScopes } = {}) =>
  as(
    (tx) => forms.markSent(tx, requestId, version, { sentOn: overrides.sentOn ?? '2026-07-24', treasuryRef: 'ref' in overrides ? overrides.ref : 'KB-0001', formInstanceIds: ids }, memberId(MAKER), overrides.scopes ?? everything, TODAY),
  );
const rowOf = async (requestId: string) =>
  (
    await owner<{ status: string; version: string; sent_on: string | null; ref: string | null; sent_by: string | null }>(
      'select status, version::text, treasury_submitted_on::text as sent_on, treasury_ref as ref, treasury_sent_by as sent_by from machvon.payment_request where id = $1::uuid',
      [requestId],
    )
  )[0];
const instances = (requestId: string) =>
  owner<{ id: string; form_code: string; status: string }>('select id, form_code, status from machvon.payment_form_instance where payment_request_id = $1::uuid order by form_code, created_at', [requestId]);

describe('the Treasury forms of a payment request (ST-PAY-005)', () => {
  beforeAll(async () => {
    await fixtures.start();
  }, 240_000);

  afterAll(async () => {
    await fixtures.stop();
  }, 60_000);

  describe('the request the forms are drawn for', () => {
    it('is held for update with the figures that fill the forms, and only while it is checked', async () => {
      const target = await checked();
      const held = await as((tx) => forms.lockChecked(tx, target.id, everything, target.version));
      expect(held).toMatchObject({
        id: target.id,
        version: target.version,
        status: 'VERIFIED',
        facts: { requestKind: 'INTERIM', grossVnd: '3000000000', advanceRecoveryVnd: '750000000', retentionVnd: '150000000', taxAdjustmentVnd: '0', netVnd: '2100000000' },
      });
      expect(held.facts.contractCode).toMatch(/^HD-P-/);
      expect(held.facts.agency).not.toBe('');
      expect(held.facts.contractorName).not.toBe('');
      expect(await refusal(as((tx) => forms.lockChecked(tx, target.id, everything, target.version + 4)))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(as((tx) => forms.lockChecked(tx, target.id, readOnly)))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      expect(await refusal(as((tx) => forms.lockChecked(tx, randomUUID(), everything)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => forms.lockChecked(tx, 'x', everything)))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'id' });
      await owner("update machvon.payment_request set status = 'RETURNED', claims_acceptance = false, return_reason = 'x', returned_by = created_by, returned_at = now() where id = $1::uuid", [target.id]);
      expect(await refusal(as((tx) => forms.lockChecked(tx, target.id, everything)))).toMatchObject({ code: 'PAYMENT_STATE_INVALID', status: 409, extensions: { status: 'RETURNED' } });
    });
  });

  describe('keeping a form that was drawn', () => {
    it('AC-ST-PAY-005-1, UAT-AC337: keeps the template revision with its legal basis, the file and the hashes, and a new form supersedes the one before so one stands for each kind', async () => {
      const target = await checked();
      const first = await draw(target.id, '03.a/TT');
      expect(first).toMatchObject({ formCode: '03.a/TT', status: 'GENERATED', templateRevision: 1, legalBasis: 'Decree 254/2025/ND-CP, appendix (fixture)', payloadSha256: 'b'.repeat(64), generatedBy: memberId(MAKER) });
      expect(first.fileSha256).toHaveLength(64);
      expect(first.documentVersionId).toEqual(expect.any(String));
      const again = await draw(target.id, '03.a/TT');
      expect((await instances(target.id)).map((row) => [row.form_code, row.status])).toEqual([
        ['03.a/TT', 'SUPERSEDED'],
        ['03.a/TT', 'GENERATED'],
      ]);
      const listed = await as((tx) => forms.list(tx, target.id, () => ({ sql: 'true', params: [] })));
      expect(listed?.map((form) => [form.id, form.status])).toEqual([
        [again.id, 'GENERATED'],
        [first.id, 'SUPERSEDED'],
      ]);
      expect([...(await as((tx) => forms.standing(tx, [target.id]))).entries()]).toEqual([[target.id, ['03.a/TT']]]);
      expect((await as((tx) => forms.standing(tx, []))).size).toBe(0);
      expect(await as((tx) => forms.list(tx, target.id, () => ({ sql: 'false', params: [] })))).toBeUndefined();
      expect(await as((tx) => forms.list(tx, randomUUID(), () => ({ sql: 'true', params: [] })))).toBeUndefined();
      expect(await as((tx) => forms.legalBasisOf(tx, randomUUID()))).toBe('');
      expect(await as((tx) => forms.resultOf(tx, target.id))).toMatchObject({ id: target.id, status: 'VERIFIED' });
    });

    it('is refused behind the application when the request is not checked, when the proof is missing and when a hash is not a hash', async () => {
      const target = await checked();
      const proofOf = (overrides: Partial<RecordFormInput>) => proof(target.id, '04.a/TT', overrides);
      const insert = (input: RecordFormInput) => as((tx) => forms.record(tx, input));
      expect((await databaseRefusal(insert(await proofOf({ payloadSha256: 'xyz' })))).message).toContain('payment_form_instance_hash_chk');
      expect((await databaseRefusal(insert(await proofOf({ inputSha256: 'G'.repeat(64) })))).message).toContain('payment_form_instance_hash_chk');
      expect((await databaseRefusal(insert(await proofOf({ template: { id: randomUUID(), code: 'T', revision: 1, legalBasis: '  ' } })))).message).toContain('payment_form_instance_text_chk');
      expect((await databaseRefusal(insert(await proofOf({ document: { documentId: randomUUID(), versionId: randomUUID(), checksum: 'a'.repeat(64) } })))).sqlstate).toBe('23503');
      await owner("update machvon.payment_request set status = 'RETURNED', claims_acceptance = false, return_reason = 'x', returned_by = created_by, returned_at = now() where id = $1::uuid", [target.id]);
      expect(await refusal(insert(await proofOf({})))).toMatchObject({ code: 'PAYMENT_STATE_INVALID', status: 409 });
      expect(await instances(target.id)).toEqual([]);
    });

    it('is kept: it is not changed except to be superseded, not deleted and not truncated, by the runtime role or by anyone else', async () => {
      const target = await checked();
      const form = await draw(target.id, '05.a/TT');
      const update = (sql: string) => databaseRefusal(owner(`update machvon.payment_form_instance set ${sql} where id = $1::uuid`, [form.id]));
      expect((await update("legal_basis = 'something else'")).message).toContain('what a form says never changes');
      expect((await update("file_sha256 = repeat('d', 64)")).message).toContain('what a form says never changes');
      expect((await update("form_code = '03.a/TT'")).message).toContain('what a form says never changes');
      expect((await update("status = 'REQUESTED'")).message).toContain('this move of the status of a form is not allowed');
      expect((await databaseRefusal(owner('delete from machvon.payment_form_instance where id = $1::uuid', [form.id]))).message).toContain('a form that was drawn is kept');
      expect((await databaseRefusal(as((tx) => tx.query('delete from machvon.payment_form_instance where id = $1::uuid', [form.id])))).sqlstate).toBe('42501');
      expect((await databaseRefusal(as((tx) => tx.query('truncate machvon.payment_form_instance')))).sqlstate).toBe('42501');
      await owner("update machvon.payment_form_instance set status = 'SUPERSEDED' where id = $1::uuid", [form.id]);
      expect((await instances(target.id))[0]?.status).toBe('SUPERSEDED');
      expect((await update("status = 'GENERATED'")).message).toContain('this move of the status of a form is not allowed');
    });
  });

  describe('sending the file to the Treasury', () => {
    it('AC-ST-PAY-005-2, UAT-PLAN-20: is refused without a standing form of each of the four kinds, and says which are missing', async () => {
      const target = await checked();
      const three = [];
      for (const code of ['03.a/TT', '04.a/TT', '04.b/TT'] as const) three.push(await draw(target.id, code));
      const refused = await refusal(send(target.id, target.version, three.map((form) => form.id)));
      expect(refused).toMatchObject({ code: 'FORMS_NOT_GENERATED', status: 422, extensions: { missing_form_codes: ['05.a/TT'], required_form_codes: [...PAYMENT_FORM_CODES] } });
      expect(await rowOf(target.id)).toMatchObject({ status: 'VERIFIED', sent_on: null });
      // The same with only one form named, as in UAT-AC337.
      expect(await refusal(send(target.id, target.version, [three[0]!.id]))).toMatchObject({ code: 'FORMS_NOT_GENERATED', extensions: { missing_form_codes: ['04.a/TT', '04.b/TT', '05.a/TT'] } });
    });

    it('goes with the four forms that stand: the day and the number are what was entered, the person is recorded, and no form is changed', async () => {
      const target = await checked();
      const all = await drawAll(target.id);
      const done = await send(target.id, target.version, all.map((form) => form.id));
      expect(done).toMatchObject({ id: target.id, status: 'SENT_TREASURY', fromStatus: 'VERIFIED', version: target.version + 1 });
      expect(await rowOf(target.id)).toMatchObject({ status: 'SENT_TREASURY', sent_on: '2026-07-24', ref: 'KB-0001', sent_by: memberId(MAKER) });
      expect((await instances(target.id)).every((row) => row.status === 'GENERATED')).toBe(true);
      // Once sent it is not sent again, and no form is drawn for it any more.
      expect(await refusal(send(target.id, target.version + 1, all.map((form) => form.id)))).toMatchObject({ code: 'PAYMENT_STATE_INVALID', status: 409, extensions: { status: 'SENT_TREASURY' } });
      expect(await refusal(draw(target.id, '03.a/TT'))).toMatchObject({ code: 'PAYMENT_STATE_INVALID' });
    });

    it('takes the number as an option, refuses a day that is not a day or is to come, a blank number, forms that are not this request’s and a stale version', async () => {
      const target = await checked();
      const other = await checked();
      const all = await drawAll(target.id);
      const foreign = await drawAll(other.id);
      const ids = all.map((form) => form.id);
      expect(await refusal(send(target.id, target.version, ids, { sentOn: '2026-02-30' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'treasury_submitted_on' });
      expect(await refusal(send(target.id, target.version, ids, { sentOn: 'tomorrow' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'treasury_submitted_on' });
      expect(await refusal(send(target.id, target.version, ids, { sentOn: '2026-07-26' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'treasury_submitted_on', extensions: { reason: 'IN_THE_FUTURE' } });
      expect(await refusal(send(target.id, target.version, ids, { ref: '   ' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'treasury_ref' });
      expect(await refusal(send(target.id, target.version, ids, { ref: 'x'.repeat(201) }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'treasury_ref' });
      expect(await refusal(send(target.id, target.version, []))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'form_instance_ids' });
      expect(await refusal(send(target.id, target.version, ['x']))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'form_instance_ids' });
      expect(await refusal(send(target.id, target.version, [...ids.slice(1), foreign[0]!.id]))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'form_instance_ids', extensions: { reason: 'NOT_STANDING_FORMS_OF_THIS_REQUEST' } });
      expect(await refusal(send(target.id, target.version + 3, ids))).toMatchObject({ code: 'VERSION_CONFLICT' });
      expect(await refusal(send(target.id, target.version, ids, { scopes: readOnly }))).toMatchObject({ code: 'SCOPE_DENIED' });
      expect(await rowOf(target.id)).toMatchObject({ status: 'VERIFIED' });
      expect(await send(target.id, target.version, ids, { ref: undefined })).toMatchObject({ status: 'SENT_TREASURY' });
      expect((await rowOf(target.id))?.ref).toBeNull();
    });

    it('is refused behind the application without the forms, the day or the person', async () => {
      const target = await checked();
      const update = (sql: string) => databaseRefusal(owner(`update machvon.payment_request set ${sql} where id = $1::uuid`, [target.id]));
      expect((await update("status = 'SENT_TREASURY'")).message).toContain('a request sent to the Treasury says on which day');
      expect((await update(`status = 'SENT_TREASURY', treasury_submitted_on = date '2026-07-24', treasury_sent_by = '${memberId(MAKER)}', treasury_sent_at = now()`)).message).toContain('FORMS_NOT_GENERATED');
      expect((await update("treasury_submitted_on = date '2026-07-24'")).message).toContain('payment_request_treasury_sent_chk');
      await drawAll(target.id);
      expect(await owner(`update machvon.payment_request set status = 'SENT_TREASURY', treasury_submitted_on = date '2026-07-24', treasury_sent_by = '${memberId(MAKER)}', treasury_sent_at = now() where id = $1::uuid returning id`, [target.id])).toHaveLength(1);
      expect((await update("treasury_ref = ' '")).message).toContain('payment_request_treasury_ref_chk');
    });

    it('does not count a kind twice, nor a form that was superseded, as the four', async () => {
      const target = await checked();
      await draw(target.id, '03.a/TT');
      await draw(target.id, '03.a/TT');
      await draw(target.id, '04.a/TT');
      await draw(target.id, '04.b/TT');
      const sentRow = `status = 'SENT_TREASURY', treasury_submitted_on = date '2026-07-24', treasury_sent_by = '${memberId(MAKER)}', treasury_sent_at = now()`;
      expect((await databaseRefusal(owner(`update machvon.payment_request set ${sentRow} where id = $1::uuid`, [target.id]))).message).toContain('FORMS_NOT_GENERATED');
    });
  });

  describe('a request that comes back', () => {
    it('supersedes the forms that were drawn for its old figures, so they are drawn again when it has been corrected and checked', async () => {
      const target = await checked();
      await drawAll(target.id);
      const returned = await as((tx) => claims.returnRequest(tx, target.id, target.version, { reason: 'The tax adjustment was wrong.', reasonCode: 'MISSING_DOCUMENT', requestId: randomUUID() }, memberId(CHECKER), everything), CHECKER);
      expect(returned.status).toBe('RETURNED');
      expect((await instances(target.id)).map((row) => row.status)).toEqual(['SUPERSEDED', 'SUPERSEDED', 'SUPERSEDED', 'SUPERSEDED']);
      expect((await as((tx) => forms.standing(tx, [target.id]))).size).toBe(0);
    });
  });
});
