import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { message } from './test-catalogue';
import ContractListScreen from './ContractListScreen';
import { MAKER, READER, client, contractId, line, mount, routeOf, world } from './test-support';

const ROUTE = routeOf('CTR-01', 'FR-CTR-01');

afterEach(cleanup);

const rows = (): HTMLElement[] => Array.from(screen.getByTestId('contracts').querySelectorAll<HTMLElement>('tbody tr'));

describe('ContractListScreen (CTR-01): the register of contracts in the scope of the member', () => {
  it('lists the contracts with the project, the contractor, the value and the status, and links each code to its draft (UI-CTR-01)', async () => {
    mount(<ContractListScreen route={ROUTE} />, client(world()), { permissions: MAKER });
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['ctr.list.page.title']);
    const first = within(rows()[0] as HTMLElement);
    expect(first.getByRole('link', { name: 'HD-A-001' }).getAttribute('href')).toBe(`/ctr/ctr-02?id=${contractId(1)}`);
    expect(first.getByText('Hợp đồng số 1')).toBeTruthy();
    expect(first.getByText('DA-2026-001')).toBeTruthy();
    expect(first.getByText('10.200.000.000 VND')).toBeTruthy();
    expect(first.getByTestId('status').textContent).toBe(vi_['ctr.status.draft.label']);
    const second = within(rows()[1] as HTMLElement);
    expect(second.getByText(vi_['ctr.list.venture.badge'])).toBeTruthy();
    expect(second.getByTestId('status').textContent).toBe(vi_['ctr.status.active.label']);
    // A contract without a title or a due date shows the placeholder, not a blank.
    expect(second.getAllByText(vi_['ctr.list.none.text']).length).toBe(2);
    expect(screen.getByText('Màn hình CTR-01 · FR-CTR-01')).toBeTruthy();
  });

  it('filters by words and by status and says when nothing matches', async () => {
    mount(<ContractListScreen route={ROUTE} />, client(world()), { permissions: MAKER });
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.change(screen.getByLabelText(vi_['ctr.list.status.label']), { target: { value: 'ACTIVE' } });
    expect(rows()).toHaveLength(1);
    expect(within(rows()[0] as HTMLElement).getByRole('link').textContent).toBe('HD-A-002');
    fireEvent.change(screen.getByLabelText(vi_['ctr.list.query.label']), { target: { value: 'không có' } });
    expect(screen.getByTestId('no-match').textContent).toBe(vi_['ctr.list.noMatch.notice']);
  });

  it('offers the drafting of a contract only to those who may create one, and not in a read-only session', async () => {
    const withCreate = mount(<ContractListScreen route={ROUTE} />, client(world()), { permissions: MAKER });
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.getByRole('link', { name: vi_['ctr.list.create.action'] }).getAttribute('href')).toBe('/ctr/ctr-02');
    withCreate.unmount();
    const reader = mount(<ContractListScreen route={ROUTE} />, client(world()), { permissions: READER });
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.queryByRole('link', { name: vi_['ctr.list.create.action'] })).toBeNull();
    reader.unmount();
    mount(<ContractListScreen route={ROUTE} />, client(world()), { permissions: MAKER, mode: 'READ_ONLY' });
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.queryByRole('link', { name: vi_['ctr.list.create.action'] })).toBeNull();
  });

  it('shows a contract that the server shows without a ceiling (a guest contractor) and ignores a line it cannot read', async () => {
    const guest = { ...line(3) } as Record<string, unknown>;
    delete guest.estimate_ceiling_vnd;
    mount(<ContractListScreen route={ROUTE} />, client(world({ contracts: [guest, { nonsense: true }] })), { permissions: READER });
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.queryByText(vi_['ctr.draft.fact.ceiling'])).toBeNull();
  });

  it('shows the empty, the denied and the error states of the register', async () => {
    const empty = mount(<ContractListScreen route={ROUTE} />, client(world({ contracts: [] })), { permissions: MAKER });
    await waitFor(() => expect(screen.getByText(vi_['states.empty.title'])).toBeTruthy());
    empty.unmount();
    const refused = client(world());
    (refused.client as unknown as { readAll: () => Promise<never> }).readAll = () => Promise.reject(new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c', extensions: {} }));
    const denied = mount(<ContractListScreen route={ROUTE} />, refused, { permissions: MAKER });
    await waitFor(() => expect(screen.getByText(vi_['states.denied.title'])).toBeTruthy());
    denied.unmount();
    mount(<ContractListScreen route={ROUTE} />, client(world({ failing: new Set(['get_resources_contract']) })), { permissions: MAKER });
    await waitFor(() => expect(screen.getByText(vi_['states.error.title'])).toBeTruthy());
  });
  it('adds up the value of the contracts that stand, says how many, and clears the filter when nothing matches', async () => {
    mount(<ContractListScreen route={ROUTE} />, client(world()), { permissions: MAKER });
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.getByTestId('totals-note').textContent).toBe(message('w2pay.ctr.list.totals.note', { standing: 2, total: 2 }));
    expect(within(document.querySelector('tfoot') as HTMLElement).getByText(/VND$/)).toBeTruthy();
    expect(screen.getByRole('group', { name: vi_['ui.contextBar.label'] }).textContent).toContain(message('ui.unitChip.label', { unit: message('w2pay.ctx.unit') }));
    fireEvent.change(screen.getByLabelText(vi_['ctr.list.query.label']), { target: { value: 'không có' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['ui.dataTable.clearFilters'] }));
    await waitFor(() => expect(rows()).toHaveLength(2));
  });
});
