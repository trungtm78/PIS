import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { vi } from 'vitest';
import { ApiClientProvider } from '../../../api/ApiClientContext';
import vi_ from '../../../i18n/vi.json';
import { ALL_MODULES_VISIBLE } from '../../../navigation/model';
import { SessionContext } from '../../../session/SessionContext';
import type { SessionValue } from '../../../session/SessionContext';
import { TENANT, client, mount, routeOf, world } from '../test-support';
import type { Harness } from '../test-support';
import ExplanationScreen from './ExplanationScreen';
import { canAnswer, canConclude, describeExplanation, endOfDay, isPastDue, requestBody, reviewBody, toExplanationPage, validateAnswer, validateRequest, validateReview, vietnamToday } from './model';

const ROUTE = routeOf('PRJ-19', 'FR-PRJ-19');
const ME = '00000000-0000-4000-8000-000000000001'; // the member of the session of the test support
const OTHER = '00000000-0000-4000-8000-0000000000c2';
const PROJECT = '00000000-0000-4000-8000-001000000001'; // the first project of the test support
const ASKER = ['explanation.read', 'explanation.request', 'membership.read'];
const ASKER_WITHOUT_MEMBERS = ['explanation.read', 'explanation.request'];
const RESPONDER = ['explanation.read', 'explanation.respond'];
const REVIEWER = ['explanation.read', 'explanation.review'];
const READER = ['explanation.read'];
const FUTURE = '2099-01-01T16:59:59.999Z';
const PAST = '2026-01-01T16:59:59.999Z';
const ANSWER = 'The contractor lost the site records in the flood; they were rebuilt and sent.';
const OK = { operation_id: 'o', status: 'RESPONDED', resource_version: 3, resource_id: 'x' };

