import { ApiError } from '@machvon/api-client';
import { EXPORT_FORMATS } from './types';
import type { ExportFormat, FormView, ObligationView, ReportKind } from './types';

const DAY_MS = 86_400_000;
const OFFSET_MS = 7 * 3_600_000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FORM_CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,49}$/;
const MAX = { title: 500, legalBasis: 2000, reference: 50, template: 80 } as const;
const MIN = { title: 3, legalBasis: 3 } as const;

/** The Vietnam date of an instant (the clock of the browser by default), `YYYY-MM-DD`. */
export const vietnamToday = (now: number = Date.now()): string => new Date(now + OFFSET_MS).toISOString().slice(0, 10);

const isRealDate = (value: string): boolean => {
  const match = DATE.exec(value);
  if (match === null) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
};

/** The last day a revision applies: the day before the exclusive end (`effective_until`), or null while it is open-ended. */
export function lastDayOf(effectiveUntil: string | null): string | null {
  if (effectiveUntil === null || !isRealDate(effectiveUntil)) return effectiveUntil;
  return new Date(Date.parse(`${effectiveUntil}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
}

export type Phase = 'draft' | 'scheduled' | 'inForce' | 'ended';

/** Where a revision stands on a date: it applies, it will apply, or it no longer applies. A retired revision still serves the days it covered. */
export function phaseOf(form: FormView, today: string): Phase {
  if (form.status === 'DRAFT') return 'draft';
  if (form.effectiveFrom > today) return 'scheduled';
  if (form.effectiveUntil !== null && form.effectiveUntil <= today) return 'ended';
  return 'inForce';
}

/** What the catalogue may offer a person on one revision (the server checks again): a draft is published by someone other than its maker. */
export interface FormActions {
  publish: boolean;
  /** The revision waits for a publisher, and this person drafted it: someone else has to publish it. */
  publishNeedsOther: boolean;
}

export interface ActionContext {
  membershipId: string | undefined;
  /** `undefined` while the grants are not known (the server decides); otherwise the permissions of the person. */
  permissions: readonly string[] | undefined;
  frozen: boolean;
  approve: string;
}

export function actionsFor(form: FormView, context: ActionContext): FormActions {
  if (context.frozen || form.status !== 'DRAFT') return { publish: false, publishNeedsOther: false };
  if (context.permissions !== undefined && !context.permissions.includes(context.approve)) return { publish: false, publishNeedsOther: false };
  const own = context.membershipId !== undefined && form.createdBy.toLowerCase() === context.membershipId.toLowerCase();
  return { publish: !own, publishNeedsOther: own };
}

/** The `[CXN-10]` tags of the label of a legal parameter that waits for its confirmation; `[CXN]` when its text names none. */
export function cxnTags(refs: readonly string[]): string {
  return refs.length === 0 ? '[CXN]' : refs.map((reference) => `[${reference}]`).join(' ');
}

/** The obligations of one month of due dates, in the order of the calendar. */
export interface MonthGroup {
  /** `YYYY-MM`. */
  month: string;
  items: ObligationView[];
}

export function groupByMonth(items: readonly ObligationView[]): MonthGroup[] {
  const groups = new Map<string, ObligationView[]>();
  for (const item of items) groups.set(item.dueDate.slice(0, 7), [...(groups.get(item.dueDate.slice(0, 7)) ?? []), item]);
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([month, members]) => ({ month, items: members }));
}

/** Whether the obligation is past its due date and still open: a text and a count, never a colour alone (MNE-09 rule). */
export const isOverdue = (item: ObligationView): boolean => item.isLate && item.daysLate !== null && item.daysLate > 0;

/** The years the year selector offers: around today, and the years the loaded obligations belong to. */
export function yearsAround(today: string, known: readonly number[]): number[] {
  const year = Number(today.slice(0, 4));
  return [...new Set([year - 1, year, year + 1, ...known])].sort((left, right) => left - right);
}

// ---- the form of a new revision (createMneFormVersion) ----

export interface RevisionValues {
  formCode: string;
  title: string;
  reportKind: ReportKind | '';
  legalBasis: string;
  legalConfirmationRef: string;
  effectiveFrom: string;
  effectiveUntil: string;
  docTemplateCode: string;
  exportFormats: ExportFormat[];
  /** The structure of the form as JSON text. */
  schemaText: string;
}

export const EMPTY_REVISION: RevisionValues = {
  formCode: '',
  title: '',
  reportKind: '',
  legalBasis: '',
  legalConfirmationRef: '',
  effectiveFrom: '',
  effectiveUntil: '',
  docTemplateCode: '',
  exportFormats: ['XLSX'],
  schemaText: '{}',
};

export type FieldProblem = 'required' | 'tooShort' | 'tooLong' | 'format' | 'date' | 'order' | 'json' | 'formats';
export type RevisionErrors = Partial<Record<keyof RevisionValues, FieldProblem>>;

function schemaOf(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function lengthProblem(value: string, min: number, max: number): FieldProblem | undefined {
  const size = value.trim().length;
  if (size === 0) return 'required';
  if (size < min) return 'tooShort';
  return size > max ? 'tooLong' : undefined;
}

/** Checks what the server checks first (shape and length), so a mistake is told before the request leaves; the server still decides. */
export function validateRevision(values: RevisionValues): RevisionErrors {
  const errors: RevisionErrors = {};
  if (values.formCode.trim() === '') errors.formCode = 'required';
  else if (!FORM_CODE.test(values.formCode.trim())) errors.formCode = 'format';
  const title = lengthProblem(values.title, MIN.title, MAX.title);
  if (title !== undefined) errors.title = title;
  if (values.reportKind === '') errors.reportKind = 'required';
  const legalBasis = lengthProblem(values.legalBasis, MIN.legalBasis, MAX.legalBasis);
  if (legalBasis !== undefined) errors.legalBasis = legalBasis;
  if (values.legalConfirmationRef.trim().length > MAX.reference) errors.legalConfirmationRef = 'tooLong';
  if (values.effectiveFrom === '') errors.effectiveFrom = 'required';
  else if (!isRealDate(values.effectiveFrom)) errors.effectiveFrom = 'date';
  if (values.effectiveUntil !== '') {
    if (!isRealDate(values.effectiveUntil)) errors.effectiveUntil = 'date';
    else if (errors.effectiveFrom === undefined && values.effectiveUntil <= values.effectiveFrom) errors.effectiveUntil = 'order';
  }
  const template = lengthProblem(values.docTemplateCode, 1, MAX.template);
  if (template !== undefined) errors.docTemplateCode = template;
  if (values.exportFormats.length === 0) errors.exportFormats = 'formats';
  if (schemaOf(values.schemaText) === undefined) errors.schemaText = 'json';
  return errors;
}

/** The request body of `createMneFormVersion` for values that passed `validateRevision`. */
export function revisionBody(values: RevisionValues) {
  const reference = values.legalConfirmationRef.trim();
  return {
    form_code: values.formCode.trim(),
    title: values.title.trim(),
    report_kind: values.reportKind as ReportKind,
    legal_basis: values.legalBasis.trim(),
    ...(reference === '' ? {} : { legal_confirmation_ref: reference }),
    effective_from: values.effectiveFrom,
    ...(values.effectiveUntil === '' ? {} : { effective_until: values.effectiveUntil }),
    schema_json: schemaOf(values.schemaText) ?? {},
    doc_template_code: values.docTemplateCode.trim(),
    export_formats: EXPORT_FORMATS.filter((format) => values.exportFormats.includes(format)),
  };
}

// ---- why a command failed ----

export type ProblemReason = 'conflict' | 'selfApproval' | 'stateInvalid' | 'rangeOverlap' | 'templateMissing' | 'invalid' | 'notFound' | 'denied' | 'session' | 'general';

export interface ProblemView {
  reason: ProblemReason;
  /** The server's name of the field the problem is about (`detail`), when it gave one. */
  field: string | undefined;
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  VERSION_CONFLICT: 'conflict',
  SELF_APPROVAL_DENIED: 'selfApproval',
  REPORT_STATE_INVALID: 'stateInvalid',
  FORM_RANGE_OVERLAP: 'rangeOverlap',
  DOC_TEMPLATE_MISSING: 'templateMissing',
  LEGAL_BASIS_REQUIRED: 'invalid',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  FIELD_NOT_ALLOWED: 'invalid',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  SESSION_EXPIRED: 'session',
};

/** Maps an error of an MNE command to what the screen shows; an unknown failure is the general message. */
export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail };
}

/** The problems of generating a year that have a wording of their own. */
export type GenerationProblem = 'noRule' | 'formNotEffective' | 'calendar' | 'scopeDenied' | 'invalid' | 'session' | 'general';

const GENERATION_BY_CODE: Readonly<Record<string, GenerationProblem>> = {
  NO_EFFECTIVE_RULE: 'noRule',
  FORM_NOT_EFFECTIVE: 'formNotEffective',
  CALENDAR_NOT_EFFECTIVE: 'calendar',
  SCOPE_DENIED: 'scopeDenied',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  SESSION_EXPIRED: 'session',
};

export function describeGenerationProblem(error: unknown): GenerationProblem {
  return error instanceof ApiError ? (GENERATION_BY_CODE[error.code] ?? 'general') : 'general';
}

/** The year of the generation form: four digits, in the range the server accepts. */
export function validateYear(value: string): number | undefined {
  if (!/^\d{4}$/.test(value)) return undefined;
  const year = Number(value);
  return year >= 2000 && year <= 2999 ? year : undefined;
}
