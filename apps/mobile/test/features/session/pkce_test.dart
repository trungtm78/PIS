import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/features/session/auth/pkce.dart';

void main() {
  final Uri authorize = Uri.parse('https://idp.example.test/realms/test/protocol/openid-connect/auth');
  final Uri redirect = Uri.parse('vn.machvon.app:/oauth2redirect');

  group('AC-ST-MOB-002-1 TK-MOB-002-1 PKCE (RFC 7636)', () {
    test('derives the S256 challenge of RFC 7636 appendix B', () {
      expect(codeChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    });

    test('makes verifiers of 43 to 128 unreserved characters and refuses other lengths', () {
      final String verifier = newCodeVerifier(random: Random(1));
      expect(verifier.length, 64);
      expect(RegExp(r'^[A-Za-z0-9\-._~]+$').hasMatch(verifier), isTrue);
      expect(() => newCodeVerifier(length: 42), throwsRangeError);
      expect(() => newCodeVerifier(length: 129), throwsRangeError);
      expect(newCodeVerifier(length: 43).length, 43);
      expect(newCodeVerifier(length: 128).length, 128);
      expect(PkceSession.start().verifier, isNot(PkceSession.start().verifier));
    });

    test('a session has its own verifier, state and nonce, none of them shared', () {
      final PkceSession session = PkceSession.start(random: Random(5));
      expect(<String>{session.verifier, session.state, session.nonce}.length, 3);
      expect(session.state.length, greaterThanOrEqualTo(32));
      expect(newRandomToken(random: Random(5)), newRandomToken(random: Random(5)));
    });

    test('builds an authorization request that carries the challenge, the state and the nonce and never the verifier', () {
      final PkceSession session = PkceSession.start(random: Random(2));
      final Uri url = session.authorizationUrl(
        authorizationEndpoint: authorize,
        clientId: 'machvon-mobile',
        redirectUri: redirect,
        scopes: <String>['openid', 'profile'],
      );
      expect(url.queryParameters['response_type'], 'code');
      expect(url.queryParameters['code_challenge_method'], 'S256');
      expect(url.queryParameters['code_challenge'], codeChallengeS256(session.verifier));
      expect(url.queryParameters['scope'], 'openid profile');
      expect(url.queryParameters['state'], session.state);
      expect(url.queryParameters['nonce'], session.nonce);
      expect(url.queryParameters.containsKey('acr_values'), isFalse);
      expect(url.queryParameters.containsKey('client_secret'), isFalse);
      expect(url.toString(), isNot(contains(session.verifier)));
    });

    test('asks for the second factor and keeps the account with acr_values and login_hint', () {
      final Uri url = PkceSession.start(random: Random(3)).authorizationUrl(
        authorizationEndpoint: authorize,
        clientId: 'machvon-mobile',
        redirectUri: redirect,
        scopes: <String>['openid'],
        acrValues: 'aal2',
        loginHint: 'ana',
      );
      expect(url.queryParameters['acr_values'], 'aal2');
      expect(url.queryParameters['login_hint'], 'ana');
    });

    test('the token request proves the verifier and carries no client secret', () {
      final PkceSession session = PkceSession.start(random: Random(4));
      final Map<String, String> form = session.tokenRequest(code: 'abc123', clientId: 'machvon-mobile', redirectUri: redirect);
      expect(form['grant_type'], 'authorization_code');
      expect(form['code'], 'abc123');
      expect(form['code_verifier'], session.verifier);
      expect(form.containsKey('client_secret'), isFalse);
    });
  });
}
