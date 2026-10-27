import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import WeeklyQuickScreen from './WeeklyQuickScreen';
import { READER, harness, mount, obligationRow, routeOf } from './test-support';
import type { Harness } from './test-support';

const ROUTE = routeOf('MNE-07', 'FR-MNE-07');
const REPORT_40 = '00000000-0000-4000-8000-000000000340';
const REPORT_41 = '00000000-0000-4000-8000-000000000341';
const SNAPSHOT = '00000000-0000-4000-8000-0000000000f2';

const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);
const failure = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });
const page = (items: unknown[]) => ({ items, next_cursor: null, as_of: '2026-10-05' });

const week = (n: number, period: string, due: string, reportId: string, overrides: Record<string, unknown> = {}) =>
  obligationRow(n, { mne_report_id: reportId, rule_code: 'WEEKLY_QUICK', reporting_role: 'PROVINCIAL_PEOPLE_COMMITTEE', form_code: 'CV3665-WEEKLY', form_title: 'Báo cáo nhanh tuần', report_year: 2026, period_label: period, due_date: due, cxn_refs: ['CXN-11'], ...overrides });
const W40 = week(40, 'W2026-40', '2026-10-02', REPORT_40);
const W41 = week(41, 'W2026-41', '2026-10-09', REPORT_41);
const HALF = obligationRow(1, { period_label: 'H1-2026' });

const field = (key: string, label: string, kind: string, overrides: Record<string, unknown> = {}) => ({ key, label, kind, required: false, locked: false, source: null, value: null, ...overrides });
const SLOW = '1. DA-02 - Cầu Bến Lức; lãnh đạo phụ trách: Nguyễn Văn A; chậm 35.5000 điểm so với kỳ vọng\n2. DA-07 - Đường tỉnh 9; lãnh đạo phụ trách: chưa phân công; chậm 12.0000 điểm so với kỳ vọng';
const metric = (name: string) => ({ kind: 'SNAPSHOT_METRIC', metric: name });

const reportBody = (id: string, period: string, due: string, overrides: Record<string, unknown> = {}) => ({
  id,
  form: { id: '00000000-0000-4000-8000-000000000109', code: 'CV3665-WEEKLY', revision: 1, title: 'Báo cáo nhanh tuần về giải ngân vốn đầu tư công', legal_confirmation_ref: null, watermark_text: 'Mẫu chờ xác nhận pháp lý [CXN-11]' },
  awaiting_confirmation: true,
  cxn_refs: ['CXN-11'],
  report_year: 2026,
  period_label: period,
  period_id: null,
  scope_unit_id: '00000000-0000-4000-8000-000000000501',
  scope_unit: { id: '00000000-0000-4000-8000-000000000501', code: 'UBND', name: 'Ủy ban nhân dân tỉnh' },
  project_id: null,
  due_date: due,
  revision: 1,
  status: 'DRAFT',
  is_late: false,
  snapshot: { id: SNAPSHOT, as_of_date: '2026-10-01' },
  snapshot_options: [],
  fields: [
    field('rate_pm_pct', 'Tỷ lệ theo kế hoạch Thủ tướng giao', 'PERCENT', { required: true, locked: true, source: metric('rate_pm_pct'), value: '60.0000' }),
    field('rate_total_pct', 'Tỷ lệ theo tổng kế hoạch', 'PERCENT', { required: true, locked: true, source: metric('rate_total_pct'), value: '48.0000' }),
    field('plan_total_vnd', 'Tổng kế hoạch vốn', 'MONEY', { required: true, locked: true, source: metric('plan_total_vnd'), value: '1250000000000' }),
    field('disbursed_treasury_vnd', 'Giải ngân lũy kế', 'MONEY', { required: true, locked: true, source: metric('disbursed_treasury_vnd'), value: '750000000000' }),
    field('slow_projects', 'Dự án chậm', 'TEXT', { required: true, locked: true, source: { kind: 'SLOW_PROJECTS', limit: 5 }, value: SLOW }),
    field('proposals', 'Kiến nghị', 'TEXT', { value: 'Đề nghị đẩy nhanh thanh toán khối lượng hoàn thành.' }),
  ],
  attachments: [],
  payload_sha256: null,
  doc_document_id: null,
  supersedes_id: null,
  correction_reason: null,
  submitted_by: null,
  approved_by: null,
  created_by: '00000000-0000-4000-8000-000000000001',
  version: 3,
  ...overrides,
});

