import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_FORM,
  describeProblem,
  filterLines,
  formOfRevision,
  fundTree,
  groupByOrigin,
  isVnd,
  millionsInput,
  millionsText,
  registerBody,
  sortLines,
  sumVnd,
  toAppropriation,
  toMasterOption,
  totalsOf,
  validateForm,
  vndOfMillions,
  vndText,
  yearsOf,
  EMPTY_FILTER,
  SUPPORT_ORIGINS,
} from './model';
import type { AppropriationForm } from './model';
import { DOCUMENT, EXTENSION, FUND_NSTW, ODA, PROGRAM_NTM, line, master, world } from './test-support';

const lines = () => world().lines.flatMap((raw) => toAppropriation(raw) ?? []);
const problem = (code: string, status = 422, detail?: string) => new ApiError({ status, code, correlationId: 'c', detail, extensions: {} });

describe('money in millions of dong, exactly', () => {
  it('shows whole VND in millions with the grouping and the decimal mark of the language, with no float involved', () => {
    expect(millionsText('10000000000', 'vi')).toBe('10.000');
    expect(millionsText('10000000000', 'en')).toBe('10,000');
    expect(millionsText('1234567890', 'vi')).toBe('1.234,56789');
    expect(millionsText('1234567890', 'en')).toBe('1,234.56789');
    expect(millionsText('999999', 'vi')).toBe('0,999999');
    expect(millionsText('0', 'vi')).toBe('0');
    expect(millionsText('123456789012345678901234', 'en')).toBe('123,456,789,012,345,678.901234');
    expect(millionsText('not an amount', 'vi')).toBe('not an amount');
  });

  it('writes an amount for the input without grouping, and groups the exact dong for the confirmation line', () => {
    expect(millionsInput('10000000000', 'vi')).toBe('10000');
    expect(millionsInput('1234500000', 'vi')).toBe('1234,5');
    expect(millionsInput('1234500000', 'en')).toBe('1234.5');
    expect(millionsInput('x', 'vi')).toBe('x');
    expect(vndText('10000000000', 'vi')).toBe('10.000.000.000');
    expect(vndText('x', 'vi')).toBe('x');
  });

  it('turns millions typed into the exact VND, to the dong, and refuses what could be misread', () => {
    expect(vndOfMillions('10', 'vi')).toBe('10000000');
    expect(vndOfMillions(' 10000 ', 'vi')).toBe('10000000000');
    expect(vndOfMillions('1234,5', 'vi')).toBe('1234500000');
    expect(vndOfMillions('1234.5', 'en')).toBe('1234500000');
    expect(vndOfMillions('0,000001', 'vi')).toBe('1');
    expect(vndOfMillions('0,1234567', 'vi')).toBeUndefined();
    expect(vndOfMillions('0', 'vi')).toBeUndefined();
    expect(vndOfMillions('', 'vi')).toBeUndefined();
    // A point is a grouping mark in Vietnamese: "10.000" is never read as ten million, and a comma is not a decimal mark in English.
    expect(vndOfMillions('10.000', 'vi')).toBeUndefined();
    expect(vndOfMillions('10,000', 'en')).toBeUndefined();
    expect(vndOfMillions('1,2,3', 'vi')).toBeUndefined();
    expect(vndOfMillions('-5', 'vi')).toBeUndefined();
    expect(vndOfMillions('1e3', 'vi')).toBeUndefined();
    expect(vndOfMillions('9'.repeat(19), 'vi')).toBeUndefined();
    expect(vndOfMillions('9'.repeat(18), 'vi')).toBe(`${'9'.repeat(18)}000000`);
  });

  it('adds amounts exactly and leaves out what is not an amount', () => {
    expect(sumVnd(['10000000000', '4000000000', '1'])).toBe('14000000001');
    expect(sumVnd(['9007199254740993', '1'])).toBe('9007199254740994');
    expect(sumVnd(['12.5', 'x', '007'])).toBe('0');
    expect(sumVnd([])).toBe('0');
    expect(isVnd('0')).toBe(true);
    expect(isVnd('1'.repeat(24))).toBe(true);
    expect(isVnd('1'.repeat(25))).toBe(false);
    expect(isVnd('01')).toBe(false);
  });
});

