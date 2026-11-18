import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart' show HttpCall, HttpResult;
import 'package:machvon_mobile/core/di/providers.dart' show routerProvider;
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/navigation/route_catalogue.dart';
import 'package:machvon_mobile/core/navigation/tab_badges.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/core/widgets/underline_tabs.dart';
import 'package:machvon_mobile/features/dashboard/dashboard_feature.dart' as dashboard;
import 'package:machvon_mobile/features/dashboard/dashboard_strings.dart';
import 'package:machvon_mobile/features/dashboard/widgets/alerts_section.dart';
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

/// A server that answers the work of the scope and the reader's own apart, as the real one does.
ScriptedServer _scopeServer({bool refuseScope = false}) {
  final ScriptedServer server = _server();
  server
    ..on('GET', '/home/command-center', (_) => commandCenter())
    ..answer('GET', '/home/my-work', (HttpCall call) {
      if (call.url.queryParameters['view'] != 'scope') {
        return FakeTransport.json(200, alertWork(<Map<String, Object?>>[alertItem('a-mine', severity: 'ACTION', source: 'REPORT', title: 'Báo cáo của tôi', dueOn: '2026-11-05')], view: 'mine'));
      }
      if (refuseScope) {
        return HttpResult(
          status: 403,
          headers: const <String, String>{'content-type': 'application/problem+json'},
          body: jsonEncode(<String, Object?>{'type': 'about:blank', 'title': 'SCOPE_DENIED', 'status': 403, 'code': 'SCOPE_DENIED'}),
        );
      }
      return FakeTransport.json(
        200,
        alertWork(<Map<String, Object?>>[
          for (int n = 0; n < 5; n += 1) alertItem('a-scope-$n', severity: 'URGENT', source: 'DIRECTIVE', title: 'Chỉ đạo của đơn vị $n', dueOn: '2026-11-0${n + 1}', overdue: true, daysLate: 1),
        ]),
      );
    });
  return server;
}

Iterable<String?> _views(ScriptedServer server) => server.callsTo('GET', '/home/my-work').map((HttpCall call) => call.url.queryParameters['view']);

/// The words of the dashboard without its home screen: the home of a leader reads the work of the scope too, and these tests count the reads of the list alone.
const MobileFeature _dashboardWords = MobileFeature(id: 'dashboard_words', strings: dashboardStrings);

Map<String, Object?> _scopeRows(String unit) => alertWork(<Map<String, Object?>>[
      for (int n = 0; n < 2; n += 1) alertItem('a-$unit-$n', severity: 'URGENT', source: 'DIRECTIVE', title: 'Chỉ đạo của $unit số $n', dueOn: '2026-11-0${n + 1}', overdue: true, daysLate: 1),
    ]);

HttpResult _scopeDenied() => HttpResult(
      status: 403,
      headers: const <String, String>{'content-type': 'application/problem+json'},
      body: jsonEncode(<String, Object?>{'type': 'about:blank', 'title': 'SCOPE_DENIED', 'status': 403, 'code': 'SCOPE_DENIED'}),
    );

const SessionSnapshot _inTenantB = SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-b', userId: 'user-1', membershipId: 'm-b');

