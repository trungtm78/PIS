import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { PLAN_READER, PLANNER, PROJECT, UNIT_TTQD, UNIT_XA, client, household, inventoryRecord, mount, parcel, planItemRecord, planRecord, routeOf, world } from '../test-support';
import PlanScreen from './PlanScreen';

const ROUTE = routeOf('LND-05', 'FR-LND-05');
const OK = { operation_id: 'o', status: 'DRAFT', resource_version: 2, resource_id: planRecord(1).id };
const PATH = `/lnd/lnd-05?project=${PROJECT}`;
const problem = (code: string, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions: {} });
const MINE = household(1, { parcels: [{ id: 'link-1', parcel_id: parcel(1).id, parcel_code: 'TB-1/10', right_kind: 'OWNER', share_pct: '100.0000' }] });
const CONFIRMED = (n: number, overrides: Record<string, unknown> = {}) => inventoryRecord(n, { status: 'CONFIRMED', household_confirmed_on: '2026-07-01', confirmed_by: '00000000-0000-4000-8000-0000000000bb', ...overrides });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const worldOf = () =>
  world({
    households: [MINE],
    inventory: [
      CONFIRMED(1),
      CONFIRMED(2, { item_kind: 'LAND', description: 'Đất vườn', quantity: '500.000000', unit_price_vnd: '200000', amount_vnd: '100000000' }),
      CONFIRMED(3, { amount_vnd: '5000000', quantity: '1.000000', unit_price_vnd: '5000000' }),
      inventoryRecord(4),
    ],
    plans: [
      planRecord(1, { total_compensation_vnd: '360000000', total_support_vnd: '10000000', grand_total_vnd: '370000000' }),
      planRecord(2, { status: 'POSTING', total_support_vnd: '5000', grand_total_vnd: '5000', version: 3 }),
      planRecord(3, { status: 'REVISED', revision: 1, plan_code: 'PA-0004', version: 4 }),
      planRecord(4, { revision: 2, plan_code: 'PA-0004', supersedes_id: planRecord(3).id, revision_reason: 'Giá đất thay đổi', status: 'DRAFT' }),
      planRecord(5, { status: 'COMPLETED', plan_code: 'PA-0005' }),
    ],
    planItems: [
      planItemRecord(1, planRecord(1).id, { item_kind: 'COMPENSATION_ASSET', parcel_code: 'TB-1/10', amount_vnd: '360000000', basis_inventory_id: inventoryRecord(9).id, quantity: '80.000000', unit_code: 'M2', unit_price_vnd: '4500000', price_decision_ref: 'QD-GIA-2024', price_decision_revision: 1, legal_basis: 'Luật Đất đai 2024, Điều 91' }),
      planItemRecord(2, planRecord(1).id),
    ],
  });
const rowOf = (n: number): HTMLElement => document.querySelector(`[data-plan-id="${planRecord(n).id}"]`) as HTMLElement;
const ready = () => screen.findByTestId('plans');
const button = (row: HTMLElement, key: string, code: string, revision = 1) => within(row).getByRole('button', { name: vi_[key as keyof typeof vi_].replace('{code}', code).replace('{revision}', String(revision)) });

