import { ApiError } from '@machvon/api-client';

export const READ_PERMISSION = 'capital.read';
export const PROPOSE_PERMISSION = 'capital.reallocation.propose';
export const APPROVE_PERMISSION = 'capital.reallocation.approve';
export const APPLY_PERMISSION = 'capital.reallocation.apply';

export const STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'APPLIED', 'REJECTED', 'WITHDRAWN'] as const;
export type Status = (typeof STATUSES)[number];
export const DECISIONS = ['approve', 'reject', 'return'] as const;
export type Decision = (typeof DECISIONS)[number];

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const MONEY = /^[0-9]+$/;
const money = (value: unknown): string | undefined => (typeof value === 'string' && MONEY.test(value) ? value : undefined);

export interface ProjectRef {
  id: string;
  code: string;
  name: string;
}

export interface LineView {
  id: string;
  fromAllocationLineId: string;
  toAllocationLineId: string | null;
  fromProject: ProjectRef;
  toProject: ProjectRef;
  amountVnd: string;
  fromAllocatedVnd: string;
  toAllocatedVnd: string;
  note: string;
}

export interface ProposalView {
  id: string;
  code: string;
  planYear: number;
  scopeUnitName: string;
  basisSnapshotId: string;
  sourceCapitalPlanId: string;
  reason: string;
  status: Status;
  decisionDocumentId: string | null;
  resultingCapitalPlanId: string | null;
  submittedBy: string | null;
  createdBy: string;
  decisionReason: string | null;
  version: number;
  totalVnd: string;
  lines: LineView[];
}

export interface ProposalPage {
  items: ProposalView[];
  nextCursor: string | undefined;
}

function toProject(value: unknown): ProjectRef | undefined {
  const row = asRecord(value);
  const id = text(row?.id);
  return row === undefined || id === undefined ? undefined : { id, code: text(row.code) ?? '', name: text(row.name) ?? '' };
}

function toLine(raw: unknown): LineView | undefined {
  const row = asRecord(raw);
  const fromProject = toProject(row?.from_project);
  const toTarget = toProject(row?.to_project);
  const id = text(row?.id);
  const from = text(row?.from_allocation_line_id);
  const amount = money(row?.amount_vnd);
  if (row === undefined || fromProject === undefined || toTarget === undefined || id === undefined || from === undefined || amount === undefined) return undefined;
  return {
    id,
    fromAllocationLineId: from,
    toAllocationLineId: text(row.to_allocation_line_id) ?? null,
    fromProject,
    toProject: toTarget,
    amountVnd: amount,
    fromAllocatedVnd: money(row.from_allocated_vnd) ?? '0',
    toAllocatedVnd: money(row.to_allocated_vnd) ?? '0',
    note: text(asRecord(row.rationale)?.note) ?? '',
  };
}

function toProposal(raw: unknown): ProposalView | undefined {
  const row = asRecord(raw);
  const status = STATUSES.find((candidate) => candidate === row?.status);
  const id = text(row?.id);
  const code = text(row?.code);
  const createdBy = text(row?.created_by);
  if (row === undefined || status === undefined || id === undefined || code === undefined || createdBy === undefined || typeof row.version !== 'number' || typeof row.plan_year !== 'number') return undefined;
  return {
    id,
    code,
    planYear: row.plan_year,
    scopeUnitName: text(asRecord(row.scope_unit)?.name) ?? '',
    basisSnapshotId: text(row.basis_snapshot_id) ?? '',
    sourceCapitalPlanId: text(row.source_capital_plan_id) ?? '',
    reason: text(row.reason) ?? '',
    status,
    decisionDocumentId: nullableText(row.decision_document_id),
    resultingCapitalPlanId: nullableText(row.resulting_capital_plan_id),
    submittedBy: nullableText(row.submitted_by),
    createdBy,
    decisionReason: nullableText(row.decision_reason),
    version: row.version,
    totalVnd: money(row.total_vnd) ?? '0',
    lines: (Array.isArray(row.lines) ? row.lines : []).flatMap((line) => toLine(line) ?? []),
  };
}

