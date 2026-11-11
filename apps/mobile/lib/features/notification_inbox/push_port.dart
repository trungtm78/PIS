import 'package:flutter/foundation.dart' show TargetPlatform, defaultTargetPlatform;

import '../release/app_info.dart';
import '../session/auth/secure_store.dart';
import 'install_identity.dart';

/// What the operating system allows the application to do with notifications. `unavailable` is a device that has no push provider at all
/// (a build without push, a provider that cannot start): it is registered with the server all the same, because the registration is also what
/// gives the offline command queue the id of its device, and it is never pushed to.
enum PushPermission { granted, denied, provisional, unknown, unavailable }

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

/// No push on this build: no token, no permission asked. In-app notifications are unaffected, and the installation is registered with the
/// server without a token (it keeps an identity of its own in the secure store, as a build with push does), so the offline command queue
/// has its device.
final class NoPushPlatform implements PushPlatform {
  NoPushPlatform({SecureValueStore? store, Future<AppInfo> Function()? info, String? platformName})
      : _identity = InstallIdentity(store: store, info: info),
        _platformName = platformName;

  final InstallIdentity _identity;
  final String? _platformName;

  @override
  String get platform => _platformName ?? (defaultTargetPlatform == TargetPlatform.iOS ? 'ios' : 'android');

  @override
  String get appVersion => _identity.appVersion;

  @override
  Future<String> installId() => _identity.installId();

  @override
  Future<PushPermission> permission() async => PushPermission.unavailable;

  @override
  Future<String?> token() async => null;

  @override
  Stream<String> get tokenRefreshes => const Stream<String>.empty();

  @override
  Future<void> forgetToken() async {}
}
