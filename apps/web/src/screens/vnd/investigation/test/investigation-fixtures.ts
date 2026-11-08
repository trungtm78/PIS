import { AS_OF, policy, uuid } from '../../shared/test/vnd-test-support';

export { ALL, AS_OF, CONTRACTOR, OTHER, READER, client, mount, routeOf, uuid } from '../../shared/test/vnd-test-support';
export type { World } from '../../shared/test/vnd-test-support';

export const AUDITOR = ['vnd.read', 'vnd.lead.read', 'vnd.lead.review', 'vnd.lead.confirm', 'vnd.lead.scan', 'vnd.screening.read', 'vnd.screening.run', 'vnd.screening.decide', 'vnd.screening.import', 'vnd.ocds.export'];
export const LEAD_READER = ['vnd.lead.read'];
export const THIRD = uuid('0001', 3);
export const LEAD = uuid('0100', 1);
export const HIT = uuid('0200', 1);

const invPolicy = (code: string, over: Record<string, unknown> = {}) => policy(code, over);

export const leadLine = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid('0100', n),
  kind: 'LINK_CLUSTER',
  rank: 85,
  status: 'NEW',
  contractor_ids: [uuid('0001', 1), uuid('0001', 2), THIRD],
  contractor_names: ['Công ty nhà thầu 1', 'Công ty nhà thầu 2', 'Công ty nhà thầu 3'],
  package_ids: [uuid('0300', 1)],
  package_codes: ['GT-2026-01'],
  evidence_kinds: ['BANK_ACCOUNT', 'ADDRESS'],
  first_flagged_at: '2026-10-20T02:00:00.000Z',
  last_evaluated_at: '2026-11-07T02:00:00.000Z',
  evaluation_count: 3,
  reviewer_name: null,
  reopened_count: 0,
  version: 2,
  is_conclusion: false,
  ...over,
});

export const leadPage = (items: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) => ({
  items,
  counts: { new: 2, in_review: 1, dismiss_proposed: 0, dismissed: 3, confirmed: 1, referred: 0 },
  next_cursor: null,
  policies: { investigation: invPolicy('VENDOR_INVESTIGATION') },
  as_of: AS_OF,
  ...over,
});

export const indicator = (code: string, over: Record<string, unknown> = {}) => ({ code, name: `Indicator ${code}`, formula: `Formula ${code}`, source: `Source ${code}`, unverified: true, ...over });

export const investigationFigures = (over: Record<string, unknown> = {}) => ({
  leads: { open: 3, new: 2, confirmed: 1, referred: 1, dismissed: 2, precision_pct: 50 },
  last_scan: { id: uuid('0400', 1), finished_at: '2026-11-07T20:00:00.000Z', parties: 40, links: 6, clusters: 2, packages: 12, leads_new: 1 },
  trace: { bids: 20, with_origin: 5, with_files: 8 },
  indicators: [indicator('VENDOR_LEADS_OPEN'), indicator('VENDOR_LEAD_PRECISION')],
  as_of: AS_OF,
  ...over,
});

export const leadLink = (a: number, b: number, over: Record<string, unknown> = {}) => ({
  a_id: uuid('0001', a),
  b_id: uuid('0001', b),
  strength: 95,
  status: 'ACTIVE',
  evidence: [{ kind: 'BANK_ACCOUNT', fingerprint: 'abcdef12', weight: 95 }],
  ...over,
});

export const leadContractor = (n: number, over: Record<string, unknown> = {}) => ({ id: uuid('0001', n), name: `Công ty nhà thầu ${n}`, tax_identifier: `010123456${n}`, restricted: false, ...over });

export const leadDetail = (over: Record<string, unknown> = {}) => ({
  lead: leadLine(1),
  signals: [
    { code: 'COVER_BID', score: 75, package_ids: [uuid('0300', 1)], contractor_ids: [uuid('0001', 1), uuid('0001', 2)], evidence: { close_gap_bp: 30, nearest_far_gap_bp: 2961, bidders: 4 } },
  ],
  contractors: [leadContractor(1), leadContractor(2, { restricted: true }), leadContractor(3)],
  links: [leadLink(1, 2), leadLink(2, 3, { strength: 61, status: 'STALE', evidence: [{ kind: 'ADDRESS', fingerprint: '99999999', weight: 35 }, { kind: 'PHONE', fingerprint: '88888888', weight: 40 }] })],
  history: [
    { id: uuid('0500', 1), move: 'SCAN_NEW', from_status: null, to_status: 'NEW', actor_name: null, reason: null, rank: 85, at: '2026-10-20T02:00:00.000Z' },
    { id: uuid('0500', 2), move: 'TAKE', from_status: 'NEW', to_status: 'IN_REVIEW', actor_name: 'Lê Thị Hoa', reason: null, rank: 85, at: '2026-10-21T02:00:00.000Z' },
  ],
  trace_coverage: { bids: 20, with_origin: 5, with_files: 8 },
  dismiss_proposed_by_name: null,
  dismiss_reason: null,
  confirm_reason: null,
  referral_reason: null,
  policies: { link: invPolicy('VENDOR_LINK_RULE'), rigging: invPolicy('VENDOR_BID_RIGGING'), investigation: invPolicy('VENDOR_INVESTIGATION') },
  may_take: true,
  may_propose_dismissal: false,
  may_confirm_dismissal: false,
  may_reject_dismissal: false,
  may_confirm_signal: false,
  may_refer: false,
  as_of: AS_OF,
  ...over,
});

