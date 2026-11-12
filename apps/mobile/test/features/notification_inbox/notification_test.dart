import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/di/providers.dart' show routerProvider;
import 'package:machvon_mobile/core/l10n/string_table.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/navigation/route_catalogue.dart';
import 'package:machvon_mobile/core/navigation/tab_badges.dart';
import 'package:machvon_mobile/core/widgets/work_row.dart' show GroupHeader;
import 'package:machvon_mobile/features/notification_inbox/notification_inbox_feature.dart' as notifications;

import '../../support/harness.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'notification_fixtures.dart';

/// The event titles the modules register; one of them is translated here, the rest fall back to the neutral title.
const MobileFeature _titles = MobileFeature(
  id: 'titles',
  strings: StringTable(
    vi: <String, String>{'notification.event.compensation_plan.updated.v1.title': 'Kế hoạch bồi thường có cập nhật'},
    en: <String, String>{'notification.event.compensation_plan.updated.v1.title': 'A compensation plan was updated'},
  ),
);

/// The screens a record opens in: stubs that take the id.
const MobileFeature _records = MobileFeature(id: 'records', screens: <ScreenSpec>[ScreenSpec(screenId: 'MOB-10', pathSuffix: '/:projectId', builder: _record), ScreenSpec(screenId: 'MOB-24', pathSuffix: '/:taskId', builder: _record)]);

Widget _record(BuildContext context, ScreenContext screen) => Text('record ${screen.pathParameters.values.single}');

Future<ProviderContainer> _open(WidgetTester tester, ScriptedServer server, String location, {FakeSession? session, Locale locale = const Locale('vi')}) =>
    pumpWithServer(tester, features: <MobileFeature>[notifications.feature, _titles, _records], server: server, location: location, session: session, locale: locale);

/// The notifications of the member, and the read and acknowledge commands answered as the server does.
ScriptedServer _server({List<Map<String, Object?>>? items}) {
  final ScriptedServer server = ScriptedServer();
  final List<Map<String, Object?>> list = items ?? standardNotifications();
  server.on('GET', '/me/notifications', (_) => notificationsPage(list));
  server.on('POST', '/notifications/:id/read', (_) => <String, Object?>{'operation_id': 'o', 'status': 'Read', 'resource_version': 2});
  server.on('POST', '/notifications/:id/acknowledge', (_) => <String, Object?>{'operation_id': 'o', 'status': 'Acknowledged', 'resource_version': 3});
  return server;
}

/// `count` notifications served fifty to a page by cursor, the way the server pages them; the one at `asking` position asks for an acknowledgement.
ScriptedServer _pagedServer({required int count, int? asking}) {
  String idAt(int index) => '3f2b6c1e-0000-4000-8000-${index.toString().padLeft(12, '0')}';
  final List<Map<String, Object?>> all = <Map<String, Object?>>[for (int i = 0; i < count; i += 1) notification(idAt(i), ack: i == asking, readAt: i == asking ? null : '2026-10-31T09:00:00Z')];
  final ScriptedServer server = ScriptedServer();
  server.on('GET', '/me/notifications', (HttpCall call) {
    final int from = int.parse(call.url.queryParameters['cursor'] ?? '0');
    final int to = from + 50 > all.length ? all.length : from + 50;
    return <String, Object?>{'items': all.sublist(from, to), 'next_cursor': to >= all.length ? null : '$to'};
  });
  server.on('POST', '/notifications/:id/read', (_) => <String, Object?>{'operation_id': 'o', 'status': 'Read', 'resource_version': 2});
  return server;
}

/// The cursors the phone asked for beyond the twenty pages of the inbox (a thousand notifications), in order.
List<String> _cursorsBeyondTheInbox(ScriptedServer server) => <String>[
      for (final HttpCall call in server.callsTo('GET', '/me/notifications'))
        if (int.parse(call.url.queryParameters['cursor'] ?? '0') >= 1000) call.url.queryParameters['cursor']!,
    ];

String _idAt(int index) => '3f2b6c1e-0000-4000-8000-${index.toString().padLeft(12, '0')}';

