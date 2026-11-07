import { DEFAULT_RULE_CODE, defaultMoneyRule, parseMoneyRuleParams } from '@machvon/kernel';
import type { MoneyRuleReading, MoneyRuleType } from '@machvon/kernel';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * What the governance platform gives for a rule in force: the approved parameters and the version of the rule they came from. `undefined` when the tenant approved no rule of the type and code
 * on the day: the built-in default applies then.
 */
export type ApprovedRuleSource = (tx: TenantTx, type: MoneyRuleType, code: string, asOf: string) => Promise<{ params: unknown; version: number } | undefined>;

/**
 * The source the money control reads through unless a caller gives its own: the governance platform (`GovernancePolicyPort.get`, an approved `governance_rule` version in force on the day). A built-in
 * default of the platform is not an approved rule, so it answers `undefined` and the reader gives the default of the lane (version null, source DEFAULT): the version stored on a decision is then
 * the one of a rule somebody approved, never the number 0 of a starting value.
 */
export const governancePortSource = (port: GovernancePolicyPort = new GovernancePolicyPort()): ApprovedRuleSource => async (tx, type, code, asOf) => {
  const found = await port.get(tx, type, code, asOf);
  return found === undefined || found.source === 'DEFAULT' ? undefined : { params: found.params, version: found.version };
};

/**
 * The thresholds of the money control as the lane reads them (governance deepening, lane B2). The shape is the one of `GovernancePolicyPort.get(tx, type, code, asOf)`: the reading carries the version
 * of the rule that decided, which the decisions that used it keep (a change order keeps the version that gave its tier). Without a `source` the reader asks the governance port (`governancePortSource`); a tenant
 * that approved no rule gets the built-in default, and the reading says so.
 */
export class MoneyPolicyReader {
  private readonly source: ApprovedRuleSource;

  constructor(source: ApprovedRuleSource = governancePortSource()) {
    this.source = source;
  }

  async get<K extends MoneyRuleType>(tx: TenantTx, type: K, asOf: string, code: string = DEFAULT_RULE_CODE): Promise<MoneyRuleReading<K>> {
    const approved = await this.source(tx, type, code, asOf);
    if (approved === undefined) return defaultMoneyRule(type, code);
    // The parameters of an approved rule are judged again as they are read: a rule that cannot be understood is never half applied.
    return { type, code, version: approved.version, source: 'RULE', params: parseMoneyRuleParams(type, approved.params) };
  }
}
