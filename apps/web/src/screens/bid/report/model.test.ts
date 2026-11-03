import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { toComparison } from '../compare/model';
import {
  MAX_CONCLUSION,
  MAX_DISSENT,
  MIN_CONCLUSION,
  MIN_DISSENT,
  candidatesOf,
  canAct,
  comparePath,
  createBody,
  declarationPath,
  describeProblem,
  emptyCreate,
  isConfirmation,
  maySign,
  readFailure,
  reviewRunPath,
  signBody,
  stageOf,
  toReport,
  toReportList,
  unreviewedCount,
  validateCreate,
  validateDissent,
  withDissentDraft,
  withRun,
  withoutDissentDraft,
  withoutRun,
} from './model';
import type { Candidate, Report } from './model';
import { CV2, comparison, memberOf, packageId, report, reportId, runId } from './test-support';

const problem = (code: string, extensions: Record<string, unknown> = {}) => new ApiError({ status: 422, code, correlationId: 'c', extensions });
const parsed = (overrides: Record<string, unknown> = {}): Report => toReport(report(1, overrides)) as Report;

describe('the model of BID-13 (ST-BID-012)', () => {
  describe('reading a report', () => {
    it('reads what the server sends: the summary the experts decided, the signatures, who is awaited, the dissent and where the minutes stand at DOC', () => {
      const one = parsed({
        status: 'ISSUED',
        report_document_id: '00000000-0000-4000-8000-0000000000e9',
        document_status: 'ISSUED',
        issued_at: '2026-12-07T03:00:00.000Z',
        recalled_at: '2026-12-08T03:00:00.000Z',
        dissenting_opinions: [{ membership_id: memberOf(2), display_name: 'Chuyên gia 2', text: 'Không đồng ý với điểm.', recorded_at: '2026-12-06T08:00:00.000Z' }],
        payload_sha256: 'b'.repeat(64),
      });
      expect(one).toMatchObject({ id: reportId(1), status: 'ISSUED', package: { id: packageId(1), code: 'GT-1' }, reportDocumentId: '00000000-0000-4000-8000-0000000000e9', documentStatus: 'ISSUED', stale: false, canSign: true, version: 2, payloadSha256: 'b'.repeat(64) });
      expect(one.summary.proposals.map((proposal) => [proposal.contractor.name, proposal.weightedScore, proposal.decidedCount, proposal.criteriaCount, proposal.mandatoryNotMet])).toEqual([
        ['Công ty nhà thầu 1', '32.00', 2, 2, 0],
        ['Công ty nhà thầu 2', null, 2, 2, 1],
      ]);
      expect(one.summary.rows[1]?.cells.map((cell) => [cell.decided?.status ?? null, cell.decided?.score ?? null, cell.risk])).toEqual([
        ['SUPPORTED', '8.00', 'NONE'],
        [null, null, 'UNDECIDED'],
      ]);
      expect(one.summary.rows[0]?.criterion).toMatchObject({ code: 'C1', mandatory: true, maxScore: null });
      expect(one.signedOffBy).toEqual([{ membershipId: memberOf(1), displayName: 'Chuyên gia 1', signedAt: '2026-12-06T06:00:00.000Z', withDissent: false }]);
      expect(one.awaiting).toEqual([{ membershipId: memberOf(2), displayName: 'Chuyên gia 2', standing: 'CLEAR' }]);
      expect(one.dissentingOpinions).toEqual([{ membershipId: memberOf(2), displayName: 'Chuyên gia 2', text: 'Không đồng ý với điểm.', recordedAt: '2026-12-06T08:00:00.000Z' }]);
      expect([one.issuedAt, one.recalledAt, one.issueRequestedAt]).toEqual(['2026-12-07T03:00:00.000Z', '2026-12-08T03:00:00.000Z', null]);
      expect(one.createdBy).toEqual({ membershipId: memberOf(1), displayName: 'Chuyên gia 1' });
    });

    it('reads the proposals the report does not cover, with the reason', () => {
      const one = parsed({ summary: { ...report(1).summary, not_covered: [{ proposal_id: 'p-9', contractor: { id: 'c-9', legal_name: 'Công ty 9' }, reason: 'NOT_SELECTED' }, { proposal_id: 'p-8', contractor: { id: 'c-8' }, reason: 'SOMETHING_ELSE' }] } });
      expect(one.summary.notCovered).toEqual([{ proposalId: 'p-9', contractorName: 'Công ty 9', reason: 'NOT_SELECTED' }]);
    });

    it('leaves out what does not have the shape and reads a list of reports, the rest as nothing', () => {
      expect(toReport(undefined)).toBeUndefined();
      expect(toReport({ ...report(1), status: 'DONE' })).toBeUndefined();
      expect(toReport({ ...report(1), summary: { conclusion: 'x' } })).toBeUndefined();
      expect(toReport({ ...report(1), created_by: {} })).toBeUndefined();
      expect(toReport({ ...report(1), version: '2' })).toBeUndefined();
      const odd = toReport({
        ...report(1),
        summary: {
          ...report(1).summary,
          proposals: [{ proposal_id: 'x' }, ...report(1).summary.proposals],
          rows: [{ criterion: {} }, { criterion: { code: 'C9' }, cells: [{ proposal_id: 'p' }, { proposal_id: 'p', risk: 'NONE', decided: { status: 'WEIRD' } }] }],
        },
        signed_off_by: [{}, 'text', { membership_id: memberOf(3), display_name: 'Ba', dissent: true }],
        awaiting: [{ membership_id: 'm', display_name: 'M', standing: 'WEIRD' }],
        dissenting_opinions: [{ membership_id: 'm', display_name: 'M' }],
      }) as Report;
      expect(odd.summary.proposals).toHaveLength(2);
      expect(odd.summary.rows).toEqual([{ criterion: { code: 'C9', name: '', maxScore: null, mandatory: false }, cells: [{ proposalId: 'p', risk: 'NONE', decided: null }] }]);
      expect(odd.signedOffBy).toEqual([{ membershipId: memberOf(3), displayName: 'Ba', signedAt: null, withDissent: true }]);
      expect(odd.awaiting).toEqual([]);
      expect(odd.dissentingOpinions).toEqual([]);
      expect(toReportList({ items: [report(1), { id: 'broken' }, report(2)] }).map((entry) => entry.id)).toEqual([reportId(1), reportId(2)]);
      expect(toReportList(undefined)).toEqual([]);
      expect(toReportList({ items: 'x' })).toEqual([]);
    });
  });

  describe('what the caller is offered', () => {
    it('offers the forms to the evaluation team in a session that is not read-only', () => {
      expect(canAct(['bid.evaluate'], 'FULL')).toBe(true);
      expect(canAct(undefined, undefined)).toBe(true);
      expect(canAct(['bid.evaluate'], 'READ_ONLY')).toBe(false);
      expect(canAct(['bid.read'], 'FULL')).toBe(false);
    });

    it('offers the signature only of a draft that waits for the caller, that did not go stale, to a caller who may', () => {
      expect(maySign(parsed(), ['bid.evaluate'], 'FULL')).toBe(true);
      expect(maySign(parsed({ actions: { sign_off: false } }), ['bid.evaluate'], 'FULL')).toBe(false);
      expect(maySign(parsed({ stale: true }), ['bid.evaluate'], 'FULL')).toBe(false);
      expect(maySign(parsed({ status: 'ISSUE_REQUESTED' }), ['bid.evaluate'], 'FULL')).toBe(false);
      expect(maySign(parsed(), ['bid.evaluate'], 'READ_ONLY')).toBe(false);
      expect(maySign(parsed(), ['bid.read'], 'FULL')).toBe(false);
    });

    it('knows the signature is only a confirmation when the caller signed already and nobody is awaited any more (AC-ST-BID-012-1)', () => {
      const signed = [{ membership_id: memberOf(1), display_name: 'Chuyên gia 1', signed_at: '2026-12-06T06:00:00.000Z', dissent: false }];
      // The server offers the call to a member who signed once the team was cut down to the members who signed.
      const cut = parsed({ signed_off_by: signed, awaiting: [] });
      expect(maySign(cut, ['bid.evaluate'], 'FULL')).toBe(true);
      expect(isConfirmation(cut, memberOf(1))).toBe(true);
      expect(isConfirmation(cut, memberOf(1).toUpperCase())).toBe(true);
      // Someone who has not signed signs, with the dissent they hold, even when nobody else is awaited.
      expect(isConfirmation(cut, memberOf(2))).toBe(false);
      expect(isConfirmation(cut, undefined)).toBe(false);
      // Others are still awaited: the signature is not a confirmation.
      expect(isConfirmation(parsed({ signed_off_by: signed }), memberOf(1))).toBe(false);
    });

    it('names the stage of the minutes for each status', () => {
      expect(['DRAFT', 'SIGNED_OFF', 'ISSUE_REQUESTED', 'ISSUED', 'SUPERSEDED'].map((status) => stageOf(parsed({ status })))).toEqual(['signing', 'refused', 'doc', 'issued', 'superseded']);
    });
  });

  describe('making the draft', () => {
    const candidates: Candidate[] = [
      { proposalId: 'p1', contractorName: 'A', runId: runId(1), decidedCount: 3, criteriaCount: 3 },
      { proposalId: 'p2', contractorName: 'B', runId: runId(2), decidedCount: 1, criteriaCount: 3 },
    ];
    const conclusion = 'x'.repeat(MIN_CONCLUSION);

    it('takes the proposals of the comparison, in the order the server gives them, with how far each is decided', () => {
      const compared = toComparison(comparison());
      expect(candidatesOf(compared).map((candidate) => [candidate.contractorName, candidate.decidedCount, candidate.criteriaCount, candidate.runId])).toEqual([
        ['Công ty nhà thầu 1', 2, 3, runId(1)],
        ['Công ty nhà thầu 2', 0, 3, runId(2)],
      ]);
      expect(candidatesOf(undefined)).toEqual([]);
      expect(compared?.criteriaVersionId).toBe(CV2);
    });

    it('puts every candidate in the report until the person takes one out, and puts it back', () => {
      expect(withoutRun([], 'r1')).toEqual([]);
      expect(withRun([], 'r1')).toEqual(['r1']);
      expect(withRun(['r1'], 'r1')).toEqual(['r1']);
      expect(withoutRun(['r1', 'r2'], 'r1')).toEqual(['r2']);
      expect(createBody(packageId(1), CV2, { taken: [runId(2)], conclusion: `  ${conclusion}  ` }, candidates)).toEqual({
        package_id: packageId(1),
        criteria_version_id: CV2,
        run_ids: [runId(1)],
        summary: { conclusion },
      });
    });

    it('asks for a conclusion of the length the minutes hold and for at least one proposal, before anything is sent', () => {
      expect(validateCreate({ taken: [], conclusion }, candidates)).toEqual({});
      expect(validateCreate(emptyCreate(), candidates)).toEqual({ conclusion: 'required' });
      expect(validateCreate({ taken: [], conclusion: 'x'.repeat(MIN_CONCLUSION - 1) }, candidates)).toEqual({ conclusion: 'tooShort' });
      expect(validateCreate({ taken: [], conclusion: ` ${'x'.repeat(MIN_CONCLUSION - 1)} ` }, candidates)).toEqual({ conclusion: 'tooShort' });
      expect(validateCreate({ taken: [], conclusion: 'x'.repeat(MAX_CONCLUSION + 1) }, candidates)).toEqual({ conclusion: 'tooLong' });
      expect(validateCreate({ taken: [runId(1), runId(2)], conclusion }, candidates)).toEqual({ runs: 'noRun' });
      expect(validateCreate({ taken: [], conclusion }, [])).toEqual({ runs: 'noRun' });
    });
  });

  describe('signing', () => {
    it('lets a member sign without a dissent, and checks the one they write', () => {
      expect(validateDissent('')).toBeUndefined();
      expect(validateDissent('    ')).toBeUndefined();
      expect(validateDissent('x'.repeat(MIN_DISSENT))).toBeUndefined();
      expect(validateDissent('x'.repeat(MIN_DISSENT - 1))).toBe('tooShort');
      expect(validateDissent('x'.repeat(MAX_DISSENT + 1))).toBe('tooLong');
      expect(signBody('  ')).toEqual({});
      expect(signBody('  Không đồng ý với điểm của nhà thầu 2.  ')).toEqual({ dissent: 'Không đồng ý với điểm của nhà thầu 2.' });
    });

    it('keeps what is typed for each report apart and drops it once the report is signed', () => {
      const typed = withDissentDraft(withDissentDraft({}, 'a', 'one'), 'b', 'two');
      expect(typed).toEqual({ a: 'one', b: 'two' });
      expect(withoutDissentDraft(typed, 'a')).toEqual({ b: 'two' });
    });
  });

  describe('refusals', () => {
    it('words each refusal of the server, and anything else is general', () => {
      const cases: Array<[string, string]> = [
        ['UNREVIEWED_FINDINGS', 'unreviewed'],
        ['CRITERIA_VERSION_MISMATCH', 'criteriaMismatch'],
        ['RUN_NOT_COMPLETED', 'runNotCompleted'],
        ['CONFLICT_UNDECLARED', 'undeclared'],
        ['ALREADY_SIGNED_OFF', 'alreadySigned'],
        ['REPORT_STATE_INVALID', 'notDraft'],
        ['REPORT_OUT_OF_DATE', 'outOfDate'],
        ['VERSION_CONFLICT', 'versionConflict'],
        ['DOC_TEMPLATE_MISSING', 'templateMissing'],
        ['PROVIDER_UNAVAILABLE', 'docUnavailable'],
        ['VALIDATION_FAILED', 'validation'],
        ['INVALID_REQUEST', 'validation'],
        ['FIELD_NOT_ALLOWED', 'validation'],
        ['RESOURCE_NOT_FOUND', 'notFound'],
        ['SCOPE_DENIED', 'denied'],
        ['ENTITLEMENT_DENIED', 'denied'],
        ['SESSION_EXPIRED', 'session'],
        ['SOMETHING_ELSE', 'general'],
      ];
      for (const [code, expected] of cases) expect(describeProblem(problem(code))).toBe(expected);
      expect(describeProblem(new Error('boom'))).toBe('general');
    });

    it('counts the findings nobody decided from the refusal, and none from anything else', () => {
      expect(unreviewedCount(problem('UNREVIEWED_FINDINGS', { unreviewed_count: 4 }))).toBe(4);
      expect(unreviewedCount(problem('UNREVIEWED_FINDINGS'))).toBe(0);
      expect(unreviewedCount(new Error('boom'))).toBe(0);
    });

    it('treats the declaration owed as a thing to do and not as a failure of the read', () => {
      expect(readFailure(problem('CONFLICT_UNDECLARED'))).toBe('undeclared');
      expect(readFailure(problem('SCOPE_DENIED'))).toBeUndefined();
      expect(readFailure(new Error('boom'))).toBeUndefined();
    });

    it('addresses the other screens with the package or the run', () => {
      expect(declarationPath('a b')).toBe('/bid/bid-05?package=a%20b');
      expect(comparePath(packageId(1))).toBe(`/bid/bid-10?package=${packageId(1)}`);
      expect(reviewRunPath(runId(1))).toBe(`/bid/bid-12?run=${runId(1)}`);
    });
  });
});
