import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { asOfDate, describeRevisionProblem, mayRevise, pendingRevisionOf, toPlanAsOf, transferBetween, trackedPlans, validateRevisionReason } from './revision-model';
import { toPlan, toPlanLine } from './plan-model';
import type { PlanLine, PlanSummary } from './plan-model';
import { plan, planLine } from './plan-test-support';

const summary = (id: string, overrides: Record<string, unknown> = {}): PlanSummary => toPlan(plan(id, overrides)) as PlanSummary;
const line = (n: number, amount: string): PlanLine => toPlanLine(planLine(n, { amount_vnd: amount })) as PlanLine;
const problem = (code: string, status = 409) => new ApiError({ status, code, correlationId: 'c', extensions: {} });

describe('the revision of a plan', () => {
  it('finds the revision still in work, but not a plan of another code or a revision that is over', () => {
    const published = summary('p1', { status: 'PUBLISHED' });
    expect(pendingRevisionOf(published, [published])).toBeUndefined();
    for (const status of ['DRAFT', 'IN_REVIEW', 'APPROVED']) expect(pendingRevisionOf(published, [published, summary('p2', { status, revision: 2 })])?.id).toBe('p2');
    for (const status of ['REJECTED', 'SUPERSEDED', 'PUBLISHED']) expect(pendingRevisionOf(published, [published, summary('p2', { status, revision: 2 })])).toBeUndefined();
    expect(pendingRevisionOf(published, [published, summary('p3', { status: 'DRAFT', plan_code: 'OTHER' })])).toBeUndefined();
  });

  it('allows a revision of the published plan only to a drafter of an unfrozen tenant, and only while none is in work', () => {
    const published = summary('p1', { status: 'PUBLISHED' });
    expect(mayRevise(published, [published], ['capital.plan.draft'], undefined)).toBe(true);
    expect(mayRevise(published, [published], undefined, undefined)).toBe(true);
    expect(mayRevise(published, [published], ['capital.read'], undefined)).toBe(false);
    expect(mayRevise(published, [published], ['capital.plan.draft'], 'READ_ONLY')).toBe(false);
    expect(mayRevise(published, [published, summary('p2', { status: 'DRAFT', revision: 2 })], ['capital.plan.draft'], undefined)).toBe(false);
    expect(mayRevise(summary('p4', { status: 'SUPERSEDED' }), [], ['capital.plan.draft'], undefined)).toBe(false);
  });

  it('asks for a reason of 10 to 2,000 characters after trimming', () => {
    expect(validateRevisionReason('   ')).toBe('required');
    expect(validateRevisionReason(' 123456789 ')).toBe('tooShort');
    expect(validateRevisionReason('1234567890')).toBeUndefined();
    expect(validateRevisionReason('x'.repeat(2000))).toBeUndefined();
    expect(validateRevisionReason('x'.repeat(2001))).toBe('tooLong');
  });

  it('maps the refusals of the command to what the screen says', () => {
    expect(describeRevisionProblem(problem('REVISION_PENDING_EXISTS'))).toBe('pending');
    expect(describeRevisionProblem(problem('PLAN_NOT_PUBLISHED'))).toBe('notPublished');
    expect(describeRevisionProblem(problem('VERSION_CONFLICT'))).toBe('versionConflict');
    expect(describeRevisionProblem(problem('FISCAL_YEAR_LOCKED'))).toBe('yearLocked');
    expect(describeRevisionProblem(problem('SCOPE_DENIED', 403))).toBe('denied');
    expect(describeRevisionProblem(problem('SOMETHING_NEW', 403))).toBe('denied');
    expect(describeRevisionProblem(problem('RESOURCE_NOT_FOUND', 404))).toBe('notFound');
    expect(describeRevisionProblem(problem('VALIDATION_FAILED', 422))).toBe('validation');
    expect(describeRevisionProblem(problem('SOMETHING_NEW', 500))).toBe('general');
    expect(describeRevisionProblem(new Error('offline'))).toBe('general');
  });
});

describe('the transfer between lines', () => {
  it('splits the lines into what is given up and what is received, with exact totals that match when capital is only moved (AC-ST-CAP-004-2)', () => {
    const transfer = transferBetween([line(1, '4200000000'), line(2, '1800000000')], [line(1, '5000000000'), line(2, '1000000000')]);
    expect(transfer.down.map((row) => row.projectCode)).toEqual(['DA-01']);
    expect(transfer.up.map((row) => row.projectCode)).toEqual(['DA-02']);
    expect(transfer).toMatchObject({ downVnd: '800000000', upVnd: '800000000', netVnd: '0', balanced: true });
  });

  it('counts a dropped line as given up and a new one as received, and shows an unbalanced revision as such', () => {
    const transfer = transferBetween([line(2, '1500000000')], [line(1, '5000000000')]);
    expect(transfer.down.map((row) => [row.projectCode, row.kind])).toEqual([['DA-01', 'DROPPED']]);
    expect(transfer.up.map((row) => [row.projectCode, row.kind])).toEqual([['DA-02', 'NEW']]);
    expect(transfer).toMatchObject({ downVnd: '5000000000', upVnd: '1500000000', netVnd: '-3500000000', balanced: false });
  });

  it('is empty, and balanced, when nothing is changed', () => {
    const transfer = transferBetween([line(1, '5')], [line(1, '5')]);
    expect(transfer).toMatchObject({ down: [], up: [], downVnd: '0', upVnd: '0', netVnd: '0', balanced: true });
  });

  it('keeps amounts above the safe integer range exact', () => {
    const transfer = transferBetween([line(1, '9007199254740993'), line(2, '1')], [line(1, '9007199254740995'), line(2, '0')]);
    expect(transfer).toMatchObject({ downVnd: '2', upVnd: '1', netVnd: '-1', balanced: false });
  });
});

