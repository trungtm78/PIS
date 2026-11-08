import { message, type WorkBucket, type WorkKind } from '@machvon/kernel';

/** How urgent an item of the alert centre is: urgent, to be acted on, to be watched. */
export type WorkSeverity = 'URGENT' | 'ACTION' | 'WATCH';
export const WORK_SEVERITIES: readonly WorkSeverity[] = ['URGENT', 'ACTION', 'WATCH'];

/** The module source an item comes from (the `source` of `WorkActionTarget`). */
export const WORK_SOURCES = ['APPROVAL', 'EXPLANATION', 'EXPLANATION_CONCLUDE', 'REPORT', 'OBLIGATION', 'EARLY_WARNING', 'ADVANCE', 'PERMIT', 'AUDIT_RECOMMENDATION', 'ISSUE', 'SITE_DIARY', 'GUARANTEE', 'MONEY_CONTROL', 'DIRECTIVE', 'CLOCK', 'PROCUREMENT_WORKFLOW', 'TREASURY_RECON', 'CROSS_TOTAL', 'SOD_EXCEPTION', 'PAYMENT_INTEGRITY', 'DISBURSEMENT_EXCEPTION', 'PROJECT_GOVERNANCE', 'CONNECTOR', 'EGP_POSTING', 'VENDOR', 'CONTRACT_CLAIM', 'CONTRACT_EARLY_WARNING', 'ESCALATION', 'COVERAGE', 'RED_FLAG', 'CONTRACT_CLOCK', 'DOC_REVIEW', 'DATA_FRESHNESS', 'ANOMALY', 'ALERT_FEEDBACK'] as const;
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
  CONNECTOR_STALE: 'CONNECTOR',
  EGP_POSTING_DUE: 'EGP_POSTING',
  EGP_POSTING_OVERDUE: 'EGP_POSTING',
  VENDOR_RESTRICTED_EXPOSURE: 'VENDOR',
  VENDOR_REPUTATION_POST: 'VENDOR',
  VENDOR_DEBARMENT_DECISION: 'VENDOR',
  VENDOR_PAYEE_ACCOUNT: 'VENDOR',
  VENDOR_QUALIFICATION_EXPIRY: 'VENDOR',
  CLAIM_LIMITATION_APPROACHING: 'CONTRACT_CLAIM',
  CLAIM_LIMITATION_MISSED: 'CONTRACT_CLAIM',
  CLAIM_RESPONSE_DUE: 'CONTRACT_CLAIM',
  CLAIM_SETTLEMENT_OVERDUE: 'CONTRACT_CLAIM',
  EW_REGISTER_OVERDUE: 'CONTRACT_EARLY_WARNING',
  EW_MEETING_OVERDUE: 'CONTRACT_EARLY_WARNING',
  EW_ACTION_OVERDUE: 'CONTRACT_EARLY_WARNING',
  ESCALATED_ITEM: 'ESCALATION',
  COVERAGE_GAP: 'COVERAGE',
  CONTRACT_END_NEAR: 'CONTRACT_CLOCK',
  CONTRACT_PAYMENT_UNREQUESTED: 'CONTRACT_CLOCK',
  DOC_REVIEW_OVERDUE: 'DOC_REVIEW',
  DATA_STALE: 'DATA_FRESHNESS',
  ANOMALY_SIGNAL: 'ANOMALY',
  RED_FLAG_NEW: 'RED_FLAG',
  ALERT_FEEDBACK_REVIEW: 'ALERT_FEEDBACK',
  CONNECTOR_FAILING: 'CONNECTOR',
  CONNECTOR_HUB_STALE: 'CONNECTOR',
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
  // EGP-1: a connection whose data is older than its rule allows (CONNECTOR_FRESHNESS); the severity is the `stale_severity` of that rule, so the facet is STALE_ plus the word (the tenant sets it on the rule, not here).
  // EGP-2: a posting to the national procurement network by the time that is left (rule EGP_POSTING_SEVERITY): urgent when little time is left and once past the deadline, else to be acted on.
  EGP_POSTING: { DUE_SOON: 'ACTION', DUE_SOON_URGENT: 'URGENT', OVERDUE: 'URGENT' },
  // VND-1: the facet of an alert of the contractor register (the table of the kernel, VENDOR_FACET_SEVERITY); a tenant changes it on the alert type.
  VENDOR: { EXPOSED: 'URGENT', DUE_SOON: 'ACTION', OVERDUE: 'URGENT', FIRST: 'WATCH', SECOND: 'ACTION', EXPIRED: 'URGENT', CHANGE_STALLED: 'ACTION', SHARED_ACCOUNT: 'URGENT' },
  // G1-9 (lane GOV-8): a limitation day the owner owes is acted on before it and urgent once missed; one the other side owes, once missed, is acted on (the owner decides what a late notice means); a response the owner owes is urgent when past; a settlement past its day is acted on.
  CONTRACT_CLAIM: { LIMITATION_APPROACHING: 'ACTION', LIMITATION_MISSED_OWN: 'URGENT', LIMITATION_MISSED_OTHER: 'ACTION', RESPONSE_DUE_SOON: 'ACTION', RESPONSE_OVERDUE: 'URGENT', SETTLEMENT_OVERDUE: 'ACTION' },
  // G1-15 (lane GOV-8): the rhythm of the early-warning register is watched while it is approaching and acted on once it is past; an action past its day is acted on.
  CONTRACT_EARLY_WARNING: { DUE_SOON: 'WATCH', OVERDUE: 'ACTION' },
  // G2-3: an item sent up to a person keeps the severity it has (the facet is the severity of the item); G2-7: a person away with nobody to cover and an owner who left are to be acted on, an absence that is about to start is to be watched.
  ESCALATION: { URGENT: 'URGENT', ACTION: 'ACTION', WATCH: 'WATCH' },
  COVERAGE: { ABSENT: 'ACTION', OWNER_INACTIVE: 'ACTION', STARTING: 'WATCH' },
  // G2-12: the end of a contract is urgent within the urgent days and past its day, otherwise to be watched; a request of payment that is late is to be acted on (the severity of an end comes from the rule CONTRACT_CLOCK_RULE, the facets say which).
  CONTRACT_CLOCK: { END_NEAR_URGENT: 'URGENT', END_NEAR: 'WATCH', END_PASSED: 'URGENT', PAYMENT_UNREQUESTED: 'ACTION' },
  // G2-12: a document review past its day is to be acted on, one near its day is to be watched.
  DOC_REVIEW: { OVERDUE: 'ACTION', DUE_SOON: 'WATCH' },
  // G2-12: the severity of a dataset that is not fresh is the stale_severity of DATA_FRESHNESS_RULE (the facet carries the word).
  DATA_FRESHNESS: { STALE_URGENT: 'URGENT', STALE_ACTION: 'ACTION', STALE_WATCH: 'WATCH', NEVER_ASSESSED: 'WATCH' },
  // G2-12 (B4): an anomaly is a hint to look at, never more than to be acted on; the severity is that of its rule (the facet carries the word).
  ANOMALY: { SIGNAL_URGENT: 'URGENT', SIGNAL_ACTION: 'ACTION', SIGNAL_WATCH: 'WATCH' },
  // G4-3: a red flag is a signal for the auditors to review, to be acted on; its score decides nothing.
  RED_FLAG: { NEW: 'ACTION', IN_REVIEW: 'WATCH' },
  // G2-9: a report that an alert was wrong waits for the owner of its type to review it.
  ALERT_FEEDBACK: { PENDING: 'WATCH', PENDING_LONG: 'ACTION' },
  // HUB-1: a failing connector and a stale hub take the severity of the rule INTEGRATION_HUB_POLICY, so the facet is FAILING_ or HUB_STALE_ plus the word.
  CONNECTOR: { STALE_URGENT: 'URGENT', STALE_ACTION: 'ACTION', STALE_WATCH: 'WATCH', FAILING_URGENT: 'URGENT', FAILING_ACTION: 'ACTION', FAILING_WATCH: 'WATCH', HUB_STALE_URGENT: 'URGENT', HUB_STALE_ACTION: 'ACTION', HUB_STALE_WATCH: 'WATCH' },
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

