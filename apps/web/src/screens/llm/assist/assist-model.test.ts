import { describe, expect, it } from 'vitest';
import { ApiError } from '@machvon/api-client';
import {
  KNOWN_CODES,
  addSource,
  approvalProblem,
  attestBody,
  bpPercent,
  camelKey,
  checklistBody,
  criteriaBody,
  dropItems,
  emptyAttest,
  emptyChecklist,
  emptyCriteria,
  emptyRequest,
  exceptionDecisionBody,
  failureCode,
  groupStatements,
  hasChecklistErrors,
  hasCriteriaErrors,
  initialScores,
  isUnsupported,
  isUuid,
  newChecklistRow,
  newCriterionRow,
  paramsSummary,
  parseReviewDetail,
  parseScore,
  rationaleOk,
  removeSource,
  requestBody,
  runBody,
  sameAsProposals,
  scoreSheet,
  statementDecision,
  subjectFromQuery,
  termList,
  toChecklist,
  toCriteriaSet,
  toEditionPolicy,
  toException,
  toProviderRow,
  toRun,
  toRunPage,
  typedWeights,
  validateAttest,
  validateChecklist,
  validateCriteria,
  validateRequest,
  validateRun,
  weightState,
  weightedTotal,
  weightsTotal,
} from './assist-model';
import type { CriterionProposal, Statement } from './assist-model';
import { assumption, checklist, criteriaSet, evalRun, exception, inference, proposal, provider, reviewItem, reviewRun, run, statement, unsupportedStatement, uuid } from './test/assist-support';

const parsed = (raw: Record<string, unknown>): Statement => toRun(run(1, { statements: [raw] })).statements[0] as Statement;

describe('camelKey', () => {
  it('turns an enumeration value into the lower camel part of a catalogue key', () => {
    expect(camelKey('ACCEPTED_WITH_CHANGE')).toBe('acceptedWithChange');
    expect(camelKey('QA')).toBe('qa');
    expect(camelKey('AI_EXTERNAL_EXCEPTION_REQUIRED')).toBe('aiExternalExceptionRequired');
    expect(camelKey('DOCUMENT_VERSION')).toBe('documentVersion');
  });

  it('gives a valid key segment for every code the screens name', () => {
    for (const code of KNOWN_CODES) expect(camelKey(code)).toMatch(/^[a-z][a-zA-Z0-9]*$/);
  });
});

describe('weightedTotal: the integer formula of the server', () => {
  const two = [
    { code: 'A', weightBp: 5000 },
    { code: 'B', weightBp: 5000 },
  ];

  it('computes sum(weight_bp * score) / 100 with two places', () => {
    expect(weightedTotal(two, new Map([['A', 85], ['B', 90]]), 100)).toBe('87.50');
    expect(weightedTotal(two, new Map([['A', 100], ['B', 100]]), 100)).toBe('100.00');
    expect(weightedTotal(two, new Map([['A', 0], ['B', 0]]), 100)).toBe('0.00');
  });

  it('rounds half up to the hundredth', () => {
    expect(weightedTotal([{ code: 'A', weightBp: 50 }], new Map([['A', 1]]), 100)).toBe('0.01');
    expect(weightedTotal([{ code: 'A', weightBp: 49 }], new Map([['A', 1]]), 100)).toBe('0.00');
    const thirds = [
      { code: 'A', weightBp: 3333 },
      { code: 'B', weightBp: 3333 },
      { code: 'C', weightBp: 3334 },
    ];
    // 3333*70 + 3333*80 + 3334*90 = 233310 + 266640 + 300060 = 800010 -> (800010 + 50) / 100 = 8000 -> 80.00
    expect(weightedTotal(thirds, new Map([['A', 70], ['B', 80], ['C', 90]]), 100)).toBe('80.00');
  });

  it('gives no total until every criterion has a whole score within the scale', () => {
    expect(weightedTotal(two, new Map([['A', 85]]), 100)).toBeNull();
    expect(weightedTotal(two, new Map([['A', 85], ['B', 101]]), 100)).toBeNull();
    expect(weightedTotal(two, new Map([['A', 85], ['B', -1]]), 100)).toBeNull();
    expect(weightedTotal(two, new Map([['A', 85], ['B', 1.5]]), 100)).toBeNull();
  });

  it('writes a percent of basis points with two places from integers', () => {
    expect(bpPercent(2550)).toBe('25.50%');
    expect(bpPercent(10000)).toBe('100.00%');
    expect(bpPercent(5)).toBe('0.05%');
  });

  it('knows when weights are complete, short or over', () => {
    expect(weightsTotal([6000, 4000])).toBe(10000);
    expect(weightState(10000)).toBe('COMPLETE');
    expect(weightState(9999)).toBe('SHORT');
    expect(weightState(10001)).toBe('OVER');
  });
});

