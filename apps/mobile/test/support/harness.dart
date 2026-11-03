import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/app/app.dart';
import 'package:machvon_mobile/app/app_config.dart';
import 'package:machvon_mobile/core/di/providers.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/offline/attachments/upload_runner.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/offline/queue/queue_runner.dart';
import 'package:machvon_mobile/core/security/device_integrity.dart';
import 'package:machvon_mobile/core/security/integrity_state.dart';
import 'package:machvon_mobile/core/session/session.dart';

/// The three devices of the design: 360x800, the 390x844 reference and 430x932.
const List<Size> kDeviceSizes = <Size>[Size(360, 800), Size(390, 844), Size(430, 932)];

/// A phone with nothing to report: the integrity signals are read at once and say that nothing looks modified. The real source asks
/// the platform over a channel, which a widget test never answers in time, and its time limit would be left pending.
class QuietDevice implements DeviceIntegritySource {
  const QuietDevice();

  @override
  Future<IntegritySignals> read() async => const IntegritySignals();
}

/// The runners of the queue and of the uploads as they stood before the application started them itself: built, but not started, so
/// a test that queues a command and looks at it waiting, or that drives a flush by hand, is not overtaken by a send. The tests of
/// the real start (`test/app/session_services_test.dart`) installs none of them. A world that wants the queue to wait adds [idleRunners] to its overrides.
final List<Override> idleRunners = <Override>[
  queueRunnerProvider.overrideWith((Ref ref) async => QueueRunner(await ref.watch(commandQueueProvider.future))),
  uploadRunnerProvider.overrideWith((Ref ref) async => UploadRunner(await ref.watch(attachmentUploaderProvider.future))),
];

/// A session that is signed in to tenant `tenant-a`.
class FakeSession extends SessionController {
  FakeSession([this.initial = const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1')]);

  final SessionSnapshot initial;

  @override
  SessionSnapshot build() => initial;

  @override
  Future<String?> accessToken() async => initial.isSignedIn ? 'test-token' : null;

  void change(SessionSnapshot next) => state = next;
}

/// A transport that answers from a function and records the calls.
class FakeTransport implements HttpTransport {
  FakeTransport(this.answer);

  final Future<HttpResult> Function(HttpCall call) answer;
  final List<HttpCall> calls = <HttpCall>[];

  @override
  Future<HttpResult> send(HttpCall call) {
    calls.add(call);
    return answer(call);
  }

  static HttpResult json(int status, Object? body, {Map<String, String> headers = const <String, String>{}}) => HttpResult(
        status: status,
        headers: <String, String>{'content-type': 'application/json', ...headers},
        body: jsonEncode(body),
      );
}

final AppConfig testConfig = AppConfig.parse('https://api.test/v1', allowInsecureLoopback: false);

/// Sizes the test view like a phone: [size] logical pixels at pixel ratio 1, [textScale] as the device text scale.
void useDevice(WidgetTester tester, Size size, {double textScale = 1.0}) {
  tester.view.devicePixelRatio = 1.0;
  tester.view.physicalSize = size;
  tester.platformDispatcher.textScaleFactorTestValue = textScale;
  addTearDown(() {
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
    tester.platformDispatcher.clearTextScaleFactorTestValue();
  });
}

/// Starts the whole application on the given features with a signed-in session (override [session] for another one).
Future<ProviderContainer> pumpApp(
  WidgetTester tester, {
  List<MobileFeature> features = const <MobileFeature>[],
  FakeSession? session,
  HttpTransport? transport,
  List<Override> overrides = const <Override>[],
  String? location,
  Locale locale = const Locale('vi'),
}) async {
  tester.platformDispatcher.localeTestValue = locale;
  addTearDown(tester.platformDispatcher.clearLocaleTestValue);
  final ProviderContainer container = ProviderContainer(
    overrides: <Override>[
      appConfigProvider.overrideWithValue(testConfig),
      featuresProvider.overrideWithValue(features),
      deviceIntegritySourceProvider.overrideWithValue(const QuietDevice()),
      sessionProvider.overrideWith(() => session ?? FakeSession()),
      if (transport != null) httpTransportProvider.overrideWithValue(transport),
      ...overrides,
    ],
  );
  addTearDown(container.dispose);
  await tester.pumpWidget(UncontrolledProviderScope(container: container, child: const MachvonApp()));
  await tester.pumpAndSettle();
  if (location != null) {
    container.read(routerProvider).go(location);
    await tester.pumpAndSettle();
  }
  return container;
}

/// Presses the system back button.
Future<void> pressBack(WidgetTester tester) async {
  await tester.binding.handlePopRoute();
  await tester.pumpAndSettle();
}

/// The router location now.
String currentLocation(ProviderContainer container) {
  final GoRouter router = container.read(routerProvider);
  return router.state.uri.toString();
}
