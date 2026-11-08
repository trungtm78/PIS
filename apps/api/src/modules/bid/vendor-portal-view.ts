import type { DisputeReport, DisputeRow, PortalEvaluationRow, PortalRequestRow, Policy, ReconfirmationLine, ReconfirmationView, RemediationActionRow, RemediationEventRow, RemediationPlanRow } from '@machvon/db';
import { DomainError, activeGrants, daysUntil, effectivePermissions, holdsPermission } from '@machvon/kernel';
import type { DisputeStats, EffectiveAccess, ExpiryState } from '@machvon/kernel';
import type { CommandScope } from '../../command-scope';
import { policyDto } from './vendor-view';

/** The names of members by id, as the people directory gives them. */
export type Names = ReadonlyMap<string, string>;
const nameOf = (names: Names, id: string | null): string | null => (id === null ? null : (names.get(id) ?? null));

export const PORTAL_CLASS = { answer: 'CONFIDENTIAL', plain: 'INTERNAL' } as const;
type Classification = (typeof PORTAL_CLASS)[keyof typeof PORTAL_CLASS];

interface Announcement {
  action: string;
  resourceType: string;
  resourceId: string;
  classification: Classification;
  version: number;
  eventType: string;
  reason?: string | undefined;
  diff: Record<string, unknown>;
}

/** Writes the audit row (ADM-11) and the outbox event of a command; the payload carries ids and codes only, never the words of an answer, a note or a reason. */
export async function announcePortal(scope: CommandScope, now: Date, item: Announcement): Promise<void> {
  await scope.audit({ action: item.action, resourceType: item.resourceType, resourceId: item.resourceId, classification: item.classification, ...(item.reason === undefined ? {} : { reason: item.reason }), diff: item.diff });
  await scope.emit({
    aggregateType: item.resourceType,
    aggregateId: item.resourceId,
    aggregateVersion: item.version,
    type: item.eventType,
    schemaVersion: 1,
    payload: { tenant_id: scope.tenant.tenantId, resource_id: item.resourceId, version: item.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), action: item.action, ...item.diff },
    eventKey: `${item.resourceType}:${item.resourceId}:${item.version}:${item.action}`,
  });
}

/**
 * Whether the caller holds a right on ANY of their active grants. A guest contractor holds its portal rights on the grants it was given (scoped to its contracts), so the whole-tenant test of the staff operations would never
 * pass; the contractor it acts for is not taken from the grant but from its membership (`VendorPortalStore.enter`).
 */
export const holdsAnywhere = (access: EffectiveAccess, permission: string): boolean => holdsPermission(effectivePermissions(access, new Date()), permission);

export const assertHoldsAnywhere = (access: EffectiveAccess, permission: string): void => {
  if (!holdsAnywhere(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
};

export const hasActiveGrant = (access: EffectiveAccess): boolean => activeGrants(access, new Date()).length > 0;

const iso = (value: string | null): string | null => value;

// -- Staff views ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const requestLineDto = (row: PortalRequestRow, names: Names): Record<string, unknown> => ({
  id: row.id,
  contractor_id: row.contractorId,
  contractor_name: row.contractorName,
  kind: row.kind,
  subject_type: row.subjectType,
  subject_id: row.subjectId,
  title: row.title,
  body: row.body,
  due_at: row.dueAt,
  status: row.status,
  clock: row.clock,
  requested_by_name: nameOf(names, row.requestedBy),
  requested_at: row.requestedAt,
  response_text: row.responseText,
  response_document_id: row.responseDocumentId,
  response_qualification_id: row.responseQualificationId,
  responded_at: iso(row.respondedAt),
  response_late: row.responseLate,
  round: row.round,
  reviewed_at: iso(row.reviewedAt),
  review_note: row.reviewNote,
  cancelled_reason: row.cancelledReason,
  version: row.version,
});

export const reconfirmationLineDto = (line: ReconfirmationLine): Record<string, unknown> => ({
  contractor_id: line.contractorId,
  contractor_name: line.contractorName,
  tax_identifier: line.taxIdentifier,
  state: line.state,
  due_on: line.dueOn,
  last_confirmed_at: line.lastConfirmedAt,
  declaration_version: line.declarationVersion,
});

export const planLineDto = (row: RemediationPlanRow, names: Names): Record<string, unknown> => ({
  id: row.id,
  contractor_id: row.contractorId,
  contractor_name: row.contractorName,
  contract_id: row.contractId,
  trigger_kind: row.triggerKind,
  title: row.title,
  objective: row.objective,
  status: row.status,
  proposed_by_name: nameOf(names, row.proposedBy),
  proposed_at: row.proposedAt,
  agreed_at: row.agreedAt,
  started_at: row.startedAt,
  closed_at: row.closedAt,
  closed_reason: row.closedReason,
  action_count: row.actionCount,
  verified_count: row.verifiedCount,
  overdue_count: row.overdueCount,
  version: row.version,
});

