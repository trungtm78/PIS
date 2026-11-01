import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { harness, mount, routeOf } from '../mne/test-support';
import DecisionLogScreen from './DecisionLogScreen';
import { EMPTY_ENGAGE, decisionQuery, engageBody, toDecision, toDecisionPage, toKillSwitch, toKillSwitchPage, validateEngage } from './emergency-model';
import KillSwitchScreen from './KillSwitchScreen';

const CONSOLE = routeOf('LLM-18', 'FR-LLM-18');
const LOG = routeOf('LLM-20', 'FR-LLM-20');
const SECURITY = ['llm.emergency', 'llm.audit.read'];
const AUDITOR = ['llm.audit.read'];
const failure = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c', extensions: {} });
const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const rawSwitch = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: id(n),
  scope_kind: 'PROFILE',
  scope_ref: 'BID_ANALYSIS',
  reason: 'Suspected leak of data through the output',
  state: 'ENGAGED',
  engaged_by: id(900),
  engaged_at: '2026-10-28T09:00:00.000Z',
  release_approved_by: null,
  released_at: null,
  release_reason: null,
  affected_requests: 8,
  version: 3,
  ...overrides,
});
const rawDecision = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: id(n),
  ai_request_id: id(50),
  subject_module: 'PAY',
  subject_kind: 'alert_amount',
  subject_id: id(60),
  ai_output_sha256: 'a'.repeat(64),
  action_kind: 'MONEY',
  decision: 'ACCEPTED_WITH_CHANGE',
  rationale: 'The amount was checked against the ledger and corrected',
  decided_by: id(901),
  decided_at: '2026-10-28T10:00:00.000Z',
  applied_operation_id: 'approvePaymentAlert',
  applied_resource_version: '7',
  ...overrides,
});
const page = (items: unknown[], extra: Record<string, unknown> = {}) => ({ items, next_cursor: null, as_of: '2026-10-28T00:00:00.000Z', ...extra });

function client(answer: (operation: string, input: unknown) => unknown, command: (operation: string, input: unknown) => unknown = () => ({})) {
  const h = harness((operation, input) => answer(operation, input), command);
  return h;
}
function withSwitches(switches: unknown[] | Error, command: (operation: string, input: unknown) => unknown = () => ({})) {
  const h = client(() => new Error('unexpected read'), command);
  const readAll = vi.fn((operation: string) =>
    operation === 'listAiKillSwitches' ? (switches instanceof Error ? Promise.reject(switches) : Promise.resolve(switches)) : Promise.reject(new Error(`unexpected readAll ${operation}`)),
  );
  (h.client as unknown as { readAll: typeof readAll }).readAll = readAll;
  return Object.assign(h, { readAll });
}

afterEach(cleanup);

