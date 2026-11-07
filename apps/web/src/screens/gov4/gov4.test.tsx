import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import part from '../../i18n/vi.json';
import { harness, mount } from '../sas/test-support';
import type { WebRoute } from '../../routes/types';
import ChangeTierScreen from './ChangeTierScreen';
import ContractControlScreen from './ContractControlScreen';
import RecoveryTableScreen from './RecoveryTableScreen';
import ReserveScreen from './ReserveScreen';

const catalogue = { ...(vi_ as Record<string, string>), ...(part as Record<string, string>) };
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), catalogue[key] ?? key);
const routeOf = (id: string, module: string): WebRoute => ({ id, path: `/${module.toLowerCase()}/${id.toLowerCase()}`, title: id, kind: 'table', area: 'investment', module, group: 'Kiểm soát vốn', role: 'workspace', parent: null, req: `FR-${id}` });
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PROJECT = uuid(1);
const CONTRACT = uuid(2);
const CHANGE = uuid(3);
const ADVANCE = uuid(4);
const RISK = uuid(5);
const DRAWDOWN = uuid(6);
const DOCUMENT = uuid(7);
const refusal = (code: string, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions: {} });

afterEach(() => cleanup());

const availability = {
  contract: { id: CONTRACT, code: 'HD-001', status: 'ACTIVE', project_id: PROJECT },
  money: { current_price_vnd: '10000000000', original_price_vnd: '9000000000', approved_variation_vnd: '1000000000', pending_increase_vnd: '700000000', requested_total_vnd: '4000000000', paid_total_vnd: '3000000000', advance_outstanding_vnd: '600000000', cash_out_vnd: '3600000000', remaining_payable_vnd: '6000000000', cash_headroom_vnd: '6400000000', requested_pct: '40.00', within_price: true },
  line: { allocation_line_id: uuid(8), allocated_vnd: '60000000000', reserved_vnd: '0', committed_vnd: '10000000000', disbursed_vnd: '3000000000', contract_committed_vnd: '10000000000', contract_commits_within_line: true, verdict: { state: 'OK', reason: null, consumption_pct: '21.66', used_vnd: '13000000000', available_vnd: '47000000000' } },
  change_orders: [{ id: CHANGE, code: 'CO-001', status: 'EVALUATED', delta_vnd: '700000000', allocation_line_id: uuid(8), verdict: { state: 'WARN', reason: null, consumption_pct: '92.00', used_vnd: '1', available_vnd: '1' } }],
  as_of: '2026-11-08T03:00:00.000Z',
};
const eac = { project_id: PROJECT, project_code: 'DA-01', eac_vnd: '12000000000', approved_total_vnd: '10000000000', verdict: 'OVER', over_by_vnd: '2000000000', over_pct: '20.00', raises_alert: true, allocated_vnd: '9000000000', funding_gap_vnd: '3000000000', method: 'CONTRACT_PRICES_PLUS_PENDING', contract_count: 1, policy: { version: null, source: 'DEFAULT', eac_alert_above_pct: '0' }, as_of: '2026-11-08T03:00:00.000Z' };

