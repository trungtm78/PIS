import { ApiError } from '@machvon/api-client';
import { FINDING_STATUSES, FINDINGS_PERMISSION, holds } from '../analysis/model';
import type { FindingStatus } from '../analysis/model';
import { REVIEW_DECISIONS, reviewPath } from '../review/model';
import type { ReviewDecision } from '../review/model';

export { FINDINGS_PERMISSION, holds, reviewPath };

/** How a decided finding bears on the evaluation; what nobody decided is UNDECIDED. */
export const CELL_RISKS = ['UNDECIDED', 'NONE', 'ATTENTION', 'MANDATORY_NOT_MET'] as const;
export type CellRisk = (typeof CELL_RISKS)[number];
/** Why a proposal is not in the table. */
export const EXCLUSION_REASONS = ['CRITERIA_VERSION_MISMATCH', 'NO_ANALYSIS_RUN'] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const nullableWhole = (value: unknown): number | null => whole(value) ?? null;
const oneOf = <T extends string>(list: readonly T[], value: unknown): T | undefined => list.find((candidate) => candidate === value);
const list = <T>(value: unknown, read: (item: unknown) => T | undefined): T[] => (Array.isArray(value) ? value.flatMap((item) => read(item) ?? []) : []);

export const isUuid = (value: string): boolean => UUID.test(value);

export interface Contractor {
  id: string;
  name: string;
}

function toContractor(raw: unknown): Contractor | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const name = text(row?.legal_name);
  return id === undefined || name === undefined ? undefined : { id, name };
}

/** A proposal in the table, with how far its criteria are decided; there is no total that ranks it and no mark that names it a winner. */
export interface ComparedProposal {
  proposalId: string;
  contractor: Contractor;
  runId: string;
  decidedCount: number;
  criteriaCount: number;
  mandatoryNotMet: number;
  /** Out of 100, from the scores the experts gave; null until every scored criterion has one. */
  weightedScore: string | null;
}

export interface Criterion {
  code: string;
  name: string;
  kind: 'SCORED' | 'PASS_FAIL';
  weight: number | null;
  maxScore: number | null;
  threshold: number | null;
  mandatory: boolean;
}

/** What a person decided about a finding; what the model said is not part of the table. */
export interface Decided {
  status: FindingStatus;
  score: string | null;
  decision: ReviewDecision;
  decidedAt: string;
}

export interface Cell {
  proposalId: string;
  findingId: string | null;
  decided: Decided | null;
  risk: CellRisk;
}

export interface Row {
  criterion: Criterion;
  cells: Cell[];
}

export interface Excluded {
  proposalId: string;
  contractor: Contractor;
  runId: string | null;
  criteriaVersionId: string | null;
  reason: ExclusionReason;
}

export interface Comparison {
  packageId: string;
  packageCode: string;
  criteriaVersionId: string;
  criteriaStatus: string;
  proposals: ComparedProposal[];
  rows: Row[];
  excluded: Excluded[];
  excludedCriteria: Array<{ code: string; rule: string }>;
  excludedAttributes: string[];
}

function toProposal(raw: unknown): ComparedProposal | undefined {
  const row = asRecord(raw);
  const proposalId = text(row?.proposal_id);
  const contractor = toContractor(row?.contractor);
  const runId = text(row?.run_id);
  if (row === undefined || proposalId === undefined || contractor === undefined || runId === undefined) return undefined;
  return {
    proposalId,
    contractor,
    runId,
    decidedCount: whole(row.decided_count) ?? 0,
    criteriaCount: whole(row.criteria_count) ?? 0,
    mandatoryNotMet: whole(row.mandatory_not_met) ?? 0,
    weightedScore: nullableText(row.weighted_score),
  };
}

function toCriterion(raw: unknown): Criterion | undefined {
  const row = asRecord(raw);
  const code = text(row?.code);
  const name = text(row?.name);
  const kind = row?.kind === 'SCORED' || row?.kind === 'PASS_FAIL' ? row.kind : undefined;
  if (row === undefined || code === undefined || name === undefined || kind === undefined) return undefined;
  return { code, name, kind, weight: nullableWhole(row.weight), maxScore: nullableWhole(row.max_score), threshold: nullableWhole(row.threshold), mandatory: row.mandatory === true };
}

