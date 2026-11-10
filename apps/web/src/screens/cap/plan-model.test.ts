import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { millionsInput } from './model';
import type { AppropriationLine } from './model';
import {
  appropriationsFor,
  canDraft,
  ceilingStates,
  bucketsOf,
  defaultBucket,
  describePlanProblem,
  differenceVnd,
  gridBody,
  gridRows,
  isDraft,
  isNegativeVnd,
  nextTotal,
  periodOf,
  planBody,
  plansOfKind,
  proposalBody,
  startEdit,
  toPlan,
  toPlanLine,
  toPlanLines,
  toProjectOption,
  toUnitOption,
  validatePlanForm,
  validateProposal,
} from './plan-model';
import type { GridEdits, PlanForm, PlanLine, ProposalForm } from './plan-model';
import { ANNUAL_ID, MEDIUM_ID, plan, planLine } from './plan-test-support';

const BILLION = 1_000_000_000;
const toMillions = (vnd: string): string => millionsInput(vnd, 'vi');
const line = (n: number, overrides: Record<string, unknown> = {}): PlanLine => toPlanLine(planLine(n, overrides)) as PlanLine;
const appropriation = (overrides: Partial<AppropriationLine> = {}): AppropriationLine =>
  ({ id: 'a1', status: 'PUBLISHED', planYear: 2026, sourceYear: 2026, origin: 'PM_ASSIGNED', budgetLevel: 'CENTRAL', remainingVnd: String(4 * BILLION), ...overrides }) as AppropriationLine;
const problem = (code: string, status = 422, extensions: Record<string, unknown> = {}, detail?: string) => new ApiError({ status, code, correlationId: 'c', detail, extensions });

