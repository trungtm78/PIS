import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Where the application keeps what must survive a restart and must not be readable by anything else on the phone: the
/// Keychain on iOS, the Keystore on Android. A key/value port, so the vault and every test run on a memory fake and only the
/// adapter below touches the platform.
abstract interface class SecureValueStore {
  Future<String?> read(String key);

  Future<void> write(String key, String value);

  Future<void> delete(String key);

  /// Every key held, for the purge of one tenant by prefix.
  Future<Set<String>> keys();
}

/// The [SecureValueStore] on `flutter_secure_storage`. On iOS an item is available after the first unlock and stays on this
/// device (never in a backup restored elsewhere); on Android the default encrypted storage backed by the Keystore is used, and
/// the application manifest disables backup.
final class FlutterSecureValueStore implements SecureValueStore {
  const FlutterSecureValueStore({
    FlutterSecureStorage storage = const FlutterSecureStorage(
      iOptions: IOSOptions(accessibility: KeychainAccessibility.first_unlock_this_device),
    ),
  }) : _storage = storage;

  final FlutterSecureStorage _storage;

  @override
  Future<String?> read(String key) => _storage.read(key: key);

  @override
  Future<void> write(String key, String value) => _storage.write(key: key, value: value);

  @override
  Future<void> delete(String key) => _storage.delete(key: key);

  @override
  Future<Set<String>> keys() async => (await _storage.readAll()).keys.toSet();
}
