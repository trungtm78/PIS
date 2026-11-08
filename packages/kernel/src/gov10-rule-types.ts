import type { AlertTypeSeed, DefaultInput, FieldSpec, RuleTypeInput } from './governance-rules.ts';
import { FLOOD_DIMENSIONS, FLOOD_RULE_TYPE, floodPolicyDefaults, floodPolicyOf } from './alert-flood.ts';
import { LADDER_CHANNELS, LADDER_RULE_TYPE, ladderDefaults, ladderPolicyOf } from './alert-ladder.ts';
import { RED_FLAG_RANKING_RULE_TYPE, rankingDefaults } from './red-flags.ts';
import { ANOMALY_RULE_TYPE, CONTRACT_CLOCK_RULE_TYPE, DATA_FRESHNESS_RULE_TYPE, DOC_REVIEW_RULE_TYPE, contractClockDefaults, dataFreshnessDefaults, docReviewDefaults } from './alert-sources.ts';
import { message } from './messages.ts';

/**
 * The kinds of governance rule and the alert types that lane GOV-10 adds (roadmap G4-3, G2-6, G2-8, G2-9, G2-11, G2-12). This file holds only data (the schema of each type, its built-in defaults with their source, the day
 * they were taken and their legal status, and the seeds of the alert types); `registerGov10Rules` in governance-rules.ts registers it. Every number is a starting value that the customer and the auditors confirm: UNVERIFIED.
 */

const AS_OF = '2026-11-08';
const SOURCE = (): string => message('gov.rules.gov10.source');
const SEVERITIES = ['URGENT', 'ACTION', 'WATCH'] as const;
export const FEEDBACK_RULE_TYPE = 'ALERT_FEEDBACK_POLICY';
export const RED_FLAG_SOURCE = (): string => message('gov.rules.gov10.red_flag.source');

/** Provenance of a built-in red-flag indicator: its formula in words, the catalogue it comes from, the day it was taken, and that its numbers are not confirmed. */
export const redFlagProvenance = (code: string): { formula: string; source: string; asOf: string; legalStatus: 'UNVERIFIED' } => ({ formula: message(`gov.rules.gov10.red_flag.${code.toLowerCase()}.formula`), source: RED_FLAG_SOURCE(), asOf: AS_OF, legalStatus: 'UNVERIFIED' });

const THRESHOLD_VND = '1000000000';
const flag = (code: string, params: Record<string, unknown>): DefaultInput => ({ params: { indicator: message(`gov.rules.gov10.red_flag.${code.toLowerCase()}.indicator`), enabled: true, ...params }, formula: message(`gov.rules.gov10.red_flag.${code.toLowerCase()}.formula`), source: RED_FLAG_SOURCE() });

/** The codes the ten indicators that the type `RED_FLAG_RULE` did not have yet (the two it had, SINGLE_BIDDER and SHORT_TENDER_PERIOD, keep their rows); the threshold in dong is a configuration, not a statement of law. */
export const gov10RedFlagDefaults = (): Record<string, DefaultInput> => ({
  SPLIT_PROCUREMENT: flag('SPLIT_PROCUREMENT', { threshold_vnd: THRESHOLD_VND, window_days: 90, min_count: 2, weight: 4 }),
  THRESHOLD_MANIPULATION: flag('THRESHOLD_MANIPULATION', { threshold_vnd: THRESHOLD_VND, margin_pct: 5, weight: 3 }),
  NEAR_THRESHOLD_DIRECT_AWARDS: flag('NEAR_THRESHOLD_DIRECT_AWARDS', { threshold_vnd: THRESHOLD_VND, margin_pct: 5, min_count: 3, window_days: 365, weight: 3 }),
  DIRECT_AWARD_THEN_CHANGE: flag('DIRECT_AWARD_THEN_CHANGE', { threshold_vnd: THRESHOLD_VND, weight: 4 }),
  AWARD_VS_FINAL_PRICE_GAP: flag('AWARD_VS_FINAL_PRICE_GAP', { threshold: 10, weight: 3 }),
  ADDENDUM_PRICE_INCREASE: flag('ADDENDUM_PRICE_INCREASE', { threshold: 10, weight: 3 }),
  CONTRACT_AMENDED: flag('CONTRACT_AMENDED', { min_count: 3, weight: 2 }),
  AWARD_AT_OR_ABOVE_ESTIMATE: flag('AWARD_AT_OR_ABOVE_ESTIMATE', { threshold: 99, weight: 2 }),
  DEBARRED_BIDDER: flag('DEBARRED_BIDDER', { weight: 5 }),
  IDENTICAL_BID_PRICES: flag('IDENTICAL_BID_PRICES', { weight: 5 }),
});

const int = (min: number, max: number, optional = false): FieldSpec => ({ kind: 'int', min, max, optional });
const num = (min: number, max: number, optional = false): FieldSpec => ({ kind: 'number', min, max, optional });
const text = (max: number, optional = false): FieldSpec => ({ kind: 'text', max, optional });
const bool: FieldSpec = { kind: 'boolean' };
const oneOf = (...values: readonly string[]): FieldSpec => ({ kind: 'enum', values });

