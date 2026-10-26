/**
 * The golden fixtures of DIS (ST-DIS-011, DIS 3 §5): the synthetic cases whose expected numbers the capital business owner is asked to sign in the session D03. They are data, not code: the golden
 * suite of the kernel reads them and computes each case with the formulas of the product; the screen DIS-25 shows them. Until D03 is signed every figure here is a proposal (CXN-03), the suite is labelled so
 * and still fails the build when a proposed number regresses.
 */
export const DIS_GOLDEN_STATUS = 'PROPOSED_PENDING_SIGNOFF';
export const DIS_GOLDEN_SESSION = 'D03';

/** The glossary domain whose terms the formulas of the snapshots and the rates are defined by (the terms are those of ST-MDM-008): a snapshot says its definitions are signed only when every one of them is published. */
export const DIS_GLOSSARY_DOMAIN = 'DISBURSEMENT';

export interface GoldenCell {
  bucket: 'CURRENT_YEAR' | 'CARRYOVER' | 'OTHER';
  budget_level: 'CENTRAL' | 'LOCAL';
  cumulative_vnd: string;
  ctmtqg_subset_vnd?: string;
}

export interface GoldenTransaction {
  id: string;
  amount_vnd: string;
  paid_on: string;
  refund?: boolean;
}

export interface GoldenUnit {
  code: string;
  plan_vnd: string;
  disbursed_vnd: string;
}

/** A case: what is given, and the numbers expected of it. Each case has the rule it proves (BR-DIS-nn) and the acceptance test of the plan. */
export type GoldenFixture =
  | { id: 'FX-DIS-001'; rule: 'BR-DIS-01'; test: 'UAT-AC240'; title: string; given: { cells: GoldenCell[] }; expected: { total_vnd: string; ctmtqg_vnd: string } }
  | { id: 'FX-DIS-002'; rule: 'BR-DIS-02, BR-DIS-03'; test: 'UAT-AC241'; title: string; given: { earlier_cumulative_vnd: string; later_cumulative_vnd: string }; expected: { cumulative_vnd: string; delta_vnd: string; not_the_sum_vnd: string } }
  | { id: 'FX-DIS-003'; rule: 'BR-DIS-04'; test: 'UAT-AC242'; title: string; given: { projects: Array<{ numerator_vnd: string; plan_pm_vnd: string }> }; expected: { unit_rate_pm_pct: string; project_rates_pm_pct: string[] } }
  | { id: 'FX-DIS-004'; rule: 'BR-DIS-05'; test: 'UAT-AC243'; title: string; given: { plan_pm_vnd: string; plan_local_vnd: string; numerator_vnd: string }; expected: { rate_pm_pct: string; rate_total_pct: string } }
  | { id: 'FX-DIS-005'; rule: 'BR-DIS-06'; test: 'UAT-AC244'; title: string; given: { cutoff: string; transactions: GoldenTransaction[] }; expected: { disbursed_vnd: string; excluded: string[] } }
  | { id: 'FX-DIS-006'; rule: 'BR-DIS-07'; test: 'UAT-AC240'; title: string; given: { cell: GoldenCell }; expected: { code: 'SUBSET_EXCEEDS_PARENT'; status: 422; field: string } }
  | { id: 'FX-DIS-007'; rule: 'BR-DIS-10'; test: 'UAT-AC254'; title: string; given: { minimum_plan_vnd: string; units: GoldenUnit[] }; expected: { ranked: Array<{ rank: number; code: string; rate_pct: string }>; excluded: Array<{ code: string; reason: 'PLAN_BELOW_MINIMUM' | 'ZERO_DENOMINATOR' }> } };

