import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/api/dart_io_transport.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/di/providers.dart';
import 'package:machvon_mobile/core/edition/edition.dart';
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

// This test names the enterprise folder, so its name ends in `enterprise_test.dart` (the edition check lets only such tests do so).

Future<void> _open(WidgetTester tester, ScriptedServer server, EditionProfile profile) async {
  tester.view.physicalSize = const Size(390, 2000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final ProviderContainer container = ProviderContainer(
    overrides: <Override>[
      appConfigProvider.overrideWithValue(testConfig),
      editionProfileProvider.overrideWithValue(profile),
      sessionProvider.overrideWith(FakeSession.new),
      httpTransportProvider.overrideWith((Ref ref) => ObservingTransport(server, ref.read(reachabilityProvider.notifier).report)),
    ],
  );
  addTearDown(container.dispose);
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp(
        theme: buildAppTheme(),
        locale: const Locale('vi'),
        supportedLocales: const <Locale>[Locale('vi'), Locale('en')],
        localizationsDelegates: <LocalizationsDelegate<Object?>>[
          AppStringsDelegate(StringCatalogue(<StringTable>[kCoreStrings, readSupportStrings, if (profile.homeStrings != null) profile.homeStrings!])),
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        home: const Scaffold(body: SingleChildScrollView(child: EditionHomeCards())),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

String _today() => vietnamTodayText();

void main() {
  group('the enterprise home cards on the phone', () {
    test('they are the profile cards of the enterprise edition, with their own words in both languages, and the public edition has none', () {
      expect(kEnterpriseEditionProfile.homeCards, hasLength(3));
      expect(kPublicEditionProfile.homeCards, isEmpty);
      final StringTable words = kEnterpriseEditionProfile.homeStrings!;
      expect(words.vi.keys.toSet(), words.en.keys.toSet());
    });

    test('the period that runs today is chosen, else the next one that starts', () {
      final List<Object?> items = <Object?>[
        <String, Object?>{'code': '2026-09', 'start_date': '2026-09-01', 'end_date': '2026-09-30'},
        <String, Object?>{'code': '2026-11', 'start_date': '2026-11-01', 'end_date': '2026-11-30'},
        <String, Object?>{'code': '2027-01', 'start_date': '2027-01-01', 'end_date': '2027-01-31'},
      ];
      expect(currentPeriod(items, '2026-11-09')!['code'], '2026-11');
      expect(currentPeriod(items, '2026-12-15')!['code'], '2027-01');
      expect(currentPeriod(items, '2027-03-01'), isNull);
    });

    testWidgets('MOB-ENT-03 the enterprise head names the product, the organisation and the role of the session, and the public edition has none', (WidgetTester tester) async {
      final MembershipChoice mine = MembershipChoice(
        tenantId: 'tenant-b',
        tenantName: 'Tổng công ty Đạm Phú Mỹ',
        tenantStatus: 'Active',
        membershipId: 'm-1',
        membershipType: 'STAFF',
        status: 'Active',
        validFrom: DateTime(2026),
      );
      final MembershipChoice other = MembershipChoice(
        tenantId: 'tenant-a',
        tenantName: 'Hà Giang',
        tenantStatus: 'Active',
        membershipId: 'm-1',
        membershipType: 'GUEST_CONTRACTOR',
        status: 'Active',
        validFrom: DateTime(2026),
      );
      Future<void> pump(EditionProfile profile) async {
        final ProviderContainer container = ProviderContainer(
          overrides: <Override>[
            appConfigProvider.overrideWithValue(testConfig),
            editionProfileProvider.overrideWithValue(profile),
            sessionProvider.overrideWith(() => FakeSession(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-b', userId: 'user-1', membershipId: 'm-1'))),
            myMembershipsProvider.overrideWith((Ref ref) async => <MembershipChoice>[other, mine]),
          ],
        );
        addTearDown(container.dispose);
        await tester.pumpWidget(
          UncontrolledProviderScope(
            container: container,
            child: MaterialApp(
              theme: buildAppTheme(),
              locale: const Locale('vi'),
              supportedLocales: const <Locale>[Locale('vi'), Locale('en')],
              localizationsDelegates: <LocalizationsDelegate<Object?>>[
                AppStringsDelegate(StringCatalogue(<StringTable>[kCoreStrings, accountStrings, if (profile.homeStrings != null) profile.homeStrings!])),
                GlobalMaterialLocalizations.delegate,
                GlobalWidgetsLocalizations.delegate,
                GlobalCupertinoLocalizations.delegate,
              ],
              home: const Scaffold(body: EditionHomeHeader()),
            ),
          ),
        );
        await tester.pumpAndSettle();
      }

      await pump(kEnterpriseEditionProfile);
      expect(find.text('Phần mềm quản lý đầu tư xây dựng'), findsOneWidget);
      expect(find.text('Tổng công ty Đạm Phú Mỹ, Cán bộ của tổ chức'), findsOneWidget);
      expect(find.textContaining('Hà Giang'), findsNothing);

      await pump(kPublicEditionProfile);
      expect(find.byType(Text), findsNothing);
    });

    testWidgets('the public edition draws nothing', (WidgetTester tester) async {
      await _open(tester, ScriptedServer(), kPublicEditionProfile);
      expect(find.byType(Card), findsNothing);
    });

    testWidgets('the enterprise edition reads the three operations and shows the period, HPM and EBS status', (WidgetTester tester) async {
      final String today = _today();
      final ScriptedServer server = ScriptedServer()
        ..on('GET', '/resources/reporting_period', (_) => <String, Object?>{
              'items': <Object?>[
                <String, Object?>{'code': 'KY-NOW', 'start_date': '2000-01-01', 'end_date': '2999-12-31', 'deadline_at': '2999-12-31T10:00:00.000Z', 'locked_at': null, 'today': today},
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
      await _open(tester, server, kEnterpriseEditionProfile);
      expect(find.textContaining('Kỳ KY-NOW'), findsOneWidget);
      expect(find.text('Kỳ đang mở'), findsOneWidget);
      expect(find.text('Tình trạng: Sắp cũ'), findsOneWidget);
      expect(find.text('7 lượt đẩy, 4 được nhận, 2 lỗi, 1 bị từ chối'), findsOneWidget);
      expect(find.text('Việc đẩy đang bị chặn.'), findsOneWidget);
      expect(find.text('3 chênh lệch đang mở, 1 quá hạn, 5 đã xử lý'), findsOneWidget);
      expect(find.byType(FilledButton), findsNothing);
    });

    testWidgets('a card whose read is refused is not drawn, and one whose read failed says so', (WidgetTester tester) async {
      final ScriptedServer server = ScriptedServer()
        ..refuse('GET', '/resources/reporting_period', 403, 'FORBIDDEN')
        ..refuse('GET', '/hpm/connection', 403, 'FORBIDDEN')
        ..refuse('GET', '/ebs/differences', 503, 'SERVICE_UNAVAILABLE');
      await _open(tester, server, kEnterpriseEditionProfile);
      expect(find.text('Kỳ báo cáo'), findsNothing);
      expect(find.text('Đẩy số liệu sang HPM'), findsNothing);
      expect(find.text('Đối chiếu EBS'), findsOneWidget);
      expect(find.text('Chưa đọc được phần này.'), findsOneWidget);
    });
  });
}
