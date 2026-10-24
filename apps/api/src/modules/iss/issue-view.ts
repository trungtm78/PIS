import { ISSUE_MAX_EXTENSIONS, ISSUE_REOPEN_WINDOW_DAYS, LOW_ACCURACY_METRES } from '@machvon/db';
import type { EscalationRow, IssueDetail, IssueEventRow, IssueLine, TaskForceRef } from '@machvon/db';

/** Who is reading, and what that person is allowed to see of an issue beyond its place in the work. */
export interface IssueViewer {
  membershipId: string;
  /** A guest contractor sees the work, not the people or the places behind it. */
  guest: boolean;
}

export interface DetailRights {
  /** The reader holds `land.household.read` over the issue: the text that came from a land complaint can name a household. */
  land: boolean;
}

interface Person {
  membership_id: string;
  display_name: string | null;
}

const personOf = (id: string | null, name: string | null): Person | null => (id === null ? null : { membership_id: id, display_name: name });

/** The issue lines as openapi.json exposes them (x-exposure dto): an allowlist, so a column added to the table later is not shown until it is listed here. */
export function issueLineView(line: IssueLine, overdueDays: number | null, viewer: IssueViewer): Record<string, unknown> {
  const own = (id: string): boolean => id === viewer.membershipId;
  return {
    id: line.id,
    code: line.code,
    title: line.title,
    project_id: line.projectId,
    project_code: line.projectCode,
    project_name: line.projectName,
    category_version_id: line.categoryVersionId,
    category_label: line.categoryLabel,
    severity: line.severity,
    status: line.status,
    owner_unit_id: line.ownerUnitId,
    owner_unit_name: line.ownerUnitName,
    assignee: viewer.guest && line.assigneeId !== null && !own(line.assigneeId) ? null : personOf(line.assigneeId, line.assigneeName),
    reported_by: viewer.guest && !own(line.reportedBy) ? null : personOf(line.reportedBy, line.reporterName),
    source_module: line.sourceModule,
    source_ref_id: viewer.guest ? null : line.sourceRefId,
    contract_id: line.contractId,
    escalation_level: line.escalationLevel,
    opened_at: line.openedAt,
    response_due_at: line.responseDueAt,
    responded_at: line.respondedAt,
    due_at: line.dueAt,
    overdue_since: line.overdueSince,
    overdue_days: overdueDays,
    closed_at: line.closedAt,
    reopen_count: line.reopenCount,
    version: line.version,
  };
}

/** What a kind of event may carry in its payload to a reader: ids and dates of the SLA and of a transfer, never free text. */
const PAYLOAD_KEYS: Readonly<Record<string, readonly string[]>> = {
  CREATED: ['sla_policy_id', 'sla_policy_code', 'sla_policy_revision', 'calendar_version_ids', 'response_due_at', 'due_at'],
  TRANSFERRED: ['from_unit_id', 'to_unit_id'],
  ESCALATED: ['escalation_id', 'level', 'trigger', 'target_unit_id', 'task_force_id'],
  ESCALATION_ACCEPTED: ['escalation_id', 'level'],
  SLA_BREACHED: ['overdue_since', 'due_at'],
  REASSIGNED: ['outcome'],
  VERIFICATION_REQUESTED: ['evidence_document_version_ids'],
  CLOSED: ['closed_at'],
  REOPENED: ['reopen_count', 'closed_at'],
  EXTENDED: ['previous_due_at', 'new_due_at', 'extension_number', 'extension_limit'],
};

const withoutDocuments = (payload: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'evidence_document_version_ids'));

function payloadView(kind: string, payload: Record<string, unknown>): Record<string, unknown> {
  const shown: Record<string, unknown> = {};
  for (const key of PAYLOAD_KEYS[kind] ?? []) {
    const value = payload[key];
    if (typeof value === 'string' || typeof value === 'number' || (Array.isArray(value) && value.every((item) => typeof item === 'string'))) shown[key] = value;
  }
  return shown;
}

/**
 * One event of the timeline. The notes of an issue that came from a land complaint are shown only to those who may read the household;
 * a guest sees the notes they wrote themselves and no names but their own.
 */
