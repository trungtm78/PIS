import { DomainError } from './errors.ts';

/**
 * The thresholds of the money control (lane B2 of the governance deepening: availability control down to the contract and its changes, the reserve ledger, the tiered change orders, the advance
 * recovery). None of them is a rule of law: they are starting values to be settled with the client and the audit, kept as data (a `governance_rule` of the rule types below once the
 * governance platform lands) and read through one function whose shape is the one of `GovernancePolicyPort.get(tx, type, code, asOf)`, so wiring the port is a one-line change.
 * Legal numbers (the advance cap of Decree 254/2025 and so on) are never here: they stay master rules that are flagged `awaiting_confirmation`.
 */
export const MONEY_RULE_TYPES = ['CHANGE_ORDER_TIER', 'RESERVE_POLICY', 'CONTRACT_AVC', 'ADVANCE_RECOVERY'] as const;
export type MoneyRuleType = (typeof MONEY_RULE_TYPES)[number];

/**
 * The document types of the delegation of authority (ADM) a drawdown of the reserve is limited under. The contingency is limited only where the tenant configured bands; the management reserve belongs to the
 * level above, so a tenant that configured no band for it cannot draw it at all (422 `DOA_RULE_NOT_FOUND`): it is never open by default.
 */
export const RESERVE_DOA_DOCUMENT_TYPE = 'PRJ_RESERVE';
export const RESERVE_MGMT_DOA_DOCUMENT_TYPE = 'PRJ_RESERVE_MGMT';

/** The code of the rule of a tenant that has not chosen one. */
export const DEFAULT_RULE_CODE = 'DEFAULT';

/** One band of the change order tiers: a change stays in this tier while its size and the cumulative variation both stay within the band. */
export interface ChangeTierBand {
  tier: 1 | 2;
  /** The largest change, whichever way it goes, in whole VND. */
  maxAmountVnd: string;
  /** The largest cumulative variation against the original price, in percent with up to two decimals. */
  maxCumulativePct: string;
}

export interface ChangeOrderTierParams {
  /** Tier 1 and tier 2; whatever is above tier 2 is tier 3. */
  bands: readonly [ChangeTierBand, ChangeTierBand];
  /** From this cumulative variation against the original price a project adjustment check is forced (percent, up to two decimals). */
  projectAdjustmentPct: string;
  /** An increase needs a source: an approved drawdown of the reserve for this change order, or a project adjustment that was cleared. */
  requireReserveCover: boolean;
}

export interface ReservePolicyParams {
  /** The alert goes when the balance of the contingency is below this share (percent) of the expected value of the open risks. */
  coverAlertBelowPct: string;
}

export interface ContractAvcParams {
  /** How far above the approved total investment the estimate at completion may go before the alert (percent, up to two decimals). */
  eacAlertAbovePct: string;
}

export interface AdvanceRecoveryParams {
  /** A final payment is refused while an advance of the contract is still owed after the recovery that request makes. */
  finalPaymentRequiresFullRecovery: boolean;
  /** What may stay owed (whole VND) and still count as recovered: rounding of the last request. */
  toleranceVnd: string;
}

export interface MoneyRuleParamsByType {
  CHANGE_ORDER_TIER: ChangeOrderTierParams;
  RESERVE_POLICY: ReservePolicyParams;
  CONTRACT_AVC: ContractAvcParams;
  ADVANCE_RECOVERY: AdvanceRecoveryParams;
}

/** The built-in defaults: working assumptions of the research (CTR F05: cumulative 10 percent of the original price), to be confirmed. */
export const MONEY_RULE_DEFAULTS: { readonly [K in MoneyRuleType]: MoneyRuleParamsByType[K] } = {
  CHANGE_ORDER_TIER: {
    bands: [
      { tier: 1, maxAmountVnd: '500000000', maxCumulativePct: '3' },
      { tier: 2, maxAmountVnd: '5000000000', maxCumulativePct: '10' },
    ],
    projectAdjustmentPct: '10',
    requireReserveCover: true,
  },
  RESERVE_POLICY: { coverAlertBelowPct: '100' },
  CONTRACT_AVC: { eacAlertAbovePct: '0' },
  ADVANCE_RECOVERY: { finalPaymentRequiresFullRecovery: true, toleranceVnd: '0' },
};

