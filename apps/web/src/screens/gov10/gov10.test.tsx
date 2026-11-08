import { ApiError } from '@machvon/api-client';
import { cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t as tr } from '../../i18n';
import { FeedbackAction } from '../../ui/alerts/FeedbackAction';
import { harness, mount, routeOf } from '../mne/test-support';
import AlertClosuresScreen from './AlertClosuresScreen';
import AlertFeedbackQueueScreen from './AlertFeedbackQueueScreen';
import AlertLadderScreen from './AlertLadderScreen';
import RedFlagDetailScreen from './RedFlagDetailScreen';
import RedFlagListScreen from './RedFlagListScreen';
import RedFlagRegistryScreen from './RedFlagRegistryScreen';
import { redFlagEmptyKind, toFinding, toFindingDetail } from './model';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 20_000 });
afterEach(cleanup);

const failure = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });
const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replaceAll(`{${key}}`, String(value)), text);
const ME = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-0000000000aa';

const finding = (overrides: Record<string, unknown> = {}) => ({
  id: 'f1',
  subject_type: 'PACKAGE',
  subject_id: 's1',
  subject_code: 'GT-001',
  score: 5,
  band: 'MEDIUM',
  status: 'NEW',
  fired: [
    { code: 'SINGLE_BIDDER', ocp_id: 'R018', value: 1, threshold: 1, weight: 3 },
    { code: 'SHORT_TENDER_PERIOD', ocp_id: 'R003', value: 5, threshold: 10, weight: 2 },
  ],
  not_computable: ['AWARD_VS_FINAL_PRICE_GAP', 'CONTRACT_AMENDED'],
  ranking_version: 'builtin',
  first_flagged_at: '2026-11-07T01:00:00Z',
  last_evaluated_at: '2026-11-08T01:00:00Z',
  reviewer_id: null,
  clear_proposed_by: null,
  version: 1,
  ...overrides,
});
const detail = (overrides: Record<string, unknown> = {}) => ({
  ...finding(),
  readings: [
    { code: 'SINGLE_BIDDER', ocp_id: 'R018', status: 'FIRED', value: 1, threshold: 1, weight: 3, missing: [] },
    { code: 'AWARD_VS_FINAL_PRICE_GAP', ocp_id: 'R059', status: 'NOT_COMPUTABLE', value: null, threshold: null, weight: 3, missing: ['awardPriceVnd'] },
    { code: 'CONTRACT_AMENDED', ocp_id: 'R064', status: 'CLEAR', value: 0, threshold: 3, weight: 2, missing: [] },
  ],
  history: [{ id: 'h1', move: 'FLAGGED', from_status: null, to_status: 'NEW', actor_id: null, reason: null, score: 5, at: '2026-11-07T01:00:00Z' }],
  reopened_count: 0,
  ...overrides,
});
const indicators = {
  as_of: '2026-11-08',
  items: [
    { code: 'SINGLE_BIDDER', ocp_id: 'R018', vendor_side: false, data_sources: ['BID proposals handed in'], formula: 'One bidder in a competitive package', source: 'OCP 2024', indicator_as_of: '2026-11-08', legal_status: 'UNVERIFIED', unverified: true, enabled: true, params: { weight: 3, indicator: 'x' }, rule_version: 0 },
    { code: 'DEBARRED_BIDDER', ocp_id: 'R046', vendor_side: false, data_sources: ['BID contractor restrictions'], formula: 'A bidder is under a restriction', source: 'OCP 2024', indicator_as_of: '2026-11-08', legal_status: 'UNVERIFIED', unverified: false, enabled: false, params: { weight: 5 }, rule_version: 2 },
  ],
};
const summary = (overrides: Record<string, unknown> = {}) => ({ as_of: '2026-11-08', total: 1, by_band: { MEDIUM: 1 }, by_status: { NEW: 1 }, last_scan: { started_at: '2026-11-08T00:00:00Z', finished_at: '2026-11-08T00:01:00Z', status: 'FINISHED', subjects: 4, flagged: 1 }, ...overrides });
const AUDITOR = ['aud.redflag.read', 'aud.redflag.review', 'aud.redflag.scan', 'aud.redflag.clear'];

