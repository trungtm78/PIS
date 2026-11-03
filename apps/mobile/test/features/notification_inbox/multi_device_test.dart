import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/di/providers.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/features/notification_inbox/device_ownership.dart';
import 'package:machvon_mobile/features/notification_inbox/notification_inbox_feature.dart' as notifications;
import 'package:machvon_mobile/features/notification_inbox/push_registration.dart';
import 'package:machvon_mobile/features/read_support/widgets.dart' show StatusPill;

import '../../support/harness.dart' show FakeSession, useDevice;
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'notification_fixtures.dart';

const String _mine = 'dev-abc-installation-0001';

Map<String, Object?> _device(String id, String publicId, {String platform = 'android', String permission = 'granted', bool owner = false, String status = 'ACTIVE', String seen = '2026-11-03T02:00:00Z'}) => <String, Object?>{
      'id': id,
      'platform': platform,
      'device_public_id': publicId,
      'last_seen_at': seen,
      'revoked_at': status == 'ACTIVE' ? null : '2026-11-02T00:00:00Z',
      'status': status,
      'permission_state': permission,
      'push_owner': owner,
    };

Map<String, Object?> _devices(List<Map<String, Object?>> items) => <String, Object?>{'items': items, 'as_of': '2026-11-03T02:00:00Z'};

Map<String, Object?> _flags(bool enabled) => <String, Object?>{
      'items': <Object?>[
        <String, Object?>{'flag_key': 'some.other.flag', 'enabled': true},
        <String, Object?>{'flag_key': externalChannelsFlag, 'enabled': enabled},
      ],
    };

void _server(ScriptedServer server, {List<Map<String, Object?>>? devices, Object? flags}) {
  server
    ..on('GET', '/me/notification-preferences', (_) => preferenceView())
    ..on('POST', '/devices', (_) => <String, Object?>{'operation_id': 'o', 'status': 'UPDATED', 'resource_version': 1, 'resource_id': 'd-1'}, status: 201)
    ..on('GET', '/me/devices', (_) => _devices(devices ?? <Map<String, Object?>>[_device('d-1', _mine, owner: true)]))
    ..on('GET', '/me/feature-flags', (_) => flags ?? _flags(false));
}

Future<ProviderContainer> _open(WidgetTester tester, ScriptedServer server, {FakePush? push}) => pumpWithServer(
      tester,
      features: <MobileFeature>[notifications.feature],
      server: server,
      location: '/inbox/mob-34',
      overrides: <Override>[pushPlatformProvider.overrideWithValue(push ?? FakePush(currentToken: 'token-one'))],
    );

