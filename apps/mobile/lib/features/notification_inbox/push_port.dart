/// What the operating system allows the application to do with notifications.
enum PushPermission { granted, denied, provisional, unknown }

/// The operating-system side of push, behind a port: the token of the provider (FCM on Android, APNs on iOS), the stream of
/// refreshed tokens, the permission, and an identity of this installation that survives a restart.
///
/// The adapter on `firebase_messaging` and the secure store is `DevicePushPlatform` (`push_device.dart`); it is selected by the build
/// configuration (`push_config.dart`). Everything above this port (what is sent to the server, how a refresh is made idempotent, how
/// sign-out revokes) is tested with a fake. A build without push configuration uses [NoPushPlatform]: no token, in-app notifications
/// work on their own.
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

  /// Forgets the token at the provider, so that a token that was revoked at the server cannot be used again by anything that kept it.
  /// Called at sign-out after the server revoked the registration.
  Future<void> forgetToken();
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

  @override
  Future<void> forgetToken() async {}
}
