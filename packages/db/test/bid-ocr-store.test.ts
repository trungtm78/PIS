import { createHash, randomUUID } from 'node:crypto';
import { BidConflictStore } from '../src/bid-conflict-store';
import { BidOcrStore } from '../src/bid-ocr-store';
import type { CorrectedText } from '../src/bid-ocr-store';
import type { ProposalViewer } from '../src/bid-proposal-reads';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, contextFor, memberId } from './support/authz-fixtures';
import { seedOcrPage } from './support/bid-ocr-fixtures';
import { DEPARTMENT, OTHER_PROJECT_UNIT, PROVINCE, hoursFromNow, nothing, onProjects, seedBidPackage, seedContractor, seedProposal } from './support/bid-proposal-fixtures';
import type { SeededPackage } from './support/bid-proposal-fixtures';

const harness = new AuthzHarness();
const store = new BidOcrStore();
const conflicts = new BidConflictStore();
const CLERK = 1;
const E1 = 2;
const E2 = 3;
const APPROVER = 4;
const REASON = 'The relation was examined and decided by the authority.';

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = E1): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const key = (): string => `tenants/${TENANT_A}/ocr-text/${randomUUID()}`;
const correctionKey = (): string => `tenants/${TENANT_A}/document/${randomUUID()}`;
const reader = async (): Promise<CorrectedText> => ({ sha256: sha('corrected text') });
const viewer = (member: number, rights: { evaluate?: ScopeBuilder; receive?: ScopeBuilder }): ProposalViewer => ({
  membershipId: memberId(member),
  evaluate: rights.evaluate ?? nothing,
  receive: rights.receive ?? nothing,
  now: new Date(),
});
const declare = (seeded: SeededPackage, member: number, body: { hasConflict: boolean; relationText?: string; contractorId?: string }) =>
  as((tx) => conflicts.declare(tx, { packageId: seeded.packageId, ...body }, memberId(member), everything), member);
const rows = <R extends object>(sql: string, params: unknown[] = []) => harness.owner<R>(TENANT_A, [[sql, params]]);
const statusOf = async (id: string): Promise<string | undefined> =>
  (await rows<{ review_status: string }>('select review_status from machvon.document_page_ocr where id = $1::uuid', [id]))[0]?.review_status;

interface Refusal {
  code?: string;
  status?: number;
  detail?: string;
  extensions?: Record<string, unknown>;
  message: string;
}
const failure = async (work: Promise<unknown>): Promise<Refusal> => {
  try {
    await work;
  } catch (error) {
    return error as Refusal;
  }
  throw new Error('expected a refusal');
};

