import { addDecimal, compareDecimal, subtractDecimal } from './decimal.ts';
import { DomainError } from './errors.ts';
import { DATA_ENTRY_CHECKS, DATA_ENTRY_RULE_TYPE, DATA_ENTRY_SEVERITIES, MANDATORY_FIELDS_TOKEN, PERIOD_STATES, isEntrySurface } from './ind-definitions.ts';
import type { DataEntryCheck, DataEntrySeverity, EntrySurface, PeriodState } from './ind-definitions.ts';

/**
 * The checks made at the moment a number is entered (IND-1, DL.02): a pure judge that the command handlers of the places where numbers are typed or loaded call before they write. A rule is a
 * `DATA_ENTRY_RULE` of the governance store (versioned, approved by someone other than its maker); this module reads its params and holds the facts of one entry up to it.
 *
 * Only the rules a tenant approved are asked: the built-in defaults are starting values that a tenant adopts (approves) and are never in force by themselves, so a tenant that configured nothing sees no
 * change in any command. A check that cannot be made because a fact it needs is not there is skipped and listed (`skipped`); absence is for the rule "required field", not for the others.
 */

/** One rule as the judge reads it. */
export interface EntryRule {
  code: string;
  version: number;
  ruleId: string | null;
  check: DataEntryCheck;
  severity: DataEntrySeverity;
  fields: readonly string[];
  totalField: string | null;
  tolerance: string | null;
  message: string;
  surfaces: readonly EntrySurface[] | null;
  min: string | null;
  max: string | null;
  closedStates: readonly PeriodState[];
}

/** The facts of one entry: what is typed (or loaded) by the name of its field, and the state of the period it is for. */
export interface EntryFacts {
  surface: EntrySurface;
  /** Decimal text for a number, any other text for a word; absent or blank is "not given". */
  values: Readonly<Record<string, string | null | undefined>>;
  /** The state of the reporting period the entry is for, when it is for one. */
  periodStatus?: string | null | undefined;
  /** The fields the dictionary requires on this surface: what the pseudo field `MANDATORY_FIELDS` stands for. */
  mandatory?: readonly string[] | undefined;
}

export interface EntryViolation {
  ruleCode: string;
  ruleVersion: number;
  ruleId: string | null;
  check: DataEntryCheck;
  severity: DataEntrySeverity;
  fields: string[];
  /** The words of the rule for the person who entered. */
  message: string;
  /** What was found, in stable machine words (the values are in the audit trail, not in the message). */
  detail: string;
}

export interface EntrySkip {
  ruleCode: string;
  reason: 'OTHER_SURFACE' | 'FACT_MISSING';
}

export interface EntryVerdict {
  violations: EntryViolation[];
  blocking: EntryViolation[];
  warnings: EntryViolation[];
  evaluated: string[];
  skipped: EntrySkip[];
}

const DECIMAL = /^-?(0|[1-9]\d*)(\.\d+)?$/;
const isDecimal = (value: string | null | undefined): value is string => typeof value === 'string' && DECIMAL.test(value);
const given = (value: string | null | undefined): value is string => typeof value === 'string' && value.trim() !== '';
const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T => (list as readonly unknown[]).includes(value);

