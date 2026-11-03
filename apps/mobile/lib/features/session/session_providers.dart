import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;

import '../../app/app_config.dart';
import '../../core/di/providers.dart';
import '../../core/offline/offline_providers.dart';
import '../../core/security/device_integrity.dart';
import '../../core/security/integrity_gate.dart';
import '../../core/security/integrity_state.dart';
import '../../core/session/session.dart';
import 'auth/auth_service.dart';
import 'auth/biometric_gate.dart';
import 'auth/identity_api.dart';
import 'auth/local_data.dart';
import 'auth/oidc_client.dart';
import 'auth/pending_work.dart';
import 'auth/secure_store.dart';
import 'auth/session_vault.dart';

const String _issuerDefine = String.fromEnvironment('MACHVON_OIDC_ISSUER');
const String _clientIdDefine = String.fromEnvironment('MACHVON_OIDC_CLIENT_ID');

/// How long the application may stay in the background before a session with the biometric unlock locks.
const Duration kLockAfterBackground = Duration(seconds: 30);

/// The Keychain or Keystore. Tests override it with a memory fake.
final Provider<SecureValueStore> secureValueStoreProvider = Provider<SecureValueStore>((Ref ref) => const FlutterSecureValueStore());

/// The system browser of the sign-in. Tests override it with a scripted browser.
final Provider<AuthorizationBrowser> authorizationBrowserProvider =
    Provider<AuthorizationBrowser>((Ref ref) => const SystemAuthorizationBrowser());

/// The biometric prompt. Tests override it.
final Provider<BiometricGate> biometricGateProvider = Provider<BiometricGate>((Ref ref) => LocalAuthBiometricGate());

/// Everything on the device that holds the data of a tenant and must delete it when the tenant is left: the encrypted
/// database with its key and the file cache. The composition root (`main.dart`) lists them; the secure values of the tenant
/// are always deleted.
final Provider<List<LocalDataPurger>> localDataPurgersProvider =
    Provider<List<LocalDataPurger>>((Ref ref) => <LocalDataPurger>[OfflineStoragePurger(ref.watch(offlineStorageProvider))]);

/// What waits on the device to be sent. Tests override it.
final Provider<PendingWork> pendingWorkProvider = Provider<PendingWork>(
  (Ref ref) => QueuePendingWork(() => ref.read(commandQueueProvider.future)),
);

/// The clock of the session: only used to renew a token before it lapses and to time the biometric lock. The server
/// decides whether a session, a licence or a deadline is valid.
final Provider<DateTime Function()> sessionClockProvider = Provider<DateTime Function()>((Ref ref) => DateTime.now);

final Provider<SessionVault> sessionVaultProvider = Provider<SessionVault>((Ref ref) => SessionVault(ref.watch(secureValueStoreProvider)));

final Provider<TenantDataPurge> tenantDataPurgeProvider = Provider<TenantDataPurge>(
  (Ref ref) => TenantDataPurge(vault: ref.watch(sessionVaultProvider), purgers: ref.watch(localDataPurgersProvider)),
);

final Provider<OidcClient> oidcClientProvider = Provider<OidcClient>(
  (Ref ref) => OidcClient(
    transport: ref.watch(httpTransportProvider),
    browser: ref.watch(authorizationBrowserProvider),
    now: ref.watch(sessionClockProvider),
  ),
);

final Provider<IdentityApi> identityApiProvider = Provider<IdentityApi>(
  (Ref ref) => IdentityApi(
    baseUrl: ref.watch(appConfigProvider).apiBaseUrl,
    transport: ref.watch(httpTransportProvider),
    locale: () => ref.read(localeProvider).languageCode,
  ),
);

/// The session logic. `sessionProvider` publishes its state; the screens of sign-in, MOB-04, MOB-03, MOB-44 and the account
/// call its methods.
final Provider<AuthService> authServiceProvider = Provider<AuthService>((Ref ref) {
  final AuthService service = AuthService(
    oidc: ref.watch(oidcClientProvider),
    api: ref.watch(identityApiProvider),
    vault: ref.watch(sessionVaultProvider),
    purge: ref.watch(tenantDataPurgeProvider),
    biometrics: ref.watch(biometricGateProvider),
    pendingCommands: () => ref.read(pendingWorkProvider).count(),
    biometricUnlockAllowed: () => !ref.read(integrityProvider).decision.restricts(IntegrityRestriction.biometricUnlock),
    now: ref.watch(sessionClockProvider),
  );
  ref.onDispose(service.dispose);
  return service;
});

