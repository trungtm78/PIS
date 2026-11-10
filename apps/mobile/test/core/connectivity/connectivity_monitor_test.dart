import 'dart:async';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/app/app_config.dart';
import 'package:machvon_mobile/core/connectivity/connectivity_monitor.dart';
import 'package:machvon_mobile/core/connectivity/connectivity_providers.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/di/providers.dart';

class _Presence implements NetworkPresence {
  _Presence(this.value);

  bool value;
  int calls = 0;

  @override
  Future<bool> hasNetwork() async {
    calls++;
    return value;
  }
}

class _Probe {
  _Probe(this.answer);

  /// A bool to answer, or an object to throw.
  Object answer;
  int calls = 0;

  Future<bool> call() async {
    calls++;
    final Object a = answer;
    if (a is bool) return a;
    throw a;
  }
}

class _Rig {
  _Rig({bool network = true, Object probeAnswer = true})
      : presence = _Presence(network),
        probe = _Probe(probeAnswer) {
    monitor = ConnectivityMonitor(
      presence: presence,
      probe: probe.call,
      report: (Reachability v) => state = v,
      current: () => state,
      policy: policy,
      now: () => clock,
    );
  }

  final ConnectivityPolicy policy = const ConnectivityPolicy();
  final _Presence presence;
  final _Probe probe;
  late final ConnectivityMonitor monitor;
  Reachability state = Reachability.unknown;
  DateTime clock = DateTime.utc(2026, 11, 10, 12);

  void advance(Duration d) => clock = clock.add(d);
}

class _FakeTransport implements HttpTransport {
  _FakeTransport(this.handler);

  final Future<HttpResult> Function(HttpCall call) handler;
  final List<HttpCall> calls = <HttpCall>[];

  @override
  Future<HttpResult> send(HttpCall call) {
    calls.add(call);
    return handler(call);
  }
}

