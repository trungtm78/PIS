import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { describeViolations, seriousViolations } from '../../../test/axe';
import ProjectWorkspaceScreen from '../../prj/ProjectWorkspaceScreen';
import { MAKER, client, detail as projectDetail, mount, routeOf as prjRoute, world } from '../../prj/test-support';
import { PERMISSIONS } from '../model';
import { text } from '../test/fixtures';
import { detail, gate, schedule, taskList } from './test/fixtures';
import WorkflowTab from './WorkflowTab';
import { toProjectView } from '../../prj/model';
import type { ProjectView } from '../../prj/model';

afterEach(cleanup);

const PROJECT = projectDetail(1);
const PATH = `/prj/prj-03?id=${PROJECT.id as string}`;
const tabName = text('prj.workspace.tab.workflow');

/** The reads of the project workspace plus the reads of the workflow, answered for the project of the workspace. */
function harness(workflow: () => unknown = () => ({ ...detail(), project_id: PROJECT.id })) {
  const h = client(world());
  const original = h.read.getMockImplementation() as (operation: string, input?: unknown) => Promise<unknown>;
  const answers: Record<string, (input: Record<string, unknown>) => unknown> = {
    getProjectWorkflow: workflow,
    getProjectSchedule: () => schedule(),
    listProjectTasks: taskList,
    evaluateProjectGate: gate,
  };
  h.read.mockImplementation((operation: string, input?: unknown) => {
    const answer = answers[operation];
    if (answer === undefined) return original(operation, input);
    const value = answer((input ?? {}) as Record<string, unknown>);
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  });
  return h;
}

describe('PRJ-03 tab "Workflow"', () => {
  it('shows the tab to who may read the project workflow, opens it from the address and keeps the tab in the address', async () => {
    mount(<ProjectWorkspaceScreen route={prjRoute('PRJ-03', 'FR-PRJ-03')} />, harness(), { permissions: [...MAKER, PERMISSIONS.read], path: PATH });
    const tabs = await screen.findByRole('tablist');
    expect(within(tabs).getAllByRole('tab').map((tab) => tab.textContent)).toContain(tabName);
    fireEvent.click(within(tabs).getByRole('tab', { name: tabName }));
    expect(await screen.findByTestId('tab-workflow')).toBeTruthy();
    expect(await screen.findByTestId('workflow')).toBeTruthy();
    expect(screen.getByRole('tab', { name: tabName }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(screen.getByRole('tab', { name: tabName }).id);
  });

  it('opens on the workflow tab named in the address', async () => {
    mount(<ProjectWorkspaceScreen route={prjRoute('PRJ-03', 'FR-PRJ-03')} />, harness(), { permissions: [...MAKER, PERMISSIONS.read], path: `${PATH}&tab=workflow` });
    expect(await screen.findByTestId('workflow')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('tab', { name: tabName }).getAttribute('aria-selected')).toBe('true'));
  });

  it('hides the tab from who may not read the project workflow, and a link to it falls back to the overview', async () => {
    mount(<ProjectWorkspaceScreen route={prjRoute('PRJ-03', 'FR-PRJ-03')} />, harness(), { permissions: MAKER, path: `${PATH}&tab=workflow` });
    const tabs = await screen.findByRole('tablist');
    expect(within(tabs).queryByRole('tab', { name: tabName })).toBeNull();
    expect(screen.queryByTestId('tab-workflow')).toBeNull();
    expect(within(tabs).getByRole('tab', { name: text('prj.workspace.tab.overview') }).getAttribute('aria-selected')).toBe('true');
  });

  it('keeps the other tabs standing when the workflow cannot be read', async () => {
    mount(<ProjectWorkspaceScreen route={prjRoute('PRJ-03', 'FR-PRJ-03')} />, harness(() => new Error('down')), { permissions: [...MAKER, PERMISSIONS.read], path: `${PATH}&tab=workflow` });
    expect(await screen.findByText(text('states.error.title'))).toBeTruthy();
    expect(screen.getByRole('tab', { name: text('prj.workspace.tab.overview') })).toBeTruthy();
  });

  it('has no serious accessibility violation with the workflow inside the workspace', async () => {
    const view = toProjectView(PROJECT) as ProjectView;
    const { container } = mount(<WorkflowTab project={view} />, harness(), { permissions: [...MAKER, PERMISSIONS.read], path: PATH });
    await screen.findByTestId('card-T5');
    await waitFor(() => expect(screen.getByTestId('critical-path')).toBeTruthy());
    expect(describeViolations(await seriousViolations(container))).toEqual([]);
  });
});
