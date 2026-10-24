import { PERMISSIONS } from '@machvon/contracts';
import type { PipelineCard, ProjectLifecycle, StageHistoryEntry, StageInput } from '@machvon/db';
import type { Schemas } from '../../contract-types';

/** The allowlist of a stage command in the shape the store takes. */
export function stageInputOf(body: Schemas['PrjStageCommand']): StageInput {
  return {
    reason: body.reason,
    decisionDocumentId: body.decision_document_id,
    investmentDecisionDocumentId: body.investment_decision_document_id,
    policyProposalDocumentId: body.policy_proposal_document_id,
    effectiveDate: body.effective_date,
  };
}

function historyView(entry: StageHistoryEntry): Record<string, unknown> {
  return {
    from: entry.from,
    to: entry.to,
    version: entry.version,
    operation: entry.operation,
    actor_kind: entry.actorKind,
    // The system has no name; a member is named as the directory of the tenant names them.
    actor_name: entry.actorName,
    decision_document_id: entry.decisionDocumentId,
    reason: entry.reason,
    effective_date: entry.effectiveDate,
    occurred_at: entry.occurredAt,
  };
}

/**
 * The lifecycle of one project as openapi.json exposes it (x-exposure dto): the stage with its history, who moved the project and on what
 * ground, and the moves open from the stage with the permission each needs, whether the caller holds it, and the state of each guard.
 */
export function lifecycleView(lifecycle: ProjectLifecycle, asOf: Date): Record<string, unknown> {
  return {
    project_id: lifecycle.projectId,
    code: lifecycle.code,
    status: lifecycle.status,
    version: lifecycle.version,
    project_group: lifecycle.projectGroup,
    national_project_code: lifecycle.nationalProjectCode,
    status_changed_at: lifecycle.statusChangedAt,
    history: lifecycle.history.map(historyView),
    next: lifecycle.next.map((transition) => ({
      operation: transition.operation,
      to: transition.to,
      permission: PERMISSIONS[transition.operation],
      allowed: transition.allowed,
      guards: transition.guards.map((guard) => ({ key: guard.key, state: guard.state })),
    })),
    as_of: asOf.toISOString(),
  };
}

/** One card of the project bank: what the board shows of a project, no unit ids and no internal ordering key. */
export function pipelineCardView(card: PipelineCard): Record<string, unknown> {
  return {
    id: card.id,
    code: card.code,
    name: card.name,
    status: card.status,
    project_group: card.projectGroup,
    appraisal_score: card.appraisalScore,
    total_investment_vnd: card.totalInvestmentVnd,
    national_project_code: card.nationalProjectCode,
    capital_ready: card.capitalReady,
    owner_unit_name: card.ownerUnitName,
    investor_unit_name: card.investorUnitName,
    leader_in_charge: card.leader === null ? null : { membership_id: card.leader.membershipId, display_name: card.leader.displayName },
    status_changed_at: card.statusChangedAt,
    version: card.version,
  };
}
