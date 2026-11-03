/// What the sync service needs to connect: where it is and the token the backend issued for this session.
final class SyncCredentials {
  const SyncCredentials({required this.endpoint, required this.token});

  final Uri endpoint;
  final String token;
}

/// Where the phone gets a PowerSync token from: the backend issues it (TTL 5 minutes at most) for the tenant and the membership
/// of the session. Nothing about the tenant is sent from the phone: the backend reads it from the session.
abstract interface class SyncCredentialSource {
  Future<SyncCredentials> fetch();
}

/// What the sync engine tells the application.
sealed class SyncEngineEvent {
  const SyncEngineEvent();
}

/// A checkpoint was applied. [serverTime] is the time of the data as the server states it (never the clock of the phone);
/// [bucketCount] is how many buckets the service sent for this user: zero means the scope of the user is empty.
final class SyncCheckpoint extends SyncEngineEvent {
  const SyncCheckpoint({required this.serverTime, required this.bucketCount});

  final DateTime serverTime;
  final int bucketCount;
}

/// The service refused the connection: the token was stale or the membership is gone ([status] 401 or 403).
final class SyncAuthFailed extends SyncEngineEvent {
  const SyncAuthFailed({required this.status, required this.code});

  final int status;
  final String code;
}

/// The sync service as the application sees it (the PowerSync Flutter SDK behind a port, ST-MOB-007). The adapter over the SDK
/// calls [SyncCredentialSource] whenever the SDK needs a token (at connection and before the token expires), connects with no
/// client parameters, and turns the checkpoints and refusals of the service into [SyncEngineEvent]s.
abstract interface class SyncEngine {
  /// Connects, asking [credentials] for a token whenever one is needed.
  Future<void> connect(Future<SyncCredentials> Function() credentials);

  /// Stops the connection and deletes every synced row from the device (`disconnectAndClear`).
  Future<void> disconnectAndClear();

  Stream<SyncEngineEvent> get events;
}
