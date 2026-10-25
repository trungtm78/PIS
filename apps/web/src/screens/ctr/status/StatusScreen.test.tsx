import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { UUID_A, contractId, mount, noActions, routeOf, summary, client } from '../workspace/test-support';
import type { World } from '../workspace/test-support';
import StatusScreen from './StatusScreen';

const ROUTE = routeOf('CTR-22', 'FR-CTR-22');
const PATH = `/ctr/ctr-22?id=${contractId(1)}`;
const PERMISSIONS = ['contract.read', 'contract.suspend', 'contract.terminate'];
const OK = { operation_id: 'o', status: 'SUSPENDED', resource_version: 4, resource_id: contractId(1) };
const problem = (code: string, status = 409, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(state: World, options: { command?: (operation: string, input: unknown) => unknown; mode?: 'FULL' | 'READ_ONLY'; path?: string } = {}) {
  const h = client(state, options.command ?? (() => OK));
  mount(<StatusScreen route={ROUTE} />, h, { permissions: PERMISSIONS, path: options.path ?? PATH, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

const radios = (): string[] => Array.from(document.querySelectorAll('input[name="halt-action"]')).map((input) => input.getAttribute('data-action') as string);
const choose = (action: string): void => {
  fireEvent.click(document.querySelector(`input[data-action="${action}"]`) as HTMLElement);
};
const type = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const press = (name: string): void => {
  fireEvent.click(screen.getByRole('button', { name }));
};
const active = (actions: Partial<Record<'suspend' | 'resume' | 'terminate', boolean>>) => summary('ACTIVE', { actions: { ...noActions, ...actions } });

describe('StatusScreen (CTR-22): suspend, resume and terminate a contract', () => {
  it('asks for a contract when the address names none', async () => {
    open({ summary: active({ suspend: true }) }, { path: '/ctr/ctr-22' });
    expect((await screen.findByTestId('no-contract')).textContent).toBe(vi_['ctr.halt.none.notice']);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['ctr.halt.page.title']);
  });

  it('UI-CTR-22: shows the contract and offers the actions the caller may take, and nothing else', async () => {
    open({ summary: active({ suspend: true, terminate: true }) });
    await screen.findByTestId('facts');
    expect(screen.getByTestId('contract-code').textContent).toBe('HD-A-001');
    expect(screen.getByTestId('value').textContent).toBe(text('ctr.value.amount', { amount: '10.200.000.000' }));
    expect(radios()).toEqual(['suspend', 'terminate']);
    // Nothing is asked until an action is chosen.
    expect(document.getElementById('halt-reason')).toBeNull();
    expect(screen.getByText(text('ctr.halt.footer.reference', { id: 'CTR-22', req: 'FR-CTR-22' }))).toBeTruthy();
  });

  describe('suspending', () => {
    it('AC-ST-CTR-005-1, UAT-AC303: asks for the reason, the document and the day, says what it does to the payments, and sends them under the version it showed', async () => {
      const h = open({ summary: active({ suspend: true, terminate: true }) });
      await screen.findByTestId('facts');
      choose('suspend');
      expect(screen.getByTestId('impact').textContent).toContain(vi_['ctr.halt.impact.suspend']);
      expect(screen.queryByTestId('irreversible')).toBeNull();
      type('halt-day', '');
      press(vi_['ctr.halt.submit.suspend']);
      expect(screen.getAllByText(vi_['ctr.workspace.problem.required'])).toHaveLength(3);
      type('halt-document', 'not-an-id');
      type('halt-day', '2999-01-01');
      type('halt-reason', 'The site is closed by the decision.');
      press(vi_['ctr.halt.submit.suspend']);
      expect(screen.getByText(vi_['ctr.workspace.problem.uuid'])).toBeTruthy();
      expect(screen.getByText(vi_['ctr.workspace.problem.future'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      type('halt-document', UUID_A.toUpperCase());
      type('halt-day', '2026-10-12');
      press(vi_['ctr.halt.submit.suspend']);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith(
        'suspendContract',
        expect.objectContaining({ path: { id: contractId(1) }, ifMatchVersion: 3, body: { reason: 'The site is closed by the decision.', decision_document_version_id: UUID_A, suspended_from: '2026-10-12' } }),
      );
      expect((await screen.findByTestId('done')).textContent).toBe(vi_['ctr.halt.done.notice']);
    });

    it('keeps the reason and the document when the person changes their mind about the action', async () => {
      open({ summary: active({ suspend: true, terminate: true }) });
      await screen.findByTestId('facts');
      choose('suspend');
      type('halt-reason', 'A reason.');
      type('halt-document', UUID_A);
      choose('terminate');
      expect((document.getElementById('halt-reason') as HTMLTextAreaElement).value).toBe('A reason.');
      expect((document.getElementById('halt-document') as HTMLInputElement).value).toBe(UUID_A);
      expect(screen.getByTestId('irreversible').textContent).toBe(vi_['ctr.halt.irreversible.notice']);
    });
  });

  describe('resuming', () => {
    const suspended = () => summary('SUSPENDED', { actions: { ...noActions, resume: true } });

    it('AC-ST-CTR-005-1, UAT-AC303: preselects the only action, takes an extension as a request and sends it as a number of days', async () => {
      const h = open({ summary: suspended() });
      await screen.findByTestId('facts');
      expect(radios()).toEqual(['resume']);
      expect((document.querySelector('input[data-action="resume"]') as HTMLInputElement).checked).toBe(true);
      expect(screen.getByTestId('impact').textContent).toContain(vi_['ctr.halt.impact.resume']);
      type('halt-reason', 'The site is open again.');
      type('halt-document', UUID_A);
      for (const wrong of ['abc', '0', '3651', '1.5']) {
        type('halt-extension', wrong);
        press(vi_['ctr.halt.submit.resume']);
        expect(screen.getByText(vi_['ctr.workspace.problem.extension'])).toBeTruthy();
      }
      expect(h.command).not.toHaveBeenCalled();
      type('halt-extension', ' 20 ');
      type('halt-day', '2026-10-20');
      press(vi_['ctr.halt.submit.resume']);
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('resumeContract', expect.objectContaining({ ifMatchVersion: 3, body: { reason: 'The site is open again.', decision_document_version_id: UUID_A, resumed_on: '2026-10-20', extension_days: 20 } })));
    });

    it('sends no extension when none was typed', async () => {
      const h = open({ summary: suspended() });
      await screen.findByTestId('facts');
      type('halt-reason', 'Back.');
      type('halt-document', UUID_A);
      type('halt-day', '2026-10-20');
      press(vi_['ctr.halt.submit.resume']);
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('resumeContract', expect.objectContaining({ body: { reason: 'Back.', decision_document_version_id: UUID_A, resumed_on: '2026-10-20' } })));
    });
  });

  describe('terminating', () => {
    const live = () => summary('ACTIVE', { actions: { ...noActions, terminate: true } });

    it('AC-ST-CTR-005-2, UAT-AC304: warns that it cannot be undone, asks what becomes of the guarantee and for a confirmation, then sends the decision', async () => {
      const h = open({ summary: live() });
      await screen.findByTestId('facts');
      expect((document.querySelector('input[data-action="terminate"]') as HTMLInputElement).checked).toBe(true);
      expect(screen.getByTestId('irreversible').textContent).toBe(vi_['ctr.halt.irreversible.notice']);
      expect(screen.getByTestId('impact').textContent).toContain(vi_['ctr.halt.impact.terminate']);
      type('halt-reason', 'The contractor abandoned the site.');
      type('halt-document', UUID_A);
      type('halt-day', '2026-10-20');
      press(vi_['ctr.halt.submit.terminate']);
      expect(screen.getByText(vi_['ctr.workspace.problem.required'])).toBeTruthy();
      expect(screen.getByText(vi_['ctr.workspace.problem.confirm'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      const options = Array.from((document.getElementById('halt-guarantee') as HTMLSelectElement).options).map((option) => option.textContent);
      expect(options).toEqual([vi_['ctr.halt.field.guarantee.choose'], vi_['ctr.halt.guarantee.call'], vi_['ctr.halt.guarantee.release'], vi_['ctr.halt.guarantee.hold']]);
      fireEvent.change(document.getElementById('halt-guarantee') as HTMLElement, { target: { value: 'CALL' } });
      fireEvent.click(document.getElementById('halt-confirm') as HTMLElement);
      press(vi_['ctr.halt.submit.terminate']);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith(
        'terminateContract',
        expect.objectContaining({ path: { id: contractId(1) }, ifMatchVersion: 3, body: { reason: 'The contractor abandoned the site.', decision_document_version_id: UUID_A, terminated_on: '2026-10-20', guarantee_action: 'CALL' } }),
      );
    });

    it('ignores a guarantee action it does not know', async () => {
      open({ summary: live() });
      await screen.findByTestId('facts');
      fireEvent.change(document.getElementById('halt-guarantee') as HTMLElement, { target: { value: 'CALL' } });
      fireEvent.change(document.getElementById('halt-guarantee') as HTMLElement, { target: { value: '' } });
      expect((document.getElementById('halt-guarantee') as HTMLSelectElement).value).toBe('');
    });

    it('says why the server refused it: no document, a proposer, the delegation limit, a conflict, nothing to call, a contract that moved', async () => {
      for (const [error, expected] of [
        [problem('DECISION_DOCUMENT_REQUIRED', 422), vi_['ctr.workspace.error.decisionDocument']],
        [problem('SELF_APPROVAL_DENIED', 403), vi_['ctr.workspace.error.selfApproval']],
        [problem('SCOPE_DENIED', 403, { approver_role_id: UUID_A }), vi_['ctr.workspace.error.delegation']],
        [problem('CONFLICT_OF_INTEREST_BLOCKED', 409, { conflict_of: 'ACTOR' }), vi_['ctr.workspace.error.conflictActor']],
        [problem('VALIDATION_FAILED', 422, { reason: 'NO_ACTIVE_GUARANTEE' }), vi_['ctr.workspace.error.noGuarantee']],
        [problem('VALIDATION_FAILED', 422), vi_['ctr.workspace.error.validation']],
        [problem('CONTRACT_STATE_INVALID', 409), vi_['ctr.workspace.error.stateInvalid']],
        [problem('VERSION_CONFLICT', 409), vi_['ctr.workspace.error.versionConflict']],
      ] as const) {
        open({ summary: live() }, { command: () => error });
        await screen.findByTestId('facts');
        type('halt-reason', 'Reason.');
        type('halt-document', UUID_A);
        fireEvent.change(document.getElementById('halt-guarantee') as HTMLElement, { target: { value: 'CALL' } });
        fireEvent.click(document.getElementById('halt-confirm') as HTMLElement);
        press(vi_['ctr.halt.submit.terminate']);
        expect((await screen.findByTestId('refusal')).textContent).toBe(expected);
        cleanup();
      }
    });
  });

  describe('who is offered what', () => {
    it('offers nothing in a read-only session, and says so', async () => {
      open({ summary: active({ suspend: true, terminate: true }) }, { mode: 'READ_ONLY' });
      await screen.findByTestId('facts');
      expect(radios()).toEqual([]);
      expect(screen.getByTestId('no-command').textContent).toBe(vi_['ctr.workspace.readOnly.notice']);
    });

    it('says that no action applies to someone who may take none, and to someone who sees the contract alone', async () => {
      open({ summary: active({}) });
      await screen.findByTestId('facts');
      expect(screen.getByTestId('no-command').textContent).toBe(vi_['ctr.workspace.noCommand.notice']);
      cleanup();
      const guest: Record<string, unknown> = { ...summary('ACTIVE') };
      delete guest.readiness;
      delete guest.actions;
      open({ summary: guest });
      await screen.findByTestId('facts');
      expect(radios()).toEqual([]);
      expect(within(screen.getByTestId('no-command')).getByText(vi_['ctr.workspace.noCommand.notice'])).toBeTruthy();
    });
  });

  describe('the seven states (UI-CTR-22)', () => {
    const failing = (error: ApiError) => {
      mount(<StatusScreen route={ROUTE} />, client({ summary: error }), { permissions: PERMISSIONS, path: PATH });
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
      mount(<StatusScreen route={ROUTE} />, client(state), { permissions: PERMISSIONS, path: PATH });
      const retry = await screen.findByRole('button', { name: vi_['states.retry.action'] });
      state.summary = active({ suspend: true });
      fireEvent.click(retry);
      await screen.findByTestId('facts');
    });
  });
});
