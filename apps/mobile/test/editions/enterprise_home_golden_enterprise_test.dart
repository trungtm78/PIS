import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/api/dart_io_transport.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/di/providers.dart';
import 'package:machvon_mobile/core/l10n/app_strings.dart';
import 'package:machvon_mobile/core/l10n/core_strings.dart';
import 'package:machvon_mobile/core/l10n/string_table.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/core/theme/app_theme.dart';
import 'package:machvon_mobile/editions/enterprise/enterprise_home.dart';
import 'package:machvon_mobile/editions/enterprise/enterprise_profile.dart';
import 'package:machvon_mobile/features/account/account_providers.dart';
import 'package:machvon_mobile/features/account/account_strings.dart';
import 'package:machvon_mobile/features/dashboard/widgets/edition_cards.dart';
import 'package:machvon_mobile/features/read_support/read_support_strings.dart';
import 'package:machvon_mobile/features/session/auth/identity_api.dart';

import '../features/support/scripted_server.dart';
import '../support/harness.dart';
import '../support/v2_support.dart';

// This test names the enterprise folder, so its name ends in `enterprise_test.dart` (the edition check lets only such tests do so).

/// Golden images of the enterprise home on the v2 theme (MUX-3 wave D): the head with the logo of the edition, its own name, the product and
/// the organisation and role of the session, and the three cards (period, HPM, EBS), in the light mode, the dark mode and at 200 percent text.
/// The edition keeps its own words and its own logo; the colours are those of the theme, so the dark mode reads as well as the light one.

ScriptedServer _server() => ScriptedServer()
  ..on('GET', '/resources/reporting_period', (_) => <String, Object?>{
        'items': <Object?>[
          <String, Object?>{'code': 'KY-NOW', 'start_date': '2000-01-01', 'end_date': '2999-12-31', 'deadline_at': '2999-12-31T10:00:00.000Z', 'locked_at': null, 'today': vietnamTodayText()},
        ],
      })
  ..on('GET', '/hpm/connection', (_) => <String, Object?>{
        'health': <String, Object?>{'status': 'AGING', 'awaiting_receipt': 2, 'push_blocked': true},
        'counts': <String, Object?>{'pushes': 7, 'written': 1, 'accepted': 4, 'failed': 2, 'rejected': 1},
      })
  ..on('GET', '/ebs/differences', (_) => <String, Object?>{
        'items': <Object?>[],
        'next_cursor': null,
        'counts': <String, Object?>{'open': 3, 'resolved': 5, 'overdue': 1, 'reviews_due': 2},
        'as_of': '2026-11-03T03:00:00.000Z',
      });

Future<void> _open(WidgetTester tester, {Brightness brightness = Brightness.light, double scale = 1.0}) async {
  useDevice(tester, const Size(390, 844), textScale: scale);
  final ScriptedServer server = _server();
  final MembershipChoice mine = MembershipChoice(
    tenantId: 'tenant-b',
    tenantName: 'Tổng công ty Đạm Phú Mỹ',
    tenantStatus: 'Active',
    membershipId: 'm-1',
    membershipType: 'STAFF',
    status: 'Active',
    validFrom: DateTime(2026),
  );
  final ProviderContainer container = ProviderContainer(
    overrides: <Override>[
      appConfigProvider.overrideWithValue(testConfig),
      editionProfileProvider.overrideWithValue(kEnterpriseEditionProfile),
      sessionProvider.overrideWith(() => FakeSession(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-b', userId: 'user-1', membershipId: 'm-1'))),
      myMembershipsProvider.overrideWith((Ref ref) async => <MembershipChoice>[mine]),
      httpTransportProvider.overrideWith((Ref ref) => ObservingTransport(server, ref.read(reachabilityProvider.notifier).report)),
    ],
  );
  addTearDown(container.dispose);
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp(
        theme: buildAppTheme(brightness: brightness),
        locale: const Locale('vi'),
        supportedLocales: const <Locale>[Locale('vi'), Locale('en')],
        localizationsDelegates: <LocalizationsDelegate<Object?>>[
          AppStringsDelegate(StringCatalogue(<StringTable>[kCoreStrings, readSupportStrings, accountStrings, kEnterpriseEditionProfile.homeStrings!])),
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        home: const Scaffold(body: SingleChildScrollView(child: Column(children: <Widget>[EditionHomeHeader(), EditionHomeCards()]))),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  useTolerantGoldens('test/editions/enterprise_home_golden_enterprise_test.dart', tolerance: kTextGoldenTolerance);

  testWidgets('the enterprise home, light', (WidgetTester tester) async {
    await _open(tester);
    expect(find.text('Mạch Vốn'), findsOneWidget);
    expect(find.text('Tổng công ty Đạm Phú Mỹ, Cán bộ của tổ chức'), findsOneWidget);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/enterprise_home_light.png'));
  });

  testWidgets('the enterprise home, dark: the identity and the cards are drawn in the colours of the dark theme', (WidgetTester tester) async {
    await _open(tester, brightness: Brightness.dark);
    expect(Theme.of(tester.element(find.text('Mạch Vốn'))).brightness, Brightness.dark);
    // The name of the edition is the strong primary of the dark palette (light teal on the dark surface), not a colour made for the light one.
    final Text name = tester.widget<Text>(find.text('Mạch Vốn'));
    expect(name.style!.color, MachvonV2.dark.palette.primaryStrong);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/enterprise_home_dark.png'));
  });

  testWidgets('the enterprise home, text 200 percent', (WidgetTester tester) async {
    await _open(tester, scale: 2.0);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/enterprise_home_text200.png'));
  });
}
