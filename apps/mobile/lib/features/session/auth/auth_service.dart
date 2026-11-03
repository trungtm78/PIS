import 'dart:async';

import 'package:flutter/services.dart' show PlatformException;
import 'package:machvon_api_client/machvon_api_client.dart';

import '../../../core/session/session.dart';
import 'biometric_gate.dart';
import 'identity_api.dart';
import 'local_data.dart';
import 'oidc_client.dart';
import 'session_vault.dart';

/// What a sign-in or a selection leads to.
enum SignInOutcome {
  /// The session is open on a tenant.
  signedIn,

  /// The person has several memberships (or none the app can choose for them): MOB-04 asks.
  needsSelection,

  /// The server wants the second factor before it lets this membership in (403 `MFA_REQUIRED`): MOB-03.
  needsSecondFactor,
}

/// What leaving a tenant does to the data of the tenant, and for which tenants.
enum SignOutScope {
  /// The active tenant only (what the local-data policy says happens to its data).
  activeTenant,

  /// Every tenant that has data on this device.
  allTenants,
}

/// A tenant switch or a sign-out was refused because commands are still waiting on the device: leaving would delete them.
/// The person sends them, or chooses to discard them, and asks again.
final class PendingCommandsBlock implements Exception {
  const PendingCommandsBlock(this.count);

  final int count;

  @override
  String toString() => 'PendingCommandsBlock($count)';
}

/// A request was prepared for one tenant while another is active. Nothing is sent: a queued command of tenant A must never
/// travel with the token of tenant B (BR-MOB, NFR-TENANCY-07).
final class TenantMismatch implements Exception {
  const TenantMismatch();

  @override
  String toString() => 'TenantMismatch';
}

/// The step needs a session and there is none (never signed in, or it ended).
final class NoSession implements Exception {
  const NoSession();

  @override
  String toString() => 'NoSession';
}

const Duration _tokenMargin = Duration(seconds: 30);
const Duration _freshTokenAge = Duration(seconds: 60);
const String _mfaRequiredCode = 'MFA_REQUIRED';
const String _licenseExpiredCode = 'LICENSE_EXPIRED';
const String _deviceRevokedCode = 'DEVICE_REVOKED';

/// What the server answers a renewal with when the person no longer belongs where the session was opened: the membership is no
/// longer active, the selection of the unit and role is void, or the scope is denied. The data of that tenant is not theirs any more.
bool _always() => true;

const Set<String> _contextLostCodes = <String>{'MEMBERSHIP_INACTIVE', 'TENANT_SELECTION_INVALID', 'SCOPE_DENIED'};

/// The session of the application, in plain Dart: the OpenID Connect tokens, the tenant token, the selection of the unit and
/// role, the second factor, the renewal, the biometric lock, the tenant switch and the sign-out with the purge of the local
/// data. [OidcSession] publishes its state as the `sessionProvider`; the screens of ST-MOB-002/008 call its methods.
///
/// What it keeps where:
///  * the refresh token and the context live in the vault (Keychain or Keystore), the refresh token is replaced the moment
///    the provider rotates it, before the new identity token is used;
///  * the identity token and the tenant token (five minutes) live in memory only and are renewed from the refresh token;
///  * nothing secret is logged, put in a URL or in an exception.
///
/// The server is the authority on whether a session is alive: the clock of the phone only decides when to renew a token
/// that is about to lapse, never whether a licence, a period or a session is valid.
class AuthService {
  AuthService({
    required OidcClient oidc,
    required IdentityApi api,
    required SessionVault vault,
    required TenantDataPurge purge,
    required BiometricGate biometrics,
    required Future<int> Function() pendingCommands,
    bool Function()? biometricUnlockAllowed,
    DateTime Function()? now,
    String Function()? newCorrelationId,
  })  : _oidc = oidc,
        _api = api,
        _vault = vault,
        _purge = purge,
        _biometrics = biometrics,
        _pendingCommands = pendingCommands,
        _biometricUnlockAllowed = biometricUnlockAllowed ?? _always,
        _now = now ?? DateTime.now,
        _newCorrelationId = newCorrelationId ?? newUuidV4;

