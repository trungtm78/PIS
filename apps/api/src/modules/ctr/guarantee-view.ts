import type { ExpiringRow, GuaranteeRow } from '@machvon/db';

/**
 * What a reader may see of a guarantee: the staff of the owner (a guest contractor is not) see who registered, verified and released it, how
 * it was checked and on what evidence; the outstanding advance of the contract is a total of the ledger and follows `ledger.read`.
 */
export interface GuaranteeRights {
  internal: boolean;
  ledger: boolean;
}

/**
 * The guarantee as openapi.json exposes it (x-exposure dto): an allowlist, so a column added to the table later is not shown until it is
 * listed here. The issuer and the number are what the paper says; the way the check was made and the evidence of it stay with the staff.
 */
export function guaranteeView(row: GuaranteeRow, rights: GuaranteeRights): Record<string, unknown> {
  return {
    id: row.id,
    contract_id: row.contractId,
    contract_code: row.contractCode,
    kind: row.kind,
    issuer: row.issuer,
    guarantee_no: row.guaranteeNo,
    party_contractor_id: row.partyContractorId,
    party_name: row.partyName,
    amount_vnd: row.amountVnd,
    currency: 'VND',
    valid_from: row.validFrom,
    expires_at: row.expiresAt,
    expires_on: row.expiresOn,
    status: row.status,
    verification_status: row.verificationStatus,
    last_alert_days: row.lastAlertDays,
    extended_from_id: row.extendedFromId,
    version: row.version,
    ...(rights.internal
      ? {
          document_version_id: row.documentVersionId,
          registered_by: row.registeredBy,
          verified_by: row.verifiedBy,
          verified_at: row.verifiedAt,
          verification_method: row.verificationMethod,
          verification_evidence_id: row.verificationEvidenceId,
          released_by: row.releasedBy,
          released_at: row.releasedAt,
          release_reason: row.releaseReason,
          release_evidence_id: row.releaseEvidenceId,
          created_at: row.createdAt,
        }
      : {}),
    // An advance guarantee is judged against what is still owed of the advance: shown only to a reader of the ledger.
    ...(rights.ledger && row.kind === 'ADVANCE' ? { advance_outstanding_vnd: row.advanceOutstandingVnd } : {}),
  };
}

/** A guarantee about to expire: the guarantee with the days left (counted in calendar days in Vietnam). */
export function expiringView(row: ExpiringRow, rights: GuaranteeRights): Record<string, unknown> {
  return { ...guaranteeView(row, rights), days_left: row.daysLeft };
}