describe('reading the register', () => {
  it('reads a line and leaves out one that is not a line of the register', () => {
    expect(lines()).toHaveLength(5);
    const first = lines()[0];
    expect(first).toMatchObject({ planYear: 2026, origin: 'PM_ASSIGNED', budgetLevel: 'CENTRAL', amountVnd: '10000000000', remainingVnd: '4000000000', decisionSymbol: '1/QD-TTg', status: 'PUBLISHED', version: 2 });
    expect(first?.fundSource).toMatchObject({ businessKey: 'NSTW-DTPT', category: 'NSTW', onLending: null });
    expect(toAppropriation(null)).toBeUndefined();
    expect(toAppropriation(line(1, { origin: 'GIFT' }))).toBeUndefined();
    expect(toAppropriation(line(1, { budget_level: 'PROVINCE' }))).toBeUndefined();
    expect(toAppropriation(line(1, { status: 'GONE' }))).toBeUndefined();
    expect(toAppropriation(line(1, { fund_source: { business_key: 'X' } }))).toBeUndefined();
    expect(toAppropriation(line(1, { decision_document: null }))).toBeUndefined();
    expect(toAppropriation(line(1, { amount_vnd: 10 }))).toBeUndefined();
    expect(toAppropriation(line(1, { version: '2' }))).toBeUndefined();
    expect(toAppropriation(line(1, { program: { version_id: PROGRAM_NTM, business_key: 'NTM' } }))?.program).toEqual({ versionId: PROGRAM_NTM, businessKey: 'NTM', label: 'NTM' });
    expect(toAppropriation(line(1, { decision_document: { id: DOCUMENT } }))).toMatchObject({ decisionSymbol: null, decisionIssuedOn: null });
    expect(toAppropriation({ ...line(1), revision: undefined, source_year: undefined, issuing_authority: undefined })).toMatchObject({ revision: 1, sourceYear: 2026, issuingAuthority: '' });
  });

  it('filters by year, origin and level, lists the years newest first and sorts by year, origin and source', () => {
    const all = lines();
    expect(yearsOf(all)).toEqual([2026, 2025]);
    expect(filterLines(all, { ...EMPTY_FILTER, year: '2025' })).toHaveLength(2);
    expect(filterLines(all, { ...EMPTY_FILTER, origin: 'LOCAL_ADDED' }).map((row) => row.id)).toEqual([lines()[1]?.id]);
    expect(filterLines(all, { ...EMPTY_FILTER, budgetLevel: 'LOCAL' })).toHaveLength(2);
    expect(filterLines(all, EMPTY_FILTER)).toHaveLength(5);
    expect(sortLines(all).map((row) => [row.planYear, row.origin])).toEqual([
      [2026, 'PM_ASSIGNED'],
      [2026, 'PM_ASSIGNED'],
      [2026, 'LOCAL_ADDED'],
      [2025, 'CENTRAL_SUPPORT'],
      [2025, 'REVENUE_INCREASE'],
    ]);
  });

  it('adds the lines exactly, and groups the published ones by origin without merging one into another (AC-ST-CAP-001-2)', () => {
    const all = lines();
    expect(totalsOf(all.filter((row) => row.status === 'PUBLISHED'))).toEqual({ amountVnd: '49000000000', allocatedVnd: '31000000000', remainingVnd: '18000000000' });
    const groups = groupByOrigin(all);
    expect(groups.map((group) => [group.origin, group.lines.length, group.totals.amountVnd])).toEqual([
      ['PM_ASSIGNED', 1, '10000000000'],
      ['LOCAL_ADDED', 1, '4000000000'],
      ['CENTRAL_SUPPORT', 1, '20000000000'],
      ['REVENUE_INCREASE', 1, '15000000000'],
    ]);
    expect(groupByOrigin(all, SUPPORT_ORIGINS).map((group) => group.origin)).toEqual(['CENTRAL_SUPPORT', 'REVENUE_INCREASE']);
    expect(groupByOrigin([], SUPPORT_ORIGINS)).toEqual([]);
  });

  it('builds the tree of the fund sources from the published lines only, ODA included, and never adds a draft', () => {
    const tree = fundTree(lines());
    expect(tree.map((category) => [category.category, category.totals.amountVnd, category.sources.map((source) => source.fundSource.businessKey)])).toEqual([
      ['NSTW', '30000000000', ['NSTW-DTPT']],
      ['NSDP', '19000000000', ['NSDP-DTPT']],
    ]);
    const withOda = fundTree([...lines(), ...[line(6, { fund_source: ODA, amount_vnd: '5000000000', allocated_total_vnd: '0', remaining_vnd: '5000000000' })].flatMap((raw) => toAppropriation(raw) ?? [])]);
    expect(withOda.map((category) => category.category)).toEqual(['NSTW', 'NSDP', 'ODA']);
    expect(withOda[2]?.sources[0]?.fundSource).toMatchObject({ onLending: true, validUntil: '2030-12-31' });
    const unknown = toAppropriation(line(7, { fund_source: { ...ODA, category: 'SOMETHING' } }));
    expect(fundTree(unknown === undefined ? [] : [unknown]).map((category) => category.category)).toEqual(['OTHER']);
    expect(fundTree([])).toEqual([]);
  });

  it('offers the entries in force, without a fund source that is part of its parent', () => {
    expect(toMasterOption(master(FUND_NSTW, 'FUND_SOURCE', 'NSTW', 'Trung ương', { attributes: { category: 'NSTW', relation: 'ADDITIVE' } }))).toEqual([{ versionId: FUND_NSTW, businessKey: 'NSTW', label: 'Trung ương', category: 'NSTW' }]);
    expect(toMasterOption(master(FUND_NSTW, 'FUND_SOURCE', 'CTMTQG', 'NTM', { attributes: { relation: 'SUBSET_OF' } }))).toEqual([]);
    expect(toMasterOption(master(FUND_NSTW, 'FUND_SOURCE', 'OLD', 'Cũ', { status: 'RETIRED' }))).toEqual([]);
    expect(toMasterOption({ business_key: 'X' })).toEqual([]);
    expect(toMasterOption(null)).toEqual([]);
    expect(toMasterOption({ version_id: FUND_NSTW, business_key: 'X', status: 'EFFECTIVE' })).toEqual([{ versionId: FUND_NSTW, businessKey: 'X', label: 'X', category: null }]);
  });
});

