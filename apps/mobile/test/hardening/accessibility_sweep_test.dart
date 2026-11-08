import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/navigation/mobile_routes.generated.dart';
import 'package:machvon_mobile/core/navigation/route_catalogue.dart';
import 'package:machvon_mobile/core/navigation/route_policy.dart';
import 'package:machvon_mobile/core/navigation/route_table.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/features/registry.generated.dart';
import 'package:machvon_mobile/features/session/auth/oidc_client.dart';
import 'package:machvon_mobile/features/session/session_providers.dart';

import '../features/support/scripted_server.dart';
import '../support/harness.dart';

/// The identity provider of the tenant is known, so that the sign-in screen is shown and not the tenant discovery before it.
class _SignInConfig extends OidcConfigNotifier {
  @override
  OidcConfig? build() => OidcConfig.parse(issuer: 'https://idp.test/realms/machvon', clientId: 'machvon-mobile');
}

/// The path parameters every screen of the registry is opened with: a well-formed identifier that exists nowhere, so the server
/// answers "not found" and the screen shows what it shows when its record cannot be had.
const String _anyId = '00000000-0000-4000-8000-000000000001';

/// Every screen the features register, with the location it opens at.
List<({String screenId, String location})> _registeredScreens() {
  final RouteTable table = RouteTable(routes: kMobileRoutes, features: kAllFeatures);
  return <({String screenId, String location})>[
    for (final MobileFeature feature in kAllFeatures)
      for (final ScreenSpec spec in feature.screens)
        (
          screenId: spec.screenId,
          location: table.locationOf(spec.screenId) + spec.pathSuffix.replaceAll(RegExp(r':[a-zA-Z]+'), _anyId),
        ),
  ]..sort((a, b) => a.screenId.compareTo(b.screenId));
}

/// The session a screen is opened under: the screens that open without one are opened signed out, the others signed in.
FakeSession _sessionFor(String screenId) => isPublicScreen(screenId)
    ? FakeSession(const SessionSnapshot(status: SessionStatus.signedOut))
    : FakeSession();

/// The checks of the design (UI-MOB-nn) applied to what is on the screen now, on both platforms.
Future<void> _expectAccessible(WidgetTester tester, String where) async {
  expect(tester.takeException(), isNull, reason: where);
  try {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline), reason: '$where: 48 dp on Android');
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    await expectLater(tester, meetsGuideline(iOSTapTargetGuideline), reason: '$where: 44 pt on iOS');
  } finally {
    debugDefaultTargetPlatformOverride = null;
  }
  await expectLater(tester, meetsGuideline(labeledTapTargetGuideline), reason: '$where: every control has a name');
  await expectLater(tester, meetsGuideline(textContrastGuideline), reason: '$where: contrast');
}

/// The plugins the application reads at start have no implementation on the host: a missing one answers 'nothing stored'.
void installPlatformChannelStubs() {
  final TestDefaultBinaryMessenger messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  messenger.setMockMethodCallHandler(const MethodChannel('plugins.it_nomads.com/flutter_secure_storage'), (MethodCall call) async {
    return call.method == 'readAll' ? <String, String>{} : null;
  });
  addTearDown(() => messenger.setMockMethodCallHandler(const MethodChannel('plugins.it_nomads.com/flutter_secure_storage'), null));
}

/// The screens none of whose test files both name the screen and check the guidelines.
List<String> _screensWithoutAccessibilityTest(Iterable<String> screenIds, List<String> testTexts) => <String>[
      for (final String id in screenIds)
        if (!testTexts.any((String text) => text.contains(id) && RegExp(r'meetsGuideline|expectScreenContract').hasMatch(text))) id,
    ];

String _repoFile(String relative) => '../../$relative';

