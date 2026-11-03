import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter/foundation.dart' show TargetPlatform, defaultTargetPlatform;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:package_info_plus/package_info_plus.dart';

/// What the application knows about itself and the phone, and nothing about the person: the version and build of the
/// application, the platform and the version of the operating system. It goes into a help request and into the version check;
/// it carries no name and no identifier of the person or of the device.
final class AppInfo {
  const AppInfo({required this.version, required this.build, required this.platform, required this.osVersion});

  final String version;
  final String build;

  /// `ios` or `android`.
  final String platform;
  final String osVersion;

  /// `1.4.0+27`, the form the version policy of the server compares.
  String get full => '$version+$build';

  /// One line for a support ticket: `app 1.4.0+27, android 14`.
  String get summary => 'app $full, $platform $osVersion';
}

/// Where the application reads [AppInfo] from. Tests override it.
abstract interface class AppInfoSource {
  Future<AppInfo> read();
}

/// The [AppInfoSource] on `package_info_plus` and `device_info_plus`.
final class PlatformAppInfoSource implements AppInfoSource {
  const PlatformAppInfoSource();

  @override
  Future<AppInfo> read() async {
    final PackageInfo package = await PackageInfo.fromPlatform();
    final DeviceInfoPlugin device = DeviceInfoPlugin();
    final bool ios = defaultTargetPlatform == TargetPlatform.iOS;
    final String os = ios ? (await device.iosInfo).systemVersion : (await device.androidInfo).version.release;
    return AppInfo(version: package.version, build: package.buildNumber, platform: ios ? 'ios' : 'android', osVersion: os);
  }
}

final Provider<AppInfoSource> appInfoSourceProvider = Provider<AppInfoSource>((Ref ref) => const PlatformAppInfoSource());

final FutureProvider<AppInfo> appInfoProvider = FutureProvider<AppInfo>((Ref ref) => ref.watch(appInfoSourceProvider).read());
