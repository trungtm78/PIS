import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/di/providers.dart' show routerProvider;
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/navigation/mobile_routes.generated.dart';
import 'package:machvon_mobile/core/navigation/route_table.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/features/project_workflow/project_workflow_feature.dart' as pwf;
import 'package:machvon_mobile/features/project_workflow/pwf_step_row.dart';

import '../../support/harness.dart';
import '../../support/offline_support.dart';
import '../field_issues/field_world.dart' show settleReal;
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'pwf_contract.dart';
import 'pwf_fixtures.dart';
import 'pwf_step_fixtures.dart';

/// PWF-5 on the phone: the step list of MOB-78 with its sheet of actions (take a task, hand in, complete, ask for more time), the sentence of where the colour
/// comes from, the claim on MOB-79 and the unclaimed chip of MOB-80. The colour is the server's; the phone only says it.

const String _taskA = '7f3a0000-0000-4000-8000-000000000011';
const String _taskB = '7f3a0000-0000-4000-8000-000000000012';
const String _nameA = 'Lập hồ sơ mời thầu gói thầu xây lắp';
const String _nameB = 'Thẩm định kế hoạch lựa chọn nhà thầu';

String _at(String screenId, [String suffix = '']) => RouteTable(routes: kMobileRoutes, features: <MobileFeature>[pwf.feature]).locationOf(screenId) + suffix;

/// A workflow with two steps of the open phase: A is held by someone and may be extended once more; B is a step nobody holds and carries the deadline of the whole file.
Map<String, Object?> _workflow({bool propose = true, Map<String, Object?>? extensionA, bool withB = true}) => <String, Object?>{
      ...workflowJson(tasks: <Map<String, Object?>>[
        <String, Object?>{...taskRow(_taskA, _nameA, official: band('RED', days: -2), finish: '2026-11-10'), ...stepFields(extension: extensionA, unit: 'Phòng Kế hoạch')},
        if (withB) <String, Object?>{...taskRow(_taskB, _nameB, official: band('YELLOW', days: 2), finish: '2026-11-14', assignee: null), ...stepFields(tier: 'POLICY', unclaimed: true, overall: true, unit: 'Sở Xây dựng', withExtension: false)},
      ]),
      if (withB) 'overall_deadline': overallJson(),
      'can_propose_reschedule': propose,
    };

Map<String, Object?> _detailOf(String id, {bool claim = false, bool mine = true, String status = 'IN_PROGRESS', List<Map<String, Object?>>? blockers, Map<String, Object?>? fields}) => <String, Object?>{
      ...taskDetailJson(TaskState(status: status, assignee: mine), blockers: blockers),
      'id': id,
      'can_claim': claim,
      ...?fields,
    };

/// The fake server of a project: the workflow, the tasks, the schedule and the two commands, each recorded.
class _World {
  _World({Map<String, Object?>? workflow, this.blockers, this.claimStatus = 200, this.claimCode, this.extensionStatus = 200, this.extensionBody}) : workflow = workflow ?? _workflow() {
    server = ScriptedServer()
      ..on('GET', '/projects/:id/workflow', (_) => this.workflow)
      ..on('GET', '/projects/:id/workflow/schedule', (_) => <String, Object?>{
            'tasks': <Object?>[
              <String, Object?>{'task_code': 'T-12', 'driving_predecessor': null, 'finish_variance_days': 3},
              <String, Object?>{'task_code': 'T-11', 'driving_predecessor': null, 'finish_variance_days': 0},
            ],
          })
      ..on(
        'GET',
        '/project-tasks/:id',
        (HttpCall call) => call.url.pathSegments.last == _taskB
            ? _detailOf(_taskB, claim: true, mine: false, status: 'NOT_STARTED', fields: stepFields(tier: 'POLICY', unclaimed: true, overall: true, unit: 'Sở Xây dựng', withExtension: false))
            : _detailOf(_taskA, blockers: blockers, fields: stepFields()),
      )
      ..answer('POST', '/project-tasks/:id/claim', (HttpCall call) {
        claims.add(call);
        if (claimCode != null) return _problem(claimStatus, claimCode!, <String, Object?>{'reason': 'NOT_MEMBER'});
        return FakeTransport.json(200, <String, Object?>{'status': 'CLAIMED', 'resource_id': 'asg-1'});
      })
      ..answer('POST', '/projects/:id/workflow/reschedules', (HttpCall call) {
        extensions.add(call);
        if (extensionBody != null) return FakeTransport.json(extensionStatus, extensionBody!);
        return FakeTransport.json(200, <String, Object?>{'status': 'PROPOSED', 'resource_id': 'prop-1', 'resource_version': 1});
      });
  }

