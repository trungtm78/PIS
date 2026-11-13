import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/offline/drafts/local_draft.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/offline/queue/command_queue.dart';
import 'package:machvon_mobile/core/offline/queue/queued_command.dart';
import 'package:machvon_mobile/core/offline/store/local_store.dart';
import 'package:machvon_mobile/features/release/telemetry.dart';
import 'package:machvon_mobile/features/reporting/data/report_drafts.dart';
import 'package:machvon_mobile/features/reporting/data/submit_flow.dart';
import 'package:machvon_mobile/features/reporting/data/submit_funnel.dart';
import 'package:machvon_mobile/features/reporting/model/report_cells.dart';
import 'package:machvon_mobile/features/reporting/model/report_form.dart';
import 'package:machvon_mobile/features/reporting/reporting_feature.dart' as reporting;

import '../../support/harness.dart';
import '../support/scripted_server.dart';
import 'reporting_fixtures.dart';
import 'reporting_harness.dart';

/// A command of the draft [draftId] taken to [state] by the moves the queue allows, as if it had been sent.
QueuedCommand commandIn(LocalStore store, CommandQueue queue, String draftId, String type, CommandState state, {String? error, bool release = false}) {
  final QueuedCommand made = queue.enqueue(commandType: type, payload: <String, Object?>{'report_id': reportId}, baseServerVersion: 1, draftId: draftId, releaseDraft: release);
  if (state == CommandState.queued) return made;
  store.commands.move(made.id, CommandState.sending, (QueuedCommand c) => c);
  return store.commands.move(made.id, state, (QueuedCommand c) => c.copyWith(errorCode: error));
}

QueuedCommand fakeCommand(CommandState state, {String? error}) => QueuedCommand(
      id: 'c1',
      tenantId: 't',
      userId: 'u',
      commandType: kSubmitCommand,
      payload: null,
      payloadBytes: 0,
      baseServerVersion: 1,
      idempotencyKey: 'k-0000000000000001',
      state: state,
      createdAt: 1,
      updatedAt: 1,
      errorCode: error,
    );

