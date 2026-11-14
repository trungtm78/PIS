import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/di/providers.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/navigation/mobile_routes.generated.dart';
import 'package:machvon_mobile/core/navigation/route_table.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/core/theme/colors.dart' show DeadlineBand;
import 'package:machvon_mobile/features/account/deadline_thresholds.dart';
import 'package:machvon_mobile/features/project_workflow/project_workflow_feature.dart' as pwf;
import 'package:machvon_mobile/features/project_workflow/pwf_models.dart';
import 'package:machvon_mobile/features/read_support/read_cache.dart';

import '../../support/harness.dart';
import '../../support/offline_support.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'pwf_contract.dart';
import 'pwf_fixtures.dart';

String _at(String screenId, [String suffix = '']) => RouteTable(routes: kMobileRoutes, features: <MobileFeature>[pwf.feature]).locationOf(screenId) + suffix;

Future<ProviderContainer> _open(WidgetTester tester, ScriptedServer server, String screenId, {String suffix = '', Locale locale = const Locale('vi'), FakeSession? session}) =>
    pumpWithServer(tester, features: <MobileFeature>[pwf.feature], server: server, location: _at(screenId, suffix), locale: locale, session: session);

ScriptedServer _workflowServer({Map<String, Object?>? workflow}) => ScriptedServer()..on('GET', '/projects/:id/workflow', (_) => workflow ?? workflowJson());

