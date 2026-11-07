import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import PlanListScreen from './PlanListScreen';
import { ANNUAL_ID, MEDIUM_ID, PLAN_PLANNER, PLAN_READER, PUBLISHED_ID, UNIT_BQL, mount, planClient, planWorld, routeOf } from './plan-test-support';
import type { PlanWorld } from './plan-test-support';

const ROUTE = routeOf('CAP-01', 'FR-CAP-01');
const problem = (code: string, status = 409, detail?: string) => new ApiError({ status, code, correlationId: 'c', detail, extensions: {} });
const created = { operation_id: 'o', status: 'DRAFT', resource_version: 1, resource_id: '00000000-0000-4000-8000-0000000009aa' };

afterEach(cleanup);

// A plan is the row of the table of the kit that holds a cell carrying its id.
const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('td [data-plan-id]')).flatMap((node) => (node.closest('tr') === null ? [] : [node.closest('tr') as HTMLElement]));
const planOf = (row: HTMLElement | undefined): string | null | undefined => row?.querySelector('[data-plan-id]')?.getAttribute('data-plan-id');
const ready = () => waitFor(() => expect(rows().length).toBeGreaterThan(0));
const cell = (row: HTMLElement | undefined, index: number): string => row?.querySelectorAll('th, td')[index]?.textContent ?? '';
const open = (world: PlanWorld = planWorld(), command?: (operation: string, input: unknown) => unknown, permissions: readonly string[] = PLAN_PLANNER, mode?: 'FULL' | 'READ_ONLY') => {
  const h = planClient(world, command);
  mount(<PlanListScreen route={ROUTE} />, h, { permissions, ...(mode === undefined ? {} : { mode }) });
  return h;
};
const form = () => within(document.querySelector<HTMLElement>('form.cap-form') as HTMLElement);
const set = (label: string, value: string): void => {
  fireEvent.change(form().getByLabelText(label), { target: { value } });
};
const startCreating = async (): Promise<void> => {
  await ready();
  fireEvent.click(screen.getByRole('button', { name: vi_['cap.plans.create.action'] }));
  await waitFor(() => expect(within(form().getByLabelText(vi_['cap.plans.unit.label'])).getAllByRole('option').length).toBeGreaterThan(1));
};

