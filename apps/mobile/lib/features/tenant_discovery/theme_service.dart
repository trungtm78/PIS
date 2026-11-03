import 'dart:convert';

import '../session/auth/secure_store.dart';
import '../session/auth/session_vault.dart';
import 'published_theme.dart';

const String _themeKeyName = 'theme.v1';

/// Applies the published theme of the active tenant and keeps the last published version of each tenant on the device, so the
/// application looks like the organisation even without a connection.
///
/// The rules, each tested:
///  * only a published theme of the tenant it is applied for is applied (a theme of another tenant is refused);
///  * the whole theme passes the contrast rules or none of it is applied;
///  * the version never goes back: a version older than the one kept for the tenant is ignored (version pinning), the same
///    version is a no-op;
///  * the copy kept on the device is of one tenant and goes with that tenant when it is purged.
class TenantThemeService {
  TenantThemeService({
    required SecureValueStore store,
    required void Function(Map<String, String>? overlay) publish,
    required void Function(ActiveTheme? theme) activate,
    required Future<Object?> Function() fetchMine,
  })  : _store = store,
        _vault = SessionVault(store),
        _publish = publish,
        _activate = activate,
        _fetchMine = fetchMine;

  final SecureValueStore _store;
  final SessionVault _vault;
  final void Function(Map<String, String>? overlay) _publish;
  final void Function(ActiveTheme? theme) _activate;
  final Future<Object?> Function() _fetchMine;
  ActiveTheme? _active;

  /// The version applied now.
  ActiveTheme? get active => _active;

  /// Applies [theme] for [tenantId] when it is a newer (or first) published version of that tenant that passes the contrast
  /// rules; true when it was applied.
  Future<bool> apply(PublishedTheme theme, {required String tenantId, bool fromCache = false}) async {
    if (theme.tenantId != tenantId || !theme.accepted) return false;
    final PublishedTheme? kept = await _kept(tenantId);
    if (kept != null && theme.version < kept.version) return false;
    if (_active?.tenantId == tenantId && _active!.version == theme.version && _active!.hash == theme.hash && _active!.fromCache == fromCache) return true;
    if (!fromCache) {
      await _store.write(tenantKey(tenantId, _themeKeyName), jsonEncode(theme.toJson()));
      await _vault.addTenant(tenantId);
    }
    _publish(theme.overlay);
    _active = ActiveTheme(tenantId: tenantId, version: theme.version, hash: theme.hash, fromCache: fromCache);
    _activate(_active);
    return true;
  }

  /// Applies the copy kept for [tenantId], when there is one.
  Future<bool> restore(String tenantId) async {
    final PublishedTheme? kept = await _kept(tenantId);
    return kept != null && await apply(kept, tenantId: tenantId, fromCache: true);
  }

  /// Asks the server for the published theme of the active tenant and applies it. False when the server could not be asked, or
  /// answered something that is not a theme of this tenant: the theme in use stays.
  Future<bool> refresh(String tenantId) async {
    final Object? json;
    try {
      json = await _fetchMine();
    } on Object {
      return false;
    }
    final PublishedTheme? theme = PublishedTheme.tryParse(json);
    return theme != null && await apply(theme, tenantId: tenantId);
  }

  /// Back to the base theme: nothing of a tenant stays on screen after it is left.
  void clear() {
    if (_active == null) return;
    _publish(null);
    _active = null;
    _activate(null);
  }

  Future<PublishedTheme?> _kept(String tenantId) async {
    final String? raw = await _store.read(tenantKey(tenantId, _themeKeyName));
    if (raw == null) return null;
    try {
      return PublishedTheme.fromStored(jsonDecode(raw));
    } on FormatException {
      return null;
    }
  }
}
