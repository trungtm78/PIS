import { DomainError, assertEmbedding, assertWithin, checkCollection, retrievalLimit, routesFor } from '@machvon/kernel';
import type { KnowledgeChunk, KnowledgeCollectionInput } from '@machvon/kernel';
import { cursorFor, cursorOf } from './dgv-keyset.ts';
import { NOT_SEALED, VERSION_JOINS } from './document-store.ts';
import { LlmRegistryStore } from './llm-registry-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The knowledge collections of the AI gateway and the retrieval over them (ST-LLM-007, LLM.md F6, BR-LLM-11, LLM-16, UAT-AC467, UAT-AC14). A collection is made for an approved embedding model and takes documents up to a
 * classification; an item is a clean document version indexed into it, with the hash of what governs who may read the document; a chunk is a piece of a page with its embedding. Who may read a document is decided
 * by the document module: the scope of the reads of document versions (`versionScope`), the unit that issues the document or, for an incoming letter, its register, the unit it was given to and who took it in.
 * Retrieval puts the tenant, the collection and that scope in front of the distance, and offers a chunk only while the item was indexed under the hash the document has now (a document whose governing unit or
 * classification changed is withheld from everybody until it is indexed again).
 */
export const KNOWLEDGE_COLLECTION_RESOURCE = 'ai_knowledge_collection';
export const KNOWLEDGE_ITEM_RESOURCE = 'ai_knowledge_item';
const MAX_PAGE = 200;
const UNIQUE_VIOLATION = '23505';

interface Sql {
  [column: string]: unknown;
  id: string;
  code: string;
  title: string;
  subject_module: string;
  embedding_model_id: string;
  index_version: number;
  max_classification: string;
  status: string;
  item_count: number;
  created_at: string;
  classification: string | null;
  descriptor: Record<string, unknown>;
  acl_hash: string;
  collection_id: string;
  document_version_id: string;
  chunk_count: number;
  failure_code: string | null;
  indexed_at: string | null;
  page_index: number;
  chunk_no: number;
  text_object_key: string;
  text_sha256: string;
}

export interface KnowledgeCollection {
  id: string;
  code: string;
  title: string;
  subjectModule: string;
  embeddingModelId: string;
  indexVersion: number;
  maxClassification: string;
  status: string;
  itemCount: number;
  createdAt: string;
  version: number;
}

export interface KnowledgeItem {
  id: string;
  collectionId: string;
  documentVersionId: string;
  chunkCount: number;
  aclHash: string;
  status: string;
  classification: string | null;
  failureCode: string | null;
  indexedAt: string | null;
  /** What governs the reading of the document is not what it was when the item was indexed: the item waits to be indexed again. */
  stale: boolean;
  version: number;
}

export interface KnowledgePage {
  items: KnowledgeCollection[];
  next: string | null;
}

/** What the indexing needs to know about a document version before it reads it. */
export interface IndexTarget {
  collection: KnowledgeCollection;
  documentVersionId: string;
  classification: string;
  /** What governs who may read the document, as the table holds it now, and its hash. */
  descriptor: Record<string, unknown>;
  aclHash: string;
  /** The model the collection embeds with, as the gateway knows it. */
  model: EmbeddingModel;
}

/** The model a collection embeds with: the id it is called by at its provider, and the ids a switch of the emergency stop names it by. */
export interface EmbeddingModel {
  providerModelId: string;
  modelRefId: string;
  providerId: string;
}

export interface ChunkToStore extends KnowledgeChunk {
  textSha256: string;
  textObjectKey: string;
  embedding: readonly number[];
}

export interface RetrievedChunk {
  chunkId: string;
  documentVersionId: string;
  pageIndex: number;
  chunkNo: number;
  textObjectKey: string;
  textSha256: string;
  classification: string;
  distance: number;
}

const COLLECTION_SELECT = `select c.id, c.code, c.title, c.subject_module, c.embedding_model_id, c.index_version, c.max_classification, c.status, c.created_at::text as created_at, c.version::text as version,
  (select count(*)::int from machvon.ai_knowledge_item i where i.collection_id = c.id and i.status <> 'REMOVED') as item_count from machvon.ai_knowledge_collection c`;

const collectionOf = (row: Sql): KnowledgeCollection => ({
  id: row.id,
  code: row.code,
  title: row.title,
  subjectModule: row.subject_module,
  embeddingModelId: row.embedding_model_id,
  indexVersion: row.index_version,
  maxClassification: row.max_classification,
  status: row.status,
  itemCount: row.item_count,
  createdAt: row.created_at,
  version: Number(row.version),
});

