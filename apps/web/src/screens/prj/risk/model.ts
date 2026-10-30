import { ApiError } from '@machvon/api-client';

export const READ_PERMISSION = 'project.read';
export const MANAGE_PERMISSION = 'project.risk.manage';
/** The master types the group of a risk is chosen from. */
export const CATEGORY_TYPES = ['RISK_CATEGORY'] as const;

export const STATUSES = ['OPEN', 'MITIGATING', 'ESCALATED', 'ACCEPTED', 'CLOSED'] as const;
export type Status = (typeof STATUSES)[number];
/** The statuses a risk is written with; it ends through the closure. */
export const LIVE_STATUSES = ['OPEN', 'MITIGATING', 'ESCALATED'] as const;
export type LiveStatus = (typeof LIVE_STATUSES)[number];
export const ENDING_STATUSES = ['CLOSED', 'ACCEPTED'] as const;
export type EndingStatus = (typeof ENDING_STATUSES)[number];
export const LEVELS = ['LOW', 'MEDIUM', 'CRITICAL'] as const;
export type Level = (typeof LEVELS)[number];
/** The scale of the likelihood and of the impact. */
export const SCALE = [1, 2, 3, 4, 5] as const;

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const count = (value: unknown): number => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0);

export interface RiskView {
  id: string;
  code: string;
  categoryId: string;
  categoryLabel: string | null;
  title: string;
  description: string;
  likelihood: number;
  impact: number;
  score: number;
  level: Level;
  ownerId: string;
  ownerName: string | null;
  mitigation: string;
  dueDate: string;
  overdue: boolean;
  linkedIssueId: string | null;
  status: Status;
  closedReason: string | null;
  version: number;
}

/** One cell of the matrix: the score and the band are the server's. */
export interface Cell {
  likelihood: number;
  impact: number;
  score: number;
  level: Level;
  count: number;
}

export interface RiskPage {
  items: RiskView[];
  nextCursor: string | undefined;
  matrix: Cell[];
  liveCount: number;
  criticalCount: number;
  overdueCount: number;
}

const scaleOf = (value: unknown): number | undefined => (typeof value === 'number' && SCALE.some((step) => step === value) ? value : undefined);

function toRisk(raw: unknown): RiskView | undefined {
  const row = asRecord(raw);
  const owner = asRecord(row?.owner);
  const status = STATUSES.find((candidate) => candidate === row?.status);
  const level = LEVELS.find((candidate) => candidate === row?.level);
  const id = text(row?.id);
  const ownerId = text(owner?.membership_id);
  const likelihood = scaleOf(row?.likelihood);
  const impact = scaleOf(row?.impact);
  if (row === undefined || status === undefined || level === undefined || id === undefined || ownerId === undefined || likelihood === undefined || impact === undefined) return undefined;
  if (typeof row.score !== 'number' || typeof row.version !== 'number' || text(row.code) === undefined || text(row.due_date) === undefined) return undefined;
  return {
    id,
    code: text(row.code) ?? '',
    categoryId: text(row.category_master_version_id) ?? '',
    categoryLabel: nullableText(row.category_label),
    title: text(row.title) ?? '',
    description: text(row.description) ?? '',
    likelihood,
    impact,
    score: row.score,
    level,
    ownerId,
    ownerName: nullableText(owner?.display_name),
    mitigation: text(row.mitigation) ?? '',
    dueDate: text(row.due_date) ?? '',
    overdue: row.overdue === true,
    linkedIssueId: nullableText(row.linked_issue_id),
    status,
    closedReason: nullableText(row.closed_reason),
    version: row.version,
  };
}

function toCell(raw: unknown): Cell[] {
  const row = asRecord(raw);
  const likelihood = scaleOf(row?.likelihood);
  const impact = scaleOf(row?.impact);
  const level = LEVELS.find((candidate) => candidate === row?.level);
  if (row === undefined || likelihood === undefined || impact === undefined || level === undefined || typeof row.score !== 'number') return [];
  return [{ likelihood, impact, score: row.score, level, count: count(row.count) }];
}

export function toRiskPage(raw: unknown): RiskPage {
  const page = asRecord(raw);
  return {
    items: (Array.isArray(page?.items) ? page.items : []).flatMap((item) => toRisk(item) ?? []),
    nextCursor: text(page?.next_cursor),
    matrix: (Array.isArray(page?.matrix) ? page.matrix : []).flatMap(toCell),
    liveCount: count(page?.live_count),
    criticalCount: count(page?.critical_count),
    overdueCount: count(page?.overdue_count),
  };
}

type Mode = 'FULL' | 'READ_ONLY' | undefined;
export const holds = (permissions: readonly string[] | undefined, permission: string, mode: Mode): boolean => (permissions === undefined || permissions.includes(permission)) && mode !== 'READ_ONLY';

/** A risk that has not ended can be rewritten and ended. */
export const isLive = (status: Status): status is LiveStatus => LIVE_STATUSES.some((candidate) => candidate === status);

/** The statuses a live risk can be written with: where it is and further on, never back. */
export const movesFrom = (status: LiveStatus): readonly LiveStatus[] => LIVE_STATUSES.slice(LIVE_STATUSES.indexOf(status));

