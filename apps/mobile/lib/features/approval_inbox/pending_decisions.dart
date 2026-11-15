import 'package:flutter/material.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

import '../../core/l10n/app_strings.dart';
import '../read_support/attempts.dart';
import '../read_support/wire.dart';
import 'approval_commands.dart';
import 'approval_models.dart';

/// What a decision on a pending record is: the same three words the web uses.
enum PendingChoice { approve, returnBack, reject }

/// One way of deciding a pending record: the operation of the owning module that carries it out, and the limits of the words the command keeps.
final class PendingAction {
  const PendingAction({required this.choice, required this.operationId, required this.reasonRequired, required this.reasonMin, required this.reasonMax});

  final PendingChoice choice;
  final String operationId;
  final bool reasonRequired;
  final int reasonMin;
  final int reasonMax;
}

/// The commands the phone knows how to send. An item that names another operation is listed but offers no button: nothing is decided blind.
const List<String> pendingOperations = <String>['approveProjectTaskCompletion', 'returnProjectTask', 'decideProjectTaskException', 'decideProjectReschedule', 'decideStaffScoreAdjustment'];

/// A record of a module that waits for the person outside the approval engine (`PendingDecision` of the contract, PWF 20.9): the completion of a
/// task, an exception, a proposal of a new schedule, an adjustment of a score. It is read beside the tasks of the engine and decided by the command of the module that owns it.
final class PendingDecision {
  const PendingDecision({required this.id, required this.kind, required this.resourceId, required this.version, required this.submittedAt, required this.overdue, required this.summary, required this.actions, this.initiatorName, this.dueAt});

  final String id;
  final String kind;
  final String resourceId;

  /// The version the command is sent under (`If-Match`).
  final int version;
  final String submittedAt;
  final String? initiatorName;
  final String? dueAt;
  final bool overdue;
  final ApprovalSummary summary;
  final List<PendingAction> actions;
}

PendingAction? _action(Object? raw) {
  final Json? row = asRecord(raw);
  final String? operation = filled(row?['operation_id']);
  final PendingChoice? choice = switch (row?['decision']) {
    'approve' => PendingChoice.approve,
    'return' => PendingChoice.returnBack,
    'reject' => PendingChoice.reject,
    _ => null,
  };
  if (row == null || operation == null || choice == null || !pendingOperations.contains(operation)) return null;
  return PendingAction(choice: choice, operationId: operation, reasonRequired: row['reason_required'] == true, reasonMin: whole(row['reason_min']) ?? 0, reasonMax: whole(row['reason_max']) ?? 500);
}

PendingDecision? parsePendingDecision(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final String? kind = filled(row?['kind']);
  final String? resourceId = filled(asRecord(row?['resource'])?['id']);
  final String? submittedAt = filled(row?['submitted_at']);
  final int? version = whole(row?['version']);
  final ApprovalSummary? summary = parseApprovalSummary(row?['summary']);
  if (row == null || id == null || kind == null || resourceId == null || submittedAt == null || version == null || summary == null) return null;
  return PendingDecision(
    id: id,
    kind: kind,
    resourceId: resourceId,
    version: version,
    submittedAt: submittedAt,
    initiatorName: filled(asRecord(row['initiator'])?['name']),
    dueAt: filled(row['due_at']),
    overdue: row['overdue'] == true,
    summary: summary,
    actions: <PendingAction>[for (final Object? one in listOf(row['actions'])) ?_action(one)],
  );
}

/// The words a decision is checked against before the command does the same again: required for a return, never shorter than the command accepts once given, never longer.
enum PendingWords { required, tooShort, tooLong }

PendingWords? checkPendingWords(PendingAction action, String comment) {
  final int length = comment.trim().runes.length;
  if (length == 0) return action.reasonRequired ? PendingWords.required : null;
  if (length < action.reasonMin) return PendingWords.tooShort;
  return length > action.reasonMax ? PendingWords.tooLong : null;
}

