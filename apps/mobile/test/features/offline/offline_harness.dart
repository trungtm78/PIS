import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/features/offline/offline_feature.dart' as offline;

import '../../support/fake_sync_server.dart';
import '../../support/harness.dart';
import '../../support/queue_rig.dart';

/// A phone as tall as the longest screen, so that a list built lazily is built whole and a test can read all of it.
const Size kTallDevice = Size(390, 2600);

/// The application on the offline feature, with the real encrypted store and queue of [rig] and the fake sync server as
/// the network. The rig is made before the application starts, so a test can leave commands in any state first.
Future<ProviderContainer> openOfflineApp(
  WidgetTester tester,
  QueueRig rig, {
  required String location,
  FakeSession? session,
  Locale locale = const Locale('vi'),
  List<Override> overrides = const <Override>[],
}) async {
  rig.store.deviceId = '11111111-1111-4111-8111-111111111111';
  final ProviderContainer container = await pumpApp(
    tester,
    features: <MobileFeature>[offline.feature],
    session: session,
    transport: rig.server,
    overrides: <Override>[offlineStorageProvider.overrideWithValue(rig.storage.storage), ...idleRunners, ...overrides],
    location: location,
    locale: locale,
  );
  return container;
}

/// A rig whose clock is the real one, because the application under test uses the real one.
Future<QueueRig> realClockRig({FakeSyncServer? server}) => QueueRig.create(server: server, clock: FakeClock(DateTime.now()));

/// Opens the screen on a fresh rig, for the contract checks that open the same screen many times.
typedef OpenOffline = Future<void> Function(WidgetTester tester);

/// The checks every screen of the application keeps (docs/mobile-foundation.md, Tests): no layout exception at the three
/// devices and at 200 percent text, tap targets large enough on both platforms and labelled, and readable text.
Future<void> expectScreenContract(WidgetTester tester, OpenOffline open) async {
  for (final Size size in kDeviceSizes) {
    for (final double scale in <double>[1.0, 2.0]) {
      useDevice(tester, size, textScale: scale);
      final SemanticsHandle semantics = tester.ensureSemantics();
      await open(tester);
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

/// Holds a future back until the test lets it go, to see the loading state.
class Gate {
  final Completer<void> _open = Completer<void>();

  Future<void> get passed => _open.future;

  void open() => _open.complete();
}
