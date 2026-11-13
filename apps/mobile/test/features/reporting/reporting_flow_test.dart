import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/offline/queue/command_queue.dart';
import 'package:machvon_mobile/core/offline/queue/queue_runner.dart';
import 'package:machvon_mobile/core/offline/queue/queued_command.dart';
import 'package:machvon_mobile/features/reporting/data/report_drafts.dart';
import 'package:machvon_mobile/features/reporting/data/submit_flow.dart';
import 'package:machvon_mobile/features/reporting/model/report_form.dart';

import '../../support/harness.dart';
import 'reporting_fixtures.dart';
import 'reporting_harness.dart';

/// R39 flow tests of the weekly report (MUX-3 wave C): the three things that must hold however the screens look. A report sent with no network is
/// one queued `report.submit` command and a receipt, never two; a retry never makes a second command: after a lost answer it carries the key the
/// command already has (the server answers from its receipt), after a refusal it is the same command under a new key (the old key is settled on the
/// server and is kept as superseded), so the server does the work once; and a report that moved on the server is a conflict the person settles on MOB-42, with nothing
/// overwritten. Each runs the real screens on the real encrypted store and queue against the fake server of the harness.

/// A complete draft on the phone and on the server whose save the server has carried out, so that only the submit is left.
Future<String> _savedDraft(WidgetTester tester, ReportingApp app) async {
  await app.open(tester);
  final String id = await newDraft(app, shape: (ReportForm f) => completeForm().copyWith(planVersionId: f.planVersionId));
  final DraftSnapshot written = (await app.drafts).read(id)!;
  final CommandQueue queue = await app.container.read(commandQueueProvider.future);
  final QueuedCommand save = queue.enqueue(commandType: kSaveCommand, payload: written.form.toPayload(written.reportId!), baseServerVersion: written.draft.baseServerVersion, draftId: id);
  await queue.flush();
  expect(queue.command(save.id)!.state, CommandState.accepted);
  return id;
}

Future<String> _unsavedDraft(WidgetTester tester, ReportingApp app) async {
  await app.open(tester);
  return newDraft(app, shape: (ReportForm f) => completeForm().copyWith(planVersionId: f.planVersionId));
}

/// The commands that are the sending itself, whatever their state.
Future<List<QueuedCommand>> _submits(ReportingApp app) async => <QueuedCommand>[
      for (final QueuedCommand command in (await app.container.read(commandQueueProvider.future)).commands())
        if (command.commandType == kSubmitCommand) command,
    ];

