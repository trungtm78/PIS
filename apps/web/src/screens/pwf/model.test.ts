import { describe, expect, it } from 'vitest';
import { refusal } from './test/fixtures';
import {
  BANDS,
  assignmentsLink,
  bandCounts,
  bandIcon,
  bandTone,
  calendarMissing,
  dayProblem,
  dayText,
  daysBetween,
  describeProblem,
  editorLink,
  factsOf,
  hasBand,
  holds,
  isConflict,
  isDay,
  missingYears,
  monthOf,
  optionalText,
  reasonProblem,
  rescheduleLink,
  stampText,
  startLink,
  taskLink,
  textProblem,
  todayInVietnam,
  wholeProblem,
  workflowLink,
} from './model';

describe('PWF model: the three colours', () => {
  it('gives every band a tone and a glyph, so the colour is never the only cue', () => {
    expect(BANDS.map(bandTone)).toEqual(['danger', 'warning', 'success', 'neutral', 'neutral']);
    expect(BANDS.map(bandIcon)).toEqual(['⛔', '⚠', '✓', '○', '?']);
  });

  it('gives no colour to a task that is done, cancelled, left out or not tracked (BR-PWF-20)', () => {
    expect(hasBand({ status: 'IN_PROGRESS', excluded: false, tracked: true })).toBe(true);
    expect(hasBand({ status: 'DONE', excluded: false, tracked: true })).toBe(false);
    expect(hasBand({ status: 'CANCELLED', excluded: false, tracked: true })).toBe(false);
    expect(hasBand({ status: 'NOT_STARTED', excluded: true, tracked: true })).toBe(false);
    expect(hasBand({ status: 'NOT_STARTED', excluded: false, tracked: false })).toBe(false);
  });

  it('names the years that have no calendar, each once and in order', () => {
    expect(calendarMissing({ state: 'CALENDAR_UNAVAILABLE', missing_year: null })).toBe(true);
    expect(calendarMissing({ state: 'SCHEDULED', missing_year: 2028 })).toBe(true);
    expect(calendarMissing({ state: 'SCHEDULED', missing_year: null })).toBe(false);
    expect(missingYears([{ missing_year: 2029 }, { missing_year: null }, { missing_year: 2028 }, { missing_year: 2029 }])).toEqual([2028, 2029]);
  });

  it('puts the counts of the bands in the order red, yellow, green', () => {
    expect(bandCounts({ RED: 3, YELLOW: 2, GREEN: 1, NONE: 4, UNKNOWN: 5 })).toEqual({ red: 3, yellow: 2, green: 1, none: 4, unknown: 5 });
  });
});

describe('PWF model: days', () => {
  it('reads a day in Vietnam time (UTC+7)', () => {
    expect(todayInVietnam(new Date('2026-11-12T20:00:00Z'))).toBe('2026-11-13');
    expect(todayInVietnam(new Date('2026-11-12T10:00:00Z'))).toBe('2026-11-12');
  });

  it('accepts only a real calendar day', () => {
    expect(isDay('2026-02-28')).toBe(true);
    expect(isDay('2026-02-30')).toBe(false);
    expect(isDay('2026-2-3')).toBe(false);
    expect(isDay('x')).toBe(false);
  });

  it('writes a day as dd/mm/yyyy and a missing one as a dash, never a guessed date', () => {
    expect(dayText('2026-12-01')).toBe('01/12/2026');
    expect(dayText(null)).toBe('–');
    expect(dayText(undefined)).toBe('–');
    expect(dayText('bad')).toBe('–');
  });

  it('writes an instant in Vietnam time', () => {
    expect(stampText('2026-12-01T18:30:00.000Z')).toBe('02/12/2026 01:30');
    expect(stampText(null)).toBe('–');
    expect(stampText('bad')).toBe('–');
  });

  it('counts whole days between two days', () => {
    expect(daysBetween('2026-12-01', '2026-12-08')).toBe(7);
    expect(daysBetween('2026-12-08', '2026-12-01')).toBe(-7);
    expect(daysBetween(null, '2026-12-01')).toBeNull();
    expect(daysBetween('2026-12-01', 'bad')).toBeNull();
    expect(daysBetween('2026-12-01', undefined)).toBeNull();
    expect(daysBetween(undefined, '2026-12-01')).toBeNull();
    expect(daysBetween('2026-12-01', null)).toBeNull();
  });

  it('takes the month of a day', () => {
    expect(monthOf('2026-12-31')).toBe('2026-12');
  });
});

