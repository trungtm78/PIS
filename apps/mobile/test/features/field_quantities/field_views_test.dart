import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/widgets/action_bar.dart';
import 'package:machvon_mobile/core/widgets/notice_panel.dart';
import 'package:machvon_mobile/core/widgets/status_pill.dart';
import 'package:machvon_mobile/core/widgets/work_row.dart';
import 'package:machvon_mobile/features/command_support/field_widgets.dart';
import 'package:machvon_mobile/features/field_quantities/quantity_models.dart';

import '../../support/harness.dart';
import '../../support/v2_support.dart';
import 'view_fixtures.dart';

/// A phone as tall as the longest of these screens, so that a list built lazily is built whole and a test can read all of it.
const Size _tall = Size(390, 2600);

/// The states of the redesigned screens of MOB-63 and MOB-64 (MUX-3 wave C), drawn from their views on sample data: what the person sees
/// in the form, under the fields and in the bar at the foot, with no network, no draft store and no server in the way.
void main() {
  group('MOB-63 the quantity form', () {
    testWidgets('writes the unit next to the field and the quantity in the digits of the language, while the text typed stays as it was typed', (WidgetTester tester) async {
      await pumpV2(tester, sampleQuantityScreen(), tables: kFieldViewTables, size: _tall);
      final TextField field = tester.widget<TextField>(find.widgetWithText(TextField, 'Khối lượng kỳ này (m3)'));
      expect(field.controller!.text, '1234.5', reason: 'what is typed is what is kept and sent');
      expect(field.decoration!.suffixText, 'm3');
      expect(field.keyboardType, const TextInputType.numberWithOptions(decimal: true));
      expect(find.text('Ghi nhận: 1.234,5 m3'), findsOneWidget, reason: 'the grouping and the decimal comma of Vietnamese');
      expect(find.text('Còn lại: 6.765,5 m3'), findsOneWidget);
    });

    testWidgets('says what is wrong with the quantity under the field, and nothing else under it', (WidgetTester tester) async {
      await pumpV2(tester, sampleQuantityScreen(quantity: '1,5', errors: const <String, String>{'quantity': 'Nhập một số, tối đa 6 chữ số thập phân, dùng dấu chấm.'}), tables: kFieldViewTables, size: _tall);
      expect(find.text('Nhập một số, tối đa 6 chữ số thập phân, dùng dấu chấm.'), findsOneWidget);
      expect(find.textContaining('Ghi nhận:'), findsNothing, reason: 'a text that is not a number is not echoed');
    });

    testWidgets('the sticky bar is the one primary action, locked with its reason in a read-only system', (WidgetTester tester) async {
      await pumpV2(tester, sampleQuantityScreen(readOnly: true), tables: kFieldViewTables, size: _tall);
      final Finder save = find.widgetWithText(FilledButton, 'Lưu khối lượng');
      expect(save, findsOneWidget);
      expect(tester.widget<FilledButton>(save).onPressed, isNull);
      expect(find.text('Hệ thống đang ở chế độ chỉ đọc nên thao tác này chưa làm được.'), findsOneWidget, reason: 'a locked button says why');
      expect(tester.getSize(save).height, greaterThanOrEqualTo(48));
      expect(tester.getBottomLeft(find.byType(ActionBar)).dy, tester.view.physicalSize.height, reason: 'the bar sits at the foot of the screen');
    });

    testWidgets('offline the bar offers to save for later, and the receipt of the save has the way to the queue', (WidgetTester tester) async {
      await pumpV2(tester, sampleQuantityScreen(offline: true), tables: kFieldViewTables, size: _tall);
      expect(find.widgetWithText(FilledButton, 'Lưu, gửi khi có mạng'), findsOneWidget);
      expect(find.text('Đã lưu, sẽ gửi khi có mạng'), findsOneWidget);
      expect(find.widgetWithText(OutlinedButton, 'Xem hàng đợi gửi'), findsOneWidget);
    });

    testWidgets('the quantities recorded are rows with their state and their evidence, and sending one for approval is the quiet action, locked offline with its reason', (WidgetTester tester) async {
      final List<String> sent = <String>[];
      await pumpV2(tester, sampleQuantityScreen(onSubmit: (Measurement measurement) => sent.add(measurement.id)), tables: kFieldViewTables, size: _tall);
      expect(find.byType(WorkRow), findsNWidgets(2));
      expect(find.text('B01: 1.234,5 m3, kỳ 2026-11'), findsOneWidget);
      expect(find.text('Tệp căn cứ: 2'), findsOneWidget);
      expect(find.widgetWithText(StatusPill, 'Nháp'), findsOneWidget);
      expect(find.widgetWithText(StatusPill, 'Đã duyệt'), findsOneWidget);
      final Finder submit = find.widgetWithText(OutlinedButton, 'Gửi duyệt');
      expect(submit, findsOneWidget, reason: 'only the quantity the server lets the maker send has the button');
      await tester.ensureVisible(submit);
      await tester.tap(submit);
      expect(sent, <String>['m-1']);

      await pumpV2(tester, sampleQuantityScreen(offline: true), tables: kFieldViewTables, size: _tall);
      await tester.ensureVisible(find.widgetWithText(OutlinedButton, 'Gửi duyệt'));
      expect(tester.widget<OutlinedButton>(find.widgetWithText(OutlinedButton, 'Gửi duyệt')).onPressed, isNull);
      expect(find.text('Không có mạng hoặc đang xem bản đã lưu: thao tác này chỉ làm được khi có mạng, trên bản mới nhất của máy chủ.'), findsOneWidget);
    });

    testWidgets('with no item to record against, the form says so and offers to read again; nothing recorded is a plain line', (WidgetTester tester) async {
      int reloads = 0;
      await pumpV2(tester, sampleQuantityScreen(empty: true, onReload: () => reloads += 1), tables: kFieldViewTables, size: _tall);
      expect(find.byType(NoticePanel), findsOneWidget);
      expect(find.text('Hợp đồng chưa có hạng mục nào để ghi khối lượng, hoặc bạn chưa có quyền ghi.'), findsOneWidget);
      await tester.tap(find.widgetWithText(OutlinedButton, 'Thử lại'));
      expect(reloads, 1);
      await tester.ensureVisible(find.text('Chưa có khối lượng nào của hợp đồng này.'));
      expect(find.text('Chưa có khối lượng nào của hợp đồng này.'), findsOneWidget);
    });

    testWidgets('holds at 200 percent text on the smallest phone: the form scrolls, nothing is cut', (WidgetTester tester) async {
      await pumpV2(tester, sampleQuantityScreen(offline: true, errors: const <String, String>{'reference': 'Cần nhập mục này.'}), tables: kFieldViewTables, scale: 2.0, size: kDeviceSizes[0]);
      expect(tester.takeException(), isNull);
      expect(find.widgetWithText(FilledButton, 'Lưu, gửi khi có mạng'), findsOneWidget);
    });
  });

  group('MOB-64 the inspection form', () {
    testWidgets('each answer is a 48 high choice, and the chosen one has a tick as well as its fill', (WidgetTester tester) async {
      await pumpV2(tester, sampleInspectionScreen(), tables: kFieldViewTables, size: _tall);
      final Finder fail = find.widgetWithText(ChoiceChip, 'Không đạt');
      expect(fail, findsNWidgets(3), reason: 'one for each of the two items of the checklist, and one for the overall result');
      for (int index = 0; index < find.byType(ChoiceChip).evaluate().length; index += 1) {
        expect(tester.getSize(find.byType(ChoiceChip).at(index)).height, greaterThanOrEqualTo(48));
      }
      final ChoiceChip chosen = tester.widget<ChoiceChip>(fail.first);
      expect(chosen.selected, isTrue);
      expect(chosen.showCheckmark, isTrue, reason: 'the selected state is not told by colour alone');
      expect(tester.widget<ChoiceChip>(find.widgetWithText(ChoiceChip, 'Không đạt').last).selected, isFalse);
    });

    testWidgets('choosing an answer reports the item and the outcome', (WidgetTester tester) async {
      final List<String> chosen = <String>[];
      await pumpV2(tester, sampleInspectionScreen(onOutcome: (String code, String outcome) => chosen.add('$code:$outcome')), tables: kFieldViewTables, size: _tall);
      await tester.ensureVisible(find.widgetWithText(ChoiceChip, 'Đạt').at(1));
      await tester.tap(find.widgetWithText(ChoiceChip, 'Đạt').at(1));
      expect(chosen, <String>['K2:PASS']);
    });

    testWidgets('what is not answered is said under the item, and the contradiction under the result', (WidgetTester tester) async {
      await pumpV2(
        tester,
        sampleInspectionScreen(errors: const <String, String>{'answer:K2': 'Chọn kết quả cho hạng mục này.', 'whole': 'Kết quả chung mâu thuẫn với các hạng mục.', 'resultNote': 'Cần nhập mục này.'}),
        tables: kFieldViewTables,
        size: _tall,
      );
      expect(find.text('Chọn kết quả cho hạng mục này.'), findsOneWidget);
      await tester.ensureVisible(find.text('Kết quả chung mâu thuẫn với các hạng mục.'));
      expect(find.text('Kết quả chung mâu thuẫn với các hạng mục.'), findsOneWidget);
      expect(find.text('Cần nhập mục này.'), findsOneWidget);
    });

    testWidgets('the sticky bar saves the result, for later while offline, and is locked with its reason when the system is read-only', (WidgetTester tester) async {
      await pumpV2(tester, sampleInspectionScreen(offline: true), tables: kFieldViewTables, size: _tall);
      expect(find.widgetWithText(FilledButton, 'Lưu, gửi khi có mạng'), findsOneWidget);
      expect(find.byType(SavedForLaterPanel), findsOneWidget);

      await pumpV2(tester, sampleInspectionScreen(readOnly: true), tables: kFieldViewTables, size: _tall);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Lưu kết quả')).onPressed, isNull);
      expect(find.text('Hệ thống đang ở chế độ chỉ đọc nên thao tác này chưa làm được.'), findsOneWidget);
    });

    testWidgets('holds at 200 percent text on the smallest phone', (WidgetTester tester) async {
      await pumpV2(tester, sampleInspectionScreen(errors: const <String, String>{'answer:K2': 'Chọn kết quả cho hạng mục này.'}), tables: kFieldViewTables, scale: 2.0, size: kDeviceSizes[0]);
      expect(tester.takeException(), isNull);
      expect(find.widgetWithText(FilledButton, 'Lưu kết quả'), findsOneWidget);
    });
  });
}
