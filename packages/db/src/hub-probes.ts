import type { RunOutcome } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

/**
 * A check the hub runs for a connector that has no import path to read (the open interface): `probe` looks at the facts the connector already holds and says how the connector stands now. The sweep of the hub
 * records the answer as one CHECK run per hour, so the health, the incidents and the trend work for it like for any other connector.
 */
export interface HubProbe {
  probe(tx: TenantTx, now: Date): Promise<{ outcome: Extract<RunOutcome, 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'SKIPPED'>; rowsTotal: number; rowsRejected: number; errorCode: string | null }>;
}

const PROBES = new Map<string, HubProbe>();

export function registerHubProbe(connectorCode: string, probe: HubProbe): void {
  if (PROBES.has(connectorCode)) throw new Error(`hub probe for ${connectorCode} is already registered`);
  PROBES.set(connectorCode, probe);
}

export const hubProbeOf = (connectorCode: string): HubProbe | undefined => PROBES.get(connectorCode);