describe('CAP-22: the contract against its price, the estimate against the approved total', () => {
  const route = routeOf('CAP-22', 'CAP');
  it('says what to open it from when the address names nothing, and reads nothing', () => {
    const h = harness(() => ({}));
    mount(<ContractControlScreen route={route} />, h, ['capital.read'], '/cap/cap-22');
    expect(screen.getByTestId('no-target').textContent).toBe(text('govb2.control.noTarget'));
    expect(h.read).not.toHaveBeenCalled();
  });

  it('shows the price in force, what is left to pay, the capital line, each change order against it, the formula and the time it was read', async () => {
    const h = harness((operation) => (operation === 'getContractAvailability' ? availability : eac));
    mount(<ContractControlScreen route={route} />, h, ['capital.read'], `/cap/cap-22?contract=${CONTRACT}&project=${PROJECT}`);
    expect((await screen.findAllByText('10.000.000.000')).length).toBeGreaterThan(0);
    expect(screen.getByText('6.000.000.000')).toBeTruthy();
    expect(screen.getAllByText(text('govb2.control.within')).length).toBe(2);
    expect(screen.getByTestId('contract-formula').textContent).toBe(text('govb2.control.contract.formula'));
    expect(within(screen.getByTestId('line')).getByText(text('govb2.control.verdict', { state: 'OK', pct: '21.66' }))).toBeTruthy();
    expect(screen.getByText('CO-001')).toBeTruthy();
    expect(screen.getByText(text('govb2.control.verdict', { state: 'WARN', pct: '92.00' }))).toBeTruthy();
    expect(screen.getByText(text('govb2.control.changes.status.evaluated'))).toBeTruthy();
    // The estimate: over the approved total, with the gap in capital and the method that made it.
    expect(await screen.findByText(text('govb2.control.eac.verdict.alert'))).toBeTruthy();
    expect(screen.getByText('3.000.000.000')).toBeTruthy();
    expect(screen.getByTestId('eac-formula').textContent).toContain(text('govb2.policy.default'));
    expect(document.querySelector('.ui-context__asof')?.textContent).toContain('08/11/2026');
  });

  it('a contract that is not there for the caller says so, and a failing read is an error with a retry, never an empty list', async () => {
    mount(<ContractControlScreen route={route} />, harness(() => refusal('RESOURCE_NOT_FOUND', 404)), ['capital.read'], `/cap/cap-22?contract=${CONTRACT}`);
    expect((await screen.findByTestId('contract-missing')).textContent).toBe(text('govb2.control.contract.missing'));
    cleanup();
    mount(<ContractControlScreen route={route} />, harness(() => new Error('boom')), ['capital.read'], `/cap/cap-22?contract=${CONTRACT}`);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByTestId('contract-missing')).toBeNull();
  });

  it('shows no alert for an estimate within the approved total', async () => {
    mount(<ContractControlScreen route={route} />, harness(() => ({ ...eac, verdict: 'WITHIN', over_by_vnd: '0', over_pct: null, raises_alert: false, funding_gap_vnd: '0' })), ['capital.read'], `/cap/cap-22?project=${PROJECT}`);
    expect(await screen.findByText(text('govb2.control.eac.verdict.within'))).toBeTruthy();
  });
});

const funds = [
  {
    id: uuid(10),
    kind: 'CONTINGENCY',
    balance_vnd: '1500000000',
    version: 3,
    entries: [
      { id: uuid(11), entry_kind: 'DRAWDOWN', amount_vnd: '500000000', balance_after_vnd: '1500000000', risk_id: RISK, change_request_id: null, drawdown_id: DRAWDOWN, reason: 'Wet foundation', requested_by: uuid(12), approved_by: uuid(13), posted_at: '2026-11-07T01:00:00.000Z' },
      { id: uuid(14), entry_kind: 'FUND', amount_vnd: '2000000000', balance_after_vnd: '2000000000', risk_id: null, change_request_id: null, drawdown_id: null, reason: 'Allotted', requested_by: uuid(12), approved_by: null, posted_at: '2026-11-06T01:00:00.000Z' },
    ],
    open_drawdowns: [{ id: DRAWDOWN, amount_vnd: '300000000', risk_id: RISK, change_request_id: null, reason: 'More piles', requested_by: uuid(12), requested_at: '2026-11-08T01:00:00.000Z', version: 1 }],
  },
];
const reserve = (overrides: Record<string, unknown> = {}) => ({
  project_id: PROJECT,
  project_code: 'DA-01',
  funds,
  risks: [
    { id: RISK, code: 'R-1', title: 'Wet foundation', status: 'OPEN', probability_pct: '50.00', cost_impact_vnd: '4000000000', expected_value_vnd: '2000000000' },
    { id: uuid(15), code: 'R-2', title: 'Late permit', status: 'OPEN', probability_pct: null, cost_impact_vnd: null, expected_value_vnd: null },
  ],
  expected_value_vnd: '2000000000',
  unassessed_risk_count: 1,
  contingency_cover: { balance_vnd: '1500000000', expected_value_vnd: '2000000000', shortfall_vnd: '500000000', covered: false, cover_pct: '75.00' },
  policy: { version: null, source: 'DEFAULT', cover_alert_below_pct: '100' },
  actions: { fund: true, request_drawdown: true, decide_drawdown: true, set_exposure: true },
  as_of: '2026-11-08T03:00:00.000Z',
  ...overrides,
});

