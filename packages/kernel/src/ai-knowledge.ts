import { DomainError } from './errors.ts';
import { CLASSIFICATIONS } from './llm-registry.ts';
import type { Classification } from './llm-registry.ts';

/**
 * The knowledge of the AI gateway (ST-LLM-007, LLM.md F6, BR-LLM-11, LLM-16, UAT-AC467, UAT-AC14): documents that are clean and not above the classification of a collection are cut into chunks, each chunk
 * is embedded, and retrieval answers a question with the chunks of the documents the asker may read - the tenant and the scope of the asker are put in front of the distance, never after it. Who may read a
 * document is decided by the document module (the scope of the reads of document versions), not here. Pure functions of their input.
 */
export const EMBEDDING_DIMENSION = 1024;
export const MAX_CHUNK_CHARS = 1200;
export const MIN_CHUNK_CHARS = 200;
export const MAX_CHUNKS_PER_ITEM = 2000;
export const MAX_RETRIEVED = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{1,59}$/;
const MODULE = /^[A-Z][A-Z0-9]{1,9}$/;

const rank = (value: string): number => (CLASSIFICATIONS as readonly string[]).indexOf(value);

/** Whether a classification is not above a ceiling (409 `CLASSIFICATION_ABOVE_COLLECTION` when it is). */
export function assertWithin(classification: string, ceiling: string): void {
  if (rank(classification) < 0 || rank(ceiling) < 0) throw new DomainError('VALIDATION_FAILED', 422, 'classification');
  if (rank(classification) > rank(ceiling)) throw new DomainError('CLASSIFICATION_ABOVE_COLLECTION', 422);
}

export function parseClassification(value: unknown, field: string): Classification {
  const found = CLASSIFICATIONS.find((candidate) => candidate === value);
  if (found === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return found;
}

export interface CollectionInput {
  code: string;
  title: string;
  subjectModule: string;
  embeddingModelId: string;
  maxClassification: string;
}

/** A collection as the request makes it: a code, a title, the module it serves, the embedding model and the highest classification it takes. */
export function checkCollection(input: CollectionInput): { code: string; title: string; subjectModule: string; embeddingModelId: string; maxClassification: Classification } {
  const code = input.code.trim();
  if (!CODE.test(code)) throw new DomainError('VALIDATION_FAILED', 422, 'code');
  const title = input.title.trim();
  if (title.length < 2 || title.length > 300) throw new DomainError('VALIDATION_FAILED', 422, 'title');
  const subjectModule = input.subjectModule.trim();
  if (!MODULE.test(subjectModule)) throw new DomainError('VALIDATION_FAILED', 422, 'subject_module');
  if (!UUID.test(input.embeddingModelId)) throw new DomainError('VALIDATION_FAILED', 422, 'embedding_model_id');
  return { code, title, subjectModule, embeddingModelId: input.embeddingModelId.toLowerCase(), maxClassification: parseClassification(input.maxClassification, 'max_classification') };
}

export interface Chunk {
  pageIndex: number;
  chunkNo: number;
  text: string;
}

/** Cuts a sentence that is longer than a chunk at the last space before the limit (or at the limit). */
function pieces(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > MAX_CHUNK_CHARS) {
    const cut = rest.lastIndexOf(' ', MAX_CHUNK_CHARS);
    const at = cut > MIN_CHUNK_CHARS ? cut : MAX_CHUNK_CHARS;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

/**
 * Cuts the pages of a document into chunks: paragraphs are kept together up to the size of a chunk, one that is longer is cut at a space, and a chunk never spans two pages (so that a chunk is cited
 * by its page). A page with no text gives none. More than `MAX_CHUNKS_PER_ITEM` is refused (422 `VALIDATION_FAILED`): a document that long is cut into several before it is indexed.
 */
export function chunkPages(pages: readonly string[]): Chunk[] {
  const chunks: Chunk[] = [];
  pages.forEach((page, pageIndex) => {
    const paragraphs = page
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
      .filter((paragraph) => paragraph.length > 0)
      .flatMap(pieces);
    let current = '';
    let chunkNo = 0;
    const flush = (): void => {
      if (current.length > 0) chunks.push({ pageIndex, chunkNo: chunkNo++, text: current });
      current = '';
    };
    for (const paragraph of paragraphs) {
      if (current.length > 0 && current.length + 1 + paragraph.length > MAX_CHUNK_CHARS) flush();
      current = current.length === 0 ? paragraph : `${current} ${paragraph}`;
    }
    flush();
  });
  if (chunks.length > MAX_CHUNKS_PER_ITEM) throw new DomainError('VALIDATION_FAILED', 422, 'document_version_id');
  return chunks;
}

/** An embedding as the model gives it: the dimension of the column and finite numbers. */
export function assertEmbedding(vector: readonly number[]): void {
  if (vector.length !== EMBEDDING_DIMENSION || vector.some((value) => !Number.isFinite(value))) throw new DomainError('VALIDATION_FAILED', 422, 'embedding');
}

/** How many chunks a question asks for: 1 to `MAX_RETRIEVED`. */
export function retrievalLimit(value: number | undefined): number {
  const limit = value ?? 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RETRIEVED) throw new DomainError('VALIDATION_FAILED', 422, 'limit');
  return limit;
}

/**
 * The distance of two embeddings: one minus their cosine, so that the nearest text has the smallest. A vector with no length has nothing to compare, and is as far as can be (1) from any other.
 */
export function cosineDistance(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  let leftLength = 0;
  let rightLength = 0;
  left.forEach((value, place) => {
    const other = right[place] ?? 0;
    dot += value * other;
    leftLength += value * value;
    rightLength += other * other;
  });
  return leftLength === 0 || rightLength === 0 ? 1 : 1 - dot / (Math.sqrt(leftLength) * Math.sqrt(rightLength));
}
