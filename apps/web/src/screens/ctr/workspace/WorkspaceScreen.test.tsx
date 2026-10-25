import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import WorkspaceScreen from './WorkspaceScreen';
import { UUID_A, UUID_B, change, client, contractId, mount, noActions, readiness, routeOf, summary } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('CTR-03', 'FR-CTR-03');
const PATH = `/ctr/ctr-03?id=${contractId(1)}`;
const PERMISSIONS = ['contract.read'];
const OK = { operation_id: 'o', status: 'IN_REVIEW', resource_version: 4, resource_id: contractId(1) };
const problem = (code: string, status = 409, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(state: World, options: { command?: (operation: string, input: unknown) => unknown; mode?: 'FULL' | 'READ_ONLY'; path?: string } = {}) {
  const h = client(state, options.command ?? (() => OK));
  mount(<WorkspaceScreen route={ROUTE} />, h, { permissions: PERMISSIONS, path: options.path ?? PATH, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

const commandButtons = (): string[] => Array.from(document.querySelectorAll('[data-testid="commands"] [data-command]')).map((button) => button.getAttribute('data-command') as string);
const dialog = (): HTMLElement => screen.getByRole('dialog');
const press = (command: string): void => {
  fireEvent.click(document.querySelector(`[data-command="${command}"]`) as HTMLElement);
};
const submitDialog = (name: string): void => {
  fireEvent.click(within(dialog()).getByRole('button', { name }));
};

describe('WorkspaceScreen (CTR-03): the review, the signing and the activation of a contract', () => {
  it('asks for a contract when the address names none', async () => {
    open({ summary: summary('DRAFT') }, { path: '/ctr/ctr-03' });
    expect((await screen.findByTestId('no-contract')).textContent).toContain(vi_['ctr.workspace.none.notice']);
    expect(screen.getByRole('link', { name: vi_['ctr.workspace.none.link'] }).getAttribute('href')).toBe('/ctr/ctr-01');
  });

  it('UI-CTR-03: shows the contract, the conditions before its activation and the commands that apply to a draft, and no others', async () => {
    open({ summary: summary('DRAFT', { actions: { ...noActions, submit: true, cancel: true } }) });
    await screen.findByTestId('facts');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['ctr.workspace.page.title']);
    expect(screen.getByTestId('contract-code').textContent).toBe('HD-A-001');
    expect(screen.getByTestId('status').textContent).toBe(vi_['ctr.status.draft.label']);
    expect(commandButtons()).toEqual(['submit', 'cancel']);
    expect(screen.getByTestId('value').textContent).toBe(text('ctr.value.amount', { amount: '10.200.000.000' }));
    const checks = Array.from(document.querySelectorAll('[data-check]')).map((item) => [item.getAttribute('data-check'), item.getAttribute('data-ok')]);
    expect(checks).toEqual([
      ['boq', 'true'],
      ['guarantee', 'true'],
      ['permitGate', 'true'],
      ['capital', 'true'],
      ['project', 'true'],
    ]);
    expect(screen.getByTestId('no-history').textContent).toBe(vi_['ctr.workspace.history.empty']);
    expect(screen.getByText(text('ctr.workspace.footer.reference', { id: 'CTR-03', req: 'FR-CTR-03' }))).toBeTruthy();
  });

  it('says what is not met before the activation: a bill of quantities that does not add up, no guarantee, a gate that is blocked, no line of capital, a project that is not in implementation', async () => {
    const unmet = readiness({
      boq: { total_vnd: '10000000000', balanced: false },
      guarantee: { required: true, held: false },
      permit_gate: { required: true, status: 'BLOCKED', blocking: ['GPXD'] },
      capital: { allocation_line_id: null },
      project: { status: 'PIPELINE', in_implementation: false },
    });
    open({ summary: summary('SIGNED', { readiness: unmet, actions: { ...noActions, activate: true } }) });
    await screen.findByTestId('checks');
    expect(Array.from(document.querySelectorAll('[data-check]')).map((item) => item.getAttribute('data-ok'))).toEqual(['false', 'false', 'false', 'false', 'false']);
    const gate = document.querySelector('[data-check="permitGate"]') as HTMLElement;
    expect(gate.textContent).toContain(vi_['ctr.workspace.gate.blocked']);
    expect(gate.textContent).toContain(text('ctr.workspace.check.blocking', { types: 'GPXD' }));
    expect(within(document.querySelector('[data-check="guarantee"]') as HTMLElement).getByText(vi_['ctr.workspace.check.unmet'])).toBeTruthy();
  });

  it('does not ask a guarantee or a permit of a contract that needs none, and shows no conditions once the contract is active', async () => {
    const none = readiness({ guarantee: { required: false, held: false }, permit_gate: { required: false, status: 'NOT_REQUIRED', blocking: [] } });
    open({ summary: summary('SIGNED', { readiness: none }) });
    await screen.findByTestId('checks');
    expect(document.querySelector('[data-check="guarantee"]')?.getAttribute('data-ok')).toBe('n/a');
    expect(document.querySelector('[data-check="permitGate"]')?.getAttribute('data-ok')).toBe('n/a');
    expect(within(document.querySelector('[data-check="guarantee"]') as HTMLElement).getByText(vi_['ctr.workspace.check.notRequired'])).toBeTruthy();
    cleanup();
    open({ summary: summary('ACTIVE', { effective_from: '2026-11-01' }) });
    await screen.findByTestId('facts');
    expect(screen.queryByTestId('checks')).toBeNull();
    expect(screen.getByTestId('effective-from').textContent).toBe('2026-11-01');
  });

  it('shows the history of the status in the words of the screen, and the signature with its date and the decision on the conflict', async () => {
    open({
      summary: summary('SIGNED', {
        signed_on: '2026-10-20',
        conflict_decision_ref: 'QD-XL-001',
        status_changes: [change(1, 'DRAFT', 'IN_REVIEW', 'Sent to review'), change(2, 'IN_REVIEW', 'SIGNED', 'Signed on 2026-10-20')],
      }),
    });
    await screen.findByTestId('history');
    expect(Array.from(document.querySelectorAll('[data-testid="history"] li')).map((item) => item.getAttribute('data-from') + '>' + item.getAttribute('data-to'))).toEqual(['DRAFT>IN_REVIEW', 'IN_REVIEW>SIGNED']);
    expect(screen.getByText(text('ctr.workspace.history.move', { from: vi_['ctr.status.draft.label'], to: vi_['ctr.status.inReview.label'] }))).toBeTruthy();
    expect(screen.getByTestId('signed-on').textContent).toBe('2026-10-20');
    expect(screen.getByTestId('decision-ref').textContent).toBe('QD-XL-001');
  });

  describe('sending to review and giving back', () => {
    it('sends the contract to review under the version it showed, with the note when there is one', async () => {
      const h = open({ summary: summary('DRAFT', { actions: { ...noActions, submit: true } }) });
      await screen.findByTestId('facts');
      press('submit');
      expect(within(dialog()).getByText(text('ctr.workspace.submit.title', { code: 'HD-A-001' }))).toBeTruthy();
      fireEvent.change(within(dialog()).getByLabelText(vi_['ctr.workspace.submit.field']), { target: { value: '  Ready for the committee.  ' } });
      submitDialog(vi_['ctr.workspace.submit.submit']);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith('submitContractForReview', expect.objectContaining({ path: { id: contractId(1) }, body: { note: 'Ready for the committee.' }, ifMatchVersion: 3 }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('sends the contract with no note at all when none was typed', async () => {
      const h = open({ summary: summary('DRAFT', { actions: { ...noActions, submit: true } }) });
      await screen.findByTestId('facts');
      press('submit');
      submitDialog(vi_['ctr.workspace.submit.submit']);
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('submitContractForReview', expect.objectContaining({ body: {} })));
    });

    it('says why the server refused the review: a bill of quantities that does not add up, and a conflict of interest', async () => {
      for (const [code, key] of [
        ['BOQ_TOTAL_MISMATCH', 'ctr.workspace.error.boqMismatch'],
        ['JV_SHARE_NOT_100', 'ctr.workspace.error.jvShares'],
        ['CAPITAL_PLAN_NOT_APPROVED', 'ctr.workspace.error.capitalPlan'],
        ['CONTRACTOR_RESTRICTED', 'ctr.workspace.error.contractor'],
        ['CONFLICT_OF_INTEREST_BLOCKED', 'ctr.workspace.error.conflictActor'],
      ] as const) {
        open({ summary: summary('DRAFT', { actions: { ...noActions, submit: true } }) }, { command: () => problem(code, code === 'CONFLICT_OF_INTEREST_BLOCKED' ? 409 : 422, code === 'CONFLICT_OF_INTEREST_BLOCKED' ? { conflict_of: 'ACTOR' } : {}) });
        await screen.findByTestId('facts');
        press('submit');
        submitDialog(vi_['ctr.workspace.submit.submit']);
        expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_[key]);
        cleanup();
      }
    });

    it('asks for the reason before it gives a contract in review back, and sends it', async () => {
      const h = open({ summary: summary('IN_REVIEW', { actions: { ...noActions, return: true, cancel: true } }) });
      await screen.findByTestId('facts');
      expect(commandButtons()).toEqual(['return', 'cancel']);
      press('return');
      submitDialog(vi_['ctr.workspace.return.submit']);
      expect(within(dialog()).getByText(vi_['ctr.workspace.problem.required'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      fireEvent.change(within(dialog()).getByLabelText(vi_['ctr.workspace.return.field']), { target: { value: 'The bill of quantities has to be corrected.' } });
      submitDialog(vi_['ctr.workspace.return.submit']);
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('returnContractDraft', expect.objectContaining({ path: { id: contractId(1) }, body: { reason: 'The bill of quantities has to be corrected.' }, ifMatchVersion: 3 })));
    });

    it('cancels a draft with its reason', async () => {
      const h = open({ summary: summary('DRAFT', { actions: { ...noActions, submit: true, cancel: true } }) });
      await screen.findByTestId('facts');
      press('cancel');
      submitDialog(vi_['ctr.workspace.cancel.submit']);
      expect(within(dialog()).getByText(vi_['ctr.workspace.problem.required'])).toBeTruthy();
      fireEvent.change(within(dialog()).getByLabelText(vi_['ctr.workspace.cancel.field']), { target: { value: 'A mistake.' } });
      submitDialog(vi_['ctr.workspace.cancel.submit']);
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('cancelContractDraft', expect.objectContaining({ path: { id: contractId(1) }, body: { reason: 'A mistake.' }, ifMatchVersion: 3 })));
    });
  });

  describe('the signing', () => {
    const inReview = () => summary('IN_REVIEW', { actions: { ...noActions, sign: true, return: true } });

    it('AC-ST-CTR-004-1, UAT-AC56: asks for the day and a clean file, and sends the decision on the conflict when there is one', async () => {
      const h = open({ summary: inReview() });
      await screen.findByTestId('facts');
      press('sign');
      fireEvent.change(within(dialog()).getByLabelText(vi_['ctr.workspace.sign.signedOn']), { target: { value: '' } });
      submitDialog(vi_['ctr.workspace.sign.submit']);
      expect(within(dialog()).getAllByText(vi_['ctr.workspace.problem.required'])).toHaveLength(2);
      fireEvent.change(within(dialog()).getByLabelText(vi_['ctr.workspace.sign.signedOn']), { target: { value: '2999-01-01' } });
      fireEvent.change(within(dialog()).getByLabelText(vi_['ctr.workspace.sign.document']), { target: { value: 'not-an-id' } });
      submitDialog(vi_['ctr.workspace.sign.submit']);
      expect(within(dialog()).getByText(vi_['ctr.workspace.problem.future'])).toBeTruthy();
      expect(within(dialog()).getByText(vi_['ctr.workspace.problem.uuid'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      fireEvent.change(within(dialog()).getByLabelText(vi_['ctr.workspace.sign.signedOn']), { target: { value: '2026-10-20' } });
      fireEvent.change(within(dialog()).getByLabelText(vi_['ctr.workspace.sign.document']), { target: { value: UUID_A.toUpperCase() } });
      fireEvent.change(within(dialog()).getByLabelText(vi_['ctr.workspace.sign.decisionRef']), { target: { value: '  QD-XL-001  ' } });
      submitDialog(vi_['ctr.workspace.sign.submit']);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith(
        'recordContractSigning',
        expect.objectContaining({ path: { id: contractId(1) }, ifMatchVersion: 3, body: { signed_on: '2026-10-20', signed_document_version_id: UUID_A, conflict_decision_ref: 'QD-XL-001' } }),
      );
    });

    it('leaves the decision out when none was typed', async () => {
      const h = open({ summary: inReview() });
      await screen.findByTestId('facts');
      press('sign');
      fireEvent.change(within(dialog()).getByLabelText(vi_['ctr.workspace.sign.signedOn']), { target: { value: '2026-10-20' } });
      fireEvent.change(within(dialog()).getByLabelText(vi_['ctr.workspace.sign.document']), { target: { value: UUID_B } });
      submitDialog(vi_['ctr.workspace.sign.submit']);
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('recordContractSigning', expect.objectContaining({ body: { signed_on: '2026-10-20', signed_document_version_id: UUID_B } })));
    });

    it('AC-ST-CTR-004-3, UAT-AC317: says why the signing was refused: a maker, a delegation limit, a conflict of the reviewer, a file that is not clean', async () => {
      for (const [error, expected] of [
        [problem('SELF_APPROVAL_DENIED', 403), vi_['ctr.workspace.error.selfApproval']],
        [problem('SCOPE_DENIED', 403, { approver_role_id: UUID_A }), vi_['ctr.workspace.error.delegation']],
        [problem('SCOPE_DENIED', 403), vi_['ctr.workspace.error.denied']],
        [problem('DOA_RULE_NOT_FOUND', 422), vi_['ctr.workspace.error.noRule']],
        [problem('CONFLICT_OF_INTEREST_BLOCKED', 409, { conflict_of: 'REVIEWER' }), vi_['ctr.workspace.error.conflictReviewer']],
        [problem('CONFLICT_OF_INTEREST_BLOCKED', 409, { conflict_of: 'ACTOR' }), vi_['ctr.workspace.error.conflictActor']],
        [problem('DOCUMENT_NOT_CLEAN', 422), vi_['ctr.workspace.error.documentNotClean']],
        [problem('CONTRACT_STATE_INVALID', 409), vi_['ctr.workspace.error.stateInvalid']],
        [problem('VERSION_CONFLICT', 409), vi_['ctr.workspace.error.versionConflict']],
        [problem('VALIDATION_FAILED', 422), vi_['ctr.workspace.error.validation']],
      ] as const) {
        open({ summary: inReview() }, { command: () => error });
        await screen.findByTestId('facts');
        press('sign');
        fireEvent.change(within(dialog()).getByLabelText(vi_['ctr.workspace.sign.document']), { target: { value: UUID_A } });
        submitDialog(vi_['ctr.workspace.sign.submit']);
        expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(expected);
        cleanup();
      }
    });
  });

  describe('the activation', () => {
    const signed = () => summary('SIGNED', { signed_on: '2026-10-20', actions: { ...noActions, activate: true } });

    it('AC-ST-CTR-004-2, UAT-AC302: asks for the day of effect and the reasons, and sends the approval with the evidence once', async () => {
      const h = open({ summary: signed() });
      await screen.findByTestId('facts');
      press('activate');
      fireEvent.change(within(dialog()).getByLabelText(vi_['ctr.workspace.activate.effectiveFrom']), { target: { value: '2026-10-19' } });
      submitDialog(vi_['ctr.workspace.activate.submit']);
      expect(within(dialog()).getByText(vi_['ctr.workspace.problem.beforeSigning'])).toBeTruthy();
      expect(within(dialog()).getByText(vi_['ctr.workspace.problem.required'])).toBeTruthy();
      fireEvent.change(within(dialog()).getByLabelText(vi_['ctr.workspace.activate.effectiveFrom']), { target: { value: '2026-11-01' } });
      fireEvent.change(within(dialog()).getByLabelText(vi_['ctr.workspace.activate.reason']), { target: { value: '  All the conditions are met.  ' } });
      fireEvent.change(within(dialog()).getByLabelText(vi_['ctr.workspace.activate.evidence']), { target: { value: `${UUID_A}\n${UUID_A.toUpperCase()}, nonsense` } });
      submitDialog(vi_['ctr.workspace.activate.submit']);
      expect(within(dialog()).getByText(vi_['ctr.workspace.problem.evidence'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      fireEvent.change(within(dialog()).getByLabelText(vi_['ctr.workspace.activate.evidence']), { target: { value: `${UUID_A}\n${UUID_A.toUpperCase()}, ${UUID_B}` } });
      submitDialog(vi_['ctr.workspace.activate.submit']);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith(
        'post_contracts_id_activate',
        expect.objectContaining({ path: { id: contractId(1) }, ifMatchVersion: 3, body: { decision: 'approve', reason: 'All the conditions are met.', evidence_ids: [UUID_A, UUID_B], effective_from: '2026-11-01' } }),
      );
    });

    it('accepts an activation with no evidence', async () => {
      const h = open({ summary: signed() });
      await screen.findByTestId('facts');
      press('activate');
      fireEvent.change(within(dialog()).getByLabelText(vi_['ctr.workspace.activate.reason']), { target: { value: 'Yes.' } });
      submitDialog(vi_['ctr.workspace.activate.submit']);
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('post_contracts_id_activate', expect.objectContaining({ body: expect.objectContaining({ evidence_ids: [], reason: 'Yes.' }) })));
    });

    it('says which condition failed, naming the permit types that block the gate and the cause the capital gave', async () => {
      for (const [error, expected] of [
        [problem('PERFORMANCE_GUARANTEE_MISSING', 422), vi_['ctr.workspace.error.guaranteeMissing']],
        [problem('PERMIT_GATE_BLOCKED', 409, { gate_code: 'CONTRACT_ACTIVATION', blocking: [{ permit_type_code: 'GPXD' }, { permit_type_code: 'PCCC' }] }), `${vi_['ctr.workspace.error.gateBlocked']} ${text('ctr.workspace.error.detail', { detail: 'GPXD, PCCC' })}`],
        [problem('FUND_COMMIT_FAILED', 422, { cause: 'AVC_BLOCKED' }), `${vi_['ctr.workspace.error.fundFailed']} ${text('ctr.workspace.error.detail', { detail: 'AVC_BLOCKED' })}`],
        [problem('PROJECT_STAGE_INVALID', 422), vi_['ctr.workspace.error.projectStage']],
        [problem('SELF_APPROVAL_DENIED', 403), vi_['ctr.workspace.error.selfApproval']],
      ] as const) {
        open({ summary: signed() }, { command: () => error });
        await screen.findByTestId('facts');
        press('activate');
        fireEvent.change(within(dialog()).getByLabelText(vi_['ctr.workspace.activate.reason']), { target: { value: 'Yes.' } });
        submitDialog(vi_['ctr.workspace.activate.submit']);
        expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(expected);
        expect(screen.getByRole('dialog')).toBeTruthy();
        cleanup();
      }
    });
  });

  describe('who is offered what', () => {
    it('offers nothing in a read-only session, and says so', async () => {
      open({ summary: summary('DRAFT', { actions: { ...noActions, submit: true, cancel: true } }) }, { mode: 'READ_ONLY' });
      await screen.findByTestId('facts');
      expect(commandButtons()).toEqual([]);
      expect(screen.getByTestId('no-command').textContent).toBe(vi_['ctr.workspace.readOnly.notice']);
    });

    it('says that no command applies to someone who may press none, and shows a guest the contract alone', async () => {
      open({ summary: summary('IN_REVIEW') });
      await screen.findByTestId('facts');
      expect(commandButtons()).toEqual([]);
      expect(screen.getByTestId('no-command').textContent).toBe(vi_['ctr.workspace.noCommand.notice']);
      cleanup();
      const guest: Record<string, unknown> = { ...summary('SIGNED') };
      delete guest.readiness;
      delete guest.actions;
      open({ summary: guest });
      await screen.findByTestId('facts');
      expect(screen.queryByTestId('no-command')).toBeNull();
      expect(screen.queryByTestId('checks')).toBeNull();
      expect(commandButtons()).toEqual([]);
    });
  });

  describe('the seven states (UI-CTR-03)', () => {
    const failing = (error: ApiError) => {
      mount(<WorkspaceScreen route={ROUTE} />, client({ summary: error }), { permissions: PERMISSIONS, path: PATH });
    };

    it('shows a loading state first, then the denied, signed-out, offline and error states, and the empty state for a contract that does not exist', async () => {
      failing(problem('SCOPE_DENIED', 403));
      expect(screen.getByRole('status')).toBeTruthy();
      expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
      cleanup();
      failing(problem('SESSION_EXPIRED', 401));
      expect(await screen.findByText(vi_['states.signedOut.title'])).toBeTruthy();
      cleanup();
      failing(new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }));
      expect(await screen.findByText(vi_['states.offline.title'])).toBeTruthy();
      cleanup();
      failing(problem('INTERNAL_ERROR', 500));
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      cleanup();
      open({ summary: { not: 'a contract' } });
      expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    });

    it('reads the summary again on retry', async () => {
      const state: World = { summary: problem('INTERNAL_ERROR', 500) };
      const h = client(state);
      mount(<WorkspaceScreen route={ROUTE} />, h, { permissions: PERMISSIONS, path: PATH });
      const retry = await screen.findByRole('button', { name: vi_['states.retry.action'] });
      state.summary = summary('DRAFT');
      fireEvent.click(retry);
      await screen.findByTestId('facts');
    });
  });
});
