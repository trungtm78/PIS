import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { translator } from '../../i18n';
import GuestContractorsScreen from './GuestContractorsScreen';
import { ADMIN, CONTRACTOR_ONE, CONTRACTOR_TWO, READER, contract, guest, harness, mount, problem, role, routeOf } from './members/test-support';

const ROUTE = routeOf('ADM-17', 'FR-ADM-17');
const DAY = 86_400_000;
const ROWS = [guest(1), guest(2, { status: 'Invited', invitation_status: 'Pending', contracts: [], contractor_name: 'Other Builders', contractor_id: CONTRACTOR_TWO }), guest(3, { status: 'Suspended' })];
const CONTRACTS = [
  contract(1),
  contract(2, { completion_due: null, status: 'SIGNED' }),
  contract(3, { status: 'DRAFT' }),
  contract(4, { contractor_id: CONTRACTOR_TWO, contractor_name: 'Other Builders', completion_due: '2027-06-30' }),
  contract(5, { status: 'CLOSED' }),
];
const ROLES = [role('GUEST_CONTRACTOR', { guest_allowed: true }), role('STAFF_ONLY'), role('RETIRED_GUEST', { guest_allowed: true, status: 'Retired' })];

afterEach(cleanup);

const rowOf = (text: string): HTMLElement => screen.getAllByText(text)[0]?.closest('tr') as HTMLElement;

async function open(h = harness({ members: ROWS, contracts: CONTRACTS, roles: ROLES })) {
  mount(<GuestContractorsScreen route={ROUTE} />, h);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: vi_['adm.guests.invite.action'] }));
  const dialog = screen.getByRole('dialog');
  await waitFor(() => expect(within(dialog).getByRole('option', { name: 'Cao Bang Builders' })).toBeTruthy());
  return { h, user, dialog };
}

