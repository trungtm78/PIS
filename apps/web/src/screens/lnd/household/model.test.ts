import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { household } from '../test-support';
import {
  EMPTY_FILTER,
  EMPTY_LINK_FORM,
  EMPTY_REQUEST_FORM,
  EMPTY_REGISTER_FORM,
  canHandleRequests,
  canReveal,
  isOpenable,
  canWrite,
  describeProblem,
  filterHouseholds,
  linkBody,
  requestBody,
  registerBody,
  toHouseholdLine,
  toIdentity,
  validateLink,
  validateReason,
  validateRequest,
  validateRegister,
} from './model';
import type { LinkForm, RegisterForm, RequestForm } from './model';

const TODAY = '2026-10-26';
const UNIT = '00000000-0000-4000-8000-000200000001';
const CONSENT = '00000000-0000-4000-8000-000900000001';
const problem = (code: string) => new ApiError({ status: 422, code, correlationId: 'c', extensions: {} });

const filled = (overrides: Partial<RegisterForm> = {}): RegisterForm => ({
  ...EMPTY_REGISTER_FORM,
  ownerUnitId: UNIT,
  headName: 'Nguyễn Văn Anh',
  legalBasis: 'PUBLIC_TASK_LAND_LAW',
  legalBasisRef: 'Luật Đất đai 2024, Điều 87',
  retentionUntil: '2036-12-31',
  ...overrides,
});

describe('toHouseholdLine', () => {
  it('reads a household of the list with its parcels', () => {
    const line = toHouseholdLine(household(1, { parcels: [{ id: 'l', parcel_id: 'p', parcel_code: 'TB-1', right_kind: 'OWNER', share_pct: '60.0000' }, { id: 'bad' }] }));
    expect(line).toMatchObject({
      householdCode: 'HH-000001',
      headNameMasked: 'N***** V** A',
      nationalIdMasked: '********0001',
      phoneMasked: '*******678',
      addressMasked: '***, Quận 1',
      memberCount: 4,
      policyBeneficiary: false,
      legalBasis: 'PUBLIC_TASK_LAND_LAW',
      consentRecordId: null,
      retentionUntil: '2036-12-31',
      dsrOpen: false,
      status: 'REGISTERED',
      version: 1,
    });
    expect(line?.parcels).toEqual([{ id: 'l', parcelId: 'p', parcelCode: 'TB-1', rightKind: 'OWNER', sharePct: '60.0000' }]);
  });

  it('keeps what is not there as nothing, and takes no parcels from an answer that has none', () => {
    const line = toHouseholdLine(household(1, { national_id_masked: undefined, phone_masked: null, address_masked: 3, member_count: 'x', parcels: 'none', consent_record_id: CONSENT, dsr_open: true, policy_beneficiary: true }));
    expect(line).toMatchObject({ nationalIdMasked: null, phoneMasked: null, addressMasked: null, memberCount: null, parcels: [], consentRecordId: CONSENT, dsrOpen: true, policyBeneficiary: true });
  });

  it('drops a row it cannot read rather than showing it half', () => {
    expect(toHouseholdLine(null)).toBeUndefined();
    for (const field of ['id', 'project_id', 'owner_unit_id', 'household_code', 'head_name_masked', 'legal_basis', 'legal_basis_ref', 'retention_until', 'status', 'version']) {
      expect(toHouseholdLine(household(1, { [field]: undefined }))).toBeUndefined();
    }
    expect(toHouseholdLine(household(1, { legal_basis: 'WHIM' }))).toBeUndefined();
    expect(toHouseholdLine(household(1, { status: 'GONE' }))).toBeUndefined();
  });
});

describe('toIdentity', () => {
  it('reads the personal data of one household', () => {
    expect(toIdentity({ household_code: 'HH-000001', head_name: 'A', national_id: '1', phone: null, address_text: undefined })).toEqual({ householdCode: 'HH-000001', headName: 'A', nationalId: '1', phone: null, addressText: null });
  });

  it('takes nothing else for an identity', () => {
    expect(toIdentity(undefined)).toBeUndefined();
    expect(toIdentity({ household_code: 'HH-000001' })).toBeUndefined();
    expect(toIdentity({ head_name: 'A' })).toBeUndefined();
  });
});

