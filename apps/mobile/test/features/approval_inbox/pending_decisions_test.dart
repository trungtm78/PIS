import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/navigation/route_catalogue.dart';
import 'package:machvon_mobile/core/navigation/tab_badges.dart';
import 'package:machvon_mobile/features/approval_inbox/approval_commands.dart';
import 'package:machvon_mobile/features/approval_inbox/approval_inbox_feature.dart' as approval;
import 'package:machvon_mobile/features/approval_inbox/pending_decisions.dart';

import '../../support/harness.dart';
import '../support/screen_contract.dart' show kTallDevice;
import '../support/scripted_server.dart';
import 'approval_fixtures.dart';

const String _task = 'task-7';

Future<ProviderContainer> _open(WidgetTester tester, ScriptedServer server) => pumpWithServer(tester, features: <MobileFeature>[approval.feature], server: server, location: '/approval');

/// The inbox with one task of the engine and the pending records given.
void _reads(ScriptedServer server, {List<Object?>? pending, List<String> unavailable = const <String>[]}) {
  server
    ..on('GET', '/resources/approval_task', (_) => page(<Object?>[approvalTask('t-1')]))
    ..on('GET', '/resources/organization_unit', (_) => unitsPage())
    ..on('GET', '/me/pending-decisions', (_) => pendingPage(pending ?? <Object?>[pendingCompletion(_task)], unavailable: unavailable));
}

HttpResult _decided(String status) => HttpResult(
      status: 200,
      headers: <String, String>{'content-type': 'application/json'},
      body: jsonEncode(<String, Object?>{'operation_id': '3f2b6c1e-0000-4000-8000-0000000000b2', 'status': status, 'resource_version': 5, 'resource_id': _task}),
    );

