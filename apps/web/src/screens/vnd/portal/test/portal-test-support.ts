import { client as baseClient, mount, routeOf, uuid, AS_OF, CONTRACTOR, DOCUMENT, policy } from '../../shared/test/vnd-test-support';

export { AS_OF, CONTRACTOR, DOCUMENT, baseClient as client, mount, policy, routeOf, uuid };
export type { World } from '../../shared/test/vnd-test-support';

/** What the guest role holds (migration V2447) and what the staff side holds. */
export const GUEST = ['vnd.portal.read', 'vnd.portal.respond', 'vnd.portal.certificate', 'vnd.portal.reconfirm', 'vnd.portal.remediation'];
export const GUEST_READER = ['vnd.portal.read'];
export const STAFF = ['vnd.read', 'vnd.portal.manage', 'vnd.remediation.manage'];

/** Fields that a payload must never make the portal draw: the screens render from named fields only. */
export const POISON = { red_flag: 'POISON-RED-FLAG', risk_grade: 'POISON-RISK-GRADE', lead: 'POISON-LEAD', screening_hit: 'POISON-SCREENING', other_contractors: ['POISON-OTHER'], investigation: 'POISON-INVESTIGATION' };

export const portalProfile = (over: Record<string, unknown> = {}) => ({
  id: CONTRACTOR,
  legal_name: 'Công ty nhà thầu 1',
  tax_identifier: '0101234561',
  verification_status: 'VERIFIED',
  legal_rep_name: 'Nguyễn Văn An',
  legal_rep_position: 'Giám đốc',
  registered_address: '12 Phố Huế, Hà Nội',
  phone: '0901234567',
  email: 'lienhe@example.vn',
  business_registration_no: '0101234561',
  ownership_declaration: 'OWNERS_LISTED',
  next_review_due: '2027-03-01',
  profile_reviewed_at: '2026-10-01T02:00:00.000Z',
  version: 4,
  ...over,
});

export const DECLARATION = 'Tôi cam kết thông tin hồ sơ là đúng và không có hành vi bị cấm.';

export const portalHome = (over: Record<string, unknown> = {}) => ({
  profile: portalProfile(),
  reconfirmation: { state: 'DUE_SOON', due_on: '2026-11-20', last_confirmed_at: '2025-11-20T02:00:00.000Z', declaration_version: 'V1', declaration_text: DECLARATION, interval_months: 12 },
  counts: { open_requests: 2, overdue_requests: 1, certificates_expiring: 1, open_plans: 1, evaluations: 2 },
  actions: { respond: true, certificate: true, reconfirm: true, remediation: true },
  as_of: AS_OF,
  ...over,
});

export const portalRequest = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid('0040', n),
  kind: 'INFORMATION',
  title: `Cung cấp báo cáo tài chính ${n}`,
  body: `Đề nghị gửi báo cáo tài chính năm 2025 (${n})`,
  due_at: '2026-11-20T02:00:00.000Z',
  status: 'OPEN',
  clock: 'ON_TIME',
  requested_at: '2026-11-01T02:00:00.000Z',
  response_text: null,
  response_document_id: null,
  response_qualification_id: null,
  responded_at: null,
  response_late: null,
  round: 1,
  review_note: null,
  version: 3,
  ...over,
});

export const requestPage = (items: Array<Record<string, unknown>>) => ({ items, as_of: AS_OF });

export const portalQualification = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid('0006', n),
  kind: 'CONSTRUCTION_ACTIVITY',
  certificate_no: `CCNL-${n}`,
  grade: 'II',
  scope: 'Công trình dân dụng',
  issuer: 'Bộ Xây dựng',
  issued_on: '2024-01-01',
  expires_on: '2027-01-01',
  verified: true,
  revoked: false,
  state: 'VALID',
  days_left: 54,
  ...over,
});

export const portalStaff = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid('0007', n),
  staff_role: 'SUPERVISOR',
  person_name: `Lý Văn Dũng ${n}`,
  qualification_title: 'Giám sát thi công',
  expires_on: '2027-05-01',
  verified: false,
  state: 'VALID',
  days_left: 200,
  ...over,
});

export const qualificationList = (over: Record<string, unknown> = {}) => ({ qualifications: [portalQualification(1), portalQualification(2, { verified: false, state: 'EXPIRING_SECOND', days_left: 20 })], key_staff: [portalStaff(1)], as_of: AS_OF, ...over });

export const portalEvaluation = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid('0041', n),
  contract_id: uuid('0042', n),
  contract_code: `HD-${n}`,
  evaluation_kind: 'PERIODIC',
  period_label: `2026-Q${n}`,
  rating: 'FAIR',
  overall_score: 71.5,
  score_quality: 70,
  score_schedule: 65,
  score_safety_env: 80,
  score_cooperation: 75,
  score_financial: 68,
  remarks: 'Tiến độ chậm ở hạng mục móng',
  approved_at: '2026-10-20T02:00:00.000Z',
  open_request_id: null,
  ...over,
});

