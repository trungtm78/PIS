import { buildProcessTree, isTreeNodeId, packageInNode, packagesOfNode, treeNodeId } from '../src/bid-process-tree.ts';
import type { ProcessTree, TreeNode, TreePackage } from '../src/bid-process-tree.ts';
import { buildPackageTimeline, filterTimeline, ganttOf, groupTimelineByDay, mergeRecentChanges, timelineSummary } from '../src/bid-timeline.ts';
import type { TimelineInput, TimelineVisitFact } from '../src/bid-timeline.ts';
import type { WorkflowDefinition, WorkflowStepDef } from '../src/bid-workflow.ts';
import type { WorkCalendarContent, WorkCalendarSource } from '../src/working-time.ts';

const step = (code: string, order: number, days: number): WorkflowStepDef => ({ code, name: `Bước ${code}`, order, entryCondition: 'vào', exitCondition: 'ra', responsibleRole: 'PROCUREMENT_OFFICER', standardWorkingDays: days, evidenceKinds: [], milestoneKind: null, makerChecker: false, checklist: [] });
const OPEN: WorkflowDefinition = { method: 'OPEN_BIDDING', name: 'Đấu thầu rộng rãi', stalledAfterWorkingDays: 5, checklistWarnDays: 2, steps: [step('ST_A', 1, 2), step('ST_B', 2, 4), step('ST_C', 3, 4)] };
const DIRECT: WorkflowDefinition = { method: 'DIRECT_PURCHASE', name: 'Mua sắm trực tiếp', stalledAfterWorkingDays: 5, checklistWarnDays: 2, steps: [step('ST_X', 1, 1)] };

const ASOF = '2026-11-12';
const pkg = (id: string, over: Partial<TreePackage>): TreePackage => ({ id, method: 'OPEN_BIDDING', status: 'IN_PROGRESS', currentStep: null, enteredOn: null, enteredVia: null, dueOn: null, valueVnd: '0', transitions: [], ...over });

/**
 * Eight packages, as computed by hand (as-of 12 November, no working calendar so days are calendar days):
 *  p1 not started 100 · p2 in A on track entered 10/11 (2 days) 200 · p3 in A late entered 02/11 due 09/11 (10 days) 300 · p4 in B returned entered 05/11 (7 days) 400
 *  p5 in B on hold entered 01/11 (11 days) 500 · p6 completed 600 · p7 cancelled 700 · p8 direct purchase, in X, entered 12/11 (0 days) 800. Total 8 packages, 3600.
 */
const PACKAGES: TreePackage[] = [
  pkg('p1', { status: 'NOT_STARTED', valueVnd: '100' }),
  pkg('p2', { currentStep: 'ST_A', enteredOn: '2026-11-10', enteredVia: 'START', dueOn: '2026-11-20', valueVnd: '200', transitions: [{ kind: 'START', from: null, to: 'ST_A', on: '2026-11-10' }] }),
  pkg('p3', { currentStep: 'ST_A', enteredOn: '2026-11-02', enteredVia: 'START', dueOn: '2026-11-09', valueVnd: '300', transitions: [{ kind: 'START', from: null, to: 'ST_A', on: '2026-11-02' }] }),
  pkg('p4', {
    currentStep: 'ST_B',
    enteredOn: '2026-11-05',
    enteredVia: 'RETURN',
    dueOn: '2026-11-30',
    valueVnd: '400',
    transitions: [
      { kind: 'START', from: null, to: 'ST_A', on: '2026-11-01' },
      { kind: 'ADVANCE', from: 'ST_A', to: 'ST_B', on: '2026-11-03' },
      { kind: 'ADVANCE', from: 'ST_B', to: 'ST_C', on: '2026-11-04' },
      { kind: 'RETURN', from: 'ST_C', to: 'ST_B', on: '2026-11-05' },
    ],
  }),
  pkg('p5', {
    status: 'ON_HOLD',
    currentStep: 'ST_B',
    enteredOn: '2026-11-01',
    enteredVia: 'ADVANCE',
    dueOn: '2026-11-04',
    valueVnd: '500',
    transitions: [
      { kind: 'START', from: null, to: 'ST_A', on: '2026-10-30' },
      { kind: 'ADVANCE', from: 'ST_A', to: 'ST_B', on: '2026-11-01' },
      { kind: 'HOLD', from: 'ST_B', to: 'ST_B', on: '2026-11-08' },
    ],
  }),
  pkg('p6', { status: 'COMPLETED', valueVnd: '600', transitions: [{ kind: 'START', from: null, to: 'ST_A', on: '2026-10-20' }, { kind: 'COMPLETE', from: 'ST_C', to: null, on: '2026-11-10' }] }),
  pkg('p7', { status: 'CANCELLED', valueVnd: '700', transitions: [{ kind: 'CANCEL', from: 'ST_B', to: null, on: '2026-11-06' }] }),
  pkg('p8', { method: 'DIRECT_PURCHASE', currentStep: 'ST_X', enteredOn: '2026-11-12', enteredVia: 'START', dueOn: '2026-11-12', valueVnd: '800' }),
];

