import 'dart:convert';

import 'package:machvon_api_client/machvon_api_client.dart';

import '../session/auth/oidc_client.dart';
import 'published_theme.dart';

/// What the application learns from a tenant code or domain before anyone signs in: the identity provider to sign in to and
/// the published theme to look like.
final class TenantDiscovery {
  const TenantDiscovery({required this.code, required this.tenantName, required this.oidc, this.theme});

  final String code;
  final String tenantName;
  final OidcConfig oidc;

  /// The published theme, or null when the tenant has none or the answer carried one the application cannot use.
  final PublishedTheme? theme;
}

/// The code or domain is not a tenant of this platform. It is the answer to every lookup that finds nothing: an unknown code,
/// a tenant that is not open for sign-in and a refused request all look the same, so the answer never confirms that a
/// tenant exists.
final class TenantNotFound implements Exception {
  const TenantNotFound();

  @override
  String toString() => 'TenantNotFound';
}

/// Too many lookups; the server says how long to wait.
final class TenantLookupRateLimited implements Exception {
  const TenantLookupRateLimited(this.retryAfter);

  final Duration retryAfter;

  @override
  String toString() => 'TenantLookupRateLimited';
}

/// The tenant directory: unauthenticated lookup of a tenant by code or domain.
abstract interface class TenantDirectory {
  Future<TenantDiscovery> lookup(String codeOrDomain);
}

final RegExp _tenantInput = RegExp(r'^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$');

/// The code or domain the person typed, in the form the directory is asked for: trimmed, lower case, without a scheme, a path
/// or a trailing dot. Null when it cannot be a code or a domain (the lookup is not even sent).
String? normalizeTenantInput(String raw) {
  String value = raw.trim().toLowerCase();
  value = value.replaceFirst(RegExp(r'^[a-z][a-z0-9+.-]*://'), '');
  final int cut = value.indexOf(RegExp(r'[/?#]'));
  if (cut >= 0) value = value.substring(0, cut);
  value = value.replaceAll(RegExp(r'\.+$'), '');
  if (value.contains('..') || !_tenantInput.hasMatch(value)) return null;
  return value;
}

/// The [TenantDirectory] on the MACHVON API: `GET {api}/tenant-discovery?q=<code or domain>`, no credential.
///
/// The contract is the one the story asks of SAS/IAM (an open cross-group request, nothing in `openapi.json` yet): the answer is
/// `{tenant_name, tenant_code, oidc: {issuer, client_id}, theme: TenantThemeVersion | null}` for a tenant that is open for
/// sign-in, and one uniform 404 for everything else, with a rate limit (429 and `Retry-After`).
final class HttpTenantDirectory implements TenantDirectory {
  HttpTenantDirectory({required this.baseUrl, required this.transport, this.locale, String Function()? newCorrelationId})
      : _newCorrelationId = newCorrelationId ?? newUuidV4;

  final Uri baseUrl;
  final HttpTransport transport;
  final String Function()? locale;
  final String Function() _newCorrelationId;

  @override
  Future<TenantDiscovery> lookup(String codeOrDomain) async {
    final String? query = normalizeTenantInput(codeOrDomain);
    if (query == null) throw const TenantNotFound();
    final String correlation = _newCorrelationId();
    final String path = '${baseUrl.path.replaceAll(RegExp(r'/+$'), '')}/tenant-discovery';
    final HttpResult result;
    try {
      result = await transport.send(HttpCall(
        method: 'GET',
        url: baseUrl.replace(path: path, queryParameters: <String, String>{'q': query}),
        headers: <String, String>{
          'accept': 'application/json',
          'x-correlation-id': correlation,
          if (locale != null) 'accept-language': locale!(),
        },
      ));
    } on Object {
      throw ApiError.network(correlation);
    }
    if (result.status == 429) {
      final ApiError error = ApiError.fromResponse(status: 429, headers: result.headers, body: result.body, fallbackCorrelationId: correlation);
      throw TenantLookupRateLimited(Duration(seconds: error.retryAfterSeconds ?? 30));
    }
    if (result.status >= 500) {
      throw ApiError.fromResponse(status: result.status, headers: result.headers, body: result.body, fallbackCorrelationId: correlation);
    }
    if (!result.ok) throw const TenantNotFound();
    return _parse(result.body, query, correlation);
  }

  TenantDiscovery _parse(String body, String query, String correlation) {
    final Object? json;
    try {
      json = jsonDecode(body);
    } on FormatException {
      throw ApiError.unusableAnswer(200, correlation);
    }
    if (json is! Map<String, Object?>) throw ApiError.unusableAnswer(200, correlation);
    final Object? oidc = json['oidc'];
    final Object? name = json['tenant_name'];
    final Object? code = json['tenant_code'];
    if (oidc is! Map<String, Object?> || name is! String || name.isEmpty) throw ApiError.unusableAnswer(200, correlation);
    final Object? issuer = oidc['issuer'];
    final Object? clientId = oidc['client_id'];
    if (issuer is! String || clientId is! String) throw ApiError.unusableAnswer(200, correlation);
    final OidcConfig config;
    try {
      config = OidcConfig.parse(issuer: issuer, clientId: clientId);
    } on OidcException {
      throw ApiError.unusableAnswer(200, correlation);
    }
    final PublishedTheme? theme = PublishedTheme.tryParse(json['theme']);
    return TenantDiscovery(code: code is String && code.isNotEmpty ? code : query, tenantName: name, oidc: config, theme: theme);
  }
}

/// Limits the lookups the person can make from this phone: [maxAttempts] in [window]. It is a courtesy to the server and to the
/// person (a mistyped code is tried again, a script is slowed); the server limits as well and its 429 wins.
final class LookupThrottle {
  LookupThrottle({required this.now, this.maxAttempts = 5, this.window = const Duration(minutes: 1)});

  final DateTime Function() now;
  final int maxAttempts;
  final Duration window;
  final List<DateTime> _attempts = <DateTime>[];

  /// How long to wait before the next lookup, or null when one may be made now.
  Duration? waitTime() {
    final DateTime current = now();
    _attempts.removeWhere((DateTime at) => current.difference(at) >= window);
    if (_attempts.length < maxAttempts) return null;
    return window - current.difference(_attempts.first);
  }

  void record() => _attempts.add(now());
}
