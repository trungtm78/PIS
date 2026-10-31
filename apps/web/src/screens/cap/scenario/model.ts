import { ApiError } from '@machvon/api-client';

export const READ_PERMISSION = 'capital.read';
export const RUN_PERMISSION = 'capital.scenario.run';
export const PROMOTE_PERMISSION = 'capital.reallocation.propose';

export const STATUSES = ['DRAFT', 'RUN', 'PROMOTED', 'ARCHIVED'] as const;
export type Status = (typeof STATUSES)[number];

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const MONEY = /^[0-9]+$/;
const money = (value: unknown): string | undefined => (typeof value === 'string' && MONEY.test(value) ? value : undefined);

export interface MoveView {
  fromAllocationLineId: string;
  toProjectId: string;
  amountVnd: string;
  note: string;
}

export interface ResultLine {
  lineId: string;
  projectId: string;
  beforeVnd: string;
  afterVnd: string;
  minimumVnd: string;
}

export interface ResultProject {
  projectId: string;
  beforeVnd: string;
  afterVnd: string;
}

export interface ResultView {
  ranAt: string;
  totalMovedVnd: string;
  lines: ResultLine[];
  projects: ResultProject[];
}

export interface ScenarioView {
  id: string;
  code: string;
  planYear: number;
  planCode: string;
  scopeUnitName: string;
  snapshotId: string | null;
  minRemainingVnd: string | null;
  maxMoveVnd: string | null;
  maxTotalVnd: string | null;
  moves: MoveView[];
  result: ResultView | null;
  status: Status;
  promotedProposalId: string | null;
  mayRun: boolean;
  mayPromote: boolean;
  version: number;
}

export interface ScenarioPage {
  items: ScenarioView[];
  nextCursor: string | undefined;
}

function toMove(raw: unknown): MoveView | undefined {
  const row = asRecord(raw);
  const from = text(row?.from_allocation_line_id);
  const to = text(row?.to_project_id);
  const amount = money(row?.amount_vnd);
  return row === undefined || from === undefined || to === undefined || amount === undefined ? undefined : { fromAllocationLineId: from, toProjectId: to, amountVnd: amount, note: text(row.rationale) ?? '' };
}

function toResult(raw: unknown): ResultView | null {
  const row = asRecord(raw);
  const total = money(row?.total_moved_vnd);
  if (row === undefined || total === undefined) return null;
  const lines = (Array.isArray(row.lines) ? row.lines : []).flatMap((entry): ResultLine[] => {
    const line = asRecord(entry);
    const lineId = text(line?.allocation_line_id);
    const projectId = text(line?.project_id);
    const before = money(line?.before_vnd);
    const after = money(line?.after_vnd);
    return line === undefined || lineId === undefined || projectId === undefined || before === undefined || after === undefined ? [] : [{ lineId, projectId, beforeVnd: before, afterVnd: after, minimumVnd: money(line.minimum_vnd) ?? '0' }];
  });
  const projects = (Array.isArray(row.projects) ? row.projects : []).flatMap((entry): ResultProject[] => {
    const project = asRecord(entry);
    const projectId = text(project?.project_id);
    const before = money(project?.before_vnd);
    const after = money(project?.after_vnd);
    return project === undefined || projectId === undefined || before === undefined || after === undefined ? [] : [{ projectId, beforeVnd: before, afterVnd: after }];
  });
  return { ranAt: text(row.ran_at) ?? '', totalMovedVnd: total, lines, projects };
}

function toScenario(raw: unknown): ScenarioView | undefined {
  const row = asRecord(raw);
  const status = STATUSES.find((candidate) => candidate === row?.status);
  const id = text(row?.id);
  const code = text(row?.code);
  const plan = asRecord(row?.base_capital_plan);
  if (row === undefined || status === undefined || id === undefined || code === undefined || typeof row.version !== 'number' || typeof row.plan_year !== 'number') return undefined;
  const constraints = asRecord(row.constraints) ?? {};
  const actions = asRecord(row.actions) ?? {};
  return {
    id,
    code,
    planYear: row.plan_year,
    planCode: text(plan?.plan_code) ?? '',
    scopeUnitName: text(asRecord(plan?.scope_unit)?.name) ?? '',
    snapshotId: text(row.input_snapshot_id) ?? null,
    minRemainingVnd: money(constraints.min_remaining_vnd) ?? null,
    maxMoveVnd: money(constraints.max_move_vnd) ?? null,
    maxTotalVnd: money(constraints.max_total_vnd) ?? null,
    moves: (Array.isArray(asRecord(row.assumptions)?.moves) ? (asRecord(row.assumptions)?.moves as unknown[]) : []).flatMap((move) => toMove(move) ?? []),
    result: toResult(row.result),
    status,
    promotedProposalId: text(row.promoted_proposal_id) ?? null,
    mayRun: actions.run === true,
    mayPromote: actions.promote === true,
    version: row.version,
  };
}

export function toScenarioPage(raw: unknown): ScenarioPage {
  const page = asRecord(raw);
  return { items: (Array.isArray(page?.items) ? page.items : []).flatMap((item) => toScenario(item) ?? []), nextCursor: text(page?.next_cursor) };
}

type Mode = 'FULL' | 'READ_ONLY' | undefined;
export const holds = (permissions: readonly string[] | undefined, permission: string, mode: Mode): boolean => (permissions === undefined || permissions.includes(permission)) && mode !== 'READ_ONLY';

/** The change of a project in the result: what it gains or loses, as an exact whole number. */
export const changeOf = (project: Pick<ResultProject, 'beforeVnd' | 'afterVnd'>): bigint => BigInt(project.afterVnd) - BigInt(project.beforeVnd);

