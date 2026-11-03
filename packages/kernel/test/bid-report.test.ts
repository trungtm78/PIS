import type { DomainError } from '../src/errors';
import {
  EVALUATION_REPORT_SOURCE_MODULE,
  EVALUATION_REPORT_STATUSES,
  EVALUATION_REPORT_TEMPLATE_CODE,
  EVALUATION_REPORT_TRANSITIONS,
  FROZEN_REPORT_STATUSES,
  MAX_CONCLUSION,
  MAX_DISSENT,
  MAX_REPORT_RUNS,
  MIN_CONCLUSION,
  MIN_DISSENT,
  assertReportDraft,
  assertEvaluationReportState,
  decisionsDigest,
  evaluationQuorum,
  evaluationReportPayload,
  evaluationReportSourceRef,
  parseEvaluationReportSourceRef,
  reportConclusionOf,
  reportDissentOf,
  reportRunIdsOf,
  reportSummary,
  signerIds,
} from '../src/bid-report';
import type { DecisionLine } from '../src/bid-report';
import { compareProposals } from '../src/bid-review';
import type { ComparisonCriterion, ComparisonRunInput } from '../src/bid-review';

function refusal(work: () => unknown): DomainError {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
}

const ID_A = '00000000-0000-4000-8000-00000000000a';
const ID_B = '00000000-0000-4000-8000-00000000000b';
const ID_C = '00000000-0000-4000-8000-00000000000c';

