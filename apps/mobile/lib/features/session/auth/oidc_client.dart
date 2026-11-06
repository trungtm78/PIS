import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/services.dart' show PlatformException;
import 'package:flutter_web_auth_2/flutter_web_auth_2.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

import '../../../core/session/session.dart';
import 'jwt_claims.dart';
import 'pkce.dart';

/// The address the identity provider sends the system browser back to: the custom scheme of the application. The same
/// scheme is declared in the Android manifest (`CallbackActivity`) and nowhere else, so no other application is offered
/// the redirect on a device where only this one declares it.
const String kMobileRedirectUri = 'vn.machvon.app:/oauth2redirect';

/// The value of `acr_values` that asks the identity provider for the second factor.
const String kSecondFactorAcr = 'aal2';

const Duration _clockSkew = Duration(minutes: 1);
const Set<String> _loopbackHosts = <String>{'localhost', '127.0.0.1', '10.0.2.2'};

/// Why a sign-in step failed. The exception carries this code and nothing else: no text from the provider, no address,
/// no token can reach a log or a screen through it.
enum OidcFailure {
  discoveryFailed,
  browserCancelled,
  browserFailed,
  callbackInvalid,
  stateMismatch,
  providerRefused,
  tokenExchangeFailed,
  nonceMismatch,
  tokenInvalid,
  secondFactorNotSatisfied,

  /// The provider no longer accepts the refresh token (revoked, expired, or used twice): the session is over.
  refreshRejected,

  /// The provider could not be reached or answered with a server error: the session is intact, try again later.
  unreachable,
}

final class OidcException implements Exception {
  const OidcException(this.failure);

  final OidcFailure failure;

  @override
  String toString() => 'OidcException(${failure.name})';
}

/// Who and where: the identity provider of the tenant, this application as a public client, the address of the redirect.
final class OidcConfig {
  const OidcConfig({
    required this.issuer,
    required this.clientId,
    required this.redirectUri,
    this.scopes = const <String>['openid'],
  });

  /// Reads the configuration and refuses what cannot be trusted: an issuer that is not https (or a loopback address when
  /// [allowInsecureLoopback]), user info, a query or a fragment in it, or a redirect that is not a custom scheme.
  factory OidcConfig.parse({
    required String issuer,
    required String clientId,
    String redirectUri = kMobileRedirectUri,
    bool allowInsecureLoopback = false,
  }) {
    final Uri? url = Uri.tryParse(issuer.trim().replaceAll(RegExp(r'/+$'), ''));
    final bool loopback = url != null && _loopbackHosts.contains(url.host);
    final bool secure = url != null && (url.scheme == 'https' || (allowInsecureLoopback && loopback && url.scheme == 'http'));
    if (url == null || !secure || !url.hasAuthority || url.host.isEmpty || url.userInfo.isNotEmpty || url.hasQuery || url.hasFragment) {
      throw const OidcException(OidcFailure.discoveryFailed);
    }
    final Uri? redirect = Uri.tryParse(redirectUri);
    if (clientId.trim().isEmpty || redirect == null || redirect.scheme.isEmpty || redirect.scheme == 'http' || redirect.scheme == 'https') {
      throw const OidcException(OidcFailure.callbackInvalid);
    }
    return OidcConfig(issuer: url, clientId: clientId.trim(), redirectUri: redirect);
  }

  /// Reads what [toJson] wrote. The vault is on the device, so a loopback issuer written by a debug build is read back.
  factory OidcConfig.fromJson(Map<String, Object?> json) => OidcConfig.parse(
        issuer: json['issuer']! as String,
        clientId: json['client_id']! as String,
        redirectUri: json['redirect_uri']! as String,
        allowInsecureLoopback: true,
      );

  final Uri issuer;
  final String clientId;
  final Uri redirectUri;
  final List<String> scopes;

  Map<String, Object?> toJson() => <String, Object?>{
        'issuer': issuer.toString(),
        'client_id': clientId,
        'redirect_uri': redirectUri.toString(),
      };

  @override
  bool operator ==(Object other) =>
      other is OidcConfig && other.issuer == issuer && other.clientId == clientId && other.redirectUri == redirectUri;

