import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { BLANK_FORM, bandAt, bodyOf, describeRefusal, disagreements, edgeDays, followsOfficial, formOf, isDirty, ladderOf, mergedLadder, previewRows, problemsOf, setsLevel, showsPersonal, viewOf, withLevel } from './model';
import type { PreferenceForm, PreferenceView } from './model';

const OFFICIAL = { green_days: 5, yellow_days: 2, red_days: 0 };
const PERSONAL = { green_days: 7, yellow_days: 3, red_days: 1 };
const form = (over: Partial<PreferenceForm> = {}): PreferenceForm => ({ ...BLANK_FORM, ...over });
const personalForm = form({ green: '7', yellow: '3', red: '1' });
const refused = (code: string, detail?: string) => new ApiError({ status: 422, code, correlationId: 'c', extensions: {}, ...(detail === undefined ? {} : { detail }) });

describe('the colour of a number of days left (BR-PWF-20)', () => {
  const official: [number, string][] = [
    [6, 'NONE'],
    [5, 'GREEN'],
    [3, 'GREEN'],
    [2, 'YELLOW'],
    [1, 'YELLOW'],
    [0, 'RED'],
    [-1, 'RED'],
    [-9, 'RED'],
  ];
  it.each(official)('the official ladder 5/2/0 gives %i days left the colour %s', (days, band) => {
    expect(bandAt(days, OFFICIAL)).toBe(band);
  });

  const personal: [number, string][] = [
    [8, 'NONE'],
    [7, 'GREEN'],
    [4, 'GREEN'],
    [3, 'YELLOW'],
    [2, 'YELLOW'],
    [1, 'RED'],
    [0, 'RED'],
    [-1, 'RED'],
  ];
  it.each(personal)('the personal ladder 7/3/1 gives %i days left the colour %s', (days, band) => {
    expect(bandAt(days, PERSONAL)).toBe(band);
  });

  it('turns every number above the yellow line green when there is no green line, and red only once overdue for a red line of -1', () => {
    expect(bandAt(400, { green_days: null, yellow_days: 2, red_days: 0 })).toBe('GREEN');
    expect(bandAt(0, { green_days: 5, yellow_days: 2, red_days: -1 })).toBe('YELLOW');
    expect(bandAt(-1, { green_days: 5, yellow_days: 2, red_days: -1 })).toBe('RED');
  });

  it('warns earlier with the personal ladder at every number of days left, never later (the colour is never milder than the official one)', () => {
    const severity = { NONE: 0, GREEN: 1, YELLOW: 2, RED: 3, UNKNOWN: 0 } as const;
    for (let days = -5; days <= 12; days += 1) expect(severity[bandAt(days, PERSONAL)]).toBeGreaterThanOrEqual(severity[bandAt(days, OFFICIAL)]);
  });
});

describe('the days the preview shows', () => {
  it('shows one number either side of each line and the first day overdue, from most days left to most overdue', () => {
    expect(edgeDays(OFFICIAL).sort((a, b) => b - a)).toEqual([6, 5, 3, 2, 1, 0, -1]);
    expect(previewRows(OFFICIAL, OFFICIAL).map((row) => row.days)).toEqual([6, 5, 3, 2, 1, 0, -1]);
  });

  it('puts the two ladders side by side on the union of their edges, once each', () => {
    const rows = previewRows(OFFICIAL, PERSONAL);
    expect(rows.map((row) => row.days)).toEqual([8, 7, 6, 5, 4, 3, 2, 1, 0, -1]);
    expect(rows.find((row) => row.days === 6)).toEqual({ days: 6, official: 'NONE', personal: 'GREEN' });
    expect(rows.find((row) => row.days === 3)).toEqual({ days: 3, official: 'GREEN', personal: 'YELLOW' });
    expect(rows.find((row) => row.days === 1)).toEqual({ days: 1, official: 'YELLOW', personal: 'RED' });
  });

  it('has no green edge for a ladder with no green line', () => {
    expect(edgeDays({ green_days: null, yellow_days: 2, red_days: 0 }).sort((a, b) => b - a)).toEqual([3, 2, 1, 0, -1]);
  });

  it('finds the numbers at which the colour of the server is not the colour computed here', () => {
    const examples = [
      { remaining_days: 8, band: 'NONE' as const },
      { remaining_days: 7, band: 'GREEN' as const },
      { remaining_days: 1, band: 'YELLOW' as const },
    ];
    expect(disagreements(PERSONAL, examples)).toEqual([1]);
    expect(disagreements(PERSONAL, examples.slice(0, 2))).toEqual([]);
  });
});

