import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/di/providers.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/navigation/route_table.dart';
import 'package:machvon_mobile/core/state/state_card.dart';
import 'package:machvon_mobile/features/permissions/permission_providers.dart';
import 'package:machvon_mobile/features/permissions/permission_service.dart';
import 'package:machvon_mobile/features/permissions/permissions_feature.dart' as permissions;
import 'package:machvon_mobile/features/permissions/problem_routing.dart';
import 'package:machvon_mobile/features/session/session_providers.dart';
import 'package:permission_handler_platform_interface/permission_handler_platform_interface.dart';
import 'package:plugin_platform_interface/plugin_platform_interface.dart';

import '../../support/harness.dart';
import '../session/support/app.dart' show expectScreenContract;
import '../session/support/world.dart' show MemorySecureStore;

/// The phone: what each permission is now, what the prompt would answer, and what was asked.
class FakePermissions implements PermissionPlatform {
  final Map<AppPermission, PermissionState> now = <AppPermission, PermissionState>{
    for (final AppPermission p in AppPermission.values) p: PermissionState.denied,
  };
  final Map<AppPermission, PermissionState> promptAnswer = <AppPermission, PermissionState>{
    for (final AppPermission p in AppPermission.values) p: PermissionState.granted,
  };
  final List<AppPermission> prompts = <AppPermission>[];
  int settingsOpened = 0;
  Object? failure;
  Future<void>? hold;

  @override
  Future<PermissionState> status(AppPermission permission) async {
    await hold;
    final Object? error = failure;
    if (error != null) throw error;
    return now[permission]!;
  }

  @override
  Future<PermissionState> request(AppPermission permission) async {
    prompts.add(permission);
    final PermissionState answer = promptAnswer[permission]!;
    now[permission] = answer;
    return answer;
  }

  @override
  Future<bool> openSettings() async {
    settingsOpened += 1;
    return true;
  }
}

/// A screen of a feature that needs the camera, as MOB-28 will be: it asks through `requestPermissions` and shows how it ended.
class _CameraHost extends ConsumerStatefulWidget {
  const _CameraHost();

  @override
  ConsumerState<_CameraHost> createState() => _CameraHostState();
}

class _CameraHostState extends ConsumerState<_CameraHost> {
  String result = 'idle';