  @override
  int get hashCode => Object.hash(issuer, clientId, redirectUri);
}

/// The endpoints the issuer announces in its discovery document.
final class OidcEndpoints {
  const OidcEndpoints({required this.authorization, required this.token, this.revocation, this.endSession});

  final Uri authorization;
  final Uri token;
  final Uri? revocation;
  final Uri? endSession;
}

/// The identity of the person as the provider vouches for it. [idToken] is what the API takes as the identity token; the
/// refresh token is what renews it. `toString` never shows either.
final class OidcTokens {
  const OidcTokens({
    required this.idToken,
    required this.subject,
    required this.assurance,
    required this.expiresIn,
    this.refreshToken,
  });

  final String idToken;
  final String? refreshToken;
  final String subject;
  final AssuranceLevel assurance;

  /// Seconds the identity token has left, from its validated `exp` claim (0 when it is already past).
  final int expiresIn;

  @override
  String toString() => 'OidcTokens(subject: $subject, assurance: ${assurance.name})';
}

/// Opens the system browser (ASWebAuthenticationSession on iOS, a Custom Tab on Android), lets the person sign in there, and
/// returns the address the provider redirected to. The application never shows the sign-in form itself, so it never sees
/// the password or the second factor.
abstract interface class AuthorizationBrowser {
  Future<Uri> authorize({required Uri url, required String callbackScheme});
}

/// The [AuthorizationBrowser] on `flutter_web_auth_2`.
final class SystemAuthorizationBrowser implements AuthorizationBrowser {
  const SystemAuthorizationBrowser();

  @override
  Future<Uri> authorize({required Uri url, required String callbackScheme}) async {
    try {
      final String callback = await FlutterWebAuth2.authenticate(url: url.toString(), callbackUrlScheme: callbackScheme);
      return Uri.parse(callback);
    } on PlatformException catch (error) {
      throw OidcException(error.code == 'CANCELED' ? OidcFailure.browserCancelled : OidcFailure.browserFailed);
    } on FormatException {
      throw const OidcException(OidcFailure.callbackInvalid);
    }
  }
}

/// The OpenID Connect part of the sign-in: Authorization Code with PKCE through the system browser, the checks that tie
/// the answer to the question (state, nonce, issuer, audience, redirect), the refresh with rotation, and the revocation.
///
/// It talks to the provider through the [HttpTransport] port and to the browser through [AuthorizationBrowser], so the whole
/// flow is tested against a fake provider; only a device and a real provider prove the browser and the provider themselves.
final class OidcClient {
  OidcClient({
    required HttpTransport transport,
    required AuthorizationBrowser browser,
    DateTime Function()? now,
    Random? random,
  })  : _transport = transport,
        _browser = browser,
        _now = now ?? DateTime.now,
        _random = random;

  final HttpTransport _transport;
  final AuthorizationBrowser _browser;
  final DateTime Function() _now;
  final Random? _random;
  final Map<String, OidcEndpoints> _endpoints = <String, OidcEndpoints>{};

  /// Signs the person in through the system browser and returns the identity tokens. [secondFactor] asks for `aal2` and
  /// refuses an answer that does not prove it; [loginHint] keeps the same account.
  Future<OidcTokens> signIn(OidcConfig config, {bool secondFactor = false, String? loginHint}) async {
    final OidcEndpoints endpoints = await discover(config);
    final PkceSession pkce = PkceSession.start(random: _random);
    final Uri url = pkce.authorizationUrl(
      authorizationEndpoint: endpoints.authorization,
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      scopes: config.scopes,
      acrValues: secondFactor ? kSecondFactorAcr : null,
      loginHint: loginHint,
    );
    final Uri callback = await _browser.authorize(url: url, callbackScheme: config.redirectUri.scheme);
    final String code = _codeFrom(callback, config, pkce);
    final Map<String, Object?> body = await _postToken(
      endpoints,
      pkce.tokenRequest(code: code, clientId: config.clientId, redirectUri: config.redirectUri),
      rejected: OidcFailure.tokenExchangeFailed,
    );
    final OidcTokens tokens = _tokensFrom(body, config, nonce: pkce.nonce);
    if (secondFactor && tokens.assurance != AssuranceLevel.aal2) throw const OidcException(OidcFailure.secondFactorNotSatisfied);
    return tokens;
  }

