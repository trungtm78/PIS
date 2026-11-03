import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/app/app.dart';
import 'package:machvon_mobile/core/di/providers.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/security/integrity_state.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/features/session/auth/auth_service.dart';
import 'package:machvon_mobile/features/session/auth/oidc_client.dart';
import 'package:machvon_mobile/features/session/session_feature.dart' as session_feature;
import 'package:machvon_mobile/features/session/session_providers.dart';

import '../../../support/harness.dart';
import 'world.dart';

class _FixedConfig extends OidcConfigNotifier {
  _FixedConfig(this.value);

  final OidcConfig? value;

  @override
  OidcConfig? build() => value;
}

/// The application on the real session (`OidcSession` on an `AuthService` wired to the fake provider and API of [world]).
/// [features] are added to the session feature; [lifecycle] lets a test play the app going to the background.
Future<ProviderContainer> pumpSessionApp(
  WidgetTester tester,
  World world, {
  String? location,
  OidcConfig? config,
  bool noConfig = false,
  List<MobileFeature> features = const <MobileFeature>[],
  List<Override> overrides = const <Override>[],
  Stream<AppLifecycleState>? lifecycle,
  Locale locale = const Locale('vi'),
  DateTime Function()? clock,
}) async {
  // An application from an earlier step of the same test is closed and its timers run out before the next one starts.
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump(const Duration(milliseconds: 50));
  tester.platformDispatcher.localeTestValue = locale;
  addTearDown(tester.platformDispatcher.clearLocaleTestValue);
  final ProviderContainer container = ProviderContainer(
    overrides: <Override>[
      appConfigProvider.overrideWithValue(testConfig),
      featuresProvider.overrideWithValue(<MobileFeature>[session_feature.feature, ...features]),
      httpTransportProvider.overrideWithValue(world.transport),
      deviceIntegritySourceProvider.overrideWithValue(const QuietDevice()),
      sessionProvider.overrideWith(OidcSession.new),
      authServiceProvider.overrideWith((Ref ref) {
        final AuthService service = world.service();
        ref.onDispose(service.dispose);
        return service;
      }),
      oidcConfigProvider.overrideWith(() => _FixedConfig(noConfig ? null : config ?? kOidcConfig)),
      appLifecycleProvider.overrideWithValue(lifecycle ?? const Stream<AppLifecycleState>.empty()),
      sessionClockProvider.overrideWithValue(clock ?? world.clock),
      ...overrides,
    ],
  );
  addTearDown(container.dispose);
  // As the application root does: the stored session is restored before the first screen is chosen.
  await container.read(authServiceProvider).ready;
  await tester.pumpWidget(UncontrolledProviderScope(container: container, child: const MachvonApp()));
  await tester.pumpAndSettle();
  if (location != null) {
    container.read(routerProvider).go(location);
    await tester.pumpAndSettle();
  }
  return container;
}

/// The screen contract checks of the design (UI-MOB-nn): no layout exception at the three devices and at 200 percent text,
/// every tap target large enough on both platforms and labelled, and the text readable. [open] opens the screen.
Future<void> expectScreenContract(WidgetTester tester, Future<void> Function() open) async {
  for (final Size size in kDeviceSizes) {
    for (final double scale in <double>[1.0, 2.0]) {
      useDevice(tester, size, textScale: scale);
      final SemanticsHandle semantics = tester.ensureSemantics();
      await open();
      final String where = '${size.width.toInt()}x${size.height.toInt()} at $scale';
      expect(tester.takeException(), isNull, reason: where);
      try {
        debugDefaultTargetPlatformOverride = TargetPlatform.android;
        await expectLater(tester, meetsGuideline(androidTapTargetGuideline), reason: where);
        debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
        await expectLater(tester, meetsGuideline(iOSTapTargetGuideline), reason: where);
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
      await expectLater(tester, meetsGuideline(labeledTapTargetGuideline), reason: where);
      await expectLater(tester, meetsGuideline(textContrastGuideline), reason: where);
      semantics.dispose();
    }
  }
}

/// Scrolls the text into view (at 200 percent text a button can be below the fold) and taps it.
Future<void> tapText(WidgetTester tester, String text) async {
  await tester.ensureVisible(find.text(text));
  await tester.pump();
  await tester.tap(find.text(text));
  await tester.pump();
}
