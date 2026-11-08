import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { READER, mount, routeOf } from '../test-support';
import OverviewScreen from './OverviewScreen';
import { PROJECT, overview, progressClient } from './test-support';
import { toDeadlines } from './UpcomingDeadlines';

const ROUTE = routeOf('LND-01', 'FR-LND-01');
const word = (key: string): string => (vi_ as Record<string, string | undefined>)[key] ?? key;
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const deadline = (n: number, over: Record<string, unknown> = {}) => ({ id: uuid(n), project_id: PROJECT, subject_kind: 'PLAN', subject_id: uuid(900), subject_label: `Plan ${n}`, timer_code: 'PAYMENT_30', days_applied: 30, started_on: '2026-10-10', due_on: '2026-11-12', remaining_days: 4, status: 'RUNNING', alert_level_sent: 0, legal_basis: 'Decree X', awaiting_confirmation: true, cxn: 'CXN-1', ...over });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(answer: (input: unknown) => unknown) {
  const base = progressClient(() => overview());
  const previous = base.read.getMockImplementation();
  base.read.mockImplementation((operation: string, input?: unknown) => {
    if (operation !== 'listUpcomingLandDeadlines') return previous === undefined ? Promise.reject(new Error(`unexpected ${operation}`)) : previous(operation, input);
    const value = answer(input);
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  });
  mount(<OverviewScreen route={ROUTE} />, base, { permissions: READER, path: '/lnd/lnd-01' });
  return base;
}

describe('LND-01 the upcoming land deadlines (listUpcomingLandDeadlines)', () => {
  it('asks for 30 days by default, lists the clocks with the days left and their "i", opens the project, and reads again for another window', async () => {
    const h = open(() => ({ items: [deadline(1), deadline(2, { status: 'BREACHED', remaining_days: -3, timer_code: 'COMPLAINT_RESOLUTION', awaiting_confirmation: false })], next_cursor: null, as_of: '2026-11-08T03:00:00.000Z' }));
    const table = await screen.findByTestId('deadlines-table');
    expect(h.read).toHaveBeenCalledWith('listUpcomingLandDeadlines', { query: { within_days: '30', limit: '50' } });
    expect(within(table).getByTestId(`deadline-left-${uuid(2)}`).textContent).toBe('-3');
    expect(within(table).getByText(word('lookahead.prj.landDeadlines.status.breached'))).toBeTruthy();
    expect(within(table).getAllByRole('button', { name: new RegExp(word('govc.bi.info.open').split('{')[0] ?? '') })).toHaveLength(2);
    fireEvent.change(screen.getByTestId('deadline-window'), { target: { value: '7' } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listUpcomingLandDeadlines', { query: { within_days: '7', limit: '50' } }));
    fireEvent.click(await screen.findByTestId(`deadline-open-${uuid(1)}`));
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('getLandProgress', { path: { id: PROJECT } }));
  });

  it('says nothing is falling due, says when the list is cut, and shows a failed read with a retry', async () => {
    open(() => ({ items: [], next_cursor: null, as_of: '2026-11-08T03:00:00.000Z' }));
    expect((await screen.findByTestId('deadlines-empty')).textContent).toContain('30');
    cleanup();
    open(() => ({ items: [deadline(1)], next_cursor: 'next', as_of: '2026-11-08T03:00:00.000Z' }));
    expect(await screen.findByTestId('deadlines-more')).toBeTruthy();
    cleanup();
    let calls = 0;
    open(() => (calls++ === 0 ? new ApiError({ status: 500, code: 'INTERNAL', correlationId: 'c' }) : { items: [deadline(1)], next_cursor: null, as_of: '2026-11-08T03:00:00.000Z' }));
    const error = await screen.findByTestId('deadlines-error');
    fireEvent.click(within(error).getByRole('button', { name: word('lookahead.prj.landDeadlines.retry') }));
    expect(await screen.findByTestId('deadlines-table')).toBeTruthy();
  });
});

describe('toDeadlines', () => {
  it('drops rows without an id or due day, and reads an unknown status as running and an unknown timer as none', () => {
    const parsed = toDeadlines({ items: [{ id: 'a' }, deadline(1, { status: 'WEIRD', timer_code: 'NOPE' })], next_cursor: null, as_of: '2026-11-08T03:00:00.000Z' });
    expect(parsed?.lines.map((line) => [line.status, line.timerCode])).toEqual([['RUNNING', null]]);
    expect(toDeadlines({})).toBeUndefined();
  });
});
