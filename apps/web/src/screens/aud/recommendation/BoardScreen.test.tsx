import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { t } from '../../../i18n';
import vi_ from '../../../i18n/vi.json';
import { OTHER_PERSON, OWNER_ROLE, READER, VERIFIER_ROLE, actionRecord, boardRecord, client, engagementRecord, mount, routeOf, world } from '../test-support';
import BoardScreen from './BoardScreen';

const ROUTE = routeOf('AUD-07', 'FR-AUD-07');
const DOCUMENT = '00000000-0000-4000-8000-000000000021';
const PATH = '/aud/aud-07';
const OTHER_OWNER = { id: OTHER_PERSON, display_name: 'Trần Thị Bình' };

afterEach(cleanup);

const open = (
  board: Array<Record<string, unknown>>,
  permissions: readonly string[] | undefined = OWNER_ROLE,
  command: (operation: string, input: unknown) => unknown = () => ({ status: 'OK' }),
  path = PATH,
  mode?: 'FULL' | 'READ_ONLY',
) => {
  const h = client(world({ engagements: [engagementRecord(1, { status: 'FOLLOW_UP' })], board }), command);
  mount(<BoardScreen route={ROUTE} />, h, { permissions, path, ...(mode === undefined ? {} : { mode }) });
  return h;
};
const column = (name: string): HTMLElement => document.querySelector(`[data-column="${name}"]`) as HTMLElement;
const cardOf = (code: string): HTMLElement => Array.from(document.querySelectorAll('article')).find((card) => card.textContent?.includes(code)) as HTMLElement;

