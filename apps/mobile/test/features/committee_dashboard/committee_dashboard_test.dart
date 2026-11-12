import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
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
import 'package:machvon_mobile/features/committee_dashboard/committee_dashboard.dart';
import 'package:machvon_mobile/features/committee_dashboard/committee_dashboard_strings.dart';
import 'package:machvon_mobile/features/committee_dashboard/screens/committee_dashboard_screen.dart';
import 'package:machvon_mobile/features/dashboard/committee_workspace.dart' show CommitteeReason;
import 'package:machvon_mobile/features/dashboard/dashboard_strings.dart';
import 'package:machvon_mobile/features/read_support/clock.dart';
import 'package:machvon_mobile/features/read_support/read_support_strings.dart';

import '../../support/harness.dart';
import '../dashboard/committee_fixtures.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';

/// MOB-72, the committee dashboard on the phone: one audited read of the workspace, the progress by four cuts, the whole attention list, the units that do not
/// report, the late directives and the live alerts. Read only, no copy kept on the device, no figure the server did not send.

const String _path = '/committee/workspace';

/// The list builds what is near the window, so a test that reads the whole page uses a window as tall as the page.
const Size _veryTall = Size(390, 9000);

Future<ProviderContainer> _open(WidgetTester tester, ScriptedServer server, {Locale locale = const Locale('vi')}) async {
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
          AppStringsDelegate(StringCatalogue(<StringTable>[kCoreStrings, readSupportStrings, dashboardStrings, committeeDashboardStrings])),
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        home: const CommitteeDashboardScreen(),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return container;
}

Map<String, Object?> _row(String dimension, String key, String label, {String rag = 'RED', String? rate = '30.00', String? disbursed = '30000000000', String gap = '-15.30', int unknown = 0, int known = 2, int total = 2}) => <String, Object?>{
      'dimension': dimension,
      'key': key,
      'label': label,
      'projects': 5,
      'plan_share_pct': '25.00',
      'attention_projects': 2,
      'plan_vnd': '100000000000',
      'disbursed_vnd': disbursed,
      'rate_pct': rate,
      'last_year_vnd': null,
      'last_year_coverage': <String, Object?>{'known': known, 'total': total},
      'change_vs_last_year_vnd': null,
      'expected_pct': '45.30',
      'gap_points': rate == null ? null : gap,
      'rag': rag,
      'outlook': <String, Object?>{'low_vnd': null, 'high_vnd': null, 'low_pct': null, 'high_pct': null, 'methods': <Object?>[], 'thin': false, 'reason': 'NO_DATA'},
      'unknown_lines': unknown,
    };

Map<String, Object?> _unit(String name, {bool notReporting = true, String reason = 'STALE', String? last = '2026-10-01', int? days = 33}) => <String, Object?>{
      'unit_id': '00000000-0000-4000-8000-0000000000b1',
      'unit_name': name,
      'expected': 4,
      'received': 1,
      'reporting_rate_pct': '25.00',
      'last_reported_on': last,
      'days_since_report': days,
      'not_reporting': notReporting,
      'reason': reason,
    };

Map<String, Object?> _directive(String code, {String phase = 'OVERDUE', int overdue = 9, String? project = 'DA-001'}) => <String, Object?>{
      'id': '00000000-0000-4000-8000-0000000000d1',
      'code': code,
      'text': 'Hoàn thành giải phóng mặt bằng trước ngày 30/10',
      'project_id': null,
      'project_code': project,
      'assignee_unit_id': '00000000-0000-4000-8000-0000000000aa',
      'assignee_unit_name': 'Ban quản lý 1',
      'due_on': '2026-10-22',
      'overdue_days': overdue,
      'phase': phase,
      'status': 'OPEN',
      'extension_count': 1,
    };

