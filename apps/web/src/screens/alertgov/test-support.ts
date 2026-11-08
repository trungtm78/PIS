import { vi } from 'vitest';
import type { WebRoute } from '../../routes/types';
import { harness as baseHarness } from '../sas/test-support';
import type { Harness } from '../sas/test-support';
import { TENANT } from '../bid/test-support';

export { mount } from '../bid/test-support';
export type { Harness };

export const ME = TENANT.membershipId;
export const OTHER = '00000000-0000-4000-8000-0000000000b2';
export const DEPUTY = '00000000-0000-4000-8000-0000000000b3';
export const UNIT = '00000000-0000-4000-8000-0000000000c1';
export const AS_OF = '2027-10-15T03:00:00.000Z';
export const READER = ['home.read'];
export const HEALTH_READER = ['home.read', 'home.alert.health.read'];
export const MANAGER = ['home.read', 'home.alert.health.read', 'home.alert.cover.manage'];

export const route = (id: string, req: string, module: string): WebRoute => ({ id, path: `/${module.toLowerCase()}/${id.toLowerCase()}`, title: id, kind: 'list', area: 'overview', module, group: 'Group', role: 'workspace', parent: null, req });

export const rule = (over: Record<string, unknown> = {}) => ({
  code: 'DEFAULT',
  version: 'builtin',
  unverified: true,
  formula: 'How the numbers are read.',
  source: 'Research of the roadmap.',
  as_of: '2026-11-08',
  params: {},
  ...over,
});

export const CODES = ['MTTA', 'MTTR', 'ON_TIME', 'ESCALATED', 'LAST_LEVEL', 'ALERTS_PER_PERSON', 'PUSH_PER_PERSON', 'OFF_HOURS', 'STALE', 'TOP10_SHARE', 'SNOOZE_RATE', 'ORPHAN', 'URGENT_DELIVERY', 'DELEGATION_COVERAGE'];

export const kpi = (code: string, over: Record<string, unknown> = {}) => ({
  code,
  value: 12.5,
  unit: code === 'MTTA' || code === 'MTTR' ? 'HOURS' : code === 'ALERTS_PER_PERSON' || code === 'PUSH_PER_PERSON' || code === 'OFF_HOURS' || code === 'ORPHAN' ? 'COUNT' : 'PERCENT',
  direction: 'MAX',
  target: 20,
  status: 'OK',
  sample: 40,
  low_sample: false,
  parts: [],
  formula: `Formula of ${code}.`,
  source: `Source of ${code}.`,
  note: null,
  ...over,
});

export function healthDto(over: Record<string, unknown> = {}) {
  const special: Record<string, Record<string, unknown>> = {
    MTTA: { value: 2.5, target: 4, status: 'OK', parts: [{ key: 'URGENT', value: 2.5, sample: 2, status: 'OK', target: 4 }, { key: 'ACTION', value: 16, sample: 1, status: 'BREACH', target: 8 }], low_sample: true, sample: 3 },
    ESCALATED: { value: 50, target: 20, status: 'BREACH' },
    STALE: { value: 10, parts: [{ key: 'OVER_7_DAYS', value: 3, sample: 30, status: 'NO_DATA', target: null }] },
    MTTR: { value: null, status: 'NO_DATA', sample: 0, note: 'NO_RECORDS', target: null },
    URGENT_DELIVERY: { value: null, status: 'NO_SOURCE', sample: 0, note: 'NO_DELIVERY_RECEIPTS', direction: 'MIN', target: 99 },
    ORPHAN: { value: 0, status: 'OK', target: 0 },
  };
  return {
    from: '2027-09-17T03:00:00.000Z',
    to: AS_OF,
    as_of: AS_OF,
    stale: false,
    last_pass_at: '2027-10-15T02:50:00.000Z',
    kpis: CODES.map((code) => kpi(code, special[code] ?? {})),
    top_types: [
      { type_code: 'CLOCK', count: 12, share_pct: 60, snoozed: 6, snooze_rate_pct: 50 },
      { type_code: 'ISSUE_SLA_BREACH', count: 3, share_pct: 15, snoozed: 0, snooze_rate_pct: null },
    ],
    stale_by_unit: [{ unit_id: UNIT, unit_name: 'North unit', count: 4 }],
    items: { in_window: 20, open: 9 },
    positions: [
      { key: 'LEADER@u1', role_code: 'LEADER', unit_id: UNIT, unit_name: 'North unit', holders: 1, present: 1, state: 'SINGLE_POINT' },
      { key: 'LEADER@u2', role_code: 'LEADER', unit_id: '00000000-0000-4000-8000-0000000000c2', unit_name: 'South unit', holders: 2, present: 2, state: 'PEER_BACKED' },
    ],
    rule: rule({ code: 'DEFAULT', params: {} }),
    ...over,
  };
}

