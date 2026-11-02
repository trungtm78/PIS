import { createHash, randomUUID } from 'node:crypto';
import { PERMISSIONS } from '@machvon/contracts';
import { LlmEmergencyStore, LlmKnowledgeStore, versionScope } from '@machvon/db';
import type { AuditWriter, ChunkToStore, EmbeddingModel, KnowledgeItem, RetrievedChunk, TenantDatabase, TenantTx } from '@machvon/db';
import { DomainError, assertEmbedding, chunkPages, cosineDistance, killedBy, retrievalLimit } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import type { FileService } from '../files';
import type { AiEmbeddingPort, DocumentTextPort } from './knowledge-ports';

/** A chunk that retrieval hands back: where it comes from and what it says. */
export interface RetrievedPassage {
  chunkId: string;
  documentVersionId: string;
  pageIndex: number;
  chunkNo: number;
  classification: string;
  distance: number;
  text: string;
}

const KIND = 'ai-chunk';
/** What a member needs to hold, over the unit that governs a document, to have it in an answer: the right to read document versions. */
const READ_PERMISSION = PERMISSIONS.get_resources_document_version;
/** The task type a switch of the emergency stop names to stop the embedding of texts. */
const TASK_TYPE = 'EMBEDDING';
const RETRIEVAL_ATTEMPTS = 3;

/** The stored texts that one indexing made and the ones it replaced: the first are taken away when it did not commit, the second when it did. */
export interface IndexTrack {
  created: string[];
  superseded: string[];
}
export const newTrack = (): IndexTrack => ({ created: [], superseded: [] });
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * The indexing and the retrieval of the knowledge collections (ST-LLM-007, LLM.md F6): a document version is read page by page, cut into chunks, embedded by the model of the collection and stored with the
 * access list it was read with; a question is embedded by the same model and answered with the chunks of the documents the asker may read, the tenant and the access list coming before the distance. What is
 * written to the log of a retrieval is the hash of the question and the chunks that were returned - never the ids of what the asker may not read, which are not known to the query that was run.
 */
export class AiKnowledgeService {
  private readonly store = new LlmKnowledgeStore();
  private readonly emergency = new LlmEmergencyStore();

  constructor(
    private readonly embeddings: AiEmbeddingPort,
    private readonly texts: DocumentTextPort,
    private readonly files: Pick<FileService, 'storeGenerated' | 'readStored' | 'remove'>,
    private readonly audit?: Pick<AuditWriter, 'recordInTx'>,
  ) {}

  /** Indexes a document version into a collection (or indexes it again: the chunks it had are replaced) in the transaction given. */
  async index(tx: TenantTx, tenant: TenantContext, collectionId: string, documentVersionId: string, track: IndexTrack = newTrack()): Promise<KnowledgeItem> {
    const target = await this.store.prepare(tx, collectionId, documentVersionId);
    await this.assertRunning(tx, target.model);
    const chunks = chunkPages(await this.texts.pages(tx, tenant, documentVersionId));
    if (chunks.length === 0) throw new DomainError('VALIDATION_FAILED', 422, 'document_version_id');
    const vectors = await this.embeddings.embed({ providerModelId: target.model.providerModelId, texts: chunks.map((chunk) => chunk.text) });
    if (vectors.length !== chunks.length) throw new DomainError('VALIDATION_FAILED', 422, 'embedding');
    const toStore: ChunkToStore[] = [];
    for (const [position, chunk] of chunks.entries()) {
      const bytes = new TextEncoder().encode(chunk.text);
      const textObjectKey = await this.files.storeGenerated(tenant, KIND, randomUUID(), bytes, 'text/plain');
      track.created.push(textObjectKey);
      toStore.push({ ...chunk, textSha256: sha256(bytes), textObjectKey, embedding: vectors[position] as number[] });
    }
    const stored = await this.store.store(tx, target, toStore);
    track.superseded.push(...stored.superseded);
    return stored.item;
  }

