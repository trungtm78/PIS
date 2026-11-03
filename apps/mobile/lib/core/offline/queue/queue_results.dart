import 'offline_codes.dart';
import 'queued_command.dart';

/// What stopped a flush before it could send everything. The commands are intact in every case.
enum FlushBlocker {
  /// Nobody is signed in to the tenant and user the queue belongs to: nothing is sent under another identity.
  noSession,

  /// The device has no registration id yet (`POST /sync/batches` names the device).
  noDevice,

  /// No answer arrived: the device is offline or the connection was lost. Sent commands are unknown, never lost.
  offline,

  /// The session lapsed (401). The commands wait for the next sign-in.
  sessionExpired,

  /// The server refused the device or the right to sync (403).
  deviceRejected,

  /// The server could not take the batch now (429, 503); a later send is safe.
  busy,

  /// The server failed (5xx) after it may have started: the sent commands are unknown.
  serverError,
}

/// The counts of one flush, for the progress shown on MOB-41 and for the tests.
final class FlushResult {
  const FlushResult({
    required this.accepted,
    required this.conflicts,
    required this.rejected,
    required this.unknown,
    required this.requeued,
    required this.looked,
    this.blocker,
  });

  factory FlushResult.blocked(FlushBlocker blocker) =>
      FlushResult(accepted: 0, conflicts: 0, rejected: 0, unknown: 0, requeued: 0, looked: 0, blocker: blocker);

  final int accepted;
  final int conflicts;
  final int rejected;

  /// Commands that were sent and whose answer is lost.
  final int unknown;

  /// Commands that go back to the queue to be sent again under the same key.
  final int requeued;

  /// Lookups of unknown commands by key that the server answered.
  final int looked;
  final FlushBlocker? blocker;

  @override
  String toString() => 'FlushResult(accepted: $accepted, conflicts: $conflicts, rejected: $rejected, unknown: $unknown, requeued: $requeued, blocker: $blocker)';
}

/// The running counts of a flush; the queue fills it and turns it into a [FlushResult].
final class Tally {
  int accepted = 0;
  int conflicts = 0;
  int rejected = 0;
  int unknown = 0;
  int requeued = 0;
  int looked = 0;

  FlushResult result(FlushBlocker? blocker) => FlushResult(
        accepted: accepted,
        conflicts: conflicts,
        rejected: rejected,
        unknown: unknown,
        requeued: requeued,
        looked: looked,
        blocker: blocker,
      );
}

/// A move of a command, announced on [CommandQueue.events]. [from] is null for a command that was just made.
final class QueueEvent {
  const QueueEvent(this.command, this.from);

  final QueuedCommand command;
  final CommandState? from;

  bool get becameAccepted => command.state == CommandState.accepted && from != CommandState.accepted;
  bool get becameConflict => command.state == CommandState.conflict && from != CommandState.conflict;

  /// The server refused the command because the reporting period is locked; the draft is intact.
  bool get becamePeriodLocked => command.state == CommandState.rejected && command.errorCode == kPeriodLocked && from != CommandState.rejected;
}

/// A command that was refused as `RESULT_UNVERIFIABLE` cannot be sent again as if it had never been tried: the server may have carried
/// it out before it forgot its receipts, and a new key would do the work twice. The person checks the record, then either drops the
/// command or sends it again knowingly (`CommandQueue.retry(confirmedNotExecuted: true)`).
final class ResultUnverifiable implements Exception {
  const ResultUnverifiable(this.commandId);

  final String commandId;

  @override
  String toString() => 'ResultUnverifiable';
}

/// A key that stands for a command is used for a different one. The server would refuse it (`IDEMPOTENCY_CONFLICT`);
/// the queue refuses it first, because it is always a programming error: one intention is one key.
final class IdempotencyKeyReuse implements Exception {
  const IdempotencyKeyReuse(this.key);

  final String key;

  @override
  String toString() => 'IdempotencyKeyReuse';
}

/// The numbers a screen or an alert needs from the queue (MOB.md 9: queue length, rate of UNKNOWN).
final class QueueStats {
  const QueueStats({
    required this.queued,
    required this.sending,
    required this.unknown,
    required this.rejected,
    required this.conflict,
    required this.accepted,
    required this.pendingBytes,
    this.oldestPendingAgeMs,
  });

  factory QueueStats.of(Map<CommandState, int> counts, List<QueuedCommand> pending, int nowMs) => QueueStats(
        queued: counts[CommandState.queued] ?? 0,
        sending: counts[CommandState.sending] ?? 0,
        unknown: counts[CommandState.unknown] ?? 0,
        rejected: counts[CommandState.rejected] ?? 0,
        conflict: counts[CommandState.conflict] ?? 0,
        accepted: counts[CommandState.accepted] ?? 0,
        pendingBytes: pending.fold(0, (int sum, QueuedCommand c) => sum + c.payloadBytes),
        oldestPendingAgeMs: pending.isEmpty ? null : nowMs - pending.map((QueuedCommand c) => c.createdAt).reduce((int a, int b) => a < b ? a : b),
      );

  final int queued;
  final int sending;
  final int unknown;
  final int rejected;
  final int conflict;
  final int accepted;

  /// The size of the data still to be sent.
  final int pendingBytes;
  final int? oldestPendingAgeMs;

  /// Commands that have not reached a final answer.
  int get pending => queued + sending + unknown;

  /// The share of the commands that were sent and have no answer yet, among those sent and answered or unanswered; the
  /// number the alert of MOB.md 9 watches. Zero when nothing was sent.
  double get unknownRate {
    final int sent = unknown + accepted + rejected + conflict;
    return sent == 0 ? 0 : unknown / sent;
  }
}
