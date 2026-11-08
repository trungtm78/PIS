import { randomUUID } from 'node:crypto';
import { citationIdOf, commentInputOf, compareUnits, normaliseExtraction, planSubmission, projectDocumentChangeOf, projectDocumentInputOf } from '@machvon/kernel';
import type { ExtractedUnit, SubmissionPlan } from '@machvon/kernel';
import { ApprovalStore } from '../src/approval-store';
import type { ApprovalEffects, FinalCommand } from '../src/approval-store';
import { DocumentCommentStore } from '../src/doc-comment-store';
import { DocumentRepositoryStore } from '../src/doc-repository-store';
import type { ExtractionRecord, FileFacts } from '../src/doc-repository-store';
import { DocumentReviewStore } from '../src/doc-review-store';
import { DocumentTextStore } from '../src/doc-text-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, roleId, unitId } from './support/authz-fixtures';
import { seedAs, seedBidPackage } from './support/bid-proposal-fixtures';

const harness = new AuthzHarness();
const documents = new DocumentRepositoryStore();
const texts = new DocumentTextStore();
const comments = new DocumentCommentStore();
const reviews = new DocumentReviewStore();
const approvals = new ApprovalStore();

const AUTHOR = 1;
const ADMIN = 2;
const PUBLISHER = 3;
const REV_A = 4;
const REV_B = 5;
const REV_C = 6;
const REV_D = 7;
const ROOT = 1;
const REVIEWER_ROLE = 1;
const ALL: ScopeBuilder = () => ({ sql: 'true', params: [] });
const NONE: ScopeBuilder = () => ({ sql: 'false', params: [] });
const BUSINESS_TYPE = 'document.review';
let NOW = new Date();
let tick = 0;

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = AUTHOR, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

interface Refusal {
  code: string;
  status: number;
  detail?: string;
  extensions?: Record<string, unknown>;
}

async function refusal(work: Promise<unknown>): Promise<Refusal> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

const databaseRefusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    return String((error as { message?: string }).message);
  }
  throw new Error('expected the database to refuse');
};

const sha = (): string => randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');

const file = (over: Partial<FileFacts> = {}): FileFacts => ({ key: `tenants/${TENANT_A}/document/${randomUUID()}`, sha256: sha(), sizeBytes: 2048, format: 'PDF', mime: 'application/pdf', pageCount: 2, ...over });

const reading = (fileSha: string, lines: ExtractedUnit[]): ExtractionRecord => {
  const { units, truncated } = normaliseExtraction(fileSha, lines);
  return { units, truncated, failed: false, engine: { name: 'test-extractor', version: '1' } };
};
const paragraphs = (fileSha: string, ...text: string[]): ExtractionRecord =>
  reading(
    fileSha,
    text.map((line, index) => ({ kind: 'PARAGRAPH' as const, locator: { page: 1, paragraph: index + 1 }, text: line, box: { x0: 0.1, y0: 0.1 * (index + 1), x1: 0.9, y1: 0.1 * (index + 1) + 0.05 } })),
  );
const noText: ExtractionRecord = { units: [], truncated: 0, failed: false, engine: { name: 'test-extractor', version: '1' } };

let reference = 0;
const describeDocument = (projectId: string, over: Record<string, unknown> = {}) => projectDocumentInputOf({ project_id: projectId, doc_class: 'DESIGN', title: 'Thiết kế cơ sở gói thầu số 3', reference: `TK-${(reference += 1)}`, ...over });

async function createDocument(projectId: string, over: Record<string, unknown> = {}, lines: string[] = ['Điều 1. Phạm vi', 'Giá trị hợp đồng là 100 tỷ đồng']) {
  const facts = file();
  return as((tx) => documents.create(tx, describeDocument(projectId, over), facts, paragraphs(facts.sha256, ...lines), 'bản đầu', memberId(AUTHOR), ALL, NOW));
}

const effects = (member: number): ApprovalEffects => ({ actor: memberId(member), audit: () => Promise.resolve(), emit: () => Promise.resolve() });
const asFinal: FinalCommand = async (call) => {
  const done = await reviews.conclude(call.tx, call.instance.id, call.instance.decisionSeq, call.outcome);
  return done.kind === 'CONCLUDED' ? 'APPLIED' : 'GUARD_REJECTED';
};

/** Sends a version to review the way the controller does: the plan, the round, the version, the instance. */
async function submit(documentId: string, versionId: string, member = AUTHOR) {
  return as(async (tx) => {
    const document = await documents.find(tx, documentId, ALL, NOW);
    const found = await documents.findVersion(tx, versionId, ALL, NOW);
    if (document === undefined || found === undefined) throw new Error('not found');
    const latest = await reviews.latestOf(tx, documentId);
    const plan: SubmissionPlan = planSubmission({
      documentActive: document.status === 'ACTIVE',
      version: { id: versionId, versionNo: found.version.versionNo, status: found.version.status, extractionStatus: found.version.extractionStatus },
      latest: latest === undefined ? null : { id: latest.id, round: latest.round, status: latest.status, versionNo: latest.versionNo },
    });
    const review = await reviews.open(tx, plan, { documentId, versionId, note: null }, memberId(member));
    const instance = await approvals.start(tx, effects(member), {
      resourceType: 'document_review',
      resourceId: review.id,
      resourceVersion: review.version,
      businessType: BUSINESS_TYPE,
      amountVnd: null,
      unitId: unitId(ROOT),
      initiatorMembershipId: memberId(member),
      now: NOW,
    });
    await reviews.attachInstance(tx, review.id, instance.id);
    return { review: (await reviews.find(tx, review.id)) as NonNullable<Awaited<ReturnType<typeof reviews.find>>>, instance, plan };
  }, member);
}