const person = (id: string, name: string) => ({ id, name });

export const escalationRow = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  source: 'CLOCK',
  source_id: 'clock-1',
  level: 1,
  kind: 'HIERARCHICAL',
  trigger: 'NOT_CLAIMED',
  recipient: person(ME, 'Tran Van Me'),
  owner: person(OTHER, 'Le Thi Other'),
  routed_via: 'PRIMARY',
  cover_id: null,
  severity: 'URGENT',
  from_severity: null,
  item_title: 'Post the invitation to bid',
  item_subtitle: 'Package 05',
  item_due_on: null,
  target: { screen: 'BID-02', id: 'pkg-5' },
  reached_at: '2027-10-15T02:00:00.000Z',
  status: 'OPEN',
  acknowledged_at: null,
  closed_at: null,
  close_reason: null,
  policy_version: 'builtin',
  ...over,
});

export const ESCALATION_ID = '00000000-0000-4000-8000-00000000e001';

export const policyParams = () => ({
  steps: {
    URGENT: [
      { kind: 'HIERARCHICAL', after_working_hours: 0, levels_up: 1 },
      { kind: 'FUNCTIONAL', after_working_hours: 4, function_role: 'AUDITOR' },
    ],
    ACTION: [{ kind: 'HIERARCHICAL', after_working_hours: 0, levels_up: 1 }],
    WATCH: [],
  },
  triggers: ['NOT_CLAIMED', 'NO_PROGRESS', 'OVERDUE'],
  hold_after_acknowledge_working_hours: { URGENT: 8, ACTION: 24, WATCH: 40 },
  watch_promotion: { enabled: true, after_working_days: 20 },
});

export const profileDto = (over: Record<string, unknown> = {}) => ({
  profile: { channels: null, quiet: null, digest_enabled: true, digest_at: null, push_min_severity: null, push_cap_per_day: null, group_same_root: null },
  effective: {
    channels: { URGENT: ['IN_APP', 'PUSH'], ACTION: ['IN_APP', 'PUSH'], WATCH: ['IN_APP'] },
    quiet: { from: '21:00', to: '06:30', weekends: true, time_zone: 'Asia/Ho_Chi_Minh' },
    digest_enabled: true,
    digest_at: '07:30',
    push_min_severity: 'ACTION',
    push_cap_per_day: 5,
    group_same_root: true,
    own: { channels: false, quiet: false, digest_at: false, push_min_severity: false, push_cap_per_day: false, group_same_root: false },
  },
  own_quiet: null,
  rule: rule({ params: { quiet_from: '21:00', quiet_to: '06:30', push_cap_per_day: 5, digest_at: '07:30', urgent_group_after_per_hour: 3 } }),
  version: 0,
  as_of: AS_OF,
  ...over,
});

export const digestDto = (over: Record<string, unknown> = {}) => ({
  sections: [
    { code: 'OVERDUE', count: 1, lines: [{ source: 'CLOCK', id: 'c1', title: 'Post the invitation to bid', subtitle: null, severity: 'URGENT', due_on: '2027-10-14', consequence: 'The package cannot open the bidding.', action: { screen: 'BID-02', id: 'pkg-5' }, on_behalf_of: null }] },
    { code: 'DUE_SOON', count: 0, lines: [] },
    { code: 'NEW', count: 0, lines: [] },
    { code: 'ON_BEHALF', count: 1, lines: [{ source: 'ISSUE', id: 'i1', title: 'Late issue', subtitle: null, severity: 'ACTION', due_on: null, consequence: null, action: { screen: 'ISS-09', id: 'i1' }, on_behalf_of: 'Le Thi Other' }] },
  ],
  total: 2,
  omitted: 0,
  digest_at: '07:30',
  last_digest_at: null,
  unavailable_sources: [],
  as_of: AS_OF,
  ...over,
});

export const COVER_ID = '00000000-0000-4000-8000-00000000c001';
export const ABSENCE_ID = '00000000-0000-4000-8000-00000000a001';

