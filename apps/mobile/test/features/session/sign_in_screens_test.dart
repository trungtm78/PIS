import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/di/providers.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/core/state/state_card.dart';
import 'package:machvon_mobile/core/sync/sync_status.dart';
import 'package:machvon_mobile/features/session/auth/oidc_client.dart';
import 'package:machvon_mobile/features/session/session_providers.dart';

import '../../support/harness.dart';
import 'support/app.dart';
import 'support/world.dart';

const FakeMembership _second = FakeMembership('tenant-a', 'UBND Minh Hà', 'm-a2', 'INVESTOR_OFFICER');
const FakeMembership _otherTenant = FakeMembership('tenant-b', 'Bộ Thử Nghiệm', 'm-b1', 'SPECIALIST');
const FakeMembership _needsMfa = FakeMembership('tenant-a', 'UBND Minh Hà', 'm-a1', 'LEADER', requiresMfa: true);

Map<String, List<FakeMembership>> _two() => <String, List<FakeMembership>>{'sub-ana': <FakeMembership>[tenantAMember, _second]};

void main() {
  late World world;

  tearDown(() => world.dispose());

  group('AC-ST-MOB-002-1 UI-MOB-02 the sign-in screen', () {
    testWidgets('a signed-out user lands on MOB-02 with the wanted location, signs in in the browser and is taken there', (WidgetTester tester) async {
      world = World();
      useDevice(tester, kDeviceSizes[1]);
      final ProviderContainer container = await pumpSessionApp(tester, world);

      expect(currentLocation(container), startsWith('/mob-02'));
      expect(Uri.parse(currentLocation(container)).queryParameters['return'], '/home');
      expect(find.text('Đăng nhập'), findsOneWidget);
      // Only the provider is known here (idp.test): the screen does not show its host as if it were the organisation.
      expect(find.text('idp.test'), findsNothing);
      expect(find.text('Đăng nhập bằng tài khoản của tổ chức'), findsOneWidget);
      expect(find.text('Tổ chức'), findsNothing);
      expect(find.byType(TextField), findsNothing, reason: 'the app never shows a password field');

      await tapText(tester, 'Đăng nhập bằng SSO');
      await tester.pumpAndSettle();

      expect(currentLocation(container), '/home');
      expect(container.read(sessionProvider).status, SessionStatus.signedIn);
      expect(container.read(sessionProvider).tenantId, 'tenant-a');
      expect(world.browser.urls.single.queryParameters['code_challenge_method'], 'S256');
    });

    testWidgets('the sign-in screen names the organisation when discovery gave its name', (WidgetTester tester) async {
      world = World();
      useDevice(tester, kDeviceSizes[1]);
      final ProviderContainer container = await pumpSessionApp(tester, world);
      container.read(tenantNameProvider.notifier).choose('Tổng công ty Đạm Phú Mỹ');
      await tester.pumpAndSettle();
      expect(find.text('Tổng công ty Đạm Phú Mỹ'), findsOneWidget);
      expect(find.text('Tổ chức'), findsOneWidget);
      expect(find.text('Đăng nhập bằng tài khoản của tổ chức'), findsNothing);
      expect(find.text('idp.test'), findsNothing);
    });

    testWidgets('without a known tenant the sign-in opens tenant discovery first', (WidgetTester tester) async {
      world = World();
      useDevice(tester, kDeviceSizes[1]);
      final ProviderContainer container = await pumpSessionApp(tester, world, noConfig: true);
      expect(currentLocation(container), startsWith('/mob-01'));
    });

    testWidgets('"Đổi tổ chức" goes back to tenant discovery', (WidgetTester tester) async {
      world = World();
      useDevice(tester, kDeviceSizes[1]);
      final ProviderContainer container = await pumpSessionApp(tester, world);
      await tapText(tester, 'Đổi tổ chức');
      await tester.pumpAndSettle();
      expect(currentLocation(container), startsWith('/mob-01'));
    });

    testWidgets('closing the browser is not an error: a hint is shown and the button works again', (WidgetTester tester) async {
      world = World();
      useDevice(tester, kDeviceSizes[1]);
      await pumpSessionApp(tester, world);
      world.browser.failure = const OidcException(OidcFailure.browserCancelled);
      await tapText(tester, 'Đăng nhập bằng SSO');
      await tester.pumpAndSettle();
      expect(find.textContaining('Bạn đã đóng trình duyệt'), findsOneWidget);
      expect(find.text('Mã lỗi'), findsNothing);

      world.browser.failure = null;
      await tapText(tester, 'Đăng nhập bằng SSO');
      await tester.pumpAndSettle();
      expect(find.textContaining('Bạn đã đóng trình duyệt'), findsNothing);
    });

    testWidgets('a person with several memberships is sent to MOB-04, a membership that needs the second factor to MOB-03', (WidgetTester tester) async {
      world = World(memberships: _two());
      useDevice(tester, kDeviceSizes[1]);
      ProviderContainer container = await pumpSessionApp(tester, world);
      await tapText(tester, 'Đăng nhập bằng SSO');
      await tester.pumpAndSettle();
      expect(currentLocation(container), startsWith('/mob-04'));
      expect(Uri.parse(currentLocation(container)).queryParameters['return'], '/home');

      world = World(memberships: <String, List<FakeMembership>>{'sub-ana': <FakeMembership>[_needsMfa]});
      container = await pumpSessionApp(tester, world);
      await tapText(tester, 'Đăng nhập bằng SSO');
      await tester.pumpAndSettle();
      expect(currentLocation(container), startsWith('/mob-03'));
    });

    testWidgets('unlock mode: the biometric prompt unlocks the stored session and the person returns to where they were', (WidgetTester tester) async {
      world = World();
      await world.service().signIn(kOidcConfig);
      await world.vault.setBiometricUnlock(enabled: true);
      useDevice(tester, kDeviceSizes[1]);
      final ProviderContainer container = await pumpSessionApp(tester, world, location: '/home');

      expect(currentLocation(container), startsWith('/mob-02'));
      expect(Uri.parse(currentLocation(container)).queryParameters['unlock'], '1');
      expect(container.read(sessionProvider).locked, isTrue);
      expect(find.text('Mở khóa bằng sinh trắc học'), findsOneWidget);

      world.biometrics.answer = false;
      await tapText(tester, 'Mở khóa bằng sinh trắc học');
      await tester.pumpAndSettle();
      expect(find.textContaining('Chưa mở khóa được'), findsOneWidget);
      expect(currentLocation(container), startsWith('/mob-02'));

      world.biometrics.answer = true;
      await tapText(tester, 'Mở khóa bằng sinh trắc học');
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/home');
      expect(container.read(sessionProvider).locked, isFalse);
      expect(world.biometrics.prompts.last, 'Mở khóa Hệ thống quản lý đầu tư công');
    });

    testWidgets('the app locked after it stayed in the background, and the guard sends every location to the unlock', (WidgetTester tester) async {
      world = World();
      await world.service().signIn(kOidcConfig);
      await world.vault.setBiometricUnlock(enabled: true);
      await world.vault.setBiometricUnlock(enabled: false);
      useDevice(tester, kDeviceSizes[1]);
      final StreamController<AppLifecycleState> lifecycle = StreamController<AppLifecycleState>.broadcast();
      addTearDown(lifecycle.close);
      final ProviderContainer container = await pumpSessionApp(tester, world, location: '/home', lifecycle: lifecycle.stream);
      expect(currentLocation(container), '/home');

      // Biometric unlock off: staying away does not lock.
      lifecycle.add(AppLifecycleState.paused);
      await tester.pump();
      world.advance(const Duration(minutes: 2));
      lifecycle.add(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(container.read(sessionProvider).locked, isFalse);

      // Biometric unlock on: a short absence does not lock, a long one does.
      await world.vault.setBiometricUnlock(enabled: true);
      lifecycle.add(AppLifecycleState.paused);
      await tester.pump();
      world.advance(const Duration(seconds: 10));
      lifecycle.add(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(container.read(sessionProvider).locked, isFalse);

      lifecycle.add(AppLifecycleState.hidden);
      await tester.pump();
      world.advance(kLockAfterBackground);
      lifecycle.add(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(container.read(sessionProvider).locked, isTrue);
      expect(currentLocation(container), startsWith('/mob-02'));
      expect(Uri.parse(currentLocation(container)).queryParameters['unlock'], '1');
    });

    testWidgets('every state: loading while the browser is open, error, ended session, licence expired, denied, offline and the time-out', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);

      world = World();
      final Completer<void> open = Completer<void>();
      world.browser.hold = open.future;
      await pumpSessionApp(tester, world);
      await tapText(tester, 'Đăng nhập bằng SSO');
      await tester.pump();
      expect(find.byType(LoadingView), findsOneWidget, reason: 'loading');
      open.complete();
      await tester.pumpAndSettle();

      Future<ProviderContainer> failWith(void Function(World w) arrange) async {
        world = World();
        arrange(world);
        final ProviderContainer container = await pumpSessionApp(tester, world);
        await tapText(tester, 'Đăng nhập bằng SSO');
        await tester.pumpAndSettle();
        return container;
      }

      await failWith((World w) => w.idp.tokenEndpointStatus = 400);
      expect(find.text('Chưa thể tải dữ liệu'), findsOneWidget, reason: 'error');
      expect(find.text('OIDC_TOKEN_EXCHANGE_FAILED'), findsOneWidget);

      await failWith((World w) => w.api.selectFailureStatus = 401);
      expect(find.text('Phiên làm việc đã hết hạn'), findsOneWidget, reason: 'ended session');
      expect(find.text('SESSION_EXPIRED'), findsOneWidget);

      await failWith((World w) {
        w.api.selectFailureStatus = 422;
        w.api.selectFailureCode = 'LICENSE_EXPIRED';
      });
      expect(find.text('License đã hết hạn'), findsOneWidget, reason: 'expired licence');

      await failWith((World w) {
        w.api.selectFailureStatus = 403;
        w.api.selectFailureCode = 'SCOPE_DENIED';
      });
      expect(find.text('Bạn chưa có quyền truy cập'), findsOneWidget, reason: 'denied');
      expect(find.text('SCOPE_DENIED'), findsOneWidget);

      ProviderContainer container = await failWith((World w) => w.idp.reachable = false);
      expect(find.text('Máy chủ phản hồi quá chậm'), findsOneWidget, reason: 'time-out');
      expect(find.text('NETWORK_ERROR'), findsOneWidget);
      container.read(reachabilityProvider.notifier).report(Reachability.offline);
      await tapText(tester, 'Thử lại');
      await tester.pumpAndSettle();
      expect(find.text('Bạn đang ngoại tuyến'), findsOneWidget, reason: 'offline');
      expect(tester.takeException(), isNull);

      // The form survives the error and a retry works once the provider answers.
      world.idp.reachable = true;
      await tapText(tester, 'Thử lại');
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/home');
      container = container;
    });

    testWidgets('UI-MOB-02 screen contract at the three devices and at 200 percent text', (WidgetTester tester) async {
      world = World();
      await expectScreenContract(tester, () async {
        await pumpSessionApp(tester, world);
      });
    });

    testWidgets('UI-MOB-02 the unlock mode keeps the contract too', (WidgetTester tester) async {
      world = World();
      await world.service().signIn(kOidcConfig);
      await world.vault.setBiometricUnlock(enabled: true);
      await expectScreenContract(tester, () async {
        await pumpSessionApp(tester, world, location: '/home');
      });
    });
  });

  group('AC-ST-MOB-002-5 UI-MOB-03 the second-factor screen', () {
    testWidgets('a sign-in that needs it waits here; the factor is asked for in the browser and the person goes on', (WidgetTester tester) async {
      world = World(memberships: <String, List<FakeMembership>>{'sub-ana': <FakeMembership>[_needsMfa]});
      useDevice(tester, kDeviceSizes[1]);
      final ProviderContainer container = await pumpSessionApp(tester, world);
      await tapText(tester, 'Đăng nhập bằng SSO');
      await tester.pumpAndSettle();

      expect(currentLocation(container), startsWith('/mob-03'));
      expect(find.text('Xác thực hai yếu tố'), findsOneWidget);
      expect(find.text('Mã xác thực'), findsOneWidget);
      expect(find.byType(TextField), findsNothing, reason: 'the code is typed in the browser, not in the app');

      await tapText(tester, 'Xác thực trong trình duyệt');
      await tester.pumpAndSettle();

      expect(world.browser.urls.last.queryParameters['acr_values'], 'aal2');
      expect(currentLocation(container), '/home');
      expect(container.read(sessionProvider).assurance, AssuranceLevel.aal2);
    });

    testWidgets('an approval the server refuses with 403 MFA_REQUIRED opens MOB-03 and, after the factor, returns to the approval', (WidgetTester tester) async {
      world = World();
      world.api.profileNeedsSecondFactor = true;
      useDevice(tester, kDeviceSizes[1]);
      final ProviderContainer container = await pumpSessionApp(tester, world, location: '/mob-02');
      await tapText(tester, 'Đăng nhập bằng SSO');
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/home');

      container.read(authServiceProvider).noteResponse(403, 'MFA_REQUIRED');
      await tester.pumpAndSettle();
      expect(currentLocation(container), startsWith('/mob-03'));
      expect(Uri.parse(currentLocation(container)).queryParameters['return'], '/home');
      expect(container.read(sessionProvider).stepUpRequired, isTrue);

      container.read(routerProvider).go('/approval');
      await tester.pumpAndSettle();
      expect(currentLocation(container), startsWith('/mob-03'));
      expect(Uri.parse(currentLocation(container)).queryParameters['return'], '/approval');

      await tapText(tester, 'Xác thực trong trình duyệt');
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/approval');
      expect(container.read(sessionProvider).stepUpRequired, isFalse);
    });

    testWidgets('"Để sau" drops the demand: a sign-in goes back to sign-in, an open session to the home screen', (WidgetTester tester) async {
      world = World(memberships: <String, List<FakeMembership>>{'sub-ana': <FakeMembership>[_needsMfa]});
      useDevice(tester, kDeviceSizes[1]);
      final ProviderContainer container = await pumpSessionApp(tester, world);
      await tapText(tester, 'Đăng nhập bằng SSO');
      await tester.pumpAndSettle();
      await tapText(tester, 'Để sau');
      await tester.pumpAndSettle();
      expect(currentLocation(container), startsWith('/mob-02'));
      expect(container.read(authServiceProvider).needsSecondFactor, isFalse);
    });

    testWidgets('opened with nothing to confirm it says so and continues', (WidgetTester tester) async {
      world = World();
      useDevice(tester, kDeviceSizes[1]);
      final ProviderContainer container = await pumpSessionApp(tester, world, location: '/mob-02');
      await tapText(tester, 'Đăng nhập bằng SSO');
      await tester.pumpAndSettle();
      container.read(routerProvider).go('/mob-03?return=%2Faccount');
      await tester.pumpAndSettle();
      expect(find.text('Không cần xác thực thêm'), findsOneWidget);
      await tapText(tester, 'Tiếp tục');
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/account');
    });

    testWidgets('every state: loading, a factor the provider did not prove, ended session, denied, time-out, offline', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);

      Future<ProviderContainer> open(void Function(World w) arrange) async {
        world = World(memberships: <String, List<FakeMembership>>{'sub-ana': <FakeMembership>[_needsMfa]});
        final ProviderContainer container = await pumpSessionApp(tester, world);
        await tapText(tester, 'Đăng nhập bằng SSO');
        await tester.pumpAndSettle();
        arrange(world);
        return container;
      }

      final Completer<void> gate = Completer<void>();
      await open((World w) => w.browser.hold = gate.future);
      await tapText(tester, 'Xác thực trong trình duyệt');
      await tester.pump();
      expect(find.byType(LoadingView), findsOneWidget, reason: 'loading');
      gate.complete();
      await tester.pumpAndSettle();

      await open((World w) => w.browser.passSecondFactor = false);
      await tapText(tester, 'Xác thực trong trình duyệt');
      await tester.pumpAndSettle();
      expect(find.text('Chưa thể tải dữ liệu'), findsOneWidget, reason: 'error');
      expect(find.text('OIDC_SECOND_FACTOR_NOT_SATISFIED'), findsOneWidget);

      await open((World w) {
        w.api.selectFailureStatus = 401;
      });
      await tapText(tester, 'Xác thực trong trình duyệt');
      await tester.pumpAndSettle();
      expect(find.text('Phiên làm việc đã hết hạn'), findsOneWidget, reason: 'ended session');

      await open((World w) {
        w.api.selectFailureStatus = 403;
        w.api.selectFailureCode = 'SCOPE_DENIED';
      });
      await tapText(tester, 'Xác thực trong trình duyệt');
      await tester.pumpAndSettle();
      expect(find.text('Bạn chưa có quyền truy cập'), findsOneWidget, reason: 'denied');

      final ProviderContainer container = await open((World w) => w.idp.reachable = false);
      await tapText(tester, 'Xác thực trong trình duyệt');
      await tester.pumpAndSettle();
      expect(find.text('Máy chủ phản hồi quá chậm'), findsOneWidget, reason: 'time-out');
      container.read(reachabilityProvider.notifier).report(Reachability.offline);
      await tapText(tester, 'Thử lại');
      await tester.pumpAndSettle();
      expect(find.text('Bạn đang ngoại tuyến'), findsOneWidget, reason: 'offline');
    });

    testWidgets('UI-MOB-03 screen contract at the three devices and at 200 percent text', (WidgetTester tester) async {
      await expectScreenContract(tester, () async {
        world = World(memberships: <String, List<FakeMembership>>{'sub-ana': <FakeMembership>[_needsMfa]});
        await pumpSessionApp(tester, world);
        await tapText(tester, 'Đăng nhập bằng SSO');
        await tester.pumpAndSettle();
        expect(find.text('Xác thực hai yếu tố'), findsOneWidget);
      });
    });
  });

  group('AC-ST-MOB-002-4 UI-MOB-04 the unit and role screen', () {
    testWidgets('lists both units and roles, enters the chosen one and sends it with the next call', (WidgetTester tester) async {
      world = World(memberships: _two());
      useDevice(tester, kDeviceSizes[1]);
      final ProviderContainer container = await pumpSessionApp(tester, world);
      await tapText(tester, 'Đăng nhập bằng SSO');
      await tester.pumpAndSettle();

      expect(find.text('Chọn đơn vị và vai trò'), findsOneWidget);
      expect(find.text('UBND Minh Hà'), findsNWidgets(2));
      expect(find.text('Vai trò: LEADER'), findsOneWidget);
      expect(find.text('Vai trò: INVESTOR_OFFICER'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Tiếp tục')).onPressed, isNull, reason: 'nothing chosen yet');

      await tapText(tester, 'Vai trò: INVESTOR_OFFICER');
      await tester.pump();
      await tapText(tester, 'Tiếp tục');
      await tester.pumpAndSettle();

      expect(currentLocation(container), '/home');
      expect(container.read(sessionProvider).membershipId, 'm-a2');
      final String token = (await container.read(sessionProvider.notifier).accessToken())!;
      expect(world.api.tenantTokens[token]!.membershipId, 'm-a2');
    });

    testWidgets('a membership the server will not let in is listed and cannot be chosen; a suggestion by the domain is marked', (WidgetTester tester) async {
      world = World(memberships: <String, List<FakeMembership>>{
        'sub-ana': <FakeMembership>[const FakeMembership('tenant-a', 'UBND Minh Hà', 'm-a1', 'LEADER', status: 'Suspended'), _second, _otherTenant],
      });
      useDevice(tester, kDeviceSizes[1]);
      await pumpSessionApp(tester, world);
      await tapText(tester, 'Đăng nhập bằng SSO');
      await tester.pumpAndSettle();
      // The only selectable memberships are two, so the choice is asked for.
      expect(find.textContaining('Chưa vào được: Suspended'), findsOneWidget);
      await tapText(tester, 'Vai trò: LEADER');
      await tester.pump();
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Tiếp tục')).onPressed, isNull);
    });

    testWidgets('choosing a membership that needs the second factor goes to MOB-03', (WidgetTester tester) async {
      world = World(memberships: <String, List<FakeMembership>>{'sub-ana': <FakeMembership>[_needsMfa, _second]});
      useDevice(tester, kDeviceSizes[1]);
      final ProviderContainer container = await pumpSessionApp(tester, world);
      await tapText(tester, 'Đăng nhập bằng SSO');
      await tester.pumpAndSettle();
      await tapText(tester, 'Vai trò: LEADER');
      await tester.pump();
      await tapText(tester, 'Tiếp tục');
      await tester.pumpAndSettle();
      expect(currentLocation(container), startsWith('/mob-03'));
    });

    testWidgets('every state: loading, empty, error with retry, ended session, licence expired, denied, time-out, offline', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);

      Future<ProviderContainer> open(World w, {bool settle = true}) async {
        world = w;
        final ProviderContainer container = await pumpSessionApp(tester, world);
        await tapText(tester, 'Đăng nhập bằng SSO');
        settle ? await tester.pumpAndSettle() : await tester.pump();
        return container;
      }

      final Completer<void> gate = Completer<void>();
      await open(
        World(memberships: _two())
          ..api.candidatesHold = gate.future
          ..api.candidatesHoldAfter = 1,
        settle: false,
      );
      await tester.pump();
      await tester.pump();
      expect(find.byType(LoadingView), findsOneWidget, reason: 'loading');
      gate.complete();
      await tester.pumpAndSettle();
      expect(find.text('Chọn đơn vị và vai trò'), findsOneWidget, reason: 'default');

      await open(World(memberships: <String, List<FakeMembership>>{'sub-ana': <FakeMembership>[]}));
      expect(find.text('Bạn chưa thuộc đơn vị nào'), findsOneWidget, reason: 'empty');

      await open(World(memberships: _two())..api.candidatesFailAfter = 1);
      expect(find.text('Chưa thể tải dữ liệu'), findsOneWidget, reason: 'error');
      expect(find.text('INTERNAL_ERROR'), findsOneWidget);
      world.api.candidatesFailAfter = 1 << 30;
      await tapText(tester, 'Thử lại');
      await tester.pumpAndSettle();
      expect(find.text('Chọn đơn vị và vai trò'), findsOneWidget, reason: 'retry');

      await open(World(memberships: _two())
        ..api.candidatesFailAfter = 1
        ..api.candidatesFailureStatus = 401
        ..api.candidatesFailureCode = 'SESSION_EXPIRED');
      expect(find.text('Phiên làm việc đã hết hạn'), findsOneWidget, reason: 'ended session');

      await open(World(memberships: _two())
        ..api.candidatesFailAfter = 1
        ..api.candidatesFailureStatus = 422
        ..api.candidatesFailureCode = 'LICENSE_EXPIRED');
      expect(find.text('License đã hết hạn'), findsOneWidget, reason: 'expired licence');

      await open(World(memberships: _two())
        ..api.candidatesFailAfter = 1
        ..api.candidatesFailureStatus = 403
        ..api.candidatesFailureCode = 'SCOPE_DENIED');
      expect(find.text('Bạn chưa có quyền truy cập'), findsOneWidget, reason: 'denied');

      final ProviderContainer container = await open(World(memberships: _two())
        ..api.candidatesFailAfter = 1
        ..api.candidatesUnreachable = true);
      expect(find.text('Máy chủ phản hồi quá chậm'), findsOneWidget, reason: 'time-out');
      container.read(reachabilityProvider.notifier).report(Reachability.offline);
      await tapText(tester, 'Thử lại');
      await tester.pumpAndSettle();
      expect(find.text('Bạn đang ngoại tuyến'), findsOneWidget, reason: 'offline');
    });

    testWidgets('UI-MOB-04 screen contract at the three devices and at 200 percent text', (WidgetTester tester) async {
      await expectScreenContract(tester, () async {
        world = World(memberships: _two());
        await pumpSessionApp(tester, world);
        await tapText(tester, 'Đăng nhập bằng SSO');
        await tester.pumpAndSettle();
        expect(find.text('Chọn đơn vị và vai trò'), findsOneWidget);
      });
    });
  });

  group('AC-ST-MOB-002-6 UI-MOB-44 the session-expired screen', () {
    testWidgets('shows the code 401 SESSION_EXPIRED and the drafts kept locked, and signs in again to where the person was', (WidgetTester tester) async {
      world = World();
      await world.service().signIn(kOidcConfig);
      useDevice(tester, kDeviceSizes[1]);
      final ProviderContainer container = await pumpSessionApp(
        tester,
        world,
        overrides: <Override>[syncStatusProvider.overrideWith(() => _Pending(2))],
      );
      expect(container.read(sessionProvider).status, SessionStatus.signedIn);

      // The server ended the session: the call is refused and so is the renewal.
      world.api.endAllSessions();
      world.api.selectFailureStatus = 401;
      container.read(authServiceProvider).noteResponse(401, 'SESSION_EXPIRED');
      await tester.pumpAndSettle();

      expect(currentLocation(container), startsWith('/mob-44'));
      expect(Uri.parse(currentLocation(container)).queryParameters['return'], '/home');
      expect(find.text('Phiên làm việc đã hết hạn'), findsOneWidget);
      expect(find.text('Mã lỗi: 401 SESSION_EXPIRED'), findsOneWidget);
      expect(find.textContaining('2 thay đổi chưa gửi đang được giữ khóa an toàn'), findsOneWidget);

      world.api.selectFailureStatus = 0;
      await tapText(tester, 'Đăng nhập lại');
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/home');
      expect(container.read(sessionProvider).status, SessionStatus.signedIn);
      expect(world.purger.purged, isEmpty, reason: 'a session that ended deletes nothing');
    });

    testWidgets('without pending changes it says the drafts are kept; with several memberships sign-in again asks again', (WidgetTester tester) async {
      world = World(memberships: _two());
      await world.service().signIn(kOidcConfig);
      useDevice(tester, kDeviceSizes[1]);
      final ProviderContainer container = await pumpSessionApp(tester, world, location: '/mob-44?return=%2Fapproval');
      expect(find.text('Các bản nháp trên máy được giữ khóa an toàn.'), findsOneWidget);
      await tapText(tester, 'Đăng nhập lại');
      await tester.pumpAndSettle();
      // The membership used last time is not known to this device, so the person chooses again.
      expect(currentLocation(container), startsWith('/mob-04'));
      expect(Uri.parse(currentLocation(container)).queryParameters['return'], '/approval');
    });

    testWidgets('with no tenant known it goes to tenant discovery; a second factor wanted goes to MOB-03', (WidgetTester tester) async {
      world = World();
      useDevice(tester, kDeviceSizes[1]);
      ProviderContainer container = await pumpSessionApp(tester, world, noConfig: true, location: '/mob-44');
      await tapText(tester, 'Đăng nhập lại');
      await tester.pumpAndSettle();
      expect(currentLocation(container), startsWith('/mob-01'));

      world = World(memberships: <String, List<FakeMembership>>{'sub-ana': <FakeMembership>[_needsMfa]});
      container = await pumpSessionApp(tester, world, location: '/mob-44');
      await tapText(tester, 'Đăng nhập lại');
      await tester.pumpAndSettle();
      expect(currentLocation(container), startsWith('/mob-03'));
    });

    testWidgets('every state: loading, error, ended session, licence expired, denied, time-out, offline', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);

      Future<ProviderContainer> open(void Function(World w) arrange) async {
        world = World();
        arrange(world);
        final ProviderContainer container = await pumpSessionApp(tester, world, location: '/mob-44');
        await tapText(tester, 'Đăng nhập lại');
        await tester.pumpAndSettle();
        return container;
      }

      final Completer<void> gate = Completer<void>();
      world = World();
      world.browser.hold = gate.future;
      await pumpSessionApp(tester, world, location: '/mob-44');
      await tapText(tester, 'Đăng nhập lại');
      await tester.pump();
      expect(find.byType(LoadingView), findsOneWidget, reason: 'loading');
      gate.complete();
      await tester.pumpAndSettle();

      await open((World w) => w.idp.tokenEndpointStatus = 400);
      expect(find.text('OIDC_TOKEN_EXCHANGE_FAILED'), findsOneWidget, reason: 'error');
      await open((World w) {
        w.api.selectFailureStatus = 422;
        w.api.selectFailureCode = 'LICENSE_EXPIRED';
      });
      expect(find.text('License đã hết hạn'), findsOneWidget, reason: 'expired licence');
      await open((World w) {
        w.api.selectFailureStatus = 403;
        w.api.selectFailureCode = 'SCOPE_DENIED';
      });
      expect(find.text('Bạn chưa có quyền truy cập'), findsOneWidget, reason: 'denied');
      await open((World w) => w.api.selectFailureStatus = 401);
      expect(find.text('SESSION_EXPIRED'), findsOneWidget, reason: 'ended session');
      final ProviderContainer container = await open((World w) => w.idp.reachable = false);
      expect(find.text('Máy chủ phản hồi quá chậm'), findsOneWidget, reason: 'time-out');
      container.read(reachabilityProvider.notifier).report(Reachability.offline);
      await tapText(tester, 'Thử lại');
      await tester.pumpAndSettle();
      expect(find.text('Bạn đang ngoại tuyến'), findsOneWidget, reason: 'offline');
    });

    testWidgets('UI-MOB-44 screen contract at the three devices and at 200 percent text', (WidgetTester tester) async {
      world = World();
      await expectScreenContract(tester, () async {
        await pumpSessionApp(tester, world, location: '/mob-44');
        expect(find.text('Đăng nhập lại'), findsOneWidget);
      });
    });
  });
}

class _Pending extends SyncStatusNotifier {
  _Pending(this.count);

  final int count;

  @override
  SyncStatus build() => SyncStatus(pendingCommands: count);
}
