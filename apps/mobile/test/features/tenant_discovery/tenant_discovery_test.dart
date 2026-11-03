import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/core/state/state_card.dart';
import 'package:machvon_mobile/core/theme/app_theme.dart';
import 'package:machvon_mobile/features/session/auth/auth_service.dart';
import 'package:machvon_mobile/features/session/auth/identity_api.dart';
import 'package:machvon_mobile/features/session/auth/session_vault.dart';
import 'package:machvon_mobile/features/session/session_providers.dart';
import 'package:machvon_mobile/features/tenant_discovery/published_theme.dart';
import 'package:machvon_mobile/features/tenant_discovery/tenant_directory.dart';
import 'package:machvon_mobile/features/tenant_discovery/tenant_discovery_feature.dart' as discovery;
import 'package:machvon_mobile/features/tenant_discovery/theme_providers.dart';
import 'package:machvon_mobile/features/tenant_discovery/theme_service.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../support/harness.dart';
import '../session/support/app.dart';
import '../session/support/world.dart';

class _Directory implements TenantDirectory {
  _Directory(this.answer);

  Future<TenantDiscovery> Function(String query) answer;
  final List<String> asked = <String>[];

  @override
  Future<TenantDiscovery> lookup(String codeOrDomain) {
    asked.add(codeOrDomain);
    return answer(codeOrDomain);
  }
}

TenantDiscovery _found({PublishedTheme? theme}) => TenantDiscovery(code: 'minh-ha', tenantName: 'UBND Minh Hà', oidc: kOidcConfig, theme: theme);

PublishedTheme _theme(String tenant, int version, {String primary = '#0b4a8f', String primaryText = '#ffffff'}) =>
    PublishedTheme.tryParse(themeJson(tenant, version, primary: primary, primaryText: primaryText))!;

HttpResult _json(int status, Object? body, [Map<String, String> headers = const <String, String>{}]) =>
    HttpResult(status: status, headers: <String, String>{'content-type': 'application/json', ...headers}, body: jsonEncode(body));

Map<String, Object?> _discoveryJson({Object? theme, String code = 'minh-ha'}) => <String, Object?>{
      'tenant_name': 'UBND Minh Hà',
      'tenant_code': code,
      'oidc': <String, Object?>{'issuer': kIssuer.toString(), 'client_id': kClientId},
      'theme': theme,
    };

Future<ProviderContainer> _pumpWelcome(
  WidgetTester tester,
  World world,
  TenantDirectory directory, {
  String location = '/mob-01',
  DateTime Function()? clock,
}) {
  return pumpSessionApp(
    tester,
    world,
    location: location,
    noConfig: true,
    features: <MobileFeature>[discovery.feature],
    clock: clock,
    overrides: <Override>[
      tenantDirectoryProvider.overrideWithValue(directory),
      secureValueStoreProvider.overrideWithValue(world.store),
      tenantThemeProvider.overrideWith(PublishedTenantTheme.new),
    ],
  );
}

