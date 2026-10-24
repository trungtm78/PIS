import { ApiError } from '@machvon/api-client';

/** The permission that publishes and ends SLA policies (ISS 2), and the one that reads them (ISS-09). */
export const POLICY_MANAGE_PERMISSION = 'issue.sla.manage';
export const POLICY_READ_PERMISSION = 'issue.read';
/** The catalogue type of the issue categories that a policy is written for (MDM-17). */
export const ISSUE_CATEGORY_TYPE = 'ISSUE_CATEGORY';

export const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** The default thresholds of the contract: 100 % of the resolve time for the second level, 150 % for the third. */
export const DEFAULT_ESCALATE_L2_PCT = 100;
export const DEFAULT_ESCALATE_L3_PCT = 150;
export const DEFAULT_CALENDAR_CODE = 'WORKDAY_VN';
export const MAX_SLA_HOURS = 2400;
export const MAX_ESCALATE_PCT = 1000;
const MAX_CODE = 100;
const MAX_CALENDAR_CODE = 40;
const CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const OFFSET_MS = 7 * 3_600_000;

export type PolicyStatus = 'DRAFT' | 'ACTIVE' | 'RETIRED';

/** One version of an SLA policy as the read model gives it. */
export interface PolicyView {
  id: string;
  code: string;
  revision: number;
  categoryVersionId: string;
  categoryRecordId: string;
  categoryKey: string;
  categoryLabel: string;
  severity: Severity;
  ownerUnitId: string | null;
  calendarCode: string;
  responseHours: number;
  resolveHours: number;
  escalateL2Pct: number;
  escalateL3Pct: number;
  requireIndependentVerifier: boolean;
  requireEvidence: boolean;
  validFrom: string;
  validUntil: string | null;
  status: PolicyStatus;
  version: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);

/** A row of the read as a PolicyView, or undefined when it lacks what the screen needs (the screen shows what it can trust). */
export function toPolicy(raw: unknown): PolicyView | undefined {
  if (!isRecord(raw)) return undefined;
  const severity = text(raw.severity) as Severity | undefined;
  const status = text(raw.status) as PolicyStatus | undefined;
  const id = text(raw.id);
  const code = text(raw.code);
  const categoryVersionId = text(raw.category_version_id);
  const categoryRecordId = text(raw.category_record_id);
  const calendarCode = text(raw.calendar_code);
  const validFrom = text(raw.valid_from);
  const revision = whole(raw.revision);
  const responseHours = whole(raw.response_hours);
  const resolveHours = whole(raw.resolve_hours);
  const escalateL2Pct = whole(raw.escalate_l2_pct);
  const escalateL3Pct = whole(raw.escalate_l3_pct);
  const version = whole(raw.version);
  if (
    id === undefined || code === undefined || categoryVersionId === undefined || categoryRecordId === undefined || calendarCode === undefined || validFrom === undefined ||
    revision === undefined || responseHours === undefined || resolveHours === undefined || escalateL2Pct === undefined || escalateL3Pct === undefined || version === undefined ||
    severity === undefined || !SEVERITIES.includes(severity) || status === undefined || !['DRAFT', 'ACTIVE', 'RETIRED'].includes(status)
  ) {
    return undefined;
  }
  return {
    id,
    code,
    revision,
    categoryVersionId,
    categoryRecordId,
    categoryKey: text(raw.category_key) ?? '',
    categoryLabel: text(raw.category_label) ?? '',
    severity,
    ownerUnitId: text(raw.owner_unit_id) ?? null,
    calendarCode,
    responseHours,
    resolveHours,
    escalateL2Pct,
    escalateL3Pct,
    requireIndependentVerifier: raw.require_independent_verifier === true,
    requireEvidence: raw.require_evidence === true,
    validFrom,
    validUntil: text(raw.valid_until) ?? null,
    status,
    version,
  };
}

/** Where a version stands on a date: it applies, it will apply, or it no longer applies. A retired version still applies until its end date. */
export type Phase = 'draft' | 'scheduled' | 'inForce' | 'ended';

export function phaseOf(policy: PolicyView, today: string): Phase {
  if (policy.status === 'DRAFT') return 'draft';
  if (policy.validFrom > today) return 'scheduled';
  if (policy.validUntil !== null && policy.validUntil <= today) return 'ended';
  return 'inForce';
}

/** The policies of one category, severity and unit: the version that matters now, and every version there has been. */
export interface PolicyGroup {
  key: string;
  categoryRecordId: string;
  categoryKey: string;
  categoryLabel: string;
  severity: Severity;
  ownerUnitId: string | null;
  /** The version that applies today; else the next one to apply; else the last one that applied. */
  current: PolicyView;
  /** Newest first. */
  versions: PolicyView[];
}

const SEVERITY_ORDER = new Map(SEVERITIES.map((severity, index) => [severity, index]));