describe('reading a run', () => {
  it('reads the statements, the counts and the decision', () => {
    const read = toRun(run(1, { decision: { id: uuid(9), decision: 'ACCEPTED', rationale: 'Reason of at least twenty characters', accepted_result: { kept_statements: ['s1'], scores: { A: 80 }, total: '80.00' }, decided_by: uuid(8), decided_at: '2026-11-08T03:00:00.000Z' } }));
    expect(read.statements.map((entry) => entry.id)).toEqual(['s1', 's2']);
    expect(read.decision?.accepted).toEqual({ keptStatements: ['s1'], scores: { A: 80 }, total: '80.00' });
    expect(read.decisionStatus).toBe('ACCEPTED');
    expect(read.counts.unsupported).toBe(1);
  });

  it('reads the decision status of a row of the list that carries no decision', () => {
    expect(toRun(run(1, { decision_status: 'REJECTED' })).decisionStatus).toBe('REJECTED');
    expect(toRun(run(1)).decisionStatus).toBeNull();
  });

  it('shows a label it does not know as unsupported, never as a fact', () => {
    const read = parsed({ ...statement('s1'), presented_as: 'FACT', verification: 'CHECKED' });
    expect(read.presentedAs).toBe('UNSUPPORTED');
    expect(read.verification).toBe('UNSUPPORTED');
    expect(isUnsupported(read)).toBe(true);
  });

  it('rejects a body of the wrong shape instead of showing an empty screen', () => {
    expect(() => toRun({ id: uuid(1) })).toThrow('unexpected run');
    expect(() => toRun(run(1, { statements: 'none' }))).toThrow('unexpected run');
    expect(() => toRun(run(1, { kind: 'MAGIC' }))).toThrow('unexpected run');
    expect(() => toRunPage({ rows: [] })).toThrow('unexpected page of runs');
  });

  it('reads a page of runs with its cursor', () => {
    const page = toRunPage({ items: [run(1), run(2)], next_cursor: 'abc', as_of: '2026-11-08T03:00:00.000Z' });
    expect(page.items).toHaveLength(2);
    expect(page.next).toBe('abc');
    expect(toRunPage({ items: [], next_cursor: null }).next).toBeUndefined();
  });

  it('reads a review with an item that is not proven as not proven', () => {
    const read = toRun(reviewRun(1, [reviewItem('A', { result: 'MAYBE' }), reviewItem('B', { result: 'PASS' })], 'NOT_READY'));
    expect(read.review?.items.map((item) => item.result)).toEqual(['UNKNOWN', 'PASS']);
    expect(read.review?.verdict).toBe('NOT_READY');
  });

  it('reads the proposals of an evaluation with the scale', () => {
    const read = toRun(evalRun(1, [proposal('A', 6000, 80), proposal('B', 4000, null, 'NEEDS_EVIDENCE')]));
    expect(read.evaluation?.scaleMax).toBe(100);
    expect(read.evaluation?.criteria.map((entry) => [entry.code, entry.proposedScore, entry.status])).toEqual([
      ['A', 80, 'PROPOSED'],
      ['B', null, 'NEEDS_EVIDENCE'],
    ]);
  });
});

describe('groupStatements', () => {
  it('groups by what a statement is shown as, in the order a reader trusts them, without empty groups', () => {
    const list = toRun(run(1, { statements: [unsupportedStatement('s1'), inference('s2', ['s3']), statement('s3'), assumption('s4'), statement('s5')] })).statements;
    const groups = groupStatements(list);
    expect(groups.map((group) => [group.basis, group.statements.map((entry) => entry.id)])).toEqual([
      ['SOURCE', ['s3', 's5']],
      ['ASSUMPTION', ['s4']],
      ['INFERENCE', ['s2']],
      ['UNSUPPORTED', ['s1']],
    ]);
    expect(groupStatements(list.filter((entry) => entry.presentedAs === 'SOURCE')).map((group) => group.basis)).toEqual(['SOURCE']);
    expect(groupStatements([])).toEqual([]);
  });
});

