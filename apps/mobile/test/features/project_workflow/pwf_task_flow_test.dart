import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/navigation/mobile_routes.generated.dart';
import 'package:machvon_mobile/core/navigation/route_table.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/offline/queue/command_queue.dart';
import 'package:machvon_mobile/core/offline/queue/queue_results.dart';
import 'package:machvon_mobile/core/offline/queue/queued_command.dart';
import 'package:machvon_mobile/core/widgets/sheets.dart';
import 'package:machvon_mobile/features/project_workflow/project_workflow_feature.dart' as pwf;
import 'package:machvon_mobile/features/project_workflow/pwf_commands.dart';
import 'package:machvon_mobile/features/project_workflow/pwf_models.dart';
import 'package:machvon_mobile/features/project_workflow/pwf_task_service.dart';

import '../../support/fake_sync_server.dart';
import '../../support/harness.dart';
import '../field_issues/field_world.dart';
import 'pwf_fixtures.dart';
import 'pwf_world.dart';

String get _location => RouteTable(routes: kMobileRoutes, features: <MobileFeature>[pwf.feature]).locationOf('MOB-79') + '/$kTaskId';

/// One phone on one task, the way a person meets it.
class _Phone {
  _Phone(this.tester, this.server, this.world);

  final WidgetTester tester;
  final PwfTaskServer server;
  final FieldWorld world;

  ProviderContainer get container => world.container;

  Future<CommandQueue> get queue async => (await tester.runAsync(() => container.read(commandQueueProvider.future)))!;

  /// The commands of the task that are still on the phone.
  Future<List<QueuedCommand>> pending() async => pwfCommandsOf((await queue).commands(), kTaskId);

  Future<void> flush() async {
    await tester.runAsync(() async => (await container.read(commandQueueProvider.future)).flush());
    await settleReal(tester, rounds: 12);
  }

  Future<void> goOffline() async {
    server.field.offline = true;
  }

  Future<void> goOnline() async {
    server.field.offline = false;
  }

  /// Taps a button of the bar of actions.
  Future<void> bar(String label) async {
    final Finder button = _button(label);
    await tester.ensureVisible(button.first);
    await tester.pump();
    await tester.tap(button.first, warnIfMissed: false);
    await settleReal(tester, rounds: 12);
  }

  /// Taps a button of the sheet that is open.
  Future<void> sheet(String label) async {
    final Finder button = find.descendant(of: find.byType(ActionSheet), matching: find.widgetWithText(FilledButton, label));
    await tester.ensureVisible(button);
    await tester.pump();
    await tester.tap(button, warnIfMissed: false);
    await settleReal(tester, rounds: 14);
  }

  Future<void> typeInSheet(String label, String text) async {
    await tester.enterText(find.descendant(of: find.byType(ActionSheet), matching: find.widgetWithText(TextField, label)), text);
    await tester.pump();
  }
}

Future<_Phone> _open(WidgetTester tester, TaskState state, {List<Map<String, Object?>>? blockers, FakeSyncServer? sync}) async {
  useDevice(tester, kTall);
  final PwfTaskServer server = PwfTaskServer(state, sync: sync)..blockers = blockers;
  final FieldWorld world = FieldWorld.create(server: server.field);
  await world.open(tester, _location, extra: <MobileFeature>[pwf.feature]);
  await settleReal(tester, rounds: 8);
  return _Phone(tester, server, world);
}

/// A button (filled or outlined) with these words.
Finder _button(String label) => find.ancestor(of: find.text(label), matching: find.byWidgetPredicate((Widget widget) => widget is ButtonStyleButton));

