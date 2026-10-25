import { ApiError } from '@machvon/api-client';

/** The permissions of SAS-07 and SAS-08 (x-permission of the operations in openapi.json). */
export const READ_SUBSCRIPTION_PERMISSION = 'system.tenant.read';
export const MANAGE_SUBSCRIPTION_PERMISSION = 'system.billing.manage';

export const CYCLES = ['MONTHLY', 'QUARTERLY', 'ANNUAL', 'CONTRACT_TERM'] as const;
export type Cycle = (typeof CYCLES)[number];
export const PAYMENT_METHODS = ['BANK_TRANSFER', 'TREASURY_TRANSFER', 'GATEWAY'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const SUBSCRIPTION_STATUSES = ['Trialing', 'Active', 'PastDue', 'Paused', 'Cancelled', 'Expired'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
export type Effective = 'NOW' | 'NEXT_CYCLE';

export interface SubscriptionView {
  id: string;
  planVersionId: string;
  cycle: Cycle;
  billingAnchor: string;
  status: SubscriptionStatus;
  trialEndsAt: string | undefined;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  pendingPlanVersionId: string | undefined;
  pendingEffectiveAt: string | undefined;
  procurementContractRef: string | undefined;
  dueDays: number | undefined;
  method: PaymentMethod | undefined;
  version: number;
}

export interface PlanSummary {
  id: string;
  planCode: string;
  revision: number;
  name: string;
  basePriceVnd: string;
}

export interface PlanChangeEntry {
  id: string;
  fromPlanVersionId: string;
  toPlanVersionId: string;
  effective: Effective;
  effectiveAt: string;
  prorationVnd: string;
  reason: string;
  requestedAt: string;
  appliedAt: string | undefined;
  supersededAt: string | undefined;
}

export interface TenantSubscription {
  subscription: SubscriptionView | undefined;
  plan: PlanSummary | undefined;
  pendingPlan: PlanSummary | undefined;
  changes: PlanChangeEntry[];
}

export interface Violation {
  featureCode: string;
  used: string;
  newLimit: string;
}

export interface PreviewResult {
  previewHash: string;
  prorationVnd: string;
  violations: Violation[];
  effectiveAt: string;
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const optionalText = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => allowed.find((candidate) => candidate === value) ?? fallback;

function toSubscription(raw: unknown): SubscriptionView | undefined {
  const row: Raw = isRecord(raw) ? raw : {};
  if (typeof row.id !== 'string') return undefined;
  const terms: Raw = isRecord(row.payment_terms) ? row.payment_terms : {};
  return {
    id: row.id,
    planVersionId: text(row.plan_version_id),
    cycle: oneOf(row.cycle, CYCLES, 'ANNUAL'),
    billingAnchor: text(row.billing_anchor),
    status: oneOf(row.status, SUBSCRIPTION_STATUSES, 'Active'),
    trialEndsAt: optionalText(row.trial_ends_at),
    currentPeriodStart: text(row.current_period_start),
    currentPeriodEnd: text(row.current_period_end),
    cancelAtPeriodEnd: row.cancel_at_period_end === true,
    pendingPlanVersionId: optionalText(row.pending_plan_version_id),
    pendingEffectiveAt: optionalText(row.pending_effective_at),
    procurementContractRef: optionalText(row.procurement_contract_ref),
    dueDays: typeof terms.due_days === 'number' ? terms.due_days : undefined,
    method: PAYMENT_METHODS.find((candidate) => candidate === terms.method),
    version: count(row.version),
  };
}

function toPlanSummary(raw: unknown): PlanSummary | undefined {
  const row: Raw = isRecord(raw) ? raw : {};
  if (typeof row.id !== 'string') return undefined;
  return { id: row.id, planCode: text(row.plan_code), revision: count(row.revision), name: text(row.name), basePriceVnd: text(row.base_price_vnd) };
}

function toChange(raw: unknown): PlanChangeEntry | undefined {
  const row: Raw = isRecord(raw) ? raw : {};
  if (typeof row.id !== 'string') return undefined;
  return {
    id: row.id,
    fromPlanVersionId: text(row.from_plan_version_id),
    toPlanVersionId: text(row.to_plan_version_id),
    effective: row.effective === 'NOW' ? 'NOW' : 'NEXT_CYCLE',
    effectiveAt: text(row.effective_at),
    prorationVnd: text(row.proration_vnd) || '0',
    reason: text(row.reason),
    requestedAt: text(row.requested_at),
    appliedAt: optionalText(row.applied_at),
    supersededAt: optionalText(row.superseded_at),
  };
}

export function toTenantSubscription(raw: unknown): TenantSubscription {
  const view: Raw = isRecord(raw) ? raw : {};
  return {
    subscription: toSubscription(view.subscription),
    plan: toPlanSummary(view.plan),
    pendingPlan: toPlanSummary(view.pending_plan),
    changes: Array.isArray(view.changes) ? view.changes.flatMap((entry) => toChange(entry) ?? []) : [],
  };
}

export function toPreview(raw: unknown): PreviewResult {
  const view: Raw = isRecord(raw) ? raw : {};
  return {
    previewHash: text(view.preview_hash),
    prorationVnd: text(view.proration_vnd) || '0',
    violations: Array.isArray(view.quota_violations)
      ? view.quota_violations.flatMap((entry): Violation[] => {
          const row: Raw = isRecord(entry) ? entry : {};
          return typeof row.feature_code === 'string' ? [{ featureCode: row.feature_code, used: text(row.used), newLimit: text(row.new_limit) }] : [];
        })
      : [],
    effectiveAt: text(view.effective_at),
  };
}

/** Whole VND with the thousands separators of the language, exact for any size; anything that is not digits is shown as it came. */
export function formatVnd(amount: string, locale: string): string {
  return /^-?[0-9]{1,24}$/.test(amount) ? BigInt(amount).toLocaleString(locale) : amount;
}

/** Whether a change to the target plan may take effect now: only a plan that costs more (the server judges the same); a cheaper or equal one waits for the next cycle. */
export function mayChangeNow(currentPriceVnd: string, targetPriceVnd: string): boolean {
  return /^[0-9]{1,24}$/.test(currentPriceVnd) && /^[0-9]{1,24}$/.test(targetPriceVnd) && BigInt(targetPriceVnd) > BigInt(currentPriceVnd);
}

// ---- the form of SAS-07 -------------------------------------------------------------------------------------------------

export interface SubscriptionForm {
  planVersionId: string;
  cycle: Cycle | '';
  billingAnchor: string;
  trialDays: string;
  contractRef: string;
  dueDays: string;
  method: PaymentMethod;
}

export const EMPTY_FORM: SubscriptionForm = { planVersionId: '', cycle: '', billingAnchor: '', trialDays: '0', contractRef: '', dueDays: '30', method: 'BANK_TRANSFER' };

export type FormField = 'planVersionId' | 'cycle' | 'billingAnchor' | 'trialDays' | 'dueDays' | 'contractRef';
export type FieldProblem = 'required' | 'notDate' | 'notWhole' | 'outOfRange' | 'tooLong';

export const MAX_TRIAL_DAYS = 90;
export const MAX_DUE_DAYS = 180;
export const MAX_CONTRACT_REF = 200;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const WHOLE = /^[0-9]{1,4}$/;

const isCalendarDate = (value: string): boolean => {
  if (!DATE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
  return date.getUTCFullYear() === year && date.getUTCMonth() === (month ?? 1) - 1 && date.getUTCDate() === day;
};

export function validateForm(form: SubscriptionForm): Partial<Record<FormField, FieldProblem>> {
  const problems: Partial<Record<FormField, FieldProblem>> = {};
  if (form.planVersionId === '') problems.planVersionId = 'required';
  if (form.cycle === '') problems.cycle = 'required';
  if (form.billingAnchor === '') problems.billingAnchor = 'required';
  else if (!isCalendarDate(form.billingAnchor)) problems.billingAnchor = 'notDate';
  const trial = form.trialDays.trim();
  if (!WHOLE.test(trial)) problems.trialDays = 'notWhole';
  else if (Number(trial) > MAX_TRIAL_DAYS) problems.trialDays = 'outOfRange';
  const due = form.dueDays.trim();
  if (!WHOLE.test(due)) problems.dueDays = 'notWhole';
  else if (Number(due) > MAX_DUE_DAYS) problems.dueDays = 'outOfRange';
  if (form.contractRef.trim().length > MAX_CONTRACT_REF) problems.contractRef = 'tooLong';
  return problems;
}

/** The body of `createSubscription` for a form that passed `validateForm`. */
export function createBody(form: SubscriptionForm): Record<string, unknown> {
  return {
    plan_version_id: form.planVersionId,
    cycle: form.cycle,
    billing_anchor: form.billingAnchor,
    ...(Number(form.trialDays) > 0 ? { trial_days: Number(form.trialDays) } : {}),
    ...(form.contractRef.trim() === '' ? {} : { procurement_contract_ref: form.contractRef.trim() }),
    payment_terms: { due_days: Number(form.dueDays), method: form.method },
  };
}

export const MIN_REASON = 10;
export const MAX_REASON = 2000;
export const isReasonValid = (reason: string): boolean => reason.trim().length >= MIN_REASON && reason.trim().length <= MAX_REASON;

// ---- refusals -----------------------------------------------------------------------------------------------------------

export type ProblemReason = 'exists' | 'notPublished' | 'stale' | 'conflict' | 'stateInvalid' | 'tenantState' | 'invalid' | 'denied' | 'notFound' | 'session' | 'general';

export interface ProblemView {
  reason: ProblemReason;
  field: string | undefined;
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  SUBSCRIPTION_EXISTS: 'exists',
  PLAN_NOT_PUBLISHED: 'notPublished',
  PREVIEW_STALE: 'stale',
  VERSION_CONFLICT: 'conflict',
  SUBSCRIPTION_STATE_INVALID: 'stateInvalid',
  TENANT_STATE_INVALID: 'tenantState',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  FIELD_NOT_ALLOWED: 'invalid',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  RESOURCE_NOT_FOUND: 'notFound',
  SESSION_EXPIRED: 'session',
};

export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail };
}
