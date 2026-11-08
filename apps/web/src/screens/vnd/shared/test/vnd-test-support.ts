import { harness } from '../../../sas/test-support';
import type { Harness } from '../../../sas/test-support';

export { mount } from '../../../bid/test-support';
export type { Harness };

export const READER = ['vnd.read'];
export const ALL = [
  'vnd.read',
  'vnd.profile.write',
  'vnd.duplicate.decide',
  'vnd.bank.request',
  'vnd.bank.approve',
  'vnd.bank.callback',
  'vnd.qualification.write',
  'vnd.qualification.verify',
  'vnd.restriction.propose',
  'vnd.restriction.decide',
  'vnd.reputation.write',
  'vnd.reputation.post',
  'vnd.venture.write',
];

export const routeOf = (id: string, req: string) => ({ id, path: `/vnd/${id.toLowerCase()}`, title: id, kind: 'table', area: 'insights', module: 'VND', group: 'Quản lý nhà thầu', role: 'workspace', parent: null, req });

export const AS_OF = '2026-11-08T03:00:00.000Z';
export const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const CONTRACTOR = uuid('0001', 1);
export const OTHER = uuid('0001', 2);
export const DOCUMENT = uuid('0009', 1);

export const policy = (code: string, over: Record<string, unknown> = {}) => ({
  code,
  version: 'DEFAULT-1',
  unverified: true,
  formula: `Formula of ${code}`,
  source: `Source of ${code}`,
  as_of: '2026-11-01',
  params: {},
  ...over,
});

export const coverage = (over: Record<string, unknown> = {}) => ({
  present: ['LEGAL_REPRESENTATIVE', 'CONTACT'],
  missing: ['REGISTERED_ADDRESS', 'OWNERSHIP'],
  required: ['LEGAL_REPRESENTATIVE', 'REGISTERED_ADDRESS', 'CONTACT', 'OWNERSHIP'],
  coverage_pct: 50,
  complete: false,
  ...over,
});

export const registerLine = (n: number, over: Record<string, unknown> = {}) => ({
  contractor_id: uuid('0001', n),
  tax_identifier: `010123456${n}`,
  legal_name: `Công ty nhà thầu ${n}`,
  verification_status: 'VERIFIED',
  legal_rep_name: `Người đại diện ${n}`,
  coverage: coverage(),
  restricted: false,
  open_cases: 0,
  active_accounts: 1,
  qualifications_expiring: 0,
  next_review_due: '2027-03-01',
  cursor: `cursor-${n}`,
  ...over,
});

export const registerPage = (items: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) => ({
  items,
  next_cursor: null,
  profile_policy: policy('VENDOR_PROFILE'),
  as_of: AS_OF,
  ...over,
});

export const indicator = (code: string, over: Record<string, unknown> = {}) => ({ code, name: `Indicator ${code}`, formula: `Formula ${code}`, source: `Source ${code}`, unverified: true, ...over });

export const figures = (over: Record<string, unknown> = {}) => ({
  profile_coverage: { complete: 6, total: 10, pct: 60 },
  debarment: { decided_in_time: 4, decided_late: 1, overdue_open: 1, open: 3, in_time_pct: 80 },
  reputation: { posted_in_time: 3, posted_late: 0, overdue_open: 0, open: 2, in_time_pct: 100 },
  payee: { changes_requested: 5, changes_with_callback: 4, accounts_waiting: 1, shared_accounts: 0 },
  indicators: [indicator('PROFILE_COVERAGE'), indicator('DEBARMENT_IN_TIME'), indicator('REPUTATION_IN_TIME'), indicator('PAYEE_CALLBACK')],
  as_of: AS_OF,
  ...over,
});

export const profile = (over: Record<string, unknown> = {}) => ({
  contractor_id: CONTRACTOR,
  tax_identifier: '0101234561',
  legal_name: 'Công ty nhà thầu 1',
  verification_status: 'VERIFIED',
  legal_rep_name: 'Nguyễn Văn An',
  legal_rep_position: 'Giám đốc',
  registered_address: '12 Phố Huế, Hà Nội',
  phone: '0901234567',
  email: 'lienhe@example.vn',
  business_registration_no: '0101234561',
  ownership_declaration: 'OWNERS_LISTED',
  phone_set_at: '2026-10-01T02:00:00.000Z',
  profile_reviewed_at: '2026-10-01T02:00:00.000Z',
  next_review_due: '2027-10-01',
  owner_count: 1,
  version: 4,
  ...over,
});

