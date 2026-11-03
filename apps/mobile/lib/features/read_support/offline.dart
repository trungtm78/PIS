import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/connectivity/reachability.dart';

/// Whether the device is known to be offline (a real request failed to reach the server). Screens that change something use it
/// to disable the action and say why; nothing is queued.
bool isOffline(WidgetRef ref) => ref.watch(reachabilityProvider) == Reachability.offline;