/** The alert types of the sources GOV-10 adds; the same first review day as the other built-in types. */
export const GOV10_ALERT_SEEDS: readonly AlertTypeSeed[] = [
  { code: 'CONTRACT_END_NEAR', source: 'CONTRACT_CLOCK', owner: 'CONTRACT_MANAGER', action: message('gov.rules.gov10_alert_seeds.action.contract_end_near'), consequence: message('home.consequence.contract_end_near'), hours: 168, severity: 'WATCH', why: message('gov.rules.gov10_alert_seeds.why.contract_end_near') },
  { code: 'CONTRACT_PAYMENT_UNREQUESTED', source: 'CONTRACT_CLOCK', owner: 'CONTRACT_MANAGER', action: message('gov.rules.gov10_alert_seeds.action.contract_payment_unrequested'), consequence: message('home.consequence.contract_payment_unrequested'), hours: 72, severity: 'ACTION', why: message('gov.rules.gov10_alert_seeds.why.contract_payment_unrequested') },
  { code: 'DOC_REVIEW_OVERDUE', source: 'DOC_REVIEW', owner: 'DOCUMENT_SIGNER', action: message('gov.rules.gov10_alert_seeds.action.doc_review_overdue'), consequence: message('home.consequence.doc_review_overdue'), hours: 48, severity: 'ACTION', why: message('gov.rules.gov10_alert_seeds.why.doc_review_overdue') },
  { code: 'DATA_STALE', source: 'DATA_FRESHNESS', owner: 'DATA_OWNER', action: message('gov.rules.gov10_alert_seeds.action.data_stale'), consequence: message('home.consequence.data_stale'), hours: 72, severity: 'ACTION', why: message('gov.rules.gov10_alert_seeds.why.data_stale') },
  { code: 'ANOMALY_SIGNAL', source: 'ANOMALY', owner: 'AUDITOR', action: message('gov.rules.gov10_alert_seeds.action.anomaly_signal'), consequence: message('home.consequence.anomaly_signal'), hours: 336, severity: 'WATCH', why: message('gov.rules.gov10_alert_seeds.why.anomaly_signal') },
  { code: 'RED_FLAG_NEW', source: 'RED_FLAG', owner: 'AUDITOR', action: message('gov.rules.gov10_alert_seeds.action.red_flag_new'), consequence: message('home.consequence.red_flag_new'), hours: 168, severity: 'ACTION', why: message('gov.rules.gov10_alert_seeds.why.red_flag_new') },
  { code: 'ALERT_FEEDBACK_REVIEW', source: 'ALERT_FEEDBACK', owner: 'ALERT_TYPE_OWNER', action: message('gov.rules.gov10_alert_seeds.action.alert_feedback_review'), consequence: message('home.consequence.alert_feedback_review'), hours: 168, severity: 'WATCH', why: message('gov.rules.gov10_alert_seeds.why.alert_feedback_review') },
];

