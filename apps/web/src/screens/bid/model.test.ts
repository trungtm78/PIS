import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILTER,
  EMPTY_REGISTER_FORM,
  EMPTY_RESTRICTION_FORM,
  describeProblem,
  filterContractors,
  profileLink,
  registerBody,
  restrictionBody,
  toContractorLine,
  toContractorView,
  validateRegister,
  validateRestriction,
  validateVerify,
} from './model';
import { DOCUMENT, detail, line, restriction, verifiedLine } from './test-support';

const problem = (code: string, status: number, extensions: Record<string, unknown> = {}, detail?: string) => new ApiError({ status, code, correlationId: 'c', extensions, ...(detail === undefined ? {} : { detail }) });

describe('readers of the registry', () => {
  it('reads a line of the list with the verification, the lookup and the restriction in force', () => {
    const read = toContractorLine(
      verifiedLine(3, {
        verification_basis: 'EVIDENCE_DOCUMENT_AND_LOOKUP',
        identity_lookup: { adapter_status: 'VERIFIED', outcome: 'MATCH', checked_at: '2026-10-20T02:00:00.000000Z' },
        master_record_id: DOCUMENT,
        restriction_in_force: restriction(1, { effective_until: null }),
      }),
    );
    expect(read).toMatchObject({
      legalName: 'Công ty nhà thầu 3',
      taxIdentifierMasked: true,
      verificationStatus: 'VERIFIED',
      verificationBasis: 'EVIDENCE_DOCUMENT_AND_LOOKUP',
      lookup: { adapterStatus: 'VERIFIED', outcome: 'MATCH', checkedAt: '2026-10-20T02:00:00.000000Z' },
      masterRecordId: DOCUMENT,
      contractCount: 2,
      restrictionInForce: { kind: 'DEBARMENT', effectiveFrom: '2026-01-01', effectiveUntil: null, decisionDocumentId: null, note: null, source: 'DECISION' },
      version: 1,
    });
  });

  it('drops an answer that is not a contractor of the contract, and ignores a lookup or a restriction that is not one', () => {
    expect(toContractorLine(null)).toBeUndefined();
    expect(toContractorLine({ id: 'x' })).toBeUndefined();
    expect(toContractorLine(line(1, { verification_status: 'MAYBE' }))).toBeUndefined();
    expect(toContractorLine(line(1, { version: '1' }))).toBeUndefined();
    const odd = toContractorLine(line(1, { identity_lookup: { adapter_status: 'TRUSTED', outcome: 'MATCH', checked_at: 'x' }, restriction_in_force: { id: 1 }, verification_basis: 'GUESS', contract_count: 'many' }));
    expect(odd).toMatchObject({ lookup: null, restrictionInForce: null, verificationBasis: null, contractCount: 0 });
  });

  it('reads the profile with the restrictions, and leaves out the people and the documents that were not sent', () => {
    const read = toContractorView(detail(1, { restrictions: [restriction(1, { decision_document_id: DOCUMENT, note: 'Decision 12' }), { id: 5 }] }));
    expect(read?.restrictions).toEqual([{ id: restriction(1).id, kind: 'DEBARMENT', source: 'DECISION', effectiveFrom: '2026-01-01', effectiveUntil: '2027-12-31', decisionDocumentId: DOCUMENT, note: 'Decision 12' }]);
    expect(read).toMatchObject({ profileDocumentId: DOCUMENT, verifiedBy: null, verificationEvidenceDocumentId: null, taxIdentifierMasked: false });
    const covered = toContractorView(line(1));
    expect(covered).toMatchObject({ profileDocumentId: null, restrictions: [] });
    expect(toContractorView(7)).toBeUndefined();
    expect(toContractorView(line(1, { restrictions: 'none' }))?.restrictions).toEqual([]);
  });

  it('links to the profile by id', () => {
    expect(profileLink('abc')).toBe('/bid/bid-02?id=abc');
  });
});

