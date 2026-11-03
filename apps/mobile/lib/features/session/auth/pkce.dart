import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart' as crypto;

const int _minVerifierLength = 43;
const int _maxVerifierLength = 128;
const String _unreserved = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

String _base64UrlNoPadding(List<int> bytes) => base64Url.encode(bytes).replaceAll('=', '');

/// A random URL-safe token of [bytes] bytes of entropy (the `state` and the `nonce` of an authorization request).
String newRandomToken({Random? random, int bytes = 24}) {
  final Random source = random ?? Random.secure();
  return _base64UrlNoPadding(List<int>.generate(bytes, (int _) => source.nextInt(256)));
}

/// The one-time secret of a PKCE authorization (RFC 7636 section 4.1): 43 to 128 unreserved characters.
String newCodeVerifier({Random? random, int length = 64}) {
  if (length < _minVerifierLength || length > _maxVerifierLength) {
    throw RangeError.range(length, _minVerifierLength, _maxVerifierLength, 'length');
  }
  final Random source = random ?? Random.secure();
  return String.fromCharCodes(List<int>.generate(length, (int _) => _unreserved.codeUnitAt(source.nextInt(_unreserved.length))));
}

/// `S256` challenge of a verifier (RFC 7636 section 4.2): base64url of the SHA-256 digest, without padding.
String codeChallengeS256(String verifier) => _base64UrlNoPadding(crypto.sha256.convert(ascii.encode(verifier)).bytes);

/// What the app holds between the redirect to the system browser and the redirect back: the verifier that proves the app
/// that asked is the app that exchanges, the `state` that ties the answer to the question and the `nonce` that ties the
/// identity token to it. It lives in memory only; if the process dies in between, the user simply signs in again.
final class PkceSession {
  const PkceSession({required this.verifier, required this.state, required this.nonce});

  factory PkceSession.start({Random? random}) {
    final Random source = random ?? Random.secure();
    return PkceSession(
      verifier: newCodeVerifier(random: source),
      state: newRandomToken(random: source),
      nonce: newRandomToken(random: source),
    );
  }

  final String verifier;
  final String state;
  final String nonce;

  /// The URL for the system browser (not a web view): authorization code flow with PKCE. [acrValues] asks for a stronger
  /// authentication (`aal2`, the second factor); [loginHint] keeps the same account in a step-up.
  Uri authorizationUrl({
    required Uri authorizationEndpoint,
    required String clientId,
    required Uri redirectUri,
    required List<String> scopes,
    String? acrValues,
    String? loginHint,
  }) =>
      authorizationEndpoint.replace(queryParameters: <String, String>{
        ...authorizationEndpoint.queryParameters,
        'response_type': 'code',
        'client_id': clientId,
        'redirect_uri': redirectUri.toString(),
        'scope': scopes.join(' '),
        'state': state,
        'nonce': nonce,
        'code_challenge': codeChallengeS256(verifier),
        'code_challenge_method': 'S256',
        if (acrValues != null) 'acr_values': acrValues,
        if (loginHint != null) 'login_hint': loginHint,
      });

  /// The form body of the token request: the verifier proves that the app that asked is the app that exchanges.
  Map<String, String> tokenRequest({required String code, required String clientId, required Uri redirectUri}) => <String, String>{
        'grant_type': 'authorization_code',
        'code': code,
        'client_id': clientId,
        'redirect_uri': redirectUri.toString(),
        'code_verifier': verifier,
      };
}
