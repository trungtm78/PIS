import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../../../test/axe';
import { mount } from '../../sas/test-support';
import type { Answer } from '../test/fixtures';
import UnitScoreboardScreen from './UnitScoreboardScreen';
import { OWN_ONLY, PERIOD_ID, SCORE_ALL, linePage, period, periodPage, refusal, routeOf, row, serve, text, uuid } from './test/fixtures';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const route = routeOf('PWF-12');

const comparable = () => [row(1, { score_computed: 70 }), row(2, { state: 'SMALL_SAMPLE', rating: null, score_computed: 99, rated_task_count: 2, effective_weight: 2 }), row(3, { score_computed: 91 }), row(4, { has_adjustment: true, score_adjusted: 74, score_computed: 71, has_open_response: true })];
const people = () => [row(1, { score_computed: 70 }), row(2, { state: 'SMALL_SAMPLE', rating: null, score_computed: 99, rated_task_count: 2, effective_weight: 2 }), row(3, { score_computed: 91, rated_task_count: 8 }), row(4, { has_adjustment: true, score_adjusted: 74, score_computed: 71, has_open_response: true })];

interface Setup {
  permissions?: readonly string[];
  periods?: Answer;
  lines?: Answer;
  exported?: Answer;
  path?: string;
}

const open = (setup: Setup = {}) => {
  const h = serve({
    listStaffScorePeriods: setup.periods ?? periodPage([period(), period({ id: uuid(5001), period_from: '2026-07-01', period_to: '2026-09-30', status: 'OFFICIAL' })]),
    listStaffScoreLines: setup.lines ?? linePage(people()),
    exportStaffScorePeriod: setup.exported ?? { file_name: 'diem-ky.xlsx', content_type: 'application/vnd.ms-excel', size_bytes: 10, sha256: 'a'.repeat(64), content_base64: btoa('0123456789'), as_of: '2026-11-12T03:00:00.000Z' },
  });
  mount(<UnitScoreboardScreen route={route} />, h, setup.permissions ?? SCORE_ALL, setup.path ?? '/pwf/pwf-12');
  return h;
};

const names = (): string[] => within(screen.getByRole('table')).getAllByRole('link').map((link) => link.textContent ?? '');

