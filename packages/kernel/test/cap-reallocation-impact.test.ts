import { reallocationPolicyDefaults, reallocationPolicyOf, projectedImpact, rateDelta, reallocationCandidates, simulateReallocation } from '../src/cap-reallocation-impact.ts';
import type { ImpactMove, ImpactProject } from '../src/cap-reallocation-impact.ts';
import { addSums, rateOfSums } from '../src/dis-rates.ts';
import type { RateSums } from '../src/dis-rates.ts';
import { builtInDefault, validateRuleParams } from '../src/governance-rules.ts';

const sums = (planPm: string, planLocal: string, treasury: string | null, over: Partial<RateSums> = {}): RateSums => ({
  projects: 1,
  planPmVnd: planPm,
  planLocalVnd: planLocal,
  treasuryVnd: treasury,
  reportedVnd: treasury,
  ctmtqgVnd: null,
  allNone: false,
  allComplete: true,
  ...over,
});
const project = (projectId: string, unitId: string | null, year: RateSums, carry: RateSums = sums('0', '0', null, { allNone: true })): ImpactProject => ({ projectId, unitId, sums: { CURRENT_YEAR: year, CARRYOVER: carry } });

// Two units: A holds P1 (slow) and P2; B holds P3 (fast).
const FIXTURE: ImpactProject[] = [
  project('p1', 'unit-a', sums('1000000000', '0', '200000000')),
  project('p2', 'unit-a', sums('500000000', '100000000', '300000000')),
  project('p3', 'unit-b', sums('400000000', '0', '420000000')),
];

const move = (over: Partial<ImpactMove> = {}): ImpactMove => ({ fromProjectId: 'p1', toProjectId: 'p3', amountVnd: '300000000', bucket: 'CURRENT_YEAR', split: 'PM', ...over });

