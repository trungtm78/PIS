import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../di/providers.dart';
import 'connectivity_monitor.dart';
import 'reachability.dart';

/// How the connection is looked at while the application is open (see [ConnectivityMonitor]). Null until the application root
/// installs one (`productionOverrides` installs [ConnectivityPolicy]), so a screen test leaves no timer behind.
final Provider<ConnectivityPolicy?> connectivityPolicyProvider = Provider<ConnectivityPolicy?>((Ref ref) => null);

/// What the platform says about the network. Tests override it.
final Provider<NetworkPresence> networkPresenceProvider = Provider<NetworkPresence>((Ref ref) => const InterfaceNetworkPresence());

/// The monitor that keeps [reachabilityProvider] true on an idle screen. It runs while the application is in the foreground (it
/// is stopped in the background and looks again at once when the person comes back). Watch it once at the root of the signed-in
/// application; it is null when no policy is installed.
final Provider<ConnectivityMonitor?> connectivityMonitorProvider = Provider<ConnectivityMonitor?>((Ref ref) {
  final ConnectivityPolicy? policy = ref.watch(connectivityPolicyProvider);
  if (policy == null) return null;
  final ConnectivityMonitor monitor = ConnectivityMonitor(
    presence: ref.watch(networkPresenceProvider),
    probe: httpReachabilityProbe(
      transport: ref.watch(httpTransportProvider),
      baseUrl: ref.watch(appConfigProvider).apiBaseUrl,
      timeout: policy.probeTimeout,
    ),
    report: ref.read(reachabilityProvider.notifier).report,
    current: () => ref.read(reachabilityProvider),
    policy: policy,
  );
  final _ForegroundObserver observer = _ForegroundObserver(monitor);
  WidgetsBinding.instance.addObserver(observer);
  ref.onDispose(() {
    WidgetsBinding.instance.removeObserver(observer);
    monitor.dispose();
  });
  final AppLifecycleState? state = WidgetsBinding.instance.lifecycleState;
  if (state == null || state == AppLifecycleState.resumed) monitor.start();
  return monitor;
});

class _ForegroundObserver with WidgetsBindingObserver {
  _ForegroundObserver(this.monitor);

  final ConnectivityMonitor monitor;

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      monitor.start();
      // Back from the background (or from a settings screen where the airplane mode was switched): look again at once.
      monitor.check(force: true);
    } else if (state == AppLifecycleState.paused || state == AppLifecycleState.hidden) {
      monitor.stop();
    }
  }
}