describe('the red flags of procurement (AUD-14, AUD-15, AUD-16)', () => {
  it('lists the findings ranked with the score, the level and the indicators that fired, under a notice that says it is not a conclusion', async () => {
    const backend = (operation: string) => (operation === 'listRedFlags' ? { as_of: '2026-11-08T01:00:00Z', items: [finding()], has_more: false } : operation === 'getRedFlagSummary' ? summary() : new Error(operation));
    mount(<RedFlagListScreen route={routeOf('AUD-14', 'FR-AUD-14')} />, harness(backend), { permissions: AUDITOR });
    const link = await screen.findByRole('link', { name: 'GT-001' });
    expect(link.getAttribute('href')).toBe('/aud/aud-15?finding=f1');
    const row = link.closest('tr') as HTMLElement;
    expect(within(row).getByTestId('score-f1').textContent).toBe('5');
    expect(within(row).getByText(tr('gov10.red.band.medium'))).toBeTruthy();
    expect(within(row).getByText(/R018/)).toBeTruthy();
    expect(within(row).getByText(fill(tr('gov10.red.missingCount'), { count: 2 }))).toBeTruthy();
    expect(screen.getByTestId('red-flag-notice').textContent).toBe(tr('gov10.red.notice'));
  });

  it('says whether a scan has finished before it says there is nothing, and says a reader without the right may not see', async () => {
    const empty = (scan: unknown, denied = false) => (operation: string) => (operation === 'listRedFlags' ? { as_of: '2026-11-08T01:00:00Z', items: [], has_more: false } : operation === 'getRedFlagSummary' ? summary({ last_scan: scan, total: 0, ...(denied ? { denied: true } : {}) }) : new Error(operation));
    mount(<RedFlagListScreen route={routeOf('AUD-14', 'FR-AUD-14')} />, harness(empty(null)), { permissions: AUDITOR });
    expect((await screen.findByTestId('red-flag-empty')).getAttribute('data-kind')).toBe('never');
    cleanup();
    mount(<RedFlagListScreen route={routeOf('AUD-14', 'FR-AUD-14')} />, harness(empty({ started_at: 'a', finished_at: 'b', status: 'FINISHED', subjects: 3, flagged: 0 })), { permissions: AUDITOR });
    expect((await screen.findByTestId('red-flag-empty')).getAttribute('data-kind')).toBe('none');
    cleanup();
    mount(<RedFlagListScreen route={routeOf('AUD-14', 'FR-AUD-14')} />, harness(empty(null, true)), { permissions: [] });
    expect((await screen.findByTestId('red-flag-empty')).getAttribute('data-kind')).toBe('denied');
    expect(redFlagEmptyKind(undefined)).toBe('never');
  });

  it('shows an error with a retry, and asks for a scan only of the one who may', async () => {
    const calls: string[] = [];
    const backend = (operation: string) => {
      calls.push(operation);
      return operation === 'listRedFlags' ? failure(500, 'BOOM') : summary();
    };
    mount(<RedFlagListScreen route={routeOf('AUD-14', 'FR-AUD-14')} />, harness(backend), { permissions: ['aud.redflag.read'] });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByTestId('scan-now')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: tr('states.retry.action') }));
    await waitFor(() => expect(calls.filter((name) => name === 'listRedFlags').length).toBeGreaterThan(1));
  });

  it('starts a scan with one idempotent command and shows the result of the list again', async () => {
    const command = vi.fn(() => ({ operation_id: 'o', status: 'FINISHED', resource_version: 1, resource_id: 'scan' }));
    const backend = (operation: string) => (operation === 'listRedFlags' ? { as_of: '2026-11-08T01:00:00Z', items: [finding()], has_more: false } : summary());
    mount(<RedFlagListScreen route={routeOf('AUD-14', 'FR-AUD-14')} />, harness(backend, command), { permissions: AUDITOR });
    await userEvent.click(await screen.findByTestId('scan-now'));
    await waitFor(() => expect(command).toHaveBeenCalledWith('scanRedFlags', expect.objectContaining({ body: {} })));
  });

  it('shows every indicator with its measure, and an indicator with no input as not computable with the missing fact, never as clear', async () => {
    const backend = (operation: string) => (operation === 'getRedFlag' ? detail() : operation === 'listRedFlagIndicators' ? indicators : new Error(operation));
    mount(<RedFlagDetailScreen route={routeOf('AUD-15', 'FR-AUD-15')} />, harness(backend), { permissions: AUDITOR }, '/aud/aud-15?finding=f1');
    await screen.findByText(tr('gov10.red.reading.notComputable'));
    const gap = screen.getByText(tr('gov10.red.indicator.awardVsFinalPriceGap')).closest('tr') as HTMLElement;
    expect(within(gap).getByText(fill(tr('gov10.red.reading.missingFacts'), { facts: 'awardPriceVnd' }))).toBeTruthy();
    expect(screen.getByTestId('red-flag-lower-bound').textContent).toBe(fill(tr('gov10.red.detail.lowerBound'), { count: 2 }));
    const single = screen.getByText(tr('gov10.red.indicator.singleBidder')).closest('tr') as HTMLElement;
    expect(within(single).getByText(tr('gov10.red.reading.fired'))).toBeTruthy();
    expect(within(single).getByText(fill(tr('gov10.red.reading.valueOf'), { value: 1, threshold: 1 }))).toBeTruthy();
  });

  it('takes a finding up with the version it saw, and proposes clearing only with a reason', async () => {
    const command = vi.fn(() => ({ operation_id: 'o', status: 'IN_REVIEW', resource_version: 2, resource_id: 'f1' }));
    const backend = (operation: string) => (operation === 'getRedFlag' ? detail({ status: 'IN_REVIEW', version: 2, reviewer_id: ME }) : operation === 'listRedFlagIndicators' ? indicators : new Error(operation));
    mount(<RedFlagDetailScreen route={routeOf('AUD-15', 'FR-AUD-15')} />, harness(backend, command), { permissions: AUDITOR }, '/aud/aud-15?finding=f1');
    await userEvent.click(await screen.findByRole('button', { name: tr('gov10.red.action.proposeClear') }));
    const dialog = screen.getByRole('dialog');
    const send = within(dialog).getByRole('button', { name: tr('gov10.red.action.proposeClear') });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(within(dialog).getByRole('textbox'), 'The single bid is justified by the market');
    await userEvent.click(send);
    await waitFor(() => expect(command).toHaveBeenCalledWith('proposeClearRedFlag', expect.objectContaining({ path: { id: 'f1' }, ifMatchVersion: 2, body: { reason: 'The single bid is justified by the market' } })));
  });

  it('offers the second auditor the confirmation, tells the proposer to wait, and says the refusal of the same person in words', async () => {
    const proposed = detail({ status: 'CLEAR_PROPOSED', version: 3, clear_proposed_by: ME, clear_reason: 'Justified' });
    mount(<RedFlagDetailScreen route={routeOf('AUD-15', 'FR-AUD-15')} />, harness((operation) => (operation === 'getRedFlag' ? proposed : indicators)), { permissions: AUDITOR }, '/aud/aud-15?finding=f1');
    expect(await screen.findByTestId('needs-second')).toBeTruthy();
    expect(screen.queryByRole('button', { name: tr('gov10.red.action.confirmClear') })).toBeNull();
    cleanup();
    const refused = vi.fn(() => failure(403, 'SELF_APPROVAL_DENIED'));
    mount(<RedFlagDetailScreen route={routeOf('AUD-15', 'FR-AUD-15')} />, harness((operation) => (operation === 'getRedFlag' ? detail({ status: 'CLEAR_PROPOSED', version: 3, clear_proposed_by: OTHER }) : indicators), refused), { permissions: AUDITOR }, '/aud/aud-15?finding=f1');
    await userEvent.click(await screen.findByRole('button', { name: tr('gov10.red.action.confirmClear') }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: tr('gov10.red.action.confirmClear') }));
    expect(await screen.findByText(tr('gov10.red.error.selfApproval'))).toBeTruthy();
  });

  it('says "not found" the same way for a finding that does not exist and one the reader took part in', async () => {
    mount(<RedFlagDetailScreen route={routeOf('AUD-15', 'FR-AUD-15')} />, harness((operation) => (operation === 'getRedFlag' ? failure(404, 'RESOURCE_NOT_FOUND') : indicators)), { permissions: AUDITOR }, '/aud/aud-15?finding=nope');
    expect((await screen.findByTestId('red-flag-not-found')).textContent).toContain(tr('gov10.red.detail.notFound'));
  });

  it('keeps the registry of indicators with formula, source, day, thresholds and the label of an unconfirmed default', async () => {
    mount(<RedFlagRegistryScreen route={routeOf('AUD-16', 'FR-AUD-16')} />, harness((operation) => (operation === 'listRedFlagIndicators' ? indicators : new Error(operation))), { permissions: AUDITOR });
    const row = (await screen.findByText(tr('gov10.red.indicator.singleBidder'))).closest('tr') as HTMLElement;
    expect(within(row).getByText(tr('gov10.red.registry.unverified'))).toBeTruthy();
    expect(within(row).getByText('weight: 3')).toBeTruthy();
    const other = screen.getByText(tr('gov10.red.indicator.debarredBidder')).closest('tr') as HTMLElement;
    expect(within(other).getByText(tr('gov10.red.registry.verified'))).toBeTruthy();
    expect(within(other).getByText(tr('gov10.red.registry.off'))).toBeTruthy();
  });

  it('parses only what it knows', () => {
    expect(toFinding({ id: 'x', status: 'MADE_UP' })).toBeUndefined();
    expect(toFindingDetail({})).toBeUndefined();
    expect(toFinding(finding())?.fired).toHaveLength(2);
  });
});

