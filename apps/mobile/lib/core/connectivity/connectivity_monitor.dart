import 'dart:async';
import 'dart:io';

import 'package:machvon_api_client/machvon_api_client.dart';

import 'reachability.dart';

/// What the platform says about the network of the device: whether any interface other than the loopback holds an address.
/// A phone in airplane mode, or an emulator whose virtual network was taken down, has none.
abstract interface class NetworkPresence {
  /// False only when the device is sure to have no network at all. When the platform cannot say, answer true: the probe of the
  /// server decides then.
  Future<bool> hasNetwork();
}

/// [NetworkPresence] on `dart:io`: no plugin, so it works the same in every edition and in a test host.
final class InterfaceNetworkPresence implements NetworkPresence {
  const InterfaceNetworkPresence();

  @override
  Future<bool> hasNetwork() async {
    try {
      final List<NetworkInterface> interfaces = await NetworkInterface.list(includeLoopback: false, includeLinkLocal: false);
      return interfaces.any((NetworkInterface i) => i.addresses.isNotEmpty);
    } on Object {
      return true;
    }
  }
}

/// How often the connection is looked at while the application is in the foreground.
///
/// [interval] is the tick: the platform is asked on every tick (a local call, no traffic). The server is probed at most every
/// [probeInterval] while the last answer was online, and on every tick while the device is offline, so the return of the connection
/// is seen at once. A probe that gets no answer within [probeTimeout] counts as offline.
final class ConnectivityPolicy {
  const ConnectivityPolicy({
    this.interval = const Duration(seconds: 5),
    this.probeInterval = const Duration(seconds: 20),
    this.probeTimeout = const Duration(seconds: 5),
  });

  final Duration interval;
  final Duration probeInterval;
  final Duration probeTimeout;
}

/// Tells whether the API answers: any answer, whatever its status, is `true`; a refused connection or a time-out is `false`.
typedef ReachabilityProbe = Future<bool> Function();

/// The probe on the transport of the application: a small read of the public version policy (the call the application makes at
/// start), without a token.
ReachabilityProbe httpReachabilityProbe({required HttpTransport transport, required Uri baseUrl, required Duration timeout}) {
  final String path = '${baseUrl.path.replaceAll(RegExp(r'/+$'), '')}/mobile/version-policy';
  final HttpCall call = HttpCall(method: 'GET', url: baseUrl.replace(path: path), headers: const <String, String>{'accept': 'application/json'});
  return () async {
    try {
      await transport.send(call).timeout(timeout);
      return true;
    } on Exception {
      return false;
    }
  };
}

/// Keeps [Reachability] true to the device while nobody is asking the server anything.
///
/// The requests of the application already report what they see (an answer is online, a refused connection is offline), but a
/// phone that goes into airplane mode on an idle screen sends no request, so without this the banner "you are offline" waits for
/// the next one. The device is offline when the platform says it has no network, or when the server cannot be reached by the probe;
/// it is online when the platform has a network and the probe was answered. The queue and the uploads are not touched: they
/// listen to [Reachability] as before and send again when it turns online.
class ConnectivityMonitor {
  ConnectivityMonitor({
    required this.presence,
    required this.probe,
    required this.report,
    required this.current,
    this.policy = const ConnectivityPolicy(),
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now;

  final NetworkPresence presence;
  final ReachabilityProbe probe;
  final void Function(Reachability value) report;

  /// What [Reachability] holds now (the requests of the application report into it too).
  final Reachability Function() current;
  final ConnectivityPolicy policy;
  final DateTime Function() _now;

  Timer? _timer;
  bool _checking = false;
  DateTime? _lastProbeAt;

  bool get running => _timer != null;

  /// Checks now and then on every tick, until [stop].
  void start() {
    if (_timer != null) return;
    _timer = Timer.periodic(policy.interval, (Timer _) => unawaited(check()));
    unawaited(check());
  }

  void stop() {
    _timer?.cancel();
    _timer = null;
  }

  /// One look at the connection; the application calls it when it returns to the foreground. [force] probes the server whatever
  /// the last probe was.
  Future<void> check({bool force = false}) async {
    if (_checking) return;
    _checking = true;
    try {
      final bool network = await presence.hasNetwork();
      if (!network) {
        _lastProbeAt = null;
        report(Reachability.offline);
        return;
      }
      final DateTime now = _now();
      final DateTime? lastProbeAt = _lastProbeAt;
      final bool due = force || current() != Reachability.online || lastProbeAt == null || now.difference(lastProbeAt) >= policy.probeInterval;
      if (!due) return;
      _lastProbeAt = now;
      final bool reached;
      try {
        reached = await probe();
      } on Object {
        // A probe that could not be made says nothing: the last observation stays.
        return;
      }
      report(reached ? Reachability.online : Reachability.offline);
    } finally {
      _checking = false;
    }
  }

  void dispose() => stop();
}
