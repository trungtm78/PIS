import 'dart:ui' show Locale;

import 'package:flutter/foundation.dart' show ValueNotifier;
import 'package:flutter/widgets.dart' show WidgetsBinding;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

import '../../app/app_config.dart';
import '../../features/registry.generated.dart';
import '../api/dart_io_transport.dart';
import '../connectivity/reachability.dart';
import '../l10n/core_strings.dart';
import '../l10n/string_table.dart';
import '../navigation/deep_link_guard.dart';
import '../navigation/feature.dart';
import '../navigation/mobile_routes.generated.dart';
import '../navigation/route_policy.dart';
import '../navigation/route_table.dart';
import '../navigation/router.dart';
import '../release/release_notice.dart';
import '../session/session.dart';

/// The settings fixed at start. The application overrides it with `AppConfig.fromEnvironment()`; a test with its own.
final Provider<AppConfig> appConfigProvider = Provider<AppConfig>(
  (Ref ref) => throw StateError('appConfigProvider must be overridden at the root of the application'),
);

/// The language of the interface: the device language when it is supported, otherwise the fallback language.
class LocaleNotifier extends Notifier<Locale> {
  @override
  Locale build() {
    final String device = WidgetsBinding.instance.platformDispatcher.locale.languageCode;
    return Locale(kSupportedLanguages.contains(device) ? device : kFallbackLanguage);
  }

  void select(Locale locale) => state = locale;
}

final NotifierProvider<LocaleNotifier, Locale> localeProvider = NotifierProvider<LocaleNotifier, Locale>(LocaleNotifier.new);

/// The features of the application. Tests override it to try a screen on its own.
final Provider<List<MobileFeature>> featuresProvider = Provider<List<MobileFeature>>((Ref ref) => kAllFeatures);

/// The strings of the core and of every feature.
final Provider<StringCatalogue> stringCatalogueProvider = Provider<StringCatalogue>((Ref ref) {
  final List<MobileFeature> features = ref.watch(featuresProvider);
  return StringCatalogue(<StringTable>[
    kCoreStrings,
    for (final MobileFeature feature in features)
      if (feature.strings != null) feature.strings!,
  ]);
});

final Provider<RouteTable> routeTableProvider = Provider<RouteTable>(
  (Ref ref) => RouteTable(routes: kMobileRoutes, features: ref.watch(featuresProvider)),
);

/// The guard in front of every location. ST-MOB-015 wraps or replaces it to resolve opaque push links.
final Provider<DeepLinkGuard> deepLinkGuardProvider = Provider<DeepLinkGuard>((Ref ref) {
  final RouteTable table = ref.watch(routeTableProvider);
  final SessionDeepLinkGuard sessionGuard = SessionDeepLinkGuard(
    targets: GuardTargets(
      signIn: table.locationOf(kSignInScreenId),
      sessionExpired: table.locationOf(kSessionExpiredScreenId),
      accessDenied: table.locationOf(kAccessDeniedScreenId),
      secondFactor: table.locationOf(kSecondFactorScreenId),
      releaseNotice: table.locationOf(kReleaseNoticeScreenId),
    ),
    isPublic: table.isPublicLocation,
    releaseBlock: () => ref.read(releaseNoticeProvider).block,
    isOffline: (Uri target) => target.pathSegments.any(
      (String segment) => kMaintenanceReachableScreenIds.any((String id) => id.toLowerCase() == segment),
    ),
  );
  return RuleDeepLinkGuard(
    inner: sessionGuard,
    rules: <LocationRule>[for (final MobileFeature feature in ref.watch(featuresProvider)) ...feature.locationRules],
    locationOf: table.locationOf,
  );
});

/// The transport: `dart:io` behind an observer that feeds [reachabilityProvider]. Tests override it with a fake.
final Provider<HttpTransport> httpTransportProvider = Provider<HttpTransport>((Ref ref) {
  final AppConfig config = ref.watch(appConfigProvider);
  return ObservingTransport(
    DartIoHttpTransport(allowInsecureLoopback: config.allowInsecureLoopback),
    ref.read(reachabilityProvider.notifier).report,
  );
});

/// The transport of the API client. It is the application transport by default; the application root wraps it so the session
/// learns what the API answered (a 401, a 403 MFA_REQUIRED). The calls to the identity provider never go through it.
final Provider<HttpTransport> apiTransportProvider = Provider<HttpTransport>((Ref ref) => ref.watch(httpTransportProvider));

/// The generated API client of the application, with the bearer token of the session and the interface language.
final Provider<MachvonApiClient> apiClientProvider = Provider<MachvonApiClient>(
  (Ref ref) => MachvonApiClient(
    baseUrl: ref.watch(appConfigProvider).apiBaseUrl,
    transport: ref.watch(apiTransportProvider),
    token: () => ref.read(sessionProvider.notifier).accessToken(),
    locale: () => ref.read(localeProvider).languageCode,
  ),
);

/// The request client of one tenant: it takes the token only while that tenant is the active one. A command that was
/// queued for tenant A and is sent after a switch to tenant B fails with [TenantMismatch] before anything leaves the
/// device. The queue and every upload use it with the tenant of their store.
final tenantApiClientProvider = Provider.family<MachvonApiClient, String>(
  (Ref ref, String tenantId) => MachvonApiClient(
    baseUrl: ref.watch(appConfigProvider).apiBaseUrl,
    transport: ref.watch(apiTransportProvider),
    token: () => ref.read(sessionProvider.notifier).accessTokenFor(tenantId),
    locale: () => ref.read(localeProvider).languageCode,
  ),
);

/// The router. It is rebuilt only when the features change; a session change makes it re-evaluate the guard.
final Provider<GoRouter> routerProvider = Provider<GoRouter>((Ref ref) {
  final ValueNotifier<int> sessionChanges = ValueNotifier<int>(0);
  ref.listen<SessionSnapshot>(sessionProvider, (SessionSnapshot? previous, SessionSnapshot next) => sessionChanges.value += 1);
  ref.listen<ReleaseNotice>(releaseNoticeProvider, (ReleaseNotice? previous, ReleaseNotice next) => sessionChanges.value += 1);
  final GoRouter router = buildRouter(
    table: ref.watch(routeTableProvider),
    guard: ref.watch(deepLinkGuardProvider),
    session: () => ref.read(sessionProvider),
    refreshListenable: sessionChanges,
  );
  ref.onDispose(() {
    router.dispose();
    sessionChanges.dispose();
  });
  return router;
});
