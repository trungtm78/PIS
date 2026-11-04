import { DomainError, PROVIDER_CHANNELS, canonicalJson, sha256Hex } from '@machvon/kernel';
import { assertTimestampCursor } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';

const TIME = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const UNIQUE_VIOLATION = '23505';
export const MAX_TEST_RECIPIENTS = 10;

export type NotificationTemplateStatus = 'Draft' | 'InReview' | 'PendingProvider' | 'Active' | 'Rejected' | 'Retired';

export interface NotificationTemplateRecord {
  id: string;
  code: string;
  channel: string;
  locale: string;
  revision: number;
  purpose: string;
  contentAst: unknown;
  variableSchema: unknown;
  lockscreenSafe: boolean;
  status: NotificationTemplateStatus;
  providerStatus: string;
  createdBy: string;
  approvedBy: string | null;
  supersedesId: string | null;
  createdAt: string;
  version: number;
  sortKey: string;
}

interface TemplateRow {
  id: string;
  code: string;
  channel: string;
  locale: string;
  revision: number;
  purpose: string;
  content_ast: unknown;
  variable_schema: unknown;
  lockscreen_safe: boolean;
  status: NotificationTemplateStatus;
  provider_status: string;
  created_by: string;
  approved_by: string | null;
  supersedes_id: string | null;
  created_at: string;
  version: string;
  sort_key: string;
}

const COLUMNS = `id, code, channel, locale, revision, purpose, content_ast, variable_schema, lockscreen_safe, status, provider_status, created_by, approved_by, supersedes_id, ${TIME('created_at')} as created_at, version::text as version,
  to_char(date_trunc('milliseconds', created_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"000Z"') as sort_key`;

const toRecord = (row: TemplateRow): NotificationTemplateRecord => ({
  id: row.id,
  code: row.code,
  channel: row.channel,
  locale: row.locale,
  revision: row.revision,
  purpose: row.purpose,
  contentAst: row.content_ast,
  variableSchema: row.variable_schema,
  lockscreenSafe: row.lockscreen_safe,
  status: row.status,
  providerStatus: row.provider_status,
  createdBy: row.created_by,
  approvedBy: row.approved_by,
  supersedesId: row.supersedes_id,
  createdAt: row.created_at,
  version: Number(row.version),
  sortKey: row.sort_key,
});

export interface NewNotificationTemplate {
  code: string;
  channel: string;
  locale: string;
  purpose: string;
  contentAst: unknown;
  variableSchema: unknown;
  lockscreenSafe: boolean;
  supersedesId?: string | undefined;
}

/**
 * The template revisions of a tenant (ST-NOT-005, NOT 3.4). A revision of a code, channel and locale is written as a Draft, goes to review, and is approved by another person (a maker is never the checker, judged on the
 * person and not on the membership); the Active revision before it is Retired. What a revision says never changes once it has left Draft: the database refuses it (migration V1443), and so does this store before asking
 * it. The content is judged by the caller (`assertTemplateAllowed`); this store keeps the revisions and the moves.
 */