describe('reading the answer of the server', () => {
  it('reads what the person set, the official ladder, the levels the server raised and the version', () => {
    const view = viewOf({ green_days: 7, yellow_days: null, red_days: 1, reminder_days: [7, 3], official: OFFICIAL, clamped: ['red_days', 'bogus' as never], version: 4, as_of: '2026-11-12T03:00:00.000Z' });
    expect(view).toMatchObject({ green_days: 7, yellow_days: null, red_days: 1, reminder_days: [7, 3], official: OFFICIAL, version: 4 });
    expect(view.clamped).toEqual(['red_days']);
  });

  it('reads an empty answer as "nothing set, the official default 5/2/0, version 0"', () => {
    expect(viewOf({})).toEqual({ green_days: null, yellow_days: null, red_days: null, reminder_days: [], official: OFFICIAL, clamped: [], version: 0, as_of: null });
  });

  it('tells a person who follows the official ladder in everything', () => {
    const none = viewOf({});
    expect(followsOfficial(none)).toBe(true);
    expect(followsOfficial({ ...none, reminder_days: [3] })).toBe(false);
    expect(followsOfficial({ ...none, red_days: 1 })).toBe(false);
  });
});

describe('the form as text', () => {
  const view: PreferenceView = { ...viewOf({}), green_days: 7, yellow_days: 3, red_days: 1, reminder_days: [7, 3, 1], version: 2 };

  it('writes what is set into the form and the form back into the body, empty levels as null and an empty list as []', () => {
    expect(formOf(view)).toEqual({ green: '7', yellow: '3', red: '1', reminders: '7, 3, 1' });
    expect(bodyOf(formOf(view))).toEqual({ green_days: 7, yellow_days: 3, red_days: 1, reminder_days: [7, 3, 1] });
    expect(bodyOf(BLANK_FORM)).toEqual({ green_days: null, yellow_days: null, red_days: null, reminder_days: [] });
    expect(bodyOf(form({ yellow: ' 4 ', reminders: '5;3  1' }))).toEqual({ green_days: null, yellow_days: 4, red_days: null, reminder_days: [5, 3, 1] });
  });

  it('knows a form that differs from what the server holds, not counting spaces', () => {
    expect(isDirty(formOf(view), view)).toBe(false);
    expect(isDirty(form({ green: '7 ', yellow: '3', red: '1', reminders: '7,3, 1' }), view)).toBe(false);
    expect(isDirty(form({ green: '8', yellow: '3', red: '1', reminders: '7, 3, 1' }), view)).toBe(true);
    expect(isDirty(BLANK_FORM, view)).toBe(true);
  });

  it('sets one level of the form without touching the others, and knows whether any level is set', () => {
    expect(withLevel(BLANK_FORM, 'green_days', '9')).toEqual(form({ green: '9' }));
    expect(withLevel(BLANK_FORM, 'yellow_days', '4')).toEqual(form({ yellow: '4' }));
    expect(withLevel(BLANK_FORM, 'red_days', '1')).toEqual(form({ red: '1' }));
    expect(setsLevel(BLANK_FORM)).toBe(false);
    expect(setsLevel(form({ reminders: '3' }))).toBe(false);
    expect(setsLevel(form({ red: '1' }))).toBe(true);
  });

  it('lays the levels over the official ladder: what is empty is the official level', () => {
    expect(mergedLadder(BLANK_FORM, OFFICIAL)).toEqual(OFFICIAL);
    expect(mergedLadder(form({ yellow: '4' }), OFFICIAL)).toEqual({ green_days: 5, yellow_days: 4, red_days: 0 });
    expect(mergedLadder(personalForm, OFFICIAL)).toEqual(PERSONAL);
  });
});

