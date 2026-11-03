import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/app/app_config.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/di/providers.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/offline/queue/command_queue.dart';
import 'package:machvon_mobile/core/offline/queue/queue_runner.dart';
import 'package:machvon_mobile/core/offline/queue/queued_command.dart';
import 'package:machvon_mobile/core/offline/store/local_store.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/core/sync/sync_status.dart';

import '../../support/fake_sync_server.dart';
import '../../support/harness.dart';
import '../../support/offline_support.dart';

ProviderContainer containerFor({required TestStorage storage, required FakeSyncServer server, FakeSession? session, List<Override> overrides = const <Override>[]}) {
  final ProviderContainer container = ProviderContainer(
    overrides: <Override>[
      appConfigProvider.overrideWithValue(AppConfig.parse('https://api.test/v1', allowInsecureLoopback: false)),
      sessionProvider.overrideWith(() => session ?? FakeSession()),
      httpTransportProvider.overrideWithValue(server),
      offlineStorageProvider.overrideWithValue(storage.storage),
      ...overrides,
    ],
  );
  addTearDown(container.dispose);
  return container;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('TK-MOB-005-4 the queue is bound to the signed-in user and tenant', () {
    test('the queue opens the store of the session, sends with the device of the store, and keeps the shell banner in step', () async {
      final TestStorage storage = TestStorage.create();
      final FakeSyncServer server = FakeSyncServer();
      final FakeSession session = FakeSession();
      final ProviderContainer container = containerFor(storage: storage, server: server, session: session);
      final LocalStore store = await container.read(localStoreProvider.future);
      expect(store.tenantId, 'tenant-a');
      expect(store.userId, 'user-1');
      store.deviceId = '11111111-1111-4111-8111-111111111111';
      final CommandQueue queue = await container.read(commandQueueProvider.future);
      container.listen(syncStatusPublisherProvider, (previous, next) {});
      await container.read(syncStatusPublisherProvider.future);
      queue.enqueue(commandType: 'issue.create', payload: <String, Object?>{'n': 1});
      await pumpEventQueue();
      expect(container.read(syncStatusProvider), const SyncStatus(pendingCommands: 1));
      await queue.flush();
      await pumpEventQueue();
      expect(container.read(syncStatusProvider).isIdle, isTrue);
      expect(server.batchPosts, 1);
      expect((await container.read(draftStoreProvider.future)).list(), isEmpty);
    });

    test('without a session there is no store and no queue: the work of nobody is kept', () async {
      final ProviderContainer container = containerFor(storage: TestStorage.create(), server: FakeSyncServer(), session: FakeSession(const SessionSnapshot.signedOut()));
      expect(container.read(offlineScopeProvider), isNull);
      await expectLater(container.read(localStoreProvider.future), throwsA(isA<OfflineUnavailable>()));
      await expectLater(container.read(commandQueueProvider.future), throwsA(isA<Object>()));
    });

    test('another tenant gets another store and another queue; the commands of the first are not in it and are never sent by it', () async {
      final TestStorage storage = TestStorage.create();
      final FakeSyncServer server = FakeSyncServer();
      final FakeSession session = FakeSession();
      final ProviderContainer container = containerFor(storage: storage, server: server, session: session);
      final LocalStore first = await container.read(localStoreProvider.future);
      first.deviceId = '11111111-1111-4111-8111-111111111111';
      final CommandQueue queueA = await container.read(commandQueueProvider.future);
      queueA.enqueue(commandType: 'issue.create', payload: <String, Object?>{'n': 1});
      expect(queueA.unsentCount, 1);

      session.change(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-b', userId: 'user-1'));
      final LocalStore second = await container.read(localStoreProvider.future);
      expect(second.tenantId, 'tenant-b');
      expect(second.path, isNot(first.path));
      second.deviceId = '22222222-2222-4222-8222-222222222222';
      final CommandQueue queueB = await container.read(commandQueueProvider.future);
      expect(queueB.commands(), isEmpty);
      await queueB.flush();
      expect(server.batchPosts, 0, reason: 'nothing of tenant-a is sent under tenant-b');
      expect(queueA.command(queueA.commands().single.id)!.state, CommandState.queued);
    });

    test('a command left sending by a killed process is unknown when the queue is opened again', () async {
      final TestStorage storage = TestStorage.create();
      final LocalStore store = await storage.open();
      store.deviceId = '11111111-1111-4111-8111-111111111111';
      final ProviderContainer first = containerFor(storage: storage, server: FakeSyncServer());
      final CommandQueue queue = await first.read(commandQueueProvider.future);
      final QueuedCommand command = queue.enqueue(commandType: 'issue.create', payload: <String, Object?>{'n': 1});
      store.commands.move(command.id, CommandState.sending, (QueuedCommand c) => c);
      first.dispose();

      final FakeSyncServer server = FakeSyncServer();
      final ProviderContainer second = containerFor(storage: storage, server: server);
      final CommandQueue reopened = await second.read(commandQueueProvider.future);
      expect(reopened.command(command.id)!.state, CommandState.unknown);
      await reopened.flush();
      expect(reopened.command(command.id)!.state, CommandState.accepted);
      expect(server.effectsOf(command.idempotencyKey), 1);
    });

    test('the runner sends when it starts, when the device comes back online and when the session is signed in again', () async {
      final TestStorage storage = TestStorage.create();
      final LocalStore store = await storage.open();
      store.deviceId = '11111111-1111-4111-8111-111111111111';
      final FakeSyncServer server = FakeSyncServer();
      final FakeSession session = FakeSession();
      final ProviderContainer container = containerFor(storage: storage, server: server, session: session);
      final CommandQueue queue = await container.read(commandQueueProvider.future);
      server.offline = true;
      queue.enqueue(commandType: 'issue.create', payload: <String, Object?>{'n': 1});
      container.listen(queueRunnerProvider, (previous, next) {});
      final QueueRunner runner = await container.read(queueRunnerProvider.future);
      await pumpEventQueue();
      expect(runner.lastResult!.blocker, isNotNull);
      server.offline = false;
      container.read(reachabilityProvider.notifier).report(Reachability.offline);
      container.read(reachabilityProvider.notifier).report(Reachability.online);
      await pumpEventQueue();
      expect(queue.commands().single.state, CommandState.accepted);

      server.offline = true;
      queue.enqueue(commandType: 'issue.create', payload: <String, Object?>{'n': 2});
      await pumpEventQueue();
      server.offline = false;
      session.change(const SessionSnapshot(status: SessionStatus.expired, tenantId: 'tenant-a', userId: 'user-1'));
      session.change(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1'));
      await pumpEventQueue();
      expect(queue.commands(states: <CommandState>{CommandState.accepted}), hasLength(2));
    });
  });
}
