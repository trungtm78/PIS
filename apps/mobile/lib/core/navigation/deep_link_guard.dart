import 'dart:async';

import '../release/release_notice.dart';
import '../session/session.dart';

/// Decides, before any location opens, whether it may open: the hook through which every in-app navigation, every
/// deep link and every restored location passes (BR-MOB-05: a deep link always needs a sign-in and a tenant check).
///
/// Returns null to let the location open, or the location to go to instead. It may be asynchronous (ST-MOB-015 resolves
/// an opaque push link against the server here).
abstract interface class DeepLinkGuard {
  FutureOr<String?> redirectFor(Uri target, SessionSnapshot session);
}

/// A rule a feature adds to the guard (ST-MOB-015). It sees a location the session guard let through (the person is signed in,
/// the tenant is checked) and may send it elsewhere: an opaque push link goes to the screen of its notification. [locationOf]
/// gives the location of a screen by its id. Null leaves the location alone.
typedef LocationRule = String? Function(Uri target, String Function(String screenId) locationOf);

/// Applies the rules of the features after another guard has let a location through. The other guard decides first, so a rule
/// never opens what the session guard refused (a signed-out person, another tenant, a release block).
final class RuleDeepLinkGuard implements DeepLinkGuard {
  const RuleDeepLinkGuard({required this.inner, required this.rules, required this.locationOf});

  final DeepLinkGuard inner;
  final List<LocationRule> rules;
  final String Function(String screenId) locationOf;

  @override
  FutureOr<String?> redirectFor(Uri target, SessionSnapshot session) {
    final FutureOr<String?> first = inner.redirectFor(target, session);
    if (first is Future<String?>) return first.then((String? redirect) => redirect ?? _byRules(target));
    return first ?? _byRules(target);
  }

  String? _byRules(Uri target) {
    for (final LocationRule rule in rules) {
      final String? redirect = rule(target, locationOf);
      if (redirect != null) return redirect;
    }
    return null;
  }
}

/// The locations the guard sends the user to.
final class GuardTargets {
  const GuardTargets({
    required this.signIn,
    required this.sessionExpired,
    required this.accessDenied,
    this.secondFactor,
    this.releaseNotice,
  });

  final String signIn;
  final String sessionExpired;
  final String accessDenied;

  /// MOB-03; without it a session that needs the second factor opens locations as usual (a test of the bare guard).
  final String? secondFactor;

  /// MOB-54; without it a release block does not redirect.
  final String? releaseNotice;
}

/// The name of the query parameter that carries the location to return to after the sign-in.
const String returnParameter = 'return';

/// The query parameter that asks sign-in to unlock the stored credential (biometrics) instead of signing in again.
const String unlockParameter = 'unlock';

/// The query parameter of a link that names the tenant it was issued for.
const String tenantParameter = 'tenant';

/// The default guard:
///  * while the release is blocked (a maintenance window, a version the server declared unsafe) every location goes to the
///    release notice, except, in a maintenance window, the offline ones;
///  * a public location opens without a session;
///  * every other location needs a signed-in session: signed out goes to sign-in, an ended session to the session-expired
///    screen, both carrying the wanted location so that it opens after the sign-in;
///  * a signed-in session that must pass the second factor (the server answered 403 `MFA_REQUIRED`) goes to MOB-03 carrying
///    the wanted location;
///  * a locked session (biometric unlock) goes to sign-in in its unlock mode (`unlock=1`);
///  * a link that names a tenant other than the active one goes to the access-denied screen and never opens.
final class SessionDeepLinkGuard implements DeepLinkGuard {
  const SessionDeepLinkGuard({
    required this.targets,
    required this.isPublic,
    this.releaseBlock = _noBlock,
    this.isOffline = _never,
  });

  final GuardTargets targets;
  final bool Function(Uri target) isPublic;

  /// The current release block, read at every navigation.
  final ReleaseBlock Function() releaseBlock;

  /// Whether the location works from the device alone (it stays open in a maintenance window).
  final bool Function(Uri target) isOffline;

  static ReleaseBlock _noBlock() => ReleaseBlock.none;
  static bool _never(Uri target) => false;

  @override
  String? redirectFor(Uri target, SessionSnapshot session) {
    final String? notice = targets.releaseNotice;
    final ReleaseBlock block = releaseBlock();
    if (notice != null && block != ReleaseBlock.none && target.path != notice) {
      final bool open = block == ReleaseBlock.maintenance && isOffline(target);
      if (!open) return notice;
    }
    if (isPublic(target)) return null;
    switch (session.status) {
      case SessionStatus.signedOut:
        return _withReturn(targets.signIn, target);
      case SessionStatus.expired:
        return _withReturn(targets.sessionExpired, target);
      case SessionStatus.signedIn:
        if (session.locked) return _withReturn(targets.signIn, target, extra: const <String, String>{unlockParameter: '1'});
        final String? second = targets.secondFactor;
        if (session.stepUpRequired && second != null) return _withReturn(second, target);
        final String? linkTenant = target.queryParameters[tenantParameter];
        if (linkTenant != null && linkTenant != session.tenantId) return targets.accessDenied;
        return null;
    }
  }

  String _withReturn(String location, Uri target, {Map<String, String> extra = const <String, String>{}}) {
    final String wanted = target.toString();
    final bool safe = safeReturnLocation(wanted) != null;
    if (!safe && extra.isEmpty) return location;
    return Uri(path: location, queryParameters: <String, String>{...extra, if (safe) returnParameter: wanted}).toString();
  }
}

/// The location in a `return` parameter, when it is safe to open after the sign-in: a path of this application, never
/// another site, scheme or protocol-relative address. Null otherwise.
String? safeReturnLocation(String? raw) {
  if (raw == null || raw.isEmpty || raw.length > 2048) return null;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.contains(r'\')) return null;
  if (raw.codeUnits.any((int unit) => unit < 0x20 || unit == 0x7f)) return null;
  return raw;
}
