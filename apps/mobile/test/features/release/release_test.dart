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
import 'package:machvon_mobile/core/release/release_notice.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/core/state/state_card.dart';
import 'package:machvon_mobile/features/release/app_info.dart';
import 'package:machvon_mobile/features/release/release_feature.dart' as release;
import 'package:machvon_mobile/features/release/release_providers.dart';
import 'package:machvon_mobile/features/release/telemetry.dart';
import 'package:machvon_mobile/features/release/version_policy.dart';

import '../../support/harness.dart';
import '../session/support/app.dart' show expectScreenContract;

const AppInfo _current = AppInfo(version: '1.4.0', build: '27', platform: 'android', osVersion: '14');
const AppInfo _previous = AppInfo(version: '1.3.0', build: '20', platform: 'android', osVersion: '14');

class _AppSource implements AppInfoSource {
  _AppSource(this.info);

  AppInfo info;

  @override
  Future<AppInfo> read() async => info;
}

class _PolicySource implements VersionPolicySource {
  _PolicySource(this.policy);

  VersionPolicy policy;
  Object? failure;
  final List<AppInfo> asked = <AppInfo>[];

  @override
  Future<VersionPolicy> fetch(AppInfo app) async {
    asked.add(app);
    final Object? error = failure;
    if (error != null) throw error;
    return policy;
  }
}

class _Opener implements UrlOpener {
  final List<Uri> opened = <Uri>[];
  bool succeeds = true;

  @override
  Future<bool> open(Uri url) async {
    opened.add(url);
    return succeeds;
  }
}

HttpResult _json(int status, Object? body, [Map<String, String> headers = const <String, String>{}]) =>
    HttpResult(status: status, headers: <String, String>{'content-type': 'application/json', ...headers}, body: jsonEncode(body));

Future<ProviderContainer> _pump(
  WidgetTester tester, {
  required _PolicySource policy,
  AppInfo app = _current,
  HttpTransport? transport,
  _Opener? opener,
  String? location,
  FakeSession? session,
  List<Override> overrides = const <Override>[],
}) async {
  // An application from an earlier step of the same test is closed and its timers run out before the next one starts.
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump(const Duration(milliseconds: 50));
  return pumpApp(
    tester,
    features: <MobileFeature>[release.feature],
    location: location,
    session: session,
    transport: transport,
    overrides: <Override>[
      appInfoSourceProvider.overrideWithValue(_AppSource(app)),
      versionPolicySourceProvider.overrideWithValue(policy),
      urlOpenerProvider.overrideWithValue(opener ?? _Opener()),
      releaseNoticeProvider.overrideWith(PolicyReleaseNotice.new),
      if (transport != null)
        apiTransportProvider.overrideWith(
          (Ref ref) => ReleaseObservingTransport(
            ref.watch(httpTransportProvider),
            (int status, Map<String, String> headers, String body) => (ref.read(releaseNoticeProvider.notifier) as PolicyReleaseNotice).noteResponse(status, headers, body),
          ),
        ),
      ...overrides,
    ],
  );
}

