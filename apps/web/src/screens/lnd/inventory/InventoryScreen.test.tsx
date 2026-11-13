import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { COUNTER, HOUSEHOLD_READER, PROJECT, TENANT, client, household, inventoryRecord, mount, parcel, routeOf, world } from '../test-support';
import InventoryScreen from './InventoryScreen';

const ROUTE = routeOf('LND-04', 'FR-LND-04');
const OK = { operation_id: 'o', status: 'DRAFT', resource_version: 1, resource_id: inventoryRecord(1).id };
const PATH = `/lnd/lnd-04?project=${PROJECT}&household=${household(1).id}`;
const problem = (code: string, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions: {} });
// The person who is signed in is the person who counted the record `mine`; the others were counted by someone else.
const ME = TENANT.membershipId;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const worldOf = () =>
  world({
    households: [household(1, { parcels: [{ id: 'link-1', parcel_id: parcel(1).id, parcel_code: 'TB-1/10', right_kind: 'OWNER', share_pct: '100.0000' }] }), household(2, { status: 'DISPUTED' })],
    inventory: [
      inventoryRecord(1),
      inventoryRecord(2, { surveyed_by: ME, item_kind: 'TREE', description: 'Cây ăn quả', quantity: '12.000000', unit_code: 'TREE', unit_price_vnd: '300000', amount_vnd: '3600000' }),
      inventoryRecord(3, { status: 'CONFIRMED', household_confirmed_on: '2026-07-01', confirmed_by: ME, amount_vnd: '1000000', version: 2 }),
      inventoryRecord(4, { status: 'DISPUTED', household_confirmed_on: '2026-07-02', note: 'Diện tích nhà là 95 m2', price_decision_revision: null, version: 2 }),
    ],
  });
const rowOf = (n: number): HTMLElement => document.querySelector(`[data-record-id="${inventoryRecord(n).id}"]`) as HTMLElement;
const ready = () => screen.findByTestId('household-summary');

