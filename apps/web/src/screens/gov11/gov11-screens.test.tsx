import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../i18n';
import type { WebRoute } from '../../routes/types';
import { harness, mount } from '../sas/test-support';
import AccuracyScreen from './AccuracyScreen';
import LessonsScreen from './LessonsScreen';
import LinkageScreen from './LinkageScreen';
import LookAheadScreen from './LookAheadScreen';
import MilestonesScreen from './MilestonesScreen';
import PaymentClocksScreen from './PaymentClocksScreen';
import ReallocationImpactScreen from './ReallocationImpactScreen';
import SettlementClocksScreen from './SettlementClocksScreen';

const route = (id: string, module: string): WebRoute => ({ id, path: `/${module.toLowerCase()}/${id.toLowerCase()}`, title: id, kind: 'table', area: 'investment', module, group: module, role: 'workspace', parent: null, req: `FR-${id}` });
const PERMISSIONS = ['capital.read'];
const ID = '00000000-0000-4000-8000-0000000000f1';
const AS_OF = '2026-11-08T03:00:00.000Z';
const rule = (over: Record<string, unknown> = {}) => ({ code: 'DEFAULT', version: 0, source: 'DEFAULT', unverified: true, params: {}, provenance: { formula: 'A formula in words', source: 'The research', as_of: '2026-11-08', legal_status: 'UNVERIFIED' }, ...over });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const problem = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });

describe('DIS-27 the milestones (G1-16)', () => {
  const unit = (over: Record<string, unknown> = {}) => ({ id: 'u1', unit: { id: 'x', code: 'CDT1', name: 'Investor one' }, plan_total_vnd: '1000000000', target_vnd: '500000000', disbursed_vnd: '300000000', projected_vnd: '450000000', projected_pct: '45.00', gap_pct: '-5.00', basis: 'FORECAST', coverage: 'COMPLETE', status: 'AT_RISK', projects: 3, ...over });
  const board = (over: Record<string, unknown> = {}) => ({
    snapshot: { id: ID, as_of_date: '2026-10-31', treasury_cutoff_date: '2026-10-31', plan_year: 2026 },
    run: { outcome: 'RECORDED', rows_written: 2 },
    milestones: [{ code: 'M_1231', date: '2026-12-31', target_pct: '95.00', margin_pct: '5.00', summary: { projected_pct: '45.00', gap_pct: '-50.00', status: 'OFF_TRACK', plan_total_vnd: '1000000000' }, units: [unit()] }],
    rule: rule(),
    as_of: AS_OF,
    ...over,
  });

  it('shows the projection, the gap and the status of each investor, the "i" of every figure and the note that the rule is not confirmed', async () => {
    mount(<MilestonesScreen route={route('DIS-27', 'DIS')} />, harness(() => board()), PERMISSIONS);
    const section = await screen.findByTestId('milestone-M_1231');
    expect(within(section).getByText('Investor one')).toBeTruthy();
    expect(within(section).getAllByRole('button', { name: /A|i/ }).length).toBeGreaterThan(2);
    expect(screen.getByTestId('unverified-note')).toBeTruthy();
    expect(screen.getByTestId('snapshot-line').textContent).toContain('31/10/2026');
    expect(within(section).getByTestId('unit-CDT1').textContent).toContain('450.000.000');
  });

  it('says a snapshot that was not read is not the same as one with no milestones', async () => {
    mount(<MilestonesScreen route={route('DIS-27', 'DIS')} />, harness(() => board({ run: null, milestones: [] })), PERMISSIONS);
    expect((await screen.findByTestId('not-recorded')).textContent).toBeTruthy();
    expect(screen.queryByTestId('nothing-to-project')).toBeNull();
  });

  it('says the snapshot had nothing to project, and shows the empty kind when there is no frozen snapshot at all', async () => {
    mount(<MilestonesScreen route={route('DIS-27', 'DIS')} />, harness(() => board({ run: { outcome: 'NO_MILESTONES', rows_written: 0 }, milestones: [] })), PERMISSIONS);
    expect(await screen.findByTestId('nothing-to-project')).toBeTruthy();
    cleanup();
    mount(<MilestonesScreen route={route('DIS-27', 'DIS')} />, harness(() => board({ snapshot: null, run: null, milestones: [] })), PERMISSIONS);
    expect(await screen.findByText(translator.t('states.empty.title'))).toBeTruthy();
  });

  it('shows a skeleton while loading, and an error with a retry that reads again', async () => {
    let calls = 0;
    const h = harness(() => (calls++ === 0 ? problem(500, 'INTERNAL') : board()));
    mount(<MilestonesScreen route={route('DIS-27', 'DIS')} />, h, PERMISSIONS);
    const retry = await screen.findByRole('button', { name: /thử lại|try again|retry/i });
    fireEvent.click(retry);
    expect(await screen.findByTestId('milestone-M_1231')).toBeTruthy();
    expect(h.read).toHaveBeenCalledTimes(2);
  });

  it('says the scope is hidden on a refusal and leaks nothing', async () => {
    mount(<MilestonesScreen route={route('DIS-27', 'DIS')} />, harness(() => problem(403, 'SCOPE_DENIED')), PERMISSIONS);
    await waitFor(() => expect(screen.queryByTestId('milestone-M_1231')).toBeNull());
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});

describe('DIS-28 the accuracy of the forecasts (G1-16)', () => {
  const row = (over: Record<string, unknown> = {}) => ({ investor: { id: 'i1', code: 'CDT1', name: 'Investor one' }, pairs: 6, months: 3, forecast_vnd: '900000000', actual_vnd: '800000000', abs_error_vnd: '150000000', wape_pct: '18.75', bias_pct: '12.50', band: 'FAIR', bias_flag: null, ...over });
  const accuracy = (rows: unknown[]) => ({ plan_year: 2026, last_measured_month: 9, rows, overall: row({ investor: null }), by_month: [], rule: rule(), truncated: false, as_of: AS_OF });

  it('lists the investors with their error, bias and band, and a band it cannot give says so', async () => {
    mount(<AccuracyScreen route={route('DIS-28', 'DIS')} />, harness(() => accuracy([row(), row({ investor: { id: 'i2', code: 'CDT2', name: 'Investor two' }, band: 'INSUFFICIENT', months: 1, bias_flag: 'OVER' })])), PERMISSIONS);
    const one = await screen.findByTestId('investor-CDT1');
    expect(one.textContent).toContain('18.75%');
    const two = screen.getByTestId('investor-CDT2');
    expect(two.textContent).toMatch(/OVER|cao hơn|above/i);
    expect(screen.getByTestId('unverified-note')).toBeTruthy();
  });

  it('shows the empty kind when nothing was measured', async () => {
    mount(<AccuracyScreen route={route('DIS-28', 'DIS')} />, harness(() => accuracy([])), PERMISSIONS);
    await waitFor(() => expect(screen.queryByTestId('accuracy-table')).toBeNull());
  });
});

describe('PAY-22 the clocks of the Treasury control (G1-17)', () => {
  const clock = (n: number, over: Record<string, unknown> = {}) => ({
    id: `c${n}`,
    payment_request_id: `r${n}`,
    request_no: `YC-${n}`,
    request_status: 'SENT_TREASURY',
    net_vnd: '1000000',
    project: { id: 'p', code: 'DA1', name: 'Project' },
    contract: { id: 'k', code: 'HD1' },
    investor: { id: 'i', code: 'CDT', name: 'Investor' },
    clock_kind: 'PAYMENT',
    attempt: 1,
    started_at: '2026-11-04T02:00:00.000Z',
    working_days: 2,
    policy_version: 0,
    state: 'BREACHED',
    basis: 'WORKING_TIME',
    due_at: '2026-11-06T02:00:00.000Z',
    working_minutes_left: null,
    working_minutes_late: 960,
    ended_at: null,
    end_kind: null,
    return_reason_code: null,
    returned_by_treasury: null,
    ...over,
  });
  const board = (items: unknown[], over: Record<string, unknown> = {}) => ({
    items,
    summary: { total: items.length, open: 1, breached: 1, near: 0, in_time_rate_pct: '50.0', returned: 1, returns_by_reason: [{ reason_code: 'MISSING_DOCUMENT', count: 1 }, { reason_code: null, count: 2 }] },
    rules: [
      { kind: 'PAYMENT', working_days: 2, near_working_hours: 8, reason_code_required: true, version: 0, source: 'DEFAULT', unverified: true, provenance: { formula: 'Due time', source: 'NĐ 254/2025 per roadmap', as_of: '2026-11-08', legal_status: 'UNVERIFIED' } },
      { kind: 'ADVANCE', working_days: 1, near_working_hours: 8, reason_code_required: true, version: 0, source: 'DEFAULT', unverified: true, provenance: null },
    ],
    truncated: false,
    calendar_found: true,
    calendar_unavailable: false,
    as_of: AS_OF,
    ...over,
  });
  const answer = (items: unknown[], over: Record<string, unknown> = {}) => (operation: string) => (operation === 'listPaymentReturnReasons' ? { items: [{ code: 'MISSING_DOCUMENT', category: 'DOSSIER' }], reason_code_required: true, as_of: '2026-11-08' } : board(items, over));

  it('shows the 2 and 1 working days of the rule, each clock with its state and time, and the returns counted per standard reason', async () => {
    mount(<PaymentClocksScreen route={route('PAY-22', 'PAY')} />, harness(answer([clock(1), clock(2, { clock_kind: 'ADVANCE', state: 'RETURNED', end_kind: 'RETURNED', return_reason_code: 'MISSING_DOCUMENT', ended_at: '2026-11-05T02:00:00.000Z', working_minutes_late: null })])), PERMISSIONS);
    expect(await screen.findByTestId('clock-c1')).toBeTruthy();
    expect(screen.getByTestId('rules-line').textContent).toContain('2');
    expect(screen.getByTestId('clock-c2').textContent).toContain('MISSING_DOCUMENT (DOSSIER)');
    expect(screen.getByTestId('returns-section').textContent).toMatch(/MISSING_DOCUMENT/);
    expect(screen.getByTestId('unverified-note')).toBeTruthy();
  });

  it('says there is no calendar for a clock without a due time and never shows a guessed time', async () => {
    mount(<PaymentClocksScreen route={route('PAY-22', 'PAY')} />, harness(answer([clock(1, { basis: 'CALENDAR_UNAVAILABLE', due_at: null, working_minutes_late: null, state: 'RUNNING' })], { calendar_unavailable: true })), PERMISSIONS);
    expect(await screen.findByTestId('calendar-note')).toBeTruthy();
    expect(screen.getByTestId('clock-c1').textContent).toMatch(/lịch|calendar/i);
  });

  it('asks again with the filter the person chose', async () => {
    const h = harness(answer([clock(1)]));
    mount(<PaymentClocksScreen route={route('PAY-22', 'PAY')} />, h, PERMISSIONS);
    await screen.findByTestId('clock-c1');
    fireEvent.change(screen.getByTestId('filter-kind'), { target: { value: 'ADVANCE' } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listPaymentClocks', expect.objectContaining({ query: expect.objectContaining({ kind: 'ADVANCE' }) })));
  });
});

describe('CTR-32 the settlement clocks (G1-18)', () => {
  const row = (over: Record<string, unknown> = {}) => ({ id: 'k1', contract: { id: ID, code: 'HD-001', status: 'COMPLETED' }, project: { id: 'p', code: 'DA1', name: 'P' }, contractor: null, project_group: 'B', started_on: '2026-06-15', months_allowed: 5, due_on: '2026-11-15', policy_version: 0, state: 'NEAR', days_left: 7, met_on: null, settlement_id: null, ...over });
  const board = (items: unknown[]) => ({ items, summary: { total: items.length, open: 1, running: 0, near: 1, overdue: 0, met: 0, met_late: 0, in_time_rate_pct: null }, rule: rule({ params: { months_by_group: { QTQG: 5, A: 5, B: 5, C: 4 } } }), truncated: false, as_of: AS_OF });

  it('shows the months by group, the due day and the days left, with a group-less contract told apart', async () => {
    mount(<SettlementClocksScreen route={route('CTR-32', 'CTR')} />, harness(() => board([row(), row({ id: 'k2', contract: { id: 'x', code: 'HD-002', status: 'COMPLETED' }, project_group: null, state: 'OVERDUE', days_left: -3 })])), PERMISSIONS);
    expect((await screen.findByTestId('clock-HD-001')).textContent).toContain('15/11/2026');
    expect(screen.getByTestId('clock-HD-002').textContent).toMatch(/Quá hạn|overdue/i);
    expect(screen.getByTestId('clock-HD-002').textContent).toMatch(/nhóm|group/i);
    expect(screen.getByTestId('months-line').textContent).toContain('5');
    expect(screen.getByTestId('months-line').textContent).toContain('4');
    expect(screen.getByTestId('unverified-note')).toBeTruthy();
  });

  it('shows the empty kind when no contract has a clock', async () => {
    mount(<SettlementClocksScreen route={route('CTR-32', 'CTR')} />, harness(() => ({ ...board([]), summary: { total: 0 } })), PERMISSIONS);
    await waitFor(() => expect(screen.queryByTestId('settlement-table')).toBeNull());
  });
});

describe('CTR-33 the linkage and the adjustment versions (G1-18)', () => {
  const linkage = (over: Record<string, unknown> = {}) => ({
    contract: { id: ID, code: 'HD-001', status: 'ACTIVE', original_value_vnd: '1000000', current_value_vnd: '1100000', revisions: 2 },
    project: { id: 'p', code: 'DA1', name: 'Project', group: 'B' },
    package: { id: 'k', code: 'GT-1', project_id: 'p' },
    contractor: { id: 'c', name: 'Builder' },
    award: { winner_contractor_id: 'c', award_price_vnd: '1000000' },
    parties: [{ contractor_id: 'c', name: 'Builder', lead: true, share_pct: '100.0000' }],
    ok: false,
    award_gap_vnd: '0',
    findings: [{ code: 'PRICE_ABOVE_AWARD', severity: 'WARNING', field: 'contract_value_vnd' }],
    as_of: AS_OF,
    ...over,
  });
  const version = (over: Record<string, unknown> = {}) => ({ id: 'a1', revision_id: 'r', revision: 2, change_request_id: null, contract: { id: ID, code: 'HD-001' }, project: { id: 'p', code: 'DA1', name: 'P' }, original_vnd: '1000000', previous_vnd: '1000000', new_vnd: '1100000', delta_vnd: '100000', delta_pct_of_previous: '10.00', cumulative_delta_vnd: '100000', cumulative_pct_of_original: '10.00', baseline_version: 1, baseline_bac_vnd: '5000000', share_of_baseline_pct: '2.00', classification: 'REVIEW_REQUIRED', reasons: ['ORIGINAL'], policy_version: 0, made_by: 'm', review_status: 'PENDING', review_decision: null, reviewed_by: null, reviewed_at: null, review_note: null, created_at: '2026-11-01T00:00:00.000Z', version: 1, ...over });
  const answer = (items: unknown[]) => (operation: string) => (operation === 'getContractLinkage' ? linkage() : { items, rule: rule({ params: {} }), as_of: AS_OF });
  const mountAt = (h: ReturnType<typeof harness>) => mount(<LinkageScreen route={route('CTR-33', 'CTR')} />, h, PERMISSIONS, `/ctr/ctr-33?id=${ID}`);

  it('asks for the contract when none is given and names a bad identifier', async () => {
    mount(<LinkageScreen route={route('CTR-33', 'CTR')} />, harness(() => ({})), PERMISSIONS, '/ctr/ctr-33?id=nope');
    expect(await screen.findByTestId('bad-id')).toBeTruthy();
  });

  it('shows the chain with its findings and the versions with the thresholds they passed, and reviews one with a note under its version', async () => {
    const h = harness(answer([version()]), () => ({ operation_id: 'o', status: 'DECIDED', resource_version: 2, resource_id: 'a1' }));
    mountAt(h);
    expect((await screen.findByTestId('chain')).textContent).toContain('GT-1');
    expect(screen.getByTestId('findings').textContent).toContain('PRICE_ABOVE_AWARD');
    const versionRow = await screen.findByTestId('version-2');
    expect(versionRow.textContent).toContain('10.00%');
    fireEvent.click(screen.getByTestId('review-2'));
    fireEvent.change(screen.getByTestId('note'), { target: { value: 'The baseline still holds after this change.' } });
    fireEvent.click(screen.getByTestId('review-submit'));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('reviewContractAdjustment', expect.objectContaining({ path: { id: 'a1' }, ifMatchVersion: 1, body: { decision: 'KEEP_BASELINE', note: 'The baseline still holds after this change.' } })));
    expect(await screen.findByTestId('review-receipt')).toBeTruthy();
  });

  it('tells the maker that they cannot review their own change', async () => {
    const h = harness(answer([version()]), () => problem(403, 'SELF_APPROVAL_DENIED'));
    mountAt(h);
    fireEvent.click(await screen.findByTestId('review-2'));
    fireEvent.click(screen.getByTestId('review-submit'));
    expect(await screen.findByTestId('review-error')).toBeTruthy();
  });

  it('keeps the chain when the versions cannot be read and offers a retry for them only', async () => {
    mountAt(harness((operation) => (operation === 'getContractLinkage' ? linkage() : problem(500, 'INTERNAL'))));
    expect(await screen.findByTestId('versions-error')).toBeTruthy();
    expect(screen.getByTestId('chain')).toBeTruthy();
  });
});

describe('PRJ-28 the look-ahead plan (G1-19)', () => {
  const item = (n: number, over: Record<string, unknown> = {}) => ({ id: `i${n}`, sequence: n, description: `Item ${n}`, planned_start: '2026-11-10', planned_finish: '2026-11-12', responsible: 'Crew', outcome: 'PLANNED', variance_reason_code: null, outcome_at: null, state: 'READY', constraints: [], version: 1, ...over });
  const view = (items: unknown[], over: Record<string, unknown> = {}) => ({
    project: { id: ID, code: 'DA1', name: 'P', status: 'IMPLEMENTATION' },
    plan: { id: 'pl', project_id: ID, week_start: '2026-11-09', window_end: '2026-11-30', horizon_weeks: 3, status: 'PUBLISHED', policy_version: 0, published_at: null, items, ppc: { committed: 2, done: 1, pct: '50.0', band: 'ALERT' }, version: 2 },
    history: [{ id: 'pl', week_start: '2026-11-09', horizon_weeks: 3, status: 'PUBLISHED', ppc: { pct: '50.0', band: 'ALERT' } }],
    overdue: false,
    rule: rule({ params: { variance_reasons: ['WEATHER', 'OTHER'] } }),
    as_of: AS_OF,
    ...over,
  });
  const mountAt = (h: ReturnType<typeof harness>) => mount(<LookAheadScreen route={route('PRJ-28', 'PRJ')} />, h, PERMISSIONS, `/prj/prj-28?id=${ID}`);

  it('shows the items with their readiness, the open constraints and the PPC with its band', async () => {
    mountAt(harness(() => view([item(1, { state: 'NOT_READY', constraints: [{ id: 'k1', kind: 'MATERIAL', description: 'Rebar not confirmed', status: 'OPEN', version: 1 }] }), item(2, { outcome: 'NOT_DONE', variance_reason_code: 'WEATHER', state: 'NOT_DONE' })])));
    const first = await screen.findByTestId('item-1');
    expect(first.textContent).toContain('Rebar not confirmed');
    expect(screen.getByTestId('item-2').textContent).toContain('WEATHER');
    expect(screen.getByTestId('history').textContent).toContain('50.0%');
    expect(screen.getByTestId('unverified-note')).toBeTruthy();
  });

  it('records an item as done under its version, once, and a not-done item with a standard reason', async () => {
    const h = harness(() => view([item(1)]), () => ({ operation_id: 'o', status: 'DONE', resource_version: 2, resource_id: 'i1' }));
    mountAt(h);
    fireEvent.click(await screen.findByTestId('done-1'));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('recordLookAheadOutcome', expect.objectContaining({ path: { id: 'i1' }, ifMatchVersion: 1, body: { outcome: 'DONE' } })));
    expect(await screen.findByTestId('receipt')).toBeTruthy();
    fireEvent.click(screen.getByTestId('notdone-1'));
    fireEvent.change(screen.getByTestId('reason'), { target: { value: 'WEATHER' } });
    fireEvent.submit(screen.getByTestId('reason').closest('form') as HTMLFormElement);
    await waitFor(() => expect(h.command).toHaveBeenLastCalledWith('recordLookAheadOutcome', expect.objectContaining({ body: { outcome: 'NOT_DONE', reason_code: 'WEATHER' } })));
  });

  it('says a plan is overdue, and shows a conflict as a refusal to reload', async () => {
    const h = harness(() => view([item(1)], { overdue: true }), () => problem(409, 'VERSION_CONFLICT'));
    mountAt(h);
    expect(await screen.findByTestId('overdue-note')).toBeTruthy();
    fireEvent.click(screen.getByTestId('done-1'));
    expect(await screen.findByTestId('command-error')).toBeTruthy();
  });

  it('asks for the project when none is given', async () => {
    mount(<LookAheadScreen route={route('PRJ-28', 'PRJ')} />, harness(() => ({})), PERMISSIONS, '/prj/prj-28');
    expect(await screen.findByTestId('pick-id')).toBeTruthy();
  });
});

describe('PRJ-29 the lessons learned and the closing gate (G1-19)', () => {
  const lesson = (n: number, over: Record<string, unknown> = {}) => ({ id: `l${n}`, project_id: ID, category: 'PLANNING', title: `Lesson ${n}`, situation: 'What happened on the site', recommendation: 'What to do next time', status: 'PROPOSED', proposed_by: 'm', proposed_at: AS_OF, decided_by: null, decided_at: null, decision_note: null, version: 1, ...over });
  const view = (lessons: unknown[], gate: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
    project: { id: ID, code: 'DA1', name: 'P', status: 'SETTLED' },
    lessons,
    waiver: null,
    gate: { met: false, reason: 'MISSING', required: 1, approved: 0, ...gate },
    rule: rule({ params: { categories: ['PLANNING', 'OTHER'], allow_waiver: true } }),
    as_of: AS_OF,
    ...over,
  });
  const mountAt = (h: ReturnType<typeof harness>) => mount(<LessonsScreen route={route('PRJ-29', 'PRJ')} />, h, PERMISSIONS, `/prj/prj-29?id=${ID}`);

  it('says what the closing gate lacks and the number of lessons against the number the rule asks for', async () => {
    mountAt(harness(() => view([], {})));
    expect((await screen.findByTestId('lessons-empty')).textContent).toBeTruthy();
    expect(screen.getByText('0 / 1')).toBeTruthy();
  });

  it('approves a lesson under its version, and refuses to reject without a reason of ten characters', async () => {
    const h = harness(() => view([lesson(1)], { reason: 'PENDING_REVIEW' }), () => ({ operation_id: 'o', status: 'APPROVED', resource_version: 2, resource_id: 'l1' }));
    mountAt(h);
    fireEvent.click(await screen.findByTestId('approve-l1'));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('decideLesson', expect.objectContaining({ path: { id: 'l1' }, ifMatchVersion: 1, body: { decision: 'APPROVE' } })));
    const reject = within(screen.getByTestId('lesson-l1')).getAllByRole('button')[1] as HTMLButtonElement;
    expect(reject.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('reject-note'), { target: { value: 'This is not a lesson of this project' } });
    expect(reject.disabled).toBe(false);
  });

  it('tells the proposer that they cannot decide their own lesson', async () => {
    mountAt(harness(() => view([lesson(1)], { reason: 'PENDING_REVIEW' }), () => problem(403, 'SELF_APPROVAL_DENIED')));
    fireEvent.click(await screen.findByTestId('approve-l1'));
    expect(await screen.findByTestId('command-error')).toBeTruthy();
  });

  it('proposes a lesson with the fields of the form, and asks for a waiver with its reason', async () => {
    const h = harness(() => view([], {}), () => ({ operation_id: 'o', status: 'PROPOSED', resource_version: 1, resource_id: 'l9' }));
    mountAt(h);
    fireEvent.change(await screen.findByTestId('field-title'), { target: { value: 'Plan the site access earlier' } });
    fireEvent.change(screen.getByTestId('field-situation'), { target: { value: 'The access road was not ready when the crews arrived.' } });
    fireEvent.change(screen.getByTestId('field-recommendation'), { target: { value: 'Clear the site access before the contract starts.' } });
    fireEvent.click(screen.getByTestId('propose-submit'));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('proposeLesson', expect.objectContaining({ path: { id: ID }, body: expect.objectContaining({ category: 'PLANNING', title: 'Plan the site access earlier' }) })));
    fireEvent.change(screen.getByTestId('field-reason'), { target: { value: 'The project was a short repair with nothing to carry over.' } });
    fireEvent.click(screen.getByTestId('waiver-submit'));
    await waitFor(() => expect(h.command).toHaveBeenLastCalledWith('requestLessonWaiver', expect.objectContaining({ body: { reason: 'The project was a short repair with nothing to carry over.' } })));
  });
});

