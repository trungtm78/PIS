import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/di/providers.dart';
import 'package:machvon_mobile/core/navigation/route_policy.dart';
import 'package:machvon_mobile/core/release/release_notice.dart';
import 'package:machvon_mobile/core/security/device_integrity.dart';
import 'package:machvon_mobile/core/security/integrity_gate.dart';
import 'package:machvon_mobile/core/security/integrity_state.dart';
import 'package:machvon_mobile/core/security/pinning_policy.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/features/release/app_info.dart';
import 'package:machvon_mobile/features/release/integrity_monitor.dart';
import 'package:machvon_mobile/features/release/release_providers.dart';
import 'package:machvon_mobile/features/release/telemetry.dart';
import 'package:machvon_mobile/features/release/version_policy.dart';
import 'package:machvon_mobile/features/session/auth/auth_service.dart';
import 'package:machvon_mobile/features/session/session_providers.dart';

import '../features/session/support/world.dart';
import '../support/harness.dart';

class _Source implements DeviceIntegritySource {
  _Source(this.signals);

  IntegritySignals signals;
  Object? failure;
  Completer<IntegritySignals>? hold;
  int reads = 0;

  @override
  Future<IntegritySignals> read() async {
    reads += 1;
    final Object? error = failure;
    if (error != null) throw error;
    return hold == null ? signals : hold!.future;
  }
}

const AppInfo _app = AppInfo(version: '1.4.0', build: '27', platform: 'android', osVersion: '14');

class _AppSource implements AppInfoSource {
  @override
  Future<AppInfo> read() async => _app;
}

class _PolicySource implements VersionPolicySource {
  _PolicySource(this.policy);

  VersionPolicy policy;

  @override
  Future<VersionPolicy> fetch(AppInfo app) async => policy;
}

ProviderContainer _container({
  required _Source source,
  FakeSession? session,
  BufferedTelemetrySink? sink,
  List<Override> overrides = const <Override>[],
}) {
  final ProviderContainer container = ProviderContainer(
    overrides: <Override>[
      sessionProvider.overrideWith(() => session ?? FakeSession()),
      deviceIntegritySourceProvider.overrideWithValue(source),
      if (sink != null) telemetrySinkProvider.overrideWithValue(sink),
      ...overrides,
    ],
  );
  addTearDown(container.dispose);
  return container;
}

const IntegritySignals _rooted = IntegritySignals(rooted: true);

