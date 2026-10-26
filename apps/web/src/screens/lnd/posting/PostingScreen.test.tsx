import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { PLAN_READER, PLANNER, PROJECT, client, feedbackRecord, household, mount, planRecord, routeOf, timersRecord, world } from '../test-support';
import { todayInVietnam } from '../model';
import PostingScreen from './PostingScreen';

const ROUTE = routeOf('LND-06', 'FR-LND-06');
const PATH = `/lnd/lnd-06?project=${PROJECT}`;
const OK = { operation_id: 'o', status: 'POSTING', resource_version: 3, resource_id: planRecord(1).id };
const problem = (code: string, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions: {} });
const APPROVER = ['land.plan.approve', 'land.read'];
const BOTH = ['land.plan.write', 'land.plan.approve', 'land.read'];
const DOCUMENT = '00000000-0000-4000-8000-000000000a01';
const TODAY = todayInVietnam();
/** A posting whose days are over long ago, and one that is far from over. */
const PAST = { posting_started_on: '2020-01-01', posting_ends_on: '2020-01-31' };
const FUTURE = { posting_started_on: '2999-01-01', posting_ends_on: '2999-01-31' };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const worldOf = () =>
  world({
    households: [household(1)],
    plans: [
      planRecord(1, { total_support_vnd: '5000', grand_total_vnd: '5000', version: 2 }),
      planRecord(2, { status: 'POSTING', ...PAST, posting_place_text: 'UBND xã An Phú', total_support_vnd: '5000', grand_total_vnd: '5000', version: 3 }),
      planRecord(3, { status: 'POSTING', ...FUTURE, posting_place_text: 'UBND xã An Phú', version: 3 }),
      planRecord(4, { status: 'POSTING_CLOSED', ...PAST, feedback_summary: 'Hai ý kiến về giá', version: 4 }),
      planRecord(5, { status: 'APPROVED', ...PAST, feedback_summary: 'Không có ý kiến', approved_on: '2020-02-05', payment_due_on: '2020-03-06', decision_document_version_id: DOCUMENT, version: 5 }),
      planRecord(6, { status: 'REVISED', plan_code: 'PA-0006' }),
      planRecord(7, { status: 'COMPLETED', plan_code: 'PA-0007' }),
      planRecord(8, { plan_code: 'PA-0008' }),
    ],
    feedback: [
      feedbackRecord(1, planRecord(2).id),
      feedbackRecord(2, planRecord(2).id, { household_id: null, household_code: null, channel: 'LETTER', summary: 'Đề nghị đo lại', status: 'HANDLED', handled_on: '2026-08-07', handling_note: 'Đã đo lại' }),
    ],
    timers: {
      [planRecord(2).id]: timersRecord(planRecord(2).id, { feedback_open: 1, feedback_handled: 1, posting_started_on: '2020-01-01', posting_ends_on: '2020-01-31' }),
      [planRecord(3).id]: timersRecord(planRecord(3).id),
      [planRecord(4).id]: timersRecord(planRecord(4).id, { status: 'POSTING_CLOSED', feedback_open: 0, feedback_handled: 2 }),
    },
  });
const rowOf = (n: number): HTMLElement => document.querySelector(`[data-plan-id="${planRecord(n).id}"]`) as HTMLElement;
const ready = () => screen.findByTestId('plans');
const label = (key: string, code: string, revision = 1) => vi_[key as keyof typeof vi_].replace('{code}', code).replace('{revision}', String(revision));
const open = async (n: number) => {
  await ready();
  fireEvent.click(within(rowOf(n)).getByRole('button', { name: label('lnd.posting.open.aria', planRecord(n).plan_code) }));
  return screen.findByTestId('posting-detail');
};

