import type { DirectiveDetail, DirectiveEventView, DirectiveLine, DirectiveSummary, EvidenceView, ExtensionView, MeetingLine, ReportView } from '@machvon/db';
import { message } from '@machvon/kernel';
import type { DirectivePolicyReading, ResourceRef } from '@machvon/kernel';

const unit = (value: { id: string; code: string; name: string }): Record<string, unknown> => ({ id: value.id, code: value.code, name: value.name });
const person = (value: { membershipId: string; displayName: string }): Record<string, unknown> => ({ membership_id: value.membershipId, display_name: value.displayName });

/** A directive as openapi.json exposes it (x-exposure dto): an allowlist, so a column added later is not shown until it is listed here. The status is the one a reader sees (OVERDUE is not stored). */
export function directiveLineView(line: DirectiveLine): Record<string, unknown> {
  return {
    id: line.id,
    code: line.code,
    seq: line.seq,
    meeting: { id: line.meeting.id, code: line.meeting.code, meeting_date: line.meeting.meetingDate, title: line.meeting.title },
    scope_kind: line.scopeKind,
    project: line.project === null ? null : { id: line.project.id, code: line.project.code, name: line.project.name },
    scope_unit: unit(line.scopeUnit),
    text: line.text,
    assignee_unit: unit(line.assigneeUnit),
    assignee: line.assignee === null ? null : person(line.assignee),
    original_due_on: line.originalDueOn,
    due_on: line.dueOn,
    extension_count: line.extensionCount,
    status: line.clock.status,
    stored_status: line.storedStatus,
    phase: line.clock.phase,
    days_to_due: line.clock.daysToDue,
    overdue_days: line.clock.overdueDays,
    reminder_today: line.clock.reminderToday,
    escalates_on: line.clock.escalatesOn,
    closed_at: line.closedAt,
    evidence_count: line.evidenceCount,
    progress_percent: line.progressPct,
    progress_reported_at: line.progressReportedAt,
    open_extension: line.openExtension === null ? null : { id: line.openExtension.id, proposed_due_on: line.openExtension.proposedDueOn, requested_by: line.openExtension.requestedBy, version: line.openExtension.version },
    created_by: person(line.createdBy),
    created_at: line.createdAt,
    version: line.version,
  };
}

export function meetingLineView(meeting: MeetingLine): Record<string, unknown> {
  return {
    id: meeting.id,
    code: meeting.code,
    meeting_date: meeting.meetingDate,
    meeting_type: meeting.meetingType,
    title: meeting.title,
    summary: meeting.summary,
    unit: unit(meeting.unit),
    minutes_document_version_id: meeting.minutesDocumentVersionId,
    created_by: meeting.createdBy,
    created_at: meeting.createdAt,
    version: meeting.version,
    counts: { total: meeting.counts.total, by_status: meeting.counts.byStatus },
  };
}

function eventView(event: DirectiveEventView): Record<string, unknown> {
  return {
    id: event.id,
    type: event.type,
    actor: person(event.actor),
    occurred_at: event.occurredAt,
    note: event.note,
    progress_pct: event.progressPct,
    from_assignee_unit: event.fromAssigneeUnit === null ? null : unit(event.fromAssigneeUnit),
    to_assignee_unit: event.toAssigneeUnit === null ? null : unit(event.toAssigneeUnit),
    from_assignee_membership_id: event.fromAssigneeMembershipId,
    to_assignee_membership_id: event.toAssigneeMembershipId,
    from_due_on: event.fromDueOn,
    to_due_on: event.toDueOn,
    extension_id: event.extensionId,
    approver: event.approver === null ? null : person(event.approver),
    directive_version: event.directiveVersion,
  };
}

function extensionView(extension: ExtensionView): Record<string, unknown> {
  return {
    id: extension.id,
    from_due_on: extension.fromDueOn,
    proposed_due_on: extension.proposedDueOn,
    reason: extension.reason,
    status: extension.status,
    requested_by: person(extension.requestedBy),
    requested_at: extension.requestedAt,
    decided_by: extension.decidedBy === null ? null : person(extension.decidedBy),
    decided_at: extension.decidedAt,
    decision_reason: extension.decisionReason,
    version: extension.version,
  };
}

