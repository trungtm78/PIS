import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256Hex, vietnamDateOf } from '@machvon/kernel';
import { GlossaryStore } from './glossary-store.ts';
import { IntegrationCursorStore } from './integration-cursor-store.ts';
import { contentHashOf } from './master-store.ts';
import type { MasterContent } from './master-store.ts';
import { tenantLookup, validateMasterContent } from './master-types.ts';
import type { EntryRef, TypeLookup } from './master-types.ts';
import { enqueueOutbox } from './outbox.ts';
import type { TenantTx } from './tenant-database.ts';

export const BASELINE_SOURCE = 'PLATFORM_BASELINE';
export const BASELINE_EVENT = 'master.baseline_applied.v1';

/** One entry of the baseline that the platform publishes to every tenant. */
export interface BaselineEntry {
  masterType: string;
  businessKey: string;
  label: string;
  /** The key of the parent entry of the same type, which comes earlier in the pack. */
  parentKey?: string;
  attributes: Record<string, unknown>;
  validFrom: string;
  validUntil?: string;
  legalBasis?: string;
}

/** A signed pack: the entries and the digest of their canonical form, which the receiver verifies before it applies anything. */
export interface BaselinePack {
  id: string;
  entries: readonly BaselineEntry[];
  sha256: string;
}

export const packDigest = (entries: readonly BaselineEntry[]): string => sha256Hex(canonicalJson(entries));
export const sealPack = (id: string, entries: readonly BaselineEntry[]): BaselinePack => ({ id, entries, sha256: packDigest(entries) });

const SINCE = '2025-01-01';
const LAW = 'Luật Đầu tư công 58/2024/QH15 (sửa đổi 90/2025)';
const entry = (masterType: string, businessKey: string, label: string, attributes: Record<string, unknown> = {}, rest: Partial<BaselineEntry> = {}): BaselineEntry => ({
  masterType,
  businessKey,
  label,
  attributes,
  validFrom: SINCE,
  ...rest,
});
const fund = (key: string, label: string, category: string, relation: string, parentKey?: string, extra: Record<string, unknown> = {}): BaselineEntry =>
  entry('FUND_SOURCE', key, label, { category, relation, ...extra }, parentKey === undefined ? {} : { parentKey });
const stage = (key: string, label: string, sequence: number, next: string[], terminal = false): BaselineEntry =>
  entry('PROJECT_STAGE', key, label, { sequence, allowed_next: next, ...(terminal ? { terminal: true } : {}) });
const band = (sector: string | null, group: string, min: string, max: string | null) => ({ sector_key: sector, group_key: group, min_amount: min, max_amount: max });
const decisionType = (key: string, label: string, requiredFields: string[]): BaselineEntry => entry('DECISION_TYPE', key, label, { required_fields: requiredFields }, { legalBasis: LAW });
const authority = (key: string, label: string, agency: string, decision: string, scope: string): BaselineEntry =>
  entry('DECISION_AUTHORITY', key, label, { agency_key: agency, decision_type_key: decision, scope }, { legalBasis: LAW });

const unit = (key: string, label: string, dimension: string, factor: string, scale: number): BaselineEntry =>
  entry('UNIT', key, label, { dimension, factor, scale, rounding: 'HALF_UP' });
const currency = (code: string, label: string, scale: number): BaselineEntry => entry('CURRENCY', code, label, { iso_code: code, scale, rounding: 'HALF_UP' });

const PDF = 'application/pdf';
const documentType = (key: string, label: string, checklist: string[]): BaselineEntry =>
  entry('DOCUMENT_TYPE', key, label, { checklist, mime_types: [PDF, 'image/png', 'image/jpeg'], max_size_mb: 50 });
const contractType = (key: string, label: string, versionPolicy: string, isAnnex = false): BaselineEntry =>
  entry('CONTRACT_TYPE', key, label, { required_fields: ['number', 'signed_on', 'contractor', 'value'], version_policy: versionPolicy, ...(isAnnex ? { is_annex: true } : {}) });
const paymentType = (key: string, label: string, kind: string, conditions: string[]): BaselineEntry => entry('PAYMENT_TYPE', key, label, { kind, conditions });
const priority = (key: string, label: string, rank: number, response: number, resolution: number, calendar: string, escalate: number): BaselineEntry =>
  entry('PRIORITY', key, label, { rank, response_hours: response, resolution_hours: resolution, working_calendar: calendar, escalate_after_hours: escalate });
const criterion = (key: string, label: string, category: string, evidence: boolean): BaselineEntry =>
  entry('CONTRACTOR_CRITERION', key, label, { category, scale_max: 10, evidence_required: evidence });