Map<String, Object?> _full() {
  final Map<String, Object?> body = committeeWorkspace();
  body['by_sector'] = <Object?>[_row('SECTOR', 'GT', 'Giao thông'), _row('SECTOR', 'YT', 'Y tế', rag: 'GREEN', rate: '50.00', gap: '4.70'), _row('SECTOR', 'GD', 'Giáo dục', rag: 'NO_DATA', rate: null, disbursed: null, unknown: 2, known: 1, total: 3)];
  body['by_district'] = <Object?>[_row('DISTRICT', 'A', 'Huyện A', rag: 'AMBER')];
  body['by_investor'] = <Object?>[_row('INVESTOR', 'i1', 'Ban quản lý 1')];
  body['by_fund_source'] = <Object?>[_row('FUND_SOURCE', 'NSTW', 'Ngân sách trung ương', rag: 'GREEN', rate: '47.00', gap: '1.70')];
  body['units'] = <Object?>[_unit('Sở Xây dựng'), _unit('Sở Y tế', reason: 'NEVER_REPORTED', last: null, days: null), _unit('Sở Giáo dục', notReporting: false)];
  body['directives'] = <String, Object?>{
    'as_of': '2026-10-31',
    'units': <Object?>[
      <String, Object?>{'unit_id': '00000000-0000-4000-8000-0000000000aa', 'unit_name': 'Ban quản lý 1', 'open': 3, 'overdue': 2, 'escalated': 1, 'oldest_overdue_days': 20},
    ],
    'directives': <Object?>[_directive('CD-001', phase: 'ESCALATED', overdue: 20), _directive('CD-002')],
    'totals': <String, Object?>{'open': 3, 'overdue': 2, 'escalated': 1},
    'truncated': true,
    'escalate_after_days': 14,
    'figures': <Object?>[],
  };
  final Map<String, Object?> alert = committeeAlert('a1', 'COMMITTEE_PROVINCE_BEHIND', 'URGENT')
    ..['expected_action'] = 'Họp rà soát tiến độ với các sở'
    ..['consequence'] = 'Tỉnh không kịp kế hoạch giải ngân năm';
  final Map<String, Object?> acknowledged = committeeAlert('a2', 'COMMITTEE_UNIT_NOT_REPORTING', 'WATCH', status: 'ACKNOWLEDGED', label: 'Sở Xây dựng')..['acknowledged_by_name'] = 'Nguyễn Văn An';
  body['alerts'] = <Object?>[alert, acknowledged, committeeAlert('a3', 'COMMITTEE_DIRECTIVE_OVERDUE', 'ACTION', status: 'RESOLVED')];
  return body;
}

ScriptedServer _server([Map<String, Object?>? body]) => ScriptedServer()..on('GET', _path, (_) => body ?? _full());

