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
import 'package:machvon_mobile/features/read_support/clock.dart';
import 'package:machvon_mobile/features/read_support/read_support_strings.dart';
import 'package:machvon_mobile/features/vendor_controls/vendor_strings.dart';

import '../../support/harness.dart';
import '../support/scripted_server.dart';

/// Opens one screen of the contractor controls on a scripted server, the way the application hosts it (theme, both languages, the strings of the core, of the
/// read support and of the feature, a signed-in session), without the router: the screens take their navigation as a parameter.
Future<ProviderContainer> openVendorScreen(WidgetTester tester, ScriptedServer server, Widget screen, {Locale locale = const Locale('vi')}) async {
  final ProviderContainer container = ProviderContainer(
    overrides: <Override>[
      appConfigProvider.overrideWithValue(testConfig),
      sessionProvider.overrideWith(FakeSession.new),
      httpTransportProvider.overrideWith((Ref ref) => ObservingTransport(server, ref.read(reachabilityProvider.notifier).report)),
      clockProvider.overrideWithValue(() => DateTime.utc(2026, 11, 3, 3)),
    ],
  );
  addTearDown(container.dispose);
  await tester.pumpWidget(
    UncontrolledProviderScope(
      key: UniqueKey(),
      container: container,
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: buildAppTheme(),
        locale: locale,
        supportedLocales: const <Locale>[Locale('vi'), Locale('en')],
        localizationsDelegates: <LocalizationsDelegate<Object?>>[
          AppStringsDelegate(StringCatalogue(<StringTable>[kCoreStrings, readSupportStrings, vendorStrings])),
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        home: screen,
      ),
    ),
  );
  await tester.pumpAndSettle();
  return container;
}

const String kVendorAsOf = '2026-11-03T03:00:00.000Z';

Map<String, Object?> riskItem(String id, String name, String tier, int score, {bool overdue = false, String? pending, String? cursor}) => <String, Object?>{
      'contractor_id': id,
      'legal_name': name,
      'tax_identifier': '0101234567',
      'tier': tier,
      'score': score,
      'next_review_on': '2027-02-03',
      'review_overdue': overdue,
      'assessment_id': 'a-$id',
      'pending_assessment_id': pending == null ? null : 'p-$id',
      'pending_tier': pending,
      'cursor': cursor ?? id,
    };

Map<String, Object?> policy({bool unverified = true}) => <String, Object?>{'code': 'VENDOR_RISK', 'version': '3', 'unverified': unverified, 'formula': 'f', 'source': 's', 'as_of': '2026-11-01', 'params': <String, Object?>{}};

Map<String, Object?> riskPage(List<Map<String, Object?>> items, {String? next}) => <String, Object?>{
      'items': items,
      'next_cursor': next,
      'policy': policy(),
      'figures': <Object?>[
        <String, Object?>{'code': 'VENDOR_RISK_HIGH_SHARE', 'numerator': 2, 'denominator': 9, 'as_of': '2026-11-03'},
      ],
      'as_of': kVendorAsOf,
    };

Map<String, Object?> factorLine(String factor, int points, int max, Map<String, Object?> reading) => <String, Object?>{'factor': factor, 'points': points, 'max': max, 'reading': reading};

Map<String, Object?> snapshot(String state, String tier, int score, {String? reason}) => <String, Object?>{
      'id': 's-$state',
      'contractor_id': 'c-1',
      'contractor_name': 'Công ty Xây dựng An Phát',
      'score': score,
      'tier': tier,
      'score_tier': tier,
      'floored': false,
      'factors': <Object?>[],
      'reasons': <Object?>[],
      'inputs': <String, Object?>{},
      'rule_version': '3',
      'rule_unverified': true,
      'review_months': 6,
      'next_review_on': '2027-05-03',
      'dual_check': true,
      'as_of': '2026-10-20',
      'state': state,
      'assessed_by': 'u-1',
      'assessed_by_name': 'Trần Thị Bình',
      'assessed_at': '2026-10-20T03:00:00.000Z',
      'decided_by': 'u-2',
      'decided_by_name': 'Lê Văn Cường',
      'decided_at': '2026-10-21T03:00:00.000Z',
      'decision_reason': reason ?? 'Đã đối chiếu hồ sơ',
      'version': 1,
      'can_decide': false,
    };

Map<String, Object?> riskGrade({bool floored = true}) => <String, Object?>{
      'contractor_id': 'c-1',
      'contractor_name': 'Công ty Xây dựng An Phát',
      'tier': 'HIGH',
      'confirmed': snapshot('CONFIRMED', 'HIGH', 52),
      'pending': snapshot('PROPOSED', 'CRITICAL', 81, reason: ''),
      'live': <String, Object?>{
        'score': 14,
        'tier': 'HIGH',
        'score_tier': 'LOW',
        'floored': floored,
        'factors': <Object?>[
          factorLine('RESTRICTION', 10, 10, <String, Object?>{'in_force': 1, 'past': 0}),
          factorLine('PROFILE_GAP', 4, 10, <String, Object?>{'coverage_pct': 60}),
          factorLine('FINANCE_BELOW', 0, 8, <String, Object?>{'finance': 'MEETS'}),
          factorLine('LOAD_OVER', 0, 6, <String, Object?>{'load': 'WITHIN'}),
        ],
        'reasons': <Object?>['RESTRICTION', 'PROFILE_GAP'],
        'review_months': 6,
        'next_review_on': '2027-05-03',
        'dual_check': true,
        'inputs': <String, Object?>{},
      },
      'history': <Object?>[snapshot('CONFIRMED', 'HIGH', 52), snapshot('SUPERSEDED', 'MEDIUM', 33)],
      'policy': policy(),
      'as_of': kVendorAsOf,
    };

Map<String, Object?> performanceLine(String contract, String rating, {String clock = 'OVERDUE', String review = 'NOT_ANSWERED', bool published = false}) => <String, Object?>{
      'proposal_id': 'pr-$contract',
      'contract_id': 'ct-$contract',
      'contract_code': contract,
      'contractor_id': 'c-1',
      'contractor_name': 'Công ty Xây dựng An Phát',
      'evaluation_kind': 'FINAL',
      'period_label': 'Giai đoạn 2',
      'state': 'ADOPTED',
      'rating': rating,
      'score': '62.5',
      'construction': true,
      'adopted_on': '2026-09-10',
      'ended_on': '2026-09-01',
      'response_kind': 'NONE',
      'publication_due_on': '2026-10-10',
      'publication_clock': clock,
      'publication': published ? <String, Object?>{'id': 'pub'} : null,
      'updates': published ? <Object?>[<String, Object?>{'id': 'u1'}] : <Object?>[],
      'response_review': review,
      'obligation': <String, Object?>{'id': 'o1', 'state': 'OPEN'},
      'can_post': false,
    };

Map<String, Object?> performance({List<Map<String, Object?>>? lines, String suggestion = 'REMEDY_PLAN', int streak = 2}) => <String, Object?>{
      'contractor_id': 'c-1',
      'contractor_name': 'Công ty Xây dựng An Phát',
      'lines': lines ?? <Map<String, Object?>>[performanceLine('HD-001', 'POOR'), performanceLine('HD-002', 'GOOD', clock: 'MET', review: 'CLOSED', published: true)],
      'streak': streak,
      'suggestion': suggestion,
      'retrospect_proposal_ids': <Object?>[],
      'policy': policy(unverified: false),
      'as_of': kVendorAsOf,
    };