describe('the rights', () => {
  it('lets whoever holds the permission write, unless the session is read-only', () => {
    expect(canWrite(['land.household.write'], 'FULL')).toBe(true);
    expect(canWrite(undefined, undefined)).toBe(true);
    expect(canWrite(['land.household.write'], 'READ_ONLY')).toBe(false);
    expect(canWrite(['land.household.read'], 'FULL')).toBe(false);
  });

  it('lets whoever holds the permission open the personal data, also in a read-only session', () => {
    expect(canReveal(['lnd.pii.read'])).toBe(true);
    expect(canReveal(undefined)).toBe(true);
    expect(canReveal(['land.household.read'])).toBe(false);
  });
});

describe('the handling of requests', () => {
  it('lets whoever holds land.dsr.handle handle them, unless the session is read-only', () => {
    expect(canHandleRequests(['land.dsr.handle'], 'FULL')).toBe(true);
    expect(canHandleRequests(undefined, undefined)).toBe(true);
    expect(canHandleRequests(['land.dsr.handle'], 'READ_ONLY')).toBe(false);
    expect(canHandleRequests(['lnd.pii.read'], 'FULL')).toBe(false);
  });

  it('opens the sealed data of a household that is not restricted and not erased', () => {
    const line = (overrides: Record<string, unknown>) => toHouseholdLine(household(1, overrides)) as NonNullable<ReturnType<typeof toHouseholdLine>>;
    expect(isOpenable(line({}))).toBe(true);
    expect(isOpenable(line({ processing_restricted: true }))).toBe(false);
    expect(isOpenable(line({ anonymised: true }))).toBe(false);
    expect(line({ processing_restricted: true, anonymised: true })).toMatchObject({ processingRestricted: true, anonymised: true });
    expect(line({})).toMatchObject({ processingRestricted: false, anonymised: false });
  });

  const filledRequest = (overrides: Partial<RequestForm> = {}): RequestForm => ({ requestKind: 'ERASE', requesterVerified: true, outcome: 'PARTIAL', reason: 'The voucher names the head of the household', ...overrides });

  it('asks for the kind, the person identified, the outcome and the reason', () => {
    expect(validateRequest(EMPTY_REQUEST_FORM)).toEqual({ requestKind: 'required', requesterVerified: 'required', outcome: 'required', reason: 'required' });
    expect(validateRequest(filledRequest())).toEqual({});
    expect(validateRequest(filledRequest({ requesterVerified: false }))).toEqual({ requesterVerified: 'required' });
  });

  it('refuses a reason that is too long or is not text', () => {
    expect(validateRequest(filledRequest({ reason: '   ' })).reason).toBe('required');
    expect(validateRequest(filledRequest({ reason: 'x'.repeat(2001) })).reason).toBe('tooLong');
    expect(validateRequest(filledRequest({ reason: 'a\u0007b' })).reason).toBe('invalid');
    expect(validateRequest(filledRequest({ reason: 'x'.repeat(2000) })).reason).toBeUndefined();
  });

  it('sends the request as it was filled in, the reason without its spaces', () => {
    expect(requestBody(filledRequest({ reason: '  Because of the voucher  ' }))).toEqual({ request_kind: 'ERASE', requester_verified: true, outcome: 'PARTIAL', reason: 'Because of the voucher' });
  });
});

describe('filterHouseholds', () => {
  const lines = [household(1), household(2, { head_name_masked: 'T*** T** B', status: 'DISPUTED', address_masked: null }), household(3, { status: 'CLOSED' })].flatMap((raw) => toHouseholdLine(raw) ?? []);

  it('keeps all of them for an empty filter, in the order of the read', () => {
    expect(filterHouseholds(lines, EMPTY_FILTER).map((line) => line.householdCode)).toEqual(['HH-000001', 'HH-000002', 'HH-000003']);
  });

  it('looks for a word in the code, the masked name and the masked address, ignoring capitals', () => {
    expect(filterHouseholds(lines, { ...EMPTY_FILTER, query: ' hh-000002 ' })).toHaveLength(1);
    expect(filterHouseholds(lines, { ...EMPTY_FILTER, query: 't*** t' })).toHaveLength(1);
    expect(filterHouseholds(lines, { ...EMPTY_FILTER, query: 'QUẬN 1' })).toHaveLength(2);
    expect(filterHouseholds(lines, { ...EMPTY_FILTER, query: 'nobody' })).toHaveLength(0);
  });

  it('keeps those of a status', () => {
    expect(filterHouseholds(lines, { ...EMPTY_FILTER, status: 'CLOSED' }).map((line) => line.householdCode)).toEqual(['HH-000003']);
  });
});