describe('PlanScreen (LND-05): the plans of compensation, support and resettlement', () => {
  it('UI-LND-05: asks for a project first and lists the plans of the one chosen', async () => {
    mount(<PlanScreen route={ROUTE} />, client(worldOf()), { permissions: PLANNER, path: '/lnd/lnd-05' });
    expect((await screen.findByTestId('choose-project')).textContent).toBe(vi_['lnd.plans.project.notice']);
    expect(screen.queryByTestId('plans')).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['lnd.plans.draft.action'] })).toBeNull();
    await screen.findByRole('option', { name: /DA-2026-001/ });
    fireEvent.change(screen.getByLabelText(vi_['lnd.plans.project.label']), { target: { value: PROJECT } });
    await ready();
    expect(Array.from(document.querySelectorAll('[data-plan-id]'))).toHaveLength(5);
    fireEvent.change(screen.getByLabelText(vi_['lnd.plans.project.label']), { target: { value: '' } });
    expect(screen.getByTestId('choose-project')).toBeTruthy();
  });

  it('UI-LND-05: shows the code, the revision, the totals by group and the grand total, the status and the reason of a revision', async () => {
    mount(<PlanScreen route={ROUTE} />, client(worldOf()), { permissions: PLANNER, path: PATH });
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['lnd.plans.page.title']);
    expect(screen.getByTestId('privacy-note').textContent).toBe(vi_['lnd.plans.privacy.note']);
    const headers = Array.from(document.querySelectorAll('thead th')).map((header) => header.textContent);
    expect(headers).toEqual([
      vi_['lnd.plans.column.code'],
      vi_['lnd.plans.column.revision'],
      vi_['lnd.plans.column.executor'],
      vi_['lnd.plans.column.compensation'],
      vi_['lnd.plans.column.support'],
      vi_['lnd.plans.column.resettlement'],
      vi_['lnd.plans.column.grand'],
      vi_['lnd.plans.column.status'],
      vi_['lnd.plans.column.action'],
    ]);
    const first = rowOf(1);
    expect(first.querySelector('th')?.textContent).toBe('PA-0001');
    expect(within(first).getByTestId('revision').textContent).toBe('1');
    expect(within(first).getByText(vi_['lnd.executorKind.landFundCentre.label'])).toBeTruthy();
    expect(within(first).getByTestId('total-compensation').textContent).toBe('360.000.000');
    expect(within(first).getByTestId('total-support').textContent).toBe('10.000.000');
    expect(within(first).getByTestId('total-resettlement').textContent).toBe('0');
    expect(within(first).getByTestId('total-grand').textContent).toBe('370.000.000');
    expect(within(first).getByTestId('status').textContent).toBe(vi_['lnd.planStatus.draft.label']);
    expect(within(rowOf(3)).getByTestId('status').textContent).toBe(vi_['lnd.planStatus.revised.label']);
    expect(within(rowOf(4)).getByTestId('reason').textContent).toBe('Giá đất thay đổi');
    expect(within(rowOf(4)).getByTestId('revision').textContent).toBe('2');
  });

  it('filters by status and says when nothing matches or the project has no plan, and when the read fails offers a retry', async () => {
    mount(<PlanScreen route={ROUTE} />, client(worldOf()), { permissions: PLANNER, path: PATH });
    await ready();
    fireEvent.change(screen.getByLabelText(vi_['lnd.plans.status.label']), { target: { value: 'POSTING' } });
    expect(Array.from(document.querySelectorAll('[data-plan-id]')).map((tr) => tr.getAttribute('data-plan-id'))).toEqual([planRecord(2).id]);
    fireEvent.change(screen.getByLabelText(vi_['lnd.plans.status.label']), { target: { value: 'CANCELLED' } });
    expect(screen.getByTestId('no-match').textContent).toBe(vi_['lnd.plans.noMatch.notice']);
    cleanup();
    mount(<PlanScreen route={ROUTE} />, client(world()), { permissions: PLANNER, path: PATH });
    expect((await screen.findByTestId('no-match')).textContent).toBe(vi_['lnd.plans.empty.notice']);
    cleanup();
    const broken = worldOf();
    broken.failing.add('listCompensationPlans');
    mount(<PlanScreen route={ROUTE} />, client(broken), { permissions: PLANNER, path: PATH });
    expect(await screen.findByRole('button', { name: /thử lại|retry/i })).toBeTruthy();
  });

  it('AC-ST-LND-005-1, UI-LND-05: opens the items of a plan with the quantity and the price, the amount and the price decision they were counted by', async () => {
    mount(<PlanScreen route={ROUTE} />, client(worldOf()), { permissions: PLAN_READER, path: PATH });
    await ready();
    fireEvent.click(button(rowOf(1), 'lnd.plans.open.aria', 'PA-0001'));
    const detail = await screen.findByTestId('plan-detail');
    expect(within(detail).getByRole('heading', { level: 2 }).textContent).toBe(vi_['lnd.plans.detail.title'].replace('{code}', 'PA-0001').replace('{revision}', '1'));
    await waitFor(() => expect(detail.querySelectorAll('[data-item-id]')).toHaveLength(2));
    const asset = detail.querySelector(`[data-item-id="${planItemRecord(1, planRecord(1).id).id}"]`) as HTMLElement;
    expect(within(asset).getByTestId('count').textContent).toBe(vi_['lnd.plans.item.count'].replace('{quantity}', '80.000000').replace('{unit}', 'M2').replace('{price}', '4.500.000'));
    expect(within(asset).getByTestId('amount').textContent).toBe('360.000.000');
    expect(within(asset).getByTestId('decision').textContent).toBe(vi_['lnd.plans.item.decision'].replace('{ref}', 'QD-GIA-2024').replace('{revision}', '1'));
    expect(within(asset).getByText('Luật Đất đai 2024, Điều 91')).toBeTruthy();
    const policy = detail.querySelector(`[data-item-id="${planItemRecord(2, planRecord(1).id).id}"]`) as HTMLElement;
    expect(within(policy).getByTestId('count').textContent).toBe(vi_['lnd.plans.item.none']);
    expect(within(policy).getByTestId('decision').textContent).toBe(vi_['lnd.plans.item.none']);
    expect(within(policy).getByText(vi_['lnd.planItemKind.supportLivelihood.label'])).toBeTruthy();
  });

  it('says when a plan has no item the reader may see, and when the items cannot be read', async () => {
    mount(<PlanScreen route={ROUTE} />, client(worldOf()), { permissions: PLAN_READER, path: PATH });
    await ready();
    fireEvent.click(button(rowOf(2), 'lnd.plans.open.aria', 'PA-0002'));
    expect((await screen.findByTestId('items-empty')).textContent).toBe(vi_['lnd.plans.items.empty']);
    cleanup();
    const broken = worldOf();
    broken.failing.add('listCompensationPlanItems');
    mount(<PlanScreen route={ROUTE} />, client(broken), { permissions: PLAN_READER, path: PATH });
    await ready();
    fireEvent.click(button(rowOf(1), 'lnd.plans.open.aria', 'PA-0001'));
    expect((await screen.findByTestId('items-failed')).textContent).toBe(vi_['lnd.plans.items.failed']);
  });

  it('AC-ST-LND-005-2, UI-LND-05: offers an item to a draft and a revision to a plan that was posted or approved, and neither to the others; a reader and a read-only session no button', async () => {
    mount(<PlanScreen route={ROUTE} />, client(worldOf()), { permissions: PLANNER, path: PATH });
    await ready();
    const has = (n: number, key: string, code: string, revision = 1) => within(rowOf(n)).queryByRole('button', { name: vi_[key as keyof typeof vi_].replace('{code}', code).replace('{revision}', String(revision)) }) !== null;
    expect([has(1, 'lnd.plans.items.aria', 'PA-0001'), has(1, 'lnd.plans.revise.aria', 'PA-0001')]).toEqual([true, false]);
    expect([has(2, 'lnd.plans.items.aria', 'PA-0002'), has(2, 'lnd.plans.revise.aria', 'PA-0002')]).toEqual([false, true]);
    expect([has(3, 'lnd.plans.items.aria', 'PA-0004'), has(3, 'lnd.plans.revise.aria', 'PA-0004')]).toEqual([false, false]);
    expect([has(4, 'lnd.plans.items.aria', 'PA-0004', 2), has(4, 'lnd.plans.revise.aria', 'PA-0004', 2)]).toEqual([true, false]);
    expect([has(5, 'lnd.plans.items.aria', 'PA-0005'), has(5, 'lnd.plans.revise.aria', 'PA-0005')]).toEqual([false, false]);
    cleanup();
    mount(<PlanScreen route={ROUTE} />, client(worldOf()), { permissions: PLAN_READER, path: PATH });
    await ready();
    expect(screen.queryByRole('button', { name: vi_['lnd.plans.draft.action'] })).toBeNull();
    for (const n of [1, 2, 3, 4, 5]) expect(within(rowOf(n)).getAllByRole('button')).toHaveLength(1);
    cleanup();
    mount(<PlanScreen route={ROUTE} />, client(worldOf()), { permissions: PLANNER, mode: 'READ_ONLY', path: PATH });
    await ready();
    expect(screen.queryByRole('button', { name: vi_['lnd.plans.draft.action'] })).toBeNull();
    expect(within(rowOf(1)).getAllByRole('button')).toHaveLength(1);
  });

  it('drafts a plan with its code, its executor and the kind of executor, and says why the server refused a code that is taken', async () => {
    const h = client(worldOf(), () => OK);
    mount(<PlanScreen route={ROUTE} />, h, { permissions: PLANNER, path: PATH });
    await ready();
    fireEvent.click(screen.getByRole('button', { name: vi_['lnd.plans.draft.action'] }));
    const dialog = screen.getByRole('dialog');
    await waitFor(() => expect(within(within(dialog).getByLabelText(vi_['lnd.plans.draftDialog.unit.label'])).getAllByRole('option').length).toBeGreaterThan(1));
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getAllByRole('alert')).toHaveLength(3);
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.plans.draftDialog.code.label']), { target: { value: 'x'.repeat(51) } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getByText(vi_['lnd.field.tooLong.error'])).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.plans.draftDialog.code.label']), { target: { value: 'a\u0007b' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getByText(vi_['lnd.field.invalid.error'])).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.plans.draftDialog.code.label']), { target: { value: ' PA-NEW ' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.plans.draftDialog.unit.label']), { target: { value: UNIT_TTQD } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.plans.draftDialog.kind.label']), { target: { value: 'LAND_FUND_CENTRE' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.command).toHaveBeenCalledWith('draftCompensationPlan', expect.objectContaining({ body: { project_id: PROJECT, executor_unit_id: UNIT_TTQD, executor_kind: 'LAND_FUND_CENTRE', plan_code: 'PA-NEW' } }));
    cleanup();
    const taken = client(worldOf(), () => problem('PLAN_CODE_DUPLICATE', 409));
    mount(<PlanScreen route={ROUTE} />, taken, { permissions: PLANNER, path: PATH });
    await ready();
    fireEvent.click(screen.getByRole('button', { name: vi_['lnd.plans.draft.action'] }));
    const again = screen.getByRole('dialog');
    await waitFor(() => expect(within(within(again).getByLabelText(vi_['lnd.plans.draftDialog.unit.label'])).getAllByRole('option').length).toBeGreaterThan(1));
    fireEvent.change(within(again).getByLabelText(vi_['lnd.plans.draftDialog.code.label']), { target: { value: 'PA-0001' } });
    fireEvent.change(within(again).getByLabelText(vi_['lnd.plans.draftDialog.unit.label']), { target: { value: UNIT_XA } });
    fireEvent.change(within(again).getByLabelText(vi_['lnd.plans.draftDialog.kind.label']), { target: { value: 'PROJECT_OWNER' } });
    fireEvent.click(within(again).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect((await within(again).findByTestId('refusal')).textContent).toBe(vi_['lnd.plans.problem.codeDuplicate.error']);
  });

  it('AC-ST-LND-005-1, UAT-AC382: adds a compensation from a confirmed record of the inventory of the kind chosen that the plan does not use yet, and takes the amount from the record', async () => {
    const state = worldOf();
    state.planItems.push(planItemRecord(3, planRecord(1).id, { item_kind: 'COMPENSATION_ASSET', basis_inventory_id: CONFIRMED(3).id, amount_vnd: '5000000' }));
    const h = client(state, () => OK);
    mount(<PlanScreen route={ROUTE} />, h, { permissions: PLANNER, path: `${PATH}&plan=${planRecord(1).id}` });
    await screen.findByTestId('plan-detail');
    await waitFor(() => expect(document.querySelectorAll('[data-item-id]')).toHaveLength(3));
    fireEvent.click(button(rowOf(1), 'lnd.plans.items.aria', 'PA-0001'));
    const dialog = screen.getByRole('dialog');
    await within(dialog).findByRole('option', { name: /HH-000001/ });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getAllByRole('alert').length).toBeGreaterThanOrEqual(3);
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.plans.itemDialog.household.label']), { target: { value: household(1).id } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.plans.itemDialog.kind.label']), { target: { value: 'COMPENSATION_ASSET' } });
    await waitFor(() => expect(within(dialog).getAllByRole('option').map((option) => option.textContent)).toContain(vi_['lnd.plans.itemDialog.basis.line'].replace('{parcel}', 'TB-1/10').replace('{kind}', vi_['lnd.itemKind.house.label']).replace('{amount}', '360.000.000')));
    // The record already in the plan, the draft record and the record of land are not offered for an asset.
    const options = within(dialog).getAllByRole('option').map((option) => option.textContent);
    expect(options.filter((text) => text?.includes('VND'))).toHaveLength(1);
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.plans.itemDialog.basis.label']), { target: { value: CONFIRMED(1).id } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.plans.itemDialog.legalBasis.label']), { target: { value: ' Luật Đất đai 2024, Điều 91 ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.command).toHaveBeenCalledWith(
      'addCompensationPlanItems',
      expect.objectContaining({
        path: { id: planRecord(1).id },
        ifMatchVersion: 1,
        body: { items: [{ household_id: household(1).id, item_kind: 'COMPENSATION_ASSET', legal_basis: 'Luật Đất đai 2024, Điều 91', basis_inventory_id: CONFIRMED(1).id }] },
      }),
    );
  });

  it('offers the records of land for a compensation for land, and says when the household has none', async () => {
    mount(<PlanScreen route={ROUTE} />, client(worldOf(), () => OK), { permissions: PLANNER, path: PATH });
    await ready();
    fireEvent.click(button(rowOf(1), 'lnd.plans.items.aria', 'PA-0001'));
    const dialog = screen.getByRole('dialog');
    await within(dialog).findByRole('option', { name: /HH-000001/ });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.plans.itemDialog.household.label']), { target: { value: household(1).id } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.plans.itemDialog.kind.label']), { target: { value: 'COMPENSATION_LAND' } });
    await waitFor(() => expect(within(dialog).getAllByRole('option').map((option) => option.textContent)).toContain(vi_['lnd.plans.itemDialog.basis.line'].replace('{parcel}', 'TB-1/10').replace('{kind}', vi_['lnd.itemKind.land.label']).replace('{amount}', '100.000.000')));
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.plans.itemDialog.household.label']), { target: { value: '' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.plans.itemDialog.kind.label']), { target: { value: 'COMPENSATION_LAND' } });
    expect(within(dialog).getByRole('option', { name: vi_['lnd.plans.itemDialog.basis.none'] })).toBeTruthy();
  });

  it('adds a support as the amount of a policy with its legal basis, and refuses an amount that is not whole dong before it is sent', async () => {
    const h = client(worldOf(), () => OK);
    mount(<PlanScreen route={ROUTE} />, h, { permissions: PLANNER, path: PATH });
    await ready();
    fireEvent.click(button(rowOf(1), 'lnd.plans.items.aria', 'PA-0001'));
    const dialog = screen.getByRole('dialog');
    await within(dialog).findByRole('option', { name: /HH-000001/ });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.plans.itemDialog.household.label']), { target: { value: household(1).id } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.plans.itemDialog.kind.label']), { target: { value: 'SUPPORT_TRAINING' } });
    expect(within(dialog).queryByLabelText(vi_['lnd.plans.itemDialog.basis.label'])).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.plans.itemDialog.amount.label']), { target: { value: '12.5' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.plans.itemDialog.legalBasis.label']), { target: { value: 'a\u0007b' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getAllByText(vi_['lnd.field.invalid.error'])).toHaveLength(2);
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.plans.itemDialog.legalBasis.label']), { target: { value: 'x'.repeat(501) } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getByText(vi_['lnd.field.tooLong.error'])).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.plans.itemDialog.amount.label']), { target: { value: ' 2500000 ' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.plans.itemDialog.legalBasis.label']), { target: { value: 'Nghị định 88/2024/NĐ-CP' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.command).toHaveBeenCalledWith(
      'addCompensationPlanItems',
      expect.objectContaining({ body: { items: [{ household_id: household(1).id, item_kind: 'SUPPORT_TRAINING', legal_basis: 'Nghị định 88/2024/NĐ-CP', amount_vnd: '2500000' }] } }),
    );
  });

  it('says why the server refused an item: a record that is not confirmed, a plan that is not a draft, a plan that changed', async () => {
    for (const [code, key] of [
      ['INVENTORY_NOT_CONFIRMED', 'lnd.plans.problem.notConfirmed.error'],
      ['PLAN_STATE_INVALID', 'lnd.plans.problem.stateInvalid.error'],
      ['VERSION_CONFLICT', 'lnd.problem.versionConflict.error'],
    ] as const) {
      const h = client(worldOf(), () => problem(code, code === 'INVENTORY_NOT_CONFIRMED' ? 422 : 409));
      mount(<PlanScreen route={ROUTE} />, h, { permissions: PLANNER, path: PATH });
      await ready();
      fireEvent.click(button(rowOf(1), 'lnd.plans.items.aria', 'PA-0001'));
      const dialog = screen.getByRole('dialog');
      await within(dialog).findByRole('option', { name: /HH-000001/ });
      fireEvent.change(within(dialog).getByLabelText(vi_['lnd.plans.itemDialog.household.label']), { target: { value: household(1).id } });
      fireEvent.change(within(dialog).getByLabelText(vi_['lnd.plans.itemDialog.kind.label']), { target: { value: 'SUPPORT_RELOCATION' } });
      fireEvent.change(within(dialog).getByLabelText(vi_['lnd.plans.itemDialog.amount.label']), { target: { value: '1' } });
      fireEvent.change(within(dialog).getByLabelText(vi_['lnd.plans.itemDialog.legalBasis.label']), { target: { value: 'Nghị định' } });
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
      expect((await within(dialog).findByTestId('refusal')).textContent).toBe(vi_[key]);
      cleanup();
    }
  });

  it('AC-ST-LND-005-2, UAT-PLAN-30, UI-LND-05: revises a plan that was posted with a reason, under its version, and says that the earlier revision stays readable', async () => {
    const h = client(worldOf(), () => ({ ...OK, resource_version: 1 }));
    mount(<PlanScreen route={ROUTE} />, h, { permissions: PLANNER, path: PATH });
    await ready();
    fireEvent.click(button(rowOf(2), 'lnd.plans.revise.aria', 'PA-0002'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByTestId('revise-note').textContent).toBe(vi_['lnd.plans.reviseDialog.note.text'].replace('{revision}', '2'));
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getByText(vi_['lnd.field.required.error'])).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.plans.reviseDialog.reason.label']), { target: { value: 'x'.repeat(2001) } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getByText(vi_['lnd.field.tooLong.error'])).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.plans.reviseDialog.reason.label']), { target: { value: 'a\u0007b' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getByText(vi_['lnd.field.invalid.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.plans.reviseDialog.reason.label']), { target: { value: '  Giá đất thay đổi  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.command).toHaveBeenCalledWith('revisePlan', expect.objectContaining({ path: { id: planRecord(2).id }, ifMatchVersion: 3, body: { reason: 'Giá đất thay đổi' } }));
  });

  it('says why the server refused the revision: the plan changed, or has items of units the reviser does not see', async () => {
    for (const [code, status, key] of [
      ['VERSION_CONFLICT', 409, 'lnd.problem.versionConflict.error'],
      ['SCOPE_DENIED', 403, 'lnd.plans.problem.scopeDenied.error'],
      ['RESOURCE_NOT_FOUND', 404, 'lnd.problem.notFound.error'],
      ['VALIDATION_FAILED', 422, 'lnd.problem.validation.error'],
    ] as const) {
      const h = client(worldOf(), () => problem(code, status));
      mount(<PlanScreen route={ROUTE} />, h, { permissions: PLANNER, path: PATH });
      await ready();
      fireEvent.click(button(rowOf(2), 'lnd.plans.revise.aria', 'PA-0002'));
      const dialog = screen.getByRole('dialog');
      fireEvent.change(within(dialog).getByLabelText(vi_['lnd.plans.reviseDialog.reason.label']), { target: { value: 'Giá đất thay đổi' } });
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
      expect((await within(dialog).findByTestId('refusal')).textContent).toBe(vi_[key]);
      cleanup();
    }
  });
});