const purpose = (key: string, label: string, consent: string, level: string): BaselineEntry => entry('CONTACT_PURPOSE', key, label, { consent, security_level: level });
const retention = (key: string, label: string, classification: string, years: number | undefined, hold: boolean): BaselineEntry =>
  entry(
    'RETENTION_POLICY',
    key,
    label,
    {
      owner_module: 'DGV',
      awaiting_confirmation: true,
      cxn: 'CXN-05',
      data_class: key,
      classification,
      ...(years === undefined ? { permanent: true } : { retention_years: years }),
      legal_hold_allowed: hold,
    },
    { legalBasis: 'Thời hạn lưu trữ theo MDM 3.1 mục 6, chờ xác nhận văn bản gốc [CXN-05]' },
  );

/**
 * The operational catalogues that the other modules select from (ST-MDM-005): document, contract and payment types, priorities and their
 * response times, criteria to evaluate contractors, expert roles, contact purposes with their consent, languages and the retention of
 * each class of data. The response times and retention periods are working assumptions until the owners confirm them (CXN-05 for the
 * retention); a change is a new version through a change request, never an edit.
 */
const OPERATIONAL_CATALOGUES: readonly BaselineEntry[] = [
  documentType('DECISION', 'Quyết định', ['number', 'issued_on', 'signature']),
  documentType('OFFICIAL_LETTER', 'Công văn', ['number', 'issued_on']),
  documentType('CONTRACT_FILE', 'Hồ sơ hợp đồng', ['signed_copy', 'annexes']),
  documentType('PAYMENT_VOUCHER', 'Chứng từ thanh toán', ['request', 'acceptance', 'invoice']),
  documentType('ACCEPTANCE_MINUTES', 'Biên bản nghiệm thu', ['signatures', 'quantities']),
  contractType('CONSTRUCTION', 'Hợp đồng thi công xây dựng', 'NEW_REVISION'),
  contractType('SUPPLY', 'Hợp đồng cung cấp hàng hóa', 'NEW_REVISION'),
  contractType('CONSULTING', 'Hợp đồng tư vấn', 'NEW_REVISION'),
  contractType('ANNEX', 'Phụ lục hợp đồng', 'ANNEX_ONLY', true),
  paymentType('ADVANCE', 'Tạm ứng', 'ADVANCE', ['guarantee_in_place', 'contract_signed']),
  paymentType('INTERIM', 'Thanh toán đợt', 'PAYMENT', ['acceptance_signed', 'within_contract_value']),
  paymentType('FINAL', 'Thanh toán cuối cùng', 'PAYMENT', ['final_acceptance', 'advance_recovered']),
  paymentType('RETENTION_RELEASE', 'Hoàn trả tiền bảo hành', 'RETENTION_RELEASE', ['warranty_period_ended']),
  priority('URGENT', 'Khẩn cấp', 1, 4, 24, 'ALL_DAYS', 12),
  priority('HIGH', 'Cao', 2, 8, 72, 'WORKING_DAYS', 48),
  priority('NORMAL', 'Bình thường', 3, 24, 168, 'WORKING_DAYS', 120),
  priority('LOW', 'Thấp', 4, 72, 336, 'WORKING_DAYS', 240),
  criterion('QUALITY_OF_WORK', 'Chất lượng công trình', 'QUALITY', true),
  criterion('SCHEDULE_ADHERENCE', 'Tiến độ thực hiện', 'SCHEDULE', true),
  criterion('SAFETY_RECORD', 'An toàn lao động', 'SAFETY', true),
  criterion('COST_DISCIPLINE', 'Kỷ luật chi phí', 'COST', false),
  criterion('LEGAL_COMPLIANCE', 'Tuân thủ pháp luật', 'COMPLIANCE', true),
  entry('EXPERT_ROLE', 'PROJECT_MANAGER', 'Chủ nhiệm dự án', { specialty: 'project_management', conditions: ['certificate_in_force'] }),
  entry('EXPERT_ROLE', 'SUPERVISION_ENGINEER', 'Kỹ sư giám sát', { specialty: 'construction_supervision', conditions: ['certificate_in_force'] }),
  entry('EXPERT_ROLE', 'COST_ESTIMATOR', 'Chuyên gia dự toán', { specialty: 'cost_estimation' }),
  purpose('SERVICE_NOTICE', 'Thông báo dịch vụ', 'NOT_REQUIRED', 'INTERNAL'),
  purpose('SATISFACTION_SURVEY', 'Khảo sát hài lòng', 'EXPLICIT', 'INTERNAL'),
  purpose('SENSITIVE_FOLLOW_UP', 'Trao đổi vụ việc nhạy cảm', 'EXPLICIT', 'CONFIDENTIAL'),
  entry('LANGUAGE', 'vi', 'Tiếng Việt', { native_name: 'Tiếng Việt' }),
  entry('LANGUAGE', 'en', 'Tiếng Anh', { native_name: 'English' }),
  retention('FINANCIAL_RECORD', 'Chứng từ và sổ sách tài chính', 'CONFIDENTIAL', 10, true),
  retention('CONTRACT_RECORD', 'Hồ sơ hợp đồng', 'CONFIDENTIAL', 10, true),
  retention('CHANGE_REQUEST', 'Đề xuất thay đổi danh mục', 'INTERNAL', 10, false),
  retention('IMPORT_BATCH', 'Lô nhập dữ liệu', 'INTERNAL', 5, false),
  retention('MASTER_DATA', 'Dữ liệu chủ và lịch sử phiên bản', 'INTERNAL', undefined, false),
];

