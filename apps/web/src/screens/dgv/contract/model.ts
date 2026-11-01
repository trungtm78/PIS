import { ApiError } from '@machvon/api-client';

export const DRAFT_PERMISSION = 'data.contract.manage';
export const APPROVE_PERMISSION = 'data.contract.approve';
export const DECIDE_PERMISSION = 'data.contract.publish';
export const CONSUME_PERMISSION = 'data.contract.consume';
/** The version of ODCS the platform pins. */
export const ODCS_PINNED = 'v3.0.2';
export const ODCS_VERSIONS = ['v3.0.2', 'v3.0.1', 'v3.0.0'] as const;

export type Compatibility = 'INITIAL' | 'BACKWARD_COMPATIBLE' | 'BREAKING';
export type RevisionStatus = 'DRAFT' | 'IN_REVIEW' | 'PUBLISHED' | 'SUPERSEDED' | 'REJECTED' | 'RETURNED';
export type ApprovalDecision = 'PENDING' | 'APPROVED' | 'REJECTED';
const COMPATIBILITIES: readonly string[] = ['INITIAL', 'BACKWARD_COMPATIBLE', 'BREAKING'];
const STATUSES: readonly string[] = ['DRAFT', 'IN_REVIEW', 'PUBLISHED', 'SUPERSEDED', 'REJECTED', 'RETURNED'];
const DECISIONS: readonly string[] = ['PENDING', 'APPROVED', 'REJECTED'];
const KINDS = ['MODULE', 'BI_DATASET', 'EXPORT', 'EXTERNAL'] as const;
export type ConsumerKind = (typeof KINDS)[number];
const CHANGE_KINDS = [
  'COLUMN_REMOVED',
  'COLUMN_ADDED_REQUIRED',
  'COLUMN_ADDED_OPTIONAL',
  'TYPE_CHANGED',
  'MADE_REQUIRED',
  'MADE_OPTIONAL',
  'GRAIN_CHANGED',
  'UNIT_CHANGED',
  'CLASSIFICATION_RAISED',
  'CLASSIFICATION_LOWERED',
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export interface Column {
  object: string;
  name: string;
  logicalType: string;
  physicalType: string | null;
  required: boolean;
  primaryKey: boolean;
  classification: string | null;
  unit: string | null;
}

export interface Approval {
  id: string;
  kind: ConsumerKind;
  ref: string;
  ownerId: string;
  ownerName: string | null;
  decision: ApprovalDecision;
  decidedAt: string | null;
  comment: string | null;
  version: number;
}

export interface Change {
  kind: ChangeKind;
  object: string;
  column: string;
  breaking: boolean;
}

export interface Revision {
  id: string;
  datasetId: string;
  datasetCode: string;
  revision: number;
  status: RevisionStatus;
  odcsVersion: string | null;
  compatibility: Compatibility | null;
  effectiveFrom: string | null;
  createdBy: string | null;
  approvedBy: string | null;
  createdAt: string;
  version: number;
  columns: Column[];
  approvals: Approval[];
  changes: Change[];
}

export interface DataVersion {
  id: string;
  datasetId: string;
  datasetCode: string;
  contractId: string | null;
  revision: number;
  compatibility: Compatibility | null;
  odcsSha256: string | null;
  publishedAt: string | null;
  migrationWindowUntil: string | null;
  serving: boolean;
  servingUntil: string | null;
}

function toColumn(raw: unknown): Column[] {
  if (!isRecord(raw) || typeof raw.object !== 'string' || typeof raw.name !== 'string' || typeof raw.logicalType !== 'string') return [];
  return [
    {
      object: raw.object,
      name: raw.name,
      logicalType: raw.logicalType,
      physicalType: text(raw.physicalType),
      required: raw.required === true,
      primaryKey: raw.primaryKey === true,
      classification: text(raw.classification),
      unit: text(raw.unit),
    },
  ];
}

function toApproval(raw: unknown): Approval[] {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.consumer_ref !== 'string') return [];
  const kind = KINDS.find((candidate) => candidate === raw.consumer_kind);
  const decision = DECISIONS.find((candidate) => candidate === raw.decision) as ApprovalDecision | undefined;
  const owner = isRecord(raw.consumer_owner) ? raw.consumer_owner : undefined;
  if (kind === undefined || decision === undefined || owner === undefined || typeof owner.membership_id !== 'string') return [];
  return [
    {
      id: raw.id,
      kind,
      ref: raw.consumer_ref,
      ownerId: owner.membership_id,
      ownerName: text(owner.display_name),
      decision,
      decidedAt: text(raw.decided_at),
      comment: text(raw.comment),
      version: typeof raw.version === 'number' ? raw.version : 1,
    },
  ];
}

