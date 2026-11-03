import 'package:machvon_api_client/machvon_api_client.dart';

const int _requestTimeout = 408;
const int _tooManyRequests = 429;
const String _inProgress = 'IDEMPOTENCY_IN_PROGRESS';

/// The server refused the request itself (a 4xx other than a time-out, a rate limit or a command still running): that answer
/// is final and the server replays it for the same idempotency key. A lost answer, a 5xx or a time-out is not final.
bool isDefinitiveRefusal(Object failure) {
  if (failure is! ApiError) return false;
  return failure.status >= 400 && failure.status < 500 && failure.status != _requestTimeout && failure.status != _tooManyRequests && failure.code != _inProgress;
}

/// Hands out the [CommandAttempt] of the user's current intention, the way the web does: the same payload (a retry after a
/// lost answer, a second tap) reuses the attempt, so the server runs the command once; a different payload is a new
/// intention with a new key; a success ends the intention; and a final refusal ends it too, so that the same request sent
/// again after the cause is removed (a second factor, a version that moved) is a new command with a new key.
class AttemptRegistry {
  AttemptRegistry([CommandAttempt Function()? start]) : _start = start ?? CommandAttempt.fresh;

  final CommandAttempt Function() _start;
  ({String payload, CommandAttempt attempt})? _last;

  CommandAttempt forPayload(String payload) {
    if (_last?.payload != payload) _last = (payload: payload, attempt: _start());
    return _last!.attempt;
  }

  void done() => _last = null;

  /// The command failed: a final refusal ends the intention, a lost answer keeps the attempt for the retry.
  void ended(Object failure) {
    if (isDefinitiveRefusal(failure)) _last = null;
  }
}
