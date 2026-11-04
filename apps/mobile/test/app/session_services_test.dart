import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/di/providers.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/offline/queue/queued_command.dart';
import 'package:machvon_mobile/core/offline/store/local_store.dart';
import 'package:machvon_mobile/core/offline/sync/sync_engine.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/core/sync/sync_status.dart';
import 'package:machvon_mobile/features/session/auth/pending_work.dart';
import 'package:machvon_mobile/features/session/session_providers.dart';

import '../core/offline/sync_coordinator_test.dart' show FakeEngine, FakeSource, credentialsOf, jwt;
import '../features/session/support/app.dart';
import '../features/session/support/world.dart';
import '../support/fake_sync_server.dart';
import '../support/harness.dart';
import '../support/offline_support.dart';

const String _user = 'sub-ana';
const String _key = 'c0000000-0000-4000-8000-000000000001';

/// The API of the session fake for everything but the sync endpoints, which the fake sync server answers.
class _Split implements HttpTransport {
  _Split(this.world, this.sync);

  final World world;
  final FakeSyncServer sync;

  @override
  Future<HttpResult> send(HttpCall call) => call.url.path.contains('/sync/') ? sync.send(call) : world.transport.send(call);
}

QueuedCommand _queued(String key) => QueuedCommand(
      id: 'row-${key.substring(30)}-00000000000000',
      tenantId: 'tenant-a',
      userId: _user,
      commandType: 'report.submit',
      payload: const <String, Object?>{'report_id': '5b3c0e7a-0a56-4c0e-8c33-0f2f6b7f1a01'},
      payloadBytes: 40,
      baseServerVersion: 3,
      idempotencyKey: key,
      state: CommandState.queued,
      createdAt: 1,
      updatedAt: 1,
    );