function evidenceView(evidence: EvidenceView): Record<string, unknown> {
  return { id: evidence.id, document_version_id: evidence.documentVersionId, title: evidence.title, added_by: person(evidence.addedBy), added_at: evidence.addedAt, event_id: evidence.eventId };
}

/** The parameters in force with where they came from: the numbers on the screens that follow them say so, and a built-in default is flagged as not confirmed. */
export function policyView(reading: DirectivePolicyReading): Record<string, unknown> {
  return {
    code: reading.code,
    version: reading.version,
    source: reading.source,
    unverified: reading.source === 'DEFAULT',
    reminder_days_before: reading.params.reminderDaysBefore,
    escalate_after_overdue_days: reading.params.escalateAfterOverdueDays,
    max_extensions: reading.params.maxExtensions,
    max_extension_days: reading.params.maxExtensionDays,
    close_requires_evidence: reading.params.closeRequiresEvidence,
  };
}

export function directiveDetailView(detail: DirectiveDetail, policy: DirectivePolicyReading, actions: Record<string, boolean>, asOf: string): Record<string, unknown> {
  return {
    directive: directiveLineView(detail.directive),
    timeline: detail.events.map(eventView),
    extensions: detail.extensions.map(extensionView),
    evidence: detail.evidence.map(evidenceView),
    policy: policyView(policy),
    actions,
    as_of: asOf,
  };
}

/** What each number on the summary is, in the words of the user: its formula, its source and the day it is read on. */
export const SUMMARY_DEFINITIONS = {
  by_status: message('dir.view.summary.by_status'),
  due_soon: message('dir.view.summary.due_soon'),
  escalated: message('dir.view.summary.escalated'),
  by_unit: message('dir.view.summary.by_unit'),
} as const;

export function summaryView(summary: DirectiveSummary, policy: DirectivePolicyReading, asOf: string): Record<string, unknown> {
  return {
    total: summary.total,
    by_status: summary.byStatus,
    due_soon: summary.dueSoon,
    escalated: summary.escalated,
    by_unit: summary.byUnit.map((row) => ({ unit: unit(row.unit), total: row.total, open: row.open, overdue: row.overdue, done: row.done })),
    truncated: summary.truncated,
    definitions: SUMMARY_DEFINITIONS,
    policy: policyView(policy),
    as_of: asOf,
  };
}

export const REPORT_DEFINITIONS = {
  raised: message('dir.view.report.raised'),
  closed: message('dir.view.report.closed'),
  extended: message('dir.view.report.extended'),
  open_at_end: message('dir.view.report.open_at_end'),
  overdue_at_end: message('dir.view.report.overdue_at_end'),
  by_status: message('dir.view.report.by_status'),
} as const;

export function reportView(report: ReportView, asOf: string): Record<string, unknown> {
  return {
    period: { from: report.from, to: report.to },
    counts: {
      total: report.counts.total,
      raised: report.counts.raised,
      closed: report.counts.closed,
      extended: report.counts.extended,
      open_at_end: report.counts.openAtEnd,
      overdue_at_end: report.counts.overdueAtEnd,
      by_status: report.counts.byStatus,
    },
    items: report.items.map((item) => ({
      id: item.id,
      code: item.code,
      meeting: { id: item.meeting.id, code: item.meeting.code, meeting_date: item.meeting.meetingDate },
      scope_kind: item.scopeKind,
      project: item.project === null ? null : { id: item.project.id, code: item.project.code, name: item.project.name },
      text: item.text,
      assignee_unit: unit(item.assigneeUnit),
      due_on_at_end: item.dueOnAtEnd,
      status_at_end: item.statusAtEnd,
      raised_in_period: item.facts.raisedInPeriod,
      closed_in_period: item.facts.closedInPeriod,
      extended_in_period: item.facts.extendedInPeriod,
      open_at_end: item.facts.openAtEnd,
      last_note: item.lastNote,
      last_note_on: item.lastNoteOn,
    })),
    truncated: report.truncated,
    definitions: REPORT_DEFINITIONS,
    as_of: asOf,
  };
}

/** The places of a directive as the permission test names them. */
export const placesOf = (line: DirectiveLine): ResourceRef[] => line.places.map((place) => ({ ownerUnitId: place.ownerUnitId, ownerUnitPath: place.ownerUnitPath, ...(place.projectId === undefined ? {} : { projectId: place.projectId }) }));
