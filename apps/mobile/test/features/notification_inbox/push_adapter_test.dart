import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/features/notification_inbox/push_config.dart';
import 'package:machvon_mobile/features/notification_inbox/push_device.dart';
import 'package:machvon_mobile/features/notification_inbox/push_gateway.dart';
import 'package:machvon_mobile/features/notification_inbox/push_lifecycle.dart';
import 'package:machvon_mobile/features/notification_inbox/push_registration.dart';
import 'package:machvon_mobile/features/release/app_info.dart';

import '../session/support/world.dart' show MemorySecureStore;
import '../support/scripted_server.dart';
import 'notification_fixtures.dart';

/// The device adapter of push: selected by the build configuration, an identity kept in the secure store, the permission and the token
/// from the provider, rotation and revocation, and the id-only payload that opens the opaque link. The plugin is replaced by a gateway
/// the tests drive; what needs a device (the native side) is not part of these tests.

final class FakeGateway implements PushGateway {
  FakeGateway({this.state = PushPermission.granted, this.current = 'fcm-token-one'});

  PushPermission state;
  String? current;
  int starts = 0;
  bool deleted = false;
  Object? startError;
  Map<String, Object?>? launch;
  final StreamController<String> refreshes = StreamController<String>.broadcast();
  final StreamController<Map<String, Object?>> inForeground = StreamController<Map<String, Object?>>.broadcast();
  final StreamController<Map<String, Object?>> taps = StreamController<Map<String, Object?>>.broadcast();

  @override
  Future<void> start(PushConfig config) async {
    starts += 1;
    if (startError != null) throw startError!;
  }

  @override
  Future<PushPermission> permission() async => state;

  @override
  Future<String?> token() async => current;

  @override
  Stream<String> get tokenRefreshes => refreshes.stream;

  @override
  Stream<Map<String, Object?>> get foreground => inForeground.stream;

  @override
  Stream<Map<String, Object?>> get opened => taps.stream;

  @override
  Future<Map<String, Object?>?> launchedBy() async => launch;

  @override
  Future<void> deleteToken() async => deleted = true;
}

final class RecordingReceipts implements PushReceiptPort {
  final List<String> events = <String>[];
  bool fails = false;

  @override
  Future<void> acknowledge(String notificationId, PushReceiptEvent event) async {
    events.add('${event.name}:$notificationId');
    if (fails) throw StateError('the receipt service is down');
  }
}

const PushConfig _complete = PushConfig(mode: PushMode.fcm, apiKey: 'k', appId: 'a', senderId: 's', projectId: 'p');
const String _nid = 'ntf-0123456789abcdef';

Future<AppInfo> _info() async => const AppInfo(version: '1.4.0', build: '27', platform: 'android', osVersion: '14');

DevicePushPlatform _platform(FakeGateway gateway, {MemorySecureStore? store, String platform = 'android'}) =>
    DevicePushPlatform(gateway: gateway, config: _complete, store: store ?? MemorySecureStore(), info: _info, platformName: platform);

