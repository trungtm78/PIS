import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/navigation/deep_link_guard.dart';
import 'package:machvon_mobile/core/session/session.dart';

/// A guard that answers what it is told, synchronously or not.
class _Inner implements DeepLinkGuard {
  _Inner(this.answer, {this.later = false});

  final String? answer;
  final bool later;

  @override
  FutureOr<String?> redirectFor(Uri target, SessionSnapshot session) => later ? Future<String?>.value(answer) : answer;
}

const SessionSnapshot _signedIn = SessionSnapshot(status: SessionStatus.signedIn, tenantId: 't', userId: 'u');

String _locationOf(String id) => '/loc/$id';

String? _toNotification(Uri target, String Function(String) locationOf) => target.path.startsWith('/r/') ? locationOf('MOB-33') : null;

String? _never(Uri target, String Function(String) locationOf) => '/never';

void main() {
  group('ST-MOB-015 TK-MOB-015-4 the rules a feature adds to the deep-link guard', () {
    test('a location the inner guard lets through is given to the rules in order; the first answer wins', () {
      final RuleDeepLinkGuard guard = RuleDeepLinkGuard(inner: _Inner(null), rules: <LocationRule>[_toNotification, _never], locationOf: _locationOf);
      expect(guard.redirectFor(Uri.parse('/r/abc'), _signedIn), '/loc/MOB-33');
      expect(guard.redirectFor(Uri.parse('/home'), _signedIn), '/never');
      expect(RuleDeepLinkGuard(inner: _Inner(null), rules: const <LocationRule>[], locationOf: _locationOf).redirectFor(Uri.parse('/home'), _signedIn), isNull);
    });

    test('what the inner guard refuses is never given to a rule: sign-in, the tenant check and a release block come first', () {
      final RuleDeepLinkGuard guard = RuleDeepLinkGuard(inner: _Inner('/mob-02?return=%2Fr%2Fabc'), rules: <LocationRule>[_toNotification], locationOf: _locationOf);
      expect(guard.redirectFor(Uri.parse('/r/abc'), _signedIn), '/mob-02?return=%2Fr%2Fabc');
    });

    test('an inner guard that answers later is waited for, then the rules apply', () async {
      final RuleDeepLinkGuard open = RuleDeepLinkGuard(inner: _Inner(null, later: true), rules: <LocationRule>[_toNotification], locationOf: _locationOf);
      expect(await open.redirectFor(Uri.parse('/r/abc'), _signedIn), '/loc/MOB-33');
      final RuleDeepLinkGuard refused = RuleDeepLinkGuard(inner: _Inner('/mob-45', later: true), rules: <LocationRule>[_toNotification], locationOf: _locationOf);
      expect(await refused.redirectFor(Uri.parse('/r/abc'), _signedIn), '/mob-45');
    });
  });
}
