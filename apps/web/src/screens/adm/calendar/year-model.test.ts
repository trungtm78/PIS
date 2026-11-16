import { describe, expect, it } from 'vitest';
import { LUNAR_DAYS, VERIFIED } from './holiday-catalogue';
import { calendarBody, emptyValues, toCalendar, validateCalendar } from './model';
import type { CalendarValues, CalendarView } from './model';
import { addSpecial, applyPreset, datesBetween, groupByMonth, openingVersion, removeEntry, restDaysOf, setEntryText, specialEntries, specialProblem, toggleRestDay, workingDaysByMonth, yearRows } from './year-model';

const blank = (year = 2027, changes: Partial<CalendarValues> = {}): CalendarValues => ({ ...emptyValues(year), calendarCode: 'WORKDAY_VN', legalBasis: 'Labour Code 2019 art. 112', ...changes });

const version = (id: string, year: number, revision: number, status: string, code = 'WORKDAY_VN'): CalendarView =>
  toCalendar({ id, calendar_code: code, year, revision, working_days: [1, 2, 3, 4, 5], holidays: [], compensated_workdays: [], legal_basis_ref: 'x', status, created_by: 'u', published_by: null, published_at: null, version: 1 }) as CalendarView;

describe('weekly rest days', () => {
  it('lists the weekdays the calendar does not work, and toggles one', () => {
    expect(restDaysOf([1, 2, 3, 4, 5])).toEqual([6, 7]);
    expect(toggleRestDay(blank(), 5).workingDays).toEqual([1, 2, 3, 4]);
    expect(toggleRestDay(toggleRestDay(blank(), 5), 5).workingDays).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('adding days by range', () => {
  it('adds every day of a range as a holiday with the same note, and shows them as one row', () => {
    const { values, added } = addSpecial(blank(), { kind: 'off', from: '2027-02-05', to: '2027-02-09', name: 'Tết Nguyên đán', basis: '' });
    expect(added).toBe(5);
    const entries = specialEntries(values);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'off', from: '2027-02-05', to: '2027-02-09', name: 'Tết Nguyên đán' });
    expect(entries[0]?.dates).toHaveLength(5);
  });

  it('adds one day when the end is empty, and replaces what the day was (a day cannot be a holiday and a make-up day)', () => {
    const start = blank(2027, { compensated: ['2027-02-13'] });
    const { values } = addSpecial(start, { kind: 'off', from: '2027-02-13', to: '', name: 'Nghỉ', basis: 'b' });
    expect(values.compensated).toEqual([]);
    expect(values.holidays).toEqual([{ date: '2027-02-13', name: 'Nghỉ', basis: 'b' }]);
  });

  it('accepts a make-up day only on a weekly rest day that is not a holiday, and counts what it skipped', () => {
    const start = blank(2027, { holidays: [{ date: '2027-02-06', name: 'x', basis: '' }] });
    // 2027-02-05 is a Friday, 02-06 a Saturday (a holiday here), 02-07 a Sunday, 02-08 a Monday.
    const result = addSpecial(start, { kind: 'work', from: '2027-02-05', to: '2027-02-08', name: '', basis: '' });
    expect(result.values.compensated).toEqual(['2027-02-07']);
    expect(result).toMatchObject({ added: 1, skippedWorking: 2, skippedHoliday: 1 });
    expect(validateCalendar(result.values).compensated).toBeUndefined();
  });

  it('refuses what cannot be added before adding it', () => {
    const base = { kind: 'off' as const, name: 'x', basis: '' };
    expect(specialProblem(2027, { ...base, from: '', to: '' })).toBe('dateRequired');
    expect(specialProblem(2027, { ...base, from: '2027-02-30', to: '' })).toBe('dateInvalid');
    expect(specialProblem(2027, { ...base, from: '2027-02-09', to: '2027-02-05' })).toBe('rangeOrder');
    expect(specialProblem(2027, { ...base, from: '2026-12-31', to: '' })).toBe('outOfYear');
    expect(specialProblem(2027, { ...base, from: '2027-01-01', to: '2027-12-31' })).toBe('tooLong');
    expect(specialProblem(2027, { ...base, name: ' ', from: '2027-02-05', to: '' })).toBe('nameRequired');
    expect(specialProblem(2027, { ...base, kind: 'work', name: '', from: '2027-02-07', to: '' })).toBeUndefined();
    expect(specialProblem(2027, { ...base, from: '2027-02-05', to: '2027-02-09' })).toBeUndefined();
  });

  it('lists a range of dates inclusive', () => {
    expect(datesBetween('2027-02-27', '2027-03-02')).toEqual(['2027-02-27', '2027-02-28', '2027-03-01', '2027-03-02']);
  });
});

describe('the table of special days', () => {
  it('merges consecutive days with the same note and keeps a different note apart, in date order', () => {
    const values = blank(2027, {
      holidays: [
        { date: '2027-02-09', name: 'Tết', basis: '' },
        { date: '2027-02-08', name: 'Tết', basis: '' },
        { date: '2027-02-10', name: 'Nghỉ bù', basis: '' },
        { date: '2027-04-16', name: 'Giỗ Tổ', basis: '' },
      ],
      compensated: ['2027-02-14', '2027-02-13'],
    });
    expect(specialEntries(values).map((entry) => [entry.kind, entry.from, entry.to])).toEqual([
      ['off', '2027-02-08', '2027-02-09'],
      ['off', '2027-02-10', '2027-02-10'],
      ['work', '2027-02-13', '2027-02-14'],
      ['off', '2027-04-16', '2027-04-16'],
    ]);
  });

  it('groups the rows by the month of their first day', () => {
    const values = blank(2027, { holidays: [{ date: '2027-01-01', name: 'a', basis: '' }, { date: '2027-04-30', name: 'b', basis: '' }, { date: '2027-04-16', name: 'c', basis: '' }] });
    expect(groupByMonth(specialEntries(values)).map((group) => [group.month, group.entries.length])).toEqual([[1, 1], [4, 2]]);
  });

  it('removes a whole row and writes a note onto every day of it', () => {
    const { values } = addSpecial(blank(), { kind: 'off', from: '2027-02-05', to: '2027-02-07', name: 'Tết', basis: '' });
    const [entry] = specialEntries(values);
    const renamed = setEntryText(values, entry!, 'name', 'Tết Đinh Mùi');
    expect(renamed.holidays.map((one) => one.name)).toEqual(['Tết Đinh Mùi', 'Tết Đinh Mùi', 'Tết Đinh Mùi']);
    expect(removeEntry(renamed, specialEntries(renamed)[0]!).holidays).toEqual([]);
  });
});

describe('the working days of each month', () => {
  it('counts weekdays, less holidays, plus make-up days, month by month', () => {
    const rules = { workingDays: [1, 2, 3, 4, 5], holidays: ['2026-05-01'], compensated: ['2026-05-09'] };
    const counts = workingDaysByMonth(rules, 2026);
    expect(counts).toHaveLength(12);
    expect(counts[0]).toBe(22);
    expect(counts[4]).toBe(21);
    expect(counts.reduce((sum, one) => sum + one, 0)).toBe(261);
  });
});

describe('the preset of the statutory holidays', () => {
  it('is flagged as not verified, and names its source in the legal basis it fills in', () => {
    expect(VERIFIED).toBe(false);
    const result = applyPreset(blank(2027, { legalBasis: '' }));
    expect(result.verified).toBe(false);
    expect(result.values.legalBasis).toContain('Điều 112');
    expect(result.values.legalBasis).toContain('chưa kiểm chứng');
    expect(validateCalendar(result.values)).toEqual({});
  });

  it('fills the fixed days, the lunar days the catalogue knows, and makes up a holiday that falls on a rest day', () => {
    const { values, missing } = applyPreset(blank(2027));
    const on = (date: string) => values.holidays.find((holiday) => holiday.date === date);
    expect(on('2027-01-01')?.name).toBe('Tết Dương lịch');
    expect(on('2027-04-30')?.name).toBe('Ngày Chiến thắng 30/4');
    expect(on('2027-09-02')?.name).toBe('Quốc khánh');
    expect(on('2027-09-01')?.name).toBe('Quốc khánh');
    expect(on('2027-04-16')?.name).toBe('Giỗ Tổ Hùng Vương');
    // Five days of Tết: the day before the first and the first four, 2027-02-05 to 2027-02-09.
    expect(['2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09'].map((date) => on(date)?.name)).toEqual(Array(5).fill('Tết Nguyên đán'));
    expect(missing).toEqual([]);
    // 2027-05-01 is a Saturday: the next working day, Monday 2027-05-03, is the make-up day.
    expect(on('2027-05-01')?.name).toBe('Ngày Quốc tế lao động');
    expect(on('2027-05-03')?.name).toBe('Nghỉ bù Ngày Quốc tế lao động');
    // The server accepts every day it wrote.
    expect(validateCalendar(values)).toEqual({});
    expect(new Set(values.holidays.map((holiday) => holiday.date)).size).toBe(values.holidays.length);
  });

  it('says which holidays it has no day for when the year is not in the catalogue', () => {
    expect(LUNAR_DAYS[2040]).toBeUndefined();
    const { values, missing } = applyPreset(blank(2040));
    expect(missing).toEqual(['Tết Nguyên đán', 'Giỗ Tổ Hùng Vương']);
    expect(values.holidays.some((holiday) => holiday.name === 'Tết Dương lịch')).toBe(true);
  });

  it('never overwrites what the person wrote, and a second run adds nothing', () => {
    const edited = blank(2027, { holidays: [{ date: '2027-01-01', name: 'Tên do người dùng sửa', basis: '' }] });
    const first = applyPreset(edited);
    expect(first.values.holidays.find((holiday) => holiday.date === '2027-01-01')?.name).toBe('Tên do người dùng sửa');
    const second = applyPreset(first.values);
    expect(second.added).toBe(0);
    expect(second.values.holidays).toHaveLength(first.values.holidays.length);
  });

  it('makes up on the days of the weekly rest the form has, not on fixed Saturdays and Sundays', () => {
    // With Saturday worked, 2027-05-01 (a Saturday) is an ordinary working day: it is a holiday and no make-up day is needed.
    const { values } = applyPreset(blank(2027, { workingDays: [1, 2, 3, 4, 5, 6] }));
    expect(values.holidays.find((holiday) => holiday.date === '2027-05-01')).toBeDefined();
    expect(values.holidays.some((holiday) => holiday.name === 'Nghỉ bù Ngày Quốc tế lao động')).toBe(false);
  });

  it('writes a body the server accepts', () => {
    const { values } = applyPreset(blank(2026, { calendarCode: 'WORKDAY_VN' }));
    expect(calendarBody(values).holidays.length).toBeGreaterThan(8);
    expect(validateCalendar(values)).toEqual({});
  });
});

describe('the year list', () => {
  it('has one row for each year of each calendar and an empty row for a year without a version, newest year first', () => {
    const rows = yearRows([version('a', 2026, 1, 'Published'), version('b', 2026, 2, 'Draft'), version('c', 2025, 1, 'Published', 'OTHER')], 'WORKDAY_VN', [2026, 2027]);
    expect(rows.map((row) => [row.year, row.code])).toEqual([[2027, 'WORKDAY_VN'], [2026, 'WORKDAY_VN'], [2025, 'OTHER']]);
    expect(rows[0]).toMatchObject({ confirmed: undefined, draft: undefined, versions: [] });
    expect(rows[1]?.confirmed?.id).toBe('a');
    expect(rows[1]?.draft?.id).toBe('b');
  });

  it('ignores a draft older than a revision that was confirmed or replaced: the server refuses it', () => {
    const rows = yearRows([version('a', 2026, 1, 'Draft'), version('b', 2026, 2, 'Superseded'), version('c', 2026, 3, 'Published')], 'WORKDAY_VN', []);
    expect(rows[0]?.draft).toBeUndefined();
    expect(rows[0]?.confirmed?.id).toBe('c');
  });

  it('opens a year on its draft, else on the version in force, else on nothing', () => {
    const [open] = yearRows([version('a', 2026, 1, 'Published'), version('b', 2026, 2, 'Draft')], 'WORKDAY_VN', []);
    expect(openingVersion(open!)?.id).toBe('b');
    const [confirmedOnly] = yearRows([version('a', 2026, 1, 'Published')], 'WORKDAY_VN', []);
    expect(openingVersion(confirmedOnly!)?.id).toBe('a');
    const [none] = yearRows([], 'WORKDAY_VN', [2027]);
    expect(openingVersion(none!)).toBeUndefined();
  });
});
