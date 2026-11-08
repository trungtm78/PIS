import { vi } from 'vitest';
import vi_ from '../../../../i18n/vi.json';
import { harness as baseHarness, mount, routeOf as sasRoute } from '../../../sas/test-support';
import type { Harness } from '../../../sas/test-support';

export { mount };
export type { Harness };

const catalogue = vi_ as Record<string, string>;
/** The Vietnamese text of a key as the screen shows it (parameters filled), so a test compares with the catalogue and never with a copy of its words. */
export const text = (key: string, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce((message, [name, value]) => message.replaceAll(`{${name}}`, String(value)), catalogue[key] ?? `MISSING ${key}`);

export const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const CONTRACT = uuid(10);
export const OTHER_CONTRACT = uuid(11);
export const CLAIM = uuid(20);
export const TERM = uuid(30);
export const WARNING = uuid(40);
export const MEMBER = uuid(50);

export const routeOf = (id: string) => ({ ...sasRoute(id, `FR-${id}`), path: `/ctr/${id.toLowerCase()}`, module: 'CTR', area: 'investment' as const });

export const MANAGER = ['claim.read', 'claim.manage', 'claim.settle', 'claim.bar', 'claim.term.propose', 'claim.term.approve'];
export const READER = ['claim.read'];
export const WARNER = ['early_warning.read', 'early_warning.raise', 'early_warning.manage', 'early_warning.close'];
export const WARNING_READER = ['early_warning.read'];

export const rule = (overrides: Record<string, unknown> = {}) => ({ source: 'DEFAULT', version: 0, unverified: true, formula: null, source_text: null, as_of: '2026-11-08', legal_status: 'UNVERIFIED', ...overrides });

export const limitation = (overrides: Record<string, unknown> = {}) => ({ status: 'RUNNING', due_on: '2026-12-01', code: 'NOTICE', days_left: 23, bar_effect: 'BARS_CLAIM', missed: [], ...overrides });

export const line = (overrides: Record<string, unknown> = {}) => ({
  id: CLAIM,
  code: 'CLM-001',
  contract: { id: CONTRACT, code: 'HD-001' },
  project_code: 'DA-01',
  claimant_side: 'CONTRACTOR',
  kind: 'EXTENSION_OF_TIME',
  title: 'Late handover of the site',
  status: 'EVENT_RECORDED',
  awareness_on: '2026-11-03',
  claimed_amount_vnd: '500000000',
  claimed_days: 20,
  settled_amount_vnd: null,
  granted_days: null,
  has_term: true,
  limitation: limitation(),
  open: true,
  responsible_name: 'Nguyen Van A',
  version: 1,
  ...overrides,
});

const zero = (keys: string[]) => Object.fromEntries(keys.map((key) => [key, 0]));
export const totals = (overrides: Record<string, unknown> = {}) => ({
  count: 2,
  open: 2,
  by_status: zero(['EVENT_RECORDED', 'NOTICE_SERVED', 'PARTICULARS_SUBMITTED', 'RESPONDED', 'SETTLEMENT_PROPOSED', 'SETTLED', 'WITHDRAWN', 'REFERRED', 'TIME_BARRED']),
  by_side: zero(['CONTRACTOR', 'OWNER']),
  by_limitation: zero(['NO_TERM', 'NOT_DEFINED', 'CALENDAR_UNAVAILABLE', 'RUNNING', 'APPROACHING', 'MISSED', 'MET', 'MET_LATE', 'BARRED', 'CLOSED']),
  claimed_vnd: '1200000000',
  settled_vnd: '0',
  open_claimed_vnd: '1200000000',
  claimed_days: 30,
  granted_days: 0,
  without_term: 1,
  ...overrides,
});

export const page = (overrides: Record<string, unknown> = {}) => ({
  items: [line(), line({ id: uuid(21), code: 'CLM-002', title: 'Design change of the foundation', has_term: false, limitation: limitation({ status: 'NO_TERM', due_on: null, code: null, days_left: null, bar_effect: null }), claimed_amount_vnd: '700000000', claimed_days: null })],
  next_cursor: null,
  totals: totals(),
  truncated: false,
  calendar_published: true,
  policy: rule(),
  as_of: '2026-11-08',
  ...overrides,
});

export const deadline = (code: string, overrides: Record<string, unknown> = {}) => ({
  code,
  state: 'RUNNING',
  started_on: '2026-11-03',
  due_on: '2026-12-01',
  done_on: null,
  days_left: 23,
  period_days: 28,
  basis: 'CALENDAR_DAYS',
  owed_by: code === 'RESPONSE' ? 'RECEIVER' : code === 'SETTLEMENT' ? 'BOTH' : 'CLAIMANT',
  owed_by_owner: code === 'RESPONSE' || code === 'SETTLEMENT',
  ...overrides,
});

export const term = (overrides: Record<string, unknown> = {}) => ({
  id: TERM,
  contract_id: CONTRACT,
  claimant_side: 'CONTRACTOR',
  notice_days: 28,
  particulars_days: 42,
  response_days: 14,
  settlement_days: 30,
  basis: 'CALENDAR_DAYS',
  particulars_from: 'NOTICE',
  bar_effect: 'BARS_CLAIM',
  clause_reference: 'Clause 20.1 of the contract',
  basis_document_version_id: null,
  template_code: null,
  status: 'APPROVED',
  decision_note: null,
  proposed_by_name: 'Le Thi B',
  proposed_at: '2026-11-01T03:00:00.000Z',
  decided_by_name: 'Tran Van C',
  decided_at: '2026-11-02T03:00:00.000Z',
  superseded_by_id: null,
  can_decide: false,
  version: 2,
  ...overrides,
});

export const step = (n: number, kind: string, overrides: Record<string, unknown> = {}) => ({
  id: uuid(60 + n),
  ordinal: n,
  kind,
  occurred_on: '2026-11-03',
  note: 'Step note of the claim',
  decision: null,
  claimed_amount_vnd: null,
  claimed_days: null,
  settled_amount_vnd: null,
  granted_days: null,
  evidence_document_version_id: null,
  actor_name: 'Nguyen Van A',
  created_at: '2026-11-03T04:00:00.000Z',
  ...overrides,
});

export const claim = (overrides: Record<string, unknown> = {}) => ({
  id: CLAIM,
  code: 'CLM-001',
  contract: { id: CONTRACT, code: 'HD-001' },
  project_code: 'DA-01',
  claimant_side: 'CONTRACTOR',
  kind: 'EXTENSION_OF_TIME',
  title: 'Late handover of the site',
  event_description: 'The site was handed over twenty days late.',
  event_on: '2026-11-01',
  awareness_on: '2026-11-03',
  status: 'EVENT_RECORDED',
  claimed_amount_vnd: '500000000',
  claimed_days: 20,
  settled_amount_vnd: null,
  granted_days: null,
  notice_on: null,
  particulars_on: null,
  response_on: null,
  response_decision: null,
  settled_on: null,
  closed_on: null,
  responsible_name: 'Nguyen Van A',
  registered_by_name: 'Nguyen Van A',
  settlement_proposed_by_name: null,
  settlement_approved_by_name: null,
  term: term(),
  deadlines: {
    NOTICE: deadline('NOTICE'),
    PARTICULARS: deadline('PARTICULARS', { state: 'NOT_STARTED', started_on: null, due_on: null, days_left: null, period_days: 42 }),
    RESPONSE: deadline('RESPONSE', { state: 'NOT_STARTED', started_on: null, due_on: null, days_left: null, period_days: 14 }),
    SETTLEMENT: deadline('SETTLEMENT', { state: 'NOT_STARTED', started_on: null, due_on: null, days_left: null, period_days: 30 }),
  },
  limitation: limitation(),
  change_request: null,
  payment_request: null,
  steps: [step(1, 'EVENT', { note: 'The site was handed over twenty days late.' })],
  allowed: { steps: ['NOTICE', 'WITHDRAWAL'], decide_settlement: false, declare_bar: false, link: true },
  calendar_published: true,
  policy: rule(),
  as_of: '2026-11-08',
  version: 1,
  ...overrides,
});

export const termList = (overrides: Record<string, unknown> = {}) => ({
  items: [term()],
  templates: [
    { code: 'FIDIC_2017_EXAMPLE', notice_days: 28, particulars_days: 84, response_days: 42, settlement_days: null, basis: 'CALENDAR_DAYS', particulars_from: 'AWARENESS', bar_effect: 'BARS_CLAIM', rule: rule({ formula: 'Example formula', source_text: 'Example source' }) },
  ],
  contract: { id: CONTRACT, code: 'HD-001' },
  can_propose: true,
  as_of: '2026-11-08',
  ...overrides,
});

export const contractRaw = (id: string, code: string) => ({
  id,
  code,
  title: code,
  status: 'ACTIVE',
  type: 'LUMP_SUM',
  project_id: uuid(1),
  project_code: 'DA-01',
  project_name: 'Project',
  package_id: uuid(2),
  contractor_id: uuid(3),
  contractor_name: 'Contractor',
  is_joint_venture: false,
  contract_value_vnd: '1000000000',
  completion_due: '2027-12-31',
  version: 1,
});

export interface World {
  /** What each read answers: a value, or a function of the input; an Error is a failed read. */
  answers: Record<string, unknown>;
  failing: Set<string>;
}

type Answer = unknown | ((input: unknown) => unknown);

export function client(answers: Record<string, Answer>, command: (operation: string, input: unknown) => unknown = () => ({ operation_id: uuid(7), status: 'OK', resource_version: 2, resource_id: CLAIM })): Harness {
  const h = baseHarness((operation, input) => {
    if (!(operation in answers)) return new Error(`unexpected read ${operation}`);
    const answer = answers[operation];
    return typeof answer === 'function' ? (answer as (input: unknown) => unknown)(input) : answer;
  }, command);
  (h.client as unknown as { readAll: (operation: string) => Promise<unknown[]> }).readAll = vi.fn((operation: string) => {
    if (operation === 'get_resources_contract') return Promise.resolve([contractRaw(CONTRACT, 'HD-001'), contractRaw(OTHER_CONTRACT, 'HD-002')]);
    if (operation === 'get_resources_membership') return Promise.resolve([{ id: MEMBER, display_name: 'Pham Van D' }]);
    return Promise.reject(new Error(`unexpected readAll ${operation}`));
  });
  return h;
}

export const commandsOf = (h: Harness, operation: string): Array<{ path?: { id?: string }; body: Record<string, unknown>; ifMatchVersion?: number }> =>
  h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { path?: { id?: string }; body: Record<string, unknown>; ifMatchVersion?: number });

export const readsOf = (h: Harness, operation: string): Array<{ path?: { id?: string }; query?: Record<string, unknown> }> =>
  h.read.mock.calls.filter((call) => call[0] === operation).map((call) => (call[1] ?? {}) as { path?: { id?: string }; query?: Record<string, unknown> });
