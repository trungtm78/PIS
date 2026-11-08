import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import EarlyWarningRecordScreen from './EarlyWarningRecordScreen';
import { CLAIM, MEMBER, WARNER, WARNING, WARNING_READER, action, client, commandsOf, mount, readsOf, routeOf, text, uuid, warning } from './test/support';

afterEach(() => cleanup());

const route = routeOf('CTR-36');
const failure = (code: string, status = 409) => new ApiError({ status, code, correlationId: 'c', extensions: {} });

const open = (record: unknown = warning(), permissions: readonly string[] = WARNER, command?: (operation: string, input: unknown) => unknown) => {
  const h = client({ getContractEarlyWarning: record }, command);
  return { h, ...mount(<EarlyWarningRecordScreen route={route} />, h, permissions, `/?warning=${WARNING}`) };
};

const reasonField = (dialog: HTMLElement, key: string) => within(dialog).getByLabelText(new RegExp(text(key).slice(0, 8)));

describe('the early-warning record (CTR-36)', () => {
  it('asks for a warning when none is named', () => {
    const h = client({});
    mount(<EarlyWarningRecordScreen route={route} />, h, WARNER, '/');
    expect(screen.getByTestId('no-warning')).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });

  it('shows who raised the warning, the assessment with the expected impact, the actions and the status as a word', async () => {
    open();
    expect(await screen.findByRole('heading', { level: 1, name: 'EW-001 · The crane may arrive late' })).toBeTruthy();
    expect(screen.getByTestId('status').textContent).toBe(text('ctrWarn.status.mitigating.label'));
    const assessment = screen.getByTestId('assessment');
    expect(assessment.textContent).toContain('Pham Van D');
    expect(within(assessment).getByTestId('time').textContent).toBe(text('ctrWarn.record.days.text', { days: 14 }));
    expect(within(assessment).getByTestId('cost').textContent).toBe('250.000.000');
    expect(screen.getByText('Order the crane from the second supplier.')).toBeTruthy();
    expect(screen.getByTestId('action-status').getAttribute('data-status')).toBe('OPEN');
    expect(screen.getByTestId('no-reviews')).toBeTruthy();
  });

  it('says that a warning is not assessed, and that "no impact expected" is a statement and not a blank', async () => {
    open(warning({ status: 'RAISED', owner_name: null, owner_membership_id: null, likelihood: null, expected_time_days: null, expected_cost_vnd: null, actions: [], allowed: { assess: true, add_action: false, close: true } }));
    expect(await screen.findByTestId('unassessed')).toBeTruthy();
    expect(screen.queryByTestId('add-action-button')).toBeNull();
    cleanup();
    open(warning({ status: 'ASSESSED', expected_time_days: null, expected_cost_vnd: null, no_impact_expected: true }));
    const assessment = await screen.findByTestId('assessment');
    expect(within(assessment).getByTestId('time').textContent).toBe(text('ctrWarn.cell.noImpact.text'));
    expect(within(assessment).getByTestId('cost').textContent).toBe(text('ctrWarn.cell.noImpact.text'));
  });

  it('marks an action past its day with a word, and shows how an action ended', async () => {
    open(warning({ actions: [action({ overdue: true }), action({ id: uuid(71), status: 'DONE', done_on: '2026-11-07', done_by_name: 'Pham Van D', done_note: 'Ordered on the 7th' })] }));
    const statuses = await screen.findAllByTestId('action-status');
    expect(statuses[0]?.getAttribute('data-overdue')).toBe('true');
    expect(statuses[0]?.textContent).toBe(text('ctrWarn.action.overdue.label'));
    expect(statuses[1]?.textContent).toBe(text('ctrWarn.actionStatus.done.label'));
    expect(screen.getByText('Ordered on the 7th')).toBeTruthy();
    expect(screen.getAllByTestId('action-done')).toHaveLength(1);
  });

  it('shows the meetings that reviewed the warning, latest first', async () => {
    open(warning({ reviews: [{ meeting_id: uuid(80), held_on: '2026-11-05', outcome: 'ACTION_AGREED', note: 'Second supplier', status_at_meeting: 'ASSESSED' }] }));
    const reviews = await screen.findByTestId('reviews');
    expect(reviews.textContent).toContain(text('ctrWarn.review.actionAgreed.label'));
    expect(reviews.textContent).toContain('Second supplier');
  });

  it('assesses under the version it saw, with a person, a likelihood and a figure; a blank impact is refused before anything is sent', async () => {
    const { h } = open(warning({ status: 'RAISED', owner_name: null, owner_membership_id: null, likelihood: null, expected_time_days: null, expected_cost_vnd: null, actions: [], version: 1 }));
    fireEvent.click(await screen.findByTestId('assess-button'));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('option', { name: 'Pham Van D' });
    fireEvent.change(within(dialog).getByLabelText(text('ctrWarn.assessDialog.owner.label')), { target: { value: MEMBER } });
    fireEvent.change(within(dialog).getByLabelText(text('ctrWarn.assessDialog.likelihood.label')), { target: { value: 'HIGH' } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('ctrWarn.assessDialog.confirm.action') }));
    expect(await within(dialog).findByText(text('ctrReg.form.required.error'))).toBeTruthy();
    expect(commandsOf(h, 'assessContractEarlyWarning')).toHaveLength(0);
    fireEvent.change(within(dialog).getByLabelText(text('ctrWarn.assessDialog.timeDays.label')), { target: { value: '14' } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('ctrWarn.assessDialog.confirm.action') }));
    await waitFor(() => expect(commandsOf(h, 'assessContractEarlyWarning')).toHaveLength(1));
    expect(commandsOf(h, 'assessContractEarlyWarning')[0]).toMatchObject({ path: { id: WARNING }, ifMatchVersion: 1, body: { owner_membership_id: MEMBER, likelihood: 'HIGH', expected_time_days: 14 } });
  });

  it('agrees an action with a person and a day that is not in the past', async () => {
    const { h } = open();
    fireEvent.click(await screen.findByTestId('add-action-button'));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('option', { name: 'Pham Van D' });
    fireEvent.change(within(dialog).getByLabelText(text('ctrWarn.actionDialog.description.label')), { target: { value: 'Agree a revised foundation sequence.' } });
    fireEvent.change(within(dialog).getByLabelText(text('ctrWarn.actionDialog.dueOn.label')), { target: { value: '2020-01-01' } });
    fireEvent.change(within(dialog).getByLabelText(text('ctrWarn.actionDialog.owner.label')), { target: { value: MEMBER } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('ctrWarn.actionDialog.confirm.action') }));
    expect(await within(dialog).findByText(text('ctrReg.form.invalidDay.error'))).toBeTruthy();
    expect(commandsOf(h, 'addContractEarlyWarningAction')).toHaveLength(0);
    fireEvent.change(within(dialog).getByLabelText(text('ctrWarn.actionDialog.dueOn.label')), { target: { value: '2999-01-01' } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('ctrWarn.actionDialog.confirm.action') }));
    await waitFor(() => expect(commandsOf(h, 'addContractEarlyWarningAction')).toHaveLength(1));
    expect(commandsOf(h, 'addContractEarlyWarningAction')[0]).toMatchObject({ path: { id: WARNING }, body: { owner_membership_id: MEMBER, due_on: '2999-01-01' } });
  });

  it('ends an action with words, under the version of the action', async () => {
    const { h } = open(warning({ actions: [action({ version: 4 })] }));
    fireEvent.click(await screen.findByTestId('action-done'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(reasonField(dialog, 'ctrWarn.completeDialog.note.label'), { target: { value: 'The crane was ordered on the 7th' } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('ctrWarn.completeDialog.done.action') }));
    await waitFor(() => expect(commandsOf(h, 'completeContractEarlyWarningAction')).toHaveLength(1));
    expect(commandsOf(h, 'completeContractEarlyWarningAction')[0]).toMatchObject({ path: { id: uuid(70) }, ifMatchVersion: 4, body: { outcome: 'DONE', note: 'The crane was ordered on the 7th' } });
  });

  it('warns before a resolution that an action is still open and that the person who answers for the warning cannot close it; the server refusal is shown too', async () => {
    const { h } = open(warning(), WARNER, () => failure('EARLY_WARNING_ACTIONS_OPEN'));
    fireEvent.click(await screen.findByTestId('close-button'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('actions-open-note').textContent).toBe(text('ctrWarn.closeDialog.actionsOpen.text', { count: 1 }));
    expect(within(dialog).getByTestId('four-eyes-note').textContent).toBe(text('ctrWarn.closeDialog.fourEyes.text'));
    fireEvent.change(reasonField(dialog, 'ctrWarn.closeDialog.reason.label'), { target: { value: 'The second supplier delivered on time.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('ctrWarn.closeDialog.confirm.action') }));
    expect(await within(dialog).findByText(text('ctrReg.problem.actionsOpen.error'))).toBeTruthy();
    expect(commandsOf(h, 'closeContractEarlyWarning')[0]).toMatchObject({ path: { id: WARNING }, ifMatchVersion: 3, body: { outcome: 'RESOLVED' } });
  });

  it('says in words that the person who answers for the warning may not close it as resolved', async () => {
    open(warning({ actions: [] }), WARNER, () => failure('SELF_APPROVAL_DENIED', 403));
    fireEvent.click(await screen.findByTestId('close-button'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(reasonField(dialog, 'ctrWarn.closeDialog.reason.label'), { target: { value: 'The second supplier delivered on time.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('ctrWarn.closeDialog.confirm.action') }));
    expect(await within(dialog).findByText(text('ctrReg.problem.selfApproval.error'))).toBeTruthy();
  });

  it('closes a warning that came true only with the change order or the claim it became', async () => {
    const { h } = open(warning({ actions: [] }));
    fireEvent.click(await screen.findByTestId('close-button'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(text('ctrWarn.closeDialog.outcome.label')), { target: { value: 'MATERIALISED' } });
    fireEvent.change(within(dialog).getByLabelText(text('ctrWarn.closeDialog.into.label')), { target: { value: 'CLAIM' } });
    fireEvent.change(reasonField(dialog, 'ctrWarn.closeDialog.reason.label'), { target: { value: 'The delay happened and a claim followed.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('ctrWarn.closeDialog.confirm.action') }));
    expect(await within(dialog).findByText(text('ctrReg.form.invalidId.error'))).toBeTruthy();
    expect(commandsOf(h, 'closeContractEarlyWarning')).toHaveLength(0);
    fireEvent.change(within(dialog).getByLabelText(text('ctrWarn.closeDialog.materialisedId.label')), { target: { value: CLAIM } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('ctrWarn.closeDialog.confirm.action') }));
    await waitFor(() => expect(commandsOf(h, 'closeContractEarlyWarning')).toHaveLength(1));
    expect(commandsOf(h, 'closeContractEarlyWarning')[0]?.body).toEqual({ outcome: 'MATERIALISED', reason: 'The delay happened and a claim followed.', materialised_into: 'CLAIM', materialised_id: CLAIM });
  });

  it('shows how a closed warning ended and offers no command on it', async () => {
    open(warning({ status: 'CLOSED_MATERIALISED', claim_id: CLAIM, closed_by_name: 'Tran Van C', closed_at: '2026-11-07T03:00:00.000Z', closed_reason: 'The delay happened and a claim followed.', allowed: { assess: false, add_action: false, close: false } }));
    const closure = await screen.findByTestId('closure');
    expect(closure.textContent).toContain('Tran Van C');
    expect(within(closure).getByRole('link', { name: CLAIM }).getAttribute('href')).toBe(`/ctr/ctr-33?claim=${CLAIM}`);
    expect(screen.queryByTestId('close-button')).toBeNull();
    expect(screen.queryByTestId('assess-button')).toBeNull();
  });

  it('keeps the commands from a reader', async () => {
    open(warning(), WARNING_READER);
    await screen.findByTestId('assessment');
    expect(screen.queryByTestId('assess-button')).toBeNull();
    expect(screen.queryByTestId('add-action-button')).toBeNull();
    expect(screen.queryByTestId('close-button')).toBeNull();
    expect(screen.queryByTestId('action-done')).toBeNull();
  });

  it('offers a reload when somebody changed the warning meanwhile, and reads again', async () => {
    const { h } = open(warning({ actions: [] }), WARNER, () => failure('VERSION_CONFLICT'));
    fireEvent.click(await screen.findByTestId('close-button'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(reasonField(dialog, 'ctrWarn.closeDialog.reason.label'), { target: { value: 'The second supplier delivered on time.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('ctrWarn.closeDialog.confirm.action') }));
    fireEvent.click(await within(dialog).findByRole('button', { name: text('ctrReg.problem.reload.action') }));
    await waitFor(() => expect(readsOf(h, 'getContractEarlyWarning').length).toBeGreaterThan(1));
  });

  it('shows a skeleton while it reads and says why it could not: an error with a retry and a refusal as denied', async () => {
    const waiting = client({ getContractEarlyWarning: () => new Promise(() => undefined) });
    mount(<EarlyWarningRecordScreen route={route} />, waiting, WARNER, `/?warning=${WARNING}`);
    expect(screen.getByRole('status', { name: text('states.loading.label') })).toBeTruthy();
    cleanup();
    const broken = client({ getContractEarlyWarning: new Error('boom') });
    mount(<EarlyWarningRecordScreen route={route} />, broken, WARNER, `/?warning=${WARNING}`);
    expect(await screen.findByRole('button', { name: text('states.retry.action') })).toBeTruthy();
    cleanup();
    const denied = client({ getContractEarlyWarning: failure('SCOPE_DENIED', 403) });
    mount(<EarlyWarningRecordScreen route={route} />, denied, WARNER, `/?warning=${WARNING}`);
    expect(await screen.findByText(text('states.denied.title'))).toBeTruthy();
  });
});
