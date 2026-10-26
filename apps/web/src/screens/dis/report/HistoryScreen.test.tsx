import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import HistoryScreen from './HistoryScreen';
import { READER, client, fxCells, lineRecord, mount, pageRecord, reportRecord, routeOf, world } from './test-support';

const ROUTE = routeOf('DIS-11', 'FR-DIS-11');
const FIRST = '00000000-0000-4000-8000-004500000011';
const SECOND = '00000000-0000-4000-8000-004500000012';
const THIRD = '00000000-0000-4000-8000-004500000013';
const PATH = (id: string) => `/dis/dis-11?report=${id}`;

afterEach(cleanup);

const withLocal = (cumulative: string) => fxCells().map((cell) => (cell.bucket === 'CURRENT_YEAR' && cell.budget_level === 'LOCAL' ? { ...cell, cumulative_vnd: cumulative } : cell));
const first = reportRecord({ id: FIRST, revision: 1, status: 'SUPERSEDED', is_current: false, version: 5, review: null });
const second = reportRecord({
  id: SECOND,
  revision: 2,
  status: 'ACCEPTED',
  is_current: true,
  version: 4,
  funding_lines: withLocal('150000000'),
  supersedes_id: FIRST,
  amendment_reason: 'The Treasury corrected a payment of March.',
  review: null,
});
const lines = [lineRecord(1, { id: FIRST, revision: 1, status: 'SUPERSEDED' }), lineRecord(2, { id: SECOND, revision: 2, status: 'ACCEPTED' })];

const open = (id: string, details: Record<string, Record<string, unknown>>, items: Array<Record<string, unknown>>) => {
  const h = client(world({ details, page: pageRecord(items) }));
  mount(<HistoryScreen route={ROUTE} />, h, { permissions: READER, path: PATH(id) });
  return h;
};

describe('DIS-11 history and comparison of the revisions', () => {
  it('AC-ST-DIS-006-4: lists the revisions with their status and marks the accepted one as the current, and reads the period of the project it was asked for', async () => {
    const h = open(SECOND, { [FIRST]: first, [SECOND]: second }, lines);
    const list = await screen.findByTestId('revisions');
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2));
    const items = within(list).getAllByRole('listitem');
    expect(items.map((item) => item.getAttribute('data-revision'))).toEqual(['1', '2']);
    expect(within(items[0] as HTMLElement).getByText(vi_['dis.reportStatus.superseded'])).toBeTruthy();
    expect(within(items[1] as HTMLElement).getByText(vi_['dis.reportStatus.accepted'])).toBeTruthy();
    expect(screen.queryByTestId('current-1')).toBeNull();
    expect(screen.getByTestId('current-2').textContent).toBe(vi_['dis.reportHistory.current.mark']);
    expect(within(items[1] as HTMLElement).getByRole('link').getAttribute('href')).toBe(`/dis/dis-07?report=${SECOND}`);
    const readAll = (h.client as unknown as { readAll: { mock: { calls: unknown[][] } } }).readAll.mock.calls.find((call) => call[0] === 'get_resources_report_revision');
    expect((readAll?.[1] as { query: Record<string, unknown> }).query).toEqual({ project_id: (second.project as { id: string }).id, period_id: (second.period as { id: string }).id });
  });

  it('AC-ST-DIS-006-4: compares the revision before with this one cell by cell with the change signed, a fall in colour and in its sign, and says why the later one was made', async () => {
    open(SECOND, { [FIRST]: first, [SECOND]: second }, lines);
    const table = await screen.findByTestId('comparison');
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([vi_['dis.reportHistory.compare.col.source'], 'Lần 1', 'Lần 2', vi_['dis.reportHistory.compare.col.change']]);
    const local = screen.getByTestId('compare-CURRENT_YEAR:LOCAL');
    expect(local.textContent).toBe('-50.000.000');
    expect(local.className).toContain('dis-fall');
    expect(screen.getByTestId('compare-CURRENT_YEAR:CENTRAL').textContent).toBe('0');
    expect(screen.getByTestId('compare-CURRENT_YEAR:CENTRAL').className).not.toContain('dis-fall');
    expect(screen.getByTestId('compare-reason').textContent).toBe('Lý do sửa của lần 2: The Treasury corrected a payment of March.');
  });

  it('compares any two: choosing the other order shows a rise with a plus', async () => {
    const user = userEvent.setup();
    open(SECOND, { [FIRST]: first, [SECOND]: second }, lines);
    await screen.findByTestId('comparison');
    await user.selectOptions(screen.getByLabelText(vi_['dis.reportHistory.compare.first.label']), SECOND);
    await user.selectOptions(screen.getByLabelText(vi_['dis.reportHistory.compare.second.label']), FIRST);
    await waitFor(() => expect(screen.getByTestId('compare-CURRENT_YEAR:LOCAL').textContent).toBe('+50.000.000'));
    expect(screen.queryByTestId('compare-reason')).toBeNull();
  });

  it('has nothing to compare while there is one revision, and says so', async () => {
    open(FIRST, { [FIRST]: first }, [lines[0] as Record<string, unknown>]);
    expect((await screen.findByTestId('compare-none')).textContent).toBe(vi_['dis.reportHistory.compare.none.text']);
    expect(screen.queryByTestId('comparison')).toBeNull();
  });

  it('offers the revision before the one opened as the first of the comparison, and none while there is none before it', async () => {
    const third = reportRecord({ id: THIRD, revision: 3, status: 'SUBMITTED', is_current: false, version: 2, review: null });
    open(THIRD, { [FIRST]: first, [SECOND]: second, [THIRD]: third }, [...lines, lineRecord(3, { id: THIRD, revision: 3, status: 'SUBMITTED' })]);
    await screen.findByTestId('comparison');
    expect((screen.getByLabelText(vi_['dis.reportHistory.compare.first.label']) as HTMLSelectElement).value).toBe(SECOND);
    expect((screen.getByLabelText(vi_['dis.reportHistory.compare.second.label']) as HTMLSelectElement).value).toBe(THIRD);
    expect(screen.queryByTestId('current-3')).toBeNull();
  });

  it('chooses a report first when none is named', async () => {
    const h = client(world());
    mount(<HistoryScreen route={ROUTE} />, h, { permissions: READER, path: '/dis/dis-11' });
    expect((await screen.findByTestId('report-choose')).textContent).toBe(vi_['dis.reportHistory.choose.text']);
  });
});
