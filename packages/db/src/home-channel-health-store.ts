import type { TenantTx } from './tenant-database.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const ISO = (column: string): string => `to_char((${column}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** A channel of the tenant whose circuit breaker is not closed: sends on it wait in the queue and are retried, they are not lost. */
export interface DegradedChannel {
  channel: string;
  /** OPEN while sends are refused; HALF_OPEN while one send tests the provider. */
  state: 'OPEN' | 'HALF_OPEN';
  /** Since when the first account of the channel has had its circuit open. */
  openSince: string;
  /** The time of the latest send on the channel that the provider accepted, or null when there never was one. */
  lastDeliveredAt: string | null;
}

/**
 * The degraded channels of the tenant for the banner of the home screen (ST-KERNEL-073): the channels with an account whose circuit (BR-NOT-16) is open, and for each the time of the latest
 * successful delivery on the channel, so that a person sees that the data is old and since when. Nothing here names an account, a recipient or a message.
 */
export class HomeChannelHealthStore {
  async degraded(tx: TenantTx): Promise<DegradedChannel[]> {
    const rows = await tx.query<{ channel: string; state: 'OPEN' | 'HALF_OPEN'; open_since: string; last_delivered_at: string | null }>(
      `select a.channel,
              case when bool_or(c.state = 'OPEN') then 'OPEN' else 'HALF_OPEN' end as state,
              ${ISO('min(c.opened_at)')} as open_since,
              (select ${ISO('max(greatest(d.accepted_at, d.delivered_at))')} from machvon.delivery_attempt d where d.tenant_id = ${TENANT} and d.channel = a.channel) as last_delivered_at
         from machvon.channel_account_circuit c
         join machvon.channel_account a on a.tenant_id = c.tenant_id and a.id = c.channel_account_id
        where c.tenant_id = ${TENANT} and c.state <> 'CLOSED'
        group by a.channel
        order by a.channel`,
    );
    return rows.map((row) => ({ channel: row.channel, state: row.state, openSince: row.open_since, lastDeliveredAt: row.last_delivered_at }));
  }
}
