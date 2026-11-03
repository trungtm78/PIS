import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/app/app_config.dart';
import 'package:machvon_mobile/core/di/providers.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/offline/store/local_store.dart';
import 'package:machvon_mobile/core/offline/sync/sync_coordinator.dart';
import 'package:machvon_mobile/core/offline/sync/sync_engine.dart';
import 'package:machvon_mobile/core/offline/sync/sync_token.dart';
import 'package:machvon_mobile/core/session/session.dart';

import '../../support/harness.dart';
import '../../support/offline_support.dart';

const String tenantA = 'tenant-a';
const String membership = '00000000-0000-4000-8000-0000000000f1';

/// A compact JWT with the claims given (the signature is not checked by the phone, the service does it).
String jwt({String tenant = tenantA, String audience = 'powersync', int scopeVersion = 7, int lifetime = 300, Object? issuedAt, bool malformed = false}) {
  String part(Object value) => base64Url.encode(utf8.encode(jsonEncode(value))).replaceAll('=', '');
  final int iat = (issuedAt as int?) ?? 1793600000;
  return '${part(<String, Object?>{'alg': 'ES256', 'typ': 'JWT'})}.${malformed ? 'not-json' : part(<String, Object?>{'aud': audience, 'sub': membership, 'tenant_id': tenant, 'membership_id': membership, 'scope_version': scopeVersion, 'iat': iat, 'exp': iat + lifetime})}.c2ln';
}

class FakeEngine implements SyncEngine {
  final StreamController<SyncEngineEvent> controller = StreamController<SyncEngineEvent>.broadcast(sync: true);
  Future<SyncCredentials> Function()? credentials;
  int connects = 0;
  int clears = 0;
  bool hasRows = true;

  @override
  Future<void> connect(Future<SyncCredentials> Function() credentials) async {
    connects += 1;
    this.credentials = credentials;
  }

  @override
  Future<void> disconnectAndClear() async {
    clears += 1;
    hasRows = false;
  }

  @override
  Stream<SyncEngineEvent> get events => controller.stream;
}

class FakeSource implements SyncCredentialSource {
  FakeSource(this.next);

  Future<SyncCredentials> Function() next;

  @override
  Future<SyncCredentials> fetch() => next();
}

SyncCredentials credentialsOf(String token) => SyncCredentials(endpoint: Uri.parse('https://sync.test'), token: token);

class Rig {
  Rig(this.storage, this.store, this.engine, this.source, this.coordinator, this.revoked);

  final TestStorage storage;
  final LocalStore store;
  final FakeEngine engine;
  final FakeSource source;
  final SyncCoordinator coordinator;
  final List<int> revoked;
}

Future<Rig> rig({TestStorage? storage, FakeEngine? engine, String? token}) async {
  final TestStorage test = storage ?? TestStorage.create();
  final LocalStore store = await test.open();
  final FakeEngine fake = engine ?? FakeEngine();
  final FakeSource source = FakeSource(() async => credentialsOf(token ?? jwt()));
  final List<int> revoked = <int>[];
  final SyncCoordinator coordinator = SyncCoordinator(store: store, engine: fake, source: source, onRevoked: () async => revoked.add(1));
  addTearDown(coordinator.dispose);
  return Rig(test, store, fake, source, coordinator, revoked);
}

Future<void> settle() => pumpEventQueue();

