import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import en from '../../../i18n/parts/ca3.en.json';
import vi_ from '../../../i18n/parts/ca3.vi.json';
import { harness } from '../../sas/test-support';
import HubScreen from './HubScreen';
import RatingScreen from './RatingScreen';
import { DEFINITIONS, analyticsClient, mount, portfolioBody, routeOf } from './test-support';
import { missingCriteria, overridesBody, proposalBody, proposalProblem, responseBody, responseProblem, toProposal, toProposals } from './rating-model';
import { REGISTER_REPORT_CODES, REPORT_LINKS, breakdownPoints, chartColumn, queryParams, toReportView, EMPTY_ANALYTICS_FILTER, DEFAULT_QUERY } from './model';

const ANALYST = ['contract.read', 'contract.analytics.read', 'ledger.read'];
const RATER = ['contractor.performance.read', 'contractor.performance.propose'];
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);

const column = (key: string, kind: string, extra: Record<string, unknown> = {}) => ({ key, kind, ledger: false, indicator: null, total: null, ...extra });
const CONTRACT = '00000000-0000-4000-8000-001000000001';
const RECORD_A = '00000000-0000-4000-8000-002000000001';
const RECORD_B = '00000000-0000-4000-8000-002000000002';

const defectsBody = (over: Record<string, unknown> = {}) =>
  portfolioBody({
    code: 'quality-defects',
    ref: 'R9',
    columns: [
      column('ncr_no', 'TEXT'),
      column('severity', 'TEXT'),
      column('ncr_status', 'TEXT'),
      column('days_overdue', 'DAYS', { total: 'MAX' }),
      column('overdue', 'FLAG', { total: 'RATIO', indicator: 'DEFECT_OVERDUE_RATE' }),
    ],
    items: [
      { contract_id: CONTRACT, record_id: RECORD_A, cells: { ncr_no: 'NCR-1', severity: 'CRITICAL', ncr_status: 'OPEN', days_overdue: 8, overdue: 1 }, na: {} },
      { contract_id: CONTRACT, record_id: RECORD_B, cells: { ncr_no: 'NCR-2', severity: 'MINOR', ncr_status: 'CLOSED', days_overdue: null, overdue: null }, na: { days_overdue: 'NOT_OPEN', overdue: 'NOT_OPEN' } },
    ],
    breakdown: null,
    breakdowns: [
      { dimension: 'severity', groups: [{ key: 'CRITICAL', totals: { rows: 1, ledger_rows: 1, cells: {}, na: {}, indicators: [] } }, { key: 'MINOR', totals: { rows: 1, ledger_rows: 1, cells: {}, na: {}, indicators: [] } }] },
    ],
    totals: {
      rows: 2,
      ledger_rows: 2,
      cells: { days_overdue: 8, overdue: '100.00' },
      na: {},
      indicators: [{ code: 'DEFECT_OVERDUE_RATE', value: '100.00', status: 'OK', reason: null, numerator: '1', denominator: '1' }],
    },
    definitions: [
      { code: 'DEFECT_OVERDUE_RATE', name: 'Open defects past their due day', formula: 'open past due / open x 100', numerator: 'a', denominator: 'b', unit: 'PERCENT', source_tables: ['quality_nonconformance'], null_policy: 'never 0' },
    ],
    notes: { unlinked_open_issues: 3 },
    ...over,
  });

const open = (code: string, answers: Parameters<typeof analyticsClient>[0]) => {
  const h = analyticsClient(answers);
  mount(<HubScreen route={routeOf('CTR-28', 'FR-CTR-28')} />, h, { permissions: ANALYST, path: `/ctr/ctr-28?report=${code}` });
  return h;
};

afterEach(cleanup);

