import { ApiError } from '@machvon/api-client';
import { FROZEN_STATUSES, PROJECT_STATUSES } from './model';
import type { ProjectStatus } from './model';

/** The project bank PRJ-14: a board with a column for each stage of the PIMA life cycle, and the guarded commands that move a project between them. */
export const BOARD_PATH = '/prj/prj-14';
export const BOARD_PAGE_SIZE = 20;

/** The stages that have a column when the board opens; the three that a project does not leave open on request. */
export const OPEN_STAGES: readonly ProjectStatus[] = PROJECT_STATUSES.filter((stage) => !FROZEN_STATUSES.includes(stage));
export const ENDED_STAGES: readonly ProjectStatus[] = FROZEN_STATUSES;

export const PROJECT_GROUPS = ['QTQG', 'A', 'B', 'C'] as const;
export type ProjectGroup = (typeof PROJECT_GROUPS)[number];

/** The commands that move a project, with the permission each needs (the server judges the same permission again). */
export const STAGE_OPERATIONS = ['startProjectImplementation', 'suspendProject', 'resumeProject', 'completeProject', 'closeProject', 'cancelProject'] as const;
export type StageOperation = (typeof STAGE_OPERATIONS)[number];
export const STAGE_PERMISSIONS: Readonly<Record<StageOperation, string>> = {
  startProjectImplementation: 'project.stage.implement',
  suspendProject: 'project.stage.suspend',
  resumeProject: 'project.stage.suspend',
  completeProject: 'project.stage.complete',
  closeProject: 'project.stage.close',
  cancelProject: 'project.stage.cancel',
};

export const REASON_MIN_LENGTH = 5;
export const REASON_MAX_LENGTH = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
/** A calendar date that reads back as typed: the 30th of February is read by the engine as a later day, so it is not one. */
function isCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return DATE.test(value) && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
const isStage = (value: string): value is ProjectStatus => (PROJECT_STATUSES as readonly string[]).includes(value);

// ---- the cards ----------------------------------------------------------------------------------------------------------

/** One card of a column: collapsed to the figures that decide the next step. */
export interface BoardCard {
  id: string;
  code: string;
  name: string;
  status: ProjectStatus;
  projectGroup: string | null;
  appraisalScore: string | null;
  totalInvestmentVnd: string;
  nationalProjectCode: string | null;
  /** For a project in the pipeline: whether it has what a capital plan needs of it; null in the other stages. */
  capitalReady: boolean | null;
  leaderName: string | null;
  version: number;
}

export function toBoardCard(raw: unknown): BoardCard | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const code = text(row?.code);
  const name = text(row?.name);
  const status = text(row?.status);
  const total = text(row?.total_investment_vnd);
  const version = whole(row?.version);
  if (row === undefined || id === undefined || code === undefined || name === undefined || status === undefined || !isStage(status) || total === undefined || version === undefined) return undefined;
  const leader = asRecord(row.leader_in_charge);
  return {
    id,
    code,
    name,
    status,
    projectGroup: nullableText(row.project_group),
    appraisalScore: nullableText(row.appraisal_score),
    totalInvestmentVnd: total,
    nationalProjectCode: nullableText(row.national_project_code),
    capitalReady: typeof row.capital_ready === 'boolean' ? row.capital_ready : null,
    leaderName: leader === undefined ? null : nullableText(leader.display_name),
    version,
  };
}

/** A page of a column: the cards, how many projects the stage has in the scope of the caller, and the cursor of the next page. */
export interface BoardPage {
  cards: BoardCard[];
  total: number;
  nextCursor: string | null;
}

export function toBoardPage(raw: unknown): BoardPage {
  const body = asRecord(raw);
  const items = Array.isArray(body?.items) ? body.items : [];
  return {
    cards: items.flatMap((item) => toBoardCard(item) ?? []),
    total: whole(body?.total) ?? 0,
    nextCursor: nullableText(body?.next_cursor),
  };
}

/** The cards of all the pages read so far, in the order the server ranked them. */
export const cardsOf = (pages: readonly BoardPage[]): BoardCard[] => pages.flatMap((page) => page.cards);

