import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../i18n';
import WhistleScreen from './aud/WhistleScreen';
import { AS_OF, harness, mount, never, problem, routeOf, uuid, word, rx } from './test/docaud';

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
  vi.restoreAllMocks();
});

const route = routeOf('AUD-18', 'AUD', 'FR-AUD-18');
const ALL = ['aud.whistle.read', 'aud.whistle.handle'];
const READ = ['aud.whistle.read'];
const ID = uuid(81);

const report = (over: Record<string, unknown> = {}) => ({
  id: ID,
  category: 'PROCUREMENT_IRREGULARITY',
  status: 'RECEIVED',
  received_on: '2027-03-03',
  subject_unit_id: null,
  handler_id: null,
  acknowledged_on: null,
  closed_on: null,
  clock: { acknowledge_due_on: '2027-03-10', acknowledge_state: 'OVERDUE', resolve_due_on: '2027-06-01', resolve_state: 'WAITING' },
  version: 2,
  ...over,
});
const detail = (over: Record<string, unknown> = {}) => ({ ...report(), as_of: AS_OF, body: 'A package was split to stay under the threshold of open bidding.', public_note: null, thread: [{ seq: 1, sender: 'REPORTER', body: 'The two orders were placed by the same officer.', sent_on: '2027-03-04', handler_id: null }], ...over });

function world(current: Record<string, unknown>, items: unknown[] = [report()]) {
  return (op: string): unknown => {
    if (op === 'getWhistleSummary') return { as_of: AS_OF, total: 3, open: 2, acknowledge_overdue: 1, resolve_overdue: 0 };
    if (op === 'listWhistleReports') return { as_of: AS_OF, items, has_more: false };
    if (op === 'getWhistleReport') return current;
    return {};
  };
}

function open(answer: (op: string, input: unknown) => unknown, command?: (op: string, input: unknown) => unknown, permissions: readonly string[] = ALL, path = '/') {
  const h = harness(answer, command);
  mount(<WhistleScreen route={route} />, h, permissions, path);
  return h;
}