describe('the pure rules of the emergency screens (ST-LLM-006)', () => {
  it('reads a switch and a page of switches, and refuses a row that is not one', () => {
    expect(toKillSwitch(rawSwitch(1))).toMatchObject({ scope: 'PROFILE', scopeRef: 'BID_ANALYSIS', state: 'ENGAGED', affected: 8, version: 3, releasedBy: null });
    expect(toKillSwitch(rawSwitch(1, { scope_kind: 'GALAXY' }))).toBeUndefined();
    expect(toKillSwitch(rawSwitch(1, { state: 'MAYBE' }))).toBeUndefined();
    expect(toKillSwitch(null)).toBeUndefined();
    expect(toKillSwitchPage(page([rawSwitch(1), { nope: 1 }], { next_cursor: 'c' }))).toMatchObject({ next: 'c', items: [{ id: id(1) }] });
  });

  it('checks the form before an emergency stop is asked for: no reference for the tenant, an id for a provider or a model, a name for a task, and a reason of ten characters', () => {
    const ok = { ...EMPTY_ENGAGE, reason: 'Suspected leak of data' };
    expect(validateEngage(ok)).toEqual({});
    expect(validateEngage({ ...ok, scopeRef: 'x' })).toEqual({ scopeRef: 'noRef' });
    expect(validateEngage({ ...ok, scope: 'PROVIDER' })).toEqual({ scopeRef: 'required' });
    expect(validateEngage({ ...ok, scope: 'MODEL', scopeRef: 'dom-model' })).toEqual({ scopeRef: 'invalidId' });
    expect(validateEngage({ ...ok, scope: 'MODEL', scopeRef: id(5) })).toEqual({});
    expect(validateEngage({ ...ok, scope: 'PROFILE', scopeRef: 'x' })).toEqual({ scopeRef: 'required' });
    expect(validateEngage({ ...ok, scope: 'TASK_TYPE', scopeRef: 'SUMMARY' })).toEqual({});
    expect(validateEngage({ ...ok, reason: 'short' })).toEqual({ reason: 'shortReason' });
    expect(engageBody({ ...ok, scopeRef: 'ignored' })).toEqual({ scope_kind: 'TENANT', reason: 'Suspected leak of data' });
    expect(engageBody({ scope: 'PROFILE', scopeRef: ' BID_ANALYSIS ', reason: ' Suspected leak of data ' })).toEqual({
      scope_kind: 'PROFILE',
      scope_ref: 'BID_ANALYSIS',
      reason: 'Suspected leak of data',
    });
  });

  it('reads a decision and a page of decisions, and asks the server only for the filter that was chosen', () => {
    expect(toDecision(rawDecision(1))).toMatchObject({ module: 'PAY', action: 'MONEY', decision: 'ACCEPTED_WITH_CHANGE', appliedOperation: 'approvePaymentAlert', appliedVersion: '7' });
    expect(toDecision(rawDecision(1, { decision: 'MAYBE' }))).toBeUndefined();
    expect(toDecision(rawDecision(1, { action_kind: 'DELETE' }))).toBeUndefined();
    expect(toDecisionPage(page([rawDecision(1), null]))).toMatchObject({ items: [{ id: id(1) }], next: undefined });
    expect(decisionQuery({ module: '', decision: '' })).toEqual({});
    expect(decisionQuery({ module: ' pay ', decision: 'REJECTED' })).toEqual({ subject_module: 'PAY', decision: 'REJECTED' });
  });
});

