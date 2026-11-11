import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/widgets.dart' show Locale;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/features/notification_inbox/push_registration.dart';
import 'package:machvon_mobile/features/release/app_info.dart';

import '../../support/harness.dart' show FakeTransport;
import '../support/scripted_server.dart';
import 'notification_fixtures.dart';

MachvonApiClient _client(ScriptedServer server) => MachvonApiClient(baseUrl: Uri.parse('https://api.test/v1'), transport: server, token: () async => 'token');

PushRegistration _registration(ScriptedServer server, FakePush push) => PushRegistration(client: _client(server), platform: push, language: () => 'vi');

Map<String, Object?> _registered(String id) => <String, Object?>{'operation_id': 'o', 'status': 'REGISTERED', 'resource_version': 1, 'resource_id': id};

const String serverDeviceId = '3f2b6c1e-0000-4000-8000-0000000000d1';

void main() {
  test('the locale sent to the server has a region, as its registration requires', () {
    expect(deviceLocaleOf(const Locale('vi')), 'vi-VN');
    expect(deviceLocaleOf(const Locale('en')), 'en-US');
    expect(deviceLocaleOf(const Locale('en', 'GB')), 'en-GB');
    expect(RegExp(r'^[a-z]{2}-[A-Z]{2}$').hasMatch(deviceLocaleOf(const Locale('vi'))), isTrue);
  });

  group('the registration hands its id to the offline store as the sync device', () {
    test('every registration that gives an id tells it; a failure of the store does not undo the registration; a lost answer tells nothing', () async {
      final List<String> told = <String>[];
      final ScriptedServer server = ScriptedServer()..on('POST', '/devices', (_) => _registered(serverDeviceId), status: 201);
      final PushRegistration registration = PushRegistration(
        client: _client(server),
        platform: FakePush(currentToken: 'token-one'),
        language: () => 'vi',
        onRegistered: (String id) async => told.add(id),
      );
      expect(await registration.sync(), RegistrationResult.registered);
      await Future<void>.delayed(Duration.zero);
      expect(told, <String>[serverDeviceId]);

      final PushRegistration broken = PushRegistration(
        client: _client(server),
        platform: FakePush(currentToken: 'token-one'),
        language: () => 'vi',
        onRegistered: (String id) async => throw StateError('store closed'),
      );
      expect(await broken.sync(), RegistrationResult.registered);

      final List<String> none = <String>[];
      final ScriptedServer down = ScriptedServer()..answer('POST', '/devices', (HttpCall call) => throw const SocketException('lost'));
      final PushRegistration offline = PushRegistration(client: _client(down), platform: FakePush(currentToken: 'token-one'), language: () => 'vi', onRegistered: (String id) async => none.add(id));
      expect(await offline.sync(), RegistrationResult.offline);
      expect(none, isEmpty);
    });
  });

  group('AC-ST-MOB-015-4 UAT-AC192 TK-MOB-015-1 the registration of the device for push', () {
    test('a token refresh keeps one live registration: the same installation identity with the new token, a new key for a new token', () async {
      final ScriptedServer server = ScriptedServer()..on('POST', '/devices', (_) => _registered(serverDeviceId), status: 201);
      final FakePush push = FakePush(currentToken: 'token-one');
      final PushRegistration registration = _registration(server, push);

      expect(await registration.sync(), RegistrationResult.registered);
      expect(await registration.sync(refreshedToken: 'token-two'), RegistrationResult.registered);

      final List<HttpCall> calls = server.callsTo('POST', '/devices');
      expect(calls, hasLength(2));
      final Map<String, Object?> first = jsonDecode(calls[0].body!) as Map<String, Object?>;
      final Map<String, Object?> second = jsonDecode(calls[1].body!) as Map<String, Object?>;
      expect(first['device_public_id'], second['device_public_id'], reason: 'the server keys the registration by the installation, so it keeps one');
      expect(first['push_token'], 'token-one');
      expect(second['push_token'], 'token-two');
      expect(first['platform'], 'android');
      expect(first['permission_state'], 'granted');
      expect(first['app_version'], '1.4.0');
      expect(first['locale'], 'vi');
      expect(calls[0].headers['idempotency-key'], isNot(calls[1].headers['idempotency-key']));
      expect(registration.serverDeviceId, serverDeviceId);
    });

    test('the same token sent again after a lost answer reuses the key, so the server registers it once', () async {
      final ScriptedServer server = ScriptedServer();
      int attempt = 0;
      server.answer('POST', '/devices', (HttpCall call) {
        attempt += 1;
        if (attempt == 1) throw const SocketException('lost');
        return FakeTransport.json(201, _registered(serverDeviceId));
      });
      final PushRegistration registration = _registration(server, FakePush(currentToken: 'token-one'));

      expect(await registration.sync(), RegistrationResult.offline);
      expect(await registration.sync(), RegistrationResult.registered);
      final List<HttpCall> calls = server.callsTo('POST', '/devices');
      expect(calls[1].headers['idempotency-key'], calls[0].headers['idempotency-key']);
    });

    // Changed with FIXAE-1: this test pinned "a device without a token is not registered". The registration is also what gives the offline command
    // queue its device id (FlushBlocker.noDevice), so a device without push (a build without Firebase, a refused permission) registers without a token.
    test('a device without a token is registered without one, with the permission it reports, and its id reaches the offline store; a refusal is reported and keeps nothing', () async {
      final List<String> told = <String>[];
      final ScriptedServer server = ScriptedServer()..on('POST', '/devices', (_) => _registered(serverDeviceId), status: 201);
      PushRegistration make(PushPlatform platform) => PushRegistration(client: _client(server), platform: platform, language: () => 'en', onRegistered: (String id) async => told.add(id));
      expect(await make(FakePush(state: PushPermission.denied)).sync(), RegistrationResult.registeredWithoutPush);
      expect(await make(FakePush(currentToken: '')).sync(), RegistrationResult.registeredWithoutPush);
      expect(await make(NoPushPlatform(info: () async => const AppInfo(version: '1.4.0', build: '27', platform: 'android', osVersion: '14'))).sync(), RegistrationResult.registeredWithoutPush);
      await Future<void>.delayed(Duration.zero);
      final List<Map<String, Object?>> bodies = <Map<String, Object?>>[for (final HttpCall call in server.callsTo('POST', '/devices')) jsonDecode(call.body!) as Map<String, Object?>];
      expect(bodies, hasLength(3));
      for (final Map<String, Object?> body in bodies) {
        expect(body.containsKey('push_token'), isFalse, reason: 'no token is sent, not even an empty one');
        expect(body['device_public_id'], matches(RegExp(r'^[A-Za-z0-9._:-]{16,128}$')));
        expect(body['locale'], 'en');
      }
      expect(<Object?>[bodies[0]['permission_state'], bodies[1]['permission_state'], bodies[2]['permission_state']], <String>['denied', 'granted', 'unavailable']);
      expect(told, <String>[serverDeviceId, serverDeviceId, serverDeviceId]);

      server.refuse('POST', '/devices', 403, 'SCOPE_DENIED');
      expect(await _registration(server, FakePush(currentToken: 't')).sync(), RegistrationResult.refused);
    });

    test('a device without a token that gets one later registers again with the same installation and the token, and an adapter that fails registers nothing', () async {
      final ScriptedServer server = ScriptedServer()..on('POST', '/devices', (_) => _registered(serverDeviceId), status: 201);
      final FakePush push = FakePush(state: PushPermission.unavailable);
      final PushRegistration registration = _registration(server, push);
      expect(await registration.sync(), RegistrationResult.registeredWithoutPush);
      push
        ..currentToken = 'token-later'
        ..state = PushPermission.granted;
      expect(await registration.sync(), RegistrationResult.registered);
      push
        ..currentToken = 'token-claims-no-provider'
        ..state = PushPermission.unavailable;
      expect(await registration.sync(), RegistrationResult.registered);
      final List<Map<String, Object?>> bodies = <Map<String, Object?>>[for (final HttpCall call in server.callsTo('POST', '/devices')) jsonDecode(call.body!) as Map<String, Object?>];
      expect(bodies[0].containsKey('push_token'), isFalse);
      expect(bodies[1], containsPair('push_token', 'token-later'));
      expect(bodies[0]['device_public_id'], bodies[1]['device_public_id']);
      expect(bodies[2]['permission_state'], 'unknown', reason: 'a device that holds a token does not say that it has no provider');

      final ScriptedServer quiet = ScriptedServer();
      expect(await PushRegistration(client: _client(quiet), platform: _FailingPush(), language: () => 'vi').sync(), RegistrationResult.refused);
      expect(quiet.calls, isEmpty);
    });

    test('a denied permission is registered as such, so the server knows the device will not show a push', () async {
      final ScriptedServer server = ScriptedServer()..on('POST', '/devices', (_) => _registered(serverDeviceId), status: 201);
      await _registration(server, FakePush(currentToken: 't', state: PushPermission.provisional)).sync();
      expect((jsonDecode(server.callsTo('POST', '/devices').single.body!) as Map<String, Object?>)['permission_state'], 'provisional');
    });

    test('sign-out revokes the registration of this device: by the id the server gave, or found among the devices by the installation', () async {
      final ScriptedServer known = ScriptedServer()
        ..on('POST', '/devices', (_) => _registered(serverDeviceId), status: 201)
        ..on('POST', '/me/devices/:id/revoke', (_) => <String, Object?>{'operation_id': 'o', 'status': 'REVOKED', 'resource_version': 2});
      final PushRegistration registration = _registration(known, FakePush(currentToken: 't'));
      await registration.sync();
      expect(await registration.revoke(), isTrue);
      final HttpCall revoke = known.callsTo('POST', '/me/devices/$serverDeviceId/revoke').single;
      expect(jsonDecode(revoke.body!), containsPair('reason', signOutReason));
      expect(registration.serverDeviceId, isNull);

      final ScriptedServer found = ScriptedServer()
        ..on(
          'GET',
          '/me/devices',
          (_) => <String, Object?>{
            'items': <Object?>[
              <String, Object?>{'id': serverDeviceId, 'device_public_id': 'dev-abc-installation-0001', 'status': 'ACTIVE'},
              // After the live one: the lookup must skip it by its status, not by coming first.
              <String, Object?>{'id': 'old', 'device_public_id': 'dev-abc-installation-0001', 'status': 'REVOKED'},
              <String, Object?>{'id': 'other', 'device_public_id': 'someone-elses-phone-0000', 'status': 'ACTIVE'},
            ],
          },
        )
        ..on('POST', '/me/devices/:id/revoke', (_) => <String, Object?>{'operation_id': 'o', 'status': 'REVOKED', 'resource_version': 2});
      expect(await _registration(found, FakePush()).revoke(), isTrue);
      expect(found.callsTo('POST', '/me/devices/$serverDeviceId/revoke'), hasLength(1));
    });

    test('a revocation that finds no registration, or that the server refuses, is reported as not done', () async {
      final ScriptedServer none = ScriptedServer()..on('GET', '/me/devices', (_) => <String, Object?>{'items': <Object?>[]});
      expect(await _registration(none, FakePush()).revoke(), isFalse);

      final ScriptedServer refused = ScriptedServer()
        ..on('GET', '/me/devices', (_) => <String, Object?>{'items': <Object?>[<String, Object?>{'id': serverDeviceId, 'device_public_id': 'dev-abc-installation-0001', 'status': 'ACTIVE'}]})
        ..refuse('POST', '/me/devices/:id/revoke', 403, 'SCOPE_DENIED');
      expect(await _registration(refused, FakePush()).revoke(), isFalse);
    });
  });

  group('the device adapter of push is not plugged in: the defaults are a clear no-op', () {
    // A build without MACHVON_PUSH=fcm (and the four MACHVON_FCM_* options) selects the null adapter: no push token and no arrival
    // stream. The device adapter is selected by the configuration (push_adapter_test.dart); nothing above these two ports changes.
    test('pushArrivalsProvider emits nothing and ends at once, and pushPlatformProvider gives no token, no permission and no refresh', () async {
      final ProviderContainer container = ProviderContainer();
      addTearDown(container.dispose);

      final List<void> arrivals = <void>[];
      var done = false;
      container.read(pushArrivalsProvider).listen(arrivals.add, onDone: () => done = true);
      await Future<void>.delayed(Duration.zero);
      expect(arrivals, isEmpty);
      expect(done, isTrue, reason: 'the default stream is empty: it has no push to wait for and holds no resource open');

      final PushPlatform platform = container.read(pushPlatformProvider);
      expect(platform, isA<NoPushPlatform>());
      expect(await platform.token(), isNull);
      expect(await platform.permission(), PushPermission.unavailable);
      expect(await platform.tokenRefreshes.isEmpty, isTrue);
    });

    test('an override with a stream is what the listeners read: a push is delivered to each of them, and the default does not hide it', () async {
      final StreamController<void> pushes = StreamController<void>.broadcast();
      final ProviderContainer container = ProviderContainer(overrides: <Override>[pushArrivalsProvider.overrideWithValue(pushes.stream)]);
      addTearDown(() async {
        container.dispose();
        await pushes.close();
      });
      var count = 0;
      container.read(pushArrivalsProvider).listen((_) => count += 1);
      pushes.add(null);
      await Future<void>.delayed(Duration.zero);
      expect(count, 1);
    });
  });
}

/// A platform whose secure store fails (the plugin is missing, the keystore is locked): the registration gives up quietly.
final class _FailingPush implements PushPlatform {
  @override
  String get platform => 'android';

  @override
  String get appVersion => '1.4.0';

  @override
  Future<String> installId() async => throw StateError('keystore locked');

  @override
  Future<PushPermission> permission() async => PushPermission.unknown;

  @override
  Future<String?> token() async => null;

  @override
  Stream<String> get tokenRefreshes => const Stream<String>.empty();

  @override
  Future<void> forgetToken() async {}
}
