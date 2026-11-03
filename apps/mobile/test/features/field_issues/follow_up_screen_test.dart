import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/offline/queue/command_queue.dart';
import 'package:machvon_mobile/core/offline/queue/queued_command.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/features/field_issues/issue_draft.dart';

import '../../support/fake_sync_server.dart';
import '../../support/harness.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'field_world.dart';

Future<FieldWorld> _open(WidgetTester tester, {Map<String, Object?>? issue, FieldServer? server, FakeSession? session, String reference = 'iss-1'}) async {
  final FieldServer field = server ?? FieldServer();
  field.api.on('GET', '/resources/issue/iss-1', (_) => issue ?? issueView('iss-1'));
  final FieldWorld world = FieldWorld.create(server: field);
  await world.open(tester, '/projects/mob-31/$reference', session: session);
  await settleReal(tester, rounds: 10);
  return world;
}

Future<void> _type(WidgetTester tester, String words) async {
  await tester.enterText(find.widgetWithText(TextField, 'Nội dung ý kiến'), words);
  await tester.pump();
}

void main() {
  group('AC-ST-MOB-014-3 UAT-PLAN-37 UI-MOB-31 the follow-up shows the status and the deadline the server counted', () {
    testWidgets('shows the status, the severity, the handler, the deadlines in Vietnam time and the timeline newest first', (WidgetTester tester) async {
      useDevice(tester, kTall);
      await _open(
        tester,
        issue: issueView('iss-1', status: 'IN_PROGRESS', events: <Object?>[
          issueEvent('e-1', 'CREATED', at: '2026-11-03T01:00:00Z', actor: 'Nguyễn Văn A'),
          issueEvent('e-2', 'ASSIGNED', at: '2026-11-03T02:00:00Z'),
          issueEvent('e-3', 'COMMENTED', at: '2026-11-03T03:00:00Z', note: 'Đã cử xe múc ra hiện trường', actor: 'Trần Văn B'),
        ]),
      );

      expect(find.text('Sạt lở taluy km3'), findsWidgets);
      expect(find.text('ISS-0001'), findsOneWidget);
      expect(find.text('Đang xử lý'), findsWidgets);
      expect(find.text('Cao'), findsOneWidget);
      expect(find.text('Trần Văn B'), findsOneWidget);
      expect(find.text('03/11/2026 12:00'), findsOneWidget, reason: 'the response deadline of the server: 05:00 UTC is 12:00 in Vietnam');
      expect(find.text('05/11/2026 17:00'), findsOneWidget, reason: 'the resolution deadline of the server');
      expect(find.text('Chính sách SLA-HIGH: phản hồi trong 4 giờ, xử lý trong 48 giờ.'), findsOneWidget);
      expect(find.text('Hạn do máy chủ tính trên lịch làm việc, không phải đồng hồ điện thoại.'), findsOneWidget);
      expect(find.text('Đã cử xe múc ra hiện trường'), findsOneWidget);
      final double created = tester.getTopLeft(find.text('Ghi nhận vướng mắc · Nguyễn Văn A')).dy;
      final double commented = tester.getTopLeft(find.text('Ý kiến xử lý · Trần Văn B')).dy;
      expect(commented, lessThan(created), reason: 'the newest comes first');
    });

    testWidgets('says an overdue issue is overdue and a closed one takes no comment', (WidgetTester tester) async {
      useDevice(tester, kTall);
      await _open(tester, issue: issueView('iss-1', status: 'CLOSED', overdue: true));
      expect(find.text('Quá hạn'), findsOneWidget);
      expect(find.text('Đã đóng'), findsWidgets);
      expect(find.text('Vướng mắc đã đóng nên không nhận thêm ý kiến.'), findsOneWidget);
      expect(find.text('Gửi ý kiến'), findsNothing);
    });

    testWidgets('shows the stored position to a reader who may see it, and says it is hidden from one who may not', (WidgetTester tester) async {
      useDevice(tester, kTall);
      await _open(tester, issue: issueView('iss-1', geoConsent: true, geo: <String, Object?>{'lat': '10.800000', 'lng': '106.700000', 'accuracy_m': '90.00', 'low_accuracy': true}));
      expect(find.text('10.800000, 106.700000'), findsOneWidget);
      expect(find.text('Độ chính xác thấp (trên 50 m): vị trí chỉ để tham khảo.'), findsOneWidget);
    });

    testWidgets('a guest reader sees the work but not the position', (WidgetTester tester) async {
      useDevice(tester, kTall);
      await _open(tester, issue: issueView('iss-1', geoConsent: true));
      expect(find.text('Báo cáo có vị trí nhưng bạn không có quyền xem.'), findsOneWidget);
      expect(find.textContaining('10.8'), findsNothing);
    });

    testWidgets('an issue that is not in the scope of the reader is a 404 with its code', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      server.api.refuse('GET', '/resources/issue/iss-1', 404, 'RESOURCE_NOT_FOUND');
      final FieldWorld world = FieldWorld.create(server: server);
      await world.open(tester, '/projects/mob-31/iss-1');
      await settleReal(tester, rounds: 10);
      expect(find.text('RESOURCE_NOT_FOUND'), findsOneWidget);
    });
  });

  group('UI-MOB-31 the comments on an issue', () {
    testWidgets('a comment is sent once, the field is emptied and the issue is read again', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      server.api.on('POST', '/issues/iss-1/comments', (_) => <String, Object?>{'operation_id': 'commentIssue', 'status': 'COMMENTED', 'resource_version': 1, 'resource_id': 'iss-1'});
      final FieldWorld world = await _open(tester, server: server);

      await _type(tester, '  Đã báo cho đội thi công.  ');
      await tapText(tester, 'Gửi ý kiến');
      await settleReal(tester, rounds: 10);

      final List<HttpCall> posts = server.api.callsTo('POST', '/issues/iss-1/comments');
      expect(posts, hasLength(1));
      expect(jsonDecode(posts.single.body!), <String, Object?>{'note': 'Đã báo cho đội thi công.'});
      expect(posts.single.headers['idempotency-key'], isNotEmpty);
      expect(find.text('Đã thêm ý kiến vào dòng thời gian.'), findsOneWidget);
      expect(tester.widget<TextField>(find.widgetWithText(TextField, 'Nội dung ý kiến')).controller!.text, isEmpty);
      expect(server.api.callsTo('GET', '/resources/issue/iss-1'), hasLength(2), reason: 'read again after the comment');
      expect(world.server.sync.batchPosts, 0, reason: 'a comment is not a queued command');
    });

    testWidgets('an empty comment is not sent', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      await _open(tester, server: server);
      await _type(tester, '   ');
      await tapText(tester, 'Gửi ý kiến');
      expect(find.text('Bắt buộc nhập.'), findsOneWidget);
      expect(server.api.callsTo('POST', '/issues/iss-1/comments'), isEmpty);
    });

    testWidgets('a refusal says why with its code and keeps the words', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      server.api.refuse('POST', '/issues/iss-1/comments', 409, 'ISSUE_STATE_INVALID');
      await _open(tester, server: server);
      await _type(tester, 'Đã báo cho đội thi công.');
      await tapText(tester, 'Gửi ý kiến');
      await settleReal(tester, rounds: 6);

      expect(find.text('Vướng mắc đã đóng hoặc không ở trạng thái nhận ý kiến.'), findsOneWidget);
      expect(find.text('ISSUE_STATE_INVALID'), findsOneWidget);
      expect(find.text('Đã báo cho đội thi công.'), findsOneWidget, reason: 'what was written is still there');
    });

    testWidgets('a comment whose answer is lost is sent again under the same key and recorded once', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      int posts = 0;
      server.api.answer('POST', '/issues/iss-1/comments', (HttpCall call) {
        posts += 1;
        if (posts == 1) throw const SocketException('the connection was cut after the server did the work');
        return FakeTransport.json(200, <String, Object?>{'operation_id': 'commentIssue', 'status': 'COMMENTED', 'resource_version': 1, 'resource_id': 'iss-1'});
      });
      await _open(tester, server: server);
      await _type(tester, 'Đã báo cho đội thi công.');
      await tapText(tester, 'Gửi ý kiến');
      await settleReal(tester, rounds: 6);

      expect(find.text('Chưa xác định kết quả'), findsOneWidget);
      await tapText(tester, 'Gửi lại cùng ý kiến');
      await settleReal(tester, rounds: 8);

      final List<HttpCall> calls = server.api.callsTo('POST', '/issues/iss-1/comments');
      expect(calls, hasLength(2));
      expect(calls[1].headers['idempotency-key'], calls[0].headers['idempotency-key'], reason: 'the same intention');
      expect(find.text('Đã thêm ý kiến vào dòng thời gian.'), findsOneWidget);
    });

    testWidgets('without a network nothing is sent, the words stay, and the screen says a comment needs a network', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      final FieldWorld world = await _open(tester, server: server);
      await _type(tester, 'Đã báo cho đội thi công.');
      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await settleReal(tester, rounds: 8);
      await tapText(tester, 'Gửi ý kiến');
      await settleReal(tester, rounds: 6);

      expect(server.api.callsTo('POST', '/issues/iss-1/comments'), isEmpty);
      expect(find.text('Ý kiến cần có mạng để gửi. Nội dung bạn đã nhập được giữ lại.'), findsWidgets);
      expect(find.text('Đã báo cho đội thi công.'), findsOneWidget);
      expect(world.server.sync.batchPosts, 0, reason: 'a comment is never queued behind the back of the person');
    });

    testWidgets('a read-only system keeps the comment closed', (WidgetTester tester) async {
      useDevice(tester, kTall);
      await _open(tester, session: FakeSession(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1', mode: SessionMode.readOnly)));
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Gửi ý kiến')).onPressed, isNull);
    });
  });

  group('AC-ST-MOB-014-3 UI-MOB-31 a report that the server does not hold yet', () {
    testWidgets('a refused report says why, can be sent again as a new decision, or be dropped', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      server.sync.decide = (Map<String, Object?> item) => const ServerOutcome.rejected('SCOPE_DENIED');
      final FieldWorld world = FieldWorld.create(server: server);
      await world.open(tester, '/projects/mob-41');
      final CommandQueue queue = (await tester.runAsync(() => world.container.read(commandQueueProvider.future)))!;
      final QueuedCommand command = queue.enqueue(commandType: kIssueCreateCommand, payload: <String, Object?>{'title': 'Cọc tiêu bị gãy', 'client_operation_id': 'op-1'});
      await tester.runAsync(queue.flush);
      await world.go(tester, '/projects/mob-31/${command.id}');

      expect(find.text('Cọc tiêu bị gãy'), findsOneWidget);
      expect(find.text('Máy chủ không nhận báo cáo này.'), findsOneWidget);
      expect(find.text('SCOPE_DENIED'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Gửi lại'), findsOneWidget);

      await tapText(tester, 'Bỏ báo cáo này');
      expect(queue.command(command.id)!.state, CommandState.discarded);
      expect(currentLocation(world.container), '/projects/mob-28');
    });

    testWidgets('the number of photographs that are up is shown while the report waits', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      server.offline = true;
      final FieldWorld world = FieldWorld.create(server: server);
      await world.open(tester, '/projects/mob-41');
      final CommandQueue queue = (await tester.runAsync(() => world.container.read(commandQueueProvider.future)))!;
      final QueuedCommand command = queue.enqueue(commandType: kIssueCreateCommand, payload: <String, Object?>{'title': 'Cọc tiêu bị gãy', 'client_operation_id': 'op-1'});
      await world.go(tester, '/projects/mob-31/${command.id}');
      expect(find.textContaining('Ảnh đã tải lên'), findsNothing, reason: 'a report without photographs says nothing about them');
    });

    testWidgets('an accepted report whose id the queue did not keep is found by the key of the command', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      server.api.on('GET', '/resources/issue/iss-9', (_) => issueView('iss-9'));
      server.sync.decide = (Map<String, Object?> item) => const ServerOutcome.accepted(resultRef: 'iss-9');
      final FieldWorld world = FieldWorld.create(server: server);
      await world.open(tester, '/projects/mob-41');
      final CommandQueue queue = (await tester.runAsync(() => world.container.read(commandQueueProvider.future)))!;
      final QueuedCommand command = queue.enqueue(commandType: kIssueCreateCommand, payload: <String, Object?>{'title': 'Sạt lở taluy km3', 'client_operation_id': 'op-1'});
      await tester.runAsync(queue.flush);
      expect(queue.command(command.id)!.resultRef, isNull, reason: 'a batch answer carries no id');

      await world.go(tester, '/projects/mob-31/${command.id}');
      await settleReal(tester, rounds: 10);

      expect(find.text('ISS-0001'), findsOneWidget);
      expect(server.sync.lookups, 1);
    });
  });

  group('UI-MOB-31 MOB-31 every state is drawn and the contract of the screen holds', () {
    testWidgets('the states and the guidelines', (WidgetTester tester) async {
      Future<void> open(WidgetTester tester, ScriptedServer server) async {
        await FieldWorld.create(server: FieldServer(api: server)).open(tester, '/projects/mob-31/iss-1');
        await settleReal(tester, rounds: 6);
      }

      void healthy(ScriptedServer server) => server.on('GET', '/resources/issue/iss-1', (_) => issueView('iss-1', status: 'IN_PROGRESS', events: <Object?>[issueEvent('e-1', 'CREATED', actor: 'Nguyễn Văn A')]));
      await expectEveryState(tester, open: open, script: StateScript(healthy: healthy, content: find.text('Hạn xử lý')));
      await expectScreenContract(tester, open: open, healthy: healthy);
    });
  });
}
