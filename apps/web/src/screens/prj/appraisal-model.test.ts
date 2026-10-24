import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_DECISION,
  EMPTY_PROPOSAL,
  EMPTY_SCORE_FORM,
  appraisalLink,
  decisionBody,
  describeAppraisalProblem,
  evidenceIdsOf,
  formOfSheet,
  needsOverride,
  ownSheet,
  previewTotal,
  proposalBody,
  scoreBody,
  toAppraisalView,
  validateDecisionForm,
  validateProposal,
  validateScoreForm,
} from './appraisal-model';
import type { AppraisalView, CriteriaSet, DecisionForm } from './appraisal-model';
import { CRITERIA, DOCUMENT, EVIDENCE, OTHER_SHEET_ID, SHEET_ID, SET_ID, appraisal, criteriaSet, lifecycle, sheet } from './appraisal-test-support';

const problem = (code: string) => new ApiError({ status: 409, code, correlationId: 'c', extensions: {} });
const SET: CriteriaSet = toAppraisalView(lifecycle('APPRAISAL', appraisal()))?.criteriaSet as CriteriaSet;
const SCORES = { C1: '4', C2: '3', C3: '5', C4: '2', C5: '4' };

const viewOf = (block: Record<string, unknown> | null, status = 'APPRAISAL'): AppraisalView => toAppraisalView(lifecycle(status, block)) as AppraisalView;
const decider = (): AppraisalView =>
  viewOf(
    appraisal({
      can_record: false,
      can_decide: true,
      sheets: [sheet(SHEET_ID, [4, 3, 5, 2, 4])],
      summary: { sheet_count: 1, mean_score: '73.00', threshold_recommendation: 'ADMIT', override_required: { ADMIT: false, REJECT: true, RETURN: true } },
      decision_target: { id: SHEET_ID, version: 1 },
    }),
  );

describe('the preview of a total (BR-PRJ-03)', () => {
  it('AC-ST-PRJ-003-1: weights 30/25/20/15/10 and scores 4,3,5,2,4 preview as 73.00, like the server', () => {
    expect(previewTotal(CRITERIA, SCORES)).toBe('73.00');
  });

  it('AC-ST-PRJ-003-1: the ends are 0.00 and 100.00, a criterion without a score gives no total, weights with decimals stay exact', () => {
    expect(previewTotal(CRITERIA, { C1: '0', C2: '0', C3: '0', C4: '0', C5: '0' })).toBe('0.00');
    expect(previewTotal(CRITERIA, { C1: '5', C2: '5', C3: '5', C4: '5', C5: '5' })).toBe('100.00');
    expect(previewTotal(CRITERIA, { C1: '5', C2: '', C3: '5', C4: '5', C5: '5' })).toBeNull();
    expect(previewTotal(CRITERIA, { C1: '5' })).toBeNull();
    const fractional = [
      { code: 'A', name: 'A', weight: '33.33' },
      { code: 'B', name: 'B', weight: '33.33' },
      { code: 'C', name: 'C', weight: '33.34' },
    ];
    expect(previewTotal(fractional, { A: '1', B: '1', C: '2' })).toBe('26.67');
    expect(previewTotal([{ code: 'A', name: 'A', weight: '12.5' }, { code: 'B', name: 'B', weight: '87.5' }], { A: '1', B: '0' })).toBe('2.50');
  });
});