describe('the plan as of a day', () => {
  const answer = (overrides: Record<string, unknown> = {}) => ({
    capital_plan_id: 'p2',
    plan_code: 'CP-2026',
    revision: 2,
    status: 'PUBLISHED',
    decision_document_id: 'd2',
    effective_at: '2026-07-01T00:00:00.000Z',
    as_of: '2026-07-02T16:59:59.999Z',
    truncated: false,
    totals: { amount_vnd: '5000000000', initial_vnd: '5000000000', adjustment_vnd: '0', disbursed_vnd: '10' },
    lines: [{ ...planLine(1, { amount_vnd: '4200000000' }), initial_vnd: '5000000000', adjustment_vnd: '-800000000', as_of_disbursed_vnd: '10' }],
    ...overrides,
  });

  it('reads the answer with the exact amounts, the sign of an adjustment kept', () => {
    const found = toPlanAsOf(answer());
    expect(found).toMatchObject({ planId: 'p2', revision: 2, status: 'PUBLISHED', decisionDocumentId: 'd2', truncated: false });
    expect(found?.totals).toEqual({ currentVnd: '5000000000', initialVnd: '5000000000', adjustmentVnd: '0', disbursedVnd: '10' });
    expect(found?.lines.map((row) => [row.line.amountVnd, row.initialVnd, row.adjustmentVnd, row.disbursedVnd])).toEqual([['4200000000', '5000000000', '-800000000', '10']]);
  });

  it('falls back to zero for an amount that is not whole VND, and drops a line that is not a line', () => {
    const found = toPlanAsOf(answer({ totals: { amount_vnd: 5, initial_vnd: '1.5' }, lines: [{ not: 'a line' }, 7] }));
    expect(found?.totals).toEqual({ currentVnd: '0', initialVnd: '0', adjustmentVnd: '0', disbursedVnd: '0' });
    expect(found?.lines).toEqual([]);
    expect(toPlanAsOf(answer({ truncated: true }))?.truncated).toBe(true);
    expect(toPlanAsOf(answer({ decision_document_id: undefined, effective_at: undefined }))).toMatchObject({ decisionDocumentId: null, effectiveAt: null });
  });

  it('is undefined when the answer is not the shape of a plan as of a day', () => {
    expect(toPlanAsOf(undefined)).toBeUndefined();
    expect(toPlanAsOf('plan')).toBeUndefined();
    expect(toPlanAsOf(answer({ capital_plan_id: undefined }))).toBeUndefined();
    expect(toPlanAsOf(answer({ status: 'WHATEVER' }))).toBeUndefined();
    expect(toPlanAsOf(answer({ revision: '2' }))).toBeUndefined();
    expect(toPlanAsOf(answer({ revision: 1.5 }))).toBeUndefined();
    expect(toPlanAsOf(answer({ as_of: undefined }))).toBeUndefined();
  });

  it('offers one plan per code, the latest revision that was in force', () => {
    const plans = [
      summary('a1', { plan_code: 'B-PLAN', status: 'SUPERSEDED', revision: 1 }),
      summary('a2', { plan_code: 'B-PLAN', status: 'PUBLISHED', revision: 2 }),
      summary('a3', { plan_code: 'B-PLAN', status: 'DRAFT', revision: 3 }),
      summary('b1', { plan_code: 'A-PLAN', status: 'PUBLISHED', revision: 1 }),
      summary('c1', { plan_code: 'C-PLAN', status: 'REJECTED', revision: 1 }),
      summary('d1', { plan_code: 'D-PLAN', status: 'SUPERSEDED', revision: 4 }),
      summary('d2', { plan_code: 'D-PLAN', status: 'SUPERSEDED', revision: 2 }),
    ];
    expect(trackedPlans(plans).map((item) => item.id)).toEqual(['b1', 'a2', 'd1']);
    expect(trackedPlans([])).toEqual([]);
  });

  it('takes a real calendar day or nothing as the day to read', () => {
    expect(asOfDate('')).toEqual({ at: undefined, valid: true });
    expect(asOfDate('  ')).toEqual({ at: undefined, valid: true });
    expect(asOfDate('2026-06-30')).toEqual({ at: '2026-06-30', valid: true });
    expect(asOfDate('2028-02-29')).toEqual({ at: '2028-02-29', valid: true });
    for (const bad of ['2026-02-30', '2027-02-29', '2026-13-01', '30/06/2026', '2026-6-30', 'yesterday']) expect(asOfDate(bad)).toEqual({ at: undefined, valid: false });
  });
});
