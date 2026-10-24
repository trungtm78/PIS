import { ApiError } from '@machvon/api-client';
import { listOf } from './model';
import type { Applicability, FieldProblem, FormErrors, Phase } from './model';

export const GATE_MANAGE_PERMISSION = 'permit.gate.manage';
export const GATE_CODES = ['CONTRACT_ACTIVATION', 'START_CONSTRUCTION', 'ACCEPTANCE_COMPLETION', 'HANDOVER', 'ADVANCE_DISBURSEMENT'] as const;
export type GateCode = (typeof GATE_CODES)[number];
export const REQUIREMENTS = ['VALID_PERMIT', 'VALID_OR_EXEMPT', 'SUBMITTED_ONLY'] as const;
export type Requirement = (typeof REQUIREMENTS)[number];
export type RuleStatus = 'DRAFT' | 'PUBLISHED' | 'RETIRED';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KEY = /^[A-Z0-9][A-Z0-9_.-]{0,59}$/;
const VND = /^(0|[1-9][0-9]{0,23})$/;
const MAX_KEYS = 50;
const MAX_BASIS = 2000;
const MAX_MILESTONE = 100;

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const keys = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);

/** One version of a gate rule as the read model gives it. */
export interface GateRuleView {
  id: string;
  gateCode: GateCode;
  milestoneCode: string | null;
  permitTypeId: string;
  permitTypeCode: string;
  requirement: Requirement;
  appliesTo: Applicability;
  legalBasis: string;
  effectiveFrom: string;
  /** The last day the rule applies (inclusive); null while it is open-ended. */
  effectiveUntil: string | null;
  revision: number;
  status: RuleStatus;
  version: number;
}

export function toGateRule(raw: unknown): GateRuleView | undefined {
  if (!isRecord(raw)) return undefined;
  const id = text(raw.id);
  const gateCode = text(raw.gate_code);
  const permitTypeId = text(raw.permit_type_id);
  const permitTypeCode = text(raw.permit_type_code);
  const requirement = text(raw.requirement);
  const legalBasis = text(raw.legal_basis);
  const effectiveFrom = text(raw.effective_from);
  const status = text(raw.status);
  const revision = whole(raw.revision);
  const version = whole(raw.version);
  if (id === undefined || gateCode === undefined || !(GATE_CODES as readonly string[]).includes(gateCode) || permitTypeId === undefined || permitTypeCode === undefined) return undefined;
  if (requirement === undefined || !(REQUIREMENTS as readonly string[]).includes(requirement) || legalBasis === undefined || effectiveFrom === undefined) return undefined;
  if (status === undefined || !['DRAFT', 'PUBLISHED', 'RETIRED'].includes(status) || revision === undefined || version === undefined) return undefined;
  const rule = isRecord(raw.applies_to_rule) ? raw.applies_to_rule : {};
  return {
    id,
    gateCode: gateCode as GateCode,
    milestoneCode: text(raw.project_milestone_code) ?? null,
    permitTypeId,
    permitTypeCode,
    requirement: requirement as Requirement,
    appliesTo: {
      projectGroupKeys: keys(rule.project_group_keys),
      workTypes: keys(rule.work_types),
      minTotalInvestmentVnd: text(rule.min_total_investment_vnd) ?? null,
      maxTotalInvestmentVnd: text(rule.max_total_investment_vnd) ?? null,
    },
    legalBasis,
    effectiveFrom,
    effectiveUntil: text(raw.effective_until) ?? null,
    revision,
    status: status as RuleStatus,
    version,
  };
}

/** Where a rule stands on a date: it applies, it will apply, or it no longer applies. A retired rule still applies until its last day. */
export function rulePhase(rule: GateRuleView, today: string): Phase {
  if (rule.status === 'DRAFT') return 'draft';
  if (rule.effectiveFrom > today) return 'scheduled';
  if (rule.effectiveUntil !== null && rule.effectiveUntil < today) return 'ended';
  return 'inForce';
}

