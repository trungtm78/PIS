import 'package:flutter/widgets.dart';

import '../../core/l10n/app_strings.dart';
import '../field_evidence/field_place.dart';
import '../field_evidence/place_format.dart';
import 'issue_comments.dart';
import 'issue_draft.dart';
import 'issue_follow_up.dart';

String severityText(BuildContext context, String severity) {
  switch (severity) {
    case 'LOW':
      return context.t('mob.fld.severity.low');
    case 'HIGH':
      return context.t('mob.fld.severity.high');
    case 'CRITICAL':
      return context.t('mob.fld.severity.critical');
    default:
      return context.t('mob.fld.severity.medium');
  }
}

String statusText(BuildContext context, String status) {
  switch (status) {
    case 'ASSIGNED':
      return context.t('mob.fld.status.assigned');
    case 'IN_PROGRESS':
      return context.t('mob.fld.status.inProgress');
    case 'ESCALATED':
      return context.t('mob.fld.status.escalated');
    case 'PENDING_VERIFICATION':
      return context.t('mob.fld.status.pendingVerification');
    case 'CLOSED':
      return context.t('mob.fld.status.closed');
    case 'REOPENED':
      return context.t('mob.fld.status.reopened');
    default:
      return context.t('mob.fld.status.open');
  }
}

String issueProblemText(BuildContext context, IssueProblem problem) {
  switch (problem) {
    case IssueProblem.required:
      return context.t('mob.fld.field.required');
    case IssueProblem.tooLong:
      return context.t('mob.fld.field.tooLong');
  }
}

/// The label a place typed by hand carries into the description of the issue, in the language of the person who wrote it.
String manualPlaceLabel(BuildContext context) =>
    context.t('mob.fld.place.manual.label');

String draftTitle(BuildContext context, IssueDraft draft) =>
    draft.title.trim().isEmpty
    ? context.t('mob.fld.waiting.draft.untitled')
    : draft.title.trim();

/// The place in a line: where it came from is always said.
String placeSummary(BuildContext context, FieldPlace place) {
  switch (place.source) {
    case PlaceSource.none:
      return context.t('mob.fld.place.none');
    case PlaceSource.manual:
      return context.t('mob.fld.place.manual.summary', <String, Object>{
        'text': place.manualText ?? '',
      });
    case PlaceSource.device:
      final DevicePosition position = place.position!;
      return context.t('mob.fld.place.device.summary', <String, Object>{
        'lat': coordinateLabel(context, latitudeText(position)),
        'lng': coordinateLabel(context, longitudeText(position)),
        'accuracy': metresLabel(context, position.accuracyMetres),
      });
  }
}

String checkText(BuildContext context, FieldCheck check) {
  final bool ok = check.status == CheckStatus.ok;
  switch (check.id) {
    case 'chosen':
      return ok
          ? context.t('mob.fld.check.chosen.ok')
          : context.t('mob.fld.check.chosen.missing');
    case 'details':
      return ok
          ? context.t('mob.fld.check.details.ok')
          : context.t('mob.fld.check.details.missing');
    case 'photo':
      return ok
          ? context.t('mob.fld.check.photo.ok')
          : context.t('mob.fld.check.photo.warning');
    case 'place':
      return ok
          ? context.t('mob.fld.check.place.ok')
          : context.t('mob.fld.check.place.warning');
    default:
      return ok
          ? context.t('mob.fld.check.metadata.ok')
          : context.t('mob.fld.check.metadata.missing');
  }
}

String checkStatusText(BuildContext context, CheckStatus status) {
  switch (status) {
    case CheckStatus.ok:
      return context.t('mob.fld.check.status.ok');
    case CheckStatus.warning:
      return context.t('mob.fld.check.status.warning');
    case CheckStatus.missing:
      return context.t('mob.fld.check.status.missing');
  }
}

String eventText(BuildContext context, IssueEvent event) {
  switch (event.kind) {
    case 'CREATED':
      return context.t('mob.fld.event.created');
    case 'ASSIGNED':
    case 'REASSIGNED':
      return context.t('mob.fld.event.assigned', <String, Object>{
        'to': event.toAssignee ?? '',
      });
    case 'TRANSFERRED':
      return context.t('mob.fld.event.transferred');
    case 'STARTED':
      return context.t('mob.fld.event.started');
    case 'COMMENTED':
      return context.t('mob.fld.event.commented');
    case 'EVIDENCE_ADDED':
      return context.t('mob.fld.event.evidence');
    case 'EXTENSION_REQUESTED':
    case 'EXTENDED':
      return context.t('mob.fld.event.extended');
    case 'ESCALATED':
    case 'ESCALATION_ACCEPTED':
      return context.t('mob.fld.event.escalated');
    case 'VERIFICATION_REQUESTED':
      return context.t('mob.fld.event.verification');
    case 'CLOSED':
      return context.t('mob.fld.event.closed');
    case 'REOPENED':
      return context.t('mob.fld.event.reopened');
    case 'SLA_BREACHED':
      return context.t('mob.fld.event.breached');
    default:
      return context.t('mob.fld.event.source');
  }
}

String commentProblemText(BuildContext context, CommentProblem problem) {
  switch (problem) {
    case CommentProblem.closed:
      return context.t('mob.fld.comment.problem.closed');
    case CommentProblem.validation:
      return context.t('mob.fld.comment.problem.validation');
    case CommentProblem.denied:
      return context.t('mob.fld.comment.problem.denied');
    case CommentProblem.notFound:
      return context.t('mob.fld.comment.problem.notFound');
    case CommentProblem.sessionEnded:
      return context.t('mob.fld.comment.problem.sessionEnded');
    case CommentProblem.general:
      return context.t('mob.fld.comment.problem.general');
  }
}

String commentFormText(BuildContext context, CommentFormProblem problem) =>
    problem == CommentFormProblem.required
    ? context.t('mob.fld.field.required')
    : context.t('mob.fld.field.tooLong');
