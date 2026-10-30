import { DomainError, canonicalJson, sha256Hex } from '@machvon/kernel';
import { assertTimestampCursor } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';

const TIME = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const UNIQUE_VIOLATION = '23505';

/** One event type of the catalogue of the platform (NOT-05): what a workflow may be written for. */
export interface EventTypeEntry {
  eventType: string;
  owningModule: string;
  schemaVersion: number;
  allowedPurposes: string[];
  dataClassification: 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'PERSONAL';
  status: 'Active' | 'Deprecated';
}

/** A notification workflow of the tenant: a `workflow_version` of kind NOTIFICATION, one per event type and revision. */
export interface NotificationWorkflowRecord {
  id: string;
  eventType: string;
  revision: number;
  status: 'Draft' | 'Published' | 'Superseded' | 'Retired';
  definition: unknown;
  createdBy: string;
  publishedBy: string | null;
  createdAt: string;
  publishedAt: string | null;
  supersedesId: string | null;
  version: number;
  sortKey: string;
}

interface WorkflowRow {
  id: string;
  event_type: string;
  revision: number;
  status: NotificationWorkflowRecord['status'];
  definition_json: unknown;
  created_by: string;
  published_by: string | null;
  created_at: string;
  published_at: string | null;
  supersedes_id: string | null;
  version: string;
  sort_key: string;
}

const COLUMNS = `id, event_type, revision, status, definition_json, created_by, published_by, ${TIME('created_at')} as created_at, ${TIME('published_at')} as published_at, supersedes_id, version::text as version, to_char(date_trunc('milliseconds', created_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"000Z"') as sort_key`;

const toRecord = (row: WorkflowRow): NotificationWorkflowRecord => ({
  id: row.id,
  eventType: row.event_type,
  revision: row.revision,
  status: row.status,
  definition: row.definition_json,
  createdBy: row.created_by,
  publishedBy: row.published_by,
  createdAt: row.created_at,
  publishedAt: row.published_at,
  supersedesId: row.supersedes_id,
  version: Number(row.version),
  sortKey: row.sort_key,
});

interface CatalogueRow {
  event_type: string;
  owning_module: string;
  schema_version: number;
  allowed_purposes: string[];
  data_classification: EventTypeEntry['dataClassification'];
  status: EventTypeEntry['status'];
}

const toEntry = (row: CatalogueRow): EventTypeEntry => ({
  eventType: row.event_type,
  owningModule: row.owning_module,
  schemaVersion: row.schema_version,
  allowedPurposes: row.allowed_purposes,
  dataClassification: row.data_classification,
  status: row.status,
});

/**
 * The notification workflows of a tenant (ST-NOT-004, NOT 3.1, BR-NOT-15): who is told about an event type, how and when, written as a definition and published by another person than its author. The definition is
 * checked by the caller (it knows the catalogue entry); this store keeps the revisions, the one in force for each event type, and the rule that a person does not publish what they wrote. A notification created after a
 * publication is written from the new revision (`NotificationStore.workflowFor` takes the latest Published), and the notifications made before keep the revision they were made from (`workflow_version_id`).
 */
export class NotificationWorkflowStore {
  /** The catalogue of the platform, through the function that gives a tenant what it may see of it. */
  async eventTypes(tx: TenantTx): Promise<EventTypeEntry[]> {
    const rows = await tx.query<CatalogueRow>('select event_type, owning_module, schema_version, allowed_purposes, data_classification, status from machvon.notification_event_catalogue()');
    return rows.map(toEntry);
  }

  /** The entry of an event type that is accepted now (the latest schema version that is Active), or undefined. */
  async activeEventType(tx: TenantTx, eventType: string): Promise<EventTypeEntry | undefined> {
    const entries = (await this.eventTypes(tx)).filter((entry) => entry.eventType === eventType && entry.status === 'Active');
    return entries.sort((a, b) => b.schemaVersion - a.schemaVersion)[0];
  }

