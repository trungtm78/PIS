import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import part from '../../i18n/vi.json';
import type { WebRoute } from '../../routes/types';
import { problemMessage } from '../pay/payment/labels';
import { harness, mount } from '../sas/test-support';
import BaselineScreen from './BaselineScreen';
import DisbursementCheckScreen from './DisbursementCheckScreen';
import EvmScreen from './EvmScreen';

const catalogue = { ...(vi_ as Record<string, string>), ...(part as Record<string, string>) };
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), catalogue[key] ?? key);
const routeOf = (id: string, module: string): WebRoute => ({ id, path: `/${module.toLowerCase()}/${id.toLowerCase()}`, title: id, kind: 'board', area: 'investment', module, group: 'Kiểm soát vốn', role: 'workspace', parent: null, req: `FR-${id}` });
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PROJECT = uuid(1);
const PACKAGE = uuid(2);
const CONTRACT = uuid(3);
const REQUEST = uuid(4);
const ALERT = uuid(5);
const SNAPSHOT = uuid(6);
const refusal = (code: string, status = 422, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type Answer = unknown | ((input: Record<string, unknown>) => unknown);
/** A client whose reads are answered by the operation. */
const serve = (answers: Record<string, Answer>, commands: Record<string, Answer> = {}) =>
  harness(
    (operation, input) => {
      const answer = answers[operation];
      if (answer === undefined) return new Error(`unexpected read ${operation}`);
      return typeof answer === 'function' ? (answer as (input: unknown) => unknown)(input) : answer;
    },
    (operation, input) => {
      const answer = commands[operation];
      return typeof answer === 'function' ? (answer as (input: unknown) => unknown)(input) : (answer ?? {});
    },
  );

// ---- PRJ-26 -----------------------------------------------------------------------------------------------------------------

const baseline = (overrides: Record<string, unknown> = {}) => ({
  project_id: PROJECT,
  project_code: 'DA-01',
  project_status: 'IMPLEMENTATION',
  has_baseline: true,
  versions: [
    { id: uuid(10), version: 0, kind: 'V0', basis: 'BASELINE', total_investment_vnd: '100000000000', bac_vnd: '90000000000', planned_start: '2026-01-01', planned_finish: '2027-12-31', source_revision_id: null, taken_by: uuid(11), taken_at: '2026-02-01T03:00:00.000Z', lines: [{ component_id: PACKAGE, code: 'GT-1', name: 'Foundation', bac_vnd: '50000000000', planned_start: '2026-01-01', planned_finish: '2026-12-31' }] },
    { id: uuid(12), version: 1, kind: 'REVISION', basis: 'PLANNED', total_investment_vnd: '112000000000', bac_vnd: '99000000000', planned_start: '2026-01-01', planned_finish: '2028-02-28', source_revision_id: uuid(13), taken_by: uuid(11), taken_at: '2026-08-01T03:00:00.000Z', lines: [] },
  ],
  current: { total_investment_vnd: '112000000000', bac_vnd: '99000000000', forecast_finish: '2028-02-28' },
  deviation: { cost_vnd: '12000000000', cost_pct: '12.00', bac_vnd: '9000000000', bac_pct: '10.00', finish_slip_days: 59, forecast_finish: '2028-02-28', milestones: [{ code: 'M-1', baseline_date: '2026-06-30', planned_date: '2026-09-30', slip_days: 92, moves: 3 }, { code: 'M-2', baseline_date: '2026-10-30', planned_date: '2026-10-30', slip_days: 0, moves: 0 }] },
  reasons: ['COST'],
  reschedule: { count: 3, project_moves: 1, per_milestone: [{ milestone_id: uuid(14), code: 'M-1', moves: 3 }], events: [{ id: uuid(15), source: 'MILESTONE', milestone_id: uuid(14), milestone_code: 'M-1', revision_id: null, from_date: '2026-06-30', to_date: '2026-09-30', reason: 'Rain', recorded_by: uuid(11), recorded_at: '2026-07-01T03:00:00.000Z' }] },
  alerts: [{ id: ALERT, project_id: PROJECT, project_code: 'DA-01', alert_type: 'RESCHEDULE_COUNT', audience: 'AUD', subject_kind: 'MILESTONE', subject_id: uuid(14), subject_code: 'M-1', move_count: 3, threshold: 3, rule_version: '1', status: 'OPEN', raised_by: uuid(11), raised_at: '2026-09-01T03:00:00.000Z', acknowledged_by: null, acknowledged_at: null, acknowledge_note: null, version: 4 }],
  reappraisals: [
    { id: REQUEST, baseline_id: uuid(10), status: 'OPEN', reasons: ['COST'], cost_pct: '12.00', finish_slip_days: 59, threshold_cost_pct: '10', threshold_slip_days: 90, rule_version: '1', triggered_by: 'REVISION', requested_by: uuid(11), requested_at: '2026-08-01T03:00:00.000Z', decided_by: null, decided_at: null, decision_reason: null, version: 2 },
    { id: uuid(16), baseline_id: uuid(10), status: 'WAIVED', reasons: ['SLIP'], cost_pct: null, finish_slip_days: 100, threshold_cost_pct: '10', threshold_slip_days: 90, rule_version: '1', triggered_by: 'MILESTONE', requested_by: uuid(11), requested_at: '2026-05-01T03:00:00.000Z', decided_by: uuid(17), decided_at: '2026-05-02T03:00:00.000Z', decision_reason: 'Accepted by the board', version: 3 },
  ],
  policy: { version: '1', source: 'BUILT_IN', cost_pct: 10, slip_days: 90, reschedule_alert_count: 3 },
  actions: { capture: false, decide_reappraisal: true, acknowledge_alert: true },
  as_of: '2026-11-08T03:00:00.000Z',
  ...overrides,
});

describe('PRJ-26: the baseline, the deviation and the number of moves', () => {
  const route = routeOf('PRJ-26', 'PRJ');
  const open = (state: unknown, commands: Record<string, Answer> = {}) => {
    const h = serve({ getProjectBaseline: state }, commands);
    mount(<BaselineScreen route={route} />, h, ['project.baseline.read'], `/prj/prj-26?project=${PROJECT}`);
    return h;
  };

  it('says what to open it from when the address names no project, and reads no project (only the register of alerts)', () => {
    const h = serve({ listGovernanceAlerts: { items: [], as_of: '2026-11-08' } });
    mount(<BaselineScreen route={route} />, h, ['project.baseline.read'], '/prj/prj-26');
    expect(screen.getByTestId('no-target').textContent).toBe(text('govb1.baseline.noTarget'));
    expect(h.read.mock.calls.every((call) => call[0] === 'listGovernanceAlerts')).toBe(true);
  });

  it('shows the versions, the deviation against the thresholds, the policy as not confirmed, the moves, the events, the requests and the alerts', async () => {
    const h = open(baseline());
    expect(await screen.findByText(text('govb1.baseline.kind.v0'))).toBeTruthy();
    expect(h.read.mock.calls[0]?.[0]).toBe('getProjectBaseline');
    expect(h.read.mock.calls[0]?.[1]).toMatchObject({ path: { id: PROJECT } });
    expect(screen.getByText(text('govb1.baseline.kind.revision', { version: 1 }))).toBeTruthy();
    expect(screen.getByText('100.000.000.000')).toBeTruthy();
    expect(screen.getByText('31/12/2027')).toBeTruthy();
    // The deviation: the cost is beyond the threshold (12 > 10), the finish slip is within it (59 < 90).
    const cost = screen.getByText(text('govb1.baseline.kpi.cost')).closest('article');
    expect(cost?.className).toContain('ui-tone-danger');
    expect(within(cost as HTMLElement).getByText('12.000.000.000')).toBeTruthy();
    expect(within(cost as HTMLElement).getByText(text('govb1.baseline.kpi.pct', { pct: '12.00' }))).toBeTruthy();
    const slip = screen.getByText(text('govb1.baseline.kpi.slip')).closest('article');
    expect(slip?.className).not.toContain('ui-tone-danger');
    expect(within(slip as HTMLElement).getByText(text('govb1.baseline.days', { count: 59 }))).toBeTruthy();
    expect(screen.getByText(text('govb1.baseline.beyond'))).toBeTruthy();
    expect(screen.getByText(text('govb1.baseline.reason.cost', {}), { selector: '[data-testid="reasons"] span span' })).toBeTruthy();
    // The policy line: thresholds, rule version, and "not confirmed" because it is the built-in value.
    expect(screen.getByTestId('policy').textContent).toContain(text('govb1.baseline.policy', { cost: 10, days: 90, moves: 3, version: '1' }));
    expect(screen.getByTestId('policy').textContent).toContain(text('govb1.policy.builtIn'));
    // A milestone moved as many times as the alert count is marked in words.
    expect(screen.getByText(text('govb1.baseline.milestones.alerted'))).toBeTruthy();
    expect(screen.getByTestId('reschedule-count').textContent).toBe(text('govb1.baseline.events.count', { count: 3, project: 1 }));
    expect(screen.getByText('Rain')).toBeTruthy();
    expect(screen.getByText(text('govb1.reapp.status.open'))).toBeTruthy();
    expect(screen.getByText(text('govb1.reapp.status.waived'))).toBeTruthy();
    expect(screen.getByText(text('govb1.alerts.status.open'))).toBeTruthy();
    expect(screen.getByText(text('govb1.alerts.audience'))).toBeTruthy();
    // Every table has a caption and the screen opens the screens that follow from it.
    expect(document.querySelectorAll('table caption').length).toBeGreaterThanOrEqual(5);
    expect(screen.getByTestId('link-evm').getAttribute('href')).toBe(`/prj/prj-27?project=${PROJECT}`);
    expect(screen.getByTestId('link-pay').getAttribute('href')).toBe(`/pay/pay-19?project=${PROJECT}`);
    expect(document.querySelector('.ui-context__asof')?.textContent).toContain('08/11/2026');
  });

  it('shows an approved policy as a rule version, and a deviation that cannot be computed as such, never as zero', async () => {
    open(baseline({ policy: { version: '7', source: 'RULE', cost_pct: 10, slip_days: 90, reschedule_alert_count: 3 }, deviation: { cost_vnd: '0', cost_pct: null, bac_vnd: '0', bac_pct: null, finish_slip_days: null, forecast_finish: null, milestones: [] }, reasons: [] }));
    expect(await screen.findByText(text('govb1.policy.rule', { version: '7' }))).toBeTruthy();
    expect(screen.getByText(text('govb1.baseline.within'))).toBeTruthy();
    expect(screen.getByText(text('govb1.baseline.kpi.slip.none'))).toBeTruthy();
    expect(screen.getAllByText(text('govb1.common.na')).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(text('govb1.baseline.days', { count: 0 }))).toBeNull();
    cleanup();
    open(baseline({ deviation: null }));
    expect((await screen.findByTestId('no-deviation')).textContent).toBe(text('govb1.baseline.deviation.none'));
  });

  it('says there is no baseline and offers the capture only to a person who may take it', async () => {
    open(baseline({ has_baseline: false, versions: [], deviation: null, reasons: [], alerts: [], reappraisals: [], actions: { capture: false, decide_reappraisal: false, acknowledge_alert: false } }));
    expect((await screen.findByTestId('no-baseline')).textContent).toBe(text('govb1.baseline.none'));
    expect(screen.queryByTestId('capture-open')).toBeNull();
    cleanup();
    open(baseline({ has_baseline: false, versions: [], deviation: null, reasons: [], alerts: [], reappraisals: [], actions: { capture: true, decide_reappraisal: false, acknowledge_alert: false } }));
    expect(await screen.findByTestId('capture-open')).toBeTruthy();
  });

  it('takes version 0 after a confirmation that names the effect, once, and says it is done', async () => {
    const empty = baseline({ has_baseline: false, versions: [], deviation: null, reasons: [], alerts: [], reappraisals: [], actions: { capture: true, decide_reappraisal: false, acknowledge_alert: false } });
    const h = open(empty, { captureProjectBaseline: { status: 'TAKEN' } });
    fireEvent.click(await screen.findByTestId('capture-open'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(text('govb1.baseline.capture.effect.text'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: text('govb1.baseline.capture.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('captureProjectBaseline');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: PROJECT }, body: {} });
    expect((await screen.findByTestId('message')).textContent).toBe(text('govb1.baseline.capture.done'));
  });

  it.each([
    ['BASELINE_NO_WBS', 'govb1.refusal.noWbs'],
    ['BASELINE_ALREADY_TAKEN', 'govb1.refusal.alreadyTaken'],
  ])('shows the refusal %s with the way to fix it', async (code, key) => {
    const empty = baseline({ has_baseline: false, versions: [], deviation: null, reasons: [], alerts: [], reappraisals: [], actions: { capture: true, decide_reappraisal: false, acknowledge_alert: false } });
    open(empty, { captureProjectBaseline: refusal(code, code === 'BASELINE_ALREADY_TAKEN' ? 409 : 422) });
    fireEvent.click(await screen.findByTestId('capture-open'));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: text('govb1.baseline.capture.confirm') }));
    expect((await screen.findByTestId('message')).textContent).toBe(text(key));
    expect(screen.getByTestId('capture-problem').textContent).toContain(text(key));
    expect(screen.getByTestId('fix-components').getAttribute('href')).toBe(`/prj/prj-05?project=${PROJECT}`);
  });

  it('lists each component that makes the baseline incomplete, with the links to fix them', async () => {
    const empty = baseline({ has_baseline: false, versions: [], deviation: null, reasons: [], alerts: [], reappraisals: [], actions: { capture: true, decide_reappraisal: false, acknowledge_alert: false } });
    open(empty, { captureProjectBaseline: refusal('BASELINE_INCOMPLETE', 422, { issues: [{ code: 'NO_FINISH_DATE', component_code: 'GT-7' }, { code: 'FINISH_BEFORE_START', component_code: 'GT-9' }] }) });
    fireEvent.click(await screen.findByTestId('capture-open'));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: text('govb1.baseline.capture.confirm') }));
    const issues = await screen.findByTestId('capture-issues');
    expect(within(issues).getByText(text('govb1.baseline.issue.line', { code: 'GT-7', problem: text('govb1.issue.noFinish') }))).toBeTruthy();
    expect(within(issues).getByText(text('govb1.baseline.issue.line', { code: 'GT-9', problem: text('govb1.issue.beforeStart') }))).toBeTruthy();
    expect(screen.getByTestId('capture-problem').textContent).toContain(text('govb1.refusal.incomplete'));
    expect(screen.getByTestId('fix-milestones').getAttribute('href')).toBe(`/prj/prj-07?project=${PROJECT}`);
    expect(screen.getByTestId('fix-components')).toBeTruthy();
  });

  it('decides a request with a reason and the version it saw, and says each refusal in words', async () => {
    const h = open(baseline(), { decideReappraisalRequest: { status: 'STARTED' } });
    fireEvent.click(await screen.findByRole('button', { name: text('govb1.reapp.start') }));
    const dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: text('govb1.reapp.start') });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'The cost is beyond the line' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('decideReappraisalRequest');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: REQUEST }, ifMatchVersion: 2, body: { decision: 'START', reason: 'The cost is beyond the line' } });
    expect((await screen.findByTestId('message')).textContent).toBe(text('govb1.reapp.done'));
  });

  it.each([
    ['SELF_APPROVAL_DENIED', 403, 'govb1.refusal.selfApproval'],
    ['REAPPRAISAL_STATE_INVALID', 409, 'govb1.refusal.reappraisalState'],
    ['VERSION_CONFLICT', 409, 'govb1.refusal.versionConflict'],
  ])('shows the refusal %s of a decision', async (code, status, key) => {
    const h = open(baseline(), { decideReappraisalRequest: refusal(code, status) });
    fireEvent.click(await screen.findByRole('button', { name: text('govb1.reapp.waive') }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Accepted' } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('govb1.reapp.waive') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { decision: 'WAIVE', reason: 'Accepted' } });
    expect((await screen.findByTestId('message')).textContent).toBe(text(key));
  });

  it('acknowledges an alert with a note and the version it saw, and says each refusal in words', async () => {
    const h = open(baseline(), { acknowledgeGovernanceAlert: { status: 'ACKNOWLEDGED' } });
    fireEvent.click(await screen.findByRole('button', { name: text('govb1.alerts.acknowledge') }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Noted by the audit team' } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('govb1.alerts.acknowledge') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('acknowledgeGovernanceAlert');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: ALERT }, ifMatchVersion: 4, body: { note: 'Noted by the audit team' } });
    expect((await screen.findByTestId('message')).textContent).toBe(text('govb1.alerts.acknowledge.done'));
  });

  it.each([
    ['SELF_APPROVAL_DENIED', 403, 'govb1.refusal.selfApproval'],
    ['GOVERNANCE_ALERT_STATE_INVALID', 409, 'govb1.refusal.alertState'],
    ['VERSION_CONFLICT', 409, 'govb1.refusal.versionConflict'],
  ])('shows the refusal %s of an acknowledgement', async (code, status, key) => {
    const h = open(baseline(), { acknowledgeGovernanceAlert: refusal(code, status) });
    fireEvent.click(await screen.findByRole('button', { name: text('govb1.alerts.acknowledge') }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Noted' } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('govb1.alerts.acknowledge') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect((await screen.findByTestId('message')).textContent).toBe(text(key));
  });

  it('a person who may not act has no buttons, and a closed request or acknowledged alert has none either', async () => {
    open(baseline({ actions: { capture: false, decide_reappraisal: false, acknowledge_alert: false } }));
    await screen.findByText(text('govb1.reapp.status.open'));
    expect(document.querySelector('[data-action="start"]')).toBeNull();
    expect(document.querySelector('[data-action="waive"]')).toBeNull();
    expect(document.querySelector('[data-action="acknowledge"]')).toBeNull();
    cleanup();
    open(baseline());
    await screen.findByText(text('govb1.reapp.status.open'));
    // One open request (the waived one has no button) and one open alert.
    expect(document.querySelectorAll('[data-action="start"]').length).toBe(1);
    expect(document.querySelectorAll('[data-action="acknowledge"]').length).toBe(1);
  });

  it('says a project that is not there for the caller, a forbidden read, and a failing read with a retry', async () => {
    open(refusal('RESOURCE_NOT_FOUND', 404));
    expect((await screen.findByTestId('missing')).textContent).toBe(text('govb1.baseline.missing'));
    cleanup();
    open(refusal('SCOPE_DENIED', 403));
    expect((await screen.findByRole('alert')).textContent).toContain(text('states.denied.title'));
    expect(screen.queryByTestId('missing')).toBeNull();
    cleanup();
    let calls = 0;
    open(() => ((calls += 1) === 1 ? new Error('boom') : baseline()));
    const failed = await screen.findByRole('alert');
    expect(failed.textContent).toContain(text('states.error.title'));
    expect(screen.queryByTestId('missing')).toBeNull();
    fireEvent.click(within(failed).getByRole('button', { name: text('states.retry.action') }));
    expect(await screen.findByText(text('govb1.baseline.kind.v0'))).toBeTruthy();
  });

  it('shows a skeleton and no number while the read is in flight', () => {
    const h = harness(() => new Promise(() => undefined) as never);
    mount(<BaselineScreen route={route} />, h, ['project.baseline.read'], `/prj/prj-26?project=${PROJECT}`);
    expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText('0')).toBeNull();
  });
});

// ---- PRJ-27 -----------------------------------------------------------------------------------------------------------------

const figures = (overrides: Record<string, unknown> = {}) => ({
  status: 'OK',
  as_of: '2026-11-08',
  eac_method: 'CPI_CUMULATIVE',
  bac_vnd: '90000000000',
  pv_vnd: '40000000000',
  ev_vnd: '36000000000',
  ac_vnd: '38000000000',
  cpi: '0.9474',
  spi: '0.9000',
  eac_vnd: '94999999999',
  etc_vnd: '56999999999',
  vac_vnd: '-4999999999',
  tcpi: '1.0370',
  unavailable: {},
  missing: [],
  rag_cpi: 'AMBER',
  rag_spi: 'RED',
  ...overrides,
});

const insufficient = figures({
  status: 'INSUFFICIENT',
  pv_vnd: null,
  ev_vnd: null,
  ac_vnd: null,
  cpi: null,
  spi: null,
  eac_vnd: null,
  etc_vnd: null,
  vac_vnd: null,
  tcpi: null,
  unavailable: { cpi: 'AC_ZERO', spi: 'PV_ZERO', ev: 'NO_DATA' },
  missing: ['NO_CONTRACT_LINK', 'NO_BASELINE'],
  rag_cpi: null,
  rag_spi: null,
});

const evm = (overrides: Record<string, unknown> = {}) => ({
  project_id: PROJECT,
  project_code: 'DA-01',
  scope: 'PROJECT',
  ref: null,
  as_of: '2026-11-08',
  source: 'LIVE',
  snapshot_id: null,
  frozen_at: null,
  payload_sha256: null,
  baseline: { version: 1, selection: 'CURRENT' },
  figures: figures(),
  eac_against_total: { over_vnd: '-5000000001', over_pct: '-5.00' },
  total_investment_vnd: '100000000000',
  rows: [{ key: PACKAGE, code: 'GT-1', name: 'Foundation', bac_vnd: '50000000000', pv_vnd: '30000000000', ev_vnd: '28000000000', ac_vnd: '29000000000', cpi: '0.9655', spi: '0.9333', rag_cpi: 'GREEN', rag_spi: 'AMBER', missing: [], contracts: [{ contract_id: CONTRACT, code: 'HD-001', value_vnd: '48000000000' }] }, { key: uuid(20), code: 'GT-2', name: 'Roof', bac_vnd: '40000000000', pv_vnd: '10000000000', ev_vnd: null, ac_vnd: null, cpi: null, spi: null, rag_cpi: null, rag_spi: null, missing: ['NO_CONTRACT_LINK'], contracts: [] }],
  policy: { version: '1', source: 'BUILT_IN', eac_method: 'CPI_CUMULATIVE', amber_below: 0.95, red_below: 0.85 },
  ...overrides,
});

const curve = (overrides: Record<string, unknown> = {}) => ({
  project_id: PROJECT,
  project_code: 'DA-01',
  scope: 'PROJECT',
  ref: null,
  as_of: '2026-11-08',
  baseline: { version: 1, selection: 'CURRENT' },
  points: [
    { day: '2026-01-01', pv_v0_vnd: '0', pv_current_vnd: '0', ev_vnd: '0', ac_vnd: '0' },
    { day: '2026-06-30', pv_v0_vnd: '20000000000', pv_current_vnd: '18000000000', ev_vnd: '17000000000', ac_vnd: '19000000000' },
    { day: '2026-11-08', pv_v0_vnd: '40000000000', pv_current_vnd: '36000000000', ev_vnd: '36000000000', ac_vnd: '38000000000' },
    { day: '2027-12-31', pv_v0_vnd: '90000000000', pv_current_vnd: '99000000000', ev_vnd: null, ac_vnd: null },
  ],
  figures: figures(),
  missing: [],
  source: 'LIVE',
  policy: evm().policy,
  ...overrides,
});

const links = {
  items: [{ id: uuid(30), component_id: PACKAGE, component_code: 'GT-1', contract_id: CONTRACT, contract_code: 'HD-001', contract_value_vnd: '48000000000', linked_at: '2026-03-01T03:00:00.000Z' }],
  as_of: '2026-11-08',
};

const exportFile = { file_name: 'duong-s-DA-01-2026-11-08.xlsx', content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size_bytes: 6, sha256: 'abc', content_base64: 'AAECAwT/', as_of: '2026-11-08' };

describe('PRJ-27: earned value and the S-curve', () => {
  const route = routeOf('PRJ-27', 'PRJ');
  const permissions = ['project.evm.read', 'project.evm.link'];
  const open = (answers: Record<string, Answer> = {}, commands: Record<string, Answer> = {}, perms: readonly string[] = permissions) => {
    const h = serve({ getProjectEvm: evm(), getProjectSCurve: curve(), getProjectBaseline: baseline(), listProjectComponentContracts: links, exportProjectSCurve: exportFile, ...answers }, commands);
    mount(<EvmScreen route={route} />, h, perms, `/prj/prj-27?project=${PROJECT}`);
    return h;
  };
  const kpi = (label: string): HTMLElement => screen.getByText(text(label), { selector: '.ui-kpi__label' }).closest('article') as HTMLElement;

  it('says what to open it from when the address names no project, and reads nothing', () => {
    const h = serve({});
    mount(<EvmScreen route={route} />, h, permissions, '/prj/prj-27');
    expect(screen.getByTestId('no-target').textContent).toBe(text('govb1.evm.noTarget'));
    expect(h.read).not.toHaveBeenCalled();
  });

  it('shows the nine figures, the colour band of the indices in words, the method named, the policy and the packages with their contracts', async () => {
    open();
    expect(await screen.findByText('36.000.000.000', { selector: '.ui-kpi__value' })).toBeTruthy();
    expect(within(kpi('govb1.evm.kpi.pv')).getByText('40.000.000.000')).toBeTruthy();
    expect(within(kpi('govb1.evm.kpi.ac')).getByText('38.000.000.000')).toBeTruthy();
    expect(within(kpi('govb1.evm.kpi.cpi')).getByText('0.9474')).toBeTruthy();
    expect(within(kpi('govb1.evm.kpi.cpi')).getByText(text('govb1.rag.amber'))).toBeTruthy();
    expect(within(kpi('govb1.evm.kpi.spi')).getByText(text('govb1.rag.red'))).toBeTruthy();
    expect(kpi('govb1.evm.kpi.spi').className).toContain('ui-tone-danger');
    expect(within(kpi('govb1.evm.kpi.eac')).getByText('94.999.999.999')).toBeTruthy();
    expect(within(kpi('govb1.evm.kpi.eac')).getByText(text('govb1.evm.kpi.eac.sub', { method: text('govb1.method.cpi') }))).toBeTruthy();
    expect(within(kpi('govb1.evm.kpi.etc')).getByText('56.999.999.999')).toBeTruthy();
    expect(within(kpi('govb1.evm.kpi.vac')).getByText('-4.999.999.999')).toBeTruthy();
    expect(within(kpi('govb1.evm.kpi.tcpi')).getByText('1.0370')).toBeTruthy();
    expect(within(kpi('govb1.evm.kpi.over')).getByText('-5.000.000.001')).toBeTruthy();
    expect(kpi('govb1.evm.kpi.over').className).not.toContain('ui-tone-danger');
    expect(screen.getByTestId('formula').textContent).toContain(text('govb1.policy.builtIn'));
    expect(screen.queryByTestId('frozen')).toBeNull();
    expect(screen.queryByTestId('insufficient')).toBeNull();
    // The packages: money from the strings, a package with no contract says so and does not show zero.
    const table = screen.getByRole('table', { name: text('govb1.evm.rows.title') });
    expect(within(table).getByText('GT-1 · Foundation')).toBeTruthy();
    expect(within(table).getByText('HD-001 (48.000.000.000)')).toBeTruthy();
    expect(within(table).getByText(text('govb1.evm.rows.noContract'))).toBeTruthy();
    expect(within(table).getByText(text('govb1.reason.noContractLink'))).toBeTruthy();
    expect(screen.getByTestId('link-baseline').getAttribute('href')).toBe(`/prj/prj-26?project=${PROJECT}`);
  });

  it('a figure that cannot be known says why and what to do, and is never shown as zero', async () => {
    open({ getProjectEvm: evm({ figures: insufficient, eac_against_total: null, rows: [] }) });
    const box = await screen.findByTestId('insufficient');
    expect(box.textContent).toContain(text('govb1.evm.insufficient'));
    const reasons = within(screen.getByTestId('reasons'));
    for (const [code, reason, hint] of [
      ['NO_CONTRACT_LINK', 'govb1.reason.noContractLink', 'govb1.hint.noContractLink'],
      ['NO_BASELINE', 'govb1.reason.noBaseline', 'govb1.hint.noBaseline'],
      ['AC_ZERO', 'govb1.reason.acZero', 'govb1.hint.acZero'],
      ['PV_ZERO', 'govb1.reason.pvZero', 'govb1.hint.pvZero'],
      ['NO_DATA', 'govb1.reason.noData', 'govb1.hint.noData'],
    ]) {
      const item = document.querySelector(`[data-reason="${code}"]`) as HTMLElement;
      expect(item, code).not.toBeNull();
      expect(within(item).getByText(text(reason as string))).toBeTruthy();
      expect(within(item).getByText(text(hint as string))).toBeTruthy();
    }
    expect(reasons.getAllByRole('listitem')).toHaveLength(5);
    // No tile shows a zero for what is unknown: each says "not enough data", the indices with their own reason.
    for (const label of ['govb1.evm.kpi.pv', 'govb1.evm.kpi.ev', 'govb1.evm.kpi.ac', 'govb1.evm.kpi.cpi', 'govb1.evm.kpi.spi', 'govb1.evm.kpi.eac', 'govb1.evm.kpi.etc', 'govb1.evm.kpi.vac', 'govb1.evm.kpi.tcpi', 'govb1.evm.kpi.over']) {
      expect(within(kpi(label)).getByText(text('govb1.common.na')), label).toBeTruthy();
    }
    expect(within(kpi('govb1.evm.kpi.cpi')).getByText(text('govb1.reason.acZero'))).toBeTruthy();
    expect(within(kpi('govb1.evm.kpi.spi')).getByText(text('govb1.reason.pvZero'))).toBeTruthy();
    expect(within(kpi('govb1.evm.kpi.ev')).getByText(text('govb1.reason.noData'))).toBeTruthy();
    expect(screen.queryByText('0', { selector: '.ui-kpi__value' })).toBeNull();
  });

  it('a frozen result carries a badge with the snapshot and the hash', async () => {
    open({ getProjectEvm: evm({ source: 'FROZEN', snapshot_id: SNAPSHOT, frozen_at: '2026-10-05T03:00:00.000Z', payload_sha256: 'deadbeef'.repeat(8) }) });
    const badge = await screen.findByTestId('frozen');
    expect(badge.textContent).toContain(SNAPSHOT);
    expect(badge.textContent).toContain('deadbeef'.repeat(8));
    expect(badge.textContent).toContain('05/10/2026');
    expect(screen.getByText(text('govb1.evm.frozen'))).toBeTruthy();
  });

  it('draws actual EV and AC solid, both plans dashed, and the day of the view, with the same figures in a table that the toggle shows', async () => {
    open();
    await screen.findByRole('img', { name: text('govb1.evm.chart.caption', { code: 'DA-01' }) });
    const plotted = Array.from(document.querySelectorAll('svg.ui-flow__svg g.ui-flow__series')).map((group) => group.getAttribute('class') ?? '');
    expect(plotted.filter((name) => name.includes('ui-flow__series--plan'))).toHaveLength(2);
    expect(plotted.filter((name) => name.includes('ui-flow__series--actual-')).length).toBeGreaterThanOrEqual(3);
    const legend = document.querySelector('.ui-flow__legend')?.textContent ?? '';
    for (const key of ['govb1.evm.series.ev', 'govb1.evm.series.ac', 'govb1.evm.series.pvV0', 'govb1.evm.series.pvCurrent']) expect(legend).toContain(text(key));
    expect(legend).toContain(text('govb1.evm.series.asOf', { day: '08/11/2026' }));
    // The accessible table of the kit is always there; the visible table is one press away and has every point.
    expect(document.querySelector('table.ui-sr-only')).not.toBeNull();
    expect(screen.queryByRole('table', { name: text('govb1.evm.curve.table') })).toBeNull();
    const toggle = screen.getByTestId('toggle-table');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    const table = screen.getByRole('table', { name: text('govb1.evm.curve.table') });
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 4);
    expect(within(table).getByText('90.000.000.000')).toBeTruthy();
    expect(within(table).getAllByText(text('govb1.common.na')).length).toBe(2);
    expect(screen.getByTestId('chart-note').textContent).toBe(text('govb1.evm.chart.note', { count: 4 }));
  });

  it('says there is no baseline when the curve has no version 0, with the way to take it, and keeps the figures', async () => {
    open({ getProjectSCurve: refusal('BASELINE_MISSING') });
    const notice = await screen.findByTestId('curve-no-baseline');
    expect(notice.textContent).toContain(text('govb1.evm.curve.noBaseline'));
    expect(within(notice).getByRole('link').getAttribute('href')).toBe(`/prj/prj-26?project=${PROJECT}`);
    expect((screen.getByTestId('export') as HTMLButtonElement).disabled).toBe(true);
    expect(await screen.findByText('36.000.000.000', { selector: '.ui-kpi__value' })).toBeTruthy();
  });

  it('exports the workbook: asks the server for it and saves the decoded bytes under its name', async () => {
    const saved: Array<{ blob: Blob; name: string }> = [];
    let blob: Blob | undefined;
    (URL as unknown as { createObjectURL: (value: Blob) => string }).createObjectURL = (value) => {
      blob = value;
      return 'blob:test';
    };
    (URL as unknown as { revokeObjectURL: (value: string) => void }).revokeObjectURL = () => undefined;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      if (blob !== undefined) saved.push({ blob, name: this.download });
    });
    const h = open();
    await screen.findByTestId('toggle-table');
    await waitFor(() => expect((screen.getByTestId('export') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('export'));
    await waitFor(() => expect(saved).toHaveLength(1));
    const call = h.read.mock.calls.find((entry) => entry[0] === 'exportProjectSCurve');
    expect(call?.[1]).toMatchObject({ path: { id: PROJECT }, query: { scope: 'PROJECT' } });
    expect(saved[0]?.name).toBe(exportFile.file_name);
    expect(saved[0]?.blob.type).toBe(exportFile.content_type);
    const bytes = await new Promise<number[]>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve([...new Uint8Array(reader.result as ArrayBuffer)]);
      reader.readAsArrayBuffer(saved[0]?.blob as Blob);
    });
    expect(bytes).toEqual([0, 1, 2, 3, 4, 255]);
    expect((await screen.findByTestId('message')).textContent).toBe(text('govb1.evm.export.done', { name: exportFile.file_name }));
  });

  it('a failing export is said in words and saves nothing', async () => {
    const save = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    open({ exportProjectSCurve: refusal('BASELINE_MISSING') });
    await waitFor(() => expect((screen.getByTestId('export') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('export'));
    expect((await screen.findByTestId('message')).textContent).toBe(text('govb1.refusal.baselineMissing'));
    expect(save).not.toHaveBeenCalled();
  });

  it('reads again for another day, never for a day after today, and passes the baseline that was chosen', async () => {
    const h = open();
    await screen.findByTestId('as-of');
    const evmCalls = () => h.read.mock.calls.filter((entry) => entry[0] === 'getProjectEvm');
    await waitFor(() => expect(evmCalls()).toHaveLength(1));
    expect((evmCalls()[0]?.[1] as { query: Record<string, string> }).query).toEqual({ scope: 'PROJECT', baseline: 'CURRENT' });
    const input = screen.getByTestId('as-of') as HTMLInputElement;
    expect(input.max).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    fireEvent.change(input, { target: { value: '2026-06-30' } });
    await waitFor(() => expect(evmCalls()).toHaveLength(2));
    expect((evmCalls()[1]?.[1] as { query: Record<string, string> }).query).toEqual({ as_of: '2026-06-30', scope: 'PROJECT', baseline: 'CURRENT' });
    expect(h.read.mock.calls.some((entry) => entry[0] === 'getProjectSCurve' && (entry[1] as { query: Record<string, string> }).query.as_of === '2026-06-30')).toBe(true);
    fireEvent.change(input, { target: { value: '2999-01-01' } });
    expect(input.value).toBe('2026-06-30');
    expect(evmCalls()).toHaveLength(2);
    fireEvent.change(screen.getByTestId('baseline'), { target: { value: 'V0' } });
    await waitFor(() => expect(evmCalls()).toHaveLength(3));
    expect((evmCalls()[2]?.[1] as { query: Record<string, string> }).query).toMatchObject({ as_of: '2026-06-30', baseline: 'V0' });
  });

  it('switches to a package or a contract with a select fed by the baseline and the links, and reads nothing until one is chosen', async () => {
    const h = open();
    await screen.findByTestId('scope');
    const evmCalls = () => h.read.mock.calls.filter((entry) => entry[0] === 'getProjectEvm');
    await waitFor(() => expect(evmCalls()).toHaveLength(1));
    fireEvent.change(screen.getByTestId('scope'), { target: { value: 'COMPONENT' } });
    expect((await screen.findByTestId('choose-ref')).textContent).toBe(text('govb1.evm.ref.needed'));
    expect(evmCalls()).toHaveLength(1);
    const select = (await screen.findByTestId('ref')) as HTMLSelectElement;
    await waitFor(() => expect(within(select).getByText('GT-1 · Foundation')).toBeTruthy());
    fireEvent.change(select, { target: { value: PACKAGE } });
    await waitFor(() => expect(evmCalls()).toHaveLength(2));
    expect((evmCalls()[1]?.[1] as { query: Record<string, string> }).query).toEqual({ scope: 'COMPONENT', ref: PACKAGE, baseline: 'CURRENT' });
    fireEvent.change(screen.getByTestId('scope'), { target: { value: 'CONTRACT' } });
    const contracts = (await screen.findByTestId('ref')) as HTMLSelectElement;
    expect(contracts.value).toBe('');
    expect(within(contracts).getByText('HD-001')).toBeTruthy();
    fireEvent.change(contracts, { target: { value: CONTRACT } });
    await waitFor(() => expect(evmCalls()).toHaveLength(3));
    expect((evmCalls()[2]?.[1] as { query: Record<string, string> }).query).toMatchObject({ scope: 'CONTRACT', ref: CONTRACT });
  });

  it('lists the links, links a contract to a package and ends a link, and says the refusal in words', async () => {
    const h = open({}, { linkContractComponent: (input: unknown) => ((input as { body: { component_id: string | null } }).body.component_id === null ? refusal('COMPONENT_CONTRACT_UNCHANGED', 409) : { status: 'LINKED' }) });
    const panel = (await screen.findByRole('heading', { name: text('govb1.link.title') })).closest('section') as HTMLElement;
    await waitFor(() => expect(within(panel).getByRole('option', { name: 'GT-1 · Foundation' })).toBeTruthy());
    await waitFor(() => expect(within(panel).getByRole('option', { name: 'HD-001' })).toBeTruthy());
    expect(within(panel).getByRole('table', { name: text('govb1.link.title') })).toBeTruthy();
    expect(within(panel).getAllByText('HD-001').length).toBeGreaterThan(0);
    const submit = within(panel).getByTestId('link-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(within(panel).getByTestId('link-contract-id'), { target: { value: 'not-an-id' } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(within(panel).getByTestId('link-contract-id'), { target: { value: '' } });
    fireEvent.change(within(panel).getByTestId('link-contract'), { target: { value: CONTRACT } });
    fireEvent.change(within(panel).getByTestId('link-component'), { target: { value: PACKAGE } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('linkContractComponent');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: PROJECT }, body: { contract_id: CONTRACT, component_id: PACKAGE } });
    expect((await screen.findByTestId('message')).textContent).toBe(text('govb1.link.linked'));
    fireEvent.change(within(panel).getByTestId('link-component'), { target: { value: '' } });
    fireEvent.click(within(panel).getByTestId('link-submit'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
    expect(h.command.mock.calls[1]?.[1]).toMatchObject({ body: { contract_id: CONTRACT, component_id: null } });
    await waitFor(() => expect(screen.getByTestId('message').textContent).toBe(text('govb1.refusal.componentUnchanged')));
  });

  it('a contract that is not in the list can be linked by its identifier', async () => {
    const h = open({}, { linkContractComponent: { status: 'LINKED' } });
    const panel = (await screen.findByRole('heading', { name: text('govb1.link.title') })).closest('section') as HTMLElement;
    await waitFor(() => expect(within(panel).getByRole('option', { name: 'GT-1 · Foundation' })).toBeTruthy());
    fireEvent.change(within(panel).getByTestId('link-contract-id'), { target: { value: uuid(99).toUpperCase() } });
    fireEvent.change(within(panel).getByTestId('link-component'), { target: { value: PACKAGE } });
    fireEvent.click(within(panel).getByTestId('link-submit'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { contract_id: uuid(99), component_id: PACKAGE } });
  });

  it('a person who may not link has no form, and a person who may not read the links still has the figures', async () => {
    open({}, {}, ['project.evm.read']);
    await screen.findByRole('heading', { name: text('govb1.link.title') });
    expect(screen.queryByTestId('link-submit')).toBeNull();
    cleanup();
    open({ listProjectComponentContracts: refusal('SCOPE_DENIED', 403) });
    expect((await screen.findByTestId('links-denied')).textContent).toBe(text('govb1.link.denied'));
    expect(screen.queryByTestId('link-submit')).toBeNull();
    expect(await screen.findByText('36.000.000.000', { selector: '.ui-kpi__value' })).toBeTruthy();
  });

  it('says a project that is not there for the caller, a forbidden read, and a failing read with a retry', async () => {
    open({ getProjectEvm: refusal('RESOURCE_NOT_FOUND', 404) });
    expect((await screen.findByTestId('missing')).textContent).toBe(text('govb1.evm.missing'));
    cleanup();
    open({ getProjectEvm: refusal('SCOPE_DENIED', 403) });
    expect((await screen.findAllByRole('alert'))[0]?.textContent).toContain(text('states.denied.title'));
    cleanup();
    let calls = 0;
    open({ getProjectEvm: () => ((calls += 1) === 1 ? new Error('boom') : evm()) });
    const failed = (await screen.findAllByRole('alert'))[0] as HTMLElement;
    expect(failed.textContent).toContain(text('states.error.title'));
    expect(screen.queryByTestId('missing')).toBeNull();
    fireEvent.click(within(failed).getByRole('button', { name: text('states.retry.action') }));
    expect(await screen.findByText('36.000.000.000', { selector: '.ui-kpi__value' })).toBeTruthy();
  });

  it('shows a skeleton and no figure while the read is in flight', () => {
    const h = harness(() => new Promise(() => undefined) as never);
    mount(<EvmScreen route={route} />, h, permissions, `/prj/prj-27?project=${PROJECT}`);
    expect(screen.getAllByRole('status').some((element) => element.getAttribute('aria-busy') === 'true')).toBe(true);
    expect(document.querySelector('.ui-kpi__value')).toBeNull();
  });
});

// ---- PAY-19 -----------------------------------------------------------------------------------------------------------------

const verdict = (overrides: Record<string, unknown> = {}) => ({
  project_id: PROJECT,
  project_code: 'DA-01',
  allowed: false,
  refusal: 'DISBURSEMENT_PROJECT_NOT_LISTED',
  fix: 'COMPLETE_STAGE_TRANSITION',
  cause: { project_status: 'PROPOSAL', allocated_vnd: '0' },
  warnings: [],
  policy_version: '2',
  as_of: '2026-11-08',
  ...overrides,
});

describe('PAY-19: the precondition of a disbursement', () => {
  const route = routeOf('PAY-19', 'PAY');
  const open = (state: unknown) => {
    const h = serve({ checkProjectDisbursement: state });
    mount(<DisbursementCheckScreen route={route} />, h, ['payment_request.read'], `/pay/pay-19?project=${PROJECT}`);
    return h;
  };

  it('says what to open it from when the address names no project, and reads nothing', () => {
    const h = serve({});
    mount(<DisbursementCheckScreen route={route} />, h, ['payment_request.read'], '/pay/pay-19');
    expect(screen.getByTestId('no-target').textContent).toBe(text('govb1.pay.noTarget'));
    expect(h.read).not.toHaveBeenCalled();
  });

  it('refuses a project that is not on the list: the stage, the cause, and the fix with the link to the project', async () => {
    const h = open(verdict());
    const box = await screen.findByTestId('verdict');
    expect(box.getAttribute('data-allowed')).toBe('no');
    expect(within(box).getByText(text('govb1.pay.refused'))).toBeTruthy();
    expect(h.read.mock.calls[0]?.[0]).toBe('checkProjectDisbursement');
    expect(screen.getByTestId('cause').textContent).toContain(text('govb1.pay.cause.notListed', { stage: 'PROPOSAL' }));
    expect(within(screen.getByTestId('facts')).getByText('PROPOSAL')).toBeTruthy();
    expect(screen.getByTestId('fix').getAttribute('data-fix')).toBe('COMPLETE_STAGE_TRANSITION');
    expect(screen.getByTestId('fix').textContent).toContain(text('govb1.pay.fix.stage'));
    expect(screen.getByTestId('fix-project').getAttribute('href')).toBe(`/prj/prj-03?id=${PROJECT}`);
    expect(screen.getByText(text('govb1.pay.fact.policy.value', { version: '2' }))).toBeTruthy();
    expect(screen.getByTestId('paper-note').textContent).toBe(text('govb1.pay.paper'));
    expect(screen.queryByTestId('warning-reappraisal')).toBeNull();
  });

  it('refuses a project with no approved plan on the system: the amount it holds and the links to the capital plan', async () => {
    open(verdict({ refusal: 'DISBURSEMENT_NO_APPROVED_PLAN', fix: 'ENTER_APPROVED_PLAN', cause: { project_status: 'IMPLEMENTATION', allocated_vnd: '0' } }));
    await screen.findByTestId('verdict');
    expect(screen.getByTestId('cause').textContent).toContain(text('govb1.pay.cause.noPlan', { amount: '0' }));
    expect(screen.getByTestId('fix').getAttribute('data-fix')).toBe('ENTER_APPROVED_PLAN');
    expect(screen.getByTestId('fix-plan').getAttribute('href')).toBe('/cap/cap-06');
    expect(screen.getByTestId('fix-annual').getAttribute('href')).toBe('/cap/cap-03');
    expect(screen.queryByTestId('fix-project')).toBeNull();
  });

  it('allows a project that meets the precondition, with the warning of an open request to appraise again and a link to it', async () => {
    open(verdict({ allowed: true, refusal: null, fix: null, cause: { project_status: 'IMPLEMENTATION', allocated_vnd: '25000000000' }, warnings: ['REAPPRAISAL_OPEN'] }));
    const box = await screen.findByTestId('verdict');
    expect(box.getAttribute('data-allowed')).toBe('yes');
    expect(within(box).getByText(text('govb1.pay.allowed'))).toBeTruthy();
    expect(within(screen.getByTestId('facts')).getByText('25.000.000.000')).toBeTruthy();
    expect(screen.queryByTestId('cause')).toBeNull();
    expect(screen.queryByTestId('fix')).toBeNull();
    expect(screen.getByTestId('warning-reappraisal').textContent).toContain(text('govb1.pay.warning.reappraisal'));
    expect(screen.getByTestId('link-baseline').getAttribute('href')).toBe(`/prj/prj-26?project=${PROJECT}`);
    expect(screen.getByTestId('paper-note')).toBeTruthy();
  });

  it('says a project that is not there for the caller, a forbidden read, and a failing read with a retry', async () => {
    open(refusal('RESOURCE_NOT_FOUND', 404));
    expect((await screen.findByTestId('missing')).textContent).toBe(text('govb1.pay.missing'));
    cleanup();
    open(refusal('SCOPE_DENIED', 403));
    expect((await screen.findByRole('alert')).textContent).toContain(text('states.denied.title'));
    cleanup();
    let calls = 0;
    open(() => ((calls += 1) === 1 ? new Error('boom') : verdict()));
    const failed = await screen.findByRole('alert');
    expect(failed.textContent).toContain(text('states.error.title'));
    fireEvent.click(within(failed).getByRole('button', { name: text('states.retry.action') }));
    expect(await screen.findByTestId('verdict')).toBeTruthy();
  });

  it('a payment draft that is refused for these causes says the cause and the fix', () => {
    const translate = (key: string): string => catalogue[key] ?? key;
    expect(problemMessage(translate, 'disbursementNotListed')).toBe(text('govb1.pay.error.notListed'));
    expect(problemMessage(translate, 'disbursementNoPlan')).toBe(text('govb1.pay.error.noPlan'));
    expect(text('govb1.pay.error.notListed')).toContain('Cách khắc phục');
    expect(text('govb1.pay.error.noPlan')).toContain('Cách khắc phục');
  });
});