/** The rules grouped by gate, in the order of the gates, the rule in force first and the rest newest first. */
export function rulesByGate(rules: readonly GateRuleView[], today: string): Array<{ gateCode: GateCode; rules: GateRuleView[] }> {
  const order = (phase: Phase): number => (phase === 'inForce' ? 0 : phase === 'scheduled' ? 1 : 2);
  return GATE_CODES.flatMap((gateCode) => {
    const mine = rules
      .filter((rule) => rule.gateCode === gateCode)
      .sort((left, right) => order(rulePhase(left, today)) - order(rulePhase(right, today)) || left.permitTypeCode.localeCompare(right.permitTypeCode) || right.revision - left.revision);
    return mine.length === 0 ? [] : [{ gateCode, rules: mine }];
  });
}

const isRealDate = (value: string): boolean => {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return DATE.test(value) && !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
};

// ---- the form that publishes a rule ----------------------------------------------------------------------------------

export interface GateRuleForm {
  gateCode: GateCode;
  milestoneCode: string;
  permitTypeId: string;
  requirement: Requirement;
  projectGroupKeys: string;
  workTypes: string;
  minInvestment: string;
  maxInvestment: string;
  legalBasis: string;
  effectiveFrom: string;
  effectiveUntil: string;
}

export type GateField = keyof GateRuleForm;

export const EMPTY_GATE_FORM: GateRuleForm = {
  gateCode: 'START_CONSTRUCTION',
  milestoneCode: '',
  permitTypeId: '',
  requirement: 'VALID_PERMIT',
  projectGroupKeys: '',
  workTypes: '',
  minInvestment: '',
  maxInvestment: '',
  legalBasis: '',
  effectiveFrom: '',
  effectiveUntil: '',
};

/** The form field that the server names (the `detail` of a 422), when the screen has one for it. */
export const FIELD_OF_DETAIL: Readonly<Record<string, GateField>> = {
  gate_code: 'gateCode',
  project_milestone_code: 'milestoneCode',
  permit_type_id: 'permitTypeId',
  requirement: 'requirement',
  applies_to_rule: 'projectGroupKeys',
  legal_basis: 'legalBasis',
  effective_from: 'effectiveFrom',
  effective_until: 'effectiveUntil',
};

function keysProblem(value: string): FieldProblem | undefined {
  const entries = listOf(value);
  return entries.length > MAX_KEYS || entries.some((entry) => !KEY.test(entry)) ? 'invalidKeys' : undefined;
}

/**
 * Every rule of the form that the screen can judge without asking the server; the server judges the rest (overlaps). A rule for a gate and a permit
 * type that already have a rule takes over from its first day, which may not be in days that are gone; the first rule may begin in the past.
 */
export function validateGateRule(form: GateRuleForm, today: string, takenOver: boolean): FormErrors<GateField> {
  const errors: FormErrors<GateField> = {};
  if (form.permitTypeId === '') errors.permitTypeId = 'required';
  const basis = form.legalBasis.trim();
  if (basis === '') errors.legalBasis = 'required';
  else if (basis.length > MAX_BASIS) errors.legalBasis = 'tooLong';
  const milestone = form.milestoneCode.trim();
  if (milestone.length > MAX_MILESTONE) errors.milestoneCode = 'tooLong';
  if (form.effectiveFrom === '') errors.effectiveFrom = 'required';
  else if (!isRealDate(form.effectiveFrom)) errors.effectiveFrom = 'invalidDate';
  else if (takenOver && form.effectiveFrom < today) errors.effectiveFrom = 'past';
  if (form.effectiveUntil !== '') {
    if (!isRealDate(form.effectiveUntil)) errors.effectiveUntil = 'invalidDate';
    else if (errors.effectiveFrom === undefined && form.effectiveFrom !== '' && form.effectiveUntil <= form.effectiveFrom) errors.effectiveUntil = 'untilOrder';
  }
  const groups = keysProblem(form.projectGroupKeys);
  if (groups !== undefined) errors.projectGroupKeys = groups;
  const works = keysProblem(form.workTypes);
  if (works !== undefined) errors.workTypes = works;
  const min = form.minInvestment.trim();
  const max = form.maxInvestment.trim();
  if (min !== '' && !VND.test(min)) errors.minInvestment = 'invalidAmount';
  if (max !== '' && !VND.test(max)) errors.maxInvestment = 'invalidAmount';
  if (errors.minInvestment === undefined && errors.maxInvestment === undefined && min !== '' && max !== '' && BigInt(min) > BigInt(max)) errors.maxInvestment = 'amountOrder';
  return errors;
}

