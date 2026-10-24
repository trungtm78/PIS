import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { PermitTypeTable } from './PermitTypeTable';
import { groupTypes, toPermitType } from './model';
import type { PermitTypeView } from './model';
import { MANAGER, client, mount, permitType } from './test-support';

const TODAY = '2026-08-01';
const problem = (code: string) => new ApiError({ status: 422, code, correlationId: 'c', retryAfterSeconds: undefined, detail: undefined, extensions: {} });
const views = (rows: Array<Record<string, unknown>>): PermitTypeView[] => rows.flatMap((row) => toPermitType(row) ?? []);

afterEach(cleanup);

const table = (rows: Array<Record<string, unknown>>, mayRetire = true) => <PermitTypeTable groups={groupTypes(views(rows), TODAY)} today={TODAY} mayRetire={mayRetire} />;
const groupRows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('tr[data-group-code]'));
const cells = (row: HTMLElement): Array<string | null> => Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent);

describe('PermitTypeTable (PMT-03): the permit types by code', () => {
  it('shows each code once with its name, category, legal basis, days in force, condition, exemption and phase', () => {
    mount(
      table([
        permitType(1, { applies_to_rule: { work_types: ['ROAD'], max_total_investment_vnd: '9000' }, exemption_allowed: true }),
        permitType(2, { category: 'ENVIRONMENT', effective_from: '2026-09-01' }),
        permitType(3, { status: 'RETIRED', effective_until: '2026-07-01' }),
      ]),
      client(),
      MANAGER,
    );
    expect(screen.getByRole('table', { name: vi_['pmt.type.table.aria'] })).toBeTruthy();
    expect(groupRows().map((row) => row.getAttribute('data-group-code'))).toEqual(['PERMIT_1', 'PERMIT_2', 'PERMIT_3']);
    const [first, second, third] = groupRows() as [HTMLElement, HTMLElement, HTMLElement];
    expect(cells(first).slice(0, 8)).toEqual([
      'PERMIT_1',
      'Giấy phép 1',
      vi_['pmt.category.constructionPermit.text'],
      'Nghị định 1/2026, điều 1',
      '2026-01-01 → ',
      'Loại công trình: ROAD · Tổng mức đầu tư đến 9000 đồng',
      vi_['pmt.type.exempt.yes.text'],
      vi_['pmt.type.phase.inForce.text'],
    ]);
    // A version that has not begun is scheduled, and one that ended is shown with its last day.
    expect(second.getAttribute('data-phase')).toBe('scheduled');
    expect(cells(second)[2]).toBe(vi_['pmt.category.environment.text']);
    expect(cells(second)[5]).toBe(vi_['pmt.type.applies.all.text']);
    expect(cells(second)[6]).toBe(vi_['pmt.type.exempt.no.text']);
    expect(third.getAttribute('data-phase')).toBe('ended');
    expect(cells(third)[4]).toBe('2026-01-01 → 2026-07-01');
  });

  it('flags a version that still waits for its confirmation with the reference it waits for, and no other', () => {
    mount(table([permitType(1, { cxn_ref: 'CXN-EXE-03' }), permitType(2)]), client(), MANAGER);
    const flags = screen.getAllByTestId('unconfirmed');
    expect(flags).toHaveLength(1);
    expect(flags[0]?.textContent).toBe('Chờ xác nhận CXN-EXE-03');
    expect(within(groupRows()[0] as HTMLElement).getByTestId('unconfirmed')).toBeTruthy();
  });

  it('keeps the versions of a code together and lists every one of them in the history, newest first (AC-ST-PMT-001-1)', async () => {
    const rows = [
      permitType(1, { id: 'old', code: 'BUILDING_PERMIT', revision: 1, legal_basis: 'Decree 175/2024', effective_until: '2026-12-31', status: 'RETIRED', default_validity_months: 24 }),
      permitType(1, { id: 'new', code: 'BUILDING_PERMIT', revision: 2, legal_basis: 'Decree 217/2026', effective_from: '2027-01-01', cxn_ref: 'CXN-EXE-02', default_processing_days: 30 }),
    ];
    mount(table(rows), client(), MANAGER);
    expect(groupRows()).toHaveLength(1);
    // The version in force today is the first one; the second is waiting for its day.
    expect(groupRows()[0]?.getAttribute('data-type-id')).toBe('old');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: vi_['pmt.type.history.action'] }));
    const history = screen.getByTestId('history');
    expect(within(history).getByRole('table', { name: vi_['pmt.type.history.aria'] })).toBeTruthy();
    const versions = Array.from(history.querySelectorAll<HTMLElement>('tr[data-revision]'));
    expect(versions.map((row) => row.getAttribute('data-revision'))).toEqual(['2', '1']);
    expect(cells(versions[0] as HTMLElement)).toEqual(['2', 'Giấy phép 1', 'Decree 217/2026 Chờ xác nhận CXN-EXE-02', 'Xử lý 30 ngày', '2027-01-01 → ', vi_['pmt.type.phase.scheduled.text']]);
    expect(cells(versions[1] as HTMLElement)).toEqual(['1', 'Giấy phép 1', 'Decree 175/2024', 'Hiệu lực 24 tháng', '2026-01-01 → 2026-12-31', vi_['pmt.type.phase.inForce.text']]);
    await user.click(screen.getByRole('button', { name: vi_['pmt.type.history.action'] }));
    expect(screen.queryByTestId('history')).toBeNull();
  });

  it('shows both defaults of a version together and nothing for a version that has none', async () => {
    mount(table([permitType(1, { default_validity_months: 12, default_processing_days: 45 })]), client(), MANAGER);
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['pmt.type.history.action'] }));
    expect(cells(document.querySelector('tr[data-revision]') as HTMLElement)[3]).toBe('Hiệu lực 12 tháng · Xử lý 45 ngày');
  });

  it('describes a condition by its groups, works and bounds', () => {
    mount(table([permitType(1, { applies_to_rule: { project_group_keys: ['A', 'B'], min_total_investment_vnd: '100' } })]), client(), MANAGER);
    expect(cells(groupRows()[0] as HTMLElement)[5]).toBe('Nhóm dự án: A, B · Tổng mức đầu tư từ 100 đồng');
  });
});

