import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/navigation/route_catalogue.dart' show AppTab;
import 'package:machvon_mobile/core/offline/drafts/conflict_adapter.dart';
import 'package:machvon_mobile/core/offline/drafts/draft_store.dart';
import 'package:machvon_mobile/core/offline/drafts/local_draft.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/offline/queue/queued_command.dart';
import 'package:machvon_mobile/core/state/state_card.dart';
import 'package:machvon_mobile/core/widgets/bottom_nav.dart' show AppBottomNav;

import '../../support/fake_sync_server.dart';
import '../../support/harness.dart';
import '../../support/queue_rig.dart';
import '../../support/report_fixtures.dart';
import 'offline_harness.dart';

/// A device that saved 130,000,000 against version 3 while the other device saved 120,000,000 (version 7): the server
/// answered the command with a conflict, and the command waits in CONFLICT for the person.
Future<({QueueRig rig, QueuedCommand command, LocalDraft draft})> conflictRig() async {
  final FakeSyncServer server = FakeSyncServer(
    decide: (Map<String, Object?> item) =>
        (item['base_server_version']! as int) < 7 ? const ServerOutcome.conflict(code: 'DRAFT_VERSION_CONFLICT', version: 7) : const ServerOutcome.accepted(version: 8),
  )..reports[reportId] = serverView();
  final QueueRig rig = await realClockRig(server: server);
  final LocalDraft draft = DraftStore(rig.store).save(kind: 'report', recordId: reportId, fields: devicePayload(), baseServerVersion: 3);
  final QueuedCommand command = rig.queue.enqueue(commandType: 'report.draft.save', payload: devicePayload(), baseServerVersion: 3, draftId: draft.id);
  await rig.queue.flush();
  expect(rig.queue.command(command.id)!.state, CommandState.conflict);
  return (rig: rig, command: command, draft: draft);
}

Future<void> press(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder);
  await tester.pumpAndSettle();
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

