import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import NonconformanceScreen from './NonconformanceScreen';
import { DOCUMENT, ME, PHOTO, HANDLER, RAISER, READER, action, actionId, allowed, client, contractId, memberId, mount, ncr, ncrId, routeOf, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('QMS-07', 'FR-QMS-07');
const OK = { operation_id: 'o', status: 'OPEN', resource_version: 2, resource_id: ncrId(9) };
const refusal = (code: string, status = 422, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });
const text = (key: string, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);
const mine = { membership_id: ME, display_name: 'Tôi' };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(state: World, options: { permissions?: readonly string[]; query?: string; command?: (operation: string, input: unknown) => unknown; mode?: 'FULL' | 'READ_ONLY' } = {}) {
  const h = client(state, options.command ?? (() => OK));
  mount(<NonconformanceScreen route={ROUTE} />, h, {
    permissions: options.permissions ?? READER,
    path: `/qms/qms-07${options.query ?? ''}`,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
  });
  return h;
}

const dialog = (): HTMLElement => screen.getByRole('dialog');
const pick = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const card = (id: string): HTMLElement => document.querySelector(`[data-ncr="${id}"]`) as HTMLElement;
const lane = (name: string): HTMLElement => document.querySelector(`[data-lane="${name}"]`) as HTMLElement;
const cardsIn = (name: string): string[] => Array.from(lane(name).querySelectorAll('[data-ncr]')).map((node) => node.getAttribute('data-ncr') as string);
const submit = (name: string): void => {
  fireEvent.click(within(dialog()).getByRole('button', { name }));
};
const commandsOf = (h: ReturnType<typeof client>, operation: string): Array<{ path?: { id?: string }; body: Record<string, unknown>; ifMatchVersion?: number }> =>
  h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { path?: { id?: string }; body: Record<string, unknown>; ifMatchVersion?: number });

