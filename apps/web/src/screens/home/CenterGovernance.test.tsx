import { ApiError } from '@machvon/api-client';
import { cleanup, configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t as tr } from '../../i18n';
import { harness, mount, routeOf } from '../mne/test-support';
import type { Harness } from '../mne/test-support';
import OverviewScreen from './OverviewScreen';

const OV = routeOf('HOME-01', 'FR-HOME-01');
const READER = ['home.read'];
const S40 = '00000000-0000-4000-8000-0000000000f2';
const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);
const failure = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });

const kpi = (code: string, overrides: Record<string, unknown> = {}) => ({
  code,
  name: `Tên ${code}`,
  formula: `công thức ${code}`,
  numerator: `tử số ${code}`,
  denominator: `mẫu số ${code}`,
  exclusions: [],
  unit: 'PERCENT',
  period: 'YEAR',
  source: 'Phân hệ giải ngân (DIS)',
  owner: 'Vụ kế hoạch',
  allowedLagDays: 8,
  version: 0,
  effectiveFrom: null,
  effectiveTo: null,
  origin: 'DEFAULT',
  unverified: false,
  asOf: '2027-10-12',
  snapshotId: S40,
  ...overrides,
});
const figure = (code: string, overrides: Record<string, unknown> = {}) => ({
  metric_code: code,
  value: '60.0000',
  display_value: '60.00',
  numerator: '600000000000',
  denominator: '1000000000000',
  null_reason: null,
  unit: 'PERCENT',
  formula: 'a / b',
  definition_status: 'SIGNED',
  context_token: `token-${code}.sig`,
  flags: [],
  certification: { status: 'CERTIFIED', version: 0, origin: 'PLATFORM', certified_by: null, at: null },
  kpi: kpi(code),
  ...overrides,
});
const count = (code: string, display: string | null, overrides: Record<string, unknown> = {}) => ({
  metric_code: code,
  value: display,
  display_value: display,
  numerator: display,
  denominator: null,
  null_reason: null,
  unit: 'COUNT',
  formula: 'đếm',
  definition_status: 'SIGNED',
  flags: [],
  certification: { status: 'CERTIFIED', version: 0, origin: 'PLATFORM', certified_by: null, at: null },
  kpi: kpi(code, { unit: 'COUNT', asOf: '2027-10-13' }),
  ...overrides,
});

const center = (overrides: Record<string, unknown> = {}) => ({
  snapshot_id: S40,
  as_of_date: '2027-10-12',
  treasury_cutoff_date: '2027-10-12',
  freshness: 'FRESH',
  definition_status: 'SIGNED',
  legal_confirmation_refs: [],
  scope: { unit_id: null, denominator_kind: null, projects: 10, scope_hash: 'h' },
  tiles: [
    figure('DISBURSEMENT_RATE_PM'),
    figure('DISBURSEMENT_RATE_TOTAL', { display_value: '48.00', kpi: kpi('DISBURSEMENT_RATE_TOTAL', { version: 2, origin: 'RULE' }) }),
    figure('DISBURSED_TREASURY', { unit: 'VND', value: '600000000000', display_value: '600000000000', numerator: null, denominator: null }),
    figure('PLAN_PM_ASSIGNED', { unit: 'VND', value: '1000000000000', display_value: '1000000000000', numerator: null, denominator: null }),
    figure('PLAN_TOTAL', { unit: 'VND', value: '1250000000000', display_value: '1250000000000', numerator: null, denominator: null }),
  ],
  count_tiles: [count('OPEN_WARNINGS', '4'), count('OVERDUE_EXPLANATIONS', '1'), count('PENDING_REALLOCATIONS', '3')],
  projects_without_data: 0,
  open_warnings: 4,
  overdue_explanations: 1,
  pending_reallocations: 3,
  quality_badge: 'NOT_ASSESSED',
  ...overrides,
});

