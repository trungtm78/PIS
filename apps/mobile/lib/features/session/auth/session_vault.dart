import 'dart:convert';

import 'oidc_client.dart';
import 'secure_store.dart';

/// What the device keeps of a signed-in session: the identity provider, the refresh token and the context the person
/// selected. The access tokens are never stored (they live in memory for five minutes and are renewed from the refresh token).
final class StoredSession {
  const StoredSession({
    required this.config,
    required this.refreshToken,
    required this.userId,
    required this.tenantId,
    required this.membershipId,
  });

  final OidcConfig config;
  final String refreshToken;
  final String userId;
  final String tenantId;
  final String membershipId;

  Map<String, Object?> toJson() => <String, Object?>{
        'config': config.toJson(),
        'refresh_token': refreshToken,
        'user_id': userId,
        'tenant_id': tenantId,
        'membership_id': membershipId,
      };

  static StoredSession? fromJson(Object? json) {
    if (json is! Map<String, Object?>) return null;
    final Object? config = json['config'];
    final Object? token = json['refresh_token'];
    final Object? user = json['user_id'];
    final Object? tenant = json['tenant_id'];
    final Object? membership = json['membership_id'];
    if (config is! Map<String, Object?> || token is! String || user is! String || tenant is! String || membership is! String) return null;
    return StoredSession(config: OidcConfig.fromJson(config), refreshToken: token, userId: user, tenantId: tenant, membershipId: membership);
  }

  @override
  String toString() => 'StoredSession(tenant: $tenantId)';
}

/// What the device remembers after the session is gone, so the person signs back in to the same place without typing the
/// tenant again (the "last tenant" hint of MOB-01 and the context MOB-44 returns to). Nothing in it is secret.
final class LastContext {
  const LastContext({this.config, this.tenantCode, this.tenantId, this.membershipId});

  final OidcConfig? config;
  final String? tenantCode;
  final String? tenantId;
  final String? membershipId;

  Map<String, Object?> toJson() => <String, Object?>{
        if (config != null) 'config': config!.toJson(),
        if (tenantCode != null) 'tenant_code': tenantCode,
        if (tenantId != null) 'tenant_id': tenantId,
        if (membershipId != null) 'membership_id': membershipId,
      };

  static LastContext fromJson(Map<String, Object?> json) {
    final Object? config = json['config'];
    final Object? code = json['tenant_code'];
    final Object? tenant = json['tenant_id'];
    final Object? membership = json['membership_id'];
    return LastContext(
      config: config is Map<String, Object?> ? OidcConfig.fromJson(config) : null,
      tenantCode: code is String ? code : null,
      tenantId: tenant is String ? tenant : null,
      membershipId: membership is String ? membership : null,
    );
  }

  LastContext copyWith({OidcConfig? config, String? tenantCode, String? tenantId, String? membershipId}) => LastContext(
        config: config ?? this.config,
        tenantCode: tenantCode ?? this.tenantCode,
        tenantId: tenantId ?? this.tenantId,
        membershipId: membershipId ?? this.membershipId,
      );
}

/// What happens to the local data of a tenant the person leaves (a tenant switch or a sign-out). The default deletes it.
enum LocalDataPolicy {
  /// Delete the store, its key and the files of the tenant left.
  purge,

  /// Keep them, still encrypted under the key in the Keychain or Keystore, for the next time the person returns.
  keepEncrypted,
}

/// The name of a secure value that belongs to one tenant. Every tenant-bound value uses it, so one prefix finds them all
/// when the tenant is purged.
String tenantKey(String tenantId, String name) => 'tenant.$tenantId.$name';

/// The typed view of the secure store: the session, the last context, the tenants that have data on this device, the purge
/// journal, and the device preferences.
class SessionVault {
  SessionVault(this._store);

  final SecureValueStore _store;

  static const String _session = 'session.v1';
  static const String _last = 'last_context.v1';
  static const String _tenants = 'tenants.v1';
  static const String _journal = 'purge_pending.v1';
  static const String _policy = 'local_data_policy.v1';
  static const String _biometric = 'biometric_unlock.v1';

  Future<StoredSession?> loadSession() async {
    final Object? json = await _readJson(_session);
    try {
      final StoredSession? session = StoredSession.fromJson(json);
      if (session == null && json != null) await _store.delete(_session);
      return session;
    } on OidcException {
      await _store.delete(_session);
      return null;
    }
  }

  Future<void> saveSession(StoredSession session) => _store.write(_session, jsonEncode(session.toJson()));

  Future<void> clearSession() => _store.delete(_session);

  Future<LastContext?> loadLast() async {
    final Object? json = await _readJson(_last);
    if (json is! Map<String, Object?>) return null;
    try {
      return LastContext.fromJson(json);
    } on OidcException {
      await _store.delete(_last);
      return null;
    }
  }

  Future<void> saveLast(LastContext context) => _store.write(_last, jsonEncode(context.toJson()));

  Future<void> clearLast() => _store.delete(_last);

  /// The tenants that hold data on this device.
  Future<Set<String>> knownTenants() => _readSet(_tenants);

  Future<void> addTenant(String tenantId) async => _writeSet(_tenants, (await knownTenants())..add(tenantId));

  Future<void> removeTenant(String tenantId) async => _writeSet(_tenants, (await knownTenants())..remove(tenantId));

  /// The tenants whose purge was decided and not yet finished. It is written before anything is deleted, so a purge that was
  /// interrupted (the process died, a deletion failed) is finished the next time the application starts.
  Future<Set<String>> pendingPurges() => _readSet(_journal);

  Future<void> markPurge(String tenantId) async => _writeSet(_journal, (await pendingPurges())..add(tenantId));

  Future<void> markPurgeDone(String tenantId) async => _writeSet(_journal, (await pendingPurges())..remove(tenantId));

  Future<LocalDataPolicy> localDataPolicy() async =>
      await _store.read(_policy) == LocalDataPolicy.keepEncrypted.name ? LocalDataPolicy.keepEncrypted : LocalDataPolicy.purge;

  Future<void> setLocalDataPolicy(LocalDataPolicy policy) => _store.write(_policy, policy.name);

  /// Whether the person asked for the credential to be unlocked by biometrics on resume.
  Future<bool> biometricUnlock() async => await _store.read(_biometric) == 'on';

  Future<void> setBiometricUnlock({required bool enabled}) => enabled ? _store.write(_biometric, 'on') : _store.delete(_biometric);

  /// Deletes every secure value of one tenant: the keys that start with `tenant.<id>.`.
  Future<void> deleteTenantValues(String tenantId) async {
    final String prefix = tenantKey(tenantId, '');
    for (final String key in await _store.keys()) {
      if (key.startsWith(prefix)) await _store.delete(key);
    }
  }

  Future<Object?> _readJson(String key) async {
    final String? raw = await _store.read(key);
    if (raw == null) return null;
    try {
      return jsonDecode(raw);
    } on FormatException {
      await _store.delete(key);
      return null;
    }
  }

  Future<Set<String>> _readSet(String key) async {
    final Object? json = await _readJson(key);
    return json is List<Object?> ? json.whereType<String>().toSet() : <String>{};
  }

  Future<void> _writeSet(String key, Set<String> values) =>
      values.isEmpty ? _store.delete(key) : _store.write(key, jsonEncode(values.toList()..sort()));
}