void main() {
  late World world;
  late TestStorage storage;
  late FakeSyncServer server;

  /// A person who signed in earlier and whose phone was killed with a command waiting in the store.
  Future<LocalStore> phoneWithQueuedCommand() async {
    storage = TestStorage.create();
    server = FakeSyncServer();
    world = World();
    world.extraPurgers.add(OfflineStoragePurger(storage.storage));
    await world.service().signIn(kOidcConfig);
    final LocalStore store = await storage.open(tenantId: 'tenant-a', userId: _user);
    store.deviceId = '11111111-1111-4111-8111-111111111111';
    store.commands.insert(_queued(_key));
    return store;
  }

  List<Override> overrides({List<Override> more = const <Override>[]}) => <Override>[
        offlineStorageProvider.overrideWithValue(storage.storage),
        apiTransportProvider.overrideWithValue(_Split(world, server)),
        ...more,
      ];

  Future<void> settle(WidgetTester tester) async {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 200)));
    await tester.pumpAndSettle();
  }

  group('AC-ST-MOB-040-3 UAT-AC502 SYNC-01 the queue, the uploads and the banner run for as long as a person is signed in', () {
    testWidgets('a command queued before the phone was killed is sent when the application starts, with no screen asking for the runner', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final LocalStore store = await phoneWithQueuedCommand();
      final ProviderContainer container = await pumpSessionApp(tester, world, overrides: overrides());
      await settle(tester);

      expect(server.batchPosts, 1, reason: 'the runner started by itself and flushed');
      expect(store.commands.byKey(_key)!.state, CommandState.accepted);
      expect(container.exists(queueRunnerProvider), isTrue);
      expect(container.exists(uploadRunnerProvider), isTrue);
      expect(container.exists(syncStatusPublisherProvider), isTrue);
    });

    testWidgets('the banner counts what the queue holds: a command waiting for the network is one pending change', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      await phoneWithQueuedCommand();
      server.offline = true;
      final ProviderContainer container = await pumpSessionApp(tester, world, overrides: overrides());
      await settle(tester);

      expect(container.read(syncStatusProvider), const SyncStatus(pendingCommands: 1));
    });

    testWidgets('nobody signed in starts nothing: the work of nobody is not opened', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      storage = TestStorage.create();
      server = FakeSyncServer();
      world = World();
      final ProviderContainer container = await pumpSessionApp(tester, world, overrides: overrides());
      expect(container.read(sessionProvider).status, SessionStatus.signedOut);
      expect(container.exists(queueRunnerProvider), isFalse);
      expect(container.exists(uploadRunnerProvider), isFalse);
      expect(container.exists(syncStatusPublisherProvider), isFalse);
      expect(container.exists(syncCoordinatorProvider), isFalse);
      expect(storage.directory.listSync(), isEmpty);
    });
  });

  group('AC-ST-MOB-041-3 UAT-AC501 SEC-01 a scope the server revoked signs the person out after the local store was deleted', () {
    testWidgets('the coordinator runs while signed in; an empty checkpoint after a full one deletes the store and its key, and the person is signed out', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final LocalStore store = await phoneWithQueuedCommand();
      final FakeEngine engine = FakeEngine();
      final FakeSource source = FakeSource(() async => credentialsOf(jwt(tenant: 'tenant-a')));
      final ProviderContainer container = await pumpSessionApp(
        tester,
        world,
        overrides: overrides(more: <Override>[
          syncEngineProvider.overrideWithValue(engine),
          syncCredentialSourceProvider.overrideWithValue(source),
        ]),
      );
      await settle(tester);
      expect(container.exists(syncCoordinatorProvider), isTrue);
      expect(engine.connects, 1);
      expect(container.read(sessionProvider).status, SessionStatus.signedIn);

      engine.controller.add(SyncCheckpoint(serverTime: DateTime.utc(2026, 11, 3, 8), bucketCount: 2));
      engine.controller.add(SyncCheckpoint(serverTime: DateTime.utc(2026, 11, 3, 9), bucketCount: 0));
      await settle(tester);

      expect(store.isClosed, isTrue);
      expect(storage.directory.listSync().where((FileSystemEntity e) => e.uri.pathSegments.last.startsWith('machvon-')), isEmpty);
      expect(storage.keys.keys, isEmpty);
      expect(container.read(sessionProvider).status, SessionStatus.signedOut, reason: 'the guard sends the person to sign-in');
      expect(container.read(scopeRevocationProvider), isFalse, reason: 'the flag is taken once');
      expect(world.store.data.containsKey('session.v1'), isFalse);
    });

    testWidgets('the coordinator deletes the store the queue is cached on, and the sign-out that follows still clears the credentials', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final LocalStore store = await phoneWithQueuedCommand();
      final FakeEngine engine = FakeEngine();
      final FakeSource source = FakeSource(() async => credentialsOf(jwt(tenant: 'tenant-a')));
      final ProviderContainer container = await pumpSessionApp(
        tester,
        world,
        overrides: overrides(more: <Override>[
          syncEngineProvider.overrideWithValue(engine),
          syncCredentialSourceProvider.overrideWithValue(source),
        ]),
      );
      // The service reads the real queue of the signed-in user, as the application wires it.
      world.countPending = () => container.read(pendingWorkProvider).count();
      world.onDiscard = () => container.read(pendingWorkProvider).discardUnsent();
      await settle(tester);
      await container.read(commandQueueProvider.future);

      engine.controller.add(SyncCheckpoint(serverTime: DateTime.utc(2026, 11, 3, 8), bucketCount: 2));
      engine.controller.add(SyncCheckpoint(serverTime: DateTime.utc(2026, 11, 3, 9), bucketCount: 0));
      await settle(tester);

      expect(store.isClosed, isTrue);
      expect(container.read(sessionProvider).status, SessionStatus.signedOut, reason: 'the closed queue must not keep the person signed in');
      expect(world.store.data.containsKey('session.v1'), isFalse);
    });

    testWidgets('the sign-out that follows a revocation does not wait for commands that can no longer be sent', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      await phoneWithQueuedCommand();
      world.pending = 4;
      final ProviderContainer container = await pumpSessionApp(tester, world, overrides: overrides());
      await settle(tester);
      container.read(scopeRevocationProvider.notifier).revoked();
      await settle(tester);
      expect(container.read(sessionProvider).status, SessionStatus.signedOut, reason: 'PendingCommandsBlock would have kept the person in');
      expect(container.read(authServiceProvider).snapshot.status, SessionStatus.signedOut);
    });
  });
}
