import { DomainError, versionConflict, vietnamDateOf } from '@machvon/kernel';
import type { CannedReplyDraft, PolicyDraft, RoutingRule } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';
import { WorkCalendarStore } from './work-calendar-store.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const TIME = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const UNIQUE_VIOLATION = '23505';
/** The units a rule may name: the tenant's own, by name; a tenant has hundreds at most. */
const UNITS_MAX = 2000;

/** Where a page of a list begins: the ordering key and the id of the last row of the page before. */
export interface ListAnchor {
  code: string;
  id: string;
}

export type RoutingPolicyStatus = 'Draft' | 'Published' | 'Superseded';

export interface PolicyRecord {
  id: string;
  revision: number;
  status: RoutingPolicyStatus;
  rules: RoutingRule[];
  calendarCode: string;
  firstResponseMinutes: number;
  resolutionHours: number;
  createdBy: string;
  publishedAt: string | null;
  version: number;
  /** The ordering key (the revision, written so that it sorts as text): the cursor of the next page. */
  sortKey: string;
}

interface PolicyRow {
  id: string;
  revision: number;
  status: RoutingPolicyStatus;
  rules_json: Array<{ channels: string[]; keywords: string[]; queue_unit_id: string; priority: RoutingRule['priority'] }>;
  calendar_code: string;
  first_response_minutes: number;
  resolution_hours: number;
  created_by: string;
  published_at: string | null;
  version: string;
  sort_key: string;
}

const COLUMNS = `id, revision, status, rules_json, calendar_code, first_response_minutes, resolution_hours, created_by, ${TIME('published_at')} as published_at, version::text as version, lpad(revision::text, 10, '0') as sort_key`;

const toPolicy = (row: PolicyRow): PolicyRecord => ({
  id: row.id,
  revision: row.revision,
  status: row.status,
  rules: row.rules_json.map((rule) => ({ channels: rule.channels, keywords: rule.keywords, queueUnitId: rule.queue_unit_id, priority: rule.priority })),
  calendarCode: row.calendar_code,
  firstResponseMinutes: row.first_response_minutes,
  resolutionHours: row.resolution_hours,
  createdBy: row.created_by,
  publishedAt: row.published_at,
  version: Number(row.version),
  sortKey: row.sort_key,
});

/** The rules as they are kept: with the names the contract uses. */
const rulesJson = (rules: readonly RoutingRule[]): string => JSON.stringify(rules.map((rule) => ({ channels: rule.channels, keywords: rule.keywords, queue_unit_id: rule.queueUnitId, priority: rule.priority })));

/**
 * The routing policies of the tenant (ST-OMNI-006, OMNI.md 3.1 step 5): written as versions, published once. Every query runs in the caller's tenant transaction; the versions are numbered and published one at a time (a lock of the tenant), so
 * two supervisors never make the same revision or publish two at once.
 */
export class RoutingPolicyStore {
  private readonly calendars = new WorkCalendarStore();

  /** A new version, as a Draft. Every unit the rules name must be a unit of the tenant (422 `POLICY_INVALID` on `rules`). */
  async createDraft(tx: TenantTx, draft: PolicyDraft, createdBy: string): Promise<PolicyRecord> {
    const units = [...new Set(draft.rules.map((rule) => rule.queueUnitId))];
    if (units.length > 0) {
      const [found] = await tx.query<{ n: string }>('select count(*)::text as n from machvon.organization_unit where id = any($1::uuid[])', [units]);
      if (Number(found?.n ?? '0') !== units.length) throw new DomainError('POLICY_INVALID', 422, 'rules');
    }
    await tx.query("select pg_advisory_xact_lock(hashtext('omni-policy:' || current_setting('app.tenant_id', true)))");
    const [made] = await tx.query<PolicyRow>(
      `insert into machvon.conversation_routing_policy (tenant_id, id, revision, rules_json, calendar_code, first_response_minutes, resolution_hours, status, created_by)
       values (${TENANT}, gen_random_uuid(), (select coalesce(max(revision), 0) + 1 from machvon.conversation_routing_policy), $1::jsonb, $2, $3::int, $4::int, 'Draft', $5::uuid)
       returning ${COLUMNS}`,
      [rulesJson(draft.rules), draft.calendarCode, draft.firstResponseMinutes, draft.resolutionHours, createdBy],
    );
    return toPolicy(made as PolicyRow);
  }

