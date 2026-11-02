import { randomUUID } from 'node:crypto';
import { BidAnalysisStore } from '../src/bid-analysis-store';
import { BidConflictStore } from '../src/bid-conflict-store';
import type { ProposalViewer } from '../src/bid-proposal-reads';
import { BidReviewStore } from '../src/bid-review-store';
import type { ReviewTarget } from '../src/bid-review-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, contextFor, memberId } from './support/authz-fixtures';
import { seedAnalysisProfile, seedCriteria } from './support/bid-analysis-fixtures';
import { DEPARTMENT, OTHER_PROJECT_UNIT, PROVINCE, hoursFromNow, nothing, onProjects, seedAs, seedBidPackage, seedContractor, seedProposal } from './support/bid-proposal-fixtures';
import type { SeededPackage } from './support/bid-proposal-fixtures';
import { DEFAULT_SAID, seedAnalysedProposal } from './support/bid-review-fixtures';
import type { AnalysedProposal, FindingSaid } from './support/bid-review-fixtures';

const harness = new AuthzHarness();
const analysis = new BidAnalysisStore();
const reviews = new BidReviewStore();
const conflicts = new BidConflictStore();
const E1 = 2;
const E2 = 3;
const APPROVER = 4;
const REASON = 'The relation was examined and decided by the authority.';
const WHY = 'The contract of the bridge was not accepted, so the experience is not met.';

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = E1): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });
const viewer = (member: number, evaluate: ScopeBuilder = nothing): ProposalViewer => ({ membershipId: memberId(member), evaluate, receive: nothing, now: new Date() });
const rows = <R extends object>(sql: string, params: unknown[] = []) => harness.owner<R>(TENANT_A, [[sql, params]]);

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

