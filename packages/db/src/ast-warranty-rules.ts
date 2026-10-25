import { CONSTRUCTION_GRADES, DomainError, minimumMonths } from '@machvon/kernel';
import type { ConstructionGrade, WarrantyMinimums } from '@machvon/kernel';
import { MasterRules } from './master-rules.ts';
import type { RuleReading } from './master-rules.ts';
import type { TenantTx } from './tenant-database.ts';

/** The type of the rule data of the minimum terms of the warranty (`master_record.master_type`). */
export const WARRANTY_RULE_TYPE = 'AST_WARRANTY';

/** The minimum term that decided, with the version of the rule it comes from: what an obligation stores of it and what a screen says of it. */
export interface ResolvedWarrantyRule {
  minimumMonths: number;
  reading: RuleReading;
}

function monthsOf(reading: RuleReading): number {
  const months = reading.attributes.min_months;
  // The rule was checked when it was published; a rule that does not read here is a defect of the data, never an answer to the caller.
  if (!Number.isInteger(months) || (months as number) < 1) throw new Error(`the warranty rule ${reading.businessKey} cannot be read`);
  return months as number;
}

/**
 * The minimum term of the warranty as rule data (BR-AST-03, rule type AST_WARRANTY of MDM): the rule in force on the day an obligation is created states, for the grade of the work, the shortest
 * term, and the obligation keeps the version of the rule it was judged by. A work whose grade is not stated is held to the longest minimum there is. No rule in force is 422
 * NO_EFFECTIVE_RULE: the platform never judges a term by a number it made up.
 */
export class AstWarrantyRules {
  private readonly rules: MasterRules;

  constructor(rules: MasterRules = new MasterRules()) {
    this.rules = rules;
  }

  /** The minimum term for the grade (or the longest one when it is null) in force on `asOf`; 422 NO_EFFECTIVE_RULE when the rule data states none. */
  async resolve(tx: TenantTx, grade: ConstructionGrade | null, asOf: string): Promise<ResolvedWarrantyRule> {
    const wanted = grade === null ? CONSTRUCTION_GRADES : [grade];
    const readings = new Map<ConstructionGrade, RuleReading>();
    for (const candidate of wanted) {
      const reading = await this.rules.read(tx, WARRANTY_RULE_TYPE, candidate, asOf);
      if (reading !== undefined) readings.set(candidate, reading);
    }
    const minimums: WarrantyMinimums = {};
    for (const [candidate, reading] of readings) minimums[candidate] = monthsOf(reading);
    const months = minimumMonths(minimums, grade);
    const decisive = months === undefined ? undefined : wanted.find((candidate) => minimums[candidate] === months);
    const reading = decisive === undefined ? undefined : readings.get(decisive);
    if (months === undefined || reading === undefined) throw new DomainError('NO_EFFECTIVE_RULE', 422, 'construction_grade');
    return { minimumMonths: months, reading };
  }
}
