import { vi } from 'vitest';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';

export { mount, routeOf } from '../../bid/plan-test-support';
export type { Harness };

export const MEMBER = ['support.ticket.create', 'support.ticket.read'];
export const READER_ONLY = ['support.ticket.read'];

const uuid = (n: number): string => `00000000-0000-4000-8000-${'0070'}${String(n).padStart(8, '0')}`;
export const ticketId = (n: number): string => uuid(n);

/** A ticket in the shape the list answers it. */
export const ticket = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: ticketId(n),
  ticket_code: `SUP-2026-00000${n}`,
  category: 'ACCESS',
  subject: `Tôi không mở được sổ đăng ký dự án số ${n}`,
  priority: 'P2',
  status: 'Open',
  sla_due_at: '2026-10-27T02:00:00.000000Z',
  created_at: '2026-10-26T02:00:00.000000Z',
  attachment_count: 0,
  own: true,
  version: 1,
  ...overrides,
});

export interface World {
  tickets: Array<Record<string, unknown>>;
  failing: Set<string>;
}

export function world(overrides: Partial<World> = {}): World {
  return { tickets: [], failing: new Set(), ...overrides };
}

/** A client over `state`: the list is answered from it, and `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  const h = baseHarness(() => new Error('unexpected read'), command);
  (h.client as unknown as { readAll: (operation: string) => Promise<unknown[]> }).readAll = vi.fn((operation: string) => {
    if (state.failing.has(operation)) return Promise.reject(new Error(`${operation} failed`));
    if (operation === 'get_resources_support_ticket') return Promise.resolve(state.tickets);
    return Promise.reject(new Error(`unexpected readAll ${operation}`));
  });
  return h;
}