export const actionLineDto = (row: RemediationActionRow, names: Names): Record<string, unknown> => ({
  id: row.id,
  seq: row.seq,
  description: row.description,
  due_on: row.dueOn,
  status: row.status,
  overdue: row.overdue,
  done_by_name: nameOf(names, row.doneBy),
  done_at: row.doneAt,
  done_note: row.doneNote,
  evidence_document_id: row.evidenceDocumentId,
  verified_by_name: nameOf(names, row.verifiedBy),
  verified_at: row.verifiedAt,
  verify_note: row.verifyNote,
  version: row.version,
});

export const planEventDto = (row: RemediationEventRow, names: Names): Record<string, unknown> => ({ id: row.id, move: row.move, from_status: row.fromStatus, to_status: row.toStatus, actor_name: nameOf(names, row.actorId), note: row.note, at: row.at });

export const statsDto = (stats: DisputeStats): Record<string, unknown> => ({
  total: stats.total,
  open: stats.open,
  upheld: stats.upheld,
  rejected: stats.rejected,
  withdrawn: stats.withdrawn,
  awaiting_outcome: stats.awaitingOutcome,
  upheld_pct: stats.upheldPct,
  mean_days_to_close: stats.meanDaysToClose,
});

export const disputeLineDto = (row: DisputeRow): Record<string, unknown> => ({
  kind: row.kind,
  id: row.id,
  contractor_id: row.contractorId,
  contractor_name: row.contractorName,
  subject_code: row.subjectCode,
  outcome: row.outcome,
  source_status: row.sourceStatus,
  awaiting_outcome: row.awaitingOutcome === true,
  decision_ref: row.decisionRef,
  opened_on: row.openedOn,
  closed_on: row.closedOn,
});

export const disputesDto = (report: DisputeReport, asOf: string): Record<string, unknown> => ({
  items: report.items.map(disputeLineDto),
  stats: statsDto(report.stats),
  petitions: statsDto(report.petitions),
  claims: statsDto(report.claims),
  portfolio: statsDto(report.portfolio),
  as_of: asOf,
});

// -- What the contractor sees ---------------------------------------------------------------------------------------------------------------------------------------------------------------

export const portalRequestDto = (row: PortalRequestRow): Record<string, unknown> => ({
  id: row.id,
  kind: row.kind,
  title: row.title,
  body: row.body,
  due_at: row.dueAt,
  status: row.status,
  clock: row.clock,
  requested_at: row.requestedAt,
  response_text: row.responseText,
  response_document_id: row.responseDocumentId,
  response_qualification_id: row.responseQualificationId,
  responded_at: row.respondedAt,
  response_late: row.responseLate,
  round: row.round,
  review_note: row.reviewNote,
  version: row.version,
});

export const portalReconfirmationDto = (view: ReconfirmationView): Record<string, unknown> => ({
  state: view.state,
  due_on: view.dueOn,
  last_confirmed_at: view.lastConfirmedAt,
  declaration_version: view.declarationVersion,
  declaration_text: view.declarationText,
  interval_months: view.intervalMonths,
});

export const portalEvaluationDto = (row: PortalEvaluationRow): Record<string, unknown> => ({
  id: row.id,
  contract_id: row.contractId,
  contract_code: row.contractCode,
  evaluation_kind: row.evaluationKind,
  period_label: row.periodLabel,
  rating: row.rating,
  overall_score: row.overallScore,
  score_quality: row.scoreQuality,
  score_schedule: row.scoreSchedule,
  score_safety_env: row.scoreSafetyEnv,
  score_cooperation: row.scoreCooperation,
  score_financial: row.scoreFinancial,
  remarks: row.remarks,
  approved_at: row.approvedAt,
  open_request_id: row.openRequestId,
});

export const portalPlanDto = (plan: RemediationPlanRow, actions: readonly RemediationActionRow[]): Record<string, unknown> => ({
  id: plan.id,
  title: plan.title,
  objective: plan.objective,
  status: plan.status,
  proposed_at: plan.proposedAt,
  agreed_at: plan.agreedAt,
  closed_at: plan.closedAt,
  actions: actions.map((action) => ({
    id: action.id,
    seq: action.seq,
    description: action.description,
    due_on: action.dueOn,
    status: action.status,
    overdue: action.overdue,
    done_at: action.doneAt,
    done_note: action.doneNote,
    verified_at: action.verifiedAt,
    verify_note: action.verifyNote,
    version: action.version,
  })),
  version: plan.version,
});

export const expiryItemDto = (state: ExpiryState, expiresOn: string | null, today: string): { state: ExpiryState; days_left: number | null } => ({ state, days_left: expiresOn === null ? null : daysUntil(today, expiresOn) });

export { policyDto };
export type { Policy };
