import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import IntegrityFindingsScreen from '../../aud/integrity/IntegrityFindingsScreen';
import ExceptionRegisterScreen from './ExceptionRegisterScreen';
import { IntegrityPanel } from './IntegrityPanel';
import { CONTRACT, EXCEPTION, REQUEST, checks, client, commandsOf, exception, finding, mount, routeOf, run, text, uuid, world } from './test-support';
import { dayText, figuresOf, isWholeAmount, toChecks, toRun, vnd } from './model';

afterEach(() => cleanup());

const PANEL = ['payment.integrity.check', 'disbursement.exception.request', 'disbursement.exception.approve'];
const forbidden = new ApiError({ status: 403, code: 'FORBIDDEN', correlationId: 'c', extensions: {} });

describe('the model reads what the server says and never turns a gap into a zero', () => {
  it('writes whole dong in the locale and keeps text that is not an amount as it came', () => {
    expect(vnd('1100000000', 'vi')).toBe('1.100.000.000');
    expect(vnd('1100000000', 'en')).toBe('1,100,000,000');
    expect(vnd('', 'vi')).toBe('');
    expect(vnd('12abc', 'vi')).toBe('12abc');
    expect(dayText('2026-11-08T03:00:00Z')).toBe('08/11/2026');
    expect(isWholeAmount('100')).toBe(true);
    expect(isWholeAmount('0')).toBe(false);
    expect(isWholeAmount('1.5')).toBe(false);
  });
  it('refuses a run without an id or with an outcome nobody knows, and a request without an id', () => {
    expect(toRun({ outcome: 'BLOCKED' })).toBeNull();
    expect(toRun({ id: 'x', outcome: 'MAYBE' })).toBeNull();
    expect(toChecks({})).toBeUndefined();
    expect(toChecks(checks({ run: null }))?.run).toBeNull();
  });
  it('lists the figures of a finding by what it is, and the figures of a code it does not know as they came', () => {
    expect(figuresOf(finding('EXCEEDS_PLAN', 'INVARIANT', { over_by_vnd: '5', available_vnd: '1' })).map((figure) => figure.key)).toEqual(['availableVnd', 'overByVnd']);
    expect(figuresOf({ code: 'FUTURE_CODE', params: { a: 'x', b: 3 } })).toEqual([
      { key: 'a', value: 'x', money: false },
      { key: 'b', value: '3', money: false },
    ]);
  });
});

