import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { ApiClientProvider } from '../../api/ApiClientContext';
import { ALL_MODULES_VISIBLE } from '../../navigation/model';
import { SessionContext } from '../../session/SessionContext';
import type { SessionTenant, SessionValue } from '../../session/SessionContext';
import { harness as baseHarness, mount as baseMount, routeOf as baseRoute } from '../sas/test-support';
import type { Harness } from '../sas/test-support';

export type { Harness };

export const MANAGER = ['issue.sla.manage', 'issue.read', 'master.read'];
export const READER = ['issue.read'];
/** The people of the issue screens: the officer who reports, the coordinator who assigns and moves, the worker who starts and comments. */
export const REPORTER = ['issue.read', 'issue.create', 'issue.work'];
export const COORDINATOR = ['issue.read', 'issue.assign', 'issue.work'];
export const WORKER = ['issue.read', 'issue.work'];
/** The people of the end of an issue: the one who confirms and closes (and may give the result back), the one who extends deadlines, the handler who holds the permissions and is stopped by independence. */
export const VERIFIER = ['issue.read', 'issue.close', 'issue.reopen', 'issue.assign'];
export const EXTENDER = ['issue.read', 'issue.extend'];
export const ESCALATOR = ['issue.read', 'issue.escalate', 'organization_unit.read'];
export const HANDLER = ['issue.read', 'issue.work', 'issue.close', 'issue.extend', 'issue.reopen'];

export const routeOf = (id: string, req: string) => ({ ...baseRoute(id, req), module: 'ISS', path: `/iss/${id.toLowerCase()}` });

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(10, '0')}`;

/** A row of the policy read, in the shape the server writes it. */
export const policy = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid('a1', n),
  code: `SLA-${n}`,
  revision: 1,
  category_version_id: uuid('b1', n),
  category_record_id: uuid('c1', n),
  category_key: `GPMB-${n}`,
  category_label: `Giải phóng mặt bằng ${n}`,
  severity: 'HIGH',
  owner_unit_id: null,
  calendar_code: 'WORKDAY_VN',
  response_hours: 4,
  resolve_hours: 72,
  escalate_l2_pct: 100,
  escalate_l3_pct: 150,
  require_independent_verifier: true,
  require_evidence: true,
  valid_from: '2026-01-01',
  valid_until: null,
  status: 'ACTIVE',
  version: 1,
  ...overrides,
});

export const category = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid('c1', n),
  namespace: 'TENANT',
  master_type: 'ISSUE_CATEGORY',
  business_key: `GPMB-${n}`,
  status: 'EFFECTIVE',
  label: `Giải phóng mặt bằng ${n}`,
  version_id: uuid('b1', n),
  version: 2,
  ...overrides,
});

export const unit = (n: number, overrides: Record<string, unknown> = {}) => ({ id: uuid('d1', n), code: `UBND-${n}`, name: `Ủy ban nhân dân ${n}`, ...overrides });

export const project = (n: number, overrides: Record<string, unknown> = {}) => ({ id: uuid('e1', n), code: `DA-2026-00${n}`, name: `Dự án số ${n}`, ...overrides });

export const person = (n: number) => ({ membership_id: uuid('f1', n), display_name: `Nguyễn Văn ${String.fromCharCode(64 + n)}` });

/** A person of the read of the people an issue may be given to. */
export const member = (n: number, overrides: Record<string, unknown> = {}) => ({ ...person(n), ...overrides });

const FUTURE = '2999-01-01T10:00:00.000Z';

/** A line of the issue list, in the shape the server writes it. */
export const issue = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid('a2', n),
  code: `VM-2026-00000${n}`,
  title: `Chậm bàn giao mặt bằng số ${n}`,
  project_id: uuid('e1', 1),
  project_code: 'DA-2026-001',
  project_name: 'Dự án số 1',
  category_version_id: uuid('b1', 1),
  category_label: 'Giải phóng mặt bằng 1',
  severity: 'HIGH',
  status: 'OPEN',
  owner_unit_id: uuid('d1', 1),
  owner_unit_name: 'Ủy ban nhân dân 1',
  assignee: null,
  reported_by: person(1),
  source_module: 'MANUAL',
  source_ref_id: null,
  contract_id: null,
  escalation_level: 0,
  opened_at: '2026-10-20T02:00:00.000Z',
  response_due_at: '2026-10-20T06:00:00.000Z',
  responded_at: null,
  due_at: FUTURE,
  overdue_since: null,
  overdue_days: null,
  closed_at: null,
  reopen_count: 0,
  version: 1,
  ...overrides,
});

export const event = (n: number, kind: string, overrides: Record<string, unknown> = {}) => ({
  id: uuid('c2', n),
  kind,
  from_status: null,
  to_status: null,
  from_assignee: null,
  to_assignee: null,
  note: null,
  document_version_id: null,
  actor: person(1),
  payload: {},
  created_at: `2026-10-20T0${n}:00:00.000Z`,
  ...overrides,
});

/** The workspace of an issue: its line, the text, the SLA, the position and the first page of its timeline. */
export const detail = (n: number, overrides: Record<string, unknown> = {}) => ({
  ...issue(n),
  description: 'Hộ dân chưa nhận tiền bồi thường nên chưa bàn giao mặt bằng.',
  resolved_at: null,
  verifier: null,
  sla: { policy_id: uuid('a1', 1), policy_code: 'SLA-GPMB-HIGH', policy_revision: 2, calendar_code: 'WORKDAY_VN', response_hours: 4, resolve_hours: 72, require_evidence: true, require_independent_verifier: true },
  extensions: { used: 0, limit: 2 },
  reopen_window_days: 30,
  escalations: [],
  active_task_force: null,
  geo_consent: false,
  geo: null,
  events: [event(1, 'CREATED', { to_status: 'OPEN' })],
  next_cursor: null,
  as_of: '2026-10-24T01:00:00.000Z',
  ...overrides,
});

/** A line of the board of escalations (ISS-10), in the shape the server writes it. */
export const breach = (n: number, overrides: Record<string, unknown> = {}) => ({
  escalation_id: uuid('b2', n),
  issue_id: uuid('a2', n),
  issue_code: `VM-2026-00000${n}`,
  issue_title: `Chậm bàn giao mặt bằng số ${n}`,
  issue_status: 'ESCALATED',
  severity: 'HIGH',
  project_code: 'DA-2026-001',
  owner_unit_name: 'Ủy ban nhân dân 1',
  level: 2,
  trigger: 'SLA_AUTO',
  target_unit: { id: uuid('d1', 1), name: 'Ủy ban nhân dân 1' },
  task_force: null,
  accept_due_at: '2999-01-01T10:00:00.000Z',
  status: 'OPEN',
  accepted_by: null,
  accepted_at: null,
  created_at: '2026-10-20T02:00:00.000Z',
  issue_due_at: '2026-10-19T02:00:00.000Z',
  overdue_since: '2026-10-19T02:00:00.000Z',
  overdue_days: 3,
  acceptable: false,
  ...overrides,
});

export interface World {
  categories: Array<Record<string, unknown>>;
  units: Array<Record<string, unknown>>;
  /** The issues of the list, and the workspace of each (the read of one issue answers the one whose id is asked). */
  issues: Array<Record<string, unknown>>;
  details: Array<Record<string, unknown>>;
  projects: Array<Record<string, unknown>>;
  members: Array<Record<string, unknown>>;
  /** The escalations of the board (ISS-10), in the shape the server writes them. */
  breaches: Array<Record<string, unknown>>;
  /** Operations whose read fails. */
  failing: Set<string>;
  /** The pages of a timeline that a read of one issue answers after the first, by cursor. */
  pages: Map<string, Record<string, unknown>>;
}

export function world(overrides: Partial<World> = {}): World {
  return {
    categories: [category(1), category(2)],
    units: [unit(1)],
    issues: [],
    details: [],
    projects: [project(1)],
    members: [member(1), member(2)],
    breaches: [],
    failing: new Set(),
    pages: new Map(),
    ...overrides,
  };
}

/** A client over `state`: every read is answered from it, and `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  const h = baseHarness((operation, input) => {
    if (state.failing.has(operation)) return new Error(`${operation} failed`);
    if (operation === 'get_resources_issue_id') {
      const asked = input as { path?: { id?: string }; query?: { cursor?: string } } | undefined;
      const cursor = asked?.query?.cursor;
      if (cursor !== undefined) return state.pages.get(cursor) ?? new Error('unknown cursor');
      return state.details.find((item) => item.id === asked?.path?.id) ?? new Error('not found');
    }
    return new Error(`unexpected read ${operation}`);
  }, command);
  (h.client as unknown as { readAll: (operation: string) => Promise<unknown[]> }).readAll = vi.fn((operation: string) => {
    if (state.failing.has(operation)) return Promise.reject(new Error(`${operation} failed`));
    switch (operation) {
      case 'searchMasterRecords':
        return Promise.resolve(state.categories);
      case 'get_resources_organization_unit':
        return Promise.resolve(state.units);
      case 'get_resources_issue':
        return Promise.resolve(state.issues);
      case 'get_resources_project':
        return Promise.resolve(state.projects);
      case 'listIssueAssignees':
        return Promise.resolve(state.members);
      case 'listIssueSlaBreaches':
        return Promise.resolve(state.breaches);
      default:
        return Promise.reject(new Error(`unexpected readAll ${operation}`));
    }
  });
  return h;
}