void main() {
  setUp(installPlatformChannelStubs);
  final List<({String screenId, String location})> screens = _registeredScreens();

  group('AC-ST-MOB-040-1 UAT-NFR-ACCESSIBILITY-02 the registry: every screen of the catalogue is implemented', () {
    test('NAV-02 FIXED: all 76 screens of the navigation (71 MOB, QMS-09, QMS-10, DOC-22, DOC-23, DIR-06) are registered, the four web screens QMS-09, QMS-10, DOC-22 and DOC-23 and DIR-06 included', () {
      final Set<String> registered = screens.map((s) => s.screenId).toSet();
      expect(screens, hasLength(registered.length), reason: 'a screen is registered once');
      final Set<String> missing = kMobileRoutes.map((MobileRoute r) => r.id).toSet().difference(registered);
      expect(missing, isEmpty);
      expect(registered, hasLength(76));
      expect(registered, containsAll(<String>['QMS-09', 'QMS-10', 'DOC-22', 'DOC-23', 'DIR-06']));
    });

    test('every registered screen is named in a test file that also checks tap targets and labels (a new screen cannot ship without one)', () {
      final List<String> texts = Directory('test')
          .listSync(recursive: true)
          .whereType<File>()
          .where((File f) => f.path.endsWith('.dart') && !f.path.replaceAll(r'\', '/').contains('test/hardening/'))
          .map((File f) => f.readAsStringSync())
          .toList();
      expect(_screensWithoutAccessibilityTest(screens.map((s) => s.screenId), texts), isEmpty, reason: 'screens whose tests never check the accessibility guidelines');
    });

    test('that scan can be red: a screen named in no file, or only in a file that checks nothing, is reported', () {
      const List<String> texts = <String>[
        "group('UI-MOB-07', () { meetsGuideline(androidTapTargetGuideline); });",
        "group('UI-MOB-09 only a title', () {});",
        "meetsGuideline(labeledTapTargetGuideline); // no screen id here",
      ];
      expect(_screensWithoutAccessibilityTest(<String>['MOB-07', 'MOB-09', 'MOB-23'], texts), <String>['MOB-09', 'MOB-23']);
    });
  });

  for (final ({String screenId, String location}) screen in screens) {
    group('AC-ST-MOB-040-1 AC-ST-DIS-017-5 UAT-NFR-ACCESSIBILITY-02 UI-${screen.screenId} opens at 200 percent text and at the reference size with names, 48 dp targets and contrast', () {
      testWidgets('without its record: no overflow, no unnamed control, no small target', (WidgetTester tester) async {
        for (final ({Size size, double scale}) device in const <({Size size, double scale})>[
          (size: Size(360, 800), scale: 2.0),
          (size: Size(390, 844), scale: 1.0),
        ]) {
          useDevice(tester, device.size, textScale: device.scale);
          final SemanticsHandle semantics = tester.ensureSemantics();
          final ProviderContainer container = await pumpApp(
            tester,
            features: kAllFeatures,
            session: _sessionFor(screen.screenId),
            transport: ScriptedServer(),
            overrides: <Override>[oidcConfigProvider.overrideWith(_SignInConfig.new)],
            location: screen.location,
          );
          final String where = '${screen.screenId} ${device.size.width.toInt()}x${device.size.height.toInt()} at ${device.scale}';
          expect(currentLocation(container).split('?').first, screen.location, reason: '$where: the screen opened where it is registered');
          final BuildContext inApp = tester.element(find.byType(Scaffold).first);
          expect(MediaQuery.textScalerOf(inApp).scale(10), 10 * device.scale, reason: '$where: the text scale of the device reaches the screen unclamped');
          await _expectAccessible(tester, where);
          semantics.dispose();
          await tester.pumpWidget(const SizedBox.shrink());
          container.dispose();
          await tester.pump(const Duration(milliseconds: 50));
        }
      });
    });
  }

  group('AC-ST-MOB-040-1 the design rules the sweep stands on are in the sources', () {
    test('the foundation honours the device text scale without a clamp (200 percent text)', () {
      final String app = File('lib/app/app.dart').readAsStringSync();
      expect(app, isNot(contains('TextScaler.noScaling')));
      expect(app, isNot(contains('textScaleFactor:')));
      expect(app, isNot(contains('TextScaler.linear')));
      expect(app, isNot(contains('.clamp(')));
      expect(File(_repoFile('docs/mobile-foundation.md')).readAsStringSync(), contains('honoured without a clamp'));
    });
  });
}
