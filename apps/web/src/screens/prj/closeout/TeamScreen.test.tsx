import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { line, mount, routeOf } from '../test-support';
import TeamScreen from './TeamScreen';
import { FAILURES, OTHER, PROJECT, assignment, asked, fill, force, member, open, problem, word } from './test-support';
import type { Served } from './test-support';

const ROUTE = routeOf('PRJ-08', 'FR-PRJ-08');
const READER = ['project.read', 'taskforce.read'];
const MANAGER = ['project.read', 'taskforce.read', 'project.accountability.assign', 'taskforce.manage'];

afterEach(cleanup);

const show = (served: Served, permissions: readonly string[] = READER, options: { project?: string | null; mode?: 'FULL' | 'READ_ONLY' } = {}) => {
  const h = open(served);
  const id = options.project === undefined ? PROJECT : options.project;
  mount(<TeamScreen route={ROUTE} />, h, { permissions, ...(options.mode === undefined ? {} : { mode: options.mode }), path: `/prj/prj-08${id === null ? '' : `?id=${id}`}` });
  return h;
};

const TEAM: Served = {
  assignments: [
    assignment(1, { accountability_role: 'FOCAL_OFFICER', leader: { membership_id: '00000000-0000-4000-8000-005000000009', display_name: 'Đầu mối' } }),
    assignment(2),
    assignment(3, { status: 'ENDED', valid_until: '2026-03-01', end_reason: 'Chuyển công tác' }),
    assignment(4, { project_id: OTHER, project_code: line(2).code }),
  ],
  forces: [
    force(1, [
      member(1),
      member(2, { role: 'SECRETARY', display_name: 'An' }),
      member(3, { project: null }),
      member(4, { valid_until: '2026-04-01' }),
      member(5, { project: { id: OTHER, code: line(2).code, name: line(2).name } }),
    ]),
    force(2, [member(6)], { status: 'DISSOLVED', valid_until: '2026-05-01' }),
  ],
};

describe('TeamScreen (PRJ-08): the team of a project', () => {
  it('UI-PRJ-08: lists who answers for the project and the task force members on it, with the role and the scope, and nothing of other projects, ended terms or dissolved forces', async () => {
    show(TEAM);
    const table = await screen.findByTestId('team');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('prj.team.page.title'));
    for (const key of ['prj.team.column.member', 'prj.team.column.role', 'prj.team.column.scope'] as const) expect(within(table).getByRole('columnheader', { name: word(key) })).toBeTruthy();
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => row.getAttribute('data-kind'))).toEqual(['assignment', 'assignment', 'taskForce', 'taskForce']);
    expect(rows[0]?.textContent).toContain('Người phụ trách 2');
    expect(rows[0]?.textContent).toContain(word('prj.accountability.role.leader.label'));
    expect(rows[0]?.textContent).toContain(fill(word('prj.team.scope.project'), { project: `${line(1).code} ${line(1).name}` }));
    expect(rows[0]?.textContent).toContain(fill(word('prj.team.validity.open'), { from: '2026-01-05' }));
    expect(rows[1]?.textContent).toContain(word('prj.accountability.role.focal.label'));
    expect(rows[2]?.textContent).toContain('An');
    expect(rows[2]?.textContent).toContain(word('prj.taskforce.memberRole.secretary.label'));
    expect(rows[3]?.textContent).toContain('Thành viên 1');
    expect(rows[3]?.textContent).toContain(fill(word('prj.team.scope.force'), { code: 'TF-01', name: 'Tổ công tác 1' }));
    expect(rows[3]?.textContent).toContain(fill(word('prj.team.scope.unit'), { unit: 'Sở Giao thông' }));
    expect(screen.queryByTestId('forces-hidden')).toBeNull();
    expect(screen.queryByText('Chuyển công tác')).toBeNull();
    expect(screen.queryByText('Thành viên 6')).toBeNull();
  });

  it('names a person who has no name yet, and the term that has an end', async () => {
    show({ assignments: [assignment(1, { leader: { membership_id: '00000000-0000-4000-8000-005000000001', display_name: null }, valid_until: '2026-12-31' })], forces: [] });
    const table = await screen.findByTestId('team');
    expect(table.textContent).toContain(word('prj.team.member.unknown'));
    expect(table.textContent).toContain(fill(word('prj.team.validity.range'), { from: '2026-01-05', until: '2026-12-31' }));
  });

  it('offers the way to PRJ-17 and PRJ-18 only to whoever may administer assignments and task forces, and not in a read-only session', async () => {
    show(TEAM, MANAGER);
    await screen.findByTestId('team');
    expect(screen.getByTestId('manage-assignments').getAttribute('href')).toBe('/prj/prj-17');
    expect(screen.getByTestId('manage-forces').getAttribute('href')).toBe('/prj/prj-18');
    cleanup();
    show(TEAM, READER);
    await screen.findByTestId('team');
    expect(screen.queryByTestId('manage-assignments')).toBeNull();
    expect(screen.queryByTestId('manage-forces')).toBeNull();
    cleanup();
    show(TEAM, MANAGER, { mode: 'READ_ONLY' });
    await screen.findByTestId('team');
    expect(screen.queryByTestId('manage-assignments')).toBeNull();
  });

  it('asks nothing of task forces from whoever may not read them, and says the list is without them', async () => {
    const h = show(TEAM, ['project.read']);
    const table = await screen.findByTestId('team');
    expect(screen.getByTestId('forces-hidden').textContent).toBe(word('prj.team.forces.hidden.notice'));
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(2);
    expect(asked(h, 'get_resources_task_force')).toHaveLength(0);
  });

  it('shows the denied card and reads nothing when the caller may not read projects', async () => {
    const h = show(TEAM, ['taskforce.read']);
    expect((await screen.findByRole('alert')).textContent).toContain(word('states.denied.title'));
    expect(screen.queryByTestId('team')).toBeNull();
    expect(screen.queryByLabelText(word('prj.revision.filter.project.label'))).toBeNull();
    expect(asked(h, 'get_resources_project_accountability')).toHaveLength(0);
  });

  it('asks for a project when the address names none, and reads no team', async () => {
    const h = show(TEAM, READER, { project: null });
    expect((await screen.findByTestId('no-project')).textContent).toBe(word('prj.revision.noProject.notice'));
    expect(asked(h, 'get_resources_project_accountability')).toHaveLength(0);
  });

  it('shows the empty card for a project nobody is assigned to, and for a project that is not in the scope of the caller', async () => {
    show({ assignments: [], forces: [] });
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    cleanup();
    show(TEAM, READER, { project: '00000000-0000-4000-8000-0000000000ff' });
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
  });

  it('shows the skeleton while the register is read', async () => {
    show({ pending: ['get_resources_project_accountability'] });
    expect(await screen.findByLabelText(word('states.loading.label'))).toBeTruthy();
  });

  for (const [name, failure, title] of FAILURES) {
    it(`shows the ${name} card when the register of assignments fails, and reads again on retry`, async () => {
      const h = show({ ...TEAM, failing: { get_resources_project_accountability: failure } });
      expect(await screen.findByText(title)).toBeTruthy();
      expect(screen.queryByTestId('team')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
      await waitFor(() => expect(asked(h, 'get_resources_project_accountability').length).toBeGreaterThan(1));
    });
  }

  it('shows the error card when the task forces fail while the assignments are fine', async () => {
    show({ ...TEAM, failing: { get_resources_task_force: problem(500, 'INTERNAL_ERROR') } });
    expect((await screen.findByRole('alert')).textContent).toContain(word('states.error.title'));
  });
});
