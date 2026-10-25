import { DomainError } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

/** The document type of a decision of the authority (`QD`): the approval of a plan and of a result rests on one. */
export const DECISION_DOCUMENT_TYPE = 'QD';

/**
 * The decision document of an approval: one of the tenant, a decision (`QD`), in force. An approval without one, or on one that is not in force, is
 * DECISION_DOCUMENT_NOT_EFFECTIVE; a document that does not exist (or belongs to another tenant) or is no decision is a fault of the request.
 */
export async function assertDecisionDocument(tx: TenantTx, documentId: string | undefined): Promise<string> {
  if (documentId === undefined) throw new DomainError('DECISION_DOCUMENT_NOT_EFFECTIVE', 422, 'decision_document_id');
  const rows = await tx.query<{ effect_status: string; doc_type_code: string }>('select effect_status, doc_type_code from machvon.document where id = $1::uuid', [documentId]);
  const document = rows[0];
  if (document === undefined || document.doc_type_code !== DECISION_DOCUMENT_TYPE) throw new DomainError('VALIDATION_FAILED', 422, 'decision_document_id');
  if (document.effect_status !== 'EFFECTIVE') throw new DomainError('DECISION_DOCUMENT_NOT_EFFECTIVE', 422, 'decision_document_id');
  return documentId;
}
