import { DomainError } from '../src/errors';
import { assertValidReorganization, successorOf, unmapped, validateReorganization } from '../src/adm-reorganization';
import type { ReorganizationInput } from '../src/adm-reorganization';

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P1 = id(1);
const P2 = id(2);
const S1 = id(11);
const S2 = id(12);
const M = (n: number): string => id(100 + n);
const J = (n: number): string => id(200 + n);
const TODAY = '2026-10-29';

const input = (overrides: Partial<ReorganizationInput> = {}): ReorganizationInput => ({
  kind: 'MERGE',
  effectiveFrom: '2026-11-15',
  predecessorIds: [P1, P2],
  successors: [{ existingUnitId: S1 }],
  mapping: { memberships: [], projects: [] },
  ...overrides,
});
const fields = (r: ReorganizationInput): string[] => validateReorganization(r, TODAY).map((defect) => `${defect.field}:${defect.code}`);

describe('validateReorganization (ADM 3.2, ST-ADM-015)', () => {
  it('accepts a merge of two units into one existing unit, a split of one into two, a dissolution into one and a rename into a new unit', () => {
    expect(fields(input())).toEqual([]);
    expect(fields(input({ kind: 'SPLIT', predecessorIds: [P1], successors: [{ existingUnitId: S1 }, { existingUnitId: S2 }] }))).toEqual([]);
    expect(fields(input({ kind: 'DISSOLVE', predecessorIds: [P1, P2], successors: [{ existingUnitId: S1 }] }))).toEqual([]);
    expect(fields(input({ kind: 'RENAME', predecessorIds: [P1], successors: [{ newUnit: { code: 'NEW', name: 'Tên mới' } }] }))).toEqual([]);
  });

  it('each kind has its shape: a merge needs two or more predecessors and one successor, a split one predecessor and two or more existing successors, a rename one and one', () => {
    expect(fields(input({ predecessorIds: [P1] }))).toEqual(['predecessor_unit_ids:MERGE_NEEDS_TWO']);
    expect(fields(input({ successors: [{ existingUnitId: S1 }, { existingUnitId: S2 }] }))).toEqual(['successors:ONE_SUCCESSOR_ONLY']);
    expect(fields(input({ kind: 'SPLIT', predecessorIds: [P1, P2], successors: [{ existingUnitId: S1 }, { existingUnitId: S2 }] }))).toEqual(['predecessor_unit_ids:ONE_PREDECESSOR_ONLY']);
    expect(fields(input({ kind: 'SPLIT', predecessorIds: [P1], successors: [{ existingUnitId: S1 }] }))).toEqual(['successors:SPLIT_NEEDS_TWO']);
    expect(fields(input({ kind: 'SPLIT', predecessorIds: [P1], successors: [{ existingUnitId: S1 }, { newUnit: { code: 'N', name: 'N' } }] }))).toEqual(['successors[1]:NEW_UNIT_NEEDS_SOLE_SUCCESSOR']);
    expect(fields(input({ kind: 'RENAME', predecessorIds: [P1, P2], successors: [{ existingUnitId: S1 }] }))).toEqual(['predecessor_unit_ids:ONE_PREDECESSOR_ONLY']);
    expect(fields(input({ kind: 'DISSOLVE', predecessorIds: [P1], successors: [] }))).toEqual(['successors:SUCCESSORS_REQUIRED']);
  });

  it('refuses a kind it does not do (a transfer is the move of a unit), a successor that is a predecessor, repeats, and a successor that names both or neither', () => {
    expect(fields(input({ kind: 'TRANSFER' as never }))).toEqual(['kind:KIND_UNSUPPORTED']);
    expect(fields(input({ successors: [{ existingUnitId: P1 }] }))).toEqual(['successors[0]:SUCCESSOR_IS_PREDECESSOR']);
    expect(fields(input({ predecessorIds: [P1, P1] }))).toEqual(['predecessor_unit_ids:DUPLICATE']);
    expect(fields(input({ kind: 'SPLIT', predecessorIds: [P1], successors: [{ existingUnitId: S1 }, { existingUnitId: S1 }] }))).toEqual(['successors:DUPLICATE']);
    expect(fields(input({ successors: [{}] }))).toEqual(['successors[0]:SUCCESSOR_UNNAMED']);
    expect(fields(input({ successors: [{ existingUnitId: S1, newUnit: { code: 'N', name: 'N' } }] }))).toEqual(['successors[0]:SUCCESSOR_AMBIGUOUS']);
    expect(fields(input({ predecessorIds: [] }))).toEqual(['predecessor_unit_ids:PREDECESSORS_REQUIRED']);
  });

  it('needs a date, and the mapping may only point at a successor of the reorganisation', () => {
    expect(fields(input({ effectiveFrom: 'tomorrow' }))).toEqual(['effective_from:DATE_INVALID']);
    expect(fields(input({ effectiveFrom: '2026-02-31' }))).toEqual(['effective_from:DATE_INVALID']);
    expect(fields(input({ effectiveFrom: '2025-01-01' }))).toEqual([]);
    expect(fields(input({ mapping: { memberships: [{ membershipId: M(1), successorUnitId: S2 }], projects: [] } }))).toEqual(['mapping.memberships[0]:TARGET_NOT_A_SUCCESSOR']);
    expect(fields(input({ mapping: { memberships: [], projects: [{ projectId: J(1), successorUnitId: id(99) }] } }))).toEqual(['mapping.projects[0]:TARGET_NOT_A_SUCCESSOR']);
    expect(fields(input({ mapping: { memberships: [], projects: [], defaultSuccessorUnitId: S2 } }))).toEqual(['mapping.default_successor_unit_id:TARGET_NOT_A_SUCCESSOR']);
    expect(
      fields(
        input({
          mapping: {
            memberships: [
              { membershipId: M(1), successorUnitId: S1 },
              { membershipId: M(1), successorUnitId: S1 },
            ],
            projects: [],
          },
        }),
      ),
    ).toEqual(['mapping.memberships[1]:DUPLICATE']);
  });

  it('assertValidReorganization answers 422 naming the first field and carrying every defect', () => {
    expect(() => assertValidReorganization(input(), TODAY)).not.toThrow();
    try {
      assertValidReorganization(input({ predecessorIds: [P1], effectiveFrom: 'x' }), TODAY);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect(error).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'predecessor_unit_ids' });
      expect((error as DomainError).extensions?.defects).toEqual([
        { field: 'predecessor_unit_ids', code: 'MERGE_NEEDS_TWO' },
        { field: 'effective_from', code: 'DATE_INVALID' },
      ]);
    }
  });
});