const taskOf = async (instanceId: string, member: number) => {
  const [task] = await owner<{ id: string; version: string }>("select id, version::text from machvon.approval_task where workflow_instance_id = $1 and assignee_id = $2 and status = 'Pending'", [instanceId, memberId(member)]);
  if (task === undefined) throw new Error(`no pending task of member ${member}`);
  return { id: task.id, version: Number(task.version) };
};

async function decide(instanceId: string, member: number, decision: 'approve' | 'return' | 'reject', reason?: string) {
  const task = await taskOf(instanceId, member);
  tick += 1;
  return as((tx) => approvals.decide(tx, effects(member), { taskId: task.id, expectedVersion: task.version, decision, reason, returnToStep: undefined, now: new Date(NOW.getTime() + tick * 1000), finish: asFinal }), member);
}

describe('the project document repository (DOC-2)', () => {
  let projectId: string;
  let otherProjectId: string;
  let packageId: string;
  let contractId: string;
  let otherContractId: string;

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
      for (const member of [AUTHOR, ADMIN, PUBLISHER, REV_A, REV_B, REV_C, REV_D]) await harness.seedMembership(tenant, member, ROOT);
    }
    await harness.seedRole(TENANT_A, REVIEWER_ROLE, 'REVIEWER', ['approval.decide'], 40);
    await harness.seedGrants(
      TENANT_A,
      [REV_A, REV_B, REV_C, REV_D].map((member, index) => ({ n: index + 1, member, role: REVIEWER_ROLE, kind: 'TENANT' as const })),
    );
    const seeded = await seedBidPackage(harness, { unit: ROOT });
    const other = await seedBidPackage(harness, { unit: ROOT });
    projectId = seeded.projectId;
    packageId = seeded.packageId;
    otherProjectId = other.projectId;
    contractId = randomUUID();
    otherContractId = randomUUID();
    await seedAs(harness, [
      [
        'insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1)',
        [TENANT_A, contractId, projectId, packageId, randomUUID(), 'HD-DOC2-1', 'LUMP_SUM', 'VND', 'DRAFT'],
      ],
      [
        'insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1)',
        [TENANT_A, otherContractId, otherProjectId, other.packageId, randomUUID(), 'HD-DOC2-2', 'LUMP_SUM', 'VND', 'DRAFT'],
      ],
    ]);
    // The workflow of the review: two stages, the first with three parallel reviewers of whom two must approve.
    const member = (n: number): string => memberId(n);
    const definition = {
      steps: [
        { id: 'technical', name: 'Technical review', assignee_rule: { type: 'SPECIFIC', membership_ids: [member(REV_A), member(REV_B), member(REV_C)] }, min_approvals: 2, sla_working_hours: 24, on_timeout: 'REMIND' },
        { id: 'legal', name: 'Legal review', assignee_rule: { type: 'SPECIFIC', membership_ids: [member(REV_D)] }, min_approvals: 1, sla_working_hours: 16, on_timeout: 'REMIND', allow_return_to: 'technical' },
      ],
      terminal: { approved: 'approveDocumentReview', returned: 'requestDocumentSupplement', rejected: 'rejectDocumentReview' },
    };
    const draft = await as((tx) => approvals.createDraft(tx, { businessType: BUSINESS_TYPE, definition }, memberId(ADMIN)), ADMIN);
    await as((tx) => approvals.publish(tx, draft.id, draft.version, memberId(PUBLISHER), new Date()), PUBLISHER);
    NOW = new Date(Date.now() + 1000);
  }, 300_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the documents of a project', () => {
    it('keeps a document with its first version, the file facts and the text in citable units', async () => {
      const { document, version } = await createDocument(projectId, { contract_id: contractId, package_id: packageId, effective_from: '2026-01-01', effective_to: '2026-12-31', security_class: 'CONFIDENTIAL' });
      expect(document).toMatchObject({
        project: { id: projectId },
        contract: { id: contractId, code: 'HD-DOC2-1' },
        package: { id: packageId },
        docClass: 'DESIGN',
        securityClass: 'CONFIDENTIAL',
        effectiveState: 'IN_FORCE',
        status: 'ACTIVE',
        versionCount: 1,
        approvedVersion: null,
        latestReview: null,
        version: 1,
      });
      expect(document.currentVersion).toMatchObject({ id: version.id, versionNo: 1, status: 'DRAFT', format: 'PDF' });
      expect(version).toMatchObject({ versionNo: 1, extractionStatus: 'EXTRACTED', unitCount: 2, locked: false, extractionEngine: 'test-extractor 1', changeNote: 'bản đầu' });
      const listed = await as((tx) => texts.list(tx, version.id, {}, { limit: 50, afterSeq: undefined }));
      expect(listed.items.map((unit) => [unit.seq, unit.locatorKey, unit.text])).toEqual([
        [1, 'p1/para1', 'Điều 1. Phạm vi'],
        [2, 'p1/para2', 'Giá trị hợp đồng là 100 tỷ đồng'],
      ]);
      expect(listed.items[0]?.citationId).toBe(citationIdOf(version.fileSha256, 'p1/para1'));
      expect(listed.items[0]?.box).toEqual({ x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.15 });
    });

    it('refuses a contract or a package that belongs to another project, whoever writes', async () => {
      const facts = file();
      const wrong = await refusal(as((tx) => documents.create(tx, describeDocument(projectId, { contract_id: otherContractId }), facts, noText, null, memberId(AUTHOR), ALL, NOW)));
      expect(wrong).toMatchObject({ code: 'DOC_LINK_MISMATCH', status: 422 });
      expect(await databaseRefusal(owner("update machvon.project_document set contract_id = $1 where id = $2", [otherContractId, (await createDocument(projectId)).document.id]))).toMatch(/DOC_LINK_MISMATCH/);
    });

    it('refuses a document of a project outside the scope as not found, and a duplicate reference in a class as a conflict', async () => {
      const facts = file();
      expect(await refusal(as((tx) => documents.create(tx, describeDocument(projectId), facts, noText, null, memberId(AUTHOR), NONE, NOW)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404, detail: 'project_id' });
      const first = await createDocument(projectId, { reference: 'QD-77', doc_class: 'INVESTMENT_DECISION' });
      expect(await as((tx) => documents.find(tx, first.document.id, NONE, NOW))).toBeUndefined();
      expect(await refusal(createDocument(projectId, { reference: 'qd-77', doc_class: 'INVESTMENT_DECISION' }))).toMatchObject({ code: 'DOC_DUPLICATE_REFERENCE', status: 409 });
      // Another class, another project, or the first one archived: the reference is free.
      await createDocument(projectId, { reference: 'QD-77', doc_class: 'DESIGN' });
      await createDocument(otherProjectId, { reference: 'QD-77', doc_class: 'INVESTMENT_DECISION' });
      await as((tx) => documents.setArchived(tx, first.document.id, first.document.version, { reason: 'Nộp nhầm dự án khác' }, memberId(AUTHOR), ALL, NOW));
      await createDocument(projectId, { reference: 'QD-77', doc_class: 'INVESTMENT_DECISION' });
    });

    it('lists the documents of the scope newest first, filters them and pages by a keyset', async () => {
      const project = (await seedBidPackage(harness, { unit: ROOT })).projectId;
      const made = [];
      for (const title of ['Dự toán hạng mục móng', 'Dự toán hạng mục thân', 'Báo cáo tiến độ tháng 10']) made.push(await createDocument(project, { title, doc_class: title.startsWith('Dự toán') ? 'COST_ESTIMATE' : 'REPORT', reference: null, effective_to: title.includes('móng') ? '2025-12-31' : null }));
      const all = await as((tx) => documents.list(tx, { projectId: project }, ALL, NOW, { limit: 50, after: undefined }));
      expect(all.items.map((item) => item.title)).toEqual(['Báo cáo tiến độ tháng 10', 'Dự toán hạng mục thân', 'Dự toán hạng mục móng']);
      const first = await as((tx) => documents.list(tx, { projectId: project }, ALL, NOW, { limit: 2, after: undefined }));
      expect([first.items.length, first.more]).toEqual([2, true]);
      const second = await as((tx) => documents.list(tx, { projectId: project }, ALL, NOW, { limit: 2, after: first.last }));
      expect(second.items.map((item) => item.id)).toEqual([made[0]?.document.id]);
      expect(second.more).toBe(false);
      const estimates = await as((tx) => documents.list(tx, { projectId: project, docClass: 'COST_ESTIMATE' }, ALL, NOW, { limit: 50, after: undefined }));
      expect(estimates.items).toHaveLength(2);
      const expired = await as((tx) => documents.list(tx, { projectId: project, effective: 'EXPIRED' }, ALL, NOW, { limit: 50, after: undefined }));
      expect(expired.items.map((item) => item.title)).toEqual(['Dự toán hạng mục móng']);
      const undated = await as((tx) => documents.list(tx, { projectId: project, effective: 'UNDATED' }, ALL, NOW, { limit: 50, after: undefined }));
      expect(undated.items).toHaveLength(2);
      const found = await as((tx) => documents.list(tx, { projectId: project, q: 'tiến độ' }, ALL, NOW, { limit: 50, after: undefined }));
      expect(found.items).toHaveLength(1);
      expect((await as((tx) => documents.list(tx, { projectId: project }, NONE, NOW, { limit: 50, after: undefined }))).items).toEqual([]);
      expect((await as((tx) => documents.list(tx, { projectId: project, q: '%' }, ALL, NOW, { limit: 50, after: undefined }))).items).toEqual([]);
    });

    it('does not show a document to another tenant', async () => {
      const { document, version } = await createDocument(projectId);
      expect(await as((tx) => documents.find(tx, document.id, ALL, NOW), AUTHOR, TENANT_B)).toBeUndefined();
      expect(await as((tx) => documents.findVersion(tx, version.id, ALL, NOW), AUTHOR, TENANT_B)).toBeUndefined();
      expect((await as((tx) => texts.list(tx, version.id, {}, { limit: 10, afterSeq: undefined }), AUTHOR, TENANT_B)).items).toEqual([]);
    });
  });

  describe('versions', () => {
    it('numbers a new version, moves the current pointer, refuses the same file twice and an archived document', async () => {
      const { document, version } = await createDocument(projectId);
      const second = file();
      const added = await as((tx) => documents.addVersion(tx, document.id, second, paragraphs(second.sha256, 'Điều 1. Phạm vi', 'Giá trị hợp đồng là 120 tỷ đồng'), 'sửa giá', memberId(AUTHOR), ALL, NOW));
      expect(added.version).toMatchObject({ versionNo: 2, status: 'DRAFT' });
      expect(added.document).toMatchObject({ versionCount: 2, version: 2 });
      expect(added.document.currentVersion?.id).toBe(added.version.id);
      expect((await as((tx) => documents.versionsOf(tx, document.id))).map((row) => row.versionNo)).toEqual([2, 1]);
      expect(await refusal(as((tx) => documents.addVersion(tx, document.id, file({ sha256: version.fileSha256 }), noText, null, memberId(AUTHOR), ALL, NOW)))).toMatchObject({ code: 'DOC_VERSION_DUPLICATE', status: 409 });
      expect(await refusal(as((tx) => documents.addVersion(tx, document.id, file(), noText, null, memberId(AUTHOR), NONE, NOW)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      await as((tx) => documents.setArchived(tx, document.id, added.document.version, { reason: 'Hồ sơ không còn dùng nữa' }, memberId(AUTHOR), ALL, NOW));
      expect(await refusal(as((tx) => documents.addVersion(tx, document.id, file(), noText, null, memberId(AUTHOR), ALL, NOW)))).toMatchObject({ code: 'DOC_ARCHIVED', status: 409 });
    });

    it('records a file with no text as NO_TEXT and reads it again once, when an engine is bound', async () => {
      const facts = file();
      const { document, version } = await as((tx) => documents.create(tx, describeDocument(projectId), facts, noText, null, memberId(AUTHOR), ALL, NOW));
      expect(version).toMatchObject({ extractionStatus: 'NO_TEXT', unitCount: 0 });
      const again = await as((tx) => documents.reextract(tx, version.id, paragraphs(facts.sha256, 'Văn bản đọc được từ bản quét'), ALL, NOW));
      expect(again.before.extractionStatus).toBe('NO_TEXT');
      expect(again.after).toMatchObject({ extractionStatus: 'EXTRACTED', unitCount: 1 });
      expect(again.document.id).toBe(document.id);
      expect(await refusal(as((tx) => documents.reextract(tx, version.id, noText, ALL, NOW)))).toMatchObject({ code: 'DOC_EXTRACTION_DONE', status: 409 });
    });

    it('keeps what was read: the units are append-only and a version read once is not read again, for any role', async () => {
      const { version } = await createDocument(projectId);
      expect(await databaseRefusal(owner("update machvon.document_text_unit set text = 'đổi' where version_id = $1", [version.id]))).toMatch(/append-only/);
      expect(await databaseRefusal(owner('delete from machvon.document_text_unit where version_id = $1', [version.id]))).toMatch(/append-only/);
      const seq = await databaseRefusal(owner(`insert into machvon.document_text_unit (tenant_id, version_id, seq, citation_id, kind, locator_key, label, text, text_sha256) values ($1, $2, 9, $3, 'PARAGRAPH', 'para9', 'para9', 'x', $4)`, [TENANT_A, version.id, citationIdOf('f'.repeat(64), 'para9'), 'a'.repeat(64)]));
      expect(seq).toMatch(/read already/);
      expect(await databaseRefusal(owner("update machvon.project_document_version set file_sha256 = $2 where id = $1", [version.id, 'b'.repeat(64)]))).toMatch(/keeps the file/);
    });

    it('resolves a citation with the units around it and finds text inside one version only', async () => {
      const { version } = await createDocument(projectId, {}, ['Một', 'Hai', 'Ba']);
      const middle = citationIdOf(version.fileSha256, 'p1/para2');
      const resolved = await as((tx) => texts.resolve(tx, version.id, middle));
      expect(resolved?.unit.text).toBe('Hai');
      expect([resolved?.before?.text, resolved?.after?.text]).toEqual(['Một', 'Ba']);
      expect(await as((tx) => texts.resolve(tx, version.id, citationIdOf(version.fileSha256, 'p9/para9')))).toBeUndefined();
      expect(await as((tx) => texts.hasCitation(tx, version.id, middle))).toBe(true);
      expect((await as((tx) => texts.list(tx, version.id, { q: 'ai' }, { limit: 10, afterSeq: undefined }))).items.map((unit) => unit.text)).toEqual(['Hai']);
      expect(await as((tx) => texts.outline(tx, version.id))).toEqual({ pages: [1], sheets: [] });
      const paged = await as((tx) => texts.list(tx, version.id, {}, { limit: 2, afterSeq: 1 }));
      expect(paged.items.map((unit) => unit.seq)).toEqual([2, 3]);
    });

    it('compares the units of two versions', async () => {
      const first = await createDocument(projectId, {}, ['Điều 1', 'Giá trị hợp đồng là 100 tỷ đồng chưa gồm thuế', 'Điều 3']);
      const facts = file();
      const second = await as((tx) => documents.addVersion(tx, first.document.id, facts, paragraphs(facts.sha256, 'Điều 1', 'Giá trị hợp đồng là 120 tỷ đồng chưa gồm thuế', 'Điều 3', 'Điều 4 mới'), null, memberId(AUTHOR), ALL, NOW));
      const result = compareUnits(await as((tx) => texts.forCompare(tx, first.version.id)), await as((tx) => texts.forCompare(tx, second.version.id)));
      expect(result.summary).toEqual({ equal: 2, added: 1, removed: 0, changed: 1 });
    });

    it('corrects the description at the version read, and archives and restores with a reason', async () => {
      const { document } = await createDocument(projectId);
      const change = projectDocumentChangeOf({ title: 'Thiết kế bản vẽ thi công đã chỉnh', effective_from: '2026-03-01' }, document);
      const done = await as((tx) => documents.update(tx, document.id, document.version, change, memberId(ADMIN), ALL, NOW), ADMIN);
      expect(done.before.title).toBe(document.title);
      expect(done.after).toMatchObject({ title: 'Thiết kế bản vẽ thi công đã chỉnh', effectiveFrom: '2026-03-01', version: 2, updatedBy: memberId(ADMIN) });
      expect(await refusal(as((tx) => documents.update(tx, document.id, document.version, change, memberId(ADMIN), ALL, NOW), ADMIN))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(as((tx) => documents.setArchived(tx, document.id, 2, null, memberId(ADMIN), ALL, NOW), ADMIN))).toMatchObject({ code: 'DOC_NOT_ARCHIVED' });
      const archived = await as((tx) => documents.setArchived(tx, document.id, 2, { reason: 'Thay bằng hồ sơ thiết kế mới' }, memberId(ADMIN), ALL, NOW), ADMIN);
      expect(archived.after).toMatchObject({ status: 'ARCHIVED', archiveReason: 'Thay bằng hồ sơ thiết kế mới', version: 3 });
      expect(await refusal(as((tx) => documents.update(tx, document.id, 3, change, memberId(ADMIN), ALL, NOW), ADMIN))).toMatchObject({ code: 'DOC_ARCHIVED' });
      expect(await databaseRefusal(owner("update machvon.project_document set title = 'khác hẳn' where id = $1", [document.id]))).toMatch(/restored before/);
      const restored = await as((tx) => documents.setArchived(tx, document.id, 3, null, memberId(ADMIN), ALL, NOW), ADMIN);
      expect(restored.after).toMatchObject({ status: 'ACTIVE', archiveReason: null, version: 4 });
    });
  });

  describe('comments', () => {
    it('anchors a comment to a unit of its version, threads one level deep, resolves and reopens, and never changes what was said', async () => {
      const { document, version } = await createDocument(projectId);
      const anchor = citationIdOf(version.fileSha256, 'p1/para2');
      const first = await as((tx) => comments.add(tx, document.id, commentInputOf({ version_id: version.id, citation_id: anchor, body: 'Cần ghi rõ giá đã gồm thuế hay chưa' }), memberId(REV_A)), REV_A);
      expect(first).toMatchObject({ status: 'OPEN', citationId: anchor, citationLabel: 'p1 para2', authorId: memberId(REV_A), parentId: null, reviewId: null });
      const reply = await as((tx) => comments.add(tx, document.id, commentInputOf({ version_id: version.id, body: 'Đã bổ sung ở bản sau', parent_id: first.id }), memberId(AUTHOR)));
      expect(reply.parentId).toBe(first.id);
      expect(await refusal(as((tx) => comments.add(tx, document.id, commentInputOf({ version_id: version.id, body: 'Trả lời trả lời', parent_id: reply.id }), memberId(AUTHOR))))).toMatchObject({ code: 'DOC_COMMENT_PARENT_INVALID', status: 422 });
      expect(await refusal(as((tx) => comments.add(tx, document.id, commentInputOf({ version_id: version.id, body: 'Neo vào chỗ không có', citation_id: citationIdOf(version.fileSha256, 'p9/para9') }), memberId(AUTHOR))))).toMatchObject({ code: 'DOC_COMMENT_ANCHOR_UNKNOWN', status: 422 });
      expect((await as((tx) => texts.list(tx, version.id, {}, { limit: 10, afterSeq: undefined }))).items.map((unit) => unit.openComments)).toEqual([0, 1]);
      const resolved = await as((tx) => comments.setState(tx, first.id, 'RESOLVED', memberId(AUTHOR), 'Đã sửa'));
      expect(resolved.after).toMatchObject({ status: 'RESOLVED', resolvedBy: memberId(AUTHOR), resolutionNote: 'Đã sửa' });
      expect(await refusal(as((tx) => comments.setState(tx, first.id, 'RESOLVED', memberId(AUTHOR), null)))).toMatchObject({ code: 'DOC_COMMENT_STATE_INVALID', status: 409 });
      const reopened = await as((tx) => comments.setState(tx, first.id, 'OPEN', memberId(REV_A), null), REV_A);
      expect(reopened.after).toMatchObject({ status: 'OPEN', resolvedBy: null, resolvedAt: null, resolutionNote: null });
      expect((await as((tx) => comments.list(tx, version.id, { status: 'OPEN' }))).map((row) => row.id)).toEqual([first.id, reply.id]);
      expect((await as((tx) => comments.list(tx, version.id, { citationId: anchor }))).map((row) => row.id)).toEqual([first.id]);
      expect((await as((tx) => comments.openCounts(tx, document.id))).get(version.id)).toBe(2);
      expect(await databaseRefusal(owner("update machvon.document_comment set body = 'sửa lại lời đã nói' where id = $1", [first.id]))).toMatch(/does not change/);
      expect(await databaseRefusal(owner('delete from machvon.document_comment where id = $1', [first.id]))).toMatch(/never deleted/);
    });

    it('is refused on a version of another document and a reply to a comment of another version', async () => {
      const one = await createDocument(projectId);
      const two = await createDocument(projectId);
      expect(await databaseRefusal(as((tx) => comments.add(tx, two.document.id, commentInputOf({ version_id: one.version.id, body: 'Nhầm hồ sơ' }), memberId(AUTHOR))))).toMatch(/not a version of this document/);
      const base = await as((tx) => comments.add(tx, one.document.id, commentInputOf({ version_id: one.version.id, body: 'Ý kiến ở bản một' }), memberId(AUTHOR)));
      const facts = file();
      const later = await as((tx) => documents.addVersion(tx, one.document.id, facts, noText, null, memberId(AUTHOR), ALL, NOW));
      expect(await refusal(as((tx) => comments.add(tx, one.document.id, commentInputOf({ version_id: later.version.id, body: 'Trả lời sang bản khác', parent_id: base.id }), memberId(AUTHOR))))).toMatchObject({ code: 'DOC_COMMENT_PARENT_INVALID' });
    });
  });

  describe('the review of a version: stages, parallel reviewers, supplement and resubmission, approval and the lock', () => {
    it('runs a round to a supplement request, takes the newer version as the next round, and ends approved with the version locked', async () => {
      const { document, version } = await createDocument(projectId);
      const started = await submit(document.id, version.id);
      expect(started.plan).toEqual({ round: 1, kind: 'SUBMITTED', previousReviewId: null });
      expect(started.review).toMatchObject({ round: 1, status: 'IN_REVIEW', versionNo: 1, workflowInstanceId: started.instance.id });
      expect((await as((tx) => documents.findVersion(tx, version.id, ALL, NOW)))?.version.status).toBe('IN_REVIEW');
      // One open review per document, and a second send is refused before anything is written.
      expect(await refusal(submit(document.id, version.id))).toMatchObject({ code: 'DOC_VERSION_STATE_INVALID' });
      expect(await databaseRefusal(owner("insert into machvon.document_review (tenant_id, document_id, version_id, round_no, previous_review_id, submitted_by) values ($1, $2, $3, 2, $4, $5)", [TENANT_A, document.id, version.id, started.review.id, memberId(AUTHOR)]))).toMatch(/document_review_open_uq/);

      // The board: stage one has three parallel reviewers, none decided yet; stage two waits.
      let board = await as((tx) => reviews.board(tx, started.review));
      expect(board.stages.map((stage) => [stage.id, stage.state, stage.reviewers.length])).toEqual([['technical', 'CURRENT', 3], ['legal', 'WAITING', 0]]);
      expect(board.workflowRevision).toBe(1);

      // Two of the three approve: the stage closes, the third reviewer is not needed, the review moves to the legal stage.
      await decide(started.instance.id, REV_A, 'approve');
      board = await as((tx) => reviews.board(tx, started.review));
      expect(board.stages[0]?.approvals).toBe(1);
      await decide(started.instance.id, REV_B, 'approve');
      board = await as((tx) => reviews.board(tx, started.review));
      expect(board.stages.map((stage) => stage.state)).toEqual(['DONE', 'CURRENT']);
      expect(board.stages[0]?.reviewers.map((reviewer) => reviewer.state).sort()).toEqual(['APPROVED', 'APPROVED', 'NOT_NEEDED']);

      // Legal asks for a supplement: the round ends, the version is marked, nothing is locked.
      const returned = await decide(started.instance.id, REV_D, 'return', 'Thiếu căn cứ pháp lý của đơn giá');
      expect(returned).toMatchObject({ kind: 'DECIDED', outcome: 'RETURNED' });
      const round1 = await as((tx) => reviews.find(tx, started.review.id));
      expect(round1).toMatchObject({ status: 'SUPPLEMENT_REQUESTED', conclusionNote: 'Thiếu căn cứ pháp lý của đơn giá' });
      const afterOne = await as((tx) => documents.findVersion(tx, version.id, ALL, NOW));
      expect(afterOne?.version).toMatchObject({ status: 'SUPPLEMENT_REQUESTED', locked: false });
      expect(afterOne?.document).toMatchObject({ approvedVersion: null, latestReview: { round: 1, status: 'SUPPLEMENT_REQUESTED' } });
      board = await as((tx) => reviews.board(tx, round1 as NonNullable<typeof round1>));
      expect(board.stages.map((stage) => stage.state)).toEqual(['DONE', 'SUPPLEMENT_REQUESTED']);
      expect(board.stages[1]?.reviewers[0]).toMatchObject({ state: 'SUPPLEMENT_REQUESTED', reason: 'Thiếu căn cứ pháp lý của đơn giá' });

      // The same file cannot be sent again; a newer version is the next round.
      expect(await refusal(submit(document.id, version.id))).toMatchObject({ code: 'DOC_VERSION_STATE_INVALID' });
      const facts = file();
      const supplement = await as((tx) => documents.addVersion(tx, document.id, facts, paragraphs(facts.sha256, 'Điều 1. Phạm vi', 'Giá trị hợp đồng là 100 tỷ đồng, căn cứ Quyết định số 12/QĐ-UBND'), 'bổ sung căn cứ', memberId(AUTHOR), ALL, NOW));
      const second = await submit(document.id, supplement.version.id);
      expect(second.plan).toEqual({ round: 2, kind: 'RESUBMITTED', previousReviewId: started.review.id });
      expect(second.review.previousReviewId).toBe(started.review.id);

      await decide(second.instance.id, REV_A, 'approve');
      await decide(second.instance.id, REV_C, 'approve');
      const approved = await decide(second.instance.id, REV_D, 'approve');
      expect(approved).toMatchObject({ kind: 'DECIDED', outcome: 'APPROVED' });
      const locked = await as((tx) => documents.findVersion(tx, supplement.version.id, ALL, NOW));
      expect(locked?.version).toMatchObject({ status: 'APPROVED', locked: true, lockedBy: memberId(REV_D) });
      expect(locked?.document.approvedVersion).toEqual({ id: supplement.version.id, versionNo: 2 });
      expect((await as((tx) => reviews.events(tx, second.review.id))).map((event) => event.kind)).toEqual(['RESUBMITTED', 'APPROVED', 'VERSION_LOCKED']);
      expect((await as((tx) => reviews.events(tx, started.review.id))).map((event) => event.kind)).toEqual(['SUBMITTED', 'SUPPLEMENT_REQUESTED']);
      expect((await as((tx) => reviews.roundsOf(tx, document.id))).map((row) => [row.round, row.status])).toEqual([[2, 'APPROVED'], [1, 'SUPPLEMENT_REQUESTED']]);

      // The lock holds against every writer: the version, its units, its review and its approved pointer.
      expect(await databaseRefusal(owner("update machvon.project_document_version set change_note = 'đổi' where id = $1", [supplement.version.id]))).toMatch(/DOC_VERSION_LOCKED/);
      expect(await databaseRefusal(owner("update machvon.project_document_version set status = 'DRAFT', locked_at = null, locked_by = null where id = $1", [supplement.version.id]))).toMatch(/DOC_VERSION_LOCKED/);
      expect(await databaseRefusal(owner("update machvon.document_review set status = 'WITHDRAWN' where id = $1", [second.review.id]))).toMatch(/keeps its conclusion/);
      expect(await databaseRefusal(owner('update machvon.project_document set approved_version_id = null where id = $1', [document.id]))).toMatch(/never withdrawn/);
      expect(await databaseRefusal(owner("update machvon.document_review_event set kind = 'REJECTED' where review_id = $1", [second.review.id]))).toMatch(/append-only/);
      // Comments are still welcome on a locked version: they do not change the file.
      const note = await as((tx) => comments.add(tx, document.id, commentInputOf({ version_id: supplement.version.id, body: 'Ghi nhận sau khi duyệt' }), memberId(REV_A)), REV_A);
      expect(note.status).toBe('OPEN');
      // A later version is a draft of its own and can be sent again.
      const later = file();
      const third = await as((tx) => documents.addVersion(tx, document.id, later, noText, null, memberId(AUTHOR), ALL, NOW));
      expect(third.version).toMatchObject({ versionNo: 3, status: 'DRAFT', locked: false });
    }, 120_000);

    it('ends rejected, and the next version starts a fresh round that must be newer than the one reviewed', async () => {
      const { document, version } = await createDocument(projectId);
      const started = await submit(document.id, version.id);
      const rejected = await decide(started.instance.id, REV_A, 'reject', 'Hồ sơ không đúng mẫu quy định');
      expect(rejected).toMatchObject({ kind: 'DECIDED', outcome: 'REJECTED' });
      expect((await as((tx) => documents.findVersion(tx, version.id, ALL, NOW)))?.version.status).toBe('REJECTED');
      const board = await as((tx) => reviews.board(tx, started.review));
      expect(board.stages.map((stage) => stage.state)).toEqual(['REJECTED', 'SKIPPED']);
      const facts = file();
      const next = await as((tx) => documents.addVersion(tx, document.id, facts, noText, null, memberId(AUTHOR), ALL, NOW));
      const again = await submit(document.id, next.version.id);
      expect(again.plan).toMatchObject({ round: 2, kind: 'SUBMITTED' });
    }, 120_000);

    it('withdraws an open round by its sender only, puts the version back to draft and lets it go again', async () => {
      const { document, version } = await createDocument(projectId);
      const started = await submit(document.id, version.id);
      expect(await refusal(as((tx) => reviews.withdraw(tx, started.review.id, started.review.version, memberId(REV_A), 'Gửi nhầm hồ sơ này'), REV_A))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      expect(await refusal(as((tx) => reviews.withdraw(tx, started.review.id, 9, memberId(AUTHOR), 'Gửi nhầm hồ sơ này')))).toMatchObject({ code: 'VERSION_CONFLICT' });
      const cancelled = await as(async (tx) => {
        const done = await reviews.withdraw(tx, started.review.id, started.review.version, memberId(AUTHOR), 'Gửi nhầm hồ sơ này');
        await approvals.cancel(tx, effects(AUTHOR), { resourceType: 'document_review', resourceId: started.review.id, reason: 'withdrawn', now: NOW });
        return done;
      });
      expect(cancelled.after).toMatchObject({ status: 'WITHDRAWN', conclusionNote: 'Gửi nhầm hồ sơ này' });
      expect((await as((tx) => documents.findVersion(tx, version.id, ALL, NOW)))?.version.status).toBe('DRAFT');
      expect(await refusal(as((tx) => reviews.withdraw(tx, started.review.id, cancelled.after.version, memberId(AUTHOR), 'Rút lại lần nữa')))).toMatchObject({ code: 'DOC_REVIEW_NOT_OPEN', status: 409 });
      const again = await submit(document.id, version.id);
      expect(again.plan).toMatchObject({ round: 2, kind: 'SUBMITTED' });
      expect((await as((tx) => reviews.events(tx, started.review.id))).map((event) => event.kind)).toEqual(['SUBMITTED', 'WITHDRAWN']);
    }, 120_000);

    it('refuses a conclusion for a review that is not open and one that has no instance, and lists the reviews of the scope', async () => {
      const { document, version } = await createDocument(projectId);
      const started = await submit(document.id, version.id);
      await decide(started.instance.id, REV_A, 'reject', 'Hồ sơ không đúng mẫu quy định');
      const again = await as((tx) => reviews.conclude(tx, started.instance.id, 99, 'APPROVED'));
      expect(again).toEqual({ kind: 'REFUSED', reason: 'NOT_OPEN' });
      expect(await as((tx) => reviews.conclude(tx, randomUUID(), 1, 'APPROVED'))).toEqual({ kind: 'REFUSED', reason: 'NOT_FOUND' });
      const listed = await as((tx) => reviews.list(tx, { documentId: document.id }, ALL, { limit: 10, after: undefined }));
      expect(listed.items.map((row) => [row.round, row.status, row.documentTitle])).toEqual([[1, 'REJECTED', document.title]]);
      expect((await as((tx) => reviews.list(tx, { documentId: document.id }, NONE, { limit: 10, after: undefined }))).items).toEqual([]);
      expect((await as((tx) => reviews.list(tx, { status: 'IN_REVIEW', projectId }, ALL, { limit: 100, after: undefined }))).items.every((row) => row.status === 'IN_REVIEW')).toBe(true);
      expect((await as((tx) => reviews.list(tx, { documentId: document.id }, ALL, { limit: 10, after: undefined }), AUTHOR, TENANT_B)).items).toEqual([]);
    }, 120_000);

    it('does not archive a document while a review is open', async () => {
      const { document, version } = await createDocument(projectId);
      await submit(document.id, version.id);
      const current = await as((tx) => documents.find(tx, document.id, ALL, NOW));
      expect(await refusal(as((tx) => documents.setArchived(tx, document.id, current?.version ?? 1, { reason: 'Thử lưu trữ khi đang duyệt' }, memberId(AUTHOR), ALL, NOW)))).toMatchObject({ code: 'DOC_REVIEW_IN_PROGRESS', status: 409 });
    }, 120_000);
  });
});
