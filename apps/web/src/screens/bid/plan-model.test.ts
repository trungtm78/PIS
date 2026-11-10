import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_PACKAGE_FILTER,
  EMPTY_PLAN_FORM,
  decisionBody,
  describeProblem,
  emptyRow,
  filterPackages,
  formatVnd,
  hasErrors,
  planBody,
  rowsOf,
  sumVnd,
  toLineOption,
  toPackageLine,
  toPlanLine,
  validateDecision,
  validatePlan,
} from './plan-model';
import type { PlanForm } from './plan-model';
import { LINE, PROJECT, line, pack, plan, project } from './plan-test-support';

const problem = (code: string, extensions: Record<string, unknown> = {}, detail?: string) => new ApiError({ status: 422, code, correlationId: 'c', extensions, ...(detail === undefined ? {} : { detail }) });

const validForm = (): PlanForm => {
  const row = { ...emptyRow(), code: 'GT-1', title: 'Gói thầu xây lắp', budget: '18000000000', allocationLineId: LINE, period: '2026-Q4', duration: '180' };
  return { projectId: PROJECT, title: 'Kế hoạch 2026', legalBasis: 'Luật Đấu thầu', rows: [row] };
};

describe('the plan model', () => {
  it('reads a plan and a package from the allowlisted answer, and drops what is not one (UI-BID-15)', () => {
    expect(toPlanLine(plan(1, { status: 'APPROVED', decision_document: { id: 'd', symbol: '45/QD', issued_on: '2026-10-01' }, last_decision: { decision: 'APPROVED', comment: null, decided_at: 'x' } }))).toMatchObject({
      revision: 1,
      status: 'APPROVED',
      decisionSymbol: '45/QD',
      lastDecision: { decision: 'APPROVED', comment: null },
      project: { code: 'PRJ-001' },
    });
    expect(toPlanLine({ id: 'x' })).toBeUndefined();
    expect(toPlanLine(plan(1, { status: 'WEIRD' }))).toBeUndefined();
    expect(toPackageLine(pack(1, 1))).toMatchObject({ code: 'GT-1', planRevision: 1, fundSourceLabel: 'Ngân sách trung ương', fundSourceKey: 'NSTW', durationDays: 180 });
    expect(toPackageLine(pack(1, null))).toMatchObject({ planId: null, planStatus: null });
    expect(toPackageLine({ id: 'x' })).toBeUndefined();
    expect(toPackageLine(null)).toBeUndefined();
  });

  it('offers a line of capital only when its capital plan is published', () => {
    expect(toLineOption(line())).toMatchObject({ id: LINE, projectId: PROJECT, label: 'Ngân sách trung ương 2026 30.000.000.000' });
    expect(toLineOption(line({ plan_status: 'DRAFT' }))).toBeUndefined();
    expect(toLineOption({ id: 'x' })).toBeUndefined();
  });

  it('writes whole amounts with separators for the eye, and adds them without a float', () => {
    expect(formatVnd('1234567890')).toBe('1.234.567.890');
    expect(formatVnd('999')).toBe('999');
    expect(sumVnd(['18000000000', '10000000000', ''])).toBe('28000000000');
    expect(sumVnd(['99999999999999999999', '1'])).toBe('100000000000000000000');
  });

  it('filters the packages by text and by the status of their plan', () => {
    const packages = [toPackageLine(pack(1, 1)), toPackageLine(pack(2, null))].flatMap((item) => item ?? []);
    expect(filterPackages(packages, EMPTY_PACKAGE_FILTER)).toHaveLength(2);
    expect(filterPackages(packages, { query: ' gt-2 ', planStatus: '' }).map((item) => item.code)).toEqual(['GT-2']);
    expect(filterPackages(packages, { query: '', planStatus: 'DRAFT' }).map((item) => item.code)).toEqual(['GT-1']);
    expect(filterPackages(packages, { query: 'cầu', planStatus: '' })).toHaveLength(2);
  });

  it('starts a revision from the packages of the plan it revises', () => {
    const rows = rowsOf([toPackageLine(pack(1, 1)), toPackageLine(pack(2, null, { method: 'OTHER', contract_type: null, bidding_form: null, allocation_line_id: null, planned_start_period: null, duration_days: null, title: null }))].flatMap((item) => item ?? []));
    expect(rows[0]).toMatchObject({ code: 'GT-1', budget: '18000000000', method: 'OPEN_BIDDING', contractType: 'LUMP_SUM', biddingForm: 'ONLINE', period: '2026-Q4', duration: '180' });
    expect(rows[1]).toMatchObject({ method: 'OPEN_BIDDING', allocationLineId: '', period: '', duration: '', title: '' });
    expect(rows[0]?.key).not.toBe(rows[1]?.key);
    expect(EMPTY_PLAN_FORM().rows).toHaveLength(1);
  });

  it('judges the form before it is sent: every field names its problem, a repeated code too', () => {
    expect(hasErrors(validatePlan(validForm()))).toBe(false);
    const empty = validatePlan(EMPTY_PLAN_FORM());
    expect(empty).toMatchObject({ projectId: 'required', title: 'required', legalBasis: 'required' });
    const row = emptyRow();
    expect(validatePlan({ ...EMPTY_PLAN_FORM(), rows: [row] }).packages[row.key]).toEqual({ code: 'required', title: 'required', budget: 'required', allocationLineId: 'required', period: 'required', duration: 'required' });
    const bad = { ...validForm(), projectId: 'x', title: 'ab', legalBasis: 'x'.repeat(2001), rows: [] };
    expect(validatePlan(bad)).toMatchObject({ projectId: 'invalidId', title: 'tooShort', legalBasis: 'tooLong', rows: 'required' });
    const first = { ...validForm().rows[0], budget: '01', allocationLineId: 'nope', period: '2026-Q5', duration: '0' } as PlanForm['rows'][number];
    const second = { ...validForm().rows[0], key: 'second', code: ' GT-1 ', budget: '10.5', duration: '4000' } as PlanForm['rows'][number];
    const found = validatePlan({ ...validForm(), rows: [first, second] });
    expect(found.packages[first.key]).toEqual({ budget: 'invalidAmount', allocationLineId: 'invalidId', period: 'invalidPeriod', duration: 'invalidDuration' });
    expect(found.packages.second).toEqual({ code: 'duplicateCode', budget: 'invalidAmount', duration: 'invalidDuration' });
    expect(validatePlan({ ...validForm(), title: 'x'.repeat(501) }).title).toBe('tooLong');
  });

  it('builds the body of the contract: trimmed text, lower-case ids, amounts as digit strings and numbers where the contract has numbers', () => {
    const form = validForm();
    form.projectId = ` ${PROJECT.toUpperCase()} `;
    form.title = '  Kế hoạch 2026 ';
    expect(planBody(form)).toEqual({
      project_id: PROJECT,
      title: 'Kế hoạch 2026',
      legal_basis: 'Luật Đấu thầu',
      packages: [
        {
          code: 'GT-1',
          title: 'Gói thầu xây lắp',
          budget_vnd: '18000000000',
          method: 'OPEN_BIDDING',
          contract_type: 'LUMP_SUM',
          bidding_form: 'ONLINE',
          allocation_line_id: LINE,
          planned_start_period: '2026-Q4',
          duration_days: 180,
        },
      ],
    });
  });

  it('asks for a document to approve and for words to return or reject, and sends only what the kind of decision takes', () => {
    expect(validateDecision({ decision: 'APPROVE', documentId: '', comment: '' })).toEqual({ documentId: 'required' });
    expect(validateDecision({ decision: 'APPROVE', documentId: 'x', comment: '' })).toEqual({ documentId: 'invalidId' });
    expect(validateDecision({ decision: 'APPROVE', documentId: LINE, comment: '' })).toEqual({});
    expect(validateDecision({ decision: 'RETURN', documentId: '', comment: ' ' })).toEqual({ comment: 'required' });
    expect(validateDecision({ decision: 'REJECT', documentId: '', comment: 'x'.repeat(2001) })).toEqual({ comment: 'tooLong' });
    expect(decisionBody({ decision: 'APPROVE', documentId: ` ${LINE.toUpperCase()} `, comment: '' })).toEqual({ decision: 'APPROVE', decision_document_id: LINE });
    expect(decisionBody({ decision: 'RETURN', documentId: LINE, comment: ' Chia gói 2 ' })).toEqual({ decision: 'RETURN', comment: 'Chia gói 2' });
  });

  it.each([
    ['PACKAGE_BUDGET_EXCEEDS_ALLOCATION', 'budgetExceeds'],
    ['ALLOCATION_LINE_INVALID', 'lineInvalid'],
    ['PROJECT_STAGE_INVALID', 'stageInvalid'],
    ['PLAN_STATE_INVALID', 'stateInvalid'],
    ['PACKAGE_CODE_DUPLICATE', 'codeDuplicate'],
    ['SELF_APPROVAL_DENIED', 'selfApproval'],
    ['DECISION_DOCUMENT_NOT_EFFECTIVE', 'decisionNotEffective'],
    ['VERSION_CONFLICT', 'versionConflict'],
    ['VALIDATION_FAILED', 'validation'],
    ['FIELD_NOT_ALLOWED', 'validation'],
    ['RESOURCE_NOT_FOUND', 'notFound'],
    ['SCOPE_DENIED', 'denied'],
    ['SOMETHING_ELSE', 'general'],
  ])('maps the refusal %s to %s', (code, reason) => {
    expect(describeProblem(problem(code)).reason).toBe(reason);
  });

  it('reads the lines that cost too much out of the refusal of the budget check, and says nothing specific of any other failure', () => {
    const refusal = problem('PACKAGE_BUDGET_EXCEEDS_ALLOCATION', { lines: [{ allocation_line_id: LINE, allocated_vnd: '30', packages_vnd: '33', excess_vnd: '3' }, { allocation_line_id: 5 }, 'x'] }, 'packages');
    expect(describeProblem(refusal)).toEqual({ reason: 'budgetExceeds', field: 'packages', lines: [{ allocationLineId: LINE, allocatedVnd: '30', packagesVnd: '33', excessVnd: '3' }] });
    expect(describeProblem(problem('VALIDATION_FAILED', { lines: 'nope' })).lines).toEqual([]);
    expect(describeProblem(new Error('network'))).toEqual({ reason: 'general', field: undefined, lines: [] });
    expect(project().code).toBe('PRJ-001');
  });
});
