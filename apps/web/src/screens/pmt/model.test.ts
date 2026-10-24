import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_TYPE_FORM,
  canRetire,
  dayBefore,
  describeProblem,
  groupTypes,
  listOf,
  phaseOf,
  toPermitType,
  toPublishBody,
  validatePermitType,
  validateRetireDate,
  vietnamToday,
} from './model';
import type { PermitTypeForm, PermitTypeView } from './model';
import { permitType } from './test-support';

const view = (n: number, overrides: Record<string, unknown> = {}): PermitTypeView => {
  const parsed = toPermitType(permitType(n, overrides));
  if (parsed === undefined) throw new Error('fixture is not a permit type');
  return parsed;
};
const problem = (code: string, detail?: string) => new ApiError({ status: 409, code, correlationId: 'c', retryAfterSeconds: undefined, detail, extensions: {} });

const TODAY = '2026-08-01';
const valid: PermitTypeForm = {
  ...EMPTY_TYPE_FORM,
  code: 'BUILDING_PERMIT',
  name: 'Giấy phép xây dựng',
  authorityText: 'Cơ quan có thẩm quyền',
  legalBasis: 'Luật Xây dựng 135/2025, điều 43',
  effectiveFrom: '2026-09-01',
};
const NONE: ReadonlySet<string> = new Set();

describe('toPermitType', () => {
  it('reads a row of the permit type read', () => {
    expect(
      toPermitType(
        permitType(1, {
          cxn_ref: 'CXN-EXE-03',
          effective_until: '2026-12-31',
          status: 'RETIRED',
          version: 2,
          default_validity_months: 24,
          default_processing_days: 30,
          exemption_allowed: true,
          applies_to_rule: { project_group_keys: ['A', 'B'], work_types: ['ROAD'], min_total_investment_vnd: '1000', max_total_investment_vnd: '9000' },
        }),
      ),
    ).toEqual({
      id: permitType(1).id,
      code: 'PERMIT_1',
      revision: 1,
      name: 'Giấy phép 1',
      category: 'CONSTRUCTION_PERMIT',
      authorityText: 'Cơ quan có thẩm quyền',
      legalBasis: 'Nghị định 1/2026, điều 1',
      cxnRef: 'CXN-EXE-03',
      effectiveFrom: '2026-01-01',
      effectiveUntil: '2026-12-31',
      appliesTo: { projectGroupKeys: ['A', 'B'], workTypes: ['ROAD'], minTotalInvestmentVnd: '1000', maxTotalInvestmentVnd: '9000' },
      defaultValidityMonths: 24,
      defaultProcessingDays: 30,
      exemptionAllowed: true,
      status: 'RETIRED',
      version: 2,
    });
  });

  it('reads an empty condition as every project, and ignores a list that is not a list', () => {
    expect(toPermitType(permitType(1))?.appliesTo).toEqual({ projectGroupKeys: [], workTypes: [], minTotalInvestmentVnd: null, maxTotalInvestmentVnd: null });
    expect(toPermitType(permitType(1, { applies_to_rule: { work_types: 'ROAD', project_group_keys: ['A', 7] } }))?.appliesTo).toMatchObject({ workTypes: [], projectGroupKeys: ['A'] });
    expect(toPermitType(permitType(1, { applies_to_rule: null }))?.appliesTo.workTypes).toEqual([]);
  });

  it.each([
    ['not an object', 'text'],
    ['null', null],
    ['an array', []],
    ['without an id', { ...permitType(1), id: undefined }],
    ['without a legal basis', { ...permitType(1), legal_basis: '' }],
    ['with an unknown category', { ...permitType(1), category: 'MISC' }],
    ['with an unknown status', { ...permitType(1), status: 'ARCHIVED' }],
    ['with a revision that is not whole', { ...permitType(1), revision: 1.5 }],
    ['without a version', { ...permitType(1), version: undefined }],
  ])('refuses a row that is %s', (_name, raw) => {
    expect(toPermitType(raw)).toBeUndefined();
  });
});

describe('phaseOf and canRetire (the last day is inclusive)', () => {
  it('judges a version on the day', () => {
    expect(phaseOf(view(1, { status: 'DRAFT' }), TODAY)).toBe('draft');
    expect(phaseOf(view(1, { effective_from: '2026-08-02' }), TODAY)).toBe('scheduled');
    expect(phaseOf(view(1, { effective_from: '2026-08-01' }), TODAY)).toBe('inForce');
    expect(phaseOf(view(1, { effective_until: '2026-08-01', status: 'RETIRED' }), TODAY)).toBe('inForce');
    expect(phaseOf(view(1, { effective_until: '2026-07-31', status: 'RETIRED' }), TODAY)).toBe('ended');
  });

  it('lets a version be ended while it is open-ended or its last day has not passed', () => {
    expect(canRetire(view(1), TODAY)).toBe(true);
    expect(canRetire(view(1, { effective_until: '2026-12-31', status: 'RETIRED' }), TODAY)).toBe(true);
    expect(canRetire(view(1, { effective_until: '2026-08-01', status: 'RETIRED' }), TODAY)).toBe(false);
    expect(canRetire(view(1, { status: 'DRAFT' }), TODAY)).toBe(false);
  });
});

