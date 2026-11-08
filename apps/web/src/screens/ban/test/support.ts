import { ApiError } from '@machvon/api-client';
import { harness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import type { WebRoute } from '../../../routes/types';

export { mount } from '../../bid/test-support';
export type { Harness };
export { harness };

export const READER = ['committee.read'];
export const HEAD = ['committee.read', 'committee.attention.decide', 'committee.alert.acknowledge', 'directive.manage', 'directive.meeting.manage', 'rpt.generate'];
export const SECRETARIAT = [...HEAD, 'committee.manage', 'committee.alert.evaluate'];
export const AUDITOR = ['committee.audit.read'];

export const routeOf = (id: string, req: string): WebRoute => ({ id, path: `/ban/${id.toLowerCase()}`, title: id, kind: 'table', area: 'overview', module: 'BAN', group: 'Điều hành', role: 'workspace', parent: null, req });

export const AS_OF = '2026-11-08';
export const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const never = (): Promise<never> => new Promise<never>(() => undefined);
export const problem = (code: string, status: number, detail?: string, extensions?: Record<string, unknown>) => new ApiError({ status, code, correlationId: 'c', ...(detail === undefined ? {} : { detail }), ...(extensions === undefined ? {} : { extensions }) });

export const kpi = (code: string, over: Record<string, unknown> = {}) => ({
  code,
  name: `Chỉ tiêu ${code}`,
  formula: `Công thức của ${code}`,
  numerator: null,
  denominator: null,
  exclusions: [],
  unit: 'PERCENT',
  period: 'YTD',
  source: 'Lõi dữ liệu đầu tư công',
  owner: 'COMMITTEE_SECRETARIAT',
  allowedLagDays: 7,
  version: 0,
  effectiveFrom: null,
  effectiveTo: null,
  origin: 'DEFAULT',
  unverified: true,
  asOf: AS_OF,
  snapshotId: null,
  ...over,
});

export const figure = (code: string, over: Record<string, unknown> = {}) => ({
  metric_code: code,
  value: '60.00',
  display_value: '60,00',
  numerator: null,
  denominator: null,
  null_reason: null,
  unit: 'PERCENT',
  formula: `Công thức của ${code}`,
  definition_status: 'PROPOSED',
  kpi: kpi(code),
  certification: null,
  flags: ['UNVERIFIED_DEFINITION'],
  ...over,
});

export const FIGURES = [
  figure('COMMITTEE_PLAN_TOTAL', { unit: 'VND', value: '1000000000000', display_value: '1.000.000.000.000' }),
  figure('COMMITTEE_DISBURSED', { unit: 'VND', value: '600000000000', display_value: '600.000.000.000' }),
  figure('COMMITTEE_DISBURSEMENT_RATE'),
  figure('COMMITTEE_DISBURSED_LAST_YEAR', { unit: 'VND', value: null, display_value: null, null_reason: 'NO_DATA', flags: ['NO_DATA'] }),
  figure('COMMITTEE_GAP_VS_CURVE', { value: '-4.00', display_value: '-4,00' }),
  figure('COMMITTEE_ATTENTION_PROJECTS', { unit: 'COUNT', value: '3', display_value: '3' }),
  figure('COMMITTEE_UNITS_NOT_REPORTING', { unit: 'COUNT', value: '1', display_value: '1' }),
  figure('COMMITTEE_DIRECTIVES_OVERDUE', { unit: 'COUNT', value: '2', display_value: '2' }),
];

export const outlook = (over: Record<string, unknown> = {}) => ({ low_vnd: '800000000000', high_vnd: '950000000000', low_pct: '80.00', high_pct: '95.00', methods: [], thin: false, reason: null, ...over });

export const row = (key: string, label: string, over: Record<string, unknown> = {}) => ({
  dimension: 'SECTOR',
  key,
  label,
  projects: 4,
  plan_share_pct: '40.00',
  attention_projects: 1,
  plan_vnd: '400000000000',
  disbursed_vnd: '200000000000',
  rate_pct: '50.00',
  last_year_vnd: '180000000000',
  last_year_coverage: { known: 4, total: 4 },
  change_vs_last_year_vnd: '20000000000',
  expected_pct: '64.00',
  gap_points: '-14.00',
  rag: 'RED',
  outlook: outlook(),
  unknown_lines: 0,
  ...over,
});

export const province = (over: Record<string, unknown> = {}) =>
  row('PROVINCE', 'Toàn tỉnh', { dimension: 'PROVINCE', projects: 10, plan_vnd: '1000000000000', disbursed_vnd: '600000000000', rate_pct: '60.00', last_year_vnd: null, last_year_coverage: { known: 6, total: 10 }, change_vs_last_year_vnd: null, gap_points: '-4.00', rag: 'AMBER', ...over });

export const signal = (reason: string, over: Record<string, unknown> = {}) => ({ reason, value: '75', threshold: 60, unit: 'DAYS', severity: 0.6, weight: 1, ...over });

export const decision = (kind: string, over: Record<string, unknown> = {}) => ({
  id: uuid(700),
  project_id: uuid(101),
  decision: kind,
  reasons: ['DELAYED'],
  score: '40.00',
  as_of: AS_OF,
  note: 'Đã xem',
  defer_until: null,
  directive_id: null,
  decided_by: uuid(9),
  decided_by_name: 'Nguyễn Văn An',
  decided_at: '2026-11-07T02:00:00.000Z',
  ...over,
});

export const attention = (n: number, over: Record<string, unknown> = {}) => ({
  rank: n,
  project_id: uuid(100 + n),
  code: `DA-${n}`,
  name: `Dự án giao thông ${n}`,
  sector_code: 'GT',
  sector_name: 'Giao thông',
  district_name: 'Thành phố Cao Bằng',
  investor_unit_id: uuid(200 + n),
  investor_name: `Ban quản lý dự án ${n}`,
  plan_vnd: '9223372036854775809',
  disbursed_vnd: null,
  rate_pct: null,
  expected_pct: '64.00',
  exposure_vnd: '123456789012',
  score: '72.50',
  signals: [signal('DELAYED'), signal('DISBURSEMENT_FAR_BELOW_PLAN', { value: '30.00', threshold: 50, unit: 'PERCENT' })],
  decision: null,
  ...over,
});

export const alert = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(300 + n),
  alert_type: 'COMMITTEE_PROVINCE_BEHIND',
  subject_kind: 'PROVINCE',
  subject_key: 'PROVINCE',
  subject_label: 'Toàn tỉnh',
  severity: 'URGENT',
  value: '-4.00',
  threshold: '-3.00',
  detail: {},
  fiscal_year: 2026,
  status: 'OPEN',
  opened_on: '2026-11-01',
  last_seen_on: AS_OF,
  resolved_on: null,
  acknowledged_by_name: null,
  acknowledged_at: null,
  acknowledged_note: null,
  owner: 'Sở Tài chính',
  expected_action: 'Họp với các chủ đầu tư chậm',
  consequence: 'Năm đóng với vốn chưa giải ngân',
  response_hours: 48,
  version: 2,
  ...over,
});

