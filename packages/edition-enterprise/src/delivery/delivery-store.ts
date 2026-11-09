import { DomainError, versionConflict } from '@machvon/kernel';
import type { TenantTx } from '@machvon/db';
import { DELIVERY_LOST_AFTER_MINUTES } from './delivery-rules.ts';
import type { DeliveryFormat, DeliveryOutcome, DeliveryScheduleRequest, DeliveryStatus } from './delivery-rules.ts';

const TIME = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const UNIQUE_VIOLATION = '23505';

export interface MailScheduleRow {
  id: string;
  layoutCode: string;
  cron: string;
  timezone: string;
  format: DeliveryFormat;
  recipients: string[];
  note: string | null;
  status: 'ACTIVE' | 'RETIRED';
  lastRunAt: string | null;
  retiredAt: string | null;
  retiredBy: string | null;
  retireReason: string | null;
  createdBy: string;
  createdAt: string;
  version: number;
}

interface ScheduleSql {
  id: string;
  layout_code: string;
  cron: string;
  timezone: string;
  format: DeliveryFormat;
  recipients: string[];
  note: string | null;
  status: 'ACTIVE' | 'RETIRED';
  last_run_at: string | null;
  retired_at: string | null;
  retired_by: string | null;
  retire_reason: string | null;
  created_by: string;
  created_at: string;
  version: string;
}

const SCHEDULE_COLUMNS = `id, layout_code, cron, timezone, format, recipients, note, status, ${TIME('last_run_at')} as last_run_at, ${TIME('retired_at')} as retired_at, retired_by, retire_reason, created_by, ${TIME('created_at')} as created_at, version::text as version`;

const scheduleOf = (row: ScheduleSql): MailScheduleRow => ({
  id: row.id,
  layoutCode: row.layout_code,
  cron: row.cron,
  timezone: row.timezone,
  format: row.format,
  recipients: row.recipients,
  note: row.note,
  status: row.status,
  lastRunAt: row.last_run_at,
  retiredAt: row.retired_at,
  retiredBy: row.retired_by,
  retireReason: row.retire_reason,
  createdBy: row.created_by,
  createdAt: row.created_at,
  version: Number(row.version),
});

export interface MailingRow {
  id: string;
  scheduleId: string;
  issueId: string;
  recipientId: string;
  fileFormat: DeliveryFormat;
  fileName: string | null;
  fileSha256: string | null;
  status: DeliveryStatus;
  attempts: number;
  errorCode: string | null;
  providerMessageId: string | null;
  firstAttemptAt: string | null;
  lastAttemptAt: string | null;
  sentAt: string | null;
  createdAt: string;
}

interface MailingSql {
  id: string;
  schedule_id: string;
  issue_id: string;
  recipient_id: string;
  file_format: DeliveryFormat;
  file_name: string | null;
  file_sha256: string | null;
  status: DeliveryStatus;
  attempts: number;
  error_code: string | null;
  provider_message_id: string | null;
  first_attempt_at: string | null;
  last_attempt_at: string | null;
  sent_at: string | null;
  created_at: string;
}

const MAILING_COLUMNS = `id, schedule_id, issue_id, recipient_id, file_format, file_name, file_sha256, status, attempts, error_code, provider_message_id, ${TIME('first_attempt_at')} as first_attempt_at, ${TIME('last_attempt_at')} as last_attempt_at, ${TIME('sent_at')} as sent_at, ${TIME('created_at')} as created_at`;

const mailingOf = (row: MailingSql): MailingRow => ({
  id: row.id,
  scheduleId: row.schedule_id,
  issueId: row.issue_id,
  recipientId: row.recipient_id,
  fileFormat: row.file_format,
  fileName: row.file_name,
  fileSha256: row.file_sha256,
  status: row.status,
  attempts: row.attempts,
  errorCode: row.error_code,
  providerMessageId: row.provider_message_id,
  firstAttemptAt: row.first_attempt_at,
  lastAttemptAt: row.last_attempt_at,
  sentAt: row.sent_at,
  createdAt: row.created_at,
});