// ---- the lifecycle ------------------------------------------------------------------------------------------------------

export type GuardKey = 'DECISION_DOCUMENT' | 'INVESTMENT_DECISION_DOCUMENT' | 'NATIONAL_CODE' | 'OPEN_OBLIGATIONS';
export type GuardState = 'MET' | 'UNMET' | 'WARNING' | 'INPUT_REQUIRED';
const GUARD_KEYS: readonly string[] = ['DECISION_DOCUMENT', 'INVESTMENT_DECISION_DOCUMENT', 'NATIONAL_CODE', 'OPEN_OBLIGATIONS'];
const GUARD_STATES: readonly string[] = ['MET', 'UNMET', 'WARNING', 'INPUT_REQUIRED'];

export interface GuardView {
  key: GuardKey;
  state: GuardState;
}

/** A move open from the stage of the project: the command, where it leads, whether the caller may make it and the state of its guards. */
export interface NextMove {
  operation: StageOperation;
  to: ProjectStatus;
  allowed: boolean;
  guards: GuardView[];
}

export interface HistoryLine {
  from: ProjectStatus;
  to: ProjectStatus;
  actorKind: 'USER' | 'SYSTEM';
  actorName: string | null;
  reason: string | null;
  occurredAt: string;
}

export interface Lifecycle {
  projectId: string;
  code: string;
  status: ProjectStatus;
  version: number;
  nationalProjectCode: string | null;
  history: HistoryLine[];
  next: NextMove[];
}

function toGuard(raw: unknown): GuardView[] {
  const row = asRecord(raw);
  const key = text(row?.key);
  const state = text(row?.state);
  return key !== undefined && state !== undefined && GUARD_KEYS.includes(key) && GUARD_STATES.includes(state) ? [{ key: key as GuardKey, state: state as GuardState }] : [];
}

function toMove(raw: unknown): NextMove[] {
  const row = asRecord(raw);
  const operation = text(row?.operation);
  const to = text(row?.to);
  if (row === undefined || operation === undefined || to === undefined || !(STAGE_OPERATIONS as readonly string[]).includes(operation) || !isStage(to)) return [];
  return [{ operation: operation as StageOperation, to, allowed: row.allowed === true, guards: (Array.isArray(row.guards) ? row.guards : []).flatMap(toGuard) }];
}

function toHistoryLine(raw: unknown): HistoryLine[] {
  const row = asRecord(raw);
  const from = text(row?.from);
  const to = text(row?.to);
  const kind = text(row?.actor_kind);
  if (row === undefined || from === undefined || to === undefined || !isStage(from) || !isStage(to) || (kind !== 'USER' && kind !== 'SYSTEM')) return [];
  return [{ from, to, actorKind: kind, actorName: nullableText(row.actor_name), reason: nullableText(row.reason), occurredAt: text(row.occurred_at) ?? '' }];
}

export function toLifecycle(raw: unknown): Lifecycle | undefined {
  const body = asRecord(raw);
  const projectId = text(body?.project_id);
  const code = text(body?.code);
  const status = text(body?.status);
  const version = whole(body?.version);
  if (body === undefined || projectId === undefined || code === undefined || status === undefined || !isStage(status) || version === undefined) return undefined;
  return {
    projectId,
    code,
    status,
    version,
    nationalProjectCode: nullableText(body.national_project_code),
    history: (Array.isArray(body.history) ? body.history : []).flatMap(toHistoryLine),
    next: (Array.isArray(body.next) ? body.next : []).flatMap(toMove),
  };
}

// ---- the confirmation ---------------------------------------------------------------------------------------------------

/** Whether the caller may open the confirmation at all: a stage permission, and a session that is not read-only. */
export function canOpenMoves(permissions: readonly string[] | undefined, mode: 'FULL' | 'READ_ONLY' | undefined): boolean {
  if (mode === 'READ_ONLY') return false;
  return permissions === undefined || Object.values(STAGE_PERMISSIONS).some((permission) => permissions.includes(permission));
}

/** The moves the caller may make, in the order the server gave them: a move the caller may not make is not offered. */
export const offeredMoves = (lifecycle: Lifecycle): NextMove[] => lifecycle.next.filter((move) => move.allowed);