export const owner = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid('0002', n),
  owner_kind: 'PERSON',
  owner_name: `Chủ sở hữu ${n}`,
  share_pct: '60.00',
  beneficial_owner: true,
  control_basis: 'SHARE_CAPITAL',
  has_identity_key: true,
  source_document_id: DOCUMENT,
  since_on: '2024-01-01',
  ended_on: null,
  ended_reason: null,
  version: 1,
  ...over,
});

export const account = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid('0003', n),
  bank_name: 'Ngân hàng Công Thương',
  account_holder: 'CÔNG TY NHÀ THẦU 1',
  holder_matches_legal_name: true,
  account_no_masked: '••••6789',
  state: 'ACTIVE',
  effective_after: '2026-11-12T03:00:00.000Z',
  valid_now: false,
  superseded_at: null,
  closed_reason: null,
  version: 2,
  ...over,
});

export const verdict = (over: Record<string, unknown> = {}) => ({
  allowed: true,
  reason: null,
  warnings: [],
  account_id: uuid('0003', 1),
  valid_from: '2026-10-01',
  policy_version: 'DEFAULT-1',
  unverified: true,
  ...over,
});

export const change = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid('0004', n),
  contractor_id: CONTRACTOR,
  contractor_name: 'Công ty nhà thầu 1',
  bank_name: 'Ngân hàng Ngoại Thương',
  account_holder: 'CÔNG TY NHÀ THẦU 1',
  holder_matches_legal_name: true,
  account_no_masked: '••••4321',
  reason: 'Đổi sang tài khoản mới theo thư của nhà thầu',
  evidence_document_id: DOCUMENT,
  status: 'REQUESTED',
  requested_by_name: 'Lê Thị Hoa',
  requested_at: '2026-11-06T02:00:00.000Z',
  expires_at: '2026-11-20T02:00:00.000Z',
  contract_match_by_name: null,
  contract_match_at: null,
  contract_match_note: null,
  account_match_by_name: null,
  account_match_at: null,
  account_match_note: null,
  callback_by_name: null,
  callback_at: null,
  callback_outcome: null,
  callback_number_last4: null,
  callback_note: null,
  closed_at: null,
  closed_reason: null,
  resulting_account_id: null,
  remaining: ['CONTRACT_MATCH', 'ACCOUNT_MATCH', 'CALLBACK'],
  may_approve_contract_match: true,
  may_approve_account_match: true,
  may_callback: true,
  may_cancel: false,
  may_reject: true,
  version: 3,
  ...over,
});

export const bankEvent = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid('0005', n),
  change_request_id: uuid('0004', 1),
  account_id: null,
  action: 'REQUESTED',
  actor_name: 'Lê Thị Hoa',
  note: null,
  occurred_at: '2026-11-06T02:00:00.000Z',
  ...over,
});

export const qualification = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid('0006', n),
  kind: 'CONSTRUCTION_ACTIVITY',
  certificate_no: `CCNL-${n}`,
  grade: 'II',
  scope: 'Công trình dân dụng và giao thông',
  issuer: 'Bộ Xây dựng',
  issued_on: '2024-01-01',
  expires_on: '2027-01-01',
  document_id: DOCUMENT,
  verified_by_name: 'Phạm Quốc Bảo',
  verified_at: '2026-10-02T02:00:00.000Z',
  revoked_at: null,
  revoke_reason: null,
  state: 'VALID',
  days_left: 54,
  may_verify: false,
  version: 2,
  ...over,
});

export const staff = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid('0007', n),
  staff_role: 'PROJECT_MANAGER',
  person_name: `Trần Văn Cường ${n}`,
  qualification_title: 'Chỉ huy trưởng công trường',
  certificate_no: `CH-${n}`,
  issued_on: '2024-02-01',
  expires_on: '2026-12-15',
  document_id: null,
  verified_by_name: null,
  verified_at: null,
  revoked_at: null,
  revoke_reason: null,
  state: 'EXPIRING_SECOND',
  days_left: 37,
  may_verify: true,
  version: 1,
  ...over,
});

