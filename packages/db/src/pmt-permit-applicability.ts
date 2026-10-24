import { DomainError, compareDecimal } from '@machvon/kernel';

/**
 * The condition under which a permit type applies to a project (PMT 6, `applies_to_rule`): the project groups, the kinds of works and the
 * size of the investment. An empty condition applies to every project. The shape is closed: a key that is not listed is refused, so a
 * condition that no evaluator reads can never be stored as if it meant something.
 */
export interface PermitApplicability {
  projectGroupKeys?: string[];
  workTypes?: string[];
  /** Whole VND as digits (the money convention of the schema), inclusive bounds. */
  minTotalInvestmentVnd?: string;
  maxTotalInvestmentVnd?: string;
}

const MAX_KEYS = 50;
const KEY = /^[A-Z0-9][A-Z0-9_.-]{0,59}$/;
const VND = /^(0|[1-9][0-9]{0,23})$/;
const FIELD = 'applies_to_rule';
const ALLOWED = new Set(['project_group_keys', 'work_types', 'min_total_investment_vnd', 'max_total_investment_vnd']);

const invalid = (): DomainError => new DomainError('VALIDATION_FAILED', 422, FIELD);

function keysOf(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_KEYS) throw invalid();
  const keys = value.map((entry) => {
    if (typeof entry !== 'string' || !KEY.test(entry)) throw invalid();
    return entry;
  });
  return [...new Set(keys)].sort();
}

function amountOf(value: unknown): string {
  if (typeof value !== 'string' || !VND.test(value)) throw invalid();
  return value;
}

/**
 * What is known about a project when the rule is read for it. A fact the project does not have yet (the group of a project is set at
 * appraisal, its kind of works may not be chosen) is `null` or empty, and a rule that depends on it is NOT used to leave the permit out:
 * a permit missing from the list of a dossier is a legal risk nobody sees, a permit too many is one click for the officer who knows better.
 */
export interface ProjectFacts {
  projectGroup: string | null;
  /** The business keys of the project type and the sector of the project, upper case. */
  workTypes: readonly string[];
  /** Whole VND as digits. */
  totalInvestmentVnd: string;
}

/** Whether a stored condition (see `checkApplicability`) applies to a project. Every key present must hold; an absent key constrains nothing. */
export function appliesTo(rule: Record<string, unknown>, facts: ProjectFacts): boolean {
  const groups = rule.project_group_keys as string[] | undefined;
  if (groups !== undefined && facts.projectGroup !== null && !groups.includes(facts.projectGroup)) return false;
  const workTypes = rule.work_types as string[] | undefined;
  if (workTypes !== undefined && facts.workTypes.length > 0 && !workTypes.some((key) => facts.workTypes.includes(key))) return false;
  const min = rule.min_total_investment_vnd as string | undefined;
  if (min !== undefined && compareDecimal(facts.totalInvestmentVnd, min) < 0) return false;
  const max = rule.max_total_investment_vnd as string | undefined;
  return max === undefined || compareDecimal(facts.totalInvestmentVnd, max) <= 0;
}

/** The condition as it is stored: refused when it has an unknown key or a bad value, otherwise with its lists sorted and without repeats. */
export function checkApplicability(rule: unknown): Record<string, unknown> {
  if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) throw invalid();
  const raw = rule as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !ALLOWED.has(key))) throw invalid();
  const stored: Record<string, unknown> = {};
  if (raw.project_group_keys !== undefined) stored.project_group_keys = keysOf(raw.project_group_keys);
  if (raw.work_types !== undefined) stored.work_types = keysOf(raw.work_types);
  const min = raw.min_total_investment_vnd === undefined ? undefined : amountOf(raw.min_total_investment_vnd);
  const max = raw.max_total_investment_vnd === undefined ? undefined : amountOf(raw.max_total_investment_vnd);
  if (min !== undefined && max !== undefined && compareDecimal(min, max) > 0) throw invalid();
  if (min !== undefined) stored.min_total_investment_vnd = min;
  if (max !== undefined) stored.max_total_investment_vnd = max;
  return stored;
}