describe('AUD-18, the anonymous reports', () => {
  it('UI-AUD-18: lists the queue with the two clocks, the counts with their "i", and says that no identity exists', async () => {
    open(world(detail()));
    expect(await screen.findByTestId(`ack-${ID}`)).toBeTruthy();
    expect(screen.getByTestId(`ack-${ID}`).textContent).toContain(word('gov12da.aud.clock.overdue'));
    expect(screen.getByTestId('figure-open').textContent).toBe('2');
    expect(screen.getByTestId('figure-ack-overdue').textContent).toBe('1');
    expect(screen.getByTestId('anonymous-note').textContent).toBe(word('gov12da.aud18.note.anonymous'));
    expect(screen.getAllByRole('button', { name: /Công thức và nguồn của/ }).length).toBeGreaterThanOrEqual(5);
    // Nothing on the screen asks for or shows a name, an address or a contact.
    expect(screen.queryByLabelText(/họ tên|địa chỉ|điện thoại|email/i)).toBeNull();
  });

  it('shows the detail with the text, the thread and the unit, and the actions only to a handler', async () => {
    open(world(detail()), undefined, ALL, `/?report=${ID}`);
    expect((await screen.findByTestId('detail-body')).textContent).toContain('split to stay under');
    expect(within(screen.getByTestId('thread')).getByText(word('gov12da.aud.sender.reporter'))).toBeTruthy();
    expect(screen.getByTestId('detail-unit').textContent).toBe(word('gov12da.aud18.fact.noUnit'));
    expect(screen.getByTestId('move-open')).toBeTruthy();
    cleanup();
    open(world(detail()), undefined, READ, `/?report=${ID}`);
    await screen.findByTestId('detail-body');
    expect(screen.queryByTestId('move-open')).toBeNull();
    expect(screen.queryByTestId('subject-open')).toBeNull();
    expect(screen.queryByTestId('reply-open')).toBeNull();
  });

  it('acknowledges at the version it saw; resolving asks for words the reporter can read and says when the step is not allowed', async () => {
    let calls = 0;
    const h = open(world(detail({ status: 'INVESTIGATING', version: 5 })), () => {
      calls += 1;
      return calls === 1 ? problem('WHISTLE_STATE_INVALID', 409) : { operation_id: 'x', status: 'RESOLVED', resource_version: 6, resource_id: ID };
    }, ALL, `/?report=${ID}`);
    fireEvent.click(await screen.findByTestId('move-open'));
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByLabelText(word('gov12da.aud18.move.choice')) as HTMLSelectElement).value).toBe('RESOLVE');
    const confirm = within(dialog).getByRole('button', { name: word('gov12da.aud18.move.confirm') }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(rx(word('gov12da.aud18.move.note'))), { target: { value: 'The orders were merged and re-tendered.' } });
    fireEvent.click(confirm);
    expect((await screen.findByRole('alert')).textContent).toBe(word('gov12da.error.whistleState.text'));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: word('gov12da.aud18.move.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
    expect(h.command).toHaveBeenLastCalledWith('moveWhistleReport', expect.objectContaining({ path: { id: ID }, ifMatchVersion: 5, body: { move: 'RESOLVE', note: 'The orders were merged and re-tendered.' } }));
  });

  it('names the unit the report is about, or clears it, and refuses what is not an identifier', async () => {
    const h = open(world(detail()), () => ({ operation_id: 'x', status: 'ACKNOWLEDGED', resource_version: 3, resource_id: ID }), ALL, `/?report=${ID}`);
    fireEvent.click(await screen.findByTestId('subject-open'));
    fireEvent.change(await screen.findByTestId('subject-unit'), { target: { value: 'not-an-id' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: word('gov12da.aud18.subject.confirm') }));
    expect((await screen.findByRole('alert')).textContent).toBe(word('gov12da.error.validation.text'));
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('subject-unit'), { target: { value: uuid(7) } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: word('gov12da.aud18.subject.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('assignWhistleSubject', expect.objectContaining({ path: { id: ID }, ifMatchVersion: 2, body: { unit_id: uuid(7) } })));
  });

  it('replies to the reporter and hides the actions of a closed report', async () => {
    const h = open(world(detail()), () => ({ operation_id: 'x', status: 'REPLIED', resource_version: 1, resource_id: ID }), ALL, `/?report=${ID}`);
    fireEvent.click(await screen.findByTestId('reply-open'));
    fireEvent.change(within(await screen.findByRole('dialog')).getByLabelText(rx(word('gov12da.aud18.reply.body'))), { target: { value: 'Which officer placed the orders?' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: word('gov12da.aud18.reply.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('replyToWhistleReporter', expect.objectContaining({ path: { id: ID }, body: { body: 'Which officer placed the orders?' } })));
    cleanup();
    open(world(detail({ status: 'RESOLVED', closed_on: '2027-03-09', public_note: 'The orders were merged.' })), undefined, ALL, `/?report=${ID}`);
    await screen.findByTestId('detail-body');
    expect(screen.queryByTestId('move-open')).toBeNull();
    expect(screen.queryByTestId('reply-open')).toBeNull();
  });

  it('says that a handler of the unit is refused, and shows the loading, empty, error and denied states', async () => {
    open(world(detail()), () => problem('WHISTLE_HANDLER_INVOLVED', 403), ALL, `/?report=${ID}`);
    fireEvent.click(await screen.findByTestId('subject-open'));
    fireEvent.change(await screen.findByTestId('subject-unit'), { target: { value: uuid(7) } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: word('gov12da.aud18.subject.confirm') }));
    expect((await screen.findByRole('alert')).textContent).toBe(word('gov12da.error.whistleInvolved.text'));
    cleanup();
    open(() => never());
    expect(await screen.findByRole('status', { name: word('states.loading.label') })).toBeTruthy();
    cleanup();
    open(world(detail(), []));
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    cleanup();
    open(() => problem('INTERNAL_ERROR', 500));
    expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
    cleanup();
    open(() => problem('SCOPE_DENIED', 403));
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
  });
});

describe('AUD-18, the queue that has more pages', () => {
  it('loads the next page with the offset of what is loaded and appends it', async () => {
    const other = uuid(82);
    const third = uuid(83);
    const h = open((op, input) => {
      if (op === 'getWhistleSummary') return { as_of: AS_OF, total: 3, open: 3, acknowledge_overdue: 0, resolve_overdue: 0 };
      if (op !== 'listWhistleReports') return {};
      const offset = (input as { query: { offset: number } }).query.offset;
      return offset === 0 ? { as_of: AS_OF, items: [report(), report({ id: other })], has_more: true } : { as_of: AS_OF, items: [report({ id: third })], has_more: false };
    });
    await screen.findByTestId(`ack-${ID}`);
    expect(screen.getByTestId('partial-note')).toBeTruthy();
    fireEvent.click(screen.getByTestId('load-more'));
    expect(await screen.findByTestId(`ack-${third}`)).toBeTruthy();
    expect(screen.getByTestId(`ack-${ID}`)).toBeTruthy();
    expect(h.read).toHaveBeenCalledWith('listWhistleReports', expect.objectContaining({ query: expect.objectContaining({ offset: 2 }) }));
    expect(screen.queryByTestId('load-more')).toBeNull();
  });
});
