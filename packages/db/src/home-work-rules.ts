import type { WorkBucket, WorkKind } from '@machvon/kernel';

/** How urgent an item of the alert centre is: "Khẩn", "Cần xử lý", "Theo dõi". */
export type WorkSeverity = 'URGENT' | 'ACTION' | 'WATCH';
export const WORK_SEVERITIES: readonly WorkSeverity[] = ['URGENT', 'ACTION', 'WATCH'];

/** The module source an item comes from (the `source` of `WorkActionTarget`). */
export const WORK_SOURCES = ['APPROVAL', 'EXPLANATION', 'EXPLANATION_CONCLUDE', 'REPORT', 'OBLIGATION', 'EARLY_WARNING', 'ADVANCE', 'PERMIT', 'AUDIT_RECOMMENDATION', 'ISSUE', 'SITE_DIARY', 'GUARANTEE', 'MONEY_CONTROL', 'DIRECTIVE', 'CLOCK', 'PROCUREMENT_WORKFLOW', 'TREASURY_RECON', 'CROSS_TOTAL', 'SOD_EXCEPTION', 'PAYMENT_INTEGRITY', 'DISBURSEMENT_EXCEPTION', 'PROJECT_GOVERNANCE'] as const;
export type WorkSource = (typeof WORK_SOURCES)[number];

/** Read is not handled: a new item, one somebody took up, one that is being worked on (given to someone, or in the hands of its module), and one that is done. */
export type WorkLifecycle = 'NEW' | 'CLAIMED' | 'IN_PROGRESS' | 'RESOLVED';
const LIFECYCLE_RANK: Readonly<Record<WorkLifecycle, number>> = { NEW: 0, CLAIMED: 1, IN_PROGRESS: 2, RESOLVED: 3 };
export const furtherLifecycle = (left: WorkLifecycle, right: WorkLifecycle): WorkLifecycle => (LIFECYCLE_RANK[right] > LIFECYCLE_RANK[left] ? right : left);

/** Where an item that was not handled stands on its way up: the level, how many levels there are, when the next level is reached (null when it is not known) and the name of each level. */
export interface WorkEscalation {
  level: number;
  of: number;
  nextAt: string | null;
  chain: string[];
}

/** The module source of each kind of work that was there before the alert centre. */
export const SOURCE_OF_KIND: Readonly<Record<WorkKind, WorkSource>> = {
  APPROVAL: 'APPROVAL',
  EXPLANATION: 'EXPLANATION',
  REPORT_RETURNED: 'REPORT',
  REPORT_DRAFT_OVERDUE: 'REPORT',
  EXPLANATION_REVIEW: 'EXPLANATION_CONCLUDE',
  MNE_OBLIGATION: 'OBLIGATION',
  EARLY_WARNING: 'EARLY_WARNING',
  ADVANCE_OVERDUE: 'ADVANCE',
  PERMIT_EXPIRY: 'PERMIT',
  AUDIT_RECOMMENDATION_OVERDUE: 'AUDIT_RECOMMENDATION',
  ISSUE_SLA_BREACH: 'ISSUE',
  SITE_DIARY_MISSING: 'SITE_DIARY',
  GUARANTEE_EXPIRING: 'GUARANTEE',
  EAC_EXCEEDS_TMDT: 'MONEY_CONTROL',
  RESERVE_BELOW_RISK_EV: 'MONEY_CONTROL',
  ADVANCE_EXCEEDS_REMAINING: 'MONEY_CONTROL',
  DIRECTIVE_DUE: 'DIRECTIVE',
  DIRECTIVE_OVERDUE: 'DIRECTIVE',
  CLOCK_DEADLINE: 'CLOCK',
  PRC_STEP_OVERDUE: 'PROCUREMENT_WORKFLOW',
  PRC_CHECKLIST_DUE: 'PROCUREMENT_WORKFLOW',
  PRC_PACKAGE_STALLED: 'PROCUREMENT_WORKFLOW',
  PRC_NO_OWNER: 'PROCUREMENT_WORKFLOW',
  TREASURY_RECON_ITEM_OVERDUE: 'TREASURY_RECON',
  CROSS_TOTAL_MISMATCH: 'CROSS_TOTAL',
  SOD_EXCEPTION_EXPIRING: 'SOD_EXCEPTION',
  SOD_EXCEPTION_USED: 'SOD_EXCEPTION',
  PAYMENT_INTEGRITY_BLOCKED: 'PAYMENT_INTEGRITY',
  PAYMENT_INTEGRITY_SIGNAL: 'PAYMENT_INTEGRITY',
  DISBURSEMENT_EXCEPTION_EXPIRING: 'DISBURSEMENT_EXCEPTION',
  RESCHEDULE_COUNT: 'PROJECT_GOVERNANCE',
};