export const restriction = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid('0008', n),
  kind: 'DEBARMENT',
  source: 'CASE',
  effective_from: '2026-01-01',
  effective_until: '2028-12-31',
  decision_document_id: DOCUMENT,
  case_id: uuid('0010', 1),
  lifted: false,
  in_force: true,
  ...over,
});

export const caseLine = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid('0010', n),
  case_no: `HSC-2026-00${n}`,
  subject_kind: 'CONTRACTOR',
  contractor_id: CONTRACTOR,
  joint_venture_id: null,
  subject_name: 'Công ty nhà thầu 1',
  trigger_kind: 'INVESTOR_PROPOSAL',
  trigger_ref: null,
  egp_record_id: null,
  violation_groups: ['GROUP_2'],
  violation_summary: 'Nộp bảo đảm dự thầu giả mạo trong gói thầu xây lắp',
  violation_on: '2026-09-15',
  proposed_by_name: 'Lê Thị Hoa',
  received_at: '2026-11-01T02:00:00.000Z',
  decide_by: '2026-11-16T02:00:00.000Z',
  clock: 'ON_TIME',
  policy_version: 'DEFAULT-1|DEFAULT-1',
  status: 'PROPOSED',
  response_due_at: null,
  response_outcome: null,
  decision: null,
  decided_by_name: null,
  decided_at: null,
  decision_scope: null,
  ban_months: null,
  effective_from: null,
  effective_until: null,
  decided_late: null,
  version: 1,
  ...over,
});

export const casePage = (items: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) => ({
  items,
  policy: policy('VENDOR_DEBARMENT', { params: { decide_within_days: 15, cumulative_max_months: 60 } }),
  counts: { open: items.length, overdue: 0, decided_in_time: 2, decided_late: 1 },
  as_of: AS_OF,
  ...over,
});

export const caseEvent = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid('0011', n),
  move: 'PROPOSE',
  from_status: null,
  to_status: 'PROPOSED',
  actor_name: 'Lê Thị Hoa',
  note: null,
  occurred_at: '2026-11-01T02:00:00.000Z',
  ...over,
});

export const caseDetail = (line: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  case: line,
  notice_document_id: null,
  proposal_document_id: DOCUMENT,
  response_document_id: null,
  response_summary: null,
  decision_document_id: null,
  decision_reason: null,
  end_reason: null,
  lift_document_id: null,
  members: [{ contractor_id: CONTRACTOR, contractor_name: 'Công ty nhà thầu 1', restriction_id: null }],
  events: [caseEvent(1)],
  escalation: { decisions_in_force: 0, suggestion: 'NONE' },
  periods: { GROUP_1: { min_months: 36, max_months: 60, behaviours: 'Gian lận' }, GROUP_2: { min_months: 12, max_months: 36, behaviours: 'Cản trở' }, GROUP_3: { min_months: 6, max_months: 12, behaviours: 'Khác' } },
  policy: policy('VENDOR_DEBARMENT', { params: { decide_within_days: 15, cumulative_max_months: 60 } }),
  may_advance: true,
  may_decide: false,
  may_put_into_effect: false,
  may_lift: false,
  as_of: AS_OF,
  ...over,
});

export const reputationEvent = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid('0012', n),
  contractor_id: CONTRACTOR,
  contractor_name: 'Công ty nhà thầu 1',
  package_id: null,
  contract_id: null,
  behaviour_code: 'NO_BID_SECURITY',
  event_on: '2026-10-30',
  description: 'Không nộp bảo đảm dự thầu đúng hạn',
  evidence_document_id: DOCUMENT,
  status: 'RECORDED',
  recorded_by_name: 'Lê Thị Hoa',
  recorded_at: '2026-11-02T02:00:00.000Z',
  post_due_at: '2026-11-11T02:00:00.000Z',
  clock: 'ON_TIME',
  deadline_policy_version: 'DEFAULT-1',
  posted_by_name: null,
  posted_at: null,
  posting_ref: null,
  retracted_at: null,
  retract_reason: null,
  may_post: true,
  may_retract: true,
  version: 1,
  ...over,
});

export const reputationPage = (items: Array<Record<string, unknown>>) => ({
  items,
  policy: policy('VENDOR_REPUTATION'),
  deadline_policy: policy('EGP_POSTING_DEADLINES'),
  as_of: AS_OF,
});