/** The cell of the matrix a likelihood and an impact fall in; none when the matrix was not read. */
export const cellOf = (matrix: readonly Cell[], likelihood: number, impact: number): Cell | undefined => matrix.find((cell) => cell.likelihood === likelihood && cell.impact === impact);

// ---- the forms ---------------------------------------------------------------------------------------------------------------

export type FormProblem = 'required' | 'invalid';
export type RiskField = 'code' | 'categoryId' | 'title' | 'description' | 'likelihood' | 'impact' | 'ownerId' | 'mitigation' | 'dueDate' | 'linkedIssueId';

export interface RiskForm {
  code: string;
  categoryId: string;
  title: string;
  description: string;
  likelihood: string;
  impact: string;
  ownerId: string;
  mitigation: string;
  dueDate: string;
  linkedIssueId: string;
  status: LiveStatus;
}

export const EMPTY_FORM: RiskForm = { code: '', categoryId: '', title: '', description: '', likelihood: '', impact: '', ownerId: '', mitigation: '', dueDate: '', linkedIssueId: '', status: 'OPEN' };

export const formOfRisk = (risk: RiskView): RiskForm => ({
  code: risk.code,
  categoryId: risk.categoryId,
  title: risk.title,
  description: risk.description,
  likelihood: String(risk.likelihood),
  impact: String(risk.impact),
  ownerId: risk.ownerId,
  mitigation: risk.mitigation,
  dueDate: risk.dueDate,
  linkedIssueId: risk.linkedIssueId ?? '',
  status: isLive(risk.status) ? risk.status : 'OPEN',
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (date: string): boolean => DATE.test(date) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;

/** The score the form would give, only as a preview: the server scores the risk. */
export function previewScore(form: Pick<RiskForm, 'likelihood' | 'impact'>): number | undefined {
  const likelihood = Number(form.likelihood);
  const impact = Number(form.impact);
  return SCALE.some((step) => step === likelihood) && SCALE.some((step) => step === impact) ? likelihood * impact : undefined;
}

const wordsOk = (value: string, min: number, max: number): boolean => value.trim().length >= min && value.trim().length <= max;

export function validateForm(form: RiskForm): Partial<Record<RiskField, FormProblem>> {
  const found: Partial<Record<RiskField, FormProblem>> = {};
  const fill = (field: RiskField, value: string, ok: boolean): void => {
    if (value.trim() === '') found[field] = 'required';
    else if (!ok) found[field] = 'invalid';
  };
  fill('code', form.code, CODE.test(form.code.trim()));
  fill('categoryId', form.categoryId, UUID.test(form.categoryId.trim()));
  fill('title', form.title, wordsOk(form.title, 3, 300));
  fill('description', form.description, wordsOk(form.description, 3, 2000));
  fill('likelihood', form.likelihood, SCALE.some((step) => String(step) === form.likelihood));
  fill('impact', form.impact, SCALE.some((step) => String(step) === form.impact));
  fill('ownerId', form.ownerId, UUID.test(form.ownerId.trim()));
  fill('mitigation', form.mitigation, wordsOk(form.mitigation, 3, 2000));
  fill('dueDate', form.dueDate, isDay(form.dueDate));
  if (form.linkedIssueId.trim() !== '' && !UUID.test(form.linkedIssueId.trim())) found.linkedIssueId = 'invalid';
  return found;
}

/** The body of a risk. A new risk starts open and says no status; a risk that is rewritten names the one it has. */
export function entryBody(form: RiskForm, withStatus: boolean): Record<string, unknown> {
  return {
    code: form.code.trim(),
    category_master_version_id: form.categoryId.trim(),
    title: form.title.trim(),
    description: form.description.trim(),
    likelihood: Number(form.likelihood),
    impact: Number(form.impact),
    owner_membership_id: form.ownerId.trim(),
    mitigation: form.mitigation.trim(),
    due_date: form.dueDate,
    ...(form.linkedIssueId.trim() === '' ? {} : { linked_issue_id: form.linkedIssueId.trim() }),
    ...(withStatus ? { status: form.status } : {}),
  };
}

export interface ClosureForm {
  status: EndingStatus;
  reason: string;
}

export const EMPTY_CLOSURE: ClosureForm = { status: 'CLOSED', reason: '' };

export function validateClosure(form: ClosureForm): FormProblem | undefined {
  const reason = form.reason.trim();
  if (reason === '') return 'required';
  return reason.length < 10 || reason.length > 2000 ? 'invalid' : undefined;
}

export const closureBody = (form: ClosureForm): Record<string, unknown> => ({ status: form.status, closed_reason: form.reason.trim() });

// ---- what the server refuses ---------------------------------------------------------------------------------------------------

export type RiskProblem = 'codeDuplicate' | 'stateInvalid' | 'versionConflict' | 'scopeDenied' | 'validation' | 'notFound' | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, RiskProblem>> = {
  RISK_CODE_DUPLICATE: 'codeDuplicate',
  RISK_STATE_INVALID: 'stateInvalid',
  VERSION_CONFLICT: 'versionConflict',
  SCOPE_DENIED: 'scopeDenied',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
};

export const describeRisk = (error: unknown): RiskProblem => (error instanceof ApiError ? (PROBLEM_BY_CODE[error.code] ?? 'general') : 'general');
