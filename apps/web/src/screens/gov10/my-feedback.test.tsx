import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { t as tr } from '../../i18n';
import { harness, mount, routeOf } from '../mne/test-support';
import AlertFeedbackQueueScreen from './AlertFeedbackQueueScreen';

afterEach(cleanup);

const failure = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });
const mine = (overrides: Record<string, unknown> = {}) => ({ id: 'p1', source: 'GUARANTEE', source_id: 'g1', alert_type: 'GUARANTEE', severity: 'WATCH', reason: 'WRONG_DATA', note: 'Renewed', status: 'PENDING', review_note: null, proposal_note: null, created_at: '2026-11-07T01:00:00Z', version: 3, ...overrides });
const queue = { as_of: '2026-11-08T01:00:00Z', items: [], next_cursor: null };
const stats = { as_of: '2026-11-08', review_line_pct: 30, min_shown: 10, unverified: true, items: [] };
const backend = (own: unknown) => (operation: string) => (operation === 'listAlertFeedback' ? queue : operation === 'getAlertFeedbackStats' ? stats : operation === 'listMyAlertFeedback' ? own : new Error(operation));
const open = (own: unknown, command?: (operation: string, input: unknown) => unknown) => mount(<AlertFeedbackQueueScreen route={routeOf('HOME-30', 'FR-HOME-14')} />, harness(backend(own), command), { permissions: [] });

describe('the reporter side of the reports that an alert is wrong (listMyAlertFeedback, withdrawAlertFeedback)', () => {
  it('lists the reports of the person with their status and the answer of the owner, and offers the withdrawal only for a pending one', async () => {
    open({ as_of: '2026-11-08', items: [mine(), mine({ id: 'p2', status: 'REJECTED', review_note: 'The data is right', version: 2 })] });
    const pending = (await screen.findByTestId('withdraw-p1')).closest('tr') as HTMLElement;
    expect(within(pending).getByText(tr('gov10.feedback.status.pending'))).toBeTruthy();
    expect(screen.queryByTestId('withdraw-p2')).toBeNull();
    expect(screen.getByText('The data is right')).toBeTruthy();
  });

  it('withdraws a report under the version that was read, after the person confirms', async () => {
    const command = () => ({ operation_id: 'o', status: 'WITHDRAWN', resource_version: 4, resource_id: 'p1' });
    const h = harness(backend({ as_of: '2026-11-08', items: [mine()] }), command);
    mount(<AlertFeedbackQueueScreen route={routeOf('HOME-30', 'FR-HOME-14')} />, h, { permissions: [] });
    fireEvent.click(await screen.findByTestId('withdraw-p1'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: tr('gov10.feedback.mine.withdraw') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('withdrawAlertFeedback', expect.objectContaining({ path: { id: 'p1' }, ifMatchVersion: 3 })));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('says in words that a report that was reviewed in the meantime can no longer be withdrawn, and keeps the dialog', async () => {
    open({ as_of: '2026-11-08', items: [mine()] }, () => failure(409, 'ALERT_FEEDBACK_STATE_INVALID'));
    fireEvent.click(await screen.findByTestId('withdraw-p1'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: tr('gov10.feedback.mine.withdraw') }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain(tr('gov10.feedback.mine.error.state'));
  });

  it('shows the empty state, and an error with a retry that reads again', async () => {
    open({ as_of: '2026-11-08', items: [] });
    expect(await screen.findByTestId('mine-empty')).toBeTruthy();
    cleanup();
    let calls = 0;
    const h = harness((operation) => (operation === 'listMyAlertFeedback' ? (calls++ === 0 ? failure(500, 'BOOM') : { as_of: 'x', items: [mine()] }) : backend(null)(operation)));
    mount(<AlertFeedbackQueueScreen route={routeOf('HOME-30', 'FR-HOME-14')} />, h, { permissions: [] });
    const error = await screen.findByTestId('mine-error');
    fireEvent.click(within(error).getByRole('button'));
    expect(await screen.findByTestId('withdraw-p1')).toBeTruthy();
  });
});