describe('reading the lifecycle read', () => {
  it('reads the project, the criteria set, the sheets, the summary and the target of a decision', () => {
    const view = decider();
    expect(view).toMatchObject({ projectId: expect.any(String), code: 'DA-2026-001', status: 'APPRAISAL', version: 2, hasAppraisal: true, round: 1, canDecide: true, canRecord: false, viewerIsProposer: false });
    expect(view.criteriaSet).toMatchObject({ versionId: SET_ID, key: 'APPR-CRIT-2026r1', passThreshold: '60', awaitingConfirmation: true, cxn: 'ASSUMPTION-APPRAISAL-60' });
    expect(view.criteriaSet?.criteria.map((criterion) => criterion.weight)).toEqual(['30', '25', '20', '15', '10']);
    expect(view.sheets[0]).toMatchObject({ id: SHEET_ID, totalScore: '73.00', recommendation: 'ADMIT', appraiserName: 'Trần Thị Bình', mine: false, decision: null });
    expect(view.summary).toEqual({ sheetCount: 1, meanScore: '73.00', thresholdRecommendation: 'ADMIT', overrideRequired: { ADMIT: false, REJECT: true, RETURN: true } });
    expect(view.decisionTarget).toEqual({ id: SHEET_ID, version: 1 });
  });

  it('reads a project without an appraisal block as one the caller neither scores nor decides', () => {
    const view = viewOf(null);
    expect(view).toMatchObject({ hasAppraisal: false, round: null, canRecord: false, canDecide: false, criteriaSet: null, sheets: [], summary: null, decisionTarget: null });
  });

  it('leaves out what is malformed: a stage that does not exist, a sheet without a total, a criterion with a bad weight, a summary without a count', () => {
    expect(toAppraisalView({ project_id: 'p', code: 'c', status: 'NOPE', version: 1 })).toBeUndefined();
    expect(toAppraisalView(null)).toBeUndefined();
    expect(toAppraisalView('text')).toBeUndefined();
    const view = viewOf(
      appraisal({
        criteria_set: criteriaSet({ criteria: [{ code: 'C1', name: 'One', weight: '30' }, { code: 'C2', name: 'Bad', weight: 'abc' }, { name: 'No code', weight: '1' }, { code: 'C3', weight: '10' }] }),
        sheets: [sheet(SHEET_ID, [1, 1, 1, 1, 1]), { id: 'x', version: 1, status: 'SUBMITTED' }, { ...sheet(OTHER_SHEET_ID, [1, 1, 1, 1, 1]), status: 'WEIRD' }, { ...sheet('y', [1, 1, 1, 1, 1]), recommendation: 'MAYBE' }, 'nope'],
        summary: { mean_score: '1.00' },
        decision_target: { id: SHEET_ID },
      }),
    );
    expect(view.criteriaSet?.criteria).toEqual([
      { code: 'C1', name: 'One', weight: '30' },
      { code: 'C3', name: 'C3', weight: '10' },
    ]);
    expect(view.sheets.map((entry) => entry.id)).toEqual([SHEET_ID]);
    expect(view.summary).toBeNull();
    expect(view.decisionTarget).toBeNull();
    const withoutSet = viewOf(appraisal({ criteria_set: { key: 'no version' } }));
    expect(withoutSet.criteriaSet).toBeNull();
  });

  it('reads a sheet with a decision and evidence, and finds the sheet of the caller', () => {
    const view = viewOf(appraisal({ sheets: [sheet(SHEET_ID, [4, 3, 5, 2, 4], { mine: true, decision: 'ADMIT', status: 'DECIDED', note: 'Sound', scores: [{ criterion_code: 'C1', score: 4, evidence_ids: [EVIDENCE, 7] }] }), sheet(OTHER_SHEET_ID, [1, 1, 1, 1, 1])] }));
    expect(view.sheets[0]).toMatchObject({ decision: 'ADMIT', status: 'DECIDED', note: 'Sound', scores: [{ criterionCode: 'C1', score: 4, evidenceIds: [EVIDENCE] }] });
    expect(ownSheet(view)?.id).toBe(SHEET_ID);
    expect(ownSheet(viewOf(appraisal({ sheets: [sheet(SHEET_ID, [1, 1, 1, 1, 1], { mine: true, status: 'VOID' })] })))).toBeUndefined();
    expect(ownSheet(viewOf(appraisal()))).toBeUndefined();
  });

  it('reads a summary without the override rule or the recommendation of the threshold', () => {
    const view = viewOf(appraisal({ summary: { sheet_count: 0, mean_score: null, threshold_recommendation: null, override_required: null } }));
    expect(view.summary).toEqual({ sheetCount: 0, meanScore: null, thresholdRecommendation: null, overrideRequired: null });
    expect(needsOverride(view, 'ADMIT')).toBe(false);
  });
});