const request = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-0000000000e${n}`,
  subject_kind: 'PROJECT',
  project: { id: PROJECT, code: 'DA-2026-001', name: 'Dự án số 1' },
  unit: null,
  period_id: null,
  warning_id: null,
  trigger_code: 'MANUAL',
  question: 'Explain why the weekly report of the project is still missing',
  requested_from_membership_id: ME,
  due_at: FUTURE,
  original_due_at: FUTURE,
  response_text: null,
  response_document_id: null,
  responded_by: null,
  responded_at: null,
  is_late: false,
  reviewed_by: null,
  review_note: null,
  status: 'REQUESTED',
  created_at: '2026-10-24T01:00:00.000Z',
  created_by: OTHER,
  version: 1,
  ...overrides,
});

const MEMBERS = [
  { id: ME, display_name: 'Nguyễn Văn An', status: 'Active', membership_type: 'STAFF' },
  { id: OTHER, display_name: 'Trần Thị Bình', status: 'Active', membership_type: 'STAFF' },
];

afterEach(cleanup);

interface Served {
  pages: Array<Record<string, unknown>>;
  failing?: Error;
}

/** The screen over a client that serves the list of the requests, the projects, the units and the staff. */
function open(served: Served, command: (operation: string, input: unknown) => unknown = () => OK): Harness {
  const h = client(world(), command);
  const previous = h.read.getMockImplementation();
  let call = 0;
  h.read.mockImplementation((operation: string, input?: unknown) => {
    if (operation === 'listExplanationRequests') {
      if (served.failing !== undefined) return Promise.reject(served.failing);
      const page = served.pages[Math.min(call, served.pages.length - 1)];
      call += 1;
      return Promise.resolve(page);
    }
    return previous === undefined ? Promise.reject(new Error(`unexpected read ${operation}`)) : previous(operation, input);
  });
  const readAll = (h.client as unknown as { readAll: ReturnType<typeof vi.fn> }).readAll;
  const base = readAll.getMockImplementation();
  readAll.mockImplementation((operation: string, input?: unknown) =>
    operation === 'get_resources_membership' ? Promise.resolve(MEMBERS) : (base?.(operation, input) ?? Promise.reject(new Error(`unexpected ${operation}`))),
  );
  return h;
}

const page = (items: unknown[], next: string | null = null) => ({ items, next_cursor: next, as_of: '2026-10-27T00:00:00.000Z' });
const show = (h: Harness, permissions: readonly string[], mode?: 'FULL' | 'READ_ONLY') =>
  mount(<ExplanationScreen route={ROUTE} />, h, { permissions, ...(mode === undefined ? {} : { mode }), path: '/prj/prj-19' });
const asked = (h: Harness) => h.read.mock.calls.filter(([operation]) => operation === 'listExplanationRequests').map(([, input]) => (input as { query: Record<string, unknown> }).query);
const buttonOf = (name: string) => screen.findByRole('button', { name });

describe('ExplanationScreen (PRJ-19): the requests for an explanation and their answers', () => {
  it('UI-PRJ-19: lists the subject, the basis, the question, the due date and the state in words, tells a request past its due date overdue with the date it was first asked for, and an answer that came late', async () => {
    const h = open({
      pages: [
        page([
          request(1),
          request(2, { due_at: PAST, original_due_at: PAST, status: 'OVERDUE' }),
          request(3, {
            warning_id: '00000000-0000-4000-8000-0000000000f1',
            trigger_code: 'EW-02',
            status: 'RESPONDED',
            is_late: true,
            response_text: ANSWER,
            responded_by: ME,
            due_at: '2099-02-01T16:59:59.999Z',
            original_due_at: FUTURE,
          }),
        ]),
      ],
    });
    show(h, READER);
    const table = await screen.findByTestId('explanations');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['prj.explanation.page.title']);
    for (const key of ['prj.explanation.col.subject', 'prj.explanation.col.basis', 'prj.explanation.col.question', 'prj.explanation.col.due', 'prj.explanation.col.status'] as const) {
      expect(within(table).getByRole('columnheader', { name: vi_[key] })).toBeTruthy();
    }
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain('DA-2026-001 Dự án số 1');
    expect(rows[0]?.textContent).toContain(vi_['prj.explanation.basis.manual']);
    expect(rows[0]?.querySelector('[data-overdue]')?.getAttribute('data-overdue')).toBe('false');
    expect(rows[1]?.querySelector('[data-overdue]')?.getAttribute('data-overdue')).toBe('true');
    expect(rows[1]?.textContent).toContain(vi_['prj.explanation.due.overdue']);
    expect(rows[1]?.textContent).toContain(vi_['prj.explanation.status.overdue']);
    expect(rows[2]?.textContent).toContain(vi_['prj.explanation.basis.warning'].replace('{rule}', 'EW-02'));
    expect(rows[2]?.textContent).toContain(vi_['prj.explanation.late.label']);
    expect(rows[2]?.textContent).toContain(vi_['prj.explanation.due.original'].replace('{date}', '2099-01-01'));
    // A reader only reads: nothing here asks, answers or concludes.
    expect(screen.queryByRole('button', { name: vi_['prj.explanation.request.open.action'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['prj.explanation.answer.action'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['prj.explanation.review.action'] })).toBeNull();
  });

  it('keys what it has read by the member as well as the tenant: the list depends on who asks', async () => {
    const h = open({ pages: [page([request(1)])] });
    const view = show(h, READER);
    await screen.findByTestId('explanations');
    const keys = view.queries
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey);
    expect(keys.some((key) => key.includes(ME) && key.includes('explanations'))).toBe(true);
  });

  it('closes what was opened for one member when the member of the session changes: no record, dialog or command is kept for the other', async () => {
    const h = open({ pages: [page([request(1)])] });
    const queries = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const session = (membershipId: string): SessionValue => ({
      tenant: { ...TENANT, membershipId },
      tenants: [{ ...TENANT, membershipId }],
      user: { displayName: 'Admin', initials: 'AD' },
      access: ALL_MODULES_VISIBLE,
      switchTenant: () => undefined,
      getSession: () => Promise.resolve({ token: 'token' }),
      permissions: RESPONDER,
    });
    const tree = (membershipId: string) => (
      <SessionContext.Provider value={session(membershipId)}>
        <QueryClientProvider client={queries}>
          <ApiClientProvider client={h.client}>
            <MemoryRouter initialEntries={['/prj/prj-19']}>
              <ExplanationScreen route={ROUTE} />
            </MemoryRouter>
          </ApiClientProvider>
        </QueryClientProvider>
      </SessionContext.Provider>
    );
    const view = render(tree(ME));
    fireEvent.click(await buttonOf(vi_['prj.explanation.answer.action']));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    view.rerender(tree(OTHER));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await screen.findByTestId('explanations');
    expect(screen.queryByRole('button', { name: vi_['prj.explanation.answer.action'] })).toBeNull();
  });

  it('shows the question beside the answer and the conclusion under them', async () => {
    const h = open({
      pages: [page([request(1, { status: 'ACCEPTED', response_text: ANSWER, responded_by: ME, responded_at: '2026-10-25T03:00:00.000Z', reviewed_by: OTHER, review_note: 'Checked against the site records' })])],
    });
    show(h, READER);
    fireEvent.click(await buttonOf(vi_['prj.explanation.view.action']));
    const detail = await screen.findByTestId('explanation-detail');
    expect(within(detail).getByTestId('detail-question').textContent).toBe(request(1).question);
    expect(within(detail).getByTestId('detail-response').textContent).toBe(ANSWER);
    expect(within(detail).getByTestId('detail-conclusion').textContent).toContain('Checked against the site records');
    expect(within(detail).getByRole('heading', { name: vi_['prj.explanation.detail.response.title'] })).toBeTruthy();
    fireEvent.click(within(detail).getByRole('button', { name: vi_['prj.explanation.detail.close.action'] }));
    expect(screen.queryByTestId('explanation-detail')).toBeNull();
  });

  describe('answering (AC-ST-PRJ-006-1)', () => {
    it('AC-ST-PRJ-006-1: the person asked answers under the version they saw, an answer that is too short is refused before anything is sent, and the list is read again', async () => {
      const h = open({ pages: [page([request(1, { status: 'OVERDUE', version: 2 })]), page([request(1, { status: 'RESPONDED', version: 3, response_text: ANSWER, responded_by: ME, is_late: true })])] });
      show(h, RESPONDER);
      fireEvent.click(await buttonOf(vi_['prj.explanation.answer.action']));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByTestId('answer-question').textContent).toBe(request(1).question);
      fireEvent.change(within(dialog).getByLabelText(vi_['prj.explanation.answer.text.label']), { target: { value: 'too short' } });
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['prj.explanation.answer.submit.action'] }));
      expect(await within(dialog).findByText(vi_['prj.explanation.field.invalid.error'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      fireEvent.change(within(dialog).getByLabelText(vi_['prj.explanation.answer.text.label']), { target: { value: ANSWER } });
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['prj.explanation.answer.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('submitExplanation');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: request(1).id }, body: { response_text: ANSWER }, ifMatchVersion: 2 });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await waitFor(() => expect(asked(h).length).toBeGreaterThan(1));
      expect((await screen.findByTestId('explanations')).querySelector('[data-status="RESPONDED"]')).toBeTruthy();
    });

    it('offers the answer only to the person asked and only while it waits, and says in words why a refusal came', async () => {
      const h = open(
        { pages: [page([request(1), request(2, { requested_from_membership_id: OTHER }), request(3, { status: 'ACCEPTED' })])] },
        () => new ApiError({ status: 422, code: 'EXPLANATION_ALREADY_SUBMITTED', correlationId: 'c' }),
      );
      show(h, RESPONDER);
      const buttons = await screen.findAllByRole('button', { name: vi_['prj.explanation.answer.action'] });
      expect(buttons).toHaveLength(1);
      fireEvent.click(buttons[0] as HTMLElement);
      const dialog = await screen.findByRole('dialog');
      fireEvent.change(within(dialog).getByLabelText(vi_['prj.explanation.answer.text.label']), { target: { value: ANSWER } });
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['prj.explanation.answer.submit.action'] }));
      expect((await within(dialog).findByTestId('answer-refusal')).textContent).toBe(vi_['prj.explanation.problem.alreadySubmitted']);
    });
  });

  describe('concluding', () => {
    it('accepts an answer, or returns it with a note and a new date; the note is needed and the new date lies after today', async () => {
      const h = open({ pages: [page([request(1, { status: 'RESPONDED', response_text: ANSWER, responded_by: OTHER, version: 3 })])] }, () => ({ ...OK, status: 'RETURNED' }));
      show(h, REVIEWER);
      fireEvent.click(await buttonOf(vi_['prj.explanation.review.action']));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByTestId('review-response').textContent).toBe(ANSWER);
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['prj.explanation.review.submit.action'] }));
      expect(await within(dialog).findByText(vi_['prj.explanation.field.required.error'])).toBeTruthy();
      fireEvent.click(within(dialog).getByRole('radio', { name: vi_['prj.explanation.review.decision.returned'] }));
      fireEvent.change(within(dialog).getByLabelText(vi_['prj.explanation.review.note.label']), { target: { value: 'Attach the site records' } });
      fireEvent.change(within(dialog).getByLabelText(vi_['prj.explanation.review.newDue.label']), { target: { value: vietnamToday() } });
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['prj.explanation.review.submit.action'] }));
      expect(await within(dialog).findByText(vi_['prj.explanation.field.past.error'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      fireEvent.change(within(dialog).getByLabelText(vi_['prj.explanation.review.newDue.label']), { target: { value: '2099-03-05' } });
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['prj.explanation.review.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('reviewExplanation');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({
        path: { id: request(1).id },
        ifMatchVersion: 3,
        body: { decision: 'RETURNED', review_note: 'Attach the site records', new_due_at: endOfDay('2099-03-05') },
      });
    });

    it('does not offer the conclusion to the person who answered, and tells the refusal of the server in words', async () => {
      const mine = request(1, { status: 'RESPONDED', response_text: ANSWER, responded_by: ME });
      const theirs = request(2, { status: 'RESPONDED', response_text: ANSWER, responded_by: OTHER });
      const h = open({ pages: [page([mine, theirs])] }, () => new ApiError({ status: 403, code: 'SELF_APPROVAL_DENIED', correlationId: 'c' }));
      show(h, REVIEWER);
      const buttons = await screen.findAllByRole('button', { name: vi_['prj.explanation.review.action'] });
      expect(buttons).toHaveLength(1);
      fireEvent.click(buttons[0] as HTMLElement);
      const dialog = await screen.findByRole('dialog');
      fireEvent.change(within(dialog).getByLabelText(vi_['prj.explanation.review.note.label']), { target: { value: 'Accepted by the committee' } });
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['prj.explanation.review.submit.action'] }));
      expect((await within(dialog).findByTestId('review-refusal')).textContent).toBe(vi_['prj.explanation.problem.selfApproval']);
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { decision: 'ACCEPTED' }, ifMatchVersion: 1 });
    });
  });

  describe('asking', () => {
    it('asks for an explanation of a project from a person of the staff by a day after today, and refuses what is missing before it sends', async () => {
      const h = open({ pages: [page([])] }, () => ({ ...OK, status: 'REQUESTED' }));
      show(h, ASKER);
      fireEvent.click(await buttonOf(vi_['prj.explanation.request.open.action']));
      const dialog = await screen.findByRole('dialog');
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['prj.explanation.request.submit.action'] }));
      expect((await within(dialog).findAllByText(vi_['prj.explanation.field.required.error'])).length).toBeGreaterThanOrEqual(4);
      expect(h.command).not.toHaveBeenCalled();
      await waitFor(() => expect(within(dialog).getByLabelText(vi_['prj.explanation.request.assignee.label']).querySelectorAll('option').length).toBe(3));
      fireEvent.change(within(dialog).getByLabelText(vi_['prj.explanation.request.project.label']), { target: { value: PROJECT } });
      fireEvent.change(within(dialog).getByLabelText(vi_['prj.explanation.request.question.label']), { target: { value: request(1).question } });
      fireEvent.change(within(dialog).getByLabelText(vi_['prj.explanation.request.assignee.label']), { target: { value: OTHER } });
      fireEvent.change(within(dialog).getByLabelText(vi_['prj.explanation.request.due.label']), { target: { value: vietnamToday() } });
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['prj.explanation.request.submit.action'] }));
      expect(await within(dialog).findByText(vi_['prj.explanation.field.past.error'])).toBeTruthy();
      fireEvent.change(within(dialog).getByLabelText(vi_['prj.explanation.request.due.label']), { target: { value: '2099-03-05' } });
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['prj.explanation.request.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('requestExplanation');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({
        body: { subject_kind: 'PROJECT', project_id: PROJECT, trigger_code: 'MANUAL', question: request(1).question, requested_from_membership_id: OTHER, due_at: endOfDay('2099-03-05') },
      });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('names the person asked by the identifier when the caller may not list the members, and says so when the list cannot be loaded', async () => {
      const h = open({ pages: [page([])] }, () => ({ ...OK, status: 'REQUESTED' }));
      show(h, ASKER_WITHOUT_MEMBERS);
      fireEvent.click(await buttonOf(vi_['prj.explanation.request.open.action']));
      const dialog = await screen.findByRole('dialog');
      const field = within(dialog).getByLabelText(vi_['prj.explanation.request.assignee.label']);
      expect(field.tagName).toBe('INPUT');
      expect(within(dialog).getByText(vi_['prj.explanation.request.assignee.idHint'])).toBeTruthy();
      await waitFor(() => expect(within(dialog).getByLabelText(vi_['prj.explanation.request.project.label']).querySelectorAll('option').length).toBeGreaterThan(1));
      fireEvent.change(within(dialog).getByLabelText(vi_['prj.explanation.request.project.label']), { target: { value: PROJECT } });
      fireEvent.change(within(dialog).getByLabelText(vi_['prj.explanation.request.question.label']), { target: { value: request(1).question } });
      fireEvent.change(within(dialog).getByLabelText(vi_['prj.explanation.request.due.label']), { target: { value: '2099-03-05' } });
      fireEvent.change(field, { target: { value: 'not an identifier' } });
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['prj.explanation.request.submit.action'] }));
      expect(await within(dialog).findByText(vi_['prj.explanation.field.invalid.error'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      fireEvent.change(field, { target: { value: OTHER } });
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['prj.explanation.request.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { requested_from_membership_id: OTHER } });
      cleanup();
      const failing = open({ pages: [page([])] });
      const readAll = (failing.client as unknown as { readAll: ReturnType<typeof vi.fn> }).readAll;
      const base = readAll.getMockImplementation();
      readAll.mockImplementation((operation: string, input?: unknown) => (operation === 'get_resources_membership' ? Promise.reject(new Error('members failed')) : base?.(operation, input)));
      show(failing, ASKER);
      fireEvent.click(await buttonOf(vi_['prj.explanation.request.open.action']));
      expect((await screen.findByTestId('members-failed')).textContent).toBe(vi_['prj.explanation.request.assignee.failed']);
    });

    it('asks about a unit as well, and tells a request that is already open in words', async () => {
      const h = open({ pages: [page([])] }, () => new ApiError({ status: 409, code: 'EXPLANATION_ALREADY_OPEN', correlationId: 'c' }));
      show(h, ASKER);
      fireEvent.click(await buttonOf(vi_['prj.explanation.request.open.action']));
      const dialog = await screen.findByRole('dialog');
      fireEvent.change(within(dialog).getByLabelText(vi_['prj.explanation.request.subject.label']), { target: { value: 'UNIT' } });
      await waitFor(() => expect(within(dialog).getByLabelText(vi_['prj.explanation.request.unit.label']).querySelectorAll('option').length).toBeGreaterThan(1));
      fireEvent.change(within(dialog).getByLabelText(vi_['prj.explanation.request.unit.label']), {
        target: { value: (within(dialog).getByLabelText(vi_['prj.explanation.request.unit.label']).querySelectorAll('option')[1] as HTMLOptionElement).value },
      });
      fireEvent.change(within(dialog).getByLabelText(vi_['prj.explanation.request.question.label']), { target: { value: request(1).question } });
      await waitFor(() => expect(within(dialog).getByLabelText(vi_['prj.explanation.request.assignee.label']).querySelectorAll('option').length).toBe(3));
      fireEvent.change(within(dialog).getByLabelText(vi_['prj.explanation.request.assignee.label']), { target: { value: ME } });
      fireEvent.change(within(dialog).getByLabelText(vi_['prj.explanation.request.due.label']), { target: { value: '2099-03-05' } });
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['prj.explanation.request.submit.action'] }));
      expect((await within(dialog).findByTestId('request-refusal')).textContent).toBe(vi_['prj.explanation.problem.alreadyOpen']);
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { subject_kind: 'UNIT', trigger_code: 'MANUAL' } });
      expect(Object.keys((h.command.mock.calls[0]?.[1] as { body: Record<string, unknown> }).body)).not.toContain('project_id');
    });
  });

  it('narrows the list by status and loads the next page by cursor', async () => {
    const h = open({ pages: [page([request(1)], 'next'), page([request(2)])] });
    show(h, READER);
    await screen.findByTestId('explanations');
    fireEvent.click(await buttonOf(vi_['prj.explanation.more.action']));
    await waitFor(() => expect(screen.getByTestId('explanations').querySelectorAll('tbody tr')).toHaveLength(2));
    expect(asked(h)).toEqual([{ limit: 25 }, { limit: 25, cursor: 'next' }]);
    fireEvent.change(screen.getByLabelText(vi_['prj.explanation.filter.status.label']), { target: { value: 'OVERDUE' } });
    await waitFor(() => expect(asked(h).at(-1)).toEqual({ limit: 25, status: 'OVERDUE' }));
  });

  it('is in each state of a screen: loading, empty, denied, signed out, offline and error', async () => {
    const empty = open({ pages: [page([])] });
    show(empty, READER);
    expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    for (const [error, title] of [
      [new ApiError({ status: 403, code: 'FORBIDDEN', correlationId: 'c' }), vi_['states.denied.title']],
      [new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), vi_['states.signedOut.title']],
      [new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      [new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), vi_['states.error.title']],
    ] as const) {
      cleanup();
      show(open({ pages: [page([])], failing: error }), READER);
      expect(await screen.findByText(title)).toBeTruthy();
    }
  });
});

describe('the explanation model', () => {
  it('reads a page and drops what is not whole, and names the refusals of the server', () => {
    expect(toExplanationPage(undefined)).toEqual({ items: [], nextCursor: undefined });
    const read = toExplanationPage({
      items: [request(1), { id: 'x' }, request(2, { status: 'NOPE' }), request(3, { subject_kind: 'UNIT', project: null, unit: { id: 'u', name: 'Sở Giao thông' } })],
      next_cursor: 'c',
    });
    expect(read.items.map((item) => [item.subject, item.subjectName])).toEqual([
      ['PROJECT', 'Dự án số 1'],
      ['UNIT', 'Sở Giao thông'],
    ]);
    expect(read.nextCursor).toBe('c');
    const codes = [
      'EXPLANATION_ALREADY_OPEN',
      'EXPLANATION_ALREADY_SUBMITTED',
      'SELF_APPROVAL_DENIED',
      'VERSION_CONFLICT',
      'STAGE_TRANSITION_DENIED',
      'SCOPE_DENIED',
      'WARNING_STATE_INVALID',
      'VALIDATION_FAILED',
      'RESOURCE_NOT_FOUND',
      'OTHER',
    ];
    expect(codes.map((code) => describeExplanation(new ApiError({ status: 409, code, correlationId: 'c' })))).toEqual([
      'alreadyOpen',
      'alreadySubmitted',
      'selfApproval',
      'versionConflict',
      'stageDenied',
      'scopeDenied',
      'warningState',
      'validation',
      'notFound',
      'general',
    ]);
    expect(describeExplanation(new Error('x'))).toBe('general');
  });

  it('decides what a person may do: answer while it waits and only if asked, conclude an answer that is not theirs, and tells overdue by the clock whatever the job has marked', () => {
    const now = new Date('2026-10-27T03:00:00Z');
    expect([
      canAnswer({ status: 'REQUESTED', requestedFrom: ME }, ME),
      canAnswer({ status: 'OVERDUE', requestedFrom: ME }, ME),
      canAnswer({ status: 'RETURNED', requestedFrom: ME }, ME),
      canAnswer({ status: 'RESPONDED', requestedFrom: ME }, ME),
      canAnswer({ status: 'REQUESTED', requestedFrom: OTHER }, ME),
    ]).toEqual([true, true, true, false, false]);
    expect([canConclude({ status: 'RESPONDED', respondedBy: OTHER }, ME), canConclude({ status: 'RESPONDED', respondedBy: ME }, ME), canConclude({ status: 'REQUESTED', respondedBy: null }, ME)]).toEqual([
      true,
      false,
      false,
    ]);
    expect([isPastDue({ status: 'REQUESTED', dueAt: PAST }, now), isPastDue({ status: 'RESPONDED', dueAt: PAST }, now), isPastDue({ status: 'REQUESTED', dueAt: FUTURE }, now)]).toEqual([true, false, false]);
  });

  it('judges the forms: what is missing, a question of ten characters, an answer of twenty, a day after today, and builds what the server reads', () => {
    expect(validateRequest({ subject: 'PROJECT', projectId: '', unitId: '', triggerCode: '', question: '', requestedFrom: '', dueDate: '' }, '2026-10-27')).toEqual({
      projectId: 'required',
      triggerCode: 'required',
      question: 'required',
      requestedFrom: 'required',
      dueDate: 'required',
    });
    expect(validateRequest({ subject: 'PROJECT', projectId: 'p', unitId: '', triggerCode: 'MANUAL', question: request(1).question, requestedFrom: 'a name', dueDate: '2099-01-01' }, '2026-10-27')).toEqual({
      requestedFrom: 'invalid',
    });
    expect(validateRequest({ subject: 'UNIT', projectId: '', unitId: '', triggerCode: 'x'.repeat(51), question: 'short', requestedFrom: ME, dueDate: '2026-10-27' }, '2026-10-27')).toEqual({
      unitId: 'required',
      triggerCode: 'invalid',
      question: 'invalid',
      dueDate: 'past',
    });
    expect(validateRequest({ subject: 'PROJECT', projectId: 'p', unitId: '', triggerCode: 'MANUAL', question: request(1).question, requestedFrom: ME, dueDate: '2026-02-30' }, '2026-10-27')).toEqual({
      dueDate: 'invalid',
    });
    expect(requestBody({ subject: 'UNIT', projectId: '', unitId: 'u', triggerCode: ' MANUAL ', question: ` ${request(1).question} `, requestedFrom: ME, dueDate: '2026-11-01' })).toEqual({
      subject_kind: 'UNIT',
      unit_id: 'u',
      trigger_code: 'MANUAL',
      question: request(1).question,
      requested_from_membership_id: ME,
      due_at: '2026-11-01T16:59:59.999Z',
    });
    expect([validateAnswer(''), validateAnswer('x'.repeat(19)), validateAnswer('x'.repeat(20)), validateAnswer('x'.repeat(2001))]).toEqual(['required', 'invalid', undefined, 'invalid']);
    expect(validateReview({ decision: 'ACCEPTED', note: '', newDueDate: '' }, '2026-10-27')).toEqual({ note: 'required' });
    expect(validateReview({ decision: 'RETURNED', note: 'Attach it', newDueDate: '2026-10-27' }, '2026-10-27')).toEqual({ newDueDate: 'past' });
    expect(validateReview({ decision: 'ACCEPTED', note: 'Fine', newDueDate: 'nonsense' }, '2026-10-27')).toEqual({ note: 'invalid' });
    expect(reviewBody({ decision: 'ACCEPTED', note: ' Fine, thank you ', newDueDate: '2099-01-01' })).toEqual({ decision: 'ACCEPTED', review_note: 'Fine, thank you' });
    expect(reviewBody({ decision: 'RETURNED', note: 'Attach it', newDueDate: '' })).toEqual({ decision: 'RETURNED', review_note: 'Attach it' });
    expect(vietnamToday(new Date('2026-10-27T18:00:00Z'))).toBe('2026-10-28');
  });
});
