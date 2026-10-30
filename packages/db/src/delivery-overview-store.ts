import { deliveredRate, dayStartVn, monthStartVn } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

export interface ChannelSummary {
  channel: string;
  delivered: number;
  read: number;
  ended: number;
  suppressed: number;
  unknown: number;
  failed: number;
  denominator: number;
  deliveredRate: number | undefined;
}

export interface AccountUse {
  channelAccountId: string;
  channel: string;
  displayName: string;
  status: string;
  dailySendCap: number | null;
  sentToday: number;
  monthlyBudgetVnd: string | null;
  spentMonthVnd: string;
  heldByLimit: number;
  version: number;
}

/**
 * The operations overview of the delivery of messages (ST-NOT-010, NOT-04, NOT-15, BR-NOT-14, BR-NOT-13). For each channel: the attempts of the period that ended (delivered, read, failed, suppressed, unknown), and the
 * delivery rate by the formula of BR-NOT-14; for each account that is not closed: what it has sent today and spent this month against its cap and its budget, and what waits because of them. The period is judged by
 * when the attempt was made (`created_at`), and the cutoff is the end of the period.
 */
export class DeliveryOverviewStore {
  async channels(tx: TenantTx, from: Date, to: Date): Promise<ChannelSummary[]> {
    const rows = await tx.query<{ channel: string; delivered: string; read: string; failed: string; suppressed: string; unknown: string }>(
      `select channel,
              count(*) filter (where status = 'Delivered')::text as delivered,
              count(*) filter (where status = 'Read')::text as read,
              count(*) filter (where status = 'Failed')::text as failed,
              count(*) filter (where status = 'Suppressed')::text as suppressed,
              count(*) filter (where status = 'Unknown')::text as unknown
         from machvon.delivery_attempt
        where created_at >= $1::timestamptz and created_at < $2::timestamptz and status in ('Delivered', 'Read', 'Failed', 'Suppressed', 'Unknown')
        group by channel order by channel`,
      [from.toISOString(), to.toISOString()],
    );
    return rows.map((row) => {
      const counts = { delivered: Number(row.delivered), read: Number(row.read), suppressed: Number(row.suppressed), unknown: Number(row.unknown), ended: Number(row.delivered) + Number(row.read) + Number(row.failed) + Number(row.suppressed) + Number(row.unknown) };
      const rate = deliveredRate(counts);
      return { channel: row.channel, delivered: counts.delivered, read: counts.read, ended: counts.ended, suppressed: counts.suppressed, unknown: counts.unknown, failed: Number(row.failed), denominator: rate.denominator, deliveredRate: rate.rate };
    });
  }

  async accounts(tx: TenantTx, now: Date): Promise<AccountUse[]> {
    const rows = await tx.query<{ id: string; channel: string; display_name: string; status: string; daily_send_cap: number | null; monthly_budget_vnd: string | null; sent_today: string; spent: string; held: string; version: string }>(
      `select a.id, a.channel, a.display_name, a.status, a.daily_send_cap, a.monthly_budget_vnd::text as monthly_budget_vnd, a.version::text as version,
              (select count(*) from machvon.delivery_attempt d where d.channel_account_id = a.id and d.sending_at >= $1::timestamptz)::text as sent_today,
              (select coalesce(sum(d.cost), 0)::bigint from machvon.delivery_attempt d where d.channel_account_id = a.id and d.sending_at >= $2::timestamptz)::text as spent,
              (select count(*) from machvon.delivery_attempt d where d.channel_account_id = a.id and d.status = 'Queued' and d.error_code in ('CHANNEL_CAP', 'CHANNEL_BUDGET'))::text as held
         from machvon.channel_account a where a.status <> 'Disabled' order by a.channel, a.id`,
      [dayStartVn(now).toISOString(), monthStartVn(now).toISOString()],
    );
    return rows.map((row) => ({
      channelAccountId: row.id,
      channel: row.channel,
      displayName: row.display_name,
      status: row.status,
      dailySendCap: row.daily_send_cap,
      sentToday: Number(row.sent_today),
      monthlyBudgetVnd: row.monthly_budget_vnd,
      spentMonthVnd: row.spent,
      heldByLimit: Number(row.held),
      version: Number(row.version),
    }));
  }
}
