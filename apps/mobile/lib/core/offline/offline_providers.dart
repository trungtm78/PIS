import 'dart:async';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

import '../../features/release/telemetry.dart';
import '../connectivity/reachability.dart';
import '../di/providers.dart';
import '../navigation/feature.dart';
import '../session/session.dart';
import '../sync/sync_status.dart';
import 'attachments/attachment_upload.dart';
import 'attachments/attachment_uploader.dart';
import 'attachments/chunk_transport.dart';
import 'attachments/image_compressor.dart';
import 'attachments/upload_runner.dart';
import 'drafts/conflict_adapter.dart';
import 'drafts/draft_store.dart';
import 'offline_probe_policy.dart';
import 'queue/command_queue.dart';
import 'queue/queue_runner.dart';
import 'queue/queued_command.dart';
import 'store/database_key.dart';
import 'store/local_store.dart';
import 'sync/sync_coordinator.dart';
import 'sync/sync_engine.dart';

/// Nobody is signed in, so there is no local store to open: the work of a person goes into the store of that person only.
final class OfflineUnavailable implements Exception {
  const OfflineUnavailable();

  @override
  String toString() => 'OfflineUnavailable';
}

/// A failure to open the store or the queue is shown by the screen with a retry button; Riverpod's own automatic retry would only
/// repeat `OfflineUnavailable` (nobody is signed in) and a store that cannot be opened.
Duration? _noRetry(int retryCount, Object error) => null;

/// The Keychain / Keystore. Tests override it with a key store in memory.
final Provider<DatabaseKeyStore> databaseKeyStoreProvider = Provider<DatabaseKeyStore>((Ref ref) => SecureDatabaseKeyStore());

/// The directory the encrypted databases live in: private to the application, not backed up by the platform.
final Provider<Future<Directory> Function()> offlineDirectoryProvider = Provider<Future<Directory> Function()>(
  (Ref ref) => () async => Directory(p.join((await getApplicationSupportDirectory()).path, 'offline')),
);

/// Opens, finds and destroys the local stores. Signing out of a tenant or switching tenant calls `purge` on it (after the
/// queue says nothing is left to send, see [CommandQueue.unsentCount]).
final Provider<OfflineStorage> offlineStorageProvider = Provider<OfflineStorage>(
  (Ref ref) => OfflineStorage(directory: ref.watch(offlineDirectoryProvider), keys: ref.watch(databaseKeyStoreProvider)),
);

/// The user and tenant the local store belongs to, or null when nobody is signed in. A lapsed session keeps its scope: the
/// drafts stay on the device and are locked by the session, not removed (design doc 07, security and the life cycle of a release).
final Provider<({String tenantId, String userId})?> offlineScopeProvider = Provider<({String tenantId, String userId})?>((Ref ref) {
  final SessionSnapshot session = ref.watch(sessionProvider);
  final String? tenantId = session.tenantId;
  final String? userId = session.userId;
  if (session.status == SessionStatus.signedOut || tenantId == null || userId == null) return null;
  return (tenantId: tenantId, userId: userId);
});

/// The encrypted store of the signed-in user, opened once for the life of the session.
final FutureProvider<LocalStore> localStoreProvider = FutureProvider<LocalStore>(retry: _noRetry, (Ref ref) async {
  final ({String tenantId, String userId})? scope = ref.watch(offlineScopeProvider);
  if (scope == null) throw const OfflineUnavailable();
  return ref.watch(offlineStorageProvider).open(tenantId: scope.tenantId, userId: scope.userId);
});

/// The offline command queue of the signed-in user (see [CommandQueue]). Use it as
/// `final queue = await ref.read(commandQueueProvider.future);`. It is rebuilt when the tenant or the user changes, so a
/// command made under one tenant is never sent by the queue of another. It sends through the client of the tenant of its store
/// ([tenantApiClientProvider]), so a switch in the middle of a flush cannot make it carry the token of the other tenant.
final FutureProvider<CommandQueue> commandQueueProvider = FutureProvider<CommandQueue>(retry: _noRetry, (Ref ref) async {
  final LocalStore store = await ref.watch(localStoreProvider.future);
  final CommandQueue queue = CommandQueue(
    store: store,
    client: ref.watch(tenantApiClientProvider(store.tenantId)),
    session: () => ref.read(sessionProvider),
    deviceId: () async => store.deviceId,
    onRoundTrip: ref.read(telemetryProvider).recordCommandRoundTrip,
  );
  queue.recoverInterrupted();
  ref.onDispose(queue.dispose);
  return queue;
});

