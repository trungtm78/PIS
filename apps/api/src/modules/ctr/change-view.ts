import type { CtrChangeLine, CtrTierConfig } from '@machvon/db';
import { CHANGEABLE_CONTRACT_STATUSES, EVALUATED_STAGES, OPEN_CHANGE_STATUSES, nextStageOf, stagesOf } from '@machvon/kernel';
import type { EffectiveAccess, TierCount } from '@machvon/kernel';
import { placeRefs, reaches } from './contract.controller';

/** What a reader may see of a request: the staff of the owner see the assessment, a guest contractor sees only where the request stands in the chain. */
export interface ChangeRights {
  internal: boolean;
}

export interface ChangePermissions {
  promote: string;
  evaluate: string;
  withdraw: string;
}

/**
 * What the caller may do with the request as it stands: the command applies to its status and its tier, the contract is still being performed and the caller holds the permission over
 * it. A button is shown for exactly these; the server judges each command again.
 */
export function changeActionsOf(line: CtrChangeLine, tierCount: TierCount | undefined, access: EffectiveAccess, now: Date, permissions: ChangePermissions): Record<'promote' | 'evaluate' | 'withdraw', boolean> {
  const open = OPEN_CHANGE_STATUSES.includes(line.status);
  const changeable = CHANGEABLE_CONTRACT_STATUSES.includes(line.contract.status);
  const refs = placeRefs(line.reach);
  return {
    promote: open && changeable && tierCount !== undefined && nextStageOf(line.stage, tierCount) !== undefined && reaches(access, permissions.promote, refs, now),
    evaluate: open && changeable && EVALUATED_STAGES.includes(line.stage) && reaches(access, permissions.evaluate, refs, now),
    withdraw: (open || line.status === 'DRAFT') && reaches(access, permissions.withdraw, refs, now),
  };
}

/** A request as openapi.json exposes it (x-exposure dto): an allowlist, so a column added to the table later is not shown until it is listed here. */
export function changeRequestView(line: CtrChangeLine, rights: ChangeRights, actions?: Record<string, boolean>): Record<string, unknown> {
  const placed = {
    id: line.id,
    code: line.code,
    stage: line.stage,
    status: line.status,
    contract: { id: line.contract.id, code: line.contract.code, status: line.contract.status },
    project_id: line.projectId,
    parent_id: line.parentId,
    created_at: line.createdAt,
    version: line.version,
  };
  if (!rights.internal) return placed;
  return {
    ...placed,
    event_kind: line.eventKind,
    baseline_revision_id: line.baselineRevisionId,
    reason: line.reason,
    status_reason: line.statusReason,
    estimated_delta_vnd: line.estimatedDeltaVnd,
    evaluated_delta_vnd: line.evaluatedDeltaVnd,
    approved_delta_vnd: line.approvedDeltaVnd,
    schedule_impact_days: line.scheduleImpactDays,
    funding_impact_note: line.fundingImpactNote,
    scope_impact_note: line.scopeImpactNote,
    allocation_line_id: line.allocationLineId,
    effective_on: line.effectiveOn,
    submitted_by: line.submittedBy,
    evaluated_by: line.evaluatedBy,
    decided_by: line.decidedBy,
    evaluated_at: line.evaluatedAt,
    decided_at: line.decidedAt,
    ...(actions === undefined ? {} : { actions }),
  };
}

/** The tiers of a project as the screens of the policy and of the board read them. */
export function tierConfigView(config: CtrTierConfig): Record<string, unknown> {
  return {
    tier_count: config.tierCount,
    stages: stagesOf(config.tierCount),
    locked: config.lockedAt !== null,
    locked_at: config.lockedAt,
    locked_by_change: config.lockedByChangeId === null ? null : { id: config.lockedByChangeId, code: config.lockedByCode },
    set_by: config.setBy,
    version: config.version,
  };
}
