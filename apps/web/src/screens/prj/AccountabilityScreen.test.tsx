import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import AccountabilityScreen from './AccountabilityScreen';
import { UNIT_GRANT, WHOLE_TENANT_GRANT, client, line, mount, routeOf, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('PRJ-17', 'FR-PRJ-17');
const ASSIGNER = ['project.read', 'project.accountability.assign'];
const READER = ['project.read'];
const LEADER = '00000000-0000-4000-8000-0000000000c1';

const assignment = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-0000000000a${n}`,
  project_id: line(1).id,
  project_code: line(1).code,
  project_name: line(1).name,
  leader: { membership_id: LEADER, display_name: 'Nguyễn Văn An' },
  accountability_role: 'LEADER_IN_CHARGE',
  assignment_document_id: null,
  valid_from: '2026-01-05',
  valid_until: null,
  status: 'ACTIVE',
  end_reason: null,
  version: 1,
  ...overrides,
});
const MEMBERS = [
  { id: LEADER, display_name: 'Nguyễn Văn An', status: 'Active', membership_type: 'STAFF' },
  { id: '00000000-0000-4000-8000-0000000000c2', display_name: 'Contractor', status: 'Active', membership_type: 'GUEST_CONTRACTOR' },
  { id: '00000000-0000-4000-8000-0000000000c3', display_name: 'Suspended', status: 'Suspended' },
  'junk',
];
const OK = { operation_id: 'o', status: 'ENDED', resource_version: 2, resource_id: assignment(1).id };

afterEach(cleanup);

interface Served {
  assignments: unknown[];
  failing?: boolean;
}

/** The register of the screen over a client that serves the reads of PRJ-17 beside those of the project register. */
function screenClient(served: Served, state: World = world({ projects: [line(1)] }), command: (operation: string, input: unknown) => unknown = () => OK) {
  const h = client(state, command);
  const base = (h.client as unknown as { readAll: (operation: string, input?: unknown) => Promise<unknown[]> }).readAll;
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string, input?: unknown) => {
    if (operation === 'get_resources_project_accountability') return served.failing === true ? Promise.reject(new Error('failed')) : Promise.resolve(served.assignments);
    if (operation === 'get_resources_membership') return Promise.resolve(MEMBERS);
    return base(operation, input);
  });
  return h;
}

describe('AccountabilityScreen (PRJ-17): who answers for each project', () => {
  it('UI-PRJ-17: lists the assignments with the history, and offers the form and the end action to the office that administers them on the whole tenant', async () => {
    const served = { assignments: [assignment(1), assignment(2, { status: 'ENDED', valid_until: '2025-12-31', end_reason: 'Moved', valid_from: '2025-01-01' })] };
    mount(<AccountabilityScreen route={ROUTE} />, screenClient(served), { permissions: ASSIGNER, path: '/prj/prj-17' });
    const table = await screen.findByTestId('assignments');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['prj.accountability.page.title']);
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    await screen.findByRole('form', { name: vi_['prj.accountability.assign.title'] });
    expect(screen.getAllByRole('button', { name: vi_['prj.accountability.end.action'].replace('{project}', line(1).code) })).toHaveLength(1);
    expect(screen.queryByTestId('whole-tenant-notice')).toBeNull();
    await waitFor(() => expect(screen.getByLabelText(vi_['prj.accountability.assign.leader.label']).querySelectorAll('option').length).toBe(2));
  });

  it('AC-ST-PRJ-005-1: ends an assignment from the register, with the version it showed, and reads the register again', async () => {
    const served = { assignments: [assignment(1)] };
    const h = screenClient(served);
    mount(<AccountabilityScreen route={ROUTE} />, h, { permissions: ASSIGNER, path: '/prj/prj-17' });
    await screen.findByTestId('assignments');
    fireEvent.click(screen.getByRole('button', { name: vi_['prj.accountability.end.action'].replace('{project}', line(1).code) }));
    fireEvent.change(screen.getByLabelText(vi_['prj.accountability.end.until.label']), { target: { value: '2026-02-01' } });
    fireEvent.change(screen.getByLabelText(vi_['prj.accountability.end.reason.label']), { target: { value: 'Reassigned to another leader' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['prj.accountability.end.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('endProjectLeaderAssignment', expect.objectContaining({ path: { id: assignment(1).id }, ifMatchVersion: 1 })));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('says that only the whole-tenant office administers assignments to a caller whose grant is on a unit subtree, and shows no form', async () => {
    mount(<AccountabilityScreen route={ROUTE} />, screenClient({ assignments: [assignment(1)] }, world({ projects: [line(1)], grants: [UNIT_GRANT] })), { permissions: ASSIGNER, path: '/prj/prj-17' });
    expect((await screen.findByTestId('whole-tenant-notice')).textContent).toBe(vi_['prj.accountability.wholeTenant.notice']);
    expect(screen.queryByRole('form', { name: vi_['prj.accountability.assign.title'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['prj.accountability.end.action'].replace('{project}', line(1).code) })).toBeNull();
    expect(screen.getByTestId('assignments')).toBeTruthy();
  });

  it('shows the register without forms to someone who only reads, and while the session is read-only', async () => {
    const reader = screenClient({ assignments: [assignment(1)] });
    mount(<AccountabilityScreen route={ROUTE} />, reader, { permissions: READER, path: '/prj/prj-17' });
    await screen.findByTestId('assignments');
    expect(screen.queryByRole('form', { name: vi_['prj.accountability.assign.title'] })).toBeNull();
    expect(screen.queryByTestId('whole-tenant-notice')).toBeNull();
    expect(reader.read).not.toHaveBeenCalled();
    cleanup();
    mount(<AccountabilityScreen route={ROUTE} />, screenClient({ assignments: [assignment(1)] }), { permissions: ASSIGNER, mode: 'READ_ONLY', path: '/prj/prj-17' });
    await screen.findByTestId('assignments');
    expect(screen.queryByRole('form', { name: vi_['prj.accountability.assign.title'] })).toBeNull();
  });

  it('leaves the decision to the server when the permissions are not known', async () => {
    mount(<AccountabilityScreen route={ROUTE} />, screenClient({ assignments: [] }), { permissions: undefined, path: '/prj/prj-17' });
    expect((await screen.findByTestId('assignments-empty')).textContent).toBe(vi_['prj.accountability.table.empty.notice']);
  });

  it('says that the register could not be read, with a retry', async () => {
    const served: Served = { assignments: [], failing: true };
    mount(<AccountabilityScreen route={ROUTE} />, screenClient(served), { permissions: READER, path: '/prj/prj-17' });
    expect(await screen.findByRole('alert')).toBeTruthy();
    served.failing = false;
    served.assignments = [assignment(1)];
    fireEvent.click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    await screen.findByTestId('assignments');
  });

  it('keeps a grant on the whole tenant that does not carry the permission from showing the forms', async () => {
    mount(<AccountabilityScreen route={ROUTE} />, screenClient({ assignments: [] }, world({ projects: [line(1)], grants: [{ ...WHOLE_TENANT_GRANT, permissions: ['project.read'] }] })), { permissions: ASSIGNER, path: '/prj/prj-17' });
    expect((await screen.findByTestId('whole-tenant-notice')).textContent).toBe(vi_['prj.accountability.wholeTenant.notice']);
  });
});
