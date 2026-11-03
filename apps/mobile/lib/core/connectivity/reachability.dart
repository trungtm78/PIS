import 'package:flutter_riverpod/flutter_riverpod.dart';

/// What the application knows about its connection to the server. It is derived from the outcome of real requests (an
/// answer means online, a refused connection means offline), so it needs no platform plugin; `unknown` before the first
/// request, and treated like online by the screens.
enum Reachability { unknown, online, offline }

/// Holds the [Reachability]; the transport reports into it. A later story may report from a platform connectivity
/// source as well by calling [report].
class ReachabilityNotifier extends Notifier<Reachability> {
  @override
  Reachability build() => Reachability.unknown;

  void report(Reachability value) => state = value;
}

final NotifierProvider<ReachabilityNotifier, Reachability> reachabilityProvider =
    NotifierProvider<ReachabilityNotifier, Reachability>(ReachabilityNotifier.new);
