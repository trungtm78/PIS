import { ApiError } from '@machvon/api-client';
import { harness as baseHarness } from '../sas/test-support';
import type { Harness } from '../sas/test-support';

export { mount, routeOf } from './test-support';
import fixtureText from './fixture-text.vi.json';
export type { Harness };

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const DOCUMENT = uuid(900);

export const card = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid(100 + n),
  code: `DA-2026-${String(n).padStart(3, '0')}`,
  name: `${fixtureText['project.numbered']} ${n}`,
  status: 'PIPELINE',
  project_group: 'B',
  appraisal_score: '72.50',
  total_investment_vnd: '500000000000',
  national_project_code: '7654321',
  capital_ready: true,
  owner_unit_name: fixtureText['unit.transport.name'],
  investor_unit_name: fixtureText['unit.provincialPmb.name'],
  leader_in_charge: null,
  status_changed_at: '2026-10-24T01:00:00.000Z',
  version: 1,
  ...overrides,
});

export const move = (operation: string, to: string, guards: Array<[string, string]> = [], allowed = true) => ({
  operation,
  to,
  permission: 'project.stage.x',
  allowed,
  guards: guards.map(([key, state]) => ({ key, state })),
});

export const lifecycle = (n: number, status: string, next: unknown[], history: unknown[] = [], overrides: Record<string, unknown> = {}) => ({
  project_id: uuid(100 + n),
  code: `DA-2026-${String(n).padStart(3, '0')}`,
  status,
  version: 3,
  project_group: 'B',
  national_project_code: null,
  status_changed_at: '2026-10-24T01:00:00.000Z',
  history,
  next,
  as_of: '2026-10-24T02:00:00.000Z',
  ...overrides,
});

export const historyLine = (from: string, to: string, kind: 'USER' | 'SYSTEM', actor: string | null) => ({
  from,
  to,
  version: 2,
  operation: kind === 'SYSTEM' ? 'capital.plan_published.v1' : 'suspendProject',
  actor_kind: kind,
  actor_name: actor,
  decision_document_id: DOCUMENT,
  reason: kind === 'SYSTEM' ? null : 'Works stopped for a flood',
  effective_date: null,
  occurred_at: '2026-10-20T03:00:00.000Z',
});

export interface BoardWorld {
  /** The cards of each stage, in the order the server ranks them. */
  columns: Record<string, Array<Record<string, unknown>>>;
  lifecycles: Record<string, unknown>;
  /** Operations whose read fails. */
  failing: Set<string>;
  /** Stages whose column fails. */
  failingStages: Set<string>;
  pageSize?: number;
  /** The server refuses the read of the bank (403). */
  denied?: boolean;
}

export function boardWorld(overrides: Partial<BoardWorld> = {}): BoardWorld {
  return { columns: {}, lifecycles: {}, failing: new Set(), failingStages: new Set(), ...overrides };
}

/** A client over `state`: the pipeline is answered per stage and group, a page at a time; the lifecycle per project. */
export function boardClient(state: BoardWorld, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  return baseHarness((operation, input) => {
    if (state.failing.has(operation)) return new Error(`${operation} failed`);
    if (operation === 'listProjectPipeline') {
      if (state.denied === true) return new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c', extensions: {} });
      const query = (input as { query?: Record<string, string | number> } | undefined)?.query ?? {};
      const stage = String(query.stage);
      if (state.failingStages.has(stage)) return new Error(`column ${stage} failed`);
      const all = (state.columns[stage] ?? []).filter((item) => query.project_group === undefined || item.project_group === query.project_group);
      const start = query.cursor === undefined ? 0 : Number(query.cursor);
      const limit = state.pageSize ?? Number(query.limit);
      const items = all.slice(start, start + limit);
      return { items, total: all.length, next_cursor: start + limit < all.length ? String(start + limit) : null, as_of: '2026-10-24T02:00:00.000Z' };
    }
    if (operation === 'getProjectLifecycle') {
      const id = (input as { path?: { id?: string } } | undefined)?.path?.id;
      return state.lifecycles[String(id)] ?? new Error('not found');
    }
    return new Error(`unexpected read ${operation}`);
  }, command);
}