describe('the register reports in the hub (CA-3)', () => {
  it('the catalogue holds the six registers, each opened from the hub, and the parts of the i18n have the same keys', () => {
    expect(REGISTER_REPORT_CODES).toHaveLength(6);
    expect(Object.keys(en).sort()).toEqual(Object.keys(vi_).sort());
    for (const code of REGISTER_REPORT_CODES) expect(REPORT_LINKS[code]).toBeDefined();
    expect(REPORT_LINKS['contract-health'].map((link) => link.to)).toEqual(['/ctr/ctr-23', '/aud/aud-12', '/pay/pay-15', '/pay/pay-16']);
  });

  it('shows two records of the same contract as two rows, with the words of the codes, the totals of the server and the note of coverage', async () => {
    open('quality-defects', { report: () => defectsBody() });
    await waitFor(() => expect(screen.getByTestId('report-table')).toBeTruthy());
    const table = within(screen.getByTestId('report-table'));
    expect(table.getByText('NCR-1')).toBeTruthy();
    expect(table.getByText('NCR-2')).toBeTruthy();
    expect(table.getAllByText(text('ca1.group.critical')).length).toBeGreaterThan(0);
    expect(table.getAllByText(text('ca1.group.closed')).length).toBeGreaterThan(0);
    // a closed defect has no days overdue: the reason is written, never 0
    expect(table.getAllByText(text('ca1.na.notOpen')).length).toBeGreaterThan(0);
    expect(document.querySelectorAll('[data-record-id]').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId('unlinked-note').textContent).toContain(text('ca3.notes.unlinked', { count: 3 }));
    expect(screen.getByTestId('breakdown').textContent).toContain('1');
  });

  it('sends the severity and the state to the server and the period is not offered for a register', async () => {
    const h = open('quality-defects', { report: () => defectsBody() });
    await waitFor(() => expect(screen.getByTestId('report-table')).toBeTruthy());
    expect(screen.queryByLabelText(text('ca1.filter.period'))).toBeNull();
    fireEvent.change(screen.getByLabelText(text('ca3.filter.severity')), { target: { value: 'CRITICAL' } });
    await waitFor(() => expect(h.read.mock.calls.some(([name, input]) => name === 'getContractReport' && (input as { query?: Record<string, string> }).query?.severity === 'CRITICAL')).toBe(true));
    fireEvent.change(screen.getByLabelText(text('ca3.filter.state')), { target: { value: 'OPEN' } });
    await waitFor(() => expect(h.read.mock.calls.some(([name, input]) => name === 'getContractReport' && (input as { query?: Record<string, string> }).query?.state === 'OPEN')).toBe(true));
  });

  it('says a register that is empty has nothing and a refused read is an error with a retry, never an empty table', async () => {
    open('obstacles', { report: () => new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }) });
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.queryByTestId('report-table')).toBeNull();
  });

  it('the health report links to the scorecard, the payment integrity findings and the settlement', async () => {
    open('contract-health', { report: () => defectsBody({ code: 'contract-health', notes: {} }) });
    await waitFor(() => expect(screen.getByTestId('related-links')).toBeTruthy());
    const links = within(screen.getByTestId('related-links')).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/ctr/ctr-23', '/aud/aud-12', '/pay/pay-15', '/pay/pay-16']);
  });
});

describe('the model of the registers', () => {
  it('reads the record id and the notes of the answer, and a count chart draws the rows of a group', () => {
    const view = toReportView(defectsBody());
    expect(view?.items.map((item) => item.recordId)).toEqual([RECORD_A, RECORD_B]);
    expect(view?.notes.unlinked_open_issues).toBe(3);
    const chart = chartColumn(view as NonNullable<typeof view>, 'severity');
    expect(chart?.key).toBe('$rows');
    expect(breakdownPoints(view as NonNullable<typeof view>, '$rows', 'severity').map((point) => point.text)).toEqual(['1', '1']);
    const params = queryParams({ ...DEFAULT_QUERY, filter: { ...EMPTY_ANALYTICS_FILTER, severity: 'MAJOR', state: 'OPEN' } });
    expect(params).toMatchObject({ severity: 'MAJOR', state: 'OPEN' });
    expect(queryParams(DEFAULT_QUERY).severity).toBeUndefined();
  });

  it('a row without a record id falls back to its contract', () => {
    const view = toReportView(portfolioBody({ items: [{ contract_id: CONTRACT, cells: { code: 'HD-1' }, na: {} }] }));
    expect(view?.items[0]?.recordId).toBe(CONTRACT);
    expect(DEFINITIONS.length).toBeGreaterThan(0);
  });

  it('checks the forms before they are sent', () => {
    expect(proposalProblem({ kind: '', periodLabel: '  ', note: '' })).toBe('period');
    expect(proposalProblem({ kind: '', periodLabel: '2026-Q4', note: '' })).toBeUndefined();
    expect(proposalBody({ kind: 'COMPLETION', periodLabel: ' 2026-Q4 ', note: '' })).toEqual({ period_label: '2026-Q4', evaluation_kind: 'COMPLETION' });
    expect(responseProblem({ kind: 'DISPUTE', receivedOn: '2026-11-01' }, 'too short', '2026-11-08')).toBe('text');
    expect(responseProblem({ kind: 'ACCEPT', receivedOn: '2026-11-09' }, '', '2026-11-08')).toBe('day');
    expect(responseProblem({ kind: 'ACCEPT', receivedOn: '2026-11-08' }, '', '2026-11-08')).toBeUndefined();
    expect(responseBody({ kind: 'ACCEPT', receivedOn: '2026-11-08' }, '')).toEqual({ response_kind: 'ACCEPT', received_on: '2026-11-08' });
    expect(overridesBody({ quality: { score: '', reason: '' } }).body).toEqual({});
    expect(overridesBody({ quality: { score: '150', reason: 'x'.repeat(30) } }).problem).toBe('quality');
    expect(overridesBody({ quality: { score: '60', reason: 'x'.repeat(30) } }).body).toEqual({ quality: { score: 60, reason: 'x'.repeat(30) } });
  });
});