const line = (overrides: Record<string, unknown> = {}) => ({ kind: 'RATE_CHANGE', direction: 'UP', params: { from: '10.00', to: '12.50', delta: '2.50' }, link: 'DRILL', metric_code: 'DISBURSEMENT_RATE_PM', context_token: 'tok-rate.sig', ...overrides });
const CHANGES = {
  snapshot_id: S40,
  as_of_date: '2027-10-12',
  week_start: '2027-10-11',
  previous_week_start: '2027-10-04',
  previous_as_of_date: '2027-10-05',
  reason: null,
  max_lines: 5,
  lines: [
    line(),
    line({ kind: 'UNITS_TO_RED', direction: 'DOWN', params: { count: 2 }, link: 'RAG', metric_code: null, context_token: null }),
    line({ kind: 'WARNINGS_DELTA', direction: 'UP', params: { from: '3', to: '4', delta: '1' }, link: 'WARNINGS', metric_code: null, context_token: null }),
    line({ kind: 'OVERDUE_DELTA', direction: 'DOWN', params: { from: '3', to: '1', delta: '2' }, link: 'MY_WORK', metric_code: null, context_token: null }),
    line({ kind: 'UNITS_RECOVERED', direction: 'UP', params: { count: 1 }, link: 'RANKING', metric_code: null, context_token: null }),
  ],
};

const RAG = { snapshot_id: S40, as_of_date: '2027-10-12', week_start: '2027-10-11', model: { unverified: false, versions: {}, min_coverage_pct: 60, score_green: 30, score_amber: 60, factors: [] }, summary: { RED: 2, AMBER: 1, GREEN: 5, NO_DATA: 1 }, units: [] };

interface Answers {
  center?: () => unknown;
  changes?: () => unknown;
  rag?: () => unknown;
  file?: () => unknown;
}

function client(answers: Answers = {}): Harness {
  const h = harness((operation) => {
    switch (operation) {
      case 'getCommandCenter':
        return (answers.center ?? (() => center()))();
      case 'getHomeChanges':
        return (answers.changes ?? (() => CHANGES))();
      case 'getRagReading':
        return (answers.rag ?? (() => RAG))();
      case 'exportHomeFigures':
        return (answers.file ?? (() => ({ file_name: 'so-lieu.csv', media_type: 'text/csv', format: 'CSV', snapshot_id: S40, as_of_date: '2027-10-12', rows: 3, size_bytes: 5, sha256: 'ab', content_base64: 'aGVsbG8=' })))();
      default:
        return new Error(`unexpected read ${operation}`);
    }
  });
  (h.client as unknown as { readAll: (operation: string) => Promise<unknown> }).readAll = () => Promise.resolve([]);
  return h;
}

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 20_000 });
afterEach(cleanup);

const hero = async (): Promise<HTMLElement> => screen.findByRole('region', { name: fill(tr('home.ov.hero.label'), { year: '2027' }) });

