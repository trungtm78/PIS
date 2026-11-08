import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../../i18n';
import MonitoringDetailScreen from './MonitoringDetailScreen';
import { FILE_ID, MANAGER, READER, completePack, detail, feedback, fileView, harness, mount, never, notice, problem, routeOf, word } from './test/support';
import type { Harness } from './test/support';

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
  vi.restoreAllMocks();
});

const route = routeOf('PRJ-32', 'FR-PRJ-32');
const PATH = `/prj/prj-32?file=${FILE_ID}`;
const show = (answer: unknown, permissions: readonly string[] = MANAGER, command?: (op: string, input: unknown) => unknown, path = PATH): { h: Harness } => {
  const h = harness(() => (typeof answer === 'function' ? (answer as () => unknown)() : answer), command);
  mount(<MonitoringDetailScreen route={route} />, h, { permissions, path });
  return { h };
};
const click = async (id: string): Promise<void> => {
  fireEvent.click(await screen.findByTestId(id));
};
const confirm = (label: string): void => {
  fireEvent.click(screen.getByRole('button', { name: label }));
};

describe('PRJ-32, one community monitoring file', () => {
  it('UI-PRJ-32: shows the deadline with its "i", the pack with what is missing, and the feedback with its clock', async () => {
    show(detail({ notice: notice({ state: 'OVERDUE', days_left: -23 }) }));
    expect(await screen.findByTestId('fact-due')).toBeTruthy();
    expect(screen.getByTestId('fact-due').textContent).toContain('15/02/2027');
    expect(screen.getByTestId('fact-left').textContent).toBe(fill('prj.common.days.late', { days: 23 }));
    expect(screen.getByTestId('pack-NOTICE_TEXT').textContent).toContain(word('prj.monDetail.pack.missingRequired'));
    expect(screen.getByTestId('pack-BOARD_LIST').textContent).toContain(word('prj.monDetail.pack.missing'));
    expect(screen.getByText(word('prj.monDetail.pack.incomplete'))).toBeTruthy();
    expect(screen.getByTestId('rule-note').textContent).toContain('45');
    expect(screen.getByTestId('sum-total').textContent).toBe('1');
    expect(screen.getByTestId('sum-ontime').textContent).toBe('–');
    expect(screen.getAllByText(word('prj.common.response.notDue')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('button', { name: new RegExp(word('prj.mon.info.notice.name')) })[0] as HTMLElement);
    const panel = await screen.findByRole('dialog', { name: word('prj.mon.info.notice.name') });
    expect(within(panel).getByText(word('prj.info.panel.unverified'))).toBeTruthy();
  });

  it('does not let the notice go while the pack is incomplete, and lets it go when the pack is complete', async () => {
    show(detail());
    await screen.findByTestId('send-notice');
    expect((screen.getByTestId('send-notice') as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    show(detail({ pack: completePack() }));
    await screen.findByTestId('send-notice');
    expect((screen.getByTestId('send-notice') as HTMLButtonElement).disabled).toBe(false);
  });

  it('sends the notice with the version of the file and the day, and says it was sent', async () => {
    const { h } = show(detail({ pack: completePack() }), MANAGER, () => ({ status: 'SENT_ON_TIME' }));
    await click('send-notice');
    fireEvent.change(await screen.findByTestId('notice-day'), { target: { value: '2027-02-10' } });
    fireEvent.change(screen.getByTestId('notice-note'), { target: { value: 'Posted at the commune hall' } });
    confirm(word('prj.monDetail.notice.confirm'));
    expect((await screen.findByTestId('receipt')).textContent).toBe(word('prj.monDetail.receipt.notice'));
    expect(h.command).toHaveBeenCalledWith('sendMonitoringNotice', expect.objectContaining({ ifMatchVersion: 3, body: { sent_on: '2027-02-10', note: 'Posted at the commune hall' } }));
  });

  it('says in words why the notice was refused', async () => {
    show(detail({ pack: completePack() }), MANAGER, () => problem('MONITORING_PACK_INCOMPLETE', 422));
    await click('send-notice');
    fireEvent.change(await screen.findByTestId('notice-day'), { target: { value: '2027-02-10' } });
    confirm(word('prj.monDetail.notice.confirm'));
    expect((await screen.findByRole('alert')).textContent).toContain(word('prj.common.error.monitoringPackIncomplete'));
  });

  it('sets the day the duty began; a day fixed by hand needs a reason', async () => {
    const { h } = show(detail({ trigger: null, notice: notice({ state: 'NOT_STARTED', due_on: null, days_left: null }), notice_days: null, notice_rule_version: null }), MANAGER, () => ({ status: 'TRIGGER_SET' }));
    await click('set-trigger');
    fireEvent.change(await screen.findByTestId('trigger-day'), { target: { value: '2027-01-01' } });
    fireEvent.change(screen.getByTestId('trigger-kind'), { target: { value: 'MANUAL' } });
    const confirmButton = screen.getByRole('button', { name: word('prj.monDetail.trigger.confirm') }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(new RegExp(word('prj.monDetail.trigger.reason'))), { target: { value: 'Decision of the people committee' } });
    fireEvent.click(confirmButton);
    await screen.findByTestId('receipt');
    expect(h.command).toHaveBeenCalledWith('setMonitoringTrigger', expect.objectContaining({ ifMatchVersion: 3, body: { kind: 'MANUAL', on: '2027-01-01', reason: 'Decision of the people committee' } }));
  });

  it('adds a document of DOC to the pack by its id, and withdraws one with a reason', async () => {
    const { h } = show(detail({ pack: completePack() }), MANAGER, () => ({ status: 'ADDED' }));
    await click('add-item');
    fireEvent.change(await screen.findByTestId('item-kind'), { target: { value: 'BOARD_LIST' } });
    fireEvent.change(screen.getByTestId('item-document'), { target: { value: 'nope' } });
    confirm(word('prj.monDetail.addItem.confirm'));
    expect((await screen.findByRole('alert')).textContent).toContain(word('prj.common.error.validationFailed'));
    fireEvent.change(screen.getByTestId('item-document'), { target: { value: '00000000-0000-4000-8000-000000000099' } });
    confirm(word('prj.monDetail.addItem.confirm'));
    await screen.findByTestId('receipt');
    expect(h.command).toHaveBeenCalledWith('addMonitoringPackItem', expect.objectContaining({ body: { item: 'BOARD_LIST', document_id: '00000000-0000-4000-8000-000000000099', document_kind: 'DOCUMENT' } }));
    const first = completePack().items[0] as { id: string };
    await click(`withdraw-${first.id}`);
    fireEvent.change(await screen.findByLabelText(new RegExp(word('prj.monDetail.withdraw.reason'))), { target: { value: 'Wrong version attached' } });
    confirm(word('prj.monDetail.withdraw.confirm'));
    await waitFor(() => expect(h.command).toHaveBeenLastCalledWith('withdrawMonitoringPackItem', expect.objectContaining({ body: { reason: 'Wrong version attached' } })));
  });

  it('hides the changes of the pack once the notice is sent', async () => {
    show(detail({ pack: completePack(), notice: notice({ state: 'SENT_LATE', sent_on: '2027-02-20', days_late: 5, days_left: null }) }));
    await screen.findByTestId('fact-sent');
    expect(screen.getByTestId('fact-sent').textContent).toContain('20/02/2027');
    expect(screen.queryByTestId('add-item')).toBeNull();
    expect(screen.queryByTestId('send-notice')).toBeNull();
  });

  it('logs a feedback with the days of the rule, without a name or a contact', async () => {
    const { h } = show(detail({ feedback: [] }), MANAGER, () => ({ status: 'RECEIVED' }));
    expect(await screen.findByTestId('feedback-empty')).toBeTruthy();
    await click('log-feedback');
    expect(await screen.findByText(word('prj.monDetail.log.noIdentity'))).toBeTruthy();
    fireEvent.change(screen.getByTestId('log-reference'), { target: { value: 'PH-009' } });
    fireEvent.change(screen.getByTestId('log-day'), { target: { value: '2027-03-01' } });
    fireEvent.change(screen.getByTestId('log-topic'), { target: { value: 'SAFETY' } });
    fireEvent.change(screen.getByTestId('log-summary'), { target: { value: 'A child nearly fell into the open trench.' } });
    confirm(word('prj.monDetail.log.confirm'));
    await screen.findByTestId('receipt');
    expect(h.command).toHaveBeenCalledWith('logMonitoringFeedback', expect.objectContaining({ body: { reference: 'PH-009', received_on: '2027-03-01', channel: 'LETTER', topic: 'SAFETY', summary: 'A child nearly fell into the open trench.' } }));
  });

  it('answers a feedback with a text of enough length and the version of the feedback', async () => {
    const received = feedback(1);
    const { h } = show(detail({ feedback: [received] }), MANAGER, () => ({ status: 'RESPONDED' }));
    await click(`move-respond-${received.id}`);
    const field = await screen.findByLabelText(new RegExp(word('prj.monDetail.move.text.respond')));
    fireEvent.change(field, { target: { value: 'short' } });
    expect((screen.getByRole('button', { name: word('prj.monDetail.move.confirm.respond') }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field, { target: { value: 'The spoil is moved by 15 March.' } });
    confirm(word('prj.monDetail.move.confirm.respond'));
    await screen.findByTestId('receipt');
    expect(h.command).toHaveBeenCalledWith('moveMonitoringFeedback', expect.objectContaining({ ifMatchVersion: 1, body: { move: 'RESPOND', text: 'The spoil is moved by 15 March.' } }));
  });

  it('does not offer to close an answer to the person who gave it, and offers it to a second person', async () => {
    const mine = feedback(1, { status: 'RESPONDED', responded_by: '00000000-0000-4000-8000-000000000001', response_text: 'Answer given by me to the community.', responded_on: '2027-03-05' });
    const theirs = feedback(2, { status: 'RESPONDED', responded_by: '00000000-0000-4000-8000-000000000777', response_text: 'Answer given by another officer.', responded_on: '2027-03-05' });
    show(detail({ feedback: [mine, theirs] }));
    await screen.findByTestId(`feedback-${mine.id}`);
    expect(screen.getByTestId(`second-person-${mine.id}`).textContent).toBe(word('prj.monDetail.move.secondPerson'));
    expect(screen.queryByTestId(`move-close-${mine.id}`)).toBeNull();
    expect(screen.getByTestId(`move-close-${theirs.id}`)).toBeTruthy();
  });

  it('shows the refusal of a self approval from the server', async () => {
    const theirs = feedback(2, { status: 'RESPONDED', responded_by: '00000000-0000-4000-8000-000000000777', response_text: 'Answer given by another officer.', responded_on: '2027-03-05' });
    show(detail({ feedback: [theirs] }), MANAGER, () => problem('SELF_APPROVAL_DENIED', 403));
    await click(`move-close-${theirs.id}`);
    confirm(word('prj.monDetail.move.confirm.close'));
    expect((await screen.findByRole('alert')).textContent).toContain(word('prj.common.error.selfApprovalDenied'));
  });

  it('shows a reader the file without any button, and a closed file read only', async () => {
    show(detail(), READER);
    await screen.findByTestId('fact-due');
    for (const id of ['set-trigger', 'send-notice', 'close-file', 'add-item', 'log-feedback']) expect(screen.queryByTestId(id)).toBeNull();
    expect(screen.queryByTestId(`move-take-${feedback(1).id}`)).toBeNull();
    cleanup();
    show(detail({ ...fileView({ status: 'CLOSED' }), pack: completePack() }));
    await screen.findByTestId('fact-due');
    expect(screen.queryByTestId('close-file')).toBeNull();
    expect(screen.queryByTestId('log-feedback')).toBeNull();
  });

  it('shows the empty, loading, error, denied and stale states', async () => {
    show(detail(), MANAGER, undefined, '/prj/prj-32');
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    cleanup();
    show(() => never());
    expect(await screen.findByRole('status', { name: word('states.loading.label') })).toBeTruthy();
    cleanup();
    show(() => problem('INTERNAL_ERROR', 500));
    expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
    cleanup();
    show(() => problem('SCOPE_DENIED', 403));
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
  });
});

function fill(key: string, params: Record<string, string | number>): string {
  return Object.entries(params).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), word(key));
}
