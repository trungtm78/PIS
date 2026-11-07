import { DomainError } from '../src/errors.ts';
import {
  WORKFLOW_METHODS,
  addWorkingDays,
  assertReason,
  assertReturnTarget,
  assessAdvance,
  blockedReasons,
  canonicalWorkflowText,
  countdownOf,
  daysInStep,
  defaultWorkflowDefinition,
  evidenceKinds,
  isEvidenceKind,
  isStalled,
  medianOf,
  parseWorkflowDefinition,
  progressOf,
  registerEvidenceKind,
  stepStatistics,
  stuckPackages,
  workflowParamsOf,
  workingDaysBetween,
} from '../src/bid-workflow.ts';
import type { StepVisitFact, VisitState, WorkflowDefinition } from '../src/bid-workflow.ts';
import { builtInDefault, ruleTypeOf, validateRuleParams } from '../src/governance-rules.ts';
import type { WorkCalendarContent, WorkCalendarSource } from '../src/working-time.ts';

/** 2026: Monday to Friday, with Wednesday 11 November a holiday (a made-up day for the fixture). 2027 is not published. */
const CALENDAR_2026: WorkCalendarContent = { calendar_code: 'WORKDAY_VN', year: 2026, working_days: [1, 2, 3, 4, 5], holidays: [{ date: '2026-11-11', name: 'Ngày nghỉ thử' }], legal_basis_ref: 'fixture' };
const CALENDARS: WorkCalendarSource = { forYear: (year) => (year === 2026 ? CALENDAR_2026 : undefined) };

/** Three steps with standard days 2, 4 and 4 (the weight of the definition is 10). Step B asks for a decision document and is maker-checker. */
const SMALL: WorkflowDefinition = {
  method: 'OPEN_BIDDING',
  name: 'Quy trình thử',
  stalledAfterWorkingDays: 5,
  checklistWarnDays: 2,
  steps: [
    { code: 'ST_A', name: 'Bước A', order: 1, entryCondition: 'vào A', exitCondition: 'ra A', responsibleRole: 'PROCUREMENT_OFFICER', standardWorkingDays: 2, evidenceKinds: [], milestoneKind: null, makerChecker: false, checklist: [] },
    {
      code: 'ST_B',
      name: 'Bước B',
      order: 2,
      entryCondition: 'vào B',
      exitCondition: 'ra B',
      responsibleRole: 'APPRAISER',
      standardWorkingDays: 4,
      evidenceKinds: ['DECISION_DOCUMENT'],
      milestoneKind: null,
      makerChecker: true,
      checklist: [
        { code: 'B1', name: 'Mục B1', required: true, ownerRole: 'APPRAISER', dueOffsetWorkingDays: 2, evidenceKinds: ['DECISION_DOCUMENT'], evidenceRequired: true, milestoneKind: null },
        { code: 'B2', name: 'Mục B2', required: true, ownerRole: 'APPRAISER', dueOffsetWorkingDays: 3, evidenceKinds: [], evidenceRequired: false, milestoneKind: null },
        { code: 'B3', name: 'Mục B3 tùy chọn', required: false, ownerRole: 'APPRAISER', dueOffsetWorkingDays: 3, evidenceKinds: [], evidenceRequired: false, milestoneKind: null },
      ],
    },
    { code: 'ST_C', name: 'Bước C', order: 3, entryCondition: 'vào C', exitCondition: 'ra C', responsibleRole: 'DECISION_AUTHORITY', standardWorkingDays: 4, evidenceKinds: [], milestoneKind: null, makerChecker: false, checklist: [] },
  ],
};

const visitB = (items: VisitState['items']): VisitState => ({ stepCode: 'ST_B', enteredOn: '2026-11-09', dueOn: '2026-11-16', items });
const done = (code: string, by: string, evidence: string[] = [], required = true) => ({ code, required, status: 'DONE' as const, completedBy: by, evidenceKinds: evidence, dueOn: null });
const open = (code: string, required = true) => ({ code, required, status: 'OPEN' as const, completedBy: null, evidenceKinds: [], dueOn: null });

const failure = (run: () => unknown): DomainError => {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
};

