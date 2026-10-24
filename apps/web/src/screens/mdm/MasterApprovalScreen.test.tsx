import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { mountInSession } from '../adm/security/test-support';
import MasterApprovalScreen from './MasterApprovalScreen';
import { ME, OTHER, PUBLISHER, READER, REVIEWER, change, client, mount, routeOf, world } from './test-support';

const ROUTE = routeOf('MDM-32', 'FR-MDM-32');
const DOCUMENT = '00000000-0000-4000-8000-0000000000d1';
const problem = (code: string) => new ApiError({ status: 403, code, correlationId: 'c', retryAfterSeconds: undefined, detail: undefined, extensions: {} });

afterEach(cleanup);

const rowOf = (id: string): HTMLElement => document.querySelector(`[data-change-id="${id}"]`) as HTMLElement;
const ready = () => waitFor(() => expect(document.querySelector('[data-change-id]')).not.toBeNull());

const QUEUE = [
  change(1, { status: 'IN_REVIEW' }),
  change(2, { status: 'IN_REVIEW', created_by: ME }),
  change(3, { status: 'APPROVED', reviewed_by: OTHER, version: 3, master_record_version: 5 }),
  change(4, { status: 'IN_REVIEW', change_kind: 'RETIRE', proposed: {}, impact: null }),
];

