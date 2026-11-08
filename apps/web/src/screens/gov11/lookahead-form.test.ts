import { describe, expect, it } from 'vitest';
import { addDays, blankRow, constraintBody, constraintProblems, defaultWeekStart, dayMs, dueAfterStart, isMonday, limitsOf, noProblems, planBody, planProblems, rowsFromText, vietnamDay, windowEndOf } from './lookahead-form';
import type { PlanForm } from './lookahead-form';

const LIMITS = limitsOf({ min_weeks: 2, max_weeks: 6, default_weeks: 3, constraint_kinds: ['DESIGN', 'MATERIAL', 'OTHER'] });
const form = (over: Partial<PlanForm> = {}): PlanForm => ({ weekStart: '2026-11-09', horizonWeeks: '3', items: [{ key: 1, description: 'Pour the slab', plannedStart: '2026-11-10', plannedFinish: '2026-11-12', responsible: 'Crew A' }], ...over });

describe('limitsOf: the window and the kinds come from the rule', () => {
  it('reads the rule and always offers OTHER', () => {
    expect(LIMITS).toEqual({ minWeeks: 2, maxWeeks: 6, defaultWeeks: 3, constraintKinds: ['DESIGN', 'MATERIAL', 'OTHER'] });
    expect(limitsOf({ constraint_kinds: ['DESIGN'] }).constraintKinds).toEqual(['DESIGN', 'OTHER']);
  });
  it('falls back to the narrow built-in values, never to a wider window', () => {
    expect(limitsOf(undefined)).toEqual({ minWeeks: 2, maxWeeks: 6, defaultWeeks: 3, constraintKinds: ['OTHER'] });
    expect(limitsOf({ min_weeks: 4, max_weeks: 2, default_weeks: 9 })).toMatchObject({ minWeeks: 4, maxWeeks: 4, defaultWeeks: 4 });
    expect(limitsOf({ min_weeks: 'x', constraint_kinds: ['bad kind', 7] }).constraintKinds).toEqual(['OTHER']);
  });
});

describe('days', () => {
  it('knows a real day from one that only looks like it', () => {
    expect(dayMs('2026-02-30')).toBeUndefined();
    expect(dayMs('2026-11-09')).toBeDefined();
    expect(dayMs('09/11/2026')).toBeUndefined();
  });
  it('finds Mondays, the window end and the Vietnam day of an instant', () => {
    expect(isMonday('2026-11-09')).toBe(true);
    expect(isMonday('2026-11-10')).toBe(false);
    expect(windowEndOf('2026-11-09', 3)).toBe('2026-11-30');
    expect(addDays('2026-12-28', 7)).toBe('2027-01-04');
    expect(vietnamDay('2026-11-08T18:00:00.000Z')).toBe('2026-11-09');
    expect(vietnamDay('nope')).toBeUndefined();
  });
  it('starts a plan on the Monday of the week of the day, or the next free Monday', () => {
    expect(defaultWeekStart('2026-11-08', [])).toBe('2026-11-02');
    expect(defaultWeekStart('2026-11-11', [])).toBe('2026-11-09');
    expect(defaultWeekStart('2026-11-09', [])).toBe('2026-11-09');
    expect(defaultWeekStart('2026-11-11', ['2026-11-09', '2026-11-16'])).toBe('2026-11-23');
    expect(defaultWeekStart('', [])).toBe('');
  });
});

describe('planProblems: the rules of the server, said before sending', () => {
  it('accepts a sound form', () => {
    expect(noProblems(planProblems(form(), LIMITS))).toBe(true);
  });
  it('wants a real Monday and a number of weeks within the rule', () => {
    expect(planProblems(form({ weekStart: '2026-11-10' }), LIMITS).plan.weekStart).toBe('weekStartNotMonday');
    expect(planProblems(form({ weekStart: '' }), LIMITS).plan.weekStart).toBe('weekStartInvalid');
    expect(planProblems(form({ horizonWeeks: '1' }), LIMITS).plan.horizon).toBe('horizonOutside');
    expect(planProblems(form({ horizonWeeks: '7' }), LIMITS).plan.horizon).toBe('horizonOutside');
    expect(planProblems(form({ horizonWeeks: '' }), LIMITS).plan.horizon).toBe('horizonOutside');
    expect(planProblems(form({ horizonWeeks: '2.5' }), LIMITS).plan.horizon).toBe('horizonOutside');
  });
  it('wants one to 500 items', () => {
    expect(planProblems(form({ items: [] }), LIMITS).plan.items).toBe('itemsNone');
    const many = Array.from({ length: 501 }, (_, index) => ({ key: index, description: 'Item', plannedStart: '2026-11-10', plannedFinish: '2026-11-10', responsible: '' }));
    expect(planProblems(form({ items: many }), LIMITS).plan.items).toBe('itemsTooMany');
  });
  it('checks each item: words, a start not after its finish, a start inside the window', () => {
    const row = (over: Record<string, string>) => ({ key: 7, description: 'Pour the slab', plannedStart: '2026-11-10', plannedFinish: '2026-11-12', responsible: '', ...over });
    const found = (over: Record<string, string>) => planProblems(form({ items: [row(over)] }), LIMITS).items.get(7);
    expect(found({ description: ' a ' })).toEqual({ description: 'descriptionShort' });
    expect(found({ description: 'x'.repeat(501) })).toEqual({ description: 'descriptionLong' });
    expect(found({ plannedStart: '' })).toEqual({ plannedStart: 'startInvalid' });
    expect(found({ plannedFinish: '2026-13-01' })).toEqual({ plannedFinish: 'finishInvalid' });
    expect(found({ plannedFinish: '2026-11-09' })).toEqual({ plannedFinish: 'finishBeforeStart' });
    expect(found({ plannedStart: '2026-11-08', plannedFinish: '2026-11-12' })).toEqual({ plannedStart: 'startOutsideWindow' });
    expect(found({ plannedStart: '2026-11-30', plannedFinish: '2026-12-01' })).toEqual({ plannedStart: 'startOutsideWindow' });
    expect(found({ plannedStart: '2026-11-29', plannedFinish: '2026-12-02' })).toBeUndefined();
    expect(found({ responsible: 'y'.repeat(201) })).toEqual({ responsible: 'responsibleLong' });
  });
});