export const DIS_GOLDEN: readonly GoldenFixture[] = [
  {
    id: 'FX-DIS-001',
    rule: 'BR-DIS-01',
    test: 'UAT-AC240',
    title: 'Six source cells add up to 420 million; the CTMTQG of 40 million is part of a cell and is not added',
    given: {
      cells: [
        { bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', cumulative_vnd: '100000000', ctmtqg_subset_vnd: '40000000' },
        { bucket: 'CURRENT_YEAR', budget_level: 'LOCAL', cumulative_vnd: '200000000' },
        { bucket: 'CARRYOVER', budget_level: 'CENTRAL', cumulative_vnd: '30000000' },
        { bucket: 'CARRYOVER', budget_level: 'LOCAL', cumulative_vnd: '70000000' },
        { bucket: 'OTHER', budget_level: 'CENTRAL', cumulative_vnd: '0' },
        { bucket: 'OTHER', budget_level: 'LOCAL', cumulative_vnd: '20000000' },
      ],
    },
    expected: { total_vnd: '420000000', ctmtqg_vnd: '40000000' },
  },
  {
    id: 'FX-DIS-002',
    rule: 'BR-DIS-02, BR-DIS-03',
    test: 'UAT-AC241',
    title: 'The cumulative of week 40 is 150 million, not the 250 million of the two weeks added; the change of the period is 50 million',
    given: { earlier_cumulative_vnd: '100000000', later_cumulative_vnd: '150000000' },
    expected: { cumulative_vnd: '150000000', delta_vnd: '50000000', not_the_sum_vnd: '250000000' },
  },
  {
    id: 'FX-DIS-003',
    rule: 'BR-DIS-04',
    test: 'UAT-AC242',
    title: 'The rate of a unit is the sum of the numerators over the sum of the denominators: 50/100 and 90/900 million are 14%, not the mean of 50% and 10%',
    given: {
      projects: [
        { numerator_vnd: '50000000', plan_pm_vnd: '100000000' },
        { numerator_vnd: '90000000', plan_pm_vnd: '900000000' },
      ],
    },
    expected: { unit_rate_pm_pct: '14.0000', project_rates_pm_pct: ['50.0000', '10.0000'] },
  },
  {
    id: 'FX-DIS-004',
    rule: 'BR-DIS-05',
    test: 'UAT-AC243',
    title: 'One numerator of 600 million is 60% of the plan of 1 billion given by the Prime Minister and 48% of the plan of 1.25 billion with the local addition',
    given: { plan_pm_vnd: '1000000000', plan_local_vnd: '250000000', numerator_vnd: '600000000' },
    expected: { rate_pm_pct: '60.0000', rate_total_pct: '48.0000' },
  },
  {
    id: 'FX-DIS-005',
    rule: 'BR-DIS-06',
    test: 'UAT-AC244',
    title: 'With the cutoff on 30 September the 500 million paid that day counts and the 300 million paid on 1 October does not',
    given: {
      cutoff: '2026-09-30',
      transactions: [
        { id: 'T1', amount_vnd: '500000000', paid_on: '2026-09-30' },
        { id: 'T2', amount_vnd: '300000000', paid_on: '2026-10-01' },
      ],
    },
    expected: { disbursed_vnd: '500000000', excluded: ['T2'] },
  },
  {
    id: 'FX-DIS-006',
    rule: 'BR-DIS-07',
    test: 'UAT-AC240',
    title: 'A CTMTQG of 120 million inside a cell of 100 million is refused: the subset cannot pass its parent',
    given: { cell: { bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', cumulative_vnd: '100000000', ctmtqg_subset_vnd: '120000000' } },
    expected: { code: 'SUBSET_EXCEEDS_PARENT', status: 422, field: 'funding_lines[0].ctmtqg_subset_vnd' },
  },
  {
    id: 'FX-DIS-007',
    rule: 'BR-DIS-10',
    test: 'UAT-AC254',
    title: 'Three units are ranked by rate, a tie goes to the larger disbursement, and the unit with a plan below the minimum is left out with its reason',
    given: {
      minimum_plan_vnd: '1000000000',
      units: [
        { code: 'U-A', plan_vnd: '2000000000', disbursed_vnd: '1200000000' },
        { code: 'U-B', plan_vnd: '1000000000', disbursed_vnd: '600000000' },
        { code: 'U-C', plan_vnd: '500000000', disbursed_vnd: '400000000' },
      ],
    },
    expected: {
      ranked: [
        { rank: 1, code: 'U-A', rate_pct: '60.0000' },
        { rank: 2, code: 'U-B', rate_pct: '60.0000' },
      ],
      excluded: [{ code: 'U-C', reason: 'PLAN_BELOW_MINIMUM' }],
    },
  },
];