describe('AUD-07 follow-up of the recommendations', () => {
  it('shows one column for each stage and one card for each recommendation in it, with its owner, its day, its money and its evidence', async () => {
    open([
      boardRecord(1, { status: 'ASSIGNED' }),
      boardRecord(2, { status: 'IN_PROGRESS', recovered_vnd: '100000000', evidence_count: 2 }),
      boardRecord(3, { status: 'PENDING_VERIFICATION' }),
      boardRecord(4, { status: 'CLOSED' }),
      boardRecord(5, { status: 'OPEN' }),
    ]);
    expect(await screen.findByRole('heading', { level: 1, name: vi_['aud.remediation.board.title'] })).toBeTruthy();
    await screen.findByTestId('board');
    const sections = Array.from(document.querySelectorAll('[data-column]')).map((section) => section.getAttribute('data-column'));
    expect(sections).toEqual(['ASSIGNED', 'IN_PROGRESS', 'DISPUTED', 'PENDING_VERIFICATION', 'CLOSED']);
    expect(within(column('ASSIGNED')).getByText('KN-001')).toBeTruthy();
    expect(within(column('IN_PROGRESS')).getByText('KN-002')).toBeTruthy();
    expect(within(column('PENDING_VERIFICATION')).getByText('KN-003')).toBeTruthy();
    expect(within(column('CLOSED')).getByText('KN-004')).toBeTruthy();
    expect(within(column('DISPUTED')).getByText(vi_['aud.remediation.board.empty.text'])).toBeTruthy();
    // a recommendation that is OPEN is given out in AUD-06 and is not on the board
    expect(screen.queryByText('KN-005')).toBeNull();
    const card = within(cardOf('KN-002'));
    expect(card.getByText('Nguyễn Văn An')).toBeTruthy();
    expect(card.getByText('2026-12-01')).toBeTruthy();
    expect(card.getByText('100.000.000 / 800.000.000')).toBeTruthy();
    expect(card.getByText(vi_['aud.remediation.card.evidence.count'].replace('{count}', '2'))).toBeTruthy();
    expect(screen.getByRole('link', { name: vi_['aud.remediation.board.list.link'] }).getAttribute('href')).toBe('/aud/aud-06');
  });

  it('shows the actions of a card with their state and their evidence, and the owner of the unit when no person was named', async () => {
    open([
      boardRecord(1, {
        status: 'IN_PROGRESS',
        owner_user: null,
        actions: [actionRecord(1), actionRecord(2, { status: 'DONE', completed_on: '2026-10-24', evidence_document_id: DOCUMENT, version: 2 })],
      }),
    ]);
    await screen.findByTestId('board');
    const actions = within(screen.getByRole('list', { name: vi_['aud.remediation.card.actions'] }));
    const items = actions.getAllByRole('listitem').map((entry) => entry.textContent);
    expect(items[0]).toContain('HD-01');
    expect(items[0]).toContain(vi_['aud.actionStatus.planned']);
    expect(items[0]).toContain(vi_['aud.remediation.card.planned'].replace('{day}', '2026-11-15'));
    expect(items[1]).toContain(vi_['aud.actionStatus.done']);
    expect(items[1]).toContain('2026-10-24');
    expect(items[1]).toContain(vi_['aud.remediation.card.evidence.shown']);
    expect(within(cardOf('KN-001')).getByText('Sở Xây dựng')).toBeTruthy();
  });

  it('says how late a card is, in words, and the explanation of a disputed one and the words of a return', async () => {
    open([
      boardRecord(1, { status: 'IN_PROGRESS', due_on: '2020-01-01', verification_note: 'Chưa đủ chứng từ của đợt hai.' }),
      boardRecord(2, { status: 'DISPUTED', due_on: '2020-01-01', dispute_reason: 'Khối lượng đã được giám sát xác nhận.' }),
      boardRecord(3, { status: 'PENDING_VERIFICATION', dispute_outcome: 'ACCEPTED_BY_AUTHORITY', verification_note: 'Đã trả lại một lần.' }),
      boardRecord(4, { status: 'CLOSED', verification_note: 'Đã kiểm tra tại hiện trường.' }),
    ]);
    await screen.findByTestId('board');
    expect(screen.getAllByTestId('late-badge').length).toBe(1);
    expect(within(cardOf('KN-001')).getByTestId('return-note').textContent).toContain('Chưa đủ chứng từ của đợt hai.');
    expect(within(cardOf('KN-002')).getByTestId('dispute-note').textContent).toContain('Khối lượng đã được giám sát xác nhận.');
    expect(within(cardOf('KN-003')).getByText(vi_['aud.disputeOutcome.accepted'])).toBeTruthy();
    expect(within(cardOf('KN-002')).queryByText(vi_['aud.disputeOutcome.accepted'])).toBeNull();
    expect(within(cardOf('KN-004')).queryByTestId('return-note')).toBeNull();
    // The card that is late carries the stripe; a disputed, a returned and a closed one do not.
    expect(cardOf('KN-001').getAttribute('data-stripe')).toBe('ACTION');
    expect(cardOf('KN-002').getAttribute('data-stripe')).toBeNull();
    expect(cardOf('KN-003').getAttribute('data-stripe')).toBeNull();
    expect(cardOf('KN-004').getAttribute('data-stripe')).toBeNull();
  });

  it('counts the recommendations being followed, the late ones and the disputed ones above the columns, and says how long is left on one that is not late', async () => {
    open([
      boardRecord(1, { status: 'IN_PROGRESS', due_on: '2020-01-01' }),
      boardRecord(2, { status: 'DISPUTED', due_on: '2020-01-01' }),
      boardRecord(3, { status: 'IN_PROGRESS', due_on: '2099-12-31' }),
      boardRecord(4, { status: 'CLOSED' }),
    ]);
    await screen.findByTestId('board');
    const strip = within(screen.getByRole('group', { name: t('w2iss.aud.board.kpi.label') }));
    expect(strip.getByText(t('w2iss.aud.board.kpi.active')).closest('article')?.textContent).toContain('3');
    expect(strip.getByText(t('w2iss.aud.board.kpi.late')).closest('article')?.textContent).toContain('1');
    expect(strip.getByText(t('w2iss.aud.board.kpi.disputed')).closest('article')?.textContent).toContain('1');
    expect(within(cardOf('KN-003')).getByText(/^Còn \d+ ngày/)).toBeTruthy();
    expect(within(cardOf('KN-001')).queryByText(/^Còn /)).toBeNull();
  });

  it('offers each button to whoever may use it in the stage it fits, and none to a reader or in a tenant that is read only', async () => {
    const working = boardRecord(1, { status: 'IN_PROGRESS', actions: [actionRecord(1)] });
    open([working, boardRecord(2, { status: 'ASSIGNED' })], OWNER_ROLE);
    await screen.findByTestId('board');
    const names = (code: string): string[] => within(cardOf(code)).getAllByRole('button').map((button) => button.textContent ?? '');
    expect(names('KN-001')).toEqual([vi_['aud.remediation.complete.action'], vi_['aud.remediation.plan.action'], vi_['aud.remediation.submit.action'], vi_['aud.remediation.dispute.action'], vi_['aud.remediation.evidence.action']]);
    expect(names('KN-002')).toEqual([vi_['aud.remediation.plan.action'], vi_['aud.remediation.dispute.action'], vi_['aud.remediation.evidence.action']]);
    cleanup();
    open([boardRecord(1, { status: 'PENDING_VERIFICATION', owner_user: OTHER_OWNER, submitted_by: OTHER_PERSON }), boardRecord(2, { status: 'DISPUTED', owner_user: OTHER_OWNER, disputed_by: OTHER_PERSON })], VERIFIER_ROLE);
    await screen.findByTestId('board');
    expect(names('KN-001')).toEqual([vi_['aud.remediation.verify.action']]);
    expect(names('KN-002')).toEqual([vi_['aud.remediation.decision.action']]);
    cleanup();
    open([working], READER);
    await screen.findByTestId('board');
    expect(within(cardOf('KN-001')).queryByRole('button')).toBeNull();
    cleanup();
    open([working], OWNER_ROLE, undefined, PATH, 'READ_ONLY');
    await screen.findByTestId('board');
    expect(within(cardOf('KN-001')).queryByRole('button')).toBeNull();
    cleanup();
    // another person's work: the owner of a named recommendation is that person
    open([boardRecord(1, { status: 'IN_PROGRESS', owner_user: OTHER_OWNER, actions: [actionRecord(1)] })], OWNER_ROLE);
    await screen.findByTestId('board');
    expect(within(cardOf('KN-001')).queryByRole('button')).toBeNull();
  });

  describe('the owner does the work (AC-ST-AUD-003-2)', () => {
    const working = () => boardRecord(1, { status: 'IN_PROGRESS', version: 5, actions: [actionRecord(1, { version: 2 })] });
    const press = async (name: string, command?: (operation: string, input: unknown) => unknown, board = [working()], permissions: readonly string[] = OWNER_ROLE) => {
      const h = open(board, permissions, command);
      const user = userEvent.setup();
      await screen.findByTestId('board');
      await user.click(within(cardOf('KN-001')).getByRole('button', { name }));
      return { h, user, box: screen.getByRole('dialog') };
    };

    it('plans an action under the version of the recommendation', async () => {
      const { h, user, box } = await press(vi_['aud.remediation.plan.action']);
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      expect(within(box).getAllByText(vi_['aud.formProblem.required']).length).toBe(3);
      await user.type(within(box).getByLabelText(vi_['aud.remediation.plan.code.label']), 'HD-02');
      await user.type(within(box).getByLabelText(vi_['aud.remediation.plan.plannedOn.label']), '2026-11-15');
      await user.type(within(box).getByLabelText(vi_['aud.remediation.plan.description.label']), 'Chấn chỉnh quy trình thanh toán.');
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('planRemediationAction');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: boardRecord(1).id }, ifMatchVersion: 5, body: { action_code: 'HD-02', description: 'Chấn chỉnh quy trình thanh toán.', planned_on: '2026-11-15' } });
    });

    it('completes an action under the version of the ACTION, with the day and the document, and refuses evidence that is not in force in words', async () => {
      const refused = new ApiError({ status: 422, code: 'EVIDENCE_REQUIRED', correlationId: 'c' });
      const { h, user, box } = await press(vi_['aud.remediation.complete.action'], () => refused);
      await user.type(within(box).getByLabelText(vi_['aud.remediation.complete.completedOn.label']), '2999-01-01');
      await user.type(within(box).getByLabelText(vi_['aud.remediation.complete.evidence.label']), 'not-an-id');
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      expect(within(box).getByText(vi_['aud.formProblem.future'])).toBeTruthy();
      expect(within(box).getByText(vi_['aud.formProblem.invalid'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      await user.clear(within(box).getByLabelText(vi_['aud.remediation.complete.completedOn.label']));
      await user.type(within(box).getByLabelText(vi_['aud.remediation.complete.completedOn.label']), '2026-10-24');
      await user.clear(within(box).getByLabelText(vi_['aud.remediation.complete.evidence.label']));
      await user.type(within(box).getByLabelText(vi_['aud.remediation.complete.evidence.label']), DOCUMENT);
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      expect((await within(box).findByTestId('refusal')).textContent).toBe(vi_['aud.remediationProblem.evidenceRequired']);
      expect(h.command.mock.calls[0]?.[0]).toBe('completeRemediationAction');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: actionRecord(1).id }, ifMatchVersion: 2, body: { completed_on: '2026-10-24', evidence_document_id: DOCUMENT } });
    });

    it('reports the work for verification with a note of what that means, and tells what is left to recover when it is not recovered in full', async () => {
      const refused = new ApiError({ status: 422, code: 'RECOVERY_INCOMPLETE', correlationId: 'c', extensions: { remaining_vnd: '100000000' } });
      const { h, user, box } = await press(vi_['aud.remediation.submit.action'], () => refused);
      expect(within(box).getByTestId('submit-note').textContent).toBe(vi_['aud.remediation.submit.note']);
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      expect((await within(box).findByTestId('refusal')).textContent).toBe(vi_['aud.remediationProblem.recoveryIncomplete'].replace('{remaining}', '100.000.000'));
      expect(h.command.mock.calls[0]?.[0]).toBe('submitRecommendationForVerification');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: boardRecord(1).id }, ifMatchVersion: 5 });
    });

    const REFUSALS: Array<[string, string]> = [
      ['OPEN_ACTIONS_REMAIN', vi_['aud.remediationProblem.openActions']],
      ['NOT_OWNER', vi_['aud.remediationProblem.notOwner']],
      ['ACTION_CODE_DUPLICATE', vi_['aud.remediationProblem.actionDuplicate']],
      ['ACTION_STATE_INVALID', vi_['aud.remediationProblem.actionState']],
      ['ENGAGEMENT_STATE_INVALID', vi_['aud.remediationProblem.engagementState']],
      ['SCOPE_DENIED', vi_['aud.remediationProblem.scopeDenied']],
      ['VALIDATION_FAILED', vi_['aud.remediationProblem.validation']],
    ];

    it.each(REFUSALS)('tells the refusal %s of a report in words', async (code, message) => {
      const { user, box } = await press(vi_['aud.remediation.submit.action'], () => new ApiError({ status: 422, code, correlationId: 'c' }));
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      expect((await within(box).findByTestId('refusal')).textContent).toBe(message);
    });

    it('puts evidence on the recommendation or on one of its actions', async () => {
      const { h, user, box } = await press(vi_['aud.remediation.evidence.action']);
      const target = within(box).getByLabelText(vi_['aud.remediation.evidence.target.label']);
      expect(within(target).getAllByRole('option').map((option) => option.textContent)).toEqual([vi_['aud.remediation.evidence.target.recommendation'], vi_['aud.remediation.evidence.target.action'].replace('{code}', 'HD-01')]);
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      expect(within(box).getByText(vi_['aud.formProblem.required'])).toBeTruthy();
      await user.selectOptions(target, `ACTION:${actionRecord(1).id}`);
      await user.type(within(box).getByLabelText(vi_['aud.remediation.evidence.document.label']), DOCUMENT);
      await user.type(within(box).getByLabelText(vi_['aud.remediation.evidence.note.label']), 'Biên bản nghiệm thu.');
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('attachAuditEvidence');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { owner_kind: 'ACTION', owner_id: actionRecord(1).id, document_id: DOCUMENT, note: 'Biên bản nghiệm thu.' } });
      expect((h.command.mock.calls[0]?.[1] as Record<string, unknown>).ifMatchVersion).toBeUndefined();
    });

    it('disputes from the board too', async () => {
      const { h, user, box } = await press(vi_['aud.remediation.dispute.action']);
      await user.type(within(box).getByLabelText(vi_['aud.remediation.dispute.reason.label']), 'Khối lượng đã được giám sát xác nhận tại hiện trường.');
      await user.type(within(box).getByLabelText(vi_['aud.remediation.dispute.document.label']), DOCUMENT);
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('disputeAuditRecommendation');
    });
  });

  describe('the verifier (BR-AUD-08)', () => {
    const pending = () => boardRecord(1, { status: 'PENDING_VERIFICATION', version: 7, owner_user: OTHER_OWNER, submitted_by: OTHER_PERSON });
    const press = async (command?: (operation: string, input: unknown) => unknown) => {
      const h = open([pending()], VERIFIER_ROLE, command);
      const user = userEvent.setup();
      await screen.findByTestId('board');
      await user.click(within(cardOf('KN-001')).getByRole('button', { name: vi_['aud.remediation.verify.action'] }));
      return { h, user, box: screen.getByRole('dialog') };
    };

    it('closes it, naming the document the closure rests on when there is one', async () => {
      const { h, user, box } = await press();
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      expect(within(box).getByText(vi_['aud.formProblem.required'])).toBeTruthy();
      expect(within(box).queryByLabelText(vi_['aud.remediation.verify.basis.label'])).toBeNull();
      await user.selectOptions(within(box).getByLabelText(vi_['aud.remediation.verify.decision.label']), 'CLOSE');
      await user.type(within(box).getByLabelText(vi_['aud.remediation.verify.basis.label']), DOCUMENT);
      await user.type(within(box).getByLabelText(vi_['aud.remediation.verify.comment.label']), 'Đã kiểm tra tại hiện trường.');
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('verifyAuditRecommendation');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ ifMatchVersion: 7, body: { decision: 'CLOSE', closure_basis_document_id: DOCUMENT, comment: 'Đã kiểm tra tại hiện trường.' } });
    });

    it('sends it back only with the words of what is left to do', async () => {
      const { h, user, box } = await press();
      await user.selectOptions(within(box).getByLabelText(vi_['aud.remediation.verify.decision.label']), 'RETURN');
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      expect(within(box).getByText(vi_['aud.formProblem.required'])).toBeTruthy();
      expect(within(box).getByText(vi_['aud.remediation.verify.comment.help'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      await user.type(within(box).getByLabelText(vi_['aud.remediation.verify.comment.label']), 'Còn thiếu chứng từ của đợt hai.');
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { decision: 'RETURN', comment: 'Còn thiếu chứng từ của đợt hai.' } });
    });

    it('tells the refusal of the server in words: the separation of duties, a recovery that is not complete, a document that is not in force', async () => {
      for (const [code, message] of [
        ['SELF_APPROVAL_DENIED', vi_['aud.remediationProblem.selfApproval']],
        ['RECOVERY_INCOMPLETE', vi_['aud.remediationProblem.recoveryIncomplete'].replace('{remaining}', '0')],
        ['DOCUMENT_NOT_EFFECTIVE', vi_['aud.remediationProblem.documentNotEffective']],
      ] as const) {
        const { user, box } = await press(() => new ApiError({ status: 403, code, correlationId: 'c' }));
        await user.selectOptions(within(box).getByLabelText(vi_['aud.remediation.verify.decision.label']), 'CLOSE');
        await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
        expect((await within(box).findByTestId('refusal')).textContent).toBe(message);
        cleanup();
      }
    });

    it('records the answer of the authority from the board', async () => {
      const h = open([boardRecord(1, { status: 'DISPUTED', dispute_reason: 'Khối lượng đã được giám sát xác nhận.', owner_user: OTHER_OWNER, disputed_by: OTHER_PERSON, version: 6 })], VERIFIER_ROLE);
      const user = userEvent.setup();
      await screen.findByTestId('board');
      await user.click(within(cardOf('KN-001')).getByRole('button', { name: vi_['aud.remediation.decision.action'] }));
      const box = screen.getByRole('dialog');
      await user.selectOptions(within(box).getByLabelText(vi_['aud.remediation.decision.outcome.label']), 'REJECTED_BY_AUTHORITY');
      await user.type(within(box).getByLabelText(vi_['aud.remediation.decision.document.label']), DOCUMENT);
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('recordAuditDisputeDecision');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ ifMatchVersion: 6, body: { outcome: 'REJECTED_BY_AUTHORITY', authority_document_id: DOCUMENT } });
    });
  });

  it('narrows the board to the engagement of the address and lists the engagements that can be chosen', async () => {
    const engagement = (boardRecord(1).engagement as { id: string }).id;
    open([boardRecord(1, { status: 'ASSIGNED' })], OWNER_ROLE, undefined, `${PATH}?engagement=${engagement}`);
    await screen.findByTestId('board');
    expect((screen.getByLabelText(vi_['aud.remediation.filter.engagement.label']) as HTMLSelectElement).value).toBe(engagement);
    expect(screen.getByRole('link', { name: vi_['aud.remediation.board.list.link'] }).getAttribute('href')).toBe(`/aud/aud-06?engagement=${engagement}`);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(vi_['aud.remediation.filter.engagement.label']), '');
    await waitFor(() => expect((screen.getByLabelText(vi_['aud.remediation.filter.engagement.label']) as HTMLSelectElement).value).toBe(''));
  });

  describe('the seven states', () => {
    it('shows the empty columns, a loading state first, then the denied, signed-out, offline and error states', async () => {
      open([]);
      await screen.findByTestId('board');
      expect(screen.getAllByText(vi_['aud.remediation.board.empty.text']).length).toBe(5);
      cleanup();
      const failing = (error: Error) => {
        const state = world({ engagements: [engagementRecord(1, { status: 'FOLLOW_UP' })] });
        state.failing.set('listAuditRecommendations', error);
        return client(state);
      };
      mount(<BoardScreen route={ROUTE} />, failing(new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' })), { permissions: READER, path: PATH });
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
      cleanup();
      mount(<BoardScreen route={ROUTE} />, failing(new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' })), { permissions: READER, path: PATH });
      expect(await screen.findByText(vi_['states.signedOut.title'])).toBeTruthy();
      cleanup();
      mount(<BoardScreen route={ROUTE} />, failing(new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' })), { permissions: READER, path: PATH });
      expect(await screen.findByText(vi_['states.offline.title'])).toBeTruthy();
      cleanup();
      mount(<BoardScreen route={ROUTE} />, failing(new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' })), { permissions: READER, path: PATH });
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    });
  });
});