describe('the default definitions', () => {
  it('has a definition for each selection method that passes its own parser and the governance schema, flagged UNVERIFIED', () => {
    for (const method of WORKFLOW_METHODS) {
      const definition = defaultWorkflowDefinition(method);
      expect(definition.method).toBe(method);
      expect(definition.steps.map((step) => step.order)).toEqual(definition.steps.map((_, index) => index + 1));
      expect(parseWorkflowDefinition(workflowParamsOf(definition), method)).toEqual(definition);
      expect(() => validateRuleParams('PROCUREMENT_WORKFLOW', workflowParamsOf(definition))).not.toThrow();
      const registered = builtInDefault('PROCUREMENT_WORKFLOW', method);
      expect(registered?.legalStatus).toBe('UNVERIFIED');
      expect(registered?.unverified).toBe(true);
    }
    expect(ruleTypeOf('PROCUREMENT_WORKFLOW').legalStatus).toBe('UNVERIFIED');
  });

  it('follows the order of the law for open bidding: notice before issue, closing before opening, result approved before posted, contract after the result', () => {
    const codes = defaultWorkflowDefinition('OPEN_BIDDING').steps.map((step) => step.code);
    const before = (first: string, second: string): boolean => codes.indexOf(first) < codes.indexOf(second);
    expect(codes).toHaveLength(16);
    expect(before('DOC_APPRAISE', 'DOC_APPROVE')).toBe(true);
    expect(before('NOTICE_POST', 'DOC_ISSUE')).toBe(true);
    expect(before('BID_CLOSING', 'BID_OPENING')).toBe(true);
    expect(before('EVALUATE', 'RESULT_APPROVE')).toBe(true);
    expect(before('RESULT_APPROVE', 'RESULT_POST')).toBe(true);
    expect(before('RESULT_POST', 'CONTRACT_SIGN')).toBe(true);
  });

  it('maps the milestones of BID-17 to the steps that mark them', () => {
    const open = defaultWorkflowDefinition('OPEN_BIDDING');
    const milestoneOf = (code: string) => open.steps.find((step) => step.code === code)?.milestoneKind;
    expect(milestoneOf('NOTICE_POST')).toBe('INVITATION_PUBLISHED');
    expect(milestoneOf('BID_CLOSING')).toBe('BID_CLOSING');
    expect(milestoneOf('BID_OPENING')).toBe('BID_OPENING');
    expect(milestoneOf('EVALUATE')).toBe('EVALUATION_DONE');
    expect(milestoneOf('RESULT_APPROVE')).toBe('RESULT_APPROVED');
    expect(milestoneOf('RESULT_POST')).toBe('RESULT_PUBLISHED');
    expect(milestoneOf('CONTRACT_SIGN')).toBe('CONTRACT_SIGNED');
  });

  it('refuses a definition that repeats a step, repeats an item, names an evidence kind nobody registered, or asks for evidence it cannot name', () => {
    const base = workflowParamsOf(SMALL) as { steps: Array<Record<string, unknown>> };
    const clone = (): { steps: Array<Record<string, unknown>> } => JSON.parse(JSON.stringify(base));
    const dup = clone();
    (dup.steps[1] as Record<string, unknown>).code = 'ST_A';
    expect(failure(() => parseWorkflowDefinition({ ...dup, method: 'OPEN_BIDDING', name: 'x y z', stalled_after_working_days: 5, checklist_warn_days: 2 })).detail).toBe('steps[1].code');
    const unknownKind = clone();
    ((unknownKind.steps[1] as { checklist: Array<Record<string, unknown>> }).checklist[0] as Record<string, unknown>).evidence_kinds = ['NOT_A_KIND'];
    expect(failure(() => parseWorkflowDefinition({ ...unknownKind, method: 'OPEN_BIDDING', name: 'x y z', stalled_after_working_days: 5, checklist_warn_days: 2 })).detail).toBe('steps[1].checklist[0].evidence_kinds[0]');
    const noKind = clone();
    ((noKind.steps[1] as { checklist: Array<Record<string, unknown>> }).checklist[0] as Record<string, unknown>).evidence_kinds = [];
    expect(failure(() => parseWorkflowDefinition({ ...noKind, method: 'OPEN_BIDDING', name: 'x y z', stalled_after_working_days: 5, checklist_warn_days: 2 })).detail).toBe('steps[1].checklist[0].evidence_kinds');
    expect(failure(() => parseWorkflowDefinition({ ...base, method: 'OPEN_BIDDING', name: 'x y z', stalled_after_working_days: 5, checklist_warn_days: 2 }, 'LIMITED_BIDDING')).detail).toBe('method');
  });

  it('gives the same canonical text for the same definition however its keys were written', () => {
    const forward = canonicalWorkflowText(SMALL);
    const reversed = canonicalWorkflowText(parseWorkflowDefinition(JSON.parse(JSON.stringify(workflowParamsOf(SMALL), (_key, value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value)))));
    expect(reversed).toBe(forward);
  });
});

