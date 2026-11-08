import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_FILTER } from '@nestjs/core';
import { Document, Packer, Paragraph, Table, TableCell, TableRow } from 'docx';
import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { ApprovalCommandsController, ApprovalTaskReadsController, WorkflowVersionReadsController } from '../../src/modules/adm/approval.controller';
import { APPROVAL_FINAL_COMMANDS, ApprovalService, FinalCommandRegistry } from '../../src/modules/adm/approval.service';
import { LocalTextExtractor } from '../../src/modules/doc/local-text-extractor';
import { DocumentCommentsController } from '../../src/modules/doc/repository-comments.controller';
import { RepositoryFiles } from '../../src/modules/doc/repository-files';
import { ProjectDocumentReadsController } from '../../src/modules/doc/repository-reads.controller';
import { DocumentReviewBinding, DocumentReviewReadsController, DocumentReviewsController } from '../../src/modules/doc/repository-review.controller';
import { ProjectDocumentFilesController, ProjectDocumentsController } from '../../src/modules/doc/repository.controller';
import { FileService } from '../../src/modules/files/file.service';
import { FsObjectStorage } from '../../src/modules/files/fs-object-storage';
import { MockScanPort, eicarBytes } from '../../src/modules/files/mock-scan';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedAs, seedBidPackage } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { CLAIMS_HEADER, TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(300_000);

const SIGNING_KEY = randomBytes(32);
const AUTHOR = 1;
const ADMIN = 2;
const PUBLISHER = 3;
const REV_A = 4;
const REV_B = 5;
const REV_C = 6;
const REV_D = 7;
const READER = 8;
const NOBODY = 9;
const OUTSIDE = 10;
const OTHER_TENANT = 11;
const UNIT = 2;
const OTHER_UNIT = 3;
const SECOND_FACTOR = { aal: 'aal2' };
const ALL = ['doc.repo.read', 'doc.repo.upload', 'doc.repo.comment', 'doc.repo.review.submit', 'workflow_instance.read', 'approval_task.read'];

interface Reply {
  status: number;
  json: Record<string, unknown>;
  bytes?: Uint8Array;
}

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function wordFile(price: string, extra = false): Promise<Uint8Array> {
  const document = new Document({
    sections: [
      {
        children: [
          new Paragraph('Điều 1. Phạm vi áp dụng của hợp đồng'),
          new Paragraph(`Giá trị hợp đồng là ${price} tỷ đồng chưa gồm thuế giá trị gia tăng`),
          ...(extra ? [new Paragraph('Điều 3. Điều khoản bổ sung về bảo hành công trình')] : []),
          new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph('Hạng mục')] }), new TableCell({ children: [new Paragraph(price)] })] })] }),
        ],
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(document));
}

async function workbookFile(second: string): Promise<Uint8Array> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Dự toán');
  sheet.getCell('A1').value = 'Hạng mục';
  sheet.getCell('B1').value = 'Giá trị';
  sheet.getCell('A2').value = 'Móng';
  sheet.getCell('B2').value = second;
  return new Uint8Array(await book.xlsx.writeBuffer());
}

async function pdfFile(line: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([600, 800]).drawText(line, { x: 50, y: 700, size: 12, font });
  return pdf.save();
}

