import { randomUUID } from 'node:crypto';
import { DomainError } from '@machvon/kernel';
import type { PublicationCheck, PublicationDecision, PublicationKind } from '@machvon/kernel';
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
  status: PublicationStatus;
  createdAt: string;
  version: number;
}

export interface PublicationFilter {
  status?: string | undefined;
  objectKind?: string | undefined;
}

interface Sql {
  [column: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const iso = (value: unknown): string => new Date(value as string).toISOString();
const UNIQUE_VIOLATION = '23505';
const SAVEPOINT = 'bi_publication_request';

const SELECT = `select r.id, r.object_kind, r.object_id, r.requested_by, r.checks_json, r.decision, r.decided_by, r.decided_at, r.comment, r.status, r.created_at, r.version::text as version,
  to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as sort_key,
  (select u.display_name from machvon.tenant_user_directory u where u.tenant_id = r.tenant_id and u.membership_id = r.requested_by) as requested_by_name,
  (select u.display_name from machvon.tenant_user_directory u where u.tenant_id = r.tenant_id and u.membership_id = r.decided_by) as decided_by_name,
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
  status: row.status,
  createdAt: iso(row.created_at),
  version: Number(row.version),
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

  /** The decision is written once, with who decided and when. */
  async decide(tx: TenantTx, id: string, input: { decision: PublicationDecision; decidedBy: string; comment: string | null }): Promise<PublicationRow> {
    await tx.query(
      "update machvon.bi_publication_request set status = 'DECIDED', decision = $2, decided_by = $3::uuid, decided_at = now(), comment = $4, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid",
      [id, input.decision, input.decidedBy, input.comment],
    );
    return (await this.find(tx, id)) as PublicationRow;
  }
}
