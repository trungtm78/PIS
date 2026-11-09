import { fundingRatioOf } from '@machvon/kernel';
import type { EnterpriseFigureReader, ReaderScope } from '@machvon/kernel';

/** The measure the funding structure is told in: what was paid (the measure the rates of the leader board use). */
export const STRUCTURE_MEASURE = 'DISBURSED' as const;

/** One class of the funding taxonomy of the enterprise pack (equity, loan, other) as the structure shows it. */
export interface StructureClass {
  classCode: string;
  /** The year plan in force of the class, whole dong; null when no project of the scope has a plan in this class (never 0). */
  planVnd: string | null;
  /** Disbursed since the start of the year, whole dong; null when nobody has the figure. */
  disbursedVnd: string | null;
  /** The class over the sum of the classes, on the plan in force and on the disbursed figure; percent with four places, null with a reason. */
  planSharePct: string | null;
  disbursedSharePct: string | null;
  /** Disbursed over plan of the class itself. */
  ratePct: string | null;
  nullReason: string | null;
}

export interface FundingStructure {
  measure: typeof STRUCTURE_MEASURE;
  planTotalVnd: string | null;
  disbursedTotalVnd: string | null;
  classes: StructureClass[];
}

/**
 * The funding structure of a frozen enterprise snapshot, from the classes of its taxonomy pack (FND-1: equity, loan, other) through the one reader (R21): the plan in force and the disbursed figure of each additive class,
 * the share of each class in the whole on both, and the rate of the class against its own plan. `scope` is the projects the reader may read (`{}` for the whole tenant). The pack decides the classes and their order; a
 * class nobody has a figure for is null in every field and never 0.
 */
export function structureOf(reader: EnterpriseFigureReader, scope: ReaderScope): FundingStructure {
  const classes = reader.view.pack.classes.filter((one) => one.additive);
  const planOf = (classCode: string): string | null => reader.amountOf(scope, STRUCTURE_MEASURE, 'PLAN_IN_FORCE', classCode);
  const paidOf = (classCode: string): string | null => reader.amountOf(scope, STRUCTURE_MEASURE, 'CUMULATIVE_YTD', classCode);
  const sum = (values: ReadonlyArray<string | null>): string | null => {
    const known = values.filter((value): value is string => value !== null);
    return known.length === 0 ? null : known.reduce((total, value) => total + BigInt(value), 0n).toString();
  };
  const planTotal = sum(classes.map((one) => planOf(one.code)));
  const paidTotal = sum(classes.map((one) => paidOf(one.code)));
  return {
    measure: STRUCTURE_MEASURE,
    planTotalVnd: planTotal,
    disbursedTotalVnd: paidTotal,
    classes: classes.map((one) => {
      const plan = planOf(one.code);
      const paid = paidOf(one.code);
      const own = fundingRatioOf(paid, plan);
      return {
        classCode: one.code,
        planVnd: plan,
        disbursedVnd: paid,
        planSharePct: fundingRatioOf(plan, planTotal).ratePct,
        disbursedSharePct: fundingRatioOf(paid, paidTotal).ratePct,
        ratePct: own.ratePct,
        nullReason: own.nullReason,
      };
    }),
  };
}
