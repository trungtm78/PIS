import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { daysLeft, vietnamToday } from './model';
import WarrantyScreen from './WarrantyScreen';
import { READER, client, mount, routeOf, warranty, warrantyId, world } from './test-support';
import type { World } from './test-support';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
const open = (state: World) => {
  const h = client(state);
  mount(<WarrantyScreen route={routeOf('AST-04', 'FR-AST-04')} />, h, { permissions: READER, path: '/ast/ast-04' });
  return h;
};
const addDays = (days: number): string => new Date(Date.parse(`${vietnamToday()}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

describe('AST-04 the warranties that end soon (listExpiringWarranties)', () => {
  it('asks for 90 days by default, lists the obligations with the days left and their "i", and reads again for another window', async () => {
    const h = open(world({ expiring: [warranty(1, { ends_on: addDays(20), open_claims: 1, total_claims: 2 }), warranty(2, { ends_on: addDays(60) })] }));
    const table = await screen.findByTestId('expiring-table');
    expect(h.read).toHaveBeenCalledWith('listExpiringWarranties', { query: { within_days: '90', limit: '50' } });
    expect(within(table).getByTestId(`expiring-left-${warrantyId(1)}`).textContent).toBe(String(daysLeft(addDays(20), vietnamToday())));
    expect(within(table).getAllByRole('button', { name: new RegExp(word('govc.bi.info.open').split('{')[0] ?? '') })).toHaveLength(2);
    fireEvent.change(screen.getByTestId('expiring-window'), { target: { value: '30' } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listExpiringWarranties', { query: { within_days: '30', limit: '50' } }));
  });

  it('says nothing ends within the window, and says the list is cut when the server has more', async () => {
    open(world({ expiring: [] }));
    expect((await screen.findByTestId('expiring-empty')).textContent).toContain('90');
    cleanup();
    open(world({ expiring: Array.from({ length: 50 }, (_, index) => warranty(index + 1, { ends_on: addDays(10) })) }));
    expect(await screen.findByTestId('expiring-more')).toBeTruthy();
  });

  it('shows a failed read as an error with a retry, and does not break the list of obligations below it', async () => {
    const state = world({ warranties: [warranty(3)], failing: new Set(['listExpiringWarranties']) });
    const h = open(state);
    const error = await screen.findByTestId('expiring-error');
    expect(await screen.findByTestId('warranties')).toBeTruthy();
    state.failing.clear();
    state.expiring = [warranty(1, { ends_on: addDays(5) })];
    fireEvent.click(within(error).getByRole('button', { name: word('ast.warranty.expiring.retry') }));
    expect(await screen.findByTestId('expiring-table')).toBeTruthy();
    expect(h.read.mock.calls.filter((call) => call[0] === 'listExpiringWarranties')).toHaveLength(2);
  });
});
