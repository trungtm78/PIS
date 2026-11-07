import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import ContractorListScreen from './ContractorListScreen';
import { DOCUMENT, MANAGER, READER, client, line, mount, restriction, routeOf, verifiedLine, world } from './test-support';

const ROUTE = routeOf('BID-01', 'FR-BID-01');
const problem = (code: string, status = 409, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });
const OK = { operation_id: 'o', status: 'UNVERIFIED', resource_version: 1, resource_id: line(9).id };

afterEach(cleanup);

const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('[data-contractor-id]')).map((cell) => cell.closest('tr') as HTMLElement);
const names = (): string[] => rows().map((row) => row.querySelectorAll('td')[1]?.textContent ?? '');
const ready = () => waitFor(() => expect(rows().length).toBeGreaterThan(0));
const set = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
const fillRegistration = (taxIdentifier = '0101234567'): void => {
  set(vi_['bid.register.taxId.label'], taxIdentifier);
  set(vi_['bid.register.name.label'], 'Công ty nhà thầu mới');
  set(vi_['bid.register.form.label'], 'TNHH');
  set(vi_['bid.register.profile.label'], DOCUMENT);
};
const submit = (): void => {
  fireEvent.click(screen.getByRole('button', { name: vi_['bid.register.submit.action'] }));
};