export function toProposalPage(raw: unknown): ProposalPage {
  const page = asRecord(raw);
  return { items: (Array.isArray(page?.items) ? page.items : []).flatMap((item) => toProposal(item) ?? []), nextCursor: text(page?.next_cursor) };
}

type Mode = 'FULL' | 'READ_ONLY' | undefined;
export const holds = (permissions: readonly string[] | undefined, permission: string, mode: Mode): boolean => (permissions === undefined || permissions.includes(permission)) && mode !== 'READ_ONLY';

export const canSubmit = (proposal: Pick<ProposalView, 'status'>): boolean => proposal.status === 'DRAFT';
/** A proposal waits for someone who is neither its author nor its submitter. */
export const canDecide = (proposal: Pick<ProposalView, 'status' | 'createdBy' | 'submittedBy'>, membershipId: string | undefined): boolean =>
  proposal.status === 'SUBMITTED' && (membershipId === undefined || (proposal.createdBy !== membershipId && proposal.submittedBy !== membershipId));
/** The application is for an approved proposal, by someone who is neither its author nor its submitter. */
export const canApply = (proposal: Pick<ProposalView, 'status' | 'createdBy' | 'submittedBy'>, membershipId: string | undefined): boolean =>
  proposal.status === 'APPROVED' && (membershipId === undefined || (proposal.createdBy !== membershipId && proposal.submittedBy !== membershipId));

type Moving = Pick<LineView, 'amountVnd' | 'fromAllocatedVnd' | 'toAllocatedVnd' | 'fromAllocationLineId' | 'toAllocationLineId' | 'toProject'>;

/**
 * What the proposal leaves on each line of the plan, as exact whole numbers: all the moves that touch one line are added up before the figure is shown (a donor that gives twice ends with its amount less both, a line
 * that receives and gives ends with the difference), so the screen shows the revision that will be published. A recipient line that is not named is told by its project.
 */
export function finalAmounts(lines: readonly Moving[]): { fromAfter(line: Moving): string; toAfter(line: Moving): string } {
  const toKey = (line: Moving): string => line.toAllocationLineId ?? `project:${line.toProject.id}`;
  const start = new Map<string, bigint>();
  const change = new Map<string, bigint>();
  for (const line of lines) {
    const move = BigInt(line.amountVnd);
    start.set(line.fromAllocationLineId, start.get(line.fromAllocationLineId) ?? BigInt(line.fromAllocatedVnd));
    start.set(toKey(line), start.get(toKey(line)) ?? BigInt(line.toAllocatedVnd));
    change.set(line.fromAllocationLineId, (change.get(line.fromAllocationLineId) ?? 0n) - move);
    change.set(toKey(line), (change.get(toKey(line)) ?? 0n) + move);
  }
  const after = (key: string): string => ((start.get(key) ?? 0n) + (change.get(key) ?? 0n)).toString();
  return { fromAfter: (line) => after(line.fromAllocationLineId), toAfter: (line) => after(toKey(line)) };
}

/** What leaves the donors and what reaches the recipients: they are the same number, which is the balance footer of the screen. */
export function balanceOf(lines: readonly Pick<LineView, 'amountVnd'>[]): { reducedVnd: string; increasedVnd: string; balanced: boolean } {
  const total = lines.reduce((sum, line) => sum + BigInt(line.amountVnd), 0n).toString();
  return { reducedVnd: total, increasedVnd: total, balanced: true };
}

// ---- the drafting form ---------------------------------------------------------------------------------------------------------

export type FormProblem = 'required' | 'invalid' | 'same' | 'duplicate';

export interface DraftLineForm {
  fromLineId: string;
  toProjectId: string;
  amount: string;
  note: string;
}

export interface DraftForm {
  code: string;
  planId: string;
  snapshotId: string;
  reason: string;
  lines: DraftLineForm[];
}

export const EMPTY_LINE: DraftLineForm = { fromLineId: '', toProjectId: '', amount: '', note: '' };
export const EMPTY_DRAFT: DraftForm = { code: '', planId: '', snapshotId: '', reason: '', lines: [{ ...EMPTY_LINE }] };

export interface DraftProblems {
  code?: FormProblem;
  planId?: FormProblem;
  snapshotId?: FormProblem;
  reason?: FormProblem;
  lines: Array<{ fromLineId?: FormProblem; toProjectId?: FormProblem; amount?: FormProblem }>;
}

