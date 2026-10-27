import { describe, expect, it } from 'vitest';
import { currentRevisionId, defaultWeek, pairedRates, proposalsOf, slowLines, weeksOf } from './weekly-model';
import type { ObligationView, ReportField, ReportView } from './types';

const obligation = (period: string, due: string, overrides: Partial<ObligationView> = {}): ObligationView =>
  ({ reportId: `r-${period}`, formCode: 'CV3665-WEEKLY', periodLabel: period, dueDate: due, status: 'DRAFT', ...overrides }) as ObligationView;

const field = (key: string, kind: ReportField['kind'], source: ReportField['source'], value: ReportField['value'], locked = source !== null): ReportField => ({ key, label: key, kind, required: false, locked, source, value });

const report = (fields: ReportField[]): Pick<ReportView, 'fields'> => ({ fields });

describe('the weeks of the weekly quick report (ST-MNE-005, MNE-07)', () => {
  it('keeps the weekly form only and orders the weeks by their due date, the latest first', () => {
    const half = obligation('H1-2026', '2026-07-10', { formCode: 'TT44-M02' });
    const weeks = weeksOf([obligation('W2026-39', '2026-09-25'), half, obligation('W2026-41', '2026-10-09'), obligation('W2026-40', '2026-10-02')]);
    expect(weeks.map((week) => week.periodLabel)).toEqual(['W2026-41', 'W2026-40', 'W2026-39']);
    expect(weeksOf([half])).toEqual([]);
  });

  it('opens on the latest week that is due by today, the earliest one when none is yet, and none when there are no weeks', () => {
    const weeks = weeksOf([obligation('W2026-39', '2026-09-25'), obligation('W2026-40', '2026-10-02'), obligation('W2026-41', '2026-10-09')]);
    expect(defaultWeek(weeks, '2026-10-05')?.periodLabel).toBe('W2026-40');
    expect(defaultWeek(weeks, '2026-10-02')?.periodLabel).toBe('W2026-40');
    expect(defaultWeek(weeks, '2026-09-01')?.periodLabel).toBe('W2026-39');
    expect(defaultWeek(weeks, '2027-01-01')?.periodLabel).toBe('W2026-41');
    expect(defaultWeek([], '2026-10-05')).toBeUndefined();
  });
});

describe('the revision that stands for the week (ST-MNE-005 review: a correction supersedes the report the calendar lists)', () => {
  const line = (id: string, revision: number) => ({ id, revision, status: 'ISSUED' });
  it('is the latest revision of the chain, and the report itself when it is the latest or has no history', () => {
    expect(currentRevisionId({ id: 'r1', history: [line('r1', 1), line('r3', 3), line('r2', 2)] })).toBe('r3');
    expect(currentRevisionId({ id: 'r2', history: [line('r1', 1), line('r2', 2)] })).toBe('r2');
    expect(currentRevisionId({ id: 'r1', history: [] })).toBe('r1');
  });
});

describe('the two rates and the slow projects of a weekly report (AC-ST-MNE-005-1, UAT-AC291)', () => {
  const metric = (name: string) => ({ kind: 'SNAPSHOT_METRIC' as const, detail: name });

  it('reads the two rates as the pair of DIS-19, with the sums they come from, and never one without the other', () => {
    const pair = pairedRates(
      report([field('a', 'PERCENT', metric('rate_pm_pct'), '60.0000'), field('b', 'PERCENT', metric('rate_total_pct'), '48.0000'), field('c', 'MONEY', metric('plan_total_vnd'), '1250000000000'), field('d', 'MONEY', metric('disbursed_treasury_vnd'), '750000000000')]),
    );
    expect(pair).toEqual({ pm: '60.0000', total: '48.0000', plan: '1250000000000', disbursed: '750000000000' });
  });

  it('says a rate has no figure when the report has none (a snapshot not attached, or nothing to divide by), and does not make it zero', () => {
    expect(pairedRates(report([field('a', 'PERCENT', metric('rate_pm_pct'), null), field('b', 'PERCENT', metric('rate_total_pct'), '48.0000')]))).toEqual({ pm: null, total: '48.0000', plan: null, disbursed: null });
    expect(pairedRates(report([]))).toEqual({ pm: null, total: null, plan: null, disbursed: null });
  });

  it('reads the slow projects as one line each, and nothing when the cell is empty or the form does not have it', () => {
    const slow = field('slow', 'TEXT', { kind: 'SLOW_PROJECTS', detail: '5' }, '1. DA-1 - A; lãnh đạo phụ trách: X; chậm 35.5000 điểm so với kỳ vọng\n2. DA-2 - B; lãnh đạo phụ trách: chưa phân công; chậm 12.0000 điểm so với kỳ vọng');
    expect(slowLines(report([slow]))).toEqual(['1. DA-1 - A; lãnh đạo phụ trách: X; chậm 35.5000 điểm so với kỳ vọng', '2. DA-2 - B; lãnh đạo phụ trách: chưa phân công; chậm 12.0000 điểm so với kỳ vọng']);
    expect(slowLines(report([{ ...slow, value: null }]))).toBeNull();
    expect(slowLines(report([]))).toBeNull();
  });

  it('reads the proposals as the text cells that are written by hand, the empty ones left out', () => {
    expect(proposalsOf(report([field('slow', 'TEXT', { kind: 'SLOW_PROJECTS', detail: '5' }, 'x'), field('proposals', 'TEXT', null, 'Speed up the payment.', false), field('other', 'TEXT', null, null, false), field('n', 'INTEGER', { kind: 'PROJECT_COUNT', detail: null }, 3)]))).toEqual([
      { key: 'proposals', label: 'proposals', text: 'Speed up the payment.' },
    ]);
  });
});
