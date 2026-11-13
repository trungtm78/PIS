import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/offline/queue/command_queue.dart';
import 'package:machvon_mobile/core/offline/queue/queued_command.dart';
import 'package:machvon_mobile/features/command_support/field_contract.dart';
import 'package:machvon_mobile/features/site_diary/diary_models.dart';

import '../../support/fake_sync_server.dart';
import '../../support/harness.dart';
import '../field_issues/field_world.dart';
import 'diary_fixtures.dart';

const String _day = '2026-11-03';

Future<FieldWorld> _open(WidgetTester tester, {List<Map<String, Object?>> diaries = const <Map<String, Object?>>[], FieldServer? server, String location = '/projects/mob-62/c-1?date=$_day', List<Override> overrides = const <Override>[]}) async {
  final FieldServer field = server ?? FieldServer();
  answerDiaries(field, diaries: diaries);
  field.api.on('GET', '/resources/contract', (_) => page(<Object?>[contractRow('c-1', 'HD-A-001')]));
  final FieldWorld world = FieldWorld.create(server: field);
  await openDiaryApp(tester, world, location, overrides: overrides);
  return world;
}

Future<CommandQueue> _queue(WidgetTester tester, FieldWorld world) async => (await tester.runAsync(() => world.container.read(commandQueueProvider.future)))!;

