import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_POLICY_FORM,
  describeProblem,
  groupPolicies,
  phaseOf,
  toCategory,
  toPolicy,
  toPublishBody,
  toUnit,
  validatePolicy,
  validateRetireDate,
  vietnamToday,
} from './model';
import type { PolicyForm, PolicyView } from './model';
import { category, policy, unit } from './test-support';

const view = (n: number, overrides: Record<string, unknown> = {}): PolicyView => {
  const parsed = toPolicy(policy(n, overrides));
  if (parsed === undefined) throw new Error('fixture is not a policy');
  return parsed;
};
const problem = (code: string, detail?: string) => new ApiError({ status: 409, code, correlationId: 'c', retryAfterSeconds: undefined, detail, extensions: {} });

const TODAY = '2026-08-01';
const valid: PolicyForm = {
  ...EMPTY_POLICY_FORM,
  code: 'SLA-GPMB-HIGH',
  categoryVersionId: '00000000-0000-4000-8000-000000000001',
  severity: 'HIGH',
  responseHours: '4',
  resolveHours: '72',
  validFrom: '2026-08-15',
};

describe('toPolicy', () => {
  it('reads a row of the policy read', () => {
    expect(toPolicy(policy(1, { owner_unit_id: unit(1).id, valid_until: '2027-01-01', status: 'RETIRED', version: 2 }))).toEqual({
      id: policy(1).id,
      code: 'SLA-1',
      revision: 1,
      categoryVersionId: policy(1).category_version_id,
      categoryRecordId: policy(1).category_record_id,
      categoryKey: 'GPMB-1',
      categoryLabel: 'Giải phóng mặt bằng 1',
      severity: 'HIGH',
      ownerUnitId: unit(1).id,
      calendarCode: 'WORKDAY_VN',
      responseHours: 4,
      resolveHours: 72,
      escalateL2Pct: 100,
      escalateL3Pct: 150,
      requireIndependentVerifier: true,
      requireEvidence: true,
      validFrom: '2026-01-01',
      validUntil: '2027-01-01',
      status: 'RETIRED',
      version: 2,
    });
  });

  it('fills what the screen only shows with an empty text, and the flags with false', () => {
    const row = toPolicy({ ...policy(1), category_key: undefined, category_label: undefined, require_evidence: undefined, require_independent_verifier: 'yes' });
    expect(row).toMatchObject({ categoryKey: '', categoryLabel: '', requireEvidence: false, requireIndependentVerifier: false, ownerUnitId: null, validUntil: null });
  });

  it.each([
    ['not an object', 'text'],
    ['a list', []],
    ['a missing id', { ...policy(1), id: undefined }],
    ['a severity that does not exist', { ...policy(1), severity: 'URGENT' }],
    ['a status that does not exist', { ...policy(1), status: 'PAUSED' }],
    ['hours that are not whole', { ...policy(1), resolve_hours: 1.5 }],
    ['a missing date', { ...policy(1), valid_from: '' }],
  ])('drops a row with %s', (_name, raw) => {
    expect(toPolicy(raw)).toBeUndefined();
  });
});

