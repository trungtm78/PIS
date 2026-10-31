import { assertPromotable, assertRunnable, assumptionsJson, constraintsJson, parseAssumptions, parseConstraints, promotionReason, proposalCodeOf, resultJson, simulate } from '../src/cap-scenario.ts';
import type { LineBasis, ResolvedMove, ScenarioConstraints } from '../src/cap-scenario.ts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const PROJECT_A = '33333333-3333-4333-8333-333333333333';
const PROJECT_B = '44444444-4444-4444-8444-444444444444';
const NONE: ScenarioConstraints = { minRemainingVnd: null, maxMoveVnd: null, maxTotalVnd: null };

const basis = (allocated: string, projectId: string, extra: Partial<LineBasis> = {}): LineBasis => ({ allocatedVnd: allocated, reservedVnd: '0', committedVnd: '0', disbursedVnd: '0', projectId, ...extra });
const step = (from: string, to: string, amount: string): ResolvedMove => ({ fromLineId: from, toLineId: to, fromProjectId: from === A ? PROJECT_A : PROJECT_B, toProjectId: to === A ? PROJECT_A : PROJECT_B, amountVnd: amount, rationale: '' });
const lines = (...entries: Array<[string, LineBasis]>) => new Map(entries);
const sim = (moves: ResolvedMove[], lineBasis: Map<string, LineBasis>, constraints: ScenarioConstraints, totals: Map<string, string> = new Map()) => simulate(moves, lineBasis, constraints, totals);
const infeasible = (action: () => unknown) => {
  try {
    action();
  } catch (error) {
    return error as { code: string; status: number; extensions: { violations: Array<Record<string, unknown>> } };
  }
  throw new Error('the scenario was feasible');
};