/**
 * The reporting calendar, the units and the currencies (ST-MDM-004). The calendar is the D03 working assumption (weeks from Saturday to
 * Friday, due on Friday at 10:00 in Vietnam) until the owner of the capital business signs it: it is data, so another decision is a new
 * version and no code change.
 */
const CALENDAR_AND_UNITS: readonly BaselineEntry[] = [
  entry(
    'CALENDAR',
    'DEFAULT',
    'Lịch kỳ báo cáo tuần',
    {
      owner_module: 'DIS',
      awaiting_confirmation: true,
      cxn: 'ASSUMPTION-D03',
      week_starts_on: 'SATURDAY',
      deadline_weekday: 'FRIDAY',
      deadline_time: '10:00',
      timezone: 'Asia/Ho_Chi_Minh',
    },
    { legalBasis: 'Giả định D03 chờ chủ nghiệp vụ vốn ký: tuần từ thứ Bảy đến thứ Sáu, hạn nộp thứ Sáu 10:00 (+07)' },
  ),
  unit('M', 'Mét', 'LENGTH', '1', 2),
  unit('KM', 'Ki-lô-mét', 'LENGTH', '1000', 3),
  unit('M2', 'Mét vuông', 'AREA', '1', 2),
  unit('HA', 'Héc-ta', 'AREA', '10000', 4),
  unit('M3', 'Mét khối', 'VOLUME', '1', 2),
  unit('KG', 'Ki-lô-gam', 'MASS', '1', 3),
  unit('TON', 'Tấn', 'MASS', '1000', 3),
  unit('PCS', 'Cái, bộ', 'COUNT', '1', 0),
  currency('VND', 'Đồng Việt Nam', 0),
  currency('USD', 'Đô la Mỹ', 2),
  currency('EUR', 'Euro', 2),
  currency('JPY', 'Yên Nhật', 0),
];

/**
 * The first baseline (MDM 3.1 F8, ST-MDM-003): the funding source tree with the national target programmes inside their budget
 * source, the sectors, the project groups, types and stages (the stage graph of PRJ 3.1), the decision types and authorities, and the
 * rule data. A rule that waits for a confirmation says which one; until it arrives the rule is a working assumption that the screens
 * that apply it label as such. An entry comes before every entry that refers to it.
 */