describe('every number of the center is the text of the server, with the "i" of its definition (G0-4)', () => {
  it('shows display_value for the hero, the two rates, the plan and the counts, and not a text made from value', async () => {
    mount(<OverviewScreen route={OV} />, client({ center: () => center({ tiles: [figure('DISBURSEMENT_RATE_PM', { value: '60.0000', display_value: '59.99' }), figure('DISBURSEMENT_RATE_TOTAL', { value: '48.0000', display_value: '47.50' }), figure('DISBURSED_TREASURY', { unit: 'VND', value: '600000000001', display_value: '600000000000', numerator: null, denominator: null }), figure('PLAN_PM_ASSIGNED', { unit: 'VND', value: '1000000000000', display_value: '1000000000000', numerator: null, denominator: null }), figure('PLAN_TOTAL', { unit: 'VND', value: '1250000000000', display_value: '1250000000000', numerator: null, denominator: null })] }) }), { permissions: READER });
    const block = await hero();
    expect(block.textContent).toContain('600000000000');
    expect(block.textContent).not.toContain('600000000001');
    expect(block.textContent).toContain(fill(tr('home.tile.value.percent'), { value: '59.99' }));
    expect(block.textContent).toContain(fill(tr('home.tile.value.percent'), { value: '47.50' }));
    expect(block.textContent).not.toContain('60.0000');
    const kpis = screen.getByTestId('home-kpis');
    expect(kpis.textContent).toContain('1250000000000');
    expect(kpis.textContent).toContain(fill(tr('govc.home.kpi.plan.sub'), { pm: '1000000000000' }));
    // The three waiting counts are the figures of the register too.
    expect(within(kpis).getByText('4')).toBeTruthy();
    expect(within(kpis).getByText('3')).toBeTruthy();
    expect(kpis.textContent).toContain(fill(tr('home.ov.kpi.warnings.sub'), { count: 1 }));
  });

  it('gives the hero chips, the amount, the plan and the three waiting counts each an "i"', async () => {
    mount(<OverviewScreen route={OV} />, client(), { permissions: READER });
    const block = await hero();
    for (const code of ['DISBURSEMENT_RATE_PM', 'DISBURSEMENT_RATE_TOTAL', 'DISBURSED_TREASURY']) expect(within(block).getByRole('button', { name: fill(tr('govc.home.info.open'), { name: `Tên ${code}` }) })).toBeTruthy();
    const kpis = screen.getByTestId('home-kpis');
    for (const code of ['PLAN_TOTAL', 'PLAN_PM_ASSIGNED', 'OPEN_WARNINGS', 'OVERDUE_EXPLANATIONS', 'PENDING_REALLOCATIONS']) expect(within(kpis).getByRole('button', { name: fill(tr('govc.home.info.open'), { name: `Tên ${code}` }) })).toBeTruthy();
    // The amount tiles under the details carry it as well.
    const amounts = screen.getByTestId('home-amounts');
    expect(within(amounts).getAllByRole('button', { name: /Tên/ })).toHaveLength(3);
  });

  it('opens the definition with the version in words ("mặc định" for the built-in one) and the day as dd/mm/yyyy', async () => {
    const user = userEvent.setup();
    mount(<OverviewScreen route={OV} />, client(), { permissions: READER });
    const block = await hero();
    await user.click(within(block).getByRole('button', { name: fill(tr('govc.home.info.open'), { name: 'Tên DISBURSEMENT_RATE_PM' }) }));
    const panel = await screen.findByRole('dialog', { name: 'Tên DISBURSEMENT_RATE_PM' });
    expect(within(panel).getByText(fill(tr('govc.home.info.version.default'), { version: 0 }))).toBeTruthy();
    expect(within(panel).getByText('Phiên bản 0 (mặc định)')).toBeTruthy();
    expect(within(panel).getByText('12/10/2027')).toBeTruthy();
    expect(within(panel).getByText('công thức DISBURSEMENT_RATE_PM')).toBeTruthy();
    expect(within(panel).getByText('Phân hệ giải ngân (DIS)')).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Tên DISBURSEMENT_RATE_PM' })).toBeNull());
    await user.click(within(block).getByRole('button', { name: fill(tr('govc.home.info.open'), { name: 'Tên DISBURSEMENT_RATE_TOTAL' }) }));
    const second = await screen.findByRole('dialog', { name: 'Tên DISBURSEMENT_RATE_TOTAL' });
    expect(within(second).getByText('Phiên bản 2')).toBeTruthy();
  });

  it('writes the flags of a figure as text pills, and the unconfirmed definition in the panel', async () => {
    const user = userEvent.setup();
    mount(
      <OverviewScreen route={OV} />,
      client({ center: () => center({ tiles: [figure('DISBURSEMENT_RATE_PM', { flags: ['STALE', 'PARTIAL_COVERAGE'], kpi: kpi('DISBURSEMENT_RATE_PM', { unverified: true }) }), figure('DISBURSEMENT_RATE_TOTAL'), figure('DISBURSED_TREASURY', { unit: 'VND', value: '1', display_value: '1', numerator: null, denominator: null })] }) }),
      { permissions: READER },
    );
    const block = await hero();
    const flags = within(block).getByTestId('flags-DISBURSEMENT_RATE_PM');
    expect(within(flags).getByText(tr('govc.home.flag.stale'))).toBeTruthy();
    expect(within(flags).getByText(tr('govc.home.flag.partialCoverage'))).toBeTruthy();
    await user.click(within(block).getByRole('button', { name: fill(tr('govc.home.info.open'), { name: 'Tên DISBURSEMENT_RATE_PM' }) }));
    expect((await screen.findByRole('dialog')).textContent).toContain(tr('govc.home.info.unverified'));
  });

  it('says why a figure is held back in words, and never writes 0 in its place', async () => {
    mount(
      <OverviewScreen route={OV} />,
      client({
        center: () =>
          center({
            tiles: [
              figure('DISBURSEMENT_RATE_PM', { value: null, display_value: null, numerator: null, denominator: null, null_reason: 'NOT_CERTIFIED', flags: ['NOT_CERTIFIED'] }),
              figure('DISBURSEMENT_RATE_TOTAL', { value: null, display_value: null, numerator: null, denominator: null, null_reason: 'OBSOLETE', flags: ['OBSOLETE'] }),
              figure('DISBURSED_TREASURY', { unit: 'VND', value: null, display_value: null, numerator: null, denominator: null, null_reason: 'NO_DATA', flags: ['NO_DATA'] }),
              figure('PLAN_TOTAL', { unit: 'VND', value: null, display_value: null, numerator: null, denominator: null, null_reason: 'NOT_CERTIFIED', flags: ['NOT_CERTIFIED'] }),
            ],
            count_tiles: [count('OPEN_WARNINGS', null, { null_reason: 'NOT_CERTIFIED', flags: ['NOT_CERTIFIED'] }), count('OVERDUE_EXPLANATIONS', '1'), count('PENDING_REALLOCATIONS', '3')],
          }),
      }),
      { permissions: READER },
    );
    const block = await hero();
    expect(block.textContent).toContain(tr('govc.home.reason.notCertified'));
    expect(block.textContent).toContain(tr('govc.home.reason.obsolete'));
    expect(block.textContent).toContain(tr('home.ov.hero.noData'));
    // The text of the pill that repeats the reason is not said twice.
    expect(within(block).queryByTestId('flags-DISBURSEMENT_RATE_PM')).toBeNull();
    expect(block.textContent).not.toMatch(/\b0([.,]00)?%/);
    const kpis = screen.getByTestId('home-kpis');
    expect(kpis.textContent).toContain(tr('govc.home.reason.notCertified'));
    const warnings = within(kpis).getByText(tr('home.ov.kpi.openWarnings.label')).closest('article') as HTMLElement;
    expect(warnings.textContent).not.toMatch(/(^|[^\d])0([^\d]|$)/);
  });

  it('shows the "i" of an amount in the details tiles with the exact text of the server', async () => {
    mount(<OverviewScreen route={OV} />, client(), { permissions: READER });
    await hero();
    expect(screen.getByTestId('tile-figure-PLAN_TOTAL').textContent).toBe('1250000000000');
    expect(screen.getByTestId('tile-figure-DISBURSEMENT_RATE_PM').textContent).toBe('60.00');
  });
});