const ladders = {
  as_of: '2026-11-08',
  ladders: [
    { severity: 'URGENT', version: 'builtin', unverified: true, formula: 'rungs by receipt', source: 'research', rule_as_of: '2026-11-08', stop_when: 'SEEN', hand_off: 'ESCALATE', hand_off_after_minutes: 30, expires_after_minutes: 1440, rungs: [{ index: 0, channel: 'IN_APP', wait_minutes: 0 }, { index: 1, channel: 'PUSH', wait_minutes: 15 }, { index: 2, channel: 'SMS', wait_minutes: 30 }] },
    { severity: 'WATCH', version: '2', unverified: false, formula: null, source: null, rule_as_of: null, stop_when: 'DELIVERED', hand_off: 'NONE', hand_off_after_minutes: 0, expires_after_minutes: 10080, rungs: [{ index: 0, channel: 'IN_APP', wait_minutes: 0 }] },
  ],
};
const run = (overrides: Record<string, unknown> = {}) => ({
  id: 'r1',
  source: 'ADVANCE',
  source_id: 'a1',
  severity: 'URGENT',
  alert_type: 'ADVANCE',
  policy_version: 'builtin',
  state: 'ESCALATED',
  done_by: null,
  started_at: '2026-11-08T01:00:00Z',
  next_at: null,
  escalated_at: '2026-11-08T02:00:00Z',
  planned: [],
  rungs: [
    { index: 0, channel: 'IN_APP', state: 'DELIVERED', reason: null, sent_at: '2026-11-08T01:00:00Z', receipt_at: '2026-11-08T01:00:01Z' },
    { index: 1, channel: 'PUSH', state: 'SUPPRESSED', reason: 'NO_WORKFLOW', sent_at: '2026-11-08T01:00:02Z', receipt_at: null },
  ],
  ...overrides,
});
const kpi = { from: '2026-10-09', to: '2026-11-09', as_of: '2026-11-08', runs: 4, unverified: true, formula: 'receipts within the line', urgent: { runs: 4, receipted: 3, receipted_within: 2, within_minutes: 30, share_within_pct: 50, median_minutes_to_receipt: 7.5, escalated: 1, exhausted: 0 }, by_channel: [{ channel: 'PUSH', sent: 3, delivered: 2, seen: 1, failed: 0, suppressed: 0, no_workflow: 2 }] };