describe('validateRegister', () => {
  it('asks for the unit, the head, the basis, its reference and the retention', () => {
    expect(validateRegister(EMPTY_REGISTER_FORM, TODAY)).toEqual({
      ownerUnitId: 'required',
      headName: 'required',
      legalBasis: 'required',
      legalBasisRef: 'required',
      retentionUntil: 'required',
    });
    expect(validateRegister(filled(), TODAY)).toEqual({});
  });

  it('asks for the record of the consent when the basis is consent, and for a real identifier of it', () => {
    expect(validateRegister(filled({ legalBasis: 'CONSENT' }), TODAY).consentRecordId).toBe('required');
    expect(validateRegister(filled({ legalBasis: 'CONSENT', consentRecordId: 'x' }), TODAY).consentRecordId).toBe('invalid');
    expect(validateRegister(filled({ legalBasis: 'CONSENT', consentRecordId: CONSENT }), TODAY)).toEqual({});
    expect(validateRegister(filled({ consentRecordId: 'x' }), TODAY).consentRecordId).toBe('invalid');
  });

  it('accepts an identity number of 9 or 12 digits however it is spaced, and a telephone number with the country prefix', () => {
    for (const nationalId of ['079000000', '079 000 000 001', '079-000-000-001']) expect(validateRegister(filled({ nationalId }), TODAY).nationalId).toBeUndefined();
    for (const nationalId of ['1234', '07900000000A', '0790000000011']) expect(validateRegister(filled({ nationalId }), TODAY).nationalId).toBe('invalid');
    for (const phone of ['0912345678', '+84 912 345 678', '(091) 234-5678']) expect(validateRegister(filled({ phone }), TODAY).phone).toBeUndefined();
    for (const phone of ['12', '09123456789012', 'abc']) expect(validateRegister(filled({ phone }), TODAY).phone).toBe('invalid');
  });

  it('refuses text that is too long or holds control characters, and a count of members that is not a count', () => {
    const long = 'x'.repeat(2001);
    expect(validateRegister(filled({ headName: long }), TODAY).headName).toBe('tooLong');
    expect(validateRegister(filled({ headName: 'a\u0007b' }), TODAY).headName).toBe('invalid');
    expect(validateRegister(filled({ addressText: long }), TODAY).addressText).toBe('tooLong');
    expect(validateRegister(filled({ addressText: 'a\u0000b' }), TODAY).addressText).toBe('invalid');
    expect(validateRegister(filled({ legalBasisRef: long }), TODAY).legalBasisRef).toBe('tooLong');
    expect(validateRegister(filled({ legalBasisRef: 'a\u0001' }), TODAY).legalBasisRef).toBe('invalid');
    for (const memberCount of ['0', '1001', '1.5', 'x', '-1']) expect(validateRegister(filled({ memberCount }), TODAY).memberCount).toBe('invalid');
    for (const memberCount of ['1', '4', '1000']) expect(validateRegister(filled({ memberCount }), TODAY).memberCount).toBeUndefined();
  });

  it('keeps the data for a day that exists and is not before today', () => {
    expect(validateRegister(filled({ retentionUntil: '2026-10-25' }), TODAY).retentionUntil).toBe('past');
    expect(validateRegister(filled({ retentionUntil: '2026-10-26' }), TODAY).retentionUntil).toBeUndefined();
    expect(validateRegister(filled({ retentionUntil: '2026-02-31' }), TODAY).retentionUntil).toBe('invalid');
    expect(validateRegister(filled({ retentionUntil: 'soon' }), TODAY).retentionUntil).toBe('invalid');
  });
});

describe('registerBody', () => {
  it('sends the required fields only when nothing else was filled in', () => {
    expect(registerBody('p', filled({ headName: '  Trần Thị B  ' }))).toEqual({
      project_id: 'p',
      owner_unit_id: UNIT,
      head_name: 'Trần Thị B',
      legal_basis: 'PUBLIC_TASK_LAND_LAW',
      legal_basis_ref: 'Luật Đất đai 2024, Điều 87',
      retention_until: '2036-12-31',
    });
  });

  it('sends the identity number and the telephone number without their spaces, the prefix as 0, and the identifier in lower case', () => {
    const body = registerBody('p', filled({ nationalId: '079 000 000 001', phone: '+84 912 345 678', addressText: ' 12 Lê Lợi ', memberCount: ' 4 ', policyBeneficiary: true, legalBasis: 'CONSENT', consentRecordId: CONSENT.toUpperCase() }));
    expect(body).toMatchObject({ national_id: '079000000001', phone: '0912345678', address_text: '12 Lê Lợi', member_count: 4, policy_beneficiary: true, consent_record_id: CONSENT });
  });
});

