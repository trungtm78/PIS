import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../../test/axe';
import DirectivesScreen from './DirectivesScreen';
import { DirectivesSourceContext, notBuiltSource } from './directives-source';
import type { DirectiveItem, DirectivesReading, DirectivesSource } from './directives-source';
import { mountPwa, pwaClient, word } from './test-support';

const failure = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });

const directive = (n: number, extra: Partial<DirectiveItem> = {}): DirectiveItem => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  title: `Chỉ đạo số ${n}`,
  issuedBy: 'Thủ tướng Chính phủ',
  issuedOn: '2027-09-01',
  dueOn: '2099-01-01',
  status: 'IN_PROGRESS',
  assigneeUnit: 'Sở Kế hoạch',
  progressPercent: 40,
  lastUpdateAt: '2027-10-12T08:00:00.000Z',
  overdueDays: 0,
  ...extra,
});

function open(source: DirectivesSource | undefined) {
  const h = pwaClient({});
  const screenElement = <DirectivesScreen />;
  return mountPwa(source === undefined ? screenElement : <DirectivesSourceContext.Provider value={source}>{screenElement}</DirectivesSourceContext.Provider>, h, { path: '/m/directives' });
}

const ready = (items: DirectiveItem[], extra: Partial<Extract<DirectivesReading, { state: 'ready' }>> = {}): DirectivesSource => () => ({ state: 'ready', items, asOf: '2027-10-12T08:00:00.000Z', stale: false, unavailableSources: [], retry: () => undefined, ...extra });

afterEach(cleanup);

describe('DirectivesScreen (PWA-04): the directive tracking view', () => {
  it('says the directive module is not built yet, as its own empty state, and shows no invented directive', () => {
    open(undefined);
    const empty = screen.getByTestId('empty');
    expect(empty.getAttribute('data-kind')).toBe('notBuilt');
    expect(empty.textContent).toContain(word('pwa.directives.empty.notBuilt.title'));
    expect(document.querySelector('[data-directive]')).toBeNull();
    expect(screen.queryByTestId('counts')).toBeNull();
    expect(notBuiltSource({ status: 'ALL' })).toEqual({ state: 'notBuilt' });
  });

  it('shows a skeleton while loading, never a count of 0', () => {
    open(() => ({ state: 'loading' }));
    expect(screen.getByRole('status', { name: word('states.loading.label') }).getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByTestId('counts')).toBeNull();
    expect(screen.queryByTestId('empty')).toBeNull();
  });

  it('lists the directives with who issued them, the unit, the deadline, the status and the progress', () => {
    open(ready([directive(1), directive(2, { status: 'OVERDUE', dueOn: '2020-01-01', overdueDays: 9, progressPercent: null, assigneeUnit: null, lastUpdateAt: null })]));
    const first = document.querySelector('[data-directive="00000000-0000-4000-8000-000000000001"]') as HTMLElement;
    expect(first.textContent).toContain('Chỉ đạo số 1');
    expect(first.textContent).toContain('Thủ tướng Chính phủ');
    expect(first.textContent).toContain('Sở Kế hoạch');
    expect(within(first).getByText(word('pwa.directives.status.inProgress'))).toBeInTheDocument();
    expect(within(first).getByRole('progressbar', { name: 'Tiến độ 40 phần trăm' })).toHaveAttribute('value', '40');
    expect(within(first).getByRole('time')).toBeInTheDocument();
    const late = document.querySelector('[data-directive="00000000-0000-4000-8000-000000000002"]') as HTMLElement;
    // No report is "not reported yet", never 0%.
    expect(within(late).getByTestId('progress-none').textContent).toBe(word('pwa.directives.progress.none'));
    expect(late.textContent).not.toContain('0%');
    expect(within(late).getByText(word('pwa.directives.status.overdue'))).toBeInTheDocument();
    expect(late.textContent).toContain('Quá hạn 9 ngày');
    expect(screen.getByTestId('counts').textContent).toContain('2 trên 2 chỉ đạo');
  });

  it('has two empty states of a list: none in the scope, and the filter found nothing with the way to clear it', () => {
    const none = open(ready([]));
    expect(screen.getByTestId('empty').getAttribute('data-kind')).toBe('none');
    none.unmount();

    open(ready([directive(1)]));
    fireEvent.change(screen.getByLabelText(word('pwa.directives.filter.status')), { target: { value: 'DONE' } });
    const filtered = screen.getByTestId('empty');
    expect(filtered.getAttribute('data-kind')).toBe('filtered');
    fireEvent.click(within(filtered).getByRole('button', { name: word('pwa.directives.empty.filtered.clear') }));
    expect(document.querySelectorAll('[data-directive]')).toHaveLength(1);
  });

  it('filters by status', () => {
    open(ready([directive(1), directive(2, { status: 'DONE', progressPercent: 100 }), directive(3, { status: 'OVERDUE', overdueDays: 2 })]));
    fireEvent.change(screen.getByLabelText(word('pwa.directives.filter.status')), { target: { value: 'DONE' } });
    expect(Array.from(document.querySelectorAll('[data-directive]')).map((card) => card.getAttribute('data-status'))).toEqual(['DONE']);
    expect(screen.getByTestId('counts').textContent).toContain('1 trên 3 chỉ đạo');
  });

  it('passes the status to the source, so a real one can ask the server for it', () => {
    const source = vi.fn<DirectivesSource>(() => ({ state: 'loading' }));
    open(source);
    expect(source).toHaveBeenCalledWith({ status: 'ALL' });
  });

  it('names a failure in the standard states and retries in place', () => {
    const retry = vi.fn();
    const failing = (error: unknown): DirectivesSource => () => ({ state: 'error', error, retry });
    const error = open(failing(new Error('x')));
    expect(screen.getByRole('alert').textContent).toContain(word('states.error.title'));
    fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
    expect(retry).toHaveBeenCalledTimes(1);
    error.unmount();

    const offline = open(failing(failure(0, NETWORK_ERROR_CODE)));
    expect(screen.getByText(word('states.offline.title'))).toBeInTheDocument();
    offline.unmount();
    const denied = open(failing(failure(403, 'SCOPE_DENIED')));
    expect(screen.getByRole('alert').textContent).toContain(word('states.denied.title'));
    denied.unmount();
    open(failing(failure(401, 'SESSION_EXPIRED')));
    expect(screen.getByRole('alert').textContent).toContain(word('states.signedOut.title'));
  });

  it('says the list is old when the last reading failed, and names a source that could not be read', () => {
    const retry = vi.fn();
    open(ready([directive(1)], { stale: true, retry, unavailableSources: ['DIR', 'ISS'] }));
    expect(screen.getByTestId('stale').textContent).toContain('Số liệu cũ');
    expect(screen.getByTestId('unavailable').textContent).toContain('DIR, ISS');
    fireEvent.click(within(screen.getByTestId('stale')).getByRole('button', { name: word('states.retry.action') }));
    expect(retry).toHaveBeenCalled();
    // The list is still there: stale, not empty.
    expect(document.querySelectorAll('[data-directive]')).toHaveLength(1);
  });

  it('has no serious accessibility violation, in the list and in the not-built state', async () => {
    const list = open(ready([directive(1), directive(2, { progressPercent: null })]));
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
    list.unmount();
    open(undefined);
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });
});