function toDecided(raw: unknown): Decided | null {
  const row = asRecord(raw);
  const status = oneOf(FINDING_STATUSES, row?.status);
  const decision = oneOf(REVIEW_DECISIONS, row?.decision);
  const decidedAt = text(row?.decided_at);
  if (row === undefined || status === undefined || decision === undefined || decidedAt === undefined) return null;
  return { status, score: nullableText(row.score), decision, decidedAt };
}

function toCell(raw: unknown): Cell | undefined {
  const row = asRecord(raw);
  const proposalId = text(row?.proposal_id);
  if (row === undefined || proposalId === undefined) return undefined;
  const decided = toDecided(row.decided);
  // What the server did not say is a decision is not one: a cell without a decision is undecided whatever its risk says.
  return { proposalId, findingId: nullableText(row.finding_id), decided, risk: decided === null ? 'UNDECIDED' : (oneOf(CELL_RISKS, row.risk) ?? 'ATTENTION') };
}

function toRow(raw: unknown): Row | undefined {
  const row = asRecord(raw);
  const criterion = toCriterion(row?.criterion);
  return row === undefined || criterion === undefined ? undefined : { criterion, cells: list(row.cells, toCell) };
}

function toExcluded(raw: unknown): Excluded | undefined {
  const row = asRecord(raw);
  const proposalId = text(row?.proposal_id);
  const contractor = toContractor(row?.contractor);
  const reason = oneOf(EXCLUSION_REASONS, row?.reason);
  if (row === undefined || proposalId === undefined || contractor === undefined || reason === undefined) return undefined;
  return { proposalId, contractor, runId: nullableText(row.run_id), criteriaVersionId: nullableText(row.criteria_version_id), reason };
}

export function toComparison(raw: unknown): Comparison | undefined {
  const body = asRecord(raw);
  const pack = asRecord(body?.package);
  const packageId = text(pack?.id);
  const criteriaVersionId = text(body?.criteria_version_id);
  if (body === undefined || packageId === undefined || criteriaVersionId === undefined) return undefined;
  return {
    packageId,
    packageCode: text(pack?.code) ?? '',
    criteriaVersionId,
    criteriaStatus: text(body.criteria_status) ?? '',
    // The order the server gave is the order shown: it is the order of the names of the contractors and never a ranking.
    proposals: list(body.proposals, toProposal),
    rows: list(body.rows, toRow),
    excluded: list(body.excluded, toExcluded),
    excludedCriteria: list(body.excluded_criteria, (item) => {
      const row = asRecord(item);
      const code = text(row?.code);
      const rule = text(row?.rule);
      return code === undefined || rule === undefined ? undefined : { code, rule };
    }),
    excludedAttributes: list(body.excluded_attributes, (item) => text(item)),
  };
}

/** Whether a table has anything to set side by side: a proposal that ran on the criteria asked for and a criterion. */
export const hasTable = (comparison: Comparison): boolean => comparison.proposals.length > 0 && comparison.rows.length > 0;

/** The cell of a proposal in a row. */
export const cellOf = (row: Row, proposalId: string): Cell | undefined => row.cells.find((cell) => cell.proposalId === proposalId);

// ---- what is asked -----------------------------------------------------------------------------------------------------------------------

/** The package is the one in the address; a text that is not an identity is not asked for. */
export const packageFromParam = (value: string | null): string => (value !== null && isUuid(value) ? value.toLowerCase() : '');

/** The version of the criteria asked for; a text that is not an identity is the same as none. */
export const versionFromParam = (value: string | null): string => (value !== null && isUuid(value.trim()) ? value.trim().toLowerCase() : '');

export type VersionProblem = 'notIdentity';

/** What is wrong with the version typed before it is applied: nothing typed is the version in force. */
export const validateVersion = (value: string): VersionProblem | undefined => (value.trim() === '' || isUuid(value.trim()) ? undefined : 'notIdentity');

// ---- refusals ----------------------------------------------------------------------------------------------------------------------------

/** How a failed read is told to the person: a package that does not exist for the caller, one they owe the declaration for, a version that is not one of the package; anything else is for the standard states. */
export function readFailure(error: unknown): 'notFound' | 'undeclared' | 'version' | undefined {
  if (!(error instanceof ApiError)) return undefined;
  if (error.code === 'CONFLICT_UNDECLARED') return 'undeclared';
  if (error.status === 422 && error.code === 'VALIDATION_FAILED') return 'version';
  return error.status === 404 ? 'notFound' : undefined;
}