const ENTRIES: readonly BaselineEntry[] = [
  fund('NSTW', 'Ngân sách trung ương', 'NSTW', 'ADDITIVE'),
  fund('NSTW-DTPT', 'Vốn đầu tư phát triển ngân sách trung ương', 'NSTW', 'ADDITIVE', 'NSTW'),
  fund('NSDP', 'Ngân sách địa phương', 'NSDP', 'ADDITIVE'),
  fund('NSDP-DTPT', 'Vốn đầu tư phát triển ngân sách địa phương', 'NSDP', 'ADDITIVE', 'NSDP'),
  fund('ODA-NONLEND', 'Vốn ODA không vay lại', 'ODA', 'ADDITIVE', undefined, { onlending: false }),
  fund('ODA-ONLEND', 'Vốn ODA vay lại', 'ODA', 'ADDITIVE', undefined, { onlending: true }),
  fund('CTMTQG-NTM', 'Chương trình mục tiêu quốc gia xây dựng nông thôn mới', 'CTMTQG', 'SUBSET_OF', 'NSTW-DTPT'),
  fund('CTMTQG-GNBV', 'Chương trình mục tiêu quốc gia giảm nghèo bền vững', 'CTMTQG', 'SUBSET_OF', 'NSTW-DTPT'),
  fund('CTMTQG-DTTS', 'Chương trình mục tiêu quốc gia phát triển kinh tế - xã hội vùng đồng bào dân tộc thiểu số và miền núi', 'CTMTQG', 'SUBSET_OF', 'NSTW-DTPT'),
  entry('PROGRAM', 'NTM', 'Xây dựng nông thôn mới', { kind: 'CTMTQG', period_from: 2021, period_to: 2025, fund_source_key: 'CTMTQG-NTM' }),
  entry('PROGRAM', 'GNBV', 'Giảm nghèo bền vững', { kind: 'CTMTQG', period_from: 2021, period_to: 2025, fund_source_key: 'CTMTQG-GNBV' }),
  entry('PROGRAM', 'DTTS', 'Phát triển kinh tế - xã hội vùng đồng bào dân tộc thiểu số và miền núi', { kind: 'CTMTQG', period_from: 2021, period_to: 2025, fund_source_key: 'CTMTQG-DTTS' }),
  ...[
    ['TRANSPORT', 'Giao thông'],
    ['AGRICULTURE', 'Nông nghiệp và phát triển nông thôn'],
    ['EDUCATION', 'Giáo dục và đào tạo'],
    ['HEALTH', 'Y tế'],
    ['CULTURE_SPORT', 'Văn hóa, thể thao'],
    ['ENVIRONMENT', 'Tài nguyên và môi trường'],
    ['ICT', 'Công nghệ thông tin và chuyển đổi số'],
    ['URBAN', 'Hạ tầng đô thị và cấp thoát nước'],
  ].map(([key, label], index) => entry('SECTOR', key as string, label as string, { sort_order: (index + 1) * 10 })),
  entry('PROJECT_GROUP', 'QTQG', 'Dự án quan trọng quốc gia', { rank: 1 }, { legalBasis: LAW }),
  entry('PROJECT_GROUP', 'A', 'Dự án nhóm A', { rank: 2 }, { legalBasis: LAW }),
  entry('PROJECT_GROUP', 'B', 'Dự án nhóm B', { rank: 3 }, { legalBasis: LAW }),
  entry('PROJECT_GROUP', 'C', 'Dự án nhóm C', { rank: 4 }, { legalBasis: LAW }),
  entry('PROJECT_TYPE', 'NEW_BUILD', 'Đầu tư xây dựng mới', { kind: 'CAPITAL_WORKS' }),
  entry('PROJECT_TYPE', 'UPGRADE', 'Cải tạo, nâng cấp, mở rộng', { kind: 'CAPITAL_WORKS' }),
  entry('PROJECT_TYPE', 'PROCUREMENT', 'Mua sắm tài sản, trang thiết bị', { kind: 'PROCUREMENT' }),
  entry('PROJECT_TYPE', 'PREPARATION', 'Chuẩn bị đầu tư', { kind: 'PREPARATION' }),
  stage('CONCEPT', 'Ý tưởng', 1, ['APPRAISAL', 'CANCELLED']),
  stage('APPRAISAL', 'Thẩm định', 2, ['PIPELINE', 'REJECTED', 'CONCEPT', 'CANCELLED']),
  stage('PIPELINE', 'Ngân hàng dự án', 3, ['BUDGETED', 'CANCELLED']),
  stage('BUDGETED', 'Đã bố trí vốn', 4, ['IMPLEMENTATION', 'CANCELLED']),
  stage('IMPLEMENTATION', 'Đang thực hiện', 5, ['SUSPENDED', 'COMPLETED']),
  stage('SUSPENDED', 'Tạm dừng', 6, ['IMPLEMENTATION']),
  stage('COMPLETED', 'Hoàn thành', 7, ['SETTLED']),
  stage('SETTLED', 'Đã quyết toán', 8, ['CLOSED']),
  stage('CLOSED', 'Đã đóng', 9, [], true),
  stage('REJECTED', 'Bị từ chối', 10, [], true),
  stage('CANCELLED', 'Đã hủy', 11, [], true),
  decisionType('INVESTMENT_POLICY', 'Quyết định chủ trương đầu tư', ['number', 'issued_on', 'issuing_authority', 'total_investment']),
  decisionType('INVESTMENT_DECISION', 'Quyết định đầu tư', ['number', 'issued_on', 'issuing_authority', 'total_investment']),
  decisionType('PLAN_ASSIGNMENT', 'Quyết định giao kế hoạch vốn', ['number', 'issued_on', 'issuing_authority', 'plan_year']),
  decisionType('SETTLEMENT_APPROVAL', 'Quyết định phê duyệt quyết toán', ['number', 'issued_on', 'issuing_authority', 'settled_amount']),
  authority('NA-POLICY', 'Quốc hội quyết định chủ trương đầu tư', 'NATIONAL_ASSEMBLY', 'INVESTMENT_POLICY', 'NATIONAL'),
  authority('PM-POLICY', 'Thủ tướng Chính phủ quyết định chủ trương đầu tư', 'PRIME_MINISTER', 'INVESTMENT_POLICY', 'NATIONAL'),
  authority('PC-POLICY', 'Hội đồng nhân dân tỉnh quyết định chủ trương đầu tư', 'PROVINCIAL_PEOPLES_COUNCIL', 'INVESTMENT_POLICY', 'PROVINCE'),
  authority('PCOM-DECISION', 'Ủy ban nhân dân tỉnh quyết định đầu tư', 'PROVINCIAL_PEOPLES_COMMITTEE', 'INVESTMENT_DECISION', 'PROVINCE'),
  authority('CCOM-DECISION', 'Ủy ban nhân dân xã quyết định đầu tư', 'COMMUNE_PEOPLES_COMMITTEE', 'INVESTMENT_DECISION', 'COMMUNE'),
  entry(
    'PROJECT_GROUP_THRESHOLDS',
    'DEFAULT',
    'Ngưỡng nhóm dự án theo tổng mức đầu tư',
    {
      owner_module: 'PRJ',
      awaiting_confirmation: true,
      cxn: 'CXN-32',
      bands: [band(null, 'C', '0', '120000000000'), band(null, 'B', '120000000000', '2300000000000'), band(null, 'A', '2300000000000', '30000000000000'), band(null, 'QTQG', '30000000000000', null)],
    },
    { legalBasis: `${LAW} — bảng ngưỡng chờ xác nhận [CXN-32]` },
  ),
  entry(
    'NATIONAL_CODE_REQUIRED',
    'DEFAULT',
    'Mã số dự án quốc gia bắt buộc từ ngân hàng dự án',
    { owner_module: 'CAP', awaiting_confirmation: true, cxn: 'CXN-01', mode: 'BLOCK', from_stage_key: 'PIPELINE' },
    { legalBasis: 'Quy định mã số dự án trên hệ thống thông tin quốc gia về đầu tư công — văn bản gốc chờ xác nhận [CXN-01]' },
  ),
  entry(
    'NATIONAL_CODE_FORMAT',
    'DEFAULT',
    'Định dạng mã số dự án quốc gia',
    { owner_module: 'CAP', awaiting_confirmation: true, cxn: 'CXN-01', pattern: '^\\d{7}$', example: '7654321' },
    { legalBasis: 'Quy định mã số dự án trên hệ thống thông tin quốc gia về đầu tư công — văn bản gốc chờ xác nhận [CXN-01]' },
  ),
  entry(
    'APPRAISAL_CRITERIA',
    'APPR-CRIT-2026r1',
    'Bộ tiêu chí thẩm định đề xuất chủ trương 2026 (bản 1)',
    {
      owner_module: 'PRJ',
      awaiting_confirmation: true,
      cxn: 'ASSUMPTION-APPRAISAL-60',
      criteria: [
        { code: 'POLICY_ALIGNMENT', name: 'Phù hợp chiến lược, quy hoạch và định hướng đầu tư', max_score: 25 },
        { code: 'FEASIBILITY', name: 'Tính khả thi về kỹ thuật và tổ chức thực hiện', max_score: 25 },
        { code: 'EFFECTIVENESS', name: 'Hiệu quả kinh tế - xã hội', max_score: 20 },
        { code: 'CAPITAL_READINESS', name: 'Khả năng cân đối nguồn vốn', max_score: 20 },
        { code: 'RISK', name: 'Rủi ro và biện pháp giảm thiểu', max_score: 10 },
      ],
      pass_threshold: 60,
    },
    { legalBasis: 'Bộ tiêu chí do cơ quan tài chính ban hành — giả định chờ ban hành chính thức' },
  ),
];

