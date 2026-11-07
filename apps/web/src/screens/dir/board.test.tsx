import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import BoardScreen from './BoardScreen';
import { UNIT_B, directive, harness, meeting, mount, overdueDirective, page, refusal, routeOf, summary, text, uuid } from './test-support';

afterEach(() => cleanup());

const ROUTE = routeOf('DIR-03');

/** The answers of the server: the summary, the meetings for the filter, and a list of directives by the status asked for. */
function server(lists: Record<string, unknown[]> = {}, nextOf: Record<string, string> = {}) {
  return (operation: string, input: unknown): unknown => {
    if (operation === 'getDirectiveSummary') return summary;
    if (operation === 'listSteeringMeetings') return page([meeting(1)]);
    if (operation === 'listDirectives') {
      const asked = (input as { query: { status?: string; cursor?: string } }).query;
      const status = asked.status ?? '';
      if (asked.cursor !== undefined) return page([directive(9, { id: uuid(299), code: 'GB-2026-001/CD-09' })]);
      return page(lists[status] ?? [], nextOf[status] ?? null);
    }
    return page([]);
  };
}
const tileOf = (label: string): HTMLElement => Array.from(document.querySelectorAll<HTMLElement>('.ui-kpi')).find((tile) => tile.textContent?.includes(label) === true) as HTMLElement;
const columns = (): string[] => Array.from(document.querySelectorAll('.dir-column')).map((column) => column.getAttribute('data-status') ?? '');

