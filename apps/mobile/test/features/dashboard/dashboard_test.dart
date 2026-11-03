import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart' show HttpCall;
import 'package:machvon_mobile/core/navigation/feature.dart';
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
    const String marker = 'Hai tỷ lệ giải ngân';

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
    testWidgets('the two rates are on one line, 14 percent from 140 over 1000 and not the average of the projects', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthyCenter(server);
      await _open(tester, server, '/home');

      expect(find.text('14,0000%'), findsOneWidget);
      expect(find.text('12,5000%'), findsOneWidget);
      expect(find.text('30,0000%'), findsNothing, reason: 'the mean of 50% and 10% is not a figure of the screen');
      expect(find.textContaining('Tử số 140 triệu đồng · mẫu số 1.000 triệu đồng'), findsOneWidget);
      expect(find.textContaining('Tử số 140 triệu đồng · mẫu số 1.120 triệu đồng'), findsOneWidget);
      final Rect pm = tester.getRect(find.ancestor(of: find.text('14,0000%'), matching: find.byType(MetricTileCard)));
      final Rect total = tester.getRect(find.ancestor(of: find.text('12,5000%'), matching: find.byType(MetricTileCard)));
      expect(pm.top, total.top, reason: 'side by side');
      expect(pm.right, lessThan(total.left));
    });

    testWidgets('the scope is the one the server read in: the number of its projects, the day and the snapshot', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer()..on('GET', '/home/command-center', (_) => commandCenter(projects: 2, unitId: 'u-bql1'));
      await _open(tester, server, '/home');

      expect(find.text('Một đơn vị và các đơn vị trực thuộc (2 dự án)'), findsOneWidget);
      expect(find.text('31/10/2026'), findsOneWidget);
      expect(find.text('3f2b6c1e…00a1'), findsOneWidget);
      expect(find.text('1 dự án chưa có dữ liệu'), findsOneWidget);
      expect(find.text('3 cảnh báo sớm đang mở'), findsOneWidget);
      expect(find.text('2 đề xuất điều chuyển vốn chờ quyết định'), findsOneWidget);
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
      expect(find.textContaining('Numerator 140 million dong · denominator 1,000 million dong'), findsOneWidget);
      expect(find.text('The two disbursement rates'), findsOneWidget);
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
          content: find.text('Hai tỷ lệ giải ngân'),
          empty: (ScriptedServer server) => server.refuse('GET', '/home/command-center', 404, 'RESOURCE_NOT_FOUND'),
        ),
      );
    });

    testWidgets('three devices, 200 percent text: no overflow, tap targets, labels and contrast', (WidgetTester tester) async {
      await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/home'), healthy: _healthyCenter);
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

      expect(find.text('4 việc, trong đó 2 quá hạn'), findsOneWidget);
      expect(find.text('Hạn nộp (1)'), findsOneWidget);
      expect(find.text('Bản nháp (1)'), findsOneWidget);
      expect(find.text('Việc giao (2)'), findsOneWidget);
      expect(find.text('Hạn 30/10/2026, trễ 4 ngày, hạn ban đầu 28/10/2026'), findsOneWidget);
      expect(find.text('Không có hạn'), findsOneWidget);
      expect(find.text('Hạn 05/11/2026'), findsOneWidget);
    });

    testWidgets('only an approval task opens, in the approval detail; the other kinds are done in their own module', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      healthy(server);
      final ProviderContainer container = await _open(tester, server, '/home/mob-08');

      await tester.tap(find.text('Phê duyệt kế hoạch vốn'));
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
        script: StateScript(healthy: healthy, content: find.text('Việc giao (2)'), empty: (ScriptedServer server) => server.on('GET', '/home/my-work', (_) => myWork(<Map<String, Object?>>[]))),
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