describe('the panel of the checks on a payment request (PAY-03)', () => {
  it('shows what blocks with the figures, the rule that decided, its source and that its numbers are not confirmed', async () => {
    const h = client(world());
    mount(<IntegrityPanel requestId={REQUEST} />, h, PANEL);
    expect(await screen.findByTestId('integrity-panel')).toBeTruthy();
    expect(await screen.findByText(text('govd.integrity.code.plan'))).toBeTruthy();
    expect(within(screen.getByTestId('blocking')).getByText(text('govd.integrity.finding.block'))).toBeTruthy();
    expect(screen.getByText(text('govd.integrity.meaning.plan'))).toBeTruthy();
    expect(screen.getByText('1.100.000.000')).toBeTruthy();
    expect(screen.getByTestId('outcome-line').textContent).toContain(text('govd.integrity.counts', { blocks: 1, signals: 0, excused: 0 }));
    expect(screen.getByTestId('rule').textContent).toContain(text('govd.integrity.rule.default', { day: '08/11/2026' }));
    expect(screen.getByTestId('unverified').textContent).toBe(text('govd.integrity.rule.unverified'));
    expect(screen.getByTestId('formula').textContent).toBe(text('govd.integrity.rule.formula', { formula: 'Chặn khi vượt trần' }));
    expect(screen.getByTestId('origin').textContent).toContain('G4-2 của lộ trình');
    expect(screen.queryByTestId('passed')).toBeNull();
  });

  it('a request nobody checked says so and offers the check; the check is a command on that request', async () => {
    const h = client(world({ checks: checks({ run: null }) }));
    mount(<IntegrityPanel requestId={REQUEST} />, h, PANEL);
    expect((await screen.findByTestId('never-checked')).textContent).toBe(text('govd.integrity.never'));
    fireEvent.click(screen.getByText(text('govd.integrity.check')));
    await waitFor(() => expect(commandsOf(h, 'checkPaymentIntegrity')).toHaveLength(1));
    expect(commandsOf(h, 'checkPaymentIntegrity')[0]).toMatchObject({ path: { id: REQUEST }, body: {} });
  });

  it('a source that could not be read is told, and the run is never shown as passed', async () => {
    mount(<IntegrityPanel requestId={REQUEST} />, client(world({ checks: checks({ run: run({ outcome: 'PARTIAL', invariant_count: 0, findings: [], unavailable: ['DIARY'] }) }) })), PANEL);
    expect((await screen.findByTestId('unavailable')).textContent).toBe(text('govd.integrity.unavailable', { sources: text('govd.integrity.source.diary') }));
    expect(screen.queryByTestId('passed')).toBeNull();
    expect(screen.getAllByText(text('govd.integrity.outcome.partial')).length).toBeGreaterThan(0);
  });

  it('a run with nothing found and every source read says it passed', async () => {
    mount(<IntegrityPanel requestId={REQUEST} />, client(world({ checks: checks({ run: run({ outcome: 'PASSED', invariant_count: 0, findings: [] }) }) })), PANEL);
    expect((await screen.findByTestId('passed')).textContent).toBe(text('govd.integrity.passed'));
  });

  it('tells signals from blocks, marks a finding that an exception covers, and says when a twin lies outside the scope', async () => {
    const covered = finding('EXCEEDS_CONTRACT', 'INVARIANT', { over_by_vnd: '250000000', basis: 'CASH_OUT' }, { excused: true, exception_id: EXCEPTION });
    const dup = finding('DUPLICATE_CLAIM', 'SIGNAL', { matched: ['SUPPLIER', 'AMOUNT', 'DATE'] }, { subject: { other_hidden: true } });
    const price = finding('UNIT_PRICE_OUTLIER', 'SIGNAL', { unit_price: '1500000', contract_unit_price: '2000000', reasons: ['CONTRACT_PRICE'] });
    mount(<IntegrityPanel requestId={REQUEST} />, client(world({ checks: checks({ run: run({ outcome: 'SIGNALS', invariant_count: 1, excused_count: 1, signal_count: 2, findings: [covered, dup, price] }) }) })), PANEL);
    expect(await screen.findByTestId('signals')).toBeTruthy();
    expect(within(screen.getByTestId('blocking')).getByText(text('govd.integrity.finding.excused'))).toBeTruthy();
    expect(within(screen.getByTestId('signals')).getAllByText(text('govd.integrity.finding.signal')).length).toBe(2);
    expect(screen.getByText(text('govd.integrity.finding.twinHidden'))).toBeTruthy();
    expect(screen.getByText(text('govd.integrity.code.price'))).toBeTruthy();
  });

  it('asking for an exception: validates the amount and the reason, then sends the ceiling, the amount, the day and the reason', async () => {
    const h = client(world({ exceptions: [] , checks: checks({ exceptions: [] }) }));
    mount(<IntegrityPanel requestId={REQUEST} />, h, PANEL);
    fireEvent.click(await screen.findByText(text('govd.integrity.ask')));
    const form = await screen.findByTestId('exception-form');
    fireEvent.click(within(form).getByText(text('govd.integrity.form.submit')));
    expect((await screen.findByTestId('form-error')).textContent).toBe(text('govd.integrity.form.amountInvalid'));
    fireEvent.change(screen.getByTestId('amount'), { target: { value: '1100000000' } });
    fireEvent.click(within(form).getByText(text('govd.integrity.form.submit')));
    expect((await screen.findByTestId('form-error')).textContent).toBe(text('govd.integrity.exception.reasonNeeded'));
    fireEvent.change(screen.getByTestId('reason'), { target: { value: '  Chờ điều chỉnh kế hoạch vốn  ' } });
    fireEvent.change(screen.getByTestId('valid-to'), { target: { value: '2026-11-20' } });
    fireEvent.click(within(form).getByText(text('govd.integrity.form.submit')));
    await waitFor(() => expect(commandsOf(h, 'requestDisbursementException')).toHaveLength(1));
    expect(commandsOf(h, 'requestDisbursementException')[0]).toMatchObject({ path: { id: REQUEST }, body: { ceiling: 'EXCEEDS_PLAN', allowed_amount_vnd: '1100000000', valid_to: '2026-11-20', reason: 'Chờ điều chỉnh kế hoạch vốn' } });
  });

  it('a refusal of the server is shown with its code, and the form stays', async () => {
    const h = client(world({ exceptions: [], checks: checks({ exceptions: [] }) }), () => new ApiError({ status: 422, code: 'DISBURSEMENT_EXCEPTION_WINDOW_INVALID', correlationId: 'c', extensions: {} }));
    mount(<IntegrityPanel requestId={REQUEST} />, h, PANEL);
    fireEvent.click(await screen.findByText(text('govd.integrity.ask')));
    fireEvent.change(screen.getByTestId('amount'), { target: { value: '5' } });
    fireEvent.change(screen.getByTestId('reason'), { target: { value: 'x' } });
    fireEvent.click(within(screen.getByTestId('exception-form')).getByText(text('govd.integrity.form.submit')));
    expect((await screen.findByTestId('form-error')).textContent).toBe(text('govd.integrity.error.refused', { code: 'DISBURSEMENT_EXCEPTION_WINDOW_INVALID' }));
    expect(screen.getByTestId('exception-form')).toBeTruthy();
  });

  it('does not offer a way past a ceiling that an exception already covers or that someone asked for, nor to a caller without the right', async () => {
    const asked = exception({ status: 'REQUESTED' });
    mount(<IntegrityPanel requestId={REQUEST} />, client(world({ checks: checks({ exceptions: [asked] }) })), PANEL);
    await screen.findByTestId('exceptions');
    expect(screen.queryByText(text('govd.integrity.ask'))).toBeNull();
    cleanup();
    mount(<IntegrityPanel requestId={REQUEST} />, client(world({ checks: checks({ exceptions: [] }) })), ['payment_request.read']);
    await screen.findByTestId('blocking');
    expect(screen.queryByText(text('govd.integrity.ask'))).toBeNull();
    expect(screen.queryByText(text('govd.integrity.recheck'))).toBeNull();
  });

  it('deciding an exception: approval needs no words, refusal needs a reason, and the command carries the version that was seen', async () => {
    const h = client(world({ checks: checks({ exceptions: [exception({ version: 4 })] }) }));
    mount(<IntegrityPanel requestId={REQUEST} />, h, PANEL);
    fireEvent.click(await screen.findByText(text('govd.integrity.exception.reject')));
    expect((await screen.findByTestId('exception-error')).textContent).toBe(text('govd.integrity.exception.reasonNeeded'));
    expect(commandsOf(h, 'rejectDisbursementException')).toHaveLength(0);
    fireEvent.change(screen.getByTestId('decision-note'), { target: { value: 'Chưa đủ căn cứ' } });
    fireEvent.click(screen.getByText(text('govd.integrity.exception.reject')));
    await waitFor(() => expect(commandsOf(h, 'rejectDisbursementException')).toHaveLength(1));
    expect(commandsOf(h, 'rejectDisbursementException')[0]).toMatchObject({ path: { id: EXCEPTION }, body: { reason: 'Chưa đủ căn cứ' }, ifMatchVersion: 4 });
    fireEvent.click(screen.getByText(text('govd.integrity.exception.approve')));
    await waitFor(() => expect(commandsOf(h, 'approveDisbursementException')).toHaveLength(1));
    expect(commandsOf(h, 'approveDisbursementException')[0]).toMatchObject({ path: { id: EXCEPTION }, body: {}, ifMatchVersion: 4 });
  });

  it('states: loading is a skeleton and never a finding, a failed read is an error with a retry, a refusal is denied, a request that is not there is empty', async () => {
    const slow = client(world());
    slow.read.mockImplementation(() => new Promise(() => undefined));
    mount(<IntegrityPanel requestId={REQUEST} />, slow, PANEL);
    expect(screen.queryByTestId('blocking')).toBeNull();
    expect(screen.queryByTestId('never-checked')).toBeNull();
    cleanup();
    mount(<IntegrityPanel requestId={REQUEST} />, client(world({ failing: new Set(['getPaymentIntegrityChecks']) })), PANEL);
    expect(await screen.findByRole('alert')).toBeTruthy();
    cleanup();
    const denied = client(world());
    denied.read.mockRejectedValue(forbidden);
    mount(<IntegrityPanel requestId={REQUEST} />, denied, PANEL);
    expect(await screen.findByText(text('states.denied.title'))).toBeTruthy();
    expect(screen.queryByTestId('blocking')).toBeNull();
    cleanup();
    const missing = client(world());
    missing.read.mockRejectedValue(new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c', extensions: {} }));
    mount(<IntegrityPanel requestId={REQUEST} />, missing, PANEL);
    await waitFor(() => expect(screen.queryByTestId('integrity-panel')).toBeTruthy());
    expect(screen.queryByTestId('blocking')).toBeNull();
    expect(screen.queryByTestId('never-checked')).toBeNull();
  });
});

describe('the register of exceptions (PAY-21)', () => {
  const route = routeOf('PAY-21', 'PAY');
  it('lists the exceptions with the ceiling, the most amount, the day, the reason and the state, and a lapsing one says how many days are left', async () => {
    const items = [exception({ status: 'REQUESTED' }), exception({ id: uuid(4), status: 'APPROVED', days_left: 3, ceiling: 'EXCEEDS_CONTRACT', reason: 'Tạm ứng chưa thu hồi' }), exception({ id: uuid(5), status: 'EXPIRED', days_left: null })];
    mount(<ExceptionRegisterScreen route={route} />, client(world({ exceptions: items })), PANEL);
    expect(await screen.findByText('Tạm ứng chưa thu hồi')).toBeTruthy();
    expect(screen.getAllByText('1.100.000.000').length).toBe(3);
    expect(screen.getByText(text('govd.integrity.register.expiring', { days: 3 }))).toBeTruthy();
    expect(within(screen.getByRole('table')).getByText(text('govd.integrity.exception.status.expired'))).toBeTruthy();
    expect(screen.getAllByRole('link').some((link) => link.getAttribute('href') === `/pay/pay-03?request=${REQUEST}`)).toBe(true);
    expect(document.querySelector('.ui-context__asof')).not.toBeNull();
  });

  it('is empty when there is none, says so for a filter, and reads again with the status that was chosen', async () => {
    const h = client(world({ exceptions: [] }));
    mount(<ExceptionRegisterScreen route={route} />, h, PANEL);
    expect(await screen.findByText(text('states.empty.title'))).toBeTruthy();
    fireEvent.change(screen.getByTestId('status-filter'), { target: { value: 'APPROVED' } });
    await waitFor(() => expect(h.client.readAll).toHaveBeenLastCalledWith('listDisbursementExceptions', { query: { status: 'APPROVED' } }));
  });

  it('a failing read is an error with a retry, never an empty list', async () => {
    mount(<ExceptionRegisterScreen route={route} />, client(world({ failing: new Set(['listDisbursementExceptions']) })), PANEL);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(text('states.empty.title'))).toBeNull();
  });

  it('deciding asks for a reason to refuse and sends the version that was seen; the answer is told', async () => {
    const h = client(world({ exceptions: [exception({ version: 3 })] }));
    mount(<ExceptionRegisterScreen route={route} />, h, PANEL);
    fireEvent.click(await screen.findByText(text('govd.integrity.exception.reject')));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByText(text('govd.integrity.exception.reject'));
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Không đủ căn cứ' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(commandsOf(h, 'rejectDisbursementException')).toHaveLength(1));
    expect(commandsOf(h, 'rejectDisbursementException')[0]).toMatchObject({ path: { id: EXCEPTION }, body: { reason: 'Không đủ căn cứ' }, ifMatchVersion: 3 });
    expect((await screen.findByTestId('done')).textContent).toBe(text('govd.integrity.decide.done'));
  });

  it('shows no buttons to a caller who may not decide', async () => {
    mount(<ExceptionRegisterScreen route={route} />, client(world()), ['disbursement.exception.read']);
    await screen.findByText('Chờ điều chỉnh kế hoạch vốn');
    expect(screen.queryByText(text('govd.integrity.exception.approve'))).toBeNull();
  });
});

