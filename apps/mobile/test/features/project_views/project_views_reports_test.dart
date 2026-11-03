import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/features/project_views/issue_models.dart';
import 'package:machvon_mobile/features/project_views/project_views_feature.dart' as project_views;

import '../../support/harness.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'project_fixtures.dart';

Future<ProviderContainer> _open(WidgetTester tester, ScriptedServer server, String location, {DateTime Function()? now}) =>
    pumpWithServer(tester, features: <MobileFeature>[project_views.feature], server: server, location: location, now: now);

void main() {
  group('AC-ST-MOB-010-9 UI-MOB-12 MOB-12 the lines of a capital plan', () {
    final Map<String, Object?> plan = planVersion('plan-1', 'KH-2026');

    void healthy(ScriptedServer server) {
      server
        ..on('GET', '/resources/plan_version', (_) => page(<Object?>[plan, planVersion('plan-0', 'KH-2025', year: 2025), planVersion('plan-2', 'KH-2026', revision: 2, status: 'DRAFT')]))
        ..on(
          'GET',
          '/capital-plans/plan-1/lines',
          (_) => planLines(plan, <Object?>[
            planLine('l-1', '1', 'NSTW', '420000000', ctmtqg: '40000000', disbursed: '100000000'),
            planLine('l-2', '2', 'NSTW', '80000000'),
            planLine('l-3', '3', 'NSDP', '50000000', disbursed: '0'),
          ]),
        );
    }

    testWidgets('opens the published plan of the newest year; the allocation is 550 million, CTMTQG is "of which" and a line without a disbursement figure says so', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      healthy(server);
      await _open(tester, server, '/projects/mob-12');

      expect(server.callsTo('GET', '/capital-plans/plan-1/lines'), hasLength(1));
      expect(find.text('550 triệu đồng'), findsOneWidget, reason: 'the total allocation; the amounts already hold the CTMTQG part');
      expect(find.text('trong đó CTMTQG 40 triệu đồng'), findsNWidgets(2), reason: 'the total and the NSTW source');
      expect(find.text('Nguồn: Nguồn NSTW'), findsOneWidget);
      expect(find.text('Giải ngân: 100 triệu đồng'), findsNothing);
      expect(find.textContaining('Chưa có số liệu giải ngân'), findsWidgets);
      expect(find.textContaining('460'), findsNothing);
      expect(find.byType(TextField), findsNothing, reason: 'amounts are read-only reference data');
    });

    testWidgets('a plan named in the address is opened, and the reader can switch to another published plan', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      healthy(server);
      final Map<String, Object?> older = planVersion('plan-0', 'KH-2025', year: 2025);
      server.on('GET', '/capital-plans/plan-0/lines', (_) => planLines(older, <Object?>[planLine('l-9', '9', 'NSDP', '30000000')]));
      await _open(tester, server, '/projects/mob-12?plan=plan-0');

      expect(find.text('30 triệu đồng'), findsWidgets);
      expect(server.callsTo('GET', '/capital-plans/plan-1/lines'), isEmpty);

      await tester.tap(find.byType(DropdownButtonFormField<String>));
      await tester.pumpAndSettle();
      await tester.tap(find.text('KH-2026, năm 2026, bản 1').last);
      await tester.pumpAndSettle();
      expect(find.text('550 triệu đồng'), findsOneWidget);
    });

    testWidgets('a reader with no published plan sees the empty state', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final ScriptedServer server = ScriptedServer()..on('GET', '/resources/plan_version', (_) => page(<Object?>[planVersion('plan-2', 'KH-2026', status: 'DRAFT')]));
      await _open(tester, server, '/projects/mob-12');
      expect(find.text('Chưa có dữ liệu'), findsOneWidget);
    });

    testWidgets('every state is drawn and the contract of the screen holds', (WidgetTester tester) async {
      await expectEveryState(
        tester,
        open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/projects/mob-12'),
        script: StateScript(healthy: healthy, content: find.text('Tổng cộng'), empty: (ScriptedServer server) => server.on('GET', '/resources/plan_version', (_) => page(<Object?>[]))),
      );
      await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/projects/mob-12'), healthy: healthy);
    });
  });

  group('AC-ST-MOB-010-4 UI-MOB-57 MOB-57 the projects that have not reported', () {
    final List<Map<String, Object?>> projects = <Map<String, Object?>>[
      progressProject('p-1', 'DA-001', 'NOT_STARTED', overdue: true),
      progressProject('p-2', 'DA-002', 'DRAFT'),
      progressProject('p-3', 'DA-003', 'SUBMITTED'),
      progressProject('p-9', 'DA-009', 'NOT_STARTED', unit: 'u-other'),
    ];

    void healthy(ScriptedServer server) {
      server
        ..on('GET', '/resources/reporting_period', (_) => page(<Object?>[period('per-1', 'W44', '2026-10-26', '2026-11-01', '2026-11-02T10:00:00Z'), period('per-0', 'W43', '2026-10-19', '2026-10-25', '2026-10-26T10:00:00Z'), period('per-2', 'W45', '2026-11-09', '2026-11-15', '2026-11-16T10:00:00Z')]))
        ..on('GET', '/reporting-periods/per-1/submission-progress', (_) => progress('per-1', projects))
        ..on('GET', '/resources/project', (_) => page(twoProjects.map((Map<String, Object?> line) => <String, Object?>{...line, 'id': line['code'] == 'DA-001' ? 'p-1' : 'p-2'}).toList()));
    }

    testWidgets('lists the projects not yet submitted, with the deadline in Vietnam time, and none of another unit', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      healthy(server);
      await _open(tester, server, '/projects/mob-57');

      expect(find.text('DA-001 · Dự án DA-001'), findsOneWidget);
      expect(find.text('DA-002 · Dự án DA-002'), findsOneWidget);
      expect(find.text('DA-003 · Dự án DA-003'), findsNothing, reason: 'it has handed a report in');
      expect(find.text('DA-009 · Dự án DA-009'), findsNothing, reason: 'its unit is not in the scope the board counted');
      expect(find.text('2 trên 4 dự án chưa nộp'), findsOneWidget);
      expect(find.text('Hạn nộp 02/11/2026 17:00 (giờ Việt Nam)'), findsOneWidget);
      expect(find.text('Kỳ W44, hạn 02/11/2026 17:00'), findsNWidgets(2));
      expect(find.text('Quá hạn'), findsOneWidget);
      expect(find.text('Có bản nháp'), findsOneWidget);
      expect(find.text('Chưa bắt đầu'), findsOneWidget);
      expect(find.text('Phụ trách: Nguyễn Văn An'), findsOneWidget);
      expect(server.callsTo('GET', '/reporting-periods/per-1/submission-progress').single.url.queryParameters['state'], 'MUST_REPORT');
    });

    testWidgets('the period is the newest that has started at the Vietnam day of the clock, and the reader can pick another', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      healthy(server);
      server.on('GET', '/reporting-periods/per-0/submission-progress', (_) => progress('per-0', <Map<String, Object?>>[progressProject('p-2', 'DA-002', 'DRAFT')], passed: true, deadline: '2026-10-26T10:00:00Z'));
      await _open(tester, server, '/projects/mob-57');
      expect(server.callsTo('GET', '/reporting-periods/per-1/submission-progress'), hasLength(1), reason: 'W45 starts after the day of the clock');

      await tester.tap(find.byType(DropdownButtonFormField<String>));
      await tester.pumpAndSettle();
      await tester.tap(find.text('W43 (19/10/2026 - 25/10/2026)').last);
      await tester.pumpAndSettle();
      expect(find.text('Đã quá hạn nộp 26/10/2026 17:00 (giờ Việt Nam)'), findsOneWidget);
    });

    testWidgets('a calendar without a period is the empty state', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final ScriptedServer server = ScriptedServer()..on('GET', '/resources/reporting_period', (_) => page(<Object?>[]));
      await _open(tester, server, '/projects/mob-57');
      expect(find.text('Chưa có dữ liệu'), findsOneWidget);
    });

    testWidgets('every state is drawn and the contract of the screen holds', (WidgetTester tester) async {
      await expectEveryState(
        tester,
        open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/projects/mob-57'),
        script: StateScript(healthy: healthy, content: find.text('2 trên 4 dự án chưa nộp'), empty: (ScriptedServer server) => server.on('GET', '/reporting-periods/per-1/submission-progress', (_) => progress('per-1', <Map<String, Object?>>[progressProject('p-3', 'DA-003', 'SUBMITTED')]))),
      );
      await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/projects/mob-57'), healthy: healthy);
    });
  });

  group('AC-ST-MOB-010-11 UI-MOB-59 MOB-59 the issues of a week', () {
    void healthy(ScriptedServer server) => server.on('GET', '/issues/weekly-matrix', (call) => issueMatrix(call.url.queryParameters['week'] ?? ''));

    testWidgets('opens on the week of today in Vietnam time and shows the totals and the groups', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      healthy(server);
      await _open(tester, server, '/projects/mob-59');

      expect(server.callsTo('GET', '/issues/weekly-matrix').single.url.queryParameters['week'], '2026-W45', reason: '3 November 2026');
      expect(find.text('Tuần 2026-W45'), findsOneWidget);
      expect(find.text('Từ 26/10/2026 đến 01/11/2026'), findsOneWidget);
      expect(find.text('Ban QLDA giao thông: Giải phóng mặt bằng'), findsOneWidget);
      expect(find.text('Ban QLDA giao thông: Vật liệu'), findsOneWidget);
      expect(find.text('Tồn cuối tuần:'), findsNWidgets(3));
      final Finder totals = find.ancestor(of: find.text('Toàn bộ phạm vi'), matching: find.byType(Card));
      expect(find.descendant(of: totals, matching: find.text('12')), findsOneWidget, reason: 'the backlog of the whole scope');
      expect(find.descendant(of: totals, matching: find.text('15')), findsOneWidget, reason: 'what was open at the start of the week');
    });

    testWidgets('the arrows move a week before and after and read that week', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      healthy(server);
      await _open(tester, server, '/projects/mob-59?week=2026-W44');

      await tester.tap(find.byTooltip('Tuần trước'));
      await tester.pumpAndSettle();
      expect(server.callsTo('GET', '/issues/weekly-matrix').last.url.queryParameters['week'], '2026-W43');
      await tester.tap(find.byTooltip('Tuần sau'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Tuần sau'));
      await tester.pumpAndSettle();
      expect(server.callsTo('GET', '/issues/weekly-matrix').last.url.queryParameters['week'], '2026-W45');
    });

    testWidgets('a week that is not a week in the address falls back to the week of today', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      healthy(server);
      await _open(tester, server, '/projects/mob-59?week=2026-W99');
      expect(server.callsTo('GET', '/issues/weekly-matrix').single.url.queryParameters['week'], '2026-W45');
    });

    test('ISO weeks: the year of a week is the year of its Thursday, a week the year does not have is refused', () {
      expect(isoWeekOf('2026-11-03'), '2026-W45');
      expect(isoWeekOf('2027-01-01'), '2026-W53');
      expect(isoWeekOf('2024-12-30'), '2025-W01');
      expect(mondayOf('2026-W45'), '2026-11-02');
      expect(mondayOf('2026-W53'), '2026-12-28');
      expect(mondayOf('2025-W53'), isNull);
      expect(mondayOf('2026-W00'), isNull);
      expect(mondayOf('nonsense'), isNull);
      expect(shiftWeek('2026-W45', -2), '2026-W43');
      expect(shiftWeek('2026-W52', 2), '2027-W01');
      expect(shiftWeek('nonsense', 1), 'nonsense');
    });

    testWidgets('every state is drawn and the contract of the screen holds', (WidgetTester tester) async {
      await expectEveryState(
        tester,
        open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/projects/mob-59'),
        script: StateScript(healthy: healthy, content: find.text('Toàn bộ phạm vi')),
      );
      await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/projects/mob-59'), healthy: healthy);
    });
  });
}