const LAND_LAW = 'Luật Đất đai 2024 và Nghị định 88/2024/NĐ-CP — số ngày chờ xác nhận văn bản gốc [CXN-12]';
const landTimer = (key: string, label: string, days: number): BaselineEntry =>
  entry('LND_TIMER', key, label, { owner_module: 'LND', awaiting_confirmation: true, cxn: 'CXN-12', days, day_count: 'CALENDAR' }, { legalBasis: LAND_LAW });

/** The timers of land clearance (BR-LND-01): calendar days, flagged with the confirmation they wait for. */
const LAND_TIMERS: readonly BaselineEntry[] = [
  landTimer('NOTICE_AGRICULTURAL_90', 'Thông báo thu hồi đất nông nghiệp trước 90 ngày', 90),
  landTimer('NOTICE_NON_AGRICULTURAL_180', 'Thông báo thu hồi đất phi nông nghiệp trước 180 ngày', 180),
  landTimer('PLAN_POSTING_30', 'Niêm yết phương án bồi thường tối thiểu 30 ngày', 30),
  landTimer('PAYMENT_30', 'Chi trả bồi thường trong 30 ngày kể từ phê duyệt', 30),
  landTimer('COMPLAINT_RESOLUTION', 'Hạn giải quyết khiếu nại về bồi thường', 30),
];

const PETITION_LAW = 'Luật Đấu thầu 22/2023/QH15 (sửa bởi Luật 90/2025/QH15) về kiến nghị trong lựa chọn nhà thầu — thời hạn chờ xác nhận văn bản gốc [CXN-BID-02]';
const petitionDeadline = (key: string, label: string, days: number): BaselineEntry =>
  entry('BID_PETITION', key, label, { owner_module: 'BID', awaiting_confirmation: true, cxn: 'CXN-BID-02', days, day_count: 'CALENDAR' }, { legalBasis: PETITION_LAW });