describe('LLM-18 emergency stop (ST-LLM-006, LLM F7, BR-LLM-12)', () => {
  it('AC-ST-LLM-006-1: UAT-AC21 shows each switch with its scope, reason, who engaged it, how many requests it stopped, and whether it is released and by whom', async () => {
    const released = rawSwitch(2, {
      scope_kind: 'TENANT',
      scope_ref: null,
      state: 'RELEASED',
      release_approved_by: id(902),
      released_at: '2026-10-28T11:00:00.000Z',
      release_reason: 'The cause was found and fixed',
    });
    mount(<KillSwitchScreen route={CONSOLE} />, withSwitches([rawSwitch(1), released]), { permissions: SECURITY });
    const table = await screen.findByTestId('switch-table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]?.textContent).toContain(vi_['llm.killScope.profile']);
    expect(rows[0]?.textContent).toContain('BID_ANALYSIS');
    expect(rows[0]?.textContent).toContain('Suspected leak of data through the output');
    expect(rows[0]?.textContent).toContain('8');
    expect(rows[0]?.textContent).toContain(vi_['llm.killState.engaged']);
    expect(rows[1]?.textContent).toContain(vi_['llm.killScope.tenant']);
    expect(rows[1]?.textContent).toContain(vi_['llm.killState.released']);
    expect(rows[1]?.textContent).toContain('The cause was found and fixed');
    expect(screen.getByTestId('emergency-engaged').textContent).toBe(fill(vi_['llm.emergency.engagedCount'], { count: 1 }));
    expect(within(rows[0] as HTMLElement).getByRole('button', { name: vi_['llm.emergency.release'] })).toBeTruthy();
    expect(within(rows[1] as HTMLElement).queryAllByRole('button').length).toBe(0);
  });

  it('says that nothing is engaged, and still offers to engage a stop', async () => {
    mount(<KillSwitchScreen route={CONSOLE} />, withSwitches([]), { permissions: SECURITY });
    expect((await screen.findByTestId('emergency-clear')).textContent).toBe(vi_['llm.emergency.clear']);
    expect(screen.getByTestId('switches-none').textContent).toBe(vi_['llm.emergency.none']);
    expect(screen.getByRole('form', { name: vi_['llm.emergency.form.title'] })).toBeTruthy();
  });

  it('AC-ST-LLM-006-1: UAT-AC21 checks the form, asks the person to confirm, and then engages the stop with what was chosen', async () => {
    const user = userEvent.setup();
    const h = withSwitches([], () => ({ status: 'ENGAGED', affected_requests: 8, cancelled: 7, killed_pending: 1 }));
    mount(<KillSwitchScreen route={CONSOLE} />, h, { permissions: SECURITY });
    const form = await screen.findByRole('form', { name: vi_['llm.emergency.form.title'] });
    expect(within(form).queryByLabelText(vi_['llm.emergency.form.ref'])).toBeNull();
    await user.click(within(form).getByRole('button', { name: vi_['llm.emergency.form.submit'] }));
    expect(await within(form).findByText(fill(vi_['llm.emergency.problem.shortReason'], { count: 10 }))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.selectOptions(within(form).getByLabelText(vi_['llm.emergency.form.scope']), 'PROFILE');
    await user.type(within(form).getByLabelText(vi_['llm.emergency.form.reason']), 'Suspected leak of data through the output');
    await user.click(within(form).getByRole('button', { name: vi_['llm.emergency.form.submit'] }));
    expect(await within(form).findByText(vi_['llm.problem.required'])).toBeTruthy();
    await user.type(within(form).getByLabelText(vi_['llm.emergency.form.ref']), 'BID_ANALYSIS');
    await user.click(within(form).getByRole('button', { name: vi_['llm.emergency.form.submit'] }));
    expect((await within(form).findByTestId('engage-unconfirmed')).textContent).toBe(vi_['llm.emergency.form.unconfirmed']);
    expect(h.command).not.toHaveBeenCalled();
    await user.click(within(form).getByLabelText(vi_['llm.emergency.form.confirm']));
    await user.click(within(form).getByRole('button', { name: vi_['llm.emergency.form.submit'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toMatchObject(['engageAiKillSwitch', { body: { scope_kind: 'PROFILE', scope_ref: 'BID_ANALYSIS', reason: 'Suspected leak of data through the output' } }]);
    expect(await screen.findByTestId('engage-done')).toBeTruthy();
    // The list is read again after the stop.
    await waitFor(() => expect(h.readAll.mock.calls.filter((call) => call[0] === 'listAiKillSwitches').length).toBeGreaterThan(1));
  });

  it('keeps what was typed for the next stop while one is being engaged, and asks for the confirmation again', async () => {
    const user = userEvent.setup();
    let settle: () => void = () => undefined;
    const h = withSwitches([], () => new Promise((resolve) => (settle = () => resolve({ status: 'ENGAGED', affected_requests: 1, cancelled: 1, killed_pending: 0 }))));
    mount(<KillSwitchScreen route={CONSOLE} />, h, { permissions: SECURITY });
    const form = await screen.findByRole('form', { name: vi_['llm.emergency.form.title'] });
    const reason = within(form).getByLabelText(vi_['llm.emergency.form.reason']) as HTMLTextAreaElement;
    await user.type(reason, 'Suspected leak of data through the output');
    await user.click(within(form).getByLabelText(vi_['llm.emergency.form.confirm']));
    await user.click(within(form).getByRole('button', { name: vi_['llm.emergency.form.submit'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    fireEvent.submit(form);
    await user.type(reason, ' and a second one');
    await act(async () => settle());
    await screen.findByTestId('engage-done');
    expect(reason.value).toBe('Suspected leak of data through the output and a second one');
    expect((within(form).getByLabelText(vi_['llm.emergency.form.confirm']) as HTMLInputElement).checked).toBe(false);
    expect(h.command).toHaveBeenCalledTimes(1);
  });

  it('puts the refusal of a second stop of the same scope in words', async () => {
    const user = userEvent.setup();
    mount(
      <KillSwitchScreen route={CONSOLE} />,
      withSwitches([], () => failure(409, 'KILL_SWITCH_ALREADY_ENGAGED')),
      { permissions: SECURITY },
    );
    const form = await screen.findByRole('form', { name: vi_['llm.emergency.form.title'] });
    await user.type(within(form).getByLabelText(vi_['llm.emergency.form.reason']), 'Suspected leak of data through the output');
    await user.click(within(form).getByLabelText(vi_['llm.emergency.form.confirm']));
    await user.click(within(form).getByRole('button', { name: vi_['llm.emergency.form.submit'] }));
    expect((await screen.findByTestId('engage-refused')).textContent).toBe(vi_['llm.reason.general']);
  });

  it('AC-ST-LLM-006-1: UAT-AC21 releases a stop with a reason of ten characters at the version it was read at, and says that the one who engaged it cannot', async () => {
    const user = userEvent.setup();
    const h = withSwitches([rawSwitch(1)], () => failure(403, 'SELF_APPROVAL_DENIED'));
    mount(<KillSwitchScreen route={CONSOLE} />, h, { permissions: SECURITY });
    const table = await screen.findByTestId('switch-table');
    await user.click(within(table).getByRole('button', { name: vi_['llm.emergency.release'] }));
    const form = await screen.findByRole('form', { name: vi_['llm.emergency.release.title'] });
    expect(within(form).getByText(vi_['llm.emergency.release.hint'])).toBeTruthy();
    await user.type(within(form).getByLabelText(vi_['llm.emergency.release.reason']), 'short');
    await user.click(within(form).getByRole('button', { name: vi_['llm.emergency.release.submit'] }));
    expect(await within(form).findByText(fill(vi_['llm.emergency.problem.shortReason'], { count: 10 }))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.type(within(form).getByLabelText(vi_['llm.emergency.release.reason']), ' - the cause was found');
    await user.click(within(form).getByRole('button', { name: vi_['llm.emergency.release.submit'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toMatchObject(['releaseAiKillSwitch', { path: { id: id(1) }, ifMatchVersion: 3, body: { release_reason: 'short - the cause was found' } }]);
    expect((await screen.findByTestId('release-refused')).textContent).toBe(vi_['llm.reason.selfApproval']);
  });

  it('offers neither the form nor a release to who can only read, and in a read-only session', async () => {
    const { unmount } = mount(<KillSwitchScreen route={CONSOLE} />, withSwitches([rawSwitch(1)]), { permissions: AUDITOR });
    const table = await screen.findByTestId('switch-table');
    expect(within(table).queryAllByRole('button').length).toBe(0);
    expect(screen.queryByRole('form', { name: vi_['llm.emergency.form.title'] })).toBeNull();
    unmount();
    mount(<KillSwitchScreen route={CONSOLE} />, withSwitches([rawSwitch(1)]), { permissions: SECURITY, mode: 'READ_ONLY' });
    const again = await screen.findByTestId('switch-table');
    expect(within(again).queryAllByRole('button').length).toBe(0);
    expect(screen.queryByRole('form')).toBeNull();
  });

  describe('the standard states', () => {
    it.each([
      ['denied', failure(403, 'SCOPE_DENIED'), vi_['states.denied.title']],
      ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      ['error', failure(500, 'INTERNAL_ERROR'), vi_['states.error.title']],
      ['signed out', failure(401, 'SESSION_EXPIRED'), vi_['states.signedOut.title']],
    ] as const)('UI-LLM-18 shows the %s state', async (_name, error, text) => {
      mount(<KillSwitchScreen route={CONSOLE} />, withSwitches(error), { permissions: SECURITY });
      expect((await screen.findAllByText(text)).length).toBeGreaterThan(0);
    });

    it('UI-LLM-18 shows the loading state first and names the page', () => {
      const h = harness(() => new Promise(() => undefined));
      (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => new Promise(() => undefined));
      mount(<KillSwitchScreen route={CONSOLE} />, h, { permissions: SECURITY });
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(screen.getByRole('region', { name: vi_['llm.emergency.page.title'] })).toBeTruthy();
    });
  });
});

describe('LLM-20 human decision records (ST-LLM-006, LLM F8)', () => {
  it('AC-ST-LLM-006-2: UAT-AC468 shows each decision with who decided, about what, the action, the decision, the rationale, a link to the answer and where it was applied', async () => {
    const world = page([rawDecision(1), rawDecision(2, { decision: 'REJECTED', action_kind: 'DECISION', subject_module: 'BID', applied_operation_id: null, applied_resource_version: null })]);
    mount(
      <DecisionLogScreen route={LOG} />,
      client(() => world),
      { permissions: AUDITOR },
    );
    const table = await screen.findByTestId('decision-table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]?.textContent).toContain('2026-10-28');
    expect(rows[0]?.textContent).toContain('PAY · alert_amount');
    expect(rows[0]?.textContent).toContain(vi_['llm.actionKind.money']);
    expect(rows[0]?.textContent).toContain(vi_['llm.decision.acceptedWithChange']);
    expect(rows[0]?.textContent).toContain('The amount was checked against the ledger and corrected');
    expect(rows[0]?.textContent).toContain(fill(vi_['llm.decisions.applied'], { operation: 'approvePaymentAlert', version: '7' }));
    expect(
      within(rows[0] as HTMLElement)
        .getByRole('link')
        .getAttribute('href'),
    ).toBe(`/llm/llm-05?request=${id(50)}`);
    expect(within(rows[0] as HTMLElement).getByRole('link').textContent).toBe('a'.repeat(12));
    expect(rows[1]?.textContent).toContain(vi_['llm.decision.rejected']);
    expect(rows[1]?.textContent).toContain(vi_['llm.decisions.notApplied']);
    // The table has no control that changes a record: it is written once.
    expect(within(table).queryAllByRole('button').length).toBe(0);
  });

  it('narrows the list by module and decision and asks the server for it, and keeps the form while the new list loads', async () => {
    const user = userEvent.setup();
    const h = client(() => page([rawDecision(1)]));
    mount(<DecisionLogScreen route={LOG} />, h, { permissions: AUDITOR });
    await screen.findByTestId('decision-table');
    expect(h.read.mock.calls[0]).toEqual(['listAiDecisionRecords', { query: { limit: 50 } }]);
    await user.selectOptions(screen.getByLabelText(vi_['llm.decisions.filter.decision']), 'REJECTED');
    await user.type(screen.getByLabelText(vi_['llm.decisions.filter.module']), 'pay');
    await waitFor(() => expect(h.read.mock.calls.at(-1)).toEqual(['listAiDecisionRecords', { query: { limit: 50, subject_module: 'PAY', decision: 'REJECTED' } }]));
    expect((screen.getByLabelText(vi_['llm.decisions.filter.module']) as HTMLInputElement).value).toBe('pay');
  });

  it('reads the next page when asked, and says when it could not, while the records already read stay', async () => {
    const user = userEvent.setup();
    const h = client((_operation, input) => ((input as { query: { cursor?: string } }).query.cursor === undefined ? page([rawDecision(1)], { next_cursor: 'p2' }) : failure(500, 'INTERNAL_ERROR')));
    mount(<DecisionLogScreen route={LOG} />, h, { permissions: AUDITOR });
    await user.click(await screen.findByTestId('decisions-more'));
    expect(await screen.findByTestId('decisions-more-failed')).toBeTruthy();
    expect(within(screen.getByTestId('decision-table')).getAllByRole('row').length).toBe(2);
  });

  it.each([
    ['denied', failure(403, 'SCOPE_DENIED'), vi_['states.denied.title']],
    ['error', failure(500, 'INTERNAL_ERROR'), vi_['states.error.title']],
    ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
  ] as const)('UI-LLM-20 shows the %s state', async (_name, error, text) => {
    mount(
      <DecisionLogScreen route={LOG} />,
      client(() => error),
      { permissions: AUDITOR },
    );
    expect((await screen.findAllByText(text)).length).toBeGreaterThan(0);
  });

  it('UI-LLM-20 says that no record matches, and shows the loading state first', async () => {
    mount(
      <DecisionLogScreen route={LOG} />,
      client(() => page([])),
      { permissions: AUDITOR },
    );
    expect((await screen.findByTestId('decisions-none')).textContent).toBe(vi_['llm.decisions.none']);
    cleanup();
    mount(
      <DecisionLogScreen route={LOG} />,
      harness(() => new Promise(() => undefined)),
      { permissions: AUDITOR },
    );
    expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
    expect(screen.getByRole('region', { name: vi_['llm.decisions.page.title'] })).toBeTruthy();
  });
});
