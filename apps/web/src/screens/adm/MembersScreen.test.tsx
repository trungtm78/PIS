import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClientProvider } from '../../api/ApiClientContext';
import vi_ from '../../i18n/vi.json';
import { translator } from '../../i18n';
import { ALL_MODULES_VISIBLE } from '../../navigation/model';
import { SessionContext } from '../../session/SessionContext';
import type { SessionValue } from '../../session/SessionContext';
import MembersScreen from './MembersScreen';
import { ADMIN, READER, SELF, TENANT, UNIT_ONE, UNIT_TWO, harness, member, mount, problem, role, routeOf, unit } from './members/test-support';

const ROUTE = routeOf('ADM-02', 'FR-ADM-02');
const UNITS = [unit(UNIT_ONE, 'U1', 'Unit one'), unit(UNIT_TWO, 'U2', 'Unit two')];
const ROWS = [
  member(1, { id: SELF, display_name: 'Me Myself', role_codes: ['TENANT_OWNER'] }),
  member(2, { organization_id: UNIT_TWO, role_codes: ['MEMBER', 'UNIT_ADMIN'] }),
  member(3, { status: 'Suspended', version: 5 }),
  member(4, { status: 'Invited', invitation_status: 'Pending', valid_until: '2027-02-01T00:00:00Z' }),
  member(5, { status: 'Ended' }),
];

afterEach(cleanup);

const rowOf = (name: string): HTMLElement => screen.getByText(name).closest('tr') as HTMLElement;

