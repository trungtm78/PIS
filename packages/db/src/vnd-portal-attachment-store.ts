import { randomUUID } from 'node:crypto';
import { DomainError, PORTAL_UPLOAD_MIMES } from '@machvon/kernel';
import type { PortalUploadPurpose } from '@machvon/kernel';
import { BidContractorStore } from './bid-contractor-store.ts';
import { DocumentStore } from './document-store.ts';
import { timestampKey } from './keyset.ts';
import { enterPortalPath } from './portal-boundary.ts';
import type { TenantTx } from './tenant-database.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const ZERO_CONTRACTOR = '00000000-0000-0000-0000-000000000000';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The document type and the module under which a portal file is registered in the DOC framework. */
export const PORTAL_DOC_TYPE = 'VND-PORTAL-ATTACHMENT';
export const PORTAL_SUBJECT_MODULE = 'VND_PORTAL';

export interface PortalAttachmentRow {
  id: string;
  documentId: string;
  purpose: PortalUploadPurpose;
  title: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  uploadedAt: string;
  linkedKind: string | null;
  linkedId: string | null;
}

export interface NewPortalAttachment {
  purpose: PortalUploadPurpose;
  title: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  objectKey: string;
  pageCount: number;
}

interface Sql {
  id: string;
  document_id: string;
  purpose: PortalUploadPurpose;
  title: string;
  mime: string;
  size_bytes: string;
  sha256: string;
  uploaded_at: string;
  linked_kind: string | null;
  linked_id: string | null;
}

const SELECT = `select id, document_id, purpose, title, mime, size_bytes::text as size_bytes, sha256, ${timestampKey('uploaded_at')} as uploaded_at, linked_kind, linked_id from machvon.portal_attachment`;

const toRow = (row: Sql): PortalAttachmentRow => ({
  id: row.id,
  documentId: row.document_id,
  purpose: row.purpose,
  title: row.title,
  mime: row.mime,
  sizeBytes: Number(row.size_bytes),
  sha256: row.sha256,
  uploadedAt: row.uploaded_at,
  linkedKind: row.linked_kind,
  linkedId: row.linked_id,
});

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/**
 * The files of a contractor on the portal (PORTAL-2; docs/plans/portal2.md). The bytes went through the shared upload pipeline (judged, scanned, stored under the tenant) before this store sees them; here the file is registered as
 * a document of the DOC framework (kind ATTACHMENT, subject module `VND_PORTAL`, subject the contractor) and as an attachment of the contractor. The portal path reads only the attachments of its contractor and never the register
 * of documents (V2643), so the id a contractor names in an answer, a certificate or the evidence of an action is checked HERE against its own attachments: a document id of anybody else is simply not found (422, no oracle).
 */
export class VendorPortalAttachmentStore {
  private readonly documents = new DocumentStore();
  private readonly contractors = new BidContractorStore();

  /** Registers a clean, stored file as the document of the contractor the caller is bound to. It runs BEFORE the portal path is entered for the rest of the transaction because the register of documents is closed to that path. */
  async register(tx: TenantTx, membershipId: string, input: NewPortalAttachment): Promise<PortalAttachmentRow> {
    const standing = await this.contractors.callerOf(tx, membershipId);
    if (!standing.guest || standing.contractorId === ZERO_CONTRACTOR) throw new DomainError('PORTAL_CONTRACTOR_REQUIRED', 403);
    const title = input.title.trim();
    if (title.length < 1 || title.length > 200) throw invalid('title');
    if (!(PORTAL_UPLOAD_MIMES as readonly string[]).includes(input.mime)) throw new DomainError('FILE_TYPE_NOT_ALLOWED', 422);
    const document = await this.documents.insertDocument(tx, {
      docKind: 'ATTACHMENT',
      docTypeCode: PORTAL_DOC_TYPE,
      title,
      classification: 'CONFIDENTIAL',
      createdBy: membershipId,
      subjectModule: PORTAL_SUBJECT_MODULE,
      subjectId: standing.contractorId,
    });
    const version = await this.documents.appendVersion(tx, {
      documentId: document.id,
      objectKey: input.objectKey,
      checksum: input.sha256,
      mime: input.mime,
      pageCount: input.pageCount,
      classification: 'CONFIDENTIAL',
      stage: 'ATTACHMENT',
      byteLength: input.sizeBytes,
      createdBy: membershipId,
    });
    await this.documents.setScanResult(tx, version.id, 'CLEAN');
    await enterPortalPath(tx, standing.contractorId);
    const id = randomUUID();
    await tx.query(
      `insert into machvon.portal_attachment (tenant_id, id, contractor_id, document_id, document_version_id, purpose, title, mime, size_bytes, sha256, scan_verdict, uploaded_by)
       values (${TENANT}, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, 'CLEAN', $10::uuid)`,
      [id, standing.contractorId, document.id, version.id, input.purpose, title, input.mime, input.sizeBytes, input.sha256, membershipId],
    );
    return (await this.byId(tx, id)) as PortalAttachmentRow;
  }

  private async byId(tx: TenantTx, id: string): Promise<PortalAttachmentRow | undefined> {
    const rows = await tx.query<Sql>(`${SELECT} where id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  /** The files of the contractor of the portal path (the policy leaves no other row), newest first. */
  async listOwn(tx: TenantTx, purpose?: string | undefined): Promise<PortalAttachmentRow[]> {
    const rows = await tx.query<Sql>(`${SELECT} where ($1::text is null or purpose = $1) order by uploaded_at desc, id limit 200`, [purpose ?? null]);
    return rows.map(toRow);
  }

  /**
   * The document id a contractor names must be one of its own files and not yet attached to something else (422 `VALIDATION_FAILED` on `document_id` otherwise); once the record takes it, it is linked. Call it on the portal
   * path (after `VendorPortalStore.enter`): the policy leaves only the rows of the contractor, so a foreign id is not found.
   */
  async take(tx: TenantTx, documentId: string, kind: 'REQUEST' | 'QUALIFICATION' | 'REMEDIATION_ACTION', linkedId: string): Promise<void> {
    if (!UUID.test(documentId)) throw invalid('document_id');
    const rows = await tx.query<{ id: string; linked_id: string | null }>('select id, linked_id from machvon.portal_attachment where document_id = $1::uuid for update', [documentId]);
    const row = rows[0];
    if (row === undefined) throw invalid('document_id');
    if (row.linked_id !== null && row.linked_id !== linkedId) throw new DomainError('VALIDATION_FAILED', 422, 'document_id', { extensions: { reason: 'FILE_ALREADY_ATTACHED' } });
    await tx.query('update machvon.portal_attachment set linked_kind = $2, linked_id = $3::uuid where id = $1::uuid', [row.id, kind, linkedId]);
  }
}
