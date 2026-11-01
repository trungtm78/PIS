import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { harness, mount, routeOf } from '../mne/test-support';
import QueryLogScreen from './QueryLogScreen';
import { filterQuery, percentile, summarise, toRun, toRunPage } from './query-log-model';

const ROUTE = routeOf('BI-13', 'FR-BI-13');
const READ = ['bi.admin.read'];
const ME = '00000000-0000-4000-8000-000000000001';
const R1 = '00000000-0000-4000-8000-0000000000a1';
const R2 = '00000000-0000-4000-8000-0000000000a2';
const R3 = '00000000-0000-4000-8000-0000000000a3';
const failure = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c', extensions: {} });
const fill = (value: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, item]) => out.replace(`{${key}}`, String(item)), value);

const run = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  requested_by: ME,
  metric_version_ids: ['00000000-0000-4000-8000-0000000000f1'],
  as_of_period: '2026-10',
  dataset_version_id: '00000000-0000-4000-8000-0000000000e1',
  mode: 'SYNC',
  status: 'COMPLETED',
  served_from_cache: false,
  duration_ms: 120,
  row_count: 12,
  cost_units: 12,
  estimated_cost: null,
  error_code: null,
  created_at: '2026-11-01T01:02:03.000Z',
  finished_at: null,
  ...overrides,
});

type Page = { items: unknown[]; next_cursor: string | null } | Error;
function client(answer: (query: Record<string, string>) => Page) {
  return harness((operation, input) => (operation === 'listBiQueryRuns' ? answer((input as { query: Record<string, string> }).query) : new Error(`unexpected read ${operation}`)));
}

afterEach(() => cleanup());

describe('the model of the log of the queries (ST-BI-009)', () => {
  it('reads a run with its timing and flags, and leaves out what is not a run', () => {
    expect(toRun(run(R1, { mode: 'ASYNC_JOB', status: 'QUEUED', estimated_cost: 240, duration_ms: null, row_count: null }))).toMatchObject({
      mode: 'ASYNC_JOB',
      status: 'QUEUED',
      estimatedCost: 240,
      durationMs: null,
      rowCount: null,
    });
    expect(toRun(run(R1, { status: 'LOST' }))).toBeUndefined();
    expect(toRun(run(R1, { mode: 'BATCH' }))).toBeUndefined();
    expect(toRun({ id: R1 })).toBeUndefined();
    expect(toRun('nothing')).toBeUndefined();
    expect(toRun(run(R1, { requested_by: 3, metric_version_ids: ['a', 4], duration_ms: 'fast' }))).toMatchObject({ requestedBy: '', metricVersionIds: ['a'], durationMs: null });
  });

  it('reads a page: the runs that are runs, and the cursor when it is text', () => {
    expect(toRunPage({ items: [run(R1), { nonsense: true }], next_cursor: 'abc' })).toMatchObject({ items: [{ id: R1 }], nextCursor: 'abc' });
    expect(toRunPage({ items: [], next_cursor: null }).nextCursor).toBeUndefined();
    expect(toRunPage(undefined)).toEqual({ items: [], nextCursor: undefined });
  });

  it('sends only what is chosen, and the period without its blanks', () => {
    expect(filterQuery({ status: '', period: '  ' })).toEqual({});
    expect(filterQuery({ status: 'QUEUED', period: ' 2026-10 ' })).toEqual({ status: 'QUEUED', as_of_period: '2026-10' });
  });

  it('takes the nearest rank of the durations, and none when there is no duration', () => {
    expect(percentile([], 0.95)).toBeUndefined();
    expect(percentile([5], 0.95)).toBe(5);
    expect(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.95)).toBe(100);
    expect(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.5)).toBe(50);
    expect(percentile([30, 10, 20], 0.01)).toBe(10);
  });

  it('counts the runs, those from the cache, the jobs, and the p95 of those that ended', () => {
    const runs = [run(R1), run(R2, { served_from_cache: true, duration_ms: 3 }), run(R3, { mode: 'ASYNC_JOB', status: 'QUEUED', duration_ms: null })].flatMap((raw) => toRun(raw) ?? []);
    expect(summarise(runs)).toEqual({ runs: 3, fromCache: 1, jobs: 1, p95Ms: 120 });
    expect(summarise([])).toEqual({ runs: 0, fromCache: 0, jobs: 0, p95Ms: undefined });
  });
});

