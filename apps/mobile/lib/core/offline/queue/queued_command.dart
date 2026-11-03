import 'dart:convert';

/// Where a queued command stands (MOB.md 4). The names of the design are kept, so the queue, the screens and the tests
/// speak the same words:
///
/// ```
///  queued --send--> sending --accepted--> accepted
///     |                |-- rejected --> rejected
///     |                |-- conflict --> conflict --resolve--> queued
///     |                '-- no answer --> unknown --lookup--> accepted | rejected | conflict | queued
///     '--discard--> discarded
/// ```
enum CommandState {
  /// Waiting for a network (or for its backoff to end). In the words of the first draft of the story: pending.
  queued,

  /// Sent in a batch; the answer has not arrived. A command found in this state after a restart is [unknown].
  sending,

  /// The request may have been carried out and the answer was lost ("Chưa xác định kết quả"). It is looked up by its
  /// key and never created again.
  unknown,

  /// Carried out by the server. Kept as a receipt until it is pruned. In the words of the first draft: done.
  accepted,

  /// Refused for good with a code of the platform (`PERIOD_LOCKED`, `LICENSE_EXPIRED`, ...). The person corrects or
  /// drops it. In the words of the first draft: failed.
  rejected,

  /// The record moved on since the command was based on it; the person chooses (MOB-42). Never last write wins.
  conflict,

  /// Dropped by the person before it was sent.
  discarded;

  /// Commands that have not reached a final answer and still count on the sync banner.
  bool get isPending => this == queued || this == sending || this == unknown;

  /// No further movement except through a new decision of the person ([rejected] and [conflict] only).
  bool get isSettled => this == accepted || this == discarded;

  static CommandState parse(String name) => CommandState.values.byName(name);
}

/// The moves the state machine allows. Anything else is a programming error ([StateError]); the rows are the table of
/// MOB.md 4 with the two moves that make it safe to live with: `sending -> queued` (the server said it kept nothing and
/// the command is sent again under the same key) and `unknown -> queued` (the lookup found nothing).
const Map<CommandState, Set<CommandState>> kAllowedMoves = <CommandState, Set<CommandState>>{
  CommandState.queued: <CommandState>{CommandState.sending, CommandState.discarded},
  CommandState.sending: <CommandState>{
    CommandState.accepted,
    CommandState.rejected,
    CommandState.conflict,
    CommandState.unknown,
    CommandState.queued,
  },
  // An unknown command is never discarded: it may have been carried out, and dropping it would hide that.
  CommandState.unknown: <CommandState>{CommandState.accepted, CommandState.rejected, CommandState.conflict, CommandState.queued},
  CommandState.rejected: <CommandState>{CommandState.queued, CommandState.discarded},
  CommandState.conflict: <CommandState>{CommandState.queued, CommandState.discarded},
  CommandState.accepted: <CommandState>{},
  CommandState.discarded: <CommandState>{},
};

bool canMove(CommandState from, CommandState to) => kAllowedMoves[from]!.contains(to);

/// One command in the offline queue (`queued_command`). It carries the tenant and the user it was made under (the
/// envelope): it is never sent under another tenant or by another user.
final class QueuedCommand {
  const QueuedCommand({
    required this.id,
    required this.tenantId,
    required this.userId,
    required this.commandType,
    required this.payload,
    required this.payloadBytes,
    required this.baseServerVersion,
    required this.idempotencyKey,
    required this.state,
    required this.createdAt,
    required this.updatedAt,
    this.supersededKeys = const <String>[],
    this.attempts = 0,
    this.nextAttemptAt = 0,
    this.errorCode,
    this.serverVersion,
    this.resultRef,
    this.draftId,
    this.releaseDraft = false,
    this.sentAt,
    this.settledAt,
  });

  /// The local id (a UUID) of the command, stable for the life of the row. The idempotency key can change (a corrected
  /// command is a new intention); the id does not.
  final String id;
  final String tenantId;
  final String userId;

  /// The operation the server carries out (`report.submit`, `report.draft.save`, `issue.create`, ...).
  final String commandType;

  /// What the command sends. Null once the command is settled: an accepted or a discarded command keeps no data.
  final Map<String, Object?>? payload;
  final int payloadBytes;

  /// The version of the record the person saw when the command was made (`If-Match` on the server).
  final int baseServerVersion;

  /// The key every send of this command carries; the server runs the command once however often it is sent.
  final String idempotencyKey;

  /// The keys this command had before a new decision gave it a new one (the settled receipts of the server keep them).
  final List<String> supersededKeys;
  final CommandState state;

  /// How often the command was sent and came back without a settled answer; drives the backoff.
  final int attempts;

  /// Epoch milliseconds before which the command is not sent again.
  final int nextAttemptAt;

  /// The code of the last refusal, conflict or failure (`PERIOD_LOCKED`, `VERSION_CONFLICT`, `NETWORK_ERROR`, ...).
  final String? errorCode;

  /// The version the server holds (from a conflict) or produced (from an acceptance).
  final int? serverVersion;
  final String? resultRef;

  /// The local draft this command was made from; it is kept intact whatever the server answers.
  final String? draftId;

  /// Whether the draft is removed when the command is accepted (a submit) or kept with the new version (a save).
  final bool releaseDraft;
  final int createdAt;
  final int updatedAt;
  final int? sentAt;
  final int? settledAt;

  QueuedCommand copyWith({
    Map<String, Object?>? payload,
    bool clearPayload = false,
    int? payloadBytes,
    int? baseServerVersion,
    String? idempotencyKey,
    List<String>? supersededKeys,
    CommandState? state,
    int? attempts,
    int? nextAttemptAt,
    String? errorCode,
    bool clearError = false,
    int? serverVersion,
    String? resultRef,
    int? updatedAt,
    int? sentAt,
    int? settledAt,
  }) =>
      QueuedCommand(
        id: id,
        tenantId: tenantId,
        userId: userId,
        commandType: commandType,
        payload: clearPayload ? null : payload ?? this.payload,
        payloadBytes: payloadBytes ?? this.payloadBytes,
        baseServerVersion: baseServerVersion ?? this.baseServerVersion,
        idempotencyKey: idempotencyKey ?? this.idempotencyKey,
        supersededKeys: supersededKeys ?? this.supersededKeys,
        state: state ?? this.state,
        attempts: attempts ?? this.attempts,
        nextAttemptAt: nextAttemptAt ?? this.nextAttemptAt,
        errorCode: clearError ? null : errorCode ?? this.errorCode,
        serverVersion: serverVersion ?? this.serverVersion,
        resultRef: resultRef ?? this.resultRef,
        draftId: draftId,
        releaseDraft: releaseDraft,
        createdAt: createdAt,
        updatedAt: updatedAt ?? this.updatedAt,
        sentAt: sentAt ?? this.sentAt,
        settledAt: settledAt ?? this.settledAt,
      );

  @override
  String toString() => 'QueuedCommand($id, $commandType, ${state.name})';
}

/// The size of a payload as it is stored (UTF-8 bytes of its JSON), shown on MOB-41.
int payloadSizeOf(Map<String, Object?> payload) => utf8.encode(jsonEncode(payload)).length;
