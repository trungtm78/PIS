import { DomainError, isInForce } from '@machvon/kernel';
import type { TenantTx } from '@machvon/db';

export interface DocumentRelationLink {
  kind: string;
  documentId: string;
}

/** What a module may know about a document it wants to point at: the facts printed on its face, nothing of its content. */
export interface DocumentFacts {
  documentId: string;
  docKind: string;
  docTypeCode: string;
  effectStatus: string;
  symbol: string | null;
  documentNumber: number | null;
  numberYear: number | null;
  issuedOn: string | null;
  /** The documents that replace, correct or recall this one, so the module can show where the effect went. */
  relations: DocumentRelationLink[];
}

interface FactsRow {
  id: string;
  doc_kind: string;
  doc_type_code: string;
  effect_status: string;
  symbol: string | null;
  document_number: number | null;
  number_year: number | null;
  issued_on: string | null;
}

/**
 * DocumentReferencePort (DOC.md section 7): the module that holds a `*_document_id` column calls `assertUsable` before it writes the column. The document
 * must belong to the tenant of the transaction, be in force and, when the module names the kinds it accepts, be of one of them. A document that does not
 * exist for the tenant (another tenant's included) is 404 like anywhere else; one that is not in force is 422 DOCUMENT_NOT_EFFECTIVE with the reason and the
 * documents that took its place.
 */
export class DocumentReferencePort {
  async assertUsable(tx: TenantTx, documentId: string, allowedDocTypes?: readonly string[]): Promise<DocumentFacts> {
    const [row] = await tx.query<FactsRow>(
      `select id, doc_kind, doc_type_code, effect_status, symbol, document_number, number_year, issued_on::text as issued_on from machvon.document where id = $1::uuid`,
      [documentId],
    );
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const relations = await tx.query<{ relation_kind: string; related: string }>(
      // Only what took effect: a replacement or a correction that is still being drawn up (or was cancelled) has not taken the place of anything.
      `select r.relation_kind, r.from_document_id as related
         from machvon.document_relation r left join machvon.outgoing_document o on o.tenant_id = r.tenant_id and o.document_id = r.from_document_id
        where r.to_document_id = $1::uuid and r.relation_kind in ('REPLACES', 'CORRECTS', 'RECALLS')
          and (o.id is null or o.status not in ('DRAFT', 'IN_REVIEW', 'SUBMITTED', 'SIGNED', 'NUMBERED', 'SEALED', 'CANCELLED'))
        order by r.created_at, r.id`,
      [documentId],
    );
    const facts: DocumentFacts = {
      documentId: row.id,
      docKind: row.doc_kind,
      docTypeCode: row.doc_type_code,
      effectStatus: row.effect_status,
      symbol: row.symbol,
      documentNumber: row.document_number,
      numberYear: row.number_year,
      issuedOn: row.issued_on,
      relations: relations.map((relation) => ({ kind: relation.relation_kind, documentId: relation.related })),
    };
    if (!isInForce(row.effect_status)) {
      throw new DomainError('DOCUMENT_NOT_EFFECTIVE', 422, 'document_id', {
        extensions: { reason: 'NOT_EFFECTIVE', effect_status: row.effect_status, relations: facts.relations.map((link) => ({ kind: link.kind, document_id: link.documentId })) },
      });
    }
    if (allowedDocTypes !== undefined && allowedDocTypes.length > 0 && !allowedDocTypes.includes(row.doc_type_code)) {
      throw new DomainError('DOCUMENT_NOT_EFFECTIVE', 422, 'document_id', { extensions: { reason: 'DOC_TYPE_NOT_ALLOWED', doc_type_code: row.doc_type_code } });
    }
    return facts;
  }
}