describe('the sources of a question', () => {
  it('adds a source by kind and id, once, up to twenty', () => {
    const first = addSource([], 'PROJECT', ` ${uuid(1).toUpperCase()} `);
    expect(first).toEqual({ list: [{ kind: 'PROJECT', id: uuid(1) }] });
    expect(addSource(first.list, 'PROJECT', uuid(1)).problem).toBe('DUPLICATE');
    expect(addSource(first.list, 'CONTRACT', uuid(1)).problem).toBeUndefined();
    expect(addSource([], 'PROJECT', 'not-an-id').problem).toBe('INVALID_ID');
    const full = Array.from({ length: 20 }, (_, index) => ({ kind: 'PROJECT' as const, id: uuid(index + 1) }));
    expect(addSource(full, 'PROJECT', uuid(99)).problem).toBe('TOO_MANY');
    expect(removeSource(full, 0)).toHaveLength(19);
  });

  it('reads the subject of a deep link and ignores a bad one', () => {
    expect(subjectFromQuery(`?subject_kind=CONTRACT&subject_id=${uuid(5)}`)).toEqual({ kind: 'CONTRACT', id: uuid(5) });
    expect(subjectFromQuery(`?subject_kind=MAGIC&subject_id=${uuid(5)}`)).toBeUndefined();
    expect(subjectFromQuery('?subject_kind=PROJECT&subject_id=x')).toBeUndefined();
    expect(subjectFromQuery('')).toBeUndefined();
    expect(isUuid(uuid(1))).toBe(true);
    expect(isUuid('x')).toBe(false);
  });
});

describe('validateRun and runBody', () => {
  const base = { kind: 'QA' as const, text: 'What is the cost?', sources: [{ kind: 'PROJECT' as const, id: uuid(1) }], subject: undefined, checklistId: '', criteriaSetId: '', maxCost: '' };

  it('asks for a text and a source', () => {
    expect(validateRun({ ...base, text: '  ', sources: [] })).toEqual(['TEXT_REQUIRED', 'SOURCES_REQUIRED']);
    expect(validateRun(base)).toEqual([]);
    expect(validateRun({ ...base, text: 'x'.repeat(4001) })).toContain('TEXT_TOO_LONG');
  });

  it('asks a review for a checklist and a document, an evaluation for a set and a contract', () => {
    expect(validateRun({ ...base, kind: 'DOC_REVIEW', text: '' })).toEqual(['CHECKLIST_REQUIRED', 'DOCUMENT_REQUIRED']);
    expect(validateRun({ ...base, kind: 'CONTRACT_EVAL', text: '' })).toEqual(['CRITERIA_REQUIRED', 'CONTRACT_REQUIRED']);
    expect(validateRun({ ...base, kind: 'DOC_REVIEW', text: '', checklistId: uuid(3), sources: [{ kind: 'DOCUMENT_VERSION', id: uuid(2) }] })).toEqual([]);
  });

  it('checks the cost limit as digits', () => {
    expect(validateRun({ ...base, maxCost: '12a' })).toEqual(['COST_INVALID']);
    expect(validateRun({ ...base, maxCost: '0' })).toEqual([]);
    expect(validateRun({ ...base, maxCost: '05' })).toEqual(['COST_INVALID']);
  });

  it('builds the body the contract describes and leaves out what is empty', () => {
    expect(runBody(base)).toEqual({ kind: 'QA', request_text: 'What is the cost?', sources: [{ kind: 'PROJECT', id: uuid(1) }] });
    expect(runBody({ ...base, subject: { kind: 'CONTRACT', id: uuid(2) }, maxCost: '5000' })).toEqual({
      kind: 'QA',
      request_text: 'What is the cost?',
      sources: [{ kind: 'PROJECT', id: uuid(1) }],
      subject: { kind: 'CONTRACT', id: uuid(2) },
      max_cost_vnd: '5000',
    });
    expect(runBody({ ...base, kind: 'DOC_REVIEW', text: '', checklistId: uuid(3) })).toMatchObject({ kind: 'DOC_REVIEW', checklist_id: uuid(3) });
    expect(runBody({ ...base, kind: 'CONTRACT_EVAL', text: '', criteriaSetId: uuid(4) })).toMatchObject({ criteria_set_id: uuid(4) });
  });
});

