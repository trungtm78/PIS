import 'dart:async';
import 'dart:convert';

import 'package:machvon_api_client/machvon_api_client.dart';

import '../../core/release/release_notice.dart';
import '../../core/security/device_integrity.dart';
import '../../core/security/pinning_policy.dart';
import 'app_info.dart';

/// The code the server answers with (426) when this version of the application is unsafe.
const String kVersionUnsafeCode = 'APP_VERSION_UNSAFE';

/// The code the server answers with (503) during a maintenance window.
const String kMaintenanceCode = 'MAINTENANCE_WINDOW';

/// What the server declares about this version of the application and about the service (the "version policy").
///
/// The application is forced to update only when the server declares its version unsafe ([upgradeRequired], or the version is
/// in [unsafeVersions]): an application one release behind keeps working. A maintenance window is the server's own flag;
/// the clock of the phone never decides that a window is open or over.
final class VersionPolicy {
  const VersionPolicy({
    this.upgradeRequired = false,
    this.maintenance = false,
    this.reasonCode,
    this.unsafeVersions = const <String>[],
    this.minimumVersion,
    this.windowStartsAt,
    this.windowEndsAt,
    this.storeUrl,
    this.integrityMode = IntegrityMode.warn,
    this.pinningMode,
  });

  /// A policy that blocks nothing.
  static const VersionPolicy open = VersionPolicy();

  final bool upgradeRequired;
  final bool maintenance;
  final String? reasonCode;
  final List<String> unsafeVersions;
  final String? minimumVersion;
  final DateTime? windowStartsAt;
  final DateTime? windowEndsAt;
  final Uri? storeUrl;

  /// How strict the tenant wants the application to be on a phone that looks modified (`integrity_mode`: `off`, `warn`,
  /// `restrict_sensitive`). Absent, or a value this version does not know, it is `warn` (D-SEC-01).
  final IntegrityMode integrityMode;

  /// What the server asks of certificate pinning (`pinning_mode`: `off`, `report_only`, `enforce`), or null when it says
  /// nothing. It can only relax the build's policy (D-SEC-02).
  final PinningMode? pinningMode;

  /// What this policy means for the version [app]: the notice MOB-54 shows, or none.
  ReleaseNotice noticeFor(AppInfo app) {
    final bool unsafe = upgradeRequired || unsafeVersions.contains(app.full) || unsafeVersions.contains(app.version);
    if (unsafe) {
      return ReleaseNotice(
        block: ReleaseBlock.upgradeRequired,
        reasonCode: reasonCode ?? kVersionUnsafeCode,
        minimumVersion: minimumVersion,
        storeUrl: storeUrl,
      );
    }
    if (maintenance) {
      return ReleaseNotice(
        block: ReleaseBlock.maintenance,
        reasonCode: reasonCode ?? kMaintenanceCode,
        windowStartsAt: windowStartsAt,
        windowEndsAt: windowEndsAt,
      );
    }
    return const ReleaseNotice();
  }

  /// Reads the answer of the server; null when it is not a policy of the contract (the application then goes on unblocked).
  static VersionPolicy? tryParse(Object? json) {
    if (json is! Map<String, Object?>) return null;
    final Object? status = json['status'];
    if (status is! String) return null;
    final Object? window = json['maintenance'];
    final Object? unsafe = json['unsafe_versions'];
    final Object? reason = json['reason_code'];
    final Object? minimum = json['min_supported_version'];
    final Uri? store = _httpsUri(json['store_url']);
    return VersionPolicy(
      upgradeRequired: status == 'upgrade_required',
      maintenance: status == 'maintenance',
      reasonCode: reason is String && RegExp(r'^[A-Z][A-Z0-9_]{2,63}$').hasMatch(reason) ? reason : null,
      unsafeVersions: unsafe is List<Object?> ? unsafe.whereType<String>().toList() : const <String>[],
      minimumVersion: minimum is String && RegExp(r'^\d+(\.\d+){0,2}(\+\d+)?$').hasMatch(minimum) ? minimum : null,
      windowStartsAt: window is Map<String, Object?> ? _time(window['starts_at']) : null,
      windowEndsAt: window is Map<String, Object?> ? _time(window['ends_at']) : null,
      storeUrl: store,
      integrityMode: IntegrityMode.parse(json['integrity_mode'] is String ? json['integrity_mode']! as String : null),
      pinningMode: _pinningMode(json['pinning_mode']),
    );
  }
}

PinningMode? _pinningMode(Object? value) => switch (value) {
      'off' => PinningMode.off,
      'report_only' => PinningMode.reportOnly,
      'enforce' => PinningMode.enforce,
      _ => null,
    };

DateTime? _time(Object? value) => value is String ? DateTime.tryParse(value) : null;

Uri? _httpsUri(Object? value) {
  if (value is! String) return null;
  final Uri? url = Uri.tryParse(value);
  return url != null && url.scheme == 'https' && url.host.isNotEmpty && url.userInfo.isEmpty ? url : null;
}

/// Where the application reads the policy from. Tests override it.
abstract interface class VersionPolicySource {
  Future<VersionPolicy> fetch(AppInfo app);
}

/// The [VersionPolicySource] on the MACHVON API: `GET {api}/mobile/version-policy?platform=...&app_version=...`, no credential
/// (the check runs before anyone signs in). The contract is the one the story asks of SAS (the version policy configuration
/// source, nothing in `openapi.json` yet): `{status: ok | upgrade_recommended | upgrade_required | maintenance, reason_code,
/// min_supported_version, unsafe_versions, maintenance: {starts_at, ends_at}, store_url}`.
final class HttpVersionPolicySource implements VersionPolicySource {
  HttpVersionPolicySource({required this.baseUrl, required this.transport, this.timeout = const Duration(seconds: 5)});

  final Uri baseUrl;
  final HttpTransport transport;
  final Duration timeout;

  @override
  Future<VersionPolicy> fetch(AppInfo app) async {
    final String path = '${baseUrl.path.replaceAll(RegExp(r'/+$'), '')}/mobile/version-policy';
    final HttpResult result = await transport
        .send(HttpCall(
          method: 'GET',
          url: baseUrl.replace(path: path, queryParameters: <String, String>{'platform': app.platform, 'app_version': app.full}),
          headers: const <String, String>{'accept': 'application/json'},
        ))
        .timeout(timeout);
    if (!result.ok) throw ApiError.fromResponse(status: result.status, headers: result.headers, body: result.body, fallbackCorrelationId: '');
    final Object? json;
    try {
      json = jsonDecode(result.body);
    } on FormatException {
      throw ApiError.unusableAnswer(result.status, '');
    }
    return VersionPolicy.tryParse(json) ?? (throw ApiError.unusableAnswer(result.status, ''));
  }
}
