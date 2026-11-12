import { describe, expect, it } from 'vitest';
import { OWNER_EXAMPLE, SOURCE_UNIT, addOverride, blankForm, formOf, paramsOf, problemsOf, removeOverride, sentenceOf, thresholdsOf, updateOverride } from './band-model';

const good = () => formOf({ unit: 'WORKING', green_days: 5, yellow_days: 2, red_days: 0, overrides: [], reminder_days: [5, 2, 0, -1], escalate_after_overdue_days: 3 });

describe('band model: reading and writing the params of a policy', () => {
  it('knows the unit each source counts in', () => {
    expect(SOURCE_UNIT).toEqual({ HOME_WORK: 'CALENDAR', REPORT_SCHEDULE: 'CALENDAR', PROJECT_TASK: 'WORKING' });
    expect(OWNER_EXAMPLE).toEqual({ green_days: 5, yellow_days: 2, red_days: 0 });
  });

  it('reads the params into the text a form holds and writes the same params back', () => {
    const params = {
      unit: 'WORKING',
      green_days: 5,
      yellow_days: 2,
      red_days: 0,
      overrides: [{ match: { task_kind: 'MILESTONE', priority: 'HIGH', phase: 'EXECUTION' }, green_days: 10, yellow_days: 4, red_days: 1 }],
      reminder_days: [5, 2, 0, -1],
      escalate_after_overdue_days: 3,
    };
    const form = formOf(params);
    expect(form.ladder).toEqual({ green: '5', yellow: '2', red: '0' });
    expect(form.reminders).toBe('5, 2, 0, -1');
    expect(form.overrides[0]).toMatchObject({ task_kind: 'MILESTONE', priority: 'HIGH', phase: 'EXECUTION', ladder: { green: '10', yellow: '4', red: '1' } });
    expect(paramsOf(form)).toEqual(params);
  });

  it('leaves out what is empty: a green line, an escalation, a match of nothing', () => {
    const form = { ...blankForm('CALENDAR'), ladder: { green: '', yellow: '3', red: '-1' }, reminders: '', escalate: '' };
    expect(paramsOf(form)).toEqual({ unit: 'CALENDAR', yellow_days: 3, red_days: -1, overrides: [], reminder_days: [] });
    const withOverride = addOverride(form);
    expect(paramsOf({ ...withOverride, overrides: [{ ...(withOverride.overrides[0] as (typeof withOverride.overrides)[number]), ladder: { green: '', yellow: '2', red: '0' } }] }).overrides).toEqual([{ match: {}, yellow_days: 2, red_days: 0 }]);
  });

  it('reads params that are not a policy as a blank form of the unit', () => {
    expect(formOf({})).toEqual(blankForm('CALENDAR'));
    expect(formOf({ unit: 'WORKING', overrides: 'x', reminder_days: [1, 'a'], green_days: 'x' }).unit).toBe('WORKING');
    expect(formOf({ overrides: [{ match: { task_kind: 'ODD', priority: 'ODD' } }] }).overrides[0]).toMatchObject({ task_kind: '', priority: '', phase: '' });
    expect(blankForm('WORKING').unit).toBe('WORKING');
  });

  it('adds up to twenty overrides, updates one and removes one', () => {
    let form = blankForm('WORKING');
    for (let i = 0; i < 25; i += 1) form = addOverride(form);
    expect(form.overrides).toHaveLength(20);
    form = updateOverride(form, 0, { phase: 'EXECUTION' });
    expect(form.overrides[0]?.phase).toBe('EXECUTION');
    expect(form.overrides[1]?.phase).toBe('');
    expect(removeOverride(form, 0).overrides).toHaveLength(19);
  });
});