describe('filterContractors', () => {
  const all = [toContractorLine(line(1)), toContractorLine(verifiedLine(2, { restriction_in_force: restriction(1) })), toContractorLine(line(3, { verification_status: 'REJECTED' }))].flatMap((item) => item ?? []);

  it('filters by text in the name or the tax id, by status and by a restriction in force', () => {
    expect(filterContractors(all, EMPTY_FILTER).map((item) => item.legalName)).toHaveLength(3);
    expect(filterContractors(all, { ...EMPTY_FILTER, query: ' NHÀ THẦU 2 ' }).map((item) => item.legalName)).toEqual(['Công ty nhà thầu 2']);
    expect(filterContractors(all, { ...EMPTY_FILTER, query: '010****561' }).map((item) => item.legalName)).toEqual(['Công ty nhà thầu 1']);
    expect(filterContractors(all, { ...EMPTY_FILTER, status: 'REJECTED' }).map((item) => item.legalName)).toEqual(['Công ty nhà thầu 3']);
    expect(filterContractors(all, { ...EMPTY_FILTER, restrictedOnly: true }).map((item) => item.legalName)).toEqual(['Công ty nhà thầu 2']);
    expect(filterContractors(all, { query: 'zzz', status: '', restrictedOnly: false })).toEqual([]);
  });
});

describe('forms', () => {
  it('asks for every field of a registration and tells which is wrong', () => {
    expect(validateRegister(EMPTY_REGISTER_FORM)).toEqual({ taxIdentifier: 'required', legalName: 'required', profileDocumentId: 'required' });
    expect(validateRegister({ taxIdentifier: '12345', legalName: 'x', legalForm: 'y'.repeat(101), profileDocumentId: 'nope' })).toEqual({
      taxIdentifier: 'invalidTaxId',
      legalName: 'tooShort',
      legalForm: 'tooLong',
      profileDocumentId: 'invalidId',
    });
    expect(validateRegister({ taxIdentifier: '1'.repeat(10), legalName: 'x'.repeat(501), legalForm: '', profileDocumentId: DOCUMENT }).legalName).toBe('tooLong');
    expect(validateRegister({ taxIdentifier: ' 0101 234 567-001 ', legalName: 'Cty', legalForm: '', profileDocumentId: DOCUMENT })).toEqual({});
  });

  it('sends only the allowlist of the contract, with the optional form left out when it is empty', () => {
    expect(registerBody({ taxIdentifier: ' 0101 234 567 ', legalName: ' Cty ', legalForm: ' ', profileDocumentId: ` ${DOCUMENT} ` })).toEqual({ tax_identifier: '0101234567', legal_name: 'Cty', profile_document_id: DOCUMENT });
    expect(registerBody({ taxIdentifier: '0101234567', legalName: 'Cty', legalForm: ' TNHH ', profileDocumentId: DOCUMENT })).toMatchObject({ legal_form: 'TNHH' });
  });

  it('asks for the evidence document of a verification', () => {
    expect(validateVerify({ decision: 'VERIFIED', evidenceDocumentId: '' })).toEqual({ evidenceDocumentId: 'required' });
    expect(validateVerify({ decision: 'REJECTED', evidenceDocumentId: 'nope' })).toEqual({ evidenceDocumentId: 'invalidId' });
    expect(validateVerify({ decision: 'VERIFIED', evidenceDocumentId: DOCUMENT })).toEqual({});
  });

  it('checks the dates, their order, the decision and the note of a restriction', () => {
    expect(validateRestriction(EMPTY_RESTRICTION_FORM)).toEqual({ effectiveFrom: 'required', decisionDocumentId: 'required' });
    expect(validateRestriction({ ...EMPTY_RESTRICTION_FORM, effectiveFrom: '2026-02-30', effectiveUntil: 'later', decisionDocumentId: DOCUMENT, note: 'n'.repeat(1001) })).toEqual({
      effectiveFrom: 'invalidDate',
      effectiveUntil: 'invalidDate',
      note: 'tooLong',
    });
    expect(validateRestriction({ ...EMPTY_RESTRICTION_FORM, effectiveFrom: '2026-05-01', effectiveUntil: '2026-04-30', decisionDocumentId: DOCUMENT })).toEqual({ effectiveUntil: 'order' });
    expect(validateRestriction({ ...EMPTY_RESTRICTION_FORM, effectiveFrom: '2026-05-01', effectiveUntil: '2026-05-01', decisionDocumentId: DOCUMENT })).toEqual({});
  });

  it('sends a restriction with its optional end and note only when they are given', () => {
    expect(restrictionBody({ kind: 'WARNING', effectiveFrom: '2026-01-01', effectiveUntil: '', decisionDocumentId: ` ${DOCUMENT} `, note: ' ' })).toEqual({ kind: 'WARNING', effective_from: '2026-01-01', decision_document_id: DOCUMENT });
    expect(restrictionBody({ kind: 'DEBARMENT', effectiveFrom: '2026-01-01', effectiveUntil: '2027-12-31', decisionDocumentId: DOCUMENT, note: ' By decision 12 ' })).toEqual({
      kind: 'DEBARMENT',
      effective_from: '2026-01-01',
      effective_until: '2027-12-31',
      decision_document_id: DOCUMENT,
      note: 'By decision 12',
    });
  });
});