export class NotificationTemplateStore {
  /** A new Draft, one revision after the latest of its code, channel and locale. A revision it supersedes must be of the same code, channel and locale. */
  async create(tx: TenantTx, input: NewNotificationTemplate, actor: string): Promise<NotificationTemplateRecord> {
    if (input.supersedesId !== undefined) {
      const [older] = await tx.query<{ code: string; channel: string; locale: string }>('select code, channel, locale from machvon.notification_template_version where id = $1::uuid', [input.supersedesId]);
      if (older === undefined || older.code !== input.code || older.channel !== input.channel || older.locale !== input.locale) throw new DomainError('TEMPLATE_INVALID', 422, 'supersedes_id');
    }
    const contentHash = sha256Hex(canonicalJson({ content: input.contentAst, variables: input.variableSchema, purpose: input.purpose, lockscreen_safe: input.lockscreenSafe }));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const [latest] = await tx.query<{ revision: number | null }>('select max(revision) as revision from machvon.notification_template_version where code = $1 and channel = $2 and locale = $3', [input.code, input.channel, input.locale]);
      await tx.query('savepoint notification_template_revision');
      try {
        const [row] = await tx.query<TemplateRow>(
          `insert into machvon.notification_template_version
             (tenant_id, id, code, channel, locale, revision, content_ast, variable_schema, status, purpose, lockscreen_safe, content_hash, created_by, supersedes_id)
           values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, $6::jsonb, 'Draft', $7, $8, $9, $10::uuid, $11::uuid) returning ${COLUMNS}`,
          [input.code, input.channel, input.locale, (latest?.revision ?? 0) + 1, JSON.stringify(input.contentAst), JSON.stringify(input.variableSchema), input.purpose, input.lockscreenSafe, contentHash, actor, input.supersedesId ?? null],
        );
        await tx.query('release savepoint notification_template_revision');
        return toRecord(row as TemplateRow);
      } catch (error) {
        // Two revisions written at the same moment ask for the same number: the second goes back to before its insert and asks again.
        if ((error as { code?: string }).code !== UNIQUE_VIOLATION || attempt === 2) throw error;
        await tx.query('rollback to savepoint notification_template_revision');
      }
    }
    throw new Error('unreachable');
  }

  private async lock(tx: TenantTx, id: string): Promise<NotificationTemplateRecord> {
    const [row] = await tx.query<TemplateRow>(`select ${COLUMNS} from machvon.notification_template_version where id = $1::uuid for update`, [id]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return toRecord(row);
  }

  private async move(tx: TenantTx, id: string, status: NotificationTemplateStatus, extra: { approvedBy?: string } = {}): Promise<NotificationTemplateRecord> {
    const [row] = await tx.query<TemplateRow>(
      `update machvon.notification_template_version set status = $2, approved_by = coalesce($3::uuid, approved_by), version = version + 1 where id = $1::uuid returning ${COLUMNS}`,
      [id, status, extra.approvedBy ?? null],
    );
    return toRecord(row as TemplateRow);
  }

  /**
   * Sends a Draft to review at the version read: an e-mail, SMS, push or inbox template to InReview, a template of a provider (Zalo ZNS, WhatsApp) to PendingProvider. `check` judges the content again with the
   * revision locked. A revision that is not a Draft is 409 `TEMPLATE_IMMUTABLE`.
   */
  async submit(tx: TenantTx, id: string, expectedVersion: number, check: (template: NotificationTemplateRecord) => void): Promise<NotificationTemplateRecord> {
    const current = await this.lock(tx, id);
    if (current.version !== expectedVersion) throw new DomainError('VERSION_CONFLICT', 409, undefined, { extensions: { current_version: current.version } });
    if (current.status !== 'Draft') throw new DomainError('TEMPLATE_IMMUTABLE', 409, 'status');
    check(current);
    return this.move(tx, id, PROVIDER_CHANNELS.has(current.channel) ? 'PendingProvider' : 'InReview');
  }

  /**
   * Decides a revision that waits: not by the person who wrote it (403 `SELF_APPROVAL_DENIED`). Approving makes it Active and Retires the Active revision of the same code, channel and locale; a template of a provider
   * that the provider has not approved is 409 `TEMPLATE_PROVIDER_PENDING`. Returning sends it back to Draft, rejecting closes it.
   */
  async decide(tx: TenantTx, id: string, expectedVersion: number, decision: 'approve' | 'return' | 'reject', approver: string): Promise<NotificationTemplateRecord> {
    // Approvals of the revisions of one line go one at a time: each locks its own row, so without this two of them could both retire the Active revision and both become Active.
    const [line] = await tx.query<{ code: string; channel: string; locale: string }>('select code, channel, locale from machvon.notification_template_version where id = $1::uuid', [id]);
    if (line === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await tx.query("select pg_advisory_xact_lock(hashtext('notification-template-line:' || current_setting('app.tenant_id', true) || ':' || $1 || ':' || $2 || ':' || $3))", [line.code, line.channel, line.locale]);
    const current = await this.lock(tx, id);
    if (current.version !== expectedVersion) throw new DomainError('VERSION_CONFLICT', 409, undefined, { extensions: { current_version: current.version } });
    if (current.status !== 'InReview' && current.status !== 'PendingProvider') throw new DomainError('TEMPLATE_IMMUTABLE', 409, 'status');
    const people = await tx.query<{ id: string; user_id: string }>('select id, user_id from machvon.membership where id = any($1::uuid[])', [[current.createdBy, approver]]);
    const userOf = (membershipId: string): string | undefined => people.find((row) => row.id === membershipId)?.user_id;
    const approverUser = userOf(approver);
    if (current.createdBy === approver || (approverUser !== undefined && userOf(current.createdBy) === approverUser)) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    if (decision === 'return') return this.move(tx, id, 'Draft');
    if (decision === 'reject') return this.move(tx, id, 'Rejected');
    if (current.status === 'PendingProvider' && current.providerStatus !== 'PROVIDER_APPROVED') throw new DomainError('TEMPLATE_PROVIDER_PENDING', 409);
    // One Active revision for each code, channel and locale: the one before it is Retired in the same transaction.
    await tx.query(
      "update machvon.notification_template_version set status = 'Retired', version = version + 1 where code = $1 and channel = $2 and locale = $3 and status = 'Active' and id <> $4::uuid",
      [current.code, current.channel, current.locale, id],
    );
    return this.move(tx, id, 'Active', { approvedBy: approver });
  }

  async find(tx: TenantTx, id: string): Promise<NotificationTemplateRecord | undefined> {
    const [row] = await tx.query<TemplateRow>(`select ${COLUMNS} from machvon.notification_template_version where id = $1::uuid`, [id]);
    return row === undefined ? undefined : toRecord(row);
  }

  /** The revisions of the tenant, newest first, a page at a time; optionally of one code, channel, locale or status. */
  async list(
    tx: TenantTx,
    filters: { code?: string | undefined; channel?: string | undefined; locale?: string | undefined; status?: string | undefined },
    page: { limit: number; after: { code: string; id: string } | undefined },
  ): Promise<NotificationTemplateRecord[]> {
    assertTimestampCursor(page.after?.code);
    const rows = await tx.query<TemplateRow>(
      `select ${COLUMNS} from machvon.notification_template_version
        where ($1::text is null or code = $1) and ($2::text is null or channel = $2) and ($3::text is null or locale = $3) and ($4::text is null or status = $4)
          and ($5::timestamptz is null or (date_trunc('milliseconds', created_at), id) < ($5::timestamptz, $6::uuid))
        order by date_trunc('milliseconds', created_at) desc, id desc limit $7::int`,
      [filters.code ?? null, filters.channel ?? null, filters.locale ?? null, filters.status ?? null, page.after?.code ?? null, page.after?.id ?? null, page.limit],
    );
    return rows.map(toRecord);
  }

  // ---- the people a test message may go to ---------------------------------------------------------------------------------------------

  /** The memberships the tenant listed for test sends. */
  async testRecipients(tx: TenantTx): Promise<string[]> {
    const rows = await tx.query<{ membership_id: string }>('select membership_id from machvon.notification_test_recipient order by created_at, membership_id');
    return rows.map((row) => row.membership_id);
  }

  /** Replaces the list: at most ten people, each an Active membership of the tenant (else 422 `TEST_RECIPIENT_NOT_ALLOWED`). */
  async replaceTestRecipients(tx: TenantTx, membershipIds: readonly string[], actor: string): Promise<{ added: string[]; removed: string[] }> {
    // One replacement at a time for the tenant, the first included: the list is read and changed under this lock, so two of them cannot both add to an empty list and go past the limit.
    await tx.query("select pg_advisory_xact_lock(hashtext('notification-test-recipients:' || current_setting('app.tenant_id', true)))", []);
    const wanted = [...new Set(membershipIds.map((id) => id.toLowerCase()))];
    if (wanted.length > MAX_TEST_RECIPIENTS) throw new DomainError('TEST_RECIPIENT_NOT_ALLOWED', 422, 'membership_ids');
    if (wanted.length > 0) {
      const known = await tx.query<{ id: string }>("select id from machvon.membership where id = any($1::uuid[]) and status = 'Active'", [wanted]);
      if (known.length !== wanted.length) throw new DomainError('TEST_RECIPIENT_NOT_ALLOWED', 422, 'membership_ids');
    }
    const before = await this.testRecipients(tx);
    const removed = before.filter((id) => !wanted.includes(id));
    const added = wanted.filter((id) => !before.includes(id));
    if (removed.length > 0) await tx.query('delete from machvon.notification_test_recipient where membership_id = any($1::uuid[])', [removed]);
    for (const id of added) {
      await tx.query(
        "insert into machvon.notification_test_recipient (tenant_id, membership_id, added_by) values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid)",
        [id, actor],
      );
    }
    return { added, removed };
  }
}
