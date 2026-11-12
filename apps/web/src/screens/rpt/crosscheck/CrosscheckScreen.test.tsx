import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { ApiError } from '@machvon/api-client';
import { afterEach, describe, expect, it } from 'vitest';
import CrosscheckScreen from './CrosscheckScreen';
import { AS_OF, harness, mount, routeOf } from '../test/support';
import { differenceText, draftFromSearch, figureText, periodFromSearch, reasonProblem, refusalOf, sortFindings } from './model';
import type { Crosscheck, Finding } from './model';

afterEach(cleanup);

const route = routeOf('RPT-09', 'CN.04');
const FP = (letter: string): string => letter.repeat(64);
const DRAFT = '00000000-0000-4000-8000-0000000000d1';
const READ = ['rpt.read', 'rpt.crosscheck.read'];
const EXPLAIN = [...READ, 'rpt.crosscheck.explain'];

const term = (over: Record<string, unknown> = {}) => ({ role: 'PVN_QUARTERLY', layout_code: 'PVN-QUARTERLY-F2', ref: { kind: 'DRAFT', id: DRAFT, revision: null }, period_code: '2026-Q4', code: 'ENT_EXECUTED_PERIOD', row_key: null, value: '600000000', source: 'Số liệu đã điền vào báo cáo lúc lập (kỳ 2026-Q4)', as_of: '2026-12-31', ...over });

const finding = (over: Record<string, unknown> = {}): Finding =>
  ({
    rule_id: 'XR-01',
    rule_name: 'Ba tháng bằng quý',
    severity: 'BLOCKING',
    code: 'ENT_EXECUTED_PERIOD',
    period_code: '2026-Q4',
    formula: 'Số phát sinh của quý ENT_EXECUTED_PERIOD = tổng số của 3 tháng trong kỳ',
    expected: '1800000000',
    actual: '600000000',
    difference: '-1200000000',
    tolerance: '0',
    unit: 'VND',
    terms: [term(), term({ role: 'PVN_MONTHLY', layout_code: 'PVN-MONTHLY', ref: { kind: 'DRAFT', id: 'm10', revision: null }, period_code: '2026-M10', value: '600000000' })],
    units: null,
    involves: [DRAFT, 'm10'],
    path: [{ step: 'REGENERATE_REPORT', layout_code: 'PVN-QUARTERLY-F2', ref: DRAFT }, { step: 'CHECK_SOURCE' }, { step: 'EXPLAIN' }],
    fingerprint: FP('a'),
    status: 'OPEN',
    explanation: null,
    blocks_release: true,
    can_explain: true,
    ...over,
  }) as Finding;

const answer = (over: Partial<Crosscheck> = {}): Crosscheck =>
  ({
    period_code: '2026-Q4',
    rule: { code: 'DEFAULT', version: 0, source: 'DEFAULT', unverified: true, formula: 'x', origin: 'y', as_of: '2026-11-09' },
    reports: [
      { role: 'PVN_QUARTERLY', layout_code: 'PVN-QUARTERLY-F2', ref: { kind: 'DRAFT', id: DRAFT, revision: null }, period_code: '2026-Q4', state: 'APPROVED', data_source: 'LIVE', has_figures: true, snapshot_id: 's1', snapshot_revision: 2 },
      { role: 'SNAPSHOT', layout_code: 'SNAPSHOT', ref: { kind: 'SNAPSHOT', id: 's1', revision: 2 }, period_code: '2026-Q4', state: null, data_source: 'LIVE', has_figures: true, snapshot_id: 's1', snapshot_revision: 2 },
    ],
    findings: [finding()],
    skipped: [{ rule_id: 'XR-01', reason: 'MISSING_REPORT', role: 'PVN_MONTHLY', layout_code: 'PVN-MONTHLY', period_code: '2026-M11', code: null, text: 'Chưa có báo cáo PVN_MONTHLY cho kỳ 2026-M11.' }],
    coverage: { reports: 2, usable: 2, rules_run: 6, comparisons: 40, skipped: 1 },
    sha256: FP('b'),
    gate: { draft_id: DRAFT, blocking_open: 1, blocking_explained: 0, warnings: 0, passed: false },
    can_explain: true,
    as_of: AS_OF,
    ...over,
  }) as Crosscheck;

