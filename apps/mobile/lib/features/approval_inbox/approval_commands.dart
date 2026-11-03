import 'package:machvon_api_client/machvon_api_client.dart';

import '../read_support/attempts.dart';
import 'approval_models.dart';

/// What the person decides on a task. An approval is never queued, never sent from a cache and never sent from a push: it is
/// one request, sent while the device is online, under the version of the task that was on the screen.
enum DecisionKind { approve, returnBack }

/// One decision, as the person wrote it. Two equal requests are the same intention (same idempotency key).
final class DecisionRequest {
  const DecisionRequest({required this.taskId, required this.version, required this.kind, this.comment = '', this.sections = const <String>[], this.dueDay});

  final String taskId;
  final int version;
  final DecisionKind kind;

  /// The opinion (approve) or the reasons (return).
  final String comment;

  /// The sections to fix, one per entry (return only).
  final List<String> sections;

  /// The day the corrections are due, `YYYY-MM-DD` (return only).
  final String? dueDay;
}

/// How a request ended.
sealed class DecisionOutcome {
  const DecisionOutcome();
}

/// The server recorded the decision.
final class Decided extends DecisionOutcome {
  const Decided(this.status);

  final String status;
}

/// The server refused: nothing was recorded. [code] is its stable error code.
final class Refused extends DecisionOutcome {
  const Refused(this.code, {this.reassigned = false});

  final String code;

  /// A self-approval was refused and the task was handed on to another approver.
  final bool reassigned;
}

/// The answer was lost: the server may or may not have recorded the decision. Sending the same request again reuses the
/// idempotency key, so the server answers with the first result and never records it twice.
final class ResultUnknown extends DecisionOutcome {
  const ResultUnknown();
}

/// The device is offline: nothing was sent and nothing was queued.
final class DeviceOffline extends DecisionOutcome {
  const DeviceOffline();
}

/// Sends the decisions of one screen. It owns the attempts of the intentions the person is on, so the retry after a lost
/// answer keeps the key and the version of the first request. Nothing is ever written to the offline queue: this class has no
/// way to reach it.
class ApprovalCommands {
  ApprovalCommands({required this.client, required this.isOnline});

  final MachvonApiClient client;

  /// Whether the device can reach the server now; asked before every send.
  final bool Function() isOnline;
  final AttemptRegistry _attempts = AttemptRegistry();

  /// The reason the server stores for a return: the reasons, the sections to fix and the day, in the words of the person's
  /// language ([sectionsLabel], [dueLabel]). The decision of a task carries a reason only, so the sections and the day travel
  /// inside it.
  static String returnReason(DecisionRequest request, {required String sectionsLabel, required String dueLabel, required String dueText}) {
    final StringBuffer out = StringBuffer(request.comment.trim());
    if (request.sections.isNotEmpty) {
      out
        ..write('\n\n$sectionsLabel:')
        ..writeAll(request.sections.map((String section) => '\n- ${section.trim()}'));
    }
    if (request.dueDay != null) out.write('\n$dueLabel: $dueText');
    return out.toString();
  }

  /// Sends one decision. [retryAfterUnknown] is the person asking, after a lost answer, to send the same decision again: the
  /// device may have been left marked offline by that very failure, so this request is the probe and is sent; it never creates
  /// a second decision, because it reuses the key of the first.
  Future<DecisionOutcome> send(DecisionRequest request, {required String returnText, bool retryAfterUnknown = false}) async {
    if (!retryAfterUnknown && !isOnline()) return const DeviceOffline();
    final ApprovalDecision body = request.kind == DecisionKind.approve
        ? ApprovalDecision(decision: 'approve', reason: request.comment.trim().isEmpty ? null : request.comment.trim())
        : ApprovalDecision(decision: 'return', reason: returnText);
    final CommandAttempt attempt = _attempts.forPayload('${request.taskId}|${request.version}|${request.kind.name}|$returnText|${body.reason}');
    try {
      final Object? answer = await client.decideApprovalTask(body, taskId: request.taskId, ifMatchVersion: request.version, attempt: attempt);
      _attempts.done();
      final Object? status = answer is Map ? answer['status'] : null;
      return Decided(status is String ? status : '');
    } on ApiError catch (error) {
      _attempts.ended(error);
      if (error.code == networkErrorCode) return const ResultUnknown();
      return Refused(error.code, reassigned: error.extensions['reassigned'] == true);
    }
  }
}