export function issueEventView(event: IssueEventRow, viewer: IssueViewer, rights: DetailRights, source: string): Record<string, unknown> {
  const own = (id: string | null): boolean => id === viewer.membershipId;
  const named = (id: string | null, name: string | null): Person | null => (id === null || (viewer.guest && !own(id)) ? null : personOf(id, name));
  const noteShown = event.note !== null && (source !== 'LND' || rights.land) && (!viewer.guest || own(event.createdBy));
  return {
    id: event.id,
    kind: event.kind,
    from_status: event.fromStatus,
    to_status: event.toStatus,
    from_assignee: named(event.fromAssigneeId, event.fromAssigneeName),
    to_assignee: named(event.toAssigneeId, event.toAssigneeName),
    note: noteShown ? event.note : null,
    document_version_id: viewer.guest && !own(event.createdBy) ? null : event.documentVersionId,
    actor: named(event.createdBy, event.actorName),
    // The documents named as evidence are shown to staff, and to a guest only on their own request.
    payload: viewer.guest && !own(event.createdBy) ? payloadView(event.kind, withoutDocuments(event.payload)) : payloadView(event.kind, event.payload),
    created_at: event.createdAt,
  };
}

/**
 * The workspace of one issue: the line, the text, the SLA it was opened under and, for staff, the position. A position is personal data
 * of the person who reported it: it is shown only with the consent that stored it, only to staff, and the accuracy carries the warning
 * of BR-ISS-06. The description of an issue from a land complaint is shown only to those who may read the household.
 */
/** What the workspace shows of the escalations of an issue, and of the task force it could be raised to by hand. */
export interface EscalationExtras {
  escalations: readonly EscalationRow[];
  /** The task force that answers for the issue today, only for a reader who may escalate. */
  taskForce: TaskForceRef | undefined;
}

function escalationView(row: EscalationRow, mayReadText: boolean): Record<string, unknown> {
  return {
    id: row.id,
    level: row.level,
    trigger: row.trigger,
    status: row.status,
    target_unit: row.targetUnitId === null ? null : { id: row.targetUnitId, name: row.targetUnitName },
    task_force: row.taskForceId === null ? null : { id: row.taskForceId, code: row.taskForceCode, name: row.taskForceName },
    // The reason of an automatic escalation is a code; the one a person wrote is free text and follows the rule of the notes.
    reason: row.trigger === 'SLA_AUTO' || mayReadText ? row.reason : null,
    accept_due_at: row.dueAt,
    accepted_by: row.acceptedBy === null ? null : { membership_id: row.acceptedBy },
    accepted_at: row.acceptedAt,
    created_at: row.createdAt,
  };
}

export function issueDetailView(detail: IssueDetail, overdueDays: number | null, viewer: IssueViewer, rights: DetailRights, extras: EscalationExtras): Record<string, unknown> {
  const mayReadText = (detail.sourceModule !== 'LND' || rights.land) && (!viewer.guest || detail.reportedBy === viewer.membershipId);
  const hasPosition = detail.geoLat !== null && detail.geoLng !== null;
  const accuracy = detail.geoAccuracyM === null ? null : Number(detail.geoAccuracyM);
  return {
    ...issueLineView(detail, overdueDays, viewer),
    description: mayReadText ? detail.description : null,
    resolved_at: detail.resolvedAt,
    verifier: viewer.guest || detail.verifierId === null ? null : { membership_id: detail.verifierId },
    sla: {
      policy_id: detail.slaPolicyId,
      policy_code: detail.policy.code,
      policy_revision: detail.policy.revision,
      calendar_code: detail.calendarCode,
      response_hours: detail.policy.responseHours,
      resolve_hours: detail.policy.resolveHours,
      require_evidence: detail.policy.requireEvidence,
      require_independent_verifier: detail.policy.requireIndependentVerifier,
    },
    // A guest contractor is told the level the issue has reached (the line has it) and not who answers for it.
    escalations: viewer.guest ? [] : extras.escalations.map((row) => escalationView(row, mayReadText)),
    active_task_force: viewer.guest || extras.taskForce === undefined ? null : { id: extras.taskForce.id, code: extras.taskForce.code, name: extras.taskForce.name },
    extensions: { used: detail.extensionCount, limit: ISSUE_MAX_EXTENSIONS },
    reopen_window_days: ISSUE_REOPEN_WINDOW_DAYS,
    geo_consent: detail.geoConsent,
    geo:
      viewer.guest || !hasPosition
        ? null
        : { lat: detail.geoLat, lng: detail.geoLng, accuracy_m: detail.geoAccuracyM, low_accuracy: accuracy !== null && accuracy > LOW_ACCURACY_METRES },
  };
}
