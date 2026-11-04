import 'dart:convert';

/// The token the backend issues for the PowerSync service is refused by the phone before it reaches the service.
final class SyncTokenRefused implements Exception {
  const SyncTokenRefused(this.reason);

  /// Why, as a stable word: `MALFORMED`, `AUDIENCE`, `TENANT`, `LIFETIME`, `SCOPE_VERSION_REPLAY`.
  final String reason;

  @override
  String toString() => 'SyncTokenRefused($reason)';
}

/// The audience of the PowerSync token and its longest lifetime in seconds (design doc 04, mobile sync with PowerSync, A1).
const String kSyncAudience = 'powersync';
const int kSyncTokenMaxLifetimeSeconds = 300;

/// The claims of the PowerSync token, read without verifying the signature: the phone cannot check it and the service does.
/// What the phone does check is that the token it is about to hand over is for the tenant and the membership the application
/// is signed in to, lives no longer than five minutes, and is not older than a token it already used (a replay).
final class SyncTokenClaims {
  const SyncTokenClaims({required this.tenantId, required this.membershipId, required this.scopeVersion, required this.issuedAt, required this.expiresAt});

  /// Reads the payload of a compact JWT. Anything that is not three parts with a JSON object as the middle one, with the claims
  /// of this token in their types, is [SyncTokenRefused] `MALFORMED`.
  factory SyncTokenClaims.parse(String token) {
    final List<String> parts = token.split('.');
    if (parts.length != 3 || parts.any((String part) => part.isEmpty)) throw const SyncTokenRefused('MALFORMED');
    final Object? payload;
    try {
      payload = jsonDecode(utf8.decode(base64Url.decode(base64Url.normalize(parts[1]))));
    } on FormatException {
      throw const SyncTokenRefused('MALFORMED');
    }
    if (payload is! Map<String, Object?>) throw const SyncTokenRefused('MALFORMED');
    final Object? audience = payload['aud'];
    if (audience != kSyncAudience) throw const SyncTokenRefused('AUDIENCE');
    final Object? tenant = payload['tenant_id'];
    final Object? membership = payload['membership_id'];
    final Object? scope = payload['scope_version'];
    final Object? issued = payload['iat'];
    final Object? expires = payload['exp'];
    if (tenant is! String || membership is! String || scope is! int || scope < 0 || issued is! int || expires is! int) throw const SyncTokenRefused('MALFORMED');
    return SyncTokenClaims(
      tenantId: tenant,
      membershipId: membership,
      scopeVersion: scope,
      issuedAt: DateTime.fromMillisecondsSinceEpoch(issued * 1000, isUtc: true),
      expiresAt: DateTime.fromMillisecondsSinceEpoch(expires * 1000, isUtc: true),
    );
  }

  final String tenantId;
  final String membershipId;
  final int scopeVersion;
  final DateTime issuedAt;
  final DateTime expiresAt;

  int get lifetimeSeconds => expiresAt.difference(issuedAt).inSeconds;

  /// Refuses the token unless it is for [tenantId], lives at most five minutes and does not go back in [previousScopeVersion].
  void requireFor({required String tenantId, int? previousScopeVersion}) {
    if (this.tenantId != tenantId) throw const SyncTokenRefused('TENANT');
    if (lifetimeSeconds <= 0 || lifetimeSeconds > kSyncTokenMaxLifetimeSeconds) throw const SyncTokenRefused('LIFETIME');
    if (previousScopeVersion != null && scopeVersion < previousScopeVersion) throw const SyncTokenRefused('SCOPE_VERSION_REPLAY');
  }
}