describe('the review of the findings of an analysis and the comparison of proposals (ST-BID-010, BID 3 F6, BR-BID-03/09/10/11)', () => {
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
    criteria: { id: string };
    profile: { id: string; promptVersionId: string };
    evaluator: ProposalViewer;
  }

  /** A package with approved criteria (C1 met or not, C2 and C3 scored out of 10), a published profile, and E1 who declared that no conflict stands. */
  async function fixture(): Promise<Fixture> {
    const seeded = await seedBidPackage(harness);
    await as((tx) => conflicts.declare(tx, { packageId: seeded.packageId, hasConflict: false }, memberId(E1), everything));
    return { seeded, criteria: await seedCriteria(harness, seeded.packageId, { codes: ['C1', 'C2', 'C3'] }), profile: await seedAnalysisProfile(harness), evaluator: viewer(E1, onProjects(seeded.projectId)) };
  }

  const analysed = (fx: Fixture, name: string, criteriaId: string, said?: FindingSaid, ended?: 'AWAITING_REVIEW' | 'CANCELLED'): Promise<AnalysedProposal> =>
    seedAnalysedProposal(harness, { seeded: fx.seeded, profileId: fx.profile.id, evaluator: fx.evaluator, member: E1 }, name, criteriaId, said, ended);

  const ownedBy = (run: AnalysedProposal): string[] => [...run.findings.values()];
  const reviewRows = async (run: AnalysedProposal): Promise<number> => (await rows<{ n: number }>('select count(*)::int as n from machvon.analysis_finding_review where finding_id = any($1::uuid[])', [ownedBy(run)]))[0]?.n ?? -1;
  const recordRows = async (run: AnalysedProposal): Promise<number> => (await rows<{ n: number }>('select count(*)::int as n from machvon.ai_decision_record where subject_id = any($1::uuid[])', [ownedBy(run)]))[0]?.n ?? -1;
  const status = (value: 'SUPPORTED' | 'CONTRADICTED' | 'MISSING' | 'NEEDS_REVIEW', score?: string): ReviewTarget => ({ kind: 'STATUS', status: value, score });
  const review = (fx: Fixture, run: AnalysedProposal, code: string, version: number, target: ReviewTarget, reason = WHY, who: ProposalViewer = fx.evaluator, member = E1, evidence: string[] = []) =>
    as((tx) => reviews.review(tx, { findingId: run.findings.get(code) as string, expectedVersion: version, target, reason, checkedEvidenceIds: evidence }, who, memberId(member)), member);

  describe('the decision of an expert about a finding (AC-ST-BID-010-1, UAT-AC16, BR-BID-09)', () => {
    it('AC-ST-BID-010-1, UAT-AC16: changes SUPPORTED scored 4 to CONTRADICTED scored 2 as a decision of its own, with the record of the decision of a person, and leaves the finding as the model said it', async () => {
      const fx = await fixture();
      const run = await analysed(fx, 'NT-1', fx.criteria.id);
      const first = await review(fx, run, 'C2', 1, status('SUPPORTED', '4'));
      expect(first.review).toMatchObject({ fromStatus: 'SUPPORTED', toStatus: 'SUPPORTED', scoreBefore: null, scoreAfter: '4.00', decision: 'ACCEPTED_WITH_CHANGE', reason: WHY });
      expect(first.finding).toMatchObject({ status: 'SUPPORTED', finalStatus: 'SUPPORTED', finalScore: '4.00', reviewCount: 1, version: 2 });

      const second = await review(fx, run, 'C2', 2, status('CONTRADICTED', '2'));
      expect(second.review).toMatchObject({ fromStatus: 'SUPPORTED', toStatus: 'CONTRADICTED', scoreBefore: '4.00', scoreAfter: '2.00', decision: 'ACCEPTED_WITH_CHANGE', reason: WHY, reviewer: { id: memberId(E1) } });
      expect(second.finding).toMatchObject({ status: 'SUPPORTED', finalStatus: 'CONTRADICTED', finalScore: '2.00', reviewCount: 2, version: 3 });
      expect(second.finding.reviews.map((entry) => [entry.fromStatus, entry.toStatus, entry.scoreBefore, entry.scoreAfter])).toEqual([
        ['SUPPORTED', 'SUPPORTED', null, '4.00'],
        ['SUPPORTED', 'CONTRADICTED', '4.00', '2.00'],
      ]);

      // The record of the decision of a person about the answer of the AI is the one the review points at, written by the same transaction.
      const [record] = await rows<{ decision: string; rationale: string; subject_kind: string; subject_id: string; subject_module: string; action_kind: string; decided_by: string; ai_output_sha256: string }>(
        'select decision, rationale, subject_kind, subject_id, subject_module, action_kind, decided_by, ai_output_sha256 from machvon.ai_decision_record where id = $1::uuid',
        [second.decisionRecordId],
      );
      expect(record).toEqual({ decision: 'ACCEPTED_WITH_CHANGE', rationale: WHY, subject_kind: 'analysis_finding', subject_id: run.findings.get('C2'), subject_module: 'BID', action_kind: 'DECISION', decided_by: memberId(E1), ai_output_sha256: 'e'.repeat(64) });
      expect(await rows('select ai_decision_record_id from machvon.analysis_finding_review where id = $1::uuid', [second.review.id])).toEqual([{ ai_decision_record_id: second.decisionRecordId }]);
      // What the model said is what it said: the finding was not updated, and the run is not done while a finding has no decision.
      expect(await rows('select status, finding, final_status, reviewer_id, override_reason, reviewed_at from machvon.analysis_finding where id = $1::uuid', [run.findings.get('C2')])).toEqual([
        { status: 'SUPPORTED', finding: 'NT-1 on C2.', final_status: null, reviewer_id: null, override_reason: null, reviewed_at: null },
      ]);
      expect(second.runStatus).toBe('AWAITING_REVIEW');
    });

    it('is ACCEPTED for the status that stands and REJECTED when no conclusion is left standing; the baseline form approves or sets aside', async () => {
      const fx = await fixture();
      const run = await analysed(fx, 'NT-1', fx.criteria.id);
      expect((await review(fx, run, 'C1', 1, status('SUPPORTED'))).decision).toBe('ACCEPTED');
      expect((await review(fx, run, 'C2', 1, status('NEEDS_REVIEW'))).decision).toBe('REJECTED');
      const approved = await review(fx, run, 'C3', 1, { kind: 'FORM', form: 'approve' });
      expect(approved).toMatchObject({ decision: 'ACCEPTED', review: { fromStatus: 'MISSING', toStatus: 'MISSING' } });
      const again = await review(fx, run, 'C1', 2, { kind: 'FORM', form: 'reject' });
      expect(again).toMatchObject({ decision: 'REJECTED', review: { fromStatus: 'SUPPORTED', toStatus: 'NEEDS_REVIEW' }, finding: { finalStatus: 'NEEDS_REVIEW', version: 3 } });
      expect(await recordRows(run)).toBe(4);
    });

    it('keeps the score that stood when none is given, and refuses a score off the scale of the criterion or for a criterion that is met or not', async () => {
      const fx = await fixture();
      const run = await analysed(fx, 'NT-1', fx.criteria.id);
      await review(fx, run, 'C2', 1, status('SUPPORTED', '7.5'));
      const kept = await review(fx, run, 'C2', 2, status('SUPPORTED'));
      expect(kept.review).toMatchObject({ scoreBefore: '7.50', scoreAfter: '7.50', decision: 'ACCEPTED' });
      expect(await failure(review(fx, run, 'C2', 3, status('SUPPORTED', '10.01')))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'score_after' });
      expect(await failure(review(fx, run, 'C1', 1, status('SUPPORTED', '1')))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'score_after' });
      expect(await reviewRows(run)).toBe(2);
    });

    it('records the citations the expert checked, each of the finding, and refuses others', async () => {
      const fx = await fixture();
      const run = await analysed(fx, 'NT-1', fx.criteria.id);
      const [own] = await rows<{ id: string }>('select id from machvon.analysis_evidence where finding_id = $1::uuid', [run.findings.get('C1')]);
      const [other] = await rows<{ id: string }>('select id from machvon.analysis_evidence where finding_id = $1::uuid', [run.findings.get('C2')]);
      const own1 = own?.id as string;
      expect(await failure(review(fx, run, 'C1', 1, { kind: 'FORM', form: 'approve' }, WHY, fx.evaluator, E1, [other?.id as string]))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'evidence_ids' });
      expect(await failure(review(fx, run, 'C1', 1, { kind: 'FORM', form: 'approve' }, WHY, fx.evaluator, E1, Array.from({ length: 21 }, () => randomUUID())))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'evidence_ids' });
      const done = await review(fx, run, 'C1', 1, { kind: 'FORM', form: 'approve' }, WHY, fx.evaluator, E1, [own1, own1.toUpperCase()]);
      expect(done.review.checkedEvidenceIds).toEqual([own1]);
    });

    it('refuses a version that is not the current one, naming the current one, and lets one of two experts who decide at once win', async () => {
      const fx = await fixture();
      const run = await analysed(fx, 'NT-1', fx.criteria.id);
      await review(fx, run, 'C1', 1, status('SUPPORTED'));
      expect(await failure(review(fx, run, 'C1', 1, status('CONTRADICTED')))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409, extensions: { current_version: 2 } });
      const outcomes = await Promise.allSettled([review(fx, run, 'C3', 1, status('SUPPORTED')), review(fx, run, 'C3', 1, status('CONTRADICTED'))]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === 'rejected').map((outcome) => (outcome as PromiseRejectedResult).reason)).toEqual([expect.objectContaining({ code: 'VERSION_CONFLICT' })]);
      expect(await rows('select count(*)::int as n from machvon.analysis_finding_review where finding_id = $1::uuid', [run.findings.get('C3')])).toEqual([{ n: 1 }]);
    });

    it('serialises the decisions of one proposal: a second expert waits for the first to commit and then meets the version conflict', async () => {
      const fx = await fixture();
      const run = await analysed(fx, 'NT-1', fx.criteria.id);
      let second: Promise<unknown> | undefined;
      let secondDone = false;
      await as(async (tx) => {
        await reviews.review(tx, { findingId: run.findings.get('C3') as string, expectedVersion: 1, target: status('SUPPORTED'), reason: WHY, checkedEvidenceIds: [] }, fx.evaluator, memberId(E1));
        second = review(fx, run, 'C3', 1, status('CONTRADICTED')).finally(() => {
          secondDone = true;
        });
        // The second decision is either blocked on the lock of the proposal or it is through; it must be the first.
        for (;;) {
          const blocked = await rows<{ n: number }>("select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted");
          if (secondDone || (blocked[0]?.n ?? 0) > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(secondDone).toBe(false);
      });
      expect(await failure(second as Promise<unknown>)).toMatchObject({ code: 'VERSION_CONFLICT', extensions: { current_version: 2 } });
      expect(await reviewRows(run)).toBe(1);
    });

    it('is not a decision of someone who only receives the proposals: the clerk sees what it is and nothing of what it says (BR-BID-03)', async () => {
      const fx = await fixture();
      const run = await analysed(fx, 'NT-1', fx.criteria.id);
      const clerk: ProposalViewer = { membershipId: memberId(E1), evaluate: nothing, receive: onProjects(fx.seeded.projectId), now: new Date() };
      expect(await failure(review(fx, run, 'C1', 1, status('SUPPORTED'), WHY, clerk))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await reviewRows(run)).toBe(0);
    });

    it('is a decision of a member of the evaluation team with the full view, who is not in conflict (BR-BID-03)', async () => {
      const fx = await fixture();
      const run = await analysed(fx, 'NT-1', fx.criteria.id);
      expect(await failure(review(fx, run, 'C1', 1, status('SUPPORTED'), WHY, viewer(E1)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await failure(as((tx) => reviews.review(tx, { findingId: randomUUID(), expectedVersion: 1, target: status('SUPPORTED'), reason: WHY, checkedEvidenceIds: [] }, fx.evaluator, memberId(E1))))).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      const owes = viewer(E2, onProjects(fx.seeded.projectId));
      expect(await failure(review(fx, run, 'C1', 1, status('SUPPORTED'), WHY, owes, E2))).toMatchObject({ code: 'CONFLICT_UNDECLARED', status: 403 });
      const made = await as((tx) => conflicts.declare(tx, { packageId: fx.seeded.packageId, hasConflict: true, relationText: 'The director of NT-1 is my cousin.', contractorId: run.contractorId }, memberId(E2), everything), E2);
      await as((tx) => conflicts.decide(tx, made.id, 1, 'RECUSED', REASON, memberId(APPROVER), everything), APPROVER);
      expect(await failure(review(fx, run, 'C1', 1, status('SUPPORTED'), WHY, owes, E2))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await reviewRows(run)).toBe(0);
      expect(await recordRows(run)).toBe(0);
    });

    it('is a decision about a run that waits for the experts or has all of them decided, and the run is COMPLETED with the last one', async () => {
      const fx = await fixture();
      const cancelled = await analysed(fx, 'NT-1', fx.criteria.id, DEFAULT_SAID, 'CANCELLED');
      expect(await failure(review(fx, cancelled, 'C1', 1, status('SUPPORTED')))).toMatchObject({ code: 'RUN_NOT_COMPLETED', status: 422, extensions: { run_status: 'CANCELLED' } });

      const run = await analysed(fx, 'NT-2', fx.criteria.id);
      expect((await review(fx, run, 'C1', 1, status('SUPPORTED'))).runStatus).toBe('AWAITING_REVIEW');
      expect((await review(fx, run, 'C2', 1, status('SUPPORTED', '8'))).runStatus).toBe('AWAITING_REVIEW');
      const last = await review(fx, run, 'C3', 1, status('MISSING'));
      expect(last.runStatus).toBe('COMPLETED');
      expect(await rows('select status, version::int as version from machvon.analysis_run where id = $1::uuid', [run.runId])).toEqual([{ status: 'COMPLETED', version: 3 }]);
      // A decision can be changed afterwards: it is a new row, and the run stays done.
      const changed = await review(fx, run, 'C1', 2, status('CONTRADICTED'));
      expect(changed).toMatchObject({ runStatus: 'COMPLETED', finding: { finalStatus: 'CONTRADICTED', reviewCount: 2 } });
      expect(await failure(as((tx) => analysis.cancel(tx, run.runId, 3, 'Wrong criteria were chosen', fx.evaluator)))).toMatchObject({ code: 'ANALYSIS_STATE_INVALID', extensions: { run_status: 'COMPLETED', reviewed_findings: 3 } });
    });

    it('is not partly done: a decision that fails to commit leaves neither the row nor the record of the decision', async () => {
      const fx = await fixture();
      const run = await analysed(fx, 'NT-1', fx.criteria.id);
      const attempt = as(async (tx) => {
        await reviews.review(tx, { findingId: run.findings.get('C1') as string, expectedVersion: 1, target: status('SUPPORTED'), reason: WHY, checkedEvidenceIds: [] }, fx.evaluator, memberId(E1));
        throw new Error('the command failed after the decision');
      });
      expect(await failure(attempt)).toMatchObject({ message: 'the command failed after the decision' });
      expect(await reviewRows(run)).toBe(0);
      expect(await recordRows(run)).toBe(0);
    });

    it('is read with the findings of the run, with who decided and the history, and by the reads of the finding and of the run', async () => {
      const fx = await fixture();
      const run = await analysed(fx, 'NT-1', fx.criteria.id);
      await review(fx, run, 'C2', 1, status('CONTRADICTED', '2'));
      const listed = await as((tx) => analysis.listFindings(tx, run.runId, {}, { limit: 10, after: undefined }));
      const c2 = listed.findings.find((finding) => finding.criterionId === 'C2');
      expect(c2).toMatchObject({ status: 'SUPPORTED', finalStatus: 'CONTRADICTED', finalScore: '2.00', reviewCount: 1, version: 2 });
      expect(c2?.reviews).toHaveLength(1);
      expect(listed.findings.find((finding) => finding.criterionId === 'C1')).toMatchObject({ finalStatus: null, finalScore: null, reviewedAt: null, reviews: [], version: 1 });
      const seen = await as((tx) => analysis.findFinding(tx, run.findings.get('C2') as string, fx.evaluator));
      expect(seen).toMatchObject({ kind: 'SEEN', finding: { finalStatus: 'CONTRADICTED', version: 2, reviews: [] } });
      const summaries = await as((tx) => analysis.listFindingSummaries(tx, fx.evaluator, { runId: run.runId }, { limit: 10, after: undefined }));
      expect(summaries.findings.map((finding) => [finding.criterionId, finding.finalStatus]).sort()).toEqual([
        ['C1', null],
        ['C2', 'CONTRADICTED'],
        ['C3', null],
      ]);
      const found = await as((tx) => analysis.findRun(tx, run.runId, fx.evaluator));
      expect(found).toMatchObject({ kind: 'SEEN', run: { reviewedCount: 1 } });
    });
  });

  describe('what the database keeps from being rewritten (BR-BID-09)', () => {
    const attempt = (sql: string, params: unknown[] = []) => failure(as((tx) => tx.query(sql, params)));

    it('keeps a decision as it was made: no update, no delete, no truncate; and refuses a decision for a run that does not wait for the experts', async () => {
      const fx = await fixture();
      const run = await analysed(fx, 'NT-1', fx.criteria.id);
      const done = await review(fx, run, 'C1', 1, status('SUPPORTED'));
      expect(await attempt("update machvon.analysis_finding_review set reason = 'Rewritten after the fact by someone.' where id = $1::uuid", [done.review.id])).toMatchObject({ message: expect.stringMatching(/permission denied|kept as it was made/) });
      expect(await attempt('delete from machvon.analysis_finding_review where id = $1::uuid', [done.review.id])).toMatchObject({ message: expect.stringMatching(/permission denied|kept as it was made/) });
      expect(await attempt('truncate machvon.analysis_finding_review')).toMatchObject({ message: expect.stringMatching(/permission denied|kept as it was made/) });
      expect(await attempt("update machvon.ai_decision_record set decision = 'REJECTED' where id = $1::uuid", [done.decisionRecordId])).toMatchObject({ message: expect.stringContaining('not changed') });

      const cancelled = await analysed(fx, 'NT-2', fx.criteria.id, DEFAULT_SAID, 'CANCELLED');
      const insert = (findingId: string, recordId: string, extra = '') =>
        as((tx) =>
          tx.query(
            `insert into machvon.analysis_finding_review (tenant_id, id, finding_id, reviewer_user_id, from_status, to_status, reason, decision, ai_decision_record_id${extra === '' ? '' : ', checked_evidence_ids'})
             values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, 'SUPPORTED', 'MISSING', $3, 'ACCEPTED_WITH_CHANGE', $4::uuid${extra === '' ? '' : `, ${extra}::jsonb`})`,
            [findingId, memberId(E1), WHY, recordId],
          ),
        );
      expect(await failure(insert(cancelled.findings.get('C1') as string, done.decisionRecordId))).toMatchObject({ message: expect.stringContaining('when its run waits for the experts') });
      // The same row for a finding of a run that waits is written, so the refusal above is the state of the run and not the shape of the row.
      await insert(run.findings.get('C3') as string, done.decisionRecordId);
      expect(await rows('select count(*)::int as n from machvon.analysis_finding_review where finding_id = $1::uuid', [run.findings.get('C3')])).toEqual([{ n: 1 }]);
    });

    it('refuses a decision that is not whole: a reason of under twenty characters, no record of the decision of a person, a score below zero, a decision that is not one', async () => {
      const fx = await fixture();
      const run = await analysed(fx, 'NT-1', fx.criteria.id);
      const done = await review(fx, run, 'C1', 1, status('SUPPORTED'));
      const base = (columns: string, values: string) =>
        as((tx) =>
          tx.query(
            `insert into machvon.analysis_finding_review (tenant_id, id, finding_id, reviewer_user_id, from_status, to_status, ${columns})
             values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, 'SUPPORTED', 'MISSING', ${values})`,
            values.includes('$3') ? [run.findings.get('C2'), memberId(E1), done.decisionRecordId] : [run.findings.get('C2'), memberId(E1)],
          ),
        );
      expect(await failure(base('reason, decision, ai_decision_record_id', "'short', 'ACCEPTED_WITH_CHANGE', $3::uuid"))).toMatchObject({ message: expect.stringContaining('analysis_finding_review_reason_check') });
      expect(await failure(base('reason, decision', "'The contract of the bridge was not accepted.', 'ACCEPTED_WITH_CHANGE'"))).toMatchObject({ message: expect.stringContaining('analysis_finding_review_record_chk') });
      expect(await failure(base('reason, decision, ai_decision_record_id, score_after', "'The contract of the bridge was not accepted.', 'ACCEPTED_WITH_CHANGE', $3::uuid, -1"))).toMatchObject({
        message: expect.stringContaining('analysis_finding_review_score_chk'),
      });
      expect(await failure(base('reason, decision, ai_decision_record_id', "'The contract of the bridge was not accepted.', 'APPROVED', $3::uuid"))).toMatchObject({ message: expect.stringContaining('analysis_finding_review_decision_chk') });
      expect(await failure(base('reason, ai_decision_record_id', "'The contract of the bridge was not accepted.', $3::uuid"))).toMatchObject({ message: expect.stringContaining('analysis_finding_review_decision_chk') });
    });
  });

  describe('the comparison of proposals on one version of the criteria (AC-ST-BID-010-2, UAT-AC17, BR-BID-10/11)', () => {
    /** CV-1 is approved and A is analysed on it, then CV-2 supersedes it and B is analysed on that. */
    async function twoVersions(fx: Fixture): Promise<{ cv1: string; cv2: string; a: AnalysedProposal; b: AnalysedProposal }> {
      const a = await analysed(fx, 'NT-A', fx.criteria.id);
      const next = await seedCriteria(harness, fx.seeded.packageId, { revision: 2, codes: ['C1', 'C2', 'C3'] });
      const b = await analysed(fx, 'NT-B', next.id);
      return { cv1: fx.criteria.id, cv2: next.id, a, b };
    }
    const compare = (fx: Fixture, version?: string, who: ProposalViewer = fx.evaluator, member = E1) => as((tx) => reviews.compare(tx, fx.seeded.packageId, version, who), member);

    it('AC-ST-BID-010-2, UAT-AC17: compares only the proposals analysed on the criteria asked for, excludes the other as CRITERIA_VERSION_MISMATCH and lists the attributes it never looks at', async () => {
      const fx = await fixture();
      const { cv1, cv2, a, b } = await twoVersions(fx);
      const read = await compare(fx, cv2);
      expect(read?.package.id).toBe(fx.seeded.packageId);
      expect(read?.criteriaStatus).toBe('APPROVED');
      expect(read?.comparison.criteriaVersionId).toBe(cv2);
      expect(read?.comparison.proposals.map((proposal) => proposal.proposalId)).toEqual([b.proposalId]);
      expect(read?.comparison.excluded).toEqual([{ proposalId: a.proposalId, contractor: { id: a.contractorId, name: 'NT-A' }, runId: a.runId, criteriaVersionId: cv1, reason: 'CRITERIA_VERSION_MISMATCH' }]);
      expect(read?.comparison.excludedAttributes).toEqual(expect.arrayContaining(['GENDER', 'ETHNICITY', 'RELIGION', 'MARITAL_STATUS', 'AGE', 'ORIGIN', 'LOCAL_PRESENCE']));
      // Asking for the other version swaps them; the default is the version in force.
      expect((await compare(fx, cv1))?.comparison.proposals.map((proposal) => proposal.proposalId)).toEqual([a.proposalId]);
      expect((await compare(fx))?.comparison.criteriaVersionId).toBe(cv2);
    });

    it('holds only what an expert decided: a finding the model supported and nobody decided is an undecided cell', async () => {
      const fx = await fixture();
      const { cv2, b } = await twoVersions(fx);
      await review(fx, b, 'C2', 1, status('CONTRADICTED', '3'));
      await review(fx, b, 'C1', 1, status('CONTRADICTED'));
      const read = (await compare(fx, cv2))?.comparison;
      const cells = new Map(read?.rows.map((row) => [row.criterion.code, row.cells[0]] as const));
      expect(cells.get('C1')).toMatchObject({ findingId: b.findings.get('C1'), risk: 'MANDATORY_NOT_MET', decided: { status: 'CONTRADICTED', score: null, decision: 'ACCEPTED_WITH_CHANGE' } });
      expect(cells.get('C2')).toMatchObject({ risk: 'ATTENTION', decided: { status: 'CONTRADICTED', score: '3.00' } });
      expect(cells.get('C3')).toEqual({ proposalId: b.proposalId, findingId: b.findings.get('C3'), decided: null, risk: 'UNDECIDED' });
      expect(read?.proposals[0]).toMatchObject({ criteriaCount: 3, decidedCount: 2, mandatoryNotMet: 1, weightedScore: null });
    });

    it('computes the weighted score only from the scores the experts gave, once every scored criterion has one', async () => {
      const fx = await fixture();
      const { cv2, b } = await twoVersions(fx);
      await review(fx, b, 'C2', 1, status('SUPPORTED', '5'));
      await review(fx, b, 'C3', 1, status('SUPPORTED', '10'));
      expect((await compare(fx, cv2))?.comparison.proposals[0]?.weightedScore).toBe('60.00');
    });

    it('shows a proposal with no analysis as excluded for that, and leaves out one of a contractor the caller is recused from, and one that is not released', async () => {
      const fx = await fixture();
      const { cv2, a, b } = await twoVersions(fx);
      const quiet = await seedContractor(harness, { name: 'NT-C' });
      const none = await seedProposal(harness, fx.seeded, quiet, { releasedAt: hoursFromNow(-1) });
      const sealed = await seedProposal(harness, fx.seeded, await seedContractor(harness, { name: 'NT-D' }), { releasedAt: hoursFromNow(48) });
      const read = await compare(fx, cv2);
      expect(read?.comparison.excluded.map((entry) => [entry.contractor.name, entry.reason])).toEqual([
        ['NT-A', 'CRITERIA_VERSION_MISMATCH'],
        ['NT-C', 'NO_ANALYSIS_RUN'],
      ]);
      expect(read?.comparison.excluded.find((entry) => entry.proposalId === none.id)).toMatchObject({ runId: null, criteriaVersionId: null });
      expect([...(read?.comparison.excluded ?? []), ...(read?.comparison.proposals ?? [])].some((entry) => entry.proposalId === sealed.id)).toBe(false);

      const recused = viewer(E2, onProjects(fx.seeded.projectId));
      expect(await failure(compare(fx, cv2, recused, E2))).toMatchObject({ code: 'CONFLICT_UNDECLARED', status: 403 });
      const made = await as((tx) => conflicts.declare(tx, { packageId: fx.seeded.packageId, hasConflict: true, relationText: 'The director of NT-A is my cousin.', contractorId: a.contractorId }, memberId(E2), everything), E2);
      await as((tx) => conflicts.decide(tx, made.id, 1, 'RECUSED', REASON, memberId(APPROVER), everything), APPROVER);
      const limited = await compare(fx, cv2, recused, E2);
      expect(limited?.comparison.proposals.map((proposal) => proposal.proposalId)).toEqual([b.proposalId]);
      expect(limited?.comparison.excluded.map((entry) => entry.proposalId)).toEqual([none.id]);
    });

    it('reads every live proposal of a package however many replaced revisions the records of the package hold', async () => {
      const fx = await fixture();
      const a = await analysed(fx, 'NT-A', fx.criteria.id);
      const old = await seedContractor(harness, { name: 'AAA-OLD' });
      await seedAs(harness, [
        [
          `insert into machvon.proposal (tenant_id, id, project_id, package_id, contractor_id, document_version_ids, revision, status, submitted_at, bid_price_vnd, access_released_at, classification, created_by, version)
           select $1, gen_random_uuid(), $2, $3, $4, '[]'::jsonb, n, 'SUPERSEDED', now(), 1, now() - interval '1 hour', 'CONFIDENTIAL', $5, 1 from generate_series(1, 600) as n`,
          [TENANT_A, fx.seeded.projectId, fx.seeded.packageId, old, memberId(1)],
        ],
      ]);
      const read = await compare(fx, fx.criteria.id);
      expect(read?.comparison.proposals.map((proposal) => proposal.proposalId)).toEqual([a.proposalId]);
    });

    it('compares the analysis that stands: a run that was cancelled leaves its proposal with no analysis', async () => {
      const fx = await fixture();
      const gone = await analysed(fx, 'NT-X', fx.criteria.id, DEFAULT_SAID, 'CANCELLED');
      const read = await compare(fx, fx.criteria.id);
      expect(read?.comparison.proposals).toEqual([]);
      expect(read?.comparison.excluded).toEqual([{ proposalId: gone.proposalId, contractor: { id: gone.contractorId, name: 'NT-X' }, runId: null, criteriaVersionId: null, reason: 'NO_ANALYSIS_RUN' }]);
    });

    it('does not exist for a caller who does not evaluate the project, and refuses a version that is not the package or is not there', async () => {
      const fx = await fixture();
      const { cv2 } = await twoVersions(fx);
      expect(await compare(fx, cv2, viewer(E1))).toBeUndefined();
      expect(await as((tx) => reviews.compare(tx, randomUUID(), undefined, fx.evaluator))).toBeUndefined();
      const other = await seedBidPackage(harness);
      const foreign = await seedCriteria(harness, other.packageId);
      expect(await failure(compare(fx, foreign.id))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'criteria_version_id' });
      expect(await failure(compare(fx, randomUUID()))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404, detail: 'criteria_version_id' });
      const bare = await seedBidPackage(harness);
      await as((tx) => conflicts.declare(tx, { packageId: bare.packageId, hasConflict: false }, memberId(E1), everything));
      expect(await failure(as((tx) => reviews.compare(tx, bare.packageId, undefined, viewer(E1, onProjects(bare.projectId)))))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', detail: 'criteria_version_id' });
    });

    it('leaves out a criterion whose text falls under a rule of the criteria nobody may ask for, and names it (BR-BID-11)', async () => {
      const fx = await fixture();
      const legacy = await seedCriteria(harness, fx.seeded.packageId, { revision: 2, codes: ['C1', 'C2', 'C3'], names: { C3: 'Gender of the legal representative' } });
      const run = await analysed(fx, 'NT-A', legacy.id);
      const read = await compare(fx, legacy.id);
      expect(read?.comparison.rows.map((row) => row.criterion.code)).toEqual(['C1', 'C2']);
      expect(read?.comparison.excludedCriteria).toEqual([{ code: 'C3', rule: 'GENDER' }]);
      expect(read?.comparison.proposals[0]).toMatchObject({ proposalId: run.proposalId, criteriaCount: 2 });
    });
  });
});