/** The donor line's project, to tell a move to the same project before the server does. */
export function validateDraft(form: DraftForm, projectOfLine: (lineId: string) => string | undefined): DraftProblems {
  const found: DraftProblems = { lines: [] };
  const code = form.code.trim();
  if (code === '') found.code = 'required';
  else if (code.length > 50) found.code = 'invalid';
  if (form.planId === '') found.planId = 'required';
  if (form.snapshotId === '') found.snapshotId = 'required';
  const reason = form.reason.trim();
  if (reason === '') found.reason = 'required';
  else if (reason.length < 20 || reason.length > 2000) found.reason = 'invalid';
  const seen = new Set<string>();
  found.lines = form.lines.map((line) => {
    const problem: DraftProblems['lines'][number] = {};
    if (line.fromLineId === '') problem.fromLineId = 'required';
    if (line.toProjectId === '') problem.toProjectId = 'required';
    else if (projectOfLine(line.fromLineId) === line.toProjectId) problem.toProjectId = 'same';
    if (line.amount.trim() === '') problem.amount = 'required';
    else if (!/^[1-9][0-9]{0,23}$/.test(line.amount.trim())) problem.amount = 'invalid';
    const key = `${line.fromLineId}|${line.toProjectId}`;
    if (line.fromLineId !== '' && line.toProjectId !== '') {
      if (seen.has(key)) problem.fromLineId = 'duplicate';
      seen.add(key);
    }
    return problem;
  });
  return found;
}

export const hasProblems = (problems: DraftProblems): boolean =>
  problems.code !== undefined || problems.planId !== undefined || problems.snapshotId !== undefined || problems.reason !== undefined || problems.lines.some((line) => Object.keys(line).length > 0);

export function draftBody(form: DraftForm, plan: { id: string; planYear: number; scopeUnitId: string }): Record<string, unknown> {
  return {
    code: form.code.trim(),
    plan_year: plan.planYear,
    scope_unit_id: plan.scopeUnitId,
    basis_snapshot_id: form.snapshotId,
    source_capital_plan_id: plan.id,
    reason: form.reason.trim(),
    lines: form.lines.map((line) => ({
      from_allocation_line_id: line.fromLineId,
      to_project_id: line.toProjectId,
      amount_vnd: line.amount.trim(),
      ...(line.note.trim() === '' ? {} : { rationale: line.note.trim() }),
    })),
  };
}

export function validateDecision(reason: string): FormProblem | undefined {
  const trimmed = reason.trim();
  if (trimmed === '') return 'required';
  return trimmed.length < 5 || trimmed.length > 2000 ? 'invalid' : undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateDocument(value: string): FormProblem | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return 'required';
  return UUID.test(trimmed) ? undefined : 'invalid';
}

// ---- what the server refuses ---------------------------------------------------------------------------------------------------

export type ReallocationProblem = 'unbalanced' | 'belowCommitted' | 'snapshotNotFrozen' | 'planChanged' | 'pendingRevision' | 'selfApproval' | 'versionConflict' | 'stageDenied' | 'documentRequired' | 'duplicate' | 'scopeDenied' | 'validation' | 'notFound' | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, ReallocationProblem>> = {
  TRANSFER_UNBALANCED: 'unbalanced',
  REVISED_BELOW_COMMITTED: 'belowCommitted',
  SNAPSHOT_NOT_FROZEN: 'snapshotNotFrozen',
  PLAN_CHANGED_SINCE_PROPOSAL: 'planChanged',
  REVISION_PENDING_EXISTS: 'pendingRevision',
  SELF_APPROVAL_DENIED: 'selfApproval',
  VERSION_CONFLICT: 'versionConflict',
  STAGE_TRANSITION_DENIED: 'stageDenied',
  DECISION_REQUIRED: 'documentRequired',
  DUPLICATE_KEY: 'duplicate',
  SCOPE_DENIED: 'scopeDenied',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
};

export const describeReallocation = (error: unknown): ReallocationProblem => (error instanceof ApiError ? (PROBLEM_BY_CODE[error.code] ?? 'general') : 'general');
