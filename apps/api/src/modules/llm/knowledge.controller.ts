import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { KNOWLEDGE_COLLECTION_RESOURCE, KNOWLEDGE_ITEM_RESOURCE, LlmKnowledgeStore, TenantDatabase } from '@machvon/db';
import type { KnowledgeCollection, KnowledgeItem } from '@machvon/db';
import { DomainError, asUuid } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { AiKnowledgeService, newTrack } from './knowledge.service';

const MANAGE_PERMISSION = PERMISSIONS.createAiKnowledgeCollection;
const READ_PERMISSION = PERMISSIONS.listAiKnowledgeCollections;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

/** The knowledge of a tenant is administered for the whole tenant (LLM 3, the AI admin): a grant on a subtree does not reach it. */
function assertHolds(access: EffectiveAccess, permission: string): void {
  if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
}

function limitOf(value: unknown): number {
  if (value === undefined) return DEFAULT_PAGE;
  if (typeof value !== 'string' || !/^[0-9]{1,4}$/.test(value) || Number(value) < 1 || Number(value) > MAX_PAGE) throw new DomainError('VALIDATION_FAILED', 422, 'limit');
  return Number(value);
}

/** openapi.json listAiKnowledgeCollections item. */
export function collectionView(collection: KnowledgeCollection): Record<string, unknown> {
  return {
    id: collection.id,
    code: collection.code,
    title: collection.title,
    subject_module: collection.subjectModule,
    embedding_model_id: collection.embeddingModelId,
    index_version: collection.indexVersion,
    max_classification: collection.maxClassification,
    status: collection.status,
    item_count: collection.itemCount,
    created_at: collection.createdAt,
    version: collection.version,
  };
}

function itemView(item: KnowledgeItem): Record<string, unknown> {
  return {
    id: item.id,
    document_version_id: item.documentVersionId,
    chunk_count: item.chunkCount,
    acl_hash: item.aclHash,
    status: item.status,
    classification: item.classification,
    failure_code: item.failureCode,
    indexed_at: item.indexedAt,
    stale: item.stale,
    version: item.version,
  };
}

/**
 * The knowledge collections of the AI gateway (ST-LLM-007, LLM.md F6, LLM-16): a collection is made for an approved embedding model and the highest classification it takes; a document version that was scanned
 * clean and is not above that classification is indexed into it - cut into chunks, embedded, stored with the access list it was read with - and indexed again when asked again. Retrieval is the service's: the
 * gateway puts the tenant and the access list of the asker before the distance (see `AiKnowledgeService`).
 */
@Controller('ai-knowledge-collections')
export class LlmKnowledgeController {
  private readonly store = new LlmKnowledgeStore();

  constructor(@Inject(AiKnowledgeService) private readonly knowledge: AiKnowledgeService) {}

  @Post()
  @HttpCode(200)
  @OperationId('createAiKnowledgeCollection')
  @Command({ operation: 'createAiKnowledgeCollection' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['LlmCollectionCreate']): Promise<CommandResult> {
    assertHolds(access, MANAGE_PERMISSION);
    const collection = await this.store.createCollection(
      scope.tx,
      { code: body.code, title: body.title, subjectModule: body.subject_module, embeddingModelId: body.embedding_model_id, maxClassification: body.max_classification },
      scope.tenant.membershipId,
    );
    await scope.audit({
      action: 'llm.knowledge_collection.created',
      resourceType: KNOWLEDGE_COLLECTION_RESOURCE,
      resourceId: collection.id,
      diff: { code: collection.code, subject_module: collection.subjectModule, embedding_model_id: collection.embeddingModelId, max_classification: collection.maxClassification },
    });
    await scope.emit({
      aggregateType: KNOWLEDGE_COLLECTION_RESOURCE,
      aggregateId: collection.id,
      aggregateVersion: collection.version,
      type: 'llm.collection.created.v1',
      schemaVersion: 1,
      payload: {
        collection_id: collection.id,
        code: collection.code,
        subject_module: collection.subjectModule,
        embedding_model_id: collection.embeddingModelId,
        max_classification: collection.maxClassification,
      },
      eventKey: `${KNOWLEDGE_COLLECTION_RESOURCE}:${collection.id}:created`,
    });
    return commandResult(scope, collection.status, collection.version, collection.id);
  }

  @Post(':id/items')
  @HttpCode(200)
  @OperationId('indexAiKnowledgeItem')
  @Command({ operation: 'indexAiKnowledgeItem' })
  async index(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['LlmIndexItem'],
  ): Promise<CommandResult & { chunk_count: number; acl_hash: string }> {
    assertHolds(access, MANAGE_PERMISSION);
    if (asUuid(body.document_version_id) === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'document_version_id');
    // The texts this indexing stores are taken away if it does not commit, and the ones it replaces when it does.
    const track = newTrack();
    scope.afterRollback(() => this.knowledge.discard(scope.tenant, track.created));
    scope.afterCommit(() => this.knowledge.discard(scope.tenant, track.superseded));
    const item = await this.knowledge.index(scope.tx, scope.tenant, id, body.document_version_id, track);
    await scope.audit({
      action: 'llm.knowledge_item.indexed',
      resourceType: KNOWLEDGE_ITEM_RESOURCE,
      resourceId: item.id,
      diff: { collection_id: id, document_version_id: item.documentVersionId, chunk_count: item.chunkCount, acl_hash: item.aclHash, classification: item.classification },
    });
    await scope.emit({
      aggregateType: KNOWLEDGE_ITEM_RESOURCE,
      aggregateId: item.id,
      aggregateVersion: item.version,
      type: 'llm.collection.item_indexed.v1',
      schemaVersion: 1,
      payload: { collection_id: id, item_id: item.id, document_version_id: item.documentVersionId, chunk_count: item.chunkCount, acl_hash: item.aclHash },
      eventKey: `${KNOWLEDGE_ITEM_RESOURCE}:${item.id}:${item.version}`,
    });
    return { ...commandResult(scope, item.status, item.version, item.id), chunk_count: item.chunkCount, acl_hash: item.aclHash };
  }
}

/** Reads of the knowledge collections (LLM-16): the list, and one collection with its items, the ones that wait to be indexed again marked. */
@Controller('ai-knowledge-collections')
export class LlmKnowledgeReadsController {
  private readonly store = new LlmKnowledgeStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('listAiKnowledgeCollections')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('status') status?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    assertHolds(access, READ_PERMISSION);
    const page = await this.database.withTenant(tenant, (tx) =>
      this.store.listCollections(tx, { status: typeof status === 'string' ? status : undefined, cursor: typeof cursor === 'string' ? cursor : undefined, limit: limitOf(limit) }),
    );
    return { items: page.items.map(collectionView), next_cursor: page.next };
  }

  @Get(':id')
  @OperationId('getAiKnowledgeCollection')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    assertHolds(access, READ_PERMISSION);
    return this.database.withTenant(tenant, async (tx) => {
      const collection = await this.store.findCollection(tx, id);
      if (collection === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      return { ...collectionView(collection), items: (await this.store.itemsOf(tx, id)).map(itemView) };
    });
  }
}