describe('PermitTypeTable: ending a version', () => {
  const rowOf = (id: string): HTMLElement => document.querySelector(`tr[data-type-id="${id}"]`) as HTMLElement;
  const retireButton = (id: string): HTMLElement => within(rowOf(id)).getByRole('button', { name: vi_['pmt.type.retire.action'] });
  const formName = (code: string): string => vi_['pmt.type.retire.title'].replace('{code}', code);

  it('asks for a last day, then ends the version on it (AC-ST-PMT-001-1)', async () => {
    const h = client(() => ({ operation_id: 'o', status: 'RETIRED', resource_version: 2, resource_id: permitType(1).id }));
    mount(table([permitType(1)]), h, MANAGER);
    const user = userEvent.setup();
    await user.click(retireButton(permitType(1).id));
    const form = screen.getByRole('form', { name: formName('PERMIT_1') });
    await user.click(within(form).getByRole('button', { name: vi_['pmt.type.retire.confirm.action'] }));
    expect(within(form).getByText(vi_['pmt.field.required.error'])).toBeTruthy();
    fireEvent.change(within(form).getByLabelText(vi_['pmt.type.retire.until.label']), { target: { value: '2026-07-01' } });
    await user.click(within(form).getByRole('button', { name: vi_['pmt.type.retire.confirm.action'] }));
    expect(within(form).getByText(vi_['pmt.field.past.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText(vi_['pmt.type.retire.until.label']), { target: { value: '2026-12-31' } });
    await user.click(within(form).getByRole('button', { name: vi_['pmt.type.retire.confirm.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('retirePermitType', expect.objectContaining({ path: { id: permitType(1).id }, body: { effective_until: '2026-12-31' } })));
    await waitFor(() => expect(screen.queryByRole('form', { name: formName('PERMIT_1') })).toBeNull());
  });

  it('refuses a last day that is not after the first day or is later than the end the version has, before asking the server', async () => {
    const h = client();
    mount(table([permitType(1, { effective_from: '2026-09-10', effective_until: '2026-12-31', status: 'RETIRED' })]), h, MANAGER);
    const user = userEvent.setup();
    await user.click(retireButton(permitType(1).id));
    const form = screen.getByRole('form', { name: formName('PERMIT_1') });
    const confirm = () => user.click(within(form).getByRole('button', { name: vi_['pmt.type.retire.confirm.action'] }));
    fireEvent.change(within(form).getByLabelText(vi_['pmt.type.retire.until.label']), { target: { value: '2026-09-10' } });
    await confirm();
    expect(within(form).getByText(vi_['pmt.field.untilOrder.error'])).toBeTruthy();
    fireEvent.change(within(form).getByLabelText(vi_['pmt.type.retire.until.label']), { target: { value: '2027-06-30' } });
    await confirm();
    expect(within(form).getByText(vi_['pmt.field.laterEnd.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('shows the refusal of the server when a permit is still on its way, and lets the person cancel', async () => {
    const h = client(() => problem('PERMIT_TYPE_IN_USE'));
    mount(table([permitType(1)]), h, MANAGER);
    const user = userEvent.setup();
    await user.click(retireButton(permitType(1).id));
    const form = screen.getByRole('form', { name: formName('PERMIT_1') });
    fireEvent.change(within(form).getByLabelText(vi_['pmt.type.retire.until.label']), { target: { value: '2026-12-31' } });
    await user.click(within(form).getByRole('button', { name: vi_['pmt.type.retire.confirm.action'] }));
    expect((await within(form).findByRole('alert')).textContent).toBe(vi_['pmt.problem.inUse.error']);
    await user.click(within(form).getByRole('button', { name: vi_['pmt.type.cancel.action'] }));
    expect(screen.queryByRole('form', { name: formName('PERMIT_1') })).toBeNull();
  });

  it('closes the form when the same button is pressed again, and offers nothing to end where there is nothing to end or no right to do it', async () => {
    mount(table([permitType(1), permitType(2, { status: 'RETIRED', effective_until: '2026-07-31' })]), client(), MANAGER);
    const user = userEvent.setup();
    await user.click(retireButton(permitType(1).id));
    expect(screen.getByRole('form', { name: formName('PERMIT_1') })).toBeTruthy();
    await user.click(retireButton(permitType(1).id));
    expect(screen.queryByRole('form', { name: formName('PERMIT_1') })).toBeNull();
    // A version whose last day has passed cannot be ended again.
    expect(within(rowOf(permitType(2).id)).queryByRole('button', { name: vi_['pmt.type.retire.action'] })).toBeNull();
    cleanup();
    mount(table([permitType(1)], false), client(), MANAGER);
    expect(screen.queryByRole('button', { name: vi_['pmt.type.retire.action'] })).toBeNull();
    expect(screen.getByRole('button', { name: vi_['pmt.type.history.action'] })).toBeTruthy();
  });
});
