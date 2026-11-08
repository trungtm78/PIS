import { COMMITTEE_POLICY_CODE, COMMITTEE_POLICY_RULE_TYPE, committeePolicyOf } from '@machvon/kernel';
import type { CommitteePolicyReading } from '@machvon/kernel';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import type { TenantTx } from './tenant-database.ts';

/** The thresholds of the committee workspace as the rule `COMMITTEE_POLICY` gives them on a day: an approved version of the tenant, else the built-in default, which every screen then calls unverified. */
export class CommitteePolicyReader {
  private readonly port: GovernancePolicyPort;

  constructor(port: GovernancePolicyPort = new GovernancePolicyPort()) {
    this.port = port;
  }

  async get(tx: TenantTx, day: string): Promise<CommitteePolicyReading> {
    const resolved = await this.port.get(tx, COMMITTEE_POLICY_RULE_TYPE, COMMITTEE_POLICY_CODE, day);
    return committeePolicyOf(resolved === undefined ? undefined : { version: resolved.version, source: resolved.source, unverified: resolved.unverified, params: resolved.params });
  }
}