void main() {
  group('ConnectivityMonitor.check', () {
    test('the platform says there is no network: offline at once, and the server is not asked', () async {
      final _Rig rig = _Rig(network: false);
      await rig.monitor.check();
      expect(rig.state, Reachability.offline);
      expect(rig.probe.calls, 0);
    });

    test('a network and an answer from the server: online', () async {
      final _Rig rig = _Rig();
      await rig.monitor.check();
      expect(rig.state, Reachability.online);
      expect(rig.probe.calls, 1);
    });

    test('a network that the platform keeps (the virtual network of an emulator) but a server that does not answer: offline', () async {
      final _Rig rig = _Rig(probeAnswer: false);
      await rig.monitor.check();
      expect(rig.state, Reachability.offline);
    });

    test('an online device is probed at most once per probe interval, an offline one on every tick', () async {
      final _Rig rig = _Rig();
      await rig.monitor.check();
      rig.advance(const Duration(seconds: 5));
      await rig.monitor.check();
      rig.advance(const Duration(seconds: 5));
      await rig.monitor.check();
      expect(rig.probe.calls, 1);
      rig.advance(const Duration(seconds: 10));
      await rig.monitor.check();
      expect(rig.probe.calls, 2);

      rig.probe.answer = false;
      rig.advance(const Duration(seconds: 20));
      await rig.monitor.check();
      expect(rig.state, Reachability.offline);
      final int afterFailure = rig.probe.calls;
      rig.advance(const Duration(seconds: 5));
      await rig.monitor.check();
      expect(rig.probe.calls, afterFailure + 1, reason: 'offline: probe again at the next tick, so the return is seen at once');
    });

    test('the airplane mode on an idle screen: online, then the radio goes away, then it comes back', () async {
      final _Rig rig = _Rig();
      await rig.monitor.check();
      expect(rig.state, Reachability.online);

      rig.presence.value = false;
      rig.advance(const Duration(seconds: 5));
      await rig.monitor.check();
      expect(rig.state, Reachability.offline);

      rig.presence.value = true;
      rig.advance(const Duration(seconds: 5));
      await rig.monitor.check();
      expect(rig.state, Reachability.online);
    });

    test('a request that failed (reported offline by the transport) is corrected by the next probe that is answered', () async {
      final _Rig rig = _Rig();
      await rig.monitor.check();
      rig.state = Reachability.offline; // the transport saw a refused connection
      rig.advance(const Duration(seconds: 1));
      await rig.monitor.check();
      expect(rig.state, Reachability.online);
    });

    test('a probe that could not be made keeps the last observation', () async {
      final _Rig rig = _Rig(probeAnswer: StateError('refusing to send'));
      rig.state = Reachability.online;
      rig.advance(const Duration(minutes: 1));
      await rig.monitor.check(force: true);
      expect(rig.state, Reachability.online);
    });

    test('force probes the server whatever the last probe was', () async {
      final _Rig rig = _Rig();
      await rig.monitor.check();
      await rig.monitor.check(force: true);
      expect(rig.probe.calls, 2);
    });

    test('two checks at once make one look', () async {
      final _Rig rig = _Rig();
      await Future.wait(<Future<void>>[rig.monitor.check(), rig.monitor.check()]);
      expect(rig.presence.calls, 1);
    });
  });

  group('ConnectivityMonitor.start', () {
    testWidgets('looks at every tick until stopped, and never twice at once', (WidgetTester tester) async {
      final _Rig rig = _Rig(network: false);
      rig.monitor.start();
      rig.monitor.start();
      await tester.pump();
      expect(rig.monitor.running, isTrue);
      expect(rig.presence.calls, 1);
      await tester.pump(const Duration(seconds: 5));
      await tester.pump(const Duration(seconds: 5));
      expect(rig.presence.calls, 3);
      expect(rig.state, Reachability.offline);
      rig.monitor.stop();
      await tester.pump(const Duration(seconds: 30));
      expect(rig.presence.calls, 3);
      expect(rig.monitor.running, isFalse);
    });
  });

  group('httpReachabilityProbe', () {
    final Uri base = Uri.parse('http://10.0.2.2:3999/api/');

    ReachabilityProbe probeOf(_FakeTransport t) => httpReachabilityProbe(transport: t, baseUrl: base, timeout: const Duration(seconds: 5));

    test('any answer is reachable, whatever its status, and the call carries no token', () async {
      for (final int status in <int>[200, 400, 401, 503]) {
        final _FakeTransport t = _FakeTransport((HttpCall c) async => HttpResult(status: status, headers: const <String, String>{}, body: ''));
        expect(await probeOf(t)(), isTrue, reason: '$status');
        expect(t.calls.single.url.path, '/api/mobile/version-policy');
        expect(t.calls.single.headers.containsKey('authorization'), isFalse);
      }
    });

    test('a refused connection is not reachable', () async {
      final _FakeTransport t = _FakeTransport((HttpCall c) async => throw const SocketException('Network is unreachable'));
      expect(await probeOf(t)(), isFalse);
    });

    test('no answer within the time-out is not reachable', () async {
      final Completer<HttpResult> never = Completer<HttpResult>();
      final _FakeTransport t = _FakeTransport((HttpCall c) => never.future);
      final ReachabilityProbe probe = httpReachabilityProbe(transport: t, baseUrl: base, timeout: const Duration(milliseconds: 20));
      expect(await probe(), isFalse);
    });
  });

  group('connectivityMonitorProvider', () {
    ProviderContainer containerOf(List<Override> extra) {
      final ProviderContainer c = ProviderContainer(overrides: <Override>[
        appConfigProvider.overrideWithValue(AppConfig(apiBaseUrl: Uri.parse('http://10.0.2.2:3999'), allowInsecureLoopback: true)),
        httpTransportProvider.overrideWithValue(_FakeTransport((HttpCall c) async => const HttpResult(status: 200, headers: <String, String>{}, body: ''))),
        ...extra,
      ]);
      addTearDown(c.dispose);
      return c;
    }

    test('no policy installed: no monitor, so a screen test leaves no timer behind', () {
      final ProviderContainer c = containerOf(const <Override>[]);
      expect(c.read(connectivityMonitorProvider), isNull);
    });

    testWidgets('with a policy it feeds the reachability that the offline banner shows', (WidgetTester tester) async {
      final _Presence presence = _Presence(false);
      final ProviderContainer c = containerOf(<Override>[
        connectivityPolicyProvider.overrideWithValue(const ConnectivityPolicy()),
        networkPresenceProvider.overrideWithValue(presence),
      ]);
      c.listen<ConnectivityMonitor?>(connectivityMonitorProvider, (ConnectivityMonitor? a, ConnectivityMonitor? b) {});
      await tester.pump();
      expect(c.read(reachabilityProvider), Reachability.offline);

      presence.value = true;
      await tester.pump(const Duration(seconds: 5));
      expect(c.read(reachabilityProvider), Reachability.online);

      c.dispose();
      await tester.pump(const Duration(seconds: 30));
      expect(presence.calls, lessThan(5), reason: 'disposing the container stops the timer');
    });
  });
}
