import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKING_DAYS,
  calendarBody,
  countWorkingDays,
  dayKindOf,
  describeProblem,
  emptyValues,
  monthWeeks,
  rulesOf,
  rulesOfCalendar,
  toCalendar,
  validateCalendar,
  valuesOfCalendar,
} from './model';
import type { CalendarValues } from './model';

const filled = (changes: Partial<CalendarValues> = {}): CalendarValues => ({
  ...emptyValues(2026),
  calendarCode: 'VN-STD',
  legalBasis: 'Labour Code 2019 art. 112',
  ...changes,
});

const problem = (code: string, extensions: Record<string, unknown> = {}) => new ApiError({ status: 422, code, correlationId: 'c', extensions });

describe('reading a version', () => {
  const RAW = {
    id: 'c1',
    calendar_code: 'VN-STD',
    year: 2026,
    revision: 2,
    working_days: [1, 2, 3, 4, 5],
    holidays: [{ date: '2026-05-01', name: 'Labour Day', legal_basis_ref: 'Labour Code' }, { date: '2026-09-02', name: 'National Day' }, { name: 'no date' }, 'junk'],
    compensated_workdays: ['2026-05-09', 7],
    legal_basis_ref: 'Labour Code 2019 art. 112',
    status: 'Published',
    created_by: 'u1',
    published_by: 'u2',
    published_at: '2026-04-01T00:00:00Z',
    version: 2,
  };

  it('reads every field, and skips what is not a holiday', () => {
    expect(toCalendar(RAW)).toEqual({
      id: 'c1',
      calendarCode: 'VN-STD',
      year: 2026,
      revision: 2,
      workingDays: [1, 2, 3, 4, 5],
      holidays: [
        { date: '2026-05-01', name: 'Labour Day', legalBasis: 'Labour Code' },
        { date: '2026-09-02', name: 'National Day', legalBasis: null },
      ],
      compensatedWorkdays: ['2026-05-09'],
      legalBasis: 'Labour Code 2019 art. 112',
      status: 'Published',
      createdBy: 'u1',
      publishedBy: 'u2',
      publishedAt: '2026-04-01T00:00:00Z',
      version: 2,
    });
  });

  it('is not a version without an id, and treats an odd row as an empty draft', () => {
    expect(toCalendar(null)).toBeUndefined();
    expect(toCalendar({ calendar_code: 'X' })).toBeUndefined();
    expect(toCalendar({ id: 'c2', status: 'Weird', holidays: 'none', working_days: 'all' })).toMatchObject({ status: 'Draft', holidays: [], workingDays: [], year: 0, publishedBy: null });
  });

  it('fills the form from a version, to write its next revision', () => {
    const view = toCalendar(RAW);
    if (view === undefined) throw new Error('no view');
    expect(valuesOfCalendar(view)).toEqual({
      calendarCode: 'VN-STD',
      year: '2026',
      workingDays: [1, 2, 3, 4, 5],
      legalBasis: 'Labour Code 2019 art. 112',
      holidays: [
        { date: '2026-05-01', name: 'Labour Day', basis: 'Labour Code' },
        { date: '2026-09-02', name: 'National Day', basis: '' },
      ],
      compensated: ['2026-05-09'],
    });
    expect(rulesOfCalendar(view)).toEqual({ workingDays: [1, 2, 3, 4, 5], holidays: ['2026-05-01', '2026-09-02'], compensated: ['2026-05-09'] });
  });
});

describe('validating the form', () => {
  it('accepts a complete form', () => {
    expect(validateCalendar(filled())).toEqual({});
  });

  it.each([
    ['a blank code', { calendarCode: '  ' }, { calendarCode: 'required' }],
    ['a code that is too long', { calendarCode: 'A'.repeat(41) }, { calendarCode: 'tooLong' }],
    ['a code with a space', { calendarCode: 'VN STD' }, { calendarCode: 'pattern' }],
    ['a blank year', { year: ' ' }, { year: 'required' }],
    ['a year before 2020', { year: '2019' }, { year: 'range' }],
    ['a year after 2100', { year: '2101' }, { year: 'range' }],
    ['a year that is not a whole number', { year: '2026.5' }, { year: 'range' }],
    ['no working weekday', { workingDays: [] }, { workingDays: 'required' }],
    ['a blank legal basis', { legalBasis: '  ' }, { legalBasis: 'required' }],
    ['a holiday without a name', { holidays: [{ date: '2026-05-01', name: ' ', basis: '' }] }, { holidays: 'nameRequired' }],
  ] as Array<[string, Partial<CalendarValues>, Record<string, string>]>)('refuses %s', (_label, changes, expected) => {
    expect(validateCalendar(filled(changes))).toEqual(expected);
  });
});

describe('the request body', () => {
  it('trims the text, sorts the days, and sends a basis only where one was written', () => {
    const body = calendarBody(
      filled({
        calendarCode: ' VN-STD ',
        workingDays: [5, 1, 3],
        holidays: [
          { date: '2026-09-02', name: ' National Day ', basis: '  ' },
          { date: '2026-05-01', name: 'Labour Day', basis: ' Labour Code ' },
        ],
        compensated: ['2026-09-05', '2026-05-09'],
      }),
    );
    expect(body).toEqual({
      calendar_code: 'VN-STD',
      year: 2026,
      working_days: [1, 3, 5],
      holidays: [
        { date: '2026-05-01', name: 'Labour Day', legal_basis_ref: 'Labour Code' },
        { date: '2026-09-02', name: 'National Day' },
      ],
      compensated_workdays: ['2026-05-09', '2026-09-05'],
      legal_basis_ref: 'Labour Code 2019 art. 112',
    });
  });
});

