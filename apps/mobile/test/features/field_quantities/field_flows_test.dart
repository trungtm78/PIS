import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart' show HttpCall;
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/offline/queue/command_queue.dart';
import 'package:machvon_mobile/core/offline/queue/queued_command.dart';
import 'package:machvon_mobile/features/command_support/field_contract.dart';
import 'package:machvon_mobile/features/field_quantities/quantity_models.dart';

import '../../support/fake_sync_server.dart';
import '../../support/harness.dart';
import '../field_issues/field_world.dart';
import '../site_diary/diary_fixtures.dart' show DiaryWorldTools;
import 'quantity_fixtures.dart';

/// The flows of the field screens of MOB-63 and MOB-64 that must hold after the redesign (R39): what is recorded without a network is one queued
/// command with its receipt on the screen; a result sent again after a refusal or a lost answer is never a second record; a result that came back
/// in conflict is settled in the queue. They run on the real screens, the real queue and a fake server that counts what it carried out.
Future<FieldWorld> _openQuantity(WidgetTester tester, FieldServer server) async {
  answerQuantities(server);
  final FieldWorld world = FieldWorld.create(server: server);
  await openQuantityApp(tester, world, '/projects/mob-63/c-1');
  return world;
}

Future<FieldWorld> _openInspection(WidgetTester tester, FieldServer server) async {
  answerInspections(server);
  final FieldWorld world = FieldWorld.create(server: server);
  await openQuantityApp(tester, world, '/projects/mob-64/c-1');
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

Future<void> _fillQuantity(WidgetTester tester, FieldWorld world) async {
  await _choose(tester, 0, 'B01 · Đào đất');
  await _choose(tester, 1, '2026-11');
  await world.typeInto(tester, 'Khối lượng kỳ này (m3)', '1234.5');
  await world.typeInto(tester, 'Số hiệu hồ sơ', 'BB-014');
}

Future<void> _tapChip(WidgetTester tester, String label, {int index = 0}) async {
  final Finder chip = find.widgetWithText(ChoiceChip, label).at(index);
  await tester.ensureVisible(chip);
  await tester.pump();
  await tester.tap(chip);
  await settleReal(tester, rounds: 4);
}

/// Fills the checklist of the sample inspection: the first item failed with its condition, the second passed, the result passed with conditions.
Future<void> _fillInspection(WidgetTester tester, FieldWorld world) async {
  await _tapChip(tester, 'Không đạt', index: 0);
  await _tapChip(tester, 'Đạt', index: 1);
  await _tapChip(tester, 'Đạt có điều kiện');
  await world.typeInto(tester, 'Ghi chú cho hạng mục Cốt thép đúng chủng loại', 'Thay thép phi 16');
  await world.typeInto(tester, 'Nhận xét chung', 'Đạt có điều kiện: thay thép');
}

Future<CommandQueue> _queue(WidgetTester tester, FieldWorld world) async => (await tester.runAsync(() => world.container.read(commandQueueProvider.future)))!;

List<QueuedCommand> _live(CommandQueue queue) => queue.commands().where((QueuedCommand command) => command.state != CommandState.discarded).toList();

void main() {
  group('R39 MOB-63 a quantity recorded without a network', () {
    testWidgets('is one queued measurement.record on the phone, the receipt says it will be sent when there is a network, and the bar says the same', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      final FieldWorld world = await _openQuantity(tester, server);
      server.offline = true;
      await _fillQuantity(tester, world);
      await tapText(tester, 'Lưu khối lượng');
      final CommandQueue queue = await _queue(tester, world);
      await waitUntil(tester, () async => queue.commands().isNotEmpty);
      await waitUntil(tester, () async => find.text('Đã lưu, sẽ gửi khi có mạng').evaluate().isNotEmpty);

      final List<QueuedCommand> queued = queue.commands().where((QueuedCommand command) => command.commandType == kMeasurementRecordCommand).toList();
      expect(queued, hasLength(1), reason: 'one record, however often the screen is rebuilt');
      expect(queued.single.payload, containsPair('quantity_period', '1234.5'), reason: 'the text typed is what is sent, unchanged');
      expect(server.sync.effects, isEmpty, reason: 'nothing reached the server');
      expect(find.text('Đã lưu, sẽ gửi khi có mạng'), findsOneWidget, reason: 'the receipt');
      expect(find.widgetWithText(FilledButton, 'Lưu, gửi khi có mạng'), findsOneWidget, reason: 'the bar offers to save for later while there is no network');
      expect(find.text('Khối lượng đang gửi'), findsOneWidget, reason: 'and the record waits in the list of what is on its way');

      await tapText(tester, 'Xem hàng đợi gửi');
      expect(currentLocation(world.container), contains('mob-41'), reason: 'the receipt leads to the queue');
    }, timeout: const Timeout(Duration(minutes: 2)));

    testWidgets('remembers the contract it was opened for, so the quick report sheet takes it', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _openQuantity(tester, FieldServer());
      expect(world.container.read(lastFieldContractProvider), 'c-1');
    });
  });

  group('R39 MOB-64 the result of an inspection is sent again without a second record', () {
    testWidgets('a result whose answer was lost goes under one key, is carried out once, and the screen then shows what the server raised', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      final FieldWorld world = await _openInspection(tester, server);
      server.offline = true;
      await _fillInspection(tester, world);
      await tapText(tester, 'Lưu kết quả');
      final CommandQueue queue = await _queue(tester, world);
      await waitUntil(tester, () async => queue.commands().isNotEmpty);
      expect(find.text('Kết quả đang gửi'), findsOneWidget);
      expect(find.text('Lưu kết quả'), findsNothing, reason: 'the form is closed while the result is on its way: another one would be a second result');

      server.offline = false;
      server.sync.dropNextBatchAnswer = true;
      await tester.runAsync(queue.flush);
      server.sync.dropNextBatchAnswer = true;
      await tester.runAsync(queue.flush);
      await tester.runAsync(queue.flush);

      final Set<Object?> keys = <Object?>{
        for (final HttpCall batch in server.sync.batches)
          for (final Object? item in (jsonDecode(batch.body!) as Map<String, Object?>)['items']! as List<Object?>) (item! as Map<String, Object?>)['idempotency_key'],
      };
      expect(keys, hasLength(1), reason: 'every send was the same intention');
      expect(server.sync.effectsOf(keys.single! as String), 1, reason: 'one result, however often it was sent');
      expect(_live(queue), hasLength(1));
      expect(queue.commands().single.state, CommandState.accepted);
    }, timeout: const Timeout(Duration(minutes: 2)));

    testWidgets('a result the server refused is told with its words, its code and the way to the queue; sending it again there is one more record only once it is accepted', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      int decisions = 0;
      server.sync.decide = (Map<String, Object?> item) {
        decisions += 1;
        return decisions == 1 ? const ServerOutcome.rejected('INSPECTION_STATE_INVALID') : const ServerOutcome.accepted(version: 4);
      };
      final FieldWorld world = await _openInspection(tester, server);
      await _fillInspection(tester, world);
      await tapText(tester, 'Lưu kết quả');
      final CommandQueue queue = await _queue(tester, world);
      await waitUntil(tester, () async => queue.commands().any((QueuedCommand command) => command.state == CommandState.rejected));
      await settleReal(tester, rounds: 8);

      expect(find.text('Đợt kiểm tra không ở trạng thái cho phép thao tác này (có thể đã có người ghi kết quả).'), findsOneWidget);
      expect(find.text('INSPECTION_STATE_INVALID'), findsOneWidget, reason: 'the stable code stays in view');
      expect(find.widgetWithText(OutlinedButton, 'Mở hàng đợi'), findsOneWidget, reason: 'the way to send it again');
      expect(find.text('Lưu kết quả'), findsNothing, reason: 'the form does not come back beside a refused result: a second result would be a second record');

      final QueuedCommand refused = queue.commands().single;
      await tester.runAsync(() => queue.retry(refused.id));
      await settleReal(tester, rounds: 6);
      expect(_live(queue), hasLength(1), reason: 'the retry is the same record, not a second one');
      expect(_live(queue).single.state, CommandState.accepted);
      expect(server.sync.effects.values.fold<int>(0, (int sum, int effects) => sum + effects), 1, reason: 'carried out once');
    }, timeout: const Timeout(Duration(minutes: 2)));

    testWidgets('a result based on an older version of the inspection is a conflict: the screen keeps it in view with its code and leads to the queue to choose', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      server.sync.decide = (Map<String, Object?> item) => const ServerOutcome.conflict(version: 5);
      final FieldWorld world = await _openInspection(tester, server);
      await _fillInspection(tester, world);
      await tapText(tester, 'Lưu kết quả');
      final CommandQueue queue = await _queue(tester, world);
      await waitUntil(tester, () async => queue.commands().any((QueuedCommand command) => command.state == CommandState.conflict));
      await settleReal(tester, rounds: 8);

      expect(find.text('Cần bạn chọn'), findsOneWidget, reason: 'the state of the result, in words');
      expect(find.text('Hồ sơ đã thay đổi ở nơi khác. Hãy xem hai bản và chọn bản giữ lại.'), findsOneWidget);
      expect(find.text('VERSION_CONFLICT'), findsOneWidget);
      expect(_live(queue), hasLength(1));
      await tapText(tester, 'Mở hàng đợi');
      expect(currentLocation(world.container), contains('mob-41'));
    }, timeout: const Timeout(Duration(minutes: 2)));
  });
}
