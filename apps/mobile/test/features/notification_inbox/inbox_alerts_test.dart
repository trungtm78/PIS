import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart' show HttpCall;
import 'package:machvon_mobile/core/di/providers.dart' show routerProvider;
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/navigation/route_catalogue.dart';
import 'package:machvon_mobile/core/navigation/tab_badges.dart';
import 'package:machvon_mobile/core/widgets/underline_tabs.dart';
import 'package:machvon_mobile/features/dashboard/dashboard_feature.dart' as dashboard;
import 'package:machvon_mobile/features/notification_inbox/notification_inbox_feature.dart' as notifications;

import '../../support/harness.dart';
import '../dashboard/dashboard_fixtures.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'notification_fixtures.dart';

/// The second tab of the inbox: the alerts of the person, which the home leads to with "See all".
Future<void> _openWorkTab(WidgetTester tester) async {
  await tester.tap(find.descendant(of: find.byType(UnderlineTabs), matching: find.textContaining('Việc cần xử lý')));
  await tester.pumpAndSettle();
}

Future<ProviderContainer> _open(WidgetTester tester, ScriptedServer server, String location) =>
    pumpWithServer(tester, features: <MobileFeature>[notifications.feature, dashboard.feature], server: server, location: location);

ScriptedServer _server({List<Map<String, Object?>>? alerts}) {
  final ScriptedServer server = ScriptedServer();
  server
    ..on('GET', '/me/notifications', (_) => notificationsPage(standardNotifications()))
    ..on(
      'GET',
      '/home/my-work',
      (_) => alertWork(
        alerts ??
            <Map<String, Object?>>[
              alertItem('a-urgent', severity: 'URGENT', source: 'PERMIT', title: 'Giấy phép DA-DT205 đã hết hạn', dueOn: '2026-11-01', overdue: true, daysLate: 2),
              alertItem('a-watch', severity: 'WATCH', source: 'SITE_DIARY', title: 'Thiếu nhật ký công trường', dueOn: '2026-11-10'),
            ],
        view: 'mine',
      ),
    )
    ..on('GET', '/home/my-work/counts', (_) => alertCounts(urgent: 1, watch: 1))
    ..on('POST', '/notifications/:id/read', (_) => <String, Object?>{'operation_id': 'o', 'status': 'Read', 'resource_version': 2});
  return server;
}

