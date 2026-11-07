import { DomainError } from '../src/errors';
import { B1_DEFAULTS } from '../src/gov-b1-policy';
import {
  assertBaselineCapturable,
  baselineDeviation,
  baselineTotal,
  deriveBaselineLines,
  earliestStart,
  firstLevelRootOf,
  latestFinish,
  percentOf,
  plannedValueAt,
  ratioOf,
  reappraisalReasons,
  rescheduleCount,
  rescheduleNeedsAlert,
  scaledOf,
} from '../src/prj-baseline';
import type { ComponentFact, MilestoneFact } from '../src/prj-baseline';

function refusal(work: () => unknown): DomainError {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
}

const policy = B1_DEFAULTS.BASELINE_DEVIATION;

const component = (id: string, parentId: string | null, code: string, value: string, validFrom: string, validUntil: string | null = null): ComponentFact => ({ id, parentId, code, name: `Gói ${code}`, plannedValueVnd: value, validFrom, validUntil });
const milestone = (id: string, componentId: string | null, baselineDate: string, plannedDate: string, status: MilestoneFact['status'] = 'PLANNED'): MilestoneFact => ({ id, componentId, code: id, baselineDate, plannedDate, status });

describe('the first-level work package of a component', () => {
  const parents = new Map<string, string | null>([
    ['A', null],
    ['A1', 'A'],
    ['A11', 'A1'],
    ['LOOP1', 'LOOP2'],
    ['LOOP2', 'LOOP1'],
  ]);
  it('is the component itself at the first level and the top of the chain below it', () => {
    expect(firstLevelRootOf('A', parents)).toBe('A');
    expect(firstLevelRootOf('A1', parents)).toBe('A');
    expect(firstLevelRootOf('A11', parents)).toBe('A');
  });
  it('is nothing for a component that is not known or whose chain loops, never an endless walk', () => {
    expect(firstLevelRootOf('ZZ', parents)).toBeUndefined();
    expect(firstLevelRootOf('LOOP1', parents)).toBeUndefined();
  });
});

describe('the lines of a baseline (G1-3)', () => {
  const components = [
    component('B', null, 'B', '500', '2026-03-01'),
    component('A', null, 'A', '1000', '2026-01-01'),
    component('A1', 'A', 'A1', '400', '2026-01-01'),
    component('C', null, 'C', '300', '2026-01-01', '2026-06-01'),
  ];
  const milestones = [
    milestone('M1', 'A1', '2026-05-31', '2026-07-15'),
    milestone('M2', 'A', '2026-06-30', '2026-08-31'),
    milestone('M3', 'A', '2027-01-01', '2027-02-01', 'CANCELLED'),
    milestone('M4', null, '2030-01-01', '2030-01-01'),
  ];

  it('takes one line per first-level component in force, in the order of their codes, and the finish from the baseline days of the milestones', () => {
    const { lines, issues } = deriveBaselineLines({ components, milestones, basis: 'BASELINE', projectFinish: '2026-12-31' });
    expect(issues).toEqual([]);
    expect(lines).toEqual([
      { componentId: 'A', code: 'A', name: 'Gói A', bacVnd: '1000', plannedStart: '2026-01-01', plannedFinish: '2026-06-30' },
      { componentId: 'B', code: 'B', name: 'Gói B', bacVnd: '500', plannedStart: '2026-03-01', plannedFinish: '2026-12-31' },
    ]);
  });

  it('reads the planned days for a later version, ignoring a cancelled milestone and one that belongs to no component', () => {
    const { lines } = deriveBaselineLines({ components, milestones, basis: 'PLANNED', projectFinish: '2026-12-31' });
    expect(lines.map((line) => [line.code, line.plannedFinish])).toEqual([
      ['A', '2026-08-31'],
      ['B', '2026-12-31'],
    ]);
  });

  it('names a component with no finish day or one that would finish before it starts, and never guesses', () => {
    const noFinish = deriveBaselineLines({ components, milestones, basis: 'BASELINE', projectFinish: null });
    expect(noFinish.lines.map((line) => line.code)).toEqual(['A']);
    expect(noFinish.issues).toEqual([{ code: 'NO_FINISH_DATE', componentCode: 'B' }]);
    const backwards = deriveBaselineLines({ components: [component('X', null, 'X', '10', '2027-01-01')], milestones: [], basis: 'BASELINE', projectFinish: '2026-12-31' });
    expect(backwards.lines).toEqual([]);
    expect(backwards.issues).toEqual([{ code: 'FINISH_BEFORE_START', componentCode: 'X' }]);
  });
});