describe('the model of RPT-09', () => {
  it('reads the period of the address and falls back to the month or quarter it is now', () => {
    const now = new Date('2026-11-09T03:00:00Z');
    expect(periodFromSearch(new URLSearchParams('kind=QUARTER&year=2026&index=4'), now)).toEqual({ kind: 'QUARTER', year: 2026, index: 4 });
    expect(periodFromSearch(new URLSearchParams('kind=QUARTER&year=2026&index=5'), now)).toEqual({ kind: 'QUARTER', year: 2026, index: 4 });
    expect(periodFromSearch(new URLSearchParams('kind=MONTH&year=2026&index=12'), now)).toEqual({ kind: 'MONTH', year: 2026, index: 12 });
    expect(periodFromSearch(new URLSearchParams(''), now)).toEqual({ kind: 'MONTH', year: 2026, index: 11 });
    expect(draftFromSearch(new URLSearchParams(`draft=${DRAFT}`))).toBe(DRAFT);
    expect(draftFromSearch(new URLSearchParams('draft=nope'))).toBeUndefined();
  });

  it('writes whole numbers with the separator, rates in percent, an absent number as a dash, and the sign of a difference', () => {
    expect(figureText('1234567890', 'VND', '.')).toBe('1.234.567.890');
    expect(figureText('-1200', 'VND', ',')).toBe('-1,200');
    expect(figureText('45.0667', 'PCT', '.')).toBe('45.0667 %');
    expect(figureText(null, 'VND', '.')).toBe('–');
    expect(differenceText('5', 'VND', '.')).toBe('+5');
    expect(differenceText('-5', 'VND', '.')).toBe('-5');
    expect(differenceText('0', 'COUNT', '.')).toBe('0');
  });

  it('judges the reason the way the server does and puts the findings that stop the draft first', () => {
    expect(reasonProblem('short')).toBe('short');
    expect(reasonProblem(' x'.repeat(20))).toBe('edges');
    expect(reasonProblem('a'.repeat(2001))).toBe('long');
    expect(reasonProblem('A good reason that is long enough.')).toBeUndefined();
    const warning = finding({ fingerprint: FP('c'), severity: 'WARNING', blocks_release: false });
    const explained = finding({ fingerprint: FP('d'), status: 'EXPLAINED', blocks_release: false });
    const other = finding({ fingerprint: FP('e'), blocks_release: false });
    expect(sortFindings([explained, warning, other, finding()]).map((one) => one.fingerprint)).toEqual([FP('a'), FP('e'), FP('c'), FP('d')]);
  });

  it('reads a refusal into its code and the count of blocking differences', () => {
    expect(refusalOf(new ApiError({ status: 409, code: 'REPORT_CROSSCHECK_BLOCKED', title: 't', extensions: { blocking_count: 3 } } as never))).toMatchObject({ code: 'REPORT_CROSSCHECK_BLOCKED', blocking: 3 });
    expect(refusalOf(new Error('x'))).toEqual({ code: 'UNKNOWN', status: 0, blocking: undefined });
  });
});

