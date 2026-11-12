import { describe, expect, it } from 'vitest';
import type { ReschedulePreview } from '../model';
import { schedulePreview, scheduleTask, uuid } from '../test/fixtures';
import { changeRows, decisionBody, decisionProblem, emptyForm, emptyProgress, hasFormErrors, heldFromAddress, heldFromPreview, isOpenProposal, proposeBody, shiftText, summarizeChanges, validateForm } from './model';
import type { RescheduleForm } from './model';

const REASON = 'Dời ngày bắt đầu vì chờ quyết định giao kế hoạch vốn';
const form = (over: Partial<RescheduleForm> = {}): RescheduleForm => ({ ...emptyForm(), plannedStart: '2027-01-04', reason: REASON, ...over });

const preview = (over: Partial<ReschedulePreview> = {}): ReschedulePreview => ({
  proposal_id: uuid(7001),
  status: 'PROPOSED',
  base_version: 3,
  schedule: schedulePreview({ tasks: [scheduleTask('T1', { start: '2027-01-04', finish: '2027-01-15', finish_variance_days: 5, start_variance_days: 3 }), scheduleTask('T2', { state: 'CALENDAR_UNAVAILABLE', missing_year: 2028, start: null, finish: null })] }),
  changes: [
    { task_code: 'T1', start_shift_days: 5, finish_shift_days: 5, float_change: -2, became_critical: true, became_non_critical: false, state_changed: false },
    { task_code: 'T2', start_shift_days: null, finish_shift_days: -1, float_change: 1, became_critical: false, became_non_critical: true, state_changed: true },
    { task_code: 'T9', start_shift_days: 0, finish_shift_days: 0, float_change: null, became_critical: false, became_non_critical: false, state_changed: false },
  ],
  project_finish_shift_days: 5,
  input_hash: 'a'.repeat(64),
  result_hash: 'b'.repeat(64),
  reason: REASON,
  proposed_by: uuid(70),
  version: 1,
  as_of: '2026-11-12T03:00:00.000Z',
  ...over,
});

describe('PWF-06 model: the proposal form', () => {
  it('asks for a change, a reason of at least 20 characters, and real days and numbers', () => {
    expect(validateForm(emptyForm())).toEqual({ fields: { reason: 'required', change: 'pickOne' }, rows: {} });
    expect(validateForm(form()).fields).toEqual({});
    expect(validateForm(form({ reason: 'ngắn' })).fields).toEqual({ reason: 'tooShort' });
    expect(validateForm(form({ plannedStart: '2027-02-30', statusDate: 'x' })).fields).toEqual({ plannedStart: 'invalidDay', statusDate: 'invalidDay' });
  });

  it('counts a progress row as a change and checks each row', () => {
    const none = form({ plannedStart: '', progress: [emptyProgress()] });
    expect(validateForm(none)).toEqual({ fields: {}, rows: { 0: { taskCode: 'required' } } });
    const bad = form({ plannedStart: '', progress: [{ taskCode: 'T1', actualStart: 'x', actualFinish: '2026-13-01', remaining: '-1', percent: '101' }] });
    expect(validateForm(bad).rows[0]).toEqual({ actualStart: 'invalidDay', actualFinish: 'invalidDay', remaining: 'invalidNumber', percent: 'invalidNumber' });
    const good = form({ plannedStart: '', progress: [{ taskCode: 'T1', actualStart: '2026-10-01', actualFinish: '', remaining: '3', percent: '40' }] });
    expect(hasFormErrors(validateForm(good))).toBe(false);
    expect(hasFormErrors(validateForm(emptyForm()))).toBe(true);
    expect(hasFormErrors({ fields: {}, rows: { 1: { taskCode: 'required' } } })).toBe(true);
  });

  it('sends only what was given', () => {
    expect(proposeBody(form())).toEqual({ planned_start_date: '2027-01-04', reason: REASON });
    expect(proposeBody(form({ plannedStart: '', statusDate: '2026-11-12', progress: [{ taskCode: ' T1 ', actualStart: '2026-10-01', actualFinish: '2026-10-09', remaining: '0', percent: '100' }, { ...emptyProgress(), taskCode: 'T2' }] }))).toEqual({
      status_date: '2026-11-12',
      progress: [{ task_code: 'T1', actual_start: '2026-10-01', actual_finish: '2026-10-09', remaining_working_days: 0, percent_complete: 100 }, { task_code: 'T2' }],
      reason: REASON,
    });
  });
});

