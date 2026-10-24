import { ApiError } from '@machvon/api-client';
import { isVnd } from './model';
import type { PlanLine, PlanStatus, PlanSummary } from './plan-model';

/** The permissions that gate the buttons of the approval screens; the server decides again on every request. */
export const SUBMIT_PERMISSION = 'capital.plan.submit';
export const DECIDE_PERMISSION = 'capital.plan.approve';
export const PUBLISH_PERMISSION = 'plan.publish';

export const APPROVAL_PATH = '/cap/cap-10';
export const DECISIONS_PATH = '/cap/cap-05';
export const BOOK_PATH = '/cap/cap-16';

export const REASON_MIN = 5;
export const REASON_MAX = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The revisions that are in the hands of the approval, and the order a person works through them in. */
export const WORK_STATUSES: readonly PlanStatus[] = ['IN_REVIEW', 'APPROVED', 'DRAFT'];

/** Whether the person holds a permission (a session that does not list permissions is judged by the server) and the tenant is not frozen. */
export const mayAct = (permissions: readonly string[] | undefined, mode: string | undefined, permission: string): boolean => (permissions === undefined || permissions.includes(permission)) && mode !== 'READ_ONLY';

/** The revision the screen opens on when the address names none: the first one waiting for a decision or a publication, else the newest. */
export function firstToWorkOn(plans: readonly PlanSummary[]): PlanSummary | undefined {
  for (const status of WORK_STATUSES) {
    const found = plans.find((plan) => plan.status === status);
    if (found !== undefined) return found;
  }
  return plans[0];
}

/** The revision a plan replaces (the one it was made from), when the list holds it. */
export const baseOf = (plan: PlanSummary, plans: readonly PlanSummary[]): PlanSummary | undefined => (plan.supersedesId === null ? undefined : plans.find((candidate) => candidate.id === plan.supersedesId));

// ---- the impact of a revision ------------------------------------------------------------------------------------------

/** One line of the impact: what the base revision gave a project on a source, what the revision gives it, and the floor that is already spent. */
export interface ImpactRow {
  key: string;
  projectCode: string;
  projectName: string;
  fundLabel: string;
  previousVnd: string;
  nextVnd: string;
  deltaVnd: string;
  /** What is committed and disbursed on the line of the base revision: the new amount may not be below it (BR-CAP-05). */
  floorVnd: string;
  belowFloor: boolean;
  kind: 'NEW' | 'CHANGED' | 'SAME' | 'DROPPED';
}

export interface Impact {
  rows: ImpactRow[];
  previousVnd: string;
  nextVnd: string;
  deltaVnd: string;
  projectCount: number;
  belowCount: number;
}

const keyOf = (line: PlanLine): string => `${line.project.id}|${line.appropriation?.id ?? ''}|${line.bucket}|${line.sourceYear}`;
const big = (value: string | null): bigint => (value === null ? 0n : BigInt(value));

/**
 * Compares the lines of a revision with the lines of the revision it replaces, exactly (BigInt, never a float): a line that grows or is new
 * is capital to allocate, a line that shrinks or is dropped is capital to reduce, and a line whose new amount is below what is committed
 * and disbursed on it is flagged, because the publication would refuse it (422 REVISED_BELOW_COMMITTED).
 */
export function computeImpact(lines: readonly PlanLine[], base: readonly PlanLine[]): Impact {
  const previous = new Map(base.map((line) => [keyOf(line), line]));
  const rows: ImpactRow[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const key = keyOf(line);
    seen.add(key);
    const before = previous.get(key);
    const previousVnd = before?.amountVnd ?? '0';
    const floor = before === undefined ? 0n : big(before.committedVnd) + big(before.disbursedVnd);
    const delta = big(line.amountVnd) - big(previousVnd);
    rows.push({
      key,
      projectCode: line.project.code,
      projectName: line.project.name,
      fundLabel: line.fundSource.businessKey,
      previousVnd,
      nextVnd: line.amountVnd,
      deltaVnd: delta.toString(),
      floorVnd: floor.toString(),
      belowFloor: big(line.amountVnd) < floor,
      kind: before === undefined ? 'NEW' : delta === 0n ? 'SAME' : 'CHANGED',
    });
  }
  for (const [key, before] of previous) {
    if (seen.has(key)) continue;
    const floor = big(before.committedVnd) + big(before.disbursedVnd);
    rows.push({
      key,
      projectCode: before.project.code,
      projectName: before.project.name,
      fundLabel: before.fundSource.businessKey,
      previousVnd: before.amountVnd,
      nextVnd: '0',
      deltaVnd: (-big(before.amountVnd)).toString(),
      floorVnd: floor.toString(),
      belowFloor: floor > 0n,
      kind: 'DROPPED',
    });
  }
  rows.sort((a, b) => (a.projectCode < b.projectCode ? -1 : a.projectCode > b.projectCode ? 1 : a.key < b.key ? -1 : 1));
  const sum = (field: 'previousVnd' | 'nextVnd'): bigint => rows.reduce((total, row) => total + BigInt(row[field]), 0n);
  const next = sum('nextVnd');
  const prior = sum('previousVnd');
  return {
    rows,
    previousVnd: prior.toString(),
    nextVnd: next.toString(),
    deltaVnd: (next - prior).toString(),
    projectCount: new Set(lines.map((line) => line.project.id)).size,
    belowCount: rows.filter((row) => row.belowFloor).length,
  };
}

