import { dayStartVn, judgeLimits, monthStartVn } from '@machvon/kernel';
import type { LimitVerdict } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

/**
 * The cap and the budget of a channel account at the moment a send is taken up (ST-NOT-010, BR-NOT-13). It runs in the transaction that claims the attempt: the account's limits are locked for the rest of that transaction
 * (an advisory lock on the account, taken only for an account that has a limit), so two sends that are claimed at once cannot both slip under the same cap. What has been sent is counted from the attempts that were taken
 * up since the start of the day and of the month in Vietnam, and what was spent is the sum of the estimated prices written on them. A CRITICAL message is never held back by money.
 */
export class DeliveryLimits {
  async check(tx: TenantTx, channelAccountId: string, channel: string, priority: string, now: Date): Promise<LimitVerdict> {
    const [account] = await tx.query<{ daily_send_cap: number | null; monthly_budget_vnd: string | null }>('select daily_send_cap, monthly_budget_vnd::text as monthly_budget_vnd from machvon.channel_account where id = $1::uuid', [channelAccountId]);
    if (account === undefined || (account.daily_send_cap === null && account.monthly_budget_vnd === null)) return { kind: 'WITHIN' };
    if (priority === 'CRITICAL') return { kind: 'WITHIN' };
    await tx.query("select pg_advisory_xact_lock(hashtext('channel-limit:' || current_setting('app.tenant_id', true) || ':' || $1))", [channelAccountId]);
    const [use] = await tx.query<{ today: string; spent: string }>(
      `select count(*) filter (where sending_at >= $2::timestamptz)::text as today, coalesce(sum(cost), 0)::bigint::text as spent
         from machvon.delivery_attempt where channel_account_id = $1::uuid and sending_at >= $3::timestamptz`,
      [channelAccountId, dayStartVn(now).toISOString(), monthStartVn(now).toISOString()],
    );
    return judgeLimits({
      limits: { dailySendCap: account.daily_send_cap, monthlyBudgetVnd: account.monthly_budget_vnd === null ? null : BigInt(account.monthly_budget_vnd) },
      use: { sentToday: Number(use?.today ?? '0'), spentThisMonthVnd: BigInt(use?.spent ?? '0') },
      channel,
      priority,
      now,
    });
  }
}
