import { investigationPolicyOf, linkPolicyOf, riggingPolicyOf, screeningPolicyOf } from '@machvon/kernel';
import type { InvestigationPolicy, LinkPolicy, ResolvedGovernanceRule, RiggingPolicy, ScreeningPolicy } from '@machvon/kernel';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import type { TenantTx } from './tenant-database.ts';
import type { Policy } from './vendor-policy.ts';

const versionOf = (rule: ResolvedGovernanceRule): string => (rule.source === 'DEFAULT' ? 'builtin' : String(rule.version));

/**
 * The rules of the investigation and of the screening of contractors (VND-3), read through the governance port: a rule the tenant approved wins over the starting value of the kernel, every answer carries the version that
 * decided and the provenance a screen shows. A read never writes; no number of the investigation is a constant of a store.
 */
export class Vnd3PolicyReader {
  private readonly port: GovernancePolicyPort;

  constructor(port: GovernancePolicyPort = new GovernancePolicyPort()) {
    this.port = port;
  }

  private async read<T>(tx: TenantTx, type: string, code: string, today: string, parse: (params: unknown) => T): Promise<Policy<T>> {
    const rule = await this.port.require(tx, type, code, today);
    return { value: parse(rule.params), version: versionOf(rule), unverified: rule.unverified, formula: rule.provenance?.formula ?? '', source: rule.provenance?.source ?? '', asOf: rule.provenance?.asOf ?? today };
  }

  link(tx: TenantTx, today: string): Promise<Policy<LinkPolicy>> {
    return this.read(tx, 'VENDOR_LINK_RULE', 'DEFAULT', today, linkPolicyOf);
  }

  rigging(tx: TenantTx, today: string): Promise<Policy<RiggingPolicy>> {
    return this.read(tx, 'VENDOR_BID_RIGGING', 'DEFAULT', today, riggingPolicyOf);
  }

  investigation(tx: TenantTx, today: string): Promise<Policy<InvestigationPolicy>> {
    return this.read(tx, 'VENDOR_INVESTIGATION', 'DEFAULT', today, investigationPolicyOf);
  }

  screening(tx: TenantTx, today: string): Promise<Policy<ScreeningPolicy>> {
    return this.read(tx, 'VENDOR_SCREENING', 'DEFAULT', today, screeningPolicyOf);
  }
}