describe('BI-13, the log of the queries (ST-BI-009)', () => {
  it('lists the runs with their duration, rows, cost and cache flag, and says in numbers what is on the screen', async () => {
    const h = client(() => ({
      items: [run(R1), run(R2, { served_from_cache: true, duration_ms: 3 }), run(R3, { mode: 'ASYNC_JOB', status: 'QUEUED', duration_ms: null, row_count: null, estimated_cost: 240 })],
      next_cursor: null,
    }));
    mount(<QueryLogScreen route={ROUTE} />, h, { permissions: READ });
    const table = await screen.findByTestId('runs');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.getAttribute('data-status')).toBe('COMPLETED');
    expect(rows[0]?.textContent).toContain('120 ms');
    expect(rows[0]?.textContent).toContain(vi_['bi.log.cache.no']);
    expect(rows[1]?.textContent).toContain(vi_['bi.log.cache.yes']);
    expect(rows[2]?.getAttribute('data-mode')).toBe('ASYNC_JOB');
    expect(rows[2]?.textContent).toContain(vi_['bi.log.status.queued']);
    expect(rows[2]?.textContent).toContain('240');
    expect(screen.getByTestId('summary').textContent).toBe(fill(vi_['bi.log.summary'], { runs: 3, cached: 1, jobs: 1, p95: '120 ms' }));
    expect(h.read).toHaveBeenCalledWith('listBiQueryRuns', { query: { limit: 50 } });
  });

  it('shows the reason a run ended badly beside its state', async () => {
    mount(
      <QueryLogScreen route={ROUTE} />,
      client(() => ({ items: [run(R1, { mode: 'ASYNC_JOB', status: 'DENIED', error_code: 'SCOPE_CHANGED', duration_ms: 4 })], next_cursor: null })),
      { permissions: READ },
    );
    expect((await screen.findByTestId('runs')).textContent).toContain('SCOPE_CHANGED');
  });

  it('asks for the state and the period that are chosen, and for more when there is a next page', async () => {
    const h = client((query) => (query.cursor === 'next' ? { items: [run(R2)], next_cursor: null } : { items: [run(R1)], next_cursor: 'next' }));
    mount(<QueryLogScreen route={ROUTE} />, h, { permissions: READ });
    await screen.findByTestId('runs');
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['bi.log.more'] }));
    await waitFor(() => expect(within(screen.getByTestId('runs')).getAllByRole('row')).toHaveLength(3));
    expect(screen.queryByRole('button', { name: vi_['bi.log.more'] })).toBeNull();
    expect(h.read).toHaveBeenCalledWith('listBiQueryRuns', { query: { limit: 50, cursor: 'next' } });
    const user = userEvent.setup();
    const form = screen.getByRole('form', { name: vi_['bi.log.filter.title'] });
    await user.selectOptions(within(form).getByLabelText(vi_['bi.log.status']), 'QUEUED');
    await user.type(within(form).getByLabelText(vi_['bi.log.period']), ' 2026-10 ');
    await user.click(within(form).getByRole('button', { name: vi_['bi.log.apply'] }));
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listBiQueryRuns', { query: { limit: 50, status: 'QUEUED', as_of_period: '2026-10' } }));
  });

  it('asks nothing of the server of a member who has not the right, and says so', async () => {
    const h = client(() => ({ items: [run(R1)], next_cursor: null }));
    mount(<QueryLogScreen route={ROUTE} />, h, { permissions: ['bi.query'] });
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });

  it('starts over when the member or the tenant changes: the filter that was typed is not carried to another', async () => {
    const view = mount(
      <QueryLogScreen route={ROUTE} />,
      client(() => ({ items: [run(R1)], next_cursor: null })),
      { permissions: READ },
    );
    const form = await screen.findByRole('form', { name: vi_['bi.log.filter.title'] });
    await userEvent.setup().type(within(form).getByLabelText(vi_['bi.log.period']), '2026');
    view.rerenderWith({ permissions: READ, tenant: { id: '00000000-0000-4000-8000-0000000000aa', name: 'Khác', membershipId: ME } as never });
    await waitFor(() => expect((screen.getByLabelText(vi_['bi.log.period']) as HTMLInputElement).value).toBe(''));
  });
});

describe('the seven standard states of BI-13 (ST-BI-009)', () => {
  const offline = new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' });
  const states: Array<[string, Page, string]> = [
    ['empty', { items: [], next_cursor: null }, vi_['states.empty.title']],
    ['denied', failure(403, 'SCOPE_DENIED'), vi_['states.denied.title']],
    ['offline', offline, vi_['states.offline.title']],
    ['error', failure(500, 'INTERNAL_ERROR'), vi_['states.error.title']],
    ['signed out', failure(401, 'SESSION_EXPIRED'), vi_['states.signedOut.title']],
  ];

  it.each(states)('UI-BI-13 shows the %s state', async (_name, answer, title) => {
    mount(
      <QueryLogScreen route={ROUTE} />,
      client(() => answer),
      { permissions: READ },
    );
    expect(await screen.findByText(title)).toBeTruthy();
  });

  it('UI-BI-13 shows the loading state first and names the page', () => {
    const h = harness(() => new Promise(() => undefined) as never);
    mount(<QueryLogScreen route={ROUTE} />, h, { permissions: READ });
    expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
    expect(screen.getByRole('region', { name: vi_['bi.log.title'] })).toBeTruthy();
  });

  it('UI-BI-13 retries after an error and then lists the runs', async () => {
    let answers: Page = failure(500, 'INTERNAL_ERROR');
    mount(
      <QueryLogScreen route={ROUTE} />,
      client(() => answers),
      { permissions: READ },
    );
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    answers = { items: [run(R1)], next_cursor: null };
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    expect(await screen.findByTestId('runs')).toBeTruthy();
  });
});
