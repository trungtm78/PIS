import { DomainError } from './errors.ts';

/**
 * The certificates and the key staff of a contractor (VND-1, research V8; docs/vendor-management.md section 4). A certificate has a kind, a number, a grade, a scope and a period; a member of the key staff has a role,
 * a qualification and a period of their own. Both are checked when a package is evaluated and when a contract is activated, and both warn before they expire (60, then 30 days, then the day itself). The grades
 * and the kinds of certificate are not confirmed against the construction decrees (NĐ 175/2024: the competent body of each grade and the date grade III stops being issued are reported differently), so the
 * list of kinds is data a tenant can widen and the order of grades is the one the certificate states.
 */

export const QUALIFICATION_KINDS = ['CONSTRUCTION_ACTIVITY', 'DESIGN_CONSULTING', 'SUPERVISION_CONSULTING', 'SAFETY_CERTIFICATE', 'QUALITY_MANAGEMENT_ISO9001', 'BUSINESS_REGISTRATION', 'TAX_CLEARANCE', 'SOCIAL_INSURANCE_CLEARANCE', 'EQUIPMENT_OWNERSHIP', 'OTHER'] as const;
export type QualificationKind = (typeof QUALIFICATION_KINDS)[number];
/** Grades from the lowest to the highest; a certificate with none (a registration, a clearance) has no grade. */
export const QUALIFICATION_GRADES = ['III', 'II', 'I'] as const;
export type QualificationGrade = (typeof QUALIFICATION_GRADES)[number];

export const STAFF_ROLES = ['PROJECT_MANAGER', 'SITE_ENGINEER', 'DESIGN_LEAD', 'SUPERVISOR', 'SAFETY_OFFICER', 'QUALITY_OFFICER', 'SURVEYOR', 'OTHER'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/** The rule `VENDOR_EXPIRY_WARNING` (code `QUALIFICATION` or `KEY_STAFF`): the days before the end at which the first and second warnings are due (the day of the end is the last one). */
export interface ExpiryWarningPolicy {
  first_warning_days: number;
  second_warning_days: number;
}

export type ExpiryState = 'VALID' | 'EXPIRING_FIRST' | 'EXPIRING_SECOND' | 'EXPIRED' | 'NOT_STARTED' | 'REVOKED';

export interface PeriodFacts {
  issuedOn: string;
  /** The last day the certificate holds; none for one that does not lapse. */
  expiresOn: string | null;
  revoked: boolean;
}

const DAY_MS = 86_400_000;
const dayNumber = (day: string): number => Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);

/** Whole days from `today` to `until` (negative once past). */
export const daysUntil = (today: string, until: string): number => dayNumber(until) - dayNumber(today);

/** The state of a certificate or a member of staff on a day: the last day of the period still counts as valid; the warnings open at the days the policy names. */
export function expiryState(period: PeriodFacts, today: string, policy: ExpiryWarningPolicy): ExpiryState {
  if (period.revoked) return 'REVOKED';
  if (period.issuedOn > today) return 'NOT_STARTED';
  if (period.expiresOn === null) return 'VALID';
  const left = daysUntil(today, period.expiresOn);
  if (left < 0) return 'EXPIRED';
  if (left <= policy.second_warning_days) return 'EXPIRING_SECOND';
  if (left <= policy.first_warning_days) return 'EXPIRING_FIRST';
  return 'VALID';
}

/** A state that holds today: the certificate counts for a check (an expiring one still does). */
export const holdsToday = (state: ExpiryState): boolean => state === 'VALID' || state === 'EXPIRING_FIRST' || state === 'EXPIRING_SECOND';

/** The severity the alert of an expiry has: URGENT on and after the day, ACTION in the second window, WATCH in the first. */
export function expiryAlertFacet(state: ExpiryState): 'EXPIRED' | 'SECOND' | 'FIRST' | null {
  if (state === 'EXPIRED') return 'EXPIRED';
  if (state === 'EXPIRING_SECOND') return 'SECOND';
  if (state === 'EXPIRING_FIRST') return 'FIRST';
  return null;
}

export function expiryPolicyOf(params: unknown): ExpiryWarningPolicy {
  const bad = (field: string): DomainError => new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, field);
  if (typeof params !== 'object' || params === null) throw bad('params');
  const read = (field: string): number => {
    const value = (params as Record<string, unknown>)[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 365) throw bad(field);
    return value;
  };
  const policy = { first_warning_days: read('first_warning_days'), second_warning_days: read('second_warning_days') };
  if (policy.second_warning_days > policy.first_warning_days) throw bad('second_warning_days');
  return policy;
}

