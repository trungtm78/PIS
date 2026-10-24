import { LOW_ACCURACY_METRES } from '@machvon/db';
import type { IssueDetail, IssueEventRow, IssueLine } from '@machvon/db';

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
};

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
    payload: payloadView(event.kind, event.payload),
    created_at: event.createdAt,
  };
}

/**
 * The workspace of one issue: the line, the text, the SLA it was opened under and, for staff, the position. A position is personal data
 * of the person who reported it: it is shown only with the consent that stored it, only to staff, and the accuracy carries the warning
 * of BR-ISS-06. The description of an issue from a land complaint is shown only to those who may read the household.
 */
export function issueDetailView(detail: IssueDetail, overdueDays: number | null, viewer: IssueViewer, rights: DetailRights): Record<string, unknown> {
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
    geo_consent: detail.geoConsent,
    geo:
      viewer.guest || !hasPosition
        ? null
        : { lat: detail.geoLat, lng: detail.geoLng, accuracy_m: detail.geoAccuracyM, low_accuracy: accuracy !== null && accuracy > LOW_ACCURACY_METRES },
  };
}