/// The queue as a stream, for the screens: every command, oldest first, and a new list after every change.
final StreamProvider<List<QueuedCommand>> queuedCommandsProvider = StreamProvider<List<QueuedCommand>>(retry: _noRetry, (Ref ref) async* {
  final CommandQueue queue = await ref.watch(commandQueueProvider.future);
  yield* queue.watch();
});

/// The drafts of the signed-in user.
final FutureProvider<DraftStore> draftStoreProvider = FutureProvider<DraftStore>(retry: _noRetry, (Ref ref) async => DraftStore(await ref.watch(localStoreProvider.future)));

/// The adapters that find the server's copy of a record in conflict: the standard ones of the weekly report, and the ones each feature
/// declares for the commands it queues (`MobileFeature.conflictAdapters`).
final Provider<ConflictAdapters> conflictAdaptersProvider = Provider<ConflictAdapters>((Ref ref) {
  final ConflictAdapters adapters = ConflictAdapters.standard();
  for (final MobileFeature feature in ref.watch(featuresProvider)) {
    feature.conflictAdapters.forEach(adapters.register);
  }
  return adapters;
});

/// How the runners probe a connection that was lost (see [OfflineProbePolicy]). No probe until the application root installs one
/// (`productionOverrides` installs [OfflineProbePolicy.standard]), so a screen test that goes offline leaves no timer behind.
final Provider<OfflineProbePolicy> offlineProbePolicyProvider = Provider<OfflineProbePolicy>((Ref ref) => OfflineProbePolicy.none);

/// The runner that keeps the queue moving: it sends when the application is signed in, when the device comes back online
/// and when a wait ends. Watch it once at the root of the signed-in application.
final FutureProvider<QueueRunner> queueRunnerProvider = FutureProvider<QueueRunner>(retry: _noRetry, (Ref ref) async {
  final CommandQueue queue = await ref.watch(commandQueueProvider.future);
  final OfflineProbePolicy probes = ref.watch(offlineProbePolicyProvider);
  final QueueRunner runner = QueueRunner(queue, offlineProbes: probes.delays, maxOfflineProbes: probes.maxProbes);
  ref.listen<Reachability>(reachabilityProvider, (Reachability? previous, Reachability next) {
    if (next == Reachability.online && previous != Reachability.online) runner.trigger();
  });
  ref.listen<SessionSnapshot>(sessionProvider, (SessionSnapshot? previous, SessionSnapshot next) {
    if (next.canAuthenticate && !(previous?.canAuthenticate ?? false)) runner.trigger();
  });
  ref.onDispose(runner.dispose);
  runner.start();
  return runner;
});

/// Writes what the queue holds into the sync banner of the shell (`syncStatusProvider`).
final FutureProvider<void> syncStatusPublisherProvider = FutureProvider<void>(retry: _noRetry, (Ref ref) async {
  final CommandQueue queue = await ref.watch(commandQueueProvider.future);
  final StreamSubscription<List<QueuedCommand>> subscription = queue.watch().listen((List<QueuedCommand> commands) {
    final int pending = commands.where((QueuedCommand c) => c.state.isPending).length;
    final int conflicts = commands.where((QueuedCommand c) => c.state == CommandState.conflict).length;
    ref.read(syncStatusProvider.notifier).update(SyncStatus(pendingCommands: pending, conflicts: conflicts));
  });
  ref.onDispose(subscription.cancel);
});

/// The chunk transport: `dart:io`, no bearer token (a signed link needs none). Tests override it with a fake.
final Provider<ChunkTransport> chunkTransportProvider = Provider<ChunkTransport>(
  (Ref ref) => DartIoChunkTransport(allowInsecureLoopback: ref.watch(appConfigProvider).allowInsecureLoopback),
);

/// The compressor of photos. A later story may swap in a native encoder.
final Provider<ImageCompressor> imageCompressorProvider = Provider<ImageCompressor>((Ref ref) => const PackageImageCompressor());

/// The attachments of the signed-in user, uploaded in chunks (see [AttachmentUploader]).
final FutureProvider<AttachmentUploader> attachmentUploaderProvider = FutureProvider<AttachmentUploader>(retry: _noRetry, (Ref ref) async {
  final LocalStore store = await ref.watch(localStoreProvider.future);
  final AttachmentUploader uploader = AttachmentUploader(
    store: store,
    client: ref.watch(tenantApiClientProvider(store.tenantId)),
    baseUrl: ref.watch(appConfigProvider).apiBaseUrl,
    chunks: ref.watch(chunkTransportProvider),
    session: () => ref.read(sessionProvider),
    deviceId: () async => store.deviceId,
    compressor: ref.watch(imageCompressorProvider),
  );
  uploader.recoverInterrupted();
  ref.onDispose(uploader.dispose);
  return uploader;
});