describe('the decision about statements', () => {
  const list = toRun(run(1, { statements: [statement('s1'), statement('s2'), unsupportedStatement('s3')] })).statements;

  it('needs a reasoning of twenty characters', () => {
    expect(rationaleOk('too short')).toBe(false);
    expect(rationaleOk(' '.repeat(30))).toBe(false);
    expect(rationaleOk('The figures agree with the report.')).toBe(true);
    expect(statementDecision('ACCEPTED', list, new Set(['s1', 's2']), 'short').problem).toBe('RATIONALE_SHORT');
  });

  it('accepts without items, and rejects without items', () => {
    const text = 'The figures agree with the report.';
    expect(statementDecision('ACCEPTED', list, new Set(['s1', 's2']), text).body).toEqual({ decision: 'ACCEPTED', rationale: text });
    expect(statementDecision('REJECTED', list, new Set(), text).body).toEqual({ decision: 'REJECTED', rationale: text });
  });

  it('drops the supported statements that are not kept, never naming an unsupported one', () => {
    const text = 'The second statement is out of date.';
    expect(dropItems(list, new Set(['s1']))).toEqual([{ item_key: 's2', action: 'DROP' }]);
    expect(statementDecision('ACCEPTED_WITH_CHANGE', list, new Set(['s1']), text).body).toEqual({ decision: 'ACCEPTED_WITH_CHANGE', rationale: text, items: [{ item_key: 's2', action: 'DROP' }] });
    expect(statementDecision('ACCEPTED_WITH_CHANGE', list, new Set(['s1', 's2']), text).problem).toBe('NOTHING_DROPPED');
  });
});

describe('the scores of an evaluation', () => {
  const criteria: CriterionProposal[] = [
    { code: 'A', label: 'A', weightBp: 6000, proposedScore: 80, status: 'PROPOSED', citations: [] },
    { code: 'B', label: 'B', weightBp: 4000, proposedScore: null, status: 'NEEDS_EVIDENCE', citations: [] },
  ];

  it('starts from the proposals and leaves a withheld score empty', () => {
    expect(initialScores(criteria)).toEqual({ A: '80', B: '' });
    expect(sameAsProposals(criteria, { A: '80', B: '' })).toBe(true);
    expect(sameAsProposals(criteria, { A: '81', B: '' })).toBe(false);
  });

  it('parses a score as a whole number within the scale', () => {
    expect(parseScore('', 100)).toEqual({ state: 'EMPTY' });
    expect(parseScore(' 85 ', 100)).toEqual({ state: 'OK', score: 85 });
    expect(parseScore('0', 100)).toEqual({ state: 'OK', score: 0 });
    expect(parseScore('101', 100)).toEqual({ state: 'INVALID' });
    expect(parseScore('8.5', 100)).toEqual({ state: 'INVALID' });
    expect(parseScore('-3', 100)).toEqual({ state: 'INVALID' });
    expect(parseScore('08', 100)).toEqual({ state: 'INVALID' });
  });

  it('has no total until every criterion has a score, and says which fields are wrong', () => {
    expect(scoreSheet(criteria, { A: '80', B: '' }, 100)).toMatchObject({ state: 'INCOMPLETE', total: null });
    expect(scoreSheet(criteria, { A: '80', B: '500' }, 100)).toMatchObject({ state: 'INVALID', total: null, invalid: ['B'] });
  });

  it('computes the total live from the scores and chooses the decision that fits', () => {
    const changed = scoreSheet(criteria, { A: '80', B: '70' }, 100);
    expect(changed.state).toBe('READY');
    expect(changed.total).toBe('76.00');
    expect(changed.decision).toBe('ACCEPTED_WITH_CHANGE');
    expect(changed.items).toEqual([{ item_key: 'B', action: 'SET_SCORE', score: 70 }]);
    const edited = scoreSheet(criteria, { A: '90', B: '70' }, 100);
    expect(edited.items.map((item) => item.item_key)).toEqual(['A', 'B']);
    const all: CriterionProposal[] = criteria.map((entry) => ({ ...entry, proposedScore: entry.proposedScore ?? 60, status: 'PROPOSED' }));
    const same = scoreSheet(all, { A: '80', B: '60' }, 100);
    expect(same).toMatchObject({ state: 'READY', decision: 'ACCEPTED', items: [], total: '72.00' });
  });
});