/** What a read of the policy gives: the parameters in force, the version of the rule they came from (null for the built-in default) and where they came from. */
export interface MoneyRuleReading<K extends MoneyRuleType = MoneyRuleType> {
  type: K;
  code: string;
  version: number | null;
  source: 'DEFAULT' | 'RULE';
  params: MoneyRuleParamsByType[K];
}

const PCT = /^(0|[1-9][0-9]{0,2})(\.[0-9]{1,2})?$/;
const AMOUNT = /^(0|[1-9][0-9]{0,23})$/;

const bad = (field: string, reason: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field, { extensions: { reason } });
const pct = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !PCT.test(value)) throw bad(field, 'NOT_A_PERCENT');
  return value;
};
const amount = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !AMOUNT.test(value)) throw bad(field, 'NOT_A_WHOLE_AMOUNT');
  return value;
};

const hundredths = (value: string): bigint => {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0') || '0');
};

/** The parameters of a rule as they must be; anything else is 422 `VALIDATION_FAILED` naming the field. Bands must be increasing and the adjustment check not below the second band. */
export function parseMoneyRuleParams<K extends MoneyRuleType>(type: K, raw: unknown): MoneyRuleParamsByType[K] {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  switch (type) {
    case 'CHANGE_ORDER_TIER': {
      const bands = input.bands;
      if (!Array.isArray(bands) || bands.length !== 2) throw bad('bands', 'TWO_BANDS_REQUIRED');
      const [first, second] = bands.map((band, index) => {
        const row = (typeof band === 'object' && band !== null ? band : {}) as Record<string, unknown>;
        return { tier: (index + 1) as 1 | 2, maxAmountVnd: amount(row.maxAmountVnd, `bands.${index}.maxAmountVnd`), maxCumulativePct: pct(row.maxCumulativePct, `bands.${index}.maxCumulativePct`) };
      }) as [ChangeTierBand, ChangeTierBand];
      if (BigInt(first.maxAmountVnd) > BigInt(second.maxAmountVnd) || hundredths(first.maxCumulativePct) > hundredths(second.maxCumulativePct)) throw bad('bands', 'BANDS_NOT_INCREASING');
      const projectAdjustmentPct = pct(input.projectAdjustmentPct, 'projectAdjustmentPct');
      if (hundredths(projectAdjustmentPct) < hundredths(second.maxCumulativePct)) throw bad('projectAdjustmentPct', 'BELOW_SECOND_BAND');
      if (typeof input.requireReserveCover !== 'boolean') throw bad('requireReserveCover', 'NOT_A_BOOLEAN');
      return { bands: [first, second], projectAdjustmentPct, requireReserveCover: input.requireReserveCover } as unknown as MoneyRuleParamsByType[K];
    }
    case 'RESERVE_POLICY':
      return { coverAlertBelowPct: pct(input.coverAlertBelowPct, 'coverAlertBelowPct') } as unknown as MoneyRuleParamsByType[K];
    case 'CONTRACT_AVC':
      return { eacAlertAbovePct: pct(input.eacAlertAbovePct, 'eacAlertAbovePct') } as unknown as MoneyRuleParamsByType[K];
    case 'ADVANCE_RECOVERY': {
      if (typeof input.finalPaymentRequiresFullRecovery !== 'boolean') throw bad('finalPaymentRequiresFullRecovery', 'NOT_A_BOOLEAN');
      return { finalPaymentRequiresFullRecovery: input.finalPaymentRequiresFullRecovery, toleranceVnd: amount(input.toleranceVnd, 'toleranceVnd') } as unknown as MoneyRuleParamsByType[K];
    }
    default:
      throw bad('type', 'UNKNOWN_RULE_TYPE');
  }
}

/** The built-in default as a reading: what the port gives when the tenant has approved no rule. */
export function defaultMoneyRule<K extends MoneyRuleType>(type: K, code: string = DEFAULT_RULE_CODE): MoneyRuleReading<K> {
  return { type, code, version: null, source: 'DEFAULT', params: MONEY_RULE_DEFAULTS[type] };
}
