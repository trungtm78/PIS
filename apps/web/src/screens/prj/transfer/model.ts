import { ApiError } from '@machvon/api-client';

export const READ_PERMISSION = 'project.read';
export const REQUEST_PERMISSION = 'project.transfer.request';
export const APPROVE_PERMISSION = 'project.transfer.approve';
/** What the list of the units of the tenant needs: without it, or beyond the branch it covers, the receiving unit is named by its identifier. */
export const UNIT_LIST_PERMISSION = 'organization_unit.read';

export const STATUSES = ['REQUESTED', 'APPROVED', 'APPLIED', 'REJECTED', 'CANCELLED'] as const;
export type Status = (typeof STATUSES)[number];
export const SCOPES = ['OWNER_UNIT', 'INVESTOR_UNIT'] as const;
export type Scope = (typeof SCOPES)[number];
export const DECISIONS = ['approve', 'reject', 'return'] as const;
export type Decision = (typeof DECISIONS)[number];

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const count = (value: unknown): number => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0);

export interface TransferView {
  id: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  scope: Scope;
  fromUnitName: string;
  toUnitName: string;
  effectiveDate: string;
  decisionDocumentId: string | null;
  reason: string;
  status: Status;
  decisionReason: string | null;
  createdBy: string;
  version: number;
}

export interface TransferPage {
  items: TransferView[];
  nextCursor: string | undefined;
}

function toTransfer(raw: unknown): TransferView | undefined {
  const row = asRecord(raw);
  const project = asRecord(row?.project);
  const status = STATUSES.find((candidate) => candidate === row?.status);
  const scope = SCOPES.find((candidate) => candidate === row?.transfer_scope);
  const id = text(row?.id);
  const projectId = text(project?.id);
  const effectiveDate = text(row?.effective_date);
  const createdBy = text(row?.created_by);
  if (row === undefined || status === undefined || scope === undefined || id === undefined || projectId === undefined || effectiveDate === undefined || createdBy === undefined || typeof row.version !== 'number') return undefined;
  return {
    id,
    projectId,
    projectCode: text(project?.code) ?? '',
    projectName: text(project?.name) ?? '',
    scope,
    fromUnitName: text(asRecord(row.from_unit)?.name) ?? '',
    toUnitName: text(asRecord(row.to_unit)?.name) ?? '',
    effectiveDate,
    decisionDocumentId: nullableText(row.decision_document_id),
    reason: text(row.reason) ?? '',
    status,
    decisionReason: nullableText(row.decision_reason),
    createdBy,
    version: row.version,
  };
}

export function toTransferPage(raw: unknown): TransferPage {
  const page = asRecord(raw);
  return { items: (Array.isArray(page?.items) ? page.items : []).flatMap((item) => toTransfer(item) ?? []), nextCursor: text(page?.next_cursor) };
}

export interface Impact {
  fromUnitName: string;
  toUnitName: string;
  reports: number;
  snapshotLines: number;
  planLines: number;
  usersGaining: number;
  usersLosing: number;
  partial: boolean;
}

export function toImpact(raw: unknown): Impact | undefined {
  const row = asRecord(raw);
  if (row === undefined || typeof row.reports !== 'number' || typeof row.plan_lines !== 'number') return undefined;
  return {
    fromUnitName: text(asRecord(row.from_unit)?.name) ?? '',
    toUnitName: text(asRecord(row.to_unit)?.name) ?? '',
    reports: count(row.reports),
    snapshotLines: count(row.snapshot_lines),
    planLines: count(row.plan_lines),
    usersGaining: count(row.users_gaining),
    usersLosing: count(row.users_losing),
    partial: row.partial === true,
  };
}

type Mode = 'FULL' | 'READ_ONLY' | undefined;
export const holds = (permissions: readonly string[] | undefined, permission: string, mode: Mode): boolean => (permissions === undefined || permissions.includes(permission)) && mode !== 'READ_ONLY';

/** A request waits for a decision of someone other than the one who asked. */
export const canDecide = (view: Pick<TransferView, 'status' | 'createdBy'>, membershipId: string | undefined): boolean => view.status === 'REQUESTED' && (membershipId === undefined || view.createdBy !== membershipId);

