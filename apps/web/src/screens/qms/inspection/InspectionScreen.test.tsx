import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import InspectionScreen from './InspectionScreen';
import { DIARY, READER, REQUESTER, SUPERVISOR, client, contractId, inspection, inspectionId, itemId, memberId, mount, routeOf, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('QMS-04', 'FR-QMS-04');
const OK = { operation_id: 'o', status: 'REQUESTED', resource_version: 2, resource_id: inspectionId(9) };
const refusal = (code: string, status = 422, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(state: World, options: { permissions?: readonly string[]; query?: string; command?: (operation: string, input: unknown) => unknown; mode?: 'FULL' | 'READ_ONLY' } = {}) {
  const h = client(state, options.command ?? (() => OK));
  mount(<InspectionScreen route={ROUTE} />, h, { permissions: options.permissions ?? READER, path: `/qms/qms-04${options.query ?? ''}`, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

const dialog = (): HTMLElement => screen.getByRole('dialog');
const pick = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const rows = (): string[] => Array.from(document.querySelectorAll('[data-inspection]')).map((row) => row.getAttribute('data-inspection') as string);
const row = (id: string): HTMLElement => document.querySelector(`[data-inspection="${id}"]`) as HTMLElement;
const submit = (name: string): void => {
  fireEvent.click(within(dialog()).getByRole('button', { name }));
};
const commandsOf = (h: ReturnType<typeof client>, operation: string): Array<{ path?: { id?: string }; body: Record<string, unknown>; ifMatchVersion?: number }> =>
  h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { path?: { id?: string }; body: Record<string, unknown>; ifMatchVersion?: number });

describe('InspectionScreen (QMS-04): the inspection requests', () => {
  it('UI-QMS-04: lists the inspections of the scope with the regime, the roles that sign and the days', async () => {
    open(world({ inspections: [inspection(1), inspection(2, { inspection_type: 'SAFETY', location_text: 'Trụ T1', boq_item: { id: itemId(1), business_key: 'B01', description: 'Bê tông' }, scheduled_at: '2026-10-30T02:30:00.000Z', status: 'SCHEDULED', actions: { schedule: false, record: true, cancel: true } })] }));
    await screen.findByTestId('inspections');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['qms.inspection.page.title']);
    expect(screen.getByText(text('qms.inspection.footer.reference', { id: 'QMS-04', req: 'FR-QMS-04' }))).toBeTruthy();
    expect(rows()).toEqual([inspectionId(1), inspectionId(2)]);
    const first = row(inspectionId(1));
    expect(within(first).getByTestId('no').textContent).toBe('KT-001');
    expect(within(first).getByTestId('inspection').textContent).toContain('Kiểm tra vật liệu đợt 1');
    expect(within(first).getByTestId('inspection').textContent).toContain(`HD-A-002 · ${vi_['qms.inspection.type.materialEntry']}`);
    expect(within(first).getByTestId('regime').textContent).toContain('Nghị định 06/2021/NĐ-CP');
    expect(within(first).getByTestId('roles').textContent).toBe(text('qms.inspection.roles.label', { roles: `${vi_['qms.inspection.role.contractor']}, ${vi_['qms.inspection.role.supervisor']}, ${vi_['qms.inspection.role.owner']}` }));
    expect(within(first).queryByTestId('regime-warning')).toBeNull();
    expect(within(first).getByTestId('status').textContent).toBe(vi_['qms.inspection.status.requested']);
    const second = row(inspectionId(2));
    expect(within(second).getByTestId('inspection').textContent).toContain('B01 · Trụ T1');
    expect(within(second).getByTestId('scheduled').textContent).toContain('30');
    expect(within(second).getByTestId('status').textContent).toBe(vi_['qms.inspection.status.scheduled']);
  });

  it('AC-ST-QMS-004-1, UAT-AC363: warns, with the number of the confirmation, while the rule data of the regime waits to be confirmed', async () => {
    open(
      world({
        inspections: [
          inspection(1, { regime: { version_id: null, label: 'Nghị định thay thế', legal_basis: null, awaiting_confirmation: true, cxn: 'CXN-07' } }),
          inspection(2, { regime: { version_id: null, label: null, legal_basis: null, awaiting_confirmation: false, cxn: null } }),
        ],
      }),
    );
    await screen.findByTestId('inspections');
    const warning = within(row(inspectionId(1))).getByTestId('regime-warning');
    expect(warning.textContent).toBe(text('qms.inspection.regime.unconfirmed', { cxn: 'CXN-07' }));
    expect(warning.textContent).toContain('CXN-07');
    expect(within(row(inspectionId(2))).queryByTestId('regime-warning')).toBeNull();
    expect(within(row(inspectionId(2))).getByTestId('regime').textContent).toContain(vi_['qms.inspection.regime.unknown']);
  });

  it('says when there is no inspection, and offers the contracts of the scope as a filter that narrows the list', async () => {
    open(world({ inspections: [inspection(1), inspection(2, { contract: { id: contractId(3), code: 'HD-A-003', status: 'ACTIVE' } })] }));
    await screen.findByTestId('inspections');
    const options = Array.from((document.getElementById('inspections-contract') as HTMLSelectElement).options).map((option) => option.textContent);
    expect(options).toEqual([vi_['qms.inspection.filter.all'], 'HD-A-001 · Hợp đồng số 1', 'HD-A-002', 'HD-A-003 · Hợp đồng số 3']);
    pick('inspections-contract', contractId(3));
    await waitFor(() => expect(rows()).toEqual([inspectionId(2)]));
    pick('inspections-contract', contractId(1));
    expect((await screen.findByTestId('no-inspections')).textContent).toBe(vi_['qms.inspection.none.notice']);
    pick('inspections-contract', '');
    await waitFor(() => expect(rows()).toHaveLength(2));
  });

  it('reads the contract named in the address, and ignores one the scope does not hold', async () => {
    open(world({ inspections: [inspection(1), inspection(2, { contract: { id: contractId(3), code: 'HD-A-003', status: 'ACTIVE' } })] }), { query: `?contract=${contractId(3)}` });
    await waitFor(() => expect(rows()).toEqual([inspectionId(2)]));
    cleanup();
    open(world({ inspections: [inspection(1)] }), { query: '?contract=00000000-0000-4000-8000-0000000000ff' });
    await waitFor(() => expect(rows()).toEqual([inspectionId(1)]));
  });

  it('still lists the inspections for whoever may not read the register, without the filter', async () => {
    open(world({ inspections: [inspection(1)], failing: new Set(['get_resources_contract']) }));
    await screen.findByTestId('inspections');
    expect(document.getElementById('inspections-contract')).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['qms.inspection.request.action'] })).toBeNull();
  });

  it('shows the state of a read that failed and reads again on retry', async () => {
    const state = world({ failing: new Set(['listInspections']) });
    const h = open(state);
    const retry = await screen.findByRole('button', { name: /thử lại|retry/i });
    state.failing.clear();
    fireEvent.click(retry);
    await screen.findByTestId('no-inspections');
    expect(h.read.mock.calls.filter((call) => call[0] === 'listInspections').length).toBeGreaterThan(1);
  });

  it('offers a button only for what the inspection and the caller allow, and none in a read-only session', async () => {
    const state = world({
      inspections: [
        inspection(1),
        inspection(2, { status: 'SCHEDULED', actions: { schedule: false, record: true, cancel: true } }),
        inspection(3, { status: 'RESULT_RECORDED', result: 'PASS', actions: { schedule: false, record: false, cancel: false } }),
      ],
    });
    open(state, { permissions: SUPERVISOR });
    await screen.findByTestId('inspections');
    expect(within(row(inspectionId(1))).getAllByRole('button').map((button) => button.textContent)).toEqual([vi_['qms.inspection.schedule.action'], vi_['qms.inspection.cancel.action']]);
    expect(within(row(inspectionId(2))).getAllByRole('button').map((button) => button.textContent)).toEqual([vi_['qms.inspection.record.action'], vi_['qms.inspection.cancel.action']]);
    expect(within(row(inspectionId(3))).queryByRole('button')).toBeNull();
    cleanup();
    open(state, { permissions: SUPERVISOR, mode: 'READ_ONLY' });
    await screen.findByTestId('inspections');
    expect(screen.queryByRole('button', { name: vi_['qms.inspection.request.action'] })).toBeNull();
    expect(within(row(inspectionId(1))).queryByRole('button')).toBeNull();
  });

  describe('asking for an inspection', () => {
    it('asks for the contract, the kind and the title before it sends anything, and offers only the contracts being performed', async () => {
      const h = open(world(), { permissions: REQUESTER });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.inspection.request.action'] }));
      const options = Array.from((document.getElementById('inspection-contract') as HTMLSelectElement).options).map((option) => option.textContent);
      expect(options).toEqual([vi_['qms.inspection.field.contract.choose'], 'HD-A-002', 'HD-A-003 · Hợp đồng số 3']);
      submit(vi_['qms.inspection.request.submit']);
      expect(within(dialog()).getAllByText(vi_['qms.inspection.problem.required'])).toHaveLength(3);
      expect(commandsOf(h, 'requestInspection')).toHaveLength(0);
      pick('inspection-contract', contractId(2));
      pick('inspection-type', 'SAFETY');
      pick('inspection-title', 'Kiểm tra an toàn');
      pick('inspection-day', '');
      pick('inspection-diary', 'not-an-id');
      submit(vi_['qms.inspection.request.submit']);
      expect(within(dialog()).getAllByText(vi_['qms.inspection.problem.required'])).toHaveLength(1);
      expect(within(dialog()).getByText(vi_['qms.inspection.problem.uuid'])).toBeTruthy();
      expect(commandsOf(h, 'requestInspection')).toHaveLength(0);
    });

    it('sends the request with the item the BOQ prices, once, and closes', async () => {
      const h = open(world({ inspections: [] }), { permissions: REQUESTER, query: `?contract=${contractId(2)}` });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.inspection.request.action'] }));
      // The contract on screen is the one asked for; the items are those the BOQ prices, each once.
      expect((document.getElementById('inspection-contract') as HTMLSelectElement).value).toBe(contractId(2));
      await waitFor(() => expect(Array.from((document.getElementById('inspection-item') as HTMLSelectElement).options)).toHaveLength(3));
      const items = Array.from((document.getElementById('inspection-item') as HTMLSelectElement).options).map((option) => option.textContent);
      expect(items).toEqual([vi_['qms.inspection.field.item.none'], 'B01 · Hạng mục 1', 'B04 · Hạng mục 4']);
      pick('inspection-item', itemId(1));
      pick('inspection-type', 'CONCEALED_WORK');
      pick('inspection-title', ' Cốt thép móng ');
      pick('inspection-location', 'Trụ T1');
      pick('inspection-day', '2026-10-30');
      pick('inspection-diary', DIARY);
      submit(vi_['qms.inspection.request.submit']);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(commandsOf(h, 'requestInspection')).toEqual([
        expect.objectContaining({ body: { contract_id: contractId(2), boq_item_id: itemId(1), inspection_type: 'CONCEALED_WORK', title: 'Cốt thép móng', location_text: 'Trụ T1', requested_for: '2026-10-30', site_diary_id: DIARY } }),
      ]);
    });

    it('forgets the item when the contract changes, and asks without one for whoever may not read the BOQ', async () => {
      const h = open(world({ failing: new Set(['get_resources_boq_line']) }), { permissions: REQUESTER });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.inspection.request.action'] }));
      pick('inspection-contract', contractId(3));
      expect(Array.from((document.getElementById('inspection-item') as HTMLSelectElement).options).map((option) => option.textContent)).toEqual([vi_['qms.inspection.field.item.none']]);
      pick('inspection-type', 'SAFETY');
      pick('inspection-title', 'An toàn');
      submit(vi_['qms.inspection.request.submit']);
      await waitFor(() => expect(commandsOf(h, 'requestInspection')).toHaveLength(1));
      expect(commandsOf(h, 'requestInspection')[0]?.body).not.toHaveProperty('boq_item_id');
    });

    it('AC-ST-QMS-004-2, UAT-AC369: says that the permits of the start of construction are missing and keeps the dialog open', async () => {
      const h = open(world(), { permissions: REQUESTER, command: () => Promise.reject(refusal('PERMIT_GATE_BLOCKED')) });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.inspection.request.action'] }));
      pick('inspection-contract', contractId(2));
      pick('inspection-type', 'MATERIAL_ENTRY');
      pick('inspection-title', 'Vật liệu');
      submit(vi_['qms.inspection.request.submit']);
      expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_['qms.inspection.error.permitGate']);
      expect(commandsOf(h, 'requestInspection')).toHaveLength(1);
    });

    it('says what the server refused for a request, in words', async () => {
      const cases: Array<[string, string]> = [
        ['CONTRACT_STATE_INVALID', 'qms.inspection.error.contractState'],
        ['INSPECTION_DUPLICATE', 'qms.inspection.error.duplicate'],
        ['REGIME_NOT_EFFECTIVE', 'qms.inspection.error.regime'],
        ['SCOPE_DENIED', 'qms.inspection.error.denied'],
      ];
      for (const [code, key] of cases) {
        open(world(), { permissions: REQUESTER, command: () => Promise.reject(refusal(code, code === 'SCOPE_DENIED' ? 403 : 409)) });
        fireEvent.click(await screen.findByRole('button', { name: vi_['qms.inspection.request.action'] }));
        pick('inspection-contract', contractId(2));
        pick('inspection-type', 'SAFETY');
        pick('inspection-title', 'An toàn');
        submit(vi_['qms.inspection.request.submit']);
        expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_[key as keyof typeof vi_]);
        cleanup();
      }
    });

    it('closes without sending from the cross and from the cancel button', async () => {
      const h = open(world(), { permissions: REQUESTER });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.inspection.request.action'] }));
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['qms.inspection.dialog.close'] }));
      expect(screen.queryByRole('dialog')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: vi_['qms.inspection.request.action'] }));
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['qms.inspection.dialog.cancel'] }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(commandsOf(h, 'requestInspection')).toHaveLength(0);
    });
  });

  describe('scheduling', () => {
    const requested = () => world({ inspections: [inspection(1, { version: 4 })] });

    it('asks for a time that has not passed and at least one participant, and offers the active members only', async () => {
      const h = open(requested(), { permissions: SUPERVISOR });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.inspection.schedule.action'] }));
      await within(dialog()).findByLabelText('Giám sát Bình');
      expect(within(dialog()).queryByLabelText('Đã nghỉ')).toBeNull();
      submit(vi_['qms.inspection.schedule.submit']);
      expect(within(dialog()).getByText(vi_['qms.inspection.problem.required'])).toBeTruthy();
      expect(within(dialog()).getByText(vi_['qms.inspection.problem.noParticipant'])).toBeTruthy();
      pick('inspection-at', '2020-01-01T09:00');
      submit(vi_['qms.inspection.schedule.submit']);
      expect(within(dialog()).getByText(vi_['qms.inspection.problem.past'])).toBeTruthy();
      expect(commandsOf(h, 'scheduleInspection')).toHaveLength(0);
    });

    it('sends the time as an instant of the Vietnam day with the people ticked, under the version shown, and closes', async () => {
      const h = open(requested(), { permissions: SUPERVISOR });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.inspection.schedule.action'] }));
      const first = await within(dialog()).findByLabelText('Giám sát Bình');
      fireEvent.click(first);
      fireEvent.click(within(dialog()).getByLabelText('Chủ đầu tư Cường'));
      fireEvent.click(first);
      pick('inspection-at', '2999-01-01T09:30');
      submit(vi_['qms.inspection.schedule.submit']);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(commandsOf(h, 'scheduleInspection')).toEqual([{ path: { id: inspectionId(1) }, body: { scheduled_at: '2999-01-01T02:30:00.000Z', participant_membership_ids: [memberId(2)] }, ifMatchVersion: 4, attempt: expect.anything() }]);
    });

    it('says so when the members cannot be read, and shows the refusal of a state that moved on', async () => {
      const state = requested();
      state.failing.add('get_resources_membership');
      open(state, { permissions: SUPERVISOR, command: () => Promise.reject(refusal('INSPECTION_STATE_INVALID', 409)) });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.inspection.schedule.action'] }));
      expect((await within(dialog()).findByTestId('members-failed')).textContent).toBe(vi_['qms.inspection.field.participants.failed']);
      cleanup();
      open(requested(), { permissions: SUPERVISOR, command: () => Promise.reject(refusal('INSPECTION_STATE_INVALID', 409)) });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.inspection.schedule.action'] }));
      fireEvent.click(await within(dialog()).findByLabelText('Giám sát Bình'));
      pick('inspection-at', '2999-01-01T09:30');
      submit(vi_['qms.inspection.schedule.submit']);
      expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_['qms.inspection.error.inspectionState']);
    });
  });

  describe('recording the result', () => {
    const scheduled = () => world({ inspections: [inspection(1, { status: 'SCHEDULED', version: 5, actions: { schedule: false, record: true, cancel: true } })] });
    const answer = (index: number, outcome: string, note?: string): void => {
      pick(`inspection-answer-${index}`, outcome);
      if (note !== undefined) pick(`inspection-answer-note-${index}`, note);
    };

    it('shows the checklist the inspection was given and asks for an answer to every item, a result and a remark', async () => {
      const h = open(scheduled(), { permissions: SUPERVISOR });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.inspection.record.action'] }));
      for (const label of ['Hồ sơ vật liệu đầy đủ', 'Mẫu thử đạt yêu cầu', 'Biện pháp an toàn tại vị trí']) expect(within(dialog()).getByText(label)).toBeTruthy();
      submit(vi_['qms.inspection.record.submit']);
      expect(within(dialog()).getAllByText(vi_['qms.inspection.problem.unanswered'])).toHaveLength(3);
      expect(within(dialog()).getAllByText(vi_['qms.inspection.problem.required'])).toHaveLength(2);
      expect(commandsOf(h, 'recordInspectionResult')).toHaveLength(0);
    });

    it('does not send a result the answers contradict', async () => {
      const h = open(scheduled(), { permissions: SUPERVISOR });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.inspection.record.action'] }));
      answer(0, 'PASS');
      answer(1, 'FAIL');
      answer(2, 'NA');
      pick('inspection-result', 'PASS');
      pick('inspection-result-note', 'Nhận xét');
      submit(vi_['qms.inspection.record.submit']);
      expect(within(dialog()).getByTestId('contradiction').textContent).toBe(vi_['qms.inspection.problem.passWithFailed']);
      pick('inspection-result', 'CONDITIONAL');
      submit(vi_['qms.inspection.record.submit']);
      expect(within(dialog()).getByText(vi_['qms.inspection.problem.conditionUnstated'])).toBeTruthy();
      expect(commandsOf(h, 'recordInspectionResult')).toHaveLength(0);
    });

    it('AC-ST-QMS-004-3, UAT-AC360: records a failed result with its answers under the version shown, and closes', async () => {
      const h = open(scheduled(), { permissions: SUPERVISOR });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.inspection.record.action'] }));
      answer(0, 'PASS');
      answer(1, 'FAIL', 'Mẫu số 2 không đạt');
      answer(2, 'NA');
      pick('inspection-result', 'FAIL');
      pick('inspection-result-note', 'Không đạt');
      submit(vi_['qms.inspection.record.submit']);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(commandsOf(h, 'recordInspectionResult')).toEqual([
        {
          path: { id: inspectionId(1) },
          body: { result: 'FAIL', result_note: 'Không đạt', checklist: [{ code: 'DOC', outcome: 'PASS' }, { code: 'SAMPLE', outcome: 'FAIL', note: 'Mẫu số 2 không đạt' }, { code: 'SAFE', outcome: 'NA' }] },
          ifMatchVersion: 5,
          attempt: expect.anything(),
        },
      ]);
    });

    it('says what the server found wrong with the checklist', async () => {
      const cases: Array<[string, string]> = [
        ['ITEMS_MISSING', 'qms.inspection.error.checklistMissing'],
        ['RESULT_CONTRADICTS', 'qms.inspection.error.checklistContradicts'],
        ['CONDITION_UNSTATED', 'qms.inspection.error.checklistCondition'],
        ['ANSWER_UNKNOWN', 'qms.inspection.error.checklistInvalid'],
      ];
      for (const [reason, key] of cases) {
        open(scheduled(), { permissions: SUPERVISOR, command: () => Promise.reject(refusal('CHECKLIST_INCOMPLETE', 422, { reason })) });
        fireEvent.click(await screen.findByRole('button', { name: vi_['qms.inspection.record.action'] }));
        answer(0, 'PASS');
        answer(1, 'PASS');
        answer(2, 'PASS');
        pick('inspection-result', 'PASS');
        pick('inspection-result-note', 'Đạt');
        submit(vi_['qms.inspection.record.submit']);
        expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_[key as keyof typeof vi_]);
        cleanup();
      }
    });

    it('shows the answers of a recorded inspection and keeps it as it is, without a button', async () => {
      open(
        world({
          inspections: [
            inspection(1, {
              status: 'RESULT_RECORDED',
              result: 'FAIL',
              result_note: 'Mẫu không đạt',
              checklist: [
                { code: 'DOC', label: 'Hồ sơ vật liệu đầy đủ', outcome: 'PASS' },
                { code: 'SAMPLE', label: 'Mẫu thử đạt yêu cầu', outcome: 'FAIL', note: 'Mẫu số 2' },
                { code: 'SAFE', label: 'Biện pháp an toàn tại vị trí', outcome: 'NA' },
              ],
              actions: { schedule: false, record: false, cancel: false },
            }),
          ],
        }),
        { permissions: SUPERVISOR },
      );
      await screen.findByTestId('inspections');
      const line = row(inspectionId(1));
      expect(within(line).getByTestId('status').textContent).toBe(vi_['qms.inspection.status.resultRecorded']);
      expect(within(line).getByTestId('result').textContent).toBe(vi_['qms.inspection.result.fail']);
      expect(within(line).getByText(text('qms.inspection.checklist.summary', { count: 3 }))).toBeTruthy();
      expect(within(line).getByText(/Mẫu thử đạt yêu cầu — Không đạt \(Mẫu số 2\)/)).toBeTruthy();
      expect(within(line).getByText('Mẫu không đạt')).toBeTruthy();
      expect(within(line).queryByRole('button')).toBeNull();
    });
  });

  describe('cancelling', () => {
    it('asks for a reason, sends it under the version shown and closes', async () => {
      const h = open(world({ inspections: [inspection(1, { version: 3 })] }), { permissions: SUPERVISOR });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.inspection.cancel.action'] }));
      submit(vi_['qms.inspection.cancel.submit']);
      expect(within(dialog()).getByText(vi_['qms.inspection.problem.required'])).toBeTruthy();
      expect(commandsOf(h, 'cancelInspection')).toHaveLength(0);
      pick('inspection-cancel-reason', ' Nhầm hợp đồng ');
      submit(vi_['qms.inspection.cancel.submit']);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(commandsOf(h, 'cancelInspection')).toEqual([{ path: { id: inspectionId(1) }, body: { reason: 'Nhầm hợp đồng' }, ifMatchVersion: 3, attempt: expect.anything() }]);
    });

    it('shows a cancelled inspection with its reason, and the refusal of a version that moved on', async () => {
      open(world({ inspections: [inspection(1, { status: 'CANCELLED', cancel_reason: 'Nhầm hợp đồng', actions: { schedule: false, record: false, cancel: false } })] }), { permissions: SUPERVISOR });
      expect((await screen.findByTestId('cancel-reason')).textContent).toBe(text('qms.inspection.cancelled.reason', { reason: 'Nhầm hợp đồng' }));
      cleanup();
      open(world({ inspections: [inspection(1)] }), { permissions: SUPERVISOR, command: () => Promise.reject(refusal('VERSION_CONFLICT', 409)) });
      fireEvent.click(await screen.findByRole('button', { name: vi_['qms.inspection.cancel.action'] }));
      pick('inspection-cancel-reason', 'Nhầm');
      submit(vi_['qms.inspection.cancel.submit']);
      expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_['qms.inspection.error.versionConflict']);
    });
  });
});
