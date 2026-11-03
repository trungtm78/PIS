import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart' show DebugPrintCallback, debugPrint;
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/features/session/auth/auth_service.dart';
import 'package:machvon_mobile/features/session/auth/biometric_gate.dart';
import 'package:machvon_mobile/features/session/auth/identity_api.dart';
import 'package:machvon_mobile/features/session/auth/local_data.dart';
import 'package:machvon_mobile/features/session/auth/oidc_client.dart';
import 'package:machvon_mobile/features/session/auth/pkce.dart';
import 'package:machvon_mobile/features/session/auth/secure_store.dart';
import 'package:machvon_mobile/features/session/auth/session_vault.dart';

import '../../../support/harness.dart';

/// The Keychain or Keystore as a map.
class MemorySecureStore implements SecureValueStore {
  final Map<String, String> data = <String, String>{};

  @override
  Future<String?> read(String key) async => data[key];

  @override
  Future<void> write(String key, String value) async => data[key] = value;

  @override
  Future<void> delete(String key) async => data.remove(key);

  @override
  Future<Set<String>> keys() async => data.keys.toSet();
}

String _b64(Object? value) => base64Url.encode(utf8.encode(jsonEncode(value))).replaceAll('=', '');

/// An unsigned JWT: the application reads its claims and the API (not under test here) verifies the signature.
String testJwt(Map<String, Object?> claims) => '${_b64(<String, Object?>{'alg': 'none'})}.${_b64(claims)}.signature';

final Uri kIssuer = Uri.parse('https://idp.test/realms/machvon');
const String kClientId = 'machvon-mobile';
final OidcConfig kOidcConfig = OidcConfig.parse(issuer: kIssuer.toString(), clientId: kClientId);

class _Family {
  _Family(this.subject, this.acr);

  final String subject;
  final String acr;
  bool revoked = false;
  final List<String> issued = <String>[];
}

/// A fake OpenID provider: discovery, the authorization code with PKCE, refresh with rotation (a refresh token used twice
/// revokes the whole family, as Keycloak does), and revocation. It checks what a real one checks, so a wrong request fails.
class FakeIdp implements HttpTransport {
  FakeIdp(this.clock);

  final DateTime Function() clock;
  final Map<String, ({String challenge, String redirect, String subject, String acr, String nonce})> _codes =
      <String, ({String challenge, String redirect, String subject, String acr, String nonce})>{};
  final Map<String, _Family> _byRefresh = <String, _Family>{};
  final List<HttpCall> calls = <HttpCall>[];
  int _counter = 0;
  bool reachable = true;
  int tokenLifetime = 300;

  /// Claims of the next identity tokens that replace the honest ones (a wrong nonce, issuer, audience).
  final Map<String, Object?> claimOverrides = <String, Object?>{};

  /// The status the token endpoint answers with instead of working (a server error, a refusal).
  int? tokenEndpointStatus;

  /// Subjects whose sign-in includes a second factor from the start (a user with TOTP).
  final Set<String> alwaysSecondFactor = <String>{};

  /// What the browser does at the authorization endpoint: the person signs in as [subject]; the second factor is proven
  /// when the request asks for `aal2` and [passSecondFactor], or the subject always has it.
  Uri authorize(Uri url, {required String subject, bool passSecondFactor = true}) {
    final Map<String, String> query = url.queryParameters;
    final bool asked = query['acr_values'] == 'aal2';
    final String acr = alwaysSecondFactor.contains(subject) || (asked && passSecondFactor) ? 'aal2' : 'aal1';
    final String code = 'code-${_counter++}';
    _codes[code] = (
      challenge: query['code_challenge']!,
      redirect: query['redirect_uri']!,
      subject: subject,
      acr: acr,
      nonce: query['nonce']!,
    );
    return Uri.parse(query['redirect_uri']!).replace(queryParameters: <String, String>{'code': code, 'state': query['state']!});
  }

  String idToken(String subject, String acr, {String? nonce, int? lifetime}) => testJwt(<String, Object?>{
        'iss': kIssuer.toString(),
        'aud': kClientId,
        'sub': subject,
        'acr': acr,
        'exp': clock().add(Duration(seconds: lifetime ?? tokenLifetime)).millisecondsSinceEpoch ~/ 1000,
        if (nonce != null) 'nonce': nonce,
        ...claimOverrides,
      });

  HttpResult _json(int status, Object? body) =>
      HttpResult(status: status, headers: const <String, String>{'content-type': 'application/json'}, body: jsonEncode(body));