describe('PlanListScreen (CAP-01): the capital plans of the province', () => {
  it('lists the medium-term plans with the period, the fund sources, the ceiling and what is proposed, and the decision behind a published one (UI-CAP-01)', async () => {
    open();
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['cap.plans.page.title']);
    expect(Array.from(document.querySelectorAll('thead th')).map((header) => header.textContent)).toEqual([
      vi_['cap.plans.column.period'],
      vi_['cap.plans.column.plan'],
      vi_['cap.plans.column.funds'],
      vi_['cap.plans.column.ceiling'],
      vi_['cap.plans.column.allocated'],
      vi_['cap.plans.column.status'],
      vi_['cap.plans.column.decision'],
      vi_['cap.plans.column.actions'],
    ]);
    expect(rows()).toHaveLength(1);
    const medium = rows()[0];
    expect(planOf(medium)).toBe(MEDIUM_ID);
    expect(cell(medium, 0)).toBe('2026 - 2030');
    expect(cell(medium, 1)).toContain('TH-2026-2030');
    expect(cell(medium, 1)).toContain(vi_['cap.planKind.medium.label']);
    expect(cell(medium, 2)).toBe('NSTW-DTPT');
    expect(cell(medium, 3)).toBe('20.000');
    expect(cell(medium, 4)).toBe('5.000');
    expect(cell(medium, 5)).toBe(vi_['cap.planStatus.draft.label']);
    expect(cell(medium, 6)).toBe(vi_['cap.planHeader.noDecision.notice']);
    expect(
      within(medium as HTMLElement)
        .getByRole('link', { name: vi_['cap.plans.open.action'] })
        .getAttribute('href'),
    ).toContain(`/cap/cap-06?plan=${MEDIUM_ID}`);
  });

  it('filters by kind: all the plans show the annual ones too, with the decision of a published one and a link to its lines', async () => {
    open();
    await ready();
    fireEvent.change(screen.getByLabelText(vi_['cap.plans.kind.label']), { target: { value: '' } });
    expect(rows()).toHaveLength(3);
    const published = rows().find((row) => planOf(row) === PUBLISHED_ID);
    expect(cell(published, 6)).toBe('12/QD-UBND ngày 2025-01-10');
    expect(cell(published, 5)).toBe(vi_['cap.planStatus.published.label']);
    expect(
      within(published as HTMLElement)
        .getByRole('link', { name: vi_['cap.plans.annual.action'] })
        .getAttribute('href'),
    ).toContain(`/cap/cap-03?plan=${PUBLISHED_ID}`);
    fireEvent.change(screen.getByLabelText(vi_['cap.plans.kind.label']), { target: { value: 'ANNUAL' } });
    expect(rows().map((row) => planOf(row))).toEqual([ANNUAL_ID, PUBLISHED_ID]);
    // A plan without lines says so instead of an empty cell.
    const world = planWorld();
    world.plans = [{ ...(world.plans[1] as object), fund_sources: [] }];
    cleanup();
    open(world);
    await ready();
    expect(cell(rows()[0], 2)).toBe(vi_['cap.plans.noFunds.notice']);
  });

  it('says when no plan matches, and shows the empty, denied and error states', async () => {
    const onlyAnnual = planWorld();
    onlyAnnual.plans = [planWorld().plans[0] as object as Record<string, unknown>];
    open(onlyAnnual);
    await waitFor(() => expect(within(screen.getByTestId('plans')).getByRole('status').textContent).toContain(vi_['ui.dataTable.emptyFiltered']));
    // The empty state of the table offers to clear the filter, and the plan of the other kind is listed again.
    fireEvent.click(within(screen.getByTestId('plans')).getByRole('button', { name: vi_['ui.dataTable.clearFilters'] }));
    expect(rows()).toHaveLength(1);
    cleanup();
    open(planWorld({ plans: [] }));
    await waitFor(() => expect(screen.getByText(vi_['states.empty.title'])).toBeTruthy());
    cleanup();
    const denied = planWorld();
    denied.failing.set('get_resources_plan_version', new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }));
    open(denied);
    await waitFor(() => expect(screen.getByText(vi_['states.denied.title'])).toBeTruthy());
    cleanup();
    const broken = planWorld();
    broken.failing.set('get_resources_plan_version', new Error('boom'));
    open(broken);
    await waitFor(() => expect(screen.getByText(vi_['states.error.title'])).toBeTruthy());
  });

  it('creates a medium-term plan as a draft: the body carries the period and no plan year, and the new plan is offered to open', async () => {
    const h = open(planWorld(), () => created);
    await startCreating();
    set(vi_['cap.plans.code.label'], ' TH-2031-2035 ');
    set(vi_['cap.plans.from.label'], '2031');
    set(vi_['cap.plans.to.label'], '2035');
    set(vi_['cap.plans.unit.label'], UNIT_BQL);
    fireEvent.click(form().getByRole('button', { name: vi_['cap.plans.form.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toEqual([
      'createCapitalPlan',
      expect.objectContaining({ body: { plan_code: 'TH-2031-2035', plan_kind: 'MEDIUM_TERM', period_from_year: 2031, period_to_year: 2035, scope_unit_id: UNIT_BQL } }),
    ]);
    await waitFor(() => expect(screen.getByTestId('created')).toBeTruthy());
    expect(screen.getByRole('link', { name: vi_['cap.plans.created.link'] }).getAttribute('href')).toContain(`/cap/cap-06?plan=${created.resource_id}`);
    expect(document.querySelector('form.cap-form')).toBeNull();
  });

  it('creates an annual plan with its year as the whole period', async () => {
    const h = open(planWorld(), () => created);
    await startCreating();
    set(vi_['cap.plans.kind.label'], 'ANNUAL');
    set(vi_['cap.plans.code.label'], 'CP-2031');
    set(vi_['cap.plans.year.label'], '2031');
    set(vi_['cap.plans.unit.label'], UNIT_BQL);
    fireEvent.click(form().getByRole('button', { name: vi_['cap.plans.form.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect((h.command.mock.calls[0]?.[1] as { body: unknown }).body).toEqual({
      plan_code: 'CP-2031',
      plan_kind: 'ANNUAL',
      plan_year: 2031,
      period_from_year: 2031,
      period_to_year: 2031,
      scope_unit_id: UNIT_BQL,
    });
  });

  it('judges the form before sending: the code, the unit, the years and their order', async () => {
    const h = open();
    await startCreating();
    fireEvent.click(form().getByRole('button', { name: vi_['cap.plans.form.submit.action'] }));
    expect(form().getAllByText(vi_['cap.plans.required.error'])).toHaveLength(4);
    set(vi_['cap.plans.code.label'], 'x'.repeat(51));
    set(vi_['cap.plans.from.label'], '2035');
    set(vi_['cap.plans.to.label'], '2031');
    set(vi_['cap.plans.unit.label'], UNIT_BQL);
    fireEvent.click(form().getByRole('button', { name: vi_['cap.plans.form.submit.action'] }));
    expect(form().getByText(vi_['cap.plans.tooLong.error'])).toBeTruthy();
    expect(form().getByText(vi_['cap.plans.periodOrder.error'])).toBeTruthy();
    set(vi_['cap.plans.from.label'], '20');
    fireEvent.click(form().getByRole('button', { name: vi_['cap.plans.form.submit.action'] }));
    expect(form().getByText(vi_['cap.plans.invalidYear.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.click(form().getByRole('button', { name: vi_['cap.form.cancel.action'] }));
    expect(document.querySelector('form.cap-form')).toBeNull();
  });

  it('shows what the server refused: a code in use, a locked year, a unit outside the scope of the planner', async () => {
    for (const [error, text] of [
      [problem('PLAN_CODE_DUPLICATE'), vi_['cap.planProblem.codeDuplicate.error']],
      [problem('FISCAL_YEAR_LOCKED'), vi_['cap.planProblem.yearLocked.error']],
      [problem('SCOPE_DENIED', 403), vi_['cap.planProblem.denied.error']],
    ] as Array<[ApiError, string]>) {
      cleanup();
      open(planWorld(), () => error);
      await startCreating();
      set(vi_['cap.plans.code.label'], 'TH-X');
      set(vi_['cap.plans.from.label'], '2031');
      set(vi_['cap.plans.to.label'], '2035');
      set(vi_['cap.plans.unit.label'], UNIT_BQL);
      fireEvent.click(form().getByRole('button', { name: vi_['cap.plans.form.submit.action'] }));
      await waitFor(() => expect(screen.getByTestId('problem').textContent).toBe(text));
    }
  });

  it('offers no way to create a plan to a caller who cannot draft, nor in a frozen tenant, and says when the units cannot be read', async () => {
    open(planWorld(), undefined, PLAN_READER);
    await ready();
    expect(screen.queryByRole('button', { name: vi_['cap.plans.create.action'] })).toBeNull();
    expect(screen.getByText(vi_['cap.readOnly.denied.notice'])).toBeTruthy();
    cleanup();
    open(planWorld(), undefined, PLAN_PLANNER, 'READ_ONLY');
    await ready();
    expect(screen.queryByRole('button', { name: vi_['cap.plans.create.action'] })).toBeNull();
    expect(screen.getByText(vi_['cap.readOnly.frozen.notice'])).toBeTruthy();
    cleanup();
    const noUnits = planWorld();
    noUnits.failing.set('get_resources_organization_unit', new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }));
    open(noUnits);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: vi_['cap.plans.create.action'] }));
    await waitFor(() => expect(screen.getByText(vi_['cap.plans.unit.unreadable.notice'])).toBeTruthy());
  });
});
