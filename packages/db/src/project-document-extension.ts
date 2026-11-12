import { DomainError } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

/**
 * The seam through which an edition adds a meaning to a project document without the repository knowing it (MD.02): the legal-document type of the enterprise edition, a code of the catalogue ENT_LEGAL_DOC_TYPE. The
 * repository commands (`createProjectDocument`, `updateProjectDocument`) are public code; they ask the extension of the process about the field `legal_doc_type` and hand it the document once it exists, in the same
 * transaction. The public edition has the extension below: it holds no catalogue, so a request that names a type is refused and nothing else about the commands changes. The enterprise edition registers its own
 * through the edition loader (`apps/api/src/editions/enterprise`); this file imports nothing of it.
 */

/** What a request says about the legal type: nothing (the member is absent, or null in an edition without the catalogue), or a type to keep, or `null` to clear the type. */
export type LegalDocTypeChange = { readonly set: false } | { readonly set: true; readonly code: string | null };

export interface ProjectDocumentExtension {
  /**
   * Judges the member `legal_doc_type` of a request (`undefined` when the request does not carry it) on the business day, before anything is written. A type the catalogue does not hold is 422 VALIDATION_FAILED on
   * `legal_doc_type`.
   */
  legalDocType(tx: TenantTx, raw: unknown, today: string): Promise<LegalDocTypeChange>;
  /** Keeps (or clears) the type of a document in the transaction of the command; answers what it was and what it is, so the caller can tell the trail. Never called for a change that is not `set`. */
  recordLegalDocType(tx: TenantTx, documentId: string, code: string | null, actor: string): Promise<{ from: string | null; to: string | null }>;
}

/** The extension of an edition that has no legal-document catalogue: the public edition. A request with no type, or a null one, is what it always was; a named type is refused. */
export class PublicProjectDocumentExtension implements ProjectDocumentExtension {
  legalDocType(_tx: TenantTx, raw: unknown): Promise<LegalDocTypeChange> {
    if (raw === undefined || raw === null) return Promise.resolve({ set: false });
    return Promise.reject(new DomainError('VALIDATION_FAILED', 422, 'legal_doc_type', { extensions: { reason: 'NOT_AVAILABLE' } }));
  }

  recordLegalDocType(): Promise<{ from: string | null; to: string | null }> {
    return Promise.resolve({ from: null, to: null });
  }
}
