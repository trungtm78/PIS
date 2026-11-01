import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { harness, mount, routeOf } from '../../mne/test-support';
import type { Harness } from '../../mne/test-support';
import AssessmentScreen from './AssessmentScreen';
import RoadmapScreen from './RoadmapScreen';
import RubricScreen from './RubricScreen';
import * as labels from './labels';
import {
  EMPTY_MILESTONE,
  EMPTY_RECORD,
  EMPTY_RUBRIC,
  EMPTY_START,
  actionsFor,
  awaitsReview,
  describeMaturityProblem,
  milestoneBody,
  parseEvidenceLines,
  personName,
  recordBody,
  rubricBody,
  rubricTemplate,
  startBody,
  toAssessment,
  toEvidence,
  toMilestone,
  toRubric,
  toScore,
  validateMilestone,
  validateRecord,
  validateRubric,
  validateStart,
} from './model';
import type { Assessment, EvidenceRow } from './model';

const ASSESS_ROUTE = routeOf('DGV-16', 'FR-DGV-16');
const ROAD_ROUTE = routeOf('DGV-17', 'FR-DGV-17');
const RUBRIC_ROUTE = routeOf('DGV-21', 'FR-DGV-21');
const ME = '00000000-0000-4000-8000-000000000001'; // the member of the session of the test support
const OTHER = '00000000-0000-4000-8000-0000000000aa';
const THIRD = '00000000-0000-4000-8000-0000000000bb';
const RUBRIC = '00000000-0000-4000-8000-0000000000c1';
const DRAFT = '00000000-0000-4000-8000-0000000000c2';
const ASSESSMENT = '00000000-0000-4000-8000-0000000000d1';
const ROW_PENDING = '00000000-0000-4000-8000-0000000000e1';
const ROW_OPEN = '00000000-0000-4000-8000-0000000000e2';
const ROW_DONE = '00000000-0000-4000-8000-0000000000e3';
const MILESTONE = '00000000-0000-4000-8000-0000000000f1';
const failure = (status: number, code: string, detail?: string) => new ApiError({ status, code, correlationId: 'c', detail, extensions: {} });
const fill = (value: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, item]) => out.replace(`{${key}}`, String(item)), value);
const READ = 'data.maturity.read';
const MANAGER = [READ, 'data.maturity.manage', 'membership.read'];
const PUBLISHER = [READ, 'data.maturity.publish'];
const ASSESSOR = [READ, 'data.maturity.assess'];
const REVIEWER = [READ, 'data.maturity.review'];

const person = (id: string, name: string) => ({ membership_id: id, display_name: name });
const criterion = (code: string, weight = '10.00') => ({
  code,
  name: `Criterion ${code}`,
  weight,
  levels: { 1: 'ad hoc', 2: 'repeatable', 3: 'defined', 4: 'managed', 5: 'optimised' },
  refs: ['DCAM 1.1'],
});
const rubric = (over: Record<string, unknown> = {}) => ({
  id: RUBRIC,
  rubric_code: 'RB-1',
  revision: 1,
  framework_refs: { DCAM: ['1.1'], DMM: ['DM-4'] },
  pillars: [
    { code: 'GOVERNANCE', name: 'Governance', weight: '50.00', criteria: [criterion('GOV-1'), criterion('GOV-2')] },
    { code: 'QUALITY', name: 'Quality', weight: '50.00', criteria: [criterion('QUAL-1')] },
  ],
  min_coverage_pct: '70.00',
  evidence_ttl_days: 365,
  status: 'PUBLISHED',
  approved_by: person(OTHER, 'Publisher'),
  created_by: person(THIRD, 'Drafter'),
  created_at: '2026-10-01T00:00:00Z',
  version: 2,
  ...over,
});
const assessment = (over: Record<string, unknown> = {}) => ({
  id: ASSESSMENT,
  period_code: '2026-H2',
  rubric_version_id: RUBRIC,
  rubric_code: 'RB-1',
  rubric_revision: 1,
  scope_kind: 'TENANT',
  scope_ref: null,
  assessor: person(ME, 'Me'),
  reviewer: person(OTHER, 'Reviewer'),
  status: 'IN_REVIEW',
  coverage_percent: '0.00',
  overall_state: null,
  overall_level: null,
  published_by: null,
  published_at: null,
  created_at: '2026-10-02T00:00:00Z',
  version: 3,
  ...over,
});
const evidenceRow = (id: string, code: string, over: Record<string, unknown> = {}) => ({
  id,
  assessment_id: ASSESSMENT,
  pillar_code: code.startsWith('QUAL') ? 'QUALITY' : 'GOVERNANCE',
  criterion_code: code,
  assessment_state: 'NOT_ASSESSED',
  level: null,
  evidence_refs: [],
  review_status: 'PENDING',
  assessed_by: null,
  evidence_expires_on: null,
  na_reason: null,
  review_note: null,
  reviewer: null,
  created_at: '2026-10-02T00:00:00Z',
  version: 4,
  ...over,
});
const scoreCriterion = (id: string, code: string, over: Record<string, unknown> = {}) => ({
  pillar_code: code.startsWith('QUAL') ? 'QUALITY' : 'GOVERNANCE',
  criterion_code: code,
  weight: '10.00',
  state: 'NOT_ASSESSED',
  level: null,
  review_status: 'PENDING',
  evidence_expires_on: null,
  evidence_count: 0,
  evidence_id: id,
  ...over,
});
const score = (over: Record<string, unknown> = {}) => ({
  assessment_id: ASSESSMENT,
  status: 'IN_REVIEW',
  as_of: '2026-11-01',
  coverage_percent: '33.33',
  min_coverage_pct: '70.00',
  overall_state: 'NOT_COMPUTED',
  assessed_count: 1,
  not_assessed_count: 2,
  not_applicable_count: 0,
  pillars: [
    { pillar_code: 'GOVERNANCE', weight: '50.00', state: 'ASSESSED', level: '3.00', assessed_count: 1, not_assessed_count: 1, not_applicable_count: 0 },
    { pillar_code: 'QUALITY', weight: '50.00', state: 'NOT_ASSESSED', level: null, assessed_count: 0, not_assessed_count: 1, not_applicable_count: 0 },
  ],
  criteria: [
    scoreCriterion(ROW_DONE, 'GOV-1', { state: 'ASSESSED', level: 3, review_status: 'ACCEPTED', evidence_expires_on: '2027-01-01', evidence_count: 2 }),
    scoreCriterion(ROW_PENDING, 'GOV-2', { review_status: 'PENDING', evidence_count: 1 }),
    scoreCriterion(ROW_OPEN, 'QUAL-1'),
  ],
  ...over,
});
const milestone = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  rubric_version_id: RUBRIC,
  rubric_code: 'RB-1',
  pillar_code: 'QUALITY',
  target_level: 3,
  due_on: '2030-12-31',
  owner: person(OTHER, 'Milestone owner'),
  exit_criteria: 'The quality score is published',
  evidence_required: ['a scorecard', 'a log'],
  status: 'PLANNED',
  achieved_assessment_id: null,
  created_at: '2026-10-03T00:00:00Z',
  version: 1,
  ...over,
});
const member = (id: string, name: string) => ({ id, display_name: name, status: 'Active', membership_type: 'STAFF' });

interface World {
  rubrics: unknown[] | Error;
  assessments: unknown[] | Error;
  evidence: unknown[] | Error;
  score: unknown;
  milestones: unknown[] | Error;
  members: unknown[] | Error;
}