  async find(tx: TenantTx, id: string): Promise<PolicyRecord | undefined> {
    const [row] = await tx.query<PolicyRow>(`select ${COLUMNS} from machvon.conversation_routing_policy where id = $1::uuid`, [id]);
    return row === undefined ? undefined : toPolicy(row);
  }

  /** The versions, the newest first, a page at a time (keyset by the revision). */
  async list(tx: TenantTx, page: { limit: number; after: ListAnchor | undefined }): Promise<PolicyRecord[]> {
    if (page.after !== undefined && !/^[0-9]{10}$/.test(page.after.code)) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
    const rows = await tx.query<PolicyRow>(
      `select ${COLUMNS} from machvon.conversation_routing_policy where ($1::text is null or (lpad(revision::text, 10, '0'), id) < ($1::text, $2::uuid)) order by revision desc, id desc limit $3::int`,
      [page.after?.code ?? null, page.after?.id ?? null, page.limit],
    );
    return rows.map(toPolicy);
  }

  /** The units a rule may name as a queue, by name: read with the policy, so that whoever manages the policy needs no other permission to choose a queue. */
  async units(tx: TenantTx): Promise<Array<{ id: string; name: string }>> {
    return await tx.query<{ id: string; name: string }>(`select id, name from machvon.organization_unit where status in ('Planned', 'Active') order by name, id limit ${UNITS_MAX}`);
  }

  /** The version that routes now, or none. */
  async inForce(tx: TenantTx): Promise<PolicyRecord | undefined> {
    const [row] = await tx.query<PolicyRow>(`select ${COLUMNS} from machvon.conversation_routing_policy where status = 'Published'`);
    return row === undefined ? undefined : toPolicy(row);
  }

