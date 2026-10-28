import { DomainError } from './errors.ts';

/**
 * Dossiers and retention (ST-DOC-013, DOC.md F11, BR-DOC-22, BR-DOC-23): documents are kept in a dossier; closing the dossier looks for the retention rule of its category and writes down how long it is kept and when it is to
 * be handed to the archive. Retention is data: a rule counts only when the lawyers have confirmed its legal basis; until then the dossier is kept for ever, provisionally, and cannot be proposed for disposal.
 */
export const DOSSIER_STATUSES = ['OPEN', 'CLOSED', 'HANDED_OVER', 'ARCHIVED', 'DISPOSAL_PROPOSED', 'DISPOSED'] as const;
export type DossierStatus = (typeof DOSSIER_STATUSES)[number];
export const RETENTION_RULE_SETS = ['TT74_2025_BTC', 'TT10_2022_BNV', 'TENANT_CUSTOM'] as const;
export type RetentionRuleSet = (typeof RETENTION_RULE_SETS)[number];
export const RETENTION_CLASSES = ['PERMANENT', 'Y70', 'Y20', 'Y10', 'Y5'] as const;
export type RetentionClass = (typeof RETENTION_CLASSES)[number];
export const RETENTION_START_BASES = ['FROM_CLOSED', 'FROM_SETTLEMENT', 'FROM_ISSUED'] as const;
export type RetentionStartBasis = (typeof RETENTION_START_BASES)[number];

/** The rule sets in the order of the tenant when two rules of the same precedence both apply: the rule of the Ministry of Finance first (an assumption of the design, CXN-05). */
export const DEFAULT_RULE_SET_ORDER: readonly RetentionRuleSet[] = ['TT74_2025_BTC', 'TT10_2022_BNV', 'TENANT_CUSTOM'];

export interface RetentionRuleView {
  id: string;
  ruleSet: RetentionRuleSet;
  categoryCode: string;
  classCode: RetentionClass;
  retentionYears: number | null;
  startBasis: RetentionStartBasis;
  handoverMonths: number;
  confirmationStatus: 'CONFIRMED' | 'PENDING_CONFIRMATION';
  precedence: number;
  effectiveFrom: string;
  effectiveUntil: string | null;
  status: 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED';
}

/**
 * The rule that applies to a dossier of `categoryCode` closed on `closedOn` (a day in Vietnam): published, of the category, in force on that day (`effective_from <= day < effective_until`); the confirmed first, then the
 * lowest precedence, then the order of the rule sets. A rule that is not confirmed may be the best one there is, and then it is returned all the same, so that the caller can see that nothing confirmed applies.
 */
export function selectRetentionRule(rules: readonly RetentionRuleView[], categoryCode: string, closedOn: string, ruleSetOrder: readonly RetentionRuleSet[] = DEFAULT_RULE_SET_ORDER): RetentionRuleView | undefined {
  const inForce = rules.filter((rule) => rule.status === 'PUBLISHED' && rule.categoryCode === categoryCode && rule.effectiveFrom <= closedOn && (rule.effectiveUntil === null || closedOn < rule.effectiveUntil));
  const rank = (rule: RetentionRuleView): number => {
    const at = ruleSetOrder.indexOf(rule.ruleSet);
    return at < 0 ? ruleSetOrder.length : at;
  };
  return [...inForce].sort((a, b) => Number(b.confirmationStatus === 'CONFIRMED') - Number(a.confirmationStatus === 'CONFIRMED') || a.precedence - b.precedence || rank(a) - rank(b) || a.id.localeCompare(b.id))[0];
}

const isDay = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

/** A day plus whole months; a day that the month does not have falls on the last day of that month (31 January plus one month is 28 or 29 February). */
export function addMonths(day: string, months: number): string {
  if (!isDay(day) || !Number.isInteger(months) || months < 0) throw new RangeError('a day and a whole number of months');
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const total = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(total / 12);
  const targetMonth = (total % 12) + 1;
  const last = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  return `${String(targetYear).padStart(4, '0')}-${String(targetMonth).padStart(2, '0')}-${String(Math.min(date, last)).padStart(2, '0')}`;
}