  Map<String, Object?> workflow;
  final List<Map<String, Object?>>? blockers;
  final int claimStatus;
  final String? claimCode;
  final int extensionStatus;
  final Map<String, Object?>? extensionBody;
  late final ScriptedServer server;
  final List<HttpCall> claims = <HttpCall>[];
  final List<HttpCall> extensions = <HttpCall>[];

  int get workflowReads => server.callsTo('GET', '/projects/$kProjectId/workflow').length;
}

HttpResult _problem(int status, String code, [Map<String, Object?> more = const <String, Object?>{}]) =>
    HttpResult(status: status, headers: <String, String>{'content-type': 'application/problem+json'}, body: jsonEncode(<String, Object?>{'type': 'about:blank', 'title': code, 'status': status, 'code': code, ...more}));

List<Override> get _storage => <Override>[offlineStorageProvider.overrideWithValue(TestStorage.create().storage)];

Future<void> _open78(WidgetTester tester, _World world, {Size size = kTallDevice, double scale = 1.0}) async {
  useDevice(tester, size, textScale: scale);
  await pumpWithServer(tester, features: <MobileFeature>[pwf.feature], server: world.server, location: _at('MOB-78', '/$kProjectId'), overrides: _storage);
  await tester.pumpAndSettle();
}

Future<void> _openSheet(WidgetTester tester, String name) async {
  await tester.ensureVisible(find.text(name));
  await tester.pumpAndSettle();
  await tester.tap(find.text(name));
  await tester.pumpAndSettle();
}

Finder _filled(String label) => find.widgetWithText(FilledButton, label);
Finder _outlined(String label) => find.widgetWithText(OutlinedButton, label);

Future<void> _letGo(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump(Duration.zero);
}

