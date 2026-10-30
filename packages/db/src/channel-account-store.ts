import { DomainError, canDisableAccount, canVerifyAccount } from '@machvon/kernel';
import type { AccountChanges, AccountStatus, ChannelLimits, ConnectedAccount } from '@machvon/kernel';
import { assertTimestampCursor } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';

const TIME = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const UNIQUE_VIOLATION = '23505';

export interface ChannelAccountRecord {
  id: string;
  channel: string;
  externalAccountId: string;
  displayName: string;
  status: AccountStatus;
  /** Whether a webhook secret is configured: the reference itself never leaves the store (OMNI 7, "secret chỉ hiển thị đã cấu hình"). */
  webhookConfigured: boolean;
  verifiedAt: string | null;
  verifyRequestedAt: string | null;
  verificationError: string | null;
  autoReplyText: string | null;
  calendarCode: string | null;
  dailySendCap: number | null;
  monthlyBudgetVnd: string | null;
  createdAt: string;
  version: number;
  sortKey: string;
}

interface AccountRow {
  id: string;
  channel: string;
  external_account_id: string;
  display_name: string;
  status: AccountStatus;
  webhook_configured: boolean;
  verified_at: string | null;
  verify_requested_at: string | null;
  verification_error: string | null;
  auto_reply_text: string | null;
  calendar_code: string | null;
  daily_send_cap: number | null;
  monthly_budget_vnd: string | null;
  created_at: string;
  version: string;
  sort_key: string;
}

const COLUMNS = `id, channel, external_account_id, display_name, status, webhook_secret_ref is not null as webhook_configured, ${TIME('verified_at')} as verified_at, ${TIME('verify_requested_at')} as verify_requested_at,
  verification_error, auto_reply_text, calendar_code, daily_send_cap, monthly_budget_vnd::text as monthly_budget_vnd, ${TIME('created_at')} as created_at, version::text as version,
  to_char(date_trunc('milliseconds', created_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"000Z"') as sort_key`;

const toRecord = (row: AccountRow): ChannelAccountRecord => ({
  id: row.id,
  channel: row.channel,
  externalAccountId: row.external_account_id,
  displayName: row.display_name,
  status: row.status,
  webhookConfigured: row.webhook_configured,
  verifiedAt: row.verified_at,
  verifyRequestedAt: row.verify_requested_at,
  verificationError: row.verification_error,
  autoReplyText: row.auto_reply_text,
  calendarCode: row.calendar_code,
  dailySendCap: row.daily_send_cap,
  monthlyBudgetVnd: row.monthly_budget_vnd,
  createdAt: row.created_at,
  version: Number(row.version),
  sortKey: row.sort_key,
});

/** What the verifier needs to ask the provider; the references are given to the port, which reads the vault itself. */
export interface VerificationTarget {
  id: string;
  channel: string;
  externalAccountId: string;
  credentialSecretRef: string;
  webhookSecretRef: string | null;
  verifyRequestedAt: string;
}

export type VerificationOutcome = { ok: true } | { ok: false; code: string };

/**
 * The channel accounts of a tenant (ST-OMNI-001, OMNI 3.7). An account is connected as PendingVerification with references to its secrets; verification is asked for with a command and answered by a consumer that
 * calls the provider outside any transaction, so no row is locked during a network call. Only an Active account sends or receives (BR-OMNI-02). A Disabled account is closed for good: a new one is connected instead.
 * Every move is made at the version the caller read (409 `VERSION_CONFLICT`), and the database refuses the moves that OMNI 4 does not have (migration V1280).
 */
export class ChannelAccountStore {
  async connect(tx: TenantTx, input: ConnectedAccount, actor: string): Promise<ChannelAccountRecord> {
    await tx.query('savepoint channel_account_connect');
    try {
      const [row] = await tx.query<AccountRow>(
        `insert into machvon.channel_account (tenant_id, id, channel, external_account_id, credential_secret_ref, capability_version, status, display_name, webhook_secret_ref, created_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2, $3, 'v1', 'PendingVerification', $4, $5, $6::uuid) returning ${COLUMNS}`,
        [input.channel, input.externalAccountId, input.credentialSecretRef, input.displayName, input.webhookSecretRef ?? null, actor],
      );
      await tx.query('release savepoint channel_account_connect');
      return toRecord(row as AccountRow);
    } catch (error) {
      if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
      await tx.query('rollback to savepoint channel_account_connect');
      throw new DomainError('CHANNEL_ACCOUNT_EXISTS', 409);
    }
  }