void main() {
  group('MOB-79 one task: what is on it', () {
    testWidgets('the name, the official deadline in words with its day, the facts, what is still needed, the checklist, the documents, the evidence, the history', (WidgetTester tester) async {
      final TaskState state = TaskState();
      state.evidence.add(<String, Object?>{'id': 'e1', 'item_code': 'C1', 'evidence_kind': 'DOCUMENT', 'document_id': null, 'legal_doc_type': null, 'form_template_code': null, 'external_ref': 'QD-12/2026', 'note': null, 'attached_by': 'x', 'attached_at': kAsOf});
      await _open(tester, state, blockers: <Map<String, Object?>>[
        <String, Object?>{'code': 'CHECKLIST_ITEM_OPEN', 'subject': 'C1'},
        <String, Object?>{'code': 'FORM_MISSING', 'subject': 'FORM_BID'},
      ]);
      expect(find.text('Lập hồ sơ mời thầu gói thầu xây lắp'), findsWidgets);
      expect(find.text('Trễ 2 ngày làm việc'), findsOneWidget);
      expect(find.text('Hạn chính thức'), findsOneWidget);
      expect(find.text('Đang làm'), findsOneWidget);
      expect(find.text('Trần Văn B'), findsOneWidget);
      expect(find.text('Còn thiếu để hoàn thành'), findsOneWidget);
      expect(find.text('Mục danh mục kiểm chưa xong: Dự thảo hồ sơ mời thầu'), findsOneWidget, reason: 'a blocker names the item, not its code');
      expect(find.text('Thiếu biểu mẫu FORM_BID'), findsOneWidget);
      expect(find.text('Dự thảo hồ sơ mời thầu'), findsOneWidget);
      expect(find.text('Chứng từ pháp lý'), findsWidgets);
      expect(find.text('Quyết định đầu tư'), findsOneWidget, reason: 'a legal document type is said by its name');
      expect(find.text('QD-12/2026'), findsOneWidget);
      // The history is on its own tab.
      await tester.scrollUntilVisible(find.textContaining('Diễn biến'), -200, scrollable: find.byType(Scrollable).first);
      await tester.tap(find.textContaining('Diễn biến').first);
      await tester.pump();
      expect(find.text('Trả lại công việc'), findsOneWidget, reason: 'the history says it was returned');
      expect(find.textContaining('Thiếu phụ lục kỹ thuật'), findsOneWidget);
      // The completion is locked while the checklist is open, and says why.
      expect(find.text('Còn 2 điều kiện chưa đủ để hoàn thành.'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Hoàn thành việc')).onPressed, isNull);
    });

    final List<({String name, TaskState Function() state, List<String> shown, List<String> hidden})> bars = <({String name, TaskState Function() state, List<String> shown, List<String> hidden})>[
      (name: 'a task that is not started: start it', state: () => TaskState(status: 'NOT_STARTED'), shown: <String>['Bắt đầu việc'], hidden: <String>['Hoàn thành việc']),
      (name: 'a task in progress: complete it or ask for more time', state: TaskState.new, shown: <String>['Hoàn thành việc', 'Dời hạn'], hidden: <String>['Bắt đầu việc', 'Duyệt hoàn thành']),
      (name: 'a task that waits for approval: approve or return it', state: () => TaskState(status: 'AWAITING_APPROVAL', canApprove: true, assignee: false), shown: <String>['Duyệt hoàn thành', 'Trả lại'], hidden: <String>['Hoàn thành việc']),
      (name: 'a task on hold: resume it', state: () => TaskState(status: 'ON_HOLD'), shown: <String>['Tiếp tục việc'], hidden: <String>['Hoàn thành việc']),
      (name: 'a task that is done: nothing', state: () => TaskState(status: 'DONE'), shown: <String>[], hidden: <String>['Hoàn thành việc', 'Bắt đầu việc', 'Duyệt hoàn thành', 'Tiếp tục việc', 'Dời hạn']),
    ];
    for (final ({String name, TaskState Function() state, List<String> shown, List<String> hidden}) bar in bars) {
      testWidgets('the bar offers what the server says the person can do: ${bar.name}', (WidgetTester tester) async {
        await _open(tester, bar.state());
        for (final String label in bar.shown) {
          expect(_button(label), findsOneWidget, reason: label);
        }
        for (final String label in bar.hidden) {
          expect(_button(label), findsNothing, reason: label);
        }
      });
    }
  });

  group('R39 the work of the person offline', () {
    testWidgets('completing a task with no connection is kept on the phone as one command on the version that was read, with a key of its own, and nothing is sent until there is a connection; then it is carried out once', (WidgetTester tester) async {
      final _Phone phone = await _open(tester, TaskState());
      await phone.goOffline();
      await phone.bar('Hoàn thành việc');
      await phone.typeInSheet('Ghi chú (không bắt buộc)', 'Đủ hồ sơ');
      await phone.sheet('Hoàn thành việc');
      final List<QueuedCommand> pending = await phone.pending();
      expect(pending, hasLength(1));
      expect(pending.single.commandType, kPwfCompleteCommand);
      expect(pending.single.payload, <String, Object?>{'task_id': kTaskId, 'note': 'Đủ hồ sơ'});
      expect(pending.single.baseServerVersion, 3);
      expect(pending.single.idempotencyKey, hasLength(36));
      expect(find.textContaining('Đã ghi nhận trên máy, sẽ gửi khi có mạng: hoàn thành việc.'), findsOneWidget);
      expect(phone.server.applied, isEmpty, reason: 'nothing reached the server');
      expect(phone.server.state.status, 'IN_PROGRESS');
      // The connection is back: the command is carried out once, on the version it was based on, and the task is read again.
      await phone.goOnline();
      await phone.flush();
      expect(phone.server.applied, <({String type, int base})>[(type: kPwfCompleteCommand, base: 3)]);
      expect(phone.server.sync.effectsOf(pending.single.idempotencyKey), 1);
      expect(find.textContaining('Đã ghi nhận trên máy, sẽ gửi'), findsNothing);
      expect(find.text('Chờ duyệt hoàn thành'), findsWidgets);
      expect(await phone.pending(), isEmpty);
      await phone.flush();
      expect(phone.server.sync.effectsOf(pending.single.idempotencyKey), 1, reason: 'sending again does not do it twice');
    });

    testWidgets('start, evidence for an item, the item and the completion are queued behind each other, each on the version the earlier ones will leave, and are carried out in order', (WidgetTester tester) async {
      final _Phone phone = await _open(tester, TaskState(status: 'NOT_STARTED'));
      await phone.goOffline();
      await phone.bar('Bắt đầu việc');
      await phone.sheet('Bắt đầu việc');
      // The task is not started on the server, but the person has started it: what follows is offered and queued behind it.
      expect(find.widgetWithText(FilledButton, 'Hoàn thành việc'), findsOneWidget);
      await tester.tap(find.text('Biên bản họp tổ chuyên gia'));
      await settleReal(tester, rounds: 10);
      await tester.tap(find.text('Nộp chứng từ cho mục này'));
      await settleReal(tester, rounds: 10);
      await tester.enterText(find.widgetWithText(TextField, 'Số hiệu hoặc đường dẫn'), 'BB-14/2026');
      await tester.pump();
      await phone.sheet('Nộp chứng từ');
      await tester.tap(find.text('Biên bản họp tổ chuyên gia'));
      await settleReal(tester, rounds: 10);
      await tester.tap(find.text('Đánh dấu mục này đã xong'));
      await settleReal(tester, rounds: 10);
      await phone.sheet('Đánh dấu đã xong');
      await phone.bar('Hoàn thành việc');
      await phone.sheet('Hoàn thành việc');
      final List<QueuedCommand> pending = await phone.pending();
      expect(pending.map((QueuedCommand c) => c.commandType), <String>[kPwfStartCommand, kPwfEvidenceCommand, kPwfChecklistCommand, kPwfCompleteCommand]);
      expect(pending.map((QueuedCommand c) => c.baseServerVersion), <int>[3, 3, 4, 5], reason: 'start adds one, the item one, the completion is after both: each versioned command is based on what the earlier ones leave (evidence does not move the version, and the server does not check it)');
      expect(pending[1].payload, <String, Object?>{'task_id': kTaskId, 'evidence_kind': 'DOCUMENT', 'item_code': 'C2', 'external_ref': 'BB-14/2026'});
      expect(find.text('Chờ gửi'), findsOneWidget, reason: 'the item that was ticked is told to wait');
      await phone.goOnline();
      await phone.flush();
      expect(phone.server.applied.map((({String type, int base}) a) => a.type), <String>[kPwfStartCommand, kPwfEvidenceCommand, kPwfChecklistCommand, kPwfCompleteCommand]);
      expect(phone.server.state.status, 'AWAITING_APPROVAL');
      expect(phone.server.state.version, 6);
      expect(find.text('Chờ duyệt hoàn thành'), findsWidgets);
      expect(find.text('Chờ gửi'), findsNothing);
    });

    testWidgets('a request for more time is kept with its reason and its days, and a reason that is too short is refused before anything is kept', (WidgetTester tester) async {
      final _Phone phone = await _open(tester, TaskState());
      await phone.goOffline();
      await phone.bar('Dời hạn');
      await phone.typeInSheet('Lý do', 'Chờ Sở');
      await phone.sheet('Gửi đề nghị');
      expect(find.text('Cần ít nhất 20 ký tự.'), findsWidgets);
      expect(await phone.pending(), isEmpty);
      await phone.typeInSheet('Lý do', 'Chờ ý kiến thẩm định của Sở Kế hoạch và Đầu tư');
      await tester.tap(find.text('Chọn ngày kết thúc'));
      await settleReal(tester, rounds: 6);
      await tester.tap(find.text('OK'));
      await settleReal(tester, rounds: 6);
      await phone.sheet('Gửi đề nghị');
      final List<QueuedCommand> pending = await phone.pending();
      expect(pending, hasLength(1));
      expect(pending.single.commandType, kPwfExceptionCommand);
      expect(pending.single.payload!['kind'], 'EXTERNAL_DELAY');
      expect(pending.single.payload!['reason'], 'Chờ ý kiến thẩm định của Sở Kế hoạch và Đầu tư');
      expect(pending.single.payload!['valid_to'], isNotNull);
      await phone.goOnline();
      await phone.flush();
      expect(phone.server.state.exceptions, hasLength(1));
      // The requests of the task are on the tab "Diễn biến" (the screen opens on "Cần làm"): the row there reads "Xin dời hạn · Chờ quyết định".
      // Not run on the machine this was written on (Smart App Control blocks sqlite3mc.dll, which this file needs): CI confirms it.
      await tester.scrollUntilVisible(find.textContaining('Diễn biến'), -200, scrollable: find.byType(Scrollable).first);
      await tester.tap(find.textContaining('Diễn biến').first);
      await settleReal(tester, rounds: 6);
      expect(find.textContaining('Chờ quyết định'), findsOneWidget);
    });

    testWidgets('an answer that is lost after the server did the work is looked up by its key and never done twice', (WidgetTester tester) async {
      final FakeSyncServer sync = FakeSyncServer()..dropNextBatchAnswer = true;
      final _Phone phone = await _open(tester, TaskState(), sync: sync);
      await phone.bar('Hoàn thành việc');
      await phone.sheet('Hoàn thành việc');
      await settleReal(tester, rounds: 24);
      // The server did the work and its answer was lost: the phone asked it by the key what became of the command, and did not send it again.
      expect(phone.server.applied, hasLength(1));
      expect(phone.server.sync.lookups, greaterThan(0));
      expect(phone.server.sync.effects.values.single, 1);
      expect(await phone.pending(), isEmpty);
      expect(find.text('Chờ duyệt hoàn thành'), findsWidgets);
    });
  });

  group('R39 the version the server answered to a command is not forgotten', () {
    testWidgets('a command the server took, then a read of the task that failed, then another action: the next command is based on the version the server answered, not on the stale one on the screen', (WidgetTester tester) async {
      final _Phone phone = await _open(tester, TaskState());
      // The screen holds the task as it was read: version 3. The person ticks an item; the server takes it and moves to version 4.
      final PwfTaskDetail stale = parsePwfTaskDetail(taskDetailJson(TaskState()))!;
      final PwfTaskService service = phone.container.read(pwfTaskServiceProvider);
      final QueuedCommand tick = (await tester.runAsync(() => service.completeChecklistItem(stale, 'C1', intention: 'tick-c1-0000000000001')))!;
      expect(tick.subjectRef, kTaskId, reason: 'the queue keeps which task the command is about');
      await phone.flush();
      expect(phone.server.state.version, 4);
      final QueuedCommand receipt = (await phone.queue).command(tick.id)!;
      expect(receipt.state, CommandState.accepted);
      expect(receipt.payload, isNull, reason: 'a command the server took keeps no data');
      expect(pwfTaskOf(receipt), kTaskId);
      expect(receipt.serverVersion, 4);
      // The read of the task after it failed: the screen still has version 3. The next action must still start from 4.
      final QueuedCommand complete = (await tester.runAsync(() => service.complete(stale, intention: 'complete-0000000000000001')))!;
      expect(complete.baseServerVersion, 4);
      await phone.flush();
      expect(phone.server.applied.map((({String type, int base}) c) => c.base), <int>[3, 4]);
      expect(phone.server.state.status, 'AWAITING_APPROVAL');
    });

    testWidgets('a command queued before the queue kept the task apart still names its task from its payload', (WidgetTester tester) async {
      final _Phone phone = await _open(tester, TaskState());
      final CommandQueue queue = await phone.queue;
      final QueuedCommand old = queue.enqueue(commandType: kPwfStartCommand, payload: pwfStartPayload(kTaskId), baseServerVersion: 3);
      expect(old.subjectRef, isNull);
      expect(pwfTaskOf(old), kTaskId);
    });
  });

  group('R39 the task changed while the person was offline', () {
    testWidgets('the command comes back as a conflict, is not written over, and the screen shows the task as it is now; the person sends their work again on the new version, under a new key, and it is carried out once', (WidgetTester tester) async {
      final _Phone phone = await _open(tester, TaskState());
      await phone.goOffline();
      await phone.bar('Hoàn thành việc');
      await phone.sheet('Hoàn thành việc');
      final QueuedCommand first = (await phone.pending()).single;
      expect(first.baseServerVersion, 3);
      // Another person ticked an item on the server meanwhile: the version is now 4.
      phone.server.changedByAnotherPerson(checklist: 'C1');
      await phone.goOnline();
      await phone.flush();
      expect(phone.server.applied, isEmpty, reason: 'the command was not carried out on a version it was not based on');
      expect(phone.server.state.status, 'IN_PROGRESS');
      expect((await phone.pending()).single.state, CommandState.conflict);
      // The screen says so and shows the task as the server has it (the item that the other person ticked is done).
      expect(find.text('Công việc đã thay đổi'), findsOneWidget);
      expect(find.textContaining('hoàn thành việc'), findsWidgets);
      expect(find.text('Xong'), findsOneWidget);
      // A new action on the task waits until the person has dealt with the conflict.
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Hoàn thành việc')).onPressed, isNull);
      expect(find.text('Một lệnh của bạn chưa được ghi. Xử lý lệnh đó ở trên trước.'), findsOneWidget);
      await tester.tap(find.text('Gửi lại trên bản mới'));
      await settleReal(tester, rounds: 14);
      await phone.flush();
      final ({String type, int base}) done = phone.server.applied.single;
      expect(done, (type: kPwfCompleteCommand, base: 4));
      expect((await phone.queue).commands().where((QueuedCommand c) => c.id == first.id).single.supersededKeys, contains(first.idempotencyKey), reason: 'the command was based again in place: same command, new key, the old key remembered');
      expect(phone.server.state.status, 'AWAITING_APPROVAL');
      expect(phone.server.sync.effectsOf(first.idempotencyKey), 0, reason: 'the old key never did anything');
      expect(find.text('Công việc đã thay đổi'), findsNothing);
      expect(await phone.pending(), isEmpty);
    });

    testWidgets('a command that follows one the server refused was based on a version the server never reached: it is a conflict, and sending it again rebases it on the version the server holds', (WidgetTester tester) async {
      final _Phone phone = await _open(tester, TaskState());
      await phone.goOffline();
      // The person ticks an item and completes: the completion is based on the version the item would leave.
      await tester.tap(find.text('Dự thảo hồ sơ mời thầu'));
      await settleReal(tester, rounds: 10);
      await tester.tap(find.text('Đánh dấu mục này đã xong'));
      await settleReal(tester, rounds: 10);
      await phone.sheet('Đánh dấu đã xong');
      await phone.bar('Hoàn thành việc');
      await phone.sheet('Hoàn thành việc');
      expect((await phone.pending()).map((QueuedCommand c) => c.baseServerVersion), <int>[3, 4]);
      // The server refuses the item (it does not allow it now): the version stays at 3 and the completion, based on 4, comes back in conflict.
      phone.server.refuses.add(kPwfChecklistCommand);
      await phone.goOnline();
      await phone.flush();
      expect((await phone.pending()).map((QueuedCommand c) => c.state), <CommandState>[CommandState.rejected, CommandState.conflict]);
      expect(find.text('Công việc đã thay đổi'), findsOneWidget);
      phone.server.refuses.clear();
      await tester.tap(find.text('Gửi lại trên bản mới'));
      await settleReal(tester, rounds: 14);
      await phone.flush();
      expect(phone.server.applied.single, (type: kPwfCompleteCommand, base: 3), reason: 'the refused item does not count: the completion is based on what the server holds');
      expect(phone.server.state.status, 'AWAITING_APPROVAL');
    });

    testWidgets('sending the chain again keeps every command and its place, and the runner is not woken by a command that is made but by the change that is kept', (WidgetTester tester) async {
      final _Phone phone = await _open(tester, TaskState());
      await phone.goOffline();
      await tester.tap(find.text('Dự thảo hồ sơ mời thầu'));
      await settleReal(tester, rounds: 10);
      await tester.tap(find.text('Đánh dấu mục này đã xong'));
      await settleReal(tester, rounds: 10);
      await phone.sheet('Đánh dấu đã xong');
      await phone.bar('Hoàn thành việc');
      await phone.sheet('Hoàn thành việc');
      final List<QueuedCommand> made = await phone.pending();
      expect(made, hasLength(2));
      // Two other people changed the task meanwhile: the version is 5, and neither command (based on 3 and 4) is carried out.
      phone.server.changedByAnotherPerson();
      phone.server.changedByAnotherPerson();
      await phone.goOnline();
      await phone.flush();
      expect((await phone.pending()).map((QueuedCommand c) => c.state), <CommandState>[CommandState.conflict, CommandState.conflict]);
      final CommandQueue queue = await phone.queue;
      final List<QueueEvent> events = <QueueEvent>[];
      final sub = queue.events.listen(events.add);
      await tester.tap(find.text('Gửi lại trên bản mới'));
      await settleReal(tester, rounds: 14);
      unawaited(sub.cancel());
      expect(events.where((QueueEvent e) => e.from == null), isEmpty, reason: 'no command was discarded and made again, so nothing woke the runner on a half-built chain');
      expect(queue.commands().map((QueuedCommand c) => c.id).toList(), containsAllInOrder(made.map((QueuedCommand c) => c.id)));
      expect(queue.commands().where((QueuedCommand c) => c.state == CommandState.discarded), isEmpty);
      await phone.flush();
      expect(phone.server.applied.map((({String type, int base}) c) => (c.type, c.base)), <(String, int)>[(kPwfChecklistCommand, 5), (kPwfCompleteCommand, 6)]);
    });

    test('the plan of a resend: the commands from the first conflict on, each on the version of the server plus the versioned ones before it; a refused one counts for nothing', () {
      QueuedCommand cmd(int n, String type, CommandState state, int base) => QueuedCommand(
            id: 'c$n',
            tenantId: 't',
            userId: 'u',
            commandType: type,
            payload: <String, Object?>{'task_id': kTaskId},
            payloadBytes: 10,
            baseServerVersion: base,
            idempotencyKey: 'key-$n-000000000000000',
            state: state,
            createdAt: n,
            updatedAt: n,
            subjectRef: kTaskId,
          );
      List<(String, int)> plan(List<QueuedCommand> commands, int version) => <(String, int)>[for (final step in pwfResendPlan(commands, kTaskId, version)) (step.id, step.baseServerVersion)];
      expect(plan(<QueuedCommand>[cmd(1, kPwfChecklistCommand, CommandState.queued, 3)], 7), isEmpty, reason: 'nothing is in conflict');
      expect(plan(<QueuedCommand>[cmd(1, kPwfChecklistCommand, CommandState.conflict, 3), cmd(2, kPwfEvidenceCommand, CommandState.queued, 4), cmd(3, kPwfCompleteCommand, CommandState.queued, 4)], 7), <(String, int)>[('c1', 7), ('c2', 8), ('c3', 8)]);
      expect(plan(<QueuedCommand>[cmd(1, kPwfChecklistCommand, CommandState.rejected, 3), cmd(2, kPwfCompleteCommand, CommandState.conflict, 4)], 3), <(String, int)>[('c2', 3)], reason: 'the refused item does not count');
      expect(plan(<QueuedCommand>[cmd(1, kPwfChecklistCommand, CommandState.queued, 3), cmd(2, kPwfCompleteCommand, CommandState.conflict, 4)], 6), <(String, int)>[('c2', 7)], reason: 'a versioned command still waiting before the conflict is carried out first');
      expect(plan(<QueuedCommand>[cmd(1, kPwfCompleteCommand, CommandState.conflict, 4), cmd(2, kPwfStartCommand, CommandState.sending, 5)], 6), <(String, int)>[('c1', 6)], reason: 'a command that is being sent is not touched');
    });

    testWidgets('the queue sends a command of the work on a task that is in conflict to the screen of the task, not to the comparison of fields, and offers no argument of the command as a field to choose', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final PwfTaskServer server = PwfTaskServer(TaskState());
      final FieldWorld world = FieldWorld.create(server: server.field);
      await world.open(tester, '/account/mob-41', extra: <MobileFeature>[pwf.feature]);
      await settleReal(tester, rounds: 8);
      final ProviderContainer container = world.container;
      expect(container.read(conflictAdaptersProvider).forType(kPwfCompleteCommand), isNull, reason: 'what a person did on a task is not a record to compare field by field');
      final CommandQueue queue = (await tester.runAsync(() => container.read(commandQueueProvider.future)))!;
      server.field.offline = true;
      final PwfTaskDetail task = parsePwfTaskDetail(taskDetailJson(TaskState()))!;
      await tester.runAsync(() => container.read(pwfTaskServiceProvider).start(task, intention: 'start-0000000000000001', note: 'Bắt đầu theo kế hoạch'));
      server.changedByAnotherPerson();
      server.field.offline = false;
      await tester.runAsync(queue.flush);
      await settleReal(tester, rounds: 12);
      expect(queue.commands().single.state, CommandState.conflict);
      expect(find.text('Xem và chọn'), findsOneWidget);
      await tester.tap(find.text('Xem và chọn'));
      await settleReal(tester, rounds: 12);
      expect(currentLocation(container), _location, reason: 'the person sees the task as it is now and sends the work again there');
    });

    testWidgets('the person can drop what they did instead: the task on the server is left as it is', (WidgetTester tester) async {
      final _Phone phone = await _open(tester, TaskState());
      await phone.goOffline();
      await phone.bar('Hoàn thành việc');
      await phone.sheet('Hoàn thành việc');
      phone.server.changedByAnotherPerson();
      await phone.goOnline();
      await phone.flush();
      expect(find.text('Công việc đã thay đổi'), findsOneWidget);
      await tester.tap(find.text('Bỏ phần đã làm').first);
      await settleReal(tester, rounds: 10);
      final Finder confirm = find.descendant(of: find.byType(ActionSheet), matching: find.widgetWithText(FilledButton, 'Bỏ phần đã làm'));
      await tester.tap(confirm);
      await settleReal(tester, rounds: 14);
      expect(await phone.pending(), isEmpty);
      expect(find.text('Công việc đã thay đổi'), findsNothing);
      expect(phone.server.applied, isEmpty);
      expect(phone.server.state.status, 'IN_PROGRESS');
      expect(find.widgetWithText(FilledButton, 'Hoàn thành việc'), findsOneWidget, reason: 'the person can act again');
    });

    testWidgets('a command the server refuses for good says which one and why, and can be dropped', (WidgetTester tester) async {
      final _Phone phone = await _open(tester, TaskState());
      await phone.goOffline();
      await phone.bar('Hoàn thành việc');
      await phone.sheet('Hoàn thành việc');
      // The task was put on hold by someone else without a change of the version the phone knows.
      phone.server.state.status = 'ON_HOLD';
      await phone.goOnline();
      await phone.flush();
      expect(find.text('Máy chủ không nhận: hoàn thành việc'), findsOneWidget);
      expect(find.textContaining('PWF_TASK_STATE_INVALID'), findsOneWidget);
      await tester.tap(find.text('Bỏ lệnh này'));
      await settleReal(tester, rounds: 10);
      await phone.sheet('Bỏ phần đã làm');
      expect(await phone.pending(), isEmpty);
      expect(find.text('Máy chủ không nhận: hoàn thành việc'), findsNothing);
    });
  });

  group('what is never queued: the decisions of another person', () {
    testWidgets('a task that waits for approval says so once, in the head: the state is not repeated as a fact under it (owner review of 14/11/2026)', (WidgetTester tester) async {
      await _open(tester, TaskState(status: 'AWAITING_APPROVAL', canApprove: true, assignee: false));
      expect(find.text('Chờ duyệt hoàn thành'), findsOneWidget);
      expect(find.text('Trạng thái'), findsNothing);
    });

    testWidgets('a task that is under way keeps its state as a fact: its head shows the days left, not the state', (WidgetTester tester) async {
      await _open(tester, TaskState(status: 'IN_PROGRESS'));
      expect(find.text('Trạng thái'), findsOneWidget);
    });

    testWidgets('an approval needs a connection: offline the button is locked and says why, nothing is queued; online it is sent on the version that is on the screen', (WidgetTester tester) async {
      final _Phone phone = await _open(tester, TaskState(status: 'AWAITING_APPROVAL', canApprove: true, assignee: false));
      await phone.goOffline();
      // The first request that fails tells the phone it is offline.
      phone.container.read(reachabilityProvider.notifier).report(Reachability.offline);
      await settleReal(tester, rounds: 4);
      expect(find.text('Duyệt, trả lại và tiếp tục việc cần có kết nối mạng.'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Duyệt hoàn thành')).onPressed, isNull);
      expect(await phone.pending(), isEmpty);
      await phone.goOnline();
      phone.container.read(reachabilityProvider.notifier).report(Reachability.online);
      await settleReal(tester, rounds: 4);
      await phone.bar('Duyệt hoàn thành');
      await phone.sheet('Duyệt hoàn thành');
      expect(phone.server.decisions.single.path, '/project-tasks/$kTaskId/approve-completion');
      expect(phone.server.decisions.single.ifMatch, '"3"');
      expect(phone.server.decisions.single.body['decision'], 'APPROVE');
      expect(phone.server.state.status, 'DONE');
      expect(await phone.pending(), isEmpty, reason: 'an approval never goes through the queue');
    });

    testWidgets('when the task changed before the approval, the server refuses the version, the screen says so and reads the task again', (WidgetTester tester) async {
      final _Phone phone = await _open(tester, TaskState(status: 'AWAITING_APPROVAL', canApprove: true, assignee: false));
      phone.server.state.version += 1;
      await phone.bar('Duyệt hoàn thành');
      await phone.sheet('Duyệt hoàn thành');
      expect(find.textContaining('Công việc đã thay đổi. Đã tải lại bản mới.'), findsOneWidget);
      expect(find.textContaining('VERSION_CONFLICT'), findsOneWidget);
      expect(phone.server.state.status, 'AWAITING_APPROVAL');
      // The task is read again, so the next approval is on the new version.
      await phone.bar('Duyệt hoàn thành');
      await phone.sheet('Duyệt hoàn thành');
      expect(phone.server.decisions.last.ifMatch, '"4"');
      expect(phone.server.state.status, 'DONE');
    });

    testWidgets('a return needs a reason of at least twenty characters and is sent online with it', (WidgetTester tester) async {
      final _Phone phone = await _open(tester, TaskState(status: 'AWAITING_APPROVAL', canApprove: true, assignee: false));
      await tester.tap(find.widgetWithText(OutlinedButton, 'Trả lại'));
      await settleReal(tester, rounds: 10);
      await phone.typeInSheet('Lý do trả lại', 'thiếu');
      await phone.sheet('Trả lại việc');
      expect(find.text('Cần ít nhất 20 ký tự.'), findsOneWidget);
      expect(phone.server.decisions, isEmpty);
      await phone.typeInSheet('Lý do trả lại', 'Thiếu phụ lục kỹ thuật của hồ sơ');
      await phone.sheet('Trả lại việc');
      expect(phone.server.decisions.single.body, <String, Object?>{'reason': 'Thiếu phụ lục kỹ thuật của hồ sơ'});
      expect(phone.server.state.status, 'IN_PROGRESS');
    });
  });
}
