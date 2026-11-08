import { randomBytes, randomUUID } from 'node:crypto';
import { FieldCipher, matchKeyOf, staticKeyProvider } from '@machvon/kernel';
import { BidContractorStore } from '../src/bid-contractor-store';
import { VendorGate } from '../src/vendor-gate';
import { VendorPayeeStore } from '../src/vendor-payee-store';
import { VendorPolicyReader } from '../src/vendor-policy';
import { VendorProfileStore } from '../src/vendor-profile-store';
import { VendorQualificationStore } from '../src/vendor-qualification-store';
import { VendorReputationStore } from '../src/vendor-reputation-store';
import { RestrictionCaseStore } from '../src/vendor-restriction-store';
import { VendorVentureStore } from '../src/vendor-venture-store';
import { WorkCalendarStore } from '../src/work-calendar-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, contextFor, memberId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const cipher = new FieldCipher(staticKeyProvider(new Map([[1, randomBytes(32)]])));
const profiles = new VendorProfileStore();
const payee = new VendorPayeeStore(cipher);
const qualifications = new VendorQualificationStore();
const cases = new RestrictionCaseStore();
const ventures = new VendorVentureStore();
const reputation = new VendorReputationStore();
const gate = new VendorGate();
const policies = new VendorPolicyReader();
const bidContractors = new BidContractorStore();
const calendars = new WorkCalendarStore();

const [M1, M2, M3, M4, M5] = [1, 2, 3, 4, 5];
const as = <T>(work: (tx: TenantTx) => Promise<T>, member = M1): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string; extensions?: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

const databaseRefusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the database to refuse');
};

