import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/app/app_config.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/di/providers.dart';
import 'package:machvon_mobile/core/offline/attachments/attachment_upload.dart';
import 'package:machvon_mobile/core/offline/attachments/attachment_uploader.dart';
import 'package:machvon_mobile/core/offline/attachments/upload_runner.dart';
import 'package:machvon_mobile/core/offline/offline_probe_policy.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/offline/queue/command_queue.dart';
import 'package:machvon_mobile/core/offline/queue/queue_results.dart';
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

  group('REVIEW-m1-1 the queue and the uploads send through the client of the tenant of their store', () {
    MachvonApiClient globalClient(FakeSyncServer server) => MachvonApiClient(
          baseUrl: Uri.parse('https://api.test/v1'),
          transport: server,
          token: () async => 'token-of-whoever-is-active',
        );

    test('the queue and the uploader never use the application client, whose token follows the active tenant', () async {
      final TestStorage storage = TestStorage.create();
      final FakeSyncServer server = FakeSyncServer();
      final ProviderContainer container = containerFor(
        storage: storage,
        server: server,
        overrides: <Override>[apiClientProvider.overrideWithValue(globalClient(server))],
      );
      final LocalStore store = await container.read(localStoreProvider.future);
      store.deviceId = '11111111-1111-4111-8111-111111111111';
      final CommandQueue queue = await container.read(commandQueueProvider.future);
      queue.enqueue(commandType: 'issue.create', payload: <String, Object?>{'n': 1});
      await queue.flush();
      expect(server.batches.single.headers['authorization'], 'Bearer test-token', reason: 'the token of the session for tenant-a, asked for tenant-a');
      final AttachmentUploader uploader = await container.read(attachmentUploaderProvider.future);
      final Directory folder = Directory.systemTemp.createTempSync('machvon-scope-');
      addTearDown(() => folder.deleteSync(recursive: true));
      final File pdf = File('${folder.path}/a.pdf')..writeAsBytesSync(<int>[...'%PDF-1.4 scope test'.codeUnits]);
      final AttachmentUpload added = await uploader.add(file: pdf, ownerKind: 'report');
      await uploader.run(added.id);
      final HttpCall start = server.calls.firstWhere((HttpCall c) => c.url.path.endsWith('/sync/attachments'));
      expect(start.headers['authorization'], 'Bearer test-token');
    });

    test('the client of tenant-a refuses to send once tenant-b is active', () async {
      final FakeSession session = FakeSession();
      final FakeSyncServer server = FakeSyncServer();
      final ProviderContainer container = containerFor(storage: TestStorage.create(), server: server, session: session);
      final MachvonApiClient clientOfA = container.read(tenantApiClientProvider('tenant-a'));
      await expectLater(clientOfA.execute('getMyProfile'), throwsA(isA<ApiError>()), reason: 'it reaches the server while tenant-a is active');
      final int before = server.calls.length;
      session.change(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-b', userId: 'user-1'));
      await expectLater(clientOfA.execute('getMyProfile'), throwsA(isA<TenantMismatch>()));
      expect(server.calls.length, before, reason: 'nothing left the phone under tenant-b');
    });

    test('disposing the container ends the queue and the uploader: nothing is written after it', () async {
      final TestStorage storage = TestStorage.create();
      final FakeSyncServer server = FakeSyncServer();
      final ProviderContainer container = containerFor(storage: storage, server: server);
      final LocalStore store = await container.read(localStoreProvider.future);
      store.deviceId = '11111111-1111-4111-8111-111111111111';
      final CommandQueue queue = await container.read(commandQueueProvider.future);
      final AttachmentUploader uploader = await container.read(attachmentUploaderProvider.future);
      queue.enqueue(commandType: 'issue.create', payload: <String, Object?>{'n': 1});
      container.dispose();
      expect((await queue.flush()).blocker, FlushBlocker.noSession);
      expect(server.batchPosts, 0);
      await uploader.resumeAll();
    });
  });

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

  group('TK-MOB-005-4 TK-MOB-009-4 the runners of the application probe a lost connection on their own', () {
    Future<void> signedIn(ProviderContainer container) async {
      await container.read(commandQueueProvider.future);
    }

    test('the queue runner and the upload runner are built with the probe policy of the provider: none until the application root installs one', () async {
      final TestStorage quietStorage = TestStorage.create();
      await quietStorage.open();
      final ProviderContainer quiet = containerFor(storage: quietStorage, server: FakeSyncServer());
      await signedIn(quiet);
      quiet.listen(queueRunnerProvider, (previous, next) {});
      quiet.listen(uploadRunnerProvider, (previous, next) {});
      expect((await quiet.read(queueRunnerProvider.future)).maxOfflineProbes, 0);
      expect((await quiet.read(uploadRunnerProvider.future)).maxOfflineProbes, 0);

      final TestStorage storage = TestStorage.create();
      await storage.open();
      final ProviderContainer container = containerFor(
        storage: storage,
        server: FakeSyncServer(),
        overrides: <Override>[offlineProbePolicyProvider.overrideWithValue(OfflineProbePolicy.standard)],
      );
      await signedIn(container);
      container.listen(queueRunnerProvider, (previous, next) {});
      container.listen(uploadRunnerProvider, (previous, next) {});
      final QueueRunner queue = await container.read(queueRunnerProvider.future);
      final UploadRunner uploads = await container.read(uploadRunnerProvider.future);
      expect(queue.offlineProbes, OfflineProbePolicy.standard.delays);
      expect(queue.maxOfflineProbes, OfflineProbePolicy.standard.maxProbes);
      expect(uploads.offlineProbes, OfflineProbePolicy.standard.delays);
      expect(uploads.maxOfflineProbes, OfflineProbePolicy.standard.maxProbes);
    });
  });
}