  /// Renews the identity token with the refresh token. The provider rotates the refresh token: the answer carries the next
  /// one, and the one used is dead (a second use of it makes the provider revoke the whole family of tokens).
  Future<OidcTokens> refresh(OidcConfig config, String refreshToken) async {
    final OidcEndpoints endpoints = await discover(config);
    final Map<String, Object?> body = await _postToken(
      endpoints,
      <String, String>{'grant_type': 'refresh_token', 'refresh_token': refreshToken, 'client_id': config.clientId},
      rejected: OidcFailure.refreshRejected,
    );
    return _tokensFrom(body, config);
  }

  /// Asks the provider to end the session behind a refresh token: the revocation endpoint (RFC 7009) when the provider has
  /// one, otherwise its end-session endpoint called directly with the refresh token. Best effort: a failure here never
  /// stops the local sign-out, which has already removed every token from the device.
  Future<void> revoke(OidcConfig config, String refreshToken) async {
    try {
      final OidcEndpoints endpoints = await discover(config);
      final Uri? target = endpoints.revocation ?? endpoints.endSession;
      if (target == null) return;
      final Map<String, String> form = endpoints.revocation != null
          ? <String, String>{'token': refreshToken, 'token_type_hint': 'refresh_token', 'client_id': config.clientId}
          : <String, String>{'refresh_token': refreshToken, 'client_id': config.clientId};
      await _transport.send(_formCall(target, form));
    } on Object {
      return;
    }
  }

  /// The endpoints of the issuer, read once from its discovery document and kept for the life of the process.
  Future<OidcEndpoints> discover(OidcConfig config) async {
    final String key = config.issuer.toString();
    final OidcEndpoints? known = _endpoints[key];
    if (known != null) return known;
    final HttpResult result;
    try {
      result = await _transport.send(HttpCall(
        method: 'GET',
        url: config.issuer.replace(path: '${config.issuer.path}/.well-known/openid-configuration'),
        headers: const <String, String>{'accept': 'application/json'},
      ));
    } on Object {
      throw const OidcException(OidcFailure.unreachable);
    }
    final Map<String, Object?>? document = result.ok ? _jsonObject(result.body) : null;
    final Uri? authorization = _endpointUri(document?['authorization_endpoint'], config.issuer);
    final Uri? token = _endpointUri(document?['token_endpoint'], config.issuer);
    final Object? announced = document?['issuer'];
    if (authorization == null || token == null || announced is! String || announced.replaceAll(RegExp(r'/+$'), '') != key) {
      throw const OidcException(OidcFailure.discoveryFailed);
    }
    return _endpoints[key] = OidcEndpoints(
      authorization: authorization,
      token: token,
      revocation: _endpointUri(document?['revocation_endpoint'], config.issuer),
      endSession: _endpointUri(document?['end_session_endpoint'], config.issuer),
    );
  }

  /// The code in the address the browser came back with, after every check that ties it to this request.
  String _codeFrom(Uri callback, OidcConfig config, PkceSession pkce) {
    final Uri expected = config.redirectUri;
    if (callback.scheme != expected.scheme || callback.host != expected.host || callback.path != expected.path) {
      throw const OidcException(OidcFailure.callbackInvalid);
    }
    final Map<String, String> query = callback.queryParameters;
    if (!_sameText(query['state'] ?? '', pkce.state)) throw const OidcException(OidcFailure.stateMismatch);
    if (query.containsKey('error')) throw const OidcException(OidcFailure.providerRefused);
    final String? issuer = query['iss'];
    if (issuer != null && issuer.replaceAll(RegExp(r'/+$'), '') != config.issuer.toString()) {
      throw const OidcException(OidcFailure.callbackInvalid);
    }
    final String? code = query['code'];
    if (code == null || code.isEmpty) throw const OidcException(OidcFailure.callbackInvalid);
    return code;
  }

  Future<Map<String, Object?>> _postToken(OidcEndpoints endpoints, Map<String, String> form, {required OidcFailure rejected}) async {
    final HttpResult result;
    try {
      result = await _transport.send(_formCall(endpoints.token, form));
    } on Object {
      throw const OidcException(OidcFailure.unreachable);
    }
    if (result.status >= 500) throw const OidcException(OidcFailure.unreachable);
    final Map<String, Object?>? body = result.ok ? _jsonObject(result.body) : null;
    if (body == null) throw OidcException(rejected);
    return body;
  }