/**
 * Which severity a finding of a source has (design.md, "Alert centre"): data, not branches, so that the table is the one place that says it and a tenant's configuration can replace it.
 * The key of the second level is what the source found (`facet`).
 */
export type SeverityRules = Readonly<Record<string, Readonly<Record<string, WorkSeverity>>>>;
export const DEFAULT_SEVERITY_RULES: SeverityRules = {
  // HOME-03: a red warning is urgent, an amber one is to be acted on, an information one is to be watched.
  EARLY_WARNING: { CRITICAL: 'URGENT', WARNING: 'ACTION', INFO: 'WATCH' },
  // PAY-12: an advance that is overdue is to be acted on (the leader is told by the module when it is a week late).
  ADVANCE: { OVERDUE: 'ACTION' },
  // PMT-05: a permit that has expired is urgent, one that expires within 30 days is to be watched.
  PERMIT: { EXPIRED: 'URGENT', EXPIRING: 'WATCH' },
  // AUD-11: a recommendation that is overdue and was escalated is urgent; one that is overdue and not yet escalated is to be acted on.
  AUDIT_RECOMMENDATION: { ESCALATED: 'URGENT', OVERDUE: 'ACTION' },
  // ISS-09/10: a breach of the SLA at level 3 (the task force) is urgent, at level 1 or 2 it is to be acted on.
  ISSUE: { LEVEL_1: 'ACTION', LEVEL_2: 'ACTION', LEVEL_3: 'URGENT' },
  // QMS-11: a missing diary is to be watched.
  SITE_DIARY: { MISSING: 'WATCH' },
  // CTR-05: a guarantee within 30 days of its end is to be watched, within 7 days it is to be acted on.
  GUARANTEE: { EXPIRING: 'WATCH', EXPIRING_SOON: 'ACTION' },
  // G1-6, G1-7, G1-11: the estimate at completion above the approved total investment and an advance that the payments left cannot recover are urgent; a contingency below the expected value of the open risks is to be acted on.
  MONEY_CONTROL: { EAC_EXCEEDS_TMDT: 'URGENT', RESERVE_BELOW_RISK_EV: 'ACTION', ADVANCE_EXCEEDS_REMAINING: 'URGENT' },
  // DIR-1: a directive due within the reminder days or today is to be acted on; one that is past its day is to be acted on, and urgent from the escalation day (one week by default; the head of the unit sees it).
  DIRECTIVE: { DUE_SOON: 'ACTION', DUE_TODAY: 'ACTION', OVERDUE: 'ACTION', ESCALATED: 'URGENT' },
  // G0-2: a native clock is as urgent as the module that started it said, and urgent once its time has run out; one that ends within the day is to be acted on.
  CLOCK: { RUNNING: 'WATCH', DUE_SOON: 'ACTION', BREACHED: 'URGENT' },
  // PRC-1: a step past its day and a required item past its day are to be acted on, an item due within the warning days and a package that has not moved are to be watched, a package nobody answers for is to be acted on.
  PROCUREMENT_WORKFLOW: { STEP_OVERDUE: 'ACTION', CHECKLIST_OVERDUE: 'ACTION', CHECKLIST_DUE_SOON: 'WATCH', PACKAGE_STALLED: 'WATCH', NO_OWNER: 'ACTION' },
  // G4-4: an item of difference with the Treasury that is past its day is to be acted on (its owner answers for it; the indicator stays flagged and an issue is opened in ISS).
  TREASURY_RECON: { OVERDUE: 'ACTION' },
  // G4-5: three totals of the disbursed money that do not agree stop the publication of the indicator: to be acted on by the data steward.
  CROSS_TOTAL: { MISMATCH: 'ACTION' },
  // G4-1: an exception to the separation of duties that ends within the days of the matrix is to be acted on by the administrator; one that was used is to be watched by the auditor.
  SOD_EXCEPTION: { EXPIRING: 'ACTION', USED: 'WATCH' },
  // G4-2: a payment request that a check blocked is to be acted on; one that was sent with signals is to be watched by whoever approves it.
  PAYMENT_INTEGRITY: { BLOCKED: 'ACTION', SIGNAL: 'WATCH' },
  // G4-2: an exception to a ceiling of disbursement that lapses is to be watched.
  DISBURSEMENT_EXCEPTION: { EXPIRING: 'WATCH' },
  // G1-3 (lane B1): a milestone or an end date moved as many times as the rule says goes to the auditors, who acknowledge it with a note: to be acted on.
  PROJECT_GOVERNANCE: { RESCHEDULE_COUNT: 'ACTION' },
  // The work that was there before the alert centre has no severity of its own: what is late or due within the week is to be acted on, the rest is to be watched.
  APPROVAL: { OVERDUE: 'ACTION', NEAR: 'ACTION', LATER: 'WATCH' },
  EXPLANATION: { OVERDUE: 'ACTION', NEAR: 'ACTION', LATER: 'WATCH' },
  EXPLANATION_CONCLUDE: { OVERDUE: 'ACTION', NEAR: 'ACTION', LATER: 'WATCH' },
  REPORT: { OVERDUE: 'ACTION', NEAR: 'ACTION', LATER: 'WATCH' },
  OBLIGATION: { OVERDUE: 'ACTION', NEAR: 'ACTION', LATER: 'WATCH' },
};