async function document(effective = true): Promise<string> {
  const id = randomUUID();
  await owner(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, symbol, issued_on, effect_status, created_by, updated_by)
     values ($1, $2, 'REFERENCE', 'QD', 'Decision', 'INTERNAL', '12/QD', date '2026-01-01', $3, $4, $4)`,
    [TENANT_A, id, effective ? 'EFFECTIVE' : 'PENDING', memberId(M1)],
  );
  return id;
}

let counter = 0;
/** A verified contractor, seeded the way the other fixtures do (a verification by a person is the business of the BID tests). */
async function contractor(name = 'Cty Nha Thau Mot', extra: { taxId?: string; verified?: boolean } = {}): Promise<string> {
  counter += 1;
  const id = randomUUID();
  const profile = await document();
  await owner(
    `insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id, created_by, updated_by, verified_by, verified_at, verification_evidence_document_id, verification_basis)
     values ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, $11)`,
    [TENANT_A, id, extra.taxId ?? `03${String(counter).padStart(8, '0')}`, name, extra.verified === false ? 'UNVERIFIED' : 'VERIFIED', profile, memberId(M1), extra.verified === false ? null : memberId(M2), extra.verified === false ? null : new Date().toISOString(), extra.verified === false ? null : await document(false), extra.verified === false ? null : 'EVIDENCE_DOCUMENT'],
  );
  return id;
}

const NOW = new Date('2026-11-09T03:00:00Z');
const day = (offset: number): Date => new Date(NOW.getTime() + offset * 86_400_000);

describe('the management of contractors (VND-1)', () => {
  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: 1, path: '/u1/' }]);
    for (const member of [M1, M2, M3, M4, M5]) await harness.seedMembership(TENANT_A, member, 1);
    for (const year of [2026, 2027, 2028]) {
      await as(async (tx) => {
        const draft = await calendars.createDraft(tx, { calendar_code: 'WORKDAY_VN', year, working_days: [1, 2, 3, 4, 5], holidays: [], legal_basis_ref: 'Labour Code' }, memberId(M1));
        const locked = await calendars.lockDraft(tx, draft.id, draft.version);
        await calendars.publish(tx, locked, memberId(M1));
      });
    }
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the profile, the owners and the duplicates', () => {
    it('keeps the profile with the keys of its normal forms, sets the day of the next review and moves the day of the number only when it changes', async () => {
      const id = await contractor('Cty Profile A');
      const first = await as((tx) => profiles.update(tx, id, 1, { legalRepName: 'Nguyen Van A', registeredAddress: '12 Le Loi, Quan 1', phone: '+84 912 345 678', email: 'Contact@Firm.VN', businessRegistrationNo: '0101-001' }, memberId(M1), '2026-11-09', 12));
      expect(first).toMatchObject({ legalRepName: 'Nguyen Van A', phone: '0912345678', email: 'contact@firm.vn', nextReviewDue: '2027-11-09', version: 2 });
      const [keys] = await owner<{ phone_key: string; address_key: string; phone_set_at: string }>('select phone_key, address_key, phone_set_at::text from machvon.contractor where id = $1', [id]);
      expect(keys?.phone_key).toMatch(/^[0-9a-f]{64}$/);
      const second = await as((tx) => profiles.update(tx, id, 2, { legalRepPosition: 'Director', phone: '0912345678' }, memberId(M1), '2026-11-10', 12));
      const [after] = await owner<{ phone_set_at: string }>('select phone_set_at::text from machvon.contractor where id = $1', [id]);
      expect(after?.phone_set_at).toBe(keys?.phone_set_at);
      expect(second.version).toBe(3);
      expect((await refusal(as((tx) => profiles.update(tx, id, 2, { legalRepPosition: 'Chair' }, memberId(M1), '2026-11-10', 12)))).code).toBe('VERSION_CONFLICT');
      expect(await refusal(as((tx) => profiles.update(tx, id, 3, { phone: '12' }, memberId(M1), '2026-11-10', 12)))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'phone' });
      expect(await refusal(as((tx) => profiles.update(tx, id, 3, { registeredAddress: 'short' }, memberId(M1), '2026-11-10', 12)))).toMatchObject({ detail: 'registered_address' });
    });

    it('lists owners that make sense, ends them without erasing them and refuses a rewrite', async () => {
      const id = await contractor('Cty Owners');
      const key = (value: string): string => cipher.blindIndex(TENANT_A, 'owner-identity', value);
      const a = await as((tx) => profiles.addOwner(tx, id, { ownerKind: 'PERSON', ownerName: 'Tran Thi B', sharePct: '60', beneficialOwner: true, identityNumber: '012345678901' }, memberId(M1), key));
      expect(a).toMatchObject({ ownerName: 'Tran Thi B', sharePct: '60.00', hasIdentityKey: true, endedOn: null });
      expect(await refusal(as((tx) => profiles.addOwner(tx, id, { ownerKind: 'PERSON', ownerName: 'Le C', sharePct: '45', beneficialOwner: false }, memberId(M1), key)))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'owners.share_pct' });
      await as((tx) => profiles.addOwner(tx, id, { ownerKind: 'ORGANISATION', ownerName: 'Holding D', sharePct: '40', beneficialOwner: false }, memberId(M1), key));
      expect((await as((tx) => profiles.require(tx, id))).ownershipDeclaration).toBe('OWNERS_LISTED');
      const ended = await as((tx) => profiles.endOwner(tx, a.id, 'sold the whole holding', memberId(M1), '2026-11-09'));
      expect(ended.endedOn).toBe('2026-11-09');
      expect((await as((tx) => profiles.owners(tx, id))).length).toBe(2);
      expect((await as((tx) => profiles.owners(tx, id, false))).length).toBe(1);
      expect((await refusal(as((tx) => profiles.endOwner(tx, a.id, 'again for no reason', memberId(M1), '2026-11-09')))).code).toBe('STAGE_TRANSITION_DENIED');
      expect(await databaseRefusal(owner('update machvon.contractor_owner set share_pct = 10 where id = $1', [a.id]))).toMatch(/not rewritten/);
      expect(await databaseRefusal(owner('delete from machvon.contractor_owner where id = $1', [a.id]))).toMatch(/never deleted/);
    });

    it('lets a contractor declare that nobody holds above the threshold only while no owner is listed', async () => {
      const id = await contractor('Cty Declared');
      const done = await as((tx) => profiles.declareNoOwnerAboveThreshold(tx, id, 1, memberId(M1)));
      expect(done.ownershipDeclaration).toBe('NO_OWNER_ABOVE_THRESHOLD');
      const other = await contractor('Cty Declared Two');
      await as((tx) => profiles.addOwner(tx, other, { ownerKind: 'PERSON', ownerName: 'Pham E', sharePct: '30', beneficialOwner: true }, memberId(M1), (value) => value));
      expect((await refusal(as((tx) => profiles.declareNoOwnerAboveThreshold(tx, other, 2, memberId(M1))))).code).toBe('STAGE_TRANSITION_DENIED');
    });

    it('suggests a merge from shared keys, never from a name alone, and keeps a dismissal until the score rises', async () => {
      const a = await contractor('Cty Trung A', { taxId: '0400000001' });
      const b = await contractor('Cty Trung B', { taxId: '0400000001-001' });
      const c = await contractor('Cty Khac', { taxId: '0400000099' });
      const weights = (await as((tx) => policies.duplicateWeights(tx, '2026-11-09'))).value;
      await as(async (tx) => {
        await profiles.update(tx, a, 1, { registeredAddress: '99 Tran Hung Dao, Ha Noi', phone: '0988000111' }, memberId(M1), '2026-11-09', 12);
        await profiles.update(tx, b, 1, { registeredAddress: '99 Tran Hung Dao, Ha Noi', phone: '0988000111' }, memberId(M1), '2026-11-09', 12);
        await profiles.update(tx, c, 1, { registeredAddress: '99 Tran Hung Dao, Ha Noi' }, memberId(M1), '2026-11-09', 12);
      });
      const found = await as((tx) => profiles.scan(tx, a, weights));
      const pair = found.find((row) => [row.contractorAId, row.contractorBId].includes(b));
      expect(pair).toMatchObject({ status: 'OPEN' });
      expect(pair?.signals).toEqual(expect.arrayContaining(['TAX_HEAD', 'ADDRESS', 'PHONE']));
      // c shares the address only: 40 points, under the line.
      expect(found.some((row) => [row.contractorAId, row.contractorBId].includes(c))).toBe(false);
      const decided = await as((tx) => profiles.decideSuggestion(tx, (pair as { id: string }).id, 1, 'DISMISSED', 'two branches of one firm, merged elsewhere', memberId(M2)));
      expect(decided).toMatchObject({ status: 'DISMISSED' });
      expect((await as((tx) => profiles.scan(tx, a, weights))).length).toBe(0);
      expect((await refusal(as((tx) => profiles.decideSuggestion(tx, decided.id, decided.version, 'MERGE_REQUESTED', 'send it to master data', memberId(M2))))).code).toBe('STAGE_TRANSITION_DENIED');
    });

    it('lists the register with the coverage of each profile, the restriction in force and the open cases', async () => {
      const id = await contractor('Cty Register Row');
      const required = (await as((tx) => policies.profile(tx, '2026-11-09'))).value.required_before_bid;
      const rows = await as((tx) => profiles.register(tx, { q: 'Register Row', limit: 10 }, required, '2026-11-09', 60));
      expect(rows[0]).toMatchObject({ restricted: false, openCases: 0, activeAccounts: 0 });
      expect(rows[0]?.coverage.complete).toBe(false);
      expect(rows[0]?.profile.contractorId).toBe(id);
      expect((await as((tx) => profiles.register(tx, { q: 'Register Row', coverage: 'COMPLETE', limit: 10 }, required, '2026-11-09', 60))).length).toBe(0);
    });
  });

  describe('the account a contractor is paid into', () => {
    async function ready(name: string): Promise<string> {
      const id = await contractor(name);
      await owner("update machvon.contractor set phone = '0912000111', phone_key = $2, phone_set_at = now() - interval '30 days', updated_at = now() where id = $1", [id, matchKeyOf('0912000111')]);
      return id;
    }
    const letter = async (): Promise<string> => document(false);

    it('takes a change through two approvals in two roles and a call-back, and waits before a payment may go to the new account', async () => {
      const id = await ready('Cty Payee A');
      const before = await as((tx) => payee.verdict(tx, id, NOW));
      expect(before.verdict).toMatchObject({ allowed: true, warnings: ['PAYEE_ACCOUNT_NOT_REGISTERED'] });
      expect(await refusal(as((tx) => payee.request(tx, id, { bankName: 'Vietcombank', accountHolder: 'CTY PAYEE A', accountNumber: '0011 0022 3344', reason: 'the old account was closed by the bank', evidenceDocumentId: randomUUID() }, memberId(M1), NOW)))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'evidence_document_id' });
      const opened = await as((tx) => letter().then((evidence) => payee.request(tx, id, { bankName: 'Vietcombank', accountHolder: 'CTY PAYEE A', accountNumber: '0011 0022 3344', reason: 'the old account was closed by the bank', evidenceDocumentId: evidence }, memberId(M1), NOW)));
      expect(opened).toMatchObject({ status: 'REQUESTED', accountNoMasked: '********3344', holderMatchesLegalName: true, remaining: ['CONTRACT_MATCH', 'ACCOUNT_MATCH', 'CALLBACK'], version: 1 });
      expect((await as((tx) => payee.verdict(tx, id, NOW))).verdict.warnings).toContain('PAYEE_CHANGE_PENDING');
      // The requester cannot approve, nor can one person approve twice.
      expect((await refusal(as((tx) => payee.approve(tx, opened.id, 1, 'CONTRACT_MATCH', undefined, memberId(M1), NOW), M1))).code).toBe('SELF_APPROVAL_DENIED');
      const one = await as((tx) => payee.approve(tx, opened.id, 1, 'CONTRACT_MATCH', 'matches contract 12/HD', memberId(M2), NOW), M2);
      expect(one.request.remaining).toEqual(['ACCOUNT_MATCH', 'CALLBACK']);
      expect((await refusal(as((tx) => payee.approve(tx, opened.id, 2, 'ACCOUNT_MATCH', undefined, memberId(M2), NOW), M2))).code).toBe('SELF_APPROVAL_DENIED');
      const two = await as((tx) => payee.approve(tx, opened.id, 2, 'ACCOUNT_MATCH', undefined, memberId(M3), NOW), M3);
      expect(two.account).toBeNull();
      // A call to a number that is not the one on file is refused; one to the number on file confirms.
      expect(await refusal(as((tx) => payee.callback(tx, opened.id, 3, { outcome: 'CONFIRMED', calledNumber: '0999999999', usedNumberOnFile: true }, memberId(M4), NOW), M4))).toMatchObject({ code: 'BANK_CHANGE_CALLBACK_INVALID', extensions: { reason: 'NUMBER_NOT_ON_FILE' } });
      expect(await refusal(as((tx) => payee.callback(tx, opened.id, 3, { outcome: 'CONFIRMED', calledNumber: '0912000111', usedNumberOnFile: false }, memberId(M4), NOW), M4))).toMatchObject({ code: 'BANK_CHANGE_CALLBACK_INVALID' });
      const done = await as((tx) => payee.callback(tx, opened.id, 3, { outcome: 'CONFIRMED', calledNumber: '0912 000 111', usedNumberOnFile: true, note: 'spoke to the director' }, memberId(M4), NOW), M4);
      expect(done.request).toMatchObject({ status: 'ACTIVATED', callbackNumberLast4: '0111', remaining: [] });
      expect(done.account).toMatchObject({ state: 'ACTIVE', accountNoMasked: '********3344', validNow: false, effectiveAfter: '2026-11-12T03:00:00.000000Z' });
      // The payment is blocked until the waiting period of 72 hours ends.
      expect((await as((tx) => payee.verdict(tx, id, day(1)))).verdict).toMatchObject({ allowed: false, reason: 'IN_WAITING_PERIOD', validFrom: '2026-11-12' });
      expect((await as((tx) => payee.verdict(tx, id, day(3)))).verdict).toMatchObject({ allowed: true, accountId: done.account?.id });
      const events = await as((tx) => payee.events(tx, id));
      expect(events.map((event) => event.action).reverse()).toEqual(['REQUESTED', 'CONTRACT_MATCHED', 'ACCOUNT_MATCHED', 'CALLBACK_CONFIRMED', 'ACTIVATED']);
      // The number is sealed, never stored in the clear.
      const [sealed] = await owner<{ account_no_enc: Buffer }>('select account_no_enc from machvon.contractor_bank_account where id = $1', [done.account?.id]);
      expect(sealed?.account_no_enc.toString('utf8')).not.toContain('00110022');
      expect(await databaseRefusal(owner("update machvon.contractor_bank_account set bank_name = 'Other' where id = $1", [done.account?.id]))).toMatch(/not rewritten/);
      expect(await databaseRefusal(owner('delete from machvon.contractor_bank_event where contractor_id = $1', [id]))).toMatch(/append-only/);
    });

    it('replaces an account in force: the old one is superseded at once and a payment waits for the new one', async () => {
      const id = await ready('Cty Payee B');
      const first = await payeeChange(id, '5500 1111', 'CTY PAYEE B', NOW);
      expect(first.account?.state).toBe('ACTIVE');
      const later = day(10);
      const second = await payeeChange(id, '5500 2222', 'CTY PAYEE B', later);
      expect((await as((tx) => payee.accounts(tx, id, later))).map((row) => [row.accountNoMasked, row.state])).toEqual([['****2222', 'ACTIVE'], ['****1111', 'SUPERSEDED']]);
      expect((await as((tx) => payee.verdict(tx, id, later))).verdict.reason).toBe('IN_WAITING_PERIOD');
      expect((await as((tx) => payee.verdict(tx, id, new Date(later.getTime() + 4 * 86_400_000)))).verdict.accountId).toBe(second.account?.id);
      // One request in work at a time.
      const open = await as((tx) => letter().then((evidence) => payee.request(tx, id, { bankName: 'ACB', accountHolder: 'CTY PAYEE B', accountNumber: '9900 1234', reason: 'a third account for a second project', evidenceDocumentId: evidence }, memberId(M1), later)));
      expect(await refusal(as((tx) => letter().then((evidence) => payee.request(tx, id, { bankName: 'ACB', accountHolder: 'CTY PAYEE B', accountNumber: '9900 5678', reason: 'one more for the same contractor', evidenceDocumentId: evidence }, memberId(M1), later))))).toMatchObject({ code: 'BANK_CHANGE_STATE_INVALID', extensions: { change_request_id: open.id } });
      const cancelled = await as((tx) => payee.close(tx, open.id, 1, 'CANCEL', 'asked by mistake for the wrong contractor', memberId(M1), later));
      expect(cancelled).toMatchObject({ status: 'CANCELLED' });
    });

    async function payeeChange(id: string, number: string, holder: string, at: Date) {
      const evidence = await letter();
      const opened = await as((tx) => payee.request(tx, id, { bankName: 'Vietcombank', accountHolder: holder, accountNumber: number, reason: 'the contractor moved to another bank', evidenceDocumentId: evidence }, memberId(M1), at));
      await as((tx) => payee.approve(tx, opened.id, 1, 'CONTRACT_MATCH', undefined, memberId(M2), at), M2);
      await as((tx) => payee.approve(tx, opened.id, 2, 'ACCOUNT_MATCH', undefined, memberId(M3), at), M3);
      return as((tx) => payee.callback(tx, opened.id, 3, { outcome: 'CONFIRMED', calledNumber: '0912000111', usedNumberOnFile: true }, memberId(M4), at), M4);
    }

    it('refuses a holder that is not the contractor, an unverified contractor, one without a number on file, and rejects the request when the call does not confirm', async () => {
      const id = await ready('Cty Payee C');
      const evidence = await letter();
      expect(await refusal(as((tx) => payee.request(tx, id, { bankName: 'ACB', accountHolder: 'Someone Else', accountNumber: '1234 5678', reason: 'the contractor asked by letter', evidenceDocumentId: evidence }, memberId(M1), NOW)))).toMatchObject({ code: 'PAYEE_ACCOUNT_NAME_MISMATCH', detail: 'account_holder' });
      const unverified = await contractor('Cty Payee D', { verified: false });
      expect((await refusal(as((tx) => payee.request(tx, unverified, { bankName: 'ACB', accountHolder: 'Cty Payee D', accountNumber: '1234 5678', reason: 'the contractor asked by letter', evidenceDocumentId: evidence }, memberId(M1), NOW)))).code).toBe('CONTRACTOR_NOT_VERIFIED');
      const noPhone = await contractor('Cty Payee E');
      expect(await refusal(as((tx) => payee.request(tx, noPhone, { bankName: 'ACB', accountHolder: 'Cty Payee E', accountNumber: '1234 5678', reason: 'the contractor asked by letter', evidenceDocumentId: evidence }, memberId(M1), NOW)))).toMatchObject({ code: 'BANK_CHANGE_CALLBACK_INVALID', extensions: { reason: 'NO_NUMBER_ON_FILE' } });
      const opened = await as((tx) => payee.request(tx, id, { bankName: 'ACB', accountHolder: 'Cty Payee C', accountNumber: '1234 5678', reason: 'the contractor asked by letter', evidenceDocumentId: evidence }, memberId(M1), NOW));
      const failed = await as((tx) => payee.callback(tx, opened.id, 1, { outcome: 'NOT_CONFIRMED', calledNumber: '0912000111', usedNumberOnFile: true, note: 'the director knows nothing of it' }, memberId(M4), NOW), M4);
      expect(failed.request).toMatchObject({ status: 'REJECTED', callbackOutcome: 'NOT_CONFIRMED' });
      expect((await as((tx) => payee.accounts(tx, id, NOW))).length).toBe(0);
    });

    it('closes a request that ran out, and finds one account held by two contractors', async () => {
      const id = await ready('Cty Payee F');
      const opened = await as((tx) => letter().then((evidence) => payee.request(tx, id, { bankName: 'ACB', accountHolder: 'Cty Payee F', accountNumber: '7777 8888', reason: 'the contractor asked by letter', evidenceDocumentId: evidence }, memberId(M1), NOW)));
      expect(await as((tx) => payee.expireDue(tx, day(31), memberId(M5)))).toBeGreaterThanOrEqual(1);
      expect((await as((tx) => payee.findRequest(tx, opened.id)))?.status).toBe('EXPIRED');
      const a = await ready('Cty Shared A');
      const b = await ready('Cty Shared B');
      await payeeChange(a, '3131 4242', 'CTY SHARED A', NOW);
      await payeeChange(b, '3131 4242', 'CTY SHARED B', NOW);
      const shared = await as((tx) => payee.sharedAccounts(tx));
      expect(shared.some((row) => row.contractorIds.includes(a) && row.contractorIds.includes(b))).toBe(true);
      const duplicates = await as((tx) => profiles.scan(tx, a, { weights: { TAX_HEAD: 100, ADDRESS: 40, PHONE: 35, EMAIL: 35, LEGAL_REPRESENTATIVE: 40, OWNER: 40, BANK_ACCOUNT: 100, NAME: 40 }, suggest_from: 60, name_similarity_from: 0.8 }));
      expect(duplicates.some((row) => row.signals.includes('BANK_ACCOUNT'))).toBe(true);
    });
  });

  describe('the certificates and the key staff', () => {
    it('verifies by another person, satisfies a requirement only when verified, in grade and in period, and revokes without erasing', async () => {
      const id = await contractor('Cty Cert A');
      const doc = await document(false);
      const cert = await as((tx) => qualifications.addQualification(tx, id, { kind: 'CONSTRUCTION_ACTIVITY', certificateNo: 'CCHN-001', grade: 'II', scope: 'Civil and industrial works', issuer: 'Ministry of Construction', issuedOn: '2025-01-01', expiresOn: '2026-12-31', documentId: doc }, memberId(M1)));
      const [pack] = await owner<{ id: string }>('select id from machvon.procurement_package limit 1');
      const policy = (await as((tx) => policies.expiry(tx, 'QUALIFICATION', '2026-11-09'))).value;
      expect((await refusal(as((tx) => qualifications.verify(tx, 'QUALIFICATION', cert.id, 1, memberId(M1))))).code).toBe('SELF_APPROVAL_DENIED');
      const verified = await as((tx) => qualifications.verify(tx, 'QUALIFICATION', cert.id, 1, memberId(M2)), M2);
      expect(verified).toMatchObject({ version: 2 });
      expect((await refusal(as((tx) => qualifications.verify(tx, 'QUALIFICATION', cert.id, 2, memberId(M3)), M3))).code).toBe('STAGE_TRANSITION_DENIED');
      const watch = await as((tx) => qualifications.expiring(tx, '2026-11-09', { qualification: policy, keyStaff: policy }));
      expect(watch.find((item) => item.id === cert.id)).toMatchObject({ state: 'EXPIRING_FIRST', contractorName: 'Cty Cert A' });
      expect((await as((tx) => qualifications.expiring(tx, '2026-12-05', { qualification: policy, keyStaff: policy }))).find((item) => item.id === cert.id)?.state).toBe('EXPIRING_SECOND');
      expect((await as((tx) => qualifications.expiring(tx, '2027-01-02', { qualification: policy, keyStaff: policy }))).find((item) => item.id === cert.id)?.state).toBe('EXPIRED');
      if (pack !== undefined) {
        await as((tx) => qualifications.setRequirements(tx, pack.id, [{ kind: 'CONSTRUCTION_ACTIVITY', minGrade: 'II', scopeKeyword: 'civil' }, { kind: 'SAFETY_CERTIFICATE', minGrade: null, scopeKeyword: null }], memberId(M1)));
        const findings = await as((tx) => qualifications.findingsForPackage(tx, id, pack.id, '2026-11-09', policy));
        expect(findings).toEqual([{ kind: 'SAFETY_CERTIFICATE', gap: 'MISSING', qualificationId: null }]);
      }
      expect(await databaseRefusal(owner("update machvon.contractor_qualification set grade = 'I' where id = $1", [cert.id]))).toMatch(/not rewritten/);
      const revoked = await as((tx) => qualifications.revoke(tx, 'QUALIFICATION', cert.id, 2, 'the ministry withdrew the certificate', memberId(M2)), M2);
      expect(revoked).toMatchObject({ revokeReason: 'the ministry withdrew the certificate' });
      expect((await as((tx) => qualifications.expiring(tx, '2026-11-09', { qualification: policy, keyStaff: policy }))).some((item) => item.id === cert.id)).toBe(false);
    });

    it('keeps the key staff the same way', async () => {
      const id = await contractor('Cty Staff A');
      const staff = await as((tx) => qualifications.addKeyStaff(tx, id, { staffRole: 'PROJECT_MANAGER', personName: 'Hoang Van F', qualificationTitle: 'Class I manager certificate', issuedOn: '2024-01-01', expiresOn: '2026-11-20', documentId: undefined }, memberId(M1)));
      expect(await refusal(as((tx) => qualifications.verify(tx, 'KEY_STAFF', staff.id, 1, memberId(M2)), M2))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'document_id' });
      const policy = (await as((tx) => policies.expiry(tx, 'KEY_STAFF', '2026-11-09'))).value;
      const watch = await as((tx) => qualifications.expiring(tx, '2026-11-09', { qualification: policy, keyStaff: policy }));
      expect(watch.find((item) => item.id === staff.id)).toMatchObject({ subject: 'KEY_STAFF', state: 'EXPIRING_SECOND' });
      expect((await as((tx) => qualifications.keyStaff(tx, id))).length).toBe(1);
    });
  });

  describe('the debarment case and the joint venture', () => {
    const open = async (contractorId: string, extra: Partial<Parameters<RestrictionCaseStore['open']>[1]> = {}, at = NOW) =>
      as((tx) => cases.open(tx, { subjectKind: 'CONTRACTOR', contractorId, triggerKind: 'INVESTOR_PROPOSAL', triggerRef: `proposal-${randomUUID()}`, violationGroups: ['GROUP_2'], violationSummary: 'The contractor did not carry out the contract it signed within the agreed time', violationOn: '2026-10-01', ...extra }, memberId(M1), at));

    it('counts the time limit on the working calendar and runs a case from proposal to the end of the ban, writing the legal record the gates read', async () => {
      const id = await contractor('Cty Case A');
      const created = await open(id);
      expect(created).toMatchObject({ status: 'PROPOSED', caseNo: expect.stringMatching(/^RC-2026-\d{5}$/), clock: 'ON_TIME', decision: null, version: 1 });
      // 15 calendar days from Monday 9 November 2026 (10:00 Vietnam time) is Tuesday 24 November, the end of that office day.
      expect(created.decideBy).toBe('2026-11-24T10:00:00.000000Z');
      expect(await refusal(open(id, { triggerRef: created.triggerRef ?? undefined, violationOn: '2026-10-01' }))).toMatchObject({ code: 'RESTRICTION_CASE_DUPLICATE', status: 409 });
      const notified = await as((tx) => cases.sendNotice(tx, created.id, 1, undefined, memberId(M1), day(1)));
      expect(notified).toMatchObject({ status: 'NOTICE_SENT' });
      expect(notified.responseDueAt).toBe('2026-11-20T10:00:00.000000Z');
      expect(await refusal(as((tx) => cases.closeNoResponse(tx, created.id, 2, memberId(M1), day(5))))).toMatchObject({ code: 'RESTRICTION_RESPONSE_WINDOW_OPEN' });
      const responded = await as((tx) => cases.recordResponse(tx, created.id, 2, { summary: 'The contractor says the delay was caused by the investor' }, memberId(M1), day(6)));
      expect(responded).toMatchObject({ status: 'RESPONSE_RECEIVED', responseOutcome: 'RESPONDED' });
      const decision = await document(true);
      expect((await refusal(as((tx) => cases.decide(tx, created.id, 3, { decision: 'BAN', reason: 'proved delay of the contractor', scope: 'TENANT', banMonths: 6, effectiveFrom: '2026-12-01', decisionDocumentId: decision }, memberId(M1), day(7))))).code).toBe('SELF_APPROVAL_DENIED');
      expect(await refusal(as((tx) => cases.decide(tx, created.id, 3, { decision: 'BAN', reason: 'proved delay of the contractor', scope: 'TENANT', banMonths: 6, effectiveFrom: '2026-12-01', decisionDocumentId: decision }, memberId(M2), day(7)), M2))).toMatchObject({ code: 'RESTRICTION_BAN_PERIOD_INVALID', extensions: { min_months: 12, max_months: 36 } });
      const decided = await as((tx) => cases.decide(tx, created.id, 3, { decision: 'BAN', reason: 'proved delay of the contractor', scope: 'TENANT', banMonths: 24, effectiveFrom: '2026-12-01', decisionDocumentId: decision }, memberId(M2), day(7)), M2);
      expect(decided).toMatchObject({ status: 'DECIDED', decision: 'BAN', effectiveFrom: '2026-12-01', effectiveUntil: '2028-11-30', decidedLate: false, clock: 'MET' });
      expect(await refusal(as((tx) => cases.putIntoEffect(tx, created.id, 4, memberId(M2), day(10)), M2))).toMatchObject({ code: 'RESTRICTION_NOT_YET_EFFECTIVE' });
      const effect = await as((tx) => cases.putIntoEffect(tx, created.id, 4, memberId(M2), new Date('2026-12-01T03:00:00Z')), M2);
      expect(effect.row.status).toBe('EFFECTIVE');
      expect(effect.restrictions).toHaveLength(1);
      // The restriction is in the register the gates read, from the decision paper, with its case.
      const inForce = await as((tx) => bidContractors.restrictionsInForce(tx, [id], '2026-12-02'));
      expect(inForce.get(id)).toMatchObject({ kind: 'DEBARMENT', source: 'DECISION', effectiveFrom: '2026-12-01', effectiveUntil: '2028-11-30' });
      expect(await refusal(as((tx) => gate.assertAllowed(tx, 'BID_SUBMISSION', { contractorId: id, now: new Date('2026-12-02T03:00:00Z') })))).toMatchObject({ code: 'CONTRACTOR_RESTRICTED', extensions: { via: 'SELF', action: 'BID_SUBMISSION' } });
      expect(await refusal(as((tx) => gate.assertAllowed(tx, 'PAYMENT', { contractorId: id, now: new Date('2026-12-02T03:00:00Z') })))).toMatchObject({ code: 'CONTRACTOR_RESTRICTED' });
      expect((await as((tx) => cases.escalation(tx, id, new Date('2026-12-02T03:00:00Z')))).decisionsInForce).toBe(1);
      expect(await as((tx) => cases.expireDue(tx, memberId(M5), new Date('2028-11-30T03:00:00Z')))).toEqual([]);
      expect(await as((tx) => cases.expireDue(tx, memberId(M5), new Date('2028-12-01T03:00:00Z')))).toEqual([created.id]);
      expect((await as((tx) => cases.require(tx, created.id, NOW))).status).toBe('EXPIRED');
      expect((await as((tx) => cases.events(tx, created.id))).map((event) => event.move)).toEqual(['PROPOSE', 'SEND_NOTICE', 'RECORD_RESPONSE', 'DECIDE', 'PUT_INTO_EFFECT', 'EXPIRE']);
      expect(await databaseRefusal(owner('delete from machvon.restriction_case where id = $1', [created.id]))).toMatch(/never deleted/);
    });

    it('reaches every member of a joint venture, blocks the venture at the gates and lifts a ban on an appeal so that it never blocks', async () => {
      const lead = await contractor('Cty JV Lead');
      const member = await contractor('Cty JV Member');
      const venture = await as((tx) => ventures.create(tx, { name: 'JV Lead-Member', members: [{ contractorId: lead, sharePct: '60', lead: true }, { contractorId: member, sharePct: '40', lead: false }] }, memberId(M1), '2026-11-09'));
      expect(venture.members.map((one) => one.sharePct)).toEqual(['60.00', '40.00']);
      expect(await refusal(as((tx) => ventures.create(tx, { name: 'Bad JV', members: [{ contractorId: lead, sharePct: '60', lead: true }, { contractorId: member, sharePct: '30', lead: false }] }, memberId(M1), '2026-11-09')))).toMatchObject({ code: 'JOINT_VENTURE_SHARES_INVALID' });
      expect(await databaseRefusal(owner('update machvon.joint_venture_member set share_pct = 10 where joint_venture_id = $1', [venture.id]))).toMatch(/not changed|permission/);
      const created = await as((tx) => cases.open(tx, { subjectKind: 'JOINT_VENTURE', jointVentureId: venture.id, triggerKind: 'AUDIT_CONCLUSION', violationGroups: ['GROUP_1'], violationSummary: 'The venture colluded with another bidder in the bid of a package', violationOn: '2026-09-01' }, memberId(M1), NOW));
      await as((tx) => cases.sendNotice(tx, created.id, 1, undefined, memberId(M1), NOW));
      await as((tx) => cases.recordResponse(tx, created.id, 2, { summary: 'The venture denies any agreement with others' }, memberId(M1), NOW));
      const decision = await document(true);
      await as((tx) => cases.decide(tx, created.id, 3, { decision: 'BAN', reason: 'the audit conclusion proves collusion', scope: 'NATIONWIDE', banMonths: 36, effectiveFrom: '2026-11-09', decisionDocumentId: decision }, memberId(M2), NOW), M2);
      const effect = await as((tx) => cases.putIntoEffect(tx, created.id, 4, memberId(M2), NOW), M2);
      expect(effect.restrictions.map((one) => one.contractorId).sort()).toEqual([lead, member].sort());
      expect((await as((tx) => cases.members(tx, created.id))).every((one) => one.restrictionId !== null)).toBe(true);
      // A contractor that leads a venture is stopped when a member of it is restricted, even without a restriction of its own.
      const other = await contractor('Cty JV Lead Two');
      const second = await contractor('Cty JV Second');
      await as((tx) => ventures.create(tx, { name: 'JV Other', members: [{ contractorId: other, sharePct: '50', lead: true }, { contractorId: second, sharePct: '50', lead: false }] }, memberId(M1), '2026-11-09'));
      await as((tx) => gate.assertAllowed(tx, 'BID_SUBMISSION', { contractorId: other, now: NOW }));
      const banned = await contractor('Cty JV Banned Later');
      await as((tx) => ventures.create(tx, { name: 'JV Third', members: [{ contractorId: banned, sharePct: '50', lead: true }, { contractorId: second, sharePct: '50', lead: false }] }, memberId(M1), '2026-11-09'));
      await owner(
        `insert into machvon.contractor_restriction (tenant_id, id, contractor_id, kind, source, effective_from, effective_until, decision_document_id, created_by, updated_by) values ($1, gen_random_uuid(), $2, 'DEBARMENT', 'DECISION', date '2026-11-01', date '2027-11-01', $3, $4, $4)`,
        [TENANT_A, second, decision, memberId(M1)],
      );
      expect(await refusal(as((tx) => gate.assertAllowed(tx, 'CONTRACT_ACTIVATION', { contractorId: other, now: NOW })))).toMatchObject({ code: 'CONTRACTOR_RESTRICTED', extensions: { via: 'JOINT_VENTURE_MEMBER', restricted_contractor_id: second } });
      // The appeal succeeds: the ban is lifted, and the contractors are free again from that moment, even on the first day of the ban.
      const lifted = await as((tx) => cases.lift(tx, created.id, 5, { reason: 'the court annulled the decision on appeal' }, memberId(M2), NOW), M2);
      expect(lifted.status).toBe('LIFTED');
      await as((tx) => gate.assertAllowed(tx, 'BID_SUBMISSION', { contractorId: lead, now: NOW }));
      expect((await as((tx) => bidContractors.restrictionsInForce(tx, [lead, member], '2026-11-09'))).size).toBe(0);
      expect((await refusal(as((tx) => cases.lift(tx, created.id, 6, { reason: 'again, for no good reason' }, memberId(M2), NOW), M2))).code).toBe('RESTRICTION_CASE_STATE_INVALID');
    });

    it('allows only the culpable member to be banned for the groups the policy excepts, and refuses a violation past the limitation', async () => {
      const a = await contractor('Cty Exc A');
      const b = await contractor('Cty Exc B');
      const venture = await as((tx) => ventures.create(tx, { name: 'JV Exc', members: [{ contractorId: a, sharePct: '50', lead: true }, { contractorId: b, sharePct: '50', lead: false }] }, memberId(M1), '2026-11-09'));
      expect(await refusal(open(a, { violationOn: '2015-01-01' }))).toMatchObject({ code: 'RESTRICTION_CASE_TIME_BARRED' });
      expect(await refusal(open(a, { violationGroups: ['GROUP_9'] }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'violation_groups' });
      expect(await refusal(open(a, { violationOn: '2027-01-01' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'violation_on' });
      expect(venture.status).toBe('ACTIVE');
    });

    it('records a late decision as late and withdraws a case that is not decided', async () => {
      const id = await contractor('Cty Late');
      const created = await open(id, {}, NOW);
      expect((await as((tx) => cases.list(tx, { open: true, contractorId: id }, day(14)))).find((row) => row.id === created.id)?.clock).toBe('DUE_SOON');
      expect((await as((tx) => cases.alertable(tx, day(30)))).find((row) => row.id === created.id)?.clock).toBe('OVERDUE');
      await as((tx) => cases.sendNotice(tx, created.id, 1, undefined, memberId(M1), NOW));
      await as((tx) => cases.recordResponse(tx, created.id, 2, { summary: 'The contractor answered at once' }, memberId(M1), NOW));
      const dismissed = await as((tx) => cases.decide(tx, created.id, 3, { decision: 'DISMISS', reason: 'no violation was proved by the proposal' }, memberId(M2), day(30)), M2);
      expect(dismissed).toMatchObject({ status: 'DISMISSED', decision: 'DISMISS', decidedLate: true, clock: 'MET_LATE' });
      const other = await open(id, {}, NOW);
      expect((await as((tx) => cases.withdraw(tx, other.id, 1, 'the proposal was sent by mistake', memberId(M1), NOW))).status).toBe('DISMISSED');
      const figures = await as((tx) => cases.figures(tx, day(30)));
      expect(figures.decidedLate).toBeGreaterThanOrEqual(1);
    });

    it('opens a case from a record of the national network (the hook of docs/egp-connector.md section 10) and never writes the restriction itself', async () => {
      const taxId = '0500000077';
      const id = await contractor('Cty Egp Hook', { taxId });
      const importId = randomUUID();
      await owner(
        `insert into machvon.file_import (tenant_id, id, connector_code, format_version, file_sha256, file_object_key, status, rows_total, rows_applied, imported_by, completed_at)
         values ($1, $2, 'EGP_RESTRICTION_FILE', 'WORKING-ASSUMPTION-2026.2', $3, 'tenants/x/import/y', 'APPLIED', 1, 1, $4, now())`,
        [TENANT_A, importId, 'a'.repeat(64), memberId(M1)],
      );
      const recordId = randomUUID();
      await owner(
        `insert into machvon.egp_record (tenant_id, id, kind, business_key, layout_version, import_id, line, row_hash, record, applied_by) values ($1, $2, 'RESTRICTION', 'R-77', 'WORKING-ASSUMPTION-2026.2', $3, 1, $4, $5::jsonb, $6)`,
        [TENANT_A, recordId, importId, 'b'.repeat(64), JSON.stringify({ restrictionCode: 'R-77', contractorTaxCode: taxId, contractorName: null, restrictionKind: 'DEBARMENT', scope: 'NATIONWIDE', validFrom: '2026-10-01', validUntil: '2029-09-30', decisionNo: '55/QD-BKHDT', decisionDate: '2026-09-20', legalBasis: 'Dieu 133' }), memberId(M1)],
      );
      const created = await as((tx) => cases.openFromEgpRecord(tx, recordId, { violationGroups: ['GROUP_1'] }, memberId(M1), NOW));
      expect(created).toMatchObject({ contractorId: id, triggerKind: 'EGP_IMPORT', triggerRef: 'R-77/55/QD-BKHDT', egpRecordId: recordId, violationOn: '2026-09-20', status: 'PROPOSED' });
      expect(created.violationSummary).toContain('55/QD-BKHDT');
      expect((await as((tx) => bidContractors.restrictionsInForce(tx, [id], '2026-11-09'))).size).toBe(0);
      expect((await refusal(as((tx) => cases.openFromEgpRecord(tx, randomUUID(), { violationGroups: ['GROUP_1'] }, memberId(M1), NOW)))).code).toBe('RESOURCE_NOT_FOUND');
      expect((await refusal(as((tx) => cases.openFromEgpRecord(tx, recordId, { violationGroups: ['GROUP_1'] }, memberId(M1), NOW)))).code).toBe('RESTRICTION_CASE_DUPLICATE');
    });
  });

  describe('the ledger of events of bid conduct', () => {
    it('counts the posting on the calendar, posts by another person, and raises the bid security for two years', async () => {
      const id = await contractor('Cty Rep A');
      // Event on Friday 6 November 2026: seven working days later is Tuesday 17 November, the end of the office day.
      const event = await as((tx) => reputation.record(tx, { contractorId: id, behaviourCode: 'NO_BID_SECURITY', eventOn: '2026-11-06', description: 'The contractor did not pay the bid security before the opening' }, memberId(M1), NOW));
      expect(event).toMatchObject({ status: 'RECORDED', postDueAt: '2026-11-17T10:00:00.000000Z', clock: 'ON_TIME', deadlinePolicyVersion: 'builtin' });
      expect((await as((tx) => reputation.alertable(tx, day(7)))).find((row) => row.id === event.id)?.clock).toBe('DUE_SOON');
      expect((await as((tx) => reputation.alertable(tx, day(9)))).find((row) => row.id === event.id)?.clock).toBe('OVERDUE');
      expect((await as((tx) => reputation.bidSecurityFactor(tx, id, '2026-11-09'))).multiplier).toBe(1);
      expect((await refusal(as((tx) => reputation.post(tx, event.id, 1, 'MSC-2026-0001', memberId(M1), NOW), M1))).code).toBe('SELF_APPROVAL_DENIED');
      const posted = await as((tx) => reputation.post(tx, event.id, 1, 'MSC-2026-0001', memberId(M2), day(2)), M2);
      expect(posted).toMatchObject({ status: 'POSTED', postingRef: 'MSC-2026-0001', clock: 'MET' });
      expect(await as((tx) => reputation.bidSecurityFactor(tx, id, '2026-11-09'))).toMatchObject({ multiplier: 3, until: '2028-11-11', eventIds: [event.id] });
      expect((await as((tx) => reputation.bidSecurityFactor(tx, id, '2028-11-12'))).multiplier).toBe(1);
      expect((await refusal(as((tx) => reputation.retract(tx, event.id, 2, 'entered against the wrong contractor by mistake', memberId(M3), NOW), M3))).code).toBe('STAGE_TRANSITION_DENIED');
      expect(await databaseRefusal(owner("update machvon.contractor_reputation_event set description = 'Something else entirely' where id = $1", [event.id]))).toMatch(/not rewritten/);
      const second = await as((tx) => reputation.record(tx, { contractorId: id, behaviourCode: 'NOT_NEGOTIATING', eventOn: '2026-11-02', description: 'The contractor refused to negotiate the contract' }, memberId(M1), NOW));
      expect(await as((tx) => reputation.retract(tx, second.id, 1, 'entered against the wrong contractor by mistake', memberId(M3), NOW), M3)).toMatchObject({ status: 'RETRACTED' });
      const figures = await as((tx) => reputation.figures(tx, NOW));
      expect(figures.postedInTime).toBeGreaterThanOrEqual(1);
      expect(await refusal(as((tx) => reputation.record(tx, { contractorId: id, behaviourCode: 'NO_BID_SECURITY', eventOn: '2027-01-01', description: 'An event in the future cannot be recorded' }, memberId(M1), NOW)))).toMatchObject({ detail: 'event_on' });
    });

    it('refuses to count a deadline where no calendar is published', async () => {
      const id = await contractor('Cty Rep B');
      expect((await refusal(as((tx) => reputation.record(tx, { contractorId: id, behaviourCode: 'NO_BID_SECURITY', eventOn: '2035-01-02', description: 'The contractor did not pay the bid security' }, memberId(M1), new Date('2035-01-03T03:00:00Z'))))).code).toBe('CALENDAR_NOT_EFFECTIVE');
    });
  });

  describe('the gates', () => {
    it('asks the profile and the account as the rules say and passes a payment to a contractor that never had an account with a warning', async () => {
      const id = await contractor('Cty Gate A');
      const warnings = await as((tx) => gate.assertAllowed(tx, 'BID_SUBMISSION', { contractorId: id, now: NOW }));
      expect(warnings).toEqual([{ code: 'PROFILE_INCOMPLETE', detail: { missing: ['LEGAL_REPRESENTATIVE', 'REGISTERED_ADDRESS', 'CONTACT', 'OWNERSHIP'], coverage_pct: 0 } }]);
      expect(await as((tx) => gate.assertAllowed(tx, 'PAYMENT', { contractorId: id, now: NOW }))).toEqual([{ code: 'PAYEE_ACCOUNT_NOT_REGISTERED', detail: { contractor_id: id } }]);
      const unverified = await contractor('Cty Gate B', { verified: false });
      expect((await refusal(as((tx) => gate.assertAllowed(tx, 'CONTRACT_ACTIVATION', { contractorId: unverified, now: NOW })))).code).toBe('CONTRACTOR_NOT_VERIFIED');
      expect((await refusal(as((tx) => gate.assertAllowed(tx, 'SUBCONTRACT', { now: NOW })))).code).toBe('VALIDATION_FAILED');
    });

    it('blocks when the tenant approves a rule that says BLOCK, with what is missing, and names the version of the rule', async () => {
      const id = await contractor('Cty Gate C');
      await as((tx) =>
        tx.query(
          `insert into machvon.governance_rule (tenant_id, id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at) values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), 'VENDOR_GATE', 'DEFAULT', 1, 'APPROVED', $1::jsonb, date '2026-11-01', 'complete records, so block', $2::uuid, $2::uuid, now(), $3::uuid, now())`,
          [JSON.stringify({ profile_enforcement: 'BLOCK', qualification_enforcement: 'WARN' }), memberId(M1), memberId(M2)],
        ),
      );
      expect(await refusal(as((tx) => gate.assertAllowed(tx, 'BID_SUBMISSION', { contractorId: id, now: NOW })))).toMatchObject({ code: 'CONTRACTOR_PROFILE_INCOMPLETE', status: 422, extensions: { coverage_pct: 0, action: 'BID_SUBMISSION' } });
      const policy = await as((tx) => policies.gate(tx, '2026-11-09'));
      expect(policy).toMatchObject({ version: '1', value: { profile_enforcement: 'BLOCK' } });
    });
  });
});
