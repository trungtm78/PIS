import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import AllocationProposalScreen from './AllocationProposalScreen';
import { ANNUAL_ID, PLAN_PLANNER, PLAN_READER, PROJECT_A, appropriationLine, mount, planClient, planWorld, routeOf } from './plan-test-support';
import type { PlanWorld } from './plan-test-support';

const ROUTE = routeOf('CAP-02', 'FR-CAP-02');
const problem = (code: string, status = 422, extensions: Record<string, unknown> = {}, detail?: string) => new ApiError({ status, code, correlationId: 'c', detail, extensions });
const answer = { operation_id: 'o', status: 'DRAFT', resource_version: 5, resource_id: ANNUAL_ID };
const BILLION = 1_000_000_000;

afterEach(cleanup);

const open = (world: PlanWorld = planWorld(), command?: (operation: string, input: unknown) => unknown, permissions: readonly string[] = PLAN_PLANNER, mode?: 'FULL' | 'READ_ONLY') => {
  const h = planClient(world, command);
  mount(<AllocationProposalScreen route={ROUTE} />, h, { permissions, path: '/?plan=' + ANNUAL_ID, ...(mode === undefined ? {} : { mode }) });
  return h;
};
const form = () => within(document.querySelector<HTMLElement>('form.cap-form') as HTMLElement);
const ready = () => waitFor(() => expect(form().getByLabelText(vi_['cap.proposal.source.label'])).toBeTruthy());
const pick = (label: string, value: string): void => {
  fireEvent.change(form().getByLabelText(label), { target: { value } });
};
const submit = (): HTMLButtonElement => form().getByRole('button', { name: vi_['cap.proposal.submit.action'] }) as HTMLButtonElement;
/** The form is ready when the choices read from the API are in it. */
const loaded = () => waitFor(() => expect(within(form().getByLabelText(vi_['cap.proposal.project.label'])).getAllByRole('option').length).toBeGreaterThan(1));
const fill = async (amount = '1000'): Promise<void> => {
  await ready();
  await loaded();
  pick(vi_['cap.proposal.project.label'], PROJECT_A);
  pick(vi_['cap.proposal.source.label'], appropriationLine(1).id);
  pick(vi_['cap.proposal.amount.label'], amount);
};

