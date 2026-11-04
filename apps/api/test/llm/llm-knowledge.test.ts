import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_FILTER } from '@nestjs/core';
import { AuditWriter, EffectiveAccessStore, InMemoryAuthzCache, LlmEmergencyStore, LlmKnowledgeStore, TenantDatabase, versionScope } from '@machvon/db';
import { DomainError, loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { llmModule } from '../../src/modules/llm';
import { LlmKnowledgeController, LlmKnowledgeReadsController } from '../../src/modules/llm/knowledge.controller';
import { MockEmbeddingPort, OcrDocumentTextPort } from '../../src/modules/llm/knowledge-ports';
import { AiKnowledgeService } from '../../src/modules/llm/knowledge.service';
import { FileService } from '../../src/modules/files/file.service';
import { FsObjectStorage } from '../../src/modules/files/fs-object-storage';
import { MockScanPort } from '../../src/modules/files/mock-scan';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, roleId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';
import { asObjects, asString } from '../support/json';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const ADMIN = 1; // llm.knowledge.manage and llm.knowledge.read
const READER = 2; // llm.knowledge.read
const NOBODY = 3;
const UNIT_ONLY = 4; // llm.knowledge.manage on one unit, not the tenant
const STC = 5; // the member the document is for
const BQL1 = 6; // a member who is added to the list later
const B_ADMIN = 7; // of tenant B
const B_USER = 8; // of tenant B, on the list of the document of tenant B
const WORKER = 9;
const LOSER = 10; // reads what unit 2 governs, until the grant is revoked

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const TEXT = 'Quy trình thẩm định dự án đầu tư công gồm ba bước: tiếp nhận hồ sơ, thẩm định nội dung và trình phê duyệt.\n\nMỗi bước có thời hạn xử lý riêng và người chịu trách nhiệm riêng.';

describe('knowledge collections: indexing and retrieval filtered by tenant and access list (ST-LLM-007, LLM.md F6, UAT-AC467, UAT-AC14)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let root: string;
  let files: FileService;
  let tenants: TenantDatabase;
  let embeddings: MockEmbeddingPort;
  let knowledge: AiKnowledgeService;
  let counter = 0;
  const modelOf: Record<string, string> = {};

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const context = (member = WORKER, tenantId = TENANT_A) => ({ tenantId, membershipId: memberId(member), scopeVersion: 1 });

  /** A model of the tenant that embeds (or one that does not, or is not approved). */
  async function model(over: { status?: string; embedding?: boolean; max?: string } = {}, tenantId = TENANT_A): Promise<string> {
    const providerId = randomUUID();
    const id = randomUUID();
    await rows(
      `insert into machvon.ai_provider (tenant_id, id, provider_code, name, region_country, route_class, max_classification, status, created_by, updated_by)
       values ($1, $2, $3, 'Embedding host', 'VN', 'SELF_HOSTED', 'IMPORTANT_CORE', 'ACTIVE', $4, $4)`,
      [tenantId, providerId, `EMB-${providerId.slice(0, 8)}`, memberId(WORKER)],
      tenantId,
    );
    await rows(
      `insert into machvon.ai_model (tenant_id, id, provider_id, model_id, capabilities, context_window, max_output, max_classification, status, created_by, updated_by)
       values ($1, $2, $3, $4, $5::jsonb, 8000, 1000, $6, $7, $8, $8)`,
      [
        tenantId,
        id,
        providerId,
        `bge-m3-${id.slice(0, 6)}`,
        JSON.stringify(over.embedding === false ? {} : { embedding: true }),
        over.max ?? 'CONFIDENTIAL',
        over.status ?? 'APPROVED',
        memberId(WORKER),
      ],
      tenantId,
    );
    modelOf[id] = tenantId;
    return id;
  }
  const collectionBody = (modelId: string, over: Record<string, unknown> = {}) => ({
    code: `KB-${(counter += 1)}`,
    title: 'Hồ sơ thẩm định',
    subject_module: 'PRJ',
    embedding_model_id: modelId,
    max_classification: 'INTERNAL',
    ...over,
  });
  async function collection(tenantId = TENANT_A, member = ADMIN, over: Record<string, unknown> = {}): Promise<{ id: string; modelId: string }> {
    const modelId = await model({}, tenantId);
    const made = await call('POST', '/ai-knowledge-collections', { member, tenantId, body: collectionBody(modelId, over) });
    expect(made.status).toBe(200);
    return { id: asString(made.json.resource_id), modelId };
  }

  /** A document version of the tenant with the pages the OCR recorded, a classification, a scan verdict and an access list. */
  async function document(options: { pages?: string[]; classification?: string; scan?: string; unit?: number | null; subject?: string; tenantId?: string } = {}): Promise<string> {
    const tenantId = options.tenantId ?? TENANT_A;
    const documentId = randomUUID();
    const versionId = randomUUID();
    await rows(
      `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, issuer_unit_id, subject_module, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Knowledge test document', 'INTERNAL', $3, $4, $5, $5)`,
      [tenantId, documentId, options.unit === null ? null : unitId(options.unit ?? 1), options.subject ?? null, memberId(WORKER)],
      tenantId,
    );
    await rows(
      `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json)
       values ($1, $2, $3, 1, $4, $5, 'application/pdf', $6, $7, $8, '{}'::jsonb)`,
      [tenantId, versionId, documentId, `tenants/${tenantId}/document/${versionId}`, 'a'.repeat(64), (options.pages ?? [TEXT]).length, options.classification ?? 'INTERNAL', options.scan ?? 'CLEAN'],
      tenantId,
    );
    for (const [index, text] of (options.pages ?? [TEXT]).entries()) {
      const bytes = new TextEncoder().encode(text);
      const key = await files.storeGenerated(context(WORKER, tenantId), 'ocr-text', randomUUID(), bytes, 'text/plain');
      await rows(
        `insert into machvon.document_page_ocr (tenant_id, id, document_version_id, page_index, ocr_confidence, text_sha256, text_object_key, engine_version, review_status)
         values ($1, $2, $3, $4, 0.99, $5, $6, 'test-1', 'AUTO_ACCEPTED')`,
        [tenantId, randomUUID(), versionId, index, sha(bytes), key],
        tenantId,
      );
    }
    return versionId;
  }
  /** The unit that governs the document: the issuer of its document, whom the grants over units decide the reading by. */
  const setUnit = (versionId: string, unit: number | null, tenantId = TENANT_A) =>
    rows('update machvon.document set issuer_unit_id = $2 where id = (select document_id from machvon.document_version where id = $1)', [versionId, unit === null ? null : unitId(unit)], tenantId);
  const accessStore = (): EffectiveAccessStore => new EffectiveAccessStore(tenants, new InMemoryAuthzCache());
  const accessOf = (member: number, tenantId = TENANT_A) => accessStore().load(context(member, tenantId));
  const index = (member: number, collectionId: string, versionId: string, tenantId = TENANT_A): Promise<Reply> =>
    call('POST', `/ai-knowledge-collections/${collectionId}/items`, { member, tenantId, body: { document_version_id: versionId } });
  const ask = async (member: number, collectionId: string, question: string, extra: { only?: string[]; limit?: number } = {}, tenantId = TENANT_A) =>
    knowledge.retrieve(tenants, context(member, tenantId), { access: await accessOf(member, tenantId), collectionId, question, ...extra });

  beforeAll(async () => {
    await harness.start();
    root = await mkdtemp(join(tmpdir(), 'machvon-knowledge-'));
    for (const tenant of [TENANT_A, TENANT_B])
      await harness.seedUnits(tenant, [
        { n: 1, path: `/${unitId(1)}/` },
        { n: 2, path: `/${unitId(1)}/${unitId(2)}/`, parent: 1 },
      ]);
    for (const n of [ADMIN, READER, NOBODY, UNIT_ONLY, STC, BQL1, WORKER, LOSER]) await harness.seedMembership(TENANT_A, n, 1);
    for (const n of [B_ADMIN, B_USER]) await harness.seedMembership(TENANT_B, n, 1);
    await harness.seedRole(TENANT_A, 1, 'AI_KNOWLEDGE_ADMIN', ['llm.knowledge.manage', 'llm.knowledge.read'], 50);
    await harness.seedRole(TENANT_A, 2, 'AI_KNOWLEDGE_READER', ['llm.knowledge.read'], 20);
    await harness.seedRole(TENANT_A, 3, 'AI_KNOWLEDGE_UNIT', ['llm.knowledge.manage', 'llm.knowledge.read'], 20);
    await harness.seedRole(TENANT_A, 4, 'DOCUMENT_READER', ['document_version.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'AI_KNOWLEDGE_ADMIN', ['llm.knowledge.manage', 'llm.knowledge.read'], 50);
    await harness.seedRole(TENANT_B, 2, 'DOCUMENT_READER', ['document_version.read'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ADMIN, role: 1, kind: 'TENANT' },
      { n: 2, member: READER, role: 2, kind: 'TENANT' },
      { n: 3, member: UNIT_ONLY, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(1)] },
      // STC reads what unit 1 and the units under it govern; BQL1 only what unit 2 governs.
      { n: 4, member: STC, role: 4, kind: 'UNIT_SUBTREE', refs: [unitId(1)] },
      { n: 5, member: BQL1, role: 4, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 6, member: LOSER, role: 4, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
    ]);
    await harness.seedGrants(TENANT_B, [
      { n: 1, member: B_ADMIN, role: 1, kind: 'TENANT' },
      { n: 2, member: B_USER, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(1)] },
    ]);
    tenants = harness.tenants as TenantDatabase;
    files = new FileService({ storage: new FsObjectStorage(root), scanner: new MockScanPort(), urlSecret: randomBytes(32) });
    embeddings = new MockEmbeddingPort();
    knowledge = new AiKnowledgeService(embeddings, new OcrDocumentTextPort(files), files, new AuditWriter(tenants));
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [LlmKnowledgeController, LlmKnowledgeReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: AiKnowledgeService, useValue: knowledge },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
    await rm(root, { recursive: true, force: true });
  }, 60_000);

  it('is registered in the module of LLM', () => {
    for (const controller of [LlmKnowledgeController, LlmKnowledgeReadsController]) expect(llmModule.controllers).toContain(controller);
  });

  it('builds the service that the module registers with an audit writer on the database of the tenants, so that a retrieval through the application is logged', async () => {
    const provider = (llmModule.providers ?? []).find((candidate) => (candidate as { provide?: unknown }).provide === AiKnowledgeService) as { inject?: unknown[] } | undefined;
    expect(provider?.inject).toContain(TenantDatabase);
    const factory = (provider as unknown as { useFactory: (...args: unknown[]) => AiKnowledgeService }).useFactory;
    const built = factory(embeddings, new OcrDocumentTextPort(files), files, tenants);
    const { id } = await collection();
    const version = await document({ unit: 2 });
    expect((await index(ADMIN, id, version)).status).toBe(200);
    const before = await rows<{ n: string }>("select count(*)::text as n from machvon.audit_event where action = 'llm.knowledge.retrieved' and resource_id = $1", [id]);
    expect(await built.retrieve(tenants, context(STC), { access: await accessOf(STC), collectionId: id, question: TEXT })).toHaveLength(1);
    const after = await rows<{ n: string }>("select count(*)::text as n from machvon.audit_event where action = 'llm.knowledge.retrieved' and resource_id = $1", [id]);
    expect(Number(after[0]?.n)).toBe(Number(before[0]?.n) + 1);
  });

  it('lets the document module decide who reads: the grants over the unit that governs a document, and nothing the document does not govern', async () => {
    const { id } = await collection();
    const inUnitOne = await document({ unit: 1 });
    const inUnitTwo = await document({ unit: 2 });
    const ungoverned = await document({ unit: null });
    for (const version of [inUnitOne, inUnitTwo, ungoverned]) expect((await index(ADMIN, id, version)).status).toBe(200);
    const read = async (member: number) => (await ask(member, id, TEXT, { limit: 10 })).map((chunk) => chunk.documentVersionId).sort();
    // STC holds the right over unit 1 and the units under it, BQL1 over unit 2 only, the others over nothing; a document of no unit is read by nobody who holds the right over units.
    expect(await read(STC)).toEqual([inUnitOne, inUnitTwo].sort());
    expect(await read(BQL1)).toEqual([inUnitTwo]);
    expect(await read(LOSER)).toEqual([inUnitTwo]);
    expect(await read(READER)).toEqual([]);
    expect(await read(NOBODY)).toEqual([]);
    // A member who loses the grant loses the documents at once, with no indexing.
    await rows("update machvon.role_grant set status = 'Revoked', revoked_at = now() where membership_id = $1 and role_id = $2", [memberId(LOSER), roleId(4)]);
    expect(await read(LOSER)).toEqual([]);
    expect(await read(BQL1)).toEqual([inUnitTwo]);
  });

  it('withholds a document from everybody when what governs it changed since it was indexed, until it is indexed again; and never offers a sealed proposal', async () => {
    const { id } = await collection();
    const version = await document({ unit: 1 });
    expect((await index(ADMIN, id, version)).status).toBe(200);
    expect(await ask(STC, id, TEXT)).toHaveLength(1);
    // The classification of the version is raised behind the back of the index (an owner's correction): the chunks were indexed under another ACL.
    await rows("update machvon.document_version set classification = 'CONFIDENTIAL' where id = $1", [version]);
    expect(await ask(STC, id, TEXT)).toEqual([]);
    expect(asObjects((await call('GET', `/ai-knowledge-collections/${id}`, { member: READER })).json.items)[0]).toMatchObject({ stale: true });
    // It is above what the collection takes now, so it cannot be indexed again: it stays withheld.
    expect(await index(ADMIN, id, version)).toMatchObject({ status: 422, json: { code: 'CLASSIFICATION_ABOVE_COLLECTION' } });
    expect(await ask(STC, id, TEXT)).toEqual([]);
    // A proposal that is sealed is no knowledge: it is neither indexed nor offered.
    const sealed = await document({ unit: 1, subject: 'BID_PROPOSAL' });
    expect(await index(ADMIN, id, sealed)).toMatchObject({ status: 404 });
    const later = await document({ unit: 1 });
    expect((await index(ADMIN, id, later)).status).toBe(200);
    await rows("update machvon.document set subject_module = 'BID_PROPOSAL' where id = (select document_id from machvon.document_version where id = $1)", [later]);
    expect(await ask(STC, id, TEXT)).toEqual([]);
  });

  it('finds the stale items among the unchanged ones, the oldest touched first, as many as asked for', async () => {
    const { id } = await collection();
    const versions: string[] = [];
    for (let n = 0; n < 4; n += 1) {
      const version = await document({ unit: 2 });
      versions.push(version);
      expect((await index(ADMIN, id, version)).status).toBe(200);
    }
    await setUnit(versions[3] as string, 1);
    const store = new LlmKnowledgeStore();
    const found = await tenants.withTenant(context(WORKER), (tx) => store.staleItems(tx, 50));
    expect(found.filter((item) => item.collectionId === id).map((item) => item.documentVersionId)).toEqual([versions[3]]);
    expect(await tenants.withTenant(context(WORKER), (tx) => store.staleItems(tx, 1))).toHaveLength(1);
    await knowledge.reindexStale(tenants, context(WORKER), 100);
  });

  it('does not keep the right to a model whose approval is gone: it neither indexes nor answers nor indexes again by itself', async () => {
    const { id, modelId } = await collection();
    const version = await document({ unit: 1 });
    expect((await index(ADMIN, id, version)).status).toBe(200);
    await rows("update machvon.ai_model set status = 'SUSPENDED' where id = $1", [modelId]);
    expect(await index(ADMIN, id, await document({ unit: 2 }))).toMatchObject({ status: 422, json: { code: 'MODEL_NOT_APPROVED' } });
    await expect(ask(STC, id, TEXT)).rejects.toMatchObject({ code: 'MODEL_NOT_APPROVED' });
    await setUnit(version, 2);
    const calls = embeddings.calls.length;
    expect(await knowledge.reindexStale(tenants, context(WORKER), 100)).toBe(0);
    expect(embeddings.calls.length).toBe(calls);
    await rows("update machvon.ai_model set status = 'APPROVED' where id = $1", [modelId]);
    expect(await knowledge.reindexStale(tenants, context(WORKER), 100)).toBeGreaterThanOrEqual(1);
  });

  it('is stopped by the emergency stop as the gateway is: a switch of the tenant, of the model or of the provider stops indexing, retrieval and the indexing again by itself', async () => {
    const emergency = new LlmEmergencyStore();
    const engage = (scopeKind: string, scopeRef: string | undefined) =>
      tenants.withTenant(context(ADMIN), (tx) => emergency.engage(tx, { scopeKind, scopeRef, reason: 'Stopped for the test of the knowledge.', actor: memberId(ADMIN) }));
    // The switch of a model stops the collections made for that model and no other.
    const stopped = await collection();
    const other = await collection();
    const version = await document({ unit: 1 });
    expect((await index(ADMIN, stopped.id, version)).status).toBe(200);
    expect((await index(ADMIN, other.id, version)).status).toBe(200);
    await engage('MODEL', stopped.modelId);
    const calls = embeddings.calls.length;
    expect(await index(ADMIN, stopped.id, version)).toMatchObject({ status: 503, json: { code: 'AI_KILL_SWITCH_ENGAGED' } });
    await expect(ask(STC, stopped.id, TEXT)).rejects.toMatchObject({ code: 'AI_KILL_SWITCH_ENGAGED' });
    await setUnit(version, 2);
    // The pass indexes the other collection again, and leaves the stopped one.
    expect(await knowledge.reindexStale(tenants, context(WORKER), 100)).toBeGreaterThanOrEqual(1);
    expect(embeddings.calls.slice(calls).length).toBe(1);
    expect(await ask(BQL1, other.id, TEXT)).toHaveLength(1);
    expect(await ask(BQL1, stopped.id, TEXT).catch((error) => error.code)).toBe('AI_KILL_SWITCH_ENGAGED');
    // The switch of the provider stops the other collection too.
    const provider = (await rows<{ provider_id: string }>('select provider_id from machvon.ai_model where id = $1', [other.modelId]))[0]?.provider_id;
    await engage('PROVIDER', provider);
    await expect(ask(STC, other.id, TEXT)).rejects.toMatchObject({ code: 'AI_KILL_SWITCH_ENGAGED' });
    expect(await index(ADMIN, other.id, version)).toMatchObject({ status: 503, json: { code: 'AI_KILL_SWITCH_ENGAGED' } });
  });

  it('does not use a model whose provider is not active', async () => {
    const { id, modelId } = await collection();
    const version = await document({ unit: 2 });
    expect((await index(ADMIN, id, version)).status).toBe(200);
    const provider = (await rows<{ provider_id: string }>('select provider_id from machvon.ai_model where id = $1', [modelId]))[0]?.provider_id;
    await rows("update machvon.ai_provider set status = 'SUSPENDED' where id = $1", [provider]);
    expect(await index(ADMIN, id, version)).toMatchObject({ status: 503, json: { code: 'PROVIDER_UNAVAILABLE' } });
    await expect(ask(STC, id, TEXT)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    await rows("update machvon.ai_provider set status = 'ACTIVE' where id = $1", [provider]);
    expect(await ask(STC, id, TEXT)).toHaveLength(1);
  });

  it('does not let items that cannot be indexed again hold the place of the ones that can: a failure sends the item to the back of the queue', async () => {
    await knowledge.reindexStale(tenants, context(WORKER), 1000);
    const { id } = await collection();
    const broken = await document({ unit: 1 });
    const mendable = await document({ unit: 1 });
    await index(ADMIN, id, broken);
    await index(ADMIN, id, mendable);
    await setUnit(broken, 2);
    await setUnit(mendable, 2);
    await rows('delete from machvon.document_page_ocr where document_version_id = $1', [broken]);
    // One try a pass, whoever else waits in the queue (the items of the tests before may be stopped by a switch): a failure sends an item to the back, so the mendable one is reached within a few passes.
    const item = async (version: string) => asObjects((await call('GET', `/ai-knowledge-collections/${id}`, { member: READER })).json.items).find((one) => one.document_version_id === version);
    let passes = 0;
    while ((await ask(BQL1, id, TEXT)).length === 0 && passes < 40) {
      await knowledge.reindexStale(tenants, context(WORKER), 1);
      passes += 1;
    }
    expect(passes).toBeLessThan(40);
    expect(await ask(BQL1, id, TEXT)).toHaveLength(1);
    while ((await item(broken))?.failure_code === null && passes < 80) {
      await knowledge.reindexStale(tenants, context(WORKER), 1);
      passes += 1;
    }
    expect(await item(broken)).toMatchObject({ failure_code: 'VALIDATION_FAILED', stale: true, status: 'INDEXED' });
    expect(await item(mendable)).toMatchObject({ failure_code: null, stale: false });
  });

  it('takes away the stored texts it does not need: the ones an indexing replaced when it commits, the ones it made when it does not', async () => {
    const { id } = await collection();
    const objects = async (): Promise<number> => (await files.listKind(context(WORKER), 'ai-chunk')).length;
    const version = await document({ unit: 2 });
    const before = await objects();
    expect((await index(ADMIN, id, version)).status).toBe(200);
    expect(await objects()).toBe(before + 1);
    expect((await index(ADMIN, id, version)).status).toBe(200);
    expect(await objects()).toBe(before + 1);
    // The item is removed behind the back of the indexing: the texts stored before it was refused are taken away.
    await rows("update machvon.ai_knowledge_item set status = 'REMOVED' where document_version_id = $1", [version]);
    expect(await index(ADMIN, id, version)).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
    expect(await objects()).toBe(before + 1);
  });

  it('asks the chunks again when an indexing took away the texts the query named, and gives up when they are gone for good', async () => {
    const { id } = await collection();
    const version = await document({ unit: 2 });
    expect((await index(ADMIN, id, version)).status).toBe(200);
    let missing = 0;
    const flaky = new AiKnowledgeService(
      embeddings,
      new OcrDocumentTextPort(files),
      {
        storeGenerated: files.storeGenerated.bind(files),
        remove: files.remove.bind(files),
        readStored: async (tenant, key) => {
          if (missing > 0) {
            missing -= 1;
            throw new DomainError('RESOURCE_NOT_FOUND', 404);
          }
          return files.readStored(tenant, key);
        },
      },
      new AuditWriter(tenants),
    );
    const logCount = async (): Promise<number> =>
      Number((await rows<{ n: string }>("select count(*)::text as n from machvon.audit_event where action = 'llm.knowledge.retrieved' and resource_id = $1", [id]))[0]?.n);
    const logged = await logCount();
    missing = 2;
    const stcAccess = await accessOf(STC);
    expect(await flaky.retrieve(tenants, context(STC), { access: stcAccess, collectionId: id, question: TEXT })).toHaveLength(1);
    missing = 3;
    await expect(flaky.retrieve(tenants, context(STC), { access: stcAccess, collectionId: id, question: TEXT })).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    // Only the answer that was given is logged.
    expect(await logCount()).toBe(logged + 1);
  });

  it('makes a collection for an approved embedding model and the classification it takes; the code is the tenant’s once', async () => {
    const modelId = await model();
    const made = await call('POST', '/ai-knowledge-collections', { member: ADMIN, body: collectionBody(modelId, { code: 'KB-PRJ' }) });
    expect([made.status, made.json.status]).toEqual([200, 'ACTIVE']);
    expect(await call('POST', '/ai-knowledge-collections', { member: ADMIN, body: collectionBody(modelId, { code: 'KB-PRJ' }) })).toMatchObject({ status: 409, json: { code: 'DUPLICATE_KEY' } });
    const created = await rows<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where type = 'llm.collection.created.v1' and aggregate_id = $1", [made.json.resource_id]);
    expect(created).toHaveLength(1);
    expect(created[0]?.payload).toMatchObject({ collection_id: made.json.resource_id, code: 'KB-PRJ', subject_module: 'PRJ', embedding_model_id: modelId, max_classification: 'INTERNAL' });
    const read = await call('GET', `/ai-knowledge-collections/${made.json.resource_id}`, { member: READER });
    expect(read.json).toMatchObject({
      id: made.json.resource_id,
      code: 'KB-PRJ',
      subject_module: 'PRJ',
      embedding_model_id: modelId,
      max_classification: 'INTERNAL',
      status: 'ACTIVE',
      item_count: 0,
      index_version: 1,
      items: [],
    });
    expect((await call('GET', '/ai-knowledge-collections?limit=1', { member: READER })).json.items).toHaveLength(1);
    expect((await call('GET', '/ai-knowledge-collections?status=Nope', { member: READER })).status).toBe(422);
  });

  it('refuses a model that is not approved (MODEL_NOT_APPROVED), one that does not embed, one cleared for less than the collection takes, an unknown one, and a body that is not one', async () => {
    expect(await call('POST', '/ai-knowledge-collections', { member: ADMIN, body: collectionBody(await model({ status: 'PROPOSED' })) })).toMatchObject({
      status: 422,
      json: { code: 'MODEL_NOT_APPROVED' },
    });
    expect((await call('POST', '/ai-knowledge-collections', { member: ADMIN, body: collectionBody(await model({ embedding: false })) })).json.detail).toBe('embedding_model_id');
    expect((await call('POST', '/ai-knowledge-collections', { member: ADMIN, body: collectionBody(await model({ max: 'PUBLIC' })) })).json.detail).toBe('max_classification');
    expect(await call('POST', '/ai-knowledge-collections', { member: ADMIN, body: collectionBody(randomUUID()) })).toMatchObject({ status: 404, json: { detail: 'embedding_model_id' } });
    const modelId = await model();
    for (const [over, field] of [
      [{ code: 'x' }, 'code'],
      [{ title: ' ' }, 'title'],
      [{ subject_module: 'lower' }, 'subject_module'],
      [{ max_classification: 'SECRET' }, 'max_classification'],
    ] as const)
      expect((await call('POST', '/ai-knowledge-collections', { member: ADMIN, body: collectionBody(modelId, over) })).json.detail).toBe(field);
  });

  it('indexes a clean document under its access list, and indexing it again replaces its chunks', async () => {
    const { id } = await collection();
    const version = await document({ unit: 1 });
    const done = await index(ADMIN, id, version);
    expect([done.status, done.json.status, done.json.chunk_count]).toEqual([200, 'INDEXED', 1]);
    expect(done.json.acl_hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await rows<{ n: string }>('select count(*)::text as n from machvon.ai_chunk where collection_id = $1', [id]))[0]?.n).toBe('1');
    const again = await index(ADMIN, id, version);
    expect([again.status, again.json.chunk_count]).toEqual([200, 1]);
    // Each indexing, the first and the one again, is told once.
    const told = await rows<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where type = 'llm.collection.item_indexed.v1' and aggregate_id = $1 order by created_at", [
      done.json.resource_id,
    ]);
    expect(told).toHaveLength(2);
    expect(told[1]?.payload).toMatchObject({ collection_id: id, document_version_id: version, chunk_count: 1, acl_hash: done.json.acl_hash });
    expect((await rows<{ n: string }>('select count(*)::text as n from machvon.ai_chunk where collection_id = $1', [id]))[0]?.n).toBe('1');
    const read = await call('GET', `/ai-knowledge-collections/${id}`, { member: READER });
    expect(read.json.items).toEqual([expect.objectContaining({ document_version_id: version, chunk_count: 1, status: 'INDEXED', classification: 'INTERNAL', stale: false })]);
    expect(read.json.item_count).toBe(1);
    expect((await rows<{ action: string }>("select action from machvon.audit_event where action = 'llm.knowledge_item.indexed' and safe_diff::text like $1", [`%${version}%`])).length).toBeGreaterThan(
      0,
    );
  });

  it('cuts a long document into chunks by page, and gives the chunks of a page their own numbers', async () => {
    const { id } = await collection();
    const long = Array.from({ length: 30 }, (_, n) => `Đoạn số ${n} nói về việc thẩm định hồ sơ và các bước xử lý của từng đơn vị trong tháng này.`).join('\n\n');
    const version = await document({ pages: [long, TEXT, ''], unit: 2 });
    const done = await index(ADMIN, id, version);
    expect(done.json.chunk_count).toBeGreaterThan(2);
    const found = await rows<{ page_index: number; chunk_no: number }>('select page_index, chunk_no from machvon.ai_chunk where collection_id = $1 order by page_index, chunk_no', [id]);
    expect(found.filter((chunk) => chunk.page_index === 1)).toEqual([{ page_index: 1, chunk_no: 0 }]);
    expect(found.filter((chunk) => chunk.page_index === 2)).toEqual([]);
    expect(found.filter((chunk) => chunk.page_index === 0).map((chunk) => chunk.chunk_no)).toEqual(found.filter((chunk) => chunk.page_index === 0).map((_, n) => n));
  });

  it('takes only a document that was scanned clean and is not above the classification of the collection', async () => {
    const { id } = await collection();
    expect(await index(ADMIN, id, await document({ scan: 'PENDING' }))).toMatchObject({ status: 409, json: { code: 'SCAN_PENDING' } });
    expect(await index(ADMIN, id, await document({ scan: 'INFECTED' }))).toMatchObject({ status: 422, json: { code: 'FILE_NOT_CLEAN' } });
    expect(await index(ADMIN, id, await document({ classification: 'CONFIDENTIAL' }))).toMatchObject({ status: 422, json: { code: 'CLASSIFICATION_ABOVE_COLLECTION' } });
    expect((await index(ADMIN, id, await document({ classification: 'PUBLIC', unit: 2 }))).status).toBe(200);
    expect((await index(ADMIN, id, randomUUID())).status).toBe(404);
    expect((await index(ADMIN, randomUUID(), await document())).status).toBe(404);
    // A version with no text recorded, or whose text was changed after the OCR, has nothing to index.
    expect((await index(ADMIN, id, await document({ pages: [] }))).json.detail).toBe('document_version_id');
    const tampered = await document();
    await rows('update machvon.document_page_ocr set text_sha256 = $2 where document_version_id = $1', [tampered, 'f'.repeat(64)]);
    expect((await index(ADMIN, id, tampered)).json.detail).toBe('document_version_id');
    expect((await index(ADMIN, id, await document({ pages: ['   ', ''] }))).json.detail).toBe('document_version_id');
    expect((await call('POST', `/ai-knowledge-collections/${id}/items`, { member: ADMIN, body: { document_version_id: 'nope' } })).status).toBeGreaterThanOrEqual(400);
  });

  it('answers with the chunks of the documents the asker may read, the tenant and the list before the distance; widening the list takes effect when the item is indexed again (UAT-AC467)', async () => {
    const a = await collection(TENANT_A);
    const b = await collection(TENANT_B, B_ADMIN);
    const documentA = await document({ unit: 1 });
    const documentB = await document({ tenantId: TENANT_B, unit: 1 });
    expect((await index(ADMIN, a.id, documentA)).status).toBe(200);
    expect((await index(B_ADMIN, b.id, documentB, TENANT_B)).status).toBe(200);
    // The user of B asks the question that matches the document of A: nothing of A comes back, not even by naming its collection.
    expect(await ask(B_USER, b.id, TEXT, {}, TENANT_B)).toHaveLength(1);
    await expect(ask(B_USER, a.id, TEXT, {}, TENANT_B)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    // The member on the list gets the chunk, with its text; BQL1 does not.
    const forStc = await ask(STC, a.id, 'thẩm định dự án đầu tư công');
    expect(forStc).toHaveLength(1);
    expect(forStc[0]).toMatchObject({ documentVersionId: documentA, pageIndex: 0, chunkNo: 0, classification: 'INTERNAL', text: TEXT.replace(/\s+/g, ' ') });
    expect(await ask(BQL1, a.id, 'thẩm định dự án đầu tư công')).toEqual([]);
    // The list is widened: BQL1 is on the list of the document, not yet on the one the item was indexed with, so they still get nothing, and the item is marked.
    await setUnit(documentA, 2);
    expect(await ask(BQL1, a.id, 'thẩm định dự án đầu tư công')).toEqual([]);
    expect(asObjects((await call('GET', `/ai-knowledge-collections/${a.id}`, { member: READER })).json.items)[0]).toMatchObject({ stale: true });
    // Indexed again under the new hash, BQL1 gets the chunk.
    const firstHash = asObjects((await call('GET', `/ai-knowledge-collections/${a.id}`, { member: READER })).json.items)[0]?.acl_hash;
    const again = await index(ADMIN, a.id, documentA);
    expect(again.json.acl_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(again.json.acl_hash).not.toBe(firstHash);
    expect(await ask(BQL1, a.id, 'thẩm định dự án đầu tư công')).toHaveLength(1);
    expect(asObjects((await call('GET', `/ai-knowledge-collections/${a.id}`, { member: READER })).json.items)[0]).toMatchObject({ stale: false });
    // Narrowing takes effect at once, before anybody indexes again.
    await setUnit(documentA, 1);
    expect(await ask(BQL1, a.id, 'thẩm định dự án đầu tư công')).toEqual([]);
    // The document is governed by unit 1 again but the chunks were indexed under unit 2: nobody is offered them until the item is indexed again.
    expect(await ask(STC, a.id, 'thẩm định dự án đầu tư công')).toEqual([]);
    expect((await index(ADMIN, a.id, documentA)).status).toBe(200);
    expect(await ask(STC, a.id, 'thẩm định dự án đầu tư công')).toHaveLength(1);
    expect(await ask(BQL1, a.id, 'thẩm định dự án đầu tư công')).toEqual([]);
  });

  it('puts the tenant in front of the distance: the same text in two tenants is found in its own, and the query names the tenant', async () => {
    const a = await collection(TENANT_A);
    const documentA = await document({ unit: 2 });
    await index(ADMIN, a.id, documentA);
    const b = await collection(TENANT_B, B_ADMIN);
    const documentB = await document({ tenantId: TENANT_B, unit: 2 });
    await index(B_ADMIN, b.id, documentB, TENANT_B);
    expect((await ask(STC, a.id, TEXT)).map((chunk) => chunk.documentVersionId)).toEqual([documentA]);
    expect((await ask(B_USER, b.id, TEXT, {}, TENANT_B)).map((chunk) => chunk.documentVersionId)).toEqual([documentB]);
    const plan = await tenants.withTenant(context(STC), (tx) =>
      tx.query<{ 'QUERY PLAN': string }>(
        "explain select c.id from machvon.ai_chunk c where c.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid and c.collection_id = $1::uuid order by c.id limit 5",
        [a.id],
      ),
    );
    expect(plan.map((line) => line['QUERY PLAN']).join('\n')).toContain('tenant_id');
  });

  it('ranks by similarity, returns at most the limit asked for, and narrows to the documents the caller allows (UAT-AC14)', async () => {
    const { id } = await collection();
    const proposals = [
      await document({ pages: ['Nhà thầu A đề xuất giải pháp thi công móng cọc khoan nhồi và tiến độ sáu tháng.'], unit: 2 }),
      await document({ pages: ['Nhà thầu B đề xuất giải pháp thi công móng bè và tiến độ chín tháng.'], unit: 2 }),
      await document({ pages: ['Bảng giá vật tư thép xi măng của nhà thầu C.'], unit: 2 }),
    ];
    for (const version of proposals) expect((await index(ADMIN, id, version)).status).toBe(200);
    const ranked = await ask(STC, id, 'thi công móng cọc khoan nhồi', { limit: 2 });
    expect(ranked).toHaveLength(2);
    expect(ranked[0]?.documentVersionId).toBe(proposals[0]);
    expect((ranked[0]?.distance ?? 1) < (ranked[1]?.distance ?? 0)).toBe(true);
    // A recused evaluator is given the proposals that are not forbidden: the one forbidden is neither returned nor named in the log.
    const allowed = await ask(STC, id, 'thi công móng cọc khoan nhồi', { only: [proposals[1] as string, proposals[2] as string] });
    expect(allowed.map((chunk) => chunk.documentVersionId).sort()).toEqual([proposals[1], proposals[2]].sort());
    const logged = await rows<{ safe_diff: string }>(
      "select safe_diff::text as safe_diff from machvon.audit_event where action = 'llm.knowledge.retrieved' and resource_id = $1 order by occurred_at desc limit 1",
      [id],
    );
    expect(logged[0]?.safe_diff).not.toContain(proposals[0]);
    expect(logged[0]?.safe_diff).toContain(proposals[1]);
    expect(logged[0]?.safe_diff).not.toContain('cọc');
    // Asking nothing, or too much, or for a silly limit, is refused.
    await expect(ask(STC, id, '  ')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(ask(STC, id, 'x'.repeat(4001))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(ask(STC, id, 'thi công', { limit: 0 })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(ask(STC, id, 'thi công', { limit: 21 })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('indexes again, by itself, the items whose document carries another list now; the others are left', async () => {
    // The items the tests before left stale are indexed again first, so that the count below is this test's own.
    await knowledge.reindexStale(tenants, context(WORKER), 1000);
    const { id } = await collection();
    const changed = await document({ unit: 1 });
    const same = await document({ unit: 2 });
    await index(ADMIN, id, changed);
    await index(ADMIN, id, same);
    expect(await knowledge.reindexStale(tenants, context(WORKER), 10)).toBe(0);
    await setUnit(changed, 2);
    expect(await ask(BQL1, id, TEXT)).toHaveLength(1);
    expect(await knowledge.reindexStale(tenants, context(WORKER), 10)).toBe(1);
    expect(await knowledge.reindexStale(tenants, context(WORKER), 10)).toBe(0);
    expect((await ask(BQL1, id, TEXT)).map((chunk) => chunk.documentVersionId).sort()).toEqual([changed, same].sort());
    expect((await rows<{ action: string }>("select action from machvon.audit_event where action = 'llm.knowledge.reindexed' and safe_diff::text like $1", [`%${changed}%`])).length).toBe(1);
    // An item whose text is gone is left as it was: it stays readable by those on both lists, and the pass goes on.
    await setUnit(changed, 1);
    await rows('delete from machvon.document_page_ocr where document_version_id = $1', [changed]);
    expect(await knowledge.reindexStale(tenants, context(WORKER), 10)).toBe(0);
  });

  it('is for those who may: making and indexing need manage, reading needs read, all on the whole tenant; another tenant sees none of it', async () => {
    const { id, modelId } = await collection();
    const version = await document({ unit: 2 });
    for (const member of [READER, NOBODY, UNIT_ONLY]) {
      expect((await call('POST', '/ai-knowledge-collections', { member, body: collectionBody(modelId) })).status).toBe(403);
      expect((await index(member, id, version)).status).toBe(403);
    }
    expect((await call('GET', '/ai-knowledge-collections', { member: NOBODY })).status).toBe(403);
    expect((await call('GET', `/ai-knowledge-collections/${id}`, { member: UNIT_ONLY })).status).toBe(403);
    expect(asObjects((await call('GET', '/ai-knowledge-collections', { member: B_ADMIN, tenantId: TENANT_B })).json.items).map((item) => item.id)).not.toContain(id);
    expect((await call('GET', `/ai-knowledge-collections/${id}`, { member: B_ADMIN, tenantId: TENANT_B })).status).toBe(404);
    expect((await index(B_ADMIN, id, version, TENANT_B)).status).toBe(404);
  });

  it('is kept for good: the table refuses to change what a collection was made with, to delete, and the chunks cannot point at another tenant’s item', async () => {
    const { id } = await collection();
    const version = await document({ unit: 2 });
    await index(ADMIN, id, version);
    const asApp = (sql: string, params: unknown[] = []) => tenants.withTenant(context(ADMIN), (tx) => tx.query(sql, params));
    await expect(asApp("update machvon.ai_knowledge_collection set max_classification = 'PUBLIC' where id = $1", [id])).rejects.toMatchObject({ code: '42501' });
    await expect(asApp("update machvon.ai_knowledge_collection set code = 'OTHER' where id = $1", [id])).rejects.toMatchObject({ code: '42501' });
    await expect(asApp('delete from machvon.ai_knowledge_collection where id = $1', [id])).rejects.toBeDefined();
    await expect(asApp('update machvon.ai_knowledge_item set document_version_id = gen_random_uuid() where collection_id = $1', [id])).rejects.toBeDefined();
    await expect(asApp('delete from machvon.ai_knowledge_item where collection_id = $1', [id])).rejects.toBeDefined();
    await expect(asApp("update machvon.ai_knowledge_collection set status = 'RETIRED' where id = $1", [id])).resolves.toBeDefined();
    await expect(asApp("update machvon.ai_knowledge_collection set status = 'ACTIVE' where id = $1", [id])).rejects.toMatchObject({ code: '42501' });
    // A retired collection is withdrawn: it takes nothing more, and answers nothing - not through the service, not through the query.
    await expect(ask(STC, id, TEXT)).rejects.toMatchObject({ code: 'STAGE_TRANSITION_DENIED' });
    const [question] = await embeddings.embed({ providerModelId: 'any', texts: [TEXT] });
    const stcAccessNow = await accessOf(STC);
    expect(
      await tenants.withTenant(context(STC), (tx) =>
        new LlmKnowledgeStore().retrieve(tx, { collectionId: id, embedding: question as number[], scope: versionScope(stcAccessNow, 'document_version.read', new Date(), memberId(STC)) }),
      ),
    ).toEqual([]);
    expect(await index(ADMIN, id, await document({ unit: 2 }))).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
    await expect(
      rows(
        `insert into machvon.ai_chunk (tenant_id, id, collection_id, document_version_id, page_index, chunk_no, text_sha256, text_object_key, embedding, acl_hash, classification)
         values ($1, gen_random_uuid(), $2, $3, 9, 9, repeat('a', 64), 'k', (select embedding from machvon.ai_chunk limit 1), repeat('b', 64), 'INTERNAL')`,
        [TENANT_A, randomUUID(), version],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
});
