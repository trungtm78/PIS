import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import ClarificationScreen from './ClarificationScreen';
import { SendPanel } from './SendPanel';
import type { Recipient } from './model';
import { CLERK, EVALUATOR, GUEST, READER, REPLY, client, clarificationId, guestView, mount, opened, packageId, proposalId, request, routeOf, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('BID-11', 'FR-BID-11');
const OK = { operation_id: '00000000-0000-4000-8000-000000000999', status: 'ANSWERED', resource_version: 2, resource_id: clarificationId(1) };
const problem = (code: string, status = 422, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });
const text = (key: string, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);
const QUESTION = 'Giải trình đơn giá của hạng mục 7 trong bảng khối lượng.';
const PAST = '2020-01-01T10:00:00.000Z';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

interface Options {
  permissions?: readonly string[];
  path?: string;
  mode?: 'FULL' | 'READ_ONLY';
  command?: (operation: string, input: unknown) => unknown;
}

function open(state: World, options: Options = {}) {
  const h = client(state, options.command ?? (() => OK));
  mount(<ClarificationScreen route={ROUTE} />, h, { permissions: options.permissions ?? CLERK, path: options.path ?? `/bid/bid-11?package=${packageId(1)}`, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

const card = (n: number): HTMLElement => document.querySelector(`[data-request="${clarificationId(n)}"]`) as HTMLElement;
const answerField = (n: number): HTMLInputElement => within(card(n)).getByLabelText(text('bid.clarifications.answer.label', { contractor: `Công ty nhà thầu ${n}` })) as HTMLInputElement;
const answerButton = (n: number, pending = false): HTMLElement => within(card(n)).getByRole('button', { name: pending ? vi_['bid.clarifications.answer.pending'] : vi_['bid.clarifications.answer.submit'] });
const type = (element: HTMLElement, value: string): void => void fireEvent.change(element, { target: { value } });
const sendField = (name: 'recipient' | 'question' | 'basis' | 'due'): HTMLElement => screen.getByLabelText(vi_[`bid.clarifications.send.${name}.label` as keyof typeof vi_]);
const sendButton = (): HTMLElement => screen.getByRole('button', { name: vi_['bid.clarifications.send.submit'] });

describe('ClarificationScreen (BID-11): the clarification requests to contractors', () => {
  describe('UI-BID-11: the seven states', () => {
    it('shows the loading state while the requests are read, and the requests once they are', async () => {
      open(world({ requests: [request(1)] }));
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      await screen.findByTestId('requests');
      expect(screen.getByRole('heading', { level: 1, name: vi_['bid.clarifications.page.title'] })).toBeTruthy();
      expect(screen.getByText(text('bid.clarifications.footer.reference', { id: 'BID-11', req: 'FR-BID-11' }))).toBeTruthy();
    });

    it('shows the empty state when there is no request, and still offers the question to the evaluation team', async () => {
      open(world(), { permissions: EVALUATOR });
      expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
      expect(screen.getByTestId('send-panel')).toBeTruthy();
    });

    it('shows the error state with a retry that reads again', async () => {
      const state = world({ requests: [request(1)], failing: new Map([['listBidClarifications', new Error('boom')]]) });
      const h = open(state);
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      state.failing.clear();
      fireEvent.click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      await screen.findByTestId('requests');
      expect(h.read.mock.calls.length).toBeGreaterThan(1);
    });

    it('shows the offline, signed-out and denied states for what the server says', async () => {
      open(world({ failing: new Map([['listBidClarifications', problem(NETWORK_ERROR_CODE, 0)]]) }));
      expect(await screen.findByText(vi_['states.offline.title'])).toBeTruthy();
      cleanup();
      open(world({ failing: new Map([['listBidClarifications', problem('SESSION_EXPIRED', 401)]]) }));
      expect(await screen.findByText(vi_['states.signedOut.title'])).toBeTruthy();
      cleanup();
      open(world({ failing: new Map([['listBidClarifications', problem('SCOPE_DENIED', 403)]]) }));
      expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    });

    it('is denied without the right to read, and reads nothing', () => {
      const h = open(world({ requests: [request(1)] }), { permissions: READER });
      expect(screen.getByText(vi_['states.denied.title'])).toBeTruthy();
      expect(h.read).not.toHaveBeenCalled();
    });

    it('tells a member of the evaluation team who owes the declaration to make it, with the way there, instead of an error', async () => {
      open(world({ failing: new Map([['listBidClarifications', problem('CONFLICT_UNDECLARED', 403)]]) }), { permissions: EVALUATOR });
      expect((await screen.findByTestId('undeclared')).textContent).toContain(vi_['bid.clarifications.undeclared.notice']);
      expect(screen.getByTestId('link-declare').getAttribute('href')).toBe(`/bid/bid-05?package=${packageId(1)}`);
      expect(screen.queryByTestId('send-panel')).toBeNull();
      expect(screen.queryByText(vi_['states.error.title'])).toBeNull();
    });

    it('offers no declaration link when no package is named', async () => {
      open(world({ failing: new Map([['listBidClarifications', problem('CONFLICT_UNDECLARED', 403)]]) }), { permissions: EVALUATOR, path: '/bid/bid-11' });
      await screen.findByTestId('undeclared');
      expect(screen.queryByTestId('link-declare')).toBeNull();
    });
  });

  describe('the requests', () => {
    it('shows each request as a conversation: the contractor, the status, the deadline, the question, the basis, who asked, and no answer yet', async () => {
      open(world({ requests: [request(1), request(2, { basis_finding: null })] }), { permissions: EVALUATOR });
      await screen.findByTestId('requests');
      expect(Array.from(document.querySelectorAll('[data-request]')).map((row) => row.getAttribute('data-request'))).toEqual([clarificationId(1), clarificationId(2)]);
      const first = card(1);
      expect(within(first).getByTestId('contractor').textContent).toBe('Công ty nhà thầu 1');
      expect(within(first).getByTestId('status').textContent).toBe(vi_['bid.clarifications.status.sent']);
      expect(within(first).getByTestId('due').textContent).toBe(text('bid.clarifications.due.text', { due: '10:00 20/11/99' }));
      expect(within(first).queryByTestId('expired')).toBeNull();
      expect(within(first).getByTestId('question').textContent).toBe(request(1).question);
      expect(within(first).getByTestId('basis').textContent).toBe(text('bid.clarifications.basis.criterion', { criterion: 'C2' }));
      expect(within(first).getByTestId('asked-by').textContent).toContain('Chuyên gia Lê Văn Hai');
      expect(within(first).getByTestId('no-answer').textContent).toBe(vi_['bid.clarifications.answer.none']);
      expect(within(card(2)).getByTestId('basis').textContent).toBe(vi_['bid.clarifications.basis.none']);
      // The evaluator asks and reads; recording the answer is not theirs.
      expect(within(first).queryByTestId('answer-form')).toBeNull();
    });

    it('shows a contractor only what asks them: no evaluator, no basis', async () => {
      open(world({ requests: [guestView(1)] }), { permissions: GUEST, path: '/bid/bid-11' });
      await screen.findByTestId('requests');
      expect(within(card(1)).queryByTestId('asked-by')).toBeNull();
      expect(within(card(1)).getByTestId('basis').textContent).toBe(vi_['bid.clarifications.basis.none']);
      expect(screen.queryByTestId('send-panel')).toBeNull();
      expect(screen.queryByTestId('choose-package')).toBeNull();
      expect(document.body.textContent).not.toContain('Chuyên gia Lê Văn Hai');
    });

    it('shows a request past its deadline as expired, with the cue, whatever the server last said, and offers no answer', async () => {
      open(world({ requests: [request(1, { due_at: PAST }), request(2, { due_at: PAST, status: 'EXPIRED', actions: { answer: false } })] }));
      await screen.findByTestId('requests');
      for (const n of [1, 2]) {
        expect(card(n).getAttribute('data-status')).toBe('EXPIRED');
        expect(within(card(n)).getByTestId('status').textContent).toBe(vi_['bid.clarifications.status.expired']);
        expect(within(card(n)).getByTestId('expired').textContent).toBe(vi_['bid.clarifications.due.expired']);
        expect(within(card(n)).queryByTestId('answer-form')).toBeNull();
      }
    });

    it('shows the answer that came: the document and who gave it, as the contractor or as the staff who took the letter', async () => {
      open(
        world({
          requests: [
            request(1, { status: 'ANSWERED', answer_document_id: REPLY, answered_at: '2026-11-11T03:00:00.000Z', answered_by: { membership_id: 'g', display_name: 'Người của nhà thầu' }, answered_as_guest: true, actions: { answer: false } }),
            request(2, { status: 'ANSWERED', answer_document_id: REPLY, answered_at: '2026-11-11T03:00:00.000Z', answered_by: { membership_id: 'c', display_name: 'Văn thư An' }, answered_as_guest: false, actions: { answer: false } }),
          ],
        }),
      );
      await screen.findByTestId('requests');
      expect(within(card(1)).getByTestId('status').textContent).toBe(vi_['bid.clarifications.status.answered']);
      expect(within(card(1)).getByTestId('answer-document').textContent).toBe(REPLY);
      expect(within(card(1)).getByTestId('answered-by').textContent).toMatch(/^Nhà thầu trả lời lúc /);
      expect(within(card(2)).getByTestId('answered-by').textContent).toContain('Văn thư An');
      expect(within(card(1)).queryByTestId('answer-form')).toBeNull();
    });
  });

  describe('answering', () => {
    it('AC-ST-BID-011-1, UAT-AC452: records the answer with the version the person saw, the document trimmed, and an idempotency attempt, then reads the requests again', async () => {
      const state = world({ requests: [request(1)] });
      const h = open(state, {
        command: () => {
          Object.assign(state.requests[0] as Record<string, unknown>, { status: 'ANSWERED', version: 2, answer_document_id: REPLY, answered_at: '2026-11-11T03:00:00.000Z', answered_as_guest: false, answered_by: { membership_id: 'c', display_name: 'Văn thư An' }, actions: { answer: false } });
          return OK;
        },
      });
      await screen.findByTestId('requests');
      type(answerField(1), ` ${REPLY.toUpperCase()} `);
      fireEvent.click(answerButton(1));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('recordClarificationAnswer');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: clarificationId(1) }, body: { answer_document_id: REPLY }, ifMatchVersion: 1, attempt: expect.anything() });
      await waitFor(() => expect(within(card(1)).getByTestId('answer-document').textContent).toBe(REPLY));
      expect(within(card(1)).queryByTestId('answer-form')).toBeNull();
    });

    it('asks for a document that is a UUID before it sends anything', async () => {
      const h = open(world({ requests: [request(1)] }));
      await screen.findByTestId('requests');
      fireEvent.click(answerButton(1));
      expect(within(card(1)).getByText(vi_['bid.clarifications.problem.required'])).toBeTruthy();
      type(answerField(1), 'not-a-uuid');
      expect(within(card(1)).getByText(vi_['bid.clarifications.problem.uuid'])).toBeTruthy();
      fireEvent.click(answerButton(1));
      expect(h.command).not.toHaveBeenCalled();
    });

    it('says in words why a refusal was made, and keeps what was typed', async () => {
      const refusals: Array<[Error, string]> = [
        [problem('CLARIFICATION_EXPIRED', 409), 'bid.clarifications.error.expired'],
        [problem('CLARIFICATION_STATE_INVALID', 409), 'bid.clarifications.error.answered'],
        [problem('VERSION_CONFLICT', 409), 'bid.clarifications.error.versionConflict'],
        [problem('VALIDATION_FAILED', 422, { reason: 'DOCUMENT_ALREADY_USED' }), 'bid.clarifications.error.documentUsed'],
        [problem('RESOURCE_NOT_FOUND', 404), 'bid.clarifications.error.notFound'],
      ];
      for (const [refusal, key] of refusals) {
        cleanup();
        open(world({ requests: [request(1)] }), { command: () => refusal });
        await screen.findByTestId('requests');
        type(answerField(1), REPLY);
        fireEvent.click(answerButton(1));
        expect((await within(card(1)).findByTestId('refusal')).textContent).toBe((vi_ as Record<string, string>)[key]);
        expect(answerField(1).value).toBe(REPLY);
      }
    });

    it('keeps the refusal in words when the request stops being answerable because of it: the deadline passed, or another caller answered first', async () => {
      for (const [refusal, key, becomes] of [
        [problem('CLARIFICATION_EXPIRED', 409), 'bid.clarifications.error.expired', { due_at: PAST }],
        [problem('CLARIFICATION_STATE_INVALID', 409), 'bid.clarifications.error.answered', { status: 'ANSWERED', version: 2, answer_document_id: REPLY, answered_at: '2026-11-11T03:00:00.000Z', answered_as_guest: true, actions: { answer: false } }],
      ] as const) {
        cleanup();
        const state = world({ requests: [request(1)] });
        const h = open(state, {
          command: () => {
            Object.assign(state.requests[0] as Record<string, unknown>, becomes);
            return refusal;
          },
        });
        await screen.findByTestId('requests');
        type(answerField(1), REPLY);
        fireEvent.click(answerButton(1));
        await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(within(card(1)).queryByTestId('answer-form')).toBeNull());
        expect(within(card(1)).getByTestId('refusal').textContent).toBe((vi_ as Record<string, string>)[key]);
      }
    });

    it('closes the request by itself when its deadline passes while the screen stays open: the status turns EXPIRED and the form goes, with no read in between', async () => {
      const h = open(world({ requests: [request(1, { due_at: new Date(Date.now() + 1500).toISOString() })] }));
      await screen.findByTestId('requests');
      expect(card(1).getAttribute('data-status')).toBe('SENT');
      expect(within(card(1)).getByTestId('answer-form')).toBeTruthy();
      const reads = h.read.mock.calls.length;
      await waitFor(() => expect(card(1).getAttribute('data-status')).toBe('EXPIRED'), { timeout: 4000 });
      expect(within(card(1)).queryByTestId('answer-form')).toBeNull();
      expect(h.read.mock.calls.length).toBe(reads);
    });

    it('sends one answer at a time: while one is on its way its field cannot change, the other requests are closed, and a second click sends nothing', async () => {
      let release: (value: unknown) => void = () => undefined;
      const pending = new Promise((resolve) => {
        release = resolve;
      });
      const h = open(world({ requests: [request(1), request(2)] }), { command: () => pending.then(() => OK) as unknown as Error });
      await screen.findByTestId('requests');
      type(answerField(1), REPLY);
      fireEvent.click(answerButton(1));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(answerButton(1, true)).toBeTruthy());
      expect(answerField(1).readOnly).toBe(true);
      expect((answerButton(1, true) as HTMLButtonElement).disabled).toBe(true);
      expect(answerField(2).disabled).toBe(true);
      expect((answerButton(2) as HTMLButtonElement).disabled).toBe(true);
      await act(async () => {
        fireEvent.submit(within(card(1)).getByTestId('answer-form'));
        fireEvent.submit(within(card(2)).getByTestId('answer-form'));
      });
      expect(h.command).toHaveBeenCalledTimes(1);
      release(undefined);
      await waitFor(() => expect(answerField(2).disabled).toBe(false));
    });

    it('keeps the idempotency key when the answer is lost, and takes a new one for another document', async () => {
      let calls = 0;
      const h = open(world({ requests: [request(1)] }), {
        command: () => {
          calls += 1;
          return calls === 1 ? problem('INTERNAL_ERROR', 500) : calls === 2 ? problem('CLARIFICATION_EXPIRED', 409) : OK;
        },
      });
      await screen.findByTestId('requests');
      type(answerField(1), REPLY);
      fireEvent.click(answerButton(1));
      await within(card(1)).findByTestId('refusal');
      fireEvent.click(answerButton(1));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(within(card(1)).getByTestId('refusal').textContent).toBe(vi_['bid.clarifications.error.expired']));
      type(answerField(1), '00000000-0000-4000-8000-00000000ee03');
      fireEvent.click(answerButton(1));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(3));
      const keys = h.command.mock.calls.map((call) => (call[1] as { attempt: { key: string } }).attempt.key);
      expect(keys[0]).toBe(keys[1]);
      expect(keys[2]).not.toBe(keys[1]);
    });

    it('offers the answer only where the server says the caller may give it, and not in a read-only session', async () => {
      open(world({ requests: [request(1), request(2, { actions: { answer: false } })] }));
      await screen.findByTestId('requests');
      expect(within(card(1)).getByTestId('answer-form')).toBeTruthy();
      expect(within(card(2)).queryByTestId('answer-form')).toBeNull();
      cleanup();
      open(world({ requests: [request(1)] }), { mode: 'READ_ONLY' });
      await screen.findByTestId('requests');
      expect(within(card(1)).queryByTestId('answer-form')).toBeNull();
    });
  });

  describe('asking', () => {
    const fill = (overrides: Partial<Record<'recipient' | 'question' | 'basis' | 'due', string>> = {}): void => {
      const values = { recipient: proposalId(2), question: QUESTION, basis: '', due: '2099-11-20T17:00', ...overrides };
      for (const [name, value] of Object.entries(values)) type(sendField(name as 'recipient'), value);
    };

    it('offers as recipients only the live proposals the caller has in full', async () => {
      open(world(), { permissions: EVALUATOR });
      await screen.findByTestId('send-panel');
      const options = Array.from((sendField('recipient') as HTMLSelectElement).options).map((option) => option.textContent);
      expect(options).toEqual([vi_['bid.clarifications.send.recipient.choose'], 'Công ty nhà thầu 1', 'Công ty nhà thầu 2']);
    });

    it('starts at the proposal the address names when it is one of the recipients, and at none when it is not', async () => {
      open(world(), { permissions: EVALUATOR, path: `/bid/bid-11?package=${packageId(1)}&proposal=${proposalId(2)}` });
      await screen.findByTestId('send-panel');
      await waitFor(() => expect((sendField('recipient') as HTMLSelectElement).value).toBe(proposalId(2)));
      cleanup();
      open(world(), { permissions: EVALUATOR, path: `/bid/bid-11?package=${packageId(1)}&proposal=${proposalId(3)}` });
      await screen.findByTestId('send-panel');
      expect((sendField('recipient') as HTMLSelectElement).value).toBe('');
    });

    it('does not keep a recipient chosen for another package when the package changes: the question goes to a proposal of the package that is shown', async () => {
      const first: Recipient[] = [{ proposalId: proposalId(1), contractorName: 'Công ty nhà thầu 1' }];
      const second: Recipient[] = [{ proposalId: proposalId(2), contractorName: 'Công ty nhà thầu 2' }];
      function Switch() {
        const [recipients, setRecipients] = useState(first);
        return (
          <>
            <button onClick={() => setRecipients(second)}>switch</button>
            <SendPanel packageCode="GT-02" recipients={recipients} preselected="" />
          </>
        );
      }
      const h = client(world(), () => OK);
      mount(<Switch />, h, { permissions: EVALUATOR });
      type(sendField('recipient'), proposalId(1));
      expect((sendField('recipient') as HTMLSelectElement).value).toBe(proposalId(1));
      fireEvent.click(screen.getByText('switch'));
      expect((sendField('recipient') as HTMLSelectElement).value).toBe('');
      type(sendField('question'), QUESTION);
      type(sendField('due'), '2099-11-20T17:00');
      fireEvent.click(sendButton());
      expect(await screen.findByText(vi_['bid.clarifications.problem.required'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
    });

    it('says when there is no proposal to ask about', async () => {
      open(world({ proposals: [opened(4, 1, { status: 'SUPERSEDED' })] }), { permissions: EVALUATOR });
      expect((await screen.findByTestId('no-recipients')).textContent).toBe(vi_['bid.clarifications.send.noRecipients']);
      expect(screen.queryByTestId('send-form')).toBeNull();
    });

    it('sends the question with the deadline as an instant, then clears the words and keeps the recipient, and reads the requests again', async () => {
      const h = open(world(), { permissions: EVALUATOR, command: () => ({ ...OK, status: 'SENT', resource_version: 1 }) });
      await screen.findByTestId('send-panel');
      await waitFor(() => expect((sendField('recipient') as HTMLSelectElement).options.length).toBe(3));
      fill({ basis: ` ${'00000000-0000-4000-8000-00d000000001'.toUpperCase()} ` });
      const reads = h.read.mock.calls.length;
      fireEvent.click(sendButton());
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('sendBidClarification');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({
        body: { proposal_id: proposalId(2), question: QUESTION, due_at: new Date('2099-11-20T17:00').toISOString(), basis_finding_id: '00000000-0000-4000-8000-00d000000001' },
        attempt: expect.anything(),
      });
      expect((await screen.findByTestId('sent')).textContent).toBe(vi_['bid.clarifications.send.sent']);
      await waitFor(() => expect(h.read.mock.calls.length).toBeGreaterThan(reads));
      expect((sendField('question') as HTMLTextAreaElement).value).toBe('');
      expect((sendField('recipient') as HTMLSelectElement).value).toBe(proposalId(2));
    });

    it('counts the words of the question, and asks for a recipient, a question of 10 characters, a finding that is a UUID and a deadline ahead before it sends anything', async () => {
      const h = open(world(), { permissions: EVALUATOR });
      await screen.findByTestId('send-panel');
      type(sendField('question'), '  abc  ');
      expect(screen.getByTestId('question-count').textContent).toBe(text('bid.clarifications.send.question.count', { count: 3, min: 10, max: 4000 }));
      fireEvent.click(sendButton());
      expect(screen.getByText(vi_['bid.clarifications.problem.tooShort'])).toBeTruthy();
      expect(screen.getAllByText(vi_['bid.clarifications.problem.required']).length).toBe(2);
      fill({ basis: 'nope', due: '2020-01-01T10:00', recipient: '' });
      await waitFor(() => expect(screen.getByText(vi_['bid.clarifications.problem.uuid'])).toBeTruthy());
      expect(screen.getByText(vi_['bid.clarifications.problem.past'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
    });

    it('says in words why the server refused the question, and keeps what was typed', async () => {
      const refusals: Array<[Error, string]> = [
        [problem('DUE_IN_PAST'), 'bid.clarifications.error.dueInPast'],
        [problem('PROPOSAL_NOT_OPEN', 409), 'bid.clarifications.error.proposalNotOpen'],
        [problem('CONFLICT_UNDECLARED', 403), 'bid.clarifications.error.undeclared'],
        [problem('VALIDATION_FAILED'), 'bid.clarifications.error.validation'],
      ];
      for (const [refusal, key] of refusals) {
        cleanup();
        const h = open(world(), { permissions: EVALUATOR, command: () => refusal });
        await screen.findByTestId('send-panel');
        await waitFor(() => expect((sendField('recipient') as HTMLSelectElement).options.length).toBe(3));
        fill();
        fireEvent.click(sendButton());
        expect((await screen.findByTestId('send-refusal')).textContent).toBe((vi_ as Record<string, string>)[key]);
        expect((sendField('question') as HTMLTextAreaElement).value).toBe(QUESTION);
        expect(h.command).toHaveBeenCalledTimes(1);
      }
    });

    it('closes the fields while the question is on its way and sends it once', async () => {
      let release: (value: unknown) => void = () => undefined;
      const pending = new Promise((resolve) => {
        release = resolve;
      });
      const h = open(world(), { permissions: EVALUATOR, command: () => pending.then(() => OK) as unknown as Error });
      await screen.findByTestId('send-panel');
      await waitFor(() => expect((sendField('recipient') as HTMLSelectElement).options.length).toBe(3));
      fill();
      fireEvent.click(sendButton());
      await waitFor(() => expect(screen.getByRole('button', { name: vi_['bid.clarifications.send.pending'] })).toBeTruthy());
      expect((sendField('question') as HTMLTextAreaElement).readOnly).toBe(true);
      expect((sendField('due') as HTMLInputElement).readOnly).toBe(true);
      expect((sendField('recipient') as HTMLSelectElement).disabled).toBe(true);
      await act(async () => {
        fireEvent.submit(screen.getByTestId('send-form'));
      });
      expect(h.command).toHaveBeenCalledTimes(1);
      release(undefined);
      await screen.findByTestId('sent');
    });

    it('is offered to the evaluation team only, in a session that is not read-only, and asks for a package', async () => {
      open(world(), { permissions: CLERK });
      await screen.findByText(vi_['states.empty.title']);
      expect(screen.queryByTestId('send-panel')).toBeNull();
      cleanup();
      open(world(), { permissions: EVALUATOR, mode: 'READ_ONLY' });
      await screen.findByText(vi_['states.empty.title']);
      expect(screen.queryByTestId('send-panel')).toBeNull();
      cleanup();
      open(world({ requests: [request(1)] }), { permissions: EVALUATOR, path: '/bid/bid-11' });
      expect((await screen.findByTestId('choose-package')).textContent).toBe(vi_['bid.clarifications.package.hint']);
      expect(screen.queryByTestId('send-panel')).toBeNull();
    });
  });
});
