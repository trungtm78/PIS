/** IAM-07: global search (ST-IAM-008, FR-IAM-07, BR-IAM-01). The API answers from a projection filtered by tenant and by the scope of the caller before ranking, and never with a total: a count would show how much exists outside the scope. */
export const SEARCH_PERMISSION = 'search.use';
export const MIN_QUERY_LENGTH = 2;
export const MAX_QUERY_LENGTH = 200;
export const PAGE_SIZE = 50;

export const CLASSIFICATIONS = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PERSONAL'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export interface SearchHit {
  entityType: string;
  entityId: string;
  /** Null for a personal document: the name of a person is not shown by a search; opening the record decides. */
  title: string | null;
  classification: Classification;
  /** A plain-text extract around the match; null above INTERNAL. */
  snippet: string | null;
}

export interface SearchPage {
  items: SearchHit[];
  nextCursor: string | undefined;
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** A hit as the API answers it; a row that does not have the shape is dropped rather than shown half-filled. */
export function toHit(raw: unknown): SearchHit | undefined {
  if (!isRecord(raw)) return undefined;
  const classification = CLASSIFICATIONS.find((candidate) => candidate === raw.classification);
  if (typeof raw.entity_type !== 'string' || raw.entity_type === '' || typeof raw.entity_id !== 'string' || raw.entity_id === '' || classification === undefined) return undefined;
  return { entityType: raw.entity_type, entityId: raw.entity_id, title: nullableText(raw.title), classification, snippet: nullableText(raw.snippet) };
}

export function toSearchPage(raw: unknown): SearchPage {
  const view: Raw = isRecord(raw) ? raw : {};
  return {
    items: Array.isArray(view.items) ? view.items.flatMap((item) => toHit(item) ?? []) : [],
    nextCursor: typeof view.next_cursor === 'string' && view.next_cursor !== '' ? view.next_cursor : undefined,
  };
}

export type QueryProblem = 'short' | 'long';

/** The keyword as the API accepts it: 2 to 200 characters, counted as characters and not as UTF-16 units, so a Vietnamese letter or an emoji counts once. */
export function queryProblem(query: string): QueryProblem | undefined {
  const length = Array.from(query.trim()).length;
  if (length < MIN_QUERY_LENGTH) return 'short';
  return length > MAX_QUERY_LENGTH ? 'long' : undefined;
}

/** Where a hit is opened. Only the kinds of record whose screen takes an `id` are linked; the API checks the permission again when the screen reads the record. */
const OPEN_PATHS: Readonly<Record<string, string>> = { project: '/prj/prj-03', issue: '/iss/iss-03', conversation: '/omni/omni-02' };

export function openPath(hit: Pick<SearchHit, 'entityType' | 'entityId'>): string | undefined {
  const path = OPEN_PATHS[hit.entityType];
  return path === undefined ? undefined : `${path}?${new URLSearchParams({ id: hit.entityId }).toString()}`;
}

/** The kinds of record among the hits loaded, in the order they first appear. */
export const typesOf = (hits: readonly SearchHit[]): string[] => [...new Set(hits.map((hit) => hit.entityType))];

/** The hits of one kind; an empty kind keeps them all. */
export const ofType = (hits: readonly SearchHit[], type: string): SearchHit[] => (type === '' ? [...hits] : hits.filter((hit) => hit.entityType === type));