describe('"Thay đổi từ tuần trước" on the center (G3-4)', () => {
  it('says each line as a sentence with its numbers and gives it ONE link by kind', async () => {
    mount(<OverviewScreen route={OV} />, client(), { permissions: READER });
    const block = await screen.findByTestId('changes-lines');
    const items = within(block).getAllByRole('listitem');
    expect(items).toHaveLength(5);
    expect(items[0]?.textContent).toContain(fill(tr('govc.home.changes.rate.up'), { from: '10.00', to: '12.50', delta: '2.50' }));
    expect(items[1]?.textContent).toContain(fill(tr('govc.home.changes.unitsToRed'), { count: 2 }));
    expect(items[2]?.textContent).toContain(fill(tr('govc.home.changes.warnings.up'), { from: 3, to: 4, delta: 1 }));
    expect(items[3]?.textContent).toContain(fill(tr('govc.home.changes.overdue.down'), { from: 3, to: 1, delta: 2 }));
    expect(items[4]?.textContent).toContain(fill(tr('govc.home.changes.unitsRecovered'), { count: 1 }));
    const hrefs = items.map((item) => within(item).getAllByRole('link').map((link) => link.getAttribute('href')));
    expect(hrefs).toEqual([['/home/home-10?token=tok-rate.sig'], ['/home/home-11'], ['/home/home-03'], ['/home/home-02'], ['/home/home-04']]);
    expect(screen.getByTestId('changes-range').textContent).toContain('11/10/2027');
  });

  it('says there is no week before to compare with, apart from nothing having changed', async () => {
    mount(<OverviewScreen route={OV} />, client({ changes: () => ({ ...CHANGES, reason: 'NO_PREVIOUS_WEEK', lines: [], previous_week_start: '', previous_as_of_date: null }) }), { permissions: READER });
    expect((await screen.findByTestId('changes-no-previous')).textContent).toBe(tr('govc.home.changes.noPrevious'));
    expect(screen.queryByTestId('changes-none')).toBeNull();
    cleanup();
    mount(<OverviewScreen route={OV} />, client({ changes: () => ({ ...CHANGES, lines: [] }) }), { permissions: READER });
    expect((await screen.findByTestId('changes-none')).textContent).toBe(tr('govc.home.changes.none'));
    expect(screen.queryByTestId('changes-no-previous')).toBeNull();
  });

  it('shows a skeleton while it is read, and never a failed reading as "no change": the error retries in place', async () => {
    const user = userEvent.setup();
    let answer: () => unknown = () => failure(500, 'INTERNAL_ERROR');
    mount(<OverviewScreen route={OV} />, client({ changes: () => answer() }), { permissions: READER });
    const error = await screen.findByTestId('changes-error');
    expect(error.textContent).toContain(fill(tr('home.ov.source.error'), { source: tr('govc.home.changes.source') }));
    expect(screen.queryByTestId('changes-none')).toBeNull();
    answer = () => ({ ...CHANGES, lines: [] });
    await user.click(within(error).getByRole('button', { name: tr('ui.common.retry') }));
    expect(await screen.findByTestId('changes-none')).toBeTruthy();
    cleanup();
    mount(<OverviewScreen route={OV} />, client({ changes: () => new Promise(() => undefined) }), { permissions: READER });
    expect(await screen.findByTestId('changes-loading')).toBeTruthy();
    expect(screen.getByTestId('changes-loading').getAttribute('aria-busy')).toBe('true');
    expect(screen.getByTestId('home-changes').textContent).not.toMatch(/\d/);
  });

  it('says a refusal as a refusal and nothing frozen yet in its own words', async () => {
    mount(<OverviewScreen route={OV} />, client({ changes: () => failure(403, 'SCOPE_DENIED') }), { permissions: READER });
    expect((await screen.findByTestId('changes-denied')).textContent).toBe(tr('govc.home.changes.denied'));
    cleanup();
    mount(<OverviewScreen route={OV} />, client({ changes: () => failure(404, 'RESOURCE_NOT_FOUND') }), { permissions: READER });
    expect((await screen.findByTestId('changes-no-snapshot')).textContent).toContain(tr('govc.home.changes.noSnapshot'));
  });

  it('does not say a line whose kind it has no sentence for', async () => {
    mount(<OverviewScreen route={OV} />, client({ changes: () => ({ ...CHANGES, lines: [line({ kind: 'SURPRISE' })] }) }), { permissions: READER });
    expect((await screen.findByTestId('changes-none')).textContent).toBe(tr('govc.home.changes.none'));
  });
});

