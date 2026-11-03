import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/di/providers.dart';
import 'package:machvon_mobile/core/navigation/deep_link_guard.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/features/notification_inbox/deep_links.dart';
import 'package:machvon_mobile/features/notification_inbox/notification_inbox_feature.dart' as notifications;
import 'package:machvon_mobile/features/notification_inbox/notification_models.dart';

import '../../support/harness.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'notification_fixtures.dart';

const MobileFeature _records = MobileFeature(id: 'records', screens: <ScreenSpec>[ScreenSpec(screenId: 'MOB-10', pathSuffix: '/:projectId', builder: _record)]);

Widget _record(BuildContext context, ScreenContext screen) => Text('record ${screen.pathParameters.values.single}');

Future<ProviderContainer> _open(WidgetTester tester, ScriptedServer server, String location, {FakeSession? session}) =>
    pumpWithServer(tester, features: <MobileFeature>[notifications.feature, _records], server: server, location: location, session: session);

ScriptedServer _server() {
  final ScriptedServer server = ScriptedServer();
  server.on('GET', '/me/notifications', (_) => notificationsPage(standardNotifications()));
  server.on('POST', '/notifications/:id/read', (_) => <String, Object?>{'operation_id': 'o', 'status': 'Read', 'resource_version': 2});
  return server;
}

String _locationOf(String screenId) {
  switch (screenId) {
    case 'MOB-33':
      return '/inbox/mob-33';
    case 'MOB-45':
      return '/projects/mob-45';
    case 'MOB-10':
      return '/projects/mob-10';
    default:
      return '/approval/mob-24';
  }
}

