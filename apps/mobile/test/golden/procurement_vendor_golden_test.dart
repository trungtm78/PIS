import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/features/procurement_workflow/screens/package_detail_screen.dart';
import 'package:machvon_mobile/features/procurement_workflow/screens/package_list_screen.dart';
import 'package:machvon_mobile/features/procurement_workflow/screens/process_tree_screen.dart';
import 'package:machvon_mobile/features/vendor_controls/screens/contractor_screen.dart';
import 'package:machvon_mobile/features/vendor_controls/screens/risk_list_screen.dart';

import '../features/procurement_workflow/prc_fixtures.dart';
import '../features/procurement_workflow/prc_host.dart';
import '../features/support/scripted_server.dart';
import '../features/vendor_controls/vendor_host.dart';
import '../support/harness.dart';
import '../support/v2_support.dart';

/// Golden images of the screens of MUX-3 wave B that belong to the procurement workflow (MOB-69, 70, 71) and to the contractor controls (MOB-73,
/// 74): the light mode, the dark mode, 200 percent text, the empty list and the copy kept on the phone when it is offline. The texts are drawn with
/// the test font, so the antialiasing of Windows and Linux is accepted up to the tolerance of the text-heavy goldens; layout and touch targets are
/// proved by the widget tests and the screen contract of the features.

const Size _phone = Size(390, 844);

const String _packages = '/package-workflows/process-tree/packages';
const String _risks = '/vendor/risk-grades';

ScriptedServer _prcServer({bool empty = false}) {
  final ScriptedServer server = ScriptedServer()
    ..on('GET', '/package-workflows/process-tree', (_) => treeJson())
    ..on('GET', '/package-workflows/process-tree/node', (_) => <String, Object?>{
          'node_id': 'M:OPEN_BIDDING',
          'count': 10,
          'late_count': 2,
          'as_of': asOf,
          'median_days': 6.5,
          'longest_days': 14,
          'shortest_days': 1,
          'basis': 'WORKING_DAYS',
          'stalled_count': 1,
          'held_count': 1,
          'no_owner_count': 1,
        })
    ..on('GET', _packages, (_) => empty
        ? rowPage(<Object?>[])
        : rowPage(<Object?>[
            rowJson('a', 'G-001', late: true, lateDays: 3, left: -3, stalled: true),
            rowJson('b', 'G-002', owner: null, title: 'Gói thầu thiết bị', left: 2),
            rowJson('c', 'G-003', title: 'Gói thầu tư vấn giám sát', left: 9, value: '2350000000'),
          ]))
    ..on('GET', '/procurement-packages/k-1/workflow', (_) => detailJson());
  return server;
}

ScriptedServer _vendorServer({bool empty = false}) {
  final ScriptedServer server = ScriptedServer()
    ..on('GET', _risks, (_) => riskPage(empty
        ? <Map<String, Object?>>[]
        : <Map<String, Object?>>[
            riskItem('c-1', 'Công ty Xây dựng An Phát', 'HIGH', 52, overdue: true, pending: 'CRITICAL'),
            riskItem('c-2', 'Công ty Cơ khí Bình Minh', 'LOW', 8),
            riskItem('c-3', 'Công ty Hòa Bình', 'MEDIUM', 30),
          ]))
    ..on('GET', '/vendor/contractors/c-1/risk', (_) => riskGrade())
    ..on('GET', '/vendor/contractors/c-1/performance', (_) => performance());
  return server;
}

Future<void> _prc(WidgetTester tester, ScriptedServer server, Widget screen, {Brightness brightness = Brightness.light, double scale = 1.0}) async {
  useDevice(tester, _phone, textScale: scale);
  await openPrcScreen(tester, server, screen, brightness: brightness);
}

Future<void> _vendor(WidgetTester tester, ScriptedServer server, Widget screen, {Brightness brightness = Brightness.light, double scale = 1.0}) async {
  useDevice(tester, _phone, textScale: scale);
  await openVendorScreen(tester, server, screen, brightness: brightness);
}

Future<void> _tab(WidgetTester tester, Finder tab) async {
  await tester.ensureVisible(tab);
  await tester.pumpAndSettle();
  await tester.tap(tab);
  await tester.pumpAndSettle();
}

