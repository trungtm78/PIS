import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClientProvider } from '../../../api/ApiClientContext';
import vi_ from '../../../i18n/vi.json';
import parts from '../../../i18n/vi.json';
import { SessionContext } from '../../../session/SessionContext';
import type { SessionValue } from '../../../session/SessionContext';
import { ALL_MODULES_VISIBLE } from '../../../navigation/model';
import CrossTotalScreen from './CrossTotalScreen';
import { toCheck, toControl } from './model';

const SNAPSHOT = '00000000-0000-4000-8000-0a0000000001';
const OTHER = '00000000-0000-4000-8000-0a0000000002';
const PROJECT = '00000000-0000-4000-8000-0a0000000011';
const ROUTE = { id: 'DIS-26', path: '/dis/dis-26', title: 'DIS-26', kind: 'table' as const, area: 'investment' as const, module: 'DIS', group: 'Quản lý kỳ báo cáo', role: 'workspace' as const, parent: null, req: 'FR-DIS-26' };
const catalogue = { ...vi_, ...parts } as Record<string, string>;
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), catalogue[key] ?? key);

const dimension = (total: string, extra: Record<string, unknown> = {}) => ({ total_vnd: total, key_count: 2, top: [{ key: 'NSTW', label: 'Ngân sách trung ương', vnd: total }], source: 'nguồn', disagrees: false, offset_vnd: null, ...extra });
const check = (overrides: Record<string, unknown> = {}) => ({
  id: '00000000-0000-4000-8000-0a0000000021',
  snapshot_id: SNAPSHOT,
  period_id: null,
  fiscal_year: 2027,
  treasury_cutoff_date: '2027-01-10',
  window_from: '2027-01-01',
  published: true,
  disagreeing: [],
  agreeing: ['UNIT', 'FUND', 'PROJECT'],
  unit: dimension('250000000'),
  fund: dimension('250000000'),
  project: dimension('250000000'),
  unattributed_fund_vnd: '0',
  project_gaps: [],
  origin: 'MANUAL',
  created_by: null,
  created_at: '2027-01-11T01:00:00.000000Z',
  ...overrides,
});
const disagreeing = () =>
  check({ published: false, disagreeing: ['UNIT'], agreeing: ['FUND', 'PROJECT'], unit: dimension('250000000', { disagrees: true, offset_vnd: '-40000000' }), fund: dimension('290000000'), project: dimension('290000000'), unattributed_fund_vnd: '40000000', project_gaps: [{ project_id: PROJECT, project_code: 'CT-1', snapshot_vnd: '250000000', ledger_vnd: '290000000', gap_vnd: '-40000000' }] });
const control = (live: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  snapshot: { id: SNAPSHOT, period_id: '00000000-0000-4000-8000-0a0000000031', snapshot_kind: 'PERIOD_CLOSE', status: 'BUILDING', treasury_cutoff_date: '2027-01-10' },
  live,
  recorded: null,
  history: [],
  formula: '',
  as_of: '2027-01-11T02:00:00.000Z',
  ...extra,
});
const heads = [
  { id: SNAPSHOT, snapshot_kind: 'PERIOD_CLOSE', status: 'BUILDING', treasury_cutoff_date: '2027-01-10', period_id: '1' },
  { id: OTHER, snapshot_kind: 'ADHOC', status: 'FROZEN', treasury_cutoff_date: '2027-01-03', period_id: '2' },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

interface Options {
  permissions?: readonly string[] | undefined;
  mode?: 'FULL' | 'READ_ONLY';
  controlAnswer?: (id: string) => unknown;
  list?: unknown;
  command?: (operation: string, input: unknown) => unknown;
  path?: string;
}

function open(options: Options = {}) {
  const respond = (value: unknown) => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value));
  const read = vi.fn((operation: string, input?: unknown) => {
    if (operation === 'listPeriodSnapshots') return respond(options.list ?? { items: heads, next_cursor: null });
    if (operation === 'getCrossTotalControl') return respond((options.controlAnswer ?? (() => control(check())))((input as { path: { id: string } }).path.id));
    return respond(new Error(`unexpected read ${operation}`));
  });
  const command = vi.fn((operation: string, input: unknown) => respond((options.command ?? (() => ({ operation_id: SNAPSHOT, status: 'PUBLISHED', resource_version: 1, resource_id: SNAPSHOT, published: true, total_unit_vnd: '1', total_fund_vnd: '1', total_project_vnd: '1', disagreeing: [] })))(operation, input)));
  const session: SessionValue = {
    tenant: { id: '00000000-0000-4000-8000-0a00000000aa', name: 'PVFCCo', membershipId: '00000000-0000-4000-8000-0a00000000bb' } as never,
    tenants: [],
    user: { displayName: 'Admin', initials: 'AD' },
    access: ALL_MODULES_VISIBLE,
    switchTenant: () => undefined,
    getSession: () => Promise.resolve({ token: 'token' }),
    permissions: options.permissions ?? ['disbursement.control.read', 'disbursement.control.evaluate'],
    ...(options.mode === undefined ? {} : { mode: options.mode }),
  };
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <SessionContext.Provider value={session}>
      <QueryClientProvider client={queries}>
        <ApiClientProvider client={{ read, readAll: vi.fn(), command } as never}>
          <MemoryRouter initialEntries={[options.path ?? '/dis/dis-26']}>
            <CrossTotalScreen route={ROUTE} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </SessionContext.Provider>,
  );
  return { read, command };
}

