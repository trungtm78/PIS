import 'package:flutter_riverpod/flutter_riverpod.dart';

enum SessionStatus { signedOut, signedIn, expired }

/// Whether the tenant lets the session change things. The server decides (`mode` of the session context): a suspended
/// tenant is read-only, and so is a session after the server answered 422 `LICENSE_EXPIRED`.
enum SessionMode { full, readOnly }

/// The level of assurance of the sign-in: `aal2` once a second factor was used (the server rechecks it per operation).
enum AssuranceLevel { aal1, aal2 }

/// Who is signed in, to which tenant. Holds no secret: the access token is read through [SessionController.accessToken].
///
/// The three fields `status`, `tenantId` and `userId` are the stable contract of the foundation. The rest was added by
/// ST-MOB-002 and defaults to "nothing special", so a screen that only reads the three keeps working.
final class SessionSnapshot {
  const SessionSnapshot({
    required this.status,
    this.tenantId,
    this.userId,
    this.membershipId,
    this.mode = SessionMode.full,
    this.assurance = AssuranceLevel.aal1,
    this.stepUpRequired = false,
    this.locked = false,
  });

  const SessionSnapshot.signedOut() : this(status: SessionStatus.signedOut);

  final SessionStatus status;

  /// The active tenant of a signed-in session; the only tenant any request, local storage or deep link may use.
  final String? tenantId;
  final String? userId;

  /// The membership (unit and role) the user selected in MOB-04; null before the selection.
  final String? membershipId;

  /// Whether this session may change things in the tenant.
  final SessionMode mode;
  final AssuranceLevel assurance;

  /// The server answered 403 `MFA_REQUIRED`: the user must pass the second factor (MOB-03) before the action is allowed.
  final bool stepUpRequired;

  /// The device is locked by the biometric unlock: the credential is not usable until the user unlocks it (MOB-02).
  final bool locked;

  bool get isSignedIn => status == SessionStatus.signedIn;

  bool get isReadOnly => mode == SessionMode.readOnly;

  @override
  bool operator ==(Object other) =>
      other is SessionSnapshot &&
      other.status == status &&
      other.tenantId == tenantId &&
      other.userId == userId &&
      other.membershipId == membershipId &&
      other.mode == mode &&
      other.assurance == assurance &&
      other.stepUpRequired == stepUpRequired &&
      other.locked == locked;

  @override
  int get hashCode => Object.hash(status, tenantId, userId, membershipId, mode, assurance, stepUpRequired, locked);
}

/// A request was prepared for one tenant while another is active. Nothing is sent: a queued command of tenant A must never
/// travel with the token of tenant B (BR-MOB, NFR-TENANCY-07).
final class TenantMismatch implements Exception {
  const TenantMismatch();

  @override
  String toString() => 'TenantMismatch';
}

/// The session of the application: `sessionProvider` is read by the router guard, the API client (for every request
/// through [accessToken]) and every screen that needs to know who is signed in.
///
/// The foundation ships [SignedOutSession]; the application replaces it with the OIDC Authorization Code + PKCE session
/// of `features/session` by overriding [sessionProvider] in `main.dart` (ST-MOB-002). A test overrides it with a fake.
/// The flows that change the session (sign-in, step-up, tenant selection and switch, sign-out) are not on this class: they
/// are `authServiceProvider` of `features/session`, which writes the state of this notifier.
abstract class SessionController extends Notifier<SessionSnapshot> {
  /// The bearer token for the next request, refreshed when needed; null when there is no session. Called for every
  /// request, so a renewed or revoked token is never reused.
  Future<String?> accessToken();

  /// The bearer token for a request that belongs to [tenantId] (a queued command, an upload): refused with [TenantMismatch] when
  /// another tenant is, or has become, the active one, so work of tenant A never travels with the token of tenant B.
  Future<String?> accessTokenFor(String tenantId) async {
    if (state.tenantId != tenantId) throw const TenantMismatch();
    return accessToken();
  }
}

class SignedOutSession extends SessionController {
  @override
  SessionSnapshot build() => const SessionSnapshot.signedOut();

  @override
  Future<String?> accessToken() async => null;
}

final NotifierProvider<SessionController, SessionSnapshot> sessionProvider =
    NotifierProvider<SessionController, SessionSnapshot>(SignedOutSession.new);