describe('PRJ-22: the contingency and the management reserve', () => {
  const route = routeOf('PRJ-22', 'PRJ');
  const open = (state: unknown, command: (operation: string, input: unknown) => unknown = () => ({}), permissions: readonly string[] = ['project.reserve.read']) => {
    const h = harness(() => state, command);
    mount(<ReserveScreen route={route} />, h, permissions, `/prj/prj-22?project=${PROJECT}`);
    return h;
  };

  it('shows the funds with their ledger, who asked and who approved, the cover, the formula and the risks without exposure', async () => {
    open(reserve());
    expect((await screen.findAllByText('Wet foundation', { exact: false })).length).toBeGreaterThan(0);
    expect(screen.getByText(text('govb2.reserve.fund.balance', { amount: '1.500.000.000' }))).toBeTruthy();
    expect(screen.getByText(text('govb2.reserve.cover.short', { amount: '500.000.000' }))).toBeTruthy();
    expect(screen.getByTestId('unassessed').textContent).toBe(text('govb2.reserve.unassessed', { count: 1 }));
    expect(screen.getByTestId('formula').textContent).toContain(text('govb2.policy.default'));
    expect(screen.getByText(text('govb2.reserve.risks.unassessed'))).toBeTruthy();
    expect(screen.getByText('-500.000.000')).toBeTruthy();
    expect(screen.getByText('+2.000.000.000')).toBeTruthy();
    expect(document.querySelectorAll('.ui-maker-checker').length).toBeGreaterThan(1);
  });

  it('says there is no fund, and a project that is not there for the caller', async () => {
    open(reserve({ funds: [], risks: [], unassessed_risk_count: 0, contingency_cover: null, expected_value_vnd: '0' }));
    expect((await screen.findByTestId('no-funds')).textContent).toBe(text('govb2.reserve.noFunds'));
    cleanup();
    const h = harness(() => refusal('RESOURCE_NOT_FOUND', 404));
    mount(<ReserveScreen route={route} />, h, ['project.reserve.read'], `/prj/prj-22?project=${PROJECT}`);
    expect((await screen.findByTestId('missing')).textContent).toBe(text('govb2.reserve.missing'));
  });

  it('a person who may not act has no buttons and no forms', async () => {
    open(reserve({ actions: { fund: false, request_drawdown: false, decide_drawdown: false, set_exposure: false } }));
    await screen.findByText(text('govb2.reserve.fund.balance', { amount: '1.500.000.000' }));
    expect(document.querySelector('[data-action="approve"]')).toBeNull();
    expect(screen.queryByTestId('fund-submit')).toBeNull();
    expect(screen.queryByTestId('draw-submit')).toBeNull();
    expect(screen.queryByTestId('exposure-submit')).toBeNull();
  });

  it('fills a fund only with a valid amount, a document and a reason, and sends it once', async () => {
    const h = open(reserve(), () => ({ status: 'FUNDED' }));
    await screen.findByTestId('fund-submit');
    const submit = screen.getByTestId('fund-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('fund-amount'), { target: { value: '1000000' } });
    fireEvent.change(screen.getByTestId('fund-document'), { target: { value: 'not-an-id' } });
    fireEvent.change(screen.getByTestId('fund-reason'), { target: { value: 'Allotted by the decision' } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('fund-document'), { target: { value: DOCUMENT } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('fundProjectReserve');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: PROJECT }, body: { kind: 'CONTINGENCY', amount_vnd: '1000000', authority_document_version_id: DOCUMENT, reason: 'Allotted by the decision' } });
    expect((await screen.findByTestId('message')).textContent).toBe(text('govb2.reserve.fund.done'));
  });

  it('asks to draw for one risk or one change order, never both and never neither', async () => {
    const h = open(reserve(), () => ({ status: 'REQUESTED' }));
    await screen.findByTestId('draw-submit');
    const submit = screen.getByTestId('draw-submit') as HTMLButtonElement;
    fireEvent.change(screen.getByTestId('draw-amount'), { target: { value: '1000' } });
    fireEvent.change(screen.getByTestId('draw-reason'), { target: { value: 'Because' } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('draw-risk'), { target: { value: RISK } });
    expect(submit.disabled).toBe(false);
    fireEvent.change(screen.getByTestId('draw-change'), { target: { value: CHANGE } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('draw-risk'), { target: { value: '' } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { kind: 'CONTINGENCY', amount_vnd: '1000', change_request_id: CHANGE, reason: 'Because' } });
    expect((h.command.mock.calls[0]?.[1] as { body: Record<string, unknown> }).body).not.toHaveProperty('risk_id');
  });

  it('approves a drawdown with a reason and the version it saw, and shows the refusal of the server in its code', async () => {
    const h = open(reserve(), (operation) => (operation === 'decideReserveDrawdown' ? refusal('SELF_APPROVAL_DENIED', 403) : {}));
    await screen.findAllByText('Wet foundation', { exact: false });
    const approve = document.querySelector('[data-action="approve"]') as HTMLButtonElement;
    fireEvent.click(approve);
    const dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: text('govb2.reserve.decide.approve') });
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Confirmed by the supervisor' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('decideReserveDrawdown');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: DRAWDOWN }, ifMatchVersion: 1, body: { decision: 'approve', reason: 'Confirmed by the supervisor' } });
    expect((await screen.findByTestId('message')).textContent).toBe(text('govb2.reserve.error.refused', { code: 'SELF_APPROVAL_DENIED' }));
  });

  it('sets what a risk would cost with a valid share and amount', async () => {
    const h = open(reserve(), () => ({ status: 'SET' }));
    await screen.findByTestId('exposure-submit');
    const submit = screen.getByTestId('exposure-submit') as HTMLButtonElement;
    fireEvent.change(screen.getByTestId('exposure-probability'), { target: { value: '120' } });
    fireEvent.change(screen.getByTestId('exposure-cost'), { target: { value: '1000' } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('exposure-probability'), { target: { value: '12.5' } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: RISK }, body: { probability_pct: '12.5', cost_impact_vnd: '1000' } });
  });
});

const tier = (overrides: Record<string, unknown> = {}) => ({
  change_id: CHANGE,
  code: 'CO-003',
  stage: 'CO',
  status: 'EVALUATED',
  version: 4,
  contract_id: CONTRACT,
  project_id: PROJECT,
  tier: 3,
  cumulative_after_vnd: '1100000000',
  cumulative_pct: '11.00',
  delta_pct: '11.00',
  forces_adjustment: true,
  authority_amount_vnd: '1100000000',
  funding: { needs_cover: true, covered: false, covered_by: null, shortfall_vnd: '1100000000', approved_drawdown_vnd: '0', contingency_balance_vnd: '300000000' },
  check: { id: uuid(20), status: 'REQUIRED', cumulative_pct: '11.00', threshold_pct: '10.00', basis: null, decision_document_version_id: null, required_at: '2026-11-08T01:00:00.000Z', cleared_by: null, cleared_at: null, audit_notified_at: '2026-11-08T01:00:00.000Z' },
  policy: { version: null, source: 'DEFAULT', project_adjustment_pct: '10', require_reserve_cover: true },
  actions: { clear_adjustment: true },
  as_of: '2026-11-08T03:00:00.000Z',
  ...overrides,
});

describe('CTR-27: the tier of a change order', () => {
  const route = routeOf('CTR-27', 'CTR');
  const open = (state: unknown, command: (operation: string, input: unknown) => unknown = () => ({})) => {
    const h = harness(() => state, command);
    mount(<ChangeTierScreen route={route} />, h, ['change.read'], `/ctr/ctr-27?change=${CHANGE}`);
    return h;
  };

  it('shows the tier, the cumulative variation against the original price, the amount put to the authority, what is lacking and the check that waits', async () => {
    open(tier());
    expect(await screen.findByText(text('govb2.tier.kpi.tier.value', { tier: 3 }))).toBeTruthy();
    expect(screen.getByText('11.00%')).toBeTruthy();
    expect(screen.getByTestId('shortfall').textContent).toBe('1.100.000.000');
    expect(screen.getByText(text('govb2.tier.funding.short'))).toBeTruthy();
    expect(screen.getByText(text('govb2.tier.check.required'))).toBeTruthy();
    expect(screen.getByTestId('check').textContent).toContain('11.00% / 10.00%');
    expect(screen.getByTestId('formula').textContent).toContain(text('govb2.policy.default'));
    expect((screen.getByTestId('reserve-link') as HTMLAnchorElement).getAttribute('href')).toBe(`/prj/prj-22?project=${PROJECT}`);
  });

  it('clears the check with a basis and a document, and shows the refusal of the server in its code', async () => {
    const h = open(tier(), () => refusal('SELF_APPROVAL_DENIED', 403));
    await screen.findByTestId('clear-submit');
    const submit = screen.getByTestId('clear-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('clear-basis'), { target: { value: 'The investment decision was adjusted' } });
    fireEvent.change(screen.getByTestId('clear-document'), { target: { value: DOCUMENT } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('clearChangeAdjustmentCheck');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: CHANGE }, ifMatchVersion: 4, body: { basis: 'The investment decision was adjusted', decision_document_version_id: DOCUMENT } });
    expect((await screen.findByTestId('message')).textContent).toBe(text('govb2.tier.clear.refused', { code: 'SELF_APPROVAL_DENIED' }));
  });

  it('has no form for a person who may not clear it, says a check that is not called for, and a change order that is not there', async () => {
    open(tier({ actions: { clear_adjustment: false } }));
    await screen.findByText(text('govb2.tier.kpi.tier.value', { tier: 3 }));
    expect(screen.queryByTestId('clear-submit')).toBeNull();
    cleanup();
    open(tier({ tier: 1, forces_adjustment: false, cumulative_pct: '2.00', check: null, actions: { clear_adjustment: false }, funding: { needs_cover: false, covered: true, covered_by: null, shortfall_vnd: '0', approved_drawdown_vnd: '0', contingency_balance_vnd: null } }));
    expect((await screen.findByTestId('no-check')).textContent).toBe(text('govb2.tier.check.notCalledFor', { pct: '10' }));
    expect(screen.getByText(text('govb2.tier.funding.notNeeded'))).toBeTruthy();
    cleanup();
    mount(<ChangeTierScreen route={route} />, harness(() => refusal('RESOURCE_NOT_FOUND', 404)), ['change.read'], `/ctr/ctr-27?change=${CHANGE}`);
    expect((await screen.findByTestId('missing')).textContent).toBe(text('govb2.tier.missing'));
  });
});

const recovery = {
  advance: { id: ADVANCE, status: 'RECOVERING', kind: 'GPMB', tranche_no: 1, contract: { id: CONTRACT, code: 'HD-001' }, party: { id: uuid(30), name: 'Nhà thầu A', work_value_vnd: '10000000000' }, paid_vnd: '500000000', recovered_vnd: '100000000', outstanding_vnd: '400000000', recovery_threshold_pct: '80', cap_rule_awaiting_confirmation: true, cap_rule_cxn: 'CXN-31' },
  rows: [
    { kind: 'ACTUAL', request_no: 'TT-01', on: '2026-03-01', at_pct: null, gross_cum_vnd: '1000000000', planned_recovered_vnd: '62500000', actual_recovered_vnd: '50000000', behind_vnd: '12500000' },
    { kind: 'PLANNED', request_no: null, on: null, at_pct: 50, gross_cum_vnd: '4000000000', planned_recovered_vnd: '250000000', actual_recovered_vnd: null, behind_vnd: null },
  ],
  position: { contract_id: CONTRACT, contract_code: 'HD-001', outstanding_vnd: '400000000', remaining_payable_vnd: '200000000', exceeds_remaining: true, unrecoverable_vnd: '200000000', final_payment_requires_full_recovery: true, policy: { version: null, source: 'DEFAULT', tolerance_vnd: '0' } },
  as_of: '2026-11-08T03:00:00.000Z',
};
const policy = { items: [{ version_id: uuid(40), advance_category: 'CONSTRUCTION', revision: 1, valid_from: '2026-01-01', valid_until: null, in_force: true, legal_basis: 'Decree 254/2025 (to be confirmed)', awaiting_confirmation: true, cxn: 'CXN-31', recovery_threshold_pct: '80', tiers: [{ min_value_vnd: '0', cap_pct: '20' }] }], as_of: '2026-11-08' };

describe('PAY-18: the recovery of an advance, planned and actual', () => {
  const route = routeOf('PAY-18', 'PAY');
  const answer = (operation: string): unknown => (operation === 'getAdvanceRecoveryTable' ? recovery : operation === 'listAdvancePolicy' ? policy : recovery.position);

  it('puts the planned recovery next to the actual one for each request, the milestones not reached, the position of the contract and the policy as data', async () => {
    mount(<RecoveryTableScreen route={route} />, harness(answer), ['advance.read'], `/pay/pay-18?advance=${ADVANCE}`);
    expect(await screen.findByText('TT-01')).toBeTruthy();
    expect(screen.getByText('62.500.000')).toBeTruthy();
    expect(screen.getByText('50.000.000')).toBeTruthy();
    expect(screen.getByText(text('govb2.recovery.table.milestone', { pct: 50 }))).toBeTruthy();
    expect(screen.getByText(text('govb2.recovery.table.notYet'))).toBeTruthy();
    expect(screen.getByText(text('govb2.recovery.position.exceeds'))).toBeTruthy();
    expect(screen.getByTestId('final-rule').textContent).toContain(text('govb2.policy.default'));
    expect(screen.getByTestId('awaiting').textContent).toBe(text('govb2.recovery.awaiting', { cxn: 'CXN-31' }));
    expect(screen.getByTestId('formula').textContent).toBe(text('govb2.recovery.formula', { pct: '80' }));
    expect(await screen.findByText('Decree 254/2025 (to be confirmed)')).toBeTruthy();
    expect(screen.getByText(text('govb2.recovery.policy.inForce'))).toBeTruthy();
    expect(screen.getByText(text('govb2.recovery.policy.awaiting', { cxn: 'CXN-31' }))).toBeTruthy();
  });

  it('opened on a contract it shows the position alone; with nothing named it says what to open it from; a missing advance is said so', async () => {
    mount(<RecoveryTableScreen route={route} />, harness(answer), ['advance.read'], `/pay/pay-18?contract=${CONTRACT}`);
    expect(await screen.findByText(text('govb2.recovery.position.title', { code: 'HD-001' }))).toBeTruthy();
    expect(screen.queryByTestId('formula')).toBeNull();
    cleanup();
    const h = harness(answer);
    mount(<RecoveryTableScreen route={route} />, h, ['advance.read'], '/pay/pay-18');
    expect(screen.getByTestId('no-target').textContent).toBe(text('govb2.recovery.noTarget'));
    cleanup();
    mount(<RecoveryTableScreen route={route} />, harness((operation) => (operation === 'getAdvanceRecoveryTable' ? refusal('RESOURCE_NOT_FOUND', 404) : policy)), ['advance.read'], `/pay/pay-18?advance=${ADVANCE}`);
    expect((await screen.findByTestId('missing')).textContent).toBe(text('govb2.recovery.missing'));
  });
});
