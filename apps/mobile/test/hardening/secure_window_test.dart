import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/navigation/mobile_routes.generated.dart';
import 'package:machvon_mobile/core/navigation/route_catalogue.dart';
import 'package:machvon_mobile/core/navigation/route_policy.dart';
import 'package:machvon_mobile/core/security/secure_screen.dart';
import 'package:machvon_mobile/core/security/secure_window.dart';
import 'package:machvon_mobile/features/registry.generated.dart';

import '../support/harness.dart';

/// The platform side as a list of what it was asked.
class RecordingPlatform implements SecureWindowPlatform {
  final List<bool> calls = <bool>[];
  bool answer = true;

  @override
  Future<bool> setSecure({required bool enabled}) async {
    calls.add(enabled);
    return answer;
  }
}

const MobileFeature _secureFeature = MobileFeature(
  id: 'test_secure',
  screens: <ScreenSpec>[
    ScreenSpec(screenId: 'MOB-23', builder: _approvals),
    ScreenSpec(screenId: 'MOB-24', pathSuffix: '/:taskId', builder: _approvalDetail),
    ScreenSpec(screenId: 'MOB-09', builder: _projects),
    ScreenSpec(screenId: 'MOB-10', pathSuffix: '/:projectId', builder: _projectDetail),
  ],
);

Widget _approvals(BuildContext context, ScreenContext screen) => Scaffold(
      body: TextButton(onPressed: () => context.go('/approval/mob-24/t1'), child: const Text('open task')),
    );
Widget _approvalDetail(BuildContext context, ScreenContext screen) => const Scaffold(body: Text('task detail'));
Widget _projects(BuildContext context, ScreenContext screen) => const Scaffold(body: Text('projects'));
Widget _projectDetail(BuildContext context, ScreenContext screen) => const Scaffold(body: Text('project detail'));

String _read(String path) => File(path).readAsStringSync();