describe('the forms of the checklists and the criteria', () => {
  const goodRow = { ...newChecklistRow(1), code: 'TERMS', label: 'Has the terms', kind: 'REQUIRED_TERMS' as const, terms: 'budget; schedule\nscope' };

  it('accepts a good checklist and builds the body of the contract', () => {
    const form = { ...emptyChecklist(), code: 'CHK.PROJECT', title: 'Project dossier', appliesTo: 'PROJECT_DOSSIER', rows: [goodRow, { ...newChecklistRow(2), code: 'WORDS', label: 'Long enough', kind: 'MIN_WORDS' as const, min: '200' }, { ...newChecklistRow(3), code: 'PAT', label: 'Has a date', kind: 'PATTERN' as const, pattern: '\\d{4}', mustMatch: false }, { ...newChecklistRow(4), code: 'ASK', label: 'Names the owner', kind: 'AI_QUESTION' as const, question: 'Who owns it?', severity: 'INFO' as const }] };
    expect(hasChecklistErrors(validateChecklist(form))).toBe(false);
    expect(checklistBody(form)).toEqual({
      code: 'CHK.PROJECT',
      title: 'Project dossier',
      applies_to: 'PROJECT_DOSSIER',
      items: [
        { code: 'TERMS', label: 'Has the terms', kind: 'REQUIRED_TERMS', severity: 'WARNING', params: { terms: ['budget', 'schedule', 'scope'], match: 'ALL' } },
        { code: 'WORDS', label: 'Long enough', kind: 'MIN_WORDS', severity: 'WARNING', params: { min: 200 } },
        { code: 'PAT', label: 'Has a date', kind: 'PATTERN', severity: 'WARNING', params: { pattern: '\\d{4}', must_match: false } },
        { code: 'ASK', label: 'Names the owner', kind: 'AI_QUESTION', severity: 'INFO', params: { question: 'Who owns it?' } },
      ],
    });
  });

  it('refuses what the contract refuses: codes, lengths, parameters of each kind', () => {
    expect(validateChecklist(emptyChecklist())).toMatchObject({ code: 'required', title: 'required', appliesTo: 'required', byRow: { 1: { code: 'required', label: 'required', terms: 'required' } } });
    expect(validateChecklist({ ...emptyChecklist(), code: 'a', title: 'T', appliesTo: 'x y' })).toMatchObject({ code: 'pattern', title: 'short', appliesTo: 'pattern' });
    const dup = validateChecklist({ ...emptyChecklist(), code: 'CHK', title: 'Title', appliesTo: 'DOSSIER', rows: [goodRow, { ...goodRow, key: 2 }] });
    expect(dup.byRow[2]?.code).toBe('duplicate');
    const kinds = validateChecklist({
      ...emptyChecklist(),
      code: 'CHK',
      title: 'Title',
      appliesTo: 'DOSSIER',
      rows: [
        { ...newChecklistRow(1), code: 'A', label: 'Label', kind: 'MIN_WORDS', min: '0' },
        { ...newChecklistRow(2), code: 'B', label: 'Label', kind: 'PATTERN', pattern: '(a+)+' },
        { ...newChecklistRow(3), code: 'C', label: 'Label', kind: 'PATTERN', pattern: '[' },
        { ...newChecklistRow(4), code: 'D', label: 'Label', kind: 'PATTERN', pattern: 'x'.repeat(201) },
        { ...newChecklistRow(5), code: 'E', label: 'Label', kind: 'AI_QUESTION', question: 'no' },
        { ...newChecklistRow(6), code: 'F', label: 'Label', kind: 'REQUIRED_TERMS', terms: Array.from({ length: 21 }, (_, index) => `t${index}`).join(',') },
      ],
    });
    expect(kinds.byRow[1]?.min).toBe('range');
    expect(kinds.byRow[2]?.pattern).toBe('nested');
    expect(kinds.byRow[3]?.pattern).toBe('regex');
    expect(kinds.byRow[4]?.pattern).toBe('long');
    expect(kinds.byRow[5]?.question).toBe('short');
    expect(kinds.byRow[6]?.terms).toBe('range');
    expect(termList('a; b,\n c ;;')).toEqual(['a', 'b', 'c']);
  });

  it('accepts a good set of criteria and builds the body with weights in basis points', () => {
    const form = { ...emptyCriteria(), code: 'PERF', title: 'Performance', scaleMax: '100', rows: [{ ...newCriterionRow(1), code: 'QUALITY', label: 'Quality', weight: '6000', guidance: 'Look at the records' }, { ...newCriterionRow(2), code: 'TIME', label: 'Time', weight: '4000', evidenceRequired: false }] };
    expect(hasCriteriaErrors(validateCriteria(form))).toBe(false);
    expect(weightsTotal(typedWeights(form))).toBe(10000);
    expect(criteriaBody(form)).toEqual({
      code: 'PERF',
      title: 'Performance',
      scale_max: 100,
      criteria: [
        { code: 'QUALITY', label: 'Quality', guidance: 'Look at the records', weight_bp: 6000, evidence_required: true },
        { code: 'TIME', label: 'Time', weight_bp: 4000, evidence_required: false },
      ],
    });
  });

  it('refuses a weight out of range, a scale out of range and a duplicate code', () => {
    const errors = validateCriteria({ ...emptyCriteria(), code: 'PERF', title: 'Performance', scaleMax: '0', rows: [{ ...newCriterionRow(1), code: 'A', label: 'Label', weight: '0' }, { ...newCriterionRow(2), code: 'A', label: 'Label', weight: '10001' }, { ...newCriterionRow(3), code: 'C', label: 'Label', weight: '' }] });
    expect(errors.scaleMax).toBe('range');
    expect(errors.byRow[1]?.weight).toBe('range');
    expect(errors.byRow[2]).toMatchObject({ code: 'duplicate', weight: 'range' });
    expect(errors.byRow[3]?.weight).toBe('required');
    expect(typedWeights({ ...emptyCriteria(), rows: [{ ...newCriterionRow(1), weight: 'abc' }, { ...newCriterionRow(2), weight: '25' }] })).toEqual([0, 25]);
  });
});

