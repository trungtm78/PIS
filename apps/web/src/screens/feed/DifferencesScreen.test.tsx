import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../i18n';
import DifferencesScreen from './DifferencesScreen';
import { addDays, vietnamStamp, vietnamToday } from './feed-model';
import { AS_OF, OTHER, client, connection, difference, differenceId, mountScreen, problem, quality, resolvedDifference, routeOf, word, world } from './test/feed-test-support';
import type { MountOptions, World } from './test/feed-test-support';

const ROUTE = routeOf('FEED-04');

// The fixtures of the worklist are drawn around AS_OF (a difference due on the 13th is not yet late, one due on the 1st is): the clock of the test is that day, not the day the suite runs.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(AS_OF));
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  translator.setLocale('vi');
  vi.restoreAllMocks();
});

interface Options extends MountOptions {
  world?: Partial<World>;
  command?: (operation: string, input: unknown) => unknown;
}

const RECONCILED = { operation_id: 'o', status: 'COMPLETED', resource_version: 1, resource_id: 'r', fiscal_year: 2026, projects_compared: 30, figures_compared: 90, existing: 2, skipped_owner_is_maker: [], opened: [difference(8), difference(9, { large: false })] };

function open(options: Options = {}) {
  const state = world(options.world);
  const h = client(state, options.command ?? ((operation) => (operation === 'runFinanceFeedReconciliation' ? RECONCILED : { operation_id: 'o', status: 'RESOLVED', resource_version: 3 })));
  const mounted = mountScreen(<DifferencesScreen route={ROUTE} />, h, options);
  return { h, state, ...mounted };
}

const rowsOf = (): HTMLElement[] => Array.from(document.querySelectorAll('tr[data-difference-id]')) as HTMLElement[];
const loaded = async (): Promise<void> => {
  await waitFor(() => expect(rowsOf().length).toBeGreaterThan(0));
};
const dialog = (): HTMLElement => screen.getByRole('dialog');
const reason = (text: string): void => {
  fireEvent.change(within(dialog()).getByRole('textbox', { name: /Lý do/ }), { target: { value: text } });
};
const kind = (value: string): void => {
  fireEvent.change(within(dialog()).getByLabelText(word('feed.diff.resolve.kind.label')), { target: { value } });
};
const resolveButton = (row: HTMLElement, code = 'FIN-0001', field = word('feed.diff.field.disbursedVsDis')): HTMLElement => within(row).getByRole('button', { name: word('feed.diff.action.resolve.label', { code, field }) });
const confirm = (): HTMLButtonElement => within(dialog()).getByRole('button', { name: word('feed.diff.resolve.confirm.action') }) as HTMLButtonElement;

