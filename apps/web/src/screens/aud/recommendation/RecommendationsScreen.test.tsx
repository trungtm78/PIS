import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { LEADER, OTHER_PERSON, OWNER_ROLE, READER, SELF, UNIT, VERIFIER_ROLE, boardRecord, client, engagementRecord, mount, routeOf, world } from '../test-support';
import RecommendationsScreen from './RecommendationsScreen';

const ROUTE = routeOf('AUD-06', 'FR-AUD-06');
const DOCUMENT = '00000000-0000-4000-8000-000000000021';
const PATH = '/aud/aud-06';

afterEach(cleanup);

const stateOf = (board: Array<Record<string, unknown>>) => world({ engagements: [engagementRecord(1, { status: 'FOLLOW_UP' })], board });
const open = (
  board: Array<Record<string, unknown>> = [boardRecord(1, { status: 'OPEN', owner_unit: null, owner_unit_id: null, owner_user: null, due_on: null })],
  permissions: readonly string[] | undefined = LEADER,
  command: (operation: string, input: unknown) => unknown = () => ({ status: 'OK' }),
  path = PATH,
  mode?: 'FULL' | 'READ_ONLY',
) => {
  const h = client(stateOf(board), command);
  mount(<RecommendationsScreen route={ROUTE} />, h, { permissions, path, ...(mode === undefined ? {} : { mode }) });
  return h;
};
const rowOf = (code: string): HTMLElement => screen.getAllByRole('row').find((row) => row.textContent?.includes(code)) as HTMLElement;