void main() {
  group('the build configuration selects the adapter', () {
    test('nothing set, or none, is the null adapter; fcm with the four options is the device adapter', () {
      expect(PushConfig.parse().enabled, isFalse);
      expect(PushConfig.parse(mode: 'none', apiKey: 'k', appId: 'a', senderId: 's', projectId: 'p').enabled, isFalse);
      expect(PushConfig.parse(mode: ' FCM ', apiKey: 'k', appId: 'a', senderId: 's', projectId: 'p').enabled, isTrue);
    });

    test('fcm with an option missing does not fail the build and does not push: it names the variables', () {
      final PushConfig config = PushConfig.parse(mode: 'fcm', apiKey: 'k', appId: ' ');
      expect(config.enabled, isFalse);
      expect(config.missing, <String>['MACHVON_FCM_APP_ID', 'MACHVON_FCM_SENDER_ID', 'MACHVON_FCM_PROJECT_ID']);
    });

    test('an unknown provider fails at start, naming the variable', () {
      expect(() => PushConfig.parse(mode: 'apns'), throwsA(isA<FormatException>().having((FormatException e) => e.message, 'message', contains('MACHVON_PUSH'))));
    });

    test('the platform provider gives the null adapter by default and the device adapter when the configuration is complete', () {
      final ProviderContainer none = ProviderContainer();
      addTearDown(none.dispose);
      expect(none.read(pushPlatformProvider), isA<NoPushPlatform>());
      expect(none.read(pushInboundProvider), isA<NoPushInbound>());

      final ProviderContainer fcm = ProviderContainer(overrides: <Override>[
        pushConfigProvider.overrideWithValue(_complete),
        pushGatewayProvider.overrideWithValue(FakeGateway()),
        pushPlatformProvider.overrideWith((Ref ref) => _platform(FakeGateway())),
      ]);
      addTearDown(fcm.dispose);
      expect(fcm.read(pushPlatformProvider), isA<DevicePushPlatform>());
      expect(fcm.read(pushInboundProvider), isA<DevicePushPlatform>());
    });
  });

  group('the device adapter', () {
    test('the installation identity is made once, kept in the secure store, and is not the token', () async {
      final MemorySecureStore store = MemorySecureStore();
      final DevicePushPlatform first = _platform(FakeGateway(), store: store);
      final String id = await first.installId();
      expect(id.length, greaterThanOrEqualTo(16));
      expect(id, isNot(contains('fcm-token')));
      expect(store.data[kInstallIdKey], id);
      expect(await _platform(FakeGateway(), store: store).installId(), id, reason: 'a restart reads the same identity');
      expect(first.appVersion, '1.4.0+27');
      expect(first.platform, 'android');
      expect(_platform(FakeGateway(), platform: 'ios').platform, 'ios');
    });

    test('the token is given only when the person allowed notifications; the permission is read, never asked', () async {
      final FakeGateway gateway = FakeGateway(state: PushPermission.denied);
      final DevicePushPlatform platform = _platform(gateway);
      expect(await platform.permission(), PushPermission.denied);
      expect(await platform.token(), isNull);
      gateway.state = PushPermission.provisional;
      expect(await platform.token(), 'fcm-token-one');
      gateway.state = PushPermission.granted;
      expect(await platform.token(), 'fcm-token-one');
      expect(gateway.starts, 1, reason: 'the provider starts once');
    });

    test('a provider that cannot start behaves as no push, and is tried again the next time', () async {
      final FakeGateway gateway = FakeGateway()..startError = StateError('no play services');
      final DevicePushPlatform platform = _platform(gateway);
      expect(await platform.permission(), PushPermission.unknown);
      expect(await platform.token(), isNull);
      gateway.startError = null;
      expect(await platform.token(), 'fcm-token-one');
    });

    test('a rotated token reaches the listeners, and forgetting the token deletes it at the provider', () async {
      final FakeGateway gateway = FakeGateway();
      final DevicePushPlatform platform = _platform(gateway);
      final List<String> seen = <String>[];
      final StreamSubscription<String> subscription = platform.tokenRefreshes.listen(seen.add);
      await pumpEventQueue();
      gateway.refreshes.add('fcm-token-two');
      await pumpEventQueue();
      expect(seen, <String>['fcm-token-two']);
      await subscription.cancel();
      await platform.forgetToken();
      expect(gateway.deleted, isTrue);
    });

    test('registration with the device adapter sends the permission, the version and the new token after a rotation', () async {
      final ScriptedServer server = ScriptedServer()..on('POST', '/devices', (_) => <String, Object?>{'operation_id': 'o', 'status': 'REGISTERED', 'resource_version': 1, 'resource_id': 'd-1'}, status: 201);
      final MachvonApiClient client = MachvonApiClient(baseUrl: Uri.parse('https://api.test/v1'), transport: server, token: () async => 'token');
      final DevicePushPlatform platform = _platform(FakeGateway(state: PushPermission.provisional));
      final PushRegistration registration = PushRegistration(client: client, platform: platform, language: () => 'vi');
      expect(await registration.sync(), RegistrationResult.registered);
      expect(await registration.sync(refreshedToken: 'fcm-token-two'), RegistrationResult.registered);
      final List<Map<String, Object?>> bodies = <Map<String, Object?>>[for (final HttpCall call in server.callsTo('POST', '/devices')) jsonDecode(call.body!) as Map<String, Object?>];
      expect(bodies[0], containsPair('permission_state', 'provisional'));
      expect(bodies[0], containsPair('app_version', '1.4.0+27'));
      expect(bodies[1], containsPair('push_token', 'fcm-token-two'));
      expect(bodies[0]['device_public_id'], bodies[1]['device_public_id']);
    });

    test('sign-out revokes at the server and then forgets the token at the provider', () async {
      final ScriptedServer server = ScriptedServer()
        ..on('GET', '/me/devices', (_) => <String, Object?>{
              'items': <Object?>[
                <String, Object?>{'id': 'dev-9', 'device_public_id': 'x' * 32, 'status': 'ACTIVE'},
              ],
            })
        ..on('POST', '/me/devices/:id/revoke', (_) => <String, Object?>{'operation_id': 'o', 'status': 'REVOKED', 'resource_version': 2});
      final MachvonApiClient client = MachvonApiClient(baseUrl: Uri.parse('https://api.test/v1'), transport: server, token: () async => 'token');
      final FakePush push = FakePush();
      final PushRegistration registration = PushRegistration(client: client, platform: push, language: () => 'vi');
      // the fake installation id differs from the listed one: nothing is revoked and the token is kept
      expect(await registration.revoke(), isFalse);
      expect(push.forgotten, isFalse);
      final ScriptedServer found = ScriptedServer()
        ..on('GET', '/me/devices', (_) => <String, Object?>{
              'items': <Object?>[
                <String, Object?>{'id': 'dev-9', 'device_public_id': 'dev-abc-installation-0001', 'status': 'ACTIVE'},
              ],
            })
        ..on('POST', '/me/devices/:id/revoke', (_) => <String, Object?>{'operation_id': 'o', 'status': 'REVOKED', 'resource_version': 2});
      final MachvonApiClient client2 = MachvonApiClient(baseUrl: Uri.parse('https://api.test/v1'), transport: found, token: () async => 'token');
      expect(await PushRegistration(client: client2, platform: push, language: () => 'vi').revoke(), isTrue);
      expect(push.forgotten, isTrue);
    });
  });

  group('the payload is the id of the notification and nothing else', () {
    test('only the nid key is read; a title, an amount or a name in the data is ignored', () {
      final PushPayload? payload = PushPayload.parse(<String, Object?>{'nid': _nid, 'title': 'Payment 12.000.000.000 VND', 'name': 'Nguyen Van A'});
      expect(payload?.notificationId, _nid);
      expect(payload?.location, '/r/$_nid');
      expect(PushPayload.parse(<String, Object?>{'title': 'x', 'amount': '1'}), isNull);
    });

    test('an id that is not a plain token, or is too short or long, is no payload', () {
      for (final Object? bad in <Object?>['short', 'has space 0123456789', '../../etc/passwd/0123', 12345, null, 'a' * 65, 'ntf/0123456789abcdef']) {
        expect(PushPayload.parse(<String, Object?>{'nid': bad}), isNull, reason: '$bad');
      }
    });

    test('the adapter hands over payloads from the foreground and from a tap, and drops the malformed ones', () async {
      final FakeGateway gateway = FakeGateway()..launch = <String, Object?>{'nid': _nid};
      final DevicePushPlatform platform = _platform(gateway);
      final List<String> received = <String>[];
      final List<String> opened = <String>[];
      final StreamSubscription<PushPayload> a = platform.received.listen((PushPayload p) => received.add(p.notificationId));
      final StreamSubscription<PushPayload> b = platform.opened.listen((PushPayload p) => opened.add(p.notificationId));
      await pumpEventQueue();
      gateway.inForeground.add(<String, Object?>{'nid': _nid});
      gateway.inForeground.add(<String, Object?>{'nid': 'bad'});
      gateway.taps.add(<String, Object?>{'nid': 'ntf-fedcba9876543210'});
      await pumpEventQueue();
      expect(received, <String>[_nid]);
      expect(opened, <String>['ntf-fedcba9876543210']);
      expect((await platform.launchedBy())?.notificationId, _nid);
      await a.cancel();
      await b.cancel();
    });
  });

  group('the lifecycle of a signed-in session', () {
    test('a tap opens the opaque link and acknowledges as opened; a foreground push acknowledges as delivered and opens nothing', () async {
      final FakeGateway gateway = FakeGateway();
      final RecordingReceipts receipts = RecordingReceipts();
      final List<String> opened = <String>[];
      int registrations = 0;
      final PushLifecycle lifecycle = PushLifecycle(inbound: _platform(gateway), receipts: receipts, open: opened.add, register: () async => registrations += 1)..start();
      await pumpEventQueue();
      expect(registrations, 1, reason: 'the device is registered when the session starts');
      gateway.inForeground.add(<String, Object?>{'nid': _nid});
      gateway.taps.add(<String, Object?>{'nid': 'ntf-fedcba9876543210'});
      await pumpEventQueue();
      expect(opened, <String>['/r/ntf-fedcba9876543210']);
      expect(receipts.events, containsAll(<String>['delivered:$_nid', 'opened:ntf-fedcba9876543210']));
      lifecycle.stop();
      gateway.taps.add(<String, Object?>{'nid': _nid});
      await pumpEventQueue();
      expect(opened, hasLength(1), reason: 'nothing is opened after the session ended');
    });

    test('the push that started the application opens its link once, and a failing receipt breaks nothing', () async {
      final FakeGateway gateway = FakeGateway()..launch = <String, Object?>{'nid': _nid};
      final RecordingReceipts receipts = RecordingReceipts()..fails = true;
      final List<String> opened = <String>[];
      final PushLifecycle lifecycle = PushLifecycle(inbound: _platform(gateway), receipts: receipts, open: opened.add, register: () async {})..start();
      await pumpEventQueue();
      expect(opened, <String>['/r/$_nid']);
      lifecycle.stop();
    });

    test('on a build without push nothing is opened and nothing is acknowledged', () async {
      final RecordingReceipts receipts = RecordingReceipts();
      final List<String> opened = <String>[];
      final PushLifecycle lifecycle = PushLifecycle(inbound: const NoPushInbound(), receipts: receipts, open: opened.add, register: () async {})..start();
      await pumpEventQueue();
      expect(opened, isEmpty);
      expect(receipts.events, isEmpty);
      lifecycle.stop();
    });
  });
}
