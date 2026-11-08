import { EGP_CONNECTOR_CODE } from '@machvon/kernel';
import { EgpConnectionStore } from './egp-store.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * What the hub needs from a connector that owns its own on/off switch (descriptor `ledger.stateOwner` CONNECTOR): to read the switch, and to move it through the connector's own command, so that the
 * connector's history and rules stay the connector's (the hub never writes a connector table). A lane that adds such a connector registers one object here; a connector whose switch the hub owns needs nothing.
 */
export interface HubStateAdapter {
  read(tx: TenantTx): Promise<{ enabled: boolean; version: number; reason: string | null; changedAt: string | null }>;
  set(tx: TenantTx, expectedVersion: number, move: { enabled: unknown; reason: unknown }, actor: string): Promise<{ before: { enabled: boolean; version: number }; after: { enabled: boolean; version: number; reason: string | null; changedAt: string | null } }>;
}

const ADAPTERS = new Map<string, HubStateAdapter>();

export function registerHubStateAdapter(connectorCode: string, adapter: HubStateAdapter): void {
  if (ADAPTERS.has(connectorCode)) throw new Error(`hub state adapter for ${connectorCode} is already registered`);
  ADAPTERS.set(connectorCode, adapter);
}

export const hubStateAdapterOf = (connectorCode: string): HubStateAdapter | undefined => ADAPTERS.get(connectorCode);

/** The e-GP connection: the switch is the one of BID-22 (`egp_connection`), moved by the same store as the command `setEgpConnectionState`. */
const egpAdapter = (): HubStateAdapter => {
  const store = new EgpConnectionStore();
  return {
    async read(tx) {
      const row = await store.current(tx);
      return { enabled: row.enabled, version: row.version, reason: row.stateReason, changedAt: row.stateChangedAt };
    },
    async set(tx, expectedVersion, move, actor) {
      const moved = await store.setState(tx, expectedVersion, move, actor);
      return {
        before: { enabled: moved.before.enabled, version: moved.before.version },
        after: { enabled: moved.row.enabled, version: moved.row.version, reason: moved.row.stateReason, changedAt: moved.row.stateChangedAt },
      };
    },
  };
};

/** Registers the adapters of the connectors that exist on main; safe to call again. */
export function registerBuiltInHubAdapters(): void {
  if (!ADAPTERS.has(EGP_CONNECTOR_CODE)) registerHubStateAdapter(EGP_CONNECTOR_CODE, egpAdapter());
}
