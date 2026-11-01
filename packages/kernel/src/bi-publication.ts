import { DomainError } from './errors.ts';

/**
 * What a request to publish is about (ST-BI-006, BI 3 F5): a tenant metric to certify, a version of a dashboard to publish or an access policy to activate. It is judged by checks made when it is asked and made again when it is
 * decided; a decision to approve stands on the second run, not on the first.
 */
export const PUBLICATION_KINDS = ['METRIC', 'DASHBOARD', 'ACCESS_POLICY'] as const;
export type PublicationKind = (typeof PUBLICATION_KINDS)[number];
export const PUBLICATION_DECISIONS = ['APPROVED', 'REJECTED'] as const;
export type PublicationDecision = (typeof PUBLICATION_DECISIONS)[number];

export interface PublicationCheck {
  code: string;
  passed: boolean;
}

/**
 * What a rerun of a metric over the latest frozen version of its dataset saw: the rows the snapshot says it has against the rows it has, and whether the groups of every dimension of the metric add up to the whole it
 * gives (the sum of the groups of an additive figure, of the numerators and of the denominators of a ratio, is the sum of all the lines).
 */
export interface Reproduction {
  storedRows: number;
  countedRows: number;
  reconciles: boolean;
}

export const CHECK_FORMULA = 'FORMULA_COMPUTABLE';
export const CHECK_FROZEN_VERSION = 'FROZEN_VERSION_EXISTS';
export const CHECK_ROWS = 'ROWS_MATCH_SNAPSHOT';
export const CHECK_GROUPS = 'GROUPS_ADD_UP';

/**
 * The checks of the reproduction of a metric, in the order they are made. A formula that cannot be computed, a dataset with no frozen version to rerun it on, rows that differ from the snapshot and groups that do not
 * add up each fail on their own, and a check that could not be made because an earlier one failed is not passed.
 */
export function reproductionChecks(formulaComputable: boolean, reproduction: Reproduction | undefined): PublicationCheck[] {
  const frozen = formulaComputable && reproduction !== undefined;
  return [
    { code: CHECK_FORMULA, passed: formulaComputable },
    { code: CHECK_FROZEN_VERSION, passed: frozen },
    { code: CHECK_ROWS, passed: frozen && reproduction.storedRows === reproduction.countedRows },
    { code: CHECK_GROUPS, passed: frozen && reproduction.reconciles },
  ];
}

export const failedCheck = (checks: readonly PublicationCheck[]): PublicationCheck | undefined => checks.find((check) => !check.passed);

/** A request that is rejected says why: a refusal nobody can read is not a decision. */
export function assertDecisionReason(decision: PublicationDecision, comment: string | undefined): string | null {
  const text = comment === undefined ? '' : comment.trim().normalize('NFC');
  if (decision === 'REJECTED' && text === '') throw new DomainError('VALIDATION_FAILED', 422, 'comment');
  return text === '' ? null : text;
}
