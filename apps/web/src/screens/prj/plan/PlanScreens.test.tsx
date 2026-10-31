import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { client, line, mount, routeOf, world } from '../test-support';
import type { Harness } from '../test-support';
import ComponentsScreen from './ComponentsScreen';
import MilestonesScreen from './MilestonesScreen';
import {
  EMPTY_COMPONENT,
  EMPTY_MILESTONE,
  EMPTY_PROGRESS,
  componentBody,
  dependencyChoices,
  describePlan,
  holds,
  isOpen,
  milestoneBody,
  progressBody,
  toComponentRegister,
  toMilestones,
  validateComponent,
  validateMilestone,
  validateProgress,
  vietnamToday,
} from './model';
import type { ComponentForm, MilestoneForm, MilestoneView, ProgressForm } from './model';

const COMPONENTS_ROUTE = routeOf('PRJ-05', 'FR-PRJ-05');
const MILESTONES_ROUTE = routeOf('PRJ-07', 'FR-PRJ-07');
const WRITER = ['project.read', 'project.update'];
const READER = ['project.read'];
const PROJECT = line(1).id;
const OK = { operation_id: 'o', status: 'ACTIVE', resource_version: 1, resource_id: 'x', warnings: [] };

const component = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-0000000000c${n}`,
  parent_component_id: null,
  code: `C${n}`,
  name: `Gói số ${n}`,
  planned_value_vnd: '10000000000',
  sort_order: 0,
  valid_from: '2026-01-01',
  valid_until: null,
  depth: 1,
  ...overrides,
});
const componentsAnswer = (items: unknown[], extra: Record<string, unknown> = {}) => ({ items, wbs_total_vnd: '20000000000', project_total_vnd: '45000000000', exceeds_total: false, as_of: '2026-10-31', ...extra });

const milestone = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-0000000000d${n}`,
  code: `M${n}`,
  name: `Mốc số ${n}`,
  component: null,
  baseline_date: '2026-02-15',
  planned_date: '2026-02-15',
  actual_date: null,
  depends_on: null,
  status: 'PLANNED',
  reason: null,
  delay_days: 0,
  delayed: false,
  version: 1,
  ...overrides,
});
const milestonesAnswer = (items: unknown[]) => ({ items, as_of: '2026-10-31' });

afterEach(cleanup);

function open(
  served: { components?: Record<string, unknown>; milestones?: Record<string, unknown>; failing?: Error },
  command: (operation: string, input: unknown) => unknown = () => OK,
  projects: Array<Record<string, unknown>> = [line(1, { status: 'IMPLEMENTATION' })],
): Harness {
  const h = client(world({ projects }), command);
  const previous = h.read.getMockImplementation();
  h.read.mockImplementation((operation: string, input?: unknown) => {
    if (served.failing !== undefined && (operation === 'listProjectComponents' || operation === 'listProjectMilestones')) return Promise.reject(served.failing);
    if (operation === 'listProjectComponents') return Promise.resolve(served.components ?? componentsAnswer([]));
    if (operation === 'listProjectMilestones') return Promise.resolve(served.milestones ?? milestonesAnswer([]));
    return previous === undefined ? Promise.reject(new Error(`unexpected read ${operation}`)) : previous(operation, input);
  });
  return h;
}

const showComponents = (h: Harness, permissions: readonly string[], options: { mode?: 'FULL' | 'READ_ONLY'; project?: boolean } = {}) =>
  mount(<ComponentsScreen route={COMPONENTS_ROUTE} />, h, { permissions, ...(options.mode === undefined ? {} : { mode: options.mode }), path: `/prj/prj-05${options.project === false ? '' : `?id=${PROJECT}`}` });
