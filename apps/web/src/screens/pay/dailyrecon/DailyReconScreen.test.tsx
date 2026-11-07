import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import parts from '../../../i18n/vi.json';
import DailyReconScreen from './DailyReconScreen';
import { READER, RESOLVER, RUNNER, client, commandsOf, documentId, item, itemAnswer, itemId, line, lineId, member, memberId, mount, routeOf, run, runAnswer, runId, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('PAY-20', 'FR-PAY-20');
const catalogue = { ...vi_, ...parts } as Record<string, string>;
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), catalogue[key] ?? key);
const refusal = (code: string, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions: {} });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(state: World, options: { permissions?: readonly string[]; mode?: 'FULL' | 'READ_ONLY'; command?: (operation: string, input: unknown) => unknown } = {}) {
  const h = client(state, options.command);
  mount(<DailyReconScreen route={ROUTE} />, h, { permissions: options.permissions ?? RUNNER, path: '/pay/pay-20', ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

const dayRow = (day: string): HTMLElement => document.querySelector(`[data-day="${day}"]`) as HTMLElement;
/** The days are shown once the read of the range has answered. */
const daysShown = async (): Promise<void> => {
  await screen.findByTestId('days');
  await waitFor(() => expect(document.querySelectorAll('[data-day]').length).toBeGreaterThan(0));
};
const itemRow = (id: string): HTMLElement => (document.querySelector(`[data-item="${id}"]`)?.closest('tr') ?? null) as HTMLElement;
const figureOf = (label: string): string | null | undefined => screen.getByText(label).closest('article')?.querySelector('.ui-kpi__value')?.textContent;
const dialog = (): HTMLElement => screen.getByRole('dialog');

describe('DailyReconScreen (PAY-20): the daily reconciliation with the Treasury', () => {
  it('UI-PAY-20: shows the thresholds with where they come from and that nobody confirmed them, what the board counts, and the days with the state of each', async () => {
    const partialDay = { recon_date: '2026-11-05', status: 'PARTIAL', partial_reason: 'STATEMENT_MISSING', run_no: 1, run_id: runId(2) };
    open(world({ days: [partialDay, { recon_date: '2026-11-06', status: 'COMPLETE', partial_reason: null, run_no: 2, run_id: runId(1) }], runs: [run(1), run(2, { status: 'PARTIAL', partial_reason: 'STATEMENT_MISSING' })] }));
    await daysShown();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(parts['govd.recon.title']);
    expect(screen.getByText(text('govd.recon.footer', { id: 'PAY-20', req: 'FR-PAY-20' }))).toBeTruthy();
    const rule = screen.getByTestId('rule');
    expect(rule.getAttribute('data-source')).toBe('DEFAULT');
    expect(rule.getAttribute('data-unverified')).toBe('yes');
    expect(rule.textContent).toContain(parts['govd.recon.rule.default']);
    expect(rule.textContent).toContain(text('govd.recon.rule.numbers', { threshold: '1.000.000', days: 3, grace: 1 }));
    expect(screen.getByTestId('rule-unverified').textContent).toBe(parts['govd.recon.rule.unverified']);
    expect(figureOf(parts['govd.recon.kpi.waiting'])).toBe('1');
    expect(figureOf(parts['govd.recon.kpi.overdue'])).toBe('0');
    expect(figureOf(parts['govd.recon.kpi.difference'])).toBe('+3.000.000');
    // The latest 14 days, today first; a day with no pass says so and is never "no difference".
    expect(document.querySelectorAll('[data-day]')).toHaveLength(14);
    expect(within(dayRow('2026-11-09')).getByTestId('day-state').getAttribute('data-state')).toBe('NO_RUN');
    expect(within(dayRow('2026-11-09')).getByTestId('day-reason').textContent).toBe(parts['govd.recon.days.noRunHint']);
    expect(within(dayRow('2026-11-06')).getByTestId('day-state').textContent).toBe(parts['govd.recon.days.state.complete']);
    expect(within(dayRow('2026-11-05')).getByTestId('day-state').textContent).toBe(parts['govd.recon.days.state.partial']);
    expect(within(dayRow('2026-11-05')).getByTestId('day-reason').textContent).toBe(parts['govd.recon.days.reason.statementMissing']);
  });

  it('opens a pass to see its lines: books and Treasury, the signed difference, the kind, the item it opens, and the figures of a project the caller may not see are said to be hidden', async () => {
    const state = world();
    state.details[runId(1)] = { lines: state.details[runId(1)]?.lines ?? [], hidden: 2 };
    const h = open(state);
    await daysShown();
    fireEvent.click(within(dayRow('2026-11-06')).getByRole('button', { name: parts['govd.recon.days.open'] }));
    await screen.findByTestId('lines');
    const first = document.querySelector(`[data-line="${lineId(1)}"]`) as HTMLElement;
    expect(within(first).getByTestId('line-project').textContent).toBe('DA-A-001');
    expect(within(first).getByTestId('line-fund').textContent).toBe('Ngân sách nhà nước');
    expect(within(first).getByTestId('line-books').textContent).toBe('5.000.000');
    expect(within(first).getByTestId('line-treasury').textContent).toBe('8.000.000');
    expect(within(first).getByTestId('line-difference').textContent).toBe('+3.000.000');
    expect(within(first).getByTestId('line-kind').textContent).toContain(parts['govd.recon.kind.amount']);
    expect(within(first).getByTestId('line-kind').textContent).toContain(parts['govd.recon.lines.opens']);
    const second = document.querySelector(`[data-line="${lineId(2)}"]`) as HTMLElement;
    expect(within(second).getByTestId('line-fund').textContent).toBe('ODA');
    expect(within(second).getByTestId('line-kind').getAttribute('data-kind')).toBe('MISSING_INTERNAL');
    const equal = document.querySelector(`[data-line="${lineId(3)}"]`) as HTMLElement;
    expect(within(equal).getByTestId('line-kind').textContent).toBe('');
    expect(screen.getByTestId('differing').textContent).toBe(text('govd.recon.lines.differing', { count: 2 }));
    expect(screen.getByTestId('hidden-lines').textContent).toBe(text('govd.recon.lines.hidden', { count: 2 }));
    expect(screen.getByTestId('run-summary').textContent).toContain(text('govd.recon.run.summary', { no: 1, day: '2026-11-06', lines: 3, imports: 1 }));
    expect(screen.queryByTestId('partial')).toBeNull();
    expect(h.read).toHaveBeenCalledWith('getTreasuryDailyReconRun', { path: { id: runId(1) } });
  });

  it('a partial pass says so in words, and an empty partial pass never reads as "no difference"', async () => {
    const state = world({ runs: [run(1, { status: 'PARTIAL', partial_reason: 'STATEMENT_MISSING', line_count: 0, books_total_vnd: '0', treasury_total_vnd: '0', calendar_basis: 'WEEKDAYS_ASSUMED' })] });
    state.details[runId(1)] = { lines: [] };
    open(state);
    await daysShown();
    fireEvent.click(within(dayRow('2026-11-06')).getByRole('button', { name: parts['govd.recon.days.open'] }));
    expect((await screen.findByTestId('partial')).textContent).toBe(text('govd.recon.partial.statementMissing', { day: '2026-11-06' }));
    expect(screen.getByTestId('no-lines').textContent).toBe(parts['govd.recon.lines.emptyPartial']);
    expect(screen.getByTestId('calendar-assumed').textContent).toBe(parts['govd.recon.run.calendarAssumed']);
    expect(screen.queryByTestId('lines')).toBeNull();
  });

  it('an unreadable source is worded apart, and a pass that vanished says so', async () => {
    const state = world({ runs: [run(1, { status: 'PARTIAL', partial_reason: 'SOURCE_UNREADABLE' })] });
    open(state);
    await daysShown();
    fireEvent.click(within(dayRow('2026-11-06')).getByRole('button', { name: parts['govd.recon.days.open'] }));
    expect((await screen.findByTestId('partial')).textContent).toBe(text('govd.recon.partial.sourceUnreadable', { day: '2026-11-06' }));
    cleanup();
    const gone = world();
    delete gone.details[runId(1)];
    open(gone);
    await daysShown();
    fireEvent.click(within(dayRow('2026-11-06')).getByRole('button', { name: parts['govd.recon.days.open'] }));
    expect((await screen.findByTestId('lines-missing')).textContent).toBe(parts['govd.recon.lines.missing']);
  });

  it('shows each item with both figures it was opened with, the signed difference, the owner, the due day and a word when it is overdue', async () => {
    const overdue = item(2, { overdue: true, due_on: '2026-11-04', status: 'EXPLAINED', kind: 'MISSING_ON_TREASURY', difference_vnd: '-4000000', latest_difference_vnd: '-4000000', owner_name: null });
    open(world({ items: [item(1), overdue], summary: { waiting: 2, overdue: 1, waiting_difference_vnd: '-1000000' } }), { permissions: READER });
    await screen.findByTestId('items');
    const first = itemRow(itemId(1));
    expect(within(first).getByTestId('item-project').textContent).toBe('DA-A-001');
    expect(within(first).getByTestId('item-fund').textContent).toBe('Ngân sách nhà nước');
    expect(within(first).getByTestId('item-day').textContent).toBe('2026-11-06');
    expect(within(first).getByTestId('item-kind').textContent).toBe(parts['govd.recon.kind.amount']);
    expect(within(first).getByTestId('item-books').textContent).toBe('5.000.000');
    expect(within(first).getByTestId('item-treasury').textContent).toBe('8.000.000');
    expect(within(first).getByTestId('item-difference').textContent).toBe('+3.000.000');
    expect(within(first).getByTestId('item-owner').textContent).toBe('Kế toán trưởng');
    expect(within(first).getByTestId('item-due').textContent).toBe('2026-11-11');
    expect(within(first).queryByTestId('item-overdue')).toBeNull();
    const second = itemRow(itemId(2));
    expect(within(second).getByTestId('item-overdue').textContent?.trim()).toBe(parts['govd.recon.items.overdue']);
    expect(within(second).getByTestId('item-difference').textContent).toBe('-4.000.000');
    expect(within(second).getByTestId('item-owner').textContent).toBe(memberId(1));
    expect(within(second).getByTestId('item-status').textContent).toBe(parts['govd.recon.status.explained']);
    expect(figureOf(parts['govd.recon.kpi.overdue'])).toBe('1');
    // A reader without the commands sees no button.
    expect(document.querySelector('button[data-action]')).toBeNull();
  });

  it('narrows the items by status and tells the state of an empty list and of a failed one', async () => {
    const h = open(world({ items: [item(1), item(2, { status: 'RESOLVED' })] }), { permissions: READER });
    await screen.findByTestId('items');
    fireEvent.change(screen.getByLabelText(parts['govd.recon.filter.status']), { target: { value: 'RESOLVED' } });
    await waitFor(() => expect(itemRow(itemId(1))).toBeNull());
    expect(itemRow(itemId(2))).not.toBeNull();
    expect(h.read.mock.calls.some((call) => (call[1] as { query?: { status?: string } } | undefined)?.query?.status === 'RESOLVED')).toBe(true);
    cleanup();
    open(world({ items: [] }), { permissions: READER });
    expect((await screen.findByTestId('nothing')).textContent).toBe(parts['govd.recon.items.empty']);
    cleanup();
    open(world({ failing: new Set(['listTreasuryDailyReconItems']) }), { permissions: READER });
    expect((await screen.findByTestId('items-failed')).textContent).toBe(parts['govd.recon.items.failed']);
  });

  describe('the states of the screen', () => {
    it('loading shows the skeleton and no number', async () => {
      const h = client(world());
      h.read.mockImplementation(() => new Promise(() => undefined));
      mount(<DailyReconScreen route={ROUTE} />, h, { permissions: RUNNER, path: '/pay/pay-20' });
      expect(await screen.findByLabelText(vi_['states.loading.label'])).toBeTruthy();
      expect(screen.queryByTestId('days')).toBeNull();
    });

    it('an error shows the card with a retry that reads again', async () => {
      const state = world({ failing: new Set(['listTreasuryDailyReconRuns']) });
      const h = open(state);
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      state.failing.clear();
      fireEvent.click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      await daysShown();
      expect(h.read.mock.calls.filter((call) => call[0] === 'listTreasuryDailyReconRuns').length).toBeGreaterThan(1);
    });

    it('a refusal for the scope shows the denied card', async () => {
      const state = world();
      const h = client(state);
      const original = h.read.getMockImplementation();
      h.read.mockImplementation((operation: string, input?: unknown) => (operation === 'listTreasuryDailyReconRuns' ? Promise.reject(refusal('SCOPE_DENIED', 403)) : (original as (a: string, b?: unknown) => Promise<unknown>)(operation, input)));
      mount(<DailyReconScreen route={ROUTE} />, h, { permissions: RUNNER, path: '/pay/pay-20' });
      expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    });

    it('without the permission to read, nothing is read and the screen says why', async () => {
      const h = open(world(), { permissions: ['treasury.daily_recon.run'] });
      expect((await screen.findByTestId('no-read')).textContent).toBe(parts['govd.recon.read.denied']);
      expect(h.read).not.toHaveBeenCalled();
    });

    it('read-only mode shows the figures and no command', async () => {
      open(world(), { mode: 'READ_ONLY' });
      await screen.findByTestId('items');
      expect(document.querySelector('button[data-action]')).toBeNull();
      expect(screen.queryByTestId('run-form')).toBeNull();
    });

    it('a failed read of one pass keeps the rest of the screen and offers a retry', async () => {
      const state = world();
      const h = client(state);
      const original = h.read.getMockImplementation();
      h.read.mockImplementation((operation: string, input?: unknown) => (operation === 'getTreasuryDailyReconRun' ? Promise.reject(new Error('boom')) : (original as (a: string, b?: unknown) => Promise<unknown>)(operation, input)));
      mount(<DailyReconScreen route={ROUTE} />, h, { permissions: RUNNER, path: '/pay/pay-20' });
      await daysShown();
      fireEvent.click(within(dayRow('2026-11-06')).getByRole('button', { name: parts['govd.recon.days.open'] }));
      expect((await screen.findByTestId('lines-failed')).textContent).toBe(parts['govd.recon.lines.failed']);
      expect(screen.getByTestId('items')).toBeTruthy();
    });
  });

  describe('running a day', () => {
    it('refuses a day in the future and an empty day before sending, and sends the day with one attempt', async () => {
      const h = open(world(), { command: () => runAnswer() });
      await screen.findByTestId('run-form');
      const input = screen.getByLabelText(parts['govd.recon.run.day']);
      fireEvent.click(screen.getByRole('button', { name: parts['govd.recon.run.submit'] }));
      expect(await screen.findByText(parts['govd.recon.problem.required'])).toBeTruthy();
      fireEvent.change(input, { target: { value: '2026-11-10' } });
      expect(await screen.findByText(parts['govd.recon.problem.future'])).toBeTruthy();
      expect(commandsOf(h, 'runTreasuryDailyRecon')).toHaveLength(0);
      fireEvent.change(input, { target: { value: '2026-11-06' } });
      fireEvent.click(screen.getByRole('button', { name: parts['govd.recon.run.submit'] }));
      await waitFor(() => expect(commandsOf(h, 'runTreasuryDailyRecon')).toHaveLength(1));
      expect(commandsOf(h, 'runTreasuryDailyRecon')[0]?.body).toEqual({ recon_date: '2026-11-06' });
      expect((await screen.findByTestId('done')).textContent).toBe(text('govd.recon.run.done.written', { day: '2026-11-06', lines: 3, opened: 2, cleared: 0 }));
      await screen.findByTestId('lines');
    });

    it('says when the day had nothing new, and words a refusal', async () => {
      open(world(), { command: () => runAnswer({ reused: true }) });
      await screen.findByTestId('run-form');
      fireEvent.change(screen.getByLabelText(parts['govd.recon.run.day']), { target: { value: '2026-11-06' } });
      fireEvent.click(screen.getByRole('button', { name: parts['govd.recon.run.submit'] }));
      expect((await screen.findByTestId('done')).textContent).toBe(text('govd.recon.run.done.reused', { day: '2026-11-06' }));
      cleanup();
      open(world(), { command: () => refusal('SCOPE_DENIED', 403) });
      await screen.findByTestId('run-form');
      fireEvent.change(screen.getByLabelText(parts['govd.recon.run.day']), { target: { value: '2026-11-06' } });
      fireEvent.click(screen.getByRole('button', { name: parts['govd.recon.run.submit'] }));
      expect((await screen.findByTestId('run-refusal')).textContent).toBe(parts['govd.recon.error.denied']);
    });
  });

  describe('assigning and resolving', () => {
    it('gives an item to a member with a day, under the version the list showed, and refuses a past day before sending', async () => {
      const h = open(world({ members: [member(1, 'Kế toán trưởng'), member(2, 'Chuyên viên đối soát')] }), { command: () => itemAnswer({ status: 'OPEN', resource_version: 2 }) });
      await screen.findByTestId('items');
      fireEvent.click(within(itemRow(itemId(1))).getByRole('button', { name: parts['govd.recon.item.assign'] }));
      await waitFor(() => expect(within(dialog()).getAllByRole('option').length).toBeGreaterThan(2));
      fireEvent.change(within(dialog()).getByLabelText(parts['govd.recon.assign.owner']), { target: { value: memberId(2) } });
      fireEvent.change(within(dialog()).getByLabelText(parts['govd.recon.assign.due']), { target: { value: '2026-11-01' } });
      fireEvent.click(within(dialog()).getByRole('button', { name: parts['govd.recon.assign.submit'] }));
      expect(await within(dialog()).findByText(parts['govd.recon.problem.past'])).toBeTruthy();
      expect(commandsOf(h, 'assignTreasuryDailyReconItem')).toHaveLength(0);
      fireEvent.change(within(dialog()).getByLabelText(parts['govd.recon.assign.due']), { target: { value: '2026-11-12' } });
      fireEvent.click(within(dialog()).getByRole('button', { name: parts['govd.recon.assign.submit'] }));
      await waitFor(() => expect(commandsOf(h, 'assignTreasuryDailyReconItem')).toHaveLength(1));
      expect(commandsOf(h, 'assignTreasuryDailyReconItem')[0]).toMatchObject({ path: { id: itemId(1) }, ifMatchVersion: 1, body: { owner_membership_id: memberId(2), due_on: '2026-11-12' } });
      expect((await screen.findByTestId('done')).textContent).toBe(parts['govd.recon.done.assigned']);
    });

    it('needs the words of the person to explain and sends them with the resolution', async () => {
      const h = open(world(), { permissions: RESOLVER, command: () => itemAnswer() });
      await screen.findByTestId('items');
      fireEvent.click(within(itemRow(itemId(1))).getByRole('button', { name: catalogue['pay.item.action.explain'] as string }));
      fireEvent.click(within(dialog()).getByRole('button', { name: catalogue['pay.item.action.explain'] as string, hidden: false }));
      expect(await within(dialog()).findByText(parts['govd.recon.problem.required'])).toBeTruthy();
      expect(commandsOf(h, 'resolveTreasuryDailyReconItem')).toHaveLength(0);
      fireEvent.change(within(dialog()).getByLabelText(parts['govd.recon.resolve.note']), { target: { value: '  Chờ dòng phân bổ của giao dịch.  ' } });
      fireEvent.click(within(dialog()).getByRole('button', { name: catalogue['pay.item.action.explain'] as string }));
      await waitFor(() => expect(commandsOf(h, 'resolveTreasuryDailyReconItem')).toHaveLength(1));
      expect(commandsOf(h, 'resolveTreasuryDailyReconItem')[0]).toMatchObject({ path: { id: itemId(1) }, ifMatchVersion: 1, body: { resolution: 'EXPLAINED', note: 'Chờ dòng phân bổ của giao dịch.' } });
      expect((await screen.findByTestId('done')).textContent).toBe(parts['govd.recon.done.resolved']);
    });

    it('a write-off asks for the approving document and words the refusal of the owner as the person who signs', async () => {
      const h = open(world(), { permissions: RESOLVER, command: () => refusal('SELF_APPROVAL_DENIED', 403) });
      await screen.findByTestId('items');
      fireEvent.click(within(itemRow(itemId(1))).getByRole('button', { name: catalogue['pay.item.action.writeOff'] as string }));
      expect(within(dialog()).getByText(parts['govd.recon.resolve.writeOffIntro'])).toBeTruthy();
      fireEvent.change(within(dialog()).getByLabelText(parts['govd.recon.resolve.note']), { target: { value: 'Quyết định xóa.' } });
      fireEvent.click(within(dialog()).getByRole('button', { name: catalogue['pay.item.action.writeOff'] as string }));
      expect(await within(dialog()).findByText(parts['govd.recon.problem.required'])).toBeTruthy();
      fireEvent.change(within(dialog()).getByLabelText(parts['govd.recon.resolve.approval']), { target: { value: 'khong-phai-ma' } });
      fireEvent.click(within(dialog()).getByRole('button', { name: catalogue['pay.item.action.writeOff'] as string }));
      expect(await within(dialog()).findByText(parts['govd.recon.problem.uuid'])).toBeTruthy();
      fireEvent.change(within(dialog()).getByLabelText(parts['govd.recon.resolve.approval']), { target: { value: documentId(1) } });
      fireEvent.click(within(dialog()).getByRole('button', { name: catalogue['pay.item.action.writeOff'] as string }));
      await waitFor(() => expect(commandsOf(h, 'resolveTreasuryDailyReconItem')).toHaveLength(1));
      expect(commandsOf(h, 'resolveTreasuryDailyReconItem')[0]?.body).toEqual({ resolution: 'WRITTEN_OFF', note: 'Quyết định xóa.', approval_document_version_id: documentId(1) });
      expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(catalogue['pay.recon.error.selfApproval']);
    });

    it('offers no command on an item that ended', async () => {
      open(world({ items: [item(1, { status: 'WRITTEN_OFF_APPROVED' }, { assign: false, explain: false, resolve: false, write_off: false }), item(2, { status: 'AUTO_CLEARED' })] }));
      await screen.findByTestId('items');
      expect(within(itemRow(itemId(1))).queryByRole('button')).toBeNull();
      expect(within(itemRow(itemId(2))).queryByRole('button')).toBeNull();
      expect(within(itemRow(itemId(2))).getByTestId('item-status').textContent).toBe(parts['govd.recon.status.autoCleared']);
      expect(line(1).id).toBe(lineId(1));
    });
  });
});