void main() {
  group('MOB-78 the step row', () {
    testWidgets('the unit and the holder, or "Chưa có người nhận", the star of the whole file, the state as words and what blocks it', (WidgetTester tester) async {
      await _open78(tester, _World());
      expect(find.text('Đơn vị: Phòng Kế hoạch · Người làm: Trần Văn B'), findsOneWidget);
      // The step nobody holds says so in a chip and in the facts, and names the unit that receives it.
      expect(find.text('Đơn vị: Sở Xây dựng'), findsOneWidget);
      expect(find.text('Chưa có người nhận'), findsOneWidget);
      expect(find.byIcon(Icons.star), findsNWidgets(2), reason: 'the star of the head and of the row that carries the deadline');
      expect(find.text('Đang làm'), findsNWidgets(2));
      expect(find.text('Chưa bắt đầu'), findsNothing);
      await _letGo(tester);
    });

    testWidgets('the head says the deadline of the whole file with its colour in words and how far it stands behind its baseline (the schedule is read beside the workflow)', (WidgetTester tester) async {
      await _open78(tester, _World());
      expect(find.text('Hạn chung của hồ sơ: 14/11/2026'), findsOneWidget);
      expect(find.text('Việc mang hạn chung: Thẩm định kế hoạch lựa chọn nhà thầu'), findsOneWidget);
      expect(find.text('Còn 2 ngày làm việc'), findsNWidgets(2), reason: 'the head and the row of the task that carries it');
      expect(find.text('Trễ 3 ngày làm việc so với kế hoạch gốc'), findsOneWidget);
      await _letGo(tester);
    });

    testWidgets('a schedule that cannot be read leaves the slip unsaid, never guessed; an answer with no whole-file deadline has no such block', (WidgetTester tester) async {
      final _World world = _World();
      world.server.refuse('GET', '/projects/:id/workflow/schedule', 403, 'SCOPE_DENIED');
      await _open78(tester, world);
      expect(find.text('Hạn chung của hồ sơ: 14/11/2026'), findsOneWidget);
      expect(find.textContaining('so với kế hoạch gốc'), findsNothing);
      await _open78(tester, _World(workflow: _workflow(withB: false)));
      expect(find.textContaining('Hạn chung của hồ sơ'), findsNothing);
      await _letGo(tester);
    });

    testWidgets('the "i" says where the colour comes from: the tier of the step, and the thresholds in the unit the colour counts in', (WidgetTester tester) async {
      await _open78(tester, _World());
      // The "i" of the row of the step (the first is the one of the head, for the deadline of the whole file, which follows the policy).
      await tester.tap(find.byType(PwfTierButton).at(1));
      await tester.pumpAndSettle();
      expect(find.text('Màu này tính thế nào'), findsOneWidget);
      expect(find.text('Theo ngưỡng của bước'), findsOneWidget);
      expect(find.text('Đỏ khi còn 0 ngày làm việc hoặc ít hơn, vàng khi còn 2 ngày làm việc hoặc ít hơn, xanh khi còn 5 ngày làm việc hoặc ít hơn.'), findsOneWidget);
      await tester.tap(find.text('Đóng'));
      await tester.pumpAndSettle();
      // The head and the step that follow the policy say so.
      await tester.tap(find.byType(PwfTierButton).first);
      await tester.pumpAndSettle();
      expect(find.text('Theo ngưỡng của chính sách'), findsOneWidget);
      await tester.tap(find.text('Đóng'));
      await tester.pumpAndSettle();
      await _letGo(tester);
    });

    testWidgets('an answer from before the tiers says the colour is the official one and invents no tier', (WidgetTester tester) async {
      await _open78(tester, _World(workflow: workflowJson()));
      await tester.tap(find.byType(PwfTierButton).first);
      await tester.pumpAndSettle();
      expect(find.text('Màu chính thức do máy chủ tính, mọi màn hình đều hiện cùng một màu.'), findsOneWidget);
      expect(find.textContaining('Theo ngưỡng'), findsNothing);
      await tester.tap(find.text('Đóng'));
      await tester.pumpAndSettle();
      await _letGo(tester);
    });

    testWidgets('the colour is never the only signal: the "i" and the row say it in words to a screen reader', (WidgetTester tester) async {
      final SemanticsHandle semantics = tester.ensureSemantics();
      await _open78(tester, _World());
      expect(find.bySemanticsLabel('Màu Đỏ. Xem cách tính màu'), findsOneWidget);
      expect(find.bySemanticsLabel('Màu Vàng. Xem cách tính màu'), findsNWidgets(2), reason: 'the head and the row');
      expect(find.bySemanticsLabel(RegExp(r'Màu Đỏ, Trễ 2 ngày làm việc.*Mở các thao tác của bước')), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp(r'Hạn chung của hồ sơ, Đơn vị: Sở Xây dựng, Chưa có người nhận')), findsOneWidget);
      semantics.dispose();
      await _letGo(tester);
    });

    testWidgets('360 dp wide at 130 percent text: the row, the sheet and the sentence of the tier do not overflow', (WidgetTester tester) async {
      await _open78(tester, _World(), size: const Size(360, 740), scale: 1.3);
      expect(tester.takeException(), isNull);
      expect(find.byType(PwfStepRow), findsNWidgets(2));
      // The "i" of the head (at the top of the page, in view).
      await tester.tap(find.byType(PwfTierButton).first);
      await tester.pumpAndSettle();
      expect(find.text('Màu này tính thế nào'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.ensureVisible(find.text('Đóng'));
      await tester.tap(find.text('Đóng'));
      await tester.pumpAndSettle();
      await _openSheet(tester, _nameB);
      expect(tester.takeException(), isNull);
      expect(find.text('Mở chi tiết việc'), findsOneWidget);
      await tester.ensureVisible(find.text('Mở chi tiết việc'));
      await tester.tap(find.text('Mở chi tiết việc'));
      await tester.pumpAndSettle();
      await _letGo(tester);
    });

    testWidgets('360 dp wide at 130 percent text: the sheet of a held step with its extension and the form of the request', (WidgetTester tester) async {
      await _open78(tester, _World(), size: const Size(360, 740), scale: 1.3);
      await _openSheet(tester, _nameA);
      expect(tester.takeException(), isNull);
      await tester.ensureVisible(_outlined('Xin gia hạn'));
      await tester.tap(_outlined('Xin gia hạn'));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(find.text('Gửi đề nghị gia hạn'), findsOneWidget);
      await tester.ensureVisible(find.text('Thôi'));
      await tester.tap(find.text('Thôi'));
      await tester.pumpAndSettle();
      await _letGo(tester);
    });

    testWidgets('the three devices and 200 percent text, with the step list on the screen', (WidgetTester tester) async {
      await expectScreenContractWithData(
        tester,
        open: (WidgetTester t, ScriptedServer scripted) => pumpWithServer(t, features: <MobileFeature>[pwf.feature], server: scripted, location: _at('MOB-78', '/$kProjectId'), overrides: _storage),
        healthy: (ScriptedServer scripted) => scripted.on('GET', '/projects/:id/workflow', (_) => _workflow()),
      );
      await _letGo(tester);
    });
  });

  group('MOB-78 the sheet of a step: take it', () {
    testWidgets('"Nhận việc" is offered when the server says the person may, is one command with its own key, and the workflow is read again', (WidgetTester tester) async {
      final _World world = _World();
      await _open78(tester, world);
      expect(world.workflowReads, 1);
      await _openSheet(tester, _nameB);
      expect(find.textContaining('Sở Xây dựng'), findsWidgets);
      expect(_filled('Nhận việc'), findsOneWidget);
      expect(_filled('Hoàn thành'), findsNothing);
      await tester.tap(_filled('Nhận việc'));
      await tester.pumpAndSettle();
      expect(world.claims, hasLength(1));
      expect(world.claims.single.url.path, endsWith('/project-tasks/$_taskB/claim'));
      expect(world.claims.single.headers['idempotency-key'], isNotEmpty);
      expect(world.claims.single.headers.containsKey('if-match'), isFalse, reason: 'a claim does not change the version of the task');
      expect(find.text('Đã nhận việc. Bạn là người làm của bước này.'), findsOneWidget);
      expect(world.workflowReads, 2);
      await _letGo(tester);
    });

    testWidgets('the person who is not of the unit or does not hold the role is told which, with the code; a task somebody just took says so and reads again', (WidgetTester tester) async {
      final _World notMember = _World(claimStatus: 403, claimCode: 'PWF_CLAIM_NOT_ELIGIBLE');
      await _open78(tester, notMember);
      await _openSheet(tester, _nameB);
      await tester.tap(_filled('Nhận việc'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Bạn không thuộc đơn vị nhận bước này nên chưa nhận được.'), findsOneWidget);
      expect(find.textContaining('PWF_CLAIM_NOT_ELIGIBLE'), findsOneWidget);
      expect(notMember.workflowReads, 1, reason: 'nothing changed: no need to read again');
      final _World taken = _World(claimStatus: 409, claimCode: 'PWF_TASK_ALREADY_CLAIMED');
      await _open78(tester, taken);
      await _openSheet(tester, _nameB);
      await tester.tap(_filled('Nhận việc'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Bước này vừa có người khác nhận.'), findsOneWidget);
      expect(taken.workflowReads, 2, reason: 'somebody else acted: the screen reads again');
      await _letGo(tester);
    });

    testWidgets('a step the person may not take has no such button, and a step held by someone offers the work, not the claim', (WidgetTester tester) async {
      await _open78(tester, _World());
      await _openSheet(tester, _nameA);
      expect(_filled('Nhận việc'), findsNothing);
      expect(_filled('Hoàn thành'), findsOneWidget);
      await _letGo(tester);
    });

    testWidgets('when what the person may do cannot be read the sheet says so, offers only the task, and sends nothing', (WidgetTester tester) async {
      final _World world = _World();
      await _open78(tester, world);
      world.server.refuse('GET', '/project-tasks/:id', 403, 'SCOPE_DENIED');
      await _openSheet(tester, _nameB);
      await settleReal(tester, rounds: 8);
      expect(find.textContaining('Chưa kiểm tra được việc bạn được làm'), findsOneWidget);
      expect(_filled('Nhận việc'), findsNothing);
      expect(find.text('Mở chi tiết việc'), findsOneWidget);
      expect(world.claims, isEmpty);
      await tester.tap(find.text('Mở chi tiết việc'));
      await tester.pumpAndSettle();
      await _letGo(tester);
    });

    testWidgets('a workflow read from the copy on the device never offers to take a task or to ask for more time', (WidgetTester tester) async {
      final _World world = _World();
      await _open78(tester, world);
      final ProviderContainer container = ProviderScope.containerOf(tester.element(find.byType(PwfStepRow).first));
      container.read(routerProvider).go(_at('MOB-09'));
      await tester.pumpAndSettle();
      world.server.offline = true;
      container.read(routerProvider).go(_at('MOB-78', '/$kProjectId'));
      await tester.pumpAndSettle();
      expect(find.textContaining('dữ liệu đã lưu trên máy'), findsWidgets);
      await _openSheet(tester, _nameA);
      expect(_outlined('Xin gia hạn'), findsNothing, reason: 'the detail could not be read: no actions');
      expect(world.extensions, isEmpty);
      await tester.tap(find.text('Mở chi tiết việc'));
      await tester.pumpAndSettle();
      await _letGo(tester);
    });
  });

  group('MOB-78 the sheet of a step: hand in, complete, ask for more time', () {
    testWidgets('a step whose completion is blocked offers "Nộp hồ sơ" (it opens the task) and no completion', (WidgetTester tester) async {
      final _World world = _World(blockers: <Map<String, Object?>>[<String, Object?>{'code': 'CHECKLIST_ITEM_OPEN', 'subject': 'C1'}]);
      world.server.on('GET', '/project-tasks/:id', (_) => _detailOf(_taskA, blockers: world.blockers, fields: stepFields()));
      await _open78(tester, world);
      await _openSheet(tester, _nameA);
      expect(_filled('Nộp hồ sơ'), findsOneWidget);
      expect(find.text('Còn 1 yêu cầu trước khi hoàn thành: mở chi tiết để nộp.'), findsOneWidget);
      expect(_filled('Hoàn thành'), findsNothing);
      await tester.tap(_filled('Nộp hồ sơ'));
      await tester.pumpAndSettle();
      expect(currentLocation(ProviderScope.containerOf(tester.element(find.byType(Scaffold).first))), contains('/mob-79/$_taskA'));
      await _letGo(tester);
    });

    testWidgets('"Xin gia hạn" shows what is used of the limit, asks for the amount and a reason, and sends one request on the version of the workflow', (WidgetTester tester) async {
      final _World world = _World();
      await _open78(tester, world);
      await _openSheet(tester, _nameA);
      expect(find.text('Đã gia hạn 1/2 lần · đã thêm 2/5 ngày làm việc'), findsWidgets);
      await tester.ensureVisible(_outlined('Xin gia hạn'));
      await tester.tap(_outlined('Xin gia hạn'));
      await tester.pumpAndSettle();
      expect(find.text('Còn được xin thêm tối đa 3 ngày làm việc.'), findsOneWidget);
      // Nothing is sent while the amount is beyond the limit or the reason is short.
      await tester.enterText(find.byType(TextField).at(0), '9');
      await tester.enterText(find.byType(TextField).at(1), 'Chờ ý kiến');
      await tester.tap(find.text('Gửi đề nghị gia hạn'));
      await tester.pumpAndSettle();
      expect(find.text('Nhập số nguyên từ 1 đến 3.'), findsOneWidget);
      expect(find.text('Cần ít nhất 20 ký tự.'), findsOneWidget);
      expect(world.extensions, isEmpty);
      await tester.enterText(find.byType(TextField).at(0), '2');
      await tester.enterText(find.byType(TextField).at(1), 'Chờ ý kiến thẩm định của Sở Kế hoạch và Đầu tư');
      await tester.tap(find.text('Gửi đề nghị gia hạn'));
      await tester.pumpAndSettle();
      expect(world.extensions, hasLength(1));
      final HttpCall call = world.extensions.single;
      expect(call.url.path, endsWith('/projects/$kProjectId/workflow/reschedules'));
      expect(call.headers['if-match'], '"4"', reason: 'the version of the workflow that was on the screen');
      expect(call.headers['idempotency-key'], isNotEmpty);
      final Map<String, Object?> body = jsonDecode(call.body!) as Map<String, Object?>;
      expect(body['extensions'], <Object?>[<String, Object?>{'task_code': 'T-11', 'add_value': 2}]);
      expect(body['reason'], 'Chờ ý kiến thẩm định của Sở Kế hoạch và Đầu tư');
      expect(find.textContaining('Đã gửi đề nghị gia hạn.'), findsOneWidget);
      await _letGo(tester);
    });

    testWidgets('a step whose limit is reached says so instead of offering it; one the template does not allow, or a person who may not propose, is offered nothing', (WidgetTester tester) async {
      const Map<String, Object?> full = <String, Object?>{'allowed': true, 'max_times': 2, 'max_value': 5, 'unit': 'WORKING_DAY', 'times_used': 2, 'value_used': 4};
      await _open78(tester, _World(workflow: _workflow(extensionA: full)));
      await _openSheet(tester, _nameA);
      expect(_outlined('Xin gia hạn'), findsNothing);
      expect(find.textContaining('Đã hết số lần hoặc số ngày làm việc được gia hạn của bước này.'), findsOneWidget);
      await tester.tap(find.text('Mở chi tiết việc'));
      await tester.pumpAndSettle();
      const Map<String, Object?> none = <String, Object?>{'allowed': false, 'unit': 'WORKING_DAY', 'times_used': 0, 'value_used': 0};
      await _open78(tester, _World(workflow: _workflow(extensionA: none)));
      await _openSheet(tester, _nameA);
      expect(_outlined('Xin gia hạn'), findsNothing);
      await tester.tap(find.text('Mở chi tiết việc'));
      await tester.pumpAndSettle();
      await _open78(tester, _World(workflow: _workflow(propose: false)));
      await _openSheet(tester, _nameA);
      expect(_outlined('Xin gia hạn'), findsNothing);
      await tester.tap(find.text('Mở chi tiết việc'));
      await tester.pumpAndSettle();
      await _letGo(tester);
    });

    testWidgets('the refusals of the extension are said in words: the limit that was hit, the step that is closed, the schedule that moved', (WidgetTester tester) async {
      final Map<String, Map<String, Object?>> cases = <String, Map<String, Object?>>{
        'PWF_EXTENSION_LIMIT_EXCEEDED': <String, Object?>{'type': 'about:blank', 'title': 'x', 'status': 422, 'code': 'PWF_EXTENSION_LIMIT_EXCEEDED', 'limit': 'VALUE', 'task_code': 'T-11'},
        'PWF_EXTENSION_TASK_CLOSED': <String, Object?>{'type': 'about:blank', 'title': 'x', 'status': 422, 'code': 'PWF_EXTENSION_TASK_CLOSED'},
        'PWF_SCHEDULE_VERSION_CONFLICT': <String, Object?>{'type': 'about:blank', 'title': 'x', 'status': 409, 'code': 'PWF_SCHEDULE_VERSION_CONFLICT'},
      };
      final Map<String, String> words = <String, String>{
        'PWF_EXTENSION_LIMIT_EXCEEDED': 'Số ngày làm việc xin thêm vượt mức còn được gia hạn của bước này.',
        'PWF_EXTENSION_TASK_CLOSED': 'Bước đã xong hoặc đã hủy nên không gia hạn được.',
        'PWF_SCHEDULE_VERSION_CONFLICT': 'Lịch của dự án vừa đổi.',
      };
      for (final MapEntry<String, Map<String, Object?>> refused in cases.entries) {
        final _World world = _World(extensionStatus: refused.value['status']! as int, extensionBody: refused.value);
        await _open78(tester, world);
        await _openSheet(tester, _nameA);
        await tester.ensureVisible(_outlined('Xin gia hạn'));
        await tester.tap(_outlined('Xin gia hạn'));
        await tester.pumpAndSettle();
        await tester.enterText(find.byType(TextField).at(0), '2');
        await tester.enterText(find.byType(TextField).at(1), 'Chờ ý kiến thẩm định của Sở Kế hoạch và Đầu tư');
        await tester.tap(find.text('Gửi đề nghị gia hạn'));
        await tester.pumpAndSettle();
        expect(find.textContaining(words[refused.key]!), findsOneWidget, reason: refused.key);
        expect(find.textContaining(refused.key), findsOneWidget, reason: 'the code stays beside the words');
        expect(world.workflowReads, refused.key == 'PWF_SCHEDULE_VERSION_CONFLICT' ? 2 : 1, reason: 'only a schedule that moved reads the workflow again');
      }
      await _letGo(tester);
    });

    testWidgets('"Hoàn thành" asks for the note, queues the completion on the device (as on MOB-79) and says so', (WidgetTester tester) async {
      final _World world = _World();
      await _open78(tester, world);
      await _openSheet(tester, _nameA);
      await tester.tap(_filled('Hoàn thành'));
      await tester.pumpAndSettle();
      expect(find.text('Hoàn thành việc'), findsWidgets);
      await tester.tap(_filled('Hoàn thành việc'));
      await tester.pumpAndSettle();
      expect(find.text('Đã ghi nhận việc hoàn thành; sẽ gửi khi có mạng.'), findsOneWidget);
      await _letGo(tester);
    });
  });

  group('MOB-79 a task nobody holds', () {
    Future<void> open79(WidgetTester tester, _World world, {double scale = 1.0}) async {
      useDevice(tester, kTallDevice, textScale: scale);
      await pumpWithServer(tester, features: <MobileFeature>[pwf.feature], server: world.server, location: _at('MOB-79', '/$_taskB'), overrides: _storage);
      await tester.pumpAndSettle();
    }

    testWidgets('the head says nobody holds it, which unit receives it and that it carries the deadline of the whole file; the bar offers "Nhận việc"', (WidgetTester tester) async {
      await open79(tester, _World());
      expect(find.text('Chưa có người nhận'), findsOneWidget);
      expect(find.text('Đơn vị nhận: Sở Xây dựng.'), findsOneWidget);
      expect(find.text('Việc này mang hạn chung của hồ sơ.'), findsOneWidget);
      expect(_filled('Nhận việc'), findsOneWidget);
      await tester.tap(_filled('Nhận việc'));
      await tester.pumpAndSettle();
      expect(find.text('Đã nhận việc. Bạn là người làm của bước này.'), findsOneWidget);
      await _letGo(tester);
    });

    testWidgets('a refusal of the claim is said in words with its code', (WidgetTester tester) async {
      await open79(tester, _World(claimStatus: 403, claimCode: 'PWF_CLAIM_NOT_ELIGIBLE'));
      await tester.tap(_filled('Nhận việc'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Bạn không thuộc đơn vị nhận bước này nên chưa nhận được.'), findsOneWidget);
      expect(find.textContaining('PWF_CLAIM_NOT_ELIGIBLE'), findsOneWidget);
      await _letGo(tester);
    });

    testWidgets('the time limit with its unit, where the colour comes from and the extension state are in the fold "Thời hạn", shut until asked for', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      await pumpWithServer(tester, features: <MobileFeature>[pwf.feature], server: _World().server, location: _at('MOB-79', '/$_taskA'), overrides: _storage);
      await tester.pumpAndSettle();
      expect(find.text('10 ngày làm việc'), findsNothing);
      await tester.scrollUntilVisible(find.text('Thời hạn'), 200, scrollable: find.byType(Scrollable).first);
      await tester.tap(find.text('Thời hạn'));
      await tester.pump();
      await tester.scrollUntilVisible(find.text('Đã gia hạn 1/2 lần · đã thêm 2/5 ngày làm việc'), 200, scrollable: find.byType(Scrollable).first);
      expect(find.text('10 ngày làm việc'), findsOneWidget);
      expect(find.textContaining('Theo ngưỡng của bước'), findsOneWidget);
      await _letGo(tester);
    });

    testWidgets('360 dp wide at 130 percent text: the head, the folds and the bar do not overflow', (WidgetTester tester) async {
      useDevice(tester, const Size(360, 740), textScale: 1.3);
      await pumpWithServer(tester, features: <MobileFeature>[pwf.feature], server: _World().server, location: _at('MOB-79', '/$_taskB'), overrides: _storage);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await tester.scrollUntilVisible(find.text('Thời hạn'), 200, scrollable: find.byType(Scrollable).first);
      await tester.tap(find.text('Thời hạn'));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await _letGo(tester);
    });
  });

  group('MOB-80 my tasks', () {
    testWidgets('a task nobody holds says so with the way to take it, the unit, and (in the official colours) where the colour comes from', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer()
        ..on('GET', '/me/project-tasks', (call) => call.url.queryParameters['status'] == 'DONE'
            ? doneTasksJson()
            : myTasksJson(items: <Map<String, Object?>>[
                <String, Object?>{...myTask(_taskB, 'Thẩm định kế hoạch lựa chọn nhà thầu', official: band('YELLOW', days: 2), personal: band('YELLOW', days: 2)), ...stepFields(tier: 'POLICY', unclaimed: true, unit: 'Sở Xây dựng', withExtension: false)},
              ]));
      await pumpWithServer(tester, features: <MobileFeature>[pwf.feature], server: server, location: _at('MOB-80'), overrides: _storage);
      await tester.pumpAndSettle();
      expect(find.text('Chưa có người nhận'), findsOneWidget);
      expect(find.text('Mở để nhận việc'), findsOneWidget);
      expect(find.textContaining('Đơn vị: Sở Xây dựng'), findsOneWidget);
      expect(find.text('Theo ngưỡng của chính sách'), findsNothing, reason: 'the colour of the person\'s own settings is said to be theirs, not explained as the official one');
      await tester.tap(find.text('Màu chính thức'));
      await tester.pumpAndSettle();
      expect(find.text('Theo ngưỡng của chính sách'), findsOneWidget);
      await _letGo(tester);
    });
  });
}