describe('the simulation of an allocation (ST-CAP-013, CAP 3.1 F8)', () => {
  describe('the assumptions', () => {
    it('takes one to 200 moves with a line, a project and a whole positive amount, and keeps them in the shape of the contract', () => {
      const moves = parseAssumptions({ moves: [{ from_allocation_line_id: A.toUpperCase(), to_project_id: PROJECT_B, amount_vnd: '100', rationale: 'Behind the curve' }, { from_allocation_line_id: B, to_project_id: PROJECT_A, amount_vnd: '5' }] });
      expect(moves).toEqual([
        { fromAllocationLineId: A, toProjectId: PROJECT_B, amountVnd: '100', rationale: 'Behind the curve' },
        { fromAllocationLineId: B, toProjectId: PROJECT_A, amountVnd: '5', rationale: '' },
      ]);
      expect(assumptionsJson(moves)).toEqual({
        moves: [
          { from_allocation_line_id: A, to_project_id: PROJECT_B, amount_vnd: '100', rationale: 'Behind the curve' },
          { from_allocation_line_id: B, to_project_id: PROJECT_A, amount_vnd: '5' },
        ],
      });
      expect(parseAssumptions(assumptionsJson(moves))).toEqual(moves);
    });

    it('refuses anything else, naming the field (422 VALIDATION_FAILED)', () => {
      const move = { from_allocation_line_id: A, to_project_id: PROJECT_B, amount_vnd: '100' };
      const field = (raw: unknown): string | undefined => {
        try {
          parseAssumptions(raw);
          return undefined;
        } catch (error) {
          expect(error).toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
          return (error as { detail: string }).detail;
        }
      };
      expect(field(null)).toBe('assumptions');
      expect(field([move])).toBe('assumptions');
      expect(field({ moves: [move], other: 1 })).toBe('assumptions.other');
      expect(field({})).toBe('assumptions.moves');
      expect(field({ moves: 'x' })).toBe('assumptions.moves');
      expect(field({ moves: [] })).toBe('assumptions.moves');
      expect(field({ moves: Array.from({ length: 201 }, (_, index) => ({ ...move, from_allocation_line_id: `${index.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111` })) })).toBe('assumptions.moves');
      expect(field({ moves: ['x'] })).toBe('assumptions.moves[0]');
      expect(field({ moves: [[]] })).toBe('assumptions.moves[0]');
      expect(field({ moves: [{ ...move, extra: 1 }] })).toBe('assumptions.moves[0].extra');
      expect(field({ moves: [{ ...move, from_allocation_line_id: 'x' }] })).toBe('assumptions.moves[0].from_allocation_line_id');
      expect(field({ moves: [{ ...move, from_allocation_line_id: 5 }] })).toBe('assumptions.moves[0].from_allocation_line_id');
      expect(field({ moves: [{ ...move, to_project_id: 'x' }] })).toBe('assumptions.moves[0].to_project_id');
      for (const bad of ['0', '-1', '1.5', '01', '', 5, null]) expect(field({ moves: [{ ...move, amount_vnd: bad }] })).toBe('assumptions.moves[0].amount_vnd');
      expect(field({ moves: [{ ...move, rationale: ' padded ' }] })).toBe('assumptions.moves[0].rationale');
      expect(field({ moves: [{ ...move, rationale: 'x'.repeat(2001) }] })).toBe('assumptions.moves[0].rationale');
      expect(field({ moves: [{ ...move, rationale: 7 }] })).toBe('assumptions.moves[0].rationale');
      expect(field({ moves: [move, { ...move, from_allocation_line_id: A.toUpperCase() }] })).toBe('assumptions.moves[1].from_allocation_line_id');
    });
  });

  describe('the constraints', () => {
    it('takes any of the three limits as whole dong, the minimum possibly 0, and keeps only those that were given', () => {
      expect(parseConstraints({})).toEqual(NONE);
      const all = parseConstraints({ min_remaining_vnd: '0', max_move_vnd: '10', max_total_vnd: '99' });
      expect(all).toEqual({ minRemainingVnd: '0', maxMoveVnd: '10', maxTotalVnd: '99' });
      expect(constraintsJson(all)).toEqual({ min_remaining_vnd: '0', max_move_vnd: '10', max_total_vnd: '99' });
      expect(constraintsJson(NONE)).toEqual({});
      expect(constraintsJson({ ...NONE, maxMoveVnd: '7' })).toEqual({ max_move_vnd: '7' });
      expect(parseConstraints(constraintsJson(all))).toEqual(all);
    });

    it('refuses what is not a limit or not whole dong (422 VALIDATION_FAILED naming the field)', () => {
      const field = (raw: unknown): string | undefined => {
        try {
          parseConstraints(raw);
          return undefined;
        } catch (error) {
          expect(error).toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
          return (error as { detail: string }).detail;
        }
      };
      expect(field(null)).toBe('constraints');
      expect(field([])).toBe('constraints');
      expect(field({ floor: '1' })).toBe('constraints.floor');
      expect(field({ min_remaining_vnd: '-1' })).toBe('constraints.min_remaining_vnd');
      expect(field({ min_remaining_vnd: 1 })).toBe('constraints.min_remaining_vnd');
      expect(field({ max_move_vnd: '0' })).toBe('constraints.max_move_vnd');
      expect(field({ max_total_vnd: '1.5' })).toBe('constraints.max_total_vnd');
    });
  });

  describe('the run', () => {
    it('applies the moves to a copy of the lines: each line and each project before and after, the total moved, and the minimum each donor keeps', () => {
      const result = sim([step(A, B, '2000')], lines([A, basis('5000', PROJECT_A, { reservedVnd: '500', committedVnd: '300', disbursedVnd: '200' })], [B, basis('1000', PROJECT_B)]), { ...NONE, minRemainingVnd: '2500' });
      expect(result.totalMovedVnd).toBe('2000');
      expect(result.lines).toEqual([
        { lineId: A, projectId: PROJECT_A, beforeVnd: '5000', afterVnd: '3000', minimumVnd: '2500' },
        { lineId: B, projectId: PROJECT_B, beforeVnd: '1000', afterVnd: '3000', minimumVnd: '0' },
      ]);
      expect(result.projects).toEqual([
        { projectId: PROJECT_A, beforeVnd: '5000', afterVnd: '3000' },
        { projectId: PROJECT_B, beforeVnd: '1000', afterVnd: '3000' },
      ]);
    });

    it('takes what is spoken for on the line as its minimum when that is more than the limit of the scenario', () => {
      const result = sim([step(A, B, '100')], lines([A, basis('5000', PROJECT_A, { reservedVnd: '1000', committedVnd: '1000' })], [B, basis('0', PROJECT_B)]), { ...NONE, minRemainingVnd: '500' });
      expect(result.lines[0]?.minimumVnd).toBe('2000');
    });

    it('judges a line that gives and receives by the difference, and does not judge a line that only receives', () => {
      const both = sim([step(A, B, '900'), step(B, A, '900')], lines([A, basis('1000', PROJECT_A)], [B, basis('1000', PROJECT_B)]), { ...NONE, minRemainingVnd: '1000' });
      expect(both.lines.map((line) => [line.beforeVnd, line.afterVnd])).toEqual([['1000', '1000'], ['1000', '1000']]);
      expect(both.totalMovedVnd).toBe('1800');
      const receives = sim([step(A, B, '100')], lines([A, basis('1000', PROJECT_A)], [B, basis('50', PROJECT_B, { reservedVnd: '90' })]), NONE);
      expect(receives.lines[1]?.afterVnd).toBe('150');
    });

    it('is infeasible below the minimum, with the line, what it holds, what it loses and the minimum it keeps', () => {
      const error = infeasible(() => sim([step(A, B, '4000')], lines([A, basis('5000', PROJECT_A)], [B, basis('0', PROJECT_B)]), { ...NONE, minRemainingVnd: '2000' }));
      expect(error).toMatchObject({ code: 'SCENARIO_CONSTRAINT_INFEASIBLE', status: 422 });
      expect(error.extensions.violations).toEqual([{ kind: 'BELOW_MINIMUM', line_id: A, allocated_vnd: '5000', reduced_vnd: '4000', minimum_vnd: '2000' }]);
    });

    it('is infeasible when a line gives more than it holds, or goes below what is reserved, committed and disbursed on it', () => {
      expect(infeasible(() => sim([step(A, B, '5001')], lines([A, basis('5000', PROJECT_A)], [B, basis('0', PROJECT_B)]), NONE)).extensions.violations).toEqual([
        { kind: 'BELOW_MINIMUM', line_id: A, allocated_vnd: '5000', reduced_vnd: '5001', minimum_vnd: '0' },
      ]);
      expect(infeasible(() => sim([step(A, B, '1')], lines([A, basis('5000', PROJECT_A, { disbursedVnd: '5000' })], [B, basis('0', PROJECT_B)]), NONE)).extensions.violations).toHaveLength(1);
    });

    it('is infeasible above the limit of a move and above the limit of the total, and says so for each', () => {
      const error = infeasible(() => sim([step(A, B, '300'), step(A, B, '200')], lines([A, basis('5000', PROJECT_A)], [B, basis('0', PROJECT_B)]), { ...NONE, maxMoveVnd: '250', maxTotalVnd: '400' }));
      expect(error.extensions.violations).toEqual([
        { kind: 'MOVE_ABOVE_LIMIT', move: 0, amount_vnd: '300', limit_vnd: '250' },
        { kind: 'TOTAL_ABOVE_LIMIT', total_vnd: '500', limit_vnd: '400' },
      ]);
      expect(sim([step(A, B, '250')], lines([A, basis('5000', PROJECT_A)], [B, basis('0', PROJECT_B)]), { ...NONE, maxMoveVnd: '250', maxTotalVnd: '250' }).totalMovedVnd).toBe('250');
    });

    it('shows a project with everything the plan gives it: the lines the moves do not name count in its before and after, and the change is the same', () => {
      const result = sim([step(A, B, '20')], lines([A, basis('100', PROJECT_A)], [B, basis('50', PROJECT_B)]), NONE, new Map([[PROJECT_A, '1000'], [PROJECT_B, '70']]));
      expect(result.projects).toEqual([
        { projectId: PROJECT_A, beforeVnd: '1000', afterVnd: '980' },
        { projectId: PROJECT_B, beforeVnd: '70', afterVnd: '90' },
      ]);
      expect(result.lines.map((line) => [line.beforeVnd, line.afterVnd])).toEqual([['100', '80'], ['50', '70']]);
    });

    it('needs the basis of every line it moves', () => {
      expect(() => sim([step(A, B, '1')], lines([A, basis('5000', PROJECT_A)]), NONE)).toThrow('a line of a scenario has a basis');
    });

    it('is kept in the shape of the screen: the moves with their lines, the lines, the projects and when it was run', () => {
      const result = sim([step(A, B, '100')], lines([A, basis('500', PROJECT_A)], [B, basis('50', PROJECT_B)]), NONE);
      expect(resultJson(result, '2027-01-01T00:00:00.000Z')).toEqual({
        ran_at: '2027-01-01T00:00:00.000Z',
        total_moved_vnd: '100',
        moves: [{ from_allocation_line_id: A, to_allocation_line_id: B, from_project_id: PROJECT_A, to_project_id: PROJECT_B, amount_vnd: '100' }],
        lines: [
          { allocation_line_id: A, project_id: PROJECT_A, before_vnd: '500', after_vnd: '400', minimum_vnd: '0' },
          { allocation_line_id: B, project_id: PROJECT_B, before_vnd: '50', after_vnd: '150', minimum_vnd: '0' },
        ],
        projects: [
          { project_id: PROJECT_A, before_vnd: '500', after_vnd: '400' },
          { project_id: PROJECT_B, before_vnd: '50', after_vnd: '150' },
        ],
      });
    });
  });

  describe('the states', () => {
    it('is run while it is a draft or has a result, and never after it was promoted or archived', () => {
      expect(() => assertRunnable('DRAFT')).not.toThrow();
      expect(() => assertRunnable('RUN')).not.toThrow();
      for (const status of ['PROMOTED', 'ARCHIVED'] as const) expect(() => assertRunnable(status)).toThrow(expect.objectContaining({ code: 'STAGE_TRANSITION_DENIED', status: 409 }));
    });

    it('is promoted once it has a result: a draft is 409 SCENARIO_NOT_RUN, a promoted or archived one is final', () => {
      expect(() => assertPromotable('RUN')).not.toThrow();
      expect(() => assertPromotable('DRAFT')).toThrow(expect.objectContaining({ code: 'SCENARIO_NOT_RUN', status: 409 }));
      for (const status of ['PROMOTED', 'ARCHIVED'] as const) expect(() => assertPromotable(status)).toThrow(expect.objectContaining({ code: 'STAGE_TRANSITION_DENIED', status: 409 }));
    });
  });

  describe('the proposal it becomes', () => {
    it('takes the code of the scenario behind a prefix, and a hash of the whole code when it would not fit in 50 characters', () => {
      expect(proposalCodeOf('KB-2027')).toBe('SCN-KB-2027');
      const fits = 'x'.repeat(46);
      expect(proposalCodeOf(fits)).toBe(`SCN-${fits}`);
      const long = proposalCodeOf('y'.repeat(50));
      expect(long).toHaveLength(50);
      expect(long.startsWith('SCN-yyyy')).toBe(true);
      expect(proposalCodeOf('y'.repeat(49) + 'z')).not.toBe(long);
      expect(proposalCodeOf('y'.repeat(50))).toBe(long);
    });

    it('says what it was drawn from, and is long enough for a proposal (at least 20 characters)', () => {
      const reason = promotionReason('KB-2027', 2, '3000');
      expect(reason).toBe('Promoted from the allocation scenario KB-2027: 2 move(s), 3000 VND in all.');
      expect(promotionReason('K', 1, '1').length).toBeGreaterThanOrEqual(20);
    });
  });
});