void main() {
  group('MUX-3C UI-MOB-62 the diary is one column of titled blocks with its action in a sticky bar', () {
    testWidgets('the blocks are titled, the save is in the bar, and the contract is remembered for the quick report', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester);

      for (final String title in <String>['Nội dung trong ngày', 'Thời tiết và nhân lực', 'Ghi chú khác', 'Vị trí viết nhật ký', 'Ảnh hiện trường']) {
        expect(find.text(title), findsOneWidget, reason: title);
      }
      expect(find.widgetWithText(FilledButton, 'Lưu nhật ký'), findsOneWidget);
      await tester.pump();
      expect(world.container.read(lastFieldContractProvider), 'c-1', reason: 'opening the diary makes its contract the one the Report sheet offers');
    });

    testWidgets('the contracts list opened by the quick report for a quantity opens the quantity, not the diary', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester, location: '/projects/mob-61?next=quantity');
      await tester.tap(find.textContaining('HD-A-001').first);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(world.container.read(lastFieldContractProvider), 'c-1');
      expect(find.widgetWithText(FilledButton, 'Lưu nhật ký'), findsNothing, reason: 'the diary form is not what was asked for');
    });

    testWidgets('a number that is not one is said under its field as it is typed, before anything is saved', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester);
      await world.typeInto(tester, 'Số nhân lực', 'mười');
      expect(find.text('Nhập một số nguyên không âm.'), findsOneWidget);
      expect(find.text('Cần nhập mục này.'), findsNothing, reason: 'a field not yet written is not "missing" until the person saves');
      expect(tester.widget<TextField>(find.widgetWithText(TextField, 'Số nhân lực')).keyboardType, TextInputType.number);

      await world.typeInto(tester, 'Số nhân lực', '14');
      expect(find.text('Nhập một số nguyên không âm.'), findsNothing);
    });

    testWidgets('offline the save says so, and the signature stays locked with its reason beside the bar', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester, diaries: <Map<String, Object?>>[diaryRow('d-1')]);
      expect(find.widgetWithText(FilledButton, 'Lưu bản sửa của nhật ký'), findsOneWidget);
      expect(tester.widget<OutlinedButton>(find.widgetWithText(OutlinedButton, 'Ký nhật ký')).onPressed, isNotNull);

      world.container.read(reachabilityProvider.notifier).report(Reachability.offline);
      await tester.pumpAndSettle();
      expect(find.widgetWithText(FilledButton, 'Lưu, gửi khi có mạng'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Lưu, gửi khi có mạng')).onPressed, isNotNull, reason: 'a diary is written offline and sent later');
      expect(tester.widget<OutlinedButton>(find.widgetWithText(OutlinedButton, 'Ký nhật ký')).onPressed, isNull);
      expect(find.textContaining('Không có mạng hoặc đang xem bản đã lưu'), findsWidgets);
    });
  });

  group('MUX-3C R39 the diary saved offline is one queued command and a receipt; a refusal or a lost answer never makes a second one', () {
    testWidgets('saved with no network: one site_diary.append in the queue, the receipt with the way to the queue, nothing sent', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      final FieldWorld world = await _open(tester, server: server);
      server.offline = true;
      world.container.read(reachabilityProvider.notifier).report(Reachability.offline);
      await tester.pumpAndSettle();
      await world.typeInto(tester, 'Công việc trong ngày', 'Đào móng trụ T3');
      await tapText(tester, 'Lưu, gửi khi có mạng');
      final CommandQueue queue = await _queue(tester, world);
      await waitUntil(tester, () async => queue.commands().isNotEmpty);
      await waitUntil(tester, () async => find.text('Đã lưu, sẽ gửi khi có mạng').evaluate().isNotEmpty);

      expect(queue.commands(), hasLength(1));
      expect(queue.commands().single.commandType, kDiaryAppendCommand);
      expect(find.text('Đã lưu, sẽ gửi khi có mạng'), findsOneWidget, reason: 'the receipt');
      expect(find.text('Xem hàng đợi gửi'), findsOneWidget, reason: 'the way to the queue');
      expect(server.sync.effects, isEmpty);
    });

    testWidgets('a save the server refused stays on the screen with its state and code, and saving it again replaces it under a new key', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      server.sync.decide = (Map<String, Object?> item) => const ServerOutcome.rejected('PERIOD_LOCKED');
      final FieldWorld world = await _open(tester, server: server);
      await world.typeInto(tester, 'Công việc trong ngày', 'Đào móng trụ T3');
      await tapText(tester, 'Lưu nhật ký');
      final CommandQueue queue = await _queue(tester, world);
      await waitUntil(tester, () async => queue.commands().any((QueuedCommand c) => c.state == CommandState.rejected));
      await settleReal(tester, rounds: 6);

      expect(find.text('Nhật ký đang gửi'), findsOneWidget, reason: 'the pending row stays beside the form');
      expect(find.text('PERIOD_LOCKED'), findsOneWidget, reason: 'the stable code');
      final String key = queue.commands().single.idempotencyKey;
      // A refusal for good is settled: saving again is a new intention under a new key, and the refused command is dropped, not repeated.
      await tapText(tester, 'Lưu nhật ký');
      await settleReal(tester, rounds: 8);
      final List<QueuedCommand> live = queue.commands().where((QueuedCommand c) => c.state != CommandState.discarded).toList();
      expect(live, hasLength(1), reason: 'one command at a time for the diary of the day');
      expect(live.single.idempotencyKey, isNot(key));
      expect(queue.commands().firstWhere((QueuedCommand c) => c.idempotencyKey == key).state, CommandState.discarded);
      expect(server.sync.effects, isEmpty, reason: 'the server did nothing for either key');
    });

    testWidgets('a conflict shows the way to the choice beside the form', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      server.sync.decide = (Map<String, Object?> item) => const ServerOutcome.conflict(version: 3);
      final FieldWorld world = await _open(tester, server: server, diaries: <Map<String, Object?>>[diaryRow('d-1')]);
      await world.typeInto(tester, 'Công việc trong ngày', 'Bản của tôi');
      await tapText(tester, 'Lưu bản sửa của nhật ký');
      final CommandQueue queue = await _queue(tester, world);
      await waitUntil(tester, () async => queue.commands().any((QueuedCommand c) => c.state == CommandState.conflict));
      await settleReal(tester, rounds: 6);
      expect(find.text('Chọn phiên bản'), findsOneWidget);
      expect(find.text('Mở hàng đợi'), findsOneWidget);
    });
  });
}
