/**
 * The work of a person in one list (ST-HOME-004, HOME 3 F5, HOME-02): what is asked of them in each module, ordered as it is looked at: what is late, then what is near its day, then the rest; inside each the earliest
 * day first, then the kind that comes first, then the id, so that the same list is always in the same order. The reads are of the modules; the order is here.
 */
export const WORK_KINDS = [
  'APPROVAL',
  'EXPLANATION',
  'REPORT_RETURNED',
  'REPORT_DRAFT_OVERDUE',
  'EXPLANATION_REVIEW',
  'MNE_OBLIGATION',
  // The alert centre adds what the other modules ask for: the warnings of DIS, the advances of PAY, the permits of PMT, the recommendations of AUD, the issues of ISS, the diaries of QMS and the guarantees of CTR.
  'EARLY_WARNING',
  'ADVANCE_OVERDUE',
  'PERMIT_EXPIRY',
  'AUDIT_RECOMMENDATION_OVERDUE',
  'ISSUE_SLA_BREACH',
  'SITE_DIARY_MISSING',
  'GUARANTEE_EXPIRING',
  // The money control (governance deepening, lane B2): the estimate above the approved total, the contingency below the open risks, an advance the payments left cannot recover.
  'EAC_EXCEEDS_TMDT',
  'RESERVE_BELOW_RISK_EV',
  'ADVANCE_EXCEEDS_REMAINING',
  // The directives of the steering meetings (lane DIR-1): one that is due within the reminder days or today, and one that is past its day.
  'DIRECTIVE_DUE',
  'DIRECTIVE_OVERDUE',
  // The native clocks of the alert centre (lane GOV-2): an obligation a module started a clock for, running, near its end or past it.
  'CLOCK_DEADLINE',
  // The monitoring of the procurement workflow (lane PRC-1): a step past its day, a required item that is due, a package that has not moved, a package nobody answers for.
  'PRC_STEP_OVERDUE',
  'PRC_CHECKLIST_DUE',
  'PRC_PACKAGE_STALLED',
  'PRC_NO_OWNER',
  // The integrity of the money and of the duties (lane D, integration GOV-INT): a difference with the Treasury past its day, three totals of the disbursed money that disagree, a separation-of-duties exception that ends soon or was used, a payment
  // request a check blocked or sent with signals, a disbursement exception that lapses; and the lane B1 alert to the auditors: a milestone or a project end moved as many times as the rule says.
  'TREASURY_RECON_ITEM_OVERDUE',
  'CROSS_TOTAL_MISMATCH',
  'SOD_EXCEPTION_EXPIRING',
  'SOD_EXCEPTION_USED',
  'PAYMENT_INTEGRITY_BLOCKED',
  'PAYMENT_INTEGRITY_SIGNAL',
  'DISBURSEMENT_EXCEPTION_EXPIRING',
  'RESCHEDULE_COUNT',
  // The Treasury answer to a complete dossier is near its end, or past it (lane GOV-11a, G1-17).
  'PAYMENT_CLOCK_NEAR',
  'PAYMENT_CLOCK_BREACHED',
  // The projection of the cumulative disbursement to a directive milestone is below its target (lane GOV-11a, G1-16).
  'DIS_MILESTONE_AT_RISK',
  // Settlement clocks, adjustment versions, look-ahead plans and lessons learned (lane GOV-11a, G1-18 and G1-19).
  'CONTRACT_SETTLEMENT_NEAR',
  'CONTRACT_SETTLEMENT_OVERDUE',
  'CONTRACT_BASELINE_REVIEW',
  'LOOK_AHEAD_NOT_READY',
  'LOOK_AHEAD_MISSING',
  'LESSONS_LEARNED_MISSING',
  // The connection to the national procurement network is older than its rule allows (lane EGP-1): the files it fed are shown as not up to date.
  'CONNECTOR_STALE',
  // The duties of posting to the national procurement network (lane EGP-2): a posting near its deadline, and one past it.
  'EGP_POSTING_DUE',
  'EGP_POSTING_OVERDUE',
  // The management of contractors (lane VND-1): the alerts of the debarment register, the ledger of bid conduct, the accounts and the certificates.
  'VENDOR_RESTRICTED_EXPOSURE',
  'VENDOR_REPUTATION_POST',
  'VENDOR_DEBARMENT_DECISION',
  'VENDOR_PAYEE_ACCOUNT',
  'VENDOR_QUALIFICATION_EXPIRY',
  // The claim register and the early-warning register of a contract (lane GOV-8): a limitation day, a response or a settlement of a claim, and the rhythm and the actions of the early-warning register.
  'CLAIM_LIMITATION_APPROACHING',
  'CLAIM_LIMITATION_MISSED',
  'CLAIM_RESPONSE_DUE',
  'CLAIM_SETTLEMENT_OVERDUE',
  'EW_REGISTER_OVERDUE',
  'EW_MEETING_OVERDUE',
  'EW_ACTION_OVERDUE',
  // The governance of the alert system (lane GOV-9a): an item that was sent up to the person by the chain of escalation, and a gap in the coverage of the receivers of alerts (an absence nobody covers, an owner who left).
  'ESCALATED_ITEM',
  'COVERAGE_GAP',
  // GOV-10: the clocks of a contract, a document review that is due, a dataset that is not fresh, an anomaly of the money, a red flag of procurement (auditors only) and a report that an alert was wrong (the owner of the type reviews it).
  'CONTRACT_END_NEAR',
  'CONTRACT_PAYMENT_UNREQUESTED',
  'DOC_REVIEW_OVERDUE',
  'DATA_STALE',
  'ANOMALY_SIGNAL',
  'RED_FLAG_NEW',
  'ALERT_FEEDBACK_REVIEW',
  // The Integration Hub (lane HUB-1): a connector whose last runs all failed, and many connectors stale at once.
  'CONNECTOR_FAILING',
  'CONNECTOR_HUB_STALE',
] as const;
export type WorkKind = (typeof WORK_KINDS)[number];
export type WorkBucket = 'OVERDUE' | 'NEAR' | 'LATER';

