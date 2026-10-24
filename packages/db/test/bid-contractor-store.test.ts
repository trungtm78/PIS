import { randomUUID } from 'node:crypto';
import { BidContractorStore } from '../src/bid-contractor-store';
import type { LookupRecord, RegisterInput, RestrictionInput } from '../src/bid-contractor-store';
import { maskTaxIdentifier, normaliseTaxIdentifier } from '../src/bid-tax-identifier';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const contractors = new BidContractorStore();
const MAKER = 1;
const CHECKER = 2;
const TODAY = '2026-10-24';

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = MAKER, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

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

let counter = 0;
/** A document of the tenant; `effective` makes it a decision in force. */
async function document(effective = true, tenant = TENANT_A): Promise<string> {
  const documentId = randomUUID();
  await owner(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, symbol, issued_on, effect_status, created_by, updated_by)
     values ($1, $2, 'REFERENCE', 'QD', 'Decision', 'INTERNAL', '12/QD', date '2026-01-01', $3, $4, $4)`,
    [tenant, documentId, effective ? 'EFFECTIVE' : 'PENDING', memberId(MAKER)],
    tenant,
  );
  return documentId;
}

/** A fresh ten-digit tax id, so a test never meets the contractors of another. */
const freshTaxId = (): string => {
  counter += 1;
  return `02${String(counter).padStart(8, '0')}`;
};

async function register(extra: Partial<RegisterInput> = {}, member = MAKER, tenant = TENANT_A) {
  const input: RegisterInput = { taxIdentifier: freshTaxId(), legalName: 'Cty Nha Thau Mot', profileDocumentId: await document(true, tenant), ...extra };
  return { input, ...(await as((tx) => contractors.register(tx, input, memberId(member)), member, tenant)) };
}

const lookup = (adapterStatus: LookupRecord['adapterStatus'], outcome: LookupRecord['outcome']): LookupRecord => ({ adapterStatus, outcome, checkedAt: '2026-10-24T01:02:03.000000Z' });

async function verified(taxIdentifier: string, member = CHECKER) {
  const created = await register({ taxIdentifier });
  const evidence = await document(false);
  await as((tx) => contractors.verify(tx, created.id, 1, { decision: 'VERIFIED', evidenceDocumentId: evidence }, memberId(member)), member);
  return created;
}

async function master(businessKey: string, extra: { type?: string; status?: string; tenant?: string } = {}): Promise<string> {
  const recordId = randomUUID();
  await owner(
    `insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', $3, $4, $5, $6, $6)`,
    [extra.tenant ?? TENANT_A, recordId, extra.type ?? 'CONTRACTOR', businessKey, extra.status ?? 'EFFECTIVE', memberId(MAKER)],
    extra.tenant ?? TENANT_A,
  );
  return recordId;
}

describe('tax identifiers', () => {
  it.each([
    ['0101234567', '0101234567'],
    [' 0101234567 ', '0101234567'],
    ['0101 234 567', '0101234567'],
    ['0101234567-001', '0101234567-001'],
    ['0101234567001', '0101234567-001'],
  ])('normalises %j to %j', (raw, expected) => {
    expect(normaliseTaxIdentifier(raw)).toBe(expected);
  });

  it.each(['', '123', '01012345678', 'ABC1234567', '0101234567-01', '0101234567--001', '0101234567-0011', '０１０１２３４５６７'])('refuses %j as TAX_ID_INVALID naming the field', (raw) => {
    expect(() => normaliseTaxIdentifier(raw)).toThrow(expect.objectContaining({ code: 'TAX_ID_INVALID', status: 409, detail: 'tax_identifier' }));
  });

  it('covers the four middle digits of the ten and keeps the branch', () => {
    expect(maskTaxIdentifier('0101234567')).toBe('010****567');
    expect(maskTaxIdentifier('0101234567-001')).toBe('010****567-001');
  });
});