function toChange(raw: unknown): Change[] {
  if (!isRecord(raw) || typeof raw.object !== 'string' || typeof raw.column !== 'string') return [];
  const kind = CHANGE_KINDS.find((candidate) => candidate === raw.kind);
  return kind === undefined ? [] : [{ kind, object: raw.object, column: raw.column, breaking: raw.breaking === true }];
}

export function toRevision(raw: unknown): Revision | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.dataset_id !== 'string' || typeof raw.dataset_code !== 'string' || typeof raw.created_at !== 'string') return undefined;
  const status = STATUSES.find((candidate) => candidate === raw.status) as RevisionStatus | undefined;
  if (status === undefined || typeof raw.revision !== 'number') return undefined;
  return {
    id: raw.id,
    datasetId: raw.dataset_id,
    datasetCode: raw.dataset_code,
    revision: raw.revision,
    status,
    odcsVersion: text(raw.odcs_version),
    compatibility: (COMPATIBILITIES.find((candidate) => candidate === raw.compatibility) as Compatibility | undefined) ?? null,
    effectiveFrom: text(raw.effective_from),
    createdBy: text(raw.created_by),
    approvedBy: text(raw.approved_by),
    createdAt: raw.created_at,
    version: typeof raw.version === 'number' ? raw.version : 1,
    columns: Array.isArray(raw.columns) ? raw.columns.flatMap(toColumn) : [],
    approvals: Array.isArray(raw.consumer_approvals) ? raw.consumer_approvals.flatMap(toApproval) : [],
    changes: Array.isArray(raw.changes) ? raw.changes.flatMap(toChange) : [],
  };
}

export function toVersion(raw: unknown): DataVersion | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.dataset_id !== 'string' || typeof raw.dataset_code !== 'string' || typeof raw.revision !== 'number') return undefined;
  return {
    id: raw.id,
    datasetId: raw.dataset_id,
    datasetCode: raw.dataset_code,
    contractId: text(raw.contract_id),
    revision: raw.revision,
    compatibility: (COMPATIBILITIES.find((candidate) => candidate === raw.compatibility) as Compatibility | undefined) ?? null,
    odcsSha256: text(raw.odcs_sha256),
    publishedAt: text(raw.published_at),
    migrationWindowUntil: text(raw.migration_window_until),
    serving: raw.serving === true,
    servingUntil: text(raw.serving_until),
  };
}

/** The revision that waits for a decision, if the dataset has one. */
export const openRevision = (revisions: readonly Revision[]): Revision | undefined => revisions.find((revision) => revision.status === 'IN_REVIEW');

/** Whether every consumer has approved: a revision that is not breaking has no consumer to wait for. */
export const allApproved = (revision: Revision): boolean => revision.approvals.every((approval) => approval.decision === 'APPROVED');

/** An approval that waits for the person as the owner of a consumer, with the revision it is about (what the server tells of it whether or not the person may see the dataset). */
export interface WaitingApproval {
  approval: Approval;
  contractId: string;
  contractStatus: RevisionStatus;
  datasetCode: string;
  revision: number;
  compatibility: Compatibility | null;
  effectiveFrom: string | null;
  changes: Change[];
}