describe('GuestContractorsScreen (ADM-17)', () => {
  it('lists only the guests, with contractor, contracts, role and end of access, asking the server for that type (AC-ST-ADM-007-3)', async () => {
    const h = harness({ members: ROWS });
    mount(<GuestContractorsScreen route={ROUTE} />, h);
    expect(await screen.findByText('Other Builders')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['adm.guests.page.title']);
    expect(h.read).toHaveBeenCalledWith('get_resources_membership', { query: { limit: 50, membership_type: 'GUEST_CONTRACTOR' } });
    const cells = within(rowOf('p1@example.test')).getAllByRole('cell');
    expect(cells[0]?.textContent).toContain('Cao Bang Builders');
    expect(cells[2]?.textContent).toBe('GC-A1');
    expect(cells[3]?.textContent).toBe('GUEST_CONTRACTOR');
    expect(cells[4]?.textContent).toBe('2027-03-31');
    expect(within(rowOf('p2@example.test')).getAllByRole('cell')[2]?.textContent).toBe(vi_['adm.guests.contracts.none']);
  });

  it('shows the status of each guest as a pill of the kit and keeps the table in its own scroll region', async () => {
    mount(<GuestContractorsScreen route={ROUTE} />, harness({ members: ROWS }));
    await screen.findByText('Other Builders');
    expect(within(rowOf('p3@example.test')).getByText(vi_['adm.members.status.suspended']).closest('.ui-pill')?.className).toContain('ui-tone-warning');
    expect(within(rowOf('p1@example.test')).getByText(vi_['adm.members.status.active']).closest('.ui-pill')?.className).toContain('ui-tone-success');
    expect(screen.getByRole('region', { name: translator.t('w2adm.guests.table.caption') })).toBeTruthy();
  });

  it('offers the commands of the status, and none to a read-only user', async () => {
    mount(<GuestContractorsScreen route={ROUTE} />, harness({ members: ROWS }));
    await screen.findByText('Other Builders');
    expect(within(rowOf('p3@example.test')).getAllByRole('button').map((button) => button.textContent)).toEqual([vi_['adm.members.reactivate.action'], vi_['adm.members.end.action']]);
    cleanup();
    mount(<GuestContractorsScreen route={ROUTE} />, harness({ members: ROWS }), { permissions: READER });
    await screen.findByText('Other Builders');
    expect(screen.queryByRole('button', { name: vi_['adm.guests.invite.action'] })).toBeNull();
    expect(within(rowOf('p3@example.test')).queryAllByRole('button')).toEqual([]);
  });

  it('invites a guest only with the guest permission, not with the member permission', async () => {
    mount(<GuestContractorsScreen route={ROUTE} />, harness({ members: ROWS }), { permissions: ['membership.read', 'iam.member.invite', 'iam.member.manage'] });
    await screen.findByText('Other Builders');
    expect(screen.queryByRole('button', { name: vi_['adm.guests.invite.action'] })).toBeNull();
  });

  it('filters by text over contractor, email and contract code, and by status', async () => {
    mount(<GuestContractorsScreen route={ROUTE} />, harness({ members: ROWS }));
    await screen.findByText('Other Builders');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(vi_['adm.members.search.label']), 'gc-a1');
    await user.click(screen.getByRole('button', { name: vi_['adm.members.filter.action'] }));
    expect(screen.queryByText('Other Builders')).toBeNull();
    await user.clear(screen.getByLabelText(vi_['adm.members.search.label']));
    await user.selectOptions(screen.getByLabelText(vi_['adm.members.status.label']), 'Invited');
    await user.click(screen.getByRole('button', { name: vi_['adm.members.filter.action'] }));
    expect(screen.getByText('Other Builders')).toBeTruthy();
    expect(screen.queryByText('p3@example.test')).toBeNull();
  });

  it.each([
    ['error', () => harness({ members: new Error('boom') }), 'states.error.title'],
    ['denied', () => harness({ members: problem('SCOPE_DENIED', 403) }), 'states.denied.title'],
    ['empty', () => harness({ members: [] }), 'states.empty.title'],
  ] as const)('shows the %s state (AC-ST-ADM-007-3)', async (_state, make, title) => {
    mount(<GuestContractorsScreen route={ROUTE} />, make());
    expect(await screen.findByText(vi_[title])).toBeTruthy();
  });

  it('still offers the invitation when there is no guest yet', async () => {
    mount(<GuestContractorsScreen route={ROUTE} />, harness({ members: [] }));
    expect(await screen.findByRole('button', { name: vi_['adm.guests.invite.action'] })).toBeTruthy();
  });

  it('is denied without the permission to read, and loading shows the skeleton', async () => {
    const h = harness({ members: ROWS });
    mount(<GuestContractorsScreen route={ROUTE} />, h, { permissions: [] });
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
    cleanup();
    mount(<GuestContractorsScreen route={ROUTE} />, harness({ members: ROWS }));
    expect(screen.getByLabelText(vi_['states.loading.label'])).toBeTruthy();
  });

  describe('the invitation', () => {
    it('offers the contractors of the contracts in force the caller reaches, and the contracts of the chosen contractor only', async () => {
      const { user, dialog } = await open();
      const contractors = within(dialog).getByLabelText(vi_['adm.guests.invite.contractor.label']);
      expect(within(contractors).getAllByRole('option').map((option) => option.textContent)).toEqual([vi_['adm.guests.invite.contractor.placeholder'], 'Cao Bang Builders', 'Other Builders']);
      expect(within(dialog).getByText(vi_['adm.guests.invite.contracts.pick'])).toBeTruthy();
      await user.selectOptions(contractors, CONTRACTOR_ONE);
      // DRAFT and CLOSED contracts are not offered; the other contractor's contract is not offered here.
      expect(within(dialog).getAllByRole('checkbox').map((box) => box.parentElement?.textContent)).toEqual([
        `GC-1${vi_['adm.guests.invite.contract.ends'].replace('{date}', '2027-03-31')}`,
        `GC-2${vi_['adm.guests.invite.contract.open']}`,
      ]);
      await user.click(within(dialog).getAllByRole('checkbox')[0] as HTMLElement);
      await user.selectOptions(contractors, CONTRACTOR_TWO);
      expect(within(dialog).getAllByRole('checkbox')).toHaveLength(1);
      expect((within(dialog).getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    });

    it('offers only the active roles that guests may hold', async () => {
      const { dialog } = await open();
      expect(within(within(dialog).getByLabelText(vi_['adm.guests.invite.role.label'])).getAllByRole('option').map((option) => option.textContent)).toEqual([vi_['adm.guests.invite.role.placeholder'], 'GUEST_CONTRACTOR']);
    });

    it('checks the form, including the bound of the end of access, before it asks the server', async () => {
      const { h, user, dialog } = await open();
      await user.click(within(dialog).getByRole('button', { name: vi_['adm.guests.invite.submit.action'] }));
      for (const text of [vi_['adm.members.problem.required']]) expect(within(dialog).getAllByText(text).length).toBeGreaterThanOrEqual(4);
      expect(h.command).not.toHaveBeenCalled();
      await user.type(within(dialog).getByLabelText(vi_['adm.members.invite.email.label']), 'guest@example.test');
      await user.selectOptions(within(dialog).getByLabelText(vi_['adm.guests.invite.contractor.label']), CONTRACTOR_ONE);
      await user.click(within(dialog).getAllByRole('checkbox')[0] as HTMLElement);
      await user.selectOptions(within(dialog).getByLabelText(vi_['adm.guests.invite.role.label']), 'role-GUEST_CONTRACTOR');
      const beyond = new Date(Date.parse('2027-03-31T00:00:00Z') + 400 * DAY);
      await user.type(within(dialog).getByLabelText(vi_['adm.guests.invite.until.label']), beyond.toISOString().slice(0, 16));
      await user.click(within(dialog).getByRole('button', { name: vi_['adm.guests.invite.submit.action'] }));
      expect(within(dialog).getByText(/^Không được muộn hơn/)).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
    });

    it('sends the contractor, the contracts, the role and the end of access', async () => {
      const { h, user, dialog } = await open();
      await user.type(within(dialog).getByLabelText(vi_['adm.members.invite.email.label']), ' guest@example.test ');
      await user.selectOptions(within(dialog).getByLabelText(vi_['adm.guests.invite.contractor.label']), CONTRACTOR_ONE);
      for (const box of within(dialog).getAllByRole('checkbox')) await user.click(box);
      await user.selectOptions(within(dialog).getByLabelText(vi_['adm.guests.invite.role.label']), 'role-GUEST_CONTRACTOR');
      await user.type(within(dialog).getByLabelText(vi_['adm.guests.invite.until.label']), '2027-01-15T10:00');
      await user.click(within(dialog).getByRole('button', { name: vi_['adm.guests.invite.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      const [operation, input] = h.command.mock.calls[0] as [string, { body: unknown }];
      expect(operation).toBe('inviteGuestContractor');
      expect(input.body).toEqual({
        email: 'guest@example.test',
        contractor_id: CONTRACTOR_ONE,
        contract_ids: [CONTRACTS[0]?.id, CONTRACTS[1]?.id],
        role_id: 'role-GUEST_CONTRACTOR',
        valid_until: new Date('2027-01-15T10:00').toISOString(),
      });
      expect(await screen.findByText(vi_['adm.members.notice.invited'].replace('{email}', 'guest@example.test'))).toBeTruthy();
    });

    it.each([
      ['GUEST_SCOPE_INVALID', 422, 'adm.members.error.guestScope'],
      ['CONTRACT_NOT_ACTIVE', 422, 'adm.members.error.contractNotActive'],
      ['SCOPE_OUT_OF_GRANTOR_RANGE', 403, 'adm.members.error.escalation'],
      ['MEMBERSHIP_EXISTS', 409, 'adm.members.error.membershipExists'],
    ] as const)('words the refusal %s and keeps the dialog', async (code, status, key) => {
      const { user, dialog } = await open(harness({ members: ROWS, contracts: CONTRACTS, roles: ROLES, command: () => problem(code, status) }));
      await user.type(within(dialog).getByLabelText(vi_['adm.members.invite.email.label']), 'guest@example.test');
      await user.selectOptions(within(dialog).getByLabelText(vi_['adm.guests.invite.contractor.label']), CONTRACTOR_ONE);
      await user.click(within(dialog).getAllByRole('checkbox')[0] as HTMLElement);
      await user.selectOptions(within(dialog).getByLabelText(vi_['adm.guests.invite.role.label']), 'role-GUEST_CONTRACTOR');
      await user.type(within(dialog).getByLabelText(vi_['adm.guests.invite.until.label']), '2027-01-15T10:00');
      await user.click(within(dialog).getByRole('button', { name: vi_['adm.guests.invite.submit.action'] }));
      expect((await within(dialog).findByRole('alert')).textContent).toContain(vi_[key]);
    });

    it('says when no contract is in reach, and lets the user retry a failed read of contracts or roles', async () => {
      mount(<GuestContractorsScreen route={ROUTE} />, harness({ members: ROWS, contracts: [contract(3, { status: 'DRAFT' })], roles: ROLES }));
      await userEvent.setup().click(await screen.findByRole('button', { name: vi_['adm.guests.invite.action'] }));
      expect(await screen.findByText(vi_['adm.guests.invite.contracts.none'])).toBeTruthy();
      cleanup();
      mount(<GuestContractorsScreen route={ROUTE} />, harness({ members: ROWS, contracts: new Error('boom'), roles: new Error('boom') }));
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: vi_['adm.guests.invite.action'] }));
      const failed = await screen.findAllByRole('button', { name: vi_['adm.members.error.retry.action'] });
      expect(failed).toHaveLength(2);
      for (const retry of failed) await user.click(retry);
    });
  });

  it('suspends a guest with the version of the row', async () => {
    const h = harness({ members: ROWS });
    mount(<GuestContractorsScreen route={ROUTE} />, h);
    await screen.findByText('Other Builders');
    const user = userEvent.setup();
    await user.click(within(rowOf('p1@example.test')).getByRole('button', { name: vi_['adm.members.suspend.label'].replace('{name}', 'Person 1') }));
    await user.type(screen.getByLabelText(vi_['adm.members.reason.label']), 'the contract is on hold');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: vi_['adm.members.suspend.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('suspendMembership');
    expect(await screen.findByText(vi_['adm.members.lifecycle.suspend.done'].replace('{name}', 'Person 1'))).toBeTruthy();
  });
});

describe('the permission set of the fixtures', () => {
  it('is what the screens read', () => {
    expect(ADMIN).toEqual(expect.arrayContaining(['membership.read', 'iam.guest.invite']));
  });
});
