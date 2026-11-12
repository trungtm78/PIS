import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart' show Ref;
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/offline/drafts/draft_store.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/offline/queue/command_queue.dart';
import 'package:machvon_mobile/core/offline/queue/queued_command.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/features/field_evidence/jpeg_metadata.dart';
import 'package:machvon_mobile/features/permissions/permission_service.dart';
import 'package:machvon_mobile/features/site_diary/diary_models.dart';
import 'package:machvon_mobile/features/site_diary/diary_service.dart';

import '../../support/fake_sync_server.dart';
import '../../support/harness.dart';
import '../field_evidence/exif_fixtures.dart';
import '../field_issues/field_world.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'diary_fixtures.dart';

const String _day = '2026-11-03';

Future<FieldWorld> _open(WidgetTester tester, {List<Map<String, Object?>> diaries = const <Map<String, Object?>>[], FieldServer? server, String? date, FakeSession? session, List<Override> overrides = const <Override>[]}) async {
  final FieldServer field = server ?? FieldServer();
  answerDiaries(field, diaries: diaries);
  final FieldWorld world = FieldWorld.create(server: field);
  await openDiaryApp(tester, world, '/projects/mob-62/c-1${date == null ? '' : '?date=$date'}', session: session, overrides: overrides);
  return world;
}

Future<CommandQueue> _queue(WidgetTester tester, FieldWorld world) async => (await tester.runAsync(() => world.container.read(commandQueueProvider.future)))!;

List<Map<String, Object?>> _appended(FieldWorld world) {
  final List<Map<String, Object?>> out = <Map<String, Object?>>[];
  for (final HttpCall batch in world.server.sync.batches) {
    final Map<String, Object?> body = jsonDecode(batch.body!) as Map<String, Object?>;
    for (final Object? item in body['items']! as List<Object?>) {
      out.add(item! as Map<String, Object?>);
    }
  }
  return out;
}

Future<void> _flush(WidgetTester tester, FieldWorld world) async {
  final CommandQueue queue = await _queue(tester, world);
  await tester.runAsync(queue.flush);
  await settleReal(tester, rounds: 6);
}

