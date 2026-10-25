import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import WorkspaceScreen from './WorkspaceScreen';
import { UUID_A, UUID_B, change, client, closure, completion, contractId, mount, noActions, readiness, routeOf, summary } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('CTR-03', 'FR-CTR-03');
const PATH = `/ctr/ctr-03?id=${contractId(1)}`;
const PERMISSIONS = ['contract.read'];
const OK = { operation_id: 'o', status: 'IN_REVIEW', resource_version: 4, resource_id: contractId(1) };
const problem = (code: string, status = 409, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });
const text = (key: string, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);

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
    expect(Array.from(document.querySelectorAll('[data-testid="history"] li')).map((item) => item.getAttribute('data-from') + '>' + item.getAttribute('data-to'))).toEqual([
      'DRAFT>IN_REVIEW',
      'IN_REVIEW>SIGNED',
    ]);
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
        open(
          { summary: summary('DRAFT', { actions: { ...noActions, submit: true } }) },
          { command: () => problem(code, code === 'CONFLICT_OF_INTEREST_BLOCKED' ? 409 : 422, code === 'CONFLICT_OF_INTEREST_BLOCKED' ? { conflict_of: 'ACTOR' } : {}) },
        );
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
      await waitFor(() =>
        expect(h.command).toHaveBeenCalledWith(
          'returnContractDraft',
          expect.objectContaining({ path: { id: contractId(1) }, body: { reason: 'The bill of quantities has to be corrected.' }, ifMatchVersion: 3 }),
        ),
      );
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
        expect.objectContaining({
          path: { id: contractId(1) },
          ifMatchVersion: 3,
          body: { decision: 'approve', reason: 'All the conditions are met.', evidence_ids: [UUID_A, UUID_B], effective_from: '2026-11-01' },
        }),
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
        [
          problem('PERMIT_GATE_BLOCKED', 409, { gate_code: 'CONTRACT_ACTIVATION', blocking: [{ permit_type_code: 'GPXD' }, { permit_type_code: 'PCCC' }] }),
          `${vi_['ctr.workspace.error.gateBlocked']} ${text('ctr.workspace.error.detail', { detail: 'GPXD, PCCC' })}`,
        ],
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

  describe('the revisions of a contract', () => {
    it('links to CTR-26 for the staff and for a guest alike, whatever the status', async () => {
      for (const status of ['DRAFT', 'ACTIVE', 'TERMINATED']) {
        open({ summary: summary(status) });
        await screen.findByTestId('facts');
        expect(screen.getByTestId('versions-link').getAttribute('href')).toBe(`/ctr/ctr-26?id=${contractId(1)}`);
        expect(screen.getByTestId('versions-link').textContent).toBe(vi_['ctr.workspace.versions.action']);
        cleanup();
      }
      open({ summary: summary('ACTIVE', { readiness: undefined, actions: undefined }) });
      await screen.findByTestId('facts');
      expect(screen.getByTestId('versions-link')).toBeTruthy();
    });
  });

  describe('the measurements of a contract', () => {
    it('links to CTR-10 for a contract that is being performed or suspended, for a guest contractor and in a read-only session too, and to nothing for any other', async () => {
      for (const status of ['ACTIVE', 'SUSPENDED']) {
        open({ summary: summary(status) });
        await screen.findByTestId('facts');
        expect(screen.getByTestId('measurements-link').getAttribute('href')).toBe(`/ctr/ctr-10?contract=${contractId(1)}`);
        expect(screen.getByTestId('measurements-link').textContent).toBe(vi_['ctr.workspace.measurements.action']);
        cleanup();
      }
      open({ summary: summary('ACTIVE', { readiness: undefined }) }, { mode: 'READ_ONLY' });
      await screen.findByTestId('facts');
      expect(screen.getByTestId('measurements-link')).toBeTruthy();
      cleanup();
      for (const status of ['DRAFT', 'IN_REVIEW', 'SIGNED', 'TERMINATED', 'COMPLETED']) {
        open({ summary: summary(status) });
        await screen.findByTestId('facts');
        expect(screen.queryByTestId('measurements-link')).toBeNull();
        cleanup();
      }
    });
  });

  describe('the change of a contract', () => {
    it('links to CTR-07 for the staff of a contract that is being performed or suspended, and to nothing for any other', async () => {
      for (const status of ['ACTIVE', 'SUSPENDED']) {
        open({ summary: summary(status) });
        await screen.findByTestId('facts');
        expect(screen.getByTestId('change-link').getAttribute('href')).toBe(`/ctr/ctr-07?contract=${contractId(1)}`);
        expect(screen.getByTestId('change-link').textContent).toBe(vi_['ctr.workspace.change.action']);
        cleanup();
      }
      for (const status of ['DRAFT', 'IN_REVIEW', 'SIGNED', 'TERMINATED', 'COMPLETED']) {
        open({ summary: summary(status) });
        await screen.findByTestId('facts');
        expect(screen.queryByTestId('change-link')).toBeNull();
        cleanup();
      }
    });

    it('does not link for a guest contractor, who has no readiness to read, or in a read-only session', async () => {
      open({ summary: summary('ACTIVE', { readiness: undefined }) });
      await screen.findByTestId('facts');
      expect(screen.queryByTestId('change-link')).toBeNull();
      cleanup();
      open({ summary: summary('ACTIVE') }, { mode: 'READ_ONLY' });
      await screen.findByTestId('facts');
      expect(screen.queryByTestId('change-link')).toBeNull();
    });
  });

  describe('the commands that stop a contract', () => {
    it('links to CTR-22 for someone who may suspend, resume or terminate, and says no command applies only when nothing is offered at all', async () => {
      open({ summary: summary('ACTIVE', { actions: { ...noActions, suspend: true } }) });
      await screen.findByTestId('facts');
      expect(screen.getByTestId('halt-link').getAttribute('href')).toBe(`/ctr/ctr-22?id=${contractId(1)}`);
      expect(screen.getByTestId('halt-link').textContent).toBe(vi_['ctr.workspace.halt.action']);
      expect(commandButtons()).toEqual([]);
      expect(screen.queryByTestId('no-command')).toBeNull();
      cleanup();
      open({ summary: summary('ACTIVE', { actions: noActions }) });
      await screen.findByTestId('facts');
      expect(screen.queryByTestId('halt-link')).toBeNull();
      expect(screen.getByTestId('no-command')).toBeTruthy();
    });

    it('does not link in a read-only session', async () => {
      open({ summary: summary('ACTIVE', { actions: { ...noActions, terminate: true } }) }, { mode: 'READ_ONLY' });
      await screen.findByTestId('facts');
      expect(screen.queryByTestId('halt-link')).toBeNull();
      expect(screen.getByTestId('no-command').textContent).toBe(vi_['ctr.workspace.readOnly.notice']);
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

describe('WorkspaceScreen (CTR-03): the completion of a contract', () => {
  const active = (overrides: Record<string, unknown> = {}) => summary('ACTIVE', { readiness: undefined, completion: completion(), actions: { ...noActions, complete: true }, ...overrides });
  const checks = (): Array<[string | null, string | null]> =>
    Array.from(document.querySelectorAll('[data-completion]')).map((item) => [item.getAttribute('data-completion'), item.getAttribute('data-ok')]);

  it('UI-CTR-03: shows what stands in the way of the completion, and offers it to whoever may complete the contract', async () => {
    open({ summary: active() });
    await screen.findByTestId('completion-checks');
    expect(commandButtons()).toEqual(['complete']);
    expect(screen.getByRole('button', { name: vi_['ctr.workspace.complete.action'] })).toBeTruthy();
    expect(checks()).toEqual([
      ['acceptance', 'true'],
      ['ncr', 'true'],
      ['measurement', 'true'],
    ]);
    expect(within(screen.getByTestId('completion-checks')).queryByText(/\d+ ·/)).toBeNull();
  });

  it('AC-ST-CTR-011-1, UAT-AC305: says the serious non-conformances and the measurements that stand in the way, with how many, and the lack of approved minutes', async () => {
    open({ summary: active({ completion: completion({ acceptances: [], open_critical_ncr_ids: [UUID_A, UUID_B], pending_measurement_ids: [UUID_A] }) }) });
    await screen.findByTestId('completion-checks');
    expect(checks()).toEqual([
      ['acceptance', 'false'],
      ['ncr', 'false'],
      ['measurement', 'false'],
    ]);
    expect(document.querySelector('[data-completion="ncr"]')?.textContent).toContain(text('ctr.workspace.completion.count', { count: 2 }));
    expect(document.querySelector('[data-completion="measurement"]')?.textContent).toContain(text('ctr.workspace.completion.count', { count: 1 }));
    expect(document.querySelector('[data-completion="acceptance"]')?.textContent).not.toContain(text('ctr.workspace.completion.count', { count: 0 }));
  });

  it('shows no way to completion for a contract that is not being performed or to whoever sees the contract alone, and no button in a read-only session', async () => {
    open({ summary: summary('SUSPENDED', { completion: completion(), actions: { ...noActions } }) });
    await screen.findByTestId('facts');
    expect(screen.queryByTestId('completion-checks')).toBeNull();
    cleanup();
    open({ summary: summary('ACTIVE', { readiness: undefined, actions: undefined }) });
    await screen.findByTestId('facts');
    expect(screen.queryByTestId('completion-checks')).toBeNull();
    cleanup();
    open({ summary: active() }, { mode: 'READ_ONLY' });
    await screen.findByTestId('completion-checks');
    expect(commandButtons()).toEqual([]);
  });

  it('asks for the minutes and the day, with the only approved minutes chosen, and sends the completion once under the version shown', async () => {
    const h = open({ summary: active() });
    await screen.findByTestId('completion-checks');
    press('complete');
    expect((within(dialog()).getByLabelText(vi_['ctr.workspace.complete.acceptance']) as HTMLSelectElement).value).toBe(UUID_A);
    expect(Array.from((within(dialog()).getByLabelText(vi_['ctr.workspace.complete.acceptance']) as HTMLSelectElement).options).map((option) => option.textContent)).toEqual([
      vi_['ctr.workspace.complete.acceptance.choose'],
      text('ctr.workspace.complete.acceptance.option', { recordNo: 'QA-C-001', day: '2026-10-20' }),
    ]);
    fireEvent.change(within(dialog()).getByLabelText(vi_['ctr.workspace.complete.completedOn']), { target: { value: '2999-01-01' } });
    submitDialog(vi_['ctr.workspace.complete.submit']);
    expect(within(dialog()).getByText(vi_['ctr.workspace.problem.future'])).toBeTruthy();
    fireEvent.change(within(dialog()).getByLabelText(vi_['ctr.workspace.complete.completedOn']), { target: { value: '' } });
    submitDialog(vi_['ctr.workspace.complete.submit']);
    expect(within(dialog()).getByText(vi_['ctr.workspace.problem.required'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(dialog()).getByLabelText(vi_['ctr.workspace.complete.completedOn']), { target: { value: '2026-10-24' } });
    submitDialog(vi_['ctr.workspace.complete.submit']);
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith(
      'completeContract',
      expect.objectContaining({ path: { id: contractId(1) }, ifMatchVersion: 3, body: { completion_quality_acceptance_id: UUID_A, completed_on: '2026-10-24' } }),
    );
  });

  it('asks for the minutes when there are several to choose from', async () => {
    const several = completion({
      acceptances: [
        { id: UUID_A, record_no: 'QA-C-001', approved_on: '2026-10-20' },
        { id: UUID_B, record_no: 'QA-C-002', approved_on: '2026-10-22' },
      ],
    });
    const h = open({ summary: active({ completion: several }) });
    await screen.findByTestId('completion-checks');
    press('complete');
    expect((within(dialog()).getByLabelText(vi_['ctr.workspace.complete.acceptance']) as HTMLSelectElement).value).toBe('');
    submitDialog(vi_['ctr.workspace.complete.submit']);
    expect(within(dialog()).getByText(vi_['ctr.workspace.problem.required'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(dialog()).getByLabelText(vi_['ctr.workspace.complete.acceptance']), { target: { value: UUID_B } });
    submitDialog(vi_['ctr.workspace.complete.submit']);
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith('completeContract', expect.objectContaining({ body: expect.objectContaining({ completion_quality_acceptance_id: UUID_B }) }));
  });

  it('says why the server refused, naming the non-conformances and the measurements', async () => {
    for (const [error, expected] of [
      [problem('COMPLETION_ACCEPTANCE_REQUIRED', 422, { reason: 'NOT_APPROVED' }), vi_['ctr.workspace.error.completionAcceptance']],
      [problem('OPEN_CRITICAL_NCR', 422, { nonconformance_ids: [UUID_A] }), `${vi_['ctr.workspace.error.openCriticalNcr']} ${text('ctr.workspace.error.detail', { detail: UUID_A })}`],
      [
        problem('MEASUREMENT_PENDING', 422, { measurement_ids: [UUID_A, UUID_B] }),
        `${vi_['ctr.workspace.error.measurementPending']} ${text('ctr.workspace.error.detail', { detail: `${UUID_A}, ${UUID_B}` })}`,
      ],
      [problem('CONTRACT_STATE_INVALID'), vi_['ctr.workspace.error.stateInvalid']],
      [problem('VERSION_CONFLICT'), vi_['ctr.workspace.error.versionConflict']],
    ] as const) {
      open({ summary: active() }, { command: () => error });
      await screen.findByTestId('completion-checks');
      press('complete');
      submitDialog(vi_['ctr.workspace.complete.submit']);
      expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(expected);
      expect(screen.getByRole('dialog')).toBeTruthy();
      cleanup();
    }
  });
});

describe('WorkspaceScreen (CTR-03): the closure of a contract', () => {
  const completed = (overrides: Record<string, unknown> = {}) => summary('COMPLETED', { readiness: undefined, closure: closure(), actions: { ...noActions, close: true }, ...overrides });
  const checks = (): Array<[string | null, string | null]> => Array.from(document.querySelectorAll('[data-closure]')).map((item) => [item.getAttribute('data-closure'), item.getAttribute('data-ok')]);

  it('UI-CTR-03: shows what stands in the way of the closure, and offers it to whoever may close the contract', async () => {
    open({ summary: completed() });
    await screen.findByTestId('closure-checks');
    expect(commandButtons()).toEqual(['close']);
    expect(screen.getByRole('button', { name: vi_['ctr.workspace.close.action'] })).toBeTruthy();
    expect(checks()).toEqual([
      ['settlement', 'true'],
      ['advance', 'true'],
      ['retention', 'true'],
    ]);
  });

  it('AC-ST-CTR-012-1, UAT-AC300: says the settlement, the advance and the retention that stand in the way, with what is left', async () => {
    open({
      summary: completed({
        closure: closure({ settlements: [], retention: { holds: 2, unresolved_vnd: '150000000' }, unmet: ['SETTLEMENT_NOT_CLOSED', 'ADVANCE_OUTSTANDING', 'RETENTION_UNRESOLVED'] }),
      }),
    });
    await screen.findByTestId('closure-checks');
    expect(checks()).toEqual([
      ['settlement', 'false'],
      ['advance', 'false'],
      ['retention', 'false'],
    ]);
    expect(document.querySelector('[data-closure="settlement"]')?.textContent).not.toContain('{amount}');
    expect(document.querySelector('[data-closure="advance"]')?.textContent).toContain(new Intl.NumberFormat('vi').format(1250000000));
    expect(document.querySelector('[data-closure="retention"]')?.textContent).toContain(new Intl.NumberFormat('vi').format(150000000));
  });

  it('shows the closure of a contract that was terminated, and none for another status, for whoever sees the contract alone, or with no button in a read-only session', async () => {
    open({ summary: summary('TERMINATED', { readiness: undefined, closure: closure(), actions: { ...noActions, close: true } }) });
    await screen.findByTestId('closure-checks');
    cleanup();
    open({ summary: summary('ACTIVE', { readiness: undefined, closure: closure(), actions: noActions }) });
    await screen.findByTestId('facts');
    expect(screen.queryByTestId('closure-checks')).toBeNull();
    cleanup();
    open({ summary: summary('COMPLETED', { readiness: undefined, closure: undefined, actions: undefined }) });
    await screen.findByTestId('facts');
    expect(screen.queryByTestId('closure-checks')).toBeNull();
    cleanup();
    open({ summary: completed() }, { mode: 'READ_ONLY' });
    await screen.findByTestId('closure-checks');
    expect(commandButtons()).toEqual([]);
  });

  it('AC-ST-CTR-012-1, UAT-AC300: asks for the settlement, with the only one chosen, and sends the closure once under the version shown, with the note when there is one', async () => {
    const h = open({ summary: completed() });
    await screen.findByTestId('closure-checks');
    press('close');
    expect((within(dialog()).getByLabelText(vi_['ctr.workspace.close.settlement']) as HTMLSelectElement).value).toBe(UUID_A);
    expect(Array.from((within(dialog()).getByLabelText(vi_['ctr.workspace.close.settlement']) as HTMLSelectElement).options).map((option) => option.textContent)).toEqual([
      vi_['ctr.workspace.close.settlement.choose'],
      text('ctr.workspace.close.settlement.excepted', { scope: vi_['ctr.workspace.close.scope.contract'], revision: 2 }),
    ]);
    fireEvent.change(within(dialog()).getByLabelText(vi_['ctr.workspace.close.note']), { target: { value: 'Đã giải tỏa hết.' } });
    submitDialog(vi_['ctr.workspace.close.submit']);
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith(
      'closeContract',
      expect.objectContaining({ path: { id: contractId(1) }, ifMatchVersion: 3, body: { settlement_revision_id: UUID_A, note: 'Đã giải tỏa hết.' } }),
    );
  });

  it('asks for the settlement when there are several to choose from, and says the scope of each', async () => {
    const several = closure({
      settlements: [
        { id: UUID_A, scope: 'CONTRACT', revision: 2, excepted: false },
        { id: UUID_B, scope: 'PROJECT', revision: 1, excepted: false },
      ],
    });
    const h = open({ summary: completed({ closure: several }) });
    await screen.findByTestId('closure-checks');
    press('close');
    const select = within(dialog()).getByLabelText(vi_['ctr.workspace.close.settlement']) as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      vi_['ctr.workspace.close.settlement.choose'],
      text('ctr.workspace.close.settlement.option', { scope: vi_['ctr.workspace.close.scope.contract'], revision: 2 }),
      text('ctr.workspace.close.settlement.option', { scope: vi_['ctr.workspace.close.scope.project'], revision: 1 }),
    ]);
    submitDialog(vi_['ctr.workspace.close.submit']);
    expect(within(dialog()).getByText(vi_['ctr.workspace.problem.required'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(select, { target: { value: UUID_B } });
    submitDialog(vi_['ctr.workspace.close.submit']);
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith('closeContract', expect.objectContaining({ body: { settlement_revision_id: UUID_B } }));
  });

  it('AC-ST-CTR-012-1, UAT-AC300: says why the server refused, guard by guard', async () => {
    for (const [error, expected] of [
      [problem('SETTLEMENT_NOT_CLOSED', 422), vi_['ctr.workspace.error.settlementNotClosed']],
      [problem('ADVANCE_OUTSTANDING', 422), vi_['ctr.workspace.error.advanceOutstanding']],
      [problem('RETENTION_UNRESOLVED', 422), vi_['ctr.workspace.error.retentionUnresolved']],
      [problem('CONTRACT_STATE_INVALID'), vi_['ctr.workspace.error.stateInvalid']],
      [problem('VERSION_CONFLICT'), vi_['ctr.workspace.error.versionConflict']],
    ] as const) {
      open({ summary: completed() }, { command: () => error });
      await screen.findByTestId('closure-checks');
      press('close');
      submitDialog(vi_['ctr.workspace.close.submit']);
      expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(expected);
      expect(screen.getByRole('dialog')).toBeTruthy();
      cleanup();
    }
  });
});
