import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { harness as baseHarness } from '../../sas/test-support';
import { mount } from '../test-support';
import { routeOf } from '../retention/test-support';
import Screen from './ContractorScorecardScreen';
import {
  approvalBody,
  confirmationBody,
  describeProblem,
  emptyConfirmation,
  emptyEvaluation,
  emptyViolation,
  evaluationBody,
  previewOf,
  scoresOf,
  shownError,
  toContractorChoices,
  toScorecard,
  validateConfirmation,
  validateEvaluation,
  validateViolation,
  violationBody,
} from './model';
import type { Rule, ViolationLine } from './model';

const CONTRACTOR = '00000000-0000-4000-8000-00c000000001';
const C1 = '00000000-0000-4000-8000-00c000000011';
const C2 = '00000000-0000-4000-8000-00c000000012';
const DOCUMENT = '00000000-0000-4000-8000-00d000000001';
const ROUTE = routeOf('CTR-23', 'FR-CTR-23');
const READER = ['contractor.performance.read'];
const MAKER = ['contractor.performance.read', 'contractor.performance.evaluate', 'contractor.violation.record'];
const problem = (code: string, status = 422) => new ApiError({ status, code, correlationId: 'c' });
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);

const RULE = {
  key: 'CTR.SCORECARD',
  weights_pct: { quality: 30, schedule: 25, safety_env: 20, cooperation: 10, financial: 15 },
  thresholds: [
    { min: 90, rating: 'EXCELLENT' },
    { min: 75, rating: 'GOOD' },
    { min: 60, rating: 'FAIR' },
  ],
  awaiting_confirmation: true,
};
const evaluation = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-00e00000000${n}`,
  contract_id: C1,
  contract_code: 'HD-A-001',
  evaluation_kind: 'PERIODIC',
  period_label: `2026-Q${n}`,
  revision: 1,
  scores: { quality: 80, schedule: 70, safety_env: 90, cooperation: 60, financial: 100 },
  overall_score: '80.50',
  rating: 'GOOD',
  status: 'SUBMITTED',
  evaluated_by: 'member-1',
  approved_by: null,
  approved_at: null,
  supersedes_id: null,
  remarks: null,
  approval_note: null,
  created_at: '2026-10-25T01:00:00.000Z',
  allowed: { approve: false },
  version: 1,
  ...overrides,
});
const violation = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-00f00000000${n}`,
  contract_id: C1,
  contract_code: 'HD-A-001',
  violation_kind: 'DELAY',
  severity: 'MAJOR',
  occurred_on: '2026-09-01',
  description: 'Chậm bàn giao mặt bằng',
  evidence_document_version_id: null,
  penalty_kind: 'NONE',
  penalty_amount_vnd: '0',
  decision_document_version_id: null,
  source_module: 'CTR',
  source_ref_id: null,
  status: 'RECORDED',
  recorded_by: 'member-1',
  confirmed_at: null,
  created_at: '2026-10-25T01:00:00.000Z',
  allowed: { confirm: false },
  version: 1,
  ...overrides,
});
const card = (overrides: Record<string, unknown> = {}) => ({
  contractor: { id: CONTRACTOR, legal_name: 'Công ty Cầu Đường 5' },
  contracts: [
    { id: C1, code: 'HD-A-001', status: 'ACTIVE', allowed: { evaluate: false, record_violation: false } },
    { id: C2, code: 'HD-A-002', status: 'ACTIVE', allowed: { evaluate: false, record_violation: false } },
  ],
  evaluations: [],
  violations: [],
  summary: { approved_count: 0, average_overall_score: null, confirmed_violations: { MINOR: 0, MAJOR: 0, CRITICAL: 0 } },
  rule: RULE,
  as_of: '2026-10-25T03:00:00.000Z',
  ...overrides,
});
const allowedContracts = (evaluate: boolean, record: boolean, only = false) => [
  { id: C1, code: 'HD-A-001', status: 'ACTIVE', allowed: { evaluate, record_violation: record } },
  ...(only ? [] : [{ id: C2, code: 'HD-A-002', status: 'ACTIVE', allowed: { evaluate, record_violation: record } }]),
];

