import { DeviceRegistrationStore, ENTITLEMENT_CHANGED_EVENT, consumeOnce, verifyDelivery } from '@machvon/db';
import type { ConsumeSecurity, OutboxDelivery, TenantDatabase } from '@machvon/db';
import { NOOP_METRICS, PLATFORMS_OF_CHANNEL, asUuid } from '@machvon/kernel';
import type { MetricsSink, PushTarget } from '@machvon/kernel';
import type { ChannelAdapterRegistry } from '../delivery/channel-adapters';
import type { PushTokenVault } from '../devices/push-vault';

export const SILENT_PUSH_CONSUMER = 'not.silent-push';
export const ACCESS_CHANGED_EVENT = 'iam.access.changed.v1';
/** What the app is asked to read again; the same for both events: the entitlements are the intersection of the permissions and the plan (BR-IAM-03). */
export const REFRESH_WHAT = 'entitlements';
const CHANNELS = ['PUSH_FCM', 'PUSH_APNS'] as const;
const CHUNK = 10;
const ADAPTER_TIMEOUT_MS = 10_000;
export const SILENT_PUSH_METRIC = 'push_silent_total';

type Delivery = Pick<OutboxDelivery, 'id' | 'tenantId' | 'tenantContext' | 'type' | 'payload'>;

export interface SilentPushDeps {
  database: TenantDatabase;
  adapters: ChannelAdapterRegistry;
  vault: PushTokenVault;
  security: ConsumeSecurity;
  metrics?: MetricsSink;
  /** How long one call to a provider may take before it is given up (the consumer is best effort and never holds the outbox delivery). */
  adapterTimeoutMs?: number;
}

/**
 * The silent push (ST-NOT-007): when the entitlements of a tenant change (`sas.entitlement.changed.v1`) or the access of some members does (`iam.access.changed.v1`), the apps of the people concerned are woken with a data
 * message that carries no text and shows nothing, and read `/me/entitlements` again. The first goes to every registered device of the tenant, the second to the devices of the members it names. It is best effort: an app
 * that misses it reads again when it is opened, and the server never trusts what an app holds (every request is judged on the access of the moment). A device the provider no longer knows is revoked as for any push.
 */
export class SilentPushConsumer {
  private readonly devices = new DeviceRegistrationStore();
  private readonly metrics: MetricsSink;

  constructor(private readonly deps: SilentPushDeps) {
    this.metrics = deps.metrics ?? NOOP_METRICS;
  }

  async handle(delivery: Delivery): Promise<'processed' | 'duplicate' | 'ignored'> {
    if (delivery.type !== ENTITLEMENT_CHANGED_EVENT && delivery.type !== ACCESS_CHANGED_EVENT) return 'ignored';
    // The payload names the tenant too (the access events of the org-unit commands do not); a delivery whose payload disagrees with its signed tenant is not ours to act on.
    const named = delivery.payload.tenant_id;
    if (delivery.type === ENTITLEMENT_CHANGED_EVENT ? asUuid(named) !== delivery.tenantId : named !== undefined && asUuid(named) !== delivery.tenantId) return 'ignored';
    const members = delivery.type === ACCESS_CHANGED_EVENT ? membersOf(delivery.payload) : undefined;
    if (members !== undefined && members.length === 0) return 'ignored';
    const deps = this.deps;
    const { database, adapters, vault, security } = deps;
    const batches: Array<{ channel: (typeof CHANNELS)[number]; accountId: string; targets: PushTarget[] }> = [];
    const tried = new Map<string, string>();
    const outcome = await consumeOnce(
      database,
      delivery,
      SILENT_PUSH_CONSUMER,
      async (tx) => {
        for (const channel of CHANNELS) {
          if (adapters.usable(channel) === undefined) continue;
          const [account] = await tx.query<{ external_account_id: string }>("select external_account_id from machvon.channel_account where channel = $1 and status = 'Active' order by id limit 1", [channel]);
          if (account === undefined) continue;
          const found = await this.devices.pushTargets(tx, members, PLATFORMS_OF_CHANNEL[channel] ?? []);
          const targets: PushTarget[] = [];
          for (const device of found) {
            const token = await vault.read(device.secretRef);
            if (token !== undefined) {
              targets.push({ deviceId: device.id, token });
              tried.set(device.id, device.secretRef);
            }
          }
          if (targets.length > 0) batches.push({ channel, accountId: account.external_account_id, targets });
        }
      },
      security,
    );
    if (outcome !== 'processed') return outcome;
    const context = verifyDelivery(delivery, security);
    const dead: Array<{ id: string; secretRef: string }> = [];
    for (const batch of batches) {
      const adapter = adapters.usable(batch.channel);
      if (adapter === undefined) continue;
      for (let from = 0, index = 0; from < batch.targets.length; from += CHUNK, index += 1) {
        const chunk = batch.targets.slice(from, from + CHUNK);
        try {
          const result = await withinTimeout(adapter.send({ idempotencyKey: `${delivery.id}:${batch.channel}:${index}`, accountId: batch.accountId, to: 'devices', text: '', targets: chunk, silent: { what: REFRESH_WHAT } }), deps.adapterTimeoutMs ?? ADAPTER_TIMEOUT_MS);
          this.metrics.increment(SILENT_PUSH_METRIC, { channel: batch.channel, outcome: result.kind === 'ACCEPTED' ? 'accepted' : 'failed' });
          if ((result.kind === 'ACCEPTED' || result.kind === 'FAILED') && result.deadTargets !== undefined) dead.push(...result.deadTargets.flatMap((id) => (tried.has(id) ? [{ id, secretRef: tried.get(id) as string }] : [])));
        } catch {
          this.metrics.increment(SILENT_PUSH_METRIC, { channel: batch.channel, outcome: 'failed' });
        }
      }
    }
    if (dead.length > 0) {
      try {
        const refs = await database.withTenant(context, (tx) => this.devices.revokeDead(tx, dead, 'PROVIDER_UNREGISTERED'));
        await Promise.allSettled(refs.map((ref) => vault.remove(ref)));
      } catch {
        // The next push that the provider refuses revokes them.
      }
    }
    return 'processed';
  }
}

/** The call, or a failure when the provider does not answer in time; the call itself is not cancelled (it holds nothing of ours). */
async function withinTimeout<T>(call: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([call, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('push provider timeout')), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** The members an access event names: most write `membership_ids`, the events of the tenant owner write one `membership_id`. */
function membersOf(payload: Record<string, unknown>): string[] {
  const listed = Array.isArray(payload.membership_ids) ? payload.membership_ids : [];
  return [...new Set([...listed, payload.membership_id].flatMap((item) => asUuid(item) ?? []))];
}