  String _newRefresh(_Family family) {
    final String token = 'refresh-${_counter++}-secret';
    _byRefresh[token] = family;
    family.issued.add(token);
    return token;
  }

  Map<String, Object?> _grant(_Family family, {String? nonce}) => <String, Object?>{
        'id_token': idToken(family.subject, family.acr, nonce: nonce),
        'refresh_token': _newRefresh(family),
        'expires_in': tokenLifetime,
        'token_type': 'Bearer',
      };

  /// The refresh token the provider last issued for the family of [token].
  String latestRefreshOf(String token) => _byRefresh[token]!.issued.last;

  bool familyRevoked(String token) => _byRefresh[token]!.revoked;

  @override
  Future<HttpResult> send(HttpCall call) async {
    calls.add(call);
    if (!reachable) throw StateError('connection refused');
    final String path = call.url.path;
    if (path.endsWith('/.well-known/openid-configuration')) {
      return _json(200, <String, Object?>{
        'issuer': kIssuer.toString(),
        'authorization_endpoint': '${kIssuer.toString()}/protocol/openid-connect/auth',
        'token_endpoint': '${kIssuer.toString()}/protocol/openid-connect/token',
        'revocation_endpoint': '${kIssuer.toString()}/protocol/openid-connect/revoke',
      });
    }
    final Map<String, String> form = Uri.splitQueryString(call.body ?? '');
    final int? forced = tokenEndpointStatus;
    if (forced != null) return _json(forced, <String, Object?>{'error': 'server_error'});
    if (path.endsWith('/revoke')) {
      _byRefresh[form['token']]?.revoked = true;
      return _json(200, <String, Object?>{});
    }
    if (form['client_id'] != kClientId) return _json(401, <String, Object?>{'error': 'invalid_client'});
    if (form['grant_type'] == 'authorization_code') {
      final ({String challenge, String redirect, String subject, String acr, String nonce})? grant = _codes.remove(form['code']);
      final bool proven = grant != null && codeChallengeS256(form['code_verifier'] ?? '') == grant.challenge && form['redirect_uri'] == grant.redirect;
      if (!proven) return _json(400, <String, Object?>{'error': 'invalid_grant'});
      return _json(200, _grant(_Family(grant.subject, grant.acr), nonce: grant.nonce));
    }
    final _Family? family = _byRefresh[form['refresh_token']];
    if (family == null || family.revoked) return _json(400, <String, Object?>{'error': 'invalid_grant'});
    if (family.issued.last != form['refresh_token']) {
      family.revoked = true;
      return _json(400, <String, Object?>{'error': 'invalid_grant'});
    }
    return _json(200, _grant(family));
  }
}

/// The system browser of the sign-in: it records the authorization URLs and answers like the person signing in.
class FakeBrowser implements AuthorizationBrowser {
  FakeBrowser(this.idp);

  final FakeIdp idp;
  final List<Uri> urls = <Uri>[];
  String subject = 'sub-ana';
  bool passSecondFactor = true;

  /// Replaces the callback the browser returns (a hijacked or tampered redirect).
  Uri Function(Uri callback)? tamper;
  Object? failure;

  /// While set, the browser stays open (the person is still typing); completing it lets the sign-in go on.
  Future<void>? hold;

  @override
  Future<Uri> authorize({required Uri url, required String callbackScheme}) async {
    urls.add(url);
    await hold;
    final Object? error = failure;
    if (error != null) throw error;
    final Uri callback = idp.authorize(url, subject: subject, passSecondFactor: passSecondFactor);
    return tamper == null ? callback : tamper!(callback);
  }
}

/// One membership of the fake API.
class FakeMembership {
  const FakeMembership(this.tenantId, this.tenantName, this.membershipId, this.type, {this.requiresMfa = false, this.status = 'Active', this.mode = 'FULL'});

  final String tenantId;
  final String tenantName;
  final String membershipId;
  final String type;
  final bool requiresMfa;
  final String status;
  final String mode;
}

/// A fake MACHVON API: the two operations that run before a tenant is chosen (they take the identity token), and `getMyProfile`
/// as a protected call (it takes the tenant token). The tenant tokens it issued can be ended, as the server does when a
/// session is revoked, idle or past its lifetime.
class FakeApi implements HttpTransport {
  FakeApi(this.idp, this.memberships);

  final FakeIdp idp;
  final Map<String, List<FakeMembership>> memberships;
  final List<HttpCall> calls = <HttpCall>[];
  final Map<String, ({String tenantId, String membershipId, String acr})> tenantTokens = <String, ({String tenantId, String membershipId, String acr})>{};
  final Set<String> ended = <String>{};
  int _counter = 0;

