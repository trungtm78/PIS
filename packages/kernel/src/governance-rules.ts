import { DomainError } from './errors.ts';
import { RAG_DIMENSIONS, contractHealthDefaults, contractHealthRagParams } from './ctr-analytics.ts';
import { threeWayDefaults, threeWayParams } from './ctr-money-reports.ts';
import { paymentClockDefaults, paymentClockParams } from './ctr-reports.ts';
import { ratingDefaults, ratingParams } from './ctr-performance-rating.ts';
import { claimLimitationDefaults, claimLimitationParams } from './ctr-register-reports.ts';
import { FIN_CRITERIA_CATEGORIES, FIN_CRITERIA_DEFAULTS, assertCriteriaSet } from './fin-criteria.ts';
import { KPI_HOME_DEFAULTS, RAG_EWS_DEFAULTS } from './analytics-rule-defaults.ts';
import { DIRECTIVE_POLICY_DEFAULTS, parseDirectivePolicy } from './directive.ts';
import { CLAIM_POLICY_DEFAULTS, parseClaimPolicy } from './ctr-claim.ts';
import { EARLY_WARNING_POLICY_DEFAULTS, parseEarlyWarningPolicy } from './ctr-early-warning.ts';
import { COMMITTEE_KPI_DEFAULTS, COMMITTEE_POLICY_DEFAULTS, COMMITTEE_POLICY_RULE_TYPE, committeePolicyParams, parseCommitteePolicy } from './committee-policy.ts';
import { B1_DEFAULTS, EAC_METHODS } from './gov-b1-policy.ts';
import { WORKFLOW_DEFAULTS_AS_OF, WORKFLOW_DEFAULTS_FORMULA, WORKFLOW_DEFAULTS_SOURCE, WORKFLOW_METHODS, WORKFLOW_RULE_TYPE, defaultWorkflowParams, parseWorkflowDefinition } from './bid-workflow.ts';
import { MILESTONE_KINDS } from './procurement-file.ts';
import { FEED_TEXT } from './messages/finance-feed-texts.ts';
import { APPROVAL_WORKFLOW_RULE_TYPE, REPORT_STEP_ASSIGNEE_TYPES, REPORT_STEP_KINDS, REPORT_WORKFLOW_RULE_CODE, WORKFLOW_MODES, defaultReportWorkflowParams, reportWorkflowDefect } from './dis-report-workflow.ts';
import { FND_FIGURE_RULE_CODE, IND_ENTRY_RULE_CODE } from './staged-approval.ts';
import { DATA_ENTRY_EXTRA_DEFAULTS, DATA_ENTRY_RULE_FIELDS, INDICATOR_IMPORT_FIELDS, INDICATOR_IMPORT_RULE_TYPE, INDICATOR_KPI_FIELDS, INDICATOR_SEEDS, indicatorSeedParams, refineDataEntryRule, refineImportMapping, sampleMappingParams } from './ind-definitions.ts';
import { MONEY_RULE_DEFAULTS, parseMoneyRuleParams } from './money-control-policy.ts';
import type { MoneyRuleType } from './money-control-policy.ts';
import { clockPolicyDefaults, clockPolicyOf, reminderPolicyDefaults, reminderPolicyOf, snoozePolicyDefaults, snoozePolicyOf } from './work-clock.ts';
import { ACTUALS_PRECEDENCES, ACTUAL_SOURCES, ENTRY_MODES, FUNDING_TAXONOMY_RULE_TYPE, MEASURES, PERIOD_GRAINS, RATIO_BASES, RATIO_TERMS, enterprisePackParams, publicPackParams, refineFundingPack } from './fnd-taxonomy.ts';
import { HUB_POLICY_PARAMS, hubAlertSeeds, hubAlertSource, hubFreshnessDefaults, hubKpiDefaults, hubPolicyFormula, hubPolicySource } from './connector-hub-defaults.ts';
import { REALLOCATION_POLICY_DEFAULT_CODE, REALLOCATION_POLICY_RULE_TYPE, reallocationPolicyDefaults, reallocationPolicyOf } from './cap-reallocation-impact.ts';
import { PAYMENT_CLOCK_RULE_TYPE, PAYMENT_RETURN_REASON_RULE_TYPE, RETURN_REASON_CATEGORIES, RETURN_REASON_DEFAULTS, RETURN_REASON_SIDES, paymentClockDefaults as payClockDefaults, paymentClockParams as payClockParams, returnReasonParams } from './pay-clock.ts';
import { ACCURACY_RULE_CODE, ACCURACY_RULE_TYPE, MILESTONE_RULE_CODE, MILESTONE_RULE_TYPE, MONTH_DAY_PATTERN, accuracyDefaults, accuracyPolicyOf, milestoneDefaults, milestonePolicyOf } from './dis-milestone-forecast.ts';
import { BASELINE_IMPACT_RULE_CODE, BASELINE_IMPACT_RULE_TYPE, baselineImpactDefaults, baselineImpactOf } from './ctr-adjustment.ts';
import { CONTRACT_SETTLEMENT_RULE_TYPE, SETTLEMENT_CLOCK_STARTS, settlementDeadlineDefaults, settlementDeadlineParams } from './ctr-settlement-clock.ts';
import { LESSONS_RULE_TYPE, LOOK_AHEAD_RULE_TYPE, POLICY_RULE_CODE, lessonsDefaults, lessonsPolicyOf, lookAheadDefaults, lookAheadPolicyOf } from './prj-look-ahead.ts';
import { EXEC_RULE_TYPES } from './ana-rules.ts';
import { message } from './messages.ts';
import { VND2_TEXT } from './messages/vnd2-texts.ts';
import { INDEPENDENCE_POLICY_DEFAULTS, VENDOR_INDEPENDENCE_RULE_TYPE, independencePolicyOf } from './vendor-independence.ts';
import { CAPACITY_POLICY_DEFAULTS, FINANCE_POLICY_DEFAULTS, VENDOR_CAPACITY_RULE_TYPE, VENDOR_FINANCE_RULE_TYPE, capacityPolicyOf, financePolicyOf } from './vendor-finance.ts';
import { BID_SECURITY_POLICY_DEFAULTS, VENDOR_BID_SECURITY_RULE_TYPE, bidSecurityPolicyOf } from './vendor-security.ts';
import { SUBCONTRACT_POLICY_DEFAULTS, VENDOR_SUBCONTRACT_RULE_TYPE, subcontractPolicyOf } from './vendor-subcontract.ts';
import { RISK_FACTORS, RISK_POLICY_DEFAULTS, RISK_TIERS, VENDOR_RISK_RULE_TYPE, riskParamsOf, riskPolicyOf } from './vendor-risk.ts';
import { PERFORMANCE_POLICY_DEFAULTS, VENDOR_PERFORMANCE_RULE_TYPE, performancePolicyOf } from './vendor-performance.ts';
import { PAYEE_ACCOUNT_DEFAULTS, payeeAccountPolicyOf } from './vendor-payee.ts';
import { PROFILE_FIELDS } from './vendor-profile.ts';
import { EXPIRY_WARNING_DEFAULTS, expiryPolicyOf } from './vendor-qualification.ts';
import { DEBARMENT_POLICY_DEFAULTS, GATE_POLICY_DEFAULTS, REPUTATION_POLICY_DEFAULTS, debarmentPeriodOf, debarmentPolicyOf, gatePolicyOf, reputationPolicyOf } from './vendor-restriction.ts';
import { DEBARMENT_PERIOD_DEFAULTS, DUPLICATE_PARAM_DEFAULTS, VENDOR_PROFILE_DEFAULTS, duplicateWeightsOf, vendorProfilePolicyOf } from './vendor-defaults.ts';
import { ABSENCE_RULE_TYPE, absencePolicyDefaults, absencePolicyOf } from './alert-coverage.ts';
import { ESCALATION_RULE_TYPE, ESCALATION_TRIGGERS, escalationPolicyDefaults, escalationPolicyOf } from './alert-escalation.ts';
import { HEALTH_RULE_TYPE, healthTargetDefaults, healthTargetsOf } from './alert-health.ts';
import { ALERT_CHANNELS, NOTIFY_RULE_TYPE, alertNotifyDefaults, alertNotifyPolicyOf } from './alert-notify.ts';
import { ALERT_GOV_TEXT } from './messages/alert-gov-texts.ts';
import { GOV10_ALERT_SEEDS, gov10RedFlagDefaults, gov10RuleTypes, redFlagProvenance } from './gov10-rule-types.ts';
import { registerBuiltInRedFlagIndicators } from './red-flags.ts';
import { TEXT as MR1_TEXT } from './messages/mr1-texts.ts';
import { RISK_INDICATORS, RISK_SIGNAL_DEFAULTS, RISK_SIGNAL_KINDS, RISK_SIGNAL_RULE_CODE, RISK_SIGNAL_RULE_TYPE, parseRiskSignalPolicy, riskSignalParams } from './risk-signals.ts';
import { CALENDAR_DEFAULTS, EFFECT_ANCHORS, EFFECT_CALENDAR_RULE_TYPE, EFFECT_EVALUATION_KINDS, EFFECT_POLICY_DEFAULTS, EFFECT_POLICY_RULE_CODE, EFFECT_POLICY_RULE_TYPE, EFFECT_PROJECT_GROUPS, calendarRuleCode, calendarRuleParams, effectPolicyParams, parseCalendarRule, parseEffectPolicy } from './effect-target.ts';
import { gov12RuleTypes } from './gov12-rule-types.ts';
import { ENT4C_ALERT_SEEDS, ent4cScheduleType } from './ent4c-rule-types.ts';
import { ent4aCrosscheckType } from './ent4a-rule-types.ts';
import { ENT4C_TEXT } from './messages/ent4c-texts.ts';
import { VND3_TEXT } from './messages/vnd3-texts.ts';
import { INVESTIGATION_POLICY_DEFAULTS, investigationPolicyOf } from './vnd-investigation.ts';
import { LINK_KINDS, LINK_PARAM_DEFAULTS, linkPolicyOf } from './vnd-link-graph.ts';
import { RIGGING_PARAM_DEFAULTS, RIGGING_SIGNAL_CODES, riggingPolicyOf } from './vnd-bid-rigging.ts';
import { SCREENING_PARAM_DEFAULTS, screeningPolicyOf } from './vnd-screening.ts';
import { PORTAL_ACCESS_DEFAULTS, portalAccessPolicyOf } from './vnd-portal-access.ts';
import { PORTAL2_TEXT } from './messages/portal2-texts.ts';
import { OCDS_EXPORT_DEFAULTS, PORTAL_CLOCK_DEFAULTS, PORTAL_REQUEST_KINDS, REMEDIATION_POLICY_DEFAULTS, ocdsExportPolicyOf, portalClockPolicyOf, reconfirmationPolicyOf, remediationPolicyOf } from './vnd-portal.ts';

/**
 * The governance rules (G0-1, G0-3 of docs/governance-roadmap-10of10.md): thresholds, definitions and policies kept as data that a tenant can version and approve, never as constants in code. This module is
 * pure: the registry of the kinds of rule (`rule_type`), the schema that checks the params of each, the built-in default params (the starting values of the research, to be confirmed with the customer and the
 * auditors), and `resolveGovernanceRule`, which picks the rule in force on a day. The database side (`governance_rule`, the port `GovernancePolicyPort`) lives in @machvon/db and is a thin reader of this.
 *
 * The registry of rule types is OPEN: the table accepts any `rule_type` that looks like `^[A-Z][A-Z0-9_]{2,63}$`, and a type is known to the platform when a `register*` function below has registered it. One file,
 * one function per domain: a lane that needs a new threshold adds a code under a type (`registerRuleDefaults`) or a type (`registerRuleType`) inside ITS function, never edits a default of another lane.
 * Every type and every built-in default carries where the numbers come from (`source`), the day they were taken (`asOf`), how they are read (`formula`) and whether they were confirmed against the legal text or
 * with the customer (`legalStatus`): `npm run governance:check` fails the build when one of them is missing.
 */

/** A rule type: upper case letters, digits and underscores, starting with a letter, 3 to 64 characters (the same pattern as the CHECK of the table `governance_rule`). */
export const RULE_TYPE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
export const isRuleTypeName = (value: unknown): value is string => typeof value === 'string' && RULE_TYPE_PATTERN.test(value);

/** A module code of the spec (`ADM`, `PAY`, `HOME`): the module that owns a rule type. */
const MODULE_PATTERN = /^[A-Z][A-Z0-9]{1,7}$/;

/** A rule type is any registered name; the type is a string because the registry is open. */
export type GovernanceRuleType = string;

export type GovernanceRuleStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'RETIRED';
export const GOVERNANCE_RULE_STATUSES: readonly GovernanceRuleStatus[] = ['DRAFT', 'SUBMITTED', 'APPROVED', 'RETIRED'];

export type RuleParams = Record<string, unknown>;

/** A rule code: upper case letters, digits and underscores, starting with a letter. */
export const RULE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
export const isRuleCode = (value: unknown): value is string => typeof value === 'string' && RULE_CODE_PATTERN.test(value);

/** Whether the numbers behind a type or a default were confirmed against the legal text or with the customer. `UNVERIFIED` is shown on every screen that shows the number (the label "default, not confirmed"). */
export type LegalStatus = 'VERIFIED' | 'UNVERIFIED';
export const LEGAL_STATUSES: readonly LegalStatus[] = ['VERIFIED', 'UNVERIFIED'];

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The schema of params: a tiny closed language, enough for numbers, words, days and lists. An unknown key is refused (a typo must not become a threshold nobody reads).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

type Optionality = { optional?: boolean };
/** The schema is plain data (a text `pattern` is the source of a regular expression), so the admin screen can build a form from it. */
export type FieldSpec = Optionality &
  (
    | { kind: 'int'; min: number; max: number }
    | { kind: 'number'; min: number; max: number }
    | { kind: 'boolean' }
    | { kind: 'text'; max: number; allowEmpty?: boolean; pattern?: string }
    | { kind: 'date' }
    | { kind: 'time' }
    | { kind: 'enum'; values: readonly string[] }
    | { kind: 'list'; of: FieldSpec; min?: number; max: number }
    | { kind: 'object'; fields: Readonly<Record<string, FieldSpec>> }
  );

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const patterns = new Map<string, RegExp>();
const patternOf = (source: string): RegExp => {
  let found = patterns.get(source);
  if (found === undefined) {
    found = new RegExp(source);
    patterns.set(source, found);
  }
  return found;
};

/** Whether `value` is a real calendar day written `YYYY-MM-DD`. */
export function isRuleDay(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DAY.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const bad = (path: string): DomainError => new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, path);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function check(spec: FieldSpec, value: unknown, path: string): unknown {
  switch (spec.kind) {
    case 'int':
      if (typeof value !== 'number' || !Number.isInteger(value) || value < spec.min || value > spec.max) throw bad(path);
      return value;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || value < spec.min || value > spec.max) throw bad(path);
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') throw bad(path);
      return value;
    case 'text': {
      if (typeof value !== 'string') throw bad(path);
      const trimmed = value.trim();
      if (trimmed !== value || value.length > spec.max || (value.length === 0 && spec.allowEmpty !== true)) throw bad(path);
      if (spec.pattern !== undefined && !patternOf(spec.pattern).test(value)) throw bad(path);
      return value;
    }
    case 'date':
      if (!isRuleDay(value)) throw bad(path);
      return value;
    case 'time':
      if (typeof value !== 'string' || !TIME.test(value)) throw bad(path);
      return value;
    case 'enum':
      if (typeof value !== 'string' || !spec.values.includes(value)) throw bad(path);
      return value;
    case 'list': {
      if (!Array.isArray(value) || value.length > spec.max || value.length < (spec.min ?? 0)) throw bad(path);
      return value.map((item, index) => check(spec.of, item, `${path}[${index}]`));
    }
    case 'object': {
      if (!isRecord(value)) throw bad(path);
      return checkObject(spec.fields, value, path);
    }
  }
}

function checkObject(fields: Readonly<Record<string, FieldSpec>>, value: Record<string, unknown>, path: string): Record<string, unknown> {
  for (const key of Object.keys(value)) if (!(key in fields)) throw bad(path === '' ? key : `${path}.${key}`);
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(fields)) {
    const at = path === '' ? key : `${path}.${key}`;
    const present = value[key];
    if (present === undefined || present === null) {
      if (spec.optional === true) continue;
      throw bad(at);
    }
    out[key] = check(spec, present, at);
  }
  return out;
}

const int = (min: number, max: number, optional = false): FieldSpec => ({ kind: 'int', min, max, optional });
const num = (min: number, max: number, optional = false): FieldSpec => ({ kind: 'number', min, max, optional });
const bool: FieldSpec = { kind: 'boolean' };
const text = (max: number, optional = false, allowEmpty = false): FieldSpec => ({ kind: 'text', max, optional, allowEmpty });
const word = (optional = false): FieldSpec => ({ kind: 'text', max: 64, optional });
/** An upper case code such as a reason or a status (2 to 40 characters). */
const codeText = (optional = false): FieldSpec => ({ kind: 'text', max: 40, optional, pattern: '^[A-Z][A-Z0-9_]{1,39}$' });
const oneOf = (...values: readonly string[]): FieldSpec => ({ kind: 'enum', values });
const list = (of: FieldSpec, max: number, min = 0): FieldSpec => ({ kind: 'list', of, max, min });
const optionally = (spec: FieldSpec): FieldSpec => ({ ...spec, optional: true });
const shape = (fields: Record<string, FieldSpec>): FieldSpec => ({ kind: 'object', fields });
/** One whole-number value for each severity of the alert centre. */
const perSeverity = (min: number, max: number): FieldSpec => shape({ URGENT: int(min, max), ACTION: int(min, max), WATCH: int(min, max) });

const SEVERITIES = ['URGENT', 'ACTION', 'WATCH'] as const;
const SCOPES = ['SAME_RECORD', 'SAME_PROJECT', 'SAME_CONTRACT', 'SAME_PACKAGE'] as const;

/** Judges the params of a lane with the lane's own parser: whatever the parser refuses, the registry refuses too, naming the field the parser names. */
const refineWith =
  (parse: (params: unknown) => unknown): ((params: Record<string, unknown>) => string | undefined) =>
  (params) => {
    try {
      parse(params);
      return undefined;
    } catch (failure) {
      return failure instanceof DomainError ? (failure.detail ?? 'params') : 'params';
    }
  };

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The kinds of rule and their registry.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** What a rule type or a built-in default says about where its numbers come from; `asOf` is the day they were taken (`YYYY-MM-DD`). */
export interface Provenance {
  /** How the number is read or computed, in one sentence a reader of the screen can follow. */
  formula: string;
  /** Where the number comes from: the legal text, the research, the customer, the module that defines it. */
  source: string;
  asOf: string;
  legalStatus: LegalStatus;
}

export interface BuiltInDefault extends Provenance {
  params: RuleParams;
  /** The numbers behind this default are not confirmed against the legal text or with the customer: every screen that shows it says so (roadmap, "not verified"). Always `legalStatus === 'UNVERIFIED'`. */
  unverified: boolean;
}

/** What a lane gives for a default; whatever it leaves out is taken from the type. */
export interface DefaultInput extends Partial<Provenance> {
  params: RuleParams;
}

export interface RuleTypeDefinition extends Provenance {
  type: string;
  /** The module code that owns the type (the lane that answers for its numbers). */
  ownerModule: string;
  /** The module codes of the spec the rule is mostly read by (a hint for the admin screen, not an access rule). */
  modules: readonly string[];
  schema: Readonly<Record<string, FieldSpec>>;
  /** A rule across fields that the closed schema cannot say; returns the offending field. */
  refine?: (params: Record<string, unknown>) => string | undefined;
  /** The shape every code of the type must have (a regular expression source): a type whose codes name something the code owns (a configured report layout) keeps the codes of the code-owned things out. */
  codePattern?: string | undefined;
  /** What applies when the tenant approved no rule of this code. A code that is not here has no default: a caller that needs it must handle `undefined`. */
  defaults: Readonly<Record<string, BuiltInDefault>>;
}

export interface RuleTypeInput extends Provenance {
  type: string;
  ownerModule: string;
  modules: readonly string[];
  schema: Readonly<Record<string, FieldSpec>>;
  refine?: (params: Record<string, unknown>) => string | undefined;
  codePattern?: string | undefined;
  defaults: Readonly<Record<string, DefaultInput>>;
}

const REGISTRY = new Map<string, { definition: Omit<RuleTypeDefinition, 'defaults'>; defaults: Record<string, BuiltInDefault> }>();

const flawOf = (message: string): Error => new Error(`governance rule registry: ${message}`);

function assertProvenance(owner: string, provenance: Partial<Provenance>, required: boolean): void {
  if (provenance.formula !== undefined && provenance.formula.trim().length < 8) throw flawOf(`${owner} has no formula`);
  if (provenance.source !== undefined && provenance.source.trim().length < 3) throw flawOf(`${owner} has no source`);
  if (provenance.asOf !== undefined && !isRuleDay(provenance.asOf)) throw flawOf(`${owner} has an as-of that is not a day`);
  if (provenance.legalStatus !== undefined && !LEGAL_STATUSES.includes(provenance.legalStatus)) throw flawOf(`${owner} has no legal status`);
  if (required && (provenance.formula === undefined || provenance.source === undefined || provenance.asOf === undefined || provenance.legalStatus === undefined)) throw flawOf(`${owner} lacks formula, source, as-of or legal status`);
}

function judge(schema: Readonly<Record<string, FieldSpec>>, refine: RuleTypeDefinition['refine'], params: unknown): RuleParams {
  if (!isRecord(params)) throw bad('params');
  const checked = checkObject(schema, params, '');
  const field = refine?.(checked);
  if (field !== undefined) throw bad(field);
  return checked;
}