describe('groupTypes', () => {
  it('keeps the versions of a code together, newest first, and shows the one in force', () => {
    const groups = groupTypes([view(1, { id: 'old', code: 'B_CODE', revision: 1, effective_until: '2026-12-31', status: 'RETIRED' }), view(1, { id: 'new', code: 'B_CODE', revision: 2, effective_from: '2027-01-01' }), view(2, { code: 'A_CODE' })], TODAY);
    expect(groups.map((group) => group.code)).toEqual(['A_CODE', 'B_CODE']);
    expect(groups[1]?.versions.map((version) => version.id)).toEqual(['new', 'old']);
    expect(groups[1]?.current.id).toBe('old');
  });

  it('shows the nearest version to come when none is in force, else the last one', () => {
    const scheduled = [view(1, { id: 'a', code: 'X', revision: 1, effective_from: '2026-10-01', effective_until: '2026-12-31', status: 'RETIRED' }), view(1, { id: 'b', code: 'X', revision: 2, effective_from: '2027-01-01' })];
    expect(groupTypes(scheduled, TODAY)[0]?.current.id).toBe('a');
    const ended = [view(1, { id: 'c', code: 'Y', revision: 1, effective_until: '2026-03-31', status: 'RETIRED' })];
    expect(groupTypes(ended, TODAY)[0]?.current.id).toBe('c');
  });
});

describe('dates', () => {
  it('reads the day in Vietnam (UTC+7) and the day before a day', () => {
    expect(vietnamToday(new Date('2026-08-01T16:59:00Z'))).toBe('2026-08-01');
    expect(vietnamToday(new Date('2026-08-01T17:00:00Z'))).toBe('2026-08-02');
    expect(dayBefore('2027-01-01')).toBe('2026-12-31');
    expect(dayBefore('2028-03-01')).toBe('2028-02-29');
  });

  it('splits a typed list into its distinct entries', () => {
    expect(listOf(' A, B;C  A\nD ')).toEqual(['A', 'B', 'C', 'D']);
    expect(listOf('  ')).toEqual([]);
  });
});

describe('validatePermitType', () => {
  it('accepts a complete form', () => {
    expect(validatePermitType(valid, TODAY, NONE)).toEqual({});
  });

  it('says what is missing, a legal basis first of all (AC-ST-PMT-001-1)', () => {
    expect(validatePermitType(EMPTY_TYPE_FORM, TODAY, NONE)).toEqual({
      code: 'required',
      name: 'required',
      authorityText: 'required',
      legalBasis: 'required',
      effectiveFrom: 'required',
    });
    expect(validatePermitType({ ...valid, legalBasis: '   ' }, TODAY, NONE)).toEqual({ legalBasis: 'required' });
  });

  it.each([
    ['a lower-case code', { code: 'building' }, { code: 'invalidCode' }],
    ['a name that is too long', { name: 'x'.repeat(301) }, { name: 'tooLong' }],
    ['a legal basis that is too long', { legalBasis: 'x'.repeat(2001) }, { legalBasis: 'tooLong' }],
    ['a confirmation reference of the wrong shape', { cxnRef: 'EXE-03' }, { cxnRef: 'invalidReference' }],
    ['a date that does not exist', { effectiveFrom: '2026-02-30' }, { effectiveFrom: 'invalidDate' }],
    ['an end that does not exist', { effectiveUntil: '2026-13-01' }, { effectiveUntil: 'invalidDate' }],
    ['an end on the first day', { effectiveUntil: '2026-09-01' }, { effectiveUntil: 'untilOrder' }],
    ['a list with a bad code', { projectGroupKeys: 'A, b' }, { projectGroupKeys: 'invalidKeys' }],
    ['more than fifty works', { workTypes: Array.from({ length: 51 }, (_unused, n) => `W${n}`).join(',') }, { workTypes: 'invalidKeys' }],
    ['an amount with a point', { minInvestment: '1.5' }, { minInvestment: 'invalidAmount' }],
    ['a maximum below the minimum', { minInvestment: '10', maxInvestment: '9' }, { maxInvestment: 'amountOrder' }],
    ['no months', { validityMonths: '0' }, { validityMonths: 'invalidNumber' }],
    ['months over the limit', { validityMonths: '1201' }, { validityMonths: 'invalidNumber' }],
    ['days that are not a number', { processingDays: 'ten' }, { processingDays: 'invalidNumber' }],
    ['days over the limit', { processingDays: '3651' }, { processingDays: 'invalidNumber' }],
  ] as Array<[string, Partial<PermitTypeForm>, Record<string, string>]>)('refuses %s', (_name, overrides, expected) => {
    expect(validatePermitType({ ...valid, ...overrides }, TODAY, NONE)).toEqual(expected);
  });

  it('lets the first revision of a code begin in the past and refuses it for the next revision of a code that exists', () => {
    expect(validatePermitType({ ...valid, effectiveFrom: '2025-01-01' }, TODAY, NONE)).toEqual({});
    expect(validatePermitType({ ...valid, effectiveFrom: '2025-01-01' }, TODAY, new Set(['BUILDING_PERMIT']))).toEqual({ effectiveFrom: 'past' });
    expect(validatePermitType({ ...valid, effectiveFrom: TODAY }, TODAY, new Set(['BUILDING_PERMIT']))).toEqual({});
  });

  it('takes the maximum equal to the minimum and the bounds of the counts', () => {
    expect(validatePermitType({ ...valid, minInvestment: '500', maxInvestment: '500', validityMonths: '1200', processingDays: '3650' }, TODAY, NONE)).toEqual({});
  });
});