describe('the summary of the colours on the center (G3-2)', () => {
  it('counts the colours as text with a mark, and leads to HOME-11', async () => {
    mount(<OverviewScreen route={OV} />, client(), { permissions: READER });
    const card = await screen.findByTestId('rag-summary');
    expect(within(card).getByTestId('rag-count-RED').textContent).toBe('2');
    expect(within(card).getByTestId('rag-count-AMBER').textContent).toBe('1');
    expect(within(card).getByTestId('rag-count-GREEN').textContent).toBe('5');
    expect(within(card).getByTestId('rag-count-NO_DATA').textContent).toBe('1');
    expect(within(card).getByText(tr('govc.home.band.noData'))).toBeTruthy();
    expect(within(screen.getByTestId('home-rag-summary')).getByRole('link', { name: tr('govc.home.rag.summary.link') }).getAttribute('href')).toBe('/home/home-11');
  });

  it('retries in place when it cannot be read, and says a refusal as a refusal', async () => {
    mount(<OverviewScreen route={OV} />, client({ rag: () => failure(500, 'INTERNAL_ERROR') }), { permissions: READER });
    expect((await screen.findByTestId('rag-error')).textContent).toContain(tr('govc.home.rag.source'));
    cleanup();
    mount(<OverviewScreen route={OV} />, client({ rag: () => failure(403, 'SCOPE_DENIED') }), { permissions: READER });
    expect((await screen.findByTestId('rag-denied')).textContent).toBe(tr('govc.home.rag.denied.read'));
  });
});