describe('DIR-03: the board of the directives', () => {
  it('shows the figures with their formula, one column for each status with the late one first, the cards with their clock, and the counts of the summary', async () => {
    const h = harness(server({ OVERDUE: [overdueDirective(1)], OPEN: [directive(2)], IN_PROGRESS: [directive(3, { status: 'IN_PROGRESS', stored_status: 'IN_PROGRESS' })], DONE: [], CANCELLED: [] }));
    mount(<BoardScreen route={ROUTE} />, h, { permissions: ['directive.read'] });
    expect(await screen.findByRole('link', { name: 'GB-2026-001/CD-01' })).toBeTruthy();
    expect(columns()).toEqual(['OVERDUE', 'OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED']);
    expect(within(tileOf(text('dir.board.tile.total.label'))).getByText('9')).toBeTruthy();
    expect(within(tileOf(text('dir.board.tile.overdue.label'))).getByText('2')).toBeTruthy();
    expect(within(tileOf(text('dir.board.tile.escalated.label'))).getByText('1')).toBeTruthy();
    expect(within(tileOf(text('dir.board.tile.soon.label'))).getByText('2')).toBeTruthy();
    expect(within(tileOf(text('dir.board.tile.open.label'))).getByText('5')).toBeTruthy();
    expect(within(tileOf(text('dir.board.tile.done.label'))).getByText('1')).toBeTruthy();
    expect(screen.getByTestId('count-OVERDUE').textContent).toBe('2');
    expect(screen.getByTestId('count-OPEN').textContent).toBe('3');
    expect(screen.getByTestId('count-CANCELLED').textContent).toBe('1');
    const card = screen.getByRole('link', { name: 'GB-2026-001/CD-01' }).closest('article') as HTMLElement;
    expect(within(card).getByText(text('dir.clock.late.text', { days: 5 }))).toBeTruthy();
    expect(within(card).getByText(text('dir.card.due.text', { day: '03/11/2026' }))).toBeTruthy();
    expect(within(card).getByText('DA-01')).toBeTruthy();
    expect(within(card).getByText('BQL1 · Nguyễn Văn A')).toBeTruthy();
    expect(card.closest('.dir-column')?.getAttribute('data-status')).toBe('OVERDUE');
    expect(h.read).toHaveBeenCalledWith('listDirectives', { query: { limit: 10, status: 'OVERDUE' } });
    expect(screen.getByTestId('policy-note').textContent).toContain(text('dir.policy.unverified.text'));
    expect(document.querySelector('.ui-context__asof')?.textContent).toContain('08/11/2026');
  });

  it('opens the "i" of a figure with its formula, source, time, owner and the version of the policy, and says the thresholds are not confirmed', async () => {
    mount(<BoardScreen route={ROUTE} />, harness(server()), { permissions: ['directive.read'] });
    const open = await screen.findByRole('button', { name: text('dir.info.open.label', { name: text('dir.board.tile.escalated.label') }) });
    fireEvent.click(open);
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText(summary.definitions.escalated)).toBeTruthy();
    expect(within(panel).getByText(text('dir.info.source.text'))).toBeTruthy();
    expect(within(panel).getByText(text('dir.policy.default.text'))).toBeTruthy();
    expect(within(panel).getByText(text('dir.info.unverified.text'))).toBeTruthy();
    expect(within(panel).getByText('03:00 08/11/2026')).toBeTruthy();
  });

  it('shows a skeleton for the figures and the columns while it reads, never a zero', () => {
    mount(<BoardScreen route={ROUTE} />, harness(server()), { permissions: ['directive.read'] });
    expect(document.querySelectorAll('.ui-kpi--loading').length).toBe(6);
    expect(screen.getAllByRole('status', { name: text('states.loading.label') }).length).toBe(5);
    expect(screen.queryByTestId('count-OVERDUE')).not.toBeNull();
    expect(screen.getByTestId('count-OVERDUE').textContent).not.toBe('0');
  });

  it('when the summary fails the figures say so with a retry and the columns still show their directives', async () => {
    const h = harness((operation, input) => (operation === 'getDirectiveSummary' ? new Error('boom') : server({ OVERDUE: [overdueDirective(1)] })(operation, input)));
    mount(<BoardScreen route={ROUTE} />, h, { permissions: ['directive.read'] });
    expect(await screen.findByRole('link', { name: 'GB-2026-001/CD-01' })).toBeTruthy();
    await waitFor(() => expect(document.querySelectorAll('.ui-kpi--error').length).toBe(6));
    expect(screen.queryByText('9')).toBeNull();
    // Without the summary a column says how many it shows, not a count it does not have.
    expect(screen.getByTestId('count-OVERDUE').textContent).toBe(text('dir.board.column.shown', { count: 1 }));
  });

  it('a column that fails says so with a retry and does not turn into "none"; the others go on', async () => {
    let fail = true;
    const h = harness((operation, input) => (operation === 'listDirectives' && (input as { query: { status?: string } }).query.status === 'DONE' && fail ? new Error('boom') : server({ OPEN: [directive(2)] })(operation, input)));
    mount(<BoardScreen route={ROUTE} />, h, { permissions: ['directive.read'] });
    expect(await screen.findByRole('link', { name: 'GB-2026-001/CD-02' })).toBeTruthy();
    const done = document.querySelector('.dir-column[data-status="DONE"]') as HTMLElement;
    expect(await within(done).findByRole('alert')).toBeTruthy();
    fail = false;
    fireEvent.click(within(done).getByRole('button', { name: text('states.retry.action') }));
    await waitFor(() => expect(within(done).queryByRole('alert')).toBeNull());
  });

  it('says a column is empty when it has no directive', async () => {
    mount(<BoardScreen route={ROUTE} />, harness(server()), { permissions: ['directive.read'] });
    const done = (await waitFor(() => document.querySelector('.dir-column[data-status="DONE"]') as HTMLElement)) as HTMLElement;
    expect(await within(done).findByText(text('states.empty.title'))).toBeTruthy();
  });

  it('shows a denial when the reader may not read the directives', async () => {
    mount(<BoardScreen route={ROUTE} />, harness(() => refusal('SCOPE_DENIED', 403)), { permissions: ['directive.read'] });
    expect((await screen.findAllByText(text('states.denied.title'))).length).toBeGreaterThan(0);
  });

  it('pages a column by the cursor of the server: more adds the next page below the first and the button goes when there is no more', async () => {
    const h = harness(server({ OPEN: [directive(2)] }, { OPEN: 'c2' }));
    mount(<BoardScreen route={ROUTE} />, h, { permissions: ['directive.read'] });
    const more = await screen.findByRole('button', { name: text('dir.board.column.more.action') });
    fireEvent.click(more);
    expect(await screen.findByRole('link', { name: 'GB-2026-001/CD-09' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'GB-2026-001/CD-02' })).toBeTruthy();
    expect(h.read).toHaveBeenCalledWith('listDirectives', { query: { limit: 10, status: 'OPEN', cursor: 'c2' } });
    expect(screen.queryByRole('button', { name: text('dir.board.column.more.action') })).toBeNull();
  });

  it('narrows by a status to the one column, by unit, project, meeting and the rest to the reads, and the summary follows only what it can', async () => {
    const h = harness(server({ DONE: [directive(4, { status: 'DONE', stored_status: 'DONE' })] }));
    mount(<BoardScreen route={ROUTE} />, h, { permissions: ['directive.read'] });
    await screen.findByTestId('board');
    fireEvent.change(screen.getByLabelText(text('dir.filter.status.label')), { target: { value: 'DONE' } });
    await waitFor(() => expect(columns()).toEqual(['DONE']));
    expect(await screen.findByRole('link', { name: 'GB-2026-001/CD-04' })).toBeTruthy();
    expect(screen.getByTestId('count-DONE').textContent).toBe('1');

    await screen.findByRole('option', { name: 'SXD · Sở Xây dựng' });
    fireEvent.change(screen.getByLabelText(text('dir.filter.unit.label')), { target: { value: UNIT_B } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('getDirectiveSummary', { query: { unit_id: UNIT_B } }));
    fireEvent.change(screen.getByLabelText(text('dir.filter.q.label')), { target: { value: 'mặt bằng' } });
    fireEvent.click(screen.getByLabelText(text('dir.filter.mine.label')));
    fireEvent.click(screen.getByLabelText(text('dir.filter.overdue.label')));
    fireEvent.change(screen.getByLabelText(text('dir.filter.dueFrom.label')), { target: { value: '2026-11-01' } });
    fireEvent.change(screen.getByLabelText(text('dir.filter.dueTo.label')), { target: { value: '2026-11-30' } });
    await waitFor(() =>
      expect(h.read).toHaveBeenCalledWith('listDirectives', { query: { limit: 10, status: 'DONE', unit_id: UNIT_B, assigned_to_me: true, overdue: true, q: 'mặt bằng', due_from: '2026-11-01', due_to: '2026-11-30' } }),
    );
    // A column does not show the total of the summary once a filter the summary cannot follow is set.
    await waitFor(() => expect(screen.getByTestId('count-DONE').textContent).toBe(text('dir.board.column.shown', { count: 1 })));
    fireEvent.click(screen.getAllByRole('button', { name: text('dir.filter.clear.action') })[0] as HTMLElement);
    await waitFor(() => expect(columns().length).toBe(5));
  });

  it('shows the directives by the unit that must do them and opens a unit on the board', async () => {
    const h = harness(server({ OPEN: [directive(2)] }));
    mount(<BoardScreen route={ROUTE} />, h, { permissions: ['directive.read'] });
    await screen.findByTestId('board');
    fireEvent.click(screen.getByRole('button', { name: text('dir.board.view.unit') }));
    expect(screen.queryByTestId('board')).toBeNull();
    const table = within(await screen.findByRole('table'));
    const row = table.getByText('SXD · Sở Xây dựng').closest('tr') as HTMLElement;
    expect(within(row).getByText('3')).toBeTruthy();
    const first = table.getByText('BQL1 · Ban quản lý 1').closest('tr') as HTMLElement;
    expect(within(first).getByText('6')).toBeTruthy();
    expect(within(first).getByText('2')).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: text('dir.byUnit.show.action') }));
    expect(await screen.findByTestId('board')).toBeTruthy();
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listDirectives', { query: { limit: 10, status: 'OPEN', unit_id: UNIT_B } }));
  });

  it('says a count that was cut: the figures are a lower bound', async () => {
    mount(<BoardScreen route={ROUTE} />, harness((operation, input) => (operation === 'getDirectiveSummary' ? { ...summary, truncated: true } : server()(operation, input))), { permissions: ['directive.read'] });
    expect(await screen.findByText(text('dir.board.truncated.text'))).toBeTruthy();
  });
});