function completeDefault(type: string, code: string, input: DefaultInput, definition: Omit<RuleTypeDefinition, 'defaults'>): BuiltInDefault {
  if (!isRuleCode(code)) throw flawOf(`${type} has a default whose code is not a rule code`);
  if (definition.codePattern !== undefined && !patternOf(definition.codePattern).test(code)) throw flawOf(`${type} has a default whose code does not fit the code pattern of the type`);
  assertProvenance(`${type}/${code}`, input, false);
  try {
    judge(definition.schema, definition.refine, input.params);
  } catch (failure) {
    throw flawOf(`the built-in default ${type}/${code} does not pass its own schema (${failure instanceof DomainError ? (failure.detail ?? '?') : 'unknown'})`);
  }
  const legalStatus = input.legalStatus ?? definition.legalStatus;
  return {
    params: input.params,
    formula: input.formula ?? definition.formula,
    source: input.source ?? definition.source,
    asOf: input.asOf ?? definition.asOf,
    legalStatus,
    unverified: legalStatus === 'UNVERIFIED',
  };
}

/** Registers a rule type; a type is registered once (a second registration of the same name is a defect of the lane, not a way to change a type). Every default must pass the schema of the type. */
export function registerRuleType(input: RuleTypeInput): void {
  if (!isRuleTypeName(input.type)) throw flawOf(`${String(input.type)} is not a rule type name`);
  if (REGISTRY.has(input.type)) throw flawOf(`${input.type} is already registered`);
  if (!MODULE_PATTERN.test(input.ownerModule) || input.modules.length === 0 || !input.modules.every((module) => MODULE_PATTERN.test(module))) throw flawOf(`${input.type} names no module that owns it`);
  assertProvenance(input.type, input, true);
  const { defaults, ...definition } = input;
  const entry = { definition, defaults: {} as Record<string, BuiltInDefault> };
  for (const [code, one] of Object.entries(defaults)) entry.defaults[code] = completeDefault(input.type, code, one, definition);
  REGISTRY.set(input.type, entry);
}

/** Adds codes (built-in defaults) under a type that is registered; a code that exists is a defect of the lane that adds it. */
export function registerRuleDefaults(type: string, defaults: Readonly<Record<string, DefaultInput>>): void {
  const entry = REGISTRY.get(type);
  if (entry === undefined) throw flawOf(`${type} is not registered (register the type before its codes)`);
  for (const [code, one] of Object.entries(defaults)) {
    if (entry.defaults[code] !== undefined) throw flawOf(`${type}/${code} already has a default`);
    entry.defaults[code] = completeDefault(type, code, one, entry.definition);
  }
}

const view = (entry: { definition: Omit<RuleTypeDefinition, 'defaults'>; defaults: Record<string, BuiltInDefault> }): RuleTypeDefinition => ({ ...entry.definition, defaults: entry.defaults });

/** Whether a type is registered with the platform (the table accepts any well-formed name; the platform only knows what a `register*` function registered). */
export const isGovernanceRuleType = (value: unknown): value is GovernanceRuleType => typeof value === 'string' && REGISTRY.has(value);

/** The registered types in the order they were registered. */
export const registeredRuleTypes = (): string[] => [...REGISTRY.keys()];

/** Every registered type with its built-in defaults, in the order they were registered. */
export const ruleTypeDefinitions = (): RuleTypeDefinition[] => [...REGISTRY.values()].map(view);

/** The definition of a type; an unknown type is 422 VALIDATION_FAILED on `rule_type`. */
export function ruleTypeOf(type: string): RuleTypeDefinition {
  const entry = REGISTRY.get(type);
  if (entry === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'rule_type');
  return view(entry);
}

/** A type as a screen or a client reads it: plain data (the schema, the provenance, the codes that have a default with theirs), no functions. */
export interface RuleTypeDescription extends Provenance {
  type: string;
  ownerModule: string;
  modules: readonly string[];
  schema: Readonly<Record<string, FieldSpec>>;
  codes: Array<Provenance & { code: string; unverified: boolean }>;
}

export function describeRuleType(type: string): RuleTypeDescription {
  const definition = ruleTypeOf(type);
  return {
    type: definition.type,
    ownerModule: definition.ownerModule,
    modules: definition.modules,
    formula: definition.formula,
    source: definition.source,
    asOf: definition.asOf,
    legalStatus: definition.legalStatus,
    schema: definition.schema,
    codes: Object.entries(definition.defaults).map(([code, one]) => ({ code, formula: one.formula, source: one.source, asOf: one.asOf, legalStatus: one.legalStatus, unverified: one.unverified })),
  };
}

const AS_OF = '2026-11-08';
const SOURCE_RESEARCH = message('gov.rules.source_research');
/** A fresh copy of data from another module, so that a registered default can never be changed by the lane that owns the original. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const rule = (params: RuleParams, legalStatus?: LegalStatus, provenance: Partial<Omit<Provenance, 'legalStatus'>> = {}): DefaultInput => ({ params, ...(legalStatus === undefined ? {} : { legalStatus }), ...provenance });

// -- the alert types of the sources that were there before (G0-3) ---------------------------------------------------------------------------------------------------------------------------------

export interface AlertTypeSeed {
  code: string;
  source: string;
  owner: string;
  action: string;
  consequence: string;
  hours: number;
  severity: (typeof SEVERITIES)[number];
  why: string;
}

/** The first review day of the built-in alert types; a tenant that approves its own type chooses its own. */
export const ALERT_TYPE_FIRST_REVIEW_ON = '2027-05-08';

const CORE_ALERT_TYPE_SEEDS: readonly AlertTypeSeed[] = [
  { code: 'APPROVAL', source: 'APPROVAL', owner: 'APPROVER', action: message('gov.rules.core_alert_type_seeds.action.approval'), consequence: message('gov.rules.core_alert_type_seeds.consequence.approval'), hours: 72, severity: 'ACTION', why: message('gov.rules.core_alert_type_seeds.why.approval') },
  { code: 'EXPLANATION', source: 'EXPLANATION', owner: 'RESPONDENT', action: message('gov.rules.core_alert_type_seeds.action.explanation'), consequence: message('gov.rules.core_alert_type_seeds.consequence.explanation'), hours: 72, severity: 'ACTION', why: message('gov.rules.core_alert_type_seeds.why.explanation') },
  { code: 'EXPLANATION_CONCLUDE', source: 'EXPLANATION_CONCLUDE', owner: 'REQUESTER', action: message('gov.rules.core_alert_type_seeds.action.explanation_conclude'), consequence: message('gov.rules.core_alert_type_seeds.consequence.explanation_conclude'), hours: 72, severity: 'ACTION', why: message('gov.rules.core_alert_type_seeds.why.explanation_conclude') },
  { code: 'REPORT', source: 'REPORT', owner: 'REPORT_OWNER', action: message('gov.rules.core_alert_type_seeds.action.report'), consequence: message('gov.rules.core_alert_type_seeds.consequence.report'), hours: 72, severity: 'ACTION', why: message('gov.rules.core_alert_type_seeds.why.report') },
  { code: 'OBLIGATION', source: 'OBLIGATION', owner: 'REPORT_OWNER', action: message('gov.rules.core_alert_type_seeds.action.obligation'), consequence: message('gov.rules.core_alert_type_seeds.consequence.obligation'), hours: 120, severity: 'ACTION', why: message('gov.rules.core_alert_type_seeds.why.obligation') },
  { code: 'EARLY_WARNING', source: 'EARLY_WARNING', owner: 'PROJECT_OWNER', action: message('gov.rules.core_alert_type_seeds.action.early_warning'), consequence: message('gov.rules.core_alert_type_seeds.consequence.early_warning'), hours: 24, severity: 'ACTION', why: message('gov.rules.core_alert_type_seeds.why.early_warning') },
  { code: 'ADVANCE', source: 'ADVANCE', owner: 'CONTRACT_MANAGER', action: message('gov.rules.core_alert_type_seeds.action.advance'), consequence: message('gov.rules.core_alert_type_seeds.consequence.advance'), hours: 120, severity: 'ACTION', why: message('gov.rules.core_alert_type_seeds.why.advance') },
  { code: 'PERMIT_EXPIRED', source: 'PERMIT', owner: 'SITE_MANAGER', action: message('gov.rules.core_alert_type_seeds.action.permit_expired'), consequence: message('gov.rules.core_alert_type_seeds.consequence.permit_expired'), hours: 24, severity: 'URGENT', why: message('gov.rules.core_alert_type_seeds.why.permit_expired') },
  { code: 'PERMIT_EXPIRING', source: 'PERMIT', owner: 'SITE_MANAGER', action: message('gov.rules.core_alert_type_seeds.action.permit_expiring'), consequence: message('gov.rules.core_alert_type_seeds.consequence.permit_expiring'), hours: 336, severity: 'WATCH', why: message('gov.rules.core_alert_type_seeds.why.permit_expiring') },
  { code: 'AUDIT_RECOMMENDATION_OVERDUE', source: 'AUDIT_RECOMMENDATION', owner: 'RECOMMENDATION_OWNER', action: message('gov.rules.core_alert_type_seeds.action.audit_recommendation_overdue'), consequence: message('gov.rules.core_alert_type_seeds.consequence.audit_recommendation_overdue'), hours: 168, severity: 'ACTION', why: message('gov.rules.core_alert_type_seeds.why.audit_recommendation_overdue') },
  { code: 'AUDIT_RECOMMENDATION_ESCALATED', source: 'AUDIT_RECOMMENDATION', owner: 'UNIT_LEADER', action: message('gov.rules.core_alert_type_seeds.action.audit_recommendation_escalated'), consequence: message('gov.rules.core_alert_type_seeds.consequence.audit_recommendation_escalated'), hours: 48, severity: 'URGENT', why: message('gov.rules.core_alert_type_seeds.why.audit_recommendation_escalated') },
  { code: 'ISSUE_SLA_BREACH', source: 'ISSUE', owner: 'ISSUE_OWNER', action: message('gov.rules.core_alert_type_seeds.action.issue_sla_breach'), consequence: message('gov.rules.core_alert_type_seeds.consequence.issue_sla_breach'), hours: 48, severity: 'ACTION', why: message('gov.rules.core_alert_type_seeds.why.issue_sla_breach') },
  { code: 'ISSUE_SLA_BREACH_L3', source: 'ISSUE', owner: 'TASK_FORCE', action: message('gov.rules.core_alert_type_seeds.action.issue_sla_breach_l3'), consequence: message('gov.rules.core_alert_type_seeds.consequence.issue_sla_breach_l3'), hours: 24, severity: 'URGENT', why: message('gov.rules.core_alert_type_seeds.why.issue_sla_breach_l3') },
  { code: 'SITE_DIARY', source: 'SITE_DIARY', owner: 'SITE_SUPERVISOR', action: message('gov.rules.core_alert_type_seeds.action.site_diary'), consequence: message('gov.rules.core_alert_type_seeds.consequence.site_diary'), hours: 168, severity: 'WATCH', why: message('gov.rules.core_alert_type_seeds.why.site_diary') },
  { code: 'GUARANTEE', source: 'GUARANTEE', owner: 'CONTRACT_MANAGER', action: message('gov.rules.core_alert_type_seeds.action.guarantee'), consequence: message('gov.rules.core_alert_type_seeds.consequence.guarantee'), hours: 168, severity: 'WATCH', why: message('gov.rules.core_alert_type_seeds.why.guarantee') },
];

