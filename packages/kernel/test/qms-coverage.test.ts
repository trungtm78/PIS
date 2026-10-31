import { coverageRange, diaryCoverage, isCalendarDay } from '../src/qms-coverage';
import type { CoverageDiary } from '../src/qms-coverage';
import { singleYear } from '../src/working-time';
import type { WorkCalendarContent } from '../src/working-time';

const refusal = (run: () => unknown): { code: string; detail: string | undefined; status: number } => {
  try {
    run();
  } catch (error) {
    const known = error as { code: string; detail?: string; status: number };
    return { code: known.code, detail: known.detail, status: known.status };
  }
  throw new Error('it was allowed');
};

const calendar = (year: number, holidays: string[] = [], compensated: string[] = []): WorkCalendarContent => ({
  calendar_code: 'WORKDAY_VN',
  year,
  working_days: [1, 2, 3, 4, 5],
  holidays: holidays.map((date) => ({ date, name: 'holiday' })),
  compensated_workdays: compensated,
  legal_basis_ref: 'test',
});
const JUNE = singleYear(calendar(2026));
// June 2026 has 22 working days: Monday the 1st to Tuesday the 30th, no holiday.
const WORKING_JUNE = [1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 15, 16, 17, 18, 19, 22, 23, 24, 25, 26, 29, 30].map((day) => `2026-06-${String(day).padStart(2, '0')}`);
const diary = (date: string, status: string, overrides: Partial<CoverageDiary> = {}): CoverageDiary => ({ id: `id-${date}`, date, status, conflict: false, signedOn: status === 'DRAFT' ? undefined : date, ...overrides });

describe('the range of a coverage', () => {
  it('ends today and starts on the first of its month when no day is given', () => {
    expect(coverageRange(undefined, undefined, '2026-06-17')).toEqual({ from: '2026-06-01', to: '2026-06-17', through: '2026-06-17' });
    expect(coverageRange(undefined, '2026-05-20', '2026-06-17')).toEqual({ from: '2026-05-01', to: '2026-05-20', through: '2026-05-20' });
  });

  it('counts through the end of the range, or through today when the range reaches past it, and nothing of a range wholly ahead', () => {
    expect(coverageRange('2026-06-01', '2026-06-30', '2026-07-05').through).toBe('2026-06-30');
    expect(coverageRange('2026-06-01', '2026-06-30', '2026-06-10').through).toBe('2026-06-10');
    expect(coverageRange('2026-06-11', '2026-06-30', '2026-06-10').through).toBeUndefined();
  });

  it('refuses a day that is not one, a start after the end and more than a year (422 naming the field)', () => {
    expect(refusal(() => coverageRange('2026-06-31', '2026-06-30', '2026-07-01'))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'from', status: 422 });
    expect(refusal(() => coverageRange('2026-06-01', '30/06/2026', '2026-07-01')).detail).toBe('to');
    expect(refusal(() => coverageRange('2026-06-02', '2026-06-01', '2026-07-01')).detail).toBe('from');
    expect(refusal(() => coverageRange(undefined, '2026-13-01', '2026-07-01')).detail).toBe('to');
    expect(() => coverageRange('2025-06-30', '2026-06-30', '2026-07-01')).not.toThrow();
    expect(refusal(() => coverageRange('2025-06-29', '2026-06-30', '2026-07-01')).detail).toBe('to');
    expect(isCalendarDay('2026-02-29')).toBe(false);
    expect(isCalendarDay('2028-02-29')).toBe(true);
  });
});