  final OidcClient _oidc;
  final IdentityApi _api;
  final SessionVault _vault;
  final TenantDataPurge _purge;
  final BiometricGate _biometrics;
  final Future<int> Function() _pendingCommands;
  final bool Function() _biometricUnlockAllowed;
  final DateTime Function() _now;
  final String Function() _newCorrelationId;
  final StreamController<SessionSnapshot> _changes = StreamController<SessionSnapshot>.broadcast();

  late final Future<void> ready = _start();

  OidcConfig? _config;
  String? _subject;
  String? _idToken;
  DateTime _idTokenExpiresAt = DateTime.fromMillisecondsSinceEpoch(0);
  String? _refreshToken;
  String? _tenantToken;
  DateTime _tenantTokenExpiresAt = DateTime.fromMillisecondsSinceEpoch(0);
  DateTime _tenantTokenIssuedAt = DateTime.fromMillisecondsSinceEpoch(0);
  String? _tenantId;
  String? _membershipId;
  SessionStatus _status = SessionStatus.signedOut;
  SessionMode _mode = SessionMode.full;
  AssuranceLevel _assurance = AssuranceLevel.aal1;
  bool _stepUpRequired = false;
  bool _locked = false;
  MembershipChoice? _pendingSelection;
  ({String tenantId, String userId})? _leaving;
  Future<String?>? _renewing;
  Future<String>? _refreshing;
  SessionSnapshot _last = const SessionSnapshot.signedOut();

  /// The state of the session now.
  SessionSnapshot get snapshot => _last;

  /// Every change of the state, for the notifier that publishes it.
  Stream<SessionSnapshot> get changes => _changes.stream;

  /// Whether the second factor is wanted: a selection waits for it (sign-in) or the server asked for it (a call).
  bool get needsSecondFactor => _pendingSelection != null || _stepUpRequired;

  /// The identity provider configuration in use, or the one remembered from the last sign-in.
  OidcConfig? get config => _config;

  void dispose() => unawaited(_changes.close());

  // ---------------------------------------------------------------- start

  Future<void> _start() async {
    StoredSession? stored;
    LastContext? last;
    try {
      await _purge.finishPending();
      stored = await _vault.loadSession();
      last = await _vault.loadLast();
    } on PlatformException {
      // The Keychain or Keystore cannot be read (a reset keystore): the application starts signed out, and the person signs in
      // again. A secret that cannot be read is no session.
      stored = null;
      last = null;
    }
    _config = stored?.config ?? last?.config;
    if (stored != null) {
      _subject = stored.userId;
      _tenantId = stored.tenantId;
      _membershipId = stored.membershipId;
      _status = SessionStatus.signedIn;
      _locked = await _vault.biometricUnlock();
      _refreshToken = _locked ? null : stored.refreshToken;
    }
    _publish();
  }

  // -------------------------------------------------------------- sign-in

  /// Signs the person in through the system browser, then looks for the membership to enter: the one used last time when it
  /// is still allowed, the only one when there is one, otherwise MOB-04 asks.
  Future<SignInOutcome> signIn(OidcConfig config) async {
    await ready;
    _leaving = null;
    final OidcTokens tokens = await _oidc.signIn(config);
    _config = config;
    await _adoptIdentity(tokens, persist: false);
    final LastContext? last = await _vault.loadLast();
    await _vault.saveLast((last ?? const LastContext()).copyWith(config: config));
    final List<MembershipChoice> choices = (await _api.candidates(_idToken!)).where((MembershipChoice c) => c.selectable).toList();
    final MembershipChoice? remembered = choices.where((MembershipChoice c) => c.tenantId == last?.tenantId && c.membershipId == last?.membershipId).firstOrNull;
    final MembershipChoice? only = choices.length == 1 ? choices.single : null;
    final MembershipChoice? automatic = remembered ?? only;
    return automatic == null ? SignInOutcome.needsSelection : selectContext(automatic);
  }

  /// The memberships the person can enter, for MOB-04 and the tenant switcher.
  Future<List<MembershipChoice>> candidates() async {
    await ready;
    return _api.candidates(await _freshIdentity());
  }

