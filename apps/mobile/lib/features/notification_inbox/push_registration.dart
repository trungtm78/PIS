import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

import '../../core/di/providers.dart';
import '../../core/offline/offline_providers.dart';
import '../../core/offline/store/local_store.dart';
import '../../core/session/session.dart';
import '../read_support/attempts.dart';
import '../read_support/wire.dart';
import '../session/session_providers.dart' show secureValueStoreProvider;
import 'push_config.dart';
import 'push_device.dart';
import 'push_gateway.dart';
import 'push_port.dart';

export 'push_port.dart';

/// The push port of the application: the device adapter on `firebase_messaging` when the build configuration asks for it (and carries
/// the options, see `push_config.dart`), else the null adapter, which has no token and asks for nothing.
final Provider<PushPlatform> pushPlatformProvider = Provider<PushPlatform>((Ref ref) {
  final PushConfig config = ref.watch(pushConfigProvider);
  if (!config.enabled) return const NoPushPlatform();
  final DevicePushPlatform platform = DevicePushPlatform(gateway: ref.watch(pushGatewayProvider), config: config, store: ref.watch(secureValueStoreProvider));
  ref.onDispose(platform.dispose);
  return platform;
});

/// What arrives from the provider in the foreground and what the person taps: the payload is id-only (`PushPayload`). The null inbound
/// has nothing and ends at once.
final Provider<PushInbound> pushInboundProvider = Provider<PushInbound>((Ref ref) {
  final PushPlatform platform = ref.watch(pushPlatformProvider);
  return platform is PushInbound ? platform as PushInbound : const NoPushInbound();
});

/// A push that arrived while the application runs. It carries nothing of the message (no title, no amount): the screens only read again
/// what the server holds, so the tab badge and the alert list follow the push. Empty and ended at once on a build without push, so nothing
/// is held open; `test/features/notification_inbox/push_registration_test.dart` pins this default.
final Provider<Stream<void>> pushArrivalsProvider = Provider<Stream<void>>((Ref ref) => ref.watch(pushInboundProvider).received.map((PushPayload payload) {}));

/// The reason the server records with the revocation (it asks for at least ten characters).
const String signOutReason = 'Signed out on this device';

/// How a registration ended.
enum RegistrationResult { registered, noToken, offline, refused }

/// Registers this device for push with the server, keeps exactly one live registration for it, and revokes it at sign-out.
///
///  * the server keys a registration by the public identity of the installation, so a token refresh sends the same identity
///    with the new token and the server keeps one live registration with the newest fingerprint (UAT-AC192);
///  * the registration is one intention per (token, permission): the same pair sent again (a retry, a second start) reuses the
///    idempotency key, a refreshed token is a new intention;
///  * only commands are sent, never a table write; nothing here goes to the offline queue, a registration is made when the
///    device is online and made again at the next start.
class PushRegistration {
  PushRegistration({required this.client, required this.platform, required this.language, this.onRegistered});

  /// Told the server's id of the registration each time it is known. The sync batches and the uploads name this id as the device
  /// (`device_id` of `POST /sync/batches`), so whoever registers the device hands it to the offline store: without it the queue
  /// leaves every command waiting (`FlushBlocker.noDevice`).
  final Future<void> Function(String deviceId)? onRegistered;

  final MachvonApiClient client;
  final PushPlatform platform;

  /// The interface language the server renders notifications in.
  final String Function() language;
  final AttemptRegistry _attempts = AttemptRegistry();
  String? _serverDeviceId;
  final CommandAttempt _revokeAttempt = CommandAttempt.fresh();

  /// The server's id of the registration of this device, once known.
  String? get serverDeviceId => _serverDeviceId;

  Future<void> _hand(String deviceId) async {
    try {
      await onRegistered?.call(deviceId);
    } on Object {
      // The id reaches the store at the next registration.
    }
  }

