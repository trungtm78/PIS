import type { AssetLine } from '@machvon/db';
import type { EffectiveAccess } from '@machvon/kernel';
import { reaches } from '../ctr/contract.controller';
import { handoverRefs } from './handover-view';

export interface AssetPermissions {
  manage: string;
  transfer: string;
}

/** An asset is worth a figure only to the people who register and transfer assets: the value is the books' and not the work's. */
function holdsValue(line: AssetLine, access: EffectiveAccess, now: Date, permissions: AssetPermissions): boolean {
  const refs = handoverRefs(line.reach);
  return reaches(access, permissions.manage, refs, now) || reaches(access, permissions.transfer, refs, now);
}

/** What the caller may do with the asset as it stands: it is registered and its handover is accepted, and the caller holds the right to transfer it over the contract or the receiving unit. */
export function assetAllowed(line: AssetLine, access: EffectiveAccess, now: Date, permissions: AssetPermissions): { transfer: boolean } {
  return { transfer: line.status === 'REGISTERED' && line.handover.status === 'ACCEPTED' && reaches(access, permissions.transfer, handoverRefs(line.reach), now) };
}

/**
 * An asset as openapi.json exposes it (x-exposure dto): an allowlist. The value and what the assets of the contract come to are shown to whoever registers or transfers assets; the code the asset
 * has in the system of public assets is shown once the asset was transferred, because until then there is none to show.
 */
export function assetView(line: AssetLine, access: EffectiveAccess, now: Date, permissions: AssetPermissions): Record<string, unknown> {
  const money = holdsValue(line, access, now, permissions);
  return {
    id: line.id,
    asset_code: line.assetCode,
    name: line.name,
    handover: { id: line.handover.id, handover_no: line.handover.handoverNo, status: line.handover.status },
    contract: { id: line.contract.id, code: line.contract.code, ...(money ? { value_vnd: line.contract.valueVnd } : {}) },
    project_id: line.projectId,
    recipient_unit: { id: line.recipientUnit.id, code: line.recipientUnit.code, name: line.recipientUnit.name },
    asset_class_master_version_id: line.assetClassMasterVersionId,
    value_vnd: money ? line.valueVnd : null,
    value_basis: money ? line.valueBasis : null,
    contract_assets_vnd: money ? line.contractAssetsVnd : null,
    funding_origin: line.fundingOrigin,
    status: line.status,
    registered_on: line.registeredOn,
    transferred_on: line.transferredOn,
    warranty_until: line.warrantyUntil,
    commissioning_document_version_id: line.commissioningDocumentVersionId,
    external_asset_id: line.status === 'TRANSFERRED' || line.status === 'IN_OPERATION' ? line.externalAssetId : null,
    created_at: line.createdAt,
    allowed: assetAllowed(line, access, now, permissions),
    version: line.version,
  };
}