describe('AUD-06 recommendations and assignment', () => {
  it('lists the recommendations with their type, the money recovered of what was recommended, the owner, the day, the status and the engagement', async () => {
    open([
      boardRecord(1, { status: 'IN_PROGRESS', recovered_vnd: '100000000' }),
      boardRecord(2, { status: 'OPEN', rec_type: 'REFERRAL', amount_vnd: null, owner_unit: null, owner_unit_id: null, owner_user: null, due_on: null }),
    ]);
    expect(await screen.findByRole('heading', { level: 1, name: vi_['aud.remediation.list.title'] })).toBeTruthy();
    const rows = (await screen.findAllByRole('row')).slice(1).map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent));
    expect(rows[0]?.slice(0, 6)).toEqual([
      expect.stringContaining('KN-001'),
      vi_['aud.recommendationType.financialRecovery'],
      '100.000.000 / 800.000.000',
      'Sở Xây dựngNguyễn Văn An',
      '2026-12-01',
      vi_['aud.recommendationStatus.inProgress'],
    ]);
    expect(rows[0]?.[0]).toContain('TTCP-2026-001');
    expect(rows[1]?.slice(1, 5)).toEqual([vi_['aud.recommendationType.referral'], '—', vi_['aud.remediation.owner.none'], '—']);
    expect(screen.getByTestId('recommendation-count').textContent).toBe(vi_['aud.remediation.list.count.text'].replace('{count}', '2'));
    expect(screen.getAllByRole('link', { name: vi_['aud.remediation.list.open.link'] })[0]?.getAttribute('href')).toBe(`/aud/aud-07?engagement=${boardRecord(1).engagement ? (boardRecord(1).engagement as { id: string }).id : ''}`);
    expect(screen.getByTestId('confidential-note').textContent).toBe(vi_['aud.remediation.confidential.note']);
  });

  it('says how late a recommendation is, in words, with the day it was due, and not for one that is disputed or closed', async () => {
    open([boardRecord(1, { status: 'IN_PROGRESS', due_on: '2020-01-01' }), boardRecord(2, { status: 'DISPUTED', due_on: '2020-01-01' }), boardRecord(3, { status: 'CLOSED', due_on: '2020-01-01' })]);
    await screen.findAllByRole('row');
    const badges = screen.getAllByTestId('late-badge');
    expect(badges.length).toBe(1);
    expect(badges[0]?.textContent).toMatch(/^Quá hạn \d+ ngày \(hạn 2020-01-01\)$/);
  });

  it('offers the assignment to a leader for what is OPEN or ASSIGNED, and the dispute and the answer to whoever holds that permission', async () => {
    open(
      [
        boardRecord(1, { status: 'OPEN', owner_unit: null, owner_unit_id: null, owner_user: null, due_on: null }),
        boardRecord(2, { status: 'ASSIGNED' }),
        boardRecord(3, { status: 'IN_PROGRESS' }),
      ],
      LEADER,
    );
    await screen.findAllByRole('row');
    expect(within(rowOf('KN-001')).getByRole('button', { name: vi_['aud.remediation.assign.action'] })).toBeTruthy();
    expect(within(rowOf('KN-002')).getByRole('button', { name: vi_['aud.remediation.reassign.action'] })).toBeTruthy();
    expect(within(rowOf('KN-003')).queryByRole('button')).toBeNull();
    cleanup();
    open([boardRecord(1, { status: 'ASSIGNED' }), boardRecord(2, { status: 'OPEN', owner_unit: null, owner_unit_id: null, owner_user: null })], OWNER_ROLE);
    await screen.findAllByRole('row');
    expect(within(rowOf('KN-001')).getByRole('button', { name: vi_['aud.remediation.dispute.action'] })).toBeTruthy();
    expect(within(rowOf('KN-002')).queryByRole('button')).toBeNull();
    cleanup();
    open([boardRecord(1, { status: 'DISPUTED', owner_user: { id: OTHER_PERSON, display_name: 'Trần Thị Bình' }, disputed_by: OTHER_PERSON })], VERIFIER_ROLE);
    await screen.findAllByRole('row');
    expect(within(rowOf('KN-001')).getByRole('button', { name: vi_['aud.remediation.decision.action'] })).toBeTruthy();
    cleanup();
    open([boardRecord(1, { status: 'OPEN' })], READER);
    await screen.findAllByRole('row');
    expect(within(rowOf('KN-001')).queryByRole('button')).toBeNull();
    cleanup();
    open([boardRecord(1, { status: 'OPEN' })], LEADER, undefined, PATH, 'READ_ONLY');
    await screen.findAllByRole('row');
    expect(within(rowOf('KN-001')).queryByRole('button')).toBeNull();
  });

  it('narrows by the words typed, by status and by type, and by the engagement of the address', async () => {
    const h = open([boardRecord(1, { status: 'OPEN' }), boardRecord(2, { status: 'IN_PROGRESS', description: 'Sửa quy trình giải ngân.' })]);
    const user = userEvent.setup();
    await screen.findAllByRole('row');
    await user.type(screen.getByLabelText(vi_['aud.remediation.filter.search.label']), 'giải ngân');
    expect(screen.getAllByRole('row').length).toBe(2);
    expect(screen.getByTestId('recommendation-count').textContent).toBe(vi_['aud.remediation.list.count.text'].replace('{count}', '1'));
    await user.clear(screen.getByLabelText(vi_['aud.remediation.filter.search.label']));
    await user.selectOptions(screen.getByLabelText(vi_['aud.remediation.filter.status.label']), 'OPEN');
    await waitFor(() => expect(screen.getByTestId('recommendation-count').textContent).toBe(vi_['aud.remediation.list.count.text'].replace('{count}', '1')));
    await user.selectOptions(screen.getByLabelText(vi_['aud.remediation.filter.type.label']), 'REFERRAL');
    expect(await screen.findByTestId('no-recommendations')).toBeTruthy();
    expect(h.client.readAll).toHaveBeenCalledWith('listAuditRecommendations', expect.objectContaining({ query: { status: 'OPEN', rec_type: 'REFERRAL' } }));
    cleanup();
    open([boardRecord(1)], LEADER, undefined, `${PATH}?engagement=${(boardRecord(1).engagement as { id: string }).id}`);
    await screen.findAllByRole('row');
    expect((screen.getByLabelText(vi_['aud.remediation.filter.engagement.label']) as HTMLSelectElement).value).toBe((boardRecord(1).engagement as { id: string }).id);
  });

  describe('assigning (AC-ST-AUD-003-1)', () => {
    const dialog = async (command: (operation: string, input: unknown) => unknown = () => ({ status: 'OK' })) => {
      const h = open([boardRecord(1, { status: 'OPEN', owner_unit: null, owner_unit_id: null, owner_user: null, due_on: null, version: 4 })], LEADER, command);
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: vi_['aud.remediation.assign.action'] }));
      return { h, user, box: screen.getByRole('dialog') };
    };

    it('asks for the unit and a day inside the deadline of the conclusion, refuses a day after it before sending, and sends the assignment under the version it saw', async () => {
      const { h, user, box } = await dialog();
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      expect(within(box).getAllByText(vi_['aud.formProblem.required']).length).toBe(2);
      expect(within(box).getByText(vi_['aud.remediation.assign.due.help'].replace('{deadline}', '2026-12-31'))).toBeTruthy();
      await waitFor(() => expect(within(box).getAllByRole('option').length).toBeGreaterThan(2));
      await user.selectOptions(within(box).getByLabelText(vi_['aud.remediation.assign.unit.label']), UNIT);
      await user.type(within(box).getByLabelText(vi_['aud.remediation.assign.due.label']), '2027-01-02');
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      expect(within(box).getByText(vi_['aud.formProblem.afterDeadline'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      await user.clear(within(box).getByLabelText(vi_['aud.remediation.assign.due.label']));
      await user.type(within(box).getByLabelText(vi_['aud.remediation.assign.due.label']), '2026-12-01');
      await user.selectOptions(within(box).getByLabelText(vi_['aud.remediation.assign.user.label']), SELF);
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('assignAuditRecommendation');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: boardRecord(1).id }, ifMatchVersion: 4, body: { owner_unit_id: UNIT, owner_user_id: SELF, due_on: '2026-12-01' } });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    const REFUSALS: Array<[string, string]> = [
      ['OWNER_OUT_OF_SCOPE', vi_['aud.remediationProblem.ownerOutOfScope']],
      ['RECOMMENDATION_STATE_INVALID', vi_['aud.remediationProblem.recommendationState']],
      ['VERSION_CONFLICT', vi_['aud.remediationProblem.versionConflict']],
      ['RESOURCE_NOT_FOUND', vi_['aud.remediationProblem.notFound']],
      ['SOMETHING_ELSE', vi_['aud.remediationProblem.general']],
    ];

    it.each(REFUSALS)('tells the refusal %s in words and keeps the dialog', async (code, message) => {
      const { user, box } = await dialog(() => new ApiError({ status: 422, code, correlationId: 'c' }));
      await waitFor(() => expect(within(box).getAllByRole('option').length).toBeGreaterThan(2));
      await user.selectOptions(within(box).getByLabelText(vi_['aud.remediation.assign.unit.label']), UNIT);
      await user.type(within(box).getByLabelText(vi_['aud.remediation.assign.due.label']), '2026-12-01');
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      expect((await within(box).findByTestId('refusal')).textContent).toBe(message);
      expect(screen.getByRole('dialog')).toBeTruthy();
    });

    it('tells the deadline the server read when a day was after it', async () => {
      const { user, box } = await dialog(() => new ApiError({ status: 422, code: 'DUE_AFTER_CONCLUSION_DEADLINE', correlationId: 'c', extensions: { implementation_due_on: '2026-11-30' } }));
      await waitFor(() => expect(within(box).getAllByRole('option').length).toBeGreaterThan(2));
      await user.selectOptions(within(box).getByLabelText(vi_['aud.remediation.assign.unit.label']), UNIT);
      await user.type(within(box).getByLabelText(vi_['aud.remediation.assign.due.label']), '2026-12-01');
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      expect((await within(box).findByTestId('refusal')).textContent).toBe(vi_['aud.remediationProblem.dueAfterDeadline'].replace('{deadline}', '2026-11-30'));
    });

    it('does not ask for a deadline when the conclusion states none', async () => {
      open([boardRecord(1, { status: 'OPEN', implementation_due_on: null, owner_unit: null, owner_unit_id: null, owner_user: null })]);
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: vi_['aud.remediation.assign.action'] }));
      expect(screen.queryByText(/Không sau hạn thực hiện của kết luận/)).toBeNull();
    });
  });

  describe('disputing and the answer of the authority (AC-ST-AUD-003-3)', () => {
    it('sends the explanation with its document, and refuses a short one before sending', async () => {
      const h = open([boardRecord(1, { status: 'IN_PROGRESS' })], OWNER_ROLE);
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: vi_['aud.remediation.dispute.action'] }));
      const box = screen.getByRole('dialog');
      await user.type(within(box).getByLabelText(vi_['aud.remediation.dispute.reason.label']), 'quá ngắn');
      await user.type(within(box).getByLabelText(vi_['aud.remediation.dispute.document.label']), DOCUMENT);
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      expect(within(box).getByText(vi_['aud.formProblem.tooShort'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      await user.clear(within(box).getByLabelText(vi_['aud.remediation.dispute.reason.label']));
      await user.type(within(box).getByLabelText(vi_['aud.remediation.dispute.reason.label']), 'Khối lượng đã được giám sát xác nhận tại hiện trường.');
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('disputeAuditRecommendation');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ ifMatchVersion: 3, body: { dispute_reason: 'Khối lượng đã được giám sát xác nhận tại hiện trường.', dispute_document_id: DOCUMENT } });
    });

    it('shows the explanation to the verifier, and records the answer of the authority with its document, telling the refusal when the document is not in force', async () => {
      const refused = new ApiError({ status: 422, code: 'DECISION_DOCUMENT_NOT_EFFECTIVE', correlationId: 'c' });
      open([boardRecord(1, { status: 'DISPUTED', dispute_reason: 'Khối lượng đã được giám sát xác nhận.', owner_user: { id: OTHER_PERSON, display_name: 'Trần Thị Bình' }, disputed_by: OTHER_PERSON })], VERIFIER_ROLE, () => refused);
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: vi_['aud.remediation.decision.action'] }));
      const box = screen.getByRole('dialog');
      expect(within(box).getByTestId('dispute-reason').textContent).toBe('Khối lượng đã được giám sát xác nhận.');
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      expect(within(box).getAllByText(vi_['aud.formProblem.required']).length).toBe(2);
      await user.selectOptions(within(box).getByLabelText(vi_['aud.remediation.decision.outcome.label']), 'ACCEPTED_BY_AUTHORITY');
      await user.type(within(box).getByLabelText(vi_['aud.remediation.decision.document.label']), DOCUMENT);
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      expect((await within(box).findByTestId('refusal')).textContent).toBe(vi_['aud.remediationProblem.decisionNotEffective']);
    });
  });

  describe('the seven states', () => {
    it('shows an empty list in words, a loading state first, then the denied, signed-out, offline and error states', async () => {
      mount(<RecommendationsScreen route={ROUTE} />, client(stateOf([])), { permissions: READER, path: PATH });
      expect(await screen.findByTestId('no-recommendations')).toBeTruthy();
      cleanup();
      const failing = (error: Error) => {
        const state = stateOf([]);
        state.failing.set('listAuditRecommendations', error);
        return client(state);
      };
      mount(<RecommendationsScreen route={ROUTE} />, failing(new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' })), { permissions: READER, path: PATH });
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
      cleanup();
      mount(<RecommendationsScreen route={ROUTE} />, failing(new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' })), { permissions: READER, path: PATH });
      expect(await screen.findByText(vi_['states.signedOut.title'])).toBeTruthy();
      cleanup();
      mount(<RecommendationsScreen route={ROUTE} />, failing(new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' })), { permissions: READER, path: PATH });
      expect(await screen.findByText(vi_['states.offline.title'])).toBeTruthy();
      cleanup();
      mount(<RecommendationsScreen route={ROUTE} />, failing(new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' })), { permissions: READER, path: PATH });
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    });
  });
});
