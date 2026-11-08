import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { translator } from '../../../i18n';
import { message as word } from '../../ctr/test-catalogue';
import { ALL, CONTRACTOR, OTHER, READER, client, mount, policy, routeOf } from '../shared/test/vnd-test-support';
import type { World } from '../shared/test/vnd-test-support';
import RiskScreen from './RiskScreen';

const route = routeOf('VND-11', 'FR-VND-11');
const AS_OF = '2026-11-08T03:00:00.000Z';
const ASSESSMENT = '00000000-0000-4000-8000-000000000a11';
const FACTORS = ['PROFILE_GAP', 'RESTRICTION', 'REPUTATION_EVENTS', 'QUALIFICATION_LAPSE', 'PAYEE_ALERT', 'POOR_PERFORMANCE', 'FINANCE_BELOW', 'LOAD_OVER', 'OPEN_FINDINGS', 'SUBCONTRACT_BREACH', 'SECURITY_FORFEIT'];
const ALL_RIGHTS = [...ALL, 'vnd.risk.assess', 'vnd.risk.decide', 'vnd.performance.publish'];

const labelOf = (label: string): RegExp => new RegExp(label.split('').map((char) => (/[\p{L}\p{N} ]/u.test(char) ? char : `\\${char}`)).join(''));

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
});

const item = (n: number, over: Record<string, unknown> = {}) => ({
  contractor_id: n === 1 ? CONTRACTOR : OTHER,
  legal_name: `Công ty nhà thầu ${n}`,
  tax_identifier: `010000000${n}`,
  tier: 'MEDIUM',
  score: 25,
  next_review_on: '2027-05-08',
  review_overdue: false,
  assessment_id: ASSESSMENT,
  pending_assessment_id: null,
  pending_tier: null,
  cursor: `c${n}`,
  ...over,
});

const page = (items: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) => ({
  items,
  next_cursor: null,
  policy: policy('VENDOR_RISK'),
  figures: [
    { code: 'VENDOR_RISK_REVIEW_IN_TIME', numerator: 3, denominator: 4, as_of: '2026-11-08' },
    { code: 'VENDOR_HIGH_RISK_CONTRACTORS', numerator: 2, denominator: 0, as_of: '2026-11-08' },
  ],
  as_of: AS_OF,
  ...over,
});

const factors = (points: Record<string, number> = {}) => FACTORS.map((factor) => ({ factor, points: points[factor] ?? 0, max: 10, reading: { count: points[factor] ?? 0 } }));
const assessment = (over: Record<string, unknown> = {}) => ({
  id: ASSESSMENT,
  contractor_id: CONTRACTOR,
  contractor_name: 'Công ty nhà thầu 1',
  score: 50,
  tier: 'HIGH',
  score_tier: 'HIGH',
  floored: false,
  factors: factors({ RESTRICTION: 10, PROFILE_GAP: 4 }),
  reasons: ['RESTRICTION', 'PROFILE_GAP'],
  inputs: {},
  rule_version: 'builtin',
  rule_unverified: true,
  review_months: 6,
  next_review_on: '2027-05-08',
  dual_check: true,
  as_of: '2026-11-08',
  state: 'PROPOSED',
  assessed_by: 'm1',
  assessed_by_name: 'Lê Thị Hoa',
  assessed_at: '2026-11-07T02:00:00.000Z',
  decided_by: null,
  decided_by_name: null,
  decided_at: null,
  decision_reason: null,
  superseded_by_id: null,
  version: 1,
  can_decide: true,
  ...over,
});

const grade = (over: Record<string, unknown> = {}) => ({
  contractor_id: CONTRACTOR,
  contractor_name: 'Công ty nhà thầu 1',
  tier: null,
  confirmed: null,
  pending: assessment(),
  live: { score: 14, tier: 'LOW', score_tier: 'LOW', floored: false, factors: factors({ RESTRICTION: 10, PROFILE_GAP: 4 }), reasons: ['RESTRICTION', 'PROFILE_GAP'], review_months: 24, next_review_on: '2028-11-08', dual_check: false, inputs: {} },
  history: [assessment()],
  policy: policy('VENDOR_RISK'),
  as_of: AS_OF,
  ...over,
});

interface Options {
  permissions?: string[];
  mode?: 'FULL' | 'READ_ONLY';
  command?: (operation: string, input: unknown) => unknown;
  path?: string;
  failing?: World['failing'];
}

