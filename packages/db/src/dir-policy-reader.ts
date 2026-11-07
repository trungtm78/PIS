import { DIRECTIVE_POLICY_DEFAULT_CODE, defaultDirectivePolicy, parseDirectivePolicy } from '@machvon/kernel';
import type { DirectivePolicyReading } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

/**
 * What the governance platform gives for a rule in force: the approved parameters and the version of the rule they came from. `undefined` when the tenant approved no rule of the type and code on
 * the day: the built-in default applies then. The shape is the one of `GovernancePolicyPort.get(tx, type, code, asOf)` (it answers with `params` and `version`).
 */
export type ApprovedDirectiveRuleSource = (tx: TenantTx, type: 'DIRECTIVE_POLICY', code: string, asOf: string) => Promise<{ params: unknown; version: number } | undefined>;

/**
 * The thresholds of the directives as the lane reads them (governance deepening, lane DIR-1): the reminder days (T-3, T-1, T+0), the days overdue after which a directive is urgent and goes to the head of the
 * unit, how often and how far the due day may move, and whether closing needs evidence. The reading carries the version of the rule that decided, which a decision that used it keeps. The type
 * `DIRECTIVE_POLICY` is not yet one of the kinds of `GovernancePolicyPort` (the list is closed until lane A1 opens it): until then every read gives the built-in default, and wiring the port is passing its
 * `get` as the `source` of the constructor, and nothing else changes.
 */
export class DirectivePolicyReader {
  private readonly source: ApprovedDirectiveRuleSource | undefined;

  constructor(source?: ApprovedDirectiveRuleSource) {
    this.source = source;
  }

  async get(tx: TenantTx, asOf: string, code: string = DIRECTIVE_POLICY_DEFAULT_CODE): Promise<DirectivePolicyReading> {
    const approved = this.source === undefined ? undefined : await this.source(tx, 'DIRECTIVE_POLICY', code, asOf);
    if (approved === undefined) return defaultDirectivePolicy(code);
    // The parameters of an approved rule are judged again as they are read: a rule that cannot be understood is never half applied.
    return { type: 'DIRECTIVE_POLICY', code, version: approved.version, source: 'RULE', params: parseDirectivePolicy(approved.params) };
  }
}
