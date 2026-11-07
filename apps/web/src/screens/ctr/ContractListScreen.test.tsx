import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { message } from './test-catalogue';
import ContractListScreen from './ContractListScreen';
import { CONTRACT_A, CONTRACT_B, analyticsClient, context, portfolioBody, row, snapshot } from './analytics/test-support';
import { MAKER, READER, line, mount, routeOf } from './test-support';

const ROUTE = routeOf('CTR-01', 'FR-CTR-01');
const refusal = () => new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c', extensions: {} });

afterEach(cleanup);

const rows = (): HTMLElement[] => Array.from(screen.getByTestId('contracts').querySelectorAll<HTMLElement>('tbody tr'));
const queries = (h: ReturnType<typeof analyticsClient>): Array<Record<string, string>> =>
  h.read.mock.calls.filter(([operation]) => operation === 'getContractPortfolio').map(([, input]) => (input as { query: Record<string, string> }).query);

describe('ContractListScreen (CTR-01): the register of contracts, read from the portfolio of the server', () => {
  it('lists the contracts with the project, the contractor, the value and the status, and links each code to its draft (UI-CTR-01)', async () => {
    mount(<ContractListScreen route={ROUTE} />, analyticsClient({}), { permissions: MAKER });
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['ctr.list.page.title']);
    const first = within(rows()[0] as HTMLElement);
    expect(first.getByRole('link', { name: 'HD-A-001' }).getAttribute('href')).toBe(`/ctr/ctr-02?id=${CONTRACT_A}`);
    expect(first.getByText('Hợp đồng HD-A-001')).toBeTruthy();
    expect(first.getByText('DA-2026-001')).toBeTruthy();
    expect(first.getByText('10.200.000.000')).toBeTruthy();
    expect(first.getByText(vi_['ctr.status.active.label'])).toBeTruthy();
    // A figure the row has no value for says why, it is not a blank or a zero.
    const second = within(rows()[1] as HTMLElement);
    expect(second.getByTestId('not-applicable').textContent).toBe(message('ca1.na.noRows'));
    expect(screen.getByText('Màn hình CTR-01 · FR-CTR-01')).toBeTruthy();
  });

  it('shows the total of the server, which is not the sum of the rows of the page, and says it is of all that match', async () => {
    mount(<ContractListScreen route={ROUTE} />, analyticsClient({ portfolio: () => portfolioBody({ totals: { ...portfolioBody().totals, rows: 40 } }) }), { permissions: MAKER });
    await waitFor(() => expect(rows()).toHaveLength(2));
    const totals = within(document.querySelector('tfoot') as HTMLElement);
    // 77.777.777.777 is the server's figure; the two rows of the page add up to 35.200.000.000 and nothing here adds them.
    expect(totals.getByText('77.777.777.777')).toBeTruthy();
    expect(totals.queryByText('35.200.000.000')).toBeNull();
    expect(totals.getByText(message('ca1.table.totals'))).toBeTruthy();
    expect(screen.getByTestId('totals-note').textContent).toBe(message('ca1.register.totals.note', { total: 40 }));
    expect(screen.getByRole('group', { name: vi_['ui.contextBar.label'] }).textContent).toContain(message('ui.unitChip.label', { unit: message('w2pay.ctx.unit') }));
  });

  it('sends the filters, the sort and the page size to the server and reads again when they change', async () => {
    const h = analyticsClient({});
    mount(<ContractListScreen route={ROUTE} />, h, { permissions: MAKER });
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(queries(h)[0]).toEqual({ sort: 'code', dir: 'asc', limit: '20' });
    fireEvent.change(screen.getByLabelText(vi_['ctr.list.status.label']), { target: { value: 'ACTIVE' } });
    await waitFor(() => expect(queries(h).some((query) => query.status === 'ACTIVE')).toBe(true));
    fireEvent.change(screen.getByLabelText(vi_['ctr.list.query.label']), { target: { value: 'cầu' } });
    await waitFor(() => expect(queries(h).some((query) => query.status === 'ACTIVE' && query.q === 'cầu')).toBe(true));
    fireEvent.change(screen.getByLabelText(message('ca1.filter.sort')), { target: { value: 'contract_value_vnd' } });
    fireEvent.change(screen.getByLabelText(message('ca1.filter.direction')), { target: { value: 'desc' } });
    await waitFor(() => expect(queries(h).some((query) => query.sort === 'contract_value_vnd' && query.dir === 'desc')).toBe(true));
    // the rows are never filtered in the browser: whatever the server sent is what is shown
    expect(rows()).toHaveLength(2);
  });

  it('pages by the cursor of the server: the next page is read with the cursor the first one gave', async () => {
    const h = analyticsClient({
      portfolio: (query) =>
        query?.cursor === 'page-two'
          ? portfolioBody({ items: [row(CONTRACT_B, 'HD-A-002')], next_cursor: null, totals: { ...portfolioBody().totals, rows: 40 } })
          : portfolioBody({ next_cursor: 'page-two', totals: { ...portfolioBody().totals, rows: 40 } }),
    });
    mount(<ContractListScreen route={ROUTE} />, h, { permissions: MAKER });
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: message('ui.tablePager.next') }));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(queries(h).some((query) => query.cursor === 'page-two')).toBe(true);
    expect(within(rows()[0] as HTMLElement).getByRole('link').textContent).toBe('HD-A-002');
    fireEvent.click(screen.getByRole('button', { name: message('ui.tablePager.prev') }));
    await waitFor(() => expect(rows()).toHaveLength(2));
  });

  it('says whether the filter or the whole register is empty, and clears the filter', async () => {
    mount(<ContractListScreen route={ROUTE} />, analyticsClient({ portfolio: (query) => (query?.q === undefined ? portfolioBody() : portfolioBody({ items: [], totals: { ...portfolioBody().totals, rows: 0, cells: {} } })) }), { permissions: MAKER });
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.change(screen.getByLabelText(vi_['ctr.list.query.label']), { target: { value: 'không có' } });
    await waitFor(() => expect(screen.getByTestId('no-match').textContent).toBe(vi_['ctr.list.noMatch.notice']));
    fireEvent.click(screen.getByRole('button', { name: vi_['ui.dataTable.clearFilters'] }));
    await waitFor(() => expect(rows()).toHaveLength(2));
    cleanup();
    mount(<ContractListScreen route={ROUTE} />, analyticsClient({ portfolio: () => portfolioBody({ items: [], totals: { ...portfolioBody().totals, rows: 0, cells: {} } }) }), { permissions: MAKER });
    await waitFor(() => expect(screen.getByTestId('no-contracts').textContent).toBe(message('ca1.empty.none')));
  });

  it('offers the drafting of a contract only to those who may create one, and not in a read-only session', async () => {
    const withCreate = mount(<ContractListScreen route={ROUTE} />, analyticsClient({}), { permissions: MAKER });
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.getByRole('link', { name: vi_['ctr.list.create.action'] }).getAttribute('href')).toBe('/ctr/ctr-02');
    withCreate.unmount();
    const reader = mount(<ContractListScreen route={ROUTE} />, analyticsClient({}), { permissions: READER });
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.queryByRole('link', { name: vi_['ctr.list.create.action'] })).toBeNull();
    reader.unmount();
    mount(<ContractListScreen route={ROUTE} />, analyticsClient({}), { permissions: MAKER, mode: 'READ_ONLY' });
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.queryByRole('link', { name: vi_['ctr.list.create.action'] })).toBeNull();
  });

  it('shows a loading skeleton, never a zero, while the portfolio is read', async () => {
    mount(<ContractListScreen route={ROUTE} />, analyticsClient({ portfolio: () => new Promise(() => undefined) }), { permissions: MAKER });
    expect(screen.getByRole('status', { name: vi_['states.loading.label'] }).getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByTestId('contracts')).toBeNull();
  });

  it('shows the denied and the error states, with a retry for the failure', async () => {
    const denied = mount(<ContractListScreen route={ROUTE} />, analyticsClient({ portfolio: () => refusal(), contracts: refusal() }), { permissions: MAKER });
    await waitFor(() => expect(screen.getByText(vi_['states.denied.title'])).toBeTruthy());
    denied.unmount();
    let calls = 0;
    const failing = analyticsClient({
      portfolio: () => {
        calls += 1;
        return calls === 1 ? new Error('boom') : portfolioBody();
      },
    });
    mount(<ContractListScreen route={ROUTE} />, failing, { permissions: MAKER });
    await waitFor(() => expect(screen.getByText(vi_['states.error.title'])).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    await waitFor(() => expect(rows()).toHaveLength(2));
  });

  it('treats a body that is not the portfolio as a failed read, not as an empty register', async () => {
    mount(<ContractListScreen route={ROUTE} />, analyticsClient({ portfolio: () => ({ items: [] }) }), { permissions: MAKER });
    await waitFor(() => expect(screen.getByText(vi_['states.error.title'])).toBeTruthy());
    expect(screen.queryByTestId('no-contracts')).toBeNull();
  });

  it('shows a guest contractor the register of their own contracts when the portfolio refuses them, with no totals row', async () => {
    mount(<ContractListScreen route={ROUTE} />, analyticsClient({ portfolio: () => refusal(), contracts: [line(3)] }), { permissions: READER });
    await waitFor(() => expect(screen.getByTestId('own-register-note').textContent).toBe(message('ca1.register.own')));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(document.querySelector('tfoot')).toBeNull();
  });

  it('tells the reader that the ledger columns cover only some of the contracts, and shows a lock, never zero, for what they may not see', async () => {
    const hidden = row(CONTRACT_A, 'HD-A-001', { accepted_vnd: null, paid_vnd: null, paid_to_accepted_pct: null }, { accepted_vnd: 'LEDGER_DENIED', paid_vnd: 'LEDGER_DENIED', paid_to_accepted_pct: 'LEDGER_DENIED' });
    mount(
      <ContractListScreen route={ROUTE} />,
      analyticsClient({ portfolio: () => portfolioBody({ context: context({ rows: 2, ledger_rows: 1 }), items: [hidden, row(CONTRACT_B, 'HD-A-002')] }) }),
      { permissions: MAKER },
    );
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.getByTestId('partial-notice').textContent).toBe(message('ca1.partial.notice', { ledger: 1, rows: 2 }));
    expect(within(rows()[0] as HTMLElement).getAllByTestId('ledger-denied')).toHaveLength(3);
    expect(within(rows()[0] as HTMLElement).queryByText('0')).toBeNull();
  });

  it('flags a snapshot of a period that has a newer revision as stale, and reads the newest on request', async () => {
    const stale = context({ freshness: { kind: 'SNAPSHOT', stale: true, snapshot: snapshot({ revision: 1, latest_revision: 2, stale: true }), latest_snapshot: snapshot({ revision: 2, latest_revision: 2 }) } });
    const h = analyticsClient({ portfolio: () => portfolioBody({ context: stale }) });
    mount(<ContractListScreen route={ROUTE} />, h, { permissions: MAKER });
    await waitFor(() => expect(screen.getByTestId('stale-notice').textContent).toContain(message('ca1.stale.notice', { period: '2026-09', revision: 1, latest: 2 })));
    fireEvent.click(screen.getByRole('button', { name: message('ca1.stale.useLatest') }));
    await waitFor(() => expect(queries(h).some((query) => query.period === '2026-09')).toBe(true));
  });
});
