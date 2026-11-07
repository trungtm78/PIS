import type { WorkBucket, WorkKind } from '@machvon/kernel';

/** How urgent an item of the alert centre is: "Khẩn", "Cần xử lý", "Theo dõi". */
export type WorkSeverity = 'URGENT' | 'ACTION' | 'WATCH';
export const WORK_SEVERITIES: readonly WorkSeverity[] = ['URGENT', 'ACTION', 'WATCH'];

/** The module source an item comes from (the `source` of `WorkActionTarget`). */
export const WORK_SOURCES = ['APPROVAL', 'EXPLANATION', 'EXPLANATION_CONCLUDE', 'REPORT', 'OBLIGATION', 'EARLY_WARNING', 'ADVANCE', 'PERMIT', 'AUDIT_RECOMMENDATION', 'ISSUE', 'SITE_DIARY', 'GUARANTEE'] as const;
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
};
