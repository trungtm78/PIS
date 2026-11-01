import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { client, line, world } from '../test-support';
import type { Harness } from '../test-support';

export const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
export const fill = (value: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, item]) => out.replace(`{${key}}`, String(item)), value);
export const problem = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c', extensions: {} });

/** The failures a read can end in, with the title of the standard card each must show. */
export const FAILURES: Array<[string, Error, string]> = [
  ['denied', problem(403, 'SCOPE_DENIED'), word('states.denied.title')],
  ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c', extensions: {} }), word('states.offline.title')],
  ['error', problem(500, 'INTERNAL_ERROR'), word('states.error.title')],
  ['signed out', problem(401, 'SESSION_EXPIRED'), word('states.signedOut.title')],
];

export const PROJECT = line(1).id;
export const OTHER = line(2).id;
const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;

export const assignment = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid('0040', n),
  project_id: PROJECT,
  project_code: line(1).code,
  project_name: line(1).name,
  leader: { membership_id: uuid('0050', n), display_name: `Người phụ trách ${n}` },
  accountability_role: 'LEADER_IN_CHARGE',
  assignment_document_id: null,
  valid_from: '2026-01-05',
  valid_until: null,
  status: 'ACTIVE',
  end_reason: null,
  version: 1,
  ...overrides,
});

export const member = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid('0060', n),
  membership_id: uuid('0050', 100 + n),
  display_name: `Thành viên ${n}`,
  role: 'MEMBER',
  project: { id: PROJECT, code: line(1).code, name: line(1).name },
  valid_from: '2026-02-01',
  valid_until: null,
  ...overrides,
});

export const force = (n: number, members: unknown[], overrides: Record<string, unknown> = {}) => ({
  id: uuid('0070', n),
  code: `TF-0${n}`,
  name: `Tổ công tác ${n}`,
  purpose: 'Đôn đốc giải ngân các dự án chậm',
  lead: { membership_id: uuid('0050', 200), display_name: 'Nguyễn Văn An' },
  scope_unit: { id: uuid('0001', 2), code: 'U2', name: 'Sở Giao thông' },
  establishment_document_id: null,
  valid_from: '2026-01-05',
  valid_until: null,
  status: 'ACTIVE',
  version: 1,
  members,
  ...overrides,
});

export const handover = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid('0080', n),
  handover_no: `BG-0${n}`,
  handover_kind: 'COMPLETION',
  status: 'INSPECTING',
  contract: { id: uuid('0090', n), code: `HD-0${n}`, status: 'ACTIVE' },
  project_id: PROJECT,
  recipient_unit: { id: uuid('0001', 3), code: 'U3', name: 'Ban quản lý vận hành' },
  quality_acceptance_id: null,
  planned_on: '2026-09-01',
  handed_on: null,
  accepted_at: null,
  accepted_by: null,
  rejection_reason: null,
  decision_note: null,
  open_critical_punch_count: 0,
  punch_item_count: 0,
  document_version_id: null,
  as_built_document_version_id: null,
  om_manual_document_version_id: null,
  warranty_certificate_document_version_id: null,
  created_at: '2026-08-01T01:00:00.000000Z',
  allowed: { add_item: false, approve: false, return: false, reject: false },
  version: 1,
  ...overrides,
});

export const asset = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid('0100', n),
  asset_code: `TS-0${n}`,
  name: `Tài sản ${n}`,
  value_vnd: '2500000000',
  status: 'REGISTERED',
  ...overrides,
});

export const trace = (target: ReturnType<typeof handover>, overrides: Record<string, unknown> = {}) => ({
  handover: target,
  items: [],
  assets: [asset(1)],
  documents: [{ role: 'MINUTES', document_version_id: uuid('0110', 1) }],
  quality_acceptance: null,
  ...overrides,
});

export const settlement = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid('0120', n),
  project: { id: PROJECT, code: line(1).code, name: line(1).name },
  contract: null,
  settlement_scope: 'PROJECT',
  fiscal_year: null,
  revision: n,
  status: 'VERIFIED',
  settled_amount_vnd: '480000000000',
  outstanding_vnd: '0',
  unrecovered_advance_vnd: '0',
  figures_refreshed_at: '2026-10-01T01:00:00.000Z',
  figures_note: null,
  project_group: 'B',
  submitted_on: '2026-10-02',
  submitted_by: null,
  submitted_at: null,
  verification_due_on: '2026-12-01',
  deadline_days: 60,
  verified_on: null,
  verification_findings: null,
  audit_finding_refs: null,
  exception_reason: null,
  exception_approved_by: null,
  exception_approved_at: null,
  decision_document_version_id: null,
  closed_by: null,
  closed_at: null,
  close_reason: null,
  supersedes_id: null,
  created_at: '2026-10-01T01:00:00.000Z',
  actions: { refresh: false, submit: false, take_up: false, verify: false, return: false, approve_exception: false, close: false },
  version: 1,
  ...overrides,
});

export interface Served {
  assignments?: unknown[];
  forces?: unknown[];
  handovers?: unknown[];
  settlements?: unknown[];
  /** The answer of the read of one trace, or the error to fail with. */
  trace?: unknown;
  /** Reads that fail, by operation. */
  failing?: Record<string, Error>;
  /** Reads that never answer. */
  pending?: string[];
}

/** A client over the world of PRJ whose reads of the closing are answered from `served`. */
export function open(served: Served, projects: Array<Record<string, unknown>> = [line(1, { status: 'COMPLETED' }), line(2)]): Harness {
  const h = client(world({ projects }));
  const base = (h.client as unknown as { readAll: (operation: string, input?: unknown) => Promise<unknown[]> }).readAll;
  const answers: Record<string, unknown[] | undefined> = {
    get_resources_project_accountability: served.assignments,
    get_resources_task_force: served.forces,
    get_resources_handover: served.handovers,
    get_resources_settlement_revision: served.settlements,
  };
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string, input?: unknown) => {
    const failure = served.failing?.[operation];
    if (failure !== undefined) return Promise.reject(failure);
    if (served.pending?.includes(operation) === true) return new Promise<unknown[]>(() => undefined);
    const rows = answers[operation];
    return rows === undefined ? base(operation, input) : Promise.resolve(rows);
  });
  const previous = h.read.getMockImplementation();
  h.read.mockImplementation((operation: string, input?: unknown) => {
    if (operation === 'getHandoverTrace') return served.trace instanceof Error ? Promise.reject(served.trace) : Promise.resolve(served.trace);
    return previous === undefined ? Promise.reject(new Error(`unexpected read ${operation}`)) : previous(operation, input);
  });
  return h;
}

/** The reads of the closing that were asked of the client, by operation. */
export const asked = (h: Harness, operation: string): unknown[][] => (h.client.readAll as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(([name]) => name === operation);
