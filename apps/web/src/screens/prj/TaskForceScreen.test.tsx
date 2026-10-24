import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import TaskForceScreen from './TaskForceScreen';
import { UNIT_GRANT, WHOLE_TENANT_GRANT, client, line, mount, routeOf, unit, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('PRJ-18', 'FR-PRJ-18');
const MANAGER = ['project.read', 'taskforce.read', 'taskforce.manage'];
const READER = ['project.read', 'taskforce.read'];
const LEAD = '00000000-0000-4000-8000-0000000000c1';
const PERSON = '00000000-0000-4000-8000-0000000000c2';

const force = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-0000000000f${n}`,
  code: `TF-0${n}`,
  name: `Tổ công tác ${n}`,
  purpose: 'Đôn đốc giải ngân các dự án chậm',
  lead: { membership_id: LEAD, display_name: 'Nguyễn Văn An' },
  scope_unit: { id: '00000000-0000-4000-8000-000000010002', code: 'U2', name: 'Sở Giao thông' },
  establishment_document_id: null,
  valid_from: '2026-01-05',
  valid_until: null,
  status: 'ACTIVE',
  version: 3,
  members: [{ id: '00000000-0000-4000-8000-0000000000e1', membership_id: LEAD, display_name: 'Nguyễn Văn An', role: 'LEAD', project: null, valid_from: '2026-01-05', valid_until: null }],
  ...overrides,
});
const MEMBERS = [
  { id: LEAD, display_name: 'Nguyễn Văn An', status: 'Active', membership_type: 'STAFF' },
  { id: PERSON, display_name: 'Trần Thị Bình', status: 'Active' },
];
const OK = { operation_id: 'o', status: 'ACTIVE', resource_version: 4, resource_id: force(1).id };

afterEach(cleanup);

interface Served {
  forces: unknown[];
  failing?: boolean;
}

const WHOLE_TENANT_FORCES = { ...WHOLE_TENANT_GRANT, permissions: ['taskforce.*'] };

function screenClient(served: Served, state: World = world({ projects: [line(1)], grants: [WHOLE_TENANT_FORCES] }), command: (operation: string, input: unknown) => unknown = () => OK) {
  const h = client({ ...state, units: [unit('00000000-0000-4000-8000-000000010002', 'U2', 'Sở Giao thông')] }, command);
  const base = (h.client as unknown as { readAll: (operation: string, input?: unknown) => Promise<unknown[]> }).readAll;
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string, input?: unknown) => {
    if (operation === 'get_resources_task_force') return served.failing === true ? Promise.reject(new Error('failed')) : Promise.resolve(served.forces);
    if (operation === 'get_resources_membership') return Promise.resolve(MEMBERS);
    return base(operation, input);
  });
  return h;
}

describe('TaskForceScreen (PRJ-18): the task forces', () => {
  it('UI-PRJ-18: lists the forces with their terms, and offers the form and the actions to the office that manages them on the whole tenant', async () => {
    mount(<TaskForceScreen route={ROUTE} />, screenClient({ forces: [force(1), force(2, { status: 'DISSOLVED', valid_until: '2026-04-01' })] }), { permissions: MANAGER, path: '/prj/prj-18' });
    await screen.findByTestId('forces');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['prj.taskforce.page.title']);
    await screen.findByRole('form', { name: vi_['prj.taskforce.create.title'] });
    expect(screen.getAllByRole('button', { name: vi_['prj.taskforce.member.action'].replace('{code}', 'TF-01') })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: vi_['prj.taskforce.member.action'].replace('{code}', 'TF-02') })).toBeNull();
    expect(screen.queryByTestId('whole-tenant-notice')).toBeNull();
    await waitFor(() => expect(screen.getByLabelText(vi_['prj.taskforce.create.scope.label']).querySelectorAll('option').length).toBe(2));
  });

  it('AC-ST-PRJ-005-2: seats a member from the list, and dissolves a force under the version it showed', async () => {
    const h = screenClient({ forces: [force(1)] });
    mount(<TaskForceScreen route={ROUTE} />, h, { permissions: MANAGER, path: '/prj/prj-18' });
    await screen.findByTestId('forces');
    await waitFor(() => expect(screen.getByLabelText(vi_['prj.taskforce.create.lead.label']).querySelectorAll('option').length).toBe(3));
    fireEvent.click(screen.getByRole('button', { name: vi_['prj.taskforce.member.action'].replace('{code}', 'TF-01') }));
    fireEvent.change(screen.getByLabelText(vi_['prj.taskforce.member.person.label']), { target: { value: PERSON } });
    fireEvent.change(screen.getByLabelText(vi_['prj.taskforce.member.from.label']), { target: { value: '2026-02-01' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['prj.taskforce.member.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('addTaskForceMember', expect.objectContaining({ path: { id: force(1).id } })));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: vi_['prj.taskforce.dissolve.action'].replace('{code}', 'TF-01') }));
    fireEvent.change(screen.getByLabelText(vi_['prj.taskforce.dissolve.reason.label']), { target: { value: 'The disbursement target was met' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['prj.taskforce.dissolve.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('dissolveTaskForce', expect.objectContaining({ path: { id: force(1).id }, ifMatchVersion: 3 })));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('says that only the whole-tenant office manages task forces to a caller whose grant is on a unit subtree, and shows no form', async () => {
    mount(<TaskForceScreen route={ROUTE} />, screenClient({ forces: [force(1)] }, world({ projects: [line(1)], grants: [{ ...UNIT_GRANT, permissions: ['taskforce.*'] }] })), { permissions: MANAGER, path: '/prj/prj-18' });
    expect((await screen.findByTestId('whole-tenant-notice')).textContent).toBe(vi_['prj.taskforce.wholeTenant.notice']);
    expect(screen.queryByRole('form', { name: vi_['prj.taskforce.create.title'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['prj.taskforce.dissolve.action'].replace('{code}', 'TF-01') })).toBeNull();
    expect(screen.getByTestId('forces')).toBeTruthy();
  });

  it('shows the forces without forms to someone who only reads, and while the session is read-only', async () => {
    const reader = screenClient({ forces: [force(1)] });
    mount(<TaskForceScreen route={ROUTE} />, reader, { permissions: READER, path: '/prj/prj-18' });
    await screen.findByTestId('forces');
    expect(screen.queryByRole('form', { name: vi_['prj.taskforce.create.title'] })).toBeNull();
    expect(reader.read).not.toHaveBeenCalled();
    cleanup();
    mount(<TaskForceScreen route={ROUTE} />, screenClient({ forces: [force(1)] }), { permissions: MANAGER, mode: 'READ_ONLY', path: '/prj/prj-18' });
    await screen.findByTestId('forces');
    expect(screen.queryByRole('form', { name: vi_['prj.taskforce.create.title'] })).toBeNull();
  });

  it('leaves the decision to the server when the permissions are not known, and says when there is no task force', async () => {
    mount(<TaskForceScreen route={ROUTE} />, screenClient({ forces: [] }), { permissions: undefined, path: '/prj/prj-18' });
    expect((await screen.findByTestId('forces-empty')).textContent).toBe(vi_['prj.taskforce.list.empty.notice']);
  });

  it('says that the list could not be read, with a retry', async () => {
    const served: Served = { forces: [], failing: true };
    mount(<TaskForceScreen route={ROUTE} />, screenClient(served), { permissions: READER, path: '/prj/prj-18' });
    expect(await screen.findByRole('alert')).toBeTruthy();
    served.failing = false;
    served.forces = [force(1)];
    fireEvent.click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    await screen.findByTestId('forces');
  });
});