void main() {
  group('AC-ST-MOB-006-1 UAT-AC504 UI-MOB-42 MOB-42 shows both versions and the difference, and does not overwrite the server', () {
    testWidgets('both amounts, the difference, the money mark; the server keeps its figure until the person has decided every item', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ({QueueRig rig, QueuedCommand command, LocalDraft draft}) setup = await conflictRig();
      await openOfflineApp(tester, setup.rig, location: '/account/mob-42/${setup.command.id}');

      expect(find.text('Giá trị xây lắp'), findsOneWidget);
      expect(find.text('Bản trên máy: 130.000.000'), findsOneWidget);
      expect(find.text('Bản trên server: 120.000.000'), findsOneWidget);
      expect(find.text('Chênh lệch (máy trừ server): +10.000.000'), findsOneWidget);
      expect(find.text('Vốn kéo dài, địa phương: Lũy kế giải ngân'), findsOneWidget);
      expect(find.text('Bản trên máy: 65.000.000'), findsOneWidget);
      expect(find.text('Chênh lệch (máy trừ server): -5.000.000'), findsOneWidget);
      expect(find.text('Kết quả thực hiện'), findsOneWidget);
      expect(find.text('Bản trên máy: Done on site and checked'), findsOneWidget);
      expect(find.text('Số tiền (đồng)'), findsNWidgets(2));
      expect(find.text('Còn 3 mục chưa chọn'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.byType(FilledButton)).onPressed, isNull, reason: 'nothing is chosen for the person');

      expect(setup.rig.server.effectsOf(setup.command.idempotencyKey), 0);
      expect(setup.rig.server.reports[reportId]!['progress'], containsPair('construction_vnd', '120000000'));
      expect(setup.rig.store.drafts.byId(setup.draft.id)!.fields, devicePayload(), reason: 'the draft on the device is intact');
    });

    testWidgets('the buttons that choose for many never choose an amount', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ({QueueRig rig, QueuedCommand command, LocalDraft draft}) setup = await conflictRig();
      await openOfflineApp(tester, setup.rig, location: '/account/mob-42/${setup.command.id}');
      await press(tester, find.text('Giữ bản máy cho các mục không phải tiền'));
      expect(find.text('Còn 2 mục chưa chọn'), findsOneWidget, reason: 'the two amounts are still to be decided');
      await press(tester, find.text('Lấy bản server cho các mục không phải tiền'));
      expect(find.text('Còn 2 mục chưa chọn'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.byType(FilledButton)).onPressed, isNull);
    });
  });

  group('AC-ST-MOB-006-3 MOB01 UAT-AC504 the choice is saved: QUEUED on the new base version, accepted once', () {
    testWidgets('each amount decided on its own; the saved command goes out on version 7 with a new key and is accepted once', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ({QueueRig rig, QueuedCommand command, LocalDraft draft}) setup = await conflictRig();
      // the person comes from the queue, where the conflict is listed
      final ProviderContainer container = await openOfflineApp(tester, setup.rig, location: '/account/mob-41');
      await press(tester, find.text('Xem và chọn'));
      expect(currentLocation(container), '/account/mob-42/${setup.command.id}');
      expect(tester.widget<AppBottomNav>(find.byType(AppBottomNav)).selectedIndex, AppTab.account.index, reason: 'the conflict opens in the Cá nhân tab, where the queue is');
      await press(tester, find.byKey(const ValueKey<String>('construction_vnd:server')));
      await press(tester, find.byKey(const ValueKey<String>('funding_lines[CARRYOVER|LOCAL|].cumulative_vnd:mine')));
      await press(tester, find.text('Giữ bản máy cho các mục không phải tiền'));
      expect(find.textContaining('chưa chọn'), findsNothing);

      await press(tester, find.text('Lưu lựa chọn và gửi lại'));
      await tester.pumpAndSettle();
      final QueuedCommand saved = setup.rig.queue.command(setup.command.id)!;
      expect(saved.state, CommandState.accepted, reason: 'the runner sent it as soon as it was saved');
      expect(saved.baseServerVersion, 7);
      expect(saved.idempotencyKey, isNot(setup.command.idempotencyKey));
      expect(setup.rig.server.effectsOf(saved.idempotencyKey), 1);
      expect(setup.rig.server.effectsOf(setup.command.idempotencyKey), 0);
      final Map<String, Object?> sent = setup.rig.store.drafts.byId(setup.draft.id)!.fields;
      expect(sent['construction_vnd'], '120000000', reason: 'the amount the person took from the server');
      expect(((sent['funding_lines']! as List<Object?>).cast<Map<String, Object?>>().firstWhere((Map<String, Object?> l) => l['bucket'] == 'CARRYOVER'))['cumulative_vnd'], '65000000');
      expect(currentLocation(container), '/account/mob-41', reason: 'the person is back on the queue');
      expect(tester.widget<AppBottomNav>(find.byType(AppBottomNav)).selectedIndex, AppTab.account.index, reason: 'and the tab did not change on the way back');
      expect(find.text('Đã gửi'), findsOneWidget);
    });

    testWidgets('a conflict without a difference in the fields the person edited asks only for a confirmation', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final FakeSyncServer server = FakeSyncServer(decide: (Map<String, Object?> item) => (item['base_server_version']! as int) < 7 ? const ServerOutcome.conflict(version: 7) : const ServerOutcome.accepted())
        ..reports[reportId] = serverView();
      final QueueRig rig = await realClockRig(server: server);
      final QueuedCommand command = rig.queue.enqueue(commandType: 'report.submit', payload: <String, Object?>{'report_id': reportId}, baseServerVersion: 3);
      await rig.queue.flush();
      await openOfflineApp(tester, rig, location: '/account/mob-42/${command.id}');
      expect(find.textContaining('không khác nhau'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.byType(FilledButton)).onPressed, isNotNull);
      await press(tester, find.text('Lưu lựa chọn và gửi lại'));
      expect(rig.queue.command(command.id)!.state, CommandState.accepted);
      expect(rig.server.effectsOf(rig.queue.command(command.id)!.idempotencyKey), 1);
    });
  });

  group('AC-ST-MOB-006-4 UI-MOB-42 the states and the screen contract', () {
    testWidgets('loading, error, denied, expired licence, ended session, offline, and a command that is not in conflict', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      // loading: the server copy has not arrived
      final Gate gate = Gate();
      ({QueueRig rig, QueuedCommand command, LocalDraft draft}) setup = await conflictRig();
      final ConflictAdapters slow = ConflictAdapters(<String, ConflictAdapter>{
        'report.draft.save': ConflictAdapter(
          read: (client, command) async {
            await gate.passed;
            return ServerCopy(version: 7, fields: reportDraftFields(serverView()));
          },
          listIdentity: reportConflictAdapter.listIdentity,
          ignore: reportConflictAdapter.ignore,
        ),
      });
      await openOfflineApp(tester, setup.rig, location: '/account/mob-42/${setup.command.id}', overrides: [conflictAdaptersProvider.overrideWithValue(slow)]);
      expect(find.byType(LoadingView), findsOneWidget, reason: 'loading');
      gate.open();
      await tester.pumpAndSettle();
      expect(find.text('Giá trị xây lắp'), findsOneWidget, reason: 'default');

      // the other states come from the answer of the read operation
      final List<({String name, int status, String code, String title})> refusals = <({String name, int status, String code, String title})>[
        (name: 'error', status: 500, code: 'INTERNAL_ERROR', title: 'Chưa thể tải dữ liệu'),
        (name: 'denied', status: 403, code: 'SCOPE_DENIED', title: 'Bạn chưa có quyền truy cập'),
        (name: 'expired licence', status: 403, code: 'LICENSE_EXPIRED', title: 'License đã hết hạn'),
        (name: 'ended session', status: 401, code: 'SESSION_EXPIRED', title: 'Phiên làm việc đã hết hạn'),
      ];
      for (final ({String name, int status, String code, String title}) refusal in refusals) {
        setup = await conflictRig();
        setup.rig.server.failNext = (status: refusal.status, code: refusal.code);
        await openOfflineApp(tester, setup.rig, location: '/account/mob-42/${setup.command.id}');
        expect(find.text(refusal.title), findsOneWidget, reason: refusal.name);
        expect(find.text(refusal.code), findsOneWidget, reason: refusal.name);
        expect(find.text('Thử lại'), findsOneWidget);
      }

      // offline: the copy of the server cannot be read, and the person is told so with a retry
      setup = await conflictRig();
      setup.rig.server.offline = true;
      final ProviderContainer container = await openOfflineApp(tester, setup.rig, location: '/account/mob-42/${setup.command.id}');
      container.read(reachabilityProvider.notifier).report(Reachability.offline);
      await tester.pumpAndSettle();
      expect(find.text('Bạn đang ngoại tuyến'), findsWidgets, reason: 'offline');
      setup.rig.server.offline = false;
      await tester.tap(find.text('Thử lại'));
      await tester.pumpAndSettle();
      expect(find.text('Giá trị xây lắp'), findsOneWidget, reason: 'retry reads the copy again');

      // not in conflict (or no longer in the queue)
      final QueueRig plain = await realClockRig();
      final QueuedCommand queued = plain.queue.enqueue(commandType: 'report.submit', payload: <String, Object?>{'report_id': reportId});
      await openOfflineApp(tester, plain, location: '/account/mob-42/${queued.id}');
      expect(find.text('Chưa có dữ liệu'), findsOneWidget, reason: 'empty');
      await openOfflineApp(tester, plain, location: '/account/mob-42/not-a-command');
      expect(find.text('Chưa có dữ liệu'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('UI-MOB-42 contract: three devices, text at 200 percent, tap targets, labels and contrast', (WidgetTester tester) async {
      await expectScreenContract(tester, (WidgetTester t) async {
        final ({QueueRig rig, QueuedCommand command, LocalDraft draft}) setup = await conflictRig();
        await openOfflineApp(t, setup.rig, location: '/account/mob-42/${setup.command.id}');
        expect(find.text('So sánh hai bản'), findsOneWidget);
      });
    });
  });
}