describe('phaseOf and groupPolicies', () => {
  it('judges a version by its dates: a retired version still applies until its end date', () => {
    expect(phaseOf(view(1, { valid_from: '2026-09-01' }), TODAY)).toBe('scheduled');
    expect(phaseOf(view(1), TODAY)).toBe('inForce');
    expect(phaseOf(view(1, { status: 'RETIRED', valid_until: '2026-08-02' }), TODAY)).toBe('inForce');
    expect(phaseOf(view(1, { status: 'RETIRED', valid_until: TODAY }), TODAY)).toBe('ended');
    expect(phaseOf(view(1, { status: 'DRAFT' }), TODAY)).toBe('draft');
  });

  it('puts the versions of one category, severity and unit together, newest first, and shows the one that applies now', () => {
    const first = view(1, { id: 'a', revision: 1, valid_from: '2026-01-01', valid_until: '2026-07-01', status: 'RETIRED' });
    const second = view(1, { id: 'b', revision: 2, valid_from: '2026-07-01', valid_until: '2026-09-01', status: 'RETIRED' });
    const third = view(1, { id: 'c', revision: 3, valid_from: '2026-09-01' });
    const groups = groupPolicies([first, third, second], TODAY);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.versions.map((version) => version.id)).toEqual(['c', 'b', 'a']);
    expect(groups[0]?.current.id).toBe('b');
  });

  it('shows the next version when none applies yet, and the last one when all have ended', () => {
    const early = view(1, { id: 'a', valid_from: '2026-09-01', valid_until: '2026-10-01', status: 'RETIRED' });
    const late = view(1, { id: 'b', valid_from: '2026-10-01', revision: 2 });
    expect(groupPolicies([early, late], TODAY)[0]?.current.id).toBe('a');
    const ended = view(2, { id: 'c', valid_from: '2025-01-01', valid_until: '2025-06-01', status: 'RETIRED' });
    const endedLater = view(2, { id: 'd', valid_from: '2025-06-01', valid_until: '2026-01-01', status: 'RETIRED', revision: 2 });
    expect(groupPolicies([ended, endedLater], TODAY)[0]?.current.id).toBe('d');
  });

  it('keeps a severity and a unit apart and orders the groups by category, severity and unit', () => {
    const rows = [
      view(2, { id: 'a', severity: 'LOW' }),
      view(1, { id: 'b', severity: 'CRITICAL' }),
      view(1, { id: 'c', severity: 'LOW', owner_unit_id: unit(1).id }),
      view(1, { id: 'd', severity: 'LOW' }),
    ];
    expect(groupPolicies(rows, TODAY).map((group) => group.current.id)).toEqual(['d', 'c', 'b', 'a']);
    expect(groupPolicies([], TODAY)).toEqual([]);
  });
});