/** The schedules that mail issued report forms, and the log of what they mailed (ENT-4d). The rules are in `delivery-rules.ts`; the database holds the invariants (V2840). */
export class ReportMailStore {
  async createSchedule(tx: TenantTx, request: DeliveryScheduleRequest, by: string): Promise<MailScheduleRow> {
    // Only members of this tenant who are active receive a form: a recipient who is not is refused when the schedule is made, and judged again every time a message is sent.
    const found = await tx.query<{ membership_id: string }>(`select membership_id from machvon.tenant_user_directory where membership_id = any($1::uuid[]) and status = 'ACTIVE'`, [request.recipients]);
    if (found.length !== request.recipients.length) throw new DomainError('RECIPIENT_OUT_OF_TENANT', 422, 'recipients');
    const [row] = await tx.query<ScheduleSql>(
      `insert into machvon.report_mail_schedule (tenant_id, layout_code, cron, format, recipients, note, created_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3, $4::uuid[], $5, $6) returning ${SCHEDULE_COLUMNS}`,
      [request.layoutCode, request.cron, request.format, request.recipients, request.note, by],
    );
    return scheduleOf(row as ScheduleSql);
  }

  async findSchedule(tx: TenantTx, id: string, lock = false): Promise<MailScheduleRow | undefined> {
    const [row] = await tx.query<ScheduleSql>(`select ${SCHEDULE_COLUMNS} from machvon.report_mail_schedule where id = $1::uuid${lock ? ' for update' : ''}`, [id]);
    return row === undefined ? undefined : scheduleOf(row);
  }

  async listSchedules(tx: TenantTx, filter: { status?: string | undefined; layoutCode?: string | undefined }, limit: number): Promise<MailScheduleRow[]> {
    const rows = await tx.query<ScheduleSql>(
      `select ${SCHEDULE_COLUMNS} from machvon.report_mail_schedule where ($1::text is null or status = $1) and ($2::text is null or layout_code = $2) order by created_at desc, id desc limit $3`,
      [filter.status ?? null, filter.layoutCode ?? null, limit],
    );
    return rows.map(scheduleOf);
  }

  /** Retires a schedule, for good, at the version the caller read. */
  async retire(tx: TenantTx, id: string, expectedVersion: number, reason: string, by: string, at: Date): Promise<MailScheduleRow> {
    const current = await this.findSchedule(tx, id, true);
    if (current === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (current.version !== expectedVersion) throw versionConflict(current.version);
    if (current.status === 'RETIRED') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    const [row] = await tx.query<ScheduleSql>(
      `update machvon.report_mail_schedule set status = 'RETIRED', retired_at = $2::timestamptz, retired_by = $3, retire_reason = $4, version = version + 1 where id = $1::uuid returning ${SCHEDULE_COLUMNS}`,
      [id, at.toISOString(), by, reason],
    );
    return scheduleOf(row as ScheduleSql);
  }

  /** The active schedules, locked so that two processes never run the same one at the same time (the one that finds it locked leaves it). */
  async activeForRun(tx: TenantTx): Promise<MailScheduleRow[]> {
    const rows = await tx.query<ScheduleSql>(`select ${SCHEDULE_COLUMNS} from machvon.report_mail_schedule where status = 'ACTIVE' order by created_at, id for update skip locked`, []);
    return rows.map(scheduleOf);
  }

  async markRun(tx: TenantTx, id: string, at: Date): Promise<void> {
    await tx.query('update machvon.report_mail_schedule set last_run_at = $2::timestamptz where id = $1::uuid', [id, at.toISOString()]);
  }

  /** The rows of the log that exist for these copies, by (copy, recipient). */
  async held(tx: TenantTx, scheduleId: string, issueIds: readonly string[]): Promise<Map<string, MailingRow>> {
    if (issueIds.length === 0) return new Map();
    const rows = await tx.query<MailingSql>(`select ${MAILING_COLUMNS} from machvon.report_mailing where schedule_id = $1::uuid and issue_id = any($2::uuid[])`, [scheduleId, [...issueIds]]);
    return new Map(rows.map((row) => [`${row.issue_id}|${row.recipient_id}`, mailingOf(row)]));
  }

  /**
   * Writes the row of a send BEFORE the message is handed to the channel: SENDING with the attempt counted, or, for a copy that FAILED before, the same row moved back to SENDING. A second process that reaches the same
   * (schedule, copy, recipient) finds the row and sends nothing (the unique key, or the guard for a row that is no longer FAILED). Returns undefined when the row was taken by someone else.
   */
  async begin(tx: TenantTx, input: { scheduleId: string; issueId: string; recipientId: string; format: DeliveryFormat; at: Date }): Promise<MailingRow | undefined> {
    await tx.query('savepoint mailing_begin');
    try {
      const [row] = await tx.query<MailingSql>(
        `insert into machvon.report_mailing (tenant_id, schedule_id, issue_id, recipient_id, file_format, status, attempts, first_attempt_at, last_attempt_at)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4, 'SENDING', 1, $5::timestamptz, $5::timestamptz)
         on conflict (tenant_id, schedule_id, issue_id, recipient_id) do update set status = 'SENDING', attempts = machvon.report_mailing.attempts + 1, last_attempt_at = excluded.last_attempt_at, error_code = null
           where machvon.report_mailing.status = 'FAILED'
         returning ${MAILING_COLUMNS}`,
        [input.scheduleId, input.issueId, input.recipientId, input.format, input.at.toISOString()],
      );
      await tx.query('release savepoint mailing_begin');
      return row === undefined ? undefined : mailingOf(row);
    } catch (error) {
      if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
      await tx.query('rollback to savepoint mailing_begin');
      return undefined;
    }
  }

  /** A copy that is not sent, and why: written once, final. */
  async skip(tx: TenantTx, input: { scheduleId: string; issueId: string; recipientId: string; format: DeliveryFormat; reason: string; at: Date }): Promise<void> {
    await tx.query(
      `insert into machvon.report_mailing (tenant_id, schedule_id, issue_id, recipient_id, file_format, status, attempts, error_code, last_attempt_at)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4, 'SKIPPED', 0, $5, $6::timestamptz)
       on conflict (tenant_id, schedule_id, issue_id, recipient_id) do nothing`,
      [input.scheduleId, input.issueId, input.recipientId, input.format, input.reason, input.at.toISOString()],
    );
  }

  /** Settles a send that was SENDING: with what the channel said (or why it never left). */
  async settle(tx: TenantTx, id: string, outcome: DeliveryOutcome, file: { name: string; sha256: string } | undefined, at: Date): Promise<MailingRow> {
    const [row] = await tx.query<MailingSql>(
      `update machvon.report_mailing set status = $2, error_code = $3, provider_message_id = $4, file_name = coalesce($5, file_name), file_sha256 = coalesce($6, file_sha256),
              sent_at = case when $2 = 'SENT' then $7::timestamptz else null end, last_attempt_at = $7::timestamptz
        where id = $1::uuid and status = 'SENDING' returning ${MAILING_COLUMNS}`,
      [id, outcome.status, outcome.errorCode, outcome.providerMessageId, file?.name ?? null, file?.sha256 ?? null, at.toISOString()],
    );
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'mailing');
    return mailingOf(row);
  }

