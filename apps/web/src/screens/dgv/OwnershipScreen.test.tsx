import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { FIRST_TENANT, SECOND_TENANT, mountInSession } from '../adm/security/test-support';
import OwnershipScreen from './OwnershipScreen';
import { MANAGER, MANAGER_WITHOUT_MEMBERS, MEMBER_ONE, MEMBER_THREE, MEMBER_TWO, READER, client, dataset, mount, routeOf, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('DGV-03', 'FR-DGV-03');
const problem = (code: string, status = 422, detail?: string) => new ApiError({ status, code, correlationId: 'c', retryAfterSeconds: undefined, detail, extensions: {} });

afterEach(cleanup);

const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('tr[data-dataset-id]'));
const codes = (): string[] => rows().map((row) => row.getAttribute('data-dataset-code') ?? '');
const ready = () => waitFor(() => expect(rows().length).toBeGreaterThan(0));
const rowOf = (code: string): HTMLElement => document.querySelector(`tr[data-dataset-code="${code}"]`) as HTMLElement;
const pick = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
const type = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};

const DATASETS = [
  dataset(1, { dataset_code: 'DS-TREASURY', title: 'Treasury', domain: 'TREASURY', is_critical: true, status: 'ACTIVE', version: 4 }),
  dataset(2, { dataset_code: 'DS-LAND', title: 'Land', domain: 'LAND', classification: 'PERSONAL' }),
  dataset(3, { dataset_code: 'DS-OLD', title: 'Old', domain: 'TREASURY', status: 'RETIRED' }),
];
const catalogue = (overrides: Partial<World> = {}): World => world({ datasets: DATASETS, ...overrides });

function fillRegistration(): void {
  type(vi_['dgv.owners.register.code.label'], 'DS-NEW');
  type(vi_['dgv.owners.register.name.label'], 'New dataset');
  type(vi_['dgv.owners.register.domain.label'], 'TREASURY');
  type(vi_['dgv.owners.register.grain.label'], 'one row per payment order');
  type(vi_['dgv.owners.register.module.label'], 'PAY');
}

