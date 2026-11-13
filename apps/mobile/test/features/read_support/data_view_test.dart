import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/features/read_support/data_view.dart';
import 'package:machvon_mobile/features/read_support/read_cache.dart';
import 'package:machvon_mobile/features/read_support/wire.dart';

import '../../support/harness.dart';
import '../support/scripted_server.dart';

/// A screen that is only a [DataView] on the my-work read, so the rules of the cache are tried without a business screen.
const MobileFeature _probe = MobileFeature(id: 'probe', screens: <ScreenSpec>[ScreenSpec(screenId: 'MOB-08', builder: _build)]);

Widget _build(BuildContext context, ScreenContext screen) => Scaffold(
      body: DataView<String>(
        cacheKey: 'probe',
        read: (MachvonApiClient client) => client.getMyWork(),
        parse: (Object? raw) => text(asRecord(raw)?['title']),
        asOf: (String value) => '2026-10-31',
        isEmpty: (String value) => value == 'empty',
        builder: (BuildContext context, loaded) => Text('title ${loaded.value}'),
      ),
    );

/// The key of the read of [_keyed]: the filters of a screen. Changing it while a read is pending is the case under test.
final ValueNotifier<String> _filter = ValueNotifier<String>('A');

const MobileFeature _keyed = MobileFeature(id: 'keyed', screens: <ScreenSpec>[ScreenSpec(screenId: 'MOB-08', builder: _buildKeyed)]);

Widget _buildKeyed(BuildContext context, ScreenContext screen) => Scaffold(
      body: ValueListenableBuilder<String>(
        valueListenable: _filter,
        builder: (BuildContext context, String filter, Widget? child) => DataView<String>(
          cacheKey: 'probe/$filter',
          read: (MachvonApiClient client) => client.getMyWork(),
          parse: (Object? raw) => text(asRecord(raw)?['title']),
          asOf: (String value) => '2026-10-31',
          builder: (BuildContext context, loaded) => Text('title ${loaded.value}'),
        ),
      ),
    );

ScriptedServer _server([String title = 'Báo cáo tuần']) {
  final ScriptedServer server = ScriptedServer();
  server.on('GET', '/home/my-work', (_) => <String, Object?>{'title': title});
  return server;
}

