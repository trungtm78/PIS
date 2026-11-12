import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/widgets/deadline.dart';
import 'package:machvon_mobile/features/procurement_workflow/navigation.dart';
import 'package:machvon_mobile/features/procurement_workflow/screens/package_detail_screen.dart';
import 'package:machvon_mobile/features/procurement_workflow/screens/package_list_screen.dart';
import 'package:machvon_mobile/features/procurement_workflow/screens/process_tree_screen.dart';

import '../../support/harness.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'prc_fixtures.dart';
import 'prc_host.dart';

class _Taps {
  final List<String> packages = <String>[];
  final List<String> nodes = <String>[];
  int trees = 0;

  PrcNavigator get navigator => PrcNavigator(
        openPackage: (BuildContext context, String id) => packages.add(id),
        openNode: (BuildContext context, String id) => nodes.add(id),
        openTree: (BuildContext context) => trees += 1,
      );
}

/// Opens a tab of the package screen: the row of tabs scrolls, so the tab is brought into view first.
Future<void> openTab(WidgetTester tester, Finder tab) async {
  await tester.ensureVisible(tab);
  await tester.pumpAndSettle();
  await tester.tap(tab);
  await tester.pumpAndSettle();
}

void _registerTree(ScriptedServer server, {int total = 10}) => server.on('GET', '/package-workflows/process-tree', (_) => treeJson(total: total));

void _registerPackages(ScriptedServer server, [Object? Function(HttpCall call)? answer]) {
  server.on(
    'GET',
    '/package-workflows/process-tree/packages',
    answer ??
        (HttpCall call) => rowPage(<Object?>[
              rowJson('a', 'G-001', late: true, lateDays: 3, left: -3, stalled: true),
              rowJson('b', 'G-002', owner: null, title: 'Gói thầu thiết bị'),
            ]),
  );
}