/** The rule a resolved `DATA_ENTRY_RULE` says; a rule of another type or one with params the registry would refuse is a mistake of the caller. */
export function entryRuleOf(resolved: { type: string; code: string; version: number; ruleId: string | null; params: Record<string, unknown> }): EntryRule {
  if (resolved.type !== DATA_ENTRY_RULE_TYPE) throw new DomainError('VALIDATION_FAILED', 422, 'rule_type');
  const params = resolved.params;
  const check = params['check'];
  const severity = params['severity'];
  if (!isOneOf(DATA_ENTRY_CHECKS, check) || !isOneOf(DATA_ENTRY_SEVERITIES, severity) || !Array.isArray(params['fields'])) throw new DomainError('VALIDATION_FAILED', 422, 'params');
  const optionalText = (name: string): string | null => (typeof params[name] === 'string' && params[name] !== '' ? (params[name] as string) : null);
  const surfaces = Array.isArray(params['surfaces']) ? (params['surfaces'] as unknown[]).filter(isEntrySurface) : null;
  const closed = Array.isArray(params['closed_states']) ? (params['closed_states'] as unknown[]).filter((state): state is PeriodState => isOneOf(PERIOD_STATES, state)) : [];
  return {
    code: resolved.code,
    version: resolved.version,
    ruleId: resolved.ruleId,
    check,
    severity,
    fields: (params['fields'] as unknown[]).filter((field): field is string => typeof field === 'string'),
    totalField: optionalText('total_field'),
    tolerance: typeof params['tolerance'] === 'number' ? String(params['tolerance']) : null,
    message: typeof params['message'] === 'string' ? params['message'] : '',
    surfaces,
    min: optionalText('min'),
    max: optionalText('max'),
    closedStates: closed.length > 0 ? closed : ['LOCKED'],
  };
}

/** The fields a rule names, with the pseudo field `MANDATORY_FIELDS` replaced by what the dictionary requires. */
const expandedFields = (rule: EntryRule, facts: EntryFacts): string[] => {
  const out: string[] = [];
  for (const field of rule.fields) {
    if (field === MANDATORY_FIELDS_TOKEN) out.push(...(facts.mandatory ?? []));
    else out.push(field);
  }
  return [...new Set(out)];
};

const violation = (rule: EntryRule, fields: string[], detail: string): EntryViolation => ({
  ruleCode: rule.code,
  ruleVersion: rule.version,
  ruleId: rule.ruleId,
  check: rule.check,
  severity: rule.severity,
  fields,
  message: rule.message,
  detail,
});

type Outcome = { skipped: true } | { skipped: false; found?: EntryViolation };

function judgeOne(rule: EntryRule, facts: EntryFacts): Outcome {
  const fields = expandedFields(rule, facts);
  switch (rule.check) {
    case 'CUMULATIVE_NOT_ABOVE_TOTAL': {
      const name = fields[0];
      const cumulative = name === undefined ? undefined : facts.values[name];
      const total = rule.totalField === null ? undefined : facts.values[rule.totalField];
      if (name === undefined || rule.totalField === null || !isDecimal(cumulative) || !isDecimal(total)) return { skipped: true };
      const allowed = rule.tolerance === null ? total : addDecimal(total, rule.tolerance);
      return compareDecimal(cumulative, allowed) > 0 ? { skipped: false, found: violation(rule, [name, rule.totalField], `ABOVE_TOTAL ${name}=${cumulative} ${rule.totalField}=${total}`) } : { skipped: false };
    }
    case 'PARTS_EQUAL_TOTAL': {
      const total = rule.totalField === null ? undefined : facts.values[rule.totalField];
      const parts = fields.map((field) => facts.values[field]);
      if (rule.totalField === null || !isDecimal(total) || parts.some((part) => !isDecimal(part))) return { skipped: true };
      const sum = (parts as string[]).reduce((running, part) => addDecimal(running, part), '0');
      const gap = subtractDecimal(sum, total);
      const size = gap.startsWith('-') ? gap.slice(1) : gap;
      const tolerance = rule.tolerance ?? '0';
      return compareDecimal(size, tolerance) > 0 ? { skipped: false, found: violation(rule, [...fields, rule.totalField], `PARTS_DIFFER sum=${sum} ${rule.totalField}=${total} gap=${gap}`) } : { skipped: false };
    }
    case 'PERIOD_LOCKED_AFTER_CLOSE': {
      const state = facts.periodStatus;
      if (!given(state)) return { skipped: true };
      return (rule.closedStates as readonly string[]).includes(state) ? { skipped: false, found: violation(rule, fields, `PERIOD_${state}`) } : { skipped: false };
    }
    case 'FIELD_REQUIRED': {
      const missing = fields.filter((field) => !given(facts.values[field]));
      return missing.length > 0 ? { skipped: false, found: violation(rule, missing, `MISSING ${missing.join(',')}`) } : { skipped: false };
    }
    case 'VALUE_IN_RANGE': {
      const present = fields.filter((field) => given(facts.values[field]));
      if (present.length === 0) return { skipped: true };
      const outside: string[] = [];
      for (const field of present) {
        const value = facts.values[field];
        if (!isDecimal(value)) outside.push(field);
        else if ((rule.min !== null && compareDecimal(value, rule.min) < 0) || (rule.max !== null && compareDecimal(value, rule.max) > 0)) outside.push(field);
      }
      return outside.length > 0 ? { skipped: false, found: violation(rule, outside, `OUT_OF_RANGE ${outside.join(',')}`) } : { skipped: false };
    }
  }
}

