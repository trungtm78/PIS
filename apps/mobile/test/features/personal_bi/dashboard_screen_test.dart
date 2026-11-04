import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/di/providers.dart' show routerProvider;
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/features/personal_bi/bi_query_service.dart';
import 'package:machvon_mobile/features/personal_bi/charts.dart';
import 'package:machvon_mobile/features/personal_bi/personal_bi_feature.dart' as personal_bi;
import 'package:machvon_mobile/features/read_support/read_cache.dart';

import '../../support/harness.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'bi_fixtures.dart';

/// No waiting between the looks at a job: the tests decide what a job answers.
final Override _instantJobs = jobPollingProvider.overrideWithValue(JobPolling(interval: Duration.zero, attempts: 3, sleep: (Duration d) async {}));

Future<ProviderContainer> _open(WidgetTester tester, ScriptedServer server, String location, {Locale locale = const Locale('vi'), List<Override> overrides = const <Override>[]}) {
  return pumpWithServer(tester, features: <MobileFeature>[personal_bi.feature], server: server, location: location, locale: locale, overrides: <Override>[_instantJobs, ...overrides]);
}

String _dashboard({String? snapshot, String id = dashD1}) => '/home/mob-40?dashboard=$id${snapshot == null ? '' : '&snapshot=$snapshot'}';

Map<String, Object?> _body(HttpCall call) => jsonDecode(call.body!) as Map<String, Object?>;

