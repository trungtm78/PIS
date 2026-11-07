import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import AllocationGridScreen from './AllocationGridScreen';
import { ANNUAL_ID, MEDIUM_ID, PLAN_PLANNER, PLAN_READER, PUBLISHED_ID, mount, planClient, planLine, planWorld, routeOf } from './plan-test-support';
import type { PlanWorld } from './plan-test-support';

const ROUTE = routeOf('CAP-06', 'FR-CAP-06');
const problem = (code: string, status = 422, extensions: Record<string, unknown> = {}, detail?: string) => new ApiError({ status, code, correlationId: 'c', detail, extensions });
const answer = { operation_id: 'o', status: 'DRAFT', resource_version: 5, resource_id: ANNUAL_ID };

afterEach(cleanup);

// A line is the row of the table of the kit that holds a cell carrying its id.
const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('[data-line-id]')).flatMap((node) => (node.closest('tr') === null ? [] : [node.closest('tr') as HTMLElement]));
const ready = () => waitFor(() => expect(rows().length).toBeGreaterThan(0));
const amountInput = (code: string): HTMLInputElement => screen.getByLabelText(`Số tiền của dự án ${code} (triệu đồng)`) as HTMLInputElement;
const ctmtqgInput = (code: string): HTMLInputElement => screen.getByLabelText(`Phần CTMTQG của dự án ${code} (triệu đồng)`) as HTMLInputElement;
const type = (input: HTMLInputElement, value: string): void => {
  fireEvent.change(input, { target: { value } });
};
const save = (): HTMLButtonElement => screen.getByRole('button', { name: vi_['cap.grid.save.action'] }) as HTMLButtonElement;
const available = (index: number): string => rows()[index]?.querySelector('[data-testid="available"]')?.textContent ?? '';
const open = (world: PlanWorld, command?: (operation: string, input: unknown) => unknown, permissions: readonly string[] = PLAN_PLANNER, path = '/?plan=' + ANNUAL_ID) => {
  const h = planClient(world, command);
  mount(<AllocationGridScreen route={ROUTE} />, h, { permissions, path });
  return h;
};

