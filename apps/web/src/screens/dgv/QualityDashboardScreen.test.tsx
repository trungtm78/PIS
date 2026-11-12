import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import QualityDashboardScreen from './QualityDashboardScreen';
import { DASHBOARD_READER, dataset, mount, qualityClient, qualityWorld, routeOf, summary } from './quality-test-support';

const ROUTE = routeOf('DGV-01', 'FR-DGV-01');
const HOUR_MS = 3_600_000;

afterEach(cleanup);

/** The rows of the table of datasets (the message rows of the table are not datasets). */
const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('tr.ui-table__row:not(.ui-table__row--message)'));
const codeOf = (row: HTMLElement): string | null => row.querySelector('code')?.textContent ?? null;
const rowOf = (code: string): HTMLElement => screen.getByText(code, { selector: 'code' }).closest('tr') as HTMLElement;
const cells = (code: string): string[] => Array.from(rowOf(code).querySelectorAll('td')).map((cell) => cell.textContent ?? '');
const ready = () => waitFor(() => expect(rows().length).toBeGreaterThan(0));
const ago = (hours: number): string => new Date(Date.now() - hours * HOUR_MS).toISOString();
const tile = (id: string): string => screen.getByTestId(id).textContent ?? '';

const DATASETS = [
  dataset(1, { dataset_code: 'DS-DISB', title: 'Disbursement', domain: 'TREASURY', quality_badge: 'STALE', quality_score: '80.00', quality_hard_fail: false, quality_run_at: ago(48), open_incidents: 1, overdue_incidents: 0, status: 'ACTIVE' }),
  dataset(2, { dataset_code: 'DS-AI-USAGE', title: 'AI usage', domain: 'AI' }),
  dataset(3, { dataset_code: 'DS-PAY', title: 'Payments', domain: 'TREASURY', quality_badge: 'FAILED', quality_score: '95.00', quality_hard_fail: true, quality_run_at: ago(3), open_incidents: 2, overdue_incidents: 1 }),
  dataset(4, { dataset_code: 'DS-LAND', title: 'Land', domain: 'LAND', quality_badge: 'PASSED', quality_score: '99.50', quality_hard_fail: false, quality_run_at: ago(0.5) }),
];
const SUMMARY = summary({ total: 4, not_assessed: 1, passed: 1, failed: 1, stale: 1, hard_fail: 1, open_incidents: 3, overdue_incidents: 1, average_score: '91.50' });

