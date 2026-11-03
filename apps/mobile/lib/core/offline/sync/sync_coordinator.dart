import 'dart:async';

import 'package:machvon_api_client/machvon_api_client.dart' show ApiError;

import '../queue/offline_codes.dart';
import '../store/local_store.dart';
import 'sync_engine.dart';
import 'sync_token.dart';

/// Where the synchronisation stands, for the sync status of the application.
enum SyncPhase {
  /// Not started.
  stopped,

  /// Connected; rows arrive as the server sends them.
  running,

  /// The membership or the scope of the person is gone: the synced rows were deleted from the device and the person must sign in.
  revoked,
}

/// The `meta` keys the coordinator keeps in the encrypted store.
const String kSyncHadBucketsMeta = 'sync_had_buckets';
const String kSyncScopeVersionMeta = 'sync_scope_version';

/// Keeps the device in step with the sync rules and empties it when the person loses their scope (ST-MOB-007, A1).
///
/// * The phone sends the service **nothing** but a token that the backend issued for the session: no tenant, no scope, no
///   parameter. A token for another tenant, one that lives more than five minutes, or one older than a token already used is
///   refused before it leaves the phone.
/// * When the service answers a checkpoint with **no buckets** for a person who had some, or refuses the connection because the
///   membership is gone, every synced row is deleted, the sync stops, and [onRevoked] is called so that the application can
///   forget the session and send the person to sign-in. This holds when the person comes back from being offline: the first
///   checkpoint after the reconnection is the empty one.
/// * The time shown as the `as_of` of the data is the time of the checkpoint the server gave, never the clock of the phone.
class SyncCoordinator {
  SyncCoordinator({
    required LocalStore store,
    required SyncEngine engine,
    required SyncCredentialSource source,
    required Future<void> Function() onRevoked,
  })  : _store = store,
        _engine = engine,
        _source = source,
        _onRevoked = onRevoked;

  final LocalStore _store;
  final SyncEngine _engine;
  final SyncCredentialSource _source;
  final Future<void> Function() _onRevoked;
  final StreamController<SyncPhase> _phases = StreamController<SyncPhase>.broadcast();
  StreamSubscription<SyncEngineEvent>? _events;
  SyncPhase _phase = SyncPhase.stopped;
  Future<void>? _revoking;

  SyncPhase get phase => _phase;

  Stream<SyncPhase> get phases => _phases.stream;

  Future<void> start() async {
    if (_phase == SyncPhase.running) return;
    _events = _engine.events.listen((SyncEngineEvent event) => unawaited(_handle(event)));
    _set(SyncPhase.running);
    await _engine.connect(_credentials);
  }

  Future<void> stop() async {
    await _events?.cancel();
    _events = null;
    if (_phase == SyncPhase.running) _set(SyncPhase.stopped);
  }

  /// The token for the next connection or refresh, checked before it is handed to the engine.
  Future<SyncCredentials> _credentials() async {
    final SyncCredentials credentials;
    try {
      credentials = await _source.fetch();
    } on ApiError catch (error) {
      // The backend no longer lets this membership sync: the person has lost the scope.
      if (error.status == 403 || error.code == kScopeDenied) await _revoke();
      rethrow;
    }
    final SyncTokenClaims claims = SyncTokenClaims.parse(credentials.token);
    final String? previous = _store.meta(kSyncScopeVersionMeta);
    claims.requireFor(tenantId: _store.tenantId, previousScopeVersion: previous == null ? null : int.parse(previous));
    _store.setMeta(kSyncScopeVersionMeta, claims.scopeVersion.toString());
    return credentials;
  }

  Future<void> _handle(SyncEngineEvent event) async {
    switch (event) {
      case SyncCheckpoint(:final DateTime serverTime, :final int bucketCount):
        if (bucketCount == 0 && _store.meta(kSyncHadBucketsMeta) == '1') return _revoke();
        if (bucketCount > 0) _store.setMeta(kSyncHadBucketsMeta, '1');
        _store.dataAsOf = serverTime;
      case SyncAuthFailed(:final int status):
        if (status == 403) return _revoke();
    }
  }

  /// Deletes what was synced, stops, and tells the application. Runs once however many events ask for it.
  Future<void> _revoke() => _revoking ??= _doRevoke();

  Future<void> _doRevoke() async {
    await _events?.cancel();
    _events = null;
    await _engine.disconnectAndClear();
    _store.setMeta(kSyncHadBucketsMeta, '0');
    _set(SyncPhase.revoked);
    await _onRevoked();
  }

  void _set(SyncPhase phase) {
    _phase = phase;
    _phases.add(phase);
  }

  Future<void> dispose() async {
    await stop();
    await _phases.close();
  }
}
