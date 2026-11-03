import 'dart:math';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_web_auth_2_platform_interface/flutter_web_auth_2_platform_interface.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/features/session/auth/jwt_claims.dart';
import 'package:machvon_mobile/features/session/auth/oidc_client.dart';
import 'package:machvon_mobile/features/session/auth/pkce.dart';

import 'support/world.dart';

class _ScriptedWebAuth extends FlutterWebAuth2Platform {
  _ScriptedWebAuth(this.answer);

  final Future<String> Function(String url, String scheme) answer;

  @override
  Future<String> authenticate({required String url, required String callbackUrlScheme, required Map<String, dynamic> options}) =>
      answer(url, callbackUrlScheme);

  @override
  Future<void> clearAllDanglingCalls() async {}
}

Future<OidcException> _failure(Future<Object?> action) async {
  try {
    await action;
  } on OidcException catch (error) {
    return error;
  }
  fail('the step was expected to fail');
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late World world;
  late OidcClient client;

  setUp(() {
    world = World();
    client = OidcClient(transport: world.transport, browser: world.browser, now: world.clock, random: Random(11));
  });

  tearDown(() => world.dispose());

  group('AC-ST-MOB-002-1 UI-MOB-02 TK-MOB-002-1 the authorization code flow with PKCE', () {
    test('the app sends the challenge, state and nonce, receives only the code and proves the verifier on exchange', () async {
      final OidcTokens tokens = await client.signIn(kOidcConfig);

      final Uri request = world.browser.urls.single;
      expect(request.queryParameters['response_type'], 'code');
      expect(request.queryParameters['code_challenge_method'], 'S256');
      expect(request.queryParameters['client_id'], kClientId);
      expect(request.queryParameters['redirect_uri'], kMobileRedirectUri);
      expect(request.queryParameters['state'], isNotEmpty);
      expect(request.queryParameters['nonce'], isNotEmpty);
      for (final String forbidden in <String>['password', 'client_secret', 'code_verifier', 'username']) {
        expect(request.queryParameters.containsKey(forbidden), isFalse, reason: forbidden);
      }

      final HttpCall exchange = world.idp.calls.lastWhere((HttpCall call) => call.method == 'POST');
      final Map<String, String> form = Uri.splitQueryString(exchange.body!);
      expect(form['grant_type'], 'authorization_code');
      expect(codeChallengeS256(form['code_verifier']!), request.queryParameters['code_challenge']);
      expect(form.containsKey('client_secret'), isFalse);
      expect(form.containsKey('password'), isFalse);
      expect(exchange.headers.containsKey('authorization'), isFalse);

      expect(tokens.subject, 'sub-ana');
      expect(tokens.refreshToken, isNotNull);
      expect(tokens.assurance, AssuranceLevel.aal1);
    });

    test('a user with a second factor gets an aal2 identity token from the sign-in alone', () async {
      world.idp.alwaysSecondFactor.add('sub-ana');
      expect((await client.signIn(kOidcConfig)).assurance, AssuranceLevel.aal2);
    });

    test('no token, code or verifier is in an address the app opens or in the text of any failure', () async {
      final OidcTokens tokens = await client.signIn(kOidcConfig);
      final String secrets = '${tokens.idToken} ${tokens.refreshToken} ${Uri.splitQueryString(world.idp.calls.last.body!)['code_verifier']}';
      for (final Uri url in world.browser.urls) {
        for (final String secret in secrets.split(' ')) {
          expect(url.toString(), isNot(contains(secret)));
        }
      }
      expect(tokens.toString(), isNot(contains(tokens.idToken)));
      expect(tokens.toString(), isNot(contains(tokens.refreshToken!)));
      world.browser.tamper = (Uri callback) => callback.replace(queryParameters: <String, String>{...callback.queryParameters, 'state': 'forged'});
      final OidcException failure = await _failure(client.signIn(kOidcConfig));
      expect(failure.toString(), 'OidcException(stateMismatch)');
    });
  });

  group('TK-MOB-002-5 redirect hijack: every check that ties the answer to the question', () {
    test('a redirect with another state is refused before any code is exchanged', () async {
      world.browser.tamper = (Uri callback) => callback.replace(queryParameters: <String, String>{...callback.queryParameters, 'state': 'attacker'});
      final int before = world.idp.calls.length;
      expect((await _failure(client.signIn(kOidcConfig))).failure, OidcFailure.stateMismatch);
      expect(world.idp.calls.skip(before).where((HttpCall call) => call.method == 'POST'), isEmpty);
    });

    test('a redirect without a state is refused', () async {
      world.browser.tamper = (Uri callback) => callback.replace(queryParameters: <String, String>{'code': callback.queryParameters['code']!});
      expect((await _failure(client.signIn(kOidcConfig))).failure, OidcFailure.stateMismatch);
    });

    test('a redirect to another scheme, host or path is refused', () async {
      for (final String other in <String>['evil.app:/oauth2redirect', 'vn.machvon.app:/other', 'vn.machvon.app://host/oauth2redirect']) {
        world.browser.tamper = (Uri callback) => Uri.parse('$other?code=${callback.queryParameters['code']}&state=${callback.queryParameters['state']}');
        expect((await _failure(client.signIn(kOidcConfig))).failure, OidcFailure.callbackInvalid, reason: other);
      }
    });

    test('a refusal by the provider ends the sign-in without repeating its text', () async {
      world.browser.tamper = (Uri callback) =>
          Uri.parse('vn.machvon.app:/oauth2redirect?error=access_denied&error_description=secret+text&state=${callback.queryParameters['state']}');
      final OidcException failure = await _failure(client.signIn(kOidcConfig));
      expect(failure.failure, OidcFailure.providerRefused);
      expect(failure.toString(), isNot(contains('secret')));
    });

    test('a redirect from another issuer (RFC 9207) or without a code is refused', () async {
      world.browser.tamper = (Uri callback) => callback.replace(queryParameters: <String, String>{...callback.queryParameters, 'iss': 'https://evil.test/realms/x'});
      expect((await _failure(client.signIn(kOidcConfig))).failure, OidcFailure.callbackInvalid);
      world.browser.tamper = (Uri callback) => callback.replace(queryParameters: <String, String>{'state': callback.queryParameters['state']!});
      expect((await _failure(client.signIn(kOidcConfig))).failure, OidcFailure.callbackInvalid);
    });

    test('the identity token must carry this request nonce, this issuer, this client and a future expiry', () async {
      world.idp.claimOverrides['nonce'] = 'replayed-from-another-login';
      expect((await _failure(client.signIn(kOidcConfig))).failure, OidcFailure.nonceMismatch);
      world.idp.claimOverrides
        ..clear()
        ..['iss'] = 'https://evil.test/realms/x';
      expect((await _failure(client.signIn(kOidcConfig))).failure, OidcFailure.tokenInvalid);
      world.idp.claimOverrides
        ..clear()
        ..['aud'] = 'another-client';
      expect((await _failure(client.signIn(kOidcConfig))).failure, OidcFailure.tokenInvalid);
      world.idp.claimOverrides
        ..clear()
        ..['exp'] = world.now.subtract(const Duration(hours: 1)).millisecondsSinceEpoch ~/ 1000;
      expect((await _failure(client.signIn(kOidcConfig))).failure, OidcFailure.tokenInvalid);
      world.idp.claimOverrides
        ..clear()
        ..['sub'] = '';
      expect((await _failure(client.signIn(kOidcConfig))).failure, OidcFailure.tokenInvalid);
    });

    test('an audience list that contains this client is accepted', () async {
      world.idp.claimOverrides['aud'] = <String>['account', kClientId];
      expect((await client.signIn(kOidcConfig)).subject, 'sub-ana');
    });

    test('a token request the provider refuses, and a server error, are told apart', () async {
      world.idp.tokenEndpointStatus = 400;
      expect((await _failure(client.signIn(kOidcConfig))).failure, OidcFailure.tokenExchangeFailed);
      world.idp.tokenEndpointStatus = 503;
      expect((await _failure(client.signIn(kOidcConfig))).failure, OidcFailure.unreachable);
    });

    test('the person closing the browser is a cancel, a broken browser a failure', () async {
      world.browser.failure = const OidcException(OidcFailure.browserCancelled);
      expect((await _failure(client.signIn(kOidcConfig))).failure, OidcFailure.browserCancelled);
    });
  });

  group('TK-MOB-002-1 the system browser adapter', () {
    final FlutterWebAuth2Platform original = FlutterWebAuth2Platform.instance;
    tearDown(() => FlutterWebAuth2Platform.instance = original);

    test('opens the authorization address and the callback scheme, and returns the address the browser came back with', () async {
      String? opened;
      String? scheme;
      FlutterWebAuth2Platform.instance = _ScriptedWebAuth((String url, String s) async {
        opened = url;
        scheme = s;
        return 'vn.machvon.app:/oauth2redirect?code=c&state=s';
      });
      final Uri callback = await const SystemAuthorizationBrowser().authorize(url: Uri.parse('https://idp.test/auth?x=1'), callbackScheme: 'vn.machvon.app');
      expect(opened, 'https://idp.test/auth?x=1');
      expect(scheme, 'vn.machvon.app');
      expect(callback.queryParameters['code'], 'c');
    });

    test('maps the cancel of the person, a platform failure and an unreadable address to a code', () async {
      Future<OidcFailure> failureOf(Future<String> Function(String, String) script) async {
        FlutterWebAuth2Platform.instance = _ScriptedWebAuth(script);
        return (await _failure(const SystemAuthorizationBrowser().authorize(url: Uri.parse('https://idp.test/auth'), callbackScheme: 'vn.machvon.app'))).failure;
      }

      expect(await failureOf((String _, String __) async => throw PlatformException(code: 'CANCELED')), OidcFailure.browserCancelled);
      expect(await failureOf((String _, String __) async => throw PlatformException(code: 'EUNKNOWN')), OidcFailure.browserFailed);
      expect(await failureOf((String _, String __) async => 'http://[bad'), OidcFailure.callbackInvalid);
    });
  });

  group('AC-ST-MOB-002-2 UAT-AC121 TK-MOB-002-3 the second factor request', () {
    test('asks the provider for aal2 and returns the stronger identity', () async {
      final OidcTokens tokens = await client.signIn(kOidcConfig, secondFactor: true);
      expect(world.browser.urls.single.queryParameters['acr_values'], 'aal2');
      expect(tokens.assurance, AssuranceLevel.aal2);
    });

    test('an answer that does not prove the second factor is refused', () async {
      world.browser.passSecondFactor = false;
      expect((await _failure(client.signIn(kOidcConfig, secondFactor: true))).failure, OidcFailure.secondFactorNotSatisfied);
    });

    test('an authentication method list that says mfa also counts', () async {
      world.idp.claimOverrides
        ..['acr'] = 'aal1'
        ..['amr'] = <String>['pwd', 'mfa'];
      expect((await client.signIn(kOidcConfig, secondFactor: true)).assurance, AssuranceLevel.aal2);
    });
  });

  group('AC-ST-MOB-002-3 UAT-NFR-SECURITY-03 TK-MOB-002-2 refresh with rotation', () {
    test('a refresh gives the next refresh token and the old one is dead', () async {
      final OidcTokens first = await client.signIn(kOidcConfig);
      final OidcTokens second = await client.refresh(kOidcConfig, first.refreshToken!);
      expect(second.refreshToken, isNot(first.refreshToken));
      expect((await _failure(client.refresh(kOidcConfig, first.refreshToken!))).failure, OidcFailure.refreshRejected);
    });

    test('a refresh token used twice makes the provider revoke the whole family, even the newest token', () async {
      final OidcTokens first = await client.signIn(kOidcConfig);
      final OidcTokens second = await client.refresh(kOidcConfig, first.refreshToken!);
      await _failure(client.refresh(kOidcConfig, first.refreshToken!));
      expect(world.idp.familyRevoked(second.refreshToken!), isTrue);
      expect((await _failure(client.refresh(kOidcConfig, second.refreshToken!))).failure, OidcFailure.refreshRejected);
    });

    test('an unreachable provider is not a refusal: the session stays, the step can be tried again', () async {
      final OidcTokens first = await client.signIn(kOidcConfig);
      world.idp.reachable = false;
      expect((await _failure(client.refresh(kOidcConfig, first.refreshToken!))).failure, OidcFailure.unreachable);
      world.idp.reachable = true;
      world.idp.tokenEndpointStatus = 502;
      expect((await _failure(client.refresh(kOidcConfig, first.refreshToken!))).failure, OidcFailure.unreachable);
      world.idp.tokenEndpointStatus = null;
      expect((await client.refresh(kOidcConfig, first.refreshToken!)).subject, 'sub-ana');
    });

    test('the sign-out revokes the refresh token at the provider and survives a provider that fails', () async {
      final OidcTokens tokens = await client.signIn(kOidcConfig);
      await client.revoke(kOidcConfig, tokens.refreshToken!);
      expect(world.idp.familyRevoked(tokens.refreshToken!), isTrue);
      world.idp.reachable = false;
      await client.revoke(kOidcConfig, 'whatever');
    });

    test('a provider without a revocation endpoint is told to end the session through its end-session endpoint', () async {
      final List<HttpCall> calls = <HttpCall>[];
      final OidcClient bare = OidcClient(
        transport: _Stub((HttpCall call) async {
          calls.add(call);
          if (call.url.path.endsWith('openid-configuration')) {
            return HttpResult(
              status: 200,
              headers: const <String, String>{},
              body: '{"issuer":"$kIssuer","authorization_endpoint":"$kIssuer/auth","token_endpoint":"$kIssuer/token","end_session_endpoint":"$kIssuer/logout"}',
            );
          }
          return const HttpResult(status: 204, headers: <String, String>{}, body: '');
        }),
        browser: world.browser,
      );
      await bare.revoke(kOidcConfig, 'refresh-1');
      final HttpCall logout = calls.last;
      expect(logout.url.path, endsWith('/logout'));
      expect(Uri.splitQueryString(logout.body!)['refresh_token'], 'refresh-1');
    });
  });

  group('TK-MOB-002-1 discovery and configuration', () {
    test('reads the discovery document once', () async {
      await client.signIn(kOidcConfig);
      await client.signIn(kOidcConfig);
      expect(world.idp.calls.where((HttpCall call) => call.url.path.endsWith('openid-configuration')), hasLength(1));
    });

    test('refuses a discovery document of another issuer, one with an address that is not https, or an unreachable one', () async {
      Future<OidcFailure> failureFor(String document) async {
        final OidcClient other = OidcClient(
          transport: _Stub((HttpCall call) async => HttpResult(status: 200, headers: const <String, String>{}, body: document)),
          browser: world.browser,
        );
        return (await _failure(other.discover(kOidcConfig))).failure;
      }

      expect(await failureFor('{"issuer":"https://evil.test","authorization_endpoint":"https://evil.test/a","token_endpoint":"https://evil.test/t"}'), OidcFailure.discoveryFailed);
      expect(await failureFor('{"issuer":"$kIssuer","authorization_endpoint":"http://idp.test/a","token_endpoint":"$kIssuer/t"}'), OidcFailure.discoveryFailed);
      expect(await failureFor('not json'), OidcFailure.discoveryFailed);
      world.idp.reachable = false;
      expect((await _failure(client.signIn(kOidcConfig))).failure, OidcFailure.unreachable);
    });

    test('accepts only an https issuer (a loopback one only when a debug build allows it) and a custom-scheme redirect', () {
      expect(() => OidcConfig.parse(issuer: 'http://idp.test', clientId: 'c'), throwsA(isA<OidcException>()));
      expect(() => OidcConfig.parse(issuer: 'http://localhost:8080/realms/x', clientId: 'c'), throwsA(isA<OidcException>()));
      expect(OidcConfig.parse(issuer: 'http://localhost:8080/realms/x', clientId: 'c', allowInsecureLoopback: true).issuer.host, 'localhost');
      expect(() => OidcConfig.parse(issuer: 'https://u:p@idp.test', clientId: 'c'), throwsA(isA<OidcException>()));
      expect(() => OidcConfig.parse(issuer: 'https://idp.test/?x=1', clientId: 'c'), throwsA(isA<OidcException>()));
      expect(() => OidcConfig.parse(issuer: 'not a url', clientId: 'c'), throwsA(isA<OidcException>()));
      expect(() => OidcConfig.parse(issuer: 'https://idp.test', clientId: ' '), throwsA(isA<OidcException>()));
      expect(() => OidcConfig.parse(issuer: 'https://idp.test', clientId: 'c', redirectUri: 'https://app.test/cb'), throwsA(isA<OidcException>()));
      final OidcConfig config = OidcConfig.parse(issuer: 'https://idp.test/realms/x/', clientId: ' c ');
      expect(config.issuer.toString(), 'https://idp.test/realms/x');
      expect(config.clientId, 'c');
      expect(OidcConfig.fromJson(config.toJson()), config);
      expect(config.hashCode, OidcConfig.fromJson(config.toJson()).hashCode);
    });

    test('reads the claims of a token and nothing of a malformed one', () {
      expect(jwtClaims(testJwt(<String, Object?>{'sub': 'x'}))!['sub'], 'x');
      expect(jwtClaims('a.b'), isNull);
      expect(jwtClaims('a.!!!.c'), isNull);
      expect(jwtClaims('a.${testJwt(<String, Object?>{})}.c'), isNull);
    });
  });
}

class _Stub implements HttpTransport {
  _Stub(this._answer);

  final Future<HttpResult> Function(HttpCall call) _answer;

  @override
  Future<HttpResult> send(HttpCall call) => _answer(call);
}