  /// Enters the tenant with the membership the person chose. The selected context is what every later request carries: the
  /// tenant token is bound to it by the server. A tenant other than the active one is a switch ([switchTenant]).
  Future<SignInOutcome> selectContext(MembershipChoice choice) async {
    await ready;
    final String identity = await _freshIdentity();
    final TenantContext context;
    try {
      context = await _api.select(identity, tenantId: choice.tenantId, membershipId: choice.membershipId);
    } on ApiError catch (error) {
      if (error.code == _mfaRequiredCode) {
        _pendingSelection = choice;
        _publish();
        return SignInOutcome.needsSecondFactor;
      }
      _leaving = null;
      rethrow;
    }
    await _enter(context);
    return SignInOutcome.signedIn;
  }

  /// The second factor (MOB-03): the identity provider asks for it in the system browser, the same account must come back,
  /// and the membership that waited (or the active one) is selected again with the stronger identity.
  Future<SignInOutcome> stepUp() async {
    await ready;
    final OidcConfig config = _config ?? (throw const NoSession());
    final OidcTokens tokens = await _oidc.signIn(config, secondFactor: true);
    if (_subject != null && tokens.subject != _subject) throw const OidcException(OidcFailure.tokenInvalid);
    await _adoptIdentity(tokens, persist: _status == SessionStatus.signedIn);
    final MembershipChoice? waiting = _pendingSelection;
    if (waiting != null) {
      _pendingSelection = null;
      return selectContext(waiting);
    }
    final String tenant = _tenantId ?? (throw const NoSession());
    final String membership = _membershipId ?? (throw const NoSession());
    await _enter(await _api.select(_idToken!, tenantId: tenant, membershipId: membership));
    return SignInOutcome.signedIn;
  }

  /// The person left MOB-03 without passing the second factor: the selection that waited is dropped, and so is the switch it
  /// belonged to, so the tenant they stayed in keeps its data.
  void cancelSecondFactor() {
    _pendingSelection = null;
    _leaving = null;
    _publish();
  }

  /// The server asked for the second factor on a call (403 `MFA_REQUIRED`): the router sends the person to MOB-03.
  void requireSecondFactor() {
    if (_status != SessionStatus.signedIn || _stepUpRequired) return;
    _stepUpRequired = true;
    _publish();
  }

  // ---------------------------------------------------------------- tokens

  /// The bearer token for the next request (the tenant token), renewed when it is about to lapse. Null when there is no
  /// session or the device is locked. When the session cannot be renewed right now (no connection) it fails like a request
  /// that did not get through; when the provider refused the refresh token the session ends and the failure is the 401.
  Future<String?> accessToken() async {
    await ready;
    if (_status != SessionStatus.signedIn || _locked) return null;
    final String? token = _tenantToken;
    if (token != null && _now().isBefore(_tenantTokenExpiresAt.subtract(_tokenMargin))) return token;
    return _renew();
  }

  /// The token for a request that belongs to [tenantId]: refused when another tenant is active, so a command that was queued
  /// for tenant A is never sent with the token of tenant B.
  Future<String?> accessTokenFor(String tenantId) async {
    await ready;
    if (_tenantId != tenantId) throw const TenantMismatch();
    return accessToken();
  }

  Future<String?> _renew() => _renewing ??= _doRenew().whenComplete(() => _renewing = null);

  Future<String?> _doRenew() async {
    final String tenant = _tenantId ?? (throw const NoSession());
    final String membership = _membershipId ?? (throw const NoSession());
    try {
      final TenantContext context = await _api.select(await _freshIdentity(), tenantId: tenant, membershipId: membership);
      _takeTenantToken(context);
      _publish();
      return context.accessToken;
    } on ApiError catch (error) {
      if (_contextLostCodes.contains(error.code)) {
        await _revoke();
      } else if (error.status == 401) {
        await _expire();
      }
      if (error.code == _mfaRequiredCode) requireSecondFactor();
      rethrow;
    } on OidcException catch (error) {
      if (error.failure == OidcFailure.refreshRejected) {
        throw ApiError(status: 401, code: 'SESSION_EXPIRED', correlationId: _newCorrelationId());
      }
      throw ApiError.network(_newCorrelationId());
    }
  }