describe('band model: the checks', () => {
  it('finds nothing wrong with the owner example in working days for the task source', () => {
    expect(problemsOf(good(), 'PROJECT_TASK')).toEqual([]);
  });

  it('asks for the numbers and for whole numbers in range', () => {
    const form = { ...good(), ladder: { green: '0', yellow: '', red: '-2' } };
    const found = problemsOf(form, 'PROJECT_TASK').map((problem) => `${problem.path}:${problem.kind}`);
    expect(found).toEqual(expect.arrayContaining(['green_days:range', 'yellow_days:required', 'red_days:range']));
    expect(problemsOf({ ...good(), ladder: { green: '1.5', yellow: 'x', red: '0' } }, 'PROJECT_TASK').map((problem) => `${problem.path}:${problem.kind}`)).toEqual(expect.arrayContaining(['green_days:integer', 'yellow_days:integer']));
  });

  it('asks the days to fall from green through yellow to red', () => {
    const found = problemsOf({ ...good(), ladder: { green: '2', yellow: '2', red: '2' } }, 'PROJECT_TASK').map((problem) => `${problem.path}:${problem.kind}`);
    expect(found).toEqual(expect.arrayContaining(['green_days:order', 'yellow_days:order']));
    expect(problemsOf({ ...good(), ladder: { green: '', yellow: '2', red: '0' } }, 'PROJECT_TASK')).toEqual([]);
  });

  it('refuses a unit other than the unit of the source', () => {
    expect(problemsOf({ ...good(), unit: 'CALENDAR' }, 'PROJECT_TASK').map((problem) => problem.kind)).toEqual(['unitMismatch']);
    expect(problemsOf({ ...good(), unit: 'CALENDAR' }, 'HOME_WORK')).toEqual([]);
  });

  it('checks every override: its ladder, the phase code and the order', () => {
    let form = addOverride(good());
    form = updateOverride(form, 0, { phase: 'bad phase', ladder: { green: '1', yellow: '2', red: '0' } });
    const found = problemsOf(form, 'PROJECT_TASK').map((problem) => `${problem.path}:${problem.kind}`);
    expect(found).toEqual(expect.arrayContaining(['overrides[0].phase:phase', 'overrides[0].green_days:order']));
  });

  it('asks the reminders to fall strictly, at most six whole numbers in range, and the escalation to be a number of days', () => {
    const base = good();
    expect(problemsOf({ ...base, reminders: '5, 5, 0' }, 'PROJECT_TASK').map((problem) => problem.kind)).toEqual(['reminderOrder']);
    expect(problemsOf({ ...base, reminders: '1, 0, -1, -2, -3, -4, -5' }, 'PROJECT_TASK').map((problem) => problem.kind)).toEqual(['listSize']);
    expect(problemsOf({ ...base, reminders: '5, x' }, 'PROJECT_TASK').map((problem) => problem.kind)).toEqual(['integer']);
    expect(problemsOf({ ...base, reminders: '400' }, 'PROJECT_TASK').map((problem) => problem.kind)).toEqual(['range']);
    expect(problemsOf({ ...base, escalate: '0' }, 'PROJECT_TASK').map((problem) => `${problem.path}:${problem.kind}`)).toEqual(['escalate_after_overdue_days:range']);
    expect(problemsOf({ ...base, escalate: 'x' }, 'PROJECT_TASK').map((problem) => problem.kind)).toEqual(['integer']);
  });
});

describe('band model: the preview', () => {
  it('takes the ladder of a good form, and nothing from a wrong one', () => {
    expect(thresholdsOf(good())).toEqual({ green_days: 5, yellow_days: 2, red_days: 0 });
    expect(thresholdsOf({ ...good(), ladder: { green: '', yellow: '3', red: '1' } })).toEqual({ green_days: null, yellow_days: 3, red_days: 1 });
    expect(thresholdsOf({ ...good(), ladder: { green: '1', yellow: '2', red: '0' } })).toBeUndefined();
  });

  it('says the ladder as the owner does: days left for green and yellow, under one day for red', () => {
    expect(sentenceOf({ green_days: 5, yellow_days: 2, red_days: 0 })).toEqual({ green: { kind: 'upTo', days: 5 }, yellow: { days: 2 }, red: { kind: 'under', days: 1 } });
    expect(sentenceOf({ green_days: null, yellow_days: 3, red_days: -1 })).toEqual({ green: { kind: 'moreThan', days: 3 }, yellow: { days: 3 }, red: { kind: 'overdue' } });
  });
});