export const policy = (over: Record<string, unknown> = {}) => ({ code: 'DEFAULT', version: null, source: 'DEFAULT', unverified: true, formula: 'Đường kỳ vọng nội suy theo tháng', rule_source: 'Quy tắc COMMITTEE_POLICY', as_of: '2026-11-08', curve: [], expected_pct: '64.00', ...over });
export const feed = (over: Record<string, unknown> = {}) => ({ basis: 'DIS_SNAPSHOT', reference: 'SNAP-12', last_delivered_at: '2026-11-07T01:00:00.000Z', empty: false, projects: 10, lines: 24, ...over });

export const tracker = (over: Record<string, unknown> = {}) => ({
  as_of: AS_OF,
  units: [
    { unit_id: uuid(201), unit_name: 'Ban quản lý dự án 1', open: 3, overdue: 2, escalated: 1, oldest_overdue_days: 21 },
    { unit_id: uuid(202), unit_name: 'Ban quản lý dự án 2', open: 1, overdue: 0, escalated: 0, oldest_overdue_days: null },
  ],
  directives: [
    { id: uuid(401), code: 'CD-2026-001', text: 'Đẩy nhanh giải ngân', project_id: uuid(101), project_code: 'DA-1', assignee_unit_id: uuid(201), assignee_unit_name: 'Ban quản lý dự án 1', due_on: '2026-10-18', overdue_days: 21, phase: 'ESCALATED', status: 'OPEN', extension_count: 1 },
    { id: uuid(402), code: 'CD-2026-002', text: 'Báo cáo vướng mắc', project_id: null, project_code: null, assignee_unit_id: uuid(201), assignee_unit_name: 'Ban quản lý dự án 1', due_on: '2026-11-01', overdue_days: 7, phase: 'OVERDUE', status: 'OPEN', extension_count: 0 },
  ],
  totals: { open: 4, overdue: 2, escalated: 1 },
  truncated: false,
  escalate_after_days: 14,
  figures: [FIGURES[7]],
  ...over,
});

