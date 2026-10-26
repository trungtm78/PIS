import { ApiError } from '@machvon/api-client';

/** The three screens that read the two disbursement rates over a frozen snapshot (ST-DIS-010, DIS 3 F6). */
export const PAIRED_PATH = '/dis/dis-19';
export const UNIT_TOTALS_PATH = '/dis/dis-12';
export const FULL_TABLE_PATH = '/dis/dis-16';
export const READ_PERMISSION = 'disbursement.read';
/** The terms the formulas are proposals under until the business owner signs them. */
export const FORMULA_REFERENCE = 'CXN-03';

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined);

export const NULL_REASONS = ['ZERO_DENOMINATOR', 'NO_DATA', 'TREASURY_COVERAGE_NONE'] as const;
export type NullReason = (typeof NULL_REASONS)[number];
export const COVERAGES = ['COMPLETE', 'PARTIAL', 'NONE'] as const;
export type Coverage = (typeof COVERAGES)[number];
export const BASES = ['CURRENT_YEAR', 'CARRYOVER'] as const;
export type Basis = (typeof BASES)[number];
export const DEFINITIONS = ['PROPOSED_PENDING_SIGNOFF', 'SIGNED'] as const;
export type Definition = (typeof DEFINITIONS)[number];

/** The figures of one row of the answer: the plan in its two parts, the one numerator, and the two rates that are made from them. */
export interface RateFigures {
  projects: number;
  numeratorVnd: string | null;
  planPmVnd: string;
  planLocalVnd: string;
  planTotalVnd: string;
  ratePmPct: string | null;
  rateTotalPct: string | null;
  nullReason: NullReason | null;
  coverage: Coverage;
  reportedVnd: string | null;
  ctmtqgVnd: string | null;
}

export interface RateGroup extends RateFigures {
  id: string | null;
  code: string | null;
  name: string | null;
}

export interface Rates extends RateFigures {
  snapshotId: string;
  snapshotKind: string;
  snapshotStatus: string;
  asOfDate: string;
  cutoffDate: string;
  definition: Definition;
  basis: Basis;
  groups: RateGroup[];
}

function figuresOf(row: Raw): RateFigures | undefined {
  const projects = whole(row.projects);
  const pm = text(row.plan_pm_assigned_vnd);
  const local = text(row.plan_local_added_vnd);
  const total = text(row.plan_total_vnd);
  const coverage = COVERAGES.find((candidate) => candidate === row.treasury_coverage);
  if (projects === undefined || pm === undefined || local === undefined || total === undefined || coverage === undefined) return undefined;
  return {
    projects,
    numeratorVnd: nullableText(row.numerator_disbursed_vnd),
    planPmVnd: pm,
    planLocalVnd: local,
    planTotalVnd: total,
    ratePmPct: nullableText(row.rate_pm_pct),
    rateTotalPct: nullableText(row.rate_total_pct),
    nullReason: NULL_REASONS.find((candidate) => candidate === row.rate_null_reason) ?? null,
    coverage,
    reportedVnd: nullableText(row.reported_vnd),
    ctmtqgVnd: nullableText(row.ctmtqg_subset_vnd),
  };
}

export function toRates(raw: unknown): Rates | undefined {
  const row = asRecord(raw);
  if (row === undefined) return undefined;
  const figures = figuresOf(row);
  const snapshotId = text(row.snapshot_id);
  const cutoff = text(row.treasury_cutoff_date);
  const asOf = text(row.as_of_date);
  const definition = DEFINITIONS.find((candidate) => candidate === row.definition_status);
  const basis = BASES.find((candidate) => candidate === row.basis);
  if (figures === undefined || snapshotId === undefined || cutoff === undefined || asOf === undefined || definition === undefined || basis === undefined) return undefined;
  const groups = (Array.isArray(row.groups) ? row.groups : []).flatMap((item): RateGroup[] => {
    const group = asRecord(item);
    const parts = group === undefined ? undefined : figuresOf(group);
    return group === undefined || parts === undefined ? [] : [{ ...parts, id: nullableText(group.id), code: nullableText(group.code), name: nullableText(group.name) }];
  });
  return { ...figures, snapshotId, snapshotKind: text(row.snapshot_kind) ?? '', snapshotStatus: text(row.snapshot_status) ?? '', asOfDate: asOf, cutoffDate: cutoff, definition, basis, groups };
}

export interface RatesQuery {
  snapshotId?: string | undefined;
  unitId?: string | undefined;
  projectId?: string | undefined;
  basis: Basis;
  groupBy?: 'UNIT' | 'PROJECT' | undefined;
}

/** The query of the read, in the words of the contract; what is not asked for is not sent. */
export function ratesQueryOf(query: RatesQuery): Record<string, string> {
  return {
    ...(query.snapshotId === undefined || query.snapshotId === '' ? {} : { snapshot_id: query.snapshotId }),
    ...(query.unitId === undefined || query.unitId === '' ? {} : { unit_id: query.unitId }),
    ...(query.projectId === undefined || query.projectId === '' ? {} : { project_id: query.projectId }),
    bucket: query.basis,
    ...(query.groupBy === undefined ? {} : { group_by: query.groupBy }),
  };
}

/** A rate can pass 100% of the plan the Prime Minister gave when the province adds to it: the screen says so next to it. */
export const passesWhole = (ratePct: string | null): boolean => ratePct !== null && Number(ratePct) > 100;

/** The figures of every row added up, the way the total row of a table is made: the rates are the sums over the sums, not the mean of the rates. */
export function totalOf(groups: readonly RateGroup[]): { numeratorVnd: string | null; planPmVnd: string; planLocalVnd: string; projects: number } {
  let numerator: bigint | null = null;
  let pm = 0n;
  let local = 0n;
  let projects = 0;
  for (const group of groups) {
    if (group.numeratorVnd !== null) numerator = (numerator ?? 0n) + BigInt(group.numeratorVnd);
    pm += BigInt(group.planPmVnd);
    local += BigInt(group.planLocalVnd);
    projects += group.projects;
  }
  return { numeratorVnd: numerator === null ? null : numerator.toString(), planPmVnd: pm.toString(), planLocalVnd: local.toString(), projects };
}

export type RatesProblem = 'notFound' | 'validation' | 'scopeDenied' | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, RatesProblem>> = {
  RESOURCE_NOT_FOUND: 'notFound',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  SCOPE_DENIED: 'scopeDenied',
};

export const describeRates = (error: unknown): RatesProblem => (error instanceof ApiError ? (PROBLEM_BY_CODE[error.code] ?? 'general') : 'general');