describe('planBody', () => {
  it('trims the words and leaves out a blank responsible', () => {
    const body = planBody(form({ items: [{ key: 1, description: '  Pour the slab ', plannedStart: '2026-11-10', plannedFinish: '2026-11-12', responsible: '   ' }, { key: 2, description: 'Cure', plannedStart: '2026-11-13', plannedFinish: '2026-11-13', responsible: ' Crew B ' }] }));
    expect(body).toEqual({
      week_start: '2026-11-09',
      horizon_weeks: 3,
      items: [
        { description: 'Pour the slab', planned_start: '2026-11-10', planned_finish: '2026-11-12' },
        { description: 'Cure', planned_start: '2026-11-13', planned_finish: '2026-11-13', responsible: 'Crew B' },
      ],
    });
  });
});

describe('rowsFromText', () => {
  it('turns pasted lines into rows, skipping blank lines, and ends on the start day when no end is given', () => {
    const rows = rowsFromText('Pour the slab\t2026-11-10\t2026-11-12\tCrew A\n\nCure;2026-11-13\r\nFormwork | 2026-11-11 | 2026-11-12 | Crew C', 10);
    expect(rows.map((row) => row.key)).toEqual([10, 11, 12]);
    expect(rows[0]).toMatchObject({ description: 'Pour the slab', plannedStart: '2026-11-10', plannedFinish: '2026-11-12', responsible: 'Crew A' });
    expect(rows[1]).toMatchObject({ description: 'Cure', plannedStart: '2026-11-13', plannedFinish: '2026-11-13', responsible: '' });
    expect(rows[2]?.responsible).toBe('Crew C');
    expect(blankRow(3, '2026-11-09')).toMatchObject({ key: 3, plannedStart: '2026-11-09', plannedFinish: '2026-11-09' });
  });
});

describe('constraints', () => {
  const base = { kind: 'MATERIAL', description: 'Rebar not delivered', ownerMembershipId: '', dueOn: '' };
  it('wants a kind of the rule, words of 3 to 500 characters and a real due day', () => {
    expect(constraintProblems(base, LIMITS)).toEqual({});
    expect(constraintProblems({ ...base, kind: 'WEATHER' }, LIMITS)).toEqual({ kind: 'kindInvalid' });
    expect(constraintProblems({ ...base, description: 'ab' }, LIMITS)).toEqual({ description: 'descriptionShort' });
    expect(constraintProblems({ ...base, description: 'z'.repeat(501) }, LIMITS)).toEqual({ description: 'descriptionLong' });
    expect(constraintProblems({ ...base, dueOn: '2026-02-30' }, LIMITS)).toEqual({ dueOn: 'dueInvalid' });
  });
  it('says, without refusing, a due day after the item starts', () => {
    expect(dueAfterStart('2026-11-12', '2026-11-10')).toBe(true);
    expect(dueAfterStart('2026-11-10', '2026-11-10')).toBe(false);
    expect(dueAfterStart('bad', '2026-11-10')).toBe(false);
  });
  it('leaves out the owner and the day when none is given', () => {
    expect(constraintBody({ ...base, description: '  Rebar not delivered ' })).toEqual({ kind: 'MATERIAL', description: 'Rebar not delivered' });
    expect(constraintBody({ ...base, ownerMembershipId: 'm1', dueOn: '2026-11-09' })).toEqual({ kind: 'MATERIAL', description: 'Rebar not delivered', owner_membership_id: 'm1', due_on: '2026-11-09' });
  });
});