void main() {
  group('PWF 20.9 the unified approval inbox on the phone', () {
    testWidgets('lists the records of PWF beside the tasks of the engine, counts them in the badge and the line of counts', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      final ProviderContainer container = await _open(tester, server);

      expect(find.text('Việc khác chờ bạn quyết định'), findsOneWidget);
      expect(find.text('Duyệt hoàn thành việc'), findsOneWidget);
      expect(find.textContaining('Đường vành đai 1'), findsOneWidget, reason: 'the row says the project');
      expect(find.textContaining('Người trình: Nguyễn Văn An'), findsOneWidget);
      expect(find.text('2 việc chờ quyết định, 0 quá hạn'), findsOneWidget);
      expect(container.read(tabBadgeProvider)[AppTab.approval], 2);
      expect(server.callsTo('GET', '/me/pending-decisions'), hasLength(1));
    });

    testWidgets('the sheet reads the record in full and approving calls the command of PWF under the version of the item, once', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      server.answer('POST', '/project-tasks/$_task/approve-completion', (HttpCall call) => _decided('DONE'));
      await _open(tester, server);

      await tester.tap(find.text('Duyệt hoàn thành việc'));
      await tester.pumpAndSettle();
      expect(find.text('Lập hồ sơ dự toán'), findsOneWidget, reason: 'the task');
      expect(find.text('20/11/2026'), findsOneWidget, reason: 'the day is a day, not a code');
      expect(find.text('Đã đủ chứng từ, đề nghị duyệt hoàn thành.'), findsOneWidget);
      expect(find.text('Nguyễn Văn An'), findsWidgets);

      await tester.tap(find.widgetWithText(FilledButton, 'Duyệt'));
      await tester.pumpAndSettle();

      final List<HttpCall> calls = server.callsTo('POST', '/project-tasks/$_task/approve-completion');
      expect(calls, hasLength(1));
      expect(calls.single.headers['if-match'], '"4"');
      expect(calls.single.headers['idempotency-key'], isNotEmpty);
      expect(jsonDecode(calls.single.body!), <String, Object?>{'decision': 'APPROVE'});
      expect(find.text('Đã ghi nhận quyết định'), findsOneWidget);
    });

    testWidgets('a return asks for its reason first, then goes to returnProjectTask with the words', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      server.answer('POST', '/project-tasks/$_task/return', (HttpCall call) => _decided('IN_PROGRESS'));
      await _open(tester, server);

      await tester.tap(find.text('Duyệt hoàn thành việc'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.widgetWithText(OutlinedButton, 'Trả lại'));
      await tester.tap(find.widgetWithText(OutlinedButton, 'Trả lại'));
      await tester.pumpAndSettle();
      expect(find.text('Hãy ghi lý do.'), findsOneWidget);
      expect(server.callsTo('POST', '/project-tasks/$_task/return'), isEmpty, reason: 'nothing is sent without the reason');

      await tester.enterText(find.byType(TextField), 'Thiếu chữ ký của tư vấn giám sát');
      await tester.tap(find.widgetWithText(OutlinedButton, 'Trả lại'));
      await tester.pumpAndSettle();
      expect(jsonDecode(server.callsTo('POST', '/project-tasks/$_task/return').single.body!), <String, Object?>{'reason': 'Thiếu chữ ký của tư vấn giám sát'});
    });

    testWidgets('the refusal of a maker is said in words and the record stays; a source that failed is named, not shown as nothing waiting', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server, unavailable: <String>['PWF']);
      server.refuse('POST', '/project-tasks/$_task/approve-completion', 403, 'MAKER_IS_APPROVER');
      await _open(tester, server);

      expect(find.byKey(const ValueKey<String>('pending-unavailable')), findsOneWidget);
      await tester.tap(find.text('Duyệt hoàn thành việc'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Duyệt'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Bạn đã tham gia làm việc này nên không thể duyệt'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Duyệt'), findsOneWidget, reason: 'a refusal never removes the form: the record stays to be decided by someone else');
    });

    testWidgets('an inbox of pending records only is not empty, and a failed read of them is named', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      server
        ..on('GET', '/resources/approval_task', (_) => page(<Object?>[]))
        ..on('GET', '/resources/organization_unit', (_) => unitsPage())
        ..refuse('GET', '/me/pending-decisions', 500, 'INTERNAL_ERROR');
      await _open(tester, server);
      expect(find.byKey(const ValueKey<String>('pending-unavailable')), findsOneWidget);
    });
  });

  group('the model of the pending records', () {
    test('reads an item with its summary and the commands it names, and drops what it cannot name', () {
      final PendingDecision? item = parsePendingDecision(pendingCompletion(_task));
      expect(item, isNotNull);
      expect(item!.version, 4);
      expect(item.actions.map((PendingAction one) => one.operationId), <String>['approveProjectTaskCompletion', 'returnProjectTask']);
      expect(item.summary.projectName, 'Đường vành đai 1');
      final Map<String, Object?> other = <String, Object?>{
        ...pendingCompletion(_task),
        'actions': <Object?>[
          <String, Object?>{'decision': 'approve', 'operation_id': 'somethingElse', 'reason_required': false},
        ],
      };
      expect(parsePendingDecision(other)!.actions, isEmpty, reason: 'an operation the phone does not know offers no button');
      expect(parsePendingDecision(<String, Object?>{'id': 'x'}), isNull);
    });

    test('checks the words against the limits of the command', () {
      const PendingAction back = PendingAction(choice: PendingChoice.returnBack, operationId: 'returnProjectTask', reasonRequired: true, reasonMin: 20, reasonMax: 500);
      const PendingAction ok = PendingAction(choice: PendingChoice.approve, operationId: 'approveProjectTaskCompletion', reasonRequired: false, reasonMin: 5, reasonMax: 500);
      expect(checkPendingWords(back, '  '), PendingWords.required);
      expect(checkPendingWords(back, 'ngắn quá'), PendingWords.tooShort);
      expect(checkPendingWords(ok, ''), isNull);
      expect(checkPendingWords(ok, 'x' * 501), PendingWords.tooLong);
    });

    test('maps the refusals of the commands of PWF', () {
      expect(pendingProblemOf('MAKER_IS_APPROVER'), DecisionProblem.maker);
      expect(pendingProblemOf('PWF_SCHEDULE_VERSION_CONFLICT'), DecisionProblem.moved);
      expect(pendingProblemOf('SELF_APPROVAL_DENIED'), DecisionProblem.selfApproval);
    });
  });
}
