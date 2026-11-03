import 'package:machvon_api_client/machvon_api_client.dart';

import '../connectivity/reachability.dart';
import '../state/screen_state.dart';

/// The code shown for a failure that did not come from the server (a bug, a response that does not match the contract).
const String clientErrorCode = 'CLIENT_ERROR';

/// The code shown when the server answered with something the generated client cannot read: the contract and the
/// backend have drifted apart.
const String contractMismatchCode = 'CONTRACT_MISMATCH';

const String _licenseExpiredCode = 'LICENSE_EXPIRED';
const String _sessionExpiredCode = 'SESSION_EXPIRED';

/// A failure as the user sees it: which standard state to show, the stable error code and the correlation id to give
/// to support. It never carries text from the server: only codes and ids reach the screen (RFC 7807 `detail` is for
/// logs, not for people), so nothing a gateway or an exception put in a response can be displayed.
final class ProblemView {
  const ProblemView({
    required this.state,
    required this.code,
    this.correlationId,
    this.timedOut = false,
    this.retryAfterSeconds,
  });

  /// Maps what a call threw to what the screen shows.
  ///
  /// A request that never got an answer is `offline` when the device is known to be offline, otherwise a time-out of
  /// the service (the connection exists but the server did not answer in time), shown as an error with its own wording.
  factory ProblemView.from(Object error, {Reachability reachability = Reachability.unknown}) {
    if (error is ApiError) return ProblemView._fromApi(error, reachability);
    if (error is ContractMismatch) return const ProblemView(state: ScreenState.error, code: contractMismatchCode);
    return const ProblemView(state: ScreenState.error, code: clientErrorCode);
  }

  factory ProblemView._fromApi(ApiError error, Reachability reachability) {
    final String code = error.code;
    final String correlationId = error.correlationId;
    final int? retryAfter = error.retryAfterSeconds;
    if (code == networkErrorCode) {
      final bool offline = reachability == Reachability.offline;
      return ProblemView(
        state: offline ? ScreenState.offline : ScreenState.error,
        code: code,
        correlationId: correlationId,
        timedOut: !offline,
        retryAfterSeconds: retryAfter,
      );
    }
    final ScreenState state;
    if (error.status == 401 || code == _sessionExpiredCode) {
      state = ScreenState.signedOut;
    } else if (code == _licenseExpiredCode) {
      state = ScreenState.expired;
    } else if (error.status == 403) {
      state = ScreenState.denied;
    } else {
      state = ScreenState.error;
    }
    return ProblemView(state: state, code: code, correlationId: correlationId, retryAfterSeconds: retryAfter);
  }

  final ScreenState state;
  final String code;

  /// The id the client sent with the request and the server logged; null for a failure that never reached the server.
  final String? correlationId;

  /// The request got no answer although the device is not known to be offline.
  final bool timedOut;
  final int? retryAfterSeconds;
}
