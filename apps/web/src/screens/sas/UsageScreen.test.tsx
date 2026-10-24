import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import UsageScreen from './UsageScreen';
import { harness, mount, routeOf } from './test-support';

const ROUTE = routeOf('SAS-11', 'FR-SAS-11');
const BILLING = ['system.tenant.read', 'system.billing.manage'];
const TENANT_MEMBER = ['subscription.read'];
const TENANT_A = '00000000-0000-4000-8000-0000000000a1';
const TENANT_B = '00000000-0000-4000-8000-0000000000b1';

const summary = (overrides: Record<string, unknown> = {}) => ({
  as_of: '2026-10-25T06:00:00Z',
  window_start: '2026-10-01T00:00:00Z',
  window_end: '2026-11-01T00:00:00Z',
  meters: [
    { counter: 'notification.messages', unit: 'message', used: '950', limit: '1000' },
    { counter: 'ai.tokens', unit: 'token', used: '250.5' },
    { counter: 'storage.gb_day', unit: 'gb_day', used: '0' },
    { counter: 'bi.queries', unit: 'query', used: '12', limit: '10' },
  ],
  seats: { used: 120, limit: 100 },
  guest_seats: { used: 2, limit: 5 },
  ...overrides,
});

const events = [
  { id: 'ev-1', meter: 'notification.zns', external_event_key: 'da-1001', quantity: '1', unit: 'message', occurred_at: '2026-10-20T01:00:00Z', source_reference: 'campaign:42', recorded_at: '2026-10-20T01:00:01Z' },
  { id: 'ev-2', meter: 'ai.tokens', external_event_key: 'tok-77', quantity: '500', unit: 'token', occurred_at: '2026-10-19T01:00:00Z', source_reference: 'analysis:9', recorded_at: '2026-10-19T01:00:01Z' },
];

interface State {
  mine: Record<string, unknown> | Error;
  byTenant: Map<string, Record<string, unknown> | Error>;
  tenants: Array<{ id: string; code: string; name: string }>;
}

const state = (overrides: Partial<State> = {}): State => ({
  mine: summary(),
  byTenant: new Map([
    [TENANT_A, summary({ recent_events: events })],
    [TENANT_B, summary({ meters: [{ counter: 'notification.messages', unit: 'message', used: '3', limit: '1000' }], seats: { used: 1 }, recent_events: [] })],
  ]),
  tenants: [
    { id: TENANT_A, code: 'cao-bang', name: 'Cao Bằng' },
    { id: TENANT_B, code: 'ha-giang', name: 'Hà Giang' },
  ],
  ...overrides,
});

function client(current: State) {
  const h = harness((operation, input) => {
    if (operation === 'getMyUsage') return current.mine;
    if (operation === 'getTenantUsage') return current.byTenant.get((input as { path: { tenantId: string } }).path.tenantId) ?? new Error('unknown tenant');
    if (operation === 'listSystemTenants') return { items: current.tenants, next_cursor: null };
    return new Error(`unexpected read ${operation}`);
  });
  return h;
}

afterEach(cleanup);

const counters = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('tr[data-counter]'));
const ready = () => waitFor(() => expect(counters().length).toBeGreaterThan(0));
const cellText = (row: HTMLElement | undefined, index: number): string => row?.querySelectorAll('td')[index]?.textContent ?? '';
const problem = (code: string, status: number) => new ApiError({ status, code, correlationId: 'c', extensions: {} });