void main() {
  group('AC-ST-MOB-016-1 UAT-NFR-OPERABILITY-03 TK-MOB-016-2 the version policy', () {
    test('an application one release behind keeps working: the server at release N declares it neither unsafe nor required', () {
      final VersionPolicy policy = VersionPolicy.tryParse(<String, Object?>{
        'status': 'ok',
        'min_supported_version': '1.2.0',
        'unsafe_versions': <String>['1.1.0+9'],
      })!;
      expect(policy.noticeFor(_previous).blocks, isFalse);
      expect(policy.noticeFor(_current).blocks, isFalse);
      expect(VersionPolicy.tryParse(<String, Object?>{'status': 'upgrade_recommended'})!.noticeFor(_previous).blocks, isFalse, reason: 'a recommendation forces nothing');
    });

    test('a forced update appears only when the server declares the version unsafe, with its reason', () {
      final ReleaseNotice byStatus = VersionPolicy.tryParse(<String, Object?>{
        'status': 'upgrade_required',
        'reason_code': 'APP_VERSION_UNSAFE',
        'min_supported_version': '1.4.0',
        'store_url': 'https://apps.example.vn/machvon',
      })!.noticeFor(_previous);
      expect(byStatus.block, ReleaseBlock.upgradeRequired);
      expect(byStatus.reasonCode, 'APP_VERSION_UNSAFE');
      expect(byStatus.minimumVersion, '1.4.0');
      expect(byStatus.storeUrl, Uri.parse('https://apps.example.vn/machvon'));

      final VersionPolicy listed = VersionPolicy.tryParse(<String, Object?>{'status': 'ok', 'unsafe_versions': <String>['1.3.0+20']})!;
      expect(listed.noticeFor(_previous).block, ReleaseBlock.upgradeRequired);
      expect(listed.noticeFor(_previous).reasonCode, kVersionUnsafeCode);
      expect(listed.noticeFor(_current).blocks, isFalse, reason: 'only the declared version');
    });

    test('a maintenance window carries its start and its expected end, as the server wrote them', () {
      final ReleaseNotice notice = VersionPolicy.tryParse(<String, Object?>{
        'status': 'maintenance',
        'maintenance': <String, Object?>{'starts_at': '2026-11-03T01:00:00Z', 'ends_at': '2026-11-03T03:30:00Z'},
      })!.noticeFor(_current);
      expect(notice.block, ReleaseBlock.maintenance);
      expect(notice.windowStartsAt, DateTime.utc(2026, 11, 3, 1));
      expect(notice.windowEndsAt, DateTime.utc(2026, 11, 3, 3, 30));
      expect(notice.reasonCode, kMaintenanceCode);
    });

    test('what is not a policy of the contract, and what is not safe to show, is ignored', () {
      expect(VersionPolicy.tryParse(null), isNull);
      expect(VersionPolicy.tryParse(<String, Object?>{'x': 1}), isNull);
      final VersionPolicy odd = VersionPolicy.tryParse(<String, Object?>{
        'status': 'upgrade_required',
        'reason_code': 'not a code',
        'min_supported_version': 'latest',
        'store_url': 'http://evil.example/app',
        'maintenance': 'soon',
        'unsafe_versions': 'all',
      })!;
      final ReleaseNotice notice = odd.noticeFor(_current);
      expect(notice.reasonCode, kVersionUnsafeCode);
      expect(notice.minimumVersion, isNull);
      expect(notice.storeUrl, isNull, reason: 'only https');
      expect(VersionPolicy.tryParse(<String, Object?>{'status': 'upgrade_required', 'store_url': 'https://u:p@evil.example/'})!.storeUrl, isNull);
      expect(VersionPolicy.tryParse(<String, Object?>{'status': 'maintenance', 'maintenance': <String, Object?>{'ends_at': 'soon'}})!.windowEndsAt, isNull);
    });

    test('the source asks the server for this platform and version without any credential', () async {
      final List<HttpCall> calls = <HttpCall>[];
      final HttpVersionPolicySource source = HttpVersionPolicySource(
        baseUrl: testConfig.apiBaseUrl,
        transport: FakeTransport((HttpCall call) async {
          calls.add(call);
          return _json(200, <String, Object?>{'status': 'ok'});
        }),
      );
      expect((await source.fetch(_current)).upgradeRequired, isFalse);
      expect(calls.single.url.toString(), 'https://api.test/v1/mobile/version-policy?platform=android&app_version=1.4.0%2B27');
      expect(calls.single.headers.containsKey('authorization'), isFalse);
    });

    test('a failing source is a failure, never a policy: a server error, an unreadable answer, a time-out', () async {
      Future<Object> failureOf(HttpResult Function() answer, {Duration timeout = const Duration(seconds: 5)}) async {
        final HttpVersionPolicySource source = HttpVersionPolicySource(
          baseUrl: testConfig.apiBaseUrl,
          transport: FakeTransport((HttpCall call) async => answer()),
          timeout: timeout,
        );
        try {
          await source.fetch(_current);
        } on Object catch (error) {
          return error;
        }
        fail('expected a failure');
      }

      expect(await failureOf(() => _json(503, <String, Object?>{'code': 'SERVICE_UNAVAILABLE'})), isA<ApiError>());
      expect(await failureOf(() => const HttpResult(status: 200, headers: <String, String>{}, body: 'not json')), isA<ApiError>());
      expect(await failureOf(() => _json(200, <String, Object?>{'x': 1})), isA<ApiError>());

      final HttpVersionPolicySource slow = HttpVersionPolicySource(
        baseUrl: testConfig.apiBaseUrl,
        transport: FakeTransport((HttpCall call) => Completer<HttpResult>().future),
        timeout: const Duration(milliseconds: 20),
      );
      await expectLater(slow.fetch(_current), throwsA(isA<TimeoutException>()));
    });

    testWidgets('at start the policy is read; a version declared unsafe stops the application at MOB-54 with its reason and nothing else opens', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final _PolicySource policy = _PolicySource(
        const VersionPolicy(upgradeRequired: true, reasonCode: 'APP_VERSION_UNSAFE', minimumVersion: '1.4.0', storeUrl: null),
      );
      final ProviderContainer container = await _pump(tester, policy: policy, app: _previous, location: '/projects');

      expect(policy.asked.single.full, '1.3.0+20');
      expect(currentLocation(container), '/mob-54');
      expect(find.text('Cần cập nhật ứng dụng'), findsOneWidget);
      expect(find.text('Mã: APP_VERSION_UNSAFE'), findsOneWidget);
      expect(find.text('Phiên bản tối thiểu: 1.4.0'), findsOneWidget);
      expect(find.textContaining('được giữ nguyên trên máy'), findsOneWidget, reason: 'the drafts are safe');

      for (final String wanted in <String>['/home', '/projects', '/approval', '/mob-02', '/mob-41']) {
        container.read(routerProvider).go(wanted);
        await tester.pumpAndSettle();
        expect(currentLocation(container), '/mob-54', reason: wanted);
      }
    });

    testWidgets('an application one release behind is not stopped, and the report it submits succeeds', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final _PolicySource policy = _PolicySource(const VersionPolicy(minimumVersion: '1.2.0'));
      final FakeTransport transport = FakeTransport((HttpCall call) async => _json(201, <String, Object?>{'operation_id': 'op-1', 'status': 'Done', 'resource_version': 1}));
      final ProviderContainer container = await _pump(tester, policy: policy, app: _previous, transport: transport, location: '/projects');
      expect(currentLocation(container), '/projects');
      expect(container.read(releaseNoticeProvider).blocks, isFalse);

      final Object? answer = await container.read(apiClientProvider).execute(
        'createSupportTicket',
        body: const SupportTicketCreate(category: 'HOWTO', subject: 'Report 1.3', description: 'An older application submits.'),
      );
      expect(answer, isA<Map<String, Object?>>());
      expect(container.read(releaseNoticeProvider).blocks, isFalse);
    });

    testWidgets('a policy that cannot be read blocks nothing, and a block already in force stays', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final _PolicySource policy = _PolicySource(VersionPolicy.open)..failure = StateError('offline');
      final ProviderContainer container = await _pump(tester, policy: policy, location: '/projects');
      expect(currentLocation(container), '/projects');

      (container.read(releaseNoticeProvider.notifier) as PolicyReleaseNotice).noteResponse(
        426,
        const <String, String>{'content-type': 'application/json'},
        jsonEncode(<String, Object?>{'code': 'APP_VERSION_UNSAFE'}),
      );
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/mob-54');
      await (container.read(releaseNoticeProvider.notifier) as PolicyReleaseNotice).check();
      expect(container.read(releaseNoticeProvider).block, ReleaseBlock.upgradeRequired, reason: 'the check failed: the block stays');
    });

    testWidgets('a call answered 426 APP_VERSION_UNSAFE stops the application from wherever the person is', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final FakeTransport transport = FakeTransport(
        (HttpCall call) async => _json(
          426,
          <String, Object?>{'code': 'APP_VERSION_UNSAFE', 'status': 426, 'min_supported_version': '1.5.0', 'store_url': 'https://apps.example.vn/machvon'},
        ),
      );
      final ProviderContainer container = await _pump(tester, policy: _PolicySource(VersionPolicy.open), transport: transport, location: '/projects');
      await expectLater(container.read(apiClientProvider).execute('getMyProfile'), throwsA(isA<ApiError>()));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/mob-54');
      expect(find.text('Phiên bản tối thiểu: 1.5.0'), findsOneWidget);
      expect(find.text('Cập nhật ngay'), findsOneWidget);
    });

    testWidgets('only the codes of the policy count: another 426 or 503 changes nothing', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final PolicyReleaseNotice notifier;
      final ProviderContainer container = await _pump(tester, policy: _PolicySource(VersionPolicy.open), location: '/projects');
      notifier = container.read(releaseNoticeProvider.notifier) as PolicyReleaseNotice;
      notifier.noteResponse(426, const <String, String>{'content-type': 'application/json'}, jsonEncode(<String, Object?>{'code': 'UPGRADE_SOMETHING'}));
      notifier.noteResponse(503, const <String, String>{'content-type': 'text/html'}, '<html>busy</html>');
      notifier.noteResponse(503, const <String, String>{'content-type': 'application/json'}, 'not json');
      notifier.noteResponse(200, const <String, String>{}, '');
      expect(container.read(releaseNoticeProvider).blocks, isFalse);
    });
  });

  group('AC-ST-MOB-016-2 UI-MOB-54 the maintenance and update screen', () {
    VersionPolicy window() => VersionPolicy(
          maintenance: true,
          windowStartsAt: DateTime.utc(2026, 11, 3, 1),
          windowEndsAt: DateTime.utc(2026, 11, 3, 3, 30),
        );

    testWidgets('a maintenance window flag at start: MOB-54 shows the window and its expected end, and the offline drafts stay within reach', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final ProviderContainer container = await _pump(tester, policy: _PolicySource(window()), location: '/projects');

      expect(currentLocation(container), '/mob-54');
      expect(find.text('Hệ thống đang bảo trì'), findsOneWidget);
      expect(find.textContaining('Bắt đầu:'), findsOneWidget);
      expect(find.textContaining('Dự kiến kết thúc:'), findsOneWidget);
      expect(find.textContaining('bản nháp ngoại tuyến'), findsWidgets);

      await tester.tap(find.text('Xem bản nháp ngoại tuyến'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), startsWith('/'), reason: 'the offline screens are not turned back');
      expect(currentLocation(container), isNot('/mob-54'));
      container.read(routerProvider).go('/projects');
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/mob-54', reason: 'the screens that need the service are');
    });

    testWidgets('"Kiểm tra lại" tells whether the service is back: still down says so, back opens the home screen', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final _PolicySource policy = _PolicySource(window());
      final ProviderContainer container = await _pump(tester, policy: policy, location: '/projects');
      await tester.tap(find.text('Kiểm tra lại'));
      await tester.pumpAndSettle();
      expect(find.text('Dịch vụ vẫn đang bảo trì.'), findsOneWidget);
      expect(policy.asked, hasLength(2));

      policy.policy = VersionPolicy.open;
      await tester.tap(find.text('Kiểm tra lại'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/home');
      expect(container.read(releaseNoticeProvider).blocks, isFalse);
    });

    testWidgets('a call answered 503 MAINTENANCE_WINDOW opens it too, with the window the server gave', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final FakeTransport transport = FakeTransport(
        (HttpCall call) async => _json(503, <String, Object?>{
          'code': 'MAINTENANCE_WINDOW',
          'status': 503,
          'starts_at': '2026-11-03T01:00:00Z',
          'ends_at': '2026-11-03T03:30:00Z',
        }),
      );
      final ProviderContainer container = await _pump(tester, policy: _PolicySource(VersionPolicy.open), transport: transport, location: '/projects');
      await expectLater(container.read(apiClientProvider).execute('getMyProfile'), throwsA(isA<ApiError>()));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/mob-54');
      expect(find.text('Hệ thống đang bảo trì'), findsOneWidget);
      expect(container.read(releaseNoticeProvider).windowEndsAt, DateTime.utc(2026, 11, 3, 3, 30));
    });

    testWidgets('the forced update opens the page of the new version; a page that cannot be opened is said; without a store address nothing is offered', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final _Opener opener = _Opener();
      final _PolicySource policy = _PolicySource(VersionPolicy(upgradeRequired: true, storeUrl: Uri.parse('https://apps.example.vn/machvon')));
      await _pump(tester, policy: policy, opener: opener, location: '/projects');
      await tester.tap(find.text('Cập nhật ngay'));
      await tester.pumpAndSettle();
      expect(opener.opened, <Uri>[Uri.parse('https://apps.example.vn/machvon')]);

      opener.succeeds = false;
      await tester.tap(find.text('Cập nhật ngay'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Chưa mở được trang cập nhật'), findsOneWidget);

      await _pump(tester, policy: _PolicySource(const VersionPolicy(upgradeRequired: true)), location: '/projects');
      expect(find.text('Cập nhật ngay'), findsNothing);
    });

    testWidgets('the system opener only opens https', (WidgetTester tester) async {
      expect(await const SystemUrlOpener().open(Uri.parse('http://apps.example.vn/machvon')), isFalse);
      expect(await const SystemUrlOpener().open(Uri.parse('javascript:alert(1)')), isFalse);
    });

    testWidgets('opened with nothing to say it says so and goes home; it opens without a session', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final ProviderContainer container = await _pump(
        tester,
        policy: _PolicySource(VersionPolicy.open),
        session: FakeSession(const SessionSnapshot.signedOut()),
        location: '/mob-54',
      );
      expect(currentLocation(container), '/mob-54');
      expect(find.text('Không có bảo trì hay bản cập nhật bắt buộc'), findsOneWidget);
      expect(find.text('Phiên bản ứng dụng: 1.4.0+27'), findsOneWidget);
      await tester.tap(find.text('Về trang chủ'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), startsWith('/mob-02'));
    });

    testWidgets('UI-MOB-54 screen contract in both situations at the three devices and at 200 percent text', (WidgetTester tester) async {
      await expectScreenContract(tester, () async {
        await _pump(tester, policy: _PolicySource(window()), location: '/projects');
        expect(find.text('Hệ thống đang bảo trì'), findsOneWidget);
      });
      await expectScreenContract(tester, () async {
        await _pump(tester, policy: _PolicySource(VersionPolicy(upgradeRequired: true, storeUrl: Uri.parse('https://apps.example.vn/m'))), location: '/projects');
        expect(find.text('Cần cập nhật ứng dụng'), findsOneWidget);
      });
    });
  });

  group('AC-ST-MOB-016-3 UI-MOB-50 TK-MOB-016-3 the help request', () {
    Future<(ProviderContainer, List<HttpCall>)> openHelp(WidgetTester tester, {String location = '/account/mob-50', Future<HttpResult> Function(HttpCall call)? answer}) async {
      final List<HttpCall> calls = <HttpCall>[];
      final FakeTransport transport = FakeTransport((HttpCall call) async {
        calls.add(call);
        return answer == null
            ? _json(201, <String, Object?>{'operation_id': '3f2b6c1e-0000-4000-8000-0000000000b1', 'status': 'Created', 'resource_version': 1, 'resource_id': '3f2b6c1e-0000-4000-8000-0000000000b2'})
            : answer(call);
      });
      final ProviderContainer container = await _pump(tester, policy: _PolicySource(VersionPolicy.open), transport: transport, location: location);
      return (container, calls);
    }

    testWidgets('a ticket is created with the topic, the subject, the description and the app and OS versions, and nothing of any record', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final (ProviderContainer container, List<HttpCall> calls) = await openHelp(tester);

      expect(find.text('Trợ giúp và phản hồi'), findsWidgets);
      expect(find.text('Đính kèm tự động: app 1.4.0+27, android 14'), findsOneWidget);
      await tester.enterText(find.widgetWithText(TextField, 'Tiêu đề'), 'Không mở được màn hình');
      await tester.enterText(find.widgetWithText(TextField, 'Mô tả'), 'Màn hình trắng sau khi đăng nhập.');
      await tester.tap(find.text('Sự cố'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Gửi yêu cầu'));
      await tester.tap(find.text('Gửi yêu cầu'));
      await tester.pumpAndSettle();

      final HttpCall call = calls.single;
      expect(call.method, 'POST');
      expect(call.url.path, '/v1/support-tickets');
      final Map<String, Object?> body = jsonDecode(call.body!) as Map<String, Object?>;
      expect(body.keys.toSet(), <String>{'category', 'subject', 'description'});
      expect(body['category'], 'INCIDENT');
      expect(body['subject'], 'Không mở được màn hình');
      expect(body['description'], 'Màn hình trắng sau khi đăng nhập.\n\napp 1.4.0+27, android 14');
      expect(call.headers['idempotency-key'], hasLength(greaterThanOrEqualTo(16)));
      expect(find.text('Đã gửi yêu cầu hỗ trợ'), findsOneWidget);
      expect(find.text('Mã yêu cầu: 3f2b6c1e-0000-4000-8000-0000000000b2'), findsOneWidget);
      expect(container, isNotNull);
    });

    testWidgets('the form checks the length of the subject and the description before anything is sent', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final (ProviderContainer _, List<HttpCall> calls) = await openHelp(tester);
      await tester.ensureVisible(find.text('Gửi yêu cầu'));
      await tester.tap(find.text('Gửi yêu cầu'));
      await tester.pump();
      expect(find.text('Nhập từ 5 đến 200 ký tự.'), findsOneWidget);
      expect(find.text('Nhập từ 10 đến 10000 ký tự.'), findsOneWidget);
      expect(calls, isEmpty);
    });

    testWidgets('the topic can be chosen by the screen that sends the person here, and only from the list', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      await openHelp(tester, location: '/account/mob-50?category=BILLING');
      expect(find.text('License và thanh toán'), findsOneWidget);
      await openHelp(tester, location: '/account/mob-50?category=EVIL');
      expect(find.text('Cách sử dụng'), findsOneWidget);
    });

    testWidgets('a request whose answer is lost is sent again with the same key and the same content; changed content is a new request', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      int attempt = 0;
      final (ProviderContainer _, List<HttpCall> calls) = await openHelp(tester, answer: (HttpCall call) async {
        attempt += 1;
        if (attempt == 1) throw StateError('answer lost');
        if (attempt == 2) return _json(409, <String, Object?>{'code': 'VERSION_CONFLICT', 'status': 409});
        return _json(201, <String, Object?>{'operation_id': '3f2b6c1e-0000-4000-8000-0000000000b1', 'status': 'Created', 'resource_version': 1});
      });
      await tester.enterText(find.widgetWithText(TextField, 'Tiêu đề'), 'Không mở được màn hình');
      await tester.enterText(find.widgetWithText(TextField, 'Mô tả'), 'Màn hình trắng sau khi đăng nhập.');
      await tester.ensureVisible(find.text('Gửi yêu cầu'));
      await tester.tap(find.text('Gửi yêu cầu'));
      await tester.pumpAndSettle();
      expect(find.text('Máy chủ phản hồi quá chậm'), findsOneWidget, reason: 'the answer was lost');
      expect(find.widgetWithText(TextField, 'Tiêu đề', skipOffstage: false), findsOneWidget, reason: 'what was typed is still there');

      await tester.tap(find.text('Thử lại'));
      await tester.pumpAndSettle();
      expect(calls, hasLength(2));
      expect(calls[1].headers['idempotency-key'], calls[0].headers['idempotency-key']);
      expect(find.textContaining('Mã: VERSION_CONFLICT'), findsOneWidget, reason: 'a refusal of the request is shown above the form, which stays editable');

      // The person changes the text: this is another request, with its own key.
      await tester.enterText(find.widgetWithText(TextField, 'Mô tả'), 'Màn hình trắng sau khi đăng nhập, Android 14.');
      await tester.ensureVisible(find.text('Gửi yêu cầu'));
      await tester.tap(find.text('Gửi yêu cầu'));
      await tester.pumpAndSettle();
      expect(calls, hasLength(3));
      expect(calls[2].headers['idempotency-key'], isNot(calls[1].headers['idempotency-key']));
      expect(find.text('Đã gửi yêu cầu hỗ trợ'), findsOneWidget);

      await tester.tap(find.text('Gửi yêu cầu khác'));
      await tester.pumpAndSettle();
      expect(tester.widget<TextField>(find.widgetWithText(TextField, 'Tiêu đề')).controller!.text, isEmpty, reason: 'a sent request is not kept');
    });

    testWidgets('every state: loading (the fields are read only), denied, ended session, licence expired, time-out and no connection', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      Future<ProviderContainer> submit(Future<HttpResult> Function(HttpCall) answer) async {
        final (ProviderContainer container, List<HttpCall> _) = await openHelp(tester, answer: answer);
        await tester.enterText(find.widgetWithText(TextField, 'Tiêu đề'), 'Không mở được màn hình');
        await tester.enterText(find.widgetWithText(TextField, 'Mô tả'), 'Màn hình trắng sau khi đăng nhập.');
        await tester.ensureVisible(find.text('Gửi yêu cầu'));
        await tester.tap(find.text('Gửi yêu cầu'));
        return container;
      }

      final Completer<HttpResult> gate = Completer<HttpResult>();
      await submit((HttpCall _) => gate.future);
      await tester.pump();
      expect(find.byType(LoadingView), findsOneWidget, reason: 'loading');
      gate.complete(_json(201, <String, Object?>{'operation_id': 'a', 'status': 'Created', 'resource_version': 1}));
      await tester.pumpAndSettle();

      await submit((HttpCall _) async => _json(403, <String, Object?>{'code': 'SCOPE_DENIED', 'status': 403}));
      await tester.pumpAndSettle();
      expect(find.text('Bạn chưa có quyền truy cập'), findsOneWidget, reason: 'denied');
      await submit((HttpCall _) async => _json(401, <String, Object?>{'code': 'SESSION_EXPIRED', 'status': 401}));
      await tester.pumpAndSettle();
      expect(find.text('SESSION_EXPIRED'), findsWidgets, reason: 'ended session');
      await submit((HttpCall _) async => _json(422, <String, Object?>{'code': 'LICENSE_EXPIRED', 'status': 422}));
      await tester.pumpAndSettle();
      expect(find.text('License đã hết hạn'), findsOneWidget, reason: 'expired licence');
      final ProviderContainer container = await submit((HttpCall _) async => throw StateError('no route'));
      await tester.pumpAndSettle();
      expect(find.text('Máy chủ phản hồi quá chậm'), findsOneWidget, reason: 'time-out');
      container.read(reachabilityProvider.notifier).report(Reachability.offline);
      await tester.tap(find.text('Thử lại'));
      await tester.pumpAndSettle();
      expect(find.text('Bạn đang ngoại tuyến'), findsOneWidget, reason: 'offline');
      expect(find.widgetWithText(TextField, 'Tiêu đề', skipOffstage: false), findsOneWidget, reason: 'the text is kept');
    });

    testWidgets('the fields are read only while the request is sent', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final Completer<HttpResult> gate = Completer<HttpResult>();
      final (ProviderContainer _, List<HttpCall> _) = await openHelp(tester, answer: (HttpCall _) => gate.future);
      await tester.enterText(find.widgetWithText(TextField, 'Tiêu đề'), 'Không mở được màn hình');
      await tester.enterText(find.widgetWithText(TextField, 'Mô tả'), 'Màn hình trắng sau khi đăng nhập.');
      await tester.ensureVisible(find.text('Gửi yêu cầu'));
      await tester.tap(find.text('Gửi yêu cầu'));
      await tester.pump();
      expect(tester.widget<TextField>(find.widgetWithText(TextField, 'Tiêu đề', skipOffstage: false)).readOnly, isTrue);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Gửi yêu cầu', skipOffstage: false)).onPressed, isNull);
      gate.complete(_json(201, <String, Object?>{'operation_id': 'a', 'status': 'Created', 'resource_version': 1}));
      await tester.pumpAndSettle();
    });

    testWidgets('UI-MOB-50 screen contract at the three devices and at 200 percent text', (WidgetTester tester) async {
      await expectScreenContract(tester, () async {
        await openHelp(tester);
        expect(find.text('Gửi yêu cầu'), findsOneWidget);
      });
    });
  });

  group('AC-ST-MOB-016-4 UAT-NFR-OBSERVABILITY-01 TK-MOB-016-4 the telemetry', () {
    test('every event carries the tenant id, and none carries what a person or a record is made of', () {
      String? tenant = 'tenant-a-0000';
      final BufferedTelemetrySink sink = BufferedTelemetrySink();
      final TelemetryService service = TelemetryService(sink: sink, tenantId: () => tenant);

      expect(service.record('app.start', <String, Object>{'app_version': '1.4.0+27', 'platform': 'android', 'os_version': '14'}), isTrue);
      tenant = null;
      service.record('release.blocked', <String, Object>{'reason_code': 'APP_VERSION_UNSAFE', 'screen_id': 'MOB-54'});
      tenant = 'tenant-b-0000';
      service.recordCrash(StateError('token eyJhbGciOi.payload.sig for Nguyen Van A'));
      service.recordQueueHealth(length: 4, unknown: 1, conflicts: 2);
      service.recordSessionEnd(crashFree: true, durationMs: 120000);

      expect(sink.events, isNotEmpty);
      expect(sink.events.map((TelemetryEvent e) => e.tenantId), everyElement(isNotEmpty));
      expect(sink.events.map((TelemetryEvent e) => e.tenantId).toSet(), <String>{'tenant-a-0000', kNoTenant, 'tenant-b-0000'});
      final String everything = jsonEncode(sink.events.map((TelemetryEvent e) => e.toJson()).toList());
      for (final String leaked in <String>['eyJhbGciOi', 'Nguyen', 'token', 'payload.sig']) {
        expect(everything, isNot(contains(leaked)), reason: leaked);
      }
      final TelemetryEvent crash = sink.events.firstWhere((TelemetryEvent e) => e.name == 'app.crash');
      expect(crash.attributes, <String, Object>{'error_type': 'StateError'});
      expect(sink.events.where((TelemetryEvent e) => e.name.startsWith('queue.')).map((TelemetryEvent e) => e.attributes.values.single), <Object>[4, 0.25, 0.5]);
    });

    test('a name, a token, an e-mail address or a record text cannot be sent: what does not fit the shape of its key is dropped', () {
      final BufferedTelemetrySink sink = BufferedTelemetrySink();
      final TelemetryService service = TelemetryService(sink: sink, tenantId: () => 'tenant-a-0000');

      expect(service.record('user.opened_contract', <String, Object>{'count': 1}), isFalse, reason: 'an event outside the list');
      service.record('app.crash', <String, Object>{
        'error_type': 'Nguyen Van A',
        'user_name': 'Nguyen Van A',
        'email': 'ana@example.vn',
        'access_token': 'tenant-token-1',
        'record': 'Cau Hoa Binh 5 ty',
        'screen_id': 'MOB-13 Cau Hoa Binh',
        'reason_code': 'a@b.c',
        'app_version': 'latest',
        'platform': 'windows',
        'os_version': '14 build 7',
        'count': -1,
        'rate': 3,
        'duration_ms': 'long',
        'crash_free': 'yes',
      });
      expect(sink.events.single.attributes, isEmpty);
      expect(service.dropped, 15);
    });

    test('the crash hooks report the type of the error and still call the handlers that were there', () {
      final BufferedTelemetrySink sink = BufferedTelemetrySink();
      final TelemetryService service = TelemetryService(sink: sink, tenantId: () => 'tenant-a-0000');
      int previousCalls = 0;
      final void Function(FlutterErrorDetails)? original = FlutterError.onError;
      FlutterError.onError = (FlutterErrorDetails details) => previousCalls += 1;
      final bool Function(Object, StackTrace)? originalPlatform = TestWidgetsFlutterBinding.ensureInitialized().platformDispatcher.onError;
      final void Function() uninstall = installCrashReporting(service);
      try {
        FlutterError.onError!(FlutterErrorDetails(exception: ArgumentError('secret ana@example.vn')));
        expect(previousCalls, 1);
        expect(sink.events.single.attributes['error_type'], 'ArgumentError');
        expect(jsonEncode(sink.events.single.toJson()), isNot(contains('secret')));
      } finally {
        uninstall();
        FlutterError.onError = original;
        TestWidgetsFlutterBinding.ensureInitialized().platformDispatcher.onError = originalPlatform;
      }
    });

    test('the buffer keeps the last events only', () {
      final BufferedTelemetrySink sink = BufferedTelemetrySink(capacity: 2);
      final TelemetryService service = TelemetryService(sink: sink, tenantId: () => 'tenant-a-0000');
      for (int i = 0; i < 4; i += 1) {
        service.record('queue.length', <String, Object>{'count': i});
      }
      expect(sink.events.map((TelemetryEvent e) => e.attributes['count']), <Object>[2, 3]);
    });

    testWidgets('the service of the application reads the tenant from the session', (WidgetTester tester) async {
      final BufferedTelemetrySink sink = BufferedTelemetrySink();
      final ProviderContainer container = await pumpApp(
        tester,
        overrides: <Override>[telemetrySinkProvider.overrideWithValue(sink)],
      );
      container.read(telemetryProvider).record('app.start', <String, Object>{'platform': 'ios'});
      expect(sink.events.single.tenantId, 'tenant-a');
    });
  });
}
