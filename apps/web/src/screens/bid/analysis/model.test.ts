import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_FORM,
  NO_FINDING_FILTER,
  canCancel,
  canStart,
  configPath,
  describeProblem,
  endedWithoutAnswer,
  failureKind,
  findingQuery,
  findingStatusFromParam,
  formatVnd,
  hasFindingFilter,
  hasFindings,
  holds,
  isCancellable,
  missingFromParam,
  progressPath,
  readFailure,
  runStatusFromParam,
  startBody,
  toEvidence,
  toFinding,
  toFindingList,
  toRun,
  toRunList,
  toStarted,
  validateForm,
  validateReason,
  workbenchPath,
} from './model';
import type { Run } from './model';
import { calcEvidence, documentEvidence, failedRun, finding, run, runId, unsupported } from './test-support';

const problem = (code: string, status = 422): ApiError => new ApiError({ status, code, correlationId: 'c', extensions: {} });
const UUID = '00000000-0000-4000-8000-000000000001';
const PACKAGE_UUID = '00000000-0000-4000-8000-000000000002';
const parsed = (raw: unknown): Run => toRun(raw) as Run;

describe('the model of the analysis screens (BID-07, BID-08, BID-09)', () => {
  describe('permissions', () => {
    it('holds a permission, or is not told yet which are held', () => {
      expect(holds(undefined, 'ai.analyze')).toBe(true);
      expect(holds(['ai.analyze'], 'ai.analyze')).toBe(true);
      expect(holds(['bid.read'], 'ai.analyze')).toBe(false);
    });

    it('offers the request and the cancellation only to a caller who holds the right in a session that is not read-only', () => {
      expect(canStart(['ai.analyze'], 'FULL')).toBe(true);
      expect(canStart(['ai.analyze'], undefined)).toBe(true);
      expect(canStart(['ai.analyze'], 'READ_ONLY')).toBe(false);
      expect(canStart(['bid.read'], 'FULL')).toBe(false);
      expect(canCancel(['ai.cancel'], 'FULL')).toBe(true);
      expect(canCancel(['ai.cancel'], 'READ_ONLY')).toBe(false);
      expect(canCancel(['ai.analyze'], 'FULL')).toBe(false);
    });
  });

  describe('runs', () => {
    it('reads a run with its timeline, its route and its counts', () => {
      expect(parsed(run(1))).toEqual({
        id: runId(1),
        proposalId: expect.any(String),
        packageId: expect.any(String),
        packageCode: 'GT-1',
        contractorName: 'Công ty nhà thầu 1',
        criteriaVersionId: expect.any(String),
        profileVersionId: expect.any(String),
        status: 'AWAITING_REVIEW',
        dataClassification: 'CONFIDENTIAL',
        routeClass: 'DOMESTIC_HOSTED',
        policyVersionId: expect.any(String),
        failureCode: null,
        failedStep: null,
        timeline: [
          { step: 'EXTRACT', state: 'DONE' },
          { step: 'MATCH', state: 'DONE' },
          { step: 'VERIFY', state: 'DONE' },
          { step: 'COMPLETE', state: 'PENDING' },
        ],
        supersedesRunId: null,
        startedAt: '2026-12-05T03:00:00.000Z',
        finishedAt: '2026-12-05T03:01:00.000Z',
        cancelReason: null,
        costVnd: '1234567',
        findingCount: 5,
        missingSourceCount: 1,
        reviewedCount: 0,
        version: 2,
      });
      expect(parsed(failedRun(2))).toMatchObject({ status: 'FAILED', failureCode: 'AI_ROUTE_EXHAUSTED', failedStep: 'MATCH', routeClass: 'SELF_HOSTED' });
    });

    it('takes what it cannot read for the defaults and refuses a run it cannot place', () => {
      const lean = parsed({ ...run(1), package: { id: UUID }, contractor: null, route_class: 'ELSEWHERE', policy_version_id: 5, failed_step: 'NOWHERE', timeline: [{ step: 'EXTRACT', state: 'DONE' }, { step: 'X', state: 'DONE' }, 'x'], finding_count: 'many' });
      expect(lean).toMatchObject({ packageCode: '', contractorName: '', routeClass: null, policyVersionId: null, failedStep: null, findingCount: 0, criteriaVersionId: expect.any(String) });
      expect(lean.timeline).toEqual([{ step: 'EXTRACT', state: 'DONE' }]);
      expect(parsed({ ...run(1), timeline: 'none', criteria_version_id: undefined, profile_version_id: undefined })).toMatchObject({ timeline: [], criteriaVersionId: '', profileVersionId: '' });
      for (const broken of [null, 'x', [], {}, { ...run(1), id: 5 }, { ...run(1), proposal_id: null }, { ...run(1), package: null }, { ...run(1), status: 'DONE' }, { ...run(1), data_classification: 'SECRET' }, { ...run(1), version: '2' }, { ...run(1), started_at: null }]) {
        expect(toRun(broken)).toBeUndefined();
      }
    });

    it('reads a page of runs and the cursor, and drops the lines it cannot read', () => {
      expect(toRunList({ items: [run(1), { nope: true }, run(2)], next_cursor: '2' })).toMatchObject({ runs: [{ id: runId(1) }, { id: runId(2) }], nextCursor: '2' });
      expect(toRunList({ items: [], next_cursor: null })).toEqual({ runs: [], nextCursor: undefined });
      expect(toRunList('x')).toEqual({ runs: [], nextCursor: undefined });
    });

    it('shows a cost as whole VND by its digits, and nothing for what is not one', () => {
      expect(formatVnd('1234567', 'en')).toBe('1,234,567');
      expect(formatVnd('123456789012345678', 'en')).toBe('123,456,789,012,345,678');
      expect(formatVnd('0', 'en')).toBe('0');
      expect(formatVnd(null, 'en')).toBe('');
      expect(formatVnd('12.5', 'en')).toBe('');
    });

    it('offers the cancellation of a run that waits for the experts with no finding reviewed, and of no other', () => {
      expect(isCancellable(parsed(run(1)), true)).toBe(true);
      expect(isCancellable(parsed(run(1)), false)).toBe(false);
      expect(isCancellable(parsed(run(1, { reviewed_count: 1 })), true)).toBe(false);
      for (const status of ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'REJECTED_BY_POLICY']) expect(isCancellable(parsed(run(1, { status })), true)).toBe(false);
      expect(hasFindings(parsed(run(1)))).toBe(true);
      expect(hasFindings(parsed(failedRun(1)))).toBe(false);
    });

    it('asks for a reason of three to a thousand characters, counted without the space around it', () => {
      expect(validateReason('Chọn nhầm bộ tiêu chí')).toBeUndefined();
      expect(validateReason('abc')).toBeUndefined();
      expect(validateReason('x'.repeat(1000))).toBeUndefined();
      expect(validateReason('  ab  ')).toBe('tooShort');
      expect(validateReason('')).toBe('tooShort');
      expect(validateReason('x'.repeat(1001))).toBe('tooLong');
    });
  });

  describe('findings and their evidence', () => {
    it('reads a citation of a page and one of a figure, and takes a citation to be unverified unless the server says it was found', () => {
      expect(toEvidence(documentEvidence(1))).toMatchObject({ kind: 'DOCUMENT', pageIndex: 11, quote: 'đã hoàn thành ba cây cầu', verified: true, figure: null });
      expect(toEvidence(calcEvidence(2))).toMatchObject({ kind: 'DETERMINISTIC_CALC', pageIndex: null, quote: null, figure: { id: 'price-check', kind: 'PRICE_CHECK', total: '17650000000' }, verified: true });
      expect(toEvidence({ ...documentEvidence(1), verified_present: 'yes' })?.verified).toBe(false);
      expect(toEvidence({ ...calcEvidence(2), calc_ref: { id: 't', kind: 'TABLE_TOTAL', total: '4000' } })?.figure).toEqual({ id: 't', kind: 'TABLE_TOTAL', total: '4000' });
      expect(toEvidence({ ...calcEvidence(2), calc_ref: { id: 'bare' } })?.figure).toEqual({ id: 'bare', kind: '', total: null });
      expect(toEvidence({ ...calcEvidence(2), calc_ref: { kind: 'X' } })?.figure).toBeNull();
      expect(toEvidence({ ...documentEvidence(1), page_index: 'x', document_version_id: 5 })).toMatchObject({ pageIndex: null, documentVersionId: null });
      for (const broken of [null, 'x', {}, { ...documentEvidence(1), id: 5 }, { ...documentEvidence(1), kind: 'GUESS' }]) expect(toEvidence(broken)).toBeUndefined();
    });

    it('reads a finding with its signal, its flag and its evidence, and refuses one it cannot place', () => {
      expect(toFinding(finding(1))).toMatchObject({ criterionId: 'C1', status: 'SUPPORTED', confidenceType: 'HEURISTIC', evidenceCount: 1, missingSource: false, finalStatus: null, evidence: [{ verified: true }] });
      expect(toFinding(unsupported(5))).toMatchObject({ status: 'NEEDS_REVIEW', missingSource: true, evidenceCount: 0, evidence: [] });
      expect(toFinding({ ...finding(1), confidence_type: 'PERCENT', evidence_count: 'x', final_status: 'SUPPORTED', evidence: 'none' })).toMatchObject({ confidenceType: 'NONE', evidenceCount: 0, finalStatus: 'SUPPORTED', evidence: [] });
      for (const broken of [null, 'x', {}, { ...finding(1), id: 5 }, { ...finding(1), criterion_id: null }, { ...finding(1), status: 'APPROVED' }, { ...finding(1), finding: null }]) expect(toFinding(broken)).toBeUndefined();
    });

    it('reads a page of findings with the run they belong to', () => {
      const list = toFindingList({ run: run(1), items: [finding(1), { nope: 1 }], next_cursor: 'abc' });
      expect(list.run?.id).toBe(runId(1));
      expect(list.findings).toHaveLength(1);
      expect(list.nextCursor).toBe('abc');
      expect(toFindingList(null)).toEqual({ run: undefined, findings: [], nextCursor: undefined });
    });
  });

  describe('filters', () => {
    it('keeps from the address only what is a status or a flag, and asks the server only for what is chosen', () => {
      expect(findingStatusFromParam('MISSING')).toBe('MISSING');
      expect(findingStatusFromParam('APPROVED')).toBe('');
      expect(findingStatusFromParam(null)).toBe('');
      expect(missingFromParam('true')).toBe('true');
      expect(missingFromParam('false')).toBe('false');
      expect(missingFromParam('maybe')).toBe('');
      expect(runStatusFromParam('FAILED')).toBe('FAILED');
      expect(runStatusFromParam('x')).toBe('');
      expect(findingQuery(NO_FINDING_FILTER)).toEqual({});
      expect(findingQuery({ status: 'SUPPORTED', missingSource: 'false' })).toEqual({ status: 'SUPPORTED', missing_source: 'false' });
      expect(findingQuery({ status: '', missingSource: 'true' })).toEqual({ missing_source: 'true' });
      expect(hasFindingFilter(NO_FINDING_FILTER)).toBe(false);
      expect(hasFindingFilter({ status: 'MISSING', missingSource: '' })).toBe(true);
      expect(hasFindingFilter({ status: '', missingSource: 'true' })).toBe(true);
    });
  });

  describe('the request of a run', () => {
    const form = { proposalId: UUID, criteriaVersionId: UUID, profileVersionId: UUID, maxCostVnd: '' };

    it('judges the form in the order of its fields', () => {
      expect(validateForm(form)).toBeUndefined();
      expect(validateForm(EMPTY_FORM)).toBe('proposal');
      expect(validateForm({ ...form, criteriaVersionId: '' })).toBe('criteria');
      expect(validateForm({ ...form, profileVersionId: 'abc' })).toBe('profile');
      expect(validateForm({ ...form, profileVersionId: ` ${UUID.toUpperCase()} ` })).toBeUndefined();
      expect(validateForm({ ...form, maxCostVnd: ' 5000 ' })).toBeUndefined();
      expect(validateForm({ ...form, maxCostVnd: '0' })).toBeUndefined();
      for (const cost of ['12x', '012', '-5', '1.5', '1'.repeat(19)]) expect(validateForm({ ...form, maxCostVnd: cost })).toBe('cost');
    });

    it('sends the proposal, the criteria and the profile, and the cost limit only when there is one; never the class or the route', () => {
      expect(startBody(form)).toEqual({ proposal_id: UUID, criteria_version_id: UUID, profile_version_id: UUID });
      expect(startBody({ ...form, profileVersionId: ` ${UUID.toUpperCase()} `, maxCostVnd: ' 5000 ' })).toEqual({ proposal_id: UUID, criteria_version_id: UUID, profile_version_id: UUID, max_cost_vnd: '5000' });
    });

    it('reads the answer to the request, and which ends left no answer', () => {
      expect(toStarted({ resource_id: runId(1), status: 'AWAITING_REVIEW', reused: true, failure_code: null })).toEqual({ runId: runId(1), status: 'AWAITING_REVIEW', reused: true, failureCode: null });
      expect(toStarted({ resource_id: runId(1), status: 'FAILED', failure_code: 'AI_ROUTE_EXHAUSTED' })).toEqual({ runId: runId(1), status: 'FAILED', reused: false, failureCode: 'AI_ROUTE_EXHAUSTED' });
      for (const broken of [null, {}, { status: 'FAILED' }, { resource_id: runId(1) }]) expect(toStarted(broken)).toBeUndefined();
      expect(endedWithoutAnswer('FAILED')).toBe(true);
      expect(endedWithoutAnswer('REJECTED_BY_POLICY')).toBe(true);
      expect(endedWithoutAnswer('AWAITING_REVIEW')).toBe(false);
    });

    it('words the code of an end without an answer', () => {
      expect(failureKind(null)).toBeUndefined();
      const expected: Array<[string, string]> = [
        ['AI_ROUTE_EXHAUSTED', 'routeExhausted'],
        ['REJECTED_NO_CITATION', 'noCitation'],
        ['OUTPUT_INVALID', 'outputInvalid'],
        ['AI_ROUTE_NOT_ALLOWED', 'routeNotAllowed'],
        ['COST_ABOVE_LIMIT', 'costAboveLimit'],
        ['BUDGET_EXCEEDED', 'budget'],
        ['BUDGET_APPROVAL_REQUIRED', 'budget'],
        ['AI_KILL_SWITCH_ENGAGED', 'killSwitch'],
        ['INVALID_JSON', 'invalidJson'],
        ['SOMETHING_NEW', 'other'],
      ];
      for (const [code, kind] of expected) expect(failureKind(code)).toBe(kind);
    });
  });

  describe('refusals', () => {
    it('words the refusal of the server', () => {
      const expected: Array<[string, string]> = [
        ['CONFLICT_UNDECLARED', 'undeclared'],
        ['OCR_REVIEW_PENDING', 'ocrPending'],
        ['OCR_NOT_RECORDED', 'ocrNotRecorded'],
        ['CRITERIA_STATE_INVALID', 'criteriaState'],
        ['PROFILE_NOT_PUBLISHED', 'profile'],
        ['TOOL_NOT_READ_ONLY', 'tools'],
        ['AI_ROUTE_NOT_ALLOWED', 'routeNotAllowed'],
        ['BUDGET_EXCEEDED', 'budget'],
        ['AI_KILL_SWITCH_ENGAGED', 'killSwitch'],
        ['VALIDATION_FAILED', 'validation'],
        ['INVALID_REQUEST', 'validation'],
        ['FIELD_NOT_ALLOWED', 'validation'],
        ['RESOURCE_NOT_FOUND', 'notFound'],
        ['ANALYSIS_STATE_INVALID', 'state'],
        ['VERSION_CONFLICT', 'conflict'],
        ['SCOPE_DENIED', 'denied'],
        ['ENTITLEMENT_DENIED', 'denied'],
        ['SESSION_EXPIRED', 'session'],
        ['SOMETHING_NEW', 'general'],
      ];
      for (const [code, kind] of expected) expect(describeProblem(problem(code))).toBe(kind);
      expect(describeProblem(new Error('down'))).toBe('general');
    });

    it('tells a run that does not exist for the caller, and one they owe a declaration for, from every other failure of the read', () => {
      expect(readFailure(problem('RESOURCE_NOT_FOUND', 404))).toBe('notFound');
      expect(readFailure(problem('CONFLICT_UNDECLARED', 403))).toBe('undeclared');
      expect(readFailure(problem('SCOPE_DENIED', 403))).toBeUndefined();
      expect(readFailure(new Error('down'))).toBeUndefined();
      expect(readFailure(undefined)).toBeUndefined();
    });
  });

  it('builds the addresses of the screens', () => {
    expect(progressPath(runId(1))).toBe(`/bid/bid-08?run=${runId(1)}`);
    expect(workbenchPath(runId(1))).toBe(`/bid/bid-09?run=${runId(1)}`);
    expect(configPath(PACKAGE_UUID, UUID)).toBe(`/bid/bid-07?package=${PACKAGE_UUID}&proposal=${UUID}`);
  });
});
