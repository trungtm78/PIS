import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart' show HttpCall;
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/widgets/bottom_nav.dart' show AppBottomNav;
import 'package:machvon_mobile/core/widgets/work_row.dart' show GroupHeader;
import 'package:machvon_mobile/features/dashboard/dashboard_feature.dart' as dashboard;
import 'package:machvon_mobile/features/dashboard/screens/leader_home_screen.dart';

import '../../support/harness.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'dashboard_fixtures.dart';

/// The approval detail is another story's screen here: a stub that takes the task id, so the link can be followed.
const MobileFeature _approvalStub = MobileFeature(id: 'stub', screens: <ScreenSpec>[ScreenSpec(screenId: 'MOB-24', pathSuffix: '/:taskId', builder: _stub)]);

Widget _stub(BuildContext context, ScreenContext screen) => Text('task ${screen.pathParameters['taskId']}');

Future<ProviderContainer> _open(WidgetTester tester, ScriptedServer server, String location, {Locale locale = const Locale('vi')}) =>
    pumpWithServer(tester, features: <MobileFeature>[dashboard.feature, _approvalStub], server: server, location: location, locale: locale);

void _healthyCenter(ScriptedServer server) => server.on('GET', '/home/command-center', (_) => commandCenter());

void main() {
  group('AC-ST-MOB-040-2 UAT-NFR-PERFORMANCE-02 the marker the cold start is timed to is on the home screen only once its content is loaded', () {
    const String marker = 'Số liệu và công thức';

    testWidgets('not while the answer is awaited, not when it failed, and there when it came', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final Completer<void> slow = Completer<void>();
      final ScriptedServer waiting = ScriptedServer()
        ..answer('GET', '/home/command-center', (HttpCall call) async {
          await slow.future;
          return FakeTransport.json(200, commandCenter());
        });
      await _open(tester, waiting, '/home');
      expect(find.text(marker), findsNothing, reason: 'the screen is on its loading state');

      slow.complete();
      await tester.pumpAndSettle();
      expect(find.text(marker), findsOneWidget);
    });

    testWidgets('a server that refuses leaves the marker out', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer refusing = ScriptedServer()..refuse('GET', '/home/command-center', 500, 'INTERNAL_ERROR');
      await _open(tester, refusing, '/home');
      expect(find.text(marker), findsNothing);
    });
  });

  group('AC-ST-MOB-010-3 UAT-AC242 MOB-07 the leader sees two rates side by side, each with its numerator and denominator', () {
    testWidgets('the two rates are in the band and in the block of figures, 14 percent from 140 over 1000 and not the average of the projects', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthyCenter(server);
      await _open(tester, server, '/home');

      expect(find.text('14,0000%'), findsOneWidget);
      expect(find.text('12,5000%'), findsOneWidget);
      expect(find.text('30,0000%'), findsNothing, reason: 'the mean of 50% and 10% is not a figure of the screen');
      expect(find.textContaining('Tử số 140 triệu đồng · mẫu số 1 tỷ đồng'), findsOneWidget);
      expect(find.textContaining('Tử số 140 triệu đồng · mẫu số 1,12 tỷ đồng'), findsOneWidget);
      // The band names both rates in its two notes and draws the one on the total plan as its bar.
      expect(find.text('Tỷ lệ theo kế hoạch Thủ tướng giao: 14,0000%'), findsOneWidget);
      expect(find.text('Tỷ lệ theo tổng kế hoạch vốn: 12,5000%'), findsOneWidget);
      // In the block of figures each rate is a row of its own, with its sums and its formula, the rate on the plan of the Prime Minister first.
      final Rect pm = tester.getRect(find.ancestor(of: find.text('14,0000%'), matching: find.byType(MetricTileCard)));
      final Rect total = tester.getRect(find.ancestor(of: find.text('12,5000%'), matching: find.byType(MetricTileCard)));
      expect(pm.bottom, lessThanOrEqualTo(total.top));
      expect(pm.width, total.width, reason: 'one under the other, the same width');
    });

    testWidgets('the band never shows another amount under the label of the Treasury disbursement: without that tile it says there is no figure', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer()
        ..on(
          'GET',
          '/home/command-center',
          (_) => commandCenter(tiles: <Map<String, Object?>>[
            tile('DISBURSEMENT_RATE_PM', value: '14.0000', numerator: '140000000', denominator: '1000000000'),
            tile('DISBURSEMENT_RATE_TOTAL', value: '12.5000', numerator: '140000000', denominator: '1120000000'),
            tile('PLAN_TOTAL', value: '1120000000', unit: 'VND'),
          ]),
        );
      await _open(tester, server, '/home');

      final SemanticsHandle semantics = tester.ensureSemantics();
      expect(find.bySemanticsLabel(RegExp(r'^Giải ngân lũy kế theo Kho bạc: Chưa có số liệu')), findsOneWidget, reason: 'the plan is not the disbursement');
      expect(find.bySemanticsLabel(RegExp(r'^Giải ngân lũy kế theo Kho bạc: 1,12')), findsNothing);
      semantics.dispose();
    });

    testWidgets('G0-4: the phone shows the digits the API gives as display_value (the text of the web and of the Excel file), not its own rounding', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer()
        ..on(
          'GET',
          '/home/command-center',
          (_) => commandCenter(tiles: <Map<String, Object?>>[
            tile('DISBURSEMENT_RATE_PM', value: '14.0000', displayValue: '14.00', numerator: '140000000', denominator: '1000000000'),
            tile('DISBURSEMENT_RATE_TOTAL', value: '12.5000', displayValue: '12.50', numerator: '140000000', denominator: '1120000000'),
          ]),
        );
      await _open(tester, server, '/home');

      expect(find.text('14,00%'), findsOneWidget);
      expect(find.text('12,50%'), findsOneWidget);
      expect(find.text('14,0000%'), findsNothing);
    });

    testWidgets('G3-1: a figure whose definition is not certified is held back by the server and the phone says so, not "no data" and not 0', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer()
        ..on(
          'GET',
          '/home/command-center',
          (_) => commandCenter(tiles: <Map<String, Object?>>[
            tile('DISBURSEMENT_RATE_PM', nullReason: 'NOT_CERTIFIED'),
            tile('DISBURSEMENT_RATE_TOTAL', nullReason: 'OBSOLETE'),
          ]),
        );
      await _open(tester, server, '/home');

      expect(find.text('Chưa chứng nhận'), findsOneWidget);
      expect(find.text('Định nghĩa đã lỗi thời'), findsOneWidget);
      expect(find.textContaining('0%'), findsNothing);
    });

    testWidgets('the scope is the one the server read in: the number of its projects, the day and the snapshot', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer()..on('GET', '/home/command-center', (_) => commandCenter(projects: 2, unitId: 'u-bql1'));
      await _open(tester, server, '/home');

      final SemanticsHandle semantics = tester.ensureSemantics();
      expect(find.textContaining('Một đơn vị · 2 dự án · Số liệu tại 31/10/2026'), findsOneWidget, reason: 'the scope and the day are one line of context, said once');
      expect(find.text('3f2b6c1e…00a1'), findsOneWidget);
      expect(find.text('1 dự án chưa có dữ liệu'), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp(r'^3 Cảnh báo đang mở')), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp(r'^2 Điều chuyển chờ duyệt')), findsOneWidget);
      semantics.dispose();
      expect(server.callsTo('GET', '/home/command-center'), hasLength(1));
    });

    testWidgets('a rate with a zero denominator is null with its reason, never 0 percent', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer()
        ..on(
          'GET',
          '/home/command-center',
          (_) => commandCenter(tiles: <Map<String, Object?>>[
            tile('DISBURSEMENT_RATE_PM', nullReason: 'ZERO_DENOMINATOR', numerator: '0', denominator: '0'),
            tile('DISBURSEMENT_RATE_TOTAL', nullReason: 'NO_DATA'),
          ]),
        );
      await _open(tester, server, '/home');

      expect(find.text('Chưa có kế hoạch vốn để tính'), findsOneWidget);
      expect(find.text('Chưa có dữ liệu'), findsOneWidget);
      expect(find.textContaining('0%'), findsNothing);
      expect(find.textContaining('0,0000'), findsNothing);
    });

    testWidgets('a pair of rates with one rate missing is not shown as a pair, and a stale snapshot says so', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer()
        ..on(
          'GET',
          '/home/command-center',
          (_) => commandCenter(freshness: 'STALE', tiles: <Map<String, Object?>>[tile('DISBURSEMENT_RATE_PM', value: '14.0000', numerator: '1', denominator: '7')]),
        );
      await _open(tester, server, '/home');

      expect(find.textContaining('Chưa thể hiển thị số liệu vì thiếu'), findsOneWidget);
      expect(find.text('14,0000%'), findsNothing);
      expect(find.textContaining('Ảnh chụp số liệu đã quá cũ'), findsOneWidget);
    });

    testWidgets('a tile without a formula or token is not a citable figure and is left out', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final Map<String, Object?> uncited = tile('DISBURSEMENT_RATE_TOTAL', value: '99.0000')..remove('formula');
      final ScriptedServer server = ScriptedServer()
        ..on('GET', '/home/command-center', (_) => commandCenter(tiles: <Map<String, Object?>>[tile('DISBURSEMENT_RATE_PM', value: '14.0000'), uncited]));
      await _open(tester, server, '/home');

      expect(find.text('99,0000%'), findsNothing);
      expect(find.textContaining('Chưa thể hiển thị số liệu vì thiếu'), findsOneWidget);
    });

    testWidgets('the english interface uses the english decimal mark and words', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthyCenter(server);
      await _open(tester, server, '/home', locale: const Locale('en'));

      expect(find.text('14.0000%'), findsOneWidget);
      expect(find.textContaining('Numerator 140 million dong · denominator 1 billion dong'), findsOneWidget);
      expect(find.text('Figures and formulas'), findsOneWidget);
    });

    testWidgets('the links lead to the officer home, the funding structure and the unreported projects', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthyCenter(server);
      server.on('GET', '/home/my-work', (_) => myWork(<Map<String, Object?>>[]));
      final ProviderContainer container = await _open(tester, server, '/home');

      await tester.tap(find.text('Việc của tôi'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/home/mob-08');
      await pressBack(tester);
      expect(currentLocation(container), '/home');

      await tester.tap(find.text('Cơ cấu nguồn vốn'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/home/mob-58');
    });
  });

  group('AC-ST-MOB-010-1 MOB-07 a device offline for three days', () {
    testWidgets('the figures of the copy show their as_of and the offline note, never the word latest, and no amount can be edited', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      DateTime now = kNow;
      final ScriptedServer server = ScriptedServer();
      _healthyCenter(server);
      await pumpWithServer(tester, features: <MobileFeature>[dashboard.feature], server: server, location: '/home', now: () => now);

      server.offline = true;
      now = kNow.add(const Duration(days: 3));
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();

      expect(find.text('14,0000%'), findsOneWidget);
      expect(find.textContaining('số liệu tại 31/10/2026'), findsOneWidget);
      expect(find.textContaining('Bản lưu đã quá 12 giờ'), findsOneWidget);
      expect(find.textContaining('mới nhất'), findsNothing);
      expect(find.byType(TextField), findsNothing);
      expect(find.byType(EditableText), findsNothing);
    });
  });

  group('AC-ST-MOB-010-5 UI-MOB-07 the seven states and the screen contract of the leader home', () {
    testWidgets('every state is drawn: content, loading, empty (no snapshot yet), error, denied, expired, signed out, offline', (WidgetTester tester) async {
      await expectEveryState(
        tester,
        open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/home'),
        script: StateScript(
          healthy: _healthyCenter,
          content: find.text('Tổng quan'),
          empty: (ScriptedServer server) => server.refuse('GET', '/home/command-center', 404, 'RESOURCE_NOT_FOUND'),
        ),
      );
    });

    testWidgets('three devices, 200 percent text: no overflow, tap targets, labels and contrast', (WidgetTester tester) async {
      await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/home'), healthy: _healthyCenter);
    });
  });

  group('R39 the home between the tabs and without a connection', () {
    testWidgets('the home keeps its place when another tab is opened and the home is chosen again; the other tab is a screen of its own', (WidgetTester tester) async {
      useDevice(tester, const Size(390, 600));
      final ScriptedServer server = ScriptedServer();
      _healthyCenter(server);
      server
        ..on('GET', '/home/my-work', (_) => alertWork(<Map<String, Object?>>[alertItem('a-1', title: 'Việc một'), alertItem('a-2', title: 'Việc hai'), alertItem('a-3', title: 'Việc ba')]))
        ..on('GET', '/home/my-work/counts', (_) => alertCounts(urgent: 0, action: 3));
      final ProviderContainer container = await _open(tester, server, '/home');
      final Finder list = find.byType(Scrollable).first;
      await tester.drag(list, const Offset(0, -300));
      await tester.pumpAndSettle();
      final double before = tester.state<ScrollableState>(list).position.pixels;
      expect(before, greaterThan(0));

      await tester.tap(find.descendant(of: find.byType(AppBottomNav), matching: find.text('Dự án')));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/projects');
      await tester.tap(find.descendant(of: find.byType(AppBottomNav), matching: find.text('Trang chủ')));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/home');
      expect(tester.state<ScrollableState>(find.byType(Scrollable).first).position.pixels, before, reason: 'a tab keeps its scroll while another is open');
      expect(server.callsTo('GET', '/home/command-center'), hasLength(1), reason: 'going back to a tab reads nothing again');
    });

    testWidgets('offline with a copy: the connection is told once, by the strip of the shell; the line of context says it is a saved copy and stays', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      DateTime now = kNow;
      final ScriptedServer server = ScriptedServer();
      _healthyCenter(server);
      server
        ..on('GET', '/home/my-work', (_) => alertWork(<Map<String, Object?>>[alertItem('a-1', title: 'Việc một')]))
        ..on('GET', '/home/my-work/counts', (_) => alertCounts(action: 1));
      await pumpWithServer(tester, features: <MobileFeature>[dashboard.feature], server: server, location: '/home', now: () => now);

      server.offline = true;
      now = kNow.add(const Duration(hours: 2));
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();

      expect(find.textContaining('Bạn đang ngoại tuyến'), findsOneWidget, reason: 'one strip, not one per screen');
      expect(find.textContaining('ngoại tuyến'), findsOneWidget, reason: 'no other line says "offline" again');
      expect(find.textContaining('dữ liệu đã lưu'), findsWidgets, reason: 'the copy says it is a copy');
      expect(find.text('14,0000%'), findsOneWidget, reason: 'the copy of the figures is still readable');
      expect(find.widgetWithText(FilledButton, 'Xử lý'), findsNothing, reason: 'a copy offers no act');
    });

    testWidgets('stale: a copy older than its time to live is marked out of date in the one line of context', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      DateTime now = kNow;
      final ScriptedServer server = ScriptedServer();
      _healthyCenter(server);
      server.on('GET', '/home/my-work', (_) => alertWork(<Map<String, Object?>>[]));
      await pumpWithServer(tester, features: <MobileFeature>[dashboard.feature], server: server, location: '/home', now: () => now);

      server.offline = true;
      now = kNow.add(const Duration(days: 3));
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();

      expect(find.text('Số liệu cũ'), findsOneWidget, reason: 'the stale badge of the line of context');
      expect(find.textContaining('Bản lưu đã quá 12 giờ'), findsOneWidget);
    });
  });

  group('AC-ST-MOB-010-6 UI-MOB-08 MOB-08 the officer home', () {
    final List<Map<String, Object?>> items = <Map<String, Object?>>[
      workItem('w-approval', 'APPROVAL', 'NEAR', screen: 'ADM-06', title: 'Phê duyệt kế hoạch vốn'),
      workItem('w-returned', 'REPORT_RETURNED', 'OVERDUE', dueOn: '2026-10-30', original: '2026-10-28', late: 4, title: 'Báo cáo bị trả'),
      workItem('w-draft', 'REPORT_DRAFT_OVERDUE', 'OVERDUE', late: 2, title: 'Nháp tuần 43'),
      workItem('w-explain', 'EXPLANATION', 'LATER', dueOn: null, title: 'Giải trình chậm giải ngân'),
    ];

    void healthy(ScriptedServer server) => server.on('GET', '/home/my-work', (_) => myWork(items));

    testWidgets('the work is grouped as deadlines, drafts and assigned work, late first, with its due days', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      healthy(server);
      await _open(tester, server, '/home/mob-08');

      final SemanticsHandle semantics = tester.ensureSemantics();
      expect(find.bySemanticsLabel(RegExp(r'^4 Việc đang mở')), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp(r'^2 Việc trễ hạn')), findsOneWidget);
      semantics.dispose();
      // One list, under one heading per band: late first, then soon, and the work with no due day last.
      expect(find.descendant(of: find.byType(GroupHeader), matching: find.text('Quá hạn')), findsOneWidget);
      expect(find.text('Sắp đến hạn'), findsOneWidget);
      expect(find.text('Chưa có hạn'), findsOneWidget);
      expect(find.text('Còn thời gian'), findsNothing, reason: 'a group with nothing in it has no heading');
      final double late4 = tester.getTopLeft(find.text('Trễ 4 ngày')).dy;
      final double late2 = tester.getTopLeft(find.text('Trễ 2 ngày')).dy;
      final double soon = tester.getTopLeft(find.text('Còn 2 ngày')).dy;
      final double none = tester.getTopLeft(find.text('Giải trình chậm giải ngân')).dy;
      expect(<double>[late4, late2, soon, none], orderedEquals(<double>[late4, late2, soon, none]..sort()), reason: 'by due day, the latest first');
      expect(find.text('hạn 30/10'), findsOneWidget, reason: 'the real day beside the words');
    });

    testWidgets('only an approval task opens, in the approval detail; the other kinds are done in their own module', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      healthy(server);
      final ProviderContainer container = await _open(tester, server, '/home/mob-08');

      await tester.tap(find.widgetWithText(FilledButton, 'Xử lý'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/approval/mob-24/w-approval');
      expect(find.text('task w-approval'), findsOneWidget);
    });

    testWidgets('a list that is a part only says so', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer()..on('GET', '/home/my-work', (_) => myWork(items, truncated: true));
      await _open(tester, server, '/home/mob-08');

      expect(find.textContaining('Danh sách chỉ là một phần'), findsOneWidget);
    });

    testWidgets('every state is drawn and the contract of the screen holds', (WidgetTester tester) async {
      await expectEveryState(
        tester,
        open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/home/mob-08'),
        script: StateScript(healthy: healthy, content: find.text('Việc đến hạn')),
      );
      await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/home/mob-08'), healthy: healthy);
    });
  });

  group('AC-ST-MOB-010-2 UAT-AC240 AC-ST-MOB-010-10 UI-MOB-58 MOB-58 the funding structure', () {
    void healthy(ScriptedServer server, {List<Object?>? lines}) {
      server
        ..on('GET', '/appropriations', (_) => page(<Object?>[appropriation('ap-1', 'NSTW', 'PM_ASSIGNED', '420000000'), appropriation('ap-2', 'NSTW', 'CARRYOVER', '0', year: 2025)]))
        ..on('GET', '/resources/allocation_line', (_) => page(lines ?? <Object?>[allocationLine('ap-1', '40000000')]));
    }

    testWidgets('the total is 420 million, CTMTQG 40 is "of which" and the screen never shows 460', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      healthy(server);
      await _open(tester, server, '/home/mob-58');

      expect(find.text('Tổng vốn đã công bố năm 2026'), findsOneWidget);
      expect(find.text('420 triệu đồng'), findsNWidgets(3), reason: 'the total, the NSTW card and the card of the year capital');
      expect(find.text('420.000.000 đồng'), findsNWidgets(3));
      expect(find.text('trong đó CTMTQG 40 triệu đồng'), findsOneWidget);
      expect(find.textContaining('460'), findsNothing);
      expect(find.textContaining('Tổng vốn đã công bố năm 2026'), findsOneWidget);
    });

    testWidgets('a CTMTQG that is registered as a source of its own is a part of NSTW and is added to no total', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer()
        ..on('GET', '/appropriations', (_) => page(<Object?>[appropriation('ap-1', 'NSTW', 'PM_ASSIGNED', '420000000'), appropriation('ap-9', 'CTMTQG', 'PM_ASSIGNED', '40000000', relation: 'SUBSET_OF')]))
        ..on('GET', '/resources/allocation_line', (_) => page(<Object?>[]));
      await _open(tester, server, '/home/mob-58');

      expect(find.text('420 triệu đồng'), findsNWidgets(3));
      expect(find.text('trong đó CTMTQG 40 triệu đồng'), findsOneWidget);
      expect(find.textContaining('460'), findsNothing);
    });

    testWidgets('a source with nothing published says no data and is not zero; a part that could not be read is no data too', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer()
        ..on('GET', '/appropriations', (_) => page(<Object?>[appropriation('ap-1', 'NSTW', 'PM_ASSIGNED', '420000000')]))
        ..refuse('GET', '/resources/allocation_line', 403, 'SCOPE_DENIED');
      await _open(tester, server, '/home/mob-58');

      expect(find.text('Chưa có số liệu'), findsWidgets);
      expect(find.text('trong đó CTMTQG: chưa có dữ liệu'), findsOneWidget);
      expect(find.text('0 triệu đồng'), findsNothing);
      expect(find.text('420 triệu đồng'), findsNWidgets(3), reason: 'the capital that was published is still there');
    });

    testWidgets('a year is chosen by the reader and the address; a draft or a replaced appropriation is not counted', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer()
        ..on(
          'GET',
          '/appropriations',
          (_) => page(<Object?>[
            appropriation('ap-1', 'NSTW', 'PM_ASSIGNED', '420000000'),
            appropriation('ap-2', 'NSDP', 'LOCAL_ADDED', '80000000', year: 2025),
            appropriation('ap-3', 'NSTW', 'PM_ASSIGNED', '999000000', status: 'DRAFT'),
          ]),
        )
        ..on('GET', '/resources/allocation_line', (_) => page(<Object?>[]));
      await _open(tester, server, '/home/mob-58?year=2025');

      expect(find.text('Tổng vốn đã công bố năm 2025'), findsOneWidget);
      expect(find.text('80 triệu đồng'), findsWidgets);
      expect(find.textContaining('999'), findsNothing);

      await tester.tap(find.text('Năm 2026'));
      await tester.pumpAndSettle();
      expect(find.text('Tổng vốn đã công bố năm 2026'), findsOneWidget);
      expect(find.text('420 triệu đồng'), findsWidgets);
    });

    testWidgets('the connection failing while the lines are read shows the copy and is not read as "no lines"', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      healthy(server);
      await _open(tester, server, '/home/mob-58');
      expect(find.text('trong đó CTMTQG 40 triệu đồng'), findsOneWidget);

      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();
      expect(find.text('trong đó CTMTQG 40 triệu đồng'), findsOneWidget);
      expect(find.textContaining('Đang hiển thị dữ liệu đã lưu trên máy'), findsOneWidget);
    });

    testWidgets('every state is drawn and the contract of the screen holds', (WidgetTester tester) async {
      await expectEveryState(
        tester,
        open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/home/mob-58'),
        script: StateScript(
          healthy: healthy,
          content: find.text('Theo nguồn vốn'),
          empty: (ScriptedServer server) => server.on('GET', '/appropriations', (_) => page(<Object?>[])),
        ),
      );
      await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/home/mob-58'), healthy: healthy);
    });
  });
}
