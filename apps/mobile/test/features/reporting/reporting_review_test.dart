import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/offline/attachments/attachment_upload.dart';
import 'package:machvon_mobile/core/offline/drafts/local_draft.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/offline/queue/command_queue.dart';
import 'package:machvon_mobile/core/offline/queue/queue_runner.dart';
import 'package:machvon_mobile/core/offline/queue/queued_command.dart';
import 'package:machvon_mobile/core/offline/store/local_store.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/core/state/state_card.dart';
import 'package:machvon_mobile/features/reporting/data/report_drafts.dart';
import 'package:machvon_mobile/features/reporting/data/submit_flow.dart';
import 'package:machvon_mobile/features/reporting/model/report_cells.dart';
import 'package:machvon_mobile/features/reporting/model/report_form.dart';
import 'package:machvon_mobile/features/reporting/reporting_feature.dart' as reporting;

import '../../support/harness.dart';
import '../support/screen_contract.dart' as contract;
import '../support/scripted_server.dart';
import 'reporting_fixtures.dart';
import 'reporting_harness.dart';

/// A complete draft on the phone and on the server whose save the server has carried out, so that only the submit is left.
Future<String> savedDraft(WidgetTester tester, ReportingApp app) async {
  await app.open(tester);
  final String id = await newDraft(app, shape: (ReportForm f) => completeForm().copyWith(planVersionId: f.planVersionId));
  final DraftSnapshot written = (await app.drafts).read(id)!;
  final CommandQueue queue = await app.container.read(commandQueueProvider.future);
  final QueuedCommand save = queue.enqueue(commandType: kSaveCommand, payload: written.form.toPayload(written.reportId!), baseServerVersion: written.draft.baseServerVersion, draftId: id);
  await queue.flush();
  expect(queue.command(save.id)!.state, CommandState.accepted);
  return id;
}

Future<String> completeUnsaved(WidgetTester tester, ReportingApp app, {bool onServer = true}) async {
  await app.open(tester);
  return newDraft(app, onServer: onServer, shape: (ReportForm f) => completeForm().copyWith(planVersionId: f.planVersionId));
}

