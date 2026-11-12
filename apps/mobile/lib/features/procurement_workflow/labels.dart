import 'package:flutter/widgets.dart';

import '../../core/format/format.dart';
import '../../core/l10n/app_strings.dart';
import 'workflow_models.dart';

/// A number of days with at most one decimal in the decimal mark of the language: 6 is `6`, 6.5 is `6,5` (`6.5` in English).
String daysNumber(BuildContext context, double value) {
  final double rounded = (value * 10).round() / 10;
  return formatNumber(rounded == rounded.truncateToDouble() ? '${rounded.toInt()}' : '$rounded', AppStrings.of(context).language);
}

/// The words of the codes of the workflow. Each key is written out so the string check can see it is in use; a code the phone does not
/// know is shown as it came, never hidden.

String methodLabel(BuildContext context, String method) {
  switch (method) {
    case 'OPEN_BIDDING':
      return context.t('mob.prc.method.openBidding');
    case 'LIMITED_BIDDING':
      return context.t('mob.prc.method.limitedBidding');
    case 'DIRECT_APPOINTMENT':
      return context.t('mob.prc.method.directAppointment');
    case 'COMPETITIVE_QUOTATION':
      return context.t('mob.prc.method.competitiveQuotation');
    case 'DIRECT_PURCHASE':
      return context.t('mob.prc.method.directPurchase');
    case 'SELF_EXECUTION':
      return context.t('mob.prc.method.selfExecution');
    case 'COMMUNITY_PARTICIPATION':
      return context.t('mob.prc.method.communityParticipation');
    case 'SPECIAL_CASE':
      return context.t('mob.prc.method.specialCase');
    default:
      return method;
  }
}

String statusLabel(BuildContext context, String status) {
  switch (status) {
    case 'IN_PROGRESS':
      return context.t('mob.prc.status.inProgress');
    case 'ON_HOLD':
      return context.t('mob.prc.status.onHold');
    case 'COMPLETED':
      return context.t('mob.prc.status.completed');
    case 'CANCELLED':
      return context.t('mob.prc.status.cancelled');
    case 'NOT_STARTED':
      return context.t('mob.prc.status.notStarted');
    default:
      return status;
  }
}

String healthLabel(BuildContext context, PrcHealth health) {
  switch (health) {
    case PrcHealth.ok:
      return context.t('mob.prc.tree.health.ok');
    case PrcHealth.attention:
      return context.t('mob.prc.tree.health.attention');
    case PrcHealth.late:
      return context.t('mob.prc.tree.health.late');
    case PrcHealth.hold:
      return context.t('mob.prc.tree.health.hold');
    case PrcHealth.none:
      return '';
  }
}

/// The name of a node of the tree: the name from the definition when the server gave one, else the word of its sub-state or terminal.
String nodeLabel(BuildContext context, PrcNode node) {
  if (node.kind == PrcNodeKind.substate) {
    switch (node.substate) {
      case 'ON_HOLD':
        return context.t('mob.prc.tree.substate.onHold');
      case 'LATE':
        return context.t('mob.prc.tree.substate.late');
      case 'RETURNED':
        return context.t('mob.prc.tree.substate.returned');
      case 'ON_TRACK':
        return context.t('mob.prc.tree.substate.onTrack');
    }
  }
  if (node.kind == PrcNodeKind.terminal) {
    switch (node.terminal) {
      case 'NOT_STARTED':
        return context.t('mob.prc.tree.terminal.notStarted');
      case 'COMPLETED':
        return context.t('mob.prc.tree.terminal.completed');
      case 'CANCELLED':
        return context.t('mob.prc.tree.terminal.cancelled');
    }
  }
  if (node.kind == PrcNodeKind.method) return node.label ?? methodLabel(context, node.method ?? '');
  return node.label ?? node.stepCode ?? node.id;
}

String stepStateLabel(BuildContext context, PrcStepState state) {
  switch (state) {
    case PrcStepState.done:
      return context.t('mob.prc.step.done');
    case PrcStepState.current:
      return context.t('mob.prc.step.current');
    case PrcStepState.upcoming:
      return context.t('mob.prc.step.upcoming');
    case PrcStepState.hold:
      return context.t('mob.prc.step.hold');
    case PrcStepState.late:
      return context.t('mob.prc.step.late');
  }
}

String weekdayLabel(BuildContext context, int isoWeekday) {
  switch (isoWeekday) {
    case 1:
      return context.t('mob.prc.timeline.weekday.mon');
    case 2:
      return context.t('mob.prc.timeline.weekday.tue');
    case 3:
      return context.t('mob.prc.timeline.weekday.wed');
    case 4:
      return context.t('mob.prc.timeline.weekday.thu');
    case 5:
      return context.t('mob.prc.timeline.weekday.fri');
    case 6:
      return context.t('mob.prc.timeline.weekday.sat');
    default:
      return context.t('mob.prc.timeline.weekday.sun');
  }
}

String evidenceLabel(BuildContext context, String kind) {
  switch (kind) {
    case 'DOCUMENT':
      return context.t('mob.prc.evidence.document');
    case 'DECISION_DOCUMENT':
      return context.t('mob.prc.evidence.decision');
    case 'MILESTONE':
      return context.t('mob.prc.evidence.milestone');
    case 'ATTESTATION':
      return context.t('mob.prc.evidence.attestation');
    case 'EXTERNAL_RECEIPT':
      return context.t('mob.prc.evidence.receipt');
    default:
      return kind;
  }
}