export const workspace = (over: Record<string, unknown> = {}) => ({
  as_of: AS_OF,
  fiscal_year: 2026,
  feed: feed(),
  policy: policy(),
  figures: FIGURES,
  province: province(),
  by_sector: [row('GT', 'Giao thông'), row('NN', 'Nông nghiệp', { rag: 'GREEN', gap_points: '2.00', rate_pct: '66.00', last_year_vnd: null, last_year_coverage: { known: 0, total: 4 }, disbursed_vnd: null })],
  by_district: [row('CB', 'Thành phố Cao Bằng', { dimension: 'DISTRICT' })],
  by_investor: [row(uuid(201), 'Ban quản lý dự án 1', { dimension: 'INVESTOR' })],
  by_fund_source: [row('NSTW', 'Ngân sách trung ương', { dimension: 'FUND_SOURCE' })],
  attention_total: 3,
  attention: [attention(1), attention(2)],
  units: [
    { unit_id: uuid(201), unit_name: 'Ban quản lý dự án 1', expected: 4, received: 4, reporting_rate_pct: '100.00', last_reported_on: '2026-11-05', days_since_report: 3, not_reporting: false, reason: null },
    { unit_id: uuid(203), unit_name: 'Ban quản lý dự án 3', expected: 4, received: 1, reporting_rate_pct: '25.00', last_reported_on: null, days_since_report: null, not_reporting: true, reason: 'NEVER_REPORTED' },
  ],
  alerts: [alert(1)],
  changes: { lines: [{ kind: 'RATE_CHANGE', direction: 'UP', params: { from: '55.00', to: '60.00', delta: '5.00' }, link: 'DRILL', metric_code: 'DISBURSEMENT_RATE_PM' }], previous_as_of: '2026-11-01', reason: null },
  directives: tracker(),
  filters: {},
  ...over,
});

export const attentionList = (over: Record<string, unknown> = {}) => ({ as_of: AS_OF, feed: feed(), policy: policy(), total: 2, shown: 2, items: [attention(1), attention(2, { decision: decision('DEFERRED', { project_id: uuid(102), defer_until: '2026-12-01', note: 'Chờ nghiệm thu' }) })], ...over });

export const alertList = (items: unknown[], over: Record<string, unknown> = {}) => ({ as_of: AS_OF, policy: policy(), alerts: items, ...over });

export const member = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(500 + n),
  committee_id: uuid(600),
  membership_id: uuid(800 + n),
  display_name: `Thành viên ${n}`,
  committee_role: 'MEMBER',
  agency_code: null,
  agency_name: null,
  decision_ref: null,
  valid_from: '2026-01-01',
  valid_until: null,
  mfa_required: false,
  status: 'ACTIVE',
  appointed_at: '2026-01-01T00:00:00.000Z',
  ended_at: null,
  end_reason: null,
  role_granted: true,
  version: 3,
  ...over,
});

export const roster = (over: Record<string, unknown> = {}) => ({
  classification: 'PERSONAL',
  committees: [
    {
      id: uuid(600),
      code: 'BAN57',
      name: 'Ban chỉ đạo đầu tư công',
      legal_basis: 'Quyết định 57',
      status: 'ACTIVE',
      version: 1,
      members: [member(1, { committee_role: 'HEAD', agency_code: 'PA05', agency_name: 'Công an tỉnh', decision_ref: 'QD-57/2026', mfa_required: true, role_granted: false }), member(2, { status: 'ENDED', ended_at: '2026-06-01T00:00:00.000Z', end_reason: 'Chuyển công tác' })],
    },
  ],
  ...over,
});