describe('DifferencesScreen (FEED-04): the worklist', () => {
  it('AC-ST-FEED-001-7 / UI-FEED-04: lists each difference with the feed value, our value, the delta, the delta in percent, the size, the owner and the due day', async () => {
    open();
    await loaded();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('feed.diff.page.title'));
    expect(screen.getByTestId('maker-note').textContent).toBe(word('feed.diff.note.maker'));
    const rows = rowsOf();
    expect(rows).toHaveLength(3);
    const first = within(rows[0] as HTMLElement);
    expect(first.getByText('FIN-0001')).toBeTruthy();
    expect(first.getByText('DA-1')).toBeTruthy();
    expect(first.getByText(word('feed.diff.field.disbursedVsDis'))).toBeTruthy();
    expect(first.getByText('1.500.000.000')).toBeTruthy();
    expect(first.getByText('1.200.000.000')).toBeTruthy();
    expect(first.getByText('300.000.000')).toBeTruthy();
    expect(first.getByText('25%')).toBeTruthy();
    expect(first.getByText(word('feed.diff.size.large'))).toBeTruthy();
    expect(first.getByText('Lê Thị Hoa')).toBeTruthy();
    expect(first.getByText('13/11/2026')).toBeTruthy();
    expect(first.getByText(word('feed.diff.state.open'))).toBeTruthy();
    expect(rows[0]?.getAttribute('data-large')).toBe('true');
  });

  it('marks an open difference past its due day as overdue, in words', async () => {
    open({ world: { differences: [difference(1, { due_at: '2000-01-01T00:00:00.000Z' }), difference(2)] } });
    await loaded();
    expect(within(rowsOf()[0] as HTMLElement).getByTestId('overdue').textContent).toBe(word('feed.diff.due.overdue', { day: '01/01/2000' }));
    expect(within(rowsOf()[1] as HTMLElement).queryByTestId('overdue')).toBeNull();
  });

  it('shows what was decided on a settled difference: how, by whom, the reason, the evidence and the day to review', async () => {
    open({ world: { differences: [resolvedDifference(3), resolvedDifference(4, { resolution: { kind: 'WAIVE', resolved_by_name: 'Lê Thị Hoa', resolved_at: '2026-11-07T03:00:00.000Z', reason: 'Chờ Sở gửi bản đối soát', evidence_ref: null, review_on: '2027-01-15' } })] } });
    await loaded();
    const dispute = within(within(rowsOf()[0] as HTMLElement).getByTestId('resolution'));
    expect(dispute.getByText(word('feed.diff.resolution.dispute'))).toBeTruthy();
    expect(dispute.getByText(word('feed.diff.resolution.by', { name: 'Nguyễn Văn An', day: '07/11/2026' }))).toBeTruthy();
    expect(dispute.getByText(word('feed.diff.resolution.reason', { reason: 'Số của Sở chưa tính đợt hai' }))).toBeTruthy();
    expect(dispute.getByText(word('feed.diff.resolution.evidence', { ref: 'CV-123/STC' }))).toBeTruthy();
    const waived = within(within(rowsOf()[1] as HTMLElement).getByTestId('resolution'));
    expect(waived.getByText(word('feed.diff.resolution.review', { day: '15/01/2027' }))).toBeTruthy();
    expect(within(rowsOf()[0] as HTMLElement).queryByRole('button', { name: /Xử lý chênh lệch/ })).toBeNull();
  });

  it('says a figure we do not have is missing, not zero', async () => {
    open({ world: { differences: [difference(1, { kind: 'MISSING_OURS', our_value: null, delta: null, delta_pct: null, our_code: null })] } });
    await loaded();
    const row = within(rowsOf()[0] as HTMLElement);
    expect(row.getByText(word('feed.diff.cell.missingOurs'))).toBeTruthy();
    expect(row.getByText(word('feed.diff.cell.noOurCode'))).toBeTruthy();
  });

  it('shows the four counts, each with its "i" with the formula, the source and the moment', async () => {
    open();
    await loaded();
    const strip = within(screen.getByRole('group', { name: word('feed.diff.counts.group.label') }));
    expect(strip.getByText(word('feed.diff.counts.open.label')).closest('article')?.textContent).toContain('2');
    expect(strip.getByText(word('feed.diff.counts.large.label')).closest('article')?.textContent).toContain('1');
    expect(strip.getByText(word('feed.diff.counts.resolved.label')).closest('article')?.textContent).toContain('1');
    expect(strip.getByText(word('feed.diff.counts.compared.label')).closest('article')?.textContent).toContain('120');
    fireEvent.click(strip.getByRole('button', { name: word('feed.common.info.open.label', { name: word('feed.diff.counts.large.label') }) }));
    const panel = screen.getByRole('dialog', { name: word('feed.diff.counts.large.label') });
    expect(panel.querySelector('[data-field="formula"] dd')?.textContent).toBe(word('feed.diff.figure.large.formula'));
    expect(panel.querySelector('[data-field="source"] dd')?.textContent).toBe(word('feed.diff.figure.source'));
    expect(panel.querySelector('[data-field="asOf"] dd')?.textContent).toBe(vietnamStamp(AS_OF));
  });

  it('opens the "i" of a delta with the formula', async () => {
    open();
    await loaded();
    fireEvent.click(within(rowsOf()[0] as HTMLElement).getByRole('button', { name: word('feed.common.info.open.label', { name: word('feed.diff.figure.delta.name') }) }));
    expect(screen.getByRole('dialog', { name: word('feed.diff.figure.delta.name') }).querySelector('[data-field="formula"] dd')?.textContent).toBe(word('feed.diff.figure.delta.formula'));
  });

  it('filters by state, by size, by year and by project code, in the address', async () => {
    const { h } = open();
    await loaded();
    fireEvent.change(screen.getByLabelText(word('feed.diff.filter.state.label')), { target: { value: 'RESOLVED' } });
    await waitFor(() => expect(rowsOf()).toHaveLength(1));
    fireEvent.change(screen.getByLabelText(word('feed.diff.filter.state.label')), { target: { value: 'OPEN' } });
    fireEvent.change(screen.getByLabelText(word('feed.diff.filter.large.label')), { target: { value: 'true' } });
    await waitFor(() => expect(rowsOf().map((row) => row.getAttribute('data-large'))).toEqual(['true']));
    fireEvent.change(screen.getByLabelText(word('feed.diff.filter.year.label')), { target: { value: '2027' } });
    fireEvent.click(screen.getByRole('button', { name: word('feed.diff.filter.apply.action') }));
    await waitFor(() => expect(rowsOf()).toHaveLength(0));
    expect(h.read.mock.calls.some(([operation, input]) => operation === 'listFinanceFeedDifferences' && (input as { query: { fiscal_year?: number } }).query.fiscal_year === 2027)).toBe(true);
    fireEvent.change(screen.getByLabelText(word('feed.diff.filter.year.label')), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(word('feed.diff.filter.q.label')), { target: { value: 'FIN-0002' } });
    fireEvent.click(screen.getByRole('button', { name: word('feed.diff.filter.apply.action') }));
    await waitFor(() => expect(rowsOf()).toHaveLength(0));
  });

  it('starts from the filter in the address', async () => {
    open({ path: '/?state=RESOLVED' });
    await waitFor(() => expect(rowsOf()).toHaveLength(1));
    expect((screen.getByLabelText(word('feed.diff.filter.state.label')) as HTMLSelectElement).value).toBe('RESOLVED');
  });

  it('pages: load more appends the next page', async () => {
    open({ world: { pageSize: 2 } });
    await loaded();
    expect(rowsOf()).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: word('feed.common.paging.more') }));
    await waitFor(() => expect(rowsOf()).toHaveLength(3));
  });
});