  /// An identity token that is good for a while, renewed from the refresh token (and the next refresh token stored at once).
  /// Every caller that finds it lapsed shares one refresh: the provider rotates the refresh token, so a second use of the same
  /// one would be a replay and would end the whole session.
  Future<String> _freshIdentity() {
    final String? token = _idToken;
    if (token != null && _now().isBefore(_idTokenExpiresAt.subtract(_tokenMargin))) return Future<String>.value(token);
    return _refreshing ??= _refreshIdentity().whenComplete(() => _refreshing = null);
  }

  Future<String> _refreshIdentity() async {
    final String refresh = _refreshToken ?? (throw const NoSession());
    final OidcConfig config = _config ?? (throw const NoSession());
    final OidcTokens tokens;
    try {
      tokens = await _oidc.refresh(config, refresh);
    } on OidcException catch (error) {
      if (error.failure == OidcFailure.refreshRejected) await _expire();
      rethrow;
    }
    if (_subject != null && tokens.subject != _subject) {
      await _expire();
      throw const OidcException(OidcFailure.tokenInvalid);
    }
    await _adoptIdentity(tokens, persist: _status == SessionStatus.signedIn);
    return _idToken!;
  }

  Future<void> _adoptIdentity(OidcTokens tokens, {required bool persist}) async {
    _idToken = tokens.idToken;
    _idTokenExpiresAt = _now().add(Duration(seconds: tokens.expiresIn));
    _subject = tokens.subject;
    final String? rotated = tokens.refreshToken;
    if (rotated != null) _refreshToken = rotated;
    if (persist && rotated != null) await _persist();
  }

  Future<void> _persist() async {
    final OidcConfig? config = _config;
    final String? refresh = _refreshToken;
    final String? subject = _subject;
    final String? tenant = _tenantId;
    final String? membership = _membershipId;
    if (config == null || refresh == null || subject == null || tenant == null || membership == null) return;
    await _vault.saveSession(StoredSession(config: config, refreshToken: refresh, userId: subject, tenantId: tenant, membershipId: membership));
  }

  void _takeTenantToken(TenantContext context) {
    _tenantToken = context.accessToken;
    _tenantTokenIssuedAt = _now();
    _tenantTokenExpiresAt = _tenantTokenIssuedAt.add(Duration(seconds: context.expiresIn));
    _mode = context.mode;
    _assurance = context.assurance;
    _stepUpRequired = false;
  }

  /// Makes the selected context the active one: stores it, forgets the previous tenant when the person left one.
  Future<void> _enter(TenantContext context) async {
    final ({String tenantId, String userId})? leaving = _leaving;
    final bool purgeLeft = leaving != null && leaving.tenantId != context.tenantId && await _vault.localDataPolicy() == LocalDataPolicy.purge;
    if (purgeLeft) await _purge.begin(leaving.tenantId, leaving.userId);
    _tenantId = context.tenantId;
    _membershipId = context.membershipId;
    _takeTenantToken(context);
    _pendingSelection = null;
    _leaving = null;
    _locked = false;
    _status = SessionStatus.signedIn;
    await _persist();
    await _vault.addTenant(context.tenantId);
    final LastContext? last = await _vault.loadLast();
    await _vault.saveLast((last ?? const LastContext()).copyWith(config: _config, tenantId: context.tenantId, membershipId: context.membershipId));
    _publish();
    if (purgeLeft) await _purge.run(leaving.tenantId, leaving.userId);
  }

  // --------------------------------------------------------- server verdicts

  /// A call answered 401. A token issued a moment ago that the server refuses means the session was ended on the server
  /// (revoked, idle, absolute lifetime): the session ends here too (MOB-44). An older token may simply have lapsed: it is
  /// renewed once, and only a refusal of the renewal ends the session.
  void noteUnauthorized() {
    if (_status != SessionStatus.signedIn) return;
    if (_now().difference(_tenantTokenIssuedAt) < _freshTokenAge) {
      unawaited(_expire());
      return;
    }
    _tenantToken = null;
    // The failure of this renewal is not lost: the next request asks for the token again and gets the same failure (the 401 that
    // ended the session, or the network error), which is where a screen shows it.
    unawaited(_renew().then<void>((String? _) {}, onError: (Object _) {}));
  }

