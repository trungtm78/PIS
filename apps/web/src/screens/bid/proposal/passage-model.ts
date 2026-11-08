import { ApiError } from '@machvon/api-client';

/** The right to list the models of the AI gateway: an evaluator may not hold it, and then names the model by its identifier. */
export const MODELS_READ_PERMISSION = 'llm.provider.read';

export const QUESTION_MAX = 4000;
export const LIMIT_MAX = 20;
export const LIMIT_DEFAULT = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PassageQuery {
  modelId: string;
  question: string;
  limit: number;
}

export type PassageProblem = 'modelRequired' | 'questionRequired' | 'questionLong' | 'limitRange';

/** What is wrong with the question: an embedding model, words of one to 4000 characters, and 1 to 20 passages. */
export function passageProblems(query: PassageQuery): Partial<Record<'model' | 'question' | 'limit', PassageProblem>> {
  const found: Partial<Record<'model' | 'question' | 'limit', PassageProblem>> = {};
  if (!UUID.test(query.modelId)) found.model = 'modelRequired';
  if (query.question.trim() === '') found.question = 'questionRequired';
  else if (query.question.length > QUESTION_MAX) found.question = 'questionLong';
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > LIMIT_MAX) found.limit = 'limitRange';
  return found;
}

export interface Passage {
  documentVersionId: string;
  pageIndex: number;
  chunkNo: number;
  classification: string;
  distance: number;
  text: string;
}

export interface PassageResult {
  items: Passage[];
  asOf: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The passages the server found, nearest first as it sent them; a row that lacks what the screen shows is dropped. */
export function toPassages(raw: unknown): PassageResult {
  const row = isRecord(raw) ? raw : {};
  const items = (Array.isArray(row.items) ? row.items : []).flatMap((item): Passage[] => {
    if (!isRecord(item) || typeof item.document_version_id !== 'string' || typeof item.text !== 'string' || typeof item.distance !== 'number') return [];
    return [
      {
        documentVersionId: item.document_version_id,
        pageIndex: typeof item.page_index === 'number' ? item.page_index : 0,
        chunkNo: typeof item.chunk_no === 'number' ? item.chunk_no : 0,
        classification: typeof item.classification === 'string' ? item.classification : '',
        distance: item.distance,
        text: item.text,
      },
    ];
  });
  return { items, asOf: typeof row.as_of === 'string' ? row.as_of : '' };
}

export type PassageRefusal = 'undeclared' | 'route' | 'killSwitch' | 'model' | 'validation' | 'denied' | 'general';

export function describePassageRefusal(error: unknown): PassageRefusal {
  if (!(error instanceof ApiError)) return 'general';
  switch (error.code) {
    case 'CONFLICT_UNDECLARED':
      return 'undeclared';
    case 'AI_ROUTE_NOT_ALLOWED':
      return 'route';
    case 'AI_KILL_SWITCH_ENGAGED':
      return 'killSwitch';
    case 'MODEL_NOT_APPROVED':
      return 'model';
    case 'VALIDATION_FAILED':
      return 'validation';
    case 'SCOPE_DENIED':
    case 'ENTITLEMENT_DENIED':
      return 'denied';
    default:
      return 'general';
  }
}

/** The distance as the person reads it: four decimals, a dash for a number that is not one. */
export const distanceText = (distance: number): string => (Number.isFinite(distance) ? distance.toFixed(4) : '–');
