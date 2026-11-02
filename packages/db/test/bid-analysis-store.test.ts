import { createHash, randomUUID } from 'node:crypto';
import { BidAnalysisStore } from '../src/bid-analysis-store';
import type { Admission, RunContext } from '../src/bid-analysis-store';
import { BidConflictStore } from '../src/bid-conflict-store';
import { BidReviewStore } from '../src/bid-review-store';
import type { ProposalViewer } from '../src/bid-proposal-reads';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, contextFor, memberId } from './support/authz-fixtures';
import { seedAiRequest, seedAnalysisProfile, seedCriteria } from './support/bid-analysis-fixtures';
import { seedOcrPage } from './support/bid-ocr-fixtures';
import { DEPARTMENT, OTHER_PROJECT_UNIT, PROVINCE, hoursFromNow, nothing, onProjects, seedBidPackage, seedContractor, seedProposal } from './support/bid-proposal-fixtures';
import type { SeededPackage } from './support/bid-proposal-fixtures';

const harness = new AuthzHarness();
const store = new BidAnalysisStore();
const conflicts = new BidConflictStore();
const reviews = new BidReviewStore();
const E1 = 2;
const E2 = 3;
const APPROVER = 4;
const REASON = 'The relation was examined and decided by the authority.';

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = E1): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });
const viewer = (member: number, evaluate: ScopeBuilder = nothing): ProposalViewer => ({ membershipId: memberId(member), evaluate, receive: nothing, now: new Date() });
const rows = <R extends object>(sql: string, params: unknown[] = []) => harness.owner<R>(TENANT_A, [[sql, params]]);
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

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