/** The alert types as built-in defaults of `ALERT_TYPE`: what a lane gives for its own alerts (`registerRuleDefaults('ALERT_TYPE', alertTypeDefaults([...]))`). */
export function alertTypeDefaults(seeds: readonly AlertTypeSeed[], provenance: Partial<Omit<Provenance, 'legalStatus'>> = {}): Record<string, DefaultInput> {
  return Object.fromEntries(
    seeds.map((seed) => [
      seed.code,
      rule(
        {
          source: seed.source,
          owner: seed.owner,
          expected_action: seed.action,
          consequence: seed.consequence,
          response_hours: seed.hours,
          default_severity: seed.severity,
          reason_to_exist: seed.why,
          review_on: ALERT_TYPE_FIRST_REVIEW_ON,
          enabled: true,
        },
        'VERIFIED',
        provenance,
      ),
    ]),
  );
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// One function per domain. Each registers the types of its lane and the codes the lane adds under types of other lanes; each is idempotent, and the order below is the order they run in.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const done = new Set<string>();
const once = (name: string, run: () => void): void => {
  if (done.has(name)) return;
  done.add(name);
  run();
};

const SOURCE_ALERT_CENTRE = message('gov.rules.source_alert_centre');
const SOURCE_KPI = message('gov.rules.source_kpi');

/** The generic kinds of rule (lane A1): the alert types, the gates, the calendar, the notification policy, the advance ceiling, the red flags, the definitions of the indicators and the lines of the traffic lights. */

/** The generic kinds of rule (lane A1): the alert types, the gates, the calendar, the notification policy, the advance ceiling, the red flags, the definitions of the indicators and the lines of the traffic lights. */
export const registerCoreRules = (): void =>
  once('core', () => {
    registerRuleType({
      type: 'ALERT_TYPE',
      ownerModule: 'ADM',
      modules: ['NOT', 'HOME', 'ADM'],
      formula: message('gov.rules.register_core_rules.formula.alert_type'),
      source: SOURCE_ALERT_CENTRE,
      asOf: AS_OF,
      legalStatus: 'VERIFIED',
      schema: {
        source: word(),
        owner: word(),
        expected_action: text(500, true, true),
        consequence: text(500),
        response_hours: int(1, 8760),
        default_severity: oneOf(...SEVERITIES),
        reason_to_exist: text(500),
        review_on: { kind: 'date' },
        enabled: bool,
        // G2-5: an urgent alert of this type may break the quiet hours of a person once nobody took it up in time (off unless the tenant approves a rule that sets it).
        quiet_bypass: optionally(bool),
      },
      // A type with no expected action can only be watched (G0-3).
      refine: (params) => ((params.expected_action === undefined || params.expected_action === '') && params.default_severity !== 'WATCH' ? 'default_severity' : undefined),
      defaults: alertTypeDefaults(CORE_ALERT_TYPE_SEEDS),
    });

    registerRuleType({
      type: 'RAG_THRESHOLDS',
      ownerModule: 'BI',
      modules: ['BI', 'HOME'],
      formula: message('gov.rules.register_core_rules.formula.rag_thresholds'),
      source: SOURCE_RESEARCH,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { direction: oneOf('HIGHER_IS_BETTER', 'LOWER_IS_BETTER'), green: num(-1_000_000, 1_000_000), amber: num(-1_000_000, 1_000_000), min_coverage_pct: int(0, 100), weight: int(0, 100, true) },
      // The green line is on the better side of the amber line, whichever way "better" runs.
      refine: (params) => {
        const [green, amber] = [params.green as number, params.amber as number];
        return (params.direction === 'HIGHER_IS_BETTER' ? green > amber : green < amber) ? undefined : 'green';
      },
      // 0,95 / 0,85 are the starting values of the research (CPI, SPI, ratio of disbursement to plan), to be confirmed with the customer and the auditors.
      defaults: {
        DISBURSEMENT_RATIO: rule({ direction: 'HIGHER_IS_BETTER', green: 0.95, amber: 0.85, min_coverage_pct: 80 }),
        CPI: rule({ direction: 'HIGHER_IS_BETTER', green: 0.95, amber: 0.85, min_coverage_pct: 80 }),
        SPI: rule({ direction: 'HIGHER_IS_BETTER', green: 0.95, amber: 0.85, min_coverage_pct: 80 }),
      },
    });

    registerRuleType({
      type: 'GATE_CRITERIA',
      ownerModule: 'PRJ',
      modules: ['PRJ', 'ADM'],
      formula: message('gov.rules.register_core_rules.formula.gate_criteria'),
      source: message('gov.rules.register_core_rules.source.gate_criteria'),
      asOf: AS_OF,
      legalStatus: 'VERIFIED',
      schema: {
        from_stage: word(),
        to_stage: word(),
        exception_allowed: bool,
        exception_approvers: int(1, 3),
        criteria: list(shape({ code: word(), label: text(200), mandatory: bool, evidence: oneOf('DOCUMENT', 'APPROVAL', 'DATA_CHECK', 'ATTESTATION') }), 40),
      },
      defaults: {
        DEFAULT: rule({
          from_stage: 'ANY',
          to_stage: 'NEXT',
          exception_allowed: true,
          exception_approvers: 2,
          criteria: [{ code: 'RECORD_COMPLETE', label: message('gov.rules.criteria.label.record_complete'), mandatory: true, evidence: 'DOCUMENT' }],
        }),
      },
    });

    registerRuleType({
      type: 'KPI_DEFINITION',
      ownerModule: 'BI',
      modules: ['BI', 'HOME'],
      formula: message('gov.rules.register_core_rules.formula.kpi_definition'),
      source: SOURCE_KPI,
      asOf: AS_OF,
      legalStatus: 'VERIFIED',
      schema: {
        name: text(120),
        formula: text(500),
        source: text(200),
        unit: oneOf('PERCENT', 'VND', 'COUNT', 'DAYS', 'RATIO'),
        owner: word(),
        decimals: int(0, 4),
        refresh_hours: int(1, 744),
        // G0-4: one definition per indicator (the numerator, the denominator, what is left out, the period, how late the figure may be, and the RAG line it is read against).
        numerator: text(300, true),
        denominator: text(300, true),
        exclusions: optionally(list(text(200), 10)),
        period: { kind: 'enum', values: ['YEAR_TO_DATE', 'AS_OF_NOW', 'WEEK', 'MONTH', 'QUARTER'], optional: true },
        allowed_lag_days: int(0, 90, true),
        rag_code: word(true),
        // IND-1: the members that make the register a dictionary (category, how the figure is obtained, its name in the entry rules, the names it carries in the customer's forms).
        ...INDICATOR_KPI_FIELDS,
      },
      defaults: {
        DISBURSEMENT_RATE: rule({ name: message('gov.rules.kpi_definition.disbursement_rate.name'), formula: message('gov.rules.kpi_definition.disbursement_rate.formula'), source: message('gov.rules.kpi_definition.disbursement_rate.source'), unit: 'PERCENT', owner: 'CAPITAL_PLANNER', decimals: 1, refresh_hours: 24 }, undefined, {
          formula: message('gov.rules.kpi_definition.disbursement_rate.formula_2'),
          source: message('gov.rules.kpi_definition.disbursement_rate.source'),
        }),
        PHYSICAL_PROGRESS: rule({ name: message('gov.rules.kpi_definition.physical_progress.name'), formula: message('gov.rules.kpi_definition.physical_progress.formula'), source: message('gov.rules.kpi_definition.physical_progress.source'), unit: 'PERCENT', owner: 'PROJECT_OWNER', decimals: 1, refresh_hours: 24 }, undefined, {
          formula: message('gov.rules.kpi_definition.physical_progress.formula_2'),
          source: message('gov.rules.kpi_definition.physical_progress.source'),
        }),
      },
    });

    registerRuleType({
      type: 'NOTIFICATION_POLICY',
      ownerModule: 'NOT',
      modules: ['NOT', 'IAM'],
      formula: message('gov.rules.register_core_rules.formula.notification_policy'),
      source: SOURCE_RESEARCH,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { quiet_from: { kind: 'time' }, quiet_to: { kind: 'time' }, overdue_urgent_bypasses_quiet: bool, digest_at: { kind: 'time' }, max_push_per_day: int(0, 100), group_same_root: bool },
      defaults: { DEFAULT: rule({ quiet_from: '21:00', quiet_to: '06:30', overdue_urgent_bypasses_quiet: true, digest_at: '07:30', max_push_per_day: 8, group_same_root: true }) },
    });

    registerRuleType({
      type: 'ADVANCE_POLICY',
      ownerModule: 'PAY',
      modules: ['PAY', 'CTR'],
      formula: message('gov.rules.register_core_rules.formula.advance_policy'),
      source: message('gov.rules.register_core_rules.source.advance_policy'),
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { max_pct_of_contract: num(0, 100), recovery_starts_at_pct: num(0, 100), fully_recovered_at_pct: num(0, 100), overdue_after_days: int(0, 365) },
      refine: (params) => ((params.recovery_starts_at_pct as number) > (params.fully_recovered_at_pct as number) ? 'recovery_starts_at_pct' : undefined),
      defaults: { DEFAULT: rule({ max_pct_of_contract: 20, recovery_starts_at_pct: 20, fully_recovered_at_pct: 80, overdue_after_days: 30 }) },
    });

    registerRuleType({
      type: 'RED_FLAG_RULE',
      ownerModule: 'AUD',
      modules: ['BID', 'CTR', 'AUD'],
      formula: message('gov.rules.register_core_rules.formula.red_flag_rule'),
      source: message('gov.rules.register_core_rules.source.red_flag_rule'),
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { indicator: text(200), threshold: num(0, 1_000_000_000, true), window_days: int(1, 3650, true), weight: int(1, 5), enabled: bool, threshold_vnd: { kind: 'text', max: 24, optional: true, pattern: '^[0-9]{1,24}$' }, margin_pct: num(0, 100, true), min_count: int(1, 1000, true) },
      defaults: {
        SINGLE_BIDDER: rule({ indicator: message('gov.rules.red_flag_rule.single_bidder.indicator'), weight: 3, enabled: true }),
        SHORT_TENDER_PERIOD: rule({ indicator: message('gov.rules.red_flag_rule.short_tender_period.indicator'), threshold: 10, weight: 2, enabled: true }),
      },
    });

    registerRuleType({
      type: 'WORKING_CALENDAR',
      ownerModule: 'ADM',
      modules: ['ADM', 'NOT'],
      formula: message('gov.rules.register_core_rules.formula.working_calendar'),
      source: message('gov.rules.register_core_rules.source.working_calendar'),
      asOf: AS_OF,
      legalStatus: 'VERIFIED',
      schema: {
        weekend_days: list({ kind: 'int', min: 0, max: 6 }, 7),
        holidays: list({ kind: 'date' }, 120),
        special_workdays: list({ kind: 'date' }, 60),
        day_starts: { kind: 'time' },
        day_ends: { kind: 'time' },
      },
      defaults: { DEFAULT: rule({ weekend_days: [0, 6], holidays: [], special_workdays: [], day_starts: '08:00', day_ends: '17:00' }) },
    });
  });

const CLOCK_ALERT_SEEDS: readonly AlertTypeSeed[] = [
  {
    code: 'CLOCK',
    source: 'CLOCK',
    owner: 'ITEM_OWNER',
    action: message('gov.rules.clock_alert_seeds.action.clock'),
    consequence: message('gov.rules.clock_alert_seeds.consequence.clock'),
    hours: 48,
    severity: 'ACTION',
    why: message('gov.rules.clock_alert_seeds.why.clock'),
  },
];

/** The clocks of the alert centre (lane A2: G2-1, G2-2, G2-4; packages/kernel/src/work-clock.ts): snooze, the two clocks and their pause, the cadence of reminders. The code that applies to everybody is `DEFAULT`. */

/** The clocks of the alert centre (lane A2: G2-1, G2-2, G2-4; packages/kernel/src/work-clock.ts): snooze, the two clocks and their pause, the cadence of reminders. The code that applies to everybody is `DEFAULT`. */
export const registerWorkClockRules = (): void =>
  once('work-clock', () => {
    registerCoreRules();
    const source = message('gov.rules.register_work_clock_rules.source');
    const reasons = list(codeText(), 20, 1);
    registerRuleType({
      type: 'SNOOZE_POLICY',
      ownerModule: 'HOME',
      modules: ['HOME', 'NOT'],
      formula: message('gov.rules.register_work_clock_rules.formula.snooze_policy'),
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { reasons, note_required_for: optionally(list(codeText(), 20, 1)), max_days_by_severity: perSeverity(0, 90), max_consecutive: int(1, 10), final_notifies_next_level: optionally(bool) },
      refine: refineWith(snoozePolicyOf),
      defaults: { DEFAULT: rule(plain({ ...snoozePolicyDefaults() })) },
    });
    registerRuleType({
      type: 'CLOCK_POLICY',
      ownerModule: 'HOME',
      modules: ['HOME', 'NOT'],
      formula: message('gov.rules.register_work_clock_rules.formula.clock_policy'),
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: {
        claim_within_working_hours: perSeverity(1, 720),
        resolve_within_working_hours: perSeverity(1, 2400),
        no_progress_after_working_hours: perSeverity(1, 720),
        max_pause_days: int(1, 365),
        pause_reasons: list(codeText(), 20, 1),
      },
      refine: refineWith(clockPolicyOf),
      defaults: { DEFAULT: rule(plain({ ...clockPolicyDefaults() })) },
    });
    registerRuleType({
      type: 'REMINDER_POLICY',
      ownerModule: 'HOME',
      modules: ['HOME', 'NOT'],
      formula: message('gov.rules.register_work_clock_rules.formula.reminder_policy'),
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { every_working_hours: perSeverity(1, 720), max_per_item: perSeverity(1, 500) },
      refine: refineWith(reminderPolicyOf),
      defaults: { DEFAULT: rule(plain({ ...reminderPolicyDefaults() })) },
    });
    registerRuleDefaults('ALERT_TYPE', alertTypeDefaults(CLOCK_ALERT_SEEDS, { source: message('gov.rules.register_work_clock_rules.source_2') }));
  });

/** The alert of the baseline lane (B1, G1-3): a milestone or the end of a project that was moved as many times as the rule `BASELINE_DEVIATION` says goes to the auditors (the table `project_governance_alert`, screen PRJ-26). */

/** The alert of the baseline lane (B1, G1-3): a milestone or the end of a project that was moved as many times as the rule `BASELINE_DEVIATION` says goes to the auditors (the table `project_governance_alert`, screen PRJ-26). */
const BASELINE_ALERT_SEEDS: readonly AlertTypeSeed[] = [
  {
    code: 'RESCHEDULE_COUNT',
    source: 'PROJECT_GOVERNANCE',
    owner: 'AUDITOR',
    action: message('gov.rules.baseline_alert_seeds.action.reschedule_count'),
    consequence: message('gov.rules.baseline_alert_seeds.consequence.reschedule_count'),
    hours: 168,
    severity: 'ACTION',
    why: message('gov.rules.baseline_alert_seeds.why.reschedule_count'),
  },
];

/** The baseline, the estimate at completion and the stages that may not be paid (lane B1: G1-2, G1-3, G1-4; packages/kernel/src/gov-b1-policy.ts). */

/** The baseline, the estimate at completion and the stages that may not be paid (lane B1: G1-2, G1-3, G1-4; packages/kernel/src/gov-b1-policy.ts). */
export const registerBaselineRules = (): void =>
  once('baseline', () => {
    registerCoreRules();
    const source = message('gov.rules.register_baseline_rules.source');
    const deviation = B1_DEFAULTS.BASELINE_DEVIATION;
    const evm = B1_DEFAULTS.EVM_POLICY;
    const precondition = B1_DEFAULTS.DISBURSEMENT_PRECONDITION;
    registerRuleType({
      type: 'BASELINE_DEVIATION',
      ownerModule: 'PRJ',
      modules: ['PRJ', 'AUD'],
      formula: message('gov.rules.register_baseline_rules.formula.baseline_deviation'),
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { cost_pct: num(0, 1000), slip_days: int(0, 3650), reschedule_alert_count: int(1, 50) },
      defaults: { DEFAULT: rule({ cost_pct: deviation.costPct, slip_days: deviation.slipDays, reschedule_alert_count: deviation.rescheduleAlertCount }) },
    });
    registerRuleType({
      type: 'EVM_POLICY',
      ownerModule: 'PRJ',
      modules: ['PRJ', 'BI'],
      formula: message('gov.rules.register_baseline_rules.formula.evm_policy'),
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { eac_method: oneOf(...EAC_METHODS), amber_below: num(0, 2), red_below: num(0, 2) },
      refine: (params) => ((params.red_below as number) > (params.amber_below as number) ? 'red_below' : undefined),
      defaults: { DEFAULT: rule({ eac_method: evm.eacMethod, amber_below: evm.amberBelow, red_below: evm.redBelow }) },
    });
    registerRuleType({
      type: 'DISBURSEMENT_PRECONDITION',
      ownerModule: 'PRJ',
      modules: ['PRJ', 'PAY', 'DIS'],
      formula: message('gov.rules.register_baseline_rules.formula.disbursement_precondition'),
      source: message('gov.rules.register_baseline_rules.source.disbursement_precondition'),
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { unlisted_statuses: list(codeText(), 20), require_approved_plan: bool },
      defaults: { DEFAULT: rule({ unlisted_statuses: [...precondition.unlistedStatuses], require_approved_plan: precondition.requireApprovedPlan }) },
    });
    registerRuleDefaults('ALERT_TYPE', alertTypeDefaults(BASELINE_ALERT_SEEDS, { source: message('gov.rules.register_baseline_rules.source_2') }));
  });

const AMOUNT_PATTERN = '^(0|[1-9][0-9]{0,23})$';
const PERCENT_PATTERN = '^(0|[1-9][0-9]{0,2})(\\.[0-9]{1,2})?$';
const amountText: FieldSpec = { kind: 'text', max: 24, pattern: AMOUNT_PATTERN };
const percentText: FieldSpec = { kind: 'text', max: 6, pattern: PERCENT_PATTERN };

const MONEY_ALERT_SEEDS: readonly AlertTypeSeed[] = [
  {
    code: 'EAC_EXCEEDS_TMDT',
    source: 'MONEY_CONTROL',
    owner: 'PROJECT_OWNER',
    action: message('gov.rules.money_alert_seeds.action.eac_exceeds_tmdt'),
    consequence: message('gov.rules.money_alert_seeds.consequence.eac_exceeds_tmdt'),
    hours: 48,
    severity: 'URGENT',
    why: message('gov.rules.money_alert_seeds.why.eac_exceeds_tmdt'),
  },
  {
    code: 'RESERVE_BELOW_RISK_EV',
    source: 'MONEY_CONTROL',
    owner: 'PROJECT_OWNER',
    action: message('gov.rules.money_alert_seeds.action.reserve_below_risk_ev'),
    consequence: message('gov.rules.money_alert_seeds.consequence.reserve_below_risk_ev'),
    hours: 120,
    severity: 'ACTION',
    why: message('gov.rules.money_alert_seeds.why.reserve_below_risk_ev'),
  },
  {
    code: 'ADVANCE_EXCEEDS_REMAINING',
    source: 'MONEY_CONTROL',
    owner: 'CONTRACT_MANAGER',
    action: message('gov.rules.money_alert_seeds.action.advance_exceeds_remaining'),
    consequence: message('gov.rules.money_alert_seeds.consequence.advance_exceeds_remaining'),
    hours: 48,
    severity: 'URGENT',
    why: message('gov.rules.money_alert_seeds.why.advance_exceeds_remaining'),
  },
];

/** The control of the money (lane B2: G1-6, G1-7, G1-11; packages/kernel/src/money-control-policy.ts). The params keep the names and the string numbers of that module (amounts in whole VND, percents with two decimals). */

/** The control of the money (lane B2: G1-6, G1-7, G1-11; packages/kernel/src/money-control-policy.ts). The params keep the names and the string numbers of that module (amounts in whole VND, percents with two decimals). */
export const registerMoneyRules = (): void =>
  once('money', () => {
    registerCoreRules();
    const source = message('gov.rules.register_money_rules.source');
    const money = <K extends MoneyRuleType>(type: K): RuleParams => plain(MONEY_RULE_DEFAULTS[type]) as unknown as RuleParams;
    registerRuleType({
      type: 'CHANGE_ORDER_TIER',
      ownerModule: 'CTR',
      modules: ['CTR', 'PRJ', 'ADM'],
      formula: message('gov.rules.register_money_rules.formula.change_order_tier'),
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: {
        bands: list(shape({ tier: optionally(int(1, 2)), maxAmountVnd: amountText, maxCumulativePct: percentText }), 2, 2),
        projectAdjustmentPct: percentText,
        requireReserveCover: bool,
      },
      refine: refineWith((params) => parseMoneyRuleParams('CHANGE_ORDER_TIER', params)),
      defaults: { DEFAULT: rule(money('CHANGE_ORDER_TIER')) },
    });
    registerRuleType({
      type: 'RESERVE_POLICY',
      ownerModule: 'PRJ',
      modules: ['PRJ', 'CAP'],
      formula: message('gov.rules.register_money_rules.formula.reserve_policy'),
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { coverAlertBelowPct: percentText },
      refine: refineWith((params) => parseMoneyRuleParams('RESERVE_POLICY', params)),
      defaults: { DEFAULT: rule(money('RESERVE_POLICY')) },
    });
    registerRuleType({
      type: 'CONTRACT_AVC',
      ownerModule: 'CAP',
      modules: ['CAP', 'CTR', 'PRJ'],
      formula: message('gov.rules.register_money_rules.formula.contract_avc'),
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { eacAlertAbovePct: percentText },
      refine: refineWith((params) => parseMoneyRuleParams('CONTRACT_AVC', params)),
      defaults: { DEFAULT: rule(money('CONTRACT_AVC')) },
    });
    registerRuleType({
      type: 'ADVANCE_RECOVERY',
      ownerModule: 'PAY',
      modules: ['PAY', 'CTR'],
      formula: message('gov.rules.register_money_rules.formula.advance_recovery'),
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { finalPaymentRequiresFullRecovery: bool, toleranceVnd: amountText },
      refine: refineWith((params) => parseMoneyRuleParams('ADVANCE_RECOVERY', params)),
      defaults: { DEFAULT: rule(money('ADVANCE_RECOVERY')) },
    });
    registerRuleDefaults('ALERT_TYPE', alertTypeDefaults(MONEY_ALERT_SEEDS, { source: message('gov.rules.register_money_rules.source_2') }));
  });

const ANALYTICS_SOURCE = message('gov.rules.analytics_source');

/** The indicators of the command centre and the factors of the early-warning score (lane C: G0-4, G3-2; packages/kernel/src/analytics-rule-defaults.ts) added under `KPI_DEFINITION` and `RAG_THRESHOLDS`. */

/** The indicators of the command centre and the factors of the early-warning score (lane C: G0-4, G3-2; packages/kernel/src/analytics-rule-defaults.ts) added under `KPI_DEFINITION` and `RAG_THRESHOLDS`. */
export const registerAnalyticsRules = (): void =>
  once('analytics', () => {
    registerCoreRules();
    const status = (unverified: boolean): LegalStatus => (unverified ? 'UNVERIFIED' : 'VERIFIED');
    registerRuleDefaults(
      'KPI_DEFINITION',
      Object.fromEntries(
        Object.entries(KPI_HOME_DEFAULTS).map(([code, one]) => [
          code,
          rule(plain(one.params), status(one.unverified), { formula: String(one.params.formula ?? ''), source: String(one.params.source ?? ANALYTICS_SOURCE), asOf: AS_OF }),
        ]),
      ),
    );
    registerRuleDefaults(
      'RAG_THRESHOLDS',
      Object.fromEntries(
        Object.entries(RAG_EWS_DEFAULTS).map(([code, one]) => {
          const direction = one.params.direction === 'HIGHER_IS_BETTER' ? message('gov.rules.register_analytics_rules.direction') : message('gov.rules.register_analytics_rules.direction_2');
          const weight = typeof one.params.weight === 'number' ? message('gov.rules.register_analytics_rules.weight', { weight: one.params.weight }) : '';
          return [
            code,
            rule(plain(one.params), status(one.unverified), {
              formula: message('gov.rules.register_analytics_rules.formula', { direction: direction, p1: String(one.params.green), direction2: direction, p3: String(one.params.amber), weight: weight }),
              source: ANALYTICS_SOURCE,
              asOf: AS_OF,
            }),
          ];
        }),
      ),
    );
  });

const SOD_CONFLICT = (action_a: string, action_b: string, scope: (typeof SCOPES)[number], exception_max_days: number): Record<string, unknown> => ({ action_a, action_b, scope, severity: 'BLOCK', exception_max_days });

const INTEGRITY_ALERT_SEEDS: readonly AlertTypeSeed[] = [
  { code: 'SOD_EXCEPTION_EXPIRING', source: 'SOD_EXCEPTION', owner: 'ADM_ADMINISTRATOR', action: message('gov.rules.integrity_alert_seeds.action.sod_exception_expiring'), consequence: message('gov.rules.integrity_alert_seeds.consequence.sod_exception_expiring'), hours: 120, severity: 'ACTION', why: message('gov.rules.integrity_alert_seeds.why.sod_exception_expiring') },
  { code: 'SOD_EXCEPTION_USED', source: 'SOD_EXCEPTION', owner: 'AUDITOR', action: message('gov.rules.integrity_alert_seeds.action.sod_exception_used'), consequence: message('gov.rules.integrity_alert_seeds.consequence.sod_exception_used'), hours: 336, severity: 'WATCH', why: message('gov.rules.integrity_alert_seeds.why.sod_exception_used') },
  { code: 'PAYMENT_INTEGRITY_BLOCKED', source: 'PAYMENT_INTEGRITY', owner: 'PAYMENT_APPROVER', action: message('gov.rules.integrity_alert_seeds.action.payment_integrity_blocked'), consequence: message('gov.rules.integrity_alert_seeds.consequence.payment_integrity_blocked'), hours: 72, severity: 'ACTION', why: message('gov.rules.integrity_alert_seeds.why.payment_integrity_blocked') },
  { code: 'PAYMENT_INTEGRITY_SIGNAL', source: 'PAYMENT_INTEGRITY', owner: 'PAYMENT_APPROVER', action: message('gov.rules.integrity_alert_seeds.action.payment_integrity_signal'), consequence: message('gov.rules.integrity_alert_seeds.consequence.payment_integrity_signal'), hours: 168, severity: 'WATCH', why: message('gov.rules.integrity_alert_seeds.why.payment_integrity_signal') },
  { code: 'DISBURSEMENT_EXCEPTION_EXPIRING', source: 'DISBURSEMENT_EXCEPTION', owner: 'CONTRACT_MANAGER', action: message('gov.rules.integrity_alert_seeds.action.disbursement_exception_expiring'), consequence: message('gov.rules.integrity_alert_seeds.consequence.disbursement_exception_expiring'), hours: 168, severity: 'WATCH', why: message('gov.rules.integrity_alert_seeds.why.disbursement_exception_expiring') },
  { code: 'TREASURY_RECON_ITEM_OVERDUE', source: 'TREASURY_RECON', owner: 'RECON_ITEM_OWNER', action: message('gov.rules.integrity_alert_seeds.action.treasury_recon_item_overdue'), consequence: message('gov.rules.integrity_alert_seeds.consequence.treasury_recon_item_overdue'), hours: 72, severity: 'ACTION', why: message('gov.rules.integrity_alert_seeds.why.treasury_recon_item_overdue') },
  { code: 'CROSS_TOTAL_MISMATCH', source: 'CROSS_TOTAL', owner: 'DIS_DATA_STEWARD', action: message('gov.rules.integrity_alert_seeds.action.cross_total_mismatch'), consequence: message('gov.rules.integrity_alert_seeds.consequence.cross_total_mismatch'), hours: 48, severity: 'ACTION', why: message('gov.rules.integrity_alert_seeds.why.cross_total_mismatch') },
];

/**
 * Integrity of the money and of the duties (lane D: G4-1, G4-2, G4-4, G4-5): the matrix of conflicting duties, the checks of a payment request, the reconciliation with the Treasury. The shapes follow the plans of
 * lane D (docs/gov-d-*.md); the lane adjusts them here when its code settles. Every number is a starting value that says so on the screen.
 */

/**
 * Integrity of the money and of the duties (lane D: G4-1, G4-2, G4-4, G4-5): the matrix of conflicting duties, the checks of a payment request, the reconciliation with the Treasury. The shapes follow the plans of
 * lane D (docs/gov-d-*.md); the lane adjusts them here when its code settles. Every number is a starting value that says so on the screen.
 */
export const registerIntegrityRules = (): void =>
  once('integrity', () => {
    registerCoreRules();
    const source = message('gov.rules.register_integrity_rules.source');
    registerRuleType({
      type: 'SOD_MATRIX',
      ownerModule: 'ADM',
      modules: ['ADM', 'CTR', 'PAY', 'BID'],
      formula: message('gov.rules.register_integrity_rules.formula.sod_matrix'),
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: {
        conflicts: list(shape({ action_a: word(), action_b: word(), scope: oneOf(...SCOPES), severity: oneOf('BLOCK', 'WARN'), exception_max_days: int(0, 90) }), 60),
        exception_approvers: int(1, 3),
      },
      defaults: {
        DEFAULT: rule({
          exception_approvers: 2,
          conflicts: [
            SOD_CONFLICT('contract.draft', 'contract.approve', 'SAME_CONTRACT', 14),
            SOD_CONFLICT('measurement.record', 'measurement.approve', 'SAME_RECORD', 14),
            SOD_CONFLICT('acceptance.record', 'acceptance.approve', 'SAME_RECORD', 14),
            SOD_CONFLICT('payment.request', 'payment.verify', 'SAME_RECORD', 14),
            SOD_CONFLICT('payment.request', 'payment.approve', 'SAME_RECORD', 14),
            SOD_CONFLICT('advance.request', 'advance.approve', 'SAME_RECORD', 14),
            SOD_CONFLICT('bid.evaluate', 'bid.award', 'SAME_PACKAGE', 0),
            SOD_CONFLICT('bid.evaluate', 'bid.sign_off', 'SAME_PACKAGE', 0),
            // Lane D (G4-1): the chain across the steps of one contract is watched, not stopped: whoever approved the work and then checks the payment of the same contract is shown to the auditor (WARN).
            { ...SOD_CONFLICT('acceptance.approve', 'payment.verify', 'SAME_CONTRACT', 14), severity: 'WARN' },
            { ...SOD_CONFLICT('measurement.approve', 'payment.request', 'SAME_CONTRACT', 14), severity: 'WARN' },
            { ...SOD_CONFLICT('contract.approve', 'payment.approve', 'SAME_CONTRACT', 14), severity: 'WARN' },
          ],
        }),
      },
    });
    registerRuleType({
      type: 'PAYMENT_INTEGRITY',
      ownerModule: 'PAY',
      modules: ['PAY', 'AUD', 'CTR'],
      formula:
        message('gov.rules.register_integrity_rules.formula.payment_integrity'),
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: {
        duplicate: shape({ block_attrs: list(oneOf('NUMBER', 'SUPPLIER', 'AMOUNT', 'DATE'), 4, 1), signal_min_matches: int(1, 5), lookback_days: int(1, 3650) }),
        unit_price: shape({ contract_tolerance_pct: num(0, 1000), peer_min: int(2, 1000), robust_z: num(0, 20) }),
        diary: shape({ tolerance_pct: num(0, 1000), min_diary_days_ratio: num(0, 1) }),
        ceilings: shape({ plan: oneOf('BLOCK', 'WARN'), contract: oneOf('BLOCK', 'WARN'), accepted: oneOf('BLOCK', 'WARN') }),
        exception_max_days: int(0, 90),
      },
      defaults: {
        DEFAULT: rule({
          duplicate: { block_attrs: ['NUMBER', 'SUPPLIER', 'AMOUNT'], signal_min_matches: 3, lookback_days: 365 },
          unit_price: { contract_tolerance_pct: 15, peer_min: 5, robust_z: 3.5 },
          diary: { tolerance_pct: 10, min_diary_days_ratio: 0.5 },
          ceilings: { plan: 'BLOCK', contract: 'BLOCK', accepted: 'BLOCK' },
          exception_max_days: 30,
        }),
      },
    });
    registerRuleType({
      type: 'RECONCILIATION_POLICY',
      ownerModule: 'PAY',
      modules: ['PAY', 'DIS'],
      formula: message('gov.rules.register_integrity_rules.formula.reconciliation_policy'),
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { threshold_vnd: int(0, 1_000_000_000_000), threshold_pct: num(0, 100, true), due_days: int(1, 60), partial_after_days: int(0, 30) },
      defaults: { DEFAULT: rule({ threshold_vnd: 1_000_000, due_days: 3, partial_after_days: 1 }) },
    });
    registerRuleDefaults('ALERT_TYPE', alertTypeDefaults(INTEGRITY_ALERT_SEEDS, { source: message('gov.rules.register_integrity_rules.source_2') }));
  });

/** The dimensions the colour of a contract is judged on (the indicators of `ctr-analytics`): the colour is the worst of them, so a single red one is never averaged away (CA-2 decision, docs/ctr-analytics-money.md). */
export const CONTRACT_HEALTH_INDICATORS = RAG_DIMENSIONS;

/** The health of a contract and the concentration of the portfolio (lane CA: CA-1, CA-3). */
export const registerContractRules = (): void =>
  once('contract', () => {
    registerCoreRules();
    const source = message('gov.rules.register_contract_rules.source');
    registerRuleType({
      type: 'CONTRACT_HEALTH_RAG',
      ownerModule: 'CTR',
      modules: ['CTR', 'BI', 'HOME'],
      formula: message('gov.rules.register_contract_rules.formula.contract_health_rag'),
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: {
        days_late_amber: int(0, 1_000_000),
        days_late_red: int(0, 1_000_000),
        change_growth_amber_pct: num(0, 1_000_000),
        change_growth_red_pct: num(0, 1_000_000),
        guarantee_coverage_amber_pct: num(0, 1_000_000),
        guarantee_coverage_red_pct: num(0, 1_000_000),
        paid_to_accepted_amber_pct: num(0, 1_000_000),
        paid_to_accepted_red_pct: num(0, 1_000_000),
      },
      refine: refineWith(contractHealthRagParams),
      defaults: { DEFAULT: rule({ ...contractHealthDefaults() }) },
    });
    registerRuleType({
      type: 'CONTRACT_CONCENTRATION',
      ownerModule: 'CTR',
      modules: ['CTR', 'BI', 'AUD'],
      formula: message('gov.rules.register_contract_rules.formula.contract_concentration'),
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: {
        basis: oneOf('CONTRACT_VALUE', 'CONTRACT_COUNT'),
        top_n: int(1, 20),
        top_share_amber_pct: num(0, 100),
        top_share_red_pct: num(0, 100),
        hhi_amber: int(0, 10_000),
        hhi_red: int(0, 10_000),
        single_bidder_amber_pct: num(0, 100),
        single_bidder_red_pct: num(0, 100),
        min_contracts: int(1, 1000),
      },
      refine: (params) => {
        if ((params.top_share_amber_pct as number) > (params.top_share_red_pct as number)) return 'top_share_amber_pct';
        if ((params.hhi_amber as number) > (params.hhi_red as number)) return 'hhi_amber';
        return (params.single_bidder_amber_pct as number) > (params.single_bidder_red_pct as number) ? 'single_bidder_amber_pct' : undefined;
      },
      defaults: {
        DEFAULT: rule({ basis: 'CONTRACT_VALUE', top_n: 5, top_share_amber_pct: 50, top_share_red_pct: 70, hhi_amber: 1000, hhi_red: 1800, single_bidder_amber_pct: 20, single_bidder_red_pct: 40, min_contracts: 10 }),
      },
    });
    registerRuleType({
      type: 'CONTRACT_PAYMENT_CLOCK',
      ownerModule: 'CTR',
      modules: ['CTR', 'PAY', 'BI'],
      formula: message('gov.rules.register_contract_rules.formula.contract_payment_clock'),
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { acceptance_to_request_days: int(1, 365), request_to_treasury_days: int(1, 365) },
      refine: refineWith(paymentClockParams),
      defaults: { DEFAULT: rule({ ...paymentClockDefaults() }) },
    });
    registerRuleType({
      type: 'CONTRACT_THREE_WAY_MATCH',
      ownerModule: 'CTR',
      modules: ['CTR', 'PAY', 'BI'],
      formula: message('gov.rules.register_contract_rules.formula.contract_three_way_match'),
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { tolerance_pct: num(0, 100), tolerance_vnd: int(0, 1_000_000_000_000) },
      refine: refineWith(threeWayParams),
      defaults: { DEFAULT: rule({ ...threeWayDefaults() }) },
    });
    registerRuleType({
      type: 'CONTRACT_CLAIM_LIMITATION',
      ownerModule: 'CTR',
      modules: ['CTR', 'BI'],
      formula: message('gov.rules.register_contract_rules.formula.contract_claim_limitation'),
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { decision_window_days: int(1, 3650), near_days: int(0, 365) },
      refine: refineWith(claimLimitationParams),
      defaults: { DEFAULT: rule({ ...claimLimitationDefaults() }) },
    });
    registerRuleType({
      type: 'CONTRACT_PERFORMANCE_RATING',
      ownerModule: 'CTR',
      modules: ['CTR', 'BID', 'BI'],
      formula: message('gov.rules.register_contract_rules.formula.contract_performance_rating'),
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: {
        weight_quality_pct: int(0, 100),
        weight_schedule_pct: int(0, 100),
        weight_safety_env_pct: int(0, 100),
        weight_cooperation_pct: int(0, 100),
        weight_financial_pct: int(0, 100),
        excellent_min: num(0, 100),
        good_min: num(0, 100),
        fair_min: num(0, 100),
        min_criteria: int(1, 5),
        min_observation_days: int(0, 3650),
        quality_penalty_critical: int(0, 100),
        quality_penalty_major: int(0, 100),
        quality_penalty_minor: int(0, 100),
        quality_penalty_reopen: int(0, 100),
        quality_closed_weight_pct: int(0, 100),
        schedule_zero_score_days_late: int(1, 3650),
        safety_penalty_minor: int(0, 100),
        safety_penalty_major: int(0, 100),
        safety_penalty_critical: int(0, 100),
        cooperation_penalty_overdue: int(0, 100),
        cooperation_penalty_escalated: int(0, 100),
        financial_guarantee_max_penalty: int(0, 100),
        financial_overpaid_max_penalty: int(0, 100),
        financial_audit_max_penalty: int(0, 100),
      },
      refine: refineWith(ratingParams),
      defaults: { DEFAULT: rule({ ...ratingDefaults() }) },
    });
  });

const INTEGRATION_ALERT_SEEDS: readonly AlertTypeSeed[] = [
  { code: 'CONNECTOR_STALE', source: 'CONNECTOR', owner: 'INTEGRATION_ADMINISTRATOR', action: message('gov.rules.integration_alert_seeds.action.connector_stale'), consequence: message('gov.rules.integration_alert_seeds.consequence.connector_stale'), hours: 24, severity: 'ACTION', why: message('gov.rules.integration_alert_seeds.why.connector_stale') },
  { code: 'EGP_POSTING_DUE', source: 'EGP_POSTING', owner: 'PROCUREMENT_OFFICER', action: message('gov.rules.integration_alert_seeds.action.egp_posting_due'), consequence: message('gov.rules.integration_alert_seeds.consequence.egp_posting_due'), hours: 48, severity: 'ACTION', why: message('gov.rules.integration_alert_seeds.why.egp_posting_due') },
  { code: 'EGP_POSTING_OVERDUE', source: 'EGP_POSTING', owner: 'PROCUREMENT_OFFICER', action: message('gov.rules.integration_alert_seeds.action.egp_posting_overdue'), consequence: message('gov.rules.integration_alert_seeds.consequence.egp_posting_overdue'), hours: 24, severity: 'URGENT', why: message('gov.rules.integration_alert_seeds.why.egp_posting_overdue') },
];

const POSTING_UNITS = ['WORKING_DAYS', 'CALENDAR_DAYS', 'MONTHS'] as const;
const POSTING_STARTS = ['DECISION_APPROVED', 'RESULT_ISSUED', 'CONTRACT_SIGNED', 'CONTRACT_COMPLETED', 'EVENT_OCCURRED', 'CONTRACTOR_NOTIFIED'] as const;

/** The data that arrives from outside and the duties of posting to the national procurement network (lane INT, EGP: EGP-1, EGP-2). */

/** The data that arrives from outside and the duties of posting to the national procurement network (lane INT, EGP: EGP-1, EGP-2). */
export const registerIntegrationRules = (): void =>
  once('integration', () => {
    registerCoreRules();
    const source = message('gov.rules.register_integration_rules.source');
    registerRuleType({
      type: 'CONNECTOR_FRESHNESS',
      ownerModule: 'INT',
      modules: ['INT', 'ADM', 'HOME'],
      formula: message('gov.rules.register_integration_rules.formula.connector_freshness'),
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { max_age_hours: int(1, 8760), warn_after_hours: int(1, 8760), stale_severity: oneOf(...SEVERITIES), figures_blocked_when_stale: bool },
      refine: (params) => ((params.warn_after_hours as number) > (params.max_age_hours as number) ? 'warn_after_hours' : undefined),
      defaults: {
        DEFAULT: rule({ max_age_hours: 168, warn_after_hours: 96, stale_severity: 'ACTION', figures_blocked_when_stale: false }),
        TREASURY_STATEMENT: rule({ max_age_hours: 72, warn_after_hours: 36, stale_severity: 'ACTION', figures_blocked_when_stale: true }, undefined, { formula: message('gov.rules.connector_freshness.treasury_statement.formula') }),
        EGP_FILE: rule({ max_age_hours: 168, warn_after_hours: 120, stale_severity: 'WATCH', figures_blocked_when_stale: false }, undefined, { formula: message('gov.rules.connector_freshness.egp_file.formula') }),
      },
    });
    registerRuleType({
      type: 'EGP_POSTING_DEADLINES',
      ownerModule: 'BID',
      modules: ['BID', 'CTR', 'HOME'],
      formula: message('gov.rules.register_integration_rules.formula.egp_posting_deadlines'),
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { obligation: text(200), due_in: int(1, 3650), due_unit: oneOf(...POSTING_UNITS), starts_on: oneOf(...POSTING_STARTS), remind_before_days: int(0, 365), legal_basis: text(300) },
      defaults: {
        PLAN: rule({ obligation: message('gov.rules.egp_posting_deadlines.plan.obligation'), due_in: 5, due_unit: 'WORKING_DAYS', starts_on: 'DECISION_APPROVED', remind_before_days: 2, legal_basis: message('gov.rules.egp_posting_deadlines.plan.legal_basis') }),
        NOTICE: rule({ obligation: message('gov.rules.egp_posting_deadlines.notice.obligation'), due_in: 5, due_unit: 'WORKING_DAYS', starts_on: 'DECISION_APPROVED', remind_before_days: 2, legal_basis: message('gov.rules.egp_posting_deadlines.plan.legal_basis') }),
        RESULT: rule({ obligation: message('gov.rules.egp_posting_deadlines.result.obligation'), due_in: 5, due_unit: 'WORKING_DAYS', starts_on: 'RESULT_ISSUED', remind_before_days: 2, legal_basis: message('gov.rules.egp_posting_deadlines.plan.legal_basis') }),
        CONTRACT_INFO: rule({ obligation: message('gov.rules.egp_posting_deadlines.contract_info.obligation'), due_in: 5, due_unit: 'WORKING_DAYS', starts_on: 'CONTRACT_SIGNED', remind_before_days: 2, legal_basis: message('gov.rules.egp_posting_deadlines.plan.legal_basis') }),
        CONTRACTOR_PERFORMANCE: rule({ obligation: message('gov.rules.egp_posting_deadlines.contractor_performance.obligation'), due_in: 6, due_unit: 'MONTHS', starts_on: 'CONTRACT_COMPLETED', remind_before_days: 14, legal_basis: message('gov.rules.egp_posting_deadlines.contractor_performance.legal_basis') }),
        VIOLATION: rule({ obligation: message('gov.rules.egp_posting_deadlines.violation.obligation'), due_in: 7, due_unit: 'WORKING_DAYS', starts_on: 'EVENT_OCCURRED', remind_before_days: 2, legal_basis: message('gov.rules.egp_posting_deadlines.violation.legal_basis') }),
        REPUTATION_EVENT: rule({ obligation: message('gov.rules.egp_posting_deadlines.reputation_event.obligation'), due_in: 7, due_unit: 'WORKING_DAYS', starts_on: 'EVENT_OCCURRED', remind_before_days: 2, legal_basis: message('gov.rules.egp_posting_deadlines.reputation_event.legal_basis') }),
        CONTRACTOR_RESPONSE: rule({ obligation: message('gov.rules.egp_posting_deadlines.contractor_response.obligation'), due_in: 20, due_unit: 'CALENDAR_DAYS', starts_on: 'CONTRACTOR_NOTIFIED', remind_before_days: 5, legal_basis: message('gov.rules.egp_posting_deadlines.contractor_response.legal_basis') }),
      },
    });
    registerRuleType({
      type: 'EGP_POSTING_SEVERITY',
      ownerModule: 'BID',
      modules: ['BID', 'HOME'],
      formula: message('gov.rules.register_integration_rules.formula.egp_posting_severity'),
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { urgent_within_hours: int(0, 720) },
      defaults: { DEFAULT: rule({ urgent_within_hours: 24 }) },
    });
    registerRuleType({
      type: 'EGP_RECONCILIATION_POLICY',
      ownerModule: 'BID',
      modules: ['BID', 'HOME'],
      formula: message('gov.rules.register_integration_rules.formula.egp_reconciliation_policy'),
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { due_in_working_days: int(1, 365) },
      defaults: { DEFAULT: rule({ due_in_working_days: 10 }) },
    });
    registerRuleDefaults('ALERT_TYPE', alertTypeDefaults(INTEGRATION_ALERT_SEEDS, { source: message('gov.rules.register_integration_rules.source_2') }));
  });

const DIRECTIVE_ALERT_SEEDS: readonly AlertTypeSeed[] = [
  { code: 'DIRECTIVE_DUE', source: 'DIRECTIVE', owner: 'DIRECTIVE_ASSIGNEE', action: message('gov.rules.directive_alert_seeds.action.directive_due'), consequence: message('gov.rules.directive_alert_seeds.consequence.directive_due'), hours: 48, severity: 'ACTION', why: message('gov.rules.directive_alert_seeds.why.directive_due') },
  { code: 'DIRECTIVE_OVERDUE', source: 'DIRECTIVE', owner: 'DIRECTIVE_ASSIGNEE', action: message('gov.rules.directive_alert_seeds.action.directive_overdue'), consequence: message('gov.rules.directive_alert_seeds.consequence.directive_overdue'), hours: 72, severity: 'ACTION', why: message('gov.rules.directive_alert_seeds.why.directive_overdue') },
  { code: 'DIRECTIVE_ESCALATED', source: 'DIRECTIVE', owner: 'UNIT_LEADER', action: message('gov.rules.directive_alert_seeds.action.directive_escalated'), consequence: message('gov.rules.directive_alert_seeds.consequence.directive_escalated'), hours: 24, severity: 'URGENT', why: message('gov.rules.directive_alert_seeds.why.directive_escalated') },
];

/** The directives of the steering meetings (lane DIR-1; packages/kernel/src/directive.ts): reminder days, escalation, extensions, evidence to close. */

/** The directives of the steering meetings (lane DIR-1; packages/kernel/src/directive.ts): reminder days, escalation, extensions, evidence to close. */
export const registerDirectiveRules = (): void =>
  once('directive', () => {
    registerCoreRules();
    registerRuleType({
      type: 'DIRECTIVE_POLICY',
      ownerModule: 'DIR',
      modules: ['DIR', 'HOME'],
      formula: message('gov.rules.register_directive_rules.formula.directive_policy'),
      source: message('gov.rules.register_directive_rules.source.directive_policy'),
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { reminder_days_before: list(int(0, 60), 8, 1), escalate_after_overdue_days: int(1, 90), max_extensions: int(0, 20), max_extension_days: int(1, 365), close_requires_evidence: bool },
      refine: refineWith(parseDirectivePolicy),
      defaults: { DEFAULT: rule({ reminder_days_before: [...DIRECTIVE_POLICY_DEFAULTS.reminderDaysBefore], escalate_after_overdue_days: DIRECTIVE_POLICY_DEFAULTS.escalateAfterOverdueDays, max_extensions: DIRECTIVE_POLICY_DEFAULTS.maxExtensions, max_extension_days: DIRECTIVE_POLICY_DEFAULTS.maxExtensionDays, close_requires_evidence: DIRECTIVE_POLICY_DEFAULTS.closeRequiresEvidence }) },
    });
    registerRuleDefaults('ALERT_TYPE', alertTypeDefaults(DIRECTIVE_ALERT_SEEDS, { source: message('gov.rules.register_directive_rules.source') }));
  });

const COMMITTEE_ALERT_SEEDS: readonly AlertTypeSeed[] = [
  { code: 'COMMITTEE_PROVINCE_BEHIND', source: 'COMMITTEE', owner: 'COMMITTEE_HEAD', action: message('gov.rules.committee_alert_seeds.action.province_behind'), consequence: message('gov.rules.committee_alert_seeds.consequence.province_behind'), hours: 72, severity: 'ACTION', why: message('gov.rules.committee_alert_seeds.why.province_behind') },
  { code: 'COMMITTEE_SECTOR_BEHIND', source: 'COMMITTEE', owner: 'COMMITTEE_HEAD', action: message('gov.rules.committee_alert_seeds.action.sector_behind'), consequence: message('gov.rules.committee_alert_seeds.consequence.sector_behind'), hours: 120, severity: 'ACTION', why: message('gov.rules.committee_alert_seeds.why.sector_behind') },
  { code: 'COMMITTEE_UNIT_NOT_REPORTING', source: 'COMMITTEE', owner: 'COMMITTEE_SECRETARIAT', action: message('gov.rules.committee_alert_seeds.action.unit_not_reporting'), consequence: message('gov.rules.committee_alert_seeds.consequence.unit_not_reporting'), hours: 72, severity: 'WATCH', why: message('gov.rules.committee_alert_seeds.why.unit_not_reporting') },
  { code: 'COMMITTEE_DIRECTIVE_OVERDUE', source: 'COMMITTEE', owner: 'COMMITTEE_SECRETARIAT', action: message('gov.rules.committee_alert_seeds.action.directive_overdue'), consequence: message('gov.rules.committee_alert_seeds.consequence.directive_overdue'), hours: 72, severity: 'ACTION', why: message('gov.rules.committee_alert_seeds.why.directive_overdue') },
];

/** The thresholds of the committee workspace and its figures in the KPI register (lane BAN-1; packages/kernel/src/committee-policy.ts): the expected curve, the lines of the colours, the reasons a project needs the head and their weights, the four alerts. */
export const registerCommitteeRules = (): void =>
  once('committee', () => {
    registerCoreRules();
    registerAnalyticsRules();
    registerRuleType({
      type: COMMITTEE_POLICY_RULE_TYPE,
      ownerModule: 'BAN',
      modules: ['BAN', 'HOME', 'DIR'],
      formula: message('gov.rules.register_committee_rules.formula'),
      source: message('gov.rules.register_committee_rules.source'),
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: {
        curve: list(shape({ month: int(1, 12), cumulative_pct: num(0, 100) }), 12, 12),
        province_gap_points: num(0, 100),
        rag_gap_green: num(-100, 0),
        rag_gap_amber: num(-100, 0),
        sector_gap_points: num(0, 100),
        sector_min_plan_share_pct: num(0, 100),
        unit_not_reporting_days: int(1, 365),
        unit_min_reporting_rate_pct: num(0, 100),
        delay_days: int(1, 3650),
        stalled_days: int(1, 3650),
        over_budget_pct: num(0, 500),
        far_below_points: num(0, 100),
        weights: shape({ delayed: num(0, 10), stalled: num(0, 10), over_budget: num(0, 10), far_below: num(0, 10), not_reporting: num(0, 10) }),
        exposure_reference_vnd: int(1, 1_000_000_000_000_000),
        attention_top_n: int(1, 200),
        directive_overdue_alert_count: int(1, 1000),
      },
      refine: refineWith(parseCommitteePolicy),
      defaults: { DEFAULT: rule(plain(committeePolicyParams(COMMITTEE_POLICY_DEFAULTS))) },
    });
    registerRuleDefaults(
      'KPI_DEFINITION',
      Object.fromEntries(Object.entries(COMMITTEE_KPI_DEFAULTS).map(([code, one]) => [code, rule(plain(one.params), one.unverified ? 'UNVERIFIED' : 'VERIFIED', { formula: String(one.params.formula ?? ''), source: String(one.params.source ?? ''), asOf: AS_OF })])),
    );
    registerRuleDefaults('ALERT_TYPE', alertTypeDefaults(COMMITTEE_ALERT_SEEDS, { source: message('gov.rules.register_committee_rules.alert_source') }));
  });

/** The model of the money of an enterprise and the checks at the moment of entry (lane FND, IND: FND-1, IND-1). */

/** The model of the money of an enterprise and the checks at the moment of entry (lane FND, IND: FND-1, IND-1). */
export const registerEnterpriseRules = (): void =>
  once('enterprise', () => {
    registerCoreRules();
    registerRuleType({
      type: FUNDING_TAXONOMY_RULE_TYPE,
      ownerModule: 'FND',
      modules: ['FND', 'DIS', 'CAP', 'MNE', 'BI'],
      formula: message('gov.rules.register_enterprise_rules.formula.funding_taxonomy'),
      source: message('gov.rules.register_enterprise_rules.source.funding_taxonomy'),
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: {
        pack_label: text(80),
        classes: list(shape({ code: codeText(), label: text(120), additive: bool, takes_subsets: list(codeText(), 6) }), 12, 2),
        tiers: list(shape({ code: codeText(), label: text(120) }), 6, 1),
        subsets: list(shape({ code: codeText(), label: text(160), of_classes: list(codeText(), 12, 1) }), 6),
        tags: list(shape({ code: codeText(), label: text(120), carries_amount: bool }), 20),
        measures: list(oneOf(...MEASURES), 2, 1),
        origin_groups: shape({ PRIMARY: list(codeText(), 12), ADDED: list(codeText(), 12) }),
        origin_decisions: optionally(list(shape({ origin: codeText(), kinds: list(codeText(), 12, 1) }), 12)),
        entry_mode: oneOf(...ENTRY_MODES),
        phasing_must_sum: bool,
        actuals_source: list(shape({ class_codes: list(codeText(), 12, 1), source: oneOf(...ACTUAL_SOURCES) }), 12, 1),
        actuals_precedence: oneOf(...ACTUALS_PRECEDENCES),
        variance_tolerance: shape({ pct: num(0, 100), abs_vnd: int(0, 1_000_000_000_000) }),
        ratios: list(shape({ code: codeText(), numerator: oneOf(...RATIO_TERMS), denominator: oneOf(...RATIO_TERMS), class_filter: list(codeText(), 12), basis: oneOf(...RATIO_BASES) }), 16, 1),
        period_grains: list(oneOf(...PERIOD_GRAINS), 4, 1),
      },
      refine: refineFundingPack,
      defaults: {
        PUBLIC: rule(publicPackParams(), 'VERIFIED', { formula: message('gov.rules.funding_taxonomy.public.formula') }),
        ENTERPRISE: rule(enterprisePackParams(), 'UNVERIFIED', { formula: message('gov.rules.funding_taxonomy.enterprise.formula') }),
      },
    });
    registerRuleType({
      type: 'DATA_ENTRY_RULE',
      ownerModule: 'IND',
      modules: ['IND', 'DIS', 'ADM'],
      formula: message('gov.rules.register_enterprise_rules.formula.data_entry_rule'),
      source: message('gov.rules.register_enterprise_rules.source.data_entry_rule'),
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: DATA_ENTRY_RULE_FIELDS,
      refine: refineDataEntryRule,
      defaults: {
        ...Object.fromEntries(Object.entries(DATA_ENTRY_EXTRA_DEFAULTS).map(([code, params]) => [code, rule(plain(params))])),
        CUMULATIVE_NOT_ABOVE_TOTAL: rule({ check: 'CUMULATIVE_NOT_ABOVE_TOTAL', severity: 'BLOCK', fields: ['CUMULATIVE'], total_field: 'TOTAL_INVESTMENT', message: message('gov.rules.data_entry_rule.cumulative_not_above_total.message') }),
        EQUITY_PLUS_DEBT_EQUALS_TOTAL: rule({ check: 'PARTS_EQUAL_TOTAL', severity: 'BLOCK', fields: ['EQUITY', 'DEBT'], total_field: 'TOTAL', tolerance: 0, message: message('gov.rules.data_entry_rule.equity_plus_debt_equals_total.message') }),
        CLOSED_PERIOD_LOCKED: rule({ check: 'PERIOD_LOCKED_AFTER_CLOSE', severity: 'BLOCK', fields: ['REPORTING_PERIOD'], message: message('gov.rules.data_entry_rule.closed_period_locked.message') }),
        MANDATORY_FIELDS: rule({ check: 'FIELD_REQUIRED', severity: 'BLOCK', fields: ['MANDATORY_FIELDS'], message: message('gov.rules.data_entry_rule.mandatory_fields.message') }),
      },
    });
  });

/** The weights of the non-financial benefits of an investment appraisal (lane FIN-1, AI.06): one set of criteria for each category (safety, compliance, maintenance), approved by someone other than who proposed it. */

/** The weights of the non-financial benefits of an investment appraisal (lane FIN-1, AI.06): one set of criteria for each category (safety, compliance, maintenance), approved by someone other than who proposed it. */
export const registerFinanceRules = (): void =>
  once('finance', () => {
    registerCoreRules();
    registerRuleType({
      type: 'FIN_CRITERIA',
      ownerModule: 'PRJ',
      modules: ['PRJ', 'ADM'],
      formula: message('gov.rules.register_finance_rules.formula.fin_criteria'),
      source: message('gov.rules.register_finance_rules.source.fin_criteria'),
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: {
        criteria: list(
          shape({
            key: { kind: 'text', max: 40, pattern: '^[a-z][a-z0-9_]{1,39}$' },
            label: text(160),
            weight_pct: { kind: 'text', max: 6, pattern: '^(0|[1-9][0-9]?|100)(\\.[0-9]{1,2})?$' },
          }),
          15,
          2,
        ),
      },
      // The weights add up to exactly 100 and the keys are unique: the same judgement the appraisal makes when it scores.
      refine: (params) => {
        try {
          const criteria = (params['criteria'] as Array<{ key: string; label: string; weight_pct: string }>).map((one) => ({ key: one.key, label: one.label, weightPct: one.weight_pct }));
          assertCriteriaSet({ category: 'SAFETY', criteria });
          return undefined;
        } catch (failure) {
          return failure instanceof DomainError ? (failure.detail ?? 'criteria') : 'criteria';
        }
      },
      defaults: Object.fromEntries(
        FIN_CRITERIA_CATEGORIES.map((category) => [
          category,
          rule({ criteria: FIN_CRITERIA_DEFAULTS[category].criteria.map((one) => ({ key: one.key, label: one.label, weight_pct: one.weightPct })) }, 'UNVERIFIED', {
            formula: message('gov.rules.defaults.fin_criteria.formula') + category + message('gov.rules.defaults.fin_criteria.formula_2'),
          }),
        ]),
      ),
    });
  });

const PROCUREMENT_WORKFLOW_ALERT_SEEDS: readonly AlertTypeSeed[] = [
  { code: 'PRC_STEP_OVERDUE', source: 'PROCUREMENT_WORKFLOW', owner: 'PACKAGE_OWNER', action: message('gov.rules.procurement_workflow_alert_seeds.action.prc_step_overdue'), consequence: message('gov.rules.procurement_workflow_alert_seeds.consequence.prc_step_overdue'), hours: 48, severity: 'ACTION', why: message('gov.rules.procurement_workflow_alert_seeds.why.prc_step_overdue') },
  { code: 'PRC_CHECKLIST_DUE', source: 'PROCUREMENT_WORKFLOW', owner: 'CHECKLIST_OWNER', action: message('gov.rules.procurement_workflow_alert_seeds.action.prc_checklist_due'), consequence: message('gov.rules.procurement_workflow_alert_seeds.consequence.prc_checklist_due'), hours: 24, severity: 'ACTION', why: message('gov.rules.procurement_workflow_alert_seeds.why.prc_checklist_due') },
  { code: 'PRC_PACKAGE_STALLED', source: 'PROCUREMENT_WORKFLOW', owner: 'PACKAGE_OWNER', action: message('gov.rules.procurement_workflow_alert_seeds.action.prc_package_stalled'), consequence: message('gov.rules.procurement_workflow_alert_seeds.consequence.prc_package_stalled'), hours: 72, severity: 'WATCH', why: message('gov.rules.procurement_workflow_alert_seeds.why.prc_package_stalled') },
  { code: 'PRC_NO_OWNER', source: 'PROCUREMENT_WORKFLOW', owner: 'PROCUREMENT_MANAGER', action: message('gov.rules.procurement_workflow_alert_seeds.action.prc_no_owner'), consequence: message('gov.rules.procurement_workflow_alert_seeds.consequence.prc_no_owner'), hours: 24, severity: 'ACTION', why: message('gov.rules.procurement_workflow_alert_seeds.why.prc_no_owner') },
];

/** The workflow of a procurement package (lane PRC-1; packages/kernel/src/bid-workflow.ts): one code per selection method, the steps with their checklists, durations and evidence, and the four alerts of the monitoring. */

/** The workflow of a procurement package (lane PRC-1; packages/kernel/src/bid-workflow.ts): one code per selection method, the steps with their checklists, durations and evidence, and the four alerts of the monitoring. */
export const registerProcurementWorkflowRules = (): void =>
  once('procurement-workflow', () => {
    registerCoreRules();
    const evidenceList = list(codeText(), 10);
    const item = shape({ code: codeText(), name: text(200), required: bool, owner_role: codeText(), due_offset_working_days: int(0, 365), evidence_kinds: evidenceList, evidence_required: bool, milestone_kind: optionally(oneOf(...MILESTONE_KINDS)) });
    const step = shape({
      code: codeText(),
      name: text(200),
      entry_condition: text(500),
      exit_condition: text(500),
      responsible_role: codeText(),
      standard_working_days: int(0, 365),
      evidence_kinds: evidenceList,
      milestone_kind: optionally(oneOf(...MILESTONE_KINDS)),
      maker_checker: bool,
      checklist: list(item, 30),
    });
    registerRuleType({
      type: WORKFLOW_RULE_TYPE,
      ownerModule: 'BID',
      modules: ['BID', 'HOME', 'ADM'],
      formula: WORKFLOW_DEFAULTS_FORMULA,
      source: WORKFLOW_DEFAULTS_SOURCE,
      asOf: WORKFLOW_DEFAULTS_AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { method: oneOf(...WORKFLOW_METHODS), name: text(200), stalled_after_working_days: int(1, 365), checklist_warn_days: int(0, 30), steps: list(step, 40, 1) },
      refine: refineWith((params) => parseWorkflowDefinition(params)),
      defaults: Object.fromEntries(WORKFLOW_METHODS.map((method) => [method, rule(defaultWorkflowParams(method), 'UNVERIFIED')])),
    });
    registerRuleDefaults('ALERT_TYPE', alertTypeDefaults(PROCUREMENT_WORKFLOW_ALERT_SEEDS, { source: message('gov.rules.register_procurement_workflow_rules.source') }));
  });

/** The steps of an approval workflow as data (lane WF-1): one code per business type the ADM engine runs for a module; the built-in default of the weekly report is the single decision it has always been. */
export const registerApprovalWorkflowRules = (): void =>
  once('approval-workflow', () => {
    registerCoreRules();
    const uuidText = (optional = false): FieldSpec => ({ kind: 'text', max: 36, optional, pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
    registerRuleType({
      type: APPROVAL_WORKFLOW_RULE_TYPE,
      ownerModule: 'ADM',
      modules: ['ADM', 'DIS', 'FND', 'IND'],
      formula: message('gov.rules.register_approval_workflow_rules.formula'),
      source: message('gov.rules.register_approval_workflow_rules.source'),
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: {
        mode: oneOf(...WORKFLOW_MODES),
        steps: list(
          shape({
            id: { kind: 'text', max: 40, pattern: '^[a-z][a-z0-9_-]{1,39}$' },
            kind: oneOf(...REPORT_STEP_KINDS),
            name: text(120),
            assignee_type: oneOf(...REPORT_STEP_ASSIGNEE_TYPES),
            role_code: optionally({ kind: 'text', max: 60, pattern: '^[A-Z][A-Z0-9_]{1,59}$' }),
            unit_id: uuidText(true),
            membership_ids: optionally(list(uuidText(), 20, 1)),
            min_approvals: int(1, 5),
            sla_working_hours: num(1, 720),
            on_timeout: oneOf('REMIND', 'ESCALATE', 'EXPIRE'),
            escalate_to: uuidText(true),
          }),
          10,
          1,
        ),
      },
      refine: reportWorkflowDefect,
      defaults: {
        [REPORT_WORKFLOW_RULE_CODE]: rule(defaultReportWorkflowParams(), 'UNVERIFIED', { formula: message('gov.rules.approval_workflow.report_accept.formula') }),
        [FND_FIGURE_RULE_CODE]: rule(defaultReportWorkflowParams(), 'UNVERIFIED', { formula: message('gov.rules.approval_workflow.fnd_figure_accept.formula') }),
        [IND_ENTRY_RULE_CODE]: rule(defaultReportWorkflowParams(), 'UNVERIFIED', { formula: message('gov.rules.approval_workflow.ind_entry_accept.formula') }),
      },
    });
  });

const VENDOR_ALERT_SEEDS: readonly AlertTypeSeed[] = [
  { code: 'VENDOR_RESTRICTED_EXPOSURE', source: 'VENDOR', owner: 'PROCUREMENT_OFFICER', action: message('gov.rules.vendor_alert_seeds.action.vendor_restricted_exposure'), consequence: message('gov.rules.vendor_alert_seeds.consequence.vendor_restricted_exposure'), hours: 24, severity: 'URGENT', why: message('gov.rules.vendor_alert_seeds.why.vendor_restricted_exposure') },
  { code: 'VENDOR_REPUTATION_POST', source: 'VENDOR', owner: 'INVESTOR_REPRESENTATIVE', action: message('gov.rules.vendor_alert_seeds.action.vendor_reputation_post'), consequence: message('gov.rules.vendor_alert_seeds.consequence.vendor_reputation_post'), hours: 48, severity: 'ACTION', why: message('gov.rules.vendor_alert_seeds.why.vendor_reputation_post') },
  { code: 'VENDOR_DEBARMENT_DECISION', source: 'VENDOR', owner: 'DEBARMENT_AUTHORITY', action: message('gov.rules.vendor_alert_seeds.action.vendor_debarment_decision'), consequence: message('gov.rules.vendor_alert_seeds.consequence.vendor_debarment_decision'), hours: 48, severity: 'ACTION', why: message('gov.rules.vendor_alert_seeds.why.vendor_debarment_decision') },
  { code: 'VENDOR_PAYEE_ACCOUNT', source: 'VENDOR', owner: 'PAYMENT_ACCOUNTANT', action: message('gov.rules.vendor_alert_seeds.action.vendor_payee_account'), consequence: message('gov.rules.vendor_alert_seeds.consequence.vendor_payee_account'), hours: 24, severity: 'URGENT', why: message('gov.rules.vendor_alert_seeds.why.vendor_payee_account') },
  { code: 'VENDOR_QUALIFICATION_EXPIRY', source: 'VENDOR', owner: 'CONTRACT_MANAGER', action: message('gov.rules.vendor_alert_seeds.action.vendor_qualification_expiry'), consequence: message('gov.rules.vendor_alert_seeds.consequence.vendor_qualification_expiry'), hours: 168, severity: 'ACTION', why: message('gov.rules.vendor_alert_seeds.why.vendor_qualification_expiry') },
];

const vendorKpi = (key: string, unit: 'PERCENT' | 'COUNT', owner: string, ragCode?: string): DefaultInput =>
  rule(
    {
      name: message(`gov.rules.vendor_kpi.${key}.name`),
      formula: message(`gov.rules.vendor_kpi.${key}.formula`),
      source: message('gov.rules.vendor_kpi.source'),
      unit,
      owner,
      decimals: unit === 'PERCENT' ? 1 : 0,
      refresh_hours: 24,
      numerator: message(`gov.rules.vendor_kpi.${key}.numerator`),
      denominator: message(`gov.rules.vendor_kpi.${key}.denominator`),
      period: 'AS_OF_NOW',
      allowed_lag_days: 1,
      ...(ragCode === undefined ? {} : { rag_code: ragCode }),
    },
    'UNVERIFIED',
    { formula: message(`gov.rules.vendor_kpi.${key}.formula`), source: message('gov.rules.vendor_kpi.source') },
  );

/** The management of contractors and suppliers (lane VND-1; packages/kernel/src/vendor-*.ts): the profile, the duplicate signals, the accounts, the certificates, the debarment register, the reputation ledger, the gates, their alert types and the indicators of the register. */
export const registerVendorRules = (): void =>
  once('vendor', () => {
    registerCoreRules();
    registerIntegrationRules();
    const source = message('gov.rules.register_vendor_rules.source');
    const modules = ['BID', 'CTR', 'PAY', 'AUD', 'HOME'];
    registerRuleType({
      type: 'VENDOR_PROFILE',
      ownerModule: 'BID',
      modules,
      formula: message('gov.rules.register_vendor_rules.formula.vendor_profile'),
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { required_before_bid: list(oneOf(...PROFILE_FIELDS), PROFILE_FIELDS.length), review_months: int(1, 120), beneficial_owner_pct: int(1, 100) },
      refine: refineWith(vendorProfilePolicyOf),
      defaults: { DEFAULT: rule(plain({ ...VENDOR_PROFILE_DEFAULTS })) },
    });
    const weight = (): FieldSpec => int(0, 100);
    registerRuleType({
      type: 'VENDOR_DUPLICATE_SIGNALS',
      ownerModule: 'BID',
      modules: ['BID', 'AUD'],
      formula: message('gov.rules.register_vendor_rules.formula.vendor_duplicate_signals'),
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: {
        weight_tax_head: weight(),
        weight_address: weight(),
        weight_phone: weight(),
        weight_email: weight(),
        weight_legal_representative: weight(),
        weight_owner: weight(),
        weight_bank_account: weight(),
        weight_name: weight(),
        suggest_from: int(1, 1000),
        name_similarity_from_pct: int(1, 100),
      },
      refine: refineWith(duplicateWeightsOf),
      defaults: { DEFAULT: rule(plain({ ...DUPLICATE_PARAM_DEFAULTS })) },
    });
    registerRuleType({
      type: 'VENDOR_PAYEE_ACCOUNT',
      ownerModule: 'PAY',
      modules: ['PAY', 'BID', 'AUD', 'HOME'],
      formula: message('gov.rules.register_vendor_rules.formula.vendor_payee_account'),
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { waiting_hours: int(0, 720), request_valid_days: int(1, 365), name_match: oneOf('REQUIRE', 'WARN'), require_registered_account: bool, old_account_pays_during_wait: bool, callback_number_min_age_days: int(0, 365) },
      refine: refineWith(payeeAccountPolicyOf),
      defaults: { DEFAULT: rule(plain({ ...PAYEE_ACCOUNT_DEFAULTS })) },
    });
    registerRuleType({
      type: 'VENDOR_EXPIRY_WARNING',
      ownerModule: 'BID',
      modules: ['BID', 'CTR', 'HOME'],
      formula: message('gov.rules.register_vendor_rules.formula.vendor_expiry_warning'),
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { first_warning_days: int(0, 365), second_warning_days: int(0, 365) },
      refine: refineWith(expiryPolicyOf),
      defaults: { QUALIFICATION: rule(plain({ ...EXPIRY_WARNING_DEFAULTS })), KEY_STAFF: rule(plain({ ...EXPIRY_WARNING_DEFAULTS })) },
    });
    registerRuleType({
      type: 'VENDOR_DEBARMENT',
      ownerModule: 'BID',
      modules,
      formula: message('gov.rules.register_vendor_rules.formula.vendor_debarment'),
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: {
        decide_within_days: int(1, 365),
        decide_day_unit: oneOf('CALENDAR_DAYS', 'WORKING_DAYS'),
        response_days: int(1, 90),
        remind_before_days: int(0, 30),
        province_threshold: int(1, 100),
        national_threshold: int(1, 100),
        cumulative_max_months: int(1, 600),
        limitation_years: int(1, 50),
        jv_exception_groups: list(codeText(), 10),
      },
      refine: refineWith(debarmentPolicyOf),
      defaults: { DEFAULT: rule(plain({ ...DEBARMENT_POLICY_DEFAULTS, jv_exception_groups: [...DEBARMENT_POLICY_DEFAULTS.jv_exception_groups] })) },
    });
    registerRuleType({
      type: 'VENDOR_DEBARMENT_PERIOD',
      ownerModule: 'BID',
      modules,
      formula: message('gov.rules.register_vendor_rules.formula.vendor_debarment_period'),
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { min_months: int(1, 600), max_months: int(1, 600), behaviours: text(500) },
      refine: refineWith(debarmentPeriodOf),
      defaults: Object.fromEntries(Object.entries(DEBARMENT_PERIOD_DEFAULTS()).map(([code, period]) => [code, rule(plain({ ...period }))])),
    });
    registerRuleType({
      type: 'VENDOR_REPUTATION',
      ownerModule: 'BID',
      modules,
      formula: message('gov.rules.register_vendor_rules.formula.vendor_reputation'),
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { bid_security_multiplier: int(1, 20), multiplier_years: int(1, 20), award_confirmation_working_days: int(1, 30) },
      refine: refineWith(reputationPolicyOf),
      defaults: { DEFAULT: rule(plain({ ...REPUTATION_POLICY_DEFAULTS })) },
    });
    registerRuleType({
      type: 'VENDOR_GATE',
      ownerModule: 'BID',
      modules,
      formula: message('gov.rules.register_vendor_rules.formula.vendor_gate'),
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { profile_enforcement: oneOf('BLOCK', 'WARN'), qualification_enforcement: oneOf('BLOCK', 'WARN') },
      refine: refineWith(gatePolicyOf),
      defaults: { DEFAULT: rule(plain({ ...GATE_POLICY_DEFAULTS })) },
    });
    registerRuleDefaults('ALERT_TYPE', alertTypeDefaults(VENDOR_ALERT_SEEDS, { source }));
    registerRuleDefaults('KPI_DEFINITION', {
      VENDOR_PROFILE_COVERAGE: vendorKpi('vendor_profile_coverage', 'PERCENT', 'PROCUREMENT_MANAGER'),
      VENDOR_DEBARMENT_IN_TIME: vendorKpi('vendor_debarment_in_time', 'PERCENT', 'DEBARMENT_AUTHORITY'),
      VENDOR_REPUTATION_POSTED_IN_TIME: vendorKpi('vendor_reputation_posted_in_time', 'PERCENT', 'INVESTOR_REPRESENTATIVE'),
      VENDOR_ACCOUNT_CHANGES: vendorKpi('vendor_account_changes', 'COUNT', 'PAYMENT_ACCOUNTANT'),
    });
  });

const VND2_ALERT_SEEDS: readonly AlertTypeSeed[] = [
  { code: 'VENDOR_INDEPENDENCE_FINDING', source: 'VENDOR', owner: 'EVALUATION_PANEL_CHAIR', action: VND2_TEXT.alerts.independence_finding.action, consequence: VND2_TEXT.alerts.independence_finding.consequence, hours: 24, severity: 'URGENT', why: VND2_TEXT.alerts.independence_finding.why },
  { code: 'VENDOR_SECURITY_EXPIRY', source: 'VENDOR', owner: 'PROCUREMENT_OFFICER', action: VND2_TEXT.alerts.security_expiry.action, consequence: VND2_TEXT.alerts.security_expiry.consequence, hours: 48, severity: 'ACTION', why: VND2_TEXT.alerts.security_expiry.why },
  { code: 'VENDOR_SUBCONTRACT_BREACH', source: 'VENDOR', owner: 'CONTRACT_MANAGER', action: VND2_TEXT.alerts.subcontract_breach.action, consequence: VND2_TEXT.alerts.subcontract_breach.consequence, hours: 72, severity: 'ACTION', why: VND2_TEXT.alerts.subcontract_breach.why },
  { code: 'VENDOR_SUB_PAYMENT_CONFIRM', source: 'VENDOR', owner: 'CONTRACT_MANAGER', action: VND2_TEXT.alerts.sub_payment_confirm.action, consequence: VND2_TEXT.alerts.sub_payment_confirm.consequence, hours: 72, severity: 'ACTION', why: VND2_TEXT.alerts.sub_payment_confirm.why },
  { code: 'VENDOR_PERFORMANCE_PUBLISH', source: 'VENDOR', owner: 'INVESTOR_REPRESENTATIVE', action: VND2_TEXT.alerts.performance_publish.action, consequence: VND2_TEXT.alerts.performance_publish.consequence, hours: 72, severity: 'ACTION', why: VND2_TEXT.alerts.performance_publish.why },
  { code: 'VENDOR_PERFORMANCE_RESPONSE', source: 'VENDOR', owner: 'INVESTOR_REPRESENTATIVE', action: VND2_TEXT.alerts.performance_response.action, consequence: VND2_TEXT.alerts.performance_response.consequence, hours: 72, severity: 'ACTION', why: VND2_TEXT.alerts.performance_response.why },
  { code: 'VENDOR_POOR_STREAK', source: 'VENDOR', owner: 'PROJECT_BOARD_HEAD', action: VND2_TEXT.alerts.poor_streak.action, consequence: VND2_TEXT.alerts.poor_streak.consequence, hours: 168, severity: 'WATCH', why: VND2_TEXT.alerts.poor_streak.why },
  { code: 'VENDOR_CAPACITY_FINANCE', source: 'VENDOR', owner: 'EVALUATION_PANEL_CHAIR', action: VND2_TEXT.alerts.capacity_finance.action, consequence: VND2_TEXT.alerts.capacity_finance.consequence, hours: 168, severity: 'WATCH', why: VND2_TEXT.alerts.capacity_finance.why },
  { code: 'VENDOR_RISK_REVIEW', source: 'VENDOR', owner: 'PROCUREMENT_MANAGER', action: VND2_TEXT.alerts.risk_review.action, consequence: VND2_TEXT.alerts.risk_review.consequence, hours: 120, severity: 'ACTION', why: VND2_TEXT.alerts.risk_review.why },
];

const vnd2Kpi = (key: keyof typeof VND2_TEXT.kpi, unit: 'PERCENT' | 'COUNT', owner: string): DefaultInput => {
  const text = VND2_TEXT.kpi[key as Exclude<keyof typeof VND2_TEXT.kpi, 'source'>];
  return rule(
    { name: text.name, formula: text.formula, source: VND2_TEXT.kpi.source, unit, owner, decimals: unit === 'PERCENT' ? 1 : 0, refresh_hours: 24, numerator: text.numerator, denominator: text.denominator, period: 'AS_OF_NOW', allowed_lag_days: 1 },
    'UNVERIFIED',
    { formula: text.formula, source: VND2_TEXT.kpi.source },
  );
};

/** The controls of contractors and suppliers (lane VND-2; packages/kernel/src/vendor-{independence,finance,security,subcontract,risk,performance}.ts): the independence limits, the finance and load lines, the bid security, the subcontract limits, the risk grade, the performance clocks, their alert types and the indicators of the register. */
export const registerVendorControlsRules = (): void =>
  once('vendor-controls', () => {
    registerVendorRules();
    const source = VND2_TEXT.source;
    const modules = ['BID', 'CTR', 'PAY', 'AUD', 'HOME'];
    const defs = (type: string, formula: string, schema: Record<string, FieldSpec>, refine: (params: Record<string, unknown>) => string | undefined, params: RuleParams, ownerModule = 'BID'): void =>
      registerRuleType({ type, ownerModule, modules, formula, source, asOf: AS_OF, legalStatus: 'UNVERIFIED', schema, refine, defaults: { DEFAULT: rule(plain(params)) } });
    defs(
      VENDOR_INDEPENDENCE_RULE_TYPE,
      VND2_TEXT.independence_formula,
      { cross_ownership_investor_pct: int(1, 100), cross_ownership_bidders_pct: int(1, 100), former_official_months: int(0, 120), undecided_strong_blocks_award: bool },
      refineWith(independencePolicyOf),
      { ...INDEPENDENCE_POLICY_DEFAULTS },
    );
    defs(
      VENDOR_FINANCE_RULE_TYPE,
      VND2_TEXT.finance_formula,
      { min_current_ratio_x100: int(0, 10_000), max_debt_to_assets_pct: int(1, 1000), min_interest_cover_x100: int(0, 100_000), revenue_years: int(1, 10), revenue_multiple_x100: int(0, 10_000), min_verified_years: int(1, 10) },
      refineWith(financePolicyOf),
      { ...FINANCE_POLICY_DEFAULTS },
    );
    defs(
      VENDOR_CAPACITY_RULE_TYPE,
      VND2_TEXT.capacity_formula,
      { max_load_multiple_x100: int(10, 100_000), max_late_contracts: int(0, 1000), pending_award_weight_pct: int(0, 100) },
      refineWith(capacityPolicyOf),
      { ...CAPACITY_POLICY_DEFAULTS },
    );
    defs(
      VENDOR_BID_SECURITY_RULE_TYPE,
      VND2_TEXT.security_formula,
      { validity_margin_days: int(0, 365), first_warning_days: int(0, 365), second_warning_days: int(0, 365), amount_below_enforcement: oneOf('BLOCK', 'WARN'), require_confirmation: bool },
      refineWith(bidSecurityPolicyOf),
      { ...BID_SECURITY_POLICY_DEFAULTS },
      'PAY',
    );
    defs(
      VENDOR_SUBCONTRACT_RULE_TYPE,
      VND2_TEXT.subcontract_formula,
      { prime_min_share_pct: int(0, 100), over_declared: oneOf('BLOCK', 'EXCEPTION'), undeclared_subcontractor: oneOf('BLOCK', 'EXCEPTION'), confirm_payment_within_days: int(1, 180), remind_before_days: int(0, 30) },
      refineWith(subcontractPolicyOf),
      { ...SUBCONTRACT_POLICY_DEFAULTS },
      'CTR',
    );
    const riskSchema: Record<string, FieldSpec> = { medium_from: int(1, 1000), high_from: int(1, 1000), critical_from: int(1, 1000), restriction_floor: oneOf(...RISK_TIERS), dual_check_from: oneOf('HIGH', 'CRITICAL') };
    for (const factor of RISK_FACTORS) riskSchema[`weight_${factor.toLowerCase()}`] = int(0, 100);
    for (const tier of RISK_TIERS) riskSchema[`review_months_${tier.toLowerCase()}`] = int(1, 120);
    defs(VENDOR_RISK_RULE_TYPE, VND2_TEXT.risk_formula, riskSchema, refineWith(riskPolicyOf), riskParamsOf(RISK_POLICY_DEFAULTS));
    defs(
      VENDOR_PERFORMANCE_RULE_TYPE,
      VND2_TEXT.performance_formula,
      { publish_within_months: int(1, 60), remind_before_days: int(0, 180), review_response_days: int(1, 180), poor_streak_remedy: int(1, 20), poor_streak_restriction: int(1, 20), retrospect_years: int(1, 30), retrospect_years_construction: int(1, 30) },
      refineWith(performancePolicyOf),
      { ...PERFORMANCE_POLICY_DEFAULTS },
      'CTR',
    );
    registerRuleDefaults('ALERT_TYPE', alertTypeDefaults(VND2_ALERT_SEEDS, { source }));
    registerRuleDefaults('KPI_DEFINITION', {
      VENDOR_INDEPENDENCE_CHECKED: vnd2Kpi('independence_checked', 'PERCENT', 'PROCUREMENT_MANAGER'),
      VENDOR_RISK_REVIEW_IN_TIME: vnd2Kpi('risk_review_in_time', 'PERCENT', 'PROCUREMENT_MANAGER'),
      VENDOR_HIGH_RISK_CONTRACTORS: vnd2Kpi('high_risk_contractors', 'COUNT', 'PROCUREMENT_MANAGER'),
      VENDOR_PERFORMANCE_PUBLISHED_IN_TIME: vnd2Kpi('performance_published_in_time', 'PERCENT', 'INVESTOR_REPRESENTATIVE'),
      VENDOR_RESPONSE_REVIEWED_IN_TIME: vnd2Kpi('response_reviewed_in_time', 'PERCENT', 'INVESTOR_REPRESENTATIVE'),
      VENDOR_SECURITY_CONFIRMED: vnd2Kpi('security_confirmed', 'PERCENT', 'PROCUREMENT_OFFICER'),
      VENDOR_SUB_PAYMENT_CONFIRMED: vnd2Kpi('sub_payment_confirmed', 'PERCENT', 'CONTRACT_MANAGER'),
    });
  });

const VND3_ALERT_SEEDS: readonly AlertTypeSeed[] = [
  { code: 'VENDOR_LINK_LEAD', source: 'VENDOR', owner: 'AUDITOR', action: VND3_TEXT.alert.action.vendor_link_lead, consequence: VND3_TEXT.alert.consequence.vendor_link_lead, hours: 168, severity: 'WATCH', why: VND3_TEXT.alert.why.vendor_link_lead },
  { code: 'VENDOR_SCREENING_HIT', source: 'VENDOR', owner: 'VENDOR_APPROVER', action: VND3_TEXT.alert.action.vendor_screening_hit, consequence: VND3_TEXT.alert.consequence.vendor_screening_hit, hours: 24, severity: 'URGENT', why: VND3_TEXT.alert.why.vendor_screening_hit },
  { code: 'VENDOR_RECONFIRM_OVERDUE', source: 'VENDOR', owner: 'PROCUREMENT_OFFICER', action: VND3_TEXT.alert.action.vendor_reconfirm, consequence: VND3_TEXT.alert.consequence.vendor_reconfirm, hours: 336, severity: 'WATCH', why: VND3_TEXT.alert.why.vendor_reconfirm },
  { code: 'VENDOR_PORTAL_REQUEST', source: 'VENDOR', owner: 'PROCUREMENT_OFFICER', action: VND3_TEXT.alert.action.vendor_portal_request, consequence: VND3_TEXT.alert.consequence.vendor_portal_request, hours: 48, severity: 'ACTION', why: VND3_TEXT.alert.why.vendor_portal_request },
  { code: 'VENDOR_REMEDIATION_ACTION', source: 'VENDOR', owner: 'CONTRACT_MANAGER', action: VND3_TEXT.alert.action.vendor_remediation, consequence: VND3_TEXT.alert.consequence.vendor_remediation, hours: 72, severity: 'ACTION', why: VND3_TEXT.alert.why.vendor_remediation },
];

type Vnd3KpiKey = Exclude<keyof typeof VND3_TEXT.kpi, 'source'>;
const vnd3Kpi = (key: Vnd3KpiKey, unit: 'PERCENT' | 'COUNT', owner: string): DefaultInput => {
  const text = VND3_TEXT.kpi[key];
  return rule(
    { name: text.name, formula: text.formula, source: VND3_TEXT.kpi.source, unit, owner, decimals: unit === 'PERCENT' ? 1 : 0, refresh_hours: 24, numerator: text.numerator, denominator: text.denominator, period: 'AS_OF_NOW', allowed_lag_days: 1 },
    'UNVERIFIED',
    { formula: text.formula, source: VND3_TEXT.kpi.source },
  );
};

/** The contractor investigation and the contractor portal (lane VND-3; packages/kernel/src/vnd-*.ts): the link graph and the screening of bid rigging for the auditors, the continuous screening against the lists of banned parties, the portal clocks, the annual re-confirmation, the remediation plan and the export of parties; their alert types and indicators. */
export const registerVendor3Rules = (): void =>
  once('vendor3', () => {
    registerCoreRules();
    registerIntegrationRules();
    registerVendorRules();
    const source = VND3_TEXT.rules_source;
    const modules = ['BID', 'AUD', 'HOME'];
    const weight = (): FieldSpec => int(0, 100);
    registerRuleType({
      type: 'VENDOR_LINK_RULE',
      ownerModule: 'AUD',
      modules: ['AUD', 'BID'],
      formula: VND3_TEXT.formula.link_rule,
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { ...Object.fromEntries(LINK_KINDS.map((kind) => [`weight_${kind.toLowerCase()}`, weight()])), link_from: int(1, 100), cluster_from: int(1, 100), max_group_size: int(2, 100) },
      refine: refineWith(linkPolicyOf),
      defaults: { DEFAULT: rule(plain({ ...LINK_PARAM_DEFAULTS })) },
    });
    registerRuleType({
      type: 'VENDOR_BID_RIGGING',
      ownerModule: 'AUD',
      modules: ['AUD', 'BID'],
      formula: VND3_TEXT.formula.bid_rigging,
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: {
        ...Object.fromEntries(RIGGING_SIGNAL_CODES.map((code) => [`weight_${code.toLowerCase()}`, weight()])),
        rotation_min_packages: int(2, 100),
        rotation_max_outsider_pct: int(0, 100),
        rotation_max_share_pct: int(1, 100),
        cover_close_gap_bp: int(0, 10_000),
        cover_far_gap_bp: int(1, 100_000),
        cover_min_bidders: int(3, 50),
        pattern_min_bids: int(3, 50),
        pattern_step_tolerance_bp: int(0, 1000),
        withdrawal_min_count: int(2, 100),
        origin_window_minutes: int(1, 10_080),
        lead_from: int(1, 100),
      },
      refine: refineWith(riggingPolicyOf),
      defaults: { DEFAULT: rule(plain({ ...RIGGING_PARAM_DEFAULTS })) },
    });
    registerRuleType({
      type: 'VENDOR_INVESTIGATION',
      ownerModule: 'AUD',
      modules: ['AUD', 'HOME'],
      formula: VND3_TEXT.formula.investigation,
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { reopen_rise: int(1, 100), window_days: int(30, 3650), alert_from: int(1, 100) },
      refine: refineWith(investigationPolicyOf),
      defaults: { DEFAULT: rule(plain({ ...INVESTIGATION_POLICY_DEFAULTS })) },
    });
    registerRuleType({
      type: 'VENDOR_SCREENING',
      ownerModule: 'BID',
      modules,
      formula: VND3_TEXT.formula.screening,
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: {
        weight_tax_code: weight(),
        weight_tax_head: weight(),
        weight_name: weight(),
        name_similarity_from_pct: int(1, 100),
        hit_from: int(1, 100),
        hold_from: int(1, 100),
        dismiss_valid_days: int(1, 3650),
        hold_not_yet_in_force: bool,
        decide_within_days: int(1, 90),
      },
      refine: refineWith(screeningPolicyOf),
      defaults: { DEFAULT: rule(plain({ ...SCREENING_PARAM_DEFAULTS })) },
    });
    registerRuleType({
      type: 'VENDOR_PORTAL',
      ownerModule: 'BID',
      modules: ['BID', 'HOME'],
      formula: VND3_TEXT.formula.portal,
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { response_days: int(1, 365), day_unit: oneOf('CALENDAR_DAYS', 'WORKING_DAYS'), remind_before_days: int(0, 60) },
      refine: refineWith(portalClockPolicyOf),
      defaults: Object.fromEntries(PORTAL_REQUEST_KINDS.map((kind) => [kind, rule(plain({ ...PORTAL_CLOCK_DEFAULTS[kind] }))])),
    });
    registerRuleType({
      type: 'VENDOR_RECONFIRMATION',
      ownerModule: 'BID',
      modules: ['BID', 'HOME'],
      formula: VND3_TEXT.formula.reconfirmation,
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { interval_months: int(1, 60), remind_days: int(0, 180), grace_days: int(0, 180), declaration_version: text(40), declaration_text: text(4000) },
      refine: refineWith(reconfirmationPolicyOf),
      defaults: { DEFAULT: rule({ interval_months: 12, remind_days: 30, grace_days: 30, declaration_version: 'V1', declaration_text: VND3_TEXT.declaration_default }) },
    });
    registerRuleType({
      type: 'VENDOR_REMEDIATION',
      ownerModule: 'BID',
      modules: ['BID', 'CTR', 'HOME'],
      formula: VND3_TEXT.formula.remediation,
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { remind_before_days: int(0, 60), max_plan_days: int(7, 1095) },
      refine: refineWith(remediationPolicyOf),
      defaults: { DEFAULT: rule(plain({ ...REMEDIATION_POLICY_DEFAULTS })) },
    });
    registerRuleType({
      type: 'VENDOR_OCDS_EXPORT',
      ownerModule: 'AUD',
      modules: ['AUD', 'BID'],
      formula: VND3_TEXT.formula.ocds_export,
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { include_owners: bool, include_contact: bool },
      refine: refineWith(ocdsExportPolicyOf),
      defaults: { DEFAULT: rule(plain({ ...OCDS_EXPORT_DEFAULTS })) },
    });
    registerRuleDefaults('ALERT_TYPE', alertTypeDefaults(VND3_ALERT_SEEDS, { source }));
    registerRuleDefaults('KPI_DEFINITION', {
      VENDOR_LEAD_PRECISION: vnd3Kpi('lead_precision', 'PERCENT', 'AUDIT_LEAD'),
      VENDOR_LEADS_OPEN: vnd3Kpi('lead_open', 'COUNT', 'AUDIT_LEAD'),
      VENDOR_SCREENING_IN_TIME: vnd3Kpi('screening_in_time', 'PERCENT', 'PROCUREMENT_MANAGER'),
      VENDOR_PORTAL_RESPONSE_IN_TIME: vnd3Kpi('portal_response_in_time', 'PERCENT', 'PROCUREMENT_MANAGER'),
      VENDOR_RECONFIRMATION_CURRENT: vnd3Kpi('reconfirmation_current', 'PERCENT', 'PROCUREMENT_MANAGER'),
    });
  });

/** PORTAL-2: the access of a contractor to the portal through the registry (no contract needed) and the limit of a portal upload. */
export const registerPortal2Rules = (): void =>
  once('portal2', () => {
    registerCoreRules();
    registerVendor3Rules();
    registerRuleType({
      type: 'VENDOR_PORTAL_ACCESS',
      ownerModule: 'BID',
      modules: ['BID', 'HOME'],
      formula: PORTAL2_TEXT.formula.portal_access,
      source: PORTAL2_TEXT.rules_source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { proposal_days: int(1, 60), access_days: int(30, 730), max_live_accounts: int(1, 20), max_upload_bytes: int(100 * 1024, 10 * 1024 * 1024) },
      refine: refineWith(portalAccessPolicyOf),
      defaults: { DEFAULT: rule(plain({ ...PORTAL_ACCESS_DEFAULTS })) },
    });
  });

const CLAIM_ALERT_SEEDS: readonly AlertTypeSeed[] = [
  { code: 'CLAIM_LIMITATION_APPROACHING', source: 'CONTRACT_CLAIM', owner: 'CONTRACT_MANAGER', action: message('gov.rules.claim_alert_seeds.action.claim_limitation_approaching'), consequence: message('gov.rules.claim_alert_seeds.consequence.claim_limitation_approaching'), hours: 48, severity: 'ACTION', why: message('gov.rules.claim_alert_seeds.why.claim_limitation_approaching') },
  { code: 'CLAIM_LIMITATION_MISSED', source: 'CONTRACT_CLAIM', owner: 'CONTRACT_MANAGER', action: message('gov.rules.claim_alert_seeds.action.claim_limitation_missed'), consequence: message('gov.rules.claim_alert_seeds.consequence.claim_limitation_missed'), hours: 24, severity: 'URGENT', why: message('gov.rules.claim_alert_seeds.why.claim_limitation_missed') },
  { code: 'CLAIM_RESPONSE_DUE', source: 'CONTRACT_CLAIM', owner: 'CONTRACT_MANAGER', action: message('gov.rules.claim_alert_seeds.action.claim_response_due'), consequence: message('gov.rules.claim_alert_seeds.consequence.claim_response_due'), hours: 48, severity: 'ACTION', why: message('gov.rules.claim_alert_seeds.why.claim_response_due') },
  { code: 'CLAIM_SETTLEMENT_OVERDUE', source: 'CONTRACT_CLAIM', owner: 'CONTRACT_MANAGER', action: message('gov.rules.claim_alert_seeds.action.claim_settlement_overdue'), consequence: message('gov.rules.claim_alert_seeds.consequence.claim_settlement_overdue'), hours: 72, severity: 'ACTION', why: message('gov.rules.claim_alert_seeds.why.claim_settlement_overdue') },
];

const EARLY_WARNING_ALERT_SEEDS: readonly AlertTypeSeed[] = [
  { code: 'EW_REGISTER_OVERDUE', source: 'CONTRACT_EARLY_WARNING', owner: 'CONTRACT_MANAGER', action: message('gov.rules.early_warning_alert_seeds.action.ew_register_overdue'), consequence: message('gov.rules.early_warning_alert_seeds.consequence.ew_register_overdue'), hours: 72, severity: 'ACTION', why: message('gov.rules.early_warning_alert_seeds.why.ew_register_overdue') },
  { code: 'EW_MEETING_OVERDUE', source: 'CONTRACT_EARLY_WARNING', owner: 'CONTRACT_MANAGER', action: message('gov.rules.early_warning_alert_seeds.action.ew_meeting_overdue'), consequence: message('gov.rules.early_warning_alert_seeds.consequence.ew_meeting_overdue'), hours: 72, severity: 'ACTION', why: message('gov.rules.early_warning_alert_seeds.why.ew_meeting_overdue') },
  { code: 'EW_ACTION_OVERDUE', source: 'CONTRACT_EARLY_WARNING', owner: 'EARLY_WARNING_ACTION_OWNER', action: message('gov.rules.early_warning_alert_seeds.action.ew_action_overdue'), consequence: message('gov.rules.early_warning_alert_seeds.consequence.ew_action_overdue'), hours: 72, severity: 'ACTION', why: message('gov.rules.early_warning_alert_seeds.why.ew_action_overdue') },
];

const CLAIM_BASES = ['CALENDAR_DAYS', 'WORKING_DAYS'] as const;
const CLAIM_BAR_EFFECTS = ['BARS_CLAIM', 'REDUCES_RELIEF', 'NONE', 'NOT_STATED'] as const;

/**
 * The claim register and the early-warning register of a contract (lane GOV-8: G1-9, G1-15; `docs/ctr-claims.md`, `docs/ctr-early-warning.md`). The register keeps no period of any contract in code: the limits of a
 * claim come from the term of its own contract (approved by a second person), and the starting numbers of the international forms are only templates a person may copy into a proposal (never applied by themselves,
 * never to a domestic contract that does not say so). The policies here are the working numbers of the registers themselves, flagged unverified until the tenant approves its own.
 */
export const registerClaimRules = (): void =>
  once('claim', () => {
    registerCoreRules();
    registerRuleType({
      type: 'CLAIM_POLICY',
      ownerModule: 'CTR',
      modules: ['CTR', 'HOME'],
      formula: message('gov.rules.register_claim_rules.formula.claim_policy'),
      source: message('gov.rules.register_claim_rules.source.claim_policy'),
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { approach_days: int(1, 90), response_approach_days: int(1, 90) },
      refine: refineWith(parseClaimPolicy),
      defaults: { DEFAULT: rule({ approach_days: CLAIM_POLICY_DEFAULTS.approachDays, response_approach_days: CLAIM_POLICY_DEFAULTS.responseApproachDays }) },
    });
    registerRuleType({
      type: 'CLAIM_TERM_TEMPLATE',
      ownerModule: 'CTR',
      modules: ['CTR'],
      formula: message('gov.rules.register_claim_rules.formula.claim_term_template'),
      source: message('gov.rules.register_claim_rules.source.claim_term_template'),
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: {
        notice_days: int(1, 3650, true),
        particulars_days: int(1, 3650, true),
        response_days: int(1, 3650, true),
        settlement_days: int(1, 3650, true),
        basis: oneOf(...CLAIM_BASES),
        particulars_from: oneOf('AWARENESS', 'NOTICE'),
        bar_effect: oneOf(...CLAIM_BAR_EFFECTS),
      },
      // A template is a starting point for a proposal: the clause of the contract and the approval of a second person still decide, and the register never applies one to a contract by itself.
      defaults: {
        FIDIC_2017_EXAMPLE: rule({ notice_days: 28, particulars_days: 84, response_days: 42, basis: 'CALENDAR_DAYS', particulars_from: 'AWARENESS', bar_effect: 'BARS_CLAIM' }, undefined, { formula: message('gov.rules.claim_term_template.fidic_2017_example.formula') }),
        NEC4_EXAMPLE: rule({ notice_days: 56, response_days: 14, basis: 'CALENDAR_DAYS', particulars_from: 'NOTICE', bar_effect: 'BARS_CLAIM' }, undefined, { formula: message('gov.rules.claim_term_template.nec4_example.formula') }),
      },
    });
    registerRuleType({
      type: 'EARLY_WARNING_POLICY',
      ownerModule: 'CTR',
      modules: ['CTR', 'HOME'],
      formula: message('gov.rules.register_claim_rules.formula.early_warning_policy'),
      source: message('gov.rules.register_claim_rules.source.early_warning_policy'),
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { initial_issue_within_days: int(1, 90), meeting_every_days: int(1, 180), reissue_within_days_after_meeting: int(1, 90), approach_days: int(1, 30), basis: oneOf(...CLAIM_BASES) },
      refine: refineWith(parseEarlyWarningPolicy),
      defaults: {
        DEFAULT: rule({
          initial_issue_within_days: EARLY_WARNING_POLICY_DEFAULTS.initialIssueWithinDays,
          meeting_every_days: EARLY_WARNING_POLICY_DEFAULTS.meetingEveryDays,
          reissue_within_days_after_meeting: EARLY_WARNING_POLICY_DEFAULTS.reissueWithinDaysAfterMeeting,
          approach_days: EARLY_WARNING_POLICY_DEFAULTS.approachDays,
          basis: EARLY_WARNING_POLICY_DEFAULTS.basis,
        }),
      },
    });
    registerRuleDefaults('ALERT_TYPE', alertTypeDefaults(CLAIM_ALERT_SEEDS, { source: message('gov.rules.register_claim_rules.source.claim_alerts') }));
    registerRuleDefaults('ALERT_TYPE', alertTypeDefaults(EARLY_WARNING_ALERT_SEEDS, { source: message('gov.rules.register_claim_rules.source.early_warning_alerts') }));
  });

const ALERT_GOVERNANCE_ALERT_SEEDS: readonly AlertTypeSeed[] = [
  {
    code: 'ESCALATED_ITEM',
    source: 'ESCALATION',
    owner: 'ESCALATION_RECIPIENT',
    action: ALERT_GOV_TEXT.alert_types.escalated_item.action,
    consequence: ALERT_GOV_TEXT.alert_types.escalated_item.consequence,
    hours: 24,
    severity: 'ACTION',
    why: ALERT_GOV_TEXT.alert_types.escalated_item.why,
  },
  {
    code: 'COVERAGE_GAP',
    source: 'COVERAGE',
    owner: 'ALERT_COVER_MANAGER',
    action: ALERT_GOV_TEXT.alert_types.coverage_gap.action,
    consequence: ALERT_GOV_TEXT.alert_types.coverage_gap.consequence,
    hours: 8,
    severity: 'ACTION',
    why: ALERT_GOV_TEXT.alert_types.coverage_gap.why,
  },
];

/** The governance of the alert system itself (lane GOV-9a: G2-3 escalation, G2-5 notification, G2-7 absence and coverage, G2-10 health; docs/alert-governance.md). The code that applies to everybody is `DEFAULT`. */
export const registerAlertGovernanceRules = (): void =>
  once('alert-governance', () => {
    registerCoreRules();
    registerWorkClockRules();
    const source = ALERT_GOV_TEXT.rules.source;
    const step = shape({ kind: oneOf('FUNCTIONAL', 'HIERARCHICAL'), after_working_hours: int(0, 720), levels_up: optionally(int(1, 5)), function_role: optionally(codeText()) });
    registerRuleType({
      type: ESCALATION_RULE_TYPE,
      ownerModule: 'NOT',
      modules: ['NOT', 'HOME', 'ADM'],
      formula: ALERT_GOV_TEXT.rules.escalation_formula,
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: {
        steps: shape({ URGENT: list(step, 5, 1), ACTION: list(step, 5, 1), WATCH: list(step, 0, 0) }),
        triggers: list(oneOf(...ESCALATION_TRIGGERS), 3, 1),
        hold_after_acknowledge_working_hours: perSeverity(0, 720),
        orphan_step: step,
        watch_promotion: shape({ enabled: bool, after_working_days: int(1, 365) }),
        leader_min_rank: int(1, 89),
        admin_fallback_min_rank: int(1, 99),
      },
      refine: refineWith(escalationPolicyOf),
      defaults: { DEFAULT: rule(plain({ ...escalationPolicyDefaults() })) },
    });
    registerRuleType({
      type: ABSENCE_RULE_TYPE,
      ownerModule: 'IAM',
      modules: ['IAM', 'NOT', 'ADM'],
      formula: ALERT_GOV_TEXT.rules.absence_formula,
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: {
        max_absence_days: int(1, 730),
        max_cover_days: int(1, 730),
        max_chain_depth: int(1, 5),
        uncovered_after_working_hours: int(1, 240),
        warn_before_days: int(0, 30),
        deputy_rank_rule: oneOf('AT_LEAST_PEER', 'ANY'),
        min_role_holders: int(1, 10),
        position_min_rank: int(1, 99),
      },
      refine: refineWith(absencePolicyOf),
      defaults: { DEFAULT: rule(plain({ ...absencePolicyDefaults() })) },
    });
    const channels = list(oneOf(...ALERT_CHANNELS), ALERT_CHANNELS.length, 1);
    registerRuleType({
      type: NOTIFY_RULE_TYPE,
      ownerModule: 'NOT',
      modules: ['NOT', 'IAM', 'HOME'],
      formula: ALERT_GOV_TEXT.rules.notify_formula,
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: {
        quiet_from: { kind: 'time' },
        quiet_to: { kind: 'time' },
        quiet_weekends: bool,
        time_zone: word(),
        digest_at: { kind: 'time' },
        push_cap_per_day: int(0, 100),
        urgent_group_after_per_hour: int(1, 20),
        push_min_severity_floor: oneOf('URGENT', 'ACTION'),
        default_channels: shape({ URGENT: channels, ACTION: channels, WATCH: channels }),
        group_same_root: bool,
        digest_max_lines: int(5, 50),
        digest_lookahead_days: int(1, 14),
      },
      refine: refineWith(alertNotifyPolicyOf),
      defaults: { DEFAULT: rule(plain({ ...alertNotifyDefaults() })) },
    });
    const bySeverity = shape({ URGENT: num(0.5, 720), ACTION: num(0.5, 720), WATCH: num(0.5, 720) });
    registerRuleType({
      type: HEALTH_RULE_TYPE,
      ownerModule: 'HOME',
      modules: ['HOME', 'BI', 'NOT'],
      formula: ALERT_GOV_TEXT.rules.health_formula,
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: {
        mtta_working_hours: bySeverity,
        on_time_min_pct: num(0, 100),
        escalated_max_pct: num(0, 100),
        last_level_max_pct: num(0, 100),
        alerts_per_person_day_max: shape({ URGENT: num(0, 500), TOTAL: num(0, 500) }),
        pushes_per_person_day_max: num(0, 100),
        off_hours_unjustified_max: int(0, 100_000),
        stale_after_days: shape({ first: int(1, 365), second: int(1, 730) }),
        stale_max_pct: num(0, 100),
        top10_share_max_pct: num(0, 100),
        snooze_rate_max_pct: num(0, 100),
        orphan_max: int(0, 100_000),
        reroute_max_hours: num(0.1, 720),
        urgent_delivery_min_pct: num(0, 100),
        urgent_delivery_minutes: int(1, 1440),
        delegation_coverage_min_pct: num(0, 100),
        min_sample: int(1, 1000),
      },
      refine: refineWith(healthTargetsOf),
      defaults: { DEFAULT: rule(plain({ ...healthTargetDefaults() })) },
    });
    registerRuleDefaults('ALERT_TYPE', alertTypeDefaults(ALERT_GOVERNANCE_ALERT_SEEDS, { source }));
  });

/** The kinds of rule and the alert types of lane GOV-10 (red flags, the channel ladder, the closing and the flood of alerts, the new alert sources); the data is in gov10-rule-types.ts. */
export const registerGov10Rules = (): void =>
  once('gov10', () => {
    registerCoreRules();
    for (const type of gov10RuleTypes()) registerRuleType(type);
    registerRuleDefaults('RED_FLAG_RULE', gov10RedFlagDefaults());
    registerBuiltInRedFlagIndicators(redFlagProvenance);
    registerRuleDefaults('ALERT_TYPE', alertTypeDefaults(GOV10_ALERT_SEEDS, { source: message('gov.rules.gov10.source') }));
  });

/** The Integration Hub (lane HUB-1): the policy of the hub, the alerts it raises, the freshness codes of the connectors that had none and the KPI definitions of the hub (data of `connector-hub-defaults.ts`). */
export const registerIntegrationHubRules = (): void =>
  once('integration-hub', () => {
    registerCoreRules();
    registerAnalyticsRules();
    registerIntegrationRules();
    registerRuleType({
      type: 'INTEGRATION_HUB_POLICY',
      ownerModule: 'HUB',
      modules: ['HUB', 'INT', 'ADM', 'HOME'],
      formula: hubPolicyFormula(),
      source: hubPolicySource(),
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: {
        failing_after_runs: int(1, 10),
        failing_severity: oneOf(...SEVERITIES),
        hub_stale_ratio_percent: int(1, 100),
        hub_stale_min_connectors: int(1, 50),
        hub_stale_severity: oneOf(...SEVERITIES),
        incident_auto_open: bool,
        snapshot_retention_days: int(30, 3650),
        agent_stale_after_minutes: int(1, 10080),
      },
      defaults: { DEFAULT: rule(plain({ ...HUB_POLICY_PARAMS })) },
    });
    registerRuleDefaults('ALERT_TYPE', alertTypeDefaults(hubAlertSeeds(), { source: hubAlertSource() }));
    registerRuleDefaults(
      'CONNECTOR_FRESHNESS',
      Object.fromEntries(Object.entries(hubFreshnessDefaults()).map(([code, one]) => [code, rule(plain(one.params), undefined, { formula: one.formula })])),
    );
    registerRuleDefaults(
      'KPI_DEFINITION',
      Object.fromEntries(
        Object.entries(hubKpiDefaults()).map(([code, one]) => [code, rule(plain(one.params), one.unverified ? 'UNVERIFIED' : 'VERIFIED', { formula: String(one.params.formula ?? ''), source: String(one.params.source ?? ''), asOf: AS_OF })]),
      ),
    );
  });

/**
 * The indicator dictionary and the Excel import mappings (lane IND-1): the starting indicators are added under `KPI_DEFINITION` (a code another lane already defined is left as that lane wrote it), and the type of
 * the mappings from a form of the customer to the codes of the dictionary is registered with two sample forms.
 */
export const registerIndicatorRules = (): void =>
  once('indicator', () => {
    registerCoreRules();
    registerEnterpriseRules();
    const SEED_AS_OF = '2026-11-08';
    registerRuleDefaults(
      'KPI_DEFINITION',
      Object.fromEntries(
        INDICATOR_SEEDS.filter((seed) => builtInDefault('KPI_DEFINITION', seed.code) === undefined).map((seed) => [
          seed.code,
          rule(indicatorSeedParams(seed), 'UNVERIFIED', { formula: message(`ind.seed.${seed.key}.formula`), source: message('ind.seed.source'), asOf: SEED_AS_OF }),
        ]),
      ),
    );
    registerRuleType({
      type: INDICATOR_IMPORT_RULE_TYPE,
      ownerModule: 'IND',
      modules: ['IND', 'DIS', 'ADM'],
      formula: message('ind.mapping.formula'),
      source: message('ind.mapping.source'),
      asOf: SEED_AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: INDICATOR_IMPORT_FIELDS,
      refine: refineImportMapping,
      defaults: { SAMPLE_COLUMNS_FORM: rule(sampleMappingParams('COLUMNS')), SAMPLE_ROWS_FORM: rule(sampleMappingParams('ROWS')) },
    });
  });

// GOV-11 (lane GOV-11a): one function per item, filled by that item and by nobody else. Each is idempotent.

/** Capital reallocation by performance (G1-12): the policy that picks donors and recipients and the assumptions of the simulation. */
export const registerReallocationRules = (): void =>
  once('gov11-reallocation', () => {
    registerCoreRules();
    registerRuleType({
      type: REALLOCATION_POLICY_RULE_TYPE,
      ownerModule: 'CAP',
      modules: ['CAP', 'DIS', 'ADM'],
      formula: message('gov.rules.register_reallocation_rules.formula.reallocation_policy'),
      source: message('gov.rules.register_reallocation_rules.source.reallocation_policy'),
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: {
        donor_max_ratio_pct: num(0, 100),
        donor_keep_margin_pct: num(0, 100),
        recipient_min_ratio_pct: num(0, 1000),
        absorption_pct: num(0, 100),
        min_move_vnd: int(0, 1_000_000_000_000),
        max_share_of_donor_plan_pct: num(0, 100),
        simulation_required: bool,
        delegation_document_type: codeText(),
      },
      refine: refineWith(reallocationPolicyOf),
      defaults: { [REALLOCATION_POLICY_DEFAULT_CODE]: rule({ ...reallocationPolicyDefaults() }) },
    });
  });

const FORECAST_ALERT_SEEDS: readonly AlertTypeSeed[] = [
  {
    code: 'DIS_MILESTONE_AT_RISK',
    source: 'DISBURSEMENT_FORECAST',
    owner: 'UNIT_LEADER',
    action: message('gov.rules.forecast_alert_seeds.action.dis_milestone_at_risk'),
    consequence: message('gov.rules.forecast_alert_seeds.consequence.dis_milestone_at_risk'),
    hours: 120,
    severity: 'ACTION',
    why: message('gov.rules.forecast_alert_seeds.why.dis_milestone_at_risk'),
  },
];

/** Disbursement forecast to 31/12, the milestones of the directives and the accuracy of forecasts (G1-16). */
export const registerForecastRules = (): void =>
  once('gov11-forecast', () => {
    registerCoreRules();
    const source = message('gov.rules.register_forecast_rules.source');
    registerRuleType({
      type: MILESTONE_RULE_TYPE,
      ownerModule: 'DIS',
      modules: ['DIS', 'CAP', 'HOME'],
      formula: message('gov.rules.register_forecast_rules.formula.disbursement_milestones'),
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: {
        milestones: list(shape({ code: codeText(), month_day: { kind: 'text', max: 5, pattern: MONTH_DAY_PATTERN }, target_pct: num(0, 100) }), 12, 1),
        at_risk_margin_pct: num(0, 50),
        directive_ref: text(200, true),
      },
      refine: refineWith(milestonePolicyOf),
      defaults: { [MILESTONE_RULE_CODE]: rule(milestoneDefaults()) },
    });
    registerRuleType({
      type: ACCURACY_RULE_TYPE,
      ownerModule: 'DIS',
      modules: ['DIS', 'CAP', 'BI'],
      formula: message('gov.rules.register_forecast_rules.formula.disbursement_forecast_accuracy'),
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { lead_months: int(1, 6), min_months: int(1, 12), good_wape_pct: num(0, 1000), fair_wape_pct: num(0, 1000), min_actual_vnd: int(0, 1_000_000_000_000), bias_flag_pct: num(0, 1000) },
      refine: refineWith(accuracyPolicyOf),
      defaults: { [ACCURACY_RULE_CODE]: rule(accuracyDefaults()) },
    });
    registerRuleDefaults('ALERT_TYPE', alertTypeDefaults(FORECAST_ALERT_SEEDS, { source: message('gov.rules.register_forecast_rules.source_2') }));
  });

/** The payment clock, the advance clock and the standard reasons to return a request (G1-17). */
const PAYMENT_CLOCK_ALERT_SEEDS: readonly AlertTypeSeed[] = [
  { code: 'PAYMENT_CLOCK_NEAR', source: 'PAYMENT_CLOCK', owner: 'PAYMENT_OFFICER', action: message('gov.rules.payment_clock_alert_seeds.action.payment_clock_near'), consequence: message('gov.rules.payment_clock_alert_seeds.consequence.payment_clock_near'), hours: 8, severity: 'WATCH', why: message('gov.rules.payment_clock_alert_seeds.why.payment_clock_near') },
  { code: 'PAYMENT_CLOCK_BREACHED', source: 'PAYMENT_CLOCK', owner: 'PAYMENT_OFFICER', action: message('gov.rules.payment_clock_alert_seeds.action.payment_clock_breached'), consequence: message('gov.rules.payment_clock_alert_seeds.consequence.payment_clock_breached'), hours: 8, severity: 'ACTION', why: message('gov.rules.payment_clock_alert_seeds.why.payment_clock_breached') },
];

export const registerPaymentClockRules = (): void =>
  once('gov11-payment-clock', () => {
    registerCoreRules();
    const source = message('gov.rules.register_payment_clock_rules.source');
    registerRuleType({
      type: PAYMENT_CLOCK_RULE_TYPE,
      ownerModule: 'PAY',
      modules: ['PAY', 'HOME', 'ADM'],
      formula: message('gov.rules.register_payment_clock_rules.formula.payment_clock'),
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { working_days: int(1, 30), near_working_hours: int(1, 240), reason_code_required: bool },
      refine: refineWith(payClockParams),
      defaults: {
        PAYMENT: rule({ ...payClockDefaults('PAYMENT') }, undefined, { formula: message('gov.rules.payment_clock.payment.formula') }),
        ADVANCE: rule({ ...payClockDefaults('ADVANCE') }, undefined, { formula: message('gov.rules.payment_clock.advance.formula') }),
      },
    });
    registerRuleType({
      type: PAYMENT_RETURN_REASON_RULE_TYPE,
      ownerModule: 'PAY',
      modules: ['PAY', 'HOME'],
      formula: message('gov.rules.register_payment_clock_rules.formula.payment_return_reason'),
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { category: oneOf(...RETURN_REASON_CATEGORIES), requires_note: bool, owner_side: oneOf(...RETURN_REASON_SIDES), active: bool },
      refine: refineWith(returnReasonParams),
      defaults: Object.fromEntries(Object.entries(RETURN_REASON_DEFAULTS).map(([code, params]) => [code, rule({ ...params })])),
    });
    registerRuleDefaults('ALERT_TYPE', alertTypeDefaults(PAYMENT_CLOCK_ALERT_SEEDS, { source: message('gov.rules.register_payment_clock_rules.source_2') }));
  });

/** The settlement deadlines of a contract and the impact of an adjustment version on the baseline (G1-18). */
const SETTLEMENT_ALERT_SEEDS: readonly AlertTypeSeed[] = [
  { code: 'CONTRACT_SETTLEMENT_NEAR', source: 'SETTLEMENT_CLOCK', owner: 'CONTRACT_MANAGER', action: message('gov.rules.settlement_alert_seeds.action.contract_settlement_near'), consequence: message('gov.rules.settlement_alert_seeds.consequence.contract_settlement_near'), hours: 168, severity: 'WATCH', why: message('gov.rules.settlement_alert_seeds.why.contract_settlement_near') },
  { code: 'CONTRACT_SETTLEMENT_OVERDUE', source: 'SETTLEMENT_CLOCK', owner: 'CONTRACT_MANAGER', action: message('gov.rules.settlement_alert_seeds.action.contract_settlement_overdue'), consequence: message('gov.rules.settlement_alert_seeds.consequence.contract_settlement_overdue'), hours: 48, severity: 'ACTION', why: message('gov.rules.settlement_alert_seeds.why.contract_settlement_overdue') },
  { code: 'CONTRACT_BASELINE_REVIEW', source: 'CONTRACT_ADJUSTMENT', owner: 'PROJECT_OWNER', action: message('gov.rules.settlement_alert_seeds.action.contract_baseline_review'), consequence: message('gov.rules.settlement_alert_seeds.consequence.contract_baseline_review'), hours: 120, severity: 'ACTION', why: message('gov.rules.settlement_alert_seeds.why.contract_baseline_review') },
];

export const registerSettlementClockRules = (): void =>
  once('gov11-settlement-clock', () => {
    registerCoreRules();
    const source = message('gov.rules.register_settlement_clock_rules.source');
    registerRuleType({
      type: CONTRACT_SETTLEMENT_RULE_TYPE,
      ownerModule: 'CTR',
      modules: ['CTR', 'PAY', 'HOME'],
      formula: message('gov.rules.register_settlement_clock_rules.formula.contract_settlement_deadline'),
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { months_by_group: shape({ QTQG: int(1, 60), A: int(1, 60), B: int(1, 60), C: int(1, 60) }), default_months: int(1, 60), starts_on: oneOf(...SETTLEMENT_CLOCK_STARTS), near_days: int(1, 120) },
      refine: refineWith(settlementDeadlineParams),
      defaults: { DEFAULT: rule(plain(settlementDeadlineDefaults()) as unknown as RuleParams) },
    });
    registerRuleType({
      type: BASELINE_IMPACT_RULE_TYPE,
      ownerModule: 'CTR',
      modules: ['CTR', 'PRJ', 'HOME'],
      formula: message('gov.rules.register_settlement_clock_rules.formula.contract_baseline_impact'),
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { review_pct_of_baseline: num(0, 1000), review_pct_of_original: num(0, 1000), note_required: bool },
      refine: refineWith(baselineImpactOf),
      defaults: { [BASELINE_IMPACT_RULE_CODE]: rule(baselineImpactDefaults()) },
    });
    registerRuleDefaults('ALERT_TYPE', alertTypeDefaults(SETTLEMENT_ALERT_SEEDS, { source: message('gov.rules.register_settlement_clock_rules.source_2') }));
  });

/** The look-ahead window and the lessons learned at the closing gate (G1-19). */
const LOOK_AHEAD_ALERT_SEEDS: readonly AlertTypeSeed[] = [
  { code: 'LOOK_AHEAD_NOT_READY', source: 'LOOK_AHEAD', owner: 'SITE_MANAGER', action: message('gov.rules.look_ahead_alert_seeds.action.look_ahead_not_ready'), consequence: message('gov.rules.look_ahead_alert_seeds.consequence.look_ahead_not_ready'), hours: 48, severity: 'ACTION', why: message('gov.rules.look_ahead_alert_seeds.why.look_ahead_not_ready') },
  { code: 'LOOK_AHEAD_MISSING', source: 'LOOK_AHEAD', owner: 'SITE_MANAGER', action: message('gov.rules.look_ahead_alert_seeds.action.look_ahead_missing'), consequence: message('gov.rules.look_ahead_alert_seeds.consequence.look_ahead_missing'), hours: 72, severity: 'WATCH', why: message('gov.rules.look_ahead_alert_seeds.why.look_ahead_missing') },
  { code: 'LESSONS_LEARNED_MISSING', source: 'LESSONS_LEARNED', owner: 'PROJECT_OWNER', action: message('gov.rules.look_ahead_alert_seeds.action.lessons_learned_missing'), consequence: message('gov.rules.look_ahead_alert_seeds.consequence.lessons_learned_missing'), hours: 168, severity: 'WATCH', why: message('gov.rules.look_ahead_alert_seeds.why.lessons_learned_missing') },
];

export const registerLookAheadRules = (): void =>
  once('gov11-look-ahead', () => {
    registerCoreRules();
    const source = message('gov.rules.register_look_ahead_rules.source');
    registerRuleType({
      type: LOOK_AHEAD_RULE_TYPE,
      ownerModule: 'PRJ',
      modules: ['PRJ', 'QMS', 'HOME'],
      formula: message('gov.rules.register_look_ahead_rules.formula.look_ahead_policy'),
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: {
        min_weeks: int(1, 12),
        max_weeks: int(1, 26),
        default_weeks: int(1, 26),
        cadence_days: int(1, 31),
        ready_lead_days: int(0, 60),
        ppc_target_pct: num(0, 100),
        ppc_alert_below_pct: num(0, 100),
        constraint_kinds: list(codeText(), 40, 1),
        variance_reasons: list(codeText(), 40, 1),
      },
      refine: refineWith(lookAheadPolicyOf),
      defaults: { [POLICY_RULE_CODE]: rule(lookAheadDefaults()) },
    });
    registerRuleType({
      type: LESSONS_RULE_TYPE,
      ownerModule: 'PRJ',
      modules: ['PRJ', 'MNE', 'HOME'],
      formula: message('gov.rules.register_look_ahead_rules.formula.lessons_learned_policy'),
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { required_at: list(oneOf('CLOSE'), 4), min_approved: int(0, 20), allow_waiver: bool, min_text_length: int(5, 500), categories: list(codeText(), 40, 1) },
      refine: refineWith(lessonsPolicyOf),
      defaults: { [POLICY_RULE_CODE]: rule(lessonsDefaults()) },
    });
    registerRuleDefaults('ALERT_TYPE', alertTypeDefaults(LOOK_AHEAD_ALERT_SEEDS, { source: message('gov.rules.register_look_ahead_rules.source_2') }));
  });

/** The rule types of the executive analytics (GOV-11b: G3-5 to G3-11), described as data in ana-rules.ts; every default is unverified. */
export const registerExecAnalyticsRules = (): void =>
  once('analytics_exec', () => {
    registerCoreRules();
    for (const one of EXEC_RULE_TYPES) {
      registerRuleType({
        type: one.type,
        ownerModule: one.ownerModule,
        modules: one.modules,
        formula: one.formula,
        source: one.source,
        asOf: AS_OF,
        legalStatus: 'UNVERIFIED',
        schema: one.schema,
        ...(one.refine === undefined ? {} : { refine: one.refine }),
        defaults: Object.fromEntries(Object.entries(one.defaults).map(([code, params]) => [code, rule(plain(params), 'UNVERIFIED')])),
      });
    }
  });

const FEED_ALERT_SEEDS: readonly AlertTypeSeed[] = [
  { code: 'FEED_STALE', source: 'CONNECTOR', owner: 'INTEGRATION_ADMINISTRATOR', action: FEED_TEXT.alert_stale_action, consequence: FEED_TEXT.alert_stale_consequence, hours: 24, severity: 'ACTION', why: FEED_TEXT.alert_stale_why },
  { code: 'FEED_UNIT_LATE', source: 'CONNECTOR', owner: 'INTEGRATION_ADMINISTRATOR', action: FEED_TEXT.alert_late_action, consequence: FEED_TEXT.alert_late_consequence, hours: 72, severity: 'WATCH', why: FEED_TEXT.alert_late_why },
  { code: 'FEED_DISCREPANCY_LARGE', source: 'CONNECTOR', owner: 'CAPITAL_PLANNER', action: FEED_TEXT.alert_discrepancy_action, consequence: FEED_TEXT.alert_discrepancy_consequence, hours: 72, severity: 'ACTION', why: FEED_TEXT.alert_discrepancy_why },
];

const feedKpi = (name: string, formula: string, numerator: string, denominator: string): DefaultInput => ({
  params: { name, formula, numerator, denominator, exclusions: [], source: FEED_TEXT.kpi_source, unit: 'PERCENT', period: 'MONTH', owner: 'INTEGRATION_ADMINISTRATOR', decimals: 2, refresh_hours: 24, allowed_lag_days: 5 },
  legalStatus: 'UNVERIFIED',
  formula,
  source: FEED_TEXT.kpi_source,
  asOf: AS_OF,
});

/** The feed of the Finance Department (lane FEED-1, docs/finance-feed.md): its policy, its freshness line, the three data-quality indicators and the three alert types. */
export const registerFinanceFeedRules = (): void =>
  once('finance-feed', () => {
    registerCoreRules();
    registerIntegrationRules();
    registerRuleType({
      type: 'FINANCE_FEED_POLICY',
      ownerModule: 'INT',
      modules: ['INT', 'HOME', 'BI'],
      formula: FEED_TEXT.policy_formula,
      source: FEED_TEXT.policy_source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { tolerance_pct: num(0, 100), large_discrepancy_pct: num(0, 1000), report_due_days: int(0, 60), difference_due_days: int(1, 90) },
      refine: (params) => ((params.tolerance_pct as number) > (params.large_discrepancy_pct as number) ? 'tolerance_pct' : undefined),
      defaults: { DEFAULT: rule({ tolerance_pct: 0.5, large_discrepancy_pct: 5, report_due_days: 5, difference_due_days: 7 }) },
    });
    registerRuleDefaults('CONNECTOR_FRESHNESS', { FIN_FEED: rule({ max_age_hours: 48, warn_after_hours: 24, stale_severity: 'ACTION', figures_blocked_when_stale: false }, undefined, { formula: FEED_TEXT.freshness_formula }) });
    registerRuleDefaults('KPI_DEFINITION', {
      FEED_COMPLETENESS: feedKpi(FEED_TEXT.kpi_completeness_name, FEED_TEXT.kpi_completeness_formula, FEED_TEXT.kpi_completeness_numerator, FEED_TEXT.kpi_completeness_denominator),
      FEED_TIMELINESS: feedKpi(FEED_TEXT.kpi_timeliness_name, FEED_TEXT.kpi_timeliness_formula, FEED_TEXT.kpi_timeliness_numerator, FEED_TEXT.kpi_timeliness_denominator),
      FEED_DISCREPANCY_RATE: feedKpi(FEED_TEXT.kpi_discrepancy_name, FEED_TEXT.kpi_discrepancy_formula, FEED_TEXT.kpi_discrepancy_numerator, FEED_TEXT.kpi_discrepancy_denominator),
    });
    registerRuleDefaults('ALERT_TYPE', alertTypeDefaults(FEED_ALERT_SEEDS, { source: FEED_TEXT.policy_source }));
  });

/** The alert types of the risk register scored from live signals (lane MR-1, MR.02): the score of a signal line crossed the critical line, or rose by the points of a jump (the table `project_risk_alert`). */
const RISK_SIGNAL_ALERT_SEEDS: readonly AlertTypeSeed[] = [
  { code: 'RISK_SCORE_CRITICAL', source: 'PROJECT_RISK', owner: 'PROJECT_OWNER', action: MR1_TEXT.alert_critical_action, consequence: MR1_TEXT.alert_critical_consequence, hours: 72, severity: 'ACTION', why: MR1_TEXT.alert_critical_why },
  { code: 'RISK_SCORE_JUMP', source: 'PROJECT_RISK', owner: 'PROJECT_OWNER', action: MR1_TEXT.alert_jump_action, consequence: MR1_TEXT.alert_jump_consequence, hours: 168, severity: 'WATCH', why: MR1_TEXT.alert_jump_why },
];

/** The risk register scored from live signals and the post-investment effectiveness (lane MR-1: MR.02, MR.03, G1-14, G4-7; packages/kernel/src/risk-signals.ts and effect-target.ts). */
export const registerRiskEffectRules = (): void =>
  once('risk_effect', () => {
    registerCoreRules();
    const thresholdLine = list(num(0, 100000), 4, 4);
    registerRuleType({
      type: RISK_SIGNAL_RULE_TYPE,
      ownerModule: 'PRJ',
      modules: ['PRJ', 'HOME', 'AUD'],
      formula: MR1_TEXT.risk_policy_formula,
      source: MR1_TEXT.risk_policy_source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: {
        impact: shape(Object.fromEntries(RISK_SIGNAL_KINDS.map((kind) => [kind, int(1, 5)]))),
        thresholds: shape(Object.fromEntries(RISK_INDICATORS.map((indicator) => [indicator, thresholdLine]))),
        open_from_likelihood: int(2, 5),
        critical_score: int(1, 25),
        jump_points: int(1, 24),
        scored_statuses: list(codeText(), 12, 1),
      },
      refine: refineWith(parseRiskSignalPolicy),
      defaults: { [RISK_SIGNAL_RULE_CODE]: rule(riskSignalParams(RISK_SIGNAL_DEFAULTS)) },
    });
    registerRuleType({
      type: EFFECT_POLICY_RULE_TYPE,
      ownerModule: 'MNE',
      modules: ['MNE', 'PRJ', 'BI'],
      formula: MR1_TEXT.effect_policy_formula,
      source: MR1_TEXT.effect_policy_source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { met_at_pct: num(1, 200), partly_at_pct: num(0, 199), draft_statuses: list(codeText(), 12, 1), fix_statuses: list(codeText(), 12, 1), measure_statuses: list(codeText(), 12, 1) },
      refine: refineWith(parseEffectPolicy),
      defaults: { [EFFECT_POLICY_RULE_CODE]: rule(effectPolicyParams(EFFECT_POLICY_DEFAULTS)) },
    });
    registerRuleType({
      type: EFFECT_CALENDAR_RULE_TYPE,
      ownerModule: 'MNE',
      modules: ['MNE', 'PRJ'],
      formula: MR1_TEXT.calendar_formula,
      source: MR1_TEXT.calendar_source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: {
        project_group: oneOf(...EFFECT_PROJECT_GROUPS),
        entries: list(shape({ kind: oneOf(...EFFECT_EVALUATION_KINDS), anchor: oneOf(...EFFECT_ANCHORS), months: int(0, 240), required: bool }), 4, 1),
      },
      refine: refineWith(parseCalendarRule),
      defaults: Object.fromEntries(EFFECT_PROJECT_GROUPS.map((group) => [calendarRuleCode(group), rule(calendarRuleParams(CALENDAR_DEFAULTS[group]), 'UNVERIFIED')])),
    });
    registerRuleDefaults('ALERT_TYPE', alertTypeDefaults(RISK_SIGNAL_ALERT_SEEDS, { source: MR1_TEXT.alert_source }));
  });

/** The kinds of rule of lane GOV-12 (community monitoring, transmittal, public portal, whistle channel, gifts, photo findings, period reports, audit standing); the data is in gov12-rule-types.ts. */
export const registerGov12Rules = (): void =>
  once('gov12', () => {
    registerCoreRules();
    for (const type of gov12RuleTypes()) registerRuleType(type);
  });

/** The reporting schedule with a deadline per step and the alert types of its reminders (QT.02, ENT-4c); the data is in ent4c-rule-types.ts. */
export const registerEnt4cRules = (): void =>
  once('ent4c', () => {
    registerCoreRules();
    registerRuleType(ent4cScheduleType());
    registerRuleDefaults('ALERT_TYPE', alertTypeDefaults(ENT4C_ALERT_SEEDS, { source: ENT4C_TEXT.alert_source }));
  });

/** The rule set of the comparison of the reports of one period before release (CN.04, ENT-4a); the data is in ent4a-rule-types.ts. */
export const registerEnt4aRules = (): void =>
  once('ent4a', () => {
    registerCoreRules();
    registerRuleType(ent4aCrosscheckType());
  });

/** Runs every registration in order (each is idempotent): the platform calls this once when the module loads, and a test or a script may call it again. */
export function registerAllGovernanceRules(): void {
  registerCoreRules();
  registerWorkClockRules();
  registerBaselineRules();
  registerMoneyRules();
  registerAnalyticsRules();
  registerIntegrityRules();
  registerContractRules();
  registerIntegrationRules();
  registerDirectiveRules();
  registerEnterpriseRules();
  registerFinanceRules();
  registerProcurementWorkflowRules();
  registerApprovalWorkflowRules();
  registerVendorRules();
  registerVendorControlsRules();
  registerVendor3Rules();
  registerPortal2Rules();
  registerClaimRules();
  registerAlertGovernanceRules();
  registerGov10Rules();
  registerIntegrationHubRules();
  registerCommitteeRules();
  registerIndicatorRules();
  registerReallocationRules();
  registerForecastRules();
  registerPaymentClockRules();
  registerSettlementClockRules();
  registerLookAheadRules();
  registerExecAnalyticsRules();
  registerFinanceFeedRules();
  registerRiskEffectRules();
  registerGov12Rules();
  registerEnt4cRules();
  registerEnt4aRules();
}

registerAllGovernanceRules();

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Validation and defaults.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * Checks the params of a rule of `type` and returns them in the shape the schema fixes (known keys only, in schema order). Anything else is 422 GOVERNANCE_RULE_PARAMS_INVALID naming the first
 * field (never its value).
 */
export function validateRuleParams(type: string, params: unknown): RuleParams {
  const definition = ruleTypeOf(type);
  return judge(definition.schema, definition.refine, params);
}

/** The built-in default of a code, or undefined when the type has none for it. */
export function builtInDefault(type: string, code: string): BuiltInDefault | undefined {
  return ruleTypeOf(type).defaults[code];
}

/** The codes that have a built-in default, in the order they were declared. */
export function builtInCodes(type: string): string[] {
  return Object.keys(ruleTypeOf(type).defaults);
}

/** Where the numbers of a code come from: its default's provenance, else that of its type; undefined for a type nobody registered. */
export function provenanceOf(type: string, code: string): Provenance | undefined {
  const entry = REGISTRY.get(type);
  if (entry === undefined) return undefined;
  const one = entry.defaults[code];
  const from = one ?? entry.definition;
  return { formula: from.formula, source: from.source, asOf: from.asOf, legalStatus: from.legalStatus };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Resolution.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** One version of a rule as the database keeps it; the resolver needs only these members. `effectiveTo` is the first day the version no longer applies (null: no end yet). */
export interface GovernanceRuleVersion {
  id: string;
  type: string;
  code: string;
  version: number;
  status: GovernanceRuleStatus;
  params: RuleParams;
  effectiveFrom: string;
  effectiveTo: string | null;
  /** The organization unit the rule is an override for; null for the rule of the whole tenant. */
  unitId: string | null;
}

export interface ResolvedGovernanceRule {
  type: string;
  code: string;
  params: RuleParams;
  /** The version of the rule that decided (0 for the built-in default): stored on the decisions that used it. */
  version: number;
  source: 'RULE' | 'DEFAULT';
  /** The row that decided, null for a default. */
  ruleId: string | null;
  /** The unit an override was made for, null when the rule of the whole tenant (or the default) decided. */
  unitId: string | null;
  /** The numbers are a starting value nobody confirmed: show it (only a default can be unverified). */
  unverified: boolean;
  /** Formula, source, as-of and legal status of the numbers (those of the built-in default, or of the type when a tenant rule decided); null for a type nobody registered. */
  provenance: Provenance | null;
}

export interface ResolveOptions {
  /** The unit of the thing that is decided and the units above it, nearest first: an override for a nearer unit wins over one for a farther unit, and both win over the rule of the whole tenant. */
  unitChain?: readonly string[];
}

const covers = (candidate: GovernanceRuleVersion, day: string): boolean => candidate.effectiveFrom <= day && (candidate.effectiveTo === null || day < candidate.effectiveTo);

/**
 * The rule in force for `code` of `type` on the business day `asOf` (`YYYY-MM-DD`): an APPROVED or RETIRED version whose period covers the day (a retired version still answers for the days it was in
 * force, so a past decision is read with what governed it), the nearest unit override first, then the newest version; with none, the built-in default; with no default either, undefined. A draft or a
 * submitted version never governs anything.
 */
export function resolveGovernanceRule(rules: readonly GovernanceRuleVersion[], type: string, code: string, asOf: string, options: ResolveOptions = {}): ResolvedGovernanceRule | undefined {
  if (!isRuleDay(asOf)) throw new DomainError('VALIDATION_FAILED', 422, 'as_of');
  const chain = options.unitChain ?? [];
  const specificity = (candidate: GovernanceRuleVersion): number => {
    if (candidate.unitId === null) return chain.length;
    const at = chain.indexOf(candidate.unitId);
    return at;
  };
  const found = rules
    .filter((candidate) => candidate.type === type && candidate.code === code && (candidate.status === 'APPROVED' || candidate.status === 'RETIRED') && covers(candidate, asOf) && specificity(candidate) >= 0)
    .sort((left, right) => specificity(left) - specificity(right) || right.version - left.version || right.effectiveFrom.localeCompare(left.effectiveFrom))[0];
  const provenance = provenanceOf(type, code) ?? null;
  if (found !== undefined) return { type, code, params: found.params, version: found.version, source: 'RULE', ruleId: found.id, unitId: found.unitId, unverified: false, provenance };
  const fallback = REGISTRY.get(type)?.defaults[code];
  if (fallback === undefined) return undefined;
  return { type, code, params: fallback.params, version: 0, source: 'DEFAULT', ruleId: null, unitId: null, unverified: fallback.unverified, provenance };
}

/** The built-in default as a resolved rule (what a caller reads before the port exists, and what a screen shows as "default"); undefined when there is none. */
export const defaultGovernanceRule = (type: string, code: string): ResolvedGovernanceRule | undefined => resolveGovernanceRule([], type, code, '2000-01-01');

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The life of a version (maker is not checker).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export type GovernanceRuleMove = 'SUBMIT' | 'APPROVE' | 'RETIRE' | 'WITHDRAW';

const MOVES: Readonly<Record<GovernanceRuleMove, { from: readonly GovernanceRuleStatus[]; to: GovernanceRuleStatus }>> = {
  SUBMIT: { from: ['DRAFT'], to: 'SUBMITTED' },
  WITHDRAW: { from: ['SUBMITTED'], to: 'DRAFT' },
  APPROVE: { from: ['SUBMITTED'], to: 'APPROVED' },
  // A version that was never approved is retired too (it is discarded and never governed anything); an approved one stops governing and the built-in default (or the version before) answers again.
  RETIRE: { from: ['DRAFT', 'SUBMITTED', 'APPROVED'], to: 'RETIRED' },
};

/**
 * The status after a move, or 409 GOVERNANCE_RULE_STATE_INVALID when the version is not where the move starts. Approving by the person who wrote the version (the maker) or who submitted it is 403
 * SELF_APPROVAL_DENIED: the checker is a third pair of eyes.
 */
export function nextRuleStatus(current: GovernanceRuleStatus, move: GovernanceRuleMove, input: { actor: string; maker: string; submitter: string | null }): GovernanceRuleStatus {
  const step = MOVES[move];
  if (!step.from.includes(current)) throw new DomainError('GOVERNANCE_RULE_STATE_INVALID', 409, 'status');
  if (move === 'APPROVE' && (input.actor === input.maker || input.actor === input.submitter)) throw new DomainError('SELF_APPROVAL_DENIED', 403);
  return step.to;
}

/** The days of a version: a period that ends is after it begins, and both are days. */
export function assertRulePeriod(effectiveFrom: string, effectiveTo: string | null): void {
  if (!isRuleDay(effectiveFrom)) throw new DomainError('VALIDATION_FAILED', 422, 'effective_from');
  if (effectiveTo !== null && (!isRuleDay(effectiveTo) || effectiveTo <= effectiveFrom)) throw new DomainError('VALIDATION_FAILED', 422, 'effective_to');
}

/** The fields that differ between two versions of params, for the diff screen: `before`/`after` are undefined where a key is absent. */
export function diffRuleParams(before: RuleParams, after: RuleParams): Array<{ path: string; before: unknown; after: unknown }> {
  const changes: Array<{ path: string; before: unknown; after: unknown }> = [];
  const walk = (left: unknown, right: unknown, path: string): void => {
    if (isRecord(left) && isRecord(right)) {
      for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) walk(left[key], right[key], path === '' ? key : `${path}.${key}`);
      return;
    }
    if (JSON.stringify(left) !== JSON.stringify(right)) changes.push({ path, before: left, after: right });
  };
  walk(before, after, '');
  return changes;
}
