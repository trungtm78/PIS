import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_FILTER } from '@nestjs/core';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { EnterpriseProjectDocumentExtension, registerEnterpriseCatalogueRules } from '@machvon/edition-enterprise/src/server.ts';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { InvestmentProfileController } from '../../src/editions/enterprise/investment-profile.controller';
import { LocalTextExtractor } from '../../src/modules/doc/local-text-extractor';
import { RepositoryFiles } from '../../src/modules/doc/repository-files';
import { ProjectDocumentReadsController } from '../../src/modules/doc/repository-reads.controller';
import { ProjectDocumentFilesController, ProjectDocumentsController } from '../../src/modules/doc/repository.controller';
import { PROJECT_DOCUMENT_EXTENSION } from '../../src/modules/doc/tokens';
import { FileService } from '../../src/modules/files/file.service';
import { FsObjectStorage } from '../../src/modules/files/fs-object-storage';
import { MockScanPort } from '../../src/modules/files/mock-scan';
import { TENANT_A, memberId } from '../../../../packages/db/test/support/authz-fixtures';
import { BQL1, CapWorld, ROOT } from '../../../../packages/db/test/support/cap-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

/**
 * The legal-document type of a project document (MD.02) through the two editions of the same repository commands. The name of this file ends in `.enterprise.test.ts`: it is one of the few sources that may name the
 * enterprise package. One database, two applications: the public one binds no extension (the repository as it always was), the enterprise one binds the extension of the edition, and the investment profile reads the result.
 */
jest.setTimeout(300_000);

const SIGNING_KEY = randomBytes(32);
const AUTHOR = 4;
const PROFILE_ONLY = 5;
const UPLOAD = ['doc.repo.read', 'doc.repo.upload', 'project.read'];

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

async function pdfFile(line: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([600, 800]).drawText(line, { x: 50, y: 700, size: 12, font });
  return pdf.save();
}

