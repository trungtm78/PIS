import 'session_vault.dart';

/// Something on the device that holds data of one tenant and user and must delete it when they leave: the encrypted
/// database, its key and the file cache (ST-MOB-005 to 007 each provide theirs). The application lists them in one place,
/// `localDataPurgersProvider`, which `main.dart` composes.
abstract interface class LocalDataPurger {
  /// Deletes everything of [userId] in [tenantId]. Deleting what is already gone is not an error.
  Future<void> purgeTenant({required String tenantId, required String userId});

  /// Deletes everything of every tenant (a sign-out of all tenants).
  Future<void> purgeAll();
}

/// The purge of the tenants: the registered purgers and the secure values of the tenant, under a journal. The journal entry
/// is written first and removed last, so a purge that dies half way (the process is killed, a deletion fails) is finished by
/// [finishPending] the next time the application starts and the old data is never left behind.
final class TenantDataPurge {
  TenantDataPurge({required SessionVault vault, required List<LocalDataPurger> purgers}) : _vault = vault, _purgers = purgers;

  final SessionVault _vault;
  final List<LocalDataPurger> _purgers;

  /// Writes the purge to the journal. Call it before the user leaves the tenant.
  Future<void> begin(String tenantId, String userId) => _vault.markPurge(_entry(tenantId, userId));

  /// Deletes the data of one tenant and user and ends its journal entry; when a purger fails the entry stays.
  Future<void> run(String tenantId, String userId) async {
    for (final LocalDataPurger purger in _purgers) {
      await purger.purgeTenant(tenantId: tenantId, userId: userId);
    }
    await _vault.deleteTenantValues(tenantId);
    await _vault.removeTenant(tenantId);
    await _vault.markPurgeDone(_entry(tenantId, userId));
  }

  /// Deletes the data of every tenant on the device.
  Future<void> runAll() async {
    final Set<String> tenants = await _vault.knownTenants();
    for (final LocalDataPurger purger in _purgers) {
      await purger.purgeAll();
    }
    for (final String tenantId in tenants) {
      await _vault.deleteTenantValues(tenantId);
      await _vault.removeTenant(tenantId);
    }
  }

  /// Finishes the purges the journal still lists.
  Future<void> finishPending() async {
    for (final String entry in await _vault.pendingPurges()) {
      final int cut = entry.indexOf('/');
      if (cut <= 0) {
        await _vault.markPurgeDone(entry);
        continue;
      }
      await run(entry.substring(0, cut), entry.substring(cut + 1));
    }
  }

  static String _entry(String tenantId, String userId) => '$tenantId/$userId';
}