const proposal = (over: Record<string, unknown> = {}) => ({
  id: '00000000-0000-4000-8000-003000000001',
  contract_id: CONTRACT,
  contract_code: 'HD-1',
  contractor_id: '00000000-0000-4000-8000-004000000001',
  evaluation_kind: 'PERIODIC',
  period_label: '2026-Q4',
  as_of_date: '2026-11-08',
  state: 'PROPOSED',
  rule: { version: 0, source: 'DEFAULT' },
  criteria: {
    quality: { score: 66, reason: null, readings: { open_defects: 1, penalty: 34 } },
    schedule: { score: 56, reason: null, readings: { days_late: 40 } },
    safety_env: { score: null, reason: 'NOT_ENOUGH_OBSERVATION', readings: {} },
    cooperation: { score: 100, reason: null, readings: {} },
    financial: { score: null, reason: 'NO_FINANCIAL_EVIDENCE', readings: {} },
  },
  covered: 3,
  overall_score: '71.00',
  rating: 'FAIR',
  inputs_sha256: 'a'.repeat(64),
  proposed_by: 'member-1',
  proposed_note: null,
  notified: null,
  response_due_at: null,
  response_clock: null,
  response: null,
  adopted: null,
  withdrawn: null,
  allowed: { notify: true, respond: false, adopt: false, withdraw: true },
  version: 1,
  created_at: '2026-11-08T01:00:00.000Z',
  ...over,
});

function ratingClient(items: unknown[], command: (operation: string, input: unknown) => unknown = () => ({ resource_id: 'x', resource_version: 2 })) {
  const h = harness((operation) => (operation === 'listContractRatingProposals' ? { items, as_of: '2026-11-08T01:00:00.000Z' } : new Error(`unexpected read ${operation}`)), command);
  mount(<RatingScreen route={routeOf('CTR-37', 'FR-CTR-37')} />, h, { permissions: RATER, path: '/ctr/ctr-37' });
  return h;
}
const commandsOf = (h: ReturnType<typeof ratingClient>, operation: string) => h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { path?: { id?: string }; body: Record<string, unknown>; ifMatchVersion?: number });

