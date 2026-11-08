import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../i18n';
import TransmittalScreen from './doc/TransmittalScreen';
import { AS_OF, ME, fill, harness, mount, never, problem, routeOf, sha, uuid, word, rx } from './test/docaud';

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
  vi.restoreAllMocks();
});

const ALL = ['doc.transmittal.read', 'doc.transmittal.send', 'doc.transmittal.answer'];
const route = routeOf('DOC-29', 'DOC', 'FR-DOC-29');
const ID = uuid(501);

const recipient = (n: number, who: string, over: Record<string, unknown> = {}) => ({
  id: uuid(600 + n),
  recipient_id: who,
  required: true,
  due_on: '2027-03-07',
  extended_due_on: null,
  extension_reason: null,
  answer: null,
  answer_comment: null,
  answered_on: null,
  review: { state: 'OVERDUE', due_on: '2027-03-07', days_left: -3, days_late: null },
  ...over,
});

const detail = (over: Record<string, unknown> = {}) => ({
  as_of: AS_OF,
  id: ID,
  project_id: uuid(900),
  number: 'TR-0001',
  purpose: 'FOR_REVIEW',
  subject: 'Design report for review',
  message: 'Please look at chapter 4',
  sent_on: '2027-03-02',
  sent_by: ME,
  review_days: 5,
  rule_version: 0,
  supersedes_id: null,
  superseded_by_id: null,
  version: 1,
  items: [{ id: uuid(701), container_id: uuid(1), document_id: uuid(801), revision_label: 'A', title: 'Design report', content_sha256: sha('c') }],
  recipients: [recipient(1, ME), recipient(2, uuid(33), { answer: 'REJECTED', answer_comment: 'The table of page 4 is wrong', answered_on: '2027-03-05', review: { state: 'ANSWERED_ON_TIME', due_on: '2027-03-07', days_left: null, days_late: -2 } })],
  progress: { recipients: 2, required: 2, answered: 1, approved: 0, rejected: 1, overdue: 1, all_required_answered: false },
  ...over,
});

function open(current: Record<string, unknown>, command?: (op: string, input: unknown) => unknown, permissions: readonly string[] = ALL, path = `/?transmittal=${ID}`) {
  const h = harness((op) => {
    if (op === 'getDocTransmittal') return current;
    if (op === 'listDocTransmittals') return { as_of: AS_OF, items: [{ id: ID, number: 'TR-0001', subject: 'Design report for review', sent_on: '2027-03-02' }], has_more: false };
    return {};
  }, command);
  mount(<TransmittalScreen route={route} />, h, permissions, path);
  return h;
}