describe('UAT-AC364: the coverage of a month', () => {
  // 18 working days have a main diary: 15 signed and 3 in DRAFT; 4 are missing; 2 of the diaries still have a copy that nobody settled.
  const missing = new Set(['2026-06-04', '2026-06-11', '2026-06-18', '2026-06-25']);
  const drafts = new Set(['2026-06-05', '2026-06-12', '2026-06-19']);
  const diaries = WORKING_JUNE.filter((date) => !missing.has(date)).map((date) => diary(date, drafts.has(date) ? 'DRAFT' : 'LOCKED', { conflict: date === '2026-06-08' || date === '2026-06-09' }));
  const range = coverageRange('2026-06-01', '2026-06-30', '2026-07-01');

  it('splits the 22 working days into 15 signed, 3 draft and 4 missing, and counts the 2 conflicts apart', () => {
    const { totals, days } = diaryCoverage(range, JUNE, diaries);
    expect(totals).toEqual({ workingDays: 22, withDiary: 18, signed: 15, draft: 3, missing: 4, late: 0, conflict: 2 });
    expect(totals.signed + totals.draft + totals.missing).toBe(totals.workingDays);
    expect(days).toHaveLength(22);
    expect(days.filter((day) => day.state === 'MISSING').map((day) => day.date)).toEqual([...missing]);
    expect(days.filter((day) => day.conflict).map((day) => day.date)).toEqual(['2026-06-08', '2026-06-09']);
    expect(days.find((day) => day.date === '2026-06-12')).toMatchObject({ state: 'DRAFT', status: 'DRAFT', signedOn: null, workingDaysToSign: null, lateDays: 0 });
  });

  it('shows a diary signed afterwards on a missing day with its late days, and one fewer missing', () => {
    const made = diary('2026-06-04', 'CONTRACTOR_SIGNED', { signedOn: '2026-06-10' });
    const { totals, days } = diaryCoverage(range, JUNE, [...diaries, made]);
    expect(totals).toMatchObject({ missing: 3, signed: 16, late: 1 });
    // The 5th, 8th, 9th and 10th are the four working days after the 4th: three beyond the one allowed.
    expect(days.find((day) => day.date === '2026-06-04')).toMatchObject({ state: 'SIGNED', signedOn: '2026-06-10', workingDaysToSign: 4, lateDays: 3 });
  });

  it('is on time when the contractor signs the same day or the next working day, over a weekend as well', () => {
    const cases: Array<[string, string, number]> = [
      ['2026-06-02', '2026-06-02', 0],
      ['2026-06-02', '2026-06-03', 1],
      ['2026-06-05', '2026-06-08', 1],
      ['2026-06-05', '2026-06-09', 2],
    ];
    for (const [date, signedOn, toSign] of cases) {
      const found = diaryCoverage(coverageRange(date, date, '2026-07-01'), JUNE, [diary(date, 'SUPERVISED', { signedOn })]);
      expect(found.days[0]).toMatchObject({ workingDaysToSign: toSign, lateDays: Math.max(0, toSign - 1) });
      expect(found.totals.late).toBe(toSign > 1 ? 1 : 0);
    }
  });

  it('does not call a diary late whose signature day is not known, and a signature before the day counts as none', () => {
    const found = diaryCoverage(coverageRange('2026-06-02', '2026-06-02', '2026-07-01'), JUNE, [diary('2026-06-02', 'LOCKED', { signedOn: undefined })]);
    expect(found.days[0]).toMatchObject({ state: 'SIGNED', signedOn: null, workingDaysToSign: null, lateDays: 0 });
    const early = diaryCoverage(coverageRange('2026-06-02', '2026-06-02', '2026-07-01'), JUNE, [diary('2026-06-02', 'LOCKED', { signedOn: '2026-06-01' })]);
    expect(early.days[0]).toMatchObject({ workingDaysToSign: 0, lateDays: 0 });
  });

  it('counts only what is ahead of today as not yet due, ignores a diary on a day off, and never counts a day off as missing', () => {
    const upToTenth = diaryCoverage(coverageRange('2026-06-01', '2026-06-30', '2026-06-10'), JUNE, diaries);
    expect(upToTenth.totals.workingDays).toBe(8);
    expect(upToTenth.days.at(-1)?.date).toBe('2026-06-10');
    const onWeekend = diaryCoverage(range, JUNE, [...diaries, diary('2026-06-06', 'LOCKED')]);
    expect(onWeekend.totals).toEqual(diaryCoverage(range, JUNE, diaries).totals);
    const ahead = diaryCoverage(coverageRange('2026-06-11', '2026-06-30', '2026-06-10'), JUNE, diaries);
    expect(ahead).toEqual({ days: [], totals: { workingDays: 0, withDiary: 0, signed: 0, draft: 0, missing: 0, late: 0, conflict: 0 } });
  });

  it('follows the calendar: a holiday is not a working day and a compensated Saturday is', () => {
    const calendars = singleYear(calendar(2026, ['2026-06-03'], ['2026-06-06']));
    const found = diaryCoverage(range, calendars, []);
    expect(found.totals).toMatchObject({ workingDays: 22, missing: 22 });
    expect(found.days.map((day) => day.date)).not.toContain('2026-06-03');
    expect(found.days.map((day) => day.date)).toContain('2026-06-06');
  });

  it('refuses a year that has no published calendar (422 CALENDAR_NOT_EFFECTIVE)', () => {
    expect(refusal(() => diaryCoverage(coverageRange('2026-12-30', '2027-01-04', '2027-02-01'), JUNE, []))).toMatchObject({ code: 'CALENDAR_NOT_EFFECTIVE', status: 422 });
  });
});
