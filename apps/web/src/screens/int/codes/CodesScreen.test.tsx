import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../../i18n';
import { clientFor, codePage, codeRow, mount, problem, routeFor, systemRow } from '../test-support';
import CodesScreen from './CodesScreen';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const route = routeFor('INT-03', 'FR-INT-03');
const REASON = 'Khớp theo quyết định đầu tư';
const SYSTEMS = { items: [systemRow(1)], kinds: ['ERP'], can_register: true, as_of: '2026-11-12T03:00:00.000Z' };

function mountWith(options: { codes?: unknown; systems?: unknown; command?: (operation: string, input: unknown) => unknown; mode?: 'FULL' | 'READ_ONLY' } = {}) {
  const h = clientFor(
    {
      listProjectCodes: options.codes ?? codePage([codeRow(1), codeRow(2, { status: 'ACTIVE', approved_by_name: 'Trần Thị Bình', approved_at: '2026-11-02T03:00:00.000Z', actions: { decide: false, retire: true } })]),
      listSourceSystems: options.systems ?? SYSTEMS,
    },
    options.command,
  );
  mount(<CodesScreen route={route} />, h, { permissions: undefined, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

const rowOf = (n: number): HTMLElement => document.querySelector(`[data-code-id="00000000-0000-4000-8000-00d0${String(n).padStart(8, '0')}"]`) as HTMLElement;
const rowsShown = async (): Promise<void> => {
  await waitFor(() => expect(document.querySelector('[data-code-id]')).not.toBeNull());
};

describe('CodesScreen (INT-03): the codes of our projects in other systems', () => {
  it('UI-INT-03: shows the note on the crosswalk, the systems and the columns of the catalogue', async () => {
    mountWith();
    await rowsShown();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(t('int.codes.page.title'));
    expect(screen.getByTestId('crosswalk-note').textContent).toBe(t('int.codes.note.crosswalk'));
    const table = screen.getByRole('table', { name: t('int.codes.table.caption') });
    expect(Array.from(table.querySelectorAll('thead th')).map((cell) => cell.textContent)).toEqual(['system', 'ours', 'external', 'validity', 'status', 'people', 'actions'].map((column) => t(`int.codes.column.${column}` as never)));
    await waitFor(() => expect(document.querySelector('[data-system="EBS"]')).not.toBeNull());
  });

  it('shows who proposed and who decided, and offers the decision only where the server says it may be taken', async () => {
    mountWith();
    await rowsShown();
    expect(within(rowOf(1)).getByTestId('proposed-by').textContent).toBe(t('int.codes.cell.proposed', { name: 'Nguyễn Văn An', day: '01/11/2026' }));
    expect(within(rowOf(1)).getByRole('button', { name: t('int.codes.action.approve.label', { code: 'PRJ-1', external: 'P-101' }) })).toBeTruthy();
    expect(within(rowOf(2)).queryByRole('button', { name: t('int.codes.action.approve.label', { code: 'PRJ-2', external: 'P-102' }) })).toBeNull();
    expect(within(rowOf(2)).getByRole('button', { name: t('int.codes.action.retire.label', { code: 'PRJ-2', external: 'P-102' }) })).toBeTruthy();
    expect(within(rowOf(2)).getByTestId('decided-by').textContent).toBe(t('int.codes.cell.approved', { name: 'Trần Thị Bình', day: '02/11/2026' }));
  });

  it('says that a proposal the viewer made waits for another person', async () => {
    mountWith({ codes: codePage([codeRow(1, { actions: { decide: false, retire: false } })]) });
    await rowsShown();
    expect(within(rowOf(1)).getByText(t('int.codes.row.waiting'))).toBeTruthy();
  });

  it('shows the empty, error, denied and read-only states', async () => {
    mountWith({ codes: codePage([]) });
    expect(await screen.findByTestId('empty')).toBeTruthy();
    cleanup();
    mountWith({ codes: new Error('x'), systems: new Error('y') });
    await waitFor(() => expect(screen.getAllByTestId('error').length).toBeGreaterThan(0));
    cleanup();
    mountWith({ codes: problem('SCOPE_DENIED', 403) });
    expect(await screen.findByTestId('denied')).toBeTruthy();
    cleanup();
    mountWith({ codes: codePage([codeRow(1, { actions: { decide: false, retire: false } })], { can_propose: false }) });
    expect(await screen.findByTestId('readonly-note')).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('int.codes.action.propose') })).toBeNull();
  });

  it('offers nothing to a frozen session', async () => {
    mountWith({ mode: 'READ_ONLY' });
    await rowsShown();
    expect(screen.queryByRole('button', { name: t('int.codes.action.propose') })).toBeNull();
    expect(within(rowOf(1)).queryByRole('button', { name: t('int.codes.action.approve.label', { code: 'PRJ-1', external: 'P-101' }) })).toBeNull();
  });

  it('checks the code against the format of the system before it sends, then proposes it', async () => {
    const command = vi.fn(() => codeRow(9));
    mountWith({ command });
    fireEvent.click(await screen.findByRole('button', { name: t('int.codes.action.propose') }));
    const dialog = await screen.findByRole('dialog', { name: t('int.codes.propose.title') });
    fireEvent.change(within(dialog).getByLabelText(t('int.codes.field.ours.label')), { target: { value: 'PRJ-1' } });
    fireEvent.change(within(dialog).getByLabelText(t('int.codes.field.external.label')), { target: { value: 'WRONG' } });
    fireEvent.change(within(dialog).getByLabelText(new RegExp(t('int.common.dialog.reason.label'))), { target: { value: REASON } });
    fireEvent.click(within(dialog).getByRole('button', { name: t('int.codes.propose.confirm.action') }));
    expect(within(dialog).getByText(t('int.codes.error.external'))).toBeTruthy();
    expect(command).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(t('int.codes.field.external.label')), { target: { value: 'P-555' } });
    fireEvent.click(within(dialog).getByRole('button', { name: t('int.codes.propose.confirm.action') }));
    await waitFor(() => expect(command).toHaveBeenCalledWith('proposeProjectCode', expect.objectContaining({ body: { source_system: 'EBS', our_code: 'PRJ-1', external_code: 'P-555', reason: REASON } })));
    await waitFor(() => expect(screen.getByTestId('receipt').textContent).toBe(t('int.codes.success.proposed', { code: 'PRJ-1', external: 'P-555' })));
  });

  it('says why a duplicate was refused and why a decision by the maker is refused', async () => {
    const command = vi.fn((operation: string) => (operation === 'proposeProjectCode' ? problem('CROSSWALK_DUPLICATE', 409, { reason: 'EXTERNAL_CODE_TAKEN' }) : problem('SELF_APPROVAL_DENIED', 403)));
    mountWith({ command });
    fireEvent.click(await screen.findByRole('button', { name: t('int.codes.action.propose') }));
    const dialog = await screen.findByRole('dialog', { name: t('int.codes.propose.title') });
    fireEvent.change(within(dialog).getByLabelText(t('int.codes.field.ours.label')), { target: { value: 'PRJ-1' } });
    fireEvent.change(within(dialog).getByLabelText(t('int.codes.field.external.label')), { target: { value: 'P-555' } });
    fireEvent.change(within(dialog).getByLabelText(new RegExp(t('int.common.dialog.reason.label'))), { target: { value: REASON } });
    fireEvent.click(within(dialog).getByRole('button', { name: t('int.codes.propose.confirm.action') }));
    await waitFor(() => expect(within(dialog).getAllByText(t('int.common.problem.duplicateTaken')).length).toBeGreaterThan(0));
    fireEvent.click(within(dialog).getByRole('button', { name: t('int.common.dialog.cancel.action') }));
    await rowsShown();
    fireEvent.click(within(rowOf(1)).getByRole('button', { name: t('int.codes.action.approve.label', { code: 'PRJ-1', external: 'P-101' }) }));
    const decide = await screen.findByRole('dialog', { name: t('int.codes.approve.title') });
    fireEvent.change(within(decide).getByLabelText(new RegExp(t('int.common.dialog.reason.label'))), { target: { value: REASON } });
    fireEvent.click(within(decide).getByRole('button', { name: t('int.codes.approve.confirm.action') }));
    await waitFor(() => expect(within(decide).getAllByText(t('int.common.problem.selfApproval')).length).toBeGreaterThan(0));
    expect(command).toHaveBeenCalledWith('decideProjectCode', expect.objectContaining({ body: { decision: 'APPROVE', reason: REASON }, ifMatchVersion: 1 }));
  });

  it('registers a system with the format of its codes', async () => {
    const command = vi.fn(() => systemRow(2));
    mountWith({ command });
    fireEvent.click(await screen.findByRole('button', { name: t('int.codes.system.action.register') }));
    const dialog = await screen.findByRole('dialog', { name: t('int.codes.system.register.title') });
    fireEvent.click(within(dialog).getByRole('button', { name: t('int.codes.systemRegisterConfirm.action') }));
    expect(within(dialog).getByText(t('int.codes.system.error.code'))).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(t('int.codes.systemFieldCode.label')), { target: { value: 'hpm' } });
    fireEvent.change(within(dialog).getByLabelText(t('int.codes.systemFieldName.label')), { target: { value: 'Hyperion' } });
    fireEvent.change(within(dialog).getByLabelText(t('int.codes.systemFieldPattern.label')), { target: { value: '[A-Z]{2}-\\d{4}' } });
    fireEvent.click(within(dialog).getByRole('button', { name: t('int.codes.systemRegisterConfirm.action') }));
    await waitFor(() => expect(command).toHaveBeenCalledWith('registerSourceSystem', expect.objectContaining({ body: { code: 'HPM', name: 'Hyperion', kind: 'ERP', code_pattern: '[A-Z]{2}-\\d{4}' } })));
  });
});
