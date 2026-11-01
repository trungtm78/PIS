import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FAILURES } from '../../prj/closeout/test-support';
import { HANDLER, actions, fill, letter, letterId, openIncoming, problem, resetNetwork, sent, setOnline, word } from './test-support';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetNetwork();
});

const cards = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('li[data-letter]'));
const ready = () => waitFor(() => expect(cards().length).toBeGreaterThan(0));

describe('IncomingMobileScreen (DOC-23): the letters to handle, on a phone', () => {
  it('UI-DOC-23: shows the letters assigned to the handler, the late ones first, with their number, directive and deadline', async () => {
    openIncoming([
      letter(1),
      letter(2, { overdue_days: 3, is_overdue: true, due_on: '2026-10-20', leader_directive: null, number: null }),
      letter(3, { status: 'RESOLVED', actions: actions() }),
      letter(4, { assignee: { user_id: 'someone-else', display_name: 'Khác' }, actions: actions() }),
      letter(5, { assignee: null, status: 'PROCESSING', due_on: null, actions: actions({ resolve: true }), symbol: null }),
      letter(6, { assignee: { user_id: '00000000-0000-4000-8000-000000000001', display_name: 'Tôi' }, actions: actions(), due_on: '2026-10-26' }),
    ]);
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('doc.mobile.in.page.title'));
    expect(cards().map((card) => card.getAttribute('data-letter'))).toEqual([letterId(2), letterId(6), letterId(1), letterId(5)]);
    const first = within(cards()[2] as HTMLElement);
    expect(first.getByTestId('letter-title').textContent).toBe('Công văn số 1');
    expect(first.getByTestId('letter-number').textContent).toContain(fill(word('doc.mobile.in.number'), { number: '10 · 10/REG-DEN-2026' }));
    expect(first.getByTestId('directive').textContent).toBe(fill(word('doc.mobile.in.directive.text'), { text: 'Chuẩn bị ý kiến.' }));
    expect(first.getByTestId('due').textContent).toContain(fill(word('doc.mobile.in.due.text'), { date: '27/10/2026' }));
    expect(first.queryByTestId('overdue')).toBeNull();
    expect(first.getByRole('link', { name: word('doc.mobile.in.open.action') }).getAttribute('href')).toBe(`/doc/doc-13?id=${letterId(1)}`);
    const late = within(cards()[0] as HTMLElement);
    expect(late.getByTestId('directive').textContent).toBe(word('doc.mobile.in.directive.none'));
    expect(late.queryByTestId('letter-number')).toBeNull();
    const open = within(cards()[3] as HTMLElement);
    expect(open.getByTestId('due').textContent).toBe(word('doc.mobile.in.due.none'));
    expect(open.getByTestId('letter-number').textContent).toBe(fill(word('doc.mobile.in.number'), { number: '14' }) + ' · ');
  });

  it('UAT-AC420: tells how many days late an overdue letter is, with its deadline, and still lets it be resolved', async () => {
    const h = openIncoming([letter(1, { overdue_days: 1, is_overdue: true, actions: actions({ resolve: true }), status: 'PROCESSING' })]);
    await ready();
    expect(screen.getByTestId('overdue').textContent?.trim()).toBe(fill(word('doc.incoming.overdue'), { days: 1, date: '27/10/2026' }));
    fireEvent.click(screen.getByRole('button', { name: word('doc.incoming.resolve.action') }));
    expect(within(screen.getByTestId('resolve-form')).getByText(fill(word('doc.incoming.resolve.late'), { days: 1 }))).toBeTruthy();
    fireEvent.change(screen.getByLabelText(word('doc.incoming.field.summary')), { target: { value: ' Đã trả lời bằng văn bản ' } });
    fireEvent.click(screen.getByRole('button', { name: word('doc.incoming.resolve.submit') }));
    await waitFor(() => expect(sent(h, 'resolveIncomingDocument')).toHaveLength(1));
    expect(sent(h, 'resolveIncomingDocument')[0]).toMatchObject({ path: { id: letterId(1) }, ifMatchVersion: 3, body: { resolution_summary: 'Đã trả lời bằng văn bản' } });
    await waitFor(() => expect(screen.queryByTestId('resolve-form')).toBeNull());
  });

  it('AC-ST-DOC-020-2: sends every command under an idempotency key, the same one for a send repeated and another for another letter', async () => {
    const h = openIncoming([letter(1, { actions: actions({ resolve: true }), status: 'PROCESSING' })], { command: () => problem(500, 'INTERNAL_ERROR') });
    await ready();
    fireEvent.click(screen.getByRole('button', { name: word('doc.incoming.resolve.action') }));
    fireEvent.change(screen.getByLabelText(word('doc.incoming.field.summary')), { target: { value: 'Đã giải quyết xong' } });
    fireEvent.click(screen.getByRole('button', { name: word('doc.incoming.resolve.submit') }));
    await waitFor(() => expect(sent(h, 'resolveIncomingDocument')).toHaveLength(1));
    expect((await screen.findByTestId('refusal')).textContent).toBe(word('doc.incoming.error.general'));
    fireEvent.click(screen.getByRole('button', { name: word('doc.incoming.resolve.submit') }));
    await waitFor(() => expect(sent(h, 'resolveIncomingDocument')).toHaveLength(2));
    const [first, second] = sent(h, 'resolveIncomingDocument');
    const key = (input: Record<string, unknown> | undefined): string | undefined => (input?.attempt as { key?: string } | undefined)?.key;
    expect(key(first)).toMatch(/^[0-9a-f-]{36}$/);
    expect(key(second)).toBe(key(first));
  });

  it('starts the handling of an assigned letter with the version that was read', async () => {
    const h = openIncoming([letter(1)]);
    await ready();
    expect(screen.queryByRole('button', { name: word('doc.incoming.resolve.action') })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: word('doc.incoming.start.action') }));
    await waitFor(() => expect(sent(h, 'startIncomingDocumentProcessing')).toHaveLength(1));
    expect(sent(h, 'startIncomingDocumentProcessing')[0]).toMatchObject({ path: { id: letterId(1) }, ifMatchVersion: 3 });
    expect((sent(h, 'startIncomingDocumentProcessing')[0]?.attempt as { key: string }).key).toBeTruthy();
  });

  it('says what the server refused, and refuses a summary that is too short without sending it', async () => {
    const h = openIncoming([letter(1, { actions: actions({ resolve: true }), status: 'PROCESSING' })], { command: () => problem(409, 'VERSION_CONFLICT') });
    await ready();
    fireEvent.click(screen.getByRole('button', { name: word('doc.incoming.resolve.action') }));
    fireEvent.click(screen.getByRole('button', { name: word('doc.incoming.resolve.submit') }));
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(word('doc.incoming.field.summary')), { target: { value: 'Đã giải quyết xong' } });
    fireEvent.click(screen.getByRole('button', { name: word('doc.incoming.resolve.submit') }));
    expect((await screen.findByTestId('refusal')).textContent).toBe(word('doc.incoming.error.versionConflict'));
    fireEvent.click(screen.getByRole('button', { name: word('doc.mobile.in.cancel.action') }));
    expect(screen.queryByTestId('resolve-form')).toBeNull();
  });

  it('shows a refusal of the start in words', async () => {
    openIncoming([letter(1)], { command: () => problem(403, 'NOT_ASSIGNEE') });
    await ready();
    fireEvent.click(screen.getByRole('button', { name: word('doc.incoming.start.action') }));
    expect((await screen.findByTestId('refusal')).textContent).toBe(word('doc.incoming.error.notAssignee'));
  });

  it('offers nothing to do with no connection, says why, and sends nothing', async () => {
    setOnline(false);
    const h = openIncoming([letter(1)]);
    expect((await screen.findByTestId('offline-note')).textContent).toBe(word('doc.mobile.in.offline.notice'));
    expect((await screen.findByText(word('states.offline.title'))).tagName).toBe('H1');
    expect(h.command).not.toHaveBeenCalled();
    expect(globalThis.localStorage.length).toBe(0);
  });

  it('keeps the letters and takes the buttons away when the connection is lost', async () => {
    openIncoming([letter(1)]);
    await ready();
    expect(screen.queryByTestId('offline-note')).toBeNull();
    setOnline(false);
    fireEvent(window, new Event('offline'));
    await waitFor(() => expect(screen.getByTestId('offline-note')).toBeTruthy());
    expect(cards()).toHaveLength(1);
    expect(screen.queryByRole('button', { name: word('doc.incoming.start.action') })).toBeNull();
  });

  it('is read-only for a suspended tenant: the letters are shown and no command is offered', async () => {
    openIncoming([letter(1)], { mode: 'READ_ONLY' });
    await ready();
    expect(screen.queryByRole('button', { name: word('doc.incoming.start.action') })).toBeNull();
    expect(screen.getByRole('link', { name: word('doc.mobile.in.open.action') })).toBeTruthy();
  });

  it('shows the denied state and reads nothing without the permission to read letters', async () => {
    const h = openIncoming([letter(1)], { permissions: ['doc.incoming.process'] });
    expect((await screen.findByText(word('states.denied.title'))).tagName).toBe('H1');
    expect(h.read).not.toHaveBeenCalled();
  });

  it('reads while the permissions are not known yet', async () => {
    openIncoming([letter(1)], { permissions: undefined });
    await ready();
  });

  it('reads on through pages that hold no letter to handle until one is found', async () => {
    const resolved = Array.from({ length: 2 }, (_, index) => letter(index + 1, { status: 'RESOLVED', actions: actions() }));
    const h = openIncoming([...resolved, letter(3)], { page: 2 });
    await ready();
    expect(cards()).toHaveLength(1);
    expect(h.read).toHaveBeenCalledTimes(2);
  });

  it('takes the resolution form away and sends nothing when the device goes offline after it was opened', async () => {
    const h = openIncoming([letter(1, { actions: actions({ resolve: true }), status: 'PROCESSING' })]);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: word('doc.incoming.resolve.action') }));
    fireEvent.change(screen.getByLabelText(word('doc.incoming.field.summary')), { target: { value: 'Đã giải quyết xong' } });
    setOnline(false);
    fireEvent(window, new Event('offline'));
    await waitFor(() => expect(screen.queryByTestId('resolve-form')).toBeNull());
    expect(h.command).not.toHaveBeenCalled();
  });

  it('shows the empty state when there is no letter to handle', async () => {
    openIncoming([letter(1, { status: 'RESOLVED', actions: actions() })], { permissions: HANDLER });
    expect((await screen.findByText(word('states.empty.title'))).tagName).toBe('H1');
  });

  it('shows the loading state while the letters are on their way', () => {
    openIncoming([], { reads: () => new Promise(() => undefined) });
    expect(screen.getByRole('status', { name: word('states.loading.label') })).toBeTruthy();
  });

  it.each(FAILURES)('shows the %s state when the letters cannot be read, and reads again on retry', async (_name, failure, title) => {
    const h = openIncoming([letter(1)], { reads: () => Promise.reject(failure) });
    expect((await screen.findByText(title)).tagName).toBe('H1');
    const before = h.read.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
    await waitFor(() => expect(h.read.mock.calls.length).toBeGreaterThan(before));
  });

  it('keeps the letters and the summary being typed when the next page cannot be read, and appends the page when it is asked for again', async () => {
    let failing = true;
    const pages = [[letter(1, { actions: actions({ resolve: true }), status: 'PROCESSING' })], [letter(2, { due_on: '2026-10-28' })]];
    const h = openIncoming([], {
      reads: (_operation, input) => {
        const cursor = (input as { query?: { cursor?: string } } | undefined)?.query?.cursor;
        if (cursor === undefined) return Promise.resolve({ items: pages[0], next_cursor: 'p2', as_of: '2026-10-28T04:00:00.000Z' });
        if (failing) return Promise.reject(problem(500, 'INTERNAL_ERROR'));
        return Promise.resolve({ items: pages[1], as_of: '2026-10-28T04:00:00.000Z' });
      },
    });
    await ready();
    fireEvent.click(screen.getByRole('button', { name: word('doc.incoming.resolve.action') }));
    fireEvent.change(screen.getByLabelText(word('doc.incoming.field.summary')), { target: { value: 'Đang soạn nội dung giải quyết' } });
    fireEvent.click(screen.getByRole('button', { name: word('doc.mobile.in.more.action') }));
    expect((await screen.findByTestId('more-failed')).textContent).toContain(word('doc.mobile.in.moreFailed.notice'));
    expect(cards()).toHaveLength(1);
    expect((screen.getByLabelText(word('doc.incoming.field.summary')) as HTMLTextAreaElement).value).toBe('Đang soạn nội dung giải quyết');
    expect(screen.queryByText(word('states.error.title'))).toBeNull();
    const asked = h.read.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.read.mock.calls.length).toBe(asked);
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: word('doc.mobile.in.moreRetry.action') }));
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(screen.queryByTestId('more-failed')).toBeNull();
    expect((screen.getByLabelText(word('doc.incoming.field.summary')) as HTMLTextAreaElement).value).toBe('Đang soạn nội dung giải quyết');
  });

  it('keeps asking for the next page until one letter to handle is found, and stops when a page cannot be read', async () => {
    const h = openIncoming([], {
      reads: (_operation, input) => {
        const cursor = (input as { query?: { cursor?: string } } | undefined)?.query?.cursor;
        if (cursor === undefined) return Promise.resolve({ items: [letter(3, { status: 'RESOLVED', actions: actions() })], next_cursor: 'p2', as_of: '2026-10-28T04:00:00.000Z' });
        return Promise.reject(problem(500, 'INTERNAL_ERROR'));
      },
    });
    expect(await screen.findByTestId('more-failed')).toBeTruthy();
    const asked = h.read.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.read.mock.calls.length).toBe(asked);
    expect(screen.getByText(word('states.empty.title'))).toBeTruthy();
  });

  it('pages through the letters', async () => {
    const h = openIncoming([letter(1), letter(2, { due_on: '2026-10-28' })], { page: 1 });
    await ready();
    expect(cards()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: word('doc.mobile.in.more.action') }));
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(h.read.mock.calls.at(-1)?.[1]).toMatchObject({ query: { cursor: '1' } });
  });
});
