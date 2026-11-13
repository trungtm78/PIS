import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import NumberRegistersScreen from './NumberRegistersScreen';
import { CLERK, READER, harness, mount, routeOf } from './test-support';

const ROUTE = routeOf('DOC-10', 'FR-DOC-10');
const THIS_YEAR = new Date().getFullYear();

const register = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`,
  register_code: `REG-${n}`,
  name: `Register ${n}`,
  direction: 'OUTGOING',
  organization_unit_id: '00000000-0000-4000-8000-000000000f01',
  year: THIS_YEAR,
  mode: 'MANAGED',
  last_number: n,
  next_number: n + 1,
  status: 'OPEN',
  scope_doc_types: ['QD'],
  version: 1,
  ...overrides,
});
const ROWS = [register(1), register(2, { status: 'CLOSED', version: 2, direction: 'INCOMING', name: 'Incoming letters' }), register(3, { mode: 'MIRRORED' })];

const entry = (number: number, status = 'ALLOCATED') => ({
  allocation_id: `00000000-0000-4000-8000-0000000001${String(number).padStart(2, '0')}`,
  number,
  display_number: number < 10 ? `0${number}` : String(number),
  symbol: `${number < 10 ? `0${number}` : number}/QD-UBND`,
  document_id: '00000000-0000-4000-8000-0000000002aa',
  issued_on: '2026-06-15',
  status,
});

function answer(operation: string, input: unknown): unknown {
  if (operation === 'listDocumentNumberRegisters') return { items: ROWS, next_cursor: null, doc_types: [] };
  if (operation === 'listDocumentRegisterEntries') {
    const query = (input as { query?: { cursor?: string } }).query;
    return query?.cursor === undefined
      ? { register: ROWS[0], items: [entry(1), entry(2, 'VOIDED')], next_cursor: 'next' }
      : { register: ROWS[0], items: [entry(3)], next_cursor: null };
  }
  return new Error('unexpected read');
}

afterEach(cleanup);

/** The client of the harness has no real paging: this one follows next_cursor over the reads of the harness, as the real client does. */
function pageThrough(h: ReturnType<typeof harness>): void {
  (h.client as unknown as { readAll: unknown }).readAll = async (operation: string, input: { path?: unknown; query?: Record<string, unknown> }) => {
    const items: unknown[] = [];
    let cursor: string | undefined;
    do {
      const page = (await h.read(operation, { ...input, query: cursor === undefined ? input.query : { ...input.query, cursor } })) as { items: unknown[]; next_cursor: string | null };
      items.push(...page.items);
      cursor = page.next_cursor ?? undefined;
    } while (cursor !== undefined);
    return items;
  };
}

describe('NumberRegistersScreen (DOC-10)', () => {
  it('lists the registers with their counters and asks the server for the year of the filter', async () => {
    const h = harness(answer);
    mount(<NumberRegistersScreen route={ROUTE} />, h);
    expect(await screen.findByText('REG-1')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['doc.registers.page.title']);
    const row = screen.getByText('REG-3').closest('tr') as HTMLElement;
    expect(within(row).getAllByRole('cell')[3]?.textContent).toContain('3');
    expect(within(row).getByText(vi_['doc.registers.next.text'].replace('{number}', '4'))).toBeTruthy();
    expect(h.read).toHaveBeenCalledWith('listDocumentNumberRegisters', { query: { limit: 50, year: String(THIS_YEAR) } });
  });

  it('filters by text and status in the page and by year and direction on the server', async () => {
    const h = harness(answer);
    mount(<NumberRegistersScreen route={ROUTE} />, h);
    await screen.findByText('REG-1');
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(vi_['doc.registers.status.label']), 'CLOSED');
    await user.click(screen.getByRole('button', { name: vi_['doc.registers.filter.action'] }));
    expect(screen.queryByText('REG-1')).toBeNull();
    expect(screen.getByText('REG-2')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText(vi_['doc.registers.status.label']), '');
    await user.type(screen.getByLabelText(vi_['doc.registers.search.label']), 'nothing like it');
    await user.click(screen.getByRole('button', { name: vi_['doc.registers.filter.action'] }));
    expect(screen.getByText(vi_['doc.registers.filtered.empty'])).toBeTruthy();
    await user.clear(screen.getByLabelText(vi_['doc.registers.search.label']));
    await user.selectOptions(screen.getByLabelText(vi_['doc.registers.year.label']), '');
    await user.selectOptions(screen.getByLabelText(vi_['doc.registers.direction.label']), 'INCOMING');
    await user.click(screen.getByRole('button', { name: vi_['doc.registers.filter.action'] }));
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listDocumentNumberRegisters', { query: { limit: 50, direction: 'INCOMING' } }));
  });

  it('tells the state of a register on a pill, names the columns, counts the filters and clears them in one click when the filter finds nothing', async () => {
    mount(<NumberRegistersScreen route={ROUTE} />, harness(answer));
    await screen.findByText('REG-1');
    const row = screen.getByText('REG-2').closest('tr') as HTMLElement;
    expect(within(row).getByText(vi_['doc.registers.status.closed']).closest('.ui-pill')?.className).toContain('ui-tone-neutral');
    expect(within(screen.getByText('REG-1').closest('tr') as HTMLElement).getByText(vi_['doc.registers.status.open']).closest('.ui-pill')?.className).toContain('ui-tone-success');
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      vi_['doc.registers.col.register'],
      vi_['doc.registers.col.year'],
      vi_['doc.registers.col.direction'],
      vi_['doc.registers.col.counter'],
      vi_['doc.registers.col.status'],
      'Thao tác',
    ]);
    // The year is applied from the start: one condition.
    expect(screen.getByRole('button', { name: vi_['ui.filterPanel.toggleApplied'].replace('{count}', '1') })).toBeTruthy();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(vi_['doc.registers.search.label']), 'nothing like it');
    await user.click(screen.getByRole('button', { name: vi_['doc.registers.filter.action'] }));
    expect(screen.getByText(vi_['doc.registers.filtered.empty'])).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Xóa bộ lọc' }));
    expect(await screen.findByText('REG-1')).toBeTruthy();
    expect((screen.getByLabelText(vi_['doc.registers.search.label']) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(vi_['doc.registers.year.label']) as HTMLSelectElement).value).toBe('');
  });

  it('opens the log of a register with two-digit numbers, voided numbers marked, and pages it', async () => {
    const h = harness(answer);
    mount(<NumberRegistersScreen route={ROUTE} />, h);
    await screen.findByText('REG-1');
    const user = userEvent.setup();
    // The first register of the list is open from the start: its log is the book the clerk keeps.
    expect(screen.getByRole('button', { name: vi_['doc.registers.entries.label'].replace('{code}', 'REG-1') }).getAttribute('aria-pressed')).toBe('true');
    expect(await screen.findByText('01/QD-UBND')).toBeTruthy();
    const voided = screen.getByText('02/QD-UBND').closest('tr') as HTMLElement;
    expect(within(voided).getByText(vi_['doc.registers.entryStatus.voided'])).toBeTruthy();
    await user.click(screen.getByRole('button', { name: vi_['doc.registers.entries.more.action'] }));
    expect(await screen.findByText('03/QD-UBND')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: vi_['doc.registers.entries.label'].replace('{code}', 'REG-1') }));
    expect(screen.queryByText('01/QD-UBND')).toBeNull();
  });

  it('says so when a register has no number yet and when its log cannot be read', async () => {
    let failing = false;
    const h = harness((operation, input) => {
      if (operation === 'listDocumentRegisterEntries') return failing ? new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c' }) : { register: ROWS[0], items: [], next_cursor: null };
      return answer(operation, input);
    });
    mount(<NumberRegistersScreen route={ROUTE} />, h);
    await screen.findByText('REG-1');
    const user = userEvent.setup();
    // The first register of the list is open from the start: its log is the book the clerk keeps.
    expect(screen.getByRole('button', { name: vi_['doc.registers.entries.label'].replace('{code}', 'REG-1') }).getAttribute('aria-pressed')).toBe('true');
    expect(await screen.findByText(vi_['doc.registers.entries.empty'])).toBeTruthy();
    failing = true;
    await user.click(screen.getByRole('button', { name: vi_['doc.registers.entries.label'].replace('{code}', 'REG-1') }));
    await user.click(screen.getByRole('button', { name: vi_['doc.registers.entries.label'].replace('{code}', 'REG-3') }));
    expect((await screen.findByRole('alert')).textContent).toBe(vi_['doc.problem.notFound.text']);
  });

  it('closes an open register after a reason, with the version that was read', async () => {
    const h = harness(answer, () => ({ status: 'CLOSED', resource_version: 2, resource_id: ROWS[0]?.id }));
    mount(<NumberRegistersScreen route={ROUTE} />, h);
    await screen.findByText('REG-1');
    const user = userEvent.setup();
    expect(screen.queryByRole('button', { name: vi_['doc.registers.close.label'].replace('{code}', 'REG-2') })).toBeNull();
    await user.click(screen.getByRole('button', { name: vi_['doc.registers.close.label'].replace('{code}', 'REG-1') }));
    await user.click(screen.getByRole('button', { name: vi_['doc.registers.close.confirm.action'] }));
    expect((await screen.findByRole('alert')).textContent).toBe(vi_['doc.form.problem.required']);
    expect(h.command).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText(vi_['doc.registers.close.reason.label']), 'closing at the end of the year');
    await user.click(screen.getByRole('button', { name: vi_['doc.registers.close.confirm.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('closeDocumentNumberRegister');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: ROWS[0]?.id }, body: { reason: 'closing at the end of the year' }, ifMatchVersion: 1 });
    expect(await screen.findByText(vi_['doc.registers.closed.notice'].replace('{code}', 'REG-1'))).toBeTruthy();
  });

  it.each([
    ['VERSION_CONFLICT', 409, 'doc.problem.conflict.text'],
    ['REGISTER_HAS_OPEN_NUMBERED_DOCUMENTS', 409, 'doc.problem.hasNumbered.text'],
    ['SCOPE_DENIED', 403, 'doc.problem.denied.text'],
  ] as const)('shows the refusal %s and lets the person cancel', async (code, status, key) => {
    const h = harness(answer, () => new ApiError({ status, code, correlationId: 'c' }));
    mount(<NumberRegistersScreen route={ROUTE} />, h);
    await screen.findByText('REG-1');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: vi_['doc.registers.close.label'].replace('{code}', 'REG-1') }));
    await user.type(screen.getByLabelText(vi_['doc.registers.close.reason.label']), 'closing at the end of the year');
    await user.click(screen.getByRole('button', { name: vi_['doc.registers.close.confirm.action'] }));
    expect((await screen.findByRole('alert')).textContent).toBe(vi_[key]);
    await user.click(screen.getByRole('button', { name: vi_['doc.registers.close.cancel.action'] }));
    expect(screen.queryByLabelText(vi_['doc.registers.close.reason.label'])).toBeNull();
  });

  it('offers no closing to a reader', async () => {
    const h = harness(answer);
    mount(<NumberRegistersScreen route={ROUTE} />, h, READER);
    await screen.findByText('REG-1');
    expect(screen.queryByRole('button', { name: vi_['doc.registers.close.label'].replace('{code}', 'REG-1') })).toBeNull();
    expect(screen.getAllByRole('button', { name: /Mở/ }).length).toBeGreaterThan(0);
  });

  it('AC-ST-DOC-002-2 / UAT-AC431: exports the whole ledger, every page, as a file with the scope and its SHA-256', async () => {
    const h = harness((operation, input) => {
      if (operation !== 'listDocumentRegisterEntries') return answer(operation, input);
      const cursor = (input as { query?: { cursor?: string } }).query?.cursor;
      return cursor === undefined
        ? { register: ROWS[0], items: [entry(1), entry(2, 'VOIDED')], next_cursor: 'next' }
        : { register: ROWS[0], items: [entry(3, 'RECALLED')], next_cursor: null };
    });
    pageThrough(h);
    mount(<NumberRegistersScreen route={ROUTE} />, h);
    await screen.findByText('REG-1');
    const user = userEvent.setup();
    // The first register of the list is open from the start: its log is the book the clerk keeps.
    expect(screen.getByRole('button', { name: vi_['doc.registers.entries.label'].replace('{code}', 'REG-1') }).getAttribute('aria-pressed')).toBe('true');
    await screen.findByText('01/QD-UBND');
    let blob: Blob | undefined;
    URL.createObjectURL = vi.fn((made: Blob) => {
      blob = made;
      return 'blob:ledger';
    });
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    await user.click(screen.getByRole('button', { name: vi_['doc.registers.export.action'] }));
    const notice = await screen.findByText(/SHA-256 [0-9a-f]{64}/);
    expect(click).toHaveBeenCalledTimes(1);
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob as Blob);
    });
    expect(text).toContain('01,01/QD-UBND');
    expect(text).toContain('03,03/QD-UBND');
    expect(text).toContain(vi_['doc.registers.entryStatus.voided']);
    expect(text).toContain(vi_['doc.registers.entryStatus.recalled']);
    expect(text).toContain('Cao Bang');
    const hash = /SHA-256 ([0-9a-f]{64})/.exec(notice.textContent ?? '')?.[1];
    expect(text).toContain(`${vi_['doc.registers.export.meta.hash']},${hash}`);
    expect(notice.textContent).toContain('REG-1: 3');
    click.mockRestore();
  });

  it('says why the ledger could not be exported and writes no file', async () => {
    let failing = false;
    const h = harness((operation, input) => (operation === 'listDocumentRegisterEntries' && failing ? new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }) : answer(operation, input)));
    pageThrough(h);
    mount(<NumberRegistersScreen route={ROUTE} />, h);
    await screen.findByText('REG-1');
    const user = userEvent.setup();
    // The first register of the list is open from the start: its log is the book the clerk keeps.
    expect(screen.getByRole('button', { name: vi_['doc.registers.entries.label'].replace('{code}', 'REG-1') }).getAttribute('aria-pressed')).toBe('true');
    await screen.findByText('01/QD-UBND');
    failing = true;
    URL.createObjectURL = vi.fn(() => 'blob:none');
    await user.click(screen.getByRole('button', { name: vi_['doc.registers.export.action'] }));
    expect((await screen.findByRole('alert')).textContent).toBe(vi_['doc.problem.denied.text']);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('loads the next page of registers on request', async () => {
    const h = harness((operation, input) => {
      if (operation !== 'listDocumentNumberRegisters') return answer(operation, input);
      const cursor = (input as { query?: { cursor?: string } }).query?.cursor;
      return cursor === undefined ? { items: [ROWS[0]], next_cursor: 'p2', doc_types: [] } : { items: [ROWS[2]], next_cursor: null, doc_types: [] };
    });
    mount(<NumberRegistersScreen route={ROUTE} />, h, CLERK);
    await screen.findByText('REG-1');
    const user = userEvent.setup();
    // The log of the first register, open from the start, has a button of its own with the same words: it is closed first.
    await user.click(screen.getByRole('button', { name: vi_['doc.registers.entries.label'].replace('{code}', 'REG-1') }));
    await user.click(screen.getByRole('button', { name: vi_['doc.registers.more.action'] }));
    expect(await screen.findByText('REG-3')).toBeTruthy();
    expect(screen.queryByRole('button', { name: vi_['doc.registers.more.action'] })).toBeNull();
  });

  it.each([
    ['empty', { items: [], next_cursor: null, doc_types: [] }, vi_['states.empty.title']],
    ['denied', new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }), vi_['states.denied.title']],
    ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
    ['error', new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), vi_['states.error.title']],
    ['signed out', new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), vi_['states.signedOut.title']],
  ])('shows the %s state', async (_name, reply, title) => {
    mount(<NumberRegistersScreen route={ROUTE} />, harness((operation) => (operation === 'listDocumentNumberRegisters' ? reply : new Error('unexpected read'))));
    expect(await screen.findByText(title)).toBeTruthy();
  });

  it('shows the loading state first', () => {
    mount(<NumberRegistersScreen route={ROUTE} />, harness(() => new Promise(() => undefined)));
    expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
  });
});
