import '../../../core/offline/offline_providers.dart' show OfflineUnavailable;
import '../../../core/offline/queue/command_queue.dart';
import '../../../core/offline/store/local_store.dart';
import 'local_data.dart';

/// The commands that wait on the device, as the tenant switch and the sign-out need to know them: how many would be lost, and a
/// way to send them now. The offline queue (ST-MOB-005) is the source; tests plug in their own.
abstract interface class PendingWork {
  /// Commands that have not reached the server for good (queued, sending, unknown, in conflict, rejected).
  Future<int> count();

  /// Tries to send everything now; the count tells afterwards what is left.
  Future<void> sendNow();

  /// Drops every command that has not reached the server for good: the person chose to discard them when leaving the tenant. They
  /// are never sent afterwards, whether or not the rest of the local data of the tenant is kept.
  Future<void> discardUnsent();
}

/// The [PendingWork] on the command queue of the signed-in user. Nobody signed in has nothing waiting.
final class QueuePendingWork implements PendingWork {
  const QueuePendingWork(this._queue);

  final Future<CommandQueue> Function() _queue;

  @override
  Future<int> count() async {
    try {
      return (await _queue()).unsentCount;
    } on OfflineUnavailable {
      return 0;
    }
  }

  @override
  Future<void> sendNow() async {
    await (await _queue()).flush();
  }

  @override
  Future<void> discardUnsent() async {
    try {
      (await _queue()).discardUnsent();
    } on OfflineUnavailable {
      return;
    }
  }
}

/// Deletes the encrypted store of a user in a tenant (file, journals and key), or of every tenant on the device.
final class OfflineStoragePurger implements LocalDataPurger {
  const OfflineStoragePurger(this._storage);

  final OfflineStorage _storage;

  @override
  Future<void> purgeTenant({required String tenantId, required String userId}) => _storage.purge(tenantId: tenantId, userId: userId);

  @override
  Future<void> purgeAll() => _storage.purgeAll();
}