void main() {
  group('TK-MOB-012-4 the funnel of the submit is counted without anything about the person or the report', () {
    SubmitStatus at(SubmitStage stage, {String? error}) => SubmitStatus(stage, fakeCommand(CommandState.queued, error: error));

    test('each stage that matters is one event with the screen, a stable code and a duration; the same stage twice is one event', () {
      final BufferedTelemetrySink sink = BufferedTelemetrySink();
      final SubmitFunnel funnel = SubmitFunnel(TelemetryService(sink: sink, tenantId: () => 'tenant-a'));
      funnel.started();
      funnel
        ..observe(at(SubmitStage.idle))
        ..observe(at(SubmitStage.queued))
        ..observe(at(SubmitStage.queued))
        ..observe(at(SubmitStage.sending))
        ..observe(at(SubmitStage.unknown))
        ..observe(at(SubmitStage.submitted))
        ..observe(at(SubmitStage.rejected, error: 'PERIOD_LOCKED'))
        ..observe(at(SubmitStage.conflict, error: 'VERSION_CONFLICT'))
        ..observe(at(SubmitStage.rejected));
      final List<String> names = <String>[for (final TelemetryEvent e in sink.events) e.name];
      expect(names, <String>[
        'report.submit_started',
        'report.submit_queued',
        'report.submit_unknown',
        'report.submit_accepted',
        'report.submit_rejected',
        'report.submit_conflict',
        'report.submit_rejected',
      ]);
      expect(sink.events.every((TelemetryEvent e) => e.tenantId == 'tenant-a'), isTrue);
      expect(sink.events.every((TelemetryEvent e) => e.attributes['screen_id'] == 'MOB-20'), isTrue);
      expect(sink.events[3].attributes['duration_ms'], isA<int>());
      expect(sink.events[4].attributes['reason_code'], 'PERIOD_LOCKED');
      expect(sink.events[5].attributes['reason_code'], 'VERSION_CONFLICT');
      expect(sink.events[6].attributes.containsKey('reason_code'), isFalse);
      expect(sink.events.expand((TelemetryEvent e) => e.attributes.keys).toSet(), <String>{'screen_id', 'duration_ms', 'reason_code'});
    });

    test('an acceptance found by the runner while the person was away has no duration', () {
      final BufferedTelemetrySink sink = BufferedTelemetrySink();
      SubmitFunnel(TelemetryService(sink: sink, tenantId: () => null)).observe(at(SubmitStage.submitted));
      expect(sink.events.single.attributes.containsKey('duration_ms'), isFalse);
      expect(sink.events.single.tenantId, kNoTenant);
    });
  });

  group('TK-MOB-012-4 UAT-AC502 the funnel of a submit whose answer was lost, from the screen', () {
    testWidgets('started, unknown, accepted: no project, no amount, no id in any event', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      final BufferedTelemetrySink sink = BufferedTelemetrySink();
      await app.open(tester);
      final String id = await newDraft(app, shape: (ReportForm f) => completeForm().copyWith(planVersionId: f.planVersionId));
      await app.open(tester, location: '/projects/mob-20/$id', overrides: <Override>[telemetrySinkProvider.overrideWithValue(sink)]);
      app.server.dropSubmitAnswer = true;
      await press(tester, 'Nộp báo cáo');
      await press(tester, 'Kiểm tra kết quả');

      final List<String> names = <String>[for (final TelemetryEvent e in sink.events) e.name];
      expect(names.first, 'report.submit_started');
      expect(names, containsAllInOrder(<String>['report.submit_unknown', 'report.submit_accepted']));
      final String everything = jsonEncode(<Object>[for (final TelemetryEvent e in sink.events) e.toJson()]);
      for (final String secret in <String>['DA-2026-002', 'Đường vành đai', reportId, projectId, periodId, '420000000', '100000000']) {
        expect(everything.contains(secret), isFalse, reason: secret);
      }
    });
  });

  group('UI-MOB-13 MOB-13 starts a draft with no network at all, and leads to the list of drafts', () {
    testWidgets('a phone known to be offline makes the draft on the phone alone; the way of reading is the one that was chosen', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      final ProviderContainer container = await app.open(tester, location: '/projects/mob-13?project=$projectId&period=$periodId');
      container.read(reachabilityProvider.notifier).report(Reachability.offline);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Phát sinh trong kỳ'));
      await tester.pumpAndSettle();
      await press(tester, 'Tạo bản nháp');

      expect(find.text('Nhập khối lượng'), findsOneWidget);
      final DraftSnapshot draft = (await app.drafts).all().single;
      expect(draft.form.basis, 'PERIOD');
      expect(draft.reportId, isNull);
      expect(app.server.calls.where((HttpCall c) => c.method == 'POST'), isEmpty, reason: 'nothing was sent');
    });

    testWidgets('the list of drafts is one tap away', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester, location: '/projects/mob-13');
      await press(tester, 'Danh sách nháp');
      expect(find.text('Danh sách nháp'), findsWidgets);
      expect(find.text('Chưa có bản nháp báo cáo'), findsOneWidget);
    });
  });

  group('the frame of a step', () {
    testWidgets('an answer of the server that is not a report is told in words; the draft and its boxes stay', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester);
      final String id = await newDraft(app, shape: (ReportForm f) => f.copyWith(construction: '5'));
      app.server.api.on('GET', '/reports/:id', (HttpCall call) => <String, Object?>{'id': 'x'});
      await app.open(tester, location: '/projects/mob-14/$id');
      expect(find.text('Không thực hiện được. Hãy thử lại sau.'), findsOneWidget);
      expect(textOf(tester, 'Khối lượng thi công'), '5');
    });

    testWidgets('a store that fails to open for want of a session, deeper in the providers, is an ended session', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester, location: '/projects/mob-14/x', overrides: <Override>[localStoreProvider.overrideWith((Ref ref) async => throw const OfflineUnavailable())]);
      expect(find.text('Phiên làm việc đã hết hạn'), findsOneWidget);
      expect(find.text('SESSION_EXPIRED'), findsOneWidget);
    });

    testWidgets('Retry asks for the store again', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final ReportingApp app = ReportingApp.create();
      int asked = 0;
      await app.open(tester, location: '/projects/mob-14/x', overrides: <Override>[
        reportDraftsProviderOverride(() async {
          asked += 1;
          throw StateError('disk');
        }),
      ]);
      expect(asked, 1);
      await tester.tap(find.text('Thử lại'));
      await tester.pumpAndSettle();
      expect(asked, 2);
      expect(find.text('CLIENT_ERROR'), findsOneWidget);

      await app.open(tester, location: '/projects/mob-22', overrides: <Override>[reportDraftsProviderOverride(() async => throw StateError('disk'))]);
      await tester.tap(find.text('Thử lại'));
      await tester.pumpAndSettle();
      expect(find.text('CLIENT_ERROR'), findsOneWidget);
    });

    testWidgets('Back returns to the screen before; a box selects what it holds when it is touched, so that the next digits replace it', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester);
      final String id = await newDraft(app, onServer: false);
      final ProviderContainer container = await app.open(tester, location: '/projects/mob-14/$id');
      await typeInto(tester, 'Khối lượng thi công', '123');
      await tester.tap(find.widgetWithText(TextField, 'Khối lượng thi công'));
      await tester.pump();
      final TextSelection selection = tester.widget<TextField>(find.widgetWithText(TextField, 'Khối lượng thi công')).controller!.selection;
      expect((selection.start, selection.end), (0, 3));

      await press(tester, 'Quay lại');
      expect(currentLocation(container), '/projects');
    });

    testWidgets('Continue goes to the next step of the sequence and the last step has none', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester);
      final String id = await newDraft(app, onServer: false);
      await app.open(tester, location: '/projects/mob-18/$id');
      await press(tester, 'Tiếp tục');
      expect(find.text('Thuyết minh'), findsWidgets, reason: 'MOB-55 follows MOB-18');
      await press(tester, 'Tiếp tục');
      expect(find.text('Tệp đính kèm'), findsWidgets, reason: 'MOB-19, the files of the report, follows');
      await app.open(tester, location: '/projects/mob-20/$id');
      expect(find.text('Tiếp tục'), findsNothing);
    });
  });

  group('UI-MOB-56 the reason for entering an estimate again is kept like the rest', () {
    testWidgets('typed and kept', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester);
      final String id = await newDraft(app);
      await app.open(tester, location: '/projects/mob-56/$id');
      await typeInto(tester, 'Lý do nhập lại', 'Thay ước cũ');
      expect((await app.drafts).readEstimate(id).reason, 'Thay ước cũ');
    });
  });

  group('UI-MOB-20 what MOB-20 does when the server cannot give its review', () {
    testWidgets('a failing server and an answer that is not a report leave the review of the phone as it is', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester);
      final String id = await newDraft(app, shape: (ReportForm f) => completeForm().copyWith(planVersionId: f.planVersionId));
      app.server.api.refuse('GET', '/reports/:id', 500, 'INTERNAL_ERROR');
      await app.open(tester, location: '/projects/mob-20/$id');
      expect(find.text('Máy chủ kiểm tra'), findsNothing);
      expect(find.text('Lỗi phải sửa trước khi gửi'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Nộp báo cáo')).onPressed, isNotNull);

      app.server.api.on('GET', '/reports/:id', (HttpCall call) => <String, Object?>{'id': 'x'});
      await app.open(tester, location: '/projects/mob-20/$id');
      expect(find.text('Máy chủ kiểm tra'), findsNothing);
      expect(find.text('Lỗi phải sửa trước khi gửi'), findsOneWidget);
    });

    testWidgets('while the command is on its way MOB-20 says it is being sent and the report cannot be sent a second time', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester);
      final String id = await newDraft(app, shape: (ReportForm f) => completeForm().copyWith(planVersionId: f.planVersionId));
      await app.open(tester, location: '/projects/mob-20/$id');
      final Completer<void> gate = Completer<void>();
      app.server.hold = gate.future;
      await tester.ensureVisible(find.text('Nộp báo cáo'));
      await tester.tap(find.text('Nộp báo cáo'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      await tester.pump(const Duration(milliseconds: 50));
      expect(find.text('Đang gửi lên máy chủ...'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Đang gửi…')).onPressed, isNull);
      app.server.hold = null;
      gate.complete();
      await tester.pumpAndSettle();
      expect(find.text('Báo cáo đã được gửi'), findsOneWidget);
      expect(app.server.only().submissions, 1);
    });
  });

  group('UI-MOB-21 the buttons of the result lead on', () {
    testWidgets('to the projects and to the send queue', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ScriptedServer server = ScriptedServer()
        ..on('GET', '/reports/:id', (HttpCall call) => serverReport(status: 'SUBMITTED', submittedAt: '2026-11-03T03:20:00.000Z', form: completeForm()));
      final ProviderContainer container = await pumpWithServer(tester, features: <MobileFeature>[reporting.feature], server: server, location: '/projects/mob-21/$reportId');
      await press(tester, 'Xem hàng đợi gửi');
      expect(currentLocation(container), '/projects/mob-41');
      await pressBack(tester);
      await press(tester, 'Về danh sách dự án');
      expect(currentLocation(container), '/projects');
    });
  });

  group('AC-ST-MOB-011-5 UI-MOB-22 each way a draft can stand is told in its own words', () {
    testWidgets('result unknown, refused, handed in, blocked and waiting', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester, overrides: idleRunners);
      final LocalStore store = await app.store;
      final CommandQueue queue = await app.container.read(commandQueueProvider.future);
      final List<String> ids = <String>[];
      for (int i = 0; i < 5; i += 1) {
        final DraftSnapshot draft = (await app.drafts).start(context: chosenOnly, projectId: 'p$i', periodId: periodId, basis: 'YTD', reportType: kWeekly);
        ids.add(draft.id);
        // a draft that has its report on the server, so that a command can be made from it
        store.drafts.upsert(LocalDraft(
          id: draft.id,
          tenantId: store.tenantId,
          userId: store.userId,
          kind: kReportKind,
          recordId: reportId,
          fields: draft.draft.fields,
          baseServerVersion: 1,
          status: DraftStatus.editing,
          createdAt: draft.draft.createdAt,
          updatedAt: draft.draft.updatedAt + i,
        ));
      }
      commandIn(store, queue, ids[0], kSubmitCommand, CommandState.unknown);
      commandIn(store, queue, ids[1], kSubmitCommand, CommandState.rejected, error: 'PERIOD_LOCKED');
      commandIn(store, queue, ids[2], kSubmitCommand, CommandState.accepted);
      final LocalDraft blocked = store.drafts.byId(ids[3])!;
      store.drafts.upsert(LocalDraft(id: blocked.id, tenantId: blocked.tenantId, userId: blocked.userId, kind: blocked.kind, recordId: blocked.recordId, fields: blocked.fields, baseServerVersion: 1, status: DraftStatus.blocked, blockedCode: 'LICENSE_EXPIRED', createdAt: blocked.createdAt, updatedAt: blocked.updatedAt));
      final LocalDraft waiting = store.drafts.byId(ids[4])!;
      store.drafts.upsert(LocalDraft(id: waiting.id, tenantId: waiting.tenantId, userId: waiting.userId, kind: waiting.kind, recordId: waiting.recordId, fields: waiting.fields, baseServerVersion: 1, status: DraftStatus.queued, createdAt: waiting.createdAt, updatedAt: waiting.updatedAt));

      await app.open(tester, location: '/projects/mob-22', overrides: idleRunners);
      expect(find.text('Chưa xác định kết quả'), findsOneWidget);
      expect(find.text('Cần xử lý'), findsNWidgets(2), reason: 'a refused command and a blocked draft');
      expect(find.text('Đã nộp'), findsOneWidget);
      expect(find.text('Chờ gửi'), findsOneWidget);
      expect(find.text('5 bản nháp trên máy'), findsOneWidget);
    });
  });
}
