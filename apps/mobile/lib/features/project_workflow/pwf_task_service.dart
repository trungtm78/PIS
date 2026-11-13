import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

import '../../core/connectivity/reachability.dart';
import '../../core/di/providers.dart' show apiClientProvider;
import '../../core/offline/offline_providers.dart';
import '../../core/offline/queue/command_queue.dart';
import '../../core/offline/queue/queued_command.dart';
import '../command_support/command_outcome.dart';
import '../read_support/attempts.dart';
import 'pwf_commands.dart';
import 'pwf_models.dart';

/// An earlier command of the person on this task was refused or came back in conflict. A new command on the task would be based on a state that
/// is not the one the server holds, so it waits until the person has dealt with the first one (resend it on the new version, or drop it).
final class PwfEarlierCommandUnresolved implements Exception {
  const PwfEarlierCommandUnresolved();

  @override
  String toString() => 'PwfEarlierCommandUnresolved';
}

/// What the person's own commands on one task look like now: the screen draws them as "waiting to be sent", "refused" or "the task changed".
final class PwfTaskQueueView {
  const PwfTaskQueueView(this.commands);

  const PwfTaskQueueView.empty() : commands = const <QueuedCommand>[];

  final List<QueuedCommand> commands;

  List<QueuedCommand> get inFlight => <QueuedCommand>[for (final QueuedCommand c in commands) if (c.state.isPending) c];
  List<QueuedCommand> get conflicts => <QueuedCommand>[for (final QueuedCommand c in commands) if (c.state == CommandState.conflict) c];
  List<QueuedCommand> get refused => <QueuedCommand>[for (final QueuedCommand c in commands) if (c.state == CommandState.rejected) c];

  bool get hasProblem => conflicts.isNotEmpty || refused.isNotEmpty;

  /// The checklist items the person ticked that are not on the server yet.
  Set<String> get pendingItems => <String>{
        for (final QueuedCommand c in commands)
          if (c.commandType == kPwfChecklistCommand && c.state != CommandState.rejected && c.payload?['item_code'] is String) c.payload!['item_code']! as String,
      };

  bool has(String commandType) => commands.any((QueuedCommand c) => c.commandType == commandType && c.state.isPending);
}

/// The commands of one task in the queue now and after every change.
final pwfTaskQueueProvider = StreamProvider.autoDispose.family<PwfTaskQueueView, String>((Ref ref, String taskId) async* {
  final CommandQueue queue = await ref.watch(commandQueueProvider.future);
  yield* queue.watch().map((List<QueuedCommand> commands) => PwfTaskQueueView(pwfCommandsOf(commands, taskId)));
});

/// The work on a task, made on the phone: each action is queued as a command with the idempotency key of the person's intention and sent as soon
/// as there is a connection (at once when there is one). The record on the screen is read again when the server has taken the command.
class PwfTaskService {
  PwfTaskService(this._ref);

  final Ref _ref;

  Future<QueuedCommand> start(PwfTaskDetail task, {required String intention, String? note, String? earlyStartReason}) =>
      _queue(task, kPwfStartCommand, pwfStartPayload(task.id, note: note, earlyStartReason: earlyStartReason), intention);

  Future<QueuedCommand> completeChecklistItem(PwfTaskDetail task, String itemCode, {required String intention, String? note}) =>
      _queue(task, kPwfChecklistCommand, pwfChecklistPayload(task.id, itemCode, note: note), intention);

  Future<QueuedCommand> attachEvidence(
    PwfTaskDetail task, {
    required String intention,
    required String evidenceKind,
    String? itemCode,
    String? legalDocType,
    String? formTemplateCode,
    String? externalRef,
    String? note,
  }) =>
      _queue(
        task,
        kPwfEvidenceCommand,
        pwfEvidencePayload(task.id, evidenceKind: evidenceKind, itemCode: itemCode, legalDocType: legalDocType, formTemplateCode: formTemplateCode, externalRef: externalRef, note: note),
        intention,
      );

  Future<QueuedCommand> complete(PwfTaskDetail task, {required String intention, String? note}) => _queue(task, kPwfCompleteCommand, pwfCompletePayload(task.id, note: note), intention);

  Future<QueuedCommand> requestException(
    PwfTaskDetail task, {
    required String intention,
    required String kind,
    required String reason,
    String? validFrom,
    String? validTo,
    List<String> items = const <String>[],
  }) =>
      _queue(task, kPwfExceptionCommand, pwfExceptionPayload(task.id, kind: kind, reason: reason, validFrom: validFrom, validTo: validTo, items: items), intention);

  Future<QueuedCommand> _queue(PwfTaskDetail task, String commandType, Map<String, Object?> payload, String intention) async {
    final CommandQueue queue = await _ref.read(commandQueueProvider.future);
    final List<QueuedCommand> mine = pwfCommandsOf(queue.commands(), task.id);
    final QueuedCommand? same = mine.where((QueuedCommand c) => c.idempotencyKey == intention).firstOrNull;
    if (same == null && mine.any((QueuedCommand c) => c.state == CommandState.conflict || c.state == CommandState.rejected)) throw const PwfEarlierCommandUnresolved();
    final int base = kPwfVersionedCommands.contains(commandType) ? pwfBaseVersion(task.version, mine.where((QueuedCommand c) => c.idempotencyKey != intention)) : task.version;
    final QueuedCommand command = queue.enqueue(commandType: commandType, payload: payload, baseServerVersion: base, attempt: CommandAttempt(intention));
    (await _ref.read(queueRunnerProvider.future)).trigger();
    return command;
  }

