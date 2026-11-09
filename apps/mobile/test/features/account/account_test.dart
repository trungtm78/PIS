import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/di/providers.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/core/state/state_card.dart';
import 'package:machvon_mobile/features/account/account_feature.dart' as account;
import 'package:machvon_mobile/features/permissions/permission_providers.dart';
import 'package:machvon_mobile/features/permissions/permission_service.dart';
import 'package:machvon_mobile/features/phone_search/phone_search_feature.dart' as phone_search;
import 'package:machvon_mobile/features/release/app_info.dart';
import 'package:machvon_mobile/features/session/auth/auth_service.dart';
import 'package:machvon_mobile/features/session/auth/identity_api.dart';
import 'package:machvon_mobile/features/session/auth/pending_work.dart';
import 'package:machvon_mobile/features/session/auth/session_vault.dart';
import 'package:machvon_mobile/features/session/session_providers.dart';

import '../../support/harness.dart';
import '../../support/offline_support.dart';
import '../permissions/permissions_test.dart' show FakePermissions;
import '../session/support/app.dart';
import '../session/support/world.dart';

class _Pending implements PendingWork {
  _Pending(this.world);

  final World world;
  int sent = 0;
  bool failToSend = false;
  int leftAfterSend = 0;

  @override
  Future<int> count() async => world.pending;

  int discarded = 0;

  @override
  Future<void> discardUnsent() async {
    discarded += 1;
    world.pending = 0;
  }

  @override
  Future<void> sendNow() async {
    sent += 1;
    if (failToSend) throw StateError('no connection');
    world.pending = leftAfterSend;
  }
}

class _AppInfo implements AppInfoSource {
  @override
  Future<AppInfo> read() async => const AppInfo(version: '1.4.0', build: '27', platform: 'android', osVersion: '14');
}

const FakeMembership _tenantB = FakeMembership('tenant-b', 'Bộ Thử Nghiệm', 'm-b1', 'SPECIALIST');
const FakeMembership _tenantBNeedsMfa = FakeMembership('tenant-b', 'Bộ Thử Nghiệm', 'm-b1', 'SPECIALIST', requiresMfa: true);

World _twoTenants({int pending = 0, FakeMembership b = _tenantB}) => World(
      memberships: <String, List<FakeMembership>>{'sub-ana': <FakeMembership>[tenantAMember, b]},
      pendingCommands: pending,
    );

Future<AuthService> _signedInTo(World world, String tenantId) async {
  final AuthService service = world.service();
  await service.signIn(kOidcConfig);
  if (service.snapshot.tenantId != tenantId) {
    final MembershipChoice choice = (await service.candidates()).firstWhere((MembershipChoice c) => c.tenantId == tenantId);
    await service.selectContext(choice);
  }
  return service;
}

Future<ProviderContainer> _pumpAccount(
  WidgetTester tester,
  World world, {
  String location = '/account',
  _Pending? pending,
  FakePermissions? phone,
  List<Override> overrides = const <Override>[],
}) {
  return pumpSessionApp(
    tester,
    world,
    location: location,
    features: <MobileFeature>[account.feature, phone_search.feature],
    overrides: <Override>[
      secureValueStoreProvider.overrideWithValue(world.store),
      pendingWorkProvider.overrideWithValue(pending ?? _Pending(world)),
      biometricGateProvider.overrideWithValue(world.biometrics),
      permissionPlatformProvider.overrideWithValue(phone ?? FakePermissions()),
      appInfoSourceProvider.overrideWithValue(_AppInfo()),
      ...overrides,
    ],
  );
}