void main() {
  group('the list of work belongs to the session it was read under', () {
    Future<ProviderContainer> openList(WidgetTester tester, ScriptedServer server, FakeSession session, {bool scope = true}) => pumpWithServer(
          tester,
          features: <MobileFeature>[notifications.feature, _dashboardWords],
          server: server,
          session: session,
          location: scope ? '/inbox?tab=work&view=scope' : '/inbox?tab=work',
        );

    ScriptedServer base() => ScriptedServer()
      ..on('GET', '/me/notifications', (_) => notificationsPage(standardNotifications()))
      ..on('GET', '/home/my-work/counts', (_) => alertCounts(urgent: 1));

    testWidgets('a switch of organisation drops the rows of the scope at once; the new session, refused the scope, gets its own work', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      bool tenantB = false;
      final Completer<void> hold = Completer<void>();
      final ScriptedServer server = base()
        ..answer('GET', '/home/my-work', (HttpCall call) async {
          if (!tenantB) return FakeTransport.json(200, _scopeRows('tỉnh A'));
          await hold.future;
          if (call.url.queryParameters['view'] == 'scope') return _scopeDenied();
          return FakeTransport.json(200, alertWork(<Map<String, Object?>>[alertItem('b-mine', severity: 'ACTION', source: 'REPORT', title: 'Báo cáo của tôi ở B', dueOn: '2026-11-05')], view: 'mine'));
        });
      final FakeSession session = FakeSession();
      await openList(tester, server, session);
      expect(find.textContaining('Chỉ đạo của tỉnh A'), findsNWidgets(2));
      expect(find.descendant(of: find.byType(AlertsSection), matching: find.text('Việc trong phạm vi quản lý')), findsOneWidget);

      tenantB = true;
      session.change(_inTenantB);
      await tester.pump();
      expect(find.textContaining('Chỉ đạo của tỉnh A'), findsNothing, reason: 'gone before the new list has even answered');

      hold.complete();
      await tester.pumpAndSettle();
      expect(find.textContaining('Chỉ đạo của tỉnh A'), findsNothing);
      expect(find.text('Báo cáo của tôi ở B'), findsOneWidget);
      expect(find.text('Bạn không được xem toàn phạm vi nên đây là việc của riêng bạn.'), findsOneWidget);
      expect(find.descendant(of: find.byType(AlertsSection), matching: find.text('Việc trong phạm vi quản lý')), findsNothing, reason: 'own work is not titled as the scope');
    });

    testWidgets('an answer of the session that ended, arriving after the switch, fills nothing; only the answer of the new session is shown', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final Completer<void> oldAnswer = Completer<void>();
      final Completer<void> newAnswer = Completer<void>();
      int asked = 0;
      final ScriptedServer server = base()
        ..answer('GET', '/home/my-work', (HttpCall call) async {
          asked += 1;
          if (asked == 1) {
            await oldAnswer.future;
            return FakeTransport.json(200, _scopeRows('tỉnh A'));
          }
          await newAnswer.future;
          return FakeTransport.json(200, _scopeRows('tỉnh B'));
        });
      final FakeSession session = FakeSession();
      await openList(tester, server, session);
      expect(find.textContaining('Chỉ đạo của'), findsNothing, reason: 'the first read is still on its way');

      session.change(_inTenantB);
      await tester.pump();
      expect(asked, 2, reason: 'the new session asks for its own list');
      expect(find.textContaining('Chỉ đạo của'), findsNothing);

      oldAnswer.complete();
      await tester.pump();
      await tester.pump();
      expect(find.textContaining('Chỉ đạo của tỉnh A'), findsNothing, reason: 'the late answer of the organisation that was left is not shown');

      newAnswer.complete();
      await tester.pumpAndSettle();
      expect(find.textContaining('Chỉ đạo của tỉnh B'), findsNWidgets(2));
      expect(find.textContaining('Chỉ đạo của tỉnh A'), findsNothing);
    });

    testWidgets('the personal list is held to the same rule: another membership of the same person reads again, and a sign-out asks nothing', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      String owner = 'vai trò một';
      final ScriptedServer server = base()
        ..on('GET', '/home/my-work', (_) => alertWork(<Map<String, Object?>>[alertItem('m-1', severity: 'ACTION', source: 'REPORT', title: 'Việc của $owner', dueOn: '2026-11-05')], view: 'mine'));
      final FakeSession session = FakeSession(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1', membershipId: 'm-1'));
      await openList(tester, server, session, scope: false);
      expect(find.text('Việc của vai trò một'), findsOneWidget);
      expect(_views(server), <String?>['mine']);

      owner = 'vai trò hai';
      session.change(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1', membershipId: 'm-2'));
      await tester.pumpAndSettle();
      expect(find.text('Việc của vai trò một'), findsNothing);
      expect(find.text('Việc của vai trò hai'), findsOneWidget);
      expect(_views(server), <String?>['mine', 'mine']);

      // A change that is not of the identity (the second factor was asked for) reads nothing again.
      session.change(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1', membershipId: 'm-2', assurance: AssuranceLevel.aal2));
      await tester.pumpAndSettle();
      expect(_views(server), hasLength(2));

      session.change(const SessionSnapshot.signedOut());
      await tester.pump();
      expect(_views(server), hasLength(2), reason: 'nobody is signed in: nothing is asked');
      expect(find.text('Việc của vai trò hai'), findsNothing);
    });
  });

  group('"Xem tất cả" of the block of the scope opens the list of the scope, not the list of the reader', () {
    testWidgets('from the leader home it opens the work of the scope under its own title, with the way to "Việc của tôi" and back', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = _scopeServer();
      final ProviderContainer container = await _open(tester, server, '/home');
      expect(find.text('Việc trong phạm vi quản lý'), findsOneWidget);
      expect(find.text('Còn 2 việc nữa trong phạm vi quản lý.'), findsOneWidget);

      await tester.tap(find.text('Xem tất cả'));
      await tester.pumpAndSettle();
      final Uri where = Uri.parse(currentLocation(container));
      expect(where.path, '/inbox');
      expect(where.queryParameters, <String, String>{'tab': 'work', 'view': 'scope'});
      final Finder inbox = find.byType(AlertsSection);
      expect(find.descendant(of: inbox, matching: find.text('Việc trong phạm vi quản lý')), findsOneWidget, reason: 'the title says whose work it is');
      expect(find.descendant(of: inbox, matching: find.textContaining('Chỉ đạo của đơn vị')), findsNWidgets(5), reason: 'every row of the scope, not three');
      expect(find.descendant(of: inbox, matching: find.text('Báo cáo của tôi')), findsNothing);
      expect(find.descendant(of: inbox, matching: find.text('Việc cần xử lý')), findsNothing);
      expect(_views(server).where((String? view) => view == 'scope'), hasLength(2), reason: 'the home once, the list once');

      // The way back to the reader's own work is a chip beside the one that is on.
      await tester.tap(find.descendant(of: inbox, matching: find.text('Việc của tôi')));
      await tester.pumpAndSettle();
      expect(Uri.parse(currentLocation(container)).queryParameters, <String, String>{'tab': 'work'});
      expect(find.descendant(of: inbox, matching: find.text('Báo cáo của tôi')), findsOneWidget);
      expect(find.descendant(of: inbox, matching: find.textContaining('Chỉ đạo của đơn vị')), findsNothing, reason: 'the rows of the scope are not left under the other title');
      expect(find.descendant(of: inbox, matching: find.text('Việc cần xử lý')), findsOneWidget);
      expect(find.descendant(of: inbox, matching: find.text('Việc trong phạm vi quản lý')), findsNothing);

      await tester.tap(find.descendant(of: inbox, matching: find.text('Phạm vi quản lý')));
      await tester.pumpAndSettle();
      expect(Uri.parse(currentLocation(container)).queryParameters['view'], 'scope');
      expect(find.descendant(of: inbox, matching: find.textContaining('Chỉ đạo của đơn vị')), findsNWidgets(5));
    });

    testWidgets('the view the person chose is still there after a look at the Events tab; a link without the view opens own work', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = _scopeServer();
      final ProviderContainer container = await _open(tester, server, '/inbox?tab=work&view=scope');
      final Finder inbox = find.byType(AlertsSection);
      expect(find.descendant(of: inbox, matching: find.textContaining('Chỉ đạo của đơn vị')), findsNWidgets(5));
      final int scopeReads = _views(server).where((String? view) => view == 'scope').length;

      await tester.tap(find.descendant(of: find.byType(UnderlineTabs), matching: find.text('Sự kiện')));
      await tester.pumpAndSettle();
      expect(Uri.parse(currentLocation(container)).queryParameters, <String, String>{'view': 'scope'}, reason: 'the Events tab, with the choice of the work tab kept');
      await _openWorkTab(tester);
      expect(Uri.parse(currentLocation(container)).queryParameters, <String, String>{'tab': 'work', 'view': 'scope'});
      expect(find.descendant(of: inbox, matching: find.text('Việc trong phạm vi quản lý')), findsOneWidget);
      expect(find.descendant(of: inbox, matching: find.textContaining('Chỉ đạo của đơn vị')), findsNWidgets(5));
      expect(find.descendant(of: inbox, matching: find.text('Báo cáo của tôi')), findsNothing);
      expect(_views(server).where((String? view) => view == 'scope'), hasLength(scopeReads), reason: 'the list was kept, not read again');

      // The same after choosing own work: the Events tab does not bring the scope back.
      await tester.tap(find.descendant(of: inbox, matching: find.text('Việc của tôi')));
      await tester.pumpAndSettle();
      await tester.tap(find.descendant(of: find.byType(UnderlineTabs), matching: find.text('Sự kiện')));
      await tester.pumpAndSettle();
      expect(Uri.parse(currentLocation(container)).queryParameters, isEmpty);
      await _openWorkTab(tester);
      expect(find.descendant(of: inbox, matching: find.text('Báo cáo của tôi')), findsOneWidget);

      // A link that names no view is the reader's own work, whatever was chosen before.
      container.read(routerProvider).go('/inbox?tab=work&view=scope');
      await tester.pumpAndSettle();
      container.read(routerProvider).go('/inbox?tab=work');
      await tester.pumpAndSettle();
      expect(find.descendant(of: inbox, matching: find.text('Báo cáo của tôi')), findsOneWidget);
      expect(find.descendant(of: inbox, matching: find.text('Việc trong phạm vi quản lý')), findsNothing);
    });

    testWidgets('a person who opens the tab by themselves has their own work and no choice of a scope they never asked for', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = _scopeServer();
      await _open(tester, server, '/inbox');
      await _openWorkTab(tester);
      expect(find.text('Báo cáo của tôi'), findsOneWidget);
      expect(find.text('Phạm vi quản lý'), findsNothing);
      expect(find.text('Việc của tôi'), findsNothing);
      expect(_views(server).where((String? view) => view == 'scope'), hasLength(1), reason: 'the home tab asked once when the application started; the list of the inbox never asks for the scope');
      expect(_views(server).last, 'mine');
    });

    testWidgets('a reader the server refuses the scope gets their own work, told so, under the title of their own work', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = _scopeServer(refuseScope: true);
      await _open(tester, server, '/inbox?tab=work&view=scope');
      final Finder inbox = find.byType(AlertsSection);
      expect(find.descendant(of: inbox, matching: find.text('Báo cáo của tôi')), findsOneWidget);
      expect(find.descendant(of: inbox, matching: find.text('Bạn không được xem toàn phạm vi nên đây là việc của riêng bạn.')), findsOneWidget);
      expect(find.descendant(of: inbox, matching: find.text('Việc cần xử lý')), findsOneWidget);
      expect(find.descendant(of: inbox, matching: find.text('Việc trong phạm vi quản lý')), findsNothing);
    });

    testWidgets('the list of the scope keeps the contract at 360 dp and at 200 percent text, in English too', (WidgetTester tester) async {
      for (final double scale in <double>[1.0, 2.0]) {
        useDevice(tester, const Size(360, 3000), textScale: scale);
        await _open(tester, _scopeServer(), '/inbox?tab=work&view=scope');
        expect(find.text('Việc trong phạm vi quản lý'), findsOneWidget, reason: 'at $scale');
        expect(tester.takeException(), isNull, reason: 'no overflow at $scale');
      }
      useDevice(tester, const Size(360, 3000));
      await pumpWithServer(tester, features: <MobileFeature>[notifications.feature, dashboard.feature], server: _scopeServer(), location: '/inbox?tab=work&view=scope', locale: const Locale('en'));
      expect(find.text('Work in the scope you manage'), findsOneWidget);
      expect(find.text('My work'), findsOneWidget);
      expect(find.text('Scope I manage'), findsOneWidget);
    });
  });

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

      await _openWorkTab(tester);
      await tester.tap(find.text('Sự kiện'));
      await tester.pumpAndSettle();
      expect(find.text('Tất cả 4'), findsOneWidget, reason: 'the person chose the events after the link');

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