describe('MasterApprovalScreen (MDM-32)', () => {
  it('lists what waits for a review and what waits for publication, with the entry, the impact and the date', async () => {
    mount(<MasterApprovalScreen route={ROUTE} />, client(world({ changes: QUEUE })), REVIEWER);
    await ready();
    const review = within(document.querySelector('[data-stage-section="review"]') as HTMLElement);
    expect(review.getAllByRole('row')).toHaveLength(4);
    const first = within(rowOf(change(1).id));
    expect(first.getByText('SECTOR · GT-1').getAttribute('href')).toBe('/mdm/mdm-27?type=SECTOR&key=GT-1');
    expect(first.getByText('Giao thông vận tải')).toBeTruthy();
    expect(first.getByText(vi_['mdm.approval.impact.total.text'].replace('{total}', '2'))).toBeTruthy();
    expect(first.getByText('2025-06-01')).toBeTruthy();
    expect(within(rowOf(change(4).id)).getByText(vi_['mdm.approval.impact.missing.text'])).toBeTruthy();
    expect(within(rowOf(change(4).id)).getByText(vi_['mdm.approval.retire.summary'])).toBeTruthy();
    const publication = within(document.querySelector('[data-stage-section="publish"]') as HTMLElement);
    expect(publication.getAllByRole('row')).toHaveLength(2);
  });

  it('does not let a reviewer decide on their own request, and offers the decision on the others', async () => {
    mount(<MasterApprovalScreen route={ROUTE} />, client(world({ changes: QUEUE })), REVIEWER);
    await ready();
    expect(within(rowOf(change(2).id)).getByTestId('own-request').textContent).toBe(vi_['mdm.approval.own.hint']);
    expect(within(rowOf(change(2).id)).queryByRole('button')).toBeNull();
    expect(within(rowOf(change(1).id)).getByRole('button', { name: vi_['mdm.approval.review.action'] })).toBeTruthy();
    // A reviewer is not a publisher: the approved request offers nothing to them.
    expect(within(rowOf(change(3).id)).queryByRole('button')).toBeNull();
  });

  it('approves with a reason, sending the version of the request that was read', async () => {
    const h = client(world({ changes: QUEUE }));
    mount(<MasterApprovalScreen route={ROUTE} />, h, REVIEWER);
    await ready();
    const user = userEvent.setup();
    await user.click(within(rowOf(change(1).id)).getByRole('button', { name: vi_['mdm.approval.review.action'] }));
    const panel = within(document.querySelector(`[data-panel-for="${change(1).id}"]`) as HTMLElement);
    expect(panel.getByTestId('impact')).toBeTruthy();
    expect(panel.getByText('Renamed by decision 12')).toBeTruthy();
    await user.click(panel.getByRole('button', { name: vi_['mdm.approval.decision.approve.action'] }));
    expect(await panel.findByText(vi_['mdm.field.tooShort.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(panel.getByLabelText(vi_['mdm.approval.reason.label']), { target: { value: 'Checked against decision 12' } });
    await user.click(panel.getByRole('button', { name: vi_['mdm.approval.decision.approve.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith(
      'decideMasterChangeRequest',
      expect.objectContaining({ path: { id: change(1).id }, body: { decision: 'approve', reason: 'Checked against decision 12' }, ifMatchVersion: 2 }),
    );
    expect(await screen.findByText(vi_['mdm.approval.decided.notice'])).toBeTruthy();
    expect(document.querySelector(`[data-panel-for="${change(1).id}"]`)).toBeNull();
  });

  it('rejects and returns with the same reason rule', async () => {
    const h = client(world({ changes: QUEUE }));
    mount(<MasterApprovalScreen route={ROUTE} />, h, REVIEWER);
    await ready();
    const user = userEvent.setup();
    for (const decision of ['reject', 'return'] as const) {
      await user.click(within(rowOf(change(1).id)).getByRole('button', { name: vi_['mdm.approval.review.action'] }));
      const panel = within(document.querySelector(`[data-panel-for="${change(1).id}"]`) as HTMLElement);
      fireEvent.change(panel.getByLabelText(vi_['mdm.approval.reason.label']), { target: { value: `Not ready: ${decision}` } });
      await user.click(panel.getByRole('button', { name: vi_[`mdm.approval.decision.${decision}.action`] }));
      await waitFor(() => expect(h.command).toHaveBeenLastCalledWith('decideMasterChangeRequest', expect.objectContaining({ body: { decision, reason: `Not ready: ${decision}` } })));
      await waitFor(() => expect(document.querySelector(`[data-panel-for="${change(1).id}"]`)).toBeNull());
    }
  });

  it('closes the panel without sending anything', async () => {
    const h = client(world({ changes: QUEUE }));
    mount(<MasterApprovalScreen route={ROUTE} />, h, REVIEWER);
    await ready();
    const user = userEvent.setup();
    await user.click(within(rowOf(change(1).id)).getByRole('button', { name: vi_['mdm.approval.review.action'] }));
    await user.click(screen.getByRole('button', { name: vi_['mdm.approval.cancel.action'] }));
    expect(document.querySelector(`[data-panel-for="${change(1).id}"]`)).toBeNull();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('publishes with the decision document and the version of the record, and refuses an id that is not one', async () => {
    const h = client(world({ changes: QUEUE }));
    mount(<MasterApprovalScreen route={ROUTE} />, h, PUBLISHER);
    await ready();
    const user = userEvent.setup();
    await user.click(within(rowOf(change(3).id)).getByRole('button', { name: vi_['mdm.approval.publish.action'] }));
    const panel = within(document.querySelector(`[data-panel-for="${change(3).id}"]`) as HTMLElement);
    fireEvent.change(panel.getByLabelText(vi_['mdm.approval.document.label']), { target: { value: 'not-an-id' } });
    await user.click(panel.getByRole('button', { name: vi_['mdm.approval.publish.confirm.action'] }));
    expect(await panel.findByText(vi_['mdm.approval.document.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(panel.getByLabelText(vi_['mdm.approval.document.label']), { target: { value: ` ${DOCUMENT.toUpperCase()} ` } });
    await user.click(panel.getByRole('button', { name: vi_['mdm.approval.publish.confirm.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith('post_master_records_id_publish', expect.objectContaining({ path: { id: change(3).master_record_id }, body: { decision_document_id: DOCUMENT }, ifMatchVersion: 5 }));
    expect(await screen.findByText(vi_['mdm.approval.published.notice'])).toBeTruthy();
  });

  it('says what the server refused', async () => {
    const h = client(world({ changes: QUEUE }), () => problem('SELF_APPROVAL_DENIED'));
    mount(<MasterApprovalScreen route={ROUTE} />, h, REVIEWER);
    await ready();
    const user = userEvent.setup();
    await user.click(within(rowOf(change(1).id)).getByRole('button', { name: vi_['mdm.approval.review.action'] }));
    const panel = within(document.querySelector(`[data-panel-for="${change(1).id}"]`) as HTMLElement);
    fireEvent.change(panel.getByLabelText(vi_['mdm.approval.reason.label']), { target: { value: 'Checked against decision 12' } });
    await user.click(panel.getByRole('button', { name: vi_['mdm.approval.decision.approve.action'] }));
    expect((await screen.findByText(vi_['mdm.problem.selfApproval.error'])).closest('[role="alert"]')).not.toBeNull();
    expect(document.querySelector(`[data-panel-for="${change(1).id}"]`)).not.toBeNull();
  });

  it('shows the empty queues, and an error with a retry', async () => {
    mount(<MasterApprovalScreen route={ROUTE} />, client(world({ changes: [] })), REVIEWER);
    expect(await screen.findByText(vi_['mdm.approval.review.empty'])).toBeTruthy();
    expect(screen.getByText(vi_['mdm.approval.publish.empty'])).toBeTruthy();
    cleanup();
    const failing = world({ changes: QUEUE, failing: new Set(['listMasterChangeRequests']) });
    mount(<MasterApprovalScreen route={ROUTE} />, client(failing), REVIEWER);
    const retry = await screen.findByRole('button', { name: vi_['states.retry.action'] });
    failing.failing.clear();
    await userEvent.setup().click(retry);
    await ready();
  });

  it('offers nothing to a reader, and nothing while the tenant is suspended', async () => {
    mount(<MasterApprovalScreen route={ROUTE} />, client(world({ changes: QUEUE })), READER);
    await ready();
    expect(screen.queryByRole('button', { name: vi_['mdm.approval.review.action'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['mdm.approval.publish.action'] })).toBeNull();
    cleanup();
    mountInSession(<MasterApprovalScreen route={ROUTE} />, client(world({ changes: QUEUE })), { permissions: [...REVIEWER, ...PUBLISHER], mode: 'READ_ONLY' });
    await ready();
    expect(screen.getByText(vi_['mdm.readOnly.frozen.notice'])).toBeTruthy();
    expect(screen.queryByRole('button', { name: vi_['mdm.approval.review.action'] })).toBeNull();
  });
});