describe('DifferencesScreen (FEED-04): the comparison for a fiscal year', () => {
  const year = (): HTMLInputElement => screen.getByLabelText(word('feed.diff.reconcile.year.label')) as HTMLInputElement;
  const run = (): HTMLElement => screen.getByRole('button', { name: word('feed.diff.reconcile.run.action') });

  it('proposes the fiscal year of the feed, runs the comparison and says what it opened', async () => {
    const { h } = open({ world: { connection: connection({ quality: quality({ fiscal_year: 2025 }) }) } });
    await waitFor(() => expect(year().value).toBe('2025'));
    fireEvent.change(year(), { target: { value: '2026' } });
    fireEvent.click(run());
    const result = await screen.findByTestId('reconcile-result');
    expect(result.textContent).toContain(word('feed.diff.reconcile.result.text', { year: 2026, projects: '30', figures: '90', opened: '2', large: '1', existing: '2' }));
    const [operation, input] = h.command.mock.calls[0] as [string, { body: unknown }];
    expect(operation).toBe('runFinanceFeedReconciliation');
    expect(input.body).toEqual({ fiscal_year: 2026 });
  });

  it('sends the owner when one is named and checks the fields before it sends', async () => {
    const { h } = open();
    await loaded();
    fireEvent.change(year(), { target: { value: '26' } });
    fireEvent.change(screen.getByLabelText(word('feed.diff.reconcile.owner.label')), { target: { value: 'ai đó' } });
    fireEvent.click(run());
    expect(screen.getByText(word('feed.diff.reconcile.issue.range'))).toBeTruthy();
    expect(screen.getByText(word('feed.diff.reconcile.issue.invalid'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(year(), { target: { value: '2026' } });
    fireEvent.change(screen.getByLabelText(word('feed.diff.reconcile.owner.label')), { target: { value: OTHER } });
    fireEvent.click(run());
    await screen.findByTestId('reconcile-result');
    expect((h.command.mock.calls[0] as [string, { body: unknown }])[1].body).toEqual({ fiscal_year: 2026, owner_id: OTHER });
  });

  it('says the projects skipped because the owner made the figures', async () => {
    open({ command: () => ({ ...RECONCILED, skipped_owner_is_maker: ['FIN-0007', 'FIN-0008'] }) });
    await loaded();
    fireEvent.click(run());
    expect((await screen.findByTestId('reconcile-skipped')).textContent).toBe(word('feed.diff.reconcile.skipped.text', { count: 2 }));
  });

  it('says in place why the server refused the comparison', async () => {
    open({ command: () => problem('VALIDATION_FAILED', 422, 'owner_id') });
    await loaded();
    fireEvent.click(run());
    expect((await screen.findByTestId('problem')).textContent).toContain(word('feed.common.problem.validation', { field: 'owner_id' }));
    expect(screen.queryByTestId('reconcile-result')).toBeNull();
  });

  it('offers no comparison to a person who may not run it, or in a read-only workspace', async () => {
    open({ world: { connection: connection({}, { reconcile: false }) } });
    expect((await screen.findByTestId('reconcile-blocked')).textContent).toBe(word('feed.diff.reconcile.blocked.text'));
    cleanup();
    open({ mode: 'READ_ONLY' });
    expect((await screen.findByTestId('reconcile-blocked')).textContent).toBe(word('feed.diff.reconcile.blocked.text'));
  });
});

describe('DifferencesScreen (FEED-04): settling a difference', () => {
  it('offers the button only on an open difference that the person may settle, and tells a maker why not', async () => {
    open({ world: { differences: [difference(1), difference(2, { can_resolve: false }), resolvedDifference(3)] } });
    await loaded();
    expect(resolveButton(rowsOf()[0] as HTMLElement)).toBeTruthy();
    expect(within(rowsOf()[1] as HTMLElement).queryByRole('button', { name: /Xử lý chênh lệch/ })).toBeNull();
    expect(within(rowsOf()[1] as HTMLElement).getByTestId('maker-words').textContent).toBe(word('feed.diff.row.makerWords'));
  });

  it('accepts the feed with a reason of ten characters, under the version the person saw, and reads the lists again', async () => {
    const { h } = open();
    await loaded();
    fireEvent.click(resolveButton(rowsOf()[0] as HTMLElement));
    expect(within(dialog()).getByText(word('feed.diff.resolve.maker.note'))).toBeTruthy();
    kind('ACCEPT_FEED');
    expect(within(dialog()).getByTestId('resolve-effect').textContent).toBe(word('feed.diff.effect.acceptFeed'));
    reason('Đã kiểm tra sổ');
    const before = h.read.mock.calls.length;
    fireEvent.click(confirm());
    expect((await screen.findByTestId('receipt')).textContent).toBe(word('feed.diff.success.resolved', { code: 'FIN-0001', how: word('feed.diff.resolution.acceptFeed') }));
    const [operation, input] = h.command.mock.calls[0] as [string, { path: { id: string }; body: unknown; ifMatchVersion: number }];
    expect(operation).toBe('resolveFinanceFeedDifference');
    expect(input.path.id).toBe(differenceId(1));
    expect(input.body).toEqual({ kind: 'ACCEPT_FEED', reason: 'Đã kiểm tra sổ' });
    expect(input.ifMatchVersion).toBe(2);
    await waitFor(() => expect(h.read.mock.calls.length).toBeGreaterThan(before));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks for a kind before it sends', async () => {
    const { h } = open();
    await loaded();
    fireEvent.click(resolveButton(rowsOf()[0] as HTMLElement));
    reason('Đã kiểm tra sổ kỹ càng');
    fireEvent.click(confirm());
    expect(within(dialog()).getAllByText(word('feed.diff.issue.kind')).length).toBeGreaterThan(0);
    expect(within(dialog()).getByRole('alert').textContent).toBe(word('feed.diff.invalid.summary'));
    expect(h.command).not.toHaveBeenCalled();
  });

  it('needs a reference to the evidence and twenty characters for a dispute', async () => {
    const { h } = open();
    await loaded();
    fireEvent.click(resolveButton(rowsOf()[0] as HTMLElement));
    kind('DISPUTE');
    expect(within(dialog()).getByText(word('feed.diff.resolve.reason.hint', { count: 20 }))).toBeTruthy();
    reason('Mười chín ký tự thôi');
    expect(confirm().disabled).toBe(false);
    reason('Số của Sở chưa tính đợt hai của quý');
    fireEvent.click(confirm());
    expect(within(dialog()).getByText(word('feed.diff.issue.required'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(dialog()).getByLabelText(word('feed.diff.resolve.evidence.label')), { target: { value: ' CV-123/STC ' } });
    fireEvent.click(confirm());
    await screen.findByTestId('receipt');
    expect((h.command.mock.calls[0] as [string, { body: unknown }])[1].body).toEqual({ kind: 'DISPUTE', reason: 'Số của Sở chưa tính đợt hai của quý', evidence_ref: 'CV-123/STC' });
  });

  it('needs a day to review inside one year for a waiver, and sends it', async () => {
    const { h } = open();
    await loaded();
    fireEvent.click(resolveButton(rowsOf()[0] as HTMLElement));
    kind('WAIVE');
    reason('Chờ Sở gửi bản đối soát tháng sau');
    const day = within(dialog()).getByLabelText(word('feed.diff.resolve.review.label'));
    fireEvent.click(confirm());
    expect(within(dialog()).getByText(word('feed.diff.issue.required'))).toBeTruthy();
    fireEvent.change(day, { target: { value: vietnamToday() } });
    fireEvent.click(confirm());
    expect(within(dialog()).getByText(word('feed.diff.issue.past'))).toBeTruthy();
    fireEvent.change(day, { target: { value: addDays(vietnamToday(), 400) } });
    fireEvent.click(confirm());
    expect(within(dialog()).getByText(word('feed.diff.issue.far'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    const review = addDays(vietnamToday(), 30);
    fireEvent.change(day, { target: { value: review } });
    fireEvent.click(confirm());
    await screen.findByTestId('receipt');
    expect((h.command.mock.calls[0] as [string, { body: unknown }])[1].body).toEqual({ kind: 'WAIVE', reason: 'Chờ Sở gửi bản đối soát tháng sau', review_on: review });
  });

  it('keeps our figure with a reason', async () => {
    const { h } = open();
    await loaded();
    fireEvent.click(resolveButton(rowsOf()[0] as HTMLElement));
    kind('KEEP_OURS');
    reason('Số của ta khớp báo cáo kho bạc');
    fireEvent.click(confirm());
    await screen.findByTestId('receipt');
    expect((h.command.mock.calls[0] as [string, { body: { kind: string } }])[1].body.kind).toBe('KEEP_OURS');
  });

  it.each([
    ['SELF_APPROVAL_DENIED', 403, word('feed.common.problem.selfApproval')],
    ['FEED_DIFFERENCE_STATE_INVALID', 409, word('feed.common.problem.differenceState')],
    ['RESOURCE_NOT_FOUND', 404, word('feed.common.problem.notFound')],
  ])('says in the dialog why the server refused: %s', async (code, status, expected) => {
    open({ command: () => problem(code, status) });
    await loaded();
    fireEvent.click(resolveButton(rowsOf()[0] as HTMLElement));
    kind('ACCEPT_FEED');
    reason('Đã kiểm tra sổ');
    fireEvent.click(confirm());
    expect((await within(dialog()).findByRole('alert')).textContent).toContain(expected);
    expect(screen.queryByTestId('receipt')).toBeNull();
  });

  it('says the field the server names, and offers the reload when the version moved', async () => {
    open({ command: () => problem('VALIDATION_FAILED', 422, 'evidence_ref') });
    await loaded();
    fireEvent.click(resolveButton(rowsOf()[0] as HTMLElement));
    kind('DISPUTE');
    reason('Số của Sở chưa tính đợt hai của quý');
    fireEvent.change(within(dialog()).getByLabelText(word('feed.diff.resolve.evidence.label')), { target: { value: 'CV-1' } });
    fireEvent.click(confirm());
    await waitFor(() => expect(within(dialog()).getByLabelText(word('feed.diff.resolve.evidence.label')).getAttribute('aria-invalid')).toBe('true'));
    cleanup();
    const { h } = open({ command: () => problem('VERSION_CONFLICT', 409) });
    await loaded();
    fireEvent.click(resolveButton(rowsOf()[0] as HTMLElement));
    kind('ACCEPT_FEED');
    reason('Đã kiểm tra sổ');
    fireEvent.click(confirm());
    await within(dialog()).findByText(word('feed.common.problem.versionConflict'));
    const before = h.read.mock.calls.length;
    fireEvent.click(within(dialog()).getByRole('button', { name: word('feed.common.problem.reload.action') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(h.read.mock.calls.length).toBeGreaterThan(before));
  });

  it('says in a read-only workspace that nothing can be settled', async () => {
    open({ mode: 'READ_ONLY' });
    await loaded();
    expect(screen.queryByRole('button', { name: /Xử lý chênh lệch/ })).toBeNull();
    expect(screen.getByTestId('readonly-note').textContent).toBe(word('feed.common.readonly.mode'));
  });
});

describe('DifferencesScreen (FEED-04): the states', () => {
  it('shows loading, then the empty state', async () => {
    const state = world();
    state.hanging.add('listFinanceFeedDifferences');
    mountScreen(<DifferencesScreen route={ROUTE} />, client(state));
    expect((await screen.findByTestId('loading')).getAttribute('aria-busy')).toBe('true');
    cleanup();
    open({ world: { differences: [] } });
    expect((await screen.findByTestId('empty')).textContent).toContain(word('feed.diff.empty.title'));
  });

  it('shows an error with a new try', async () => {
    const { state } = open({ world: { failing: new Map([['listFinanceFeedDifferences', new Error('down')]]) } });
    const error = await screen.findByTestId('error');
    state.failing.clear();
    fireEvent.click(within(error).getByRole('button', { name: word('states.retry.action') }));
    await loaded();
  });

  it('shows the forbidden card for a 403 and none of the commands', async () => {
    open({ world: { failing: new Map([['listFinanceFeedDifferences', problem('SCOPE_DENIED', 403)]]) } });
    expect((await screen.findByTestId('denied')).textContent).toContain(word('feed.common.state.denied.title'));
    expect(screen.queryByRole('button', { name: word('feed.diff.reconcile.run.action') })).toBeNull();
  });

  it('keeps the differences and says the refresh failed (stale)', async () => {
    const { queries, state } = open();
    await loaded();
    state.failing.set('listFinanceFeedDifferences', new Error('down'));
    await act(async () => {
      await queries.invalidateQueries({ predicate: (query) => query.queryKey.includes('differences') });
    });
    expect((await screen.findByTestId('stale')).textContent).toContain(word('feed.common.state.stale.text', { time: vietnamStamp(AS_OF) }));
    expect(rowsOf()).toHaveLength(3);
  });
});