describe('the channel ladder (NOT-30)', () => {
  const backend = (runs: unknown = { as_of: 'x', items: [run()], has_more: false }) => (operation: string) => (operation === 'getAlertLadderPolicy' ? ladders : operation === 'getAlertLadderKpi' ? kpi : operation === 'listAlertLadderRuns' ? runs : new Error(operation));

  it('shows the ladder of each level with its waits, the hand-off, and the label of a default that nobody confirmed', async () => {
    mount(<AlertLadderScreen route={routeOf('NOT-30', 'FR-NOT-20')} />, harness(backend()), { permissions: ['alert.ladder.read'] });
    const urgent = await screen.findByTestId('ladder-URGENT');
    expect(within(urgent).getByText(`${tr('gov10.ladder.channel.push')} (${fill(tr('gov10.ladder.policy.wait'), { minutes: 15 })}) →`)).toBeTruthy();
    expect(within(urgent).getByText(fill(tr('gov10.ladder.policy.handOff'), { minutes: 30 }))).toBeTruthy();
    expect(within(urgent).getByText(tr('gov10.info.unverified'))).toBeTruthy();
    expect(within(screen.getByTestId('ladder-WATCH')).getByText(tr('gov10.ladder.policy.noHandOff'))).toBeTruthy();
    expect(screen.getByText(tr('gov10.ladder.noFigures'))).toBeTruthy();
  });

  it('shows the KPI of urgent delivery and counts a rung with no workflow apart from a failure', async () => {
    mount(<AlertLadderScreen route={routeOf('NOT-30', 'FR-NOT-20')} />, harness(backend()), { permissions: ['alert.ladder.read'] });
    expect(await screen.findByText('50%')).toBeTruthy();
    expect(screen.getByText(fill(tr('gov10.ladder.kpi.minutes'), { minutes: 7.5 }))).toBeTruthy();
    const table = screen.getByTestId('channel-table');
    const push = within(table).getByRole('rowheader', { name: tr('gov10.ladder.channel.push') }).closest('tr') as HTMLElement;
    expect(within(push).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['3', '2', '1', '0', '0', '2']);
  });

  it('shows the receipt of every rung of a ladder, and why a rung was not sent', async () => {
    mount(<AlertLadderScreen route={routeOf('NOT-30', 'FR-NOT-20')} />, harness(backend()), { permissions: ['alert.ladder.read'] });
    await screen.findAllByText(tr('gov10.ladder.run.escalated'));
    expect(screen.getByText(`${tr('gov10.ladder.channel.inApp')}: ${tr('gov10.ladder.state.delivered')}`)).toBeTruthy();
    expect(screen.getByText(`${tr('gov10.ladder.channel.push')}: ${tr('gov10.ladder.state.suppressed')}`)).toBeTruthy();
    expect(screen.getByText(tr('gov10.ladder.reason.noWorkflow'))).toBeTruthy();
  });

  it('says there is no ladder yet, says a failed list, and refuses a reader without the right', async () => {
    mount(<AlertLadderScreen route={routeOf('NOT-30', 'FR-NOT-20')} />, harness(backend({ as_of: 'x', items: [], has_more: false })), { permissions: ['alert.ladder.read'] });
    expect(await screen.findByTestId('runs-empty')).toBeTruthy();
    cleanup();
    mount(<AlertLadderScreen route={routeOf('NOT-30', 'FR-NOT-20')} />, harness((operation) => (operation === 'listAlertLadderRuns' ? failure(500, 'BOOM') : backend()(operation))), { permissions: ['alert.ladder.read'] });
    expect(await screen.findByTestId('runs-error')).toBeTruthy();
    cleanup();
    mount(<AlertLadderScreen route={routeOf('NOT-30', 'FR-NOT-20')} />, harness((operation) => (operation === 'getAlertLadderPolicy' ? { as_of: 'x', denied: true, ladders: [] } : backend()(operation))), { permissions: [] });
    expect(await screen.findByTestId('ladder-denied')).toBeTruthy();
  });
});

