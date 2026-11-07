import { ApiError } from '@machvon/api-client';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { harness, mountInSession, routeOf } from '../test-support';
import type { Harness } from '../test-support';
import IncomingHandlingScreen from './IncomingHandlingScreen';
import IncomingIntakeScreen from './IncomingIntakeScreen';
import IncomingLedgerScreen from './IncomingLedgerScreen';
import * as labels from './labels';
import { NO_FILTER, assignBody, describeProblem, duplicateOf, openRegistersOf, emptyAssign, emptyReceive, filterQuery, receiveBody, toIncomingLine, toIncomingPage, validateAssign, validateReceive, validateWords, vietnamToday } from './model';

const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), word(key));
const problem = (code: string, status = 422, extensions: Record<string, unknown> = {}, detail?: string) => new ApiError({ status, code, correlationId: 'c', extensions, ...(detail === undefined ? {} : { detail }) });

const UNIT = '00000000-0000-4000-8000-000000000f01';
const USER = '00000000-0000-4000-8000-0000000000b1';
const documentOf = (n: number): string => `00000000-0000-4000-8000-0000000e${String(n).padStart(4, '0')}`;
const letterId = (n: number): string => `00000000-0000-4000-8000-0000000d${String(n).padStart(4, '0')}`;
const actions = (on: Partial<Record<'register' | 'reject' | 'assign' | 'startProcessing' | 'resolve', boolean>> = {}) => ({ register: false, reject: false, assign: false, startProcessing: false, resolve: false, ...on });

/** A letter as the ledger answers it: assigned to the unit and a handler, due on the 27th, nothing the caller may do unless the test says so. */
const letter = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: letterId(n),
  document_id: documentOf(n),
  status: 'ASSIGNED',
  channel: 'UPLOAD',
  title: `Công văn số ${n}`,
  doc_type_code: 'CV',
  classification: 'INTERNAL',
  received_at: `2026-10-2${n}T02:00:00.000Z`,
  register: { id: '00000000-0000-4000-8000-000000000a01', code: 'REG-DEN-2026' },
  number: 9 + n,
  symbol: `${9 + n}/REG-DEN-2026`,
  original_symbol: `${n}/BTC`,
  original_issued_on: '2026-10-20',
  sender_name: 'Bộ Tài chính',
  urgency: 'NORMAL',
  due_on: '2026-10-27',
  leader_directive: 'Chuẩn bị ý kiến.',
  assigned_unit: { id: UNIT, name: 'Phòng Kế hoạch' },
  assignee: { user_id: USER, display_name: 'Chuyên viên An' },
  resolution_summary: null,
  resolved_at: null,
  late_days: null,
  response_outgoing_id: null,
  duplicate_of_id: null,
  duplicate_override_reason: null,
  rejection_reason: null,
  is_overdue: false,
  overdue_since: null,
  overdue_days: null,
  file_sha256: 'a'.repeat(64),
  version: 3,
  updated_at: '2026-10-23T03:00:00.000Z',
  actions: actions(),
  ...overrides,
});

interface World {
  letters: Array<Record<string, unknown>>;
  failing: Set<string>;
  page: number;
  /** The caller may assign but not read the units. */
  unitsDenied?: boolean;
}

function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({ resource_id: letterId(9), resource_version: 2 })): Harness & { upload: ReturnType<typeof vi.fn> } {
  const h = harness((operation, input) => {
    if (state.failing.has(operation)) return Promise.reject(new Error(`${operation} failed`));
    if (operation === 'listIncomingDocuments') {
      const query = (input as { query?: Record<string, string | number> } | undefined)?.query ?? {};
      const items = state.letters.filter((item) => (query.status === undefined || item.status === query.status) && (query.overdue === undefined || item.is_overdue === true) && (query.year === undefined || String(item.received_at).startsWith(String(query.year))));
      const start = query.cursor === undefined ? 0 : Number(query.cursor);
      return { items: items.slice(start, start + state.page), ...(start + state.page < items.length ? { next_cursor: String(start + state.page) } : {}), as_of: '2026-10-28T04:00:00.000Z' };
    }
    if (operation === 'getIncomingDocument') {
      const found = state.letters.find((item) => item.id === (input as { path: { id: string } }).path.id);
      return found === undefined ? new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c', extensions: {} }) : found;
    }
    return new Error(`unexpected read ${operation}`);
  }, command);
  const upload = vi.fn(() => Promise.resolve({ file_object_key: 'tenants/t/document/file-1', file_sha256: 'c'.repeat(64) }));
  (h.client as unknown as { upload: unknown; readAll: unknown }).upload = upload;
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => {
    if (operation === 'get_resources_organization_unit') return state.unitsDenied === true ? Promise.reject(problem('SCOPE_DENIED', 403)) : Promise.resolve([{ id: UNIT, code: 'KH', name: 'Phòng Kế hoạch' }]);
    return Promise.reject(new Error(`unexpected readAll ${operation}`));
  });
  return { ...h, upload };
}