void main() {
  group('AC-ST-MOB-027-1 UAT-AC34 a dashboard opened from a snapshot that has a newer one', () {
    testWidgets('it shows the snapshot it was opened from, says newer data exists, and every figure is read over that snapshot', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final SemanticsHandle semantics = tester.ensureSemantics();
      final ScriptedServer server = biServer(newData: true, newer: snapB, cached: true, frozen: <String>[snapB, snapA]);
      await _open(tester, server, _dashboard(snapshot: snapA));

      expect(find.text('Giải ngân của tôi'), findsOneWidget);
      expect(find.text('Có dữ liệu mới hơn'), findsOneWidget);
      expect(find.textContaining('Kỳ này đã có ảnh chụp mới hơn (10b00000). Các số bên dưới vẫn là của ảnh chụp đang mở (10a00000)'), findsOneWidget);
      expect(find.text('10a00000, kỳ 2026-10'), findsOneWidget, reason: 'the header names the snapshot that is open');
      expect(find.textContaining('Lấy từ bộ nhớ đệm, tính lúc 12/11/2026 08:00'), findsWidgets, reason: 'a figure from the cache says so and says when it was built');
      final List<HttpCall> queries = server.callsTo('POST', '/dashboard-queries');
      expect(queries, hasLength(2));
      expect(queries.map((HttpCall call) => _body(call)['snapshot_id']).toSet(), <String>{snapA}, reason: 'never a figure of the newer snapshot while the older is open');
      expect(server.callsTo('GET', '/bi/datasets'), isEmpty, reason: 'a snapshot that was named is not looked up again');
      semantics.dispose();
    });

    testWidgets('every figure carries its period, snapshot, quality, cache state and scope; a ratio shows its numerator and denominator', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      await _open(tester, biServer(), _dashboard(snapshot: snapA));

      expect(find.text('64,13%'), findsOneWidget);
      expect(find.text('Tử số 480.000.000, mẫu số 748.000.000'), findsOneWidget);
      expect(find.text('Kỳ dữ liệu: 2026-10. Ảnh chụp: 10a00000'), findsNWidgets(2));
      expect(find.text('Chất lượng dữ liệu: Đạt'), findsNWidgets(2));
      expect(find.textContaining('Mới tính lúc 12/11/2026 08:00'), findsNWidgets(2));
      expect(find.textContaining('Trong phạm vi của bạn'), findsNWidgets(2));
      expect(find.text('Có dữ liệu mới hơn'), findsNothing, reason: 'no banner while there is no newer snapshot');
    });

    testWidgets('the group that has no figure says "no data" and is not drawn as a bar of zero', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      await _open(tester, biServer(), _dashboard(snapshot: snapA));

      expect(find.text('Ban QLDA huyện'), findsOneWidget);
      expect(find.text('Chưa có dữ liệu'), findsOneWidget);
      expect(find.byType(ProportionBar), findsNWidgets(2), reason: 'a bar for each of the two groups that have a figure');
      expect(find.text('300.000.000 ₫'), findsOneWidget);
    });

    testWidgets('the drill from a cell totals the cell: the check says so, from the same snapshot', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final SemanticsHandle semantics = tester.ensureSemantics();
      final ScriptedServer server = biServer();
      server.on('GET', '/bi/drill', (HttpCall call) => answer(dimension: 'project', total: figure('300000000'), children: <Map<String, Object?>>[groupJson('p-1', 'Cầu Bình An', '200000000', token: 'tk-1'), groupJson('p-2', 'Đường tỉnh 12', '100000000', token: 'tk-2')], token: tokenAUnit));
      await _open(tester, server, _dashboard(snapshot: snapA));

      await tester.tap(find.bySemanticsLabel('Đi sâu vào Sở Giao thông'));
      await tester.pumpAndSettle();
      expect(find.text('Đi sâu vào Sở Giao thông theo:'), findsOneWidget);
      expect(find.widgetWithText(ActionChip, 'Đơn vị'), findsNothing, reason: 'the tile is already cut by unit');
      await tester.tap(find.widgetWithText(ActionChip, 'Dự án'));
      await tester.pumpAndSettle();

      expect(server.callsTo('GET', '/bi/drill').single.url.queryParameters, <String, String>{'drill_token': tokenAUnit, 'child_dimension': 'project'});
      expect(find.text('Tổng của bước này bằng ô đã chọn (300.000.000 ₫), cùng ảnh chụp.'), findsOneWidget);
      expect(find.text('Cầu Bình An'), findsOneWidget);
      expect(find.text('Tổng › Sở Giao thông (Dự án)'), findsOneWidget);
      await tester.tap(find.text('Quay lại'));
      await tester.pumpAndSettle();
      expect(find.text('Sở Nông nghiệp'), findsOneWidget);
      expect(find.textContaining('Tổng của bước này'), findsNothing);
      semantics.dispose();
    });

    testWidgets('a drill whose total is not the cell says so with both figures; it is never hidden', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final SemanticsHandle semantics = tester.ensureSemantics();
      final ScriptedServer server = biServer();
      server.on('GET', '/bi/drill', (_) => answer(dimension: 'project', total: figure('250000000'), children: <Map<String, Object?>>[groupJson('p-1', 'Cầu Bình An', '250000000', token: 'tk-1')], token: tokenAUnit));
      await _open(tester, server, _dashboard(snapshot: snapA));

      await tester.tap(find.bySemanticsLabel('Đi sâu vào Sở Giao thông'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(ActionChip, 'Dự án'));
      await tester.pumpAndSettle();

      expect(find.text('Tổng của bước này không bằng ô đã chọn: ô là 300.000.000 ₫, tổng là 250.000.000 ₫.'), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('a drill from another snapshot than the cell is not compared with it', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final SemanticsHandle semantics = tester.ensureSemantics();
      final ScriptedServer server = biServer();
      server.on('GET', '/bi/drill', (_) => answer(snapshot: snapB, dimension: 'project', total: figure('300000000'), token: tokenB));
      await _open(tester, server, _dashboard(snapshot: snapA));

      await tester.tap(find.bySemanticsLabel('Đi sâu vào Sở Giao thông'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(ActionChip, 'Dự án'));
      await tester.pumpAndSettle();

      expect(find.textContaining('thuộc ảnh chụp khác với ô đã chọn'), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('a second step goes further down and the dimensions already used are not offered again', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final SemanticsHandle semantics = tester.ensureSemantics();
      final ScriptedServer server = biServer();
      server.on('GET', '/bi/drill', (HttpCall call) => call.url.queryParameters['child_dimension'] == 'project'
          ? answer(dimension: 'project', total: figure('300000000'), children: <Map<String, Object?>>[groupJson('p-1', 'Cầu Bình An', '300000000', token: 'tk-1')], token: tokenAUnit)
          : answer(dimension: 'fund_source', total: figure('300000000'), children: <Map<String, Object?>>[groupJson('f-1', 'Ngân sách trung ương', '300000000')], token: tokenAUnit));
      await _open(tester, server, _dashboard(snapshot: snapA));

      await tester.tap(find.bySemanticsLabel('Đi sâu vào Sở Giao thông'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(ActionChip, 'Dự án'));
      await tester.pumpAndSettle();
      await tester.tap(find.bySemanticsLabel('Đi sâu vào Cầu Bình An'));
      await tester.pumpAndSettle();
      expect(find.widgetWithText(ActionChip, 'Đơn vị'), findsNothing);
      expect(find.widgetWithText(ActionChip, 'Dự án'), findsNothing);
      await tester.tap(find.widgetWithText(ActionChip, 'Nguồn vốn'));
      await tester.pumpAndSettle();

      expect(find.text('Tổng › Sở Giao thông (Dự án) › Cầu Bình An (Nguồn vốn)'), findsOneWidget);
      expect(find.text('Ngân sách trung ương'), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('REVIEW-r7 Back while a deeper drill is on its way drops that drill and closes the chooser: the late answer is not added under the group the person left', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final SemanticsHandle semantics = tester.ensureSemantics();
      final ScriptedServer server = biServer();
      final Completer<HttpResult> held = Completer<HttpResult>();
      server.answer('GET', '/bi/drill', (HttpCall call) => call.url.queryParameters['child_dimension'] == 'project'
          ? FakeTransport.json(200, answer(dimension: 'project', total: figure('300000000'), children: <Map<String, Object?>>[groupJson('p-1', 'Cầu Bình An', '300000000', token: 'tk-1')], token: tokenAUnit))
          : held.future);
      await _open(tester, server, _dashboard(snapshot: snapA));
      await tester.tap(find.bySemanticsLabel('Đi sâu vào Sở Giao thông'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(ActionChip, 'Dự án'));
      await tester.pumpAndSettle();
      await tester.tap(find.bySemanticsLabel('Đi sâu vào Cầu Bình An'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(ActionChip, 'Nguồn vốn'));
      await tester.pump();
      expect(server.callsTo('GET', '/bi/drill'), hasLength(2), reason: 'the deeper drill is on its way');

      await tester.tap(find.text('Quay lại'));
      await tester.pump();
      expect(find.text('Đi sâu vào Cầu Bình An theo:'), findsNothing, reason: 'the chooser of the level that was left is closed');
      expect(find.text('Sở Nông nghiệp'), findsOneWidget);

      held.complete(FakeTransport.json(200, answer(dimension: 'fund_source', total: figure('300000000'), children: <Map<String, Object?>>[groupJson('f-1', 'Ngân sách trung ương', '300000000')], token: tokenAUnit)));
      await tester.pumpAndSettle();

      expect(find.text('Ngân sách trung ương'), findsNothing, reason: 'the answer belongs to a level the person left');
      expect(find.textContaining('Cầu Bình An (Nguồn vốn)'), findsNothing);
      expect(find.text('Sở Nông nghiệp'), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('a drill the server refuses is told with its code beside the figures, which stay', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final SemanticsHandle semantics = tester.ensureSemantics();
      final ScriptedServer server = biServer();
      server.refuse('GET', '/bi/drill', 409, 'SNAPSHOT_EXPIRED');
      await _open(tester, server, _dashboard(snapshot: snapA));

      await tester.tap(find.bySemanticsLabel('Đi sâu vào Sở Giao thông'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(ActionChip, 'Dự án'));
      await tester.pumpAndSettle();

      expect(find.textContaining('Phiên phân tích đã hết hạn (30 phút)'), findsOneWidget);
      expect(find.text('SNAPSHOT_EXPIRED'), findsOneWidget);
      expect(find.text('Sở Giao thông'), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('renewing makes a new context on the newest snapshot: the tiles are read again over it and the banner goes', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = biServer(newData: true, newer: snapB, frozen: <String>[snapB, snapA]);
      server.on('POST', '/bi/query-contexts/refresh', (_) => <String, Object?>{'operation_id': 'o', 'status': 'OK', 'resource_version': 1, 'snapshot_id': snapB, 'drill_token': tokenB});
      await _open(tester, server, _dashboard(snapshot: snapA));

      await tester.tap(find.widgetWithText(FilledButton, 'Làm mới dữ liệu'));
      await tester.pumpAndSettle();

      expect(_body(server.callsTo('POST', '/bi/query-contexts/refresh').single)['drill_token'], tokenA);
      final List<Object?> snapshots = server.callsTo('POST', '/dashboard-queries').map((HttpCall call) => _body(call)['snapshot_id']).toList();
      expect(snapshots.sublist(0, 2), <String>[snapA, snapA]);
      expect(snapshots.sublist(2).toSet(), <String>{snapB}, reason: 'after the renewal every tile is of the newer snapshot');
      expect(find.text('Có dữ liệu mới hơn'), findsNothing);
      expect(find.textContaining('Đã chuyển sang ảnh chụp 10b00000'), findsOneWidget);
      expect(find.text('10b00000, kỳ 2026-10'), findsOneWidget);
    });

    testWidgets('the banner of the old snapshot goes at once when the renewal is done, not when the tiles have answered again', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = biServer(newData: true, newer: snapB);
      server.on('POST', '/bi/query-contexts/refresh', (_) => <String, Object?>{'snapshot_id': snapB, 'drill_token': tokenB});
      await _open(tester, server, _dashboard(snapshot: snapA));
      final Completer<void> hold = Completer<void>();
      server.answer('POST', '/dashboard-queries', (HttpCall call) async {
        await hold.future;
        return FakeTransport.json(200, _body(call)['metric_version_id'] == metricRate ? rateAnswer(snapshot: snapB) : paidAnswer(snapshot: snapB));
      });

      await tester.tap(find.widgetWithText(FilledButton, 'Làm mới dữ liệu'));
      await tester.pump();
      await tester.pump();

      expect(find.text('Có dữ liệu mới hơn'), findsNothing, reason: 'the figures of the old snapshot are gone, and so is what was said about them');
      expect(find.text('Đang tải số liệu…'), findsWidgets);
      hold.complete();
      await tester.pumpAndSettle();
      expect(find.text('64,13%'), findsOneWidget);
    });

    testWidgets('the renewal needs a connection: offline it is disabled with the reason beside it', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = biServer(newData: true, newer: snapB);
      final ProviderContainer container = await _open(tester, server, _dashboard(snapshot: snapA));

      container.read(reachabilityProvider.notifier).report(Reachability.offline);
      await tester.pumpAndSettle();

      expect(find.text('Làm mới dữ liệu cần có kết nối.'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Làm mới dữ liệu')).onPressed, isNull);
      expect(server.callsTo('POST', '/bi/query-contexts/refresh'), isEmpty);
    });

    testWidgets('a renewal the server refuses is told with its code and the snapshot that is open stays', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = biServer(newData: true, newer: snapB);
      server.refuse('POST', '/bi/query-contexts/refresh', 400, 'DRILL_TOKEN_INVALID');
      await _open(tester, server, _dashboard(snapshot: snapA));

      await tester.tap(find.widgetWithText(FilledButton, 'Làm mới dữ liệu'));
      await tester.pumpAndSettle();

      expect(find.textContaining('Phiên phân tích này không còn hợp lệ'), findsOneWidget);
      expect(find.text('DRILL_TOKEN_INVALID'), findsOneWidget);
      expect(find.text('10a00000, kỳ 2026-10'), findsOneWidget);
    });

    testWidgets('an expired drill offers the renewal in place', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final SemanticsHandle semantics = tester.ensureSemantics();
      final ScriptedServer server = biServer(frozen: <String>[snapB, snapA]);
      server.refuse('GET', '/bi/drill', 409, 'SNAPSHOT_EXPIRED');
      server.on('POST', '/bi/query-contexts/refresh', (_) => <String, Object?>{'snapshot_id': snapB, 'drill_token': tokenB});
      await _open(tester, server, _dashboard(snapshot: snapA));

      await tester.tap(find.bySemanticsLabel('Đi sâu vào Sở Giao thông'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(ActionChip, 'Dự án'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(TextButton, 'Làm mới dữ liệu'));
      await tester.pumpAndSettle();

      expect(server.callsTo('POST', '/bi/query-contexts/refresh'), hasLength(1));
      expect(find.text('10b00000, kỳ 2026-10'), findsOneWidget);
      semantics.dispose();
    });
  });

  group('AC-ST-MOB-027-1 which snapshot a dashboard is read over', () {
    testWidgets('without a named snapshot the newest frozen version of the data is used; the versions are read next to the dashboard', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = biServer(frozen: <String>[snapB, snapA]);
      await _open(tester, server, _dashboard());

      expect(server.callsTo('POST', '/dashboard-queries').map((HttpCall call) => _body(call)['snapshot_id']).toSet(), <String>{snapB});
      expect(server.callsTo('GET', '/bi/datasets/$dataset/versions'), hasLength(1));
    });

    testWidgets('a pinned dashboard is read over the version it pinned, and looks nothing up', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = biServer(dashboard: standardDashboard(policy: 'PINNED', pinned: <String>[snapB]), frozen: <String>[snapB, snapA]);
      await _open(tester, server, _dashboard(snapshot: snapA));
      expect(server.callsTo('POST', '/dashboard-queries').map((HttpCall call) => _body(call)['snapshot_id']).toSet(), <String>{snapA}, reason: 'the snapshot the person named wins over the pin');

      final ScriptedServer pinned = biServer(dashboard: standardDashboard(policy: 'PINNED', pinned: <String>[snapA]), frozen: <String>[snapB, snapA]);
      await _open(tester, pinned, _dashboard());
      expect(pinned.callsTo('POST', '/dashboard-queries').map((HttpCall call) => _body(call)['snapshot_id']).toSet(), <String>{snapA}, reason: 'the pin wins over the newest');
    });

    testWidgets('no frozen version of any period yet: said so, and no query is made', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = biServer(frozen: const <String>[]);
      await _open(tester, server, _dashboard());

      expect(find.text('Chưa có bản dữ liệu đã chốt của kỳ nào.'), findsOneWidget);
      expect(server.callsTo('POST', '/dashboard-queries'), isEmpty);
    });

    testWidgets('a dashboard without a version, or without a tile, says so', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      await _open(tester, biServer(dashboard: dashboardJson(dashEmpty)), _dashboard(id: dashEmpty));
      expect(find.text('Dashboard này chưa có phiên bản nào.'), findsOneWidget);

      await _open(tester, biServer(dashboard: standardDashboard(widgets: <Map<String, Object?>>[])), _dashboard());
      expect(find.text('Phiên bản này chưa có ô nào.'), findsOneWidget);
    });

    testWidgets('a metric that is no longer certified is said so at the top', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      await _open(tester, biServer(dashboard: standardDashboard(certified: false)), _dashboard(snapshot: snapA));
      expect(find.textContaining('Có chỉ tiêu không còn được chứng nhận'), findsOneWidget);
    });
  });

  group('AC-ST-MOB-027-3 UAT-NFR-PERFORMANCE-02 the first content does not wait for the rest', () {
    testWidgets('the tiles ask for their figures together, and the first answer is on the screen while the other is still on its way', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = biServer();
      final Completer<void> slow = Completer<void>();
      server.answer('POST', '/dashboard-queries', (HttpCall call) async {
        if (_body(call)['metric_version_id'] == metricPaid) await slow.future;
        return FakeTransport.json(200, _body(call)['metric_version_id'] == metricRate ? rateAnswer() : paidAnswer());
      });
      await _open(tester, server, _dashboard(snapshot: snapA));

      expect(server.callsTo('POST', '/dashboard-queries'), hasLength(2), reason: 'the second tile did not wait for the first to be answered');
      expect(find.text('64,13%'), findsOneWidget, reason: 'the fast tile is already there');
      expect(find.text('Đang tải số liệu…'), findsWidgets, reason: 'the slow one says it is loading');

      slow.complete();
      await tester.pumpAndSettle();
      expect(find.text('Sở Giao thông'), findsOneWidget);
    });

    testWidgets('a heavy question is waited for as a job, and a job that is still running after a minute says so', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = biServer();
      server.answer('POST', '/dashboard-queries', (HttpCall call) {
        final bool rate = _body(call)['metric_version_id'] == metricRate;
        return rate ? FakeTransport.json(200, rateAnswer()) : FakeTransport.json(202, <String, Object?>{'status': 'ASYNC_JOB', 'run_id': 'run-9'});
      });
      server.on('GET', '/bi/query-runs/:id', (_) => <String, Object?>{'status': 'RUNNING'});
      await _open(tester, server, _dashboard(snapshot: snapA));

      expect(find.text('64,13%'), findsOneWidget);
      expect(find.textContaining('Truy vấn này nặng nên đang chạy nền'), findsOneWidget);
      await tester.tap(find.widgetWithText(TextButton, 'Thử lại'));
      await tester.pumpAndSettle();
      expect(server.callsTo('POST', '/dashboard-queries'), hasLength(3), reason: 'two tiles, and the tile that waits asked again');
    });

    testWidgets('a tile the server refuses says why with its code; the others are not affected', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = biServer();
      server.answer('POST', '/dashboard-queries', (HttpCall call) {
        final bool rate = _body(call)['metric_version_id'] == metricRate;
        return rate
            ? FakeTransport.json(200, rateAnswer())
            : HttpResult(status: 403, headers: const <String, String>{'content-type': 'application/problem+json'}, body: jsonEncode(<String, Object?>{'type': 'about:blank', 'title': 'x', 'status': 403, 'code': 'ACCESS_POLICY_MISSING'}));
      });
      await _open(tester, server, _dashboard(snapshot: snapA));

      expect(find.text('64,13%'), findsOneWidget);
      expect(find.textContaining('Bộ dữ liệu này đang đóng với bạn'), findsOneWidget);
      expect(find.text('ACCESS_POLICY_MISSING'), findsOneWidget);
    });
  });

  group('AC-ST-MOB-027-1 a tile whose query changes in a refreshed dashboard is read again, and never shown with the figures of the old query', () {
    Map<String, Object?> tileOf(String metric) => standardDashboard(widgets: <Map<String, Object?>>[widgetJson('w-1', 'BAR', metric, dimension: 'unit', title: 'Ô một')]);

    testWidgets('the tile keeps its id and snapshot but names another metric: it asks the server for that metric', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = biServer(dashboard: tileOf(metricPaid));
      await _open(tester, server, _dashboard(snapshot: snapA));
      expect(find.text('Sở Giao thông'), findsOneWidget);
      expect(find.text('64,13%'), findsNothing);

      final Map<String, Object?> changed = tileOf(metricRate);
      server.on('GET', '/bi/dashboards/:id', (_) => changed);
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();

      final List<HttpCall> queries = server.callsTo('POST', '/dashboard-queries');
      expect(queries, hasLength(2));
      expect(_body(queries.last)['metric_version_id'], metricRate);
      expect(find.text('64,13%'), findsOneWidget, reason: 'the figures of the new metric');
      expect(find.text('Sở Giao thông'), findsNothing, reason: 'nothing of the old metric stays under the new definition');
    });

    testWidgets('the saved copy of the old query is not offered for the new one when the server cannot be reached', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = biServer(dashboard: tileOf(metricPaid));
      await _open(tester, server, _dashboard(snapshot: snapA));
      expect(find.text('Sở Giao thông'), findsOneWidget);

      final Map<String, Object?> changed = tileOf(metricRate);
      server.on('GET', '/bi/dashboards/:id', (_) => changed);
      server.answer('POST', '/dashboard-queries', (HttpCall call) => throw const SocketException('no connection'));
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();

      expect(find.text('Không kết nối được máy chủ và chưa có bản lưu của ô này.'), findsOneWidget);
      expect(find.text('Sở Giao thông'), findsNothing, reason: 'a copy of another metric is not a copy of this tile');
    });
  });

  group('AC-ST-MOB-027-1 UI-MOB-40 what the tile kinds draw', () {
    testWidgets('a line and an area are sketched through the groups that have a figure, with the exact figures listed under them; a table is rows only', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final Map<String, Object?> dashboard = standardDashboard(widgets: <Map<String, Object?>>[
        widgetJson('w-line', 'LINE', metricPaid, dimension: 'unit', title: 'Đường'),
        widgetJson('w-area', 'AREA', metricPaid, dimension: 'unit', title: 'Miền', y: 4),
        widgetJson('w-table', 'TABLE', metricPaid, dimension: 'unit', title: 'Bảng', y: 8),
        widgetJson('w-pie', 'PIE', metricPaid, dimension: 'unit', title: 'Tròn', y: 12),
      ]);
      await _open(tester, biServer(dashboard: dashboard), _dashboard(snapshot: snapA));

      expect(find.byType(LineSketch), findsNWidgets(2));
      expect(find.byType(ProportionBar), findsNWidgets(2), reason: 'the pie draws bars; the line, the area and the table do not');
      expect(find.text('300.000.000 ₫'), findsNWidgets(4));
    });

    testWidgets('a list of more than eight groups shows eight and offers the rest', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = biServer();
      server.on('POST', '/dashboard-queries', (HttpCall call) => _body(call)['metric_version_id'] == metricRate
          ? rateAnswer()
          : answer(dimension: 'unit', total: figure('55'), children: <Map<String, Object?>>[for (int i = 1; i <= 10; i += 1) groupJson('u-$i', 'Đơn vị $i', '$i', token: 'tk-$i')]));
      await _open(tester, server, _dashboard(snapshot: snapA));

      expect(find.text('Đơn vị 8'), findsOneWidget);
      expect(find.text('Đơn vị 9'), findsNothing);
      await tester.tap(find.text('Xem tất cả 10 nhóm'));
      await tester.pumpAndSettle();
      expect(find.text('Đơn vị 10'), findsOneWidget);
      await tester.tap(find.text('Thu gọn'));
      await tester.pumpAndSettle();
      expect(find.text('Đơn vị 10'), findsNothing);
    });

    testWidgets('groups that do not add up to the total say so, and the quarantine and the cut are told', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = biServer();
      server.on('POST', '/dashboard-queries', (HttpCall call) => _body(call)['metric_version_id'] == metricRate
          ? rateAnswer()
          : <String, Object?>{
              ...paidAnswer(),
              'reconciles_to_parent': false,
              'non_additive_reason': 'DISTINCT_NOT_ADDITIVE',
              'excluded_quarantine_rows': 3,
              'truncated': true,
              'feeds_certified': false,
              'scope': <String, Object?>{'label': 'FULL_TENANT'},
            });
      await _open(tester, server, _dashboard(snapshot: snapA));

      expect(find.textContaining('Không cộng được: một đối tượng có thể thuộc nhiều nhóm'), findsOneWidget);
      expect(find.text('(đã loại tối đa 3 dòng cách ly)'), findsOneWidget);
      expect(find.textContaining('Danh sách nhóm bị cắt ở mức tối đa'), findsOneWidget);
      expect(find.textContaining('(không dùng cho số liệu chứng nhận)'), findsOneWidget);
      expect(find.text('Toàn bộ tổ chức'), findsOneWidget);
    });

    testWidgets('the dashboard is read in English as well', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      await _open(tester, biServer(), _dashboard(snapshot: snapA), locale: const Locale('en'));
      expect(find.text('BI dashboard'), findsOneWidget);
      expect(find.text('64.13%'), findsOneWidget);
      expect(find.text('Data quality: Passed'), findsNWidgets(2));
      expect(find.text('Version 3, published'), findsOneWidget);
    });

    testWidgets('a draft version is called a draft', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final Map<String, Object?> draft = dashboardJson(dashD1, version: versionD1, versions: <Map<String, Object?>>[versionJson(versionD1, <Map<String, Object?>>[widgetJson('w-rate', 'KPI', metricRate)], status: 'DRAFT')]);
      await _open(tester, biServer(dashboard: draft), _dashboard(snapshot: snapA));
      expect(find.text('Phiên bản 3, bản nháp'), findsOneWidget);

      final Map<String, Object?> old = dashboardJson(dashD1, version: versionD1, versions: <Map<String, Object?>>[versionJson(versionD1, <Map<String, Object?>>[widgetJson('w-rate', 'KPI', metricRate)], status: 'SUPERSEDED')]);
      await _open(tester, biServer(dashboard: old), _dashboard(snapshot: snapA));
      expect(find.text('Phiên bản 3, đã được thay thế'), findsOneWidget);
    });
  });

  group('AC-ST-MOB-027-1 BR-MOB-01 a copy kept on the device is shown as a copy', () {
    testWidgets('when the server cannot be reached a tile shows its last answer with the period it describes, and nothing can be drilled', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final SemanticsHandle semantics = tester.ensureSemantics();
      final ScriptedServer server = biServer();
      final ProviderContainer container = await _open(tester, server, _dashboard(snapshot: snapA));
      expect(find.text('300.000.000 ₫'), findsOneWidget);

      container.read(routerProvider).go('/home/mob-52');
      await tester.pumpAndSettle();
      server.offline = true;
      container.read(routerProvider).go(_dashboard(snapshot: snapA));
      await tester.pumpAndSettle();

      expect(find.textContaining('Bản lưu trên máy, số liệu kỳ 2026-10'), findsNWidgets(2));
      expect(find.text('Số tiền chỉ để tham khảo, không sửa được.'), findsWidgets);
      expect(find.text('300.000.000 ₫'), findsOneWidget);
      expect(find.bySemanticsLabel('Đi sâu vào Sở Giao thông'), findsNothing, reason: 'a drill is a question to the server');
      semantics.dispose();
    });

    testWidgets('a tile with no copy and no connection says so, with the code, and can be tried again', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = biServer();
      server.answer('POST', '/dashboard-queries', (_) => throw const SocketException('no signal'));
      await _open(tester, server, _dashboard(snapshot: snapA));

      expect(find.text('Không kết nối được máy chủ và chưa có bản lưu của ô này.'), findsNWidgets(2));
      expect(find.text('NETWORK_ERROR'), findsNWidgets(2));
      server.answer('POST', '/dashboard-queries', (HttpCall call) => FakeTransport.json(200, _body(call)['metric_version_id'] == metricRate ? rateAnswer() : paidAnswer()));
      server.offline = false;
      await tester.tap(find.widgetWithText(TextButton, 'Thử lại').first);
      await tester.pumpAndSettle();
      expect(find.text('64,13%'), findsOneWidget);
    });

    testWidgets('a copy older than twelve hours is marked out of date', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = biServer();
      DateTime clock = kNow;
      final ProviderContainer container = await pumpWithServer(tester, features: <MobileFeature>[personal_bi.feature], server: server, location: _dashboard(snapshot: snapA), now: () => clock, overrides: <Override>[_instantJobs]);
      container.read(routerProvider).go('/home/mob-52');
      await tester.pumpAndSettle();
      clock = kNow.add(const Duration(hours: 13));
      server.offline = true;
      container.read(routerProvider).go(_dashboard(snapshot: snapA));
      await tester.pumpAndSettle();

      expect(find.textContaining('Bản lưu đã quá 12 giờ'), findsNWidgets(3), reason: 'the page and each of the two tiles say their copy is out of date');
    });

    testWidgets('what the server refuses is not kept: a taken-away right leaves no copy of the tile', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = biServer();
      final ProviderContainer container = await _open(tester, server, _dashboard(snapshot: snapA));
      expect((container.read(readCacheProvider) as InMemoryReadCache).length, greaterThan(0));

      container.read(routerProvider).go('/home/mob-52');
      await tester.pumpAndSettle();
      server.refuse('POST', '/dashboard-queries', 403, 'SCOPE_DENIED');
      container.read(routerProvider).go(_dashboard(snapshot: snapA));
      await tester.pumpAndSettle();
      expect(find.text('SCOPE_DENIED'), findsWidgets);

      server.clear();
      server.offline = true;
      container.read(routerProvider).go('/home/mob-52');
      await tester.pumpAndSettle();
      container.read(routerProvider).go(_dashboard(snapshot: snapA));
      await tester.pumpAndSettle();
      expect(find.textContaining('Bản lưu trên máy, số liệu kỳ'), findsNothing, reason: 'the copies of the refused tiles were dropped');
    });
  });

  group('AC-ST-MOB-027-4 UI-MOB-40 MOB-40 the library of dashboards and the seven states', () {
    testWidgets('the library lists the dashboards of the reader: theirs first, with the version and whether the metrics are certified; a dashboard without a version cannot be opened', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      server.on('GET', '/bi/dashboards', (_) => <String, Object?>{
            'items': <Object?>[
              dashboardJson(dashShared, title: 'Chung của tổ chức', mine: false, owner: 'Nguyễn Văn An', version: versionD1, certified: false),
              dashboardJson(dashD1, version: versionD1),
              dashboardJson(dashEmpty, title: 'Chưa có gì'),
            ],
            'next_cursor': null,
          });
      final ProviderContainer container = await _open(tester, server, '/home/mob-40');

      final List<String> titles = tester.widgetList<Text>(find.byType(Text)).map((Text t) => t.data ?? '').toList();
      expect(titles.indexOf('Giải ngân của tôi'), lessThan(titles.indexOf('Chung của tổ chức')), reason: 'their own first');
      expect(find.text('Của bạn'), findsNWidgets(2), reason: 'two of the three are theirs');
      expect(find.text('Chủ sở hữu: Nguyễn Văn An'), findsOneWidget);
      expect(find.text('Có chỉ tiêu không còn được chứng nhận'), findsOneWidget);
      expect(find.text('Chỉ tiêu đã chứng nhận'), findsOneWidget);
      expect(find.text('Chưa có phiên bản'), findsOneWidget);

      await tester.tap(find.text('Chưa có gì'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/home/mob-40', reason: 'nothing to open');

      server.on('GET', '/bi/dashboards/:id', (_) => standardDashboard());
      server.on('GET', '/bi/datasets', (_) => <String, Object?>{'items': <Object?>[]});
      await tester.tap(find.text('Giải ngân của tôi'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/home/mob-40?dashboard=$dashD1');
      await pressBack(tester);
      expect(currentLocation(container), '/home/mob-40');
    });

    testWidgets('a library longer than the pages the phone reads says there is more', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      int page = 0;
      server.on('GET', '/bi/dashboards', (_) {
        page += 1;
        return <String, Object?>{
          'items': <Object?>[dashboardJson('d1000000-0000-4000-8000-00000000010$page', title: 'Bảng $page', version: versionD1)],
          'next_cursor': 'c$page',
        };
      });
      await _open(tester, server, '/home/mob-40');

      expect(server.callsTo('GET', '/bi/dashboards'), hasLength(4));
      expect(find.text('Bảng 4'), findsOneWidget);
      expect(find.text('Còn dashboard chưa hiển thị.'), findsOneWidget);
    });

    testWidgets('every state of the library is drawn and the contract of the screen holds', (WidgetTester tester) async {
      void healthy(ScriptedServer server) => server.on('GET', '/bi/dashboards', (_) => <String, Object?>{
            'items': <Object?>[dashboardJson(dashD1, version: versionD1), dashboardJson(dashShared, title: 'Chung', mine: false, version: versionD1)],
            'next_cursor': null,
          });
      await expectEveryState(
        tester,
        open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/home/mob-40'),
        script: StateScript(healthy: healthy, content: find.text('Giải ngân của tôi'), empty: (ScriptedServer server) => server.on('GET', '/bi/dashboards', (_) => <String, Object?>{'items': <Object?>[], 'next_cursor': null})),
      );
      await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/home/mob-40'), healthy: healthy);
    });

    testWidgets('every state of a dashboard is drawn and the contract of the screen holds', (WidgetTester tester) async {
      void healthy(ScriptedServer server) {
        server.on('GET', '/bi/dashboards/:id', (_) => standardDashboard());
        server.on('POST', '/dashboard-queries', (HttpCall call) => _body(call)['metric_version_id'] == metricRate ? rateAnswer(newData: true, newer: snapB) : paidAnswer(newData: true, newer: snapB));
        server.on('GET', '/bi/datasets', (_) => <String, Object?>{'items': <Object?>[]});
      }

      await expectEveryState(
        tester,
        open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, _dashboard(snapshot: snapA)),
        script: StateScript(healthy: healthy, content: find.text('Giải ngân của tôi')),
      );
      await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, _dashboard(snapshot: snapA)), healthy: healthy);
    });
  });
}