describe('BidContractorStore (the contractor registry, ST-BID-002)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: 1, path: '/u1/' }]);
      for (const member of [MAKER, CHECKER]) await harness.seedMembership(tenant, member, 1);
    }
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('registering a contractor', () => {
    it('registers it UNVERIFIED with the tax id in its one form, and links the master entry that carries the tax id', async () => {
      const taxIdentifier = freshTaxId();
      const entry = await master(taxIdentifier);
      const created = await register({ taxIdentifier: ` ${taxIdentifier} `, legalName: '  Cty Nha Thau Mot  ', legalForm: ' TNHH ' });
      expect(created).toMatchObject({ version: 1, masterRecordId: entry });
      const row = await as((tx) => contractors.find(tx, created.id));
      expect(row).toMatchObject({
        taxIdentifier,
        legalName: 'Cty Nha Thau Mot',
        legalForm: 'TNHH',
        verificationStatus: 'UNVERIFIED',
        verificationBasis: null,
        lookup: null,
        masterRecordId: entry,
        verifiedBy: null,
        createdBy: memberId(MAKER),
        contractCount: 0,
        version: 1,
      });
    });

    it('keeps the contractor unlinked when master data has no entry for the tax id: a name never links anything', async () => {
      await master(freshTaxId(), { type: 'CONTRACTOR' });
      const created = await register({ legalName: 'Cty Nha Thau Mot' });
      expect(created.masterRecordId).toBeNull();
    });

    it('takes the entry that is named only when it is a live CONTRACTOR entry keyed by the same tax id of this tenant', async () => {
      const taxIdentifier = freshTaxId();
      const entry = await master(taxIdentifier);
      expect((await register({ taxIdentifier, masterRecordId: entry })).masterRecordId).toBe(entry);
      expect(await refusal(register({ masterRecordId: entry }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'master_record_id' });
      expect(await refusal(register({ taxIdentifier: freshTaxId(), masterRecordId: await master(freshTaxId(), { type: 'UNIT' }) }))).toMatchObject({ detail: 'master_record_id' });
      const retired = freshTaxId();
      expect(await refusal(register({ taxIdentifier: retired, masterRecordId: await master(retired, { status: 'RETIRED' }) }))).toMatchObject({ detail: 'master_record_id' });
      expect(await refusal(register({ masterRecordId: randomUUID() }))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      const other = freshTaxId();
      expect(await refusal(register({ taxIdentifier: other, masterRecordId: await master(other, { tenant: TENANT_B }) }))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('ignores a master entry that was retired or merged away when it looks one up by the tax id', async () => {
      const taxIdentifier = freshTaxId();
      await master(taxIdentifier, { status: 'RETIRED' });
      expect((await register({ taxIdentifier })).masterRecordId).toBeNull();
    });

    it('refuses a tax id that is not one, a name or a form that is empty, long or holds control characters, and a profile document that does not exist', async () => {
      expect(await refusal(register({ taxIdentifier: '12345' }))).toEqual({ code: 'TAX_ID_INVALID', status: 409, detail: 'tax_identifier' });
      expect(await refusal(register({ legalName: '   ' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'legal_name' });
      expect(await refusal(register({ legalName: 'x'.repeat(501) }))).toMatchObject({ detail: 'legal_name' });
      expect(await refusal(register({ legalName: 'A\u0000B' }))).toMatchObject({ detail: 'legal_name' });
      expect(await refusal(register({ legalForm: 'y'.repeat(101) }))).toMatchObject({ detail: 'legal_form' });
      expect(await refusal(register({ profileDocumentId: randomUUID() }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'profile_document_id' });
      const form = await register({ legalForm: '   ' });
      expect((await as((tx) => contractors.find(tx, form.id)))?.legalForm).toBeNull();
    });

    it('allows two unverified claims of one tax id, and refuses a registration once a contractor holds the tax id as VERIFIED', async () => {
      const taxIdentifier = freshTaxId();
      const first = await register({ taxIdentifier });
      const second = await register({ taxIdentifier });
      expect(second.id).not.toBe(first.id);
      const evidence = await document(false);
      await as((tx) => contractors.verify(tx, first.id, 1, { decision: 'VERIFIED', evidenceDocumentId: evidence }, memberId(CHECKER)), CHECKER);
      expect(await refusal(register({ taxIdentifier }))).toEqual({
        code: 'CONTRACTOR_ALREADY_VERIFIED',
        status: 422,
        detail: 'tax_identifier',
        extensions: { existing_contractor_id: first.id },
      });
    });
  });

  describe('verifying a contractor', () => {
    it('refuses to verify a second contractor with a tax id that is already VERIFIED, names the verified one for the merge in master data, and merges nothing (AC-ST-BID-002-1)', async () => {
      const taxIdentifier = freshTaxId();
      const entry = await master(taxIdentifier);
      const nt2 = await register({ taxIdentifier, legalName: 'Cty NT Hai' });
      const nt1 = await register({ taxIdentifier, legalName: 'Cty NT Mot' });
      const evidence = await document(false);
      await as((tx) => contractors.verify(tx, nt1.id, 1, { decision: 'VERIFIED', evidenceDocumentId: evidence }, memberId(CHECKER)), CHECKER);

      expect(await refusal(as((tx) => contractors.verify(tx, nt2.id, 1, { decision: 'VERIFIED', evidenceDocumentId: evidence }, memberId(CHECKER)), CHECKER))).toEqual({
        code: 'TAX_ID_DUPLICATE_VERIFIED',
        status: 409,
        detail: 'tax_identifier',
        extensions: {
          merge_suggestion: { target: 'MDM', action: 'MERGE', verified_contractor_id: nt1.id, verified_master_record_id: entry, contractor_id: nt2.id, master_record_id: entry },
        },
      });
      // Nothing was merged, changed or linked by name: the second claim is as it was, and the verified one is still alone.
      expect(await as((tx) => contractors.find(tx, nt2.id))).toMatchObject({ verificationStatus: 'UNVERIFIED', version: 1, legalName: 'Cty NT Hai' });
      expect(await owner("select count(*)::int as n from machvon.contractor where tax_identifier = $1 and verification_status = 'VERIFIED'", [taxIdentifier])).toEqual([{ n: 1 }]);
      // The duplicate can still be rejected: the guard is about the verification only.
      await as((tx) => contractors.verify(tx, nt2.id, 1, { decision: 'REJECTED', evidenceDocumentId: evidence }, memberId(CHECKER)), CHECKER);
      expect(await as((tx) => contractors.find(tx, nt2.id))).toMatchObject({ verificationStatus: 'REJECTED', version: 2 });
    });

    it('answers 409 TAX_ID_DUPLICATE_VERIFIED, not a raw database error, when the other claim of the tax id is verified between the check and the write (race)', async () => {
      const taxIdentifier = freshTaxId();
      const nt1 = await register({ taxIdentifier, legalName: 'Cty NT Mot' });
      const nt2 = await register({ taxIdentifier, legalName: 'Cty NT Hai' });
      const evidence = await document(false);
      let holdOpen: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        holdOpen = resolve;
      });
      let firstWrote: () => void = () => undefined;
      const wrote = new Promise<void>((resolve) => {
        firstWrote = resolve;
      });
      // The first transaction verifies nt1 and stays open; the second passes its check (nothing is committed yet) and waits on the unique index.
      const first = as(async (tx) => {
        await contractors.verify(tx, nt1.id, 1, { decision: 'VERIFIED', evidenceDocumentId: evidence }, memberId(CHECKER));
        firstWrote();
        await gate;
      }, CHECKER);
      await wrote;
      const second = refusal(as((tx) => contractors.verify(tx, nt2.id, 1, { decision: 'VERIFIED', evidenceDocumentId: evidence }, memberId(CHECKER)), CHECKER));
      await new Promise((resolve) => setTimeout(resolve, 700));
      holdOpen();
      await first;
      expect(await second).toMatchObject({
        code: 'TAX_ID_DUPLICATE_VERIFIED',
        status: 409,
        extensions: { merge_suggestion: { target: 'MDM', action: 'MERGE', verified_contractor_id: nt1.id, contractor_id: nt2.id } },
      });
      expect(await as((tx) => contractors.find(tx, nt2.id))).toMatchObject({ verificationStatus: 'UNVERIFIED', version: 1 });
    }, 30_000);

    it('verifies on the evidence document by someone else: the person, the time and the evidence are kept, and the version moves', async () => {
      const created = await register();
      const evidence = await document(false);
      const done = await as((tx) => contractors.verify(tx, created.id, 1, { decision: 'VERIFIED', evidenceDocumentId: evidence }, memberId(CHECKER)), CHECKER);
      expect(done.version).toBe(2);
      expect(done.row).toMatchObject({
        verificationStatus: 'VERIFIED',
        verificationBasis: 'EVIDENCE_DOCUMENT',
        lookup: null,
        verifiedBy: memberId(CHECKER),
        verificationEvidenceDocumentId: evidence,
        version: 2,
      });
      expect(done.row.verifiedAt).not.toBeNull();
    });

    it('links the master entry at verification when the contractor was registered before master data had one', async () => {
      const taxIdentifier = freshTaxId();
      const created = await register({ taxIdentifier });
      expect(created.masterRecordId).toBeNull();
      const entry = await master(taxIdentifier);
      const evidence = await document(false);
      const verifiedNow = await as((tx) => contractors.verify(tx, created.id, 1, { decision: 'VERIFIED', evidenceDocumentId: evidence }, memberId(CHECKER)), CHECKER);
      expect(verifiedNow.row.masterRecordId).toBe(entry);
    });

    it('records a lookup as it was, and calls the verification a lookup only when the adapter itself is VERIFIED and said MATCH', async () => {
      const cases: Array<[LookupRecord, string]> = [
        [lookup('VERIFIED', 'MATCH'), 'EVIDENCE_DOCUMENT_AND_LOOKUP'],
        [lookup('MOCK', 'MATCH'), 'EVIDENCE_DOCUMENT'],
        [lookup('PROPOSED', 'MATCH'), 'EVIDENCE_DOCUMENT'],
        [lookup('MISSING', 'UNAVAILABLE'), 'EVIDENCE_DOCUMENT'],
        [lookup('VERIFIED', 'UNAVAILABLE'), 'EVIDENCE_DOCUMENT'],
      ];
      for (const [record, basis] of cases) {
        const created = await register();
        const evidence = await document(false);
        const done = await as((tx) => contractors.verify(tx, created.id, 1, { decision: 'VERIFIED', evidenceDocumentId: evidence, lookup: record }, memberId(CHECKER)), CHECKER);
        expect([record.adapterStatus, record.outcome, done.row.verificationBasis]).toEqual([record.adapterStatus, record.outcome, basis]);
        expect(done.row.lookup).toEqual(record);
      }
    });

    it('does not record a lookup for a rejection, and a rejection carries no basis', async () => {
      const created = await register();
      const evidence = await document(false);
      const done = await as((tx) => contractors.verify(tx, created.id, 1, { decision: 'REJECTED', evidenceDocumentId: evidence, lookup: lookup('MOCK', 'MATCH') }, memberId(CHECKER)), CHECKER);
      expect(done.row).toMatchObject({ verificationStatus: 'REJECTED', verificationBasis: null, lookup: null, verifiedBy: memberId(CHECKER) });
    });

    it('refuses the person who registered it (403 SELF_APPROVAL_DENIED), a stale version (VERSION_CONFLICT), a decided contractor and evidence that does not exist', async () => {
      const created = await register();
      const evidence = await document(false);
      expect(await refusal(as((tx) => contractors.verify(tx, created.id, 1, { decision: 'VERIFIED', evidenceDocumentId: evidence }, memberId(MAKER)), MAKER))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(as((tx) => contractors.verify(tx, created.id, 7, { decision: 'VERIFIED', evidenceDocumentId: evidence }, memberId(CHECKER)), CHECKER))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(as((tx) => contractors.verify(tx, created.id, 1, { decision: 'VERIFIED', evidenceDocumentId: randomUUID() }, memberId(CHECKER)), CHECKER))).toEqual({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: 'verification_evidence_document_id',
      });
      expect(await refusal(as((tx) => contractors.verify(tx, randomUUID(), 1, { decision: 'VERIFIED', evidenceDocumentId: evidence }, memberId(CHECKER)), CHECKER))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      await as((tx) => contractors.verify(tx, created.id, 1, { decision: 'VERIFIED', evidenceDocumentId: evidence }, memberId(CHECKER)), CHECKER);
      expect(await refusal(as((tx) => contractors.verify(tx, created.id, 2, { decision: 'REJECTED', evidenceDocumentId: evidence }, memberId(CHECKER)), CHECKER))).toEqual({
        code: 'STAGE_TRANSITION_DENIED',
        status: 409,
        detail: 'verification_status',
      });
    });
  });

  describe('what the database itself keeps', () => {
    it('refuses to change a tax id, to undo a decision, and to verify without the person, the time, the evidence and the basis', async () => {
      const created = await register();
      expect(await databaseRefusal(owner("update machvon.contractor set tax_identifier = '0999999999' where id = $1", [created.id]))).toContain('keeps its tax id');
      expect(await databaseRefusal(owner("update machvon.contractor set verification_status = 'VERIFIED' where id = $1", [created.id]))).toContain('by a person, at a time, on evidence');
      const done = await verified(freshTaxId());
      expect(await databaseRefusal(owner("update machvon.contractor set verification_status = 'UNVERIFIED' where id = $1", [done.id]))).toContain('final');
      expect(await databaseRefusal(owner("update machvon.contractor set verification_status = 'REJECTED' where id = $1", [done.id]))).toContain('final');
    });

    it('refuses a basis that claims a lookup the adapter did not give, a lookup half recorded, a value outside the lists, a malformed tax id and a verifier who is the registrant', async () => {
      const done = await verified(freshTaxId());
      const evidence = await document(false);
      const updates = [
        "verification_basis = 'EVIDENCE_DOCUMENT_AND_LOOKUP', lookup_adapter_status = 'MOCK', lookup_outcome = 'MATCH', lookup_checked_at = now()",
        "verification_basis = 'EVIDENCE_DOCUMENT_AND_LOOKUP', lookup_adapter_status = 'VERIFIED', lookup_outcome = 'NOT_FOUND', lookup_checked_at = now()",
        "verification_basis = 'EVIDENCE_DOCUMENT_AND_LOOKUP'",
        "lookup_adapter_status = 'MOCK'",
        "lookup_adapter_status = 'TRUSTED', lookup_outcome = 'MATCH', lookup_checked_at = now()",
        "lookup_adapter_status = 'MOCK', lookup_outcome = 'FOUND', lookup_checked_at = now()",
        "verification_basis = 'GUESS'",
        `verified_by = created_by, verification_evidence_document_id = '${evidence}'`,
      ];
      const accepted: string[] = [];
      for (const set of updates) await owner(`update machvon.contractor set ${set} where id = $1`, [done.id]).then(() => accepted.push(set), () => undefined);
      expect(accepted).toEqual([]);
      const created = await register();
      expect(await databaseRefusal(owner("update machvon.contractor set verification_status = 'MAYBE' where id = $1", [created.id]))).toContain('contractor_verification_status_chk');
      expect(await databaseRefusal(owner("insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id) values ($1, $2, 'TAX-1', 'X', 'UNVERIFIED', $3)", [TENANT_A, randomUUID(), created.id]))).toContain('contractor_tax_identifier_chk');
      expect(await databaseRefusal(owner("update machvon.contractor set verification_basis = 'EVIDENCE_DOCUMENT' where id = $1", [created.id]))).toContain('contractor_basis_chk');
    });

    it('lets two contractors hold one tax id only while at most one is VERIFIED (unique index)', async () => {
      const taxIdentifier = freshTaxId();
      const first = await register({ taxIdentifier });
      const second = await register({ taxIdentifier });
      const evidence = await document(false);
      const verify = (target: string) =>
        owner(
          `update machvon.contractor set verification_status = 'VERIFIED', verification_basis = 'EVIDENCE_DOCUMENT', verified_by = $2, verified_at = now(), verification_evidence_document_id = $3 where id = $1`,
          [target, memberId(CHECKER), evidence],
        );
      await verify(first.id);
      expect(await databaseRefusal(verify(second.id))).toContain('contractor_tax_verified_uq');
    });
  });

  describe('restrictions', () => {
    it('records a restriction on a decision in force, and keeps it as a record', async () => {
      const done = await verified(freshTaxId());
      const decision = await document(true);
      const recorded = await as((tx) => contractors.recordRestriction(tx, done.id, { kind: 'DEBARMENT', effectiveFrom: '2026-01-01', effectiveUntil: '2027-12-31', decisionDocumentId: decision, note: '  By decision 12  ' }, memberId(CHECKER)), CHECKER);
      expect(recorded.version).toBe(1);
      const list = (await as((tx) => contractors.restrictionsOf(tx, [done.id]))).get(done.id);
      expect(list).toEqual([
        { id: recorded.id, contractorId: done.id, kind: 'DEBARMENT', source: 'DECISION', effectiveFrom: '2026-01-01', effectiveUntil: '2027-12-31', decisionDocumentId: decision, note: 'By decision 12', createdBy: memberId(CHECKER), version: 1 },
      ]);
      expect(await databaseRefusal(owner('delete from machvon.contractor_restriction where id = $1', [recorded.id]))).toContain('never deleted');
      expect(await databaseRefusal(owner("update machvon.contractor_restriction set kind = 'WARNING' where id = $1", [recorded.id]))).toContain('not rewritten');
      expect(await databaseRefusal(owner('update machvon.contractor_restriction set effective_from = effective_from + 1 where id = $1', [recorded.id]))).toContain('not rewritten');
      await owner("update machvon.contractor_restriction set effective_until = '2026-06-30', note = 'Ended earlier by decision 13' where id = $1", [recorded.id]);
      expect((await as((tx) => contractors.restrictionsOf(tx, [done.id]))).get(done.id)?.[0]).toMatchObject({ effectiveUntil: '2026-06-30', note: 'Ended earlier by decision 13' });
      // The end may only be brought forward: moving it later, or taking it away, would lift or stretch a debarment by rewriting the record.
      expect(await databaseRefusal(owner("update machvon.contractor_restriction set effective_until = '2027-12-31' where id = $1", [recorded.id]))).toContain('only be brought forward');
      expect(await databaseRefusal(owner('update machvon.contractor_restriction set effective_until = null where id = $1', [recorded.id]))).toContain('only be brought forward');
      expect((await as((tx) => contractors.restrictionsOf(tx, [done.id]))).get(done.id)?.[0]).toMatchObject({ effectiveUntil: '2026-06-30' });
    });

    it('lets an open-ended restriction be given an end, once, and only earlier from then on', async () => {
      const done = await verified(freshTaxId());
      const decision = await document(true);
      const recorded = await as((tx) => contractors.recordRestriction(tx, done.id, { kind: 'SUSPENSION', effectiveFrom: '2026-01-01', decisionDocumentId: decision }, memberId(CHECKER)), CHECKER);
      await owner("update machvon.contractor_restriction set effective_until = '2026-12-31' where id = $1", [recorded.id]);
      expect(await databaseRefusal(owner("update machvon.contractor_restriction set effective_until = '2027-01-01' where id = $1", [recorded.id]))).toContain('only be brought forward');
      await owner("update machvon.contractor_restriction set effective_until = '2026-11-30' where id = $1", [recorded.id]);
    });

    it('refuses a decision that is not in force or does not exist, an unknown contractor, a kind outside the list, and dates that are not a range', async () => {
      const done = await verified(freshTaxId());
      const base: RestrictionInput = { kind: 'SUSPENSION', effectiveFrom: '2026-01-01', decisionDocumentId: await document(true) };
      const record = (input: Partial<RestrictionInput>, target = done.id) => as((tx) => contractors.recordRestriction(tx, target, { ...base, ...input }, memberId(CHECKER)), CHECKER);
      expect(await refusal(record({ decisionDocumentId: await document(false) }))).toEqual({ code: 'DECISION_DOCUMENT_NOT_EFFECTIVE', status: 422, detail: 'decision_document_id' });
      expect(await refusal(record({ decisionDocumentId: randomUUID() }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'decision_document_id' });
      expect(await refusal(record({}, randomUUID()))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(record({ kind: 'BAN' as RestrictionInput['kind'] }))).toMatchObject({ detail: 'kind' });
      expect(await refusal(record({ effectiveFrom: '2026-02-30' }))).toMatchObject({ detail: 'effective_from' });
      expect(await refusal(record({ effectiveFrom: 'soon' }))).toMatchObject({ detail: 'effective_from' });
      expect(await refusal(record({ effectiveUntil: '2025-12-31' }))).toMatchObject({ detail: 'effective_until' });
      expect(await refusal(record({ effectiveUntil: 'later' }))).toMatchObject({ detail: 'effective_until' });
      expect(await refusal(record({ note: 'n'.repeat(1001) }))).toMatchObject({ detail: 'note' });
      expect(await refusal(record({ note: 'a\u0000b' }))).toMatchObject({ detail: 'note' });
      // A restriction of one day is allowed, and a note with line breaks is kept.
      await record({ effectiveUntil: '2026-01-01', note: 'line 1\nline 2' });
      expect((await as((tx) => contractors.restrictionsOf(tx, [done.id]))).get(done.id)?.[0]?.note).toBe('line 1\nline 2');
    });

    it('counts a restriction in force from its first to its last day, whatever it is', async () => {
      const done = await verified(freshTaxId());
      const decision = await document(true);
      await as((tx) => contractors.recordRestriction(tx, done.id, { kind: 'SUSPENSION', effectiveFrom: '2026-03-01', effectiveUntil: '2026-03-31', decisionDocumentId: decision }, memberId(CHECKER)), CHECKER);
      const on = async (date: string) => (await as((tx) => contractors.restrictionsInForce(tx, [done.id], date))).get(done.id)?.kind;
      expect(await on('2026-02-28')).toBeUndefined();
      expect(await on('2026-03-01')).toBe('SUSPENSION');
      expect(await on('2026-03-31')).toBe('SUSPENSION');
      expect(await on('2026-04-01')).toBeUndefined();
      expect(await as((tx) => contractors.restrictionsInForce(tx, []))).toEqual(new Map());
      expect(await as((tx) => contractors.restrictionsOf(tx, []))).toEqual(new Map());
    });

    it('blocks a debarred contractor from taking part, and says why; the restriction wins over every other state (AC-ST-BID-002-1)', async () => {
      const taxIdentifier = freshTaxId();
      const nt3 = await verified(taxIdentifier);
      const decision = await document(true);
      await as((tx) => contractors.recordRestriction(tx, nt3.id, { kind: 'DEBARMENT', effectiveFrom: '2026-01-01', effectiveUntil: '2027-12-31', decisionDocumentId: decision }, memberId(CHECKER)), CHECKER);
      const expected = { code: 'CONTRACTOR_RESTRICTED', status: 422, extensions: { restriction: { kind: 'DEBARMENT', effective_from: '2026-01-01', effective_until: '2027-12-31' } } };
      // What the registration of a proposal and the submission of a result both ask first.
      expect(await refusal(as((tx) => contractors.assertMayTakePart(tx, nt3.id, TODAY)))).toEqual(expected);
      expect(await refusal(as((tx) => contractors.assertMayTakePart(tx, nt3.id, '2027-12-31')))).toEqual(expected);
      expect((await as((tx) => contractors.assertMayTakePart(tx, nt3.id, '2028-01-01'))).id).toBe(nt3.id);
      expect((await as((tx) => contractors.assertMayTakePart(tx, nt3.id, '2025-12-31'))).id).toBe(nt3.id);
      // A restriction also stops a contractor that nobody verified: the reason given is the restriction.
      const unverified = await register();
      await as((tx) => contractors.recordRestriction(tx, unverified.id, { kind: 'WARNING', effectiveFrom: '2026-01-01', decisionDocumentId: decision }, memberId(CHECKER)), CHECKER);
      expect((await refusal(as((tx) => contractors.assertMayTakePart(tx, unverified.id, TODAY)))).code).toBe('CONTRACTOR_RESTRICTED');
      expect((await refusal(as((tx) => contractors.assertMayTakePart(tx, unverified.id, '2020-01-01')))).code).toBe('CONTRACTOR_NOT_VERIFIED');
      expect(await refusal(as((tx) => contractors.assertMayTakePart(tx, randomUUID(), TODAY)))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('uses today in Vietnam when no date is given', async () => {
      const done = await verified(freshTaxId());
      expect((await as((tx) => contractors.assertMayTakePart(tx, done.id))).id).toBe(done.id);
      const decision = await document(true);
      await as((tx) => contractors.recordRestriction(tx, done.id, { kind: 'DEBARMENT', effectiveFrom: '2000-01-01', decisionDocumentId: decision }, memberId(CHECKER)), CHECKER);
      expect((await refusal(as((tx) => contractors.assertMayTakePart(tx, done.id)))).code).toBe('CONTRACTOR_RESTRICTED');
    });
  });

  describe('reading', () => {
    it('lists the newest first by keyset, narrows to one contractor, and finds by id only inside the tenant', async () => {
      const first = await register();
      const second = await register();
      const third = await register();
      const page1 = await as((tx) => contractors.list(tx, null, { limit: 2, after: undefined }));
      expect(page1.map((row) => row.id).slice(0, 2)).toEqual([third.id, second.id]);
      const last = page1[1];
      const page2 = await as((tx) => contractors.list(tx, null, { limit: 100, after: { code: last?.createdAtKey ?? '', id: last?.id ?? '' } }));
      expect(page2.map((row) => row.id)).toContain(first.id);
      expect(page2.map((row) => row.id)).not.toContain(second.id);
      expect((await as((tx) => contractors.list(tx, first.id, { limit: 10, after: undefined }))).map((row) => row.id)).toEqual([first.id]);
      expect(await as((tx) => contractors.find(tx, first.id, false), MAKER, TENANT_B)).toBeUndefined();
      expect(await as((tx) => contractors.list(tx, first.id, { limit: 10, after: undefined }), MAKER, TENANT_B)).toEqual([]);
    });

    it('counts the contracts of a contractor, and tells a guest contractor from a member of staff', async () => {
      const created = await register();
      expect((await as((tx) => contractors.find(tx, created.id)))?.contractCount).toBe(0);
      expect(await as((tx) => contractors.callerOf(tx, memberId(MAKER)))).toEqual({ guest: false });
      await owner("update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2, valid_until = now() + interval '1 year' where id = $1", [memberId(CHECKER), created.id]);
      expect(await as((tx) => contractors.callerOf(tx, memberId(CHECKER)))).toEqual({ guest: true, contractorId: created.id });
      expect(await as((tx) => contractors.callerOf(tx, randomUUID()))).toEqual({ guest: false });
      await owner("update machvon.membership set membership_type = 'STAFF', contractor_id = null, valid_until = null where id = $1", [memberId(CHECKER)]);
    });
  });
});