  async find(tx: TenantTx, id: string): Promise<ChannelAccountRecord | undefined> {
    const [row] = await tx.query<AccountRow>(`select ${COLUMNS} from machvon.channel_account where id = $1::uuid`, [id]);
    return row === undefined ? undefined : toRecord(row);
  }

  async list(
    tx: TenantTx,
    filters: { status?: string | undefined; channel?: string | undefined },
    page: { limit: number; after: { code: string; id: string } | undefined },
  ): Promise<ChannelAccountRecord[]> {
    assertTimestampCursor(page.after?.code);
    const rows = await tx.query<AccountRow>(
      `select ${COLUMNS} from machvon.channel_account
        where ($1::text is null or status = $1) and ($2::text is null or channel = $2)
          and ($3::timestamptz is null or (date_trunc('milliseconds', created_at), id) < ($3::timestamptz, $4::uuid))
        order by date_trunc('milliseconds', created_at) desc, id desc limit $5::int`,
      [filters.status ?? null, filters.channel ?? null, page.after?.code ?? null, page.after?.id ?? null, page.limit],
    );
    return rows.map(toRecord);
  }

  private async lock(tx: TenantTx, id: string, expectedVersion: number): Promise<ChannelAccountRecord> {
    const [row] = await tx.query<AccountRow>(`select ${COLUMNS} from machvon.channel_account where id = $1::uuid for update`, [id]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const current = toRecord(row);
    if (current.version !== expectedVersion) throw new DomainError('VERSION_CONFLICT', 409, undefined, { extensions: { current_version: current.version } });
    return current;
  }

  /** The name, the auto reply and the calendar of an account that is not closed. The calendar must be one the tenant has published. */
  async update(tx: TenantTx, id: string, expectedVersion: number, changes: AccountChanges): Promise<ChannelAccountRecord> {
    const current = await this.lock(tx, id, expectedVersion);
    if (current.status === 'Disabled') throw new DomainError('CHANNEL_ACCOUNT_STATE_INVALID', 409, 'status');
    if (changes.calendarCode !== undefined && changes.calendarCode !== null) {
      const [known] = await tx.query<{ found: boolean }>("select exists (select 1 from machvon.work_calendar_version where calendar_code = $1 and status = 'Published') as found", [changes.calendarCode]);
      if (known?.found !== true) throw new DomainError('VALIDATION_FAILED', 422, 'calendar_code');
    }
    const [row] = await tx.query<AccountRow>(
      `update machvon.channel_account set
          display_name = case when $2::boolean then $3 else display_name end,
          auto_reply_text = case when $4::boolean then $5 else auto_reply_text end,
          calendar_code = case when $6::boolean then $7 else calendar_code end,
          version = version + 1
        where id = $1::uuid returning ${COLUMNS}`,
      [
        id,
        changes.displayName !== undefined,
        changes.displayName ?? null,
        changes.autoReplyText !== undefined,
        changes.autoReplyText ?? null,
        changes.calendarCode !== undefined,
        changes.calendarCode ?? null,
      ],
    );
    return toRecord(row as AccountRow);
  }

  /** The cap and the budget of the account (ST-NOT-010): the ones given are changed, `null` takes a limit off. A closed account has none to change. */
  async setLimits(tx: TenantTx, id: string, expectedVersion: number, limits: ChannelLimits): Promise<ChannelAccountRecord> {
    // The same order as a claim in the delivery engine, which holds its attempt before it takes the account: the held attempts first (by id), then the account, so the two cannot wait on each other.
    await tx.query("select id from machvon.delivery_attempt where channel_account_id = $1::uuid and status = 'Queued' and error_code in ('CHANNEL_CAP', 'CHANNEL_BUDGET') order by id for update", [id]);
    const current = await this.lock(tx, id, expectedVersion);
    if (current.status === 'Disabled') throw new DomainError('CHANNEL_ACCOUNT_STATE_INVALID', 409, 'status');
    const [row] = await tx.query<AccountRow>(
      `update machvon.channel_account set
          daily_send_cap = case when $2::boolean then $3::int else daily_send_cap end,
          monthly_budget_vnd = case when $4::boolean then $5::numeric else monthly_budget_vnd end,
          version = version + 1
        where id = $1::uuid returning ${COLUMNS}`,
      [id, limits.dailySendCap !== undefined, limits.dailySendCap ?? null, limits.monthlyBudgetVnd !== undefined, limits.monthlyBudgetVnd ?? null],
    );
    // What was held by the old limits is judged again under the new ones at once, not at the start of the next day or month (it could be past its expiry by then); one that is still over a limit is held again.
    await tx.query("update machvon.delivery_attempt set next_retry_at = null, error_code = null where channel_account_id = $1::uuid and status = 'Queued' and error_code in ('CHANNEL_CAP', 'CHANNEL_BUDGET')", [id]);
    return toRecord(row as AccountRow);
  }

  /** Asks for a verification of an account that waits for one. The answer comes from the verifier; asking again before it has come just renews the request. */
  async requestVerification(tx: TenantTx, id: string, expectedVersion: number): Promise<ChannelAccountRecord> {
    const current = await this.lock(tx, id, expectedVersion);
    if (!canVerifyAccount(current.status)) throw new DomainError('CHANNEL_ACCOUNT_STATE_INVALID', 409, 'status');
    const [row] = await tx.query<AccountRow>('update machvon.channel_account set verify_requested_at = now(), verification_error = null, version = version + 1 where id = $1::uuid returning ' + COLUMNS, [id]);
    return toRecord(row as AccountRow);
  }

  /** Closes an account. What waits to be sent through it is stopped by the dispatcher (an attempt on an account that is not Active is Suppressed). */
  async disable(tx: TenantTx, id: string, expectedVersion: number): Promise<ChannelAccountRecord> {
    const current = await this.lock(tx, id, expectedVersion);
    if (!canDisableAccount(current.status)) throw new DomainError('CHANNEL_ACCOUNT_STATE_INVALID', 409, 'status');
    const [row] = await tx.query<AccountRow>("update machvon.channel_account set status = 'Disabled', verify_requested_at = null, version = version + 1 where id = $1::uuid returning " + COLUMNS, [id]);
    return toRecord(row as AccountRow);
  }

  /** The provider said the credential is gone: an Active account stops being used until it is verified again. Anything else is left as it is. */
  async expireCredential(tx: TenantTx, id: string): Promise<boolean> {
    const moved = await tx.query<{ id: string }>("update machvon.channel_account set status = 'CredentialExpired', version = version + 1 where id = $1::uuid and status = 'Active' returning id", [id]);
    return moved.length > 0;
  }

  /** The account to verify and the request being answered, or nothing when there is none (the account is gone, or the request was answered or withdrawn). */
  async verificationTarget(tx: TenantTx, id: string): Promise<VerificationTarget | undefined> {
    const [row] = await tx.query<{ id: string; channel: string; external_account_id: string; credential_secret_ref: string; webhook_secret_ref: string | null; verify_requested_at: string }>(
      `select id, channel, external_account_id, credential_secret_ref, webhook_secret_ref, ${TIME('verify_requested_at')} as verify_requested_at
         from machvon.channel_account where id = $1::uuid and verify_requested_at is not null and status in ('PendingVerification', 'CredentialExpired')`,
      [id],
    );
    return row === undefined
      ? undefined
      : { id: row.id, channel: row.channel, externalAccountId: row.external_account_id, credentialSecretRef: row.credential_secret_ref, webhookSecretRef: row.webhook_secret_ref, verifyRequestedAt: row.verify_requested_at };
  }

  /**
   * Records what the provider answered to the request that was made. A request that has been renewed, answered or withdrawn since (the account was disabled) is not this one and changes nothing: `STALE`. A good answer
   * makes the account Active and verified; a bad one keeps the reason and leaves the account where it was, for the supervisor to correct and ask again.
   */
  async recordVerification(tx: TenantTx, id: string, requestedAt: string, outcome: VerificationOutcome): Promise<'VERIFIED' | 'FAILED' | 'STALE'> {
    const [row] = await tx.query<{ id: string }>(
      `select id from machvon.channel_account where id = $1::uuid and verify_requested_at = $2::timestamptz and status in ('PendingVerification', 'CredentialExpired') for update`,
      [id, requestedAt],
    );
    if (row === undefined) return 'STALE';
    if (outcome.ok) {
      await tx.query("update machvon.channel_account set status = 'Active', verified_at = now(), verify_requested_at = null, verification_error = null, version = version + 1 where id = $1::uuid", [id]);
      return 'VERIFIED';
    }
    await tx.query('update machvon.channel_account set verification_error = $2, verify_requested_at = null, version = version + 1 where id = $1::uuid', [id, outcome.code]);
    return 'FAILED';
  }
}