/**
 * What governs who may read a document version, as the scope of the reads of versions reads it (aliases of the joins of the document store): the classification, the unit that issues the document and, for an
 * incoming letter, the unit of its register, the unit it was given to and who took it in. The hash of it is the `acl_hash` of the chunks: when it changes, the chunks were indexed under another ACL.
 */
const DESCRIPTOR = `jsonb_build_object('classification', v.classification, 'issuer', d.issuer_unit_id, 'home', ir.organization_unit_id, 'given', inc.assigned_unit_id, 'receiver', inc.received_by)`;
const ACL_HASH = `encode(sha256(convert_to((${DESCRIPTOR})::text, 'UTF8')), 'hex')`;
/** The hash the document of the item `item` has now (null when the document is gone). */
const currentHash = (item: string): string => `(select ${ACL_HASH} from machvon.document_version v ${VERSION_JOINS} where v.tenant_id = ${item}.tenant_id and v.id = ${item}.document_version_id)`;

export class LlmKnowledgeStore {
  /** Whether the embeddings are held as pgvector (the nearest-neighbour index and the operator of distance) or as plain arrays (the TEST profile). */
  private native: boolean | undefined;

  private async vectorNative(tx: TenantTx): Promise<boolean> {
    if (this.native === undefined) {
      const rows = await tx.query<{ udt_name: string }>("select udt_name from information_schema.columns where table_schema = 'machvon' and table_name = 'ai_chunk' and column_name = 'embedding'");
      this.native = rows[0]?.udt_name === 'vector';
    }
    return this.native;
  }