export const pack = (over: Record<string, unknown> = {}) => ({
  as_of: AS_OF,
  fiscal_year: 2026,
  feed: feed(),
  policy: policy(),
  layout_code: 'BAN-MEETING-PACK',
  layout_version: '2026.1',
  figures: FIGURES,
  province: province(),
  by_sector: workspace().by_sector,
  by_district: workspace().by_district,
  by_investor: workspace().by_investor,
  by_fund_source: workspace().by_fund_source,
  attention: [attention(1)],
  directives: tracker(),
  generation: { period: { kind: 'AS_OF', year: 2026, day: AS_OF }, recent_drafts: [], recent_issues: [] },
  ...over,
});

export const draft = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(900 + n),
  layout_code: 'BAN-MEETING-PACK',
  layout_version: '2026.1',
  layout_name: 'Hồ sơ họp Ban chỉ đạo',
  period_code: '2026-11-08',
  period: { kind: 'AS_OF', year: 2026, day: '2026-11-08' },
  state: 'DRAFT',
  base_revision: 0,
  reason: null,
  package_sha256: 'a'.repeat(64),
  files: [],
  data_source: 'LIVE',
  form_status: 'READY',
  demo_mark: null,
  snapshot: null,
  issue_count: 0,
  prepared_by: uuid(801),
  prepared_by_name: 'Thư ký A',
  checked_by_name: null,
  approved_by_name: null,
  issue_id: null,
  version: 1,
  created_at: '2026-11-07T01:00:00.000Z',
  can_check: true,
  can_approve: false,
  can_issue: false,
  demo_forms_off: false,
  preview: null,
  issues: [],
  ...over,
});

export const issue = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(950 + n),
  layout_code: 'BAN-MEETING-PACK',
  layout_version: '2026.1',
  layout_name: 'Hồ sơ họp Ban chỉ đạo',
  period_code: '2026-11-01',
  period: { kind: 'AS_OF', year: 2026, day: '2026-11-01' },
  revision: 1,
  supersedes_id: null,
  reason: null,
  sha256: 'c'.repeat(64),
  files: [],
  data_source: 'LIVE',
  form_status: 'READY',
  demo_mark: null,
  counts_as_accepted: true,
  snapshot: null,
  issue_count: 0,
  prepared_by_name: 'Thư ký A',
  checked_by_name: 'Thành viên B',
  approved_by_name: 'Trưởng ban C',
  issued_by_name: 'Thư ký A',
  issued_at: '2026-11-02T02:00:00.000Z',
  is_current: true,
  current_revision: 1,
  chain: [],
  deliveries: [],
  issues: [],
  can_deliver: false,
  can_answer: false,
  ...over,
});

export const rptPage = (items: unknown[]) => ({ items, truncated: false, as_of: '2026-11-08T03:00:00.000Z' });

export const auditRow = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(1000 + n),
  membership_id: uuid(800 + n),
  display_name: `Người xem ${n}`,
  committee_role: 'HEAD',
  screen: 'WORKSPACE',
  filters: { sector_code: 'GT' },
  as_of: AS_OF,
  record_count: 12,
  feed_basis: 'DIS_SNAPSHOT',
  assurance_level: 'UNKNOWN',
  mfa_required: true,
  viewed_at: '2026-11-08T01:00:00.000Z',
  ...over,
});

/** The reads of a committee world: every operation answered from one table, `overrides` replacing entries. */
export function world(overrides: Record<string, unknown> = {}): (operation: string) => unknown {
  const answers: Record<string, unknown> = {
    getCommitteeWorkspace: workspace(),
    listCommitteeAttention: attentionList(),
    getCommitteeDirectiveTracker: tracker(),
    getCommitteeMeetingPack: pack(),
    listCommitteeAlerts: alertList([alert(1)]),
    getCommitteeRoster: roster(),
    listCommitteeViewAudit: { rows: [auditRow(1)], next: null },
    listReportDrafts: rptPage([draft(1)]),
    listReportIssues: rptPage([issue(1)]),
    listSteeringMeetings: { items: [], next_cursor: null },
    ...overrides,
  };
  return (operation) => answers[operation] ?? new Error(`unexpected read ${operation}`);
}

export const meeting = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(1200 + n),
  code: `GB-2026-00${n}`,
  meeting_date: '2026-11-03',
  meeting_type: 'WEEKLY',
  title: `Giao ban tuần ${n}`,
  summary: null,
  unit: { id: uuid(201), name: 'Ban quản lý dự án 1' },
  minutes_document_version_id: null,
  version: 1,
  counts: { total: 0, by_status: {} },
  ...over,
});