export interface PublishGateBody {
  gate_code: GateCode;
  project_milestone_code?: string;
  permit_type_id: string;
  requirement: Requirement;
  applies_to_rule: Record<string, unknown>;
  legal_basis: string;
  effective_from: string;
  effective_until?: string;
}

export function toPublishBody(form: GateRuleForm): PublishGateBody {
  const groups = listOf(form.projectGroupKeys);
  const works = listOf(form.workTypes);
  return {
    gate_code: form.gateCode,
    ...(form.milestoneCode.trim() === '' ? {} : { project_milestone_code: form.milestoneCode.trim() }),
    permit_type_id: form.permitTypeId,
    requirement: form.requirement,
    applies_to_rule: {
      ...(groups.length === 0 ? {} : { project_group_keys: groups }),
      ...(works.length === 0 ? {} : { work_types: works }),
      ...(form.minInvestment.trim() === '' ? {} : { min_total_investment_vnd: form.minInvestment.trim() }),
      ...(form.maxInvestment.trim() === '' ? {} : { max_total_investment_vnd: form.maxInvestment.trim() }),
    },
    legal_basis: form.legalBasis.trim(),
    effective_from: form.effectiveFrom,
    ...(form.effectiveUntil === '' ? {} : { effective_until: form.effectiveUntil }),
  };
}

/** The last day of a retirement: a real date, after the rule began, not in days that are gone (unless it is the end the rule already has) and not later than the end it already has. */
export function validateRetireDate(effectiveUntil: string, rule: GateRuleView, today: string): FieldProblem | undefined {
  if (effectiveUntil === '') return 'required';
  if (!isRealDate(effectiveUntil)) return 'invalidDate';
  if (effectiveUntil <= rule.effectiveFrom) return 'untilOrder';
  if (rule.effectiveUntil !== null && effectiveUntil > rule.effectiveUntil) return 'laterEnd';
  if (effectiveUntil < today && effectiveUntil !== rule.effectiveUntil) return 'past';
  return undefined;
}

/** Whether a rule can still be ended earlier: it has no end yet, or its end has not passed. */
export const canRetire = (rule: GateRuleView, today: string): boolean => rule.status !== 'DRAFT' && (rule.effectiveUntil === null || rule.effectiveUntil > today);

export type GateProblemReason = 'overlap' | 'legalBasis' | 'validation' | 'denied' | 'notFound' | 'general';

const REASON_BY_CODE: Readonly<Record<string, GateProblemReason>> = {
  GATE_RULE_OVERLAP: 'overlap',
  LEGAL_BASIS_REQUIRED: 'legalBasis',
  VALIDATION_FAILED: 'validation',
  FIELD_NOT_ALLOWED: 'validation',
  INVALID_REQUEST: 'validation',
  SCOPE_DENIED: 'denied',
  PERMISSION_DENIED: 'denied',
  RESOURCE_NOT_FOUND: 'notFound',
};

export interface GateProblemView {
  reason: GateProblemReason;
  field: string | undefined;
}

/** Maps the failure of a command of this screen to what it shows; an unknown failure is the general message. */
export function describeGateProblem(error: unknown): GateProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail };
}

