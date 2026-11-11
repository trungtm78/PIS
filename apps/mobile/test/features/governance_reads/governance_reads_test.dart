import 'package:flutter/foundation.dart' show debugDefaultTargetPlatformOverride;
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
import 'package:machvon_mobile/features/governance_reads/reads_models.dart';
import 'package:machvon_mobile/features/governance_reads/reads_strings.dart';
import 'package:machvon_mobile/features/governance_reads/screens/reads_screens.dart';
import 'package:machvon_mobile/features/read_support/clock.dart';
import 'package:machvon_mobile/features/read_support/read_support_strings.dart';

import '../../support/harness.dart';
import '../support/scripted_server.dart';

/// MOB-75, MOB-76, MOB-77: read-only views of delegations and absences, the KPI register and the report catalogue.

Future<void> _open(WidgetTester tester, ScriptedServer server, Widget screen, {Locale locale = const Locale('vi')}) async {
  tester.view.physicalSize = const Size(390, 3000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
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
        theme: buildAppTheme(),
        locale: locale,
        supportedLocales: const <Locale>[Locale('vi'), Locale('en')],
        localizationsDelegates: <LocalizationsDelegate<Object?>>[
          AppStringsDelegate(StringCatalogue(<StringTable>[kCoreStrings, readSupportStrings, readsStrings])),
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        home: screen,
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Map<String, Object?> _rule() => <String, Object?>{'code': 'ALERT_COVERAGE', 'version': '2', 'unverified': true, 'formula': 'f', 'source': 's', 'as_of': '2026-11-01', 'params': <String, Object?>{}};

Map<String, Object?> _absences() => <String, Object?>{
      'items': <Object?>[
        <String, Object?>{'id': 'a-1', 'membership_id': 'm-1', 'name': 'Trần Thị Bình', 'kind': 'LEAVE', 'valid_from': '2026-11-10', 'valid_until': '2026-11-20', 'effective_until': '2026-11-20', 'status': 'APPROVED', 'phase': 'ACTIVE', 'coverage': 'UNCOVERED', 'covers': <Object?>[], 'version': 1},
      ],
      'pending_covers': <Object?>[
        <String, Object?>{'id': 'c-1', 'absence_id': 'a-1', 'absent': <String, Object?>{'id': 'm-1', 'name': 'Trần Thị Bình'}, 'deputy': <String, Object?>{'id': 'm-2', 'name': 'Lê Văn Cường'}, 'valid_from': '2026-11-10', 'valid_until': '2026-11-20', 'scope_kind': 'ALL', 'sources': <Object?>[], 'status': 'PENDING', 'in_force': false, 'requested_by': 'u', 'version': 1},
      ],
      'rule': _rule(),
      'as_of': '2026-11-03T03:00:00.000Z',
    };

Map<String, Object?> _grants() => <String, Object?>{
      'items': <Object?>[
        <String, Object?>{'id': 'g-1', 'status': 'Active', 'valid_from': '2026-11-01T00:00:00.000Z', 'valid_until': '2026-12-01T00:00:00.000Z', 'permissions': <Object?>['a.read', 'b.read'], 'reason': 'Công tác nước ngoài'},
      ],
      'next_cursor': null,
      'as_of': '2026-11-03T03:00:00.000Z',
    };

/// The accessibility contract of a read screen: tap targets large enough on both platforms, every control named and the text readable,
/// at the normal text size and at 200 percent (the reference of the phone sweep).
Future<void> _expectAccessible(WidgetTester tester) async {
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
  for (final double scale in <double>[1.0, 2.0]) {
    tester.platformDispatcher.textScaleFactorTestValue = scale;
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull, reason: 'at $scale');
    try {
      debugDefaultTargetPlatformOverride = TargetPlatform.android;
      await expectLater(tester, meetsGuideline(androidTapTargetGuideline), reason: 'at $scale');
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      await expectLater(tester, meetsGuideline(iOSTapTargetGuideline), reason: 'at $scale');
    } finally {
      debugDefaultTargetPlatformOverride = null;
    }
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline), reason: 'at $scale');
    await expectLater(tester, meetsGuideline(textContrastGuideline), reason: 'at $scale');
  }
}

