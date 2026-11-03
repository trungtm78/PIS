import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:url_launcher/url_launcher.dart' as launcher;

import '../../core/di/providers.dart';
import '../../core/release/release_notice.dart';
import '../../core/security/integrity_state.dart';
import 'app_info.dart';
import 'version_policy.dart';

/// Where the version policy is read. Tests override it.
final Provider<VersionPolicySource> versionPolicySourceProvider = Provider<VersionPolicySource>(
  (Ref ref) => HttpVersionPolicySource(baseUrl: ref.watch(appConfigProvider).apiBaseUrl, transport: ref.watch(httpTransportProvider)),
);

/// Opens the page where the new version is (a store listing, or the managed distribution of the organisation). Tests override it.
abstract interface class UrlOpener {
  Future<bool> open(Uri url);
}

/// The [UrlOpener] on `url_launcher`, in the browser or the store application, and only for https.
final class SystemUrlOpener implements UrlOpener {
  const SystemUrlOpener();

  @override
  Future<bool> open(Uri url) async {
    if (url.scheme != 'https') return false;
    return launcher.launchUrl(url, mode: launcher.LaunchMode.externalApplication);
  }
}

final Provider<UrlOpener> urlOpenerProvider = Provider<UrlOpener>((Ref ref) => const SystemUrlOpener());

/// The release state of the application, from the version policy of the server and from what the server answers to a call.
///
///  * At start the policy is read once; a policy that says the version is unsafe stops the application at MOB-54 (nothing opens
///    until the person updates), a maintenance window stops it too except the screens that work from the device.
///  * A call answered 426 `APP_VERSION_UNSAFE` or 503 `MAINTENANCE_WINDOW` does the same, from wherever the person is.
///  * A policy that cannot be read (no connection, a gateway error) blocks nothing: the application never refuses to open
///    because a check could not be made.
///
/// `main.dart` installs it with `releaseNoticeProvider.overrideWith(PolicyReleaseNotice.new)`.
class PolicyReleaseNotice extends ReleaseNoticeController {
  /// Why the last check could not be made (a diagnostic for a support call; it never reaches a screen), or null.
  Object? lastCheckError;

  @override
  ReleaseNotice build() {
    unawaited(check());
    return const ReleaseNotice();
  }

  /// Reads the policy again (the person asked, or the maintenance window may be over) and updates the notice.
  Future<ReleaseNotice> check() async {
    try {
      final AppInfo app = await ref.read(appInfoProvider.future);
      final VersionPolicy policy = await ref.read(versionPolicySourceProvider).fetch(app);
      final ReleaseNotice next = policy.noticeFor(app);
      lastCheckError = null;
      if (ref.mounted) {
        state = next;
        ref.read(integrityModeProvider.notifier).set(policy.integrityMode);
        ref.read(remotePinningModeProvider.notifier).set(policy.pinningMode);
      }
    } on Object catch (error) {
      // The check could not be made: the notice stays as it was, and a blocked application stays blocked.
      lastCheckError = error;
    }
    return state;
  }

  /// What a call to the API answered: 426 and 503 with the codes of the release policy set the notice.
  void noteResponse(int status, Map<String, String> headers, String body) {
    if (status != 426 && status != 503) return;
    final Map<String, Object?>? problem = _problemOf(headers, body);
    final Object? code = problem?['code'];
    if (status == 426 && code == kVersionUnsafeCode) {
      state = ReleaseNotice(
        block: ReleaseBlock.upgradeRequired,
        reasonCode: kVersionUnsafeCode,
        minimumVersion: _minimumOf(problem),
        storeUrl: _storeOf(problem),
      );
    } else if (status == 503 && code == kMaintenanceCode) {
      state = ReleaseNotice(
        block: ReleaseBlock.maintenance,
        reasonCode: kMaintenanceCode,
        windowStartsAt: _timeOf(problem?['starts_at']),
        windowEndsAt: _timeOf(problem?['ends_at']),
      );
    }
  }

  /// The person left MOB-54 because the service is back (a later check found no block).
  void clear() => state = const ReleaseNotice();

  static Map<String, Object?>? _problemOf(Map<String, String> headers, String body) {
    if (!(headers['content-type'] ?? '').contains('json')) return null;
    try {
      final Object? decoded = jsonDecode(body);
      return decoded is Map<String, Object?> ? decoded : null;
    } on FormatException {
      return null;
    }
  }

  static DateTime? _timeOf(Object? value) => value is String ? DateTime.tryParse(value) : null;

  static String? _minimumOf(Map<String, Object?>? problem) {
    final Object? value = problem?['min_supported_version'];
    return value is String && RegExp(r'^\d+(\.\d+){0,2}(\+\d+)?$').hasMatch(value) ? value : null;
  }

  static Uri? _storeOf(Map<String, Object?>? problem) {
    final Object? value = problem?['store_url'];
    final Uri? url = value is String ? Uri.tryParse(value) : null;
    return url != null && url.scheme == 'https' && url.host.isNotEmpty && url.userInfo.isEmpty ? url : null;
  }
}

/// Tells the release state what the API answered (426 and 503), before the client turns the answer into a result.
final class ReleaseObservingTransport implements HttpTransport {
  const ReleaseObservingTransport(this._inner, this._report);

  final HttpTransport _inner;
  final void Function(int status, Map<String, String> headers, String body) _report;

  @override
  Future<HttpResult> send(HttpCall call) async {
    final HttpResult result = await _inner.send(call);
    if (result.status == 426 || result.status == 503) _report(result.status, result.headers, result.body);
    return result;
  }
}