const report = (overrides: Record<string, unknown> = {}) => ({ id: 'p1', source: 'GUARANTEE', source_id: 'g1', alert_type: 'GUARANTEE', severity: 'WATCH', reason: 'WRONG_DATA', note: 'The guarantee was renewed', status: 'PENDING', review_note: null, proposal_note: null, created_at: '2026-11-07T01:00:00Z', version: 1, ...overrides });
const stats = { as_of: '2026-11-08', review_line_pct: 30, min_shown: 10, unverified: true, items: [{ alert_type: 'GUARANTEE', reports: 4, pending: 2, shown: 10, share_pct: 40, needs_review: true }, { alert_type: 'PERMIT', reports: 1, pending: 0, shown: 0, share_pct: null, needs_review: false }] };

describe('the reports that an alert is wrong (HOME-30 and the button)', () => {
  const backend = (queue: unknown = { as_of: '2026-11-08T01:00:00Z', items: [report()], next_cursor: null }) => (operation: string) => (operation === 'listAlertFeedback' ? queue : operation === 'getAlertFeedbackStats' ? stats : new Error(operation));

  it('lists what waits with its reason and the words of the reporter, and the share of each type against what was shown', async () => {
    mount(<AlertFeedbackQueueScreen route={routeOf('HOME-30', 'FR-HOME-14')} />, harness(backend()), { permissions: ['alert.feedback.review'] });
    const row = (await screen.findByText('GUARANTEE', { selector: 'strong' })).closest('tr') as HTMLElement;
    expect(within(row).getByText(tr('gov10.feedback.reason.wrongData'))).toBeTruthy();
    expect(within(row).getByText('The guarantee was renewed')).toBeTruthy();
    expect(screen.getByTestId('feedback-notice').textContent).toBe(tr('gov10.feedback.notice'));
    expect(await screen.findByText('40%')).toBeTruthy();
    expect(screen.getByText(tr('gov10.feedback.stats.needsReview'))).toBeTruthy();
    expect(screen.getByText(tr('gov10.feedback.stats.noShare'))).toBeTruthy();
  });

  it('rejects only with a reason, with the version it saw, and says the refusal of reviewing one own report', async () => {
    const command = vi.fn(() => failure(403, 'SELF_APPROVAL_DENIED'));
    mount(<AlertFeedbackQueueScreen route={routeOf('HOME-30', 'FR-HOME-14')} />, harness(backend(), command), { permissions: ['alert.feedback.review'] });
    await userEvent.click(await screen.findByRole('button', { name: tr('gov10.feedback.action.reject') }));
    const dialog = screen.getByRole('dialog');
    const send = within(dialog).getByRole('button', { name: tr('gov10.feedback.action.reject') });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(within(dialog).getByRole('textbox'), 'The data is right');
    await userEvent.click(send);
    await waitFor(() => expect(command).toHaveBeenCalledWith('reviewAlertFeedback', expect.objectContaining({ path: { id: 'p1' }, ifMatchVersion: 1, body: { move: 'REJECT', review_note: 'The data is right' } })));
    expect(await screen.findByText(tr('gov10.feedback.error.self'))).toBeTruthy();
  });

  it('offers no review to a reader without the right, and says an empty queue and a failed one in their own words', async () => {
    mount(<AlertFeedbackQueueScreen route={routeOf('HOME-30', 'FR-HOME-14')} />, harness(backend()), { permissions: [] });
    await screen.findByText('GUARANTEE', { selector: 'strong' });
    expect(screen.queryByRole('button', { name: tr('gov10.feedback.action.accept') })).toBeNull();
    cleanup();
    mount(<AlertFeedbackQueueScreen route={routeOf('HOME-30', 'FR-HOME-14')} />, harness(backend({ as_of: 'x', items: [], next_cursor: null })), { permissions: ['alert.feedback.review'] });
    expect(await screen.findByTestId('feedback-empty')).toBeTruthy();
    cleanup();
    mount(<AlertFeedbackQueueScreen route={routeOf('HOME-30', 'FR-HOME-14')} />, harness((operation) => (operation === 'listAlertFeedback' ? failure(500, 'BOOM') : stats)), { permissions: ['alert.feedback.review'] });
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('sends a report from the button with a reason, needs words for another reason, and shows the item as reported afterwards', async () => {
    const command = vi.fn(() => ({ operation_id: 'o', status: 'PENDING', resource_version: 1, resource_id: 'p1' }));
    mount(<FeedbackAction item={{ source: 'GUARANTEE', id: 'g1', title: 'Guarantee ends' }} />, harness(() => new Error('no reads'), command));
    await userEvent.click(screen.getByRole('button', { name: tr('gov10.feedback.report.button') }));
    const dialog = screen.getByRole('dialog');
    const send = within(dialog).getByRole('button', { name: tr('gov10.feedback.report.send') });
    await userEvent.selectOptions(within(dialog).getByRole('combobox'), 'OTHER');
    await userEvent.type(within(dialog).getByRole('textbox'), 'abc');
    expect((send as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(within(dialog).getByRole('textbox'), 'de');
    await userEvent.click(send);
    await waitFor(() => expect(command).toHaveBeenCalledWith('reportAlertWrong', expect.objectContaining({ body: { source: 'GUARANTEE', source_id: 'g1', reason: 'OTHER', note: 'abcde' } })));
    expect(await screen.findByTestId('alert-reported')).toBeTruthy();
  });

  it('says so when the same alert was already reported', async () => {
    const command = vi.fn(() => failure(409, 'ALERT_FEEDBACK_ALREADY_REPORTED'));
    mount(<FeedbackAction item={{ source: 'GUARANTEE', id: 'g1', title: 'Guarantee ends' }} />, harness(() => new Error('no reads'), command));
    await userEvent.click(screen.getByRole('button', { name: tr('gov10.feedback.report.button') }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'DUPLICATE' } });
    await userEvent.click(within(dialog).getByRole('button', { name: tr('gov10.feedback.report.send') }));
    expect(await screen.findByTestId('alert-reported')).toBeTruthy();
  });
});

const summaryOfClosures = { as_of: '2026-11-08', from: '2026-10-09', to: '2026-11-09', open_now: 12, closed_by_system: 7, reopened: 2, closed_without_record: 3, median_hours_open: 30.5, formula: 'counted from events', by_type: [] };
const flood = (overrides: Record<string, unknown> = {}) => ({
  as_of: '2026-11-08T03:00:00Z',
  view: 'mine',
  storm: { active: true, since: '2026-11-08T02:30:00Z' },
  protecting: true,
  new_in_window: 14,
  new_today: 20,
  unavailable_sources: ['PERMIT'],
  policy: { window_minutes: 60, start_above: 10, end_below: 5, max_new_per_day: 30, group_by: ['CAUSE', 'SOURCE'], min_group_size: 3, version: 'builtin', unverified: true, formula: 'storm rule', source: 'research', rule_as_of: '2026-11-08' },
  groups: [{ key: 'SOURCE:GUARANTEE', dimension: 'SOURCE', source: 'GUARANTEE', count: 5, most_severe: 'ACTION', members: [] }],
  singles: 2,
  ...overrides,
});
const closure = (overrides: Record<string, unknown> = {}) => ({ id: 'c1', source: 'PERMIT', source_id: 'p1', alert_type: 'PERMIT_EXPIRING', severity: 'WATCH', state: 'RESOLVED_BY_SYSTEM', first_seen_at: '2026-11-01T01:00:00Z', closed_at: '2026-11-05T01:00:00Z', reopen_count: 1, decisions_before_close: 0, closed_without_record: true, ...overrides });

describe('the closing of alerts and the storms (HOME-31)', () => {
  const backend = (overrides: Record<string, unknown> = {}) => (operation: string) => {
    const answers: Record<string, unknown> = {
      getAlertClosureSummary: summaryOfClosures,
      listAlertClosures: { as_of: 'x', items: [closure()], next_cursor: null },
      listAlertStorms: { items: [{ id: 's1', member_id: ME, started_at: '2026-11-08T02:30:00Z', ended_at: null, peak_new: 14, grouped_count: 9, window_minutes: 60, start_above: 10, end_below: 5 }] },
      getAlertFlood: flood(),
      ...overrides,
    };
    return answers[operation] ?? new Error(operation);
  };

  it('counts what the system closed, reopened and closed with no record, and flags the items nobody acted on', async () => {
    mount(<AlertClosuresScreen route={routeOf('HOME-31', 'FR-HOME-15')} />, harness(backend()), { permissions: ['alert.closure.read'] });
    expect(await screen.findByText('7')).toBeTruthy();
    expect(screen.getByText(fill(tr('gov10.closures.kpi.hours'), { hours: 30.5 }))).toBeTruthy();
    const row = screen.getByText('PERMIT_EXPIRING', { selector: 'strong' }).closest('tr') as HTMLElement;
    expect(within(row).getByText(tr('gov10.closures.noRecord'))).toBeTruthy();
  });

  it('says whether the reader is in a storm, what was gathered, that urgent alerts are never gathered, and which source could not be read', async () => {
    mount(<AlertClosuresScreen route={routeOf('HOME-31', 'FR-HOME-15')} />, harness(backend()), { permissions: ['alert.closure.read'] });
    const state = await screen.findByTestId('flood-state');
    expect(state.getAttribute('data-active')).toBe('true');
    expect(within(screen.getByTestId('flood-groups')).getByText(fill(tr('gov10.flood.group'), { count: 5, source: tr('alerts.source.guarantee') }))).toBeTruthy();
    expect(screen.getByText(tr('gov10.flood.urgentApart'))).toBeTruthy();
    expect(screen.getByTestId('flood-unavailable').textContent).toContain(tr('alerts.source.permit'));
    expect(screen.getByText(tr('gov10.storms.ongoing'))).toBeTruthy();
  });

  it('says calm when there is no storm, and an empty list and a failed list in their own words', async () => {
    mount(<AlertClosuresScreen route={routeOf('HOME-31', 'FR-HOME-15')} />, harness(backend({ getAlertFlood: flood({ storm: { active: false, since: null }, protecting: false, groups: [], unavailable_sources: [] }), listAlertClosures: { as_of: 'x', items: [], next_cursor: null }, listAlertStorms: { items: [] } })), { permissions: ['alert.closure.read'] });
    expect((await screen.findByTestId('flood-state')).getAttribute('data-active')).toBe('false');
    expect(await screen.findByTestId('closures-empty')).toBeTruthy();
    expect(screen.getByTestId('storms-empty')).toBeTruthy();
    expect(screen.getByTestId('flood-no-groups')).toBeTruthy();
    cleanup();
    mount(<AlertClosuresScreen route={routeOf('HOME-31', 'FR-HOME-15')} />, harness(backend({ listAlertClosures: failure(500, 'BOOM'), getAlertFlood: failure(500, 'BOOM') })), { permissions: ['alert.closure.read'] });
    expect(await screen.findByTestId('closures-error')).toBeTruthy();
    expect(screen.getByTestId('flood-error')).toBeTruthy();
  });

  it('refuses a reader without the right', async () => {
    mount(<AlertClosuresScreen route={routeOf('HOME-31', 'FR-HOME-15')} />, harness(backend({ getAlertClosureSummary: { as_of: 'x', denied: true } })), { permissions: [] });
    expect(await screen.findByTestId('closures-denied')).toBeTruthy();
  });
});
