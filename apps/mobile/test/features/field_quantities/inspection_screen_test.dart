import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart' show Ref;
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/offline/queue/command_queue.dart';
import 'package:machvon_mobile/core/offline/queue/queued_command.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/features/field_quantities/inspection_commands.dart';
import 'package:machvon_mobile/features/field_quantities/inspection_models.dart';
import 'package:machvon_mobile/features/field_quantities/inspection_service.dart';

import '../../support/fake_sync_server.dart';
import '../../support/harness.dart';
import '../field_evidence/exif_fixtures.dart' show plainJpeg;
import '../field_issues/field_world.dart';
import '../site_diary/diary_fixtures.dart' show DiaryWorldTools;
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'quantity_fixtures.dart';

const String _document = 'a0000000-0000-4000-8000-0000000000d1';

Future<FieldWorld> _open(WidgetTester tester, {FieldServer? server, void Function(FieldServer server)? answers, FakeSession? session, List<Override> overrides = const <Override>[]}) async {
  final FieldServer field = server ?? FieldServer();
  (answers ?? answerInspections)(field);
  final FieldWorld world = FieldWorld.create(server: field);
  await openQuantityApp(tester, world, '/projects/mob-64/c-1', session: session, overrides: overrides);
  return world;
}

Future<void> _tapChip(WidgetTester tester, String label, {int index = 0}) async {
  final Finder chip = find.widgetWithText(ChoiceChip, label).at(index);
  await tester.ensureVisible(chip);
  await tester.pump();
  await tester.tap(chip);
  await settleReal(tester, rounds: 4);
}

Future<CommandQueue> _queue(WidgetTester tester, FieldWorld world) async => (await tester.runAsync(() => world.container.read(commandQueueProvider.future)))!;