  /** A new draft of an event type, one revision after the latest of the event type (whatever business type an older workflow of it has). The business type of a workflow written here is its event type. */
  async createDraft(tx: TenantTx, input: { eventType: string; definition: unknown }, actor: string): Promise<NotificationWorkflowRecord> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const [latest] = await tx.query<{ revision: number | null }>("select max(revision) as revision from machvon.workflow_version where kind = 'NOTIFICATION' and event_type = $1", [input.eventType]);
      await tx.query('savepoint notification_workflow_revision');
      try {
        const [row] = await tx.query<WorkflowRow>(
          `insert into machvon.workflow_version (tenant_id, id, business_type, event_type, revision, definition_json, status, kind, created_by, last_edited_by, definition_hash)
           values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $1, $2, $3::jsonb, 'Draft', 'NOTIFICATION', $4::uuid, $4::uuid, $5) returning ${COLUMNS}`,
          [input.eventType, (latest?.revision ?? 0) + 1, JSON.stringify(input.definition), actor, sha256Hex(canonicalJson(input.definition))],
        );
        await tx.query('release savepoint notification_workflow_revision');
        return toRecord(row as WorkflowRow);
      } catch (error) {
        // Two drafts made at the same moment ask for the same revision: the second goes back to before its insert and asks again.
        if ((error as { code?: string }).code !== UNIQUE_VIOLATION || attempt === 2) throw error;
        await tx.query('rollback to savepoint notification_workflow_revision');
      }
    }
    throw new Error('unreachable');
  }

  private async lock(tx: TenantTx, id: string): Promise<NotificationWorkflowRecord> {
    const [row] = await tx.query<WorkflowRow>(`select ${COLUMNS} from machvon.workflow_version where id = $1::uuid and kind = 'NOTIFICATION' for update`, [id]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return toRecord(row);
  }

  /**
   * Publishes a draft at the version read: not by the person who wrote it (403 `SELF_APPROVAL_DENIED`, judged on the person and not on the membership), and the one in force for the event type becomes Superseded. `check`
   * judges the definition against the entry of the catalogue while the draft is locked.
   */
  async publish(
    tx: TenantTx,
    id: string,
    expectedVersion: number,
    publisher: string,
    now: Date,
    check: (workflow: NotificationWorkflowRecord) => Promise<void>,
  ): Promise<{ workflow: NotificationWorkflowRecord; supersededId: string | null }> {
    // Publications of one event type go one at a time: the lock is taken before the one in force is read, so a second publication finds the first and supersedes it.
    const [peek] = await tx.query<{ event_type: string }>("select event_type from machvon.workflow_version where id = $1::uuid and kind = 'NOTIFICATION'", [id]);
    if (peek === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await tx.query("select pg_advisory_xact_lock(hashtext('notification-workflow-publish:' || current_setting('app.tenant_id', true) || ':' || $1))", [peek.event_type]);
    const current = await this.lock(tx, id);
    if (current.version !== expectedVersion) throw new DomainError('VERSION_CONFLICT', 409, undefined, { extensions: { current_version: current.version } });
    if (current.status !== 'Draft') throw new DomainError('WORKFLOW_NOT_DRAFT', 409, 'status');
    const people = await tx.query<{ id: string; user_id: string }>('select id, user_id from machvon.membership where id = any($1::uuid[])', [[current.createdBy, publisher]]);
    const userOf = (membershipId: string): string | undefined => people.find((row) => row.id === membershipId)?.user_id;
    const publisherUser = userOf(publisher);
    if (current.createdBy === publisher || (publisherUser !== undefined && userOf(current.createdBy) === publisherUser)) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    await check(current);
    // Judged by the event type, not by the business type: a workflow written before this story may have another business type, and the core takes the Published revision of the event type.
    const inForce = await tx.query<{ id: string }>("select id from machvon.workflow_version where kind = 'NOTIFICATION' and event_type = $1 and status = 'Published' order by revision desc for update", [current.eventType]);
    for (const older of inForce) await tx.query("update machvon.workflow_version set status = 'Superseded', version = version + 1 where id = $1::uuid", [older.id]);
    const [row] = await tx.query<WorkflowRow>(
      `update machvon.workflow_version set status = 'Published', published_by = $2::uuid, published_at = $3::timestamptz, effective_from = $3::timestamptz, supersedes_id = $4::uuid, version = version + 1
        where id = $1::uuid returning ${COLUMNS}`,
      [id, publisher, now.toISOString(), inForce[0]?.id ?? null],
    );
    return { workflow: toRecord(row as WorkflowRow), supersededId: inForce[0]?.id ?? null };
  }

  async find(tx: TenantTx, id: string): Promise<NotificationWorkflowRecord | undefined> {
    const [row] = await tx.query<WorkflowRow>(`select ${COLUMNS} from machvon.workflow_version where id = $1::uuid and kind = 'NOTIFICATION'`, [id]);
    return row === undefined ? undefined : toRecord(row);
  }

  /** The workflows of the tenant, newest first, a page at a time; optionally of one event type or one status. */
  async list(tx: TenantTx, filters: { eventType?: string | undefined; status?: string | undefined }, page: { limit: number; after: { code: string; id: string } | undefined }): Promise<NotificationWorkflowRecord[]> {
    assertTimestampCursor(page.after?.code);
    const rows = await tx.query<WorkflowRow>(
      `select ${COLUMNS} from machvon.workflow_version
        where kind = 'NOTIFICATION' and ($1::text is null or event_type = $1) and ($2::text is null or status = $2)
          and ($3::timestamptz is null or (date_trunc('milliseconds', created_at), id) < ($3::timestamptz, $4::uuid))
        order by date_trunc('milliseconds', created_at) desc, id desc limit $5::int`,
      [filters.eventType ?? null, filters.status ?? null, page.after?.code ?? null, page.after?.id ?? null, page.limit],
    );
    return rows.map(toRecord);
  }
}