const tree = (): ProcessTree => buildProcessTree([OPEN, DIRECT], PACKAGES, { asOf: ASOF, period: { from: '2026-11-01', to: '2026-11-12' } });
const node = (built: ProcessTree, id: string): TreeNode => {
  const found = built.nodes.find((one) => one.id === id);
  if (found === undefined) throw new Error(`no node ${id}`);
  return found;
};
const edge = (built: ProcessTree, from: string, to: string, kind: string): number => built.edges.find((one) => one.from === from && one.to === to && one.kind === kind)?.count ?? 0;

describe('the process tree', () => {
  it('counts every package once, with the total value and the shares of the method', () => {
    const built = tree();
    expect(built.totalCount).toBe(8);
    expect(built.totalValueVnd).toBe('3600');
    const root = node(built, 'ROOT');
    expect([root.count, root.valueVnd]).toEqual([8, '3600']);
    const open = node(built, 'M:OPEN_BIDDING');
    // 7 of 8 packages = 87,50 %; 2800 of 3600 = 77,78 %.
    expect([open.count, open.valueVnd, open.shareCountBp, open.shareValueBp]).toEqual([7, '2800', 8750, 7778]);
    expect(node(built, 'M:DIRECT_PURCHASE').count).toBe(1);
  });

  it('puts the packages of a step into on hold, late, returned and on track, which add up to the step', () => {
    const built = tree();
    const a = node(built, 'S:OPEN_BIDDING:ST_A');
    expect([a.count, a.valueVnd, a.lateCount]).toEqual([2, '500', 1]);
    expect(node(built, 'S:OPEN_BIDDING:ST_A:LATE').count).toBe(1);
    expect(node(built, 'S:OPEN_BIDDING:ST_A:ON_TRACK').count).toBe(1);
    const b = node(built, 'S:OPEN_BIDDING:ST_B');
    expect([b.count, b.valueVnd, b.lateCount]).toEqual([2, '900', 0]);
    expect(node(built, 'S:OPEN_BIDDING:ST_B:ON_HOLD').count).toBe(1);
    expect(node(built, 'S:OPEN_BIDDING:ST_B:RETURNED').count).toBe(1);
    for (const stepNode of built.nodes.filter((one) => one.kind === 'STEP')) {
      const children = built.nodes.filter((one) => one.parentId === stepNode.id);
      expect(children.reduce((sum, one) => sum + one.count, 0)).toBe(stepNode.count);
    }
  });

  it('does not call a package on hold late even when its day has passed', () => {
    expect(node(tree(), 'S:OPEN_BIDDING:ST_B').lateCount).toBe(0);
  });

  it('takes the median of the days the packages have been in the node: 2 and 10 give 6, 7 and 11 give 9', () => {
    const built = tree();
    expect(node(built, 'S:OPEN_BIDDING:ST_A').medianDays).toBe(6);
    expect(node(built, 'S:OPEN_BIDDING:ST_B').medianDays).toBe(9);
    expect(node(built, 'S:OPEN_BIDDING:ST_A').medianBasis).toBe('CALENDAR_DAYS');
    expect(node(built, 'S:OPEN_BIDDING:ST_C').medianDays).toBeNull();
    expect(node(built, 'T:OPEN_BIDDING:COMPLETED').medianDays).toBeNull();
  });

  it('counts the terminals: not started, completed and cancelled', () => {
    const built = tree();
    expect([node(built, 'T:OPEN_BIDDING:NOT_STARTED').count, node(built, 'T:OPEN_BIDDING:COMPLETED').count, node(built, 'T:OPEN_BIDDING:CANCELLED').count]).toEqual([1, 1, 1]);
    expect(node(built, 'T:OPEN_BIDDING:CANCELLED').valueVnd).toBe('700');
  });

  it('counts the moves of the period along each edge, the returns and the drop-outs apart', () => {
    const built = tree();
    expect(edge(built, 'T:OPEN_BIDDING:NOT_STARTED', 'S:OPEN_BIDDING:ST_A', 'ADVANCE')).toBe(3);
    expect(edge(built, 'S:OPEN_BIDDING:ST_A', 'S:OPEN_BIDDING:ST_B', 'ADVANCE')).toBe(2);
    expect(edge(built, 'S:OPEN_BIDDING:ST_B', 'S:OPEN_BIDDING:ST_C', 'ADVANCE')).toBe(1);
    expect(edge(built, 'S:OPEN_BIDDING:ST_C', 'S:OPEN_BIDDING:ST_B', 'RETURN')).toBe(1);
    expect(edge(built, 'S:OPEN_BIDDING:ST_B', 'S:OPEN_BIDDING:ST_B:ON_HOLD', 'HOLD')).toBe(1);
    expect(edge(built, 'S:OPEN_BIDDING:ST_C', 'T:OPEN_BIDDING:COMPLETED', 'COMPLETE')).toBe(1);
    expect(edge(built, 'S:OPEN_BIDDING:ST_B', 'T:OPEN_BIDDING:CANCELLED', 'CANCEL')).toBe(1);
  });

  it('leaves out the moves outside the period', () => {
    const narrow = buildProcessTree([OPEN, DIRECT], PACKAGES, { asOf: ASOF, period: { from: '2026-11-04', to: '2026-11-12' } });
    expect(edge(narrow, 'T:OPEN_BIDDING:NOT_STARTED', 'S:OPEN_BIDDING:ST_A', 'ADVANCE')).toBe(1);
    expect(edge(narrow, 'S:OPEN_BIDDING:ST_A', 'S:OPEN_BIDDING:ST_B', 'ADVANCE')).toBe(0);
  });

  it('gives each node its path from the root and the route of steps that lead to it', () => {
    const built = tree();
    expect(node(built, 'S:OPEN_BIDDING:ST_B:RETURNED').path).toEqual(['ROOT', 'M:OPEN_BIDDING', 'S:OPEN_BIDDING:ST_B', 'S:OPEN_BIDDING:ST_B:RETURNED']);
    expect(node(built, 'S:OPEN_BIDDING:ST_B:RETURNED').route).toEqual(['ST_A', 'ST_B']);
    expect(node(built, 'T:OPEN_BIDDING:COMPLETED').path).toEqual(['ROOT', 'M:OPEN_BIDDING', 'T:OPEN_BIDDING:COMPLETED']);
    expect(node(built, 'M:OPEN_BIDDING').path).toEqual(['ROOT', 'M:OPEN_BIDDING']);
  });

  it('shows an empty method only when asked, and a package under a step the definition no longer has goes under its method, not into a step that is not there', () => {
    expect(tree().nodes.some((one) => one.id === 'M:LIMITED_BIDDING')).toBe(false);
    const withEmpty = buildProcessTree([OPEN, DIRECT, { ...OPEN, method: 'LIMITED_BIDDING' }], PACKAGES, { asOf: ASOF, period: { from: '2026-11-01', to: '2026-11-12' }, includeEmptyMethods: true });
    expect(node(withEmpty, 'M:LIMITED_BIDDING').count).toBe(0);
    const orphan = buildProcessTree([OPEN], [pkg('o1', { currentStep: 'ST_GONE', enteredOn: '2026-11-10', enteredVia: 'START', valueVnd: '50' })], { asOf: ASOF, period: { from: '2026-11-01', to: '2026-11-12' } });
    expect(node(orphan, 'M:OPEN_BIDDING').count).toBe(1);
    expect(orphan.nodes.filter((one) => one.kind === 'STEP').every((one) => one.count === 0)).toBe(true);
  });

  it('has shares of 0 and no division by zero for an empty set', () => {
    const empty = buildProcessTree([OPEN], [], { asOf: ASOF, period: { from: '2026-11-01', to: '2026-11-12' } });
    expect(empty.totalCount).toBe(0);
    expect(empty.nodes).toHaveLength(1);
    expect(empty.nodes[0]).toMatchObject({ count: 0, shareCountBp: 0, shareValueBp: 0, valueVnd: '0' });
  });

  it('counts working days when the calendar is published, so the median is in working days', () => {
    const calendar: WorkCalendarContent = { calendar_code: 'W', year: 2026, working_days: [1, 2, 3, 4, 5], holidays: [], legal_basis_ref: 'fixture' };
    const calendars: WorkCalendarSource = { forYear: (year) => (year === 2026 ? calendar : undefined) };
    // p2 entered Tue 10/11: 2 days (Wed, Thu) = 2 working days; p3 entered Mon 02/11: Tue 3 .. Thu 12 = 8 working days; median of 2 and 8 is 5.
    const built = buildProcessTree([OPEN, DIRECT], PACKAGES, { asOf: ASOF, period: { from: '2026-11-01', to: '2026-11-12' }, calendars });
    expect(node(built, 'S:OPEN_BIDDING:ST_A')).toMatchObject({ medianDays: 5, medianBasis: 'WORKING_DAYS' });
  });
});