const showMilestones = (h: Harness, permissions: readonly string[], options: { mode?: 'FULL' | 'READ_ONLY'; project?: boolean } = {}) =>
  mount(<MilestonesScreen route={MILESTONES_ROUTE} />, h, { permissions, ...(options.mode === undefined ? {} : { mode: options.mode }), path: `/prj/prj-07${options.project === false ? '' : `?id=${PROJECT}`}` });
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const sent = (h: Harness, operation: string) => h.command.mock.calls.filter(([name]) => name === operation).map(([, input]) => input as { path?: Record<string, string>; body?: Record<string, unknown>; ifMatchVersion?: number });

describe('ComponentsScreen (PRJ-05): the work breakdown of a project', () => {
  it('UI-PRJ-05: lists the components as a tree with their code, parent and value, and tells in words when the first level exceeds the total', async () => {
    const h = open({ components: componentsAnswer([component(1), component(2, { parent_component_id: component(1).id, depth: 2, planned_value_vnd: '4000000000' }), component(3)], { wbs_total_vnd: '48000000000', exceeds_total: true }) });
    showComponents(h, READER);
    const table = await screen.findByTestId('components');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['prj.wbs.title']);
    for (const key of ['prj.wbs.col.code', 'prj.wbs.col.parent', 'prj.wbs.col.value'] as const) expect(within(table).getByRole('columnheader', { name: vi_[key] })).toBeTruthy();
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain('C1');
    expect(rows[0]?.textContent).toContain('10.000.000.000');
    expect(rows[1]?.getAttribute('data-depth')).toBe('2');
    expect(rows[1]?.textContent).toContain(vi_['prj.wbs.level'].replace('{level}', '2'));
    expect(within(rows[1] as HTMLElement).getAllByRole('cell')[1]?.textContent).toBe('C1');
    expect((rows[1]?.querySelector('td') as HTMLElement).style.paddingLeft).toBe('28px');
    expect(screen.getByTestId('exceeds-warning').textContent).toBe(vi_['prj.wbs.exceeds.warning'].replace('{wbs}', '48.000.000.000 đồng').replace('{total}', '45.000.000.000 đồng'));
    expect(screen.getByTestId('wbs-total').textContent).toContain('48.000.000.000');
    expect(screen.queryByRole('form', { name: vi_['prj.wbs.form.title'] })).toBeNull();
  });

  it('shows no warning when the first level fits the total, and asks for a project when the address names none', async () => {
    const h = open({ components: componentsAnswer([component(1)]) });
    showComponents(h, READER);
    await screen.findByTestId('components');
    expect(screen.queryByTestId('exceeds-warning')).toBeNull();
    cleanup();
    showComponents(h, READER, { project: false });
    expect((await screen.findByTestId('no-project')).textContent).toBe(vi_['prj.revision.noProject.notice']);
  });

  it('refuses before it sends what is missing or not valid, then sends the component under its parent and starts the form over', async () => {
    const h = open({ components: componentsAnswer([component(1)]) });
    showComponents(h, WRITER);
    const form = await screen.findByRole('form', { name: vi_['prj.wbs.form.title'] });
    fireEvent.click(within(form).getByRole('button', { name: vi_['prj.wbs.form.submit.action'] }));
    expect((await within(form).findAllByText(vi_['prj.plan.field.required.error'])).length).toBe(4);
    type(vi_['prj.wbs.field.code.label'], '-bad');
    type(vi_['prj.wbs.field.name.label'], 'Gói phụ');
    type(vi_['prj.wbs.field.value.label'], '1.5');
    type(vi_['prj.wbs.field.from.label'], '2026-01-01');
    fireEvent.click(within(form).getByRole('button', { name: vi_['prj.wbs.form.submit.action'] }));
    expect((await within(form).findAllByText(vi_['prj.plan.field.invalid.error'])).length).toBe(2);
    expect(h.command).not.toHaveBeenCalled();
    type(vi_['prj.wbs.field.code.label'], ' C1-1 ');
    type(vi_['prj.wbs.field.value.label'], '4000000000');
    fireEvent.change(within(form).getByLabelText(vi_['prj.wbs.field.parent.label']), { target: { value: component(1).id } });
    type(vi_['prj.wbs.field.sort.label'], '3');
    fireEvent.click(within(form).getByRole('button', { name: vi_['prj.wbs.form.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(sent(h, 'addProjectComponent')[0]).toMatchObject({ path: { id: PROJECT }, body: { code: 'C1-1', name: 'Gói phụ', planned_value_vnd: '4000000000', valid_from: '2026-01-01', parent_component_id: component(1).id, sort_order: 3 } });
    expect((await screen.findByTestId('component-saved')).textContent).toBe(vi_['prj.wbs.form.saved']);
    expect((within(form).getByLabelText(vi_['prj.wbs.field.code.label']) as HTMLInputElement).value).toBe('');
  });

  it('says in words why the server refused the component, and offers no form to a reader, to a session that is read only or for a project that is closed', async () => {
    const h = open({ components: componentsAnswer([]) }, () => new ApiError({ status: 409, code: 'COMPONENT_CODE_DUPLICATE', correlationId: 'c' }));
    showComponents(h, WRITER);
    const form = await screen.findByRole('form', { name: vi_['prj.wbs.form.title'] });
    type(vi_['prj.wbs.field.code.label'], 'C1');
    type(vi_['prj.wbs.field.name.label'], 'Gói chính');
    type(vi_['prj.wbs.field.value.label'], '1');
    type(vi_['prj.wbs.field.from.label'], '2026-01-01');
    fireEvent.click(within(form).getByRole('button', { name: vi_['prj.wbs.form.submit.action'] }));
    expect((await within(form).findByTestId('component-refusal')).textContent).toBe(vi_['prj.plan.problem.componentDuplicate']);
    cleanup();
    showComponents(open({ components: componentsAnswer([]) }), WRITER, { mode: 'READ_ONLY' });
    await screen.findByTestId('components');
    expect(screen.queryByRole('form', { name: vi_['prj.wbs.form.title'] })).toBeNull();
    cleanup();
    showComponents(open({ components: componentsAnswer([]) }, () => OK, [line(1, { status: 'CLOSED' })]), WRITER);
    await screen.findByTestId('components');
    expect(screen.queryByRole('form', { name: vi_['prj.wbs.form.title'] })).toBeNull();
  });

  it('says in words that the breakdown could not be read and reads it again on request', async () => {
    const h = open({ failing: new ApiError({ status: 500, code: 'INTERNAL', correlationId: 'c' }) });
    showComponents(h, READER);
    fireEvent.click(await screen.findByRole('button', { name: vi_['states.retry.action'] }));
    await waitFor(() => expect(h.read.mock.calls.filter(([name]) => name === 'listProjectComponents').length).toBeGreaterThanOrEqual(2));
  });
});

describe('MilestonesScreen (PRJ-07): the schedule of a project', () => {
  it('UI-PRJ-07, UAT-AC218: lists each milestone with its baseline, planned and actual day and what it waits for; a late one says so in words with the days', async () => {
    const h = open({
      milestones: milestonesAnswer([
        milestone(1, { code: 'M-KC', status: 'DONE', actual_date: '2026-03-02', planned_date: '2026-02-20', delay_days: 15, delayed: true, component: { id: component(1).id, code: 'C1', name: 'Gói số 1' } }),
        milestone(2, { code: 'M-HT', depends_on: { id: milestone(1).id, code: 'M-KC' }, baseline_date: '2026-12-31', planned_date: '2026-12-31' }),
        milestone(3, { code: 'M-X', status: 'CANCELLED', reason: 'The works were dropped' }),
      ]),
    });
    showMilestones(h, READER);
    const table = await screen.findByTestId('milestones');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['prj.mile.title']);
    for (const key of ['prj.mile.col.milestone', 'prj.mile.col.planned', 'prj.mile.col.actual', 'prj.mile.col.depends'] as const) expect(within(table).getByRole('columnheader', { name: vi_[key] })).toBeTruthy();
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]?.textContent).toContain('2026-03-02');
    expect(rows[0]?.textContent).toContain(vi_['prj.mile.status.done']);
    expect(within(rows[0] as HTMLElement).getByTestId('delay').textContent).toBe(vi_['prj.mile.delay.pill'].replace('{days}', '15'));
    expect(rows[0]?.getAttribute('data-delayed')).toBe('true');
    expect(rows[0]?.textContent).toContain(vi_['prj.mile.component'].replace('{component}', 'C1'));
    expect(within(rows[1] as HTMLElement).queryByTestId('delay')).toBeNull();
    expect(within(rows[1] as HTMLElement).getAllByRole('cell')[4]?.textContent).toBe('M-KC');
    expect(rows[2]?.textContent).toContain(vi_['prj.mile.status.cancelled']);
    expect(rows[2]?.textContent).toContain(vi_['prj.mile.reason'].replace('{reason}', 'The works were dropped'));
    expect(screen.queryByRole('button', { name: vi_['prj.mile.progress.action'] })).toBeNull();
  });

  it('refuses before it sends what is missing or not valid, then sends the milestone with its component and dependency', async () => {
    const h = open({ components: componentsAnswer([component(1)]), milestones: milestonesAnswer([milestone(1)]) });
    showMilestones(h, WRITER);
    const form = await screen.findByRole('form', { name: vi_['prj.mile.form.title'] });
    fireEvent.click(within(form).getByRole('button', { name: vi_['prj.mile.form.submit.action'] }));
    expect((await within(form).findAllByText(vi_['prj.plan.field.required.error'])).length).toBe(4);
    type(vi_['prj.mile.field.code.label'], '-bad');
    type(vi_['prj.mile.field.name.label'], 'Khởi công');
    type(vi_['prj.mile.field.baseline.label'], '2026-02-15');
    type(vi_['prj.mile.field.planned.label'], '2026-02-30');
    fireEvent.click(within(form).getByRole('button', { name: vi_['prj.mile.form.submit.action'] }));
    expect((await within(form).findAllByText(vi_['prj.plan.field.invalid.error'])).length).toBeGreaterThanOrEqual(1);
    expect(h.command).not.toHaveBeenCalled();
    type(vi_['prj.mile.field.code.label'], 'M-KC');
    type(vi_['prj.mile.field.planned.label'], '2026-02-20');
    await waitFor(() => expect(within(form).getByLabelText(vi_['prj.mile.field.component.label']).querySelectorAll('option').length).toBeGreaterThan(1));
    fireEvent.change(within(form).getByLabelText(vi_['prj.mile.field.component.label']), { target: { value: component(1).id } });
    fireEvent.change(within(form).getByLabelText(vi_['prj.mile.field.depends.label']), { target: { value: milestone(1).id } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['prj.mile.form.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(sent(h, 'addProjectMilestone')[0]).toMatchObject({ path: { id: PROJECT }, body: { code: 'M-KC', name: 'Khởi công', baseline_date: '2026-02-15', planned_date: '2026-02-20', component_id: component(1).id, depends_on_milestone_id: milestone(1).id } });
    expect((await screen.findByTestId('milestone-saved')).textContent).toBe(vi_['prj.mile.form.saved']);
  });

  it('says in words that a milestone code is taken', async () => {
    const h = open({ milestones: milestonesAnswer([]) }, () => new ApiError({ status: 409, code: 'MILESTONE_CODE_DUPLICATE', correlationId: 'c' }));
    showMilestones(h, WRITER);
    const form = await screen.findByRole('form', { name: vi_['prj.mile.form.title'] });
    type(vi_['prj.mile.field.code.label'], 'M1');
    type(vi_['prj.mile.field.name.label'], 'Khởi công');
    type(vi_['prj.mile.field.baseline.label'], '2026-02-15');
    type(vi_['prj.mile.field.planned.label'], '2026-02-20');
    fireEvent.click(within(form).getByRole('button', { name: vi_['prj.mile.form.submit.action'] }));
    expect((await within(form).findByTestId('milestone-refusal')).textContent).toBe(vi_['prj.plan.problem.milestoneDuplicate']);
  });

  it('UAT-AC218: marks a milestone done only with the day, sends the version shown, and refuses a day in the future before it sends', async () => {
    const h = open({ milestones: milestonesAnswer([milestone(1, { version: 4 })]) });
    showMilestones(h, WRITER);
    fireEvent.click(await screen.findByRole('button', { name: vi_['prj.mile.progress.action'] }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('progress-summary').textContent).toBe(vi_['prj.mile.progress.summary'].replace('{baseline}', '2026-02-15').replace('{planned}', '2026-02-15'));
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['prj.mile.progress.submit.action'] }));
    expect(await within(dialog).findByText(vi_['prj.plan.field.required.error'])).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(vi_['prj.mile.progress.actual.label']), { target: { value: '2999-01-01' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['prj.mile.progress.submit.action'] }));
    expect(await within(dialog).findByText(vi_['prj.plan.field.invalid.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(vi_['prj.mile.progress.actual.label']), { target: { value: '2026-03-02' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['prj.mile.progress.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(sent(h, 'recordMilestoneProgress')[0]).toMatchObject({ path: { id: milestone(1).id }, ifMatchVersion: 4, body: { status: 'DONE', actual_date: '2026-03-02' } });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('delays a milestone to a later day with a reason, or cancels it with a reason, and says in words why the server refused', async () => {
    const h = open({ milestones: milestonesAnswer([milestone(1)]) }, () => new ApiError({ status: 409, code: 'MILESTONE_STATE_INVALID', correlationId: 'c' }));
    showMilestones(h, WRITER);
    fireEvent.click(await screen.findByRole('button', { name: vi_['prj.mile.progress.action'] }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByLabelText(vi_['prj.mile.progress.delayed']));
    fireEvent.change(within(dialog).getByLabelText(vi_['prj.mile.progress.planned.label']), { target: { value: '2026-02-10' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['prj.mile.progress.reason.label']), { target: { value: 'no' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['prj.mile.progress.submit.action'] }));
    expect((await within(dialog).findAllByText(vi_['prj.plan.field.invalid.error'])).length).toBe(2);
    fireEvent.change(within(dialog).getByLabelText(vi_['prj.mile.progress.planned.label']), { target: { value: '2026-03-15' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['prj.mile.progress.reason.label']), { target: { value: 'Site clearance is late' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['prj.mile.progress.submit.action'] }));
    expect((await within(dialog).findByTestId('progress-refusal')).textContent).toBe(vi_['prj.plan.problem.stateInvalid']);
    expect(sent(h, 'recordMilestoneProgress')[0]).toMatchObject({ body: { status: 'DELAYED', planned_date: '2026-03-15', reason: 'Site clearance is late' } });
    fireEvent.click(within(dialog).getByLabelText(vi_['prj.mile.progress.cancelled']));
    expect(within(dialog).queryByLabelText(vi_['prj.mile.progress.planned.label'])).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(vi_['prj.mile.progress.reason.label']), { target: { value: ' ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['prj.mile.progress.submit.action'] }));
    expect(await within(dialog).findByText(vi_['prj.plan.field.required.error'])).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['prj.plan.dialog.close.label'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('changes the milestone another waits for, offering only the ones that close no loop, and tells in words when the server finds a loop', async () => {
    const h = open(
      { milestones: milestonesAnswer([milestone(1, { version: 2 }), milestone(2, { depends_on: { id: milestone(1).id, code: 'M1' } }), milestone(3, { depends_on: { id: milestone(2).id, code: 'M2' } })]) },
      () => new ApiError({ status: 409, code: 'DEPENDENCY_CYCLE', correlationId: 'c' }),
    );
    showMilestones(h, WRITER);
    const buttons = await screen.findAllByRole('button', { name: vi_['prj.mile.depends.action'] });
    fireEvent.click(buttons[0] as HTMLElement);
    const dialog = await screen.findByRole('dialog');
    const choices = Array.from((within(dialog).getByLabelText(vi_['prj.mile.depends.target.label']) as HTMLSelectElement).options).map((option) => option.textContent);
    expect(choices).toEqual(['—']);
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['prj.mile.depends.submit.action'] }));
    expect((await within(dialog).findByTestId('depends-refusal')).textContent).toBe(vi_['prj.plan.problem.cycle']);
    expect(sent(h, 'setMilestoneDependency')[0]).toMatchObject({ path: { id: milestone(1).id }, ifMatchVersion: 2, body: { depends_on_milestone_id: null } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['prj.plan.dialog.cancel.action'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click((await screen.findAllByRole('button', { name: vi_['prj.mile.depends.action'] }))[2] as HTMLElement);
    const other = await screen.findByRole('dialog');
    const select = within(other).getByLabelText(vi_['prj.mile.depends.target.label']) as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual(['', milestone(1).id, milestone(2).id]);
    expect(select.value).toBe(milestone(2).id);
    fireEvent.change(select, { target: { value: milestone(1).id } });
    fireEvent.click(within(other).getByRole('button', { name: vi_['prj.mile.depends.submit.action'] }));
    await waitFor(() => expect(sent(h, 'setMilestoneDependency')).toHaveLength(2));
    expect(sent(h, 'setMilestoneDependency')[1]?.body).toEqual({ depends_on_milestone_id: milestone(1).id });
  });

  it('offers no action on a milestone that is done or cancelled, and no form to a reader, a session that is read only or a closed project', async () => {
    const h = open({ milestones: milestonesAnswer([milestone(1, { status: 'DONE', actual_date: '2026-03-02' }), milestone(2, { status: 'CANCELLED', reason: 'The works were dropped' })]) });
    showMilestones(h, WRITER);
    await screen.findByTestId('milestones');
    expect(screen.queryByRole('button', { name: vi_['prj.mile.progress.action'] })).toBeNull();
    expect(screen.getByRole('form', { name: vi_['prj.mile.form.title'] })).toBeTruthy();
    cleanup();
    showMilestones(open({ milestones: milestonesAnswer([milestone(1)]) }), WRITER, { mode: 'READ_ONLY' });
    await screen.findByTestId('milestones');
    expect(screen.queryByRole('form')).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['prj.mile.progress.action'] })).toBeNull();
    cleanup();
    showMilestones(open({ milestones: milestonesAnswer([milestone(1)]) }, () => OK, [line(1, { status: 'CANCELLED' })]), WRITER);
    await screen.findByTestId('milestones');
    expect(screen.queryByRole('form')).toBeNull();
    cleanup();
    showMilestones(open({}), READER, { project: false });
    expect(await screen.findByTestId('no-project')).toBeTruthy();
  });

  it('says in words that the schedule could not be read and reads it again on request', async () => {
    const h = open({ failing: new Error('failed') });
    showMilestones(h, READER);
    fireEvent.click(await screen.findByRole('button', { name: vi_['states.retry.action'] }));
    await waitFor(() => expect(h.read.mock.calls.filter(([name]) => name === 'listProjectMilestones').length).toBeGreaterThanOrEqual(2));
  });
});

describe('the model of the plan', () => {
  it('reads the breakdown and the milestones, leaves out what is not one, and knows what is open', () => {
    const read = toComponentRegister(componentsAnswer([component(1), { id: 'x' }, null, component(2, { depth: 'x' }), component(3, { parent_component_id: component(1).id, depth: 2 })], { exceeds_total: true }));
    expect(read.items.map((item) => [item.code, item.depth, item.parentId])).toEqual([['C1', 1, null], ['C3', 2, component(1).id]]);
    expect(read).toMatchObject({ wbsTotalVnd: '20000000000', projectTotalVnd: '45000000000', exceedsTotal: true });
    expect(toComponentRegister(undefined)).toEqual({ items: [], wbsTotalVnd: '0', projectTotalVnd: '0', exceedsTotal: false });
    const items = toMilestones(milestonesAnswer([milestone(1), { id: 'x' }, milestone(2, { status: 'LOST' }), null, milestone(3, { delay_days: 'x', delayed: 'yes', depends_on: { id: milestone(1).id }, component: { id: 'c' }, version: 2 })]));
    expect(items.map((item) => item.code)).toEqual(['M1', 'M3']);
    expect(items[1]).toMatchObject({ delayDays: 0, delayed: false, dependsOn: { id: milestone(1).id, code: '' }, componentCode: null });
    expect(toMilestones(undefined)).toEqual([]);
    expect([isOpen('PLANNED'), isOpen('DELAYED'), isOpen('DONE'), isOpen('CANCELLED')]).toEqual([true, true, false, false]);
    expect([holds(WRITER, 'project.update', undefined), holds(READER, 'project.update', undefined), holds(undefined, 'x', 'FULL'), holds(WRITER, 'project.update', 'READ_ONLY')]).toEqual([true, false, true, false]);
  });

  it('offers as a dependency the other milestones that do not already wait, through others, for this one', () => {
    const items: MilestoneView[] = toMilestones(milestonesAnswer([milestone(1), milestone(2, { depends_on: { id: milestone(1).id, code: 'M1' } }), milestone(3, { depends_on: { id: milestone(2).id, code: 'M2' } }), milestone(4)]));
    expect(dependencyChoices(items, milestone(1).id).map((item) => item.code)).toEqual(['M4']);
    expect(dependencyChoices(items, milestone(3).id).map((item) => item.code)).toEqual(['M1', 'M2', 'M4']);
    expect(dependencyChoices(items, milestone(4).id).map((item) => item.code)).toEqual(['M1', 'M2', 'M3']);
  });

  const COMPONENT: ComponentForm = { ...EMPTY_COMPONENT, code: 'C1', name: 'Gói chính', value: '10', validFrom: '2026-01-01' };
  const MILESTONE: MilestoneForm = { ...EMPTY_MILESTONE, code: 'M1', name: 'Khởi công', baseline: '2026-02-15', planned: '2026-02-20' };
  const PROGRESS: ProgressForm = { ...EMPTY_PROGRESS };

  it('checks a component and a milestone and builds the body the server takes', () => {
    expect(validateComponent(COMPONENT)).toEqual({});
    expect(validateComponent(EMPTY_COMPONENT)).toEqual({ code: 'required', name: 'required', value: 'required', validFrom: 'required' });
    expect(validateComponent({ ...COMPONENT, code: '-x', name: 'x', parent: 'x', value: '-1', validFrom: '2026-02-30', sortOrder: '100001' })).toEqual({ code: 'invalid', name: 'invalid', parent: 'invalid', value: 'invalid', validFrom: 'invalid', sortOrder: 'invalid' });
    expect(validateComponent({ ...COMPONENT, value: '1'.repeat(25), sortOrder: 'x' })).toEqual({ value: 'invalid', sortOrder: 'invalid' });
    expect(componentBody({ ...COMPONENT, code: ' C1 ', parent: component(1).id, sortOrder: '2' })).toEqual({ code: 'C1', name: 'Gói chính', planned_value_vnd: '10', valid_from: '2026-01-01', parent_component_id: component(1).id, sort_order: 2 });
    expect(componentBody(COMPONENT)).toEqual({ code: 'C1', name: 'Gói chính', planned_value_vnd: '10', valid_from: '2026-01-01' });
    expect(validateMilestone(MILESTONE)).toEqual({});
    expect(validateMilestone(EMPTY_MILESTONE)).toEqual({ code: 'required', name: 'required', baseline: 'required', planned: 'required' });
    expect(validateMilestone({ ...MILESTONE, code: '-x', name: 'x', baseline: '2026-13-01', planned: 'x' })).toEqual({ code: 'invalid', name: 'invalid', baseline: 'invalid', planned: 'invalid' });
    expect(milestoneBody({ ...MILESTONE, component: component(1).id, dependsOn: milestone(1).id })).toEqual({ code: 'M1', name: 'Khởi công', baseline_date: '2026-02-15', planned_date: '2026-02-20', component_id: component(1).id, depends_on_milestone_id: milestone(1).id });
    expect(milestoneBody(MILESTONE)).toEqual({ code: 'M1', name: 'Khởi công', baseline_date: '2026-02-15', planned_date: '2026-02-20' });
  });

  it('checks a progress by its outcome, builds its body, tells the day in Vietnam and what the server refused', () => {
    const today = '2026-10-31';
    const current = { plannedDate: '2026-02-20' };
    expect(validateProgress(PROGRESS, current, today)).toEqual({ actual: 'required' });
    expect(validateProgress({ ...PROGRESS, actual: '2026-03-02' }, current, today)).toEqual({});
    expect(validateProgress({ ...PROGRESS, actual: '2026-11-01', reason: 'no' }, current, today)).toEqual({ actual: 'invalid', reason: 'invalid' });
    const delayed: ProgressForm = { outcome: 'DELAYED', actual: '', planned: '2026-03-01', reason: 'Site clearance is late' };
    expect(validateProgress(delayed, current, today)).toEqual({});
    expect(validateProgress({ ...delayed, planned: '2026-02-20', reason: '' }, current, today)).toEqual({ planned: 'invalid', reason: 'required' });
    expect(validateProgress({ ...delayed, planned: '' }, current, today)).toEqual({ planned: 'required' });
    expect(validateProgress({ outcome: 'CANCELLED', actual: '', planned: '', reason: ' ' }, current, today)).toEqual({ reason: 'required' });
    expect(progressBody({ ...PROGRESS, actual: '2026-03-02' })).toEqual({ status: 'DONE', actual_date: '2026-03-02' });
    expect(progressBody({ ...PROGRESS, actual: '2026-03-02', reason: ' On site ' })).toEqual({ status: 'DONE', actual_date: '2026-03-02', reason: 'On site' });
    expect(progressBody(delayed)).toEqual({ status: 'DELAYED', planned_date: '2026-03-01', reason: 'Site clearance is late' });
    expect(progressBody({ outcome: 'CANCELLED', actual: 'x', planned: 'x', reason: ' The works were dropped ' })).toEqual({ status: 'CANCELLED', reason: 'The works were dropped' });
    expect(vietnamToday(new Date('2026-10-30T20:00:00Z'))).toBe('2026-10-31');
    expect(vietnamToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const refusal = (status: number, code: string) => describePlan(new ApiError({ status, code, correlationId: 'c' }));
    expect([
      refusal(409, 'COMPONENT_CODE_DUPLICATE'), refusal(409, 'MILESTONE_CODE_DUPLICATE'), refusal(409, 'DEPENDENCY_CYCLE'), refusal(409, 'MILESTONE_STATE_INVALID'), refusal(409, 'VERSION_CONFLICT'),
      refusal(403, 'SCOPE_DENIED'), refusal(422, 'PROJECT_STAGE_INVALID'), refusal(422, 'VALIDATION_FAILED'), refusal(400, 'INVALID_REQUEST'), refusal(404, 'RESOURCE_NOT_FOUND'), refusal(500, 'X'), describePlan(new Error('x')),
    ]).toEqual(['componentDuplicate', 'milestoneDuplicate', 'cycle', 'stateInvalid', 'versionConflict', 'scopeDenied', 'stageClosed', 'validation', 'validation', 'notFound', 'general', 'general']);
  });
});