describe('the OCR of the pages of a proposal and its review (ST-BID-008, BR-BID-03/06)', () => {
  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: PROVINCE, path: '/u1/' },
      { n: DEPARTMENT, path: '/u1/u2/', parent: PROVINCE },
      { n: OTHER_PROJECT_UNIT, path: '/u3/' },
    ]);
    for (const n of [CLERK, E1, E2, APPROVER]) await harness.seedMembership(TENANT_A, n, PROVINCE);
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  /** A released proposal of one file of twelve pages, and a member (E1) who declared that no conflict stands. */
  async function fixture() {
    const seeded = await seedBidPackage(harness);
    const contractor = await seedContractor(harness, { name: 'NT-1' });
    const proposal = await seedProposal(harness, seeded, contractor, { releasedAt: hoursFromNow(-1) });
    await declare(seeded, E1, { hasConflict: false });
    return { seeded, contractor, proposal, evaluator: viewer(E1, { evaluate: onProjects(seeded.projectId) }) };
  }

  describe('recordPages', () => {
    it('gives each page the status of its reading and leaves a page recorded before as it is (idempotent per page)', async () => {
      const { proposal } = await fixture();
      const good = { pageIndex: 0, confidence: '0.9100', textSha256: sha('a'), textObjectKey: key(), tables: [{ rows: [{ label: 'Item', amount: '5' }], total: '5' }] };
      const edge = { pageIndex: 1, confidence: '0.85', textSha256: sha('b'), textObjectKey: key(), tables: [] };
      const low = { pageIndex: 10, confidence: '0.71', textSha256: sha('c'), textObjectKey: key(), tables: [] };
      const mismatch = { pageIndex: 3, confidence: '0.99', textSha256: sha('d'), textObjectKey: key(), tables: [{ rows: [{ label: 'Item', amount: '5' }], total: '6' }] };
      const just = { pageIndex: 4, confidence: '0.849', textSha256: sha('e'), textObjectKey: key(), tables: [] };
      const first = await as((tx) => store.recordPages(tx, proposal.versionId, [good, edge, low, mismatch, just], 'engine-1.0'));
      expect(first.map((page) => [page.pageIndex, page.status, page.tableMismatch, page.created])).toEqual([
        [0, 'AUTO_ACCEPTED', false, true],
        [1, 'AUTO_ACCEPTED', false, true],
        [3, 'NEEDS_REVIEW', true, true],
        [4, 'NEEDS_REVIEW', false, true],
        [10, 'NEEDS_REVIEW', false, true],
      ]);
      const again = await as((tx) => store.recordPages(tx, proposal.versionId, [good, { ...low, confidence: '0.99' }], 'engine-2.0'));
      expect(again.map((page) => [page.pageIndex, page.status, page.created])).toEqual([
        [0, 'AUTO_ACCEPTED', false],
        [10, 'NEEDS_REVIEW', false],
      ]);
      expect(Number((await rows<{ n: string }>('select count(*)::text as n from machvon.document_page_ocr where document_version_id = $1::uuid', [proposal.versionId]))[0]?.n)).toBe(5);
      expect(
        (await rows<{ engine_version: string; ocr_confidence: string }>('select engine_version, ocr_confidence::text from machvon.document_page_ocr where id = $1::uuid', [again[1]?.id]))[0],
      ).toEqual({
        engine_version: 'engine-1.0',
        ocr_confidence: '0.7100',
      });
    });

    it('refuses what the column cannot keep (422) and a version that is not the tenant is (404)', async () => {
      const { proposal } = await fixture();
      const page = { pageIndex: 0, confidence: '0.9', textSha256: sha('a'), textObjectKey: key(), tables: [] as unknown };
      const record = (pages: Array<typeof page>, engine = 'engine-1.0', version = proposal.versionId) => as((tx) => store.recordPages(tx, version, pages, engine));
      expect(await failure(record([]))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'pages' });
      expect(await failure(record([page], ' '))).toMatchObject({ detail: 'engine_version' });
      expect(await failure(record([page], 'x'.repeat(121)))).toMatchObject({ detail: 'engine_version' });
      expect(await failure(record([{ ...page, pageIndex: -1 }]))).toMatchObject({ detail: 'page_index' });
      expect(await failure(record([{ ...page, pageIndex: 12 }]))).toMatchObject({ detail: 'page_index' });
      expect(await failure(record([{ ...page, pageIndex: 1.5 }]))).toMatchObject({ detail: 'page_index' });
      expect(await failure(record([page, page]))).toMatchObject({ detail: 'page_index' });
      expect(await failure(record([{ ...page, confidence: '1.5' }]))).toMatchObject({ detail: 'ocr_confidence' });
      expect(await failure(record([{ ...page, textSha256: 'zz' }]))).toMatchObject({ detail: 'text_sha256' });
      expect(await failure(record([{ ...page, textObjectKey: 'not/a/key' }]))).toMatchObject({ detail: 'text_object_key' });
      expect(await failure(record([{ ...page, tables: 'x' }]))).toMatchObject({ detail: 'tables' });
      expect(await failure(record([page], 'engine-1.0', randomUUID()))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(Number((await rows<{ n: string }>('select count(*)::text as n from machvon.document_page_ocr where document_version_id = $1::uuid', [proposal.versionId]))[0]?.n)).toBe(0);
    });

    it('keeps a page whose table cannot be read as one that waits for a person', async () => {
      const { proposal } = await fixture();
      const [recorded] = await as((tx) =>
        store.recordPages(tx, proposal.versionId, [{ pageIndex: 0, confidence: '1', textSha256: sha('a'), textObjectKey: key(), tables: [{ rows: 'x', total: '1' }] }], 'engine-1.0'),
      );
      expect(recorded).toMatchObject({ status: 'NEEDS_REVIEW', tableMismatch: true });
    });
  });

  describe('what the caller sees of the pages (BR-BID-03)', () => {
    it('lists the pages of a proposal for the member who has the full view, with the gate of the financial analysis (AC-ST-BID-008-1, UAT-AC449)', async () => {
      const { proposal, evaluator } = await fixture();
      const accepted = await seedOcrPage(harness, proposal.versionId, { pageIndex: 0 });
      const waiting = await seedOcrPage(harness, proposal.versionId, { pageIndex: 11, confidence: '0.7100', status: 'NEEDS_REVIEW' });
      const listed = await as((tx) => store.listForProposal(tx, proposal.id, evaluator, {}, { limit: 50, after: undefined }));
      expect(listed.kind).toBe('SEEN');
      if (listed.kind !== 'SEEN') return;
      expect(listed.pages.map((page) => [page.id, page.pageIndex, page.confidence, page.status, page.reviewedBy])).toEqual([
        [accepted.id, 0, '0.9900', 'AUTO_ACCEPTED', null],
        [waiting.id, 11, '0.7100', 'NEEDS_REVIEW', null],
      ]);
      expect(listed.gate).toEqual({ ready: false, blocked: [{ id: waiting.id, pageIndex: 11 }] });
      expect(listed.documents.map((document) => document.title)).toEqual(['Technical proposal']);
      expect(listed.proposal.id).toBe(proposal.id);
    });

    it('filters by file and by status, and pages by the file and the page', async () => {
      const { proposal, evaluator } = await fixture();
      for (let n = 0; n < 3; n += 1) await seedOcrPage(harness, proposal.versionId, { pageIndex: n, status: n === 1 ? 'NEEDS_REVIEW' : 'AUTO_ACCEPTED', confidence: n === 1 ? '0.5000' : '0.9900' });
      const list = (filter: { documentVersionId?: string; status?: 'NEEDS_REVIEW' }, limit = 50, after?: { code: string; id: string }) =>
        as((tx) => store.listForProposal(tx, proposal.id, evaluator, filter, { limit, after }));
      const waiting = await list({ status: 'NEEDS_REVIEW' });
      expect(waiting.kind === 'SEEN' && waiting.pages.map((page) => page.pageIndex)).toEqual([1]);
      const elsewhere = await list({ documentVersionId: randomUUID() });
      expect(elsewhere.kind === 'SEEN' && elsewhere.pages).toEqual([]);
      const first = await list({ documentVersionId: proposal.versionId }, 2);
      if (first.kind !== 'SEEN') throw new Error('expected pages');
      expect(first.pages.map((page) => page.pageIndex)).toEqual([0, 1]);
      expect(first.more).toBe(true);
      const second = await list({}, 2, first.last);
      if (second.kind !== 'SEEN') throw new Error('expected pages');
      expect([second.pages.map((page) => page.pageIndex), second.more]).toEqual([[2], false]);
      expect(await failure(list({}, 2, { code: 'garbage', id: randomUUID() }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'cursor' });
    });

    it('shows an empty list as a list and the gate as ready for a proposal whose pages are not read yet', async () => {
      const { proposal, evaluator } = await fixture();
      const listed = await as((tx) => store.listForProposal(tx, proposal.id, evaluator, {}, { limit: 50, after: undefined }));
      expect(listed).toMatchObject({ kind: 'SEEN', pages: [], more: false, last: undefined, gate: { ready: true, blocked: [] } });
    });

    it('hides the pages from a clerk, from a member outside the scope, before the opening and from a member recused from the contractor (404)', async () => {
      const { seeded, contractor, proposal, evaluator } = await fixture();
      const waiting = await seedOcrPage(harness, proposal.versionId, { pageIndex: 0, status: 'NEEDS_REVIEW', confidence: '0.5000' });
      const list = (v: ProposalViewer, id = proposal.id) => as((tx) => store.listForProposal(tx, id, v, {}, { limit: 50, after: undefined }));
      expect(await list(viewer(CLERK, { receive: onProjects(seeded.projectId) }))).toEqual({ kind: 'HIDDEN' });
      expect(await list(viewer(E1, { evaluate: onProjects(randomUUID()) }))).toEqual({ kind: 'HIDDEN' });
      expect(await list(viewer(E1, {}))).toEqual({ kind: 'HIDDEN' });
      expect(await list(evaluator, randomUUID())).toEqual({ kind: 'HIDDEN' });
      const sealedProposal = await seedProposal(harness, seeded, await seedContractor(harness), { releasedAt: hoursFromNow(24) });
      expect(await list(evaluator, sealedProposal.id)).toEqual({ kind: 'HIDDEN' });
      const recused = viewer(E2, { evaluate: onProjects(seeded.projectId) });
      expect(await list(recused)).toEqual({ kind: 'DECLARATION_REQUIRED' });
      const made = await declare(seeded, E2, { hasConflict: true, relationText: 'The director of NT-1 is my cousin.', contractorId: contractor });
      expect(await list(recused)).toEqual({ kind: 'HIDDEN' });
      await as((tx) => conflicts.decide(tx, made.id, 1, 'RECUSED', REASON, memberId(APPROVER), everything), APPROVER);
      expect(await list(recused)).toEqual({ kind: 'HIDDEN' });
      const outcome = await failure(as((tx) => store.review(tx, waiting.id, { decision: 'CONFIRMED' }, memberId(E2), recused, reader), E2));
      expect(outcome).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });
  });

  describe('review', () => {
    it('confirms a page that waits and opens the gate once no page waits (AC-ST-BID-008-1, UAT-AC449)', async () => {
      const { seeded, contractor, proposal, evaluator } = await fixture();
      await seedOcrPage(harness, proposal.versionId, { pageIndex: 0 });
      const waiting = await seedOcrPage(harness, proposal.versionId, { pageIndex: 5, status: 'NEEDS_REVIEW', confidence: '0.7100' });
      const reviewed = await as((tx) => store.review(tx, waiting.id, { decision: 'CONFIRMED', note: 'Checked against the scan.' }, memberId(E1), evaluator, reader));
      expect(reviewed).toEqual({
        id: waiting.id,
        documentVersionId: proposal.versionId,
        pageIndex: 5,
        proposalId: proposal.id,
        packageId: seeded.packageId,
        packageCode: seeded.packageCode,
        projectId: seeded.projectId,
        contractorId: contractor,
        previousStatus: 'NEEDS_REVIEW',
        status: 'CONFIRMED',
        hasNote: true,
        confidence: '0.7100',
        tableMismatch: false,
        financialReady: true,
      });
      const [stored] = await rows<{ review_status: string; reviewed_by: string; reviewed_at: string | null; review_note: string; corrected_text_object_key: string | null }>(
        'select review_status, reviewed_by, reviewed_at::text, review_note, corrected_text_object_key from machvon.document_page_ocr where id = $1::uuid',
        [waiting.id],
      );
      expect(stored).toMatchObject({ review_status: 'CONFIRMED', reviewed_by: memberId(E1), review_note: 'Checked against the scan.', corrected_text_object_key: null });
      expect(stored?.reviewed_at).not.toBeNull();
    });

    it('corrects a page with the text the reviewer put in its place, and keeps the reading of the engine as it was', async () => {
      const { proposal, evaluator } = await fixture();
      const waiting = await seedOcrPage(harness, proposal.versionId, { pageIndex: 5, status: 'NEEDS_REVIEW', confidence: '0.7100', textSha: sha('engine text') });
      const corrected = correctionKey();
      const seen: string[] = [];
      const reviewed = await as((tx) =>
        store.review(tx, waiting.id, { decision: 'CORRECTED', correctedTextObjectKey: corrected, note: '   ' }, memberId(E1), evaluator, async (value) => {
          seen.push(value);
          return { sha256: sha('corrected text') };
        }),
      );
      expect(seen).toEqual([corrected]);
      expect(reviewed).toMatchObject({ status: 'CORRECTED', hasNote: false, financialReady: true });
      const [stored] = await rows<{ review_status: string; corrected_text_object_key: string; corrected_text_sha256: string; text_sha256: string; review_note: string | null }>(
        'select review_status, corrected_text_object_key, corrected_text_sha256, text_sha256, review_note from machvon.document_page_ocr where id = $1::uuid',
        [waiting.id],
      );
      expect(stored).toEqual({ review_status: 'CORRECTED', corrected_text_object_key: corrected, corrected_text_sha256: sha('corrected text'), text_sha256: sha('engine text'), review_note: null });
      const listed = await as((tx) => store.listForProposal(tx, proposal.id, evaluator, {}, { limit: 50, after: undefined }));
      expect(listed.kind === 'SEEN' && listed.pages[0]).toMatchObject({ status: 'CORRECTED', correctedTextObjectKey: corrected, correctedTextSha256: sha('corrected text'), reviewedBy: memberId(E1) });
    });

    it('keeps the gate closed while another page of the proposal waits', async () => {
      const { proposal, evaluator } = await fixture();
      const first = await seedOcrPage(harness, proposal.versionId, { pageIndex: 1, status: 'NEEDS_REVIEW', confidence: '0.5000' });
      const second = await seedOcrPage(harness, proposal.versionId, { pageIndex: 2, status: 'NEEDS_REVIEW', tableMismatch: true });
      expect(await as((tx) => store.review(tx, first.id, { decision: 'CONFIRMED' }, memberId(E1), evaluator, reader))).toMatchObject({ financialReady: false });
      expect(await as((tx) => store.review(tx, second.id, { decision: 'CONFIRMED' }, memberId(E1), evaluator, reader))).toMatchObject({ financialReady: true, tableMismatch: true });
    });

    it('reports the proposal as ready to the review that settles its last page, when the last two pages are reviewed at the same time', async () => {
      const { proposal, evaluator } = await fixture();
      const first = await seedOcrPage(harness, proposal.versionId, { pageIndex: 1, status: 'NEEDS_REVIEW', confidence: '0.5000' });
      const second = await seedOcrPage(harness, proposal.versionId, { pageIndex: 2, status: 'NEEDS_REVIEW', confidence: '0.5000' });
      // The first review is done and its transaction stays open until the second review is done (a second at most): without a lock on the proposal the second one cannot see the first, and nobody
      // reports the proposal as ready; with it, the second waits for the first to commit and sees it.
      const input = () => ({ decision: 'CORRECTED', correctedTextObjectKey: correctionKey() });
      let reviewed: () => void = () => undefined;
      const firstReviewed = new Promise<void>((resolve) => {
        reviewed = resolve;
      });
      let secondDone: Promise<unknown> = Promise.resolve();
      const firstReview = as(async (tx) => {
        const done = await store.review(tx, first.id, input(), memberId(E1), evaluator, reader);
        reviewed();
        await Promise.race([firstReviewed.then(() => secondDone), new Promise((resolve) => setTimeout(resolve, 1000))]);
        return done;
      });
      await firstReviewed;
      const secondReview = as((tx) => store.review(tx, second.id, input(), memberId(E1), evaluator, reader));
      secondDone = secondReview;
      const results = await Promise.all([firstReview, secondReview]);
      expect(results.map((one) => one.financialReady)).toEqual([false, true]);
    });

    it('reviews a page once: a second review, and the review of a page that was accepted, is 409 OCR_STATE_INVALID, judged before the body and the text', async () => {
      const { proposal, evaluator } = await fixture();
      const waiting = await seedOcrPage(harness, proposal.versionId, { pageIndex: 1, status: 'NEEDS_REVIEW', confidence: '0.5000' });
      const accepted = await seedOcrPage(harness, proposal.versionId, { pageIndex: 2 });
      await as((tx) => store.review(tx, waiting.id, { decision: 'CONFIRMED' }, memberId(E1), evaluator, reader));
      const untouched = async (): Promise<CorrectedText> => {
        throw new Error('the text must not be read');
      };
      for (const id of [waiting.id, accepted.id]) {
        expect(await failure(as((tx) => store.review(tx, id, { decision: 'CORRECTED', correctedTextObjectKey: correctionKey() }, memberId(E1), evaluator, untouched)))).toMatchObject({
          code: 'OCR_STATE_INVALID',
          status: 409,
        });
      }
      expect(await statusOf(accepted.id)).toBe('AUTO_ACCEPTED');
    });

    it('refuses a correction without its text, a confirmation with one, and a text that is already a file of something else (422)', async () => {
      const { proposal, evaluator } = await fixture();
      const waiting = await seedOcrPage(harness, proposal.versionId, { pageIndex: 1, status: 'NEEDS_REVIEW', confidence: '0.5000' });
      const other = await seedOcrPage(harness, proposal.versionId, { pageIndex: 2, status: 'NEEDS_REVIEW', confidence: '0.5000' });
      const review = (id: string, input: { decision: unknown; correctedTextObjectKey?: unknown }) => as((tx) => store.review(tx, id, input, memberId(E1), evaluator, reader));
      expect(await failure(review(waiting.id, { decision: 'CORRECTED' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'corrected_text_object_key' });
      expect(await failure(review(waiting.id, { decision: 'CONFIRMED', correctedTextObjectKey: correctionKey() }))).toMatchObject({ detail: 'corrected_text_object_key' });
      expect(await failure(review(waiting.id, { decision: 'nope' }))).toMatchObject({ detail: 'decision' });
      const [version] = await rows<{ object_key: string }>('select object_key from machvon.document_version where id = $1::uuid', [proposal.versionId]);
      expect(await failure(review(waiting.id, { decision: 'CORRECTED', correctedTextObjectKey: version?.object_key }))).toMatchObject({
        detail: 'corrected_text_object_key',
        extensions: { reason: 'FILE_ALREADY_ATTACHED' },
      });
      const shared = correctionKey();
      await review(waiting.id, { decision: 'CORRECTED', correctedTextObjectKey: shared });
      expect(await failure(review(other.id, { decision: 'CORRECTED', correctedTextObjectKey: shared }))).toMatchObject({ extensions: { reason: 'FILE_ALREADY_ATTACHED' } });
      const [engineText] = await rows<{ text_object_key: string }>('select text_object_key from machvon.document_page_ocr where id = $1::uuid', [other.id]);
      expect(await failure(review(other.id, { decision: 'CORRECTED', correctedTextObjectKey: engineText?.text_object_key }))).toMatchObject({ extensions: { reason: 'FILE_ALREADY_ATTACHED' } });
      expect(await statusOf(other.id)).toBe('NEEDS_REVIEW');
    });

    it('does not let a text the reader refuses change the page', async () => {
      const { proposal, evaluator } = await fixture();
      const waiting = await seedOcrPage(harness, proposal.versionId, { pageIndex: 1, status: 'NEEDS_REVIEW', confidence: '0.5000' });
      const refused = async (): Promise<CorrectedText> => {
        throw Object.assign(new Error('refused'), { code: 'FILE_KEY_INVALID' });
      };
      expect(await failure(as((tx) => store.review(tx, waiting.id, { decision: 'CORRECTED', correctedTextObjectKey: correctionKey() }, memberId(E1), evaluator, refused)))).toMatchObject({
        code: 'FILE_KEY_INVALID',
      });
      expect(await statusOf(waiting.id)).toBe('NEEDS_REVIEW');
    });

    it('does not show a page to the caller who may not see its proposal: a clerk, one outside the scope, one that owes the declaration, a page that does not exist (404, 403)', async () => {
      const { seeded, proposal } = await fixture();
      const waiting = await seedOcrPage(harness, proposal.versionId, { pageIndex: 1, status: 'NEEDS_REVIEW', confidence: '0.5000' });
      const review = (id: string, v: ProposalViewer, member = E1) => as((tx) => store.review(tx, id, { decision: 'CONFIRMED' }, memberId(member), v, reader), member);
      expect(await failure(review(waiting.id, viewer(CLERK, { receive: onProjects(seeded.projectId) }), CLERK))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await failure(review(waiting.id, viewer(E1, { evaluate: onProjects(randomUUID()) })))).toMatchObject({ status: 404 });
      expect(await failure(review(randomUUID(), viewer(E1, { evaluate: onProjects(seeded.projectId) })))).toMatchObject({ status: 404 });
      expect(await failure(review(waiting.id, viewer(E2, { evaluate: onProjects(seeded.projectId) }), E2))).toMatchObject({ code: 'CONFLICT_UNDECLARED', status: 403 });
      expect(await statusOf(waiting.id)).toBe('NEEDS_REVIEW');
    });
  });

  describe('gate', () => {
    it('answers for the versions of documents the analysis names, and refuses ids that are none', async () => {
      const { proposal } = await fixture();
      const other = await fixture();
      const waiting = await seedOcrPage(harness, proposal.versionId, { pageIndex: 3, status: 'NEEDS_REVIEW', confidence: '0.5000' });
      await seedOcrPage(harness, other.proposal.versionId, { pageIndex: 0 });
      expect(await as((tx) => store.gate(tx, [proposal.versionId]))).toEqual({ ready: false, blocked: [{ id: waiting.id, pageIndex: 3 }] });
      expect(await as((tx) => store.gate(tx, [other.proposal.versionId]))).toEqual({ ready: true, blocked: [] });
      expect(await as((tx) => store.gate(tx, [other.proposal.versionId, proposal.versionId.toUpperCase()]))).toMatchObject({ ready: false });
      expect(await as((tx) => store.gate(tx, []))).toEqual({ ready: true, blocked: [] });
      expect(await failure(as((tx) => store.gate(tx, ['nope'])))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'document_version_ids' });
    });
  });

  describe('the guard of the table', () => {
    const attempt = (sql: string, params: unknown[]) => failure(as((tx) => tx.query(sql, params)));

    it('keeps what the engine read: no fact of a page changes, whatever its status (UAT-AC449)', async () => {
      const { proposal } = await fixture();
      const waiting = await seedOcrPage(harness, proposal.versionId, { pageIndex: 1, status: 'NEEDS_REVIEW', confidence: '0.5000' });
      for (const change of [
        'ocr_confidence = 0.99',
        `text_sha256 = '${'b'.repeat(64)}'`,
        "text_object_key = 'tenants/x/ocr-text/y'",
        'tables_json = \'[{"rows":[],"total":"0"}]\'::jsonb',
        "engine_version = 'engine-9'",
        'page_index = 7',
        'table_mismatch = true',
        'document_version_id = gen_random_uuid()',
        "created_at = now() - interval '1 day'",
      ]) {
        expect((await attempt(`update machvon.document_page_ocr set ${change} where id = $1::uuid`, [waiting.id])).message).toContain('what the engine read');
      }
    });

    it('moves a page that waits only to CONFIRMED or CORRECTED, by a person, and never moves a page that was accepted or reviewed', async () => {
      const { proposal } = await fixture();
      const waiting = await seedOcrPage(harness, proposal.versionId, { pageIndex: 1, status: 'NEEDS_REVIEW', confidence: '0.5000' });
      const accepted = await seedOcrPage(harness, proposal.versionId, { pageIndex: 2 });
      const reviewer = memberId(E1);
      expect((await attempt("update machvon.document_page_ocr set review_status = 'AUTO_ACCEPTED' where id = $1::uuid", [waiting.id])).message).toContain('confirmed or corrected by a person');
      expect((await attempt("update machvon.document_page_ocr set review_status = 'CONFIRMED' where id = $1::uuid", [waiting.id])).message).toContain('confirmed or corrected by a person');
      expect(
        (await attempt("update machvon.document_page_ocr set review_status = 'CONFIRMED', reviewed_by = $2::uuid, reviewed_at = now() where id = $1::uuid", [accepted.id, reviewer])).message,
      ).toContain('stays so');
      expect((await attempt("update machvon.document_page_ocr set review_note = 'x' where id = $1::uuid", [accepted.id])).message).toContain('stays so');
      expect(
        (await attempt("update machvon.document_page_ocr set review_status = 'CORRECTED', reviewed_by = $2::uuid, reviewed_at = now() where id = $1::uuid", [waiting.id, reviewer])).message,
      ).toContain('document_page_ocr_corrected_chk');
      await as((tx) => tx.query("update machvon.document_page_ocr set review_status = 'CONFIRMED', reviewed_by = $2::uuid, reviewed_at = now() where id = $1::uuid", [waiting.id, reviewer]));
      expect((await attempt("update machvon.document_page_ocr set review_status = 'NEEDS_REVIEW', reviewed_by = null, reviewed_at = null where id = $1::uuid", [waiting.id])).message).toContain(
        'stays so',
      );
      expect((await attempt("update machvon.document_page_ocr set review_note = 'changed my mind' where id = $1::uuid", [waiting.id])).message).toContain('stays so');
    });

    it('writes a page as read and not as reviewed, with no reviewer, and a table that does not add up is not accepted', async () => {
      const { proposal } = await fixture();
      const insert = (columns: string, values: string) =>
        attempt(
          `insert into machvon.document_page_ocr (tenant_id, id, document_version_id, page_index, ocr_confidence, text_sha256, text_object_key, engine_version, ${columns})
           values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, 9, 0.99, $2, 'tenants/x/ocr-text/y', 'engine-1.0', ${values})`,
          [proposal.versionId, 'a'.repeat(64)],
        );
      expect((await insert('review_status', "'CONFIRMED'")).message).toContain('read before it is reviewed');
      expect((await insert('review_status, review_note', "'NEEDS_REVIEW', 'x'")).message).toContain('read before it is reviewed');
      expect((await insert('review_status, table_mismatch', "'AUTO_ACCEPTED', true")).message).toContain('document_page_ocr_mismatch_chk');
      expect((await insert('review_status, tables_json', "'AUTO_ACCEPTED', '{}'::jsonb")).message).toContain('document_page_ocr_tables_chk');
    });

    it('deletes no page and empties no table, for the application; the owner of the schema keeps its maintenance', async () => {
      const { proposal } = await fixture();
      const page = await seedOcrPage(harness, proposal.versionId, { pageIndex: 1 });
      expect((await attempt('delete from machvon.document_page_ocr where id = $1::uuid', [page.id])).message).toMatch(/permission denied|kept for good/);
      expect((await attempt('truncate machvon.document_page_ocr', [])).message).toMatch(/permission denied|kept for good/);
      await rows('delete from machvon.document_page_ocr where id = $1::uuid', [page.id]);
      expect(await rows('select 1 from machvon.document_page_ocr where id = $1::uuid', [page.id])).toEqual([]);
    });

    it('keeps the stored file of a correction for one page only', async () => {
      const { proposal } = await fixture();
      const a = await seedOcrPage(harness, proposal.versionId, { pageIndex: 1, status: 'NEEDS_REVIEW', confidence: '0.5000' });
      const b = await seedOcrPage(harness, proposal.versionId, { pageIndex: 2, status: 'NEEDS_REVIEW', confidence: '0.5000' });
      const shared = correctionKey();
      const correct = (id: string) =>
        rows(
          `update machvon.document_page_ocr set review_status = 'CORRECTED', reviewed_by = $2::uuid, reviewed_at = now(), corrected_text_object_key = $3, corrected_text_sha256 = $4 where id = $1::uuid`,
          [id, memberId(E1), shared, 'c'.repeat(64)],
        );
      await correct(a.id);
      await expect(correct(b.id)).rejects.toThrow(/document_page_ocr_corrected_uq/);
    });
  });
});