describe('QualityDashboardScreen (DGV-01): data quality control (UI-DGV-01)', () => {
  it('UAT-AC486: shows a dataset that was never assessed as "not assessed" with no score, and a run older than its freshness SLO as stale with its age (AC-ST-DGV-002-2)', async () => {
    mount(<QualityDashboardScreen route={ROUTE} />, qualityClient(qualityWorld({ datasets: DATASETS, summary: SUMMARY })), DASHBOARD_READER, '/dgv/dgv-01');
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['dgv.dashboard.page.title']);

    const never = cells('DS-AI-USAGE');
    expect(never[2]).toBe(vi_['dgv.dashboard.score.none']);
    expect(never[2]).not.toMatch(/\b0\b/);
    expect(never[3]).toBe(vi_['dgv.dashboard.freshness.none.text'].replace('{slo}', '1 ngày'));
    expect(never[5]).toBe(vi_['dgv.badge.notAssessed.text']);
    expect(rowOf('DS-AI-USAGE').querySelector('[data-badge]')?.getAttribute('data-badge')).toBe('NOT_ASSESSED');
    expect(rowOf('DS-AI-USAGE').querySelector('.ui-pill')?.className).toBe('ui-pill ui-tone-neutral');

    const stale = cells('DS-DISB');
    expect(stale[2]).toBe('80.00');
    expect(stale[3]).toBe(vi_['dgv.dashboard.freshness.stale.text'].replace('{age}', '2 ngày').replace('{slo}', '1 ngày'));
    expect(stale[3]).toBe('Dữ liệu cũ: 2 ngày (SLO 1 ngày)');
    expect(stale[5]).toBe(vi_['dgv.badge.stale.text']);
    expect(stale[4]).toBe(vi_['dgv.dashboard.incidents.text'].replace('{open}', '1').replace('{overdue}', '0'));
    expect(cells('DS-LAND')[3]).toBe('Chạy cách đây 30 phút (SLO 1 ngày)');
  });

  it('puts the average where the server computed it and says how many datasets it leaves out', async () => {
    mount(<QualityDashboardScreen route={ROUTE} />, qualityClient(qualityWorld({ datasets: DATASETS, summary: SUMMARY })), DASHBOARD_READER, '/dgv/dgv-01');
    await ready();
    expect(tile('tile-average')).toContain('91.50');
    expect(tile('tile-average')).toContain(vi_['dgv.dashboard.tile.average.note'].replace('{count}', '1'));
    expect(tile('tile-not-assessed')).toContain('1');
    expect(tile('tile-passed')).toContain(vi_['dgv.badge.passed.text']);
    expect(tile('tile-failed')).toContain(vi_['dgv.dashboard.tile.hardFail.note'].replace('{count}', '1'));
    expect(tile('tile-stale')).toContain('1');
    expect(tile('tile-incidents')).toContain(vi_['dgv.dashboard.tile.overdue.note'].replace('{count}', '1'));
    expect(screen.getByRole('group', { name: vi_['dgv.dashboard.tiles.aria'] })).toBeTruthy();
  });

  it('has no average, not 0, when no dataset has a score, and no note when nothing is left out', async () => {
    const unassessed = [dataset(1), dataset(2)];
    mount(<QualityDashboardScreen route={ROUTE} />, qualityClient(qualityWorld({ datasets: unassessed, summary: summary({ total: 2, not_assessed: 2 }) })), DASHBOARD_READER, '/dgv/dgv-01');
    await ready();
    expect(tile('tile-average')).toContain(vi_['dgv.dashboard.tile.average.none']);
    expect(tile('tile-average')).not.toMatch(/\b0\b/);
    cleanup();
    mount(<QualityDashboardScreen route={ROUTE} />, qualityClient(qualityWorld({ datasets: [DATASETS[3] as Record<string, unknown>], summary: summary({ total: 1, passed: 1, average_score: '99.50' }) })), DASHBOARD_READER, '/dgv/dgv-01');
    await ready();
    expect(tile('tile-average')).not.toContain(vi_['dgv.dashboard.tile.average.note'].replace('{count}', '0'));
  });

  it('shows a hard fail as one beside the high score of a failed run', async () => {
    mount(<QualityDashboardScreen route={ROUTE} />, qualityClient(qualityWorld({ datasets: DATASETS, summary: SUMMARY })), DASHBOARD_READER, '/dgv/dgv-01');
    await ready();
    const row = rowOf('DS-PAY');
    expect(cells('DS-PAY')[2]).toBe('95.00');
    expect(within(row).getByText(vi_['dgv.dashboard.hardFail.pill'])).toBeTruthy();
    expect(within(row).getByText(vi_['dgv.badge.failed.text'])).toBeTruthy();
    expect(within(rowOf('DS-LAND')).queryByText(vi_['dgv.dashboard.hardFail.pill'])).toBeNull();
  });

  it('links each dataset to its score', async () => {
    mount(<QualityDashboardScreen route={ROUTE} />, qualityClient(qualityWorld({ datasets: DATASETS, summary: SUMMARY })), DASHBOARD_READER, '/dgv/dgv-01');
    await ready();
    const link = within(rowOf('DS-PAY')).getByRole('link', { name: vi_['dgv.dashboard.detail.link'] });
    expect(link.getAttribute('href')).toBe(`/dgv/dgv-07?dataset=${(DATASETS[2] as { id: string }).id}`);
  });

  it('filters by domain on the server, reads the summary of the same filter, and clears the filter', async () => {
    const h = qualityClient(qualityWorld({ datasets: DATASETS, summary: SUMMARY }));
    mount(<QualityDashboardScreen route={ROUTE} />, h, DASHBOARD_READER, '/dgv/dgv-01');
    await ready();
    const user = userEvent.setup();
    expect(h.readAll).toHaveBeenCalledWith('searchCatalog', { query: {} });
    expect(h.read).toHaveBeenCalledWith('searchCatalog', { query: { limit: 1 } });
    fireEvent.change(screen.getByLabelText(vi_['dgv.dashboard.filter.domain.label']), { target: { value: ' LAND ' } });
    await user.click(screen.getByRole('button', { name: vi_['dgv.dashboard.filter.apply.action'] }));
    await waitFor(() => expect(rows().map(codeOf)).toEqual(['DS-LAND']));
    expect(h.readAll).toHaveBeenLastCalledWith('searchCatalog', { query: { domain: 'LAND' } });
    expect(h.read).toHaveBeenLastCalledWith('searchCatalog', { query: { domain: 'LAND', limit: 1 } });
    expect(screen.getByTestId('count').textContent).toBe(vi_['dgv.dashboard.count.text'].replace('{count}', '1'));

    fireEvent.change(screen.getByLabelText(vi_['dgv.dashboard.filter.domain.label']), { target: { value: 'NOWHERE' } });
    await user.click(screen.getByRole('button', { name: vi_['dgv.dashboard.filter.apply.action'] }));
    expect((await screen.findByTestId('empty-dashboard')).textContent).toBe(vi_['dgv.dashboard.noMatch.text']);
    await user.click(screen.getByRole('button', { name: vi_['dgv.dashboard.filter.clear.action'] }));
    await waitFor(() => expect(rows()).toHaveLength(4));
  });

  it('puts the seven figures in a strip of KPI tiles, names the scope and the number of datasets in the context bar, and counts the applied filter', async () => {
    mount(<QualityDashboardScreen route={ROUTE} />, qualityClient(qualityWorld({ datasets: DATASETS, summary: SUMMARY })), DASHBOARD_READER, '/dgv/dgv-01');
    await ready();
    const strip = screen.getByRole('group', { name: vi_['dgv.dashboard.tiles.aria'] });
    expect(within(strip).getAllByRole('article')).toHaveLength(7);
    const bar = screen.getByRole('group', { name: vi_['ui.contextBar.label'] });
    expect(within(bar).getByText('Số bộ dữ liệu đang hiện')).toBeTruthy();
    expect(within(bar).getByText('4')).toBeTruthy();
    expect(screen.getByRole('button', { name: vi_['ui.filterPanel.toggle'] })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(vi_['dgv.dashboard.filter.domain.label']), { target: { value: 'LAND' } });
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['dgv.dashboard.filter.apply.action'] }));
    expect(await screen.findByRole('button', { name: vi_['ui.filterPanel.toggleApplied'].replace('{count}', '1') })).toBeTruthy();
  });

  it('says there is nothing to show when no dataset is visible, and does not tell that something is hidden', async () => {
    mount(<QualityDashboardScreen route={ROUTE} />, qualityClient(qualityWorld({ datasets: [], summary: summary() })), DASHBOARD_READER, '/dgv/dgv-01');
    expect((await screen.findByTestId('empty-dashboard')).textContent).toBe(vi_['dgv.dashboard.empty.text']);
    expect(screen.getByTestId('count').textContent).toBe(vi_['dgv.dashboard.count.text'].replace('{count}', '0'));
    expect(screen.getByText(vi_['dgv.dashboard.visibility.note'])).toBeTruthy();
  });

  it('shows the error state with a retry when the catalogue cannot be read, and when the answer has no summary', async () => {
    const failing = qualityWorld({ datasets: DATASETS, failing: new Set(['searchCatalog']) });
    mount(<QualityDashboardScreen route={ROUTE} />, qualityClient(failing), DASHBOARD_READER, '/dgv/dgv-01');
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(rows()).toEqual([]);
    cleanup();
    mount(<QualityDashboardScreen route={ROUTE} />, qualityClient(qualityWorld({ datasets: DATASETS, summary: undefined })), DASHBOARD_READER, '/dgv/dgv-01');
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('is a screen of its own, with a footer that names the requirement', async () => {
    mount(<QualityDashboardScreen route={ROUTE} />, qualityClient(qualityWorld({ datasets: DATASETS, summary: SUMMARY })), DASHBOARD_READER, '/dgv/dgv-01');
    await ready();
    expect(document.querySelector('[data-screen-id="DGV-01"]')).toBeTruthy();
    expect(screen.getByText(vi_['dgv.dashboard.footer.reference'].replace('{id}', 'DGV-01').replace('{req}', 'FR-DGV-01'))).toBeTruthy();
    expect(screen.getByRole('table', { name: vi_['dgv.dashboard.table.aria'] })).toBeTruthy();
  });
});
