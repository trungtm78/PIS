import { maskTaxIdentifier } from '@machvon/db';
import type { ContractorRow, RestrictionRow } from '@machvon/db';

/** What a reader may see of a contractor: the full right shows the tax id and the people and documents behind the decision; any other reader sees them covered or left out. */
export interface ReaderRights {
  full: boolean;
}

function restrictionView(row: RestrictionRow, rights: ReaderRights): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    source: row.source,
    effective_from: row.effectiveFrom,
    effective_until: row.effectiveUntil,
    // The decision and the note may name people: they stay with those who hold the full right.
    ...(rights.full ? { decision_document_id: row.decisionDocumentId, note: row.note } : {}),
  };
}

/**
 * The contractor as openapi.json exposes it (x-exposure dto): an allowlist, so a column added to the table later is not shown until it is
 * listed here. The tax id is covered for a reader without the full right; the people who registered and verified, and the documents, are left out.
 */
export function contractorLineView(row: ContractorRow, inForce: RestrictionRow | undefined, rights: ReaderRights): Record<string, unknown> {
  return {
    id: row.id,
    tax_identifier: rights.full ? row.taxIdentifier : maskTaxIdentifier(row.taxIdentifier),
    tax_identifier_masked: !rights.full,
    legal_name: row.legalName,
    legal_form: row.legalForm,
    verification_status: row.verificationStatus,
    verification_basis: row.verificationBasis,
    identity_lookup: row.lookup === null ? null : { adapter_status: row.lookup.adapterStatus, outcome: row.lookup.outcome, checked_at: row.lookup.checkedAt },
    master_record_id: row.masterRecordId,
    contract_count: row.contractCount,
    verified_at: row.verifiedAt,
    restriction_in_force: inForce === undefined ? null : { id: inForce.id, kind: inForce.kind, effective_from: inForce.effectiveFrom, effective_until: inForce.effectiveUntil },
    version: row.version,
  };
}

/** The profile of one contractor: the line, the documents and the verifier for those with the full right, and every restriction it ever had. */
export function contractorDetailView(row: ContractorRow, restrictions: readonly RestrictionRow[], inForce: RestrictionRow | undefined, rights: ReaderRights): Record<string, unknown> {
  return {
    ...contractorLineView(row, inForce, rights),
    ...(rights.full ? { profile_document_id: row.profileDocumentId, verified_by: row.verifiedBy, verification_evidence_document_id: row.verificationEvidenceDocumentId } : {}),
    restrictions: restrictions.map((restriction) => restrictionView(restriction, rights)),
  };
}