function open(
  world: Partial<World> = {},
  command: (operation: string, input: unknown) => unknown = () => ({ operation_id: 'o', status: 'OK', resource_version: 2, resource_id: ASSESSMENT }),
): Harness & { readAll: ReturnType<typeof vi.fn> } {
  const state: World = {
    rubrics: [rubric(), rubric({ id: DRAFT, revision: 2, status: 'DRAFT', approved_by: null, version: 1 })],
    assessments: [assessment()],
    evidence: [
      evidenceRow(ROW_DONE, 'GOV-1', { assessment_state: 'ASSESSED', level: 3, review_status: 'ACCEPTED' }),
      evidenceRow(ROW_PENDING, 'GOV-2', { assessment_state: 'ASSESSED', level: 4, evidence_refs: [{ kind: 'TEST', ref: 'r' }] }),
      evidenceRow(ROW_OPEN, 'QUAL-1'),
    ],
    score: score(),
    milestones: [milestone(MILESTONE)],
    members: [member(ME, 'Me'), member(OTHER, 'Other'), member(THIRD, 'Third')],
    ...world,
  };
  const h = harness((operation) => (operation === 'getMaturityScore' ? state.score : new Error(`unexpected read ${operation}`)), command);
  const pick = (value: unknown[] | Error): Promise<unknown[]> => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value));
  const readAll = vi.fn((operation: string) => {
    switch (operation) {
      case 'listMaturityRubrics':
        return pick(state.rubrics);
      case 'get_resources_maturity_assessment':
        return pick(state.assessments);
      case 'get_resources_maturity_evidence':
        return pick(state.evidence);
      case 'listMaturityMilestones':
        return pick(state.milestones);
      case 'get_resources_membership':
        return pick(state.members);
      default:
        return Promise.reject(new Error(`unexpected readAll ${operation}`));
    }
  });
  (h.client as unknown as { readAll: typeof readAll }).readAll = readAll;
  return Object.assign(h, { readAll });
}

afterEach(cleanup);

