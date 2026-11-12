import { GovernancePolicyPort } from '@machvon/db';
import type { LegalDocTypeChange, ProjectDocumentExtension, TenantTx } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import { LEGAL_DOC_TYPE_RULE, legalDocTypesOfResolved } from './ent-catalogue.ts';

/**
 * The legal-document type of a project document in the enterprise edition (MD.02): a file of the project repository is also said to be one of the legal documents of the catalogue ENT_LEGAL_DOC_TYPE (the resolution of the
 * group, the decision approving the feasibility study, the groundbreaking record, ...), the types a milestone of the investment life takes as its evidence. The repository commands are public code and ask the extension of
 * the process; this is the one of the enterprise edition (`PROJECT_DOCUMENT_EXTENSION`, bound by the enterprise module of the API). The catalogue is read as it stands on the business day, so a code a tenant added through an
 * approved rule is accepted, and a code whose rule was retired is not. The type is kept in `project_document_legal_type`, a table of the edition: the public table of the documents is not touched.
 */

const CODE = /^[A-Z][A-Z0-9_]{1,39}$/;

const refused = (reason: string): DomainError => new DomainError('VALIDATION_FAILED', 422, 'legal_doc_type', { extensions: { reason } });

/** The code a request names, judged against the codes of the catalogue; `null` clears the type. 422 on `legal_doc_type` for what is not a code (`FORMAT`) or not in the catalogue (`UNKNOWN_TYPE`). */
export function legalDocTypeOf(raw: unknown, catalogue: readonly string[]): string | null {
  if (raw === null) return null;
  if (typeof raw !== 'string' || !CODE.test(raw)) throw refused('FORMAT');
  if (!catalogue.includes(raw)) throw refused('UNKNOWN_TYPE');
  return raw;
}

export class EnterpriseProjectDocumentExtension implements ProjectDocumentExtension {
  private readonly rules = new GovernancePolicyPort();

  async legalDocType(tx: TenantTx, raw: unknown, today: string): Promise<LegalDocTypeChange> {
    if (raw === undefined) return { set: false };
    // Clearing needs no catalogue; a code is judged against the catalogue in force on the day.
    const catalogue = raw === null ? [] : legalDocTypesOfResolved(await this.rules.getAll(tx, LEGAL_DOC_TYPE_RULE, today)).map((one) => one.code);
    return { set: true, code: legalDocTypeOf(raw, catalogue) };
  }

  async recordLegalDocType(tx: TenantTx, documentId: string, code: string | null, actor: string): Promise<{ from: string | null; to: string | null }> {
    const [held] = await tx.query<{ legal_doc_type: string }>('select legal_doc_type from machvon.project_document_legal_type where document_id = $1::uuid', [documentId]);
    const from = held?.legal_doc_type ?? null;
    if (from === code) return { from, to: code };
    if (code === null) {
      await tx.query('delete from machvon.project_document_legal_type where document_id = $1::uuid', [documentId]);
    } else {
      await tx.query(
        `insert into machvon.project_document_legal_type (tenant_id, document_id, legal_doc_type, set_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3::uuid)
         on conflict (tenant_id, document_id) do update set legal_doc_type = excluded.legal_doc_type, set_by = excluded.set_by, set_at = now()`,
        [documentId, code, actor],
      );
    }
    return { from, to: code };
  }
}