describe('the forms of the providers and the exceptions', () => {
  it('checks an attestation and builds its body', () => {
    expect(validateAttest(emptyAttest())).toMatchObject({ country: 'required', reference: 'required' });
    expect(validateAttest({ ...emptyAttest(), country: 'vn', reference: 'ATT-1' }).country).toBe('pattern');
    expect(validateAttest({ ...emptyAttest(), country: 'VN', reference: 'AT' }).reference).toBe('short');
    expect(validateAttest({ ...emptyAttest(), country: 'VN', reference: 'ATT-1', documentId: 'x' }).documentId).toBe('pattern');
    expect(validateAttest({ ...emptyAttest(), country: 'VN', reference: 'ATT-1', detail: 'x' }).detail).toBe('short');
    const form = { country: 'VN', detail: ' Hanoi region ', noTraining: true, reference: ' ATT-2026-01 ', documentId: uuid(7).toUpperCase() };
    expect(validateAttest(form)).toEqual({});
    expect(attestBody(form)).toEqual({ data_location_country: 'VN', data_location_detail: 'Hanoi region', no_training_attested: true, attestation_ref: 'ATT-2026-01', attestation_document_id: uuid(7) });
    expect(attestBody({ ...emptyAttest(), country: 'VN', reference: 'ATT-1' })).toEqual({ data_location_country: 'VN', no_training_attested: false, attestation_ref: 'ATT-1' });
  });

  it('checks a request for an exception and builds its body', () => {
    expect(validateRequest(emptyRequest())).toMatchObject({ providerId: 'required', reason: 'required' });
    expect(validateRequest({ ...emptyRequest(), providerId: uuid(1), reason: 'too short' }).reason).toBe('short');
    expect(validateRequest({ ...emptyRequest(), providerId: uuid(1), reason: 'x'.repeat(25), days: '91' }).days).toBe('range');
    expect(validateRequest({ ...emptyRequest(), providerId: uuid(1), reason: 'x'.repeat(25), days: '0' }).days).toBe('range');
    expect(validateRequest({ ...emptyRequest(), providerId: uuid(1), reason: 'x'.repeat(25), taskType: 'qa' }).taskType).toBe('pattern');
    const form = { providerId: uuid(1), taskType: 'AI_ASSIST_QA', maxClassification: 'INTERNAL' as const, reason: 'Public statistics need the external model.', days: '45' };
    expect(validateRequest(form)).toEqual({});
    expect(requestBody(form)).toEqual({ provider_id: uuid(1), task_type: 'AI_ASSIST_QA', max_classification: 'INTERNAL', reason: 'Public statistics need the external model.', valid_days: 45 });
    expect(requestBody({ ...form, taskType: '' })).not.toHaveProperty('task_type');
  });

  it('asks an approval for its reference and a rejection for a note', () => {
    expect(approvalProblem('APPROVE', '', '')).toBe('REF_REQUIRED');
    expect(approvalProblem('APPROVE', 'ab', '')).toBe('REF_SHORT');
    expect(approvalProblem('APPROVE', 'DEC-1', 'short')).toBe('NOTE_SHORT');
    expect(approvalProblem('APPROVE', 'DEC-1', '')).toBeUndefined();
    expect(approvalProblem('REJECT', '', 'too short')).toBe('NOTE_SHORT');
    expect(approvalProblem('REJECT', '', 'The reason is clear.')).toBeUndefined();
    expect(exceptionDecisionBody('APPROVE', ' DEC-1 ', '')).toEqual({ decision: 'APPROVE', approval_ref: 'DEC-1' });
    expect(exceptionDecisionBody('REJECT', '', ' The reason is clear. ')).toEqual({ decision: 'REJECT', note: 'The reason is clear.' });
  });
});