void main() {
  group('AC-ST-MOB-012-4 UAT-PLAN-35 UI-MOB-20 MOB-20 reviews the whole report and sends it as one command', () {
    testWidgets('a complete report has no error; Submit saves the draft, sends the submit and shows the result of the server', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      final String id = await completeUnsaved(tester, app);
      await app.open(tester, location: '/projects/mob-20/$id');

      expect(find.text('Rà soát và gửi báo cáo'), findsOneWidget);
      expect(find.text('Không có.'), findsAtLeastNWidgets(2));
      expect(find.text('Bước 8/8'), findsOneWidget);
      expect(fact('Tổng lũy kế sáu ô', '420 triệu đồng'), findsOneWidget);
      expect(fact('Trong đó CTMTQG (không cộng vào tổng)', '40 triệu đồng'), findsOneWidget);
      expect(fact('Tổng đăng ký tháng sau', '300 triệu đồng'), findsOneWidget);
      expect(find.text('Chưa có kỳ trước để so sánh.'), findsOneWidget);
      expect(find.text('Chưa có thuyết minh.'), findsOneWidget);
      expect(find.text('Chưa có tệp đính kèm.'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Nộp báo cáo')).onPressed, isNotNull);

      await press(tester, 'Nộp báo cáo');

      expect(find.text('Kết quả gửi báo cáo'), findsOneWidget, reason: 'MOB-21 follows the acceptance');
      expect(find.text('Báo cáo đã được gửi'), findsOneWidget);
      expect(app.server.only().submissions, 1);
      expect(app.server.only().status, 'SUBMITTED');
      expect(app.server.sentTypes(), <String>[kSaveCommand, kSubmitCommand]);
      expect((await app.drafts).read(id), isNull, reason: 'the draft is released once the server accepted the report');
      expect(app.server.created, 1);
    });

    testWidgets('what is wrong is listed all at once, each with the step where it is put right; the report cannot be sent until it is fixed', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester);
      final String id = await newDraft(app, shape: (ReportForm f) => completeForm().copyWith(planVersionId: f.planVersionId, preparing: '').withCell(kCells[1], const CellEntry(cumulative: '5', ctmtqg: '9')));
      await app.open(tester, location: '/projects/mob-20/$id');

      expect(find.textContaining('Chưa nhập khối lượng thi công, nghiệm thu'), findsOneWidget);
      expect(find.textContaining('CTMTQG 9 đồng lớn hơn 5 đồng của ô Vốn năm NSĐP'), findsOneWidget);
      expect(find.text('Báo cáo còn lỗi nên chưa gửi được.'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Nộp báo cáo')).onPressed, isNull);
      expect(find.text('Sửa tại bước này'), findsNWidgets(2));
      await press(tester, 'Sửa tại bước này');
      expect(find.text('Nhập vốn năm'), findsOneWidget, reason: 'the first error is the CTMTQG of the year plan');
      expect(app.server.sync.batchPosts, 0);
    });

    testWidgets('the change since the period before is shown for each cell, a fall in words; the warnings do not stop the sending', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      app.server.previous = <String, String>{'CURRENT_YEAR:CENTRAL': '130000000', 'CURRENT_YEAR:LOCAL': '150000000'};
      await app.open(tester);
      final String id = await newDraft(
        app,
        shape: (ReportForm f) => completeForm().copyWith(planVersionId: f.planVersionId, explanation: 'Điều chỉnh sau đối chiếu', construction: '2000000000'),
      );
      await app.open(tester, location: '/projects/mob-20/$id');

      expect(fact('Vốn năm NSTW', '-30 triệu đồng · giảm so với kỳ trước'), findsOneWidget);
      expect(fact('Vốn năm NSĐP', '+50 triệu đồng'), findsOneWidget);
      expect(fact('Kéo dài NSTW', 'Chưa có'), findsOneWidget);
      expect(find.textContaining('Khối lượng thi công 2.000.000.000 đồng bằng 200.0% vốn đã giao'), findsOneWidget);
      expect(find.textContaining('tổng giảm -30.000.000 đồng; đã có giải trình'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Nộp báo cáo')).onPressed, isNotNull);
    });

    testWidgets('the review of the server on the copy it holds is shown beside the phone\'s, with the moment it describes', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      app.server.review = <String, Object?>{
        'blocking': false,
        'errors': <Object?>[],
        'warnings': <Object?>[
          <String, Object?>{'code': 'TREASURY_GAP', 'field': 'funding_lines', 'values': <String, Object?>{'reported_vnd': '420000000', 'treasury_vnd': '400000000', 'gap_pct': '5.0'}},
        ],
      };
      final String id = await completeUnsaved(tester, app);
      await app.open(tester, location: '/projects/mob-20/$id');
      expect(find.text('Máy chủ kiểm tra'), findsOneWidget);
      expect(find.textContaining('Theo bản đã lưu lần gần nhất trên máy chủ, số liệu tại'), findsOneWidget);
      expect(find.text('Lũy kế báo cáo 420.000.000 đồng lệch 5.0% so với 400.000.000 đồng Kho bạc đã thanh toán.'), findsOneWidget);
    });

    testWidgets('the files of the report are counted by state and are said not to be part of what is submitted yet', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      final String id = await completeUnsaved(tester, app);
      final LocalStore store = await app.store;
      AttachmentUpload upload(String name, UploadState state, {String owner = 'report', String? ref}) => AttachmentUpload(
            id: 'u-$name',
            tenantId: store.tenantId,
            userId: store.userId,
            ownerKind: owner,
            ownerRef: ref ?? id,
            fileName: name,
            sourcePath: '/x/$name',
            sizeBytes: 10,
            state: state,
            startKey: 'start-$name-0000000000',
            completeKey: 'complete-$name-00000000',
            createdAt: 1,
            updatedAt: 1,
          );
      store.uploads
        ..upsert(upload('a.pdf', UploadState.clean))
        ..upsert(upload('b.pdf', UploadState.pending))
        ..upsert(upload('c.pdf', UploadState.failed))
        ..upsert(upload('d.pdf', UploadState.cancelled))
        ..upsert(upload('e.pdf', UploadState.clean, ref: 'another-draft'))
        ..upsert(upload('f.pdf', UploadState.clean, owner: 'issue'));
      await app.open(tester, location: '/projects/mob-20/$id', overrides: idleRunners);
      expect(find.text('1 tệp đã tải lên và quét sạch · 1 đang chờ · 1 lỗi'), findsOneWidget);
      expect(find.textContaining('chưa gắn vào nội dung báo cáo được nộp'), findsOneWidget);
      await press(tester, 'Quản lý tệp đính kèm');
      expect(find.text('Tệp đính kèm'), findsWidgets);
      expect(find.text('a.pdf'), findsOneWidget);
      expect(find.text('e.pdf'), findsNothing);
    });
  });

  group('AC-ST-MOB-012-1 UAT-AC502 UI-MOB-20 the connection drops before the answer: "result unknown", then accepted, one report', () {
    testWidgets('MOB-20 says the result is unknown and asks the server by the key of the command; the result then comes without a second command', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      final String id = await completeUnsaved(tester, app);
      await app.open(tester, location: '/projects/mob-20/$id');
      app.server.dropSubmitAnswer = true;
      await press(tester, 'Nộp báo cáo');

      expect(find.textContaining('Chưa xác định kết quả'), findsOneWidget);
      expect(find.textContaining('không gửi lệnh mới'), findsOneWidget);
      expect(app.server.only().submissions, 1, reason: 'the server did the work whose answer was lost');
      final QueuedCommand unknown = (await app.container.read(commandQueueProvider.future)).commands(states: <CommandState>{CommandState.unknown}).single;
      expect(unknown.commandType, kSubmitCommand);
      expect(find.text('Kết quả gửi báo cáo'), findsNothing);

      await press(tester, 'Kiểm tra kết quả');
      expect(find.text('Báo cáo đã được gửi'), findsOneWidget);
      expect(app.server.only().submissions, 1);
      expect(app.server.sync.batchPosts, 2, reason: 'the save and the submit: no command was made a second time');
      expect(app.server.sync.lookups, 1);
      expect(app.server.sync.effectsOf(unknown.idempotencyKey), 1);
    });

    testWidgets('MOB-41 shows the same command as "Chưa xác định kết quả" and nothing else is queued', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      final String id = await completeUnsaved(tester, app);
      await app.open(tester, location: '/projects/mob-20/$id');
      app.server.dropSubmitAnswer = true;
      await press(tester, 'Nộp báo cáo');
      await press(tester, 'Xem hàng đợi gửi');
      expect(find.text('Hàng đợi gửi'), findsOneWidget);
      expect(find.text('Chưa xác định kết quả'), findsOneWidget);
      expect(find.text('Nộp báo cáo'), findsOneWidget);
    });
  });

  group('AC-ST-MOB-012-3 UAT-AC03 UI-MOB-20 a closed period: PERIOD_LOCKED is shown on MOB-20 and the draft is preserved', () {
    testWidgets('the refusal is told in words with its code; every figure is still in the draft; Send again is offered', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      final String id = await savedDraft(tester, app);
      final ReportForm before = (await app.drafts).read(id)!.form;
      app.server.periodLocked = true;
      await app.open(tester, location: '/projects/mob-20/$id');
      await press(tester, 'Nộp báo cáo');

      expect(find.textContaining('Kỳ đã khóa sổ. Chỉ lập hoặc nộp được khi có đề nghị mở lại'), findsOneWidget);
      expect(find.textContaining('Mã lỗi: PERIOD_LOCKED'), findsOneWidget);
      expect(find.textContaining('Bản nháp vẫn được giữ trên máy.'), findsOneWidget);
      expect(find.text('Gửi lại'), findsOneWidget);
      expect(find.text('Kết quả gửi báo cáo'), findsNothing);
      final DraftSnapshot kept = (await app.drafts).read(id)!;
      expect(kept.form, before);
      expect(kept.draft.status, DraftStatus.blocked);
      expect(app.server.only().submissions, 0);

      app.server.periodLocked = false;
      await press(tester, 'Gửi lại');
      expect(find.text('Báo cáo đã được gửi'), findsOneWidget);
      expect(app.server.only().submissions, 1);
    });
  });

  group('REVIEW-r7 UI-MOB-20 Send again after a refusal does not hand in an older copy than the one on the screen', () {
    testWidgets('a draft edited since the refusal is saved first: the server holds the corrections when it holds the submitted report', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      final String id = await savedDraft(tester, app);
      app.server.periodLocked = true;
      final ProviderContainer container = await app.open(tester, location: '/projects/mob-20/$id');
      await press(tester, 'Nộp báo cáo');
      expect(find.text('Gửi lại'), findsOneWidget);

      final ReportDrafts drafts = await app.drafts;
      drafts.writeForm(id, drafts.read(id)!.form.copyWith(results: 'Đã sửa sau khi bị từ chối'));
      final CommandQueue queue = (await tester.runAsync(() => container.read(commandQueueProvider.future)))!;
      queue.enqueue(commandType: 'x.refresh', payload: <String, Object?>{}); // announces the change to the screen
      await tester.pumpAndSettle();

      app.server.periodLocked = false;
      await press(tester, 'Gửi lại');
      expect(find.text('Báo cáo đã được gửi'), findsOneWidget);
      expect(app.server.only().submissions, 1);
      expect(app.server.only().form.results, 'Đã sửa sau khi bị từ chối', reason: 'the corrections reached the server before the report was handed in');
    });
  });

  group('REVIEW-m1-2 UI-MOB-20 a submit whose result cannot be verified is not sent again', () {
    testWidgets('the screen says so, offers the queue and no Send again, and the command keeps its key', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      final String id = await savedDraft(tester, app);
      app.server.periodLocked = true;
      final ProviderContainer container = await app.open(tester, location: '/projects/mob-20/$id');
      await press(tester, 'Nộp báo cáo');
      expect(find.text('Gửi lại'), findsOneWidget, reason: 'an ordinary refusal can be sent again');

      final CommandQueue queue = (await tester.runAsync(() => container.read(commandQueueProvider.future)))!;
      final LocalStore store = (await tester.runAsync(() => container.read(localStoreProvider.future)))!;
      final QueuedCommand refused = queue.commands(states: <CommandState>{CommandState.rejected}).single;
      store.commands.update(refused.id, (QueuedCommand c) => c.copyWith(errorCode: 'RESULT_UNVERIFIABLE'));
      queue.enqueue(commandType: 'x.refresh', payload: <String, Object?>{}); // announces the change to the screen
      await tester.pumpAndSettle();

      expect(find.text('Gửi lại'), findsNothing);
      expect(find.textContaining('Kiểm tra hồ sơ trên web trước khi gửi lại'), findsOneWidget);
      expect(find.text('Xem hàng đợi gửi'), findsOneWidget);
      expect(queue.command(refused.id)!.idempotencyKey, refused.idempotencyKey);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Nộp báo cáo')).onPressed, isNull, reason: 'a new submit would discard the one that may have been carried out: only the queue decides');
    });
  });

  group('AC-ST-MOB-012-1 UI-MOB-20 offline, the command is queued and sent when the network is back', () {
    testWidgets('while the runner of the queue is not running the submit waits as queued; Send now sends it once the network is back', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      final String id = await savedDraft(tester, app);
      final ProviderContainer container = await app.open(
        tester,
        location: '/projects/mob-20/$id',
        overrides: <Override>[queueRunnerProvider.overrideWith((Ref ref) async => QueueRunner(await ref.watch(commandQueueProvider.future)))],
      );
      app.server.offline = true;
      container.read(reachabilityProvider.notifier).report(Reachability.offline);
      await tester.pumpAndSettle();
      expect(find.text('Đang ngoại tuyến: lệnh nộp sẽ được xếp hàng và gửi khi có mạng.'), findsOneWidget);

      await press(tester, 'Nộp báo cáo');
      expect(find.text('Lệnh nộp đã xếp hàng, sẽ gửi khi có mạng.'), findsOneWidget);
      expect(app.server.only().submissions, 0);
      expect(app.server.sync.batchPosts, 1, reason: 'only the save went before');
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Nộp báo cáo')).onPressed, isNull, reason: 'the report cannot be sent twice while its command waits');

      app.server.offline = false;
      await press(tester, 'Gửi ngay');
      expect(find.text('Báo cáo đã được gửi'), findsOneWidget);
      expect(app.server.only().submissions, 1);
    });

    testWidgets('with the runner running, a submit made with no network is looked up and sent by itself when the network is back, once', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      final String id = await savedDraft(tester, app);
      final ProviderContainer container = await app.open(tester, location: '/projects/mob-20/$id');
      app.server.offline = true;
      container.read(reachabilityProvider.notifier).report(Reachability.offline);
      await tester.pumpAndSettle();
      await press(tester, 'Nộp báo cáo');
      expect(find.textContaining('Chưa xác định kết quả'), findsOneWidget);
      expect(app.server.only().submissions, 0);

      app.server.offline = false;
      container.read(reachabilityProvider.notifier).report(Reachability.online);
      await tester.pumpAndSettle();
      expect(find.text('Báo cáo đã được gửi'), findsOneWidget);
      expect(app.server.only().submissions, 1);
      expect(app.server.sync.lookups, greaterThanOrEqualTo(1));
      expect(app.server.sync.effectsOf((await container.read(commandQueueProvider.future)).commands(states: <CommandState>{CommandState.accepted}).last.idempotencyKey), 1);
    });

    testWidgets('a report that is not on the server yet needs a network once; the draft is kept and nothing is queued', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      final String id = await completeUnsaved(tester, app, onServer: false);
      app.server.offline = true;
      await app.open(tester, location: '/projects/mob-20/$id');
      await press(tester, 'Nộp báo cáo');
      expect(find.textContaining('cần kết nối mạng một lần để tạo'), findsOneWidget);
      expect((await app.container.read(commandQueueProvider.future)).commands(), isEmpty);
      expect((await app.drafts).read(id)!.form, isNotNull);
      app.server.offline = false;
      await press(tester, 'Nộp báo cáo');
      expect(find.text('Báo cáo đã được gửi'), findsOneWidget);
      expect(app.server.created, 1);
    });

    testWidgets('a project that already has a draft on the server: the person is offered that draft, which becomes a draft of the phone', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      final String id = await completeUnsaved(tester, app, onServer: false);
      app.server.existing = ServerReport(id: reportId, clientOperationId: 'theirs', form: const ReportForm(projectId: projectId, periodId: periodId, planVersionId: planId))..version = 3;
      await app.open(tester, location: '/projects/mob-20/$id');
      await press(tester, 'Nộp báo cáo');
      expect(find.text('Dự án này đã có bản nháp trong kỳ. Hãy mở bản nháp đó, không lập thêm.'), findsWidgets);
      await press(tester, 'Mở bản nháp đã có');
      expect(find.text('Nhập khối lượng'), findsOneWidget);
      expect((await app.drafts).all(), hasLength(2));
      expect((await app.drafts).read(id)!.reportId, isNull, reason: 'the draft with entries was not touched');
    });

    testWidgets('another refusal of the server while the report is made is told in words', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      final String id = await completeUnsaved(tester, app, onServer: false);
      app.server.api.refuse('POST', '/reports', 422, 'PLAN_VERSION_NOT_EFFECTIVE');
      await app.open(tester, location: '/projects/mob-20/$id');
      await press(tester, 'Nộp báo cáo');
      expect(find.text('Dự án chưa có kế hoạch vốn đang hiệu lực tại ngày cuối kỳ.'), findsWidgets);
    });

    testWidgets('a report that somebody else changed after the save whose answer was lost is not submitted', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      final String id = await completeUnsaved(tester, app);
      await app.open(tester, location: '/projects/mob-20/$id');
      app.server.sync.dropNextBatchAnswer = true;
      await press(tester, 'Nộp báo cáo');
      expect(find.text('Chưa xác định kết quả. Máy chủ có thể đã nhận báo cáo; ứng dụng sẽ hỏi lại bằng mã của lệnh và không gửi lệnh mới.'), findsOneWidget);
      app.server.only().form = app.server.only().form.copyWith(construction: '1');
      app.server.only().version += 1;
      await press(tester, 'Kiểm tra kết quả');
      await press(tester, 'Nộp báo cáo');
      expect(find.textContaining('Báo cáo trên máy chủ đã khác với bản bạn vừa lưu'), findsOneWidget);
      expect(app.server.only().submissions, 0);
    });

    testWidgets('a report that moved on is a conflict: Compare is offered and nothing is overwritten', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      final String id = await completeUnsaved(tester, app);
      app.server.only().version = 5;
      await app.open(tester, location: '/projects/mob-20/$id');
      await press(tester, 'Nộp báo cáo');
      expect(find.textContaining('Báo cáo đã thay đổi trên máy chủ. Hãy so sánh hai bản và chọn'), findsOneWidget);
      await press(tester, 'So sánh hai bản');
      expect(find.text('So sánh hai bản'), findsWidgets);
      expect(app.server.only().submissions, 0);
    });
  });

  group('AC-ST-MOB-012-4 UAT-PLAN-35 UI-MOB-21 MOB-21 shows the revision, the time of the server and the status, and nothing to edit', () {
    Future<void> open(WidgetTester tester, ScriptedServer server, {DateTime? now}) =>
        pumpWithServer(tester, features: <MobileFeature>[reporting.feature], server: server, location: '/projects/mob-21/$reportId', now: now == null ? null : () => now);

    ScriptedServer submitted({int revision = 1, bool late = false, String status = 'SUBMITTED'}) => ScriptedServer()
      ..on(
        'GET',
        '/reports/:id',
        (HttpCall call) => serverReport(status: status, revision: revision, submittedAt: status == 'DRAFT' ? null : '2026-11-03T03:20:00.000Z', isLate: late, form: completeForm().copyWith(planVersionId: planId)),
      );

    testWidgets('revision 1, the time the server gave in Vietnam time, the status, and no way to edit a figure', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      await open(tester, submitted());
      expect(find.text('Báo cáo đã được gửi'), findsOneWidget);
      expect(fact('Mã báo cáo', 'Dự án DA-2026-002 · Kỳ W2026-45'), findsOneWidget);
      expect(fact('Lần nộp', 'Lần 1'), findsOneWidget);
      expect(fact('Trạng thái', 'Đã gửi'), findsOneWidget);
      expect(fact('Máy chủ nhận lúc', '03/11/2026 10:20'), findsOneWidget);
      expect(fact('Thời hạn', 'Đúng hạn'), findsOneWidget);
      expect(fact('Tổng lũy kế sáu ô', '420 triệu đồng'), findsOneWidget);
      expect(find.byType(TextField), findsNothing);
      expect(find.byType(DropdownButtonFormField<String>), findsNothing);
      expect(find.textContaining('Số liệu đã nộp không sửa được'), findsOneWidget);
      expect(find.textContaining('lập bản điều chỉnh'), findsOneWidget);
    });

    testWidgets('the time is the server\'s: the clock of the phone moved by an hour changes nothing', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      await open(tester, submitted(), now: DateTime.utc(2026, 11, 3, 3, 30));
      expect(fact('Máy chủ nhận lúc', '03/11/2026 10:20'), findsOneWidget);
      await open(tester, submitted(), now: DateTime.utc(2026, 11, 3, 4, 30));
      expect(fact('Máy chủ nhận lúc', '03/11/2026 10:20'), findsOneWidget);
      await open(tester, submitted(), now: DateTime.utc(2026, 11, 2, 22, 0));
      expect(fact('Máy chủ nhận lúc', '03/11/2026 10:20'), findsOneWidget);
    });

    testWidgets('a revision after the first, a late report, and a report that is still a draft are told as they are', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      await open(tester, submitted(revision: 2, late: true));
      expect(fact('Lần nộp', 'Lần 2'), findsOneWidget);
      expect(fact('Thời hạn', 'Nộp trễ hạn (máy chủ xác định)'), findsOneWidget);
      await open(tester, submitted(status: 'DRAFT'));
      expect(find.text('Báo cáo chưa được gửi'), findsOneWidget);
      expect(fact('Máy chủ nhận lúc', 'Chưa nộp'), findsOneWidget);
      expect(fact('Trạng thái', 'Nháp'), findsOneWidget);
      expect(find.textContaining('vẫn là bản nháp trên máy chủ'), findsOneWidget);
    });

    testWidgets('the buttons lead to the projects and to the send queue', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      await open(tester, submitted());
      expect(find.text('Về danh sách dự án'), findsOneWidget);
      expect(find.text('Xem hàng đợi gửi'), findsOneWidget);
    });

    testWidgets('default, loading, error, denied, expired licence, ended session and no connection', (WidgetTester tester) async {
      await contract.expectEveryState(
        tester,
        open: (WidgetTester t, ScriptedServer server) => open(t, server),
        script: contract.StateScript(
          healthy: (ScriptedServer server) => server.on('GET', '/reports/:id', (HttpCall call) => serverReport(status: 'SUBMITTED', submittedAt: '2026-11-03T03:20:00.000Z', form: completeForm())),
          content: find.text('Báo cáo đã được gửi'),
        ),
      );
    });

    testWidgets('three devices, text at 200 percent, tap targets, labels and contrast', (WidgetTester tester) async {
      await contract.expectScreenContract(
        tester,
        open: (WidgetTester t, ScriptedServer server) => open(t, server),
        healthy: (ScriptedServer server) => server.on('GET', '/reports/:id', (HttpCall call) => serverReport(status: 'SUBMITTED', submittedAt: '2026-11-03T03:20:00.000Z', form: completeForm())),
      );
    });
  });

  group('AC-ST-MOB-011-5 UI-MOB-22 MOB-22 lists the drafts on the phone', () {
    testWidgets('each draft with its project, its period, when it was saved and where it stands; one waiting in the queue is opened at its status', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester, overrides: idleRunners);
      final String editing = await newDraft(app, onServer: false, shape: (ReportForm f) => f.withCell(kCells.first, const CellEntry(cumulative: '100.000.000')));
      final String synced = await newDraft(app);
      final DraftSnapshot third = (await app.drafts).start(context: chosenOnly, projectId: 'p3', periodId: periodId, basis: 'YTD', reportType: kWeekly);
      final CommandQueue queue = await app.container.read(commandQueueProvider.future);
      final DraftSnapshot written = (await app.drafts).read(synced)!;
      queue.enqueue(commandType: kSaveCommand, payload: written.form.toPayload(written.reportId!), baseServerVersion: 1, draftId: synced);
      await app.open(tester, location: '/projects/mob-22', overrides: idleRunners);

      expect(find.text('3 bản nháp trên máy'), findsOneWidget);
      expect(find.text('Dự án DA-2026-002 · Kỳ W2026-45'), findsNWidgets(3));
      expect(find.text('Đường vành đai 3'), findsNWidgets(3));
      expect(find.text('Đang soạn'), findsNWidgets(2));
      expect(find.text('Chờ gửi'), findsOneWidget);
      expect(find.textContaining('Lưu lúc'), findsNWidgets(3));
      expect(find.textContaining('mã nháp ${editing.substring(0, 8)}'), findsOneWidget);
      expect(find.textContaining('mã nháp ${third.shortId}'), findsOneWidget);
      expect(find.text('100 triệu đồng'), findsOneWidget);
      expect(find.text('Bỏ nháp'), findsNWidgets(2), reason: 'a draft waiting in the queue cannot be dropped');
      expect(find.text('Xem trạng thái gửi'), findsOneWidget);

      await press(tester, 'Xem trạng thái gửi');
      expect(find.text('Rà soát và gửi báo cáo'), findsOneWidget);
    });

    testWidgets('a draft is opened at the first step', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester);
      final String id = await newDraft(app, onServer: false);
      await app.open(tester, location: '/projects/mob-22');
      await press(tester, 'Mở nháp');
      expect(find.text('Nhập khối lượng'), findsOneWidget);
      expect(find.textContaining('mã nháp ${id.substring(0, 8)}'), findsOneWidget);
    });

    testWidgets('dropping a draft asks first and says what it does; the draft is gone after, and the report on the server is not touched', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester);
      final String local = await newDraft(app, onServer: false);
      await app.open(tester, location: '/projects/mob-22');
      await press(tester, 'Bỏ nháp');
      expect(find.text('Bỏ bản nháp này?'), findsOneWidget);
      expect(find.textContaining('Bản nháp chỉ có trên máy này và sẽ mất'), findsOneWidget);
      await tester.tap(find.text('Giữ lại'));
      await tester.pumpAndSettle();
      expect((await app.drafts).read(local), isNotNull);

      await press(tester, 'Bỏ nháp');
      await tester.tap(find.text('Bỏ nháp').last);
      await tester.pumpAndSettle();
      expect((await app.drafts).read(local), isNull);
      expect(find.text('Chưa có dữ liệu'), findsOneWidget);
    });

    testWidgets('a draft that exists on the server says the server\'s copy stays', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester);
      final String id = await newDraft(app);
      await app.open(tester, location: '/projects/mob-22');
      await press(tester, 'Bỏ nháp');
      expect(find.textContaining('Bản nháp trên máy chủ (nếu đã có) vẫn giữ nguyên'), findsOneWidget);
      await tester.tap(find.text('Bỏ nháp').last);
      await tester.pumpAndSettle();
      expect((await app.drafts).read(id), isNull);
      expect(app.server.only().status, 'DRAFT');
    });

    testWidgets('a new report is started from the list', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester);
      await press(tester, 'Lập báo cáo mới');
      expect(find.text('Chọn kỳ báo cáo'), findsOneWidget);
    });

    testWidgets('offline and read only are told above the list, which stays; a read-only tenant cannot start a report', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester);
      await newDraft(app, onServer: false);
      final ProviderContainer container = await app.open(tester, location: '/projects/mob-22');
      container.read(reachabilityProvider.notifier).report(Reachability.offline);
      await tester.pumpAndSettle();
      expect(find.textContaining('Đang ngoại tuyến. Bản nháp được giữ trên máy'), findsOneWidget);
      expect(find.text('1 bản nháp trên máy'), findsOneWidget);

      await app.open(tester, location: '/projects/mob-22', session: FakeSession(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1', mode: SessionMode.readOnly)));
      expect(find.textContaining('chế độ chỉ xem'), findsOneWidget);
      expect(find.text('Lập báo cáo mới'), findsNothing);
      expect(find.text('1 bản nháp trên máy'), findsOneWidget);
    });

    testWidgets('default, empty, loading, error and ended session', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      ReportingApp app = ReportingApp.create();
      await app.open(tester);
      expect(find.text('Chưa có dữ liệu'), findsOneWidget, reason: 'empty');
      await newDraft(app, onServer: false);
      await app.open(tester, location: '/projects/mob-22');
      expect(find.text('Mở nháp'), findsOneWidget, reason: 'default');

      final Completer<void> gate = Completer<void>();
      app = ReportingApp.create();
      await app.open(tester, overrides: <Override>[
        reportDraftsProviderOverride(() async {
          await gate.future;
          throw StateError('never');
        }),
      ]);
      expect(find.byType(LoadingView), findsOneWidget, reason: 'loading');
      gate.complete();
      await tester.pumpAndSettle();

      app = ReportingApp.create();
      await app.open(tester, overrides: <Override>[reportDraftsProviderOverride(() async => throw StateError('disk'))]);
      expect(find.text('Chưa thể tải dữ liệu'), findsOneWidget, reason: 'error');
      expect(find.text('CLIENT_ERROR'), findsOneWidget);

      app = ReportingApp.create();
      await app.open(tester, overrides: <Override>[reportDraftsProviderOverride(() async => throw const OfflineUnavailable())]);
      expect(find.text('Phiên làm việc đã hết hạn'), findsOneWidget, reason: 'signed out');
      expect(find.text('Lập báo cáo mới'), findsNothing);
    });

    testWidgets('an English interface reads in English', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester);
      await newDraft(app, onServer: false);
      await app.open(tester, location: '/projects/mob-22', locale: const Locale('en'));
      expect(find.text('Drafts'), findsOneWidget);
      expect(find.text('1 drafts on this phone'), findsOneWidget);
      expect(find.text('Being written'), findsOneWidget);
      expect(find.text('New report'), findsOneWidget);
    });

    testWidgets('three devices, text at 200 percent, tap targets, labels and contrast', (WidgetTester tester) async {
      final ReportingApp app = ReportingApp.create();
      useDevice(tester, kDeviceSizes[1]);
      await app.open(tester);
      await newDraft(app);
      await newDraft(app, onServer: false, shape: (ReportForm f) => f.copyWith(construction: '5'));
      for (final Size size in kDeviceSizes) {
        for (final double scale in <double>[1.0, 2.0]) {
          useDevice(tester, size, textScale: scale);
          final SemanticsHandle semantics = tester.ensureSemantics();
          await app.open(tester, location: '/projects/mob-22');
          await _expectContract(tester, '${size.width.toInt()}x${size.height.toInt()} at $scale');
          semantics.dispose();
        }
      }
    });
  });

  group('UI-MOB-20 the screen contract of MOB-20 and its states', () {
    testWidgets('three devices, text at 200 percent, tap targets, labels and contrast', (WidgetTester tester) async {
      final ReportingApp app = ReportingApp.create();
      useDevice(tester, kDeviceSizes[1]);
      final String id = await completeUnsaved(tester, app);
      for (final Size size in kDeviceSizes) {
        for (final double scale in <double>[1.0, 2.0]) {
          useDevice(tester, size, textScale: scale);
          final SemanticsHandle semantics = tester.ensureSemantics();
          await app.open(tester, location: '/projects/mob-20/$id');
          await _expectContract(tester, '${size.width.toInt()}x${size.height.toInt()} at $scale');
          semantics.dispose();
        }
      }
    });

    testWidgets('a draft that is not there and an ended session', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      ReportingApp app = ReportingApp.create();
      await app.open(tester, location: '/projects/mob-20/missing');
      expect(find.text('Chưa có dữ liệu'), findsOneWidget);
      app = ReportingApp.create();
      await app.open(tester, location: '/projects/mob-20/x', overrides: <Override>[reportDraftsProviderOverride(() async => throw const OfflineUnavailable())]);
      expect(find.text('Phiên làm việc đã hết hạn'), findsOneWidget);
    });
  });
}

Future<void> _expectContract(WidgetTester tester, String where) async {
  expect(tester.takeException(), isNull, reason: where);
  try {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline), reason: where);
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    await expectLater(tester, meetsGuideline(iOSTapTargetGuideline), reason: where);
  } finally {
    debugDefaultTargetPlatformOverride = null;
  }
  await expectLater(tester, meetsGuideline(labeledTapTargetGuideline), reason: where);
  await expectLater(tester, meetsGuideline(textContrastGuideline), reason: where);
}