void main() {
  setUp(forgetExpandedNodes);

  group('MOB-69 the packages by step', () {
    testWidgets('shows the chips of the steps with their counts and the packages of the method: code, project, price, days, holder, late with icon and word', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _registerTree(server);
      _registerPackages(server);
      await openPrcScreen(tester, server, const PackageListScreen());

      expect(find.text('Tất cả · 10'), findsOneWidget);
      expect(find.text('Lập hồ sơ mời thầu · 4'), findsOneWidget);
      expect(find.text('Đánh giá hồ sơ dự thầu · 3'), findsOneWidget);
      expect(find.text('Hoàn thành · 1'), findsOneWidget);
      expect(find.text('G-001 · Gói thầu xây lắp'), findsOneWidget);
      expect(find.text('G-002 · Gói thầu thiết bị'), findsOneWidget);
      expect(find.text('Trễ 3 ngày'), findsOneWidget, reason: 'a late package says so in words, with its icon');
      expect(find.text('Đứng yên'), findsOneWidget);
      expect(find.text('Dự án: DA-001 · Đường vành đai 1'), findsNWidgets(2));
      expect(find.text('Giá gói: 450 triệu đồng'), findsNWidgets(2));
      expect(find.text('5 ngày làm việc ở bước'), findsNWidgets(2));
      expect(find.text('Quá hạn 3 ngày · 15/11'), findsOneWidget);
      expect(find.text('Còn 3 ngày · 15/11'), findsOneWidget);
      expect(find.text('Người giữ: Nguyễn Văn An'), findsOneWidget);
      expect(find.text('Chưa có người phụ trách'), findsOneWidget);
      expect(find.text('Hiển thị 2 gói thầu'), findsOneWidget);
      // The default node is the method with most packages; the tree is read for the counts of the chips.
      expect(server.callsTo('GET', '/package-workflows/process-tree/packages').single.url.queryParameters['node_id'], 'M:OPEN_BIDDING');
    });

    testWidgets('a chip reads the packages of its step; the node of the query opens the screen on it; a tap on a row goes to the package', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _registerTree(server);
      _registerPackages(server);
      final _Taps taps = _Taps();
      await openPrcScreen(tester, server, PackageListScreen(initialNode: 'S:OPEN_BIDDING:EVALUATE', navigator: taps.navigator));
      expect(server.callsTo('GET', '/package-workflows/process-tree/packages').single.url.queryParameters['node_id'], 'S:OPEN_BIDDING:EVALUATE');

      await tester.ensureVisible(find.text('Lập hồ sơ mời thầu · 4'));
      await tester.tap(find.text('Lập hồ sơ mời thầu · 4'));
      await tester.pumpAndSettle();
      expect(server.callsTo('GET', '/package-workflows/process-tree/packages').last.url.queryParameters['node_id'], 'S:OPEN_BIDDING:DOC_PREPARE');

      await tester.tap(find.text('G-001 · Gói thầu xây lắp'));
      expect(taps.packages, <String>['a']);
      await tester.tap(find.text('Xem cây tiến độ'));
      expect(taps.trees, 1);
    });

    testWidgets('follows the cursor: more rows are appended, the next page is asked with the cursor, a failure says so in place and can be tried again', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _registerTree(server);
      int served = 0;
      _registerPackages(server, (HttpCall call) {
        if (call.url.queryParameters['cursor'] == null) return rowPage(<Object?>[rowJson('a', 'G-001')], next: 'c1');
        served += 1;
        return rowPage(<Object?>[rowJson('b', 'G-002', title: 'Gói thầu thiết bị')]);
      });
      await openPrcScreen(tester, server, const PackageListScreen());
      expect(find.text('G-002 · Gói thầu thiết bị'), findsNothing);

      server.answer('GET', '/package-workflows/process-tree/packages', (HttpCall call) => throw StateError('refused'));
      await tester.tap(find.text('Tải thêm'));
      await tester.pumpAndSettle();
      expect(find.text('Chưa tải được trang kế tiếp.'), findsOneWidget);
      expect(find.text('G-001 · Gói thầu xây lắp'), findsOneWidget, reason: 'what was shown stays');

      _registerPackages(server, (HttpCall call) {
        served += 1;
        expect(call.url.queryParameters['cursor'], 'c1');
        return rowPage(<Object?>[rowJson('b', 'G-002', title: 'Gói thầu thiết bị')]);
      });
      await tester.tap(find.text('Thử lại'));
      await tester.pumpAndSettle();
      expect(find.text('G-002 · Gói thầu thiết bị'), findsOneWidget);
      expect(find.text('Hiển thị 2 gói thầu'), findsOneWidget);
      expect(find.text('Tải thêm'), findsNothing, reason: 'the list was read to its end');
      expect(served, greaterThan(0));
    });

    testWidgets('a node with no package is the filter-found-nothing empty state and offers to go back to all; a partial read says so', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _registerTree(server);
      _registerPackages(server, (HttpCall call) => rowPage(<Object?>[], truncated: true));
      await openPrcScreen(tester, server, const PackageListScreen(initialNode: 'S:OPEN_BIDDING:EVALUATE'));
      expect(find.text('Chưa có gói thầu ở bước này'), findsOneWidget);
      expect(find.text('Bộ lọc đang áp dụng: Đánh giá hồ sơ dự thầu'), findsOneWidget, reason: 'the filter in use is named');
      await tester.tap(find.text('Xóa bộ lọc'));
      await tester.pumpAndSettle();
      expect(server.callsTo('GET', '/package-workflows/process-tree/packages').last.url.queryParameters['node_id'], 'M:OPEN_BIDDING');
    });

    testWidgets('a row carries the band of its due day with the real day: late, soon, ok; a completed package is done and a package with no due day has no band', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _registerTree(server);
      _registerPackages(server, (HttpCall call) => rowPage(<Object?>[
            rowJson('a', 'G-001', left: -3),
            rowJson('b', 'G-002', left: 2),
            rowJson('c', 'G-003', left: 9),
            rowJson('d', 'G-004', status: 'COMPLETED'),
            rowJson('e', 'G-005', status: 'NOT_STARTED'),
          ]));
      await openPrcScreen(tester, server, const PackageListScreen());

      final List<DeadlineGlyph> glyphs = tester.widgetList<DeadlineGlyph>(find.byType(DeadlineGlyph)).toList();
      expect(glyphs.map((DeadlineGlyph glyph) => glyph.band), <DeadlineBand>[DeadlineBand.late, DeadlineBand.soon, DeadlineBand.ok, DeadlineBand.done], reason: 'the not started package has no glyph');
      expect(find.byType(DeadlineLabel), findsNWidgets(3), reason: 'the completed and the not started have no countdown');
      expect(find.bySemanticsLabel('G-001 Gói thầu xây lắp, Đang thực hiện, Quá hạn: Quá hạn 3 ngày · 15/11'), findsOneWidget);
    });

    testWidgets('a truncated page says the list is partial', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _registerTree(server);
      _registerPackages(server, (HttpCall call) => rowPage(<Object?>[rowJson('a', 'G-001')], truncated: true));
      await openPrcScreen(tester, server, const PackageListScreen());
      expect(find.textContaining('Danh sách chỉ là một phần'), findsOneWidget);
    });

    testWidgets('offline, the copy of the last read is shown with the moment it describes and no claim that it is the newest', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _registerTree(server);
      _registerPackages(server);
      await openPrcScreen(tester, server, const PackageListScreen());
      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Đang hiển thị dữ liệu đã lưu trên máy, số liệu tại 12/11/2026 10:00'), findsOneWidget);
      expect(find.text('G-001 · Gói thầu xây lắp'), findsOneWidget);
      expect(find.textContaining('mới nhất'), findsNothing);
    });

    testWidgets('every state, and the screen contract at the three devices and at 200 percent text', (WidgetTester tester) async {
      Future<void> open(WidgetTester tester, ScriptedServer server) => openPrcScreen(tester, server, const PackageListScreen()).then((_) {});
      await expectEveryState(
        tester,
        open: open,
        script: StateScript(
          healthy: (ScriptedServer server) {
            _registerTree(server);
            _registerPackages(server);
          },
          content: find.text('G-001 · Gói thầu xây lắp'),
          empty: (ScriptedServer server) => _registerTree(server, total: 0),
        ),
      );
      await expectScreenContract(
        tester,
        open: open,
        healthy: (ScriptedServer server) {
          _registerTree(server);
          _registerPackages(server);
        },
      );
    });
  });

  group('MOB-71 the process tree as an outline', () {
    testWidgets('shows the methods with their count, health in words, value, share and the KPIs; the states appear when a row is opened', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _registerTree(server);
      await openPrcScreen(tester, server, const ProcessTreeScreen());

      expect(find.text('Tổng 10 gói thầu'), findsOneWidget);
      expect(find.text('Kỳ 13/10/2026 đến 12/11/2026'), findsOneWidget);
      expect(find.text('Quy trình đấu thầu rộng rãi'), findsOneWidget);
      expect(find.text('10 gói'), findsOneWidget);
      expect(find.text('Lập hồ sơ mời thầu'), findsNothing, reason: 'a method is closed until it is opened');
      expect(find.text('Đang xử lý'), findsOneWidget);

      await tester.tap(find.text('Quy trình đấu thầu rộng rãi'));
      await tester.pumpAndSettle();
      expect(find.text('Xem 10 gói thầu'), findsOneWidget);
      expect(find.text('Lập hồ sơ mời thầu'), findsOneWidget);
      expect(find.text('4 gói'), findsOneWidget);
      expect(find.text('Cần chú ý'), findsOneWidget, reason: 'two of the four are late');
      expect(find.text('2 trễ'), findsOneWidget);
      expect(find.text('40% tổng'), findsOneWidget);
      expect(find.text('trung vị 6 ngày làm việc'), findsOneWidget);
      expect(find.text('trung vị 9,5 ngày'), findsOneWidget, reason: 'calendar days when the calendar is not published');
      expect(find.text('Đã chuyển vào trong kỳ: 3 gói'), findsOneWidget);
      expect(find.text('Trả lại trong kỳ: 1 gói'), findsOneWidget, reason: 'the step that sent one back says so in words');
      expect(find.text('Chưa bắt đầu quy trình'), findsOneWidget);
      expect(find.text('Hủy / không thành'), findsOneWidget);
    });

    testWidgets('a step opens into its states; an empty state stays in the structure but opens nothing; a state and "see the packages" open the node', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _registerTree(server);
      final _Taps taps = _Taps();
      await openPrcScreen(tester, server, ProcessTreeScreen(navigator: taps.navigator));
      await tester.tap(find.text('Quy trình đấu thầu rộng rãi'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Lập hồ sơ mời thầu'));
      await tester.pumpAndSettle();

      expect(find.text('Trễ hạn'), findsOneWidget);
      expect(find.text('Đúng tiến độ'), findsWidgets);
      expect(find.text('Tạm dừng'), findsOneWidget, reason: 'the empty state of the step is still a row');

      await tester.tap(find.text('Trễ hạn'));
      expect(taps.nodes, <String>['S:OPEN_BIDDING:DOC_PREPARE:LATE']);
      // The empty "Tạm dừng" row of the first step has no package: it opens nothing.
      await tester.tap(find.text('Tạm dừng'));
      expect(taps.nodes, hasLength(1));
      await tester.tap(find.text('Xem 4 gói thầu'));
      expect(taps.nodes.last, 'S:OPEN_BIDDING:DOC_PREPARE');
    });

    testWidgets('a method with no definition says its packages are listed together, and the way to its packages is the first row', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      final Map<String, Object?> tree = treeJson();
      (tree['nodes']! as List<Object?>).removeWhere((Object? one) => (one! as Map<String, Object?>)['kind'] == 'STEP' || (one as Map<String, Object?>)['kind'] == 'SUBSTATE');
      server.on('GET', '/package-workflows/process-tree', (_) => tree);
      await openPrcScreen(tester, server, const ProcessTreeScreen());
      await tester.tap(find.text('Quy trình đấu thầu rộng rãi'));
      await tester.pumpAndSettle();
      expect(find.textContaining('chưa có định nghĩa quy trình hiệu lực'), findsOneWidget);
    });

    testWidgets('the rows that were open stay open when the screen is opened again (UI state of the session)', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _registerTree(server);
      await openPrcScreen(tester, server, const ProcessTreeScreen());
      await tester.tap(find.text('Quy trình đấu thầu rộng rãi'));
      await tester.pumpAndSettle();
      await openPrcScreen(tester, server, const ProcessTreeScreen());
      expect(find.text('Lập hồ sơ mời thầu'), findsOneWidget);
    });

    testWidgets('every state, and the screen contract at the three devices and at 200 percent text', (WidgetTester tester) async {
      Future<void> open(WidgetTester tester, ScriptedServer server) => openPrcScreen(tester, server, const ProcessTreeScreen()).then((_) {});
      await expectEveryState(
        tester,
        open: open,
        script: StateScript(healthy: _registerTree, content: find.text('Quy trình đấu thầu rộng rãi'), empty: (ScriptedServer server) => _registerTree(server, total: 0)),
      );
      await expectScreenContract(tester, open: open, healthy: _registerTree);
    });
  });

  group('MOB-70 one package', () {
    void register(ScriptedServer server, [Map<String, Object?>? body]) => server.on('GET', '/procurement-packages/k-1/workflow', (_) => body ?? detailJson());

    testWidgets('says where the package is in one line, what blocks it, the stepper with the standard and the actual days, and the checklist', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      register(server);
      await openPrcScreen(tester, server, const PackageDetailScreen(packageId: 'k-1'));

      expect(find.text('G-001 · Gói thầu xây lắp số 1'), findsOneWidget);
      expect(find.text('Đang ở Đánh giá hồ sơ dự thầu · 6 ngày làm việc · trễ 2 ngày so với chuẩn · người giữ: Nguyễn Văn An'), findsOneWidget);
      expect(find.text('Quá hạn 2 ngày · 10/11'), findsOneWidget);
      expect(find.text('Đã đi 2/4 bước · 52%'), findsOneWidget);
      expect(find.text('Còn 1 mục bắt buộc chưa xong'), findsOneWidget);
      expect(find.text('Bước quá hạn 2 ngày'), findsOneWidget);
      expect(find.text('Giá gói'), findsOneWidget);
      expect(find.text('450.000.000 đồng (450 triệu đồng)'), findsOneWidget);
      await openTab(tester, find.text('Các bước'));
      // The stepper: done, done, late (the only one that is not "done"), upcoming; the standard against the actual days.
      expect(find.text('Xong'), findsNWidgets(2));
      expect(find.text('Trễ'), findsOneWidget);
      expect(find.text('Sắp tới'), findsOneWidget);
      expect(find.text('chuẩn 4 · thực 6'), findsOneWidget);
      expect(find.text('chuẩn 10'), findsOneWidget, reason: 'a step that was passed with no days kept shows only its standard');
      expect(find.text('chuẩn 6'), findsOneWidget, reason: 'a step not reached shows only its standard');
      await openTab(tester, find.textContaining('Danh mục kiểm'));
      expect(find.text('Khai báo không có xung đột lợi ích'), findsOneWidget);
      expect(find.text('Báo cáo đánh giá hồ sơ dự thầu'), findsOneWidget);
      expect(find.text('Giao cho: Lê Văn Cường'), findsOneWidget);
      expect(find.text('Xác nhận'), findsOneWidget, reason: 'the evidence kind as a chip');
      await openTab(tester, find.text('Tổng quan'));
      expect(find.text('Kiến nghị: 1 đang chờ trên tổng 1'), findsOneWidget);
      expect(find.text('Mở thầu: 04/11/2026'), findsOneWidget);
    });

    testWidgets('the timeline groups the days newest first with the wait up to today as a gap; a tap on the gap lists the days; the filter keeps the changes of state only', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      register(server);
      await openPrcScreen(tester, server, const PackageDetailScreen(packageId: 'k-1'));
      await openTab(tester, find.text('Dòng thời gian'));

      expect(find.text('Thứ Tư, 04/11/2026 · 1 thay đổi'), findsOneWidget);
      expect(find.text('Thứ Ba, 03/11/2026'), findsOneWidget);
      expect(find.text('Thứ Hai, 02/11/2026 · 1 thay đổi'), findsOneWidget);
      expect(find.text('Chuyển từ Lập hồ sơ mời thầu sang Đánh giá hồ sơ dự thầu'), findsOneWidget);
      expect(find.text('Người làm: Nguyễn Văn An'), findsWidgets);
      expect(find.text('sau 2 ngày làm việc ở bước trước'), findsOneWidget);
      expect(find.text('Hoàn thành mục: DOC_DRAFTED'), findsOneWidget);
      expect(find.text('Tài liệu'), findsOneWidget);
      expect(find.text('Bắt đầu quy trình'), findsOneWidget);
      expect(find.text('6 ngày ở Đánh giá hồ sơ dự thầu · trễ 2 ngày so với chuẩn'), findsOneWidget);

      expect(find.text('8 ngày không có thay đổi · đang chờ Đánh giá hồ sơ dự thầu'), findsOneWidget);
      await tester.tap(find.text('8 ngày không có thay đổi · đang chờ Đánh giá hồ sơ dự thầu'));
      await tester.pumpAndSettle();
      expect(find.textContaining('05/11, 06/11, 07/11'), findsOneWidget);

      await tester.tap(find.text('Chỉ đổi trạng thái'));
      await tester.pumpAndSettle();
      expect(find.text('Hoàn thành mục: DOC_DRAFTED'), findsNothing);
      expect(find.text('Thứ Ba, 03/11/2026'), findsNothing);
      expect(find.text('1 ngày không có thay đổi · khi đó chờ Lập hồ sơ mời thầu'), findsOneWidget);
      await tester.tap(find.text('Tất cả thay đổi'));
      await tester.pumpAndSettle();
      expect(find.text('Hoàn thành mục: DOC_DRAFTED'), findsOneWidget);
    });

    testWidgets('a system event says "Hệ thống", an overdue step carries its consequence and a note can be opened; a timeline with no entry says so', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      final Map<String, Object?> body = detailJson();
      final Map<String, Object?> timeline = (body['workflow']! as Map<String, Object?>)['timeline']! as Map<String, Object?>;
      (timeline['days']! as List<Object?>).insert(0, <String, Object?>{
        'day': '2026-11-11',
        'entries': <Object?>[
          entryJson('e9', 'CLOCK_OVERDUE', '2026-11-11T00:00:00.000+07:00', from: 'EVALUATE', to: 'EVALUATE', reason: '2026-11-10'),
          entryJson('e8', 'RETURN', '2026-11-11T02:00:00.000Z', from: 'EVALUATE', to: 'DOC_PREPARE', actor: 'Lê Văn Cường', reason: 'Thiếu hồ sơ kỹ thuật', change: true),
        ],
        'state_changes': 1,
        'checklist_done': 0,
      });
      register(server, body);
      await openPrcScreen(tester, server, const PackageDetailScreen(packageId: 'k-1'));
      await openTab(tester, find.text('Dòng thời gian'));
      expect(find.text('Quá hạn bước Đánh giá hồ sơ dự thầu (hạn 10/11/2026)'), findsOneWidget);
      expect(find.textContaining('Người làm: Hệ thống'), findsOneWidget);
      expect(find.textContaining('các bước sau và ngày ký hợp đồng bị đẩy lùi'), findsOneWidget);
      expect(find.text('Trả lại từ Đánh giá hồ sơ dự thầu về Lập hồ sơ mời thầu'), findsOneWidget);
      expect(find.text('Lý do: Thiếu hồ sơ kỹ thuật'), findsOneWidget);
    });

    testWidgets('a package that has not started shows the steps it will follow; a package on hold says why', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      ScriptedServer server = ScriptedServer();
      register(server, detailJson(withWorkflow: false));
      await openPrcScreen(tester, server, const PackageDetailScreen(packageId: 'k-1'));
      expect(find.textContaining('chưa bắt đầu quy trình lựa chọn nhà thầu'), findsOneWidget);
      expect(find.text('1. Lập kế hoạch lựa chọn nhà thầu · chuẩn 10 ngày làm việc'), findsOneWidget);
      expect(find.text('Dòng thời gian từng ngày'), findsNothing);

      server = ScriptedServer();
      register(server, detailJson(status: 'ON_HOLD', late: false));
      await openPrcScreen(tester, server, const PackageDetailScreen(packageId: 'k-1'));
      expect(find.text('Tạm dừng: Chờ ý kiến chủ đầu tư'), findsOneWidget);
      expect(find.text('Tạm dừng'), findsWidgets);
    });

    testWidgets('in English the same screen reads in English', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      register(server);
      await openPrcScreen(tester, server, const PackageDetailScreen(packageId: 'k-1'), locale: const Locale('en'));
      expect(find.text('Package progress'), findsOneWidget);
      await openTab(tester, find.text('Timeline'));
      expect(find.text('Wednesday, 04/11/2026 · 1 changes'), findsOneWidget);
      expect(find.text('Moved from Lập hồ sơ mời thầu to Đánh giá hồ sơ dự thầu'), findsOneWidget);
    });

    testWidgets('every state, and the screen contract at the three devices and at 200 percent text', (WidgetTester tester) async {
      Future<void> open(WidgetTester tester, ScriptedServer server) => openPrcScreen(tester, server, const PackageDetailScreen(packageId: 'k-1')).then((_) {});
      await expectEveryState(tester, open: open, script: StateScript(healthy: register, content: find.text('G-001 · Gói thầu xây lắp số 1')));
      await expectScreenContract(tester, open: open, healthy: register);
    });
  });
}