/** The guards that refuse the move as it stands (the server refuses it with the same reason). */
export const unmetGuards = (move: NextMove): GuardView[] => move.guards.filter((guard) => guard.state === 'UNMET');

/** The guards that the person supplies with the command: the document the decision rests on. */
export const inputGuards = (move: NextMove): GuardView[] => move.guards.filter((guard) => guard.state === 'INPUT_REQUIRED');

export const warningGuards = (move: NextMove): GuardView[] => move.guards.filter((guard) => guard.state === 'WARNING');

/** The field of the command body that a document guard fills. */
export function documentFieldOf(guard: GuardKey): 'decision_document_id' | 'investment_decision_document_id' | undefined {
  if (guard === 'DECISION_DOCUMENT') return 'decision_document_id';
  return guard === 'INVESTMENT_DECISION_DOCUMENT' ? 'investment_decision_document_id' : undefined;
}

export interface StageForm {
  reason: string;
  documentId: string;
  effectiveDate: string;
}

export const EMPTY_STAGE_FORM: StageForm = { reason: '', documentId: '', effectiveDate: '' };

export type StageFieldProblem = 'reasonRequired' | 'reasonShort' | 'reasonLong' | 'documentRequired' | 'documentInvalid' | 'dateInvalid';

/** What is wrong with the form of a move before anything is sent; the server judges the same rules again. */
export function validateStageForm(move: NextMove, form: StageForm): Partial<Record<keyof StageForm, StageFieldProblem>> {
  const problems: Partial<Record<keyof StageForm, StageFieldProblem>> = {};
  const reason = form.reason.trim();
  if (reason === '') problems.reason = 'reasonRequired';
  else if (reason.length < REASON_MIN_LENGTH) problems.reason = 'reasonShort';
  else if (reason.length > REASON_MAX_LENGTH) problems.reason = 'reasonLong';
  const document = form.documentId.trim();
  if (inputGuards(move).length > 0 && document === '') problems.documentId = 'documentRequired';
  else if (document !== '' && !UUID.test(document)) problems.documentId = 'documentInvalid';
  if (form.effectiveDate !== '' && !isCalendarDate(form.effectiveDate)) problems.effectiveDate = 'dateInvalid';
  return problems;
}

export interface StageBody {
  reason: string;
  decision_document_id?: string;
  investment_decision_document_id?: string;
  effective_date?: string;
}

/** The body of a stage command for a form that passed `validateStageForm`: what was left empty is not sent. */
export function stageBody(move: NextMove, form: StageForm): StageBody {
  const body: StageBody = { reason: form.reason.trim() };
  const document = form.documentId.trim();
  const field = move.guards.map((guard) => documentFieldOf(guard.key)).find((candidate) => candidate !== undefined);
  if (document !== '' && field !== undefined) body[field] = document.toLowerCase();
  if (form.effectiveDate !== '') body.effective_date = form.effectiveDate;
  return body;
}

// ---- refusals -----------------------------------------------------------------------------------------------------------

export type StageProblemReason =
  | 'transitionDenied'
  | 'decisionRequired'
  | 'nationalCodeRequired'
  | 'nationalCodeFormat'
  | 'openObligations'
  | 'versionConflict'
  | 'validation'
  | 'notFound'
  | 'denied'
  | 'general';

const REASON_BY_CODE: Readonly<Record<string, StageProblemReason>> = {
  STAGE_TRANSITION_DENIED: 'transitionDenied',
  DECISION_REQUIRED: 'decisionRequired',
  NATIONAL_CODE_REQUIRED: 'nationalCodeRequired',
  NATIONAL_CODE_FORMAT_INVALID: 'nationalCodeFormat',
  OPEN_OBLIGATIONS_EXIST: 'openObligations',
  VERSION_CONFLICT: 'versionConflict',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  FIELD_NOT_ALLOWED: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
};

/** Maps the error of a stage command to what the confirmation shows; an unknown failure is the general message. */
export function describeStageProblem(error: unknown): StageProblemReason {
  return error instanceof ApiError ? (REASON_BY_CODE[error.code] ?? 'general') : 'general';
}