describe('describeProblem', () => {
  it('maps each refusal of the contract to what the screens show, and names the verified holder of a tax id', () => {
    const reasons: Array<[string, number, string]> = [
      ['TAX_ID_INVALID', 409, 'taxIdInvalid'],
      ['CONTRACTOR_ALREADY_VERIFIED', 422, 'alreadyVerified'],
      ['TAX_ID_DUPLICATE_VERIFIED', 409, 'duplicateVerified'],
      ['SELF_APPROVAL_DENIED', 403, 'selfApproval'],
      ['VERSION_CONFLICT', 409, 'versionConflict'],
      ['STAGE_TRANSITION_DENIED', 409, 'stageDenied'],
      ['DECISION_DOCUMENT_NOT_EFFECTIVE', 422, 'decisionNotEffective'],
      ['VALIDATION_FAILED', 422, 'validation'],
      ['FIELD_NOT_ALLOWED', 400, 'validation'],
      ['RESOURCE_NOT_FOUND', 404, 'notFound'],
      ['SCOPE_DENIED', 403, 'denied'],
      ['SOMETHING_ELSE', 500, 'general'],
    ];
    for (const [code, status, reason] of reasons) expect(describeProblem(problem(code, status)).reason).toBe(reason);
    expect(describeProblem(new Error('x'))).toEqual({ reason: 'general', field: undefined });
    expect(describeProblem(problem('VALIDATION_FAILED', 422, {}, 'legal_name'))).toEqual({ reason: 'validation', field: 'legal_name' });
    const duplicate = describeProblem(problem('TAX_ID_DUPLICATE_VERIFIED', 409, { merge_suggestion: { verified_contractor_id: 'v1' } }, 'tax_identifier'));
    expect(duplicate).toEqual({ reason: 'duplicateVerified', field: 'tax_identifier', verifiedContractorId: 'v1' });
    expect(describeProblem(problem('CONTRACTOR_ALREADY_VERIFIED', 422, { existing_contractor_id: 'v2' })).verifiedContractorId).toBe('v2');
  });

  it('tells an official lookup that contradicts the evidence from a tax id that is not well formed, by what was asked', () => {
    expect(describeProblem(problem('TAX_ID_INVALID', 409), 'register').reason).toBe('taxIdInvalid');
    expect(describeProblem(problem('TAX_ID_INVALID', 409), 'verify').reason).toBe('adapterContradicts');
  });
});