/** The deadlines to answer a petition of a contractor (BR-BID-14): calendar days, the stricter reading, flagged with the confirmation they wait for. A tenant that counts working days publishes a version that names its calendar. */
const PETITION_DEADLINES: readonly BaselineEntry[] = [
  petitionDeadline('PROCESS', 'Hạn trả lời kiến nghị về quá trình lựa chọn nhà thầu', 7),
  petitionDeadline('RESULT', 'Hạn trả lời kiến nghị về kết quả lựa chọn nhà thầu', 7),
];

const REGIME_LAW = 'Nghị định 06/2021/NĐ-CP về quản lý chất lượng, thi công xây dựng và bảo trì công trình và văn bản thay thế dự kiến Nghị định 207/2026 — nội dung chờ xác nhận văn bản gốc [CXN-07]';
const checklist = (inspectionType: string, items: Array<[string, string]>) => ({ inspection_type: inspectionType, items: items.map(([code, label]) => ({ code, label })) });
/** The checklists of the working assumption: what the supervisor checks for each kind of inspection, until the owner of the construction business signs the regime. */
const REGIME_CHECKLISTS = [
  checklist('MATERIAL_ENTRY', [['ORIGIN', 'Hồ sơ xuất xứ và chứng nhận chất lượng vật liệu'], ['SAMPLE', 'Mẫu vật liệu khớp với hồ sơ đã đăng ký']]),
  checklist('CONCEALED_WORK', [['DRAWING', 'Thi công đúng hồ sơ thiết kế được duyệt'], ['QUALITY', 'Chất lượng công việc che khuất đạt yêu cầu'], ['RECORD', 'Hồ sơ nghiệm thu nội bộ của nhà thầu đầy đủ']]),
  checklist('CONSTRUCTION_STAGE', [['DRAWING', 'Thi công đúng hồ sơ thiết kế được duyệt'], ['QUALITY', 'Chất lượng giai đoạn thi công đạt yêu cầu']]),
  checklist('PART_ACCEPTANCE', [['DRAWING', 'Thi công đúng hồ sơ thiết kế được duyệt'], ['QUALITY', 'Chất lượng bộ phận công trình đạt yêu cầu']]),
  checklist('COMPLETION', [['DRAWING', 'Thi công đúng hồ sơ thiết kế được duyệt'], ['QUALITY', 'Chất lượng hạng mục hoặc công trình đạt yêu cầu'], ['DOSSIER', 'Hồ sơ hoàn thành công trình đầy đủ']]),
  checklist('SAFETY', [['MEASURES', 'Biện pháp an toàn lao động được thực hiện'], ['EQUIPMENT', 'Thiết bị và phương tiện bảo hộ đạt yêu cầu']]),
  checklist('OTHER', [['CONTENT', 'Nội dung kiểm tra theo đề nghị được thực hiện']]),
];
const regime = (key: string, label: string, requiredRoles: string[], validFrom: string, validUntil?: string): BaselineEntry =>
  entry(
    'QMS_REGIME',
    key,
    label,
    { owner_module: 'QMS', awaiting_confirmation: true, cxn: 'CXN-07', required_roles: requiredRoles, completion_required_roles: ['CONTRACTOR', 'SUPERVISOR', 'OWNER', 'DESIGNER'], checklists: REGIME_CHECKLISTS },
    { legalBasis: REGIME_LAW, validFrom, ...(validUntil === undefined ? {} : { validUntil }) },
  );

/** The regimes of quality management (BR-QMS-04): the current decree until the end of 2026 and the one that replaces it from 2027, both flagged with the confirmation they wait for. */
const QMS_REGIMES: readonly BaselineEntry[] = [
  regime('ND-06-2021', 'Quy chế Nghị định 06/2021/NĐ-CP', ['CONTRACTOR', 'SUPERVISOR', 'OWNER'], SINCE, '2027-01-01'),
  regime('ND-207-2026', 'Quy chế Nghị định 207/2026/NĐ-CP (dự kiến)', ['CONTRACTOR', 'SUPERVISOR', 'OWNER', 'DESIGNER'], '2027-01-01'),
];

const ADVANCE_LAW = 'Nghị định 254/2025/NĐ-CP về điều kiện và mức tạm ứng hợp đồng (thay Nghị định 99/2021) — mức trần và ngưỡng thu hồi là số liệu thử, không phải quy định, chờ kiểm văn bản gốc [CXN-02]';
const advanceCap = (key: string, label: string, tiers: Array<{ min_value_vnd: string; cap_pct: string }>): BaselineEntry =>
  entry('PAY_ADVANCE_CAP', key, label, { owner_module: 'PAY', awaiting_confirmation: true, cxn: 'CXN-02', tiers, recovery_threshold_pct: '80' }, { legalBasis: ADVANCE_LAW });

