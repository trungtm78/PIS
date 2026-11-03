import 'package:flutter/foundation.dart' show kDebugMode;

const String _baseUrlDefine = String.fromEnvironment('MACHVON_API_BASE_URL');

/// The loopback hosts a debug build may reach over plain http: the host machine as seen from the Android emulator and
/// from the iOS simulator.
const Set<String> _loopbackHosts = <String>{'localhost', '127.0.0.1', '10.0.2.2'};

/// The settings fixed when the application starts.
final class AppConfig {
  const AppConfig({required this.apiBaseUrl, this.allowInsecureLoopback = false});

  /// Reads `--dart-define=MACHVON_API_BASE_URL=https://...`. Fails at start when it is missing or not acceptable, so a
  /// build never runs against an address nobody chose.
  factory AppConfig.fromEnvironment() => AppConfig.parse(_baseUrlDefine, allowInsecureLoopback: kDebugMode);

  /// Parses the base URL of the API: https only; plain http is accepted for a loopback host when [allowInsecureLoopback]
  /// is set (debug builds). The URL carries no user info, query or fragment.
  factory AppConfig.parse(String raw, {required bool allowInsecureLoopback}) {
    final Uri? url = Uri.tryParse(raw.trim());
    if (url == null || !url.hasAuthority || url.host.isEmpty) {
      throw FormatException('MACHVON_API_BASE_URL must be an absolute URL', raw);
    }
    final bool loopback = _loopbackHosts.contains(url.host);
    final bool secure = url.scheme == 'https';
    if (!secure && !(allowInsecureLoopback && loopback && url.scheme == 'http')) {
      throw FormatException('MACHVON_API_BASE_URL must use https', raw);
    }
    if (url.userInfo.isNotEmpty || url.hasQuery || url.hasFragment) {
      throw FormatException('MACHVON_API_BASE_URL must not carry user info, a query or a fragment', raw);
    }
    return AppConfig(apiBaseUrl: url, allowInsecureLoopback: allowInsecureLoopback && loopback);
  }

  final Uri apiBaseUrl;

  /// A request to an `http` address is allowed (only ever true for a loopback host of a debug build).
  final bool allowInsecureLoopback;
}