describe('ContractorListScreen (BID-01): the registry of contractors', () => {
  it('lists each contractor with the tax id as it was sent, the contracts, how it was verified and the restriction in force, in words (UI-BID-01)', async () => {
    mount(<ContractorListScreen route={ROUTE} />, client(world()), { permissions: READER });
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['bid.list.page.title']);
    const headers = Array.from(document.querySelectorAll('th[scope="col"]')).map((cell) => cell.textContent);
    expect(headers).toEqual([
      vi_['bid.list.column.taxId'],
      vi_['bid.list.column.name'],
      vi_['bid.list.column.contracts'],
      vi_['bid.list.column.verification'],
      vi_['bid.list.column.restriction'],
    ]);
    expect(names()).toEqual(['Công ty nhà thầu 1', 'Công ty nhà thầu 2']);
    const first = rows()[0] as HTMLElement;
    expect(first.querySelector('code')?.textContent).toBe('010****561');
    expect(first.querySelector('a')?.getAttribute('href')).toBe(`/bid/bid-02?id=${line(1).id}`);
    expect(first.querySelector('[data-testid="verification"]')?.textContent).toBe(vi_['bid.status.unverified.label']);
    expect(first.querySelector('[data-testid="restriction-none"]')?.textContent).toBe(vi_['bid.restriction.none.text']);
    const second = rows()[1] as HTMLElement;
    expect(second.querySelector('[data-testid="verification"]')?.textContent).toBe(`${vi_['bid.status.verified.label']}${vi_['bid.basis.document.label']}`);
    expect(second.querySelectorAll('td')[2]?.textContent).toBe('2');
    expect(second.querySelector('[data-testid="restriction-in-force"]')?.textContent).toBe(
      vi_['bid.restriction.until.badge'].replace('{kind}', vi_['bid.kind.debarment.label']).replace('{until}', '2027-12-31'),
    );
  });

  it('says a verification rests on a lookup only when the answer says so, and shows a restriction with no end date and a rejection in words', async () => {
    const state = world({
      contractors: [
        verifiedLine(1, { verification_basis: 'EVIDENCE_DOCUMENT_AND_LOOKUP' }),
        line(2, { verification_status: 'REJECTED' }),
        line(3, { restriction_in_force: restriction(1, { kind: 'WARNING', effective_until: null }) }),
      ],
    });
    mount(<ContractorListScreen route={ROUTE} />, client(state), { permissions: READER });
    await ready();
    expect(rows()[0]?.querySelector('[data-testid="basis"]')?.textContent).toBe(vi_['bid.basis.lookup.label']);
    expect(rows()[1]?.querySelector('[data-testid="verification"]')?.textContent).toBe(vi_['bid.status.rejected.label']);
    expect(rows()[2]?.querySelector('[data-testid="restriction-in-force"]')?.textContent).toBe(
      vi_['bid.restriction.open.badge'].replace('{kind}', vi_['bid.kind.warning.label']).replace('{from}', '2026-01-01'),
    );
  });

  it('filters by name or tax id, by status and by a restriction in force, and says when nothing matches', async () => {
    mount(<ContractorListScreen route={ROUTE} />, client(world()), { permissions: READER });
    await ready();
    set(vi_['bid.list.query.label'], 'nhà thầu 2');
    expect(names()).toEqual(['Công ty nhà thầu 2']);
    set(vi_['bid.list.query.label'], '');
    set(vi_['bid.list.status.label'], 'UNVERIFIED');
    expect(names()).toEqual(['Công ty nhà thầu 1']);
    set(vi_['bid.list.status.label'], '');
    fireEvent.click(screen.getByLabelText(vi_['bid.list.restricted.label']));
    expect(names()).toEqual(['Công ty nhà thầu 2']);
    set(vi_['bid.list.status.label'], 'REJECTED');
    expect(screen.getByTestId('no-match').textContent).toBe(vi_['bid.list.noMatch.notice']);
    expect(screen.getByText(vi_['bid.list.count.text'].replace('{count}', '0'))).toBeTruthy();
  });

  it('offers the registration to those who may manage contractors, not to a reader nor to a tenant that is read only', async () => {
    mount(<ContractorListScreen route={ROUTE} />, client(world()), { permissions: MANAGER });
    await ready();
    expect(screen.getByTestId('register-panel')).toBeTruthy();
    cleanup();
    mount(<ContractorListScreen route={ROUTE} />, client(world()), { permissions: READER });
    await ready();
    expect(screen.queryByTestId('register-panel')).toBeNull();
    cleanup();
    mount(<ContractorListScreen route={ROUTE} />, client(world()), { permissions: MANAGER, mode: 'READ_ONLY' });
    await ready();
    expect(screen.queryByTestId('register-panel')).toBeNull();
    cleanup();
    mount(<ContractorListScreen route={ROUTE} />, client(world()), { permissions: undefined });
    await ready();
    expect(screen.getByTestId('register-panel')).toBeTruthy();
  });

  it('registers a contractor with the fields of the contract only, then opens the way to its profile', async () => {
    const h = client(world(), () => OK);
    mount(<ContractorListScreen route={ROUTE} />, h, { permissions: MANAGER });
    await ready();
    fillRegistration('0101 234 567');
    submit();
    const done = await screen.findByTestId('register-done');
    expect(done.querySelector('a')?.getAttribute('href')).toBe(`/bid/bid-02?id=${line(9).id}`);
    expect(h.command).toHaveBeenCalledTimes(1);
    const [operation, input] = h.command.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(operation).toBe('registerContractor');
    expect(input.body).toEqual({ tax_identifier: '0101234567', legal_name: 'Công ty nhà thầu mới', legal_form: 'TNHH', profile_document_id: DOCUMENT });
    // The form is empty again for the next registration.
    expect((screen.getByLabelText(vi_['bid.register.taxId.label']) as HTMLInputElement).value).toBe('');
  });

  it('asks again for what is missing or wrong and sends nothing', async () => {
    const h = client(world());
    mount(<ContractorListScreen route={ROUTE} />, h, { permissions: MANAGER });
    await ready();
    submit();
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toEqual([vi_['bid.field.required.error'], vi_['bid.field.required.error'], vi_['bid.field.required.error']]);
    fillRegistration('12345');
    set(vi_['bid.register.profile.label'], 'not-an-id');
    submit();
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toEqual([vi_['bid.field.invalidTaxId.error'], vi_['bid.field.invalidId.error']]);
    expect(h.command).not.toHaveBeenCalled();
    // Typing in a field clears its message.
    set(vi_['bid.register.taxId.label'], '0101234567');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it.each([
    [problem('TAX_ID_INVALID'), vi_['bid.problem.taxIdInvalid.error']],
    [problem('VALIDATION_FAILED', 422), vi_['bid.problem.validation.error']],
    [problem('SCOPE_DENIED', 403), vi_['bid.problem.denied.error']],
    [new Error('boom'), vi_['bid.problem.general.error']],
  ])('tells the person why the registration was refused (%#)', async (failure, message) => {
    const h = client(world(), () => failure);
    mount(<ContractorListScreen route={ROUTE} />, h, { permissions: MANAGER });
    await ready();
    fillRegistration();
    submit();
    expect((await screen.findByTestId('register-refusal')).textContent).toBe(message);
  });

  it('names the verified contractor that already holds the tax id, with a way to open it', async () => {
    const holder = line(5).id;
    const h = client(world(), () => problem('CONTRACTOR_ALREADY_VERIFIED', 422, { existing_contractor_id: holder }));
    mount(<ContractorListScreen route={ROUTE} />, h, { permissions: MANAGER });
    await ready();
    fillRegistration();
    submit();
    const refusal = await screen.findByTestId('register-refusal');
    expect(refusal.textContent).toContain(vi_['bid.problem.alreadyVerified.error']);
    expect(refusal.querySelector('a')?.getAttribute('href')).toBe(`/bid/bid-02?id=${holder}`);
  });

  it('shows the empty state when the caller sees no contractor', async () => {
    mount(<ContractorListScreen route={ROUTE} />, client(world({ contractors: [] })), { permissions: READER });
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
  });

  it('says that the registry could not be read, with a retry, and that the scope refused it', async () => {
    const state = world({ failing: new Set(['get_resources_contractor']) });
    mount(<ContractorListScreen route={ROUTE} />, client(state), { permissions: READER });
    expect(await screen.findByRole('alert')).toBeTruthy();
    state.failing = new Set();
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    await ready();
    expect(rows().length).toBe(2);
    cleanup();
    const h = client(world());
    (h.client as unknown as { readAll: () => Promise<unknown[]> }).readAll = () => Promise.reject(new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c', extensions: {} }));
    mount(<ContractorListScreen route={ROUTE} />, h, { permissions: READER });
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
  });
  it('offers to clear the filter when nothing matches, and puts the filters, the table and the pager in the kit', async () => {
    mount(<ContractorListScreen route={ROUTE} />, client(world()), { permissions: READER });
    await ready();
    expect(screen.getByRole('group', { name: vi_['ui.contextBar.label'] })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: vi_['ui.tablePager.nav'] })).toBeTruthy();
    set(vi_['bid.list.status.label'], 'REJECTED');
    fireEvent.click(screen.getByRole('button', { name: vi_['ui.dataTable.clearFilters'] }));
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect((screen.getByLabelText(vi_['bid.list.status.label']) as HTMLSelectElement).value).toBe('');
  });
});