  /** A send that has been SENDING for longer than the rule allows was lost with its process: it may have left, so it is UNKNOWN and is never sent again on its own. Returns how many. */
  async settleLost(tx: TenantTx, now: Date): Promise<number> {
    const rows = await tx.query<{ id: string }>(
      `update machvon.report_mailing set status = 'UNKNOWN', error_code = 'SEND_RESULT_LOST'
        where status = 'SENDING' and last_attempt_at < $1::timestamptz - make_interval(mins => $2::int) returning id`,
      [now.toISOString(), DELIVERY_LOST_AFTER_MINUTES],
    );
    return rows.length;
  }

  async list(tx: TenantTx, filter: { scheduleId?: string | undefined; issueId?: string | undefined; recipientId?: string | undefined; status?: string | undefined }, limit: number): Promise<MailingRow[]> {
    const rows = await tx.query<MailingSql>(
      `select ${MAILING_COLUMNS} from machvon.report_mailing
        where ($1::uuid is null or schedule_id = $1::uuid) and ($2::uuid is null or issue_id = $2::uuid) and ($3::uuid is null or recipient_id = $3::uuid) and ($4::text is null or status = $4)
        order by created_at desc, id desc limit $5`,
      [filter.scheduleId ?? null, filter.issueId ?? null, filter.recipientId ?? null, filter.status ?? null, limit],
    );
    return rows.map(mailingOf);
  }

  /** The address of a member, read for one send and held in memory for it; the directory masks it unless the transaction says the reader may see it. */
  async addressOf(tx: TenantTx, membershipId: string): Promise<string | undefined> {
    await tx.query("select set_config('app.can_read_pii', 'true', true)", []);
    const [row] = await tx.query<{ value: string | null }>("select email as value from machvon.tenant_user_directory where membership_id = $1::uuid and status = 'ACTIVE'", [membershipId]);
    return row?.value ?? undefined;
  }
}
