import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/navigation/deep_link_guard.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/features/notification_inbox/deep_links.dart';

import '../../features/notification_inbox/notification_fixtures.dart';

const GuardTargets _targets = GuardTargets(signIn: '/mob-02', sessionExpired: '/mob-44', accessDenied: '/projects/mob-45', secondFactor: '/mob-03');

String _locationOf(String screenId) {
  switch (screenId) {
    case 'MOB-33':
      return '/inbox/mob-33';
    case 'MOB-45':
      return '/projects/mob-45';
    default:
      return '/home';
  }
}

RuleDeepLinkGuard _guard() => RuleDeepLinkGuard(
      inner: SessionDeepLinkGuard(targets: _targets, isPublic: (Uri uri) => uri.path.startsWith('/mob-0')),
      rules: const <LocationRule>[opaqueLinkRule],
      locationOf: _locationOf,
    );

final Uri _push = Uri.parse('/r/$idUnread');

/// The guard here is synchronous (the session guard and a rule), so its answer is a location, not a future.
String? _go(Uri target, SessionSnapshot session) => _guard().redirectFor(target, session) as String?;

void main() {
  group('a push deep link keeps its target through the sign-in, the second factor and the tenant, and checks the permission on arrival', () {
    test('signed out: the sign-in carries the exact link and nothing of the record is resolved yet', () {
      final Uri to = Uri.parse(_go(_push, const SessionSnapshot.signedOut())!);
      expect(to.path, '/mob-02');
      expect(to.queryParameters[returnParameter], '/r/$idUnread');
    });

    test('a session that ended, a locked session and a session that owes the second factor each carry the same target', () {
      const SessionSnapshot expired = SessionSnapshot(status: SessionStatus.expired, tenantId: 'tenant-a');
      expect(Uri.parse(_go(_push, expired)!).queryParameters[returnParameter], '/r/$idUnread');

      const SessionSnapshot locked = SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'u1', locked: true);
      final Uri unlock = Uri.parse(_go(_push, locked)!);
      expect(unlock.path, '/mob-02');
      expect(unlock.queryParameters[unlockParameter], '1');
      expect(unlock.queryParameters[returnParameter], '/r/$idUnread');

      const SessionSnapshot step = SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'u1', stepUpRequired: true);
      final Uri second = Uri.parse(_go(_push, step)!);
      expect(second.path, '/mob-03');
      expect(second.queryParameters[returnParameter], '/r/$idUnread');
    });

    test('once signed in to the tenant the same link opens the notification, marked as opened from a push', () {
      const SessionSnapshot signedIn = SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'u1');
      expect(_go(_push, signedIn), '/inbox/mob-33/$idUnread?via=push');
    });

    test('a link issued for another tenant is refused after the sign-in and reveals nothing', () {
      const SessionSnapshot signedIn = SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'u1');
      expect(_go(Uri.parse('/r/$idUnread?tenant=tenant-b'), signedIn), '/projects/mob-45');
    });

    test('whatever else a link carries (a record, an amount) is dropped: the lock screen and the link never show money', () {
      const SessionSnapshot signedIn = SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'u1');
      final String? to = _go(Uri.parse('/r/$idUnread?amount=5000000000&project=p-1'), signedIn);
      expect(to, '/inbox/mob-33/$idUnread?via=push');
      expect(to, isNot(contains('5000000000')));
    });

    test('a target that is not a path of the application is never kept for after the sign-in', () {
      final String? to = _go(Uri.parse('//evil.example/r/$idUnread'), const SessionSnapshot.signedOut());
      expect(to == null || Uri.parse(to).queryParameters[returnParameter] == null, isTrue);
    });
  });
}
