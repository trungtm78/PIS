import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_FILTER } from '@nestjs/core';
import { BidOcrStore, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { OCR_CONFIDENCE_THRESHOLD_TEXT, loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { bidModule } from '../../src/modules/bid';
import { ConflictController } from '../../src/modules/bid/conflict.controller';
import { OcrController, ocrPageDto, within } from '../../src/modules/bid/ocr.controller';
import { FileService } from '../../src/modules/files/file.service';
import { FsObjectStorage } from '../../src/modules/files/fs-object-storage';
import { MockScanPort, eicarBytes } from '../../src/modules/files/mock-scan';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedOcrPage } from '../../../../packages/db/test/support/bid-ocr-fixtures';
import { hoursFromNow, seedBidPackage, seedContractor, seedProposal } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const E1 = 1; // bid.evaluate, bid.ocr.read, bid.ocr.review over the tenant
const E2 = 2; // the same: recused from the contractor in one test
const E3 = 3; // the same: never declares
const CLERK = 4; // bid.proposal.receive, bid.ocr.read, bid.ocr.review: receives proposals, evaluates none
const READER = 5; // bid.ocr.read only
const NOBODY = 6;
const SCOPED = 7; // bid.evaluate over the tenant, the OCR rights over another branch only
const APPROVER = 8; // bid.conflict.decide
const WORKER = 9; // the pipeline
const B_EVALUATOR = 1; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const REASON = 'The relation was examined by the authority and recorded.';
const RELATION = 'The director of NT-1 is a cousin of mine.';
const ENGINE_TEXT = 'Bang tong hop gia: 1.000.000 + 2.000.000 = 3.000.000';
const SECRET_NOTE = 'Checked the figures against the scanned page.';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

const shaOf = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

describe('the OCR of the pages of a proposal and its review (ST-BID-008)', () => {
  const harness = new AuthzHarness();
  const store = new BidOcrStore();
  let app: RunningApp;
  let root: string;
  let files: FileService;
  let tenants: TenantDatabase;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; tenantId?: string; body?: unknown; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const audits = (resourceId: string, action: string) =>
    rows<{ safe_diff: Record<string, unknown>; outcome: string; actor_id: string; classification: string; reason: string | null }>(
      'select safe_diff, outcome, actor_id, classification, reason from machvon.audit_event where resource_id = $1 and action = $2',
      [resourceId, action],
    );
  const events = (aggregateId: string, type: string) =>
    rows<{ payload: Record<string, unknown>; aggregate_version: string }>(
      'select payload, aggregate_version::text as aggregate_version from machvon.outbox_event where aggregate_id = $1 and type = $2',
      [aggregateId, type],
    );

  const worker = { tenantId: TENANT_A, membershipId: memberId(WORKER), scopeVersion: 1 };
  /** A text of a page put in the store as the pipeline does, with the digest the row will keep. */
  async function storeText(text: string, tenantId = TENANT_A): Promise<{ key: string; sha: string }> {
    const bytes = new TextEncoder().encode(text);
    const key = await files.storeGenerated({ ...worker, tenantId }, 'ocr-text', randomUUID(), bytes, 'text/plain');
    return { key, sha: shaOf(bytes) };
  }

  interface Fixture {
    packageId: string;
    packageCode: string;
    projectId: string;
    contractor: string;
    proposalId: string;
    versionId: string;
  }

  /** A proposal whose bids were opened an hour ago, of a file of forty pages, and E1 who declared that no conflict stands between them and the bidder. */
  async function fixture(options: { released?: boolean; declare?: boolean } = {}): Promise<Fixture> {
    const seeded = await seedBidPackage(harness);
    const contractor = await seedContractor(harness, { name: 'NT-1 Builders' });
    const proposal = await seedProposal(harness, seeded, contractor, { releasedAt: hoursFromNow(options.released === false ? 24 : -1) });
    await rows('update machvon.document_version set page_count = 40 where id = $1::uuid', [proposal.versionId]);
    if (options.declare !== false) expect((await declare(E1, seeded.packageId, { has_conflict: false })).status).toBe(200);
    return { packageId: seeded.packageId, packageCode: seeded.packageCode, projectId: seeded.projectId, contractor, proposalId: proposal.id, versionId: proposal.versionId };
  }

  /** The pipeline of the analysis: records the pages the engine read, with their texts in the store. */
  async function record(fx: Fixture, readings: Array<{ pageIndex: number; confidence: string; text?: string; tables?: unknown[] }>): Promise<Array<{ id: string; pageIndex: number; status: string }>> {
    const pages: Array<{ pageIndex: number; confidence: string; textSha256: string; textObjectKey: string; tables: unknown[] }> = [];
    for (const reading of readings) {
      const stored = await storeText(reading.text ?? `${ENGINE_TEXT} (${reading.pageIndex})`);
      pages.push({ pageIndex: reading.pageIndex, confidence: reading.confidence, textSha256: stored.sha, textObjectKey: stored.key, tables: reading.tables ?? [] });
    }
    return tenants.withTenant(worker, (tx) => store.recordPages(tx, fx.versionId, pages, 'ocr-engine-1.0'));
  }

  const declare = (member: number, packageId: string, body: Record<string, unknown>): Promise<Reply> => call('POST', `/procurement-packages/${packageId}/conflict-declarations`, { member, body });
  const pagesOf = (proposalId: string, member: number, query = ''): Promise<Reply> => call('GET', `/proposals/${proposalId}/ocr-pages${query}`, { member });
  const review = (member: number, pageId: string, body: Record<string, unknown>, extra: { key?: string; tenantId?: string } = {}): Promise<Reply> =>
    call('POST', `/document-page-ocr/${pageId}/review`, { member, body, ...extra });
  const items = (reply: Reply): Array<Record<string, unknown>> => reply.json.items as Array<Record<string, unknown>>;

  /** A text through the upload door as a reviewer would. */
  async function uploadText(member: number, bytes: Uint8Array, type = 'text/plain'): Promise<Reply> {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type }), 'page.txt');
    const response = await fetch(`${app.baseUrl}/document-page-ocr/files`, { method: 'POST', headers: { [TENANT_HEADER]: tokenOf(member), 'idempotency-key': `key-${randomUUID()}` }, body: form });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
  const correction = async (text: string, member = E1): Promise<{ key: string; sha: string }> => {
    const bytes = new TextEncoder().encode(text);
    const done = await uploadText(member, bytes);
    expect(done.status).toBe(200);
    return { key: String(done.json.file_object_key), sha: String(done.json.file_sha256) };
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'machvon-bid-ocr-'));
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
      ]);
    }
    for (const n of [E1, E2, E3, CLERK, READER, NOBODY, SCOPED, APPROVER, WORKER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_EVALUATOR, ROOT);
    const evaluator = ['bid.evaluate', 'bid.ocr.read', 'bid.ocr.review'];
    await harness.seedRole(TENANT_A, 1, 'BID_EVALUATOR', evaluator, 30);
    await harness.seedRole(TENANT_A, 2, 'BID_CLERK', ['bid.proposal.receive', 'bid.ocr.read', 'bid.ocr.review'], 30);
    await harness.seedRole(TENANT_A, 3, 'OCR_READER', ['bid.ocr.read'], 10);
    await harness.seedRole(TENANT_A, 4, 'BID_EVALUATOR_BASE', ['bid.evaluate'], 30);
    await harness.seedRole(TENANT_A, 5, 'OCR_REVIEWER', ['bid.ocr.read', 'bid.ocr.review'], 30);
    await harness.seedRole(TENANT_A, 6, 'BID_AUTHORITY', ['bid.conflict.decide', 'bid.read'], 40);
    await harness.seedRole(TENANT_B, 1, 'BID_EVALUATOR', evaluator, 30);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: E1, role: 1, kind: 'TENANT' },
      { n: 2, member: E2, role: 1, kind: 'TENANT' },
      { n: 3, member: E3, role: 1, kind: 'TENANT' },
      { n: 4, member: CLERK, role: 2, kind: 'TENANT' },
      { n: 5, member: READER, role: 3, kind: 'TENANT' },
      { n: 6, member: SCOPED, role: 4, kind: 'TENANT' },
      { n: 7, member: SCOPED, role: 5, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
      { n: 8, member: APPROVER, role: 6, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_EVALUATOR, role: 1, kind: 'TENANT' }]);
    tenants = harness.tenants as TenantDatabase;
    files = new FileService({ storage: new FsObjectStorage(root), scanner: new MockScanPort(), urlSecret: randomBytes(32) });
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [OcrController, ConflictController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: FileService, useValue: files },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
    await rm(root, { recursive: true, force: true });
  }, 60_000);

  it('is registered in the module of BID', () => {
    expect(bidModule.controllers).toContain(OcrController);
  });

  describe('AC-ST-BID-008-1 / UAT-AC449: a page under the threshold stops the financial analysis until the expert corrects it', () => {
    it('sends page 23 at 0.71 to review, holds the gate, and opens it when the expert corrects the page', async () => {
      const fx = await fixture();
      const recorded = await record(fx, [
        { pageIndex: 0, confidence: '0.9700' },
        { pageIndex: 22, confidence: '0.71', text: 'Bang tong hop gia: 1.000.000 + 2.000.OOO = 3.000.000' },
      ]);
      const page23 = recorded.find((page) => page.pageIndex === 22);
      expect(page23).toMatchObject({ status: 'NEEDS_REVIEW' });

      // The first run: the gate is closed and names the page.
      const before = await pagesOf(fx.proposalId, E1);
      expect(before.status).toBe(200);
      expect(before.json).toMatchObject({ financial_ready: false, blocked_pages: 1, threshold: OCR_CONFIDENCE_THRESHOLD_TEXT });
      expect(items(before).map((page) => [page.page_index, page.review_status, page.ocr_confidence])).toEqual([
        [0, 'AUTO_ACCEPTED', '0.9700'],
        [22, 'NEEDS_REVIEW', '0.7100'],
      ]);

      // The expert corrects it with a text of their own, and the page is corrected once.
      const fixed = await correction('Bang tong hop gia: 1.000.000 + 2.000.000 = 3.000.000');
      const done = await review(E1, String(page23?.id), { decision: 'CORRECTED', corrected_text_object_key: fixed.key, note: SECRET_NOTE });
      expect(done).toMatchObject({ status: 200, json: { status: 'CORRECTED', resource_version: 1, resource_id: page23?.id } });

      // The second run: the gate is open and the page shows the corrected text beside the reading of the engine.
      const after = await pagesOf(fx.proposalId, E1);
      expect(after.json).toMatchObject({ financial_ready: true, blocked_pages: 0 });
      expect(items(after)[1]).toMatchObject({
        page_index: 22,
        review_status: 'CORRECTED',
        reviewed_by: memberId(E1),
        note: SECRET_NOTE,
        text: 'Bang tong hop gia: 1.000.000 + 2.000.OOO = 3.000.000',
        text_state: 'READABLE',
        corrected_text: 'Bang tong hop gia: 1.000.000 + 2.000.000 = 3.000.000',
      });
      expect(await rows('select 1 from machvon.document_page_ocr where id = $1::uuid and reviewed_at is not null', [page23?.id])).toHaveLength(1);
    });

    it('accepts a reading at the threshold and not one just under it, and sends a table whose total is wrong to review (BR-BID-06)', async () => {
      const fx = await fixture();
      const mismatch = [
        {
          rows: [
            { label: 'Earthworks', amount: '1000000' },
            { label: 'Concrete', amount: '2000000.50' },
          ],
          total: '3000000',
        },
      ];
      const exact = [
        {
          rows: [
            { label: 'Earthworks', amount: '1000000' },
            { label: 'Concrete', amount: '2000000' },
          ],
          total: '3000000',
        },
      ];
      await record(fx, [
        { pageIndex: 0, confidence: '0.85' },
        { pageIndex: 1, confidence: '0.849' },
        { pageIndex: 2, confidence: '0.99', tables: mismatch },
        { pageIndex: 3, confidence: '0.99', tables: exact },
      ]);
      const listed = await pagesOf(fx.proposalId, E1);
      expect(items(listed).map((page) => [page.page_index, page.review_status, page.table_mismatch])).toEqual([
        [0, 'AUTO_ACCEPTED', false],
        [1, 'NEEDS_REVIEW', false],
        [2, 'NEEDS_REVIEW', true],
        [3, 'AUTO_ACCEPTED', false],
      ]);
      expect(listed.json).toMatchObject({ financial_ready: false, blocked_pages: 2 });
    });

    it('confirms a page as it was read, keeps the gate shut while another page waits, and opens it with the last review', async () => {
      const fx = await fixture();
      const [first, second] = await record(fx, [
        { pageIndex: 3, confidence: '0.6' },
        { pageIndex: 4, confidence: '0.7' },
      ]);
      expect(await review(E1, String(first?.id), { decision: 'CONFIRMED' })).toMatchObject({ status: 200, json: { status: 'CONFIRMED', resource_version: 1 } });
      expect((await pagesOf(fx.proposalId, E1)).json).toMatchObject({ financial_ready: false, blocked_pages: 1 });
      expect((await review(E1, String(second?.id), { decision: 'CONFIRMED', note: SECRET_NOTE })).status).toBe(200);
      expect((await pagesOf(fx.proposalId, E1)).json).toMatchObject({ financial_ready: true, blocked_pages: 0 });
    });
  });

  describe('reviewOcrPage', () => {
    it('audits the review and tells the world which page was reviewed, without any of the text or the note', async () => {
      const fx = await fixture();
      const [page] = await record(fx, [{ pageIndex: 7, confidence: '0.42', text: 'SECRET-PAGE-TEXT' }]);
      const fixed = await correction('SECRET-CORRECTED-TEXT');
      const done = await review(E1, String(page?.id), { decision: 'CORRECTED', corrected_text_object_key: fixed.key, note: SECRET_NOTE });
      expect(done.status).toBe(200);
      const [audit] = await audits(String(page?.id), 'bid.ocr_reviewed');
      expect(audit).toMatchObject({
        outcome: 'SUCCESS',
        actor_id: memberId(E1),
        classification: 'CONFIDENTIAL',
        safe_diff: {
          proposal_id: fx.proposalId,
          package_code: fx.packageCode,
          contractor_id: fx.contractor,
          document_version_id: fx.versionId,
          page_index: 7,
          ocr_confidence: '0.4200',
          table_mismatch: false,
          previous_status: 'NEEDS_REVIEW',
          status: 'CORRECTED',
          has_note: true,
          financial_ready: true,
        },
      });
      const [event] = await events(String(page?.id), 'bid.ocr.reviewed.v1');
      expect(event?.payload).toMatchObject({
        tenant_id: TENANT_A,
        page_id: page?.id,
        proposal_id: fx.proposalId,
        package_id: fx.packageId,
        project_id: fx.projectId,
        contractor_id: fx.contractor,
        page_index: 7,
        decision: 'CORRECTED',
        financial_ready: true,
        actor_id: memberId(E1),
      });
      expect(event?.aggregate_version).toBe('1');
      const everything = JSON.stringify([audit, event]);
      for (const secret of ['SECRET-PAGE-TEXT', 'SECRET-CORRECTED-TEXT', SECRET_NOTE, fixed.key, 'tenants/']) expect(everything).not.toContain(secret);
      const [uploaded] = await rows<{ safe_diff: Record<string, unknown> }>(
        `select safe_diff from machvon.audit_event where action = 'bid.ocr_correction_uploaded' and safe_diff->>'file_sha256' = $1`,
        [fixed.sha],
      );
      expect(uploaded?.safe_diff).toEqual({ file_sha256: fixed.sha, size_bytes: Buffer.byteLength('SECRET-CORRECTED-TEXT') });
    });

    it('answers the same request with the same key once (idempotency)', async () => {
      const fx = await fixture();
      const [page] = await record(fx, [{ pageIndex: 1, confidence: '0.5' }]);
      const first = await review(E1, String(page?.id), { decision: 'CONFIRMED' }, { key: 'same-key-for-one-review' });
      const again = await review(E1, String(page?.id), { decision: 'CONFIRMED' }, { key: 'same-key-for-one-review' });
      expect(first.status).toBe(200);
      expect(again).toEqual(first);
      expect(await audits(String(page?.id), 'bid.ocr_reviewed')).toHaveLength(1);
      expect(await events(String(page?.id), 'bid.ocr.reviewed.v1')).toHaveLength(1);
      const other = await review(E1, String(page?.id), { decision: 'CORRECTED' }, { key: 'same-key-for-one-review' });
      expect(other).toMatchObject({ status: 409, json: { code: 'IDEMPOTENCY_CONFLICT' } });
    });

    it('reviews a page once: a second review, and the review of a page that was accepted, is 409 OCR_STATE_INVALID', async () => {
      const fx = await fixture();
      const [accepted, waiting] = await record(fx, [
        { pageIndex: 0, confidence: '0.95' },
        { pageIndex: 1, confidence: '0.5' },
      ]);
      expect((await review(E1, String(waiting?.id), { decision: 'CONFIRMED' })).status).toBe(200);
      expect(await review(E1, String(waiting?.id), { decision: 'CONFIRMED' })).toMatchObject({ status: 409, json: { code: 'OCR_STATE_INVALID' } });
      expect(await review(E1, String(waiting?.id), { decision: 'CORRECTED', corrected_text_object_key: (await correction('x')).key })).toMatchObject({
        status: 409,
        json: { code: 'OCR_STATE_INVALID' },
      });
      expect(await review(E1, String(accepted?.id), { decision: 'CONFIRMED' })).toMatchObject({ status: 409, json: { code: 'OCR_STATE_INVALID' } });
      expect(await audits(String(accepted?.id), 'bid.ocr_reviewed')).toEqual([]);
    });

    it('refuses a correction without its text, a confirmation with one, a decision that is none and a note that is too long (422)', async () => {
      const fx = await fixture();
      const [page] = await record(fx, [{ pageIndex: 1, confidence: '0.5' }]);
      const id = String(page?.id);
      const fixed = await correction('A corrected text');
      expect(await review(E1, id, { decision: 'CORRECTED' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await review(E1, id, { decision: 'CONFIRMED', corrected_text_object_key: fixed.key })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect((await review(E1, id, { decision: 'REJECTED' })).status).toBeGreaterThanOrEqual(400);
      expect((await review(E1, id, { decision: 'CONFIRMED', note: 'x'.repeat(1001) })).status).toBeGreaterThanOrEqual(400);
      expect(await rows<{ review_status: string }>('select review_status from machvon.document_page_ocr where id = $1::uuid', [id])).toEqual([{ review_status: 'NEEDS_REVIEW' }]);
    });

    it('refuses a text that is not a stored plain text of this tenant: another purpose (422), a file that is not text (422), a foreign or missing key (404), the same text twice (422)', async () => {
      const fx = await fixture();
      const [one, two] = await record(fx, [
        { pageIndex: 1, confidence: '0.5' },
        { pageIndex: 2, confidence: '0.5' },
      ]);
      const id = String(one?.id);
      const engineText = await storeText('not a correction');
      expect(await review(E1, id, { decision: 'CORRECTED', corrected_text_object_key: engineText.key })).toMatchObject({
        status: 422,
        json: { code: 'VALIDATION_FAILED', reason: 'FILE_KEY_INVALID' },
      });
      expect(await review(E1, id, { decision: 'CORRECTED', corrected_text_object_key: 'not/a/key/at/all' })).toMatchObject({ status: 422 });
      const csv = await files.upload({ ...worker, tenantId: TENANT_A }, { purpose: 'document', declaredType: 'text/csv', bytes: new TextEncoder().encode('a,b\n1,2\n') });
      expect(await review(E1, id, { decision: 'CORRECTED', corrected_text_object_key: csv.key })).toMatchObject({ status: 422, json: { reason: 'FILE_TYPE_INVALID' } });
      const foreign = await files.upload({ ...worker, tenantId: TENANT_B }, { purpose: 'document', declaredType: 'text/plain', bytes: new TextEncoder().encode('a foreign text') });
      expect(await review(E1, id, { decision: 'CORRECTED', corrected_text_object_key: foreign.key })).toMatchObject({ status: 404 });
      expect(await review(E1, id, { decision: 'CORRECTED', corrected_text_object_key: `tenants/${TENANT_A}/document/${randomUUID()}` })).toMatchObject({ status: 404 });
      const shared = await correction('One text for one page');
      expect((await review(E1, id, { decision: 'CORRECTED', corrected_text_object_key: shared.key })).status).toBe(200);
      expect(await review(E1, String(two?.id), { decision: 'CORRECTED', corrected_text_object_key: shared.key })).toMatchObject({ status: 422, json: { reason: 'FILE_ALREADY_ATTACHED' } });
    });

    it('is for the member with the right to review who evaluates the project: 403 without the right, 404 for a clerk, for a scope elsewhere, before the opening and for another tenant', async () => {
      const fx = await fixture();
      const [page] = await record(fx, [{ pageIndex: 1, confidence: '0.5' }]);
      const id = String(page?.id);
      expect((await review(READER, id, { decision: 'CONFIRMED' })).status).toBe(403);
      expect((await review(NOBODY, id, { decision: 'CONFIRMED' })).status).toBe(403);
      expect(await review(CLERK, id, { decision: 'CONFIRMED' })).toMatchObject({ status: 404 });
      expect(await review(SCOPED, id, { decision: 'CONFIRMED' })).toMatchObject({ status: 404 });
      expect(await review(B_EVALUATOR, id, { decision: 'CONFIRMED' }, { tenantId: TENANT_B })).toMatchObject({ status: 404 });
      expect(await review(E1, randomUUID(), { decision: 'CONFIRMED' })).toMatchObject({ status: 404 });
      expect(await review(E3, id, { decision: 'CONFIRMED' })).toMatchObject({ status: 403, json: { code: 'CONFLICT_UNDECLARED' } });
      const sealed = await fixture({ released: false });
      const [sealedPage] = await record(sealed, [{ pageIndex: 1, confidence: '0.5' }]);
      expect(await review(E1, String(sealedPage?.id), { decision: 'CONFIRMED' })).toMatchObject({ status: 404 });
      expect(await rows<{ review_status: string }>('select review_status from machvon.document_page_ocr where id = any($1::uuid[]) order by review_status', [[id, sealedPage?.id]])).toEqual([
        { review_status: 'NEEDS_REVIEW' },
        { review_status: 'NEEDS_REVIEW' },
      ]);
    });

    it('shuts out the member recused from the contractor, for the pages as for the proposal, and opens them again when the conflict is allowed', async () => {
      const fx = await fixture();
      const [page] = await record(fx, [{ pageIndex: 1, confidence: '0.5' }]);
      const id = String(page?.id);
      expect((await declare(E2, fx.packageId, { has_conflict: true, relation_text: RELATION, contractor_id: fx.contractor })).status).toBe(200);
      const [declaration] = await rows<{ id: string }>('select id from machvon.bid_conflict_declaration where package_id = $1::uuid and user_id = $2::uuid', [fx.packageId, memberId(E2)]);
      // Waiting for the decision, and after it: the pages of the contractor do not exist for the member.
      expect(await pagesOf(fx.proposalId, E2)).toMatchObject({ status: 404 });
      expect(await review(E2, id, { decision: 'CONFIRMED' })).toMatchObject({ status: 404 });
      const decided = await fetch(`${app.baseUrl}/bid-conflict-declarations/${declaration?.id}/decision`, {
        method: 'POST',
        headers: { [TENANT_HEADER]: tokenOf(APPROVER), 'content-type': 'application/json', 'idempotency-key': `key-${randomUUID()}`, 'if-match': '"1"' },
        body: JSON.stringify({ decision: 'RECUSED', decision_reason: REASON }),
      });
      expect(decided.status).toBe(200);
      expect(await pagesOf(fx.proposalId, E2)).toMatchObject({ status: 404 });
      expect(await review(E2, id, { decision: 'CONFIRMED' })).toMatchObject({ status: 404 });
      const allowed = await fetch(`${app.baseUrl}/bid-conflict-declarations/${declaration?.id}/decision`, {
        method: 'POST',
        headers: { [TENANT_HEADER]: tokenOf(APPROVER), 'content-type': 'application/json', 'idempotency-key': `key-${randomUUID()}`, 'if-match': '"2"' },
        body: JSON.stringify({ decision: 'ALLOWED', decision_reason: 'The relation was found to have no effect on the evaluation.' }),
      });
      expect(allowed.status).toBe(200);
      expect((await pagesOf(fx.proposalId, E2)).status).toBe(200);
      expect((await review(E2, id, { decision: 'CONFIRMED' })).status).toBe(200);
    });
  });

  describe('uploadOcrCorrectionFile', () => {
    it('stores a clean plain text and answers the key, the digest and the size', async () => {
      const bytes = new TextEncoder().encode('Một văn bản đã sửa');
      const done = await uploadText(E1, bytes);
      expect(done).toMatchObject({ status: 200, json: { file_sha256: shaOf(bytes), size_bytes: bytes.length } });
      expect(String(done.json.file_object_key)).toMatch(new RegExp(`^tenants/${TENANT_A}/document/`));
    });

    it('refuses what is not plain text (422), a text over the size of a page (413), an infected one (422) and a caller without the right (403)', async () => {
      const pdf = new TextEncoder().encode('%PDF-1.4\n');
      expect(await uploadText(E1, pdf, 'application/pdf')).toMatchObject({ status: 422, json: { code: 'FILE_TYPE_NOT_ALLOWED' } });
      expect(await uploadText(E1, new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]), 'application/x-msdownload')).toMatchObject({ status: 422, json: { code: 'FILE_TYPE_NOT_ALLOWED' } });
      expect(await uploadText(E1, new TextEncoder().encode('a,b\n1,2\n'), 'text/csv')).toMatchObject({ status: 422, json: { code: 'FILE_TYPE_NOT_ALLOWED' } });
      expect(await uploadText(E1, new TextEncoder().encode('x'.repeat(1024 * 1024 + 1)))).toMatchObject({ status: 413, json: { code: 'PAYLOAD_TOO_LARGE' } });
      expect(await uploadText(E1, Buffer.concat([Buffer.from('a text '), Buffer.from(eicarBytes())]))).toMatchObject({ status: 422, json: { code: 'FILE_NOT_CLEAN' } });
      for (const member of [READER, NOBODY]) expect((await uploadText(member, new TextEncoder().encode('text'))).status).toBe(403);
    });
  });

  describe('listProposalOcrPages (BID-06)', () => {
    it('shows the member with the full view the recognised text beside the confidence and the status, and leaves a row in the audit trail without the text', async () => {
      const fx = await fixture();
      await record(fx, [
        { pageIndex: 5, confidence: '0.93', text: 'SECRET-RECOGNISED-TEXT' },
        { pageIndex: 2, confidence: '0.6', text: 'Bang chi tiet' },
      ]);
      const listed = await pagesOf(fx.proposalId, E1);
      expect(listed.status).toBe(200);
      expect(items(listed).map((page) => page.page_index)).toEqual([2, 5]);
      expect(items(listed)[1]).toEqual({
        id: expect.any(String),
        document_version_id: fx.versionId,
        page_index: 5,
        ocr_confidence: '0.9300',
        review_status: 'AUTO_ACCEPTED',
        table_mismatch: false,
        reviewed_by: null,
        reviewed_at: null,
        note: null,
        engine_version: 'ocr-engine-1.0',
        text: 'SECRET-RECOGNISED-TEXT',
        text_state: 'READABLE',
        corrected_text: null,
      });
      expect(listed.json.documents).toEqual([{ document_version_id: fx.versionId, title: 'Technical proposal', part: 'TECHNICAL', page_count: 40 }]);
      expect(JSON.stringify(listed.json)).not.toContain('tenants/');
      expect(JSON.stringify(listed.json)).not.toContain('text_object_key');
      const [opened] = await audits(fx.proposalId, 'bid.ocr_opened');
      expect(opened).toMatchObject({
        actor_id: memberId(E1),
        outcome: 'SUCCESS',
        classification: 'CONFIDENTIAL',
        safe_diff: { package_code: fx.packageCode, contractor_id: fx.contractor, revision: 1, page_count: 2 },
      });
      expect(JSON.stringify(opened)).not.toContain('SECRET-RECOGNISED-TEXT');
    });

    it('says when the stored text is not the text that was read: changed after it was recorded, or gone', async () => {
      const fx = await fixture();
      const written = await storeText('The text as it was read');
      await seedOcrPage(harness, fx.versionId, { pageIndex: 0, textKey: written.key, textSha: shaOf('The text as it is now') });
      await seedOcrPage(harness, fx.versionId, { pageIndex: 1, textKey: `tenants/${TENANT_A}/ocr-text/${randomUUID()}`, textSha: shaOf('gone') });
      const good = await storeText('Good text');
      const withBadCorrection = await seedOcrPage(harness, fx.versionId, { pageIndex: 2, textKey: good.key, textSha: good.sha, status: 'NEEDS_REVIEW', confidence: '0.5' });
      await rows(
        `update machvon.document_page_ocr set review_status = 'CORRECTED', reviewed_by = $2::uuid, reviewed_at = now(), corrected_text_object_key = $3, corrected_text_sha256 = $4 where id = $1::uuid`,
        [withBadCorrection.id, memberId(E1), `tenants/${TENANT_A}/document/${randomUUID()}`, 'd'.repeat(64)],
      );
      const listed = await pagesOf(fx.proposalId, E1);
      expect(items(listed).map((page) => [page.page_index, page.text, page.text_state, page.corrected_text])).toEqual([
        [0, null, 'DIGEST_MISMATCH', null],
        [1, null, 'MISSING', null],
        [2, 'Good text', 'MISSING', null],
      ]);
    });

    it('filters by file and by status, pages with a cursor, and refuses a filter that is none (422)', async () => {
      const fx = await fixture();
      await record(fx, [
        { pageIndex: 0, confidence: '0.95' },
        { pageIndex: 1, confidence: '0.5' },
        { pageIndex: 2, confidence: '0.95' },
      ]);
      const waiting = await pagesOf(fx.proposalId, E1, '?review_status=NEEDS_REVIEW');
      expect(items(waiting).map((page) => page.page_index)).toEqual([1]);
      expect(waiting.json).toMatchObject({ financial_ready: false, blocked_pages: 1 });
      expect(items(await pagesOf(fx.proposalId, E1, `?document_version_id=${randomUUID()}`))).toEqual([]);
      expect(items(await pagesOf(fx.proposalId, E1, `?document_version_id=${fx.versionId}`))).toHaveLength(3);
      const first = await pagesOf(fx.proposalId, E1, '?limit=2');
      expect(items(first)).toHaveLength(2);
      expect(first.json.next_cursor).toEqual(expect.any(String));
      const second = await pagesOf(fx.proposalId, E1, `?limit=2&cursor=${encodeURIComponent(String(first.json.next_cursor))}`);
      expect(items(second).map((page) => page.page_index)).toEqual([2]);
      expect(second.json.next_cursor).toBeNull();
      for (const query of ['?review_status=nope', '?document_version_id=nope', '?limit=0', '?cursor=%25%25']) expect((await pagesOf(fx.proposalId, E1, query)).status).toBe(422);
    });

    it('shows a proposal whose pages are not read yet as a list, with the gate open', async () => {
      const fx = await fixture();
      const listed = await pagesOf(fx.proposalId, E1);
      expect(listed).toMatchObject({ status: 200, json: { items: [], next_cursor: null, financial_ready: true, blocked_pages: 0 } });
    });

    it('shows nothing to whoever has not the full view: 403 without the right, 404 for a clerk, a scope elsewhere, a recused member, another tenant, a proposal before the opening, a proposal that does not exist', async () => {
      const fx = await fixture();
      await record(fx, [{ pageIndex: 0, confidence: '0.5' }]);
      expect((await pagesOf(fx.proposalId, NOBODY)).status).toBe(403);
      expect(await pagesOf(fx.proposalId, CLERK)).toMatchObject({ status: 404 });
      expect(await pagesOf(fx.proposalId, SCOPED)).toMatchObject({ status: 404 });
      expect(await pagesOf(randomUUID(), E1)).toMatchObject({ status: 404 });
      expect(await call('GET', `/proposals/${fx.proposalId}/ocr-pages`, { member: B_EVALUATOR, tenantId: TENANT_B })).toMatchObject({ status: 404 });
      expect(await pagesOf(fx.proposalId, E3)).toMatchObject({ status: 403, json: { code: 'CONFLICT_UNDECLARED' } });
      const sealed = await fixture({ released: false });
      expect(await pagesOf(sealed.proposalId, E1)).toMatchObject({ status: 404 });
      expect(await audits(sealed.proposalId, 'bid.ocr_opened')).toEqual([]);
      // The member who may only read can read; reading is not reviewing, and the reader has no scope over the evaluation, so for them too the proposal does not exist.
      expect(await pagesOf(fx.proposalId, READER)).toMatchObject({ status: 404 });
    });
  });

  describe('the pieces of the controller', () => {
    it('joins two scopes with the parameters of the second numbered after the first', () => {
      const both = within(
        (first) => ({ sql: `p.id = any($${first}::uuid[])`, params: [['a']] }),
        (first) => ({ sql: `p.owner = $${first} or p.investor = $${first + 1}`, params: ['x', 'y'] }),
      );
      expect(both(3)).toEqual({ sql: '(p.id = any($3::uuid[]) and p.owner = $4 or p.investor = $5)', params: [['a'], 'x', 'y'] });
    });

    it('shows the state of a text beside a correction that cannot be read, and of a text that cannot be read whatever the correction says', () => {
      const line = {
        id: 'p',
        documentVersionId: 'v',
        pageIndex: 0,
        confidence: '0.5000',
        status: 'CORRECTED' as const,
        tableMismatch: false,
        reviewedBy: 'm',
        reviewedAt: 't',
        note: null,
        engineVersion: 'e',
        textObjectKey: 'k',
        textSha256: 's',
        correctedTextObjectKey: 'c',
        correctedTextSha256: 'd',
      };
      const readable = { text: 'a', state: 'READABLE' as const };
      const gone = { text: null, state: 'MISSING' as const };
      expect(ocrPageDto(line, readable, readable)).toMatchObject({ text_state: 'READABLE', corrected_text: 'a' });
      expect(ocrPageDto(line, readable, gone)).toMatchObject({ text_state: 'MISSING', corrected_text: null });
      expect(ocrPageDto(line, { text: null, state: 'DIGEST_MISMATCH' }, readable)).toMatchObject({ text_state: 'DIGEST_MISMATCH', text: null });
      expect(ocrPageDto(line, readable, undefined)).toMatchObject({ text_state: 'READABLE', corrected_text: null });
    });
  });
});