/** How many days ahead a task is "near its day". */
export const NEAR_DAYS = 7;

/** Which kind comes first when two tasks have the same day: an approval that waits for the person, then an explanation they owe, then a report that came back, and so on. */
const PRIORITY: Readonly<Record<WorkKind, number>> = {
  APPROVAL: 1,
  EXPLANATION: 2,
  REPORT_RETURNED: 3,
  REPORT_DRAFT_OVERDUE: 4,
  EXPLANATION_REVIEW: 5,
  MNE_OBLIGATION: 6,
  EARLY_WARNING: 7,
  ADVANCE_OVERDUE: 8,
  PERMIT_EXPIRY: 9,
  AUDIT_RECOMMENDATION_OVERDUE: 10,
  ISSUE_SLA_BREACH: 11,
  SITE_DIARY_MISSING: 12,
  GUARANTEE_EXPIRING: 13,
  EAC_EXCEEDS_TMDT: 14,
  RESERVE_BELOW_RISK_EV: 15,
  ADVANCE_EXCEEDS_REMAINING: 16,
  DIRECTIVE_DUE: 17,
  DIRECTIVE_OVERDUE: 18,
  CLOCK_DEADLINE: 19,
  PRC_STEP_OVERDUE: 20,
  PRC_CHECKLIST_DUE: 21,
  PRC_PACKAGE_STALLED: 22,
  PRC_NO_OWNER: 23,
  TREASURY_RECON_ITEM_OVERDUE: 24,
  CROSS_TOTAL_MISMATCH: 25,
  SOD_EXCEPTION_EXPIRING: 26,
  SOD_EXCEPTION_USED: 27,
  PAYMENT_INTEGRITY_BLOCKED: 28,
  PAYMENT_INTEGRITY_SIGNAL: 29,
  DISBURSEMENT_EXCEPTION_EXPIRING: 30,
  RESCHEDULE_COUNT: 31,
  PAYMENT_CLOCK_NEAR: 40,
  PAYMENT_CLOCK_BREACHED: 41,
  DIS_MILESTONE_AT_RISK: 42,
  CONTRACT_SETTLEMENT_NEAR: 43,
  CONTRACT_SETTLEMENT_OVERDUE: 44,
  CONTRACT_BASELINE_REVIEW: 45,
  LOOK_AHEAD_NOT_READY: 46,
  LOOK_AHEAD_MISSING: 47,
  LESSONS_LEARNED_MISSING: 48,
  CONNECTOR_STALE: 32,
  EGP_POSTING_DUE: 33,
  EGP_POSTING_OVERDUE: 34,
  VENDOR_RESTRICTED_EXPOSURE: 35,
  VENDOR_REPUTATION_POST: 36,
  VENDOR_DEBARMENT_DECISION: 37,
  VENDOR_PAYEE_ACCOUNT: 38,
  VENDOR_QUALIFICATION_EXPIRY: 39,
  CLAIM_LIMITATION_APPROACHING: 40,
  CLAIM_LIMITATION_MISSED: 41,
  CLAIM_RESPONSE_DUE: 42,
  CLAIM_SETTLEMENT_OVERDUE: 43,
  EW_REGISTER_OVERDUE: 44,
  EW_MEETING_OVERDUE: 45,
  EW_ACTION_OVERDUE: 46,
  ESCALATED_ITEM: 47,
  COVERAGE_GAP: 48,
  CONTRACT_END_NEAR: 49,
  CONTRACT_PAYMENT_UNREQUESTED: 50,
  DOC_REVIEW_OVERDUE: 51,
  DATA_STALE: 52,
  ANOMALY_SIGNAL: 53,
  RED_FLAG_NEW: 54,
  ALERT_FEEDBACK_REVIEW: 55,
  CONNECTOR_FAILING: 56,
  CONNECTOR_HUB_STALE: 57,
};