/// What a refusal means to the person, for the words of the screen.
enum DecisionProblem { selfApproval, stepUp, notAuthorized, alreadyDecided, versionConflict, notRunning, periodLocked, licenseExpired, denied, notFound, validation, sessionEnded, general }

DecisionProblem problemOf(String code) {
  switch (code) {
    case 'SELF_APPROVAL_DENIED':
      return DecisionProblem.selfApproval;
    case 'MFA_REQUIRED':
      return DecisionProblem.stepUp;
    case 'APPROVER_NOT_AUTHORIZED':
      return DecisionProblem.notAuthorized;
    case 'TASK_ALREADY_DECIDED':
      return DecisionProblem.alreadyDecided;
    case 'VERSION_CONFLICT':
      return DecisionProblem.versionConflict;
    case 'WORKFLOW_STATE_INVALID':
      return DecisionProblem.notRunning;
    case 'PERIOD_LOCKED':
      return DecisionProblem.periodLocked;
    case 'LICENSE_EXPIRED':
      return DecisionProblem.licenseExpired;
    case 'SCOPE_DENIED':
    case 'PERMISSION_DENIED':
      return DecisionProblem.denied;
    case 'RESOURCE_NOT_FOUND':
      return DecisionProblem.notFound;
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return DecisionProblem.validation;
    case 'SESSION_EXPIRED':
      return DecisionProblem.sessionEnded;
    default:
      return DecisionProblem.general;
  }
}

/// The reasons of a return as the form checks them before the server does (the server judges the same again).
enum ReturnProblem { reasonRequired, reasonTooLong, sectionsRequired, sectionTooShort, sectionTooLong, tooManySections, dueRequired, dueInvalid }

const int returnReasonMax = 2000;
const int returnSectionMin = 3;
const int returnSectionMax = 2000;
const int returnSectionsMax = 20;

/// The lines of the sections as the person typed them: trimmed, the empty ones left out.
List<String> sectionsOf(String text) => <String>[for (final String line in text.split('\n')) if (line.trim().isNotEmpty) line.trim()];

/// A day that is on the calendar (the 30th of February is not), written `YYYY-MM-DD`.
bool isRealDay(String value) {
  if (!RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(value)) return false;
  final DateTime? parsed = DateTime.tryParse('${value}T00:00:00Z');
  return parsed != null && parsed.toIso8601String().substring(0, 10) == value;
}

/// What the form of a return lacks. A return names the reasons, at least one section to fix and the day the corrections are
/// due; whether the day is still ahead is the server's to judge, not the phone's clock.
Map<String, ReturnProblem> checkReturn({required String reason, required String sectionsText, required String dueDay, required int composedLength}) {
  final Map<String, ReturnProblem> problems = <String, ReturnProblem>{};
  final String trimmed = reason.trim();
  if (trimmed.isEmpty) {
    problems['reason'] = ReturnProblem.reasonRequired;
  } else if (composedLength > returnReasonMax) {
    problems['reason'] = ReturnProblem.reasonTooLong;
  }
  final List<String> sections = sectionsOf(sectionsText);
  if (sections.isEmpty) {
    problems['sections'] = ReturnProblem.sectionsRequired;
  } else if (sections.length > returnSectionsMax) {
    problems['sections'] = ReturnProblem.tooManySections;
  } else if (sections.any((String section) => section.runes.length < returnSectionMin)) {
    problems['sections'] = ReturnProblem.sectionTooShort;
  } else if (sections.any((String section) => section.runes.length > returnSectionMax)) {
    problems['sections'] = ReturnProblem.sectionTooLong;
  }
  if (dueDay.trim().isEmpty) {
    problems['due'] = ReturnProblem.dueRequired;
  } else if (!isRealDay(dueDay.trim())) {
    problems['due'] = ReturnProblem.dueInvalid;
  }
  return problems;
}

/// A decision can be made only on a task that is pending, that the server says the person may decide, in a session that may
/// change things.
bool mayDecide(ApprovalTask task, {required bool sessionReadOnly}) => task.isPending && task.canDecide && !sessionReadOnly;
