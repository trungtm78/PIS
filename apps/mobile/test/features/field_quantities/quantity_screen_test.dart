import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/offline/drafts/draft_store.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/offline/queue/command_queue.dart';
import 'package:machvon_mobile/core/offline/queue/queued_command.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/features/field_evidence/jpeg_metadata.dart';
import 'package:machvon_mobile/features/field_quantities/quantity_commands.dart';
import 'package:machvon_mobile/features/field_quantities/quantity_models.dart';

import '../../support/fake_sync_server.dart';
import '../../support/harness.dart';
import '../field_evidence/exif_fixtures.dart';
import '../field_issues/field_world.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'quantity_fixtures.dart';

Future<FieldWorld> _open(WidgetTester tester, {FieldServer? server, void Function(FieldServer server)? answers, FakeSession? session, String location = '/projects/mob-63/c-1'}) async {
  final FieldServer field = server ?? FieldServer();
  (answers ?? answerQuantities)(field);
  final FieldWorld world = FieldWorld.create(server: field);
  await openQuantityApp(tester, world, location, session: session);
  return world;
}

Future<void> _choose(WidgetTester tester, int dropdown, String option) async {
  await tester.ensureVisible(find.byType(DropdownButtonFormField<String>).at(dropdown));
  await tester.pump();
  await tester.tap(find.byType(DropdownButtonFormField<String>).at(dropdown));
  await tester.pumpAndSettle();
  await tester.tap(find.text(option).last);
  await tester.pumpAndSettle();
}

Future<void> _type(WidgetTester tester, String label, String text) async {
  final Finder field = find.widgetWithText(TextField, label);
  await tester.ensureVisible(field.first);
  await tester.pump();
  await tester.enterText(field.first, text);
  await settleReal(tester, rounds: 4);
}

Future<void> _fill(WidgetTester tester, {String quantity = '120.5', String reference = 'BB-014'}) async {
  await _choose(tester, 0, 'B01 · Đào đất');
  await _choose(tester, 1, '2026-11');
  await _type(tester, 'Khối lượng kỳ này (m3)', quantity);
  await _type(tester, 'Số hiệu hồ sơ', reference);
}

Future<CommandQueue> _queue(WidgetTester tester, FieldWorld world) async => (await tester.runAsync(() => world.container.read(commandQueueProvider.future)))!;

List<Map<String, Object?>> _sent(FieldWorld world) => <Map<String, Object?>>[
      for (final HttpCall batch in world.server.sync.batches)
        for (final Object? item in (jsonDecode(batch.body!) as Map<String, Object?>)['items']! as List<Object?>) item! as Map<String, Object?>,
    ];

