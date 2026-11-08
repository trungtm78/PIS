import type { TenantTx } from './tenant-database.ts';

export type DocumentRefKind = 'DOCUMENT' | 'PROJECT_DOCUMENT';

export interface DocumentRef {
  title: string;
  /** The hash of the version the reader of the document would get today. */
  sha256: string;
}

/**
 * Resolves a document of DOC by its id: a document of the register (`document`, its current version) or a file of the project repository of DOC-2 (`project_document`, its approved version, else the current one). The title
 * and the hash are what a record of this lane keeps at the moment it links the document, so it can say later exactly what was linked. Row-level security keeps it to the tenant. A document with no version, or a repository
 * that this database does not have, is `undefined`.
 */
export async function resolveDocument(tx: TenantTx, kind: DocumentRefKind, id: string): Promise<DocumentRef | undefined> {
  if (kind === 'DOCUMENT') {
    const [row] = await tx.query<{ title: string; sha: string }>(
      `select d.title, v.checksum as sha from machvon.document d join machvon.document_version v on v.tenant_id = d.tenant_id and v.id = d.current_version_id where d.id = $1::uuid`,
      [id],
    );
    return row === undefined ? undefined : { title: row.title, sha256: row.sha };
  }
  const [present] = await tx.query<{ found: string | null }>(`select to_regclass('machvon.project_document')::text as found`);
  if (present?.found === null || present === undefined) return undefined;
  const [row] = await tx.query<{ title: string; sha: string }>(
    `select d.title, v.file_sha256 as sha from machvon.project_document d join machvon.project_document_version v on v.tenant_id = d.tenant_id and v.id = coalesce(d.approved_version_id, d.current_version_id) where d.id = $1::uuid`,
    [id],
  );
  return row === undefined ? undefined : { title: row.title, sha256: row.sha };
}