void main() {
  late World world;

  setUp(() => world = World());
  tearDown(() => world.dispose());

  group('AC-ST-MOB-008-1 UAT-AC505 TK-MOB-008-1 switching tenant with a command waiting', () {
    test('the switch is blocked and shows the number, and nothing of the old tenant is deleted until it is sent or discarded', () async {
      world = _twoTenants(pending: 1);
      final TestStorage storage = TestStorage.create();
      world.extraPurgers.add(OfflineStoragePurger(storage.storage));
      await storage.open(tenantId: 'tenant-a', userId: 'sub-ana');
      final AuthService service = await _signedInTo(world, 'tenant-a');
      final MembershipChoice b = (await service.candidates()).firstWhere((MembershipChoice c) => c.tenantId == 'tenant-b');

      await expectLater(service.switchTenant(b), throwsA(isA<PendingCommandsBlock>().having((PendingCommandsBlock e) => e.count, 'count', 1)));
      expect(service.snapshot.tenantId, 'tenant-a', reason: 'the session did not move');
      expect(storage.keys.keys, isNotEmpty);
      expect(storage.directory.listSync(), isNotEmpty);
      expect(world.api.calls.where((HttpCall c) => c.method == 'POST' && jsonDecode(c.body ?? '{}').toString().contains('tenant-b')), isEmpty, reason: 'no selection was even sent');

      // The command is sent: the switch goes through and the old store, its key and its files are gone.
      world.pending = 0;
      expect(await service.switchTenant(b), SignInOutcome.signedIn);
      expect(service.snapshot.tenantId, 'tenant-b');
      expect(storage.directory.listSync(), isEmpty);
      expect(storage.keys.keys, isEmpty);
      expect(world.store.data.keys.where((String k) => k.startsWith('tenant.tenant-a.')), isEmpty);
      expect(await world.vault.pendingPurges(), isEmpty);
    });

    test('discarding the unsent command lets the switch through, and the old data is deleted with it', () async {
      world = _twoTenants(pending: 2);
      final TestStorage storage = TestStorage.create();
      world.extraPurgers.add(OfflineStoragePurger(storage.storage));
      await storage.open(tenantId: 'tenant-a', userId: 'sub-ana');
      final AuthService service = await _signedInTo(world, 'tenant-a');
      final MembershipChoice b = (await service.candidates()).firstWhere((MembershipChoice c) => c.tenantId == 'tenant-b');
      expect(await service.switchTenant(b, discardPending: true), SignInOutcome.signedIn);
      expect(storage.directory.listSync(), isEmpty);
      expect(world.purger.purged, <({String tenantId, String userId})>[(tenantId: 'tenant-a', userId: 'sub-ana')]);
    });

    test('a role of the same tenant does not need the data of the tenant to go, nor a stop for unsent commands', () async {
      world = World(
        memberships: <String, List<FakeMembership>>{'sub-ana': <FakeMembership>[tenantAMember, const FakeMembership('tenant-a', 'UBND Minh Hà', 'm-a2', 'SPECIALIST')]},
        pendingCommands: 3,
      );
      final AuthService service = await _signedInTo(world, 'tenant-a');
      final MembershipChoice other = (await service.candidates()).firstWhere((MembershipChoice c) => c.membershipId != service.snapshot.membershipId);
      expect(await service.switchTenant(other), SignInOutcome.signedIn);
      expect(service.snapshot.membershipId, 'm-a2');
      expect(world.purger.purged, isEmpty);
    });

    test('the security option "keep encrypted" leaves the old store and its key where they are', () async {
      world = _twoTenants();
      final TestStorage storage = TestStorage.create();
      world.extraPurgers.add(OfflineStoragePurger(storage.storage));
      await storage.open(tenantId: 'tenant-a', userId: 'sub-ana');
      final AuthService service = await _signedInTo(world, 'tenant-a');
      expect(await service.localDataPolicy(), LocalDataPolicy.purge, reason: 'the default deletes');
      await service.setLocalDataPolicy(LocalDataPolicy.keepEncrypted);
      final MembershipChoice b = (await service.candidates()).firstWhere((MembershipChoice c) => c.tenantId == 'tenant-b');
      await service.switchTenant(b);
      expect(storage.directory.listSync(), isNotEmpty);
      expect(storage.keys.keys, isNotEmpty);
      expect(world.purger.purged, isEmpty);
    });

    test('a switch that fails changes nothing: the old tenant keeps its session and its data', () async {
      world = _twoTenants();
      final AuthService service = await _signedInTo(world, 'tenant-a');
      final MembershipChoice b = (await service.candidates()).firstWhere((MembershipChoice c) => c.tenantId == 'tenant-b');
      world.api.selectFailureStatus = 403;
      world.api.selectFailureCode = 'TENANT_SUSPENDED';
      await expectLater(service.switchTenant(b), throwsA(isA<ApiError>()));
      expect(service.snapshot.tenantId, 'tenant-a');
      expect(world.purger.purged, isEmpty);
      world.api.selectFailureStatus = 0;
      expect(await service.switchTenant(b), SignInOutcome.signedIn);
      expect(world.purger.purged, hasLength(1), reason: 'the leftover intention of the failed switch did not purge twice');
    });

    test('a switch to a tenant that needs the second factor waits for it, then deletes the old data; cancelling keeps the old data', () async {
      world = _twoTenants(b: _tenantBNeedsMfa);
      final AuthService service = await _signedInTo(world, 'tenant-a');
      final MembershipChoice b = (await service.candidates()).firstWhere((MembershipChoice c) => c.tenantId == 'tenant-b');

      expect(await service.switchTenant(b), SignInOutcome.needsSecondFactor);
      expect(world.purger.purged, isEmpty);
      service.cancelSecondFactor();
      expect(service.snapshot.tenantId, 'tenant-a');
      final MembershipChoice a = (await service.candidates()).firstWhere((MembershipChoice c) => c.tenantId == 'tenant-a');
      await service.selectContext(a);
      expect(world.purger.purged, isEmpty, reason: 'the cancelled switch no longer deletes anything');

      expect(await service.switchTenant(b), SignInOutcome.needsSecondFactor);
      expect(await service.stepUp(), SignInOutcome.signedIn);
      expect(service.snapshot.tenantId, 'tenant-b');
      expect(world.purger.purged, <({String tenantId, String userId})>[(tenantId: 'tenant-a', userId: 'sub-ana')]);
    });

    test('a purge that fails half way is finished when the application starts again, and the old data is never left behind', () async {
      world = _twoTenants();
      final AuthService service = await _signedInTo(world, 'tenant-a');
      final MembershipChoice b = (await service.candidates()).firstWhere((MembershipChoice c) => c.tenantId == 'tenant-b');
      world.purger.failure = StateError('disk error');
      await expectLater(service.switchTenant(b), throwsStateError);
      expect(service.snapshot.tenantId, 'tenant-b', reason: 'the new tenant is entered');
      expect(await world.vault.pendingPurges(), <String>{'tenant-a/sub-ana'}, reason: 'the journal remembers what is left');

      world.purger.failure = null;
      final AuthService restarted = world.service();
      await restarted.ready;
      expect(world.purger.purged, <({String tenantId, String userId})>[(tenantId: 'tenant-a', userId: 'sub-ana')]);
      expect(await world.vault.pendingPurges(), isEmpty);
    });

    test('a journal entry that is not an entry is dropped', () async {
      world = World();
      await world.vault.markPurge('garbage');
      final AuthService service = world.service();
      await service.ready;
      expect(await world.vault.pendingPurges(), isEmpty);
    });
  });

  group('AC-ST-MOB-008-2 MOB02 a command queued for a tenant is never sent under another', () {
    testWidgets('after the switch to B the client of tenant A fails before anything leaves the phone', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      world = _twoTenants();
      final ProviderContainer container = await pumpSessionApp(tester, world);
      await container.read(authServiceProvider).signIn(kOidcConfig);
      final AuthService service = container.read(authServiceProvider);
      await service.selectContext((await service.candidates()).firstWhere((MembershipChoice c) => c.tenantId == 'tenant-a'));
      final MachvonApiClient clientOfA = container.read(tenantApiClientProvider('tenant-a'));
      expect(await clientOfA.execute('getMyProfile'), isA<Map<String, Object?>>(), reason: 'while A is active it works');

      await service.switchTenant((await service.candidates()).firstWhere((MembershipChoice c) => c.tenantId == 'tenant-b'));
      final int before = world.api.calls.length;
      await expectLater(clientOfA.execute('getMyProfile'), throwsA(isA<TenantMismatch>()));
      expect(world.api.calls.length, before, reason: 'no upload or request is made under tenant B for a command of tenant A');
      expect(await container.read(tenantApiClientProvider('tenant-b')).execute('getMyProfile'), isA<Map<String, Object?>>());
    });
  });

  group('AC-ST-MOB-008-3 AC-ST-MOB-008-6 UAT-AC102 UI-MOB-49 devices and revocation', () {
    void seed(World w) {
      w.api.sessions.addAll(<Map<String, Object?>>[
        <String, Object?>{'id': 's-1', 'current': true, 'assurance_level': 'aal1', 'user_agent_summary': 'MACHVON Android 14', 'created_at': '2026-11-01T00:00:00Z', 'last_seen_at': '2026-11-03T01:00:00Z', 'device': <String, Object?>{'id': 'd-this'}},
        <String, Object?>{'id': 's-2', 'current': false, 'assurance_level': 'aal1', 'user_agent_summary': 'MACHVON iOS 17', 'created_at': '2026-10-01T00:00:00Z', 'last_seen_at': '2026-11-02T01:00:00Z', 'device': null},
      ]);
      w.api.devices.addAll(<Map<String, Object?>>[
        <String, Object?>{'id': 'd-this', 'platform': 'android', 'device_public_id': 'device-public-aaaa1111', 'last_seen_at': '2026-11-03T01:00:00Z', 'revoked_at': null, 'status': 'ACTIVE'},
        <String, Object?>{'id': 'd-other', 'platform': 'ios', 'device_public_id': 'device-public-bbbb2222', 'last_seen_at': '2026-11-02T01:00:00Z', 'revoked_at': null, 'status': 'ACTIVE'},
        <String, Object?>{'id': 'd-old', 'platform': 'android', 'device_public_id': 'device-public-cccc3333', 'last_seen_at': '2026-10-01T01:00:00Z', 'revoked_at': '2026-10-02T00:00:00Z', 'status': 'REVOKED'},
      ]);
    }

    testWidgets('lists the sessions and the devices; revoking another device asks, sends a reason of 10 characters or more, and shows it revoked', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      seed(world);
      await world.service().signIn(kOidcConfig);
      await _pumpAccount(tester, world, location: '/account/mob-49');

      expect(find.text('Phiên đang mở'), findsOneWidget);
      expect(find.text('MACHVON Android 14'), findsOneWidget);
      expect(find.text('Phiên này · Hoạt động gần nhất: 03/11/2026 08:00'), findsOneWidget);
      expect(find.textContaining('Máy này'), findsOneWidget);
      expect(find.textContaining('Đã thu hồi'), findsOneWidget);
      expect(find.text('Thu hồi'), findsNWidgets(2), reason: 'a revoked device offers nothing');

      await tester.tap(find.text('Thu hồi').last);
      await tester.pumpAndSettle();
      expect(find.text('Thu hồi thiết bị?'), findsOneWidget);
      await tester.tap(find.text('Thu hồi thiết bị'));
      await tester.pumpAndSettle();

      final HttpCall call = world.api.revokeCalls.single;
      expect(call.url.path, '/v1/me/devices/d-other/revoke');
      expect((jsonDecode(call.body!) as Map<String, Object?>)['reason'], 'Thu hồi từ ứng dụng di động');
      expect(((jsonDecode(call.body!) as Map<String, Object?>)['reason']! as String).length, greaterThanOrEqualTo(10));
      expect(call.headers['idempotency-key'], hasLength(greaterThanOrEqualTo(16)));
      expect(find.text('Đã thu hồi thiết bị.'), findsOneWidget);
    });

    testWidgets('a revocation whose answer is lost is repeated with the same key, and the server executes it once', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      seed(world);
      world.api.revokeUnreachableOnce = true;
      await world.service().signIn(kOidcConfig);
      await _pumpAccount(tester, world, location: '/account/mob-49');
      await tester.tap(find.text('Thu hồi').last);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Thu hồi thiết bị'));
      await tester.pumpAndSettle();
      expect(find.text('Máy chủ phản hồi quá chậm'), findsOneWidget, reason: 'the answer was lost');

      await tester.tap(find.text('Thử lại'));
      await tester.pumpAndSettle();
      expect(world.api.revokeCalls, hasLength(2));
      expect(world.api.revokeCalls[1].headers['idempotency-key'], world.api.revokeCalls[0].headers['idempotency-key']);
      expect(find.text('Đã thu hồi thiết bị.'), findsOneWidget);
    });

    testWidgets('revoking this phone signs it out at once and deletes its local data of every tenant', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      seed(world);
      world.pending = 2;
      final ProviderContainer container = await _signedIn(tester, world, location: '/account/mob-49');
      expect(find.text('Thu hồi'), findsNWidgets(2));
      await tester.tap(find.text('Thu hồi').first);
      await tester.pumpAndSettle();
      expect(find.textContaining('Đây là máy bạn đang cầm'), findsOneWidget);
      expect(find.textContaining('2 thay đổi chưa gửi'), findsOneWidget);
      await tester.tap(find.text('Thu hồi thiết bị'));
      await tester.pumpAndSettle();

      expect(world.api.revokeCalls.single.url.path, '/v1/me/devices/d-this/revoke');
      expect(container.read(sessionProvider).status, SessionStatus.signedOut);
      expect(world.purger.purgedAll, 1);
      expect(world.store.data.containsKey('session.v1'), isFalse);
      expect(currentLocation(container), startsWith('/mob-02'));
    });

    test('the server telling a device it was revoked ends the session and deletes the data of every tenant on first contact', () async {
      world = _twoTenants();
      final AuthService service = await _signedInTo(world, 'tenant-a');
      service.noteResponse(401, 'DEVICE_REVOKED');
      await pumpEventQueue();
      expect(service.snapshot.status, SessionStatus.signedOut);
      expect(world.purger.purgedAll, 1);
      expect(world.store.data.containsKey('session.v1'), isFalse);
      service.noteResponse(401, 'DEVICE_REVOKED');
      await pumpEventQueue();
      expect(world.purger.purgedAll, 1, reason: 'once');
    });

    testWidgets('every state: loading, empty, error with retry, ended session, licence expired, denied, time-out, offline', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      world = World();
      await world.service().signIn(kOidcConfig);
      await _pumpAccount(tester, world, location: '/account/mob-49');
      expect(find.text('Chưa có thiết bị nào'), findsOneWidget, reason: 'empty');

      Future<ProviderContainer> open(void Function(World w) arrange) async {
        world = World();
        await world.service().signIn(kOidcConfig);
        arrange(world);
        return _pumpAccount(tester, world, location: '/account/mob-49');
      }

      await open((World w) {
        w.api.listFailureStatus = 500;
        w.api.listFailureCode = 'INTERNAL_ERROR';
      });
      expect(find.text('Chưa thể tải dữ liệu'), findsOneWidget, reason: 'error');
      world.api.listFailureStatus = 0;
      await tester.tap(find.text('Thử lại'));
      await tester.pumpAndSettle();
      expect(find.text('Chưa có thiết bị nào'), findsOneWidget, reason: 'retry');

      await open((World w) {
        w.api.listFailureStatus = 401;
        w.api.listFailureCode = 'SESSION_EXPIRED';
      });
      expect(find.text('SESSION_EXPIRED'), findsOneWidget, reason: 'ended session');
      await open((World w) {
        w.api.listFailureStatus = 422;
        w.api.listFailureCode = 'LICENSE_EXPIRED';
      });
      expect(find.text('License đã hết hạn'), findsOneWidget, reason: 'expired licence');
      await open((World w) {
        w.api.listFailureStatus = 403;
        w.api.listFailureCode = 'SCOPE_DENIED';
      });
      expect(find.text('Bạn chưa có quyền truy cập'), findsOneWidget, reason: 'denied');
      final ProviderContainer container = await open((World w) => w.api.listUnreachable = true);
      expect(find.text('Máy chủ phản hồi quá chậm'), findsOneWidget, reason: 'time-out');
      container.read(reachabilityProvider.notifier).report(Reachability.offline);
      await tester.tap(find.text('Thử lại'));
      await tester.pumpAndSettle();
      expect(find.text('Bạn đang ngoại tuyến'), findsOneWidget, reason: 'offline');
    });

    testWidgets('UI-MOB-49 screen contract at the three devices and at 200 percent text', (WidgetTester tester) async {
      await expectScreenContract(tester, () async {
        world = World();
        seed(world);
        await world.service().signIn(kOidcConfig);
        await _pumpAccount(tester, world, location: '/account/mob-49');
        expect(find.text('Thiết bị và đăng xuất'), findsWidgets);
      });
    });
  });

  group('AC-ST-MOB-008-3 TK-MOB-008-3 sign-out', () {
    testWidgets('signing out cancels the refresh token at the provider, deletes the local data of the tenant, and sends the person to sign-in', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      world = World();
      final ProviderContainer container = await _signedIn(tester, world, location: '/account/mob-49');
      final String refresh = (await world.vault.loadSession())!.refreshToken;

      await tester.ensureVisible(find.text('Đăng xuất'));
      await tester.tap(find.text('Đăng xuất'));
      await tester.pumpAndSettle();
      expect(find.text('Đăng xuất khỏi máy này?'), findsOneWidget);
      await tester.tap(find.descendant(of: find.byType(AlertDialog), matching: find.widgetWithText(FilledButton, 'Đăng xuất')));
      await tester.pumpAndSettle();

      expect(container.read(sessionProvider).status, SessionStatus.signedOut);
      expect(world.idp.familyRevoked(refresh), isTrue);
      expect(world.store.data.containsKey('session.v1'), isFalse);
      expect(world.purger.purged, <({String tenantId, String userId})>[(tenantId: 'tenant-a', userId: 'sub-ana')]);
      expect(currentLocation(container), startsWith('/mob-02'));
    });

    testWidgets('with commands waiting it says how many would be lost, and signs out only when the person accepts', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      world = World(pendingCommands: 3);
      final ProviderContainer container = await _signedIn(tester, world, location: '/account/mob-49');
      await tester.ensureVisible(find.text('Đăng xuất'));
      await tester.tap(find.text('Đăng xuất'));
      await tester.pumpAndSettle();
      expect(find.textContaining('3 thay đổi chưa gửi sẽ bị mất'), findsOneWidget);
      await tester.tap(find.text('Hủy'));
      await tester.pumpAndSettle();
      expect(container.read(sessionProvider).status, SessionStatus.signedIn);

      await tester.tap(find.text('Đăng xuất'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Bỏ 3 thay đổi và đăng xuất'));
      await tester.pumpAndSettle();
      expect(container.read(sessionProvider).status, SessionStatus.signedOut);
    });

    testWidgets('"delete every organisation" also removes the data of the other tenants that stayed on the phone', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      world = _twoTenants();
      final ProviderContainer container = await _signedIn(tester, world, location: '/account/mob-49');
      await world.vault.addTenant('tenant-z');
      world.store.data['tenant.tenant-z.theme.v1'] = '{}';
      await tester.ensureVisible(find.text('Đăng xuất'));
      await tester.tap(find.text('Đăng xuất'));
      await tester.pumpAndSettle();
      await tester.tap(find.byType(CheckboxListTile));
      await tester.pump();
      await tester.tap(find.descendant(of: find.byType(AlertDialog), matching: find.widgetWithText(FilledButton, 'Đăng xuất')));
      await tester.pumpAndSettle();
      expect(container.read(sessionProvider).status, SessionStatus.signedOut);
      expect(world.purger.purgedAll, 1);
      expect(world.store.data.keys.where((String k) => k.startsWith('tenant.')), isEmpty);
      expect(await world.vault.knownTenants(), isEmpty);
    });

    test('a session that already ended signs out without a stop, even with commands waiting; the provider is not asked for a token it has not got', () async {
      world = World(pendingCommands: 5);
      final AuthService service = await _signedInTo(world, 'tenant-a');
      world.api.selectFailureStatus = 401;
      world.advance(const Duration(minutes: 6));
      await expectLater(service.accessToken(), throwsA(isA<ApiError>()));
      expect(service.snapshot.status, SessionStatus.expired);
      await service.signOut();
      expect(service.snapshot.status, SessionStatus.signedOut);
    });

    test('with the keep-encrypted option the data of the tenant stays on the phone after sign-out; the provider is still told', () async {
      world = World();
      final AuthService service = await _signedInTo(world, 'tenant-a');
      await service.setLocalDataPolicy(LocalDataPolicy.keepEncrypted);
      final String refresh = (await world.vault.loadSession())!.refreshToken;
      await service.signOut();
      expect(world.purger.purged, isEmpty);
      expect(world.idp.familyRevoked(refresh), isTrue);
    });

    test('a sign-out with a provider that cannot be reached still ends the session and deletes the data', () async {
      world = World();
      final AuthService service = await _signedInTo(world, 'tenant-a');
      world.idp.reachable = false;
      await service.signOut();
      expect(service.snapshot.status, SessionStatus.signedOut);
      expect(world.purger.purged, hasLength(1));
    });
  });

  group('AC-ST-MOB-008-5 UI-MOB-48 the tenant switch screen', () {
    testWidgets('lists the memberships, marks the one in use, and says what happens to the data; confirming switches and goes home', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      world = _twoTenants();
      final ProviderContainer container = await _signedIn(tester, world, location: '/account/mob-48');

      expect(find.text('Đổi tổ chức'), findsWidgets);
      expect(find.text('UBND Minh Hà'), findsOneWidget);
      expect(find.text('Bộ Thử Nghiệm'), findsOneWidget);
      expect(find.text('Đang dùng'), findsOneWidget);
      expect(find.textContaining('Cơ sở dữ liệu, khóa và tệp tạm của tổ chức cũ sẽ bị xóa'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Đổi sang tổ chức này')).onPressed, isNull);

      await tester.tap(find.text('Bộ Thử Nghiệm'));
      await tester.pump();
      await tapText(tester, 'Đổi sang tổ chức này');
      await tester.pumpAndSettle();

      expect(container.read(sessionProvider).tenantId, 'tenant-b');
      expect(currentLocation(container), '/home');
      expect(world.purger.purged, hasLength(1));
    });

    testWidgets('with an unsent command the screen blocks the switch showing the number; sending it clears the block, discarding switches', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      world = _twoTenants(pending: 1);
      final _Pending pending = _Pending(world);
      final ProviderContainer container = await _signedIn(tester, world, location: '/account/mob-48', pending: pending);
      await tester.tap(find.text('Bộ Thử Nghiệm'));
      await tester.pump();
      await tapText(tester, 'Đổi sang tổ chức này');
      await tester.pumpAndSettle();

      expect(find.text('Còn thay đổi chưa gửi'), findsOneWidget);
      expect(find.textContaining('Có 1 thay đổi chưa gửi'), findsOneWidget);
      expect(container.read(sessionProvider).tenantId, 'tenant-a');
      expect(world.purger.purged, isEmpty);

      // Sending fails: the block stays and says so.
      pending.failToSend = true;
      await tapText(tester, 'Gửi ngay');
      await tester.pumpAndSettle();
      expect(find.textContaining('Chưa gửi hết được'), findsOneWidget);

      // The command is sent: the block lifts and the switch goes through.
      pending.failToSend = false;
      await tapText(tester, 'Gửi ngay');
      await tester.pumpAndSettle();
      expect(find.text('Còn thay đổi chưa gửi'), findsNothing);
      await tapText(tester, 'Đổi sang tổ chức này');
      await tester.pumpAndSettle();
      expect(container.read(sessionProvider).tenantId, 'tenant-b');
    });

    testWidgets('discarding the unsent commands switches and deletes the old data', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      world = _twoTenants(pending: 2);
      final ProviderContainer container = await _signedIn(tester, world, location: '/account/mob-48');
      await tester.tap(find.text('Bộ Thử Nghiệm'));
      await tester.pump();
      await tapText(tester, 'Đổi sang tổ chức này');
      await tester.pumpAndSettle();
      // Sending leaves one behind.
      await tapText(tester, 'Bỏ 2 thay đổi và đổi');
      await tester.pumpAndSettle();
      expect(container.read(sessionProvider).tenantId, 'tenant-b');
      expect(world.purger.purged, hasLength(1));
    });

    testWidgets('the option to keep the old data encrypted is shown and remembered', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      world = _twoTenants();
      await _signedIn(tester, world, location: '/account/mob-48');
      await tester.tap(find.byType(Switch));
      await tester.pumpAndSettle();
      expect(find.textContaining('vẫn mã hóa, cho lần quay lại'), findsOneWidget);
      expect(await world.vault.localDataPolicy(), LocalDataPolicy.keepEncrypted);
    });

    testWidgets('a tenant that needs the second factor goes to MOB-03', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      world = _twoTenants(b: _tenantBNeedsMfa);
      final ProviderContainer container = await _signedIn(tester, world, location: '/account/mob-48');
      await tester.tap(find.text('Bộ Thử Nghiệm'));
      await tester.pump();
      await tapText(tester, 'Đổi sang tổ chức này');
      await tester.pumpAndSettle();
      expect(currentLocation(container), startsWith('/mob-03'));
    });

    testWidgets('a person with one membership sees that there is no other; every state of the list holds', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      world = World();
      await _signedIn(tester, world, location: '/account/mob-48');
      expect(find.text('Không có tổ chức khác'), findsOneWidget, reason: 'empty');

      Future<ProviderContainer> open(void Function(ApiProbe api) arrange) async {
        world = _twoTenants();
        return _signedIn(tester, world, location: '/account/mob-48', afterSeed: (World w) => arrange(ApiProbe(w.api)));
      }

      final Completer<void> gate = Completer<void>();
      await open((ApiProbe api) => api.holdFromNow(gate.future));
      expect(find.byType(LoadingView), findsOneWidget, reason: 'loading');
      gate.complete();
      await tester.pumpAndSettle();
      expect(find.text('Bộ Thử Nghiệm'), findsOneWidget);

      await open((ApiProbe api) => api.failFromNow(500, 'INTERNAL_ERROR'));
      expect(find.text('Chưa thể tải dữ liệu'), findsOneWidget, reason: 'error');
      world.api.candidatesFailAfter = 1 << 30;
      await tester.tap(find.text('Thử lại'));
      await tester.pumpAndSettle();
      expect(find.text('Bộ Thử Nghiệm'), findsOneWidget, reason: 'retry');

      await open((ApiProbe api) => api.failFromNow(401, 'SESSION_EXPIRED'));
      expect(find.text('SESSION_EXPIRED'), findsOneWidget, reason: 'ended session');
      await open((ApiProbe api) => api.failFromNow(403, 'SCOPE_DENIED'));
      expect(find.text('Bạn chưa có quyền truy cập'), findsOneWidget, reason: 'denied');
      await open((ApiProbe api) => api.failFromNow(422, 'LICENSE_EXPIRED'));
      expect(find.text('License đã hết hạn'), findsOneWidget, reason: 'expired licence');
      final ProviderContainer container = await open((ApiProbe api) => api.failFromNow(0, 'NETWORK', unreachable: true));
      expect(find.text('Máy chủ phản hồi quá chậm'), findsOneWidget, reason: 'time-out');
      container.read(reachabilityProvider.notifier).report(Reachability.offline);
      await tester.tap(find.text('Thử lại'));
      await tester.pumpAndSettle();
      expect(find.text('Bạn đang ngoại tuyến'), findsOneWidget, reason: 'offline');
    });

    testWidgets('UI-MOB-48 screen contract at the three devices and at 200 percent text', (WidgetTester tester) async {
      await expectScreenContract(tester, () async {
        world = _twoTenants();
        await _signedIn(tester, world, location: '/account/mob-48');
        expect(find.text('Bộ Thử Nghiệm'), findsOneWidget);
      });
    });
  });

  group('AC-ST-MOB-008-4 UAT-PLAN-33 UI-MOB-47 the account and the biometric unlock', () {
    testWidgets('shows who is signed in, the organisation and role, the push state and the version; the language changes at once', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      world = World();
      final FakePermissions phone = FakePermissions()..now[AppPermission.notifications] = PermissionState.blocked;
      final ProviderContainer container = await _signedIn(tester, world, location: '/account', phone: phone);

      expect(find.text('Ana'), findsOneWidget);
      expect(find.text('Email: a***@example.vn'), findsOneWidget);
      expect(find.text('UBND Minh Hà'), findsOneWidget);
      expect(find.text('Vai trò: LEADER'), findsOneWidget);
      expect(find.text('Bị chặn trong cài đặt của máy'), findsOneWidget);
      await tester.ensureVisible(find.textContaining('Phiên bản ứng dụng'));
      expect(find.text('Phiên bản ứng dụng: 1.4.0+27'), findsOneWidget);

      await tester.ensureVisible(find.text('English'));
      await tester.tap(find.text('English'));
      await tester.pumpAndSettle();
      expect(container.read(localeProvider).languageCode, 'en');
      expect(find.text('Account'), findsOneWidget);
      expect(find.text('App version: 1.4.0+27'), findsOneWidget);
    });

    testWidgets('MOB-ENT-03 the organisation is the one of the session even when two organisations give the person the same membership id; a known type is said in words', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      // The first membership listed (organisation A) carries the same id as the one the session holds (organisation B).
      world = World(
        memberships: <String, List<FakeMembership>>{
          'sub-ana': <FakeMembership>[
            const FakeMembership('tenant-a', 'Hà Giang', 'm-same', 'GUEST_CONTRACTOR'),
            const FakeMembership('tenant-b', 'Đạm Phú Mỹ', 'm-same', 'STAFF'),
          ],
        },
      );
      await _signedIn(tester, world, location: '/account', tenantId: 'tenant-b');

      expect(find.text('Đạm Phú Mỹ'), findsOneWidget);
      expect(find.text('Hà Giang'), findsNothing);
      expect(find.text('Vai trò: Cán bộ của tổ chức'), findsOneWidget);
      expect(find.text('Vai trò: STAFF'), findsNothing);
    });

    testWidgets('AC-ST-MOB-040-3 NAV-01 the rows lead to the tenant switch, the devices, the send queue (MOB-41), the offline settings (MOB-43), the help and the push state', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      world = World();
      final ProviderContainer container = await _signedIn(tester, world, location: '/account');
      for (final ({String label, String path}) row in <({String label, String path})>[
        (label: 'Đổi tổ chức hoặc vai trò', path: '/account/mob-48'),
        (label: 'Thiết bị và đăng xuất', path: '/account/mob-49'),
        (label: 'Hàng đợi gửi', path: '/projects/mob-41'),
        (label: 'Làm việc ngoại tuyến', path: '/projects/mob-43'),
        (label: 'Trợ giúp và phản hồi', path: '/account/mob-50'),
      ]) {
        await tester.ensureVisible(find.text(row.label));
        await tester.tap(find.text(row.label));
        await tester.pumpAndSettle();
        expect(currentLocation(container), row.path);
        if (row.path.startsWith('/projects')) {
          await tester.tap(find.text('Cá nhân'));
          await tester.pumpAndSettle();
        } else {
          await pressBack(tester);
        }
      }
      await tester.ensureVisible(find.text('Thông báo đẩy'));
      await tester.tap(find.text('Thông báo đẩy'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/mob-05');
    });

    testWidgets('turning the unlock on needs the phone to have one and the person to pass the prompt; off needs nothing', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      world = World();
      await _signedIn(tester, world, location: '/account');
      await tester.ensureVisible(find.byType(Switch).first);

      world.biometrics.available = false;
      await tester.tap(find.byType(Switch).first);
      await tester.pumpAndSettle();
      expect(find.text('Máy này chưa cài sinh trắc học hoặc mã khóa màn hình.'), findsOneWidget);
      expect(await world.vault.biometricUnlock(), isFalse);

      world.biometrics.available = true;
      world.biometrics.answer = false;
      await tester.tap(find.byType(Switch).first);
      await tester.pumpAndSettle();
      expect(find.textContaining('Chưa bật được'), findsOneWidget);
      expect(await world.vault.biometricUnlock(), isFalse);
      expect(world.biometrics.prompts, <String>['Bật mở khóa Hệ thống quản lý đầu tư công bằng sinh trắc học']);

      world.biometrics.answer = true;
      await tester.tap(find.byType(Switch).first);
      await tester.pumpAndSettle();
      expect(await world.vault.biometricUnlock(), isTrue);
      expect(tester.widget<SwitchListTile>(find.byType(SwitchListTile)).value, isTrue);

      await tester.tap(find.byType(Switch).first);
      await tester.pumpAndSettle();
      expect(await world.vault.biometricUnlock(), isFalse);
    });

    testWidgets('the unlock says it is neither a signature nor an approval', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      world = World();
      await _signedIn(tester, world, location: '/account');
      expect(find.textContaining('Nó không thay cho chữ ký hay phê duyệt'), findsOneWidget);
    });

    testWidgets('a read-only session says so', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      world = World(memberships: <String, List<FakeMembership>>{
        'sub-ana': <FakeMembership>[const FakeMembership('tenant-a', 'UBND Minh Hà', 'm-a1', 'LEADER', mode: 'READ_ONLY')],
      });
      await _signedIn(tester, world, location: '/account');
      expect(find.textContaining('chế độ chỉ đọc'), findsOneWidget);
    });

    testWidgets('every state of the profile: loading, error with retry, ended session, denied, time-out, offline', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      Future<ProviderContainer> open(void Function(World w) arrange) async {
        world = World();
        arrange(world);
        return _signedIn(tester, world, location: '/account');
      }

      await open((World w) {
        w.api.profileFailureStatus = 500;
        w.api.profileFailureCode = 'INTERNAL_ERROR';
      });
      expect(find.text('Chưa thể tải dữ liệu'), findsOneWidget, reason: 'error');
      world.api.profileFailureStatus = 0;
      await tester.tap(find.text('Thử lại'));
      await tester.pumpAndSettle();
      expect(find.text('Ana'), findsOneWidget, reason: 'retry');

      await open((World w) {
        w.api.profileFailureStatus = 403;
        w.api.profileFailureCode = 'SCOPE_DENIED';
      });
      expect(find.text('Bạn chưa có quyền truy cập'), findsOneWidget, reason: 'denied');
      await open((World w) {
        w.api.profileFailureStatus = 422;
        w.api.profileFailureCode = 'LICENSE_EXPIRED';
      });
      expect(find.text('License đã hết hạn'), findsOneWidget, reason: 'expired licence');
    });

    testWidgets('UI-MOB-47 screen contract at the three devices and at 200 percent text', (WidgetTester tester) async {
      await expectScreenContract(tester, () async {
        world = World();
        await _signedIn(tester, world, location: '/account');
        expect(find.text('Ana'), findsOneWidget);
      });
    });
  });

  group('TK-MOB-027-2 UI-MOB-47 the account leads to the search on the phone (MOB-51)', () {
    testWidgets('a row of the account opens the search, which the story ST-MOB-027 implements', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      world = World();
      final ProviderContainer container = await _signedIn(tester, world, location: '/account');

      await tester.ensureVisible(find.text('Tìm kiếm trong hệ thống'));
      await tester.tap(find.text('Tìm kiếm trong hệ thống'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/account/mob-51');
    });
  });
}