export const coverRow = (over: Record<string, unknown> = {}) => ({
  id: COVER_ID,
  absence_id: ABSENCE_ID,
  absent: person(ME, 'Tran Van Me'),
  deputy: person(DEPUTY, 'Pham Deputy'),
  valid_from: '2027-10-15T03:00:00.000Z',
  valid_until: '2027-10-20T03:00:00.000Z',
  scope_kind: 'ALL',
  sources: [],
  status: 'PENDING',
  in_force: false,
  requested_by: ME,
  decided_by: null,
  decided_at: null,
  decision_note: null,
  revoke_reason: null,
  version: 1,
  ...over,
});

export const absenceRow = (over: Record<string, unknown> = {}) => ({
  id: ABSENCE_ID,
  membership_id: ME,
  name: 'Tran Van Me',
  kind: 'LEAVE',
  valid_from: '2027-10-15T03:00:00.000Z',
  valid_until: '2027-10-20T03:00:00.000Z',
  effective_until: '2027-10-20T03:00:00.000Z',
  reason: 'Annual leave',
  status: 'DECLARED',
  phase: 'ACTIVE',
  coverage: 'UNCOVERED',
  covers: [],
  version: 1,
  ...over,
});

export const coverageDto = (over: Record<string, unknown> = {}) => ({
  positions: [
    { key: 'LEADER@u1', role_code: 'LEADER', unit_id: UNIT, unit_name: 'North unit', holders: 1, present: 1, state: 'SINGLE_POINT' },
    { key: 'LEADER@u3', role_code: 'LEADER', unit_id: '00000000-0000-4000-8000-0000000000c3', unit_name: 'East unit', holders: 1, present: 0, state: 'UNCOVERED' },
  ],
  summary: { backed_up: 0, total: 2, percent: 0 },
  gaps: [{ id: 'g1', kind: 'ABSENT_NO_COVER', membership_id: OTHER, name: 'Le Thi Other', unit_id: UNIT, absence_id: ABSENCE_ID, item_count: 3, opened_at: '2027-10-14T10:00:00.000Z', closed_at: null, close_reason: null }],
  rule: rule({ code: 'DEFAULT' }),
  as_of: AS_OF,
  ...over,
});

export interface World {
  health: unknown;
  escalations: unknown;
  profile: unknown;
  digest: unknown;
  mine: unknown;
  managed: unknown;
  coverage: unknown;
  members: unknown[];
  failing: Map<string, { error: Error; times: number }>;
}

export function world(over: Partial<World> = {}): World {
  return {
    health: healthDto(),
    escalations: { items: [escalationRow(ESCALATION_ID)], rule: rule({ params: policyParams() }), as_of: AS_OF },
    profile: profileDto(),
    digest: digestDto(),
    mine: { items: [absenceRow()], pending_covers: [], rule: rule({ params: {} }), as_of: AS_OF },
    managed: { items: [absenceRow({ id: '00000000-0000-4000-8000-00000000a002', membership_id: OTHER, name: 'Le Thi Other' })], pending_covers: [coverRow()], rule: rule({ params: {} }), as_of: AS_OF },
    coverage: coverageDto(),
    members: [
      { id: DEPUTY, user_id: 'u3', display_name: 'Pham Deputy', status: 'Active' },
      { id: OTHER, user_id: 'u2', display_name: 'Le Thi Other', status: 'Active' },
    ],
    failing: new Map(),
    ...over,
  };
}

export const failing = (operation: string, error: Error): Map<string, { error: Error; times: number }> => new Map([[operation, { error, times: Infinity }]]);

export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({ operation_id: 'o', status: 'OK', resource_version: 2 })): Harness {
  const h = baseHarness((operation, input) => {
    const refusal = state.failing.get(operation);
    if (refusal !== undefined && refusal.times > 0) {
      refusal.times -= 1;
      return refusal.error;
    }
    const query = (input as { query?: Record<string, unknown> } | undefined)?.query ?? {};
    switch (operation) {
      case 'getAlertHealth':
        return state.health;
      case 'listAlertEscalations':
        return state.escalations;
      case 'getMyAlertProfile':
        return state.profile;
      case 'getMyAlertDigest':
        return state.digest;
      case 'listAlertAbsences':
        return query.mine === 'false' ? state.managed : state.mine;
      case 'getAlertCoverageReport':
        return state.coverage;
      default:
        return new Error(`unexpected read ${operation}`);
    }
  }, command);
  // The list of members is read in pages by `readAll`.
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => Promise.resolve(operation === 'get_resources_membership' ? state.members : []));
  return h;
}