function open(register: Record<string, unknown> = page([item(1), item(2, { tier: null, score: null, next_review_on: null, assessment_id: null })]), detail: Record<string, unknown> | Error = grade(), options: Options = {}) {
  const world: World = { answers: { listVendorRiskGrades: register, getVendorRiskGrade: detail }, ...(options.failing === undefined ? {} : { failing: options.failing }) };
  const h = client(world, options.command);
  mount(<RiskScreen route={route} />, h, { permissions: options.permissions ?? ALL_RIGHTS, path: options.path ?? '/vnd/vnd-11', ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return { h, world };
}

const dialog = (name: string): HTMLElement => screen.getByRole('dialog', { name });
const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('tr[data-contractor-id]'));
const loaded = async (): Promise<void> => {
  await screen.findAllByText('Công ty nhà thầu 1');
};

describe('RiskScreen (VND-11): the risk grade', () => {
  it('lists the contractors with the grade, the score, the review day, and the grade that waits; the rule has its "i" and the unverified flag', async () => {
    open(page([item(1), item(2, { tier: 'CRITICAL', score: 80, review_overdue: true, next_review_on: '2026-10-01', pending_assessment_id: ASSESSMENT, pending_tier: 'HIGH' }), item(3, { tier: null, score: null, next_review_on: null, assessment_id: null })]));
    await loaded();
    const [first, second, third] = rows();
    expect(first?.textContent).toContain(word('vnd.risk.tier.MEDIUM.name'));
    expect(first?.textContent).toContain('25');
    expect(first?.textContent).toContain('08/05/2027');
    expect(second?.textContent).toContain(word('vnd.risk.tier.CRITICAL.name'));
    expect(second?.textContent).toContain(word('vnd.risk.review.overdue.badge'));
    expect(second?.textContent).toContain(word('vnd.risk.pending.text', { tier: word('vnd.risk.tier.HIGH.name') }));
    expect(third?.textContent).toContain(word('vnd.risk.tier.none.text'));
    const rule = screen.getByTestId('risk-rule');
    expect(rule.textContent).toContain(word('vnd.risk.rule.text'));
    fireEvent.click(within(rule).getByRole('button', { name: word('vnd.info.open.label', { name: word('vnd.risk.figure.rule.name') }) }));
    expect(screen.getByRole('dialog', { name: word('vnd.risk.figure.rule.name') }).querySelector('[data-field=unverified]')).toBeTruthy();
    expect(screen.getByTestId('figure-VENDOR_RISK_REVIEW_IN_TIME').textContent).toBe('75%');
    expect(screen.getByTestId('figure-VENDOR_HIGH_RISK_CONTRACTORS').textContent).toBe('2');
  });

  it('says an empty register and filters by grade, review day and waiting grade', async () => {
    const { h } = open(page([]));
    await screen.findByText(word('ui.dataTable.emptyNone'));
    expect(h.read).toHaveBeenCalledWith('listVendorRiskGrades', { query: { limit: 25 } });
    fireEvent.change(screen.getByLabelText(word('vnd.risk.filter.tier.label')), { target: { value: 'HIGH' } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listVendorRiskGrades', { query: { tier: 'HIGH', limit: 25 } }));
    fireEvent.click(screen.getByLabelText(word('vnd.risk.filter.reviewDue.label')));
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listVendorRiskGrades', { query: { tier: 'HIGH', review_due: true, limit: 25 } }));
    fireEvent.click(screen.getByLabelText(word('vnd.risk.filter.pending.label')));
    fireEvent.change(screen.getByLabelText(word('vnd.risk.filter.q.label')), { target: { value: ' Alpha ' } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listVendorRiskGrades', { query: { q: 'Alpha', tier: 'HIGH', review_due: true, pending: true, limit: 25 } }));
  });

  it('shows the explanation of a contractor factor by factor with the main reason, the bar, the reading and the "i" of each figure', async () => {
    const { h } = open();
    await loaded();
    fireEvent.click(within(rows()[0] as HTMLElement).getByTestId('open-grade'));
    await screen.findByTestId('explanation');
    expect(h.read).toHaveBeenCalledWith('getVendorRiskGrade', { path: { id: CONTRACTOR } });
    expect(screen.getByTestId('live-score').textContent).toBe(word('vnd.risk.live.score.text', { score: 14 }));
    expect(screen.getByTestId('main-reason').textContent).toBe(word('vnd.risk.live.main.text', { factor: word('vnd.risk.factor.RESTRICTION.name'), points: 10 }));
    const factorRows = Array.from(document.querySelectorAll<HTMLElement>('tr[data-factor]'));
    expect(factorRows.map((row) => row.getAttribute('data-factor'))).toEqual(FACTORS);
    const restriction = factorRows[1] as HTMLElement;
    expect(restriction.textContent).toContain(word('vnd.risk.factors.points.text', { points: 10, max: 10 }));
    expect(restriction.textContent).toContain('count: 10');
    expect((restriction.querySelector('.vnd-bar__fill') as HTMLElement).style.width).toBe('100%');
    expect((factorRows[2]?.querySelector('.vnd-bar__fill') as HTMLElement).style.width).toBe('0%');
    fireEvent.click(within(restriction).getByRole('button', { name: word('vnd.info.open.label', { name: word('vnd.risk.factor.RESTRICTION.name') }) }));
    expect(screen.getByRole('dialog', { name: word('vnd.risk.factor.RESTRICTION.name') }).textContent).toContain(word('vnd.risk.factor.RESTRICTION.formula'));
    expect(screen.getByTestId('explanation').textContent).toContain(word('vnd.risk.live.review.text', { months: 24, date: '08/11/2028', dual: word('vnd.risk.live.dual.no') }));
  });

  it('says a floor held up by a restriction and, for a clean contractor, that no factor adds points', async () => {
    open(page([item(1)]), grade({ live: { score: 5, tier: 'HIGH', score_tier: 'LOW', floored: true, factors: factors({ RESTRICTION: 5 }), reasons: ['RESTRICTION'], review_months: 6, next_review_on: '2027-05-08', dual_check: true, inputs: {} } }));
    await loaded();
    fireEvent.click(within(rows()[0] as HTMLElement).getByTestId('open-grade'));
    await screen.findByTestId('explanation');
    expect(screen.getByTestId('explanation').textContent).toContain(word('vnd.risk.live.floored.badge', { tier: word('vnd.risk.tier.LOW.name') }));
    cleanup();
    open(page([item(1)]), grade({ live: { score: 0, tier: 'LOW', score_tier: 'LOW', floored: false, factors: factors(), reasons: [], review_months: 24, next_review_on: '2028-11-08', dual_check: false, inputs: {} } }));
    await loaded();
    fireEvent.click(within(rows()[0] as HTMLElement).getByTestId('open-grade'));
    expect((await screen.findByTestId('no-reason')).textContent).toBe(word('vnd.risk.live.none.text'));
  });

  it('assesses a contractor and says the receipt; the button is offered only to a person with the right and when no grade waits', async () => {
    const { h } = open(page([item(1)]), grade({ pending: null, history: [] }));
    await loaded();
    fireEvent.click(within(rows()[0] as HTMLElement).getByTestId('open-grade'));
    fireEvent.click(await screen.findByTestId('assess-risk'));
    const form = dialog(word('vnd.risk.assess.title'));
    fireEvent.click(within(form).getByRole('button', { name: word('vnd.risk.assess.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('assessVendorRisk', { path: { id: CONTRACTOR }, attempt: { key: expect.any(String) } }));
    expect((await screen.findByTestId('receipt')).textContent).toContain(word('vnd.risk.assess.title'));
    cleanup();
    open(page([item(1)]), grade(), { permissions: ALL_RIGHTS });
    await loaded();
    fireEvent.click(within(rows()[0] as HTMLElement).getByTestId('open-grade'));
    await screen.findByTestId('pending-grade');
    expect(screen.queryByTestId('assess-risk')).toBeNull();
    cleanup();
    open(page([item(1)]), grade({ pending: null, history: [] }), { permissions: READER });
    await loaded();
    fireEvent.click(within(rows()[0] as HTMLElement).getByTestId('open-grade'));
    await screen.findByTestId('explanation');
    expect(screen.queryByTestId('assess-risk')).toBeNull();
  });

  it('confirms the grade that waits with the version it saw, and needs a reason of 20 characters to reject', async () => {
    const { h } = open(page([item(1)]));
    await loaded();
    fireEvent.click(within(rows()[0] as HTMLElement).getByTestId('open-grade'));
    expect((await screen.findByTestId('pending-grade')).textContent).toContain(word('vnd.risk.panel.dual.badge'));
    fireEvent.click(screen.getByTestId('decide-risk'));
    const form = dialog(word('vnd.risk.decide.title'));
    fireEvent.click(within(form).getByRole('button', { name: word('vnd.risk.decide.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('decideVendorRiskGrade', { path: { id: ASSESSMENT }, ifMatchVersion: 1, body: { decision: 'CONFIRM' }, attempt: { key: expect.any(String) } }));
    cleanup();
    const second = open(page([item(1)]));
    await loaded();
    fireEvent.click(within(rows()[0] as HTMLElement).getByTestId('open-grade'));
    fireEvent.click(await screen.findByTestId('decide-risk'));
    const again = dialog(word('vnd.risk.decide.title'));
    fireEvent.change(within(again).getByLabelText(labelOf(word('vnd.risk.decide.decision.label'))), { target: { value: 'REJECT' } });
    const send = within(again).getByRole('button', { name: word('vnd.risk.decide.confirm') }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(within(again).getByLabelText(labelOf(word('vnd.risk.decide.reason.label'))), { target: { value: 'Số liệu chứng chỉ lấy nhầm năm' } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(second.h.command).toHaveBeenCalledWith('decideVendorRiskGrade', { path: { id: ASSESSMENT }, ifMatchVersion: 1, body: { decision: 'REJECT', reason: 'Số liệu chứng chỉ lấy nhầm năm' }, attempt: { key: expect.any(String) } }));
  });

  it('says that the assessor cannot confirm a high grade alone, with no button to decide', async () => {
    open(page([item(1)]), grade({ pending: assessment({ can_decide: false }) }));
    await loaded();
    fireEvent.click(within(rows()[0] as HTMLElement).getByTestId('open-grade'));
    expect((await screen.findByTestId('cannot-decide')).textContent).toBe(word('vnd.risk.panel.cannotDual.text'));
    expect(screen.queryByTestId('decide-risk')).toBeNull();
  });

  it('says in the dialog what the server refused', async () => {
    open(page([item(1)]), grade(), { command: () => Promise.reject(new ApiError({ status: 403, code: 'SELF_APPROVAL_DENIED', correlationId: 'c' })) });
    await loaded();
    fireEvent.click(within(rows()[0] as HTMLElement).getByTestId('open-grade'));
    fireEvent.click(await screen.findByTestId('decide-risk'));
    const form = dialog(word('vnd.risk.decide.title'));
    fireEvent.click(within(form).getByRole('button', { name: word('vnd.risk.decide.confirm') }));
    expect((await within(form).findByRole('alert')).textContent).toBeTruthy();
    expect(screen.queryByTestId('receipt')).toBeNull();
  });

  it('shows the history of the assessments and the states of loading, failure and the read-only workspace', async () => {
    open(page([item(1)]), grade({ history: [assessment({ state: 'CONFIRMED', decided_by_name: 'Phạm Quốc Bảo', decided_at: '2026-11-07T04:00:00.000Z' }), assessment({ id: 'old', state: 'SUPERSEDED' })] }));
    await loaded();
    fireEvent.click(within(rows()[0] as HTMLElement).getByTestId('open-grade'));
    await screen.findByTestId('explanation');
    const history = screen.getByRole('table', { name: word('vnd.risk.history.caption') });
    expect(history.textContent).toContain(word('vnd.risk.state.CONFIRMED.name'));
    expect(history.textContent).toContain(word('vnd.risk.state.SUPERSEDED.name'));
    expect(history.textContent).toContain('Phạm Quốc Bảo');
    cleanup();
    open(page([item(1)]), new Error('boom'));
    await loaded();
    fireEvent.click(within(rows()[0] as HTMLElement).getByTestId('open-grade'));
    expect(await screen.findByTestId('risk-panel-error')).toBeTruthy();
    cleanup();
    open(page([item(1)]), grade({ pending: null, history: [] }), { mode: 'READ_ONLY' });
    await loaded();
    fireEvent.click(within(rows()[0] as HTMLElement).getByTestId('open-grade'));
    await screen.findByTestId('explanation');
    expect(screen.queryByTestId('assess-risk')).toBeNull();
  });

  it('opens the contractor the address names and shows a failed register with a way to retry', async () => {
    const { h } = open(page([item(1)]), grade(), { path: `/vnd/vnd-11?contractor=${CONTRACTOR}` });
    await screen.findByTestId('explanation');
    expect(h.read).toHaveBeenCalledWith('getVendorRiskGrade', { path: { id: CONTRACTOR } });
    cleanup();
    open(page([]), grade(), { failing: { listVendorRiskGrades: { error: new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), times: 1 } } });
    const retry = await screen.findByRole('button', { name: word('states.retry.action') });
    fireEvent.click(retry);
    await screen.findByText(word('ui.dataTable.emptyNone'));
  });
});
