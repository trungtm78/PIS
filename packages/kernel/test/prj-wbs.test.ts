import { MAX_COMPONENT_DEPTH, assertComponentInput, assertMilestoneInput, assertMilestoneProgress, calendarDaysBetween, delayDays, formsCycle, wbsExceedsTotal } from '../src/prj-wbs';

const refusal = (run: () => unknown): { code: string; detail: string | undefined; status: number } => {
  try {
    run();
  } catch (error) {
    const known = error as { code: string; detail?: string; status: number };
    return { code: known.code, detail: known.detail, status: known.status };
  }
  throw new Error('it was allowed');
};
const UUID = '00000000-0000-4000-8000-0000000000a1';
const TODAY = '2026-10-31';

describe('the work breakdown and the milestones of a project (ST-PRJ-009, BR-PRJ-08)', () => {
  it('takes a component with a code, a name, a parent, a value in whole dong, a place and a day', () => {
    expect(assertComponentInput({ code: ' C1 ', name: '  Gói xây lắp ', parent_component_id: UUID.toUpperCase(), planned_value_vnd: '8000000000', sort_order: 3, valid_from: '2026-01-01' })).toEqual({
      code: 'C1',
      name: 'Gói xây lắp',
      parentId: UUID,
      plannedValueVnd: '8000000000',
      sortOrder: 3,
      validFrom: '2026-01-01',
    });
    expect(assertComponentInput({ code: 'C1', name: 'Gói xây lắp', planned_value_vnd: '0', valid_from: '2026-01-01' })).toMatchObject({ parentId: undefined, sortOrder: 0, plannedValueVnd: '0' });
    expect(MAX_COMPONENT_DEPTH).toBe(6);
  });

  it('refuses a component with a code that is not one, a short name, a value that is not money, a place out of range or a day that is not real', () => {
    const base = { code: 'C1', name: 'Gói xây lắp', planned_value_vnd: '10', valid_from: '2026-01-01' };
    const detail = (extra: Record<string, unknown>) => refusal(() => assertComponentInput({ ...base, ...extra }));
    for (const code of [undefined, '', '-x', 'a b', 'x'.repeat(31)]) expect(detail({ code }).detail).toBe('code');
    for (const name of [undefined, 'x', 'n'.repeat(301)]) expect(detail({ name }).detail).toBe('name');
    for (const value of [undefined, '-1', '1.5', 'x', 10]) expect(detail({ planned_value_vnd: value }).detail).toBe('planned_value_vnd');
    for (const sort of [-1, 100_001, 1.5, '1']) expect(detail({ sort_order: sort }).detail).toBe('sort_order');
    for (const day of [undefined, '2026-02-30', '1/1/2026']) expect(detail({ valid_from: day }).detail).toBe('valid_from');
    expect(detail({ parent_component_id: 'x' })).toEqual({ code: 'VALIDATION_FAILED', detail: 'parent_component_id', status: 422 });
  });

  it('takes a milestone with a baseline day, a planned day and what it waits for', () => {
    expect(assertMilestoneInput({ code: 'M-KC', name: 'Khởi công', component_id: UUID, baseline_date: '2026-02-15', planned_date: '2026-02-20', depends_on_milestone_id: UUID.toUpperCase() })).toEqual({
      code: 'M-KC',
      name: 'Khởi công',
      componentId: UUID,
      baselineDate: '2026-02-15',
      plannedDate: '2026-02-20',
      dependsOnId: UUID,
    });
    expect(assertMilestoneInput({ code: 'M-KC', name: 'Khởi công', baseline_date: '2026-02-15', planned_date: '2026-02-10' })).toMatchObject({ componentId: undefined, dependsOnId: undefined });
    const detail = (extra: Record<string, unknown>) => refusal(() => assertMilestoneInput({ code: 'M1', name: 'Khởi công', baseline_date: '2026-02-15', planned_date: '2026-02-20', ...extra })).detail;
    expect([detail({ code: '' }), detail({ name: 'x' }), detail({ baseline_date: '2026-13-01' }), detail({ planned_date: undefined }), detail({ component_id: 'x' }), detail({ depends_on_milestone_id: 5 })]).toEqual([
      'code', 'name', 'baseline_date', 'planned_date', 'component_id', 'depends_on_milestone_id',
    ]);
  });

  it('UAT-AC218: marking a milestone done needs the day it was done (422 on actual_date), a real day that is not in the future', () => {
    const now = { status: 'PLANNED' as const, plannedDate: '2026-02-20' };
    expect(refusal(() => assertMilestoneProgress({ status: 'DONE' }, now, TODAY))).toEqual({ code: 'VALIDATION_FAILED', detail: 'actual_date', status: 422 });
    for (const bad of ['2026-02-30', '2026-11-01', 'x', 5]) expect(refusal(() => assertMilestoneProgress({ status: 'DONE', actual_date: bad }, now, TODAY)).detail).toBe('actual_date');
    expect(assertMilestoneProgress({ status: 'DONE', actual_date: '2026-03-02', reason: '  On site  ' }, now, TODAY)).toEqual({ status: 'DONE', actualDate: '2026-03-02', plannedDate: undefined, reason: 'On site' });
    expect(assertMilestoneProgress({ status: 'DONE', actual_date: TODAY, reason: '' }, now, TODAY).reason).toBeUndefined();
    expect(refusal(() => assertMilestoneProgress({ status: 'DONE', actual_date: TODAY, planned_date: '2026-12-01' }, now, TODAY)).detail).toBe('planned_date');
  });

  it('delays a milestone to a later planned day with a reason, and cancels it with a reason, each refusing the fields of the others', () => {
    const now = { status: 'DELAYED' as const, plannedDate: '2026-02-20' };
    expect(assertMilestoneProgress({ status: 'DELAYED', planned_date: '2026-03-20', reason: 'Site clearance is late' }, now, TODAY)).toEqual({ status: 'DELAYED', actualDate: undefined, plannedDate: '2026-03-20', reason: 'Site clearance is late' });
    const detail = (raw: Record<string, unknown>) => refusal(() => assertMilestoneProgress(raw as never, now, TODAY)).detail;
    expect([detail({ status: 'DELAYED', planned_date: '2026-02-20', reason: 'Site clearance is late' }), detail({ status: 'DELAYED', planned_date: '2026-02-19', reason: 'Site clearance is late' }), detail({ status: 'DELAYED', reason: 'Site clearance is late' })]).toEqual([
      'planned_date', 'planned_date', 'planned_date',
    ]);
    expect([detail({ status: 'DELAYED', planned_date: '2026-03-20' }), detail({ status: 'DELAYED', planned_date: '2026-03-20', reason: 'no' }), detail({ status: 'CANCELLED' }), detail({ status: 'CANCELLED', reason: 'x'.repeat(2001) })]).toEqual(['reason', 'reason', 'reason', 'reason']);
    expect(detail({ status: 'DELAYED', planned_date: '2026-03-20', reason: 'Site clearance is late', actual_date: TODAY })).toBe('actual_date');
    expect(assertMilestoneProgress({ status: 'CANCELLED', reason: 'The works were dropped' }, now, TODAY)).toEqual({ status: 'CANCELLED', actualDate: undefined, plannedDate: undefined, reason: 'The works were dropped' });
    expect([detail({ status: 'CANCELLED', reason: 'The works were dropped', actual_date: TODAY }), detail({ status: 'CANCELLED', reason: 'The works were dropped', planned_date: '2026-03-20' })]).toEqual(['actual_date', 'planned_date']);
    expect(detail({ status: 'PLANNED' })).toBe('status');
  });

  it('moves a milestone that is done or cancelled no more (409 MILESTONE_STATE_INVALID)', () => {
    for (const status of ['DONE', 'CANCELLED'] as const) {
      expect(refusal(() => assertMilestoneProgress({ status: 'DONE', actual_date: TODAY }, { status, plannedDate: '2026-02-20' }, TODAY))).toEqual({ code: 'MILESTONE_STATE_INVALID', detail: 'status', status: 409 });
    }
    expect(assertMilestoneProgress({ status: 'DONE', actual_date: TODAY }, { status: 'PLANNED', plannedDate: '2026-02-20' }, TODAY).status).toBe('DONE');
  });

  it('counts a delay in calendar days from the baseline: the day it was done, else the planned day, else today when that day has passed', () => {
    expect(calendarDaysBetween('2026-02-15', '2026-03-02')).toBe(15);
    expect(calendarDaysBetween('2026-03-02', '2026-02-15')).toBe(-15);
    const milestone = { status: 'DONE' as const, baselineDate: '2026-02-15', plannedDate: '2026-02-20', actualDate: '2026-03-02' };
    expect(delayDays(milestone, TODAY)).toBe(15);
    expect(delayDays({ ...milestone, actualDate: '2026-02-10' }, TODAY)).toBe(0);
    expect(delayDays({ ...milestone, status: 'PLANNED', actualDate: null, plannedDate: '2026-12-01' }, TODAY)).toBe(calendarDaysBetween('2026-02-15', '2026-12-01'));
    expect(delayDays({ ...milestone, status: 'PLANNED', actualDate: null, plannedDate: '2026-10-01' }, TODAY)).toBe(calendarDaysBetween('2026-02-15', TODAY));
    expect(delayDays({ ...milestone, status: 'PLANNED', actualDate: null, plannedDate: '2026-02-15' }, '2026-02-15')).toBe(0);
    expect(delayDays({ ...milestone, status: 'CANCELLED', actualDate: null }, TODAY)).toBe(0);
  });

  it('UAT-PLAN-58: finds a loop in what milestones wait for, and none where there is not one', () => {
    const links = new Map<string, string | null>([['M3', 'M2'], ['M2', 'M1'], ['M1', null]]);
    expect(formsCycle(links, 'M1', 'M3')).toBe(true);
    expect(formsCycle(links, 'M1', 'M1')).toBe(true);
    expect(formsCycle(links, 'M1', 'M2')).toBe(true);
    expect(formsCycle(links, 'M3', 'M1')).toBe(false);
    expect(formsCycle(links, 'M2', 'M3')).toBe(true);
    expect(formsCycle(new Map(), 'M1', 'M2')).toBe(false);
    // A loop that does not pass through the milestone is not its business and does not hang.
    expect(formsCycle(new Map<string, string | null>([['A', 'B'], ['B', 'A']]), 'M1', 'A')).toBe(false);
  });

  it('UAT-AC218: finds the first-level values adding up to more than the total (30 + 10 + 8 > 45 billion), and not when they fit', () => {
    expect(wbsExceedsTotal(['30000000000', '10000000000', '8000000000'], '45000000000')).toBe(true);
    expect(wbsExceedsTotal(['30000000000', '10000000000'], '45000000000')).toBe(false);
    expect(wbsExceedsTotal(['45000000000'], '45000000000')).toBe(false);
    expect(wbsExceedsTotal([], '0')).toBe(false);
  });
});