describe('evidence kinds', () => {
  it('registers a kind once and refuses a second registration (the hook EGP-1 part 2 uses)', () => {
    expect(evidenceKinds().map((kind) => kind.code)).toEqual(expect.arrayContaining(['DOCUMENT', 'DECISION_DOCUMENT', 'MILESTONE', 'ATTESTATION']));
    registerEvidenceKind({ code: 'TEST_EGP_RECEIPT', source: 'EXTERNAL_RECEIPT', label: 'Biên nhận đăng tải thử', module: 'EGP' });
    expect(isEvidenceKind('TEST_EGP_RECEIPT')).toBe(true);
    expect(() => registerEvidenceKind({ code: 'TEST_EGP_RECEIPT', source: 'EXTERNAL_RECEIPT', label: 'Lại lần nữa', module: 'EGP' })).toThrow('already registered');
    expect(() => registerEvidenceKind({ code: 'bad code', source: 'DOCUMENT', label: 'Sai mã', module: 'EGP' })).toThrow('not a code');
  });
});

describe('working days', () => {
  it('counts from the day of entry: Friday 6 November plus 3 working days skips the weekend and the holiday of Wednesday 11 and falls on Thursday 12', () => {
    // Mon 9 (1), Tue 10 (2), Wed 11 holiday, Thu 12 (3).
    expect(addWorkingDays(CALENDARS, '2026-11-06', 3)).toBe('2026-11-12');
    expect(addWorkingDays(CALENDARS, '2026-11-08', 1)).toBe('2026-11-09');
    expect(addWorkingDays(CALENDARS, '2026-11-06', 0)).toBe('2026-11-06');
    expect(addWorkingDays(undefined, '2026-11-06', 0)).toBe('2026-11-06');
  });

  it('never guesses: no calendar, or a year without one, gives undefined', () => {
    expect(addWorkingDays(undefined, '2026-11-06', 3)).toBeUndefined();
    expect(addWorkingDays(CALENDARS, '2026-12-31', 1)).toBeUndefined();
    expect(workingDaysBetween(CALENDARS, '2026-12-30', '2027-01-04')).toBeUndefined();
  });

  it('counts the working days after the first day up to and including the last, and the days in a step with both counts', () => {
    expect(workingDaysBetween(CALENDARS, '2026-11-06', '2026-11-12')).toBe(3);
    expect(workingDaysBetween(CALENDARS, '2026-11-12', '2026-11-06')).toBe(0);
    expect(daysInStep(CALENDARS, '2026-11-06', '2026-11-12')).toEqual({ calendarDays: 6, workingDays: 3 });
    expect(daysInStep(undefined, '2026-11-06', '2026-11-12')).toEqual({ calendarDays: 6, workingDays: null });
  });

  it('says a package is stalled once the working days since its last activity reach the threshold', () => {
    expect(isStalled(CALENDARS, '2026-11-06', '2026-11-12', 3)).toBe(true);
    expect(isStalled(CALENDARS, '2026-11-06', '2026-11-12', 4)).toBe(false);
    expect(isStalled(undefined, '2026-11-06', '2026-11-12', 4)).toBeUndefined();
  });
});