/// The application with a person already signed in to tenant A (the stored session is restored at start).
Future<ProviderContainer> _signedIn(
  WidgetTester tester,
  World world, {
  required String location,
  _Pending? pending,
  FakePermissions? phone,
  void Function(World world)? afterSeed,
  String tenantId = 'tenant-a',
}) async {
  final AuthService seed = world.service();
  await seed.signIn(kOidcConfig);
  if (seed.snapshot.status != SessionStatus.signedIn) {
    await seed.selectContext((await seed.candidates()).firstWhere((MembershipChoice c) => c.tenantId == tenantId));
  }
  afterSeed?.call(world);
  return _pumpAccount(tester, world, location: location, pending: pending, phone: phone);
}

/// Scripts the list of memberships of the fake API from the calls made so far on: what the application asks next fails or waits.
class ApiProbe {
  ApiProbe(this._api);

  final FakeApi _api;

  void failFromNow(int status, String code, {bool unreachable = false}) {
    _api
      ..candidatesFailAfter = _api.candidateCalls
      ..candidatesFailureStatus = status
      ..candidatesFailureCode = code
      ..candidatesUnreachable = unreachable;
  }

  void holdFromNow(Future<void> gate) {
    _api
      ..candidatesHold = gate
      ..candidatesHoldAfter = _api.candidateCalls;
  }
}