  /// The protected call answers 403 MFA_REQUIRED while the session is only `aal1`.
  bool profileNeedsSecondFactor = false;
  String? profileFailureCode;
  int profileFailureStatus = 0;

  /// The tenant selection answers this status and code instead of working (the session ended on the server).
  int selectFailureStatus = 0;
  String selectFailureCode = 'SESSION_EXPIRED';

  /// What the sessions and devices lists answer, the revocations received, and failures to script.
  final List<Map<String, Object?>> sessions = <Map<String, Object?>>[];
  final List<Map<String, Object?>> devices = <Map<String, Object?>>[];
  final List<HttpCall> revokeCalls = <HttpCall>[];
  bool revokeUnreachableOnce = false;
  int listFailureStatus = 0;
  String listFailureCode = 'INTERNAL_ERROR';
  bool listUnreachable = false;

  void _markRevoked(String id) {
    for (final Map<String, Object?> d in devices) {
      if (d['id'] == id) {
        d['status'] = 'REVOKED';
        d['revoked_at'] = '2026-11-03T01:00:00Z';
      }
    }
  }

  /// The published theme of each tenant (the JSON of `TenantThemeVersion`); a tenant without one answers 404.
  final Map<String, Map<String, Object?>> themes = <String, Map<String, Object?>>{};
  bool themeUnreachable = false;
  final List<String> themeRequests = <String>[];

  /// The list of memberships: the calls before [candidatesFailAfter] work, later ones answer the failure, wait for
  /// [candidatesHold], or never reach the server ([candidatesUnreachable]).
  int candidateCalls = 0;
  int candidatesFailAfter = 1 << 30;
  int candidatesFailureStatus = 500;
  String candidatesFailureCode = 'INTERNAL_ERROR';
  bool candidatesUnreachable = false;
  Future<void>? candidatesHold;
  int candidatesHoldAfter = 1 << 30;

  HttpResult _json(int status, Object? body) =>
      HttpResult(status: status, headers: const <String, String>{'content-type': 'application/json'}, body: jsonEncode(body));

  HttpResult _problem(int status, String code) => _json(status, <String, Object?>{
        'type': 'about:blank',
        'title': code,
        'status': status,
        'code': code,
        'correlation_id': 'corr-$status',
      });

  /// Ends every tenant session on the server.
  void endAllSessions() => ended.addAll(tenantTokens.keys);

  Map<String, Object?>? _identity(HttpCall call) {
    final String? header = call.headers['authorization'];
    if (header == null || !header.startsWith('Bearer ')) return null;
    final List<String> parts = header.substring(7).split('.');
    if (parts.length != 3) return null;
    return jsonDecode(utf8.decode(base64Url.decode(base64Url.normalize(parts[1])))) as Map<String, Object?>;
  }