describe('the file of the figures (G0-4)', () => {
  it('asks for the file of the snapshot on the screen and hands the bytes to the browser as a download, with no server kept', async () => {
    const user = userEvent.setup();
    const created = vi.fn((blob: Blob) => {
      expect(blob.type).toBe('text/csv');
      return 'blob:figures';
    });
    const revoked = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: created });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revoked });
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    try {
      const h = client();
      mount(<OverviewScreen route={OV} />, h, { permissions: READER });
      await hero();
      await user.click(screen.getByRole('button', { name: tr('govc.home.export.csv') }));
      await waitFor(() => expect(created).toHaveBeenCalledTimes(1));
      const blob = created.mock.calls[0]?.[0] as Blob;
      const content = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.readAsText(blob);
      });
      expect(content).toBe('hello');
      expect(clicked).toHaveBeenCalledTimes(1);
      expect(revoked).toHaveBeenCalledWith('blob:figures');
      const call = h.read.mock.calls.find((entry) => entry[0] === 'exportHomeFigures');
      expect((call?.[1] as { query: Record<string, string> }).query).toEqual({ format: 'CSV', snapshot_id: S40 });
      await waitFor(() => expect(screen.getByTestId('export-status').textContent).toBe(fill(tr('govc.home.export.done'), { name: 'so-lieu.csv', rows: 3 })));
    } finally {
      Reflect.deleteProperty(URL, 'createObjectURL');
      Reflect.deleteProperty(URL, 'revokeObjectURL');
      clicked.mockRestore();
    }
  });

  it('offers Excel too, and says a failure or a refusal in words', async () => {
    const user = userEvent.setup();
    let answer: () => unknown = () => failure(500, 'INTERNAL_ERROR');
    const h = client({ file: () => answer() });
    mount(<OverviewScreen route={OV} />, h, { permissions: READER });
    await hero();
    await user.click(screen.getByRole('button', { name: tr('govc.home.export.xlsx') }));
    expect((await screen.findByTestId('export-error')).textContent).toBe(tr('govc.home.export.error'));
    expect((h.read.mock.calls.find((entry) => entry[0] === 'exportHomeFigures')?.[1] as { query: Record<string, string> }).query.format).toBe('XLSX');
    answer = () => failure(403, 'FORBIDDEN');
    await user.click(screen.getByRole('button', { name: tr('govc.home.export.csv') }));
    await waitFor(() => expect(screen.getByTestId('export-error').textContent).toBe(tr('govc.home.export.denied')));
  });
});
