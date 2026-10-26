import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIS_GLOSSARY_DOMAIN, DIS_GOLDEN, DIS_GOLDEN_SESSION, DIS_GOLDEN_STATUS } from '@machvon/contracts';
import type { GoldenFixture } from '@machvon/contracts';
import { DomainError, addSums, fundingCells, fundingTotals, periodDeltaOf, rankUnits, rateOfSums, ratesOf, treasuryDisbursed } from '@machvon/kernel';

/**
 * The golden suite of DIS (ST-DIS-011): every case is read from the fixture file of the contracts and computed with the formulas of the product, and the expected numbers are those of the file, not
 * copies of them. The numbers are proposals until the capital business owner signs D03 (CXN-03): the suite says so in its name, it does not gate the sign-off, and it still fails the build when a proposed number moves.
 */
const LABEL = `[CHỜ KÝ ${DIS_GOLDEN_SESSION}]`;
const fixture = <Id extends GoldenFixture['id']>(id: Id): Extract<GoldenFixture, { id: Id }> => DIS_GOLDEN.find((item) => item.id === id) as Extract<GoldenFixture, { id: Id }>;
const sumsOf = (numeratorVnd: string, planPmVnd: string) => ({ projects: 1, planPmVnd, planLocalVnd: '0', treasuryVnd: numeratorVnd, reportedVnd: null, ctmtqgVnd: null, allNone: false, allComplete: true });

const PACK = join(__dirname, '..', '..', '..', '..', 'docs', 'dis-d03-signoff-pack.md');

describe(`${LABEL} golden fixtures FX-DIS-001..007 (ST-DIS-011)`, () => {
  it('carries all seven fixtures, each once, with the rule it proves and the test of the plan, and every one is a proposal awaiting the sign-off', () => {
    expect(DIS_GOLDEN.map((item) => item.id)).toEqual(['FX-DIS-001', 'FX-DIS-002', 'FX-DIS-003', 'FX-DIS-004', 'FX-DIS-005', 'FX-DIS-006', 'FX-DIS-007']);
    for (const item of DIS_GOLDEN) {
      expect(item.rule).toMatch(/^BR-DIS-\d\d/);
      expect(item.test).toMatch(/^UAT-AC\d+$/);
      expect(item.title.length).toBeGreaterThan(20);
    }
    expect(DIS_GOLDEN_STATUS).toBe('PROPOSED_PENDING_SIGNOFF');
    expect(DIS_GLOSSARY_DOMAIN).toBe('DISBURSEMENT');
  });

  it(`${LABEL} AC-ST-DIS-011-2 / FX-DIS-001 / UAT-AC240: the six cells are 420 million and the CTMTQG of 40 million is apart, never added`, () => {
    const { given, expected } = fixture('FX-DIS-001');
    const totals = fundingTotals(fundingCells(given.cells));
    expect(totals.cumulativeVnd).toBe(expected.total_vnd);
    expect(totals.ctmtqgVnd).toBe(expected.ctmtqg_vnd);
  });

  it(`${LABEL} FX-DIS-002 / UAT-AC241: the cumulative is that of the accepted report of the period (150 million), never the two periods added (250), and the change is 50 million`, () => {
    const { given, expected } = fixture('FX-DIS-002');
    expect(given.later_cumulative_vnd).toBe(expected.cumulative_vnd);
    expect((BigInt(given.earlier_cumulative_vnd) + BigInt(given.later_cumulative_vnd)).toString()).toBe(expected.not_the_sum_vnd);
    expect(periodDeltaOf([(BigInt(given.later_cumulative_vnd) - BigInt(given.earlier_cumulative_vnd)).toString()])).toBe(expected.delta_vnd);
  });

  it(`${LABEL} FX-DIS-003 / UAT-AC242: the rate of the unit is the sum of the numerators over the sum of the denominators (14%) and each project has its own`, () => {
    const { given, expected } = fixture('FX-DIS-003');
    const projects = given.projects.map((project) => sumsOf(project.numerator_vnd, project.plan_pm_vnd));
    expect(rateOfSums(addSums(projects), 'CURRENT_YEAR').ratePmPct).toBe(expected.unit_rate_pm_pct);
    expect(projects.map((project) => rateOfSums(project, 'CURRENT_YEAR').ratePmPct)).toEqual(expected.project_rates_pm_pct);
  });

  it(`${LABEL} FX-DIS-004 / UAT-AC243: one numerator, 60% of the plan of the Prime Minister and 48% of the plan with the local addition`, () => {
    const { given, expected } = fixture('FX-DIS-004');
    const rates = ratesOf({ disbursedVnd: given.numerator_vnd, planPmVnd: given.plan_pm_vnd, planLocalVnd: given.plan_local_vnd, coverage: 'COMPLETE' });
    expect(rates).toEqual({ ratePmPct: expected.rate_pm_pct, rateTotalPct: expected.rate_total_pct, nullReason: null });
  });

  it(`${LABEL} FX-DIS-005 / UAT-AC244: the payment of the cutoff day counts and the one of the day after does not`, () => {
    const { given, expected } = fixture('FX-DIS-005');
    const entries = given.transactions.map((transaction) => ({ amountVnd: transaction.amount_vnd, reversal: transaction.refund === true, paidOn: transaction.paid_on }));
    expect(treasuryDisbursed(entries, given.cutoff)?.totalVnd).toBe(expected.disbursed_vnd);
    const counted = given.transactions.filter((transaction) => transaction.paid_on <= given.cutoff).map((transaction) => transaction.id);
    expect(given.transactions.map((transaction) => transaction.id).filter((id) => !counted.includes(id))).toEqual(expected.excluded);
  });

  it(`${LABEL} FX-DIS-006: a CTMTQG of 120 million in a cell of 100 million is refused on the CTMTQG field`, () => {
    const { given, expected } = fixture('FX-DIS-006');
    let refusal: DomainError | undefined;
    try {
      fundingCells([given.cell]);
    } catch (error) {
      refusal = error as DomainError;
    }
    expect(refusal).toBeInstanceOf(DomainError);
    expect([refusal?.code, refusal?.status, refusal?.detail]).toEqual([expected.code, expected.status, expected.field]);
  });

  it(`${LABEL} FX-DIS-007 / UAT-AC254: ranks by rate, breaks the tie by the larger disbursement, and leaves out the unit below the minimum plan with its reason`, () => {
    const { given, expected } = fixture('FX-DIS-007');
    const ranking = rankUnits(
      given.units.map((unit) => ({ code: unit.code, planVnd: unit.plan_vnd, disbursedVnd: unit.disbursed_vnd })),
      given.minimum_plan_vnd,
    );
    expect(ranking.ranked.map((unit) => ({ rank: unit.rank, code: unit.code, rate_pct: unit.ratePct }))).toEqual(expected.ranked);
    expect(ranking.excluded).toEqual(expected.excluded);
  });

  it(`${LABEL} AC-ST-DIS-011-1: the sign-off pack for the capital owner lists every fixture with its given and expected numbers, as the file of the fixtures has them`, () => {
    const pack = readFileSync(PACK, 'utf8');
    for (const item of DIS_GOLDEN) {
      expect(pack).toContain(`### ${item.id}: ${item.title}`);
      expect(pack).toContain(JSON.stringify(item.given));
      expect(pack).toContain(JSON.stringify(item.expected));
    }
    expect(pack).toContain('PROPOSED_PENDING_SIGNOFF');
  });
});
