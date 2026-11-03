import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/app/bootstrap.dart';
import 'package:machvon_mobile/core/di/providers.dart';
import 'package:machvon_mobile/core/offline/offline_probe_policy.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/release/release_notice.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/features/release/app_info.dart';
import 'package:machvon_mobile/features/release/release_providers.dart';
import 'package:machvon_mobile/features/release/telemetry.dart';
import 'package:machvon_mobile/features/release/version_policy.dart';
import 'package:machvon_mobile/features/session/auth/oidc_client.dart' show kMobileRedirectUri;
import 'package:machvon_mobile/features/session/auth/pending_work.dart';
import 'package:machvon_mobile/features/session/session_providers.dart';

import '../features/session/support/world.dart';
import '../support/harness.dart';

class _App implements AppInfoSource {
  @override
  Future<AppInfo> read() async => const AppInfo(version: '1.4.0', build: '27', platform: 'android', osVersion: '14');
}

class _Policy implements VersionPolicySource {
  @override
  Future<VersionPolicy> fetch(AppInfo app) async => VersionPolicy.open;
}

class _NoPending implements PendingWork {
  @override
  Future<int> count() async => 0;

  @override
  Future<void> sendNow() async {}
}

HttpResult _json(int status, Object? body) =>
    HttpResult(status: status, headers: const <String, String>{'content-type': 'application/json'}, body: jsonEncode(body));