void main() {
  group('AC-ST-MOB-007-2 UAT-AC501 a membership revoked while the device was offline empties the device at the next sync', () {
    test('the first checkpoint after the reconnection has no buckets: the rows are deleted, the sync stops, and the person is sent to sign in', () async {
      final Rig r = await rig();
      await r.coordinator.start();
      r.engine.controller.add(SyncCheckpoint(serverTime: DateTime.utc(2026, 11, 3, 8), bucketCount: 3));
      await settle();
      expect(r.coordinator.phase, SyncPhase.running);
      expect(r.engine.clears, 0);

      // the device is offline while the membership is revoked; it comes back and the first answer is empty
      r.engine.controller.add(SyncCheckpoint(serverTime: DateTime.utc(2026, 11, 3, 9), bucketCount: 0));
      await settle();
      expect(r.engine.clears, 1, reason: 'the local project data is deleted');
      expect(r.engine.hasRows, isFalse);
      expect(r.coordinator.phase, SyncPhase.revoked);
      expect(r.revoked, hasLength(1), reason: 'the application is told once, to send the person to sign-in');
      expect(r.store.dataAsOf, DateTime.utc(2026, 11, 3, 8), reason: 'the empty checkpoint does not make the old rows look fresh');
    });

    test('the memory of having had buckets survives a restart: a device killed before the empty answer still empties', () async {
      final Rig first = await rig();
      await first.coordinator.start();
      first.engine.controller.add(SyncCheckpoint(serverTime: DateTime.utc(2026, 11, 3, 8), bucketCount: 2));
      await settle();
      await first.coordinator.stop();

      final Rig second = await rig(storage: first.storage);
      await second.coordinator.start();
      second.engine.controller.add(SyncCheckpoint(serverTime: DateTime.utc(2026, 11, 3, 9), bucketCount: 0));
      await settle();
      expect(second.engine.clears, 1);
      expect(second.revoked, hasLength(1));
    });

    test('a person who never had a scope is not "revoked": an empty first checkpoint changes nothing', () async {
      final Rig r = await rig();
      await r.coordinator.start();
      r.engine.controller.add(SyncCheckpoint(serverTime: DateTime.utc(2026, 11, 3, 8), bucketCount: 0));
      await settle();
      expect(r.engine.clears, 0);
      expect(r.coordinator.phase, SyncPhase.running);
      expect(r.store.dataAsOf, DateTime.utc(2026, 11, 3, 8));
    });

    test('the service refusing the connection with 403 is a revocation; 401 (a stale token) is not, it only asks for a new token', () async {
      final Rig stale = await rig();
      await stale.coordinator.start();
      stale.engine.controller.add(const SyncAuthFailed(status: 401, code: 'TOKEN_EXPIRED'));
      await settle();
      expect(stale.engine.clears, 0);
      expect(stale.coordinator.phase, SyncPhase.running);

      final Rig gone = await rig();
      await gone.coordinator.start();
      gone.engine.controller.add(const SyncAuthFailed(status: 403, code: 'SCOPE_DENIED'));
      gone.engine.controller.add(const SyncAuthFailed(status: 403, code: 'SCOPE_DENIED'));
      await settle();
      expect(gone.engine.clears, 1, reason: 'once, however many events say so');
      expect(gone.revoked, hasLength(1));
      expect(gone.coordinator.phase, SyncPhase.revoked);
    });

    test('when the backend refuses to issue a token because the membership is gone (403), the device is emptied; a server failure is not a revocation', () async {
      final Rig r = await rig();
      await r.coordinator.start();
      r.source.next = () async => throw const ApiError(status: 500, code: 'INTERNAL_ERROR', correlationId: 'c');
      await expectLater(r.engine.credentials!(), throwsA(isA<ApiError>()));
      expect(r.engine.clears, 0);
      r.source.next = () async => throw const ApiError(status: 403, code: 'SCOPE_DENIED', correlationId: 'c');
      await expectLater(r.engine.credentials!(), throwsA(isA<ApiError>()));
      expect(r.engine.clears, 1);
      expect(r.revoked, hasLength(1));
    });

    test('purging on revocation removes the encrypted store of the person, and raises the flag the session story watches', () async {
      final TestStorage storage = TestStorage.create();
      final FakeEngine engine = FakeEngine();
      final FakeSource source = FakeSource(() async => credentialsOf(jwt()));
      final ProviderContainer container = ProviderContainer(overrides: <Override>[
        appConfigProvider.overrideWithValue(AppConfig.parse('https://api.test/v1', allowInsecureLoopback: false)),
        sessionProvider.overrideWith(() => FakeSession()),
        offlineStorageProvider.overrideWithValue(storage.storage),
        syncEngineProvider.overrideWithValue(engine),
        syncCredentialSourceProvider.overrideWithValue(source),
      ]);
      addTearDown(container.dispose);
      final LocalStore store = await container.read(localStoreProvider.future);
      final SyncCoordinator? coordinator = await container.read(syncCoordinatorProvider.future);
      expect(coordinator, isNotNull);
      expect(engine.connects, 1);
      expect(container.read(scopeRevocationProvider), isFalse);
      engine.controller.add(SyncCheckpoint(serverTime: DateTime.utc(2026, 11, 3, 8), bucketCount: 1));
      await settle();
      engine.controller.add(SyncCheckpoint(serverTime: DateTime.utc(2026, 11, 3, 9), bucketCount: 0));
      await settle();
      expect(container.read(scopeRevocationProvider), isTrue);
      expect(store.isClosed, isTrue);
      expect(storage.keys.keys, isEmpty);
      container.read(scopeRevocationProvider.notifier).acknowledge();
      expect(container.read(scopeRevocationProvider), isFalse);
    });

    test('without an engine or a token source nothing is started: sync is simply not configured', () async {
      final ProviderContainer container = ProviderContainer(overrides: <Override>[
        appConfigProvider.overrideWithValue(AppConfig.parse('https://api.test/v1', allowInsecureLoopback: false)),
        sessionProvider.overrideWith(() => FakeSession()),
        offlineStorageProvider.overrideWithValue(TestStorage.create().storage),
      ]);
      addTearDown(container.dispose);
      expect(await container.read(syncCoordinatorProvider.future), isNull);
    });
  });

  group('AC-ST-MOB-007-3 UAT-NFR-TENANCY-07 the phone hands over only a token for its tenant, and no parameter at all', () {
    test('the engine gets the endpoint and the token of the backend and nothing else; the tenant is not a parameter of the connection', () async {
      final String token = jwt();
      final Rig r = await rig(token: token);
      await r.coordinator.start();
      final SyncCredentials credentials = await r.engine.credentials!();
      expect(credentials.token, token);
      expect(credentials.endpoint, Uri.parse('https://sync.test'));
      expect(r.engine.connects, 1);
    });

    test('a token for another tenant is refused before it leaves the phone (a forged or mixed-up token)', () async {
      final Rig r = await rig(token: jwt(tenant: 'tenant-b'));
      await r.coordinator.start();
      await expectLater(r.engine.credentials!(), throwsA(isA<SyncTokenRefused>().having((SyncTokenRefused e) => e.reason, 'reason', 'TENANT')));
    });

    test('a token that lives longer than five minutes, one that is already over, a foreign audience and a damaged token are refused', () async {
      Future<String> reasonOf(String token) async {
        final Rig r = await rig(token: token);
        await r.coordinator.start();
        try {
          await r.engine.credentials!();
        } on SyncTokenRefused catch (refused) {
          return refused.reason;
        }
        return 'accepted';
      }

      expect(await reasonOf(jwt(lifetime: 300)), 'accepted');
      expect(await reasonOf(jwt(lifetime: 301)), 'LIFETIME');
      expect(await reasonOf(jwt(lifetime: 3600)), 'LIFETIME');
      expect(await reasonOf(jwt(lifetime: 0)), 'LIFETIME');
      expect(await reasonOf(jwt(lifetime: -5)), 'LIFETIME');
      expect(await reasonOf(jwt(audience: 'machvon-api')), 'AUDIENCE');
      expect(await reasonOf(jwt(malformed: true)), 'MALFORMED');
      expect(await reasonOf('only.two'), 'MALFORMED');
      expect(await reasonOf('a..c'), 'MALFORMED');
      expect(await reasonOf('a.${base64Url.encode(utf8.encode('[1]'))}.c'), 'MALFORMED');
      expect(await reasonOf('a.${base64Url.encode(utf8.encode('{"aud":"powersync","tenant_id":1}'))}.c'), 'MALFORMED');
    });

    test('a token with an older scope version than one already used is a replay and is refused; the same or a newer one is taken and remembered', () async {
      final Rig r = await rig();
      await r.coordinator.start();
      r.source.next = () async => credentialsOf(jwt(scopeVersion: 8));
      await r.engine.credentials!();
      expect(r.store.meta(kSyncScopeVersionMeta), '8');
      r.source.next = () async => credentialsOf(jwt(scopeVersion: 7));
      await expectLater(r.engine.credentials!(), throwsA(isA<SyncTokenRefused>().having((SyncTokenRefused e) => e.reason, 'reason', 'SCOPE_VERSION_REPLAY')));
      expect(r.store.meta(kSyncScopeVersionMeta), '8');
      r.source.next = () async => credentialsOf(jwt(scopeVersion: 8));
      await r.engine.credentials!();
      r.source.next = () async => credentialsOf(jwt(scopeVersion: 9));
      await r.engine.credentials!();
      expect(r.store.meta(kSyncScopeVersionMeta), '9');
    });

    test('the claims are read as the backend writes them', () {
      final SyncTokenClaims claims = SyncTokenClaims.parse(jwt(scopeVersion: 4));
      expect(claims.tenantId, tenantA);
      expect(claims.membershipId, membership);
      expect(claims.scopeVersion, 4);
      expect(claims.lifetimeSeconds, 300);
      expect(const SyncTokenRefused('X').toString(), 'SyncTokenRefused(X)');
    });
  });

  group('AC-ST-MOB-007-1 UAT-AC500 the time shown for the data is the time of the server', () {
    test('the as_of of the device is the time of the last checkpoint the server gave; it is stored in the encrypted store', () async {
      final Rig r = await rig();
      expect(r.store.dataAsOf, isNull);
      await r.coordinator.start();
      r.engine.controller.add(SyncCheckpoint(serverTime: DateTime.utc(2026, 11, 3, 8, 30), bucketCount: 2));
      await settle();
      expect(r.store.dataAsOf, DateTime.utc(2026, 11, 3, 8, 30));
      r.engine.controller.add(SyncCheckpoint(serverTime: DateTime.utc(2026, 11, 3, 8, 45), bucketCount: 2));
      await settle();
      expect(r.store.dataAsOf, DateTime.utc(2026, 11, 3, 8, 45));
    });

    test('starting twice connects once, and stopping stops listening', () async {
      final Rig r = await rig();
      await r.coordinator.start();
      await r.coordinator.start();
      expect(r.engine.connects, 1);
      final List<SyncPhase> phases = <SyncPhase>[];
      final StreamSubscription<SyncPhase> sub = r.coordinator.phases.listen(phases.add);
      await r.coordinator.stop();
      r.engine.controller.add(SyncCheckpoint(serverTime: DateTime.utc(2026, 11, 3, 10), bucketCount: 1));
      await settle();
      await sub.cancel();
      expect(r.coordinator.phase, SyncPhase.stopped);
      expect(phases, <SyncPhase>[SyncPhase.stopped]);
      expect(r.store.dataAsOf, isNull, reason: 'a stopped coordinator ignores the engine');
    });
  });
}
