import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart' show HttpCall;
import 'package:machvon_mobile/core/di/providers.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/navigation/mobile_routes.generated.dart';
import 'package:machvon_mobile/core/navigation/route_table.dart';
import 'package:machvon_mobile/core/widgets/stat_strip.dart';
import 'package:machvon_mobile/features/dashboard/dashboard_feature.dart' as dashboard;
import 'package:machvon_mobile/features/project_workflow/project_workflow_feature.dart' as pwf;
import 'package:machvon_mobile/features/project_workflow/pwf_home_card.dart';
import 'package:machvon_mobile/features/project_workflow/pwf_models.dart';
import 'package:machvon_mobile/features/project_workflow/pwf_todo_read.dart';
import 'package:machvon_mobile/features/project_workflow/screens/my_tasks_screen.dart';

import '../../support/harness.dart';
import '../dashboard/dashboard_fixtures.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'pwf_fixtures.dart';

void main() {
  group('the block "my tasks by deadline" of the home screen', () {
    test('reads the counts of the three colours from the answer of /me/project-tasks', () {
      final PwfHomeCounts? counts = parsePwfHomeCounts(<String, Object?>{
        'items': <Object?>[],
        'counts_by_band': <String, Object?>{'RED': 4, 'YELLOW': 1, 'GREEN': 6, 'NONE': 20, 'UNKNOWN': 0},
      });
      expect(counts, (red: 4, yellow: 1, green: 6));
    });

    test('a colour the answer leaves out counts nothing, and a count that is not a number is not trusted', () {
      expect(parsePwfHomeCounts(<String, Object?>{'counts_by_band': <String, Object?>{'RED': '3'}}), (red: 0, yellow: 0, green: 0));
    });

    test('an answer with no counts (an older server) gives nothing to draw', () {
      expect(parsePwfHomeCounts(<String, Object?>{'items': <Object?>[]}), isNull);
      expect(parsePwfHomeCounts(null), isNull);
      expect(parsePwfHomeCounts(<Object?>[]), isNull);
    });
  });

  group('L7b one count "to do by band" for the block of the home and the head of "Việc của tôi"', () {
    // What the leader of the demo had: tasks of their own to do, and tasks they finished that wait for another person's approval.
    final List<Map<String, Object?>> rows = <Map<String, Object?>>[
      myTask('7f3a0000-0000-4000-8000-000000000041', 'Trễ hạn', official: band('RED', days: -2), due: '2026-11-10'),
      myTask('7f3a0000-0000-4000-8000-000000000042', 'Đến hạn hôm nay', official: band('RED', days: 0), due: '2026-11-12'),
      myTask('7f3a0000-0000-4000-8000-000000000043', 'Sắp đến hạn', official: band('YELLOW', days: 2)),
      myTask('7f3a0000-0000-4000-8000-000000000044', 'Còn thời gian', official: band('GREEN', days: 9)),
      myTask('7f3a0000-0000-4000-8000-000000000045', 'Đỏ, chờ duyệt', official: band('RED', days: -1), status: 'AWAITING_APPROVAL'),
      myTask('7f3a0000-0000-4000-8000-000000000046', 'Vàng, chờ duyệt', official: band('YELLOW', days: 1), status: 'AWAITING_APPROVAL'),
      myTask('7f3a0000-0000-4000-8000-000000000047', 'Xanh, chờ duyệt', official: band('GREEN', days: 8), status: 'AWAITING_APPROVAL'),
      myTask('7f3a0000-0000-4000-8000-000000000048', 'Còn xa', official: band('NONE', reason: 'FAR'), due: '2027-03-01'),
      myTask('7f3a0000-0000-4000-8000-000000000049', 'Tạm dừng, vàng', official: band('YELLOW', days: 3), status: 'ON_HOLD'),
    ];
    // The server counts every open task by its official colour, the ones that wait for approval among them.
    final Map<String, Object?> answer = <String, Object?>{
      ...myTasksJson(items: rows),
      'counts_by_band': <String, Object?>{'RED': 3, 'YELLOW': 3, 'GREEN': 2, 'NONE': 1, 'UNKNOWN': 0},
    };

    test('tasks that wait for another person are in none of the three figures; a task on hold still is', () {
      final PwfMyTasks page = parsePwfMyTasks(answer)!;
      expect(pwfTodoByBand(page.items), (red: 2, yellow: 2, green: 1));
      expect(pwfTodoByBand(page.items, personal: false), (red: 2, yellow: 2, green: 1));
      expect(pwfTodoByBand(const <PwfMyTask>[]), (red: 0, yellow: 0, green: 0));
    });

    test('the block of the home says what the head of "Việc của tôi" says, not the counts of the server', () async {
      final ({PwfHomeCounts counts, bool more})? home = await readPwfHomeTodo((String? cursor) async => answer);
      final PwfTodoCount head = await readPwfTodo(parsePwfMyTasks(answer)!, (String? cursor) async => fail('a list of one page asks for no other'));
      expect(home!.counts, head.personal);
      expect(home.counts, (red: 2, yellow: 2, green: 1));
      expect(home.more, isFalse);
      expect(parsePwfHomeCounts(answer), (red: 3, yellow: 3, green: 2), reason: 'the triple the home used to show');
    });

    test('a level of the person that reminds earlier colours both the same way; the official view counts by the official colour', () {
      final PwfMyTasks page = parsePwfMyTasks(myTasksJson(items: <Map<String, Object?>>[
        myTask('7f3a0000-0000-4000-8000-000000000051', 'Nhắc sớm', official: band('GREEN', days: 6), personal: band('YELLOW', days: 6)),
        myTask('7f3a0000-0000-4000-8000-000000000052', 'Như nhau', official: band('RED', days: -1)),
      ]))!;
      expect(pwfTodoByBand(page.items), (red: 1, yellow: 1, green: 0));
      expect(pwfTodoByBand(page.items, personal: false), (red: 1, yellow: 0, green: 1));
    });

    test('an answer whose tasks cannot be read (an older server) still gives the counts of the server; one with neither gives nothing', () async {
      expect(await readPwfHomeTodo((String? cursor) async => <String, Object?>{'counts_by_band': <String, Object?>{'RED': 4, 'YELLOW': 1, 'GREEN': 6}}), (counts: (red: 4, yellow: 1, green: 6), more: false));
      expect(await readPwfHomeTodo((String? cursor) async => <String, Object?>{'items': <Object?>[]}), isNull);
      expect(await readPwfHomeTodo((String? cursor) async => null), isNull);
    });

    testWidgets('on the phone: the three numbers of the block of the home and of the head of "Việc của tôi" are the same, and both read the same page', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer()
        ..on('GET', '/home/command-center', (_) => commandCenter())
        ..on('GET', '/home/my-work', (_) => alertWork(const <Map<String, Object?>>[]))
        ..on('GET', '/me/project-tasks', (HttpCall call) => call.url.queryParameters['status'] == 'DONE' ? doneTasksJson(items: <Map<String, Object?>>[]) : answer);
      final ProviderContainer container = await pumpWithServer(tester, features: <MobileFeature>[dashboard.feature, pwf.feature], server: server, location: '/home');

      List<String> figuresUnder(Finder scope) => <String>[for (final StatCell cell in tester.widget<StatStrip>(find.descendant(of: scope, matching: find.byType(StatStrip))).cells) cell.value];

      expect(find.text('Việc theo hạn của tôi'), findsOneWidget);
      final List<String> home = figuresUnder(find.byType(PwfHomeDeadlines));
      expect(home, <String>['2', '2', '1'], reason: 'not 3, 3, 2: what waits for another person is not theirs to do');
      final List<String?> asked = <String?>[for (final HttpCall call in server.callsTo('GET', '/me/project-tasks')) call.url.queryParameters['limit']];
      expect(asked, <String>['$pwfTodoPageSize'], reason: 'one page, and no second question when the cursor ends');

      container.read(routerProvider).go(RouteTable(routes: kMobileRoutes, features: <MobileFeature>[pwf.feature]).locationOf('MOB-80'));
      await tester.pumpAndSettle();
      expect(find.byType(PwfMyTasksList), findsOneWidget);
      expect(figuresUnder(find.byType(PwfMyTasksList)), home);
      final Iterable<HttpCall> open = server.callsTo('GET', '/me/project-tasks').where((HttpCall call) => call.url.queryParameters['status'] == null);
      expect(open.map((HttpCall call) => call.url.queryParameters['limit']).toSet(), <String>{'$pwfTodoPageSize'});
    });
  });

  group('L7b the count reads every page of the list, not the first one only', () {
    String id(int n) => '7f3a0000-0000-4000-8000-${n.toString().padLeft(12, '0')}';
    Map<String, Object?> red(int n, {String status = 'IN_PROGRESS'}) => myTask(id(n), 'Việc $n', official: band('RED', days: -1), status: status);

    /// A list of [rows] in pages of 50: the cursor of a page is the index its next page starts at.
    Map<String, Object?> pageOf(List<Map<String, Object?>> rows, String? cursor) {
      final int from = cursor == null ? 0 : int.parse(cursor);
      final int to = from + pwfTodoPageSize < rows.length ? from + pwfTodoPageSize : rows.length;
      return myTasksJson(items: rows.sublist(from, to), next: to < rows.length ? '$to' : null, total: rows.length);
    }

    ScriptedServer serverOf(List<Map<String, Object?>> rows) => ScriptedServer()
      ..on('GET', '/home/command-center', (_) => commandCenter())
      ..on('GET', '/home/my-work', (_) => alertWork(const <Map<String, Object?>>[]))
      ..on('GET', '/me/project-tasks', (HttpCall call) => call.url.queryParameters['status'] == 'DONE' ? doneTasksJson(items: <Map<String, Object?>>[]) : pageOf(rows, call.url.queryParameters['cursor']));

    List<String> figuresUnder(WidgetTester tester, Finder scope) =>
        <String>[for (final StatCell cell in tester.widget<StatStrip>(find.descendant(of: scope, matching: find.byType(StatStrip))).cells) cell.value];

    Future<List<String>> homeThenList(WidgetTester tester, ScriptedServer server) async {
      final ProviderContainer container = await pumpWithServer(tester, features: <MobileFeature>[dashboard.feature, pwf.feature], server: server, location: '/home');
      expect(find.text('Việc theo hạn của tôi'), findsOneWidget, reason: 'the block is drawn');
      final List<String> home = figuresUnder(tester, find.byType(PwfHomeDeadlines));
      container.read(routerProvider).go(RouteTable(routes: kMobileRoutes, features: <MobileFeature>[pwf.feature]).locationOf('MOB-80'));
      await tester.pumpAndSettle();
      expect(figuresUnder(tester, find.byType(PwfMyTasksList)), home, reason: 'the head of the list says what the block of the home says');
      return home;
    }

    testWidgets('60 red tasks to do over two pages count 60 in the block of the home and in the head of "Việc của tôi"', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = serverOf(<Map<String, Object?>>[for (int n = 0; n < 60; n += 1) red(n)]);
      expect(await homeThenList(tester, server), <String>['60', '0', '0']);
      // The second page was read for the two counts only (the block, then the head): the rows of the list still page when the person asks.
      expect(server.callsTo('GET', '/me/project-tasks').where((HttpCall call) => call.url.queryParameters['cursor'] == '50'), hasLength(2));
    });

    testWidgets('a first page that is all waiting for approval does not hide the block: the tasks to do of the second page are counted', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = serverOf(<Map<String, Object?>>[
        for (int n = 0; n < 50; n += 1) red(n, status: 'AWAITING_APPROVAL'),
        for (int n = 50; n < 53; n += 1) red(n),
        myTask(id(53), 'Sắp đến hạn', official: band('YELLOW', days: 2)),
      ]);
      expect(await homeThenList(tester, server), <String>['3', '1', '0']);
    });

    testWidgets('past the bound of five pages the figures are written with a "+" in both places, never as a whole number', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = serverOf(<Map<String, Object?>>[for (int n = 0; n < 260; n += 1) red(n)]);
      expect(await homeThenList(tester, server), <String>['250+', '0+', '0+']);
      final Iterable<String?> cursors = server.callsTo('GET', '/me/project-tasks').where((HttpCall call) => call.url.queryParameters['status'] == null).map((HttpCall call) => call.url.queryParameters['cursor']);
      expect(cursors.toSet(), <String?>{null, '50', '100', '150', '200'}, reason: 'five pages, and the sixth is never asked for');
    });

    test('the reader: every page until the cursor ends, at most five; a page that fails ends the count there, marked as short', () async {
      final List<Map<String, Object?>> rows = <Map<String, Object?>>[for (int n = 0; n < 120; n += 1) red(n)];
      final List<String?> asked = <String?>[];
      Future<Object?> read(String? cursor) async {
        asked.add(cursor);
        return pageOf(rows, cursor);
      }

      final PwfTodoCount whole = await readPwfTodo(parsePwfMyTasks(pageOf(rows, null))!, read);
      expect(whole.personal, (red: 120, yellow: 0, green: 0));
      expect(whole.official, (red: 120, yellow: 0, green: 0));
      expect(whole.more, isFalse);
      expect(whole.isZero, isFalse);
      expect(asked, <String?>['50', '100'], reason: 'the first page is the one in hand');

      final PwfTodoCount broken = await readPwfTodo(parsePwfMyTasks(pageOf(rows, null))!, (String? cursor) async => cursor == '100' ? throw StateError('lost') : pageOf(rows, cursor));
      expect(broken.personal.red, 100);
      expect(broken.more, isTrue);
      final PwfTodoCount mismatch = await readPwfTodo(parsePwfMyTasks(pageOf(rows, null))!, (String? cursor) async => <String, Object?>{'items': 'no'});
      expect((mismatch.personal.red, mismatch.more), (50, true));

      expect(pwfTodoFigure(60, more: false), '60');
      expect(pwfTodoFigure(250, more: true), '250+');
      expect((await readPwfHomeTodo(read))!.counts.red, 120);
    });
  });
}
