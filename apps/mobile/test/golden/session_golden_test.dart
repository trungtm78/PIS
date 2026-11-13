import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/sync/sync_status.dart';
import 'package:machvon_mobile/core/theme/app_theme.dart';
import 'package:machvon_mobile/features/session/session_providers.dart';
import 'package:machvon_mobile/features/tenant_discovery/tenant_directory.dart';
import 'package:machvon_mobile/features/tenant_discovery/tenant_discovery_feature.dart' as discovery;
import 'package:machvon_mobile/features/tenant_discovery/theme_providers.dart';

import '../features/session/support/app.dart';
import '../features/session/support/world.dart';
import '../support/harness.dart';
import '../support/v2_support.dart';

/// Golden images of the first-impression screens on the v2 frame (MUX-3 wave D): the welcome screen, the sign-in screen, the second factor,
/// the unit and role choice and the session-expired screen, each in the light mode and the dark mode, with the sign-in and the welcome screen
/// also at 200 percent text and the sign-in screen in its offline state. The texts are drawn with the test font, so a difference of the
/// antialiasing between Windows and Linux is accepted up to the tolerance of the text-heavy goldens; layout and touch targets are proved by the
/// widget tests of the screens (`test/features/session`, `test/features/tenant_discovery`).

class _Dark extends ThemeModeNotifier {
  @override
  ThemeMode build() => ThemeMode.dark;
}

class _Pending extends SyncStatusNotifier {
  @override
  SyncStatus build() => const SyncStatus(pendingCommands: 2);
}

class _NotFound implements TenantDirectory {
  @override
  Future<TenantDiscovery> lookup(String codeOrDomain) async => throw const TenantNotFound();
}

const Size _phone = Size(390, 844);

Future<ProviderContainer> _open(
  WidgetTester tester,
  World world, {
  String? location,
  bool dark = false,
  double scale = 1.0,
  bool noConfig = false,
  List<MobileFeature> features = const <MobileFeature>[],
  List<Override> overrides = const <Override>[],
}) {
  useDevice(tester, _phone, textScale: scale);
  return pumpSessionApp(
    tester,
    world,
    location: location,
    noConfig: noConfig,
    features: features,
    overrides: <Override>[if (dark) themeModeProvider.overrideWith(_Dark.new), ...overrides],
  );
}

Future<ProviderContainer> _welcome(WidgetTester tester, World world, {bool dark = false, double scale = 1.0}) => _open(
      tester,
      world,
      location: '/mob-01',
      dark: dark,
      scale: scale,
      noConfig: true,
      features: <MobileFeature>[discovery.feature],
      overrides: <Override>[
        tenantDirectoryProvider.overrideWithValue(_NotFound()),
        secureValueStoreProvider.overrideWithValue(world.store),
        tenantThemeProvider.overrideWith(PublishedTenantTheme.new),
      ],
    );

void main() {
  late World world;

  setUp(() => world = World());
  tearDown(() => world.dispose());

  useTolerantGoldens('test/golden/session_golden_test.dart', tolerance: kTextGoldenTolerance);

  group('MUX-3 wave D the welcome screen (MOB-01)', () {
    testWidgets('light', (WidgetTester tester) async {
      await _welcome(tester, world);
      expect(find.textContaining('Chào mừng đến'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/welcome_light.png'));
    });

    testWidgets('dark', (WidgetTester tester) async {
      await _welcome(tester, world, dark: true);
      expect(Theme.of(tester.element(find.textContaining('Chào mừng đến'))).brightness, Brightness.dark);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/welcome_dark.png'));
    });

    testWidgets('text 200 percent', (WidgetTester tester) async {
      await _welcome(tester, world, scale: 2.0);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/welcome_text200.png'));
    });
  });

  group('MUX-3 wave D the sign-in screen (MOB-02)', () {
    testWidgets('light', (WidgetTester tester) async {
      await _open(tester, world);
      expect(find.text('Đăng nhập'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/sign_in_light.png'));
    });

    testWidgets('dark', (WidgetTester tester) async {
      await _open(tester, world, dark: true);
      expect(Theme.of(tester.element(find.text('Đăng nhập'))).brightness, Brightness.dark);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/sign_in_dark.png'));
    });

    testWidgets('text 200 percent', (WidgetTester tester) async {
      await _open(tester, world, scale: 2.0);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/sign_in_text200.png'));
    });

    testWidgets('offline start: the provider cannot be reached, the screen says so and offers to try again', (WidgetTester tester) async {
      world.idp.reachable = false;
      final ProviderContainer container = await _open(tester, world);
      container.read(reachabilityProvider.notifier).report(Reachability.offline);
      await tapText(tester, 'Đăng nhập bằng SSO');
      await tester.pumpAndSettle();
      expect(find.text('Bạn đang ngoại tuyến'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/sign_in_offline.png'));
    });
  });

  group('MUX-3 wave D the second factor (MOB-03), the unit and role (MOB-04) and the ended session (MOB-44)', () {
    testWidgets('second factor, light', (WidgetTester tester) async {
      world = World(memberships: <String, List<FakeMembership>>{'sub-ana': <FakeMembership>[const FakeMembership('tenant-a', 'UBND Minh Hà', 'm-a1', 'LEADER', requiresMfa: true)]});
      await _open(tester, world);
      await tapText(tester, 'Đăng nhập bằng SSO');
      await tester.pumpAndSettle();
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/second_factor_light.png'));
    });

    testWidgets('unit and role choice, light', (WidgetTester tester) async {
      world = World(memberships: <String, List<FakeMembership>>{
        'sub-ana': <FakeMembership>[tenantAMember, const FakeMembership('tenant-a', 'UBND Minh Hà', 'm-a2', 'INVESTOR_OFFICER')],
      });
      await _open(tester, world);
      await tapText(tester, 'Đăng nhập bằng SSO');
      await tester.pumpAndSettle();
      expect(find.text('Vai trò: INVESTOR_OFFICER'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/context_light.png'));
    });

    Future<void> expired(WidgetTester tester, {bool dark = false}) async {
      await world.service().signIn(kOidcConfig);
      final ProviderContainer container = await _open(tester, world, dark: dark, overrides: <Override>[syncStatusProvider.overrideWith(_Pending.new)]);
      world.api.endAllSessions();
      world.api.selectFailureStatus = 401;
      container.read(authServiceProvider).noteResponse(401, 'SESSION_EXPIRED');
      await tester.pumpAndSettle();
      expect(find.text('Phiên làm việc đã hết hạn'), findsOneWidget);
    }

    testWidgets('session expired, light', (WidgetTester tester) async {
      await expired(tester);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/session_expired_light.png'));
    });

    testWidgets('session expired, dark', (WidgetTester tester) async {
      await expired(tester, dark: true);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/session_expired_dark.png'));
    });
  });
}