void main() {
  late World world;

  setUp(() => world = World());
  tearDown(() => world.dispose());

  group('AC-ST-MOB-004-1 UI-MOB-01 TK-MOB-004-1 the tenant code and the published theme', () {
    test('the directory is asked without any credential, and gives the identity provider and the published theme', () async {
      final List<HttpCall> calls = <HttpCall>[];
      final HttpTenantDirectory directory = HttpTenantDirectory(
        baseUrl: testConfig.apiBaseUrl,
        transport: FakeTransport((HttpCall call) async {
          calls.add(call);
          return _json(200, _discoveryJson(theme: themeJson('tenant-a', 3)));
        }),
        locale: () => 'vi',
      );
      final TenantDiscovery found = await directory.lookup('  Minh-Ha ');

      expect(calls.single.method, 'GET');
      expect(calls.single.url.toString(), 'https://api.test/v1/tenant-discovery?q=minh-ha');
      expect(calls.single.headers.containsKey('authorization'), isFalse);
      expect(calls.single.headers['accept-language'], 'vi');
      expect(found.code, 'minh-ha');
      expect(found.tenantName, 'UBND Minh Hà');
      expect(found.oidc, kOidcConfig);
      expect(found.theme!.version, 3);
      expect(found.theme!.tenantId, 'tenant-a');
      expect(found.theme!.accepted, isTrue);
    });

    test('an answer without a theme, or with a theme that is not of the contract, still gives the identity provider', () async {
      for (final Object? theme in <Object?>[null, <String, Object?>{'tenantId': 'x'}, 'text']) {
        final HttpTenantDirectory directory = HttpTenantDirectory(
          baseUrl: testConfig.apiBaseUrl,
          transport: FakeTransport((HttpCall call) async => _json(200, _discoveryJson(theme: theme))),
        );
        final TenantDiscovery found = await directory.lookup('minh-ha');
        expect(found.theme, isNull);
        expect(found.oidc, kOidcConfig);
      }
    });

    test('an answer the application cannot use is a failure of the service, never a tenant', () async {
      Future<ApiError> failureOf(HttpResult answer) async {
        final HttpTenantDirectory directory = HttpTenantDirectory(baseUrl: testConfig.apiBaseUrl, transport: FakeTransport((HttpCall call) async => answer));
        try {
          await directory.lookup('minh-ha');
        } on ApiError catch (error) {
          return error;
        }
        fail('expected a failure');
      }

      expect((await failureOf(const HttpResult(status: 200, headers: <String, String>{}, body: 'not json'))).code, 'INTERNAL_ERROR');
      expect((await failureOf(_json(200, <String>['x']))).code, 'INTERNAL_ERROR');
      expect((await failureOf(_json(200, <String, Object?>{'tenant_name': 'x'}))).code, 'INTERNAL_ERROR');
      final Map<String, Object?> http = _discoveryJson()..['oidc'] = <String, Object?>{'issuer': 'http://idp.test/realms/x', 'client_id': 'c'};
      expect((await failureOf(_json(200, http))).code, 'INTERNAL_ERROR');
      final Map<String, Object?> noIssuer = _discoveryJson()..['oidc'] = <String, Object?>{'client_id': 'c'};
      expect((await failureOf(_json(200, noIssuer))).code, 'INTERNAL_ERROR');
      expect((await failureOf(_json(503, <String, Object?>{'code': 'SERVICE_UNAVAILABLE', 'status': 503}))).status, 503);
    });

    test('a request that does not get through is a network failure', () async {
      final HttpTenantDirectory directory = HttpTenantDirectory(
        baseUrl: testConfig.apiBaseUrl,
        transport: FakeTransport((HttpCall call) async => throw StateError('refused')),
      );
      await expectLater(directory.lookup('minh-ha'), throwsA(isA<ApiError>().having((ApiError e) => e.code, 'code', 'NETWORK_ERROR')));
    });

    test('what the person typed becomes a code or a domain, or nothing at all (and then nothing is sent)', () async {
      expect(normalizeTenantInput('Minh-Ha'), 'minh-ha');
      expect(normalizeTenantInput(' https://MinhHa.machvon.vn/login?x=1 '), 'minhha.machvon.vn');
      expect(normalizeTenantInput('minhha.machvon.vn.'), 'minhha.machvon.vn');
      expect(normalizeTenantInput('a'), 'a');
      for (final String bad in <String>['', ' ', '-bad', 'bad-', 'a b', 'a..b', 'a_b', 'tên', "x'; drop", '<script>', 'a' * 300]) {
        expect(normalizeTenantInput(bad), isNull, reason: bad);
      }
      final HttpTenantDirectory directory = HttpTenantDirectory(baseUrl: testConfig.apiBaseUrl, transport: FakeTransport((HttpCall call) async => fail('nothing is sent')));
      await expectLater(directory.lookup('a b'), throwsA(isA<TenantNotFound>()));
    });

    testWidgets('a valid code loads the identity provider and the published theme, applies it with no contrast violation and goes on to sign-in', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final PublishedTheme theme = _theme('tenant-a', 3);
      final _Directory directory = _Directory((String q) async => _found(theme: theme));
      final ProviderContainer container = await _pumpWelcome(tester, world, directory, location: '/mob-01?return=%2Fapproval');

      expect(find.text('Chào mừng đến MACHVON'), findsOneWidget);
      expect(find.text('Tiếp tục'), findsOneWidget);
      await tester.enterText(find.byType(TextField), 'Minh-Ha');
      await tapText(tester, 'Tiếp tục');
      await tester.pumpAndSettle();

      expect(directory.asked, <String>['minh-ha']);
      expect(container.read(oidcConfigProvider), kOidcConfig);
      expect(overlayFindingCodes(theme.overlay), isEmpty, reason: 'zero contrast violations');
      expect(container.read(activeThemeProvider), ActiveTheme(tenantId: 'tenant-a', version: 3, hash: '03' * 32));
      expect(container.read(appThemeProvider).colorScheme.primary, const Color(0xFF0B4A8F));
      expect(currentLocation(container), startsWith('/mob-02'));
      expect(Uri.parse(currentLocation(container)).queryParameters['return'], '/approval');
      final LastContext last = (await world.vault.loadLast())!;
      expect(last.tenantCode, 'minh-ha');
      expect(last.config, kOidcConfig);
    });

    testWidgets('a theme that fails the contrast rules is not applied, not even in part, and the sign-in still goes on', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final PublishedTheme poor = _theme('tenant-a', 3, primary: '#ffffff', primaryText: '#f0f0f0');
      expect(poor.accepted, isFalse);
      final ProviderContainer container = await _pumpWelcome(tester, world, _Directory((String q) async => _found(theme: poor)));
      await tester.enterText(find.byType(TextField), 'minh-ha');
      await tapText(tester, 'Tiếp tục');
      await tester.pumpAndSettle();

      expect(container.read(activeThemeProvider), isNull);
      expect(container.read(appThemeProvider).colorScheme.primary, buildAppTheme().colorScheme.primary);
      expect(currentLocation(container), startsWith('/mob-02'));
    });

    testWidgets('the tenant used last time is offered, and one tap looks it up', (WidgetTester tester) async {
      await world.vault.saveLast(LastContext(config: kOidcConfig, tenantCode: 'bo-thu-nghiem'));
      useDevice(tester, kDeviceSizes[1]);
      final _Directory directory = _Directory((String q) async => _found());
      final ProviderContainer container = await _pumpWelcome(tester, world, directory);

      expect(find.text('Dùng lại bo-thu-nghiem'), findsOneWidget);
      await tapText(tester, 'Dùng lại bo-thu-nghiem');
      await tester.pumpAndSettle();
      expect(directory.asked, <String>['bo-thu-nghiem']);
      expect(currentLocation(container), startsWith('/mob-02'));
    });

    testWidgets('something that cannot be a code is refused on the phone, nothing is sent, and typing clears the message', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final _Directory directory = _Directory((String q) async => _found());
      await _pumpWelcome(tester, world, directory);
      await tester.enterText(find.byType(TextField), 'bad code!');
      await tapText(tester, 'Tiếp tục');
      expect(find.text('Mã hoặc tên miền chỉ gồm chữ thường, số, dấu gạch ngang và dấu chấm.'), findsOneWidget);
      expect(directory.asked, isEmpty);
      await tester.enterText(find.byType(TextField), 'bad code');
      await tester.pump();
      expect(find.textContaining('chỉ gồm chữ thường'), findsNothing);
    });

    testWidgets('UI-MOB-01 screen contract at the three devices and at 200 percent text', (WidgetTester tester) async {
      await expectScreenContract(tester, () async {
        await _pumpWelcome(tester, world, _Directory((String q) async => _found()));
        expect(find.text('Chào mừng đến MACHVON'), findsOneWidget);
      });
    });
  });

  group('AC-ST-MOB-004-1 UI-MOB-01 the directory of the application', () {
    testWidgets('is the one on the API of the configured address, in the language of the interface', (WidgetTester tester) async {
      final ProviderContainer container = await pumpApp(tester, transport: FakeTransport((HttpCall call) async => _json(404, <String, Object?>{'code': 'X'})));
      final TenantDirectory directory = container.read(tenantDirectoryProvider);
      expect(directory, isA<HttpTenantDirectory>());
      await expectLater(directory.lookup('minh-ha'), throwsA(isA<TenantNotFound>()));
    });
  });

  group('AC-ST-MOB-004-2 TH01 TK-MOB-004-3 an unknown code and a draft theme', () {
    testWidgets('every lookup that finds nothing gets the same answer, so the screen never says whether a tenant exists', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final List<String> shown = <String>[];
      for (final int status in <int>[404, 403, 410, 422, 400]) {
        world = World();
        final HttpTenantDirectory directory = HttpTenantDirectory(
          baseUrl: testConfig.apiBaseUrl,
          transport: FakeTransport((HttpCall call) async => _json(status, <String, Object?>{'code': 'ANYTHING', 'status': status, 'detail': 'tenant minh-ha is suspended'})),
        );
        final ProviderContainer container = await _pumpWelcome(tester, world, directory);
        await tester.enterText(find.byType(TextField), 'minh-ha');
        await tapText(tester, 'Tiếp tục');
        await tester.pumpAndSettle();
        shown.add(tester.widget<TextField>(find.byType(TextField)).decoration!.errorText!);
        expect(currentLocation(container), startsWith('/mob-01'));
        expect(find.textContaining('suspended'), findsNothing);
        expect(find.byType(LoadingView), findsNothing);
      }
      expect(shown.toSet(), <String>{'Không tìm thấy tổ chức với mã này. Kiểm tra lại mã hoặc tên miền.'});
    });

    testWidgets('too many lookups: the phone stops after five in a minute, the server 429 is obeyed, and the button comes back', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      DateTime now = DateTime.utc(2026, 11, 3, 8);
      final _Directory directory = _Directory((String q) async => throw const TenantNotFound());
      await _pumpWelcome(tester, world, directory, clock: () => now);
      await tester.enterText(find.byType(TextField), 'minh-ha');
      for (int attempt = 0; attempt < 5; attempt += 1) {
        await tapText(tester, 'Tiếp tục');
        await tester.pumpAndSettle();
      }
      expect(directory.asked, hasLength(5));
      await tapText(tester, 'Tiếp tục');
      await tester.pump();
      expect(directory.asked, hasLength(5), reason: 'the sixth is not sent');
      expect(find.textContaining('Bạn đã thử quá nhiều lần'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Tiếp tục')).onPressed, isNull);

      await tester.pump(const Duration(seconds: 61));
      now = now.add(const Duration(seconds: 61));
      await tester.pumpAndSettle();
      expect(find.textContaining('Bạn đã thử quá nhiều lần'), findsNothing);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Tiếp tục')).onPressed, isNotNull);
    });

    testWidgets('a 429 of the server says how long to wait', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      await _pumpWelcome(
        tester,
        world,
        HttpTenantDirectory(
          baseUrl: testConfig.apiBaseUrl,
          transport: FakeTransport((HttpCall call) async => _json(429, <String, Object?>{'code': 'RATE_LIMIT', 'status': 429}, <String, String>{'retry-after': '20'})),
        ),
      );
      await tester.enterText(find.byType(TextField), 'minh-ha');
      await tapText(tester, 'Tiếp tục');
      await tester.pump();
      expect(find.text('Bạn đã thử quá nhiều lần. Thử lại sau 21 giây.'), findsOneWidget);
      await tester.pump(const Duration(seconds: 21));
    });

    test('a theme of another tenant is never applied for this one, and the application never asks for a draft', () async {
      final List<String> applied = <String>[];
      final TenantThemeService service = TenantThemeService(
        store: world.store,
        publish: (Map<String, String>? overlay) => applied.add(overlay?['primary'] ?? 'base'),
        activate: (ActiveTheme? theme) {},
        fetchMine: () async => themeJson('tenant-b', 9, primary: '#1b6b3a'),
      );
      expect(await service.apply(_theme('tenant-b', 9), tenantId: 'tenant-a'), isFalse);
      expect(await service.refresh('tenant-a'), isFalse, reason: 'the server answered a theme of another tenant');
      expect(applied, isEmpty);
      expect(await service.refresh('tenant-b'), isTrue);
      expect(applied, <String>['#1b6b3a']);

      world.api.themes['tenant-a'] = themeJson('tenant-a', 2);
      final AuthService session = world.service();
      await session.signIn(kOidcConfig);
      final MachvonApiClient client = MachvonApiClient(baseUrl: testConfig.apiBaseUrl, transport: world.transport, token: session.accessToken);
      await client.execute('getMyPublishedTheme');
      expect(world.api.themeRequests, <String>['/v1/me/tenant/theme'], reason: 'the published theme of the session is the only theme the application reads');
      for (final HttpCall call in world.api.calls) {
        expect(call.url.path, isNot(contains('draft')));
      }
    });

    test('a published theme must carry its version, hash and date; a half theme is nothing', () {
      final Map<String, Object?> noHash = themeJson('tenant-a', 1)..remove('hash');
      expect(PublishedTheme.tryParse(noHash), isNull);
      final Map<String, Object?> noDate = themeJson('tenant-a', 1)..['publishedAt'] = 'yesterday';
      expect(PublishedTheme.tryParse(noDate), isNull);
      expect(PublishedTheme.tryParse(null), isNull);
      expect(PublishedTheme.fromStored(null), isNull);
      expect(PublishedTheme.fromStored(<String, Object?>{'tenant_id': 'a'}), isNull);
      expect(PublishedTheme.fromStored(<String, Object?>{'tenant_id': 'a', 'version': 1, 'hash': 'h', 'published_at': 'no', 'name': 'n', 'overlay': <String, Object?>{}}), isNull);
    });
  });

  group('AC-ST-MOB-004-3 TH05 TK-MOB-004-2 the tenant switch and the theme', () {
    test('the version never goes back, the same version is a no-op, a copy is kept per tenant and read back offline', () async {
      final List<Map<String, String>?> applied = <Map<String, String>?>[];
      final List<ActiveTheme?> active = <ActiveTheme?>[];
      TenantThemeService build(Future<Object?> Function() fetch) => TenantThemeService(
            store: world.store,
            publish: applied.add,
            activate: active.add,
            fetchMine: fetch,
          );
      final TenantThemeService service = build(() async => themeJson('tenant-a', 5, primary: '#0b4a8f'));

      expect(await service.refresh('tenant-a'), isTrue);
      expect(service.active!.version, 5);
      expect(await service.apply(_theme('tenant-a', 4, primary: '#1b6b3a'), tenantId: 'tenant-a'), isFalse, reason: 'an older version');
      expect(service.active!.version, 5);
      final int before = applied.length;
      expect(await service.apply(_theme('tenant-a', 5), tenantId: 'tenant-a'), isTrue, reason: 'the same version');
      expect(applied.length, before, reason: 'nothing is applied twice');
      expect(await service.apply(_theme('tenant-a', 6, primary: '#1b6b3a'), tenantId: 'tenant-a'), isTrue);
      expect(service.active!.version, 6);

      // The device restarts and the server cannot be reached: the last published version of the tenant is applied from the copy.
      final TenantThemeService offline = build(() async => throw StateError('offline'));
      expect(await offline.restore('tenant-a'), isTrue);
      expect(offline.active, ActiveTheme(tenantId: 'tenant-a', version: 6, hash: '06' * 32, fromCache: true));
      expect(await offline.refresh('tenant-a'), isFalse);
      expect(offline.active!.version, 6, reason: 'a failed refresh keeps what is shown');
      expect(await offline.restore('tenant-z'), isFalse);
      offline.clear();
      expect(offline.active, isNull);
      offline.clear();
      expect(applied.last, isNull);
    });

    test('a damaged copy on the device is ignored', () async {
      world.store.data['tenant.tenant-a.theme.v1'] = 'not json';
      final TenantThemeService service = TenantThemeService(
        store: world.store,
        publish: (Map<String, String>? overlay) {},
        activate: (ActiveTheme? theme) {},
        fetchMine: () async => null,
      );
      expect(await service.restore('tenant-a'), isFalse);
      expect(await service.refresh('tenant-a'), isFalse);
    });

    testWidgets('switching tenant shows the theme version the other tenant published, and the route, the scroll position and the form stay as they were', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      world = World(memberships: <String, List<FakeMembership>>{'sub-ana': <FakeMembership>[tenantAMember, tenantBMember]});
      world.api.themes['tenant-a'] = themeJson('tenant-a', 3, primary: '#0b4a8f');
      world.api.themes['tenant-b'] = themeJson('tenant-b', 7, primary: '#1b6b3a');
      final AuthService seed = world.service();
      await seed.signIn(kOidcConfig);
      await seed.selectContext((await seed.candidates()).first);

      final ProviderContainer container = await pumpSessionApp(
        tester,
        world,
        location: '/projects',
        features: <MobileFeature>[_formFeature],
        overrides: <Override>[
          secureValueStoreProvider.overrideWithValue(world.store),
          tenantThemeProvider.overrideWith(PublishedTenantTheme.new),
        ],
      );
      expect(container.read(activeThemeProvider)!.tenantId, 'tenant-a');
      expect(container.read(activeThemeProvider)!.version, 3);
      expect(container.read(appThemeProvider).colorScheme.primary, const Color(0xFF0B4A8F));

      await tester.enterText(find.byType(TextField), 'Ghi chú đang soạn');
      // The person put the keyboard away before scrolling (a focused field would bring its caret back into view on any restyle).
      FocusManager.instance.primaryFocus?.unfocus();
      await tester.pump();
      await tester.drag(find.byType(SingleChildScrollView), const Offset(0, -300));
      await tester.pump();
      final double scrolled = tester.state<ScrollableState>(find.byType(Scrollable).first).position.pixels;
      expect(scrolled, greaterThan(0));
      final String before = currentLocation(container);

      // The other tenant has published a newer version; the person switches to it.
      final AuthService service = container.read(authServiceProvider);
      final MembershipChoice other = (await service.candidates()).firstWhere((MembershipChoice c) => c.tenantId == 'tenant-b');
      await service.switchTenant(other);
      await tester.pumpAndSettle();

      expect(container.read(activeThemeProvider), ActiveTheme(tenantId: 'tenant-b', version: 7, hash: '07' * 32));
      expect(container.read(appThemeProvider).colorScheme.primary, const Color(0xFF1B6B3A));
      expect(currentLocation(container), before);
      expect(tester.widget<EditableText>(find.byType(EditableText)).controller.text, 'Ghi chú đang soạn');
      expect(tester.state<ScrollableState>(find.byType(Scrollable).first).position.pixels, scrolled);

      // It publishes again while the person is in it: pulling to refresh shows the new version, an older one never replaces it.
      world.api.themes['tenant-b'] = themeJson('tenant-b', 8, primary: '#4b2d83');
      expect(await (container.read(tenantThemeProvider.notifier) as PublishedTenantTheme).refresh(), isTrue);
      expect(container.read(activeThemeProvider)!.version, 8);
      world.api.themes['tenant-b'] = themeJson('tenant-b', 6, primary: '#1b6b3a');
      await (container.read(tenantThemeProvider.notifier) as PublishedTenantTheme).refresh();
      expect(container.read(activeThemeProvider)!.version, 8);
      expect(currentLocation(container), before);
      expect(tester.widget<EditableText>(find.byType(EditableText)).controller.text, 'Ghi chú đang soạn');
    });

    testWidgets('signing out puts the base theme back; the application opened offline shows the last published version of the tenant', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      world.api.themes['tenant-a'] = themeJson('tenant-a', 3);
      final AuthService seed = world.service();
      await seed.signIn(kOidcConfig);
      world.api.themeUnreachable = true;
      final TenantThemeService writer = TenantThemeService(
        store: world.store,
        publish: (Map<String, String>? overlay) {},
        activate: (ActiveTheme? theme) {},
        fetchMine: () async => themeJson('tenant-a', 3),
      );
      await writer.refresh('tenant-a');

      final ProviderContainer container = await pumpSessionApp(
        tester,
        world,
        overrides: <Override>[secureValueStoreProvider.overrideWithValue(world.store), tenantThemeProvider.overrideWith(PublishedTenantTheme.new)],
      );
      await tester.pumpAndSettle();
      expect(container.read(activeThemeProvider), ActiveTheme(tenantId: 'tenant-a', version: 3, hash: '03' * 32, fromCache: true));

      await container.read(authServiceProvider).signOut();
      await tester.pumpAndSettle();
      expect(container.read(activeThemeProvider), isNull);
      expect(container.read(tenantThemeProvider), isNull);
      expect(container.read(sessionProvider).status, SessionStatus.signedOut);
    });

    testWidgets('a session that expires keeps the theme of the tenant on screen', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      world.api.themes['tenant-a'] = themeJson('tenant-a', 3);
      await world.service().signIn(kOidcConfig);
      final ProviderContainer container = await pumpSessionApp(
        tester,
        world,
        overrides: <Override>[secureValueStoreProvider.overrideWithValue(world.store), tenantThemeProvider.overrideWith(PublishedTenantTheme.new)],
      );
      await tester.pumpAndSettle();
      expect(container.read(activeThemeProvider)!.version, 3);
      world.api.selectFailureStatus = 401;
      container.read(authServiceProvider).noteResponse(401, 'SESSION_EXPIRED');
      await tester.pumpAndSettle();
      expect(container.read(sessionProvider).status, SessionStatus.expired);
      expect(container.read(activeThemeProvider)!.version, 3);
    });
  });

  group('UI-MOB-01 every state', () {
    testWidgets('loading, a service error with retry, the time-out and no connection', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final Completer<TenantDiscovery> gate = Completer<TenantDiscovery>();
      ProviderContainer container = await _pumpWelcome(tester, world, _Directory((String q) => gate.future));
      await tester.enterText(find.byType(TextField), 'minh-ha');
      await tapText(tester, 'Tiếp tục');
      await tester.pump();
      expect(find.byType(LoadingView), findsOneWidget, reason: 'loading');
      gate.complete(_found());
      await tester.pumpAndSettle();
      expect(currentLocation(container), startsWith('/mob-02'));

      int calls = 0;
      container = await _pumpWelcome(
        tester,
        world,
        _Directory((String q) async {
          calls += 1;
          if (calls == 1) throw const ApiError(status: 500, code: 'INTERNAL_ERROR', correlationId: '3f2b6c1e-0000-4000-8000-000000000003');
          if (calls == 2) throw ApiError.network('3f2b6c1e-0000-4000-8000-000000000004');
          return _found();
        }),
      );
      await tester.enterText(find.byType(TextField), 'minh-ha');
      await tapText(tester, 'Tiếp tục');
      await tester.pumpAndSettle();
      expect(find.text('Chưa thể tải dữ liệu'), findsOneWidget, reason: 'error');
      expect(find.text('INTERNAL_ERROR'), findsOneWidget);
      await tapText(tester, 'Thử lại');
      await tester.pumpAndSettle();
      expect(find.text('Máy chủ phản hồi quá chậm'), findsOneWidget, reason: 'time-out');
      container.read(reachabilityProvider.notifier).report(Reachability.offline);
      await tapText(tester, 'Thử lại');
      await tester.pumpAndSettle();
      expect(currentLocation(container), startsWith('/mob-02'));
    });
  });
}

Widget _buildForm(BuildContext context, ScreenContext screen) => const _FormScreen();

const MobileFeature _formFeature = MobileFeature(id: 'form_host', screens: <ScreenSpec>[ScreenSpec(screenId: 'MOB-09', builder: _buildForm)]);

class _FormScreen extends StatelessWidget {
  const _FormScreen();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SingleChildScrollView(
        child: Column(
          children: <Widget>[
            const TextField(),
            for (int row = 0; row < 40; row += 1) SizedBox(height: 48, child: Text('Dòng $row')),
          ],
        ),
      ),
    );
  }
}