describe('NonconformanceScreen (QMS-07): the non-conformances and the actions that put them right', () => {
  it('UI-QMS-07: puts each non-conformance in the lane of its status, the one due soonest first, with its severity and what it holds back', async () => {
    open(
      world({
        nonconformances: [
          ncr(1, { due_at: '2026-12-01T16:59:00.000Z' }),
          ncr(2, { status: 'REOPENED', due_at: '2026-11-01T16:59:00.000Z', reopen_count: 1, reopen_reason: 'Nứt lại sau đợt đổ tiếp theo' }),
          ncr(3, {
            status: 'ACTION_ASSIGNED',
            severity: 'CRITICAL',
            blocks_acceptance: true,
            overdue: true,
            actions: [action(1, { overdue: true }), action(2, { status: 'REJECTED', verification_note: 'Vẫn thiếu' })],
          }),
          ncr(4, { status: 'ACTION_SUBMITTED', severity: 'MINOR', actions: [action(3, { status: 'SUBMITTED', evidence_note: 'Đã đổ lại' })] }),
          ncr(5, { status: 'VERIFIED', root_cause: 'Ván khuôn xê dịch' }),
          ncr(6, { status: 'CLOSED', severity: 'CRITICAL', blocks_acceptance: true, closure_note: 'Đã xác nhận đủ' }),
        ],
      }),
    );
    await screen.findByTestId('board');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['qms.ncr.page.title']);
    expect(screen.getByText(text('qms.ncr.footer.reference', { id: 'QMS-07', req: 'FR-QMS-07' }))).toBeTruthy();
    expect(cardsIn('OPEN')).toEqual([ncrId(2), ncrId(1)]);
    expect(cardsIn('ACTION_ASSIGNED')).toEqual([ncrId(3)]);
    expect(cardsIn('ACTION_SUBMITTED')).toEqual([ncrId(4)]);
    expect(cardsIn('VERIFIED')).toEqual([ncrId(5)]);
    expect(cardsIn('CLOSED')).toEqual([ncrId(6)]);
    expect(within(lane('OPEN')).getByRole('heading').textContent).toContain('2');

    const critical = card(ncrId(3));
    expect(within(critical).getByTestId('no').textContent).toBe('NCR-003');
    expect(within(critical).getByTestId('severity').textContent).toBe(vi_['qms.ncr.severity.critical']);
    expect(within(critical).getByTestId('blocks').textContent).toBe(vi_['qms.ncr.blocks.badge']);
    expect(within(critical).getByTestId('overdue').textContent).toBe(vi_['qms.ncr.overdue.badge']);
    expect(within(critical).getByTestId('due').textContent).toContain('Giám sát Bình');
    expect(within(critical).getByTestId('due').textContent).toContain('23:59');
    expect(within(critical).getByTestId('status').textContent).toBe(vi_['qms.ncr.status.actionAssigned']);
    const actions = within(critical).getByTestId('actions');
    expect(
      within(actions)
        .getAllByRole('listitem')
        .map((item) => item.getAttribute('data-status')),
    ).toEqual(['ASSIGNED', 'REJECTED']);
    expect(within(actions).getAllByTestId('action-overdue')).toHaveLength(1);
    expect(actions.textContent).toContain(text('qms.ncr.action.rejected.note', { note: 'Vẫn thiếu' }));

    // A closed one no longer holds the acceptance back; a minor one never did.
    expect(within(card(ncrId(6))).queryByTestId('blocks')).toBeNull();
    expect(within(card(ncrId(6))).getByTestId('closure-note').textContent).toBe(text('qms.ncr.closureNote.label', { note: 'Đã xác nhận đủ' }));
    expect(within(card(ncrId(4))).queryByTestId('blocks')).toBeNull();
    expect(within(card(ncrId(5))).getByTestId('root-cause').textContent).toBe(text('qms.ncr.rootCause.label', { cause: 'Ván khuôn xê dịch' }));
    expect(within(card(ncrId(2))).getByTestId('reopen-reason').textContent).toBe(text('qms.ncr.reopenReason.label', { reason: 'Nứt lại sau đợt đổ tiếp theo', count: 1 }));
    expect(within(card(ncrId(1))).getByTestId('severity').textContent).toBe(vi_['qms.ncr.severity.major']);
    expect(within(card(ncrId(1))).queryByTestId('actions')).toBeNull();
    expect(within(card(ncrId(1))).queryByTestId('overdue')).toBeNull();
  });

  it('says when there is no non-conformance, and offers the contracts of the scope as a filter that narrows the board', async () => {
    open(world({ nonconformances: [ncr(1), ncr(2, { contract: { id: contractId(3), code: 'HD-A-003', status: 'ACTIVE' } })] }));
    await screen.findByTestId('board');
    const options = Array.from((document.getElementById('ncr-filter-contract') as HTMLSelectElement).options).map((option) => option.textContent);
    expect(options).toEqual([vi_['qms.ncr.filter.all'], 'HD-A-001 · Hợp đồng số 1', 'HD-A-002', 'HD-A-003 · Hợp đồng số 3']);
    pick('ncr-filter-contract', contractId(3));
    await waitFor(() => expect(cardsIn('OPEN')).toEqual([ncrId(2)]));
    pick('ncr-filter-contract', contractId(1));
    expect((await screen.findByTestId('no-nonconformances')).textContent).toBe(vi_['qms.ncr.none.notice']);
    pick('ncr-filter-contract', '');
    await waitFor(() => expect(cardsIn('OPEN')).toHaveLength(2));
  });

  it('reads the contract named in the address, and ignores one the scope does not hold', async () => {
    open(world({ nonconformances: [ncr(1), ncr(2, { contract: { id: contractId(3), code: 'HD-A-003', status: 'ACTIVE' } })] }), { query: `?contract=${contractId(3)}` });
    await waitFor(() => expect(cardsIn('OPEN')).toEqual([ncrId(2)]));
    cleanup();
    open(world({ nonconformances: [ncr(1)] }), { query: '?contract=00000000-0000-4000-8000-0000000000ff' });
    await waitFor(() => expect(cardsIn('OPEN')).toEqual([ncrId(1)]));
  });

  it('still lists the non-conformances for whoever may not read the register, without the filter', async () => {
    open(world({ nonconformances: [ncr(1)], failing: new Set(['get_resources_contract']) }));
    await screen.findByTestId('board');
    expect(document.getElementById('ncr-filter-contract')).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['qms.ncr.raise.action'] })).toBeNull();
  });

  it('shows the state of a read that failed and reads again on retry', async () => {
    const state = world({ failing: new Set(['get_resources_quality_nonconformance']) });
    const h = open(state);
    const retry = await screen.findByRole('button', { name: /thử lại|retry/i });
    state.failing.clear();
    fireEvent.click(retry);
    await screen.findByTestId('no-nonconformances');
    expect(h.read.mock.calls.filter((call) => call[0] === 'get_resources_quality_nonconformance').length).toBeGreaterThan(1);
  });

  it('offers a button only for what the server allows the caller and the action allows, and none in a read-only session', async () => {
    const state = world({
      nonconformances: [
        ncr(1, { allowed: allowed({ assign: true }) }),
        ncr(2, { status: 'ACTION_ASSIGNED', allowed: allowed({ respond: true }), actions: [action(1, { owner: mine }), action(2, { status: 'REJECTED', owner: mine }), action(3)] }),
        ncr(3, { status: 'ACTION_SUBMITTED', allowed: allowed({ verify: true }), actions: [action(4, { status: 'SUBMITTED', owner: mine }), action(5, { status: 'SUBMITTED' })] }),
        ncr(4, { status: 'VERIFIED', allowed: allowed({ close: true }) }),
        ncr(5, { status: 'CLOSED', allowed: allowed({ reopen: true }) }),
        ncr(6, { status: 'CLOSED' }),
      ],
    });
    open(state, { permissions: HANDLER });
    await screen.findByTestId('board');
    const buttons = (id: string): string[] =>
      within(card(id))
        .queryAllByRole('button')
        .map((button) => button.textContent as string);
    expect(buttons(ncrId(1))).toEqual([vi_['qms.ncr.assign.action']]);
    expect(buttons(ncrId(2))).toEqual([vi_['qms.ncr.evidence.action'], vi_['qms.ncr.evidence.action']]);
    expect(buttons(ncrId(3))).toEqual([vi_['qms.ncr.verify.action']]);
    expect(buttons(ncrId(4))).toEqual([vi_['qms.ncr.close.action']]);
    expect(buttons(ncrId(5))).toEqual([vi_['qms.ncr.reopen.action']]);
    expect(buttons(ncrId(6))).toEqual([]);
    cleanup();
    open(state, { permissions: HANDLER, mode: 'READ_ONLY' });
    await screen.findByTestId('board');
    expect(screen.queryByRole('button', { name: vi_['qms.ncr.raise.action'] })).toBeNull();
    expect(buttons(ncrId(1))).toEqual([]);
    cleanup();
    // UI-QMS-07: a person who only reads is offered nothing, even where the server allows the membership every step.
    open(state, { permissions: READER });
    await screen.findByTestId('board');
    for (const n of [1, 2, 3, 4, 5]) expect(buttons(ncrId(n))).toEqual([]);
  });

  describe('raising', () => {
    const fill = (values: Record<string, string>): void => {
      for (const [id, value] of Object.entries(values)) pick(id, value);
    };

    it('asks for what a non-conformance needs before it sends anything, and offers only the contracts being performed and the members who can answer', async () => {
      const h = open(world(), { permissions: RAISER });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.ncr.raise.action'] }));
      const contracts = Array.from((document.getElementById('ncr-contract') as HTMLSelectElement).options).map((option) => option.textContent);
      expect(contracts).toEqual([vi_['qms.ncr.field.contract.choose'], 'HD-A-002', 'HD-A-003 · Hợp đồng số 3']);
      await waitFor(() =>
        expect(Array.from((document.getElementById('ncr-owner') as HTMLSelectElement).options).map((option) => option.textContent)).toEqual([
          vi_['qms.ncr.field.person.choose'],
          'Giám sát Bình',
          'Nhà thầu An Phát',
        ]),
      );
      submit(vi_['qms.ncr.raise.submit']);
      expect(within(dialog()).getAllByText(vi_['qms.ncr.problem.required'])).toHaveLength(6);
      expect(commandsOf(h, 'raiseNonconformance')).toHaveLength(0);
      fill({
        'ncr-contract': contractId(2),
        'ncr-severity': 'CRITICAL',
        'ncr-source': 'INSPECTION',
        'ncr-title': 'Thiếu',
        'ncr-description': 'Đo được 30 mm',
        'ncr-owner': memberId(1),
        'ncr-due': '2020-01-01',
        'ncr-diary': 'nope',
      });
      await screen.findByLabelText(vi_['qms.ncr.field.inspection']);
      submit(vi_['qms.ncr.raise.submit']);
      expect(within(dialog()).getByText(vi_['qms.ncr.problem.past'])).toBeTruthy();
      expect(within(dialog()).getByText(vi_['qms.ncr.problem.uuid'])).toBeTruthy();
      expect(within(dialog()).getByText(vi_['qms.ncr.problem.sourceReference'])).toBeTruthy();
      expect(commandsOf(h, 'raiseNonconformance')).toHaveLength(0);
    });

    it('shows the record field of the source that asks for one and no other', async () => {
      open(world(), { permissions: RAISER });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.ncr.raise.action'] }));
      expect(document.getElementById('ncr-inspection')).toBeNull();
      expect(document.getElementById('ncr-test')).toBeNull();
      pick('ncr-source', 'INSPECTION');
      expect(document.getElementById('ncr-inspection')).not.toBeNull();
      expect(document.getElementById('ncr-test')).toBeNull();
      pick('ncr-source', 'MATERIAL_TEST');
      expect(document.getElementById('ncr-inspection')).toBeNull();
      expect(document.getElementById('ncr-test')).not.toBeNull();
      pick('ncr-source', 'AUDIT');
      expect(document.getElementById('ncr-test')).toBeNull();
    });

    it('AC-ST-QMS-006-1, UAT-AC361: sends the non-conformance with the contract of the filter, the day as the end of the day in Vietnam, once, and closes', async () => {
      const h = open(world(), { permissions: RAISER, query: `?contract=${contractId(2)}` });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.ncr.raise.action'] }));
      expect((document.getElementById('ncr-contract') as HTMLSelectElement).value).toBe(contractId(2));
      await waitFor(() => expect(Array.from((document.getElementById('ncr-owner') as HTMLSelectElement).options)).toHaveLength(3));
      fill({ 'ncr-severity': 'CRITICAL', 'ncr-source': 'SUPERVISOR_REMARK', 'ncr-title': ' Lớp bảo vệ thiếu ', 'ncr-description': 'Đo được 30 mm', 'ncr-owner': memberId(1), 'ncr-due': '2999-01-01' });
      submit(vi_['qms.ncr.raise.submit']);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(commandsOf(h, 'raiseNonconformance')).toEqual([
        expect.objectContaining({
          body: {
            contract_id: contractId(2),
            severity: 'CRITICAL',
            title: 'Lớp bảo vệ thiếu',
            description: 'Đo được 30 mm',
            source_kind: 'SUPERVISOR_REMARK',
            action_owner_id: memberId(1),
            due_at: '2999-01-01T16:59:00.000Z',
          },
        }),
      ]);
    });

    it('says, in words, what the server refused and keeps the dialog open', async () => {
      const cases: Array<[string, number, string]> = [
        ['CONTRACT_STATE_INVALID', 409, 'qms.ncr.error.contractState'],
        ['SCOPE_DENIED', 403, 'qms.ncr.error.denied'],
        ['VALIDATION_FAILED', 422, 'qms.ncr.error.validation'],
        ['SESSION_EXPIRED', 401, 'qms.ncr.error.session'],
        ['SOMETHING_ELSE', 500, 'qms.ncr.error.general'],
      ];
      for (const [code, status, key] of cases) {
        open(world(), { permissions: RAISER, command: () => Promise.reject(refusal(code, status)) });
        fireEvent.click(await screen.findByRole('button', { name: vi_['qms.ncr.raise.action'] }));
        await waitFor(() => expect(Array.from((document.getElementById('ncr-owner') as HTMLSelectElement).options)).toHaveLength(3));
        fill({
          'ncr-contract': contractId(2),
          'ncr-severity': 'MINOR',
          'ncr-source': 'SELF_REPORT',
          'ncr-title': 'Thiếu',
          'ncr-description': 'Đo được',
          'ncr-owner': memberId(1),
          'ncr-due': '2999-01-01',
        });
        submit(vi_['qms.ncr.raise.submit']);
        expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_[key as keyof typeof vi_]);
        cleanup();
      }
    });

    it('says so when the members cannot be read, and closes without sending from the cross and from the cancel button', async () => {
      const h = open(world({ failing: new Set(['get_resources_membership']) }), { permissions: RAISER });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.ncr.raise.action'] }));
      expect((await within(dialog()).findByTestId('members-failed')).textContent).toBe(vi_['qms.ncr.field.person.failed']);
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['qms.ncr.dialog.close'] }));
      expect(screen.queryByRole('dialog')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: vi_['qms.ncr.raise.action'] }));
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['qms.ncr.dialog.cancel'] }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(commandsOf(h, 'raiseNonconformance')).toHaveLength(0);
    });
  });

  describe('the actions', () => {
    it('assigns an action under the version shown, with what is to be done, who does it and the day', async () => {
      const h = open(world({ nonconformances: [ncr(1, { version: 3, allowed: allowed({ assign: true }) })] }), { permissions: RAISER });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.ncr.assign.action'] }));
      await waitFor(() => expect(Array.from((document.getElementById('ncr-action-owner') as HTMLSelectElement).options)).toHaveLength(3));
      submit(vi_['qms.ncr.assign.submit']);
      expect(within(dialog()).getAllByText(vi_['qms.ncr.problem.required'])).toHaveLength(2);
      expect(commandsOf(h, 'assignCorrectiveAction')).toHaveLength(0);
      pick('ncr-action-description', ' Đục bỏ và đổ lại ');
      pick('ncr-action-owner', memberId(2));
      pick('ncr-action-due', '2999-01-01');
      submit(vi_['qms.ncr.assign.submit']);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(commandsOf(h, 'assignCorrectiveAction')).toEqual([
        { path: { id: ncrId(1) }, body: { description: 'Đục bỏ và đổ lại', owner_membership_id: memberId(2), due_at: '2999-01-01T16:59:00.000Z' }, ifMatchVersion: 3, attempt: expect.anything() },
      ]);
    });

    it('shows a state that moved on as a refusal of the step', async () => {
      open(world({ nonconformances: [ncr(1, { allowed: allowed({ assign: true }) })] }), { permissions: RAISER, command: () => Promise.reject(refusal('NCR_STATE_INVALID', 409)) });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.ncr.assign.action'] }));
      await waitFor(() => expect(Array.from((document.getElementById('ncr-action-owner') as HTMLSelectElement).options)).toHaveLength(3));
      pick('ncr-action-description', 'Đổ lại');
      pick('ncr-action-owner', memberId(1));
      submit(vi_['qms.ncr.assign.submit']);
      expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_['qms.ncr.error.ncrState']);
    });

    it('AC-ST-QMS-006-1, UAT-AC361: answers an action with a document or a photo and a note, and says why the server refused', async () => {
      const state = world({ nonconformances: [ncr(1, { status: 'ACTION_ASSIGNED', allowed: allowed({ respond: true }), actions: [action(1, { owner: mine })] })] });
      const h = open(state, { permissions: HANDLER });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.ncr.evidence.action'] }));
      expect(within(dialog()).getByTestId('evidence-action').textContent).toContain('Đục bỏ');
      submit(vi_['qms.ncr.evidence.submit']);
      expect(within(dialog()).getByText(vi_['qms.ncr.problem.evidenceRequired'])).toBeTruthy();
      expect(within(dialog()).getByText(vi_['qms.ncr.problem.required'])).toBeTruthy();
      pick('ncr-evidence-document', 'nope');
      pick('ncr-evidence-note', 'Đã đổ lại');
      submit(vi_['qms.ncr.evidence.submit']);
      expect(within(dialog()).getByText(vi_['qms.ncr.problem.uuid'])).toBeTruthy();
      expect(commandsOf(h, 'submitCorrectiveEvidence')).toHaveLength(0);
      pick('ncr-evidence-document', DOCUMENT);
      pick('ncr-evidence-photo', PHOTO);
      cleanup();
      for (const [code, key] of [
        ['DOCUMENT_NOT_CLEAN', 'qms.ncr.error.notClean'],
        ['EVIDENCE_REQUIRED', 'qms.ncr.error.evidenceRequired'],
        ['CORRECTIVE_ACTION_STATE_INVALID', 'qms.ncr.error.actionState'],
      ] as const) {
        open(state, { permissions: HANDLER, command: () => Promise.reject(refusal(code, 422)) });
        fireEvent.click(await screen.findByRole('button', { name: vi_['qms.ncr.evidence.action'] }));
        pick('ncr-evidence-photo', PHOTO);
        pick('ncr-evidence-note', 'Đã đổ lại');
        submit(vi_['qms.ncr.evidence.submit']);
        expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_[key]);
        cleanup();
      }
      const sent = open(state, { permissions: HANDLER });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.ncr.evidence.action'] }));
      pick('ncr-evidence-document', DOCUMENT);
      pick('ncr-evidence-note', ' Đã đổ lại ');
      submit(vi_['qms.ncr.evidence.submit']);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(commandsOf(sent, 'submitCorrectiveEvidence')).toEqual([{ path: { id: actionId(1) }, body: { note: 'Đã đổ lại', evidence_document_version_id: DOCUMENT }, attempt: expect.anything() }]);
    });

    it('AC-ST-QMS-006-1, UAT-AC361: shows the evidence of an answered action, and verifies it or gives it back with a note', async () => {
      const state = world({
        nonconformances: [ncr(1, { status: 'ACTION_SUBMITTED', allowed: allowed({ verify: true }), actions: [action(1, { status: 'SUBMITTED', evidence_note: 'Đã đổ lại, đo được 52 mm' })] })],
      });
      const h = open(state, { permissions: HANDLER });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.ncr.verify.action'] }));
      expect(within(dialog()).getByTestId('verify-evidence').textContent).toBe(text('qms.ncr.verify.evidence', { note: 'Đã đổ lại, đo được 52 mm' }));
      submit(vi_['qms.ncr.verify.submit']);
      expect(within(dialog()).getAllByText(vi_['qms.ncr.problem.required'])).toHaveLength(2);
      expect(commandsOf(h, 'verifyCorrectiveAction')).toHaveLength(0);
      pick('ncr-verify-outcome', 'REJECTED');
      pick('ncr-verify-note', ' Vẫn thiếu 10 mm ');
      submit(vi_['qms.ncr.verify.submit']);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(commandsOf(h, 'verifyCorrectiveAction')).toEqual([{ path: { id: actionId(1) }, body: { outcome: 'REJECTED', verification_note: 'Vẫn thiếu 10 mm' }, attempt: expect.anything() }]);
      cleanup();
      open(state, { permissions: HANDLER, command: () => Promise.reject(refusal('SELF_APPROVAL_DENIED', 403)) });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.ncr.verify.action'] }));
      pick('ncr-verify-outcome', 'VERIFIED');
      pick('ncr-verify-note', 'Đạt');
      submit(vi_['qms.ncr.verify.submit']);
      expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_['qms.ncr.error.selfApproval']);
    });

    it('shows an answered action that has no words of evidence without the line of evidence', async () => {
      open(world({ nonconformances: [ncr(1, { status: 'ACTION_SUBMITTED', allowed: allowed({ verify: true }), actions: [action(1, { status: 'SUBMITTED' })] })] }), { permissions: HANDLER });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.ncr.verify.action'] }));
      expect(within(dialog()).queryByTestId('verify-evidence')).toBeNull();
    });
  });

  describe('closing and reopening', () => {
    it('AC-ST-QMS-006-1, UAT-AC361: closes a verified non-conformance under the version shown, with a note, and says when actions are still open', async () => {
      const state = world({ nonconformances: [ncr(1, { status: 'VERIFIED', version: 7, allowed: allowed({ close: true }) })] });
      const h = open(state, { permissions: HANDLER });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.ncr.close.action'] }));
      submit(vi_['qms.ncr.close.submit']);
      expect(within(dialog()).getByText(vi_['qms.ncr.problem.required'])).toBeTruthy();
      expect(commandsOf(h, 'closeNonconformance')).toHaveLength(0);
      pick('ncr-closure-note', ' Đã xác nhận đủ ');
      submit(vi_['qms.ncr.close.submit']);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(commandsOf(h, 'closeNonconformance')).toEqual([{ path: { id: ncrId(1) }, body: { closure_note: 'Đã xác nhận đủ' }, ifMatchVersion: 7, attempt: expect.anything() }]);
      cleanup();
      open(state, { permissions: HANDLER, command: () => Promise.reject(refusal('CORRECTIVE_ACTION_OPEN')) });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.ncr.close.action'] }));
      pick('ncr-closure-note', 'Xong');
      submit(vi_['qms.ncr.close.submit']);
      expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_['qms.ncr.error.actionsOpen']);
    });

    it('reopens a closed non-conformance under the version shown, with the reason, and says when someone changed it first', async () => {
      const state = world({ nonconformances: [ncr(1, { status: 'CLOSED', version: 9, allowed: allowed({ reopen: true }) })] });
      const h = open(state, { permissions: HANDLER });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.ncr.reopen.action'] }));
      submit(vi_['qms.ncr.reopen.submit']);
      expect(within(dialog()).getByText(vi_['qms.ncr.problem.required'])).toBeTruthy();
      pick('ncr-reopen-reason', ' Nứt lại ');
      submit(vi_['qms.ncr.reopen.submit']);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(commandsOf(h, 'reopenNonconformance')).toEqual([{ path: { id: ncrId(1) }, body: { reason: 'Nứt lại' }, ifMatchVersion: 9, attempt: expect.anything() }]);
      cleanup();
      open(state, { permissions: HANDLER, command: () => Promise.reject(refusal('VERSION_CONFLICT', 409)) });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.ncr.reopen.action'] }));
      pick('ncr-reopen-reason', 'Nứt lại');
      submit(vi_['qms.ncr.reopen.submit']);
      expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_['qms.ncr.error.versionConflict']);
    });
  });
});