describe('the packages of a node', () => {
  it('is the same rule the tree counts with: a node holds the packages of its sub-states, a method holds all of its own', () => {
    const ids = (nodeId: string): string[] => packagesOfNode(PACKAGES, nodeId, ASOF, [OPEN, DIRECT]).map((one) => one.id);
    expect(ids('S:OPEN_BIDDING:ST_A')).toEqual(['p2', 'p3']);
    expect(ids('S:OPEN_BIDDING:ST_A:LATE')).toEqual(['p3']);
    expect(ids('S:OPEN_BIDDING:ST_B')).toEqual(['p4', 'p5']);
    expect(ids('T:OPEN_BIDDING:CANCELLED')).toEqual(['p7']);
    expect(ids('M:OPEN_BIDDING')).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
    expect(ids('ROOT')).toHaveLength(8);
    const built = tree();
    for (const one of built.nodes) expect(ids(one.id)).toHaveLength(one.count);
  });

  it('knows a well formed node id', () => {
    for (const id of ['ROOT', 'M:OPEN_BIDDING', 'S:OPEN_BIDDING:ST_A', 'S:OPEN_BIDDING:ST_A:LATE', 'T:OPEN_BIDDING:COMPLETED']) expect(isTreeNodeId(id)).toBe(true);
    for (const id of ['', 'X:OPEN', 'S:OPEN_BIDDING', 'S:open:ST_A', 'S:OPEN_BIDDING:ST_A:SLEEPING', 'T:OPEN_BIDDING:DONE', 'M:A:B', 7]) expect(isTreeNodeId(id)).toBe(false);
    expect(treeNodeId.substate('OPEN_BIDDING', 'ST_A', 'LATE')).toBe('S:OPEN_BIDDING:ST_A:LATE');
    expect(packageInNode(PACKAGES[0] as TreePackage, 'M:OPEN_BIDDING', ASOF, [OPEN])).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The timeline of one package.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const visit = (over: Partial<TimelineVisitFact> & Pick<TimelineVisitFact, 'visit' | 'stepCode' | 'enteredAt'>): TimelineVisitFact => ({ enteredBy: 'u1', entryKind: 'ADVANCE', exitedAt: null, exitedBy: null, exitKind: null, dueOn: null, note: null, ...over });

/** Times are UTC; Vietnam is seven hours ahead, so 01:00Z is 08:00 of the same day. */
const INPUT: TimelineInput = {
  definition: OPEN,
  startedAt: '2026-11-02T01:00:00.000Z',
  startedBy: 'u1',
  completedAt: null,
  today: '2026-11-12',
  visits: [
    visit({ visit: 1, stepCode: 'ST_A', enteredAt: '2026-11-02T01:00:00.000Z', entryKind: 'START', exitedAt: '2026-11-04T03:00:00.000Z', exitedBy: 'u2', exitKind: 'ADVANCE', dueOn: '2026-11-04' }),
    visit({ visit: 2, stepCode: 'ST_B', enteredAt: '2026-11-04T03:00:00.000Z', exitedAt: '2026-11-12T03:00:00.000Z', exitedBy: 'u3', exitKind: 'RETURN', dueOn: '2026-11-06' }),
    visit({ visit: 3, stepCode: 'ST_A', enteredAt: '2026-11-12T03:00:00.000Z', entryKind: 'RETURN', note: 'Thiếu hồ sơ kỹ thuật', dueOn: '2026-11-16' }),
  ],
  items: [{ stepCode: 'ST_A', itemCode: 'A1', name: 'Dự thảo', required: true, dueOn: null, completedAt: '2026-11-03T05:00:00.000Z', completedBy: 'u1', status: 'DONE', evidence: [{ kind: 'DOCUMENT', documentId: 'd1', milestoneKind: null, reference: null }] }],
  log: [{ kind: 'HOLD', at: '2026-11-06T02:00:00.000Z', actor: 'u2', stepCode: 'ST_B', reason: 'Chờ ý kiến', subject: null }],
  milestones: [{ kind: 'INVITATION_PUBLISHED', actualAt: '2026-11-05T02:00:00.000Z', source: 'IMPORT', importBatchId: 'b1' }],
};

describe('the timeline of a package', () => {
  it('lists every change in time order, state changes before the other entries of an instant, with who and how long', () => {
    const entries = buildPackageTimeline(INPUT);
    expect(entries.map((entry) => `${entry.day} ${entry.kind}`)).toEqual([
      '2026-11-02 START',
      '2026-11-03 CHECKLIST_DONE',
      '2026-11-04 STATE_CHANGE',
      '2026-11-05 IMPORT',
      '2026-11-06 HOLD',
      '2026-11-07 CLOCK_OVERDUE',
      '2026-11-12 RETURN',
    ]);
    const advance = entries.find((entry) => entry.kind === 'STATE_CHANGE');
    expect(advance).toMatchObject({ from: 'ST_A', to: 'ST_B', actor: 'u2', spentCalendarDays: 2 });
    const back = entries.find((entry) => entry.kind === 'RETURN');
    // 8 days in B (4 to 12 November); the reason is the one the return gave.
    expect(back).toMatchObject({ from: 'ST_B', to: 'ST_A', actor: 'u3', spentCalendarDays: 8, reason: 'Thiếu hồ sơ kỹ thuật' });
  });

  it('carries the evidence of an item and the file of an import, and says the day a clock ran out (day after the due day), only when the step ended late or is still open', () => {
    const entries = buildPackageTimeline(INPUT);
    expect(entries.find((entry) => entry.kind === 'CHECKLIST_DONE')?.evidence).toEqual([{ kind: 'DOCUMENT', documentId: 'd1', milestoneKind: null, reference: null }]);
    expect(entries.find((entry) => entry.kind === 'IMPORT')).toMatchObject({ subject: 'INVITATION_PUBLISHED', reason: 'b1' });
    // visit 1 ended on its due day: no overdue; visit 2 ended after 6 November: overdue on the 7th; visit 3 is not yet due.
    expect(entries.filter((entry) => entry.kind === 'CLOCK_OVERDUE').map((entry) => entry.day)).toEqual(['2026-11-07']);
  });

  it('is derived, not stored: the same facts give the same entries, and the facts are not changed', () => {
    const before = JSON.stringify(INPUT);
    expect(buildPackageTimeline(INPUT)).toEqual(buildPackageTimeline(INPUT));
    expect(JSON.stringify(INPUT)).toBe(before);
  });

  it('turns a cancellation and the completion into the last entry of the timeline', () => {
    const cancelled = buildPackageTimeline({ ...INPUT, visits: [visit({ visit: 1, stepCode: 'ST_A', enteredAt: '2026-11-02T01:00:00.000Z', entryKind: 'START', exitedAt: '2026-11-05T03:00:00.000Z', exitedBy: 'u2', exitKind: 'CANCEL', dueOn: '2026-11-10' })], items: [], log: [], milestones: [] });
    expect(cancelled.map((entry) => entry.kind)).toEqual(['START', 'CANCEL']);
    expect(cancelled[1]).toMatchObject({ from: 'ST_A', to: null, spentCalendarDays: 3 });
  });

  it('filters by day range, by person and by state changes only, and groups by day with counts', () => {
    const entries = buildPackageTimeline(INPUT);
    expect(filterTimeline(entries, { fromDay: '2026-11-04', toDay: '2026-11-06' }).map((entry) => entry.kind)).toEqual(['STATE_CHANGE', 'IMPORT', 'HOLD']);
    expect(filterTimeline(entries, { actor: 'u1' }).map((entry) => entry.kind)).toEqual(['START', 'CHECKLIST_DONE']);
    expect(filterTimeline(entries, { onlyStateChanges: true }).map((entry) => entry.kind)).toEqual(['START', 'STATE_CHANGE', 'HOLD', 'RETURN']);
    const days = groupTimelineByDay(entries, true);
    expect(days.map((day) => day.day)).toEqual(['2026-11-12', '2026-11-07', '2026-11-06', '2026-11-05', '2026-11-04', '2026-11-03', '2026-11-02']);
    expect(days[0]).toMatchObject({ stateChanges: 1, checklistDone: 0 });
    expect(days.find((day) => day.day === '2026-11-03')).toMatchObject({ stateChanges: 0, checklistDone: 1 });
  });

  it('summarises the days in each step against the standard: A has 2 + 0 days (standard 2), B has 8 days (standard 4) so 4 over', () => {
    const rows = timelineSummary(OPEN, INPUT.visits, '2026-11-12');
    expect(rows.find((row) => row.stepCode === 'ST_A')).toMatchObject({ days: 2, daysOver: 0, current: true, basis: 'CALENDAR_DAYS' });
    expect(rows.find((row) => row.stepCode === 'ST_B')).toMatchObject({ days: 8, daysOver: 4, current: false, standardWorkingDays: 4 });
    expect(rows.find((row) => row.stepCode === 'ST_C')).toBeUndefined();
  });

  it('draws the plan and what happened: the plan needs the calendar and is never guessed', () => {
    const calendar: WorkCalendarContent = { calendar_code: 'W', year: 2026, working_days: [1, 2, 3, 4, 5], holidays: [], legal_basis_ref: 'fixture' };
    const calendars: WorkCalendarSource = { forYear: (year) => (year === 2026 ? calendar : undefined) };
    const bars = ganttOf(OPEN, INPUT.visits, '2026-11-12', calendars);
    // Entered Mon 02/11; A standard 2 working days: Wed 04/11; B standard 4: Tue 10/11 (Thu 5, Fri 6, Mon 9, Tue 10); C standard 4: Mon 16/11.
    expect(bars[0]).toMatchObject({ stepCode: 'ST_A', planned: { startOn: '2026-11-02', endOn: '2026-11-04' }, actual: { startOn: '2026-11-02', endOn: '2026-11-12', open: true } });
    expect(bars[1]).toMatchObject({ stepCode: 'ST_B', planned: { startOn: '2026-11-04', endOn: '2026-11-10' }, actual: { startOn: '2026-11-04', endOn: '2026-11-12', open: false } });
    expect(bars[2]).toMatchObject({ stepCode: 'ST_C', planned: { startOn: '2026-11-10', endOn: '2026-11-16' }, actual: null });
    expect(ganttOf(OPEN, INPUT.visits, '2026-11-12').every((bar) => bar.planned === null)).toBe(true);
  });

  it('merges the feeds of several packages newest first, state changes only by default, in a fixed order', () => {
    const entries = buildPackageTimeline(INPUT);
    const feeds = new Map([
      ['p-b', entries],
      ['p-a', entries],
    ]);
    const feed = mergeRecentChanges(feeds, 3);
    expect(feed.map((one) => `${one.packageId} ${one.entry.kind}`)).toEqual(['p-a RETURN', 'p-b RETURN', 'p-a HOLD']);
    expect(mergeRecentChanges(feeds, 100, false)).toHaveLength(entries.length * 2);
  });
});
