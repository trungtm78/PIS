import { ACCESS_CONNECTOR_CODE, EGP_CONNECTOR_CODE, FEED_CONNECTOR_CODE } from '@machvon/kernel';
import { EgpConnectionStore } from './egp-store.ts';
import { FeedConnectionStore } from './finance-feed-store.ts';
import { hubProbeOf, registerHubProbe } from './hub-probes.ts';
import type { HubProbe } from './hub-probes.ts';
import { AccessOverviewReads } from './int-open-api-store.ts';
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

/** The Finance Department feed: the switch is the one of FEED-01 (the table finance_feed_connection), moved by the same store as the command that switches the feed. */
const feedAdapter = (): HubStateAdapter => {
  const store = new FeedConnectionStore();
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

/**
 * The open interface has no import path to read, so the hub asks it how it stands: an active consumer whose credential has expired makes the check FAILED (it can no longer call), any other consumer that needs a look
 * (expiring soon, secret overdue, rate limited, never used) makes it PARTIAL, a tenant that never opened the interface has nothing to check (SKIPPED: the connector stays NEVER_RUN, which is the truth).
 */
const accessProbe = (): HubProbe => {
  const reads = new AccessOverviewReads();
  return {
    async probe(tx, now) {
      const view = await reads.view(tx, now);
      const total = view.consumers.length + view.counts.biReaders.ACTIVE + view.counts.biReaders.SUSPENDED + view.counts.biReaders.RETIRED;
      if (view.status === 'NO_CONSUMERS') return { outcome: 'SKIPPED', rowsTotal: 0, rowsRejected: 0, errorCode: null };
      const expired = view.consumers.some((consumer) => consumer.attention.includes('EXPIRED'));
      return { outcome: expired ? 'FAILED' : view.attentionCount > 0 ? 'PARTIAL' : 'SUCCEEDED', rowsTotal: total, rowsRejected: view.attentionCount, errorCode: expired ? 'ACCESS_CREDENTIAL_EXPIRED' : null };
    },
  };
};

/** Registers the adapters and the probes of the connectors that exist on main; safe to call again. */
export function registerBuiltInHubAdapters(): void {
  if (!ADAPTERS.has(EGP_CONNECTOR_CODE)) registerHubStateAdapter(EGP_CONNECTOR_CODE, egpAdapter());
  if (!ADAPTERS.has(FEED_CONNECTOR_CODE)) registerHubStateAdapter(FEED_CONNECTOR_CODE, feedAdapter());
  if (hubProbeOf(ACCESS_CONNECTOR_CODE) === undefined) registerHubProbe(ACCESS_CONNECTOR_CODE, accessProbe());
}
