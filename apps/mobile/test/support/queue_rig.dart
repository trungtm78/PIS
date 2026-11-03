import 'dart:math';

import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/offline/queue/backoff.dart';
import 'package:machvon_mobile/core/offline/queue/command_queue.dart';
import 'package:machvon_mobile/core/offline/store/local_store.dart';
import 'package:machvon_mobile/core/session/session.dart';

import 'fake_sync_server.dart';
import 'offline_support.dart';

const SessionSnapshot kSignedInA = SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1');

/// A queue on a real encrypted store in a temporary directory, talking to a [FakeSyncServer] through the real generated
/// client. The clock and the keys are deterministic.
class QueueRig {
  QueueRig._(this.storage, this.store, this.server, this.queue, this.clock, this.client);

  final TestStorage storage;
  final LocalStore store;
  final FakeSyncServer server;
  final CommandQueue queue;
  final FakeClock clock;
  final MachvonApiClient client;

  static Future<QueueRig> create({
    FakeSyncServer? server,
    SessionSnapshot session = kSignedInA,
    SessionSnapshot Function()? sessionOf,
    Future<String?> Function()? tokenOf,
    String? deviceId = '11111111-1111-4111-8111-111111111111',
    TestStorage? storage,
    FakeClock? clock,
    int keyStart = 1,
    String? storeTenantId,
    String? storeUserId,
  }) async {
    final TestStorage test = storage ?? TestStorage.create();
    final LocalStore store = await test.open(tenantId: storeTenantId ?? session.tenantId ?? 'tenant-a', userId: storeUserId ?? session.userId ?? 'user-1');
    final FakeSyncServer fake = server ?? FakeSyncServer();
    final FakeClock time = clock ?? FakeClock();
    int counter = keyStart;
    final MachvonApiClient client = MachvonApiClient(
      baseUrl: Uri.parse('https://api.test/v1'),
      transport: fake,
      token: tokenOf ?? () async => 'test-token',
      newKey: () => 'a0000000-0000-4000-8000-${(counter++).toString().padLeft(12, '0')}',
      delay: (Duration _) async {},
    );
    final CommandQueue queue = CommandQueue(
      store: store,
      client: client,
      session: sessionOf ?? () => session,
      deviceId: () async => deviceId,
      clock: time.call,
      newKey: () => 'b0000000-0000-4000-8000-${(counter++).toString().padLeft(12, '0')}',
      backoff: Backoff(random: _FixedRandom()),
    );
    return QueueRig._(test, store, fake, queue, time, client);
  }
}

/// A clock that only moves when a test says so.
class FakeClock {
  FakeClock([DateTime? start]) : _now = start ?? DateTime.utc(2026, 11, 3, 8);

  DateTime _now;

  DateTime call() => _now;

  void advance(Duration by) => _now = _now.add(by);
}

/// A random source without jitter: 0.5 is the middle of the spread, so the delay is exactly the exponential one.
class _FixedRandom implements Random {
  @override
  bool nextBool() => true;

  @override
  double nextDouble() => 0.5;

  @override
  int nextInt(int max) => 0;
}
