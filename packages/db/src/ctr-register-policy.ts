import { CLAIM_POLICY_DEFAULT_CODE, CLAIM_POLICY_RULE_TYPE, CLAIM_TERM_TEMPLATE_RULE_TYPE, EARLY_WARNING_POLICY_DEFAULT_CODE, EARLY_WARNING_POLICY_RULE_TYPE, parseClaimPolicy, parseEarlyWarningPolicy } from '@machvon/kernel';
import type { BarEffect, ClaimPolicy, EarlyWarningPolicy, ParticularsFrom, ClaimPeriodBasis, ResolvedGovernanceRule } from '@machvon/kernel';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import type { TenantTx } from './tenant-database.ts';

/** Where the numbers of a policy come from, as the screen shows them behind an "i": the rule that decided (a version of the tenant, else the built-in default), its formula, source, day and whether anybody confirmed it. */
export interface PolicyBasis {
  source: ResolvedGovernanceRule['source'];
  version: number;
  unverified: boolean;
  formula: string | null;
  sourceText: string | null;
  asOf: string | null;
  legalStatus: string | null;
}

export interface PolicyReading<T> {
  params: T;
  basis: PolicyBasis;
}

const basisOf = (rule: ResolvedGovernanceRule): PolicyBasis => ({
  source: rule.source,
  version: rule.version,
  unverified: rule.unverified,
  formula: rule.provenance?.formula ?? null,
  sourceText: rule.provenance?.source ?? null,
  asOf: rule.provenance?.asOf ?? null,
  legalStatus: rule.provenance?.legalStatus ?? null,
});

/** A template of a claim term as the proposal screen offers it: the numbers of an example term, flagged unverified, never applied by itself. */
export interface ClaimTermTemplate {
  code: string;
  noticeDays: number | null;
  particularsDays: number | null;
  responseDays: number | null;
  settlementDays: number | null;
  basis: ClaimPeriodBasis;
  particularsFrom: ParticularsFrom;
  barEffect: BarEffect;
  basisOf: PolicyBasis;
}

const periodOf = (value: unknown): number | null => (typeof value === 'number' ? value : null);

/**
 * The working numbers of the claim register and of the early-warning register of a contract, read through the governance port (G0-1): a tenant that approved its own rule gets it, any other the built-in default
 * with its source and its flag "not confirmed". Nothing is a constant of a controller, a screen or a store. The templates of a claim term are rules too (`CLAIM_TERM_TEMPLATE`): a person may copy one
 * into a proposal, and the register never applies one to a contract.
 */
export class CtrRegisterPolicy {
  private readonly port: GovernancePolicyPort;

  constructor(port: GovernancePolicyPort = new GovernancePolicyPort()) {
    this.port = port;
  }

  async claim(tx: TenantTx, asOf: string | Date): Promise<PolicyReading<ClaimPolicy>> {
    const rule = await this.port.require(tx, CLAIM_POLICY_RULE_TYPE, CLAIM_POLICY_DEFAULT_CODE, asOf);
    return { params: parseClaimPolicy(rule.params), basis: basisOf(rule) };
  }

  async earlyWarning(tx: TenantTx, asOf: string | Date): Promise<PolicyReading<EarlyWarningPolicy>> {
    const rule = await this.port.require(tx, EARLY_WARNING_POLICY_RULE_TYPE, EARLY_WARNING_POLICY_DEFAULT_CODE, asOf);
    return { params: parseEarlyWarningPolicy(rule.params), basis: basisOf(rule) };
  }

  async templates(tx: TenantTx, asOf: string | Date): Promise<ClaimTermTemplate[]> {
    const rules = await this.port.getAll(tx, CLAIM_TERM_TEMPLATE_RULE_TYPE, asOf);
    return rules.map((rule) => ({
      code: rule.code,
      noticeDays: periodOf(rule.params.notice_days),
      particularsDays: periodOf(rule.params.particulars_days),
      responseDays: periodOf(rule.params.response_days),
      settlementDays: periodOf(rule.params.settlement_days),
      basis: rule.params.basis as ClaimPeriodBasis,
      particularsFrom: rule.params.particulars_from as ParticularsFrom,
      barEffect: rule.params.bar_effect as BarEffect,
      basisOf: basisOf(rule),
    }));
  }
}