  /// A call answered 422 `LICENSE_EXPIRED`: the session stays signed in and reads, and the screens stop offering changes.
  void noteLicenseExpired() {
    if (_status != SessionStatus.signedIn || _mode == SessionMode.readOnly) return;
    _mode = SessionMode.readOnly;
    _publish();
  }

  /// Tells the service what a call answered, from the transport; only the session-level verdicts matter here.
  void noteResponse(int status, String? code) {
    if (status == 401 && code == _deviceRevokedCode) {
      unawaited(_wipeRevokedDevice());
    } else if (status == 401) {
      noteUnauthorized();
    } else if (status == 403 && code == _mfaRequiredCode) {
      requireSecondFactor();
    } else if (status == 422 && code == _licenseExpiredCode) {
      noteLicenseExpired();
    }
  }

  /// The server says this device was revoked (the person did it from another phone, or an administrator did): the session ends and
  /// the data of every tenant on the device is deleted on this first contact, since the device is no longer trusted. Nothing
  /// waits for the person.
  Future<void> _wipeRevokedDevice() async {
    if (_status == SessionStatus.signedOut) return;
    await signOut(discardPending: true, scope: SignOutScope.allTenants);
  }

  /// The session is over on the server. The tokens go, the data stays (the drafts are locked on the device until the person
  /// signs in again), and the router shows MOB-44.
  Future<void> _expire() async {
    if (_status != SessionStatus.signedIn) return;
    _idToken = null;
    _refreshToken = null;
    _tenantToken = null;
    _pendingSelection = null;
    _stepUpRequired = false;
    _status = SessionStatus.expired;
    _publish();
    await _vault.clearSession();
  }

  /// The server says the person no longer belongs to the tenant the session was opened on (AC-ST-MOB-041-3). Their cached data is
  /// deleted at this first online contact, before the session is shown as ended: the encrypted store with its journals, the uploads
  /// and the key. The purge is journaled first, so a process killed half way finishes it at the next start. The context of the
  /// session goes with the data (no tenant, no user), so nothing keeps the deleted store open and nobody is signed in on it again.
  Future<void> _revoke() async {
    if (_status != SessionStatus.signedIn) return;
    final String? tenant = _tenantId;
    final String? user = _subject;
    try {
      if (tenant != null && user != null) {
        await _purge.begin(tenant, user);
        await _purge.run(tenant, user);
      }
    } finally {
      // A purge that failed stays in the journal and is finished at the next start; the session ends either way.
      _tenantId = null;
      _membershipId = null;
      _subject = null;
      await _expire();
    }
  }

  // ---------------------------------------------------------------- lock

  /// Locks the credential (the application went to the background and the person asked for the biometric unlock): the tokens
  /// leave memory, only the vault keeps the refresh token, and nothing is signed until [unlock].
  void lock() {
    if (_status != SessionStatus.signedIn || _locked) return;
    _locked = true;
    _idToken = null;
    _tenantToken = null;
    _refreshToken = null;
    _publish();
  }

  /// Locks the credential when the person asked for the biometric unlock (the application stayed away long enough).
  Future<void> lockIfBiometricUnlock() async {
    await ready;
    if (await _vault.biometricUnlock()) lock();
  }

  /// Whether the person asked for the biometric unlock.
  Future<bool> biometricUnlockEnabled() async {
    await ready;
    return _vault.biometricUnlock();
  }

  /// Whether the phone has a biometric (or a device credential) the application can use.
  Future<bool> biometricAvailable() => _biometrics.isAvailable();

  /// Turns the biometric unlock on or off. Turning it on needs the phone to have one and the person to pass the prompt once, so
  /// it cannot be enabled by someone who only holds the unlocked phone; false when it was not turned on. It changes how the
  /// stored credential is unlocked and nothing about what the person may sign or approve. On a phone that looks modified, under a
  /// tenant that restricts such phones, it cannot be turned on (INTEG-01, D-SEC-01): the prompt can be answered "yes" by a hooking
  /// framework, so the stored credential is released only after the identity provider has been asked again.
  Future<bool> setBiometricUnlock({required bool enabled, required String reason}) async {
    await ready;
    if (enabled) {
      if (!_biometricUnlockAllowed()) return false;
      if (!await _biometrics.isAvailable() || !await _biometrics.authenticate(reason: reason)) return false;
    }
    await _vault.setBiometricUnlock(enabled: enabled);
    return true;
  }

