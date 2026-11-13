import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/l10n/string_table.dart';
import 'package:machvon_mobile/core/theme/machvon_semantic.dart';
import 'package:machvon_mobile/core/widgets/app_scaffold.dart';
import 'package:machvon_mobile/core/widgets/notice_panel.dart';
import 'package:machvon_mobile/core/widgets/state_view.dart';
import 'package:machvon_mobile/features/command_support/field_widgets.dart';
import 'package:machvon_mobile/features/diary_hub/field_report_sheet.dart';
import 'package:machvon_mobile/features/field_evidence/field_evidence_strings.dart';

import '../support/v2_support.dart';

/// Golden images of what the field screens (obstacles, photographs, the queue, the files of a report) are built from, in the phone design
/// (MUX-3 wave C): a form with its sticky send bar, the list of items on their way with progress and retry, the receipt of an offline save,
/// the empty state with its action, and the quick "Report" sheet. Light, dark, 200 percent text, empty and offline. The screens themselves
/// open the encrypted store of the device, which a golden cannot, so these host the shared views the screens are made of.
const List<StringTable> _tables = <StringTable>[fieldEvidenceStrings];

Widget _form({bool offline = false}) => AppScaffold(
      title: 'Ghi nhận vướng mắc',
      bottomBar: FieldSendBar(label: 'Gửi báo cáo', onSend: () {}, offline: offline),
      body: ListView(
        children: <Widget>[
          if (offline) const SavedForLaterPanel(onOpenQueue: _noop),
          const FormSection(title: 'Vướng mắc', first: true, caption: 'Mô tả ngắn, có ảnh nếu chụp được', children: <Widget>[TextField(decoration: InputDecoration(labelText: 'Tiêu đề'))]),
          const FormSection(
            title: 'Mức độ',
            children: <Widget>[NoticePanel(tone: NoticeTone.warning, title: 'Chọn mức độ', margin: EdgeInsets.zero, live: false)],
          ),
        ],
      ),
    );

void _noop() {}

Widget _items() => AppScaffold(
      title: 'Hàng đợi gửi',
      bottomBar: FieldSendBar(label: 'Gửi ngay', onSend: () {}),
      body: ListView(
        children: <Widget>[
          UploadRow(title: 'anh-hien-truong-1.jpg', stateLabel: 'Đang gửi', tone: MachvonTone.info, size: 'Dung lượng 1,2 MB', progress: 0.6, progressText: 'Đã gửi 6/10 phần', dividerAbove: false, actions: <RowAction>[RowAction(label: 'Hủy', onPressed: () {})]),
          UploadRow(title: 'Báo vướng mắc', stateLabel: 'Bị từ chối', tone: MachvonTone.danger, size: 'Dung lượng 4 KB', reason: 'Bạn không còn quyền với hồ sơ này.', code: 'Mã lỗi: SCOPE_DENIED', actions: <RowAction>[RowAction(label: 'Gửi lại', onPressed: () {}), RowAction(label: 'Bỏ', onPressed: () {})]),
          const UploadRow(title: 'Nhật ký công trường', stateLabel: 'Chờ gửi', tone: MachvonTone.neutral, size: 'Dung lượng 9 KB'),
        ],
      ),
    );

Widget _empty() => AppScaffold(
      title: 'Vướng mắc',
      body: StateView(kind: StateKind.empty, title: 'Chưa có vướng mắc nào', body: 'Khi gặp vướng mắc ở công trường, hãy ghi nhận ngay để người phụ trách xử lý.', actionLabel: 'Ghi nhận vướng mắc', onAction: () {}),
    );

Widget _sheet() => ProviderScope(child: Builder(builder: (BuildContext context) => FieldReportSheet(onChosen: (FieldReportKind kind, String? contract) {})));

void main() {
  useTolerantGoldens('test/golden/field_issues_golden_test.dart', tolerance: kTextGoldenTolerance);

  final Map<String, Widget Function()> views = <String, Widget Function()>{
    'form': _form,
    'items': _items,
    'sheet': () => Scaffold(body: SingleChildScrollView(padding: const EdgeInsets.all(16), child: _sheet())),
  };

  for (final MapEntry<String, Widget Function()> view in views.entries) {
    testWidgets('golden ${view.key} in the light mode', (WidgetTester tester) async {
      await pumpV2(tester, view.value(), tables: _tables);
      expect(tester.takeException(), isNull);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/field_issues_${view.key}_light.png'));
    });
    testWidgets('golden ${view.key} in the dark mode', (WidgetTester tester) async {
      await pumpV2(tester, view.value(), brightness: Brightness.dark, tables: _tables);
      expect(tester.takeException(), isNull);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/field_issues_${view.key}_dark.png'));
    });
    testWidgets('golden ${view.key} at 200 percent text', (WidgetTester tester) async {
      await pumpV2(tester, view.value(), scale: 2.0, size: const Size(360, 800), tables: _tables);
      expect(tester.takeException(), isNull, reason: '${view.key} must not overflow at 200 percent');
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/field_issues_${view.key}_text200.png'));
    });
  }

  testWidgets('golden of the form offline: the receipt of a save for later and the bar that says it saves', (WidgetTester tester) async {
    await pumpV2(tester, _form(offline: true), tables: _tables);
    expect(tester.takeException(), isNull);
    expect(find.text('Lưu, gửi khi có mạng'), findsOneWidget);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/field_issues_form_offline_light.png'));
  });

  testWidgets('golden of the empty list of obstacles: the action that fixes it', (WidgetTester tester) async {
    for (final Brightness brightness in Brightness.values) {
      await pumpV2(tester, _empty(), brightness: brightness, tables: _tables);
      expect(tester.takeException(), isNull);
      expect(find.text('Ghi nhận vướng mắc'), findsWidgets);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/field_issues_empty_${brightness.name}.png'));
    }
  });
}