/// The uploads as a stream, for MOB-19: every upload, oldest first, and a new list after every change.
final StreamProvider<List<AttachmentUpload>> attachmentUploadsProvider = StreamProvider<List<AttachmentUpload>>(retry: _noRetry, (Ref ref) async* {
  final AttachmentUploader uploader = await ref.watch(attachmentUploaderProvider.future);
  yield* uploader.watch();
});

/// Keeps the uploads moving: it resumes them when started, when the device comes back online and when the session is signed in
/// again. Watch it once at the root of the signed-in application, beside [queueRunnerProvider].
final FutureProvider<UploadRunner> uploadRunnerProvider = FutureProvider<UploadRunner>(retry: _noRetry, (Ref ref) async {
  final AttachmentUploader uploader = await ref.watch(attachmentUploaderProvider.future);
  final OfflineProbePolicy probes = ref.watch(offlineProbePolicyProvider);
  final UploadRunner runner = UploadRunner(uploader, offlineProbes: probes.delays, maxOfflineProbes: probes.maxProbes);
  ref.listen<Reachability>(reachabilityProvider, (Reachability? previous, Reachability next) {
    if (next == Reachability.online && previous != Reachability.online) runner.trigger();
  });
  ref.listen<SessionSnapshot>(sessionProvider, (SessionSnapshot? previous, SessionSnapshot next) {
    if (next.canAuthenticate && !(previous?.canAuthenticate ?? false)) runner.trigger();
  });
  ref.onDispose(runner.dispose);
  runner.start();
  return runner;
});

/// How the application picks files: the gallery, the camera, the document picker. A story that has the native plugin (and the
/// permission screens) provides it; without one the list is shown and no file can be added from it.
typedef AttachmentPicker = Future<List<File>> Function();

final Provider<AttachmentPicker?> attachmentPickerProvider = Provider<AttachmentPicker?>((Ref ref) => null);

/// The sync service behind its port. Null until the PowerSync adapter is configured (the service must exist: spike
/// ST-KERNEL-002), and then the application does not sync rows; the queue and the uploads do not depend on it.
final Provider<SyncEngine?> syncEngineProvider = Provider<SyncEngine?>((Ref ref) => null);

/// Where the PowerSync token comes from (the backend issues it for the session). Null until the backend exposes it.
final Provider<SyncCredentialSource?> syncCredentialSourceProvider = Provider<SyncCredentialSource?>((Ref ref) => null);

/// Set when the person lost their membership or scope while the device was away and the synced rows were deleted. The session
/// story watches it and signs the person out; the guard then sends them to sign-in.
class ScopeRevocationNotifier extends Notifier<bool> {
  @override
  bool build() => false;

  void revoked() => state = true;

  void acknowledge() => state = false;
}

final NotifierProvider<ScopeRevocationNotifier, bool> scopeRevocationProvider = NotifierProvider<ScopeRevocationNotifier, bool>(ScopeRevocationNotifier.new);

/// The sync coordinator of the signed-in user, or null when sync is not configured. On a revocation it deletes the local store
/// of the user (the queue, the drafts, the uploads and the synced rows) and raises [scopeRevocationProvider].
final FutureProvider<SyncCoordinator?> syncCoordinatorProvider = FutureProvider<SyncCoordinator?>(retry: _noRetry, (Ref ref) async {
  final SyncEngine? engine = ref.watch(syncEngineProvider);
  final SyncCredentialSource? source = ref.watch(syncCredentialSourceProvider);
  if (engine == null || source == null) return null;
  final LocalStore store = await ref.watch(localStoreProvider.future);
  final OfflineStorage storage = ref.read(offlineStorageProvider);
  final SyncCoordinator coordinator = SyncCoordinator(
    store: store,
    engine: engine,
    source: source,
    onRevoked: () async {
      await storage.purge(tenantId: store.tenantId, userId: store.userId);
      ref.read(scopeRevocationProvider.notifier).revoked();
    },
  );
  ref.onDispose(coordinator.dispose);
  await coordinator.start();
  return coordinator;
});
