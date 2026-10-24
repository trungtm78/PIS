import { ApiError } from '@machvon/api-client';

/** The permission of SAS-06 (x-permission of the plan operations in openapi.json): the billing operator and the System Admin hold it. */
export const MANAGE_PLANS_PERMISSION = 'system.billing.manage';

export const BILLING_CYCLES = ['MONTHLY', 'QUARTERLY', 'ANNUAL', 'CONTRACT_TERM'] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];
export const VAT_CATEGORIES = ['NOT_SUBJECT', 'VAT_0', 'VAT_5', 'VAT_8', 'VAT_10'] as const;
export type VatCategory = (typeof VAT_CATEGORIES)[number];
export const LIMIT_KINDS = ['BOOLEAN', 'QUOTA', 'METERED'] as const;
export type LimitKind = (typeof LIMIT_KINDS)[number];
export const GRACE_BEHAVIORS = ['ALLOW', 'READ_ONLY', 'DENY'] as const;
export type GraceBehavior = (typeof GRACE_BEHAVIORS)[number];
export const EXPIRED_BEHAVIORS = ['READ_ONLY', 'EXPORT_ONLY', 'DENY'] as const;
export type ExpiredBehavior = (typeof EXPIRED_BEHAVIORS)[number];
export const PLAN_STATUSES = ['Draft', 'Published', 'Retired'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** The features a plan can sell: the ones something enforces (PLAN_FEATURE_CODES of the kernel). */
export const FEATURE_CODES = ['reporting', 'export', 'ai.analysis', 'notification.campaign', 'member.invite', 'member.seats'] as const;
export type FeatureCode = (typeof FEATURE_CODES)[number];

export interface PlanFeature {
  featureCode: string;
  limitKind: LimitKind;
  limitValue: string | null;
  meter: string | null;
  graceBehavior: GraceBehavior;
  expiredBehavior: ExpiredBehavior;
}

export interface PlanRow {
  id: string;
  planCode: string;
  revision: number;
  name: string;
  status: PlanStatus;
  billingCycles: BillingCycle[];
  basePriceVnd: string;
  vatCategory: VatCategory;
  legalTermsRef: string;
  publishedAt: string | null;
  version: number;
  features: PlanFeature[];
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => allowed.find((candidate) => candidate === value) ?? fallback;

function toFeature(raw: unknown): PlanFeature {
  const row: Raw = isRecord(raw) ? raw : {};
  return {
    featureCode: text(row.feature_code),
    limitKind: oneOf(row.limit_kind, LIMIT_KINDS, 'BOOLEAN'),
    limitValue: nullableText(row.limit_value),
    meter: nullableText(row.meter),
    graceBehavior: oneOf(row.grace_behavior, GRACE_BEHAVIORS, 'DENY'),
    expiredBehavior: oneOf(row.expired_behavior, EXPIRED_BEHAVIORS, 'DENY'),
  };
}

export function toPlan(raw: unknown): PlanRow | undefined {
  const row: Raw = isRecord(raw) ? raw : {};
  if (typeof row.id !== 'string') return undefined;
  return {
    id: row.id,
    planCode: text(row.plan_code),
    revision: count(row.revision),
    name: text(row.name),
    status: oneOf(row.status, PLAN_STATUSES, 'Draft'),
    billingCycles: Array.isArray(row.billing_cycles) ? row.billing_cycles.flatMap((cycle) => BILLING_CYCLES.filter((candidate) => candidate === cycle)) : [],
    basePriceVnd: text(row.base_price_vnd),
    vatCategory: oneOf(row.vat_category, VAT_CATEGORIES, 'NOT_SUBJECT'),
    legalTermsRef: text(row.legal_terms_ref),
    publishedAt: nullableText(row.published_at),
    version: count(row.version),
    features: Array.isArray(row.features) ? row.features.map(toFeature) : [],
  };
}

/** Whole VND with the thousands separators of the language, exact for any size; anything that is not digits is shown as it came. */
export function formatPrice(amount: string, locale: string): string {
  return /^-?[0-9]{1,24}$/.test(amount) ? BigInt(amount).toLocaleString(locale) : amount;
}

// ---- the form -----------------------------------------------------------------------------------------------------------

export interface FeatureForm {
  /** A key of the row inside the form, so that removing a row keeps the others as they were typed. */
  key: number;
  featureCode: string;
  limitKind: LimitKind;
  limitValue: string;
  meter: string;
  graceBehavior: GraceBehavior;
  expiredBehavior: ExpiredBehavior;
}

export interface PlanForm {
  planCode: string;
  name: string;
  billingCycles: BillingCycle[];
  basePriceVnd: string;
  vatCategory: VatCategory;
  legalTermsRef: string;
  features: FeatureForm[];
}

export const emptyFeature = (key: number): FeatureForm => ({
  key,
  featureCode: 'reporting',
  limitKind: 'BOOLEAN',
  limitValue: '',
  meter: '',
  graceBehavior: 'ALLOW',
  expiredBehavior: 'READ_ONLY',
});

export const EMPTY_FORM: PlanForm = {
  planCode: '',
  name: '',
  billingCycles: ['ANNUAL'],
  basePriceVnd: '0',
  vatCategory: 'NOT_SUBJECT',
  legalTermsRef: '',
  features: [emptyFeature(0)],
};

/** The form that writes the next revision of a plan: the same code, price, terms and features, to be changed. */
export function formOfRevision(plan: PlanRow): PlanForm {
  return {
    planCode: plan.planCode,
    name: plan.name,
    billingCycles: [...plan.billingCycles],
    basePriceVnd: plan.basePriceVnd,
    vatCategory: plan.vatCategory,
    legalTermsRef: plan.legalTermsRef,
    features: plan.features.map((feature, key) => ({
      key,
      featureCode: feature.featureCode,
      limitKind: feature.limitKind,
      limitValue: feature.limitValue ?? '',
      meter: feature.meter ?? '',
      graceBehavior: feature.graceBehavior,
      expiredBehavior: feature.expiredBehavior,
    })),
  };
}

export type FormField = 'planCode' | 'name' | 'billingCycles' | 'basePriceVnd' | 'legalTermsRef' | 'features';
export type FieldProblem = 'required' | 'format' | 'tooLong' | 'notAmount';
export type FeatureField = 'featureCode' | 'limitValue' | 'meter' | 'expiredBehavior';
export type FeatureProblem = 'duplicate' | 'limitRequired' | 'limitInvalid' | 'meterRequired' | 'meterInvalid' | 'meterNotAllowed' | 'expiredWider';

const PLAN_CODE = /^[a-z0-9-]{3,40}$/;
const AMOUNT = /^[0-9]{1,24}$/;
const LIMIT = /^[0-9]{1,18}(\.[0-9]{1,6})?$/;
const METER = /^[a-z][a-z0-9_.]{1,59}$/;
export const MAX_TEXT = 200;

// How much a feature still gives in the grace window and after the end: the end never gives more than the grace did (the server judges the same).
const GRACE_REACH: Readonly<Record<GraceBehavior, number>> = { ALLOW: 3, READ_ONLY: 2, DENY: 0 };
const EXPIRED_REACH: Readonly<Record<ExpiredBehavior, number>> = { READ_ONLY: 2, EXPORT_ONLY: 1, DENY: 0 };

export interface FormProblems {
  fields: Partial<Record<FormField, FieldProblem>>;
  /** By the key of the feature row. */
  features: Map<number, Partial<Record<FeatureField, FeatureProblem>>>;
}

function featureProblems(feature: FeatureForm, duplicate: boolean): Partial<Record<FeatureField, FeatureProblem>> {
  const found: Partial<Record<FeatureField, FeatureProblem>> = {};
  if (duplicate) found.featureCode = 'duplicate';
  const limit = feature.limitValue.trim();
  const meter = feature.meter.trim();
  if (limit !== '' && !LIMIT.test(limit)) found.limitValue = 'limitInvalid';
  else if (feature.limitKind === 'BOOLEAN' && limit !== '' && Number(limit) !== 0 && Number(limit) !== 1) found.limitValue = 'limitInvalid';
  else if (feature.limitKind === 'QUOTA' && limit === '') found.limitValue = 'limitRequired';
  if (feature.limitKind === 'METERED') {
    if (meter === '') found.meter = 'meterRequired';
    else if (!METER.test(meter)) found.meter = 'meterInvalid';
  } else if (meter !== '') found.meter = 'meterNotAllowed';
  if (EXPIRED_REACH[feature.expiredBehavior] > GRACE_REACH[feature.graceBehavior]) found.expiredBehavior = 'expiredWider';
  return found;
}

/** What is wrong with the form, field by field and feature by feature, in the words the server's own check would use. */
export function validateForm(form: PlanForm): FormProblems {
  const fields: Partial<Record<FormField, FieldProblem>> = {};
  const code = form.planCode.trim();
  if (code === '') fields.planCode = 'required';
  else if (!PLAN_CODE.test(code)) fields.planCode = 'format';
  const name = form.name.trim();
  if (name === '') fields.name = 'required';
  else if (name.length > MAX_TEXT) fields.name = 'tooLong';
  if (form.billingCycles.length === 0) fields.billingCycles = 'required';
  if (!AMOUNT.test(form.basePriceVnd.trim())) fields.basePriceVnd = form.basePriceVnd.trim() === '' ? 'required' : 'notAmount';
  const terms = form.legalTermsRef.trim();
  if (terms === '') fields.legalTermsRef = 'required';
  else if (terms.length > MAX_TEXT) fields.legalTermsRef = 'tooLong';
  if (form.features.length === 0) fields.features = 'required';
  const seen = new Set<string>();
  const features = new Map<number, Partial<Record<FeatureField, FeatureProblem>>>();
  for (const feature of form.features) {
    const found = featureProblems(feature, seen.has(feature.featureCode));
    seen.add(feature.featureCode);
    if (Object.keys(found).length > 0) features.set(feature.key, found);
  }
  return { fields, features };
}

export const hasProblems = (problems: FormProblems): boolean => Object.keys(problems.fields).length > 0 || problems.features.size > 0;

/** The body of `createPlanVersion` for a form that passed `validateForm`. */
export function createBody(form: PlanForm): Record<string, unknown> {
  return {
    plan_code: form.planCode.trim(),
    name: form.name.trim(),
    billing_cycles: BILLING_CYCLES.filter((cycle) => form.billingCycles.includes(cycle)),
    base_price_vnd: form.basePriceVnd.trim(),
    vat_category: form.vatCategory,
    legal_terms_ref: form.legalTermsRef.trim(),
    features: form.features.map((feature) => ({
      feature_code: feature.featureCode,
      limit_kind: feature.limitKind,
      ...(feature.limitValue.trim() === '' ? {} : { limit_value: feature.limitValue.trim() }),
      ...(feature.limitKind === 'METERED' ? { meter: feature.meter.trim() } : {}),
      grace_behavior: feature.graceBehavior,
      expired_behavior: feature.expiredBehavior,
    })),
  };
}

export const MIN_REASON = 10;
export const MAX_REASON = 2000;
export const isReasonValid = (reason: string): boolean => reason.trim().length >= MIN_REASON && reason.trim().length <= MAX_REASON;

// ---- refusals -----------------------------------------------------------------------------------------------------------

export type ProblemReason = 'invalid' | 'planInvalid' | 'immutable' | 'conflict' | 'denied' | 'notFound' | 'session' | 'general';

export interface ProblemView {
  reason: ProblemReason;
  /** For a plan the server found unfit to be sold: the first problem, `field: reason`. */
  field: string | undefined;
  serverReason: string | undefined;
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  PLAN_INVALID: 'planInvalid',
  PLAN_VERSION_IMMUTABLE: 'immutable',
  VERSION_CONFLICT: 'conflict',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  FIELD_NOT_ALLOWED: 'invalid',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  RESOURCE_NOT_FOUND: 'notFound',
  SESSION_EXPIRED: 'session',
};

export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined, serverReason: undefined };
  const reason = error.extensions.reason;
  return { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail, serverReason: typeof reason === 'string' ? reason : undefined };
}
