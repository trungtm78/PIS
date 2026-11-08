import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../i18n';
import ContainerScreen from './doc/ContainerScreen';
import { AS_OF, harness, mount, never, problem, routeOf, sha, uuid, word, rx } from './test/docaud';

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
  vi.restoreAllMocks();
});

const ALL = ['doc.transmittal.read', 'doc.transmittal.manage', 'doc.transmittal.send', 'doc.transmittal.answer'];
const READER = ['doc.transmittal.read'];
const route = routeOf('DOC-28', 'DOC', 'FR-DOC-28');

const container = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(n),
  project_id: uuid(900),
  document_id: uuid(800 + n),
  document_kind: 'DOCUMENT',
  revision_label: 'A',
  title: `Design report ${n}`,
  content_sha256: sha('c'),
  state: 'WIP',
  author_id: uuid(701),
  state_changed_at: '2027-03-09T01:00:00.000Z',
  version: 3,
  ...over,
});
const head = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(500 + n),
  project_id: uuid(900),
  number: `TR-000${n}`,
  purpose: 'FOR_REVIEW',
  subject: `Transmittal subject ${n}`,
  message: null,
  sent_on: '2027-03-02',
  sent_by: uuid(701),
  review_days: 5,
  rule_version: 0,
  supersedes_id: null,
  superseded_by_id: null,
  version: 1,
  progress: { required: 2, answered: 1, rejected: 0, overdue: 1, all_required_answered: false },
  ...over,
});

function world(containers: unknown[], over: Record<string, unknown> = {}) {
  return (op: string): unknown => {
    if (op === 'listDocContainers') return { as_of: AS_OF, items: containers, has_more: false };
    if (op === 'listDocTransmittals') return { as_of: AS_OF, items: [head(1)], has_more: false, ...over };
    if (op === 'getDocTransmittalInbox') return { as_of: AS_OF, items: [{ ...head(2), my_due_on: '2027-03-12', my_review: { state: 'DUE_SOON', days_left: 2 } }] };
    return {};
  };
}

function open(answer: (op: string, input: unknown) => unknown, command?: (op: string, input: unknown) => unknown, permissions: readonly string[] = ALL) {
  const h = harness(answer, command);
  mount(<ContainerScreen route={route} />, h, permissions);
  return h;
}