describe('PRJ-09: the proposal form', () => {
  it('UI-PRJ-09: asks for the reason, the document and a real date, and sends the document in lower case', () => {
    expect(validateProposal(EMPTY_PROPOSAL)).toEqual({ reason: 'required', documentId: 'required' });
    expect(validateProposal({ reason: 'abc', documentId: 'nope', effectiveDate: '2026-02-30' })).toEqual({ reason: 'tooShort', documentId: 'invalidId', effectiveDate: 'invalidDate' });
    expect(validateProposal({ reason: 'x'.repeat(2001), documentId: DOCUMENT, effectiveDate: '' })).toEqual({ reason: 'tooLong' });
    const form = { reason: '  Send it for appraisal  ', documentId: ` ${DOCUMENT.toUpperCase()} `, effectiveDate: '2026-11-01' };
    expect(validateProposal(form)).toEqual({});
    expect(proposalBody(form)).toEqual({ reason: 'Send it for appraisal', policy_proposal_document_id: DOCUMENT, effective_date: '2026-11-01' });
    expect(proposalBody({ ...form, effectiveDate: '' })).not.toHaveProperty('effective_date');
  });
});

describe('PRJ-15: the scoring form', () => {
  it('UI-PRJ-15: every criterion needs a score, evidence must be ids, a recommendation is chosen, the note is bounded', () => {
    expect(validateScoreForm(SET.criteria, EMPTY_SCORE_FORM)).toEqual({ scores: 'scoresIncomplete', recommendation: 'required' });
    expect(validateScoreForm(SET.criteria, { scores: SCORES, evidence: { C1: 'not-an-id' }, recommendation: 'ADMIT', note: 'x'.repeat(2001) })).toEqual({ evidence: 'evidenceInvalid', note: 'tooLong' });
    expect(validateScoreForm(SET.criteria, { scores: SCORES, evidence: { C1: `${EVIDENCE}, ${EVIDENCE}` }, recommendation: 'ADMIT', note: '' })).toEqual({});
  });

  it('AC-ST-PRJ-003-1: the body of a sheet carries the version of the set, whole scores, de-duplicated lower-case evidence and the trimmed note', () => {
    const body = scoreBody(SET, { scores: SCORES, evidence: { C1: `${EVIDENCE.toUpperCase()} ${EVIDENCE}`, C2: '' }, recommendation: 'ADMIT', note: '  Sound  ' });
    expect(body).toEqual({
      criteria_set_version_id: SET_ID,
      recommendation: 'ADMIT',
      note: 'Sound',
      scores: [
        { criterion_code: 'C1', score: 4, evidence_ids: [EVIDENCE] },
        { criterion_code: 'C2', score: 3 },
        { criterion_code: 'C3', score: 5 },
        { criterion_code: 'C4', score: 2 },
        { criterion_code: 'C5', score: 4 },
      ],
    });
    expect(scoreBody(SET, { scores: SCORES, evidence: {}, recommendation: 'REJECT', note: ' ' })).not.toHaveProperty('note');
    expect(evidenceIdsOf(` a,b;c  d `)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('starts the form of a sheet already recorded from what it says', () => {
    const own = viewOf(appraisal({ sheets: [sheet(SHEET_ID, [4, 3, 5, 2, 4], { mine: true, note: 'Sound', scores: [{ criterion_code: 'C1', score: 4, evidence_ids: [EVIDENCE] }, { criterion_code: 'C2', score: 3 }] })] })).sheets[0];
    expect(formOfSheet(own as NonNullable<typeof own>)).toEqual({ scores: { C1: '4', C2: '3' }, evidence: { C1: EVIDENCE, C2: '' }, recommendation: 'ADMIT', note: 'Sound' });
  });
});

describe('PRJ-10: the decision form', () => {
  const form = (overrides: Partial<DecisionForm>): DecisionForm => ({ ...EMPTY_DECISION, ...overrides });

  it('UI-PRJ-10: a decision needs a reason; ADMIT needs the document and the group; the document, when given, is an id', () => {
    const view = decider();
    expect(validateDecisionForm(view, EMPTY_DECISION)).toEqual({ decision: 'required', reason: 'required' });
    expect(validateDecisionForm(view, form({ decision: 'ADMIT', reason: 'Admit it' }))).toEqual({ documentId: 'required', projectGroup: 'required' });
    expect(validateDecisionForm(view, form({ decision: 'ADMIT', reason: 'abc', documentId: 'nope', projectGroup: 'B' }))).toEqual({ reason: 'tooShort', documentId: 'invalidId' });
    expect(validateDecisionForm(view, form({ decision: 'ADMIT', reason: 'x'.repeat(2001), documentId: DOCUMENT, projectGroup: 'B' }))).toEqual({ reason: 'tooLong' });
    expect(validateDecisionForm(view, form({ decision: 'ADMIT', reason: 'Admit it', documentId: DOCUMENT, projectGroup: 'B' }))).toEqual({});
  });

  it('AC-ST-PRJ-003-3: a decision against the sheets needs an override reason of at least 20 characters', () => {
    const view = decider();
    expect(needsOverride(view, 'REJECT')).toBe(true);
    expect(needsOverride(view, 'ADMIT')).toBe(false);
    expect(needsOverride(view, '')).toBe(false);
    expect(validateDecisionForm(view, form({ decision: 'REJECT', reason: 'Reject it' }))).toEqual({ overrideReason: 'required' });
    expect(validateDecisionForm(view, form({ decision: 'REJECT', reason: 'Reject it', overrideReason: 'too short' }))).toEqual({ overrideReason: 'overrideShort' });
    expect(validateDecisionForm(view, form({ decision: 'REJECT', reason: 'Reject it', overrideReason: 'x'.repeat(2001) }))).toEqual({ overrideReason: 'tooLong' });
    expect(validateDecisionForm(view, form({ decision: 'REJECT', reason: 'Reject it', overrideReason: 'The funding was withdrawn' }))).toEqual({});
  });

  it('sends only what the decision takes: the group only with ADMIT, the override only when it is needed', () => {
    const view = decider();
    expect(decisionBody(view, form({ decision: 'ADMIT', reason: ' Admit it ', documentId: DOCUMENT.toUpperCase(), projectGroup: 'B', overrideReason: 'ignored since not needed' }))).toEqual({
      decision: 'ADMIT',
      reason: 'Admit it',
      decision_document_id: DOCUMENT,
      project_group: 'B',
    });
    expect(decisionBody(view, form({ decision: 'REJECT', reason: 'Reject it', projectGroup: 'B', overrideReason: ' The funding was withdrawn ' }))).toEqual({
      decision: 'REJECT',
      reason: 'Reject it',
      override_reason: 'The funding was withdrawn',
    });
  });
});

describe('refusals and addresses', () => {
  it('maps the codes of the commands to the reasons the screens say, and an unknown failure to the general one', () => {
    const cases: Array<[string, string]> = [
      ['SELF_APPROVAL_DENIED', 'selfApproval'],
      ['CRITERIA_WEIGHT_INVALID', 'criteriaWeight'],
      ['SCORE_OUT_OF_RANGE', 'scoreRange'],
      ['OVERRIDE_REASON_REQUIRED', 'overrideRequired'],
      ['PROJECT_GROUP_REQUIRED', 'groupRequired'],
      ['DECISION_REQUIRED', 'decisionRequired'],
      ['APPRAISAL_INCOMPLETE', 'incomplete'],
      ['STAGE_TRANSITION_DENIED', 'transitionDenied'],
      ['VERSION_CONFLICT', 'versionConflict'],
      ['VALIDATION_FAILED', 'validation'],
      ['INVALID_REQUEST', 'validation'],
      ['RESOURCE_NOT_FOUND', 'notFound'],
      ['SCOPE_DENIED', 'denied'],
      ['SOMETHING_ELSE', 'general'],
    ];
    for (const [code, reason] of cases) expect(describeAppraisalProblem(problem(code))).toBe(reason);
    expect(describeAppraisalProblem(new Error('boom'))).toBe('general');
  });

  it('builds the address of a screen of the appraisal for a project', () => {
    expect(appraisalLink('/prj/prj-15', 'abc')).toBe('/prj/prj-15?id=abc');
  });
});