/** The caps of the advance (BR-PAY-10): the fixture of the acceptance tests, flagged as such. A category with no row cannot be advanced until its owner publishes one. */
const ADVANCE_CAPS: readonly BaselineEntry[] = [
  advanceCap('CONSTRUCTION', 'Trần tạm ứng hợp đồng thi công (số liệu thử)', [{ min_value_vnd: '10000000000', cap_pct: '20' }]),
  advanceCap('CONSULTING', 'Trần tạm ứng hợp đồng tư vấn (số liệu thử)', [{ min_value_vnd: '0', cap_pct: '30' }]),
  entry('PAY_ADVANCE_GPMB', 'GPMB', 'Hạn thu hồi tạm ứng giải phóng mặt bằng', { owner_module: 'PAY', awaiting_confirmation: true, cxn: 'CXN-12', recovery_days: 30 }, { legalBasis: 'Hạn thu hồi tạm ứng bồi thường, hỗ trợ, tái định cư — số ngày chờ xác nhận văn bản gốc [CXN-12]' }),
];

export const BASELINE_PACK: BaselinePack = sealPack('PLATFORM-2026.1', [...ENTRIES, ...CALENDAR_AND_UNITS, ...OPERATIONAL_CATALOGUES, ...LAND_TIMERS, ...PETITION_DEADLINES, ...QMS_REGIMES, ...ADVANCE_CAPS]);

export interface BaselineResult {
  created: number;
  /** Entries that gained a version because the pack carries a later one. */
  superseded: number;
  unchanged: number;
}

const contentOf = (item: BaselineEntry, parentRecordId: string | null): MasterContent => ({
  label: item.label,
  attributes: item.attributes,
  parentRecordId,
  validFrom: item.validFrom,
  validUntil: item.validUntil ?? null,
  legalBasis: item.legalBasis ?? null,
});

/**
 * Gives an entry that the tenant already has the version the pack carries, when it is a new one: false when some version of the entry
 * has this very content (a pack applied twice, or an older pack applied after a newer one).
 */
async function supersede(tx: TenantTx, recordId: string, item: BaselineEntry, content: MasterContent, actor: string, on: string): Promise<boolean> {
  const hash = contentHashOf(item.masterType, item.businessKey, content);
  const versions = await tx.query<{ id: string; revision: number; valid_from: string; valid_until: string | null; content_sha256: string | null }>(
    'select id, revision, valid_from::text as valid_from, valid_until::text as valid_until, content_sha256 from machvon.master_record_version where master_record_id = $1::uuid order by revision desc',
    [recordId],
  );
  if (versions.some((version) => version.content_sha256 === hash)) return false;
  const latest = versions[0];
  if (latest === undefined || item.validFrom <= latest.valid_from) throw new Error(`baseline entry ${item.masterType}/${item.businessKey} would change a version that is already in force`);
  if (latest.valid_until === null || latest.valid_until > item.validFrom) {
    await tx.query('update machvon.master_record_version set valid_until = $2::date, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid', [latest.id, item.validFrom, actor]);
  }
  const inForce = item.validFrom <= on;
  const created = await tx.query<{ id: string }>(
    `insert into machvon.master_record_version
       (tenant_id, id, master_record_id, master_type, code, revision, label, parent_id, attributes, valid_from, valid_until, status, namespace, source_system, supersedes_id,
        legal_basis, content_sha256, approved_by, published_at, created_by, updated_by)
     values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2, $3, $4, $5, $6::uuid, $7::jsonb, $8::date, $9::date, $10, 'PLATFORM', $11,
        $12::uuid, $13, $14, $15::uuid, now(), $15::uuid, $15::uuid)
     returning id`,
    [
      recordId,
      item.masterType,
      item.businessKey,
      latest.revision + 1,
      item.label,
      content.parentRecordId,
      JSON.stringify(item.attributes),
      item.validFrom,
      item.validUntil ?? null,
      inForce ? 'EFFECTIVE' : 'APPROVED',
      BASELINE_SOURCE,
      latest.id,
      item.legalBasis ?? null,
      hash,
      actor,
    ],
  );
  if (inForce) {
    // Every earlier version ends here, one that never became active too: the activation job would otherwise put it back in force.
    await tx.query("update machvon.master_record_version set status = 'RETIRED' where master_record_id = $1::uuid and revision < $2 and status in ('EFFECTIVE', 'APPROVED')", [recordId, latest.revision + 1]);
    await tx.query('update machvon.master_record set current_version_id = $2::uuid, status = $3, updated_at = now(), updated_by = $4::uuid, version = version + 1 where id = $1::uuid', [
      recordId,
      (created[0] as { id: string }).id,
      'EFFECTIVE',
      actor,
    ]);
  }
  return true;
}

