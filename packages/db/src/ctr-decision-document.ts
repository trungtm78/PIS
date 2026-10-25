import { DomainError } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

/**
 * The decision document a command of the contract rests on (the suspension, the resumption and the termination of a contract, the approval of a change order): a version of a file of
 * the tenant that is not infected and not a sealed bid. Without one, or with one that is none of these, the command is refused with 422 `DECISION_DOCUMENT_REQUIRED` naming
 * `field`. `maker` is whoever made the document: one of the people who proposed what it decides.
 */
export async function decisionDocument(tx: TenantTx, versionId: string | undefined, field: string): Promise<{ versionId: string; maker: string }> {
  if (versionId === undefined) throw new DomainError('DECISION_DOCUMENT_REQUIRED', 422, field);
  const rows = await tx.query<{ created_by: string; scan_status: string; sealed: boolean }>(
    `select d.created_by, v.scan_status, (d.subject_module = 'BID_PROPOSAL') as sealed
       from machvon.document_version v join machvon.document d on d.tenant_id = v.tenant_id and d.id = v.document_id where v.id = $1::uuid`,
    [versionId.toLowerCase()],
  );
  const row = rows[0];
  if (row === undefined || row.sealed || row.scan_status === 'INFECTED') throw new DomainError('DECISION_DOCUMENT_REQUIRED', 422, field);
  return { versionId: versionId.toLowerCase(), maker: row.created_by };
}
