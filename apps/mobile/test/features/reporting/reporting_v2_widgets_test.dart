import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/l10n/string_table.dart';
import 'package:machvon_mobile/core/offline/queue/queued_command.dart';
import 'package:machvon_mobile/core/theme/machvon_semantic.dart';
import 'package:machvon_mobile/features/field_evidence/field_evidence_strings.dart';
import 'package:machvon_mobile/features/reporting/data/submit_flow.dart';
import 'package:machvon_mobile/features/reporting/model/report_review.dart';
import 'package:machvon_mobile/features/reporting/reporting_strings.dart';
import 'package:machvon_mobile/features/reporting/screens/drafts_screen.dart';
import 'package:machvon_mobile/features/reporting/screens/review_screen.dart';
import 'package:machvon_mobile/features/reporting/widgets/draft_host.dart';
import 'package:machvon_mobile/features/reporting/widgets/draft_text_field.dart';
import 'package:machvon_mobile/features/reporting/widgets/money_field.dart';
import 'package:machvon_mobile/features/reporting/widgets/notices.dart';

import '../../support/v2_support.dart';
import 'reporting_fixtures.dart';

const List<StringTable> _tables = <StringTable>[reportingStrings, fieldEvidenceStrings];

QueuedCommand _command({String type = kSubmitCommand, CommandState state = CommandState.rejected, String? code}) => QueuedCommand(
      id: 'c1',
      tenantId: 't',
      userId: 'u',
      commandType: type,
      payload: null,
      payloadBytes: 0,
      baseServerVersion: 1,
      idempotencyKey: 'key-1',
      state: state,
      createdAt: 0,
      updatedAt: 0,
      errorCode: code,
    );

Future<void> _outcome(WidgetTester tester, SubmitStatus status, {bool busy = false, VoidCallback? onCheck, VoidCallback? onCompare, VoidCallback? onQueue}) => pumpV2(
      tester,
      SingleChildScrollView(child: SendOutcomePanel(status: status, busy: busy, onCheck: onCheck ?? () {}, onQueue: onQueue ?? () {}, onCompare: onCompare ?? () {})),
      tables: _tables,
    );

