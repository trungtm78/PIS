import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_PATH,
  DECIDE_PERMISSION,
  EMPTY_PUBLISH_FORM,
  baseOf,
  computeImpact,
  describeApprovalProblem,
  firstToWorkOn,
  mayAct,
  publishBody,
  validatePublishForm,
  validateReason,
} from './approval-model';
import { decisionRows } from './decision-model';
import { toAppropriation } from './model';
import { toPlan, toPlanLine } from './plan-model';
import type { PlanLine, PlanSummary } from './plan-model';
import { ANNUAL_ID, BILLION, MEDIUM_ID, PUBLISHED_ID, appropriationLine, plan, planLine, planWorld } from './plan-test-support';

const vnd = (billions: number): string => String(billions * BILLION);
const lineOf = (raw: Record<string, unknown>): PlanLine => toPlanLine(raw) as PlanLine;
const planOf = (id: string, overrides: Record<string, unknown> = {}): PlanSummary => toPlan(plan(id, overrides)) as PlanSummary;
const problem = (code: string, status = 422, extensions: Record<string, unknown> = {}, detail?: string) => new ApiError({ status, code, correlationId: 'c', detail, extensions });

describe('computeImpact: a revision against the revision it replaces, exactly', () => {
  const other = { project: { id: '00000000-0000-4000-8000-000000000099', code: 'DA-09', name: 'Cầu mới' } };
  const base = [lineOf(planLine(1, { amount_vnd: vnd(10), committed_vnd: vnd(6), disbursed_vnd: vnd(3) })), lineOf(planLine(2, { amount_vnd: vnd(1) }))];

  it('marks lines that grow, shrink, stay, are new or are dropped, and adds the totals without a float', () => {
    const revision = [lineOf(planLine(1, { amount_vnd: vnd(9) })), lineOf(planLine(4, other)), lineOf(planLine(5, { ...other, amount_vnd: '123456789012345678901', project: { id: '00000000-0000-4000-8000-000000000098', code: 'DA-10', name: 'Rất lớn' } }))];
    const impact = computeImpact(revision, base);
    expect(impact.rows.map((row) => [row.projectCode, row.kind, row.deltaVnd])).toEqual([
      ['DA-01', 'CHANGED', String(-BILLION)],
      ['DA-02', 'DROPPED', String(-BILLION)],
      ['DA-09', 'NEW', vnd(1)],
      ['DA-10', 'NEW', '123456789012345678901'],
    ]);
    expect(impact.previousVnd).toBe(vnd(11));
    expect(impact.nextVnd).toBe((BigInt(vnd(9)) + BigInt(vnd(1)) + 123456789012345678901n).toString());
    expect(impact.projectCount).toBe(3);
    expect(impact.belowCount).toBe(0);
  });

  it('flags a line below what is committed and disbursed on the line it replaces, and a dropped line that has a commitment', () => {
    const low = computeImpact([lineOf(planLine(1, { amount_vnd: String(8.5 * BILLION) }))], base);
    expect(low.rows.find((row) => row.projectCode === 'DA-01')).toMatchObject({ floorVnd: vnd(9), belowFloor: true });
    expect(low.belowCount).toBe(1);
    const dropped = computeImpact([lineOf(planLine(2, { amount_vnd: vnd(1) }))], base);
    expect(dropped.rows.find((row) => row.projectCode === 'DA-01')).toMatchObject({ kind: 'DROPPED', belowFloor: true, nextVnd: '0' });
    const exact = computeImpact([lineOf(planLine(1, { amount_vnd: vnd(9) }))], base);
    expect(exact.rows[0]).toMatchObject({ belowFloor: false });
  });

  it('treats every line as new when there is no revision in force, and an unchanged line as SAME', () => {
    expect(computeImpact(base, []).rows.every((row) => row.kind === 'NEW' && row.floorVnd === '0')).toBe(true);
    expect(computeImpact(base, base).rows.every((row) => row.kind === 'SAME' && row.deltaVnd === '0')).toBe(true);
  });
});

describe('the choice of the revision and the permissions', () => {
  it('opens on the revision that waits for a decision, then for a publication, then a draft, then the first', () => {
    const published = planOf(PUBLISHED_ID, { status: 'PUBLISHED' });
    const approved = planOf(MEDIUM_ID, { status: 'APPROVED' });
    const review = planOf(ANNUAL_ID, { status: 'IN_REVIEW' });
    expect(firstToWorkOn([published, approved, review])?.id).toBe(ANNUAL_ID);
    expect(firstToWorkOn([published, approved])?.id).toBe(MEDIUM_ID);
    expect(firstToWorkOn([published, planOf(ANNUAL_ID)])?.id).toBe(ANNUAL_ID);
    expect(firstToWorkOn([published])?.id).toBe(PUBLISHED_ID);
    expect(firstToWorkOn([])).toBeUndefined();
  });

  it('finds the revision a plan replaces when the list holds it', () => {
    const base = planOf(PUBLISHED_ID, { status: 'PUBLISHED' });
    const revision = planOf(ANNUAL_ID, { supersedes_id: PUBLISHED_ID });
    expect(baseOf(revision, [base, revision])?.id).toBe(PUBLISHED_ID);
    expect(baseOf(planOf(ANNUAL_ID), [base])).toBeUndefined();
    expect(baseOf(planOf(ANNUAL_ID, { supersedes_id: MEDIUM_ID }), [base])).toBeUndefined();
  });

  it('judges the permission and the frozen tenant', () => {
    expect(mayAct([DECIDE_PERMISSION], undefined, DECIDE_PERMISSION)).toBe(true);
    expect(mayAct(undefined, undefined, DECIDE_PERMISSION)).toBe(true);
    expect(mayAct(['capital.read'], undefined, DECIDE_PERMISSION)).toBe(false);
    expect(mayAct([DECIDE_PERMISSION], 'READ_ONLY', DECIDE_PERMISSION)).toBe(false);
    expect(APPROVAL_PATH).toBe('/cap/cap-10');
  });
});

