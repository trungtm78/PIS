import { ApiError } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import DossierWorkspaceScreen from './DossierWorkspaceScreen';
import { MANAGER_ONLY, OFFICER, READ_ONLY, client, dossier, dossierId, dossierLine, mount, permitLine, projectId, projectRow, world } from './dossier-test-support';
import { routeOf } from './test-support';

const ROUTE = routeOf('PMT-01', 'FR-PMT-01');
const denied = () => new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c', retryAfterSeconds: undefined, detail: undefined, extensions: {} });

afterEach(cleanup);

// A dossier is the row of the table of the kit that holds the cell carrying its id.
const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('td [data-dossier-id]')).flatMap((node) => (node.closest('tr') === null ? [] : [node.closest('tr') as HTMLElement]));
const idOf = (row: HTMLElement | undefined): string | null | undefined => row?.querySelector('[data-dossier-id]')?.getAttribute('data-dossier-id');
const ready = () => waitFor(() => expect(rows().length).toBeGreaterThan(0));
const open = (state = world(), permissions: readonly string[] | undefined = OFFICER, path = '/', command?: (operation: string, input: unknown) => unknown) => {
  const h = client(state, command);
  mount(<DossierWorkspaceScreen route={ROUTE} />, h, { permissions, path });
  return h;
};

describe('DossierWorkspaceScreen (PMT-01): the legal dossier of each project', () => {
  it('reads the dossiers in the scope of the caller, shows them with the form that opens a dossier and asks to pick one (UI-PMT-01)', async () => {
    open(world({ dossiers: [dossierLine(1), dossierLine(2, { unconfirmed_count: 1 })], projects: [projectRow(1), projectRow(3)] }));
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['pmt.dossier.page.title']);
    expect(document.querySelector('[data-screen-id="PMT-01"]')).toBeTruthy();
    expect(rows().map((row) => idOf(row))).toEqual([dossierId(1), dossierId(2)]);
    expect(screen.getByTestId('unconfirmed-banner').textContent).toBe(vi_['pmt.dossier.banner.unconfirmed'].replace('{count}', '1'));
    expect(screen.getByTestId('pick-dossier').textContent).toBe(vi_['pmt.dossier.pick.text']);
    // Only the project without a dossier can be opened.
    const form = await screen.findByRole('form', { name: vi_['pmt.dossier.open.aria'] });
    expect(within(form).getAllByRole('option').map((option) => option.textContent)).toEqual([vi_['pmt.dossier.open.project.placeholder'], 'DA-2026-003 · Dự án số 3']);
  });

  it('shows the permits of the dossier named in the address, with the form that adds a permit to the one who manages (AC-ST-PMT-002-1)', async () => {
    open(world({ dossiers: [dossierLine(1)], dossierDetails: [dossier(1, [permitLine(1, { status: 'ISSUED', permit_no: 'GP-0001' })])] }), MANAGER_ONLY, `/?dossier=${dossierId(1)}`);
    expect((await screen.findByTestId('dossier-permits')).getAttribute('data-dossier-id')).toBe(dossierId(1));
    expect(screen.getByText('GP-0001')).toBeTruthy();
    expect(screen.getByRole('form', { name: vi_['pmt.dossier.add.aria'] })).toBeTruthy();
    expect(screen.queryByTestId('pick-dossier')).toBeNull();
  });

  it('shows the permits of a dossier when its row is chosen', async () => {
    open(world({ dossiers: [dossierLine(1), dossierLine(2)], dossierDetails: [dossier(2, [permitLine(7, { permit_type_code: 'SEVEN' })])] }));
    await ready();
    await userEvent.setup().click(within(rows()[1] as HTMLElement).getByRole('button', { name: vi_['pmt.dossier.select.action'] }));
    const permits = await screen.findByTestId('dossier-permits');
    expect(within(permits).getByText('SEVEN')).toBeTruthy();
    expect(rows()[1]?.querySelector('[data-selected]')?.getAttribute('data-selected')).toBe('true');
  });

  it('says so when the dossier named in the address is not there or is out of scope', async () => {
    open(world({ dossiers: [dossierLine(1)] }), OFFICER, `/?dossier=${dossierId(9)}`);
    expect((await screen.findByTestId('no-dossier')).textContent).toBe(vi_['pmt.dossier.missing.notice']);
    expect(screen.queryByTestId('dossier-permits')).toBeNull();
  });

  it('opens the dossier of a project and shows it, with the permits planned for it', async () => {
    const state = world({ projects: [projectRow(1)], dossierDetails: [dossier(1, [permitLine(1)])] });
    const h = open(state, OFFICER, '/', (operation) => {
      if (operation === 'createPermitDossier') {
        state.dossiers.push(dossierLine(1));
        return { operation_id: 'o', status: 'OPEN', resource_version: 1, resource_id: dossierId(1) };
      }
      return {};
    });
    expect((await screen.findByTestId('empty-dossiers')).textContent).toBe(vi_['pmt.dossier.empty.text']);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText(vi_['pmt.dossier.open.project.label']), projectId(1));
    await user.click(screen.getByRole('button', { name: vi_['pmt.dossier.open.action'] }));
    expect((await screen.findByTestId('dossier-permits')).getAttribute('data-dossier-id')).toBe(dossierId(1));
    expect(h.command).toHaveBeenCalledWith('createPermitDossier', expect.objectContaining({ path: { id: projectId(1) } }));
    expect(rows()).toHaveLength(1);
  });

  it('shows the dossiers and nothing to change to someone who may only read, and while the tenant is suspended', async () => {
    open(world({ dossiers: [dossierLine(1)], projects: [projectRow(3)] }), READ_ONLY, `/?dossier=${dossierId(1)}`);
    await ready();
    expect(screen.getByText(vi_['pmt.dossier.readonly.text'])).toBeTruthy();
    expect(screen.queryByRole('form')).toBeNull();
    cleanup();
    const h = client(world({ dossiers: [dossierLine(1)], dossierDetails: [dossier(1)], projects: [projectRow(3)] }));
    mount(<DossierWorkspaceScreen route={ROUTE} />, h, { permissions: OFFICER, mode: 'READ_ONLY', path: `/?dossier=${dossierId(1)}` });
    await screen.findByTestId('dossier-permits');
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('says so when the read is refused or fails, and reads again on retry', async () => {
    const state = world({ failing: new Set(['get_resources_permit_dossier']) });
    open(state);
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    state.failing.clear();
    state.dossiers.push(dossierLine(1));
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    await ready();
    cleanup();
    const h = client(world());
    (h.client as unknown as { readAll: () => Promise<never> }).readAll = () => Promise.reject(denied());
    mount(<DossierWorkspaceScreen route={ROUTE} />, h, { permissions: OFFICER });
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
  });
});
