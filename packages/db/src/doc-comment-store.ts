import { DomainError } from '@machvon/kernel';
import type { CommentInput } from '@machvon/kernel';
import { refuseWrite } from './doc-repository-store.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * Comments on a version of a project document (DOC-2, PD.02). A comment belongs to one version, may be anchored to a citation of it and may answer another comment of the same version; what it says and who said it
 * never change; it is OPEN or RESOLVED, and a resolved one can be reopened. The caller has judged that the version is in its scope.
 */

export interface CommentRow {
  id: string;
  documentId: string;
  versionId: string;
  citationId: string | null;
  citationLabel: string | null;
  parentId: string | null;
  reviewId: string | null;
  body: string;
  authorId: string;
  authorName: string | null;
  status: 'OPEN' | 'RESOLVED';
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  createdAt: string;
}

interface CommentSql {
  id: string;
  document_id: string;
  version_id: string;
  citation_id: string | null;
  citation_label: string | null;
  parent_comment_id: string | null;
  review_id: string | null;
  body: string;
  author_id: string;
  author_name: string | null;
  status: 'OPEN' | 'RESOLVED';
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  created_at: string;
}

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const SELECT = `select c.id, c.document_id, c.version_id, c.citation_id, u.label as citation_label, c.parent_comment_id, c.review_id, c.body, c.author_id, d.display_name as author_name, c.status,
       c.resolved_by, to_char(c.resolved_at at time zone 'UTC', ${ISO}) as resolved_at, c.resolution_note, to_char(c.created_at at time zone 'UTC', ${ISO}) as created_at
  from machvon.document_comment c
  left join machvon.document_text_unit u on u.tenant_id = c.tenant_id and u.version_id = c.version_id and u.citation_id = c.citation_id
  left join machvon.tenant_user_directory d on d.tenant_id = c.tenant_id and d.membership_id = c.author_id`;

const commentOf = (row: CommentSql): CommentRow => ({
  id: row.id,
  documentId: row.document_id,
  versionId: row.version_id,
  citationId: row.citation_id,
  citationLabel: row.citation_label,
  parentId: row.parent_comment_id,
  reviewId: row.review_id,
  body: row.body,
  authorId: row.author_id,
  authorName: row.author_name,
  status: row.status,
  resolvedBy: row.resolved_by,
  resolvedAt: row.resolved_at,
  resolutionNote: row.resolution_note,
  createdAt: row.created_at,
});

export class DocumentCommentStore {
  async list(tx: TenantTx, versionId: string, filter: { citationId?: string | undefined; status?: 'OPEN' | 'RESOLVED' | undefined }): Promise<CommentRow[]> {
    const params: unknown[] = [versionId];
    const where = ['c.version_id = $1::uuid'];
    if (filter.citationId !== undefined) {
      params.push(filter.citationId);
      where.push(`c.citation_id = $${params.length}`);
    }
    if (filter.status !== undefined) {
      params.push(filter.status);
      where.push(`c.status = $${params.length}`);
    }
    const rows = await tx.query<CommentSql>(`${SELECT} where ${where.join(' and ')} order by c.created_at, c.id`, params);
    return rows.map(commentOf);
  }

  async find(tx: TenantTx, id: string): Promise<CommentRow | undefined> {
    const rows = await tx.query<CommentSql>(`${SELECT} where c.id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : commentOf(rows[0]);
  }

  /** The open comments of each version of a document, to show on its versions. */
  async openCounts(tx: TenantTx, documentId: string): Promise<Map<string, number>> {
    const rows = await tx.query<{ version_id: string; n: string }>("select version_id, count(*)::text as n from machvon.document_comment where document_id = $1::uuid and status = 'OPEN' group by version_id", [documentId]);
    return new Map(rows.map((row) => [row.version_id, Number(row.n)]));
  }

  /**
   * Adds a comment. The anchor is a unit of this version (422 `DOC_COMMENT_ANCHOR_UNKNOWN`), a reply answers a comment of the same version, one level deep (422 `DOC_COMMENT_PARENT_INVALID`); the review it was
   * made in, when there is one open, is named.
   */
  async add(tx: TenantTx, documentId: string, input: CommentInput, author: string): Promise<CommentRow> {
    if (input.citationId !== null) {
      const anchored = await tx.query<{ n: string }>('select 1::text as n from machvon.document_text_unit where version_id = $1::uuid and citation_id = $2', [input.versionId, input.citationId]);
      if (anchored[0] === undefined) throw new DomainError('DOC_COMMENT_ANCHOR_UNKNOWN', 422, 'citation_id');
    }
    if (input.parentId !== null) {
      const parents = await tx.query<{ version_id: string; parent_comment_id: string | null }>('select version_id, parent_comment_id from machvon.document_comment where id = $1::uuid', [input.parentId]);
      const parent = parents[0];
      if (parent === undefined || parent.version_id !== input.versionId || parent.parent_comment_id !== null) throw new DomainError('DOC_COMMENT_PARENT_INVALID', 422, 'parent_id');
    }
    const [open] = await tx.query<{ id: string }>("select id from machvon.document_review where document_id = $1::uuid and version_id = $2::uuid and status = 'IN_REVIEW'", [documentId, input.versionId]);
    let id: string;
    try {
      const rows = await tx.query<{ id: string }>(
        `insert into machvon.document_comment (tenant_id, document_id, version_id, citation_id, parent_comment_id, review_id, body, author_id)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6, $7::uuid) returning id`,
        [documentId, input.versionId, input.citationId, input.parentId, open?.id ?? null, input.body, author],
      );
      id = (rows[0] as { id: string }).id;
    } catch (error) {
      return refuseWrite(error);
    }
    const created = await this.find(tx, id);
    if (created === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return created;
  }

  /** Resolves an open comment with an optional note, or reopens a resolved one; moving a comment to the state it is in is 409 `DOC_COMMENT_STATE_INVALID`. */
  async setState(tx: TenantTx, id: string, to: 'OPEN' | 'RESOLVED', actor: string, note: string | null): Promise<{ before: CommentRow; after: CommentRow }> {
    const before = await this.find(tx, id);
    if (before === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await tx.query('select id from machvon.document_comment where id = $1::uuid for update', [id]);
    if (before.status === to) throw new DomainError('DOC_COMMENT_STATE_INVALID', 409, 'status', { extensions: { status: before.status } });
    await tx.query(
      `update machvon.document_comment set status = $2, resolved_by = case when $2 = 'RESOLVED' then $3::uuid else null end, resolved_at = case when $2 = 'RESOLVED' then now() else null end,
              resolution_note = case when $2 = 'RESOLVED' then $4 else null end where id = $1::uuid`,
      [id, to, actor, note],
    );
    const after = await this.find(tx, id);
    if (after === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { before, after };
  }
}