describe('the readers of the answers of the API', () => {
  it('reads a plan with its totals, fund sources and decision, and refuses an answer that is not a plan', () => {
    const parsed = toPlan(plan(ANNUAL_ID, { decision_document: { id: 'd', symbol: '1/QD', issued_on: '2026-01-01' }, effective_at: '2026-01-01T00:00:00.000Z' }));
    expect(parsed).toMatchObject({ id: ANNUAL_ID, planCode: 'CP-2026', planKind: 'ANNUAL', planYear: 2026, status: 'DRAFT', version: 4, decisionSymbol: '1/QD', decisionIssuedOn: '2026-01-01' });
    expect(parsed?.totals).toEqual({ lineCount: 2, allocatedVnd: String(3 * BILLION), ctmtqgSubsetVnd: '400000000', ceilingVnd: String(10 * BILLION) });
    expect(parsed?.fundSources).toEqual([{ versionId: expect.any(String), businessKey: 'NSTW-DTPT', label: 'Ngân sách trung ương' }]);
    expect(toPlan(plan(MEDIUM_ID, { plan_kind: 'MEDIUM_TERM', plan_year: null }))?.planYear).toBeNull();
    for (const broken of [null, 'x', [], {}, plan(ANNUAL_ID, { plan_kind: 'WEEKLY' }), plan(ANNUAL_ID, { status: 'DONE' }), plan(ANNUAL_ID, { version: '4' }), plan(ANNUAL_ID, { period_from_year: 'x' }), plan(ANNUAL_ID, { id: 7 })]) {
      expect(toPlan(broken)).toBeUndefined();
    }
    const sparse = toPlan({ ...plan(ANNUAL_ID), totals: undefined, fund_sources: [{ version_id: 1 }, 'x'], scope_unit: undefined, revision: undefined });
    expect(sparse).toMatchObject({ totals: { lineCount: 0, allocatedVnd: '0' }, fundSources: [], scopeUnit: { id: '', name: '' }, revision: 1 });
  });

  it('reads a line with its source, ceiling, extension and balance, and refuses what is not a line', () => {
    const carried = line(2, { committed_vnd: '5', reserved_vnd: '6' });
    expect(carried).toMatchObject({
      bucket: 'CURRENT_YEAR',
      isExtended: false,
      project: { code: 'DA-02' },
      fundSource: { businessKey: 'NSTW-DTPT', category: 'NSTW' },
      appropriation: { amountVnd: String(10 * BILLION), remainingVnd: String(4 * BILLION) },
      committedVnd: '5',
      reservedVnd: '6',
    });
    const extended = toPlanLine(planLine(2, { bucket: 'CARRYOVER', is_extended: true, extended_to: '2026-12-31', extension_document: { id: 'e', symbol: '55/QD', issued_on: '2026-01-05' } })) as PlanLine;
    expect(extended).toMatchObject({ isExtended: true, extendedTo: '2026-12-31', extensionDocument: { id: 'e', symbol: '55/QD', issuedOn: '2026-01-05' } });
    expect(toPlanLine(planLine(1, { appropriation: null }))?.appropriation).toBeNull();
    // The enterprise pack (ENT-3e) draws its lines in equity and loan: the annual plan of the enterprise reads them like any other line (CAP-03 was empty for want of this).
    expect(toPlanLine(planLine(3, { bucket: 'EQUITY' }))?.bucket).toBe('EQUITY');
    expect(toPlanLine(planLine(4, { bucket: 'LOAN' }))?.bucket).toBe('LOAN');
    expect(toPlanLine(planLine(5, { bucket: 'MYSTERY' }))).toBeUndefined();
    expect(toPlanLine(planLine(1, { amount_vnd: 'abc' }))?.amountVnd).toBe('0');
    for (const broken of [null, {}, planLine(1, { bucket: 'ELSE' }), planLine(1, { project: {} }), planLine(1, { fund_source: {} }), planLine(1, { source_year: 'x' }), planLine(1, { version: null })]) {
      expect(toPlanLine(broken)).toBeUndefined();
    }
  });

  it('reads the answer of the lines of a plan, leaving out the lines it cannot read', () => {
    const answer = toPlanLines({ plan: plan(ANNUAL_ID), items: [planLine(1), { nonsense: true }, planLine(2)], totals: { line_count: 2, allocated_vnd: '30', ctmtqg_subset_vnd: '4' }, next_cursor: 'next' });
    expect(answer?.lines).toHaveLength(2);
    expect(answer).toMatchObject({ totals: { lineCount: 2, allocatedVnd: '30', ctmtqgSubsetVnd: '4' }, nextCursor: 'next' });
    expect(toPlanLines({ items: [] })).toBeUndefined();
    expect(toPlanLines(null)).toBeUndefined();
    expect(toPlanLines({ plan: plan(ANNUAL_ID) })).toMatchObject({ lines: [], totals: { lineCount: 0, allocatedVnd: '0' }, nextCursor: null });
  });

  it('reads project and unit options', () => {
    expect(toProjectOption({ id: 'p', code: 'DA', name: 'Name', status: 'PIPELINE' })).toEqual({ id: 'p', code: 'DA', name: 'Name', status: 'PIPELINE' });
    expect(toProjectOption({ id: 'p', code: 'DA' })).toEqual({ id: 'p', code: 'DA', name: 'DA', status: '' });
    expect(toProjectOption({ id: 'p' })).toBeUndefined();
    expect(toUnitOption({ id: 'u', code: 'U', name: 'Unit' })).toEqual({ id: 'u', code: 'U', name: 'Unit' });
    expect(toUnitOption({ id: 'u', code: 'U' })).toEqual({ id: 'u', code: 'U', name: 'U' });
    expect(toUnitOption(7)).toBeUndefined();
  });
});

describe('the plans', () => {
  it('writes the years of a plan, picks the plans of a kind and the appropriations a plan can draw on', () => {
    const annual = toPlan(plan(ANNUAL_ID)) as ReturnType<typeof toPlan> & object;
    const medium = toPlan(plan(MEDIUM_ID, { plan_kind: 'MEDIUM_TERM', plan_year: null, period_from_year: 2026, period_to_year: 2030 })) as ReturnType<typeof toPlan> & object;
    expect(periodOf(annual)).toBe('2026');
    expect(periodOf(medium)).toBe('2026 - 2030');
    expect(plansOfKind([annual, medium], 'MEDIUM_TERM')).toEqual([medium]);
    expect(isDraft(annual)).toBe(true);
    expect(isDraft({ ...annual, status: 'PUBLISHED' })).toBe(false);
    const book = [appropriation({ id: 'in' }), appropriation({ id: 'later', planYear: 2028 }), appropriation({ id: 'out', planYear: 2031 }), appropriation({ id: 'draft', status: 'DRAFT' })];
    expect(appropriationsFor(annual, book).map((item) => item.id)).toEqual(['in']);
    expect(appropriationsFor(medium, book).map((item) => item.id)).toEqual(['in', 'later']);
    expect(defaultBucket(appropriation({ origin: 'CARRYOVER' }))).toBe('CARRYOVER');
    expect(defaultBucket(appropriation())).toBe('CURRENT_YEAR');
    expect(defaultBucket(undefined)).toBe('CURRENT_YEAR');
    expect(defaultBucket(appropriation(), true)).toBe('EQUITY');
    expect(bucketsOf(true)).toEqual(['EQUITY', 'LOAN', 'OTHER']);
    expect(bucketsOf(false)).toEqual(['CURRENT_YEAR', 'CARRYOVER', 'OTHER']);
    expect(canDraft(undefined, 'FULL')).toBe(true);
    expect(canDraft(['capital.plan.draft'], 'FULL')).toBe(true);
    expect(canDraft(['capital.read'], 'FULL')).toBe(false);
    expect(canDraft(['capital.plan.draft'], 'READ_ONLY')).toBe(false);
  });

  it('subtracts exact amounts that may go below zero', () => {
    expect(differenceVnd('5000000000', '6000000000')).toBe('-1000000000');
    expect(isNegativeVnd('-1')).toBe(true);
    expect(isNegativeVnd('0')).toBe(false);
    expect(isNegativeVnd('junk')).toBe(false);
  });
});

