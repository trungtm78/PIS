import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/features/notification_inbox/push_registration.dart';

import '../../support/harness.dart' show FakeTransport;
import '../support/scripted_server.dart';
import 'notification_fixtures.dart';

MachvonApiClient _client(ScriptedServer server) => MachvonApiClient(baseUrl: Uri.parse('https://api.test/v1'), transport: server, token: () async => 'token');

PushRegistration _registration(ScriptedServer server, FakePush push) => PushRegistration(client: _client(server), platform: push, language: () => 'vi');

Map<String, Object?> _registered(String id) => <String, Object?>{'operation_id': 'o', 'status': 'REGISTERED', 'resource_version': 1, 'resource_id': id};

const String serverDeviceId = '3f2b6c1e-0000-4000-8000-0000000000d1';

void main() {
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

    test('a device without a token is not registered and nothing is sent; a refusal is reported and keeps nothing', () async {
      final ScriptedServer server = ScriptedServer();
      expect(await _registration(server, FakePush()).sync(), RegistrationResult.noToken);
      expect(await _registration(server, FakePush(currentToken: '')).sync(), RegistrationResult.noToken);
      expect(await PushRegistration(client: _client(server), platform: const NoPushPlatform(), language: () => 'en').sync(), RegistrationResult.noToken);
      expect(server.calls, isEmpty);

      server.refuse('POST', '/devices', 403, 'SCOPE_DENIED');
      expect(await _registration(server, FakePush(currentToken: 't')).sync(), RegistrationResult.refused);
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
      expect(await platform.permission(), PushPermission.unknown);
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