describe('PWF-12: the scoreboard of a unit', () => {
  it('lists the lines of the first period, rated people ranked by score and the others after them with no place', async () => {
    const h = open({ lines: linePage(comparable()) });
    await screen.findByRole('table');
    expect(h.read).toHaveBeenCalledWith('listStaffScoreLines', expect.objectContaining({ path: { id: PERIOD_ID } }));
    expect(names()).toEqual(['Người 3', 'Người 4', 'Người 1', 'Người 2']);
    const rows = within(screen.getByRole('table')).getAllByRole('row');
    expect(within(rows[1] as HTMLElement).getAllByRole('cell')[0]?.textContent).toBe('1');
    expect(within(rows[4] as HTMLElement).getAllByRole('cell')[0]?.textContent).toBe('–');
  });

  it('gives no place to anybody when the rated people were judged on different samples, keeps the order of the server and writes "not enough data" for a small sample', async () => {
    open();
    await screen.findByRole('table');
    expect(screen.getByTestId('no-ranking').textContent).toBe(text('pwfs.board.differ.note'));
    expect(names()).toEqual(['Người 1', 'Người 2', 'Người 3', 'Người 4']);
    const places = within(screen.getByRole('table')).getAllByRole('row').slice(1).map((one) => within(one).getAllByRole('cell')[0]?.textContent);
    expect(places).toEqual(['–', '–', '–', '–']);
    expect(within(screen.getByRole('table')).getByText(text('pwfs.state.smallSample.word'))).toBeTruthy();
  });

  it('marks a line that was adjusted and a line with an open response, in words', async () => {
    open();
    await screen.findByRole('table');
    expect(screen.getByText(text('pwfs.board.adjusted.word'))).toBeTruthy();
    expect(screen.getByText(text('pwfs.board.openResponse.word'))).toBeTruthy();
  });

  it('gives no place while only some pages of the population are loaded, and numbers the rated once the last page is in', async () => {
    const pages = (input: Record<string, unknown>) => {
      const query = input.query as { cursor?: string } | undefined;
      return query?.cursor === undefined ? linePage(comparable().slice(0, 2), { total: 4, next_cursor: 'abc' }) : linePage(comparable().slice(2), { total: 4, next_cursor: null });
    };
    open({ lines: pages });
    await screen.findByRole('table');
    expect(screen.getByTestId('no-ranking').textContent).toBe(text('pwfs.board.partial.note'));
    expect(within(screen.getByRole('table')).getAllByRole('row').slice(1).map((one) => within(one).getAllByRole('cell')[0]?.textContent)).toEqual(['–', '–']);
    fireEvent.click(screen.getByRole('button', { name: text('pwfs.board.moreLines.action') }));
    await waitFor(() => expect(screen.queryByTestId('no-ranking')).toBeNull());
    expect(names()).toEqual(['Người 3', 'Người 4', 'Người 1', 'Người 2']);
    expect(within(screen.getAllByRole('row')[1] as HTMLElement).getAllByRole('cell')[0]?.textContent).toBe('1');
  });

  it('says how many are shown of how many', async () => {
    open({ lines: linePage(people().slice(0, 2), { total: 7, next_cursor: 'abc' }) });
    await screen.findByRole('table');
    expect(screen.getByTestId('shown').textContent).toBe(text('pwfs.board.shown.text', { shown: 2, total: 7 }));
    expect(screen.getByRole('button', { name: text('pwfs.board.moreLines.action') })).toBeTruthy();
  });

  it('links each person to the detail of their line', async () => {
    open();
    await screen.findByRole('table');
    expect(within(screen.getByRole('table')).getByRole('link', { name: 'Người 3' }).getAttribute('href')).toBe(`/pwf/pwf-13?id=${uuid(5103)}`);
  });

  it('shows the snapshot hash and the window of the chosen period and changes period on request', async () => {
    const h = open();
    await screen.findByRole('table');
    expect(within(screen.getByTestId('period-facts')).getByText('ab12cd34ef56ab12')).toBeTruthy();
    fireEvent.change(screen.getByTestId('period'), { target: { value: uuid(5001) } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listStaffScoreLines', expect.objectContaining({ path: { id: uuid(5001) } })));
  });

  it('filters by state through the server', async () => {
    const h = open();
    await screen.findByRole('table');
    fireEvent.change(screen.getByTestId('filter-state'), { target: { value: 'SMALL_SAMPLE' } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listStaffScoreLines', expect.objectContaining({ query: expect.objectContaining({ state: 'SMALL_SAMPLE' }) })));
  });

  it('filters by unit only with a valid unit id and says so otherwise', async () => {
    const h = open();
    await screen.findByRole('table');
    fireEvent.change(screen.getByTestId('filter-unit'), { target: { value: 'not-an-id' } });
    expect((await screen.findByTestId('error-unit')).textContent).toContain(text('pwfs.board.filter.unit.error'));
    fireEvent.change(screen.getByTestId('filter-unit'), { target: { value: uuid(60).toUpperCase() } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listStaffScoreLines', expect.objectContaining({ query: expect.objectContaining({ unit_id: uuid(60) }) })));
  });
});

describe('PWF-12: the export', () => {
  it('asks the server for the file of the period and hands it to the browser', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const create = vi.fn(() => 'blob:file');
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    const h = open();
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: text('pwfs.board.export.action') }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(h.read).toHaveBeenCalledWith('exportStaffScorePeriod', { path: { id: PERIOD_ID }, query: { format: 'xlsx' } });
    expect(create).toHaveBeenCalled();
  });

  it('says the scope is denied when the server refuses the export, and leaves nothing to download', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    open({ exported: refusal('SCOPE_DENIED', 403) });
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: text('pwfs.board.export.action') }));
    expect((await screen.findByTestId('problem')).textContent).toContain(text('pwfs.problem.denied.error'));
    expect(click).not.toHaveBeenCalled();
  });

  it('has no export button for a membership without the export right', async () => {
    open({ permissions: ['staff_score.read_unit'] });
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: text('pwfs.board.export.action') })).toBeNull();
  });
});

describe('PWF-12: the states', () => {
  it('is denied without asking for a membership that holds only the right to its own score', () => {
    const h = open({ permissions: OWN_ONLY });
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });

  it('shows the empty state when there is no period in scope', async () => {
    open({ periods: periodPage([]) });
    expect(await screen.findByText(text('states.empty.title'))).toBeTruthy();
  });

  it('shows the error state when the periods cannot be read', async () => {
    open({ periods: refusal('INTERNAL', 500) });
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('shows the empty state of the table when a period has no line the caller may see', async () => {
    open({ lines: linePage([]) });
    expect(await screen.findByText(text('states.empty.title'))).toBeTruthy();
  });

  it('has no serious accessibility violation', async () => {
    open();
    await screen.findByRole('table');
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });
});