void main() {
  group('AC-ST-MOB-031-1 UAT-AC176 TK-MOB-031-1 the devices of the member and the one the push goes to', () {
    testWidgets('lists the live devices with the owner first, this device marked, and says why the others do not receive push', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _server(server, devices: <Map<String, Object?>>[
        _device('d-2', 'tablet-installation-0002', platform: 'ios', owner: false),
        _device('d-1', _mine, owner: true, seen: '2026-11-03T03:00:00Z'),
        _device('d-3', 'browser-installation-0003', platform: 'web', permission: 'denied'),
        _device('d-4', 'old-installation-0004', status: 'REVOKED'),
      ]);
      await _open(tester, server);

      expect(find.text('Thiết bị nhận thông báo đẩy'), findsOneWidget);
      expect(find.text('Điện thoại Android (thiết bị này)'), findsOneWidget);
      expect(find.text('Nhận thông báo đẩy'), findsOneWidget, reason: 'exactly one device receives the push');
      expect(find.text('Dự phòng: cho phép thông báo nhưng bạn dùng thiết bị khác gần nhất'), findsOneWidget);
      expect(find.text('Không nhận thông báo đẩy: hệ điều hành chưa cho phép'), findsOneWidget);
      expect(find.text('iPhone / iPad'), findsOneWidget);
      expect(find.text('Trình duyệt'), findsOneWidget);
      expect(find.text('Dùng lần cuối 03/11/2026 10:00'), findsOneWidget, reason: 'in Vietnam time');
      expect(find.textContaining('chỉ gửi tới một thiết bị'), findsOneWidget);
      expect(find.byType(StatusPill), findsNWidgets(3), reason: 'the removed device is not listed');
      expect(tester.getTopLeft(find.text('Điện thoại Android (thiết bị này)')).dy, lessThan(tester.getTopLeft(find.text('iPhone / iPad')).dy), reason: 'the owner first');
    });

    testWidgets('the phone shows the decision of the server and decides nothing: a device the server does not call the owner is not shown as one, even when it is this device', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _server(server, devices: <Map<String, Object?>>[_device('d-1', _mine, owner: false), _device('d-2', 'tablet-installation-0002', owner: true)]);
      await _open(tester, server);
      expect(find.text('Nhận thông báo đẩy'), findsOneWidget);
      expect(find.text('Dự phòng: cho phép thông báo nhưng bạn dùng thiết bị khác gần nhất'), findsOneWidget);
      final double standby = tester.getTopLeft(find.text('Điện thoại Android (thiết bị này)')).dy;
      final double owner = tester.getTopLeft(find.text('Điện thoại Android').first).dy;
      expect(owner, lessThan(standby));
    });

    testWidgets('opening the card registers this device again with what the system allows now, before the list is read, so that the choice follows the use and a changed permission', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _server(server);
      await _open(tester, server, push: FakePush(currentToken: 'token-one', state: PushPermission.provisional));

      final List<HttpCall> order = <HttpCall>[for (final HttpCall call in server.calls) if (call.url.path.endsWith('/devices') || call.url.path.endsWith('/me/devices')) call];
      final List<String> names = <String>[for (final HttpCall call in order) '${call.method} ${call.url.path.replaceFirst('/v1', '')}'];
      expect(names.where((String n) => n == 'POST /devices'), hasLength(2), reason: 'the inbox registers at its opening and the card registers again before it reads');
      expect(names.last, 'GET /me/devices');
      expect(names[names.length - 2], 'POST /devices', reason: 'the registration comes right before the list');
      final Map<String, Object?> body = jsonDecode(order[order.length - 2].body!) as Map<String, Object?>;
      expect(body, containsPair('permission_state', 'provisional'));
      expect(body, containsPair('device_public_id', _mine));
    });

    testWidgets('a device with no push token is not registered but the list is still read', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _server(server);
      await _open(tester, server, push: FakePush(currentToken: null, state: PushPermission.denied));
      expect(server.callsTo('POST', '/devices'), isEmpty);
      expect(find.text('Điện thoại Android (thiết bị này)'), findsOneWidget);
    });

    testWidgets('a list that cannot be read is said, the settings stay usable, and a retry reads it again', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _server(server);
      server.refuse('GET', '/me/devices', 503, 'DEPENDENCY_UNAVAILABLE');
      await _open(tester, server);
      expect(find.text('Chưa đọc được danh sách thiết bị. Hộp thông báo vẫn dùng được.'), findsOneWidget);
      expect(find.text('Cài đặt thông báo'), findsWidgets);

      server.on('GET', '/me/devices', (_) => _devices(<Map<String, Object?>>[_device('d-1', _mine, owner: true)]));
      await tester.ensureVisible(find.widgetWithText(OutlinedButton, 'Thử lại'));
      await tester.tap(find.widgetWithText(OutlinedButton, 'Thử lại'));
      await tester.pumpAndSettle();
      expect(find.text('Điện thoại Android (thiết bị này)'), findsOneWidget);
    });

    testWidgets('a member with no registered device is told so', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _server(server, devices: <Map<String, Object?>>[]);
      await _open(tester, server);
      expect(find.text('Chưa có thiết bị nào đăng ký nhận thông báo đẩy.'), findsOneWidget);
    });

    testWidgets('the devices are read-only here: the member cannot pin or remove a device from this card', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _server(server, devices: <Map<String, Object?>>[_device('d-1', _mine, owner: true), _device('d-2', 'tablet-installation-0002')]);
      await _open(tester, server);
      expect(server.calls.where((HttpCall call) => call.method == 'POST' && call.url.path.contains('/revoke')), isEmpty);
      expect(find.widgetWithText(OutlinedButton, 'Thử lại'), findsNothing);
    });
  });

  group('TK-MOB-031-2 the external channels start only when the organisation has them', () {
    testWidgets('the flag off says they are not on and that they start with the provider contract', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _server(server, flags: _flags(false));
      await _open(tester, server);
      expect(find.text('Hội thoại với kênh ngoài'), findsOneWidget);
      expect(find.textContaining('Chưa bật cho tổ chức của bạn'), findsOneWidget);
      expect(find.textContaining('Đã bật cho tổ chức của bạn'), findsNothing);
    });

    testWidgets('the flag on says they are on, and that consent and the reply window still apply', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _server(server, flags: _flags(true));
      await _open(tester, server);
      expect(find.textContaining('Đã bật cho tổ chức của bạn'), findsOneWidget);
      expect(find.textContaining('đã đồng ý'), findsOneWidget);
    });

    test('a flag that is absent, or cannot be read, is off', () async {
      for (final void Function(ScriptedServer) script in <void Function(ScriptedServer)>[
        (ScriptedServer s) => s.on('GET', '/me/feature-flags', (_) => <String, Object?>{'items': <Object?>[]}),
        (ScriptedServer s) => s.on('GET', '/me/feature-flags', (_) => <String, Object?>{'items': <Object?>[<String, Object?>{'flag_key': 'other', 'enabled': true}]}),
        (ScriptedServer s) => s.refuse('GET', '/me/feature-flags', 403, 'SCOPE_DENIED'),
        (ScriptedServer s) => s.offline = true,
      ]) {
        final ScriptedServer server = ScriptedServer();
        script(server);
        final ProviderContainer container = ProviderContainer(
          overrides: <Override>[
            sessionProvider.overrideWith(() => FakeSession()),
            apiClientProvider.overrideWithValue(MachvonApiClient(baseUrl: Uri.parse('https://api.test/v1'), transport: server, token: () async => 'token')),
          ],
        );
        addTearDown(container.dispose);
        expect(await container.read(externalChannelsEnabledProvider.future), isFalse);
      }
    });
  });

  group('UI-MOB-34 the settings with the devices card keep the screen contract', () {
    testWidgets('the seven states and the contract hold with the new cards', (WidgetTester tester) async {
      Future<void> open(WidgetTester t, ScriptedServer s) async {
        await _open(t, s);
      }

      await expectEveryState(
        tester,
        open: open,
        script: StateScript(healthy: (ScriptedServer s) => _server(s), content: find.byType(ListView)),
      );
      await expectScreenContract(tester, open: open, healthy: (ScriptedServer s) => _server(s, flags: _flags(true), devices: <Map<String, Object?>>[_device('d-1', _mine, owner: true), _device('d-2', 'tablet-installation-0002', platform: 'ios')]));
    });
  });
}