describe('AllocationProposalScreen (CAP-02): propose capital for a project', () => {
  it('offers the draft plans, the projects and the published appropriations of the years of the plan, with what each has left (UI-CAP-02)', async () => {
    open();
    await ready();
    await loaded();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['cap.proposal.page.title']);
    // Only plans that are still drafts are offered.
    expect(within(screen.getByLabelText(vi_['cap.planChooser.label'])).getAllByRole('option').map((option) => option.textContent)).toEqual(['CP-2026 · 2026 · Nháp', 'TH-2026-2030 · 2026 - 2030 · Nháp']);
    expect(within(form().getByLabelText(vi_['cap.proposal.project.label'])).getAllByRole('option').map((option) => option.textContent)).toEqual([vi_['cap.form.choose.option'], 'DA-01 · Đường vành đai 3', 'DA-02 · Cầu Thủ Thiêm 4']);
    const sources = within(form().getByLabelText(vi_['cap.proposal.source.label'])).getAllByRole('option').map((option) => option.textContent);
    expect(sources).toEqual([vi_['cap.form.choose.option'], 'NSTW-DTPT · 2026 · còn 4.000 triệu đồng', 'NSDP-DTPT · 2026 · còn 4.000 triệu đồng']);
  });

  it('shows the exact dong of the amount and what the source will have left, and refuses an amount the source cannot hold (UI-CAP-02, UAT-AC221)', async () => {
    const h = open();
    await fill('1000');
    expect(screen.getByTestId('exact-amount').textContent).toBe('Sẽ ghi 1.000.000.000 đồng.');
    expect(screen.getByTestId('ceiling').textContent).toContain('4.000');
    expect(screen.getByTestId('ceiling').textContent).toContain('3.000');
    expect(screen.getByTestId('ceiling').getAttribute('data-exceeded')).toBe('false');
    pick(vi_['cap.proposal.amount.label'], '6000');
    expect(screen.getByTestId('ceiling').getAttribute('data-exceeded')).toBe('true');
    expect(screen.getByTestId('ceiling').textContent).toContain('-2.000');
    fireEvent.click(submit());
    expect(form().getByText(vi_['cap.proposal.exceedsRemaining.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('judges the fields before sending: the project, the source and the amount are required, the CTMTQG part cannot be larger than the amount', async () => {
    const h = open();
    await ready();
    await loaded();
    fireEvent.click(submit());
    expect(form().getAllByText(vi_['cap.proposal.required.error'])).toHaveLength(3);
    pick(vi_['cap.proposal.project.label'], PROJECT_A);
    pick(vi_['cap.proposal.source.label'], appropriationLine(1).id);
    pick(vi_['cap.proposal.amount.label'], '1.000');
    fireEvent.click(submit());
    expect(form().getByText(vi_['cap.proposal.invalidAmount.error'])).toBeTruthy();
    pick(vi_['cap.proposal.amount.label'], '100');
    pick(vi_['cap.proposal.ctmtqg.label'], '101');
    fireEvent.click(submit());
    expect(form().getByText(vi_['cap.proposal.subsetExceeds.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('saves the proposal with the version of the plan and the amounts as exact VND, then offers the grid (AC-ST-CAP-002-6)', async () => {
    const h = open(planWorld(), () => answer);
    await fill('1000');
    pick(vi_['cap.proposal.ctmtqg.label'], '400');
    fireEvent.click(submit());
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    const [operation, input] = h.command.mock.calls[0] as [string, { path: { id: string }; ifMatchVersion: number; body: unknown }];
    expect(operation).toBe('draftCapitalAllocation');
    expect(input.path).toEqual({ id: ANNUAL_ID });
    expect(input.ifMatchVersion).toBe(4);
    expect(input.body).toEqual({ lines: [{ project_id: PROJECT_A, appropriation_id: appropriationLine(1).id, bucket: 'CURRENT_YEAR', source_year: 2026, amount_vnd: String(BILLION), ctmtqg_subset_vnd: '400000000' }] });
    await waitFor(() => expect(screen.getByTestId('saved')).toBeTruthy());
    expect(screen.getByRole('link', { name: vi_['cap.proposal.saved.link'] }).getAttribute('href')).toContain(`/cap/cap-06?plan=${ANNUAL_ID}`);
    // The amount is cleared for the next proposal; the project stays.
    expect((form().getByLabelText(vi_['cap.proposal.amount.label']) as HTMLInputElement).value).toBe('');
    expect((form().getByLabelText(vi_['cap.proposal.project.label']) as HTMLSelectElement).value).toBe(PROJECT_A);
  });

  it('puts capital that is carried over in the carry-over bucket by default, and sends the source year of the appropriation', async () => {
    const world = planWorld();
    world.appropriations.lines = [appropriationLine(1, { origin: 'CARRYOVER', source_year: 2025 })];
    const h = open(world, () => answer);
    await fill('100');
    expect((form().getByLabelText(vi_['cap.proposal.bucket.label']) as HTMLSelectElement).value).toBe('CARRYOVER');
    fireEvent.click(submit());
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect((h.command.mock.calls[0]?.[1] as { body: { lines: Array<Record<string, unknown>> } }).body.lines[0]).toMatchObject({ bucket: 'CARRYOVER', source_year: 2025 });
  });

  it('tells the planner what is available when another planner took the capital first (AC-ST-CAP-002-1, UAT-AC08)', async () => {
    const h = open(planWorld(), () => problem('APPROPRIATION_EXCEEDED', 422, { available_vnd: '200000000' }, 'amount_vnd'));
    await fill('1000');
    fireEvent.click(submit());
    await waitFor(() => expect(screen.getByTestId('problem').textContent).toBe('Nguồn chỉ còn 200.000.000 đồng; không thể phân bổ quá số này.'));
    expect(h.command).toHaveBeenCalledTimes(1);
  });

  it('disables the form and says why when the server says the year is locked (UAT-AC230)', async () => {
    open(planWorld(), () => problem('FISCAL_YEAR_LOCKED', 409));
    await fill('1000');
    fireEvent.click(submit());
    await waitFor(() => expect(screen.getByTestId('year-locked').textContent).toBe(vi_['cap.yearLocked.banner']));
    expect(submit().disabled).toBe(true);
    expect(form().getByLabelText(vi_['cap.proposal.amount.label']).matches(':disabled')).toBe(true);
  });

  it('is read only for a caller who cannot draft, and for a frozen tenant', async () => {
    open(planWorld(), undefined, PLAN_READER);
    await ready();
    expect(submit().disabled).toBe(true);
    expect(screen.getByText(vi_['cap.readOnly.denied.notice'])).toBeTruthy();
    cleanup();
    open(planWorld(), undefined, PLAN_PLANNER, 'READ_ONLY');
    await ready();
    expect(submit().disabled).toBe(true);
    expect(screen.getByText(vi_['cap.readOnly.frozen.notice'])).toBeTruthy();
  });

  it('says when there is no source to draw on, no plan in draft, or the read fails', async () => {
    const world = planWorld();
    world.appropriations.lines = [];
    open(world);
    await ready();
    expect(screen.getByText(vi_['cap.proposal.source.empty.notice'])).toBeTruthy();
    cleanup();
    const published = planWorld();
    published.plans = published.plans.map((item) => ({ ...item, status: 'PUBLISHED' }));
    open(published);
    await waitFor(() => expect(screen.getByText(vi_['states.empty.title'])).toBeTruthy());
    cleanup();
    const broken = planWorld();
    broken.failing.set('get_resources_plan_version', new Error('boom'));
    open(broken);
    await waitFor(() => expect(screen.getByText(vi_['states.error.title'])).toBeTruthy());
    cleanup();
    const noProjects = planWorld();
    noProjects.failing.set('get_resources_project', new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }));
    open(noProjects);
    await ready();
    await waitFor(() => expect(screen.getByText(vi_['cap.proposal.project.unreadable.notice'])).toBeTruthy());
  });
});
