import { ApiError } from '@machvon/api-client';

/** The permission that publishes and ends permit type versions (PMT 2), and the one that reads the catalogue (PMT-03). */
export const CATALOGUE_MANAGE_PERMISSION = 'permit.catalogue.manage';
export const CATALOGUE_READ_PERMISSION = 'permit.read';

export const CATEGORIES = ['ENVIRONMENT', 'DESIGN_APPRAISAL', 'FIRE_SAFETY', 'CONSTRUCTION_PERMIT', 'LAND', 'TRAFFIC', 'WATER_RESOURCES', 'OTHER'] as const;
export type Category = (typeof CATEGORIES)[number];
export type TypeStatus = 'DRAFT' | 'PUBLISHED' | 'RETIRED';

const MAX_TEXT = { name: 300, authority: 500, legalBasis: 2000 } as const;
const MAX_VALIDITY_MONTHS = 1200;
const MAX_PROCESSING_DAYS = 3650;
const MAX_KEYS = 50;
const CODE = /^[A-Z][A-Z0-9_]{0,59}$/;
const CXN_REF = /^CXN-[A-Z0-9]+(-[A-Z0-9]+)*$/;
const KEY = /^[A-Z0-9][A-Z0-9_.-]{0,59}$/;
const VND = /^(0|[1-9][0-9]{0,23})$/;
const WHOLE = /^\d{1,5}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;

/** The condition under which a permit type applies to a project; empty lists and no bounds mean every project. */
export interface Applicability {
  projectGroupKeys: string[];
  workTypes: string[];
  minTotalInvestmentVnd: string | null;
  maxTotalInvestmentVnd: string | null;
}

/** One version of a permit type as the read model gives it. */
export interface PermitTypeView {
  id: string;
  code: string;
  revision: number;
  name: string;
  category: Category;
  authorityText: string;
  legalBasis: string;
  /** The confirmation id this version still waits for; null once the legal text has been confirmed. */
  cxnRef: string | null;
  effectiveFrom: string;
  /** The last day the version applies (inclusive); null while it is open-ended. */
  effectiveUntil: string | null;
  appliesTo: Applicability;
  defaultValidityMonths: number | null;
  defaultProcessingDays: number | null;
  exemptionAllowed: boolean;
  status: TypeStatus;
  version: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const keys = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);

function appliesToOf(raw: unknown): Applicability {
  const rule = isRecord(raw) ? raw : {};
  return {
    projectGroupKeys: keys(rule.project_group_keys),
    workTypes: keys(rule.work_types),
    minTotalInvestmentVnd: text(rule.min_total_investment_vnd) ?? null,
    maxTotalInvestmentVnd: text(rule.max_total_investment_vnd) ?? null,
  };
}

/** A row of the read as a PermitTypeView, or undefined when it lacks what the screen needs (the screen shows what it can trust). */
export function toPermitType(raw: unknown): PermitTypeView | undefined {
  if (!isRecord(raw)) return undefined;
  const id = text(raw.id);
  const code = text(raw.code);
  const name = text(raw.name);
  const category = text(raw.category) as Category | undefined;
  const authorityText = text(raw.authority_text);
  const legalBasis = text(raw.legal_basis);
  const effectiveFrom = text(raw.effective_from);
  const status = text(raw.status) as TypeStatus | undefined;
  const revision = whole(raw.revision);
  const version = whole(raw.version);
  if (
    id === undefined || code === undefined || name === undefined || authorityText === undefined || legalBasis === undefined || effectiveFrom === undefined ||
    revision === undefined || version === undefined || category === undefined || !CATEGORIES.includes(category) ||
    status === undefined || !['DRAFT', 'PUBLISHED', 'RETIRED'].includes(status)
  ) {
    return undefined;
  }
  return {
    id,
    code,
    revision,
    name,
    category,
    authorityText,
    legalBasis,
    cxnRef: text(raw.cxn_ref) ?? null,
    effectiveFrom,
    effectiveUntil: text(raw.effective_until) ?? null,
    appliesTo: appliesToOf(raw.applies_to_rule),
    defaultValidityMonths: whole(raw.default_validity_months) ?? null,
    defaultProcessingDays: whole(raw.default_processing_days) ?? null,
    exemptionAllowed: raw.exemption_allowed === true,
    status,
    version,
  };
}

/** Where a version stands on a date: it applies, it will apply, or it no longer applies. A retired version still applies until its last day. */
export type Phase = 'draft' | 'scheduled' | 'inForce' | 'ended';

export function phaseOf(type: PermitTypeView, today: string): Phase {
  if (type.status === 'DRAFT') return 'draft';
  if (type.effectiveFrom > today) return 'scheduled';
  if (type.effectiveUntil !== null && type.effectiveUntil < today) return 'ended';
  return 'inForce';
}

/** The versions of one code: the one that matters now, and every version there has been. */
export interface TypeGroup {
  code: string;
  /** The version that applies today; else the next one to apply; else the last one that applied. */
  current: PermitTypeView;
  /** Newest first. */
  versions: PermitTypeView[];
}