describe('what it takes to take version 0', () => {
  const line = { componentId: 'A', code: 'A', name: 'A', bacVnd: '10', plannedStart: '2026-01-01', plannedFinish: '2026-02-01' };
  it('refuses a project with no work breakdown and one whose value adds up to nothing (BASELINE_NO_WBS)', () => {
    const empty = refusal(() => assertBaselineCapturable({ lines: [], issues: [] }));
    expect([empty.code, empty.status, empty.detail]).toEqual(['BASELINE_NO_WBS', 422, 'components']);
    expect(refusal(() => assertBaselineCapturable({ lines: [{ ...line, bacVnd: '0' }], issues: [] })).code).toBe('BASELINE_NO_WBS');
  });
  it('refuses a partial plan and tells which components are the cause (BASELINE_INCOMPLETE)', () => {
    const error = refusal(() => assertBaselineCapturable({ lines: [line], issues: [{ code: 'NO_FINISH_DATE', componentCode: 'B' }] }));
    expect(error).toBeInstanceOf(DomainError);
    expect([error.code, error.status]).toEqual(['BASELINE_INCOMPLETE', 422]);
    expect(error.extensions).toEqual({ issues: [{ code: 'NO_FINISH_DATE', component_code: 'B' }] });
    // an issue with no line at all is incomplete, not "no breakdown"
    expect(refusal(() => assertBaselineCapturable({ lines: [], issues: [{ code: 'FINISH_BEFORE_START', componentCode: 'B' }] })).code).toBe('BASELINE_INCOMPLETE');
  });
  it('lets a complete plan through', () => {
    expect(() => assertBaselineCapturable({ lines: [line], issues: [] })).not.toThrow();
  });
  it('adds the total as whole dong beyond the safe integer range and finds the first and last day', () => {
    const lines = [
      { ...line, bacVnd: '9007199254740993', plannedStart: '2026-03-01', plannedFinish: '2026-09-01' },
      { ...line, bacVnd: '7', plannedStart: '2026-01-15', plannedFinish: '2026-12-31' },
    ];
    expect(baselineTotal(lines)).toBe('9007199254741000');
    expect(earliestStart(lines)).toBe('2026-01-15');
    expect(latestFinish(lines)).toBe('2026-12-31');
    expect(earliestStart([])).toBeNull();
    expect(latestFinish([])).toBeNull();
    expect(baselineTotal([])).toBe('0');
  });
});

describe('the value planned by a day on the straight curve', () => {
  const ten = { bacVnd: '1000', plannedStart: '2026-01-01', plannedFinish: '2026-01-10' };
  it('is nothing before the first day, all of it from the last day, and the share of the days that passed between (both ends count)', () => {
    expect(plannedValueAt(ten, '2025-12-31')).toBe(0n);
    expect(plannedValueAt(ten, '2026-01-01')).toBe(100n);
    expect(plannedValueAt(ten, '2026-01-05')).toBe(500n);
    expect(plannedValueAt(ten, '2026-01-09')).toBe(900n);
    expect(plannedValueAt(ten, '2026-01-10')).toBe(1000n);
    expect(plannedValueAt(ten, '2030-01-01')).toBe(1000n);
  });
  it('rounds down to the dong, never up to a value that was not yet planned', () => {
    const three = { bacVnd: '1000', plannedStart: '2026-01-01', plannedFinish: '2026-01-03' };
    expect(plannedValueAt(three, '2026-01-01')).toBe(333n);
    expect(plannedValueAt(three, '2026-01-02')).toBe(666n);
  });
  it('handles a work package of one day and a value larger than a double can hold', () => {
    expect(plannedValueAt({ bacVnd: '50', plannedStart: '2026-01-01', plannedFinish: '2026-01-01' }, '2026-01-01')).toBe(50n);
    expect(plannedValueAt({ bacVnd: '9007199254740993000', plannedStart: '2026-01-01', plannedFinish: '2026-01-10' }, '2026-01-05')).toBe(4503599627370496500n);
  });
  it('refuses a day that is not a calendar day instead of answering zero', () => {
    const error = refusal(() => plannedValueAt(ten, '2026-02-30'));
    expect([error.code, error.status, error.detail]).toEqual(['VALIDATION_FAILED', 422, 'as_of']);
  });
});

