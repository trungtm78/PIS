import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import AcceptanceScreen from './AcceptanceScreen';
import { OWNER, PAPER, READER, SUPERVISOR, acceptance, acceptanceId, client, inspectionId, mount, passed, routeOf, signature, world } from './test-support';
import type { World } from './test-support';
import { contractId } from '../../ctr/test-support';

const ROUTE = routeOf('QMS-05', 'FR-QMS-05');
const OK = { operation_id: 'o', status: 'SIGNING', resource_version: 3, resource_id: acceptanceId(9) };
const refusal = (code: string, status = 422, extensions: Record<string, unknown> = {}, detail?: string) => new ApiError({ status, code, correlationId: 'c', extensions, ...(detail === undefined ? {} : { detail }) });
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(state: World, options: { permissions?: readonly string[]; query?: string; command?: (operation: string, input: unknown) => unknown; mode?: 'FULL' | 'READ_ONLY' } = {}) {
  const h = client(state, options.command ?? (() => OK));
  mount(<AcceptanceScreen route={ROUTE} />, h, { permissions: options.permissions ?? READER, path: `/qms/qms-05${options.query ?? ''}`, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

const dialog = (): HTMLElement => screen.getByRole('dialog');
const pick = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const rows = (): string[] => Array.from(document.querySelectorAll('[data-acceptance]')).map((row) => row.getAttribute('data-acceptance') as string);
const row = (id: string): HTMLElement => document.querySelector(`[data-acceptance="${id}"]`) as HTMLElement;
const submit = (name: string): void => {
  fireEvent.click(within(dialog()).getByRole('button', { name }));
};
const commandsOf = (h: ReturnType<typeof client>, operation: string): Array<{ path?: { id?: string }; body: Record<string, unknown>; ifMatchVersion?: number }> =>
  h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { path?: { id?: string }; body: Record<string, unknown>; ifMatchVersion?: number });

describe('AcceptanceScreen (QMS-05): the quality acceptance minutes', () => {
  it('UI-QMS-05: lists the minutes with the roles that sign, who signed and how, and what each signature is worth', async () => {
    open(
      world({
        acceptances: [
          acceptance(1, {
            signatures: [signature('CONTRACTOR', 'Nhà thầu An Phát'), signature('SUPERVISOR', 'Giám sát Bình', { method: 'DIGITAL_CERT', legal_effect: 'LEGAL_E_SIGNATURE', cert_serial: 'SN-0099' })],
            missing_roles: ['OWNER'],
          }),
          acceptance(2, { status: 'DRAFT', signatures: [], acceptance_scope: 'COMPLETION', required_roles: ['CONTRACTOR', 'SUPERVISOR', 'OWNER', 'DESIGNER'], missing_roles: ['CONTRACTOR', 'SUPERVISOR', 'OWNER', 'DESIGNER'], boq_item: null }),
        ],
      }),
    );
    await screen.findByTestId('acceptances');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['qms.acceptance.page.title']);
    expect(screen.getByText(text('qms.acceptance.footer.reference', { id: 'QMS-05', req: 'FR-QMS-05' }))).toBeTruthy();
    expect(rows()).toEqual([acceptanceId(1), acceptanceId(2)]);
    const first = row(acceptanceId(1));
    expect(within(first).getByTestId('record').textContent).toContain('QA-W-001');
    expect(within(first).getByTestId('record').textContent).toContain(`HD-A-002 · KT-001 · ${vi_['qms.inspection.type.concealedWork']} · B01`);
    expect(within(first).getByTestId('scope').textContent).toBe(vi_['qms.acceptance.scope.workItem']);
    expect(within(first).getByTestId('status').textContent).toBe(vi_['qms.acceptance.status.signing']);
    const signed = Array.from(first.querySelectorAll('[data-role]')).map((item) => [item.getAttribute('data-role'), item.getAttribute('data-signed')]);
    expect(signed).toEqual([
      ['CONTRACTOR', 'true'],
      ['SUPERVISOR', 'true'],
      ['OWNER', 'false'],
    ]);
    const effects = within(first).getAllByTestId('effect').map((effect) => effect.textContent);
    expect(effects).toEqual([vi_['qms.acceptance.effect.internal'], vi_['qms.acceptance.effect.legal']]);
    expect(within(first).getByText(/SN-0099/)).toBeTruthy();
    expect(within(first).getByText(vi_['qms.acceptance.signer.waiting'], { exact: false })).toBeTruthy();
    const second = row(acceptanceId(2));
    expect(within(second).getByTestId('scope').textContent).toBe(vi_['qms.acceptance.scope.completion']);
    expect(second.querySelectorAll('[data-role]')).toHaveLength(4);
  });

  it('AC-ST-QMS-005-1, UAT-AC360: warns of an open serious non-conformance and of a regime still waiting for its confirmation, and marks a void signature', async () => {
    open(
      world({
        acceptances: [
          acceptance(1, { open_critical_ncr: 2, signatures: [signature('CONTRACTOR', 'Nhà thầu', { valid: false })] }),
          acceptance(2, { status: 'APPROVED', open_critical_ncr: 1, regime: { version_id: null, label: null, legal_basis: null, awaiting_confirmation: false, cxn: null }, decision_note: 'Đã xem tại hiện trường', approved_by: { membership_id: 'm', display_name: 'Chủ đầu tư' } }),
        ],
      }),
    );
    await screen.findByTestId('acceptances');
    const first = row(acceptanceId(1));
    expect(within(first).getByTestId('ncr-open').textContent).toBe(text('qms.acceptance.ncr.open', { count: 2 }));
    expect(within(first).getByTestId('regime-warning').textContent).toBe(text('qms.acceptance.regime.unconfirmed', { cxn: 'CXN-07' }));
    expect(within(first).getByText(vi_['qms.acceptance.signer.void'])).toBeTruthy();
    expect(first.querySelector('[data-role="CONTRACTOR"]')?.getAttribute('data-signed')).toBe('false');
    // Approved minutes need no warning about what blocks their approval, and keep their decision.
    const second = row(acceptanceId(2));
    expect(within(second).queryByTestId('ncr-open')).toBeNull();
    expect(within(second).queryByTestId('regime-warning')).toBeNull();
    expect(within(second).getByTestId('status').textContent).toBe(vi_['qms.acceptance.status.approved']);
    expect(within(second).getByTestId('decision-note').textContent).toBe('Đã xem tại hiện trường');
  });

  it('says when there are no minutes, and offers the contracts of the scope as a filter that narrows the list', async () => {
    open(world({ acceptances: [acceptance(1), acceptance(2, { contract: { id: contractId(1), code: 'HD-A-001', status: 'ACTIVE' } })] }));
    await screen.findByTestId('acceptances');
    const options = Array.from((document.getElementById('acceptances-contract') as HTMLSelectElement).options).map((option) => option.textContent);
    expect(options).toEqual([vi_['qms.acceptance.filter.all'], 'HD-A-001 · Hợp đồng số 1', 'HD-A-002']);
    pick('acceptances-contract', contractId(1));
    await waitFor(() => expect(rows()).toEqual([acceptanceId(2)]));
    pick('acceptances-contract', contractId(2));
    await waitFor(() => expect(rows()).toEqual([acceptanceId(1)]));
    cleanup();
    open(world(), { query: `?contract=${contractId(1)}` });
    expect((await screen.findByTestId('no-acceptances')).textContent).toBe(vi_['qms.acceptance.none.notice']);
    pick('acceptances-contract', '');
    await screen.findByTestId('no-acceptances');
  });

  it('still lists the minutes for whoever may not read the register, without the filter, and shows a read that failed', async () => {
    open(world({ acceptances: [acceptance(1)], failing: new Set(['get_resources_contract']) }));
    await screen.findByTestId('acceptances');
    expect(document.getElementById('acceptances-contract')).toBeNull();
    cleanup();
    const state = world({ failing: new Set(['listQualityAcceptances']) });
    const h = open(state);
    const retry = await screen.findByRole('button', { name: /thử lại|retry/i });
    state.failing.clear();
    fireEvent.click(retry);
    await screen.findByTestId('no-acceptances');
    expect(h.read.mock.calls.filter((call) => call[0] === 'listQualityAcceptances').length).toBeGreaterThan(1);
  });

  it('offers a button only for what the minutes and the caller allow, and none in a read-only session', async () => {
    const state = world({
      acceptances: [
        acceptance(1, { actions: { sign: true, approve: true, reject: true, revoke: false } }),
        acceptance(2, { status: 'APPROVED', actions: { sign: false, approve: false, reject: false, revoke: true } }),
        acceptance(3, { status: 'REJECTED', actions: { sign: false, approve: false, reject: false, revoke: false } }),
      ],
    });
    open(state, { permissions: OWNER });
    await screen.findByTestId('acceptances');
    expect(within(row(acceptanceId(1))).getAllByRole('button').map((button) => button.textContent)).toEqual([vi_['qms.acceptance.sign.action'], vi_['qms.acceptance.decide.action']]);
    expect(within(row(acceptanceId(2))).getAllByRole('button').map((button) => button.textContent)).toEqual([vi_['qms.acceptance.revoke.action']]);
    expect(within(row(acceptanceId(3))).queryByRole('button')).toBeNull();
    cleanup();
    open(state, { permissions: OWNER, mode: 'READ_ONLY' });
    await screen.findByTestId('acceptances');
    expect(within(row(acceptanceId(1))).queryByRole('button')).toBeNull();
  });

  describe('drafting', () => {
    it('offers the inspections that passed and have no live minutes, and nothing to whoever may not draft', async () => {
      open(
        world({
          inspections: [passed(1), passed(2, { result: 'CONDITIONAL', inspection_type: 'COMPLETION', required_roles: ['CONTRACTOR', 'SUPERVISOR', 'OWNER', 'DESIGNER'] }), passed(3, { result: 'FAIL' }), passed(4)],
          acceptances: [acceptance(4, { status: 'SIGNING' })],
        }),
        { permissions: SUPERVISOR },
      );
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.acceptance.draft.action'] }));
      const options = Array.from((document.getElementById('acceptance-inspection') as HTMLSelectElement).options).map((option) => option.textContent);
      expect(options).toEqual([vi_['qms.acceptance.field.inspection.choose'], 'KT-001 · HD-A-002 · Kiểm tra vật liệu đợt 1', 'KT-002 · HD-A-002 · Kiểm tra vật liệu đợt 2']);
      pick('acceptance-inspection', inspectionId(2));
      expect(screen.getByTestId('draft-scope').textContent).toBe(
        text('qms.acceptance.draft.scope', {
          kind: vi_['qms.inspection.type.completion'],
          scope: vi_['qms.acceptance.scope.completion'],
          roles: `${vi_['qms.inspection.role.contractor']}, ${vi_['qms.inspection.role.supervisor']}, ${vi_['qms.inspection.role.owner']}, ${vi_['qms.inspection.role.designer']}`,
        }),
      );
      cleanup();
      open(world({ inspections: [passed(1)] }), { permissions: ['qacceptance.read'] });
      await screen.findByTestId('no-acceptances');
      expect(screen.queryByRole('button', { name: vi_['qms.acceptance.draft.action'] })).toBeNull();
      cleanup();
      open(world({ inspections: [] }), { permissions: SUPERVISOR });
      await screen.findByTestId('no-acceptances');
      expect(screen.queryByRole('button', { name: vi_['qms.acceptance.draft.action'] })).toBeNull();
    });

    it('asks for the inspection, the number and the paper before it sends anything', async () => {
      const h = open(world({ inspections: [passed(1)] }), { permissions: SUPERVISOR });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.acceptance.draft.action'] }));
      submit(vi_['qms.acceptance.draft.submit']);
      expect(within(dialog()).getAllByText(vi_['qms.acceptance.problem.required'])).toHaveLength(3);
      pick('acceptance-inspection', inspectionId(1));
      pick('acceptance-record-no', 'QA-W-001');
      pick('acceptance-document', 'not-an-id');
      submit(vi_['qms.acceptance.draft.submit']);
      expect(within(dialog()).getByText(vi_['qms.acceptance.problem.uuid'])).toBeTruthy();
      expect(commandsOf(h, 'createQualityAcceptance')).toHaveLength(0);
    });

    it('sends the minutes with the scope of the inspection under its identifier, once, and closes', async () => {
      const h = open(world({ inspections: [passed(1, { inspection_type: 'CONSTRUCTION_STAGE' })] }), { permissions: SUPERVISOR });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.acceptance.draft.action'] }));
      pick('acceptance-inspection', inspectionId(1));
      pick('acceptance-record-no', ' QA-S-001 ');
      pick('acceptance-document', PAPER);
      submit(vi_['qms.acceptance.draft.submit']);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(commandsOf(h, 'createQualityAcceptance')).toEqual([{ path: { id: inspectionId(1) }, body: { acceptance_scope: 'STAGE', record_no: 'QA-S-001', document_version_id: PAPER }, attempt: expect.anything() }]);
    });

    it('says what the server refused for the draft, in words', async () => {
      const cases: Array<[Error, string]> = [
        [refusal('INSPECTION_NOT_PASSED'), 'qms.acceptance.error.inspectionNotPassed'],
        [refusal('OPEN_CRITICAL_NCR'), 'qms.acceptance.error.openCriticalNcr'],
        [refusal('QUALITY_ACCEPTANCE_STATE_INVALID', 409, { reason: 'RECORD_NO_USED' }), 'qms.acceptance.error.recordNoUsed'],
      ];
      for (const [error, key] of cases) {
        open(world({ inspections: [passed(1)] }), { permissions: SUPERVISOR, command: () => Promise.reject(error) });
        fireEvent.click(await screen.findByRole('button', { name: vi_['qms.acceptance.draft.action'] }));
        pick('acceptance-inspection', inspectionId(1));
        pick('acceptance-record-no', 'QA-W-001');
        pick('acceptance-document', PAPER);
        submit(vi_['qms.acceptance.draft.submit']);
        expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_[key as keyof typeof vi_]);
        cleanup();
      }
    });
  });

  describe('signing', () => {
    const signable = (roles: string[]) => world({ acceptances: [acceptance(1, { signable_roles: roles, version: 4 })] });

    it('signs as the only role the signer may sign as, with an in-app confirmation that is an internal record, under the version shown', async () => {
      const h = open(signable(['OWNER']), { permissions: OWNER });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.acceptance.sign.action'] }));
      expect((document.getElementById('acceptance-role') as HTMLSelectElement).value).toBe('OWNER');
      expect(within(dialog()).getByText(vi_['qms.acceptance.effect.internal'])).toBeTruthy();
      submit(vi_['qms.acceptance.sign.submit']);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      const [sent] = commandsOf(h, 'signQualityAcceptance');
      expect(sent).toMatchObject({ path: { id: acceptanceId(1) }, ifMatchVersion: 4, body: { signer_role: 'OWNER', signature_method: 'IN_APP_OTP' } });
      expect(sent?.body.client_operation_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(sent?.body).not.toHaveProperty('cert_serial');
    });

    it('asks for a role when there are several, and for the serial of a certificate, which is a legal electronic signature', async () => {
      const h = open(signable(['SUPERVISOR', 'OWNER']), { permissions: OWNER });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.acceptance.sign.action'] }));
      expect(Array.from((document.getElementById('acceptance-role') as HTMLSelectElement).options).map((option) => option.textContent)).toEqual([vi_['qms.acceptance.field.role.choose'], vi_['qms.inspection.role.supervisor'], vi_['qms.inspection.role.owner']]);
      submit(vi_['qms.acceptance.sign.submit']);
      expect(within(dialog()).getByText(vi_['qms.acceptance.problem.required'])).toBeTruthy();
      pick('acceptance-role', 'SUPERVISOR');
      pick('acceptance-method', 'DIGITAL_CERT');
      expect(within(dialog()).getByText(vi_['qms.acceptance.effect.legal'])).toBeTruthy();
      submit(vi_['qms.acceptance.sign.submit']);
      expect(within(dialog()).getByText(vi_['qms.acceptance.problem.certSerial'])).toBeTruthy();
      pick('acceptance-serial', ' SN-0099 ');
      submit(vi_['qms.acceptance.sign.submit']);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(commandsOf(h, 'signQualityAcceptance')[0]?.body).toMatchObject({ signer_role: 'SUPERVISOR', signature_method: 'DIGITAL_CERT', cert_serial: 'SN-0099' });
    });

    it('keeps the same identifier for a retry of the same signature', async () => {
      let attempts = 0;
      const h = open(signable(['OWNER']), {
        permissions: OWNER,
        command: () => {
          attempts += 1;
          return attempts === 1 ? Promise.reject(refusal('VERSION_CONFLICT', 409)) : OK;
        },
      });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.acceptance.sign.action'] }));
      submit(vi_['qms.acceptance.sign.submit']);
      expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_['qms.acceptance.error.versionConflict']);
      submit(vi_['qms.acceptance.sign.submit']);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      const [first, second] = commandsOf(h, 'signQualityAcceptance');
      expect(second?.body.client_operation_id).toBe(first?.body.client_operation_id);
    });

    it('says what the server refused for a signature, in words', async () => {
      const cases: Array<[Error, string]> = [
        [refusal('ROLE_NOT_REQUIRED'), 'qms.acceptance.error.roleNotRequired'],
        [refusal('ALREADY_SIGNED', 409), 'qms.acceptance.error.alreadySigned'],
        [refusal('SIGNATURE_METHOD_NOT_ACCEPTED'), 'qms.acceptance.error.methodNotAccepted'],
        [refusal('SCOPE_DENIED', 403, {}, 'signer_role'), 'qms.acceptance.error.notYourRole'],
        [refusal('QUALITY_ACCEPTANCE_STATE_INVALID', 409, { reason: 'CONTENT_CHANGED' }), 'qms.acceptance.error.contentChanged'],
      ];
      for (const [error, key] of cases) {
        open(signable(['OWNER']), { permissions: OWNER, command: () => Promise.reject(error) });
        fireEvent.click(await screen.findByRole('button', { name: vi_['qms.acceptance.sign.action'] }));
        submit(vi_['qms.acceptance.sign.submit']);
        expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_[key as keyof typeof vi_]);
        cleanup();
      }
    });
  });

  describe('deciding', () => {
    const decidable = (actions: Record<string, boolean>) => world({ acceptances: [acceptance(1, { signatures: [], missing_roles: [], actions: { sign: false, approve: false, reject: false, revoke: false, ...actions }, version: 6 })] });

    it('AC-ST-QMS-005-1, UAT-AC360: approves with a reason under the version shown, and closes', async () => {
      const h = open(decidable({ approve: true, reject: true }), { permissions: OWNER });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.acceptance.decide.action'] }));
      submit(vi_['qms.acceptance.decide.submit']);
      expect(within(dialog()).getAllByText(vi_['qms.acceptance.problem.required'])).toHaveLength(2);
      fireEvent.click(within(dialog()).getByLabelText(vi_['qms.acceptance.decision.approve']));
      pick('acceptance-reason', ' Đã đủ chữ ký ');
      submit(vi_['qms.acceptance.decide.submit']);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(commandsOf(h, 'decideQualityAcceptance')).toEqual([{ path: { id: acceptanceId(1) }, body: { decision: 'approve', reason: 'Đã đủ chữ ký' }, ifMatchVersion: 6, attempt: expect.anything() }]);
    });

    it('offers only the decision the caller may take: whoever drafted the minutes can reject and not approve', async () => {
      open(decidable({ approve: false, reject: true }), { permissions: OWNER });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.acceptance.decide.action'] }));
      expect(within(dialog()).queryByLabelText(vi_['qms.acceptance.decision.approve'])).toBeNull();
      expect(within(dialog()).getByLabelText(vi_['qms.acceptance.decision.reject'])).toBeTruthy();
    });

    it('names the roles that have not signed when the server refuses the approval, and says why for the other refusals', async () => {
      const cases: Array<[Error, string]> = [
        [refusal('SIGNATURES_INCOMPLETE', 422, { missing_roles: ['OWNER'] }), text('qms.acceptance.error.signaturesMissing', { roles: vi_['qms.inspection.role.owner'] })],
        [refusal('OPEN_CRITICAL_NCR'), vi_['qms.acceptance.error.openCriticalNcr']],
        [refusal('SELF_APPROVAL_DENIED', 403), vi_['qms.acceptance.error.selfApproval']],
        [refusal('CONTRACT_STATE_INVALID', 409), vi_['qms.acceptance.error.contractState']],
      ];
      for (const [error, message] of cases) {
        open(decidable({ approve: true, reject: true }), { permissions: OWNER, command: () => Promise.reject(error) });
        fireEvent.click(await screen.findByRole('button', { name: vi_['qms.acceptance.decide.action'] }));
        fireEvent.click(within(dialog()).getByLabelText(vi_['qms.acceptance.decision.approve']));
        pick('acceptance-reason', 'Duyệt');
        submit(vi_['qms.acceptance.decide.submit']);
        expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(message);
        cleanup();
      }
    });
  });

  describe('revoking', () => {
    const approved = () => world({ acceptances: [acceptance(1, { status: 'APPROVED', signatures: [], missing_roles: [], actions: { sign: false, approve: false, reject: false, revoke: true }, version: 8 })] });

    it('asks for a reason, sends it under the version shown and closes', async () => {
      const h = open(approved(), { permissions: OWNER });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.acceptance.revoke.action'] }));
      submit(vi_['qms.acceptance.revoke.submit']);
      expect(within(dialog()).getByText(vi_['qms.acceptance.problem.required'])).toBeTruthy();
      expect(commandsOf(h, 'revokeQualityAcceptance')).toHaveLength(0);
      pick('acceptance-revoke-reason', ' Công việc bị lỗi ');
      submit(vi_['qms.acceptance.revoke.submit']);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(commandsOf(h, 'revokeQualityAcceptance')).toEqual([{ path: { id: acceptanceId(1) }, body: { reason: 'Công việc bị lỗi' }, ifMatchVersion: 8, attempt: expect.anything() }]);
    });

    it('says in words that an approved acceptance of work holds the minutes, and shows revoked minutes with their reason', async () => {
      open(approved(), { permissions: OWNER, command: () => Promise.reject(refusal('ACCEPTANCE_ALREADY_USED', 409)) });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.acceptance.revoke.action'] }));
      pick('acceptance-revoke-reason', 'Lỗi');
      submit(vi_['qms.acceptance.revoke.submit']);
      expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_['qms.acceptance.error.alreadyUsed']);
      cleanup();
      open(world({ acceptances: [acceptance(1, { status: 'REVOKED', revoke_reason: 'Công việc bị lỗi', signatures: [], missing_roles: [], actions: { sign: false, approve: false, reject: false, revoke: false } })] }), { permissions: OWNER });
      expect((await screen.findByTestId('revoke-reason')).textContent).toBe(text('qms.acceptance.revoked.reason', { reason: 'Công việc bị lỗi' }));
    });

    it('closes without sending from the cross and from the cancel button', async () => {
      const h = open(approved(), { permissions: OWNER });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.acceptance.revoke.action'] }));
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['qms.acceptance.dialog.close'] }));
      expect(screen.queryByRole('dialog')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: vi_['qms.acceptance.revoke.action'] }));
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['qms.acceptance.dialog.cancel'] }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(commandsOf(h, 'revokeQualityAcceptance')).toHaveLength(0);
    });
  });
});
