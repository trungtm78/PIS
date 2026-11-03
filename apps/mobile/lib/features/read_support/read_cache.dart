import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/session/session.dart';

/// The tenant and the person a copy belongs to. A copy is never read under another scope (BR-MOB-01, R6).
final class CacheScope {
  const CacheScope({required this.tenantId, required this.userId});

  final String tenantId;
  final String userId;

  @override
  bool operator ==(Object other) => other is CacheScope && other.tenantId == tenantId && other.userId == userId;

  @override
  int get hashCode => Object.hash(tenantId, userId);
}

/// One copy of a read: the answer as the server gave it, the moment it describes (`as_of`, when the answer names one),
/// and the moment the phone got it.
final class CacheEntry {
  const CacheEntry({required this.raw, required this.fetchedAt, this.asOf});

  final Object? raw;
  final String? asOf;
  final DateTime fetchedAt;
}

/// Where reads are kept so that the last answer can be shown with its `as_of` when the server cannot be reached.
///
/// The persistent store (encrypted SQLite, filled by the sync rules of ST-MOB-007) plugs in by overriding
/// [readCacheProvider]; this contract is what the screens use. Only answers are kept, never a command and never a table
/// write, and everything is dropped on [clear] (sign-out, tenant switch).
abstract interface class ReadCache {
  Future<CacheEntry?> read(CacheScope scope, String key);

  Future<void> write(CacheScope scope, String key, CacheEntry entry);

  Future<void> forget(CacheScope scope, String key);

  /// Drops every copy of every scope.
  Future<void> clear();
}

/// The copies in memory: they live as long as the process. Used until the persistent store is plugged in, and by tests.
final class InMemoryReadCache implements ReadCache {
  final Map<String, CacheEntry> _entries = <String, CacheEntry>{};

  String _id(CacheScope scope, String key) => '${scope.tenantId}\u0000${scope.userId}\u0000$key';

  @override
  Future<CacheEntry?> read(CacheScope scope, String key) async => _entries[_id(scope, key)];

  @override
  Future<void> write(CacheScope scope, String key, CacheEntry entry) async => _entries[_id(scope, key)] = entry;

  @override
  Future<void> forget(CacheScope scope, String key) async => _entries.remove(_id(scope, key));

  @override
  Future<void> clear() async => _entries.clear();

  int get length => _entries.length;
}

/// The cache of the application. It empties itself when the person signs out and when the tenant or the person changes,
/// so no copy outlives the session it was read under.
final Provider<ReadCache> readCacheProvider = Provider<ReadCache>((Ref ref) {
  final InMemoryReadCache cache = InMemoryReadCache();
  ref.listen<SessionSnapshot>(sessionProvider, (SessionSnapshot? previous, SessionSnapshot next) {
    if (previous == null) return;
    final bool left = next.status == SessionStatus.signedOut;
    if (left || previous.tenantId != next.tenantId || previous.userId != next.userId) cache.clear();
  });
  return cache;
});