const filled = (overrides: Partial<AppropriationForm> = {}): AppropriationForm => ({
  ...EMPTY_FORM,
  fundSourceVersionId: FUND_NSTW,
  planYear: '2026',
  amount: '10000',
  decisionDocumentId: DOCUMENT.toUpperCase(),
  issuingAuthority: ' Thủ tướng Chính phủ ',
  ...overrides,
});

describe('the form', () => {
  it('names what is missing or wrong and passes a form that is right', () => {
    expect(validateForm(filled(), 'vi')).toEqual({});
    expect(Object.keys(validateForm(EMPTY_FORM, 'vi')).sort()).toEqual(['amount', 'decisionDocumentId', 'fundSourceVersionId', 'issuingAuthority', 'planYear']);
    expect(validateForm(filled({ planYear: '26' }), 'vi')).toEqual({ planYear: 'invalidYear' });
    expect(validateForm(filled({ planYear: '2101' }), 'vi')).toEqual({ planYear: 'invalidYear' });
    expect(validateForm(filled({ amount: '10.000' }), 'vi')).toEqual({ amount: 'invalidAmount' });
    expect(validateForm(filled({ amount: '10000' }), 'en')).toEqual({});
    expect(validateForm(filled({ decisionDocumentId: 'QD-1' }), 'vi')).toEqual({ decisionDocumentId: 'invalidId' });
    expect(validateForm(filled({ issuingAuthority: 'a' }), 'vi')).toEqual({ issuingAuthority: 'tooShort' });
    expect(validateForm(filled({ issuingAuthority: 'a'.repeat(301) }), 'vi')).toEqual({ issuingAuthority: 'tooLong' });
  });

  it('asks a carry-over for its source year before the plan year, its extension document and the day the extension ends', () => {
    const carry = (overrides: Partial<AppropriationForm> = {}) => filled({ origin: 'CARRYOVER', sourceYear: '2025', extensionDocumentId: EXTENSION, extendedTo: '2026-12-31', ...overrides });
    expect(validateForm(carry(), 'vi')).toEqual({});
    expect(validateForm(filled({ origin: 'CARRYOVER' }), 'vi')).toEqual({ sourceYear: 'required', extensionDocumentId: 'required', extendedTo: 'required' });
    expect(validateForm(carry({ sourceYear: '2026' }), 'vi')).toEqual({ sourceYear: 'sourceYear' });
    expect(validateForm(carry({ sourceYear: '25' }), 'vi')).toEqual({ sourceYear: 'invalidYear' });
    expect(validateForm(carry({ extensionDocumentId: 'x' }), 'vi')).toEqual({ extensionDocumentId: 'invalidId' });
    expect(validateForm(carry({ extendedTo: '31/12/2026' }), 'vi')).toEqual({ extendedTo: 'invalidDate' });
    expect(validateForm(carry({ extendedTo: '2026-13-45' }), 'vi')).toEqual({ extendedTo: 'invalidDate' });
  });

  it('builds the body with the exact VND, the source year of the plan year, and only what was filled', () => {
    expect(registerBody(filled({ programVersionId: PROGRAM_NTM, amount: '1234,5' }), 'vi')).toEqual({
      fund_source_version_id: FUND_NSTW,
      plan_year: 2026,
      origin: 'PM_ASSIGNED',
      budget_level: 'CENTRAL',
      amount_vnd: '1234500000',
      decision_document_id: DOCUMENT,
      issuing_authority: 'Thủ tướng Chính phủ',
      source_year: 2026,
      program_master_version_id: PROGRAM_NTM,
    });
    expect(registerBody(filled(), 'vi')).not.toHaveProperty('program_master_version_id');
    expect(registerBody(filled(), 'vi')).not.toHaveProperty('extended_to');
    expect(registerBody(filled({ origin: 'CARRYOVER', sourceYear: '2025', extensionDocumentId: EXTENSION.toUpperCase(), extendedTo: '2026-12-31' }), 'vi', FUND_NSTW)).toMatchObject({
      origin: 'CARRYOVER',
      source_year: 2025,
      extended_to: '2026-12-31',
      extension_document_id: EXTENSION,
      supersedes_id: FUND_NSTW,
    });
  });

  it('starts a revision from the appropriation it replaces, with the amount in millions and without its document', () => {
    const published = lines()[0];
    const form = formOfRevision(published as NonNullable<typeof published>, 'vi');
    expect(form).toMatchObject({ fundSourceVersionId: FUND_NSTW, planYear: '2026', origin: 'PM_ASSIGNED', amount: '10000', decisionDocumentId: '', issuingAuthority: 'Thủ tướng Chính phủ', sourceYear: '2026', programVersionId: '' });
    const carried = toAppropriation(line(8, { origin: 'CARRYOVER', is_extended: true, extended_to: '2026-12-31', extension_document_id: EXTENSION, source_year: 2025, program: { version_id: PROGRAM_NTM, business_key: 'NTM' } }));
    expect(formOfRevision(carried as NonNullable<typeof carried>, 'en')).toMatchObject({ extendedTo: '2026-12-31', extensionDocumentId: EXTENSION, sourceYear: '2025', programVersionId: PROGRAM_NTM });
  });
});

