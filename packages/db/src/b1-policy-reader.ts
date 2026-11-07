import { resolveB1Policy } from '@machvon/kernel';
import type { B1PolicyAnswer, B1PolicyReader, B1RawRule, B1RuleType } from '@machvon/kernel';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The thresholds of lane B1 as the governance platform gives them (G0-1): `GovernancePolicyPort.get(tx, type, code, asOf)` answers with the approved rule of the tenant in force on the day. A built-in default of
 * the platform is not an approved rule, so it is answered as "none" and the kernel gives the starting value of the lane stamped `built-in:1`; the version stored on an alert, a request or a frozen result is then
 * either that stamp or the number of a rule somebody approved, never a number that looks like an approval.
 */
export class GovernanceB1Reader implements B1PolicyReader<TenantTx> {
  private readonly port: GovernancePolicyPort;

  constructor(port: GovernancePolicyPort = new GovernancePolicyPort()) {
    this.port = port;
  }

  async get(tx: TenantTx, type: B1RuleType, code: string, asOf: string): Promise<B1RawRule | undefined> {
    const found = await this.port.get(tx, type, code, asOf);
    if (found === undefined || found.source === 'DEFAULT') return undefined;
    return { params: found.params, version: String(found.version) };
  }
}

export const DEFAULT_B1_READER: B1PolicyReader<TenantTx> = new GovernanceB1Reader();

/** The policy of a type in force on a day, through the reader given (the governance port unless a test gives its own). */
export const b1PolicyOf = <K extends B1RuleType>(reader: B1PolicyReader<TenantTx>, tx: TenantTx, type: K, asOf: string): Promise<B1PolicyAnswer<K>> => resolveB1Policy(reader, tx, type, asOf);