/**
 * Applies a signed baseline pack to the tenant (job `master-baseline-sync`, MDM 3.1 §9): the digest is verified first, every entry
 * meets the rules of its type (the pack may refer to its own entries), and an entry the tenant already has is left alone. The entries
 * are written in the namespace PLATFORM, in force from their date, and carry the digest of their content; a tenant never edits them.
 * A later pack may carry a newer version of an entry: it starts at its own date and the version before it ends there, so the history
 * is never rewritten. A pack that would change a version already in force from a date at or before it is refused.
 */
export async function applyBaseline(tx: TenantTx, pack: BaselinePack, actor: string, on: string = vietnamDateOf(new Date())): Promise<BaselineResult> {
  if (packDigest(pack.entries) !== pack.sha256) throw new Error(`baseline pack ${pack.id} does not match its digest`);
  const database = tenantLookup(tx);
  const inPack = new Map<string, EntryRef>(pack.entries.map((item) => [`${item.masterType}:${item.businessKey}`, { masterType: item.masterType, businessKey: item.businessKey, attributes: item.attributes }]));
  const lookup: TypeLookup = { entry: async (masterType, businessKey) => inPack.get(`${masterType}:${businessKey}`) ?? (await database.entry(masterType, businessKey)) };
  const recordIds = new Map<string, string>();
  let created = 0;
  let superseded = 0;
  let unchanged = 0;
  for (const item of pack.entries) {
    const existing = await tx.query<{ id: string }>("select id from machvon.master_record where namespace = 'PLATFORM' and master_type = $1 and business_key = $2 for update", [item.masterType, item.businessKey]);
    const parentRecordId = item.parentKey === undefined ? null : (recordIds.get(`${item.masterType}:${item.parentKey}`) ?? null);
    if (item.parentKey !== undefined && parentRecordId === null) throw new Error(`baseline entry ${item.masterType}/${item.businessKey} names a parent that is not in the pack before it`);
    const content = contentOf(item, parentRecordId);
    await validateMasterContent({
      masterType: item.masterType,
      businessKey: item.businessKey,
      content,
      parent: item.parentKey === undefined ? undefined : inPack.get(`${item.masterType}:${item.parentKey}`),
      lookup,
    });
    if (existing[0] !== undefined) {
      recordIds.set(`${item.masterType}:${item.businessKey}`, existing[0].id);
      if (await supersede(tx, existing[0].id, item, content, actor, on)) superseded += 1;
      else unchanged += 1;
      continue;
    }
    const inForce = item.validFrom <= on;
    const recordId = randomUUID();
    const versionId = randomUUID();
    await tx.query(
      `insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, 'PLATFORM', $2, $3, $4, $5::uuid, $5::uuid)`,
      [recordId, item.masterType, item.businessKey, inForce ? 'EFFECTIVE' : 'APPROVED', actor],
    );
    await tx.query(
      `insert into machvon.master_record_version
         (tenant_id, id, master_record_id, master_type, code, revision, label, parent_id, attributes, valid_from, valid_until, status, namespace, source_system,
          legal_basis, content_sha256, approved_by, published_at, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4, 1, $5, $6::uuid, $7::jsonb, $8::date, $9::date, $10, 'PLATFORM', $11,
          $12, $13, $14::uuid, now(), $14::uuid, $14::uuid)`,
      [
        versionId,
        recordId,
        item.masterType,
        item.businessKey,
        item.label,
        parentRecordId,
        JSON.stringify(item.attributes),
        item.validFrom,
        item.validUntil ?? null,
        inForce ? 'EFFECTIVE' : 'APPROVED',
        BASELINE_SOURCE,
        item.legalBasis ?? null,
        contentHashOf(item.masterType, item.businessKey, content),
        actor,
      ],
    );
    if (inForce) await tx.query('update machvon.master_record set current_version_id = $2::uuid where id = $1::uuid', [recordId, versionId]);
    recordIds.set(`${item.masterType}:${item.businessKey}`, recordId);
    created += 1;
  }
  // The connectors that feed master data exist for every tenant, with their adapter still PROPOSED.
  await new IntegrationCursorStore().ensureDefaults(tx, actor);
  // The definitions of the disbursement figures wait for the signature of the capital business owner (D03): in review, never published here.
  await new GlossaryStore().ensureDisbursementTerms(tx, actor);
  if (created + superseded > 0) {
    await enqueueOutbox(tx, {
      aggregateType: 'master_baseline',
      aggregateId: randomUUID(),
      aggregateVersion: 1,
      type: BASELINE_EVENT,
      schemaVersion: 1,
      payload: { pack_id: pack.id, sha256: pack.sha256, created, superseded, unchanged },
      eventKey: `master_baseline:${pack.id}:${pack.sha256}`,
      correlationId: randomUUID(),
    });
  }
  return { created, superseded, unchanged };
}