describe('the checks (the same order and the same "not later" rule as the server)', () => {
  it('finds nothing wrong with a form that sets nothing, with the personal ladder 7/3/1 and with the official one', () => {
    expect(problemsOf(BLANK_FORM, OFFICIAL)).toEqual([]);
    expect(problemsOf(personalForm, OFFICIAL)).toEqual([]);
    expect(problemsOf(form({ green: '5', yellow: '2', red: '0' }), OFFICIAL)).toEqual([]);
    expect(problemsOf(form({ red: '-1' }), { green_days: 5, yellow_days: 2, red_days: -1 })).toEqual([]);
  });

  it('asks for whole numbers in the range of each level', () => {
    expect(problemsOf(form({ green: 'x', yellow: '2.5', red: '-2' }), OFFICIAL)).toEqual([
      { path: 'green_days', kind: 'integer' },
      { path: 'yellow_days', kind: 'integer' },
      { path: 'red_days', kind: 'range', min: -1, max: 3650 },
    ]);
    expect(problemsOf(form({ green: '0' }), OFFICIAL)).toContainEqual({ path: 'green_days', kind: 'range', min: 1, max: 3650 });
    expect(problemsOf(form({ yellow: '4000' }), OFFICIAL)).toContainEqual({ path: 'yellow_days', kind: 'range', min: 0, max: 3650 });
  });

  it('names the level that breaks the order green > yellow > red on the ladder as it will be merged', () => {
    // Yellow raised above the official green line: green must be raised too.
    expect(problemsOf(form({ yellow: '6' }), OFFICIAL)).toEqual([{ path: 'green_days', kind: 'order' }]);
    // Red raised to the yellow line.
    expect(problemsOf(form({ red: '2' }), OFFICIAL)).toEqual([{ path: 'yellow_days', kind: 'order' }]);
    // Both broken.
    expect(problemsOf(form({ green: '4', yellow: '4', red: '4' }), OFFICIAL).map((problem) => `${problem.path}:${problem.kind}`)).toEqual(expect.arrayContaining(['yellow_days:order', 'green_days:order', 'green_days:notEarlier']));
  });

  it('refuses a personal level later than the official one, naming it and the official line', () => {
    expect(problemsOf(form({ yellow: '1' }), OFFICIAL)).toEqual([{ path: 'yellow_days', kind: 'notEarlier', official: 2 }]);
    expect(problemsOf(form({ green: '4' }), OFFICIAL)).toEqual([{ path: 'green_days', kind: 'notEarlier', official: 5 }]);
    expect(problemsOf(form({ red: '-1' }), OFFICIAL)).toEqual([{ path: 'red_days', kind: 'notEarlier', official: 0 }]);
  });

  it('puts the refusal that is not later than the official level before the order when a level breaks both', () => {
    const found = problemsOf(form({ green: '7', yellow: '1', red: '1' }), OFFICIAL).filter((problem) => problem.path === 'yellow_days');
    expect(found).toEqual([
      { path: 'yellow_days', kind: 'notEarlier', official: 2 },
      { path: 'yellow_days', kind: 'order' },
    ]);
  });

  it('accepts a personal green line when the official policy sets none (the server has the last word)', () => {
    expect(problemsOf(form({ green: '9' }), { green_days: null, yellow_days: 2, red_days: 0 })).toEqual([]);
  });

  it('checks the reminder days: whole numbers, at most six, in range, strictly decreasing, none below the official red level', () => {
    expect(problemsOf(form({ reminders: '7, 3, 1' }), OFFICIAL)).toEqual([]);
    expect(problemsOf(form({ reminders: '7, x' }), OFFICIAL)).toEqual([{ path: 'reminder_days', kind: 'integer' }]);
    expect(problemsOf(form({ reminders: '9, 8, 7, 6, 5, 4, 3' }), OFFICIAL)).toEqual([{ path: 'reminder_days', kind: 'listSize', max: 6 }]);
    expect(problemsOf(form({ reminders: '400' }), OFFICIAL)).toEqual([{ path: 'reminder_days', kind: 'range', min: -30, max: 365 }]);
    expect(problemsOf(form({ reminders: '3, 3' }), OFFICIAL)).toEqual([{ path: 'reminder_days', kind: 'reminderOrder' }]);
    expect(problemsOf(form({ reminders: '3, 1' }), { ...OFFICIAL, red_days: 2, yellow_days: 4 })).toEqual([{ path: 'reminder_days', kind: 'reminderNotEarlier', official: 2 }]);
    expect(problemsOf(form({ reminders: '3, 0, -1' }), OFFICIAL)).toEqual([{ path: 'reminder_days', kind: 'reminderNotEarlier', official: 0 }]);
  });

  it('gives the ladder to say and preview only when no level has a problem (the reminders do not hold it back)', () => {
    expect(ladderOf(personalForm, OFFICIAL)).toEqual(PERSONAL);
    expect(ladderOf(BLANK_FORM, OFFICIAL)).toEqual(OFFICIAL);
    expect(ladderOf(form({ yellow: '1' }), OFFICIAL)).toBeUndefined();
    expect(ladderOf(form({ yellow: '3', reminders: 'x' }), OFFICIAL)).toEqual({ green_days: 5, yellow_days: 3, red_days: 0 });
  });
});

