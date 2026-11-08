import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import ClaimRecordScreen from './ClaimRecordScreen';
import { CLAIM, CONTRACT, MANAGER, READER, claim, client, commandsOf, deadline, limitation, mount, readsOf, routeOf, step, text, uuid } from './test/support';

afterEach(() => cleanup());

const route = routeOf('CTR-33');
const failure = (code: string, status = 409, detail?: string) => new ApiError({ status, code, correlationId: 'c', extensions: {}, ...(detail === undefined ? {} : { detail }) });

const open = (record: unknown = claim(), permissions: readonly string[] = MANAGER, command?: (operation: string, input: unknown) => unknown) => {
  const h = client({ getClaim: record }, command);
  return { h, ...mount(<ClaimRecordScreen route={route} />, h, permissions, `/?claim=${CLAIM}`) };
};

const dialogOf = async () => screen.findByRole('dialog');
const noteField = (dialog: HTMLElement, key: string) => within(dialog).getByLabelText(new RegExp(text(key).slice(0, 12)));

describe('the claim record (CTR-33)', () => {
  it('asks for a claim when none is named in the address', () => {
    const h = client({});
    mount(<ClaimRecordScreen route={route} />, h, MANAGER, '/');
    expect(screen.getByTestId('no-claim')).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });

  it('shows the claim with the term that gives its clocks, the four clocks with a state and a day each, and an "i" on every due day', async () => {
    open();
    expect(await screen.findByRole('heading', { level: 1, name: 'CLM-001 · Late handover of the site' })).toBeTruthy();
    expect(screen.getByTestId('term').textContent).toContain('Clause 20.1 of the contract');
    expect(screen.getByTestId('claimed').textContent).toContain('500.000.000');
    const notice = screen.getByTestId('clock-notice');
    expect(notice.getAttribute('data-state')).toBe('RUNNING');
    expect(within(notice).getByTestId('due').textContent).toContain('01/12/2026');
    expect(within(notice).getByRole('button', { name: text('ctrReg.info.open.label', { name: text('ctrClaim.deadline.notice.label') }) })).toBeTruthy();
    // A clock that has not started has no day and no "i": nothing is guessed.
    const particulars = screen.getByTestId('clock-particulars');
    expect(particulars.getAttribute('data-state')).toBe('NOT_STARTED');
    expect(within(particulars).getByTestId('due').textContent).toBe('–');
    expect(within(screen.getByTestId('clock-response')).getByText(`${text('ctrClaim.owedBy.receiver.label')} · ${text('ctrClaim.clock.owedByOwner.text')}`)).toBeTruthy();
    fireEvent.click(within(notice).getByRole('button', { name: text('ctrReg.info.open.label', { name: text('ctrClaim.deadline.notice.label') }) }));
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText(text('ctrClaim.figure.deadline.formula'))).toBeTruthy();
    expect(within(panel).getByText(text('ctrClaim.figure.deadline.source', { clause: 'Clause 20.1 of the contract' }))).toBeTruthy();
  });

  it('shows a claim without an approved term with no clock at all and a way to propose one', async () => {
    const none = (code: string) => deadline(code, { state: 'NOT_DEFINED', started_on: null, due_on: null, days_left: null, period_days: null, basis: null });
    open(
      claim({
        term: null,
        deadlines: { NOTICE: none('NOTICE'), PARTICULARS: none('PARTICULARS'), RESPONSE: none('RESPONSE'), SETTLEMENT: none('SETTLEMENT') },
        limitation: limitation({ status: 'NO_TERM', due_on: null, code: null, days_left: null, bar_effect: null }),
      }),
    );
    expect(await screen.findByTestId('no-term')).toBeTruthy();
    expect(screen.getAllByText(text('ctrClaim.clock.notDefined.text'))).toHaveLength(4);
    expect(screen.getByRole('link', { name: text('ctrClaim.record.term.propose.action') }).getAttribute('href')).toBe(`/ctr/ctr-34?contract=${CONTRACT}`);
    expect(within(screen.getByTestId('limitation')).getByText('–')).toBeTruthy();
  });

  it('says that a working-day clock cannot be given when the calendar is not published, and gives no day', async () => {
    open(
      claim({
        calendar_published: false,
        deadlines: { ...claim().deadlines, NOTICE: deadline('NOTICE', { state: 'CALENDAR_UNAVAILABLE', due_on: null, days_left: null, basis: 'WORKING_DAYS' }) },
        limitation: limitation({ status: 'CALENDAR_UNAVAILABLE', due_on: null, code: null, days_left: null }),
      }),
    );
    expect(await screen.findByTestId('calendar-notice')).toBeTruthy();
    const notice = screen.getByTestId('clock-notice');
    expect(within(notice).getByText(text('ctrClaim.clock.calendar.text'))).toBeTruthy();
    expect(within(notice).getByTestId('due').textContent).toBe('–');
  });

  it('shows the days past a missed day, and the timeline in order with a system step as its label and not as a technical note', async () => {
    open(
      claim({
        deadlines: { ...claim().deadlines, NOTICE: deadline('NOTICE', { state: 'MISSED', days_left: -4 }) },
        limitation: limitation({ status: 'MISSED', days_left: -4, missed: ['NOTICE'] }),
        steps: [step(1, 'EVENT'), step(2, 'TERM_BOUND', { note: 'The approved term of the contract was bound to the claim.' }), step(3, 'RESPONSE', { decision: 'REJECTED', note: 'Rejected in writing' })],
      }),
    );
    const notice = await screen.findByTestId('clock-notice');
    expect(within(notice).getByText(text('ctrClaim.clock.daysPast.text', { days: 4 }))).toBeTruthy();
    const items = within(screen.getByTestId('timeline')).getAllByRole('listitem');
    expect(items.map((item) => item.getAttribute('data-step'))).toEqual(['EVENT', 'TERM_BOUND', 'RESPONSE']);
    expect(items[1]?.textContent).toContain(text('ctrClaim.record.timeline.termBound.text'));
    expect(items[1]?.textContent).not.toContain('The approved term of the contract was bound');
    expect(items[2]?.textContent).toContain(text('ctrClaim.decision.rejected.label'));
  });

  it('offers only the steps the server says may be taken, and only to the person who holds the right', async () => {
    open();
    expect(await screen.findByTestId('step-notice')).toBeTruthy();
    expect(screen.getByTestId('step-withdrawal')).toBeTruthy();
    expect(screen.queryByTestId('step-particulars')).toBeNull();
    expect(screen.queryByTestId('settlement-approve')).toBeNull();
    expect(screen.queryByTestId('bar-button')).toBeNull();
    cleanup();
    open(claim(), READER);
    await screen.findByTestId('actions');
    expect(screen.queryByTestId('step-notice')).toBeNull();
    expect(screen.queryByTestId('links-button')).toBeNull();
  });

  it('records a notice on the day it was served, under the version it saw; a day before awareness is refused before anything is sent', async () => {
    const { h } = open();
    fireEvent.click(await screen.findByTestId('step-notice'));
    const dialog = await dialogOf();
    fireEvent.change(within(dialog).getByLabelText(text('ctrClaim.stepDialog.occurredOn.label')), { target: { value: '2026-11-01' } });
    fireEvent.change(noteField(dialog, 'ctrClaim.stepDialog.note.label'), { target: { value: 'Notice served by registered letter' } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('ctrClaim.stepDialog.confirm.action') }));
    expect(await within(dialog).findByText(text('ctrReg.form.invalidDay.error'))).toBeTruthy();
    expect(commandsOf(h, 'recordClaimStep')).toHaveLength(0);
    fireEvent.change(within(dialog).getByLabelText(text('ctrClaim.stepDialog.occurredOn.label')), { target: { value: '2026-11-04' } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('ctrClaim.stepDialog.confirm.action') }));
    await waitFor(() => expect(commandsOf(h, 'recordClaimStep')).toHaveLength(1));
    const sent = commandsOf(h, 'recordClaimStep')[0];
    expect(sent).toMatchObject({ path: { id: CLAIM }, ifMatchVersion: 1, body: { kind: 'NOTICE', occurred_on: '2026-11-04', note: 'Notice served by registered letter' } });
    expect(await screen.findByTestId('receipt')).toBeTruthy();
  });

  it('asks which way a response decided before it is recorded', async () => {
    const { h } = open(claim({ allowed: { steps: ['RESPONSE'], decide_settlement: false, declare_bar: false, link: true } }));
    fireEvent.click(await screen.findByTestId('step-response'));
    const dialog = await dialogOf();
    fireEvent.change(noteField(dialog, 'ctrClaim.stepDialog.note.label'), { target: { value: 'The engineer answered in writing' } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('ctrClaim.stepDialog.confirm.action') }));
    expect(await within(dialog).findByText(text('ctrReg.form.pickOne.error'))).toBeTruthy();
    expect(commandsOf(h, 'recordClaimStep')).toHaveLength(0);
  });

  it('shows who proposed a settlement and that somebody else approves it; a refusal for the same person is said in the dialog and nothing changes', async () => {
    const proposed = claim({ status: 'SETTLEMENT_PROPOSED', settlement_proposed_by_name: 'Nguyen Van A', settled_amount_vnd: '300000000', granted_days: 10, allowed: { steps: [], decide_settlement: true, declare_bar: false, link: true }, version: 6 });
    const { h } = open(proposed, MANAGER, () => failure('SELF_APPROVAL_DENIED', 403));
    expect(await screen.findByTestId('proposed-by')).toBeTruthy();
    fireEvent.click(screen.getByTestId('settlement-approve'));
    const dialog = await dialogOf();
    expect(within(dialog).getByTestId('four-eyes-note').textContent).toBe(text('ctrClaim.settlementDialog.fourEyes.text'));
    expect(within(dialog).getByText('Nguyen Van A')).toBeTruthy();
    fireEvent.change(noteField(dialog, 'ctrClaim.settlementDialog.note.label'), { target: { value: 'Checked against the response' } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('ctrClaim.settlementDialog.approve.action') }));
    expect(await within(dialog).findByText(text('ctrReg.problem.selfApproval.error'))).toBeTruthy();
    expect(commandsOf(h, 'decideClaimSettlement')[0]).toMatchObject({ path: { id: CLAIM }, ifMatchVersion: 6, body: { decision: 'APPROVE', note: 'Checked against the response' } });
    expect(screen.queryByTestId('receipt')).toBeNull();
  });

  it('says why a bar was refused and shows the four-eyes rule for the one who registered the claim', async () => {
    const missed = claim({ limitation: limitation({ status: 'MISSED', days_left: -3, missed: ['NOTICE'] }), allowed: { steps: ['NOTICE'], decide_settlement: false, declare_bar: true, link: true } });
    open(missed, MANAGER, () => failure('CLAIM_BAR_NOT_DUE'));
    fireEvent.click(await screen.findByTestId('bar-button'));
    const dialog = await dialogOf();
    expect(within(dialog).getByTestId('four-eyes-note').textContent).toBe(text('ctrClaim.barDialog.fourEyes.text'));
    fireEvent.change(noteField(dialog, 'ctrClaim.barDialog.reason.label'), { target: { value: 'The notice day passed under clause 20.1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('ctrClaim.barDialog.confirm.action') }));
    expect(await within(dialog).findByText(text('ctrReg.problem.barNotDue.error'))).toBeTruthy();
  });

  it('offers a reload when somebody changed the claim meanwhile, and reads again', async () => {
    const { h } = open(claim(), MANAGER, () => failure('VERSION_CONFLICT'));
    fireEvent.click(await screen.findByTestId('step-withdrawal'));
    const dialog = await dialogOf();
    fireEvent.change(noteField(dialog, 'ctrClaim.stepDialog.note.label'), { target: { value: 'Withdrawn by the contractor' } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('ctrClaim.stepDialog.confirm.action') }));
    fireEvent.click(await within(dialog).findByRole('button', { name: text('ctrReg.problem.reload.action') }));
    await waitFor(() => expect(readsOf(h, 'getClaim').length).toBeGreaterThan(1));
  });

  it('links a change order and a payment by identifier and refuses an identifier that is not one', async () => {
    const { h } = open();
    fireEvent.click(await screen.findByTestId('links-button'));
    const dialog = await dialogOf();
    fireEvent.change(within(dialog).getByLabelText(text('ctrClaim.linksDialog.change.label')), { target: { value: 'not-an-id' } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('ctrClaim.linksDialog.confirm.action') }));
    expect(await within(dialog).findByText(text('ctrReg.form.invalidId.error'))).toBeTruthy();
    expect(commandsOf(h, 'linkClaim')).toHaveLength(0);
    fireEvent.change(within(dialog).getByLabelText(text('ctrClaim.linksDialog.change.label')), { target: { value: uuid(77) } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('ctrClaim.linksDialog.confirm.action') }));
    await waitFor(() => expect(commandsOf(h, 'linkClaim')).toHaveLength(1));
    expect(commandsOf(h, 'linkClaim')[0]).toMatchObject({ path: { id: CLAIM }, ifMatchVersion: 1, body: { change_request_id: uuid(77) } });
  });

  it('shows the linked change order and payment', async () => {
    open(claim({ change_request: { id: uuid(77), code: 'CR-001' }, payment_request: { id: uuid(78), status: 'SUBMITTED', gross_vnd: '300000000', net_vnd: '290000000' } }));
    const links = await screen.findByTestId('links');
    expect(links.textContent).toContain('CR-001');
    expect(links.textContent).toContain('300.000.000');
  });

  it('shows a skeleton while it reads and says why it could not: an error with a retry and a refusal as denied', async () => {
    const waiting = client({ getClaim: () => new Promise(() => undefined) });
    mount(<ClaimRecordScreen route={route} />, waiting, MANAGER, `/?claim=${CLAIM}`);
    expect(screen.getByRole('status', { name: text('states.loading.label') })).toBeTruthy();
    cleanup();
    const broken = client({ getClaim: new Error('boom') });
    mount(<ClaimRecordScreen route={route} />, broken, MANAGER, `/?claim=${CLAIM}`);
    expect(await screen.findByRole('button', { name: text('states.retry.action') })).toBeTruthy();
    cleanup();
    const denied = client({ getClaim: failure('SCOPE_DENIED', 403) });
    mount(<ClaimRecordScreen route={route} />, denied, MANAGER, `/?claim=${CLAIM}`);
    expect(await screen.findByText(text('states.denied.title'))).toBeTruthy();
  });
});