/** The kinds of rule of lane GOV-10 with their built-in defaults; registered in this order by `registerGov10Rules`. */
export const gov10RuleTypes = (): RuleTypeInput[] => [
  {
    type: RED_FLAG_RANKING_RULE_TYPE,
    ownerModule: 'AUD',
    modules: ['AUD', 'BID', 'CTR'],
    formula: message('gov.rules.gov10.ranking.formula'),
    source: RED_FLAG_SOURCE(),
    asOf: AS_OF,
    legalStatus: 'UNVERIFIED',
    schema: { medium_from: int(1, 100), high_from: int(1, 100) },
    refine: (params) => ((params.medium_from as number) > (params.high_from as number) ? 'medium_from' : undefined),
    defaults: { DEFAULT: { params: { ...rankingDefaults() } } },
  },
  {
    type: LADDER_RULE_TYPE,
    ownerModule: 'NOT',
    modules: ['NOT', 'HOME', 'ADM'],
    formula: message('gov.rules.gov10.ladder.formula'),
    source: SOURCE(),
    asOf: AS_OF,
    legalStatus: 'UNVERIFIED',
    schema: {
      rungs: { kind: 'list', of: { kind: 'object', fields: { channel: oneOf(...LADDER_CHANNELS), wait_minutes: int(0, 4320) } }, min: 1, max: LADDER_CHANNELS.length },
      stop_when: oneOf('DELIVERED', 'SEEN'),
      hand_off: oneOf('ESCALATE', 'NONE'),
      hand_off_after_minutes: int(0, 4320),
      expires_after_minutes: int(1, 43_200),
    },
    refine: (params) => {
      try {
        ladderPolicyOf(params);
        return undefined;
      } catch (failure) {
        return failure instanceof Error && 'detail' in failure ? String((failure as { detail?: string }).detail ?? 'params') : 'params';
      }
    },
    defaults: Object.fromEntries(Object.entries(ladderDefaults()).map(([code, policy]) => [code, { params: JSON.parse(JSON.stringify(policy)) as Record<string, unknown> }])),
  },
  {
    type: FLOOD_RULE_TYPE,
    ownerModule: 'NOT',
    modules: ['NOT', 'HOME'],
    formula: message('gov.rules.gov10.flood.formula'),
    source: SOURCE(),
    asOf: AS_OF,
    legalStatus: 'UNVERIFIED',
    schema: { window_minutes: int(5, 1440), start_above: int(1, 10_000), end_below: int(0, 10_000), max_new_per_day: int(1, 100_000), group_by: { kind: 'list', of: oneOf(...FLOOD_DIMENSIONS), min: 1, max: FLOOD_DIMENSIONS.length }, min_group_size: int(2, 1000) },
    refine: (params) => {
      try {
        floodPolicyOf(params);
        return undefined;
      } catch (failure) {
        return failure instanceof Error && 'detail' in failure ? String((failure as { detail?: string }).detail ?? 'params') : 'params';
      }
    },
    defaults: { DEFAULT: { params: { ...floodPolicyDefaults() } } },
  },
  {
    type: FEEDBACK_RULE_TYPE,
    ownerModule: 'NOT',
    modules: ['NOT', 'HOME', 'ADM'],
    formula: message('gov.rules.gov10.feedback.formula'),
    source: SOURCE(),
    asOf: AS_OF,
    legalStatus: 'UNVERIFIED',
    schema: { review_line_pct: num(1, 100), min_shown: int(1, 100_000), pending_long_days: int(1, 365) },
    defaults: { DEFAULT: { params: { review_line_pct: 30, min_shown: 10, pending_long_days: 7 } } },
  },
  {
    type: CONTRACT_CLOCK_RULE_TYPE,
    ownerModule: 'CTR',
    modules: ['CTR', 'HOME'],
    formula: message('gov.rules.gov10.contract_clock.formula'),
    source: SOURCE(),
    asOf: AS_OF,
    legalStatus: 'UNVERIFIED',
    schema: { end_warning_days: int(1, 365), end_urgent_days: int(0, 365) },
    refine: (params) => ((params.end_urgent_days as number) > (params.end_warning_days as number) ? 'end_urgent_days' : undefined),
    defaults: { DEFAULT: { params: { ...contractClockDefaults() } } },
  },
  {
    type: DOC_REVIEW_RULE_TYPE,
    ownerModule: 'DOC',
    modules: ['DOC', 'HOME'],
    formula: message('gov.rules.gov10.doc_review.formula'),
    source: SOURCE(),
    asOf: AS_OF,
    legalStatus: 'UNVERIFIED',
    schema: { warning_days: int(0, 60) },
    defaults: { DEFAULT: { params: { ...docReviewDefaults() } } },
  },
  {
    type: DATA_FRESHNESS_RULE_TYPE,
    ownerModule: 'DGV',
    modules: ['DGV', 'BI', 'HOME'],
    formula: message('gov.rules.gov10.data_freshness.formula'),
    source: SOURCE(),
    asOf: AS_OF,
    legalStatus: 'UNVERIFIED',
    schema: { stale_severity: oneOf(...SEVERITIES), flag_never_assessed_critical: bool },
    defaults: { DEFAULT: { params: { ...dataFreshnessDefaults() } } },
  },
  {
    type: ANOMALY_RULE_TYPE,
    ownerModule: 'AUD',
    modules: ['AUD', 'PAY', 'CAP', 'HOME'],
    formula: message('gov.rules.gov10.anomaly.formula'),
    source: SOURCE(),
    asOf: AS_OF,
    legalStatus: 'UNVERIFIED',
    schema: { indicator: text(200), window_days: int(1, 3650, true), threshold_pct: num(0, 100, true), threshold_count: int(1, 1000, true), min_amount_vnd: { kind: 'text', max: 24, optional: true, pattern: '^[0-9]{1,24}$' }, severity: oneOf(...SEVERITIES), enabled: bool },
    defaults: {
      PERIOD_END_RUSH: { params: { indicator: message('gov.rules.gov10.anomaly.period_end_rush.indicator'), window_days: 10, threshold_pct: 50, min_amount_vnd: '1000000000', severity: 'WATCH', enabled: true }, formula: message('gov.rules.gov10.anomaly.period_end_rush.formula') },
      ADVANCE_WHILE_OPEN: { params: { indicator: message('gov.rules.gov10.anomaly.advance_while_open.indicator'), min_amount_vnd: '1', severity: 'ACTION', enabled: true }, formula: message('gov.rules.gov10.anomaly.advance_while_open.formula') },
      REPEATED_REALLOCATION: { params: { indicator: message('gov.rules.gov10.anomaly.repeated_reallocation.indicator'), window_days: 365, threshold_count: 3, severity: 'WATCH', enabled: true }, formula: message('gov.rules.gov10.anomaly.repeated_reallocation.formula') },
    },
  },
];