describe('what the server refused a save for', () => {
  it('says whose version, which order and which level', () => {
    expect(describeRefusal(refused('VERSION_CONFLICT'))).toEqual({ kind: 'conflict', field: undefined });
    expect(describeRefusal(refused('DEADLINE_BAND_THRESHOLDS_INVALID', 'yellow_days'))).toEqual({ kind: 'order', field: 'yellow_days' });
    expect(describeRefusal(refused('DEADLINE_PERSONAL_NOT_EARLIER', 'green_days'))).toEqual({ kind: 'notEarlier', field: 'green_days' });
    expect(describeRefusal(refused('DEADLINE_PERSONAL_NOT_EARLIER', 'reminder_days'))).toEqual({ kind: 'notEarlier', field: 'reminder_days' });
    expect(describeRefusal(refused('DEADLINE_PERSONAL_NOT_EARLIER', 'something'))).toEqual({ kind: 'notEarlier', field: undefined });
    expect(describeRefusal(refused('SCOPE_DENIED'))).toEqual({ kind: 'denied', field: undefined });
    expect(describeRefusal(refused('VALIDATION_FAILED'))).toEqual({ kind: 'validation', field: undefined });
    expect(describeRefusal(refused('INVALID_REQUEST'))).toEqual({ kind: 'validation', field: undefined });
    expect(describeRefusal(refused('SOMETHING_ELSE'))).toEqual({ kind: 'general', field: undefined });
    expect(describeRefusal(new Error('down'))).toEqual({ kind: 'general', field: undefined });
  });
});

describe('the colour of a task of the person', () => {
  const band = (name: 'RED' | 'YELLOW' | 'GREEN') => ({ band: name, remaining_days: 1, unit: 'WORKING' as const, overdue: false });
  it('shows the personal colour only when there is one and it differs from the official colour', () => {
    expect(showsPersonal({ official_band: band('YELLOW'), personal_band: null })).toBe(false);
    expect(showsPersonal({ official_band: band('YELLOW'), personal_band: band('YELLOW') })).toBe(false);
    expect(showsPersonal({ official_band: band('YELLOW'), personal_band: band('RED') })).toBe(true);
  });
});