describe('the simulation of a reallocation (G1-12): the rates DIS shows, before and after', () => {
  it('golden: with no move, before and after are the rates that DIS makes from the same sums, for the province, each unit and each basis', () => {
    const result = simulateReallocation({ projects: FIXTURE, moves: [] });
    const expected = rateOfSums(addSums(FIXTURE.map((each) => each.sums.CURRENT_YEAR)), 'CURRENT_YEAR');
    expect(result.basis.CURRENT_YEAR.province.before).toEqual(expected);
    expect(result.basis.CURRENT_YEAR.province.after).toEqual(expected);
    expect(result.basis.CURRENT_YEAR.province.deltaRateTotalPct).toBe('0.0000');
    expect(expected).toMatchObject({ numeratorVnd: '920000000', planTotalVnd: '2000000000', rateTotalPct: '46.0000', ratePmPct: '48.4211' });
    const unitA = result.basis.CURRENT_YEAR.units.find((unit) => unit.id === 'unit-a');
    expect(unitA?.before).toEqual(rateOfSums(addSums([FIXTURE[0]!.sums.CURRENT_YEAR, FIXTURE[1]!.sums.CURRENT_YEAR]), 'CURRENT_YEAR'));
    expect(unitA?.after).toEqual(unitA?.before);
    expect(result.basis.CARRYOVER.province.before).toEqual(rateOfSums(addSums(FIXTURE.map((each) => each.sums.CARRYOVER)), 'CARRYOVER'));
    expect(result.basis.CURRENT_YEAR.projects).toEqual([]);
    expect(result.warnings).toEqual([{ basis: 'CARRYOVER', code: 'ZERO_DENOMINATOR', projectId: null }]);
  });

  it('a move between two units changes only those two units, and the rate of the province on the whole plan does not move because the total of the plan does not', () => {
    const result = simulateReallocation({ projects: FIXTURE, moves: [move()] });
    const year = result.basis.CURRENT_YEAR;
    expect(year.province.before.rateTotalPct).toBe(year.province.after.rateTotalPct);
    expect(year.province.after.planTotalVnd).toBe('2000000000');
    const unitA = year.units.find((unit) => unit.id === 'unit-a');
    const unitB = year.units.find((unit) => unit.id === 'unit-b');
    expect(unitA?.before.planTotalVnd).toBe('1600000000');
    expect(unitA?.after.planTotalVnd).toBe('1300000000');
    expect(unitB?.after.planTotalVnd).toBe('700000000');
    expect(unitA?.after.rateTotalPct).toBe('38.4615');
    expect(unitA?.deltaRateTotalPct).toBe('7.2115');
    expect(unitB?.after.rateTotalPct).toBe('60.0000');
    expect(unitB?.deltaRateTotalPct).toBe('-45.0000');
    expect(year.projects.map((each) => each.id)).toEqual(['p1', 'p3']);
  });

  it('a move inside one unit leaves the rates of that unit and of the province unchanged and changes the two projects', () => {
    const result = simulateReallocation({ projects: FIXTURE, moves: [move({ toProjectId: 'p2', amountVnd: '100000000' })] });
    const year = result.basis.CURRENT_YEAR;
    expect(year.units.every((unit) => unit.deltaRateTotalPct === '0.0000')).toBe(true);
    expect(year.province.deltaRateTotalPct).toBe('0.0000');
    expect(year.projects.map((each) => [each.id, each.after.planTotalVnd])).toEqual([['p1', '900000000'], ['p2', '700000000']]);
  });

  it('a move of the local part reaches the local denominator only, and the rate on the plan of the Prime Minister keeps its denominator', () => {
    const result = simulateReallocation({ projects: FIXTURE, moves: [move({ fromProjectId: 'p2', toProjectId: 'p3', amountVnd: '50000000', split: 'LOCAL' })] });
    const p2 = result.basis.CURRENT_YEAR.projects.find((each) => each.id === 'p2');
    expect(p2?.after).toMatchObject({ planPmVnd: '500000000', planLocalVnd: '50000000' });
    expect(p2?.deltaRatePmPct).toBe('0.0000');
  });

  it('a move of the carried-over capital reaches only that basis; a move in a bucket that has no rate is reported, never dropped in silence', () => {
    const carried = [project('p1', 'unit-a', sums('100', '0', '10'), sums('800', '0', '100')), project('p3', 'unit-b', sums('100', '0', '10'), sums('200', '0', '150'))];
    const result = simulateReallocation({ projects: carried, moves: [move({ bucket: 'CARRYOVER', amountVnd: '300' }), move({ bucket: 'OTHER', amountVnd: '5' })] });
    expect(result.basis.CARRYOVER.projects.map((each) => each.after.planTotalVnd)).toEqual(['500', '500']);
    expect(result.basis.CURRENT_YEAR.projects.map((each) => each.after.planTotalVnd)).toEqual(['100', '100']);
    expect(result.warnings).toContainEqual({ code: 'MOVE_OUTSIDE_RATES', projectId: 'p1', basis: null });
  });

  it('a plan that would end below zero is clamped and told; a project that is not in the basis is told', () => {
    const result = simulateReallocation({ projects: FIXTURE, moves: [move({ amountVnd: '2000000000' }), move({ toProjectId: 'ghost', amountVnd: '1' })] });
    expect(result.warnings.some((warning) => warning.code === 'PLAN_BELOW_ZERO' && warning.projectId === 'p1')).toBe(true);
    expect(result.warnings).toContainEqual({ code: 'UNKNOWN_PROJECT', projectId: 'ghost', basis: null });
  });

  it('a rate with no plan to divide by stays null with its reason after the move, it is never turned into zero', () => {
    const result = simulateReallocation({ projects: [project('p1', 'unit-a', sums('0', '0', null, { allNone: true }))], moves: [] });
    expect(result.basis.CURRENT_YEAR.province.after).toMatchObject({ rateTotalPct: null, rateNullReason: 'ZERO_DENOMINATOR' });
    expect(result.basis.CURRENT_YEAR.province.deltaRateTotalPct).toBeNull();
    expect(result.warnings).toContainEqual({ code: 'ZERO_DENOMINATOR', projectId: null, basis: 'CURRENT_YEAR' });
  });

  it('the difference of two rates is signed, to four decimals, and null when either is missing', () => {
    expect(rateDelta('48.0000', '52.5000')).toBe('4.5000');
    expect(rateDelta('48.0000', '47.9999')).toBe('-0.0001');
    expect(rateDelta('48.0000', '48.0000')).toBe('0.0000');
    expect(rateDelta(null, '1.0000')).toBeNull();
  });
});