void _healthy(ScriptedServer server) {
  server.on('GET', '/me/notifications', (_) => notificationsPage(standardNotifications()));
  server.on('POST', '/notifications/:id/read', (_) => <String, Object?>{'operation_id': 'o', 'status': 'Read', 'resource_version': 2});
}

void main() {
  group('UI-MOB-32 AC-ST-MOB-015-5 MOB-32 the notification inbox', () {
    testWidgets('lists the notifications with their title, priority and state; the unread count is the badge; opening the list reads nothing', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = _server();
      final ProviderContainer container = await _open(tester, server, '/inbox');

      expect(find.text('Kế hoạch bồi thường có cập nhật'), findsNWidgets(3), reason: 'the translated title of three of the notifications');
      expect(find.text('Nội dung không còn khả dụng'), findsOneWidget);
      expect(find.text('Tất cả 4'), findsOneWidget);
      expect(find.text('Chưa đọc 3'), findsOneWidget);
      expect(find.text('Cần xác nhận 1'), findsOneWidget);
      expect(container.read(tabBadgeProvider)[AppTab.inbox], 3);
      expect(server.calls.where((HttpCall call) => call.method == 'POST'), isEmpty, reason: 'a notification is read when it is opened, not when it is listed');
    });

    testWidgets('the views, the priority and the type narrow the list; clearing the filters brings it back', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = _server();
      await _open(tester, server, '/inbox');

      await tester.ensureVisible(find.text('Cần xác nhận 1'));
      await tester.tap(find.text('Cần xác nhận 1'));
      await tester.pumpAndSettle();
      expect(find.text('Hiển thị 1 trên 4 thông báo'), findsOneWidget);

      await tester.ensureVisible(find.text('Tất cả 4'));
      await tester.tap(find.text('Tất cả 4'));
      await tester.pumpAndSettle();
      // The priority and the type are in the filter sheet: the chips apply at once, "Xong" closes it.
      await tester.tap(find.text('Lọc'));
      await tester.pumpAndSettle();
      expect(find.text('Lọc thông báo'), findsOneWidget);
      await tester.ensureVisible(find.text('Thấp'));
      await tester.tap(find.text('Thấp'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Xong'));
      await tester.pumpAndSettle();
      expect(find.text('Lọc (1)'), findsOneWidget, reason: 'the button says how many filters narrow the list');
      expect(find.text('Hiển thị 1 trên 4 thông báo'), findsOneWidget);

      await tester.ensureVisible(find.text('Chưa đọc 3'));
      await tester.tap(find.text('Chưa đọc 3'));
      await tester.pumpAndSettle();
      expect(find.text('Chưa có dữ liệu'), findsOneWidget);
      await tester.tap(find.text('Xóa bộ lọc'));
      await tester.pumpAndSettle();
      expect(find.text('Hiển thị 4 trên 4 thông báo'), findsOneWidget);
    });

    testWidgets('the notifications are grouped by what is asked of the person: waiting for an acknowledgement, unread, handled; the group says how many', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final SemanticsHandle semantics = tester.ensureSemantics();
      await _open(tester, _server(), '/inbox');

      expect(find.widgetWithText(GroupHeader, 'Cần xác nhận'), findsOneWidget);
      expect(find.widgetWithText(GroupHeader, 'Chưa đọc'), findsOneWidget);
      expect(find.bySemanticsLabel('Cần xác nhận, 1'), findsOneWidget);
      expect(find.bySemanticsLabel('Chưa đọc, 2'), findsOneWidget);
      final double action = tester.getTopLeft(find.widgetWithText(GroupHeader, 'Cần xác nhận')).dy;
      final double unread = tester.getTopLeft(find.widgetWithText(GroupHeader, 'Chưa đọc')).dy;
      expect(action, lessThan(unread), reason: 'what is asked of the person comes first');
      semantics.dispose();
    });

    testWidgets('without a connection the inbox shows the copy kept on the phone, says when it is from and that it is a copy, and the shell tells the connection once', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = _server();
      final ProviderContainer container = await _open(tester, server, '/inbox');

      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();

      expect(container.read(reachabilityProvider), Reachability.offline);
      expect(find.text('Tất cả 4'), findsOneWidget, reason: 'the copy is on the screen, not an empty page');
      expect(find.textContaining('Đang hiển thị dữ liệu đã lưu trên máy'), findsOneWidget);
      expect(find.textContaining('Bạn đang ngoại tuyến'), findsOneWidget, reason: 'one offline notice: the strip of the shell');
      expect(find.textContaining('mới nhất'), findsNothing);
    });

    testWidgets('a copy older than its time to live is marked as stale figures, and the screen still reads', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = _server();
      DateTime now = kNow;
      await pumpWithServer(tester, features: <MobileFeature>[notifications.feature, _titles, _records], server: server, location: '/inbox', now: () => now);

      server.offline = true;
      now = now.add(const Duration(days: 3));
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();

      expect(find.text('Số liệu cũ'), findsOneWidget);
      expect(find.textContaining('quá 12 giờ'), findsOneWidget);
      expect(find.text('Tất cả 4'), findsOneWidget);
    });

    testWidgets('a row opens its detail, and the settings button opens the preferences', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = _server();
      server.on('GET', '/me/notification-preferences', (_) => preferenceView());
      final ProviderContainer container = await _open(tester, server, '/inbox');

      await tester.tap(find.text('Nội dung không còn khả dụng'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/inbox/mob-33/$idRevoked');
      await pressBack(tester);
      await tester.tap(find.byTooltip('Cài đặt thông báo'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/inbox/mob-34');
    });

    testWidgets('every state is drawn and the contract of the screen holds', (WidgetTester tester) async {
      await expectEveryState(
        tester,
        open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/inbox'),
        script: StateScript(healthy: (ScriptedServer server) => server.on('GET', '/me/notifications', (_) => notificationsPage(standardNotifications())), content: find.text('Tất cả 4'), empty: (ScriptedServer server) => server.on('GET', '/me/notifications', (_) => notificationsPage(<Map<String, Object?>>[]))),
      );
      await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/inbox'), healthy: (ScriptedServer server) => server.on('GET', '/me/notifications', (_) => notificationsPage(standardNotifications())));
    });
  });

  group('UI-MOB-33 AC-ST-MOB-015-6 UAT-AC181 MOB-33 read is not acknowledged', () {
    testWidgets('opening a notification marks it read once, as opened in the app; nothing is acknowledged', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = _server();
      await _open(tester, server, '/inbox/mob-33/$idUnread');

      final List<HttpCall> reads = server.callsTo('POST', '/notifications/$idUnread/read');
      expect(reads, hasLength(1));
      expect(reads.single.body, '{"opened_via":"IN_APP"}');
      expect(reads.single.headers['idempotency-key'], isNotEmpty);
      expect(server.callsTo('POST', '/notifications/$idUnread/acknowledge'), isEmpty);
      expect(find.text('Kế hoạch bồi thường có cập nhật'), findsOneWidget);
      expect(find.text('Đã đọc chưa phải là đã xác nhận.'), findsOneWidget);
    });

    testWidgets('after it is read, the acknowledgement is a separate act: the button records it with the note, and a notification that asks for none offers none', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final List<Map<String, Object?>> items = standardNotifications();
      final ScriptedServer server = _server(items: items);
      server.on('POST', '/notifications/$idUnread/read', (_) {
        items[0] = notification(idUnread, priority: 'HIGH', ack: true, readAt: '2026-11-03T03:00:00Z', ref: '/prj/prj-03?id=p-1');
        return <String, Object?>{'operation_id': 'o', 'status': 'Read', 'resource_version': 2};
      });
      await _open(tester, server, '/inbox/mob-33/$idUnread');

      expect(find.text('Thông báo này cần bạn xác nhận đã nhận.'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Xác nhận đã nhận')).onPressed, isNotNull);
      await tester.enterText(find.byType(TextField), 'Đã nhận, sẽ xử lý');
      await tester.tap(find.widgetWithText(FilledButton, 'Xác nhận đã nhận'));
      await tester.pumpAndSettle();
      final List<HttpCall> acknowledgements = server.callsTo('POST', '/notifications/$idUnread/acknowledge');
      expect(acknowledgements, hasLength(1));
      expect(acknowledgements.single.body, '{"comment":"Đã nhận, sẽ xử lý"}');
      expect(find.text('Đã ghi nhận xác nhận của bạn.'), findsOneWidget);

      await _open(tester, server, '/inbox/mob-33/$idPlain');
      expect(find.text('Thông báo này cần bạn xác nhận đã nhận.'), findsNothing);
      expect(server.callsTo('POST', '/notifications/$idPlain/acknowledge'), isEmpty);
    });

    testWidgets('an acknowledgement the server refuses says why (422 ACK_NOT_REQUIRED) and a lost answer is retried under the same key', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final List<Map<String, Object?>> items = <Map<String, Object?>>[notification(idUnread, ack: true, readAt: '2026-11-03T03:00:00Z')];
      final ScriptedServer server = _server(items: items);
      server.refuse('POST', '/notifications/$idUnread/acknowledge', 422, 'ACK_NOT_REQUIRED');
      await _open(tester, server, '/inbox/mob-33/$idUnread');
      await tester.tap(find.widgetWithText(FilledButton, 'Xác nhận đã nhận'));
      await tester.pumpAndSettle();
      expect(find.text('Thông báo này không yêu cầu xác nhận.'), findsOneWidget);

      final ScriptedServer lossy = _server(items: items);
      int attempt = 0;
      lossy.answer('POST', '/notifications/$idUnread/acknowledge', (HttpCall call) {
        attempt += 1;
        if (attempt == 1) throw Exception('lost');
        return FakeTransport.json(200, <String, Object?>{'operation_id': 'o', 'status': 'Acknowledged', 'resource_version': 3});
      });
      await _open(tester, lossy, '/inbox/mob-33/$idUnread');
      await tester.tap(find.widgetWithText(FilledButton, 'Xác nhận đã nhận'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Mất kết nối trước khi nhận được trả lời'), findsOneWidget);
      await tester.tap(find.widgetWithText(FilledButton, 'Xác nhận đã nhận'));
      await tester.pumpAndSettle();
      final List<HttpCall> calls = lossy.callsTo('POST', '/notifications/$idUnread/acknowledge');
      expect(calls, hasLength(2));
      expect(calls[1].headers['idempotency-key'], calls[0].headers['idempotency-key']);
      expect(find.text('Đã ghi nhận xác nhận của bạn.'), findsOneWidget);
    });

    testWidgets('a notification whose record the member lost shows nothing of it: no content, no link, no acknowledgement', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      // The notification still carries the reference of the record and asks for an acknowledgement: the lost access, not the lack of
      // a reference, is what keeps the link and the button away.
      final ScriptedServer server = _server(items: <Map<String, Object?>>[notification(idRevoked, title: 'notification.content.unavailable.title', ack: true, ref: '/prj/prj-03?id=p-1')]);
      await _open(tester, server, '/inbox/mob-33/$idRevoked');

      expect(find.text('Nội dung không còn khả dụng'), findsOneWidget);
      expect(find.textContaining('Bạn không còn quyền xem hồ sơ'), findsOneWidget);
      expect(find.text('Mở hồ sơ'), findsNothing);
      expect(find.text('Xác nhận đã nhận'), findsNothing);
      expect(server.callsTo('POST', '/notifications/$idRevoked/read'), isEmpty, reason: 'there is nothing to read');
    });

    testWidgets('a notification that is not found (another tenant, another member) says so and reveals nothing', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = _server();
      await _open(tester, server, '/inbox/mob-33/3f2b6c1e-0000-4000-8000-0000000000ff');

      expect(find.text('Không tìm thấy thông báo'), findsOneWidget);
      expect(server.calls.where((HttpCall call) => call.method == 'POST'), isEmpty);
      await tester.tap(find.text('Về hộp thông báo'));
      await tester.pumpAndSettle();
      expect(find.text('Tất cả 4'), findsOneWidget);
    });

    testWidgets('a notification older than the first thousand the inbox lists is found by reading on, and is read like any other', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = _pagedServer(count: 1130, asking: 1075);
      await _open(tester, server, '/inbox/mob-33/${_idAt(1075)}');

      expect(find.text('Không tìm thấy thông báo'), findsNothing);
      expect(find.text('Thông báo này cần bạn xác nhận đã nhận.'), findsOneWidget);
      expect(server.callsTo('POST', '/notifications/${_idAt(1075)}/read'), hasLength(1), reason: 'opening it reads it');
      expect(_cursorsBeyondTheInbox(server).toSet(), <String>{'1000', '1050'}, reason: 'the pages after the twenty of the inbox, up to the one that holds it (the list is read again once the notification is marked read)');
    });

    testWidgets('a notification the whole list does not hold is not found, after the list was read to its end and not beyond', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = _pagedServer(count: 1130);
      await _open(tester, server, '/inbox/mob-33/3f2b6c1e-0000-4000-8000-0000000000ff');

      expect(find.text('Không tìm thấy thông báo'), findsOneWidget);
      expect(_cursorsBeyondTheInbox(server), <String>['1000', '1050', '1100'], reason: 'every page after the inbox ones, to the end of the list and not beyond');
      expect(server.calls.where((HttpCall call) => call.method == 'POST'), isEmpty);
    });

    testWidgets('the record a notification is about opens in its screen on the phone; a reference without a screen opens nothing', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = _server();
      final ProviderContainer container = await _open(tester, server, '/inbox/mob-33/$idUnread');

      await tester.tap(find.text('Mở hồ sơ'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/projects/mob-10/p-1');
      expect(find.text('record p-1'), findsOneWidget);

    });

    testWidgets('an approval reference opens the approval, and a notification without a reference has no link', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = _server();
      final ProviderContainer container = await _open(tester, server, '/inbox/mob-33/$idRead');
      await tester.tap(find.text('Mở hồ sơ'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/approval/mob-24/t-9');

      await _open(tester, server, '/inbox/mob-33/$idPlain');
      expect(find.text('Mở hồ sơ'), findsNothing, reason: 'no reference, no link');
    });

    testWidgets('a read that cannot reach the server says so and is retried under the same key; a copy on the device marks nothing', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = _server();
      int attempt = 0;
      server.answer('POST', '/notifications/$idPlain/read', (HttpCall call) {
        attempt += 1;
        if (attempt == 1) throw Exception('lost');
        return FakeTransport.json(200, <String, Object?>{'operation_id': 'o', 'status': 'Read', 'resource_version': 2});
      });
      await _open(tester, server, '/inbox/mob-33/$idPlain');
      expect(find.text('Chưa đánh dấu đã đọc được vì chưa kết nối được máy chủ.'), findsOneWidget);
      await tester.tap(find.text('Thử đánh dấu lại'));
      await tester.pumpAndSettle();
      final List<HttpCall> reads = server.callsTo('POST', '/notifications/$idPlain/read');
      expect(reads, hasLength(2));
      expect(reads[1].headers['idempotency-key'], reads[0].headers['idempotency-key']);
      expect(find.text('Chưa đánh dấu đã đọc được vì chưa kết nối được máy chủ.'), findsNothing);

    });

    testWidgets('a notification opened from the copy on the device, still unread there, sends no read and cannot be acknowledged', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer copy = _server();
      final ProviderContainer container = await _open(tester, copy, '/inbox');
      copy.offline = true;
      container.read(routerProvider).go('/inbox/mob-33/$idUnread');
      await tester.pumpAndSettle();

      expect(find.textContaining('Đang hiển thị dữ liệu đã lưu trên máy'), findsOneWidget, reason: 'the detail is drawn from the copy');
      expect(copy.callsTo('POST', '/notifications/$idUnread/read'), isEmpty, reason: 'the copy is not a reason to send anything');
      expect(find.text('Thông báo này cần bạn xác nhận đã nhận.'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Xác nhận đã nhận')).onPressed, isNull, reason: 'it is acknowledged after it is read, and it has not been read');
    });

    testWidgets('every state is drawn and the contract of the screen holds', (WidgetTester tester) async {
      await expectEveryState(
        tester,
        open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/inbox/mob-33/$idPlain'),
        script: StateScript(healthy: _healthy, content: find.text('Chi tiết thông báo')),
      );
      await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/inbox/mob-33/$idPlain'), healthy: _healthy);
    });
  });
}