describe('the findings for the auditor (AUD-12)', () => {
  const route = routeOf('AUD-12', 'AUD');
  const line = (n: number, overrides: Record<string, unknown> = {}) => ({
    ...finding('EXCEEDS_PLAN', 'INVARIANT', { over_by_vnd: '1100000000' }, { id: uuid(300 + n) }),
    run_id: uuid(50),
    payment_request_id: REQUEST,
    request_no: `DNTT-00${n}`,
    contract_id: CONTRACT,
    contract_code: 'HD-001',
    project_code: 'DA-01',
    trigger: 'SUBMIT',
    outcome: 'BLOCKED',
    rule_version: 0,
    created_at: '2026-11-08T03:00:00.000000Z',
    ...overrides,
  });

  it('lists the findings with the day, the kind, the request, the contract, the project and the rule that decided; a row opens its figures', async () => {
    const h = client(world({ findingPages: [{ items: [line(1), line(2, { ...finding('UNIT_PRICE_OUTLIER', 'SIGNAL', { unit_price: '1' }, { id: uuid(399) }), rule_version: 3 })], next_cursor: null }] }));
    mount(<IntegrityFindingsScreen route={route} />, h, ['payment.integrity.audit.read']);
    expect(await screen.findByText('DNTT-001')).toBeTruthy();
    expect(screen.getAllByText('08/11/2026').length).toBeGreaterThan(0);
    expect(screen.getByText(text('govd.integrity.rule.version', { version: 3 }))).toBeTruthy();
    expect(screen.getByText(text('govd.integrity.rule.builtin'))).toBeTruthy();
    expect(screen.getByText(text('govd.integrity.audit.blocks', { count: 1 }))).toBeTruthy();
    fireEvent.click(document.querySelector(`[data-finding="${uuid(301)}"]`) as Element);
    expect(within(await screen.findByTestId('detail')).getByText('1.100.000.000')).toBeTruthy();
  });

  it('asks the server for the filters that are whole, a page at a time, and shows more on demand', async () => {
    const h = client(world({ findingPages: [{ items: [line(1)], next_cursor: '1' }, { items: [line(2)], next_cursor: null }] }));
    mount(<IntegrityFindingsScreen route={route} />, h, ['payment.integrity.audit.read']);
    await screen.findByText('DNTT-001');
    expect(screen.queryByText('DNTT-002')).toBeNull();
    fireEvent.click(screen.getByTestId('more'));
    expect(await screen.findByText('DNTT-002')).toBeTruthy();
    expect(screen.queryByTestId('more')).toBeNull();
    fireEvent.change(screen.getByTestId('code-filter'), { target: { value: 'DUPLICATE_CLAIM' } });
    fireEvent.change(screen.getByTestId('from'), { target: { value: '2026-1' } });
    await waitFor(() => expect(h.read).toHaveBeenLastCalledWith('listPaymentIntegrityFindings', { query: { limit: '50', code: 'DUPLICATE_CLAIM' } }));
    fireEvent.change(screen.getByTestId('from'), { target: { value: '2026-11-01' } });
    await waitFor(() => expect(h.read).toHaveBeenLastCalledWith('listPaymentIntegrityFindings', { query: { limit: '50', code: 'DUPLICATE_CLAIM', from: '2026-11-01' } }));
  });

  it('is empty when nothing was found, and a failing read is an error with a retry, never an empty list', async () => {
    mount(<IntegrityFindingsScreen route={route} />, client(world()), ['payment.integrity.audit.read']);
    expect(await screen.findByText(text('states.empty.title'))).toBeTruthy();
    cleanup();
    mount(<IntegrityFindingsScreen route={route} />, client(world({ failing: new Set(['listPaymentIntegrityFindings']) })), ['payment.integrity.audit.read']);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(text('states.empty.title'))).toBeNull();
  });
});
