import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { client, line, mount, routeOf, world } from '../../prj/test-support';
import type { Harness } from '../../prj/test-support';
import LedgerScreen from './LedgerScreen';
import { EMPTY_FILTER, formatVnd, ledgerQuery, toLedgerPage, validateFilter } from './model';

const ROUTE = routeOf('CAP-21', 'FR-CAP-21');
const AUDITOR = ['capital.ledger.read'];
const LINE = '00000000-0000-4000-8000-0000000000a1';
const APPROPRIATION = '00000000-0000-4000-8000-0000000000b1';

const entry = (n: number, type: string, amount: string, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-0000000000e${n}`,
  entry_type: type,
  amount_vnd: amount,
  plan_year: 2026,
  appropriation_id: APPROPRIATION,
  allocation_line_id: LINE,
  project: { id: line(1).id, code: 'DA-2026-001', name: 'Dự án số 1' },
  source_ref_kind: 'CAPITAL_PLAN',
  source_ref_id: '00000000-0000-4000-8000-0000000000f1',
  reversal_of_id: null,
  reason: null,
  posted_at: `2026-06-01T08:0${n}:00.000000Z`,
  posted_by: { membership_id: '00000000-0000-4000-8000-000000000001', display_name: 'Nguyễn Văn An' },
  ...overrides,
});

const answer = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  items,
  next_cursor: null,
  balance: { appropriated_vnd: '0', allocated_vnd: '40000000000', reserved_vnd: '0', committed_vnd: '30000000000', disbursed_vnd: '10000000000' },
  entry_count: items.length,
  as_of: '2026-06-01T16:59:59.999Z',
  ...extra,
});

afterEach(cleanup);

function open(pages: Array<Record<string, unknown>>, failing?: Error, projects: Array<Record<string, unknown>> = [line(1)]): Harness {
  const h = client(world({ projects }));
  const previous = h.read.getMockImplementation();
  let call = 0;
  h.read.mockImplementation((operation: string, input?: unknown) => {
    if (operation === 'listCapitalLedger') {
      if (failing !== undefined) return Promise.reject(failing);
      const page = pages[Math.min(call, pages.length - 1)];
      call += 1;
      return Promise.resolve(page);
    }
    return previous === undefined ? Promise.reject(new Error(`unexpected read ${operation}`)) : previous(operation, input);
  });
  return h;
}

const show = (h: Harness, permissions: readonly string[] = AUDITOR) => mount(<LedgerScreen route={ROUTE} />, h, { permissions, path: '/cap/cap-21' });
const asked = (h: Harness) => h.read.mock.calls.filter(([name]) => name === 'listCapitalLedger').map(([, input]) => (input as { query?: Record<string, unknown> }).query);
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('LedgerScreen (CAP-21): the capital ledger', () => {
  it('UI-CAP-21, UAT-AC227: lists the entries newest first with their type in words, amount, project, reason and who posted them, and the balance they add up to; no action writes', async () => {
    const h = open([answer([entry(3, 'REVERSAL', '2000000000', { reversal_of_id: '00000000-0000-4000-8000-0000000000e2', reason: 'A payment was reversed' }), entry(2, 'RELEASE', '5000000000', { reason: 'reservation RS-1 expired' }), entry(1, 'APPROPRIATE', '100000000000', { project: null, allocation_line_id: null })])]);
    show(h);
    const table = await screen.findByTestId('entries');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['cap.ledger.page.title']);
    for (const key of ['cap.ledger.col.posted', 'cap.ledger.col.type', 'cap.ledger.col.amount', 'cap.ledger.col.project', 'cap.ledger.col.reason', 'cap.ledger.col.by'] as const) {
      expect(within(table).getByRole('columnheader', { name: vi_[key] })).toBeTruthy();
    }
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain(vi_['cap.ledger.type.reversal']);
    expect(rows[0]?.textContent).toContain(vi_['cap.ledger.reversal.of'].replace('{id}', '00000000-0000-4000-8000-0000000000e2'));
    expect(rows[0]?.textContent).toContain('2.000.000.000 đồng');
    expect(rows[0]?.textContent).toContain('A payment was reversed');
    expect(rows[1]?.textContent).toContain(vi_['cap.ledger.type.release']);
    expect(rows[1]?.textContent).toContain('DA-2026-001 Dự án số 1');
    expect(rows[1]?.textContent).toContain('Nguyễn Văn An');
    expect(rows[2]?.textContent).toContain(vi_['cap.ledger.type.appropriate']);
    expect(within(rows[2] as HTMLElement).getAllByRole('cell')[3]?.textContent).toBe('—');
    const balance = screen.getByTestId('balance');
    expect(within(balance).getByRole('heading', { level: 2 }).textContent).toBe(vi_['cap.ledger.balance.title'].replace('{count}', '3'));
    expect(balance.querySelector('[data-column="allocated"]')?.textContent).toContain('40.000.000.000 đồng');
    expect(balance.querySelector('[data-column="reserved"]')?.textContent).toContain('0 đồng');
    expect(balance.querySelector('[data-column="disbursed"]')?.textContent).toContain('10.000.000.000 đồng');
    expect(screen.getByTestId('as-of').textContent).toBe(vi_['cap.ledger.balance.now']);
    expect(asked(h)[0]).toEqual({ limit: 25 });
    // The only controls are the filter and the paging: nothing writes.
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([vi_['cap.ledger.filter.apply.action']]);
    expect(h.command).not.toHaveBeenCalled();
  });

  it('filters by project, source and line and views the balance at a day, asking the server with exactly that', async () => {
    const h = open([answer([entry(1, 'ALLOCATE', '40000000000')]), answer([entry(1, 'ALLOCATE', '40000000000')], { balance: { appropriated_vnd: '0', allocated_vnd: '40000000000', reserved_vnd: '5000000000', committed_vnd: '0', disbursed_vnd: '0' } })]);
    show(h);
    await screen.findByTestId('entries');
    const chooser = screen.getByLabelText(vi_['cap.ledger.field.project.label']) as HTMLSelectElement;
    await waitFor(() => expect(Array.from(chooser.options).some((option) => option.value === line(1).id)).toBe(true));
    fireEvent.change(chooser, { target: { value: line(1).id } });
    type(vi_['cap.ledger.field.appropriation.label'], ` ${APPROPRIATION} `);
    type(vi_['cap.ledger.field.line.label'], LINE);
    type(vi_['cap.ledger.field.day.label'], '2026-06-01');
    fireEvent.click(screen.getByRole('button', { name: vi_['cap.ledger.filter.apply.action'] }));
    await waitFor(() => expect(asked(h).at(-1)).toEqual({ project_id: line(1).id, appropriation_id: APPROPRIATION, allocation_line_id: LINE, at: '2026-06-01', limit: 25 }));
    await waitFor(() => expect(screen.getByTestId('as-of').textContent).toBe(vi_['cap.ledger.balance.at'].replace('{day}', '2026-06-01')));
    await waitFor(() => expect(screen.getByTestId('balance').querySelector('[data-column="reserved"]')?.textContent).toContain('5.000.000.000 đồng'));
  });

  it('refuses before it asks an identifier that is not one and a day that does not exist', async () => {
    const h = open([answer([entry(1, 'ALLOCATE', '1')])]);
    show(h);
    await screen.findByTestId('entries');
    type(vi_['cap.ledger.field.appropriation.label'], 'x');
    type(vi_['cap.ledger.field.line.label'], 'y');
    fireEvent.click(screen.getByRole('button', { name: vi_['cap.ledger.filter.apply.action'] }));
    expect((await screen.findAllByText(vi_['cap.ledger.field.invalid.error'])).length).toBe(2);
    expect(asked(h)).toHaveLength(1);
  });

  it('goes on with the next page and keeps the balance of the first', async () => {
    const h = open([answer([entry(2, 'COMMIT', '1')], { next_cursor: 'CURSOR-1', entry_count: 2 }), answer([entry(1, 'ALLOCATE', '1')], { entry_count: 2 })]);
    show(h);
    await screen.findByTestId('entries');
    fireEvent.click(await screen.findByRole('button', { name: vi_['cap.ledger.more.action'] }));
    await waitFor(() => expect(within(screen.getByTestId('entries')).getAllByRole('row')).toHaveLength(3));
    expect(asked(h)[1]).toEqual({ limit: 25, cursor: 'CURSOR-1' });
    expect(screen.queryByRole('button', { name: vi_['cap.ledger.more.action'] })).toBeNull();
  });

  it('says that nothing was posted, hides the project list from a caller who cannot read projects, and says in words that the ledger could not be read', async () => {
    show(open([answer([])], undefined, []));
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    expect(screen.queryByLabelText(vi_['cap.ledger.field.project.label'])).toBeNull();
    cleanup();
    const failing = open([answer([])], new ApiError({ status: 500, code: 'INTERNAL', correlationId: 'c' }));
    show(failing);
    fireEvent.click(await screen.findByRole('button', { name: vi_['states.retry.action'] }));
    await waitFor(() => expect(asked(failing).length).toBeGreaterThanOrEqual(2));
  });
});

describe('the model of the ledger', () => {
  it('reads a page, leaves out what is not an entry, and shows whole dong exactly', () => {
    const page = toLedgerPage(answer([entry(1, 'ALLOCATE', '5'), { id: 'x' }, null, entry(2, 'COMMIT', '6', { project: { code: 'no id' }, posted_by: {}, plan_year: 'x', reason: 5 })], { next_cursor: 'N', entry_count: 'x' }));
    expect(page.items.map((item) => item.entryType)).toEqual(['ALLOCATE', 'COMMIT']);
    expect(page.items[1]).toMatchObject({ project: null, postedBy: '', planYear: 0, reason: null });
    expect(page).toMatchObject({ nextCursor: 'N', entryCount: 0, asOf: '2026-06-01T16:59:59.999Z', balance: { allocated: '40000000000', reserved: '0' } });
    expect(toLedgerPage(undefined)).toEqual({ items: [], nextCursor: undefined, balance: { appropriated: '0', allocated: '0', reserved: '0', committed: '0', disbursed: '0' }, entryCount: 0, asOf: '' });
    expect(toLedgerPage({ items: [entry(1, 'ALLOCATE', '5', { posted_by: { membership_id: 'm1' } })] }).items[0]?.postedBy).toBe('m1');
    expect(formatVnd('9007199254740993', 'en')).toBe('9,007,199,254,740,993');
    expect(formatVnd('-12', 'en')).toBe('-12');
    expect(formatVnd('12.5', 'en')).toBe('12.5');
  });

  it('checks the filter and builds the query of the read', () => {
    expect(validateFilter(EMPTY_FILTER)).toEqual({});
    expect(validateFilter({ projectId: '', appropriationId: APPROPRIATION, lineId: LINE, day: '2026-06-01' })).toEqual({});
    expect(validateFilter({ projectId: '', appropriationId: 'x', lineId: 'y', day: '2026-13-01' })).toEqual({ appropriationId: 'invalid', lineId: 'invalid', day: 'invalid' });
    expect(validateFilter({ projectId: '', appropriationId: ' ', lineId: ' ', day: '1/1/2026' })).toEqual({ day: 'invalid' });
    expect(ledgerQuery(EMPTY_FILTER)).toEqual({});
    expect(ledgerQuery({ projectId: 'p', appropriationId: ` ${APPROPRIATION} `, lineId: ` ${LINE} `, day: '2026-06-01' })).toEqual({ project_id: 'p', appropriation_id: APPROPRIATION, allocation_line_id: LINE, at: '2026-06-01' });
  });
});