describe('percent and ratio from whole numbers', () => {
  it('writes four decimals, half away from zero, with the sign of the quotient', () => {
    expect(percentOf(1n, 3n)).toBe('33.3333');
    expect(percentOf(-1n, 3n)).toBe('-33.3333');
    expect(ratioOf(2n, 3n)).toBe('0.6667');
    expect(ratioOf(-2n, 3n)).toBe('-0.6667');
    expect(ratioOf(1n, -3n)).toBe('-0.3333');
    expect(ratioOf(-1n, -3n)).toBe('0.3333');
    expect(ratioOf(1n, 8n)).toBe('0.1250');
    expect(ratioOf(1n, 20000n)).toBe('0.0001');
    expect(ratioOf(-1n, 20000n)).toBe('-0.0001');
  });
  it('has no negative zero and treats a real zero as a number', () => {
    expect(ratioOf(-1n, 30000n)).toBe('0.0000');
    expect(ratioOf(0n, 5n)).toBe('0.0000');
  });
  it('is null, not zero, when there is nothing to divide by', () => {
    expect(ratioOf(5n, 0n)).toBeNull();
    expect(percentOf(0n, 0n)).toBeNull();
  });
  it('reads a written decimal back to the scaled whole number', () => {
    expect(scaledOf('-12.5000')).toBe(-125000n);
    expect(scaledOf('0.9523')).toBe(9523n);
    expect(scaledOf('12')).toBe(120000n);
    expect(scaledOf('1.5')).toBe(15000n);
    expect(scaledOf('0.0000')).toBe(0n);
    expect(ratioOf(scaledOf('-12.5000'), 10000n)).toBe('-12.5000');
  });
});

describe('the deviation from version 0 (G1-4)', () => {
  const v0 = { totalInvestmentVnd: '1000', bacVnd: '800', plannedStart: '2026-01-01', plannedFinish: '2026-12-31' };
  const moves = [
    { ...milestone('M1', 'A', '2026-06-30', '2026-09-30'), moves: 2 },
    { ...milestone('M2', 'A', '2026-12-31', '2027-03-31'), moves: 1 },
    { ...milestone('M3', 'A', '2026-10-01', '2028-01-01', 'CANCELLED'), moves: 4 },
  ];

  it('measures the cost and the finish against version 0, whatever the revisions in between', () => {
    const deviation = baselineDeviation({ v0, currentTotalInvestmentVnd: '1150', currentBacVnd: '800', milestones: moves });
    expect(deviation).toMatchObject({ costVnd: '150', costPct: '15.0000', bacVnd: '0', bacPct: '0.0000', forecastFinish: '2027-03-31', finishSlipDays: 90 });
    // a cancelled milestone is listed but never forecasts the finish
    expect(deviation.milestones.map((entry) => [entry.code, entry.slipDays, entry.moves])).toEqual([
      ['M1', 92, 2],
      ['M2', 90, 1],
      ['M3', 457, 4],
    ]);
  });
  it('is negative when the project got cheaper and earlier, and says so', () => {
    const deviation = baselineDeviation({ v0, currentTotalInvestmentVnd: '900', currentBacVnd: '720', milestones: [{ ...milestone('M1', 'A', '2026-12-31', '2026-12-01'), moves: 1 }] });
    expect(deviation).toMatchObject({ costVnd: '-100', costPct: '-10.0000', bacVnd: '-80', bacPct: '-10.0000', finishSlipDays: -30 });
  });
  it('has no finish slip when there is no milestone to stand on or version 0 has no finish, and no percent of a total of nothing', () => {
    expect(baselineDeviation({ v0, currentTotalInvestmentVnd: '1000', currentBacVnd: '800', milestones: [] })).toMatchObject({ finishSlipDays: null, forecastFinish: null });
    expect(baselineDeviation({ v0: { ...v0, plannedFinish: null }, currentTotalInvestmentVnd: '1000', currentBacVnd: '800', milestones: moves }).finishSlipDays).toBeNull();
    expect(baselineDeviation({ v0: { ...v0, totalInvestmentVnd: '0', bacVnd: '0' }, currentTotalInvestmentVnd: '5', currentBacVnd: '5', milestones: [] })).toMatchObject({ costVnd: '5', costPct: null, bacPct: null });
  });
});

