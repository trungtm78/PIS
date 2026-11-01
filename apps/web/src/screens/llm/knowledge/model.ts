import { ApiError } from '@machvon/api-client';

export const MANAGE_PERMISSION = 'llm.knowledge.manage';
export const READ_PERMISSION = 'llm.knowledge.read';

export const CLASSIFICATIONS = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PERSONAL', 'IMPORTANT_CORE'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];
export const COLLECTION_STATUSES = ['ACTIVE', 'REINDEXING', 'RETIRED'] as const;
export type CollectionStatus = (typeof COLLECTION_STATUSES)[number];
export const ITEM_STATUSES = ['PENDING', 'INDEXED', 'FAILED', 'REMOVED'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Item {
  id: string;
  documentVersionId: string;
  chunkCount: number;
  aclHash: string;
  status: ItemStatus;
  classification: string | null;
  failureCode: string | null;
  indexedAt: string | null;
  /** The document carries another access list than the one the item was indexed with: it waits to be indexed again. */
  stale: boolean;
}

export interface Collection {
  id: string;
  code: string;
  title: string;
  subjectModule: string;
  embeddingModelId: string;
  indexVersion: number;
  maxClassification: Classification;
  status: CollectionStatus;
  itemCount: number;
  version: number;
  /** Only the collection that was opened has them. */
  items: Item[];
}

function toItem(raw: unknown): Item[] {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.document_version_id !== 'string' || typeof raw.acl_hash !== 'string') return [];
  const status = ITEM_STATUSES.find((candidate) => candidate === raw.status);
  if (status === undefined) return [];
  return [
    {
      id: raw.id,
      documentVersionId: raw.document_version_id,
      chunkCount: count(raw.chunk_count),
      aclHash: raw.acl_hash,
      status,
      classification: text(raw.classification),
      failureCode: text(raw.failure_code),
      indexedAt: text(raw.indexed_at),
      stale: raw.stale === true,
    },
  ];
}

export function toCollection(raw: unknown): Collection | undefined {
  if (
    !isRecord(raw) ||
    typeof raw.id !== 'string' ||
    typeof raw.code !== 'string' ||
    typeof raw.title !== 'string' ||
    typeof raw.subject_module !== 'string' ||
    typeof raw.embedding_model_id !== 'string' ||
    typeof raw.version !== 'number'
  )
    return undefined;
  const status = COLLECTION_STATUSES.find((candidate) => candidate === raw.status);
  const maxClassification = CLASSIFICATIONS.find((candidate) => candidate === raw.max_classification);
  if (status === undefined || maxClassification === undefined) return undefined;
  return {
    id: raw.id,
    code: raw.code,
    title: raw.title,
    subjectModule: raw.subject_module,
    embeddingModelId: raw.embedding_model_id,
    indexVersion: count(raw.index_version),
    maxClassification,
    status,
    itemCount: count(raw.item_count),
    version: raw.version,
    items: Array.isArray(raw.items) ? raw.items.flatMap(toItem) : [],
  };
}

// --- the forms ---------------------------------------------------------------------------------------------------------------------------------

export interface CollectionForm {
  code: string;
  title: string;
  subjectModule: string;
  embeddingModelId: string;
  maxClassification: Classification;
}

export type CollectionField = keyof CollectionForm;
export type FormProblem = 'required' | 'invalid';
export const EMPTY_COLLECTION: CollectionForm = { code: '', title: '', subjectModule: '', embeddingModelId: '', maxClassification: 'INTERNAL' };

export function validateCollection(form: CollectionForm): Partial<Record<CollectionField, FormProblem>> {
  const problems: Partial<Record<CollectionField, FormProblem>> = {};
  if (form.code.trim() === '') problems.code = 'required';
  else if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{1,59}$/.test(form.code.trim())) problems.code = 'invalid';
  if (form.title.trim() === '') problems.title = 'required';
  else if (form.title.trim().length < 2 || form.title.trim().length > 300) problems.title = 'invalid';
  if (form.subjectModule.trim() === '') problems.subjectModule = 'required';
  else if (!/^[A-Z][A-Z0-9]{1,9}$/.test(form.subjectModule.trim())) problems.subjectModule = 'invalid';
  if (form.embeddingModelId.trim() === '') problems.embeddingModelId = 'required';
  else if (!UUID.test(form.embeddingModelId.trim())) problems.embeddingModelId = 'invalid';
  return problems;
}

export function collectionBody(form: CollectionForm): Record<string, unknown> {
  return {
    code: form.code.trim(),
    title: form.title.trim(),
    subject_module: form.subjectModule.trim(),
    embedding_model_id: form.embeddingModelId.trim().toLowerCase(),
    max_classification: form.maxClassification,
  };
}

/** The id of a document version to index: a UUID. */
export function versionProblem(value: string): FormProblem | undefined {
  if (value.trim() === '') return 'required';
  return UUID.test(value.trim()) ? undefined : 'invalid';
}

// --- refusals ----------------------------------------------------------------------------------------------------------------------------------

export type KnowledgeReason = 'model' | 'classification' | 'scan' | 'infected' | 'state' | 'duplicate' | 'scope' | 'notFound' | 'validation' | 'general';

const REASON_BY_CODE: Readonly<Record<string, KnowledgeReason>> = {
  MODEL_NOT_APPROVED: 'model',
  CLASSIFICATION_ABOVE_COLLECTION: 'classification',
  SCAN_PENDING: 'scan',
  FILE_NOT_CLEAN: 'infected',
  STAGE_TRANSITION_DENIED: 'state',
  DUPLICATE_KEY: 'duplicate',
  SCOPE_DENIED: 'scope',
  RESOURCE_NOT_FOUND: 'notFound',
  VALIDATION_FAILED: 'validation',
};

export interface KnowledgeProblem {
  reason: KnowledgeReason;
  detail: string;
}

export function describeProblem(error: unknown): KnowledgeProblem {
  if (!(error instanceof ApiError)) return { reason: 'general', detail: '' };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', detail: error.detail ?? '' };
}