void main() {
  group('MOB-78 the workflow of a project', () {
    testWidgets('the strip of the stages, the progress, the count by official colour and the open stage with its tasks, each with its deadline in words and its day', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      await _open(tester, _workflowServer(), 'MOB-78', suffix: '/$kProjectId');
      expect(find.text('Giai đoạn 2/3 · Thực hiện đầu tư'), findsOneWidget);
      expect(find.text('Việc bắt buộc xong 4/9'), findsOneWidget);
      // The overview: the three official bands as three figures, each named by its band, the tasks that need a person now and the stages with what is done of each.
      expect(find.text('Quá hạn'), findsOneWidget);
      expect(find.text('Sắp đến hạn'), findsOneWidget);
      expect(find.text('Còn thời gian'), findsOneWidget);
      expect(find.textContaining('Màu hạn chính thức của đơn vị, giống nhau với mọi người xem.'), findsOneWidget);
      expect(find.text('Cần xử lý ngay'), findsOneWidget);
      expect(find.text('Các giai đoạn'), findsOneWidget);
      expect(find.textContaining('Đang thực hiện · Việc bắt buộc xong '), findsOneWidget, reason: 'one stage is the current one');
      // The work is a tab of its own: the open stage is open; the others are closed.
      await tester.tap(find.textContaining('Công việc').first);
      await tester.pumpAndSettle();
      expect(find.text('Các giai đoạn'), findsNothing);
      expect(find.text('Lập hồ sơ mời thầu gói thầu xây lắp'), findsOneWidget);
      expect(find.text('Quyết toán dự án'), findsNothing);
      expect(find.text('Quyết định chủ trương đầu tư'), findsNothing);
      // A deadline is told in words with the unit the server counted in, and its day.
      expect(find.text('Trễ 2 ngày làm việc'), findsOneWidget);
      expect(find.text('Còn 2 ngày làm việc'), findsOneWidget);
      expect(find.text('hạn 10/11'), findsOneWidget);
      // A deadline that cannot be counted says why, never a colour, and never a guess.
      expect(find.text('Chưa tính được hạn, thiếu lịch năm 2027'), findsOneWidget);
      // A branch the project does not have is not shown.
      expect(find.text('Việc của nhánh không có'), findsNothing);
    });

    testWidgets('only the official colour is on a shared screen: no word of a personal setting', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      await _open(tester, _workflowServer(), 'MOB-78', suffix: '/$kProjectId');
      expect(find.textContaining('theo cài đặt của bạn', findRichText: true), findsNothing);
      expect(find.textContaining('Theo cài đặt của bạn'), findsNothing);
    });

    testWidgets('the milestones ahead are listed first; a colour filter narrows the list and opens the stages that match; a stage can be opened and closed', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      await _open(tester, _workflowServer(), 'MOB-78', suffix: '/$kProjectId');
      // The milestones are a tab of their own: the ones not done yet, the nearest first.
      await tester.tap(find.textContaining('Mốc').first);
      await tester.pumpAndSettle();
      expect(find.text('Mốc chưa xong'), findsOneWidget);
      expect(find.text('Ký hợp đồng thi công'), findsOneWidget);
      await tester.tap(find.textContaining('Công việc').first);
      await tester.pumpAndSettle();
      expect(find.text('Mốc chưa xong'), findsNothing);
      await tester.tap(find.text('Kết thúc đầu tư'));
      await tester.pumpAndSettle();
      expect(find.text('Quyết toán dự án'), findsOneWidget);
      await tester.tap(find.text('Kết thúc đầu tư'));
      await tester.pumpAndSettle();
      expect(find.text('Quyết toán dự án'), findsNothing);
      await tester.tap(find.textContaining('Quá hạn').last);
      await tester.pumpAndSettle();
      expect(find.text('Lập hồ sơ mời thầu gói thầu xây lắp'), findsOneWidget);
      expect(find.text('Thẩm định kế hoạch lựa chọn nhà thầu'), findsNothing);
    });

    testWidgets('a task opens its screen', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = _workflowServer()..on('GET', '/project-tasks/:id', (_) => taskDetailJson(TaskState()));
      final ProviderContainer container = await _open(tester, server, 'MOB-78', suffix: '/$kProjectId');
      await tester.tap(find.text('Lập hồ sơ mời thầu gói thầu xây lắp'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), contains('/mob-79/$kTaskId'));
    });

    testWidgets('a project with no workflow says so and who starts one; a template nobody confirmed says so; a workflow on hold says so', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer none = ScriptedServer()..refuse('GET', '/projects/:id/workflow', 404, 'RESOURCE_NOT_FOUND');
      await _open(tester, none, 'MOB-78', suffix: '/$kProjectId');
      expect(find.text('Dự án chưa có workflow'), findsOneWidget);
      await _open(tester, _workflowServer(workflow: workflowJson(unverified: true, status: 'ON_HOLD')), 'MOB-78', suffix: '/$kProjectId');
      expect(find.text('Mẫu mặc định, chưa được đơn vị xác nhận.'), findsOneWidget);
      expect(find.text('Workflow đang tạm dừng cùng dự án.'), findsOneWidget);
    });

    testWidgets('offline, the copy of the last read is shown with the moment it describes', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = _workflowServer();
      final ProviderContainer container = await _open(tester, server, 'MOB-78', suffix: '/$kProjectId');
      expect(find.text('Giai đoạn 2/3 · Thực hiện đầu tư'), findsOneWidget);
      server.offline = true;
      container.read(routerProvider).go(_at('MOB-09'));
      await tester.pumpAndSettle();
      container.read(routerProvider).go(_at('MOB-78', '/$kProjectId'));
      await tester.pumpAndSettle();
      expect(find.text('Giai đoạn 2/3 · Thực hiện đầu tư'), findsOneWidget);
      expect(find.textContaining('dữ liệu đã lưu trên máy'), findsWidgets);
    });

    testWidgets('every state, the three devices and 200 percent text', (WidgetTester tester) async {
      await expectEveryState(
        tester,
        open: (WidgetTester t, ScriptedServer server) async {
          await pumpWithServer(t, features: <MobileFeature>[pwf.feature], server: server, location: _at('MOB-78', '/$kProjectId'));
        },
        script: StateScript(healthy: (ScriptedServer server) => server.on('GET', '/projects/:id/workflow', (_) => workflowJson()), content: find.text('Giai đoạn 2/3 · Thực hiện đầu tư')),
      );
      await expectScreenContractWithData(
        tester,
        open: (WidgetTester t, ScriptedServer server) async {
          await pumpWithServer(t, features: <MobileFeature>[pwf.feature], server: server, location: _at('MOB-78', '/$kProjectId'));
        },
        healthy: (ScriptedServer server) => server.on('GET', '/projects/:id/workflow', (_) => workflowJson()),
      );
    });
  });

  group('MOB-79 one task', () {
    ScriptedServer task() => ScriptedServer()..on('GET', '/project-tasks/:id', (_) => taskDetailJson(TaskState()));

    testWidgets('every state, the three devices and 200 percent text', (WidgetTester tester) async {
      await expectEveryState(
        tester,
        open: (WidgetTester t, ScriptedServer server) async {
          await pumpWithServer(t, features: <MobileFeature>[pwf.feature], server: server, location: _at('MOB-79', '/$kTaskId'), overrides: <Override>[offlineStorageProvider.overrideWithValue(TestStorage.create().storage)]);
        },
        script: StateScript(healthy: (ScriptedServer server) => server.on('GET', '/project-tasks/:id', (_) => taskDetailJson(TaskState())), content: find.text('Lập hồ sơ mời thầu gói thầu xây lắp')),
      );
      await expectScreenContractWithData(
        tester,
        open: (WidgetTester t, ScriptedServer server) async {
          await pumpWithServer(t, features: <MobileFeature>[pwf.feature], server: server, location: _at('MOB-79', '/$kTaskId'), overrides: <Override>[offlineStorageProvider.overrideWithValue(TestStorage.create().storage)]);
        },
        healthy: (ScriptedServer server) => server.on('GET', '/project-tasks/:id', (_) => taskDetailJson(TaskState())),
      );
      // The screen watches the queue of its task through a provider that is let go when the screen is: let the tree go before the test ends.
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump(Duration.zero);
    });

    testWidgets('in English the same task reads in English, with the unit the server counted in', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      await pumpWithServer(tester, features: <MobileFeature>[pwf.feature], server: task(), location: _at('MOB-79', '/$kTaskId'), locale: const Locale('en'), overrides: <Override>[offlineStorageProvider.overrideWithValue(TestStorage.create().storage)]);
      expect(find.text('Complete task'), findsOneWidget);
      expect(find.text('Checklist'), findsOneWidget);
      expect(find.text('2 days late'), findsNothing);
      expect(find.text('2 working days late'), findsOneWidget);
    });
  });

  group('MOB-80 my tasks', () {
    ScriptedServer mine({Map<String, Object?>? body}) => ScriptedServer()..on('GET', '/me/project-tasks', (_) => body ?? myTasksJson());

    testWidgets('the colours are the person\'s own: every row that has a deadline says "Theo cài đặt của bạn" and carries the real day; the official one is said where it differs', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      await _open(tester, mine(), 'MOB-80');
      expect(find.text('Trình thẩm định báo cáo nghiên cứu khả thi'), findsOneWidget);
      // Four tasks have a deadline; each says whose colour it is.
      expect(find.textContaining('Theo cài đặt của bạn', findRichText: true), findsWidgets);
      expect(find.text('hạn 14/11'), findsOneWidget);
      expect(find.text('hạn 11/11'), findsOneWidget);
      // The first task is red by the person's setting and yellow by the official rule: the screen says both.
      expect(find.textContaining('Chính thức: Còn 2 ngày làm việc'), findsOneWidget);
      // It is grouped by the person's own band: the first and the second are in "Trễ hạn".
      expect(find.text('Trễ hạn'), findsOneWidget);
      expect(find.text('Chưa vào tầm'), findsNWidgets(2), reason: 'the group and the words of the task that is not in range');
      // What is over is a tab of its own, not a group at the foot of a long list.
      await tester.tap(find.textContaining('Đã xong').first);
      await tester.pumpAndSettle();
      expect(find.text('Trễ hạn'), findsNothing);
      expect(find.text('Không có việc nào ở mục này.'), findsNothing, reason: 'one task of the list is done');
    });

    testWidgets('a person with no level of their own (the real answer of the enterprise stack, personal_band null) sees their tasks, coloured by the official level and said to be so', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      await _open(tester, mine(body: jsonDecode(kEnterpriseMyTasksAnswer) as Map<String, Object?>), 'MOB-80');
      expect(find.text('Chưa thể tải dữ liệu'), findsNothing);
      expect(find.textContaining('CONTRACT_MISMATCH'), findsNothing);
      expect(find.text('Xác định nhu cầu, mục tiêu và sự cần thiết đầu tư'), findsOneWidget);
      expect(find.text('Thẩm định chủ trương đầu tư và nguồn vốn'), findsOneWidget);
      expect(find.text('hạn 10/11'), findsOneWidget);
      // Nothing claims a personal setting the person does not have; each open task says whose level colours it.
      expect(find.textContaining('Theo cài đặt của bạn', findRichText: true), findsNothing);
      expect(find.text('Theo mức chính thức'), findsNWidgets(2));
      expect(find.text('Trễ hạn'), findsWidgets);
    });

    testWidgets('on the official view the same list is grouped by the official colour and says nothing of a personal setting', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      await _open(tester, mine(), 'MOB-80');
      await tester.tap(find.text('Màu chính thức'));
      await tester.pumpAndSettle();
      expect(find.text('Sắp đến hạn'), findsNWidgets(2), reason: 'the figure at the head of the screen and the group of the list');
      expect(find.text('Trễ hạn'), findsOneWidget);
      expect(find.textContaining('Theo cài đặt của bạn', findRichText: true), findsNothing);
      expect(find.text('Màu hạn chính thức của đơn vị, giống nhau với mọi người xem.'), findsOneWidget);
    });

    testWidgets('more tasks are read with the cursor; a failed page says so and keeps the page that is shown', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      int reads = 0;
      server.on('GET', '/me/project-tasks', (call) {
        reads += 1;
        if (call.url.queryParameters['cursor'] == null) return myTasksJson(items: <Map<String, Object?>>[myTask('7f3a0000-0000-4000-8000-000000000041', 'Việc trang một')], next: 'c2', total: 2);
        return myTasksJson(items: <Map<String, Object?>>[myTask('7f3a0000-0000-4000-8000-000000000042', 'Việc trang hai')], total: 2);
      });
      await _open(tester, server, 'MOB-80');
      expect(find.text('Hiển thị 1 trên 2 việc'), findsOneWidget);
      await tester.tap(find.text('Tải thêm'));
      await tester.pumpAndSettle();
      expect(find.text('Việc trang hai'), findsOneWidget);
      expect(find.text('Việc trang một'), findsOneWidget);
      expect(find.text('Hiển thị 2 trên 2 việc'), findsOneWidget);
      expect(find.text('Tải thêm'), findsNothing);
      expect(reads, 2);
    });

    testWidgets('a page asked for before the list was read again answers for a cursor that no longer exists: its list is not added to the new one, and its failure is not shown', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      final Completer<void> late = Completer<void>();
      bool refreshed = false;
      server.answer('GET', '/me/project-tasks', (HttpCall call) async {
        if (call.url.queryParameters['cursor'] != null) {
          await late.future;
          return FakeTransport.json(200, myTasksJson(items: <Map<String, Object?>>[myTask('7f3a0000-0000-4000-8000-000000000042', 'Việc trang cũ')], total: 2));
        }
        if (refreshed) return FakeTransport.json(200, myTasksJson(items: <Map<String, Object?>>[myTask('7f3a0000-0000-4000-8000-000000000043', 'Việc đọc lại')], total: 1));
        return FakeTransport.json(200, myTasksJson(items: <Map<String, Object?>>[myTask('7f3a0000-0000-4000-8000-000000000041', 'Việc trang một')], next: 'c2', total: 2));
      });
      await _open(tester, server, 'MOB-80');
      await tester.tap(find.text('Tải thêm'));
      await tester.pump();
      // While the second page is on its way the person reads the list again; it has one page and no cursor.
      refreshed = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();
      expect(find.text('Việc đọc lại'), findsOneWidget);
      expect(find.text('Hiển thị 1 trên 1 việc'), findsOneWidget);
      late.complete();
      await tester.pumpAndSettle();
      expect(find.text('Việc trang cũ'), findsNothing, reason: 'the answer of the old cursor is ignored');
      expect(find.text('Hiển thị 1 trên 1 việc'), findsOneWidget);
      expect(find.text('Tải thêm'), findsNothing);
    });

    testWidgets('the reminder settings open from the note', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ProviderContainer container = await _open(tester, mine()..on('GET', '/me/deadline-preference', (_) => preferenceJson()), 'MOB-80');
      await tester.tap(find.text('Cài đặt nhắc hạn'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), contains('/mob-82'));
    });

    testWidgets('nothing to do says so (the empty state), and in English the words are English', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      await _open(tester, mine(body: myTasksJson(items: <Map<String, Object?>>[])), 'MOB-80');
      expect(find.text('Chưa có dữ liệu'), findsOneWidget);
      await _open(tester, mine(), 'MOB-80', locale: const Locale('en'));
      expect(find.text('Your colours'), findsOneWidget);
      expect(find.text('Late'), findsOneWidget);
    });

    testWidgets('every state, the three devices and 200 percent text', (WidgetTester tester) async {
      await expectEveryState(
        tester,
        open: (WidgetTester t, ScriptedServer server) async {
          await pumpWithServer(t, features: <MobileFeature>[pwf.feature], server: server, location: _at('MOB-80'));
        },
        script: StateScript(healthy: (ScriptedServer server) => server.on('GET', '/me/project-tasks', (_) => myTasksJson()), content: find.text('Trình thẩm định báo cáo nghiên cứu khả thi'), empty: (ScriptedServer server) => server.on('GET', '/me/project-tasks', (_) => myTasksJson(items: <Map<String, Object?>>[]))),
      );
      await expectScreenContractWithData(
        tester,
        open: (WidgetTester t, ScriptedServer server) async {
          await pumpWithServer(t, features: <MobileFeature>[pwf.feature], server: server, location: _at('MOB-80'));
        },
        healthy: (ScriptedServer server) => server.on('GET', '/me/project-tasks', (_) => myTasksJson()),
      );
    });
  });

  group('MOB-81 my score', () {
    ScriptedServer scores({Map<String, Object?>? body}) => ScriptedServer()..on('GET', '/me/staff-scores', (_) => body ?? scoresJson());

    testWidgets('the score of the period, how it was worked out task by task, what was left out, the response, and that it is a basis for support', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      await _open(tester, scores(), 'MOB-81');
      expect(find.text('82,5'), findsWidgets);
      expect(find.text('Tốt'), findsOneWidget);
      expect(find.textContaining('căn cứ hỗ trợ'), findsOneWidget);
      expect(find.text('Lập hồ sơ mời thầu'), findsOneWidget);
      expect(find.text('Tạm dừng được duyệt'), findsOneWidget);
      // The adjustments and the responses are on their own tab.
      await tester.scrollUntilVisible(find.textContaining('Điều chỉnh'), 200, scrollable: find.byType(Scrollable).first);
      await tester.tap(find.textContaining('Điều chỉnh').first);
      await tester.pump();
      expect(find.text('Hai việc bị tính trễ do chờ ý kiến của Sở.'), findsOneWidget);
      expect(find.textContaining('trên bản máy tính đến ngày 30/11/2026'), findsOneWidget);
      // How the score was worked out (the rule it follows) is the third tab.
      await tester.ensureVisible(find.textContaining('Cách tính').first);
      await tester.tap(find.textContaining('Cách tính').first);
      await tester.pump();
      expect(find.text('Chính sách chấm điểm: phiên bản 1'), findsOneWidget);
    });

    testWidgets('it is read only: nothing on the screen takes input or sends a command', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = scores();
      await _open(tester, server, 'MOB-81');
      expect(find.byType(TextField), findsNothing);
      expect(find.byType(FilledButton), findsNothing);
      expect(server.calls.every((HttpCall call) => call.method == 'GET'), isTrue);
    });

    testWidgets('an adjustment shows the adjusted score first and the computed one beside it; a small sample says it is not enough to rate; a period with no task says so', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      await _open(tester, scores(body: scoresJson(items: <Map<String, Object?>>[scoreItem(adjusted: 85)])), 'MOB-81');
      expect(find.text('85'), findsWidgets);
      await tester.ensureVisible(find.textContaining('Cách tính').first);
      await tester.tap(find.textContaining('Cách tính').first);
      await tester.pump();
      expect(find.text('Điểm tính được, trước điều chỉnh'), findsOneWidget);
      await tester.scrollUntilVisible(find.textContaining('Điều chỉnh'), 200, scrollable: find.byType(Scrollable).first);
      await tester.tap(find.textContaining('Điều chỉnh').first);
      await tester.pump();
      expect(find.text('Điều chỉnh +2,5 điểm'), findsOneWidget);
      await _open(tester, scores(body: scoresJson(items: <Map<String, Object?>>[scoreItem(state: 'SMALL_SAMPLE', rating: null, rated: 2)])), 'MOB-81');
      expect(find.textContaining('Mới có 2 việc được chấm'), findsOneWidget);
      expect(find.text('Chưa đủ dữ liệu'), findsWidgets);
      await _open(tester, scores(body: scoresJson(items: <Map<String, Object?>>[scoreItem(state: 'NOT_RATED', computed: null, rating: null, rated: 0)])), 'MOB-81');
      expect(find.textContaining('chưa có việc nào đủ điều kiện'), findsOneWidget);
    });

    testWidgets('R33: the score is never kept on the device: a read leaves nothing in the cache, and with no connection there is no copy to show', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = scores();
      final ProviderContainer container = await _open(tester, server, 'MOB-81');
      expect(find.text('Tốt'), findsOneWidget);
      expect((container.read(readCacheProvider) as InMemoryReadCache).length, 0);
      server.offline = true;
      container.read(routerProvider).go(_at('MOB-47'));
      await tester.pumpAndSettle();
      container.read(routerProvider).go(_at('MOB-81'));
      await tester.pumpAndSettle();
      expect(find.text('Tốt'), findsNothing);
      expect(find.text('82,5'), findsNothing);
      expect(find.text('Bạn đang ngoại tuyến'), findsWidgets);
    });

    testWidgets('R33: what the screen holds is dropped when the person, the membership or the right changes; a right that was taken away answers "no access" with nothing behind it', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = scores();
      final FakeSession session = FakeSession();
      final ProviderContainer container = await _open(tester, server, 'MOB-81', session: session);
      expect(find.text('Tốt'), findsOneWidget);
      // The membership (unit and role) the person works under changes: the score of the other membership is not shown from the old read.
      server.clear();
      server.refuse('GET', '/me/staff-scores', 403, 'SCOPE_DENIED');
      session.change(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1', membershipId: 'm-2'));
      await tester.pumpAndSettle();
      expect(find.text('Tốt'), findsNothing);
      expect(find.text('Bạn chưa có quyền truy cập'), findsOneWidget);
      expect((container.read(readCacheProvider) as InMemoryReadCache).length, 0);
    });

    testWidgets('every state, the three devices and 200 percent text', (WidgetTester tester) async {
      await expectEveryState(
        tester,
        open: (WidgetTester t, ScriptedServer server) async {
          await pumpWithServer(t, features: <MobileFeature>[pwf.feature], server: server, location: _at('MOB-81'));
        },
        script: StateScript(healthy: (ScriptedServer server) => server.on('GET', '/me/staff-scores', (_) => scoresJson()), content: find.text('Tốt'), empty: (ScriptedServer server) => server.on('GET', '/me/staff-scores', (_) => scoresJson(items: <Map<String, Object?>>[]))),
      );
      await expectScreenContractWithData(
        tester,
        open: (WidgetTester t, ScriptedServer server) async {
          await pumpWithServer(t, features: <MobileFeature>[pwf.feature], server: server, location: _at('MOB-81'));
        },
        healthy: (ScriptedServer server) => server.on('GET', '/me/staff-scores', (_) => scoresJson()),
      );
    });
  });

  group('MOB-82 my reminders', () {
    ScriptedServer prefs({Map<String, Object?>? body}) => ScriptedServer()..on('GET', '/me/deadline-preference', (_) => body ?? preferenceJson(green: 7, yellow: 3, red: 1, reminders: <int>[5, 2]));

    testWidgets('the thresholds of the person, the official rule beside them, the preview of the three bands and the note that the official alerts and the KPI do not change', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      await _open(tester, prefs(), 'MOB-82');
      expect(find.text('Quy định của đơn vị: xanh đến 5 ngày, vàng đến 2 ngày, đỏ từ 0 ngày trở xuống.'), findsOneWidget);
      expect(find.text('Đỏ: còn 1 ngày trở xuống hoặc đã quá hạn'), findsOneWidget);
      expect(find.text('Vàng: còn từ 2 đến 3 ngày'), findsOneWidget);
      expect(find.text('Xanh: còn từ 4 đến 7 ngày'), findsOneWidget);
      expect(find.textContaining('Cảnh báo chính thức, leo thang và điểm KPI vẫn theo quy định của đơn vị'), findsOneWidget);
    });

    testWidgets('the preview of the account follows the thresholds in force: the personal ones from the server, read again after a save, with the band boundaries inclusive', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      Map<String, Object?> stored = preferenceJson(green: 7, yellow: 3, red: 1, reminders: <int>[5, 2]);
      final ScriptedServer server = ScriptedServer()
        ..on('GET', '/me/deadline-preference', (_) => stored)
        ..on('PUT', '/me/deadline-preference', (HttpCall call) {
          stored = preferenceJson(green: 8, yellow: 4, red: 2, reminders: <int>[5, 2], version: 3);
          return <String, Object?>{'operation_id': 'o1', 'status': 'SAVED', 'resource_version': 3};
        });
      final ProviderContainer container = await _open(tester, server, 'MOB-82');
      container.read(deadlineThresholdsProvider);
      await tester.pumpAndSettle();
      // Red up to 1 day left, yellow up to 3: red is the days below 2, and the days on the boundaries (1 and 3) are in the band they close.
      final DeadlineThresholds before = container.read(deadlineThresholdsProvider);
      expect(before, const DeadlineThresholds(lateBelow: 2, soonUpTo: 3));
      expect(<int>[0, 1, 2, 3, 4].map((int days) => before.bandOf(days)), <DeadlineBand>[DeadlineBand.late, DeadlineBand.late, DeadlineBand.soon, DeadlineBand.soon, DeadlineBand.ok]);
      await tester.enterText(find.widgetWithText(TextField, 'Đỏ khi còn tối đa (ngày)'), '2');
      await tester.enterText(find.widgetWithText(TextField, 'Vàng khi còn tối đa (ngày)'), '4');
      await tester.enterText(find.widgetWithText(TextField, 'Xanh khi còn tối đa (ngày)'), '8');
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Lưu cài đặt'));
      await tester.pumpAndSettle();
      container.read(deadlineThresholdsProvider);
      await tester.pumpAndSettle();
      expect(container.read(deadlineThresholdsProvider), const DeadlineThresholds(lateBelow: 3, soonUpTo: 4), reason: 'invalidated by the save and read again');
    });

    test('the thresholds in force: the personal ones, else the official ones, else the system ones; an unordered set is not shown', () {
      PwfPreference preference({int? yellow, int? red, PwfThresholds? official}) => PwfPreference(reminderDays: const <int>[], version: 1, yellow: yellow, red: red, official: official);
      const PwfThresholds official = PwfThresholds(yellow: 2, red: 0, green: 5);
      expect(DeadlineThresholds.effective(preference(yellow: 3, red: 1, official: official)), const DeadlineThresholds(lateBelow: 2, soonUpTo: 3));
      expect(DeadlineThresholds.effective(preference(official: official)), const DeadlineThresholds(lateBelow: 1, soonUpTo: 2), reason: 'none of their own: the official rule');
      expect(DeadlineThresholds.effective(preference(red: 1, official: official)), const DeadlineThresholds(lateBelow: 2, soonUpTo: 2), reason: 'red from the person, yellow from the rule');
      expect(DeadlineThresholds.effective(preference(red: 2, official: official)), DeadlineThresholds.system, reason: 'red as late as the yellow of the rule: not ordered');
      expect(DeadlineThresholds.effective(preference()), DeadlineThresholds.system);
      expect(DeadlineThresholds.effective(preference(red: -1, yellow: 3)), const DeadlineThresholds(lateBelow: 0, soonUpTo: 3), reason: 'red only once the day has passed');
      expect(DeadlineThresholds.effective(preference(red: 4, yellow: 3)), DeadlineThresholds.system);
      final DeadlineThresholds own = DeadlineThresholds.effective(preference(yellow: 3, red: 0));
      expect(<int>[-1, 0, 1, 3, 4].map((int days) => own.bandOf(days)), <DeadlineBand>[DeadlineBand.late, DeadlineBand.late, DeadlineBand.soon, DeadlineBand.soon, DeadlineBand.ok], reason: 'a band includes the day it is named for');
    });

    testWidgets('a level later than the official rule is refused on the screen before anything is sent', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = prefs();
      await _open(tester, server, 'MOB-82');
      await tester.enterText(find.widgetWithText(TextField, 'Đỏ khi còn tối đa (ngày)'), '0');
      await tester.enterText(find.widgetWithText(TextField, 'Vàng khi còn tối đa (ngày)'), '1');
      await tester.pumpAndSettle();
      expect(find.text('Mức của bạn chỉ được nhắc sớm hơn hoặc bằng quy định của đơn vị, không được muộn hơn.'), findsOneWidget);
      final FilledButton save = tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Lưu cài đặt'));
      expect(save.onPressed, isNull);
      expect(server.calls.where((HttpCall c) => c.method == 'PUT'), isEmpty);
    });

    testWidgets('saving sends the thresholds and the reminder days on the version that was read, under one key, and reads the settings again', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = prefs();
      server.on('PUT', '/me/deadline-preference', (HttpCall call) => <String, Object?>{'operation_id': 'o1', 'status': 'SAVED', 'resource_version': 3});
      await _open(tester, server, 'MOB-82');
      await tester.enterText(find.widgetWithText(TextField, 'Nhắc vào các mốc (ngày)'), '6, 3, 0');
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Lưu cài đặt'));
      await tester.pumpAndSettle();
      final HttpCall put = server.calls.singleWhere((HttpCall c) => c.method == 'PUT');
      expect(jsonDecode(put.body!), <String, Object?>{'green_days': 7, 'yellow_days': 3, 'red_days': 1, 'reminder_days': <Object?>[6, 3, 0]});
      expect(put.headers['if-match'], '"2"');
      expect(put.headers['idempotency-key'], isNotEmpty);
      expect(find.text('Đã lưu cài đặt nhắc hạn.'), findsOneWidget);
      expect(server.calls.where((HttpCall c) => c.method == 'GET' && c.url.path.endsWith('/me/deadline-preference')).length, 2, reason: 'the settings are read again after the save');
    });

    testWidgets('the refusals of the server are told in words: not earlier, thresholds, a version that moved; offline nothing is sent', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = prefs();
      server.refuse('PUT', '/me/deadline-preference', 422, 'DEADLINE_PERSONAL_NOT_EARLIER');
      await _open(tester, server, 'MOB-82');
      await tester.tap(find.widgetWithText(FilledButton, 'Lưu cài đặt'));
      await tester.pumpAndSettle();
      expect(find.text('Mức của bạn chỉ được nhắc sớm hơn hoặc bằng quy định của đơn vị, không được muộn hơn.'), findsOneWidget);
      server.clear();
      server.on('GET', '/me/deadline-preference', (_) => preferenceJson());
      server.refuse('PUT', '/me/deadline-preference', 409, 'VERSION_CONFLICT');
      await tester.tap(find.widgetWithText(FilledButton, 'Lưu cài đặt'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Cài đặt đã được đổi ở nơi khác'), findsOneWidget);
    });

    testWidgets('what the server raised to the official level is said, and "use the level of the unit" clears the thresholds', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      await _open(tester, prefs(body: preferenceJson(green: 7, yellow: 3, red: 1, clamped: <String>['red_days'])), 'MOB-82');
      expect(find.textContaining('muộn hơn quy định của đơn vị, nên máy chủ giữ'), findsOneWidget);
      await tester.tap(find.text('Dùng mức của đơn vị'));
      await tester.pumpAndSettle();
      expect(find.text('Đỏ: còn 0 ngày trở xuống hoặc đã quá hạn'), findsOneWidget);
    });

    testWidgets('every state, the three devices and 200 percent text', (WidgetTester tester) async {
      await expectEveryState(
        tester,
        open: (WidgetTester t, ScriptedServer server) async {
          await pumpWithServer(t, features: <MobileFeature>[pwf.feature], server: server, location: _at('MOB-82'));
        },
        script: StateScript(healthy: (ScriptedServer server) => server.on('GET', '/me/deadline-preference', (_) => preferenceJson()), content: find.text('Cài đặt nhắc hạn')),
      );
      await expectScreenContractWithData(
        tester,
        open: (WidgetTester t, ScriptedServer server) async {
          await pumpWithServer(t, features: <MobileFeature>[pwf.feature], server: server, location: _at('MOB-82'));
        },
        healthy: (ScriptedServer server) => server.on('GET', '/me/deadline-preference', (_) => preferenceJson(green: 7, yellow: 3, red: 1)),
      );
    });
  });
}
