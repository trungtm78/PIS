import type { Client } from 'pg';
import type { TenantName } from '../../suite';

/** What a seed function of the governance deepening needs from the seed of the isolation suite that calls it (inside the transaction of the tenant). */
export interface SeedContext {
  tenant: TenantName;
  tenantId: string;
  /** The first unit of the tenant. */
  home: string;
  /** The member the suite acts as (seeded with every right). */
  membershipId: string;
  /** The members the fixtures name as the maker and the approver of rows that need two people. */
  actorId: string;
  approverId: string;
}

/** A value that belongs to one tenant only: it must never appear in an answer given to the other tenant. */
export interface Marker {
  kind: string;
  value: string;
}

/**
 * The pieces one domain adds to the isolation suite: the rows it seeds for a tenant, the markers of those rows, the operations whose
 * permission the suite principal needs, and the tables the snapshot reads to prove a foreign attempt changed nothing.
 */
export interface DomainSeed {
  seed: (client: Client, context: SeedContext) => Promise<void>;
}

/** Fixed ids of the fixtures: `00000000-0000-4000-<tenant letter><group digit><two hex digits>-<12 hex digits>`. */
export function fixtureId(tenant: TenantName, group: number, family: number, serial = 1): string {
  const letter = tenant === 'TNT-A' ? 'a' : 'b';
  return `00000000-0000-4000-${letter}${group.toString(16)}${family.toString(16).padStart(2, '0')}-${serial.toString(16).padStart(12, '0')}`;
}
