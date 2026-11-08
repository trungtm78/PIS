import type { EarlyWarningActionRow, EarlyWarningDetail, EarlyWarningIssueRow, EarlyWarningMeetingRow, EarlyWarningRegisterView, EarlyWarningRow } from '@machvon/db';
import type { RegisterClock, WarningSummary } from '@machvon/kernel';
import { nameOf, ruleBasisDto } from './claim-view';
import type { Names } from './claim-view';

export function warningLineDto(row: EarlyWarningRow, names: Names): Record<string, unknown> {
  return {
    id: row.id,
    code: row.code,
    contract: { id: row.contractId, code: row.contractCode },
    title: row.title,
    category: row.category,
    raised_by_party: row.raisedByParty,
    raised_on: row.raisedOn,
    status: row.status,
    likelihood: row.likelihood,
    owner_name: nameOf(names, row.ownerMembershipId),
    expected_time_days: row.expectedTimeDays,
    expected_cost_vnd: row.expectedCostVnd,
    no_impact_expected: row.noImpactExpected,
    open_actions: row.openActions,
    overdue_actions: row.overdueActions,
    version: row.version,
  };
}

export const summaryDto = (summary: WarningSummary): Record<string, unknown> => ({
  total: summary.total,
  open: summary.open,
  by_status: summary.byStatus,
  by_category: summary.byCategory,
  by_party: summary.byParty,
  without_owner: summary.withoutOwner,
  unassessed: summary.unassessed,
  exposure_cost_vnd: summary.exposureCostVnd,
  exposure_time_days: summary.exposureTimeDays,
  impact_unknown: summary.impactUnknown,
  overdue_actions: summary.overdueActions,
});

export const actionDto = (row: EarlyWarningActionRow, names: Names): Record<string, unknown> => ({
  id: row.id,
  description: row.description,
  owner_name: nameOf(names, row.ownerMembershipId),
  owner_membership_id: row.ownerMembershipId,
  due_on: row.dueOn,
  status: row.status,
  done_on: row.doneOn,
  done_by_name: nameOf(names, row.doneBy),
  done_note: row.doneNote,
  overdue: row.overdue,
  version: row.version,
});

export interface WarningRights {
  manage: boolean;
  close: boolean;
}

export function warningDto(detail: EarlyWarningDetail, names: Names, rights: WarningRights, asOf: string): Record<string, unknown> {
  const row = detail.row;
  const open = row.status === 'RAISED' || row.status === 'ASSESSED' || row.status === 'MITIGATING';
  return {
    id: row.id,
    code: row.code,
    contract: { id: row.contractId, code: row.contractCode },
    title: row.title,
    description: row.description,
    category: row.category,
    raised_by_party: row.raisedByParty,
    raised_by_name: nameOf(names, row.raisedBy),
    raised_on: row.raisedOn,
    status: row.status,
    likelihood: row.likelihood,
    owner_name: nameOf(names, row.ownerMembershipId),
    owner_membership_id: row.ownerMembershipId,
    expected_time_days: row.expectedTimeDays,
    expected_cost_vnd: row.expectedCostVnd,
    no_impact_expected: row.noImpactExpected,
    assessed_by_name: nameOf(names, row.assessedBy),
    assessed_at: row.assessedAt,
    closed_by_name: nameOf(names, row.closedBy),
    closed_at: row.closedAt,
    closed_reason: row.closedReason,
    change_request_id: row.changeRequestId,
    claim_id: row.claimId,
    actions: detail.actions.map((action) => actionDto(action, names)),
    reviews: detail.reviews.map((review) => ({ meeting_id: review.meetingId, held_on: review.heldOn, outcome: review.outcome, note: review.note, status_at_meeting: review.statusAtMeeting })),
    allowed: { assess: rights.manage && open, add_action: rights.manage && (row.status === 'ASSESSED' || row.status === 'MITIGATING'), close: rights.close && open },
    as_of: asOf,
    version: row.version,
  };
}

export const clockDto = (clock: RegisterClock): Record<string, unknown> => ({
  code: clock.code,
  state: clock.state,
  started_on: clock.startedOn,
  due_on: clock.dueOn,
  done_on: clock.doneOn,
  days_left: clock.daysLeft,
  period_days: clock.periodDays,
  basis: clock.basis,
  meeting_id: clock.meetingId,
});

const meetingDto = (row: EarlyWarningMeetingRow, names: Names): Record<string, unknown> => ({
  id: row.id,
  ordinal: row.ordinal,
  held_on: row.heldOn,
  attendees: row.attendees,
  notes: row.notes,
  minutes_document_version_id: row.minutesDocumentVersionId,
  recorded_by_name: nameOf(names, row.recordedBy),
  reissued_on: row.reissuedOn,
  reviews: row.reviews.map((review) => ({ warning_id: review.warningId, warning_code: review.warningCode, outcome: review.outcome, note: review.note, status_at_meeting: review.statusAtMeeting })),
});

const issueDto = (row: EarlyWarningIssueRow, names: Names): Record<string, unknown> => ({
  id: row.id,
  ordinal: row.ordinal,
  kind: row.kind,
  issued_on: row.issuedOn,
  meeting_id: row.meetingId,
  warning_count: row.warningCount,
  open_count: row.openCount,
  content_hash: row.contentHash,
  issued_by_name: nameOf(names, row.issuedBy),
});

export interface RegisterRights {
  raise: boolean;
  manage: boolean;
}

export function registerDto(view: EarlyWarningRegisterView, names: Names, rights: RegisterRights): Record<string, unknown> {
  const { policy } = view;
  return {
    contract: { id: view.contract.id, code: view.contract.code, status: view.contract.status, effective_from: view.contract.effectiveFrom },
    clocks: { initial: clockDto(view.clocks.initial), meeting: clockDto(view.clocks.meeting), reissue: view.clocks.reissue === null ? null : clockDto(view.clocks.reissue) },
    meetings: view.meetings.map((meeting) => meetingDto(meeting, names)),
    issues: view.issues.map((issue) => issueDto(issue, names)),
    summary: summaryDto(view.summary),
    policy: {
      rule: ruleBasisDto(policy),
      initial_issue_within_days: policy.initialIssueWithinDays,
      meeting_every_days: policy.meetingEveryDays,
      reissue_within_days_after_meeting: policy.reissueWithinDaysAfterMeeting,
      approach_days: policy.approachDays,
      basis: policy.basis,
    },
    calendar_published: view.calendarPublished,
    allowed: { raise: rights.raise, record_meeting: rights.manage, issue_register: rights.manage },
    as_of: view.asOf,
  };
}