void main() {
  group('MOB-32 shows the alerts and the notifications with the same words for the severity', () {
    testWidgets('the events are the first tab and the alerts of the person the second, with the levels Khẩn and Theo dõi; the tab says how many are to act on', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = _server();
      await _open(tester, server, '/inbox');

      expect(find.text('Sự kiện'), findsOneWidget);
      expect(find.text('Tất cả 4'), findsOneWidget, reason: 'the timeline of events is what the tab opens on');
      expect(find.text('Giấy phép DA-DT205 đã hết hạn'), findsNothing, reason: 'the tasks are not stacked above the events any more: they are the other tab');
      expect(find.text('Việc cần xử lý 1'), findsOneWidget, reason: 'one urgent alert is to be acted on, the watched one is not counted');

      await _openWorkTab(tester);
      expect(find.text('Giấy phép DA-DT205 đã hết hạn'), findsOneWidget);
      expect(find.text('Trễ 2 ngày'), findsOneWidget);
      expect(find.text('Khẩn 1 · Theo dõi 1'), findsOneWidget);
      expect(find.text('Tất cả 4'), findsNothing, reason: 'the events tab is out of sight, still mounted');
      expect(server.callsTo('GET', '/home/my-work').any((HttpCall call) => call.url.queryParameters['view'] == 'mine'), isTrue, reason: 'the inbox shows the alerts of the person');
    });

    testWidgets('the "Xem tất cả" of the alerts on the home opens the inbox on the tab of the alerts, not on the events', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = _server();
      server.on('GET', '/home/command-center', (_) => commandCenter());
      final ProviderContainer container = await _open(tester, server, '/home');

      await tester.tap(find.text('Xem tất cả'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/inbox?tab=work');
      expect(find.text('Giấy phép DA-DT205 đã hết hạn'), findsOneWidget, reason: 'the full list of the alerts is what was asked for');
      expect(find.text('Tất cả 4'), findsNothing, reason: 'the events are the other tab');
    });

    testWidgets('the "Xem tất cả" opens the alert tab even when the inbox was left on the events before', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = _server();
      server.on('GET', '/home/command-center', (_) => commandCenter());
      final ProviderContainer container = await _open(tester, server, '/inbox');
      expect(find.text('Tất cả 4'), findsOneWidget, reason: 'the inbox was seen on its events');

      container.read(routerProvider).go('/home');
      await tester.pumpAndSettle();
      await tester.tap(find.text('Xem tất cả'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/inbox?tab=work');
      expect(find.text('Giấy phép DA-DT205 đã hết hạn'), findsOneWidget);
      expect(find.text('Tất cả 4'), findsNothing);
    });

    testWidgets('an inbox with no notification still has the alerts of the person in the other tab, and says it is empty', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = _server();
      server.on('GET', '/me/notifications', (_) => notificationsPage(<Map<String, Object?>>[]));
      await _open(tester, server, '/inbox');

      expect(find.text('Tất cả 0'), findsOneWidget);
      expect(find.text('Chưa có dữ liệu'), findsOneWidget);
      await _openWorkTab(tester);
      expect(find.text('Giấy phép DA-DT205 đã hết hạn'), findsOneWidget);
      expect(find.text('Khẩn 1 · Theo dõi 1'), findsOneWidget);
    });

    testWidgets('the number on the tab is the alerts to act on once the server has given it; the unread notifications stand in until then', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ProviderContainer withCounts = await _open(tester, _server(), '/inbox');
      expect(withCounts.read(tabBadgeProvider)[AppTab.inbox], 1, reason: 'one urgent alert, the watched one is not counted');

      final ScriptedServer old = _server()..refuse('GET', '/home/my-work/counts', 404, 'RESOURCE_NOT_FOUND');
      final ProviderContainer without = await _open(tester, old, '/inbox');
      expect(without.read(tabBadgeProvider)[AppTab.inbox], 3, reason: 'three notifications are unread');
    });

    testWidgets('while the alerts load there is a skeleton and no figure; a failure names the source and retries in place', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final Completer<void> slow = Completer<void>();
      final ScriptedServer server = _server();
      server.answer('GET', '/home/my-work', (HttpCall call) async {
        await slow.future;
        return FakeTransport.json(500, <String, Object?>{'type': 'about:blank', 'title': 'x', 'status': 500, 'code': 'INTERNAL_ERROR'});
      });
      await _open(tester, server, '/inbox');
      await _openWorkTab(tester);
      expect(find.text('Khẩn 0'), findsNothing);
      expect(find.byWidgetPredicate((Widget widget) => widget.runtimeType.toString() == 'AlertListSkeleton'), findsOneWidget);

      slow.complete();
      await tester.pumpAndSettle();
      expect(find.text('Chưa tải được việc cần xử lý'), findsOneWidget);
      expect(find.textContaining('INTERNAL_ERROR'), findsOneWidget);
      await tester.tap(find.text('Sự kiện'));
      await tester.pumpAndSettle();
      expect(find.text('Tất cả 4'), findsOneWidget, reason: 'the notifications are still there');
      await _openWorkTab(tester);

      server.on('GET', '/home/my-work', (_) => alertWork(<Map<String, Object?>>[alertItem('a-1', title: 'Tạm ứng quá hạn')], view: 'mine'));
      await tester.tap(find.widgetWithText(OutlinedButton, 'Thử lại'));
      await tester.pumpAndSettle();
      expect(find.text('Tạm ứng quá hạn'), findsOneWidget);
    });

    testWidgets('no alerts: the line says nothing urgent is left, and the notifications are unaffected', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      await _open(tester, _server(alerts: <Map<String, Object?>>[]), '/inbox');
      expect(find.text('Tất cả 4'), findsOneWidget);
      await _openWorkTab(tester);
      expect(find.textContaining('Không còn việc khẩn · đã kiểm tra lúc'), findsOneWidget);
    });

    testWidgets('the screen holds at three sizes and 200 percent text', (WidgetTester tester) async {
      await expectScreenContract(
        tester,
        open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/inbox'),
        healthy: (ScriptedServer server) {
          server
            ..on('GET', '/me/notifications', (_) => notificationsPage(standardNotifications()))
            ..on('GET', '/home/my-work', (_) => alertWork(<Map<String, Object?>>[alertItem('a-u', severity: 'URGENT', title: 'Giấy phép đã hết hạn'), alertItem('a-w', severity: 'WATCH', title: 'Thiếu nhật ký')], view: 'mine'));
        },
      );
    });
  });

  group('a notification whose record is closed or no longer readable says so; the lock screen text never carries an amount', () {
    testWidgets('a push for a record the member lost shows "Hồ sơ đã đóng" and nothing of the record', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      await _open(tester, _server(), '/r/$idRevoked');

      expect(find.text('Hồ sơ đã đóng'), findsOneWidget);
      expect(find.textContaining('Bạn không còn quyền xem hồ sơ'), findsOneWidget);
      expect(find.text('Mở hồ sơ'), findsNothing);
    });

    testWidgets('a push whose notification is gone says the record is closed too, and offers the way back', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = _server();
      server.on('GET', '/me/notifications', (_) => notificationsPage(<Map<String, Object?>>[]));
      await _open(tester, server, '/r/$idUnread');

      expect(find.text('Hồ sơ đã đóng'), findsOneWidget);
      expect(find.text('Không tìm thấy thông báo'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Về hộp thông báo'), findsOneWidget);
    });

    testWidgets('a title that carries an amount in free text is not shown: only the translated event title is', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = _server();
      server.on('GET', '/me/notifications', (_) => notificationsPage(<Map<String, Object?>>[notification(idPlain, title: 'Đã chi 5.000.000.000 đồng cho dự án A')]));
      await _open(tester, server, '/inbox');

      expect(find.textContaining('5.000.000.000'), findsNothing);
      expect(find.textContaining('đồng'), findsNothing);
    });
  });
}