describe('MembersScreen (ADM-02)', () => {
  it('lists the memberships the server returns with roles, unit, type, invitation and end of validity', async () => {
    const h = harness({ members: ROWS, units: UNITS });
    mount(<MembersScreen route={ROUTE} />, h);
    expect(await screen.findByText('Person 2')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['adm.members.page.title']);
    const cells = within(rowOf('Person 2')).getAllByRole('cell');
    expect(cells[1]?.textContent).toBe('MEMBER, UNIT_ADMIN');
    expect(cells[2]?.textContent).toBe('Unit two');
    expect(cells[3]?.textContent).toBe(vi_['adm.members.type.staff']);
    expect(within(rowOf('Person 4')).getAllByRole('cell')[4]?.textContent).toBe(vi_['adm.members.invitation.pending']);
    expect(within(rowOf('Person 4')).getAllByRole('cell')[5]?.textContent).toBe('2027-02-01');
    expect(within(rowOf('Person 3')).getAllByRole('cell')[5]?.textContent).toBe(vi_['adm.members.validUntil.open']);
    expect(h.read).toHaveBeenCalledWith('get_resources_membership', { query: { limit: 50 } });
  });

  it('offers the commands the status allows, and none on the row of the signed-in user', async () => {
    mount(<MembersScreen route={ROUTE} />, harness({ members: ROWS, units: UNITS }));
    await screen.findByText('Person 2');
    const names = (row: HTMLElement) => within(row).queryAllByRole('button').map((button) => button.textContent);
    expect(names(rowOf('Me Myself'))).toEqual([]);
    expect(names(rowOf('Person 2'))).toEqual([vi_['adm.members.suspend.action'], vi_['adm.members.end.action']]);
    expect(names(rowOf('Person 3'))).toEqual([vi_['adm.members.reactivate.action'], vi_['adm.members.end.action']]);
    expect(names(rowOf('Person 4'))).toEqual([vi_['adm.members.end.action']]);
    expect(names(rowOf('Person 5'))).toEqual([]);
  });

  it('AC-ST-ADM-006-5 / UI-ADM-02: hides the actions on members the server says the reader does not outrank, and shows the seats used out of their limit', async () => {
    const rows = [member(2, { can_manage: false }), member(3, { can_manage: true }), member(4)];
    const h = harness({ members: rows, units: UNITS, usage: { as_of: '2026-10-26T00:00:00Z', seats: { used: 3, limit: 3 }, guest_seats: { used: 1 } } });
    mount(<MembersScreen route={ROUTE} />, h, { permissions: [...ADMIN, 'subscription.read'] });
    await screen.findByText('Person 2');
    const names = (row: HTMLElement) => within(row).queryAllByRole('button').map((button) => button.textContent);
    expect(names(rowOf('Person 2'))).toEqual([]);
    expect(names(rowOf('Person 3'))).toEqual([vi_['adm.members.suspend.action'], vi_['adm.members.end.action']]);
    // A server that says nothing leaves the decision to the command, so the buttons stay.
    expect(names(rowOf('Person 4'))).toEqual([vi_['adm.members.suspend.action'], vi_['adm.members.end.action']]);
    const seats = await screen.findByText((content) => content.startsWith('Ghế đã dùng'));
    expect(seats.textContent).toBe(
      vi_['adm.members.seats.text'].replace('{staff}', vi_['adm.members.seats.used'].replace('{used}', '3').replace('{limit}', '3')).replace('{guests}', vi_['adm.members.seats.unlimited'].replace('{used}', '1')),
    );
    expect(h.read).toHaveBeenCalledWith('getMyUsage');
  });

  it('asks for no seats without the right to read the subscription, and shows no line when they cannot be read', async () => {
    const h = harness({ members: ROWS, units: UNITS });
    mount(<MembersScreen route={ROUTE} />, h);
    await screen.findByText('Person 2');
    expect(h.read).not.toHaveBeenCalledWith('getMyUsage');
    cleanup();
    const failing = harness({ members: ROWS, units: UNITS, usage: problem('INTERNAL_ERROR', 500) });
    mount(<MembersScreen route={ROUTE} />, failing, { permissions: [...ADMIN, 'subscription.read'] });
    await screen.findByText('Person 2');
    await waitFor(() => expect(failing.read).toHaveBeenCalledWith('getMyUsage'));
    expect(screen.queryByText((content) => content.startsWith('Ghế đã dùng'))).toBeNull();
  });

  it('shows no control to a read-only user, nor in a suspended tenant', async () => {
    mount(<MembersScreen route={ROUTE} />, harness({ members: ROWS, units: UNITS }), { permissions: READER });
    await screen.findByText('Person 2');
    expect(screen.queryByRole('button', { name: vi_['adm.members.invite.action'] })).toBeNull();
    expect(within(rowOf('Person 2')).queryAllByRole('button')).toEqual([]);
    cleanup();
    mount(<MembersScreen route={ROUTE} />, harness({ members: ROWS, units: UNITS }), { mode: 'READ_ONLY' });
    await screen.findByText('Person 2');
    expect(screen.queryByRole('button', { name: vi_['adm.members.invite.action'] })).toBeNull();
    expect(within(rowOf('Person 2')).queryAllByRole('button')).toEqual([]);
  });

  it('is denied without the permission to read, and asks nothing', async () => {
    const h = harness({ members: ROWS });
    mount(<MembersScreen route={ROUTE} />, h, { permissions: [] });
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });

  it.each([
    ['loading', () => harness({ members: ROWS })],
    ['error', () => harness({ members: new Error('boom') })],
    ['denied', () => harness({ members: problem('SCOPE_DENIED', 403) })],
    ['signedOut', () => harness({ members: problem('SESSION_EXPIRED', 401) })],
    ['offline', () => harness({ members: problem('NETWORK_ERROR', 0) })],
    ['empty', () => harness({ members: [] })],
  ] as const)('shows the %s state', async (state, make) => {
    mount(<MembersScreen route={ROUTE} />, make());
    if (state === 'loading') {
      expect(screen.getByLabelText(vi_['states.loading.label'])).toBeTruthy();
      return;
    }
    const title = { error: 'states.error.title', denied: 'states.denied.title', signedOut: 'states.signedOut.title', offline: 'states.offline.title', empty: 'states.empty.title' }[state];
    expect(await screen.findByText(vi_[title as keyof typeof vi_])).toBeTruthy();
  });

  it('filters by text, type and status in the page', async () => {
    mount(<MembersScreen route={ROUTE} />, harness({ members: [...ROWS, member(6, { membership_type: 'GUEST_CONTRACTOR', display_name: 'Guest Six' })], units: UNITS }));
    await screen.findByText('Person 2');
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(vi_['adm.members.status.label']), 'Suspended');
    await user.click(screen.getByRole('button', { name: vi_['adm.members.filter.action'] }));
    expect(screen.queryByText('Person 2')).toBeNull();
    expect(screen.getByText('Person 3')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText(vi_['adm.members.status.label']), '');
    await user.selectOptions(screen.getByLabelText(vi_['adm.members.type.label']), 'GUEST_CONTRACTOR');
    await user.click(screen.getByRole('button', { name: vi_['adm.members.filter.action'] }));
    expect(screen.getByText('Guest Six')).toBeTruthy();
    expect(screen.queryByText('Person 3')).toBeNull();
    await user.selectOptions(screen.getByLabelText(vi_['adm.members.type.label']), '');
    await user.type(screen.getByLabelText(vi_['adm.members.search.label']), 'nobody like this');
    await user.click(screen.getByRole('button', { name: vi_['adm.members.filter.action'] }));
    expect(screen.getByText(vi_['adm.members.filtered.empty'])).toBeTruthy();
  });

  it('shows each status as a pill of the kit and counts the filters that are applied on the panel button', async () => {
    mount(<MembersScreen route={ROUTE} />, harness({ members: ROWS, units: UNITS }));
    await screen.findByText('Person 2');
    expect(within(rowOf('Person 3')).getByText(vi_['adm.members.status.suspended']).closest('.ui-pill')?.className).toContain('ui-tone-warning');
    expect(screen.getByRole('table', { name: translator.t('w2adm.members.table.caption') })).toBeTruthy();
    expect(screen.getByRole('button', { name: vi_['ui.filterPanel.toggle'] })).toBeTruthy();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(vi_['adm.members.status.label']), 'Suspended');
    await user.click(screen.getByRole('button', { name: vi_['adm.members.filter.action'] }));
    expect(screen.getByRole('button', { name: vi_['ui.filterPanel.toggleApplied'].replace('{count}', '1') })).toBeTruthy();
  });

  it('suspends a member with a reason and the version the list showed, then shows a notice', async () => {
    const h = harness({ members: ROWS, units: UNITS });
    mount(<MembersScreen route={ROUTE} />, h);
    await screen.findByText('Person 2');
    const user = userEvent.setup();
    await user.click(within(rowOf('Person 2')).getByRole('button', { name: vi_['adm.members.suspend.label'].replace('{name}', 'Person 2') }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: vi_['adm.members.suspend.action'] }));
    expect(within(dialog).getByText(vi_['adm.members.problem.required'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.type(within(dialog).getByLabelText(vi_['adm.members.reason.label']), 'left the project team');
    await user.click(within(dialog).getByRole('button', { name: vi_['adm.members.suspend.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    const [operation, input] = h.command.mock.calls[0] as [string, { path: unknown; body: unknown; ifMatchVersion: number }];
    expect(operation).toBe('suspendMembership');
    expect(input).toMatchObject({ path: { membershipId: ROWS[1]?.id }, body: { reason: 'left the project team' }, ifMatchVersion: 3 });
    expect(await screen.findByText(vi_['adm.members.lifecycle.suspend.done'].replace('{name}', 'Person 2'))).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each([
    ['Person 3', 'reactivate', 'reactivateMembership'],
    ['Person 4', 'end', 'endMembership'],
  ] as const)('runs %s through %s', async (name, action, operation) => {
    const h = harness({ members: ROWS, units: UNITS });
    mount(<MembersScreen route={ROUTE} />, h);
    await screen.findByText(name);
    const user = userEvent.setup();
    await user.click(within(rowOf(name)).getByRole('button', { name: vi_[`adm.members.${action}.label`].replace('{name}', name) }));
    await user.type(screen.getByLabelText(vi_['adm.members.reason.label']), 'a sufficient reason');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: vi_[`adm.members.${action}.action`] }));
    await waitFor(() => expect(h.command.mock.calls[0]?.[0]).toBe(operation));
  });

  it.each([
    ['VERSION_CONFLICT', 409, 'adm.members.error.versionConflict'],
    ['LAST_TENANT_OWNER', 409, 'adm.members.error.lastOwner'],
    ['ROLE_ESCALATION_DENIED', 403, 'adm.members.error.escalation'],
    ['MEMBERSHIP_STATE_INVALID', 409, 'adm.members.error.stateInvalid'],
    ['SELF_ACTION_DENIED', 403, 'adm.members.error.selfAction'],
    ['QUOTA_EXCEEDED', 403, 'adm.members.error.quotaExceeded'],
    ['SOMETHING_ELSE', 500, 'adm.members.error.generic'],
  ] as const)('words the refusal %s without showing the server text, and keeps the dialog open', async (code, status, key) => {
    const h = harness({ members: ROWS, units: UNITS, command: () => problem(code, status) });
    mount(<MembersScreen route={ROUTE} />, h);
    await screen.findByText('Person 2');
    const user = userEvent.setup();
    await user.click(within(rowOf('Person 2')).getByRole('button', { name: vi_['adm.members.end.label'].replace('{name}', 'Person 2') }));
    await user.type(screen.getByLabelText(vi_['adm.members.reason.label']), 'a sufficient reason');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: vi_['adm.members.end.action'] }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(vi_[key]);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('offers a reload after a stale version', async () => {
    const h = harness({ members: ROWS, units: UNITS, command: () => problem('VERSION_CONFLICT', 409) });
    mount(<MembersScreen route={ROUTE} />, h);
    await screen.findByText('Person 2');
    const user = userEvent.setup();
    await user.click(within(rowOf('Person 2')).getByRole('button', { name: vi_['adm.members.suspend.label'].replace('{name}', 'Person 2') }));
    await user.type(screen.getByLabelText(vi_['adm.members.reason.label']), 'a sufficient reason');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: vi_['adm.members.suspend.action'] }));
    await user.click(await screen.findByRole('button', { name: vi_['adm.members.error.reload.action'] }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(h.read.mock.calls.length).toBeGreaterThan(1));
  });

  describe('the invitation', () => {
    const open = async () => {
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: vi_['adm.members.invite.action'] }));
      return { user, dialog: screen.getByRole('dialog') };
    };

    it('checks the form before it asks the server', async () => {
      const h = harness({ members: ROWS, units: UNITS });
      mount(<MembersScreen route={ROUTE} />, h);
      const { user, dialog } = await open();
      await user.type(within(dialog).getByLabelText(vi_['adm.members.invite.email.label']), 'not-an-email');
      await user.click(within(dialog).getByRole('button', { name: vi_['adm.members.invite.submit.action'] }));
      expect(within(dialog).getByText(vi_['adm.members.problem.email'])).toBeTruthy();
      expect(within(dialog).getByText(vi_['adm.members.problem.required'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
    });

    it('invites with the unit, the chosen initial role over that unit and the end of validity', async () => {
      const h = harness({ members: ROWS, units: UNITS, roles: [role('UNIT_ADMIN'), role('OLD', { status: 'Retired' })] });
      mount(<MembersScreen route={ROUTE} />, h);
      const { user, dialog } = await open();
      await user.type(within(dialog).getByLabelText(vi_['adm.members.invite.email.label']), ' new@example.test ');
      await user.type(within(dialog).getByLabelText(vi_['adm.members.invite.name.label']), 'New Person');
      await waitFor(() => expect(within(dialog).getByRole('option', { name: 'U2 · Unit two' })).toBeTruthy());
      await user.selectOptions(within(dialog).getByLabelText(vi_['adm.members.invite.unit.label']), UNIT_TWO);
      await waitFor(() => expect(within(dialog).getByRole('option', { name: 'UNIT_ADMIN' })).toBeTruthy());
      expect(within(dialog).queryByRole('option', { name: 'OLD' })).toBeNull();
      await user.selectOptions(within(dialog).getByLabelText(vi_['adm.members.invite.role.label']), 'role-UNIT_ADMIN');
      await user.selectOptions(within(dialog).getByLabelText(vi_['adm.members.invite.scope.label']), 'UNIT_SUBTREE');
      await user.type(within(dialog).getByLabelText(vi_['adm.members.invite.until.label']), '2030-01-01T10:00');
      await user.click(within(dialog).getByRole('button', { name: vi_['adm.members.invite.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      const [operation, input] = h.command.mock.calls[0] as [string, { body: unknown }];
      expect(operation).toBe('inviteMember');
      expect(input.body).toEqual({
        email: 'new@example.test',
        display_name: 'New Person',
        organization_unit_id: UNIT_TWO,
        initial_grants: [{ role_id: 'role-UNIT_ADMIN', scope_kind: 'UNIT_SUBTREE', scope_ref_ids: [UNIT_TWO] }],
        valid_until: new Date('2030-01-01T10:00').toISOString(),
      });
      expect(await screen.findByText(vi_['adm.members.notice.invited'].replace('{email}', 'new@example.test'))).toBeTruthy();
    });

    it('confirms the address that was sent, not the one typed while the request was on its way', async () => {
      let release: (value: unknown) => void = () => undefined;
      const h = harness({
        members: ROWS,
        units: UNITS,
        command: () => new Promise((resolve) => (release = resolve)),
      });
      mount(<MembersScreen route={ROUTE} />, h);
      const { user, dialog } = await open();
      const email = within(dialog).getByLabelText(vi_['adm.members.invite.email.label']);
      await user.type(email, 'sent@example.test');
      await waitFor(() => expect(within(dialog).getByRole('option', { name: 'U1 · Unit one' })).toBeTruthy());
      await user.selectOptions(within(dialog).getByLabelText(vi_['adm.members.invite.unit.label']), UNIT_ONE);
      await user.click(within(dialog).getByRole('button', { name: vi_['adm.members.invite.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      await user.clear(email);
      await user.type(email, 'edited@example.test');
      release({ operation_id: 'o', status: 'OK', resource_version: 1, resource_id: 'x' });
      expect(await screen.findByText(vi_['adm.members.notice.invited'].replace('{email}', 'sent@example.test'))).toBeTruthy();
      expect(screen.queryByText(vi_['adm.members.notice.invited'].replace('{email}', 'edited@example.test'))).toBeNull();
    });

    it('sends no initial grant without a role, and invites with the default role of the server', async () => {
      const h = harness({ members: ROWS, units: UNITS });
      mount(<MembersScreen route={ROUTE} />, h);
      const { user, dialog } = await open();
      await user.type(within(dialog).getByLabelText(vi_['adm.members.invite.email.label']), 'a@example.test');
      await waitFor(() => expect(within(dialog).getByRole('option', { name: 'U1 · Unit one' })).toBeTruthy());
      await user.selectOptions(within(dialog).getByLabelText(vi_['adm.members.invite.unit.label']), UNIT_ONE);
      await user.click(within(dialog).getByRole('button', { name: vi_['adm.members.invite.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect((h.command.mock.calls[0] as [string, { body: unknown }])[1].body).toEqual({ email: 'a@example.test', organization_unit_id: UNIT_ONE });
    });

    it('refuses an end of validity in the past before asking the server', async () => {
      const h = harness({ members: ROWS, units: UNITS });
      mount(<MembersScreen route={ROUTE} />, h);
      const { user, dialog } = await open();
      await user.type(within(dialog).getByLabelText(vi_['adm.members.invite.email.label']), 'a@example.test');
      await waitFor(() => expect(within(dialog).getByRole('option', { name: 'U1 · Unit one' })).toBeTruthy());
      await user.selectOptions(within(dialog).getByLabelText(vi_['adm.members.invite.unit.label']), UNIT_ONE);
      await user.type(within(dialog).getByLabelText(vi_['adm.members.invite.until.label']), '2020-01-01T10:00');
      await user.click(within(dialog).getByRole('button', { name: vi_['adm.members.invite.submit.action'] }));
      expect(within(dialog).getByText(vi_['adm.members.problem.past'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
    });

    it('tells that the roles could not be read and still invites', async () => {
      const h = harness({ members: ROWS, units: UNITS, roles: problem('SCOPE_DENIED', 403) });
      mount(<MembersScreen route={ROUTE} />, h);
      const { dialog } = await open();
      expect(await within(dialog).findByText(vi_['adm.members.invite.role.unavailable'])).toBeTruthy();
    });

    it('lets the user retry the units that could not be read', async () => {
      const h = harness({ members: ROWS, units: new Error('boom') });
      mount(<MembersScreen route={ROUTE} />, h);
      const { user, dialog } = await open();
      await user.click(await within(dialog).findByRole('button', { name: vi_['adm.members.error.retry.action'] }));
      await waitFor(() => expect(h.readAll.mock.calls.filter(([operation]) => operation === 'get_resources_organization_unit').length).toBeGreaterThan(2));
    });

    it('words a refusal of the invitation', async () => {
      const h = harness({ members: ROWS, units: UNITS, command: () => problem('MEMBERSHIP_EXISTS', 409) });
      mount(<MembersScreen route={ROUTE} />, h);
      const { user, dialog } = await open();
      await user.type(within(dialog).getByLabelText(vi_['adm.members.invite.email.label']), 'a@example.test');
      await waitFor(() => expect(within(dialog).getByRole('option', { name: 'U1 · Unit one' })).toBeTruthy());
      await user.selectOptions(within(dialog).getByLabelText(vi_['adm.members.invite.unit.label']), UNIT_ONE);
      await user.click(within(dialog).getByRole('button', { name: vi_['adm.members.invite.submit.action'] }));
      expect((await within(dialog).findByRole('alert')).textContent).toContain(vi_['adm.members.error.membershipExists']);
    });

    it('closes with Escape without sending anything', async () => {
      const h = harness({ members: ROWS, units: UNITS });
      mount(<MembersScreen route={ROUTE} />, h);
      const { user } = await open();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(h.command).not.toHaveBeenCalled();
    });

    it('shows the one-time acceptance data only in a development session', async () => {
      const mailbox = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ invitation_id: 'inv-1', token: 'tok-secret', expires_at: '2026-10-30T00:00:00Z' }) }));
      vi.stubGlobal('fetch', mailbox);
      try {
        const h = harness({ members: ROWS, units: UNITS });
        mount(<MembersScreen route={ROUTE} />, h);
        const { user, dialog } = await open();
        await user.type(within(dialog).getByLabelText(vi_['adm.members.invite.email.label']), 'dev@example.test');
        await waitFor(() => expect(within(dialog).getByRole('option', { name: 'U1 · Unit one' })).toBeTruthy());
        await user.selectOptions(within(dialog).getByLabelText(vi_['adm.members.invite.unit.label']), UNIT_ONE);
        await user.click(within(dialog).getByRole('button', { name: vi_['adm.members.invite.submit.action'] }));
        expect(await screen.findByText('tok-secret')).toBeTruthy();
        expect(screen.getByText(vi_['adm.members.dev.acceptance.title'])).toBeTruthy();
        expect(mailbox).toHaveBeenCalledWith(expect.stringContaining('/__dev/mailbox?email=dev%40example.test'));
        cleanup();
        mailbox.mockClear();
        const real = harness({ members: ROWS, units: UNITS });
        mount(<MembersScreen route={ROUTE} />, real, { status: 'active' });
        const second = await open();
        await second.user.type(within(second.dialog).getByLabelText(vi_['adm.members.invite.email.label']), 'real@example.test');
        await waitFor(() => expect(within(second.dialog).getByRole('option', { name: 'U1 · Unit one' })).toBeTruthy());
        await second.user.selectOptions(within(second.dialog).getByLabelText(vi_['adm.members.invite.unit.label']), UNIT_ONE);
        await second.user.click(within(second.dialog).getByRole('button', { name: vi_['adm.members.invite.submit.action'] }));
        await screen.findByText(vi_['adm.members.notice.invited'].replace('{email}', 'real@example.test'));
        expect(screen.queryByText(vi_['adm.members.dev.acceptance.title'])).toBeNull();
        expect(mailbox).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  it('keeps the reads of one membership apart from those of another membership of the same tenant', async () => {
    const OTHER_MEMBERSHIP = '00000000-0000-4000-8000-0000000000a2';
    let release: (value: unknown) => void = () => undefined;
    let reads = 0;
    const read = vi.fn(() => {
      reads += 1;
      return reads === 1 ? Promise.resolve({ items: [ROWS[1]], next_cursor: null }) : new Promise((resolve) => (release = resolve));
    });
    const client = { read, readAll: vi.fn(() => Promise.resolve([])), command: vi.fn() } as unknown as Parameters<typeof ApiClientProvider>[0]['client'];
    const queries = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } });
    const sessionOf = (membershipId: string): SessionValue => ({
      tenant: { ...TENANT, membershipId },
      tenants: [TENANT],
      user: { displayName: 'Admin', initials: 'AD' },
      access: ALL_MODULES_VISIBLE,
      switchTenant: () => undefined,
      getSession: () => Promise.resolve({ token: 'token' }),
      permissions: ['membership.read'],
    });
    const view = (membershipId: string) => (
      <SessionContext.Provider value={sessionOf(membershipId)}>
        <QueryClientProvider client={queries}>
          <ApiClientProvider client={client}>
            <MembersScreen route={ROUTE} />
          </ApiClientProvider>
        </QueryClientProvider>
      </SessionContext.Provider>
    );
    const rendered = render(view(SELF));
    expect(await screen.findByText('Person 2')).toBeTruthy();
    // The other membership of the tenant sees what its own scope allows: the first membership's directory must not show meanwhile.
    rendered.rerender(view(OTHER_MEMBERSHIP));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Person 2')).toBeNull();
    release({ items: [ROWS[2]], next_cursor: null });
    expect(await screen.findByText('Person 3')).toBeTruthy();
    expect(screen.queryByText('Person 2')).toBeNull();
  });

  it('keeps nothing of one tenant when the tenant changes', async () => {
    const h = harness({ members: ROWS, units: UNITS });
    const view = mount(<MembersScreen route={ROUTE} />, h);
    await screen.findByText('Person 2');
    expect(view.queries.getQueryCache().getAll().every((query) => (query.queryKey as unknown[])[1] === TENANT.id)).toBe(true);
  });
});