function client(weeks: unknown, reports: Record<string, unknown> = { [REPORT_40]: reportBody(REPORT_40, 'W2026-40', '2026-10-02'), [REPORT_41]: reportBody(REPORT_41, 'W2026-41', '2026-10-09') }): Harness {
  return harness((operation, input) => {
    if (operation === 'listMneObligations') return weeks;
    if (operation === 'getMneReport') return reports[(input as { path: { id: string } }).path.id] ?? failure(404, 'NOT_FOUND');
    return new Error(`unexpected read ${operation}`);
  });
}

const reads = (h: Harness, operation: string): Array<Record<string, unknown>> => h.read.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as Record<string, unknown>);

beforeEach(() => {
  // The week the screen opens on depends on today: the Friday after W2026-40 is due, before W2026-41 is.
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-05T03:00:00Z') });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('MNE-07 weekly quick report (ST-MNE-005, MNE F3, CV 3665 [CXN-11])', () => {
  it('AC-ST-MNE-005-1: UAT-AC291 shows the report of W2026-40 with the two rates of DIS-19, the slow projects with their leaders, and the due date', async () => {
    mount(<WeeklyQuickScreen route={ROUTE} />, client(page([HALF, W41, W40])), { permissions: READER });
    expect(await screen.findByTestId('weekly-report')).toBeTruthy();
    // The week that is due by today is the one that opens.
    expect((screen.getByLabelText(vi_['mne.weekly.week.label']) as HTMLSelectElement).value).toBe(REPORT_40);
    const pair = screen.getByTestId('weekly-rates');
    expect(pair.querySelector('[data-rate="pm"]')?.textContent).toContain('60.0000%');
    expect(pair.querySelector('[data-rate="total"]')?.textContent).toContain('48.0000%');
    // The words are the ones DIS-19 uses for the two rates.
    expect(pair.textContent).toContain(vi_['dis.rates.col.ratePm']);
    expect(pair.textContent).toContain(vi_['dis.rates.col.rateTotal']);
    expect(pair.textContent).toContain('1.250.000.000.000');
    expect(pair.textContent).toContain('750.000.000.000');
    const slow = within(screen.getByTestId('weekly-slow'));
    expect(slow.getByText(/DA-02 - Cầu Bến Lức; lãnh đạo phụ trách: Nguyễn Văn A; chậm 35\.5000/)).toBeTruthy();
    expect(slow.getByText(/DA-07 - Đường tỉnh 9; lãnh đạo phụ trách: chưa phân công/)).toBeTruthy();
    expect(screen.getByTestId('weekly-header').textContent).toContain('2026-10-02');
    expect(screen.getByTestId('weekly-header').textContent).toContain('2026-10-01');
    expect(screen.getByTestId('weekly-proposals').textContent).toContain('Đề nghị đẩy nhanh thanh toán');
  });

  it('shows the correction that supersedes the report the calendar lists, with its figures and its link, and the unit of each week in the picker', async () => {
    const CORRECTION = '00000000-0000-4000-8000-000000000350';
    const history = [
      { id: REPORT_40, revision: 1, status: 'SUPERSEDED', correction_reason: null, supersedes_id: null, issued_at: null, created_at: '2026-10-02T00:00:00Z', current: true },
      { id: CORRECTION, revision: 2, status: 'DRAFT', correction_reason: 'The rate was wrong.', supersedes_id: REPORT_40, issued_at: null, created_at: '2026-10-03T00:00:00Z', current: false },
    ];
    const corrected = reportBody(CORRECTION, 'W2026-40', '2026-10-02', {
      revision: 2,
      fields: [
        field('rate_pm_pct', 'PM', 'PERCENT', { locked: true, source: metric('rate_pm_pct'), value: '61.5000' }),
        field('rate_total_pct', 'Total', 'PERCENT', { locked: true, source: metric('rate_total_pct'), value: '49.2000' }),
      ],
    });
    const h = client(page([W40]), { [REPORT_40]: reportBody(REPORT_40, 'W2026-40', '2026-10-02', { status: 'SUPERSEDED', history }), [CORRECTION]: { ...corrected, history: history.map((entry) => ({ ...entry, current: entry.id === CORRECTION })) } });
    mount(<WeeklyQuickScreen route={ROUTE} />, h, { permissions: READER });
    await screen.findByTestId('weekly-rates');
    await waitFor(() => expect(screen.getByTestId('weekly-rates').querySelector('[data-rate="pm"]')?.textContent).toContain('61.5000%'));
    expect(screen.getByTestId('weekly-revision').textContent).toBe(fill(vi_['mne.weekly.header.revision'], { revision: 2 }));
    expect(screen.getByRole('link', { name: vi_['mne.weekly.open'] }).getAttribute('href')).toBe(`/mne/mne-03?report=${CORRECTION}`);
    // The picker still names the week by the report the calendar lists, with the unit.
    expect(within(screen.getByLabelText(vi_['mne.weekly.week.label'])).getByText(fill(vi_['mne.weekly.week.option'], { period: 'W2026-40', unit: 'CDT-40', due: '2026-10-02' }))).toBeTruthy();
  });

  it('loads the stylesheet of the rate tiles itself, so that the pair is side by side when this is the first screen opened', () => {
    // The tiles are styled by the DIS sheet, which is only there when a DIS screen was opened before: the screen imports it (a stylesheet is not applied in the test environment, so the import is what is checked).
    const source = readFileSync(resolve(process.cwd(), 'src/screens/mne/WeeklyQuickScreen.tsx'), 'utf8');
    expect(source).toMatch(/import '\.\.\/dis\/dis\.css';/);
    expect(readFileSync(resolve(process.cwd(), 'src/screens/dis/dis.css'), 'utf8')).toMatch(/\.dis-rate-pair/);
  });

  it('keeps the weekly form only in the picker, and reads the report of the week that is chosen', async () => {
    const user = userEvent.setup();
    const h = client(page([HALF, W41, W40]));
    mount(<WeeklyQuickScreen route={ROUTE} />, h, { permissions: READER });
    const picker = (await screen.findByLabelText(vi_['mne.weekly.week.label'])) as HTMLSelectElement;
    expect(Array.from(picker.options).map((option) => option.value)).toEqual([REPORT_41, REPORT_40]);
    await screen.findByTestId('weekly-report');
    await user.selectOptions(picker, REPORT_41);
    await waitFor(() => expect(reads(h, 'getMneReport').map((input) => (input.path as { id: string }).id)).toContain(REPORT_41));
    expect(await screen.findByText(fill(vi_['mne.weekly.header.period'], { period: 'W2026-41', due: '2026-10-09' }))).toBeTruthy();
  });

  it('shows both rates always, and says a rate has no figure instead of showing 0 when the report has none', async () => {
    const empty = reportBody(REPORT_40, 'W2026-40', '2026-10-02', {
      snapshot: null,
      fields: [
        field('rate_pm_pct', 'PM', 'PERCENT', { locked: true, source: metric('rate_pm_pct'), value: null }),
        field('rate_total_pct', 'Total', 'PERCENT', { locked: true, source: metric('rate_total_pct'), value: '48.0000' }),
        field('slow_projects', 'Slow', 'TEXT', { locked: true, source: { kind: 'SLOW_PROJECTS', limit: 5 }, value: null }),
      ],
    });
    mount(<WeeklyQuickScreen route={ROUTE} />, client(page([W40]), { [REPORT_40]: empty }), { permissions: READER });
    const pair = await screen.findByTestId('weekly-rates');
    expect(pair.querySelector('[data-rate="pm"]')?.textContent).toContain(vi_['mne.weekly.rate.missing']);
    expect(pair.querySelector('[data-rate="pm"]')?.textContent).not.toContain('0%');
    expect(pair.querySelector('[data-rate="total"]')?.textContent).toContain('48.0000%');
    // Without a snapshot there is no list either, and the screen says why.
    expect(screen.getByTestId('weekly-header').textContent).toContain(vi_['mne.weekly.header.noSnapshot']);
    expect(screen.getByTestId('weekly-slow').textContent).toContain(vi_['mne.weekly.slow.missing']);
    expect(screen.getByTestId('weekly-proposals').textContent).toContain(vi_['mne.weekly.proposals.none']);
  });

  it('says the form waits for the legal confirmation, and opens the report in MNE-03 to write it', async () => {
    mount(<WeeklyQuickScreen route={ROUTE} />, client(page([W40])), { permissions: READER });
    await screen.findByTestId('weekly-report');
    expect(screen.getByTestId('weekly-header').textContent).toContain('CXN-11');
    expect(screen.getByRole('link', { name: vi_['mne.weekly.open'] }).getAttribute('href')).toBe(`/mne/mne-03?report=${REPORT_40}`);
  });

  describe('AC-ST-MNE-005-2: UI-MNE-07 the seven standard states', () => {
    it.each([
      ['empty', page([HALF]), vi_['states.empty.title']],
      ['denied', failure(403, 'SCOPE_DENIED'), vi_['states.denied.title']],
      ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      ['error', failure(500, 'INTERNAL_ERROR'), vi_['states.error.title']],
      ['signed out', failure(401, 'SESSION_EXPIRED'), vi_['states.signedOut.title']],
    ])('AC-ST-MNE-005-2: UI-MNE-07 shows the %s state of the weeks and keeps the year', async (_name, reply, title) => {
      mount(<WeeklyQuickScreen route={ROUTE} />, client(reply), { permissions: READER });
      expect(await screen.findByText(title)).toBeTruthy();
      expect(screen.getByLabelText(vi_['mne.calendar.filter.year.label'])).toBeTruthy();
    });

    it('AC-ST-MNE-005-2: UI-MNE-07 shows the states of the report on its own, and keeps the picker of the weeks', async () => {
      mount(<WeeklyQuickScreen route={ROUTE} />, client(page([W40]), { [REPORT_40]: failure(403, 'SCOPE_DENIED') }), { permissions: READER });
      expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
      expect(screen.getByLabelText(vi_['mne.weekly.week.label'])).toBeTruthy();
    });

    it('AC-ST-MNE-005-2: UI-MNE-07 shows the loading state first and names the page for assistive technology', () => {
      mount(<WeeklyQuickScreen route={ROUTE} />, harness(() => new Promise(() => undefined)));
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(screen.getByRole('region', { name: vi_['mne.weekly.page.title'] })).toBeTruthy();
    });

    it('AC-ST-MNE-005-2: UI-MNE-07 names every control and retries after an error', async () => {
      mount(<WeeklyQuickScreen route={ROUTE} />, client(page([W40])), { permissions: READER });
      await screen.findByTestId('weekly-report');
      for (const control of screen.getAllByRole('combobox')) expect((control as HTMLSelectElement).labels?.length).toBeGreaterThan(0);
      cleanup();
      let failing = true;
      const h = harness((operation) => (operation === 'listMneObligations' ? (failing ? failure(500, 'INTERNAL_ERROR') : page([W40])) : reportBody(REPORT_40, 'W2026-40', '2026-10-02')));
      mount(<WeeklyQuickScreen route={ROUTE} />, h);
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      failing = false;
      await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      expect(await screen.findByTestId('weekly-report')).toBeTruthy();
    });
  });
});