void main() {
  group('UI-MOB-62 the diary of a day is written on the phone and saved as a draft', () {
    testWidgets('a day with no diary starts empty, and what is typed is kept on the phone as a draft of the contract and the day', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester, date: _day);

      expect(find.text('Chưa có nhật ký'), findsOneWidget);
      expect(find.text('Ngày 03/11/2026'), findsOneWidget);
      await world.typeInto(tester, 'Công việc trong ngày', 'Đào móng trụ T3 và đổ bê tông lót');
      await world.typeInto(tester, 'Hạng mục thi công', 'Đào móng T3\nĐổ bê tông lót\n\n  ');
      await world.typeInto(tester, 'Số nhân lực', '14');
      await world.typeInto(tester, 'Ghi chú', 'Mưa nhẹ buổi chiều');

      final DraftStore store = (await tester.runAsync(() => world.container.read(draftStoreProvider.future)))!;
      final DiaryDraft draft = DiaryDraft.fromJson(store.list(kind: kDiaryDraftKind).single.fields)!;
      expect(draft.contractId, 'c-1');
      expect(draft.recordDate, _day);
      expect(draft.form.summary, 'Đào móng trụ T3 và đổ bê tông lót');
      expect(workItemsOf(draft.form.workItems), <String>['Đào móng T3', 'Đổ bê tông lót']);
      expect(draft.form.workforce, '14');
      expect(world.server.sync.batchPosts, 0, reason: 'nothing is sent by typing');
    });

    testWidgets('a draft is found again when the screen is opened again for the same day', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester, date: _day);
      await world.typeInto(tester, 'Công việc trong ngày', 'Đào móng trụ T3');
      await world.go(tester, '/account/mob-41');
      await world.go(tester, '/projects/mob-62/c-1?date=$_day');
      expect(find.text('Đào móng trụ T3'), findsOneWidget);
    });

    testWidgets('the form says what is missing and does not queue anything', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester, date: _day);
      await world.typeInto(tester, 'Số nhân lực', 'mười');
      await tapText(tester, 'Lưu nhật ký');

      expect(find.text('Cần nhập mục này.'), findsOneWidget);
      expect(find.text('Nhập một số nguyên không âm.'), findsOneWidget);
      expect((await _queue(tester, world)).unsentCount, 0);
    });

    testWidgets('a day that has not come cannot be written', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester, date: '2026-11-04');
      await world.typeInto(tester, 'Công việc trong ngày', 'Kế hoạch');
      await tapText(tester, 'Lưu nhật ký');
      expect(find.text('Không lập nhật ký cho ngày chưa đến.'), findsOneWidget);
      expect((await _queue(tester, world)).unsentCount, 0);
    });

    testWidgets('moves to the day before and the day after, and not past today', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester, date: _day);
      expect(tester.widget<IconButton>(find.widgetWithIcon(IconButton, Icons.chevron_right)).onPressed, isNull, reason: 'there is no tomorrow');
      await tester.tap(find.byTooltip('Ngày trước'));
      await settleReal(tester, rounds: 8);
      expect(find.text('Ngày 02/11/2026'), findsOneWidget);
      expect(world.server.api.callsTo('GET', '/resources/site_diary').last.url.queryParameters, containsPair('from', '2026-11-02'));
      expect(tester.widget<IconButton>(find.widgetWithIcon(IconButton, Icons.chevron_right)).onPressed, isNotNull);
    });
  });

  group('AC-ST-MOB-020-2 UAT-AC358 a diary saved offline and sent three times by retry is one diary', () {
    testWidgets('saved without a network, it is sent when the network is back; answers lost twice, still one diary under one key', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      final FieldWorld world = await _open(tester, server: server, date: _day);
      server.offline = true;
      await world.typeInto(tester, 'Công việc trong ngày', 'Đào móng trụ T3');
      await tapText(tester, 'Lưu nhật ký');
      await waitUntil(tester, () async => find.textContaining('Nhật ký đã được lưu trên máy').evaluate().isNotEmpty || find.text('Diary being sent').evaluate().isNotEmpty || find.text('Nhật ký đang gửi').evaluate().isNotEmpty);
      expect(server.sync.effects, isEmpty, reason: 'nothing reached the server');

      // The network is back, and the answer is lost twice: the phone cannot know whether the server did the work.
      server.offline = false;
      server.sync.dropNextBatchAnswer = true;
      await _flush(tester, world);
      server.sync.dropNextBatchAnswer = true;
      await _flush(tester, world);
      await _flush(tester, world);

      final List<Map<String, Object?>> sent = _appended(world).where((Map<String, Object?> item) => item['command_type'] == kDiaryAppendCommand).toList();
      expect(sent, isNotEmpty);
      final Set<Object?> keys = sent.map((Map<String, Object?> item) => item['idempotency_key']).toSet();
      expect(keys, hasLength(1), reason: 'every send carries the same key');
      expect(server.sync.effectsOf(keys.single! as String), 1, reason: 'one diary, however often it was sent');
      final Set<Object?> operations = sent.map((Map<String, Object?> item) => (item['payload']! as Map<String, Object?>)['client_operation_id']).toSet();
      expect(operations, hasLength(1));
      expect(operations.single, keys.single, reason: 'the identity of the save is its key');
      final Map<String, Object?> payload = sent.first['payload']! as Map<String, Object?>;
      expect(payload['contract_id'], 'c-1');
      expect(payload['record_date'], _day);
      expect((payload['content']! as Map<String, Object?>)['summary'], 'Đào móng trụ T3');
      expect(sent.first['base_server_version'], 0);
    }, timeout: const Timeout(Duration(minutes: 2)));

    testWidgets('the contractor signature, sent again after a lost answer, is one signature', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      final Map<String, Object?> diary = diaryRow('d-1');
      final Set<String> keys = <String>{};
      int calls = 0;
      server.api.answer('POST', '/site-diaries/d-1/contractor-sign', (HttpCall call) {
        calls += 1;
        keys.add(call.headers['idempotency-key']!);
        if (calls == 1) throw const SocketException('the connection was cut after the server did the work');
        return FakeTransport.json(200, <String, Object?>{'operation_id': 'signSiteDiaryByContractor', 'status': 'CONTRACTOR_SIGNED', 'resource_version': 3, 'resource_id': 'd-1'});
      });
      await _open(tester, server: server, diaries: <Map<String, Object?>>[diary], date: _day);

      await tapText(tester, 'Ký nhật ký');
      expect(find.text('Chưa xác định kết quả'), findsOneWidget);
      await tapText(tester, 'Gửi lại cùng thao tác');

      expect(server.api.callsTo('POST', '/site-diaries/d-1/contractor-sign'), hasLength(2));
      expect(keys, hasLength(1), reason: 'one key, so the server holds one signature');
      final HttpCall last = server.api.callsTo('POST', '/site-diaries/d-1/contractor-sign').last;
      expect(last.headers['if-match'], '"2"', reason: 'signed on the version that was read');
      expect(jsonDecode(last.body!), <String, Object?>{'signature_method': 'IN_APP_OTP', 'client_operation_id': keys.single});
      expect(find.text('Máy chủ đã ghi nhận.'), findsOneWidget);
    });

    testWidgets('a second tap on Save is the same command, and a changed text replaces the one that the server has not taken', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      // The server answers that it cannot take the command now: it stays in the queue, under its key, to be tried again.
      server.sync.decide = (Map<String, Object?> item) => const ServerOutcome.transient();
      final FieldWorld world = await _open(tester, server: server, date: _day);
      await world.typeInto(tester, 'Công việc trong ngày', 'Đào móng trụ T3');
      await tapText(tester, 'Lưu nhật ký');
      final CommandQueue queue = await _queue(tester, world);
      await waitUntil(tester, () async => queue.commands().isNotEmpty);
      final String first = queue.commands().single.id;
      await tapText(tester, 'Lưu nhật ký');
      await settleReal(tester, rounds: 8);
      expect(queue.commands().map((QueuedCommand c) => c.id), <String>[first], reason: 'the same text is the same command: nothing was discarded or made again');

      // A changed text replaces the command that has not left the phone: the first is dropped, the change has an identity of its own.
      await world.typeInto(tester, 'Công việc trong ngày', 'Đào móng trụ T3 và T4');
      await tapText(tester, 'Lưu nhật ký');
      await waitUntil(tester, () async => queue.commands().length == 2);
      final List<QueuedCommand> all = queue.commands();
      expect(all.where((QueuedCommand c) => c.state == CommandState.discarded).map((QueuedCommand c) => c.id), <String>[first]);
      final QueuedCommand second = all.singleWhere((QueuedCommand c) => c.id != first);
      expect(second.idempotencyKey, isNot(all.firstWhere((QueuedCommand c) => c.id == first).idempotencyKey));
      // The runner waits for the end of the backoff of the command: stop it, so no timer outlives the test.
      (await tester.runAsync(() => world.container.read(queueRunnerProvider.future)))!.dispose();
    });
  });

  group('UI-MOB-62 AC-ST-MOB-020-2 an edit made after the server took a save is still the person\'s unsent work', () {
    testWidgets('reopened, the text typed after the accepted save is shown and kept', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      final FieldWorld world = await _open(tester, server: server, date: _day);
      await world.typeInto(tester, 'Công việc trong ngày', 'Đào móng trụ T3');
      await tapText(tester, 'Lưu nhật ký');
      final CommandQueue queue = await _queue(tester, world);
      await waitUntil(tester, () async => queue.commands().isNotEmpty);
      final String id = queue.commands().single.id;
      await waitUntil(tester, () async => queue.command(id)!.state == CommandState.accepted);
      await settleReal(tester, rounds: 6);

      // Typed after the save: the draft still carries the command that the server took.
      await world.typeInto(tester, 'Ghi chú', 'Thêm sau khi lưu');
      await world.go(tester, '/account/mob-41');
      await world.go(tester, '/projects/mob-62/c-1?date=$_day');
      await waitUntil(tester, () async => find.widgetWithText(TextField, 'Công việc trong ngày').evaluate().isNotEmpty);
      expect(find.text('Thêm sau khi lưu'), findsOneWidget, reason: 'the newer unsent edit is not replaced by the server form');
      expect(find.text('Đào móng trụ T3'), findsOneWidget);
    });
  });

  group('AC-ST-MOB-020-2 UI-MOB-62 a diary is queued only from the form that was written to the phone', () {
    testWidgets('when the draft can no longer be written, Save queues nothing and says so instead of queueing the older stored diary', (WidgetTester tester) async {
      useDevice(tester, kTall);
      late FailingDiaryService service;
      final FieldWorld world = await _open(tester, date: _day, overrides: <Override>[diaryServiceProvider.overrideWith((Ref ref) => service = FailingDiaryService(ref))]);
      await world.typeInto(tester, 'Công việc trong ngày', 'Đào móng trụ T3');
      service.failing = true;
      await world.typeInto(tester, 'Công việc trong ngày', 'Đào móng trụ T3 và T4');
      await tapText(tester, 'Lưu nhật ký');
      await settleReal(tester, rounds: 6);

      final CommandQueue queue = await _queue(tester, world);
      expect(queue.commands(), isEmpty, reason: 'the stored diary is older than the form');
      expect(find.text('Không lưu được nháp trên điện thoại này. Nội dung đang nhập chưa được giữ lại.'), findsOneWidget);

      service.failing = false;
      await tapText(tester, 'Lưu nhật ký');
      await waitUntil(tester, () async => queue.commands().isNotEmpty);
      await waitUntil(tester, () async => _appended(world).isNotEmpty);
      expect((_appended(world).first['payload']! as Map<String, Object?>)['content'], containsPair('summary', 'Đào móng trụ T3 và T4'));
    });
  });

  group('AC-ST-MOB-020-2 UAT-AC358 a save the server may have taken is never followed by another', () {
    testWidgets('while the answer is not known a second save waits: it could be a second diary', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      final FieldWorld world = await _open(tester, server: server, date: _day);
      server.offline = true;
      await world.typeInto(tester, 'Công việc trong ngày', 'Đào móng trụ T3');
      await tapText(tester, 'Lưu nhật ký');
      final CommandQueue queue = await _queue(tester, world);
      await waitUntil(tester, () async => queue.commands().any((QueuedCommand c) => c.state == CommandState.unknown));
      await world.typeInto(tester, 'Công việc trong ngày', 'Đào móng trụ T3 và T4');
      await tapText(tester, 'Lưu nhật ký');
      await settleReal(tester, rounds: 8);

      expect(find.text('Lần lưu trước chưa được máy chủ xác nhận xong nên chưa lưu thêm được. Xem trạng thái ở hàng đợi.'), findsOneWidget);
      expect(queue.commands(), hasLength(1), reason: 'no second command');
    });
  });

  group('AC-ST-MOB-020-3 UAT-AC366 two editors of one diary: one succeeds, the other is refused with VERSION_CONFLICT and chooses in MOB-42', () {
    testWidgets('the revision on version 2 is refused after the other device saved version 3; both versions are shown and the choice is sent on version 3', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      // The other editor saved version 3 meanwhile.
      server.api.on('GET', '/resources/site_diary/d-1', (_) => diaryRow('d-1', version: 3, content: <String, Object?>{'summary': 'Bản của người sửa trước', 'workforce_count': 12}));
      server.sync.decide = (Map<String, Object?> item) => (item['base_server_version']! as int) < 3 ? const ServerOutcome.conflict(version: 3) : const ServerOutcome.accepted(version: 4);
      final FieldWorld world = await _open(tester, server: server, diaries: <Map<String, Object?>>[diaryRow('d-1')], date: _day);
      server.api.on('GET', '/resources/site_diary/d-1', (_) => diaryRow('d-1', version: 3, content: <String, Object?>{'summary': 'Bản của người sửa trước', 'workforce_count': 12}));

      await world.typeInto(tester, 'Công việc trong ngày', 'Bản của tôi trên máy');
      await tapText(tester, 'Lưu bản sửa của nhật ký');
      await waitUntil(tester, () async => server.sync.batchPosts > 0);
      await settleReal(tester, rounds: 10);

      final CommandQueue queue = await _queue(tester, world);
      final QueuedCommand command = queue.commands().firstWhere((QueuedCommand c) => c.commandType == kDiaryAppendCommand);
      expect(command.state, CommandState.conflict);
      expect(command.baseServerVersion, 2);
      expect((command.payload!)['diary_id'], 'd-1', reason: 'a diary that exists is written over under the version that was read');
      expect(server.sync.effectsOf(command.idempotencyKey), 0);
      expect(find.text('Chọn phiên bản'), findsOneWidget, reason: 'shown beside the diary, with the way to MOB-42');

      await tapText(tester, 'Chọn phiên bản');
      expect(currentLocation(world.container), '/account/mob-42/${command.id}');
      expect(find.text('content.summary'), findsOneWidget);
      expect(find.text('Bản trên máy: Bản của tôi trên máy'), findsOneWidget);
      expect(find.text('Bản trên server: Bản của người sửa trước'), findsOneWidget);
      await tester.ensureVisible(find.byKey(const ValueKey<String>('content.summary:mine')));
      await tester.tap(find.byKey(const ValueKey<String>('content.summary:mine')));
      await settleReal(tester, rounds: 4);
      await tapText(tester, 'Lưu lựa chọn và gửi lại');
      await waitUntil(tester, () async => queue.command(command.id)!.state == CommandState.accepted);

      final QueuedCommand settled = queue.command(command.id)!;
      expect(settled.state, CommandState.accepted);
      expect(settled.baseServerVersion, 3);
      expect(server.sync.effectsOf(settled.idempotencyKey), 1);
    }, timeout: const Timeout(Duration(minutes: 2)));
  });

  group('AC-ST-MOB-020-4 UAT-AC356 a diary the contractor signed cannot be edited; a correction is a new revision', () {
    testWidgets('a signed diary is shown as it was signed, with its signature, and has no form', (WidgetTester tester) async {
      useDevice(tester, kTall);
      await _open(
        tester,
        diaries: <Map<String, Object?>>[diaryRow('d-1', status: 'CONTRACTOR_SIGNED', version: 3, sign: false, revise: false, signatures: <Object?>[signatureRow()])],
        date: _day,
      );
      expect(find.text('Nhà thầu đã ký'), findsWidgets);
      expect(find.text('Đào móng trụ T3'), findsOneWidget);
      expect(find.text('Lưu nhật ký'), findsNothing);
      expect(find.text('Lưu bản sửa của nhật ký'), findsNothing);
      expect(find.widgetWithText(TextField, 'Công việc trong ngày'), findsNothing, reason: 'the content cannot be edited');
      expect(find.textContaining('Nhà thầu: Lê Văn C, Xác nhận trong ứng dụng (OTP)'), findsOneWidget);
      expect(find.text('Nhật ký đã ký nên không sửa được nội dung: mọi thay đổi phải qua một bản điều chỉnh.'), findsOneWidget);
    });

    testWidgets('a signature that is not over the content any more is shown as void', (WidgetTester tester) async {
      useDevice(tester, kTall);
      await _open(tester, diaries: <Map<String, Object?>>[diaryRow('d-1', status: 'CONTRACTOR_SIGNED', sign: false, revise: false, signatures: <Object?>[signatureRow(valid: false)])], date: _day);
      expect(find.textContaining('không còn hiệu lực vì nội dung đã đổi'), findsOneWidget);
    });

    testWidgets('a revision of a signed diary that was queued before it was signed is refused with the reason, not applied', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      server.sync.decide = (Map<String, Object?> item) => const ServerOutcome.rejected('DIARY_STATE_INVALID');
      final FieldWorld world = await _open(tester, server: server, diaries: <Map<String, Object?>>[diaryRow('d-1')], date: _day);
      await world.typeInto(tester, 'Công việc trong ngày', 'Sửa sau khi đã ký ở nơi khác');
      await tapText(tester, 'Lưu bản sửa của nhật ký');
      await waitUntil(tester, () async => server.sync.batchPosts > 0);
      await settleReal(tester, rounds: 10);

      final QueuedCommand command = (await _queue(tester, world)).commands().firstWhere((QueuedCommand c) => c.commandType == kDiaryAppendCommand);
      expect(command.state, CommandState.rejected);
      expect(command.errorCode, 'DIARY_STATE_INVALID');
      expect(server.sync.effectsOf(command.idempotencyKey), 0);
    });

    testWidgets('a correction asks for its reason, is sent online with the reason, and is one revision however often it is sent', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      final Set<String> keys = <String>{};
      int calls = 0;
      server.api.answer('POST', '/site-diaries/d-1/corrections', (HttpCall call) {
        calls += 1;
        keys.add(call.headers['idempotency-key']!);
        if (calls == 1) throw const SocketException('cut');
        return FakeTransport.json(200, <String, Object?>{'operation_id': 'correctSiteDiary', 'status': 'DRAFT', 'resource_version': 1, 'resource_id': 'd-2'});
      });
      await _open(tester, server: server, diaries: <Map<String, Object?>>[diaryRow('d-1', status: 'LOCKED', version: 6, sign: false, revise: false, correct: true, signatures: <Object?>[signatureRow()])], date: _day);

      await tester.ensureVisible(find.text('Gửi bản điều chỉnh'));
      await tester.pump();
      await tester.tap(find.text('Gửi bản điều chỉnh'));
      await settleReal(tester, rounds: 4);
      expect(find.text('Cần nhập mục này.'), findsOneWidget, reason: 'no reason, nothing sent');
      expect(calls, 0);

      await tester.enterText(find.widgetWithText(TextField, 'Công việc trong ngày').last, 'Đào móng trụ T3, sửa số liệu');
      await tester.enterText(find.widgetWithText(TextField, 'Lý do điều chỉnh').last, 'Sai khối lượng bê tông');
      await tapText(tester, 'Gửi bản điều chỉnh');
      expect(find.text('Chưa xác định kết quả'), findsOneWidget);
      await tapText(tester, 'Gửi lại cùng thao tác');

      final List<HttpCall> posts = server.api.callsTo('POST', '/site-diaries/d-1/corrections');
      expect(posts, hasLength(2));
      expect(keys, hasLength(1));
      final Map<String, Object?> body = jsonDecode(posts.last.body!) as Map<String, Object?>;
      expect(body['correction_reason'], 'Sai khối lượng bê tông');
      expect((body['content']! as Map<String, Object?>)['summary'], 'Đào móng trụ T3, sửa số liệu');
      expect(body['client_operation_id'], keys.single);
    });

    testWidgets('edited, saved and signed without leaving the screen, the correction starts from the diary that was signed, not from the text the screen was opened with', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      Map<String, Object?> row = diaryRow('d-1', content: <String, Object?>{'summary': 'Đào móng trụ T3', 'notes': 'Ghi chú cũ', 'workforce_count': 12});
      server.api
        ..on('GET', '/resources/contract/c-1', (_) => contractRow('c-1', 'HD-A-001'))
        ..on('GET', '/resources/site_diary', (_) => page(<Object?>[row]))
        ..on('GET', '/resources/site_diary/d-1', (_) => row);
      // The server takes the save: the diary it shows from then on has the text that was saved.
      server.sync.decide = (Map<String, Object?> item) {
        row = diaryRow('d-1', version: 3, content: <String, Object?>{'summary': 'Đào móng trụ T3 và T4', 'notes': 'Ghi chú mới thêm', 'workforce_count': 12});
        return const ServerOutcome.accepted(version: 3);
      };
      server.api.answer('POST', '/site-diaries/d-1/contractor-sign', (HttpCall call) {
        row = diaryRow('d-1', status: 'LOCKED', version: 4, sign: false, revise: false, correct: true, signatures: <Object?>[signatureRow()], content: <String, Object?>{'summary': 'Đào móng trụ T3 và T4', 'notes': 'Ghi chú mới thêm', 'workforce_count': 12});
        return FakeTransport.json(200, <String, Object?>{'operation_id': 'signSiteDiaryByContractor', 'status': 'CONTRACTOR_SIGNED', 'resource_version': 4, 'resource_id': 'd-1'});
      });
      final FieldWorld world = await _open(tester, server: server, diaries: <Map<String, Object?>>[row], date: _day);
      server.api
        ..on('GET', '/resources/site_diary', (_) => page(<Object?>[row]))
        ..on('GET', '/resources/site_diary/d-1', (_) => row);

      await world.typeInto(tester, 'Công việc trong ngày', 'Đào móng trụ T3 và T4');
      await world.typeInto(tester, 'Ghi chú', 'Ghi chú mới thêm');
      await tapText(tester, 'Lưu bản sửa của nhật ký');
      final CommandQueue queue = await _queue(tester, world);
      await waitUntil(tester, () async => queue.commands().any((QueuedCommand c) => c.state == CommandState.accepted));
      await settleReal(tester, rounds: 8);
      await tapText(tester, 'Ký nhật ký');
      await waitUntil(tester, () async => find.text('Gửi bản điều chỉnh').evaluate().isNotEmpty);

      String shown(String label) => tester.widget<TextField>(find.widgetWithText(TextField, label).last).controller!.text;
      expect(shown('Công việc trong ngày'), 'Đào móng trụ T3 và T4', reason: 'the correction starts from the signed content, not the text of the first reading');
      expect(shown('Ghi chú'), 'Ghi chú mới thêm');

      await tester.enterText(find.widgetWithText(TextField, 'Lý do điều chỉnh').last, 'Sai khối lượng');
      await tapText(tester, 'Gửi bản điều chỉnh');
      final HttpCall sent = server.api.callsTo('POST', '/site-diaries/d-1/corrections').single;
      final Map<String, Object?> content = (jsonDecode(sent.body!) as Map<String, Object?>)['content']! as Map<String, Object?>;
      expect(content['summary'], 'Đào móng trụ T3 và T4', reason: 'a correction sent without a change in the fields does not bring the old text back');
    });

    testWidgets('a refused correction says why with its code', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      server.api.refuse('POST', '/site-diaries/d-1/corrections', 409, 'DIARY_STATE_INVALID');
      await _open(tester, server: server, diaries: <Map<String, Object?>>[diaryRow('d-1', status: 'LOCKED', sign: false, revise: false, correct: true)], date: _day);
      await tester.enterText(find.widgetWithText(TextField, 'Lý do điều chỉnh').last, 'Sai khối lượng');
      await tapText(tester, 'Gửi bản điều chỉnh');
      expect(find.text('Nhật ký không ở trạng thái cho phép thao tác này.'), findsOneWidget);
      expect(find.text('DIARY_STATE_INVALID'), findsOneWidget);
    });

    testWidgets('signing and correcting are not offered without a network, from a copy, or while changes are unsent', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      final FieldWorld world = await _open(tester, server: server, diaries: <Map<String, Object?>>[diaryRow('d-1')], date: _day);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Ký nhật ký')).onPressed, isNotNull);

      server.offline = true;
      await world.typeInto(tester, 'Công việc trong ngày', 'Đã sửa trên máy');
      await tapText(tester, 'Lưu bản sửa của nhật ký');
      await settleReal(tester, rounds: 10);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Ký nhật ký')).onPressed, isNull);
      expect(find.textContaining('Không có mạng hoặc đang xem bản đã lưu'), findsWidgets);
      expect(server.api.callsTo('POST', '/site-diaries/d-1/contractor-sign'), isEmpty, reason: 'no signature from the queue or from a copy');
    });

    testWidgets('a read-only system keeps the save and the signature closed', (WidgetTester tester) async {
      useDevice(tester, kTall);
      await _open(
        tester,
        diaries: <Map<String, Object?>>[diaryRow('d-1')],
        date: _day,
        session: FakeSession(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1', mode: SessionMode.readOnly)),
      );
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Lưu bản sửa của nhật ký')).onPressed, isNull);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Ký nhật ký')).onPressed, isNull);
    });
  });

  group('AC-ST-MOB-020-2 UAT-AC367 the place and the photographs of a diary follow the consent', () {
    testWidgets('without the consent the content carries no place; with it and a position the place goes with geo_consent true', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      final FieldWorld world = await _open(tester, server: server, date: _day);
      server.offline = true;
      await world.typeInto(tester, 'Công việc trong ngày', 'Đào móng trụ T3');
      await tapText(tester, 'Lưu nhật ký');
      final CommandQueue queue = await _queue(tester, world);
      await waitUntil(tester, () async => queue.commands().isNotEmpty);
      Map<String, Object?> content = queue.commands().first.payload!['content']! as Map<String, Object?>;
      expect(content.containsKey('location'), isFalse);
      expect(content.containsKey('geo_consent'), isFalse);

      // A new day, this time with the consent.
      server.offline = false;
      await world.go(tester, '/projects/mob-62/c-1?date=2026-11-02');
      await waitUntil(tester, () async => find.widgetWithText(TextField, 'Công việc trong ngày').evaluate().isNotEmpty);
      server.offline = true;
      await world.typeInto(tester, 'Công việc trong ngày', 'Lắp ván khuôn');
      await tester.tap(find.byType(SwitchListTile));
      await settleReal(tester, rounds: 6);
      await tapText(tester, 'Lấy vị trí hiện tại');
      await waitUntil(tester, () async => world.position.asked == 1);
      await settleReal(tester, rounds: 8);
      await tapText(tester, 'Lưu nhật ký');
      await waitUntil(tester, () async => queue.commands().length == 2);
      content = queue.commands().firstWhere((QueuedCommand c) => c.payload?['record_date'] == '2026-11-02').payload!['content']! as Map<String, Object?>;
      expect(content['geo_consent'], isTrue);
      expect(content['location'], <String, Object?>{'lat': 10.8, 'lng': 106.7, 'accuracy_m': 12.0});
    });

    testWidgets('a position the phone refuses leaves the diary without a place', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester, date: _day);
      world.permissionsPlatform.now[AppPermission.location] = PermissionState.blocked;
      await tester.tap(find.byType(SwitchListTile));
      await settleReal(tester, rounds: 6);
      await tapText(tester, 'Lấy vị trí hiện tại');
      await tapText(tester, 'Để sau');
      expect(find.text('Điện thoại chưa cho phép lấy vị trí. Bản ghi vẫn lưu được không kèm vị trí.'), findsOneWidget);
      expect(world.position.asked, 0);
    });

    testWidgets('the consent taken back is on the phone at once, and the diary cannot be saved until the photographs have lost their place and time', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester, date: _day);
      await world.typeInto(tester, 'Công việc trong ngày', 'Đào móng trụ T3');
      await tester.ensureVisible(find.byType(SwitchListTile));
      await tester.tap(find.byType(SwitchListTile));
      await settleReal(tester, rounds: 6);
      world.photos.gallery = world.file('gate.jpg', geotaggedJpeg());
      await tester.ensureVisible(find.text('Chọn từ thư viện'));
      await tester.pump();
      await tester.tap(find.text('Chọn từ thư viện'));
      await waitUntil(tester, () async => find.textContaining('Dung lượng').evaluate().isNotEmpty);
      await settleReal(tester, rounds: 6);
      final Finder save = find.widgetWithText(FilledButton, 'Lưu nhật ký');
      expect(tester.widget<FilledButton>(save).onPressed, isNotNull);

      await tester.ensureVisible(find.byType(SwitchListTile));
      await tester.tap(find.byType(SwitchListTile));
      await tester.pump();
      // The files are still being rewritten (real input and output has not run).
      expect(tester.widget<SwitchListTile>(find.byType(SwitchListTile)).value, isFalse);
      expect(tester.widget<FilledButton>(save).onPressed, isNull, reason: 'no save while the photographs still say where they were taken');
      final DraftStore store = (await tester.runAsync(() => world.container.read(draftStoreProvider.future)))!;
      expect(DiaryDraft.fromJson(store.list(kind: kDiaryDraftKind).single.fields)!.place.consent, isFalse, reason: 'the withdrawal is already written to the phone');

      await settleReal(tester, rounds: 8);
      expect(tester.widget<FilledButton>(save).onPressed, isNotNull);
      final DiaryDraft after = DiaryDraft.fromJson(store.list(kind: kDiaryDraftKind).single.fields)!;
      expect(readJpegMetadata(File(after.photos.single.path).readAsBytesSync()).carriesPlaceOrTime, isFalse);
      expect(after.form.summary, 'Đào móng trụ T3');
    });

    testWidgets('a photograph taken without the consent is kept for the upload without its place and time', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester, date: _day);
      world.photos.gallery = world.file('gate.jpg', geotaggedJpeg());
      await tester.ensureVisible(find.text('Chọn từ thư viện'));
      await tester.pump();
      await tester.tap(find.text('Chọn từ thư viện'));
      await waitUntil(tester, () async => find.text('Đã xóa vị trí và thời điểm chụp khỏi ảnh').evaluate().isNotEmpty);

      final DraftStore store = (await tester.runAsync(() => world.container.read(draftStoreProvider.future)))!;
      final DiaryDraft draft = DiaryDraft.fromJson(store.list(kind: kDiaryDraftKind).single.fields)!;
      final File kept = File(draft.photos.single.path);
      expect(readJpegMetadata(kept.readAsBytesSync()).carriesPlaceOrTime, isFalse);
      expect(draft.photos.single.sourceHadPlaceOrTime, isTrue);
    });

    testWidgets('AC-ST-MOB-041-1 SEC-03 the file the picker left in the cache is deleted once the photograph is prepared, and also when it is refused', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester, date: _day);
      final File good = world.file('good.jpg', geotaggedJpeg());
      world.photos.gallery = good;
      await tester.ensureVisible(find.text('Chọn từ thư viện'));
      await tester.pump();
      await tester.tap(find.text('Chọn từ thư viện'));
      await waitUntil(tester, () async => find.text('Đã xóa vị trí và thời điểm chụp khỏi ảnh').evaluate().isNotEmpty);
      expect(good.existsSync(), isFalse);

      final File bad = world.file('run.jpg', <int>[0x4D, 0x5A, 0x90, 0x00, 0x03, 0x00]);
      world.photos.gallery = bad;
      await tapText(tester, 'Chọn từ thư viện');
      expect(find.text('FILE_TYPE_NOT_ALLOWED'), findsOneWidget);
      expect(bad.existsSync(), isFalse);
      expect(world.photos.discarded, <String>[good.path, bad.path]);
    });

    testWidgets('a photograph that is not a photograph is refused with its reason before anything is kept', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester, date: _day);
      world.photos.gallery = world.file('run.jpg', <int>[0x4D, 0x5A, 0x90, 0x00, 0x03, 0x00]);
      await tapText(tester, 'Chọn từ thư viện');
      expect(find.text('FILE_TYPE_NOT_ALLOWED'), findsOneWidget);
      expect(world.server.attachments.calls, isEmpty);
    });
  });

  group('AC-ST-MOB-020-6 UI-MOB-62 MOB-62 the states and the contract of the screen', () {
    testWidgets('every state is drawn and the guidelines hold', (WidgetTester tester) async {
      Future<void> open(WidgetTester tester, ScriptedServer server) async {
        await openDiaryApp(tester, FieldWorld.create(server: FieldServer(api: server)), '/projects/mob-62/c-1?date=$_day');
      }

      void healthy(ScriptedServer server) => answerDiaries(FieldServer(api: server), diaries: <Map<String, Object?>>[diaryRow('d-1', signatures: <Object?>[signatureRow()])]);
      await expectEveryState(tester, open: open, script: StateScript(healthy: healthy, content: find.text('Nội dung trong ngày')));
      await expectScreenContract(tester, open: open, healthy: healthy);
    });
  });

  group('AC-ST-MOB-020-2 the rules of the diary', () {
    test('the payload of a new day names the contract and the day; of a diary that exists, the diary and nothing of the day', () {
      const DiaryDraft draft = DiaryDraft(contractId: 'c-1', recordDate: _day, operationId: 'a0000000-0000-4000-8000-000000000001', form: DiaryForm(summary: ' Đào móng '));
      expect(diaryPayload(draft), <String, Object?>{
        'contract_id': 'c-1',
        'record_date': _day,
        'client_operation_id': 'a0000000-0000-4000-8000-000000000001',
        'content': <String, Object?>{'summary': 'Đào móng'},
      });
      final DiaryRecord over = parseDiary(diaryRow('d-1', content: <String, Object?>{'summary': 'Cũ', 'equipment': <Object?>['máy xúc']}))!;
      final Map<String, Object?> revision = diaryPayload(draft, over: over);
      expect(revision.keys, unorderedEquals(<String>['diary_id', 'content', 'client_operation_id']));
      expect((revision['content']! as Map<String, Object?>)['equipment'], <Object?>['máy xúc'], reason: 'what the form cannot show is kept and signed with the rest');
      expect((revision['content']! as Map<String, Object?>)['summary'], 'Đào móng');
    });

    test('an emptied field is taken out of the content, not sent as an empty text', () {
      final Map<String, Object?> content = contentOf(const DiaryForm(summary: 'x'), base: <String, Object?>{'notes': 'cũ', 'weather_code': 'RAIN', 'workforce_count': 3, 'work_items': <Object?>['a']});
      expect(content, <String, Object?>{'summary': 'x'});
    });

    test('the form rules: the day, the summary, the work items, the weather and the workforce', () {
      Map<String, DiaryProblem> check(DiaryForm form, {String day = _day}) => checkDiary(form, recordDate: day, today: _day);
      expect(check(const DiaryForm(summary: 'x')), isEmpty);
      expect(check(const DiaryForm(summary: 'x'), day: '2026-02-30')['date'], DiaryProblem.invalidDay);
      expect(check(const DiaryForm(summary: 'x'), day: 'hôm nay')['date'], DiaryProblem.invalidDay);
      expect(check(const DiaryForm(summary: 'x'), day: '2026-11-04')['date'], DiaryProblem.futureDay);
      expect(check(DiaryForm(summary: 'x' * 8001))['summary'], DiaryProblem.tooLong);
      expect(check(DiaryForm(summary: 'x', notes: 'n' * 8001))['notes'], DiaryProblem.tooLong);
      expect(check(DiaryForm(summary: 'x', workItems: List<String>.generate(51, (int i) => 'item $i').join('\n')))['workItems'], DiaryProblem.tooManyItems);
      expect(check(DiaryForm(summary: 'x', workItems: 'y' * 201))['workItems'], DiaryProblem.tooLong);
      expect(check(const DiaryForm(summary: 'x', weatherCode: 'rainy day'))['weather'], isNotNull);
      expect(check(const DiaryForm(summary: 'x', weatherCode: 'RAIN', workforce: '12'))['workforce'], isNull);
      expect(check(const DiaryForm(summary: 'x', workforce: '-3'))['workforce'], DiaryProblem.invalidNumber);
    });

    test('a diary without what makes it citable is refused as a whole; a superseded one is not the diary of the day', () {
      final Map<String, Object?> good = diaryRow('d-1');
      for (final String missing in <String>['id', 'status', 'record_date', 'version', 'actions', 'contract']) {
        expect(parseDiary(<String, Object?>{...good}..remove(missing)), isNull, reason: missing);
      }
      expect(parseDiary(<String, Object?>{...good, 'status': 'ODD'}), isNull);
      final DiaryDay? day = parseDiaryDay(<String, Object?>{
        'contract': contractRow('c-1', 'HD-A-001'),
        'diaries': <Object?>[diaryRow('d-1', status: 'SUPERSEDED', version: 9), diaryRow('d-2', version: 4), diaryRow('d-3', version: 2)],
      });
      expect(day!.diary!.id, 'd-2', reason: 'the newest that is not set aside');
      expect(parseDiaryDay(<String, Object?>{'contract': contractRow('c-1', 'HD-A-001')}), isNull);
      expect(parseDiaryDay(<String, Object?>{'contract': contractRow('c-1', 'HD-A-001'), 'diaries': <Object?>[]})!.diary, isNull);
    });
  });
}