afterEach(cleanup);

function open(answer: () => unknown, options: { permissions?: readonly string[]; query?: string; command?: (operation: string, input: unknown) => unknown; mode?: 'FULL' | 'READ_ONLY'; contractors?: () => unknown } = {}) {
  const h = baseHarness((operation) => (operation === 'getContractorScorecard' ? answer() : operation === 'listScorecardContractors' ? (options.contractors ?? (() => ({ items: [], as_of: 'x' })))() : new Error(`unexpected read ${operation}`)), options.command ?? (() => ({ operation_id: 'o', status: 'OK', resource_version: 2, resource_id: 'x' })));
  mount(<Screen route={ROUTE} />, h, { permissions: options.permissions ?? READER, path: `/ctr/ctr-23${options.query ?? `?id=${CONTRACTOR}`}`, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}
const dialog = (): HTMLElement => screen.getByRole('dialog');
const pick = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const commandsOf = (h: ReturnType<typeof open>, operation: string) => h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { path?: { id?: string }; body: Record<string, unknown>; ifMatchVersion?: number });
const ready = async (): Promise<void> => {
  await screen.findByTestId('summary');
};

describe('ContractorScorecardScreen (CTR-23): the scorecard of a contractor and the log of its violations', () => {
  it('UI-CTR-23 AC-ST-CTR-014-1: shows the contractor, the approved count and average, the evaluations with the five scores, the overall score, the rating and the status, and the rule with its assumption', async () => {
    const h = open(() =>
      card({
        evaluations: [evaluation(3, { status: 'APPROVED', approved_by: 'member-2' }), evaluation(4, { status: 'SUBMITTED', revision: 2 })],
        violations: [violation(1, { status: 'CONFIRMED', penalty_kind: 'LIQUIDATED_DAMAGES', penalty_amount_vnd: '150000000' })],
        summary: { approved_count: 1, average_overall_score: '80.50', confirmed_violations: { MINOR: 0, MAJOR: 1, CRITICAL: 0 } },
      }),
    );
    await ready();
    expect(screen.getByText(text('ctr.scorecard.page.contractor', { name: 'Công ty Cầu Đường 5' }))).toBeTruthy();
    expect(screen.getByTestId('approved').textContent).toBe(text('ctr.scorecard.summary.approved', { count: 1 }));
    expect(screen.getByTestId('average').textContent).toBe(text('ctr.scorecard.summary.average', { score: '80.50' }));
    expect(screen.getByTestId('confirmed').textContent).toBe(text('ctr.scorecard.summary.confirmed', { minor: 0, major: 1, critical: 0 }));
    const rows = document.querySelectorAll('[data-evaluation]');
    expect(rows).toHaveLength(2);
    const first = rows[0] as HTMLElement;
    expect([...first.querySelectorAll('[data-score]')].map((cell) => cell.textContent)).toEqual(['80', '70', '90', '60', '100']);
    expect(within(first).getByTestId('overall').textContent).toBe('80.50');
    expect(within(first).getByTestId('rating').textContent).toBe(text('ctr.scorecard.rating.good'));
    expect(within(first).getByTestId('status').textContent).toBe(text('ctr.scorecard.status.approved'));
    expect((rows[1] as HTMLElement).textContent).toContain(text('ctr.scorecard.revision', { revision: 2 }));
    const rule = screen.getByTestId('rule');
    expect(rule.textContent).toContain('30%');
    expect(rule.textContent).toContain(`${text('ctr.scorecard.rating.excellent')} ≥ 90`);
    expect(screen.getByTestId('assumption').textContent).toContain(text('ctr.scorecard.rule.assumption'));
    const line = document.querySelector('[data-violation]') as HTMLElement;
    expect(within(line).getByTestId('penalty').textContent).toContain(text('ctr.scorecard.penalty.liquidated'));
    expect(within(line).getByTestId('penalty').textContent).toContain('150.000');
    expect(within(line).getByTestId('status').textContent).toBe(text('ctr.scorecard.vstatus.confirmed'));
    expect(h.read.mock.calls[0]).toEqual(['getContractorScorecard', { path: { id: CONTRACTOR }, query: {} }]);
  });

  it('says there is nothing yet, and offers no action to a reader who may do nothing', async () => {
    open(() => card());
    await ready();
    expect(screen.getByTestId('no-evaluations')).toBeTruthy();
    expect(screen.getByTestId('no-violations')).toBeTruthy();
    expect(screen.getByTestId('average').textContent).toBe(text('ctr.scorecard.summary.average.none'));
    expect(document.querySelector('[data-evaluate]')).toBeNull();
    expect(document.querySelector('[data-record]')).toBeNull();
  });

  it('limits the scorecard to a range of days: the days go with the read', async () => {
    const h = open(() => card());
    await ready();
    fireEvent.change(document.getElementById('range-from') as HTMLElement, { target: { value: '2026-07-01' } });
    fireEvent.change(document.getElementById('range-to') as HTMLElement, { target: { value: '2026-09-30' } });
    fireEvent.submit(screen.getByTestId('range'));
    await waitFor(() => expect(h.read.mock.calls.some((call) => JSON.stringify(call[1]) === JSON.stringify({ path: { id: CONTRACTOR }, query: { from: '2026-07-01', to: '2026-09-30' } }))).toBe(true));
  });

  it('limits nothing by a range that is the wrong way round: it is told in words, the filter stays and nothing more is asked', async () => {
    const h = open(() => card());
    await ready();
    const reads = h.read.mock.calls.length;
    fireEvent.change(document.getElementById('range-from') as HTMLElement, { target: { value: '2026-09-30' } });
    fireEvent.change(document.getElementById('range-to') as HTMLElement, { target: { value: '2026-09-01' } });
    fireEvent.submit(screen.getByTestId('range'));
    expect((await screen.findByTestId('range-problem')).textContent).toBe(text('ctr.scorecard.range.invalid'));
    expect(h.read.mock.calls.length).toBe(reads);
    fireEvent.change(document.getElementById('range-to') as HTMLElement, { target: { value: '2026-10-31' } });
    fireEvent.submit(screen.getByTestId('range'));
    await waitFor(() => expect(h.read.mock.calls.length).toBe(reads + 1));
    expect(screen.queryByTestId('range-problem')).toBeNull();
  });

  it('says how many rows the lists show of how many there are, when the totals count more', async () => {
    open(() => card({ evaluations: [evaluation(1)], violations: [violation(1)], summary: { approved_count: 600, average_overall_score: '70.00', confirmed_violations: { MINOR: 0, MAJOR: 0, CRITICAL: 0 }, evaluation_count: 600, violation_count: 1 } }));
    await ready();
    expect(screen.getByTestId('evaluations-cut').textContent).toBe(text('ctr.scorecard.list.cut', { shown: 1, total: 600 }));
    expect(screen.queryByTestId('violations-cut')).toBeNull();
  });

  it('offers the contractors to choose from when none is named, and reads the scorecard of the one that is chosen', async () => {
    const h = open(() => card(), {
      query: '',
      contractors: () => ({ items: [{ id: CONTRACTOR, legal_name: 'Công ty Cầu Đường 5', contract_count: 2 }, { contract_count: 1 }], as_of: 'x' }),
    });
    expect(await screen.findByTestId('picker')).toBeTruthy();
    expect(h.read.mock.calls.every((call) => call[0] === 'listScorecardContractors')).toBe(true);
    const select = (await waitFor(() => {
      const found = document.getElementById('pick-contractor') as HTMLSelectElement;
      if (found.options.length < 2) throw new Error('not yet');
      return found;
    })) as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([text('ctr.scorecard.pick.choose'), text('ctr.scorecard.pick.option', { name: 'Công ty Cầu Đường 5', count: 2 })]);
    expect((screen.getByRole('button', { name: text('ctr.scorecard.pick.action') }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(select, { target: { value: CONTRACTOR } });
    fireEvent.submit(screen.getByTestId('picker'));
    await waitFor(() => expect(h.read.mock.calls.some((call) => JSON.stringify(call[1]) === JSON.stringify({ path: { id: CONTRACTOR }, query: {} }))).toBe(true));
    expect(await screen.findByTestId('summary')).toBeTruthy();
    expect(screen.queryByTestId('picker')).toBeNull();
  });

  it('says so when the contractors cannot be loaded, and offers no picker to one who may not read the scorecards', async () => {
    open(() => card(), { query: '', contractors: () => problem('SCOPE_DENIED', 403) });
    expect(await screen.findByTestId('pick-failed')).toBeTruthy();
    cleanup();
    open(() => card(), { query: '', permissions: ['notification.self'] });
    await screen.findByText(vi_['states.denied.title']);
    expect(document.querySelector('[data-testid="picker"]')).toBeNull();
  });

  describe('the evaluation (AC-ST-CTR-014-1, UAT-AC315)', () => {
    const maker = () => card({ contracts: allowedContracts(true, true) });

    it('shows the overall score and the rating the rule gives while the scores are typed, and sends the scores of the contract that was chosen', async () => {
      const h = open(maker, { permissions: MAKER });
      await ready();
      fireEvent.click(document.querySelector('[data-evaluate]') as HTMLElement);
      expect(within(dialog()).getByTestId('preview').textContent).toBe(text('ctr.scorecard.preview.none'));
      pick('evaluate-contract', C2);
      pick('evaluate-period', '2026-Q3');
      for (const [criterion, score] of [['quality', '80'], ['schedule', '70'], ['safetyEnv', '90'], ['cooperation', '60'], ['financial', '100']] as const) pick(`evaluate-${criterion}`, score);
      expect(within(dialog()).getByTestId('preview').textContent).toBe(text('ctr.scorecard.preview.value', { score: '80.50', rating: text('ctr.scorecard.rating.good') }));
      pick('evaluate-remarks', '  Đạt yêu cầu  ');
      fireEvent.submit(dialog().querySelector('form') as HTMLElement);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(commandsOf(h, 'evaluateContractor')[0]).toMatchObject({
        path: { id: C2 },
        body: { evaluation_kind: 'PERIODIC', period_label: '2026-Q3', score_quality: 80, score_schedule: 70, score_safety_env: 90, score_cooperation: 60, score_financial: 100, remarks: 'Đạt yêu cầu' },
      });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('names what is wrong before sending: no contract, no period, a score that is not a whole number from 0 to 100', async () => {
      const h = open(maker, { permissions: MAKER });
      await ready();
      fireEvent.click(document.querySelector('[data-evaluate]') as HTMLElement);
      fireEvent.submit(dialog().querySelector('form') as HTMLElement);
      expect(await within(dialog()).findAllByText(text('ctr.scorecard.problem.score'))).toHaveLength(5);
      expect(within(dialog()).getAllByText(text('ctr.scorecard.problem.required'))).toHaveLength(2);
      pick('evaluate-quality', '101');
      pick('evaluate-schedule', '7.5');
      fireEvent.submit(dialog().querySelector('form') as HTMLElement);
      expect(within(dialog()).getAllByText(text('ctr.scorecard.problem.score')).length).toBeGreaterThanOrEqual(2);
      expect(h.command).not.toHaveBeenCalled();
    });

    it('preselects the only contract that may be evaluated, and offers the action to none who may evaluate nothing, or while the tenant is read-only', async () => {
      open(() => card({ contracts: allowedContracts(true, false, true) }), { permissions: MAKER });
      await ready();
      fireEvent.click(document.querySelector('[data-evaluate]') as HTMLElement);
      expect((document.getElementById('evaluate-contract') as HTMLSelectElement).value).toBe(C1);
      cleanup();
      open(maker, { permissions: MAKER, mode: 'READ_ONLY' });
      await ready();
      expect(document.querySelector('[data-evaluate]')).toBeNull();
      expect(document.querySelector('[data-record]')).toBeNull();
    });

    it('approves an evaluation at the version read, with a note, only where the server says it may', async () => {
      const waiting = evaluation(1, { allowed: { approve: true }, version: 3 });
      const h = open(() => card({ evaluations: [waiting, evaluation(2)] }), { permissions: ['contractor.performance.read', 'contractor.performance.approve'] });
      await ready();
      expect(document.querySelectorAll('[data-approve]')).toHaveLength(1);
      fireEvent.click(document.querySelector('[data-approve]') as HTMLElement);
      expect(within(dialog()).getByTestId('approving').textContent).toContain('80.50');
      pick('approve-note', ' Đồng ý ');
      fireEvent.submit(dialog().querySelector('form') as HTMLElement);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(commandsOf(h, 'approveContractorEvaluation')[0]).toMatchObject({ path: { id: waiting.id }, ifMatchVersion: 3, body: { note: 'Đồng ý' } });
    });

    it('says in words why the server refused: duplicate, self-approval, state, contract state, version, validation, denied, not found, session, general', async () => {
      for (const [code, key] of [
        ['EVALUATION_DUPLICATE', 'duplicate'],
        ['SELF_APPROVAL_DENIED', 'selfApproval'],
        ['EVALUATION_STATE_INVALID', 'evaluationState'],
        ['VIOLATION_STATE_INVALID', 'violationState'],
        ['CONTRACT_STATE_INVALID', 'contractState'],
        ['DECISION_DOCUMENT_REQUIRED', 'decisionRequired'],
        ['DOCUMENT_NOT_CLEAN', 'notClean'],
        ['VERSION_CONFLICT', 'versionConflict'],
        ['VALIDATION_FAILED', 'validation'],
        ['SCOPE_DENIED', 'denied'],
        ['RESOURCE_NOT_FOUND', 'notFound'],
        ['SESSION_EXPIRED', 'session'],
        ['INTERNAL_ERROR', 'general'],
      ] as const) {
        open(() => card({ evaluations: [evaluation(1, { allowed: { approve: true } })] }), { permissions: MAKER, command: () => problem(code, code === 'INTERNAL_ERROR' ? 500 : 422) });
        await ready();
        fireEvent.click(document.querySelector('[data-approve]') as HTMLElement);
        fireEvent.submit(dialog().querySelector('form') as HTMLElement);
        expect((await within(dialog()).findByRole('alert')).textContent).toBe(text(`ctr.scorecard.error.${key}`));
        cleanup();
      }
    });
  });

  describe('the violation (AC-ST-CTR-014-2, UAT-PLAN-17)', () => {
    const maker = () => card({ contracts: allowedContracts(true, true) });

    it('records a violation on the chosen contract with its words, and refuses a day to come or a day that is not real before sending', async () => {
      const h = open(maker, { permissions: MAKER });
      await ready();
      fireEvent.click(document.querySelector('[data-record]') as HTMLElement);
      fireEvent.submit(dialog().querySelector('form') as HTMLElement);
      // The contract, the day and the words are each asked for.
      expect(await within(dialog()).findAllByText(text('ctr.scorecard.problem.required'))).toHaveLength(3);
      pick('record-contract', C1);
      pick('record-day', '2099-01-01');
      pick('record-description', 'Chậm bàn giao');
      fireEvent.submit(dialog().querySelector('form') as HTMLElement);
      expect(await within(dialog()).findByText(text('ctr.scorecard.problem.future'))).toBeTruthy();
      pick('record-day', '2026-02-30');
      fireEvent.submit(dialog().querySelector('form') as HTMLElement);
      expect(await within(dialog()).findByText(text('ctr.scorecard.problem.day'))).toBeTruthy();
      pick('record-day', '2026-09-01');
      pick('record-evidence', 'x');
      fireEvent.submit(dialog().querySelector('form') as HTMLElement);
      expect(await within(dialog()).findByText(text('ctr.scorecard.problem.uuid'))).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      pick('record-evidence', DOCUMENT.toUpperCase());
      pick('record-kind', 'SAFETY');
      pick('record-severity', 'CRITICAL');
      fireEvent.submit(dialog().querySelector('form') as HTMLElement);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(commandsOf(h, 'recordContractorViolation')[0]).toMatchObject({
        path: { id: C1 },
        body: { violation_kind: 'SAFETY', severity: 'CRITICAL', occurred_on: '2026-09-01', description: 'Chậm bàn giao', evidence_document_version_id: DOCUMENT },
      });
    });

    it('AC-ST-CTR-014-2 UAT-PLAN-17: asks for the document of decision for every sanction, and for none when there is no sanction, and an amount only for liquidated damages', async () => {
      const waiting = violation(1, { allowed: { confirm: true }, version: 4 });
      const h = open(() => card({ violations: [waiting] }), { permissions: READER });
      await ready();
      fireEvent.click(document.querySelector('[data-confirm]') as HTMLElement);
      expect(document.getElementById('confirm-amount')).toBeNull();
      pick('confirm-penalty', 'LIQUIDATED_DAMAGES');
      fireEvent.submit(dialog().querySelector('form') as HTMLElement);
      // The amount and the document are each asked for.
      expect(await within(dialog()).findAllByText(text('ctr.scorecard.problem.required'))).toHaveLength(2);
      pick('confirm-amount', '0');
      pick('confirm-decision', DOCUMENT);
      fireEvent.submit(dialog().querySelector('form') as HTMLElement);
      expect(await within(dialog()).findByText(text('ctr.scorecard.problem.amount'))).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      pick('confirm-amount', '0150000000');
      fireEvent.submit(dialog().querySelector('form') as HTMLElement);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(commandsOf(h, 'confirmContractorViolation')[0]).toMatchObject({ path: { id: waiting.id }, ifMatchVersion: 4, body: { penalty_kind: 'LIQUIDATED_DAMAGES', penalty_amount_vnd: '150000000', decision_document_version_id: DOCUMENT } });
    });

    it('confirms a violation with no sanction without a document, and opens a suggested one with its sanction and its document', async () => {
      const h = open(() => card({ violations: [violation(1, { allowed: { confirm: true } }), violation(2, { allowed: { confirm: true }, penalty_kind: 'TERMINATION', decision_document_version_id: DOCUMENT })] }));
      await ready();
      fireEvent.click(document.querySelector('[data-confirm]') as HTMLElement);
      fireEvent.submit(dialog().querySelector('form') as HTMLElement);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(commandsOf(h, 'confirmContractorViolation')[0]?.body).toEqual({ penalty_kind: 'NONE' });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      fireEvent.click(document.querySelectorAll('[data-confirm]')[1] as HTMLElement);
      expect((document.getElementById('confirm-penalty') as HTMLSelectElement).value).toBe('TERMINATION');
      expect((document.getElementById('confirm-decision') as HTMLInputElement).value).toBe(DOCUMENT);
    });

    it('shows the refusal of a sanction with no document in words and keeps the form open', async () => {
      open(() => card({ violations: [violation(1, { allowed: { confirm: true } })] }), { command: () => problem('DECISION_DOCUMENT_REQUIRED') });
      await ready();
      fireEvent.click(document.querySelector('[data-confirm]') as HTMLElement);
      pick('confirm-penalty', 'WARNING');
      pick('confirm-decision', DOCUMENT);
      fireEvent.submit(dialog().querySelector('form') as HTMLElement);
      expect((await within(dialog()).findByRole('alert')).textContent).toBe(text('ctr.scorecard.error.decisionRequired'));
      expect((document.getElementById('confirm-decision') as HTMLInputElement).value).toBe(DOCUMENT);
    });
  });

  it('shows the seven states: loading, denied, signed out, offline, error, empty (no contractor named) and not found', async () => {
    const loading = open(() => card());
    expect(loading).toBeDefined();
    expect(document.querySelector('[role="status"]')).not.toBeNull();
    cleanup();
    for (const [error, title] of [
      [new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }), vi_['states.denied.title']],
      [new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), vi_['states.signedOut.title']],
      [new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      [new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), vi_['states.error.title']],
      [new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c' }), vi_['states.error.title']],
    ] as const) {
      open(() => error);
      expect(await screen.findByText(title)).toBeTruthy();
      cleanup();
    }
    const nobody = open(() => card(), { permissions: ['notification.self'] });
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    expect(nobody.read).not.toHaveBeenCalled();
    cleanup();
    const none = open(() => card(), { query: '' });
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    expect(none.read.mock.calls.every((call) => call[0] === 'listScorecardContractors')).toBe(true);
    cleanup();
    open(() => ({ contractor: 3 }));
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
  });

  describe('the rules of the forms', () => {
    const rule = toScorecard(card())?.rule as Rule;

    it('weights the scores the way the server does, to the hundredth, and rates by the thresholds', () => {
      expect(previewOf({ quality: 80, schedule: 70, safetyEnv: 90, cooperation: 60, financial: 100 }, rule)).toEqual({ overall: '80.50', rating: 'GOOD' });
      expect(previewOf({ quality: 100, schedule: 100, safetyEnv: 100, cooperation: 100, financial: 100 }, rule)).toEqual({ overall: '100.00', rating: 'EXCELLENT' });
      expect(previewOf({ quality: 1, schedule: 0, safetyEnv: 0, cooperation: 0, financial: 0 }, rule)).toEqual({ overall: '0.30', rating: 'POOR' });
      expect(previewOf({ quality: 60, schedule: 60, safetyEnv: 60, cooperation: 60, financial: 60 }, rule).rating).toBe('FAIR');
      expect(previewOf({ quality: 59, schedule: 60, safetyEnv: 60, cooperation: 60, financial: 60 }, rule).rating).toBe('POOR');
    });

    it('reads the scores of a form only when every one is a whole number from 0 to 100', () => {
      const form = { ...emptyEvaluation(C1), scores: { quality: '80', schedule: '70', safetyEnv: '90', cooperation: '60', financial: '100' } };
      expect(scoresOf(form)).toEqual({ quality: 80, schedule: 70, safetyEnv: 90, cooperation: 60, financial: 100 });
      for (const bad of ['', '101', '7.5', '-1', 'x']) expect(scoresOf({ ...form, scores: { ...form.scores, financial: bad } })).toBeUndefined();
      expect(validateEvaluation({ ...form, contractId: C1, period: 'x'.repeat(41), remarks: 'y'.repeat(2001) })).toEqual({ period: 'tooLong', remarks: 'tooLong' });
      expect(validateEvaluation({ ...form, contractId: C1, period: '2026-Q3' })).toEqual({});
      expect(evaluationBody({ ...form, contractId: C1, period: ' 2026-Q3 ', kind: 'COMPLETION' })).toEqual({
        evaluation_kind: 'COMPLETION',
        period_label: '2026-Q3',
        score_quality: 80,
        score_schedule: 70,
        score_safety_env: 90,
        score_cooperation: 60,
        score_financial: 100,
      });
      expect(approvalBody('  ')).toEqual({});
      expect(approvalBody(' ok ')).toEqual({ note: 'ok' });
    });

    it('judges a violation by the day of the person and its words, and builds the body without the spaces', () => {
      const base = { ...emptyViolation(C1), occurredOn: '2026-09-01', description: ' Chậm ' };
      expect(validateViolation(base, '2026-09-30')).toEqual({});
      expect(validateViolation({ ...base, occurredOn: '2026-09-30' }, '2026-09-30')).toEqual({});
      expect(validateViolation({ ...base, occurredOn: '2026-10-01' }, '2026-09-30')).toEqual({ occurredOn: 'future' });
      expect(validateViolation({ ...base, occurredOn: '01/09/2026' }, '2026-09-30')).toEqual({ occurredOn: 'day' });
      expect(validateViolation({ ...emptyViolation(''), occurredOn: '', description: '' }, '2026-09-30')).toEqual({ contractId: 'required', occurredOn: 'required', description: 'required' });
      expect(validateViolation({ ...base, description: 'x'.repeat(2001), evidence: 'zz' }, '2026-09-30')).toEqual({ description: 'tooLong', evidence: 'uuid' });
      expect(violationBody({ ...base, evidence: DOCUMENT.toUpperCase() })).toEqual({ violation_kind: 'DELAY', severity: 'MINOR', occurred_on: '2026-09-01', description: 'Chậm', evidence_document_version_id: DOCUMENT });
    });

    it('asks for a document of decision for every sanction and an amount for liquidated damages only', () => {
      const line = toScorecard(card({ violations: [violation(1)] }))?.violations[0] as ViolationLine;
      expect(emptyConfirmation(line)).toEqual({ penaltyKind: 'NONE', amount: '', decision: '' });
      expect(validateConfirmation({ penaltyKind: 'NONE', amount: '', decision: '' })).toEqual({});
      expect(validateConfirmation({ penaltyKind: 'WARNING', amount: '', decision: '' })).toEqual({ decision: 'required' });
      expect(validateConfirmation({ penaltyKind: 'WARNING', amount: '', decision: 'zz' })).toEqual({ decision: 'uuid' });
      expect(validateConfirmation({ penaltyKind: 'LIQUIDATED_DAMAGES', amount: '', decision: DOCUMENT })).toEqual({ amount: 'required' });
      expect(validateConfirmation({ penaltyKind: 'LIQUIDATED_DAMAGES', amount: '00', decision: DOCUMENT })).toEqual({ amount: 'amount' });
      expect(validateConfirmation({ penaltyKind: 'LIQUIDATED_DAMAGES', amount: '5', decision: DOCUMENT })).toEqual({});
      expect(confirmationBody({ penaltyKind: 'LIQUIDATED_DAMAGES', amount: ' 0150 ', decision: DOCUMENT.toUpperCase() })).toEqual({ penalty_kind: 'LIQUIDATED_DAMAGES', penalty_amount_vnd: '150', decision_document_version_id: DOCUMENT });
      expect(confirmationBody({ penaltyKind: 'WARNING', amount: '7', decision: '' })).toEqual({ penalty_kind: 'WARNING' });
    });

    it('reads the answer of the server leniently, and tells a refusal from a break in the network', () => {
      expect(toContractorChoices({ items: [{ id: 'a', legal_name: 'A', contract_count: 3 }, { id: 'b' }, null] })).toEqual([{ id: 'a', name: 'A', contracts: 3 }, { id: 'b', name: 'b', contracts: 0 }]);
      expect(toContractorChoices(null)).toEqual([]);
      expect(toScorecard(null)).toBeUndefined();
      expect(toScorecard({ contractor: { id: 'c' }, contracts: [], evaluations: [], violations: [] })).toBeUndefined();
      const read = toScorecard(card({ evaluations: [evaluation(1), { id: 3 }, evaluation(2, { rating: 'GREAT' })], violations: [violation(1), { id: 'v', severity: 'X' }], contracts: [{ id: C1 }, null] }));
      expect([read?.evaluations.length, read?.violations.length, read?.contracts.length]).toEqual([1, 1, 1]);
      expect(describeProblem(new Error('x'))).toBe('general');
      expect(describeProblem(problem('SOMETHING_NEW'))).toBe('general');
      expect(shownError(null, true)).toBeUndefined();
      expect(shownError(new Error('x'), false)).toBeInstanceOf(Error);
      expect(shownError(new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), true)).toBeUndefined();
      expect(shownError(problem('SCOPE_DENIED', 403), true)).toBeDefined();
    });
  });
});