describe('the AI analysis of a proposal (ST-BID-009, BID 3 F5, BR-BID-05/07)', () => {
  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: PROVINCE, path: '/u1/' },
      { n: DEPARTMENT, path: '/u1/u2/', parent: PROVINCE },
      { n: OTHER_PROJECT_UNIT, path: '/u3/' },
    ]);
    for (const n of [1, E1, E2, APPROVER]) await harness.seedMembership(TENANT_A, n, PROVINCE);
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  interface Fixture {
    seeded: SeededPackage;
    contractor: string;
    proposal: { id: string; versionId: string };
    criteria: { id: string };
    profile: { id: string; promptVersionId: string };
    evaluator: ProposalViewer;
  }

  /** A released proposal of one file of two pages that were read with confidence, approved criteria, a published profile, and E1 who declared that no conflict stands. */
  async function fixture(options: { pages?: 'accepted' | 'waiting' | 'none' | 'partial' } = {}): Promise<Fixture> {
    const seeded = await seedBidPackage(harness);
    const contractor = await seedContractor(harness, { name: 'NT-1' });
    const proposal = await seedProposal(harness, seeded, contractor, { releasedAt: hoursFromNow(-1), price: '4000' });
    await rows('update machvon.document_version set page_count = 2 where id = $1::uuid', [proposal.versionId]);
    const mode = options.pages ?? 'accepted';
    if (mode !== 'none') await seedOcrPage(harness, proposal.versionId, { pageIndex: 0, status: mode === 'waiting' ? 'NEEDS_REVIEW' : 'AUTO_ACCEPTED', confidence: mode === 'waiting' ? '0.7100' : '0.9900' });
    if (mode !== 'none' && mode !== 'partial') await seedOcrPage(harness, proposal.versionId, { pageIndex: 1, tables: [{ rows: [{ label: 'Work', amount: '4000' }], total: '4000' }] });
    await as((tx) => conflicts.declare(tx, { packageId: seeded.packageId, hasConflict: false }, memberId(E1), everything));
    return {
      seeded,
      contractor,
      proposal,
      criteria: await seedCriteria(harness, seeded.packageId),
      profile: await seedAnalysisProfile(harness),
      evaluator: viewer(E1, onProjects(seeded.projectId)),
    };
  }

  const request = (fx: Fixture, overrides: Partial<{ proposalId: string; criteriaVersionId: string; profileVersionId: string }> = {}) => ({
    proposalId: fx.proposal.id,
    criteriaVersionId: fx.criteria.id,
    profileVersionId: fx.profile.id,
    ...overrides,
  });
  const admit = (fx: Fixture, overrides: Parameters<typeof request>[1] = {}, who: ProposalViewer = fx.evaluator, member = E1) => as((tx) => store.admit(tx, request(fx, overrides), who), member);
  const contextOf = (admission: Admission): RunContext => {
    if (admission.kind !== 'NEW') throw new Error('expected a new run');
    return admission.context;
  };

  /** A run begun and ended as the pipeline would end it: a request answered, findings with their evidence written while it ran. */
  async function runOf(fx: Fixture, overrides: Parameters<typeof request>[1] = {}): Promise<string> {
    const context = contextOf(await admit(fx, overrides));
    const requestId = await seedAiRequest(harness);
    return as(async (tx) => {
      const id = await store.begin(tx, context, memberId(E1));
      await store.saveFindings(
        tx,
        id,
        [
          {
            criterionCode: 'C1',
            status: 'SUPPORTED',
            text: 'The contractor built three bridges.',
            missingSource: false,
            evidence: [
              { kind: 'DOCUMENT', documentVersionId: fx.proposal.versionId, pageIndex: 0, quoteSha256: sha('three bridges'), quoteExcerpt: 'three bridges', verifiedPresent: true },
              { kind: 'DOCUMENT', documentVersionId: fx.proposal.versionId, pageIndex: 1, quoteSha256: sha('four bridges'), quoteExcerpt: 'four bridges', verifiedPresent: false },
            ],
          },
          { criterionCode: 'C2', status: 'NEEDS_REVIEW', text: 'Claimed but not found.', missingSource: true, evidence: [] },
        ],
        'HEURISTIC',
      );
      await store.finish(tx, id, { status: 'AWAITING_REVIEW', failureCode: null, failedStep: null }, { aiRequestId: requestId, routeClass: 'DOMESTIC_HOSTED', budgetReservationId: null });
      return id;
    });
  }

  describe('the admission of a run', () => {
    it('hands back the context of a run: the criteria, the files, the hashes, the class of the data and the price', async () => {
      const fx = await fixture();
      const context = contextOf(await admit(fx));
      expect(context.proposal.id).toBe(fx.proposal.id);
      expect(context.criteria).toEqual([
        { code: 'C1', name: 'Criterion C1', kind: 'PASS_FAIL', weight: null, maxScore: null, threshold: null, mandatory: true, requiredEvidence: ['A contract list'] },
        { code: 'C2', name: 'Criterion C2', kind: 'SCORED', weight: 40, maxScore: 10, threshold: 6, mandatory: false, requiredEvidence: ['A contract list'] },
      ]);
      expect(context.documents.map((document) => document.documentVersionId)).toEqual([fx.proposal.versionId]);
      expect(context.profile).toEqual({ id: fx.profile.id, promptVersionId: fx.profile.promptVersionId, maxInputTokens: 8000, taskType: 'BID_ANALYSIS' });
      expect(context.dataClassification).toBe('CONFIDENTIAL');
      expect(context.bidPriceVnd).toBe('4000');
      expect(context.supersedesRunId).toBeNull();
      expect(context.inputHash).toMatch(/^[0-9a-f]{64}$/);
      expect(context.documentSetSha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('does not exist for a caller without the full view: 404, and 403 for one who owes the declaration', async () => {
      const fx = await fixture();
      expect(await failure(admit(fx, {}, viewer(E1)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await failure(admit(fx, { proposalId: randomUUID() }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      const owes = viewer(E2, onProjects(fx.seeded.projectId));
      expect(await failure(admit(fx, {}, owes, E2))).toMatchObject({ code: 'CONFLICT_UNDECLARED', status: 403 });
      const made = await as((tx) => conflicts.declare(tx, { packageId: fx.seeded.packageId, hasConflict: true, relationText: 'The director of NT-1 is my cousin.', contractorId: fx.contractor }, memberId(E2), everything), E2);
      await as((tx) => conflicts.decide(tx, made.id, 1, 'RECUSED', REASON, memberId(APPROVER), everything), APPROVER);
      expect(await failure(admit(fx, {}, owes, E2))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await rows('select 1 from machvon.analysis_run where proposal_id = $1::uuid', [fx.proposal.id])).toEqual([]);
    });

    it('refuses criteria that are not the package approved criteria, and a profile that is not a published, read-only one of the task', async () => {
      const fx = await fixture();
      expect(await failure(admit(fx, { criteriaVersionId: randomUUID() }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', detail: 'criteria_version_id' });
      const other = await seedBidPackage(harness);
      const foreign = await seedCriteria(harness, other.packageId);
      expect(await failure(admit(fx, { criteriaVersionId: foreign.id }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'criteria_version_id' });
      const draft = await seedCriteria(harness, fx.seeded.packageId, { status: 'DRAFT', revision: 2 });
      expect(await failure(admit(fx, { criteriaVersionId: draft.id }))).toMatchObject({ code: 'CRITERIA_STATE_INVALID', status: 409, extensions: { criteria_status: 'DRAFT' } });

      const draftProfile = await seedAnalysisProfile(harness, { status: 'DRAFT' });
      const otherTask = await seedAnalysisProfile(harness, { taskType: 'SUMMARY', status: 'PUBLISHED' });
      const noPrompt = await seedAnalysisProfile(harness, { status: 'DRAFT', withPrompt: false });
      for (const profile of [randomUUID(), draftProfile.id, otherTask.id, noPrompt.id]) expect(await failure(admit(fx, { profileVersionId: profile }))).toMatchObject({ code: 'PROFILE_NOT_PUBLISHED', status: 422 });
      const writer = await seedAnalysisProfile(harness, { tools: ['read_document', 'update_record'] });
      expect(await failure(admit(fx, { profileVersionId: writer.id }))).toMatchObject({ code: 'TOOL_NOT_READ_ONLY', status: 422, detail: 'update_record' });
    });

    it('does not run on files whose pages are not all recorded, nor while a page waits for a person (BR-BID-06)', async () => {
      const none = await fixture({ pages: 'none' });
      expect(await failure(admit(none))).toMatchObject({ code: 'OCR_NOT_RECORDED', status: 409, extensions: { document_version_ids: [none.proposal.versionId] } });
      const partial = await fixture({ pages: 'partial' });
      expect(await failure(admit(partial))).toMatchObject({ code: 'OCR_NOT_RECORDED', status: 409 });
      const waiting = await fixture({ pages: 'waiting' });
      expect(await failure(admit(waiting))).toMatchObject({ code: 'OCR_REVIEW_PENDING', status: 409, extensions: { blocked_pages: 1 } });
      await rows("update machvon.document_page_ocr set review_status = 'CONFIRMED', reviewed_by = $2::uuid, reviewed_at = now() where document_version_id = $1::uuid and review_status = 'NEEDS_REVIEW'", [waiting.proposal.versionId, memberId(E1)]);
      expect((await admit(waiting)).kind).toBe('NEW');
    });
  });

  describe('immutable runs (AC-ST-BID-009-3, BR-BID-05)', () => {
    it('returns the existing run for the same input, makes a new one that supersedes it for a new input, and leaves the old run and its findings as they were', async () => {
      const fx = await fixture();
      const first = await runOf(fx);
      const findings = await rows<{ id: string; status: string; evidence_count: number; finding: string }>('select id, status, evidence_count, finding from machvon.analysis_finding where run_id = $1::uuid order by criterion_id', [first]);
      const again = await admit(fx);
      expect(again).toMatchObject({ kind: 'EXISTING', run: { id: first, status: 'AWAITING_REVIEW', findingCount: 2, missingSourceCount: 1, routeClass: 'DOMESTIC_HOSTED', dataClassification: 'CONFIDENTIAL' } });

      const next = await seedCriteria(harness, fx.seeded.packageId, { revision: 2, codes: ['C1', 'C2', 'C3'] });
      const changed = contextOf(await admit(fx, { criteriaVersionId: next.id }));
      expect(changed.supersedesRunId).toBe(first);
      expect(changed.inputHash).not.toBe((await rows<{ input_hash: string }>('select input_hash from machvon.analysis_run where id = $1::uuid', [first]))[0]?.input_hash);

      // The repeat of the old input still returns the first run, and nothing of it moved.
      const second = await as((tx) => store.begin(tx, changed, memberId(E1)));
      expect((await admit(fx)).kind).toBe('EXISTING');
      expect(await rows('select supersedes_run_id from machvon.analysis_run where id = $1::uuid', [second])).toEqual([{ supersedes_run_id: first }]);
      expect(await rows<{ id: string; status: string; evidence_count: number; finding: string }>('select id, status, evidence_count, finding from machvon.analysis_finding where run_id = $1::uuid order by criterion_id', [first])).toEqual(findings);
      expect(await rows('select status, version from machvon.analysis_run where id = $1::uuid', [first])).toEqual([{ status: 'AWAITING_REVIEW', version: '2' }]);
    });

    it('lets a cancelled run and a run that ended without an answer free the input to be asked again', async () => {
      const fx = await fixture();
      const failed = contextOf(await admit(fx));
      const requestId = await seedAiRequest(harness, { status: 'FAILED', route: 'SELF_HOSTED', rejectCode: 'AI_ROUTE_EXHAUSTED' });
      const id = await as(async (tx) => {
        const runId = await store.begin(tx, failed, memberId(E1));
        const ended = await store.finish(tx, runId, { status: 'FAILED', failureCode: 'AI_ROUTE_EXHAUSTED', failedStep: 'MATCH' }, { aiRequestId: requestId, routeClass: 'SELF_HOSTED', budgetReservationId: null });
        expect(ended).toMatchObject({ status: 'FAILED', failureCode: 'AI_ROUTE_EXHAUSTED', failedStep: 'MATCH', routeClass: 'SELF_HOSTED', findingCount: 0, costVnd: '1500' });
        return runId;
      });
      const retry = await admit(fx);
      expect(retry.kind).toBe('NEW');
      // A failed run is not the run that the next one supersedes.
      expect(contextOf(retry).supersedesRunId).toBeNull();
      const second = await as((tx) => store.begin(tx, contextOf(retry), memberId(E1)));
      const cancelled = await as((tx) => store.fail(tx, second, 'OUTPUT_INVALID', 'VERIFY', { aiRequestId: requestId, routeClass: 'DOMESTIC_HOSTED', budgetReservationId: null }));
      expect(cancelled).toMatchObject({ status: 'FAILED', failedStep: 'VERIFY', failureCode: 'OUTPUT_INVALID' });
      expect((await admit(fx)).kind).toBe('NEW');
      expect(id).not.toBe(second);
    });

    it('keeps one live run for one input even when two are begun together', async () => {
      const fx = await fixture();
      const context = contextOf(await admit(fx));
      await as((tx) => store.begin(tx, context, memberId(E1)));
      expect(await failure(as((tx) => store.begin(tx, context, memberId(E1))))).toMatchObject({ message: expect.stringContaining('analysis_run_input_uq') });
    });
  });

  describe('what the database keeps from being rewritten (BR-BID-07)', () => {
    const attempt = (sql: string, params: unknown[] = []) => failure(as((tx) => tx.query(sql, params)));

    it('refuses to change what a run was asked, to move it against its states, to delete it and to rewrite a finding or its evidence', async () => {
      const fx = await fixture();
      const run = await runOf(fx);
      const [finding] = await rows<{ id: string }>("select id from machvon.analysis_finding where run_id = $1::uuid and criterion_id = 'C1'", [run]);
      const [evidence] = await rows<{ id: string }>('select e.id from machvon.analysis_evidence e where e.finding_id = $1::uuid limit 1', [finding?.id]);

      expect(await attempt("update machvon.analysis_run set input_hash = repeat('e', 64), version = version + 1 where id = $1::uuid", [run])).toMatchObject({ message: expect.stringContaining('what a run was asked does not change') });
      expect(await attempt("update machvon.analysis_run set status = 'RUNNING', version = version + 1 where id = $1::uuid", [run])).toMatchObject({ message: expect.stringContaining('does not move from AWAITING_REVIEW to RUNNING') });
      expect(await attempt('update machvon.analysis_run set version = version + 2 where id = $1::uuid', [run])).toMatchObject({ message: expect.stringContaining('one version at a time') });
      expect(await attempt('update machvon.analysis_run set ai_request_id = gen_random_uuid(), version = version + 1 where id = $1::uuid', [run])).toMatchObject({ message: expect.stringContaining('set once') });
      expect(await attempt('delete from machvon.analysis_run where id = $1::uuid', [run])).toMatchObject({ message: expect.stringMatching(/permission denied|kept for good|kept as it was found/) });
      expect(await attempt("update machvon.analysis_finding set finding = 'Rewritten.' where id = $1::uuid", [finding?.id])).toMatchObject({ message: expect.stringContaining('kept as the model said it') });
      expect(await attempt("update machvon.analysis_finding set status = 'CONTRADICTED' where id = $1::uuid", [finding?.id])).toMatchObject({ message: expect.stringContaining('kept as the model said it') });
      expect(await attempt('delete from machvon.analysis_finding where id = $1::uuid', [finding?.id])).toMatchObject({ message: expect.stringMatching(/permission denied|kept for good|kept as it was found/) });
      expect(await attempt('update machvon.analysis_evidence set verified_present = true where id = $1::uuid', [evidence?.id])).toMatchObject({ message: expect.stringContaining('kept as it was found') });
      expect(await attempt('delete from machvon.analysis_evidence where id = $1::uuid', [evidence?.id])).toMatchObject({ message: expect.stringMatching(/permission denied|kept for good|kept as it was found/) });
      expect(await attempt('truncate machvon.analysis_evidence')).toMatchObject({ message: expect.stringMatching(/permission denied|kept for good|kept as it was found/) });
      expect(await attempt('truncate machvon.analysis_finding')).toMatchObject({ message: expect.stringMatching(/permission denied|kept for good|kept as it was found/) });
      expect(await attempt('truncate machvon.analysis_run')).toMatchObject({ message: expect.stringMatching(/permission denied|kept for good|kept as it was found/) });
      expect(await rows('select count(*)::int as n from machvon.analysis_finding where run_id = $1::uuid', [run])).toEqual([{ n: 2 }]);
    });

    it('does not let anyone change a finding, not even the columns of a review: the decision of an expert is a row of its own (ST-BID-010)', async () => {
      const fx = await fixture();
      const run = await runOf(fx);
      const reason = 'The page shows three bridges, one of them not accepted.';
      expect(await attempt("update machvon.analysis_finding set final_status = 'CONTRADICTED', reviewer_id = $2::uuid, override_reason = $3, reviewed_at = now() where run_id = $1::uuid and criterion_id = 'C1'", [run, memberId(E1), reason])).toMatchObject({
        message: expect.stringContaining('an expert decides in a record of its own'),
      });
      expect(await attempt("update machvon.analysis_finding set override_reason = $2 where run_id = $1::uuid", [run, reason])).toMatchObject({ message: expect.stringContaining('an expert decides in a record of its own') });
      expect(await rows('select final_status, status from machvon.analysis_finding where run_id = $1::uuid and criterion_id = $2', [run, 'C1'])).toEqual([{ final_status: null, status: 'SUPPORTED' }]);
    });

    it('writes findings and evidence only while the run runs, and checks the count of verified citations when the transaction commits', async () => {
      const fx = await fixture();
      const run = await runOf(fx);
      const insertFinding = (runId: string, status: string, count: number, criterion: string) =>
        as((tx) =>
          tx.query(
            `insert into machvon.analysis_finding (tenant_id, id, run_id, criterion_id, status, finding, evidence_refs, confidence_type, evidence_count)
             values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2, $3, 'A finding.', '[]'::jsonb, 'HEURISTIC', $4::int)`,
            [runId, criterion, status, count],
          ),
        );
      expect(await failure(insertFinding(run, 'MISSING', 0, 'C9'))).toMatchObject({ message: expect.stringContaining('while its run runs') });
      const context = contextOf(await admit(fx, { criteriaVersionId: (await seedCriteria(harness, fx.seeded.packageId, { revision: 3 })).id }));
      const running = await as((tx) => store.begin(tx, context, memberId(E1)));
      // A supported finding stands on at least one citation, and the count is the number of citations found on their page.
      expect(await failure(insertFinding(running, 'SUPPORTED', 0, 'C1'))).toMatchObject({ message: expect.stringContaining('analysis_finding_evidence_chk') });
      expect(await failure(insertFinding(running, 'MISSING', 2, 'C1'))).toMatchObject({ message: expect.stringContaining('the number of its verified citations') });
      expect(await failure(insertFinding(running, 'SUPPORTED', 1, 'C1'))).toMatchObject({ message: expect.stringContaining('the number of its verified citations') });
      expect(await failure(as((tx) => tx.query("insert into machvon.analysis_evidence (tenant_id, id, finding_id, evidence_kind, calc_ref, verified_present) values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), (select id from machvon.analysis_finding where run_id = $1::uuid limit 1), 'DETERMINISTIC_CALC', '{}'::jsonb, true)", [run])))).toMatchObject({
        message: expect.stringContaining('while the run of its finding runs'),
      });
      // The flag of a missing source is only for a finding taken back to NEEDS_REVIEW.
      expect(
        await failure(
          as((tx) =>
            tx.query(
              `insert into machvon.analysis_finding (tenant_id, id, run_id, criterion_id, status, finding, evidence_refs, confidence_type, evidence_count, missing_source)
               values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, 'C1', 'MISSING', 'A finding.', '[]'::jsonb, 'HEURISTIC', 0, true)`,
              [running],
            ),
          ),
        ),
      ).toMatchObject({ message: expect.stringContaining('analysis_finding_source_chk') });
      expect(await rows('select count(*)::int as n from machvon.analysis_finding where run_id = $1::uuid', [running])).toEqual([{ n: 0 }]);
    });

    it('refuses a run that begins ended, an international route for data that is not public and a run answered without its request', async () => {
      const fx = await fixture();
      const context = contextOf(await admit(fx));
      const insert = (status: string, route: string | null) =>
        as((tx) =>
          tx.query(
            `insert into machvon.analysis_run (tenant_id, id, proposal_id, criteria_version_id, profile_version_id, input_hash, status, package_id, data_classification, prompt_version_id, document_version_set_sha256, requested_by, route_class)
             values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, repeat('9', 64), $4, $5::uuid, 'CONFIDENTIAL', $6::uuid, repeat('8', 64), $7::uuid, $8)`,
            [context.proposal.id, fx.criteria.id, fx.profile.id, status, fx.seeded.packageId, fx.profile.promptVersionId, memberId(E1), route],
          ),
        );
      expect(await failure(insert('COMPLETED', null))).toMatchObject({ message: expect.stringContaining('a run begins queued or running') });
      expect(await failure(insert('RUNNING', 'INTERNATIONAL'))).toMatchObject({ message: expect.stringContaining('analysis_run_route_chk') });
      await rows("insert into machvon.analysis_run (tenant_id, id, proposal_id, criteria_version_id, profile_version_id, input_hash, status, package_id, data_classification, prompt_version_id, document_version_set_sha256, requested_by) values ($1, gen_random_uuid(), $2, $3, $4, repeat('7', 64), 'RUNNING', $5, 'CONFIDENTIAL', $6, repeat('8', 64), $7)", [
        TENANT_A,
        context.proposal.id,
        fx.criteria.id,
        fx.profile.id,
        fx.seeded.packageId,
        fx.profile.promptVersionId,
        memberId(E1),
      ]);
      expect(await failure(rows("update machvon.analysis_run set status = 'AWAITING_REVIEW', finished_at = now() where input_hash = repeat('7', 64)"))).toMatchObject({ message: expect.stringContaining('analysis_run_answered_chk') });
    });
  });

  describe('the reads of runs and findings', () => {
    it('shows a run, its findings and their evidence to whoever has the full view of the proposal, and a run does not exist for anyone else', async () => {
      const fx = await fixture();
      const run = await runOf(fx);
      const found = await as((tx) => store.findRun(tx, run, fx.evaluator));
      expect(found).toMatchObject({ kind: 'SEEN', run: { id: run, proposalId: fx.proposal.id, packageCode: fx.seeded.packageCode, contractorName: 'NT-1', version: 2, finishedAt: expect.any(String), reviewedCount: 0 } });
      const listed = await as((tx) => store.listFindings(tx, run, {}, { limit: 10, after: undefined }));
      expect(listed.more).toBe(false);
      expect(listed.findings.map((finding) => [finding.criterionId, finding.status, finding.evidenceCount, finding.missingSource])).toEqual([
        ['C1', 'SUPPORTED', 1, false],
        ['C2', 'NEEDS_REVIEW', 0, true],
      ]);
      expect(listed.findings[0]?.evidence.map((evidence) => [evidence.verifiedPresent, evidence.pageIndex, evidence.quoteExcerpt])).toEqual([
        [true, 0, 'three bridges'],
        [false, 1, 'four bridges'],
      ]);
      expect(listed.findings[0]?.evidence[0]).toMatchObject({ kind: 'DOCUMENT', documentVersionId: fx.proposal.versionId, calcRef: null });

      expect(await as((tx) => store.findRun(tx, run, viewer(E1)))).toEqual({ kind: 'HIDDEN' });
      expect(await as((tx) => store.findRun(tx, randomUUID(), fx.evaluator))).toEqual({ kind: 'HIDDEN' });
      expect(await as((tx) => store.findRun(tx, run, viewer(E2, onProjects(fx.seeded.projectId))), E2)).toEqual({ kind: 'DECLARATION_REQUIRED' });
    });

    it('filters and pages the findings of a run', async () => {
      const fx = await fixture();
      const run = await runOf(fx);
      const page = (filter: Parameters<BidAnalysisStore['listFindings']>[2], after?: { code: string; id: string }) => as((tx) => store.listFindings(tx, run, filter, { limit: 1, after }));
      const first = await page({});
      expect(first.findings.map((finding) => finding.criterionId)).toEqual(['C1']);
      expect(first.more).toBe(true);
      const second = await page({}, first.last);
      expect(second.findings.map((finding) => finding.criterionId)).toEqual(['C2']);
      expect(second.more).toBe(false);
      expect((await page({ missingSource: true })).findings.map((finding) => finding.criterionId)).toEqual(['C2']);
      expect((await page({ missingSource: false })).findings.map((finding) => finding.criterionId)).toEqual(['C1']);
      expect((await page({ status: 'SUPPORTED' })).findings.map((finding) => finding.criterionId)).toEqual(['C1']);
      expect((await page({ status: 'MISSING' })).findings).toEqual([]);
    });

    it('lists the runs and finding summaries of the proposals the caller has the full view of, newest first, and none of the others', async () => {
      const fx = await fixture();
      const run = await runOf(fx);
      const other = await fixture();
      const otherRun = await runOf(other);
      const both = viewer(E1, onProjects(fx.seeded.projectId, other.seeded.projectId));
      const listed = await as((tx) => store.listRuns(tx, both, {}, { limit: 50, after: undefined }));
      const ids = listed.runs.map((candidate) => candidate.id);
      expect(ids.indexOf(otherRun)).toBeLessThan(ids.indexOf(run));
      expect(ids).toEqual(expect.arrayContaining([run, otherRun]));
      expect((await as((tx) => store.listRuns(tx, fx.evaluator, {}, { limit: 50, after: undefined }))).runs.map((candidate) => candidate.id)).toEqual([run]);
      expect((await as((tx) => store.listRuns(tx, fx.evaluator, { proposalId: other.proposal.id }, { limit: 50, after: undefined }))).runs).toEqual([]);
      expect((await as((tx) => store.listRuns(tx, both, { status: 'CANCELLED' }, { limit: 50, after: undefined }))).runs).toEqual([]);
      const first = await as((tx) => store.listRuns(tx, both, { proposalId: fx.proposal.id }, { limit: 1, after: undefined }));
      expect(first.runs.map((candidate) => candidate.id)).toEqual([run]);
      expect(first.more).toBe(false);
      expect((await as((tx) => store.listRuns(tx, both, { proposalId: fx.proposal.id }, { limit: 1, after: first.last }))).runs).toEqual([]);
      expect(await failure(as((tx) => store.listRuns(tx, both, {}, { limit: 1, after: { code: 'not-a-time', id: randomUUID() } })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'cursor' });

      const summaries = await as((tx) => store.listFindingSummaries(tx, fx.evaluator, {}, { limit: 50, after: undefined }));
      expect(summaries.findings.map((finding) => finding.proposalId)).toEqual([fx.proposal.id, fx.proposal.id]);
      expect((await as((tx) => store.listFindingSummaries(tx, fx.evaluator, { runId: otherRun }, { limit: 50, after: undefined }))).findings).toEqual([]);
      const firstSummary = await as((tx) => store.listFindingSummaries(tx, both, { runId: run }, { limit: 1, after: undefined }));
      expect(firstSummary.more).toBe(true);
      const nextSummary = await as((tx) => store.listFindingSummaries(tx, both, { runId: run }, { limit: 5, after: firstSummary.last }));
      expect(nextSummary.findings).toHaveLength(1);
      expect(await failure(as((tx) => store.listFindingSummaries(tx, both, {}, { limit: 1, after: { code: 'x', id: randomUUID() } })))).toMatchObject({ detail: 'cursor' });

      const [anyFinding] = summaries.findings;
      expect(await as((tx) => store.findFinding(tx, anyFinding?.id as string, fx.evaluator))).toMatchObject({ kind: 'SEEN', finding: { id: anyFinding?.id, runId: run } });
      expect(await as((tx) => store.findFinding(tx, anyFinding?.id as string, viewer(E1)))).toEqual({ kind: 'HIDDEN' });
      expect(await as((tx) => store.findFinding(tx, randomUUID(), fx.evaluator))).toEqual({ kind: 'HIDDEN' });
    });
  });

  describe('cancelling a run', () => {
    it('cancels a run that waits for the experts, with the reason, and frees its input; the run and its findings stay', async () => {
      const fx = await fixture();
      const run = await runOf(fx);
      expect(await failure(as((tx) => store.cancel(tx, run, 1, 'Wrong criteria were chosen', fx.evaluator)))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409, extensions: { current_version: 2 } });
      const done = await as((tx) => store.cancel(tx, run, 2, 'Wrong criteria were chosen', fx.evaluator));
      expect(done).toMatchObject({ previousStatus: 'AWAITING_REVIEW', run: { id: run, status: 'CANCELLED', cancelReason: 'Wrong criteria were chosen', version: 3, findingCount: 2 } });
      expect(await failure(as((tx) => store.cancel(tx, run, 3, 'Cancelled again', fx.evaluator)))).toMatchObject({ code: 'ANALYSIS_STATE_INVALID', status: 409, extensions: { run_status: 'CANCELLED' } });
      expect((await admit(fx)).kind).toBe('NEW');
    });

    it('refuses a run an expert already reviewed a finding of, and a run the caller may not see', async () => {
      const fx = await fixture();
      const run = await runOf(fx);
      const [finding] = await rows<{ id: string }>("select id from machvon.analysis_finding where run_id = $1::uuid and criterion_id = 'C1'", [run]);
      await as((tx) =>
        reviews.review(tx, { findingId: finding?.id as string, expectedVersion: 1, target: { kind: 'STATUS', status: 'SUPPORTED', score: undefined }, reason: 'The page shows three bridges, all accepted.', checkedEvidenceIds: [] }, fx.evaluator, memberId(E1)),
      );
      expect(await failure(as((tx) => store.cancel(tx, run, 2, 'Wrong criteria were chosen', fx.evaluator)))).toMatchObject({ code: 'ANALYSIS_STATE_INVALID', extensions: { run_status: 'AWAITING_REVIEW', reviewed_findings: 1 } });
      expect(await failure(as((tx) => store.cancel(tx, run, 2, 'Wrong criteria were chosen', viewer(E1))))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await failure(as((tx) => store.cancel(tx, run, 2, 'Wrong criteria were chosen', viewer(E2, onProjects(fx.seeded.projectId))), E2))).toMatchObject({ code: 'CONFLICT_UNDECLARED', status: 403 });
    });
  });

  describe('the files a question may be answered from (AC-ST-BID-009-5, UAT-AC14)', () => {
    it('are those of the proposals of the package that the caller has the full view of, and none of a contractor they are recused from', async () => {
      const fx = await fixture();
      const rival = await seedContractor(harness, { name: 'NT-2' });
      const second = await seedProposal(harness, fx.seeded, rival, { releasedAt: hoursFromNow(-1) });
      const sealed = await seedProposal(harness, fx.seeded, await seedContractor(harness), { releasedAt: hoursFromNow(48) });
      const own = fx.evaluator;
      const versionsOf = async (who: ProposalViewer, member = E1) => ((await as((tx) => store.permittedDocumentVersions(tx, fx.seeded.packageId, who), member)) ?? []).map((file) => file.documentVersionId);
      expect(await as((tx) => store.permittedDocumentVersions(tx, fx.seeded.packageId, own))).toEqual([fx.proposal.versionId, second.versionId].sort().map((documentVersionId) => ({ documentVersionId, classification: 'CONFIDENTIAL' })));
      expect(await versionsOf(own)).not.toContain(sealed.versionId);
      const made = await as((tx) => conflicts.declare(tx, { packageId: fx.seeded.packageId, hasConflict: true, relationText: 'The director of NT-2 is my cousin.', contractorId: rival }, memberId(E2), everything), E2);
      await as((tx) => conflicts.decide(tx, made.id, 1, 'ALLOWED', REASON, memberId(APPROVER), everything), APPROVER);
      const recused = viewer(E2, onProjects(fx.seeded.projectId));
      expect(await versionsOf(recused, E2)).toEqual([fx.proposal.versionId, second.versionId].sort());
      expect(await as((tx) => store.permittedDocumentVersions(tx, fx.seeded.packageId, viewer(E1)))).toBeUndefined();
      expect(await as((tx) => store.permittedDocumentVersions(tx, randomUUID(), own))).toBeUndefined();
    });

    it('leave out the proposal of the contractor the caller was recused from (page 12 of proposal B does not exist for them)', async () => {
      const fx = await fixture();
      const rival = await seedContractor(harness, { name: 'NT-B' });
      const other = await seedProposal(harness, fx.seeded, rival, { releasedAt: hoursFromNow(-1) });
      const made = await as((tx) => conflicts.declare(tx, { packageId: fx.seeded.packageId, hasConflict: true, relationText: 'The director of NT-B is my cousin.', contractorId: rival }, memberId(E2), everything), E2);
      await as((tx) => conflicts.decide(tx, made.id, 1, 'RECUSED', REASON, memberId(APPROVER), everything), APPROVER);
      const recused = viewer(E2, onProjects(fx.seeded.projectId));
      const permitted = ((await as((tx) => store.permittedDocumentVersions(tx, fx.seeded.packageId, recused), E2)) ?? []).map((file) => file.documentVersionId);
      expect(permitted).toContain(fx.proposal.versionId);
      expect(permitted).not.toContain(other.versionId);
    });
  });
});