describe('leaving a step', () => {
  it('is blocked by an open required item, not by an optional one, and not once the required items are done with the evidence of the step', () => {
    const blocked = assessAdvance(SMALL, 'IN_PROGRESS', visitB([open('B1'), open('B2'), open('B3', false)]), { actor: 'u9', exceptionApproved: false });
    expect(blocked.ok).toBe(false);
    expect(blocked.blockers.filter((blocker) => blocker.code === 'REQUIRED_ITEM_OPEN').map((blocker) => blocker.subject)).toEqual(['B1', 'B2']);
    expect(blocked.blockers).toContainEqual({ code: 'STEP_EVIDENCE_MISSING', subject: 'DECISION_DOCUMENT' });
    const clear = assessAdvance(SMALL, 'IN_PROGRESS', visitB([done('B1', 'u1', ['DECISION_DOCUMENT']), done('B2', 'u1'), open('B3', false)]), { actor: 'u9', exceptionApproved: false });
    expect(clear.ok).toBe(true);
    expect(clear.next?.code).toBe('ST_C');
  });

  it('is blocked when the step shows no evidence of a kind it asks for, even with every item done', () => {
    const result = assessAdvance(SMALL, 'IN_PROGRESS', visitB([done('B1', 'u1', []), done('B2', 'u1')]), { actor: 'u9', exceptionApproved: false });
    expect(result.blockers).toEqual([{ code: 'STEP_EVIDENCE_MISSING', subject: 'DECISION_DOCUMENT' }]);
  });

  it('keeps maker and approver apart: the person who completed an item of a maker-checker step cannot leave it, and an exception does not change that', () => {
    const items = [done('B1', 'U1', ['DECISION_DOCUMENT']), done('B2', 'u2')];
    const maker = assessAdvance(SMALL, 'IN_PROGRESS', visitB(items), { actor: 'u1', exceptionApproved: false });
    expect(maker.ok).toBe(false);
    expect(maker.blockers).toEqual([{ code: 'MAKER_IS_APPROVER', subject: null }]);
    expect(assessAdvance(SMALL, 'IN_PROGRESS', visitB(items), { actor: 'u1', exceptionApproved: true }).ok).toBe(false);
    expect(assessAdvance(SMALL, 'IN_PROGRESS', visitB(items), { actor: 'u3', exceptionApproved: false }).ok).toBe(true);
  });

  it('lets an approved exception cover open required items and missing evidence only, never a workflow on hold', () => {
    const openItems = visitB([open('B1'), open('B2')]);
    const asked = assessAdvance(SMALL, 'IN_PROGRESS', openItems, { actor: 'u9', exceptionApproved: true });
    expect(asked.ok).toBe(true);
    expect(asked.coverable.length).toBe(3);
    const held = assessAdvance(SMALL, 'ON_HOLD', openItems, { actor: 'u9', exceptionApproved: true });
    expect(held.ok).toBe(false);
    expect(held.blockers).toEqual([{ code: 'WORKFLOW_NOT_ACTIVE', subject: 'ON_HOLD' }]);
  });

  it('says the last step completes the workflow (no next step)', () => {
    const last = assessAdvance(SMALL, 'IN_PROGRESS', { stepCode: 'ST_C', enteredOn: '2026-11-09', dueOn: null, items: [] }, { actor: 'u9', exceptionApproved: false });
    expect(last.ok).toBe(true);
    expect(last.next).toBeNull();
  });

  it('allows a return only to an earlier step and a reason only in words', () => {
    expect(assertReturnTarget(SMALL, 'ST_C', 'ST_A').code).toBe('ST_A');
    expect(failure(() => assertReturnTarget(SMALL, 'ST_B', 'ST_C')).detail).toBe('to_step');
    expect(failure(() => assertReturnTarget(SMALL, 'ST_B', 'ST_B')).detail).toBe('to_step');
    expect(failure(() => assertReturnTarget(SMALL, 'ST_B', 'ZZ')).detail).toBe('to_step');
    expect(assertReason('  thiếu hồ sơ  ')).toBe('thiếu hồ sơ');
    expect(failure(() => assertReason('ừ')).detail).toBe('reason');
  });
});

describe('progress', () => {
  it('weighs the steps by their standard days: step A done (2 of 10) and half of the two required items of B (half of 4) is 40 per cent', () => {
    const progress = progressOf(SMALL, 'IN_PROGRESS', visitB([done('B1', 'u1', ['DECISION_DOCUMENT']), open('B2'), open('B3', false)]));
    expect(progress).toEqual({ stepsTotal: 3, stepsDone: 1, currentOrder: 2, itemsRequired: 2, itemsRequiredDone: 1, percent: 40 });
  });

  it('is 0 before the first step, 100 when completed, and never 100 while a step is still current', () => {
    expect(progressOf(SMALL, 'IN_PROGRESS', null).percent).toBe(0);
    expect(progressOf(SMALL, 'COMPLETED', null)).toMatchObject({ percent: 100, stepsDone: 3 });
    expect(progressOf(SMALL, 'IN_PROGRESS', { stepCode: 'ST_C', enteredOn: '2026-11-09', dueOn: null, items: [] }).percent).toBe(60);
  });
});

