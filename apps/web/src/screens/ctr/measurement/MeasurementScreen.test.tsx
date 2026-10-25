import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import MeasurementScreen from './MeasurementScreen';
import { PERIOD_1, PERIOD_2, UUID_A, active, client, contractId, itemId, lines, measurement, measurementId, mount, routeOf, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('CTR-10', 'FR-CTR-10');
const PATH = `/ctr/ctr-10?contract=${contractId(1)}`;
const OK = { operation_id: 'o', status: 'DRAFT', resource_version: 1, resource_id: measurementId(9) };
const RECORDER = ['measurement.record', 'measurement.submit', 'measurement.read'];
const problem = (code: string, status = 422, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(state: World, options: { command?: (operation: string, input: unknown) => unknown; mode?: 'FULL' | 'READ_ONLY'; path?: string; permissions?: readonly string[] | undefined } = {}) {
  const h = client(state, options.command ?? (() => OK));
  mount(<MeasurementScreen route={ROUTE} />, h, { permissions: 'permissions' in options ? options.permissions : RECORDER, path: options.path ?? PATH, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

const type = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const press = (name: string): void => {
  fireEvent.click(screen.getByRole('button', { name }));
};
const rowOf = (key: string): HTMLElement => document.querySelector(`tr[data-item="${key}"]`) as HTMLElement;

/** B01 with 3,500 m3 approved and 1,000 m3 waiting (4,500 left of 8,000). */
const recorded = () => [measurement(1, { status: 'APPROVED' }), measurement(2, { status: 'SUBMITTED', period: { id: PERIOD_2, code: '2026-02' }, quantity_period: '1000.000000', quantity_cumulative: '3500.000000', reference_no: 'NK-002', version: 2 })];

describe('MeasurementScreen (CTR-10): record the work done', () => {
  it('asks for a contract when the address names none', async () => {
    open(world(), { path: '/ctr/ctr-10' });
    expect((await screen.findByTestId('no-contract')).textContent).toBe(vi_['ctr.measurement.none.notice']);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['ctr.measurement.title']);
    expect(screen.getByText(text('ctr.measurement.footer', { id: 'CTR-10', req: 'FR-CTR-10' }))).toBeTruthy();
  });

  it('UI-CTR-10: has a row for each item of the revision in force with its quantity, what was approved and what is left', async () => {
    open(world({ measurements: recorded() }));
    await screen.findByTestId('items');
    expect(screen.getByTestId('contract-code').textContent).toBe('HD-A-001');
    expect(screen.getByTestId('revision-no').textContent).toContain(text('ctr.measurement.contract.revision', { revision: 1 }));
    const first = within(rowOf('B01')).getAllByRole('cell').map((cell) => cell.textContent);
    expect(first.slice(0, 4)).toEqual(['M3', '8.000', '3.500', '4.500']);
    // An item with nothing recorded has all its quantity left.
    expect(within(rowOf('B02')).getAllByRole('cell').map((cell) => cell.textContent).slice(0, 4)).toEqual(['M3', '500', '0', '500']);
    expect(within(rowOf('B01')).getByRole('button', { name: vi_['ctr.measurement.action.record'] })).toBeTruthy();
  });

  it('lists the quantities recorded, oldest first, with their cumulative, their revision and their status', async () => {
    open(world({ measurements: recorded() }));
    const table = await screen.findByTestId('measurements');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => row.getAttribute('data-status'))).toEqual(['APPROVED', 'SUBMITTED']);
    expect(within(rows[0] as HTMLElement).getAllByRole('cell').map((cell) => cell.textContent).slice(0, 6)).toEqual(['B01 · Hạng mục 1', '3.500 M3', '3.500', '1', 'NK-001', vi_['ctr.measurement.status.approved']]);
    expect(within(rows[1] as HTMLElement).getByTestId('measurement-status').textContent).toBe(vi_['ctr.measurement.status.submitted']);
  });

  it('shows a rejected quantity as a warning and says when nothing is recorded', async () => {
    open(world({ measurements: [measurement(1, { status: 'REJECTED' })] }));
    expect((await screen.findByTestId('measurement-status')).className).toContain('warning');
    cleanup();
    open(world());
    expect((await screen.findByTestId('no-measurements')).textContent).toBe(vi_['ctr.measurement.list.empty']);
  });

  it('offers no way to record to a caller without the right, in a read-only session, on a contract not being performed, or without the stable item', async () => {
    open(world(), { permissions: ['measurement.read'] });
    await screen.findByTestId('items');
    expect(screen.queryByRole('button', { name: vi_['ctr.measurement.action.record'] })).toBeNull();
    cleanup();
    open(world(), { mode: 'READ_ONLY' });
    await screen.findByTestId('items');
    expect(screen.queryByRole('button', { name: vi_['ctr.measurement.action.record'] })).toBeNull();
    cleanup();
    open(world({ details: [active({ status: 'SUSPENDED' })] }));
    await screen.findByTestId('items');
    expect(screen.queryByRole('button', { name: vi_['ctr.measurement.action.record'] })).toBeNull();
    expect(screen.getByTestId('not-active').textContent).toBe(vi_['ctr.measurement.contract.notActive']);
    cleanup();
    // A guest who was not given the right to record is not shown the stable item.
    open(world({ boqLines: lines().map((entry) => ({ ...entry, boq_item_id: undefined })) }));
    await screen.findByTestId('items');
    expect(screen.queryByRole('button', { name: vi_['ctr.measurement.action.record'] })).toBeNull();
  });

  it('still lists the quantities for a caller who may not read the BOQ, and says the items are not shown', async () => {
    open(world({ measurements: recorded(), failing: new Set(['get_resources_boq_line']) }));
    expect((await screen.findByTestId('no-items')).textContent).toBe(vi_['ctr.measurement.items.denied']);
    expect(within(screen.getByTestId('measurements')).getAllByRole('row')).toHaveLength(3);
    expect(screen.queryByTestId('items')).toBeNull();
  });

  it('says there is nothing to measure when the contract has no revision in force', async () => {
    open(world({ details: [active({ revisions: [] })] }));
    expect((await screen.findByTestId('no-items')).textContent).toBe(vi_['ctr.measurement.items.empty']);
  });

  describe('recording', () => {
    const fill = (overrides: Record<string, string> = {}): void => {
      const values = { 'record-period': PERIOD_1, 'record-quantity': '3500.5', 'record-reference': ' NK-010 ', 'record-evidence': UUID_A, ...overrides };
      for (const [id, value] of Object.entries(values)) type(id, value);
    };

    it('AC-ST-CTR-008-1, UAT-AC311: asks for every field, shows what is left, and sends the quantity as it was typed with the revision in force', async () => {
      const h = open(world({ measurements: recorded() }));
      await screen.findByTestId('items');
      fireEvent.click(within(rowOf('B01')).getByRole('button', { name: vi_['ctr.measurement.action.record'] }));
      expect((await screen.findByTestId('record-left')).textContent).toBe(text('ctr.measurement.record.left', { remaining: '4.500', unit: 'M3' }));
      press(vi_['ctr.measurement.record.submit']);
      expect(screen.getAllByText(vi_['ctr.measurement.problem.required'])).toHaveLength(3);
      expect(h.command).not.toHaveBeenCalled();
      fill({ 'record-quantity': '1.0000001', 'record-evidence': 'nope' });
      press(vi_['ctr.measurement.record.submit']);
      expect(screen.getByText(vi_['ctr.measurement.problem.quantity'])).toBeTruthy();
      expect(screen.getByText(vi_['ctr.measurement.problem.uuid'])).toBeTruthy();
      type('record-quantity', '0');
      press(vi_['ctr.measurement.record.submit']);
      expect(screen.getByText(vi_['ctr.measurement.problem.positive'])).toBeTruthy();
      fill({ 'record-evidence': `${UUID_A}\n${UUID_A.toUpperCase()}` });
      press(vi_['ctr.measurement.record.submit']);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith(
        'recordMeasurement',
        expect.objectContaining({
          path: { id: contractId(1) },
          body: {
            contract_revision_id: '00000000-0000-4000-8000-001100000001',
            boq_item_id: itemId(1),
            period_id: PERIOD_1,
            quantity_period: '3500.5',
            reference_no: 'NK-010',
            evidence_refs: [{ document_version_id: UUID_A }, { document_version_id: UUID_A }],
          },
        }),
      );
      expect((await screen.findByTestId('done')).textContent).toBe(vi_['ctr.measurement.done.recorded']);
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('AC-ST-CTR-008-2, UAT-AC312: says in words that the total is above the item and what is left, and keeps the dialog open', async () => {
      const h = open(world({ measurements: recorded() }), { command: () => problem('QUANTITY_EXCEEDS_BOQ', 422, { remaining_quantity: '4500.000000' }) });
      await screen.findByTestId('items');
      fireEvent.click(within(rowOf('B01')).getByRole('button', { name: vi_['ctr.measurement.action.record'] }));
      await screen.findByTestId('record-left');
      fill({ 'record-quantity': '4500.000001' });
      press(vi_['ctr.measurement.record.submit']);
      expect((await screen.findByTestId('refusal')).textContent).toBe(text('ctr.measurement.error.exceedsLeft', { remaining: '4.500' }));
      expect(h.command).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('dialog')).toBeTruthy();
    });

    it('asks why a number of record is used again when the server says it is, and sends the reason with it', async () => {
      let calls = 0;
      const h = open(world(), {
        command: () => {
          calls += 1;
          return calls === 1 ? problem('MEASUREMENT_REFERENCE_DUPLICATE', 409) : OK;
        },
      });
      await screen.findByTestId('items');
      fireEvent.click(within(rowOf('B01')).getByRole('button', { name: vi_['ctr.measurement.action.record'] }));
      await screen.findByTestId('record-left');
      expect(document.getElementById('record-override')).toBeNull();
      fill();
      press(vi_['ctr.measurement.record.submit']);
      expect((await screen.findByTestId('refusal')).textContent).toBe(vi_['ctr.measurement.error.duplicateReference']);
      type('record-override', ' One form covers two periods. ');
      press(vi_['ctr.measurement.record.submit']);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
      expect(h.command).toHaveBeenLastCalledWith('recordMeasurement', expect.objectContaining({ body: expect.objectContaining({ duplicate_override_reason: 'One form covers two periods.' }) }));
    });

    it('words the other refusals of the server', async () => {
      const refusals: Array<[string, number, string]> = [
        ['CUMULATIVE_DECREASE_WITHOUT_CORRECTION', 422, 'ctr.measurement.error.decrease'],
        ['REVISION_NOT_EFFECTIVE', 422, 'ctr.measurement.error.revisionNotEffective'],
        ['PERMIT_GATE_BLOCKED', 422, 'ctr.measurement.error.permitGate'],
        ['QUANTITY_EXCEEDS_BOQ', 422, 'ctr.measurement.error.exceeds'],
        ['MEASUREMENT_STATE_INVALID', 409, 'ctr.measurement.error.measurementState'],
        ['CONTRACT_STATE_INVALID', 409, 'ctr.change.error.contractState'],
      ];
      for (const [code, status, key] of refusals) {
        cleanup();
        open(world(), { command: () => problem(code, status) });
        await screen.findByTestId('items');
        fireEvent.click(within(rowOf('B01')).getByRole('button', { name: vi_['ctr.measurement.action.record'] }));
        await screen.findByTestId('record-left');
        fill();
        press(vi_['ctr.measurement.record.submit']);
        expect((await screen.findByTestId('refusal')).textContent).toBe((vi_ as Record<string, string>)[key]);
      }
      cleanup();
      open(world(), { command: () => problem('MEASUREMENT_STATE_INVALID', 409, { reason: 'PERIOD_ALREADY_MEASURED' }) });
      await screen.findByTestId('items');
      fireEvent.click(within(rowOf('B01')).getByRole('button', { name: vi_['ctr.measurement.action.record'] }));
      await screen.findByTestId('record-left');
      fill();
      press(vi_['ctr.measurement.record.submit']);
      expect((await screen.findByTestId('refusal')).textContent).toBe(vi_['ctr.measurement.error.periodTaken']);
    });

    it('lets a caller who cannot read the periods type the identifier of the period, and closes the dialog on cancel', async () => {
      const h = open(world({ failing: new Set(['get_resources_reporting_period']) }));
      await screen.findByTestId('items');
      fireEvent.click(within(rowOf('B01')).getByRole('button', { name: vi_['ctr.measurement.action.record'] }));
      await screen.findByTestId('record-left');
      await waitFor(() => expect((document.getElementById('record-period') as HTMLElement).tagName).toBe('INPUT'));
      fill();
      press(vi_['ctr.measurement.record.submit']);
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('recordMeasurement', expect.objectContaining({ body: expect.objectContaining({ period_id: PERIOD_1 }) })));
      cleanup();
      open(world());
      await screen.findByTestId('items');
      fireEvent.click(within(rowOf('B01')).getByRole('button', { name: vi_['ctr.measurement.action.record'] }));
      await screen.findByTestId('record-left');
      press(vi_['ctr.measurement.dialog.cancel']);
      expect(screen.queryByRole('dialog')).toBeNull();
      fireEvent.click(within(rowOf('B01')).getByRole('button', { name: vi_['ctr.measurement.action.record'] }));
      await screen.findByTestId('record-left');
      fireEvent.click(screen.getByRole('button', { name: vi_['ctr.measurement.dialog.close'] }));
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  describe('sending, deciding and correcting', () => {
    const draft = () => measurement(3, { status: 'DRAFT', version: 1, actions: { submit: true, decide: false, correct: false }, period: { id: PERIOD_2, code: '2026-02' } });
    const waiting = () => measurement(4, { status: 'SUBMITTED', version: 2, actions: { submit: false, decide: true, correct: false } });
    const approved = () => measurement(5, { status: 'APPROVED', version: 3, actions: { submit: false, decide: false, correct: true } });
    const action = (name: string): HTMLElement => document.querySelector(`button[data-action="${name}"]`) as HTMLElement;

    it('sends a draft under the version it showed and tells it', async () => {
      const h = open(world({ measurements: [draft()] }));
      await screen.findByTestId('measurements');
      fireEvent.click(action('submit'));
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('submitMeasurement', expect.objectContaining({ path: { id: measurementId(3) }, ifMatchVersion: 1, body: {} })));
      expect((await screen.findByTestId('done')).textContent).toBe(vi_['ctr.measurement.done.submitted']);
    });

    it('says why a draft is not sent: no evidence', async () => {
      open(world({ measurements: [draft()] }), { command: () => problem('EVIDENCE_REQUIRED') });
      await screen.findByTestId('measurements');
      fireEvent.click(action('submit'));
      expect((await screen.findByTestId('submit-refusal')).textContent).toBe(vi_['ctr.measurement.error.evidenceRequired']);
    });

    it('decides a measurement that was sent: asks for the decision and the reason, then sends them under its version', async () => {
      const h = open(world({ measurements: [waiting()] }));
      await screen.findByTestId('measurements');
      fireEvent.click(action('decide'));
      expect((await screen.findByTestId('decide-quantity')).textContent).toBe(text('ctr.measurement.decide.quantity', { quantity: '3.500', unit: 'M3' }));
      press(vi_['ctr.measurement.decide.submit']);
      expect(screen.getByText(vi_['ctr.measurement.problem.choose'])).toBeTruthy();
      expect(screen.getByText(vi_['ctr.measurement.problem.required'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      fireEvent.click(document.querySelector('input[data-decision="approve"]') as HTMLElement);
      type('decide-reason', ' Checked on site. ');
      type('decide-evidence', 'nope');
      press(vi_['ctr.measurement.submit.approve']);
      expect(screen.getByText(vi_['ctr.measurement.problem.uuid'])).toBeTruthy();
      type('decide-evidence', UUID_A);
      press(vi_['ctr.measurement.submit.approve']);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith(
        'post_measurements_id_decision',
        expect.objectContaining({ path: { id: measurementId(4) }, ifMatchVersion: 2, body: { decision: 'approve', reason: 'Checked on site.', evidence_ids: [UUID_A] } }),
      );
      expect((await screen.findByTestId('done')).textContent).toBe(vi_['ctr.measurement.done.decided']);
    });

    it('words the refusal of whoever recorded the quantity deciding it, and offers the three decisions', async () => {
      open(world({ measurements: [waiting()] }), { command: () => problem('SELF_APPROVAL_DENIED', 403) });
      await screen.findByTestId('measurements');
      fireEvent.click(action('decide'));
      await screen.findByTestId('decide-quantity');
      expect(Array.from(document.querySelectorAll('input[data-decision]')).map((input) => input.getAttribute('data-decision'))).toEqual(['approve', 'return', 'reject']);
      fireEvent.click(document.querySelector('input[data-decision="reject"]') as HTMLElement);
      type('decide-reason', 'Not what was done.');
      press(vi_['ctr.measurement.submit.reject']);
      expect((await screen.findByTestId('refusal')).textContent).toBe(vi_['ctr.change.error.selfApproval']);
    });

    it('AC-ST-CTR-008-1, UAT-AC311: corrects an approved measurement with the new quantity, the reason and the evidence', async () => {
      const h = open(world({ measurements: [approved()] }));
      await screen.findByTestId('measurements');
      fireEvent.click(action('correct'));
      expect((await screen.findByTestId('correct-was')).textContent).toBe(text('ctr.measurement.correct.was', { quantity: '3.500', unit: 'M3' }));
      expect((document.getElementById('correct-quantity') as HTMLInputElement).value).toBe('3500.000000');
      type('correct-quantity', '-1');
      press(vi_['ctr.measurement.correct.submit']);
      expect(screen.getByText(vi_['ctr.measurement.problem.quantity'])).toBeTruthy();
      expect(screen.getAllByText(vi_['ctr.measurement.problem.required'])).toHaveLength(2);
      expect(h.command).not.toHaveBeenCalled();
      type('correct-quantity', '3000');
      type('correct-reason', ' Re-measured on site. ');
      type('correct-evidence', UUID_A);
      press(vi_['ctr.measurement.correct.submit']);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith(
        'correctMeasurement',
        expect.objectContaining({ path: { id: measurementId(5) }, ifMatchVersion: 3, body: { quantity_period: '3000', correction_reason: 'Re-measured on site.', evidence_refs: [{ document_version_id: UUID_A }] } }),
      );
      expect((await screen.findByTestId('done')).textContent).toBe(vi_['ctr.measurement.done.corrected']);
    });

    it('words the refusal to correct what an active acceptance holds', async () => {
      open(world({ measurements: [approved()] }), { command: () => problem('MEASUREMENT_IN_ACTIVE_ACCEPTANCE', 409) });
      await screen.findByTestId('measurements');
      fireEvent.click(action('correct'));
      await screen.findByTestId('correct-was');
      type('correct-quantity', '3000');
      type('correct-reason', 'Re-measured.');
      type('correct-evidence', UUID_A);
      press(vi_['ctr.measurement.correct.submit']);
      expect((await screen.findByTestId('refusal')).textContent).toBe(vi_['ctr.measurement.error.inAcceptance']);
    });

    it('hides the buttons in a read-only session', async () => {
      open(world({ measurements: [draft(), waiting(), approved()] }), { mode: 'READ_ONLY' });
      await screen.findByTestId('measurements');
      expect(document.querySelectorAll('button[data-action]')).toHaveLength(0);
    });
  });

  it('shows the state of a failed read and reads again on retry', async () => {
    const state = world({ failing: new Set(['get_resources_measurement']) });
    open(state);
    const retry = await screen.findByRole('button', { name: /./ });
    state.failing.clear();
    fireEvent.click(retry);
    expect(await screen.findByTestId('items')).toBeTruthy();
  });
});