  /// What happens to the data of a tenant the person leaves.
  Future<LocalDataPolicy> localDataPolicy() async {
    await ready;
    return _vault.localDataPolicy();
  }

  Future<void> setLocalDataPolicy(LocalDataPolicy policy) async {
    await ready;
    await _vault.setLocalDataPolicy(policy);
  }

  /// Unlocks with the biometric prompt. The prompt answers yes or no; on yes the refresh token already in the vault is read
  /// back into memory. Nothing of the prompt goes to the server and it satisfies no second-factor demand.
  Future<bool> unlock({required String reason}) async {
    await ready;
    if (!_locked) return true;
    // On a phone that looks modified under a restricting tenant the prompt releases nothing: the person signs in again.
    if (!_biometricUnlockAllowed()) return false;
    if (!await _biometrics.authenticate(reason: reason)) return false;
    final StoredSession? stored = await _vault.loadSession();
    if (stored == null) {
      _locked = false;
      await _expire();
      return false;
    }
    _refreshToken = stored.refreshToken;
    _locked = false;
    _publish();
    return true;
  }

  // ---------------------------------------------------------- switch and out

  /// Changes the active tenant. Refused while commands wait on the device ([PendingCommandsBlock]) unless the person chose to
  /// discard them. The new context is entered first; only then is the data of the tenant left purged (when the policy says
  /// so), under the journal, so nothing of the old tenant outlives the switch and nothing is lost if the switch fails.
  Future<SignInOutcome> switchTenant(MembershipChoice target, {bool discardPending = false}) async {
    await ready;
    final String tenant = _tenantId ?? (throw const NoSession());
    final String user = _subject ?? (throw const NoSession());
    final int waiting = await _pendingCommands();
    if (target.tenantId != tenant && waiting > 0 && !discardPending) throw PendingCommandsBlock(waiting);
    _leaving = (tenantId: tenant, userId: user);
    return selectContext(target);
  }

  /// Signs out of this device: the tokens leave, the provider is asked to end the session behind the refresh token, and the
  /// local data is handled per the policy ([SignOutScope.allTenants] always deletes it all). Refused while commands wait
  /// ([PendingCommandsBlock]) unless the person chose to discard them; a session that already ended signs out freely.
  Future<void> signOut({bool discardPending = false, SignOutScope scope = SignOutScope.activeTenant}) async {
    await ready;
    final int waiting = await _pendingCommands();
    if (_status == SessionStatus.signedIn && waiting > 0 && !discardPending) throw PendingCommandsBlock(waiting);
    final String? tenant = _tenantId;
    final String? user = _subject;
    final String? refresh = _refreshToken ?? (await _vault.loadSession())?.refreshToken;
    final OidcConfig? config = _config;
    final bool purgeActive = scope == SignOutScope.activeTenant && tenant != null && user != null && await _vault.localDataPolicy() == LocalDataPolicy.purge;
    if (purgeActive) await _purge.begin(tenant, user);
    _clearMemory();
    _status = SessionStatus.signedOut;
    await _vault.clearSession();
    _publish();
    if (refresh != null && config != null) await _oidc.revoke(config, refresh);
    if (scope == SignOutScope.allTenants) {
      await _purge.runAll();
    } else if (purgeActive) {
      await _purge.run(tenant, user);
    }
  }

  void _clearMemory() {
    _idToken = null;
    _refreshToken = null;
    _tenantToken = null;
    _tenantId = null;
    _membershipId = null;
    _subject = null;
    _pendingSelection = null;
    _leaving = null;
    _stepUpRequired = false;
    _locked = false;
    _mode = SessionMode.full;
    _assurance = AssuranceLevel.aal1;
  }

  void _publish() {
    final SessionSnapshot next = SessionSnapshot(
      status: _status,
      tenantId: _tenantId,
      userId: _subject,
      membershipId: _membershipId,
      mode: _mode,
      assurance: _assurance,
      stepUpRequired: _stepUpRequired,
      locked: _locked,
    );
    if (next == _last) return;
    _last = next;
    if (!_changes.isClosed) _changes.add(next);
  }
}
