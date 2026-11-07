import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import AnnualPlanScreen from './AnnualPlanScreen';
import { ANNUAL_ID, PLAN_PLANNER, PLAN_READER, PUBLISHED_ID, mount, planClient, planLine, planWorld, routeOf } from './plan-test-support';

const ROUTE = routeOf('CAP-03', 'FR-CAP-03');

afterEach(cleanup);

// A line is the row of the table of the kit that holds a cell carrying its id.
const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('[data-line-id]')).flatMap((node) => (node.closest('tr') === null ? [] : [node.closest('tr') as HTMLElement]));
const ready = () => waitFor(() => expect(rows().length).toBeGreaterThan(0));
const cell = (row: HTMLElement | undefined, index: number): string => row?.querySelectorAll('th, td')[index]?.textContent ?? '';

describe('AnnualPlanScreen (CAP-03): the lines of an annual plan', () => {
  it('lists each line by project with the capital of the year, the carried-over capital, the source year, the extension and the CTMTQG part (UI-CAP-03, AC-ST-CAP-002-3, UAT-AC222)', async () => {
    mount(<AnnualPlanScreen route={ROUTE} />, planClient(planWorld()), { permissions: PLAN_READER, path: '/?plan=' + ANNUAL_ID });
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['cap.annual.page.title']);
    expect(Array.from(document.querySelectorAll('thead th')).map((header) => header.textContent)).toEqual([
      vi_['cap.annual.column.year'],
      vi_['cap.annual.column.project'],
      vi_['cap.annual.column.fund'],
      vi_['cap.annual.column.yearAmount'],
      vi_['cap.annual.column.carryAmount'],
      vi_['cap.annual.column.sourceYear'],
      vi_['cap.annual.column.extendedTo'],
      vi_['cap.annual.column.extensionDocument'],
      vi_['cap.annual.column.ctmtqg'],
    ]);
    const [yearLine, carryLine] = rows();
    // The line of the year: 1,000 million, of which 400 million CTMTQG; nothing carried over.
    expect(cell(yearLine, 0)).toBe('2026');
    expect(cell(yearLine, 1)).toContain('DA-01');
    expect(cell(yearLine, 3)).toBe('1.000');
    expect(cell(yearLine, 4)).toBe('');
    expect(cell(yearLine, 5)).toBe('2026');
    expect(cell(yearLine, 8)).toBe('400');
    // The carried-over line: 2,000 million in the other column, with the day the extension ends and the document that allowed it.
    expect(cell(carryLine, 3)).toBe('');
    expect(cell(carryLine, 4)).toBe('2.000');
    expect(cell(carryLine, 5)).toBe('2025');
    expect(cell(carryLine, 6)).toBe('2026-12-31');
    expect(cell(carryLine, 7)).toBe('55/QD-UBND');
    // The total adds the lines and not the CTMTQG part: 3,000 million, and 400 million CTMTQG shown apart.
    expect(screen.getByTestId('total').textContent).toBe('3.000');
    expect(screen.getByTestId('total-ctmtqg').textContent).toBe('400');
    expect(screen.getByTestId('totals').textContent).toContain(vi_['cap.annual.total.note']);
  });

  it('shows the plan it works on and offers only the annual plans', async () => {
    mount(<AnnualPlanScreen route={ROUTE} />, planClient(planWorld()), { permissions: PLAN_READER });
    await ready();
    const header = screen.getByTestId('plan-header');
    expect(header.textContent).toContain('CP-2026');
    expect(header.textContent).toContain(vi_['cap.planStatus.draft.label']);
    expect(header.textContent).toContain(vi_['cap.planHeader.noDecision.notice']);
    expect(
      within(screen.getByLabelText(vi_['cap.planChooser.label']))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['CP-2026 · 2026 · Nháp', 'CP-2025 · 2025 · Đã công bố']);
  });

  it('opens another plan from the chooser and cites the decision of a published one', async () => {
    mount(<AnnualPlanScreen route={ROUTE} />, planClient(planWorld()), { permissions: PLAN_READER });
    await ready();
    fireEvent.change(screen.getByLabelText(vi_['cap.planChooser.label']), { target: { value: PUBLISHED_ID } });
    await waitFor(() => expect(screen.getByTestId('plan-header').getAttribute('data-plan-id')).toBe(PUBLISHED_ID));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.getByTestId('plan-header').textContent).toContain('12/QD-UBND ngày 2025-01-10');
  });

  it('offers to propose and to edit only to a planner, and only while the plan is a draft', async () => {
    const { unmount } = mount(<AnnualPlanScreen route={ROUTE} />, planClient(planWorld()), { permissions: PLAN_PLANNER, path: '/?plan=' + ANNUAL_ID });
    await ready();
    expect(screen.getByRole('link', { name: vi_['cap.annual.propose.action'] }).getAttribute('href')).toContain(`/cap/cap-02?plan=${ANNUAL_ID}`);
    expect(screen.getByRole('link', { name: vi_['cap.annual.edit.action'] }).getAttribute('href')).toContain(`/cap/cap-06?plan=${ANNUAL_ID}`);
    unmount();
    cleanup();
    mount(<AnnualPlanScreen route={ROUTE} />, planClient(planWorld()), { permissions: PLAN_READER, path: '/?plan=' + ANNUAL_ID });
    await ready();
    expect(screen.queryByRole('link', { name: vi_['cap.annual.propose.action'] })).toBeNull();
    cleanup();
    mount(<AnnualPlanScreen route={ROUTE} />, planClient(planWorld()), { permissions: PLAN_PLANNER, path: '/?plan=' + PUBLISHED_ID });
    await ready();
    expect(screen.queryByRole('link', { name: vi_['cap.annual.propose.action'] })).toBeNull();
  });

  it('says so when the caller sees no line of the plan, and when there is no annual plan at all', async () => {
    const world = planWorld();
    world.lines[ANNUAL_ID] = [];
    mount(<AnnualPlanScreen route={ROUTE} />, planClient(world), { permissions: PLAN_READER });
    await waitFor(() => expect(screen.getByTestId('no-lines')).toBeTruthy());
    cleanup();
    mount(<AnnualPlanScreen route={ROUTE} />, planClient(planWorld({ plans: [] })), { permissions: PLAN_READER });
    await waitFor(() => expect(screen.getByText(vi_['states.empty.title'])).toBeTruthy());
  });

  it('shows the denied and the error state of a read that fails', async () => {
    const denied = planWorld();
    denied.failing.set('get_resources_plan_version', new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }));
    mount(<AnnualPlanScreen route={ROUTE} />, planClient(denied), { permissions: PLAN_READER });
    await waitFor(() => expect(screen.getByText(vi_['states.denied.title'])).toBeTruthy());
    cleanup();
    const broken = planWorld();
    broken.failing.set('get_resources_plan_version', new Error('boom'));
    mount(<AnnualPlanScreen route={ROUTE} />, planClient(broken), { permissions: PLAN_READER });
    await waitFor(() => expect(screen.getByText(vi_['states.error.title'])).toBeTruthy());
  });

  it('reads the lines of a plan page after page until the last', async () => {
    const world = planWorld();
    const h = planClient(world);
    const pages = [
      { plan: world.plans[0], items: [planLine(1)], totals: { line_count: 2, allocated_vnd: '3', ctmtqg_subset_vnd: '0' }, next_cursor: 'more' },
      { plan: world.plans[0], items: [planLine(2)], totals: { line_count: 2, allocated_vnd: '3', ctmtqg_subset_vnd: '0' }, next_cursor: null },
    ];
    h.read.mockImplementation((_operation: string, input?: unknown) => Promise.resolve((input as { query?: { cursor?: string } }).query?.cursor === undefined ? pages[0] : pages[1]));
    mount(<AnnualPlanScreen route={ROUTE} />, h, { permissions: PLAN_READER });
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(h.read).toHaveBeenCalledTimes(2);
  });
});
