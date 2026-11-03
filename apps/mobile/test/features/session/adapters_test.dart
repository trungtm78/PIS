import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:local_auth_platform_interface/local_auth_platform_interface.dart';
import 'package:machvon_mobile/features/session/auth/biometric_gate.dart';
import 'package:machvon_mobile/features/session/auth/secure_store.dart';
import 'package:machvon_mobile/features/session/session_providers.dart';
import 'package:plugin_platform_interface/plugin_platform_interface.dart';

class _FakeLocalAuth extends LocalAuthPlatform with MockPlatformInterfaceMixin {
  bool supported = true;
  Object? supportError;
  List<BiometricType> enrolled = <BiometricType>[BiometricType.fingerprint];
  Object? outcome = true;
  final List<String> reasons = <String>[];

  @override
  Future<bool> isDeviceSupported() async {
    final Object? error = supportError;
    if (error != null) throw error;
    return supported;
  }

  @override
  Future<List<BiometricType>> getEnrolledBiometrics() async => enrolled;

  @override
  Future<bool> authenticate({
    required String localizedReason,
    required Iterable<AuthMessages> authMessages,
    AuthenticationOptions options = const AuthenticationOptions(),
  }) async {
    reasons.add(localizedReason);
    final Object? result = outcome;
    if (result is LocalAuthException) throw result;
    return result! as bool;
  }
}

void main() {
  group('AC-ST-MOB-008-4 the lifecycle of the application as the session sees it', () {
    testWidgets('the provider reports the states of the application to its listeners and stops when it is disposed', (WidgetTester tester) async {
      final ProviderContainer container = ProviderContainer();
      final List<AppLifecycleState> seen = <AppLifecycleState>[];
      container.read(appLifecycleProvider).listen(seen.add);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      await tester.pump();
      expect(seen, <AppLifecycleState>[AppLifecycleState.inactive, AppLifecycleState.hidden]);
      container.dispose();
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await tester.pump();
      expect(seen, hasLength(2));
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    });
  });

  group('AC-ST-MOB-002-1 TK-MOB-002-2 the secure store adapter on flutter_secure_storage', () {
    test('writes, reads, lists and deletes values of the Keychain or Keystore', () async {
      FlutterSecureStorage.setMockInitialValues(<String, String>{});
      const FlutterSecureValueStore store = FlutterSecureValueStore();
      expect(await store.read('session.v1'), isNull);
      await store.write('session.v1', '{"a":1}');
      await store.write('tenant.t1.theme.v1', 'x');
      expect(await store.read('session.v1'), '{"a":1}');
      expect(await store.keys(), <String>{'session.v1', 'tenant.t1.theme.v1'});
      await store.delete('session.v1');
      expect(await store.read('session.v1'), isNull);
      expect(await store.keys(), <String>{'tenant.t1.theme.v1'});
    });
  });

  group('AC-ST-MOB-008-4 UAT-PLAN-33 the biometric adapter on local_auth', () {
    final LocalAuthPlatform original = LocalAuthPlatform.instance;
    late _FakeLocalAuth phone;

    setUp(() {
      phone = _FakeLocalAuth();
      LocalAuthPlatform.instance = phone;
    });
    tearDown(() => LocalAuthPlatform.instance = original);

    test('is available only when the phone supports it and a biometric is enrolled', () async {
      final LocalAuthBiometricGate gate = LocalAuthBiometricGate();
      expect(await gate.isAvailable(), isTrue);
      phone.enrolled = <BiometricType>[];
      expect(await gate.isAvailable(), isFalse);
      phone.enrolled = <BiometricType>[BiometricType.face];
      phone.supported = false;
      expect(await gate.isAvailable(), isFalse);
    });

    test('a passed prompt is true; a failed one, a cancel, a lock-out and a system error are all false; the reason is shown', () async {
      final LocalAuthBiometricGate gate = LocalAuthBiometricGate();
      expect(await gate.authenticate(reason: 'Unlock'), isTrue);
      expect(phone.reasons, <String>['Unlock']);
      phone.outcome = false;
      expect(await gate.authenticate(reason: 'Unlock'), isFalse);
      for (final LocalAuthExceptionCode code in <LocalAuthExceptionCode>[
        LocalAuthExceptionCode.userCanceled,
        LocalAuthExceptionCode.temporaryLockout,
        LocalAuthExceptionCode.systemCanceled,
      ]) {
        phone.outcome = LocalAuthException(code: code);
        expect(await gate.authenticate(reason: 'Unlock'), isFalse, reason: code.name);
      }
    });

    test('an error of the platform while asking what is available is "not available"', () async {
      final LocalAuthBiometricGate gate = LocalAuthBiometricGate();
      phone.supportError = const LocalAuthException(code: LocalAuthExceptionCode.uiUnavailable);
      expect(await gate.isAvailable(), isFalse);
    });
  });
}