describe('RPT-09, the comparison of the reports of a period', () => {
  const path = `/rpt/rpt-09?kind=QUARTER&year=2026&index=4&draft=${DRAFT}`;

  it('UAT-RPT-ENT4A-1: asks for the period and the draft, shows the coverage, the gate, the numbers and where each came from', async () => {
    const h = harness(() => answer());
    mount(<CrosscheckScreen route={route} />, h, { permissions: EXPLAIN, path });
    expect(await screen.findByTestId('coverage')).toBeTruthy();
    expect(h.read).toHaveBeenCalledWith('getReportCrosscheck', expect.objectContaining({ query: { kind: 'QUARTER', year: 2026, index: 4, draft_id: DRAFT } }));
    expect(screen.getByTestId('gate').textContent).toContain('1');
    expect(screen.getByTestId('rule-unverified')).toBeTruthy();
    const card = screen.getByTestId('finding-aaaaaaaa');
    expect(card.textContent).toContain('1.800.000.000');
    expect(card.textContent).toContain('-1.200.000.000');
    expect(screen.getByTestId('formula').textContent).toContain('ENT_EXECUTED_PERIOD');
    expect(card.textContent).toContain('2026-M10');
    expect(card.textContent).toContain('Số liệu đã điền vào báo cáo');
    expect(screen.getByText(/Chưa có báo cáo PVN_MONTHLY/)).toBeTruthy();
    expect(screen.queryByTestId('nothing-compared')).toBeNull();
  });

  it('says plainly when nothing was compared, instead of looking like a pass', async () => {
    const h = harness(() => answer({ findings: [], gate: null, coverage: { reports: 1, usable: 0, rules_run: 6, comparisons: 0, skipped: 5 } }));
    mount(<CrosscheckScreen route={route} />, h, { permissions: READ, path: '/rpt/rpt-09?kind=QUARTER&year=2026&index=4' });
    expect(await screen.findByTestId('nothing-compared')).toBeTruthy();
    expect(screen.getByTestId('no-findings').textContent).toMatch(/Chưa có phép so sánh/);
    expect(screen.queryByTestId('gate')).toBeNull();
  });

  it('keeps the explanation form from a reader who cannot explain, and from a preparer of one of the reports', async () => {
    const h = harness(() => answer({ findings: [finding({ can_explain: false })], can_explain: false }));
    mount(<CrosscheckScreen route={route} />, h, { permissions: READ, path });
    expect(await screen.findByTestId('cannot-explain')).toBeTruthy();
    expect(screen.queryByTestId('explain-form')).toBeNull();
  });

  it('sends the explanation for the fingerprint with the period, and only with a reason that is long enough', async () => {
    const h = harness(
      () => answer(),
      () => ({ outcome: 'CREATED', explanation: {} }),
    );
    mount(<CrosscheckScreen route={route} />, h, { permissions: EXPLAIN, path });
    await screen.findByTestId('explain-form');
    fireEvent.change(screen.getByTestId('explain-reason'), { target: { value: 'too short' } });
    fireEvent.click(screen.getByTestId('explain-submit'));
    expect(screen.getByTestId('explain-problem')).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('explain-reason'), { target: { value: 'The Treasury corrected the months after the quarter was filled.' } });
    fireEvent.click(screen.getByTestId('explain-submit'));
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    expect(h.command.mock.calls[0]?.[0]).toBe('explainCrosscheckFinding');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { period: { kind: 'QUARTER', year: 2026, index: 4 }, fingerprint: FP('a'), reason: 'The Treasury corrected the months after the quarter was filled.' } });
  });

  it('shows who explained a difference and why, and no form for it', async () => {
    const explained = finding({ status: 'EXPLAINED', blocks_release: false, explanation: { id: 'e1', fingerprint: FP('a'), rule_id: 'XR-01', figure_code: 'ENT_EXECUTED_PERIOD', period_code: '2026-Q4', severity: 'BLOCKING', involves: [], reason: 'Corrected by the Treasury.', explained_by: 'u1', explained_by_name: 'Nguyen Van B', created_at: '2026-12-20T03:00:00.000Z' } });
    const h = harness(() => answer({ findings: [explained], gate: { draft_id: DRAFT, blocking_open: 0, blocking_explained: 1, warnings: 0, passed: true } }));
    mount(<CrosscheckScreen route={route} />, h, { permissions: EXPLAIN, path });
    const given = await screen.findByTestId('explanation');
    expect(given.textContent).toContain('Nguyen Van B');
    expect(given.textContent).toContain('Corrected by the Treasury.');
    expect(screen.queryByTestId('explain-form')).toBeNull();
    expect(screen.getByTestId('gate').textContent).toMatch(/không bị số lệch nào chặn/);
  });

  it('names the unit subtotals and the rows with no unit for the unit-sum rule', async () => {
    const unitSum = finding({ rule_id: 'XR-05', units: [{ unit: 'Unit A', sum: '1000' }], path: [{ step: 'ASSIGN_UNIT', layout_code: 'PVN-QUARTERLY-F2', rows: ['P3'] }, { step: 'EXPLAIN' }] });
    const h = harness(() => answer({ findings: [unitSum] }));
    mount(<CrosscheckScreen route={route} />, h, { permissions: EXPLAIN, path });
    expect((await screen.findByTestId('unit-sums')).textContent).toContain('Unit A: 1.000');
    expect(screen.getByTestId('finding-aaaaaaaa').textContent).toContain('P3');
  });

  it('changes the period in the address when another one is chosen', async () => {
    const h = harness(() => answer());
    mount(<CrosscheckScreen route={route} />, h, { permissions: READ, path: '/rpt/rpt-09?kind=QUARTER&year=2026&index=4' });
    await screen.findByTestId('coverage');
    fireEvent.change(screen.getByTestId('period-kind'), { target: { value: 'MONTH' } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('getReportCrosscheck', expect.objectContaining({ query: { kind: 'MONTH', year: 2026, index: 4 } })));
  });
});