describe('the model of the maturity (ST-DGV-008)', () => {
  it('reads a rubric, an assessment, a row of evidence, a score and a milestone, and leaves out what is not one', () => {
    expect(toRubric(rubric())).toMatchObject({
      id: RUBRIC,
      code: 'RB-1',
      revision: 1,
      status: 'PUBLISHED',
      minCoveragePct: '70.00',
      evidenceTtlDays: 365,
      frameworkRefs: { DCAM: ['1.1'], DMM: ['DM-4'] },
      version: 2,
    });
    expect(toRubric(rubric())?.pillars[0]?.criteria[0]).toMatchObject({ code: 'GOV-1', weight: '10.00', levels: { 1: 'ad hoc', 5: 'optimised' }, refs: ['DCAM 1.1'] });
    for (const bad of [null, [], {}, rubric({ status: 'LOST' }), rubric({ revision: '1' }), rubric({ pillars: 'x' }), rubric({ min_coverage_pct: 70 }), rubric({ evidence_ttl_days: '365' })])
      expect(toRubric(bad)).toBeUndefined();
    expect(toRubric(rubric({ pillars: [3, { code: 'X' }], framework_refs: 'x' }))).toMatchObject({ pillars: [], frameworkRefs: {} });
    expect(toAssessment(assessment())).toMatchObject({
      id: ASSESSMENT,
      periodCode: '2026-H2',
      scopeKind: 'TENANT',
      scopeRef: null,
      status: 'IN_REVIEW',
      overallState: null,
      assessor: { membershipId: ME, displayName: 'Me' },
      version: 3,
    });
    expect(toAssessment(assessment({ overall_state: 'COMPUTED', overall_level: '3.25', scope_kind: 'DOMAIN', scope_ref: 'TREASURY' }))).toMatchObject({
      overallState: 'COMPUTED',
      overallLevel: '3.25',
      scopeRef: 'TREASURY',
    });
    for (const bad of [null, {}, assessment({ status: 'LOST' }), assessment({ scope_kind: 'GALAXY' }), assessment({ coverage_percent: 3 }), assessment({ version: '3' })])
      expect(toAssessment(bad)).toBeUndefined();
    expect(toEvidence(evidenceRow(ROW_PENDING, 'GOV-2', { assessment_state: 'ASSESSED', level: 4, evidence_refs: [{}, {}] }))).toMatchObject({
      state: 'ASSESSED',
      level: 4,
      evidenceCount: 2,
      reviewStatus: 'PENDING',
    });
    for (const bad of [
      null,
      {},
      evidenceRow(ROW_PENDING, 'GOV-2', { assessment_state: 'MAYBE' }),
      evidenceRow(ROW_PENDING, 'GOV-2', { review_status: 'LATER' }),
      evidenceRow(ROW_PENDING, 'GOV-2', { version: '1' }),
    ])
      expect(toEvidence(bad)).toBeUndefined();
    expect(toScore(score())).toMatchObject({ assessmentId: ASSESSMENT, coveragePercent: '33.33', overallState: 'NOT_COMPUTED', overallLevel: null, assessed: 1, notAssessed: 2 });
    expect(toScore(score())?.pillars[1]).toMatchObject({ code: 'QUALITY', state: 'NOT_ASSESSED', level: null });
    expect(toScore(score({ overall_state: 'COMPUTED', overall_level: '3.00' }))?.overallLevel).toBe('3.00');
    expect(toScore(score({ pillars: [3, { pillar_code: 'X', weight: '1', state: 'MAYBE' }], criteria: [3, { pillar_code: 'X' }, scoreCriterion('x', 'GOV-1', { state: 'MAYBE' })] }))).toMatchObject({
      pillars: [],
      criteria: [],
    });
    for (const bad of [null, {}, score({ status: 'LOST' }), score({ overall_state: 'MAYBE' }), score({ pillars: 'x' }), score({ coverage_percent: 33 })]) expect(toScore(bad)).toBeUndefined();
    expect(toScore({ ...score(), criteria: undefined, as_of: undefined, min_coverage_pct: undefined })).toMatchObject({ criteria: [], asOf: '', minCoveragePct: '' });
    expect(toMilestone(milestone(MILESTONE))).toMatchObject({
      id: MILESTONE,
      pillarCode: 'QUALITY',
      targetLevel: 3,
      dueOn: '2030-12-31',
      status: 'PLANNED',
      evidenceRequired: ['a scorecard', 'a log'],
      owner: { displayName: 'Milestone owner' },
    });
    for (const bad of [null, {}, milestone(MILESTONE, { status: 'LOST' }), milestone(MILESTONE, { target_level: '3' }), milestone(MILESTONE, { exit_criteria: 3 })])
      expect(toMilestone(bad)).toBeUndefined();
    expect(personName(null)).toBe('—');
    expect(personName({ membershipId: ME, displayName: null })).toBe(ME);
  });

  it('offers a person only what they may do on an assessment: not their own work to themselves, nothing when it is closed or the session is read-only', () => {
    const own = toAssessment(assessment()) as Assessment;
    const rows = (permissions: string[], mode?: string, who: string | undefined = ME, over: Partial<Assessment> = {}) => actionsFor({ ...own, ...over }, permissions, mode, who);
    expect(rows(['data.maturity.assess'])).toEqual({ record: true, review: false, decide: false });
    expect(rows(['data.maturity.review'], undefined, OTHER)).toEqual({ record: false, review: true, decide: false });
    expect(rows(['data.maturity.publish'], undefined, THIRD)).toEqual({ record: false, review: false, decide: true });
    expect(rows(['data.maturity.publish'], undefined, ME)).toEqual({ record: false, review: false, decide: false });
    expect(rows(['data.maturity.assess'], 'READ_ONLY')).toEqual({ record: false, review: false, decide: false });
    expect(rows(['data.maturity.assess'], undefined, ME, { status: 'PUBLISHED' })).toEqual({ record: false, review: false, decide: false });
    expect(rows(['data.maturity.assess'], undefined, ME, { status: 'DRAFT' }).record).toBe(true);
    expect(actionsFor(own, undefined, undefined, ME)).toEqual({ record: true, review: false, decide: false });
    expect(awaitsReview(toEvidence(evidenceRow(ROW_PENDING, 'GOV-2', { assessment_state: 'ASSESSED', level: 4 })) as EvidenceRow)).toBe(true);
    expect(awaitsReview(toEvidence(evidenceRow(ROW_OPEN, 'QUAL-1')) as EvidenceRow)).toBe(false);
    expect(awaitsReview(toEvidence(evidenceRow(ROW_DONE, 'GOV-1', { assessment_state: 'ASSESSED', level: 4, review_status: 'ACCEPTED' })) as EvidenceRow)).toBe(false);
  });

  it('checks a rubric before it is sent, and sends the document as typed', () => {
    expect(validateRubric({ ...EMPTY_RUBRIC, code: 'RB-1', pillars: '{"pillars":[]}' })).toEqual({});
    expect(validateRubric(EMPTY_RUBRIC)).toEqual({ code: 'required', pillars: 'required' });
    expect(validateRubric({ ...EMPTY_RUBRIC, code: 'rb 1', minCoveragePct: '0', evidenceTtlDays: '3651', frameworkRefs: '[', pillars: '[]' })).toEqual({
      code: 'invalid',
      minCoveragePct: 'invalid',
      evidenceTtlDays: 'invalid',
      frameworkRefs: 'invalid',
      pillars: 'invalid',
    });
    expect(validateRubric({ ...EMPTY_RUBRIC, code: 'RB-1', pillars: '{}', minCoveragePct: '', evidenceTtlDays: '' })).toEqual({ minCoveragePct: 'required', evidenceTtlDays: 'required' });
    expect(validateRubric({ ...EMPTY_RUBRIC, code: 'RB-1', pillars: '{}', minCoveragePct: '70.123' }).minCoveragePct).toBe('invalid');
    expect(rubricBody({ ...EMPTY_RUBRIC, code: ' RB-1 ', pillars: '{"pillars":[]}', frameworkRefs: '{"DCAM":["1"]}', minCoveragePct: ' 80 ', evidenceTtlDays: '90' })).toEqual({
      rubric_code: 'RB-1',
      framework_refs: { DCAM: ['1'] },
      pillars_json: { pillars: [] },
      min_coverage_pct: '80',
      evidence_ttl_days: 90,
    });
    const template = rubricTemplate();
    const pillars = (JSON.parse(template.pillars) as { pillars: Array<{ code: string; weight: number; criteria: unknown[] }> }).pillars;
    expect(pillars.map((pillar) => pillar.code)).toHaveLength(8);
    expect(pillars.reduce((sum, pillar) => sum + pillar.weight, 0)).toBe(100);
    expect(pillars.every((pillar) => pillar.criteria.length === 3)).toBe(true);
    expect(validateRubric({ ...EMPTY_RUBRIC, code: 'RB-1', frameworkRefs: template.frameworkRefs, pillars: template.pillars })).toEqual({});
    // The server refuses a framework that names no place: the template names none or names some.
    const refs = JSON.parse(template.frameworkRefs) as Record<string, unknown[]>;
    expect(Object.values(refs).every((places) => places.length > 0)).toBe(true);
  });

  it('checks the start of an assessment and the record of a criterion', () => {
    expect(validateStart(EMPTY_START)).toEqual({ rubricId: 'required', period: 'required', assessorId: 'required', reviewerId: 'required' });
    expect(validateStart({ ...EMPTY_START, rubricId: RUBRIC, period: '2026', assessorId: ME, reviewerId: ME })).toEqual({ reviewerId: 'invalid' });
    expect(validateStart({ ...EMPTY_START, rubricId: RUBRIC, period: 'x', scopeKind: 'DOMAIN', assessorId: ME, reviewerId: OTHER })).toEqual({ period: 'invalid', scopeRef: 'required' });
    expect(startBody({ ...EMPTY_START, rubricId: RUBRIC, period: ' 2026-H2 ', assessorId: ME, reviewerId: OTHER })).toEqual({
      period_code: '2026-H2',
      rubric_version_id: RUBRIC,
      scope_kind: 'TENANT',
      assessor_user_id: ME,
      reviewer_id: OTHER,
    });
    expect(startBody({ ...EMPTY_START, rubricId: RUBRIC, period: '2026-H2', scopeKind: 'DATA_PRODUCT', scopeRef: ' PRODUCT-1 ', assessorId: ME, reviewerId: OTHER })).toMatchObject({
      scope_kind: 'DATA_PRODUCT',
      scope_ref: 'PRODUCT-1',
    });
    expect(parseEvidenceLines('TEST run-1\n\n  log  the log of 5 Nov \n')).toEqual([
      { kind: 'TEST', ref: 'run-1' },
      { kind: 'LOG', ref: 'the log of 5 Nov' },
    ]);
    expect(parseEvidenceLines('')).toEqual([]);
    for (const bad of ['TEST', 'HEARSAY x', 'TEST   ']) expect(parseEvidenceLines(bad)).toBeUndefined();
    expect(validateRecord(EMPTY_RECORD)).toEqual({ level: 'required', evidence: 'required' });
    expect(validateRecord({ ...EMPTY_RECORD, level: '6', evidence: 'nope', expiresOn: '2026-02-30', sampleSize: '0' })).toEqual({
      level: 'invalid',
      evidence: 'invalid',
      expiresOn: 'invalid',
      sampleSize: 'invalid',
    });
    expect(validateRecord({ ...EMPTY_RECORD, level: '4', evidence: 'TEST run-1', expiresOn: '2027-01-31', sampleSize: '30' })).toEqual({});
    expect(validateRecord({ ...EMPTY_RECORD, state: 'NOT_APPLICABLE' })).toEqual({ naReason: 'required' });
    expect(validateRecord({ ...EMPTY_RECORD, state: 'NOT_APPLICABLE', naReason: 'short' })).toEqual({ naReason: 'invalid' });
    expect(validateRecord({ ...EMPTY_RECORD, state: 'NOT_ASSESSED' })).toEqual({});
    expect(recordBody('QUALITY', 'QUAL-1', { ...EMPTY_RECORD, level: '4', evidence: 'TEST run-1', expiresOn: '2027-01-31', sampleSize: '30', confidence: 'HIGH' })).toEqual({
      pillar_code: 'QUALITY',
      criterion_code: 'QUAL-1',
      assessment_state: 'ASSESSED',
      level: 4,
      evidence_refs: [{ kind: 'TEST', ref: 'run-1' }],
      evidence_expires_on: '2027-01-31',
      sample_size: 30,
      confidence: 'HIGH',
    });
    expect(recordBody('QUALITY', 'QUAL-1', { ...EMPTY_RECORD, level: '4', evidence: 'TEST run-1' })).not.toHaveProperty('evidence_expires_on');
    expect(recordBody('QUALITY', 'QUAL-1', { ...EMPTY_RECORD, state: 'NOT_APPLICABLE', naReason: ' does not apply here ' })).toEqual({
      pillar_code: 'QUALITY',
      criterion_code: 'QUAL-1',
      assessment_state: 'NOT_APPLICABLE',
      evidence_refs: [],
      na_reason: 'does not apply here',
    });
    expect(recordBody('QUALITY', 'QUAL-1', { ...EMPTY_RECORD, state: 'NOT_ASSESSED' })).toEqual({
      pillar_code: 'QUALITY',
      criterion_code: 'QUAL-1',
      assessment_state: 'NOT_ASSESSED',
      evidence_refs: [],
    });
  });

  it('checks a milestone and says what a refusal of the server means', () => {
    expect(validateMilestone(EMPTY_MILESTONE)).toEqual({ rubricId: 'required', targetLevel: 'required', dueOn: 'required', ownerId: 'required', exitCriteria: 'required' });
    expect(validateMilestone({ ...EMPTY_MILESTONE, rubricId: RUBRIC, targetLevel: '7', dueOn: '2026-02-30', ownerId: ME, exitCriteria: 'short' })).toEqual({
      targetLevel: 'invalid',
      dueOn: 'invalid',
      exitCriteria: 'invalid',
    });
    expect(
      milestoneBody({ ...EMPTY_MILESTONE, rubricId: RUBRIC, targetLevel: '3', dueOn: '2030-12-31', ownerId: ME, exitCriteria: ' The score is published ', evidence: 'a scorecard\n\n a log ' }),
    ).toEqual({
      rubric_version_id: RUBRIC,
      pillar_code: 'QUALITY',
      target_level: 3,
      due_on: '2030-12-31',
      owner_user_id: ME,
      exit_criteria: 'The score is published',
      evidence_required: ['a scorecard', 'a log'],
    });
    const cases: Array<[string, string]> = [
      ['RUBRIC_WEIGHTS_INVALID', 'weights'],
      ['RUBRIC_NOT_PUBLISHED', 'notPublished'],
      ['ASSESSOR_IS_REVIEWER', 'sameRole'],
      ['EVIDENCE_REQUIRED', 'evidenceRequired'],
      ['EVIDENCE_EXPIRED', 'expired'],
      ['LEVEL_OUT_OF_RANGE', 'level'],
      ['TARGET_BELOW_CURRENT', 'targetBelow'],
      ['SELF_APPROVAL_DENIED', 'self'],
      ['SCOPE_DENIED', 'scope'],
      ['VERSION_CONFLICT', 'stale'],
      ['STAGE_TRANSITION_DENIED', 'state'],
      ['DUPLICATE_KEY', 'duplicate'],
      ['VALIDATION_FAILED', 'validation'],
      ['RESOURCE_NOT_FOUND', 'notFound'],
      ['SOMETHING_ELSE', 'general'],
    ];
    for (const [code, reason] of cases) expect(describeMaturityProblem(failure(422, code, 'level'))).toEqual({ reason, detail: 'level' });
    expect(describeMaturityProblem(new Error('x'))).toEqual({ reason: 'general', detail: '' });
    expect(describeMaturityProblem(new ApiError({ status: 500, code: 'X', correlationId: 'c', extensions: {} }))).toEqual({ reason: 'general', detail: '' });
  });

  it('has a word, in both languages, for everything it names', () => {
    const t = (key: string, values?: Record<string, string | number>): string => (values === undefined ? key : fill(key, values));
    for (const code of ['GOVERNANCE', 'METADATA', 'QUALITY', 'INTEGRATION', 'SECURITY', 'LINEAGE_BI', 'AI_READINESS', 'VALUE_COST'])
      expect(labels.pillarLabel(t, code)).toMatch(/^dgv\.maturity\.pillar\./);
    expect(labels.pillarLabel(t, 'OTHER')).toBe('OTHER');
    for (const status of ['DRAFT', 'PUBLISHED', 'SUPERSEDED'] as const) expect(labels.rubricStatusLabel(t, status)).toMatch(/^dgv\.maturity\.rubric\.status\./);
    for (const status of ['DRAFT', 'IN_REVIEW', 'PUBLISHED', 'REJECTED'] as const) expect(labels.assessmentStatusLabel(t, status)).toMatch(/^dgv\.maturity\.status\./);
    for (const state of ['ASSESSED', 'NOT_ASSESSED', 'NOT_APPLICABLE'] as const) expect(labels.stateLabel(t, state)).toMatch(/^dgv\.maturity\.state\./);
    for (const status of ['PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED'] as const) expect(labels.reviewLabel(t, status)).toMatch(/^dgv\.maturity\.review\./);
    for (const status of ['PLANNED', 'IN_PROGRESS', 'ACHIEVED', 'MISSED'] as const) expect(labels.milestoneStatusLabel(t, status)).toMatch(/^dgv\.maturity\.milestone\.status\./);
    for (const scope of ['TENANT', 'DOMAIN', 'DATA_PRODUCT'] as const) expect(labels.scopeLabel(t, scope)).toMatch(/^dgv\.maturity\.scope\./);
    for (const kind of ['ARTIFACT', 'LOG', 'INTERVIEW', 'TEST'] as const) expect(labels.kindLabel(t, kind)).toMatch(/^dgv\.maturity\.kind\./);
    for (const confidence of ['HIGH', 'MEDIUM', 'LOW']) expect(labels.confidenceLabel(t, confidence)).toMatch(/^dgv\.maturity\.confidence\./);
    expect(labels.confidenceLabel(t, 'OTHER')).toBe('OTHER');
    expect(labels.overallLabel(t, 'COMPUTED')).toBe('dgv.maturity.overall.computed');
    expect(labels.overallLabel(t, 'NOT_COMPUTED')).toBe('dgv.maturity.overall.notComputed');
    for (const reason of [
      'weights',
      'notPublished',
      'sameRole',
      'evidenceRequired',
      'expired',
      'level',
      'targetBelow',
      'self',
      'scope',
      'stale',
      'state',
      'duplicate',
      'validation',
      'notFound',
      'general',
    ] as const)
      expect(labels.problemMessage(t, reason, 'field')).toMatch(/^dgv\.maturity\.problem\./);
  });
});

