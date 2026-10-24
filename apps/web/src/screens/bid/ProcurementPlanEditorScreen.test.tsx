import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import ProcurementPlanEditorScreen from './ProcurementPlanEditorScreen';
import { BOTH, LINE, PLANNER, PROJECT, READER, client, mount, pack, plan, planId, routeOf, world } from './plan-test-support';

const ROUTE = routeOf('BID-16', 'FR-BID-16');
const OK = { operation_id: 'o', status: 'DRAFT', resource_version: 1, resource_id: planId(3) };
const problem = (code: string, status = 422, extensions: Record<string, unknown> = {}, detail?: string) =>
  new ApiError({ status, code, correlationId: 'c', extensions, ...(detail === undefined ? {} : { detail }) });

afterEach(cleanup);

const set = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
const form = () => screen.findByTestId('plan-form');
const send = () => userEvent.click(screen.getByRole('button', { name: vi_['bid.editor.submit.action'] }));

describe('ProcurementPlanEditorScreen (BID-16): drafting and revising a procurement plan', () => {
  async function fillFirstRow(code = 'GT-1'): Promise<void> {
    const row = screen.getAllByTestId('package-row')[0] as HTMLElement;
    const field = (label: string) => within(row).getByLabelText(label);
    fireEvent.change(field(vi_['bid.editor.row.code']), { target: { value: code } });
    fireEvent.change(field(vi_['bid.editor.row.title.label']), { target: { value: 'Gói thầu xây lắp' } });
    fireEvent.change(field(vi_['bid.editor.row.budget']), { target: { value: '18000000000' } });
    fireEvent.change(field(vi_['bid.editor.row.line']), { target: { value: LINE } });
    fireEvent.change(field(vi_['bid.editor.row.period']), { target: { value: '2026-Q4' } });
    fireEvent.change(field(vi_['bid.editor.row.duration']), { target: { value: '180' } });
  }

  it('names every empty field of the form and the first package and sends nothing (UI-BID-16)', async () => {
    const h = client(world(), () => OK);
    mount(<ProcurementPlanEditorScreen route={ROUTE} />, h, { permissions: PLANNER });
    await form();
    await send();
    expect(screen.getAllByText(vi_['bid.planField.required.error']).length).toBeGreaterThanOrEqual(9);
    expect(h.command).not.toHaveBeenCalled();
  });

  it('sends the allowlisted body, shows the running total beside the packages and offers the plan once drafted (UI-BID-16)', async () => {
    const h = client(world(), () => OK);
    mount(<ProcurementPlanEditorScreen route={ROUTE} />, h, { permissions: PLANNER });
    await form();
    set(vi_['bid.editor.project.label'], PROJECT.toUpperCase());
    set(vi_['bid.editor.title.label'], ' Kế hoạch lựa chọn nhà thầu 2026 ');
    set(vi_['bid.editor.basis.label'], 'Luật Đấu thầu 22/2023/QH15');
    await fillFirstRow();
    expect(screen.getByTestId('running-total').textContent).toBe('Tổng giá gói: 18.000.000.000 đồng');
    await send();
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('createProcurementPlan');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({
      body: {
        project_id: PROJECT,
        title: 'Kế hoạch lựa chọn nhà thầu 2026',
        legal_basis: 'Luật Đấu thầu 22/2023/QH15',
        packages: [
          {
            code: 'GT-1',
            title: 'Gói thầu xây lắp',
            budget_vnd: '18000000000',
            method: 'OPEN_BIDDING',
            contract_type: 'LUMP_SUM',
            bidding_form: 'ONLINE',
            allocation_line_id: LINE,
            planned_start_period: '2026-Q4',
            duration_days: 180,
          },
        ],
      },
    });
    const done = await screen.findByTestId('create-done');
    expect(within(done).getByRole('link', { name: vi_['bid.editor.open.link'] }).getAttribute('href')).toBe(`/bid/bid-15?plan=${planId(3)}`);
  });

  it('adds and removes packages, keeps one, refuses a repeated code and takes the other choices of a package', async () => {
    const h = client(world(), () => OK);
    mount(<ProcurementPlanEditorScreen route={ROUTE} />, h, { permissions: PLANNER });
    await form();
    expect((screen.getByRole('button', { name: vi_['bid.editor.row.remove'] }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: vi_['bid.editor.row.add'] }));
    expect(screen.getAllByTestId('package-row')).toHaveLength(2);
    set(vi_['bid.editor.project.label'], PROJECT);
    set(vi_['bid.editor.title.label'], 'Kế hoạch lựa chọn nhà thầu');
    set(vi_['bid.editor.basis.label'], 'Luật Đấu thầu');
    await fillFirstRow('SAME');
    const second = screen.getAllByTestId('package-row')[1] as HTMLElement;
    for (const [label, value] of [
      [vi_['bid.editor.row.code'], 'SAME'],
      [vi_['bid.editor.row.title.label'], 'Gói thầu thứ hai'],
      [vi_['bid.editor.row.budget'], '10000000000'],
      [vi_['bid.editor.row.line'], LINE],
      [vi_['bid.editor.row.period'], '2026-11'],
      [vi_['bid.editor.row.duration'], '90'],
      [vi_['bid.editor.row.method'], 'DIRECT_PURCHASE'],
      [vi_['bid.editor.row.contractType'], 'TIME_BASED'],
      [vi_['bid.editor.row.form'], 'OFFLINE'],
    ] as const) {
      fireEvent.change(within(second).getByLabelText(label), { target: { value } });
    }
    expect(screen.getByTestId('running-total').textContent).toBe('Tổng giá gói: 28.000.000.000 đồng');
    await send();
    expect(within(second).getByText(vi_['bid.planField.duplicateCode.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(second).getByLabelText(vi_['bid.editor.row.code']), { target: { value: 'OTHER' } });
    await send();
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    const packages = (h.command.mock.calls[0]?.[1] as { body: { packages: Array<Record<string, unknown>> } }).body.packages;
    expect(packages[1]).toMatchObject({ code: 'OTHER', method: 'DIRECT_PURCHASE', contract_type: 'TIME_BASED', bidding_form: 'OFFLINE', planned_start_period: '2026-11', duration_days: 90 });
    await userEvent.click(screen.getAllByRole('button', { name: vi_['bid.editor.row.remove'] })[0] as HTMLElement);
    expect(screen.getAllByTestId('package-row')).toHaveLength(1);
  });

  it('starts a revision from the project, the text and the packages of the plan it revises (UI-BID-16)', async () => {
    const base = plan(1, { status: 'APPROVED' });
    const h = client(world({ plans: [base], packages: [pack(1, 1), pack(2, 1), pack(3, null)] }), () => OK);
    mount(<ProcurementPlanEditorScreen route={ROUTE} />, h, { permissions: PLANNER, path: `/bid/bid-16?revise=${planId(1)}` });
    expect(await screen.findByRole('heading', { level: 1, name: vi_['bid.editor.revise.title'] })).toBeTruthy();
    await waitFor(() => expect(screen.getAllByTestId('package-row')).toHaveLength(2));
    expect((screen.getByLabelText(vi_['bid.editor.project.label']) as HTMLInputElement).value).toBe(PROJECT);
    expect((screen.getByLabelText(vi_['bid.editor.title.label']) as HTMLInputElement).value).toBe(base.title);
    expect(screen.getByTestId('running-total').textContent).toBe('Tổng giá gói: 28.000.000.000 đồng');
    await send();
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect((h.command.mock.calls[0]?.[1] as { body: { packages: unknown[] } }).body.packages).toHaveLength(2);
  });

  it('offers the projects and the published lines of the project as suggestions, and still works when the caller may not read them', async () => {
    mount(<ProcurementPlanEditorScreen route={ROUTE} />, client(world()), { permissions: PLANNER });
    await form();
    await waitFor(() => expect(document.querySelectorAll('#plan-projects option')).toHaveLength(1));
    set(vi_['bid.editor.project.label'], PROJECT);
    await waitFor(() => expect(document.querySelectorAll('#plan-lines option')).toHaveLength(1));
    expect(document.querySelector('#plan-lines option')?.textContent).toBe('Ngân sách trung ương 2026 30.000.000.000');
    cleanup();
    mount(<ProcurementPlanEditorScreen route={ROUTE} />, client(world({ failing: new Set(['get_resources_project', 'get_resources_allocation_line']) })), { permissions: PLANNER });
    await form();
    expect(document.querySelectorAll('#plan-projects option')).toHaveLength(0);
  });

  it('shows the refusal of the server in words: the budget check with its figures, the stage, a repeated code and a field', async () => {
    const excess = { lines: [{ allocation_line_id: LINE, allocated_vnd: '30000000000', packages_vnd: '33000000000', excess_vnd: '3000000000' }] };
    const refusals = [
      problem('PACKAGE_BUDGET_EXCEEDS_ALLOCATION', 422, excess),
      problem('PROJECT_STAGE_INVALID'),
      problem('PACKAGE_CODE_DUPLICATE', 409),
      problem('VALIDATION_FAILED', 422, {}, 'packages.0.method'),
    ];
    let call = 0;
    mount(<ProcurementPlanEditorScreen route={ROUTE} />, client(world(), () => refusals[call++]), { permissions: PLANNER });
    await form();
    set(vi_['bid.editor.project.label'], PROJECT);
    set(vi_['bid.editor.title.label'], 'Kế hoạch lựa chọn nhà thầu');
    set(vi_['bid.editor.basis.label'], 'Luật Đấu thầu');
    await fillFirstRow();
    await send();
    expect((await screen.findByTestId('create-refusal')).textContent).toContain(vi_['bid.planProblem.budgetExceeds.error']);
    expect(within(screen.getByTestId('excess-lines')).getByText('3.000.000.000')).toBeTruthy();
    // Changing the form clears the refusal; the next attempt is a new intention.
    set(vi_['bid.editor.title.label'], 'Kế hoạch lựa chọn nhà thầu (sửa)');
    expect(screen.queryByTestId('create-refusal')).toBeNull();
    await send();
    expect((await screen.findByTestId('create-refusal')).textContent).toContain(vi_['bid.planProblem.stageInvalid.error']);
    set(vi_['bid.editor.title.label'], 'Kế hoạch lựa chọn nhà thầu (sửa 2)');
    await send();
    expect((await screen.findByTestId('create-refusal')).textContent).toContain(vi_['bid.planProblem.codeDuplicate.error']);
    set(vi_['bid.editor.title.label'], 'Kế hoạch lựa chọn nhà thầu (sửa 3)');
    await send();
    expect((await screen.findByTestId('create-refusal')).textContent).toContain('packages.0.method');
  });

  it('is read-only for a caller who may not plan, and for a read-only session (UI-BID-16)', async () => {
    mount(<ProcurementPlanEditorScreen route={ROUTE} />, client(world()), { permissions: READER });
    expect((await screen.findByTestId('read-only')).textContent).toBe(vi_['bid.editor.readOnly.notice']);
    expect(screen.queryByTestId('plan-form')).toBeNull();
    cleanup();
    mount(<ProcurementPlanEditorScreen route={ROUTE} />, client(world()), { permissions: BOTH, mode: 'READ_ONLY' });
    expect(await screen.findByTestId('read-only')).toBeTruthy();
  });
});