function currentOf(versions: readonly PermitTypeView[], today: string): PermitTypeView {
  const inForce = versions.find((version) => phaseOf(version, today) === 'inForce');
  if (inForce !== undefined) return inForce;
  // `versions` is newest first, so the last scheduled one is the nearest to apply.
  const scheduled = versions.filter((version) => phaseOf(version, today) === 'scheduled');
  return scheduled[scheduled.length - 1] ?? (versions[0] as PermitTypeView);
}

export function groupTypes(types: readonly PermitTypeView[], today: string): TypeGroup[] {
  const byCode = new Map<string, PermitTypeView[]>();
  for (const type of types) byCode.set(type.code, [...(byCode.get(type.code) ?? []), type]);
  return [...byCode.entries()]
    .map(([code, members]): TypeGroup => {
      const versions = [...members].sort((left, right) => right.revision - left.revision);
      return { code, current: currentOf(versions, today), versions };
    })
    .sort((left, right) => left.code.localeCompare(right.code));
}

/** Today's date in Vietnam (UTC+7, no daylight saving): the day a later revision may begin on or after. */
export function vietnamToday(now: Date = new Date()): string {
  return new Date(now.getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

const isRealDate = (value: string): boolean => {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return DATE.test(value) && !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
};

/** The day before a day (the last day of the version that the next one replaces). */
export const dayBefore = (value: string): string => new Date(Date.parse(`${value}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);

export type FieldProblem =
  | 'required'
  | 'invalidCode'
  | 'tooLong'
  | 'invalidReference'
  | 'invalidDate'
  | 'past'
  | 'untilOrder'
  | 'laterEnd'
  | 'invalidNumber'
  | 'invalidKeys'
  | 'invalidAmount'
  | 'amountOrder'
  | 'rejected';
export type FormErrors<Field extends string> = Partial<Record<Field, FieldProblem>>;

export interface PermitTypeForm {
  code: string;
  name: string;
  category: Category;
  authorityText: string;
  legalBasis: string;
  cxnRef: string;
  effectiveFrom: string;
  effectiveUntil: string;
  projectGroupKeys: string;
  workTypes: string;
  minInvestment: string;
  maxInvestment: string;
  validityMonths: string;
  processingDays: string;
  exemptionAllowed: boolean;
}

export type TypeField = keyof PermitTypeForm;

export const EMPTY_TYPE_FORM: PermitTypeForm = {
  code: '',
  name: '',
  category: 'OTHER',
  authorityText: '',
  legalBasis: '',
  cxnRef: '',
  effectiveFrom: '',
  effectiveUntil: '',
  projectGroupKeys: '',
  workTypes: '',
  minInvestment: '',
  maxInvestment: '',
  validityMonths: '',
  processingDays: '',
  exemptionAllowed: false,
};

/** The form field that the server names (the `detail` of a 422), when the screen has one for it. */
export const FIELD_OF_DETAIL: Readonly<Record<string, TypeField>> = {
  code: 'code',
  name: 'name',
  category: 'category',
  authority_text: 'authorityText',
  legal_basis: 'legalBasis',
  cxn_ref: 'cxnRef',
  effective_from: 'effectiveFrom',
  effective_until: 'effectiveUntil',
  applies_to_rule: 'projectGroupKeys',
  default_validity_months: 'validityMonths',
  default_processing_days: 'processingDays',
};

/** A list typed as words separated by commas, spaces or lines: the distinct entries, in the order typed. */
export function listOf(value: string): string[] {
  return [...new Set(value.split(/[\s,;]+/).filter((entry) => entry !== ''))];
}

function listProblem(value: string): FieldProblem | undefined {
  const entries = listOf(value);
  return entries.length > MAX_KEYS || entries.some((entry) => !KEY.test(entry)) ? 'invalidKeys' : undefined;
}

function countProblem(value: string, max: number): FieldProblem | undefined {
  if (value.trim() === '') return undefined;
  const number = WHOLE.test(value.trim()) ? Number(value.trim()) : undefined;
  return number === undefined || number < 1 || number > max ? 'invalidNumber' : undefined;
}

/**
 * Every rule of the form that the screen can judge without asking the server; the server judges the rest (overlaps, what is in use). A
 * later revision of a code that exists may not begin in days that are gone; the first revision of a code may, because the regulation may be
 * in force already.
 */
export function validatePermitType(form: PermitTypeForm, today: string, existingCodes: ReadonlySet<string>): FormErrors<TypeField> {
  const errors: FormErrors<TypeField> = {};
  const code = form.code.trim();
  if (code === '') errors.code = 'required';
  else if (!CODE.test(code)) errors.code = 'invalidCode';
  const required = (field: 'name' | 'authorityText' | 'legalBasis', max: number): void => {
    const value = form[field].trim();
    if (value === '') errors[field] = 'required';
    else if (value.length > max) errors[field] = 'tooLong';
  };
  required('name', MAX_TEXT.name);
  required('authorityText', MAX_TEXT.authority);
  required('legalBasis', MAX_TEXT.legalBasis);
  if (form.cxnRef.trim() !== '' && !CXN_REF.test(form.cxnRef.trim())) errors.cxnRef = 'invalidReference';

  if (form.effectiveFrom === '') errors.effectiveFrom = 'required';
  else if (!isRealDate(form.effectiveFrom)) errors.effectiveFrom = 'invalidDate';
  else if (existingCodes.has(code) && form.effectiveFrom < today) errors.effectiveFrom = 'past';
  if (form.effectiveUntil !== '') {
    if (!isRealDate(form.effectiveUntil)) errors.effectiveUntil = 'invalidDate';
    else if (errors.effectiveFrom === undefined && form.effectiveFrom !== '' && form.effectiveUntil <= form.effectiveFrom) errors.effectiveUntil = 'untilOrder';
  }

  const groups = listProblem(form.projectGroupKeys);
  if (groups !== undefined) errors.projectGroupKeys = groups;
  const works = listProblem(form.workTypes);
  if (works !== undefined) errors.workTypes = works;
  const min = form.minInvestment.trim();
  const max = form.maxInvestment.trim();
  if (min !== '' && !VND.test(min)) errors.minInvestment = 'invalidAmount';
  if (max !== '' && !VND.test(max)) errors.maxInvestment = 'invalidAmount';
  if (errors.minInvestment === undefined && errors.maxInvestment === undefined && min !== '' && max !== '' && BigInt(min) > BigInt(max)) errors.maxInvestment = 'amountOrder';
  const months = countProblem(form.validityMonths, MAX_VALIDITY_MONTHS);
  if (months !== undefined) errors.validityMonths = months;
  const days = countProblem(form.processingDays, MAX_PROCESSING_DAYS);
  if (days !== undefined) errors.processingDays = days;
  return errors;
}

/** The body of publishPermitType for a form that passed `validatePermitType`; a field left blank is left out. */
export interface PublishTypeBody {
  code: string;
  name: string;
  category: Category;
  authority_text: string;
  legal_basis: string;
  cxn_ref?: string;
  effective_from: string;
  effective_until?: string;
  applies_to_rule: Record<string, unknown>;
  default_validity_months?: number;
  default_processing_days?: number;
  exemption_allowed: boolean;
}

export function toPublishBody(form: PermitTypeForm): PublishTypeBody {
  const groups = listOf(form.projectGroupKeys);
  const works = listOf(form.workTypes);
  return {
    code: form.code.trim(),
    name: form.name.trim(),
    category: form.category,
    authority_text: form.authorityText.trim(),
    legal_basis: form.legalBasis.trim(),
    ...(form.cxnRef.trim() === '' ? {} : { cxn_ref: form.cxnRef.trim() }),
    effective_from: form.effectiveFrom,
    ...(form.effectiveUntil === '' ? {} : { effective_until: form.effectiveUntil }),
    applies_to_rule: {
      ...(groups.length === 0 ? {} : { project_group_keys: groups }),
      ...(works.length === 0 ? {} : { work_types: works }),
      ...(form.minInvestment.trim() === '' ? {} : { min_total_investment_vnd: form.minInvestment.trim() }),
      ...(form.maxInvestment.trim() === '' ? {} : { max_total_investment_vnd: form.maxInvestment.trim() }),
    },
    ...(form.validityMonths.trim() === '' ? {} : { default_validity_months: Number(form.validityMonths.trim()) }),
    ...(form.processingDays.trim() === '' ? {} : { default_processing_days: Number(form.processingDays.trim()) }),
    exemption_allowed: form.exemptionAllowed,
  };
}

/**
 * The last day of a retirement: a real date, after the version began, not in days that are gone (unless it is the end the version already
 * has) and not later than the end it already has.
 */
export function validateRetireDate(effectiveUntil: string, type: PermitTypeView, today: string): FieldProblem | undefined {
  if (effectiveUntil === '') return 'required';
  if (!isRealDate(effectiveUntil)) return 'invalidDate';
  if (effectiveUntil <= type.effectiveFrom) return 'untilOrder';
  if (type.effectiveUntil !== null && effectiveUntil > type.effectiveUntil) return 'laterEnd';
  if (effectiveUntil < today && effectiveUntil !== type.effectiveUntil) return 'past';
  return undefined;
}

/** Whether a version can still be ended earlier: it has no end yet, or its end has not passed. */
export const canRetire = (type: PermitTypeView, today: string): boolean => type.status !== 'DRAFT' && (type.effectiveUntil === null || type.effectiveUntil > today);

export type ProblemReason = 'overlap' | 'inUse' | 'legalBasis' | 'validation' | 'denied' | 'notFound' | 'general';

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  PERMIT_TYPE_OVERLAP: 'overlap',
  PERMIT_TYPE_IN_USE: 'inUse',
  LEGAL_BASIS_REQUIRED: 'legalBasis',
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
