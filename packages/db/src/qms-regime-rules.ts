import { DomainError, INSPECTION_TYPES, SIGNER_ROLES } from '@machvon/kernel';
import type { ChecklistItem, InspectionType, RegimeRule, SignerRole } from '@machvon/kernel';
import { MasterRules } from './master-rules.ts';
import type { RuleReading } from './master-rules.ts';
import type { TenantTx } from './tenant-database.ts';

/** The type of the rule data of the regimes of quality management (`master_record.master_type`). */
export const REGIME_RULE_TYPE = 'QMS_REGIME';

/** The regime in force on a day as the rule data states it, with where the rule comes from: what an inspection stores of it and what a screen says of it. */
export interface ResolvedRegime {
  rule: RegimeRule;
  reading: RuleReading;
}

const roles = (value: unknown): SignerRole[] => (Array.isArray(value) ? value.filter((role): role is SignerRole => (SIGNER_ROLES as readonly string[]).includes(role as string)) : []);

function ruleOf(reading: RuleReading): RegimeRule {
  const { required_roles: required, completion_required_roles: completion, checklists } = reading.attributes;
  const requiredRoles = roles(required);
  // The rule was checked when it was published; a rule that does not read here is a defect of the data, never an answer to the caller.
  if (requiredRoles.length === 0 || !Array.isArray(checklists)) throw new Error(`the regime rule ${reading.businessKey} cannot be read`);
  const byType: Partial<Record<InspectionType, ChecklistItem[]>> = {};
  for (const entry of checklists as Array<{ inspection_type?: string; items?: Array<{ code: string; label: string }> }>) {
    const type = INSPECTION_TYPES.find((candidate) => candidate === entry.inspection_type);
    if (type !== undefined) byType[type] = (entry.items ?? []).map((item) => ({ code: item.code, label: item.label }));
  }
  const completionRoles = roles(completion);
  return { requiredRoles, completionRequiredRoles: completionRoles.length === 0 ? requiredRoles : completionRoles, checklists: byType };
}

/**
 * The regimes of quality management as rule data (BR-QMS-04, rule type QMS_REGIME of MDM): the regime whose dates contain the day of the request decides the roles that sign the minutes and
 * the checklist, and an inspection keeps the version of the rule it was given. No regime in force on the day is 422 REGIME_NOT_EFFECTIVE: the platform never picks a regime for a day it
 * does not cover.
 */
export class QmsRegimeRules {
  private readonly rules: MasterRules;

  constructor(rules: MasterRules = new MasterRules()) {
    this.rules = rules;
  }

  /** The regime in force on `asOf`; 422 REGIME_NOT_EFFECTIVE when none is. */
  async at(tx: TenantTx, asOf: string): Promise<ResolvedRegime> {
    const reading = await this.rules.regimeAt(tx, asOf);
    if (reading === undefined) throw new DomainError('REGIME_NOT_EFFECTIVE', 422, 'requested_for');
    return { rule: ruleOf(reading), reading };
  }
}
