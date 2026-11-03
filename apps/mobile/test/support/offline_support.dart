import 'dart:io';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/offline/store/database_key.dart';
import 'package:machvon_mobile/core/offline/store/local_store.dart';

/// A key store in memory: the secure storage of the phone needs a device, the rest of the store does not.
class MemoryKeyStore implements DatabaseKeyStore {
  MemoryKeyStore([Random? random]) : _random = random ?? Random(7);

  final Random _random;
  final Map<String, String> keys = <String, String>{};

  @override
  Future<String> keyFor(String scope) async => keys.putIfAbsent(scope, () => newDatabaseKey(_random));

  @override
  Future<void> delete(String scope) async => keys.remove(scope);
}

/// A storage in a temporary directory that is removed when the test ends.
class TestStorage {
  TestStorage._(this.directory, this.keys, this.storage);

  final Directory directory;
  final MemoryKeyStore keys;
  final OfflineStorage storage;

  static TestStorage create() {
    final Directory directory = Directory.systemTemp.createTempSync('machvon-offline-');
    final MemoryKeyStore keys = MemoryKeyStore();
    final OfflineStorage storage = OfflineStorage(directory: () async => directory, keys: keys);
    addTearDown(() async {
      try {
        await storage.purgeAll();
      } finally {
        if (directory.existsSync()) directory.deleteSync(recursive: true);
      }
    });
    return TestStorage._(directory, keys, storage);
  }

  Future<LocalStore> open({String tenantId = 'tenant-a', String userId = 'user-1'}) => storage.open(tenantId: tenantId, userId: userId);
}