function currentOf(versions: readonly PolicyView[], today: string): PolicyView {
  const inForce = versions.find((version) => phaseOf(version, today) === 'inForce');
  if (inForce !== undefined) return inForce;
  // `versions` is newest first, so the last scheduled one is the nearest to apply.
  const scheduled = versions.filter((version) => phaseOf(version, today) === 'scheduled');
  return scheduled[scheduled.length - 1] ?? (versions[0] as PolicyView);
}

export function groupPolicies(policies: readonly PolicyView[], today: string): PolicyGroup[] {
  const byKey = new Map<string, PolicyView[]>();
  for (const policy of policies) {
    const key = `${policy.categoryRecordId}|${policy.severity}|${policy.ownerUnitId ?? ''}`;
    byKey.set(key, [...(byKey.get(key) ?? []), policy]);
  }
  const groups = [...byKey.entries()].map(([key, members]): PolicyGroup => {
    const versions = [...members].sort((left, right) => right.validFrom.localeCompare(left.validFrom) || right.revision - left.revision);
    const current = currentOf(versions, today);
    return { key, categoryRecordId: current.categoryRecordId, categoryKey: current.categoryKey, categoryLabel: current.categoryLabel, severity: current.severity, ownerUnitId: current.ownerUnitId, current, versions };
  });
  return groups.sort(
    (left, right) =>
      left.categoryKey.localeCompare(right.categoryKey) ||
      (SEVERITY_ORDER.get(left.severity) ?? 0) - (SEVERITY_ORDER.get(right.severity) ?? 0) ||
      (left.ownerUnitId ?? '').localeCompare(right.ownerUnitId ?? ''),
  );
}

