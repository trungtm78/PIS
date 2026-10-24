import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { EMPTY_REGISTRATION, currentOf, describeScheduleProblem, monthOf, monthRows, rateOf, ratePercent, registrationBody, toScheduleItem, validateRegistration, vndOfTyped, yearOf, yearTotal } from './schedule-model';
import type { RegistrationForm, ScheduleItem } from './schedule-model';

const MILLION = 1_000_000;
const millions = (n: number): string => String(n * MILLION);
const raw = (overrides: Record<string, unknown> = {}) => ({
  id: 'r1',
  month: 10,
  kind: 'REGISTERED',
  granularity: 'MONTH',
  is_current: true,
  bucket: 'CURRENT_YEAR',
  budget_level: 'CENTRAL',
  amount_vnd: millions(800),
  ctmtqg_subset_vnd: null,
  revision: 1,
  achievement: { disbursed_vnd: millions(300), rate: '0.3750' },
  ...overrides,
});
const item = (overrides: Partial<ScheduleItem> = {}): ScheduleItem => ({ id: 'i', month: 10, bucket: 'CURRENT_YEAR', budgetLevel: 'CENTRAL', amountVnd: millions(800), ctmtqgSubsetVnd: null, revision: 1, disbursedVnd: millions(300), ...overrides });
const form = (overrides: Partial<RegistrationForm> = {}): RegistrationForm => ({ ...EMPTY_REGISTRATION, month: '10', amount: '800', ...overrides });
const problem = (code: string, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions: {} });

describe('the monthly registrations as the API answers them', () => {
  it('reads a current monthly registration with what was paid in its month', () => {
    expect(toScheduleItem(raw())).toEqual({ id: 'r1', month: 10, bucket: 'CURRENT_YEAR', budgetLevel: 'CENTRAL', amountVnd: millions(800), ctmtqgSubsetVnd: null, revision: 1, disbursedVnd: millions(300) });
    expect(toScheduleItem(raw({ ctmtqg_subset_vnd: millions(100), achievement: null }))).toMatchObject({ ctmtqgSubsetVnd: millions(100), disbursedVnd: '0' });
  });

  it('leaves out what is not a current monthly registration, or is not well formed', () => {
    for (const bad of [
      raw({ kind: 'FORECAST' }),
      raw({ granularity: 'WEEK' }),
      raw({ is_current: false }),
      raw({ month: 14 }),
      raw({ month: 0 }),
      raw({ month: 1.5 }),
      raw({ bucket: 'X' }),
      raw({ budget_level: 'X' }),
      raw({ amount_vnd: '1.5' }),
      raw({ amount_vnd: undefined }),
      raw({ revision: '1' }),
      raw({ id: undefined }),
      undefined,
      'row',
    ]) expect(toScheduleItem(bad)).toBeUndefined();
    expect(toScheduleItem(raw({ ctmtqg_subset_vnd: 'x', achievement: { disbursed_vnd: '-1' } }))).toMatchObject({ ctmtqgSubsetVnd: null, disbursedVnd: '0' });
  });
});