List<Override> _testOverrides(World world, HttpTransport transport, BufferedTelemetrySink sink) => <Override>[
      secureValueStoreProvider.overrideWithValue(world.store),
      httpTransportProvider.overrideWithValue(transport),
      appInfoSourceProvider.overrideWithValue(_App()),
      versionPolicySourceProvider.overrideWithValue(_Policy()),
      pendingWorkProvider.overrideWithValue(_NoPending()),
      biometricGateProvider.overrideWithValue(world.biometrics),
      sessionClockProvider.overrideWithValue(world.clock),
      telemetrySinkProvider.overrideWithValue(sink),
    ];

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('AC-ST-MOB-002-1 TK-MOB-002-2 the application root', () {
    test('restores the stored session before the first screen is chosen, so a person who signed in yesterday does not meet the sign-in screen', () async {
      final World world = World();
      addTearDown(world.dispose);
      await world.service().signIn(kOidcConfig);

      final ProviderContainer container = await bootstrap(
        config: testConfig,
        crashReporting: false,
        overrides: _testOverrides(world, world.transport, BufferedTelemetrySink()),
      );
      addTearDown(container.dispose);

      final SessionSnapshot session = container.read(sessionProvider);
      expect(session.status, SessionStatus.signedIn);
      expect(session.tenantId, 'tenant-a');
      expect(await container.read(sessionProvider.notifier).accessToken(), isNotNull);
    });

    test('the application root installs the probe of a lost connection for the queue and the uploads', () async {
      final World world = World();
      addTearDown(world.dispose);
      final ProviderContainer container = await bootstrap(
        config: testConfig,
        crashReporting: false,
        overrides: _testOverrides(world, world.transport, BufferedTelemetrySink()),
      );
      addTearDown(container.dispose);
      expect(container.read(offlineProbePolicyProvider), same(OfflineProbePolicy.standard));
    });

    test('a person who never signed in starts signed out', () async {
      final World world = World();
      addTearDown(world.dispose);
      final ProviderContainer container = await bootstrap(
        config: testConfig,
        crashReporting: false,
        overrides: _testOverrides(world, world.transport, BufferedTelemetrySink()),
      );
      addTearDown(container.dispose);
      expect(container.read(sessionProvider).status, SessionStatus.signedOut);
      expect(await container.read(sessionProvider.notifier).accessToken(), isNull);
    });

    test('the transport of the API client tells the session about a second factor wanted and a licence expired, and the release state about an unsafe version', () async {
      final World world = World();
      addTearDown(world.dispose);
      await world.service().signIn(kOidcConfig);
      int status = 403;
      Map<String, Object?> body = <String, Object?>{'code': 'MFA_REQUIRED', 'status': 403};
      final FakeTransport transport = FakeTransport((HttpCall call) async {
        if (call.url.host == kIssuer.host || call.url.path.contains('tenant-selection')) return world.transport.send(call);
        return _json(status, body);
      });
      final ProviderContainer container = await bootstrap(
        config: testConfig,
        crashReporting: false,
        overrides: _testOverrides(world, transport, BufferedTelemetrySink()),
      );
      addTearDown(container.dispose);
      final MachvonApiClient client = container.read(apiClientProvider);

      await expectLater(client.execute('getMyProfile'), throwsA(isA<ApiError>()));
      await pumpEventQueue();
      expect(container.read(sessionProvider).stepUpRequired, isTrue);

      status = 426;
      body = <String, Object?>{'code': 'APP_VERSION_UNSAFE', 'status': 426};
      await expectLater(client.execute('getMyProfile'), throwsA(isA<ApiError>()));
      expect(container.read(releaseNoticeProvider).block, ReleaseBlock.upgradeRequired);

      status = 422;
      body = <String, Object?>{'code': 'LICENSE_EXPIRED', 'status': 422};
      await expectLater(client.execute('getMyProfile'), throwsA(isA<ApiError>()));
      await pumpEventQueue();
      expect(container.read(sessionProvider).isReadOnly, isTrue);
    });
  });

  group('AC-ST-MOB-016-4 UAT-NFR-OBSERVABILITY-01 the crash reporting of the root', () {
    test('is installed once at start and reports the type of an uncaught error with the tenant', () async {
      final World world = World();
      addTearDown(world.dispose);
      await world.service().signIn(kOidcConfig);
      final BufferedTelemetrySink sink = BufferedTelemetrySink();
      final void Function(FlutterErrorDetails)? original = FlutterError.onError;
      final bool Function(Object, StackTrace)? originalPlatform = PlatformDispatcher.instance.onError;
      final ProviderContainer container = await bootstrap(config: testConfig, overrides: _testOverrides(world, world.transport, sink));
      addTearDown(container.dispose);
      try {
        FlutterError.onError!(const FlutterErrorDetails(exception: FormatException('Nguyen Van A')));
        PlatformDispatcher.instance.onError!(ArgumentError('x'), StackTrace.empty);
        expect(sink.events.map((TelemetryEvent e) => e.attributes['error_type']), <Object?>['FormatException', 'ArgumentError']);
        expect(sink.events.map((TelemetryEvent e) => e.tenantId).toSet(), <String>{'tenant-a'});
        expect(jsonEncode(sink.events.map((TelemetryEvent e) => e.toJson()).toList()), isNot(contains('Nguyen')));
      } finally {
        FlutterError.onError = original;
        PlatformDispatcher.instance.onError = originalPlatform;
      }
    });
  });

  group('TK-MOB-002-5 the platform files', () {
    test('the sign-in redirect scheme is declared once on Android, by the callback activity of the sign-in library, and nowhere else', () {
      final String manifest = File('android/app/src/main/AndroidManifest.xml').readAsStringSync();
      expect(RegExp('android:scheme="([^"]+)"').allMatches(manifest).map((Match m) => m.group(1)).toList(), <String>['vn.machvon.app', 'https']);
      expect(manifest, contains('com.linusu.flutter_web_auth_2.CallbackActivity'));
      expect(manifest, contains('android:allowBackup="false"'));
      expect(manifest, contains('android:usesCleartextTraffic="false"'));
      expect(manifest, contains('android:scheme="${Uri.parse(kMobileRedirectUri).scheme}"'));
      final String main = manifest.substring(manifest.indexOf('.MainActivity'), manifest.indexOf('</activity>'));
      expect(main, isNot(contains('android:scheme')), reason: 'the main activity takes no redirect');
    });

    test('Android asks for the camera and the position while in use, never the position in the background', () {
      final String manifest = File('android/app/src/main/AndroidManifest.xml').readAsStringSync();
      expect(manifest, contains('android.permission.CAMERA'));
      expect(manifest, contains('android.permission.ACCESS_FINE_LOCATION'));
      expect(manifest, contains('android.permission.POST_NOTIFICATIONS'));
      expect(manifest, contains('android.permission.USE_BIOMETRIC'));
      expect(manifest, isNot(contains('ACCESS_BACKGROUND_LOCATION')));
    });

    test('the biometric prompt has the activity it needs, and iOS says why it asks for the camera, the position and Face ID', () {
      expect(File('android/app/src/main/kotlin/vn/machvon/machvon_mobile/MainActivity.kt').readAsStringSync(), contains('FlutterFragmentActivity'));
      final String plist = File('ios/Runner/Info.plist').readAsStringSync();
      for (final String key in <String>['NSCameraUsageDescription', 'NSLocationWhenInUseUsageDescription', 'NSFaceIDUsageDescription']) {
        expect(plist, contains(key));
      }
      expect(plist, isNot(contains('NSLocationAlwaysUsageDescription')));
      expect(plist, isNot(contains('NSAppTransportSecurity')), reason: 'the default (https only) stays');
    });
  });
}