/** Today's date in Vietnam (UTC+7, no daylight saving): the day a policy may begin on or after. */
export function vietnamToday(now: Date = new Date()): string {
  return new Date(now.getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

const isRealDate = (value: string): boolean => {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return DATE.test(value) && !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
};

export type FieldProblem = 'required' | 'invalidCode' | 'invalidNumber' | 'resolveOrder' | 'levelOrder' | 'invalidDate' | 'past' | 'untilOrder' | 'rejected';
export type FormErrors<Field extends string> = Partial<Record<Field, FieldProblem>>;

export interface PolicyForm {
  code: string;
  categoryVersionId: string;
  severity: Severity;
  ownerUnitId: string;
  calendarCode: string;
  responseHours: string;
  resolveHours: string;
  escalateL2Pct: string;
  escalateL3Pct: string;
  requireIndependentVerifier: boolean;
  requireEvidence: boolean;
  validFrom: string;
}

export type PolicyField = keyof PolicyForm;

export const EMPTY_POLICY_FORM: PolicyForm = {
  code: '',
  categoryVersionId: '',
  severity: 'MEDIUM',
  ownerUnitId: '',
  calendarCode: DEFAULT_CALENDAR_CODE,
  responseHours: '',
  resolveHours: '',
  escalateL2Pct: '',
  escalateL3Pct: '',
  requireIndependentVerifier: true,
  requireEvidence: true,
  validFrom: '',
};

const WHOLE = /^\d{1,6}$/;
const wholeOf = (value: string): number | undefined => (WHOLE.test(value.trim()) ? Number(value.trim()) : undefined);

/** The form field that the server names (the `detail` of a 422), when the screen has one for it. */
export const FIELD_OF_DETAIL: Readonly<Record<string, PolicyField>> = {
  code: 'code',
  category_version_id: 'categoryVersionId',
  severity: 'severity',
  owner_unit_id: 'ownerUnitId',
  calendar_code: 'calendarCode',
  response_hours: 'responseHours',
  resolve_hours: 'resolveHours',
  escalate_l2_pct: 'escalateL2Pct',
  escalate_l3_pct: 'escalateL3Pct',
  valid_from: 'validFrom',
};

/** Every rule of the form that the screen can judge without asking the server; the server judges the rest (the category, the unit, the calendar, overlaps). */
export function validatePolicy(form: PolicyForm, today: string): FormErrors<PolicyField> {
  const errors: FormErrors<PolicyField> = {};
  const code = form.code.trim();
  if (code === '') errors.code = 'required';
  else if (code.length > MAX_CODE || !CODE.test(code)) errors.code = 'invalidCode';
  if (form.categoryVersionId === '') errors.categoryVersionId = 'required';
  const calendar = form.calendarCode.trim();
  if (calendar === '') errors.calendarCode = 'required';
  else if (calendar.length > MAX_CALENDAR_CODE || !CODE.test(calendar)) errors.calendarCode = 'invalidCode';

  const response = wholeOf(form.responseHours);
  const resolve = wholeOf(form.resolveHours);
  if (form.responseHours.trim() === '') errors.responseHours = 'required';
  else if (response === undefined || response < 1 || response > MAX_SLA_HOURS) errors.responseHours = 'invalidNumber';
  if (form.resolveHours.trim() === '') errors.resolveHours = 'required';
  else if (resolve === undefined || resolve < 1 || resolve > MAX_SLA_HOURS) errors.resolveHours = 'invalidNumber';
  else if (response !== undefined && errors.responseHours === undefined && resolve < response) errors.resolveHours = 'resolveOrder';

  const level2 = form.escalateL2Pct.trim() === '' ? DEFAULT_ESCALATE_L2_PCT : wholeOf(form.escalateL2Pct);
  const level3 = form.escalateL3Pct.trim() === '' ? DEFAULT_ESCALATE_L3_PCT : wholeOf(form.escalateL3Pct);
  if (level2 === undefined || level2 < 1 || level2 >= MAX_ESCALATE_PCT) errors.escalateL2Pct = 'invalidNumber';
  if (level3 === undefined || level3 < 1 || level3 > MAX_ESCALATE_PCT) errors.escalateL3Pct = 'invalidNumber';
  else if (errors.escalateL2Pct === undefined && level2 !== undefined && level3 <= level2) errors.escalateL3Pct = 'levelOrder';

  if (form.validFrom === '') errors.validFrom = 'required';
  else if (!isRealDate(form.validFrom)) errors.validFrom = 'invalidDate';
  else if (form.validFrom < today) errors.validFrom = 'past';
  return errors;
}

/** The body of upsertIssueSlaPolicy for a form that passed `validatePolicy`; a threshold left blank takes the default of the contract. */
export interface PublishPolicyBody {
  code: string;
  category_version_id: string;
  severity: Severity;
  owner_unit_id?: string;
  calendar_code: string;
  response_hours: number;
  resolve_hours: number;
  escalate_l2_pct: number;
  escalate_l3_pct: number;
  require_independent_verifier: boolean;
  require_evidence: boolean;
  valid_from: string;
}

export function toPublishBody(form: PolicyForm): PublishPolicyBody {
  return {
    code: form.code.trim(),
    category_version_id: form.categoryVersionId,
    severity: form.severity,
    ...(form.ownerUnitId === '' ? {} : { owner_unit_id: form.ownerUnitId }),
    calendar_code: form.calendarCode.trim(),
    response_hours: Number(form.responseHours.trim()),
    resolve_hours: Number(form.resolveHours.trim()),
    escalate_l2_pct: form.escalateL2Pct.trim() === '' ? DEFAULT_ESCALATE_L2_PCT : Number(form.escalateL2Pct.trim()),
    escalate_l3_pct: form.escalateL3Pct.trim() === '' ? DEFAULT_ESCALATE_L3_PCT : Number(form.escalateL3Pct.trim()),
    require_independent_verifier: form.requireIndependentVerifier,
    require_evidence: form.requireEvidence,
    valid_from: form.validFrom,
  };
}

/** The end date of a retirement: a real date, after the policy began, and not in days that are gone. */
export function validateRetireDate(validUntil: string, policy: PolicyView, today: string): FieldProblem | undefined {
  if (validUntil === '') return 'required';
  if (!isRealDate(validUntil)) return 'invalidDate';
  if (validUntil <= policy.validFrom) return 'untilOrder';
  if (validUntil < today) return 'past';
  return undefined;
}

export type ProblemReason = 'overlap' | 'stateInvalid' | 'validation' | 'denied' | 'notFound' | 'general';

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  SLA_POLICY_OVERLAP: 'overlap',
  SLA_POLICY_STATE_INVALID: 'stateInvalid',
  VALIDATION_FAILED: 'validation',
  FIELD_NOT_ALLOWED: 'validation',
  INVALID_REQUEST: 'validation',
  SCOPE_DENIED: 'denied',
  PERMISSION_DENIED: 'denied',
  RESOURCE_NOT_FOUND: 'notFound',
};

export interface ProblemView {
  reason: ProblemReason;
  field: string | undefined;
}

/** Maps the failure of a command of this screen to what it shows; an unknown failure is the general message. */
export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail };
}

/** An entry of the category catalogue that a policy can be written for: one that is in force. */
export interface CategoryOption {
  /** The version in force: what a policy is written against. */
  versionId: string;
  key: string;
  label: string;
}

export function toCategory(raw: unknown): CategoryOption | undefined {
  if (!isRecord(raw)) return undefined;
  const versionId = text(raw.version_id);
  const key = text(raw.business_key);
  if (versionId === undefined || key === undefined || raw.status !== 'EFFECTIVE') return undefined;
  return { versionId, key, label: text(raw.label) ?? key };
}

export interface UnitOption {
  id: string;
  code: string;
  name: string;
}

export function toUnit(raw: unknown): UnitOption | undefined {
  if (!isRecord(raw)) return undefined;
  const id = text(raw.id);
  const code = text(raw.code);
  if (id === undefined || code === undefined) return undefined;
  return { id, code, name: text(raw.name) ?? code };
}
