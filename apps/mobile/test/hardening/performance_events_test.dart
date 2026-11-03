import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/offline/queue/command_queue.dart';
import 'package:machvon_mobile/features/read_support/data_view.dart';
import 'package:machvon_mobile/features/read_support/wire.dart';
import 'package:machvon_mobile/features/release/telemetry.dart';

import '../core/offline/offline_providers_test.dart' show containerFor;
import '../features/support/scripted_server.dart';
import '../support/fake_sync_server.dart';
import '../support/harness.dart';
import '../support/offline_support.dart';

const MobileFeature _probe = MobileFeature(id: 'probe', screens: <ScreenSpec>[ScreenSpec(screenId: 'MOB-08', builder: _build)]);

Widget _build(BuildContext context, ScreenContext screen) => Scaffold(
      body: DataView<String>(
        cacheKey: 'probe',
        read: (MachvonApiClient client) => client.getMyWork(),
        parse: (Object? raw) => text(asRecord(raw)?['title']),
        asOf: (String value) => '2026-10-31',
        builder: (BuildContext context, loaded) => Text('title ${loaded.value}'),
      ),
    );

List<TelemetryEvent> _named(BufferedTelemetrySink sink, String name) => sink.events.where((TelemetryEvent e) => e.name == name).toList();

void main() {
  group('AC-ST-MOB-040-2 UAT-NFR-PERFORMANCE-02 PERF-01 the application reports how long its start, a read and a command took', () {
    test('the three events exist, carry duration_ms as a whole number of milliseconds, and nothing else about the person', () {
      expect(kTelemetryEvents, containsAll(<String>['app.cold_start', 'list.loaded', 'command.round_trip']));
      final BufferedTelemetrySink sink = BufferedTelemetrySink();
      final TelemetryService service = TelemetryService(sink: sink, tenantId: () => 'tenant-a');
      service
        ..recordColdStart(const Duration(milliseconds: 1840))
        ..recordListLoaded(const Duration(milliseconds: 420, microseconds: 900))
        ..recordCommandRoundTrip(const Duration(seconds: 2));
      expect(sink.events.map((TelemetryEvent e) => e.toJson()), <Map<String, Object>>[
        <String, Object>{'name': 'app.cold_start', 'tenant_id': 'tenant-a', 'duration_ms': 1840},
        <String, Object>{'name': 'list.loaded', 'tenant_id': 'tenant-a', 'duration_ms': 420},
        <String, Object>{'name': 'command.round_trip', 'tenant_id': 'tenant-a', 'duration_ms': 2000},
      ]);
      expect(service.dropped, 0);
    });

    testWidgets('the cold start is reported once the first frame is drawn, measured from the stopwatch of main', (WidgetTester tester) async {
      final BufferedTelemetrySink sink = BufferedTelemetrySink();
      final TelemetryService service = TelemetryService(sink: sink, tenantId: () => null);
      final Stopwatch started = Stopwatch()..start();
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));

      reportColdStartAfterFirstFrame(tester.binding, service, started);
      expect(sink.events, isEmpty, reason: 'not before the frame');
      await tester.pumpWidget(const SizedBox.shrink());

      final TelemetryEvent event = sink.events.single;
      expect(event.name, 'app.cold_start');
      expect(event.tenantId, kNoTenant);
      expect(event.attributes['duration_ms'], greaterThanOrEqualTo(20));
    });

    testWidgets('a read answered by the server is reported with the time it took; a copy kept on the device is not', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final BufferedTelemetrySink sink = BufferedTelemetrySink();
      final ScriptedServer server = ScriptedServer()..on('GET', '/home/my-work', (_) => <String, Object?>{'title': 'Báo cáo tuần'});
      await pumpWithServer(
        tester,
        features: <MobileFeature>[_probe],
        server: server,
        location: '/home/mob-08',
        overrides: <Override>[telemetrySinkProvider.overrideWithValue(sink)],
      );
      expect(find.text('title Báo cáo tuần'), findsOneWidget);
      final List<TelemetryEvent> loaded = _named(sink, 'list.loaded');
      expect(loaded, hasLength(1));
      expect(loaded.single.attributes['duration_ms'], isA<int>().having((int ms) => ms, 'ms', greaterThanOrEqualTo(0)));
      expect(loaded.single.tenantId, 'tenant-a');

      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();
      expect(find.textContaining('dữ liệu đã lưu'), findsOneWidget, reason: 'the copy is shown');
      expect(_named(sink, 'list.loaded'), hasLength(1), reason: 'a copy says nothing about the network');
    });

    test('a batch of commands is reported with the time the server took to answer it; a batch that never got an answer is not', () async {
      final TestStorage storage = TestStorage.create();
      final FakeSyncServer server = FakeSyncServer();
      final BufferedTelemetrySink sink = BufferedTelemetrySink();
      final ProviderContainer container = containerFor(
        storage: storage,
        server: server,
        overrides: <Override>[telemetrySinkProvider.overrideWithValue(sink)],
      );
      (await container.read(localStoreProvider.future)).deviceId = '11111111-1111-4111-8111-111111111111';
      final CommandQueue queue = await container.read(commandQueueProvider.future);
      queue.enqueue(commandType: 'issue.create', payload: <String, Object?>{'n': 1});

      server.offline = true;
      await queue.flush();
      expect(_named(sink, 'command.round_trip'), isEmpty);

      server.offline = false;
      await queue.flush();
      final List<TelemetryEvent> trips = _named(sink, 'command.round_trip');
      expect(trips, hasLength(1));
      expect(trips.single.attributes['duration_ms'], isA<int>().having((int ms) => ms, 'ms', greaterThanOrEqualTo(0)));
    });
  });
}