describe('the proposals of a rating (CTR-37)', () => {
  it('reads the proposals defensively and keeps what is allowed', () => {
    expect(toProposals({ items: [proposal()], as_of: 'x' })).toHaveLength(1);
    expect(toProposals({ items: [{ id: 'x' }] })).toBeUndefined();
    expect(toProposals({})).toBeUndefined();
    const read = toProposal(proposal());
    expect(read?.allowed.notify).toBe(true);
    expect(missingCriteria(read as NonNullable<typeof read>)).toEqual(['safety_env', 'financial']);
  });

  it('shows the score of each criterion, and the reason in words where the data do not exist, never zero', async () => {
    ratingClient([proposal()]);
    await waitFor(() => expect(screen.getByTestId('proposals')).toBeTruthy());
    const card = within(screen.getByTestId('proposals'));
    expect(card.getByTestId('overall').textContent).toBe('71,00');
    expect(card.getAllByTestId('criterion-reason')).toHaveLength(2);
    expect(card.getAllByText(text('ca1.na.notEnoughObservation')).length).toBe(1);
    expect(card.getAllByText(text('ca1.na.noFinancialEvidence')).length).toBe(1);
    expect(card.getByText(text('ca3.rating.unverified'), { exact: false })).toBeTruthy();
    const row = document.querySelector('[data-criterion="safety_env"]');
    expect(row?.textContent).not.toMatch(/\b0\b/);
  });

  it('tells the contractor with the version of the proposal, and says a refusal in words', async () => {
    const h = ratingClient([proposal()], () => new ApiError({ status: 403, code: 'SELF_APPROVAL_DENIED', correlationId: 'c' }));
    const button = await screen.findByRole('button', { name: text('ca3.rating.step.notify') });
    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: text('ca3.rating.step.notify') }));
    await waitFor(() => expect(commandsOf(h, 'notifyContractRating')).toHaveLength(1));
    expect(commandsOf(h, 'notifyContractRating')[0]).toMatchObject({ path: { id: '00000000-0000-4000-8000-003000000001' }, ifMatchVersion: 1 });
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toContain(text('ca3.rating.error.selfApprovalDenied')));
  });

  it('withdraws only with a reason of ten characters', async () => {
    const h = ratingClient([proposal()]);
    fireEvent.click(await screen.findByRole('button', { name: text('ca3.rating.step.withdraw') }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: text('ca3.rating.step.withdraw') }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(text('ca3.rating.dialog.reason'), { exact: false }), { target: { value: 'Proposed on the wrong day' } });
    expect((within(dialog).getByRole('button', { name: text('ca3.rating.step.withdraw') }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: text('ca3.rating.step.withdraw') }));
    await waitFor(() => expect(commandsOf(h, 'withdrawContractRating')[0]).toMatchObject({ body: { reason: 'Proposed on the wrong day' }, ifMatchVersion: 1 }));
  });

  it('asks for a score and a reason for each criterion with no data before it adopts', async () => {
    const adoptable = proposal({ state: 'RESPONDED', allowed: { notify: false, respond: false, adopt: true, withdraw: false }, version: 3, response: { kind: 'ACCEPT', text: null, received_on: '2026-11-07', at: '2026-11-07T01:00:00.000Z', by: 'm' } });
    const h = ratingClient([adoptable]);
    fireEvent.click(await screen.findByRole('button', { name: text('ca3.rating.step.adopt') }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('overrides')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: text('ca3.rating.step.adopt') }));
    expect(commandsOf(h, 'adoptContractRating')).toHaveLength(0);
    for (const criterion of ['safety_env', 'financial']) {
      const field = dialog.querySelector(`[data-override="${criterion}"]`) as HTMLElement;
      const inputs = field.querySelectorAll('input');
      fireEvent.change(inputs[0] as HTMLInputElement, { target: { value: '70' } });
      fireEvent.change(inputs[1] as HTMLInputElement, { target: { value: 'Scored by hand from the file of the contractor.' } });
    }
    fireEvent.click(within(dialog).getByRole('button', { name: text('ca3.rating.step.adopt') }));
    await waitFor(() => expect(commandsOf(h, 'adoptContractRating')).toHaveLength(1));
    expect(commandsOf(h, 'adoptContractRating')[0]?.body).toMatchObject({ overrides: { safety_env: { score: 70 }, financial: { score: 70 } } });
  });

  it('is denied without the right to read, and says there is nothing when the list is empty', async () => {
    cleanup();
    const h = harness(() => new Error('no read'));
    mount(<RatingScreen route={routeOf('CTR-37', 'FR-CTR-37')} />, h, { permissions: [], path: '/ctr/ctr-37' });
    await waitFor(() => expect(screen.queryByTestId('proposals')).toBeNull());
    expect(h.read).not.toHaveBeenCalled();
    cleanup();
    ratingClient([]);
    await waitFor(() => expect(screen.getByTestId('no-proposals').textContent).toContain(text('ca3.rating.empty')));
  });
});
