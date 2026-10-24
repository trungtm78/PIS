import { DomainError } from './errors.ts';

/**
 * Retention rules of the platform (ST-ADM-017, ADM 3.12, BR-ADM-11). A record class is a kind of record that is kept or removed
 * as a whole: a BUSINESS class (a dossier, a revision of a report, a contract, a payment, the audit trail) is never deleted by a
 * job, it is listed for a person to decide; a TECHNICAL class (idempotency keys, outbox events, inbox payloads, sessions, delivery
 * attempts) is removed physically when it has outlived its period.
 */
export const RETENTION_BASES = ['FROM_CREATED', 'FROM_CLOSED', 'FROM_CONTRACT_END', 'PERMANENT'] as const;
export type RetentionBasis = (typeof RETENTION_BASES)[number];

export const END_ACTIONS = ['REVIEW_FOR_DESTRUCTION', 'ARCHIVE_TRANSFER', 'AUTO_PURGE_TECHNICAL'] as const;
export type EndAction = (typeof END_ACTIONS)[number];

/** The technical classes and how long each is kept at least, in days (BR-ADM-11): a tenant policy can only lengthen it. */
export const TECHNICAL_RETENTION_DAYS = {
  // Governed by the expiry of each key (72 hours, 7 days for money and offline queue commands); the hourly job removes it.
  idempotency_record: 7,
  outbox_event: 30,
  // The payload only: the metadata stays two years (the dedupe key of a provider event must outlive its payload).
  integration_event_inbox: 90,
  user_session: 180,
  delivery_attempt: 365,
} as const;

export type TechnicalClass = keyof typeof TECHNICAL_RETENTION_DAYS;
export const TECHNICAL_CLASSES: readonly TechnicalClass[] = Object.keys(TECHNICAL_RETENTION_DAYS) as TechnicalClass[];

export type RecordKind = 'BUSINESS' | 'TECHNICAL';

// BR-ADM-11: `*_dossier`, `report_revision`, `contract*`, `payment*` and `audit_event` are business classes.
const BUSINESS_CLASS = /^(?:[a-z][a-z0-9_]*_dossier|report_revision|contract[a-z0-9_]*|payment[a-z0-9_]*|audit_event)$/;
const CLASS_NAME = /^[a-z][a-z0-9_]{1,79}$/;
const MIN_YEARS = 1;
const MAX_YEARS = 100;
const MIN_LEGAL_BASIS = 5;
const MAX_LEGAL_BASIS = 500;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether a record class is business or technical; undefined for a class the platform does not know (no policy can name it). */
export function recordKindOf(recordClass: string): RecordKind | undefined {
  if ((TECHNICAL_CLASSES as readonly string[]).includes(recordClass)) return 'TECHNICAL';
  return BUSINESS_CLASS.test(recordClass) ? 'BUSINESS' : undefined;
}

export interface RetentionPolicyContent {
  record_class: string;
  retention_years?: number | null | undefined;
  retention_basis: RetentionBasis;
  legal_basis_ref: string;
  end_action: EndAction;
  effective_from: string;
}

export type RetentionFindingCode =
  | 'CLASS_FORMAT'
  | 'CLASS_UNKNOWN'
  | 'END_ACTION_NOT_ALLOWED'
  | 'BASIS_NOT_ALLOWED'
  | 'YEARS_REQUIRED'
  | 'YEARS_NOT_ALLOWED'
  | 'YEARS_RANGE'
  | 'LEGAL_BASIS_REQUIRED'
  | 'DATE_INVALID'
  | 'DATE_FUTURE'
  | 'BELOW_PLATFORM_BASELINE';

export interface RetentionFinding {
  field: string;
  code: RetentionFindingCode;
  /** The i18n key of the sentence the screen shows for the finding. */
  message: string;
}

const MESSAGES: Readonly<Record<RetentionFindingCode, string>> = {
  CLASS_FORMAT: 'adm.retention.error.classFormat',
  CLASS_UNKNOWN: 'adm.retention.error.classUnknown',
  END_ACTION_NOT_ALLOWED: 'adm.retention.error.endAction',
  BASIS_NOT_ALLOWED: 'adm.retention.error.basis',
  YEARS_REQUIRED: 'adm.retention.error.yearsRequired',
  YEARS_NOT_ALLOWED: 'adm.retention.error.yearsNotAllowed',
  YEARS_RANGE: 'adm.retention.error.yearsRange',
  LEGAL_BASIS_REQUIRED: 'adm.retention.error.legalBasis',
  DATE_INVALID: 'adm.retention.error.date',
  DATE_FUTURE: 'adm.retention.error.dateFuture',
  BELOW_PLATFORM_BASELINE: 'adm.retention.error.belowBaseline',
};