export const EXPIRY_WARNING_DEFAULTS: ExpiryWarningPolicy = { first_warning_days: 60, second_warning_days: 30 };

// -- A requirement of a package (V8: checked when the package is evaluated and when the contract is activated) ------------------------------------------------------------------------------

export interface QualificationRequirement {
  kind: QualificationKind;
  /** The lowest grade accepted; none when any grade (or none) will do. */
  minGrade: QualificationGrade | null;
  /** A word the certificate's scope must contain (folded comparison is the caller's); none when the scope is not judged. */
  scopeKeyword: string | null;
}

export interface HeldQualification {
  id: string;
  kind: QualificationKind;
  grade: QualificationGrade | null;
  scope: string | null;
  period: PeriodFacts;
  /** A person verified it against the document. */
  verified: boolean;
}

export type RequirementGap = 'MISSING' | 'NOT_VERIFIED' | 'EXPIRED' | 'NOT_STARTED' | 'REVOKED' | 'GRADE_LOW' | 'SCOPE_NOT_COVERED';

export interface RequirementFinding {
  kind: QualificationKind;
  gap: RequirementGap;
  /** The certificate that came closest, when there is one. */
  qualificationId: string | null;
}

const gradeRank = (grade: QualificationGrade | null): number => (grade === null ? -1 : QUALIFICATION_GRADES.indexOf(grade));
const GAP_ORDER: readonly RequirementGap[] = ['MISSING', 'REVOKED', 'NOT_STARTED', 'EXPIRED', 'NOT_VERIFIED', 'GRADE_LOW', 'SCOPE_NOT_COVERED'];

/**
 * What a requirement lacks: nothing (a verified certificate of the kind that holds today, of the grade and with the scope asked) or the gap of the one that came closest. A certificate that was not verified by a person
 * does not satisfy a requirement.
 */
export function requirementGap(requirement: QualificationRequirement, held: readonly HeldQualification[], today: string, policy: ExpiryWarningPolicy): RequirementFinding | null {
  const ofKind = held.filter((item) => item.kind === requirement.kind);
  if (ofKind.length === 0) return { kind: requirement.kind, gap: 'MISSING', qualificationId: null };
  let nearest: RequirementFinding | undefined;
  for (const item of ofKind) {
    const state = expiryState(item.period, today, policy);
    let gap: RequirementGap | null = null;
    if (state === 'REVOKED') gap = 'REVOKED';
    else if (state === 'NOT_STARTED') gap = 'NOT_STARTED';
    else if (state === 'EXPIRED') gap = 'EXPIRED';
    else if (!item.verified) gap = 'NOT_VERIFIED';
    else if (requirement.minGrade !== null && gradeRank(item.grade) < gradeRank(requirement.minGrade)) gap = 'GRADE_LOW';
    else if (requirement.scopeKeyword !== null && !(item.scope ?? '').toLowerCase().includes(requirement.scopeKeyword.toLowerCase())) gap = 'SCOPE_NOT_COVERED';
    if (gap === null) return null;
    if (nearest === undefined || GAP_ORDER.indexOf(gap) > GAP_ORDER.indexOf(nearest.gap)) nearest = { kind: requirement.kind, gap, qualificationId: item.id };
  }
  return nearest as RequirementFinding;
}

/** The gaps of a set of requirements; empty when the contractor meets every one. */
export function qualificationFindings(requirements: readonly QualificationRequirement[], held: readonly HeldQualification[], today: string, policy: ExpiryWarningPolicy): RequirementFinding[] {
  return requirements.map((requirement) => requirementGap(requirement, held, today, policy)).filter((finding): finding is RequirementFinding => finding !== null);
}

/** A certificate and a member of staff are written the same way: kind (or role), number, an issuing body and a period with an end that is not before its start. */
export function assertValidityPeriod(issuedOn: string, expiresOn: string | null): void {
  const real = (day: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(day) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
  if (!real(issuedOn)) throw new DomainError('VALIDATION_FAILED', 422, 'issued_on');
  if (expiresOn !== null && (!real(expiresOn) || expiresOn < issuedOn)) throw new DomainError('VALIDATION_FAILED', 422, 'expires_on');
}