describe('validateLink and linkBody', () => {
  const link = (overrides: Partial<LinkForm> = {}): LinkForm => ({ ...EMPTY_LINK_FORM, parcelId: 'p', rightKind: 'OWNER', ...overrides });

  it('asks for the parcel, the right and a share', () => {
    expect(validateLink(EMPTY_LINK_FORM)).toEqual({ parcelId: 'required', rightKind: 'required' });
    expect(validateLink(link())).toEqual({});
    expect(validateLink(link({ sharePct: '' })).sharePct).toBe('required');
  });

  it('accepts a share above 0 and up to 100 with at most four decimals', () => {
    for (const sharePct of ['100', '0.0001', '33.3333', '60']) expect(validateLink(link({ sharePct })).sharePct).toBeUndefined();
    for (const sharePct of ['0', '100.0001', '101', '12.12345', 'half', '-5']) expect(validateLink(link({ sharePct })).sharePct).toBe('invalid');
  });

  it('wants a title document that is an identifier when one is given', () => {
    expect(validateLink(link({ titleDocumentVersionId: 'x' })).titleDocumentVersionId).toBe('invalid');
    expect(validateLink(link({ titleDocumentVersionId: CONSENT })).titleDocumentVersionId).toBeUndefined();
  });

  it('sends the title document only when one was given', () => {
    expect(linkBody(link({ sharePct: ' 40 ' }))).toEqual({ parcel_id: 'p', right_kind: 'OWNER', share_pct: '40' });
    expect(linkBody(link({ titleDocumentVersionId: CONSENT.toUpperCase() }))).toEqual({ parcel_id: 'p', right_kind: 'OWNER', share_pct: '100', title_document_version_id: CONSENT });
  });
});

describe('validateReason', () => {
  it('wants words of at least ten characters and at most three hundred, with nothing that is not text', () => {
    expect(validateReason('')).toBe('required');
    expect(validateReason('     ')).toBe('required');
    expect(validateReason('too short')).toBe('invalid');
    expect(validateReason('a reason\u0007 with a control character')).toBe('invalid');
    expect(validateReason('x'.repeat(301))).toBe('tooLong');
    expect(validateReason('  Checking the record  ')).toBeUndefined();
    expect(validateReason('x'.repeat(300))).toBeUndefined();
    expect(validateReason('x'.repeat(10))).toBeUndefined();
  });
});

describe('describeProblem', () => {
  it('names the refusals that have their own sentence', () => {
    expect(describeProblem(problem('RETENTION_LEGAL_HOLD'))).toBe('retentionHold');
    expect(describeProblem(problem('REQUESTER_NOT_VERIFIED'))).toBe('requesterNotVerified');
    expect(describeProblem(problem('PROCESSING_RESTRICTED'))).toBe('processingRestricted');
    expect(describeProblem(problem('LEGAL_BASIS_REQUIRED'))).toBe('legalBasisRequired');
    expect(describeProblem(problem('CONSENT_REQUIRED'))).toBe('consentRequired');
    expect(describeProblem(problem('HOUSEHOLD_DUPLICATE'))).toBe('householdDuplicate');
    expect(describeProblem(problem('LINK_DUPLICATE'))).toBe('linkDuplicate');
    expect(describeProblem(problem('SHARE_EXCEEDS_100'))).toBe('shareExceeded');
    expect(describeProblem(problem('DOCUMENT_NOT_CLEAN'))).toBe('documentNotClean');
    expect(describeProblem(problem('PROVIDER_UNAVAILABLE'))).toBe('sealUnavailable');
    expect(describeProblem(problem('VALIDATION_FAILED'))).toBe('validation');
    expect(describeProblem(problem('FIELD_NOT_ALLOWED'))).toBe('validation');
    expect(describeProblem(problem('RESOURCE_NOT_FOUND'))).toBe('notFound');
    expect(describeProblem(problem('SCOPE_DENIED'))).toBe('denied');
  });

  it('says the general sentence for anything else', () => {
    expect(describeProblem(problem('SOMETHING_ELSE'))).toBe('general');
    expect(describeProblem(new Error('x'))).toBe('general');
    expect(describeProblem(undefined)).toBe('general');
  });
});
