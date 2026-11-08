import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { harness, mount, routeOf } from '../mne/test-support';
import AlertLadderScreen from './AlertLadderScreen';

afterEach(cleanup);

const policy = { as_of: '2026-11-08', denied: false, ladders: [] };
const kpi = { from: '2026-10-09', to: '2026-11-08', as_of: '2026-11-08', runs: 0, denied: false, unverified: true, formula: 'f', urgent: { runs: 0, receipted: 0, receipted_within: 0, within_minutes: 15, share_pct: null, median_minutes: null, escalated: 0, exhausted: 0 }, by_channel: [] };
const run = { id: 'r1', source: 'GUARANTEE', source_id: 'g1', severity: 'URGENT', alert_type: 'GUARANTEE_EXPIRY', policy_version: 'builtin', state: 'DONE', done_by: 'SEEN', started_at: '2026-11-07T01:00:00Z', next_at: null, escalated_at: null, planned: [], rungs: [{ index: 1, channel: 'IN_APP', state: 'SEEN', reason: null, sent_at: '2026-11-07T01:00:00Z', receipt_at: '2026-11-07T01:05:00Z' }] };
const backend = (item: () => unknown) => (operation: string, input?: unknown) => (operation === 'getAlertLadderPolicy' ? policy : operation === 'getAlertLadderKpi' ? kpi : operation === 'listAlertLadderRuns' ? { as_of: 'x', has_more: false, items: [] } : operation === 'getAlertLadderForItem' ? (input === undefined ? item() : item()) : new Error(operation));
const open = (item: () => unknown) => {
  const h = harness(backend(item));
  mount(<AlertLadderScreen route={routeOf('NOT-30', 'FR-NOT-20')} />, h, { permissions: ['alert.ladder.read'] });
  return h;
};
const ask = (source: string, id: string) => {
  fireEvent.change(screen.getByLabelText(/Nguồn của cảnh báo|Source of the alert/), { target: { value: source } });
  fireEvent.change(screen.getByLabelText(/Mã định danh của việc cảnh báo|Identifier of the alert item/), { target: { value: id } });
  fireEvent.submit(screen.getByTestId('item-lookup'));
};

describe('the ladder of one alert item (getAlertLadderForItem)', () => {
  it('reads nothing until asked, refuses a source that is not a code, then shows the runs and their receipts', async () => {
    const h = open(() => ({ as_of: '2026-11-08', items: [run] }));
    await screen.findByTestId('item-lookup');
    expect(h.read).not.toHaveBeenCalledWith('getAlertLadderForItem', expect.anything());
    ask('guarantee 1', '');
    expect(screen.getByTestId('item-invalid')).toBeTruthy();
    expect(h.read).not.toHaveBeenCalledWith('getAlertLadderForItem', expect.anything());
    ask('guarantee', 'g1');
    const list = await screen.findByTestId('item-runs');
    expect(h.read).toHaveBeenCalledWith('getAlertLadderForItem', { query: { source: 'GUARANTEE', source_id: 'g1' } });
    expect(within(list).getByText('GUARANTEE_EXPIRY')).toBeTruthy();
  });

  it('says an item with no ladder, and an error with a retry that asks again', async () => {
    open(() => ({ as_of: '2026-11-08', items: [] }));
    await screen.findByTestId('item-lookup');
    ask('GUARANTEE', 'g1');
    expect(await screen.findByTestId('item-empty')).toBeTruthy();
    cleanup();
    let calls = 0;
    open(() => (calls++ === 0 ? new ApiError({ status: 500, code: 'BOOM', correlationId: 'c' }) : { as_of: 'x', items: [run] }));
    await screen.findByTestId('item-lookup');
    ask('GUARANTEE', 'g1');
    fireEvent.click(within(await screen.findByTestId('item-error')).getByRole('button'));
    expect(await screen.findByTestId('item-runs')).toBeTruthy();
  });
});