// ---- the evaluation ----------------------------------------------------------------------------------------------------

export type GateStatus = 'PASSED' | 'PASSED_WITH_WAIVER' | 'BLOCKED';
export type Outcome = 'SATISFIED' | 'WAIVED' | 'BLOCKING';

export interface VerdictView {
  ruleId: string;
  revision: number;
  milestoneCode: string | null;
  permitTypeCode: string;
  requirement: Requirement;
  legalBasis: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  outcome: Outcome;
  permit: { id: string; permitNo: string | null; status: string; validUntil: string | null } | null;
  waiver: { id: string; validUntil: string } | null;
}

export interface GateView {
  gateCode: GateCode;
  status: GateStatus;
  rules: VerdictView[];
}

export interface EvaluationView {
  projectId: string;
  asOf: string;
  gates: GateView[];
}

function toVerdict(raw: unknown): VerdictView | undefined {
  if (!isRecord(raw)) return undefined;
  const ruleId = text(raw.rule_id);
  const permitTypeCode = text(raw.permit_type_code);
  const requirement = text(raw.requirement);
  const outcome = text(raw.outcome);
  const legalBasis = text(raw.legal_basis);
  const revision = whole(raw.revision);
  const effectiveFrom = text(raw.effective_from);
  if (ruleId === undefined || permitTypeCode === undefined || legalBasis === undefined || revision === undefined || effectiveFrom === undefined) return undefined;
  if (requirement === undefined || !(REQUIREMENTS as readonly string[]).includes(requirement) || outcome === undefined || !['SATISFIED', 'WAIVED', 'BLOCKING'].includes(outcome)) return undefined;
  const permit = isRecord(raw.permit) ? raw.permit : undefined;
  const waiver = isRecord(raw.waiver) ? raw.waiver : undefined;
  const permitId = text(permit?.id);
  const waiverId = text(waiver?.id);
  return {
    ruleId,
    revision,
    milestoneCode: text(raw.project_milestone_code) ?? null,
    permitTypeCode,
    requirement: requirement as Requirement,
    legalBasis,
    effectiveFrom,
    effectiveUntil: text(raw.effective_until) ?? null,
    outcome: outcome as Outcome,
    permit: permitId === undefined ? null : { id: permitId, permitNo: text(permit?.permit_no) ?? null, status: text(permit?.status) ?? '', validUntil: text(permit?.valid_until) ?? null },
    waiver: waiverId === undefined ? null : { id: waiverId, validUntil: text(waiver?.valid_until) ?? '' },
  };
}

/** The answer of `evaluatePermitGates`; undefined when it is not the shape of one. */
export function toEvaluation(raw: unknown): EvaluationView | undefined {
  if (!isRecord(raw)) return undefined;
  const projectId = text(raw.project_id);
  const asOf = text(raw.as_of);
  if (projectId === undefined || asOf === undefined || !Array.isArray(raw.gates)) return undefined;
  const gates = raw.gates.flatMap((entry: unknown): GateView[] => {
    if (!isRecord(entry)) return [];
    const gateCode = text(entry.gate_code);
    const status = text(entry.status);
    if (gateCode === undefined || !(GATE_CODES as readonly string[]).includes(gateCode) || status === undefined || !['PASSED', 'PASSED_WITH_WAIVER', 'BLOCKED'].includes(status)) return [];
    return [{ gateCode: gateCode as GateCode, status: status as GateStatus, rules: (Array.isArray(entry.rules) ? entry.rules : []).flatMap((rule: unknown) => toVerdict(rule) ?? []) }];
  });
  return { projectId, asOf, gates };
}

/** The date an evaluation is asked for: a real day, or nothing (today). */
export const asOfOf = (value: string): { at: string | undefined; valid: boolean } => (value === '' ? { at: undefined, valid: true } : isRealDate(value) ? { at: value, valid: true } : { at: undefined, valid: false });
