import { CONTRACT, MEMBER, WARNING, rule, uuid } from '../../claims/test/support';

export * from '../../claims/test/support';

export const line = (overrides: Record<string, unknown> = {}) => ({
  id: WARNING,
  code: 'EW-001',
  contract: { id: CONTRACT, code: 'HD-001' },
  title: 'The crane may arrive late',
  category: 'TIME',
  raised_by_party: 'CONTRACTOR',
  raised_on: '2026-11-05',
  status: 'MITIGATING',
  likelihood: 'HIGH',
  owner_name: 'Pham Van D',
  expected_time_days: 14,
  expected_cost_vnd: '250000000',
  no_impact_expected: false,
  open_actions: 1,
  overdue_actions: 0,
  version: 3,
  ...overrides,
});

const zero = (keys: string[]) => Object.fromEntries(keys.map((key) => [key, 0]));
export const summary = (overrides: Record<string, unknown> = {}) => ({
  total: 2,
  open: 2,
  by_status: zero(['RAISED', 'ASSESSED', 'MITIGATING', 'CLOSED_RESOLVED', 'CLOSED_MATERIALISED', 'CLOSED_WITHDRAWN']),
  by_category: zero(['TIME', 'COST', 'QUALITY', 'SAFETY', 'SCOPE', 'LEGAL', 'ENVIRONMENT', 'OTHER']),
  by_party: zero(['OWNER', 'CONTRACTOR', 'SUPERVISOR', 'DESIGNER', 'OTHER']),
  without_owner: 1,
  unassessed: 1,
  exposure_cost_vnd: '250000000',
  exposure_time_days: 14,
  impact_unknown: 1,
  overdue_actions: 1,
  ...overrides,
});

export const page = (overrides: Record<string, unknown> = {}) => ({
  items: [line(), line({ id: uuid(41), code: 'EW-002', title: 'The rebar delivery is below grade', category: 'QUALITY', status: 'RAISED', likelihood: null, owner_name: null, expected_time_days: null, expected_cost_vnd: null, open_actions: 0, version: 1 })],
  next_cursor: null,
  summary: summary(),
  truncated: false,
  as_of: '2026-11-08',
  ...overrides,
});

export const clock = (code: string, overrides: Record<string, unknown> = {}) => ({
  code,
  state: 'RUNNING',
  started_on: '2026-11-01',
  due_on: '2026-11-15',
  done_on: null,
  days_left: 7,
  period_days: code === 'MEETING' ? 14 : 7,
  basis: 'CALENDAR_DAYS',
  meeting_id: null,
  ...overrides,
});

export const register = (overrides: Record<string, unknown> = {}) => ({
  contract: { id: CONTRACT, code: 'HD-001', status: 'ACTIVE', effective_from: '2026-11-01' },
  clocks: { initial: clock('INITIAL_ISSUE', { state: 'MISSED', due_on: '2026-11-08', days_left: -1 }), meeting: clock('MEETING'), reissue: null },
  meetings: [],
  issues: [],
  summary: summary(),
  policy: { rule: rule(), initial_issue_within_days: 7, meeting_every_days: 14, reissue_within_days_after_meeting: 7, approach_days: 3, basis: 'CALENDAR_DAYS' },
  calendar_published: true,
  allowed: { raise: true, record_meeting: true, issue_register: true },
  as_of: '2026-11-08',
  ...overrides,
});

export const action = (overrides: Record<string, unknown> = {}) => ({
  id: uuid(70),
  description: 'Order the crane from the second supplier.',
  owner_name: 'Pham Van D',
  owner_membership_id: MEMBER,
  due_on: '2026-11-20',
  status: 'OPEN',
  done_on: null,
  done_by_name: null,
  done_note: null,
  overdue: false,
  version: 1,
  ...overrides,
});

export const warning = (overrides: Record<string, unknown> = {}) => ({
  id: WARNING,
  code: 'EW-001',
  contract: { id: CONTRACT, code: 'HD-001' },
  title: 'The crane may arrive late',
  description: 'The supplier says the crane arrives after the foundation pour.',
  category: 'TIME',
  raised_by_party: 'CONTRACTOR',
  raised_by_name: 'Nguyen Van A',
  raised_on: '2026-11-05',
  status: 'MITIGATING',
  likelihood: 'HIGH',
  owner_name: 'Pham Van D',
  owner_membership_id: MEMBER,
  expected_time_days: 14,
  expected_cost_vnd: '250000000',
  no_impact_expected: false,
  assessed_by_name: 'Nguyen Van A',
  assessed_at: '2026-11-06T03:00:00.000Z',
  closed_by_name: null,
  closed_at: null,
  closed_reason: null,
  change_request_id: null,
  claim_id: null,
  actions: [action()],
  reviews: [],
  allowed: { assess: true, add_action: true, close: true },
  as_of: '2026-11-08',
  version: 3,
  ...overrides,
});