export const mount = baseMount;

/** The signed-in member of the issue screens: the people of the reads are named after the ids of the world. */
export const SELF_MEMBERSHIP = uuid('f1', 1);

const TENANT: SessionTenant = {
  id: '00000000-0000-4000-8000-00000000000a',
  name: 'Cao Bang',
  monogram: 'CB',
  membershipId: SELF_MEMBERSHIP,
  theme: { themeId: 'tenant', version: 1, overlay: {} },
};

export interface SessionOptions {
  permissions: readonly string[] | undefined;
  mode?: 'FULL' | 'READ_ONLY';
  path?: string;
}

/** Mounts a screen in a session with the given permissions and mode, at the given address (the issue of the workspace is in its query string). */
export function mountIssue(screen: ReactElement, h: Harness, options: SessionOptions): RenderResult & { queries: QueryClient } {
  const session: SessionValue = {
    tenant: TENANT,
    tenants: [TENANT],
    user: { displayName: 'Admin', initials: 'AD' },
    access: ALL_MODULES_VISIBLE,
    switchTenant: () => undefined,
    getSession: () => Promise.resolve({ token: 'token' }),
    permissions: options.permissions,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
  };
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return {
    queries,
    ...render(
      <SessionContext.Provider value={session}>
        <QueryClientProvider client={queries}>
          <ApiClientProvider client={h.client}>
            <MemoryRouter initialEntries={[options.path ?? '/']}>{screen}</MemoryRouter>
          </ApiClientProvider>
        </QueryClientProvider>
      </SessionContext.Provider>,
    ),
  };
}