/** What happens when the item is not done: one sentence, in the words of the user (the texts are in the kernel message catalogue, `home.consequence.<key>`). */
const CONSEQUENCE_KEYS = [
  'CLOCK',
  'APPROVAL',
  'EXPLANATION',
  'EXPLANATION_CONCLUDE',
  'REPORT',
  'OBLIGATION',
  'EARLY_WARNING',
  'ADVANCE',
  'PERMIT_EXPIRED',
  'PERMIT_EXPIRING',
  'AUDIT_RECOMMENDATION_OVERDUE',
  'AUDIT_RECOMMENDATION_ESCALATED',
  'ISSUE_SLA_BREACH',
  'ISSUE_SLA_BREACH_L3',
  'SITE_DIARY',
  'GUARANTEE',
  'EAC_EXCEEDS_TMDT',
  'RESERVE_BELOW_RISK_EV',
  'ADVANCE_EXCEEDS_REMAINING',
  'DIRECTIVE_DUE',
  'DIRECTIVE_OVERDUE',
  'DIRECTIVE_ESCALATED',
  'PRC_STEP_OVERDUE',
  'PRC_CHECKLIST_DUE',
  'PRC_PACKAGE_STALLED',
  'PRC_NO_OWNER',
  'TREASURY_RECON_ITEM_OVERDUE',
  'CROSS_TOTAL_MISMATCH',
  'SOD_EXCEPTION_EXPIRING',
  'SOD_EXCEPTION_USED',
  'PAYMENT_INTEGRITY_BLOCKED',
  'PAYMENT_INTEGRITY_SIGNAL',
  'DISBURSEMENT_EXCEPTION_EXPIRING',
  'RESCHEDULE_COUNT',
  'CONNECTOR_STALE',
  'EGP_POSTING_DUE',
  'EGP_POSTING_OVERDUE',
  'VENDOR_RESTRICTED_EXPOSURE',
  'VENDOR_REPUTATION_POST',
  'VENDOR_DEBARMENT_DECISION',
  'VENDOR_PAYEE_ACCOUNT',
  'VENDOR_QUALIFICATION_EXPIRY',
  'CLAIM_LIMITATION_APPROACHING',
  'CLAIM_LIMITATION_MISSED',
  'CLAIM_RESPONSE_DUE',
  'CLAIM_SETTLEMENT_OVERDUE',
  'EW_REGISTER_OVERDUE',
  'EW_MEETING_OVERDUE',
  'EW_ACTION_OVERDUE',
  'ESCALATED_ITEM',
  'COVERAGE_GAP',
  'CONTRACT_END_NEAR',
  'CONTRACT_PAYMENT_UNREQUESTED',
  'DOC_REVIEW_OVERDUE',
  'DATA_STALE',
  'ANOMALY_SIGNAL',
  'RED_FLAG_NEW',
  'ALERT_FEEDBACK_REVIEW',
  'CONNECTOR_FAILING',
  'CONNECTOR_HUB_STALE',
] as const;
export const CONSEQUENCES: Readonly<Record<string, string>> = Object.fromEntries(CONSEQUENCE_KEYS.map((key) => [key, message(`home.consequence.${key.toLowerCase()}`)]));