/// The name of a kind of pending record. Each key is written out so the string check can see it is in use.
String pendingKindLabel(BuildContext context, String kind) {
  switch (kind) {
    case 'pwf.task.completion':
      return context.t('mob.apv.pend.kind.completion');
    case 'pwf.task.exception':
      return context.t('mob.apv.pend.kind.exception');
    case 'pwf.reschedule':
      return context.t('mob.apv.pend.kind.reschedule');
    case 'pwf.score.adjustment':
      return context.t('mob.apv.pend.kind.adjustment');
    default:
      return context.t('mob.apv.pend.kind.other');
  }
}

/// The name of a button of a decision.
String pendingChoiceLabel(BuildContext context, PendingChoice choice) => switch (choice) {
      PendingChoice.approve => context.t('mob.apv.pend.action.approve'),
      PendingChoice.returnBack => context.t('mob.apv.pend.action.return'),
      PendingChoice.reject => context.t('mob.apv.pend.action.reject'),
    };

String pendingWordsText(BuildContext context, PendingWords problem, PendingAction action) => switch (problem) {
      PendingWords.required => context.t('mob.apv.pend.error.required'),
      PendingWords.tooShort => context.t('mob.apv.pend.error.tooShort', <String, Object>{'min': action.reasonMin}),
      PendingWords.tooLong => context.t('mob.apv.pend.error.tooLong', <String, Object>{'max': action.reasonMax}),
    };

/// What a refusal of the commands of PWF means, beyond the ones the engine gives: a maker is never the approver, and a record that moved or was decided meanwhile.
DecisionProblem pendingProblemOf(String code) {
  switch (code) {
    case 'MAKER_IS_APPROVER':
      return DecisionProblem.maker;
    case 'PWF_SCHEDULE_VERSION_CONFLICT':
    case 'PWF_TASK_STATE_INVALID':
    case 'PWF_EXCEPTION_INVALID':
    case 'STAFF_SCORE_ADJUSTMENT_INVALID':
    case 'STAFF_SCORE_PERIOD_LOCKED':
      return DecisionProblem.moved;
    default:
      return problemOf(code);
  }
}

/// Sends the decisions of one sheet through the command each action names. It owns the attempts of the intention the person is on, so the retry after a lost answer keeps its key and its version. Never queued:
/// one request, sent while the device is online, under the version that was on the screen.
class PendingCommands {
  PendingCommands({required this.client, required this.isOnline});

  final MachvonApiClient client;
  final bool Function() isOnline;
  final AttemptRegistry _attempts = AttemptRegistry();

  Future<DecisionOutcome> send(PendingDecision item, PendingAction action, String comment, {bool retryAfterUnknown = false}) async {
    if (!retryAfterUnknown && !isOnline()) return const DeviceOffline();
    final String words = comment.trim();
    final String? note = words.isEmpty ? null : words;
    final String decision = action.choice == PendingChoice.approve ? 'APPROVE' : 'REJECT';
    final CommandAttempt attempt = _attempts.forPayload('${item.id}|${item.version}|${action.operationId}|$decision|$words');
    try {
      final Object? answer = switch (action.operationId) {
        'approveProjectTaskCompletion' => await client.approveProjectTaskCompletion(PwfDecisionInput(decision: 'APPROVE', note: note), taskId: item.resourceId, ifMatchVersion: item.version, attempt: attempt),
        'returnProjectTask' => await client.returnProjectTask(PwfReturnInput(reason: words), taskId: item.resourceId, ifMatchVersion: item.version, attempt: attempt),
        'decideProjectTaskException' => await client.decideProjectTaskException(PwfDecisionInput(decision: decision, note: note), id: item.resourceId, ifMatchVersion: item.version, attempt: attempt),
        'decideProjectReschedule' => await client.decideProjectReschedule(PwfDecisionInput(decision: decision, note: note), id: item.resourceId, ifMatchVersion: item.version, attempt: attempt),
        _ => await client.decideStaffScoreAdjustment(PwfDecisionInput(decision: decision, note: note), id: item.resourceId, ifMatchVersion: item.version, attempt: attempt),
      };
      _attempts.done();
      final Object? status = answer is Map ? answer['status'] : null;
      return Decided(status is String ? status : '');
    } on ApiError catch (error) {
      _attempts.ended(error);
      if (error.code == networkErrorCode) return const ResultUnknown();
      return Refused(error.code);
    }
  }
}
