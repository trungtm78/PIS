import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;

import '../core/connectivity/connectivity_monitor.dart';
import '../core/connectivity/connectivity_providers.dart';
import '../core/di/providers.dart';
import '../core/offline/offline_probe_policy.dart';
import '../core/offline/offline_providers.dart';
import '../core/release/release_notice.dart';
import '../core/theme/theme_mode.dart';
import '../features/release/release_providers.dart';
import '../features/release/telemetry.dart';
import '../features/session/auth/session_transport.dart';
import '../features/session/session_providers.dart';
import '../features/tenant_discovery/theme_providers.dart';
import 'app_config.dart';
import 'theme_preference_store.dart';

/// What the application installs over the foundation, in one place:
///  * the OIDC session (ST-MOB-002) in place of the signed-out one;
///  * the tenant theme that follows the session (ST-MOB-004);
///  * the release state that reads the version policy (ST-MOB-016);
///  * the store of the choice of light, dark or system, read at start so the first frame is already in the chosen mode;
///  * the probe of a lost connection by the queue and the uploads (without it only a request that succeeds elsewhere resumes them);
///  * the monitor of the connection, which keeps the offline banner true on an idle screen and with the radio switched off (a request alone
///    reports nothing while nobody asks the server anything);
///  * the transport of the API client, which tells the session what the API answered (401, 403 MFA_REQUIRED, 422
///    LICENSE_EXPIRED) and the release state what it answered (426, 503).
List<Override> productionOverrides() => <Override>[
      ...sessionOverrides(),
      ...themeOverrides(),
      releaseNoticeProvider.overrideWith(PolicyReleaseNotice.new),
      themePreferenceStoreProvider.overrideWith((Ref ref) => SecureThemePreferenceStore(ref.watch(secureValueStoreProvider))),
      offlineProbePolicyProvider.overrideWithValue(OfflineProbePolicy.standard),
      connectivityPolicyProvider.overrideWithValue(const ConnectivityPolicy()),
      apiTransportProvider.overrideWith(
        (Ref ref) => ReleaseObservingTransport(
          SessionObservingTransport(
            ref.watch(httpTransportProvider),
            ref.read(authServiceProvider).noteResponse,
            () => ref.read(authServiceProvider).credentialStamp,
          ),
          (int status, Map<String, String> headers, String body) =>
              (ref.read(releaseNoticeProvider.notifier) as PolicyReleaseNotice).noteResponse(status, headers, body),
        ),
      ),
    ];

/// Builds the container the application runs on. The stored session is restored before the first screen is chosen, so a person
/// who signed in yesterday opens on their home screen and not on the sign-in screen; the crash reporting is installed once.
/// [overrides] are for tests (a memory secure store, a fake transport); [installCrashReporting] is off in tests that keep
/// the handlers of the test framework.
Future<ProviderContainer> bootstrap({
  AppConfig? config,
  List<Override> overrides = const <Override>[],
  bool crashReporting = true,
}) async {
  final ProviderContainer container = ProviderContainer(
    overrides: <Override>[
      appConfigProvider.overrideWithValue(config ?? AppConfig.fromEnvironment()),
      ...productionOverrides(),
      ...overrides,
    ],
  );
  await container.read(authServiceProvider).ready;
  await container.read(themeModeProvider.notifier).restore();
  if (crashReporting) installCrashReporting(container.read(telemetryProvider));
  return container;
}