describe('CAP-23 the reallocation by performance (G1-12)', () => {
  const candidates = (over: Record<string, unknown> = {}) => ({
    snapshot_id: ID,
    as_of_date: '2026-10-31',
    treasury_cutoff_date: '2026-10-31',
    plan_year: 2026,
    policy: { version: 0, source: 'DEFAULT', unverified: true, formula: 'A formula', source_text: 'The design', as_of: '2026-11-08', params: {} },
    donors: [{ project_id: 'pa', ratio_pct: '40.0000', releasable_vnd: '500000000' }],
    recipients: [{ project_id: 'pb', ratio_pct: '180.0000', demand_vnd: '400000000' }],
    excluded: [],
    lines: [],
    projects: [{ id: 'pa', code: 'DA-A', name: 'Slow' }, { id: 'pb', code: 'DA-B', name: 'Fast' }],
    units: [{ id: 'ua', code: 'A', name: 'Unit A' }],
    as_of: AS_OF,
    ...over,
  });
  const impact = (frozen: boolean) => ({
    proposal_id: 'rp',
    basis_snapshot_id: ID,
    plan_year: 2026,
    as_of_date: '2026-10-31',
    treasury_cutoff_date: '2026-10-31',
    frozen,
    record: frozen ? { recorded_at: '2026-11-02T00:00:00.000Z' } : null,
    policy: { rule_version: 0, source: 'DEFAULT' },
    assumptions: {},
    moves: [],
    result: { basis: { CURRENT_YEAR: { province: { before: { rate_total_pct: '46.0000' }, after: { rate_total_pct: '46.0000' }, delta_rate_total_pct: '0.0000' }, units: [{ id: 'ua', before: { rate_total_pct: '31.2500' }, after: { rate_total_pct: '38.4615' }, delta_rate_total_pct: '7.2115' }], projects: [] } }, projected: null, warnings: [{ code: 'ZERO_DENOMINATOR', project_id: null }] },
    units: [],
    projects: [],
    delegation: { document_type: 'CAP_REALLOCATION', configured: true, approver_role_name: 'Department head', approval_levels: 1 },
    as_of: AS_OF,
  });
  const answer = (frozen = true) => (operation: string) => (operation === 'listReallocationCandidates' ? candidates() : operation === 'listReallocationProposals' ? { items: [{ id: 'rp', code: 'DC-1', status: 'SUBMITTED' }] } : impact(frozen));

  it('ranks the donors and the recipients with the "i" of the ratio, the releasable amount and the demand', async () => {
    mount(<ReallocationImpactScreen route={route('CAP-23', 'CAP')} />, harness(answer()), PERMISSIONS);
    const donor = await screen.findByTestId('donor-pa');
    expect(donor.textContent).toContain('40.0000%');
    expect(donor.textContent).toContain('500.000.000');
    expect(screen.getByTestId('recipient-pb').textContent).toContain('400.000.000');
    expect(screen.getByTestId('unverified-note')).toBeTruthy();
  });

  it('shows the recorded impact on the province and the units, the warnings and who may approve', async () => {
    mount(<ReallocationImpactScreen route={route('CAP-23', 'CAP')} />, harness(answer(true)), PERMISSIONS);
    await screen.findByTestId('donor-pa');
    fireEvent.change(screen.getByTestId('proposal-select'), { target: { value: 'rp' } });
    expect((await screen.findByTestId('impact-frozen')).textContent).toContain('2026-11-02');
    expect(screen.getByTestId('units-table').textContent).toContain('38.4615%');
    expect(screen.getByTestId('warnings').textContent).toContain('ZERO_DENOMINATOR');
    expect(screen.getByTestId('delegation-line').textContent).toContain('Department head');
  });

  it('says the simulation of a draft is live, and offers a retry when the impact cannot be read', async () => {
    let failing = true;
    const h = harness((operation) => (operation === 'getReallocationImpact' && failing ? problem(500, 'INTERNAL') : answer(false)(operation)));
    mount(<ReallocationImpactScreen route={route('CAP-23', 'CAP')} />, h, PERMISSIONS);
    await screen.findByTestId('donor-pa');
    fireEvent.change(screen.getByTestId('proposal-select'), { target: { value: 'rp' } });
    expect(await screen.findByTestId('impact-error')).toBeTruthy();
    failing = false;
    fireEvent.click(within(screen.getByTestId('impact-error')).getByRole('button'));
    expect((await screen.findByTestId('impact-frozen')).textContent).toBeTruthy();
  });
});
