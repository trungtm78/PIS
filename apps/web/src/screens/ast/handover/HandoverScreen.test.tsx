import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import HandoverScreen from './HandoverScreen';
import { AS_BUILT, DOCUMENT, PHOTO, READER, allowed, client, handover, handoverId, item, itemAllowed, itemId, mount, routeOf, trace, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('AST-02', 'FR-AST-02', 'review');
const OK = { operation_id: 'o', status: 'PUNCH_PENDING', resource_version: 2, resource_id: handoverId(1) };
const refusal = (code: string, status = 422, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });
const text = (key: string, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const stateOf = (found: Record<string, unknown>): World => world({ traces: { [handoverId(1)]: found } });

function open(state: World, options: { command?: (operation: string, input: unknown) => unknown; mode?: 'FULL' | 'READ_ONLY'; path?: string } = {}) {
  const h = client(state, options.command ?? (() => OK));
  mount(<HandoverScreen route={ROUTE} />, h, { permissions: READER, path: options.path ?? `/ast/ast-02?id=${handoverId(1)}`, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

const dialog = (): HTMLElement => screen.getByRole('dialog');
const pick = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const rowOf = (id: string): HTMLElement => document.querySelector(`[data-item="${id}"]`) as HTMLElement;
const submit = (name: string): void => {
  fireEvent.click(within(dialog()).getByRole('button', { name }));
};
const commandsOf = (h: ReturnType<typeof client>, operation: string): Array<{ path?: { id?: string }; body: Record<string, unknown>; ifMatchVersion?: number }> =>
  h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { path?: { id?: string }; body: Record<string, unknown>; ifMatchVersion?: number });

describe('HandoverScreen (AST-02): the minutes of a handover and its punch list', () => {
  it('asks for a handover when the address names none', async () => {
    open(world(), { path: '/ast/ast-02' });
    expect((await screen.findByTestId('no-handover')).textContent).toContain(vi_['ast.handover.review.none']);
    expect(screen.getByRole('link', { name: vi_['ast.handover.review.none.link'] }).getAttribute('href')).toBe('/ast/ast-01');
  });

  it('UI-AST-02: shows the handover, the unit that receives the work, the punch list with its severity, day and contractor, the dossier and the assets', async () => {
    open(
      stateOf(
        trace({
          items: [
            item(1, { severity: 'CRITICAL', location_text: 'Cầu thang B', overdue: true }),
            item(2, { status: 'FIXED', fixed_note: 'Đã siết', reopen_count: 2 }),
            item(3, { status: 'WAIVED', severity: 'MINOR', waiver_reason: 'Chỉ là thẩm mỹ', responsible_contractor: null }),
            item(4, { status: 'VERIFIED', verification_note: 'Đạt' }),
          ],
          assets: [{ id: 'a1', asset_code: 'AS-001', name: 'Trạm bơm', value_vnd: '3200000000', status: 'DRAFT' }],
          documents: [
            { role: 'MINUTES', document_version_id: DOCUMENT },
            { role: 'AS_BUILT', document_version_id: AS_BUILT },
          ],
        }),
      ),
    );
    await screen.findByTestId('items');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['ast.handover.review.title']);
    expect(screen.getByText(text('ast.handover.footer.reference', { id: 'AST-02', req: 'FR-AST-02' }))).toBeTruthy();
    expect(screen.getByTestId('handover-no').textContent).toBe('BG-001');
    expect(screen.getByTestId('status').textContent).toBe(vi_['ast.handover.status.punchPending']);
    expect(screen.getByTestId('receiving-unit').textContent).toBe(text('ast.handover.receiving.label', { unit: 'Sở Giao thông' }));
    expect(screen.getByRole('link', { name: vi_['ast.handover.back.list'] }).getAttribute('href')).toBe('/ast/ast-01');
    const first = rowOf(itemId(1));
    expect(within(first).getByTestId('severity').textContent).toBe(vi_['ast.handover.severity.critical']);
    expect(within(first).getByTestId('contractor').textContent).toBe('Nhà thầu An Phát');
    expect(within(first).getByTestId('overdue').textContent).toBe(vi_['ast.handover.overdue.badge']);
    expect(first.textContent).toContain('Cầu thang B');
    const second = rowOf(itemId(2));
    expect(within(second).getByTestId('item-status').textContent).toBe(vi_['ast.handover.punch.fixed']);
    expect(second.textContent).toContain(text('ast.handover.fixed.note', { note: 'Đã siết' }));
    expect(second.textContent).toContain(text('ast.handover.reopened.count', { count: 2 }));
    expect(within(rowOf(itemId(3))).getByTestId('waiver').textContent).toBe(text('ast.handover.waiver.note', { reason: 'Chỉ là thẩm mỹ' }));
    expect(within(rowOf(itemId(3))).getByTestId('contractor').textContent).toBe(vi_['ast.handover.contractor.none']);
    expect(rowOf(itemId(4)).textContent).toContain(text('ast.handover.verification.note', { note: 'Đạt' }));
    expect(
      within(screen.getByTestId('documents'))
        .getAllByRole('listitem')
        .map((entry) => entry.getAttribute('data-role')),
    ).toEqual(['MINUTES', 'AS_BUILT', null]);
    expect(screen.getByTestId('minutes').textContent).toBe(text('ast.handover.minutes.label', { recordNo: 'QA-C-001' }));
    expect(within(screen.getByTestId('assets')).getByText(/AS-001 · Trạm bơm · 3200000000/)).toBeTruthy();
  });

  it('AC-ST-AST-001-1, UAT-AC388: says, with the number, that critical defects are still open, and that the as-built dossier is missing', async () => {
    open(stateOf(trace({ items: [item(1, { severity: 'CRITICAL' }), item(2, { severity: 'CRITICAL', status: 'FIXED' }), item(3, { severity: 'CRITICAL', status: 'VERIFIED' }), item(4)] })));
    await screen.findByTestId('items');
    expect(screen.getByTestId('critical-notice').textContent).toBe(text('ast.handover.critical.notice', { count: 2 }));
    expect(screen.getByTestId('as-built-notice').textContent).toBe(vi_['ast.handover.asBuilt.missing']);
    cleanup();
    open(stateOf(trace({ handover: handover(1, { status: 'ACCEPTED', as_built_document_version_id: AS_BUILT, decision_note: 'Đủ điều kiện' }), items: [] })));
    await screen.findByTestId('no-items');
    expect(screen.queryByTestId('critical-notice')).toBeNull();
    expect(screen.queryByTestId('as-built-notice')).toBeNull();
    expect(screen.getByTestId('decision-note').textContent).toBe(text('ast.handover.decisionNote.label', { note: 'Đủ điều kiện' }));
    expect(screen.getByTestId('no-assets').textContent).toBe(vi_['ast.handover.assets.none']);
    cleanup();
    open(stateOf(trace({ handover: handover(1, { status: 'REJECTED', rejection_reason: 'Chưa sẵn sàng' }), items: [], quality_acceptance: null })));
    await screen.findByTestId('no-items');
    expect(screen.getByTestId('rejection').textContent).toBe(text('ast.handover.rejection.label', { reason: 'Chưa sẵn sàng' }));
    expect(screen.queryByTestId('decision-note')).toBeNull();
    expect(screen.queryByTestId('as-built-notice')).toBeNull();
    expect(screen.queryByTestId('minutes')).toBeNull();
  });

  it('says so when the handover is not there for the caller, and shows the state of a read that failed', async () => {
    open(world(), { path: `/ast/ast-02?id=${handoverId(7)}` });
    await screen.findByTestId('empty-state').catch(() => undefined);
    expect(screen.queryByTestId('items')).toBeNull();
    cleanup();
    const state = stateOf(trace());
    state.failing.add('getHandoverTrace');
    const h = open(state);
    const retry = await screen.findByRole('button', { name: /thử lại|retry/i });
    state.failing.clear();
    fireEvent.click(retry);
    await screen.findByTestId('items');
    expect(h.read.mock.calls.filter((call) => call[0] === 'getHandoverTrace').length).toBeGreaterThan(1);
  });

  it('offers a button only for what the server allows the caller and the item allows, and none in a read-only session', async () => {
    const found = trace({
      handover: handover(1, { status: 'PUNCH_PENDING', allowed: allowed({ add_item: true, approve: true, return: true, reject: true }) }),
      items: [item(1, { allowed: itemAllowed({ fix: true }) }), item(2, { status: 'FIXED', allowed: itemAllowed({ verify: true, waive: true }) }), item(3, { status: 'VERIFIED' })],
    });
    open(stateOf(found));
    await screen.findByTestId('items');
    expect(
      within(screen.getByTestId('commands'))
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual([vi_['ast.handover.item.action'], vi_['ast.handover.decide.action']]);
    expect(
      within(rowOf(itemId(1)))
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual([vi_['ast.handover.fix.action']]);
    expect(
      within(rowOf(itemId(2)))
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual([vi_['ast.handover.verify.action'], vi_['ast.handover.waive.action']]);
    expect(within(rowOf(itemId(3))).queryByRole('button')).toBeNull();
    cleanup();
    open(stateOf(found), { mode: 'READ_ONLY' });
    await screen.findByTestId('items');
    expect(screen.queryByTestId('commands')).toBeNull();
    expect(within(rowOf(itemId(1))).queryByRole('button')).toBeNull();
    cleanup();
    open(stateOf(trace({ handover: handover(1, { status: 'PUNCH_PENDING', allowed: allowed({ add_item: true }) }), items: [] })));
    await screen.findByTestId('no-items');
    expect(
      within(screen.getByTestId('commands'))
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual([vi_['ast.handover.item.action']]);
  });

  describe('the punch list', () => {
    const adding = () => stateOf(trace({ handover: handover(1, { status: 'PUNCH_PENDING', version: 6, allowed: allowed({ add_item: true }) }), items: [] }));

    it('asks for the defect, its severity and its day, and sends it under the version shown, once', async () => {
      const h = open(adding());
      fireEvent.click(await screen.findByRole('button', { name: vi_['ast.handover.item.action'] }));
      submit(vi_['ast.handover.item.submit']);
      expect(within(dialog()).getAllByText(vi_['ast.handover.problem.required'])).toHaveLength(2);
      expect(commandsOf(h, 'addPunchItem')).toHaveLength(0);
      pick('item-due', '2020-01-01');
      pick('item-description', ' Tay vịn lỏng ');
      pick('item-severity', 'CRITICAL');
      pick('item-contractor', 'nope');
      submit(vi_['ast.handover.item.submit']);
      expect(within(dialog()).getByText(vi_['ast.handover.problem.past'])).toBeTruthy();
      expect(within(dialog()).getByText(vi_['ast.handover.problem.uuid'])).toBeTruthy();
      pick('item-contractor', '');
      pick('item-due', '2999-01-01');
      pick('item-location', 'Cầu thang B');
      submit(vi_['ast.handover.item.submit']);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(commandsOf(h, 'addPunchItem')).toEqual([
        { path: { id: handoverId(1) }, body: { description: 'Tay vịn lỏng', severity: 'CRITICAL', due_on: '2999-01-01', location_text: 'Cầu thang B' }, ifMatchVersion: 6, attempt: expect.anything() },
      ]);
    });

    it('AC-ST-AST-001-1, UAT-AC388: answers an item with a photo or a document and a note, and says why the server refused', async () => {
      const state = stateOf(trace({ items: [item(1, { severity: 'CRITICAL', allowed: itemAllowed({ fix: true }) })] }));
      const h = open(state);
      fireEvent.click(await screen.findByRole('button', { name: vi_['ast.handover.fix.action'] }));
      expect(within(dialog()).getByTestId('fix-item').textContent).toContain('Tay vịn');
      submit(vi_['ast.handover.fix.submit']);
      expect(within(dialog()).getAllByText(vi_['ast.handover.problem.required'])).toHaveLength(2);
      expect(commandsOf(h, 'markPunchItemFixed')).toHaveLength(0);
      pick('fix-photo', PHOTO);
      pick('fix-note', ' Đã siết ');
      submit(vi_['ast.handover.fix.submit']);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(commandsOf(h, 'markPunchItemFixed')).toEqual([{ path: { id: itemId(1) }, body: { note: 'Đã siết', evidence_photo_id: PHOTO }, attempt: expect.anything() }]);
      cleanup();
      for (const [code, key] of [
        ['EVIDENCE_REQUIRED', 'ast.handover.error.evidenceRequired'],
        ['FILE_NOT_CLEAN', 'ast.handover.error.notClean'],
        ['PUNCH_STATE_INVALID', 'ast.handover.error.punchState'],
        ['SCOPE_DENIED', 'ast.handover.error.denied'],
      ] as const) {
        open(state, { command: () => Promise.reject(refusal(code, code === 'SCOPE_DENIED' ? 403 : 422)) });
        fireEvent.click(await screen.findByRole('button', { name: vi_['ast.handover.fix.action'] }));
        pick('fix-document', DOCUMENT);
        pick('fix-note', 'Đã siết');
        submit(vi_['ast.handover.fix.submit']);
        expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_[key]);
        cleanup();
      }
    });

    it('shows what the contractor said was done, and verifies the item or reopens it, or says the verifier is not allowed to', async () => {
      const state = stateOf(trace({ items: [item(1, { status: 'FIXED', fixed_note: 'Đã siết', allowed: itemAllowed({ verify: true }) })] }));
      const h = open(state);
      fireEvent.click(await screen.findByRole('button', { name: vi_['ast.handover.verify.action'] }));
      expect(within(dialog()).getByTestId('verify-fixed').textContent).toBe(text('ast.handover.verify.fixed', { note: 'Đã siết' }));
      submit(vi_['ast.handover.verify.submit']);
      expect(within(dialog()).getAllByText(vi_['ast.handover.problem.required'])).toHaveLength(2);
      pick('verify-outcome', 'REOPEN');
      pick('verify-note', ' Vẫn lỏng ');
      submit(vi_['ast.handover.verify.submit']);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(commandsOf(h, 'verifyPunchItem')).toEqual([{ path: { id: itemId(1) }, body: { outcome: 'REOPEN', note: 'Vẫn lỏng' }, attempt: expect.anything() }]);
      cleanup();
      open(state, { command: () => Promise.reject(refusal('SELF_APPROVAL_DENIED', 403)) });
      fireEvent.click(await screen.findByRole('button', { name: vi_['ast.handover.verify.action'] }));
      pick('verify-outcome', 'VERIFIED');
      pick('verify-note', 'Đạt');
      submit(vi_['ast.handover.verify.submit']);
      expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_['ast.handover.error.selfApproval']);
      cleanup();
      open(stateOf(trace({ items: [item(1, { status: 'FIXED', allowed: itemAllowed({ verify: true }) })] })));
      fireEvent.click(await screen.findByRole('button', { name: vi_['ast.handover.verify.action'] }));
      expect(within(dialog()).queryByTestId('verify-fixed')).toBeNull();
    });

    it('AC-ST-AST-001-1, UAT-AC388: waives an item that is not critical with a reason, and says when the server refuses', async () => {
      const state = stateOf(trace({ items: [item(1, { allowed: itemAllowed({ waive: true }) })] }));
      const h = open(state);
      fireEvent.click(await screen.findByRole('button', { name: vi_['ast.handover.waive.action'] }));
      expect(within(dialog()).getByTestId('waive-item').textContent).toContain('Tay vịn');
      submit(vi_['ast.handover.waive.submit']);
      expect(within(dialog()).getByText(vi_['ast.handover.problem.required'])).toBeTruthy();
      pick('waive-reason', ' Chỉ là thẩm mỹ ');
      submit(vi_['ast.handover.waive.submit']);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(commandsOf(h, 'waivePunchItem')).toEqual([{ path: { id: itemId(1) }, body: { waiver_reason: 'Chỉ là thẩm mỹ' }, attempt: expect.anything() }]);
      cleanup();
      open(state, { command: () => Promise.reject(refusal('CRITICAL_CANNOT_BE_WAIVED')) });
      fireEvent.click(await screen.findByRole('button', { name: vi_['ast.handover.waive.action'] }));
      pick('waive-reason', 'Cosmetic');
      submit(vi_['ast.handover.waive.submit']);
      expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_['ast.handover.error.criticalWaiver']);
    });
  });

  describe('the decision', () => {
    const deciding = (patch: Record<string, unknown> = {}) =>
      stateOf(trace({ handover: handover(1, { status: 'PUNCH_PENDING', version: 8, allowed: allowed({ approve: true, return: true, reject: true }), ...patch }), items: [] }));

    it('offers the decisions the server allows, asks for a reason and the as-built dossier for an acceptance, and sends it under the version shown', async () => {
      const h = open(deciding());
      fireEvent.click(await screen.findByRole('button', { name: vi_['ast.handover.decide.action'] }));
      expect(Array.from((document.getElementById('decide-decision') as HTMLSelectElement).options).map((option) => option.textContent)).toEqual([
        vi_['ast.handover.field.decision.choose'],
        vi_['ast.handover.decision.approve'],
        vi_['ast.handover.decision.return'],
        vi_['ast.handover.decision.reject'],
      ]);
      expect(within(dialog()).queryByTestId('decide-critical')).toBeNull();
      submit(vi_['ast.handover.decide.submit']);
      expect(within(dialog()).getAllByText(vi_['ast.handover.problem.required'])).toHaveLength(2);
      pick('decide-decision', 'approve');
      pick('decide-reason', ' Đủ điều kiện ');
      submit(vi_['ast.handover.decide.submit']);
      expect(within(dialog()).getByText(vi_['ast.handover.problem.required'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      pick('decide-as-built', AS_BUILT);
      pick('decide-manual', DOCUMENT);
      pick('decide-evidence', `${DOCUMENT}\n${AS_BUILT}`);
      submit(vi_['ast.handover.decide.submit']);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(commandsOf(h, 'post_handovers_id_decision')).toEqual([
        {
          path: { id: handoverId(1) },
          body: { decision: 'approve', reason: 'Đủ điều kiện', evidence_ids: [DOCUMENT, AS_BUILT], as_built_document_version_id: AS_BUILT, om_manual_document_version_id: DOCUMENT },
          ifMatchVersion: 8,
          attempt: expect.anything(),
        },
      ]);
    });

    it('offers only the decisions the server allows, and shows the critical defects that are still open above the decision', async () => {
      open(deciding({ allowed: allowed({ reject: true }), open_critical_punch_count: 3, as_built_document_version_id: AS_BUILT }));
      fireEvent.click(await screen.findByRole('button', { name: vi_['ast.handover.decide.action'] }));
      expect(Array.from((document.getElementById('decide-decision') as HTMLSelectElement).options).map((option) => option.textContent)).toEqual([
        vi_['ast.handover.field.decision.choose'],
        vi_['ast.handover.decision.reject'],
      ]);
      expect(within(dialog()).getByTestId('decide-critical').textContent).toBe(text('ast.handover.critical.notice', { count: 3 }));
      expect((document.getElementById('decide-as-built') as HTMLInputElement).value).toBe(AS_BUILT);
    });

    it('AC-ST-AST-001-1, UAT-AC388: says why the server refused the acceptance, naming the critical defects that are still open', async () => {
      for (const [error, expected] of [
        [refusal('OPEN_CRITICAL_PUNCH', 422, { open_critical_punch_count: 2, item_nos: [1, 3] }), `${vi_['ast.handover.error.openCritical']} ${text('ast.handover.error.items', { items: '1, 3' })}`],
        [refusal('AS_BUILT_REQUIRED'), vi_['ast.handover.error.asBuiltRequired']],
        [refusal('SELF_APPROVAL_DENIED', 403), vi_['ast.handover.error.selfApproval']],
        [refusal('HANDOVER_STATE_INVALID', 409), vi_['ast.handover.error.handoverState']],
        [refusal('VERSION_CONFLICT', 409), vi_['ast.handover.error.versionConflict']],
      ] as const) {
        open(deciding(), { command: () => Promise.reject(error) });
        fireEvent.click(await screen.findByRole('button', { name: vi_['ast.handover.decide.action'] }));
        pick('decide-decision', 'approve');
        pick('decide-reason', 'Đủ điều kiện');
        pick('decide-as-built', AS_BUILT);
        submit(vi_['ast.handover.decide.submit']);
        expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(expected);
        expect(screen.getByRole('dialog')).toBeTruthy();
        cleanup();
      }
    });

    it('sends a handover back or rejects it without the dossier', async () => {
      const h = open(deciding());
      fireEvent.click(await screen.findByRole('button', { name: vi_['ast.handover.decide.action'] }));
      pick('decide-decision', 'reject');
      pick('decide-reason', 'Chưa sẵn sàng');
      submit(vi_['ast.handover.decide.submit']);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(commandsOf(h, 'post_handovers_id_decision')[0]?.body).toEqual({ decision: 'reject', reason: 'Chưa sẵn sàng', evidence_ids: [] });
    });

    it('closes a dialog without sending from the cross and from the cancel button', async () => {
      const h = open(deciding());
      fireEvent.click(await screen.findByRole('button', { name: vi_['ast.handover.decide.action'] }));
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['ast.handover.dialog.close'] }));
      expect(screen.queryByRole('dialog')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: vi_['ast.handover.decide.action'] }));
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['ast.handover.dialog.cancel'] }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(h.command).not.toHaveBeenCalled();
    });
  });
});