describe('the forms of the approval', () => {
  it('judges the reason: required, at least 5 characters, at most 2000', () => {
    expect(validateReason('   ')).toBe('required');
    expect(validateReason(' abcd ')).toBe('tooShort');
    expect(validateReason('abcde')).toBeUndefined();
    expect(validateReason('x'.repeat(2001))).toBe('tooLong');
  });

  it('judges the publication form and sends the document in lower case with an ISO moment', () => {
    expect(validatePublishForm(EMPTY_PUBLISH_FORM)).toEqual({ documentId: 'required' });
    expect(validatePublishForm({ documentId: 'abc', effectiveAt: '' })).toEqual({ documentId: 'invalidId' });
    const id = '3F2B8C1E-4D5A-4B6C-8D7E-9F0A1B2C3D4E';
    expect(validatePublishForm({ documentId: id, effectiveAt: 'never' })).toEqual({ effectiveAt: 'invalidDate' });
    expect(validatePublishForm({ documentId: id, effectiveAt: '2026-07-01T08:00' })).toEqual({});
    expect(publishBody({ documentId: ` ${id} `, effectiveAt: '' })).toEqual({ decision_document_id: id.toLowerCase() });
    expect(publishBody({ documentId: id, effectiveAt: '2026-07-01T08:00' })).toEqual({ decision_document_id: id.toLowerCase(), effective_at: new Date('2026-07-01T08:00').toISOString() });
  });
});

describe('describeApprovalProblem', () => {
  it.each([
    ['SELF_APPROVAL_DENIED', 403, 'selfApproval'],
    ['DECISION_REQUIRED', 422, 'decisionRequired'],
    ['PLAN_NOT_APPROVED', 409, 'notApproved'],
    ['PLAN_NOT_DRAFT', 409, 'notDraft'],
    ['STAGE_TRANSITION_DENIED', 409, 'notInReview'],
    ['NATIONAL_CODE_REQUIRED', 422, 'nationalCode'],
    ['NATIONAL_CODE_FORMAT_INVALID', 422, 'nationalCode'],
    ['FISCAL_YEAR_LOCKED', 409, 'yearLocked'],
    ['VERSION_CONFLICT', 409, 'versionConflict'],
    ['PLAN_CHANGED_SINCE_PROPOSAL', 409, 'planChanged'],
    ['PROJECT_STAGE_INVALID', 422, 'stageInvalid'],
    ['APPROPRIATION_NOT_PUBLISHED', 422, 'notPublished'],
    ['RESOURCE_NOT_FOUND', 404, 'notFound'],
    ['SCOPE_DENIED', 403, 'denied'],
    ['SOMETHING_ELSE', 403, 'denied'],
    ['SOMETHING_ELSE', 500, 'general'],
    ['VALIDATION_FAILED', 422, 'validation'],
  ])('maps %s (%i) to %s', (code, status, reason) => {
    expect(describeApprovalProblem(problem(code, status)).reason).toBe(reason);
  });

  it('names the field, the projects and the lines of a refusal, and keeps only well formed lines', () => {
    expect(describeApprovalProblem(problem('VALIDATION_FAILED', 422, {}, 'lines')).reason).toBe('noLines');
    expect(describeApprovalProblem(problem('VALIDATION_FAILED', 422, {}, 'reason'))).toMatchObject({ reason: 'validation', field: 'reason' });
    expect(describeApprovalProblem(problem('NATIONAL_CODE_REQUIRED', 422, { project_ids: ['a', 'b'] })).projectCount).toBe(2);
    const lines = [
      { line_id: 'l1', project_id: 'p1', allocated_vnd: '8', committed_vnd: '6', disbursed_vnd: '3', minimum_vnd: '9' },
      { line_id: 'l2', allocated_vnd: 'x', committed_vnd: '6', disbursed_vnd: '3', minimum_vnd: '9' },
      null,
    ];
    expect(describeApprovalProblem(problem('REVISED_BELOW_COMMITTED', 422, { lines })).lines).toEqual([{ lineId: 'l1', projectId: 'p1', allocatedVnd: '8', committedVnd: '6', disbursedVnd: '3', minimumVnd: '9' }]);
    expect(describeApprovalProblem(problem('REVISED_BELOW_COMMITTED', 422, { lines: 'no' })).lines).toEqual([]);
    expect(describeApprovalProblem(new Error('offline')).reason).toBe('general');
  });
});

describe('decisionRows: the decisions that give capital out', () => {
  it('lists the decision behind every appropriation and every plan that has one, newest first, and none for a plan without a decision', () => {
    const world = planWorld();
    const appropriation = toAppropriation({ ...appropriationLine(1) });
    const plans = world.plans.flatMap((raw) => toPlan(raw) ?? []);
    const rows = decisionRows(appropriation === undefined ? [] : [appropriation], plans);
    const keys = rows.map((row) => row.key);
    expect(keys.filter((key) => key.startsWith('plan:'))).toEqual([`plan:${PUBLISHED_ID}`]);
    expect(rows.find((row) => row.key === `plan:${PUBLISHED_ID}`)).toMatchObject({ symbol: '12/QD-UBND', issuedOn: '2025-01-10', authority: null, basis: { kind: 'PLAN' } });
    expect(rows.filter((row) => row.basis.kind === 'APPROPRIATION')).toHaveLength(appropriation === undefined ? 0 : 1);
    const dates = rows.map((row) => row.issuedOn ?? '');
    expect([...dates].sort().reverse()).toEqual(dates);
  });
});
