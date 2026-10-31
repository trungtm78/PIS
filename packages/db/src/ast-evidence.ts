import { DomainError } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

const invalid = (field: string, reason: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field, { extensions: { reason } });

/** A version of a file of the tenant that has passed the scan: 422 `VALIDATION_FAILED` when there is none, `DOCUMENT_NOT_CLEAN` when it is not clean. */
export async function assertCleanDocument(tx: TenantTx, versionId: string, field: string): Promise<void> {
  const rows = await tx.query<{ scan_status: string }>('select scan_status from machvon.document_version where id = $1::uuid', [versionId]);
  if (rows[0] === undefined) throw invalid(field, 'NOT_FOUND');
  if (rows[0].scan_status !== 'CLEAN') throw new DomainError('DOCUMENT_NOT_CLEAN', 422, field);
}

/** A photo of the contract that has passed the scan: 422 `VALIDATION_FAILED` when it is not one of the contract, `FILE_NOT_CLEAN` when it is not clean. */
export async function assertCleanPhoto(tx: TenantTx, photoId: string, contractId: string, field: string): Promise<void> {
  const rows = await tx.query<{ scan_status: string }>('select scan_status from machvon.site_photo where id = $1::uuid and contract_id = $2::uuid', [photoId, contractId]);
  if (rows[0] === undefined) throw invalid(field, 'NOT_IN_CONTRACT');
  if (rows[0].scan_status !== 'CLEAN') throw new DomainError('FILE_NOT_CLEAN', 422, field);
}

/** The contractor answering for a work is the contractor of the contract or one of its active parties. */
export async function assertContractParty(tx: TenantTx, contractId: string, contractorId: string, field: string): Promise<void> {
  const rows = await tx.query(
    `select 1 from machvon.contract where id = $1::uuid and contractor_id = $2::uuid
      union select 1 from machvon.contract_party where contract_id = $1::uuid and contractor_id = $2::uuid and status = 'ACTIVE'`,
    [contractId, contractorId],
  );
  if (rows.length === 0) throw invalid(field, 'NOT_A_PARTY');
}

/** The contractor a guest member belongs to (null when the guest has none); undefined for any other member, who is judged by its scope alone. */
export async function guestContractorOf(tx: TenantTx, memberId: string): Promise<string | null | undefined> {
  const caller = (await tx.query<{ membership_type: string; contractor_id: string | null }>('select membership_type, contractor_id from machvon.membership where id = $1::uuid', [memberId]))[0];
  return caller?.membership_type === 'GUEST_CONTRACTOR' ? caller.contractor_id : undefined;
}

/** A contractor member answers for the claims and items of its own contractor, and for no other; any other member is judged by its scope alone. */
export async function assertContractorOwn(tx: TenantTx, memberId: string, responsibleContractorId: string | null): Promise<void> {
  const own = await guestContractorOf(tx, memberId);
  if (own !== undefined && responsibleContractorId !== null && own !== responsibleContractorId) throw new DomainError('SCOPE_DENIED', 403);
}