export interface WorkItem {
  id: string;
  kind: WorkKind;
  /** The day (Vietnam time) the task is due on, or null for a task that has none. */
  dueOn: string | null;
  /** The first day it was asked for, which a later due day does not hide (an explanation that was sent back with a new day is still late by the day it was first asked on). */
  originalDueOn: string | null;
  title: string;
  /** The place the task is about (a project, a unit), when it has one. */
  subtitle: string | null;
  status: string;
}

const day = (value: string): number => Math.floor(Date.parse(`${value}T00:00:00Z`) / 86_400_000);

export function workBucket(item: Pick<WorkItem, 'dueOn' | 'originalDueOn'>, today: string): WorkBucket {
  if (item.dueOn === null) return 'LATER';
  const days = day(item.dueOn) - day(today);
  if (days < 0) return 'OVERDUE';
  return days <= NEAR_DAYS ? 'NEAR' : 'LATER';
}

const RANK: Readonly<Record<WorkBucket, number>> = { OVERDUE: 0, NEAR: 1, LATER: 2 };

/**
 * The order of two tasks: negative when the first is looked at first. It is a position, not a list: a page can go on from a task that is no longer in the list (it was done meanwhile) by asking for what comes after it.
 */
export function compareWork(left: Pick<WorkItem, 'id' | 'kind' | 'dueOn' | 'originalDueOn'>, right: Pick<WorkItem, 'id' | 'kind' | 'dueOn' | 'originalDueOn'>, today: string): number {
  const byBucket = RANK[workBucket(left, today)] - RANK[workBucket(right, today)];
  if (byBucket !== 0) return byBucket;
  // A task with no day comes after the ones that have one.
  if (left.dueOn !== right.dueOn) return left.dueOn === null ? 1 : right.dueOn === null ? -1 : left.dueOn.localeCompare(right.dueOn);
  return PRIORITY[left.kind] - PRIORITY[right.kind] || left.id.localeCompare(right.id, 'en');
}

/** The tasks in the order they are looked at; the list that was given is left as it was. */
export function orderWork<T extends WorkItem>(items: readonly T[], today: string): T[] {
  return [...items].sort((left, right) => compareWork(left, right, today));
}