describe('the evaluation report and its sign-off (ST-BID-012)', () => {
  it('names the statuses, the edges of BID 4, the frozen ones and the limits of the words', () => {
    expect(EVALUATION_REPORT_STATUSES).toEqual(['DRAFT', 'SIGNED_OFF', 'ISSUE_REQUESTED', 'ISSUED', 'SUPERSEDED']);
    expect(EVALUATION_REPORT_TRANSITIONS).toEqual([
      ['DRAFT', 'SIGNED_OFF'],
      ['SIGNED_OFF', 'DRAFT'],
      ['SIGNED_OFF', 'ISSUE_REQUESTED'],
      ['ISSUE_REQUESTED', 'ISSUED'],
      ['ISSUE_REQUESTED', 'SIGNED_OFF'],
      ['ISSUED', 'SUPERSEDED'],
    ]);
    expect(FROZEN_REPORT_STATUSES).toEqual(['ISSUE_REQUESTED', 'ISSUED', 'SUPERSEDED']);
    expect([MIN_CONCLUSION, MAX_CONCLUSION, MIN_DISSENT, MAX_DISSENT, MAX_REPORT_RUNS]).toEqual([20, 8000, 20, 4000, 500]);
    expect([EVALUATION_REPORT_SOURCE_MODULE, EVALUATION_REPORT_TEMPLATE_CODE]).toEqual(['BID', 'BID-BB-DANH-GIA-HSDT']);
  });

  describe('how DOC names a report', () => {
    it('writes the reference in lower case and reads back only what it wrote', () => {
      const ref = evaluationReportSourceRef(ID_A.toUpperCase());
      expect(ref).toBe(`BID:evaluation_report:${ID_A}`);
      expect(parseEvaluationReportSourceRef(ref)).toEqual({ id: ID_A });
      for (const value of [undefined, 7, '', `MNE:evaluation_report:${ID_A}`, `BID:evaluation_report:${ID_A}:r1`, 'BID:evaluation_report:not-an-id']) expect(parseEvaluationReportSourceRef(value)).toBeUndefined();
    });
  });

  describe('the words a person gives', () => {
    it('keeps the conclusion trimmed and refuses one that is missing, short, long or sits beside a member that is not part of the summary, with 422 VALIDATION_FAILED on summary', () => {
      expect(reportConclusionOf({ conclusion: '  The team finds proposal A the better one.  ' })).toBe('The team finds proposal A the better one.');
      expect(reportConclusionOf({ conclusion: 'x'.repeat(20) })).toHaveLength(20);
      expect(reportConclusionOf({ conclusion: 'x'.repeat(8000) })).toHaveLength(8000);
      for (const value of [undefined, null, 'text', [], {}, { conclusion: 7 }, { conclusion: ' short ' }, { conclusion: 'x'.repeat(19) }, { conclusion: 'x'.repeat(8001) }, { conclusion: 'x'.repeat(30), extra: 1 }]) {
        expect(refusal(() => reportConclusionOf(value))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'summary' });
      }
    });

    it('takes no dissent as none, keeps one trimmed and refuses an empty, short or long one with 422 VALIDATION_FAILED on dissent', () => {
      expect(reportDissentOf(undefined)).toBeNull();
      expect(reportDissentOf(null)).toBeNull();
      expect(reportDissentOf('  I do not agree with the score of criterion C2.  ')).toBe('I do not agree with the score of criterion C2.');
      expect(reportDissentOf('x'.repeat(20))).toHaveLength(20);
      expect(reportDissentOf('x'.repeat(4000))).toHaveLength(4000);
      for (const value of ['', '          ', 'x'.repeat(19), 'x'.repeat(4001), 7, {}]) {
        expect(refusal(() => reportDissentOf(value))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'dissent' });
      }
    });

    it('takes the runs as ids named once, in order, and refuses none, too many, a repeat or something that is not an id with 422 VALIDATION_FAILED on run_ids', () => {
      expect(reportRunIdsOf([ID_C.toUpperCase(), ID_A])).toEqual([ID_A, ID_C]);
      const many = Array.from({ length: 500 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
      expect(reportRunIdsOf(many)).toHaveLength(500);
      for (const value of [undefined, 'x', [], [ID_A, ID_A], [ID_A, 'nope'], [ID_A, 7], [...many, ID_A]]) {
        expect(refusal(() => reportRunIdsOf(value))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'run_ids' });
      }
    });
  });

  describe('the road of a report', () => {
    it('is signed only while a draft, and says which state refused it with 409 REPORT_STATE_INVALID', () => {
      expect(() => assertReportDraft('DRAFT')).not.toThrow();
      for (const status of ['SIGNED_OFF', 'ISSUE_REQUESTED', 'ISSUED', 'SUPERSEDED'] as const) {
        expect(refusal(() => assertReportDraft(status))).toMatchObject({ code: 'REPORT_STATE_INVALID', status: 409, extensions: { report_status: status } });
      }
    });
  });

  describe('the states an action starts from', () => {
    it('lets an action start from the states it names and refuses the others with the state in the problem', () => {
      expect(() => assertEvaluationReportState('ISSUE_REQUESTED', ['ISSUE_REQUESTED'])).not.toThrow();
      expect(refusal(() => assertEvaluationReportState('ISSUED', ['ISSUE_REQUESTED']))).toMatchObject({ code: 'REPORT_STATE_INVALID', status: 409, extensions: { report_status: 'ISSUED' } });
    });
  });

  describe('who has still to sign', () => {
    const team = [
      { membershipId: ID_A, standing: 'CLEAR' as const },
      { membershipId: ID_B, standing: 'ALLOWED' as const },
      { membershipId: ID_C, standing: 'CLEAR' as const },
    ];

    it('is complete when every member of the team has signed and waits for the others otherwise', () => {
      expect(evaluationQuorum(team, [ID_A, ID_B])).toMatchObject({ complete: false, awaiting: [{ membershipId: ID_C }] });
      expect(evaluationQuorum(team, [ID_A, ID_B, ID_C.toUpperCase()])).toMatchObject({ complete: true, awaiting: [] });
      expect(evaluationQuorum(team, [])).toMatchObject({ complete: false });
    });

    it('does not wait for a member a decision on a conflict shut out, and waits for one who has not declared or whose conflict is not decided', () => {
      const shut = [{ membershipId: ID_A, standing: 'CLEAR' as const }, { membershipId: ID_B, standing: 'RECUSED' as const }, { membershipId: ID_C, standing: 'BLOCKED' as const }];
      expect(evaluationQuorum(shut, [ID_A])).toMatchObject({ complete: true, required: [{ membershipId: ID_A }] });
      const waiting = [{ membershipId: ID_A, standing: 'CLEAR' as const }, { membershipId: ID_B, standing: 'UNDECLARED' as const }, { membershipId: ID_C, standing: 'PENDING' as const }];
      expect(evaluationQuorum(waiting, [ID_A])).toMatchObject({ complete: false, awaiting: [{ membershipId: ID_B }, { membershipId: ID_C }] });
    });

    it('is never complete for a team with nobody to sign', () => {
      expect(evaluationQuorum([], [ID_A]).complete).toBe(false);
      expect(evaluationQuorum([{ membershipId: ID_A, standing: 'RECUSED' }], [ID_A]).complete).toBe(false);
    });

    it('reads a signature as a membership id or as an object that names it, and ignores anything else', () => {
      expect(signerIds([ID_A.toUpperCase(), { membership_id: ID_B, signed_at: '2026-11-13T01:00:00Z' }, 7, null, {}, { membership_id: 5 }])).toEqual([ID_A, ID_B]);
    });
  });

  describe('the digest of the decisions', () => {
    const line = (over: Partial<DecisionLine> = {}): DecisionLine => ({ findingId: ID_A, runId: ID_B, status: 'SUPPORTED', score: '8', decision: 'ACCEPTED', decidedAt: '2026-11-13T01:00:00.000Z', ...over });

    it('does not depend on the order of the lines, and changes with any status, score, decision, moment or finding', () => {
      const one = line();
      const two = line({ findingId: ID_C });
      expect(decisionsDigest([one, two])).toBe(decisionsDigest([two, one]));
      expect(decisionsDigest([one, two])).toMatch(/^[0-9a-f]{64}$/);
      for (const changed of [{ status: 'MISSING' as const }, { score: '9' }, { score: null }, { decision: 'REJECTED' }, { decidedAt: '2026-11-13T01:00:00.001Z' }, { runId: ID_C }]) {
        expect(decisionsDigest([line(changed), two])).not.toBe(decisionsDigest([one, two]));
      }
      expect(decisionsDigest([one])).not.toBe(decisionsDigest([one, two]));
    });
  });

  describe('the content of a report', () => {
    const criteria: ComparisonCriterion[] = [
      { code: 'C1', name: 'Experience', kind: 'SCORED', weight: 60, maxScore: 10, threshold: 5, mandatory: true, prohibitedRule: null },
      { code: 'C2', name: 'Licence', kind: 'MET_OR_NOT', weight: null, maxScore: null, threshold: null, mandatory: true, prohibitedRule: null },
    ];
    const run = (proposalId: string, name: string, runId: string, c1: string | null, c2: 'SUPPORTED' | 'MISSING' | null): ComparisonRunInput => ({
      proposalId,
      contractor: { id: `contractor-${proposalId}`, name },
      run: { id: runId, status: 'COMPLETED', criteriaVersionId: ID_C },
      findings: [
        { findingId: `${proposalId}-1`, criterionCode: 'C1', decided: c1 === null ? null : { findingId: `${proposalId}-1`, status: 'SUPPORTED', score: c1, decision: 'ACCEPTED', decidedAt: '2026-11-13T01:00:00.000Z' } },
        { findingId: `${proposalId}-2`, criterionCode: 'C2', decided: c2 === null ? null : { findingId: `${proposalId}-2`, status: c2, score: null, decision: c2 === 'MISSING' ? 'ACCEPTED_WITH_CHANGE' : 'ACCEPTED', decidedAt: '2026-11-13T02:00:00.000Z' } },
      ],
    });
    const comparison = compareProposals({
      criteriaVersionId: ID_C,
      criteria,
      runs: [run('p-b', 'Beta Builders', 'run-b', '4', 'MISSING'), run('p-a', 'Alpha Builders', 'run-a', '9', 'SUPPORTED')],
      excludedAttributes: ['GENDER'],
    });
    const summary = reportSummary({
      conclusion: 'Alpha meets every mandatory criterion; Beta lacks the licence.',
      pack: { id: ID_A, code: 'G-01' },
      comparison,
      notSelected: [{ proposalId: 'p-z', contractor: { id: 'contractor-p-z', name: 'Zeta Builders' } }],
      decisionsSha256: 'a'.repeat(64),
    });

    it('freezes the comparison of the chosen runs cell by cell, names the proposals left out and says nothing of a winner', () => {
      expect(summary).toMatchObject({ conclusion: expect.stringContaining('Alpha meets'), package: { id: ID_A, code: 'G-01' }, criteria_version_id: ID_C, decisions_sha256: 'a'.repeat(64) });
      expect(summary.proposals.map((proposal) => [proposal.contractor.legal_name, proposal.weighted_score, proposal.mandatory_not_met])).toEqual([
        ['Alpha Builders', '54.00', 0],
        ['Beta Builders', '24.00', 2],
      ]);
      expect(summary.rows[1]?.cells.map((cell) => [cell.proposal_id, cell.decided?.status, cell.risk])).toEqual([
        ['p-a', 'SUPPORTED', 'NONE'],
        ['p-b', 'MISSING', 'MANDATORY_NOT_MET'],
      ]);
      expect(summary.not_covered).toEqual([{ proposal_id: 'p-z', contractor: { id: 'contractor-p-z', legal_name: 'Zeta Builders' }, reason: 'NOT_SELECTED' }]);
      expect(summary.excluded_attributes).toEqual(['GENDER']);
      expect(Object.keys(summary)).not.toContain('winner');
      expect(Object.keys(summary)).not.toContain('ranking');
    });

    it('names the proposals the comparison left out for their analysis, next to the ones nobody chose, in the order of the names of the contractors', () => {
      const withLeft = reportSummary({
        conclusion: 'x'.repeat(20),
        pack: { id: ID_A, code: 'G-01' },
        comparison: compareProposals({
          criteriaVersionId: ID_C,
          criteria,
          runs: [
            { proposalId: 'p-m', contractor: { id: 'c-m', name: 'Mid' }, run: { id: 'run-m', status: 'COMPLETED', criteriaVersionId: ID_A }, findings: [] },
            { proposalId: 'p-n', contractor: { id: 'c-n', name: 'Alpha' }, run: null, findings: [] },
          ],
          excludedAttributes: [],
        }),
        notSelected: [{ proposalId: 'p-z', contractor: { id: 'c-z', name: 'Zed' } }],
        decisionsSha256: 'b'.repeat(64),
      });
      expect(withLeft.proposals).toEqual([]);
      expect(withLeft.not_covered.map((entry) => [entry.contractor.legal_name, entry.reason])).toEqual([
        ['Alpha', 'NO_ANALYSIS_RUN'],
        ['Mid', 'CRITERIA_VERSION_MISMATCH'],
        ['Zed', 'NOT_SELECTED'],
      ]);
    });

    it('prints the same minutes for the same report, with what each expert decided for each criterion, the conclusion, the signatures and the dissent', () => {
      const input = {
        summary,
        packageName: 'Bridge deck',
        agency: 'Project board',
        signatures: [{ displayName: 'Nguyen A', signedAt: '2026-11-13T03:00:00.000Z' }, { displayName: 'Tran B', signedAt: '2026-11-13T04:00:00.000Z' }],
        dissents: [{ displayName: 'Tran B', text: 'The experience score of Beta is too low.', recordedAt: '2026-11-13T04:00:00.000Z' }],
      };
      const payload = evaluationReportPayload(input);
      expect(payload).toEqual(evaluationReportPayload(input));
      expect(Object.keys(payload).sort()).toEqual(['agency', 'body', 'place', 'title']);
      expect(payload).toMatchObject({ title: 'BIÊN BẢN ĐÁNH GIÁ HỒ SƠ DỰ THẦU - GÓI THẦU G-01', agency: 'Project board', place: '-' });
      expect(payload.body).toContain('Gói thầu G-01: Bridge deck');
      expect(payload.body).toContain('1. Alpha Builders: điểm theo trọng số 54.00; tiêu chí bắt buộc không đạt: 0; đã quyết định 2/2 tiêu chí.');
      expect(payload.body).toContain('2. Beta Builders: điểm theo trọng số 24.00; tiêu chí bắt buộc không đạt: 2; đã quyết định 2/2 tiêu chí.');
      expect(payload.body).toContain('   - C1 Experience: đáp ứng, điểm 9/10; không có lưu ý');
      expect(payload.body).toContain('   - C2 Licence: thiếu; không đạt tiêu chí bắt buộc');
      expect(payload.body).toContain('   - Zeta Builders: không đưa vào biên bản');
      expect(payload.body).toContain('Kết luận của tổ chuyên gia:\nAlpha meets every mandatory criterion; Beta lacks the licence.');
      expect(payload.body).toContain('   - Nguyen A (2026-11-13T03:00:00.000Z)');
      expect(payload.body).toContain('   - Tran B (2026-11-13T04:00:00.000Z): The experience score of Beta is too low.');
      expect(payload.body).not.toMatch(/winner|xếp hạng|trúng thầu/i);
      const bare = evaluationReportPayload({ ...input, dissents: [], signatures: [] });
      expect(bare.body).not.toContain('Ý kiến khác');
    });

    it('says a criterion nobody decided is undecided and a proposal without a weighted score has not enough', () => {
      const open = compareProposals({ criteriaVersionId: ID_C, criteria, runs: [run('p-a', 'Alpha Builders', 'run-a', null, null)], excludedAttributes: [] });
      const payload = evaluationReportPayload({
        summary: reportSummary({ conclusion: 'x'.repeat(20), pack: { id: ID_A, code: 'G-01' }, comparison: open, notSelected: [], decisionsSha256: 'c'.repeat(64) }),
        packageName: 'Bridge deck',
        agency: 'Project board',
        signatures: [],
        dissents: [],
      });
      expect(payload.body).toContain('điểm theo trọng số chưa đủ điểm để tính');
      expect(payload.body).toContain('   - C1 Experience: chưa có quyết định\n   - C2');
    });
  });
});
