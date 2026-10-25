import type { AdvancePlan, AdvanceView } from '@machvon/db';
import type { EffectiveAccess } from '@machvon/kernel';
import { placeRefs, reaches } from '../ctr/contract.controller';

export interface AdvancePermissions {
  cancel: string;
  recover: string;
}

export interface AdvanceWarning {
  code: 'RULE_AWAITING_CONFIRMATION';
  detail: Record<string, unknown>;
}

const DAY = 86_400_000;

/** The days a date is past another, both as `YYYY-MM-DD`. */
const daysBetween = (from: string, to: string): number => Math.round((Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10))) - Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)))) / DAY);

/** The rule that capped an advance is a working assumption until its confirmation arrives: the caller is told, and the screens say so (UAT-AC326). */
export function advanceWarnings(view: AdvanceView): AdvanceWarning[] {
  return view.capRuleAwaitingConfirmation ? [{ code: 'RULE_AWAITING_CONFIRMATION', detail: { cxn: view.capRuleCxn, cap_rule_version_id: view.capRuleVersionId } }] : [];
}

/**
 * An advance as openapi.json exposes it (x-exposure dto): an allowlist, so a column added to the table later is not shown until it is listed here. The buttons are the commands the caller may give
 * over the contract (an advance is cancelled while it is planned or asked for and recovered while it is owed); the server judges each command again.
 */
export function advanceView(view: AdvanceView, access: EffectiveAccess, now: Date, permissions: AdvancePermissions, today: string): Record<string, unknown> {
  const refs = placeRefs(view.reach);
  const late = view.recoveryDeadline !== null && view.outstandingVnd !== '0' && today > view.recoveryDeadline;
  return {
    id: view.id,
    status: view.status,
    contract: { id: view.contract.id, code: view.contract.code, status: view.contract.status, value_vnd: view.contract.valueVnd, advance_category: view.contract.advanceCategory },
    project_id: view.projectId,
    party: { id: view.party.id, role: view.party.role, name: view.party.name, work_value_vnd: view.party.workValueVnd },
    tranche_no: view.trancheNo,
    kind: view.kind,
    amount_vnd: view.amountVnd,
    cap_vnd: view.capVnd,
    cap_pct: view.capPct,
    cap_rule_version_id: view.capRuleVersionId,
    cap_rule_awaiting_confirmation: view.capRuleAwaitingConfirmation,
    cap_rule_cxn: view.capRuleCxn,
    guarantee_id: view.guaranteeId,
    allocation_line_id: view.allocationLineId,
    paid_vnd: view.paidVnd,
    recovered_vnd: view.recoveredVnd,
    outstanding_vnd: view.outstandingVnd,
    paid_on: view.paidOn,
    recovery_threshold_pct: view.thresholdPct,
    recovery_deadline: view.recoveryDeadline,
    overdue_since: view.overdueSince,
    overdue_days: late && view.recoveryDeadline !== null ? daysBetween(view.recoveryDeadline, today) : null,
    last_alert_level: view.lastAlertLevel,
    created_at: view.createdAt,
    updated_at: view.updatedAt,
    actions: {
      cancel: (view.status === 'PLANNED' || view.status === 'REQUESTED') && reaches(access, permissions.cancel, refs, now),
      record_recovery: (view.status === 'PAID' || view.status === 'RECOVERING') && reaches(access, permissions.recover, refs, now),
    },
    version: view.version,
  };
}

/** The recovery of one advance (CTR-06, PAY-07): where it stands and where it goes by the formula, for the member the advance was paid to. */
export function planView(found: AdvancePlan, access: EffectiveAccess, now: Date, permissions: AdvancePermissions, today: string): Record<string, unknown> {
  const { plan } = found;
  return {
    advance: advanceView(found.view, access, now, permissions, today),
    threshold_value_vnd: plan.thresholdValueVnd,
    gross_to_date_vnd: plan.grossToDateVnd,
    remaining_to_threshold_vnd: plan.remainingToThresholdVnd,
    target_recovered_vnd: plan.targetRecoveredVnd,
    recovered_vnd: plan.recoveredVnd,
    outstanding_vnd: plan.outstandingVnd,
    behind_vnd: plan.behindVnd,
    milestones: plan.milestones.map((milestone) => ({ at_pct: milestone.atPct, at_gross_vnd: milestone.atGrossVnd, recovered_vnd: milestone.recoveredVnd })),
    warnings: advanceWarnings(found.view),
  };
}