describe('what blocks a package', () => {
  const base = { status: 'IN_PROGRESS' as const, holdReason: null, visit: visitB([open('B1'), done('B2', 'u1')]), dueOn: '2026-11-16', today: '2026-11-18', ownerId: 'u1', exceptionPending: false, calendarUnavailable: false, definition: SMALL };

  it('lists every reason that applies, in the order a person reads them', () => {
    const reasons = blockedReasons({ ...base, ownerId: null, exceptionPending: true });
    expect(reasons.map((reason) => reason.reason)).toEqual(['NO_OWNER', 'REQUIRED_ITEMS_OPEN', 'EXCEPTION_PENDING', 'STEP_OVERDUE']);
    expect(reasons.find((reason) => reason.reason === 'REQUIRED_ITEMS_OPEN')?.count).toBe(1);
    expect(reasons.find((reason) => reason.reason === 'STEP_OVERDUE')?.count).toBe(2);
  });

  it('says on hold with its reason, and nothing for an ended workflow or a package on its way', () => {
    expect(blockedReasons({ ...base, status: 'ON_HOLD', holdReason: 'chờ ý kiến', visit: visitB([done('B1', 'u1', ['DECISION_DOCUMENT']), done('B2', 'u1')]) })[0]).toEqual({ reason: 'ON_HOLD', count: null, detail: 'chờ ý kiến' });
    expect(blockedReasons({ ...base, status: 'COMPLETED' })).toEqual([]);
    expect(blockedReasons({ ...base, dueOn: '2026-11-30', visit: visitB([done('B1', 'u1', ['DECISION_DOCUMENT']), done('B2', 'u1')]) })).toEqual([]);
  });

  it('counts down to the due day, negative when late, and says nothing when the day is not known', () => {
    expect(countdownOf('2026-11-16', '2026-11-12')).toEqual({ daysLeft: 4, dueOn: '2026-11-16' });
    expect(countdownOf('2026-11-16', '2026-11-18')).toEqual({ daysLeft: -2, dueOn: '2026-11-16' });
    expect(countdownOf(null, '2026-11-18')).toBeNull();
  });
});

describe('statistics', () => {
  const visit = (over: Partial<StepVisitFact>): StepVisitFact => ({ packageId: 'p', method: 'OPEN_BIDDING', stepCode: 'A', enteredOn: '2026-11-01', exitedOn: '2026-11-05', exitKind: 'ADVANCE', standardWorkingDays: 4, workingDays: 4, calendarDays: 4, ...over });

  it('takes the median days and the share on time of the visits that ended by moving on in the period: 2, 4 and 6 days against a standard of 4', () => {
    const stats = stepStatistics(
      [
        visit({ packageId: 'p1', workingDays: 2, calendarDays: 2 }),
        visit({ packageId: 'p2', workingDays: 4, calendarDays: 4 }),
        visit({ packageId: 'p3', workingDays: 6, calendarDays: 8 }),
        visit({ packageId: 'p4', exitedOn: null, exitKind: null, workingDays: 7, calendarDays: 9 }),
        visit({ packageId: 'p5', exitKind: 'RETURN', workingDays: 1, calendarDays: 1 }),
        visit({ packageId: 'p6', exitedOn: '2026-12-31', workingDays: 1, calendarDays: 1 }),
      ],
      { from: '2026-11-01', to: '2026-11-30' },
    );
    expect(stats).toEqual([{ method: 'OPEN_BIDDING', stepCode: 'A', completedVisits: 3, medianDays: 4, basis: 'WORKING_DAYS', onTimeShare: 0.6667, openVisits: 1, overStandard: 1 }]);
  });

  it('falls back to calendar days when a visit has no working days, and says so', () => {
    const stats = stepStatistics([visit({ workingDays: null, calendarDays: 5 }), visit({ packageId: 'q', workingDays: 3, calendarDays: 3 })], { from: '2026-11-01', to: '2026-11-30' });
    expect(stats[0]).toMatchObject({ basis: 'CALENDAR_DAYS', medianDays: 4, onTimeShare: 0.5 });
  });

  it('takes the median of an even count as the mean of the two in the middle, and of nothing as null', () => {
    expect(medianOf([1, 3, 5, 9])).toBe(4);
    expect(medianOf([7])).toBe(7);
    expect(medianOf([])).toBeNull();
  });

  it('lists the stuck packages longest first, working days where known', () => {
    const stuck = stuckPackages([visit({ packageId: 'a', exitedOn: null, exitKind: null, workingDays: 3, calendarDays: 5 }), visit({ packageId: 'b', exitedOn: null, exitKind: null, workingDays: null, calendarDays: 9 }), visit({ packageId: 'c' })], 5);
    expect(stuck).toEqual([
      { packageId: 'b', stepCode: 'A', days: 9, basis: 'CALENDAR_DAYS' },
      { packageId: 'a', stepCode: 'A', days: 3, basis: 'WORKING_DAYS' },
    ]);
  });
});
