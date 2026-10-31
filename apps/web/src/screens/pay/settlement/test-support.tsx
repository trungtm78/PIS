import { ApiError } from '@machvon/api-client';
import { vi } from 'vitest';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import { PROJECT, mount } from '../payment/test-support';
import { routeOf as baseRoute } from '../payment/test-support';

export { PROJECT, mount };
export type { Harness };

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const settlementId = (n: number): string => uuid('0150', n);
export const documentId = (n: number): string => uuid('0e60', n);
export const contractOf = (n: number): string => uuid('0010', n);

export const routeOf = (id: string, req: string) => baseRoute(id, 'PAY', req);

/** The settlement officer who opens, reads again, sends and takes up; the chief who approves the exception; the leader who closes; a reader. */
export const OFFICER = ['settlement_revision.read', 'settlement.open', 'settlement.submit', 'settlement.verify', 'project.read'];
export const CHIEF = ['settlement_revision.read', 'settlement.exception.approve'];
export const LEADER = ['settlement_revision.read', 'settlement.close'];
export const AUDITOR = ['settlement_revision.read', 'aud.read', 'settlement.verify'];
export const READER = ['settlement_revision.read'];

export const noActions = { refresh: false, submit: false, take_up: false, verify: false, return: false, approve_exception: false, close: false };

export const actions = (overrides: Record<string, boolean> = {}) => ({ ...noActions, ...overrides });

/** A settlement of the example (project B, 150m owed, nothing unrecovered): a draft by default. */
export const settlement = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: settlementId(n),
  project: { id: PROJECT, code: 'DA-001', name: 'Cầu qua sông' },
  contract: null,
  settlement_scope: 'PROJECT',
  fiscal_year: null,
  revision: 1,
  status: 'DRAFT',
  settled_amount_vnd: '9850000000',
  outstanding_vnd: '150000000',
  unrecovered_advance_vnd: '0',
  figures_refreshed_at: '2026-10-20T03:00:00.000000Z',
  figures_note: null,
  project_group: null,
  submitted_on: null,
  submitted_by: null,
  submitted_at: null,
  verification_due_on: null,
  deadline_days: null,
  deadline_rule_version_id: null,
  deadline_rule_awaiting_confirmation: null,
  verified_on: null,
  verified_by: null,
  verified_at: null,
  verification_findings: null,
  audit_finding_refs: null,
  exception_reason: null,
  exception_approved_by: null,
  exception_approved_at: null,
  exception_approval_document_version_id: null,
  decision_document_version_id: null,
  closed_by: null,
  closed_at: null,
  close_reason: null,
  close_evidence_ids: [],
  supersedes_id: null,
  created_by: uuid('0030', 1),
  created_at: `2026-10-2${n}T03:00:00.000000Z`,
  updated_at: `2026-10-2${n}T03:00:00.000000Z`,
  actions: actions({ refresh: true, submit: true }),
  version: 1,
  ...overrides,
});

/** A settlement that was sent on 1 October: group B, 180 days, so the last day is 30 March 2027. */
export const sent = (n: number, overrides: Record<string, unknown> = {}) =>
  settlement(n, {
    status: 'SUBMITTED',
    project_group: 'B',
    submitted_on: '2026-10-01',
    submitted_by: uuid('0030', 2),
    submitted_at: '2026-10-01T03:00:00.000000Z',
    verification_due_on: '2027-03-30',
    deadline_days: 180,
    deadline_rule_version_id: uuid('0160', 1),
    deadline_rule_awaiting_confirmation: true,
    actions: actions({ take_up: true, return: true }),
    version: 2,
    ...overrides,
  });

export const answer = (overrides: Record<string, unknown> = {}) => ({ operation_id: uuid('0e50', 1), status: 'SUBMITTED', resource_version: 2, resource_id: settlementId(1), ...overrides });

/** A form of a settlement as the read answers it. */
export const formRecord = (n: number, code: string, overrides: Record<string, unknown> = {}) => ({
  id: uuid('0e70', n),
  settlement_id: settlementId(1),
  form_code: code,
  status: 'GENERATED',
  template_code: `PAY-QT-${code.replace(/\W/g, '')}`,
  template_revision: 1,
  legal_basis: 'Thông tư 96/2021/TT-BTC',
  document_id: uuid('0e80', n),
  document_version_id: uuid('0e90', n),
  file_sha256: 'a'.repeat(64),
  payload_sha256: 'b'.repeat(64),
  generated_at: '2026-10-26T05:00:00.000Z',
  generated_by: uuid('0030', 1),
  ...overrides,
});

export interface World {
  settlements: Array<Record<string, unknown>>;
  /** What the list read answers when it is not all of the settlements (the pages it read do not reach the others). */
  listed?: Array<Record<string, unknown>>;
  /** The forms of the settlements, by settlement. */
  forms: Map<string, Array<Record<string, unknown>>>;
  projects: Array<Record<string, unknown>>;
  failing: Set<string>;
}

export function world(overrides: Partial<World> = {}): World {
  return { settlements: [settlement(1)], forms: new Map(), projects: [{ id: PROJECT, code: 'DA-001', name: 'Cầu qua sông' }], failing: new Set(), ...overrides };
}

/** A client over `state`: the settlements are answered from it (filtered by the status asked for), and `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => answer()): Harness {
  const h = baseHarness((operation, input) => {
    if (state.failing.has(operation)) return new Error(`${operation} failed`);
    const asked = input as { path?: { id?: string }; query?: { status?: string } } | undefined;
    if (operation === 'get_resources_settlement_revision') {
      const status = asked?.query?.status;
      return { items: state.settlements.filter((item) => status === undefined || item.status === status), next_cursor: null, as_of: '2026-10-26T05:00:00.000Z' };
    }
    if (operation === 'get_resources_settlement_revision_id') {
      return state.settlements.find((item) => item.id === asked?.path?.id) ?? new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c', extensions: {} });
    }
    if (operation === 'listSettlementForms') {
      const forms = state.forms.get(asked?.path?.id ?? '');
      return forms === undefined ? new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c', extensions: {} }) : { items: forms };
    }
    return new Error(`unexpected read ${operation}`);
  }, command);
  (h.client as unknown as { readAll: (operation: string, input?: unknown) => Promise<unknown[]> }).readAll = vi.fn((operation: string) => {
    if (state.failing.has(operation)) return Promise.reject(new Error(`${operation} failed`));
    if (operation === 'get_resources_settlement_revision') return Promise.resolve(state.listed ?? state.settlements);
    return operation === 'get_resources_project' ? Promise.resolve(state.projects) : Promise.reject(new Error(`unexpected readAll ${operation}`));
  });
  return h;
}

export const commandsOf = (h: Harness, operation: string): Array<{ path?: { id?: string }; body: Record<string, unknown>; ifMatchVersion?: number }> =>
  h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { path?: { id?: string }; body: Record<string, unknown>; ifMatchVersion?: number });