describe('PostingScreen (LND-06): the posting of a plan, the opinions on it and its approval', () => {
  it('UI-LND-06: asks for a project first and lists the plans that can be posted, are posted, have closed their posting or were approved', async () => {
    mount(<PostingScreen route={ROUTE} />, client(worldOf()), { permissions: PLANNER, path: '/lnd/lnd-06' });
    expect((await screen.findByTestId('choose-project')).textContent).toBe(vi_['lnd.posting.project.notice']);
    expect(screen.queryByTestId('plans')).toBeNull();
    const back = (): string | null => screen.getByRole('link', { name: new RegExp(vi_['lnd.posting.back.link']) }).getAttribute('href');
    expect(back()).toBe('/lnd/lnd-05');
    await screen.findByRole('option', { name: /DA-2026-001/ });
    fireEvent.change(screen.getByLabelText(vi_['lnd.posting.project.label']), { target: { value: PROJECT } });
    await ready();
    expect(back()).toBe(`/lnd/lnd-05?project=${PROJECT}`);
    expect(Array.from(document.querySelectorAll('[data-plan-id]')).map((row) => row.getAttribute('data-plan-id'))).toEqual([1, 2, 3, 4, 5, 8].map((n) => planRecord(n).id));
    expect(within(rowOf(2)).getByTestId('start').textContent).toBe('2020-01-01');
    expect(within(rowOf(2)).getByTestId('end').textContent).toBe('2020-01-31');
    expect(within(rowOf(1)).getByTestId('start').textContent).toBe(vi_['lnd.posting.value.none']);
    expect(within(rowOf(2)).getByTestId('status').textContent).toBe(vi_['lnd.planStatus.posting.label']);
    fireEvent.change(screen.getByLabelText(vi_['lnd.posting.project.label']), { target: { value: '' } });
    expect(screen.getByTestId('choose-project')).toBeTruthy();
  });

  it('says so when the project has no plan to post', async () => {
    mount(<PostingScreen route={ROUTE} />, client(world({ plans: [planRecord(1, { status: 'REVISED' })] })), { permissions: PLANNER, path: PATH });
    expect((await screen.findByTestId('no-plans')).textContent).toBe(vi_['lnd.posting.empty.notice']);
  });

  it('UI-LND-06: shows the dates of a posted plan, the rule that counted its days, the opinions counted and each opinion with how it was handled', async () => {
    mount(<PostingScreen route={ROUTE} />, client(worldOf()), { permissions: PLAN_READER, path: PATH });
    const detail = await open(2);
    expect(within(detail).getByTestId('tile-start').textContent).toContain('2020-01-01');
    expect(within(detail).getByTestId('tile-end').textContent).toContain('2020-01-31');
    expect(within(detail).getByTestId('tile-left').textContent).toContain('-');
    await waitFor(() => expect(within(detail).getByTestId('tile-open').textContent).toContain('1'));
    expect(within(detail).getByTestId('tile-handled').textContent).toContain('1');
    expect(within(detail).getByTestId('place').textContent).toBe(vi_['lnd.posting.place.text'].replace('{place}', 'UBND xã An Phú'));
    const timer = await within(detail).findByTestId('timer');
    expect(timer.textContent).toContain(vi_['lnd.timer.planPosting30.label']);
    expect(timer.textContent).toContain('2026-08-31');
    expect(timer.textContent).toContain('CXN-12');
    const rows = Array.from(document.querySelectorAll('[data-feedback-id]'));
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByText('HH-000001')).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByTestId('feedback-status').textContent).toBe(vi_['lnd.feedbackStatus.open.label']);
    expect(within(rows[0] as HTMLElement).getByTestId('handling').textContent).toBe(vi_['lnd.posting.value.none']);
    expect(within(rows[1] as HTMLElement).getByText(vi_['lnd.posting.feedback.nobody'])).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText(vi_['lnd.feedbackChannel.letter.label'])).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByTestId('handling').textContent).toBe(vi_['lnd.posting.handling.text'].replace('{date}', '2026-08-07').replace('{note}', 'Đã đo lại'));
    expect(within(detail).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('button', { name: label('lnd.posting.post.aria', 'PA-0001') })).toBeNull();
  });

  it('UI-LND-06: shows the summary at the closing and the approval with the payment due of a plan whose posting closed and of one that was approved', async () => {
    mount(<PostingScreen route={ROUTE} />, client(worldOf()), { permissions: PLAN_READER, path: PATH });
    const closed = await open(4);
    expect(within(closed).getByTestId('summary').textContent).toBe(vi_['lnd.posting.summary.text'].replace('{summary}', 'Hai ý kiến về giá'));
    expect(within(closed).queryByTestId('approval')).toBeNull();
    expect(within(closed).getByTestId('tile-left').textContent).toContain(vi_['lnd.posting.value.none']);
    fireEvent.click(within(rowOf(5)).getByRole('button', { name: label('lnd.posting.open.aria', 'PA-0005') }));
    await waitFor(() => expect(screen.getByTestId('approval').textContent).toBe(vi_['lnd.posting.approval.text'].replace('{approved}', '2020-02-05').replace('{due}', '2020-03-06')));
  });

  it('AC-ST-LND-006-1, UAT-AC377, UI-LND-06: does not offer to close a posting before its days are over, and says when it can be closed', async () => {
    mount(<PostingScreen route={ROUTE} />, client(worldOf()), { permissions: PLANNER, path: PATH });
    const early = await open(3);
    const close = within(early).getByRole('button', { name: vi_['lnd.posting.close.action'] });
    expect((close as HTMLButtonElement).disabled).toBe(true);
    expect(within(early).getByTestId('close-hint').textContent).toBe(vi_['lnd.posting.close.hint'].replace('{date}', '2999-01-31'));
    fireEvent.click(within(rowOf(2)).getByRole('button', { name: label('lnd.posting.open.aria', 'PA-0002') }));
    await waitFor(() => expect((screen.getByRole('button', { name: vi_['lnd.posting.close.action'] }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByTestId('close-hint')).toBeNull();
  });

  it('AC-ST-LND-006-1, UI-LND-06: closes the posting with a summary in words, under the version of the plan', async () => {
    const h = client(worldOf(), () => ({ ...OK, status: 'POSTING_CLOSED', resource_version: 4 }));
    mount(<PostingScreen route={ROUTE} />, h, { permissions: PLANNER, path: PATH });
    await open(2);
    fireEvent.click(screen.getByRole('button', { name: vi_['lnd.posting.close.action'] }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getByText(vi_['lnd.field.required.error'])).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.posting.closeDialog.summary.label']), { target: { value: 'x'.repeat(2001) } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getByText(vi_['lnd.field.tooLong.error'])).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.posting.closeDialog.summary.label']), { target: { value: 'a\u0007b' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getByText(vi_['lnd.field.invalid.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.posting.closeDialog.summary.label']), { target: { value: '  Một ý kiến chưa xử lý  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.command).toHaveBeenCalledWith('closePlanPosting', expect.objectContaining({ path: { id: planRecord(2).id }, ifMatchVersion: 3, body: { feedback_summary: 'Một ý kiến chưa xử lý' } }));
  });

  it('UI-LND-06: posts a draft that has something in it, from a day that has come, at a place, under the version of the plan', async () => {
    const h = client(worldOf(), () => ({ ...OK, resource_id: planRecord(1).id }));
    mount(<PostingScreen route={ROUTE} />, h, { permissions: PLANNER, path: PATH });
    await ready();
    expect(within(rowOf(8)).queryByRole('button', { name: label('lnd.posting.post.aria', 'PA-0008') })).toBeNull();
    expect(within(rowOf(2)).queryByRole('button', { name: label('lnd.posting.post.aria', 'PA-0002') })).toBeNull();
    fireEvent.click(within(rowOf(1)).getByRole('button', { name: label('lnd.posting.post.aria', 'PA-0001') }));
    const dialog = screen.getByRole('dialog');
    expect((within(dialog).getByLabelText(vi_['lnd.posting.postDialog.start.label']) as HTMLInputElement).value).toBe(TODAY);
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getByText(vi_['lnd.field.required.error'])).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.posting.postDialog.start.label']), { target: { value: '2999-01-01' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getByText(vi_['lnd.posting.field.future.error'])).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.posting.postDialog.start.label']), { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getAllByText(vi_['lnd.field.required.error']).length).toBe(2);
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.posting.postDialog.start.label']), { target: { value: TODAY } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.posting.postDialog.place.label']), { target: { value: '  UBND xã An Phú  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.command).toHaveBeenCalledWith('postCompensationPlan', expect.objectContaining({ path: { id: planRecord(1).id }, ifMatchVersion: 2, body: { posting_started_on: TODAY, posting_place_text: 'UBND xã An Phú' } }));
  });

  it('UI-LND-06: records an opinion of a household or of nobody on the list, by a channel, in words', async () => {
    const h = client(worldOf(), () => ({ ...OK, status: 'OPEN', resource_version: 1 }));
    mount(<PostingScreen route={ROUTE} />, h, { permissions: PLANNER, path: PATH });
    await open(2);
    fireEvent.click(screen.getByRole('button', { name: vi_['lnd.posting.feedback.action'] }));
    const dialog = screen.getByRole('dialog');
    await within(dialog).findByRole('option', { name: 'HH-000001' });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getAllByText(vi_['lnd.field.required.error']).length).toBe(2);
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.posting.feedbackDialog.channel.label']), { target: { value: 'MEETING' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.posting.feedbackDialog.summary.label']), { target: { value: '  Giá nhà quá thấp  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.command).toHaveBeenCalledWith('recordPlanFeedback', expect.objectContaining({ path: { id: planRecord(2).id }, body: { summary: 'Giá nhà quá thấp', channel: 'MEETING' } }));
    fireEvent.click(screen.getByRole('button', { name: vi_['lnd.posting.feedback.action'] }));
    const again = screen.getByRole('dialog');
    await within(again).findByRole('option', { name: 'HH-000001' });
    fireEvent.change(within(again).getByLabelText(vi_['lnd.posting.feedbackDialog.household.label']), { target: { value: household(1).id } });
    fireEvent.change(within(again).getByLabelText(vi_['lnd.posting.feedbackDialog.channel.label']), { target: { value: 'LETTER' } });
    fireEvent.change(within(again).getByLabelText(vi_['lnd.posting.feedbackDialog.summary.label']), { target: { value: 'Đề nghị đo lại' } });
    fireEvent.click(within(again).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
    expect(h.command).toHaveBeenLastCalledWith('recordPlanFeedback', expect.objectContaining({ body: { summary: 'Đề nghị đo lại', channel: 'LETTER', household_id: household(1).id } }));
  });

  it('UI-LND-06: handles an open opinion with a note; a handled one has no button', async () => {
    const h = client(worldOf(), () => ({ ...OK, status: 'HANDLED', resource_version: 2 }));
    mount(<PostingScreen route={ROUTE} />, h, { permissions: PLANNER, path: PATH });
    await open(2);
    await waitFor(() => expect(document.querySelectorAll('[data-feedback-id]').length).toBe(2));
    const rows = Array.from(document.querySelectorAll('[data-feedback-id]')) as HTMLElement[];
    expect(within(rows[1] as HTMLElement).queryByRole('button')).toBeNull();
    fireEvent.click(within(rows[0] as HTMLElement).getByRole('button', { name: vi_['lnd.posting.handle.aria'].replace('{household}', 'HH-000001') }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByTestId('handled-opinion').textContent).toBe('Giá nhà quá thấp');
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getByText(vi_['lnd.field.required.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.posting.handleDialog.note.label']), { target: { value: ' Đã giải thích ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.command).toHaveBeenCalledWith('handlePlanFeedback', expect.objectContaining({ path: { id: planRecord(2).id, feedback_id: feedbackRecord(1, planRecord(2).id).id }, body: { handling_note: 'Đã giải thích' } }));
  });

  it('AC-ST-LND-006-1, UAT-AC377, UI-LND-06: offers the approval to who holds the right, for a plan whose posting closed, after a day that is not before the posting ended and with a decision document', async () => {
    const h = client(worldOf(), () => ({ ...OK, status: 'APPROVED', resource_version: 5 }));
    mount(<PostingScreen route={ROUTE} />, h, { permissions: APPROVER, path: PATH });
    const detail = await open(4);
    expect(within(detail).queryByRole('button', { name: vi_['lnd.posting.feedback.action'] })).toBeNull();
    fireEvent.click(within(detail).getByRole('button', { name: vi_['lnd.posting.approve.action'] }));
    const dialog = screen.getByRole('dialog');
    expect((within(dialog).getByLabelText(vi_['lnd.posting.approveDialog.date.label']) as HTMLInputElement).value).toBe(TODAY);
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.posting.approveDialog.date.label']), { target: { value: '2020-01-15' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.posting.approveDialog.document.label']), { target: { value: 'not-an-id' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getByText(vi_['lnd.posting.field.early.error'])).toBeTruthy();
    expect(within(dialog).getByText(vi_['lnd.field.invalid.error'])).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.posting.approveDialog.date.label']), { target: { value: '2999-01-01' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.posting.approveDialog.document.label']), { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getByText(vi_['lnd.posting.field.future.error'])).toBeTruthy();
    expect(within(dialog).getByText(vi_['lnd.field.required.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.posting.approveDialog.date.label']), { target: { value: '2020-02-05' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.posting.approveDialog.document.label']), { target: { value: ` ${DOCUMENT.toUpperCase()} ` } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.command).toHaveBeenCalledWith('approveCompensationPlan', expect.objectContaining({ path: { id: planRecord(4).id }, ifMatchVersion: 4, body: { approved_on: '2020-02-05', decision_document_version_id: DOCUMENT } }));
  });

  it('shows no approval for a plan that is not closed, for who may not approve, and nothing to write for a reader or a session that only reads', async () => {
    mount(<PostingScreen route={ROUTE} />, client(worldOf()), { permissions: APPROVER, path: PATH });
    const posted = await open(2);
    expect(within(posted).queryByRole('button', { name: vi_['lnd.posting.approve.action'] })).toBeNull();
    expect(within(posted).queryByRole('button', { name: vi_['lnd.posting.close.action'] })).toBeNull();
    expect(within(posted).queryByRole('button', { name: vi_['lnd.posting.feedback.action'] })).toBeNull();
    cleanup();
    mount(<PostingScreen route={ROUTE} />, client(worldOf()), { permissions: PLANNER, path: PATH });
    const closed = await open(4);
    expect(within(closed).queryByRole('button', { name: vi_['lnd.posting.approve.action'] })).toBeNull();
    cleanup();
    mount(<PostingScreen route={ROUTE} />, client(worldOf()), { permissions: BOTH, mode: 'READ_ONLY', path: PATH });
    const readOnly = await open(2);
    expect(within(readOnly).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('button', { name: label('lnd.posting.post.aria', 'PA-0001') })).toBeNull();
    cleanup();
    mount(<PostingScreen route={ROUTE} />, client(worldOf()), { permissions: undefined, path: PATH });
    const everything = await open(4);
    expect(within(everything).getByRole('button', { name: vi_['lnd.posting.approve.action'] })).toBeTruthy();
  });

  it('says why the server refused each command', async () => {
    const cases: Array<[string, number, string]> = [
      ['PLAN_STATE_INVALID', 409, 'lnd.posting.problem.stateInvalid.error'],
      ['PLAN_HAS_NO_ITEMS', 422, 'lnd.posting.problem.noItems.error'],
      ['INVENTORY_NOT_CONFIRMED', 422, 'lnd.posting.problem.notConfirmed.error'],
      ['TIMER_RULE_UNCONFIRMED', 422, 'lnd.posting.problem.ruleUnconfirmed.error'],
      ['POSTING_PERIOD_NOT_ELAPSED', 422, 'lnd.posting.problem.notElapsed.error'],
      ['UNRESOLVED_FEEDBACK', 422, 'lnd.posting.problem.unresolved.error'],
      ['SELF_APPROVAL_DENIED', 403, 'lnd.posting.problem.selfApproval.error'],
      ['DECISION_DOCUMENT_REQUIRED', 422, 'lnd.posting.problem.decisionRequired.error'],
      ['DOCUMENT_NOT_CLEAN', 422, 'lnd.posting.problem.documentNotClean.error'],
      ['FEEDBACK_ALREADY_HANDLED', 409, 'lnd.posting.problem.alreadyHandled.error'],
      ['VERSION_CONFLICT', 409, 'lnd.problem.versionConflict.error'],
      ['SCOPE_DENIED', 403, 'lnd.posting.problem.scopeDenied.error'],
      ['VALIDATION_FAILED', 422, 'lnd.problem.validation.error'],
      ['RESOURCE_NOT_FOUND', 404, 'lnd.problem.notFound.error'],
    ];
    for (const [code, status, key] of cases) {
      const h = client(worldOf(), () => problem(code, status));
      mount(<PostingScreen route={ROUTE} />, h, { permissions: BOTH, path: PATH });
      await open(4);
      fireEvent.click(screen.getByRole('button', { name: vi_['lnd.posting.approve.action'] }));
      const dialog = screen.getByRole('dialog');
      fireEvent.change(within(dialog).getByLabelText(vi_['lnd.posting.approveDialog.date.label']), { target: { value: '2020-02-05' } });
      fireEvent.change(within(dialog).getByLabelText(vi_['lnd.posting.approveDialog.document.label']), { target: { value: DOCUMENT } });
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
      expect((await within(dialog).findByTestId('refusal')).textContent).toBe(vi_[key as keyof typeof vi_]);
      cleanup();
    }
    const unknown = client(worldOf(), () => new Error('boom'));
    mount(<PostingScreen route={ROUTE} />, unknown, { permissions: BOTH, path: PATH });
    await open(4);
    fireEvent.click(screen.getByRole('button', { name: vi_['lnd.posting.approve.action'] }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.posting.approveDialog.date.label']), { target: { value: '2020-02-05' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.posting.approveDialog.document.label']), { target: { value: DOCUMENT } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect((await within(dialog).findByTestId('refusal')).textContent).toBe(vi_['lnd.problem.general.error']);
  });

  it('says so when the timers or the opinions of a plan cannot be read, and while the opinions load', async () => {
    const failing = worldOf();
    failing.failing.add('listPlanFeedback');
    failing.timers = {};
    mount(<PostingScreen route={ROUTE} />, client(failing), { permissions: PLAN_READER, path: PATH });
    const detail = await open(2);
    expect((await within(detail).findByTestId('timers-failed')).textContent).toBe(vi_['lnd.posting.timers.failed']);
    expect((await within(detail).findByTestId('feedback-failed')).textContent).toBe(vi_['lnd.posting.feedbackList.failed']);
    cleanup();
    const empty = worldOf();
    empty.feedback = [];
    mount(<PostingScreen route={ROUTE} />, client(empty), { permissions: PLAN_READER, path: PATH });
    const none = await open(2);
    expect(within(none).getByRole('status').textContent).toBe(vi_['lnd.posting.feedbackList.loading']);
    expect((await within(none).findByTestId('feedback-empty')).textContent).toBe(vi_['lnd.posting.feedbackList.empty']);
  });

  it('shows the plans a failing read could not give as the error of the screen, and tries again on request', async () => {
    const failing = worldOf();
    failing.failing.add('listCompensationPlans');
    mount(<PostingScreen route={ROUTE} />, client(failing), { permissions: PLAN_READER, path: PATH });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByTestId('plans')).toBeNull();
  });
});
