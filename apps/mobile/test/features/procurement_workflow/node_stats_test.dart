import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/features/procurement_workflow/node_stats.dart';
import 'package:machvon_mobile/features/procurement_workflow/screens/package_list_screen.dart';

import '../../support/harness.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'prc_fixtures.dart';
import 'prc_host.dart';

/// The statistics of the node on MOB-69: what the server counted for the node in view, written out, and an honest line when it could not.

Map<String, Object?> nodeStatsJson({String nodeId = 'M:OPEN_BIDDING', bool full = true}) => <String, Object?>{
      'node_id': nodeId,
      'count': 10,
      'late_count': 2,
      'as_of': asOf,
      if (full) ...<String, Object?>{
        'median_days': 6.5,
        'longest_days': 14,
        'shortest_days': 1,
        'basis': 'WORKING_DAYS',
        'stalled_count': 1,
        'held_count': 1,
        'no_owner_count': 1,
        'top_owners': <Object?>[
          <String, Object?>{'id': 'm-1', 'name': 'Nguyễn Văn An', 'count': 4},
          <String, Object?>{'id': null, 'name': null, 'count': 3},
        ],
        'unfinished_items': <Object?>[
          <String, Object?>{'step_code': 'DOC_PREPARE', 'item_code': 'APPRAISAL', 'name': 'Thẩm định hồ sơ mời thầu', 'count': 3},
          <String, Object?>{'step_code': 'EVALUATE', 'item_code': 'REPORT', 'count': 2},
        ],
        'weeks': <Object?>[
          <String, Object?>{'week_of': '2026-11-02', 'arrivals': 3, 'departures': 1},
          <String, Object?>{'week_of': '2026-11-09', 'arrivals': 2, 'departures': 2},
        ],
        'truncated': true,
      },
    };

ScriptedServer _server({Object? Function()? stats, int? refuseStatus}) {
  final ScriptedServer server = ScriptedServer()
    ..on('GET', '/package-workflows/process-tree', (_) => treeJson())
    ..on('GET', '/package-workflows/process-tree/packages', (_) => rowPage(<Object?>[rowJson('a', 'G-001'), rowJson('b', 'G-002')]));
  if (refuseStatus != null) {
    server.refuse('GET', '/package-workflows/process-tree/node', refuseStatus, 'SCOPE_DENIED');
  } else {
    server.on('GET', '/package-workflows/process-tree/node', (_) => stats == null ? nodeStatsJson() : stats());
  }
  return server;
}

void main() {
  group('the model of the statistics of a node', () {
    test('keeps what the server counted and leaves out what it did not send', () {
      final PrcNodeStats stats = parsePrcNodeStats(nodeStatsJson())!;
      expect(stats.count, 10);
      expect(stats.lateCount, 2);
      expect(stats.medianDays, 6.5);
      expect(stats.longestDays, 14);
      expect(stats.working, isTrue);
      expect(stats.topOwners.map((PrcTopOwner owner) => owner.name), <String>['Nguyễn Văn An'], reason: 'a holder with no name is not made up');
      expect(stats.unfinished.map((PrcUnfinishedItem item) => item.label), <String>['Thẩm định hồ sơ mời thầu', 'REPORT'], reason: 'the code stands in for a name the definition lacks');
      expect(stats.weeks, hasLength(2));
      expect(stats.truncated, isTrue);

      final PrcNodeStats bare = parsePrcNodeStats(nodeStatsJson(full: false))!;
      expect(bare.hasDays, isFalse);
      expect(bare.stalledCount, isNull, reason: 'a count the server did not send is unknown, not zero');
      expect(bare.topOwners, isEmpty);
    });

    test('an answer without the node, the count, the late count or the day is refused as a whole', () {
      for (final String key in <String>['node_id', 'count', 'late_count', 'as_of']) {
        expect(parsePrcNodeStats(nodeStatsJson()..remove(key)), isNull, reason: key);
      }
      expect(parsePrcNodeStats('nope'), isNull);
    });
  });

  group('MOB-69 shows the statistics of the node in view', () {
    testWidgets('days, counts, who holds most, what is open and the weeks, in words; the node is the one the list shows', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = _server();
      await openPrcScreen(tester, server, const PackageListScreen());

      expect(find.text('Thống kê của bước đang xem'), findsOneWidget);
      expect(find.text('10 gói, 2 trễ hạn'), findsOneWidget, reason: 'closed, the card is one line with the two counts');
      expect(find.text('6,5 ngày làm việc'), findsNothing);
      await tester.tap(find.text('Thống kê của bước đang xem'));
      await tester.pumpAndSettle();
      expect(find.text('6,5 ngày làm việc'), findsOneWidget);
      expect(find.text('14 ngày làm việc'), findsOneWidget);
      expect(find.text('1 ngày làm việc'), findsOneWidget);
      expect(find.text('Nguyễn Văn An: 4 gói'), findsOneWidget);
      expect(find.text('Thẩm định hồ sơ mời thầu: 3 gói'), findsOneWidget);
      expect(find.text('REPORT: 2 gói'), findsOneWidget);
      expect(find.text('Tuần từ 02/11/2026: vào 3, ra 1'), findsOneWidget);
      expect(find.text('Các danh sách chỉ là một phần: phạm vi có nhiều gói hơn mức đọc một lần.'), findsOneWidget);
      expect(server.callsTo('GET', '/package-workflows/process-tree/node').single.url.queryParameters['node_id'], 'M:OPEN_BIDDING');
      // The packages of the node are still there.
      expect(find.text('G-001 · Gói thầu xây lắp'), findsOneWidget);
      await tester.tap(find.text('Thu gọn'));
      await tester.pumpAndSettle();
      expect(find.text('6,5 ngày làm việc'), findsNothing, reason: 'closed again');
    });

    testWidgets('a server that cannot give the statistics says so with the code and the packages stay', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = _server(refuseStatus: 403);
      await openPrcScreen(tester, server, const PackageListScreen());

      expect(find.textContaining('Chưa đọc được thống kê của bước này (mã SCOPE_DENIED)'), findsOneWidget);
      expect(find.text('G-001 · Gói thầu xây lắp'), findsOneWidget);
    });

    testWidgets('an answer that does not hold what the card needs is a contract mismatch, not an empty card', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = _server(stats: () => <String, Object?>{'nope': 1});
      await openPrcScreen(tester, server, const PackageListScreen());

      expect(find.textContaining('mã CONTRACT_MISMATCH'), findsOneWidget);
    });

    testWidgets('English words, and calendar days when the server counted calendar days', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = _server(stats: () => nodeStatsJson()..['basis'] = 'CALENDAR_DAYS');
      await openPrcScreen(tester, server, const PackageListScreen(), locale: const Locale('en'));

      expect(find.text('Statistics of the step in view'), findsOneWidget);
      await tester.tap(find.text('Statistics of the step in view'));
      await tester.pumpAndSettle();
      expect(find.text('6.5 calendar days'), findsOneWidget);
      expect(find.text('Week of 02/11/2026: in 3, out 1'), findsOneWidget);
    });
  });
}