void main() {
  group('R39 UI-MOB-20 offline: the report is saved for the network, once', () {
    testWidgets('one queued report.submit command, the receipt with the way to the queue, and a second tap makes no second command', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      final String id = await _savedDraft(tester, app);
      final ProviderContainer container = await app.open(
        tester,
        location: '/projects/mob-20/$id',
        // The runner of the queue is not running: the command stays queued, as it does with no network.
        overrides: <Override>[queueRunnerProvider.overrideWith((Ref ref) async => QueueRunner(await ref.watch(commandQueueProvider.future)))],
      );
      app.server.offline = true;
      container.read(reachabilityProvider.notifier).report(Reachability.offline);
      await tester.pumpAndSettle();

      expect(find.text('Lưu, gửi khi có mạng'), findsOneWidget, reason: 'offline the one action of the bar saves for the network');
      expect(find.text('Nộp báo cáo'), findsNothing);
      expect(find.text('Đang ngoại tuyến. Bản nháp được giữ trên máy và gửi khi có mạng.'), findsOneWidget, reason: 'one strip tells it, not two');

      await press(tester, 'Lưu, gửi khi có mạng');

      final List<QueuedCommand> submits = await _submits(app);
      expect(submits, hasLength(1), reason: 'exactly one report.submit command exists');
      expect(submits.single.state, CommandState.queued);
      expect(find.text('Lệnh nộp đã xếp hàng, sẽ gửi khi có mạng.'), findsOneWidget, reason: 'the receipt');
      expect(find.text('Xem hàng đợi gửi'), findsOneWidget, reason: 'with the way to the queue');
      expect(app.server.sentTypes(), isNot(contains(kSubmitCommand)), reason: 'nothing went to the server');
      expect(app.server.only().submissions, 0);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Lưu, gửi khi có mạng')).onPressed, isNull, reason: 'the bar is locked while the command waits');

      await tester.tap(find.widgetWithText(FilledButton, 'Lưu, gửi khi có mạng'), warnIfMissed: false);
      await tester.pumpAndSettle();
      expect(await _submits(app), hasLength(1), reason: 'a second tap makes no second command');

      await press(tester, 'Xem hàng đợi gửi');
      expect(find.text('Hàng đợi gửi'), findsOneWidget);
      expect(find.text('Chờ gửi'), findsWidgets);
    });
  });

  group('R39 UI-MOB-20 a retry never makes a second command', () {
    testWidgets('after a refusal: Send again resends the same command (no second command) under a new key, because the server settled the old one; one effect', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      final String id = await _savedDraft(tester, app);
      app.server.periodLocked = true;
      await app.open(tester, location: '/projects/mob-20/$id');
      await press(tester, 'Nộp báo cáo');

      expect(find.textContaining('Mã lỗi: PERIOD_LOCKED'), findsOneWidget, reason: 'the refusal is told with its stable code');
      expect(find.text('Gửi lại'), findsOneWidget);
      final QueuedCommand refused = (await _submits(app)).single;
      expect(refused.state, CommandState.rejected);
      final String refusedKey = refused.idempotencyKey;
      expect(app.server.sync.effectsOf(refusedKey), 0, reason: 'a refused command did nothing on the server');

      app.server.periodLocked = false;
      await press(tester, 'Gửi lại');

      expect(find.text('Báo cáo đã được gửi'), findsOneWidget);
      final List<QueuedCommand> after = await _submits(app);
      expect(after, hasLength(1), reason: 'no second command was made by the retry: it is the same command');
      expect(after.single.id, refused.id);
      expect(after.single.supersededKeys, contains(refusedKey), reason: 'the old key is kept as a superseded one, so the settled receipt of the server still answers to it');
      expect(app.server.sync.effectsOf(after.single.idempotencyKey), 1, reason: 'the server did the work once');
      expect(app.server.only().submissions, 1);
    });

    testWidgets('after a lost answer: Check the result asks by the key, makes no second command, and the server holds one submission', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      final String id = await _unsavedDraft(tester, app);
      await app.open(tester, location: '/projects/mob-20/$id');
      app.server.dropSubmitAnswer = true;
      await press(tester, 'Nộp báo cáo');

      expect(find.textContaining('Chưa xác định kết quả'), findsOneWidget);
      final QueuedCommand unknown = (await _submits(app)).single;
      expect(unknown.state, CommandState.unknown);
      final String key = unknown.idempotencyKey;
      expect(app.server.only().submissions, 1, reason: 'the server did the work whose answer was lost');

      await press(tester, 'Kiểm tra kết quả');

      expect(find.text('Báo cáo đã được gửi'), findsOneWidget);
      final List<QueuedCommand> after = await _submits(app);
      expect(after, hasLength(1));
      expect(after.single.idempotencyKey, key);
      expect(app.server.sync.lookups, 1, reason: 'the answer was asked for by the key, not sent again');
      expect(app.server.sync.effectsOf(key), 1);
      expect(app.server.only().submissions, 1);
    });
  });

  group('R39 UI-MOB-20 a report that moved on the server is a conflict the person settles', () {
    testWidgets('the outcome says so with its code and offers the comparison on MOB-42; nothing is overwritten or submitted', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      final String id = await _unsavedDraft(tester, app);
      app.server.only().version = 5;
      final ProviderContainer container = await app.open(tester, location: '/projects/mob-20/$id');
      await press(tester, 'Nộp báo cáo');

      expect(find.textContaining('Báo cáo đã thay đổi trên máy chủ. Hãy so sánh hai bản và chọn'), findsOneWidget);
      expect(find.textContaining('Mã lỗi:'), findsOneWidget);
      final DraftSnapshot kept = (await app.drafts).read(id)!;
      expect(kept.form.construction, '300000000', reason: 'the draft keeps what the person typed');
      expect(app.server.only().submissions, 0);
      expect(app.server.only().form.construction, isNot('300000000'), reason: 'the server copy was not overwritten by the phone');

      await press(tester, 'So sánh hai bản');

      expect(currentLocation(container), contains('/mob-42/'), reason: 'the conflict is settled on MOB-42');
      expect(find.text('So sánh hai bản'), findsWidgets);
      expect(app.server.only().submissions, 0);
      expect(await _submits(app), isEmpty, reason: 'the save conflicted, so the submit was never made');
    });
  });
}
