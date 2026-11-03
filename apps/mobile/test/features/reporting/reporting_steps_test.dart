import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
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

void main() {
  group('AC-ST-MOB-011-1 UI-MOB-13 MOB-13 starts a draft on the phone, and on the server when there is a network', () {
    testWidgets('the period, the project and the way of reading are chosen; the draft has a UUID; the server makes the report from it', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester, location: '/projects/mob-13');
      expect(find.text('Chọn kỳ báo cáo'), findsOneWidget);
      expect(find.text('Báo cáo tuần'), findsOneWidget);
      expect(find.text('Lũy kế từ đầu năm'), findsOneWidget);

      await press(tester, 'Tạo bản nháp');
      expect(find.text('Chọn kỳ báo cáo'), findsOneWidget, reason: 'nothing is chosen yet');
      expect(find.text('Chọn kỳ báo cáo.'), findsOneWidget);
      expect(find.text('Chọn dự án.'), findsOneWidget);
      expect((await app.drafts).all(), isEmpty);

      await tester.tap(find.byType(DropdownButtonFormField<String>).first);
      await tester.pumpAndSettle();
      expect(find.text('W2026-45 · Đang mở'), findsWidgets);
      expect(find.text('M2026-10 · Đã quá hạn, vẫn nhận'), findsNothing, reason: 'a month is not a weekly period');
      await tester.tap(find.text('W2026-45 · Đang mở').last);
      await tester.pumpAndSettle();
      await tester.tap(find.byType(DropdownButtonFormField<String>).last);
      await tester.pumpAndSettle();
      await tester.tap(find.text('DA-2026-002 · Đường vành đai 3').last);
      await tester.pumpAndSettle();
      expect(find.text('Từ 2026-10-31 đến 2026-11-06'), findsOneWidget);
      await press(tester, 'Tạo bản nháp');

      expect(find.text('Nhập khối lượng'), findsOneWidget, reason: 'the first step opens');
      final ReportDrafts drafts = await app.drafts;
      final DraftSnapshot draft = drafts.all().single;
      expect(draft.id, matches(RegExp(r'^[0-9a-f-]{36}$')));
      expect(draft.form.basis, 'YTD');
      expect(draft.form.reportType, kWeekly);
      expect(draft.reportId, app.server.only().id);
      expect(app.server.only().clientOperationId, draft.id);
      expect(find.text('Dự án DA-2026-002 · Kỳ W2026-45'), findsOneWidget);
    });

    testWidgets('a monthly report starts from a month and reads the figures as arising in the period', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester, location: '/projects/mob-13');
      await tester.tap(find.text('Báo cáo tháng'));
      await tester.pumpAndSettle();
      await tester.tap(find.byType(DropdownButtonFormField<String>).first);
      await tester.pumpAndSettle();
      expect(find.text('W2026-45 · Đang mở'), findsNothing);
      await tester.tap(find.text('M2026-10 · Đã quá hạn, vẫn nhận').last);
      await tester.pumpAndSettle();
      await tester.tap(find.byType(DropdownButtonFormField<String>).last);
      await tester.pumpAndSettle();
      await tester.tap(find.text('DA-2026-002 · Đường vành đai 3').last);
      await tester.pumpAndSettle();
      await press(tester, 'Tạo bản nháp');
      final DraftSnapshot draft = (await app.drafts).all().single;
      expect(draft.form.reportType, kMonthly);
      expect(draft.form.basis, 'PERIOD');
    });

    testWidgets('with no network the draft is made on the phone and the first step opens; the server is not asked for a report it has no way to make', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester, location: '/projects/mob-13?project=$projectId&period=$periodId');
      expect(find.text('Chọn kỳ báo cáo'), findsOneWidget);
      app.server.offline = true;
      await press(tester, 'Tạo bản nháp');
      expect(find.text('Nhập khối lượng'), findsOneWidget);
      final DraftSnapshot draft = (await app.drafts).all().single;
      expect(draft.reportId, isNull, reason: 'the report is made on the server when there is a network');
      expect(app.server.created, 0);
      expect(find.text('Dự án DA-2026-002 · Kỳ W2026-45'), findsOneWidget);
      expect(find.textContaining('Đang ngoại tuyến'), findsOneWidget);
    });

    testWidgets('a project that already has a draft on the phone for the period opens it, never a second', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester, location: '/projects/mob-13?project=$projectId&period=$periodId');
      final String id = await newDraft(app, onServer: false);
      await press(tester, 'Tạo bản nháp');
      expect(find.text('Nhập khối lượng'), findsOneWidget);
      expect((await app.drafts).all().map((DraftSnapshot s) => s.id), <String>[id]);
    });

    testWidgets('a period the server will not take a report for is told, and no draft is kept for it', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      app.server.periodLocked = true;
      await app.open(tester, location: '/projects/mob-13?project=$projectId&period=$periodId');
      await press(tester, 'Tạo bản nháp');
      expect(find.text('Chọn kỳ báo cáo'), findsOneWidget);
      expect(find.textContaining('Kỳ đã khóa sổ. Chỉ lập hoặc nộp được'), findsOneWidget);
      expect((await app.drafts).all(), isEmpty);
    });

    testWidgets('a locked period is told before the choice is made', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester, location: '/projects/mob-13?period=7a1f0000-0000-4000-8000-000000000012');
      expect(find.textContaining('Kỳ này đã khóa sổ'), findsOneWidget);
    });

    testWidgets('a project that has a draft on the server takes it over; one that the phone cannot take is offered', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      app.server.existing = ServerReport(id: reportId, clientOperationId: 'theirs', form: completeForm().copyWith(planVersionId: planId))..version = 4;
      await app.open(tester, location: '/projects/mob-13?project=$projectId&period=$periodId');
      await press(tester, 'Tạo bản nháp');
      expect(find.text('Nhập khối lượng'), findsOneWidget);
      final DraftSnapshot draft = (await app.drafts).all().single;
      expect(draft.reportId, reportId);
      expect(draft.form.construction, '300000000');
      expect(app.server.created, 0);
    });

    testWidgets('a read-only tenant cannot start a report', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester, location: '/projects/mob-13', session: FakeSession(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1', mode: SessionMode.readOnly)));
      expect(find.textContaining('chế độ chỉ xem'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Tạo bản nháp')).onPressed, isNull);
    });
  });

  group('AC-ST-MOB-011-5 UI-MOB-13 the states of MOB-13', () {
    Future<void> open(WidgetTester tester, ScriptedServer server) async {
      await pumpWithServer(tester, features: <MobileFeature>[reporting.feature], server: server, location: '/projects/mob-13');
    }

    testWidgets('default, loading, empty, error, denied, expired licence, ended session and no connection', (WidgetTester tester) async {
      await contract.expectEveryState(
        tester,
        open: open,
        script: contract.StateScript(
          healthy: (ScriptedServer server) => server
            ..on('GET', '/resources/reporting_period', (HttpCall call) => <String, Object?>{'items': periodRows(), 'next_cursor': null})
            ..on('GET', '/resources/project', (HttpCall call) => <String, Object?>{'items': projectRows(), 'next_cursor': null}),
          content: find.text('Loại báo cáo'),
          empty: (ScriptedServer server) => server.on('GET', '/resources/project', (HttpCall call) => <String, Object?>{'items': <Object?>[], 'next_cursor': null}),
        ),
      );
    });

    testWidgets('three devices, text at 200 percent, tap targets, labels and contrast', (WidgetTester tester) async {
      await contract.expectScreenContract(
        tester,
        open: open,
        healthy: (ScriptedServer server) => server
          ..on('GET', '/resources/reporting_period', (HttpCall call) => <String, Object?>{'items': periodRows(), 'next_cursor': null})
          ..on('GET', '/resources/project', (HttpCall call) => <String, Object?>{'items': projectRows(), 'next_cursor': null}),
      );
    });
  });

  group('AC-ST-MOB-011-3 UAT-AC241 UI-MOB-14 MOB-14 shows the cumulative as the cells say it, not the period before added to it', () {
    testWidgets('a period before of 100 million and a cumulative of 150 million: the change is 50 million and the cumulative 150', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      app.server.previous = <String, String>{'CURRENT_YEAR:CENTRAL': '100000000'};
      await app.open(tester);
      final String id = await newDraft(app, shape: (ReportForm f) => f.withCell(kCells.first, const CellEntry(cumulative: '150.000.000')));
      await app.open(tester, location: '/projects/mob-14/$id');

      expect(fact('Lũy kế kỳ trước', '100 triệu đồng'), findsOneWidget);
      expect(fact('Phát sinh trong kỳ', '+50 triệu đồng'), findsOneWidget);
      expect(fact('Lũy kế kỳ này', '150 triệu đồng'), findsOneWidget);
      expect(find.textContaining('250 triệu'), findsNothing);
    });

    testWidgets('with no period before the change is not invented', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester);
      final String id = await newDraft(app, onServer: false);
      await app.open(tester, location: '/projects/mob-14/$id');
      expect(fact('Lũy kế kỳ trước', 'Chưa có kỳ trước để so sánh'), findsOneWidget);
      expect(fact('Phát sinh trong kỳ', 'Chưa có kỳ trước để so sánh'), findsOneWidget);
      expect(fact('Lũy kế kỳ này', '0 triệu đồng'), findsOneWidget);
    });
  });

  group('UI-MOB-14 MOB-14 keeps the volumes at every change, with the unit beside each box', () {
    testWidgets('each volume is written to the draft as it is typed; the same amount is read in millions; the way of reading can be changed', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester);
      final String id = await newDraft(app);
      await app.open(tester, location: '/projects/mob-14/$id');

      expect(find.text('đồng'), findsNWidgets(4), reason: 'the unit is written beside each of the four boxes');
      await typeInto(tester, 'Khối lượng thi công', '1.500.000.000');
      await typeInto(tester, 'Khối lượng nghiệm thu', '1.250.000.000');
      await typeInto(tester, 'Đã gửi Kho bạc', '0');
      await typeInto(tester, 'Hồ sơ đang hoàn thiện', '200.000.000');
      await typeInto(tester, 'Tiến độ thực hiện', '40,5');
      expect(find.text('1.500 triệu đồng'), findsOneWidget);
      expect(find.text('1.250 triệu đồng'), findsOneWidget);

      await tester.tap(find.text('Phát sinh trong kỳ').first);
      await tester.pumpAndSettle();
      final ReportForm saved = (await app.drafts).read(id)!.form;
      expect(saved.construction, '1.500.000.000');
      expect(saved.acceptance, '1.250.000.000');
      expect(saved.treasury, '0');
      expect(saved.preparing, '200.000.000');
      expect(saved.percent, '40,5');
      expect(saved.basis, 'PERIOD');
      expect(find.textContaining('Đã lưu nháp trên máy lúc'), findsOneWidget);
    });

    testWidgets('a percent above 100 is told beside its box and is not an amount of dong; letters cannot be typed in an amount', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester);
      final String id = await newDraft(app, onServer: false);
      await app.open(tester, location: '/projects/mob-14/$id');
      await typeInto(tester, 'Tiến độ thực hiện', '120');
      expect(find.text('Phần trăm phải từ 0 đến 100.'), findsOneWidget);
      await typeInto(tester, 'Tiến độ thực hiện', 'abc');
      expect(find.text('Nhập số từ 0 đến 100, tối đa hai chữ số thập phân.'), findsOneWidget);
      await typeInto(tester, 'Khối lượng thi công', '12ab3');
      expect(textOf(tester, 'Khối lượng thi công'), '123', reason: 'the keyboard accepts digits and the separators of thousands only');
    });
  });

  group('AC-ST-MOB-011-2 UAT-AC240 UI-MOB-15 MOB-15 totals the cells and shows the CTMTQG apart', () {
    testWidgets('FX-DIS-001 totals 420 million, the CTMTQG of 40 million is shown apart and never added', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester);
      final String id = await newDraft(app, shape: (ReportForm f) => completeForm().copyWith(planVersionId: f.planVersionId));
      await app.open(tester, location: '/projects/mob-15/$id');

      expect(find.text('Nhập vốn năm'), findsOneWidget);
      expect(fact('Tổng lũy kế sáu ô', '420 triệu đồng'), findsOneWidget);
      expect(fact('Trong đó CTMTQG (không cộng vào tổng)', '40 triệu đồng'), findsOneWidget);
      expect(fact('Tổng của nguồn này', '300 triệu đồng'), findsOneWidget);
      expect(find.textContaining('460'), findsNothing);
      expect(find.text('CTMTQG nằm trong số của ô, không cộng vào tổng.'), findsWidgets);
    });

    testWidgets('central 400 million with 40 million of CTMTQG as a subset, typed on the screen, total 420 million with 20 million local', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester);
      final String id = await newDraft(app, onServer: false);
      await app.open(tester, location: '/projects/mob-15/$id');

      await typeInto(tester, 'Lũy kế giải ngân Vốn năm NSTW', '400.000.000');
      await typeInto(tester, 'Trong đó CTMTQG của Vốn năm NSTW', '40.000.000');
      await typeInto(tester, 'Lũy kế giải ngân Vốn năm NSĐP', '20.000.000');
      expect(fact('Tổng lũy kế sáu ô', '420 triệu đồng'), findsOneWidget);
      expect(fact('Trong đó CTMTQG (không cộng vào tổng)', '40 triệu đồng'), findsOneWidget);
      expect(find.text('400 triệu đồng'), findsWidgets);
      final ReportForm saved = (await app.drafts).read(id)!.form;
      expect(saved.cell(kCells.first).cumulative, '400.000.000');
      expect(saved.cell(kCells.first).ctmtqg, '40.000.000');
    });

    testWidgets('a CTMTQG larger than its cell is told beside its box and the draft is still saved', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester);
      final String id = await newDraft(app, onServer: false);
      await app.open(tester, location: '/projects/mob-15/$id');
      await typeInto(tester, 'Lũy kế giải ngân Vốn năm NSTW', '10');
      await typeInto(tester, 'Trong đó CTMTQG của Vốn năm NSTW', '11');
      expect(find.text('Số trong đó CTMTQG không được lớn hơn số của ô.'), findsOneWidget);
      expect((await app.drafts).read(id)!.form.cell(kCells.first).ctmtqg, '11');
      await typeInto(tester, 'Lũy kế giải ngân Vốn năm NSTW', '');
      expect(find.text('Nhập số tiền, hoặc 0 nếu chưa giải ngân.'), findsOneWidget);
    });

    testWidgets('a cell below the period before asks for an explanation, which is kept with the draft', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      app.server.previous = <String, String>{'CURRENT_YEAR:CENTRAL': '300000000'};
      await app.open(tester);
      final String id = await newDraft(app, shape: (ReportForm f) => f.withCell(kCells.first, const CellEntry(cumulative: '100.000.000')));
      await app.open(tester, location: '/projects/mob-15/$id');

      expect(find.text('Giải trình khi số giảm'), findsOneWidget);
      expect(find.text('Thay đổi so với kỳ trước: -200 triệu đồng'), findsOneWidget);
      await typeInto(tester, 'Giải trình khi số giảm', 'Điều chỉnh sau đối chiếu với Kho bạc');
      expect((await app.drafts).read(id)!.form.explanation, 'Điều chỉnh sau đối chiếu với Kho bạc');
      await typeInto(tester, 'Lũy kế giải ngân Vốn năm NSTW', '300.000.000');
      expect(find.text('Giải trình khi số giảm'), findsNothing, reason: 'no cell is below the period before any more');
    });

    testWidgets('the vốn đã giao and the period before are told with the moment they describe; without them the screen says they are not here', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      app.server.previous = <String, String>{'CURRENT_YEAR:CENTRAL': '90000000'};
      await app.open(tester);
      final String id = await newDraft(app);
      final String bare = await newDraft(app, onServer: false, shape: (ReportForm f) => f);
      await app.open(tester, location: '/projects/mob-15/$id');
      expect(find.textContaining('Vốn đã giao và số kỳ trước: số liệu tại'), findsOneWidget);
      expect(fact('Vốn đã giao', '500 triệu đồng'), findsOneWidget);
      expect(fact('Lũy kế kỳ trước', '90 triệu đồng'), findsOneWidget);
      app.server.offline = true;
      await app.open(tester, location: '/projects/mob-15/$bare');
      expect(find.textContaining('Chưa có số vốn đã giao và số kỳ trước'), findsOneWidget);
    });
  });

  group('AC-ST-MOB-011-1 UI-MOB-15 the app is killed after the fourth step and the draft comes back with the same values, the same UUID and a saved indicator', () {
    testWidgets('the figures typed on MOB-15, MOB-16 and MOB-17 are there after the process is killed', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester);
      final String id = await newDraft(app);
      await app.open(tester, location: '/projects/mob-15/$id');

      await typeInto(tester, 'Lũy kế giải ngân Vốn năm NSTW', '400.000.000');
      await typeInto(tester, 'Trong đó CTMTQG của Vốn năm NSTW', '40.000.000');
      await typeInto(tester, 'Lũy kế giải ngân Vốn năm NSĐP', '20.000.000');
      await press(tester, 'Tiếp tục');
      expect(find.text('Nhập vốn kéo dài'), findsOneWidget);
      await typeInto(tester, 'Lũy kế giải ngân Kéo dài NSĐP', '7.000.000');
      await press(tester, 'Tiếp tục');
      expect(find.text('Nhập vốn khác'), findsOneWidget);
      await typeInto(tester, 'Lũy kế giải ngân Vốn khác NSĐP', '5.500.000');
      expect(find.textContaining('Đã lưu nháp trên máy lúc'), findsOneWidget);

      await app.kill(tester);
      await app.open(tester, location: '/projects/mob-15/$id');
      expect(await onlyDraftId(app), id, reason: 'the same local UUID');
      expect(textOf(tester, 'Lũy kế giải ngân Vốn năm NSTW'), '400.000.000');
      expect(textOf(tester, 'Trong đó CTMTQG của Vốn năm NSTW'), '40.000.000');
      expect(textOf(tester, 'Lũy kế giải ngân Vốn năm NSĐP'), '20.000.000');
      expect(find.textContaining('Đã lưu nháp trên máy lúc'), findsOneWidget);
      expect(find.textContaining('mã nháp ${id.substring(0, 8)}'), findsOneWidget);
      expect(fact('Tổng lũy kế sáu ô', '432,5 triệu đồng'), findsOneWidget);
      await app.open(tester, location: '/projects/mob-17/$id');
      expect(textOf(tester, 'Lũy kế giải ngân Vốn khác NSĐP'), '5.500.000');
    });
  });

  group('AC-ST-MOB-011-4 UI-MOB-16 a field that does not apply shows "Không áp dụng" and not a zero input', () {
    testWidgets('MOB-16: the carried-over funds the plan did not give are not an input; the ones it did are', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester);
      final String id = await newDraft(app);
      await app.open(tester, location: '/projects/mob-16/$id');

      expect(find.text('Nhập vốn kéo dài'), findsOneWidget);
      expect(find.textContaining('Không áp dụng. Dự án không được giao vốn kéo dài ở nguồn NSTW'), findsOneWidget);
      expect(find.widgetWithText(TextField, 'Lũy kế giải ngân Kéo dài NSTW'), findsNothing, reason: 'no zero input for a field that does not apply');
      expect(find.widgetWithText(TextField, 'Trong đó CTMTQG của Kéo dài NSTW'), findsNothing);
      expect(find.widgetWithText(TextField, 'Lũy kế giải ngân Kéo dài NSĐP'), findsOneWidget);
      expect(find.widgetWithText(TextField, 'Trong đó CTMTQG của Kéo dài NSĐP'), findsOneWidget);
      expect(find.textContaining('Không áp dụng. Dự án không được giao vốn kéo dài ở nguồn NSĐP'), findsNothing);
    });

    testWidgets('a carried-over figure that was entered is never hidden', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester);
      final String id = await newDraft(app, shape: (ReportForm f) => f.withCell(const CellKey('CARRYOVER', 'CENTRAL'), const CellEntry(cumulative: '5.000')));
      await app.open(tester, location: '/projects/mob-16/$id');
      expect(find.widgetWithText(TextField, 'Lũy kế giải ngân Kéo dài NSTW'), findsOneWidget);
      expect(find.textContaining('Không áp dụng. Dự án không được giao'), findsNothing);
    });

    testWidgets('MOB-17: the other sources have no CTMTQG, said in words and not as an input', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester);
      final String id = await newDraft(app);
      await app.open(tester, location: '/projects/mob-17/$id');
      expect(find.text('Nhập vốn khác'), findsOneWidget);
      expect(find.text('Trong đó CTMTQG: Không áp dụng. Vốn khác không có phần CTMTQG.'), findsNWidgets(2));
      expect(find.widgetWithText(TextField, 'Lũy kế giải ngân Vốn khác NSTW'), findsOneWidget);
      expect(find.byWidgetPredicate((Widget w) => w is TextField && (w.decoration?.labelText ?? '').startsWith('Trong đó CTMTQG')), findsNothing);
    });

    testWidgets('with no allocation from the server nothing is judged not applicable', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester);
      final String id = await newDraft(app, onServer: false);
      app.server.offline = true;
      await app.open(tester, location: '/projects/mob-16/$id');
      expect(find.widgetWithText(TextField, 'Lũy kế giải ngân Kéo dài NSTW'), findsOneWidget);
    });
  });

  group('UI-MOB-18 MOB-18 registers next month by source with the CTMTQG inside it', () {
    testWidgets('the month, what is left to disburse and the totals; each box is kept in the draft', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester);
      final String id = await newDraft(app, shape: (ReportForm f) => f.withCell(kCells.first, const CellEntry(cumulative: '200.000.000')));
      await app.open(tester, location: '/projects/mob-18/$id');

      expect(find.text('Đăng ký tháng sau'), findsOneWidget);
      expect(find.text('Đăng ký cho tháng 12/2026.'), findsOneWidget);
      expect(fact('Còn lại chưa giải ngân', '300 triệu đồng'), findsNWidgets(2), reason: 'the year plan, central and local');
      await typeInto(tester, 'Đăng ký tháng sau của Vốn năm NSTW', '300.000.000');
      await typeInto(tester, 'Trong đó CTMTQG đăng ký tháng sau của Vốn năm NSTW', '30.000.000');
      await typeInto(tester, 'Đăng ký tháng sau của Vốn khác NSĐP', '10.000.000');
      expect(fact('Tổng đăng ký tháng sau', '310 triệu đồng'), findsOneWidget);
      expect(fact('Trong đó CTMTQG (không cộng vào tổng)', '30 triệu đồng'), findsOneWidget);
      final ReportForm saved = (await app.drafts).read(id)!.form;
      expect(saved.cell(kCells.first).nextMonth, '300.000.000');
      expect(saved.cell(kCells.first).nextCtmtqg, '30.000.000');
      expect(saved.cell(kCells.first).cumulative, '200.000.000', reason: 'a step does not overwrite what another step entered');
      await typeInto(tester, 'Trong đó CTMTQG đăng ký tháng sau của Vốn năm NSTW', '300.000.001');
      expect(find.text('Số trong đó CTMTQG không được lớn hơn số của ô.'), findsOneWidget);
    });

    testWidgets('a carried-over cell with nothing allocated is not an input here either; the estimate of the end of the period is one tap away', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester);
      final String id = await newDraft(app);
      await app.open(tester, location: '/projects/mob-18/$id');
      expect(find.widgetWithText(TextField, 'Đăng ký tháng sau của Kéo dài NSTW'), findsNothing);
      expect(find.widgetWithText(TextField, 'Đăng ký tháng sau của Kéo dài NSĐP'), findsOneWidget);
      await press(tester, 'Nhập ước giải ngân cuối kỳ');
      expect(find.text('Ước giải ngân cuối kỳ'), findsWidgets);
      expect(find.text('Giả định'), findsOneWidget);
    });
  });

  group('AC-ST-MOB-011-6 UI-MOB-55 MOB-55 keeps the notes of the report', () {
    testWidgets('a monthly report needs the causes, says so beside the box and keeps what is written', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester);
      final String id = await newDraft(app, type: kMonthly);
      await app.open(tester, location: '/projects/mob-55/$id');

      expect(find.text('Thuyết minh'), findsWidgets);
      expect(find.textContaining('Nguyên nhân là bắt buộc khi gửi báo cáo tháng'), findsOneWidget);
      expect(find.text('Chưa có nguyên nhân: báo cáo tháng chưa gửi được.'), findsOneWidget);
      await typeInto(tester, 'Kết quả đạt được', 'Hoàn thành phần móng');
      await typeInto(tester, 'Nguyên nhân (bắt buộc khi gửi)', 'Mưa kéo dài');
      await typeInto(tester, 'Giải pháp', 'Tăng ca');
      await typeInto(tester, 'Kiến nghị', 'Gia hạn tiến độ');
      expect(find.text('Chưa có nguyên nhân: báo cáo tháng chưa gửi được.'), findsNothing);
      final ReportForm saved = (await app.drafts).read(id)!.form;
      expect(saved.results, 'Hoàn thành phần móng');
      expect(saved.causes, 'Mưa kéo dài');
      expect(saved.solutions, 'Tăng ca');
      expect(saved.proposals, 'Gia hạn tiến độ');
    });

    testWidgets('a weekly report may leave every section empty; a section over 4000 characters is told', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester);
      final String id = await newDraft(app);
      await app.open(tester, location: '/projects/mob-55/$id');
      expect(find.textContaining('Không bắt buộc đối với báo cáo tuần'), findsOneWidget);
      expect(find.text('Nguyên nhân'), findsOneWidget);
      await typeInto(tester, 'Giải pháp', 'a' * 4001);
      expect(find.text('Dài quá giới hạn.'), findsOneWidget);
    });

    Future<void> openNarrative(WidgetTester tester, ReportingApp app, {String? id}) async {
      await app.open(tester, location: '/projects/mob-55/${id ?? 'missing'}');
    }

    testWidgets('default, a draft that is not there, loading, a store that cannot be opened, an ended session', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      ReportingApp app = ReportingApp.create();
      await app.open(tester);
      final String id = await newDraft(app);
      await openNarrative(tester, app, id: id);
      expect(find.text('Kết quả đạt được'), findsWidgets, reason: 'default');

      app = ReportingApp.create();
      await openNarrative(tester, app);
      expect(find.text('Chưa có dữ liệu'), findsOneWidget, reason: 'empty: no such draft on the phone');

      final Completer<void> gate = Completer<void>();
      app = ReportingApp.create();
      await app.open(tester, location: '/projects/mob-55/x', overrides: <Override>[
        reportDraftsProviderOverride(() async {
          await gate.future;
          throw StateError('never');
        }),
      ]);
      expect(find.byType(LoadingView), findsOneWidget, reason: 'loading');
      gate.complete();
      await tester.pumpAndSettle();

      app = ReportingApp.create();
      await app.open(tester, location: '/projects/mob-55/x', overrides: <Override>[reportDraftsProviderOverride(() async => throw StateError('disk'))]);
      expect(find.text('Chưa thể tải dữ liệu'), findsOneWidget, reason: 'error');
      expect(find.text('CLIENT_ERROR'), findsOneWidget);

      app = ReportingApp.create();
      await app.open(tester, location: '/projects/mob-55/x', overrides: <Override>[reportDraftsProviderOverride(() async => throw const OfflineUnavailable())]);
      expect(find.text('Phiên làm việc đã hết hạn'), findsOneWidget, reason: 'signed out');
      expect(find.text('SESSION_EXPIRED'), findsOneWidget);
    });

    testWidgets('no connection, no right and an expired licence are told above the notes, which stay', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      ReportingApp app = ReportingApp.create();
      await app.open(tester);
      String id = await newDraft(app, shape: (ReportForm f) => f.copyWith(results: 'Đã viết'));
      final ProviderContainer container = await app.open(tester, location: '/projects/mob-55/$id');
      container.read(reachabilityProvider.notifier).report(Reachability.offline);
      await tester.pumpAndSettle();
      expect(find.textContaining('Đang ngoại tuyến. Bản nháp được giữ trên máy'), findsOneWidget, reason: 'offline');
      expect(textOf(tester, 'Kết quả đạt được'), 'Đã viết');

      app = ReportingApp.create();
      await app.open(tester);
      id = await newDraft(app, shape: (ReportForm f) => f.copyWith(results: 'Đã viết'));
      app.server.api.refuse('GET', '/reports/:id', 403, 'SCOPE_DENIED');
      await app.open(tester, location: '/projects/mob-55/$id');
      expect(find.textContaining('Bạn không có quyền thực hiện việc này với dự án này'), findsOneWidget, reason: 'denied');
      expect(textOf(tester, 'Kết quả đạt được'), 'Đã viết');

      app = ReportingApp.create();
      await app.open(tester);
      id = await newDraft(app, shape: (ReportForm f) => f.copyWith(results: 'Đã viết'));
      app.server.api.refuse('GET', '/reports/:id', 422, 'LICENSE_EXPIRED');
      await app.open(tester, location: '/projects/mob-55/$id');
      expect(find.textContaining('License đã hết hạn nên chưa gửi được'), findsOneWidget, reason: 'expired licence');
      expect(textOf(tester, 'Kết quả đạt được'), 'Đã viết');
      expect(tester.takeException(), isNull);
    });

    testWidgets('three devices, text at 200 percent, tap targets, labels and contrast', (WidgetTester tester) async {
      final ReportingApp app = ReportingApp.create();
      final String id = await _preparedDraft(tester, app, type: kMonthly);
      for (final Size size in kDeviceSizes) {
        for (final double scale in <double>[1.0, 2.0]) {
          useDevice(tester, size, textScale: scale);
          final SemanticsHandle semantics = tester.ensureSemantics();
          await app.open(tester, location: '/projects/mob-55/$id');
          await _expectContract(tester, '${size.width.toInt()}x${size.height.toInt()} at $scale');
          semantics.dispose();
        }
      }
    });
  });

  group('AC-ST-MOB-011-7 UI-MOB-56 MOB-56 sends the estimate of the end of the period once, and keeps it until it is sent', () {
    Future<String> prepared(WidgetTester tester, ReportingApp app) async {
      await app.open(tester);
      return newDraft(app);
    }

    testWidgets('the month, the source, the amount and the assumption go as one command of the capital plan; what was typed is then cleared', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      final String id = await prepared(tester, app);
      await app.open(tester, location: '/projects/mob-56/$id');

      await tester.tap(find.byType(DropdownButtonFormField<String>).first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Tháng 11').last);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Vốn năm NSTW').last);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Kéo dài NSĐP').last);
      await tester.pumpAndSettle();
      await typeInto(tester, 'Ước thực hiện', '1.250.000');
      await typeInto(tester, 'Giả định', 'Nghiệm thu đợt 2 hoàn tất trong tháng');
      expect(find.text('1,25 triệu đồng'), findsOneWidget);
      await press(tester, 'Gửi ước');

      expect(app.server.schedules, hasLength(1));
      expect(app.server.schedules.single, <String, Object?>{
        'project_id': projectId,
        'plan_year': 2026,
        'granularity': 'MONTH',
        'month': 11,
        'kind': 'FORECAST',
        'bucket': 'CARRYOVER',
        'budget_level': 'LOCAL',
        'amount_vnd': '1250000',
        'assumption': 'Nghiệm thu đợt 2 hoàn tất trong tháng',
      });
      expect(find.text('Đã ghi ước tháng 11.'), findsOneWidget);
      expect((await app.drafts).readEstimate(id).isEmpty, isTrue);
      expect(textOf(tester, 'Ước thực hiện'), '');
    });

    testWidgets('an incomplete estimate is not sent; each missing part is told', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      final String id = await prepared(tester, app);
      await app.open(tester, location: '/projects/mob-56/$id');
      await press(tester, 'Gửi ước');
      expect(app.server.schedules, isEmpty);
      expect(find.text('Chọn tháng.'), findsOneWidget);
      expect(find.text('Nhập số tiền, hoặc 0 nếu chưa giải ngân.'), findsOneWidget);
      expect(find.text('Nêu giả định của số ước.'), findsOneWidget);
    });

    testWidgets('what was typed is kept on the phone, also across a kill, until it is sent', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      final String id = await prepared(tester, app);
      await app.open(tester, location: '/projects/mob-56/$id');
      await typeInto(tester, 'Ước thực hiện', '2.000.000');
      await typeInto(tester, 'Giả định', 'Chờ phê duyệt');
      await app.kill(tester);
      await app.open(tester, location: '/projects/mob-56/$id');
      expect(textOf(tester, 'Ước thực hiện'), '2.000.000');
      expect(textOf(tester, 'Giả định'), 'Chờ phê duyệt');
    });

    testWidgets('a lost answer keeps the estimate and sending it again is the same command, not a second', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      final String id = await prepared(tester, app);
      await app.open(tester, location: '/projects/mob-56/$id');
      await tester.tap(find.byType(DropdownButtonFormField<String>).first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Tháng 12').last);
      await tester.pumpAndSettle();
      await typeInto(tester, 'Ước thực hiện', '5.000');
      await typeInto(tester, 'Giả định', 'Giả định');
      bool lose = true;
      app.server.api.answer('POST', '/disbursement-schedules', (HttpCall call) {
        app.server.schedules.add(<String, Object?>{'key': call.headers['idempotency-key']});
        if (lose) {
          lose = false;
          throw const SocketException('lost');
        }
        return FakeTransport.json(200, <String, Object?>{'operation_id': 'x', 'status': 'REGISTERED', 'resource_version': 1, 'resource_id': 's'});
      });
      await press(tester, 'Gửi ước');
      expect(find.textContaining('Chưa nhận được trả lời'), findsOneWidget);
      expect(textOf(tester, 'Ước thực hiện'), '5.000');
      await press(tester, 'Gửi ước');
      expect(find.text('Đã ghi ước tháng 12.'), findsOneWidget);
      expect(app.server.schedules.map((Map<String, Object?> s) => s['key']).toSet(), hasLength(1), reason: 'both requests carried the same idempotency key');
      expect(app.server.schedules, hasLength(2));
    });

    testWidgets('a refusal is told in words and the estimate stays; with no network it cannot be sent and says why', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      final String id = await prepared(tester, app);
      await app.open(tester, location: '/projects/mob-56/$id');
      await typeInto(tester, 'Ước thực hiện', '5.000');
      await typeInto(tester, 'Giả định', 'Giả định');
      await tester.tap(find.byType(DropdownButtonFormField<String>).first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Tháng 3').last);
      await tester.pumpAndSettle();
      app.server.api.refuse('POST', '/disbursement-schedules', 403, 'SCOPE_DENIED');
      await press(tester, 'Gửi ước');
      expect(find.text('Bạn không có quyền thực hiện việc này với dự án này.'), findsWidgets);
      expect(textOf(tester, 'Ước thực hiện'), '5.000');
      expect((await app.drafts).readEstimate(id).amount, '5.000');

      app.container.read(reachabilityProvider.notifier).report(Reachability.offline);
      await tester.pumpAndSettle();
      expect(find.textContaining('Ước chỉ gửi được khi có mạng'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Gửi ước')).onPressed, isNull);
    });

    testWidgets('a read-only tenant cannot send; a draft with no plan year cannot be sent', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      final String id = await prepared(tester, app);
      await app.open(tester, location: '/projects/mob-56/$id', session: FakeSession(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1', mode: SessionMode.readOnly)));
      expect(find.textContaining('chế độ chỉ xem'), findsWidgets);
      expect(isEnabled(tester, 'Ước thực hiện'), isFalse);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Gửi ước')).onPressed, isNull);
    });

    testWidgets('three devices, text at 200 percent, tap targets, labels and contrast', (WidgetTester tester) async {
      final ReportingApp app = ReportingApp.create();
      final String id = await _preparedDraft(tester, app);
      for (final Size size in kDeviceSizes) {
        for (final double scale in <double>[1.0, 2.0]) {
          useDevice(tester, size, textScale: scale);
          final SemanticsHandle semantics = tester.ensureSemantics();
          await app.open(tester, location: '/projects/mob-56/$id');
          await _expectContract(tester, '${size.width.toInt()}x${size.height.toInt()} at $scale');
          semantics.dispose();
        }
      }
    });

    testWidgets('the states: nothing on the phone, an ended session, no right and an expired licence on the draft behind it', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      ReportingApp app = ReportingApp.create();
      await app.open(tester, location: '/projects/mob-56/missing');
      expect(find.text('Chưa có dữ liệu'), findsOneWidget);
      app = ReportingApp.create();
      await app.open(tester, location: '/projects/mob-56/x', overrides: <Override>[reportDraftsProviderOverride(() async => throw const OfflineUnavailable())]);
      expect(find.text('Phiên làm việc đã hết hạn'), findsOneWidget);
      app = ReportingApp.create();
      await app.open(tester);
      final String id = await newDraft(app);
      app.server.api.refuse('GET', '/reports/:id', 403, 'SCOPE_DENIED');
      await app.open(tester, location: '/projects/mob-56/$id');
      expect(find.textContaining('Bạn không có quyền thực hiện việc này'), findsOneWidget);
      expect(find.text('Gửi ước'), findsOneWidget, reason: 'the form stays');
    });
  });

  group('AC-ST-MOB-011-1 UI-MOB-14 UI-MOB-15 UI-MOB-20 a step kept on the stack works on the draft as it is now, never on the copy it was opened with', () {
    testWidgets('what was typed at the next step is still there after the person goes back and types at this one', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester);
      final String id = await newDraft(app, onServer: false);
      await app.open(tester, location: '/projects/mob-14/$id');
      await typeInto(tester, 'Khối lượng thi công', '1.500.000.000');

      await press(tester, 'Tiếp tục');
      expect(find.text('Nhập vốn năm'), findsOneWidget);
      await typeInto(tester, 'Lũy kế giải ngân Vốn năm NSTW', '400.000.000');
      await press(tester, 'Quay lại');
      expect(find.text('Nhập khối lượng'), findsOneWidget);
      await typeInto(tester, 'Khối lượng nghiệm thu', '1.250.000.000');

      final ReportForm saved = (await app.drafts).read(id)!.form;
      expect(saved.cell(kCells.first).cumulative, '400.000.000', reason: 'typed at the next step, which this step knew nothing about');
      expect(saved.construction, '1.500.000.000');
      expect(saved.acceptance, '1.250.000.000');
    });

    testWidgets('a change of the draft made elsewhere, with nothing to tell this step, is not erased by the next thing typed here', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester);
      final String id = await newDraft(app, onServer: false);
      await app.open(tester, location: '/projects/mob-14/$id');
      await typeInto(tester, 'Khối lượng thi công', '1.500.000.000');

      final ReportDrafts drafts = await app.drafts;
      drafts.writeForm(id, drafts.read(id)!.form.withCell(kCells.first, const CellEntry(cumulative: '400.000.000')));
      await typeInto(tester, 'Khối lượng nghiệm thu', '1.250.000.000');

      final ReportForm saved = drafts.read(id)!.form;
      expect(saved.cell(kCells.first).cumulative, '400.000.000', reason: 'the write of this step is made on the draft as it is on the device');
      expect(saved.construction, '1.500.000.000');
      expect(saved.acceptance, '1.250.000.000');
    });

    testWidgets('the review shows what is wrong now: the step that fixed it is left and the error is gone from the screen that comes back', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester);
      final String id = await newDraft(app, shape: (ReportForm f) => completeForm().copyWith(planVersionId: f.planVersionId, construction: '', acceptance: ''));
      await app.open(tester, location: '/projects/mob-20/$id');
      expect(find.textContaining('Chưa nhập khối lượng thi công, nghiệm thu'), findsOneWidget);
      expect(find.text('Báo cáo còn lỗi nên chưa gửi được.'), findsOneWidget);

      await press(tester, 'Sửa tại bước này');
      expect(find.text('Nhập khối lượng'), findsOneWidget);
      await typeInto(tester, 'Khối lượng thi công', '300.000.000');
      await typeInto(tester, 'Khối lượng nghiệm thu', '250.000.000');
      await press(tester, 'Quay lại');

      expect(find.textContaining('Chưa nhập khối lượng thi công, nghiệm thu'), findsNothing, reason: 'the review was read again when the person came back');
      expect(find.text('Báo cáo còn lỗi nên chưa gửi được.'), findsNothing);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Nộp báo cáo')).onPressed, isNotNull);
    });
  });

  group('a draft that is waiting in the queue is read only, with the reason beside it', () {
    testWidgets('the boxes cannot be typed into and the notice leads to the queue', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester);
      final String id = await newDraft(app, shape: (ReportForm f) => completeForm().copyWith(planVersionId: f.planVersionId));
      final DraftSnapshot snapshot = (await app.drafts).read(id)!;
      final CommandQueue queue = await app.container.read(commandQueueProvider.future);
      queue.enqueue(commandType: kSaveCommand, payload: snapshot.form.toPayload(snapshot.reportId!), baseServerVersion: snapshot.draft.baseServerVersion, draftId: id);
      app.server.offline = true;
      await app.open(tester, location: '/projects/mob-15/$id');
      expect(isEnabled(tester, 'Lũy kế giải ngân Vốn năm NSTW'), isFalse);
      expect(find.textContaining('Bản nháp đang chờ gửi hoặc chờ kết quả nên chưa sửa được'), findsOneWidget);
      await press(tester, 'Xem hàng đợi gửi');
      expect(find.text('Hàng đợi gửi'), findsOneWidget);
      expect((await app.drafts).read(id)!.draft.status, DraftStatus.queued);
    });

    testWidgets('a refused draft shows the code and can be edited again', (WidgetTester tester) async {
      useDevice(tester, kTallPhone);
      final ReportingApp app = ReportingApp.create();
      await app.open(tester);
      final String id = await newDraft(app, shape: (ReportForm f) => completeForm().copyWith(planVersionId: f.planVersionId));
      final DraftSnapshot snapshot = (await app.drafts).read(id)!;
      final CommandQueue queue = await app.container.read(commandQueueProvider.future);
      app.server.periodLocked = true;
      final QueuedCommand command = queue.enqueue(commandType: kSaveCommand, payload: snapshot.form.toPayload(snapshot.reportId!), baseServerVersion: snapshot.draft.baseServerVersion, draftId: id);
      await queue.flush();
      expect(queue.command(command.id)!.state, CommandState.rejected);
      await app.open(tester, location: '/projects/mob-15/$id');
      expect(find.textContaining('Kỳ đã khóa sổ. Chỉ lập hoặc nộp được'), findsOneWidget);
      expect(find.textContaining('Mã lỗi: PERIOD_LOCKED'), findsOneWidget);
      expect(isEnabled(tester, 'Lũy kế giải ngân Vốn năm NSTW'), isTrue);
    });
  });
}

Future<String> _preparedDraft(WidgetTester tester, ReportingApp app, {String type = kWeekly}) async {
  useDevice(tester, kDeviceSizes[1]);
  await app.open(tester);
  return newDraft(app, type: type, shape: (ReportForm f) => completeForm(reportType: type).copyWith(planVersionId: f.planVersionId));
}

/// The checks every screen of the application keeps: no layout exception, tap targets large enough on both platforms and labelled,
/// and readable text.
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
