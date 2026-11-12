import { randomUUID } from 'node:crypto';
import { DomainError, signOffOf } from '@machvon/kernel';
import type { PublicationCheck, PublicationDecision, PublicationKind, SignOffBlock, SignOffEntry } from '@machvon/kernel';
import { assertTimestampCursor } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';

export type PublicationStatus = 'PENDING' | 'DECIDED' | 'WITHDRAWN';

export interface PublicationRow {
  id: string;
  objectKind: PublicationKind;
  objectId: string;
  /** The code and the revision of what the request is about, as it is now (a metric, the dashboard a version belongs to, the dataset a policy is over). */
  objectCode: string | null;
  objectRevision: number | null;
  requestedBy: string;
  requestedByName: string | null;
  checks: PublicationCheck[];
  decision: PublicationDecision | null;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  comment: string | null;
  /** The check step (BC.02): who checked the request, when and what they said; null while nobody has. */
  checkedBy: string | null;
  checkedByName: string | null;
  checkedAt: string | null;
  checkComment: string | null;
  status: PublicationStatus;
  createdAt: string;
  version: number;
}

export interface PublicationFilter {
  status?: string | undefined;
  objectKind?: string | undefined;
}

interface Sql {
  [column: string]: unknown;
  id: string;
  object_kind: "METRIC" | "DASHBOARD" | "ACCESS_POLICY";
  object_id: string;
  object_code: string | null;
  object_revision: number | null;
  requested_by: string;
  requested_by_name: string | null;
  decision: "REJECTED" | "APPROVED" | null;
  decided_by: string | null;
  decided_by_name: string | null;
  checked_by: string | null;
  checked_by_name: string | null;
  check_comment: string | null;
  comment: string | null;
  status: PublicationStatus;
  sort_key: string;
}

const iso = (value: unknown): string => new Date(value as string).toISOString();
const UNIQUE_VIOLATION = '23505';
const SAVEPOINT = 'bi_publication_request';

const SELECT = `select r.id, r.object_kind, r.object_id, r.requested_by, r.checks_json, r.decision, r.decided_by, r.decided_at, r.comment, r.checked_by, r.checked_at, r.check_comment, r.status, r.created_at, r.version::text as version,
  to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as sort_key,
  (select u.display_name from machvon.tenant_user_directory u where u.tenant_id = r.tenant_id and u.membership_id = r.requested_by) as requested_by_name,
  (select u.display_name from machvon.tenant_user_directory u where u.tenant_id = r.tenant_id and u.membership_id = r.decided_by) as decided_by_name,
  (select u.display_name from machvon.tenant_user_directory u where u.tenant_id = r.tenant_id and u.membership_id = r.checked_by) as checked_by_name,
  case r.object_kind
    when 'METRIC' then (select m.code from machvon.metric_definition m where m.tenant_id = r.tenant_id and m.id = r.object_id)
    when 'DASHBOARD' then (select d.code from machvon.dashboard_version v join machvon.dashboard d on d.tenant_id = v.tenant_id and d.id = v.dashboard_id where v.tenant_id = r.tenant_id and v.id = r.object_id)
    else (select ds.dataset_code from machvon.bi_access_policy p join machvon.bi_dataset ds on ds.tenant_id = p.tenant_id and ds.id = p.dataset_id where p.tenant_id = r.tenant_id and p.id = r.object_id) end as object_code,
  case r.object_kind
    when 'METRIC' then (select m.revision from machvon.metric_definition m where m.tenant_id = r.tenant_id and m.id = r.object_id)
    when 'DASHBOARD' then (select v.revision from machvon.dashboard_version v where v.tenant_id = r.tenant_id and v.id = r.object_id)
    else (select p.revision from machvon.bi_access_policy p where p.tenant_id = r.tenant_id and p.id = r.object_id) end as object_revision
  from machvon.bi_publication_request r`;

const toRow = (row: Sql): PublicationRow => ({
  id: row.id,
  objectKind: row.object_kind,
  objectId: row.object_id,
  objectCode: row.object_code,
  objectRevision: row.object_revision,
  requestedBy: row.requested_by,
  requestedByName: row.requested_by_name,
  checks: (row.checks_json as { checks?: PublicationCheck[] }).checks ?? [],
  decision: row.decision,
  decidedBy: row.decided_by,
  decidedByName: row.decided_by_name,
  decidedAt: row.decided_at === null ? null : iso(row.decided_at),
  comment: row.comment,
  checkedBy: row.checked_by,
  checkedByName: row.checked_by_name,
  checkedAt: row.checked_at === null ? null : iso(row.checked_at),
  checkComment: row.check_comment,
  status: row.status,
  createdAt: iso(row.created_at),
  version: Number(row.version),
});

