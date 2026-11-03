import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/offline/drafts/local_draft.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/offline/queue/queued_command.dart';
import 'package:machvon_mobile/core/state/state_card.dart';
import 'package:machvon_mobile/core/sync/sync_status.dart';

import '../../support/fake_sync_server.dart';
import '../../support/harness.dart';
import '../../support/queue_rig.dart';
import 'offline_harness.dart';

const String reportId = '5b3c0e7a-0a56-4c0e-8c33-0f2f6b7f1a01';

QueuedCommand submit(QueueRig rig, {String report = reportId, int version = 3}) => rig.queue.enqueue(
      commandType: 'report.submit',
      payload: <String, Object?>{'report_id': report},
      baseServerVersion: version,
    );

Future<void> settle(WidgetTester tester) async {
  await tester.pumpAndSettle();
}

/// Taps a button after scrolling it into view (the list is longer than the screen and sits above the tab bar).
Future<void> press(WidgetTester tester, String label) async {
  await tester.ensureVisible(find.text(label));
  await tester.pumpAndSettle();
  await tester.tap(find.text(label));
  await tester.pumpAndSettle();
}

void main() {
  group('AC-ST-MOB-005-1 UAT-AC502 UI-MOB-41 a submit whose answer was lost shows "result unknown", then ACCEPTED, with nothing sent twice', () {
    testWidgets('the connection is cut before the answer; MOB-41 says the result is unknown; the check finds it accepted; the client sent no new command', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final QueueRig rig = await realClockRig();
      final QueuedCommand command = submit(rig);
      await openOfflineApp(tester, rig, location: '/projects/mob-41');
      expect(find.text('Nộp báo cáo'), findsOneWidget);
      expect(find.text('Chờ gửi'), findsOneWidget);

      rig.server.dropNextBatchAnswer = true;
      await press(tester, 'Gửi ngay');
      expect(find.text('Chưa xác định kết quả'), findsOneWidget);
      expect(find.textContaining('không gửi lại thao tác mới'), findsOneWidget);
      expect(rig.queue.command(command.id)!.state, CommandState.unknown);
      expect(find.text('Bạn đang ngoại tuyến'), findsNothing);

      await press(tester, 'Kiểm tra kết quả');
      expect(find.text('Đã gửi'), findsOneWidget);
      expect(find.text('Chưa xác định kết quả'), findsNothing);
      expect(rig.server.batchPosts, 1, reason: 'no new command was sent');
      expect(rig.server.lookups, 1);
      expect(rig.server.effectsOf(command.idempotencyKey), 1, reason: 'the server holds one');
    });
  });

  group('AC-ST-MOB-005-3 UAT-AC358 UI-MOB-41 the queue shows size, state and the reason of each command', () {
    testWidgets('a refused command shows its reason, the guidance and its code; the others are sent; the draft stays', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final QueueRig rig = await realClockRig(server: FakeSyncServer(decide: (Map<String, Object?> item) => item['base_server_version'] == 1 ? const ServerOutcome.rejected('PERIOD_LOCKED') : const ServerOutcome.accepted()));
      submit(rig, version: 1);
      submit(rig, version: 2);
      await openOfflineApp(tester, rig, location: '/projects/mob-41');
      expect(find.textContaining('2 thay đổi chưa gửi xong'), findsOneWidget);
      expect(find.textContaining('Dung lượng chờ gửi:'), findsOneWidget);
      await press(tester, 'Gửi ngay');
      expect(find.text('Bị từ chối'), findsOneWidget);
      expect(find.text('Đã gửi'), findsOneWidget);
      expect(find.textContaining('Kỳ báo cáo đã bị khóa'), findsOneWidget);
      expect(find.textContaining('Bản nháp vẫn được giữ trên máy'), findsOneWidget);
      expect(find.text('Mã lỗi: PERIOD_LOCKED'), findsOneWidget);
      expect(find.text('Gửi lại'), findsOneWidget);
      expect(find.textContaining('Dung lượng'), findsWidgets);
    });

    testWidgets('after the period is reopened, Send again makes a new decision and the command is accepted once', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      bool locked = true;
      final QueueRig rig = await realClockRig(server: FakeSyncServer(decide: (Map<String, Object?> item) => locked ? const ServerOutcome.rejected('PERIOD_LOCKED') : const ServerOutcome.accepted()));
      final QueuedCommand command = submit(rig);
      await openOfflineApp(tester, rig, location: '/projects/mob-41');
      await press(tester, 'Gửi ngay');
      expect(find.text('Bị từ chối'), findsOneWidget);
      locked = false;
      await press(tester, 'Gửi lại');
      expect(find.text('Đã gửi'), findsOneWidget);
      expect(rig.server.effectsOf(rig.queue.command(command.id)!.idempotencyKey), 1);
      expect(rig.server.effectsOf(command.idempotencyKey), 0);
    });

    testWidgets('a queued command can be dropped after a confirmation, and the draft stays on the device', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final QueueRig rig = await realClockRig();
      rig.store.drafts.upsert(const LocalDraft(id: 'draft-1', tenantId: 'tenant-a', userId: 'user-1', kind: 'report', fields: <String, Object?>{'a': 1}, baseServerVersion: 1, status: DraftStatus.editing, createdAt: 1, updatedAt: 1));
      final QueuedCommand command = rig.queue.enqueue(commandType: 'report.draft.save', payload: <String, Object?>{'a': 1}, draftId: 'draft-1');
      await openOfflineApp(tester, rig, location: '/projects/mob-41');
      await press(tester, 'Bỏ');
      expect(find.text('Bỏ thao tác này?'), findsOneWidget);
      await press(tester, 'Giữ lại');
      expect(rig.queue.command(command.id)!.state, CommandState.queued);
      await press(tester, 'Bỏ');
      await press(tester, 'Bỏ thao tác');
      expect(rig.queue.command(command.id)!.state, CommandState.discarded);
      expect(rig.store.drafts.byId('draft-1'), isNotNull);
      expect(find.text('Chưa có dữ liệu'), findsOneWidget, reason: 'nothing is left to show');
    });

    testWidgets('a conflict leads to MOB-42, an unknown command has no Drop button', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final QueueRig rig = await realClockRig(server: FakeSyncServer(decide: (Map<String, Object?> item) => const ServerOutcome.conflict(code: 'DRAFT_VERSION_CONFLICT')));
      final QueuedCommand command = submit(rig);
      final ProviderContainer container = await openOfflineApp(tester, rig, location: '/projects/mob-41');
      await press(tester, 'Gửi ngay');
      expect(find.text('Cần bạn chọn'), findsOneWidget);
      expect(container.read(syncStatusProvider).conflicts, 1, reason: 'the banner is written by the publisher, which runs with the signed-in application');
      await press(tester, 'Xem và chọn');
      expect(currentLocation(container), '/projects/mob-42/${command.id}');

      final QueueRig other = await realClockRig();
      final QueuedCommand lost = submit(other);
      other.server.offline = true;
      await other.queue.flush();
      expect(other.queue.command(lost.id)!.state, CommandState.unknown);
      await openOfflineApp(tester, other, location: '/projects/mob-41');
      expect(find.text('Bỏ'), findsNothing);
      expect(find.text('Kiểm tra kết quả'), findsOneWidget);
    });

    testWidgets('the banner of the shell counts the commands that wait and the conflicts, from the queue', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final QueueRig rig = await realClockRig(server: FakeSyncServer(decide: (Map<String, Object?> item) => item['base_server_version'] == 1 ? const ServerOutcome.conflict() : const ServerOutcome.accepted()));
      submit(rig, version: 2);
      final ProviderContainer container = await openOfflineApp(tester, rig, location: '/projects/mob-41');
      container.read(syncStatusPublisherProvider);
      await settle(tester);
      expect(find.text('1 thay đổi đang chờ gửi'), findsOneWidget);
      submit(rig, report: '5b3c0e7a-0a56-4c0e-8c33-0f2f6b7f1a09', version: 1);
      await settle(tester);
      await press(tester, 'Gửi ngay');
      expect(container.read(syncStatusProvider), const SyncStatus(pendingCommands: 0, conflicts: 1));
      expect(find.text('1 thay đổi cần bạn chọn cách xử lý xung đột'), findsOneWidget);
    });
  });

  group('AC-ST-MOB-005-5 UI-MOB-41 the seven states and the screen contract', () {
    testWidgets('default, empty, loading, error, ended session; offline, denied and expired licence are told above the list', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      // empty
      QueueRig rig = await realClockRig();
      await openOfflineApp(tester, rig, location: '/projects/mob-41');
      expect(find.text('Chưa có dữ liệu'), findsOneWidget, reason: 'empty');

      // default
      rig = await realClockRig();
      submit(rig);
      await openOfflineApp(tester, rig, location: '/projects/mob-41');
      expect(find.text('Nộp báo cáo'), findsOneWidget, reason: 'default');

      // loading: the store is still being opened
      final Gate gate = Gate();
      rig = await realClockRig();
      await openOfflineApp(
        tester,
        rig,
        location: '/projects/mob-41',
        overrides: [localStoreProvider.overrideWith((Ref ref) async {
          await gate.passed;
          return rig.store;
        })],
      );
      expect(find.byType(LoadingView), findsOneWidget, reason: 'loading');
      gate.open();
      await settle(tester);
      expect(find.text('Chưa có dữ liệu'), findsOneWidget);

      // error: the store cannot be opened
      rig = await realClockRig();
      await openOfflineApp(tester, rig, location: '/projects/mob-41', overrides: [localStoreProvider.overrideWith((Ref ref) async => throw StateError('disk'))]);
      expect(find.text('Chưa thể tải dữ liệu'), findsOneWidget, reason: 'error');
      expect(find.text('CLIENT_ERROR'), findsOneWidget);

      // the session ended
      rig = await realClockRig();
      await openOfflineApp(tester, rig, location: '/projects/mob-41', overrides: [localStoreProvider.overrideWith((Ref ref) async => throw const OfflineUnavailable())]);
      expect(find.text('Phiên làm việc đã hết hạn'), findsOneWidget, reason: 'signed out');
      expect(find.text('SESSION_EXPIRED'), findsOneWidget);

      // offline: the list stays, the notice says the changes are kept
      rig = await realClockRig();
      submit(rig);
      final ProviderContainer container = await openOfflineApp(tester, rig, location: '/projects/mob-41');
      container.read(reachabilityProvider.notifier).report(Reachability.offline);
      await settle(tester);
      expect(find.textContaining('Thay đổi được giữ trên máy và gửi khi có mạng'), findsOneWidget, reason: 'offline');
      expect(find.text('Nộp báo cáo'), findsOneWidget);

      // denied: the server refuses the device
      rig = await realClockRig();
      submit(rig);
      await openOfflineApp(tester, rig, location: '/projects/mob-41');
      rig.server.failNext = (status: 403, code: 'SCOPE_DENIED');
      await press(tester, 'Gửi ngay');
      expect(find.textContaining('chưa được phép đồng bộ'), findsOneWidget, reason: 'denied');
      expect(find.text('Nộp báo cáo'), findsOneWidget);

      // expired licence: the server refuses everything with LICENSE_EXPIRED; the data stays
      rig = await realClockRig();
      submit(rig);
      await openOfflineApp(tester, rig, location: '/projects/mob-41');
      rig.server.failNext = (status: 422, code: 'LICENSE_EXPIRED');
      await press(tester, 'Gửi ngay');
      expect(find.textContaining('License đã hết hạn'), findsOneWidget, reason: 'expired');
      expect(find.text('Mã lỗi: LICENSE_EXPIRED'), findsOneWidget);

      // the server failed after it may have started: the notice says the result is looked up later
      rig = await realClockRig();
      submit(rig);
      await openOfflineApp(tester, rig, location: '/projects/mob-41');
      rig.server.failNext = (status: 500, code: 'INTERNAL_ERROR');
      await press(tester, 'Gửi ngay');
      expect(find.textContaining('Máy chủ gặp lỗi'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('in English every text is English, and the state names are the words of the design', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final QueueRig rig = await realClockRig();
      submit(rig);
      rig.server.offline = true;
      await rig.queue.flush();
      await openOfflineApp(tester, rig, location: '/projects/mob-41', locale: const Locale('en'));
      expect(find.text('Send queue'), findsOneWidget);
      expect(find.text('Result unknown'), findsOneWidget);
      expect(find.text('Submit report'), findsOneWidget);
      expect(find.text('Check the result'), findsOneWidget);
    });

    testWidgets('UI-MOB-41 contract: three devices, text at 200 percent, tap targets, labels and contrast', (WidgetTester tester) async {
      await expectScreenContract(tester, (WidgetTester t) async {
        // one command of each kind that has actions: refused, unknown, queued
        final QueueRig rig = await realClockRig(server: FakeSyncServer(decide: (Map<String, Object?> item) => const ServerOutcome.rejected('PERIOD_LOCKED')));
        submit(rig);
        await rig.queue.flush();
        final QueuedCommand lost = rig.queue.enqueue(commandType: 'issue.create', payload: <String, Object?>{'n': 1});
        rig.server.offline = true;
        await rig.queue.flush();
        rig.server.offline = false;
        expect(rig.queue.command(lost.id)!.state, CommandState.unknown);
        rig.queue.enqueue(commandType: 'site_diary.append', payload: <String, Object?>{'n': 2});
        await openOfflineApp(t, rig, location: '/projects/mob-41');
        expect(find.text('Bị từ chối', skipOffstage: false), findsOneWidget);
      });
    });
  });

  test('the payload that is shown as its size is what is sent', () async {
    final QueueRig rig = await realClockRig();
    final QueuedCommand command = rig.queue.enqueue(commandType: 'issue.create', payload: <String, Object?>{'title': 'Sạt lở'});
    expect(command.payloadBytes, utf8.encode(jsonEncode(<String, Object?>{'title': 'Sạt lở'})).length);
  });
}