  /// The person looked at the task as it is now and chose to send their commands again on it. From the first command in conflict on, the commands
  /// that have not been taken go back to the queue in the order they were made, each on the version the server holds plus the versioned commands
  /// before it, under a new key (the old one is settled on the server as a conflict). Nothing is written over: the server checks every version again.
  /// A command that follows one the server refused was based on a version the server never reached, so its new base can be lower than its old one;
  /// the queue does not renew a command on a lower base, so such a command is dropped and made again. [serverVersion] is the version of the task they
  /// were looking at.
  Future<int> resendConflicts(String taskId, int serverVersion) async {
    final CommandQueue queue = await _ref.read(commandQueueProvider.future);
    final List<QueuedCommand> mine = pwfCommandsOf(queue.commands(), taskId);
    final int first = mine.indexWhere((QueuedCommand c) => c.state == CommandState.conflict);
    if (first < 0) return 0;
    final int ahead = mine.take(first).where((QueuedCommand c) => c.state != CommandState.rejected && kPwfVersionedCommands.contains(c.commandType)).length;
    int resent = 0;
    int before = ahead;
    for (final QueuedCommand command in mine.skip(first)) {
      if (command.state != CommandState.conflict && command.state != CommandState.queued) continue;
      final int base = serverVersion + before;
      final Map<String, Object?> payload = command.payload!;
      queue.discard(command.id);
      queue.enqueue(commandType: command.commandType, payload: payload, baseServerVersion: base, attempt: CommandAttempt.fresh());
      resent += 1;
      if (kPwfVersionedCommands.contains(command.commandType)) before += 1;
    }
    (await _ref.read(queueRunnerProvider.future)).trigger();
    return resent;
  }

  /// The person chose to drop what they did offline on this task, because it no longer fits what the server holds.
  Future<int> dropUnsent(String taskId) async {
    final CommandQueue queue = await _ref.read(commandQueueProvider.future);
    int dropped = 0;
    for (final QueuedCommand command in pwfCommandsOf(queue.commands(), taskId)) {
      if (command.state == CommandState.queued || command.state == CommandState.conflict || command.state == CommandState.rejected) {
        queue.discard(command.id);
        dropped += 1;
      }
    }
    return dropped;
  }
}

final Provider<PwfTaskService> pwfTaskServiceProvider = Provider<PwfTaskService>(PwfTaskService.new);

/// The decisions of the person who approves the completion of a task. An approval and a return are never queued and never sent from a copy kept on
/// the device: they go to the server while the device is online, on the version the person is looking at, and the server checks the right, the
/// scope and the version again. This class has no way to reach the offline queue.
class PwfDecisionCommands {
  PwfDecisionCommands({required this.client, required this.isOnline});

  final MachvonApiClient client;
  final bool Function() isOnline;
  final AttemptRegistry _approveAttempts = AttemptRegistry();
  final AttemptRegistry _returnAttempts = AttemptRegistry();
  final AttemptRegistry _resumeAttempts = AttemptRegistry();

  Future<CommandOutcome> approve(String taskId, int version, {String? note, bool retryAfterUnknown = false}) {
    final String text = (note ?? '').trim();
    return sendCommand(
      isOnline: isOnline,
      attempts: _approveAttempts,
      intention: '$taskId|$version|APPROVE|$text',
      retryAfterUnknown: retryAfterUnknown,
      call: (CommandAttempt attempt) => client.approveProjectTaskCompletion(PwfDecisionInput(decision: 'APPROVE', note: text.isEmpty ? null : text), taskId: taskId, ifMatchVersion: version, attempt: attempt),
    );
  }

  Future<CommandOutcome> resume(String taskId, int version, {bool retryAfterUnknown = false}) => sendCommand(
        isOnline: isOnline,
        attempts: _resumeAttempts,
        intention: '$taskId|$version|RESUME',
        retryAfterUnknown: retryAfterUnknown,
        call: (CommandAttempt attempt) => client.resumeProjectTask(taskId: taskId, ifMatchVersion: version, attempt: attempt),
      );

  Future<CommandOutcome> returnTask(String taskId, int version, String reason, {bool retryAfterUnknown = false}) {
    final String text = reason.trim();
    return sendCommand(
      isOnline: isOnline,
      attempts: _returnAttempts,
      intention: '$taskId|$version|RETURN|$text',
      retryAfterUnknown: retryAfterUnknown,
      call: (CommandAttempt attempt) => client.returnProjectTask(PwfReturnInput(reason: text), taskId: taskId, ifMatchVersion: version, attempt: attempt),
    );
  }
}

final Provider<PwfDecisionCommands> pwfDecisionCommandsProvider = Provider<PwfDecisionCommands>(
  (Ref ref) => PwfDecisionCommands(client: ref.watch(apiClientProvider), isOnline: () => ref.read(reachabilityProvider) != Reachability.offline),
);