  async findCollection(tx: TenantTx, id: string): Promise<KnowledgeCollection | undefined> {
    const rows = await tx.query<Sql>(`${COLLECTION_SELECT} where c.id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : collectionOf(rows[0]);
  }

  async listCollections(tx: TenantTx, filter: { status?: string | undefined; cursor?: string | undefined; limit: number }): Promise<KnowledgePage> {
    if (filter.status !== undefined && !['ACTIVE', 'REINDEXING', 'RETIRED'].includes(filter.status)) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const limit = Math.min(filter.limit, MAX_PAGE);
    const after = cursorOf(filter.cursor);
    const rows = await tx.query<Sql>(
      `${COLLECTION_SELECT} where ($1::text is null or c.status = $1) and ($2::timestamptz is null or (c.created_at, c.id) < ($2::timestamptz, $3::uuid)) order by c.created_at desc, c.id desc limit $4::int`,
      [filter.status ?? null, after?.at ?? null, after?.id ?? null, limit + 1],
    );
    const page = rows.slice(0, limit).map(collectionOf);
    const last = page[page.length - 1];
    return { items: page, next: rows.length > limit && last !== undefined ? cursorFor(last.createdAt, last.id) : null };
  }

  /** The items of a collection, the stale ones marked: those whose document is governed by something else now than when they were indexed. */
  async itemsOf(tx: TenantTx, collectionId: string): Promise<KnowledgeItem[]> {
    const rows = await tx.query<Sql>(
      `select i.id, i.collection_id, i.document_version_id, i.chunk_count, i.acl_hash, i.status, i.classification, i.failure_code, i.indexed_at::text as indexed_at, i.version::text as version,
              (i.status = 'INDEXED' and i.acl_hash is distinct from ${currentHash('i')}) as stale
         from machvon.ai_knowledge_item i where i.collection_id = $1::uuid order by i.created_at, i.id`,
      [collectionId],
    );
    return rows.map((row) => ({
      id: row.id,
      collectionId: row.collection_id,
      documentVersionId: row.document_version_id,
      chunkCount: row.chunk_count,
      aclHash: row.acl_hash,
      status: row.status,
      classification: row.classification,
      failureCode: row.failure_code,
      indexedAt: row.indexed_at,
      stale: row.stale === true,
      version: Number(row.version),
    }));
  }

  /**
   * The items that are indexed and whose document is governed by something else now: what the job indexes again, the ones touched longest ago first (an item that could not be indexed again is touched, and
   * so goes to the back).
   */
  async staleItems(tx: TenantTx, limit: number): Promise<Array<{ collectionId: string; documentVersionId: string }>> {
    const rows = await tx.query<Sql>(
      `select i.collection_id, i.document_version_id
         from machvon.ai_knowledge_item i join machvon.ai_knowledge_collection c on c.tenant_id = i.tenant_id and c.id = i.collection_id
        where i.status = 'INDEXED' and c.status = 'ACTIVE' and i.acl_hash is distinct from ${currentHash('i')}
        order by i.updated_at, i.id limit $1::int`,
      [limit],
    );
    return rows.map((row) => ({ collectionId: row.collection_id, documentVersionId: row.document_version_id }));
  }

  /**
   * Makes a collection for an embedding model of the tenant: the model has to be APPROVED (422 `MODEL_NOT_APPROVED`), has to be one that embeds (`capabilities.embedding`) and has to be cleared for the highest classification
   * the collection takes (422 `VALIDATION_FAILED` naming the field). A code is the tenant's once (409 `DUPLICATE_KEY`).
   */
  async createCollection(tx: TenantTx, input: KnowledgeCollectionInput, actor: string): Promise<KnowledgeCollection> {
    const made = checkCollection(input);
    const models = await tx.query<Sql>('select status, capabilities, max_classification from machvon.ai_model where id = $1::uuid', [made.embeddingModelId]);
    const model = models[0];
    if (model === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'embedding_model_id');
    if (model.status !== 'APPROVED') throw new DomainError('MODEL_NOT_APPROVED', 422, 'embedding_model_id');
    if ((model.capabilities as { embedding?: unknown } | null)?.embedding !== true) throw new DomainError('VALIDATION_FAILED', 422, 'embedding_model_id');
    try {
      assertWithin(made.maxClassification, model.max_classification);
    } catch {
      throw new DomainError('VALIDATION_FAILED', 422, 'max_classification');
    }
    try {
      const rows = await tx.query<{ id: string }>(
        `insert into machvon.ai_knowledge_collection (tenant_id, id, code, title, subject_module, embedding_model_id, max_classification, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2, $3, $4::uuid, $5, $6::uuid, $6::uuid) returning id`,
        [made.code, made.title, made.subjectModule, made.embeddingModelId, made.maxClassification, actor],
      );
      return (await this.findCollection(tx, (rows[0] as { id: string }).id)) as KnowledgeCollection;
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new DomainError('DUPLICATE_KEY', 409, 'code');
      throw error;
    }
  }

  /**
   * The model a collection embeds with, while it can be called: the model is APPROVED (422 `MODEL_NOT_APPROVED`) and its provider is ACTIVE (503 `PROVIDER_UNAVAILABLE`), as the gateway requires - a collection
   * made for a model does not keep the right to use it when the approval is gone.
   */
  async providerModelOf(tx: TenantTx, embeddingModelId: string): Promise<EmbeddingModel> {
    const models = await tx.query<{ model_id: string; status: string; provider_id: string; provider_status: string }>(
      'select m.model_id, m.status, m.provider_id, p.status as provider_status from machvon.ai_model m join machvon.ai_provider p on p.tenant_id = m.tenant_id and p.id = m.provider_id where m.id = $1::uuid',
      [embeddingModelId],
    );
    const model = models[0];
    if (model === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (model.status !== 'APPROVED') throw new DomainError('MODEL_NOT_APPROVED', 422, 'embedding_model_id');
    if (model.provider_status !== 'ACTIVE') throw new DomainError('PROVIDER_UNAVAILABLE', 503, 'embedding_model_id');
    return { providerModelId: model.model_id, modelRefId: embeddingModelId.toLowerCase(), providerId: model.provider_id };
  }

  /**
   * The model that embeds passages a caller has already chosen, for passages of a class: it is one that embeds (422), is approved and on an active provider (as for a collection), takes the class (422), and is
   * reached over a route the policy in force allows for the class (422 `AI_ROUTE_NOT_ALLOWED`): the text is sent nowhere else, as for a completion.
   */
  async rankingModel(tx: TenantTx, embeddingModelId: string, classification: string): Promise<EmbeddingModel> {
    const model = await this.providerModelOf(tx, embeddingModelId);
    const rows = await tx.query<{ capabilities: { embedding?: unknown } | null; max_classification: string; route_class: string }>(
      'select m.capabilities, m.max_classification, p.route_class from machvon.ai_model m join machvon.ai_provider p on p.tenant_id = m.tenant_id and p.id = m.provider_id where m.id = $1::uuid',
      [embeddingModelId],
    );
    const row = rows[0] as { capabilities: { embedding?: unknown } | null; max_classification: string; route_class: string };
    if (row.capabilities?.embedding !== true) throw new DomainError('VALIDATION_FAILED', 422, 'embedding_model_id');
    try {
      assertWithin(classification, row.max_classification);
    } catch {
      throw new DomainError('VALIDATION_FAILED', 422, 'embedding_model_id');
    }
    const inForce = await new LlmRegistryStore().published(tx);
    const allowed = routesFor(classification as Parameters<typeof routesFor>[0], inForce === undefined ? undefined : { matrix: inForce.matrix, internationalEnabled: inForce.internationalEnabled });
    if (!allowed.includes(row.route_class as (typeof allowed)[number])) throw new DomainError('AI_ROUTE_NOT_ALLOWED', 422, 'embedding_model_id');
    return model;
  }

  /**
   * An item that could not be indexed again keeps what it has and moves to the back of the queue: the job reads the items in the order they were last touched, so the ones that fail cannot hold the
   * place of the ones that can be mended.
   */
  async noteFailure(tx: TenantTx, collectionId: string, documentVersionId: string, code: string): Promise<void> {
    await tx.query("update machvon.ai_knowledge_item set failure_code = $3, updated_at = now() where collection_id = $1::uuid and document_version_id = $2::uuid and status = 'INDEXED'", [
      collectionId,
      documentVersionId,
      code.slice(0, 100),
    ]);
  }

  /**
   * What has to hold before a document version is read for a collection: the collection is open (409 `STAGE_TRANSITION_DENIED`), the version is the tenant's (404), it was scanned clean (409 `SCAN_PENDING`
   * while it waits, 422 `FILE_NOT_CLEAN` when it is infected) and its classification is not above the collection's (422 `CLASSIFICATION_ABOVE_COLLECTION`). The collection row is held.
   */
  async prepare(tx: TenantTx, collectionId: string, documentVersionId: string): Promise<IndexTarget> {
    const locked = await tx.query('select 1 from machvon.ai_knowledge_collection where id = $1::uuid for update', [collectionId]);
    if (locked.length === 0) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const collection = (await this.findCollection(tx, collectionId)) as KnowledgeCollection;
    if (collection.status !== 'ACTIVE') throw new DomainError('STAGE_TRANSITION_DENIED', 409, collection.status);
    const versions = await tx.query<Sql>(
      `select v.classification, v.scan_status, (${DESCRIPTOR}) as descriptor, ${ACL_HASH} as acl_hash from machvon.document_version v ${VERSION_JOINS} where v.id = $1::uuid and ${NOT_SEALED}`,
      [documentVersionId],
    );
    const version = versions[0];
    if (version === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (version.scan_status === 'INFECTED') throw new DomainError('FILE_NOT_CLEAN', 422);
    if (version.scan_status !== 'CLEAN') throw new DomainError('SCAN_PENDING', 409);
    assertWithin(version.classification as string, collection.maxClassification);
    return {
      collection,
      documentVersionId,
      classification: version.classification as string,
      descriptor: version.descriptor,
      aclHash: version.acl_hash,
      model: await this.providerModelOf(tx, collection.embeddingModelId),
    };
  }

  /**
   * Writes the chunks of a document version into a collection, in place of the ones it had (indexing it again is the same call), and records the item as INDEXED under the access list it was read with. The item
   * is held while this runs, so that two indexings of one document do not interleave.
   */
  async store(tx: TenantTx, target: IndexTarget, chunks: readonly ChunkToStore[]): Promise<{ item: KnowledgeItem; superseded: string[] }> {
    if (chunks.length === 0) throw new DomainError('VALIDATION_FAILED', 422, 'document_version_id');
    for (const chunk of chunks) assertEmbedding(chunk.embedding);
    const native = await this.vectorNative(tx);
    await tx.query(
      `insert into machvon.ai_knowledge_item (tenant_id, id, collection_id, document_version_id, chunk_count, acl_hash, status)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, 0, $3, 'PENDING') on conflict (tenant_id, collection_id, document_version_id) do nothing`,
      [target.collection.id, target.documentVersionId, target.aclHash],
    );
    const held = await tx.query<{ id: string; status: string }>('select id, status from machvon.ai_knowledge_item where collection_id = $1::uuid and document_version_id = $2::uuid for update', [
      target.collection.id,
      target.documentVersionId,
    ]);
    const item = held[0] as { id: string; status: string };
    if (item.status === 'REMOVED') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'REMOVED');
    const before = await tx.query<{ text_object_key: string }>('select text_object_key from machvon.ai_chunk where collection_id = $1::uuid and document_version_id = $2::uuid', [
      target.collection.id,
      target.documentVersionId,
    ]);
    await tx.query('delete from machvon.ai_chunk where collection_id = $1::uuid and document_version_id = $2::uuid', [target.collection.id, target.documentVersionId]);
    for (const chunk of chunks) {
      await tx.query(
        `insert into machvon.ai_chunk (tenant_id, id, collection_id, document_version_id, page_index, chunk_no, text_sha256, text_object_key, embedding, acl_hash, classification)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5, $6, ${native ? '$7::vector' : '$7::real[]'}, $8, $9)`,
        [
          target.collection.id,
          target.documentVersionId,
          chunk.pageIndex,
          chunk.chunkNo,
          chunk.textSha256,
          chunk.textObjectKey,
          native ? `[${chunk.embedding.join(',')}]` : [...chunk.embedding],
          target.aclHash,
          target.classification,
        ],
      );
    }
    await tx.query(
      `update machvon.ai_knowledge_item set status = 'INDEXED', chunk_count = $2, acl_hash = $3, acl_json = $4::jsonb, classification = $5, failure_code = null, indexed_at = now(), updated_at = now(), version = version + 1
        where id = $1::uuid`,
      [item.id, chunks.length, target.aclHash, JSON.stringify(target.descriptor), target.classification],
    );
    const items = await this.itemsOf(tx, target.collection.id);
    return { item: items.find((candidate) => candidate.id === item.id) as KnowledgeItem, superseded: before.map((row) => row.text_object_key) };
  }

  /**
   * The chunks of a collection that are nearest to a question, for a member. The tenant, the collection and the scope of the reads of document versions - the member's own, built by the caller from their
   * grants - come before the distance: a chunk is a candidate only when its item is INDEXED under the hash the chunk carries and the document has now (a document governed otherwise since is withheld until it is
   * indexed again), the document is not a sealed proposal, and (when the caller narrows it) the document version is among `only`. A document the member may not read is not in the candidates, so its id cannot come
   * back.
   */
  async retrieve(
    tx: TenantTx,
    input: { collectionId: string; embedding: readonly number[]; scope: ScopeBuilder; limit?: number | undefined; only?: readonly string[] | undefined },
  ): Promise<RetrievedChunk[]> {
    assertEmbedding(input.embedding);
    const limit = retrievalLimit(input.limit);
    const native = await this.vectorNative(tx);
    const distance = native
      ? 'c.embedding <=> $2::vector'
      : '1 - (select sum(a * b) from unnest(c.embedding, $2::real[]) as t(a, b)) / nullif(sqrt((select sum(a * a) from unnest(c.embedding) as u(a))) * sqrt((select sum(b * b) from unnest($2::real[]) as w(b))), 0)';
    const scope = input.scope(5);
    const rows = await tx.query<Sql>(
      `select c.id, c.document_version_id, c.page_index, c.chunk_no, c.text_object_key, c.text_sha256, c.classification, (${distance}) as distance
         from machvon.ai_chunk c
         join machvon.ai_knowledge_item i on i.tenant_id = c.tenant_id and i.collection_id = c.collection_id and i.document_version_id = c.document_version_id and i.status = 'INDEXED' and i.acl_hash = c.acl_hash
         join machvon.ai_knowledge_collection k on k.tenant_id = c.tenant_id and k.id = c.collection_id and k.status <> 'RETIRED'
         join machvon.document_version v on v.tenant_id = c.tenant_id and v.id = c.document_version_id
         ${VERSION_JOINS}
        where c.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid and c.collection_id = $1::uuid
          and c.acl_hash = ${ACL_HASH}
          and ${NOT_SEALED}
          and ${scope.sql}
          and ($3::uuid[] is null or c.document_version_id = any($3::uuid[]))
        order by distance asc nulls last, c.id limit $4::int`,
      [input.collectionId, native ? `[${input.embedding.join(',')}]` : [...input.embedding], input.only === undefined ? null : [...input.only], limit, ...scope.params],
    );
    return rows.map((row) => ({
      chunkId: row.id,
      documentVersionId: row.document_version_id,
      pageIndex: row.page_index,
      chunkNo: row.chunk_no,
      textObjectKey: row.text_object_key,
      textSha256: row.text_sha256,
      classification: row.classification as string,
      distance: Number(row.distance),
    }));
  }
}