  /**
   * Publishes a Draft at the version read (409 `VERSION_CONFLICT` if stale, 409 `POLICY_STATE_INVALID` if it is not a Draft). The calendar it counts on must be published for the year of today (422 `POLICY_INVALID` on `calendar_code`): a
   * policy whose deadlines could not be counted would route conversations with none. The version that was in force becomes Superseded.
   */
  async publish(tx: TenantTx, id: string, expectedVersion: number, now: Date): Promise<{ policy: PolicyRecord; superseded: PolicyRecord | undefined }> {
    await tx.query("select pg_advisory_xact_lock(hashtext('omni-policy:' || current_setting('app.tenant_id', true)))");
    const [locked] = await tx.query<PolicyRow>(`select ${COLUMNS} from machvon.conversation_routing_policy where id = $1::uuid for update`, [id]);
    if (locked === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const current = toPolicy(locked);
    if (current.version !== expectedVersion) throw versionConflict(current.version);
    if (current.status !== 'Draft') throw new DomainError('POLICY_STATE_INVALID', 409, 'status');
    const year = Number(vietnamDateOf(now).slice(0, 4));
    if ((await this.calendars.published(tx, current.calendarCode, year)) === undefined) throw new DomainError('POLICY_INVALID', 422, 'calendar_code');
    const previous = await this.inForce(tx);
    if (previous !== undefined) await tx.query("update machvon.conversation_routing_policy set status = 'Superseded', version = version + 1 where id = $1::uuid", [previous.id]);
    const [published] = await tx.query<PolicyRow>(`update machvon.conversation_routing_policy set status = 'Published', published_at = $2::timestamptz, version = version + 1 where id = $1::uuid returning ${COLUMNS}`, [id, now.toISOString()]);
    return { policy: toPolicy(published as PolicyRow), superseded: previous };
  }
}

export type ReplyStatus = 'Active' | 'Retired';

export interface CannedReplyRecord {
  id: string;
  code: string;
  title: string;
  bodyText: string;
  channels: string[];
  classification: string;
  status: ReplyStatus;
  version: number;
}

interface ReplyRow {
  id: string;
  code: string;
  title: string;
  body_text: string;
  channels: string[];
  classification: string;
  status: ReplyStatus;
  version: string;
}

const REPLY_COLUMNS = 'id, code, title, body_text, channels, classification, status, version::text as version';
const toReply = (row: ReplyRow): CannedReplyRecord => ({ id: row.id, code: row.code, title: row.title, bodyText: row.body_text, channels: row.channels, classification: row.classification, status: row.status, version: Number(row.version) });

/** The canned replies of the tenant (BR-OMNI-08): public or internal text with no variable, by code. */
export class CannedReplyStore {
  /** A new reply; a code that is taken (also by two supervisors at once) is 409 `CANNED_CODE_TAKEN`. */
  async create(tx: TenantTx, draft: CannedReplyDraft, createdBy: string): Promise<CannedReplyRecord> {
    await tx.query('savepoint canned_reply_create');
    try {
      const [made] = await tx.query<ReplyRow>(
        `insert into machvon.canned_reply (tenant_id, id, code, title, body_text, channels, classification, status, created_by)
         values (${TENANT}, gen_random_uuid(), $1, $2, $3, $4::text[], $5, 'Active', $6::uuid) returning ${REPLY_COLUMNS}`,
        [draft.code, draft.title, draft.bodyText, draft.channels, draft.classification, createdBy],
      );
      await tx.query('release savepoint canned_reply_create');
      return toReply(made as ReplyRow);
    } catch (error) {
      if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
      await tx.query('rollback to savepoint canned_reply_create');
      throw new DomainError('CANNED_CODE_TAKEN', 409, 'code');
    }
  }

  async find(tx: TenantTx, id: string): Promise<CannedReplyRecord | undefined> {
    const [row] = await tx.query<ReplyRow>(`select ${REPLY_COLUMNS} from machvon.canned_reply where id = $1::uuid`, [id]);
    return row === undefined ? undefined : toReply(row);
  }

  /** The replies by code, a page at a time (keyset by the code and the id). */
  async list(tx: TenantTx, page: { limit: number; after: ListAnchor | undefined }): Promise<CannedReplyRecord[]> {
    const rows = await tx.query<ReplyRow>(
      `select ${REPLY_COLUMNS} from machvon.canned_reply where ($1::text is null or (code, id) > ($1::text, $2::uuid)) order by code, id limit $3::int`,
      [page.after?.code ?? null, page.after?.id ?? null, page.limit],
    );
    return rows.map(toReply);
  }

  /** Changes a reply at the version read (409 `VERSION_CONFLICT` if stale). The code is the reply's name and does not change (422 on `code`). */
  async update(tx: TenantTx, id: string, expectedVersion: number, draft: CannedReplyDraft): Promise<{ before: CannedReplyRecord; after: CannedReplyRecord }> {
    const [locked] = await tx.query<ReplyRow>(`select ${REPLY_COLUMNS} from machvon.canned_reply where id = $1::uuid for update`, [id]);
    if (locked === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const before = toReply(locked);
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    if (draft.code !== before.code) throw new DomainError('VALIDATION_FAILED', 422, 'code');
    const [changed] = await tx.query<ReplyRow>(
      `update machvon.canned_reply set title = $2, body_text = $3, channels = $4::text[], classification = $5, version = version + 1 where id = $1::uuid returning ${REPLY_COLUMNS}`,
      [id, draft.title, draft.bodyText, draft.channels, draft.classification],
    );
    return { before, after: toReply(changed as ReplyRow) };
  }
}