describe('toPublishBody', () => {
  it('sends only what was filled in, trimmed, with the lists as lists', () => {
    expect(toPublishBody({ ...valid, code: ' BUILDING_PERMIT ', name: ' Giấy phép xây dựng ' })).toEqual({
      code: 'BUILDING_PERMIT',
      name: 'Giấy phép xây dựng',
      category: 'OTHER',
      authority_text: 'Cơ quan có thẩm quyền',
      legal_basis: 'Luật Xây dựng 135/2025, điều 43',
      effective_from: '2026-09-01',
      applies_to_rule: {},
      exemption_allowed: false,
    });
    expect(
      toPublishBody({
        ...valid,
        cxnRef: 'CXN-EXE-02',
        effectiveUntil: '2031-12-31',
        projectGroupKeys: 'B, A',
        workTypes: 'ROAD',
        minInvestment: '1000',
        maxInvestment: '9000',
        validityMonths: '24',
        processingDays: '30',
        exemptionAllowed: true,
        category: 'LAND',
      }),
    ).toEqual({
      code: 'BUILDING_PERMIT',
      name: 'Giấy phép xây dựng',
      category: 'LAND',
      authority_text: 'Cơ quan có thẩm quyền',
      legal_basis: 'Luật Xây dựng 135/2025, điều 43',
      cxn_ref: 'CXN-EXE-02',
      effective_from: '2026-09-01',
      effective_until: '2031-12-31',
      applies_to_rule: { project_group_keys: ['B', 'A'], work_types: ['ROAD'], min_total_investment_vnd: '1000', max_total_investment_vnd: '9000' },
      default_validity_months: 24,
      default_processing_days: 30,
      exemption_allowed: true,
    });
  });
});

describe('validateRetireDate', () => {
  const open = view(1, { effective_from: '2026-01-01' });
  const ended = view(2, { effective_from: '2026-01-01', effective_until: '2026-12-31', status: 'RETIRED' });

  it('accepts a day after the first day that is not gone', () => {
    expect(validateRetireDate('2026-12-31', open, TODAY)).toBeUndefined();
    expect(validateRetireDate('2026-08-01', open, TODAY)).toBeUndefined();
  });

  it('asks for a date, a real date, after the first day, and not in days that are gone', () => {
    expect(validateRetireDate('', open, TODAY)).toBe('required');
    expect(validateRetireDate('2026-02-30', open, TODAY)).toBe('invalidDate');
    expect(validateRetireDate('2026-01-01', open, TODAY)).toBe('untilOrder');
    expect(validateRetireDate('2026-07-31', open, TODAY)).toBe('past');
  });

  it('moves the end only earlier, and takes the end the version already has even when it is in the past', () => {
    expect(validateRetireDate('2027-01-01', ended, TODAY)).toBe('laterEnd');
    expect(validateRetireDate('2026-12-31', ended, TODAY)).toBeUndefined();
    expect(validateRetireDate('2026-11-30', ended, TODAY)).toBeUndefined();
    const past = view(3, { effective_from: '2026-01-01', effective_until: '2026-03-31', status: 'RETIRED' });
    expect(validateRetireDate('2026-03-31', past, TODAY)).toBeUndefined();
  });
});

describe('describeProblem', () => {
  it.each([
    ['PERMIT_TYPE_OVERLAP', 'overlap'],
    ['PERMIT_TYPE_IN_USE', 'inUse'],
    ['LEGAL_BASIS_REQUIRED', 'legalBasis'],
    ['VALIDATION_FAILED', 'validation'],
    ['FIELD_NOT_ALLOWED', 'validation'],
    ['INVALID_REQUEST', 'validation'],
    ['SCOPE_DENIED', 'denied'],
    ['PERMISSION_DENIED', 'denied'],
    ['RESOURCE_NOT_FOUND', 'notFound'],
    ['SOMETHING_ELSE', 'general'],
  ])('maps %s to %s', (code, reason) => {
    expect(describeProblem(problem(code, 'effective_from'))).toEqual({ reason, field: 'effective_from' });
  });

  it('treats a failure that is not a problem of the server as a general one', () => {
    expect(describeProblem(new Error('network'))).toEqual({ reason: 'general', field: undefined });
  });
});
