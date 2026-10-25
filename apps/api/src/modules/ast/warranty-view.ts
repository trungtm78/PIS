import type { WarrantyLine } from '@machvon/db';
import { effectiveWarrantyStatus, hasRunOut, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { reaches } from '../ctr/contract.controller';
import { handoverRefs } from './handover-view';

export interface WarrantyPermissions {
  manage: string;
}

/** What the caller may do with the obligation as it stands: close it once it has run out, if it holds the right to over the contract or the receiving unit. The claims that are open are told, not hidden. */
export function warrantyAllowed(line: WarrantyLine, access: EffectiveAccess, now: Date, permissions: WarrantyPermissions): { close: boolean } {
  return { close: line.status !== 'CLOSED' && hasRunOut(line.endsOn, vietnamDateOf(now)) && reaches(access, permissions.manage, handoverRefs(line.reach), now) };
}

/**
 * An obligation as openapi.json exposes it (x-exposure dto): an allowlist. The status is the one of the day (an active obligation whose last day has come is expired, whether or not the job has
 * marked it yet); the rule the term was judged by says whether it still waits for the confirmation of its source, because the screen has to say so.
 */
export function warrantyView(line: WarrantyLine, access: EffectiveAccess, now: Date, permissions: WarrantyPermissions): Record<string, unknown> {
  return {
    id: line.id,
    contract: { id: line.contract.id, code: line.contract.code },
    handover: { id: line.handover.id, handover_no: line.handover.handoverNo, status: line.handover.status },
    project_id: line.projectId,
    asset: line.asset === null ? null : { id: line.asset.id, asset_code: line.asset.assetCode, name: line.asset.name },
    scope_description: line.scopeDescription,
    starts_on: line.startsOn,
    ends_on: line.endsOn,
    period_months: line.periodMonths,
    construction_grade: line.constructionGrade,
    minimum_months: line.minimumMonths,
    rule: line.rule === null ? null : { version_id: line.rule.versionId, awaiting_confirmation: line.rule.awaitingConfirmation, cxn: line.rule.cxn },
    guarantee:
      line.guarantee === null
        ? null
        : { id: line.guarantee.id, guarantee_no: line.guarantee.guaranteeNo, issuer: line.guarantee.issuer, amount_vnd: line.guarantee.amountVnd, expires_on: line.guarantee.expiresOn },
    retention_amount_vnd: line.retentionAmountVnd,
    status: effectiveWarrantyStatus(line.status, line.endsOn, vietnamDateOf(now)),
    closed_at: line.closedAt,
    close_note: line.closeNote,
    open_claims: line.openClaims,
    total_claims: line.totalClaims,
    created_at: line.createdAt,
    allowed: warrantyAllowed(line, access, now, permissions),
    version: line.version,
  };
}