export function toWaiting(raw: unknown): WaitingApproval | undefined {
  const approval = toApproval(raw)[0];
  const contract = isRecord(raw) && isRecord(raw.contract) ? raw.contract : undefined;
  if (approval === undefined || contract === undefined || typeof contract.id !== 'string' || typeof contract.dataset_code !== 'string' || typeof contract.revision !== 'number') return undefined;
  const status = STATUSES.find((candidate) => candidate === contract.status) as RevisionStatus | undefined;
  if (status === undefined) return undefined;
  return {
    approval,
    contractId: contract.id,
    contractStatus: status,
    datasetCode: contract.dataset_code,
    revision: contract.revision,
    compatibility: (COMPATIBILITIES.find((candidate) => candidate === contract.compatibility) as Compatibility | undefined) ?? null,
    effectiveFrom: text(contract.effective_from),
    changes: Array.isArray(contract.changes) ? contract.changes.flatMap(toChange) : [],
  };
}

export interface DraftForm {
  odcsVersion: string;
  document: string;
  effectiveFrom: string;
}

export const EMPTY_DRAFT: DraftForm = { odcsVersion: ODCS_PINNED, document: '', effectiveFrom: '' };
export type DraftField = 'document' | 'effectiveFrom';
export type DraftProblem = 'required' | 'invalid';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The day as a calendar day: `2030-02-30` is not one. */
export const isDay = (value: string): boolean => DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;

function parseDocument(source: string): Raw | undefined {
  try {
    const parsed: unknown = JSON.parse(source);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function validateDraft(form: DraftForm): Partial<Record<DraftField, DraftProblem>> {
  const problems: Partial<Record<DraftField, DraftProblem>> = {};
  if (form.document.trim() === '') problems.document = 'required';
  else if (parseDocument(form.document) === undefined) problems.document = 'invalid';
  if (form.effectiveFrom.trim() === '') problems.effectiveFrom = 'required';
  else if (!isDay(form.effectiveFrom.trim())) problems.effectiveFrom = 'invalid';
  return problems;
}

/** The body of the draft; the document is the one that was typed, read as JSON. */
export function draftBody(datasetId: string, form: DraftForm): { dataset_id: string; odcs_version: string; odcs_json: Raw; effective_from: string } {
  return { dataset_id: datasetId, odcs_version: form.odcsVersion, odcs_json: parseDocument(form.document) ?? {}, effective_from: form.effectiveFrom.trim() };
}

export interface PublishForm {
  windowUntil: string;
  reason: string;
}
export const EMPTY_PUBLISH: PublishForm = { windowUntil: '', reason: '' };

export type ContractReason = 'schema' | 'open' | 'pending' | 'window' | 'self' | 'notOwner' | 'stale' | 'state' | 'notFound' | 'scope' | 'validation' | 'general';
const REASON_BY_CODE: Readonly<Record<string, ContractReason>> = {
  ODCS_SCHEMA_INVALID: 'schema',
  CONTRACT_REVISION_OPEN: 'open',
  CONSUMER_APPROVAL_PENDING: 'pending',
  MIGRATION_WINDOW_REQUIRED: 'window',
  SELF_APPROVAL_DENIED: 'self',
  NOT_CONSUMER_OWNER: 'notOwner',
  VERSION_CONFLICT: 'stale',
  STAGE_TRANSITION_DENIED: 'state',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'scope',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
};

/** Why a command was refused, by the code the server gave, with the path or the field it names. */
export function describeContractProblem(error: unknown): { reason: ContractReason; detail: string } {
  if (!(error instanceof ApiError)) return { reason: 'general', detail: '' };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', detail: error.detail ?? '' };
}

/** The first characters of the hash of a document, to be read by a person. */
export const shortHash = (hash: string | null): string => (hash === null ? '' : hash.slice(0, 12));
