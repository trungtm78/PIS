import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import LedgerScreen from './LedgerScreen';
import { READER, acceptanceId, calls, client, contractId, entry, itemId, line, mount, page, routeOf, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('PAY-10', 'FR-PAY-10');
const PATH = `/pay/pay-10?contract=${contractId(1)}`;
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(state: World, path = PATH) {
  const h = client(state);
  mount(<LedgerScreen route={ROUTE} />, h, { permissions: READER, path });
  return h;
}

const rowOf = (id: string): HTMLElement => document.querySelector(`tr[data-line="${id}"]`) as HTMLElement;

describe('LedgerScreen (PAY-10): the cumulative ledger of a contract', () => {
  it('asks for a contract when the address names none', async () => {
    open(world(), '/pay/pay-10');
    expect((await screen.findByTestId('no-contract')).textContent).toBe(vi_['pay.ledger.none.notice']);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['pay.ledger.title']);
    expect(screen.getByText(text('pay.ledger.footer', { id: 'PAY-10', req: 'FR-PAY-10' }))).toBeTruthy();
  });

  it('UI-PAY-10: shows the contract in figures and each balance with what is free to request, and totals the lines', async () => {
    const h = open(world([line(1), line(2)]));
    await screen.findByTestId('ledger');
    expect(screen.getByTestId('contract-code').textContent).toBe('HD-A-001');
    expect(screen.getByTestId('contract-value').textContent).toBe('10.200.000.000');
    expect(screen.getByTestId('contract-accepted').textContent).toBe('800.000.000');
    expect(screen.getByTestId('contract-requested').textContent).toBe('300.000.000');
    expect(screen.getByTestId('contract-paid').textContent).toBe('200.000.000');
    expect(screen.getByTestId('contract-advance').textContent).toBe('30.000.000');
    expect(screen.getByTestId('contract-retention-held').textContent).toBe('20.000.000');
    expect(screen.getByTestId('contract-retention-released').textContent).toBe('0');
    expect(screen.getByTestId('reconciled').textContent).toBe(vi_['pay.ledger.reconciled.yes']);
    const first = rowOf(line(1).id);
    expect(within(first).getByTestId('item').textContent).toBe('B01');
    expect(within(first).getByTestId('acceptance').textContent).toBe('NT-001');
    expect(within(first).getByTestId('accepted').textContent).toBe('400.000.000');
    expect(within(first).getByTestId('requested').textContent).toBe('150.000.000');
    expect(within(first).getByTestId('paid').textContent).toBe('100.000.000');
    expect(within(first).getByTestId('recovered').textContent).toBe('20.000.000');
    expect(within(first).getByTestId('held').textContent).toBe('10.000.000');
    expect(within(first).getByTestId('available').textContent).toBe('250.000.000');
    const total = screen.getByTestId('total');
    expect(within(total).getByTestId('accepted').textContent).toBe('800.000.000');
    expect(within(total).getByText(vi_['pay.ledger.total.all'])).toBeTruthy();
    expect(calls(h)[0]).toEqual({ path: { id: contractId(1) }, query: { limit: 50 } });
  });

  it('opens the entries of a balance, with the reversal marked, and closes them again', async () => {
    const reversal = entry(3, { kind: 'REVOKE_ACCEPTANCE', accepted_delta_vnd: '-400000000', reversal_of_id: entry(1).id, reason: 'Withdrawn.' });
    open(world([line(1, { entries: [entry(1), reversal] })]));
    await screen.findByTestId('ledger');
    const button = document.querySelector(`button[data-entries="${line(1).id}"]`) as HTMLElement;
    expect(button.textContent).toBe(text('pay.ledger.entries.show', { count: 2 }));
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    const list = document.querySelector(`tr[data-entries-of="${line(1).id}"]`) as HTMLElement;
    const entries = within(list).getAllByRole('row').slice(1);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.textContent).toContain(vi_['pay.ledger.entry.kind.recognizeAcceptance']);
    expect(entries[0]?.textContent).not.toContain(vi_['pay.ledger.entry.reverses']);
    expect(entries[1]?.textContent).toContain(vi_['pay.ledger.entry.kind.revokeAcceptance']);
    expect(entries[1]?.textContent).toContain(vi_['pay.ledger.entry.reverses']);
    expect(entries[1]?.textContent).toContain('-400.000.000');
    expect(entries[1]?.textContent).toContain('Withdrawn.');
    expect(button.textContent).toBe(vi_['pay.ledger.entries.hide']);
    fireEvent.click(button);
    expect(document.querySelector(`tr[data-entries-of="${line(1).id}"]`)).toBeNull();
  });

  it('warns when the balances do not add up to what the contract accepted', async () => {
    open(world([line(1)], { overrides: { reconciled: false } }));
    await screen.findByTestId('ledger');
    expect(screen.getByTestId('reconciled').textContent).toBe(vi_['pay.ledger.reconciled.no']);
    expect(screen.getByTestId('reconciled').getAttribute('data-reconciled')).toBe('false');
  });

  it('says so when the contract has no balance yet', async () => {
    open(world([]));
    expect((await screen.findByTestId('no-lines')).textContent).toBe(vi_['pay.ledger.list.empty']);
    expect(screen.queryByTestId('ledger')).toBeNull();
  });

  it('filters by item and acceptance through the server, keeps the choices it has seen, and clears the filter', async () => {
    const lines = [line(1), line(2), line(3, { acceptance_id: acceptanceId(2), acceptance_no: 'NT-002' })];
    const h = open(world(lines));
    await screen.findByTestId('ledger');
    // The choices are those of the lines read so far.
    fireEvent.click(screen.getByTestId('more'));
    await waitFor(() => expect(document.querySelectorAll('tbody > tr[data-line]')).toHaveLength(3));
    const items = screen.getByTestId('filter-item') as HTMLSelectElement;
    fireEvent.change(items, { target: { value: itemId(2) } });
    await waitFor(() => expect(document.querySelectorAll('tbody > tr[data-line]')).toHaveLength(1));
    expect(calls(h).at(-1)?.query).toMatchObject({ boq_item_id: itemId(2) });
    expect(within(screen.getByTestId('total')).getByText(vi_['pay.ledger.total.filtered'])).toBeTruthy();
    // The options that were seen before the filter stay on offer, so another choice is one click away.
    expect([...items.options].map((option) => option.textContent)).toEqual([vi_['pay.ledger.filter.all'], 'B01', 'B02', 'B03']);
    const acceptances = screen.getByTestId('filter-acceptance') as HTMLSelectElement;
    fireEvent.change(items, { target: { value: '' } });
    await waitFor(() => expect(document.querySelectorAll('tbody > tr[data-line]')).toHaveLength(2));
    fireEvent.change(acceptances, { target: { value: acceptanceId(2) } });
    await waitFor(() => expect(calls(h).at(-1)?.query).toMatchObject({ acceptance_id: acceptanceId(2) }));
    expect(calls(h).at(-1)?.query).not.toHaveProperty('boq_item_id');
    await waitFor(() => expect((document.querySelector('tbody > tr[data-line] [data-testid="item"]') as HTMLElement).textContent).toBe('B03'));
    fireEvent.change(acceptances, { target: { value: '' } });
    await waitFor(() => expect(screen.getByTestId('more')).toBeTruthy());
    expect(calls(h).at(-1)?.query).toEqual({ limit: 50 });
  });

  it('starts from the filter in the address', async () => {
    const h = open(world([line(1), line(2)]), `${PATH}&item=${itemId(2)}&acceptance=${acceptanceId(1)}`);
    await screen.findByTestId('ledger');
    expect(calls(h)[0]?.query).toMatchObject({ boq_item_id: itemId(2), acceptance_id: acceptanceId(1) });
    expect(document.querySelectorAll('tbody > tr[data-line]')).toHaveLength(1);
    expect((screen.getByTestId('filter-item') as HTMLSelectElement).value).toBe(itemId(2));
  });

  it('shows more balances with the cursor of the last page, and no button once there are no more', async () => {
    const h = open(world([line(1), line(2), line(3)]));
    await screen.findByTestId('ledger');
    expect(document.querySelectorAll('tbody > tr[data-line]')).toHaveLength(2);
    fireEvent.click(screen.getByTestId('more'));
    await waitFor(() => expect(document.querySelectorAll('tbody > tr[data-line]')).toHaveLength(3));
    expect(calls(h).at(-1)?.query).toMatchObject({ cursor: '2' });
    expect(screen.queryByTestId('more')).toBeNull();
    // The contract and the totals are those of the first page.
    expect(screen.getByTestId('contract-accepted').textContent).toBe('800.000.000');
  });

  it('shows the state of a contract that is not there, of a refusal and of a failure', async () => {
    open(world([], { answer: new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c' }) }));
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    expect(screen.queryByTestId('contract-code')).toBeNull();
    cleanup();
    open(world([], { answer: new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }) }));
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    cleanup();
    open(world([], { answer: new Error('boom') }));
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    cleanup();
    open(world([], { answer: { not: 'a ledger' } }));
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
  });

  it('shows a page of an unreadable shape as a contract that is not there, never half a ledger', async () => {
    open(world([line(1)], { answer: { ...page([line(1)]), total: null } }));
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    expect(screen.queryByTestId('contract-code')).toBeNull();
  });
});