void main() {
  useTolerantGoldens('test/golden/procurement_vendor_golden_test.dart', tolerance: kTextGoldenTolerance);

  group('MUX-3 wave B the packages by step (MOB-69)', () {
    testWidgets('light', (WidgetTester tester) async {
      await _prc(tester, _prcServer(), const PackageListScreen());
      expect(find.text('G-001 · Gói thầu xây lắp'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/proc_list_light.png'));
    });

    testWidgets('dark', (WidgetTester tester) async {
      await _prc(tester, _prcServer(), const PackageListScreen(), brightness: Brightness.dark);
      expect(Theme.of(tester.element(find.text('G-001 · Gói thầu xây lắp'))).brightness, Brightness.dark);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/proc_list_dark.png'));
    });

    testWidgets('text 200 percent', (WidgetTester tester) async {
      await _prc(tester, _prcServer(), const PackageListScreen(), scale: 2.0);
      expect(tester.takeException(), isNull);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/proc_list_text200.png'));
    });

    testWidgets('empty: a step with no package offers to go back to all the steps', (WidgetTester tester) async {
      await _prc(tester, _prcServer(empty: true), const PackageListScreen(initialNode: 'S:OPEN_BIDDING:EVALUATE'));
      expect(find.text('Xóa bộ lọc'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/proc_list_empty.png'));
    });

    testWidgets('offline: the copy kept on the phone', (WidgetTester tester) async {
      final ScriptedServer server = _prcServer();
      await _prc(tester, server, const PackageListScreen());
      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();
      expect(find.textContaining('dữ liệu đã lưu trên máy'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/proc_list_offline.png'));
    });
  });

  group('MUX-3 wave B one package (MOB-70)', () {
    testWidgets('overview, light', (WidgetTester tester) async {
      await _prc(tester, _prcServer(), const PackageDetailScreen(packageId: 'k-1'));
      expect(find.text('Đã đi 2/4 bước · 52%'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/proc_detail_light.png'));
    });

    testWidgets('overview, dark', (WidgetTester tester) async {
      await _prc(tester, _prcServer(), const PackageDetailScreen(packageId: 'k-1'), brightness: Brightness.dark);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/proc_detail_dark.png'));
    });

    testWidgets('overview, text 200 percent', (WidgetTester tester) async {
      await _prc(tester, _prcServer(), const PackageDetailScreen(packageId: 'k-1'), scale: 2.0);
      expect(tester.takeException(), isNull);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/proc_detail_text200.png'));
    });

    testWidgets('the steps as a timeline', (WidgetTester tester) async {
      await _prc(tester, _prcServer(), const PackageDetailScreen(packageId: 'k-1'));
      await _tab(tester, find.text('Các bước'));
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/proc_detail_steps.png'));
    });

    testWidgets('the day-by-day timeline, dark', (WidgetTester tester) async {
      await _prc(tester, _prcServer(), const PackageDetailScreen(packageId: 'k-1'), brightness: Brightness.dark);
      await _tab(tester, find.text('Dòng thời gian'));
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/proc_detail_timeline_dark.png'));
    });

    testWidgets('offline: the copy kept on the phone', (WidgetTester tester) async {
      final ScriptedServer server = _prcServer();
      await _prc(tester, server, const PackageDetailScreen(packageId: 'k-1'));
      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/proc_detail_offline.png'));
    });
  });

  group('MUX-3 wave B the progress tree (MOB-71)', () {
    testWidgets('light', (WidgetTester tester) async {
      await _prc(tester, _prcServer(), const ProcessTreeScreen());
      await tester.tap(find.text('Quy trình đấu thầu rộng rãi'));
      await tester.pumpAndSettle();
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/proc_tree_light.png'));
    });

    testWidgets('dark', (WidgetTester tester) async {
      await _prc(tester, _prcServer(), const ProcessTreeScreen(), brightness: Brightness.dark);
      await tester.tap(find.text('Quy trình đấu thầu rộng rãi'));
      await tester.pumpAndSettle();
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/proc_tree_dark.png'));
    });
  });

  group('MUX-3 wave B the grades of risk (MOB-73)', () {
    testWidgets('light', (WidgetTester tester) async {
      await _vendor(tester, _vendorServer(), const RiskListScreen());
      expect(find.text('Công ty Xây dựng An Phát'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/vendor_list_light.png'));
    });

    testWidgets('dark', (WidgetTester tester) async {
      await _vendor(tester, _vendorServer(), const RiskListScreen(), brightness: Brightness.dark);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/vendor_list_dark.png'));
    });

    testWidgets('text 200 percent', (WidgetTester tester) async {
      await _vendor(tester, _vendorServer(), const RiskListScreen(), scale: 2.0);
      expect(tester.takeException(), isNull);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/vendor_list_text200.png'));
    });

    testWidgets('empty', (WidgetTester tester) async {
      await _vendor(tester, _vendorServer(empty: true), const RiskListScreen());
      expect(find.text('Chưa có dữ liệu'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/vendor_list_empty.png'));
    });

    testWidgets('offline: the copy kept on the phone', (WidgetTester tester) async {
      final ScriptedServer server = _vendorServer();
      await _vendor(tester, server, const RiskListScreen());
      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/vendor_list_offline.png'));
    });
  });

  group('MUX-3 wave B one contractor (MOB-74)', () {
    testWidgets('light', (WidgetTester tester) async {
      await _vendor(tester, _vendorServer(), const ContractorScreen(contractorId: 'c-1'));
      expect(find.text('Mức đã xác nhận: Cao'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/vendor_detail_light.png'));
    });

    testWidgets('dark', (WidgetTester tester) async {
      await _vendor(tester, _vendorServer(), const ContractorScreen(contractorId: 'c-1'), brightness: Brightness.dark);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/vendor_detail_dark.png'));
    });

    testWidgets('text 200 percent', (WidgetTester tester) async {
      await _vendor(tester, _vendorServer(), const ContractorScreen(contractorId: 'c-1'), scale: 2.0);
      expect(tester.takeException(), isNull);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/vendor_detail_text200.png'));
    });

    testWidgets('the performance tab', (WidgetTester tester) async {
      await _vendor(tester, _vendorServer(), const ContractorScreen(contractorId: 'c-1'));
      await _tab(tester, find.text('Kết quả'));
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/vendor_detail_performance.png'));
    });
  });
}
