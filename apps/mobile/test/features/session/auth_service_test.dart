import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/features/session/auth/auth_service.dart';
import 'package:machvon_mobile/features/session/auth/identity_api.dart';
import 'package:machvon_mobile/features/session/auth/oidc_client.dart';
import 'package:machvon_mobile/features/session/auth/session_vault.dart';

import '../../support/harness.dart';
import 'support/world.dart';

const FakeMembership _tenantAOther = FakeMembership('tenant-a', 'UBND Minh Hà', 'm-a2', 'INVESTOR_OFFICER');
const FakeMembership _leaderNeedsMfa = FakeMembership('tenant-a', 'UBND Minh Hà', 'm-a1', 'LEADER', requiresMfa: true);

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

  group('AC-ST-MOB-008-2 MOB02 a request is made for one tenant only', () {
    test('the token of the active tenant is given, the token for another tenant is refused', () async {
      world = World();
      final AuthService service = world.service();
      await service.signIn(kOidcConfig);
      expect(await service.accessTokenFor('tenant-a'), isNotNull);
      await expectLater(service.accessTokenFor('tenant-b'), throwsA(isA<TenantMismatch>()));
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
