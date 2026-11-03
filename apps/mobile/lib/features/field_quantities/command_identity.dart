import '../../core/offline/queue/command_queue.dart';
import '../../core/offline/queue/offline_codes.dart';
import '../../core/offline/queue/queue_results.dart';
import '../../core/offline/queue/queued_command.dart';

/// The identity (idempotency key) a draft goes to the queue under. A draft carries one for the whole of its life, which is right while
/// the command made from it is on its way: the same payload is the same tap. Once that command has ended without the measurement or the
/// result being recorded (the server refused it, or the person took it back), the key is spent: the queue answers a corrected payload
/// with `IdempotencyKeyReuse`, and the same payload with the command that already ended. What the person sends next is a new intention,
/// so it gets a new identity, and a command that was refused is retired so it cannot be retried beside its correction.
///
/// A command refused as `RESULT_UNVERIFIABLE` is not one of those: the server may have carried it out and no longer holds the receipt that
/// would say so, so a new key could record it a second time. It throws [ResultUnverifiable] and leaves the command as it is; the
/// person looks at the record and decides in the queue (where it can only be dropped).
///
/// Returns [operationId] when it is still the intention of a command that is on its way (or was never queued), and [newId]'s value when
/// that intention has ended.
String operationForNextSend(CommandQueue queue, String operationId, String Function() newId) {
  for (final QueuedCommand command in queue.commands()) {
    if (command.idempotencyKey != operationId && !command.supersededKeys.contains(operationId)) continue;
    switch (command.state) {
      case CommandState.rejected:
        if (command.errorCode == kResultUnverifiable) throw ResultUnverifiable(command.id);
        queue.discard(command.id);
        return newId();
      case CommandState.discarded:
      case CommandState.accepted:
        return newId();
      case CommandState.queued:
      case CommandState.sending:
      case CommandState.unknown:
      case CommandState.conflict:
        return operationId;
    }
  }
  return operationId;
}