describe('AllocationGridScreen (CAP-06): the allocation grid of a plan', () => {
  it('lists each line with the project, the source, the amount, what the source has left, and the committed and reserved amounts (UI-CAP-06)', async () => {
    open(planWorld());
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['cap.grid.page.title']);
    expect(Array.from(document.querySelectorAll('thead th')).map((header) => header.textContent)).toEqual([
      vi_['cap.grid.column.project'],
      vi_['cap.grid.column.fund'],
      vi_['cap.grid.column.amount'],
      vi_['cap.grid.column.ctmtqg'],
      vi_['cap.grid.column.available'],
      vi_['cap.grid.column.committed'],
      vi_['cap.grid.column.reserved'],
      vi_['cap.grid.column.avc'],
      vi_['cap.grid.column.actions'],
    ]);
    expect(amountInput('DA-01').value).toBe('1000');
    expect(ctmtqgInput('DA-01').value).toBe('400');
    expect(amountInput('DA-02').value).toBe('2000');
    // The source has 4,000 million left, for both lines (they draw on the same appropriation).
    expect(available(0)).toBe('4.000');
    expect(available(1)).toBe('4.000');
    // Nothing is committed or reserved before the plan is published; the AVC threshold is not set yet.
    expect(rows()[0]?.textContent).toContain(vi_['cap.grid.notPublished.notice']);
    expect(rows()[0]?.textContent).toContain(vi_['cap.grid.avc.notice']);
    expect(screen.getByTestId('total').textContent).toBe('3.000');
    expect(save().disabled).toBe(true);
  });

  it('follows the remaining ceiling as amounts are typed, refuses to save what the source cannot hold, and gives capital back when an amount is lowered (AC-ST-CAP-002-1, UAT-AC08)', async () => {
    open(planWorld());
    await ready();
    type(amountInput('DA-01'), '4000');
    expect(available(0)).toBe('1.000');
    expect(save().disabled).toBe(false);
    type(amountInput('DA-02'), '4000');
    // 3,000 more than before on one line and 2,000 on the other: the source is 1,000 million short.
    expect(available(0)).toContain('-1.000');
    expect(rows()[0]?.querySelector('[data-testid="available"]')?.getAttribute('data-exceeded')).toBe('true');
    expect(rows()[0]?.textContent).toContain(vi_['cap.grid.exceeded.error']);
    expect(save().disabled).toBe(true);
    expect(screen.getByTestId('total').textContent).toBe('8.000');
    type(amountInput('DA-02'), '1000');
    expect(available(1)).toBe('2.000');
    expect(save().disabled).toBe(false);
    expect(screen.getByTestId('total').textContent).toBe('5.000');
  });

  it('judges the amount typed: not an amount, and a CTMTQG part larger than the line', async () => {
    open(planWorld());
    await ready();
    type(amountInput('DA-01'), '1.000');
    expect(rows()[0]?.textContent).toContain(vi_['cap.grid.invalidAmount.error']);
    expect(save().disabled).toBe(true);
    type(amountInput('DA-01'), '300');
    expect(rows()[0]?.textContent).toContain(vi_['cap.grid.subsetExceeds.error']);
    expect(save().disabled).toBe(true);
    type(ctmtqgInput('DA-01'), '300');
    expect(rows()[0]?.textContent).not.toContain(vi_['cap.grid.subsetExceeds.error']);
    expect(save().disabled).toBe(false);
  });

  it('saves the lines that changed with the version of the plan, as exact VND, and says so (AC-ST-CAP-002-6)', async () => {
    const h = open(planWorld(), () => answer);
    await ready();
    type(amountInput('DA-01'), '1500');
    type(ctmtqgInput('DA-01'), '600');
    fireEvent.click(save());
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    const [operation, input] = h.command.mock.calls[0] as [string, { path: { id: string }; ifMatchVersion: number; body: { lines: Array<Record<string, unknown>> } }];
    expect(operation).toBe('draftCapitalAllocation');
    expect(input.path).toEqual({ id: ANNUAL_ID });
    expect(input.ifMatchVersion).toBe(4);
    expect(input.body).toEqual({
      lines: [{ project_id: expect.any(String), appropriation_id: expect.any(String), bucket: 'CURRENT_YEAR', source_year: 2026, amount_vnd: '1500000000', ctmtqg_subset_vnd: '600000000' }],
    });
    await waitFor(() => expect(screen.getByTestId('saved')).toBeTruthy());
  });

  it('removes a line: only the removal is sent, and the removed line gives its capital back', async () => {
    const h = open(planWorld(), () => answer);
    await ready();
    fireEvent.click(within(rows()[1] as HTMLElement).getByRole('button', { name: vi_['cap.grid.remove.action'] }));
    expect(rows()[1]?.querySelector('[data-removed]')?.getAttribute('data-removed')).toBe('true');
    expect(available(0)).toBe('6.000');
    expect(amountInput('DA-02').disabled).toBe(true);
    expect(screen.getByTestId('total').textContent).toBe('1.000');
    fireEvent.click(save());
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    const input = h.command.mock.calls[0]?.[1] as { body: { lines: Array<Record<string, unknown>>; remove_line_ids: string[] } };
    expect(input.body.remove_line_ids).toEqual([(planWorld().lines[ANNUAL_ID]?.[1] as { id: string }).id]);
    expect(input.body.lines).toEqual([]);
    // A removal can be taken back.
    cleanup();
    open(planWorld());
    await ready();
    fireEvent.click(within(rows()[1] as HTMLElement).getByRole('button', { name: vi_['cap.grid.remove.action'] }));
    fireEvent.click(within(rows()[1] as HTMLElement).getByRole('button', { name: vi_['cap.grid.restore.action'] }));
    expect(rows()[1]?.querySelector('[data-removed]')?.getAttribute('data-removed')).toBe('false');
    expect(save().disabled).toBe(true);
  });

  it('removes every line of a plan in one save: the command carries no line and the ids to remove (CR-CAP-01)', async () => {
    const h = open(planWorld(), () => answer);
    await ready();
    for (const row of rows()) fireEvent.click(within(row).getByRole('button', { name: vi_['cap.grid.remove.action'] }));
    expect(screen.getByTestId('total').textContent).toBe('0');
    expect(save().disabled).toBe(false);
    fireEvent.click(save());
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    const input = h.command.mock.calls[0]?.[1] as { body: { lines: unknown[]; remove_line_ids: string[] } };
    expect(input.body.lines).toEqual([]);
    expect(input.body.remove_line_ids).toHaveLength(2);
  });

  it('shows what the server refused: the ceiling with what is available, a plan that moved on, a stale version, a project that no longer takes capital', async () => {
    const refusals: Array<[ApiError, string]> = [
      [problem('APPROPRIATION_EXCEEDED', 422, { available_vnd: '5000000000' }), 'Nguồn chỉ còn 5.000.000.000 đồng; không thể phân bổ quá số này.'],
      [problem('VERSION_CONFLICT', 409), vi_['cap.planProblem.versionConflict.error']],
      [problem('PLAN_NOT_DRAFT', 409), vi_['cap.planProblem.planNotDraft.error']],
      [problem('PROJECT_STAGE_INVALID', 422), vi_['cap.planProblem.stageInvalid.error']],
      [problem('SUBSET_EXCEEDS_PARENT', 422), vi_['cap.planProblem.subsetExceeds.error']],
      [problem('SCOPE_DENIED', 403), vi_['cap.planProblem.denied.error']],
    ];
    for (const [error, text] of refusals) {
      cleanup();
      open(planWorld(), () => error);
      await ready();
      type(amountInput('DA-01'), '1100');
      fireEvent.click(save());
      await waitFor(() => expect(screen.getByTestId('problem').textContent).toBe(text));
    }
  });

  it('disables every write once the server says the year is locked (UAT-AC230)', async () => {
    open(planWorld(), () => problem('FISCAL_YEAR_LOCKED', 409));
    await ready();
    type(amountInput('DA-01'), '1100');
    fireEvent.click(save());
    await waitFor(() => expect(screen.getByTestId('year-locked')).toBeTruthy());
    expect(screen.queryByRole('button', { name: vi_['cap.grid.save.action'] })).toBeNull();
    expect(screen.queryByLabelText('Số tiền của dự án DA-01 (triệu đồng)')).toBeNull();
    expect(screen.getByTestId('problem').textContent).toBe(vi_['cap.planProblem.yearLocked.error']);
  });

  it('shows a published plan as it stands, with the committed and reserved amounts and nothing to edit', async () => {
    open(planWorld(), undefined, PLAN_PLANNER, '/?plan=' + PUBLISHED_ID);
    await ready();
    expect(screen.getByTestId('not-draft')).toBeTruthy();
    expect(screen.queryByRole('button', { name: vi_['cap.grid.save.action'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['cap.grid.remove.action'] })).toBeNull();
    expect(rows()[0]?.textContent).toContain('500');
    expect(rows()[0]?.textContent).toContain('100');
  });

  it('is read only for a caller who cannot draft, and for a frozen tenant', async () => {
    open(planWorld(), undefined, PLAN_READER);
    await ready();
    expect(screen.queryByRole('button', { name: vi_['cap.grid.save.action'] })).toBeNull();
    expect(screen.getByText(vi_['cap.readOnly.denied.notice'])).toBeTruthy();
    cleanup();
    const h = planClient(planWorld());
    mount(<AllocationGridScreen route={ROUTE} />, h, { permissions: PLAN_PLANNER, mode: 'READ_ONLY', path: '/?plan=' + ANNUAL_ID });
    await ready();
    expect(screen.queryByRole('button', { name: vi_['cap.grid.save.action'] })).toBeNull();
    expect(screen.getByText(vi_['cap.readOnly.frozen.notice'])).toBeTruthy();
  });

  it('works on the plan the address names, offers all the plans, and starts the edits over for another plan', async () => {
    open(planWorld());
    await ready();
    type(amountInput('DA-01'), '1100');
    expect(within(screen.getByLabelText(vi_['cap.planChooser.label'])).getAllByRole('option')).toHaveLength(3);
    fireEvent.change(screen.getByLabelText(vi_['cap.planChooser.label']), { target: { value: MEDIUM_ID } });
    await waitFor(() => expect(screen.getByTestId('plan-header').getAttribute('data-plan-id')).toBe(MEDIUM_ID));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(amountInput('DA-01').value).toBe('1000');
    expect(save().disabled).toBe(true);
  });

  it('keeps a line that draws on no appropriation read only, and says there is no source', async () => {
    const world = planWorld();
    world.lines[ANNUAL_ID] = [planLine(1, { appropriation: null }), planLine(2)];
    open(world);
    await ready();
    expect(amountInput('DA-01').disabled).toBe(true);
    expect(rows()[0]?.textContent).toContain(vi_['cap.grid.noSource.notice']);
    expect(amountInput('DA-02').disabled).toBe(false);
  });

  it('says when the plan has no line the caller may see, and shows the error state of a failed read', async () => {
    const world = planWorld();
    world.lines[ANNUAL_ID] = [];
    open(world);
    await waitFor(() => expect(screen.getByTestId('no-lines')).toBeTruthy());
    cleanup();
    const broken = planWorld();
    broken.failing.set('get_resources_plan_version', new Error('boom'));
    open(broken);
    await waitFor(() => expect(screen.getByText(vi_['states.error.title'])).toBeTruthy());
  });
});