  Future<void> _capture(List<AppPermission> needed) async {
    final PermissionOutcome outcome = await requestPermissions(context, ref, needed);
    setState(() {
      result = outcome.alternative != null
          ? 'alternative:${outcome.alternative!.name}${outcome.manualLocation == null ? '' : ':${outcome.manualLocation!.text}:${outcome.manualLocation!.source.name}'}'
          : outcome.deferred
              ? 'deferred'
              : needed.every(outcome.isGranted)
                  ? 'granted'
                  : 'refused';
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Column(
        children: <Widget>[
          Text('result: $result'),
          TextButton(onPressed: () => _capture(const <AppPermission>[AppPermission.camera]), child: const Text('Chụp ảnh')),
          TextButton(onPressed: () => _capture(const <AppPermission>[AppPermission.location]), child: const Text('Gắn vị trí')),
          TextButton(onPressed: () => _capture(const <AppPermission>[AppPermission.notifications]), child: const Text('Bật nhắc việc')),
        ],
      ),
    );
  }
}

Widget _buildHost(BuildContext context, ScreenContext screen) => const _CameraHost();

const MobileFeature _hostFeature = MobileFeature(id: 'camera_host', screens: <ScreenSpec>[ScreenSpec(screenId: 'MOB-09', builder: _buildHost)]);

Future<ProviderContainer> _pump(WidgetTester tester, FakePermissions phone, {String? location, List<Override> overrides = const <Override>[]}) {
  return pumpApp(
    tester,
    features: <MobileFeature>[permissions.feature, _hostFeature],
    location: location,
    overrides: <Override>[
      permissionPlatformProvider.overrideWithValue(phone),
      secureValueStoreProvider.overrideWithValue(MemorySecureStore()),
      ...overrides,
    ],
  );
}

Future<void> _tap(WidgetTester tester, String text) async {
  await tester.ensureVisible(find.text(text));
  await tester.pump();
  await tester.tap(find.text(text));
  await tester.pumpAndSettle();
}

void main() {
  late FakePermissions phone;

  setUp(() => phone = FakePermissions());

  group('AC-ST-MOB-003-1 UI-MOB-06 TK-MOB-003-1 the rationale comes before the system prompt', () {
    testWidgets('nothing is requested at startup or by browsing; the camera feature shows the rationale first and the prompt only after Allow', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      await _pump(tester, phone, location: '/projects');
      expect(phone.prompts, isEmpty, reason: 'startup');

      await _tap(tester, 'Chụp ảnh');
      expect(find.text('Camera'), findsOneWidget);
      expect(find.text('Vị trí khi dùng ứng dụng'), findsNothing);
      expect(find.textContaining('Ứng dụng chỉ mở camera khi bạn chạm'), findsOneWidget);
      expect(phone.prompts, isEmpty, reason: 'the rationale is shown before the system prompt');

      await _tap(tester, 'Cho phép');
      expect(phone.prompts, <AppPermission>[AppPermission.camera]);
      expect(find.text('Đã cho phép'), findsOneWidget);

      await _tap(tester, 'Xong');
      expect(find.text('result: granted'), findsOneWidget);
    });

    testWidgets('a denial leaves both alternatives: attach a file for the camera, a place by hand for the position', (WidgetTester tester) async {
      phone.promptAnswer[AppPermission.camera] = PermissionState.denied;
      useDevice(tester, kDeviceSizes[1]);
      await _pump(tester, phone, location: '/projects');

      await _tap(tester, 'Chụp ảnh');
      await _tap(tester, 'Cho phép');
      expect(find.text('Đã từ chối'), findsOneWidget);
      expect(find.text('Thử cấp lại'), findsOneWidget);
      expect(find.text('Đính kèm tệp có sẵn trong máy'), findsOneWidget);

      await _tap(tester, 'Đính kèm tệp có sẵn trong máy');
      expect(find.text('result: alternative:attachFile'), findsOneWidget);
    });

    testWidgets('the position can be typed by hand and carries the label "entered by hand"', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      await _pump(tester, phone, location: '/projects');
      await _tap(tester, 'Gắn vị trí');
      expect(find.text('Chụp ảnh'), findsNothing);
      expect(find.text('Camera'), findsNothing);

      await _tap(tester, 'Nhập vị trí thủ công');
      expect(find.textContaining('gắn nhãn “nhập tay”'), findsOneWidget);
      await tester.enterText(find.byType(TextField), 'ab');
      await _tap(tester, 'Dùng vị trí này');
      expect(find.text('Nhập từ 3 đến 200 ký tự.'), findsOneWidget);
      await tester.enterText(find.byType(TextField), 'Km 12 đường 70, xã An Phú');
      await tester.pump();
      expect(find.text('Nhập từ 3 đến 200 ký tự.'), findsNothing);
      await _tap(tester, 'Dùng vị trí này');

      expect(find.text('result: alternative:manualLocation:Km 12 đường 70, xã An Phú:manual'), findsOneWidget);
      expect(phone.prompts, isEmpty, reason: 'typing a place never asks the phone');
    });

    testWidgets('"Để sau" puts the request off and asks the phone nothing; a permission already granted opens no screen', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      await _pump(tester, phone, location: '/projects');
      await _tap(tester, 'Chụp ảnh');
      await _tap(tester, 'Để sau');
      expect(find.text('result: deferred'), findsOneWidget);
      expect(phone.prompts, isEmpty);

      phone.now[AppPermission.camera] = PermissionState.granted;
      await _tap(tester, 'Chụp ảnh');
      expect(find.text('result: granted'), findsOneWidget);
      expect(find.text('Camera'), findsNothing);
    });

