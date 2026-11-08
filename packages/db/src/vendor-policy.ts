import {
  REPUTATION_DEADLINE_CODE,
  VENDOR_DEBARMENT_PERIOD_RULE_TYPE,
  VENDOR_DEBARMENT_RULE_TYPE,
  VENDOR_DUPLICATE_RULE_TYPE,
  VENDOR_EXPIRY_RULE_TYPE,
  VENDOR_GATE_RULE_TYPE,
  VENDOR_PROFILE_RULE_TYPE,
  VENDOR_REPUTATION_RULE_TYPE,
  VENDOR_RULE_CODE,
  PAYEE_POLICY_RULE_CODE,
  PAYEE_POLICY_RULE_TYPE,
  EGP_POSTING_RULE_TYPE,
  debarmentPeriodOf,
  debarmentPolicyOf,
  duplicateWeightsOf,
  egpPostingRuleOf,
  expiryPolicyOf,
  gatePolicyOf,
  payeeAccountPolicyOf,
  reputationPolicyOf,
  vendorProfilePolicyOf,
  DEBARMENT_GROUPS,
} from '@machvon/kernel';
import type {
  DebarmentPeriod,
  DebarmentPolicy,
  DuplicateWeights,
  EgpPostingRule,
  ExpiryWarningPolicy,
  GatePolicy,
  PayeeAccountPolicy,
  ReputationPolicy,
  ResolvedGovernanceRule,
  VendorProfilePolicy,
} from '@machvon/kernel';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import type { TenantTx } from './tenant-database.ts';

/** A policy as it was read: the numbers, the version that decided (`builtin` for a starting value nobody approved), whether they are unconfirmed, and the provenance a screen shows next to them. */
export interface Policy<T> {
  value: T;
  version: string;
  unverified: boolean;
  formula: string;
  source: string;
  asOf: string;
}

const versionOf = (rule: ResolvedGovernanceRule): string => (rule.source === 'DEFAULT' ? 'builtin' : String(rule.version));

/**
 * The rules of the management of contractors, read through the governance port (G0-1): a rule the tenant approved wins over the starting value of the kernel, and every answer says which version decided so that the
 * decision that used it (a case, a change of account, a gate) keeps it. A read never writes. Thresholds are never constants of a store or a controller.
 */
export class VendorPolicyReader {
  private readonly port: GovernancePolicyPort;

  constructor(port: GovernancePolicyPort = new GovernancePolicyPort()) {
    this.port = port;
  }

  private async read<T>(tx: TenantTx, type: string, code: string, today: string, parse: (params: unknown) => T): Promise<Policy<T>> {
    const rule = await this.port.require(tx, type, code, today);
    return {
      value: parse(rule.params),
      version: versionOf(rule),
      unverified: rule.unverified,
      formula: rule.provenance?.formula ?? '',
      source: rule.provenance?.source ?? '',
      asOf: rule.provenance?.asOf ?? today,
    };
  }

  profile(tx: TenantTx, today: string): Promise<Policy<VendorProfilePolicy>> {
    return this.read(tx, VENDOR_PROFILE_RULE_TYPE, VENDOR_RULE_CODE, today, vendorProfilePolicyOf);
  }

  duplicateWeights(tx: TenantTx, today: string): Promise<Policy<DuplicateWeights>> {
    return this.read(tx, VENDOR_DUPLICATE_RULE_TYPE, VENDOR_RULE_CODE, today, duplicateWeightsOf);
  }

  payee(tx: TenantTx, today: string): Promise<Policy<PayeeAccountPolicy>> {
    return this.read(tx, PAYEE_POLICY_RULE_TYPE, PAYEE_POLICY_RULE_CODE, today, payeeAccountPolicyOf);
  }

  expiry(tx: TenantTx, kind: 'QUALIFICATION' | 'KEY_STAFF', today: string): Promise<Policy<ExpiryWarningPolicy>> {
    return this.read(tx, VENDOR_EXPIRY_RULE_TYPE, kind, today, expiryPolicyOf);
  }

  debarment(tx: TenantTx, today: string): Promise<Policy<DebarmentPolicy>> {
    return this.read(tx, VENDOR_DEBARMENT_RULE_TYPE, VENDOR_RULE_CODE, today, debarmentPolicyOf);
  }

  /** The three periods of a ban, by group; a tenant that approved its own period for a group changes that group only. */
  async periods(tx: TenantTx, today: string): Promise<Policy<Record<string, DebarmentPeriod>>> {
    const found = await Promise.all(DEBARMENT_GROUPS.map((group) => this.read(tx, VENDOR_DEBARMENT_PERIOD_RULE_TYPE, group, today, debarmentPeriodOf)));
    const first = found[0] as Policy<DebarmentPeriod>;
    return {
      value: Object.fromEntries(DEBARMENT_GROUPS.map((group, index) => [group, (found[index] as Policy<DebarmentPeriod>).value])),
      version: found.map((one) => one.version).join(','),
      unverified: found.some((one) => one.unverified),
      formula: first.formula,
      source: first.source,
      asOf: first.asOf,
    };
  }

  reputation(tx: TenantTx, today: string): Promise<Policy<ReputationPolicy>> {
    return this.read(tx, VENDOR_REPUTATION_RULE_TYPE, VENDOR_RULE_CODE, today, reputationPolicyOf);
  }

  gate(tx: TenantTx, today: string): Promise<Policy<GatePolicy>> {
    return this.read(tx, VENDOR_GATE_RULE_TYPE, VENDOR_RULE_CODE, today, gatePolicyOf);
  }

  /** The deadline of posting an event of bid conduct: the rule of the posting obligations of EGP-2, code REPUTATION_EVENT (7 working days, flagged unverified), so the clock here and the obligation there are one number. */
  postingDeadline(tx: TenantTx, today: string): Promise<Policy<EgpPostingRule>> {
    return this.read(tx, EGP_POSTING_RULE_TYPE, REPUTATION_DEADLINE_CODE, today, (params) => egpPostingRuleOf(params as Readonly<Record<string, unknown>>));
  }
}
