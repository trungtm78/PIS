import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/di/providers.dart';
import 'package:machvon_mobile/core/navigation/deep_link_guard.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/core/widgets/bottom_nav.dart';

import '../support/harness.dart';
import '../support/list_feature.dart';

const GuardTargets _targets = GuardTargets(signIn: '/mob-02', sessionExpired: '/mob-44', accessDenied: '/projects/mob-45');

const SessionSnapshot _signedIn = SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'u1');
const SessionSnapshot _expired = SessionSnapshot(status: SessionStatus.expired, tenantId: 'tenant-a');

SessionDeepLinkGuard _guard() => SessionDeepLinkGuard(targets: _targets, isPublic: (Uri uri) => uri.path.startsWith('/mob-0'));

void main() {
  group('TK-MOB-001-1 the deep-link guard (BR-MOB-05)', () {
    test('a signed-out user is sent to sign-in carrying the wanted location', () {
      final String? to = _guard().redirectFor(Uri.parse('/projects/mob-10/p1?tab=files'), const SessionSnapshot.signedOut());
      final Uri target = Uri.parse(to!);
      expect(target.path, '/mob-02');
      expect(target.queryParameters['return'], '/projects/mob-10/p1?tab=files');
    });

    test('a user whose session ended is sent to the session-expired screen carrying the wanted location', () {
      final Uri target = Uri.parse(_guard().redirectFor(Uri.parse('/approval'), _expired)!);
      expect(target.path, '/mob-44');
      expect(target.queryParameters['return'], '/approval');
    });

    test('a public location opens without a session', () {
      expect(_guard().redirectFor(Uri.parse('/mob-02'), const SessionSnapshot.signedOut()), isNull);
    });

    test('a signed-in user opens any location of the active tenant', () {
      expect(_guard().redirectFor(Uri.parse('/projects/mob-10/p1?tenant=tenant-a'), _signedIn), isNull);
      expect(_guard().redirectFor(Uri.parse('/home'), _signedIn), isNull);
    });

    test('a link issued for another tenant never opens and goes to the access-denied screen', () {
      expect(_guard().redirectFor(Uri.parse('/projects/mob-10/p1?tenant=tenant-b'), _signedIn), '/projects/mob-45');
    });

    test('a link that carries a tenant is refused when the session has none', () {
      const SessionSnapshot noTenant = SessionSnapshot(status: SessionStatus.signedIn);
      expect(_guard().redirectFor(Uri.parse('/home?tenant=tenant-a'), noTenant), '/projects/mob-45');
    });

    test('the location to return to must be a path of this application', () {
      expect(safeReturnLocation('/projects/mob-10/p1?x=1'), '/projects/mob-10/p1?x=1');
      expect(safeReturnLocation(null), isNull);
      expect(safeReturnLocation(''), isNull);
      expect(safeReturnLocation('https://evil.example/'), isNull);
      expect(safeReturnLocation('//evil.example/'), isNull);
      expect(safeReturnLocation(r'/\evil.example'), isNull);
      expect(safeReturnLocation('/a\nb'), isNull);
      expect(safeReturnLocation('/${'a' * 2100}'), isNull);
    });

    test('an unsafe wanted location is not carried to sign-in', () {
      expect(_guard().redirectFor(Uri.parse('//evil.example/x'), const SessionSnapshot.signedOut()), '/mob-02');
    });
  });

  group('TK-MOB-001-1 the guard in front of the router', () {
    testWidgets('a signed-out user who opens a deep link lands on sign-in, and the link is not opened', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final container = await pumpApp(tester, features: const <MobileFeature>[], session: FakeSession(const SessionSnapshot.signedOut()));

      container.read(routerProvider).go('/projects/mob-10/p1');
      await tester.pumpAndSettle();

      expect(Uri.parse(currentLocation(container)).path, '/mob-02');
      expect(Uri.parse(currentLocation(container)).queryParameters['return'], '/projects/mob-10/p1');
      expect(find.byType(AppBottomNav), findsNothing, reason: 'no tabs before sign-in');
      expect(find.textContaining('MOB-02'), findsOneWidget);
    });

    testWidgets('signing out while a protected screen is open leads to sign-in', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final FakeSession session = FakeSession();
      final container = await pumpApp(tester, features: const <MobileFeature>[listFeature], session: session, location: '/projects');
      expect(find.byType(AppBottomNav), findsOneWidget);

      session.change(const SessionSnapshot.signedOut());
      await tester.pumpAndSettle();

      expect(Uri.parse(currentLocation(container)).path, '/mob-02');
      expect(find.byType(AppBottomNav), findsNothing);
    });

    testWidgets('a session that ended leads to the session-expired screen outside the tabs', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final container = await pumpApp(tester, session: FakeSession(_expired));

      expect(Uri.parse(currentLocation(container)).path, '/mob-44');
      expect(find.byType(AppBottomNav), findsNothing);
    });

    testWidgets('a link of another tenant opens the access-denied screen', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final container = await pumpApp(tester, location: '/projects/mob-10/p1?tenant=tenant-b');

      expect(currentLocation(container), '/projects/mob-45');
      expect(find.textContaining('MOB-45'), findsOneWidget);
    });
  });
}