describe('the proposal form (CAP-02)', () => {
  const form = (overrides: Partial<ProposalForm> = {}): ProposalForm => ({ projectId: 'p', appropriationId: 'a1', bucket: 'CURRENT_YEAR', amount: '1000', ctmtqg: '', ...overrides });

  it('judges what is missing or wrong before anything is sent', () => {
    expect(validateProposal(form(), appropriation(), 'vi')).toEqual({});
    expect(validateProposal(form({ projectId: '', appropriationId: '', amount: '' }), undefined, 'vi')).toEqual({ projectId: 'required', appropriationId: 'required', amount: 'required' });
    expect(validateProposal(form({ amount: '10.000' }), appropriation(), 'vi')).toEqual({ amount: 'invalidAmount' });
    expect(validateProposal(form({ amount: '0' }), appropriation(), 'vi')).toEqual({ amount: 'invalidAmount' });
    expect(validateProposal(form({ amount: '4000' }), appropriation(), 'vi')).toEqual({});
    expect(validateProposal(form({ amount: '4000,000001' }), appropriation(), 'vi')).toEqual({ amount: 'exceedsRemaining' });
    expect(validateProposal(form({ amount: '100', ctmtqg: '100' }), appropriation(), 'vi')).toEqual({});
    expect(validateProposal(form({ amount: '100', ctmtqg: '100,000001' }), appropriation(), 'vi')).toEqual({ ctmtqg: 'subsetExceeds' });
    expect(validateProposal(form({ amount: '100', ctmtqg: 'x' }), appropriation(), 'vi')).toEqual({ ctmtqg: 'invalidAmount' });
  });

  it('sends the amounts as exact VND, the source year of the appropriation, and the CTMTQG part only when there is one', () => {
    expect(proposalBody(form({ amount: '1234,567891' }), appropriation({ sourceYear: 2025 }), 'vi')).toEqual({
      lines: [{ project_id: 'p', appropriation_id: 'a1', bucket: 'CURRENT_YEAR', source_year: 2025, amount_vnd: '1234567891' }],
    });
    expect(proposalBody(form({ amount: '1000', ctmtqg: '400' }), appropriation(), 'vi').lines[0]).toMatchObject({ amount_vnd: String(BILLION), ctmtqg_subset_vnd: '400000000' });
  });
});

describe('the plan form (CAP-01)', () => {
  const form = (overrides: Partial<PlanForm> = {}): PlanForm => ({ planCode: 'TH-2026', planKind: 'MEDIUM_TERM', planYear: '', periodFrom: '2026', periodTo: '2030', scopeUnitId: 'U', ...overrides });

  it('judges a medium-term plan by its period and an annual plan by its year', () => {
    expect(validatePlanForm(form())).toEqual({});
    expect(validatePlanForm(form({ planCode: ' ', scopeUnitId: '', periodFrom: '', periodTo: '' }))).toEqual({ planCode: 'required', scopeUnitId: 'required', periodFrom: 'required', periodTo: 'required' });
    expect(validatePlanForm(form({ planCode: 'x'.repeat(51), periodFrom: '26', periodTo: '3000' }))).toEqual({ planCode: 'tooLong', periodFrom: 'invalidYear', periodTo: 'invalidYear' });
    expect(validatePlanForm(form({ periodFrom: '2030', periodTo: '2030' }))).toEqual({ periodTo: 'periodOrder' });
    expect(validatePlanForm(form({ planKind: 'ANNUAL', planYear: '2026' }))).toEqual({});
    expect(validatePlanForm(form({ planKind: 'ANNUAL', planYear: '' }))).toEqual({ planYear: 'required' });
    expect(validatePlanForm(form({ planKind: 'ANNUAL', planYear: '1800' }))).toEqual({ planYear: 'invalidYear' });
  });

  it('sends the body of each kind: the year of an annual plan is its whole period, a medium-term plan has no plan year', () => {
    expect(planBody(form({ planCode: ' TH-2026 ', scopeUnitId: 'ABC' }))).toEqual({ plan_code: 'TH-2026', plan_kind: 'MEDIUM_TERM', period_from_year: 2026, period_to_year: 2030, scope_unit_id: 'abc' });
    expect(planBody(form({ planKind: 'ANNUAL', planYear: '2027' }))).toEqual({ plan_code: 'TH-2026', plan_kind: 'ANNUAL', plan_year: 2027, period_from_year: 2027, period_to_year: 2027, scope_unit_id: 'U'.toLowerCase() });
  });
});