describe('DOC-28, the documents of the project by state and their transmittals', () => {
  it('UI-DOC-28: lists the documents with state, revision and hash, counts them by state, and shows the progress of each transmittal', async () => {
    open(world([container(1), container(2, { state: 'SHARED' }), container(3, { state: 'PUBLISHED' })]));
    expect(await screen.findByText('Design report 1')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('gov12da.doc28.page.title'));
    expect(screen.getByTestId('count-WIP').textContent).toBe('1');
    expect(screen.getByTestId('count-PUBLISHED').textContent).toBe('1');
    expect(screen.getByTestId('count-overdue').textContent).toBe('1');
    expect(screen.getByTestId('progress-TR-0001').textContent).toContain('1 trên 2');
    // Every figure has its "i".
    expect(screen.getAllByRole('button', { name: /Công thức và nguồn của/ }).length).toBeGreaterThanOrEqual(5);
    expect(screen.getByTestId('inbox')).toBeTruthy();
  });

  it('says that a default number is not confirmed in the "i" of a figure', async () => {
    open(world([container(1)]));
    await screen.findByText('Design report 1');
    fireEvent.click(screen.getByTestId('progress-TR-0001').querySelector('button') as HTMLElement);
    const panel = await screen.findByRole('dialog', { name: word('gov12da.doc28.tcol.progress') });
    expect(within(panel).getByText(word('gov12da.info.label.unverified'))).toBeTruthy();
    expect(within(panel).getByText(word('gov12da.info.version.default'))).toBeTruthy();
  });

  it('shows a reader the documents and no action to register, move or send', async () => {
    open(world([container(1)]), undefined, READER);
    await screen.findByText('Design report 1');
    expect(screen.queryByTestId('register-open')).toBeNull();
    expect(screen.queryByTestId('send-open')).toBeNull();
    expect(screen.queryByTestId(`move-${uuid(1)}`)).toBeNull();
    expect(screen.queryByTestId('inbox')).toBeNull();
  });

  it('refuses ids that are not ids when registering, then registers the document by its id', async () => {
    const h = open(world([container(1)]), () => ({ operation_id: 'x', status: 'REGISTERED', resource_version: 1, resource_id: uuid(10) }));
    fireEvent.click(await screen.findByTestId('register-open'));
    fireEvent.change(await screen.findByTestId('register-project'), { target: { value: 'not-an-id' } });
    fireEvent.click(screen.getByRole('button', { name: word('gov12da.doc28.register.confirm') }));
    expect((await screen.findByRole('alert')).textContent).toBe(word('gov12da.error.validation.text'));
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('register-project'), { target: { value: uuid(900) } });
    fireEvent.change(screen.getByTestId('register-document'), { target: { value: uuid(801) } });
    fireEvent.click(screen.getByRole('button', { name: word('gov12da.doc28.register.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('registerDocContainer', expect.objectContaining({ body: { project_id: uuid(900), document_id: uuid(801), document_kind: 'DOCUMENT', revision_label: 'A' } })));
  });

  it('moves a container at the version it saw, asks a reason for the archive, and says in words that publishing needs the answers', async () => {
    let calls = 0;
    const h = open(world([container(1, { state: 'SHARED', version: 4 })]), () => {
      calls += 1;
      return calls === 1 ? problem('TRANSMITTAL_NOT_APPROVED', 422) : { operation_id: 'x', status: 'ARCHIVE', resource_version: 5, resource_id: uuid(1) };
    });
    fireEvent.click(await screen.findByTestId(`move-${uuid(1)}`));
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByLabelText(word('gov12da.doc28.move.to')) as HTMLSelectElement).value).toBe('PUBLISHED');
    fireEvent.click(within(dialog).getByRole('button', { name: word('gov12da.doc28.move.confirm') }));
    expect((await screen.findByRole('alert')).textContent).toBe(word('gov12da.error.transmittalNotApproved.text'));
    expect(h.command).toHaveBeenLastCalledWith('moveDocContainer', expect.objectContaining({ path: { id: uuid(1) }, ifMatchVersion: 4, body: { to: 'PUBLISHED' } }));
    fireEvent.change(within(dialog).getByLabelText(word('gov12da.doc28.move.to')), { target: { value: 'ARCHIVE' } });
    const confirm = within(dialog).getByRole('button', { name: word('gov12da.doc28.move.confirm') }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(rx(word('gov12da.common.reason.label'))), { target: { value: 'Superseded by revision B' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(h.command).toHaveBeenLastCalledWith('moveDocContainer', expect.objectContaining({ body: { to: 'ARCHIVE', reason: 'Superseded by revision B' } })));
  });

  it('sends a transmittal for the picked documents with the recipients and shows the receipt', async () => {
    const h = open(world([container(1), container(2)]), (op) => (op === 'sendDocTransmittal' ? { operation_id: 'x', status: 'SENT', resource_version: 1, resource_id: uuid(555) } : {}));
    expect((await screen.findByTestId('send-open') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(await screen.findByTestId(`pick-${uuid(1)}`));
    fireEvent.click(screen.getByTestId(`pick-${uuid(2)}`));
    fireEvent.click(screen.getByTestId('send-open'));
    fireEvent.change(await screen.findByTestId('send-number'), { target: { value: 'TR-0042' } });
    fireEvent.change(screen.getByTestId('send-subject'), { target: { value: 'Design reports for review' } });
    fireEvent.change(screen.getByTestId('send-recipient-0'), { target: { value: uuid(33) } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: word('gov12da.doc28.send.confirm') }));
    expect((await screen.findByTestId('send-receipt')).textContent).toContain(word('gov12da.doc28.receipt.text'));
    expect(h.command).toHaveBeenCalledWith('sendDocTransmittal', expect.objectContaining({ body: { project_id: uuid(900), number: 'TR-0042', purpose: 'FOR_REVIEW', subject: 'Design reports for review', container_ids: [uuid(1), uuid(2)], recipients: [{ membership_id: uuid(33), required: true }] } }));
  });

  it('refuses a review with nobody who must answer before anything is sent', async () => {
    const h = open(world([container(1)]));
    fireEvent.click(await screen.findByTestId(`pick-${uuid(1)}`));
    fireEvent.click(screen.getByTestId('send-open'));
    fireEvent.change(await screen.findByTestId('send-number'), { target: { value: 'TR-0043' } });
    fireEvent.change(screen.getByTestId('send-subject'), { target: { value: 'Design report' } });
    fireEvent.change(screen.getByTestId('send-recipient-0'), { target: { value: uuid(33) } });
    fireEvent.click(screen.getByTestId('send-required-0'));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: word('gov12da.doc28.send.confirm') }));
    expect((await screen.findByRole('alert')).textContent).toBe(word('gov12da.doc28.send.noRequired'));
    expect(h.command).not.toHaveBeenCalled();
  });

  it('shows the loading, empty, error and denied states', async () => {
    const loading = open(() => never());
    expect(await screen.findByRole('status', { name: word('states.loading.label') })).toBeTruthy();
    expect(loading.read).toHaveBeenCalled();
    cleanup();
    open(world([]));
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    cleanup();
    open(() => problem('INTERNAL_ERROR', 500));
    expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
    cleanup();
    open(() => problem('SCOPE_DENIED', 403));
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
  });

  it('asks the server again with the project filter that was typed', async () => {
    let fail = false;
    const h = open((op) => {
      if (fail && op === 'listDocContainers') return problem('INTERNAL_ERROR', 500);
      return world([container(1)])(op);
    });
    await screen.findByText('Design report 1');
    fail = true;
    fireEvent.change(screen.getByTestId('filter-project'), { target: { value: uuid(901) } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listDocContainers', expect.objectContaining({ query: expect.objectContaining({ project_id: uuid(901) }) })));
  });
});

describe('DOC-28, lists that have more pages', () => {
  const offsetOf = (input: unknown): number => (input as { query: { offset: number } }).query.offset;

  it('loads the next page with the offset of what is loaded, appends it, and labels the counts as partial only while there is more', async () => {
    const h = open((op, input) => {
      if (op === 'listDocContainers') return offsetOf(input) === 0 ? { as_of: AS_OF, items: [container(1), container(2)], has_more: true } : { as_of: AS_OF, items: [container(3)], has_more: false };
      return world([])(op);
    });
    await screen.findByText('Design report 1');
    expect(screen.getByTestId('partial-note').textContent).toBe(word('gov12da.common.partial.note').replace('{count}', '2'));
    expect(screen.getByText(`${word('gov12da.doc.state.wip')} ${word('gov12da.common.partial.suffix')}`)).toBeTruthy();
    expect(screen.getByTestId('count-WIP').textContent).toBe('2');
    fireEvent.click(screen.getByTestId('load-more'));
    expect(await screen.findByText('Design report 3')).toBeTruthy();
    expect(screen.getByText('Design report 1')).toBeTruthy();
    expect(h.read).toHaveBeenCalledWith('listDocContainers', expect.objectContaining({ query: expect.objectContaining({ offset: 2 }) }));
    expect(screen.queryByTestId('load-more')).toBeNull();
    expect(screen.getByTestId('count-WIP').textContent).toBe('3');
    expect(screen.queryByText(`${word('gov12da.doc.state.wip')} ${word('gov12da.common.partial.suffix')}`)).toBeNull();
  });

  it('pages the transmittals too, and the overdue figure is partial until the last page', async () => {
    const h = open((op, input) => {
      if (op === 'listDocTransmittals') return offsetOf(input) === 0 ? { as_of: AS_OF, items: [head(1)], has_more: true } : { as_of: AS_OF, items: [head(3)], has_more: false };
      return world([container(1)])(op);
    });
    await screen.findByTestId('open-TR-0001');
    expect(screen.getByText(`${word('gov12da.doc28.figure.overdue')} ${word('gov12da.common.partial.suffix')}`)).toBeTruthy();
    fireEvent.click(screen.getByTestId('load-more'));
    expect(await screen.findByTestId('open-TR-0003')).toBeTruthy();
    expect(h.read).toHaveBeenCalledWith('listDocTransmittals', expect.objectContaining({ query: expect.objectContaining({ offset: 1 }) }));
    expect(screen.getByTestId('count-overdue').textContent).toBe('2');
    expect(screen.queryByText(`${word('gov12da.doc28.figure.overdue')} ${word('gov12da.common.partial.suffix')}`)).toBeNull();
  });

  it('says in words when the next page cannot be loaded and keeps the pages already shown', async () => {
    open((op, input) => {
      if (op === 'listDocContainers') return offsetOf(input) === 0 ? { as_of: AS_OF, items: [container(1)], has_more: true } : problem('INTERNAL_ERROR', 500);
      return world([])(op);
    });
    fireEvent.click(await screen.findByTestId('load-more'));
    expect(await screen.findByText(word('gov12da.common.more.error'))).toBeTruthy();
    expect(screen.getByText('Design report 1')).toBeTruthy();
    expect(screen.getByTestId('load-more')).toBeTruthy();
  });
});