describe('the refusals of the commands', () => {
  it.each([
    ['APPROPRIATION_BELOW_ALLOCATED', 422, 'belowAllocated'],
    ['DECISION_REQUIRED', 422, 'decisionRequired'],
    ['EXTENSION_DOCUMENT_REQUIRED', 422, 'extensionRequired'],
    ['APPROPRIATION_DUPLICATE', 409, 'duplicate'],
    ['REVISION_PENDING_EXISTS', 409, 'revisionPending'],
    ['SELF_APPROVAL_DENIED', 403, 'selfApproval'],
    ['VERSION_CONFLICT', 409, 'versionConflict'],
    ['STAGE_TRANSITION_DENIED', 409, 'stateInvalid'],
    ['FISCAL_YEAR_LOCKED', 409, 'yearLocked'],
    ['MASTER_NOT_EFFECTIVE', 422, 'masterNotEffective'],
    ['SUBSET_SOURCE_NOT_ADDITIVE', 422, 'subsetSource'],
    ['FIELD_NOT_ALLOWED', 400, 'notAllowed'],
    ['VALIDATION_FAILED', 422, 'validation'],
    ['INVALID_REQUEST', 400, 'validation'],
    ['RESOURCE_NOT_FOUND', 404, 'notFound'],
    ['SCOPE_DENIED', 403, 'denied'],
    ['SOMETHING_NEW', 500, 'general'],
  ])('maps %s to %s', (code, status, reason) => {
    expect(describeProblem(problem(code, status as number, 'field')).reason).toBe(reason);
  });

  it('keeps the field the server named, and treats a refusal for rights as a denial and an unknown failure as general', () => {
    expect(describeProblem(problem('VALIDATION_FAILED', 422, 'amount_vnd'))).toEqual({ reason: 'validation', field: 'amount_vnd' });
    expect(describeProblem(problem('PERMISSION_DENIED', 403))).toEqual({ reason: 'denied', field: undefined });
    expect(describeProblem(new Error('boom'))).toEqual({ reason: 'general', field: undefined });
  });
});