void main() {
  group('MoneyField and DraftTextField are v2 form fields', () {
    testWidgets('an amount is 48 high, has a number pad, the unit beside it and the same amount in the unit that fits it, exact', (WidgetTester tester) async {
      await pumpV2(tester, Padding(padding: const EdgeInsets.all(16), child: MoneyField(label: 'Khối lượng thi công', value: '', onChanged: (_) {})), tables: _tables);
      final Finder box = find.widgetWithText(TextField, 'Khối lượng thi công');
      expect(tester.widget<TextField>(box).keyboardType, TextInputType.number);
      expect(tester.getSize(box).height, greaterThanOrEqualTo(48));
      expect(find.text('đồng'), findsOneWidget, reason: 'the unit is beside the box');

      await tester.enterText(box, '1500000000');
      await tester.pump();
      expect(find.text('1,5 tỷ đồng'), findsOneWidget, reason: 'the amount in the unit that fits it');
      await tester.enterText(box, '1.049.123.456');
      await tester.pump();
      expect(find.text('1.049.123.456 đồng'), findsOneWidget, reason: 'exact: no digit is hidden');
    });

    testWidgets('a text that is not an amount is told under the box at once, in words', (WidgetTester tester) async {
      await pumpV2(tester, Padding(padding: const EdgeInsets.all(16), child: MoneyField(label: 'Khối lượng thi công', value: '12-3', onChanged: (_) {})), tables: _tables);
      expect(find.text('Chỉ nhập số nguyên đồng, không âm.'), findsOneWidget);
    });

    testWidgets('the error of the review replaces the helper and the keyboard accepts digits and the separators of thousands only', (WidgetTester tester) async {
      await pumpV2(tester, Padding(padding: const EdgeInsets.all(16), child: MoneyField(label: 'Lũy kế', value: '5', error: 'Nhập số tiền, hoặc 0 nếu chưa giải ngân.', onChanged: (_) {})), tables: _tables);
      expect(find.text('Nhập số tiền, hoặc 0 nếu chưa giải ngân.'), findsOneWidget);
      await tester.enterText(find.widgetWithText(TextField, 'Lũy kế'), 'ab1.2c');
      await tester.pump();
      expect(tester.widget<TextField>(find.widgetWithText(TextField, 'Lũy kế')).controller!.text, '1.2');
    });

    testWidgets('a text box is 48 high at least, shows its helper and its error, and a long text is a multiline box', (WidgetTester tester) async {
      await pumpV2(
        tester,
        Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            children: <Widget>[
              DraftTextField(label: 'Tiến độ thực hiện', value: '', suffix: '%', helper: 'Không bắt buộc.', error: 'Phần trăm phải từ 0 đến 100.', keyboardType: const TextInputType.numberWithOptions(decimal: true), onChanged: (_) {}),
              DraftTextField(label: 'Nguyên nhân', value: '', maxLines: 5, onChanged: (_) {}),
            ],
          ),
        ),
        tables: _tables,
      );
      expect(tester.getSize(find.widgetWithText(TextField, 'Tiến độ thực hiện')).height, greaterThanOrEqualTo(48));
      expect(find.text('Phần trăm phải từ 0 đến 100.'), findsOneWidget);
      expect(tester.widget<TextField>(find.widgetWithText(TextField, 'Nguyên nhân')).keyboardType, TextInputType.multiline);
    });
  });

  group('the strips and the context of a draft', () {
    testWidgets('offline is one strip, never two; a read-only tenant is a second, different strip', (WidgetTester tester) async {
      await pumpV2(tester, const DraftBanners(offline: true, readOnlySession: false), tables: _tables);
      expect(find.text('Đang ngoại tuyến. Bản nháp được giữ trên máy và gửi khi có mạng.'), findsOneWidget);
      await pumpV2(tester, const DraftBanners(offline: true, readOnlySession: true), tables: _tables);
      expect(find.textContaining('Đang ngoại tuyến'), findsOneWidget);
      expect(find.textContaining('chế độ chỉ xem'), findsOneWidget);
      await pumpV2(tester, const DraftBanners(offline: false, readOnlySession: false), tables: _tables);
      expect(find.byType(Text), findsNothing);
    });

    testWidgets('the context line holds the project, the period, the step and the time it was saved, at 200 percent too', (WidgetTester tester) async {
      for (final double scale in <double>[1.0, 2.0]) {
        await pumpV2(
          tester,
          const DraftContext(line: 'Dự án DA-2026-002 · Kỳ W2026-45', name: 'Đường vành đai 3', step: 'Bước 2/8', saved: 'Đã lưu nháp trên máy lúc 03/11/2026 10:20 · mã nháp 1a2b3c4d'),
          scale: scale,
          size: const Size(360, 800),
          tables: _tables,
        );
        expect(tester.takeException(), isNull, reason: 'at $scale');
        expect(find.text('Bước 2/8'), findsOneWidget);
        expect(find.textContaining('Đã lưu nháp trên máy lúc'), findsOneWidget);
      }
    });
  });

  group('the outcome of the sending is one panel with its way out', () {
    testWidgets('waiting in the queue: Send now and the queue; on its way: only the queue; nothing: nothing', (WidgetTester tester) async {
      int checks = 0;
      int queues = 0;
      await _outcome(tester, SubmitStatus(SubmitStage.queued, _command(state: CommandState.queued)), onCheck: () => checks += 1, onQueue: () => queues += 1);
      expect(find.text('Lệnh nộp đã xếp hàng, sẽ gửi khi có mạng.'), findsOneWidget);
      await tester.tap(find.text('Gửi ngay'));
      await tester.tap(find.text('Xem hàng đợi gửi'));
      expect((checks, queues), (1, 1));

      await _outcome(tester, SubmitStatus(SubmitStage.sending, _command(state: CommandState.sending)));
      expect(find.text('Đang gửi lên máy chủ...'), findsOneWidget);
      expect(find.text('Gửi ngay'), findsNothing);
      expect(find.text('Xem hàng đợi gửi'), findsOneWidget);

      await _outcome(tester, const SubmitStatus(SubmitStage.idle));
      expect(find.byType(Text), findsNothing);
    });

    testWidgets('the answer was lost: "result unknown" and Check the result, which asks by the key and sends nothing new', (WidgetTester tester) async {
      int checks = 0;
      await _outcome(tester, SubmitStatus(SubmitStage.unknown, _command(state: CommandState.unknown)), onCheck: () => checks += 1);
      expect(find.textContaining('Chưa xác định kết quả'), findsOneWidget);
      expect(find.textContaining('không gửi lệnh mới'), findsOneWidget);
      await tester.tap(find.text('Kiểm tra kết quả'));
      expect(checks, 1);
    });

    testWidgets('refused: the words, the stable code, the draft kept and Send again; a submit that cannot be verified offers the queue only', (WidgetTester tester) async {
      int checks = 0;
      await _outcome(tester, SubmitStatus(SubmitStage.rejected, _command(code: 'PERIOD_LOCKED')), onCheck: () => checks += 1);
      expect(find.textContaining('Kỳ đã khóa sổ'), findsOneWidget);
      expect(find.text('Mã lỗi: PERIOD_LOCKED'), findsOneWidget);
      expect(find.text('Bản nháp vẫn được giữ trên máy.'), findsOneWidget);
      await tester.tap(find.text('Gửi lại'));
      expect(checks, 1);

      await _outcome(tester, SubmitStatus(SubmitStage.rejected, _command(code: 'RESULT_UNVERIFIABLE')));
      expect(find.text('Gửi lại'), findsNothing, reason: 'a new key could make the report twice');
      expect(find.text('Mã lỗi: RESULT_UNVERIFIABLE'), findsOneWidget);
      expect(find.text('Xem hàng đợi gửi'), findsOneWidget);

      await _outcome(tester, SubmitStatus(SubmitStage.rejected, _command(type: kSaveCommand, code: 'VALIDATION_FAILED')));
      expect(find.text('Gửi lại'), findsNothing, reason: 'the save is not the sending');
    });

    testWidgets('conflict: the code and Compare, which opens the comparison', (WidgetTester tester) async {
      int compares = 0;
      await _outcome(tester, SubmitStatus(SubmitStage.conflict, _command(state: CommandState.conflict, code: 'VERSION_CONFLICT')), onCompare: () => compares += 1);
      expect(find.textContaining('Báo cáo đã thay đổi trên máy chủ'), findsOneWidget);
      expect(find.text('Mã lỗi: VERSION_CONFLICT'), findsOneWidget);
      await tester.tap(find.text('So sánh hai bản'));
      expect(compares, 1);
    });

    testWidgets('a retry that is already on its way cannot be started again', (WidgetTester tester) async {
      await _outcome(tester, SubmitStatus(SubmitStage.unknown, _command(state: CommandState.unknown)), busy: true);
      expect(find.text('Kiểm tra kết quả'), findsNothing);
    });
  });

  group('the review is rows under headings, each finding with the step where it is put right', () {
    ReviewList list({List<Finding> errors = const <Finding>[], List<Finding> warnings = const <Finding>[], void Function(String)? onFix, ReviewFiles? files}) => ReviewList(
          form: completeForm(),
          reportContext: chosenOnly,
          errors: errors,
          warnings: warnings,
          files: files ?? const ReviewFiles(total: 0, clean: 0, waiting: 0, failed: 0),
          onFix: onFix ?? (_) {},
          onManageFiles: () {},
        );

    testWidgets('a good report says "none" under both headings; an error is a row that opens its step', (WidgetTester tester) async {
      await pumpV2(tester, list(), size: const Size(390, 3000), tables: _tables);
      expect(find.text('Không có.'), findsNWidgets(2));
      expect(find.text('Chưa có tệp đính kèm.'), findsOneWidget);

      final List<Finding> errors = reviewForm(completeForm().copyWith(preparing: ''), chosenOnly).where((Finding f) => f.isError).toList();
      expect(errors, isNotEmpty);
      final List<String> opened = <String>[];
      await pumpV2(tester, list(errors: errors, onFix: opened.add), size: const Size(390, 3000), tables: _tables);
      expect(find.textContaining('Chưa nhập khối lượng thi công'), findsOneWidget);
      await tester.tap(find.text('Sửa tại bước này'));
      expect(opened, <String>['MOB-14']);
    });

    testWidgets('the files are counted by state, and the screen holds at 200 percent text and meets the tap target guidelines', (WidgetTester tester) async {
      final SemanticsHandle semantics = tester.ensureSemantics();
      final List<Finding> errors = reviewForm(completeForm().copyWith(preparing: ''), chosenOnly).where((Finding f) => f.isError).toList();
      for (final double scale in <double>[1.0, 2.0]) {
        await pumpV2(tester, list(errors: errors, files: const ReviewFiles(total: 3, clean: 1, waiting: 1, failed: 1)), scale: scale, size: const Size(360, 5000), tables: _tables);
        expect(tester.takeException(), isNull, reason: 'at $scale');
        expect(find.textContaining('1 tệp đã tải lên và quét sạch · 1 đang chờ · 1 lỗi'), findsOneWidget);
        await expectLater(tester, meetsGuideline(androidTapTargetGuideline), reason: 'at $scale');
        await expectLater(tester, meetsGuideline(labeledTapTargetGuideline), reason: 'at $scale');
      }
      semantics.dispose();
    });
  });

  group('the list of drafts is rows; its emptiness has its way out', () {
    DraftEntry entry(String id, {String standing = 'Đang soạn', MachvonTone tone = MachvonTone.neutral, bool pending = false, VoidCallback? onOpen, VoidCallback? onDiscard}) => DraftEntry(
          id: id,
          title: 'Dự án DA-2026-002 · Kỳ W2026-45',
          projectName: 'Đường vành đai 3',
          standing: standing,
          tone: tone,
          saved: 'Lưu lúc 03/11/2026 10:20 · mã nháp $id',
          total: '420 triệu đồng',
          pending: pending,
          onOpen: onOpen ?? () {},
          onDiscard: pending ? null : (onDiscard ?? () {}),
        );

    testWidgets('each draft is a row with its state as a pill; Open and Drop are links, and a draft waiting in the queue cannot be dropped', (WidgetTester tester) async {
      int opened = 0;
      int dropped = 0;
      await pumpV2(
        tester,
        DraftsList(entries: <DraftEntry>[entry('aaaa1111', onOpen: () => opened += 1, onDiscard: () => dropped += 1), entry('bbbb2222', standing: 'Chờ gửi', tone: MachvonTone.info, pending: true)]),
        tables: _tables,
      );
      expect(find.text('2 bản nháp trên máy'), findsOneWidget);
      expect(find.text('Đang soạn'), findsOneWidget);
      expect(find.text('Chờ gửi'), findsOneWidget);
      expect(find.text('Bỏ nháp'), findsOneWidget);
      expect(find.text('Xem trạng thái gửi'), findsOneWidget);
      await tester.tap(find.text('Mở nháp'));
      await tester.tap(find.text('Bỏ nháp'));
      expect((opened, dropped), (1, 1));
    });

    testWidgets('the list meets the tap target and label guidelines at 200 percent text', (WidgetTester tester) async {
      final SemanticsHandle semantics = tester.ensureSemantics();
      for (final double scale in <double>[1.0, 2.0]) {
        await pumpV2(tester, DraftsList(entries: <DraftEntry>[entry('aaaa1111'), entry('bbbb2222', standing: 'Cần xử lý', tone: MachvonTone.danger)]), scale: scale, size: const Size(360, 1800), tables: _tables);
        expect(tester.takeException(), isNull, reason: 'at $scale');
        await expectLater(tester, meetsGuideline(androidTapTargetGuideline), reason: 'at $scale');
        await expectLater(tester, meetsGuideline(labeledTapTargetGuideline), reason: 'at $scale');
      }
      semantics.dispose();
    });

    testWidgets('empty: what a draft is and "Start a report"; a read-only tenant is told why and is offered nothing', (WidgetTester tester) async {
      int started = 0;
      await pumpV2(tester, DraftsEmpty(canStart: true, onStart: () => started += 1), tables: _tables);
      expect(find.text('Chưa có bản nháp báo cáo'), findsOneWidget);
      await tester.tap(find.text('Bắt đầu báo cáo'));
      expect(started, 1);

      await pumpV2(tester, DraftsEmpty(canStart: false, onStart: () {}), tables: _tables);
      expect(find.text('Bắt đầu báo cáo'), findsNothing);
      expect(find.textContaining('chế độ chỉ xem'), findsOneWidget);
    });
  });
}
