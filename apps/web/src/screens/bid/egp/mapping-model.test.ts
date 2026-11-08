import { describe, expect, it } from 'vitest';
import { problem, mapping, suggestions } from './test/mapping-test-support';
import {
  EMPTY_FORM,
  appliedCount,
  dayText,
  describeProblem,
  dongText,
  fieldOfDetail,
  filtersOf,
  findingKey,
  formOfSuggestion,
  instantDay,
  instantTime,
  isPackageLike,
  likenessText,
  methodKind,
  proposeBody,
  queryOf,
  searchOf,
  toMapping,
  toMappingPage,
  toSuggestionList,
  totalOf,
  validatePropose,
} from './mapping-model';
import type { ProposeForm } from './mapping-model';

const form = (over: Partial<ProposeForm> = {}): ProposeForm => ({ ...EMPTY_FORM, ourCode: 'GT-1', externalCode: 'IB2600001', ...over });

describe('mapping model (BID-23)', () => {
  it('reads a page defensively: unknown rows are dropped, counts default to 0, a page without items is refused', () => {
    const page = toMappingPage({ items: [mapping(1), { id: 'x', subject_type: 'NOPE', status: 'ACTIVE', external_code: 'A' }, null], next_cursor: '50', counts: { ACTIVE: 4, PROPOSED: 'x' }, as_of: '2026-11-12T03:00:00.000Z' });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe('50');
    expect(page.counts).toEqual({ PROPOSED: 0, ACTIVE: 4, REJECTED: 0, RETIRED: 0 });
    expect(totalOf(page.counts)).toBe(4);
    expect(() => toMappingPage({})).toThrow();
    expect(() => toSuggestionList(null)).toThrow();
    expect(toMapping({ ...mapping(1), can_decide: 'yes' })[0]?.canDecide).toBe(false);
  });

  it('reads the suggestions with their candidates and drops what has no code or likeness', () => {
    const list = toSuggestionList({ ...suggestions(), items: [...suggestions().items, { imported_name: 'no code' }, { external_code: 'B', candidates: [{ code: 'x' }, { package_id: 'p', code: 'c', confidence: 0.9 }] }] });
    expect(list.items.map((item) => item.externalCode)).toEqual(['IB2600900', 'B']);
    expect(list.items[0]?.candidates[0]).toMatchObject({ code: 'GT-9', confidence: 0.857, budgetVnd: '128400000000' });
    expect(list.items[1]?.candidates).toHaveLength(1);
    expect(list.threshold).toBe(0.8);
    expect(list.legalStatus).toBe('UNVERIFIED');
  });

  it('tells how a row was made in words: a MANUAL row with a confidence is a confirmed suggestion', () => {
    expect(methodKind({ matchMethod: 'IMPORT', confidence: null })).toBe('IMPORT');
    expect(methodKind({ matchMethod: 'RULE', confidence: null })).toBe('RULE');
    expect(methodKind({ matchMethod: 'MANUAL', confidence: null })).toBe('MANUAL');
    expect(methodKind({ matchMethod: 'MANUAL', confidence: 0.9 })).toBe('SUGGESTION');
  });

  it('keeps the filters in the address and ignores what is not a filter', () => {
    const filters = filtersOf(new URLSearchParams('subject_type=PACKAGE&status=PROPOSED&q=%20GT-1%20&junk=1'));
    expect(filters).toEqual({ subject_type: 'PACKAGE', status: 'PROPOSED', q: 'GT-1' });
    expect(searchOf(filters).toString()).toBe('subject_type=PACKAGE&status=PROPOSED&q=GT-1');
    expect(filtersOf(new URLSearchParams('subject_type=NOPE&status=ACTIVE&q='))).toEqual({ status: 'ACTIVE' });
    expect(appliedCount(filters)).toBe(3);
    expect(queryOf(filters, '50')).toEqual({ subject_type: 'PACKAGE', status: 'PROPOSED', q: 'GT-1', limit: 50, cursor: '50' });
    expect(queryOf({})).toEqual({ limit: 50 });
  });

  it('checks the proposal as the server does: codes present and within 100 characters, days real, the end after the start', () => {
    expect(validatePropose(form())).toEqual({});
    expect(validatePropose(form({ ourCode: '  ', externalCode: '' }))).toEqual({ ourCode: 'required', externalCode: 'required' });
    expect(validatePropose(form({ ourCode: 'x'.repeat(101) }))).toEqual({ ourCode: 'tooLong' });
    expect(validatePropose(form({ externalCode: 'a\u0007b' }))).toEqual({ externalCode: 'control' });
    expect(validatePropose(form({ validFrom: '2026-02-30' }))).toEqual({ validFrom: 'day' });
    expect(validatePropose(form({ validUntil: 'soon' }))).toEqual({ validUntil: 'day' });
    expect(validatePropose(form({ validFrom: '2026-11-10', validUntil: '2026-11-10' }))).toEqual({ validUntil: 'range' });
    expect(validatePropose(form({ validFrom: '2026-11-10', validUntil: '2026-11-11' }))).toEqual({});
    expect(validatePropose(form({ validUntil: '2026-11-11' }))).toEqual({});
    expect(validatePropose(form({ projectCode: 'x'.repeat(101) }))).toEqual({ projectCode: 'tooLong' });
    expect(validatePropose(form({ subjectType: 'CONTRACT', projectCode: 'x'.repeat(101) }))).toEqual({});
  });

  it('a suggestion has a likeness in (0, 1] and a contractor is never mapped from one', () => {
    expect(validatePropose(form({ suggestionConfidence: 0.857 }))).toEqual({});
    expect(validatePropose(form({ suggestionConfidence: 1 }))).toEqual({});
    expect(validatePropose(form({ suggestionConfidence: 0 }))).toEqual({ confidence: 'confidence' });
    expect(validatePropose(form({ suggestionConfidence: 1.2 }))).toEqual({ confidence: 'confidence' });
    expect(validatePropose(form({ subjectType: 'CONTRACTOR', suggestionConfidence: 0.9 }))).toEqual({ method: 'contractor' });
  });

  it('builds the body: trimmed, the project code only for a package-like subject, the method and confidence together, empty days left out', () => {
    expect(proposeBody(form({ ourCode: ' GT-1 ', externalCode: ' IB1 ', projectCode: ' PRJ-1 ' }), '  Khớp theo hồ sơ mời thầu ')).toEqual({
      subject_type: 'PACKAGE',
      our_code: 'GT-1',
      our_project_code: 'PRJ-1',
      external_code: 'IB1',
      match_method: 'MANUAL',
      reason: 'Khớp theo hồ sơ mời thầu',
    });
    expect(proposeBody(form({ subjectType: 'CONTRACTOR', ourCode: '0101234567', projectCode: 'PRJ-1', validFrom: '2026-11-01', validUntil: '2027-01-01' }), 'Khớp theo mã số thuế')).toEqual({
      subject_type: 'CONTRACTOR',
      our_code: '0101234567',
      external_code: 'IB2600001',
      match_method: 'MANUAL',
      valid_from: '2026-11-01',
      valid_until: '2027-01-01',
      reason: 'Khớp theo mã số thuế',
    });
    expect(proposeBody(formOfSuggestion('IB9', { code: 'GT-9', confidence: 0.857 }), 'Đã đối chiếu hồ sơ')).toMatchObject({ subject_type: 'PACKAGE', our_code: 'GT-9', external_code: 'IB9', match_method: 'NAME_SUGGESTION', confidence: 0.857 });
    expect(isPackageLike('PACKAGE') && isPackageLike('NOTICE') && isPackageLike('RESULT')).toBe(true);
    expect(isPackageLike('PROJECT') || isPackageLike('CONTRACTOR')).toBe(false);
  });

  it('names the reason of a duplicate and the field of a validation, and keeps the findings', () => {
    const duplicate = (reason?: string) => describeProblem(problem('CROSSWALK_DUPLICATE', 409, reason === undefined ? {} : { reason })).kind;
    expect(duplicate('EXTERNAL_CODE_TAKEN')).toBe('externalCodeTaken');
    expect(duplicate('SUBJECT_HAS_OTHER_CODE')).toBe('subjectHasOtherCode');
    expect(duplicate('UNCHANGED')).toBe('unchanged');
    expect(duplicate('ALREADY_PROPOSED')).toBe('alreadyProposed');
    expect(duplicate('SOMETHING_NEW')).toBe('duplicate');
    expect(duplicate()).toBe('duplicate');
    expect(describeProblem(problem('SELF_APPROVAL_DENIED', 403)).kind).toBe('selfApproval');
    expect(describeProblem(problem('VERSION_CONFLICT', 409)).kind).toBe('versionConflict');
    expect(describeProblem(problem('EGP_MAPPING_STATE_INVALID', 409)).kind).toBe('stateInvalid');
    expect(describeProblem(problem('RESOURCE_NOT_FOUND', 404)).kind).toBe('notFound');
    expect(describeProblem(problem('SCOPE_DENIED', 403)).kind).toBe('forbidden');
    expect(describeProblem(problem('INTERNAL_ERROR', 500)).kind).toBe('general');
    expect(describeProblem(new Error('x')).kind).toBe('general');
    const invalid = describeProblem(problem('VALIDATION_FAILED', 422, { findings: [{ field: 'external_type', code: 'EXTERNAL_TYPE_MISMATCH' }, { nothing: true }] }, 'our_project_code'));
    expect(invalid).toEqual({ kind: 'validation', field: 'projectCode', findings: [{ field: 'external_type', code: 'EXTERNAL_TYPE_MISMATCH' }] });
    expect(fieldOfDetail('our_code')).toBe('ourCode');
    expect(fieldOfDetail('Field our_code does not exist')).toBe('ourCode');
    expect(fieldOfDetail('valid_until must be after valid_from')).toBe('validUntil');
    expect(fieldOfDetail('valid_until')).toBe('validUntil');
    expect(fieldOfDetail(undefined)).toBeUndefined();
    expect(findingKey('CONTRACTOR_BY_TAX_CODE_ONLY')).toBe('contractorByTaxCodeOnly');
  });

  it('writes days and numbers for people', () => {
    expect(dayText('2026-11-09')).toBe('09/11/2026');
    expect(dayText('soon')).toBe('soon');
    expect(instantDay('2026-11-12T20:00:00.000Z')).toBe('13/11/2026');
    expect(instantTime('2026-11-12T20:00:00.000Z')).toBe('03:00');
    expect(instantDay('nope')).toBe('nope');
    expect(likenessText(0.857, 'en')).toBe('0.857');
    expect(likenessText(1, 'en')).toBe('1');
    expect(dongText('128400000000', 'en')).toBe('128,400,000,000');
    expect(dongText('12.5', 'en')).toBe('12.5');
  });
});