const THIS_YEAR = Number(new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 4));
const register = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-0000000a${String(n).padStart(4, '0')}`,
  register_code: `REG-DEN-${n}`,
  name: `Sổ đến ${n}`,
  direction: 'INCOMING',
  organization_unit_id: UNIT,
  year: THIS_YEAR,
  mode: 'MANAGED',
  last_number: 0,
  status: 'OPEN',
  scope_doc_types: ['CV'],
  version: 1,
  ...overrides,
});
const docTypes = [{ id: 'dt1', code: 'CV', name: 'Công văn', symbol_kind: 'OFFICIAL_LETTER', symbol_pattern: '{number}/{type}', status: 'DEFINED' }];

/** Answers the registers (and with them the document types); with `readable: false` the caller may not read them. */
function withRegisters(h: Harness, items: Array<Record<string, unknown>> = [], readable = true): void {
  const original = h.read.getMockImplementation();
  h.read.mockImplementation((operation: string, input?: unknown) => {
    if (operation !== 'listDocumentNumberRegisters') return (original as (a: string, b?: unknown) => Promise<unknown>)(operation, input);
    return readable ? Promise.resolve({ items, doc_types: docTypes }) : Promise.reject(problem('SCOPE_DENIED', 403));
  });
}

const ALL = ['doc.incoming.receive', 'doc.incoming.register', 'doc.incoming.assign', 'doc.incoming.process', 'doc.incoming.read', 'doc.file.upload'];

function ledger(state: Partial<World> = {}, options: { permissions?: readonly string[]; mode?: 'FULL' | 'READ_ONLY' } = {}) {
  const h = client({ letters: [], failing: new Set(), page: 50, ...state });
  mountInSession(<IncomingLedgerScreen route={routeOf('DOC-12', 'FR-DOC-12')} />, h, { permissions: options.permissions ?? ALL, ...(options.mode === undefined ? {} : { mode: options.mode }) }, '/doc/doc-12');
  return h;
}

function handling(state: Partial<World>, id: string | undefined, command?: (operation: string, input: unknown) => unknown, options: { mode?: 'FULL' | 'READ_ONLY'; registers?: Array<Record<string, unknown>>; readable?: boolean } = {}) {
  const world: World = Object.assign(state, { letters: state.letters ?? [], failing: state.failing ?? new Set<string>(), page: state.page ?? 50 }) as World;
  const h = client(world, command);
  withRegisters(h, options.registers ?? [register(1)], options.readable ?? true);
  mountInSession(<IncomingHandlingScreen route={routeOf('DOC-13', 'FR-DOC-13')} />, h, { permissions: ALL, ...(options.mode === undefined ? {} : { mode: options.mode }) }, `/doc/doc-13${id === undefined ? '' : `?id=${id}`}`);
  return h;
}

function intake(options: { permissions?: readonly string[]; mode?: 'FULL' | 'READ_ONLY'; command?: (operation: string, input: unknown) => unknown; readable?: boolean } = {}) {
  const h = client({ letters: [], failing: new Set(), page: 50 }, options.command);
  withRegisters(h, [], options.readable ?? true);
  mountInSession(<IncomingIntakeScreen route={routeOf('DOC-11', 'FR-DOC-11')} />, h, { permissions: options.permissions ?? ALL, ...(options.mode === undefined ? {} : { mode: options.mode }) }, '/doc/doc-11');
  return h;
}

const rows = (): string[] => Array.from(document.querySelectorAll('[data-letter]')).map((row) => row.getAttribute('data-letter') as string);
const carrier = (id: string): HTMLElement => document.querySelector(`[data-letter="${id}"]`) as HTMLElement;
const row = (id: string): HTMLElement => carrier(id).closest('tr') as HTMLElement;
const pick = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const dialog = (): HTMLElement => screen.getByRole('dialog');
const commandsOf = (h: Harness, operation: string): Array<{ path?: { id?: string }; body?: Record<string, unknown>; ifMatchVersion?: number }> =>
  h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { path?: { id?: string }; body?: Record<string, unknown>; ifMatchVersion?: number });
const pdf = (name = 'letter.pdf'): File => new File(['%PDF-1.4 letter'], name, { type: 'application/pdf' });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('IncomingLedgerScreen (DOC-12): the register of the incoming documents', () => {
  it('UI-DOC-12: lists the letters with number, sender, unit, handler, deadline and a chip for the ones that are overdue', async () => {
    ledger({ letters: [letter(3, { is_overdue: true, overdue_days: 1 }), letter(2, { status: 'RECEIVED', register: null, number: null, symbol: null, assigned_unit: null, assignee: null, due_on: null }), letter(1, { urgency: 'HOA_TOC' })] });
    await screen.findByTestId('letters');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('doc.incoming.ledger.title'));
    expect(screen.getByText(text('doc.incoming.footer.reference', { id: 'DOC-12', req: 'FR-DOC-12' }))).toBeTruthy();
    expect(rows()).toEqual([letterId(3), letterId(2), letterId(1)]);
    const overdue = row(letterId(3));
    expect(within(overdue).getByTestId('number').textContent).toBe('12/REG-DEN-2026');
    expect(within(overdue).getByTestId('letter').textContent).toContain('Bộ Tài chính');
    expect(within(overdue).getByTestId('assigned').textContent).toContain('Phòng Kế hoạch');
    expect(within(overdue).getByTestId('assigned').textContent).toContain('Chuyên viên An');
    expect(within(overdue).getByTestId('overdue').textContent).toBe(text('doc.incoming.overdue', { days: 1, date: '27/10/26' }));
    expect(carrier(letterId(3)).getAttribute('data-overdue')).toBe('yes');
    const received = row(letterId(2));
    expect(within(received).getByTestId('number').textContent).toBe(word('doc.incoming.none'));
    expect(within(received).getByTestId('status').textContent).toBe(word('doc.incoming.status.received'));
    expect(within(received).queryByTestId('overdue')).toBeNull();
    expect(within(row(letterId(1))).getByText(word('doc.incoming.urgency.hoaToc'))).toBeTruthy();
    expect(
      within(row(letterId(3)))
        .getByRole('link', { name: word('doc.incoming.open.action') })
        .getAttribute('href'),
    ).toBe(`/doc/doc-13?id=${letterId(3)}`);
  });

  it('narrows the list by state, year and overdue, sending only what was chosen, and reads a page at a time', async () => {
    const h = ledger({ page: 2, letters: [letter(3, { is_overdue: true }), letter(2, { status: 'PROCESSING' }), letter(1)] });
    await screen.findByTestId('letters');
    const reads = () => h.read.mock.calls.filter((call) => call[0] === 'listIncomingDocuments').map((call) => (call[1] as { query?: Record<string, unknown> }).query);
    expect(reads()[0]).toEqual({ limit: 50 });
    expect(rows()).toEqual([letterId(3), letterId(2)]);
    fireEvent.click(screen.getByRole('button', { name: word('doc.incoming.more.action') }));
    await waitFor(() => expect(rows()).toEqual([letterId(3), letterId(2), letterId(1)]));
    pick('incoming-filter-status', 'PROCESSING');
    await waitFor(() => expect(rows()).toEqual([letterId(2)]));
    pick('incoming-filter-status', '');
    fireEvent.click(document.getElementById('incoming-filter-overdue') as HTMLElement);
    await waitFor(() => expect(rows()).toEqual([letterId(3)]));
    expect(reads().at(-1)).toEqual({ limit: 50, overdue: 'true' });
  });

  it('shows the state of a letter as a pill with its words, counts the conditions on the filter and clears them in one click', async () => {
    const h = ledger({ page: 50, letters: [letter(3, { is_overdue: true }), letter(2, { status: 'PROCESSING' })] });
    await screen.findByTestId('letters');
    expect(screen.queryByRole('button', { name: /xóa bộ lọc/i })).toBeNull();
    // The columns are named and the first one is the one that stays in view.
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      word('doc.incoming.column.number'),
      word('doc.incoming.column.letter'),
      word('doc.incoming.column.received'),
      word('doc.incoming.column.assigned'),
      word('doc.incoming.column.status'),
      word('doc.incoming.column.actions'),
    ]);
    expect(within(row(letterId(2))).getByTestId('status').textContent).toBe(word('doc.incoming.status.processing'));
    pick('incoming-filter-status', 'PROCESSING');
    await waitFor(() => expect(rows()).toEqual([letterId(2)]));
    expect(screen.getByRole('button', { name: /1/, expanded: false })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /xóa bộ lọc/i }));
    await waitFor(() => expect(rows()).toEqual([letterId(3), letterId(2)]));
    expect((document.getElementById('incoming-filter-status') as HTMLSelectElement).value).toBe('');
    expect(h.read.mock.calls.filter((call) => call[0] === 'listIncomingDocuments').at(-1)?.[1]).toEqual({ query: { limit: 50 } });
  });

  it('offers taking a letter in only to whoever may, says when there is none, and shows a read that failed', async () => {
    ledger({}, { permissions: ['doc.incoming.read'] });
    expect((await screen.findByTestId('no-letters')).textContent).toBe(word('doc.incoming.none.notice'));
    expect(screen.queryByRole('link', { name: word('doc.incoming.intake.link') })).toBeNull();
    cleanup();
    ledger({}, { mode: 'READ_ONLY' });
    await screen.findByTestId('no-letters');
    expect(screen.queryByRole('link', { name: word('doc.incoming.intake.link') })).toBeNull();
    cleanup();
    const state = { letters: [], failing: new Set(['listIncomingDocuments']), page: 50 };
    const h = client(state);
    mountInSession(<IncomingLedgerScreen route={routeOf('DOC-12', 'FR-DOC-12')} />, h, { permissions: ALL }, '/doc/doc-12');
    const retry = await screen.findByRole('button', { name: /thử lại|retry/i });
    state.failing.clear();
    fireEvent.click(retry);
    await screen.findByTestId('no-letters');
    expect(screen.getByRole('link', { name: word('doc.incoming.intake.link') })).toBeTruthy();
  });
});

describe('IncomingIntakeScreen (DOC-11): receiving a letter', () => {
  const fill = async (): Promise<void> => {
    await waitFor(() => expect(within(document.getElementById('incoming-type') as HTMLElement).getByText('CV')).toBeTruthy());
    pick('incoming-title', 'Công văn về kế hoạch vốn');
    pick('incoming-type', 'CV');
    pick('incoming-sender', 'Bộ Tài chính');
    pick('incoming-symbol', '1234/BTC-ĐTPT');
    pick('incoming-issued', '2026-10-20');
    fireEvent.change(document.getElementById('incoming-file') as HTMLInputElement, { target: { files: [pdf()] } });
  };
  const submit = (): void => {
    fireEvent.click(screen.getByRole('button', { name: word('doc.incoming.intake.submit') }));
  };

  it('asks for the file, the title, the type, the channel and the sender before it sends anything', async () => {
    const h = intake();
    await waitFor(() => expect(h.read).toHaveBeenCalled());
    submit();
    expect(await screen.findAllByText(word('doc.incoming.problem.required'))).toHaveLength(4);
    pick('incoming-title', 'ab');
    pick('incoming-issued', '2999-01-01');
    submit();
    expect(screen.getByText(word('doc.incoming.problem.tooShort'))).toBeTruthy();
    expect(screen.getByText(word('doc.incoming.problem.futureDate'))).toBeTruthy();
    fireEvent.change(document.getElementById('incoming-file') as HTMLInputElement, { target: { files: [new File(['x'], 'letter.docx', { type: 'application/msword' })] } });
    submit();
    expect(screen.getByText(word('doc.incoming.problem.notPdf'))).toBeTruthy();
    expect(h.upload).not.toHaveBeenCalled();
    expect(commandsOf(h, 'receiveIncomingDocument')).toHaveLength(0);
  });

  it('AC-ST-DOC-011-1: UAT-AC419 uploads the file, takes the letter in with the key and the hash that came back, and links to its handling', async () => {
    const h = intake();
    await fill();
    submit();
    expect((await screen.findByTestId('taken')).textContent).toContain(word('doc.incoming.intake.taken'));
    expect(screen.getByTestId('taken-link').getAttribute('href')).toBe(`/doc/doc-13?id=${letterId(9)}`);
    // The form starts over: a second click cannot take the same letter in again.
    expect((document.getElementById('incoming-title') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('incoming-file') as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: word('doc.incoming.intake.submit') }));
    expect(commandsOf(h, 'receiveIncomingDocument')).toHaveLength(1);
    expect(h.upload).toHaveBeenCalledTimes(1);
    const [sent] = commandsOf(h, 'receiveIncomingDocument');
    expect(sent?.body).toEqual({
      title: 'Công văn về kế hoạch vốn',
      doc_type_code: 'CV',
      channel: 'UPLOAD',
      file_object_key: 'tenants/t/document/file-1',
      file_sha256: 'c'.repeat(64),
      sender_name: 'Bộ Tài chính',
      urgency: 'NORMAL',
      original_symbol: '1234/BTC-ĐTPT',
      original_issued_on: '2026-10-20',
    });
  });

  it('AC-ST-DOC-011-1: UAT-AC419 warns of a letter that looks like one already there, links to it, and takes it in again only with the reason', async () => {
    let calls = 0;
    const h = intake({
      command: () => {
        calls += 1;
        if (calls === 1) throw problem('INCOMING_DUPLICATE_SUSPECTED', 409, { duplicate_of_id: letterId(1) });
        return { resource_id: letterId(2), resource_version: 1 };
      },
    });
    await fill();
    expect(document.getElementById('incoming-reason')).toBeNull();
    submit();
    expect((await screen.findByTestId('refusal')).textContent).toContain(word('doc.incoming.error.duplicate'));
    expect(screen.getByTestId('duplicate-link').getAttribute('href')).toBe(`/doc/doc-13?id=${letterId(1)}`);
    // The reason is asked for now, at least ten characters.
    pick('incoming-reason', 'ngắn');
    submit();
    expect(await screen.findByText(word('doc.incoming.problem.tooShort'))).toBeTruthy();
    pick('incoming-reason', 'Bản gốc gửi lại kèm phụ lục mới.');
    submit();
    expect((await screen.findByTestId('taken')).textContent).toContain(word('doc.incoming.intake.taken'));
    expect(commandsOf(h, 'receiveIncomingDocument').at(-1)?.body).toMatchObject({ duplicate_override_reason: 'Bản gốc gửi lại kèm phụ lục mới.' });
  });

  it('AC-ST-DOC-011-3: UAT-AC429 says that a letter with a level of state secret is not taken in, and where to send it instead', async () => {
    intake({
      command: () => {
        throw problem('STATE_SECRET_NOT_SUPPORTED', 422);
      },
    });
    await fill();
    submit();
    expect((await screen.findByTestId('refusal')).textContent).toBe(word('doc.incoming.error.stateSecret'));
    expect(screen.queryByTestId('taken')).toBeNull();
  });

  it('says what the server refused for the file, in words', async () => {
    const cases: Array<[Error, string]> = [
      [problem('UPLOAD_NOT_PDF'), 'doc.incoming.error.notPdf'],
      [problem('SCAN_PENDING', 409), 'doc.incoming.error.scanPending'],
      [problem('FILE_NOT_CLEAN'), 'doc.incoming.error.infected'],
      [problem('SCOPE_DENIED', 403), 'doc.incoming.error.denied'],
    ];
    for (const [error, key] of cases) {
      intake({
        command: () => {
          throw error;
        },
      });
      await fill();
      submit();
      expect((await screen.findByTestId('refusal')).textContent).toBe(word(key));
      cleanup();
    }
  });

  it('is read only for whoever may not receive letters or upload files, and in a read-only session', async () => {
    for (const options of [{ permissions: ['doc.incoming.read'] }, { permissions: ['doc.incoming.receive'] }, { mode: 'READ_ONLY' as const }]) {
      intake(options);
      expect(await screen.findByTestId('read-only')).toBeTruthy();
      expect((screen.getByRole('button', { name: word('doc.incoming.intake.submit') }) as HTMLButtonElement).disabled).toBe(true);
      cleanup();
    }
  });
});

describe('IncomingHandlingScreen (DOC-13): handling one letter', () => {
  const open = (overrides: Record<string, unknown>, command?: (operation: string, input: unknown) => unknown) => handling({ letters: [letter(1, overrides)] }, letterId(1), command);

  it('asks to choose a letter when none is named, and does not show a letter that is not there', async () => {
    handling({ letters: [] }, undefined);
    expect((await screen.findByTestId('no-letter-chosen')).textContent).toBe(word('doc.incoming.handling.choose'));
    cleanup();
    handling({ letters: [] }, letterId(5));
    expect(await screen.findByRole('button', { name: /thử lại|retry/i })).toBeTruthy();
    expect(screen.queryByTestId('letter-title')).toBeNull();
  });

  it('shows the letter with its facts, the overdue chip, and the history of the assignments', async () => {
    open({
      is_overdue: true,
      overdue_days: 2,
      duplicate_of_id: letterId(7),
      duplicate_override_reason: 'Bản gốc gửi lại kèm phụ lục.',
      assignments: [
        { id: 'a1', assigned_unit: { id: UNIT, name: 'Phòng Kế hoạch' }, assignee: { user_id: USER, display_name: 'Chuyên viên An' }, leader_directive: 'Lần một', due_on: '2026-10-24', assigned_at: '2026-10-22T03:00:00.000Z' },
        { id: 'a2', assigned_unit: { id: UNIT, name: 'Phòng Kế hoạch' }, assignee: null, leader_directive: null, due_on: '2026-10-27', assigned_at: '2026-10-23T03:00:00.000Z' },
      ],
    });
    expect((await screen.findByTestId('letter-title')).textContent).toContain('Công văn số 1');
    expect(screen.getByTestId('letter-status').textContent).toBe(word('doc.incoming.status.assigned'));
    expect(screen.getByTestId('overdue').textContent).toBe(text('doc.incoming.overdue', { days: 2, date: '27/10/26' }));
    expect(screen.getByTestId('fact-number').textContent).toBe('10/REG-DEN-2026');
    expect(screen.getByTestId('fact-sender').textContent).toBe('Bộ Tài chính');
    // The code of the document is what the other screens ask for when a decision is the ground of a step (the publication of a catalogue entry), so the person can read it here.
    expect(screen.getByTestId('fact-document').textContent).toBe(documentOf(1));
    expect(screen.getByTestId('fact-assigned').textContent).toBe('Phòng Kế hoạch · Chuyên viên An');
    expect(screen.getByTestId('fact-duplicate').querySelector('a')?.getAttribute('href')).toBe(`/doc/doc-13?id=${letterId(7)}`);
    const history = screen.getByTestId('history');
    expect(Array.from(history.querySelectorAll('[data-assignment]')).map((item) => item.getAttribute('data-assignment'))).toEqual(['a1', 'a2']);
    expect(history.textContent).toContain('Lần một');
    // No button when the server allows none.
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers a button only for what the letter and the caller allow, and none in a read-only session', async () => {
    open({ status: 'RECEIVED', register: null, actions: actions({ register: true, reject: true }) });
    await screen.findByTestId('letter-title');
    expect(Array.from(document.querySelectorAll('[data-action]')).map((button) => button.getAttribute('data-action'))).toEqual(['register', 'reject']);
    cleanup();
    open({ status: 'REGISTERED', actions: actions({ assign: true }) });
    await screen.findByTestId('letter-title');
    expect(screen.getByRole('button', { name: word('doc.incoming.assign.action') })).toBeTruthy();
    cleanup();
    open({ status: 'PROCESSING', actions: actions({ assign: true, resolve: true }) });
    await screen.findByTestId('letter-title');
    expect(screen.getByRole('button', { name: word('doc.incoming.reassign.action') })).toBeTruthy();
    expect(screen.getByRole('button', { name: word('doc.incoming.resolve.action') })).toBeTruthy();
    cleanup();
    handling({ letters: [letter(1, { actions: actions({ resolve: true }) })] }, letterId(1), undefined, { mode: 'READ_ONLY' });
    await screen.findByTestId('letter-title');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('AC-ST-DOC-011-1: UAT-AC419 registers the letter and starts working it under the version shown, and says what the server refused', async () => {
    const h = open({ status: 'RECEIVED', register: null, actions: actions({ register: true }), version: 4 });
    fireEvent.click(await screen.findByRole('button', { name: word('doc.incoming.register.action') }));
    // With one open register there is nothing to choose: the server takes it.
    expect(document.getElementById('register-choice')).toBeNull();
    fireEvent.click(within(dialog()).getByRole('button', { name: word('doc.incoming.register.submit') }));
    await waitFor(() => expect(commandsOf(h, 'registerIncomingDocument')).toHaveLength(1));
    expect(commandsOf(h, 'registerIncomingDocument')[0]).toMatchObject({ path: { id: letterId(1) }, ifMatchVersion: 4, body: {} });
    cleanup();
    const refused = open({ status: 'ASSIGNED', actions: actions({ startProcessing: true }) }, () => {
      throw problem('NOT_ASSIGNEE', 403);
    });
    fireEvent.click(await screen.findByRole('button', { name: word('doc.incoming.start.action') }));
    expect((await screen.findByTestId('refusal')).textContent).toBe(word('doc.incoming.error.notAssignee'));
    expect(commandsOf(refused, 'startIncomingDocumentProcessing')).toHaveLength(1);
  });

  it('asks the unit, the handler and the deadline of an assignment, and sends them under the version shown', async () => {
    const h = open({ status: 'REGISTERED', assigned_unit: null, assignee: null, due_on: null, actions: actions({ assign: true }), version: 2 });
    fireEvent.click(await screen.findByRole('button', { name: word('doc.incoming.assign.action') }));
    fireEvent.click(within(dialog()).getByRole('button', { name: word('doc.incoming.assign.submit') }));
    expect(within(dialog()).getByText(word('doc.incoming.problem.required'))).toBeTruthy();
    await waitFor(() => expect(within(document.getElementById('assign-unit') as HTMLElement).getByText('Phòng Kế hoạch')).toBeTruthy());
    pick('assign-unit', UNIT);
    pick('assign-user', 'not-an-id');
    pick('assign-due', '2020-01-01');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('doc.incoming.assign.submit') }));
    expect(within(dialog()).getByText(word('doc.incoming.problem.invalidId'))).toBeTruthy();
    expect(within(dialog()).getByText(word('doc.incoming.problem.pastDate'))).toBeTruthy();
    expect(commandsOf(h, 'assignIncomingDocument')).toHaveLength(0);
    pick('assign-user', USER);
    pick('assign-due', '2999-12-31');
    pick('assign-directive', '  Trả lời trước hạn.  ');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('doc.incoming.assign.submit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsOf(h, 'assignIncomingDocument')[0]).toMatchObject({ path: { id: letterId(1) }, ifMatchVersion: 2, body: { assigned_unit_id: UNIT, assignee_user_id: USER, due_on: '2999-12-31', leader_directive: 'Trả lời trước hạn.' } });
  });

  it('says what the server refused for an assignment, in words', async () => {
    const cases: Array<[Error, string]> = [
      [problem('ASSIGNEE_OUT_OF_SCOPE'), 'doc.incoming.error.outOfScope'],
      [problem('DUE_DATE_IN_PAST'), 'doc.incoming.error.dueInPast'],
      [problem('DOCUMENT_STATE_INVALID', 409), 'doc.incoming.error.wrongState'],
    ];
    for (const [error, key] of cases) {
      open({ status: 'REGISTERED', due_on: null, actions: actions({ assign: true }) }, () => {
        throw error;
      });
      fireEvent.click(await screen.findByRole('button', { name: word('doc.incoming.assign.action') }));
      await waitFor(() => expect(within(document.getElementById('assign-unit') as HTMLElement).getByText('Phòng Kế hoạch')).toBeTruthy());
      pick('assign-unit', UNIT);
      fireEvent.click(within(dialog()).getByRole('button', { name: word('doc.incoming.assign.submit') }));
      expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(word(key));
      cleanup();
    }
  });

  it('AC-ST-DOC-011-2: UAT-AC420 resolves a letter that is overdue, saying so, with the summary the handler wrote', async () => {
    const h = open({ status: 'PROCESSING', is_overdue: true, overdue_days: 1, actions: actions({ resolve: true }), version: 5 });
    fireEvent.click(await screen.findByRole('button', { name: word('doc.incoming.resolve.action') }));
    expect(within(dialog()).getByText(text('doc.incoming.resolve.late', { days: 1 }))).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole('button', { name: word('doc.incoming.resolve.submit') }));
    expect(within(dialog()).getByText(word('doc.incoming.problem.required'))).toBeTruthy();
    pick('resolve-summary', 'abc');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('doc.incoming.resolve.submit') }));
    expect(within(dialog()).getByText(word('doc.incoming.problem.tooShort'))).toBeTruthy();
    pick('resolve-summary', '  Đã trả lời bằng công văn.  ');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('doc.incoming.resolve.submit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsOf(h, 'resolveIncomingDocument')[0]).toMatchObject({ path: { id: letterId(1) }, ifMatchVersion: 5, body: { resolution_summary: 'Đã trả lời bằng công văn.' } });
  });

  it('shows how late a letter was resolved', async () => {
    open({ status: 'RESOLVED', resolution_summary: 'Đã trả lời.', resolved_at: '2026-10-28T08:00:00.000Z', late_days: 1 });
    expect((await screen.findByTestId('fact-late')).textContent).toBe(text('doc.incoming.late.days', { days: 1 }));
    expect(screen.getByTestId('fact-summary').textContent).toBe('Đã trả lời.');
  });

  it('rejects a letter that was only received, with a reason of at least ten characters', async () => {
    const h = open({ status: 'RECEIVED', register: null, actions: actions({ reject: true }), version: 1 });
    fireEvent.click(await screen.findByRole('button', { name: word('doc.incoming.reject.action') }));
    pick('reject-reason', 'ngắn');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('doc.incoming.reject.submit') }));
    expect(within(dialog()).getByText(word('doc.incoming.problem.tooShort'))).toBeTruthy();
    pick('reject-reason', 'Gửi nhầm đơn vị, không thuộc thẩm quyền.');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('doc.incoming.reject.submit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsOf(h, 'rejectIncomingDocument')[0]).toMatchObject({ path: { id: letterId(1) }, ifMatchVersion: 1, body: { rejection_reason: 'Gửi nhầm đơn vị, không thuộc thẩm quyền.' } });
  });
});

describe('reassigning a letter that has a directive', () => {
  it('opens with the directive that is there and sends it again, so that changing the deadline does not clear it', async () => {
    const h = handling({ letters: [letter(1, { status: 'ASSIGNED', due_on: '2999-01-01', leader_directive: 'Chuẩn bị ý kiến.', actions: actions({ assign: true }), version: 3 })] }, letterId(1));
    fireEvent.click(await screen.findByRole('button', { name: word('doc.incoming.reassign.action') }));
    expect((document.getElementById('assign-directive') as HTMLTextAreaElement).value).toBe('Chuẩn bị ý kiến.');
    await waitFor(() => expect(within(document.getElementById('assign-unit') as HTMLElement).getByText('Phòng Kế hoạch')).toBeTruthy());
    pick('assign-due', '2999-12-31');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('doc.incoming.assign.submit') }));
    await waitFor(() => expect(commandsOf(h, 'assignIncomingDocument')).toHaveLength(1));
    expect(commandsOf(h, 'assignIncomingDocument')[0]?.body).toMatchObject({ due_on: '2999-12-31', leader_directive: 'Chuẩn bị ý kiến.' });
  });
});

describe('a letter that changed while the screen was open', () => {
  it('reads the letter again and closes the dialog, saying so, so that the next try is made under the new version', async () => {
    const state: World = { letters: [letter(1, { status: 'PROCESSING', actions: actions({ resolve: true }), version: 5 })], failing: new Set(), page: 50 };
    const h = handling(state, letterId(1), () => {
      throw problem('VERSION_CONFLICT', 409, { current_version: 6 });
    });
    fireEvent.click(await screen.findByRole('button', { name: word('doc.incoming.resolve.action') }));
    pick('resolve-summary', 'Đã trả lời bằng công văn.');
    state.letters = [letter(1, { status: 'PROCESSING', actions: actions({ resolve: true }), version: 6 })];
    const reads = h.read.mock.calls.filter((call) => call[0] === 'getIncomingDocument').length;
    fireEvent.click(within(dialog()).getByRole('button', { name: word('doc.incoming.resolve.submit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await screen.findByTestId('refusal')).textContent).toBe(word('doc.incoming.error.versionConflict'));
    await waitFor(() => expect(h.read.mock.calls.filter((call) => call[0] === 'getIncomingDocument').length).toBeGreaterThan(reads));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    // The next try goes out under the version that is there now.
    fireEvent.click(await screen.findByRole('button', { name: word('doc.incoming.resolve.action') }));
    expect(screen.queryByTestId('refusal')).toBeNull();
    pick('resolve-summary', 'Đã trả lời bằng công văn.');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('doc.incoming.resolve.submit') }));
    await waitFor(() => expect(commandsOf(h, 'resolveIncomingDocument')).toHaveLength(2));
    expect(commandsOf(h, 'resolveIncomingDocument').map((call) => call.ifMatchVersion)).toEqual([5, 6]);
  });
});

describe('assigning without the right to read the units', () => {
  it('lets the unit be typed by its id, and sends it', async () => {
    const h = handling({ letters: [letter(1, { status: 'REGISTERED', assigned_unit: null, assignee: null, due_on: null, actions: actions({ assign: true }), version: 2 })], unitsDenied: true }, letterId(1));
    fireEvent.click(await screen.findByRole('button', { name: word('doc.incoming.assign.action') }));
    const field = await waitFor(() => {
      const found = document.getElementById('assign-unit') as HTMLInputElement;
      expect(found.tagName).toBe('INPUT');
      return found;
    });
    expect(screen.getByText(word('doc.incoming.field.unit.typed'))).toBeTruthy();
    fireEvent.change(field, { target: { value: 'not-an-id' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: word('doc.incoming.assign.submit') }));
    expect(within(dialog()).getByText(word('doc.incoming.problem.invalidId'))).toBeTruthy();
    expect(commandsOf(h, 'assignIncomingDocument')).toHaveLength(0);
    fireEvent.change(field, { target: { value: UNIT } });
    fireEvent.click(within(dialog()).getByRole('button', { name: word('doc.incoming.assign.submit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsOf(h, 'assignIncomingDocument')[0]).toMatchObject({ ifMatchVersion: 2, body: { assigned_unit_id: UNIT } });
  });
});

describe('registering with several open registers, an intake without the list of types, and a retry of the intake', () => {
  it('offers the open registers that the server names when there are several, and sends the one chosen', async () => {
    let calls = 0;
    const h = handling(
      { letters: [letter(1, { status: 'RECEIVED', register: null, actions: actions({ register: true }), version: 2 })] },
      letterId(1),
      () => {
        calls += 1;
        if (calls === 1) {
          throw problem(
            'VALIDATION_FAILED',
            422,
            {
              open_registers: [
                { id: register(1).id, register_code: 'REG-DEN-1', name: 'Sổ đến 1' },
                { id: register(2).id, register_code: 'REG-DEN-2', name: 'Sổ đến 2' },
              ],
            },
            'register_id',
          );
        }
        return { resource_id: letterId(1), resource_version: 3 };
      },
      { readable: false },
    );
    fireEvent.click(await screen.findByRole('button', { name: word('doc.incoming.register.action') }));
    expect(document.getElementById('register-choice')).toBeNull();
    fireEvent.click(within(dialog()).getByRole('button', { name: word('doc.incoming.register.submit') }));
    expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(word('doc.incoming.error.registerChoice'));
    const choice = document.getElementById('register-choice') as HTMLSelectElement;
    expect(Array.from(choice.options).map((option) => option.textContent)).toEqual([word('doc.incoming.register.automatic'), 'REG-DEN-1 · Sổ đến 1', 'REG-DEN-2 · Sổ đến 2']);
    pick('register-choice', register(2).id);
    fireEvent.click(within(dialog()).getByRole('button', { name: word('doc.incoming.register.submit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsOf(h, 'registerIncomingDocument').map((call) => call.body)).toEqual([{}, { register_id: register(2).id }]);
    expect(commandsOf(h, 'registerIncomingDocument')[1]).toMatchObject({ ifMatchVersion: 2 });
  });

  it('lets the type be typed when the list of types cannot be read, and sends the code', async () => {
    const h = intake({ readable: false });
    const field = await waitFor(() => {
      const found = document.getElementById('incoming-type') as HTMLInputElement;
      expect(found.tagName).toBe('INPUT');
      return found;
    });
    expect(screen.getByText(word('doc.incoming.field.docType.typed'))).toBeTruthy();
    pick('incoming-title', 'Công văn về kế hoạch vốn');
    fireEvent.change(field, { target: { value: ' cv ' } });
    pick('incoming-sender', 'Bộ Tài chính');
    fireEvent.change(document.getElementById('incoming-file') as HTMLInputElement, { target: { files: [pdf()] } });
    fireEvent.click(screen.getByRole('button', { name: word('doc.incoming.intake.submit') }));
    await screen.findByTestId('taken');
    expect(commandsOf(h, 'receiveIncomingDocument')[0]?.body).toMatchObject({ doc_type_code: 'CV' });
  });

  it('sends the same key and hash when a lost answer makes the clerk try again, and uploads again only for another file', async () => {
    let calls = 0;
    const h = intake({
      command: () => {
        calls += 1;
        if (calls === 1) throw new Error('the answer was lost');
        return { resource_id: letterId(9), resource_version: 1 };
      },
    });
    await waitFor(() => expect(within(document.getElementById('incoming-type') as HTMLElement).getByText('CV')).toBeTruthy());
    pick('incoming-title', 'Công văn về kế hoạch vốn');
    pick('incoming-type', 'CV');
    pick('incoming-sender', 'Bộ Tài chính');
    const file = pdf();
    fireEvent.change(document.getElementById('incoming-file') as HTMLInputElement, { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: word('doc.incoming.intake.submit') }));
    await screen.findByTestId('refusal');
    h.upload.mockImplementation(() => Promise.resolve({ file_object_key: 'tenants/t/document/file-2', file_sha256: 'd'.repeat(64) }));
    fireEvent.click(screen.getByRole('button', { name: word('doc.incoming.intake.submit') }));
    await screen.findByTestId('taken');
    // One upload, and the two receives carried the same file.
    expect(h.upload).toHaveBeenCalledTimes(1);
    const sent = commandsOf(h, 'receiveIncomingDocument').map((call) => [call.body?.file_object_key, call.body?.file_sha256]);
    expect(sent).toEqual([
      ['tenants/t/document/file-1', 'c'.repeat(64)],
      ['tenants/t/document/file-1', 'c'.repeat(64)],
    ]);
  });
});

describe('the model and the words of DOC-11..13', () => {
  it('reads a letter, a page and the actions, ignoring what is not a letter', () => {
    const line = toIncomingLine(letter(1, { actions: actions({ assign: true }) }));
    expect(line).toMatchObject({ id: letterId(1), status: 'ASSIGNED', symbol: '10/REG-DEN-2026', senderName: 'Bộ Tài chính', assignedUnit: { name: 'Phòng Kế hoạch' }, assignee: { userId: USER }, actions: { assign: true, resolve: false }, version: 3 });
    expect(toIncomingLine({ ...letter(1), status: 'LOST' })).toBeUndefined();
    expect(toIncomingLine({ ...letter(1), version: '3' })).toBeUndefined();
    expect(toIncomingLine(null)).toBeUndefined();
    expect(toIncomingLine({ ...letter(1), register: null, assigned_unit: null, assignee: null })).toMatchObject({ register: null, assignedUnit: null, assignee: null });
    expect(toIncomingPage({ items: [letter(1), { id: 3 }], next_cursor: 'x' })).toMatchObject({ lines: [{ id: letterId(1) }], next: 'x' });
    expect(toIncomingPage(undefined)).toEqual({ lines: [], next: undefined });
  });

  it('asks the server only for what was chosen and is well formed', () => {
    expect(filterQuery(NO_FILTER)).toEqual({});
    expect(filterQuery({ status: 'ASSIGNED', overdue: true, year: '2026' })).toEqual({ status: 'ASSIGNED', overdue: 'true', year: '2026' });
    expect(filterQuery({ status: 'LOST', overdue: false, year: '26' })).toEqual({});
  });

  it('validates the intake and builds what is sent', () => {
    const today = '2026-10-28';
    const file = { name: 'a.pdf', type: 'application/pdf', size: 10 };
    const form = { ...emptyReceive(), title: 'Công văn', docTypeCode: 'CV', senderName: 'Bộ Tài chính' };
    expect(validateReceive(form, file, today)).toEqual({});
    expect(validateReceive(emptyReceive(), undefined, today)).toEqual({ title: 'required', docTypeCode: 'required', senderName: 'required', file: 'required' });
    expect(validateReceive({ ...form, originalIssuedOn: '2026-02-30' }, file, today)).toEqual({ originalIssuedOn: 'invalidDate' });
    expect(validateReceive({ ...form, originalIssuedOn: '2026-10-29' }, file, today)).toEqual({ originalIssuedOn: 'futureDate' });
    expect(validateReceive({ ...form, duplicateReason: 'ngắn' }, file, today)).toEqual({ duplicateReason: 'tooShort' });
    expect(validateReceive(form, { name: 'a.doc', type: 'application/msword', size: 1 }, today)).toEqual({ file: 'notPdf' });
    expect(validateReceive(form, { name: 'a.PDF', type: '', size: 1 }, today)).toEqual({});
    expect(receiveBody({ ...form, originalSymbol: ' 1/BTC ', duplicateReason: ' Có lý do chính đáng. ' }, { key: 'k', sha256: 's' })).toEqual({
      title: 'Công văn',
      doc_type_code: 'CV',
      channel: 'UPLOAD',
      file_object_key: 'k',
      file_sha256: 's',
      sender_name: 'Bộ Tài chính',
      urgency: 'NORMAL',
      original_symbol: '1/BTC',
      duplicate_override_reason: 'Có lý do chính đáng.',
    });
  });

  it('validates an assignment and builds what is sent', () => {
    expect(validateAssign(emptyAssign(), '2026-10-28')).toEqual({ unitId: 'required' });
    expect(validateAssign({ ...emptyAssign(), unitId: 'x' }, '2026-10-28')).toEqual({ unitId: 'invalidId' });
    expect(validateAssign({ unitId: UNIT, assigneeUserId: 'x', directive: '', dueOn: '2026-10-27' }, '2026-10-28')).toEqual({ assigneeUserId: 'invalidId', dueOn: 'pastDate' });
    expect(validateAssign({ unitId: UNIT, assigneeUserId: '', directive: 'x'.repeat(2001), dueOn: '2026-13-01' }, '2026-10-28')).toEqual({ directive: 'tooLong', dueOn: 'invalidDate' });
    expect(assignBody({ unitId: UNIT, assigneeUserId: '', directive: '  ', dueOn: '' })).toEqual({ assigned_unit_id: UNIT });
    expect(assignBody({ unitId: UNIT, assigneeUserId: USER, directive: ' Làm ngay ', dueOn: '2026-10-30' })).toEqual({ assigned_unit_id: UNIT, assignee_user_id: USER, leader_directive: 'Làm ngay', due_on: '2026-10-30' });
    expect(validateWords('', 5, 10)).toBe('required');
    expect(validateWords('abc', 5, 10)).toBe('tooShort');
    expect(validateWords('x'.repeat(11), 5, 10)).toBe('tooLong');
    expect(validateWords('hợp lệ', 5, 10)).toBeUndefined();
    expect(vietnamToday(new Date('2026-10-27T17:30:00Z'))).toBe('2026-10-28');
  });

  it('words each refusal, names the letter a duplicate is a copy of, and has words for every state, channel, urgency and problem', () => {
    const cases: Array<[string, string]> = [
      ['INCOMING_DUPLICATE_SUSPECTED', 'duplicate'],
      ['UPLOAD_NOT_PDF', 'notPdf'],
      ['SCAN_PENDING', 'scanPending'],
      ['FILE_NOT_CLEAN', 'infected'],
      ['STATE_SECRET_NOT_SUPPORTED', 'stateSecret'],
      ['DOCUMENT_STATE_INVALID', 'wrongState'],
      ['REGISTER_NOT_OPEN', 'registerNotOpen'],
      ['REGISTER_LOCK_TIMEOUT', 'registerBusy'],
      ['ASSIGNEE_OUT_OF_SCOPE', 'outOfScope'],
      ['DUE_DATE_IN_PAST', 'dueInPast'],
      ['NOT_ASSIGNEE', 'notAssignee'],
      ['RESPONSE_DOCUMENT_NOT_ISSUED', 'responseNotIssued'],
      ['VERSION_CONFLICT', 'versionConflict'],
      ['VALIDATION_FAILED', 'validation'],
      ['RESOURCE_NOT_FOUND', 'notFound'],
      ['SCOPE_DENIED', 'denied'],
      ['SESSION_EXPIRED', 'session'],
      ['SOMETHING_ELSE', 'general'],
    ];
    for (const [code, expected] of cases) expect(describeProblem(problem(code))).toBe(expected);
    expect(describeProblem(problem('VALIDATION_FAILED', 422, {}, 'register_id'))).toBe('registerChoice');
    expect(openRegistersOf(problem('VALIDATION_FAILED', 422, { open_registers: [{ id: 'a', register_code: 'R1', name: 'Một' }, { id: 3 }, 'x'] }, 'register_id'))).toEqual([{ id: 'a', code: 'R1', name: 'Một' }]);
    expect(openRegistersOf(new Error('x'))).toEqual([]);
    expect(openRegistersOf(problem('VALIDATION_FAILED'))).toEqual([]);
    expect(describeProblem(new Error('x'))).toBe('general');
    expect(duplicateOf(problem('INCOMING_DUPLICATE_SUSPECTED', 409, { duplicate_of_id: letterId(1) }))).toBe(letterId(1));
    expect(duplicateOf(problem('INCOMING_DUPLICATE_SUSPECTED', 409, { duplicate_of_id: 'x' }))).toBeUndefined();
    expect(duplicateOf(problem('VALIDATION_FAILED'))).toBeUndefined();
    const t = ((key: string) => (vi_ as Record<string, string>)[key] ?? `MISSING:${key}`) as never;
    const all = [
      ...(['RECEIVED', 'REGISTERED', 'ASSIGNED', 'PROCESSING', 'RESOLVED', 'FILED', 'REJECTED'] as const).map((status) => labels.statusLabel(t, status)),
      ...(['PAPER_SCAN', 'EMAIL', 'LGSP', 'PORTAL', 'UPLOAD'] as const).map((channel) => labels.channelLabel(t, channel)),
      ...(['NORMAL', 'KHAN', 'THUONG_KHAN', 'HOA_TOC'] as const).map((urgency) => labels.urgencyLabel(t, urgency)),
      ...(['required', 'tooShort', 'tooLong', 'invalidDate', 'futureDate', 'pastDate', 'invalidId', 'notPdf'] as const).map((item) => labels.formProblemMessage(t, item)),
      ...[...cases.map(([, expected]) => expected), 'registerChoice'].map((expected) => labels.problemMessage(t, expected as never)),
    ];
    expect(all.filter((entry) => entry.startsWith('MISSING:'))).toEqual([]);
  });
});