  @override
  Future<HttpResult> send(HttpCall call) async {
    calls.add(call);
    final String path = call.url.path.replaceFirst('/v1', '');
    if (path == '/me/session/tenant-selection/candidates') {
      final int nth = candidateCalls++;
      if (nth >= candidatesHoldAfter) await candidatesHold;
      if (nth >= candidatesFailAfter) {
        if (candidatesUnreachable) throw StateError('connection refused');
        return _problem(candidatesFailureStatus, candidatesFailureCode);
      }
      final Map<String, Object?>? identity = _identity(call);
      if (identity == null) return _problem(401, 'SESSION_EXPIRED');
      final List<FakeMembership> mine = memberships[identity['sub']] ?? const <FakeMembership>[];
      return _json(200, <String, Object?>{
        'items': <Object?>[
          for (final FakeMembership m in mine)
            <String, Object?>{
              'tenant_id': m.tenantId,
              'tenant_name': m.tenantName,
              'tenant_status': 'Active',
              'membership_id': m.membershipId,
              'membership_type': m.type,
              'status': m.status,
              'valid_from': '2026-01-01T00:00:00Z',
              'valid_until': null,
            },
        ],
      });
    }
    if (path == '/me/session/tenant-selection') {
      final Map<String, Object?>? identity = _identity(call);
      if (identity == null) return _problem(401, 'SESSION_EXPIRED');
      if (selectFailureStatus != 0) return _problem(selectFailureStatus, selectFailureCode);
      final Map<String, Object?> body = jsonDecode(call.body!) as Map<String, Object?>;
      final FakeMembership? chosen = (memberships[identity['sub']] ?? const <FakeMembership>[])
          .where((FakeMembership m) => m.tenantId == body['tenant_id'] && m.membershipId == body['membership_id'])
          .firstOrNull;
      if (chosen == null) return _problem(403, 'TENANT_SELECTION_INVALID');
      if (chosen.requiresMfa && identity['acr'] != 'aal2') return _problem(403, 'MFA_REQUIRED');
      final String token = 'tenant-token-${_counter++}';
      tenantTokens[token] = (tenantId: chosen.tenantId, membershipId: chosen.membershipId, acr: identity['acr']! as String);
      return _json(200, <String, Object?>{
        'tenant_id': chosen.tenantId,
        'membership_id': chosen.membershipId,
        'scope_version': 1,
        'assurance_level': identity['acr'],
        'access_token': token,
        'token_type': 'Bearer',
        'expires_in': 300,
        'mode': chosen.mode,
      });
    }
    if (path == '/me/tenant/theme') {
      themeRequests.add(call.url.path);
      if (themeUnreachable) throw StateError('connection refused');
      final String? token = call.headers['authorization']?.replaceFirst('Bearer ', '');
      final ({String tenantId, String membershipId, String acr})? session = tenantTokens[token];
      if (session == null || ended.contains(token)) return _problem(401, 'SESSION_EXPIRED');
      final Map<String, Object?>? theme = themes[session.tenantId];
      return theme == null ? _problem(404, 'RESOURCE_NOT_FOUND') : _json(200, theme);
    }
    if (path == '/me/sessions' || path == '/me/devices') {
      final String? token = call.headers['authorization']?.replaceFirst('Bearer ', '');
      if (tenantTokens[token] == null || ended.contains(token)) return _problem(401, 'SESSION_EXPIRED');
      if (listFailureStatus != 0) return _problem(listFailureStatus, listFailureCode);
      if (listUnreachable) throw StateError('connection refused');
      return _json(200, path == '/me/sessions' ? <String, Object?>{'items': sessions, 'as_of': '2026-11-03T00:00:00Z'} : <String, Object?>{'items': devices, 'as_of': '2026-11-03T00:00:00Z'});
    }
    if (path.startsWith('/me/devices/') && path.endsWith('/revoke')) {
      revokeCalls.add(call);
      if (revokeUnreachableOnce) {
        revokeUnreachableOnce = false;
        final String id = path.split('/')[3];
        _markRevoked(id);
        throw StateError('answer lost');
      }
      final String id = path.split('/')[3];
      final bool known = devices.any((Map<String, Object?> d) => d['id'] == id);
      if (!known) return _problem(404, 'RESOURCE_NOT_FOUND');
      _markRevoked(id);
      return _json(200, <String, Object?>{'operation_id': '3f2b6c1e-0000-4000-8000-0000000000aa', 'status': 'Done', 'resource_version': 2});
    }
    if (path == '/me/profile') {
      final String? token = call.headers['authorization']?.replaceFirst('Bearer ', '');
      final ({String tenantId, String membershipId, String acr})? session = tenantTokens[token];
      if (session == null || ended.contains(token)) return _problem(401, 'SESSION_EXPIRED');
      if (profileFailureStatus != 0) return _problem(profileFailureStatus, profileFailureCode!);
      if (profileNeedsSecondFactor && session.acr != 'aal2') return _problem(403, 'MFA_REQUIRED');
      return _json(200, <String, Object?>{'id': 'u-1', 'display_name': 'Ana', 'email_masked': 'a***@example.vn', 'locale': 'vi-VN', 'version': 1});
    }
    return _problem(404, 'RESOURCE_NOT_FOUND');
  }
}

/// Sends each call to the provider or the API by host, so one transport serves both as on a phone.
class WorldTransport implements HttpTransport {
  WorldTransport(this.idp, this.api);

  final FakeIdp idp;
  final FakeApi api;

  @override
  Future<HttpResult> send(HttpCall call) => call.url.host == kIssuer.host ? idp.send(call) : api.send(call);
}

/// The biometric prompt: scripted answers.
class FakeBiometrics implements BiometricGate {
  bool available = true;
  bool answer = true;
  final List<String> prompts = <String>[];

  @override
  Future<bool> isAvailable() async => available;

  @override
  Future<bool> authenticate({required String reason}) async {
    prompts.add(reason);
    return answer;
  }
}

/// A purger that records what it was asked to delete.
class RecordingPurger implements LocalDataPurger {
  final List<({String tenantId, String userId})> purged = <({String tenantId, String userId})>[];
  int purgedAll = 0;
  Object? failure;

  @override
  Future<void> purgeTenant({required String tenantId, required String userId}) async {
    final Object? error = failure;
    if (error != null) throw error;
    purged.add((tenantId: tenantId, userId: userId));
  }