export const venture = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid('0013', n),
  name: `Liên danh ${n}`,
  lead_contractor_id: CONTRACTOR,
  agreement_document_id: DOCUMENT,
  package_id: null,
  starts_on: '2026-06-01',
  ends_on: null,
  ended_reason: null,
  status: 'ACTIVE',
  members: [
    { contractor_id: CONTRACTOR, contractor_name: 'Công ty nhà thầu 1', tax_identifier: '0101234561', share_pct: '60', lead: true },
    { contractor_id: OTHER, contractor_name: 'Công ty nhà thầu 2', tax_identifier: '0101234562', share_pct: '40', lead: false },
  ],
  version: 1,
  ...over,
});

export const duplicate = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid('0014', n),
  contractor_a_id: CONTRACTOR,
  contractor_b_id: OTHER,
  contractor_a_name: 'Công ty nhà thầu 1',
  contractor_b_name: 'Công ty Nhà Thầu 1 chi nhánh',
  contractor_a_tax: '0101234561',
  contractor_b_tax: '0101234561-001',
  score: 100,
  signals: ['TAX_HEAD', 'ADDRESS'],
  status: 'OPEN',
  decision_reason: null,
  version: 1,
  ...over,
});

export const expiry = (n: number, over: Record<string, unknown> = {}) => ({
  subject: 'QUALIFICATION',
  id: uuid('0006', n),
  contractor_id: CONTRACTOR,
  contractor_name: 'Công ty nhà thầu 1',
  label: `CCNL-${n}`,
  expires_on: '2026-12-01',
  state: 'EXPIRING_SECOND',
  ...over,
});

export const profileView = (over: Record<string, unknown> = {}) => ({
  profile: profile(),
  tax_check: { format: 'VALID', checksum: 'MATCH', checksum_legal_status: 'UNVERIFIED', normalised: '0101234561' },
  coverage: coverage(),
  owners: [owner(1)],
  accounts: [account(1)],
  payee_verdict: verdict(),
  payee_changes: [change(1)],
  bank_events: [bankEvent(1)],
  qualifications: [qualification(1)],
  key_staff: [staff(1)],
  restrictions: [restriction(1)],
  cases: [caseLine(1)],
  reputation_events: [reputationEvent(1)],
  bid_security: { multiplier: 3, until: '2028-11-01', event_ids: [uuid('0012', 1)], policy_version: 'DEFAULT-1' },
  escalation: { decisions_in_force: 1, suggestion: 'NONE' },
  duplicates: [duplicate(1)],
  ventures: [venture(1)],
  policies: {
    profile: policy('VENDOR_PROFILE'),
    payee: policy('VENDOR_PAYEE_ACCOUNT'),
    qualification_expiry: policy('VENDOR_EXPIRY_WARNING'),
    key_staff_expiry: policy('VENDOR_EXPIRY_WARNING'),
    gate: policy('VENDOR_GATE'),
  },
  actions: {
    update_profile: true,
    manage_owners: true,
    request_payee_change: true,
    manage_certificates: true,
    propose_restriction: true,
    record_reputation_event: true,
    manage_ventures: true,
    decide_duplicates: true,
  },
  as_of: AS_OF,
  ...over,
});

export type Answer = unknown | ((input: unknown) => unknown);
export interface World {
  /** What each read answers: a value, a function of the input, or an Error to reject with. */
  answers: Record<string, Answer>;
  /** Reads that fail (by operation) for their first `times` calls. */
  failing?: Record<string, { error: Error; times: number }>;
}

/** A client over `world`: reads are answered from it, `command(operation, input)` answers the commands. */
export function client(world: World, command: (operation: string, input: unknown) => unknown = () => ({ operation_id: 'o', status: 'OK', resource_version: 9 })): Harness {
  return harness((operation, input) => {
    const failure = world.failing?.[operation];
    if (failure !== undefined && failure.times > 0) {
      failure.times -= 1;
      return failure.error;
    }
    if (!(operation in world.answers)) return new Error(`unexpected read ${operation}`);
    const answer = world.answers[operation];
    return typeof answer === 'function' ? (answer as (value: unknown) => unknown)(input) : answer;
  }, command);
}
