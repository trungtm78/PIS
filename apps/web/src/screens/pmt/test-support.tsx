import { vi } from 'vitest';
import { harness as baseHarness, mount as baseMount, routeOf as baseRoute } from '../sas/test-support';
import type { Harness } from '../sas/test-support';

export type { Harness };

export const MANAGER = ['permit.catalogue.manage', 'permit.read'];
export const READER = ['permit.read'];

export const routeOf = (id: string, req: string) => ({ ...baseRoute(id, req), module: 'PMT', path: `/pmt/${id.toLowerCase()}` });

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A row of the permit type read, in the shape the server writes it. */
export const permitType = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid(n),
  code: `PERMIT_${n}`,
  revision: 1,
  name: `Giấy phép ${n}`,
  category: 'CONSTRUCTION_PERMIT',
  authority_text: 'Cơ quan có thẩm quyền',
  legal_basis: `Nghị định ${n}/2026, điều 1`,
  cxn_ref: null,
  effective_from: '2026-01-01',
  effective_until: null,
  applies_to_rule: {},
  default_validity_months: null,
  default_processing_days: null,
  exemption_allowed: false,
  status: 'PUBLISHED',
  supersedes_id: null,
  version: 1,
  ...overrides,
});

/** A client whose commands are answered by `command` and whose catalogue read is answered by `catalogue` (rows, or a failure). */
export function client(command: (operation: string, input: unknown) => unknown = () => ({}), catalogue: () => Array<Record<string, unknown>> | Error = () => []): Harness {
  const h = baseHarness((operation) => new Error(`unexpected read ${operation}`), command);
  (h.client as unknown as { readAll: (operation: string) => Promise<unknown[]> }).readAll = vi.fn((operation: string) => {
    if (operation !== 'get_resources_permit_type') return Promise.reject(new Error(`unexpected readAll ${operation}`));
    const rows = catalogue();
    return rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows);
  });
  return h;
}

export const mount = baseMount;