// ---- the form ------------------------------------------------------------------------------------------------------------------

export type FormProblem = 'required' | 'invalid' | 'same' | 'duplicate';

export interface MoveForm {
  fromLineId: string;
  toProjectId: string;
  amount: string;
  note: string;
}

export interface ScenarioForm {
  code: string;
  planId: string;
  snapshotId: string;
  minRemaining: string;
  maxMove: string;
  maxTotal: string;
  moves: MoveForm[];
}

export const EMPTY_MOVE: MoveForm = { fromLineId: '', toProjectId: '', amount: '', note: '' };
export const EMPTY_FORM: ScenarioForm = { code: '', planId: '', snapshotId: '', minRemaining: '', maxMove: '', maxTotal: '', moves: [{ ...EMPTY_MOVE }] };

export interface FormProblems {
  code?: FormProblem;
  planId?: FormProblem;
  minRemaining?: FormProblem;
  maxMove?: FormProblem;
  maxTotal?: FormProblem;
  moves: Array<{ fromLineId?: FormProblem; toProjectId?: FormProblem; amount?: FormProblem }>;
}

const POSITIVE = /^[1-9][0-9]{0,23}$/;
const WHOLE = /^(0|[1-9][0-9]{0,23})$/;

/** The donor line's project, to tell a move to the same project before the server does. */
export function validateForm(form: ScenarioForm, projectOfLine: (lineId: string) => string | undefined): FormProblems {
  const found: FormProblems = { moves: [] };
  const code = form.code.trim();
  if (code === '') found.code = 'required';
  else if (code.length > 50) found.code = 'invalid';
  if (form.planId === '') found.planId = 'required';
  if (form.minRemaining.trim() !== '' && !WHOLE.test(form.minRemaining.trim())) found.minRemaining = 'invalid';
  if (form.maxMove.trim() !== '' && !POSITIVE.test(form.maxMove.trim())) found.maxMove = 'invalid';
  if (form.maxTotal.trim() !== '' && !POSITIVE.test(form.maxTotal.trim())) found.maxTotal = 'invalid';
  const seen = new Set<string>();
  found.moves = form.moves.map((move) => {
    const problem: FormProblems['moves'][number] = {};
    if (move.fromLineId === '') problem.fromLineId = 'required';
    if (move.toProjectId === '') problem.toProjectId = 'required';
    else if (projectOfLine(move.fromLineId) === move.toProjectId) problem.toProjectId = 'same';
    if (move.amount.trim() === '') problem.amount = 'required';
    else if (!POSITIVE.test(move.amount.trim())) problem.amount = 'invalid';
    const key = `${move.fromLineId}|${move.toProjectId}`;
    if (move.fromLineId !== '' && move.toProjectId !== '') {
      if (seen.has(key)) problem.fromLineId = 'duplicate';
      seen.add(key);
    }
    return problem;
  });
  return found;
}

export const hasProblems = (problems: FormProblems): boolean =>
  problems.code !== undefined || problems.planId !== undefined || problems.minRemaining !== undefined || problems.maxMove !== undefined || problems.maxTotal !== undefined || problems.moves.some((move) => Object.keys(move).length > 0);

export function scenarioBody(form: ScenarioForm, plan: { id: string; planYear: number }): Record<string, unknown> {
  return {
    code: form.code.trim(),
    plan_year: plan.planYear,
    base_capital_plan_id: plan.id,
    ...(form.snapshotId === '' ? {} : { input_snapshot_id: form.snapshotId }),
    constraints: {
      ...(form.minRemaining.trim() === '' ? {} : { min_remaining_vnd: form.minRemaining.trim() }),
      ...(form.maxMove.trim() === '' ? {} : { max_move_vnd: form.maxMove.trim() }),
      ...(form.maxTotal.trim() === '' ? {} : { max_total_vnd: form.maxTotal.trim() }),
    },
    assumptions: {
      moves: form.moves.map((move) => ({
        from_allocation_line_id: move.fromLineId,
        to_project_id: move.toProjectId,
        amount_vnd: move.amount.trim(),
        ...(move.note.trim() === '' ? {} : { rationale: move.note.trim() }),
      })),
    },
  };
}

// ---- what the server refuses ---------------------------------------------------------------------------------------------------

export type ScenarioProblem =
  | 'infeasible'
  | 'notRun'
  | 'snapshotNotFrozen'
  | 'belowCommitted'
  | 'planNotPublished'
  | 'versionConflict'
  | 'stageDenied'
  | 'duplicate'
  | 'scopeDenied'
  | 'validation'
  | 'notFound'
  | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, ScenarioProblem>> = {
  SCENARIO_CONSTRAINT_INFEASIBLE: 'infeasible',
  SCENARIO_NOT_RUN: 'notRun',
  SNAPSHOT_NOT_FROZEN: 'snapshotNotFrozen',
  REVISED_BELOW_COMMITTED: 'belowCommitted',
  PLAN_NOT_PUBLISHED: 'planNotPublished',
  VERSION_CONFLICT: 'versionConflict',
  STAGE_TRANSITION_DENIED: 'stageDenied',
  DUPLICATE_KEY: 'duplicate',
  SCOPE_DENIED: 'scopeDenied',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
};

export const describeScenario = (error: unknown): ScenarioProblem => (error instanceof ApiError ? (PROBLEM_BY_CODE[error.code] ?? 'general') : 'general');

/** The kinds of limit an infeasible run says it broke, in the order the server listed them. */
export function violationsOf(error: unknown): string[] {
  if (!(error instanceof ApiError)) return [];
  const list = error.extensions.violations;
  return (Array.isArray(list) ? list : []).flatMap((entry) => text(asRecord(entry)?.kind) ?? []);
}