/** A finding with the key of the sentence the screen shows for it. */
export function retentionFinding(field: string, code: RetentionFindingCode): RetentionFinding {
  return { field, code, message: MESSAGES[code] };
}

const finding = retentionFinding;

/** Whether `YYYY-MM-DD` names a day of the calendar. */
export function isCalendarDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * Every rule of a retention policy version that the request schema cannot state; an empty list means it is valid:
 * a business class may only be reviewed or transferred, never purged by a job (AC-ST-ADM-017-1); a technical class is only purged;
 * a period in years exists exactly when the basis is not PERMANENT; the legal basis is named.
 */
export function retentionFindings(content: RetentionPolicyContent): RetentionFinding[] {
  const found: RetentionFinding[] = [];
  const kind = CLASS_NAME.test(content.record_class) ? recordKindOf(content.record_class) : undefined;
  if (!CLASS_NAME.test(content.record_class)) found.push(finding('record_class', 'CLASS_FORMAT'));
  else if (kind === undefined) found.push(finding('record_class', 'CLASS_UNKNOWN'));
  if (kind === 'BUSINESS' && content.end_action === 'AUTO_PURGE_TECHNICAL') found.push(finding('end_action', 'END_ACTION_NOT_ALLOWED'));
  if (kind === 'TECHNICAL' && content.end_action !== 'AUTO_PURGE_TECHNICAL') found.push(finding('end_action', 'END_ACTION_NOT_ALLOWED'));
  if (kind === 'TECHNICAL' && content.retention_basis !== 'FROM_CREATED' && content.retention_basis !== 'PERMANENT') found.push(finding('retention_basis', 'BASIS_NOT_ALLOWED'));
  const years = content.retention_years ?? undefined;
  if (content.retention_basis === 'PERMANENT') {
    if (years !== undefined) found.push(finding('retention_years', 'YEARS_NOT_ALLOWED'));
  } else if (years === undefined) {
    found.push(finding('retention_years', 'YEARS_REQUIRED'));
  } else if (!Number.isInteger(years) || years < MIN_YEARS || years > MAX_YEARS) {
    found.push(finding('retention_years', 'YEARS_RANGE'));
  }
  const legalBasis = content.legal_basis_ref.trim();
  if (legalBasis.length < MIN_LEGAL_BASIS || legalBasis.length > MAX_LEGAL_BASIS) found.push(finding('legal_basis_ref', 'LEGAL_BASIS_REQUIRED'));
  if (!isCalendarDate(content.effective_from)) found.push(finding('effective_from', 'DATE_INVALID'));
  return found;
}

/** Fails with 422 RETENTION_POLICY_INVALID naming every finding in `errors`; the detail names the first field, never a value. */
export function validateRetentionPolicy(content: RetentionPolicyContent): void {
  const found = retentionFindings(content);
  if (found.length > 0) throw new DomainError('RETENTION_POLICY_INVALID', 422, found[0]?.field, { extensions: { errors: found } });
}

/** The day `years` years after a day (YYYY-MM-DD); 29 February moves to 28 February in a year that has no 29th. */
export function addYears(day: string, years: number): string {
  const match = ISO_DATE.exec(day);
  if (match === null) throw new RangeError('addYears needs a YYYY-MM-DD day');
  const year = Number(match[1]) + years;
  const month = Number(match[2]);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const moved = Math.min(Number(match[3]), last);
  return `${String(year).padStart(4, '0')}-${match[2]}-${String(moved).padStart(2, '0')}`;
}

const DAY_MS = 86_400_000;

/**
 * The moment before which a record of a technical class has outlived its period: the platform period of the class, or the years of
 * the tenant's published policy when that is longer (a policy can only lengthen it). Undefined when the policy keeps the class for good.
 */
export function technicalCutoff(recordClass: TechnicalClass, policy: { years: number | undefined; permanent: boolean } | undefined, now: Date): Date | undefined {
  if (policy?.permanent === true) return undefined;
  const platformDays = TECHNICAL_RETENTION_DAYS[recordClass];
  const policyDays = policy?.years === undefined ? 0 : policy.years * 365;
  return new Date(now.getTime() - Math.max(platformDays, policyDays) * DAY_MS);
}