describe('the allocation grid (CAP-06)', () => {
  const lines = [line(1, { amount_vnd: String(BILLION), ctmtqg_subset_vnd: '400000000' }), line(2, { amount_vnd: String(2 * BILLION) })];
  const rowsOf = (edits: GridEdits = {}, source: readonly PlanLine[] = lines) => gridRows(source, edits, 'vi', toMillions);
  const typed = (n: number, amount: string, extra: Partial<{ ctmtqg: string; remove: boolean }> = {}): GridEdits => ({
    [(lines[n - 1] as PlanLine).id]: { ...startEdit(lines[n - 1] as PlanLine, toMillions), amount, ...extra },
  });

  it('starts each line with its own amounts in millions, unchanged', () => {
    const rows = rowsOf();
    expect(rows.map((row) => [row.edit.amount, row.edit.ctmtqg, row.changed, row.problem])).toEqual([
      ['1000', '400', false, undefined],
      ['2000', '', false, undefined],
    ]);
    expect(gridBody(rows)).toEqual({ ok: false, reason: 'nothing' });
    expect(nextTotal(rows)).toBe(String(3 * BILLION));
  });

  it('follows the remaining ceiling of the source as amounts change, and gives capital back on a lower amount or a removal (UI-CAP-06)', () => {
    // The appropriation has 4 billion left; the first line goes from 1 to 4 billion (+3), leaving 1 billion.
    const raised = rowsOf(typed(1, '4000'));
    expect(ceilingStates(raised)).toEqual([{ appropriationId: (lines[0] as PlanLine).appropriation?.id, remainingVnd: String(BILLION), exceeded: false }]);
    // The second line goes from 2 to 4 billion too: the two changes take 5 billion of the 4 that are left, one short.
    const both = rowsOf({ ...typed(1, '4000'), ...typed(2, '4000') });
    expect(ceilingStates(both)[0]).toMatchObject({ remainingVnd: String(-1 * BILLION), exceeded: true });
    expect(gridBody(both)).toEqual({ ok: false, reason: 'exceeded' });
    // Lowering the second line gives capital back.
    expect(ceilingStates(rowsOf({ ...typed(1, '4000'), ...typed(2, '1000') }))[0]).toMatchObject({ remainingVnd: String(2 * BILLION), exceeded: false });
    // A removal gives all of the line back.
    expect(ceilingStates(rowsOf(typed(2, '2000', { remove: true })))[0]).toMatchObject({ remainingVnd: String(6 * BILLION) });
    expect(nextTotal(rowsOf(typed(2, '2000', { remove: true })))).toBe(String(BILLION));
  });

  it('builds the body of the lines that changed, with the CTMTQG part inside the line', () => {
    const outcome = gridBody(rowsOf(typed(1, '1500', { ctmtqg: '600' })));
    expect(outcome).toEqual({
      ok: true,
      body: { lines: [{ project_id: (lines[0] as PlanLine).project.id, appropriation_id: (lines[0] as PlanLine).appropriation?.id, bucket: 'CURRENT_YEAR', source_year: 2026, amount_vnd: '1500000000', ctmtqg_subset_vnd: '600000000' }] },
    });
    // The CTMTQG part of a line is cleared by emptying it.
    const cleared = gridBody(rowsOf(typed(1, '1000', { ctmtqg: '' })));
    expect(cleared).toMatchObject({ ok: true, body: { lines: [{ amount_vnd: String(BILLION) }] } });
    expect((cleared as unknown as { body: { lines: Array<Record<string, unknown>> } }).body.lines[0]).not.toHaveProperty('ctmtqg_subset_vnd');
  });

  it('judges the amounts typed: not an amount, and a CTMTQG part larger than the line', () => {
    expect(rowsOf(typed(1, 'abc'))[0]?.problem).toBe('invalidAmount');
    expect(rowsOf(typed(1, '10.000'))[0]?.problem).toBe('invalidAmount');
    expect(rowsOf(typed(1, '100', { ctmtqg: '101' }))[0]?.problem).toBe('subsetExceeds');
    expect(gridBody(rowsOf(typed(1, 'abc')))).toEqual({ ok: false, reason: 'invalid' });
    // The ceiling counts a line with an amount it cannot read as unchanged.
    expect(ceilingStates(rowsOf(typed(1, 'abc')))[0]?.remainingVnd).toBe(String(4 * BILLION));
  });

  it('removes lines: a command that only removes sends no line, whether lines stay or every line goes (CR-CAP-01)', () => {
    const removal = gridBody(rowsOf(typed(2, '2000', { remove: true })));
    expect(removal).toEqual({ ok: true, body: { lines: [], remove_line_ids: [(lines[1] as PlanLine).id] } });
    const all = gridBody(rowsOf({ ...typed(1, '1000', { remove: true }), ...typed(2, '2000', { remove: true }) }));
    expect(all).toEqual({ ok: true, body: { lines: [], remove_line_ids: [(lines[0] as PlanLine).id, (lines[1] as PlanLine).id] } });
    // A change and a removal together: the change is the line of the command.
    const mixed = gridBody(rowsOf({ ...typed(1, '1100'), ...typed(2, '2000', { remove: true }) }));
    expect(mixed).toMatchObject({ ok: true, body: { lines: [{ amount_vnd: '1100000000' }], remove_line_ids: [(lines[1] as PlanLine).id] } });
  });

  it('leaves a line that draws on no appropriation as it is (it can only be removed)', () => {
    const orphan = line(1, { appropriation: null });
    const rows = gridRows([orphan], { [orphan.id]: { ...startEdit(orphan, toMillions), amount: '5' } }, 'vi', toMillions);
    expect(rows[0]).toMatchObject({ changed: false, problem: undefined });
    expect(ceilingStates(rows)).toEqual([]);
    expect(gridBody(gridRows([orphan], { [orphan.id]: { ...startEdit(orphan, toMillions), remove: true } }, 'vi', toMillions))).toEqual({ ok: true, body: { lines: [], remove_line_ids: [orphan.id] } });
    const other = line(2);
    const withOther = gridRows([orphan, other], { [orphan.id]: { ...startEdit(orphan, toMillions), remove: true } }, 'vi', toMillions);
    expect(gridBody(withOther)).toEqual({ ok: true, body: { lines: [], remove_line_ids: [orphan.id] } });
  });
});

