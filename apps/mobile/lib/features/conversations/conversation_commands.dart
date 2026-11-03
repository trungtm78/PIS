import 'package:machvon_api_client/machvon_api_client.dart';

import '../command_support/command_outcome.dart';
import '../read_support/attempts.dart';
import 'conversation_rules.dart';

/// One message the person wants to send, with the conversation and the version of it the screen showed.
final class SendRequest {
  const SendRequest({required this.conversationId, required this.version, required this.channelAccountId, required this.draft});

  final String conversationId;
  final int version;
  final String channelAccountId;
  final MessageDraft draft;

  /// What makes two requests the same intention (a retry after a lost answer, a second tap). The version is not part of it: it is
  /// pinned to the first request of the intention.
  String get intention => '$conversationId|${draft.note ? 'note' : 'external'}|${draft.purpose}|$channelAccountId|${draft.text.trim()}';
}

/// Resolve or reopen a conversation under a reason.
final class MoveRequest {
  const MoveRequest({required this.conversationId, required this.version, required this.reopen, required this.reason});

  final String conversationId;
  final int version;
  final bool reopen;
  final String reason;

  String get intention => '$conversationId|${reopen ? 'reopen' : 'resolve'}|${reason.trim()}';
}

/// Give a conversation to a colleague.
final class AssignRequest {
  const AssignRequest({required this.conversationId, required this.version, required this.assigneeId, this.reason = ''});

  final String conversationId;
  final int version;
  final String assigneeId;
  final String reason;

  String get intention => '$conversationId|$assigneeId|${reason.trim()}';
}

/// The version an intention was first sent at. A send whose answer was lost may have committed: the thread is read again, its
/// version has moved, and the same retry must still be the same request (the server judges it by the key, the body and the version),
/// or the message would go twice. A new intention takes the version it is given.
class _PinnedVersion {
  String? _intention;
  int? _version;

  int forIntention(String intention, int version) {
    if (_intention != intention) {
      _intention = intention;
      _version = version;
    }
    return _version!;
  }

  void clear() {
    _intention = null;
    _version = null;
  }
}

/// Sends the commands of a conversation: a message or a note, resolve and reopen, assign. All of them are online only (the server
/// judges consent, window, account and state), none reaches the offline queue, and each keeps the idempotency key and the version of
/// the first request of an intention across a retry.
class ConversationCommands {
  ConversationCommands({required this.client, required this.isOnline});

  final MachvonApiClient client;
  final bool Function() isOnline;
  final AttemptRegistry _sendAttempts = AttemptRegistry();
  final AttemptRegistry _moveAttempts = AttemptRegistry();
  final AttemptRegistry _assignAttempts = AttemptRegistry();
  final _PinnedVersion _sendVersion = _PinnedVersion();
  final _PinnedVersion _moveVersion = _PinnedVersion();
  final _PinnedVersion _assignVersion = _PinnedVersion();

  Future<CommandOutcome> send(SendRequest request, {bool retryAfterUnknown = false}) {
    return _pinned(
      _sendVersion,
      request.intention,
      request.version,
      (int version) => sendCommand(
        isOnline: isOnline,
        attempts: _sendAttempts,
        intention: request.intention,
        retryAfterUnknown: retryAfterUnknown,
        call: (CommandAttempt attempt) => client.sendConversationMessage(sendBodyOf(request.draft, request.channelAccountId), conversationId: request.conversationId, ifMatchVersion: version, attempt: attempt),
      ),
    );
  }

  Future<CommandOutcome> move(MoveRequest request, {bool retryAfterUnknown = false}) {
    return _pinned(
      _moveVersion,
      request.intention,
      request.version,
      (int version) => sendCommand(
        isOnline: isOnline,
        attempts: _moveAttempts,
        intention: request.intention,
        retryAfterUnknown: retryAfterUnknown,
        call: (CommandAttempt attempt) => request.reopen
            ? client.reopenConversation(ReasonOnly(reason: request.reason.trim()), conversationId: request.conversationId, ifMatchVersion: version, attempt: attempt)
            : client.resolveConversation(ReasonOnly(reason: request.reason.trim()), conversationId: request.conversationId, ifMatchVersion: version, attempt: attempt),
      ),
    );
  }

  Future<CommandOutcome> assign(AssignRequest request, {bool retryAfterUnknown = false}) {
    return _pinned(
      _assignVersion,
      request.intention,
      request.version,
      (int version) => sendCommand(
        isOnline: isOnline,
        attempts: _assignAttempts,
        intention: request.intention,
        retryAfterUnknown: retryAfterUnknown,
        call: (CommandAttempt attempt) => client.assignConversation(
          ConversationAssign(assigneeMembershipId: request.assigneeId, reason: request.reason.trim().isEmpty ? null : request.reason.trim()),
          conversationId: request.conversationId,
          ifMatchVersion: version,
          attempt: attempt,
        ),
      ),
    );
  }

  /// Runs [run] under the version the intention was first sent at; a recorded command or a final refusal ends the intention, and so
  /// does a send that never left the device (nothing was sent, so there is no first request to repeat).
  Future<CommandOutcome> _pinned(_PinnedVersion pin, String intention, int version, Future<CommandOutcome> Function(int version) run) async {
    final CommandOutcome outcome = await run(pin.forIntention(intention, version));
    if (outcome is CommandDone || outcome is CommandOffline || (outcome is CommandRefused && outcome.isFinal)) pin.clear();
    return outcome;
  }
}