void main() {
  group('TK-MOB-010-4 AC-ST-MOB-010-1 BR-MOB-01 the cache rules: as_of, time to live, stale marking', () {
    testWidgets('an answer from the server shows the moment it describes and no copy note', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final ScriptedServer server = _server();
      await pumpWithServer(tester, features: <MobileFeature>[_probe], server: server, location: '/home/mob-08');

      expect(find.text('title Báo cáo tuần'), findsOneWidget);
      expect(find.text('Số liệu tại 31/10/2026'), findsOneWidget);
      expect(find.textContaining('dữ liệu đã lưu'), findsNothing);
    });

    testWidgets('when the server cannot be reached the copy is shown with its as_of, as read-only reference data, never as the newest', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final ScriptedServer server = _server();
      final ProviderContainer container = await pumpWithServer(tester, features: <MobileFeature>[_probe], server: server, location: '/home/mob-08');

      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();

      expect(container.read(reachabilityProvider), Reachability.offline);
      expect(find.text('title Báo cáo tuần'), findsOneWidget);
      expect(find.textContaining('Đang hiển thị dữ liệu đã lưu trên máy, số liệu tại 31/10/2026'), findsOneWidget);
      expect(find.textContaining('Số tiền chỉ để tham khảo, không sửa được.'), findsOneWidget);
      expect(find.textContaining('mới nhất'), findsNothing);
      expect(find.textContaining('latest'), findsNothing);
      expect(find.textContaining('quá'), findsNothing, reason: 'a copy of today is not out of date');
    });

    testWidgets('a copy older than its time to live is marked out of date, and the english words never say latest either', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final ScriptedServer server = _server();
      DateTime now = kNow;
      await pumpWithServer(tester, features: <MobileFeature>[_probe], server: server, location: '/home/mob-08', now: () => now, locale: const Locale('en'));

      server.offline = true;
      now = kNow.add(const Duration(days: 3));
      await tester.tap(find.byTooltip('Refresh'));
      await tester.pumpAndSettle();

      expect(find.textContaining('Showing the copy kept on this device, as of 31/10/2026'), findsOneWidget);
      expect(find.textContaining('This copy is older than 12 hours. Connect to check it again.'), findsOneWidget);
      expect(find.textContaining('latest'), findsNothing);
      expect(find.textContaining('newest'), findsNothing);
    });

    testWidgets('without a copy an unreachable server is the offline state, not an empty page', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final ScriptedServer server = _server()..offline = true;
      await pumpWithServer(tester, features: <MobileFeature>[_probe], server: server, location: '/home/mob-08');

      expect(find.text('NETWORK_ERROR'), findsOneWidget);
      expect(find.text('title Báo cáo tuần'), findsNothing);
    });

    testWidgets('a refusal never falls back to the copy, and the copy of what was refused is dropped', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final ScriptedServer server = _server();
      final ProviderContainer container = await pumpWithServer(tester, features: <MobileFeature>[_probe], server: server, location: '/home/mob-08');
      expect(find.text('title Báo cáo tuần'), findsOneWidget);

      server.refuse('GET', '/home/my-work', 403, 'SCOPE_DENIED');
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();
      expect(find.text('SCOPE_DENIED'), findsOneWidget);
      expect(find.text('title Báo cáo tuần'), findsNothing);

      server.clear();
      server.offline = true;
      await tester.tap(find.text('Thử lại'));
      await tester.pumpAndSettle();
      expect(find.text('NETWORK_ERROR'), findsOneWidget, reason: 'the copy was dropped when the right was taken away');
      expect(find.text('title Báo cáo tuần'), findsNothing);
      expect((container.read(readCacheProvider) as InMemoryReadCache).length, 0);
    });

    testWidgets('a copy belongs to one tenant and one person: another tenant never sees it, and signing out empties the store', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final ScriptedServer server = _server();
      final FakeSession session = FakeSession();
      final ProviderContainer container = await pumpWithServer(tester, features: <MobileFeature>[_probe], server: server, location: '/home/mob-08', session: session);
      final InMemoryReadCache cache = container.read(readCacheProvider) as InMemoryReadCache;
      expect(cache.length, 1);

      server.offline = true;
      session.change(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-b', userId: 'user-1'));
      await tester.pumpAndSettle();
      expect(cache.length, 0, reason: 'a tenant switch purges the device');
      expect(find.text('NETWORK_ERROR'), findsOneWidget);
      expect(find.text('title Báo cáo tuần'), findsNothing);

      server.offline = false;
      await tester.tap(find.text('Thử lại'));
      await tester.pumpAndSettle();
      expect(cache.length, 1);

      session.change(const SessionSnapshot.signedOut());
      await tester.pumpAndSettle();
      expect(cache.length, 0, reason: 'sign-out purges the device');
    });

    testWidgets('an answer that lacks what the screen needs is a contract mismatch, and an empty answer is the empty state', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final ScriptedServer server = ScriptedServer()..on('GET', '/home/my-work', (_) => <String, Object?>{'name': 'x'});
      await pumpWithServer(tester, features: <MobileFeature>[_probe], server: server, location: '/home/mob-08');
      expect(find.text('CONTRACT_MISMATCH'), findsOneWidget);

      server.on('GET', '/home/my-work', (_) => <String, Object?>{'title': 'empty'});
      await tester.tap(find.text('Thử lại'));
      await tester.pumpAndSettle();
      expect(find.text('Chưa có dữ liệu'), findsOneWidget);
    });
  });

  group('TK-MOB-010-4 AC-ST-MOB-010-1 BR-MOB-01 a read that answers after the filters changed never touches the copy of the new filters', () {
    /// The first read waits until [release] is completed and then answers [firstStatus]; every later read answers at once.
    ScriptedServer slowFirst(Completer<void> release, {int firstStatus = 200}) {
      final ScriptedServer server = ScriptedServer();
      int calls = 0;
      server.answer('GET', '/home/my-work', (HttpCall call) async {
        if (calls++ == 0) {
          await release.future;
          if (firstStatus != 200) {
            return FakeTransport.json(firstStatus, <String, Object?>{'type': 'about:blank', 'title': 'SCOPE_DENIED', 'status': firstStatus, 'code': 'SCOPE_DENIED'});
          }
          return FakeTransport.json(200, <String, Object?>{'title': 'late answer for A'});
        }
        return FakeTransport.json(200, <String, Object?>{'title': 'answer for B'});
      });
      return server;
    }

    setUp(() => _filter.value = 'A');

    testWidgets('the late answer for A does not overwrite the copy of B, and no copy of A is written', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final Completer<void> release = Completer<void>();
      final ScriptedServer server = slowFirst(release);
      final ProviderContainer container = await pumpWithServer(tester, features: <MobileFeature>[_keyed], server: server, location: '/home/mob-08');
      _filter.value = 'B';
      await tester.pumpAndSettle();
      expect(find.text('title answer for B'), findsOneWidget);

      release.complete();
      await tester.pumpAndSettle();
      expect(find.text('title answer for B'), findsOneWidget, reason: 'the late answer is not shown either');

      expect((container.read(readCacheProvider) as InMemoryReadCache).length, 1, reason: 'only the copy of B exists');
      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();
      expect(find.text('title answer for B'), findsOneWidget, reason: 'the copy kept for B is the answer for B');
    });

    testWidgets('the late refusal of A does not drop the copy of B', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final Completer<void> release = Completer<void>();
      final ScriptedServer server = slowFirst(release, firstStatus: 403);
      final ProviderContainer container = await pumpWithServer(tester, features: <MobileFeature>[_keyed], server: server, location: '/home/mob-08');
      _filter.value = 'B';
      await tester.pumpAndSettle();
      expect((container.read(readCacheProvider) as InMemoryReadCache).length, 1);

      release.complete();
      await tester.pumpAndSettle();

      expect((container.read(readCacheProvider) as InMemoryReadCache).length, 1, reason: 'what was refused for A says nothing about B');
      expect(find.text('title answer for B'), findsOneWidget);
    });
  });
}
