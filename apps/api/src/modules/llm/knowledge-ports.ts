import { createHash } from 'node:crypto';
import { DomainError, EMBEDDING_DIMENSION } from '@machvon/kernel';
import type { TenantContext } from '@machvon/kernel';
import type { TenantTx } from '@machvon/db';
import type { FileService } from '../files';

/** Injection token of the port to the embedding models (ST-LLM-007): the adapter that goes through LiteLLM replaces the stand-in where the gateway is deployed. */
export const LLM_EMBEDDING = Symbol('LLM_EMBEDDING');
/** Injection token of the port that reads the text of a document version page by page. */
export const LLM_DOCUMENT_TEXT = Symbol('LLM_DOCUMENT_TEXT');

/** The embeddings of texts by a model, in the order of the texts, each of the dimension of the column. */
export interface AiEmbeddingPort {
  embed(input: { providerModelId: string; texts: readonly string[] }): Promise<number[][]>;
}

/** The text of the pages of a document version, page by page (an empty text for a page that has none), read in the transaction that is indexing: no second connection is taken while one is held. */
export interface DocumentTextPort {
  pages(tx: TenantTx, tenant: TenantContext, documentVersionId: string): Promise<string[]>;
}

/**
 * The stand-in of the embedding model until the gateway goes through LiteLLM: a text becomes the counts of its words in the 1024 places the hash of each word falls in, scaled to length one, so that texts that
 * share words are near and texts that share none are far. The same text always gives the same vector.
 */
export class MockEmbeddingPort implements AiEmbeddingPort {
  readonly calls: Array<{ providerModelId: string; count: number }> = [];

  async embed(input: { providerModelId: string; texts: readonly string[] }): Promise<number[][]> {
    this.calls.push({ providerModelId: input.providerModelId, count: input.texts.length });
    return input.texts.map((text) => {
      const vector = new Array<number>(EMBEDDING_DIMENSION).fill(0);
      for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
        const place = createHash('sha256').update(word).digest().readUInt32BE(0) % EMBEDDING_DIMENSION;
        vector[place] = (vector[place] ?? 0) + 1;
      }
      const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
      return length === 0 ? vector : vector.map((value) => value / length);
    });
  }
}

/**
 * Reads the text of a document version from the pages the OCR of the document module recorded (`document_page_ocr`): each page's text is in the object store under the key the row names, and its hash is
 * checked, so that a text that was changed after the OCR is not indexed. A version with no page recorded has no text to index (422).
 */
export class OcrDocumentTextPort implements DocumentTextPort {
  constructor(private readonly files: Pick<FileService, 'readStored'>) {}

  async pages(tx: TenantTx, tenant: TenantContext, documentVersionId: string): Promise<string[]> {
    const rows = await tx.query<{ page_index: number; text_object_key: string; text_sha256: string }>(
      'select page_index, text_object_key, text_sha256 from machvon.document_page_ocr where document_version_id = $1::uuid order by page_index',
      [documentVersionId],
    );
    if (rows.length === 0) throw new DomainError('VALIDATION_FAILED', 422, 'document_version_id');
    const pages: string[] = [];
    for (const row of rows) {
      const { bytes } = await this.files.readStored(tenant, row.text_object_key);
      if (createHash('sha256').update(bytes).digest('hex') !== row.text_sha256) throw new DomainError('VALIDATION_FAILED', 422, 'document_version_id');
      pages[row.page_index] = new TextDecoder().decode(bytes);
    }
    return Array.from(pages, (page) => page ?? '');
  }
}