void main() {
  group('AC-ST-MOB-041-1 SEC-04 D-SEC-03 the channel to the platform', () {
    const MethodChannel channel = MethodChannel(kSecureWindowChannel);

    setUp(() => TestWidgetsFlutterBinding.ensureInitialized());
    tearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null));

    test('set carries enabled as a boolean, on the channel both platforms listen on', () async {
      final List<MethodCall> seen = <MethodCall>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (MethodCall call) async {
        seen.add(call);
        return null;
      });
      const MethodChannelSecureWindow platform = MethodChannelSecureWindow();
      expect(await platform.setSecure(enabled: true), isTrue);
      expect(await platform.setSecure(enabled: false), isTrue);
      expect(seen.map((MethodCall c) => c.method), <String>['set', 'set']);
      expect(seen.map((MethodCall c) => c.arguments), <Object>[
        <String, Object>{'enabled': true},
        <String, Object>{'enabled': false},
      ]);
      expect(kSecureWindowChannel, 'vn.machvon/secure_window');
    });

    test('a host with no platform side, and a platform that refuses, answer "not applied" and never throw', () async {
      const MethodChannelSecureWindow platform = MethodChannelSecureWindow();
      expect(await platform.setSecure(enabled: true), isFalse, reason: 'no handler: MissingPluginException');
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (MethodCall call) async => throw PlatformException(code: 'NO_WINDOW'));
      expect(await platform.setSecure(enabled: true), isFalse);
    });
  });

  group('AC-ST-MOB-041-1 SEC-04 D-SEC-03 the protection is held while at least one sensitive screen is shown', () {
    test('two screens on top of each other: the protection goes on once and off when the last one is gone', () async {
      final RecordingPlatform platform = RecordingPlatform();
      final SecureWindowController controller = SecureWindowController(platform);
      final void Function() first = controller.acquire();
      final void Function() second = controller.acquire();
      await controller.settled;
      expect(platform.calls, <bool>[true]);
      expect(controller.holders, 2);

      first();
      await controller.settled;
      expect(platform.calls, <bool>[true], reason: 'one screen still needs it');
      first();
      expect(controller.holders, 1, reason: 'giving it back twice counts once');

      second();
      await controller.settled;
      expect(platform.calls, <bool>[true, false]);
      expect(controller.holders, 0);
    });

    test('a quick on and off reaches the platform in the same order, and applied tells whether the last request got through', () async {
      final RecordingPlatform platform = RecordingPlatform()..answer = false;
      final SecureWindowController controller = SecureWindowController(platform);
      controller.acquire()();
      final void Function() again = controller.acquire();
      await controller.settled;
      expect(platform.calls, <bool>[true, false, true]);
      expect(controller.applied, isFalse, reason: 'the platform did not do it: the content of the screen is not protected here');
      platform.answer = true;
      again();
      await controller.settled;
      expect(controller.applied, isTrue);
    });
  });

  group('AC-ST-MOB-041-1 SEC-04 D-SEC-03 the screens of money and decisions switch it on, the others do not', () {
    testWidgets('an approval screen holds it, an ordinary tab releases it, coming back holds it again, and a detail on top keeps it', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final RecordingPlatform platform = RecordingPlatform();
      final container = await pumpApp(
        tester,
        features: const <MobileFeature>[_secureFeature],
        overrides: <Override>[secureWindowPlatformProvider.overrideWithValue(platform)],
        location: '/approval',
      );
      final SecureWindowController controller = container.read(secureWindowControllerProvider);
      await controller.settled;
      expect(find.text('open task'), findsOneWidget);
      expect(platform.calls, <bool>[true]);

      await tester.tap(find.text('Dự án'));
      await tester.pumpAndSettle();
      await controller.settled;
      expect(find.text('projects'), findsOneWidget);
      expect(platform.calls, <bool>[true, false], reason: 'the approval tab is built but not shown: the projects must not be hidden');

      await tester.tap(find.text('Phê duyệt'));
      await tester.pumpAndSettle();
      await controller.settled;
      expect(platform.calls, <bool>[true, false, true]);

      await tester.tap(find.text('open task'));
      await tester.pumpAndSettle();
      await controller.settled;
      expect(find.text('task detail'), findsOneWidget);
      expect(controller.holders, 1, reason: 'the detail replaced the list: one holder, and the protection was never dropped in between except by the list leaving');
      expect(platform.calls.last, isTrue);
    });

    testWidgets('an ordinary screen never asks', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final RecordingPlatform platform = RecordingPlatform();
      final container = await pumpApp(
        tester,
        features: const <MobileFeature>[_secureFeature],
        overrides: <Override>[secureWindowPlatformProvider.overrideWithValue(platform)],
        location: '/projects',
      );
      await container.read(secureWindowControllerProvider).settled;
      expect(find.text('projects'), findsOneWidget);
      expect(platform.calls, isEmpty);
    });

    testWidgets('SecureScreen alone: shown holds, removed releases', (WidgetTester tester) async {
      final RecordingPlatform platform = RecordingPlatform();
      final container = await pumpApp(tester, overrides: <Override>[secureWindowPlatformProvider.overrideWithValue(platform)]);
      final SecureWindowController controller = container.read(secureWindowControllerProvider);
      expect(controller.holders, 0);
      await tester.pumpWidget(
        ProviderScope(
          overrides: <Override>[secureWindowControllerProvider.overrideWithValue(controller)],
          child: const MaterialApp(home: SecureScreen(child: Text('amounts'))),
        ),
      );
      expect(controller.holders, 1);
      await tester.pumpWidget(const SizedBox.shrink());
      expect(controller.holders, 0);
    });

    test('the sensitive screens are all screens of the catalogue and all have an implementation', () {
      final Set<String> catalogue = kMobileRoutes.map((MobileRoute r) => r.id).toSet();
      final Set<String> implemented = <String>{
        for (final MobileFeature feature in kAllFeatures)
          for (final ScreenSpec spec in feature.screens) spec.screenId,
      };
      expect(kSecureScreenIds.difference(catalogue), isEmpty);
      expect(kSecureScreenIds.difference(implemented), isEmpty, reason: 'a protected screen that does not exist protects nothing');
      expect(kSecureScreenIds, containsAll(<String>['MOB-23', 'MOB-24', 'MOB-25', 'MOB-26', 'MOB-67', 'DOC-22', 'MOB-27', 'MOB-60', 'MOB-14', 'MOB-20']));
    });
  });

  group('AC-ST-MOB-041-1 SEC-04 D-SEC-03 the platform side exists on both platforms and answers on the same channel', () {
    test('Android flags the window secure and clears the flag, on the channel of the Dart service', () {
      final String activity = _read('android/app/src/main/kotlin/vn/machvon/machvon_mobile/MainActivity.kt');
      expect(activity, contains('"$kSecureWindowChannel"'));
      expect(activity, contains('WindowManager.LayoutParams.FLAG_SECURE'));
      expect(activity, contains('window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)'));
      expect(activity, contains('window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)'));
      expect(activity, contains('"set"'));
      expect(activity, contains('"enabled"'));
    });

    test('iOS covers the window when the scene leaves the foreground and while the screen is captured, only while the protection is on', () {
      final String app = _read('ios/Runner/AppDelegate.swift');
      final String scene = _read('ios/Runner/SceneDelegate.swift');
      expect(scene, contains('"$kSecureWindowChannel"'));
      expect(scene, contains('UIScene.willDeactivateNotification'));
      expect(scene, contains('UIScene.didActivateNotification'));
      expect(scene, contains('UIScreen.capturedDidChangeNotification'));
      expect(scene, contains('isCaptured'));
      expect(scene, contains('"set"'));
      expect(scene, contains('"enabled"'));
      expect(app, contains('SecureWindow'), reason: 'the channel is registered when the engine starts');
    });
  });
}