describe('the projected year end before and after the move', () => {
  const inputs = [
    { projectId: 'p1', planTotalVnd: '1000000000', eacVnd: '400000000' },
    { projectId: 'p3', planTotalVnd: '400000000', eacVnd: '700000000' },
    { projectId: 'nodata', planTotalVnd: '100', eacVnd: null },
  ];

  it('moves the unused plan of a slow project to a fast one: the demand above the plan is funded, the donor is capped by its smaller plan', () => {
    const result = projectedImpact(inputs, [move()], { absorption_pct: 100 });
    expect(result.before).toMatchObject({ planTotalVnd: '1400000000', disbursedVnd: '800000000', ratePct: '57.1429', projects: 2 });
    expect(result.after).toMatchObject({ planTotalVnd: '1400000000', disbursedVnd: '1100000000', ratePct: '78.5714' });
    expect(result.deltaRatePct).toBe('21.4285');
    expect(result.excludedProjects).toBe(1);
  });

  it('a donor whose projection is above its new plan loses the difference, and the absorption of the recipient scales what it gains', () => {
    const tight = [
      { projectId: 'p1', planTotalVnd: '1000000000', eacVnd: '900000000' },
      { projectId: 'p3', planTotalVnd: '400000000', eacVnd: '700000000' },
    ];
    const half = projectedImpact(tight, [move()], { absorption_pct: 50 });
    expect(half.after.disbursedVnd).toBe((700000000 + 400000000 + 150000000).toString());
    const full = projectedImpact(tight, [move()], { absorption_pct: 100 });
    expect(full.after.disbursedVnd).toBe((700000000 + 400000000 + 300000000).toString());
    expect(full.before.disbursedVnd).toBe((900000000 + 400000000).toString());
  });

  it('with no move the projection does not change', () => {
    const result = projectedImpact(inputs, [], { absorption_pct: 100 });
    expect(result.after).toEqual(result.before);
    expect(result.deltaRatePct).toBe('0.0000');
  });

  it('is part of the simulation only when the estimates are given, and says when there is nothing to project', () => {
    expect(simulateReallocation({ projects: FIXTURE, moves: [] }).projected).toBeNull();
    const empty = simulateReallocation({ projects: FIXTURE, moves: [], projections: [{ projectId: 'p1', planTotalVnd: '1', eacVnd: null }] });
    expect(empty.warnings).toContainEqual({ code: 'NO_PROJECTION_DATA', projectId: null, basis: 'CURRENT_YEAR' });
  });
});