void main() {
  group('the models', () {
    test('delegations keep each part on its own: a part that was not read is null, not an empty list', () {
      final DelegationsView both = parseDelegations(grants: _grants(), absences: _absences())!;
      expect(both.grants, hasLength(1));
      expect(both.grants!.single.permissions, 2);
      expect(both.absences!.single.coverage, 'UNCOVERED');
      expect(both.covers!.single.deputy, 'Lê Văn Cường');
      expect(both.unverified, isTrue);
      final DelegationsView onlyAbsences = parseDelegations(grants: null, absences: _absences())!;
      expect(onlyAbsences.grants, isNull);
      expect(onlyAbsences.absences, isNotNull);
      expect(parseDelegations(grants: null, absences: null), isNull);
    });

    test('the KPI register and the report catalogue need their lists, and drop rows without a code or a name', () {
      expect(parseKpiRegister(<String, Object?>{'as_of': '2026-11-03'}), isNull);
      final KpiRegister kpi = parseKpiRegister(<String, Object?>{
        'as_of': '2026-11-03',
        'definitions': <Object?>[
          <String, Object?>{'code': 'K1', 'name': 'Giải ngân', 'version': 3, 'unverified': true, 'certification': <String, Object?>{'status': 'CERTIFIED'}},
          <String, Object?>{'code': 'K2'},
        ],
      })!;
      expect(kpi.items, hasLength(1));
      expect(kpi.items.single.version, '3');
      expect(kpi.items.single.certification, 'CERTIFIED');
      expect(parseReportCatalogue(<String, Object?>{'demo_mode': true}), isNull);
    });
  });

  group('the screens', () {
    testWidgets('MOB-75 shows delegations, absences with their cover, and the cover requests, read only', (WidgetTester tester) async {
      final ScriptedServer server = ScriptedServer()
        ..on('GET', '/resources/delegation_grant', (_) => _grants())
        ..on('GET', '/home/alert-absences', (_) => _absences());
      final SemanticsHandle semantics = tester.ensureSemantics();
      await _open(tester, server, const DelegationsScreen());
      expect(find.textContaining('Chỉ đọc'), findsOneWidget);
      expect(find.textContaining('Công tác nước ngoài'), findsOneWidget);
      expect(find.textContaining('Trần Thị Bình'), findsWidgets);
      expect(find.text('Chưa có người thay'), findsOneWidget);
      expect(find.textContaining('Các ngưỡng của quy tắc chưa được kiểm chứng'), findsOneWidget);
      expect(find.byType(ElevatedButton), findsNothing);
      expect(find.byType(FilledButton), findsNothing);
      await _expectAccessible(tester);
      semantics.dispose();
    });

    testWidgets('MOB-75 says which part could not be read when the delegation register is refused', (WidgetTester tester) async {
      final ScriptedServer server = ScriptedServer()
        ..refuse('GET', '/resources/delegation_grant', 403, 'FORBIDDEN')
        ..on('GET', '/home/alert-absences', (_) => _absences());
      await _open(tester, server, const DelegationsScreen());
      expect(find.text('Phần này chưa đọc được hoặc bạn chưa có quyền xem.'), findsOneWidget);
      expect(find.textContaining('Trần Thị Bình'), findsWidgets);
    });

    testWidgets('MOB-76 shows the definition of each indicator with its version and certification', (WidgetTester tester) async {
      final ScriptedServer server = ScriptedServer()
        ..on('GET', '/home/kpi-register', (_) => <String, Object?>{
              'as_of': '2026-11-03',
              'definitions': <Object?>[
                <String, Object?>{'code': 'DISB', 'name': 'Tỷ lệ giải ngân', 'version': 2, 'formula': 'a / b', 'numerator': 'đã giải ngân', 'denominator': 'kế hoạch vốn', 'unit': '%', 'period': 'MONTH', 'source': 'Kho bạc', 'owner': 'Sở Tài chính', 'unverified': true, 'certification': null},
              ],
            });
      final SemanticsHandle semantics = tester.ensureSemantics();
      await _open(tester, server, const KpiRegisterScreen());
      expect(find.text('Tỷ lệ giải ngân'), findsOneWidget);
      expect(find.text('Công thức: a / b'), findsOneWidget);
      expect(find.text('Chưa chứng nhận'), findsOneWidget);
      expect(find.text('Chưa kiểm chứng'), findsOneWidget);
      await _expectAccessible(tester);
      semantics.dispose();
    });

    testWidgets('MOB-77 shows the forms, labels a demo form and does not offer to issue anything', (WidgetTester tester) async {
      final ScriptedServer server = ScriptedServer()
        ..on('GET', '/report-engine/catalogue', (_) => <String, Object?>{
              'demo_mode': true,
              'can_generate': true,
              'as_of': '2026-11-03',
              'items': <Object?>[
                <String, Object?>{'code': 'BC01', 'name': 'Báo cáo giải ngân', 'version': '1', 'edition': 'PUBLIC', 'status': 'ACTIVE', 'official': 'OFFICIAL', 'form_ref': null, 'receiver': 'UBND tỉnh', 'period_kind': 'MONTH', 'has_narrative': true, 'data_source': 'x', 'demo_mark': 'MẪU THỬ', 'registered': true, 'issuable': false, 'whole_tenant': true},
              ],
            });
      final SemanticsHandle semantics = tester.ensureSemantics();
      await _open(tester, server, const ReportCatalogueScreen());
      expect(find.text('Báo cáo giải ngân'), findsOneWidget);
      expect(find.text('Mẫu thử: MẪU THỬ'), findsOneWidget);
      expect(find.text('Chưa thể phát hành'), findsOneWidget);
      expect(find.byType(FilledButton), findsNothing);
      expect(find.byType(ElevatedButton), findsNothing);
      await _expectAccessible(tester);
      semantics.dispose();
    });
  });
}