describe('OwnershipScreen (DGV-03): owners and stewards (UI-DGV-03)', () => {
  it('lists each dataset with its domain, owner, steward, freshness, criticality and status', async () => {
    mount(<OwnershipScreen route={ROUTE} />, client(catalogue()), READER, '/dgv/dgv-03');
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['dgv.owners.page.title']);
    expect(codes()).toEqual(['DS-TREASURY', 'DS-LAND', 'DS-OLD']);
    const cells = (code: string) => Array.from(rowOf(code).querySelectorAll('td')).map((cell) => cell.textContent);
    expect(cells('DS-TREASURY').slice(0, 7)).toEqual([
      'TREASURY',
      `TreasuryDS-TREASURY${vi_['dgv.classification.internal.text']}`,
      'Nguyen Van An',
      'Tran Thi Binh',
      '1 ngày',
      vi_['dgv.owners.critical.yes'],
      vi_['dgv.status.dataset.active.text'],
    ]);
    expect(cells('DS-LAND')[5]).toBe(vi_['dgv.owners.critical.no']);
    expect(screen.getByTestId('count').textContent).toBe(vi_['dgv.owners.count.text'].replace('{count}', '3'));
  });

  it('filters by domain and says when a domain has no dataset or the catalogue is empty', async () => {
    mount(<OwnershipScreen route={ROUTE} />, client(catalogue()), READER, '/dgv/dgv-03');
    await ready();
    expect(within(screen.getByLabelText(vi_['dgv.owners.filter.domain.label'])).getAllByRole('option').map((option) => option.textContent)).toEqual([vi_['dgv.owners.filter.all.option'], 'LAND', 'TREASURY']);
    pick(vi_['dgv.owners.filter.domain.label'], 'LAND');
    expect(codes()).toEqual(['DS-LAND']);
    cleanup();
    mount(<OwnershipScreen route={ROUTE} />, client(world()), READER, '/dgv/dgv-03');
    expect((await screen.findByTestId('empty-owners')).textContent).toBe(vi_['dgv.owners.empty.text']);
  });

  it('says that the datasets could not be read, with a retry', async () => {
    const state = catalogue({ failing: new Set(['searchCatalog']) });
    mount(<OwnershipScreen route={ROUTE} />, client(state), READER, '/dgv/dgv-03');
    expect(await screen.findByRole('alert')).toBeTruthy();
    state.failing = new Set();
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    await ready();
    expect(codes().length).toBe(3);
  });

  it('shows no register form and no change button to a person who only reads', async () => {
    mount(<OwnershipScreen route={ROUTE} />, client(catalogue()), READER, '/dgv/dgv-03');
    await ready();
    expect(screen.queryByRole('form', { name: vi_['dgv.owners.register.title'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['dgv.owners.change.action'] })).toBeNull();
  });

  it('shows no register form and no change button while the tenant is read-only', async () => {
    mountInSession(<OwnershipScreen route={ROUTE} />, client(catalogue()), { permissions: MANAGER, mode: 'READ_ONLY' });
    await ready();
    expect(screen.queryByRole('form', { name: vi_['dgv.owners.register.title'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['dgv.owners.change.action'] })).toBeNull();
  });

  it('starts over when the person switches tenant', async () => {
    const view = mountInSession(<OwnershipScreen route={ROUTE} />, client(catalogue()), { permissions: MANAGER });
    await ready();
    pick(vi_['dgv.owners.filter.domain.label'], 'LAND');
    expect(codes()).toEqual(['DS-LAND']);
    expect(FIRST_TENANT.id).not.toBe(SECOND_TENANT.id);
    view.rerenderWith({ permissions: MANAGER, tenant: SECOND_TENANT });
    await waitFor(() => expect(codes().length).toBe(3));
  });
});

describe('OwnershipScreen: registering a dataset', () => {
  it('offers the active staff as owner and steward, not guests or members who are not active', async () => {
    mount(<OwnershipScreen route={ROUTE} />, client(catalogue()), MANAGER, '/dgv/dgv-03');
    await ready();
    const options = await waitFor(() => {
      const found = within(screen.getByLabelText(vi_['dgv.owners.register.owner.label'])).getAllByRole('option').map((option) => option.textContent);
      expect(found.length).toBeGreaterThan(1);
      return found;
    });
    expect(options).toEqual([vi_['dgv.owners.member.placeholder'], 'Nguyen Van An', 'Tran Thi Binh', 'Le Van Cuong']);
  });

  it('refuses a critical dataset whose owner is its steward before anything is sent (AC-ST-DGV-001-1)', async () => {
    const h = client(catalogue());
    mount(<OwnershipScreen route={ROUTE} />, h, MANAGER, '/dgv/dgv-03');
    await ready();
    await waitFor(() => expect(within(screen.getByLabelText(vi_['dgv.owners.register.owner.label'])).getAllByRole('option').length).toBeGreaterThan(1));
    fillRegistration();
    pick(vi_['dgv.owners.register.owner.label'], MEMBER_ONE);
    pick(vi_['dgv.owners.register.steward.label'], MEMBER_ONE);
    fireEvent.click(screen.getByLabelText(vi_['dgv.owners.register.critical.label']));
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['dgv.owners.register.save.action'] }));
    expect(within(screen.getByRole('form', { name: vi_['dgv.owners.register.title'] })).getByText(vi_['dgv.field.sameAsOwner.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('asks for what is missing', async () => {
    const h = client(catalogue());
    mount(<OwnershipScreen route={ROUTE} />, h, MANAGER, '/dgv/dgv-03');
    await ready();
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['dgv.owners.register.save.action'] }));
    expect(within(screen.getByRole('form', { name: vi_['dgv.owners.register.title'] })).getAllByText(vi_['dgv.field.required.error']).length).toBeGreaterThanOrEqual(6);
    expect(h.command).not.toHaveBeenCalled();
  });

  it('sends the registration, shows that the dataset is registered as a draft and empties the form', async () => {
    const h = client(catalogue(), () => ({ operation_id: 'o', status: 'DRAFT', resource_version: 1, resource_id: 'new' }));
    mount(<OwnershipScreen route={ROUTE} />, h, MANAGER, '/dgv/dgv-03');
    await ready();
    await waitFor(() => expect(within(screen.getByLabelText(vi_['dgv.owners.register.owner.label'])).getAllByRole('option').length).toBeGreaterThan(1));
    fillRegistration();
    pick(vi_['dgv.owners.register.owner.label'], MEMBER_THREE);
    pick(vi_['dgv.owners.register.steward.label'], MEMBER_TWO);
    pick(vi_['dgv.owners.register.classification.label'], 'CONFIDENTIAL');
    type(vi_['dgv.owners.register.freshness.label'], '48');
    fireEvent.click(screen.getByLabelText(vi_['dgv.owners.register.critical.label']));
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['dgv.owners.register.save.action'] }));
    await waitFor(() =>
      expect(h.command).toHaveBeenCalledWith(
        'registerDataset',
        expect.objectContaining({
          body: {
            dataset_code: 'DS-NEW',
            title: 'New dataset',
            domain: 'TREASURY',
            grain: 'one row per payment order',
            producer_module: 'PAY',
            owner_user_id: MEMBER_THREE,
            steward_user_id: MEMBER_TWO,
            classification: 'CONFIDENTIAL',
            is_critical: true,
            freshness_slo_seconds: 172_800,
          },
        }),
      ),
    );
    expect((await screen.findByTestId('dataset-saved')).textContent).toBe(vi_['dgv.owners.register.saved.notice']);
    expect((screen.getByLabelText(vi_['dgv.owners.register.code.label']) as HTMLInputElement).value).toBe('');
  });

  it.each([
    ['OWNER_STEWARD_SAME', 422, 'dgv.problem.ownerStewardSame.error'],
    ['DATASET_CODE_DUPLICATE', 409, 'dgv.problem.duplicateCode.error'],
  ])('shows the refusal %s of the server (AC-ST-DGV-001-1)', async (code, status, key) => {
    const h = client(catalogue(), () => problem(code, status));
    mount(<OwnershipScreen route={ROUTE} />, h, MANAGER, '/dgv/dgv-03');
    await ready();
    await waitFor(() => expect(within(screen.getByLabelText(vi_['dgv.owners.register.owner.label'])).getAllByRole('option').length).toBeGreaterThan(1));
    fillRegistration();
    pick(vi_['dgv.owners.register.owner.label'], MEMBER_ONE);
    pick(vi_['dgv.owners.register.steward.label'], MEMBER_TWO);
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['dgv.owners.register.save.action'] }));
    const form = screen.getByRole('form', { name: vi_['dgv.owners.register.title'] });
    expect((await within(form).findByRole('alert')).textContent).toBe((vi_ as Record<string, string>)[key]);
    // The form keeps what the person typed so that it can be corrected.
    expect((screen.getByLabelText(vi_['dgv.owners.register.code.label']) as HTMLInputElement).value).toBe('DS-NEW');
  });

  it('cannot register without the permission to list members, and says why', async () => {
    mount(<OwnershipScreen route={ROUTE} />, client(catalogue()), MANAGER_WITHOUT_MEMBERS, '/dgv/dgv-03');
    await ready();
    expect(screen.getByTestId('members-unavailable').textContent).toBe(vi_['dgv.owners.members.unavailable']);
    expect((screen.getByRole('button', { name: vi_['dgv.owners.register.save.action'] }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says so when the list of members could not be read', async () => {
    mount(<OwnershipScreen route={ROUTE} />, client(catalogue({ failing: new Set(['get_resources_membership']) })), MANAGER, '/dgv/dgv-03');
    expect(await screen.findByTestId('members-unavailable')).toBeTruthy();
  });
});

describe('OwnershipScreen: changing the owner and the steward', () => {
  const open = async (code: string) => {
    await userEvent.setup().click(within(rowOf(code)).getByRole('button', { name: vi_['dgv.owners.change.action'] }));
    return screen.getByRole('form', { name: vi_['dgv.owners.change.title'].replace('{code}', code) });
  };
  const ownerOf = (form: HTMLElement): HTMLElement => within(form).getByLabelText(vi_['dgv.owners.change.owner.label']);
  const stewardOf = (form: HTMLElement): HTMLElement => within(form).getByLabelText(vi_['dgv.owners.change.steward.label']);
  const reasonOf = (form: HTMLElement): HTMLElement => within(form).getByLabelText(vi_['dgv.owners.change.reason.label']);

  async function readyWithMembers(h = client(catalogue())) {
    mount(<OwnershipScreen route={ROUTE} />, h, MANAGER, '/dgv/dgv-03');
    await ready();
    return h;
  }

  it('has no button for a retired dataset', async () => {
    await readyWithMembers();
    expect(within(rowOf('DS-OLD')).queryByRole('button')).toBeNull();
    expect(within(rowOf('DS-TREASURY')).getByRole('button', { name: vi_['dgv.owners.change.action'] })).toBeTruthy();
  });

  it('starts from the current pair, asks for a reason, and refuses one person in both seats of a critical dataset', async () => {
    const h = await readyWithMembers();
    const form = await open('DS-TREASURY');
    await waitFor(() => expect((ownerOf(form) as HTMLSelectElement).value).toBe(MEMBER_ONE));
    expect((stewardOf(form) as HTMLSelectElement).value).toBe(MEMBER_TWO);
    await userEvent.setup().click(within(form).getByRole('button', { name: vi_['dgv.owners.change.confirm.action'] }));
    expect(within(form).getByText(vi_['dgv.field.required.error'])).toBeTruthy();
    fireEvent.change(reasonOf(form), { target: { value: 'too short' } });
    fireEvent.change(stewardOf(form), { target: { value: MEMBER_ONE } });
    await userEvent.setup().click(within(form).getByRole('button', { name: vi_['dgv.owners.change.confirm.action'] }));
    expect(within(form).getByText(vi_['dgv.field.tooShort.error'])).toBeTruthy();
    expect(within(form).getByText(vi_['dgv.field.sameAsOwner.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('sends the new pair with the reason and the version that was read, then closes the form', async () => {
    const h = client(catalogue(), () => ({ operation_id: 'o', status: 'ACTIVE', resource_version: 5, resource_id: DATASETS[0]?.id }));
    await readyWithMembers(h);
    const form = await open('DS-TREASURY');
    await waitFor(() => expect((ownerOf(form) as HTMLSelectElement).value).toBe(MEMBER_ONE));
    fireEvent.change(ownerOf(form), { target: { value: MEMBER_THREE } });
    fireEvent.change(reasonOf(form), { target: { value: 'The owner moved to another directorate' } });
    await userEvent.setup().click(within(form).getByRole('button', { name: vi_['dgv.owners.change.confirm.action'] }));
    await waitFor(() =>
      expect(h.command).toHaveBeenCalledWith(
        'assignDatasetOwnership',
        expect.objectContaining({
          path: { id: DATASETS[0]?.id },
          body: { owner_user_id: MEMBER_THREE, steward_user_id: MEMBER_TWO, reason: 'The owner moved to another directorate' },
          ifMatchVersion: 4,
        }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole('form', { name: vi_['dgv.owners.change.title'].replace('{code}', 'DS-TREASURY') })).toBeNull());
  });

  it('shows the refusal of the server and lets the person cancel', async () => {
    const h = client(catalogue(), () => problem('VERSION_CONFLICT', 409));
    await readyWithMembers(h);
    const form = await open('DS-LAND');
    fireEvent.change(ownerOf(form), { target: { value: MEMBER_THREE } });
    fireEvent.change(reasonOf(form), { target: { value: 'The owner moved to another directorate' } });
    await userEvent.setup().click(within(form).getByRole('button', { name: vi_['dgv.owners.change.confirm.action'] }));
    expect((await within(form).findByRole('alert')).textContent).toBe(vi_['dgv.problem.versionConflict.error']);
    await userEvent.setup().click(within(form).getByRole('button', { name: vi_['dgv.owners.change.cancel.action'] }));
    expect(screen.queryByRole('form', { name: vi_['dgv.owners.change.title'].replace('{code}', 'DS-LAND') })).toBeNull();
  });

  it('closes the form when the same button is pressed again', async () => {
    await readyWithMembers();
    await open('DS-LAND');
    await userEvent.setup().click(within(rowOf('DS-LAND')).getByRole('button', { name: vi_['dgv.owners.change.action'] }));
    expect(screen.queryByRole('form', { name: vi_['dgv.owners.change.title'].replace('{code}', 'DS-LAND') })).toBeNull();
  });
});
