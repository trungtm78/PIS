import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart' show OfflineUnavailable;
import 'package:machvon_mobile/features/session/auth/pending_work.dart';

import '../../support/offline_support.dart';
import '../../support/queue_rig.dart';

void main() {
  group('AC-ST-MOB-008-1 UAT-AC505 the pending commands as the tenant switch counts them', () {
    test('counts what has not reached the server for good and sends it on request', () async {
      final QueueRig rig = await QueueRig.create();
      final QueuePendingWork pending = QueuePendingWork(() async => rig.queue);
      expect(await pending.count(), 0);

      rig.queue.enqueue(commandType: 'dis.report.submit', payload: <String, Object?>{'report_id': 'r-1'}, baseServerVersion: 3);
      expect(await pending.count(), 1);

      await pending.sendNow();
      expect(await pending.count(), 0, reason: 'the server accepted it, nothing is left to lose');
    });

    test('nobody signed in has nothing waiting', () async {
      final QueuePendingWork pending = QueuePendingWork(() async => throw const OfflineUnavailable());
      expect(await pending.count(), 0);
    });
  });

  group('AC-ST-MOB-008-1 UAT-AC505 the purge of the local stores', () {
    test('deletes the store of one user in one tenant, with its key, and leaves the others', () async {
      final TestStorage storage = TestStorage.create();
      await storage.open(tenantId: 'tenant-a', userId: 'user-1');
      await storage.open(tenantId: 'tenant-b', userId: 'user-1');
      final OfflineStoragePurger purger = OfflineStoragePurger(storage.storage);

      await purger.purgeTenant(tenantId: 'tenant-a', userId: 'user-1');
      expect(storage.keys.keys, hasLength(1));
      expect(storage.directory.listSync().where((entity) => entity.path.endsWith('.db')), hasLength(1));
    });

    test('deletes every store of the installation', () async {
      final TestStorage storage = TestStorage.create();
      await storage.open(tenantId: 'tenant-a', userId: 'user-1');
      await storage.open(tenantId: 'tenant-b', userId: 'user-2');
      await OfflineStoragePurger(storage.storage).purgeAll();
      expect(storage.keys.keys, isEmpty);
      expect(storage.directory.listSync().where((entity) => entity.path.endsWith('.db')), isEmpty);
    });
  });
}
