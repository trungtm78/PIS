import { createHash } from 'node:crypto';
import { addDecimal, compareDecimal, subtractDecimal } from './decimal.ts';
import { DomainError } from './errors.ts';
import type { LineHold } from './cap-reallocation.ts';

/**
 * The simulation of an allocation (ST-CAP-013, CAP 3.1 F8, CAP-09): a planner states moves of capital between projects of the plan in force as assumptions and floors and limits as constraints, runs the scenario and
 * reads each line before and after. A scenario never writes the ledger or an allocation line; it is promoted to a DRAFT reallocation proposal, which has its own approval. The rules are here, with no store or clock.
 */
export const SCENARIO_STATUSES = ['DRAFT', 'RUN', 'PROMOTED', 'ARCHIVED'] as const;
export type ScenarioStatus = (typeof SCENARIO_STATUSES)[number];

export const MAX_SCENARIO_MOVES = 200;
const CONSTRAINT_KEYS = ['min_remaining_vnd', 'max_move_vnd', 'max_total_vnd'] as const;
const MOVE_KEYS = ['from_allocation_line_id', 'to_project_id', 'amount_vnd', 'rationale'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POSITIVE_VND = /^[1-9][0-9]{0,23}$/;
const WHOLE_VND = /^(0|[1-9][0-9]{0,23})$/;

/** One assumed move: the amount taken from a line of the plan and given to another project of the same appropriation. */
export interface ScenarioMove {
  fromAllocationLineId: string;
  toProjectId: string;
  amountVnd: string;
  rationale: string;
}

/** The limits a scenario must keep; an absent limit is not judged. */
export interface ScenarioConstraints {
  /** A donor line keeps at least this much after the moves, over and above what is reserved, committed and disbursed on it. */
  minRemainingVnd: string | null;
  /** No single move is larger than this. */
  maxMoveVnd: string | null;
  /** The moves together are not larger than this. */
  maxTotalVnd: string | null;
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function noOtherKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw invalid(`${field}.${key}`);
}

/** The assumptions of a scenario: `{ moves: [...] }`, one to 200 moves, each a line of the plan, the receiving project and a whole positive amount. Anything else is a fault of the request (422 VALIDATION_FAILED). */
export function parseAssumptions(raw: unknown): ScenarioMove[] {
  if (!isObject(raw)) throw invalid('assumptions');
  noOtherKeys(raw, ['moves'], 'assumptions');
  const moves = raw.moves;
  if (!Array.isArray(moves) || moves.length === 0 || moves.length > MAX_SCENARIO_MOVES) throw invalid('assumptions.moves');
  const seen = new Set<string>();
  return moves.map((entry: unknown, index): ScenarioMove => {
    const field = `assumptions.moves[${index}]`;
    if (!isObject(entry)) throw invalid(field);
    noOtherKeys(entry, MOVE_KEYS, field);
    const { from_allocation_line_id: from, to_project_id: to, amount_vnd: amount, rationale } = entry;
    if (typeof from !== 'string' || !UUID.test(from)) throw invalid(`${field}.from_allocation_line_id`);
    if (typeof to !== 'string' || !UUID.test(to)) throw invalid(`${field}.to_project_id`);
    if (typeof amount !== 'string' || !POSITIVE_VND.test(amount)) throw invalid(`${field}.amount_vnd`);
    if (rationale !== undefined && (typeof rationale !== 'string' || rationale !== rationale.trim() || rationale.length > 2000)) throw invalid(`${field}.rationale`);
    const key = `${from.toLowerCase()}|${to.toLowerCase()}`;
    if (seen.has(key)) throw invalid(`${field}.from_allocation_line_id`);
    seen.add(key);
    return { fromAllocationLineId: from.toLowerCase(), toProjectId: to.toLowerCase(), amountVnd: amount, rationale: rationale ?? '' };
  });
}

/** The constraints of a scenario: any of `min_remaining_vnd`, `max_move_vnd`, `max_total_vnd`, each a whole number of dong (the first may be 0, the others are positive). */
export function parseConstraints(raw: unknown): ScenarioConstraints {
  if (!isObject(raw)) throw invalid('constraints');
  noOtherKeys(raw, CONSTRAINT_KEYS, 'constraints');
  const whole = (key: (typeof CONSTRAINT_KEYS)[number], pattern: RegExp): string | null => {
    const value = raw[key];
    if (value === undefined) return null;
    if (typeof value !== 'string' || !pattern.test(value)) throw invalid(`constraints.${key}`);
    return value;
  };
  return { minRemainingVnd: whole('min_remaining_vnd', WHOLE_VND), maxMoveVnd: whole('max_move_vnd', POSITIVE_VND), maxTotalVnd: whole('max_total_vnd', POSITIVE_VND) };
}

/** The assumptions as they are kept: the same moves in the shape of the contract, so that what was run is what was asked. */
export function assumptionsJson(moves: readonly ScenarioMove[]): { moves: Array<Record<string, string>> } {
  return {
    moves: moves.map((move) => ({
      from_allocation_line_id: move.fromAllocationLineId,
      to_project_id: move.toProjectId,
      amount_vnd: move.amountVnd,
      ...(move.rationale === '' ? {} : { rationale: move.rationale }),
    })),
  };
}

export function constraintsJson(constraints: ScenarioConstraints): Record<string, string> {
  return {
    ...(constraints.minRemainingVnd === null ? {} : { min_remaining_vnd: constraints.minRemainingVnd }),
    ...(constraints.maxMoveVnd === null ? {} : { max_move_vnd: constraints.maxMoveVnd }),
    ...(constraints.maxTotalVnd === null ? {} : { max_total_vnd: constraints.maxTotalVnd }),
  };
}

/** A move once its lines are known: the donor line and the line of the receiving project in the same appropriation. */
export interface ResolvedMove {
  fromLineId: string;
  toLineId: string;
  fromProjectId: string;
  toProjectId: string;
  amountVnd: string;
  rationale: string;
}

export type ScenarioViolation =
  | { kind: 'NO_RECIPIENT_LINE'; move: number; toProjectId: string }
  | { kind: 'MOVE_ABOVE_LIMIT'; move: number; amountVnd: string; limitVnd: string }
  | { kind: 'TOTAL_ABOVE_LIMIT'; totalVnd: string; limitVnd: string }
  | { kind: 'BELOW_MINIMUM'; lineId: string; allocatedVnd: string; reducedVnd: string; minimumVnd: string };

export interface ScenarioLine {
  lineId: string;
  projectId: string;
  beforeVnd: string;
  afterVnd: string;
  /** What must remain on the line: what is reserved, committed and disbursed on it, or the minimum of the scenario when that is more. */
  minimumVnd: string;
}

export interface ScenarioProject {
  projectId: string;
  beforeVnd: string;
  afterVnd: string;
}

export interface ScenarioResult {
  moves: ResolvedMove[];
  lines: ScenarioLine[];
  projects: ScenarioProject[];
  totalMovedVnd: string;
}

export interface LineBasis extends LineHold {
  projectId: string;
}

/**
 * The scenario applied to a copy of the lines: each line before and after, each project before and after, the total moved. A line that gives and receives ends with the difference. The limits are judged all together, and
 * what breaks them is listed (422 SCENARIO_CONSTRAINT_INFEASIBLE) with nothing kept. A project is shown with all it holds in the plan (`projectTotals`: the lines the moves do not touch count), not only the lines they name.
 */
export function simulate(moves: readonly ResolvedMove[], basis: ReadonlyMap<string, LineBasis>, constraints: ScenarioConstraints, projectTotals: ReadonlyMap<string, string>): ScenarioResult {
  const violations: ScenarioViolation[] = [];
  const net = new Map<string, string>();
  let total = '0';
  moves.forEach((move, index) => {
    if (constraints.maxMoveVnd !== null && compareDecimal(move.amountVnd, constraints.maxMoveVnd) > 0) violations.push({ kind: 'MOVE_ABOVE_LIMIT', move: index, amountVnd: move.amountVnd, limitVnd: constraints.maxMoveVnd });
    net.set(move.fromLineId, subtractDecimal(net.get(move.fromLineId) ?? '0', move.amountVnd));
    net.set(move.toLineId, addDecimal(net.get(move.toLineId) ?? '0', move.amountVnd));
    total = addDecimal(total, move.amountVnd);
  });
  if (constraints.maxTotalVnd !== null && compareDecimal(total, constraints.maxTotalVnd) > 0) violations.push({ kind: 'TOTAL_ABOVE_LIMIT', totalVnd: total, limitVnd: constraints.maxTotalVnd });
  const lines: ScenarioLine[] = [];
  for (const [lineId, change] of [...net].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const line = basis.get(lineId);
    if (line === undefined) throw new Error('a line of a scenario has a basis');
    const spoken = addDecimal(addDecimal(line.reservedVnd, line.committedVnd), line.disbursedVnd);
    // The minimum of the scenario is asked of the lines that lose; a line that gives nothing or only receives keeps what is spoken for on it.
    const losing = compareDecimal(change, '0') < 0;
    const minimum = losing && constraints.minRemainingVnd !== null && compareDecimal(constraints.minRemainingVnd, spoken) > 0 ? constraints.minRemainingVnd : spoken;
    const after = addDecimal(line.allocatedVnd, change);
    if (losing && compareDecimal(after, minimum) < 0) {
      violations.push({ kind: 'BELOW_MINIMUM', lineId, allocatedVnd: line.allocatedVnd, reducedVnd: subtractDecimal('0', change), minimumVnd: minimum });
    }
    lines.push({ lineId, projectId: line.projectId, beforeVnd: line.allocatedVnd, afterVnd: after, minimumVnd: minimum });
  }
  if (violations.length > 0) throw infeasible(violations);
  const changes = new Map<string, string>();
  for (const line of lines) changes.set(line.projectId, addDecimal(changes.get(line.projectId) ?? '0', subtractDecimal(line.afterVnd, line.beforeVnd)));
  const projects = new Map<string, ScenarioProject>();
  for (const [projectId, change] of changes) {
    const touched = lines.filter((line) => line.projectId === projectId).reduce((sum, line) => addDecimal(sum, line.beforeVnd), '0');
    // The lines the moves name are all there is to show only for a caller that does not know the rest of the project; the plan knows it.
    const before = projectTotals.get(projectId) ?? touched;
    projects.set(projectId, { projectId, beforeVnd: before, afterVnd: addDecimal(before, change) });
  }
  return { moves: [...moves], lines, projects: [...projects.values()].sort((a, b) => (a.projectId < b.projectId ? -1 : 1)), totalMovedVnd: total };
}

/** The refusal of a scenario that cannot be run: 422 SCENARIO_CONSTRAINT_INFEASIBLE, with each broken limit named. */
export function infeasible(violations: readonly ScenarioViolation[]): DomainError {
  return new DomainError('SCENARIO_CONSTRAINT_INFEASIBLE', 422, 'constraints', { extensions: { violations: violations.map(violationBody) } });
}

function violationBody(violation: ScenarioViolation): Record<string, unknown> {
  switch (violation.kind) {
    case 'NO_RECIPIENT_LINE':
      return { kind: violation.kind, move: violation.move, to_project_id: violation.toProjectId };
    case 'MOVE_ABOVE_LIMIT':
      return { kind: violation.kind, move: violation.move, amount_vnd: violation.amountVnd, limit_vnd: violation.limitVnd };
    case 'TOTAL_ABOVE_LIMIT':
      return { kind: violation.kind, total_vnd: violation.totalVnd, limit_vnd: violation.limitVnd };
    case 'BELOW_MINIMUM':
      return { kind: violation.kind, line_id: violation.lineId, allocated_vnd: violation.allocatedVnd, reduced_vnd: violation.reducedVnd, minimum_vnd: violation.minimumVnd };
  }
}

/** The result as it is kept in the scenario (`result_json`), in the shape the screen reads. */
export function resultJson(result: ScenarioResult, ranAt: string): Record<string, unknown> {
  return {
    ran_at: ranAt,
    total_moved_vnd: result.totalMovedVnd,
    moves: result.moves.map((move) => ({
      from_allocation_line_id: move.fromLineId,
      to_allocation_line_id: move.toLineId,
      from_project_id: move.fromProjectId,
      to_project_id: move.toProjectId,
      amount_vnd: move.amountVnd,
    })),
    lines: result.lines.map((line) => ({ allocation_line_id: line.lineId, project_id: line.projectId, before_vnd: line.beforeVnd, after_vnd: line.afterVnd, minimum_vnd: line.minimumVnd })),
    projects: result.projects.map((project) => ({ project_id: project.projectId, before_vnd: project.beforeVnd, after_vnd: project.afterVnd })),
  };
}

/**
 * A scenario can be run again until it is promoted; promoting needs a result. A scenario that was never run is 409 SCENARIO_NOT_RUN; one that was promoted (or archived) is final (409 STAGE_TRANSITION_DENIED).
 */
export function assertRunnable(status: ScenarioStatus): void {
  if (status !== 'DRAFT' && status !== 'RUN') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status', { extensions: { scenario_status: status } });
}

export function assertPromotable(status: ScenarioStatus): void {
  if (status === 'DRAFT') throw new DomainError('SCENARIO_NOT_RUN', 409, 'status');
  if (status !== 'RUN') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status', { extensions: { scenario_status: status } });
}

const PROPOSAL_PREFIX = 'SCN-';
const PROPOSAL_CODE_MAX = 50;

/** The code of the proposal a scenario becomes: the code of the scenario behind a prefix, shortened with a hash of the whole code when it would not fit. */
export function proposalCodeOf(scenarioCode: string): string {
  const whole = `${PROPOSAL_PREFIX}${scenarioCode}`;
  if (whole.length <= PROPOSAL_CODE_MAX) return whole;
  const hash = createHash('sha256').update(scenarioCode).digest('hex').slice(0, 8);
  return `${whole.slice(0, PROPOSAL_CODE_MAX - hash.length - 1)}-${hash}`;
}

/** The reason of the proposal: what it was drawn from. */
export function promotionReason(scenarioCode: string, moves: number, totalVnd: string): string {
  return `Promoted from the allocation scenario ${scenarioCode}: ${moves} move(s), ${totalVnd} VND in all.`;
}