describe('UsageScreen (SAS-11): the usage of the month', () => {
  describe('the tenant plane', () => {
    it('shows the counters with unit, used, limit and where each stands in words, and the seats (UI-SAS-11, AC-ST-SAS-010-3)', async () => {
      const h = client(state());
      mount(<UsageScreen route={ROUTE} />, h, TENANT_MEMBER);
      await ready();
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['sas.usage.page.title']);
      expect(h.read).toHaveBeenCalledWith('getMyUsage');
      const [messages, ai, storage, bi] = counters();
      expect(cellText(messages, 0)).toContain(vi_['sas.usage.counter.messages']);
      expect(cellText(messages, 0)).toContain('notification.messages');
      expect(cellText(messages, 1)).toBe(vi_['sas.usage.unit.message']);
      expect(cellText(messages, 2)).toBe('950');
      expect(cellText(messages, 3)).toBe('1000');
      expect(cellText(messages, 4)).toContain(vi_['sas.usage.level.near']);
      expect(cellText(messages, 4)).toContain(vi_['sas.usage.share.text'].replace('{percent}', '95'));
      expect(messages?.getAttribute('data-level')).toBe('near');
      // A counter without a limit says it is only reported, and has no share.
      expect(cellText(ai, 3)).toBe(vi_['sas.usage.limit.none']);
      expect(cellText(ai, 4)).toBe(vi_['sas.usage.level.none']);
      expect(cellText(storage, 4)).toBe(vi_['sas.usage.level.none']);
      // Over its limit it says so.
      expect(cellText(bi, 4)).toContain(vi_['sas.usage.level.over']);
      const staff = document.querySelector('tr[data-seat="staff"]');
      expect(cellText(staff as HTMLElement, 1)).toBe('120');
      expect(cellText(staff as HTMLElement, 2)).toBe('100');
      expect(staff?.getAttribute('data-level')).toBe('over');
      expect(cellText(staff as HTMLElement, 3)).toContain(vi_['sas.usage.level.over']);
      const guests = document.querySelector('tr[data-seat="guests"]');
      expect(guests?.getAttribute('data-level')).toBe('ok');
    });

    it('names the month the counters are of, in UTC', async () => {
      mount(<UsageScreen route={ROUTE} />, client(state()), TENANT_MEMBER);
      await ready();
      const from = new Date('2026-10-01T00:00:00Z').toLocaleDateString('vi', { timeZone: 'UTC' });
      const until = new Date('2026-10-31T23:59:59.999Z').toLocaleDateString('vi', { timeZone: 'UTC' });
      expect(screen.getByText(vi_['sas.usage.window.text'].replace('{from}', from).replace('{until}', until))).toBeTruthy();
    });

    it('has no tenant picker and no events: the events are the control plane\'s', async () => {
      mount(<UsageScreen route={ROUTE} />, client(state()), TENANT_MEMBER);
      await ready();
      expect(screen.queryByLabelText(vi_['sas.usage.tenant.label'])).toBeNull();
      expect(screen.queryByText(vi_['sas.usage.events.title'])).toBeNull();
    });

    it('says a seat limit that is absent is no limit', async () => {
      mount(<UsageScreen route={ROUTE} />, client(state({ mine: summary({ seats: { used: 7 }, guest_seats: { used: 0 } }) })), TENANT_MEMBER);
      await ready();
      const staff = document.querySelector('tr[data-seat="staff"]') as HTMLElement;
      expect(cellText(staff, 2)).toBe(vi_['sas.usage.limit.none']);
      expect(cellText(staff, 3)).toBe(vi_['sas.usage.level.none']);
    });
  });

  describe('the control plane', () => {
    it('reads the first tenant, shows its latest events, and reads the next tenant when it is chosen', async () => {
      const h = client(state());
      mount(<UsageScreen route={ROUTE} />, h, BILLING);
      await ready();
      expect(h.read).toHaveBeenCalledWith('getTenantUsage', { path: { tenantId: TENANT_A } });
      expect(cellText(counters()[0], 2)).toBe('950');
      const table = screen.getByRole('table', { name: vi_['sas.usage.events.title'] });
      const rows = within(table).getAllByRole('row').slice(1);
      expect(rows).toHaveLength(2);
      expect(rows[0]?.textContent).toContain('notification.zns');
      expect(rows[0]?.textContent).toContain('campaign:42');
      expect(rows[0]?.textContent).toContain('da-1001');
      expect(rows[0]?.textContent).toContain(`1 ${vi_['sas.usage.unit.message']}`);
      expect(rows[1]?.textContent).toContain(`500 ${vi_['sas.usage.unit.token']}`);
      fireEvent.change(screen.getByLabelText(vi_['sas.usage.tenant.label']), { target: { value: TENANT_B } });
      await waitFor(() => expect(h.read).toHaveBeenCalledWith('getTenantUsage', { path: { tenantId: TENANT_B } }));
      await waitFor(() => expect(cellText(counters()[0], 2)).toBe('3'));
      expect(screen.getByText(vi_['sas.usage.events.empty'])).toBeTruthy();
    });

    it('opens the tenant named in the address, also when it lies beyond the tenants loaded', async () => {
      const other = '00000000-0000-4000-8000-0000000000c1';
      const current = state();
      current.byTenant.set(other, summary({ recent_events: [] }));
      const h = client(current);
      mount(<UsageScreen route={ROUTE} />, h, BILLING, `/?tenant=${other}`);
      await ready();
      expect(h.read).toHaveBeenCalledWith('getTenantUsage', { path: { tenantId: other } });
      expect((screen.getByLabelText(vi_['sas.usage.tenant.label']) as HTMLSelectElement).value).toBe(other);
    });

    it('keeps the tenant picker when the read of the tenant fails', async () => {
      const current = state();
      current.byTenant.set(TENANT_A, problem('RESOURCE_NOT_FOUND', 404));
      mount(<UsageScreen route={ROUTE} />, client(current), BILLING);
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      expect(screen.getByLabelText(vi_['sas.usage.tenant.label'])).toBeTruthy();
    });

    it('offers more tenants when there are more', async () => {
      const h = harness((operation, input) => {
        if (operation === 'getTenantUsage') return summary({ recent_events: [] });
        if (operation !== 'listSystemTenants') return new Error('unexpected');
        const next = (input as { query: { cursor?: string } }).query.cursor === undefined;
        return next ? { items: [{ id: TENANT_A, code: 'cao-bang', name: 'Cao Bằng' }], next_cursor: 'more' } : { items: [{ id: TENANT_B, code: 'ha-giang', name: 'Hà Giang' }], next_cursor: null };
      });
      mount(<UsageScreen route={ROUTE} />, h, BILLING);
      await ready();
      fireEvent.click(screen.getByRole('button', { name: vi_['sas.usage.tenant.more.action'] }));
      await waitFor(() => expect(h.read.mock.calls.filter(([operation]) => operation === 'listSystemTenants')).toHaveLength(2));
    });
  });

  describe('the seven states', () => {
    it('shows loading while the counters are read', async () => {
      const h = client(state());
      (h.client as unknown as { read: () => Promise<unknown> }).read = vi.fn(() => new Promise(() => undefined));
      mount(<UsageScreen route={ROUTE} />, h, TENANT_MEMBER);
      expect(await screen.findByLabelText(vi_['states.loading.label'])).toBeTruthy();
    });

    it('shows the empty state when the answer has no counter', async () => {
      mount(<UsageScreen route={ROUTE} />, client(state({ mine: summary({ meters: [] }) })), TENANT_MEMBER);
      expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    });

    it.each([
      ['an error', new ApiError({ status: 503, code: 'UNAVAILABLE', correlationId: 'c' }), 'states.error.title'],
      ['a refusal', problem('SCOPE_DENIED', 403), 'states.denied.title'],
      ['a lapsed session', problem('SESSION_EXPIRED', 401), 'states.signedOut.title'],
      ['a network failure', new ApiError({ status: 0, code: 'NETWORK_ERROR', correlationId: 'c' }), 'states.offline.title'],
    ])('shows %s as its own state, and retries', async (_name, failure, title) => {
      const current = state({ mine: failure });
      mount(<UsageScreen route={ROUTE} />, client(current), TENANT_MEMBER);
      expect(await screen.findByText(vi_[title as keyof typeof vi_])).toBeTruthy();
      current.mine = summary();
      fireEvent.click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      await ready();
    });

    it('shows the tenant list failing as a state of its own on the control plane', async () => {
      const h = harness((operation) => (operation === 'listSystemTenants' ? problem('SCOPE_DENIED', 403) : new Error('unexpected')));
      mount(<UsageScreen route={ROUTE} />, h, BILLING);
      expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    });
  });
});