interface SignOffSql {
  [column: string]: unknown;
  id: string;
  revision: number;
  prepared_by: string | null;
  prepared_at: string | null;
  prepared_name: string | null;
  checked_by: string | null;
  checked_at: string | null;
  checked_name: string | null;
  approved_by: string | null;
  approved_at: string | null;
  approved_name: string | null;
}

const signature = (id: string | null, name: string | null, at: string | null): SignOffEntry | null => (id === null || at === null ? null : { id, name, at: iso(at) });
const signOffRow = (row: SignOffSql): SignOffBlock =>
  signOffOf({
    versionId: row.id,
    revision: row.revision,
    prepared: signature(row.prepared_by, row.prepared_name, row.prepared_at),
    checked: signature(row.checked_by, row.checked_name, row.checked_at),
    approved: signature(row.approved_by, row.approved_name, row.approved_at),
  });

/**
 * The requests to publish (ST-BI-006, BI 3 F5): to certify a metric, to publish a version of a dashboard, to activate an access policy. One request is pending for an object at a time, it carries the checks it was made
 * with, and it is decided once, by someone other than who asked (the database refuses otherwise). What the decision does to the object is the business of the stores of the object.
 */
export class BiPublicationStore {
  async find(tx: TenantTx, id: string): Promise<PublicationRow | undefined> {
    const rows = await tx.query<Sql>(`${SELECT} where r.id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  /** The request locked for its decision. */
  async lock(tx: TenantTx, id: string): Promise<PublicationRow | undefined> {
    const rows = await tx.query<{ id: string }>('select id from machvon.bi_publication_request where id = $1::uuid for update', [id]);
    return rows[0] === undefined ? undefined : this.find(tx, id);
  }

  /** The pending request for an object, if there is one. */
  async pendingFor(tx: TenantTx, kind: PublicationKind, objectId: string): Promise<PublicationRow | undefined> {
    const rows = await tx.query<Sql>(`${SELECT} where r.object_kind = $1 and r.object_id = $2::uuid and r.status = 'PENDING'`, [kind, objectId]);
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  /** The requests, the newest first, narrowed by their state and by what they are about. */
  async list(tx: TenantTx, filter: PublicationFilter, page: { limit: number; after: { at: string; id: string } | undefined }): Promise<{ records: PublicationRow[]; next: { at: string; id: string } | undefined }> {
    assertTimestampCursor(page.after?.at);
    const rows = await tx.query<Sql>(
      `${SELECT}
        where ($1::text is null or r.status = $1) and ($2::text is null or r.object_kind = $2) and ($3::timestamptz is null or (r.created_at, r.id) < ($3::timestamptz, $4::uuid))
        order by r.created_at desc, r.id desc limit $5::int`,
      [filter.status ?? null, filter.objectKind ?? null, page.after?.at ?? null, page.after?.id ?? null, page.limit + 1],
    );
    const shown = rows.slice(0, page.limit);
    const last = shown.at(-1);
    return { records: shown.map(toRow), next: rows.length > page.limit && last !== undefined ? { at: last.sort_key, id: last.id } : undefined };
  }

  /** A request is made with the checks it passed; a second one for an object that has one pending is 409 `PUBLICATION_ALREADY_PENDING`. */
  async create(tx: TenantTx, input: { kind: PublicationKind; objectId: string; requestedBy: string; checks: readonly PublicationCheck[] }): Promise<PublicationRow> {
    const id = randomUUID();
    await tx.query(`savepoint ${SAVEPOINT}`);
    try {
      await tx.query(
        `insert into machvon.bi_publication_request (tenant_id, id, object_kind, object_id, requested_by, checks_json, status, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3::uuid, $4::uuid, $5::jsonb, 'PENDING', $4::uuid, $4::uuid)`,
        [id, input.kind, input.objectId, input.requestedBy, JSON.stringify({ checks: input.checks })],
      );
      await tx.query(`release savepoint ${SAVEPOINT}`);
    } catch (error) {
      if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
      await tx.query(`rollback to savepoint ${SAVEPOINT}`);
      throw new DomainError('PUBLICATION_ALREADY_PENDING', 409, 'object_id');
    }
    return (await this.find(tx, id)) as PublicationRow;
  }

  /** The check is written once while the request is pending, with who checked and when. */
  async check(tx: TenantTx, id: string, input: { checkedBy: string; comment: string | null }): Promise<PublicationRow> {
    await tx.query(
      "update machvon.bi_publication_request set checked_by = $2::uuid, checked_at = now(), check_comment = $3, updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid and status = 'PENDING' and checked_by is null",
      [id, input.checkedBy, input.comment],
    );
    return (await this.find(tx, id)) as PublicationRow;
  }

  /**
   * The three signatures of versions of a dashboard: the author of the version prepared it, the check is the one of the request that is pending for it or that approved it (the check of a rejected request is not
   * carried to a later publication), the approval is the publication of the version. A step nobody took is null.
   */
  async signOffsOfVersions(tx: TenantTx, versionIds: readonly string[]): Promise<Map<string, SignOffBlock>> {
    const rows = await tx.query<SignOffSql>(
      `select v.id, v.revision, v.created_by as prepared_by, v.created_at as prepared_at, v.published_by as approved_by, v.published_at as approved_at, c.checked_by, c.checked_at,
              (select u.display_name from machvon.tenant_user_directory u where u.tenant_id = v.tenant_id and u.membership_id = v.created_by) as prepared_name,
              (select u.display_name from machvon.tenant_user_directory u where u.tenant_id = v.tenant_id and u.membership_id = v.published_by) as approved_name,
              (select u.display_name from machvon.tenant_user_directory u where u.tenant_id = v.tenant_id and u.membership_id = c.checked_by) as checked_name
         from machvon.dashboard_version v
         left join lateral (select r.checked_by, r.checked_at from machvon.bi_publication_request r
                             where r.tenant_id = v.tenant_id and r.object_kind = 'DASHBOARD' and r.object_id = v.id and r.checked_by is not null and (r.status = 'PENDING' or r.decision = 'APPROVED')
                             order by r.created_at desc, r.id desc limit 1) c on true
        where v.id = any($1::uuid[])`,
      [versionIds],
    );
    return new Map(rows.map((row) => [row.id, signOffRow(row)]));
  }

  /**
   * The signatures an export carries: the person the file is made for prepared it, the check is the one of the request that certified the metric, and the approval is the certification of the metric. A metric that the
   * platform certified (no request) has no checker, and nobody is made up.
   */
  async signOffOfMetric(tx: TenantTx, metricId: string, preparer: { id: string; at: Date }): Promise<SignOffBlock> {
    const rows = await tx.query<SignOffSql>(
      `select m.id, m.revision, $2::uuid as prepared_by, $3::timestamptz as prepared_at, m.certified_by as approved_by, m.certified_at as approved_at, c.checked_by, c.checked_at,
              (select u.display_name from machvon.tenant_user_directory u where u.tenant_id = m.tenant_id and u.membership_id = $2::uuid) as prepared_name,
              (select u.display_name from machvon.tenant_user_directory u where u.tenant_id = m.tenant_id and u.membership_id = m.certified_by) as approved_name,
              (select u.display_name from machvon.tenant_user_directory u where u.tenant_id = m.tenant_id and u.membership_id = c.checked_by) as checked_name
         from machvon.metric_definition m
         left join lateral (select r.checked_by, r.checked_at from machvon.bi_publication_request r
                             where r.tenant_id = m.tenant_id and r.object_kind = 'METRIC' and r.object_id = m.id and r.checked_by is not null and r.decision = 'APPROVED'
                             order by r.created_at desc, r.id desc limit 1) c on true
        where m.id = $1::uuid`,
      [metricId, preparer.id, preparer.at.toISOString()],
    );
    const row = rows[0];
    return row === undefined ? signOffOf({ versionId: null, revision: null, prepared: { id: preparer.id, name: null, at: preparer.at.toISOString() }, checked: null, approved: null }) : signOffRow(row);
  }

  /** The decision is written once, with who decided and when. */
  async decide(tx: TenantTx, id: string, input: { decision: PublicationDecision; decidedBy: string; comment: string | null }): Promise<PublicationRow> {
    await tx.query(
      "update machvon.bi_publication_request set status = 'DECIDED', decision = $2, decided_by = $3::uuid, decided_at = now(), comment = $4, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid",
      [id, input.decision, input.decidedBy, input.comment],
    );
    return (await this.find(tx, id)) as PublicationRow;
  }
}