/** The severity of a finding; a finding the table does not know is to be acted on (never hidden as "watch"). */
export function severityOf(source: WorkSource, facet: string, rules: SeverityRules = DEFAULT_SEVERITY_RULES): WorkSeverity {
  return rules[source]?.[facet] ?? 'ACTION';
}

export const bucketFacet = (bucket: WorkBucket): string => bucket;

/** After how many days overdue a recommendation of the audit is raised to the leader (AUD-11). */
export const AUDIT_ESCALATION_DAYS = 30;
/** How many days ahead a permit or a guarantee that comes to an end is shown. */
export const EXPIRY_WINDOW_DAYS = 30;
/** A guarantee that ends within this many days is to be acted on and no longer only watched. */
export const GUARANTEE_SOON_DAYS = 7;

export const SEVERITY_RANK: Readonly<Record<WorkSeverity, number>> = { URGENT: 0, ACTION: 1, WATCH: 2 };

/** What happens when the item is not done: one sentence, in the words of the user. */
export const CONSEQUENCES: Readonly<Record<string, string>> = {
  CLOCK: 'Thời hạn của việc này tính theo giờ làm việc; quá hạn sẽ bị ghi nhận là chậm và báo lên cấp trên.',
  APPROVAL: 'Hồ sơ chờ bạn duyệt bị dừng ở bước này cho đến khi có quyết định.',
  EXPLANATION: 'Yêu cầu giải trình chưa được trả lời sẽ bị tính là quá hạn và báo lên người yêu cầu.',
  EXPLANATION_CONCLUDE: 'Giải trình đã nhận chưa được kết luận thì cảnh báo liên quan vẫn còn mở.',
  REPORT: 'Báo cáo chưa nộp đúng kỳ làm số liệu của dự án thiếu hoặc chậm trên bảng điều hành.',
  OBLIGATION: 'Báo cáo giám sát đánh giá chưa nộp đúng hạn sẽ bị ghi nhận là chậm.',
  EARLY_WARNING: 'Cảnh báo chưa xử lý có thể làm dự án chậm so với kế hoạch giải ngân của kỳ.',
  ADVANCE: 'Tạm ứng chưa thu hồi đúng hạn sẽ bị nâng cấp cảnh báo lên lãnh đạo.',
  PERMIT_EXPIRED: 'Giấy phép đã hết hạn: công việc cần giấy phép này có thể phải dừng cho đến khi được gia hạn.',
  PERMIT_EXPIRING: 'Giấy phép sắp hết hạn: cần gia hạn trước ngày hết hạn để thi công không bị gián đoạn.',
  AUDIT_RECOMMENDATION_OVERDUE: 'Kiến nghị quá hạn thực hiện sẽ tiếp tục bị đưa vào theo dõi của cơ quan kiểm toán.',
  AUDIT_RECOMMENDATION_ESCALATED: 'Kiến nghị quá hạn đã được nâng lên lãnh đạo: đơn vị cần báo cáo kết quả xử lý ngay.',
  ISSUE_SLA_BREACH: 'Vấn đề vượt thời hạn xử lý sẽ tiếp tục được chuyển lên cấp cao hơn.',
  ISSUE_SLA_BREACH_L3: 'Vấn đề đã lên cấp 3 (tổ công tác): cần xử lý ngay để không ảnh hưởng tiến độ dự án.',
  SITE_DIARY: 'Thiếu nhật ký công trường thì hồ sơ chất lượng không đủ căn cứ để nghiệm thu.',
  GUARANTEE: 'Bảo lãnh hết hạn mà chưa được thay thế thì hợp đồng không còn được bảo đảm.',
  EAC_EXCEEDS_TMDT: 'Dự báo chi phí hoàn thành vượt tổng mức đầu tư đã duyệt: dự án cần điều chỉnh quyết định đầu tư trước khi ký thêm hợp đồng hoặc lệnh thay đổi.',
  RESERVE_BELOW_RISK_EV: 'Dự phòng còn lại thấp hơn giá trị kỳ vọng của các rủi ro đang mở: một rủi ro xảy ra sẽ phải xin điều chỉnh thay vì rút dự phòng.',
  ADVANCE_EXCEEDS_REMAINING: 'Dư nợ tạm ứng lớn hơn giá trị còn lại phải thanh toán: không kỳ thanh toán nào còn đủ để thu hồi, và thanh toán cuối sẽ bị chặn.',
  DIRECTIVE_DUE: 'Chỉ đạo sắp đến hạn: nếu không có báo cáo tiến độ hoặc đề nghị gia hạn có lý do, chỉ đạo sẽ bị tính là quá hạn và báo lên lãnh đạo đơn vị.',
  DIRECTIVE_OVERDUE: 'Chỉ đạo quá hạn được đưa vào báo cáo kỳ sau là chưa hoàn thành; quá hạn 7 ngày sẽ báo lên lãnh đạo đơn vị.',
  DIRECTIVE_ESCALATED: 'Chỉ đạo quá hạn từ 7 ngày đã được nâng lên lãnh đạo đơn vị: cần báo cáo kết quả hoặc xin gia hạn có lý do ngay.',
  PRC_STEP_OVERDUE: 'Gói thầu ở lại bước quá số ngày chuẩn: các bước sau và ngày ký hợp đồng bị đẩy lùi, dự án có thể chậm giải ngân.',
  PRC_CHECKLIST_DUE: 'Mục bắt buộc chưa xong chặn không cho gói thầu sang bước sau; quá hạn sẽ làm bước bị trễ.',
  PRC_PACKAGE_STALLED: 'Gói thầu đứng yên quá số ngày làm việc cho phép mà không có ai ghi nhận: tiến độ thực tế không còn được theo dõi.',
  PRC_NO_OWNER: 'Gói thầu không có người phụ trách thì không ai nhận cảnh báo của bước và mục danh mục kiểm, gói sẽ trôi.',
  // Lane D (G4-1, G4-2, G4-4, G4-5) and lane B1 (G1-3): the sentences are the ones of the `ALERT_TYPE` seeds (the registry replaces them when a tenant approves its own type).
  TREASURY_RECON_ITEM_OVERDUE: 'Chỉ tiêu liên quan vẫn bị đánh dấu và một vướng mắc được mở ở phân hệ ISS.',
  CROSS_TOTAL_MISMATCH: 'Chỉ tiêu không được công bố cho đến khi ba tổng khớp nhau.',
  SOD_EXCEPTION_EXPIRING: 'Ngoại lệ hết hạn thì người giữ cả hai nhiệm vụ bị chặn ở lần thao tác kế tiếp.',
  SOD_EXCEPTION_USED: 'Hồ sơ đi qua ngoại lệ mà không ai xem lại thì ngoại lệ mất tác dụng kiểm soát.',
  PAYMENT_INTEGRITY_BLOCKED: 'Đề nghị thanh toán bị chặn không gửi đi được cho đến khi hết phát hiện chặn hoặc có ngoại lệ được duyệt.',
  PAYMENT_INTEGRITY_SIGNAL: 'Tín hiệu bất thường không được xem xét sẽ còn nguyên trong hồ sơ cho kiểm toán.',
  DISBURSEMENT_EXCEPTION_EXPIRING: 'Ngoại lệ giải ngân hết hạn thì thanh toán vượt trần bị chặn trở lại.',
  RESCHEDULE_COUNT: 'Đường cơ sở bị sửa nhiều lần mà không ai xem lại: kiểm toán theo dõi muộn.',
};