void main() {
  group('UI-MOB-64 the result of an inspection is written on the phone', () {
    testWidgets('shows the checklist the inspection was given, item by item, with the overall result to choose', (WidgetTester tester) async {
      useDevice(tester, kTall);
      await _open(tester);
      expect(find.text('Cốt thép đúng chủng loại'), findsOneWidget);
      expect(find.text('Khoảng cách thép đai'), findsOneWidget);
      expect(find.widgetWithText(ChoiceChip, 'Đạt'), findsNWidgets(3), reason: 'two items and the overall result');
      expect(find.text('Trụ T3, km3+200'), findsOneWidget);
      expect(find.text('Đã lên lịch'), findsOneWidget);
    });

    testWidgets('does not go on until every item is answered, the result is chosen and the words are written', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester);
      await tapText(tester, 'Lưu kết quả');
      expect(find.text('Chọn kết quả cho hạng mục này.'), findsNWidgets(2));
      expect(find.text('Cần nhập mục này.'), findsNWidgets(2), reason: 'the overall result and the remark');
      expect((await _queue(tester, world)).unsentCount, 0);
    });

    testWidgets('a pass with a failed item, and a fail with none, contradict themselves and are not sent', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester);
      await _tapChip(tester, 'Không đạt', index: 0);
      await _tapChip(tester, 'Đạt', index: 1);
      await _tapChip(tester, 'Đạt', index: 2);
      await world.typeInto(tester, 'Nhận xét chung', 'Có một hạng mục không đạt');
      await tapText(tester, 'Lưu kết quả');
      expect(find.textContaining('Kết quả chung mâu thuẫn với các hạng mục'), findsOneWidget);
      expect((await _queue(tester, world)).unsentCount, 0);
    });

    testWidgets('a pass with conditions asks for the condition in the note of each failed item', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester);
      await _tapChip(tester, 'Không đạt', index: 0);
      await _tapChip(tester, 'Đạt', index: 1);
      await _tapChip(tester, 'Đạt có điều kiện');
      await world.typeInto(tester, 'Nhận xét chung', 'Đạt với điều kiện thay thép');
      await tapText(tester, 'Lưu kết quả');
      expect(find.text('Cần nhập mục này.'), findsOneWidget, reason: 'the condition of the failed item');
      expect((await _queue(tester, world)).unsentCount, 0);
    });
  });

  group('AC-ST-MOB-021-3 UAT-AC361 an inspection with a failed critical item raises a non-conformance that blocks the acceptance', () {
    testWidgets('the result is saved offline on the version that was read, sent once, and the non-conformance the server raised then blocks the acceptance request with OPEN_CRITICAL_NCR', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      final FieldWorld world = await _open(tester, server: server);
      server.offline = true;
      await _tapChip(tester, 'Không đạt', index: 0);
      await _tapChip(tester, 'Đạt', index: 1);
      await _tapChip(tester, 'Đạt có điều kiện');
      await world.typeInto(tester, 'Ghi chú cho hạng mục Cốt thép đúng chủng loại', 'Phải thay thép phi 16 đúng chủng loại');
      await world.typeInto(tester, 'Nhận xét chung', 'Đạt có điều kiện: thay thép');
      await tapText(tester, 'Lưu kết quả');
      final CommandQueue queue = await _queue(tester, world);
      await waitUntil(tester, () async => queue.commands().isNotEmpty);

      final QueuedCommand command = queue.commands().single;
      expect(command.commandType, kInspectionResultCommand);
      expect(command.baseServerVersion, 3);
      expect(command.payload, <String, Object?>{
        'inspection_id': 'i-1',
        'result': 'CONDITIONAL',
        'result_note': 'Đạt có điều kiện: thay thép',
        'checklist': <Object?>[
          <String, Object?>{'code': 'K1', 'outcome': 'FAIL', 'note': 'Phải thay thép phi 16 đúng chủng loại'},
          <String, Object?>{'code': 'K2', 'outcome': 'PASS'},
        ],
      });
      expect(find.text('Kết quả đang gửi'), findsOneWidget);
      expect(find.text('Lưu kết quả'), findsNothing, reason: 'the form is closed while the result is on its way: another one would be a second result');

      // The network is back: the server records the result and raises the non-conformance (the failed item is critical).
      server.offline = false;
      server.api
        ..on('GET', '/inspections', (_) => page(<Object?>[inspectionRow('i-1', status: 'RESULT_RECORDED', result: 'CONDITIONAL', version: 4)]))
        ..on('GET', '/resources/quality_nonconformance', (_) => page(<Object?>[ncrRow('n-1')]));
      server.sync.decide = (Map<String, Object?> item) => const ServerOutcome.accepted(version: 4);
      await tester.runAsync(queue.flush);
      await tester.runAsync(queue.flush);
      await waitUntil(tester, () async => find.text('Điểm không phù hợp phát sinh').evaluate().isNotEmpty);

      expect(server.sync.effectsOf(command.idempotencyKey), 1);
      expect(find.text('NCR-100: Cốt thép sai chủng loại'), findsOneWidget);
      expect(find.text('Nghiêm trọng'), findsOneWidget);
      expect(find.text('Đang chặn nghiệm thu'), findsOneWidget);

      // The acceptance request is made online and the server refuses it while the critical non-conformance is open.
      server.api.refuse('POST', '/inspections/i-1/quality-acceptances', 422, 'OPEN_CRITICAL_NCR');
      await world.typeInto(tester, 'Số hiệu biên bản', 'BBNT-014');
      await world.typeInto(tester, 'Mã phiên bản tệp của biên bản', _document);
      await tapText(tester, 'Gửi đề nghị nghiệm thu');

      final HttpCall request = server.api.callsTo('POST', '/inspections/i-1/quality-acceptances').single;
      expect(jsonDecode(request.body!), <String, Object?>{'acceptance_scope': 'WORK_ITEM', 'record_no': 'BBNT-014', 'document_version_id': _document});
      expect(find.text('Chưa nghiệm thu được: còn điểm không phù hợp nghiêm trọng chưa đóng. Đóng điểm đó trước.'), findsOneWidget);
      expect(find.text('OPEN_CRITICAL_NCR'), findsOneWidget);
    }, timeout: const Timeout(Duration(minutes: 2)));

    testWidgets('a closed non-conformance no longer blocks, and an acceptance request is one however often it is sent', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      final Set<String> keys = <String>{};
      int calls = 0;
      server.api.answer('POST', '/inspections/i-1/quality-acceptances', (HttpCall call) {
        calls += 1;
        keys.add(call.headers['idempotency-key']!);
        if (calls == 1) throw const SocketException('cut');
        return FakeTransport.json(200, <String, Object?>{'operation_id': 'createQualityAcceptance', 'status': 'DRAFT', 'resource_version': 1, 'resource_id': 'qa-1'});
      });
      final FieldWorld world = await _open(
        tester,
        server: server,
        answers: (FieldServer s) => answerInspections(s, inspections: <Map<String, Object?>>[inspectionRow('i-1', status: 'RESULT_RECORDED', result: 'PASS', type: 'CONSTRUCTION_STAGE')], ncrs: <Map<String, Object?>>[ncrRow('n-1', status: 'CLOSED')]),
      );
      expect(find.text('Đang chặn nghiệm thu'), findsNothing);
      await world.typeInto(tester, 'Số hiệu biên bản', 'BBNT-015');
      await world.typeInto(tester, 'Mã phiên bản tệp của biên bản', _document.toUpperCase());
      await tapText(tester, 'Gửi đề nghị nghiệm thu');
      expect(find.text('Chưa xác định kết quả'), findsOneWidget);
      await tapText(tester, 'Gửi lại cùng thao tác');
      expect(keys, hasLength(1));
      final Map<String, Object?> body = jsonDecode(server.api.callsTo('POST', '/inspections/i-1/quality-acceptances').last.body!) as Map<String, Object?>;
      expect(body['acceptance_scope'], 'STAGE', reason: 'a construction-stage inspection leads to a stage acceptance');
      expect(body['document_version_id'], _document, reason: 'the identifier is written the way the server reads it');
      expect(find.text('Máy chủ đã ghi nhận đề nghị nghiệm thu.'), findsOneWidget);
    });

    testWidgets('the request asks for the minutes and the file, and is not offered without a network or in a read-only system', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      final FieldWorld world = await _open(
        tester,
        server: server,
        answers: (FieldServer s) => answerInspections(s, inspections: <Map<String, Object?>>[inspectionRow('i-1', status: 'RESULT_RECORDED', result: 'CONDITIONAL')]),
      );
      await tapText(tester, 'Gửi đề nghị nghiệm thu');
      expect(find.text('Cần nhập mục này.'), findsNWidgets(2));
      await world.typeInto(tester, 'Mã phiên bản tệp của biên bản', 'not an id');
      await world.typeInto(tester, 'Số hiệu biên bản', 'BB');
      await tapText(tester, 'Gửi đề nghị nghiệm thu');
      expect(find.text('Nhập đúng mã phiên bản tệp.'), findsOneWidget);
      expect(server.api.callsTo('POST', '/inspections/i-1/quality-acceptances'), isEmpty);

      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await settleReal(tester, rounds: 8);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Gửi đề nghị nghiệm thu')).onPressed, isNull);
    });

    testWidgets('a result refused while it waited says why, with the code', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      server.sync.decide = (Map<String, Object?> item) => const ServerOutcome.rejected('INSPECTION_STATE_INVALID');
      final FieldWorld world = await _open(tester, server: server);
      await _tapChip(tester, 'Đạt', index: 0);
      await _tapChip(tester, 'Đạt', index: 1);
      await _tapChip(tester, 'Đạt', index: 2);
      await world.typeInto(tester, 'Nhận xét chung', 'Đạt');
      await tapText(tester, 'Lưu kết quả');
      final CommandQueue queue = await _queue(tester, world);
      await waitUntil(tester, () async => queue.commands().any((QueuedCommand c) => c.state == CommandState.rejected));
      await settleReal(tester, rounds: 8);
      expect(find.text('Đợt kiểm tra không ở trạng thái cho phép thao tác này (có thể đã có người ghi kết quả).'), findsOneWidget);
      expect(find.text('INSPECTION_STATE_INVALID'), findsOneWidget);
    });
  });

  group('AC-ST-MOB-021-3 UI-MOB-64 a result is queued only from the form that was written to the phone', () {
    testWidgets('when the draft can no longer be written, Save queues nothing and says so instead of queueing the older stored result', (WidgetTester tester) async {
      useDevice(tester, kTall);
      late FailingInspectionService service;
      final FieldWorld world = await _open(tester, overrides: <Override>[inspectionServiceProvider.overrideWith((Ref ref) => service = FailingInspectionService(ref))]);
      await _tapChip(tester, 'Đạt', index: 0);
      await _tapChip(tester, 'Đạt', index: 1);
      await _tapChip(tester, 'Đạt', index: 2);
      await world.typeInto(tester, 'Nhận xét chung', 'Đạt, đúng bản vẽ');
      service.failing = true;
      await world.typeInto(tester, 'Nhận xét chung', 'Đạt, đúng bản vẽ và đúng chủng loại');
      await tapText(tester, 'Lưu kết quả');
      await settleReal(tester, rounds: 6);

      final CommandQueue queue = await _queue(tester, world);
      expect(queue.commands(), isEmpty, reason: 'the stored result is older than the form');
      expect(find.text('Không lưu được nháp trên điện thoại này. Nội dung đang nhập chưa được giữ lại.'), findsOneWidget);
      expect(find.text('Lưu kết quả'), findsOneWidget, reason: 'the form stays open');
    });
  });

  group('AC-ST-MOB-021-3 UI-MOB-64 two inspectors of one inspection: the second chooses in MOB-42', () {
    testWidgets('a result based on an older version of the inspection is a conflict, shown item by item with both versions', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      server.sync.decide = (Map<String, Object?> item) => (item['base_server_version']! as int) < 5 ? const ServerOutcome.conflict(version: 5) : const ServerOutcome.accepted(version: 6);
      final FieldWorld world = await _open(tester, server: server);
      final Map<String, Object?> theirs = inspectionRow('i-1', status: 'SCHEDULED', version: 5);
      (theirs['checklist']! as List<Object?>)[0] = <String, Object?>{'code': 'K1', 'label': 'Cốt thép đúng chủng loại', 'outcome': 'PASS', 'note': null};
      server.api.on('GET', '/inspections/i-1', (_) => theirs);

      await _tapChip(tester, 'Không đạt', index: 0);
      await _tapChip(tester, 'Đạt', index: 1);
      await _tapChip(tester, 'Không đạt', index: 2);
      await world.typeInto(tester, 'Nhận xét chung', 'Không đạt: thép sai');
      await tapText(tester, 'Lưu kết quả');
      final CommandQueue queue = await _queue(tester, world);
      await waitUntil(tester, () async => queue.commands().any((QueuedCommand c) => c.state == CommandState.conflict));
      final QueuedCommand command = queue.commands().single;

      await world.go(tester, '/projects/mob-42/${command.id}');
      expect(find.text('Bản trên máy: FAIL'), findsWidgets);
      expect(find.text('Bản trên server: PASS'), findsOneWidget);
      expect(find.byKey(const ValueKey<String>('checklist[K1].outcome:mine')), findsOneWidget, reason: 'the items of the checklist are compared by their code');
      await tapText(tester, 'Giữ bản máy cho các mục không phải tiền');
      await tester.ensureVisible(find.byKey(const ValueKey<String>('checklist[K1].outcome:server')));
      await tester.tap(find.byKey(const ValueKey<String>('checklist[K1].outcome:server')));
      await settleReal(tester, rounds: 4);
      await tapText(tester, 'Lưu lựa chọn và gửi lại');
      await waitUntil(tester, () async => queue.command(command.id)!.state == CommandState.accepted);
      expect(queue.command(command.id)!.baseServerVersion, 5);
      final Map<String, Object?> resent = jsonDecode(server.sync.batches.last.body!) as Map<String, Object?>;
      final Map<String, Object?> payload = ((resent['items']! as List<Object?>).single! as Map<String, Object?>)['payload']! as Map<String, Object?>;
      expect((payload['checklist']! as List<Object?>).first, containsPair('outcome', 'PASS'), reason: 'the item the person took from the server');
      expect(payload['result_note'], 'Không đạt: thép sai', reason: 'what the person kept of their own');
    }, timeout: const Timeout(Duration(minutes: 2)));
  });

  group('AC-ST-MOB-021-1 UAT-AC367 the photographs of an inspection follow the consent', () {
    testWidgets('a photograph without the consent is kept without its place and time and carries the flags of a photograph with no place', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester);
      world.photos.gallery = world.file('wall.jpg', plainJpeg());
      await tester.ensureVisible(find.text('Chọn từ thư viện'));
      await tester.pump();
      await tester.tap(find.text('Chọn từ thư viện'));
      await waitUntil(tester, () async => find.textContaining('Nguồn vị trí của ảnh:').evaluate().isNotEmpty);
      expect(find.text('Nguồn vị trí của ảnh: NONE; đồng ý lưu vị trí: không'), findsOneWidget);
    });
  });

  group('AC-ST-MOB-021-5 UI-MOB-64 MOB-64 the states and the contract of the screen', () {
    testWidgets('every state is drawn and the guidelines hold', (WidgetTester tester) async {
      Future<void> open(WidgetTester tester, ScriptedServer server) async {
        await openQuantityApp(tester, FieldWorld.create(server: FieldServer(api: server)), '/projects/mob-64/c-1');
      }

      void healthy(ScriptedServer server) => answerInspections(FieldServer(api: server), ncrs: <Map<String, Object?>>[ncrRow('n-1')]);
      await expectEveryState(
        tester,
        open: open,
        script: StateScript(
          healthy: healthy,
          content: find.text('Checklist'),
          empty: (ScriptedServer server) => answerInspections(FieldServer(api: server), inspections: <Map<String, Object?>>[]),
        ),
      );
      await expectScreenContract(tester, open: open, healthy: healthy);
    });

    testWidgets('a read-only system keeps the save closed', (WidgetTester tester) async {
      useDevice(tester, kTall);
      await _open(tester, session: FakeSession(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1', mode: SessionMode.readOnly)));
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Lưu kết quả')).onPressed, isNull);
    });

    testWidgets('an inspection that is not open for a result shows what is known of it', (WidgetTester tester) async {
      useDevice(tester, kTall);
      await _open(tester, answers: (FieldServer s) => answerInspections(s, inspections: <Map<String, Object?>>[inspectionRow('i-1', status: 'REQUESTED', record: false)]));
      expect(find.text('Đợt kiểm tra này chưa mở để ghi kết quả.'), findsOneWidget);
      expect(find.text('Lưu kết quả'), findsNothing);
    });
  });

  group('AC-ST-MOB-021-3 the rules of the inspection', () {
    final List<ChecklistItem> items = <ChecklistItem>[const ChecklistItem(code: 'K1', label: 'a'), const ChecklistItem(code: 'K2', label: 'b')];
    ResultForm answered(String first, String second, {String result = 'PASS', String note = 'ok', String firstNote = ''}) => ResultForm(
          answers: <String, ItemAnswer>{'K1': ItemAnswer(outcome: first, note: firstNote), 'K2': ItemAnswer(outcome: second)},
          result: result,
          resultNote: note,
        );

    test('every item is answered once, and the result agrees with the answers', () {
      expect(checkResult(answered('PASS', 'NA'), items), isEmpty);
      expect(checkResult(answered('FAIL', 'PASS', result: 'FAIL'), items), isEmpty);
      expect(checkResult(answered('FAIL', 'PASS', result: 'CONDITIONAL', firstNote: 'thay thép'), items), isEmpty);
      expect(checkResult(const ResultForm(), items).keys, unorderedEquals(<String>['answer:K1', 'answer:K2', 'result', 'resultNote']));
      expect(checkResult(answered('FAIL', 'PASS'), items)['whole'], ResultProblem.contradiction, reason: 'a pass with a failed item');
      expect(checkResult(answered('PASS', 'PASS', result: 'FAIL'), items)['whole'], ResultProblem.contradiction, reason: 'a fail with none');
      expect(checkResult(answered('PASS', 'PASS', result: 'CONDITIONAL'), items)['whole'], ResultProblem.contradiction);
      expect(checkResult(answered('FAIL', 'PASS', result: 'CONDITIONAL'), items)['answer:K1'], ResultProblem.required, reason: 'the condition');
      expect(checkResult(answered('PASS', 'PASS', note: 'x' * 2001), items)['resultNote'], ResultProblem.tooLong);
      expect(checkResult(answered('PASS', 'PASS', firstNote: 'x' * 2001), items)['answer:K1'], ResultProblem.tooLong);
      expect(checkResult(answered('PASS', 'PASS'), const <ChecklistItem>[])['whole'], ResultProblem.noInspection);
    });

    test('the body lists the items in the order of the checklist and leaves a note out when there is none', () {
      final Map<String, Object?> payload = resultPayload('i-1', answered('FAIL', 'NA', result: 'FAIL', firstNote: ' thép sai '), items);
      expect(payload['checklist'], <Object?>[
        <String, Object?>{'code': 'K1', 'outcome': 'FAIL', 'note': 'thép sai'},
        <String, Object?>{'code': 'K2', 'outcome': 'NA'},
      ]);
      expect(ResultForm.fromJson(answered('FAIL', 'NA', firstNote: 'x').toJson()).answerOf('K1').note, 'x');
      expect(ResultForm.fromJson('x').answers, isEmpty);
    });

    test('the acceptance scope follows the kind of inspection, and a request needs a record and a file identifier', () {
      Inspection of(String type) => parseInspection(inspectionRow('i-1', type: type))!;
      expect(of('CONSTRUCTION_STAGE').acceptanceScope, 'STAGE');
      expect(of('PART_ACCEPTANCE').acceptanceScope, 'PART');
      expect(of('COMPLETION').acceptanceScope, 'COMPLETION');
      expect(of('MATERIAL_ENTRY').acceptanceScope, 'WORK_ITEM');
      expect(of('SAFETY').acceptanceScope, 'WORK_ITEM');
      expect(checkRequest(recordNo: '', documentVersionId: '')['record'], RequestProblem.recordRequired);
      expect(checkRequest(recordNo: 'x' * 2001, documentVersionId: _document)['record'], RequestProblem.recordTooLong);
      expect(checkRequest(recordNo: 'a', documentVersionId: 'x')['document'], RequestProblem.documentNotAnIdentifier);
      expect(checkRequest(recordNo: 'a', documentVersionId: _document), isEmpty);
    });

    test('an inspection that passed, or passed with conditions, may lead to an acceptance; the others may not', () {
      expect(parseInspection(inspectionRow('i-1', status: 'RESULT_RECORDED', result: 'PASS'))!.mayRequestAcceptance, isTrue);
      expect(parseInspection(inspectionRow('i-1', status: 'RESULT_RECORDED', result: 'CONDITIONAL'))!.mayRequestAcceptance, isTrue);
      expect(parseInspection(inspectionRow('i-1', status: 'RESULT_RECORDED', result: 'FAIL'))!.mayRequestAcceptance, isFalse);
      expect(parseInspection(inspectionRow('i-1'))!.mayRequestAcceptance, isFalse);
      expect(parseInspection(inspectionRow('i-1', record: false))!.isOpen, isFalse);
      expect(parseInspection(<String, Object?>{'id': 'i'}), isNull);
      expect(parseNonconformance(ncrRow('n-1'))!.isOpen, isTrue);
      expect(parseNonconformance(ncrRow('n-1', status: 'VERIFIED'))!.isOpen, isFalse);
      expect(parseNonconformance(<String, Object?>{'id': 'n'}), isNull);
      expect(parseInspectionContext(<String, Object?>{'contract': contractRow('c-1', 'A')}), isNull);
    });

    test('the refusals of the server are told in the words of the screen', () {
      expect(inspectionRefusalOf('OPEN_CRITICAL_NCR'), InspectionRefusal.openCriticalNcr);
      expect(inspectionRefusalOf('INSPECTION_NOT_PASSED'), InspectionRefusal.notPassed);
      expect(inspectionRefusalOf('INSPECTION_STATE_INVALID'), InspectionRefusal.inspectionState);
      expect(inspectionRefusalOf('CHECKLIST_INCOMPLETE'), InspectionRefusal.checklistIncomplete);
      expect(inspectionRefusalOf('SCOPE_DENIED'), InspectionRefusal.denied);
      expect(inspectionRefusalOf('SOMETHING'), InspectionRefusal.general);
    });
  });
}