// ---- the forms ---------------------------------------------------------------------------------------------------------------

export type FormProblem = 'required' | 'invalid' | 'past' | 'same';

export interface RequestForm {
  projectId: string;
  scope: Scope;
  toUnitId: string;
  /** The receiving unit named by its identifier, for a unit the list does not offer (it takes the place of the choice). */
  toUnitInput: string;
  effectiveDate: string;
  reason: string;
  documentId: string;
}

export const EMPTY_REQUEST: RequestForm = { projectId: '', scope: 'OWNER_UNIT', toUnitId: '', toUnitInput: '', effectiveDate: '', reason: '', documentId: '' };
export type RequestField = 'projectId' | 'toUnitId' | 'effectiveDate' | 'reason' | 'documentId';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (date: string): boolean => DATE.test(date) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;

/** The day of the form in Vietnam (UTC+7), as `YYYY-MM-DD`. */
export const vietnamToday = (now: Date = new Date()): string => new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

/** The receiving unit: the one named by its identifier when there is one, else the one chosen from the list. */
export const targetUnitId = (form: Pick<RequestForm, 'toUnitId' | 'toUnitInput'>): string => (form.toUnitInput.trim() !== '' ? form.toUnitInput.trim() : form.toUnitId);

/** The unit a project has for a scope of transfer; null when it has none (a project may have no investor unit). */
export const currentUnitId = (project: { ownerUnitId: string; investorUnitId: string | null }, scope: Scope): string | null => (scope === 'OWNER_UNIT' ? project.ownerUnitId : project.investorUnitId);

export function validateRequest(form: RequestForm, today: string, currentUnit: string | null): Partial<Record<RequestField, FormProblem>> {
  const found: Partial<Record<RequestField, FormProblem>> = {};
  if (form.projectId === '') found.projectId = 'required';
  else if (currentUnit === null) found.projectId = 'invalid';
  const target = targetUnitId(form);
  if (target === '') found.toUnitId = 'required';
  else if (!UUID.test(target)) found.toUnitId = 'invalid';
  else if (target === currentUnit) found.toUnitId = 'same';
  if (form.effectiveDate === '') found.effectiveDate = 'required';
  else if (!isDay(form.effectiveDate)) found.effectiveDate = 'invalid';
  else if (form.effectiveDate < today) found.effectiveDate = 'past';
  const reason = form.reason.trim();
  if (reason === '') found.reason = 'required';
  else if (reason.length < 10 || reason.length > 2000) found.reason = 'invalid';
  if (form.documentId !== '' && !UUID.test(form.documentId.trim())) found.documentId = 'invalid';
  return found;
}

export function requestBody(form: RequestForm): Record<string, unknown> {
  return {
    to_unit_id: targetUnitId(form),
    transfer_scope: form.scope,
    effective_date: form.effectiveDate,
    reason: form.reason.trim(),
    ...(form.documentId.trim() === '' ? {} : { decision_document_id: form.documentId.trim() }),
  };
}

export function validateDecision(reason: string): FormProblem | undefined {
  const trimmed = reason.trim();
  if (trimmed === '') return 'required';
  return trimmed.length < 5 || trimmed.length > 2000 ? 'invalid' : undefined;
}

// ---- what the server refuses ---------------------------------------------------------------------------------------------------

export type TransferProblem = 'pendingExists' | 'selfApproval' | 'versionConflict' | 'stageDenied' | 'scopeDenied' | 'projectClosed' | 'documentInvalid' | 'validation' | 'notFound' | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, TransferProblem>> = {
  TRANSFER_PENDING_EXISTS: 'pendingExists',
  SELF_APPROVAL_DENIED: 'selfApproval',
  VERSION_CONFLICT: 'versionConflict',
  STAGE_TRANSITION_DENIED: 'stageDenied',
  SCOPE_DENIED: 'scopeDenied',
  PROJECT_STAGE_INVALID: 'projectClosed',
  DECISION_REQUIRED: 'documentInvalid',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
};

export const describeTransfer = (error: unknown): TransferProblem => (error instanceof ApiError ? (PROBLEM_BY_CODE[error.code] ?? 'general') : 'general');