describe('InventoryScreen (LND-04): the inventory of the assets of a household', () => {
  it('UI-LND-04: asks for a project and then a household before it shows anything', async () => {
    mount(<InventoryScreen route={ROUTE} />, client(worldOf()), { permissions: COUNTER, path: '/lnd/lnd-04' });
    expect((await screen.findByTestId('choose-household')).textContent).toBe(vi_['lnd.inventory.project.notice']);
    expect(document.querySelectorAll('[data-record-id]')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: vi_['lnd.inventory.record.action'] })).toBeNull();
    await screen.findByRole('option', { name: /DA-2026-001/ });
    fireEvent.change(screen.getByLabelText(vi_['lnd.inventory.project.label']), { target: { value: PROJECT } });
    expect((await screen.findByTestId('choose-household')).textContent).toBe(vi_['lnd.inventory.household.notice']);
    await screen.findByRole('option', { name: /HH-000001/ });
    fireEvent.change(screen.getByLabelText(vi_['lnd.inventory.household.label']), { target: { value: household(1).id } });
    await ready();
    fireEvent.change(screen.getByLabelText(vi_['lnd.inventory.household.label']), { target: { value: '' } });
    expect(screen.getByTestId('choose-household')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(vi_['lnd.inventory.project.label']), { target: { value: '' } });
    expect(screen.getByTestId('choose-household').textContent).toBe(vi_['lnd.inventory.project.notice']);
  });

  it('UI-LND-04: shows what was counted, with the amount to the dong, the decision and its revision, the answer of the household and the total of the confirmed records only', async () => {
    mount(<InventoryScreen route={ROUTE} />, client(worldOf()), { permissions: COUNTER, path: PATH });
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['lnd.inventory.page.title']);
    expect(screen.getByTestId('privacy-note').textContent).toBe(vi_['lnd.inventory.privacy.note']);
    expect(screen.getByTestId('household-summary').textContent).toBe(vi_['lnd.inventory.household.summary'].replace('{code}', 'HH-000001').replace('{head}', 'N***** V** A').replace('{status}', vi_['lnd.householdStatus.registered.label']));
    const headers = Array.from(document.querySelectorAll('thead th')).map((header) => header.textContent);
    expect(headers).toEqual([
      vi_['lnd.inventory.column.parcel'],
      vi_['lnd.inventory.column.kind'],
      vi_['lnd.inventory.column.description'],
      vi_['lnd.inventory.column.quantity'],
      vi_['lnd.inventory.column.price'],
      vi_['lnd.inventory.column.amount'],
      vi_['lnd.inventory.column.decision'],
      'Hộ xác nhận',
      vi_['lnd.inventory.column.answer'],
      vi_['lnd.inventory.column.status'],
      vi_['lnd.inventory.column.action'],
    ]);
    const first = rowOf(1);
    expect(first.querySelector('th')?.textContent).toBe('TB-1/10');
    expect(within(first).getByText(vi_['lnd.itemKind.house.label'])).toBeTruthy();
    expect(within(first).getByTestId('amount').textContent).toBe('360.000.000');
    expect(within(first).getByTestId('decision').textContent).toBe(vi_['lnd.inventory.decision.line'].replace('{ref}', 'QD-GIA-2024').replace('{revision}', '1'));
    expect(within(first).getByTestId('confirmed').textContent).toBe(vi_['lnd.inventory.answer.none']);
    expect(within(first).getByTestId('status').textContent).toBe(vi_['lnd.inventoryStatus.draft.label']);
    expect(within(rowOf(3)).getByTestId('confirmed').textContent).toBe(vi_['lnd.inventory.answer.line'].replace('{on}', '2026-07-01'));
    expect(within(rowOf(3)).getByTestId('status').textContent).toBe(vi_['lnd.inventoryStatus.confirmed.label']);
    expect(within(rowOf(4)).getByTestId('note').textContent).toBe('Diện tích nhà là 95 m2');
    expect(within(rowOf(4)).getByTestId('decision').textContent).toBe('QD-GIA-2024');
    expect(within(rowOf(4)).getByTestId('status').textContent).toBe(vi_['lnd.inventoryStatus.disputed.label']);
    expect(screen.getByTestId('confirmed-total').textContent).toBe(vi_['lnd.inventory.total.text'].replace('{amount}', '1.000.000'));
  });

  it('filters by status and says when nothing matches or nothing was counted, and when the read fails offers a retry', async () => {
    mount(<InventoryScreen route={ROUTE} />, client(worldOf()), { permissions: COUNTER, path: PATH });
    await ready();
    fireEvent.change(screen.getByLabelText(vi_['lnd.inventory.status.label']), { target: { value: 'CONFIRMED' } });
    expect(Array.from(document.querySelectorAll('[data-record-id]')).map((tr) => tr.getAttribute('data-record-id'))).toEqual([inventoryRecord(3).id]);
    fireEvent.change(screen.getByLabelText(vi_['lnd.inventory.status.label']), { target: { value: 'SUPERSEDED' } });
    expect(screen.getByTestId('no-match').textContent).toBe(vi_['lnd.inventory.noMatch.notice']);
    cleanup();
    mount(<InventoryScreen route={ROUTE} />, client(world({ households: worldOf().households })), { permissions: COUNTER, path: PATH });
    expect((await screen.findByTestId('no-match')).textContent).toBe(vi_['lnd.inventory.empty.notice']);
    expect(screen.getByTestId('confirmed-total').textContent).toBe(vi_['lnd.inventory.total.text'].replace('{amount}', '0'));
    cleanup();
    const broken = worldOf();
    broken.failing.add('listInventoryRecords');
    mount(<InventoryScreen route={ROUTE} />, client(broken), { permissions: COUNTER, path: PATH });
    expect(await screen.findByRole('button', { name: /thử lại|retry/i })).toBeTruthy();
  });

  it('shows a reader the records and no button; a read-only session too', async () => {
    mount(<InventoryScreen route={ROUTE} />, client(worldOf()), { permissions: HOUSEHOLD_READER, path: PATH });
    await ready();
    expect(screen.queryByRole('button', { name: vi_['lnd.inventory.record.action'] })).toBeNull();
    expect(within(rowOf(1)).queryByRole('button')).toBeNull();
    cleanup();
    mount(<InventoryScreen route={ROUTE} />, client(worldOf()), { permissions: COUNTER, mode: 'READ_ONLY', path: PATH });
    await ready();
    expect(screen.queryByRole('button', { name: vi_['lnd.inventory.record.action'] })).toBeNull();
    expect(within(rowOf(1)).queryByRole('button')).toBeNull();
  });

  it('AC-ST-LND-004-1, UAT-PLAN-29, UI-LND-04: offers the answer of the household for a draft that someone else counted, and for no other', async () => {
    mount(<InventoryScreen route={ROUTE} />, client(worldOf()), { permissions: COUNTER, path: PATH });
    await ready();
    expect(within(rowOf(1)).getByRole('button', { name: vi_['lnd.inventory.answer.aria'].replace('{code}', 'TB-1/10') })).toBeTruthy();
    // The record the signed-in person counted is not theirs to answer; a record that was answered is not answered again.
    expect(within(rowOf(2)).queryByRole('button')).toBeNull();
    expect(within(rowOf(3)).queryByRole('button')).toBeNull();
    expect(within(rowOf(4)).queryByRole('button')).toBeNull();
  });

  it('AC-ST-LND-004-1: records the answer under the version of the record, with the day and the note, and closes', async () => {
    const h = client(worldOf(), () => ({ ...OK, status: 'CONFIRMED', resource_version: 2 }));
    mount(<InventoryScreen route={ROUTE} />, h, { permissions: COUNTER, path: PATH });
    await ready();
    fireEvent.click(within(rowOf(1)).getByRole('button', { name: vi_['lnd.inventory.answer.aria'].replace('{code}', 'TB-1/10') }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByTestId('answer-summary').textContent).toBe(vi_['lnd.inventory.answerDialog.summary.text'].replace('{kind}', vi_['lnd.itemKind.house.label']).replace('{amount}', '360.000.000'));
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getAllByRole('alert').length).toBe(2);
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.inventory.answerDialog.outcome.label']), { target: { value: 'CONFIRMED' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.inventory.answerDialog.date.label']), { target: { value: '2026-07-01' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.inventory.answerDialog.note.label']), { target: { value: ' Hộ đồng ý ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.command).toHaveBeenCalledWith(
      'confirmInventory',
      expect.objectContaining({ path: { id: inventoryRecord(1).id }, ifMatchVersion: 1, body: { outcome: 'CONFIRMED', household_confirmed_on: '2026-07-01', note: 'Hộ đồng ý' } }),
    );
  });

  it('wants a note for an objection, and a day that is not before the survey and not to come', async () => {
    const h = client(worldOf(), () => OK);
    mount(<InventoryScreen route={ROUTE} />, h, { permissions: COUNTER, path: PATH });
    await ready();
    fireEvent.click(within(rowOf(1)).getByRole('button', { name: vi_['lnd.inventory.answer.aria'].replace('{code}', 'TB-1/10') }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.inventory.answerDialog.outcome.label']), { target: { value: 'DISPUTED' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.inventory.answerDialog.date.label']), { target: { value: '2026-06-01' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getByText(vi_['lnd.inventory.field.beforeSurvey.error'])).toBeTruthy();
    expect(within(dialog).getByText(vi_['lnd.field.required.error'])).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.inventory.answerDialog.date.label']), { target: { value: '2999-01-01' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getByText(vi_['lnd.field.future.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('says why the server refused the answer: the person who counted may not give it, the record was answered, the record changed', async () => {
    for (const [code, key] of [
      ['SELF_APPROVAL_DENIED', 'lnd.inventory.problem.selfApproval.error'],
      ['INVENTORY_STATE_INVALID', 'lnd.inventory.problem.stateInvalid.error'],
      ['VERSION_CONFLICT', 'lnd.problem.versionConflict.error'],
    ] as const) {
      const h = client(worldOf(), () => problem(code, 409));
      mount(<InventoryScreen route={ROUTE} />, h, { permissions: COUNTER, path: PATH });
      await ready();
      fireEvent.click(within(rowOf(1)).getByRole('button', { name: vi_['lnd.inventory.answer.aria'].replace('{code}', 'TB-1/10') }));
      const dialog = screen.getByRole('dialog');
      fireEvent.change(within(dialog).getByLabelText(vi_['lnd.inventory.answerDialog.outcome.label']), { target: { value: 'CONFIRMED' } });
      fireEvent.change(within(dialog).getByLabelText(vi_['lnd.inventory.answerDialog.date.label']), { target: { value: '2026-07-01' } });
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
      expect((await within(dialog).findByTestId('refusal')).textContent).toBe(vi_[key]);
      cleanup();
    }
  });

  it('AC-ST-LND-004-1, UI-LND-04: counts an asset, shows the amount as it will be computed, and sends the figures as they were written', async () => {
    const h = client(worldOf(), () => OK);
    mount(<InventoryScreen route={ROUTE} />, h, { permissions: COUNTER, path: PATH });
    await ready();
    fireEvent.click(screen.getByRole('button', { name: vi_['lnd.inventory.record.action'] }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByTestId('amount-preview').textContent).toBe(vi_['lnd.inventory.recordDialog.amount.none']);
    // Only the parcels the household holds a right on are offered.
    expect(within(dialog).getAllByRole('option').map((option) => option.textContent)).toContain('TB-1/10');
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getAllByRole('alert').length).toBeGreaterThanOrEqual(7);
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.inventory.recordDialog.parcel.label']), { target: { value: parcel(1).id } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.inventory.recordDialog.kind.label']), { target: { value: 'HOUSE' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.inventory.recordDialog.description.label']), { target: { value: ' Nhà cấp 4 ' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.inventory.recordDialog.quantity.label']), { target: { value: '80' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.inventory.recordDialog.unit.label']), { target: { value: ' M2 ' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.inventory.recordDialog.price.label']), { target: { value: '4500000' } });
    expect(within(dialog).getByTestId('amount-preview').textContent).toBe(vi_['lnd.inventory.recordDialog.amount.text'].replace('{amount}', '360.000.000'));
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.inventory.recordDialog.decision.label']), { target: { value: ' QD-GIA-2024 ' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.inventory.recordDialog.surveyed.label']), { target: { value: '2026-06-20' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.inventory.recordDialog.document.label']), { target: { value: '00000000-0000-4000-8000-000000000004' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.command).toHaveBeenCalledWith(
      'recordInventory',
      expect.objectContaining({
        body: {
          household_id: household(1).id,
          parcel_id: parcel(1).id,
          item_kind: 'HOUSE',
          description: 'Nhà cấp 4',
          quantity: '80',
          unit_code: 'M2',
          unit_price_vnd: '4500000',
          price_decision_ref: 'QD-GIA-2024',
          surveyed_on: '2026-06-20',
          document_version_id: '00000000-0000-4000-8000-000000000004',
        },
      }),
    );
  });

  it('refuses a figure that is not a figure before it is sent, and says why the server refused a price decision that was not in force or a parcel the household has no right on', async () => {
    const h = client(worldOf(), () => problem('PRICE_DECISION_NOT_EFFECTIVE'));
    mount(<InventoryScreen route={ROUTE} />, h, { permissions: COUNTER, path: PATH });
    await ready();
    fireEvent.click(screen.getByRole('button', { name: vi_['lnd.inventory.record.action'] }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.inventory.recordDialog.quantity.label']), { target: { value: '0' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.inventory.recordDialog.price.label']), { target: { value: '4.5' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.inventory.recordDialog.surveyed.label']), { target: { value: '2999-01-01' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.inventory.recordDialog.document.label']), { target: { value: 'not-an-id' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getAllByText(vi_['lnd.field.invalid.error']).length).toBeGreaterThanOrEqual(3);
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.inventory.recordDialog.parcel.label']), { target: { value: parcel(1).id } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.inventory.recordDialog.kind.label']), { target: { value: 'LAND' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.inventory.recordDialog.description.label']), { target: { value: 'Đất vườn' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.inventory.recordDialog.quantity.label']), { target: { value: '500' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.inventory.recordDialog.unit.label']), { target: { value: 'M2' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.inventory.recordDialog.price.label']), { target: { value: '200000' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.inventory.recordDialog.decision.label']), { target: { value: 'QD-GIA-2024' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.inventory.recordDialog.surveyed.label']), { target: { value: '2026-07-15' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.inventory.recordDialog.document.label']), { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect((await within(dialog).findByTestId('refusal')).textContent).toBe(vi_['lnd.inventory.problem.priceDecision.error']);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});
