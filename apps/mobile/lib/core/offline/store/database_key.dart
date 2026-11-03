import 'dart:math';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Where the key of a local database is kept: the Keychain on iOS and the Keystore on Android (MOB.md 6). The key never
/// leaves this port in a log, a file or a URL; a database file without its key is unreadable.
abstract interface class DatabaseKeyStore {
  /// The key stored for [scope], created and stored when there is none yet.
  Future<String> keyFor(String scope);

  /// Removes the key of [scope]; the database it opened can no longer be read.
  Future<void> delete(String scope);
}

/// A new 256-bit key as 64 hexadecimal characters, from the secure random source of the platform.
String newDatabaseKey([Random? random]) {
  final Random source = random ?? Random.secure();
  return List<String>.generate(32, (int _) => source.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
}

/// The [DatabaseKeyStore] on `flutter_secure_storage`. The accessibility is "after first unlock, this device only", so
/// the key is not restored to another phone from a backup and a queued command can still be sent by a background task.
final class SecureDatabaseKeyStore implements DatabaseKeyStore {
  SecureDatabaseKeyStore({FlutterSecureStorage? storage, Random? random})
      : _storage = storage ?? const FlutterSecureStorage(iOptions: IOSOptions(accessibility: KeychainAccessibility.first_unlock_this_device)),
        _random = random;

  final FlutterSecureStorage _storage;
  final Random? _random;

  static String _name(String scope) => 'machvon.local-database.$scope';

  @override
  Future<String> keyFor(String scope) async {
    final String name = _name(scope);
    final String? existing = await _storage.read(key: name);
    if (existing != null) return existing;
    final String created = newDatabaseKey(_random);
    await _storage.write(key: name, value: created);
    return created;
  }

  @override
  Future<void> delete(String scope) => _storage.delete(key: _name(scope));
}