void main() {
  group('the model of the dashboard', () {
    test('reads the rows, the whole attention list in rank order, only the units that do not report, the directives and the live alerts', () {
      final CommitteeDashboard dashboard = parseCommitteeDashboard(_full())!;
      expect(dashboard.rows[CommitteeDimension.sector]!.map((CommitteeRow row) => row.label), <String>['Giao thông', 'Y tế', 'Giáo dục']);
      expect(dashboard.rows[CommitteeDimension.sector]![2].hasRate, isFalse, reason: 'a rate the server holds back is unknown, not zero');
      expect(dashboard.projects.map((CommitteeProject project) => project.code), <String>['DA-001', 'DA-002', 'DA-003', 'DA-004']);
      expect(dashboard.projects.first.signals.map((CommitteeSignal signal) => signal.reason), <CommitteeReason>[CommitteeReason.delayed, CommitteeReason.stalled]);
      expect(dashboard.attentionTotal, 7);
      expect(dashboard.attentionMore, 3);
      expect(dashboard.unitsNotReporting.map((CommitteeUnit unit) => unit.name), <String>['Sở Xây dựng', 'Sở Y tế']);
      expect(dashboard.unitsNotReporting[1].reason, CommitteeUnitReason.neverReported);
      expect(dashboard.directives!.directives.first.escalated, isTrue);
      expect(dashboard.directives!.truncated, isTrue);
      expect(dashboard.alerts.map((CommitteeAlertLine alert) => alert.acknowledged), <bool>[false, true], reason: 'a resolved alert is history, not a live alert');
      expect(dashboard.basis, 'DIS_SNAPSHOT');
      expect(dashboard.policy!.unverified, isTrue);
    });

    test('an answer without the feed basis or the province is refused as a whole; a row that cannot be read is left out and the totals stay', () {
      expect(parseCommitteeDashboard(<String, Object?>{'as_of': '2026-10-31'}), isNull);
      final Map<String, Object?> body = _full();
      (body['feed']! as Map<String, Object?>).remove('basis');
      expect(parseCommitteeDashboard(body), isNull);
      final Map<String, Object?> partial = _full();
      partial['by_sector'] = <Object?>[_row('SECTOR', 'GT', 'Giao thông'), <String, Object?>{'key': 'broken'}];
      final CommitteeDashboard dashboard = parseCommitteeDashboard(partial)!;
      expect(dashboard.rows[CommitteeDimension.sector], hasLength(1));
      expect(dashboard.attentionTotal, 7, reason: 'the server\'s total is kept even though a list is shorter');
    });

    test('a tracker that is not there (an older server) is no directives, not zero directives', () {
      final Map<String, Object?> body = _full()..['directives'] = <String, Object?>{};
      expect(parseCommitteeDashboard(body)!.directives, isNull);
    });
  });

  group('MOB-72 the dashboard', () {
    testWidgets('reads once, says what the figures stand on, the rule and that it is read only, and shows the province with its words and shapes', (WidgetTester tester) async {
      useDevice(tester, _veryTall);
      final ScriptedServer server = _server();
      await _open(tester, server);

      expect(server.callsTo('GET', _path), hasLength(1), reason: 'one view, one audit row');
      expect(find.text('Số liệu đến ngày 31/10/2026, năm 2026'), findsOneWidget);
      expect(find.text('Cơ sở số liệu: bản chụp kế hoạch vốn đã khóa'), findsOneWidget);
      expect(find.textContaining('Mã lần nạp số liệu: 3f2b6c1e'), findsOneWidget);
      expect(find.text('Quy tắc COMMITTEE_POLICY'), findsOneWidget);
      expect(find.textContaining('Các ngưỡng chưa được kiểm chứng'), findsOneWidget);
      expect(find.textContaining('Chỉ đọc. Mỗi lần mở bảng này'), findsOneWidget);
      expect(find.text('Vàng: chậm so với đường kỳ vọng'), findsOneWidget);
      expect(find.text('Tỷ lệ giải ngân toàn tỉnh'), findsOneWidget);
    });

    testWidgets('the four cuts: sector first, then district, investor and funding source, each row with its colour in words, its amounts and what is unknown', (WidgetTester tester) async {
      useDevice(tester, _veryTall);
      await _open(tester, _server());

      expect(find.text('Giao thông'), findsOneWidget);
      expect(find.text('Y tế'), findsOneWidget);
      expect(find.text('Đỏ: chậm nhiều so với đường kỳ vọng'), findsWidgets);
      expect(find.text('Xanh: kịp đường kỳ vọng'), findsWidgets);
      expect(find.text('Tỷ lệ giải ngân: 30,00%, đường kỳ vọng 45,30%'), findsOneWidget);
      expect(find.text('5 dự án, 2 cần quan tâm'), findsWidgets);
      expect(find.text('Kế hoạch vốn: 100 tỷ đồng'), findsWidgets);
      expect(find.text('-15,30 điểm phần trăm'), findsOneWidget);
      expect(find.text('+4,70 điểm phần trăm'), findsOneWidget);
      // A sector whose rate is held back says so and is never given a colour of its own or a zero.
      expect(find.text('Chưa có tỷ lệ giải ngân'), findsOneWidget);
      expect(find.text('2 dòng vốn chưa có số liệu'), findsOneWidget);
      expect(find.text('Chỉ 1/3 dòng vốn có số cùng kỳ'), findsOneWidget);

      await tester.tap(find.text('Huyện'));
      await tester.pumpAndSettle();
      expect(find.text('Huyện A'), findsWidgets);
      expect(find.text('Giao thông'), findsNothing);
      await tester.tap(find.text('Chủ đầu tư'));
      await tester.pumpAndSettle();
      expect(find.text('Ban quản lý 1'), findsWidgets);
      await tester.tap(find.text('Nguồn vốn'));
      await tester.pumpAndSettle();
      expect(find.text('Ngân sách trung ương'), findsOneWidget);
    });

    testWidgets('the four cuts can be switched from the screen reader: each has a tap action (Codex review P2)', (WidgetTester tester) async {
      useDevice(tester, _veryTall);
      final SemanticsHandle semantics = tester.ensureSemantics();
      await _open(tester, _server());

      expect(tester.getSemantics(find.bySemanticsLabel('Huyện')).getSemanticsData().hasAction(SemanticsAction.tap), isTrue);
      tester.semantics.tap(find.semantics.byLabel('Huyện'));
      await tester.pumpAndSettle();
      expect(find.text('Huyện A'), findsWidgets);
      expect(find.text('Giao thông'), findsNothing);
      semantics.dispose();
    });

    testWidgets('the whole attention list with its reasons and figures, and how many more there are', (WidgetTester tester) async {
      useDevice(tester, _veryTall);
      await _open(tester, _server());

      expect(find.text('Hiển thị 4 trong 7 dự án'), findsOneWidget);
      expect(find.text('DA-001 · Đường vành đai 3'), findsOneWidget);
      expect(find.text('DA-004 · Trường học xã B'), findsOneWidget);
      expect(find.text('Ngành Giao thông, huyện Huyện A, chủ đầu tư Ban quản lý 1'), findsNWidgets(4));
      expect(find.text('Chậm tiến độ: 90 ngày'), findsNWidgets(2));
      expect(find.text('Vướng thủ tục: 90 ngày'), findsOneWidget);
      expect(find.text('Còn 3 dự án khác trong danh sách đầy đủ trên máy tính.'), findsOneWidget);
    });

    testWidgets('the units that do not report (only those), the late directives with the phase they reached, and the alerts with what follows from them', (WidgetTester tester) async {
      useDevice(tester, _veryTall);
      await _open(tester, _server());

      expect(find.text('Sở Xây dựng'), findsWidgets);
      expect(find.text('Sở Y tế'), findsOneWidget);
      expect(find.text('Sở Giáo dục'), findsNothing, reason: 'a unit that reports is not listed as one that does not');
      expect(find.text('Báo cáo đã cũ'), findsOneWidget);
      expect(find.text('Chưa từng báo cáo'), findsOneWidget);
      expect(find.text('Chưa báo cáo lần nào'), findsOneWidget);
      expect(find.text('Báo cáo gần nhất 01/10/2026, cách 33 ngày'), findsOneWidget);

      expect(find.text('Đang mở 3, quá hạn 2, đã chuyển lên cấp trên 1'), findsOneWidget);
      expect(find.text('Quá hạn trên 14 ngày thì chuyển lên cấp trên.'), findsOneWidget);
      expect(find.text('Đã chuyển lên cấp trên'), findsOneWidget);
      expect(find.text('Quá hạn'), findsOneWidget);
      expect(find.text('Hạn 22/10/2026, quá hạn 20 ngày'), findsOneWidget);
      expect(find.text('CD-001 · Ban quản lý 1'), findsOneWidget);
      expect(find.text('Danh sách chỉ là một phần; phần còn lại xem trên máy tính.'), findsOneWidget);

      expect(find.text('Toàn tỉnh chậm hơn đường kỳ vọng'), findsOneWidget);
      expect(find.text('Việc cần làm: Họp rà soát tiến độ với các sở'), findsOneWidget);
      expect(find.text('Nếu không xử lý: Tỉnh không kịp kế hoạch giải ngân năm'), findsOneWidget);
      expect(find.text('Đã được xác nhận đã biết bởi Nguyễn Văn An'), findsOneWidget);
      expect(find.text('Khẩn'), findsOneWidget);
      expect(find.text('Chỉ đạo quá hạn'), findsWidgets);
    });

    testWidgets('a feed with nothing loaded says so once instead of a page of "no figure"', (WidgetTester tester) async {
      useDevice(tester, _veryTall);
      await _open(tester, _server(committeeWorkspace(empty: true)));

      expect(find.textContaining('Chưa có số liệu nào được nạp vào lõi dữ liệu'), findsOneWidget);
      expect(find.text('Giao thông'), findsNothing);
    });

    testWidgets('the same screen reads in English', (WidgetTester tester) async {
      useDevice(tester, _veryTall);
      await _open(tester, _server(), locale: const Locale('en'));

      expect(find.text('Steering committee dashboard'), findsOneWidget);
      expect(find.text('Basis of the figures: the frozen snapshot of the capital plan'), findsOneWidget);
      expect(find.text('Showing 4 of 7 projects'), findsOneWidget);
      expect(find.text('Open 3, overdue 2, escalated 1'), findsOneWidget);
      expect(find.text('Sector'), findsOneWidget);
      expect(find.text('Funding source'), findsOneWidget);
    });

    testWidgets('every state, and the screen contract at the three devices and at 200 percent text', (WidgetTester tester) async {
      Future<void> open(WidgetTester tester, ScriptedServer server) => _open(tester, server).then((_) {});
      await expectEveryState(
        tester,
        open: open,
        script: StateScript(healthy: (ScriptedServer server) => server.on('GET', _path, (_) => _full()), content: find.text('Số liệu đến ngày 31/10/2026, năm 2026')),
      );
      await expectScreenContract(tester, open: open, healthy: (ScriptedServer server) => server.on('GET', _path, (_) => _full()));
    });
  });
}

