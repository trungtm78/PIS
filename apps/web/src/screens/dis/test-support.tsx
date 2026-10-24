import { vi } from 'vitest';
import { harness as baseHarness, mount as baseMount, routeOf as baseRoute } from '../sas/test-support';
import type { Harness } from '../sas/test-support';

export type { Harness };

/** A period manager (soft close, lock, generate), a planner who may not lock, and a maker of reports who only reads the calendar. */
export const MANAGER = ['period.manage', 'period.lock', 'reporting_period.read'];
export const PLANNER = ['period.manage', 'reporting_period.read'];
export const MAKER = ['reporting_period.read'];
/** A maker who may ask for a reopening, an approver who may decide one, and a person who may do both (never on their own request). */
export const REQUESTER = ['reporting_period.read', 'period.reopen.request'];
export const APPROVER = ['reporting_period.read', 'period.reopen.approve'];
export const BOTH = ['reporting_period.read', 'period.reopen.request', 'period.reopen.approve'];

/** The membership of the session of the harness (the platform tenant of the SAS test support), and another person. */
export const ME = '00000000-0000-4000-8000-0000000000e9';
export const SOMEONE_ELSE = '00000000-0000-4000-8000-0000000000f1';

export const routeOf = (id: string, req: string) => ({ ...baseRoute(id, req), module: 'DIS', path: `/dis/${id.toLowerCase()}` });

const uuid = (n: number): string => `00000000-0000-4000-8000-${'0003'}${String(n).padStart(8, '0')}`;

/** The year the screen opens on: the periods of the fixtures belong to it unless a test says otherwise. */
export const CURRENT_YEAR = new Date().getFullYear();

/** A deadline long past (2020) and one far ahead (2099), so a test never depends on the day it runs. */
export const PAST_DEADLINE = '2020-01-10T03:00:00.000Z';
export const FUTURE_DEADLINE = '2099-01-09T03:00:00.000Z';

/** A period of the answer of `get_resources_reporting_period`: OPEN, WEEK, calendar r1, version 1, unless overridden. */
export const period = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid(n),
  code: `W${CURRENT_YEAR}-${String(n).padStart(2, '0')}`,
  calendar_code: 'DEFAULT',
  period_type: 'WEEK',
  fiscal_year: CURRENT_YEAR,
  start_date: `${CURRENT_YEAR}-01-${String(3 + (n - 1) * 7).padStart(2, '0')}`,
  end_date: `${CURRENT_YEAR}-01-${String(9 + (n - 1) * 7).padStart(2, '0')}`,
  deadline_at: PAST_DEADLINE,
  calendar_version: 1,
  calendar_version_id: uuid(900 + n),
  status: 'OPEN',
  soft_closed_at: null,
  locked_at: null,
  locked_by: null,
  version: 1,
  reopens: [],
  ...overrides,
});

export const PROJECT_ONE = '00000000-0000-4000-8000-0005000000a1';
export const PROJECT_TWO = '00000000-0000-4000-8000-0005000000a2';

/** A request to reopen a period as the calendar answers it to the requester and the approvers (the detail), WEEK, version 1, unless overridden. */
export const reopen = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-0004${String(n).padStart(8, '0')}`,
  scope_kind: 'PROJECTS',
  status: 'REQUESTED',
  window_until: null,
  requested_at: `2026-10-0${n}T01:00:00.000Z`,
  version: 1,
  reason: 'The Treasury returned the vouchers for a wrong source code',
  requested_by: SOMEONE_ELSE,
  requested_window_hours: 72,
  approved_by: null,
  decided_by: null,
  decided_at: null,
  decision_reason: null,
  projects: [{ id: PROJECT_ONE, code: 'P-A-001' }],
  ...overrides,
});

/** A project of the register as the list answers it. */
export const project = (id: string, code: string, name: string) => ({ id, code, name, status: 'IMPLEMENTATION', version: 1 });

export interface World {
  periods: Array<Record<string, unknown>>;
  /** The projects the register answers. */
  projects: Array<Record<string, unknown>>;
  /** Reads that fail, by operation. */
  failing: Set<string>;
}

export function world(overrides: Partial<World> = {}): World {
  return { periods: [], projects: [], failing: new Set(), ...overrides };
}

/** A client over `state`: the periods are answered from it, and `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  const h = baseHarness(() => new Error('unexpected read'), command);
  (h.client as unknown as { readAll: (operation: string) => Promise<unknown[]> }).readAll = vi.fn((operation: string) => {
    if (state.failing.has(operation)) return Promise.reject(new Error(`${operation} failed`));
    if (operation === 'get_resources_reporting_period') return Promise.resolve(state.periods);
    if (operation === 'get_resources_project') return Promise.resolve(state.projects);
    return Promise.reject(new Error(`unexpected readAll ${operation}`));
  });
  return h;
}

export const mount = baseMount;