/// The identity provider the next sign-in uses: the one the tenant discovery (MOB-01) found, or the one of the build
/// (`--dart-define=MACHVON_OIDC_ISSUER` and `MACHVON_OIDC_CLIENT_ID`) for a single-tenant deployment, or null.
class OidcConfigNotifier extends Notifier<OidcConfig?> {
  @override
  OidcConfig? build() {
    if (_issuerDefine.isEmpty || _clientIdDefine.isEmpty) return null;
    final AppConfig app = ref.watch(appConfigProvider);
    return OidcConfig.parse(issuer: _issuerDefine, clientId: _clientIdDefine, allowInsecureLoopback: app.allowInsecureLoopback);
  }

  void choose(OidcConfig config) => state = config;
}

final NotifierProvider<OidcConfigNotifier, OidcConfig?> oidcConfigProvider =
    NotifierProvider<OidcConfigNotifier, OidcConfig?>(OidcConfigNotifier.new);

/// The lifecycle of the application as a stream, so the session lock is tested without a device.
final Provider<Stream<AppLifecycleState>> appLifecycleProvider = Provider<Stream<AppLifecycleState>>((Ref ref) {
  final StreamController<AppLifecycleState> controller = StreamController<AppLifecycleState>.broadcast();
  final _LifecycleObserver observer = _LifecycleObserver(controller.add);
  WidgetsBinding.instance.addObserver(observer);
  ref.onDispose(() {
    WidgetsBinding.instance.removeObserver(observer);
    unawaited(controller.close());
  });
  return controller.stream;
});

class _LifecycleObserver with WidgetsBindingObserver {
  _LifecycleObserver(this._report);

  final void Function(AppLifecycleState state) _report;

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) => _report(state);
}

/// The session of the application on [AuthService]. `main.dart` installs it with `sessionProvider.overrideWith(OidcSession.new)`.
class OidcSession extends SessionController {
  DateTime? _backgroundedAt;

  @override
  SessionSnapshot build() {
    final AuthService service = ref.watch(authServiceProvider);
    bool alive = true;
    ref.onDispose(() => alive = false);
    final StreamSubscription<SessionSnapshot> changes = service.changes.listen((SessionSnapshot next) {
      if (alive) state = next;
    });
    ref.onDispose(changes.cancel);
    unawaited(service.ready.then<void>((void _) {
      if (alive) state = service.snapshot;
    }));
    final StreamSubscription<AppLifecycleState> lifecycle = ref.watch(appLifecycleProvider).listen(_onLifecycle);
    ref.onDispose(lifecycle.cancel);
    return service.snapshot;
  }

  @override
  Future<String?> accessToken() => ref.read(authServiceProvider).accessToken();

  @override
  Future<String?> accessTokenFor(String tenantId) => ref.read(authServiceProvider).accessTokenFor(tenantId);

  void _onLifecycle(AppLifecycleState next) {
    final DateTime now = ref.read(sessionClockProvider)();
    if (next == AppLifecycleState.paused || next == AppLifecycleState.hidden) {
      _backgroundedAt ??= now;
    } else if (next == AppLifecycleState.resumed) {
      final DateTime? since = _backgroundedAt;
      _backgroundedAt = null;
      if (since != null && now.difference(since) >= kLockAfterBackground) unawaited(ref.read(authServiceProvider).lockIfBiometricUnlock());
    }
  }

}

/// What the application root installs for the session: the OIDC session in place of the signed-out one. The transport that tells
/// the session what the API answered is composed in `bootstrap.dart`, together with the one that tells the release state.
List<Override> sessionOverrides() => <Override>[
      sessionProvider.overrideWith(OidcSession.new),
      secondFactorRequesterProvider.overrideWith((Ref ref) => ref.read(authServiceProvider).requireSecondFactor),
    ];