/** Holds the facts of one entry up to the rules, in the order of the rule codes. The same facts and rules always give the same verdict. */
export function evaluateEntryRules(rules: readonly EntryRule[], facts: EntryFacts): EntryVerdict {
  const verdict: EntryVerdict = { violations: [], blocking: [], warnings: [], evaluated: [], skipped: [] };
  for (const rule of [...rules].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))) {
    if (rule.surfaces !== null && !rule.surfaces.includes(facts.surface)) {
      verdict.skipped.push({ ruleCode: rule.code, reason: 'OTHER_SURFACE' });
      continue;
    }
    const outcome = judgeOne(rule, facts);
    if (outcome.skipped) {
      verdict.skipped.push({ ruleCode: rule.code, reason: 'FACT_MISSING' });
      continue;
    }
    verdict.evaluated.push(rule.code);
    if (outcome.found === undefined) continue;
    verdict.violations.push(outcome.found);
    (outcome.found.severity === 'BLOCK' ? verdict.blocking : verdict.warnings).push(outcome.found);
  }
  return verdict;
}

/**
 * The verdict without the rules that ask for a field to be given: a draft that is still being written is judged on what it has, and the "required" rules are held against it when it is handed in. The rules that were
 * evaluated stay listed, so the trail says what was asked.
 */
export function withoutRequiredChecks(verdict: EntryVerdict): EntryVerdict {
  const keep = (list: EntryViolation[]): EntryViolation[] => list.filter((one) => one.check !== 'FIELD_REQUIRED');
  return { ...verdict, violations: keep(verdict.violations), blocking: keep(verdict.blocking), warnings: keep(verdict.warnings) };
}

/** The error of an entry a rule blocks: 422 `IND_ENTRY_RULE_VIOLATED`, the detail names the first rule and the extension lists every blocking violation (the warnings are not an error). */
export function entryRefusal(verdict: EntryVerdict): DomainError | undefined {
  const first = verdict.blocking[0];
  if (first === undefined) return undefined;
  return new DomainError('IND_ENTRY_RULE_VIOLATED', 422, first.ruleCode, {
    extensions: { violations: verdict.blocking.map((one) => ({ rule_code: one.ruleCode, rule_version: one.ruleVersion, check: one.check, fields: one.fields, message: one.message, detail: one.detail })) },
  });
}

/** Throws the refusal when a rule blocks the entry. */
export function assertEntryAllowed(verdict: EntryVerdict): void {
  const refusal = entryRefusal(verdict);
  if (refusal !== undefined) throw refusal;
}

/** What the audit trail keeps of a verdict: rule codes, versions, checks and field names, never the words of a person. */
export function verdictTrail(verdict: EntryVerdict): Record<string, unknown> {
  return {
    evaluated: verdict.evaluated,
    blocked: verdict.blocking.map((one) => ({ rule_code: one.ruleCode, rule_version: one.ruleVersion, check: one.check, fields: one.fields, detail: one.detail })),
    warned: verdict.warnings.map((one) => ({ rule_code: one.ruleCode, rule_version: one.ruleVersion, check: one.check, fields: one.fields, detail: one.detail })),
  };
}