describe('unmapped and successorOf (the mapping of members and projects)', () => {
  it('with one successor nothing has to be mapped: everything goes to it', () => {
    expect(unmapped(input(), [M(1), M(2)], [J(1)], [S1])).toEqual({ memberships: [], projects: [] });
    expect(successorOf(input(), 'membership', M(1), [S1])).toBe(S1);
  });

  it('with several successors each member and project needs a place: its own entry or the default successor; what has none is listed', () => {
    const split = input({
      kind: 'SPLIT',
      predecessorIds: [P1],
      successors: [{ existingUnitId: S1 }, { existingUnitId: S2 }],
      mapping: { memberships: [{ membershipId: M(1), successorUnitId: S1 }], projects: [{ projectId: J(1), successorUnitId: S2 }] },
    });
    expect(unmapped(split, [M(1), M(2), M(3)], [J(1), J(2)], [S1, S2])).toEqual({ memberships: [M(2), M(3)], projects: [J(2)] });
    expect(successorOf(split, 'membership', M(1), [S1, S2])).toBe(S1);
    expect(successorOf(split, 'project', J(1), [S1, S2])).toBe(S2);
    expect(successorOf(split, 'membership', M(2), [S1, S2])).toBeUndefined();
    const withDefault = { ...split, mapping: { ...split.mapping, defaultSuccessorUnitId: S2 } };
    expect(unmapped(withDefault, [M(1), M(2)], [J(1), J(2)], [S1, S2])).toEqual({ memberships: [], projects: [] });
    expect(successorOf(withDefault, 'membership', M(2), [S1, S2])).toBe(S2);
  });

  it('a district with 6 projects and a mapping that covers 5 lists the one that is missing', () => {
    const projects = [1, 2, 3, 4, 5, 6].map(J);
    const split = input({
      kind: 'SPLIT',
      predecessorIds: [P1],
      successors: [{ existingUnitId: S1 }, { existingUnitId: S2 }],
      mapping: { memberships: [], projects: projects.slice(0, 5).map((projectId) => ({ projectId, successorUnitId: S1 })) },
    });
    expect(unmapped(split, [], projects, [S1, S2])).toEqual({ memberships: [], projects: [J(6)] });
  });
});