describe('the month grid', () => {
  const rules = { workingDays: DEFAULT_WORKING_DAYS, holidays: ['2026-05-01'], compensated: ['2026-05-09'] };

  it('lays May 2026 out in weeks of seven, Monday first, with the first day on a Friday', () => {
    const weeks = monthWeeks(rules, 2026, 4);
    expect(weeks).toHaveLength(5);
    expect(weeks.every((week) => week.length === 7)).toBe(true);
    expect(weeks[0]?.map((cell) => cell?.day ?? null)).toEqual([null, null, null, null, 1, 2, 3]);
    expect(weeks[4]?.map((cell) => cell?.day ?? null)).toEqual([25, 26, 27, 28, 29, 30, 31]);
  });

  it('tells a holiday, a compensated Saturday, a weekend and a worked day apart', () => {
    const kind = (day: number) => dayKindOf(rules, 2026, 4, day);
    expect(kind(1)).toBe('holiday');
    expect(kind(2)).toBe('off');
    expect(kind(9)).toBe('compensated');
    expect(kind(11)).toBe('working');
    const cells = monthWeeks(rules, 2026, 4).flat();
    expect(cells.find((cell) => cell?.date === '2026-05-09')?.kind).toBe('compensated');
  });

  it('pads a month that ends before Sunday, and starts a month that begins on Monday without padding', () => {
    expect(monthWeeks(rules, 2026, 5)[0]?.[0]?.day).toBe(1);
    expect(monthWeeks(rules, 2026, 5)[4]?.map((cell) => cell?.day ?? null)).toEqual([29, 30, null, null, null, null, null]);
  });

  it('counts the worked days of a year: 261 weekdays in 2026, less holidays on weekdays, plus compensated days', () => {
    expect(countWorkingDays({ workingDays: DEFAULT_WORKING_DAYS, holidays: [], compensated: [] }, 2026)).toBe(261);
    expect(countWorkingDays(rules, 2026)).toBe(261);
    expect(countWorkingDays({ workingDays: DEFAULT_WORKING_DAYS, holidays: ['2026-05-01', '2026-09-02'], compensated: [] }, 2026)).toBe(259);
  });
});

describe('a compensated day the server would refuse', () => {
  it('is found before anything is sent: on a holiday, and on an ordinary working weekday', () => {
    expect(validateCalendar(filled({ compensated: ['2026-05-09'] })).compensated).toBeUndefined();
    expect(validateCalendar(filled({ compensated: ['2026-05-08'] })).compensated).toBe('compensatedConflict');
    expect(validateCalendar(filled({ holidays: [{ date: '2026-05-09', name: 'x', basis: '' }], compensated: ['2026-05-09'] })).compensated).toBe('compensatedConflict');
  });

  it('follows the weekly rest days: a Friday make-up day is fine once Friday is a rest day', () => {
    expect(validateCalendar(filled({ workingDays: [1, 2, 3, 4], compensated: ['2026-05-08'] })).compensated).toBeUndefined();
  });

  it('reads the rules of the form for the grid', () => {
    expect(rulesOf(filled({ holidays: [{ date: '2026-05-01', name: 'x', basis: '' }, { date: '2026-09-02', name: 'x', basis: '' }] })).holidays).toEqual(['2026-05-01', '2026-09-02']);
  });
});

describe('describing a refusal', () => {
  it('lists the findings of CALENDAR_INVALID in the order of the server, and skips what is not a finding', () => {
    const view = describeProblem(problem('CALENDAR_INVALID', { errors: [{ field: 'holidays[1]', code: 'OUT_OF_YEAR', message: 'x' }, { field: 7 }, 'junk', { field: 'working_days', code: 'NO_WORKING_DAYS' }] }));
    expect(view).toEqual({
      reason: 'calendarInvalid',
      findings: [
        { field: 'holidays[1]', code: 'OUT_OF_YEAR' },
        { field: 'working_days', code: 'NO_WORKING_DAYS' },
      ],
    });
  });

  it.each([
    ['VERSION_CONFLICT', 'conflict'],
    ['STAGE_TRANSITION_DENIED', 'stage'],
    ['VALIDATION_FAILED', 'invalid'],
    ['INVALID_REQUEST', 'invalid'],
    ['FIELD_NOT_ALLOWED', 'invalid'],
    ['RESOURCE_NOT_FOUND', 'notFound'],
    ['SCOPE_DENIED', 'denied'],
    ['ENTITLEMENT_DENIED', 'denied'],
    ['SESSION_EXPIRED', 'session'],
    ['SOMETHING_ELSE', 'general'],
  ])('maps %s to %s', (code, reason) => {
    expect(describeProblem(problem(code))).toEqual({ reason, findings: [] });
  });

  it('says only "general" for a failure that is not an API error, and has no findings when `errors` is not a list', () => {
    expect(describeProblem(new Error('boom'))).toEqual({ reason: 'general', findings: [] });
    expect(describeProblem(problem('CALENDAR_INVALID', { errors: 'many' })).findings).toEqual([]);
  });
});
