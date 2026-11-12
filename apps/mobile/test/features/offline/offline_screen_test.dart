import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/offline/drafts/draft_store.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/state/state_card.dart';

import '../../support/harness.dart';
import '../../support/queue_rig.dart';
import 'offline_harness.dart';

/// Every text on the screen, including what is scrolled out of view.
String allText(WidgetTester tester) => tester.widgetList<Text>(find.byType(Text, skipOffstage: false)).map((Text t) => t.data ?? '').join('\n');

void main() {
  group('AC-ST-MOB-005-4 UI-MOB-43 MOB-43 when the device is offline', () {
    testWidgets('it lists what can be done offline (drafts only), the drafts on the device, and the time of the data; it never calls it the latest', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final QueueRig rig = await realClockRig();
      // 14:05 on 3 November 2026 in Vietnam time (07:05 UTC)
      rig.store.dataAsOf = DateTime.utc(2026, 11, 3, 7, 5);
      DraftStore(rig.store).save(kind: 'report', fields: <String, Object?>{'a': 1});
      DraftStore(rig.store).save(kind: 'issue', fields: <String, Object?>{'a': 1});
      rig.queue.enqueue(commandType: 'report.submit', payload: <String, Object?>{'report_id': '5b3c0e7a-0a56-4c0e-8c33-0f2f6b7f1a01'});
      final ProviderContainer container = await openOfflineApp(tester, rig, location: '/projects/mob-43');
      container.read(reachabilityProvider.notifier).report(Reachability.offline);
      await tester.pumpAndSettle();

      expect(find.text('Bạn đang ngoại tuyến'), findsOneWidget);
      expect(find.text('Dữ liệu trên máy tính đến 03/11/2026 14:05'), findsOneWidget);
      expect(find.textContaining('có thể đã khác trên server'), findsOneWidget);
      expect(find.text('Làm được khi ngoại tuyến'), findsOneWidget);
      expect(find.text('Báo cáo: lưu nháp và nộp'), findsOneWidget);
      expect(find.text('Báo vướng mắc'), findsOneWidget);
      expect(find.text('Cần kết nối'), findsOneWidget);
      expect(find.textContaining('Phê duyệt, trả lại và ký số'), findsOneWidget);
      expect(find.text('Bản nháp trên máy (2)'), findsOneWidget);
      expect(find.text('Báo cáo'), findsOneWidget);
      expect(find.text('Vướng mắc'), findsOneWidget);
      expect(find.text('Xem hàng đợi gửi (1)'), findsOneWidget);
      expect(allText(tester).toLowerCase(), isNot(contains('mới nhất')), reason: 'cached data is never the latest');
      expect(allText(tester).toLowerCase(), isNot(contains('latest')));
    });

    testWidgets('without any synced data it says so instead of showing a time, and the same in English', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final QueueRig rig = await realClockRig();
      final ProviderContainer container = await openOfflineApp(tester, rig, location: '/projects/mob-43', locale: const Locale('en'));
      container.read(reachabilityProvider.notifier).report(Reachability.offline);
      await tester.pumpAndSettle();
      expect(find.text('You are offline'), findsOneWidget);
      expect(find.text('No synced data on this device yet.'), findsOneWidget);
      expect(find.textContaining('Data on this device as of'), findsNothing);
      expect(find.text('There are no drafts on this device.'), findsOneWidget);
      expect(allText(tester).toLowerCase(), isNot(contains('latest')));
      expect(allText(tester).toLowerCase(), isNot(contains('mới nhất')));
      rig.store.dataAsOf = DateTime.utc(2026, 11, 3, 2, 7);
      await openOfflineApp(tester, rig, location: '/projects/mob-43', locale: const Locale('en'));
      expect(find.text('Data on this device as of 2026-11-03 09:07'), findsOneWidget);
    });

    testWidgets('online, it says so and keeps the same honesty about the data; the link leads to the queue', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final QueueRig rig = await realClockRig();
      rig.store.dataAsOf = DateTime.utc(2026, 11, 3, 7, 5);
      final ProviderContainer container = await openOfflineApp(tester, rig, location: '/projects/mob-43');
      expect(find.text('Bạn đang trực tuyến'), findsOneWidget);
      expect(find.textContaining('có thể đã khác trên server'), findsOneWidget);
      await tester.tap(find.text('Xem hàng đợi gửi (0)'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/projects/mob-41');
    });
  });

  group('AC-ST-MOB-005-4 UI-MOB-43 the states and the screen contract', () {
    testWidgets('loading, error and ended session', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final Gate gate = Gate();
      QueueRig rig = await realClockRig();
      await openOfflineApp(
        tester,
        rig,
        location: '/projects/mob-43',
        overrides: [localStoreProvider.overrideWith((Ref ref) async {
          await gate.passed;
          return rig.store;
        })],
      );
      expect(find.byType(LoadingView), findsOneWidget, reason: 'loading');
      gate.open();
      await tester.pumpAndSettle();
      expect(find.text('Làm được khi ngoại tuyến'), findsOneWidget, reason: 'default');

      rig = await realClockRig();
      await openOfflineApp(tester, rig, location: '/projects/mob-43', overrides: [localStoreProvider.overrideWith((Ref ref) async => throw StateError('disk'))]);
      expect(find.text('Chưa thể tải dữ liệu'), findsOneWidget, reason: 'error');
      expect(find.text('CLIENT_ERROR'), findsOneWidget);

      rig = await realClockRig();
      await openOfflineApp(tester, rig, location: '/projects/mob-43', overrides: [localStoreProvider.overrideWith((Ref ref) async => throw const OfflineUnavailable())]);
      expect(find.text('Phiên làm việc đã hết hạn'), findsOneWidget, reason: 'signed out');
      expect(tester.takeException(), isNull);
    });

    testWidgets('UI-MOB-43 contract: three devices, text at 200 percent, tap targets, labels and contrast', (WidgetTester tester) async {
      await expectScreenContract(tester, (WidgetTester t) async {
        final QueueRig rig = await realClockRig();
        rig.store.dataAsOf = DateTime.utc(2026, 11, 3, 7, 5);
        DraftStore(rig.store).save(kind: 'report', fields: <String, Object?>{'a': 1});
        final ProviderContainer container = await openOfflineApp(t, rig, location: '/projects/mob-43');
        container.read(reachabilityProvider.notifier).report(Reachability.offline);
        await t.pumpAndSettle();
      });
    });
  });
}