    testWidgets('a permission the system blocks for good sends the person to the settings of the phone, and the state is read again on return', (WidgetTester tester) async {
      phone.now[AppPermission.camera] = PermissionState.blocked;
      useDevice(tester, kDeviceSizes[1]);
      await _pump(tester, phone, location: '/projects');
      await _tap(tester, 'Chụp ảnh');
      expect(find.text('Bị chặn trong cài đặt'), findsOneWidget);
      expect(find.text('Cho phép'), findsNothing);
      expect(find.textContaining('Hệ thống không hỏi lại'), findsOneWidget);
      expect(find.text('Đính kèm tệp có sẵn trong máy'), findsOneWidget);

      await _tap(tester, 'Mở cài đặt hệ thống');
      expect(phone.settingsOpened, 1);

      phone.now[AppPermission.camera] = PermissionState.granted;
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(find.text('Đã cho phép'), findsOneWidget);
    });

    testWidgets('both permissions are explained when the screen is opened without a list; unknown names are ignored', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final ProviderContainer container = await _pump(tester, phone, location: '/mob-06');
      expect(find.text('Camera'), findsOneWidget);
      expect(find.text('Vị trí khi dùng ứng dụng'), findsOneWidget);
      container.read(routerProvider).go('/mob-06?need=camera,other,,location');
      await tester.pumpAndSettle();
      expect(find.text('Camera'), findsOneWidget);
      expect(find.text('Vị trí khi dùng ứng dụng'), findsOneWidget);
      container.read(routerProvider).go('/mob-06?need=location&return=%2Faccount');
      await tester.pumpAndSettle();
      expect(find.text('Camera'), findsNothing);
      await _tap(tester, 'Để sau');
      expect(Uri.parse(currentLocation(container)).path, '/account');
    });

    testWidgets('every state: loading, error with retry, not asked, granted, declined, blocked', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final Completer<void> gate = Completer<void>();
      phone.hold = gate.future;
      await _pump(tester, phone, location: '/mob-06');
      expect(find.byType(LoadingView), findsOneWidget, reason: 'loading');
      gate.complete();
      await tester.pumpAndSettle();
      expect(find.text('Chưa cấp'), findsNWidgets(2), reason: 'a permission the phone reports as declined but never asked for is not asked yet');

      phone.hold = null;
      phone.failure = StateError('plugin failed');
      final ProviderContainer container = await _pump(tester, phone, location: '/mob-06');
      expect(find.text('CLIENT_ERROR'), findsOneWidget, reason: 'error');
      phone.failure = null;
      await _tap(tester, 'Thử lại');
      expect(find.text('Chưa cấp'), findsNWidgets(2));

      await container.read(permissionServiceProvider).request(AppPermission.camera);
      phone.now[AppPermission.camera] = PermissionState.denied;
      phone.now[AppPermission.location] = PermissionState.blocked;
      container.read(routerProvider).go('/mob-05');
      await tester.pumpAndSettle();
      container.read(routerProvider).go('/mob-06');
      await tester.pumpAndSettle();
      expect(find.text('Đã từ chối'), findsOneWidget, reason: 'declined once asked');
      expect(find.text('Bị chặn trong cài đặt'), findsOneWidget, reason: 'blocked');
    });

    testWidgets('UI-MOB-06 screen contract at the three devices and at 200 percent text', (WidgetTester tester) async {
      await expectScreenContract(tester, () async {
        await _pump(tester, phone, location: '/mob-06');
        expect(find.text('Quyền camera và vị trí'), findsOneWidget);
      });
    });
  });

  group('AC-ST-MOB-003-2 AC-ST-NOT-006-2 UI-MOB-05 the push state', () {
    testWidgets('denied for good: the state shows blocked with a link to the settings, and in-app notifications still work', (WidgetTester tester) async {
      phone.now[AppPermission.notifications] = PermissionState.blocked;
      useDevice(tester, kDeviceSizes[1]);
      await _pump(tester, phone, location: '/mob-05');

      expect(find.text('Thông báo đẩy'), findsNWidgets(2));
      expect(find.text('Bị chặn trong cài đặt'), findsOneWidget);
      expect(find.text('Mở cài đặt hệ thống'), findsOneWidget);
      expect(find.textContaining('Thông báo trong ứng dụng vẫn hoạt động'), findsOneWidget);
      await _tap(tester, 'Mở cài đặt hệ thống');
      expect(phone.settingsOpened, 1);
      expect(phone.prompts, isEmpty);
    });

    testWidgets('not asked: the benefit is explained and the system prompt comes only from "Bật"; granted shows done', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      await _pump(tester, phone, location: '/mob-05');
      expect(find.textContaining('Biết ngay khi có hồ sơ chờ phê duyệt'), findsOneWidget);
      expect(phone.prompts, isEmpty);
      await _tap(tester, 'Cho phép');
      expect(phone.prompts, <AppPermission>[AppPermission.notifications]);
      expect(find.text('Đã cho phép'), findsOneWidget);
      expect(find.text('Xong'), findsOneWidget);
      expect(find.textContaining('Thông báo trong ứng dụng vẫn hoạt động'), findsNothing);
    });

    testWidgets('a feature that asks for notifications gets MOB-05, with its own title', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      await _pump(tester, phone, location: '/projects');
      await _tap(tester, 'Bật nhắc việc');
      expect(find.text('Thông báo đẩy'), findsNWidgets(2));
      await _tap(tester, 'Để sau');
      expect(find.text('result: deferred'), findsOneWidget);
    });

    testWidgets('UI-MOB-05 screen contract at the three devices and at 200 percent text', (WidgetTester tester) async {
      phone.now[AppPermission.notifications] = PermissionState.blocked;
      await expectScreenContract(tester, () async {
        await _pump(tester, phone, location: '/mob-05');
        expect(find.text('Mở cài đặt hệ thống'), findsOneWidget);
      });
    });
  });

  group('TK-MOB-003-1 the permission service', () {
    test('reads the phone, tells never-asked from declined, and remembers that the prompt was shown', () async {
      final MemorySecureStore store = MemorySecureStore();
      final PermissionService service = PermissionService(platform: phone, ledger: PermissionLedger(store));
      expect(await service.status(AppPermission.camera), PermissionState.notAsked);
      expect(await service.request(AppPermission.camera), PermissionState.granted);
      phone.now[AppPermission.camera] = PermissionState.denied;
      expect(await service.status(AppPermission.camera), PermissionState.denied);
      expect(await service.status(AppPermission.location), PermissionState.notAsked);
      phone.promptAnswer[AppPermission.location] = PermissionState.notAsked;
      expect(await service.request(AppPermission.location), PermissionState.denied);
      expect(await PermissionLedger(store).asked(), <AppPermission>{AppPermission.camera, AppPermission.location});
      expect(await service.openSettings(), isTrue);
    });

    test('a damaged ledger is read as empty', () async {
      final MemorySecureStore store = MemorySecureStore()..data['permissions.v1'] = 'not json';
      expect(await PermissionLedger(store).asked(), isEmpty);
      store.data['permissions.v1'] = '{"a":1}';
      expect(await PermissionLedger(store).asked(), isEmpty);
    });

    test('a place typed by hand: 3 to 200 printable characters, coordinates read when they are a pair on earth', () {
      expect(ManualLocation.tryParse('ab'), isNull);
      expect(ManualLocation.tryParse('a' * 201), isNull);
      expect(ManualLocation.tryParse('bell\u0007'), isNull);
      expect(ManualLocation.tryParse('line\nbreak')!.text, 'line break', reason: 'a pasted line break becomes a space');
      expect(ManualLocation.tryParse('  Cầu   Hòa  Bình ')!.text, 'Cầu Hòa Bình');
      final ManualLocation pair = ManualLocation.tryParse('21.0285, 105.8542')!;
      expect((pair.latitude, pair.longitude), (21.0285, 105.8542));
      expect(pair.source, LocationSource.manual);
      expect(ManualLocation.tryParse('95.0, 10.0')!.latitude, isNull, reason: 'not a point on earth: kept as text');
      expect(ManualLocation.tryParse('45, 190')!.longitude, isNull);
      expect(ManualLocation.tryParse('Km 12')!.latitude, isNull);
    });
  });

  group('AC-ST-MOB-003-3 AC-ST-MOB-003-5 LIC01 UI-MOB-46 the licence expired on the server', () {
    testWidgets('422 LICENSE_EXPIRED opens MOB-46: read access is kept, the code and the reference are shown, support is one tap away', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final ProviderContainer container = await _pump(tester, phone, location: '/projects');
      const ApiError refused = ApiError(status: 422, code: 'LICENSE_EXPIRED', correlationId: '3f2b6c1e-0000-4000-8000-000000000001');
      final String location = errorScreenLocation(container.read(routeTableProvider), refused)!;
      unawaited(container.read(routerProvider).push<void>(location));
      await tester.pumpAndSettle();

      expect(find.text('License đã hết hạn'), findsOneWidget);
      expect(find.text('Hết hạn theo máy chủ'), findsOneWidget);
      expect(find.text('Bạn vẫn xem được dữ liệu'), findsOneWidget);
      expect(find.textContaining('chế độ chỉ đọc'), findsOneWidget);
      expect(find.text('LICENSE_EXPIRED'), findsOneWidget);
      expect(find.text('3f2b6c1e-0000-4000-8000-000000000001'), findsOneWidget);

      await _tap(tester, 'Xem dữ liệu (chỉ đọc)');
      expect(currentLocation(container), '/home');
    });

    testWidgets('"Liên hệ quản trị" opens the help screen for a billing question', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final ProviderContainer container = await _pump(tester, phone, location: '/projects/mob-46');
      await _tap(tester, 'Liên hệ quản trị');
      expect(Uri.parse(currentLocation(container)).queryParameters['category'], 'BILLING');
    });

    test('the decision rests on the code of the server: no clock is read by the code that shows or routes a licence refusal', () {
      for (final String path in <String>[
        'lib/features/permissions/problem_routing.dart',
        'lib/features/permissions/screens/error_screens.dart',
        'lib/features/permissions/permission_service.dart',
      ]) {
        final String source = File(path).readAsStringSync();
        expect(source, isNot(contains('DateTime.now')), reason: path);
        expect(source, isNot(contains('Stopwatch')), reason: path);
      }
    });

    testWidgets('a code in a link that is not a stable code is replaced, and the reference is checked', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final ProviderContainer container = await _pump(tester, phone, location: '/projects/mob-46?code=%3Cscript%3E&cid=x');
      expect(find.text('LICENSE_EXPIRED'), findsOneWidget);
      expect(find.text('x'), findsNothing);
      expect(container, isNotNull);
    });

    testWidgets('every state of the screen holds at the three devices and at 200 percent text (UI-MOB-46)', (WidgetTester tester) async {
      await expectScreenContract(tester, () async {
        await _pump(tester, phone, location: '/projects/mob-46?code=LICENSE_EXPIRED&cid=3f2b6c1e-0000-4000-8000-000000000001');
        expect(find.text('License đã hết hạn'), findsOneWidget);
      });
    });
  });

  group('AC-ST-MOB-003-4 UAT-PLAN-32 UI-MOB-45 a forbidden action', () {
    testWidgets('403 SCOPE_DENIED opens MOB-45 with the reason and the code, and nothing of the protected record', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final ProviderContainer container = await _pump(tester, phone, location: '/projects');
      const ApiError refused = ApiError(
        status: 403,
        code: 'SCOPE_DENIED',
        correlationId: '3f2b6c1e-0000-4000-8000-000000000002',
        detail: 'Hồ sơ R-77 Cầu Hòa Bình 5.000.000.000 đồng thuộc U-BQL2',
      );
      final String location = errorScreenLocation(container.read(routeTableProvider), refused, action: 'approve')!;
      expect(location, isNot(contains('R-77')));
      expect(location, isNot(contains('C%E1%BA%A7u')));
      unawaited(container.read(routerProvider).push<void>(location));
      await tester.pumpAndSettle();

      expect(find.text('Bạn không có quyền thực hiện thao tác này'), findsOneWidget);
      expect(find.textContaining('Phạm vi quyền của bạn không bao gồm nội dung này'), findsOneWidget);
      expect(find.descendant(of: find.byType(StateCard), matching: find.text('Phê duyệt')), findsOneWidget);
      expect(find.text('SCOPE_DENIED'), findsOneWidget);
      expect(find.text('3f2b6c1e-0000-4000-8000-000000000002'), findsOneWidget);
      for (final String leaked in <String>['R-77', 'Cầu Hòa Bình', '5.000.000.000', 'U-BQL2']) {
        expect(find.textContaining(leaked), findsNothing, reason: leaked);
      }

      await _tap(tester, 'Quay lại');
      expect(currentLocation(container), '/projects');
    });

    testWidgets('a link of another tenant arrives without a code and says so; support is opened for an access question', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final ProviderContainer container = await _pump(tester, phone, location: '/projects/mob-45');
      expect(find.textContaining('thuộc một tổ chức khác'), findsOneWidget);
      expect(find.text('TENANT_MISMATCH'), findsOneWidget);
      await _tap(tester, 'Liên hệ quản trị');
      expect(Uri.parse(currentLocation(container)).queryParameters['category'], 'ACCESS');
    });

    testWidgets('a refusal about the plan names the plan, not the person; an unknown action is not printed', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      await _pump(tester, phone, location: '/projects/mob-45?code=ENTITLEMENT_DENIED&action=<b>hack</b>');
      expect(find.textContaining('Gói dịch vụ của tổ chức chưa bao gồm'), findsOneWidget);
      expect(find.text('Thao tác bị từ chối:'), findsNothing);
      expect(find.textContaining('hack'), findsNothing);
    });

    test('which answers lead to which screen', () {
      ErrorScreen? screenFor(int status, String code) => errorScreenFor(ApiError(status: status, code: code, correlationId: 'c'));
      expect(screenFor(403, 'SCOPE_DENIED'), ErrorScreen.accessDenied);
      expect(screenFor(403, 'ANY_OTHER_REFUSAL'), ErrorScreen.accessDenied);
      expect(screenFor(403, 'ENTITLEMENT_DENIED'), ErrorScreen.accessDenied);
      expect(screenFor(422, 'LICENSE_EXPIRED'), ErrorScreen.licenceExpired);
      expect(screenFor(403, 'LICENSE_EXPIRED'), ErrorScreen.licenceExpired);
      expect(screenFor(403, 'MFA_REQUIRED'), isNull, reason: 'the second factor is the session\'s');
      expect(screenFor(401, 'SESSION_EXPIRED'), isNull);
      expect(screenFor(409, 'VERSION_CONFLICT'), isNull);
      expect(screenFor(500, 'INTERNAL_ERROR'), isNull);
      expect(safeCode('SCOPE_DENIED'), 'SCOPE_DENIED');
      expect(safeCode('scope'), isNull);
      expect(safeCode(null), isNull);
      expect(safeReference('abc'), isNull);
      expect(safeReference('3f2b6c1e-0000-4000-8000'), '3f2b6c1e-0000-4000-8000');
    });

    testWidgets('the location is built from the route table and nothing else', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final ProviderContainer container = await _pump(tester, phone);
      final RouteTable table = container.read(routeTableProvider);
      expect(errorScreenLocation(table, const ApiError(status: 500, code: 'INTERNAL_ERROR', correlationId: 'c')), isNull);
      final Uri uri = Uri.parse(errorScreenLocation(table, const ApiError(status: 403, code: 'SCOPE_DENIED', correlationId: 'short'), action: 'delete')!);
      expect(uri.path, table.locationOf('MOB-45'));
      expect(uri.queryParameters.keys, <String>['code'], reason: 'a reference that is not one and an action that is not listed are dropped');
    });

    testWidgets('UI-MOB-45 screen contract at the three devices and at 200 percent text', (WidgetTester tester) async {
      await expectScreenContract(tester, () async {
        await _pump(tester, phone, location: '/projects/mob-45?code=SCOPE_DENIED&cid=3f2b6c1e-0000-4000-8000-000000000002&action=view');
        expect(find.text('Bạn không có quyền thực hiện thao tác này'), findsOneWidget);
      });
    });
  });

  group('TK-MOB-003-1 the adapter on permission_handler', () {
    final PermissionHandlerPlatform original = PermissionHandlerPlatform.instance;
    late _FakeHandler handler;

    setUp(() {
      handler = _FakeHandler();
      PermissionHandlerPlatform.instance = handler;
    });
    tearDown(() => PermissionHandlerPlatform.instance = original);

    test('asks for the notification, the camera and the position while in use, and nothing else', () async {
      const HandlerPermissionPlatform adapter = HandlerPermissionPlatform();
      await adapter.status(AppPermission.notifications);
      await adapter.status(AppPermission.camera);
      await adapter.status(AppPermission.location);
      expect(handler.checked, <Permission>[Permission.notification, Permission.camera, Permission.locationWhenInUse]);
    });

    test('maps what the plugin reports: allowed in any degree is granted, declined is declined, permanent or restricted is blocked', () async {
      const HandlerPermissionPlatform adapter = HandlerPermissionPlatform();
      Future<PermissionState> stateOf(PermissionStatus status) async {
        handler.answer = status;
        return adapter.status(AppPermission.camera);
      }

      expect(await stateOf(PermissionStatus.granted), PermissionState.granted);
      expect(await stateOf(PermissionStatus.limited), PermissionState.granted);
      expect(await stateOf(PermissionStatus.provisional), PermissionState.granted);
      expect(await stateOf(PermissionStatus.denied), PermissionState.denied);
      expect(await stateOf(PermissionStatus.permanentlyDenied), PermissionState.blocked);
      expect(await stateOf(PermissionStatus.restricted), PermissionState.blocked);
    });

    test('shows the system prompt through the plugin and opens the settings of the application', () async {
      const HandlerPermissionPlatform adapter = HandlerPermissionPlatform();
      handler.answer = PermissionStatus.granted;
      expect(await adapter.request(AppPermission.location), PermissionState.granted);
      expect(handler.requested, <Permission>[Permission.locationWhenInUse]);
      expect(await adapter.openSettings(), isTrue);
      expect(handler.settings, 1);
    });
  });
}

class _FakeHandler extends PermissionHandlerPlatform with MockPlatformInterfaceMixin {
  PermissionStatus answer = PermissionStatus.denied;
  final List<Permission> checked = <Permission>[];
  final List<Permission> requested = <Permission>[];
  int settings = 0;

  @override
  Future<PermissionStatus> checkPermissionStatus(Permission permission) async {
    checked.add(permission);
    return answer;
  }

  @override
  Future<Map<Permission, PermissionStatus>> requestPermissions(List<Permission> permissions) async {
    requested.addAll(permissions);
    return <Permission, PermissionStatus>{for (final Permission p in permissions) p: answer};
  }

  @override
  Future<bool> openAppSettings() async {
    settings += 1;
    return true;
  }
}
