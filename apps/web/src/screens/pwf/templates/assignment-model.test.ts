import { describe, expect, it } from 'vitest';
import { NO_APPLY_CHANGE, alreadyApplies, applyChange, applyDifference, hasApplyChange, linesFor, overlapping, readLines } from './assignment-model';

/*
 * "Áp cho" (R60). Value: protects=the mapping of projects to procedures stays a rule of its own, approved by a second person; fails_when=the editor writes the rule in force or rewrites lines nobody touched;
 * no_claim=none beyond protects.
 */

const RULE = {
  default_template_code: 'PUBLIC_INVESTMENT',
  lines: [
    { code: 'REPAIR', priority: 20, template_code: 'PUBLIC_REPAIR', when: [{ field: 'project_type', in: ['REPAIR', 'UPGRADE'] }], note: 'Sửa chữa lớn' },
    { code: 'ROAD_REPAIR', priority: 5, template_code: 'CB_ROAD_REPAIR', when: [{ field: 'project_type', in: ['ROAD_REPAIR'] }] },
    { code: 'ROAD_C', priority: 30, template_code: 'CB_ROAD_REPAIR', when: [{ field: 'project_type', in: ['ROAD_REPAIR'] }, { field: 'project_group', in: ['C'] }] },
  ],
};

describe('the lines of the mapping rule that point at a template', () => {
  it('lists them in the order the rule reads them', () => {
    expect(readLines(RULE).map((line) => line.code)).toEqual(['ROAD_REPAIR', 'REPAIR', 'ROAD_C']);
    expect(linesFor(RULE, 'CB_ROAD_REPAIR').map((line) => line.code)).toEqual(['ROAD_REPAIR', 'ROAD_C']);
    expect(linesFor(RULE, 'NOTHING')).toEqual([]);
    expect(readLines(undefined)).toEqual([]);
    expect(readLines({ lines: 'x' })).toEqual([]);
  });

  it('knows a value another procedure already takes, and a value this one takes already', () => {
    expect(overlapping(RULE, 'CB_ROAD_REPAIR', 'project_type', 'UPGRADE').map((line) => line.code)).toEqual(['REPAIR']);
    expect(overlapping(RULE, 'PUBLIC_REPAIR', 'project_type', 'UPGRADE')).toEqual([]);
    expect(alreadyApplies(RULE, 'CB_ROAD_REPAIR', NO_APPLY_CHANGE, 'project_type', 'ROAD_REPAIR')).toBe(true);
    expect(alreadyApplies(RULE, 'CB_ROAD_REPAIR', { added: [], removed: ['ROAD_REPAIR'] }, 'project_type', 'ROAD_REPAIR')).toBe(false);
    expect(alreadyApplies(RULE, 'CB_ROAD_REPAIR', { added: [{ field: 'funding_source', value: 'ODA', first: false }], removed: [] }, 'funding_source', 'ODA')).toBe(true);
    expect(hasApplyChange(NO_APPLY_CHANGE)).toBe(false);
  });
});

describe('the draft of the mapping rule', () => {
  it('adds a line with a code and a priority of its own and leaves every other line exactly as stored', () => {
    const next = applyChange(RULE, 'CB_ROAD_REPAIR', { added: [{ field: 'funding_source', value: 'ODA', first: false }], removed: [] }) as typeof RULE;
    expect(next.default_template_code).toBe('PUBLIC_INVESTMENT');
    expect(next.lines.slice(0, 3)).toEqual(RULE.lines);
    expect(next.lines[3]).toEqual({ code: 'CB_ROAD_REPAIR_ODA', priority: 40, template_code: 'CB_ROAD_REPAIR', when: [{ field: 'funding_source', in: ['ODA'] }] });
    // The rule in force is never changed in place.
    expect(RULE.lines).toHaveLength(3);
  });

  it('a line the person put before the other procedure is read before it; without that choice it is read after every line', () => {
    const first = applyChange(RULE, 'CB_ROAD_REPAIR', { added: [{ field: 'project_type', value: 'UPGRADE', first: true }], removed: [] }) as typeof RULE;
    expect(first.lines[3]).toMatchObject({ code: 'CB_ROAD_REPAIR_UPGRADE', priority: 19 });
    const last = applyChange(RULE, 'CB_ROAD_REPAIR', { added: [{ field: 'project_type', value: 'UPGRADE', first: false }], removed: [] }) as typeof RULE;
    expect(last.lines[3]).toMatchObject({ priority: 40 });
    // No two lines share a priority or a code, however many are added.
    const many = applyChange(RULE, 'CB_ROAD_REPAIR', { added: [{ field: 'project_type', value: 'UPGRADE', first: true }, { field: 'project_type', value: 'REPAIR', first: true }, { field: 'project_type', value: 'UPGRADE', first: false }], removed: [] }) as typeof RULE;
    expect(new Set(many.lines.map((line) => line.priority)).size).toBe(many.lines.length);
    expect(new Set(many.lines.map((line) => line.code)).size).toBe(many.lines.length);
  });

  it('takes off only a line of this template', () => {
    const next = applyChange(RULE, 'CB_ROAD_REPAIR', { added: [], removed: ['ROAD_C', 'REPAIR'] }) as typeof RULE;
    expect(next.lines.map((line) => line.code)).toEqual(['REPAIR', 'ROAD_REPAIR']);
    expect(applyChange(undefined, 'X', { added: [{ field: 'project_type', value: 'A', first: false }], removed: [] })).toEqual({ lines: [{ code: 'X_A', priority: 10, template_code: 'X', when: [{ field: 'project_type', in: ['A'] }] }] });
  });

  it('says what a draft of the rule changes for the template (what its approver is shown)', () => {
    const draft = applyChange(RULE, 'CB_ROAD_REPAIR', { added: [{ field: 'funding_source', value: 'ODA', first: false }], removed: ['ROAD_C'] });
    const difference = applyDifference(RULE, draft, 'CB_ROAD_REPAIR');
    expect(difference.added.map((line) => line.code)).toEqual(['CB_ROAD_REPAIR_ODA']);
    expect(difference.removed.map((line) => line.code)).toEqual(['ROAD_C']);
    expect(applyDifference(RULE, RULE, 'CB_ROAD_REPAIR')).toEqual({ added: [], removed: [] });
    expect(applyDifference(RULE, draft, 'PUBLIC_REPAIR')).toEqual({ added: [], removed: [] });
  });
});