describe('vietnamToday', () => {
  it('is the date in Vietnam (UTC+7), a day ahead of UTC in the evening', () => {
    expect(vietnamToday(new Date('2026-08-01T16:59:59Z'))).toBe('2026-08-01');
    expect(vietnamToday(new Date('2026-08-01T17:00:00Z'))).toBe('2026-08-02');
    expect(vietnamToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('validatePolicy and toPublishBody', () => {
  it('accepts a policy and sends the thresholds of the contract when they are left blank (AC-ST-ISS-001-1)', () => {
    expect(validatePolicy(valid, TODAY)).toEqual({});
    expect(toPublishBody(valid)).toEqual({
      code: 'SLA-GPMB-HIGH',
      category_version_id: valid.categoryVersionId,
      severity: 'HIGH',
      calendar_code: 'WORKDAY_VN',
      response_hours: 4,
      resolve_hours: 72,
      escalate_l2_pct: 100,
      escalate_l3_pct: 150,
      require_independent_verifier: true,
      require_evidence: true,
      valid_from: '2026-08-15',
    });
  });

  it('sends the unit and the thresholds that were typed, trimmed', () => {
    const body = toPublishBody({ ...valid, code: ' SLA-X ', ownerUnitId: unit(1).id, escalateL2Pct: ' 80 ', escalateL3Pct: '120', requireEvidence: false, requireIndependentVerifier: false, calendarCode: ' WORKDAY_VN ' });
    expect(body).toMatchObject({ code: 'SLA-X', owner_unit_id: unit(1).id, escalate_l2_pct: 80, escalate_l3_pct: 120, require_evidence: false, require_independent_verifier: false, calendar_code: 'WORKDAY_VN' });
  });

  it.each([
    [{ code: '' }, { code: 'required' }],
    [{ code: 'has space' }, { code: 'invalidCode' }],
    [{ code: 'x'.repeat(101) }, { code: 'invalidCode' }],
    [{ categoryVersionId: '' }, { categoryVersionId: 'required' }],
    [{ calendarCode: ' ' }, { calendarCode: 'required' }],
    [{ calendarCode: 'y'.repeat(41) }, { calendarCode: 'invalidCode' }],
    [{ responseHours: '' }, { responseHours: 'required' }],
    [{ responseHours: '0' }, { responseHours: 'invalidNumber' }],
    [{ responseHours: '1.5' }, { responseHours: 'invalidNumber' }],
    [{ responseHours: '2401' }, { responseHours: 'invalidNumber' }],
    [{ resolveHours: '' }, { resolveHours: 'required' }],
    [{ resolveHours: 'abc' }, { resolveHours: 'invalidNumber' }],
    [{ responseHours: '10', resolveHours: '5' }, { resolveHours: 'resolveOrder' }],
    [{ escalateL2Pct: '0' }, { escalateL2Pct: 'invalidNumber' }],
    [{ escalateL2Pct: '1000' }, { escalateL2Pct: 'invalidNumber' }],
    [{ escalateL3Pct: '1001' }, { escalateL3Pct: 'invalidNumber' }],
    [{ escalateL2Pct: '150' }, { escalateL3Pct: 'levelOrder' }],
    [{ escalateL2Pct: '120', escalateL3Pct: '120' }, { escalateL3Pct: 'levelOrder' }],
    [{ validFrom: '' }, { validFrom: 'required' }],
    [{ validFrom: 'next week' }, { validFrom: 'invalidDate' }],
    [{ validFrom: '2026-02-30' }, { validFrom: 'invalidDate' }],
    [{ validFrom: '2026-07-31' }, { validFrom: 'past' }],
  ] as Array<[Partial<PolicyForm>, Record<string, string>]>)('judges %j', (change, expected) => {
    expect(validatePolicy({ ...valid, ...change }, TODAY)).toEqual(expected);
  });

  it('takes today as a valid first day', () => {
    expect(validatePolicy({ ...valid, validFrom: TODAY }, TODAY)).toEqual({});
  });
});

describe('validateRetireDate', () => {
  const row = view(1, { valid_from: '2026-09-10' });
  it('wants a real date after the policy began and not in the past', () => {
    expect(validateRetireDate('', row, TODAY)).toBe('required');
    expect(validateRetireDate('soon', row, TODAY)).toBe('invalidDate');
    expect(validateRetireDate('2026-09-10', row, TODAY)).toBe('untilOrder');
    expect(validateRetireDate('2026-09-09', row, TODAY)).toBe('untilOrder');
    expect(validateRetireDate('2026-09-11', row, TODAY)).toBeUndefined();
    expect(validateRetireDate('2026-07-31', view(1, { valid_from: '2026-01-01' }), TODAY)).toBe('past');
    expect(validateRetireDate(TODAY, view(1, { valid_from: '2026-01-01' }), TODAY)).toBeUndefined();
  });
});

describe('describeProblem', () => {
  it.each([
    ['SLA_POLICY_OVERLAP', 'overlap'],
    ['SLA_POLICY_STATE_INVALID', 'stateInvalid'],
    ['VALIDATION_FAILED', 'validation'],
    ['FIELD_NOT_ALLOWED', 'validation'],
    ['INVALID_REQUEST', 'validation'],
    ['SCOPE_DENIED', 'denied'],
    ['PERMISSION_DENIED', 'denied'],
    ['RESOURCE_NOT_FOUND', 'notFound'],
    ['SOMETHING_ELSE', 'general'],
  ])('maps %s to %s', (code, reason) => {
    expect(describeProblem(problem(code, 'valid_from'))).toEqual({ reason, field: 'valid_from' });
  });

  it('treats a failure that is not an API error as the general one', () => {
    expect(describeProblem(new Error('network'))).toEqual({ reason: 'general', field: undefined });
  });
});

describe('toCategory and toUnit', () => {
  it('offers a category that is in force, by the version in force', () => {
    expect(toCategory(category(1))).toEqual({ versionId: category(1).version_id, key: 'GPMB-1', label: 'Giải phóng mặt bằng 1' });
    expect(toCategory(category(1, { label: null }))).toMatchObject({ label: 'GPMB-1' });
  });

  it('leaves out a category that is not in force, or has no version', () => {
    expect(toCategory(category(1, { status: 'RETIRED' }))).toBeUndefined();
    expect(toCategory(category(1, { version_id: null }))).toBeUndefined();
    expect(toCategory(category(1, { business_key: '' }))).toBeUndefined();
    expect(toCategory('text')).toBeUndefined();
  });

  it('reads a unit and names it by its code when it has no name', () => {
    expect(toUnit(unit(1))).toEqual({ id: unit(1).id, code: 'UBND-1', name: 'Ủy ban nhân dân 1' });
    expect(toUnit(unit(1, { name: undefined }))).toMatchObject({ name: 'UBND-1' });
    expect(toUnit(unit(1, { id: undefined }))).toBeUndefined();
    expect(toUnit(null)).toBeUndefined();
  });
});