describe('PWF-06 model: the decision', () => {
  it('asks a rejection for its reason and lets an approval carry a note', () => {
    expect(decisionProblem('REJECT', '')).toBe('required');
    expect(decisionProblem('REJECT', 'ngắn')).toBe('tooShort');
    expect(decisionProblem('REJECT', REASON)).toBeUndefined();
    expect(decisionProblem('APPROVE', '')).toBeUndefined();
    expect(decisionProblem('APPROVE', 'x'.repeat(2001))).toBe('tooLong');
    expect(decisionBody('APPROVE', '  ')).toEqual({ decision: 'APPROVE' });
    expect(decisionBody('REJECT', ` ${REASON} `)).toEqual({ decision: 'REJECT', note: REASON });
  });
});

describe('PWF-06 model: reading a proposal', () => {
  const before = { tasks: [scheduleTask('T1', { start: '2026-12-01', finish: '2026-12-10', name: 'Việc T1' })] };

  it('puts the days before and after side by side with the shift and the variance against the first baseline', () => {
    const rows = changeRows(preview(), before);
    expect(rows[0]).toMatchObject({ code: 'T1', beforeStart: '2026-12-01', beforeFinish: '2026-12-10', afterStart: '2027-01-04', afterFinish: '2027-01-15', startShift: 5, finishShift: 5, floatChange: -2, becameCritical: true, baselineFinishVariance: 5, baselineStartVariance: 3, calendarMissingYear: null });
    expect(rows[1]).toMatchObject({ code: 'T2', beforeStart: null, afterStart: null, startShift: null, becameNonCritical: true, stateChanged: true, calendarMissingYear: 2028, baselineFinishVariance: null });
    expect(rows[2]).toMatchObject({ code: 'T9', name: 'T9', afterStart: null });
    expect(changeRows(preview(), undefined)[0]?.beforeStart).toBeNull();
  });

  it('counts the tasks that move later or earlier and those that join or leave the critical path', () => {
    expect(summarizeChanges(preview())).toEqual({ total: 3, becameCritical: 1, becameNonCritical: 1, slipped: 1, gained: 1 });
  });

  it('writes a shift with its sign', () => {
    expect([shiftText(3), shiftText(-2), shiftText(0), shiftText(null)]).toEqual(['+3', '−2', '0', '–']);
  });

  it('reads the proposal an address names, with the version it was computed on', () => {
    expect(heldFromAddress(new URLSearchParams(`proposal=${uuid(7001)}&v=4`))).toEqual({ id: uuid(7001), baseVersion: 4 });
    expect(heldFromAddress(new URLSearchParams(`proposal=${uuid(7001)}`))?.baseVersion).toBe(1);
    expect(heldFromAddress(new URLSearchParams(`proposal=${uuid(7001)}&v=x`))?.baseVersion).toBe(1);
    expect(heldFromAddress(new URLSearchParams('proposal=zzz'))).toBeUndefined();
    expect(heldFromAddress(new URLSearchParams(''))).toBeUndefined();
  });

  it('keeps the proposal a person just made, and knows when it can still be decided', () => {
    const made = heldFromPreview(preview());
    expect(made).toMatchObject({ id: uuid(7001), baseVersion: 3 });
    expect(isOpenProposal(made)).toBe(true);
    expect(isOpenProposal({ id: 'x', baseVersion: 1 })).toBe(true);
    expect(isOpenProposal(heldFromPreview(preview({ status: 'APPROVED' })))).toBe(false);
  });
});