export const linkGraph = (over: Record<string, unknown> = {}) => ({
  focus_id: uuid('0001', 1),
  nodes: [
    { id: uuid('0001', 1), name: 'Công ty nhà thầu 1', tax_identifier: '0101234561', restricted: false, cluster: 0 },
    { id: uuid('0001', 2), name: 'Công ty nhà thầu 2', tax_identifier: '0101234562', restricted: true, cluster: 0 },
  ],
  links: [leadLink(1, 2)],
  clusters: [{ key: 'a,b', members: [uuid('0001', 1), uuid('0001', 2)], score: 95 }],
  ignored: [{ kind: 'ADDRESS', fingerprint: '55555555', size: 7 }],
  scan_at: '2026-11-07T20:00:00.000Z',
  policy: invPolicy('VENDOR_LINK_RULE'),
  as_of: AS_OF,
  ...over,
});

export const hitLine = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid('0200', n),
  contractor_id: uuid('0001', n),
  contractor_name: `Công ty nhà thầu ${n}`,
  contractor_tax_identifier: `010123456${n}`,
  source: 'NATIONAL_DEBARMENT',
  entry_ref: `RC-${n}`,
  entry_name: `Công ty nhà thầu ${n}`,
  entry_tax_code: `010123456${n}`,
  entry_valid_from: '2026-01-01',
  entry_valid_until: '2027-12-31',
  in_force: true,
  score: 100,
  basis: ['TAX_CODE'],
  similarity: null,
  hold: true,
  status: 'PENDING',
  first_seen_at: '2026-11-05T02:00:00.000Z',
  last_seen_at: '2026-11-07T02:00:00.000Z',
  decided_by_name: null,
  decided_at: null,
  decision_reason: null,
  case_id: null,
  egp_record_id: uuid('0600', n),
  reopened_count: 0,
  clock: 'ON_TIME',
  version: 3,
  ...over,
});

export const run = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid('0700', n),
  trigger_kind: 'NIGHTLY',
  started_at: '2026-11-07T19:00:00.000Z',
  finished_at: '2026-11-07T19:01:00.000Z',
  contractors: 120,
  entries: 40,
  hits_new: 2,
  hits_reopened: 0,
  hits_resolved: 1,
  holds: 1,
  policy_version: 'DEFAULT-1',
  requested_by_name: null,
  ...over,
});

export const overview = (hits: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) => ({
  hits,
  counts: { pending: 2, holds: 1, confirmed: 1, dismissed: 3, resolved: 0, overdue: 1 },
  runs: [run(1)],
  sources: [
    { source: 'NATIONAL_DEBARMENT', entries: 35, as_of: '2026-11-06', reference: 'tệp-quốc-gia-06' },
    { source: 'WORLD_BANK', entries: 0, as_of: null, reference: null },
  ],
  in_time_pct: 80,
  policy: invPolicy('VENDOR_SCREENING', { params: { decide_within_days: 5 } }),
  as_of: AS_OF,
  ...over,
});

export const hitDetail = (n = 1, over: Record<string, unknown> = {}) => ({
  hit: hitLine(n),
  events: [
    { id: uuid('0800', 1), move: 'FOUND', from_status: null, to_status: 'PENDING', actor_name: null, reason: null, score: 100, at: '2026-11-05T02:00:00.000Z' },
  ],
  policy: invPolicy('VENDOR_SCREENING'),
  may_confirm: true,
  may_dismiss: true,
  as_of: AS_OF,
  ...over,
});

const stats = (over: Record<string, unknown> = {}) => ({ total: 4, open: 1, upheld: 1, rejected: 2, withdrawn: 0, upheld_pct: 33, mean_days_to_close: 6.5, ...over });

export const disputes = (over: Record<string, unknown> = {}) => ({
  items: [
    { kind: 'PETITION', id: uuid('0900', 1), contractor_id: uuid('0001', 1), contractor_name: 'Công ty nhà thầu 1', subject_code: 'GT-2026-01', outcome: 'UPHELD', source_status: 'RESOLVED', opened_on: '2026-09-01', closed_on: '2026-09-10' },
    { kind: 'CLAIM', id: uuid('0900', 2), contractor_id: uuid('0001', 1), contractor_name: 'Công ty nhà thầu 1', subject_code: null, outcome: 'OPEN', source_status: 'SUBMITTED', opened_on: '2026-10-01', closed_on: null },
  ],
  stats: stats(),
  petitions: stats({ total: 3 }),
  claims: stats({ total: 1, upheld: 0, rejected: 0, upheld_pct: null, mean_days_to_close: null }),
  portfolio: stats({ total: 9, upheld_pct: 40 }),
  as_of: AS_OF,
  ...over,
});

export const ocds = (over: Record<string, unknown> = {}) => ({
  parties: [{ id: 'VN-MST-0101234561', name: 'Công ty nhà thầu 1', identifier: { scheme: 'VN-MST', id: '0101234561', legalName: 'Công ty nhà thầu 1' }, roles: ['tenderer'] }],
  policy: invPolicy('VENDOR_OCDS_EXPORT'),
  owners_included: false,
  contact_included: false,
  notice: 'Owners and contact point are left out',
  as_of: AS_OF,
  ...over,
});
