import { FEATURE_BY_PERMISSION } from './features.ts';

export type PlanLimitKind = 'BOOLEAN' | 'QUOTA' | 'METERED';
export type PlanGraceBehavior = 'ALLOW' | 'READ_ONLY' | 'DENY';
export type PlanExpiredBehavior = 'READ_ONLY' | 'EXPORT_ONLY' | 'DENY';
export type PlanBillingCycle = 'MONTHLY' | 'QUARTERLY' | 'ANNUAL' | 'CONTRACT_TERM';
export type PlanVatCategory = 'NOT_SUBJECT' | 'VAT_0' | 'VAT_5' | 'VAT_8' | 'VAT_10';

/** One feature row of a plan version as an operator writes it (`PlanVersionDraft.features[]`). */
export interface PlanFeatureDraft {
  featureCode: string;
  limitKind: PlanLimitKind;
  /** A non-negative decimal of at most six places, as text. */
  limitValue?: string | undefined;
  meter?: string | undefined;
  graceBehavior: PlanGraceBehavior;
  expiredBehavior: PlanExpiredBehavior;
}

/** A plan version as an operator writes it (`PlanVersionDraft`): the revision number is given by the catalogue, not by the operator. */
export interface PlanDraft {
  planCode: string;
  name: string;
  billingCycles: readonly PlanBillingCycle[];
  /** Integer VND as a decimal string. */
  basePriceVnd: string;
  vatCategory: PlanVatCategory;
  legalTermsRef: string;
  features: readonly PlanFeatureDraft[];
}

export type PlanIssueReason =
  | 'REQUIRED'
  | 'TOO_LONG'
  | 'DUPLICATE'
  | 'PRICE_INVALID'
  | 'FEATURE_UNKNOWN'
  | 'LIMIT_REQUIRED'
  | 'LIMIT_INVALID'
  | 'METER_REQUIRED'
  | 'METER_INVALID'
  | 'METER_NOT_ALLOWED'
  | 'EXPIRED_WIDER_THAN_GRACE';

export interface PlanIssue {
  field: string;
  reason: PlanIssueReason;
}

/**
 * The features a plan can sell: the ones the permissions are gated by (`FEATURE_BY_PERMISSION`) and the seat quota of the
 * tenant. A code outside this set would be sold and never enforced, so a plan that names one is invalid (a new feature is
 * added here together with the code that enforces it).
 */
export const PLAN_FEATURE_CODES: ReadonlySet<string> = new Set([...Object.values(FEATURE_BY_PERMISSION), 'member.seats']);

export const MAX_PLAN_FEATURES = 100;
const MAX_TEXT = 200;
const PRICE_PATTERN = /^[0-9]{1,24}$/;
const LIMIT_PATTERN = /^[0-9]{1,18}(\.[0-9]{1,6})?$/;
const METER_PATTERN = /^[a-z][a-z0-9_.]{1,59}$/;

// How much a feature still gives: a feature in the grace window or after the end must not give more than it did before, so an
// expired licence can never open what a licence in grace keeps shut.
const GRACE_REACH: Readonly<Record<PlanGraceBehavior, number>> = { ALLOW: 3, READ_ONLY: 2, DENY: 0 };
const EXPIRED_REACH: Readonly<Record<PlanExpiredBehavior, number>> = { READ_ONLY: 2, EXPORT_ONLY: 1, DENY: 0 };

const blank = (value: string): boolean => value.trim().length === 0;

function featureIssues(feature: PlanFeatureDraft, at: string): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const add = (member: string, reason: PlanIssueReason): void => {
    issues.push({ field: `${at}.${member}`, reason });
  };
  if (!PLAN_FEATURE_CODES.has(feature.featureCode)) add('feature_code', 'FEATURE_UNKNOWN');
  const { limitValue, meter } = feature;
  if (limitValue !== undefined && !LIMIT_PATTERN.test(limitValue)) add('limit_value', 'LIMIT_INVALID');
  switch (feature.limitKind) {
    case 'BOOLEAN':
      if (limitValue !== undefined && LIMIT_PATTERN.test(limitValue) && Number(limitValue) !== 0 && Number(limitValue) !== 1) add('limit_value', 'LIMIT_INVALID');
      if (meter !== undefined) add('meter', 'METER_NOT_ALLOWED');
      break;
    case 'QUOTA':
      if (limitValue === undefined) add('limit_value', 'LIMIT_REQUIRED');
      if (meter !== undefined) add('meter', 'METER_NOT_ALLOWED');
      break;
    case 'METERED':
      if (meter === undefined || blank(meter)) add('meter', 'METER_REQUIRED');
      else if (!METER_PATTERN.test(meter)) add('meter', 'METER_INVALID');
      break;
  }
  if (EXPIRED_REACH[feature.expiredBehavior] > GRACE_REACH[feature.graceBehavior]) add('expired_behavior', 'EXPIRED_WIDER_THAN_GRACE');
  return issues;
}

/**
 * Everything that makes a plan version unfit to be sold (422 PLAN_INVALID), in the order of the form. An empty list is a plan
 * that may be written as a draft and, unchanged, published: the same function judges both moments (the published promise is
 * the one that was validated).
 */
export function planDraftIssues(draft: PlanDraft): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const add = (field: string, reason: PlanIssueReason): void => {
    issues.push({ field, reason });
  };
  if (blank(draft.name)) add('name', 'REQUIRED');
  else if (draft.name.length > MAX_TEXT) add('name', 'TOO_LONG');
  if (draft.billingCycles.length === 0) add('billing_cycles', 'REQUIRED');
  else if (new Set(draft.billingCycles).size !== draft.billingCycles.length) add('billing_cycles', 'DUPLICATE');
  if (!PRICE_PATTERN.test(draft.basePriceVnd)) add('base_price_vnd', 'PRICE_INVALID');
  if (blank(draft.legalTermsRef)) add('legal_terms_ref', 'REQUIRED');
  else if (draft.legalTermsRef.length > MAX_TEXT) add('legal_terms_ref', 'TOO_LONG');
  if (draft.features.length === 0) add('features', 'REQUIRED');
  else if (draft.features.length > MAX_PLAN_FEATURES) add('features', 'TOO_LONG');
  const seen = new Set<string>();
  draft.features.forEach((feature, index) => {
    const at = `features[${index}]`;
    if (seen.has(feature.featureCode)) add(`${at}.feature_code`, 'DUPLICATE');
    seen.add(feature.featureCode);
    issues.push(...featureIssues(feature, at));
  });
  return issues;
}
