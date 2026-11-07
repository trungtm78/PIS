import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

import '../../core/di/providers.dart';
import '../../core/session/session.dart';
import '../read_support/attempts.dart';
import '../read_support/wire.dart';

/// What the operating system allows the application to do with notifications.
enum PushPermission { granted, denied, provisional, unknown }

/// The operating-system side of push, behind a port: the token of the provider (FCM on Android, APNs on iOS), the stream of
/// refreshed tokens, the permission, and an identity of this installation that survives a restart.
///
/// The adapter on `firebase_messaging` and the secure store needs a device with its provider configuration and is not part of
/// this slice's tests; everything above this port (what is sent to the server, how a refresh is made idempotent, how sign-out
/// revokes) is real and tested with a fake. Until the adapter is plugged in, [NoPushPlatform] has no token and in-app
/// notifications work on their own.
abstract interface class PushPlatform {
  /// `ios` or `android`.
  String get platform;

  /// The version of the application, as the server records it with the device.
  String get appVersion;

  /// A stable public identity of this installation (16 to 128 characters). It is not the push token and not a hardware id.
  Future<String> installId();

  Future<PushPermission> permission();

  /// The current token of the provider, or null when there is none (no permission, no provider).
  Future<String?> token();

  /// A token the provider issued after the first one (it rotates).
  Stream<String> get tokenRefreshes;
}

/// No push on this build: no token, no permission asked. In-app notifications are unaffected.
final class NoPushPlatform implements PushPlatform {
  const NoPushPlatform();

  @override
  String get platform => 'android';

  @override
  String get appVersion => '0.0.0';

  @override
  Future<String> installId() async => 'no-push-installation';

  @override
  Future<PushPermission> permission() async => PushPermission.unknown;

  @override
  Future<String?> token() async => null;

  @override
  Stream<String> get tokenRefreshes => const Stream<String>.empty();
}

/// The push port of the application; the device adapter overrides it.
final Provider<PushPlatform> pushPlatformProvider = Provider<PushPlatform>((Ref ref) => const NoPushPlatform());

/// A push that arrived while the application runs (in the foreground, or one the person tapped to open it). The device adapter
/// overrides this with the stream of the provider; it carries nothing of the message (no title, no amount): the screens only
/// read again what the server holds, so the tab badge and the alert list follow the push.
final Provider<Stream<void>> pushArrivalsProvider = Provider<Stream<void>>((Ref ref) => const Stream<void>.empty());

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
  PushRegistration({required this.client, required this.platform, required this.language});

  final MachvonApiClient client;
  final PushPlatform platform;

  /// The interface language the server renders notifications in.
  final String Function() language;
  final AttemptRegistry _attempts = AttemptRegistry();
  String? _serverDeviceId;
  final CommandAttempt _revokeAttempt = CommandAttempt.fresh();

  /// The server's id of the registration of this device, once known.
  String? get serverDeviceId => _serverDeviceId;

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