String milestoneLabel(BuildContext context, String kind) {
  switch (kind) {
    case 'INVITATION_PUBLISHED':
      return context.t('mob.prc.milestone.invitationPublished');
    case 'CLARIFICATION_DEADLINE':
      return context.t('mob.prc.milestone.clarificationDeadline');
    case 'BID_CLOSING':
      return context.t('mob.prc.milestone.bidClosing');
    case 'BID_OPENING':
      return context.t('mob.prc.milestone.bidOpening');
    case 'EVALUATION_DONE':
      return context.t('mob.prc.milestone.evaluationDone');
    case 'RESULT_APPROVED':
      return context.t('mob.prc.milestone.resultApproved');
    case 'RESULT_PUBLISHED':
      return context.t('mob.prc.milestone.resultPublished');
    case 'CONTRACT_SIGNED':
      return context.t('mob.prc.milestone.contractSigned');
    default:
      return kind;
  }
}

String blockerLabel(BuildContext context, PrcBlocker blocker) {
  switch (blocker.reason) {
    case 'ON_HOLD':
      final String? reason = blocker.detail;
      return reason == null ? context.t('mob.prc.blocker.holdNoReason') : context.t('mob.prc.blocker.hold', <String, Object>{'reason': reason});
    case 'REQUIRED_ITEMS_OPEN':
      return context.t('mob.prc.blocker.items', <String, Object>{'n': blocker.count ?? 0});
    case 'EVIDENCE_MISSING':
      return context.t('mob.prc.blocker.evidence');
    case 'EXCEPTION_PENDING':
      return context.t('mob.prc.blocker.exception');
    case 'STEP_OVERDUE':
      return context.t('mob.prc.blocker.overdue', <String, Object>{'n': blocker.count ?? 0});
    case 'NO_OWNER':
      return context.t('mob.prc.blocker.noOwner');
    case 'CALENDAR_UNAVAILABLE':
      return context.t('mob.prc.blocker.calendar');
    default:
      return blocker.reason;
  }
}

/// The countdown of a due day in the words of the row: days left (with the day), due today, or overdue.
String countdownLabel(BuildContext context, int daysLeft, String dueOn) {
  final String date = _shortDay(dueOn);
  if (daysLeft > 0) return context.t('mob.prc.row.countdown.left', <String, Object>{'n': daysLeft, 'date': date});
  if (daysLeft == 0) return context.t('mob.prc.row.countdown.today', <String, Object>{'date': date});
  return context.t('mob.prc.row.countdown.over', <String, Object>{'n': -daysLeft, 'date': date});
}

/// `dd/MM` of a day `YYYY-MM-DD`.
String _shortDay(String value) {
  final String full = formatDay(value);
  return full.length >= 5 ? full.substring(0, 5) : full;
}

String shortDay(String value) => _shortDay(value);

/// The sentence of one entry of the timeline: what happened, with the names of the steps it names.
String entryTitle(BuildContext context, PrcTimelineEntry entry, String Function(String? code) stepName) {
  final String from = stepName(entry.fromStep);
  final String to = stepName(entry.toStep);
  switch (entry.kind) {
    case 'START':
      return context.t('mob.prc.timeline.kind.start');
    case 'STATE_CHANGE':
      return context.t('mob.prc.timeline.kind.change', <String, Object>{'from': from, 'to': to});
    case 'RETURN':
      return context.t('mob.prc.timeline.kind.return', <String, Object>{'from': from, 'to': to});
    case 'CORRECTION':
      return context.t('mob.prc.timeline.kind.correction', <String, Object>{'from': from, 'to': to});
    case 'CHECKLIST_DONE':
      return context.t('mob.prc.timeline.kind.checklist', <String, Object>{'item': entry.subject ?? ''});
    case 'HOLD':
      return context.t('mob.prc.timeline.kind.hold');
    case 'RESUME':
      return context.t('mob.prc.timeline.kind.resume');
    case 'EXCEPTION':
      switch (entry.subject) {
        case 'EXCEPTION_APPROVED':
          return context.t('mob.prc.timeline.kind.exceptionApproved');
        case 'EXCEPTION_REJECTED':
          return context.t('mob.prc.timeline.kind.exceptionRejected');
        default:
          return context.t('mob.prc.timeline.kind.exceptionRequested');
      }
    case 'ASSIGNMENT':
      switch (entry.subject) {
        case 'REASSIGN_OWNER':
          return context.t('mob.prc.timeline.kind.reassignOwner');
        case 'ASSIGN_ITEM':
          return context.t('mob.prc.timeline.kind.assignItem');
        default:
          return context.t('mob.prc.timeline.kind.assignOwner');
      }
    case 'MILESTONE':
      return context.t('mob.prc.timeline.kind.milestone', <String, Object>{'kind': milestoneLabel(context, entry.subject ?? '')});
    case 'IMPORT':
      return context.t('mob.prc.timeline.kind.import', <String, Object>{'kind': milestoneLabel(context, entry.subject ?? '')});
    case 'CLOCK_OVERDUE':
      return context.t('mob.prc.timeline.kind.overdue', <String, Object>{'step': from, 'date': entry.reason == null ? '' : formatDay(entry.reason!)});
    case 'CANCEL':
      return context.t('mob.prc.timeline.kind.cancel');
    case 'COMPLETE':
      return context.t('mob.prc.timeline.kind.complete');
    default:
      return entry.kind;
  }
}
