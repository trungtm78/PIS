import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/features/session/auth/auth_service.dart';
import 'package:machvon_mobile/features/session/auth/identity_api.dart';
import 'package:machvon_mobile/features/session/auth/oidc_client.dart';
import 'package:machvon_mobile/features/session/auth/session_transport.dart';
import 'package:machvon_mobile/features/session/auth/session_vault.dart';

import '../../support/harness.dart';
import 'support/world.dart';

const FakeMembership _tenantAOther = FakeMembership('tenant-a', 'UBND Minh Hà', 'm-a2', 'INVESTOR_OFFICER');
const FakeMembership _leaderNeedsMfa = FakeMembership('tenant-a', 'UBND Minh Hà', 'm-a1', 'LEADER', requiresMfa: true);

/// A client whose transport tells the session what the API answered, as the application composes it.
MachvonApiClient _observed(World world, AuthService service) => MachvonApiClient(
      baseUrl: testConfig.apiBaseUrl,
      transport: SessionObservingTransport(world.transport, service.noteResponse, () => service.credentialStamp),
      token: service.accessToken,
    );

MachvonApiClient _client(World world, AuthService service) => MachvonApiClient(
      baseUrl: testConfig.apiBaseUrl,
      transport: world.transport,
      token: service.accessToken,
    );

Future<ApiError> _apiFailure(Future<Object?> call) async {
  try {
    await call;
  } on ApiError catch (error) {
    return error;
  }
  fail('the call was expected to fail');
}

Future<void> _profile(World world, AuthService service) async {
  final Object? json = await _client(world, service).execute('getMyProfile');
  expect(json, isA<Map<String, Object?>>());
}

Future<AuthService> _signedInOnce(World world) async {
  final AuthService service = world.service();
  await service.signIn(kOidcConfig);
  return service;
}

String _tokenOf(HttpCall call) => call.headers['authorization']!.substring(7);

