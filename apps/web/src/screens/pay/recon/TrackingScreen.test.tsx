import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import TrackingScreen from './TrackingScreen';
import { PROJECT, READER, client, mount, routeOf, tracking, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('PAY-09', 'FR-PAY-09');
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(state: World, permissions: readonly string[] = READER) {
  const h = client(state);
  mount(<TrackingScreen route={ROUTE} />, h, { permissions, path: '/pay/pay-09' });
  return h;
}

const rowOf = (id: string): HTMLElement => document.querySelector(`tr[data-project="${id}"]`) as HTMLElement;

describe('TrackingScreen (PAY-09): the projects with the Treasury', () => {
  it('UI-PAY-09: shows, for each project, the Treasury code, what was sent, settled and confirmed, what is not matched, the differences that wait and the last statement', async () => {
    open(world({ tracking: [tracking(1), tracking(2, { differences: { count: 0, amount_vnd: '0' }, last_import_at: null, unmatched: 0 })] }));
    await screen.findByTestId('tracking');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['pay.track.title']);
    expect(screen.getByText(text('pay.track.footer', { id: 'PAY-09', req: 'FR-PAY-09' }))).toBeTruthy();
    const first = rowOf(PROJECT);
    expect(within(first).getByTestId('project').textContent).toBe('Dự án 1');
    expect(within(first).getByTestId('code').textContent).toBe('DA-A-001');
    expect(within(first).getByTestId('sent').textContent).toBe(text('pay.track.count', { count: 2, amount: '4.200.000.000' }));
    expect(within(first).getByTestId('settled').textContent).toBe(text('pay.track.count', { count: 1, amount: '2.100.000.000' }));
    expect(within(first).getByTestId('confirmed').textContent).toBe(text('pay.track.count', { count: 3, amount: '5.190.000.000' }));
    expect(within(first).getByTestId('unmatched').textContent).toBe('1');
    expect(within(first).getByTestId('differences').textContent).toBe(text('pay.track.count', { count: 1, amount: '-10.000.000' }));
    expect((within(first).getByTestId('differences').querySelector('a') as HTMLAnchorElement).getAttribute('href')).toBe('/pay/pay-05');
    expect(within(first).getByTestId('sync').textContent).not.toBe(vi_['pay.track.never']);
    const second = within(screen.getByTestId('tracking')).getAllByRole('row')[2] as HTMLElement;
    expect(within(second).getByTestId('differences').textContent).toBe('0');
    expect(within(second).getByTestId('differences').querySelector('a')).toBeNull();
    expect(within(second).getByTestId('sync').textContent).toBe(vi_['pay.track.never']);
  });

  it('says so when no project has anything with the Treasury, when the read fails and when the caller may not read', async () => {
    open(world({ tracking: [] }));
    expect((await screen.findByTestId('nothing')).textContent).toBe(vi_['pay.track.empty']);
    cleanup();
    open(world({ failing: new Set(['getTreasuryTracking']) }));
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    cleanup();
    open(world(), ['reconciliation.read']);
    expect((await screen.findByTestId('no-read')).textContent).toBe(vi_['pay.track.read.denied']);
    expect(screen.queryByTestId('tracking')).toBeNull();
  });
});
