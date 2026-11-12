import '../core/theme/theme_mode.dart';
import '../features/session/auth/secure_store.dart';

/// The choice of light, dark or system kept in the platform store, under one key, so it survives a restart.
final class SecureThemePreferenceStore implements ThemePreferenceStore {
  const SecureThemePreferenceStore(this._store);

  /// The key of the choice. It holds one of `system`, `light` or `dark`.
  static const String key = 'ui.themeMode';

  final SecureValueStore _store;

  @override
  Future<String?> read() => _store.read(key);

  @override
  Future<void> write(String value) => _store.write(key, value);
}