const figureOf = (label: string): HTMLElement => screen.getByText(label).closest('article') as HTMLElement;

describe('CrossTotalScreen (DIS-26): the cross-total control', () => {
  it('UI-DIS-26: when the three totals agree the indicator is published, each total says it agrees, and the formula is on the "i"', async () => {
    open();
    const verdict = await screen.findByTestId('verdict');
    expect(verdict.getAttribute('data-published')).toBe('yes');
    expect(verdict.textContent).toBe(parts['govd.cross.verdict.published']);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(parts['govd.cross.title']);
    expect(screen.getByText(text('govd.cross.footer', { id: 'DIS-26', req: 'FR-DIS-26' }))).toBeTruthy();
    for (const name of ['Đơn vị', 'Nguồn vốn', 'Dự án']) {
      const tile = figureOf(text('govd.cross.kpi.total', { dimension: name }));
      expect(tile.querySelector('.ui-kpi__value')?.textContent).toBe('250.000.000');
      expect(tile.textContent).toContain(parts['govd.cross.kpi.agrees']);
    }
    expect(screen.queryByTestId('unattributed')).toBeNull();
    expect(screen.getByRole('button', { name: text('govd.cross.info.open', { name: parts['govd.cross.info.name'] }) })).toBeTruthy();
    // The first snapshot of the list is the one that is read when none is asked for.
    expect(screen.getByLabelText(parts['govd.cross.snapshot.label'])).toHaveProperty('value', SNAPSHOT);
  });

  it('names the dimension that disagrees, by how much, the money with no fund and the project that differs', async () => {
    open({ controlAnswer: () => control(disagreeing()) });
    const verdict = await screen.findByTestId('verdict');
    expect(verdict.getAttribute('data-published')).toBe('no');
    expect(screen.getByTestId('verdict-which').textContent).toBe(text('govd.cross.verdict.which', { dimensions: 'Đơn vị' }));
    expect(figureOf(text('govd.cross.kpi.total', { dimension: 'Đơn vị' })).textContent).toContain(text('govd.cross.kpi.offset', { offset: '-40.000.000' }));
    expect(figureOf(text('govd.cross.kpi.total', { dimension: 'Nguồn vốn' })).textContent).toContain(parts['govd.cross.kpi.agrees']);
    expect(screen.getByTestId('unattributed').textContent).toBe(text('govd.cross.unattributed', { amount: '40.000.000' }));
    const gap = within(screen.getByTestId('gaps'));
    expect(gap.getByTestId('gap-project').textContent).toBe('CT-1');
    expect(gap.getByTestId('gap-snapshot').textContent).toBe('250.000.000');
    expect(gap.getByTestId('gap-ledger').textContent).toBe('290.000.000');
    expect(gap.getByTestId('gap-gap').textContent).toBe('-40.000.000');
  });

  it('when no two totals agree it says all three differ', async () => {
    const all = check({ published: false, disagreeing: ['UNIT', 'FUND', 'PROJECT'], agreeing: [], unit: dimension('1', { disagrees: true }), fund: dimension('2', { disagrees: true }), project: dimension('3', { disagrees: true }) });
    open({ controlAnswer: () => control(all) });
    expect((await screen.findByTestId('verdict-which')).textContent).toBe(parts['govd.cross.verdict.allDisagree']);
    expect(figureOf(text('govd.cross.kpi.total', { dimension: 'Dự án' })).textContent).toContain(parts['govd.cross.kpi.disagrees']);
  });

  it('shows the largest keys of each dimension and the history of the checks that were written', async () => {
    const history = [check({ published: false, disagreeing: ['UNIT'], origin: 'FREEZE_GATE', id: '00000000-0000-4000-8000-0a0000000022' }), check()];
    open({ controlAnswer: () => control(check(), { history, recorded: history[0] }) });
    await screen.findByTestId('keys-unit');
    expect(within(screen.getByTestId('keys-fund')).getByTestId('key-name').textContent).toBe('Ngân sách trung ương');
    const rows = within(screen.getByTestId('history')).getAllByTestId('history-result');
    expect(rows.map((row) => row.getAttribute('data-published'))).toEqual(['no', 'yes']);
    expect(within(screen.getByTestId('history')).getAllByTestId('history-origin')[0]?.textContent).toBe(parts['govd.cross.history.origin.freeze']);
    expect(within(screen.getByTestId('history')).getAllByTestId('history-which')[0]?.textContent).toBe('Đơn vị');
    expect(screen.getByTestId('to-snapshot').getAttribute('href')).toBe('/dis/dis-21');
  });

  it('says so when no check was written yet', async () => {
    open();
    expect((await screen.findByTestId('no-history')).textContent).toBe(parts['govd.cross.history.empty']);
  });

  it('writes a check on demand and tells what it found; the snapshot asked for in the address is the one read', async () => {
    const { read, command } = open({ path: `/dis/dis-26?snapshot=${OTHER}`, command: () => ({ operation_id: OTHER, status: 'NOT_PUBLISHED', resource_version: 1, resource_id: OTHER, published: false, total_unit_vnd: '1', total_fund_vnd: '2', total_project_vnd: '2', disagreeing: ['UNIT'] }) });
    await screen.findByTestId('verdict');
    expect(read).toHaveBeenCalledWith('getCrossTotalControl', { path: { id: OTHER } });
    fireEvent.click(screen.getByRole('button', { name: parts['govd.cross.evaluate.action'] }));
    expect((await screen.findByTestId('evaluate-done')).textContent).toBe(parts['govd.cross.evaluate.done.notPublished']);
    expect(command).toHaveBeenCalledWith('evaluateCrossTotal', expect.objectContaining({ path: { id: OTHER }, body: {} }));
  });

  it('words a refusal of the check and offers no button without the permission or in read-only mode', async () => {
    open({ command: () => new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c', extensions: {} }) });
    fireEvent.click(await screen.findByRole('button', { name: parts['govd.cross.evaluate.action'] }));
    expect((await screen.findByTestId('evaluate-refusal')).textContent).toBe(parts['govd.cross.error.denied']);
    cleanup();
    open({ permissions: ['disbursement.control.read'] });
    await screen.findByTestId('verdict');
    expect(screen.queryByRole('button', { name: parts['govd.cross.evaluate.action'] })).toBeNull();
    cleanup();
    open({ mode: 'READ_ONLY' });
    await screen.findByTestId('verdict');
    expect(screen.queryByRole('button', { name: parts['govd.cross.evaluate.action'] })).toBeNull();
  });

  describe('the states of the screen', () => {
    it('loading shows the skeleton and no number', async () => {
      const never = new Promise(() => undefined);
      open({ list: never as never });
      expect(await screen.findByLabelText(vi_['states.loading.label'])).toBeTruthy();
      expect(screen.queryByTestId('verdict')).toBeNull();
    });

    it('an error shows the card with a retry', async () => {
      open({ controlAnswer: () => new Error('boom') });
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      expect(screen.getByRole('button', { name: vi_['states.retry.action'] })).toBeTruthy();
    });

    it('a refusal for the scope shows the denied card', async () => {
      open({ controlAnswer: () => new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c', extensions: {} }) });
      expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    });

    it('with no snapshot at all it says so, and with one that is not there it shows the empty card', async () => {
      open({ list: { items: [], next_cursor: null } });
      expect((await screen.findByTestId('no-snapshot')).textContent).toBe(parts['govd.cross.snapshot.none']);
      cleanup();
      open({ controlAnswer: () => new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c', extensions: {} }) });
      expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    });

    it('without the permission to read nothing is read and the screen says why', async () => {
      const { read } = open({ permissions: ['disbursement.control.evaluate'] });
      expect((await screen.findByTestId('no-read')).textContent).toBe(parts['govd.cross.read.denied']);
      expect(read).not.toHaveBeenCalled();
    });
  });

  describe('the model', () => {
    it('reads only what it can make sense of: a check with a total that is not a whole number is dropped', () => {
      expect(toCheck(check())?.published).toBe(true);
      expect(toCheck(check({ unit: dimension('12.5') }))).toBeUndefined();
      expect(toCheck(check({ published: 'yes' }))).toBeUndefined();
      expect(toControl({ snapshot: {}, live: check() })).toBeUndefined();
      expect(toControl(control(check()))?.snapshot.id).toBe(SNAPSHOT);
      expect(toCheck(check({ disagreeing: ['UNIT', 'NOPE'] }))?.disagreeing).toEqual(['UNIT']);
    });
  });
});