describe('the year by month', () => {
  it('always has the twelve months and the adjustment period, with both budget levels of a source group added up exactly', () => {
    const rows = monthRows([
      item({ amountVnd: millions(800), disbursedVnd: millions(300) }),
      item({ id: 'j', budgetLevel: 'LOCAL', amountVnd: millions(200), disbursedVnd: millions(100) }),
      item({ id: 'k', bucket: 'CARRYOVER', amountVnd: millions(50), disbursedVnd: '0' }),
      item({ id: 'l', month: 3, amountVnd: '0', disbursedVnd: millions(70) }),
    ]);
    expect(rows.map((row) => row.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(rows[9]).toMatchObject({ byBucket: { CURRENT_YEAR: millions(1_000), CARRYOVER: millions(50), OTHER: '0' }, registeredVnd: millions(1_050), disbursedVnd: millions(400), rate: '0.3810' });
    // Nothing registered in March: the payments are shown, the rate is not.
    expect(rows[2]).toMatchObject({ registeredVnd: '0', disbursedVnd: millions(70), rate: null });
    expect(rows[0]).toMatchObject({ registeredVnd: '0', rate: null });
    expect(yearTotal(rows)).toEqual({ registeredVnd: millions(1_050), disbursedVnd: millions(470), rate: '0.4476' });
  });

  it('keeps amounts above the safe integer range exact', () => {
    const big = '9007199254740993';
    const rows = monthRows([item({ amountVnd: big, disbursedVnd: '1' }), item({ id: 'j', budgetLevel: 'LOCAL', amountVnd: '1', disbursedVnd: '0' })]);
    expect(rows[9]?.registeredVnd).toBe('9007199254740994');
    expect(rateOf('9007199254740994', '9007199254740994')).toBe('1.0000');
  });

  it('computes the rate to four decimals, half up and exact, and none when nothing is registered', () => {
    expect(rateOf(millions(300), millions(800))).toBe('0.3750');
    expect(rateOf('1', '3')).toBe('0.3333');
    expect(rateOf('2', '3')).toBe('0.6667');
    expect(rateOf('1', '32')).toBe('0.0313');
    expect(rateOf('25', '10')).toBe('2.5000');
    expect(rateOf('5', '0')).toBeNull();
  });

  it('shows the rate as a percentage of the language', () => {
    expect(ratePercent('0.3750', 'en')).toBe('37.50%');
    expect(ratePercent('2.5000', 'en')).toBe('250.00%');
    expect(ratePercent('0.3750', 'vi')).toMatch(/^37,50\s?%$/);
  });

  it('finds the current registration of a key', () => {
    const items = [item(), item({ id: 'j', budgetLevel: 'LOCAL' })];
    expect(currentOf(items, 10, 'CURRENT_YEAR', 'LOCAL')?.id).toBe('j');
    expect(currentOf(items, 11, 'CURRENT_YEAR', 'LOCAL')).toBeUndefined();
  });
});

describe('the form', () => {
  it('takes millions of dong as typed, zero included, and nothing else', () => {
    expect(vndOfTyped('800', 'en')).toBe(millions(800));
    expect(vndOfTyped('0', 'en')).toBe('0');
    expect(vndOfTyped('000', 'en')).toBe('0');
    expect(vndOfTyped('0.5', 'en')).toBe('500000');
    expect(vndOfTyped('1.234567', 'en')).toBe('1234567');
    expect(vndOfTyped('0,5', 'vi')).toBe('500000');
    for (const bad of ['', 'x', '-1', '1,000', '1.1234567', '1e3']) expect(vndOfTyped(bad, 'en')).toBeUndefined();
  });

  it('asks for the month and the amount, refuses a programme amount above the amount, and a reason that is too long', () => {
    expect(validateRegistration(form(), 'en')).toEqual({});
    expect(validateRegistration(form({ month: '' }), 'en')).toEqual({ month: 'required' });
    expect(validateRegistration(form({ month: '14' }), 'en')).toEqual({ month: 'required' });
    expect(validateRegistration(form({ amount: ' ' }), 'en')).toEqual({ amount: 'required' });
    expect(validateRegistration(form({ amount: 'many' }), 'en')).toEqual({ amount: 'invalidAmount' });
    expect(validateRegistration(form({ amount: '0' }), 'en')).toEqual({});
    expect(validateRegistration(form({ ctmtqg: '801' }), 'en')).toEqual({ ctmtqg: 'subsetExceeds' });
    expect(validateRegistration(form({ ctmtqg: '800' }), 'en')).toEqual({});
    expect(validateRegistration(form({ ctmtqg: 'x' }), 'en')).toEqual({ ctmtqg: 'invalidAmount' });
    expect(validateRegistration(form({ reason: 'x'.repeat(2001) }), 'en')).toEqual({ reason: 'tooLong' });
    expect(Object.keys(validateRegistration(form({ month: '', amount: '' }), 'en')).sort()).toEqual(['amount', 'month']);
  });

  it('sends a monthly registration with exact VND, the programme amount and the reason only when given', () => {
    expect(registrationBody(form(), 'p1', 2026, 'en')).toEqual({
      project_id: 'p1',
      plan_year: 2026,
      granularity: 'MONTH',
      month: 10,
      kind: 'REGISTERED',
      bucket: 'CURRENT_YEAR',
      budget_level: 'CENTRAL',
      amount_vnd: millions(800),
    });
    expect(registrationBody(form({ bucket: 'CARRYOVER', budgetLevel: 'LOCAL', ctmtqg: '100', reason: '  Re-registered  ', month: '13' }), 'p1', 2026, 'en')).toMatchObject({
      month: 13,
      bucket: 'CARRYOVER',
      budget_level: 'LOCAL',
      ctmtqg_subset_vnd: millions(100),
      revision_reason: 'Re-registered',
    });
  });

  it('reads a month and a year as the server takes them', () => {
    expect(monthOf('1')).toBe(1);
    expect(monthOf('13')).toBe(13);
    for (const bad of ['', '0', '14', '1.5', 'x', '001']) expect(monthOf(bad)).toBeUndefined();
    expect(yearOf('2026')).toBe(2026);
    expect(yearOf(' 2026 ')).toBe(2026);
    for (const bad of ['', '26', '1989', '2101', '20260', 'abcd']) expect(yearOf(bad)).toBeUndefined();
  });

  it('maps the refusals of the command to what the screen says', () => {
    expect(describeScheduleProblem(problem('SUBSET_EXCEEDS_PARENT'))).toBe('subset');
    expect(describeScheduleProblem(problem('PERIOD_LOCKED', 409))).toBe('periodLocked');
    expect(describeScheduleProblem(problem('FISCAL_YEAR_LOCKED', 409))).toBe('yearLocked');
    expect(describeScheduleProblem(problem('PROJECT_STAGE_INVALID'))).toBe('stage');
    expect(describeScheduleProblem(problem('SCOPE_DENIED', 403))).toBe('denied');
    expect(describeScheduleProblem(problem('OTHER', 403))).toBe('denied');
    expect(describeScheduleProblem(problem('RESOURCE_NOT_FOUND', 404))).toBe('notFound');
    expect(describeScheduleProblem(problem('VALIDATION_FAILED'))).toBe('validation');
    expect(describeScheduleProblem(problem('OTHER', 500))).toBe('general');
    expect(describeScheduleProblem(new Error('offline'))).toBe('general');
  });
});