  @override
  Future<void> purgeAll() async => purgedAll += 1;
}

const FakeMembership tenantAMember = FakeMembership('tenant-a', 'UBND Minh Hà', 'm-a1', 'LEADER');
const FakeMembership tenantBMember = FakeMembership('tenant-b', 'Bộ Thử Nghiệm', 'm-b1', 'SPECIALIST');

/// Everything a session test needs, wired the way the application wires it.
class World {
  World({Map<String, List<FakeMembership>>? memberships, DateTime? start, int pendingCommands = 0}) {
    now = start ?? DateTime.utc(2026, 11, 3, 8);
    idp = FakeIdp(() => now);
    api = FakeApi(idp, memberships ?? <String, List<FakeMembership>>{'sub-ana': <FakeMembership>[tenantAMember]});
    transport = WorldTransport(idp, api);
    browser = FakeBrowser(idp);
    pending = pendingCommands;
  }

  late DateTime now;
  late final FakeIdp idp;
  late final FakeApi api;
  late final WorldTransport transport;
  late final FakeBrowser browser;
  final MemorySecureStore store = MemorySecureStore();
  final FakeBiometrics biometrics = FakeBiometrics();
  final RecordingPurger purger = RecordingPurger();

  /// Purgers besides the recording one (the real encrypted store of a test).
  final List<LocalDataPurger> extraPurgers = <LocalDataPurger>[];
  late int pending;
  final List<AuthService> services = <AuthService>[];

  DateTime clock() => now;

  void advance(Duration by) => now = now.add(by);

  SessionVault get vault => SessionVault(store);

  /// A service as the application builds it, on this world's store (a restart builds another on the same store).
  AuthService service() => serviceOn(store);

  /// A service on another secure store (a copy of this device's vault, a second device).
  AuthService serviceOn(MemorySecureStore secure, {bool Function()? biometricUnlockAllowed}) {
    final AuthService built = AuthService(
      oidc: OidcClient(transport: transport, browser: browser, now: clock, random: Random(7)),
      api: IdentityApi(baseUrl: testConfig.apiBaseUrl, transport: transport),
      vault: SessionVault(secure),
      purge: TenantDataPurge(vault: SessionVault(secure), purgers: <LocalDataPurger>[purger, ...extraPurgers]),
      biometrics: biometrics,
      pendingCommands: () async => pending,
      biometricUnlockAllowed: biometricUnlockAllowed,
      now: clock,
    );
    services.add(built);
    return built;
  }

  void dispose() {
    for (final AuthService built in services) {
      built.dispose();
    }
  }
}

/// The states a service went through, as snapshots.
List<SessionSnapshot> recordChanges(AuthService service) {
  final List<SessionSnapshot> seen = <SessionSnapshot>[];
  service.changes.listen(seen.add);
  return seen;
}

/// Runs [body] and collects everything it prints or sends to the debug log.
Future<void> runPrinted(List<String> lines, Future<void> Function() body) async {
  final DebugPrintCallback original = debugPrint;
  debugPrint = (String? message, {int? wrapWidth}) => lines.add(message ?? '');
  try {
    await runZoned(
      body,
      zoneSpecification: ZoneSpecification(print: (Zone self, ZoneDelegate parent, Zone zone, String line) => lines.add(line)),
    );
  } finally {
    debugPrint = original;
  }
}

/// The JSON of a `TenantThemeVersion` the server serves for [tenantId] at [version]: the colours of the base theme with the
/// primary colour of the tenant, which passes the contrast rules unless [primaryText] is changed.
Map<String, Object?> themeJson(String tenantId, int version, {String primary = '#0b4a8f', String primaryText = '#ffffff'}) => <String, Object?>{
      'tenantId': tenantId,
      'version': version,
      'hash': (version.toRadixString(16).padLeft(2, '0') * 32).substring(0, 64),
      'publishedAt': '2026-10-01T00:00:00Z',
      'sourceVersion': null,
      'config': <String, Object?>{
        'name': 'Tenant $tenantId',
        'title': 'Title',
        'subtitle': '',
        'header': 'Header',
        'footer': '',
        'address': '',
        'email': '',
        'phone': '',
        'primary': primary,
        'primaryText': primaryText,
        'menu': '#ffffff',
        'menuText': '#68616c',
        'selected': '#fff0f2',
        'selectedText': '#a11d37',
        'headerBg': '#ffffff',
        'headerText': '#29272d',
        'footerBg': '#ffffff',
        'footerText': '#68616c',
        'background': '#f7f5f4',
        'titleColor': '#29272d',
        'logoAssetId': null,
      },
    };
