import 'package:flutter_riverpod/misc.dart' show ProviderException;

import '../../core/api/problem.dart';
import '../../core/connectivity/reachability.dart';
import '../../core/offline/offline_providers.dart';
import '../../core/state/screen_state.dart';

/// The failure of a provider as the screen shows it. Nobody signed in is an ended session; anything else is mapped like every
/// other failure (`ProblemView.from`). Riverpod wraps an error each time it crosses from one provider to another, so the cause
/// is taken out first.
ProblemView offlineProblemOf(Object error, Reachability reachability) {
  Object cause = error;
  while (cause is ProviderException) {
    cause = cause.exception;
  }
  if (cause is OfflineUnavailable) return const ProblemView(state: ScreenState.signedOut, code: 'SESSION_EXPIRED');
  return ProblemView.from(cause, reachability: reachability);
}