void main() {
  group('AC-ST-MOB-041-1 INTEG-01 D-SEC-01 the platform port', () {
    const MethodChannel channel = MethodChannel(kDeviceIntegrityChannel);

    setUp(() => TestWidgetsFlutterBinding.ensureInitialized());
    tearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null));

    void answer(Object? Function() body) =>
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (MethodCall call) async => call.method == 'read' ? body() : null);

    test('the five signals of the platform become the signals of the policy', () async {
      answer(() => <String, Object>{'rooted': true, 'jailbroken': false, 'debuggerAttached': true, 'hookingFramework': false, 'emulator': true});
      final IntegritySignals signals = await const MethodChannelIntegritySource().read();
      expect(signals.available, isTrue);
      expect(signals.rooted, isTrue);
      expect(signals.jailbroken, isFalse);
      expect(signals.debuggerAttached, isTrue);
      expect(signals.hookingFramework, isFalse);
      expect(signals.emulator, isTrue);
      expect(kDeviceIntegrityChannel, 'vn.machvon/device_integrity');
    });

    test('a platform with no such side, an error, nothing, or an answer that is not the five booleans is unknown, and never throws', () async {
      expect((await const MethodChannelIntegritySource().read()).available, isFalse, reason: 'MissingPluginException on a host');
      answer(() => throw PlatformException(code: 'BROKEN'));
      expect((await const MethodChannelIntegritySource().read()).available, isFalse);
      answer(() => null);
      expect((await const MethodChannelIntegritySource().read()).available, isFalse);
      answer(() => <String, Object>{'rooted': true});
      expect((await const MethodChannelIntegritySource().read()).available, isFalse, reason: 'a missing signal is not "false"');
      answer(() => <String, Object>{'rooted': 'yes', 'jailbroken': false, 'debuggerAttached': false, 'hookingFramework': false, 'emulator': false});
      expect((await const MethodChannelIntegritySource().read()).available, isFalse);
    });

    test('the native sides read the signals on the same channel', () {
      expect(_read('android/app/src/main/kotlin/vn/machvon/machvon_mobile/MainActivity.kt'), allOf(contains('"$kDeviceIntegrityChannel"'), contains('"read"'), contains('"hookingFramework"')));
      expect(_read('ios/Runner/AppDelegate.swift'), allOf(contains('"$kDeviceIntegrityChannel"'), contains('"read"'), contains('"hookingFramework"'), contains('isExcludedFromBackup')));
    });
  });

  group('AC-ST-MOB-041-1 INTEG-01 D-SEC-01 the tenant mode comes from the version policy and is warn until the server says otherwise', () {
    test('integrity_mode and pinning_mode are read; absent or unknown values are warn and null', () {
      VersionPolicy parse(Map<String, Object?> extra) => VersionPolicy.tryParse(<String, Object?>{'status': 'ok', ...extra})!;
      expect(parse(<String, Object?>{}).integrityMode, IntegrityMode.warn);
      expect(parse(<String, Object?>{}).pinningMode, isNull);
      expect(parse(<String, Object?>{'integrity_mode': 'off'}).integrityMode, IntegrityMode.off);
      expect(parse(<String, Object?>{'integrity_mode': 'restrict_sensitive'}).integrityMode, IntegrityMode.restrictSensitive);
      expect(parse(<String, Object?>{'integrity_mode': 'block'}).integrityMode, IntegrityMode.warn, reason: 'there is no mode that blocks');
      expect(parse(<String, Object?>{'integrity_mode': 7}).integrityMode, IntegrityMode.warn);
      expect(parse(<String, Object?>{'pinning_mode': 'off'}).pinningMode, PinningMode.off);
      expect(parse(<String, Object?>{'pinning_mode': 'report_only'}).pinningMode, PinningMode.reportOnly);
      expect(parse(<String, Object?>{'pinning_mode': 'enforce'}).pinningMode, PinningMode.enforce);
      expect(parse(<String, Object?>{'pinning_mode': 'strict'}).pinningMode, isNull);
    });

    test('the check of the version policy sets the mode and the pinning request, and the pinning policy in force can only be relaxed', () async {
      final ProviderContainer container = ProviderContainer(overrides: <Override>[
        sessionProvider.overrideWith(() => FakeSession(const SessionSnapshot.signedOut())),
        appInfoSourceProvider.overrideWithValue(_AppSource()),
        versionPolicySourceProvider.overrideWithValue(
          _PolicySource(const VersionPolicy(integrityMode: IntegrityMode.restrictSensitive, pinningMode: PinningMode.enforce)),
        ),
        releaseNoticeProvider.overrideWith(PolicyReleaseNotice.new),
      ]);
      addTearDown(container.dispose);
      expect(container.read(integrityModeProvider), IntegrityMode.warn);
      expect(container.read(pinningPolicyProvider).mode, PinningMode.off);

      await (container.read(releaseNoticeProvider.notifier) as PolicyReleaseNotice).check();

      expect(container.read(integrityModeProvider), IntegrityMode.restrictSensitive);
      expect(container.read(remotePinningModeProvider), PinningMode.enforce);
      expect(container.read(pinningPolicyProvider).mode, PinningMode.off, reason: 'a server can lower the pinning of the build and never raise it');
      expect(container.read(pinningPolicyProvider), same(kPinningPolicy));
    });
  });

  group('AC-ST-MOB-041-1 INTEG-01 D-SEC-01 the assessment of the phone once per session, with the signals counted and nothing else', () {
    test('a rooted phone under warn: the decision warns, one device.integrity event with the reason code, and the tenant is the only other field', () async {
      final BufferedTelemetrySink sink = BufferedTelemetrySink();
      final ProviderContainer container = _container(source: _Source(_rooted), sink: sink);
      await container.read(integrityMonitorProvider.future);

      final IntegrityStatus status = container.read(integrityProvider);
      expect(status.decision.level, IntegrityLevel.warn);
      expect(status.warningVisible, isTrue);
      expect(sink.events.map((TelemetryEvent e) => e.toJson()), <Map<String, Object>>[
        <String, Object>{'name': 'device.integrity', 'tenant_id': 'tenant-a', 'reason_code': 'DEVICE_ROOTED'},
      ]);
    });

    test('an ordinary phone reports nothing and warns nobody', () async {
      final BufferedTelemetrySink sink = BufferedTelemetrySink();
      final ProviderContainer container = _container(source: _Source(const IntegritySignals()), sink: sink);
      await container.read(integrityMonitorProvider.future);
      expect(container.read(integrityProvider).decision.level, IntegrityLevel.proceed);
      expect(container.read(integrityProvider).warningVisible, isFalse);
      expect(sink.events, isEmpty);
    });

    test('a detector that throws, or does not answer, is unknown: the application goes on and the unknown is counted', () async {
      final BufferedTelemetrySink sink = BufferedTelemetrySink();
      final _Source broken = _Source(_rooted)..failure = StateError('detector');
      final ProviderContainer container = _container(source: broken, sink: sink);
      await container.read(integrityMonitorProvider.future);
      expect(container.read(integrityProvider).decision.level, IntegrityLevel.proceed);
      expect(sink.events.single.attributes['reason_code'], 'INTEGRITY_UNKNOWN');
    });

    test('the mode of the tenant decides: off is silent, restrict_sensitive restricts; a change of mode updates the decision and does not count the phone twice', () async {
      final BufferedTelemetrySink sink = BufferedTelemetrySink();
      final ProviderContainer container = _container(source: _Source(_rooted), sink: sink);
      container.listen<AsyncValue<void>>(integrityMonitorProvider, (AsyncValue<void>? previous, AsyncValue<void> next) {});
      container.read(integrityModeProvider.notifier).set(IntegrityMode.off);
      await container.read(integrityMonitorProvider.future);
      expect(container.read(integrityProvider).decision.level, IntegrityLevel.proceed);
      expect(container.read(integrityProvider).warningVisible, isFalse);
      expect(sink.events, hasLength(1), reason: 'the phone is counted whatever the mode');

      container.read(integrityModeProvider.notifier).set(IntegrityMode.restrictSensitive);
      await container.read(integrityMonitorProvider.future);
      final IntegrityDecision decision = container.read(integrityProvider).decision;
      expect(decision.level, IntegrityLevel.restrict);
      expect(decision.restricts(IntegrityRestriction.approvals), isTrue);
      expect(decision.restricts(IntegrityRestriction.signing), isTrue);
      expect(decision.restricts(IntegrityRestriction.biometricUnlock), isTrue);
      expect(decision.blocksUse, isFalse);
      expect(sink.events, hasLength(1), reason: 'the second look in the same session is not a second phone');
    });

    test('nobody signed in: nothing is read and nothing is known', () async {
      final _Source source = _Source(_rooted);
      final ProviderContainer container = _container(source: source, session: FakeSession(const SessionSnapshot.signedOut()));
      await container.read(integrityMonitorProvider.future);
      expect(source.reads, 0);
      expect(container.read(integrityProvider).assessed, isFalse);
    });

    test('the person closes the notice and it does not come back in the session; a new session starts afresh', () async {
      final FakeSession session = FakeSession();
      final ProviderContainer container = _container(source: _Source(_rooted), session: session);
      container.listen<AsyncValue<void>>(integrityMonitorProvider, (AsyncValue<void>? previous, AsyncValue<void> next) {});
      await container.read(integrityMonitorProvider.future);
      expect(container.read(integrityProvider).warningVisible, isTrue);
      container.read(integrityProvider.notifier).dismissWarning();
      expect(container.read(integrityProvider).warningVisible, isFalse);
      container.read(integrityModeProvider.notifier).set(IntegrityMode.restrictSensitive);
      await container.read(integrityMonitorProvider.future);
      expect(container.read(integrityProvider).warningVisible, isFalse, reason: 'told once');

      session.change(const SessionSnapshot.signedOut());
      await pumpEventQueue();
      expect(container.read(integrityProvider).assessed, isFalse);
      session.change(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1'));
      await container.read(integrityMonitorProvider.future);
      expect(container.read(integrityProvider).warningVisible, isTrue);
    });
  });

  group('AC-ST-MOB-041-1 INTEG-01 D-SEC-01 restrict_sensitive: approvals, signing and the biometric unlock need the second factor first', () {
    testWidgets('a restricted phone on an approval screen asks for the step-up once; an unrestricted phone, or a session at the second level, is not interrupted', (WidgetTester tester) async {
      int asked = 0;
      Future<ProviderContainer> show({required bool restricted, AssuranceLevel assurance = AssuranceLevel.aal1}) async {
        await tester.pumpWidget(const SizedBox.shrink()); // a screen opened afresh: the same State is not reused
        asked = 0;
        final ProviderContainer container = ProviderContainer(overrides: <Override>[
          sessionProvider.overrideWith(() => FakeSession(SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1', assurance: assurance))),
          secondFactorRequesterProvider.overrideWithValue(() => asked += 1),
        ]);
        addTearDown(container.dispose);
        if (restricted) container.read(integrityProvider.notifier).apply(decideIntegrity(_rooted, IntegrityMode.restrictSensitive, releaseBuild: true));
        await tester.pumpWidget(UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(home: IntegrityStepUp(restriction: IntegrityRestriction.approvals, child: Text('confirm'))),
        ));
        await tester.pump();
        return container;
      }

      await show(restricted: true);
      expect(find.text('confirm'), findsOneWidget, reason: 'the screen is shown; the router moves the person to MOB-03');
      expect(asked, 1);
      await show(restricted: false);
      expect(asked, 0);
      await show(restricted: true, assurance: AssuranceLevel.aal2);
      expect(asked, 0);
    });

    testWidgets('the decision arrives after the screen was shown: the step-up is asked then', (WidgetTester tester) async {
      int asked = 0;
      final ProviderContainer container = ProviderContainer(overrides: <Override>[
        sessionProvider.overrideWith(() => FakeSession()),
        secondFactorRequesterProvider.overrideWithValue(() => asked += 1),
      ]);
      addTearDown(container.dispose);
      await tester.pumpWidget(UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(home: IntegrityStepUp(restriction: IntegrityRestriction.signing, child: Text('sign'))),
      ));
      await tester.pump();
      expect(asked, 0);
      container.read(integrityProvider.notifier).apply(decideIntegrity(_rooted, IntegrityMode.restrictSensitive, releaseBuild: true));
      await tester.pump();
      expect(asked, 1);
    });

    test('the screens that carry the restriction are the approval, the return and the signing (MOB-67 and DOC-22, which signs the same way)', () {
      expect(kIntegrityRestrictedScreens, <String, IntegrityRestriction>{
        'MOB-25': IntegrityRestriction.approvals,
        'MOB-26': IntegrityRestriction.approvals,
        'MOB-67': IntegrityRestriction.signing,
        'DOC-22': IntegrityRestriction.signing,
      });
    });

    test('as the application wires it: the session asks for the second factor through the requester, and the stored unlock obeys the decision of the monitor', () async {
      final World world = World();
      addTearDown(world.dispose);
      final ProviderContainer container = ProviderContainer(overrides: <Override>[
        appConfigProvider.overrideWithValue(testConfig),
        httpTransportProvider.overrideWithValue(world.transport),
        secureValueStoreProvider.overrideWithValue(world.store),
        biometricGateProvider.overrideWithValue(world.biometrics),
        authorizationBrowserProvider.overrideWithValue(world.browser),
        sessionClockProvider.overrideWithValue(world.clock),
        appLifecycleProvider.overrideWithValue(const Stream<AppLifecycleState>.empty()),
        ...sessionOverrides(),
      ]);
      addTearDown(container.dispose);
      final AuthService service = container.read(authServiceProvider);
      await service.signIn(kOidcConfig);
      await pumpEventQueue();
      expect(container.read(sessionProvider).stepUpRequired, isFalse);

      container.read(secondFactorRequesterProvider)();
      await pumpEventQueue();
      expect(container.read(sessionProvider).stepUpRequired, isTrue, reason: 'MOB-03 is asked for exactly as when the server answers 403 MFA_REQUIRED');

      expect(await service.setBiometricUnlock(enabled: true, reason: 'on'), isTrue);
      service.lock();
      container.read(integrityProvider.notifier).apply(decideIntegrity(_rooted, IntegrityMode.restrictSensitive, releaseBuild: true));
      expect(await service.unlock(reason: 'unlock'), isFalse, reason: 'the decision of the monitor reaches the session');
      container.read(integrityModeProvider.notifier).set(IntegrityMode.off);
      container.read(integrityProvider.notifier).apply(decideIntegrity(_rooted, IntegrityMode.off, releaseBuild: true));
      expect(await service.unlock(reason: 'unlock'), isTrue);
    });

    test('the biometric unlock cannot be turned on, and releases nothing, on a restricted phone; the person signs in again', () async {
      bool allowed = true;
      final World world = World();
      addTearDown(world.dispose);
      final AuthService service = world.serviceOn(world.store, biometricUnlockAllowed: () => allowed);
      await service.signIn(kOidcConfig);
      expect(await service.setBiometricUnlock(enabled: true, reason: 'enable'), isTrue, reason: 'an ordinary phone may turn it on');
      expect(world.biometrics.prompts, <String>['enable']);

      service.lock();
      expect(service.snapshot.locked, isTrue);
      allowed = false;
      expect(await service.unlock(reason: 'unlock'), isFalse);
      expect(world.biometrics.prompts, <String>['enable'], reason: 'the prompt was not even shown: a hooked prompt would have said yes');
      expect(service.snapshot.locked, isTrue);
      expect(await service.accessToken(), isNull);

      expect(await service.setBiometricUnlock(enabled: true, reason: 'again'), isFalse);
      expect(world.biometrics.prompts, hasLength(1));
      expect(await service.setBiometricUnlock(enabled: false, reason: 'off'), isTrue, reason: 'turning it off is always allowed');

      allowed = true;
      expect(await service.unlock(reason: 'unlock'), isTrue);
      expect(service.snapshot.locked, isFalse);
    });
  });

}

String _read(String path) => File(path).readAsStringSync();