describe('the project document repository over HTTP (DOC-2)', () => {
  const harness = new AuthzHarness();
  const registry = new FinalCommandRegistry();
  let app: RunningApp;
  let objectRoot = '';
  let projectId = '';
  let otherProjectId = '';
  let contractId = '';
  let otherContractId = '';
  let packageId = '';

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string; claims?: Record<string, unknown> }): Promise<Reply> {
    const claims = options.claims === undefined ? {} : { ...options.claims, ...(options.claims.aal === 'aal2' ? { aal2At: new Date().toISOString() } : {}) };
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json', [CLAIMS_HEADER]: JSON.stringify(claims) };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
  async function upload(bytes: Uint8Array, type: string, member = AUTHOR): Promise<Reply> {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type }), 'file');
    const response = await fetch(`${app.baseUrl}/project-documents/files`, { method: 'POST', headers: { [TENANT_HEADER]: tokenOf(member), 'idempotency-key': `key-${randomUUID()}` }, body: form });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

  /** Uploads a file and creates a document of the project from it; returns the ids. */
  async function createDocument(bytes: Uint8Array, type: string, over: Record<string, unknown> = {}, member = AUTHOR): Promise<{ documentId: string; versionId: string; staged: Record<string, unknown> }> {
    const staged = await upload(bytes, type, member);
    expect(staged.status).toBe(200);
    const created = await call('POST', '/project-documents', {
      member,
      body: { project_id: projectId, doc_class: 'DESIGN', title: 'Thiết kế cơ sở gói thầu số 3', reference: `TK-${randomUUID().slice(0, 8)}`, file_object_key: staged.json.file_object_key, file_sha256: staged.json.file_sha256, ...over },
    });
    expect(created).toMatchObject({ status: 200, json: { status: 'CREATED' } });
    const documentId = created.json.resource_id as string;
    const detail = await call('GET', `/project-documents/${documentId}`, { member });
    return { documentId, versionId: (detail.json.document as { current_version: { id: string } }).current_version.id, staged: staged.json };
  }
  async function addVersion(documentId: string, bytes: Uint8Array, type: string, member = AUTHOR): Promise<string> {
    const staged = await upload(bytes, type, member);
    expect(staged.status).toBe(200);
    const added = await call('POST', `/project-documents/${documentId}/versions`, { member, body: { file_object_key: staged.json.file_object_key, file_sha256: staged.json.file_sha256, change_note: 'bản mới' } });
    expect(added).toMatchObject({ status: 200, json: { status: 'VERSION_ADDED' } });
    return added.json.resource_id as string;
  }
  const taskOf = async (instanceId: string, member: number) => (await rows<{ id: string; version: string }>("select id, version::text from machvon.approval_task where workflow_instance_id = $1 and assignee_id = $2 and status = 'Pending'", [instanceId, memberId(member)]))[0];
  const instanceOf = async (reviewId: string): Promise<string> => (await rows<{ workflow_instance_id: string }>('select workflow_instance_id from machvon.document_review where id = $1', [reviewId]))[0]?.workflow_instance_id as string;
  async function decide(reviewId: string, member: number, decision: 'approve' | 'return' | 'reject', reason?: string): Promise<Reply> {
    const task = await taskOf(await instanceOf(reviewId), member);
    return call('POST', `/approval-tasks/${task?.id}/decision`, { member, ifMatch: `"${task?.version}"`, body: { decision, ...(reason === undefined ? {} : { reason }) }, claims: SECOND_FACTOR });
  }

  beforeAll(async () => {
    await harness.start();
    objectRoot = await mkdtemp(join(tmpdir(), 'machvon-repo-objects-'));
    const files = new FileService({ storage: new FsObjectStorage(objectRoot), scanner: new MockScanPort(), urlSecret: randomBytes(32) });
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }, { n: UNIT, path: `/${unitId(1)}/${unitId(UNIT)}/`, parent: 1 }, { n: OTHER_UNIT, path: `/${unitId(1)}/${unitId(OTHER_UNIT)}/`, parent: 1 }]);
    for (const n of [AUTHOR, ADMIN, PUBLISHER, REV_A, REV_B, REV_C, REV_D, READER, NOBODY, OUTSIDE]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedMembership(TENANT_B, OTHER_TENANT, 1);
    await harness.seedRole(TENANT_A, 1, 'REPO_USER', ALL, 40);
    await harness.seedRole(TENANT_A, 2, 'REPO_READER', ['doc.repo.read'], 10);
    await harness.seedRole(TENANT_A, 3, 'WORKFLOW_ADMIN', ['adm.workflow.manage', 'workflow_version.read'], 50);
    await harness.seedRole(TENANT_A, 4, 'WORKFLOW_PUBLISHER', ['adm.workflow.publish', 'workflow_version.read'], 50);
    await harness.seedRole(TENANT_A, 5, 'REVIEWER', [...ALL, 'approval.decide'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: AUTHOR, role: 1, kind: 'TENANT' },
      { n: 2, member: ADMIN, role: 3, kind: 'TENANT' },
      { n: 3, member: PUBLISHER, role: 4, kind: 'TENANT' },
      { n: 4, member: REV_A, role: 5, kind: 'TENANT' },
      { n: 5, member: REV_B, role: 5, kind: 'TENANT' },
      { n: 6, member: REV_C, role: 5, kind: 'TENANT' },
      { n: 7, member: REV_D, role: 5, kind: 'TENANT' },
      { n: 8, member: READER, role: 2, kind: 'TENANT' },
      // The same rights, but only over a unit that owns none of the projects: nothing of the repository is in their reach.
      { n: 9, member: OUTSIDE, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(OTHER_UNIT)] },
    ]);
    await harness.seedRole(TENANT_B, 1, 'REPO_USER', ALL, 40);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT, role: 1, kind: 'TENANT' }]);
    const project = await seedBidPackage(harness, { unit: UNIT });
    const other = await seedBidPackage(harness, { unit: UNIT });
    projectId = project.projectId;
    packageId = project.packageId;
    otherProjectId = other.projectId;
    contractId = randomUUID();
    otherContractId = randomUUID();
    const contract = (id: string, project_id: string, package_id: string, code: string): [string, unknown[]] => [
      'insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1)',
      [TENANT_A, id, project_id, package_id, randomUUID(), code, 'LUMP_SUM', 'VND', 'DRAFT'],
    ];
    await seedAs(harness, [contract(contractId, projectId, packageId, 'HD-REPO-1'), contract(otherContractId, otherProjectId, other.packageId, 'HD-REPO-2')]);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [ProjectDocumentFilesController, ProjectDocumentsController, ProjectDocumentReadsController, DocumentCommentsController, DocumentReviewsController, DocumentReviewReadsController, ApprovalCommandsController, ApprovalTaskReadsController, WorkflowVersionReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: FileService, useValue: files },
        { provide: RepositoryFiles, useValue: new RepositoryFiles(files, new LocalTextExtractor()) },
        { provide: APPROVAL_FINAL_COMMANDS, useValue: registry },
        { provide: ApprovalService, useFactory: (commands: FinalCommandRegistry) => new ApprovalService(commands), inject: [APPROVAL_FINAL_COMMANDS] },
        { provide: DocumentReviewBinding, useFactory: (commands: FinalCommandRegistry) => new DocumentReviewBinding(commands, tenants), inject: [APPROVAL_FINAL_COMMANDS] },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
    if (objectRoot !== '') await rm(objectRoot, { recursive: true, force: true });
  }, 60_000);

  describe('files in: the upload, the checks on what it is, and the text read from it', () => {
    it('stores a Word file, a workbook and a PDF, tells their format, and reads each into citable units', async () => {
      const word = await upload(await wordFile('100'), DOCX);
      expect(word).toMatchObject({ status: 200, json: { format: 'DOCX', mime: DOCX, page_count: null } });
      const book = await upload(await workbookFile('1250'), XLSX);
      expect(book.json).toMatchObject({ format: 'XLSX', page_count: null });
      const pdf = await upload(await pdfFile('Page one of the plan'), 'application/pdf');
      expect(pdf.json).toMatchObject({ format: 'PDF', page_count: 1 });
      expect(JSON.stringify(word.json)).not.toContain(objectRoot);

      const made = await createDocument(await wordFile('100'), DOCX);
      const version = await call('GET', `/project-document-versions/${made.versionId}`, { member: AUTHOR });
      expect(version.json).toMatchObject({ version: { extraction_status: 'EXTRACTED', unit_count: 4, locked: false, status: 'DRAFT' }, actions: { comment: true, download: true, re_extract: false } });
      const units = await call('GET', `/project-document-versions/${made.versionId}/units`, { member: AUTHOR });
      const items = units.json.items as Array<{ citation_id: string; citation_ref: string; locator: string; text: string; kind: string }>;
      expect(items.map((item) => [item.kind, item.locator, item.text])).toEqual([
        ['PARAGRAPH', 'para1', 'Điều 1. Phạm vi áp dụng của hợp đồng'],
        ['PARAGRAPH', 'para2', 'Giá trị hợp đồng là 100 tỷ đồng chưa gồm thuế giá trị gia tăng'],
        ['TABLE_CELL', 't1/r1c1', 'Hạng mục'],
        ['TABLE_CELL', 't1/r1c2', '100'],
      ]);
      expect(items[0]?.citation_ref).toBe(`docver:${made.versionId}#${items[0]?.citation_id}`);
      const cited = await call('GET', `/project-document-versions/${made.versionId}/units/${items[1]?.citation_id}`, { member: AUTHOR });
      expect(cited.json).toMatchObject({ citation_ref: items[1]?.citation_ref, unit: { text: items[1]?.text }, before: { locator: 'para1' }, after: { locator: 't1/r1c1' }, version: { id: made.versionId, version_no: 1 } });
      expect(await call('GET', `/project-document-versions/${made.versionId}/units/cit_${'0'.repeat(20)}`, { member: AUTHOR })).toMatchObject({ status: 404 });
      expect(await call('GET', `/project-document-versions/${made.versionId}/units/not-a-citation`, { member: AUTHOR })).toMatchObject({ status: 422 });

      const sheet = await createDocument(await workbookFile('1250'), XLSX, { doc_class: 'COST_ESTIMATE' });
      const cells = await call('GET', `/project-document-versions/${sheet.versionId}/units`, { member: AUTHOR });
      expect((cells.json.items as Array<{ locator: string; sheet: string; cell: string }>).map((item) => [item.locator, item.sheet, item.cell])).toEqual([
        ['Dự toán!A1', 'Dự toán', 'A1'],
        ['Dự toán!B1', 'Dự toán', 'B1'],
        ['Dự toán!A2', 'Dự toán', 'A2'],
        ['Dự toán!B2', 'Dự toán', 'B2'],
      ]);
      // Reading the same bytes again gives the same citation: it comes from the file and the place.
      const again = await createDocument(await workbookFile('1250'), XLSX, { doc_class: 'COST_ESTIMATE' });
      const second = await call('GET', `/project-document-versions/${again.versionId}/units`, { member: AUTHOR });
      expect((second.json.items as Array<{ citation_id: string }>).map((item) => item.citation_id)).toEqual((cells.json.items as Array<{ citation_id: string }>).map((item) => item.citation_id));
    });

    it('refuses what is not a document of the three formats: another type, a mislabelled container, an infected file', async () => {
      expect(await upload(new TextEncoder().encode('just text'), 'text/plain')).toMatchObject({ status: 422, json: { code: 'FILE_TYPE_NOT_ALLOWED' } });
      expect(await upload(await wordFile('1'), XLSX)).toMatchObject({ status: 422, json: { code: 'DOC_FILE_FORMAT_MISMATCH' } });
      expect(await upload(await workbookFile('1'), DOCX)).toMatchObject({ status: 422, json: { code: 'DOC_FILE_FORMAT_MISMATCH' } });
      const infected = new Uint8Array([...new TextEncoder().encode('%PDF-1.7\n'), ...eicarBytes()]);
      expect(await upload(infected, 'application/pdf')).toMatchObject({ status: 422, json: { code: 'FILE_NOT_CLEAN' } });
      expect(await upload(await pdfFile('x'), 'application/pdf', NOBODY)).toMatchObject({ status: 403 });
    });

    it('opens the file again by key and hash: a hash that is not the file, a key that is not a document of the tenant', async () => {
      const staged = await upload(await pdfFile('Hash me'), 'application/pdf');
      const body = { project_id: projectId, doc_class: 'REPORT', title: 'Báo cáo tiến độ tháng', file_object_key: staged.json.file_object_key, file_sha256: 'f'.repeat(64) };
      expect(await call('POST', '/project-documents', { member: AUTHOR, body })).toMatchObject({ status: 422, json: { code: 'HASH_MISMATCH' } });
      expect(await call('POST', '/project-documents', { member: AUTHOR, body: { ...body, file_sha256: staged.json.file_sha256, file_object_key: `tenants/${TENANT_B}/document/${randomUUID()}` } })).toMatchObject({ status: 404 });
      expect(await call('POST', '/project-documents', { member: AUTHOR, body: { ...body, file_sha256: staged.json.file_sha256, file_object_key: `tenants/${TENANT_A}/import/${randomUUID()}` } })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'file_object_key' } });
    });
  });

  describe('the documents: links, classes, effective dates, versions, the list and the scope', () => {
    it('links a document to a contract and a package of its project only, and lists and filters by them', async () => {
      const staged = await upload(await pdfFile('Contract text'), 'application/pdf');
      const base = { project_id: projectId, doc_class: 'CONTRACT', title: 'Hợp đồng thi công gói số 3', file_object_key: staged.json.file_object_key, file_sha256: staged.json.file_sha256 };
      expect(await call('POST', '/project-documents', { member: AUTHOR, body: { ...base, contract_id: otherContractId } })).toMatchObject({ status: 422, json: { code: 'DOC_LINK_MISMATCH' } });
      expect(await rows('select id from machvon.project_document where project_id = $1 and doc_class = $2', [projectId, 'CONTRACT'])).toHaveLength(0);
      const made = await call('POST', '/project-documents', { member: AUTHOR, body: { ...base, reference: 'HD-03/2026', contract_id: contractId, package_id: packageId, effective_from: '2026-01-01', effective_to: '2026-12-31', security_class: 'CONFIDENTIAL' } });
      expect(made.status).toBe(200);
      const id = made.json.resource_id as string;
      const detail = await call('GET', `/project-documents/${id}`, { member: READER });
      expect(detail.json.document).toMatchObject({ doc_class: 'CONTRACT', contract: { id: contractId, code: 'HD-REPO-1' }, package: { id: packageId }, effective_state: 'IN_FORCE', security_class: 'CONFIDENTIAL', status: 'ACTIVE', version_count: 1 });
      expect(detail.json.actions).toMatchObject({ update: false, add_version: false, comment: false, submit_for_review: false });
      const byContract = await call('GET', `/project-documents?contract_id=${contractId}`, { member: READER });
      expect((byContract.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([id]);
      expect(byContract.json.classes).toContain('CONTRACT');
      expect(await call('GET', '/project-documents?doc_class=NOT_A_CLASS', { member: READER })).toMatchObject({ status: 422, json: { detail: 'doc_class' } });
      expect(await call('GET', '/project-documents?effective=EXPIRED&contract_id=' + contractId, { member: READER })).toMatchObject({ status: 200, json: { items: [] } });
      // The same reference in the same class of the project is filed once.
      expect(await call('POST', '/project-documents', { member: AUTHOR, body: { ...base, reference: 'hd-03/2026' } })).toMatchObject({ status: 409, json: { code: 'DOC_DUPLICATE_REFERENCE' } });
    });

    it('corrects the description at the version read, adds a version, archives with a reason and restores', async () => {
      const made = await createDocument(await wordFile('100'), DOCX);
      const before = await call('GET', `/project-documents/${made.documentId}`, { member: AUTHOR });
      expect(before.json.actions).toMatchObject({ update: true, add_version: true, archive: true, restore: false, submit_for_review: true });
      expect(await call('POST', `/project-documents/${made.documentId}/description`, { member: AUTHOR, ifMatch: '"9"', body: { title: 'Tiêu đề đã sửa của hồ sơ' } })).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      const updated = await call('POST', `/project-documents/${made.documentId}/description`, { member: AUTHOR, ifMatch: '"1"', body: { title: 'Tiêu đề đã sửa của hồ sơ', effective_from: '2026-03-01' } });
      expect(updated).toMatchObject({ status: 200, json: { status: 'UPDATED', resource_version: 2 } });
      expect(await call('POST', `/project-documents/${made.documentId}/description`, { member: AUTHOR, ifMatch: '"2"', body: { effective_from: '2026-03-01', effective_to: '2026-01-01' } })).toMatchObject({ status: 422, json: { detail: 'effective_to' } });
      const version2 = await addVersion(made.documentId, await wordFile('120', true), DOCX);
      const list = await call('GET', `/project-documents?project_id=${projectId}&q=${encodeURIComponent('đã sửa')}`, { member: AUTHOR });
      expect((list.json.items as Array<{ id: string; version_count: number; current_version: { id: string; version_no: number } }>).find((item) => item.id === made.documentId)).toMatchObject({ version_count: 2, current_version: { id: version2, version_no: 2 } });
      expect(await call('POST', `/project-documents/${made.documentId}/archive`, { member: AUTHOR, ifMatch: '"3"', body: { reason: 'ngắn' } })).toMatchObject({ status: 422, json: { detail: 'reason' } });
      expect(await call('POST', `/project-documents/${made.documentId}/archive`, { member: AUTHOR, ifMatch: '"3"', body: { reason: 'Thay bằng hồ sơ thiết kế mới' } })).toMatchObject({ status: 200, json: { status: 'ARCHIVED' } });
      const staged = await upload(await wordFile('777'), DOCX);
      expect(await call('POST', `/project-documents/${made.documentId}/versions`, { member: AUTHOR, body: { file_object_key: staged.json.file_object_key, file_sha256: staged.json.file_sha256 } })).toMatchObject({ status: 409, json: { code: 'DOC_ARCHIVED' } });
      expect(await call('POST', `/project-documents/${made.documentId}/restore`, { member: AUTHOR, ifMatch: '"4"', body: {} })).toMatchObject({ status: 200, json: { status: 'RESTORED' } });
      const audit = await rows<{ action: string }>("select action from machvon.audit_event where resource_id = $1 order by occurred_at", [made.documentId]);
      expect(audit.map((row) => row.action)).toEqual(expect.arrayContaining(['doc.repo.document_created', 'doc.repo.document_updated', 'doc.repo.document_archived', 'doc.repo.document_restored']));
      // The trail names fields, never the title or the text.
      expect(JSON.stringify(await rows('select safe_diff from machvon.audit_event where resource_id = $1', [made.documentId]))).not.toContain('Tiêu đề đã sửa');
    });

    it('does not show a document to a member whose grant is over another unit, to a reader who cannot act, or to another tenant', async () => {
      const made = await createDocument(await pdfFile('Scoped'), 'application/pdf');
      expect(await call('GET', `/project-documents/${made.documentId}`, { member: OUTSIDE })).toMatchObject({ status: 404 });
      expect((await call('GET', `/project-documents?project_id=${projectId}`, { member: OUTSIDE })).json.items).toEqual([]);
      expect(await call('GET', `/project-document-versions/${made.versionId}`, { member: OUTSIDE })).toMatchObject({ status: 404 });
      expect(await call('GET', `/project-document-versions/${made.versionId}/units`, { member: OUTSIDE })).toMatchObject({ status: 404 });
      expect(await call('POST', `/project-documents/${made.documentId}/archive`, { member: OUTSIDE, ifMatch: '"1"', body: { reason: 'Không thuộc phạm vi của tôi' } })).toMatchObject({ status: 404 });
      expect(await call('GET', `/project-documents/${made.documentId}`, { member: NOBODY })).toMatchObject({ status: 403 });
      expect(await call('POST', `/project-documents/${made.documentId}/archive`, { member: READER, ifMatch: '"1"', body: { reason: 'Người đọc không được lưu trữ' } })).toMatchObject({ status: 403 });
      expect(await call('GET', `/project-documents/${made.documentId}`, { member: OTHER_TENANT, tenantId: TENANT_B })).toMatchObject({ status: 404 });
    });

    it('serves a file by a signed link that lives for minutes, and leaves a trace of who asked', async () => {
      const bytes = await pdfFile('Download me');
      const made = await createDocument(bytes, 'application/pdf');
      const link = await call('GET', `/project-document-versions/${made.versionId}/download`, { member: AUTHOR });
      expect(link.status).toBe(200);
      const url = String(link.json.url);
      expect(url).toMatch(/^\/project-document-files\/[0-9a-f-]{36}\?tenant=/);
      expect(url).not.toContain('tenants/');
      const served = await fetch(`${app.baseUrl}${url}`);
      expect(served.status).toBe(200);
      expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes);
      const tampered = await fetch(`${app.baseUrl}${url.replace(/signature=[0-9a-f]{4}/, 'signature=0000')}`);
      expect(tampered.status).toBe(401);
      expect((await rows<{ action: string }>("select action from machvon.audit_event where resource_id = $1 and action = 'doc.repo.file_downloaded'", [made.versionId])).length).toBe(1);
    });
  });

  describe('comments on a version', () => {
    it('anchors a comment to a citation, threads one level, resolves and reopens, and the words are never in the trail', async () => {
      const made = await createDocument(await wordFile('100'), DOCX);
      const units = (await call('GET', `/project-document-versions/${made.versionId}/units`, { member: AUTHOR })).json.items as Array<{ citation_id: string }>;
      const anchor = units[1]?.citation_id as string;
      const first = await call('POST', `/project-document-versions/${made.versionId}/comments`, { member: REV_A, body: { citation_id: anchor, body: 'Cần ghi rõ giá đã gồm thuế hay chưa' } });
      expect(first).toMatchObject({ status: 200, json: { status: 'OPEN' } });
      const reply = await call('POST', `/project-document-versions/${made.versionId}/comments`, { member: AUTHOR, body: { parent_id: first.json.resource_id, body: 'Đã bổ sung ở bản sau' } });
      expect(reply.status).toBe(200);
      expect(await call('POST', `/project-document-versions/${made.versionId}/comments`, { member: AUTHOR, body: { parent_id: reply.json.resource_id, body: 'Trả lời của trả lời' } })).toMatchObject({ status: 422, json: { code: 'DOC_COMMENT_PARENT_INVALID' } });
      expect(await call('POST', `/project-document-versions/${made.versionId}/comments`, { member: AUTHOR, body: { citation_id: `cit_${'1'.repeat(20)}`, body: 'Neo vào chỗ không có' } })).toMatchObject({ status: 422, json: { code: 'DOC_COMMENT_ANCHOR_UNKNOWN' } });
      const open = await call('GET', `/project-document-versions/${made.versionId}/comments?status=OPEN`, { member: READER });
      expect(open.json).toMatchObject({ open_count: 2 });
      expect((open.json.items as Array<{ id: string; citation_label: string | null }>)[0]).toMatchObject({ id: first.json.resource_id, citation_label: 'para2' });
      const withCounts = await call('GET', `/project-document-versions/${made.versionId}/units`, { member: AUTHOR });
      expect((withCounts.json.items as Array<{ open_comments: number }>).map((item) => item.open_comments)).toEqual([0, 1, 0, 0]);
      expect(await call('POST', `/document-comments/${first.json.resource_id}/resolve`, { member: AUTHOR, body: { note: 'Đã sửa' } })).toMatchObject({ status: 200, json: { status: 'RESOLVED' } });
      expect(await call('POST', `/document-comments/${first.json.resource_id}/resolve`, { member: AUTHOR, body: {} })).toMatchObject({ status: 409, json: { code: 'DOC_COMMENT_STATE_INVALID' } });
      expect(await call('POST', `/document-comments/${first.json.resource_id}/reopen`, { member: REV_A, body: {} })).toMatchObject({ status: 200, json: { status: 'OPEN' } });
      expect(await call('POST', `/document-comments/${first.json.resource_id}/reopen`, { member: OUTSIDE, body: {} })).toMatchObject({ status: 404 });
      expect(await call('POST', `/project-document-versions/${made.versionId}/comments`, { member: READER, body: { body: 'Người đọc không được góp ý' } })).toMatchObject({ status: 403 });
      expect(JSON.stringify(await rows("select safe_diff from machvon.audit_event where action like 'doc.repo.comment%'"))).not.toContain('Cần ghi rõ');
    });
  });

  describe('the comparison of two versions', () => {
    it('shows the words that changed in a paragraph, the paragraph that is new, and only the cells that changed in a workbook', async () => {
      const made = await createDocument(await wordFile('100'), DOCX);
      const second = await addVersion(made.documentId, await wordFile('120', true), DOCX);
      const result = await call('GET', `/project-documents/${made.documentId}/compare?from_version_id=${made.versionId}&to_version_id=${second}`, { member: READER });
      expect(result.status).toBe(200);
      expect(result.json).toMatchObject({ mode: 'SEQUENCE', summary: { equal: 2, added: 2, removed: 1, changed: 1 } });
      const changed = (result.json.entries as Array<{ op: string; words: Array<{ op: string; text: string }> | null; after: { text: string } | null }>).find((entry) => entry.op === 'CHANGED' && entry.after?.text.startsWith('Giá trị'));
      expect(changed?.words?.filter((segment) => segment.op !== 'EQUAL')).toEqual([
        { op: 'REMOVED', text: '100' },
        { op: 'ADDED', text: '120' },
      ]);
      expect(String(result.json.formula)).toContain('longest common subsequence');

      const book = await createDocument(await workbookFile('1250'), XLSX, { doc_class: 'COST_ESTIMATE' });
      const book2 = await addVersion(book.documentId, await workbookFile('1300'), XLSX);
      const cells = await call('GET', `/project-documents/${book.documentId}/compare?from_version_id=${book.versionId}&to_version_id=${book2}`, { member: READER });
      expect(cells.json).toMatchObject({ mode: 'CELLS', summary: { equal: 3, added: 0, removed: 0, changed: 1 } });

      expect(await call('GET', `/project-documents/${made.documentId}/compare?from_version_id=${made.versionId}&to_version_id=${made.versionId}`, { member: READER })).toMatchObject({ status: 422, json: { detail: 'to_version_id' } });
      expect(await call('GET', `/project-documents/${made.documentId}/compare?from_version_id=${made.versionId}&to_version_id=${book2}`, { member: READER })).toMatchObject({ status: 404 });
      expect(await call('GET', `/project-documents/${made.documentId}/compare?from_version_id=${made.versionId}`, { member: READER })).toMatchObject({ status: 422 });
    });
  });

  describe('the review: stages, parallel reviewers, a request for a supplement, the next round, the lock', () => {
    const definition = {
      steps: [
        { id: 'technical', name: 'Technical review', assignee_rule: { type: 'SPECIFIC', membership_ids: [memberId(REV_A), memberId(REV_B), memberId(REV_C)] }, min_approvals: 2, sla_working_hours: 24, on_timeout: 'REMIND' },
        { id: 'legal', name: 'Legal review', assignee_rule: { type: 'SPECIFIC', membership_ids: [memberId(REV_D)] }, min_approvals: 1, sla_working_hours: 16, on_timeout: 'REMIND', allow_return_to: 'technical' },
      ],
      terminal: { approved: 'approveDocumentReview', returned: 'requestDocumentSupplement', rejected: 'rejectDocumentReview' },
    };

    it('refuses to send a version while no workflow is published, and leaves the version a draft', async () => {
      const made = await createDocument(await pdfFile('No workflow yet'), 'application/pdf');
      expect(await call('POST', `/project-documents/${made.documentId}/reviews`, { member: AUTHOR, body: { version_id: made.versionId } })).toMatchObject({ status: 422, json: { code: 'WORKFLOW_NOT_CONFIGURED' } });
      expect(await rows('select id from machvon.document_review where document_id = $1', [made.documentId])).toHaveLength(0);
      expect((await call('GET', `/project-document-versions/${made.versionId}`, { member: AUTHOR })).json).toMatchObject({ version: { status: 'DRAFT' } });
    });

    it('runs two rounds to approval and locks the approved version, and the board shows every step of it', async () => {
      const created = await call('POST', '/workflow-definitions', { member: ADMIN, body: { business_type: 'document.review', definition } });
      expect(created.status).toBe(200);
      const published = await call('POST', `/workflow-definitions/${created.json.resource_id}/publish`, { member: PUBLISHER, ifMatch: '"1"', body: { reason: 'Công bố quy trình duyệt hồ sơ dự án.' } });
      expect(published).toMatchObject({ status: 200, json: { status: 'PUBLISHED' } });

      const made = await createDocument(await wordFile('100'), DOCX);
      expect(await call('POST', `/project-documents/${made.documentId}/reviews`, { member: READER, body: { version_id: made.versionId } })).toMatchObject({ status: 403 });
      expect(await call('POST', `/project-documents/${made.documentId}/reviews`, { member: AUTHOR, body: { version_id: randomUUID() } })).toMatchObject({ status: 404 });
      const sent = await call('POST', `/project-documents/${made.documentId}/reviews`, { member: AUTHOR, body: { version_id: made.versionId, note: 'Trình thẩm định lần đầu' } });
      expect(sent).toMatchObject({ status: 200, json: { status: 'IN_REVIEW' } });
      const reviewId = sent.json.resource_id as string;
      expect(await call('POST', `/project-documents/${made.documentId}/reviews`, { member: AUTHOR, body: { version_id: made.versionId } })).toMatchObject({ status: 409, json: { code: 'DOC_VERSION_STATE_INVALID' } });

      let board = await call('GET', `/document-reviews/${reviewId}`, { member: REV_A });
      expect(board.json).toMatchObject({ review: { round: 1, status: 'IN_REVIEW', version_no: 1 }, workflow_revision: 1, actions: { withdraw: false, resubmit: false } });
      const stages = board.json.stages as Array<{ id: string; state: string; min_approvals: number; reviewers: Array<{ assignee_id: string; state: string; can_decide: boolean; task_version: number | null }> }>;
      expect(stages.map((stage) => [stage.id, stage.state, stage.min_approvals, stage.reviewers.length])).toEqual([['technical', 'CURRENT', 2, 3], ['legal', 'WAITING', 1, 0]]);
      // Only the person a task is given to may decide it: the board says so for the caller.
      expect(stages[0]?.reviewers.filter((reviewer) => reviewer.can_decide).map((reviewer) => reviewer.assignee_id)).toEqual([memberId(REV_A)]);
      expect(stages[0]?.reviewers.find((reviewer) => reviewer.assignee_id === memberId(REV_A))?.task_version).toBe(1);

      // The one who sent the version never decides on it (the maker is not the checker): the author holds no task.
      expect(await taskOf(await instanceOf(reviewId), AUTHOR)).toBeUndefined();
      expect(await decide(reviewId, REV_A, 'approve')).toMatchObject({ status: 200 });
      expect(await decide(reviewId, REV_B, 'approve')).toMatchObject({ status: 200 });
      board = await call('GET', `/document-reviews/${reviewId}`, { member: AUTHOR });
      expect((board.json.stages as Array<{ state: string }>).map((stage) => stage.state)).toEqual(['DONE', 'CURRENT']);
      expect(((board.json.stages as Array<{ reviewers: Array<{ state: string }> }>)[0]?.reviewers ?? []).map((reviewer) => reviewer.state).sort()).toEqual(['APPROVED', 'APPROVED', 'NOT_NEEDED']);
      expect(board.json.actions).toMatchObject({ withdraw: true });

      expect(await decide(reviewId, REV_D, 'return', 'Thiếu căn cứ pháp lý của đơn giá')).toMatchObject({ status: 200, json: { status: 'RETURNED' } });
      board = await call('GET', `/document-reviews/${reviewId}`, { member: AUTHOR });
      expect(board.json).toMatchObject({ review: { status: 'SUPPLEMENT_REQUESTED', conclusion_note: 'Thiếu căn cứ pháp lý của đơn giá' }, outcome: 'RETURNED', actions: { withdraw: false, resubmit: true } });
      expect((board.json.stages as Array<{ state: string }>).map((stage) => stage.state)).toEqual(['DONE', 'SUPPLEMENT_REQUESTED']);
      expect((board.json.events as Array<{ kind: string }>).map((event) => event.kind)).toEqual(['SUBMITTED', 'SUPPLEMENT_REQUESTED']);
      expect((await call('GET', `/project-document-versions/${made.versionId}`, { member: AUTHOR })).json).toMatchObject({ version: { status: 'SUPPLEMENT_REQUESTED', locked: false } });

      // The same file is not a supplement: a newer version is, and it is the next round.
      expect(await call('POST', `/project-documents/${made.documentId}/reviews`, { member: AUTHOR, body: { version_id: made.versionId } })).toMatchObject({ status: 409 });
      const next = await addVersion(made.documentId, await wordFile('100', true), DOCX);
      const second = await call('POST', `/project-documents/${made.documentId}/reviews`, { member: AUTHOR, body: { version_id: next } });
      expect(second).toMatchObject({ status: 200, json: { status: 'IN_REVIEW' } });
      const secondId = second.json.resource_id as string;
      expect((await call('GET', `/document-reviews/${secondId}`, { member: AUTHOR })).json).toMatchObject({ review: { round: 2, previous_review_id: reviewId, version_no: 2 } });
      expect(await decide(secondId, REV_A, 'approve')).toMatchObject({ status: 200 });
      expect(await decide(secondId, REV_C, 'approve')).toMatchObject({ status: 200 });
      expect(await decide(secondId, REV_D, 'approve')).toMatchObject({ status: 200, json: { status: 'APPROVED' } });

      const locked = await call('GET', `/project-document-versions/${next}`, { member: AUTHOR });
      expect(locked.json).toMatchObject({ version: { status: 'APPROVED', locked: true, locked_by_name: 'User 7' }, actions: { re_extract: false } });
      const detail = await call('GET', `/project-documents/${made.documentId}`, { member: AUTHOR });
      expect(detail.json.document).toMatchObject({ approved_version: { id: next, version_no: 2 }, latest_review: { round: 2, status: 'APPROVED' } });
      expect((detail.json.rounds as Array<{ round: number; status: string }>).map((round) => [round.round, round.status])).toEqual([[2, 'APPROVED'], [1, 'SUPPLEMENT_REQUESTED']]);
      // The lock holds against every writer, the database included; a comment is still welcome; the next change is a new version.
      expect(await rows("select 1 from machvon.project_document_version where id = $1 and locked_at is not null", [next])).toHaveLength(1);
      await expect(rows("update machvon.project_document_version set change_note = 'đổi' where id = $1", [next])).rejects.toThrow(/DOC_VERSION_LOCKED/);
      expect(await call('POST', `/project-document-versions/${next}/comments`, { member: REV_A, body: { body: 'Ghi nhận sau khi duyệt' } })).toMatchObject({ status: 200 });
      expect(await call('POST', `/project-document-versions/${next}/extraction`, { member: AUTHOR, body: {} })).toMatchObject({ status: 409 });
      await addVersion(made.documentId, await wordFile('130'), DOCX);

      // Trail and events: one concluded event per round, one lock event, and no text anywhere.
      const concluded = await rows<{ type: string }>("select type from machvon.outbox_event where aggregate_id = any($1::uuid[]) order by created_at", [[reviewId, secondId]]);
      expect(concluded.map((row) => row.type).filter((type) => type.startsWith('doc.repo.review_concluded'))).toHaveLength(2);
      expect(await rows("select 1 from machvon.outbox_event where aggregate_id = $1 and type = 'doc.repo.version_locked.v1'", [next])).toHaveLength(1);
      const actions = (await rows<{ action: string }>('select action from machvon.audit_event where resource_id = any($1::uuid[])', [[reviewId, secondId]])).map((row) => row.action);
      expect(actions).toEqual(expect.arrayContaining(['doc.repo.review_submitted', 'doc.repo.review_supplement_requested', 'doc.repo.review_approved']));
      expect(JSON.stringify(await rows("select safe_diff from machvon.audit_event where action like 'doc.repo.review%'"))).not.toContain('Thiếu căn cứ');

      const listed = await call('GET', `/document-reviews?document_id=${made.documentId}`, { member: READER });
      expect((listed.json.items as Array<{ round: number; status: string }>).map((item) => [item.round, item.status])).toEqual([[2, 'APPROVED'], [1, 'SUPPLEMENT_REQUESTED']]);
      expect(await call('GET', `/document-reviews/${reviewId}`, { member: OUTSIDE })).toMatchObject({ status: 404 });
      expect(await call('GET', `/document-reviews/${reviewId}`, { member: OTHER_TENANT, tenantId: TENANT_B })).toMatchObject({ status: 404 });
      expect(await call('GET', '/document-reviews?status=NOT_A_STATUS', { member: READER })).toMatchObject({ status: 422 });
    });

    it('ends a round rejected, and withdraws an open one by the person who sent it', async () => {
      const made = await createDocument(await pdfFile('To be rejected'), 'application/pdf');
      const sent = await call('POST', `/project-documents/${made.documentId}/reviews`, { member: AUTHOR, body: { version_id: made.versionId } });
      const reviewId = sent.json.resource_id as string;
      expect(await decide(reviewId, REV_A, 'reject', 'Hồ sơ không đúng mẫu quy định')).toMatchObject({ status: 200, json: { status: 'REJECTED' } });
      expect((await call('GET', `/document-reviews/${reviewId}`, { member: AUTHOR })).json).toMatchObject({ review: { status: 'REJECTED' }, actions: { resubmit: true } });
      expect((await call('GET', `/project-document-versions/${made.versionId}`, { member: AUTHOR })).json).toMatchObject({ version: { status: 'REJECTED' } });

      const again = await createDocument(await pdfFile('To be withdrawn'), 'application/pdf');
      const open = await call('POST', `/project-documents/${again.documentId}/reviews`, { member: AUTHOR, body: { version_id: again.versionId } });
      const openId = open.json.resource_id as string;
      const detail = await call('GET', `/document-reviews/${openId}`, { member: AUTHOR });
      const version = (detail.json.review as { version: number }).version;
      expect(await call('POST', `/document-reviews/${openId}/withdraw`, { member: REV_A, ifMatch: `"${version}"`, body: { reason: 'Không phải người trình bản này' } })).toMatchObject({ status: 403 });
      expect(await call('POST', `/document-reviews/${openId}/withdraw`, { member: AUTHOR, ifMatch: `"${version}"`, body: { reason: 'ngắn' } })).toMatchObject({ status: 422 });
      expect(await call('POST', `/document-reviews/${openId}/withdraw`, { member: AUTHOR, ifMatch: `"${version}"`, body: { reason: 'Gửi nhầm hồ sơ, sẽ trình lại sau' } })).toMatchObject({ status: 200, json: { status: 'WITHDRAWN' } });
      expect((await call('GET', `/project-document-versions/${again.versionId}`, { member: AUTHOR })).json).toMatchObject({ version: { status: 'DRAFT' } });
      expect(await rows("select 1 from machvon.workflow_instance where resource_id = $1 and status = 'Cancelled'", [openId])).toHaveLength(1);
      expect(await call('POST', `/document-reviews/${openId}/withdraw`, { member: AUTHOR, ifMatch: `"${version + 1}"`, body: { reason: 'Rút lại một lần nữa nữa' } })).toMatchObject({ status: 409, json: { code: 'DOC_REVIEW_NOT_OPEN' } });
      expect(await call('POST', `/project-documents/${again.documentId}/reviews`, { member: AUTHOR, body: { version_id: again.versionId } })).toMatchObject({ status: 200 });
    });

    it('does not archive a document that is in review', async () => {
      const made = await createDocument(await pdfFile('In review'), 'application/pdf');
      await call('POST', `/project-documents/${made.documentId}/reviews`, { member: AUTHOR, body: { version_id: made.versionId } });
      const current = await call('GET', `/project-documents/${made.documentId}`, { member: AUTHOR });
      expect(current.json.actions).toMatchObject({ archive: false, submit_for_review: false });
      expect(await call('POST', `/project-documents/${made.documentId}/archive`, { member: AUTHOR, ifMatch: `"${(current.json.document as { version: number }).version}"`, body: { reason: 'Thử lưu trữ khi đang duyệt' } })).toMatchObject({ status: 409, json: { code: 'DOC_REVIEW_IN_PROGRESS' } });
    });
  });

  it('answers the same idempotency key with the first answer and creates one document', async () => {
    const staged = await upload(await pdfFile('Once only'), 'application/pdf');
    const body = { project_id: projectId, doc_class: 'REPORT', title: 'Báo cáo chỉ nộp một lần', reference: 'BC-ONCE', file_object_key: staged.json.file_object_key, file_sha256: staged.json.file_sha256 };
    const key = `key-${randomUUID()}`;
    const first = await call('POST', '/project-documents', { member: AUTHOR, body, key });
    const second = await call('POST', '/project-documents', { member: AUTHOR, body, key });
    expect(first.status).toBe(200);
    expect(second.json.resource_id).toBe(first.json.resource_id);
    expect(await rows("select id from machvon.project_document where reference = 'BC-ONCE'")).toHaveLength(1);
  });
});