  /// Sends the registration with the token the provider gave. A device without a token (no permission, no provider) is not
  /// registered: it receives nothing by push and still has its inbox.
  Future<RegistrationResult> sync({String? refreshedToken}) async {
    final String? token = refreshedToken ?? await platform.token();
    if (token == null || token.isEmpty) return RegistrationResult.noToken;
    final PushPermission permission = await platform.permission();
    final String installId = await platform.installId();
    final DeviceRegister body = DeviceRegister(
      devicePublicId: installId,
      platform: platform.platform,
      pushToken: token,
      permissionState: permission.name,
      appVersion: platform.appVersion,
      locale: language(),
    );
    final CommandAttempt attempt = _attempts.forPayload('$installId|$token|${permission.name}');
    try {
      final Object? answer = await client.registerDevice(body, attempt: attempt);
      _attempts.done();
      final Json? result = asRecord(answer);
      _serverDeviceId = filled(result?['resource_id']) ?? _serverDeviceId;
      final String? known = _serverDeviceId;
      // Not waited for: the registration is made, and the store (opened on its own time) may take the id later or at the next start.
      if (known != null) unawaited(_hand(known));
      return RegistrationResult.registered;
    } on ApiError catch (error) {
      _attempts.ended(error);
      return error.code == networkErrorCode ? RegistrationResult.offline : RegistrationResult.refused;
    }
  }

  /// Revokes this device's registration at the server (sign-out): the server stops sending to its token. It must run while the
  /// session is still valid, so the sign-out calls it before the session ends. Returns whether the server revoked it.
  Future<bool> revoke() async {
    String? id = _serverDeviceId;
    try {
      if (id == null) {
        final String installId = await platform.installId();
        final Json? devices = asRecord(await client.listMyDevices());
        for (final Object? item in listOf(devices?['items'])) {
          final Json? device = asRecord(item);
          if (device != null && device['device_public_id'] == installId && device['status'] != 'REVOKED') id = filled(device['id']);
        }
      }
      if (id == null) return false;
      await client.revokeMyDevice(const ReasonOnly(reason: signOutReason), deviceId: id, attempt: _revokeAttempt);
      _serverDeviceId = null;
      await platform.forgetToken();
      return true;
    } on ApiError {
      return false;
    }
  }
}

/// The registration of this device. The app root, or the screen that asks for the OS permission (ST-MOB-003), calls
/// `sync()` after the permission is decided and when a refreshed token arrives (`listenForRefreshes`); the sign-out
/// (ST-MOB-008) calls `revoke()` before the session ends.
final Provider<PushRegistration> pushRegistrationProvider = Provider<PushRegistration>((Ref ref) {
  return PushRegistration(
    client: ref.watch(apiClientProvider),
    platform: ref.watch(pushPlatformProvider),
    language: () => ref.read(localeProvider).languageCode,
    onRegistered: (String deviceId) async {
      final LocalStore store = await ref.read(localStoreProvider.future);
      if (store.deviceId == deviceId) return;
      store.deviceId = deviceId;
      // What waited for a device goes now.
      (await ref.read(queueRunnerProvider.future)).trigger();
      (await ref.read(uploadRunnerProvider.future)).trigger();
    },
  );
});

/// Registers again whenever the provider rotates the token, for as long as the session lives.
final Provider<StreamSubscription<String>> pushRefreshListenerProvider = Provider<StreamSubscription<String>>((Ref ref) {
  final PushRegistration registration = ref.watch(pushRegistrationProvider);
  final StreamSubscription<String> subscription = ref.watch(pushPlatformProvider).tokenRefreshes.listen((String token) {
    if (ref.read(sessionProvider).isSignedIn) unawaited(registration.sync(refreshedToken: token));
  });
  ref.onDispose(subscription.cancel);
  return subscription;
});

/// What sign-out runs while the session is still valid: the server revokes this device's registration (so it sends nothing to its token),
/// then the provider forgets the token. It never fails and never waits long: a sign-out must not be held by a push that cannot be revoked
/// (the server also stops sending to a device whose session ended, and the registration expires).
final Provider<Future<void> Function()> pushSignOutProvider = Provider<Future<void> Function()>((Ref ref) {
  return () async {
    try {
      await ref.read(pushRegistrationProvider).revoke().timeout(const Duration(seconds: 5), onTimeout: () => false);
    } on Object {
      // Nothing to revoke or the server could not be reached: the sign-out goes on.
    }
  };
});
