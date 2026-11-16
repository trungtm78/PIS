import { describe, expect, it } from 'vitest';
import type { ReschedulePreview } from '../model';
import { schedulePreview, scheduleTask, uuid, workflowDetail, workflowTask } from '../test/fixtures';
import { changeRows, decisionBody, decisionProblem, emptyExtension, emptyForm, emptyProgress, extendableSteps, formFor, groupChanges, hasFormErrors, heldFromAddress, heldFromPreview, isOpenProposal, proposeBody, shiftText, summarizeChanges, validateForm } from './model';
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
    expect(validateForm(emptyForm())).toEqual({ fields: { reason: 'required', change: 'pickOne' }, rows: {}, extensions: {} });
    expect(validateForm(form()).fields).toEqual({});
    expect(validateForm(form({ reason: 'ngắn' })).fields).toEqual({ reason: 'tooShort' });
    expect(validateForm(form({ plannedStart: '2027-02-30', statusDate: 'x' })).fields).toEqual({ plannedStart: 'invalidDay', statusDate: 'invalidDay' });
  });

  it('counts a progress row as a change and checks each row', () => {
    const none = form({ plannedStart: '', progress: [emptyProgress()] });
    expect(validateForm(none)).toEqual({ fields: {}, rows: { 0: { taskCode: 'required' } }, extensions: {} });
    const bad = form({ plannedStart: '', progress: [{ taskCode: 'T1', actualStart: 'x', actualFinish: '2026-13-01', remaining: '-1', percent: '101' }] });
    expect(validateForm(bad).rows[0]).toEqual({ actualStart: 'invalidDay', actualFinish: 'invalidDay', remaining: 'invalidNumber', percent: 'invalidNumber' });
    const good = form({ plannedStart: '', progress: [{ taskCode: 'T1', actualStart: '2026-10-01', actualFinish: '', remaining: '3', percent: '40' }] });
    expect(hasFormErrors(validateForm(good))).toBe(false);
    expect(hasFormErrors(validateForm(emptyForm()))).toBe(true);
    expect(hasFormErrors({ fields: {}, rows: { 1: { taskCode: 'required' } }, extensions: {} })).toBe(true);
    expect(hasFormErrors({ fields: {}, rows: {}, extensions: { 0: { addValue: 'required' } } })).toBe(true);
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
    expect(summarizeChanges(preview())).toEqual({ extended: 0, cascaded: 0, total: 3, becameCritical: 1, becameNonCritical: 1, slipped: 1, gained: 1 });
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

describe('PWF-06 model: extensions (R72)', () => {
  const rule = { allowed: true, max_times: 2, max_value: 10, unit: 'WORKING_DAY' as const, times_used: 1, value_used: 4 };
  const flow = workflowDetail({
    tasks: [
      workflowTask(1, { extension: rule }),
      workflowTask(2, { extension: { ...rule, allowed: false } }),
      workflowTask(3, { status: 'DONE', extension: rule }),
      workflowTask(4),
      workflowTask(5, { extension: { ...rule, max_times: null, max_value: null } }),
      workflowTask(6, { excluded: true, extension: rule }),
    ],
  });

  it('lists the steps that may be extended, with what is left of each cap, and none that is over, cut out, not allowed or has no rule', () => {
    expect(extendableSteps(flow).map((step) => [step.code, step.timesLeft, step.valueLeft])).toEqual([
      ['T1', 1, 6],
      ['T5', null, null],
    ]);
  });

  it('opens a request with the step named in the address ready, and ignores a name that cannot be extended', () => {
    const steps = extendableSteps(flow);
    expect(formFor('T1', steps).extensions).toEqual([{ taskCode: 'T1', addValue: '' }]);
    expect(formFor('T2', steps).extensions).toEqual([]);
    expect(formFor(null, steps).extensions).toEqual([]);
  });

  it('asks every extension for a step and a whole amount of 1 to 1095, and counts an extension as a change', () => {
    const base = { ...emptyForm(), reason: REASON };
    expect(validateForm({ ...base, extensions: [emptyExtension()] }).extensions).toEqual({ 0: { taskCode: 'pickOne', addValue: 'required' } });
    expect(validateForm({ ...base, extensions: [{ taskCode: 'T1', addValue: '0' }] }).extensions[0]).toEqual({ addValue: 'invalidNumber' });
    expect(validateForm({ ...base, extensions: [{ taskCode: 'T1', addValue: '1096' }] }).extensions[0]).toEqual({ addValue: 'invalidNumber' });
    const good = validateForm({ ...base, extensions: [{ taskCode: 'T1', addValue: '3' }] });
    expect(good.extensions).toEqual({});
    expect(good.fields.change).toBeUndefined();
  });

  it('sends the extensions as the step and the amount added, and nothing when there are none', () => {
    expect(proposeBody({ ...emptyForm(), reason: REASON, extensions: [{ taskCode: ' T1 ', addValue: ' 3 ' }, { taskCode: 'T5', addValue: '2' }] })).toEqual({
      reason: REASON,
      extensions: [
        { task_code: 'T1', add_value: 3 },
        { task_code: 'T5', add_value: 2 },
      ],
    });
    expect('extensions' in proposeBody({ ...emptyForm(), plannedStart: '2027-01-04', reason: REASON })).toBe(false);
  });
});

describe('PWF-06 model: why a step moves', () => {
  const pv = preview({
    changes: [
      { task_code: 'T1', start_shift_days: 0, finish_shift_days: 5, float_change: 0, became_critical: false, became_non_critical: false, state_changed: false, cause: 'EXTENDED' },
      { task_code: 'T2', start_shift_days: 5, finish_shift_days: 5, float_change: 0, became_critical: false, became_non_critical: false, state_changed: false, cause: 'CASCADED' },
      { task_code: 'T3', start_shift_days: 0, finish_shift_days: 0, float_change: 0, became_critical: false, became_non_critical: false, state_changed: false, finish_calendar_shift_days: 1 },
    ],
  });

  it('keeps the cause of each change and the calendar days of a move the working days do not show', () => {
    const rows = changeRows(pv, undefined);
    expect(rows.map((row) => [row.code, row.cause, row.finishCalendarShift])).toEqual([
      ['T1', 'EXTENDED', null],
      ['T2', 'CASCADED', null],
      ['T3', null, 1],
    ]);
  });

  it('groups the changes: extended, moved behind another, and the rest, each only when it has rows', () => {
    expect(groupChanges(changeRows(pv, undefined)).map((entry) => [entry.group, entry.rows.map((row) => row.code)])).toEqual([
      ['EXTENDED', ['T1']],
      ['CASCADED', ['T2']],
      ['OTHER', ['T3']],
    ]);
    expect(groupChanges([])).toEqual([]);
  });

  it('counts the causes, and a move of calendar days alone as a step that slipped', () => {
    expect(summarizeChanges(pv)).toMatchObject({ extended: 1, cascaded: 1, slipped: 3, total: 3 });
  });
});
