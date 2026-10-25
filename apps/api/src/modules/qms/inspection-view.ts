import type { QmsInspectionLine } from '@machvon/db';
import type { EffectiveAccess } from '@machvon/kernel';
import { placeRefs, reaches } from '../ctr/contract.controller';

export interface InspectionPermissions {
  manage: string;
  record: string;
}

/**
 * What the caller may do with the inspection as it stands: the command applies to its status and the caller holds the permission over the contract. A button is shown for exactly these;
 * the server judges each command again.
 */
export function inspectionActionsOf(line: QmsInspectionLine, access: EffectiveAccess, now: Date, permissions: InspectionPermissions): Record<'schedule' | 'record' | 'cancel', boolean> {
  const refs = placeRefs(line.reach);
  const manage = reaches(access, permissions.manage, refs, now);
  return {
    schedule: line.status === 'REQUESTED' && manage,
    record: line.status === 'SCHEDULED' && reaches(access, permissions.record, refs, now),
    cancel: (line.status === 'REQUESTED' || line.status === 'SCHEDULED') && manage,
  };
}

/** An inspection as openapi.json exposes it (x-exposure dto): an allowlist, so a column added to the table later is not shown until it is listed here. */
export function inspectionView(line: QmsInspectionLine, actions: Record<'schedule' | 'record' | 'cancel', boolean>): Record<string, unknown> {
  return {
    id: line.id,
    inspection_no: line.inspectionNo,
    contract: { id: line.contract.id, code: line.contract.code, status: line.contract.status },
    project_id: line.projectId,
    boq_item: line.boqItem === null ? null : { id: line.boqItem.id, business_key: line.boqItem.businessKey, description: line.boqItem.description },
    inspection_type: line.inspectionType,
    title: line.title,
    location_text: line.locationText,
    requested_by: { membership_id: line.requestedBy.membershipId, display_name: line.requestedBy.displayName },
    requested_for: line.requestedFor,
    scheduled_at: line.scheduledAt,
    participants: line.participants.map((person) => ({ membership_id: person.membershipId, display_name: person.displayName })),
    status: line.status,
    result: line.result,
    result_note: line.resultNote,
    result_recorded_at: line.resultRecordedAt,
    checklist: line.checklist,
    regime: {
      version_id: line.regime.versionId,
      label: line.regime.label,
      legal_basis: line.regime.legalBasis,
      awaiting_confirmation: line.regime.awaitingConfirmation,
      cxn: line.regime.cxn,
    },
    required_roles: line.requiredRoles,
    site_diary_id: line.siteDiaryId,
    cancel_reason: line.cancelReason,
    created_at: line.createdAt,
    actions,
    version: line.version,
  };
}