describe('the refusals of the planning commands', () => {
  it.each([
    ['APPROPRIATION_EXCEEDED', 'ceilingExceeded'],
    ['SUBSET_EXCEEDS_PARENT', 'subsetExceeds'],
    ['PLAN_NOT_DRAFT', 'planNotDraft'],
    ['FISCAL_YEAR_LOCKED', 'yearLocked'],
    ['PROJECT_STAGE_INVALID', 'stageInvalid'],
    ['APPROPRIATION_NOT_PUBLISHED', 'appropriationNotPublished'],
    ['PLAN_CODE_DUPLICATE', 'planCodeDuplicate'],
    ['VERSION_CONFLICT', 'versionConflict'],
    ['FIELD_NOT_ALLOWED', 'notAllowed'],
    ['VALIDATION_FAILED', 'validation'],
    ['INVALID_REQUEST', 'validation'],
    ['RESOURCE_NOT_FOUND', 'notFound'],
    ['SOMETHING_NEW', 'general'],
  ])('maps %s to %s', (code, reason) => {
    expect(describePlanProblem(problem(code, 422, {}, 'amount_vnd'))).toEqual({ reason, field: 'amount_vnd', availableVnd: undefined });
  });

  it('carries what the appropriation had left, only when it is an exact amount, and is denied on any 403', () => {
    expect(describePlanProblem(problem('APPROPRIATION_EXCEEDED', 422, { available_vnd: '5000000000' }))).toMatchObject({ reason: 'ceilingExceeded', availableVnd: '5000000000' });
    expect(describePlanProblem(problem('APPROPRIATION_EXCEEDED', 422, { available_vnd: '5.5' })).availableVnd).toBeUndefined();
    expect(describePlanProblem(problem('SCOPE_DENIED', 403)).reason).toBe('denied');
    expect(describePlanProblem(new Error('x')).reason).toBe('general');
  });
});