void main() {
  group('UI-MOB-63 the quantity is recorded on the phone as a draft', () {
    testWidgets('offers the items that take a quantity, with what is left, and keeps what is typed as a draft of the contract', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester, answers: (FieldServer s) => answerQuantities(s, measurements: <Map<String, Object?>>[measurementRow('m-1', status: 'APPROVED', submit: false)]));

      // B02 has no stable identity for this reader (it comes without boq_item_id), so it cannot be chosen.
      await tester.tap(find.byType(DropdownButtonFormField<String>).at(0));
      await tester.pumpAndSettle();
      expect(find.text('B01 · Đào đất'), findsWidgets);
      expect(find.text('B02 · Bê tông'), findsNothing);
      await tester.tap(find.text('B01 · Đào đất').last);
      await tester.pumpAndSettle();
      expect(find.text('Còn lại: 7.879,5 m3'), findsOneWidget, reason: 'the figure the server gave, in the digits of the language');
      await _choose(tester, 1, '2026-11');
      await _type(tester, 'Khối lượng kỳ này (m3)', '120.5');
      await _type(tester, 'Số hiệu hồ sơ', 'BB-014');

      final DraftStore store = (await tester.runAsync(() => world.container.read(draftStoreProvider.future)))!;
      final QuantityDraft draft = QuantityDraft.fromJson(store.list(kind: kQuantityDraftKind).single.fields)!;
      expect(draft.contractId, 'c-1');
      expect(draft.form.itemLineId, 'l-1');
      expect(draft.form.periodId, 'per-1');
      expect(draft.form.quantity, '120.5');
      expect(draft.form.referenceNo, 'BB-014');
      expect(world.server.sync.batchPosts, 0, reason: 'nothing is sent by typing');
    });

    testWidgets('says what is wrong and queues nothing', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester);
      await tapText(tester, 'Lưu khối lượng');
      expect(find.text('Cần nhập mục này.'), findsNWidgets(4), reason: 'item, period, quantity and reference');
      await _choose(tester, 0, 'B01 · Đào đất');
      await _choose(tester, 1, '2026-11');
      await _type(tester, 'Khối lượng kỳ này (m3)', '1,5');
      await _type(tester, 'Số hiệu hồ sơ', 'BB-014');
      await tapText(tester, 'Lưu khối lượng');
      expect(find.text('Nhập một số, tối đa 6 chữ số thập phân, dùng dấu chấm.'), findsOneWidget);
      await _type(tester, 'Khối lượng kỳ này (m3)', '0.000');
      await tapText(tester, 'Lưu khối lượng');
      expect(find.text('Khối lượng phải lớn hơn 0.'), findsOneWidget);
      expect((await _queue(tester, world)).unsentCount, 0);
    });

    testWidgets('a period that cannot be listed (403) is typed as an identifier, as on the web', (WidgetTester tester) async {
      useDevice(tester, kTall);
      await _open(tester, answers: (FieldServer s) => answerQuantities(s, periods: false));
      expect(find.text('Mã kỳ'), findsOneWidget);
      await _choose(tester, 0, 'B01 · Đào đất');
      await _type(tester, 'Mã kỳ', 'not an id');
      await _type(tester, 'Khối lượng kỳ này (m3)', '5');
      await _type(tester, 'Số hiệu hồ sơ', 'BB-1');
      await tapText(tester, 'Lưu khối lượng');
      expect(find.text('Nhập đúng mã kỳ.'), findsOneWidget);
    });

    testWidgets('a reader who may record no item is told so', (WidgetTester tester) async {
      useDevice(tester, kTall);
      await _open(tester, answers: (FieldServer s) => answerQuantities(s, items: <Map<String, Object?>>[itemRow('l-2', 'B02', recordable: false)]));
      expect(find.text('Hợp đồng chưa có hạng mục nào để ghi khối lượng, hoặc bạn chưa có quyền ghi.'), findsOneWidget);
    });
  });

  group('AC-ST-MOB-021-2 UAT-AC358 a quantity recorded twice with the same key is one measurement', () {
    testWidgets('saved offline and sent again after lost answers, it goes under one key and is carried out once, without an id of the client in the body', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      final FieldWorld world = await _open(tester, server: server);
      server.offline = true;
      await _fill(tester);
      await tapText(tester, 'Lưu khối lượng');
      final CommandQueue queue = await _queue(tester, world);
      await waitUntil(tester, () async => queue.commands().isNotEmpty);
      expect(find.text('Khối lượng đang gửi'), findsOneWidget);
      expect(find.widgetWithText(TextField, 'Số hiệu hồ sơ').evaluate().single.widget is TextField, isTrue);
      expect(tester.widget<TextField>(find.widgetWithText(TextField, 'Số hiệu hồ sơ')).controller!.text, isEmpty, reason: 'the next quantity starts on an empty form');

      server.offline = false;
      server.sync.dropNextBatchAnswer = true;
      await tester.runAsync(queue.flush);
      server.sync.dropNextBatchAnswer = true;
      await tester.runAsync(queue.flush);
      await tester.runAsync(queue.flush);

      final List<Map<String, Object?>> sent = _sent(world).where((Map<String, Object?> item) => item['command_type'] == kMeasurementRecordCommand).toList();
      final Set<Object?> keys = sent.map((Map<String, Object?> item) => item['idempotency_key']).toSet();
      expect(keys, hasLength(1));
      expect(server.sync.effectsOf(keys.single! as String), 1, reason: 'one measurement, however often it was sent');
      final Map<String, Object?> payload = sent.first['payload']! as Map<String, Object?>;
      expect(payload, <String, Object?>{
        'contract_id': 'c-1',
        'contract_revision_id': 'r-1',
        'boq_item_id': 'item-l-1',
        'period_id': 'per-1',
        'quantity_period': '120.5',
        'reference_no': 'BB-014',
        'evidence_refs': <Object?>[],
      });
      expect(sent.first['base_server_version'], 0);
    }, timeout: const Timeout(Duration(minutes: 2)));

    testWidgets('a second tap on Save, after the first, queues nothing more', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      final FieldWorld world = await _open(tester, server: server);
      server.offline = true;
      await _fill(tester);
      await tapText(tester, 'Lưu khối lượng');
      final CommandQueue queue = await _queue(tester, world);
      await waitUntil(tester, () async => queue.commands().isNotEmpty);
      await tapText(tester, 'Lưu khối lượng');
      expect(queue.commands().where((QueuedCommand c) => c.commandType == kMeasurementRecordCommand), hasLength(1));
      expect(find.text('Cần nhập mục này.'), findsWidgets, reason: 'the empty form is not a second record');
    });

    testWidgets('a quantity refused while it waited says why, in words, with the code', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      server.sync.decide = (Map<String, Object?> item) => const ServerOutcome.rejected('QUANTITY_EXCEEDS_BOQ');
      final FieldWorld world = await _open(tester, server: server);
      await _fill(tester, quantity: '9000');
      await tapText(tester, 'Lưu khối lượng');
      final CommandQueue queue = await _queue(tester, world);
      await waitUntil(tester, () async => queue.commands().any((QueuedCommand c) => c.state == CommandState.rejected));
      await settleReal(tester, rounds: 8);
      expect(find.text('Tổng khối lượng vượt khối lượng của hạng mục trong hợp đồng.'), findsOneWidget);
      expect(find.text('QUANTITY_EXCEEDS_BOQ'), findsOneWidget);
    });
  });

  group('AC-ST-MOB-021-2 UAT-AC358 a quantity refused as unverifiable', () {
    testWidgets('comes back with its form when the screen is opened again, and recording it again says why it waits instead of making a second measurement', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      server.sync.decide = (Map<String, Object?> item) => const ServerOutcome.rejected('RESULT_UNVERIFIABLE');
      final FieldWorld world = await _open(tester, server: server);
      await _fill(tester);
      await tapText(tester, 'Lưu khối lượng');
      final CommandQueue first = await _queue(tester, world);
      await waitUntil(tester, () async => first.commands().any((QueuedCommand c) => c.state == CommandState.rejected));
      await settleReal(tester, rounds: 8);

      await openQuantityApp(tester, world, '/projects/mob-63/c-1');
      final CommandQueue queue = await _queue(tester, world);
      expect(find.text('Đã quá 7 ngày nên không xác nhận được kết quả. Kiểm tra hồ sơ trên web trước khi gửi lại.'), findsOneWidget, reason: 'the waiting card says why');
      await tapText(tester, 'Lưu khối lượng');
      await settleReal(tester, rounds: 8);

      expect(find.text('Đã quá 7 ngày nên không xác nhận được kết quả. Kiểm tra hồ sơ trên web trước khi gửi lại.'), findsNWidgets(2), reason: 'the card and the note of the refused save');
      expect(queue.commands().where((QueuedCommand c) => c.commandType == kMeasurementRecordCommand), hasLength(1));
      expect(queue.commands().single.state, CommandState.rejected);
    });
  });

  group('AC-ST-MOB-021-1 UAT-AC367 a photograph with EXIF and no consent to keep the position', () {
    testWidgets('is kept without its place and time, carries gps_source NONE and geo_consent false, and its missing place is a warning only', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      final FieldWorld world = await _open(tester, server: server);
      world.photos.gallery = world.file('wall.jpg', geotaggedJpeg());
      await tester.ensureVisible(find.text('Chọn từ thư viện'));
      await tester.pump();
      await tester.tap(find.text('Chọn từ thư viện'));
      await waitUntil(tester, () async => find.textContaining('Nguồn vị trí của ảnh: NONE').evaluate().isNotEmpty);

      expect(find.text('Nguồn vị trí của ảnh: NONE; đồng ý lưu vị trí: không'), findsOneWidget);
      expect(find.text('Cờ rà soát: ảnh không có vị trí. Chỉ là cảnh báo, ảnh vẫn được gửi.'), findsOneWidget);
      expect(find.text('Cờ rà soát: ảnh không có thời điểm chụp. Chỉ là cảnh báo, ảnh vẫn được gửi.'), findsOneWidget);
      expect(find.text('Đã xóa vị trí và thời điểm chụp khỏi ảnh'), findsOneWidget);

      await _fill(tester);
      server.offline = false;
      await tapText(tester, 'Lưu khối lượng');
      await waitUntil(tester, () async => server.sync.batchPosts > 0, seconds: 20);
      await waitUntil(tester, () async => server.attachments.uploadIds.isNotEmpty && server.attachments.statusOf(server.attachments.uploadIds.first) == 'CLEAN', seconds: 40);
      final Uint8List uploaded = server.attachments.storedBytes(server.attachments.uploadIds.single)!;
      expect(readJpegMetadata(uploaded).carriesPlaceOrTime, isFalse, reason: 'the file that went up says neither where nor when');
      final Map<String, Object?> payload = _sent(world).first['payload']! as Map<String, Object?>;
      expect(payload.keys.where((String key) => key.startsWith('geo') || key.contains('gps')), isEmpty);
    }, timeout: const Timeout(Duration(minutes: 2)));

    testWidgets('with the consent and a position, the place of the photograph is the position of the phone at capture', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester);
      await tester.ensureVisible(find.byType(SwitchListTile));
      await tester.tap(find.byType(SwitchListTile));
      await settleReal(tester, rounds: 6);
      await tapText(tester, 'Lấy vị trí hiện tại');
      await waitUntil(tester, () async => world.position.asked == 1);
      await settleReal(tester, rounds: 8);
      world.photos.gallery = world.file('wall.jpg', plainJpeg());
      await tapText(tester, 'Chọn từ thư viện');
      await waitUntil(tester, () async => find.textContaining('Nguồn vị trí của ảnh:').evaluate().isNotEmpty);

      expect(find.text('Nguồn vị trí của ảnh: DEVICE_AT_CAPTURE; đồng ý lưu vị trí: có'), findsOneWidget);
      expect(find.text('Cờ rà soát: ảnh không có vị trí. Chỉ là cảnh báo, ảnh vẫn được gửi.'), findsNothing);
    });

    testWidgets('a photograph that is not a photograph is refused before anything is kept', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester);
      world.photos.gallery = world.file('run.jpg', <int>[0x4D, 0x5A, 0x90, 0x00, 0x03]);
      await tester.ensureVisible(find.text('Chọn từ thư viện'));
      await tester.pump();
      await tester.tap(find.text('Chọn từ thư viện'));
      await waitUntil(tester, () async => find.text('FILE_TYPE_NOT_ALLOWED').evaluate().isNotEmpty);
      expect(world.server.attachments.calls, isEmpty);
    });
  });

  group('UI-MOB-63 a recorded quantity is sent for approval online', () {
    testWidgets('the quantity is submitted on the version that was read, once however often it is sent, and the refusal is told with its code', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      final Set<String> keys = <String>{};
      int calls = 0;
      server.api.answer('POST', '/measurements/m-1/submit', (HttpCall call) {
        calls += 1;
        keys.add(call.headers['idempotency-key']!);
        if (calls == 1) throw const SocketException('cut');
        return FakeTransport.json(409, <String, Object?>{'type': 'about:blank', 'title': 'x', 'status': 409, 'code': 'EVIDENCE_REQUIRED'});
      });
      await _open(tester, server: server, answers: (FieldServer s) => answerQuantities(s, measurements: <Map<String, Object?>>[measurementRow('m-1', version: 4)]));

      expect(find.text('Khối lượng đã ghi'), findsOneWidget);
      expect(find.text('B01: 120,5 m3, kỳ 2026-11'), findsOneWidget);
      await tapText(tester, 'Gửi duyệt');
      expect(find.text('Chưa xác định kết quả'), findsOneWidget);
      await tapText(tester, 'Gửi lại cùng thao tác');

      expect(keys, hasLength(1));
      expect(server.api.callsTo('POST', '/measurements/m-1/submit').last.headers['if-match'], '"4"');
      expect(find.text('Cần có ít nhất một tệp căn cứ đã quét sạch trước khi gửi duyệt.'), findsOneWidget);
      expect(find.text('EVIDENCE_REQUIRED'), findsOneWidget);
    });

    testWidgets('without a network, or from a copy, or in a read-only system it is not offered', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      final FieldWorld world = await _open(tester, server: server, answers: (FieldServer s) => answerQuantities(s, measurements: <Map<String, Object?>>[measurementRow('m-1')]));
      expect(tester.widget<OutlinedButton>(find.widgetWithText(OutlinedButton, 'Gửi duyệt')).onPressed, isNotNull);
      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await settleReal(tester, rounds: 8);
      expect(tester.widget<OutlinedButton>(find.widgetWithText(OutlinedButton, 'Gửi duyệt')).onPressed, isNull);
      expect(server.api.callsTo('POST', '/measurements/m-1/submit'), isEmpty);
      expect(world.server.sync.batchPosts, 0, reason: 'a submission is never queued');
    });

    testWidgets('a read-only system keeps the save closed', (WidgetTester tester) async {
      useDevice(tester, kTall);
      await _open(tester, session: FakeSession(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1', mode: SessionMode.readOnly)));
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Lưu khối lượng')).onPressed, isNull);
    });
  });

  group('AC-ST-MOB-020-1 UAT-AC365 the quantities of a contract the reader may not open', () {
    testWidgets('are a 404 RESOURCE_NOT_FOUND with its code', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      server.api.refuse('GET', '/resources/contract/c-2', 404, 'RESOURCE_NOT_FOUND');
      final FieldWorld world = FieldWorld.create(server: server);
      await openQuantityApp(tester, world, '/projects/mob-63/c-2');
      expect(find.text('RESOURCE_NOT_FOUND'), findsOneWidget);
      expect(find.text('Lưu khối lượng'), findsNothing);
    });
  });

  group('AC-ST-MOB-021-4 UI-MOB-63 MOB-63 the states and the contract of the screen', () {
    testWidgets('every state is drawn and the guidelines hold', (WidgetTester tester) async {
      Future<void> open(WidgetTester tester, ScriptedServer server) async {
        await openQuantityApp(tester, FieldWorld.create(server: FieldServer(api: server)), '/projects/mob-63/c-1');
      }

      void healthy(ScriptedServer server) => answerQuantities(FieldServer(api: server), measurements: <Map<String, Object?>>[measurementRow('m-1')]);
      await expectEveryState(tester, open: open, script: StateScript(healthy: healthy, content: find.text('Khối lượng đo được')));
      await expectScreenContract(tester, open: open, healthy: healthy);
    });
  });

  group('AC-ST-MOB-021-2 the rules of the quantity', () {
    const QuantityForm good = QuantityForm(itemLineId: 'l-1', periodId: 'per-1', quantity: '120.5', referenceNo: 'BB-014');

    test('the quantity is exact decimal text above zero with at most six decimals', () {
      Map<String, QuantityProblem> check(String quantity) => checkQuantity(good.copyWith(quantity: quantity), periodsKnown: true);
      expect(check('120.5'), isEmpty);
      expect(check('0.000001'), isEmpty);
      expect(check('123456789012345678'), isEmpty);
      expect(check('0')['quantity'], QuantityProblem.notPositive);
      expect(check('0.000')['quantity'], QuantityProblem.notPositive);
      expect(check('')['quantity'], QuantityProblem.required);
      for (final String bad in <String>['1,5', '-3', '1.1234567', '01', '12 5', 'abc', '1e3', '1234567890123456789']) {
        expect(check(bad)['quantity'], QuantityProblem.notAQuantity, reason: bad);
      }
    });

    test('the item, the period and the reference are needed; a typed period must be an identifier', () {
      expect(checkQuantity(const QuantityForm(), periodsKnown: true).keys, unorderedEquals(<String>['item', 'period', 'quantity', 'reference']));
      expect(checkQuantity(good.copyWith(periodId: 'x'), periodsKnown: false)['period'], QuantityProblem.notAnIdentifier);
      expect(checkQuantity(good.copyWith(periodId: 'a0000000-0000-4000-8000-000000000001'), periodsKnown: false), isEmpty);
      expect(checkQuantity(good.copyWith(referenceNo: 'x' * 2001), periodsKnown: true)['reference'], QuantityProblem.tooLong);
      expect(checkQuantity(good.copyWith(overrideReason: 'x' * 2001), periodsKnown: true)['override'], QuantityProblem.tooLong);
    });

    test('the body names the contract and the revision, and says the evidence list is empty; the reason to use a reference again goes only when given', () {
      const BoqItem item = BoqItem(lineId: 'l-1', revisionId: 'r-1', businessKey: 'B01', description: 'Đào đất', unitCode: 'm3', quantity: '8000', itemId: 'item-1');
      final QuantityDraft draft = QuantityDraft(contractId: 'c-1', operationId: 'a0000000-0000-4000-8000-000000000001', form: good.copyWith(periodId: ' PER-1 '));
      expect(measurementPayload(draft, item)['period_id'], 'per-1');
      expect(measurementPayload(draft, item).containsKey('duplicate_override_reason'), isFalse);
      expect(measurementPayload(draft.copyWith(form: good.copyWith(overrideReason: ' Ghi lại ')), item)['duplicate_override_reason'], 'Ghi lại');
    });

    test('lines of a revision that is not in force, and rows without what makes them citable, are not offered', () {
      expect(parseBoqItem(itemRow('l-1', 'B01', revision: 'PENDING')), isNull);
      expect(parseBoqItem(itemRow('l-1', 'B01', quantity: 'many')), isNull);
      expect(parseBoqItem(itemRow('l-1', 'B01'))!.itemId, 'item-l-1');
      expect(parseBoqItem(itemRow('l-1', 'B01', recordable: false))!.itemId, isNull);
      expect(parseBoqItem('x'), isNull);
      expect(parsePeriod(<String, Object?>{'id': 'p'}), isNull);
      expect(parseMeasurement(measurementRow('m-1', status: 'ODD')), isNull);
      expect(parseMeasurement(measurementRow('m-1'))!.canSubmit, isTrue);
      expect(parseQuantityContext(<String, Object?>{'contract': contractRow('c-1', 'A')}), isNull);
    });

    test('a refusal of the server is told in the words of the screen', () {
      expect(refusalOfCode('QUANTITY_EXCEEDS_BOQ'), QuantityRefusal.exceeds);
      expect(refusalOfCode('CUMULATIVE_DECREASE_WITHOUT_CORRECTION'), QuantityRefusal.decrease);
      expect(refusalOfCode('MEASUREMENT_REFERENCE_DUPLICATE'), QuantityRefusal.duplicateReference);
      expect(refusalOfCode('MEASUREMENT_STATE_INVALID', reason: 'PERIOD_ALREADY_MEASURED'), QuantityRefusal.periodTaken);
      expect(refusalOfCode('MEASUREMENT_STATE_INVALID'), QuantityRefusal.measurementState);
      expect(refusalOfCode('EVIDENCE_REQUIRED'), QuantityRefusal.evidenceRequired);
      expect(refusalOfCode('PERIOD_LOCKED'), QuantityRefusal.periodLocked);
      expect(refusalOfCode('SCOPE_DENIED'), QuantityRefusal.denied);
      expect(refusalOfCode('SOMETHING'), QuantityRefusal.general);
    });
  });
}