describe('the legal-document type of a project document (MD.02)', () => {
  const world = new CapWorld();
  let publicApp: RunningApp;
  let enterpriseApp: RunningApp;
  let objectRoot = '';
  let projectId = '';
  let otherProjectId = '';

  const tokenOf = (member: number): string => signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function call(app: RunningApp, method: 'GET' | 'POST', url: string, options: { member?: number; body?: unknown; ifMatch?: string } = {}): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member ?? AUTHOR), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
  async function upload(app: RunningApp, line: string): Promise<Record<string, unknown>> {
    const form = new FormData();
    form.append('file', new Blob([await pdfFile(line)], { type: 'application/pdf' }), 'file');
    const response = await fetch(`${app.baseUrl}/project-documents/files`, { method: 'POST', headers: { [TENANT_HEADER]: tokenOf(AUTHOR), 'idempotency-key': `key-${randomUUID()}` }, body: form });
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  }
  /** Creates a document of the project through the application given; the extra members of the body are the test's own. */
  async function create(app: RunningApp, extra: Record<string, unknown> = {}, project = projectId): Promise<Reply> {
    const staged = await upload(app, `Document ${randomUUID()}`);
    return call(app, 'POST', '/project-documents', {
      body: { project_id: project, doc_class: 'LEGAL_BASIS', title: `Legal basis ${randomUUID().slice(0, 8)}`, reference: `VB-${randomUUID().slice(0, 8)}`, file_object_key: staged.file_object_key, file_sha256: staged.file_sha256, ...extra },
    });
  }
  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => world.owner<R>(sql, params);
  const typeOf = async (documentId: string): Promise<string | undefined> => (await rows<{ legal_doc_type: string }>('select legal_doc_type from machvon.project_document_legal_type where document_id = $1', [documentId]))[0]?.legal_doc_type;
  const actionsOf = async (documentId: string): Promise<string[]> => (await rows<{ action: string }>('select action from machvon.audit_event where resource_id = $1', [documentId])).map((row) => row.action).sort();
  const countDocuments = async (): Promise<number> => Number((await rows<{ n: string }>('select count(*)::text as n from machvon.project_document'))[0]?.n);

  beforeAll(async () => {
    await world.start();
    registerEnterpriseCatalogueRules();
    objectRoot = await mkdtemp(join(tmpdir(), 'machvon-legal-type-'));
    const files = new FileService({ storage: new FsObjectStorage(objectRoot), scanner: new MockScanPort(), urlSecret: randomBytes(32) });
    for (const n of [AUTHOR, PROFILE_ONLY]) await world.harness.seedMembership(TENANT_A, n, ROOT);
    await world.harness.seedRole(TENANT_A, 1, 'REPO_USER', UPLOAD, 40);
    await world.harness.seedRole(TENANT_A, 2, 'PROJECT_READER', ['project.read'], 10);
    await world.harness.seedGrants(TENANT_A, [
      { n: 1, member: AUTHOR, role: 1, kind: 'TENANT' },
      { n: 2, member: PROFILE_ONLY, role: 2, kind: 'TENANT' },
    ]);
    projectId = await world.project({ unitNumber: BQL1 });
    otherProjectId = await world.project({ unitNumber: BQL1 });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const tenants = world.harness.tenants as TenantDatabase;
    const common = {
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
    };
    const providers = [
      { provide: TenantDatabase, useValue: tenants },
      { provide: FileService, useValue: files },
      { provide: RepositoryFiles, useValue: new RepositoryFiles(files, new LocalTextExtractor()) },
      { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
    ];
    publicApp = await startTestApp({ ...common, controllers: [ProjectDocumentFilesController, ProjectDocumentsController, ProjectDocumentReadsController], providers });
    enterpriseApp = await startTestApp({
      ...common,
      controllers: [ProjectDocumentFilesController, ProjectDocumentsController, ProjectDocumentReadsController, InvestmentProfileController],
      providers: [...providers, { provide: PROJECT_DOCUMENT_EXTENSION, useValue: new EnterpriseProjectDocumentExtension() }],
    });
  }, 300_000);

  afterAll(async () => {
    if (publicApp) await publicApp.close();
    if (enterpriseApp) await enterpriseApp.close();
    await world.stop();
    if (objectRoot !== '') await rm(objectRoot, { recursive: true, force: true });
  }, 60_000);

  describe('UAT-ENT-IPF-03 the public edition: the repository as it was', () => {
    it('creates a document without the member exactly as before: the same trail, no type', async () => {
      const made = await create(publicApp);
      expect(made).toMatchObject({ status: 200, json: { status: 'CREATED' } });
      const id = made.json.resource_id as string;
      expect(await typeOf(id)).toBeUndefined();
      expect(await actionsOf(id)).toEqual(['doc.repo.document_created']);
      const [audit] = await rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where resource_id = $1 and action = 'doc.repo.document_created'", [id]);
      expect(Object.keys(audit?.safe_diff ?? {}).sort()).toEqual(['contract_id', 'doc_class', 'effective_from', 'effective_to', 'package_id', 'project_id', 'security_class']);
    });

    it('takes null as no type, and refuses a named type (422 on legal_doc_type, reason NOT_AVAILABLE) without writing anything', async () => {
      const kept = await create(publicApp, { legal_doc_type: null });
      expect(kept).toMatchObject({ status: 200, json: { status: 'CREATED' } });
      expect(await typeOf(kept.json.resource_id as string)).toBeUndefined();

      const before = await countDocuments();
      const refused = await create(publicApp, { legal_doc_type: 'GROUP_RESOLUTION' });
      expect(refused).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'legal_doc_type' } });
      expect(await countDocuments()).toBe(before);
    });

    it('refuses a change that names a type, and a change that names nothing but a null one is the empty change it always was', async () => {
      const id = (await create(publicApp)).json.resource_id as string;
      const named = await call(publicApp, 'POST', `/project-documents/${id}/description`, { ifMatch: '"1"', body: { legal_doc_type: 'GROUP_RESOLUTION' } });
      expect(named).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'legal_doc_type' } });
      const empty = await call(publicApp, 'POST', `/project-documents/${id}/description`, { ifMatch: '"1"', body: { legal_doc_type: null } });
      expect(empty).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'body' } });
      const titled = await call(publicApp, 'POST', `/project-documents/${id}/description`, { ifMatch: '"1"', body: { title: 'Renamed legal basis', legal_doc_type: null } });
      expect(titled).toMatchObject({ status: 200, json: { status: 'UPDATED', resource_version: 2 } });
      expect(await actionsOf(id)).toEqual(['doc.repo.document_created', 'doc.repo.document_updated']);
      expect(await typeOf(id)).toBeUndefined();
    });
  });

  describe('UAT-ENT-IPF-04 the enterprise edition: the type of the catalogue is judged and kept', () => {
    it('keeps a code of the catalogue with the document, in the same transaction, and tells the trail', async () => {
      const made = await create(enterpriseApp, { legal_doc_type: 'GROUP_RESOLUTION' });
      expect(made).toMatchObject({ status: 200, json: { status: 'CREATED' } });
      const id = made.json.resource_id as string;
      expect(await typeOf(id)).toBe('GROUP_RESOLUTION');
      expect(await actionsOf(id)).toEqual(['doc.repo.document_created', 'doc.repo.document_legal_type_set'].sort());
      const [audit] = await rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where resource_id = $1 and action = 'doc.repo.document_legal_type_set'", [id]);
      expect(audit?.safe_diff).toMatchObject({ project_id: projectId, legal_doc_type: { from: null, to: 'GROUP_RESOLUTION' } });
      const [row] = await rows<{ set_by: string }>('select set_by from machvon.project_document_legal_type where document_id = $1', [id]);
      expect(row?.set_by).toBe(memberId(AUTHOR));
    });

    it('creates a document with no type as before, and refuses a code that is not in the catalogue or not a code, writing nothing', async () => {
      const plain = await create(enterpriseApp);
      expect(plain).toMatchObject({ status: 200, json: { status: 'CREATED' } });
      expect(await actionsOf(plain.json.resource_id as string)).toEqual(['doc.repo.document_created']);

      const before = await countDocuments();
      expect(await create(enterpriseApp, { legal_doc_type: 'MADE_UP_TYPE' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'legal_doc_type' } });
      expect(await create(enterpriseApp, { legal_doc_type: 'group_resolution' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'legal_doc_type' } });
      // What is not even a string is stopped by the contract before the command runs.
      expect(await create(enterpriseApp, { legal_doc_type: 12 })).toMatchObject({ status: 400, json: { code: 'INVALID_REQUEST', detail: 'legal_doc_type' } });
      expect(await countDocuments()).toBe(before);
    });

    it('accepts a code a tenant added through an approved rule, and refuses one whose rule is not in force on the day', async () => {
      const rule = (code: string, effectiveFrom: string, effectiveTo: string | null) =>
        rows(
          `insert into machvon.governance_rule (tenant_id, id, rule_type, code, version, status, params, effective_from, effective_to, reason, created_by, submitted_by, submitted_at, approved_by, approved_at)
           values ($1, gen_random_uuid(), 'ENT_LEGAL_DOC_TYPE', $2, 1, 'APPROVED', $3::jsonb, $4::date, $5::date, 'A type of the tenant', $6, $6, now(), $7, now())`,
          [TENANT_A, code, JSON.stringify({ label: 'Tenant notice', issuer: 'OTHER', purpose: 'LIFECYCLE_EVIDENCE' }), effectiveFrom, effectiveTo, memberId(AUTHOR), memberId(PROFILE_ONLY)],
        );
      await rule('TENANT_NOTICE', '2000-01-01', null);
      await rule('TENANT_EXPIRED', '2000-01-01', '2001-01-01');
      const made = await create(enterpriseApp, { legal_doc_type: 'TENANT_NOTICE' });
      expect(made).toMatchObject({ status: 200, json: { status: 'CREATED' } });
      expect(await typeOf(made.json.resource_id as string)).toBe('TENANT_NOTICE');
      expect(await create(enterpriseApp, { legal_doc_type: 'TENANT_EXPIRED' })).toMatchObject({ status: 422, json: { detail: 'legal_doc_type' } });
    });

    it('changes the type at the version read (the version moves), clears it with null, and leaves it alone when another field changes', async () => {
      const id = (await create(enterpriseApp, { legal_doc_type: 'GROUP_RESOLUTION' })).json.resource_id as string;
      const changed = await call(enterpriseApp, 'POST', `/project-documents/${id}/description`, { ifMatch: '"1"', body: { legal_doc_type: 'FS_APPROVAL_DECISION' } });
      expect(changed).toMatchObject({ status: 200, json: { status: 'UPDATED', resource_version: 2 } });
      expect(await typeOf(id)).toBe('FS_APPROVAL_DECISION');
      expect(await call(enterpriseApp, 'POST', `/project-documents/${id}/description`, { ifMatch: '"2"', body: { legal_doc_type: 'MADE_UP_TYPE' } })).toMatchObject({ status: 422, json: { detail: 'legal_doc_type' } });
      expect(await call(enterpriseApp, 'POST', `/project-documents/${id}/description`, { ifMatch: '"9"', body: { legal_doc_type: 'GROUP_DECISION' } })).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect(await typeOf(id)).toBe('FS_APPROVAL_DECISION');
      const titled = await call(enterpriseApp, 'POST', `/project-documents/${id}/description`, { ifMatch: '"2"', body: { title: 'Renamed approval decision' } });
      expect(titled).toMatchObject({ status: 200, json: { status: 'UPDATED', resource_version: 3 } });
      expect(await typeOf(id)).toBe('FS_APPROVAL_DECISION');
      const cleared = await call(enterpriseApp, 'POST', `/project-documents/${id}/description`, { ifMatch: '"3"', body: { legal_doc_type: null } });
      expect(cleared).toMatchObject({ status: 200, json: { status: 'UPDATED', resource_version: 4 } });
      expect(await typeOf(id)).toBeUndefined();
      const trail = await rows<{ safe_diff: { legal_doc_type: { from: string | null; to: string | null } } }>("select safe_diff from machvon.audit_event where resource_id = $1 and action = 'doc.repo.document_legal_type_set' order by occurred_at, id", [id]);
      expect(trail.map((one) => [one.safe_diff.legal_doc_type.from, one.safe_diff.legal_doc_type.to])).toEqual([
        [null, 'GROUP_RESOLUTION'],
        ['GROUP_RESOLUTION', 'FS_APPROVAL_DECISION'],
        ['FS_APPROVAL_DECISION', null],
      ]);
    });
  });

  describe('UAT-ENT-IPF-05 the investment profile reads the documents by type', () => {
    it('lists the active typed documents of the project by type, for who may read the documents, and none for who may not', async () => {
      const group = await create(enterpriseApp, { legal_doc_type: 'GROUP_RESOLUTION', reference: 'PROFILE-NQ-1', effective_from: '2000-01-01' });
      const group2 = await create(enterpriseApp, { legal_doc_type: 'GROUP_RESOLUTION', reference: 'PROFILE-NQ-2' });
      const fs = await create(enterpriseApp, { legal_doc_type: 'FS_APPROVAL_DECISION', reference: 'PROFILE-FS-1' });
      const archived = await create(enterpriseApp, { legal_doc_type: 'COMPANY_DECISION', reference: 'PROFILE-QD-1' });
      const elsewhere = await create(enterpriseApp, { legal_doc_type: 'COMPANY_DECISION', reference: 'PROFILE-QD-2' }, otherProjectId);
      await create(enterpriseApp, { reference: 'PROFILE-UNTYPED' });
      expect(await call(enterpriseApp, 'POST', `/project-documents/${archived.json.resource_id as string}/archive`, { ifMatch: '"1"', body: { reason: 'Replaced by a newer decision' } })).toMatchObject({ status: 200 });
      expect(elsewhere.status).toBe(200);

      const reply = await call(enterpriseApp, 'GET', `/projects/${projectId}/investment-profile?plan_year=2026`);
      expect(reply.status).toBe(200);
      const groups = reply.json.legal_documents as Array<{ legal_doc_type: string; label: string; issuer: string | null; purpose: string | null; count: number; documents: Array<{ id: string; reference: string | null; effective_state: string; status: string }> }>;
      const mine = groups.filter((one) => ['GROUP_RESOLUTION', 'FS_APPROVAL_DECISION', 'COMPANY_DECISION'].includes(one.legal_doc_type));
      expect(mine.map((one) => one.legal_doc_type)).toEqual(['GROUP_RESOLUTION', 'FS_APPROVAL_DECISION']);
      expect(mine[0]).toMatchObject({ issuer: 'GROUP', purpose: 'CAPITAL_ASSIGNMENT' });
      expect(mine[0]?.label).not.toBe('GROUP_RESOLUTION');
      const resolutions = groups.find((one) => one.legal_doc_type === 'GROUP_RESOLUTION');
      // Newest first: the second resolution was made after the first.
      expect(resolutions?.documents.filter((one) => one.reference?.startsWith('PROFILE-')).map((one) => [one.id, one.reference, one.effective_state, one.status])).toEqual([
        [group2.json.resource_id, 'PROFILE-NQ-2', 'UNDATED', 'ACTIVE'],
        [group.json.resource_id, 'PROFILE-NQ-1', 'IN_FORCE', 'ACTIVE'],
      ]);
      expect(groups.find((one) => one.legal_doc_type === 'FS_APPROVAL_DECISION')?.documents.map((one) => one.id)).toContain(fs.json.resource_id);
      // The other project's document and the archived one are not on this profile; the untyped one has no group.
      expect(JSON.stringify(groups)).not.toContain('PROFILE-QD');
      expect(JSON.stringify(groups)).not.toContain('PROFILE-UNTYPED');

      // Who may read the project but not its documents (no doc.repo.read) sees the profile and no document.
      const blind = await call(enterpriseApp, 'GET', `/projects/${projectId}/investment-profile?plan_year=2026`, { member: PROFILE_ONLY });
      expect(blind.status).toBe(200);
      expect(blind.json.legal_documents).toEqual([]);
    });
  });
});