describe('DOC-29, one transmittal', () => {
  it('UI-DOC-29: shows what was sent with the whole hash, the recipients with their days and answers, and the figures with their "i"', async () => {
    open(detail());
    expect((await screen.findByTestId('fact-number')).textContent).toBe('TR-0001');
    expect(screen.getByTestId(`hash-${uuid(701)}`).textContent).toBe(sha('c'));
    expect(screen.getByTestId('fact-days').textContent).toContain(fill('gov12da.doc29.days.text', { days: 5 }));
    expect(screen.getByTestId('figure-answered').textContent).toBe(fill('gov12da.doc28.progress.text', { answered: 1, required: 2 }));
    expect(screen.getByTestId('figure-rejected').textContent).toBe('1');
    expect(screen.getByText('The table of page 4 is wrong')).toBeTruthy();
    expect(screen.getAllByText(word('gov12da.doc.review.overdue')).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /Công thức và nguồn của/ }).length).toBeGreaterThanOrEqual(4);
  });

  it('lets the recipient answer once, asks a comment for a rejection, and says in words when the answer was already given', async () => {
    let calls = 0;
    const h = open(detail(), () => {
      calls += 1;
      return calls === 1 ? problem('TRANSMITTAL_STATE_INVALID', 409) : { operation_id: 'x', status: 'ANSWERED', resource_version: 1, resource_id: ID };
    });
    fireEvent.click(await screen.findByTestId('answer-open'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(word('gov12da.doc29.answer.choice')), { target: { value: 'REJECTED' } });
    const confirm = within(dialog).getByRole('button', { name: word('gov12da.doc29.answer.confirm') }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(rx(word('gov12da.doc29.answer.comment'))), { target: { value: 'The estimate is missing' } });
    fireEvent.click(confirm);
    expect((await screen.findByRole('alert')).textContent).toBe(word('gov12da.error.transmittalState.text'));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: word('gov12da.doc29.answer.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
    expect(h.command).toHaveBeenLastCalledWith('answerDocTransmittal', expect.objectContaining({ path: { id: ID }, body: { answer: 'REJECTED', comment: 'The estimate is missing' } }));
  });

  it('offers no answer to a person who is not a recipient, who has answered, or when the transmittal was replaced', async () => {
    open(detail({ recipients: [recipient(2, uuid(33))] }));
    await screen.findByTestId('fact-number');
    expect(screen.queryByTestId('answer-open')).toBeNull();
    cleanup();
    open(detail({ recipients: [recipient(1, ME, { answer: 'APPROVED', answered_on: '2027-03-05' })] }));
    await screen.findByTestId('fact-number');
    expect(screen.queryByTestId('answer-open')).toBeNull();
    cleanup();
    open(detail({ superseded_by_id: uuid(502) }));
    expect((await screen.findByTestId('superseded')).textContent).toContain(word('gov12da.doc29.fact.replaced'));
    expect(screen.queryByTestId('answer-open')).toBeNull();
    expect(screen.queryByTestId(`extend-${uuid(601)}`)).toBeNull();
  });

  it('lets the sender move a day once, with a reason, and not again', async () => {
    const h = open(detail(), () => ({ operation_id: 'x', status: 'EXTENDED', resource_version: 1, resource_id: ID }));
    fireEvent.click(await screen.findByTestId(`extend-${uuid(601)}`));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByTestId('extend-day'), { target: { value: '2027-03-12' } });
    fireEvent.change(within(dialog).getByLabelText(rx(word('gov12da.common.reason.label'))), { target: { value: 'A site visit is needed' } });
    fireEvent.click(within(dialog).getByRole('button', { name: word('gov12da.doc29.extend.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('extendDocTransmittal', expect.objectContaining({ path: { id: ID }, body: { recipient_id: uuid(601), due_on: '2027-03-12', reason: 'A site visit is needed' } })));
    cleanup();
    open(detail({ recipients: [recipient(1, ME, { extended_due_on: '2027-03-12', extension_reason: 'A site visit is needed' })] }));
    expect((await screen.findByTestId(`due-${uuid(601)}`)).textContent).toContain('12/03/2027');
    expect(screen.queryByTestId(`extend-${uuid(601)}`)).toBeNull();
  });

  it('shows a reader the transmittal without answer or extension, and the list when no transmittal is named', async () => {
    open(detail({ sent_by: uuid(44) }), undefined, ['doc.transmittal.read']);
    await screen.findByTestId('fact-number');
    expect(screen.queryByTestId('answer-open')).toBeNull();
    expect(screen.queryByTestId(`extend-${uuid(601)}`)).toBeNull();
    cleanup();
    open(detail(), undefined, ALL, '/');
    fireEvent.click(await screen.findByTestId('open-TR-0001'));
    await waitFor(() => expect(screen.queryByTestId('open-TR-0001')).toBeNull());
  });

  it('shows the loading, error, denied and not found states', async () => {
    const h = harness(() => never());
    mount(<TransmittalScreen route={route} />, h, ALL, `/?transmittal=${ID}`);
    expect(await screen.findByRole('status', { name: word('states.loading.label') })).toBeTruthy();
    cleanup();
    open(detail());
    cleanup();
    const failing = (error: Error) => {
      const harnessed = harness(() => error);
      mount(<TransmittalScreen route={route} />, harnessed, ALL, `/?transmittal=${ID}`);
    };
    failing(problem('INTERNAL_ERROR', 500));
    expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
    cleanup();
    failing(problem('SCOPE_DENIED', 403));
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
    cleanup();
    failing(problem('RESOURCE_NOT_FOUND', 404));
    expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
  });
});
