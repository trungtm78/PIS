import 'package:machvon_api_client/machvon_api_client.dart';

import '../read_support/attempts.dart';
import '../read_support/wire.dart';

/// How one command of a screen that changes something online ended. These screens never queue: a command is one request,
/// sent while the device is online, under the version of the record that was on the screen (BR-MOB-02, MOB.md 4).
sealed class CommandOutcome {
  const CommandOutcome();
}

/// The server recorded the command. [status] is its word for the result, [version] the version of the record after it.
final class CommandDone extends CommandOutcome {
  const CommandDone({this.status = '', this.version, this.resourceId});

  final String status;
  final int? version;
  final String? resourceId;
}

/// The server refused: nothing was recorded. [code] is its stable error code; [extensions] are the members of the problem
/// body beyond the standard ones (`missing_roles`, `current_version`).
final class CommandRefused extends CommandOutcome {
  const CommandRefused(this.code, {this.status = 0, this.detail, this.extensions = const <String, Object?>{}});

  final String code;
  final int status;

  /// The name of the field or rule the refusal is about (`signer_role`), when the server gave one.
  final String? detail;

  /// The server refused the command itself (a 4xx other than a time-out, a rate limit or a command still running): the answer is final,
  /// and the server replays it for the same idempotency key, so the same request sent again after the cause is removed needs a new key.
  bool get isFinal => status >= 400 && status < 500 && status != 408 && status != 429 && code != 'IDEMPOTENCY_IN_PROGRESS';
  final Map<String, Object?> extensions;
}

/// The answer was lost: the server may or may not have recorded the command. Sending the same command again reuses the
/// idempotency key, so the server answers with the first result and never records it twice.
final class CommandUnknown extends CommandOutcome {
  const CommandUnknown();
}

/// The device is offline: nothing was sent and nothing was queued.
final class CommandOffline extends CommandOutcome {
  const CommandOffline();
}

/// Sends one command and sorts what comes back. [attempts] keeps the key of the person's intention: the same [intention]
/// (a retry after a lost answer, a second tap) reuses it, a final refusal ends it. [retryAfterUnknown] is the person asking,
/// after a lost answer, to send the same command again: the failure may have left the device marked offline, so this request
/// is the probe and is sent; it never creates a second command because it reuses the key of the first.
Future<CommandOutcome> sendCommand({
  required bool Function() isOnline,
  required AttemptRegistry attempts,
  required String intention,
  required Future<Object?> Function(CommandAttempt attempt) call,
  bool retryAfterUnknown = false,
}) async {
  if (!retryAfterUnknown && !isOnline()) return const CommandOffline();
  final CommandAttempt attempt = attempts.forPayload(intention);
  try {
    final Object? answer = await call(attempt);
    attempts.done();
    final Json? body = asRecord(answer);
    return CommandDone(status: text(body?['status']) ?? '', version: whole(body?['resource_version']), resourceId: filled(body?['resource_id']));
  } on ApiError catch (error) {
    attempts.ended(error);
    if (error.code == networkErrorCode) return const CommandUnknown();
    return CommandRefused(error.code, status: error.status, detail: error.detail, extensions: error.extensions);
  }
}