  /** A switch of the emergency stop - of the tenant, of the provider or of the model - stops the embedding as it stops the gateway (503 `AI_KILL_SWITCH_ENGAGED`); Postgres is read at every call (BR-LLM-12). */
  private async assertRunning(tx: TenantTx, model: EmbeddingModel): Promise<void> {
    const stopped = killedBy(await this.emergency.engaged(tx), { taskType: TASK_TYPE, providerId: model.providerId, modelRefId: model.modelRefId });
    if (stopped !== undefined) throw new DomainError('AI_KILL_SWITCH_ENGAGED', 503, stopped.scopeKind);
  }

  /** Takes stored texts away; one that cannot be taken away is left for the sweep of its kind, and the others still go. */
  async discard(tenant: TenantContext, keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      try {
        await this.files.remove(tenant, key);
      } catch {
        // Left in the store: nothing refers to it.
      }
    }
  }

  /** Indexes again the items whose document carries another access list now; returns how many were indexed. An item that cannot be indexed again (the file is gone, the model is not approved any more) is left as it is. */
  async reindexStale(tenants: TenantDatabase, tenant: TenantContext, limit: number): Promise<number> {
    const stale = await tenants.withTenant(tenant, (tx) => this.store.staleItems(tx, limit));
    let done = 0;
    for (const item of stale) {
      const track = newTrack();
      try {
        await tenants.withTenant(tenant, async (tx) => {
          const indexed = await this.index(tx, tenant, item.collectionId, item.documentVersionId, track);
          await this.audit?.recordInTx(tx, tenant.membershipId, {
            action: 'llm.knowledge.reindexed',
            resourceType: 'ai_knowledge_item',
            resourceId: indexed.id,
            diff: { collection_id: item.collectionId, document_version_id: item.documentVersionId, acl_hash: indexed.aclHash, chunk_count: indexed.chunkCount },
            correlationId: randomUUID(),
            requestId: randomUUID(),
          });
        });
        await this.discard(tenant, track.superseded);
        done += 1;
      } catch (error) {
        // The item stays as it is, still readable only by those on both lists; it goes to the back of the queue, so that the ones behind it are reached, and the texts this try stored are taken away.
        await this.discard(tenant, track.created);
        const code = error instanceof DomainError ? error.code : 'INDEX_FAILED';
        await tenants.withTenant(tenant, (tx) => this.store.noteFailure(tx, item.collectionId, item.documentVersionId, code)).catch(() => undefined);
      }
    }
    return done;
  }

  /**
   * Answers a question with the passages of a collection that the member may read. `only` narrows it to document versions the caller has decided the member may use (a recused evaluator is given the proposals
   * that are not forbidden to them), and is only ever a narrowing: the access lists are applied in any case.
   */
  async retrieve(
    tenants: TenantDatabase,
    tenant: TenantContext,
    input: { access: EffectiveAccess; collectionId: string; question: string; limit?: number; only?: readonly string[] },
  ): Promise<RetrievedPassage[]> {
    const question = input.question.trim();
    if (question === '' || question.length > 4000) throw new DomainError('VALIDATION_FAILED', 422, 'question');
    const prepared = await tenants.withTenant(tenant, async (tx) => {
      const collection = await this.store.findCollection(tx, input.collectionId);
      if (collection === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      // A collection that was retired is withdrawn from the answers as well as from the indexing.
      if (collection.status === 'RETIRED') throw new DomainError('STAGE_TRANSITION_DENIED', 409, collection.status);
      const model = await this.store.providerModelOf(tx, collection.embeddingModelId);
      await this.assertRunning(tx, model);
      return { collection, model };
    });
    const [embedding] = await this.embeddings.embed({ providerModelId: prepared.model.providerModelId, texts: [question] });
    // An indexing that commits between the query and the reading of the texts takes away the texts the query named. The chunks are then asked for again (they are the ones that replaced them), a few times.
    for (let attempt = 1; ; attempt += 1) {
      const found = await tenants.withTenant(tenant, (tx) =>
        this.store.retrieve(tx, {
          collectionId: input.collectionId,
          embedding: embedding as number[],
          scope: versionScope(input.access, READ_PERMISSION, new Date(), tenant.membershipId),
          limit: input.limit,
          only: input.only,
        }),
      );
      try {
        const passages = await this.passagesOf(tenant, found);
        await tenants.withTenant(tenant, async (tx) => {
          await this.audit?.recordInTx(tx, tenant.membershipId, {
            action: 'llm.knowledge.retrieved',
            resourceType: 'ai_knowledge_collection',
            resourceId: input.collectionId,
            diff: {
              question_sha256: sha256(new TextEncoder().encode(question)),
              count: found.length,
              chunk_ids: found.map((chunk) => chunk.chunkId),
              document_version_ids: [...new Set(found.map((chunk) => chunk.documentVersionId))],
            },
            correlationId: randomUUID(),
            requestId: randomUUID(),
          });
        });
        return passages;
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'RESOURCE_NOT_FOUND' || attempt >= RETRIEVAL_ATTEMPTS) throw error;
      }
    }
  }

  /**
   * Orders passages the caller has already chosen by their nearness to a question, with the embedding model given (a proposal is not in any collection: it is sealed, and the module that owns it decides who may read which
   * file). The passages are the only candidates, so what the asker may not read is never embedded or compared. The model must embed, take the class of the passages and not be reached over a route the class forbids; a
   * switch of the emergency stop stops it as it stops the indexing. Nothing but the hash of the question and the references of the passages that came back is logged.
   */
  async rank(
    tenants: TenantDatabase,
    tenant: TenantContext,
    input: { embeddingModelId: string; classification: string; question: string; passages: ReadonlyArray<{ ref: string; text: string }>; limit?: number },
  ): Promise<Array<{ ref: string; distance: number }>> {
    const question = input.question.trim();
    if (question === '' || question.length > 4000) throw new DomainError('VALIDATION_FAILED', 422, 'question');
    const limit = retrievalLimit(input.limit);
    const model = await tenants.withTenant(tenant, async (tx) => {
      const found = await this.store.rankingModel(tx, input.embeddingModelId, input.classification);
      await this.assertRunning(tx, found);
      return found;
    });
    if (input.passages.length === 0) return [];
    const vectors = await this.embeddings.embed({ providerModelId: model.providerModelId, texts: [question, ...input.passages.map((passage) => passage.text)] });
    if (vectors.length !== input.passages.length + 1) throw new DomainError('VALIDATION_FAILED', 422, 'embedding');
    for (const vector of vectors) assertEmbedding(vector);
    const [asked, ...found] = vectors as [number[], ...number[][]];
    const ranked = input.passages
      .map((passage, place) => ({ ref: passage.ref, distance: cosineDistance(asked, found[place] as number[]) }))
      .sort((left, right) => left.distance - right.distance || left.ref.localeCompare(right.ref))
      .slice(0, limit);
    await tenants.withTenant(tenant, async (tx) => {
      await this.audit?.recordInTx(tx, tenant.membershipId, {
        action: 'llm.knowledge.ranked',
        resourceType: 'ai_model',
        resourceId: input.embeddingModelId,
        diff: { question_sha256: sha256(new TextEncoder().encode(question)), candidates: input.passages.length, refs: ranked.map((entry) => entry.ref) },
        correlationId: randomUUID(),
        requestId: randomUUID(),
      });
    });
    return ranked;
  }

  /** The text of each chunk, read from the object store and checked against the hash the chunk carries. */
  private async passagesOf(tenant: TenantContext, found: readonly RetrievedChunk[]): Promise<RetrievedPassage[]> {
    const passages: RetrievedPassage[] = [];
    for (const chunk of found) {
      const { bytes } = await this.files.readStored(tenant, chunk.textObjectKey);
      if (sha256(bytes) !== chunk.textSha256) throw new DomainError('VALIDATION_FAILED', 422, 'text_sha256');
      passages.push({
        chunkId: chunk.chunkId,
        documentVersionId: chunk.documentVersionId,
        pageIndex: chunk.pageIndex,
        chunkNo: chunk.chunkNo,
        classification: chunk.classification,
        distance: chunk.distance,
        text: new TextDecoder().decode(bytes),
      });
    }
    return passages;
  }
}
