import { DomainError } from './errors.ts';

export type RuleConfirmation = 'CONFIRMED' | 'AWAITING_CONFIRMATION';

/**
 * One version of a legal rule or of a form template kept as data (ST-KERNEL-060). The range is [validFrom, validUntil): `validUntil` is the first day the version no longer
 * applies and null means it has no end yet, the convention of master data and of the template tables. A law change is a new version, never an edit of this one.
 */
export interface DatedRule<T> {
  code: string;
  revision: number;
  validFrom: string;
  validUntil: string | null;
  legalBasis: string;
  confirmation: RuleConfirmation;
  payload: T;
}

export interface ResolvedRule<T> {
  rule: DatedRule<T>;
  /** The rule is a working assumption until a lawyer confirms it: whatever is produced with it carries the watermark. */
  watermarked: boolean;
  legalBasis: string;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function assertDay(value: string, field: string): void {
  if (!ISO_DAY.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new DomainError('VALIDATION_FAILED', 422, field);
}

const covers = (rule: DatedRule<unknown>, day: string): boolean => rule.validFrom <= day && (rule.validUntil === null || day < rule.validUntil);

/**
 * The version of `code` that governed the business date `asOf`, with its legal basis and whether it still waits for confirmation; undefined when no version covered the day.
 * The date is the date of the business fact (the day a request is made), so a request made under version 1 is read with version 1 for ever after, whatever was published
 * since (bind the revision it was made with and read it back with `ruleOfRevision`).
 */
export function resolveRule<T>(rules: readonly DatedRule<T>[], code: string, asOf: string): ResolvedRule<T> | undefined {
  assertDay(asOf, 'as_of');
  const found = rules.filter((rule) => rule.code === code && covers(rule, asOf)).sort((left, right) => right.revision - left.revision)[0];
  return found === undefined ? undefined : { rule: found, watermarked: found.confirmation !== 'CONFIRMED', legalBasis: found.legalBasis };
}

/** The exact revision a record was bound to when it was made: history is read by revision, not by today's date. */
export function ruleOfRevision<T>(rules: readonly DatedRule<T>[], code: string, revision: number): DatedRule<T> | undefined {
  return rules.find((rule) => rule.code === code && rule.revision === revision);
}

/**
 * Refuses a set of versions of one code that covers a day twice, that ends before it starts, that has a day that is not a day, or that carries no legal basis: a law change
 * must not rewrite history, and a rule with no basis is not a rule (409 RULE_RANGE_OVERLAP, 422 VALIDATION_FAILED).
 */
export function assertRuleVersions(rules: readonly DatedRule<unknown>[]): void {
  for (const rule of rules) {
    assertDay(rule.validFrom, 'valid_from');
    if (rule.validUntil !== null) {
      assertDay(rule.validUntil, 'valid_until');
      if (rule.validUntil <= rule.validFrom) throw new DomainError('VALIDATION_FAILED', 422, 'valid_until');
    }
    if (rule.legalBasis.trim() === '') throw new DomainError('VALIDATION_FAILED', 422, 'legal_basis');
  }
  const ordered = [...rules].sort((left, right) => (left.code === right.code ? left.validFrom.localeCompare(right.validFrom) : left.code.localeCompare(right.code)));
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous !== undefined && current !== undefined && previous.code === current.code && (previous.validUntil === null || current.validFrom < previous.validUntil)) {
      throw new DomainError('RULE_RANGE_OVERLAP', 409, 'valid_from', { extensions: { rule_code: current.code, rule_revision: current.revision, overlaps_revision: previous.revision } });
    }
  }
}
