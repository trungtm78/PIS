import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import SettlementScreen from './SettlementScreen';
import { AUDITOR, CHIEF, LEADER, OFFICER, PROJECT, READER, actions, answer, client, commandsOf, documentId, mount, routeOf, sent, settlement, settlementId, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('PAY-15', 'FR-PAY-15');
const text = (key: string, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);
const refusal = (code: string, extensions: Record<string, unknown> = {}, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions });

beforeEach(() => {
  // Noon in Vietnam on 26 October 2026; only the clock is faked, so the promises of the screen run as they do.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-26T05:00:00Z'));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function open(state: World, options: { path?: string; permissions?: readonly string[]; mode?: 'FULL' | 'READ_ONLY'; command?: (operation: string, input: unknown) => unknown } = {}) {
  const h = client(state, options.command);
  mount(<SettlementScreen route={ROUTE} />, h, { permissions: options.permissions ?? OFFICER, path: options.path ?? '/pay/pay-15', ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

const picked = (n: number): string => `/pay/pay-15?settlement=${settlementId(n)}`;
const dialog = (): HTMLElement => screen.getByRole('dialog');
const field = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;
const type = (id: string, value: string): void => {
  fireEvent.change(field(id), { target: { value } });
};
const press = (name: string): void => {
  fireEvent.click(within(dialog()).getByRole('button', { name }));
};
const action = (name: string): HTMLButtonElement | null => document.querySelector(`button[data-action="${name}"]`);
const rowOf = (n: number): HTMLElement => document.querySelector(`tr[data-settlement="${settlementId(n)}"]`) as HTMLElement;

describe('SettlementScreen (PAY-15): the settlement of a project, a year or a contract', () => {
  it('says so when the caller may not read settlements, and shows no command', async () => {
    open(world(), { permissions: [] });
    expect((await screen.findByTestId('no-read')).textContent).toBe(vi_['pay.settlement.read.denied']);
    expect(screen.queryByTestId('settlements')).toBeNull();
    expect(action('open')).toBeNull();
    expect(screen.getByText(text('pay.settlement.footer', { id: 'PAY-15', req: 'FR-PAY-15' }))).toBeTruthy();
  });

  it('says so when there is no settlement yet', async () => {
    open(world({ settlements: [] }));
    expect((await screen.findByTestId('none')).textContent).toBe(vi_['pay.settlement.list.empty']);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['pay.settlement.title']);
  });

  it('UI-PAY-15: lists the settlements with their figures and the days left to verify, and says plainly when a deadline has passed', async () => {
    const late = sent(2, { verification_due_on: '2026-10-20', project_group: 'C', deadline_days: 120 });
    const near = sent(3, { verification_due_on: '2026-11-15' });
    const closed = settlement(4, { status: 'CLOSED', settlement_scope: 'ANNUAL', fiscal_year: 2025, revision: 2, outstanding_vnd: '0', actions: actions() });
    open(world({ settlements: [settlement(1), late, near, closed, sent(5)] }));
    await screen.findByTestId('settlements');
    const draft = rowOf(1);
    expect(within(draft).getByTestId('project').textContent).toBe('DA-001');
    expect(within(draft).getByTestId('scope').textContent).toBe(vi_['pay.settlement.scope.project']);
    expect(within(draft).getByTestId('status').textContent).toBe(vi_['pay.settlement.status.draft']);
    expect(within(draft).getByTestId('settled').textContent).toBe('9.850.000.000');
    expect(within(draft).getByTestId('outstanding').textContent).toBe('150.000.000');
    expect(within(draft).getByTestId('unrecovered').textContent).toBe('0');
    expect(within(draft).getByTestId('due').getAttribute('data-urgency')).toBe('none');
    expect(within(rowOf(2)).getByTestId('due').getAttribute('data-urgency')).toBe('late');
    expect(within(rowOf(2)).getByTestId('days-left').textContent).toBe(text('pay.settlement.deadline.late', { days: 6 }));
    expect(within(rowOf(2)).getByTestId('group').textContent).toBe(vi_['pay.settlement.group.c']);
    expect(within(rowOf(3)).getByTestId('due').getAttribute('data-urgency')).toBe('near');
    expect(within(rowOf(3)).getByTestId('days-left').textContent).toBe(text('pay.settlement.deadline.near', { days: 20 }));
    expect(within(rowOf(5)).getByTestId('due').getAttribute('data-urgency')).toBe('later');
    expect(within(rowOf(5)).getByTestId('days-left').textContent).toBe(text('pay.settlement.deadline.later', { days: 155 }));
    expect(within(rowOf(4)).getByTestId('scope').textContent).toContain('2025');
    expect(within(rowOf(4)).getByTestId('scope').textContent).toContain(text('pay.settlement.revision', { revision: 2 }));
    expect(within(rowOf(4)).queryByTestId('days-left')).toBeNull();
    expect((within(draft).getByTestId('open') as HTMLAnchorElement).getAttribute('href')).toBe(picked(1));
    expect(screen.getByTestId('pick').textContent).toBe(vi_['pay.settlement.pick']);
  });

  it('reads the list again for the status picked', async () => {
    const h = open(world({ settlements: [settlement(1), sent(2)] }));
    await screen.findByTestId('settlements');
    fireEvent.change(field('settlement-status'), { target: { value: 'SUBMITTED' } });
    await waitFor(() => expect(within(screen.getByTestId('settlements')).queryByText('9.850.000.000')).not.toBeNull());
    await waitFor(() => expect(document.querySelectorAll('tr[data-settlement]').length).toBe(1));
    expect(h.read.mock.calls.some((call) => call[0] === 'get_resources_settlement_revision' && (call[1] as { query: { status?: string } }).query.status === 'SUBMITTED')).toBe(true);
  });

  it('fails in words when the list cannot be read, and when the settlement picked is not there', async () => {
    const state = world();
    state.failing.add('get_resources_settlement_revision');
    open(state);
    expect(await screen.findByRole('alert')).toBeTruthy();
    cleanup();
    open(world(), { path: picked(9) });
    expect((await screen.findByTestId('detail-missing')).textContent).toBe(vi_['pay.settlement.detail.missing']);
    cleanup();
    const failing = world();
    failing.failing.add('get_resources_settlement_revision_id');
    open(failing, { path: picked(1) });
    expect((await screen.findByTestId('detail-failed')).textContent).toBe(vi_['pay.settlement.detail.failed']);
  });

  it('shows the settlement picked in full, with the deadline, the days the rule gave and that the rule still waits for its confirmation', async () => {
    open(world({ settlements: [sent(1, { actions: actions() })] }), { path: picked(1), permissions: READER });
    await screen.findByTestId('detail');
    expect(screen.getByTestId('fact-project').textContent).toBe('DA-001');
    expect(screen.getByTestId('fact-scope').textContent).toBe(vi_['pay.settlement.scope.project']);
    expect(screen.getByTestId('fact-status').textContent).toBe(vi_['pay.settlement.status.submitted']);
    expect(screen.getByTestId('fact-settled').textContent).toBe('9.850.000.000');
    expect(screen.getByTestId('fact-outstanding').textContent).toBe('150.000.000');
    expect(screen.getByTestId('fact-unrecovered').textContent).toBe('0');
    expect(screen.getByTestId('fact-group').textContent).toBe(vi_['pay.settlement.group.b']);
    expect(screen.getByTestId('fact-submitted').textContent).toBe('2026-10-01');
    expect(screen.getByTestId('fact-deadline').textContent).toBe('2027-03-30');
    expect(screen.getByTestId('fact-days').textContent).toContain(text('pay.settlement.fact.days', { days: 180 }));
    expect(screen.getByTestId('fact-urgency').textContent).toBe(text('pay.settlement.deadline.later', { days: 155 }));
    expect(screen.getByTestId('fact-rule').textContent).toBe(vi_['pay.settlement.fact.rule.awaiting']);
    expect(document.querySelectorAll('button[data-action]').length).toBe(0);
    expect(screen.queryByTestId('owes')).toBeNull();
  });

  it('offers exactly the commands the server says the caller may do, and none in read-only mode', async () => {
    open(world({ settlements: [settlement(1, { actions: actions({ refresh: true, submit: true }) })] }), { path: picked(1) });
    await screen.findByTestId('detail');
    expect(action('refresh')).not.toBeNull();
    expect(action('submit')).not.toBeNull();
    for (const name of ['take-up', 'verify', 'return', 'exception', 'close']) expect(action(name)).toBeNull();
    cleanup();
    open(world({ settlements: [settlement(1, { actions: actions({ refresh: true, submit: true }) })] }), { path: picked(1), mode: 'READ_ONLY' });
    await screen.findByTestId('detail');
    expect(document.querySelectorAll('button[data-action]').length).toBe(0);
    cleanup();
    open(world({ settlements: [settlement(1, { status: 'VERIFYING', actions: actions({ verify: true, return: true }) })] }), { path: picked(1) });
    await screen.findByTestId('detail');
    expect(action('verify')).not.toBeNull();
    expect(action('return')).not.toBeNull();
    expect(action('submit')).toBeNull();
  });

  describe('opening a settlement', () => {
    it('is offered only to who may open, asks for what the scope needs and sends it', async () => {
      const h = open(world(), { command: () => answer({ status: 'DRAFT', resource_version: 1, resource_id: settlementId(7) }) });
      await screen.findByTestId('settlements');
      fireEvent.click(action('open') as HTMLButtonElement);
      press(vi_['pay.settlement.open.submit']);
      expect(within(dialog()).getAllByRole('alert').length).toBe(1);
      expect(commandsOf(h, 'openSettlement')).toHaveLength(0);
      await waitFor(() => expect(field('open-project').tagName).toBe('SELECT'));
      fireEvent.change(field('open-project'), { target: { value: PROJECT } });
      fireEvent.change(field('open-scope'), { target: { value: 'ANNUAL' } });
      press(vi_['pay.settlement.open.submit']);
      expect(within(dialog()).getByText(vi_['pay.settlement.problem.required'])).toBeTruthy();
      type('open-year', '1999');
      press(vi_['pay.settlement.open.submit']);
      expect(within(dialog()).getByText(vi_['pay.settlement.problem.year'])).toBeTruthy();
      fireEvent.change(field('open-scope'), { target: { value: 'CONTRACT' } });
      press(vi_['pay.settlement.open.submit']);
      expect(within(dialog()).getByText(vi_['pay.settlement.problem.required'])).toBeTruthy();
      type('open-contract', 'x');
      press(vi_['pay.settlement.open.submit']);
      expect(within(dialog()).getByText(vi_['pay.settlement.problem.uuid'])).toBeTruthy();
      type('open-contract', documentId(1));
      press(vi_['pay.settlement.open.submit']);
      await waitFor(() => expect(commandsOf(h, 'openSettlement')).toHaveLength(1));
      expect(commandsOf(h, 'openSettlement')[0]?.body).toEqual({ project_id: PROJECT, settlement_scope: 'CONTRACT', contract_id: documentId(1) });
      expect((await screen.findByTestId('done')).textContent).toBe(vi_['pay.settlement.done.opened']);
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('sends the year of an annual settlement, takes a typed identifier when the projects cannot be listed, and is not offered to who may not open', async () => {
      const state = world();
      state.projects = [];
      const h = open(state, { command: () => answer({ resource_id: settlementId(7) }) });
      await screen.findByTestId('settlements');
      fireEvent.click(action('open') as HTMLButtonElement);
      await waitFor(() => expect(field('open-project').tagName).toBe('INPUT'));
      type('open-project', PROJECT);
      fireEvent.change(field('open-scope'), { target: { value: 'ANNUAL' } });
      type('open-year', '2026');
      press(vi_['pay.settlement.open.submit']);
      await waitFor(() => expect(commandsOf(h, 'openSettlement')).toHaveLength(1));
      expect(commandsOf(h, 'openSettlement')[0]?.body).toEqual({ project_id: PROJECT, settlement_scope: 'ANNUAL', fiscal_year: 2026 });
      cleanup();
      open(world(), { permissions: READER });
      await screen.findByTestId('settlements');
      expect(action('open')).toBeNull();
    });

    it('says in words why a settlement cannot be opened', async () => {
      let refused = 'SETTLEMENT_OPEN_EXISTS';
      open(world(), { command: () => refusal(refused, {}, refused === 'SETTLEMENT_OPEN_EXISTS' ? 409 : 422) });
      await screen.findByTestId('settlements');
      fireEvent.click(action('open') as HTMLButtonElement);
      fireEvent.change(field('open-project'), { target: { value: PROJECT } });
      press(vi_['pay.settlement.open.submit']);
      expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_['pay.settlement.error.openExists']);
      refused = 'PROJECT_STAGE_INVALID';
      press(vi_['pay.settlement.open.submit']);
      await waitFor(() => expect(within(dialog()).getByTestId('refusal').textContent).toBe(vi_['pay.settlement.error.stageInvalid']));
    });
  });

  describe('reading the figures again', () => {
    it('sends the note and the version, says that a returned settlement becomes a draft, and says it was done', async () => {
      const h = open(world({ settlements: [sent(1, { status: 'RETURNED', actions: actions({ refresh: true, submit: true }) })] }), {
        path: picked(1),
        command: () => answer({ status: 'DRAFT', resource_version: 3 }),
      });
      await screen.findByTestId('detail');
      fireEvent.click(action('refresh') as HTMLButtonElement);
      expect(within(dialog()).getByText(vi_['pay.settlement.refresh.returned'])).toBeTruthy();
      type('refresh-note', 'After the acceptance of July.');
      press(vi_['pay.settlement.refresh.submit']);
      await waitFor(() => expect(commandsOf(h, 'refreshSettlementFigures')).toHaveLength(1));
      expect(commandsOf(h, 'refreshSettlementFigures')[0]).toMatchObject({ path: { id: settlementId(1) }, body: { note: 'After the acceptance of July.' }, ifMatchVersion: 2 });
      expect((await screen.findByTestId('done')).textContent).toBe(vi_['pay.settlement.done.refreshed']);
    });

    it('sends no note when none is typed, refuses one that is too long, and shows a refusal of the server', async () => {
      const h = open(world(), { path: picked(1), command: () => refusal('SETTLEMENT_STATE_INVALID', {}, 409) });
      await screen.findByTestId('detail');
      fireEvent.click(action('refresh') as HTMLButtonElement);
      expect(within(dialog()).getByText(vi_['pay.settlement.refresh.intro'])).toBeTruthy();
      type('refresh-note', 'x'.repeat(2001));
      press(vi_['pay.settlement.refresh.submit']);
      expect(within(dialog()).getByText(vi_['pay.settlement.problem.tooLong'])).toBeTruthy();
      expect(commandsOf(h, 'refreshSettlementFigures')).toHaveLength(0);
      type('refresh-note', '');
      press(vi_['pay.settlement.refresh.submit']);
      await waitFor(() => expect(commandsOf(h, 'refreshSettlementFigures')).toHaveLength(1));
      expect(commandsOf(h, 'refreshSettlementFigures')[0]?.body).toEqual({});
      expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_['pay.settlement.error.stateInvalid']);
    });
  });

  describe('sending the settlement (AC-ST-PAY-009-1)', () => {
    it('proposes today, refuses a day to come or a day that is not a day, and sends the day with the version', async () => {
      const h = open(world(), { path: picked(1), command: () => answer() });
      await screen.findByTestId('detail');
      fireEvent.click(action('submit') as HTMLButtonElement);
      expect(field('submit-day').value).toBe('2026-10-26');
      type('submit-day', '2026-10-27');
      press(vi_['pay.settlement.submit.submit']);
      expect(within(dialog()).getByText(vi_['pay.settlement.problem.future'])).toBeTruthy();
      type('submit-day', '');
      press(vi_['pay.settlement.submit.submit']);
      expect(within(dialog()).getByText(vi_['pay.settlement.problem.required'])).toBeTruthy();
      type('submit-day', '2026-10-01');
      press(vi_['pay.settlement.submit.submit']);
      await waitFor(() => expect(commandsOf(h, 'submitSettlement')).toHaveLength(1));
      expect(commandsOf(h, 'submitSettlement')[0]).toMatchObject({ path: { id: settlementId(1) }, body: { submitted_on: '2026-10-01' }, ifMatchVersion: 1 });
      expect((await screen.findByTestId('done')).textContent).toBe(vi_['pay.settlement.done.submitted']);
    });

    it('says in words that the project has no group, that the rule is not in force, and that the settlement is not in a state to be sent', async () => {
      let code = 'PROJECT_GROUP_MISSING';
      open(world(), { path: picked(1), command: () => refusal(code) });
      await screen.findByTestId('detail');
      fireEvent.click(action('submit') as HTMLButtonElement);
      press(vi_['pay.settlement.submit.submit']);
      expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_['pay.settlement.error.groupMissing']);
      for (const [refused, key] of [
        ['DEADLINE_RULE_UNCONFIRMED', 'ruleUnconfirmed'],
        ['SETTLEMENT_STATE_INVALID', 'stateInvalid'],
        ['VERSION_CONFLICT', 'versionConflict'],
      ] as const) {
        code = refused;
        press(vi_['pay.settlement.submit.submit']);
        await waitFor(() => expect(within(dialog()).getByTestId('refusal').textContent).toBe(vi_[`pay.settlement.error.${key}` as keyof typeof vi_]));
      }
    });
  });

  describe('verification (BR-PAY-16)', () => {
    it('takes the file up with the findings of the person', async () => {
      const h = open(world({ settlements: [sent(1)] }), { path: picked(1), command: () => answer({ status: 'VERIFYING' }), permissions: OFFICER });
      await screen.findByTestId('detail');
      expect(action('take-up')).not.toBeNull();
      expect(action('verify')).toBeNull();
      fireEvent.click(action('take-up') as HTMLButtonElement);
      press(vi_['pay.settlement.outcome.verifying']);
      expect(within(dialog()).getByText(vi_['pay.settlement.problem.required'])).toBeTruthy();
      type('verify-findings', 'Taken up.');
      press(vi_['pay.settlement.outcome.verifying']);
      await waitFor(() => expect(commandsOf(h, 'recordSettlementVerification')).toHaveLength(1));
      expect(commandsOf(h, 'recordSettlementVerification')[0]).toMatchObject({ path: { id: settlementId(1) }, body: { outcome: 'VERIFYING', findings: 'Taken up.' }, ifMatchVersion: 2 });
      expect(commandsOf(h, 'recordSettlementVerification')[0]?.body).not.toHaveProperty('audit_finding_refs');
      expect((await screen.findByTestId('done')).textContent).toBe(vi_['pay.settlement.done.verifying']);
    });

    it('cites the conclusions of AUD only for who may read AUD, and refuses an identifier that is not one', async () => {
      const verifying = sent(1, { status: 'VERIFYING', actions: actions({ verify: true, return: true }), audit_finding_refs: [documentId(1)] });
      const h = open(world({ settlements: [verifying] }), { path: picked(1), command: () => answer({ status: 'VERIFIED' }), permissions: AUDITOR });
      await screen.findByTestId('detail');
      expect(screen.getByTestId('fact-refs').textContent).toBe(documentId(1));
      fireEvent.click(action('verify') as HTMLButtonElement);
      type('verify-findings', 'No finding.');
      type('verify-refs', 'nope');
      press(vi_['pay.settlement.outcome.verified']);
      expect(within(dialog()).getByText(vi_['pay.settlement.problem.uuids'])).toBeTruthy();
      type('verify-refs', `${documentId(1)}, ${documentId(2)}`);
      press(vi_['pay.settlement.outcome.verified']);
      await waitFor(() => expect(commandsOf(h, 'recordSettlementVerification')).toHaveLength(1));
      expect(commandsOf(h, 'recordSettlementVerification')[0]?.body).toEqual({ outcome: 'VERIFIED', findings: 'No finding.', audit_finding_refs: [documentId(1), documentId(2)] });
      expect((await screen.findByTestId('done')).textContent).toBe(vi_['pay.settlement.done.verified']);
      cleanup();
      // The server shows the references only to who may read AUD; the dialog does not ask for them from anyone else.
      open(world({ settlements: [{ ...verifying, audit_finding_refs: null }] }), { path: picked(1), permissions: OFFICER });
      await screen.findByTestId('detail');
      expect(screen.queryByTestId('fact-refs')).toBeNull();
      fireEvent.click(action('verify') as HTMLButtonElement);
      expect(document.getElementById('verify-refs')).toBeNull();
    });

    it('gives the file back, and says in words that the person who sent it may not verify it', async () => {
      const h = open(world({ settlements: [sent(1)] }), { path: picked(1), command: () => refusal('SELF_APPROVAL_DENIED', {}, 403) });
      await screen.findByTestId('detail');
      fireEvent.click(action('return') as HTMLButtonElement);
      type('verify-findings', 'The report is missing.');
      press(vi_['pay.settlement.outcome.returned']);
      expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_['pay.settlement.error.selfApproval']);
      expect(commandsOf(h, 'recordSettlementVerification')[0]?.body).toMatchObject({ outcome: 'RETURNED' });
    });

    it('says that the settlement was given back', async () => {
      open(world({ settlements: [sent(1)] }), { path: picked(1), command: () => answer({ status: 'RETURNED' }) });
      await screen.findByTestId('detail');
      fireEvent.click(action('return') as HTMLButtonElement);
      type('verify-findings', 'The report is missing.');
      press(vi_['pay.settlement.outcome.returned']);
      expect((await screen.findByTestId('done')).textContent).toBe(vi_['pay.settlement.done.returned']);
    });
  });

  describe('the exception and the close of a settlement that owes (AC-ST-PAY-009-2, UAT-AC66)', () => {
    const verified = (overrides: Record<string, unknown> = {}) =>
      sent(1, { status: 'VERIFIED', verified_on: '2026-10-20', verification_findings: 'No finding.', actions: actions({ approve_exception: true }), version: 5, ...overrides });

    it('tells that something is owed, asks for the reason and the document of the exception, and sends them', async () => {
      const h = open(world({ settlements: [verified()] }), { path: picked(1), permissions: CHIEF, command: () => answer({ status: 'VERIFIED' }) });
      await screen.findByTestId('detail');
      expect(screen.getByTestId('owes').textContent).toBe(vi_['pay.settlement.owes.callout']);
      expect(action('close')).toBeNull();
      fireEvent.click(action('exception') as HTMLButtonElement);
      press(vi_['pay.settlement.exception.submit']);
      expect(within(dialog()).getAllByText(vi_['pay.settlement.problem.required'])).toHaveLength(2);
      type('exception-reason', 'Công nợ chờ bảo lãnh bảo hành theo biên bản 05/BB');
      type('exception-document', 'x');
      press(vi_['pay.settlement.exception.submit']);
      expect(within(dialog()).getByText(vi_['pay.settlement.problem.uuid'])).toBeTruthy();
      type('exception-document', documentId(3));
      press(vi_['pay.settlement.exception.submit']);
      await waitFor(() => expect(commandsOf(h, 'approveSettlementException')).toHaveLength(1));
      expect(commandsOf(h, 'approveSettlementException')[0]).toMatchObject({
        path: { id: settlementId(1) },
        body: { reason: 'Công nợ chờ bảo lãnh bảo hành theo biên bản 05/BB', approval_document_version_id: documentId(3) },
        ifMatchVersion: 5,
      });
      expect((await screen.findByTestId('done')).textContent).toBe(vi_['pay.settlement.done.exception']);
    });

    it('says in words that nothing is owed, that the person prepared the settlement, and that the document is not clean', async () => {
      let code = 'NO_OUTSTANDING_TO_EXCEPT';
      open(world({ settlements: [verified()] }), { path: picked(1), permissions: CHIEF, command: () => refusal(code, {}, code === 'SELF_APPROVAL_DENIED' ? 403 : 422) });
      await screen.findByTestId('detail');
      fireEvent.click(action('exception') as HTMLButtonElement);
      type('exception-reason', 'Because.');
      type('exception-document', documentId(3));
      press(vi_['pay.settlement.exception.submit']);
      expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_['pay.settlement.error.noOutstanding']);
      for (const [refused, key] of [
        ['SELF_APPROVAL_DENIED', 'selfApproval'],
        ['DOCUMENT_NOT_CLEAN', 'notClean'],
        ['APPROVAL_REQUIRED', 'approvalRequired'],
      ] as const) {
        code = refused;
        press(vi_['pay.settlement.exception.submit']);
        await waitFor(() => expect(within(dialog()).getByTestId('refusal').textContent).toBe(vi_[`pay.settlement.error.${key}` as keyof typeof vi_]));
      }
    });

    it('closes on the decision, with the evidence listed, and keeps the figures on screen as they were', async () => {
      const excepted = verified({
        actions: actions({ close: true }),
        exception_reason: 'Waits for the guarantee.',
        exception_approved_by: documentId(9),
        exception_approved_at: '2026-10-22T03:00:00.000000Z',
      });
      const h = open(world({ settlements: [excepted] }), { path: picked(1), permissions: LEADER, command: () => answer({ status: 'CLOSED' }) });
      await screen.findByTestId('detail');
      expect(screen.queryByTestId('owes')).toBeNull();
      expect(screen.getByTestId('fact-exception').textContent).toBe('Waits for the guarantee.');
      expect(screen.getByTestId('fact-outstanding').textContent).toBe('150.000.000');
      fireEvent.click(action('close') as HTMLButtonElement);
      press(vi_['pay.settlement.close.submit']);
      expect(within(dialog()).getAllByText(vi_['pay.settlement.problem.required'])).toHaveLength(2);
      type('close-reason', 'Approved by decision 10/QTDA.');
      type('close-decision', documentId(4));
      type('close-evidence', `${documentId(5)} ${documentId(6)}`);
      press(vi_['pay.settlement.close.submit']);
      await waitFor(() => expect(commandsOf(h, 'post_settlements_id_close')).toHaveLength(1));
      expect(commandsOf(h, 'post_settlements_id_close')[0]).toMatchObject({
        path: { id: settlementId(1) },
        body: { decision: 'approve', reason: 'Approved by decision 10/QTDA.', evidence_ids: [documentId(5), documentId(6)], decision_document_version_id: documentId(4) },
        ifMatchVersion: 5,
      });
      expect((await screen.findByTestId('done')).textContent).toBe(vi_['pay.settlement.done.closed']);
    });

    it('refuses an evidence that is not an identifier, and says in words that something is still owed or that the decision cannot be used', async () => {
      let code = 'SETTLEMENT_HAS_OUTSTANDING';
      open(world({ settlements: [verified({ actions: actions({ close: true }) })] }), { path: picked(1), permissions: LEADER, command: () => refusal(code) });
      await screen.findByTestId('detail');
      fireEvent.click(action('close') as HTMLButtonElement);
      type('close-reason', 'Approved.');
      type('close-decision', documentId(4));
      type('close-evidence', 'nope');
      press(vi_['pay.settlement.close.submit']);
      expect(within(dialog()).getByText(vi_['pay.settlement.problem.uuids'])).toBeTruthy();
      type('close-evidence', Array.from({ length: 51 }, (_, n) => documentId(n + 1)).join(' '));
      press(vi_['pay.settlement.close.submit']);
      expect(within(dialog()).getByText(vi_['pay.settlement.problem.tooMany'])).toBeTruthy();
      type('close-evidence', '');
      press(vi_['pay.settlement.close.submit']);
      expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_['pay.settlement.error.hasOutstanding']);
      for (const [refused, key] of [
        ['DECISION_DOCUMENT_REQUIRED', 'decisionRequired'],
        ['RESOURCE_NOT_FOUND', 'notFound'],
        ['SCOPE_DENIED', 'denied'],
        ['SESSION_EXPIRED', 'session'],
        ['SOMETHING_ELSE', 'general'],
        ['VALIDATION_FAILED', 'validation'],
      ] as const) {
        code = refused;
        press(vi_['pay.settlement.close.submit']);
        await waitFor(() => expect(within(dialog()).getByTestId('refusal').textContent).toBe(vi_[`pay.settlement.error.${key}` as keyof typeof vi_]));
      }
    });
  });

  it('shows the closed settlement with who closed it and when, and the exception it closed on', async () => {
    const closed = sent(1, {
      status: 'CLOSED',
      verified_on: '2026-10-20',
      verification_findings: 'No finding.',
      exception_reason: 'Waits for the guarantee.',
      exception_approved_at: '2026-10-22T03:00:00.000000Z',
      closed_at: '2026-10-25T03:00:00.000000Z',
      close_reason: 'Approved by decision 10/QTDA.',
      actions: actions(),
    });
    open(world({ settlements: [closed] }), { path: picked(1), permissions: READER });
    await screen.findByTestId('detail');
    expect(screen.getByTestId('fact-verified').textContent).toBe('2026-10-20');
    expect(screen.getByTestId('fact-findings').textContent).toBe('No finding.');
    expect(screen.getByTestId('fact-closed').textContent).not.toBe('');
    expect(screen.getByTestId('fact-exception').textContent).toBe('Waits for the guarantee.');
    expect(screen.queryByTestId('fact-urgency')).toBeNull();
    expect(document.querySelectorAll('button[data-action]').length).toBe(0);
  });
});