describe('when the deviation asks for a re-appraisal', () => {
  it('asks when the total moved by more than the percent, either way, and not at the line itself', () => {
    expect(policy).toMatchObject({ costPct: 10, slipDays: 90 });
    expect(reappraisalReasons({ costPct: '10.0000', finishSlipDays: 0 }, policy)).toEqual([]);
    expect(reappraisalReasons({ costPct: '10.0001', finishSlipDays: 0 }, policy)).toEqual(['COST']);
    expect(reappraisalReasons({ costPct: '-10.5000', finishSlipDays: 0 }, policy)).toEqual(['COST']);
    expect(reappraisalReasons({ costPct: '-10.0000', finishSlipDays: 0 }, policy)).toEqual([]);
  });
  it('asks when the finish moved later by more than the days, and never for an earlier finish', () => {
    expect(reappraisalReasons({ costPct: '0.0000', finishSlipDays: 90 }, policy)).toEqual([]);
    expect(reappraisalReasons({ costPct: '0.0000', finishSlipDays: 91 }, policy)).toEqual(['SLIP']);
    expect(reappraisalReasons({ costPct: '0.0000', finishSlipDays: -400 }, policy)).toEqual([]);
  });
  it('names both reasons, and asks nothing about a figure that is unknown', () => {
    expect(reappraisalReasons({ costPct: '25.0000', finishSlipDays: 200 }, policy)).toEqual(['COST', 'SLIP']);
    expect(reappraisalReasons({ costPct: null, finishSlipDays: null }, policy)).toEqual([]);
  });
  it('follows the policy it is given, not the default', () => {
    expect(reappraisalReasons({ costPct: '5.0000', finishSlipDays: 31 }, { costPct: 4.5, slipDays: 30, rescheduleAlertCount: 3 })).toEqual(['COST', 'SLIP']);
  });
});

describe('how often a date was moved', () => {
  it('counts each milestone and the project finish apart and reports the most any one date moved', () => {
    const result = rescheduleCount([
      { source: 'MILESTONE', milestoneId: 'M1' },
      { source: 'MILESTONE', milestoneId: 'M1' },
      { source: 'MILESTONE', milestoneId: 'M1' },
      { source: 'MILESTONE', milestoneId: 'M2' },
      { source: 'REVISION', milestoneId: null },
      { source: 'REVISION', milestoneId: 'M2' },
    ]);
    expect(result.perMilestone.get('M1')).toBe(3);
    expect(result.perMilestone.get('M2')).toBe(1);
    expect(result.projectMoves).toBe(2);
    expect(result.count).toBe(3);
  });
  it('lets the project finish be the one that was moved most, and counts a milestone event with no milestone as a project move', () => {
    const result = rescheduleCount([
      { source: 'MILESTONE', milestoneId: null },
      { source: 'REVISION', milestoneId: null },
      { source: 'REVISION', milestoneId: null },
      { source: 'REVISION', milestoneId: null },
      { source: 'MILESTONE', milestoneId: 'M1' },
    ]);
    expect(result.projectMoves).toBe(4);
    expect(result.count).toBe(4);
  });
  it('is zero when nothing moved', () => {
    expect(rescheduleCount([])).toMatchObject({ projectMoves: 0, count: 0 });
  });
  it('raises the alert at the count of the policy and above, not below (the research: three)', () => {
    expect(rescheduleNeedsAlert(2, policy)).toBe(false);
    expect(rescheduleNeedsAlert(3, policy)).toBe(true);
    expect(rescheduleNeedsAlert(4, policy)).toBe(true);
    expect(rescheduleNeedsAlert(4, { ...policy, rescheduleAlertCount: 5 })).toBe(false);
  });
});