describe('PWF model: links and permissions', () => {
  it('links to the workflow tab of the project, a task, the start form, the reschedule and the ledger', () => {
    expect(workflowLink('p 1')).toBe('/prj/prj-03?id=p%201&tab=workflow');
    expect(taskLink('t1')).toBe('/pwf/pwf-04?id=t1');
    expect(taskLink('t1', 'p1')).toBe('/pwf/pwf-04?id=t1&project=p1');
    expect(startLink('p1')).toBe('/pwf/pwf-05?id=p1');
    expect(rescheduleLink('p1')).toBe('/pwf/pwf-06?id=p1');
    expect(rescheduleLink('p1', 'r1')).toBe('/pwf/pwf-06?id=p1&proposal=r1');
    expect(assignmentsLink('t1')).toBe('/pwf/pwf-16?id=t1');
    expect(editorLink()).toBe('/pwf/pwf-02');
    expect(editorLink('PUBLIC_REPAIR', 'abc')).toBe('/pwf/pwf-02?code=PUBLIC_REPAIR&from=abc');
  });

  it('holds a permission when the session names it or does not say what is held; a frozen session writes nothing', () => {
    expect(holds(['pwf.read'], 'pwf.read')).toBe(true);
    expect(holds(['pwf.read'], 'pwf.task.work')).toBe(false);
    expect(holds(undefined, 'pwf.task.work')).toBe(true);
    expect(holds(undefined, 'pwf.task.work', true)).toBe(false);
  });
});

describe('PWF model: refusals', () => {
  it('names the kind of a refusal by its code and carries what the server listed with it', () => {
    const blocked = describeProblem(refusal('PWF_TASK_COMPLETION_BLOCKED', 422, { blockers: [{ code: 'FORM_MISSING', subject: 'F1' }] }));
    expect(blocked.kind).toBe('completionBlocked');
    expect(blocked.blockers).toEqual([{ code: 'FORM_MISSING', subject: 'F1' }]);
    const gate = describeProblem(refusal('PWF_GATE_CLOSED', 422, { missing: [{ task: 'T1', task_id: null, phase: 'P', reason: 'NOT_DONE' }] }));
    expect(gate.kind).toBe('gateClosed');
    expect(gate.missing).toHaveLength(1);
    expect(describeProblem(refusal('MAKER_IS_APPROVER')).kind).toBe('selfApproval');
    expect(describeProblem(refusal('SELF_APPROVAL_DENIED')).kind).toBe('selfApproval');
    expect(describeProblem(refusal('PROJECT_WORKFLOW_TEMPLATE_INVALID', 422, {}, 'tasks[1]')).field).toBe('tasks[1]');
    expect(describeProblem(refusal('SOMETHING_NEW')).kind).toBe('general');
    expect(describeProblem(new Error('x')).kind).toBe('general');
  });

  it('treats a version conflict and a schedule conflict as "somebody changed it first"', () => {
    expect(isConflict(describeProblem(refusal('VERSION_CONFLICT', 409)))).toBe(true);
    expect(isConflict(describeProblem(refusal('PWF_SCHEDULE_VERSION_CONFLICT', 409)))).toBe(true);
    expect(isConflict(describeProblem(refusal('SCOPE_DENIED', 403)))).toBe(false);
  });

  it('ignores a list the server did not send as a list', () => {
    expect(describeProblem(refusal('PWF_GATE_CLOSED', 422, { missing: 'x', blockers: 3 }))).toMatchObject({ missing: [], blockers: [] });
  });
});

describe('PWF model: form checks', () => {
  it('asks a reason of at least 20 characters once trimmed', () => {
    expect(reasonProblem('')).toBe('required');
    expect(reasonProblem('   ngắn   ')).toBe('tooShort');
    expect(reasonProblem('x'.repeat(20))).toBeUndefined();
    expect(reasonProblem('x'.repeat(2001))).toBe('tooLong');
    expect(textProblem('ab', 1, 5)).toBeUndefined();
  });

  it('checks a day and a whole number', () => {
    expect(dayProblem('')).toBe('required');
    expect(dayProblem('2026-13-01')).toBe('invalidDay');
    expect(dayProblem('2026-12-01')).toBeUndefined();
    expect(wholeProblem('', 0, 5)).toBe('required');
    expect(wholeProblem('1.5', 0, 5)).toBe('invalidNumber');
    expect(wholeProblem('6', 0, 5)).toBe('invalidNumber');
    expect(wholeProblem('-1', -1, 5)).toBeUndefined();
  });

  it('sends only the facts that were given (an unknown fact is never taken as true)', () => {
    expect(optionalText('  ')).toBeUndefined();
    expect(optionalText(' a ')).toBe('a');
    expect(factsOf({ project_group: ' A ', funding_source: '', project_type: 'X' })).toEqual({ project_group: 'A', project_type: 'X' });
    expect(factsOf({ project_group: '', funding_source: ' S ', project_type: '' })).toEqual({ funding_source: 'S' });
  });
});