describe('reading the registry answers', () => {
  it('reads a checklist and a set of criteria and leaves out what lacks an id, a status or a version', () => {
    expect(toChecklist(checklist(1))?.items).toHaveLength(3);
    expect(paramsSummary(toChecklist(checklist(1))?.items[0] ?? (undefined as never))).toBe('budget, schedule');
    expect(paramsSummary(toChecklist(checklist(1))?.items[1] ?? (undefined as never))).toBe('200');
    expect(toChecklist({ ...checklist(1), status: 'WEIRD' })).toBeUndefined();
    expect(toCriteriaSet(criteriaSet(1))?.weightsTotalBp).toBe(10000);
    expect(toCriteriaSet({ ...criteriaSet(1), version: undefined })).toBeUndefined();
  });

  it('reads a provider with or without an attestation', () => {
    expect(toProviderRow(provider(1))).toMatchObject({ country: null, noTrainingAttested: null, route: 'INTERNATIONAL' });
    expect(toProviderRow(provider(1, { no_training_attested: false, data_location_country: 'SG' }))).toMatchObject({ country: 'SG', noTrainingAttested: false });
    expect(toProviderRow({ id: uuid(1) })).toBeUndefined();
  });

  it('reads an exception with its uses and the edition policy', () => {
    expect(toException(exception(1))?.status).toBe('REQUESTED');
    expect(toException({ ...exception(1), status: 'MAYBE' })).toBeUndefined();
    expect(toEditionPolicy({ name: 'x', external_routing: 'ALLOWED', attestation_required: false })).toEqual({ name: 'x', externalRouting: 'ALLOWED', attestationRequired: false });
    expect(() => toEditionPolicy({ name: 'x', external_routing: 'ANYTHING' })).toThrow('unexpected edition policy');
  });

  it('reads the details of a review item', () => {
    expect(parseReviewDetail('MISSING:budget|schedule')).toEqual({ kind: 'missing', terms: 'budget, schedule' });
    expect(parseReviewDetail('WORDS:5<10')).toEqual({ kind: 'words', words: '5', min: '10' });
    expect(parseReviewDetail('PATTERN_ABSENT')).toEqual({ kind: 'patternAbsent' });
    expect(parseReviewDetail('PATTERN_PRESENT')).toEqual({ kind: 'patternPresent' });
    expect(parseReviewDetail('NOT_ANSWERED')).toEqual({ kind: 'notAnswered' });
    expect(parseReviewDetail('PASS_WITHOUT_EVIDENCE')).toEqual({ kind: 'passWithoutEvidence' });
    expect(parseReviewDetail('NOT_COMPUTABLE')).toEqual({ kind: 'notComputable' });
    expect(parseReviewDetail('SOMETHING')).toEqual({ kind: 'other', text: 'SOMETHING' });
  });

  it('tells the code of an API failure', () => {
    expect(failureCode(new ApiError({ status: 422, code: 'BUDGET_EXCEEDED', correlationId: 'c' }))).toBe('BUDGET_EXCEEDED');
    expect(failureCode(new Error('x'))).toBeUndefined();
  });
});