export const portalAction = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid('0043', n),
  seq: n,
  description: `Bổ sung nhân sự giám sát ${n}`,
  due_on: '2026-12-01',
  status: 'OPEN',
  overdue: false,
  done_at: null,
  done_note: null,
  verified_at: null,
  verify_note: null,
  version: 2,
  ...over,
});

export const portalPlan = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid('0044', n),
  title: `Khắc phục tiến độ ${n}`,
  objective: 'Đưa tiến độ về đúng kế hoạch trong hai tháng',
  status: 'PROPOSED',
  proposed_at: '2026-11-02T02:00:00.000Z',
  agreed_at: null,
  closed_at: null,
  actions: [portalAction(n), portalAction(n + 10, { seq: 2, overdue: true, due_on: '2026-11-01' })],
  version: 5,
  ...over,
});

// ---- the staff side --------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const staffRequest = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid('0045', n),
  contractor_id: CONTRACTOR,
  contractor_name: 'Công ty nhà thầu 1',
  kind: 'EVALUATION_RESPONSE',
  subject_type: null,
  subject_id: null,
  title: `Phản hồi đánh giá ${n}`,
  body: 'Đề nghị phản hồi đánh giá quý 3',
  due_at: '2026-11-20T02:00:00.000Z',
  status: 'RESPONDED',
  clock: 'ANSWERED_LATE',
  requested_by_name: 'Lê Thị Hoa',
  requested_at: '2026-11-01T02:00:00.000Z',
  response_text: 'Chúng tôi đã khắc phục tiến độ',
  response_document_id: null,
  response_qualification_id: null,
  responded_at: '2026-11-22T02:00:00.000Z',
  response_late: true,
  round: 1,
  reviewed_at: null,
  review_note: null,
  cancelled_reason: null,
  version: 4,
  ...over,
});

export const staffRequestPage = (items: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) => ({
  items,
  counts: { open: 3, responded: 2, overdue: 1 },
  in_time_pct: 75,
  policies: {},
  as_of: AS_OF,
  ...over,
});

export const reconfirmationLine = (n: number, over: Record<string, unknown> = {}) => ({
  contractor_id: uuid('0001', n),
  contractor_name: `Công ty nhà thầu ${n}`,
  tax_identifier: `010123456${n}`,
  state: 'OVERDUE',
  due_on: '2026-10-01',
  last_confirmed_at: '2025-10-01T02:00:00.000Z',
  declaration_version: 'V1',
  ...over,
});

export const reconfirmationPage = (items: Array<Record<string, unknown>>) => ({
  items,
  counts: { current: 5, due_soon: 2, overdue: 1, lapsed: 1, never: 3 },
  current_pct: 41.7,
  policy: policy('VENDOR_RECONFIRMATION'),
  as_of: AS_OF,
});

export const planLine = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid('0044', n),
  contractor_id: CONTRACTOR,
  contractor_name: 'Công ty nhà thầu 1',
  contract_id: null,
  trigger_kind: 'POOR_EVALUATION',
  title: `Khắc phục tiến độ ${n}`,
  objective: 'Đưa tiến độ về đúng kế hoạch trong hai tháng',
  status: 'IN_PROGRESS',
  proposed_by_name: 'Lê Thị Hoa',
  proposed_at: '2026-11-02T02:00:00.000Z',
  agreed_at: '2026-11-03T02:00:00.000Z',
  started_at: '2026-11-04T02:00:00.000Z',
  closed_at: null,
  closed_reason: null,
  action_count: 2,
  verified_count: 1,
  overdue_count: 1,
  version: 6,
  ...over,
});

export const planActionLine = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid('0043', n),
  seq: n,
  description: `Bổ sung nhân sự giám sát ${n}`,
  due_on: '2026-12-01',
  status: 'DONE',
  overdue: false,
  done_by_name: 'Nguyễn Văn An',
  done_at: '2026-11-06T02:00:00.000Z',
  done_note: 'Đã bổ sung hai giám sát',
  evidence_document_id: null,
  verified_by_name: null,
  verified_at: null,
  verify_note: null,
  version: 3,
  ...over,
});

export const planPage = (items: Array<Record<string, unknown>>) => ({ items, policy: policy('VENDOR_REMEDIATION'), as_of: AS_OF });

export const planDetail = (over: Record<string, unknown> = {}) => ({
  plan: planLine(1),
  actions: [planActionLine(1), planActionLine(2, { status: 'OPEN', done_at: null, done_by_name: null, done_note: null })],
  events: [{ id: uuid('0046', 1), move: 'START', from_status: 'AGREED', to_status: 'IN_PROGRESS', actor_name: 'Lê Thị Hoa', note: null, at: '2026-11-04T02:00:00.000Z' }],
  policy: policy('VENDOR_REMEDIATION'),
  may_start: false,
  may_complete: true,
  may_close: true,
  as_of: AS_OF,
  ...over,
});

export const registerChoices = () => ({
  items: [{ contractor_id: CONTRACTOR, legal_name: 'Công ty nhà thầu 1', tax_identifier: '0101234561' }],
  next_cursor: null,
  as_of: AS_OF,
});