const states: Array<[string, Error, string]> = [
  ['denied', failure(403, 'SCOPE_DENIED'), vi_['states.denied.title']],
  ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c', extensions: {} }), vi_['states.offline.title']],
  ['error', failure(500, 'INTERNAL_ERROR'), vi_['states.error.title']],
  ['signed out', failure(401, 'SESSION_EXPIRED'), vi_['states.signedOut.title']],
];

describe('DGV-21, the rubric (ST-DGV-008, UAT-AC493)', () => {
  it('shows the pillars, the criteria with the description of each level, the mapping that is no certification, the coverage and the days of evidence', async () => {
    mount(<RubricScreen route={RUBRIC_ROUTE} />, open(), { permissions: [READ] });
    const view = await screen.findByRole('region', { name: fill(vi_['dgv.maturity.rubric.heading'], { code: 'RB-1', revision: 1 }) });
    expect(within(view).getByTestId('min-coverage').textContent).toBe('70.00%');
    expect(within(view).getByTestId('ttl').textContent).toBe(fill(vi_['dgv.maturity.rubric.days'], { days: 365 }));
    expect(within(view).getByTestId('frameworks-note').textContent).toBe(vi_['dgv.maturity.rubric.frameworks.note']);
    expect(view.textContent).toContain('DM-4');
    const table = within(view).getByTestId('rubric-table');
    expect(
      within(table)
        .getAllByRole('row')
        .filter((row) => row.hasAttribute('data-criterion')),
    ).toHaveLength(3);
    const first = table.querySelector('[data-criterion="GOV-1"]') as HTMLElement;
    expect(first.textContent).toContain('repeatable');
    expect(first.textContent).toContain('optimised');
    expect(first.textContent).toContain('DCAM 1.1');
    expect(table.querySelector('[data-pillar="QUALITY"]')?.textContent).toContain(vi_['dgv.maturity.pillar.quality']);
    expect(screen.queryByRole('button', { name: vi_['dgv.maturity.rubric.publish'] })).toBeNull();
    expect(screen.queryByRole('form', { name: vi_['dgv.maturity.draft.title'] })).toBeNull();
  });

  it('chooses a version and publishes a draft against the version that was read, with the refusal of the server shown', async () => {
    const user = userEvent.setup();
    const h = open({}, () => {
      throw failure(403, 'SELF_APPROVAL_DENIED');
    });
    mount(<RubricScreen route={RUBRIC_ROUTE} />, h, { permissions: PUBLISHER });
    await screen.findByRole('region', { name: fill(vi_['dgv.maturity.rubric.heading'], { code: 'RB-1', revision: 1 }) });
    expect(screen.queryByRole('button', { name: vi_['dgv.maturity.rubric.publish'] })).toBeNull();
    await user.selectOptions(screen.getByLabelText(vi_['dgv.maturity.rubric.version']), DRAFT);
    const draft = await screen.findByRole('region', { name: fill(vi_['dgv.maturity.rubric.heading'], { code: 'RB-1', revision: 2 }) });
    expect(draft.getAttribute('data-status')).toBe('DRAFT');
    await user.click(within(draft).getByRole('button', { name: vi_['dgv.maturity.rubric.publish'] }));
    expect((await within(draft).findByTestId('refusal')).getAttribute('data-reason')).toBe('self');
    expect(h.command).toHaveBeenCalledWith('publishMaturityRubric', expect.objectContaining({ path: { id: DRAFT }, ifMatchVersion: 1 }));
  });

  it('drafts the next version: the form is checked first, a template is offered, the refusal of the server is shown, and a draft that was made is said so', async () => {
    const user = userEvent.setup();
    const h = open({}, (_operation, input) => {
      if ((input as { body: { rubric_code: string } }).body.rubric_code === 'RB-BAD') throw failure(422, 'RUBRIC_WEIGHTS_INVALID', 'pillars_json.pillars');
      return { operation_id: 'o', status: 'DRAFT', resource_version: 1, resource_id: DRAFT };
    });
    mount(<RubricScreen route={RUBRIC_ROUTE} />, h, { permissions: MANAGER });
    const form = await screen.findByRole('form', { name: vi_['dgv.maturity.draft.title'] });
    await user.click(within(form).getByRole('button', { name: vi_['dgv.maturity.draft.submit'] }));
    expect(await within(form).findAllByText(vi_['dgv.maturity.form.required'])).not.toHaveLength(0);
    expect(h.command).not.toHaveBeenCalled();
    await user.type(within(form).getByLabelText(vi_['dgv.maturity.draft.code']), 'RB-BAD');
    await user.click(within(form).getByRole('button', { name: vi_['dgv.maturity.draft.template'] }));
    expect((within(form).getByLabelText(vi_['dgv.maturity.draft.pillars']) as HTMLTextAreaElement).value).toContain('"GOVERNANCE"');
    await user.click(within(form).getByRole('button', { name: vi_['dgv.maturity.draft.submit'] }));
    expect((await within(form).findByTestId('draft-refusal')).getAttribute('data-reason')).toBe('weights');
    const sent = h.command.mock.calls[0]?.[1] as { body: Record<string, unknown> };
    expect(sent.body).toMatchObject({ rubric_code: 'RB-BAD', min_coverage_pct: '70', evidence_ttl_days: 365 });
    await user.clear(within(form).getByLabelText(vi_['dgv.maturity.draft.code']));
    await user.type(within(form).getByLabelText(vi_['dgv.maturity.draft.code']), 'RB-OK');
    await user.click(within(form).getByRole('button', { name: vi_['dgv.maturity.draft.submit'] }));
    expect(await within(form).findByTestId('draft-saved')).toBeTruthy();
    expect((within(form).getByLabelText(vi_['dgv.maturity.draft.code']) as HTMLInputElement).value).toBe('');
  });

  it('says there is none when there is no version, and still offers the draft to those who manage', async () => {
    mount(<RubricScreen route={RUBRIC_ROUTE} />, open({ rubrics: [] }), { permissions: MANAGER });
    expect((await screen.findByTestId('no-rubric')).textContent).toBe(vi_['dgv.maturity.rubric.none']);
    expect(screen.getByRole('form', { name: vi_['dgv.maturity.draft.title'] })).toBeTruthy();
  });

  it('gives no form and no button to a read-only session', async () => {
    mount(<RubricScreen route={RUBRIC_ROUTE} />, open(), { permissions: [...MANAGER, ...PUBLISHER], mode: 'READ_ONLY' });
    await screen.findByTestId('rubric-table');
    expect(screen.queryByRole('form', { name: vi_['dgv.maturity.draft.title'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['dgv.maturity.rubric.publish'] })).toBeNull();
  });

  it.each(states)('UI-DGV-21 shows the %s state', async (_name, answer, title) => {
    mount(<RubricScreen route={RUBRIC_ROUTE} />, open({ rubrics: answer }), { permissions: MANAGER });
    expect(await screen.findByText(title)).toBeTruthy();
    expect(screen.queryByRole('form', { name: vi_['dgv.maturity.draft.title'] })).toBeNull();
  });

  it('shows the loading state while the versions are read', async () => {
    const h = open();
    h.readAll.mockImplementation(() => new Promise(() => undefined));
    mount(<RubricScreen route={RUBRIC_ROUTE} />, h, { permissions: MANAGER });
    expect(await screen.findByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
  });
});

describe('DGV-16, the assessment (ST-DGV-008, UAT-AC53, UAT-AC492)', () => {
  it('shows a total that is not computed as no total, the pillars with nothing assessed as not assessed, and what each criterion counts as', async () => {
    mount(<AssessmentScreen route={ASSESS_ROUTE} />, open(), { permissions: [READ] });
    const view = await screen.findByRole('region', { name: fill(vi_['dgv.maturity.assess.heading'], { period: '2026-H2' }) });
    await within(view).findByTestId('score');
    expect(within(view).getByTestId('coverage').textContent).toContain('33.33%');
    expect(within(view).getByTestId('coverage').textContent).toContain(fill(vi_['dgv.maturity.score.asked'], { share: '70.00' }));
    const overall = within(view).getByTestId('overall');
    expect(overall.getAttribute('data-state')).toBe('NOT_COMPUTED');
    expect(overall.textContent).toContain(vi_['dgv.maturity.overall.notComputed']);
    expect(overall.textContent).toContain(vi_['dgv.maturity.score.noTotal']);
    expect(within(view).getByTestId('counts').textContent).toContain(fill(vi_['dgv.maturity.score.countsValue'], { assessed: 1, notAssessed: 2, notApplicable: 0 }));
    const quality = view.querySelector('[data-pillar="QUALITY"]') as HTMLElement;
    expect(quality.getAttribute('data-state')).toBe('NOT_ASSESSED');
    expect(quality.textContent).toContain('—');
    expect(quality.textContent).not.toMatch(/\b[01]\b/);
    const done = view.querySelector('tr[data-criterion="GOV-1"]') as HTMLElement;
    expect(done.getAttribute('data-state')).toBe('ASSESSED');
    expect(done.textContent).toContain(vi_['dgv.maturity.review.accepted']);
    expect(done.textContent).toContain('2027-01-01');
    expect((view.querySelector('tr[data-criterion="QUAL-1"]') as HTMLElement).getAttribute('data-state')).toBe('NOT_ASSESSED');
    expect(within(view).getByTestId('assessor').textContent).toBe('Me');
    expect(within(view).getByTestId('reviewer').textContent).toBe('Reviewer');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows the total once it is computed', async () => {
    mount(<AssessmentScreen route={ASSESS_ROUTE} />, open({ score: score({ coverage_percent: '77.27', overall_state: 'COMPUTED', overall_level: '3.25' }) }), { permissions: [READ] });
    const overall = await screen.findByTestId('overall');
    expect(overall.textContent).toContain('3.25');
    expect(overall.textContent).not.toContain(vi_['dgv.maturity.score.noTotal']);
  });

  it('lets the assessor record a criterion against the version of its row, and shows what the server refuses', async () => {
    const user = userEvent.setup();
    const h = open({}, (_operation, input) => {
      if ((input as { body: { level?: number } }).body.level === 5) throw failure(422, 'EVIDENCE_EXPIRED');
      return { operation_id: 'o', status: 'ASSESSED', resource_version: 5, resource_id: ROW_OPEN };
    });
    mount(<AssessmentScreen route={ASSESS_ROUTE} />, h, { permissions: ASSESSOR });
    await user.click(await screen.findByRole('button', { name: fill(vi_['dgv.maturity.record.open'], { criterion: 'QUAL-1' }) }));
    const form = screen.getByRole('form', { name: fill(vi_['dgv.maturity.record.title'], { criterion: 'QUAL-1' }) });
    await user.click(within(form).getByRole('button', { name: vi_['dgv.maturity.record.submit'] }));
    expect(await within(form).findAllByText(vi_['dgv.maturity.form.required'])).toHaveLength(2);
    expect(h.command).not.toHaveBeenCalled();
    await user.selectOptions(within(form).getByLabelText(vi_['dgv.maturity.record.level']), '5');
    await user.type(within(form).getByLabelText(vi_['dgv.maturity.record.evidence']), 'nonsense');
    await user.click(within(form).getByRole('button', { name: vi_['dgv.maturity.record.submit'] }));
    expect(await within(form).findByText(vi_['dgv.maturity.record.evidence.invalid'])).toBeTruthy();
    await user.clear(within(form).getByLabelText(vi_['dgv.maturity.record.evidence']));
    await user.type(within(form).getByLabelText(vi_['dgv.maturity.record.evidence']), 'TEST run-1');
    await user.click(within(form).getByRole('button', { name: vi_['dgv.maturity.record.submit'] }));
    expect((await within(form).findByTestId('record-refusal')).getAttribute('data-reason')).toBe('expired');
    await user.selectOptions(within(form).getByLabelText(vi_['dgv.maturity.record.level']), '4');
    await user.click(within(form).getByRole('button', { name: vi_['dgv.maturity.record.submit'] }));
    await waitFor(() =>
      expect(h.command).toHaveBeenLastCalledWith(
        'recordMaturityEvidence',
        expect.objectContaining({
          path: { id: ASSESSMENT },
          ifMatchVersion: 4,
          body: { pillar_code: 'QUALITY', criterion_code: 'QUAL-1', assessment_state: 'ASSESSED', level: 4, evidence_refs: [{ kind: 'TEST', ref: 'run-1' }] },
        }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole('form', { name: fill(vi_['dgv.maturity.record.title'], { criterion: 'QUAL-1' }) })).toBeNull());
  });

  it('keeps what was typed for one criterion when another is saved and the assessment is read again', async () => {
    const user = userEvent.setup();
    const h = open();
    mount(<AssessmentScreen route={ASSESS_ROUTE} />, h, { permissions: ASSESSOR });
    await user.click(await screen.findByRole('button', { name: fill(vi_['dgv.maturity.record.open'], { criterion: 'GOV-2' }) }));
    await user.click(screen.getByRole('button', { name: fill(vi_['dgv.maturity.record.open'], { criterion: 'QUAL-1' }) }));
    const other = screen.getByRole('form', { name: fill(vi_['dgv.maturity.record.title'], { criterion: 'GOV-2' }) });
    await user.type(within(other).getByLabelText(vi_['dgv.maturity.record.evidence']), 'TEST half-typed');
    const saved = screen.getByRole('form', { name: fill(vi_['dgv.maturity.record.title'], { criterion: 'QUAL-1' }) });
    // Saving moves the version of the assessment: it is read again with the version that follows.
    const reads = h.readAll.getMockImplementation() as (operation: string) => Promise<unknown[]>;
    h.readAll.mockImplementation((operation: string) => (operation === 'get_resources_maturity_assessment' ? Promise.resolve([assessment({ version: 4 })]) : reads(operation)));
    await user.selectOptions(within(saved).getByLabelText(vi_['dgv.maturity.record.state']), 'NOT_ASSESSED');
    await user.click(within(saved).getByRole('button', { name: vi_['dgv.maturity.record.submit'] }));
    await waitFor(() => expect(screen.queryByRole('form', { name: fill(vi_['dgv.maturity.record.title'], { criterion: 'QUAL-1' }) })).toBeNull());
    // The assessment is read again with a version that moved; the form of the other criterion is as it was left.
    expect(
      (within(screen.getByRole('form', { name: fill(vi_['dgv.maturity.record.title'], { criterion: 'GOV-2' }) })).getByLabelText(vi_['dgv.maturity.record.evidence']) as HTMLTextAreaElement).value,
    ).toBe('TEST half-typed');
  });

  it('asks a reason for what is not applicable, and records a criterion as not assessed again', async () => {
    const user = userEvent.setup();
    const h = open();
    mount(<AssessmentScreen route={ASSESS_ROUTE} />, h, { permissions: ASSESSOR });
    await user.click(await screen.findByRole('button', { name: fill(vi_['dgv.maturity.record.open'], { criterion: 'GOV-2' }) }));
    const form = screen.getByRole('form', { name: fill(vi_['dgv.maturity.record.title'], { criterion: 'GOV-2' }) });
    await user.selectOptions(within(form).getByLabelText(vi_['dgv.maturity.record.state']), 'NOT_APPLICABLE');
    await user.click(within(form).getByRole('button', { name: vi_['dgv.maturity.record.submit'] }));
    expect(await within(form).findByText(vi_['dgv.maturity.form.required'])).toBeTruthy();
    await user.type(within(form).getByLabelText(vi_['dgv.maturity.record.na']), 'short');
    await user.click(within(form).getByRole('button', { name: vi_['dgv.maturity.record.submit'] }));
    expect(await within(form).findByText(vi_['dgv.maturity.record.na.invalid'])).toBeTruthy();
    await user.selectOptions(within(form).getByLabelText(vi_['dgv.maturity.record.state']), 'NOT_ASSESSED');
    await user.click(within(form).getByRole('button', { name: vi_['dgv.maturity.record.submit'] }));
    await waitFor(() =>
      expect(h.command).toHaveBeenCalledWith(
        'recordMaturityEvidence',
        expect.objectContaining({ body: { pillar_code: 'GOVERNANCE', criterion_code: 'GOV-2', assessment_state: 'NOT_ASSESSED', evidence_refs: [] } }),
      ),
    );
  });

  it('lets the reviewer accept or reject a record with a note, and shows the refusal of the server', async () => {
    const user = userEvent.setup();
    const h = open({ assessments: [assessment({ assessor: person(THIRD, 'Third'), reviewer: person(ME, 'Me') })] }, (_operation, input) => {
      if ((input as { body: { decision: string } }).body.decision === 'REJECTED') throw failure(403, 'SELF_APPROVAL_DENIED');
      return { operation_id: 'o', status: 'ACCEPTED', resource_version: 5, resource_id: ROW_PENDING };
    });
    mount(<AssessmentScreen route={ASSESS_ROUTE} />, h, { permissions: REVIEWER });
    // Only a record that waits can be reviewed.
    const accept = await screen.findByRole('button', { name: fill(vi_['dgv.maturity.review.accept'], { criterion: 'GOV-2' }) });
    expect(screen.queryByRole('button', { name: fill(vi_['dgv.maturity.review.accept'], { criterion: 'QUAL-1' }) })).toBeNull();
    expect(screen.queryByRole('button', { name: fill(vi_['dgv.maturity.review.accept'], { criterion: 'GOV-1' }) })).toBeNull();
    await user.click(accept);
    expect(await screen.findByText(vi_['dgv.maturity.review.note.required'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText(fill(vi_['dgv.maturity.review.note'], { criterion: 'GOV-2' })), '  The run was read and agreed.  ');
    await user.click(screen.getByRole('button', { name: fill(vi_['dgv.maturity.review.reject'], { criterion: 'GOV-2' }) }));
    expect((await screen.findByTestId('review-refusal')).getAttribute('data-reason')).toBe('self');
    await user.click(screen.getByRole('button', { name: fill(vi_['dgv.maturity.review.accept'], { criterion: 'GOV-2' }) }));
    await waitFor(() =>
      expect(h.command).toHaveBeenLastCalledWith(
        'reviewMaturityEvidence',
        expect.objectContaining({ path: { id: ROW_PENDING }, ifMatchVersion: 4, body: { decision: 'ACCEPTED', note: 'The run was read and agreed.' } }),
      ),
    );
  });

  it('shows the reviewer what was submitted - the level proposed, the evidence with its note, the sample, the confidence, and why a criterion does not apply - and not only what it counts for', async () => {
    const rows = [
      evidenceRow(ROW_PENDING, 'GOV-2', {
        assessment_state: 'ASSESSED',
        level: 4,
        evidence_refs: [
          { kind: 'TEST', ref: 'run-2026-10-30', note: 'the run that was read' },
          { kind: 'HEARSAY', ref: 'x' },
        ],
        sample_size: 30,
        confidence: 'HIGH',
      }),
      evidenceRow(ROW_OPEN, 'QUAL-1', { assessment_state: 'NOT_APPLICABLE', na_reason: 'The platform keeps no such data.' }),
      // The evidence of this one is not shown to the reader: the server counts it and sends none.
      evidenceRow(ROW_DONE, 'GOV-1', { assessment_state: 'ASSESSED', level: 3, review_status: 'ACCEPTED', evidence_count: 2, evidence_refs: [] }),
    ];
    mount(<AssessmentScreen route={ASSESS_ROUTE} />, open({ evidence: rows, assessments: [assessment({ assessor: person(THIRD, 'Third'), reviewer: person(ME, 'Me') })] }), { permissions: REVIEWER });
    const submitted = await screen.findByTestId('submitted-GOV-2');
    expect(submitted.textContent).toContain('4');
    expect(submitted.textContent).toContain(vi_['dgv.maturity.kind.test']);
    expect(submitted.textContent).toContain('run-2026-10-30 (the run that was read)');
    expect(submitted.textContent).toContain('HEARSAY: x');
    expect(submitted.textContent).toContain('30');
    expect(submitted.textContent).toContain(vi_['dgv.maturity.confidence.high']);
    expect(screen.getByTestId('submitted-QUAL-1').textContent).toContain('The platform keeps no such data.');
    expect(screen.getByTestId('hidden-GOV-1').textContent).toBe(fill(vi_['dgv.maturity.submitted.hidden'], { count: 2 }));
    expect(screen.queryByTestId('hidden-GOV-2')).toBeNull();
    expect(screen.queryByTestId('submitted-QUAL-2')).toBeNull();
  });

  it('opens the assessment that the link of a notification names', async () => {
    const other = assessment({ id: '00000000-0000-4000-8000-0000000000d2', period_code: '2025-H1', status: 'DRAFT', created_at: '2025-07-01T00:00:00Z' });
    mount(<AssessmentScreen route={ASSESS_ROUTE} />, open({ assessments: [assessment(), other] }), { permissions: [READ] }, `/?assessment=${other.id}`);
    expect(await screen.findByRole('region', { name: fill(vi_['dgv.maturity.assess.heading'], { period: '2025-H1' }) })).toBeTruthy();
    cleanup();
    mount(<AssessmentScreen route={ASSESS_ROUTE} />, open({ assessments: [assessment(), other] }), { permissions: [READ] }, '/?assessment=00000000-0000-4000-8000-0000000000ff');
    expect(await screen.findByRole('region', { name: fill(vi_['dgv.maturity.assess.heading'], { period: '2026-H2' }) })).toBeTruthy();
  });

  it('lets somebody other than the assessor publish, return or reject, with a reason, against the version that was read', async () => {
    const user = userEvent.setup();
    const h = open({ assessments: [assessment({ assessor: person(THIRD, 'Third') })] }, (_operation, input) => {
      if ((input as { body: { decision: string } }).body.decision === 'reject') throw failure(409, 'STAGE_TRANSITION_DENIED');
      return { operation_id: 'o', status: 'PUBLISHED', resource_version: 4, resource_id: ASSESSMENT };
    });
    mount(<AssessmentScreen route={ASSESS_ROUTE} />, h, { permissions: PUBLISHER });
    const form = await screen.findByRole('form', { name: vi_['dgv.maturity.decide.title'] });
    await user.click(within(form).getByRole('button', { name: vi_['dgv.maturity.decide.approve'] }));
    expect(await within(form).findByText(vi_['dgv.maturity.decide.reason.required'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.type(within(form).getByLabelText(vi_['dgv.maturity.decide.reason']), 'Read and agreed');
    await user.click(within(form).getByRole('button', { name: vi_['dgv.maturity.decide.reject'] }));
    expect((await within(form).findByTestId('decide-refusal')).getAttribute('data-reason')).toBe('state');
    await user.click(within(form).getByRole('button', { name: vi_['dgv.maturity.decide.approve'] }));
    await waitFor(() =>
      expect(h.command).toHaveBeenLastCalledWith(
        'post_maturity_assessments_id_publish',
        expect.objectContaining({ path: { id: ASSESSMENT }, ifMatchVersion: 3, body: { decision: 'approve', reason: 'Read and agreed', evidence_ids: [] } }),
      ),
    );
    await user.click(within(form).getByRole('button', { name: vi_['dgv.maturity.decide.return'] }));
    await waitFor(() => expect(h.command).toHaveBeenLastCalledWith('post_maturity_assessments_id_publish', expect.objectContaining({ body: expect.objectContaining({ decision: 'return' }) })));
  });

  it('gives no button to who assessed it, to a read-only session, to a published assessment, or to who has no right', async () => {
    mount(<AssessmentScreen route={ASSESS_ROUTE} />, open(), { permissions: [...PUBLISHER, ...REVIEWER] });
    await screen.findByTestId('criteria');
    expect(screen.queryByRole('form', { name: vi_['dgv.maturity.decide.title'] })).toBeNull();
    cleanup();
    mount(<AssessmentScreen route={ASSESS_ROUTE} />, open(), { permissions: [...ASSESSOR, ...PUBLISHER], mode: 'READ_ONLY' });
    await screen.findByTestId('criteria');
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    mount(
      <AssessmentScreen route={ASSESS_ROUTE} />,
      open({ assessments: [assessment({ status: 'PUBLISHED', assessor: person(THIRD, 'Third'), overall_state: 'NOT_COMPUTED' })], score: score({ status: 'PUBLISHED' }) }),
      { permissions: [...ASSESSOR, ...PUBLISHER, ...REVIEWER] },
    );
    await screen.findByTestId('criteria');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('form', { name: vi_['dgv.maturity.decide.title'] })).toBeNull();
  });

  it('starts an assessment: the form is checked, the reviewer is another person, the refusal of the server is shown, and what was started is said so', async () => {
    const user = userEvent.setup();
    const h = open({}, (_operation, input) => {
      if ((input as { body: { period_code: string } }).body.period_code === '2026-H2') throw failure(409, 'DUPLICATE_KEY', 'period_code');
      return { operation_id: 'o', status: 'DRAFT', resource_version: 1, resource_id: ASSESSMENT };
    });
    mount(<AssessmentScreen route={ASSESS_ROUTE} />, h, { permissions: MANAGER });
    const form = await screen.findByRole('form', { name: vi_['dgv.maturity.start.title'] });
    await user.click(within(form).getByRole('button', { name: vi_['dgv.maturity.start.submit'] }));
    expect(await within(form).findAllByText(vi_['dgv.maturity.form.required'])).toHaveLength(4);
    // Only a published rubric is offered.
    expect(
      within(form)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).not.toContain(fill(vi_['dgv.maturity.rubric.heading'], { code: 'RB-1', revision: 2 }));
    await user.selectOptions(within(form).getByLabelText(vi_['dgv.maturity.start.rubric']), RUBRIC);
    await user.type(within(form).getByLabelText(vi_['dgv.maturity.start.period']), '2026-H2');
    await user.selectOptions(within(form).getByLabelText(vi_['dgv.maturity.start.assessor']), ME);
    await user.selectOptions(within(form).getByLabelText(vi_['dgv.maturity.start.reviewer']), ME);
    await user.click(within(form).getByRole('button', { name: vi_['dgv.maturity.start.submit'] }));
    expect(await within(form).findByText(vi_['dgv.maturity.start.reviewer.same'])).toBeTruthy();
    await user.selectOptions(within(form).getByLabelText(vi_['dgv.maturity.start.reviewer']), OTHER);
    await user.click(within(form).getByRole('button', { name: vi_['dgv.maturity.start.submit'] }));
    expect((await within(form).findByTestId('start-refusal')).getAttribute('data-reason')).toBe('duplicate');
    await user.selectOptions(within(form).getByLabelText(vi_['dgv.maturity.start.scope']), 'DOMAIN');
    await user.click(within(form).getByRole('button', { name: vi_['dgv.maturity.start.submit'] }));
    expect((await within(form).findAllByText(vi_['dgv.maturity.form.required'])).length).toBeGreaterThan(0);
    await user.type(within(form).getByLabelText(vi_['dgv.maturity.start.scopeRef']), 'TREASURY');
    await user.clear(within(form).getByLabelText(vi_['dgv.maturity.start.period']));
    await user.type(within(form).getByLabelText(vi_['dgv.maturity.start.period']), '2026-H3');
    await user.click(within(form).getByRole('button', { name: vi_['dgv.maturity.start.submit'] }));
    expect(await within(form).findByTestId('start-saved')).toBeTruthy();
    expect(h.command).toHaveBeenLastCalledWith(
      'createMaturityAssessment',
      expect.objectContaining({ body: { period_code: '2026-H3', rubric_version_id: RUBRIC, scope_kind: 'DOMAIN', scope_ref: 'TREASURY', assessor_user_id: ME, reviewer_id: OTHER } }),
    );
  });

  it('says the people cannot be chosen when the members cannot be read', async () => {
    mount(<AssessmentScreen route={ASSESS_ROUTE} />, open(), { permissions: [READ, 'data.maturity.manage'] });
    expect((await screen.findByTestId('members-unavailable')).textContent).toBe(vi_['dgv.maturity.start.membersDenied']);
    cleanup();
    mount(<AssessmentScreen route={ASSESS_ROUTE} />, open({ members: failure(500, 'INTERNAL_ERROR') }), { permissions: MANAGER });
    expect((await screen.findByTestId('members-unavailable')).textContent).toBe(vi_['dgv.maturity.start.membersFailed']);
  });

  it('says there is none when there is no assessment, and offers the start to those who manage', async () => {
    mount(<AssessmentScreen route={ASSESS_ROUTE} />, open({ assessments: [] }), { permissions: MANAGER });
    expect((await screen.findByTestId('no-assessment')).textContent).toBe(vi_['dgv.maturity.assess.none']);
    expect(screen.getByRole('form', { name: vi_['dgv.maturity.start.title'] })).toBeTruthy();
  });

  it('chooses another assessment', async () => {
    const user = userEvent.setup();
    const other = assessment({ id: '00000000-0000-4000-8000-0000000000d2', period_code: '2027-H1', status: 'DRAFT' });
    const h = open({ assessments: [assessment(), other] });
    mount(<AssessmentScreen route={ASSESS_ROUTE} />, h, { permissions: [READ] });
    await screen.findByRole('region', { name: fill(vi_['dgv.maturity.assess.heading'], { period: '2026-H2' }) });
    await user.selectOptions(screen.getByLabelText(vi_['dgv.maturity.assess.choose']), '00000000-0000-4000-8000-0000000000d2');
    expect(await screen.findByRole('region', { name: fill(vi_['dgv.maturity.assess.heading'], { period: '2027-H1' }) })).toBeTruthy();
    expect(h.read).toHaveBeenCalledWith('getMaturityScore', { path: { id: '00000000-0000-4000-8000-0000000000d2' } });
  });

  it.each(states)('UI-DGV-16 shows the %s state', async (_name, answer, title) => {
    mount(<AssessmentScreen route={ASSESS_ROUTE} />, open({ assessments: answer }), { permissions: MANAGER });
    expect(await screen.findByText(title)).toBeTruthy();
    expect(screen.queryByRole('form', { name: vi_['dgv.maturity.start.title'] })).toBeNull();
  });

  it('holds the score and the criteria back when they cannot be read, and reads them again on retry', async () => {
    const user = userEvent.setup();
    const h = open({ score: failure(500, 'INTERNAL_ERROR') });
    mount(<AssessmentScreen route={ASSESS_ROUTE} />, h, { permissions: [READ] });
    const view = await screen.findByRole('region', { name: fill(vi_['dgv.maturity.assess.heading'], { period: '2026-H2' }) });
    expect(await within(view).findByText(vi_['states.error.title'])).toBeTruthy();
    expect(within(view).queryByTestId('criteria')).toBeNull();
    h.read.mockImplementation(() => Promise.resolve(score()));
    await user.click(within(view).getByRole('button', { name: vi_['states.retry.action'] }));
    expect(await within(view).findByTestId('criteria')).toBeTruthy();
  });

  it('shows the loading state while the assessments are read', async () => {
    const h = open();
    h.readAll.mockImplementation(() => new Promise(() => undefined));
    mount(<AssessmentScreen route={ASSESS_ROUTE} />, h, { permissions: MANAGER });
    expect(await screen.findByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
  });
});

describe('DGV-17, the roadmap (ST-DGV-008, UAT-AC494)', () => {
  it('shows each milestone with its pillar, the level to reach, its day, its owner, the criteria to leave by, the evidence needed and where it stands', async () => {
    const achieved = milestone('00000000-0000-4000-8000-0000000000f2', { status: 'ACHIEVED', pillar_code: 'SECURITY', achieved_assessment_id: ASSESSMENT });
    const missed = milestone('00000000-0000-4000-8000-0000000000f3', { status: 'MISSED', pillar_code: 'GOVERNANCE' });
    mount(<RoadmapScreen route={ROAD_ROUTE} />, open({ milestones: [milestone(MILESTONE), achieved, missed] }), { permissions: [READ] });
    const table = await screen.findByTestId('milestones');
    const planned = table.querySelector(`[data-milestone="${MILESTONE}"]`) as HTMLElement;
    expect(planned.getAttribute('data-status')).toBe('PLANNED');
    expect(planned.textContent).toContain(vi_['dgv.maturity.pillar.quality']);
    expect(planned.textContent).toContain('2030-12-31');
    expect(planned.textContent).toContain('Milestone owner');
    expect(planned.textContent).toContain('a scorecard; a log');
    expect(planned.textContent).toContain(vi_['dgv.maturity.milestone.status.planned']);
    expect(table.querySelector('[data-status="ACHIEVED"]')?.textContent).toContain(vi_['dgv.maturity.road.provedBy']);
    expect(table.querySelector('[data-status="MISSED"]')?.textContent).toContain(vi_['dgv.maturity.milestone.status.missed']);
    expect(screen.getByTestId('road-rule').textContent).toBe(vi_['dgv.maturity.road.rule']);
    expect(screen.queryByRole('form', { name: vi_['dgv.maturity.plan.title'] })).toBeNull();
  });

  it('marks the milestone that the link of a notification names', async () => {
    const other = milestone('00000000-0000-4000-8000-0000000000f2');
    mount(<RoadmapScreen route={ROAD_ROUTE} />, open({ milestones: [milestone(MILESTONE), other] }), { permissions: [READ] }, `/?milestone=${other.id}`);
    const table = await screen.findByTestId('milestones');
    expect(table.querySelector(`[data-milestone="${other.id}"]`)?.getAttribute('aria-current')).toBe('true');
    expect(table.querySelector(`[data-milestone="${MILESTONE}"]`)?.hasAttribute('aria-current')).toBe(false);
  });

  it('plans a milestone: the form is checked, the refusal of the server is shown, and what was planned is said so', async () => {
    const user = userEvent.setup();
    const h = open({}, (_operation, input) => {
      if ((input as { body: { target_level: number } }).body.target_level === 2) throw failure(422, 'TARGET_BELOW_CURRENT', 'target_level');
      return { operation_id: 'o', status: 'PLANNED', resource_version: 1, resource_id: MILESTONE };
    });
    mount(<RoadmapScreen route={ROAD_ROUTE} />, h, { permissions: MANAGER });
    const form = await screen.findByRole('form', { name: vi_['dgv.maturity.plan.title'] });
    await user.click(within(form).getByRole('button', { name: vi_['dgv.maturity.plan.submit'] }));
    expect(await within(form).findAllByText(vi_['dgv.maturity.form.required'])).toHaveLength(5);
    expect(h.command).not.toHaveBeenCalled();
    await user.selectOptions(within(form).getByLabelText(vi_['dgv.maturity.start.rubric']), RUBRIC);
    await user.selectOptions(within(form).getByLabelText(vi_['dgv.maturity.plan.target']), '2');
    await user.type(within(form).getByLabelText(vi_['dgv.maturity.plan.due']), '2030-12-31');
    await user.selectOptions(within(form).getByLabelText(vi_['dgv.maturity.col.owner']), OTHER);
    await user.type(within(form).getByLabelText(vi_['dgv.maturity.col.exit']), 'short');
    await user.click(within(form).getByRole('button', { name: vi_['dgv.maturity.plan.submit'] }));
    expect(await within(form).findByText(vi_['dgv.maturity.plan.exit.invalid'])).toBeTruthy();
    await user.clear(within(form).getByLabelText(vi_['dgv.maturity.col.exit']));
    await user.type(within(form).getByLabelText(vi_['dgv.maturity.col.exit']), 'The quality score is published');
    await user.type(within(form).getByLabelText(vi_['dgv.maturity.col.evidenceNeeded']), 'a scorecard');
    await user.click(within(form).getByRole('button', { name: vi_['dgv.maturity.plan.submit'] }));
    expect((await within(form).findByTestId('plan-refusal')).getAttribute('data-reason')).toBe('targetBelow');
    await user.selectOptions(within(form).getByLabelText(vi_['dgv.maturity.plan.target']), '3');
    await user.click(within(form).getByRole('button', { name: vi_['dgv.maturity.plan.submit'] }));
    expect(await within(form).findByTestId('plan-saved')).toBeTruthy();
    expect(h.command).toHaveBeenLastCalledWith(
      'createMaturityMilestone',
      expect.objectContaining({
        body: {
          rubric_version_id: RUBRIC,
          pillar_code: 'QUALITY',
          target_level: 3,
          due_on: '2030-12-31',
          owner_user_id: OTHER,
          exit_criteria: 'The quality score is published',
          evidence_required: ['a scorecard'],
        },
      }),
    );
  });

  it('says there is none when the roadmap is empty, says the people cannot be chosen when the members cannot be read, and gives no form to a read-only session', async () => {
    mount(<RoadmapScreen route={ROAD_ROUTE} />, open({ milestones: [] }), { permissions: [READ, 'data.maturity.manage'] });
    expect((await screen.findByTestId('no-milestones')).textContent).toBe(vi_['dgv.maturity.road.none']);
    expect(screen.getByTestId('members-unavailable').textContent).toBe(vi_['dgv.maturity.start.membersDenied']);
    cleanup();
    mount(<RoadmapScreen route={ROAD_ROUTE} />, open({ milestones: [], members: failure(500, 'INTERNAL_ERROR') }), { permissions: MANAGER });
    expect((await screen.findByTestId('members-unavailable')).textContent).toBe(vi_['dgv.maturity.start.membersFailed']);
    cleanup();
    mount(<RoadmapScreen route={ROAD_ROUTE} />, open(), { permissions: MANAGER, mode: 'READ_ONLY' });
    await screen.findByTestId('milestones');
    expect(screen.queryByRole('form', { name: vi_['dgv.maturity.plan.title'] })).toBeNull();
  });

  it.each(states)('UI-DGV-17 shows the %s state', async (_name, answer, title) => {
    mount(<RoadmapScreen route={ROAD_ROUTE} />, open({ milestones: answer }), { permissions: MANAGER });
    expect(await screen.findByText(title)).toBeTruthy();
    expect(screen.queryByRole('form', { name: vi_['dgv.maturity.plan.title'] })).toBeNull();
  });

  it('shows the loading state while the milestones are read', async () => {
    const h = open();
    h.readAll.mockImplementation(() => new Promise(() => undefined));
    mount(<RoadmapScreen route={ROAD_ROUTE} />, h, { permissions: MANAGER });
    expect(await screen.findByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
  });
});