describe('the candidates by performance', () => {
  const policy = reallocationPolicyDefaults();
  const list = [
    { projectId: 'slow', unitId: 'u', planTotalVnd: '1000000000', eacVnd: '400000000', floorVnd: '300000000' },
    { projectId: 'slower', unitId: 'u', planTotalVnd: '2000000000', eacVnd: '200000000', floorVnd: '1950000000' },
    { projectId: 'fast', unitId: 'v', planTotalVnd: '500000000', eacVnd: '900000000', floorVnd: '0' },
    { projectId: 'steady', unitId: 'v', planTotalVnd: '500000000', eacVnd: '450000000', floorVnd: '0' },
    { projectId: 'nodata', unitId: 'v', planTotalVnd: '500000000', eacVnd: null, floorVnd: '0' },
    { projectId: 'noplan', unitId: 'v', planTotalVnd: '0', eacVnd: '5', floorVnd: '0' },
    { projectId: 'tiny', unitId: 'v', planTotalVnd: '100000000', eacVnd: '10000000', floorVnd: '0' },
  ];

  it('picks the donors below the line and the recipients above their plan, slowest and fastest first, and says why the others are left out', () => {
    const result = reallocationCandidates(list, policy);
    expect(result.donors.map((donor) => donor.projectId)).toEqual(['slow']);
    expect(result.donors[0]).toMatchObject({ ratioPct: '40.0000', surplusVnd: '580000000', releasableVnd: '500000000' });
    expect(result.recipients).toEqual([expect.objectContaining({ projectId: 'fast', demandVnd: '400000000', ratioPct: '180.0000' })]);
    expect(result.excluded).toEqual([
      { projectId: 'nodata', reason: 'NO_ESTIMATE' },
      { projectId: 'noplan', reason: 'NO_PLAN' },
      { projectId: 'slower', reason: 'BELOW_MIN_MOVE' },
      { projectId: 'steady', reason: 'WITHIN_RANGE' },
      { projectId: 'tiny', reason: 'BELOW_MIN_MOVE' },
    ]);
  });

  it('a donor keeps what is already spoken for even when its projection is lower, and the order does not depend on the order read', () => {
    const result = reallocationCandidates([...list].reverse(), policy);
    expect(result.donors.map((donor) => donor.projectId)).toEqual(['slow']);
    const floorHigh = reallocationCandidates([{ projectId: 'a', unitId: null, planTotalVnd: '1000000000', eacVnd: '100000000', floorVnd: '950000000' }], policy);
    expect(floorHigh.donors).toEqual([]);
    expect(floorHigh.excluded).toEqual([{ projectId: 'a', reason: 'BELOW_MIN_MOVE' }]);
  });

  it('orders donors slowest first and recipients fastest first, ties by project id', () => {
    const many = [
      { projectId: 'b', unitId: null, planTotalVnd: '1000000000', eacVnd: '500000000', floorVnd: '0' },
      { projectId: 'a', unitId: null, planTotalVnd: '1000000000', eacVnd: '500000000', floorVnd: '0' },
      { projectId: 'c', unitId: null, planTotalVnd: '1000000000', eacVnd: '100000000', floorVnd: '0' },
      { projectId: 'r1', unitId: null, planTotalVnd: '1000000000', eacVnd: '1200000000', floorVnd: '0' },
      { projectId: 'r2', unitId: null, planTotalVnd: '1000000000', eacVnd: '1500000000', floorVnd: '0' },
    ];
    const result = reallocationCandidates(many, policy);
    expect(result.donors.map((donor) => donor.projectId)).toEqual(['c', 'a', 'b']);
    expect(result.recipients.map((recipient) => recipient.projectId)).toEqual(['r2', 'r1']);
  });
});

describe('the policy as a governance rule', () => {
  it('has a built-in default that passes its own schema, is flagged unverified and carries its source', () => {
    const found = builtInDefault('REALLOCATION_POLICY', 'DEFAULT');
    expect(found?.unverified).toBe(true);
    expect(found?.source.length).toBeGreaterThan(10);
    expect(validateRuleParams('REALLOCATION_POLICY', reallocationPolicyDefaults())).toEqual(reallocationPolicyDefaults());
    expect(reallocationPolicyDefaults().donor_max_ratio_pct).toBe(80);
  });

  it('refuses params that do not say all of it, an unknown key, and a recipient line below the donor line', () => {
    const base = { ...reallocationPolicyDefaults() };
    expect(() => validateRuleParams('REALLOCATION_POLICY', { ...base, extra: 1 })).toThrow(expect.objectContaining({ code: 'GOVERNANCE_RULE_PARAMS_INVALID' }));
    expect(() => validateRuleParams('REALLOCATION_POLICY', { ...base, donor_max_ratio_pct: 120 })).toThrow(expect.objectContaining({ code: 'GOVERNANCE_RULE_PARAMS_INVALID' }));
    expect(() => reallocationPolicyOf({ ...base, recipient_min_ratio_pct: 50 })).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(() => reallocationPolicyOf({ ...base, delegation_document_type: 'bad type' })).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(() => reallocationPolicyOf(null)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });
});