// ---- the forms ---------------------------------------------------------------------------------------------------------

export type ReasonProblem = 'required' | 'tooShort' | 'tooLong';

export function validateReason(reason: string): ReasonProblem | undefined {
  const length = reason.trim().length;
  if (length === 0) return 'required';
  if (length < REASON_MIN) return 'tooShort';
  return length > REASON_MAX ? 'tooLong' : undefined;
}

export interface PublishForm {
  documentId: string;
  effectiveAt: string;
}

export const EMPTY_PUBLISH_FORM: PublishForm = { documentId: '', effectiveAt: '' };

export type PublishField = 'documentId' | 'effectiveAt';
export type PublishProblem = 'required' | 'invalidId' | 'invalidDate';

export function validatePublishForm(form: PublishForm): Partial<Record<PublishField, PublishProblem>> {
  const problems: Partial<Record<PublishField, PublishProblem>> = {};
  const id = form.documentId.trim();
  if (id === '') problems.documentId = 'required';
  else if (!UUID.test(id)) problems.documentId = 'invalidId';
  if (form.effectiveAt.trim() !== '' && Number.isNaN(new Date(form.effectiveAt).getTime())) problems.effectiveAt = 'invalidDate';
  return problems;
}

/** The body of the publication: the document by its lower-case id, and the moment it takes effect when one is given. */
export function publishBody(form: PublishForm): { decision_document_id: string; effective_at?: string } {
  return {
    decision_document_id: form.documentId.trim().toLowerCase(),
    ...(form.effectiveAt.trim() === '' ? {} : { effective_at: new Date(form.effectiveAt).toISOString() }),
  };
}

// ---- the refusals ------------------------------------------------------------------------------------------------------

export type ApprovalProblemReason =
  | 'selfApproval'
  | 'decisionRequired'
  | 'notApproved'
  | 'notDraft'
  | 'notInReview'
  | 'belowCommitted'
  | 'nationalCode'
  | 'yearLocked'
  | 'versionConflict'
  | 'planChanged'
  | 'stageInvalid'
  | 'notPublished'
  | 'noLines'
  | 'denied'
  | 'notFound'
  | 'validation'
  | 'general';

/** A line the publication refused because it is below what is committed and disbursed on it. */
export interface BelowCommittedLine {
  lineId: string;
  projectId: string;
  allocatedVnd: string;
  committedVnd: string;
  disbursedVnd: string;
  minimumVnd: string;
}

export interface ApprovalProblemView {
  reason: ApprovalProblemReason;
  field: string | undefined;
  lines: BelowCommittedLine[];
  projectCount: number;
}

const REASON_BY_CODE: Readonly<Record<string, ApprovalProblemReason>> = {
  SELF_APPROVAL_DENIED: 'selfApproval',
  DECISION_REQUIRED: 'decisionRequired',
  PLAN_NOT_APPROVED: 'notApproved',
  PLAN_NOT_DRAFT: 'notDraft',
  STAGE_TRANSITION_DENIED: 'notInReview',
  REVISED_BELOW_COMMITTED: 'belowCommitted',
  NATIONAL_CODE_REQUIRED: 'nationalCode',
  NATIONAL_CODE_FORMAT_INVALID: 'nationalCode',
  FISCAL_YEAR_LOCKED: 'yearLocked',
  VERSION_CONFLICT: 'versionConflict',
  PLAN_CHANGED_SINCE_PROPOSAL: 'planChanged',
  PROJECT_STAGE_INVALID: 'stageInvalid',
  APPROPRIATION_NOT_PUBLISHED: 'notPublished',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  FIELD_NOT_ALLOWED: 'validation',
};

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

function belowLines(value: unknown): BelowCommittedLine[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw: unknown) => {
    const row = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const lineId = text(row.line_id);
    const amounts = [row.allocated_vnd, row.committed_vnd, row.disbursed_vnd, row.minimum_vnd].map(text);
    if (lineId === undefined || amounts.some((amount) => amount === undefined || !isVnd(amount))) return [];
    return [{ lineId, projectId: text(row.project_id) ?? '', allocatedVnd: amounts[0] as string, committedVnd: amounts[1] as string, disbursedVnd: amounts[2] as string, minimumVnd: amounts[3] as string }];
  });
}

/** Maps the failure of a command of the approval to what the screen says; a plan with no lines is a validation problem on `lines`. */
export function describeApprovalProblem(error: unknown): ApprovalProblemView {
  const none = { field: undefined, lines: [] as BelowCommittedLine[], projectCount: 0 };
  if (!(error instanceof ApiError)) return { reason: 'general', ...none };
  const reason = REASON_BY_CODE[error.code] ?? (error.status === 403 ? 'denied' : 'general');
  const ids = error.extensions.project_ids;
  return {
    reason: reason === 'validation' && error.detail === 'lines' ? 'noLines' : reason,
    field: error.detail,
    lines: belowLines(error.extensions.lines),
    projectCount: Array.isArray(ids) ? ids.length : 0,
  };
}