void main() {
  late World world;

  tearDown(() => world.dispose());

  group('AC-ST-MOB-002-1 UI-MOB-02 TK-MOB-002-2 the session after the sign-in', () {
    test('signs in through the browser, enters the only membership and keeps the refresh token in the secure store', () async {
      world = World();
      final AuthService service = world.service();
      final List<SessionSnapshot> seen = recordChanges(service);

      expect(await service.signIn(kOidcConfig), SignInOutcome.signedIn);
      await pumpEventQueue();

      expect(service.snapshot.status, SessionStatus.signedIn);
      expect(service.snapshot.tenantId, 'tenant-a');
      expect(service.snapshot.membershipId, 'm-a1');
      expect(service.snapshot.userId, 'sub-ana');
      expect(seen.last, service.snapshot);
      final StoredSession stored = (await world.vault.loadSession())!;
      expect(stored.refreshToken, world.idp.latestRefreshOf(stored.refreshToken));
      expect(stored.tenantId, 'tenant-a');
      expect(stored.config, kOidcConfig);
      await _profile(world, service);
    });

    test('the secure store holds no access token, no identity token and no verifier: only the refresh token and the context', () async {
      world = World();
      final AuthService service = world.service();
      await service.signIn(kOidcConfig);
      final String everything = world.store.data.values.join('\n');
      expect(everything, contains('refresh-'));
      expect(everything, isNot(contains('tenant-token-')));
      expect(everything, isNot(contains('.signature')));
      expect(everything, isNot(contains('code_verifier')));
      expect(everything.toLowerCase(), isNot(contains('password')));
    });

    test('a failed sign-in leaves the session signed out and the store empty', () async {
      world = World();
      world.browser.tamper = (Uri callback) => callback.replace(queryParameters: <String, String>{...callback.queryParameters, 'state': 'attacker'});
      final AuthService service = world.service();
      await expectLater(service.signIn(kOidcConfig), throwsA(isA<OidcException>()));
      expect(service.snapshot.status, SessionStatus.signedOut);
      expect(world.store.data, isEmpty);
    });

    test('does not log or print any token while signing in, renewing and signing out', () async {
      world = World();
      final List<String> lines = <String>[];
      final Future<void> Function() run = () async {
        final AuthService service = world.service();
        await service.signIn(kOidcConfig);
        world.advance(const Duration(minutes: 4, seconds: 40));
        await service.accessToken();
        await service.signOut();
      };
      await runPrinted(lines, run);
      final String printed = lines.join('\n');
      expect(printed, isNot(contains('refresh-')));
      expect(printed, isNot(contains('tenant-token-')));
      expect(printed, isNot(contains('.signature')));
    });
  });

  group('AC-ST-MOB-002-4 UI-MOB-04 TK-MOB-002-4 the unit and role', () {
    test('lists both memberships, and the selected context is what the server binds the next calls to', () async {
      world = World(memberships: <String, List<FakeMembership>>{'sub-ana': <FakeMembership>[tenantAMember, _tenantAOther]});
      final AuthService service = world.service();

      expect(await service.signIn(kOidcConfig), SignInOutcome.needsSelection);
      expect(service.snapshot.status, SessionStatus.signedOut);
      final List<MembershipChoice> choices = await service.candidates();
      expect(choices.map((MembershipChoice c) => '${c.tenantName}/${c.membershipType}'), <String>['UBND Minh Hà/LEADER', 'UBND Minh Hà/INVESTOR_OFFICER']);

      expect(await service.selectContext(choices.last), SignInOutcome.signedIn);
      final HttpCall selection = world.api.calls.lastWhere((HttpCall call) => call.url.path.endsWith('/tenant-selection'));
      expect(jsonDecode(selection.body!), <String, Object?>{'tenant_id': 'tenant-a', 'membership_id': 'm-a2'});
      expect(service.snapshot.membershipId, 'm-a2');
      await _profile(world, service);
      expect(world.api.tenantTokens[_tokenOf(world.api.calls.last)]!.membershipId, 'm-a2');
    });

    test('every selection is a new command: the key is never reused, because a replay carries no token', () async {
      world = World(memberships: <String, List<FakeMembership>>{'sub-ana': <FakeMembership>[tenantAMember, _tenantAOther]});
      final AuthService service = world.service();
      await service.signIn(kOidcConfig);
      final List<MembershipChoice> choices = await service.candidates();
      await service.selectContext(choices.first);
      await service.selectContext(choices.last);
      final List<String> keys = <String>[
        for (final HttpCall call in world.api.calls)
          if (call.url.path.endsWith('/tenant-selection') && call.method == 'POST') call.headers['idempotency-key']!,
      ];
      expect(keys.toSet(), hasLength(keys.length));
    });

    test('the membership used last time is entered again without asking, when it is still allowed', () async {
      world = World(memberships: <String, List<FakeMembership>>{'sub-ana': <FakeMembership>[tenantAMember, _tenantAOther]});
      final AuthService first = world.service();
      await first.signIn(kOidcConfig);
      await first.selectContext((await first.candidates()).last);
      final AuthService second = world.service();
      expect(await second.signIn(kOidcConfig), SignInOutcome.signedIn);
      expect(second.snapshot.membershipId, 'm-a2');
    });

    test('a membership the server will not let in is never chosen for the person', () async {
      world = World(memberships: <String, List<FakeMembership>>{
        'sub-ana': <FakeMembership>[const FakeMembership('tenant-a', 'UBND Minh Hà', 'm-a1', 'LEADER', status: 'Suspended'), _tenantAOther],
      });
      final AuthService service = world.service();
      expect(await service.signIn(kOidcConfig), SignInOutcome.signedIn);
      expect(service.snapshot.membershipId, 'm-a2');
    });
  });

  group('AC-ST-MOB-002-2 UAT-AC121 TK-MOB-002-3 the server asks for the second factor', () {
    test('a membership that needs it waits for MOB-03, and after the second factor the same membership is entered', () async {
      world = World(memberships: <String, List<FakeMembership>>{'sub-ana': <FakeMembership>[_leaderNeedsMfa]});
      final AuthService service = world.service();

      expect(await service.signIn(kOidcConfig), SignInOutcome.needsSecondFactor);
      expect(service.needsSecondFactor, isTrue);
      expect(service.snapshot.status, SessionStatus.signedOut);
      expect(world.store.data.containsKey('session.v1'), isFalse);

      expect(await service.stepUp(), SignInOutcome.signedIn);
      expect(world.browser.urls.last.queryParameters['acr_values'], 'aal2');
      expect(service.needsSecondFactor, isFalse);
      expect(service.snapshot.status, SessionStatus.signedIn);
      expect(service.snapshot.assurance, AssuranceLevel.aal2);
      expect(service.snapshot.membershipId, 'm-a1');
    });

    test('a money approver without the second factor: the approval answers 403 MFA_REQUIRED, MOB-03 is asked for, then the action is allowed', () async {
      world = World();
      world.api.profileNeedsSecondFactor = true;
      final AuthService service = world.service();
      await service.signIn(kOidcConfig);
      final MachvonApiClient client = MachvonApiClient(
        baseUrl: testConfig.apiBaseUrl,
        transport: _Relay(world.transport, service.noteResponse),
        token: service.accessToken,
      );

      final ApiError refused = await _apiFailure(client.execute('getMyProfile'));
      expect(refused.status, 403);
      expect(refused.code, 'MFA_REQUIRED');
      expect(service.snapshot.stepUpRequired, isTrue);
      expect(service.needsSecondFactor, isTrue);
      expect(service.snapshot.status, SessionStatus.signedIn);

      expect(await service.stepUp(), SignInOutcome.signedIn);
      expect(service.snapshot.stepUpRequired, isFalse);
      expect(service.snapshot.assurance, AssuranceLevel.aal2);
      expect(await client.execute('getMyProfile'), isA<Map<String, Object?>>());
    });

    test('the second factor must come from the same account, and a provider that does not prove it changes nothing', () async {
      world = World(memberships: <String, List<FakeMembership>>{'sub-ana': <FakeMembership>[_leaderNeedsMfa], 'sub-ben': <FakeMembership>[_leaderNeedsMfa]});
      final AuthService service = world.service();
      await service.signIn(kOidcConfig);

      world.browser.subject = 'sub-ben';
      await expectLater(service.stepUp(), throwsA(isA<OidcException>().having((OidcException e) => e.failure, 'failure', OidcFailure.tokenInvalid)));
      expect(service.snapshot.status, SessionStatus.signedOut);

      world.browser.subject = 'sub-ana';
      world.browser.passSecondFactor = false;
      await expectLater(service.stepUp(), throwsA(isA<OidcException>().having((OidcException e) => e.failure, 'failure', OidcFailure.secondFactorNotSatisfied)));
      expect(service.needsSecondFactor, isTrue);
    });

    test('leaving MOB-03 drops the selection that waited', () async {
      world = World(memberships: <String, List<FakeMembership>>{'sub-ana': <FakeMembership>[_leaderNeedsMfa]});
      final AuthService service = world.service();
      await service.signIn(kOidcConfig);
      service.cancelSecondFactor();
      expect(service.needsSecondFactor, isFalse);
      expect(service.snapshot.status, SessionStatus.signedOut);
    });

    test('a step-up without any session has nothing to select', () async {
      world = World();
      await expectLater(world.service().stepUp(), throwsA(isA<NoSession>()));
    });

    test('the demand is ignored when nobody is signed in', () async {
      world = World();
      final AuthService service = world.service();
      service.requireSecondFactor();
      expect(service.snapshot.stepUpRequired, isFalse);
    });
  });

  group('AC-ST-MOB-002-3 UAT-NFR-SECURITY-03 TK-MOB-002-2 renewal, rotation and the end of the session', () {
    test('the tenant token is reused while it is good and renewed before it lapses, with the next refresh token stored first', () async {
      world = World();
      final AuthService service = world.service();
      await service.signIn(kOidcConfig);
      final String first = (await service.accessToken())!;
      world.advance(const Duration(minutes: 2));
      expect(await service.accessToken(), first);
      final int selections = world.api.calls.where((HttpCall c) => c.method == 'POST').length;

      world.advance(const Duration(minutes: 2, seconds: 40));
      final String renewed = (await service.accessToken())!;
      expect(renewed, isNot(first));
      expect(world.api.calls.where((HttpCall c) => c.method == 'POST'), hasLength(selections + 1));
      final StoredSession stored = (await world.vault.loadSession())!;
      expect(stored.refreshToken, world.idp.latestRefreshOf(stored.refreshToken));
      await _profile(world, service);
    });

    test('two requests that find the token lapsed share one renewal: the refresh token is used once', () async {
      world = World();
      final AuthService service = world.service();
      await service.signIn(kOidcConfig);
      world.advance(const Duration(minutes: 5));
      final List<String?> tokens = await Future.wait(<Future<String?>>[service.accessToken(), service.accessToken(), service.accessToken()]);
      expect(tokens.toSet(), hasLength(1));
      expect(world.idp.calls.where((HttpCall c) => Uri.splitQueryString(c.body ?? '')['grant_type'] == 'refresh_token'), hasLength(1));
      expect(world.idp.familyRevoked((await world.vault.loadSession())!.refreshToken), isFalse);
    });

    test('the list of memberships and a request that both find the identity token lapsed share one refresh of the refresh token', () async {
      world = World();
      final AuthService service = await _signedInOnce(world);
      final AuthService restarted = world.service();
      await restarted.ready;
      final List<Object?> results = await Future.wait(<Future<Object?>>[restarted.candidates(), restarted.accessToken()]);
      expect(results.last, isNotNull);
      expect(world.idp.calls.where((HttpCall c) => Uri.splitQueryString(c.body ?? '')['grant_type'] == 'refresh_token'), hasLength(1));
      expect(restarted.snapshot.status, SessionStatus.signedIn, reason: 'a second use of the same refresh token would have ended the session');
      expect(service.snapshot.status, SessionStatus.signedIn);
    });

    test('an identity token that lives shorter than the access token is renewed when it lapses, not when expires_in says (no 401, no ended session)', () async {
      world = World();
      world.idp.tokenLifetime = 120;
      world.idp.expiresInOverride = 3600;
      final AuthService service = world.service();
      await service.signIn(kOidcConfig);
      int refreshes() => world.idp.calls.where((HttpCall c) => Uri.splitQueryString(c.body ?? '')['grant_type'] == 'refresh_token').length;

      world.advance(const Duration(seconds: 100));
      final List<MembershipChoice> choices = await service.candidates();

      expect(choices, isNotEmpty);
      expect(refreshes(), 1, reason: 'the identity token was 20 seconds from its exp: it is renewed, not sent');
      expect(service.snapshot.status, SessionStatus.signedIn);
      expect(world.api.calls.where((HttpCall c) => c.url.path.endsWith('/candidates')).every((HttpCall c) => c.headers['authorization'] != null), isTrue);
    });

    test('the application restarted: the session comes back from the vault and renews itself', () async {
      world = World();
      await world.service().signIn(kOidcConfig);
      final AuthService restarted = world.service();
      await restarted.ready;
      expect(restarted.snapshot.status, SessionStatus.signedIn);
      expect(restarted.snapshot.tenantId, 'tenant-a');
      expect(await restarted.accessToken(), isNotNull);
      await _profile(world, restarted);
    });

    test('a replayed refresh token: the old copy is refused, the token family is revoked, and the legitimate session ends at its next renewal', () async {
      world = World();
      final AuthService legitimate = world.service();
      await legitimate.signIn(kOidcConfig);
      final MemorySecureStore oldCopy = MemorySecureStore()..data.addAll(world.store.data);
      final String replayed = (jsonDecode(oldCopy.data['session.v1']!) as Map<String, Object?>)['refresh_token']! as String;

      world.advance(const Duration(minutes: 5));
      await legitimate.accessToken();

      // An old copy of the vault (a restored backup, a cloned device) replays the refresh token that was already used.
      final AuthService clone = world.serviceOn(oldCopy);
      expect((await _apiFailure(clone.accessToken())).code, 'SESSION_EXPIRED');
      expect(clone.snapshot.status, SessionStatus.expired);

      expect(world.idp.familyRevoked(replayed), isTrue);
      expect(oldCopy.data.containsKey('session.v1'), isFalse);
      world.advance(const Duration(minutes: 5));
      expect((await _apiFailure(legitimate.accessToken())).status, 401);
      expect(legitimate.snapshot.status, SessionStatus.expired);
    });

    test('MOB-44: the session ends with 401 SESSION_EXPIRED, the tokens go, the drafts and the context stay', () async {
      world = World(pendingCommands: 3);
      final AuthService service = world.service();
      await service.signIn(kOidcConfig);
      final MachvonApiClient client = MachvonApiClient(
        baseUrl: testConfig.apiBaseUrl,
        transport: _Relay(world.transport, service.noteResponse),
        token: service.accessToken,
      );
      world.api.endAllSessions();

      final ApiError error = await _apiFailure(client.execute('getMyProfile'));
      expect(error.status, 401);
      expect(error.code, 'SESSION_EXPIRED');
      await pumpEventQueue();

      expect(service.snapshot.status, SessionStatus.expired);
      expect(service.snapshot.tenantId, 'tenant-a');
      expect(await service.accessToken(), isNull);
      expect(world.store.data.containsKey('session.v1'), isFalse);
      expect(world.purger.purged, isEmpty);
      expect(world.purger.purgedAll, 0);
      expect((await world.vault.loadLast())!.tenantId, 'tenant-a');
    });

    test('a 401 on a token that is old is a lapsed token: it is renewed once, and the session lives', () async {
      world = World();
      final AuthService service = world.service();
      await service.signIn(kOidcConfig);
      world.advance(const Duration(minutes: 3));
      service.noteResponse(401, 'SESSION_EXPIRED');
      await pumpEventQueue();
      expect(service.snapshot.status, SessionStatus.signedIn);
      await _profile(world, service);
    });

    test('a renewal the server answers with 401 (the absolute lifetime) ends the session', () async {
      world = World();
      final AuthService service = world.service();
      await service.signIn(kOidcConfig);
      world.advance(const Duration(minutes: 6));
      world.api.selectFailureStatus = 401;
      expect((await _apiFailure(service.accessToken())).status, 401);
      expect(service.snapshot.status, SessionStatus.expired);
    });

    test('a membership that is no longer valid ends the session at the next renewal; a second factor wanted asks for it instead', () async {
      world = World();
      final AuthService service = world.service();
      await service.signIn(kOidcConfig);
      world.advance(const Duration(minutes: 6));
      world.api.selectFailureStatus = 403;
      world.api.selectFailureCode = 'MFA_REQUIRED';
      expect((await _apiFailure(service.accessToken())).code, 'MFA_REQUIRED');
      expect(service.snapshot.status, SessionStatus.signedIn);
      expect(service.snapshot.stepUpRequired, isTrue);
      world.api.selectFailureCode = 'MEMBERSHIP_INACTIVE';
      expect((await _apiFailure(service.accessToken())).code, 'MEMBERSHIP_INACTIVE');
      expect(service.snapshot.status, SessionStatus.expired);
    });

    group('AC-ST-MOB-041-3 UAT-AC501 SEC-01 a revoked membership is purged before the session is shown as ended', () {
      for (final String code in <String>['MEMBERSHIP_INACTIVE', 'TENANT_SELECTION_INVALID', 'SCOPE_DENIED']) {
        test('the renewal answered 403 $code purges the tenant and the user, forgets the context, and only then expires', () async {
          world = World();
          final AuthService service = world.service();
          await service.signIn(kOidcConfig);
          final List<SessionStatus> seen = <SessionStatus>[];
          final List<int> purgedWhenPublished = <int>[];
          service.changes.listen((SessionSnapshot s) {
            seen.add(s.status);
            purgedWhenPublished.add(world.purger.purged.length);
          });
          world.advance(const Duration(minutes: 6));
          world.api.selectFailureStatus = 403;
          world.api.selectFailureCode = code;

          expect((await _apiFailure(service.accessToken())).code, code);

          expect(world.purger.purged, <({String tenantId, String userId})>[(tenantId: 'tenant-a', userId: 'sub-ana')]);
          expect(seen.last, SessionStatus.expired);
          expect(purgedWhenPublished.last, 1, reason: 'the data was already gone when the session was announced as ended');
          expect(service.snapshot.tenantId, isNull, reason: 'no scope is left that could keep the deleted store open');
          expect(service.snapshot.userId, isNull);
          expect(world.store.data.containsKey('session.v1'), isFalse);
          expect(await world.vault.pendingPurges(), isEmpty, reason: 'the journal entry ended with the purge');
          expect(await service.accessToken(), isNull);
        });
      }

      test('a 401 on the renewal only expires: the drafts stay locked on the device and nothing is purged', () async {
        world = World();
        final AuthService service = world.service();
        await service.signIn(kOidcConfig);
        world.advance(const Duration(minutes: 6));
        world.api.selectFailureStatus = 401;
        await _apiFailure(service.accessToken());
        expect(service.snapshot.status, SessionStatus.expired);
        expect(service.snapshot.tenantId, 'tenant-a');
        expect(world.purger.purged, isEmpty);
      });

      test('a purge that fails still ends the session, and the journal finishes it at the next start', () async {
        world = World();
        final AuthService service = world.service();
        await service.signIn(kOidcConfig);
        world.advance(const Duration(minutes: 6));
        world.api.selectFailureStatus = 403;
        world.api.selectFailureCode = 'MEMBERSHIP_INACTIVE';
        world.purger.failure = StateError('disk full');
        await expectLater(service.accessToken(), throwsA(isA<StateError>()));
        expect(service.snapshot.status, SessionStatus.expired);
        expect(await world.vault.pendingPurges(), <String>['tenant-a/sub-ana']);

        world.purger.failure = null;
        final AuthService restarted = world.service();
        await restarted.ready;
        expect(world.purger.purged, <({String tenantId, String userId})>[(tenantId: 'tenant-a', userId: 'sub-ana')]);
        expect(await world.vault.pendingPurges(), isEmpty);
      });

      test('a second factor wanted on the renewal is not a revocation: nothing is purged', () async {
        world = World();
        final AuthService service = world.service();
        await service.signIn(kOidcConfig);
        world.advance(const Duration(minutes: 6));
        world.api.selectFailureStatus = 403;
        world.api.selectFailureCode = 'MFA_REQUIRED';
        await _apiFailure(service.accessToken());
        expect(world.purger.purged, isEmpty);
        expect(service.snapshot.status, SessionStatus.signedIn);
      });
    });

    test('with no connection the session stays: the request fails like one that did not get through, and works when the connection is back', () async {
      world = World();
      final AuthService service = world.service();
      await service.signIn(kOidcConfig);
      world.advance(const Duration(minutes: 6));
      world.idp.reachable = false;
      final ApiError error = await _apiFailure(service.accessToken());
      expect(error.code, networkErrorCode);
      expect(service.snapshot.status, SessionStatus.signedIn);
      expect(world.store.data.containsKey('session.v1'), isTrue);
      world.idp.reachable = true;
      expect(await service.accessToken(), isNotNull);
    });

    test('an identity token of another account after a refresh ends the session', () async {
      world = World();
      final AuthService service = world.service();
      await service.signIn(kOidcConfig);
      world.advance(const Duration(minutes: 6));
      world.idp.claimOverrides['sub'] = 'sub-mallory';
      await _apiFailure(service.accessToken());
      expect(service.snapshot.status, SessionStatus.expired);
    });

    test('licence expired on the server: the session reads and no longer offers changes; the device clock decides nothing', () async {
      world = World();
      final AuthService service = world.service();
      await service.signIn(kOidcConfig);
      world.advance(const Duration(days: 4000));
      service.noteResponse(200, null);
      expect(service.snapshot.isReadOnly, isFalse);
      service.noteResponse(422, 'LICENSE_EXPIRED');
      expect(service.snapshot.isReadOnly, isTrue);
      expect(service.snapshot.status, SessionStatus.signedIn);
    });

    test('a suspended tenant opens the session read-only', () async {
      world = World(memberships: <String, List<FakeMembership>>{
        'sub-ana': <FakeMembership>[const FakeMembership('tenant-a', 'UBND Minh Hà', 'm-a1', 'LEADER', mode: 'READ_ONLY')],
      });
      final AuthService service = world.service();
      await service.signIn(kOidcConfig);
      expect(service.snapshot.mode, SessionMode.readOnly);
    });
  });

  group('AC-ST-MOB-008-4 UAT-PLAN-33 the biometric unlock only unlocks the stored credential', () {
    test('a locked session gives no token until the person passes the prompt; the prompt result goes nowhere', () async {
      world = World();
      await world.service().signIn(kOidcConfig);
      await world.vault.setBiometricUnlock(enabled: true);

      final AuthService service = world.service();
      await service.ready;
      expect(service.snapshot.locked, isTrue);
      expect(await service.accessToken(), isNull);

      world.biometrics.answer = false;
      expect(await service.unlock(reason: 'Unlock'), isFalse);
      expect(service.snapshot.locked, isTrue);
      expect(await service.accessToken(), isNull);

      world.biometrics.answer = true;
      final int calls = world.api.calls.length + world.idp.calls.length;
      expect(await service.unlock(reason: 'Unlock'), isTrue);
      expect(world.api.calls.length + world.idp.calls.length, calls, reason: 'the unlock itself sends nothing');
      expect(service.snapshot.locked, isFalse);
      await _profile(world, service);
      expect(world.biometrics.prompts, <String>['Unlock', 'Unlock']);
      for (final HttpCall call in <HttpCall>[...world.api.calls, ...world.idp.calls]) {
        expect('${call.url} ${call.headers} ${call.body}'.toLowerCase(), isNot(contains('biometric')));
      }
    });

    test('a biometric unlock does not satisfy a demand for the second factor', () async {
      world = World();
      world.api.profileNeedsSecondFactor = true;
      final AuthService service = world.service();
      await service.signIn(kOidcConfig);
      service.requireSecondFactor();
      service.lock();
      expect(service.snapshot.locked, isTrue);
      expect(await service.unlock(reason: 'Unlock'), isTrue);
      expect(service.snapshot.stepUpRequired, isTrue);
      expect(service.needsSecondFactor, isTrue);
      expect((await _apiFailure(_client(world, service).execute('getMyProfile'))).code, 'MFA_REQUIRED');
    });

    test('locking drops the tokens from memory and keeps the refresh token in the vault', () async {
      world = World();
      final AuthService service = world.service();
      await service.signIn(kOidcConfig);
      service.lock();
      expect(service.snapshot.locked, isTrue);
      expect(await service.accessToken(), isNull);
      expect(world.store.data.containsKey('session.v1'), isTrue);
      expect(await service.unlock(reason: 'Unlock'), isTrue);
      expect(await service.accessToken(), isNotNull);
    });

    test('unlocking when the vault no longer holds the session ends it; unlocking when not locked is a no-op', () async {
      world = World();
      final AuthService service = world.service();
      await service.signIn(kOidcConfig);
      expect(await service.unlock(reason: 'Unlock'), isTrue);
      expect(world.biometrics.prompts, isEmpty);
      service.lock();
      await world.vault.clearSession();
      expect(await service.unlock(reason: 'Unlock'), isFalse);
      expect(service.snapshot.status, SessionStatus.expired);
    });
  });

  group('AC-ST-MOB-008-2 MOB02 a renewal that answers after the person moved on does not touch the new context', () {
    Future<(AuthService, MembershipChoice)> twoTenantsOnA() async {
      world = World(memberships: <String, List<FakeMembership>>{'sub-ana': <FakeMembership>[tenantAMember, tenantBMember]});
      final AuthService service = world.service();
      await service.signIn(kOidcConfig);
      final List<MembershipChoice> choices = await service.candidates();
      await service.selectContext(choices.firstWhere((MembershipChoice c) => c.tenantId == 'tenant-a'));
      return (service, choices.firstWhere((MembershipChoice c) => c.tenantId == 'tenant-b'));
    }

    test('the late token of tenant A never replaces the token of tenant B', () async {
      final (AuthService service, MembershipChoice b) = await twoTenantsOnA();
      world.advance(const Duration(minutes: 6));
      final Completer<void> hold = world.api.selectHoldOnce = Completer<void>();
      final Future<String?> renewal = service.accessToken();
      await pumpEventQueue();

      await service.switchTenant(b);
      expect(service.snapshot.tenantId, 'tenant-b');
      hold.complete();
      final String? answered = await renewal;

      expect(world.api.tenantTokens[answered]?.tenantId, 'tenant-b', reason: 'the caller gets a token of the context that is active now');
      final String? later = await service.accessTokenFor('tenant-b');
      expect(world.api.tenantTokens[later]?.tenantId, 'tenant-b', reason: 'every later request carries the token of tenant B');
      expect(service.snapshot.membershipId, 'm-b1');
    });

    test('the late refusal of tenant A does not purge or end the session of tenant B', () async {
      final (AuthService service, MembershipChoice b) = await twoTenantsOnA();
      world.advance(const Duration(minutes: 6));
      final Completer<void> hold = world.api.selectHoldOnce = Completer<void>();
      final Future<String?> renewal = service.accessToken();
      await pumpEventQueue();

      await service.switchTenant(b);
      final int purgedBefore = world.purger.purged.length;
      world.api.selectFailureStatus = 403;
      world.api.selectFailureCode = 'MEMBERSHIP_INACTIVE';
      hold.complete();
      final String? answered = await renewal;

      expect(world.api.tenantTokens[answered]?.tenantId, 'tenant-b');
      expect(service.snapshot.status, SessionStatus.signedIn);
      expect(service.snapshot.tenantId, 'tenant-b');
      expect(world.purger.purged.length, purgedBefore, reason: 'tenant B was not purged because tenant A lost a membership');
      expect(world.store.data.containsKey('session.v1'), isTrue);
    });

    test('a renewal that answers after the person signed out gives no token and leaves nothing in memory', () async {
      final (AuthService service, MembershipChoice _) = await twoTenantsOnA();
      world.advance(const Duration(minutes: 6));
      final Completer<void> hold = world.api.selectHoldOnce = Completer<void>();
      final Future<String?> renewal = service.accessToken();
      await pumpEventQueue();

      await service.signOut();
      hold.complete();

      expect(await renewal, isNull);
      expect(service.snapshot.status, SessionStatus.signedOut);
      expect(await service.accessToken(), isNull);
    });

    test('a request queued for tenant A that is renewed across the switch is refused, not sent with the token of tenant B', () async {
      final (AuthService service, MembershipChoice b) = await twoTenantsOnA();
      world.advance(const Duration(minutes: 6));
      final Completer<void> hold = world.api.selectHoldOnce = Completer<void>();
      final Future<String?> renewal = service.accessTokenFor('tenant-a');
      final Future<void> refused = expectLater(renewal, throwsA(isA<TenantMismatch>()));
      await pumpEventQueue();

      await service.switchTenant(b);
      hold.complete();
      await refused;
    });
  });

  group('AC-ST-MOB-041-3 UAT-AC501 SEC-01 the wipe of every tenant survives a failure or a killed process', () {
    test('a wipe that fails after the session was cleared is finished at the next start, and the journal then ends', () async {
      world = World();
      final AuthService service = world.service();
      await service.signIn(kOidcConfig);
      world.store.data['tenant.tenant-a.key'] = 'secret';
      world.purger.failure = StateError('disk full');

      await expectLater(service.signOut(discardPending: true, scope: SignOutScope.allTenants), throwsStateError);
      expect(world.store.data.containsKey('session.v1'), isFalse);
      expect(await world.vault.pendingPurges(), isNotEmpty, reason: 'the wipe was journaled before the credentials went');
      expect(world.store.data['tenant.tenant-a.key'], 'secret', reason: 'nothing was deleted yet');

      world.purger.failure = null;
      final AuthService restarted = world.service();
      await restarted.ready;
      expect(world.purger.purgedAll, 1, reason: 'the next start finished the wipe of the revoked device');
      expect(world.store.data.containsKey('tenant.tenant-a.key'), isFalse);
      expect(await world.vault.pendingPurges(), isEmpty);
      expect(restarted.snapshot.status, SessionStatus.signedOut);
    });

    test('a wipe that went through leaves no journal entry, and a next start wipes nothing again', () async {
      world = World();
      final AuthService service = world.service();
      await service.signIn(kOidcConfig);
      await service.signOut(discardPending: true, scope: SignOutScope.allTenants);
      expect(world.purger.purgedAll, 1);
      expect(await world.vault.pendingPurges(), isEmpty);

      await world.service().ready;
      expect(world.purger.purgedAll, 1);
    });
  });

  group('AC-ST-MOB-008-2 MOB02 a request is made for one tenant only', () {
    test('the token of the active tenant is given, the token for another tenant is refused', () async {
      world = World();
      final AuthService service = world.service();
      await service.signIn(kOidcConfig);
      expect(await service.accessTokenFor('tenant-a'), isNotNull);
      await expectLater(service.accessTokenFor('tenant-b'), throwsA(isA<TenantMismatch>()));
    });
  });

  group('REVIEW-m1-7 discarding the pending commands is explicit, whatever happens to the rest of the local data', () {
    Future<(AuthService, MembershipChoice)> keepingData({int pending = 3, FakeMembership b = tenantBMember}) async {
      world = World(memberships: <String, List<FakeMembership>>{'sub-ana': <FakeMembership>[tenantAMember, b]}, pendingCommands: pending);
      final AuthService service = world.service();
      await service.setLocalDataPolicy(LocalDataPolicy.keepEncrypted);
      await service.signIn(kOidcConfig);
      final List<MembershipChoice> choices = await service.candidates();
      await service.selectContext(choices.firstWhere((MembershipChoice c) => c.tenantId == 'tenant-a'));
      return (service, choices.firstWhere((MembershipChoice c) => c.tenantId == 'tenant-b'));
    }

    test('a switch with the data kept drops the pending commands of the tenant left, once the server has let the person into the new tenant', () async {
      final (AuthService service, MembershipChoice b) = await keepingData();
      final List<String?> activeWhenDropped = <String?>[];
      world.onDiscard = () async => activeWhenDropped.add(service.snapshot.tenantId);

      await service.switchTenant(b, discardPending: true);

      expect(world.discardedPending, 1);
      expect(world.purger.purged, isEmpty, reason: 'the policy keeps the data of the tenant left');
      expect(service.snapshot.tenantId, 'tenant-b');
      expect(activeWhenDropped, <String?>['tenant-a'], reason: 'the queue that is dropped is the one of the tenant left: it is still the active one');
    });

    test('a switch that is refused for the pending commands, or that fails, drops nothing', () async {
      final (AuthService service, MembershipChoice b) = await keepingData();
      await expectLater(service.switchTenant(b), throwsA(isA<PendingCommandsBlock>()));
      expect(world.discardedPending, 0);

      world.api.selectFailureStatus = 500;
      world.api.selectFailureCode = 'INTERNAL_ERROR';
      await expectLater(service.switchTenant(b, discardPending: true), throwsA(isA<ApiError>()));
      expect(world.discardedPending, 0, reason: 'the person has not left the tenant, so their work is still theirs');
      expect(service.snapshot.tenantId, 'tenant-a');
    });

    test('a switch that waits for the second factor drops the commands only when the second factor is passed', () async {
      final (AuthService service, MembershipChoice b) =
          await keepingData(b: const FakeMembership('tenant-b', 'Bộ Thử Nghiệm', 'm-b1', 'SPECIALIST', requiresMfa: true));
      expect(await service.switchTenant(b, discardPending: true), SignInOutcome.needsSecondFactor);
      expect(world.discardedPending, 0);

      expect(await service.stepUp(), SignInOutcome.signedIn);
      expect(world.discardedPending, 1);
      expect(service.snapshot.tenantId, 'tenant-b');
    });

    test('the second factor left without passing drops nothing', () async {
      final (AuthService service, MembershipChoice b) =
          await keepingData(b: const FakeMembership('tenant-b', 'Bộ Thử Nghiệm', 'm-b1', 'SPECIALIST', requiresMfa: true));
      await service.switchTenant(b, discardPending: true);
      service.cancelSecondFactor();
      expect(world.discardedPending, 0);
    });

    test('the same tenant selected again is not a departure: nothing is dropped', () async {
      final (AuthService service, MembershipChoice _) = await keepingData(pending: 0);
      final MembershipChoice same = (await service.candidates()).firstWhere((MembershipChoice c) => c.tenantId == 'tenant-a');
      await service.switchTenant(same, discardPending: true);
      expect(world.discardedPending, 0);
    });

    test('signing out with the data kept and the pending commands discarded drops them; without that choice they are refused and kept', () async {
      final (AuthService service, MembershipChoice _) = await keepingData();
      await expectLater(service.signOut(), throwsA(isA<PendingCommandsBlock>()));
      expect(world.discardedPending, 0);

      await service.signOut(discardPending: true);

      expect(world.discardedPending, 1);
      expect(service.snapshot.status, SessionStatus.signedOut);
      expect(world.purger.purged, isEmpty);
    });
  });

  group('REVIEW-m1-7 an identity refresh that was on its way when the person left belongs to the session that started it', () {
    // The identity token of the session is lapsed, a screen asks for the memberships and the refresh is in flight.
    Future<(AuthService, Future<void>)> refreshInFlight({Completer<void>? requestHold, Completer<void>? responseHold}) async {
      world = World(memberships: <String, List<FakeMembership>>{
        'sub-ana': <FakeMembership>[tenantAMember],
        'sub-bo': <FakeMembership>[tenantBMember],
      });
      final AuthService service = world.service();
      await service.signIn(kOidcConfig);
      world.advance(const Duration(minutes: 5));
      world.idp.refreshHoldOnce = requestHold;
      world.idp.refreshResponseHoldOnce = responseHold;
      final Future<void> late = service.candidates().then<void>((List<MembershipChoice> _) {}, onError: (Object _) {});
      await pumpEventQueue();
      return (service, late);
    }

    test('the refusal of the old session does not end the session that signed in after it', () async {
      final Completer<void> hold = Completer<void>();
      final (AuthService service, Future<void> late) = await refreshInFlight(requestHold: hold);

      await service.signOut();
      expect(await service.signIn(kOidcConfig), SignInOutcome.signedIn);
      hold.complete();
      await late;

      expect(service.snapshot.status, SessionStatus.signedIn, reason: 'the provider refused the refresh token of the session that was signed out');
      expect(await service.accessToken(), isNotNull);
      expect((await world.vault.loadSession())!.refreshToken, isNotEmpty);
    });

    test('the late answer of the old session overwrites neither the credentials nor the subject of the new one', () async {
      final Completer<void> hold = Completer<void>();
      final (AuthService service, Future<void> late) = await refreshInFlight(responseHold: hold);

      await service.signOut();
      world.browser.subject = 'sub-bo';
      expect(await service.signIn(kOidcConfig), SignInOutcome.signedIn);
      final StoredSession before = (await world.vault.loadSession())!;
      hold.complete();
      await late;

      expect(service.snapshot.status, SessionStatus.signedIn, reason: 'a subject mismatch of the old answer is not a mismatch of the new session');
      expect(service.snapshot.userId, 'sub-bo');
      final StoredSession after = (await world.vault.loadSession())!;
      expect(after.refreshToken, before.refreshToken, reason: 'the refresh token of the old session was not stored over the new one');
      expect(after.userId, 'sub-bo');
      world.advance(const Duration(minutes: 5));
      expect(await service.accessToken(), isNotNull, reason: 'the new session still renews with its own refresh token');
      expect(service.snapshot.status, SessionStatus.signedIn);
    });

    test('the same account signing in again is a new session too: the old answer does not replace its refresh token', () async {
      final Completer<void> hold = Completer<void>();
      final (AuthService service, Future<void> late) = await refreshInFlight(responseHold: hold);

      await service.signOut();
      expect(await service.signIn(kOidcConfig), SignInOutcome.signedIn);
      final String current = (await world.vault.loadSession())!.refreshToken;
      hold.complete();
      await late;

      expect((await world.vault.loadSession())!.refreshToken, current);
      world.advance(const Duration(minutes: 5));
      expect(await service.accessToken(), isNotNull);
      expect(service.snapshot.status, SessionStatus.signedIn);
    });

    test('a tenant switch is not a new session: the rotated refresh token of the answer in flight is still kept', () async {
      world = World(memberships: <String, List<FakeMembership>>{'sub-ana': <FakeMembership>[tenantAMember, tenantBMember]});
      final AuthService service = world.service();
      await service.signIn(kOidcConfig);
      final List<MembershipChoice> choices = await service.candidates();
      await service.selectContext(choices.firstWhere((MembershipChoice c) => c.tenantId == 'tenant-a'));
      final MembershipChoice b = choices.firstWhere((MembershipChoice c) => c.tenantId == 'tenant-b');
      final Completer<void> selecting = world.api.selectHoldOnce = Completer<void>();
      final Future<SignInOutcome> switching = service.switchTenant(b);
      await pumpEventQueue();
      world.advance(const Duration(minutes: 5));
      final Completer<void> hold = world.idp.refreshResponseHoldOnce = Completer<void>();
      final Future<void> renewal = service.accessToken().then<void>((String? _) {}, onError: (Object _) {});
      await pumpEventQueue();
      selecting.complete();
      expect(await switching, SignInOutcome.signedIn);
      hold.complete();
      await renewal;

      final StoredSession stored = (await world.vault.loadSession())!;
      expect(stored.refreshToken, world.idp.latestRefreshOf(stored.refreshToken), reason: 'the provider rotated the token; the old one is dead');
      expect(service.snapshot.status, SessionStatus.signedIn);
      expect(service.snapshot.tenantId, 'tenant-b');
    });
  });

  group('AC-ST-MOB-008-4 UAT-PLAN-33 REVIEW-m1-7 a renewal that was on its way when the credential was locked gives no token', () {
    Future<AuthService> twoTenants() async {
      world = World(memberships: <String, List<FakeMembership>>{'sub-ana': <FakeMembership>[tenantAMember, tenantBMember]});
      final AuthService service = world.service();
      await service.signIn(kOidcConfig);
      return service;
    }

    test('a tenant token that is selected after the lock is not returned to the request that waited for it', () async {
      world = World();
      final AuthService service = await _signedInOnce(world);
      world.advance(const Duration(minutes: 6));
      final Completer<void> hold = world.api.selectHoldOnce = Completer<void>();
      final Future<String?> waiting = service.accessToken();
      await pumpEventQueue();

      service.lock();
      hold.complete();

      expect(await waiting, isNull, reason: 'the biometric lock is engaged: no bearer token leaves the service');
      expect(service.snapshot.locked, isTrue);
      expect(await service.accessToken(), isNull);
    });

    test('an identity refresh that answers after the lock keeps the rotated refresh token in the vault only, and the unlock goes on with it', () async {
      world = World();
      final AuthService service = await _signedInOnce(world);
      final String before = (await world.vault.loadSession())!.refreshToken;
      world.advance(const Duration(minutes: 6));
      final Completer<void> hold = world.idp.refreshResponseHoldOnce = Completer<void>();
      final Future<String?> waiting = service.accessToken();
      await pumpEventQueue();

      service.lock();
      hold.complete();

      expect(await waiting, isNull);
      expect(service.snapshot.locked, isTrue);
      final String stored = (await world.vault.loadSession())!.refreshToken;
      expect(stored, world.idp.latestRefreshOf(before), reason: 'the provider rotated it: the vault must not keep the dead one');
      expect(await service.accessToken(), isNull, reason: 'nothing was put back in memory while locked');
      expect(await service.unlock(reason: 'Unlock'), isTrue);
      expect(await service.accessToken(), isNotNull, reason: 'the stored token still renews the session');
      expect(service.snapshot.status, SessionStatus.signedIn);
    });

    test('the rotated refresh token that answers after the lock is not in memory: a late 401 cannot renew the locked session with it', () async {
      world = World();
      final AuthService service = await _signedInOnce(world);
      world.advance(const Duration(minutes: 6));
      final Completer<void> hold = world.idp.refreshResponseHoldOnce = Completer<void>();
      final Future<String?> waiting = service.accessToken();
      await pumpEventQueue();
      service.lock();
      hold.complete();
      expect(await waiting, isNull);

      final int calls = world.api.calls.length + world.idp.calls.length;
      world.advance(const Duration(minutes: 6));
      service.noteUnauthorized();
      await pumpEventQueue();

      expect(world.api.calls.length + world.idp.calls.length, calls, reason: 'nothing is asked of the server with a credential that is locked');
      expect(service.snapshot.locked, isTrue);
    });

    test('a lock that was lifted again before the provider answered keeps the rotated refresh token in memory and in the vault', () async {
      world = World();
      final AuthService service = await _signedInOnce(world);
      final String before = (await world.vault.loadSession())!.refreshToken;
      world.advance(const Duration(minutes: 6));
      final Completer<void> hold = world.idp.refreshResponseHoldOnce = Completer<void>();
      final Future<String?> waiting = service.accessToken();
      await pumpEventQueue();
      service.lock();
      expect(await service.unlock(reason: 'Unlock'), isTrue);
      hold.complete();

      expect(await waiting, isNotNull, reason: 'the person is unlocked again and the request asked for a token of this session');
      expect((await world.vault.loadSession())!.refreshToken, isNot(before));
      world.advance(const Duration(minutes: 6));
      expect(await service.accessToken(), isNotNull, reason: 'the refresh token in memory is the live one, not the one the vault held before the rotation');
      expect(service.snapshot.status, SessionStatus.signedIn);
    });

    test('a refusal that answers after the lock does not end the locked session', () async {
      world = World();
      final AuthService service = await _signedInOnce(world);
      world.advance(const Duration(minutes: 6));
      final Completer<void> hold = world.api.selectHoldOnce = Completer<void>();
      final Future<String?> waiting = service.accessToken();
      await pumpEventQueue();

      service.lock();
      world.api.selectFailureStatus = 401;
      world.api.selectFailureCode = 'SESSION_EXPIRED';
      hold.complete();

      expect(await waiting, isNull);
      expect(service.snapshot.locked, isTrue);
      expect(service.snapshot.status, SessionStatus.signedIn, reason: 'the person has not been asked to prove anything yet');
    });

    test('a tenant switch that the server answers after the lock does not unlock the credential', () async {
      final AuthService service = await twoTenants();
      final List<MembershipChoice> choices = await service.candidates();
      await service.selectContext(choices.firstWhere((MembershipChoice c) => c.tenantId == 'tenant-a'));
      final MembershipChoice b = choices.firstWhere((MembershipChoice c) => c.tenantId == 'tenant-b');
      final Completer<void> hold = world.api.selectHoldOnce = Completer<void>();
      final Future<Object?> switching = service.switchTenant(b).then<Object?>((SignInOutcome o) => o, onError: (Object e) => e);
      await pumpEventQueue();

      service.lock();
      hold.complete();

      expect(await switching, isA<NoSession>());
      expect(service.snapshot.locked, isTrue, reason: 'only the biometric prompt unlocks');
      expect(service.snapshot.tenantId, 'tenant-a');
      expect(await service.accessToken(), isNull);
    });
  });

  group('AC-ST-MOB-008-4 REVIEW-m1-8 a tenant selection that is answered after the session ended does not reopen it', () {
    Future<(AuthService, MembershipChoice, Completer<void>)> switching() async {
      world = World(memberships: <String, List<FakeMembership>>{'sub-ana': <FakeMembership>[tenantAMember, tenantBMember]});
      final AuthService service = world.service();
      await service.signIn(kOidcConfig);
      final List<MembershipChoice> choices = await service.candidates();
      await service.selectContext(choices.firstWhere((MembershipChoice c) => c.tenantId == 'tenant-a'));
      final MembershipChoice b = choices.firstWhere((MembershipChoice c) => c.tenantId == 'tenant-b');
      return (service, b, world.api.selectHoldOnce = Completer<void>());
    }

    Future<Object?> outcomeOf(Future<SignInOutcome> selection) => selection.then<Object?>((SignInOutcome o) => o, onError: (Object e) => e);

    void expectNothingRestored(AuthService service, Object? outcome, {String? tenant}) {
      expect(outcome, isA<NoSession>());
      expect(service.snapshot.tenantId, tenant, reason: 'no context was entered');
      expect(service.snapshot.status, isNot(SessionStatus.signedIn));
      expect(world.store.data.containsKey('session.v1'), isFalse, reason: 'the credentials stay gone');
    }

    test('a sign-out that completes while the switch is answered keeps the person signed out', () async {
      final (AuthService service, MembershipChoice b, Completer<void> hold) = await switching();
      final Future<Object?> selection = outcomeOf(service.switchTenant(b));
      await pumpEventQueue();

      await service.signOut();
      hold.complete();

      expectNothingRestored(service, await selection);
      expect(service.snapshot.status, SessionStatus.signedOut);
      expect(await service.accessToken(), isNull);
    });

    test('the wipe of a revoked device that completes while the switch is answered keeps the person signed out', () async {
      final (AuthService service, MembershipChoice b, Completer<void> hold) = await switching();
      final Future<Object?> selection = outcomeOf(service.switchTenant(b));
      await pumpEventQueue();

      service.noteResponse(401, 'DEVICE_REVOKED');
      await pumpEventQueue();
      hold.complete();

      expectNothingRestored(service, await selection);
      expect(service.snapshot.status, SessionStatus.signedOut);
    });

    test('a session that the server ended while the switch is answered stays expired', () async {
      final (AuthService service, MembershipChoice b, Completer<void> hold) = await switching();
      final Future<Object?> selection = outcomeOf(service.switchTenant(b));
      await pumpEventQueue();

      service.noteUnauthorized();
      await pumpEventQueue();
      expect(service.snapshot.status, SessionStatus.expired);
      hold.complete();

      expectNothingRestored(service, await selection, tenant: 'tenant-a');
      expect(service.snapshot.status, SessionStatus.expired);
      expect(await service.accessToken(), isNull);
    });

    test('a sign-in selection that is answered after a sign-out does not sign the person in', () async {
      world = World();
      final AuthService service = world.service();
      final Completer<void> hold = world.api.selectHoldOnce = Completer<void>();
      final Future<Object?> signingIn = outcomeOf(service.signIn(kOidcConfig));
      await pumpEventQueue();

      await service.signOut();
      hold.complete();

      expectNothingRestored(service, await signingIn);
      expect(service.snapshot.status, SessionStatus.signedOut);
    });

    test('a second-factor demand that arrives after a sign-out leaves no selection waiting', () async {
      world = World(memberships: <String, List<FakeMembership>>{'sub-ana': <FakeMembership>[_leaderNeedsMfa]});
      final AuthService service = world.service();
      final Completer<void> hold = world.api.selectHoldOnce = Completer<void>();
      final Future<Object?> signingIn = outcomeOf(service.signIn(kOidcConfig));
      await pumpEventQueue();

      await service.signOut();
      hold.complete();

      expectNothingRestored(service, await signingIn);
      expect(service.needsSecondFactor, isFalse, reason: 'the selection that waited for the second factor belonged to the ended session');
    });

    test('a switch that is answered with nothing in between still enters the tenant and keeps the same refresh token going', () async {
      final (AuthService service, MembershipChoice b, Completer<void> hold) = await switching();
      final Future<SignInOutcome> selection = service.switchTenant(b);
      await pumpEventQueue();
      hold.complete();

      expect(await selection, SignInOutcome.signedIn);
      expect(service.snapshot.tenantId, 'tenant-b');
    });
  });

  group('AC-ST-MOB-041-3 UAT-AC501 SEC-01 a sign-out that discards what waits does not read the queue', () {
    test('the queue is not asked for its count, and a queue that cannot be read does not keep the person signed in', () async {
      world = World();
      final AuthService service = await _signedInOnce(world);
      int asked = 0;
      world.countPending = () async {
        asked += 1;
        throw StateError('This database has already been closed');
      };

      await service.signOut(discardPending: true);

      expect(asked, 0, reason: 'what is discarded is not counted');
      expect(service.snapshot.status, SessionStatus.signedOut);
      expect(world.store.data.containsKey('session.v1'), isFalse, reason: 'the credentials are gone');
    });

    test('a sign-out that has not chosen to discard still counts, and is refused while commands wait', () async {
      world = World();
      final AuthService service = await _signedInOnce(world);
      world.countPending = () async => 2;
      await expectLater(service.signOut(), throwsA(isA<PendingCommandsBlock>()));
      expect(service.snapshot.status, SessionStatus.signedIn);
    });
  });

  group('REVIEW-m1-7 the verdict of a response belongs to the session that sent the request', () {
    Future<(AuthService, MachvonApiClient, MembershipChoice)> twoTenants() async {
      world = World(memberships: <String, List<FakeMembership>>{'sub-ana': <FakeMembership>[tenantAMember, tenantBMember]});
      final AuthService service = world.service();
      await service.signIn(kOidcConfig);
      final List<MembershipChoice> choices = await service.candidates();
      await service.selectContext(choices.firstWhere((MembershipChoice c) => c.tenantId == 'tenant-a'));
      return (service, _observed(world, service), choices.firstWhere((MembershipChoice c) => c.tenantId == 'tenant-b'));
    }

    test('a 401 that arrives from tenant A after the switch does not end the session of tenant B, whose token is brand new', () async {
      final (AuthService service, MachvonApiClient client, MembershipChoice b) = await twoTenants();
      final Completer<void> hold = world.api.profileHoldOnce = Completer<void>();
      final Future<void> failed = expectLater(client.execute('getMyProfile'), throwsA(isA<ApiError>()));
      await pumpEventQueue();

      await service.switchTenant(b);
      world.api.profileFailureStatus = 401;
      world.api.profileFailureCode = 'SESSION_EXPIRED';
      hold.complete();
      await failed;
      await pumpEventQueue();

      expect(service.snapshot.status, SessionStatus.signedIn);
      expect(service.snapshot.tenantId, 'tenant-b');
      expect(await service.accessToken(), isNotNull);
    });

    test('a 422 LICENSE_EXPIRED that arrives from tenant A after the switch does not make tenant B read-only', () async {
      final (AuthService service, MachvonApiClient client, MembershipChoice b) = await twoTenants();
      final Completer<void> hold = world.api.profileHoldOnce = Completer<void>();
      final Future<void> failed = expectLater(client.execute('getMyProfile'), throwsA(isA<ApiError>()));
      await pumpEventQueue();

      await service.switchTenant(b);
      world.api.profileFailureStatus = 422;
      world.api.profileFailureCode = 'LICENSE_EXPIRED';
      hold.complete();
      await failed;
      await pumpEventQueue();

      expect(service.snapshot.mode, SessionMode.full);
      expect(service.snapshot.isReadOnly, isFalse);
    });

    test('a 401 for a token that has since been renewed does not end the session that renewed it', () async {
      final (AuthService service, MachvonApiClient client, MembershipChoice _) = await twoTenants();
      final Completer<void> hold = world.api.profileHoldOnce = Completer<void>();
      final Future<void> failed = expectLater(client.execute('getMyProfile'), throwsA(isA<ApiError>()));
      await pumpEventQueue();

      world.advance(const Duration(minutes: 6));
      await service.accessToken();
      world.api.profileFailureStatus = 401;
      world.api.profileFailureCode = 'SESSION_EXPIRED';
      hold.complete();
      await failed;
      await pumpEventQueue();

      expect(service.snapshot.status, SessionStatus.signedIn, reason: 'the token that was refused is not the one the session holds now');
    });

    test('a 401 for the token the session holds still ends it, and a 422 LICENSE_EXPIRED still makes it read-only', () async {
      final (AuthService service, MachvonApiClient client, MembershipChoice _) = await twoTenants();
      world.api.profileFailureStatus = 422;
      world.api.profileFailureCode = 'LICENSE_EXPIRED';
      await _apiFailure(client.execute('getMyProfile'));
      expect(service.snapshot.isReadOnly, isTrue);

      world.api.profileFailureStatus = 401;
      world.api.profileFailureCode = 'SESSION_EXPIRED';
      await _apiFailure(client.execute('getMyProfile'));
      await pumpEventQueue();
      expect(service.snapshot.status, SessionStatus.expired);
    });
  });
}

/// Passes each call on and tells the session what it answered, as the transport of the application does.
class _Relay implements HttpTransport {
  _Relay(this._inner, this._report);

  final HttpTransport _inner;
  final void Function(int status, String? code) _report;

  @override
  Future<HttpResult> send(HttpCall call) async {
    final HttpResult result = await _inner.send(call);
    if (result.status >= 400) {
      final Object? body = jsonDecode(result.body);
      _report(result.status, body is Map<String, Object?> ? body['code'] as String? : null);
    }
    return result;
  }
}