void main() {
  group('AC-ST-MOB-015-2 UAT-AC181 BR-MOB-05 an opaque push link: sign-in and tenant first, only then the notification', () {
    testWidgets('signed in, the link opens the notification as opened from a push: read, never acknowledged', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = _server();
      final ProviderContainer container = await _open(tester, server, '/r/$idUnread');

      expect(currentLocation(container), '/inbox/mob-33/$idUnread?via=push');
      final List<HttpCall> reads = server.callsTo('POST', '/notifications/$idUnread/read');
      expect(reads, hasLength(1));
      expect(reads.single.body, '{"opened_via":"PUSH"}');
      expect(server.callsTo('POST', '/notifications/$idUnread/acknowledge'), isEmpty, reason: 'opening a push does not acknowledge it');
    });

    testWidgets('signed out, the link goes to sign-in first and keeps the wanted location; nothing is read or fetched', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = _server();
      final FakeSession session = FakeSession(const SessionSnapshot.signedOut());
      final ProviderContainer container = await _open(tester, server, '/r/$idUnread', session: session);

      final Uri now = Uri.parse(currentLocation(container));
      expect(now.path, '/mob-02');
      expect(now.queryParameters[returnParameter], '/r/$idUnread');
      expect(server.calls, isEmpty, reason: 'nothing of the notification is asked for before the sign-in');
    });

    testWidgets('after the sign-in the same link opens the notification', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = _server();
      final FakeSession session = FakeSession(const SessionSnapshot.signedOut());
      final ProviderContainer container = await _open(tester, server, '/r/$idUnread', session: session);
      expect(Uri.parse(currentLocation(container)).path, '/mob-02');

      session.change(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1'));
      await tester.pumpAndSettle();
      container.read(routerProvider).go('/r/$idUnread');
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/inbox/mob-33/$idUnread?via=push');
    });

    testWidgets('a link that names another tenant never opens: the access-denied screen, and nothing is read', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = _server();
      final ProviderContainer container = await _open(tester, server, '/r/$idUnread?tenant=tenant-b');

      expect(Uri.parse(currentLocation(container)).path, endsWith('/mob-45'));
      expect(server.calls.where((HttpCall call) => call.method == 'POST'), isEmpty);
    });

    testWidgets('a notification of another tenant, or of a membership that was revoked, is not found: no record detail', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = _server();
      server.on('GET', '/me/notifications', (_) => notificationsPage(<Map<String, Object?>>[]));
      await _open(tester, server, '/r/$idUnread');

      expect(find.text('Không tìm thấy thông báo'), findsOneWidget);
      expect(find.text('Mở hồ sơ'), findsNothing);
      expect(server.calls.where((HttpCall call) => call.method == 'POST'), isEmpty);
    });

    testWidgets('a link of the opaque path that is not of its shape goes to the access-denied screen and says nothing about what exists', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      for (final String bad in <String>['/r/short', '/r/$idUnread/extra', '/r/', '/r/%2e%2e%2f']) {
        final ScriptedServer server = _server();
        final ProviderContainer container = await _open(tester, server, bad);
        expect(Uri.parse(currentLocation(container)).path, endsWith('/mob-45'), reason: bad);
        expect(server.calls, isEmpty, reason: bad);
      }
    });
  });

  group('AC-ST-MOB-015-1 NOT02 the link reveals nothing: a pure look at the rule', () {
    test('only a link of the opaque shape is routed, to the notification screen with the push marker; the id is the only thing carried', () {
      expect(opaqueLinkRule(Uri.parse('/r/$idUnread'), _locationOf), '/inbox/mob-33/$idUnread?via=push');
      expect(opaqueLinkRule(Uri.parse('/home'), _locationOf), isNull);
      expect(opaqueLinkRule(Uri.parse('/rr/$idUnread'), _locationOf), isNull);
      expect(opaqueLinkRule(Uri.parse('/r/bad'), _locationOf), '/projects/mob-45');
      expect(opaqueLinkRule(Uri.parse('/r/$idUnread?project=p-1&amount=5'), _locationOf), '/inbox/mob-33/$idUnread?via=push', reason: 'whatever else the link carries is dropped');
    });

    test('the shape accepts a notification id and nothing that could carry a record, a path or a token', () {
      expect(opaqueLinkPattern.hasMatch('/r/$idUnread'), isTrue);
      expect(opaqueLinkPattern.hasMatch('/r/${'a' * 64}'), isTrue);
      expect(opaqueLinkPattern.hasMatch('/r/${'a' * 15}'), isFalse);
      expect(opaqueLinkPattern.hasMatch('/r/${'a' * 65}'), isFalse);
      expect(opaqueLinkPattern.hasMatch('/r/$idUnread/p-1'), isFalse);
      expect(opaqueLinkPattern.hasMatch('/r/$idUnread?token=x'), isFalse);
      expect(opaqueLinkPattern.hasMatch('https://evil.example/r/$idUnread'), isFalse);
    });

    test('a record opens only for a path the phone has a screen for, with a plain id', () {
      expect(recordLocationOf('/prj/prj-03?id=p-1', _locationOf), '/projects/mob-10/p-1');
      expect(recordLocationOf('/adm/adm-06?id=t-9', _locationOf), '/approval/mob-24/t-9');
      expect(recordLocationOf('/prj/prj-03', _locationOf), isNull);
      expect(recordLocationOf('/prj/prj-03?id=a b', _locationOf), isNull);
      expect(recordLocationOf('/dis/dis-03?id=r-1', _locationOf), isNull);
      expect(recordLocationOf('https://evil.example/prj/prj-03?id=p-1', _locationOf), isNull);
      expect(recordLocationOf('//evil.example/prj/prj-03?id=p-1', _locationOf), isNull);
      expect(recordLocationOf(r'/prj\prj-03?id=p-1', _locationOf), isNull);
      expect(recordLocationOf('javascript:alert(1)', _locationOf), isNull);
      expect(recordLocationOf(null, _locationOf), isNull);
    });

    test('the filters of the inbox are exact', () {
      final List<NotificationItem> items = <NotificationItem>[
        parseNotification(notification('a-0000000000000001', priority: 'HIGH', ack: true))!,
        parseNotification(notification('a-0000000000000002', readAt: '2026-11-01T00:00:00Z'))!,
        parseNotification(notification('a-0000000000000003', ack: true, readAt: '2026-11-01T00:00:00Z', acknowledgedAt: '2026-11-02T00:00:00Z'))!,
        parseNotification(notification('a-0000000000000004', title: 'notification.content.unavailable.title'))!,
      ];
      expect(applyNotificationFilter(items, const NotificationFilter(view: InboxView.unread)).map((NotificationItem i) => i.id), <String>['a-0000000000000001', 'a-0000000000000004']);
      expect(applyNotificationFilter(items, const NotificationFilter(view: InboxView.action)).map((NotificationItem i) => i.id), <String>['a-0000000000000001']);
      expect(applyNotificationFilter(items, const NotificationFilter(priority: 'HIGH')), hasLength(1));
      expect(applyNotificationFilter(items, const NotificationFilter(type: 'compensation_plan.updated.v1')), hasLength(3));
      expect(items[3].eventType, isNull);
      expect(items[3].isUnavailable, isTrue);
      expect(parseNotificationList(<String, Object?>{'items': <Object?>[]})!.complete, isTrue);
      expect(parseNotificationList(<String, Object?>{'items': <Object?>[], 'next_cursor': 'c'})!.complete, isFalse);
      expect(parseNotificationList(<String, Object?>{'nope': 1}), isNull);
    });
  });
}
