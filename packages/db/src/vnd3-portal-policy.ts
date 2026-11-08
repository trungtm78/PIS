import { PORTAL_CLOCK_DEFAULTS, ocdsExportPolicyOf, portalClockPolicyOf, reconfirmationPolicyOf, remediationPolicyOf } from '@machvon/kernel';
import type { OcdsExportPolicy, PortalClockPolicy, PortalRequestKind, ReconfirmationPolicy, RemediationPolicy, ResolvedGovernanceRule } from '@machvon/kernel';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import type { Policy } from './vendor-policy.ts';
import type { TenantTx } from './tenant-database.ts';

const versionOf = (rule: ResolvedGovernanceRule): string => (rule.source === 'DEFAULT' ? 'builtin' : String(rule.version));

/**
 * The rules of the contractor portal (VND-3), read through the governance port like those of VND-1: the clock of each kind of request (`VENDOR_PORTAL`, one code per kind), the yearly re-confirmation with the text of the
 * declaration (`VENDOR_RECONFIRMATION`), the plans of remediation (`VENDOR_REMEDIATION`) and the export of parties (`VENDOR_OCDS_EXPORT`). A rule the tenant approved wins over the starting value; every answer says which version decided.
 */
export class VendorPortalPolicyReader {
  private readonly port: GovernancePolicyPort;

  constructor(port: GovernancePolicyPort = new GovernancePolicyPort()) {
    this.port = port;
  }

  private async read<T>(tx: TenantTx, type: string, code: string, today: string, parse: (params: unknown) => T): Promise<Policy<T>> {
    const rule = await this.port.require(tx, type, code, today);
    return { value: parse(rule.params), version: versionOf(rule), unverified: rule.unverified, formula: rule.provenance?.formula ?? '', source: rule.provenance?.source ?? '', asOf: rule.provenance?.asOf ?? today };
  }

  clock(tx: TenantTx, kind: PortalRequestKind, today: string): Promise<Policy<PortalClockPolicy>> {
    return this.read(tx, 'VENDOR_PORTAL', kind, today, portalClockPolicyOf);
  }

  /** The clock rule of every kind, for the screen that shows the numbers next to the list. */
  async clocks(tx: TenantTx, today: string): Promise<Record<string, Policy<PortalClockPolicy>>> {
    const out: Record<string, Policy<PortalClockPolicy>> = {};
    for (const kind of Object.keys(PORTAL_CLOCK_DEFAULTS)) out[kind] = await this.clock(tx, kind as PortalRequestKind, today);
    return out;
  }

  reconfirmation(tx: TenantTx, today: string): Promise<Policy<ReconfirmationPolicy>> {
    return this.read(tx, 'VENDOR_RECONFIRMATION', 'DEFAULT', today, reconfirmationPolicyOf);
  }

  remediation(tx: TenantTx, today: string): Promise<Policy<RemediationPolicy>> {
    return this.read(tx, 'VENDOR_REMEDIATION', 'DEFAULT', today, remediationPolicyOf);
  }

  ocds(tx: TenantTx, today: string): Promise<Policy<OcdsExportPolicy>> {
    return this.read(tx, 'VENDOR_OCDS_EXPORT', 'DEFAULT', today, ocdsExportPolicyOf);
  }
}
