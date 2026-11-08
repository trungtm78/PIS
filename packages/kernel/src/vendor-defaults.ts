import { DomainError } from './errors.ts';
import { message } from './messages.ts';
import { DUPLICATE_SIGNALS, PROFILE_FIELDS } from './vendor-profile.ts';
import type { DuplicateSignal, DuplicateWeights, ProfileField } from './vendor-profile.ts';
import type { DebarmentPeriod } from './vendor-restriction.ts';

/**
 * Built-in starting values of the contractor rules that need no module of their own (VND-1): the profile policy and the weights of the duplicate signals, and the three periods of a ban. Plain data and readers, so the
 * rule registry can spread them into its defaults without a cycle. Every number is a starting value of the research (docs/vendor-management.md), flagged unverified, that a tenant replaces with a rule it approves.
 */

export const VENDOR_PROFILE_RULE_TYPE = 'VENDOR_PROFILE';
export const VENDOR_DUPLICATE_RULE_TYPE = 'VENDOR_DUPLICATE_SIGNALS';
export const VENDOR_DEBARMENT_RULE_TYPE = 'VENDOR_DEBARMENT';
export const VENDOR_DEBARMENT_PERIOD_RULE_TYPE = 'VENDOR_DEBARMENT_PERIOD';
export const VENDOR_REPUTATION_RULE_TYPE = 'VENDOR_REPUTATION';
export const VENDOR_EXPIRY_RULE_TYPE = 'VENDOR_EXPIRY_WARNING';
export const VENDOR_GATE_RULE_TYPE = 'VENDOR_GATE';
export const VENDOR_RULE_CODE = 'DEFAULT';
/** The posting deadline of an event of bid conduct is the rule `EGP_POSTING_DEADLINES` code `REPUTATION_EVENT` (EGP-2), so the clock of the register and the obligation of the posting are one number. */
export const REPUTATION_DEADLINE_CODE = 'REPUTATION_EVENT';

const bad = (field: string): DomainError => new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, field);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The rule `VENDOR_PROFILE`. */
export interface VendorProfilePolicy {
  /** The fields of the profile that must be present before a contractor bids or a contract is activated. */
  required_before_bid: ProfileField[];
  /** Months after which the profile is reviewed again (the next review day of the contractor). */
  review_months: number;
  /** The share of the capital, in percent, at or above which an owner is a beneficial owner (the limit the research reads from the anti money laundering decree: 25 percent or control). */
  beneficial_owner_pct: number;
}

export function vendorProfilePolicyOf(params: unknown): VendorProfilePolicy {
  if (!isRecord(params)) throw bad('params');
  const fields = params.required_before_bid;
  if (!Array.isArray(fields) || fields.length > PROFILE_FIELDS.length || !fields.every((field): field is ProfileField => typeof field === 'string' && (PROFILE_FIELDS as readonly string[]).includes(field))) throw bad('required_before_bid');
  const whole = (field: string, min: number, max: number): number => {
    const value = params[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw bad(field);
    return value;
  };
  return { required_before_bid: [...new Set(fields)], review_months: whole('review_months', 1, 120), beneficial_owner_pct: whole('beneficial_owner_pct', 1, 100) };
}

export const VENDOR_PROFILE_DEFAULTS: VendorProfilePolicy = {
  required_before_bid: ['LEGAL_REPRESENTATIVE', 'REGISTERED_ADDRESS', 'CONTACT', 'OWNERSHIP'],
  review_months: 12,
  beneficial_owner_pct: 25,
};

export function duplicateWeightsOf(params: unknown): DuplicateWeights {
  if (!isRecord(params)) throw bad('params');
  const whole = (field: string, min: number, max: number): number => {
    const value = params[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw bad(field);
    return value;
  };
  const weights = {} as Record<DuplicateSignal, number>;
  for (const signal of DUPLICATE_SIGNALS) weights[signal] = whole(`weight_${signal.toLowerCase()}`, 0, 100);
  return { weights, suggest_from: whole('suggest_from', 1, 1000), name_similarity_from: Math.min(100, whole('name_similarity_from_pct', 1, 100)) / 100 };
}

/** Params of `VENDOR_DUPLICATE_SIGNALS` as the registry keeps them (flat, one number each): the same tax head or a shared account is decisive; an address, a telephone number or a representative alone is a hint to look at. */
export const DUPLICATE_PARAM_DEFAULTS: Readonly<Record<string, number>> = {
  weight_tax_head: 100,
  weight_address: 40,
  weight_phone: 35,
  weight_email: 35,
  weight_legal_representative: 40,
  weight_owner: 40,
  weight_bank_account: 100,
  weight_name: 40,
  suggest_from: 60,
  name_similarity_from_pct: 80,
};

export const DEBARMENT_PERIOD_DEFAULTS = (): Readonly<Record<string, DebarmentPeriod>> => ({
  GROUP_1: { min_months: 36, max_months: 60, behaviours: message('vendor.debarment_group.group_1.behaviours') },
  GROUP_2: { min_months: 12, max_months: 36, behaviours: message('vendor.debarment_group.group_2.behaviours') },
  GROUP_3: { min_months: 6, max_months: 12, behaviours: message('vendor.debarment_group.group_3.behaviours') },
});