export interface RetentionPlan {
  /** The rule applied, or none while the dossier is kept provisionally. */
  ruleId: string | null;
  classCode: RetentionClass;
  provisional: boolean;
  /** The last day of the retention; none for a permanent class and for a provisional dossier. */
  endsOn: string | null;
  /** The day by which the dossier is to be handed over to the archive (the day it was closed plus the months of the rule); none while provisional. */
  handoverDueOn: string | null;
}

/**
 * What closing a dossier writes down (BR-DOC-22). With no confirmed rule the dossier is PERMANENT and provisional; with one, the class is the rule's, the retention runs from the start the rule names (the day of closing, the
 * day the settlement closed, or the day the last document was issued) for its years, and the handover is due its months after closing. A rule that starts at the settlement needs the day of it (422 `settlement_closed_on`).
 */
export function planRetention(input: { rule: RetentionRuleView | undefined; closedOn: string; settlementClosedOn?: string | undefined; latestIssuedOn?: string | undefined }): RetentionPlan {
  const { rule, closedOn } = input;
  if (rule === undefined || rule.confirmationStatus !== 'CONFIRMED') return { ruleId: null, classCode: 'PERMANENT', provisional: true, endsOn: null, handoverDueOn: null };
  let start = closedOn;
  if (rule.startBasis === 'FROM_SETTLEMENT') {
    if (input.settlementClosedOn === undefined || !isDay(input.settlementClosedOn)) throw new DomainError('VALIDATION_FAILED', 422, 'settlement_closed_on');
    start = input.settlementClosedOn;
  } else if (rule.startBasis === 'FROM_ISSUED') start = input.latestIssuedOn ?? closedOn;
  const endsOn = rule.classCode === 'PERMANENT' || rule.retentionYears === null ? null : addMonths(start, rule.retentionYears * 12);
  return { ruleId: rule.id, classCode: rule.classCode, provisional: false, endsOn, handoverDueOn: addMonths(closedOn, rule.handoverMonths) };
}

/** Why a dossier cannot be proposed for disposal now, or nothing (BR-DOC-23): an open dossier has not been closed; a provisional one is kept for ever; a legal hold stops the disposal even when the retention is over; the retention must have ended. */
export type DisposalBlocker = 'DOSSIER_NOT_CLOSED' | 'RETENTION_PROVISIONAL' | 'LEGAL_HOLD_ACTIVE' | 'RETENTION_NOT_EXPIRED';

export function disposalBlocker(input: { status: DossierStatus; provisional: boolean; retentionEndsOn: string | null; holdActive: boolean; today: string }): DisposalBlocker | undefined {
  if (input.status === 'OPEN') return 'DOSSIER_NOT_CLOSED';
  if (input.provisional) return 'RETENTION_PROVISIONAL';
  if (input.holdActive) return 'LEGAL_HOLD_ACTIVE';
  if (input.retentionEndsOn === null || input.today < input.retentionEndsOn) return 'RETENTION_NOT_EXPIRED';
  return undefined;
}

/** The refusal for a blocker: 409 for the state of the dossier and for a legal hold, 422 for the retention. */
export function assertDisposable(input: Parameters<typeof disposalBlocker>[0]): void {
  const blocker = disposalBlocker(input);
  if (blocker === undefined) return;
  throw new DomainError(blocker, blocker === 'DOSSIER_NOT_CLOSED' || blocker === 'LEGAL_HOLD_ACTIVE' ? 409 : 422);
}

/** Where a dossier goes next: the chain of F11. Closing is the only step of this story; the others are named so that the database guard and the later commands agree. */
const NEXT: Readonly<Record<DossierStatus, readonly DossierStatus[]>> = {
  OPEN: ['CLOSED'],
  CLOSED: ['HANDED_OVER', 'DISPOSAL_PROPOSED'],
  HANDED_OVER: ['ARCHIVED', 'DISPOSAL_PROPOSED'],
  ARCHIVED: ['DISPOSAL_PROPOSED'],
  DISPOSAL_PROPOSED: ['DISPOSED'],
  DISPOSED: [],
};
export const canMoveDossier = (from: DossierStatus, to: DossierStatus): boolean => NEXT[from].includes(to);