  OidcTokens _tokensFrom(Map<String, Object?> body, OidcConfig config, {String? nonce}) {
    final Object? idToken = body['id_token'];
    final Object? refreshToken = body['refresh_token'];
    if (idToken is! String || idToken.isEmpty) throw const OidcException(OidcFailure.tokenInvalid);
    final Map<String, Object?>? claims = jwtClaims(idToken);
    if (claims == null) throw const OidcException(OidcFailure.tokenInvalid);
    if (!_sameIssuer(claims['iss'], config.issuer) || !_audienceHas(claims['aud'], config.clientId)) {
      throw const OidcException(OidcFailure.tokenInvalid);
    }
    final Object? expiry = claims['exp'];
    final Object? subject = claims['sub'];
    if (subject is! String || subject.isEmpty || expiry is! num) throw const OidcException(OidcFailure.tokenInvalid);
    final DateTime expiresAt = DateTime.fromMillisecondsSinceEpoch((expiry * 1000).round(), isUtc: true);
    final DateTime now = _now().toUtc();
    if (expiresAt.isBefore(now.subtract(_clockSkew))) throw const OidcException(OidcFailure.tokenInvalid);
    if (nonce != null && !_sameText(claims['nonce'] is String ? claims['nonce']! as String : '', nonce)) {
      throw const OidcException(OidcFailure.nonceMismatch);
    }
    return OidcTokens(
      idToken: idToken,
      subject: subject,
      refreshToken: refreshToken is String && refreshToken.isNotEmpty ? refreshToken : null,
      assurance: _assuranceOf(claims),
      // The lifetime of the identity token is its own `exp`: `expires_in` of the token endpoint describes the access token, which
      // some providers keep longer than the identity token.
      expiresIn: expiresAt.isAfter(now) ? expiresAt.difference(now).inSeconds : 0,
    );
  }

  HttpCall _formCall(Uri url, Map<String, String> form) => HttpCall(
        method: 'POST',
        url: url,
        headers: const <String, String>{'accept': 'application/json', 'content-type': 'application/x-www-form-urlencoded'},
        body: Uri(queryParameters: form).query,
      );
}

AssuranceLevel _assuranceOf(Map<String, Object?> claims) {
  final Object? acr = claims['acr'];
  final Object? amr = claims['amr'];
  final bool byAcr = acr == 'aal2' || acr == '2';
  final bool byAmr = amr is List<Object?> && amr.contains('mfa');
  return byAcr || byAmr ? AssuranceLevel.aal2 : AssuranceLevel.aal1;
}

bool _sameIssuer(Object? claim, Uri issuer) => claim is String && claim.replaceAll(RegExp(r'/+$'), '') == issuer.toString();

bool _audienceHas(Object? audience, String clientId) =>
    audience == clientId || (audience is List<Object?> && audience.contains(clientId));

/// An endpoint of the discovery document: https, or plain http on the very address of an issuer that is itself plain http (an
/// issuer is only accepted that way for a loopback host of a debug build, see [OidcConfig.parse]).
Uri? _endpointUri(Object? value, Uri issuer) {
  if (value is! String) return null;
  final Uri? url = Uri.tryParse(value);
  if (url == null || url.host.isEmpty) return null;
  if (url.scheme == 'https') return url;
  return url.scheme == 'http' && issuer.scheme == 'http' && url.host == issuer.host && url.port == issuer.port ? url : null;
}

Map<String, Object?>? _jsonObject(String text) {
  try {
    final Object? decoded = jsonDecode(text);
    return decoded is Map<String, Object?> ? decoded : null;
  } on FormatException {
    return null;
  }
}

/// Compares two secrets without stopping at the first difference.
bool _sameText(String a, String b) {
  if (a.length != b.length) return false;
  int difference = 0;
  for (int index = 0; index < a.length; index += 1) {
    difference |= a.codeUnitAt(index) ^ b.codeUnitAt(index);
  }
  return difference == 0;
}
