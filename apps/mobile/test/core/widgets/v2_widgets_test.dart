import 'dart:ui' show Tristate;

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/theme/app_theme.dart';
import 'package:machvon_mobile/core/widgets/action_bar.dart';
import 'package:machvon_mobile/core/widgets/app_scaffold.dart';
import 'package:machvon_mobile/core/widgets/bottom_nav.dart';
import 'package:machvon_mobile/core/widgets/command_band.dart';
import 'package:machvon_mobile/core/widgets/context_line.dart';
import 'package:machvon_mobile/core/widgets/deadline.dart';
import 'package:machvon_mobile/core/widgets/filter_chips.dart';
import 'package:machvon_mobile/core/widgets/info_row.dart';
import 'package:machvon_mobile/core/widgets/progress.dart';
import 'package:machvon_mobile/core/widgets/sheets.dart';
import 'package:machvon_mobile/core/widgets/stage_strip.dart';
import 'package:machvon_mobile/core/widgets/stat_strip.dart';
import 'package:machvon_mobile/core/widgets/state_view.dart';
import 'package:machvon_mobile/core/widgets/timeline.dart';
import 'package:machvon_mobile/core/widgets/underline_tabs.dart';
import 'package:machvon_mobile/core/widgets/work_row.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../support/v2_support.dart';

/// The semantics of one widget found by [finder], read after `ensureSemantics`.
SemanticsNode _node(WidgetTester tester, Finder finder) => tester.getSemantics(finder);

void main() {
  group('the three deadline bands are three shapes with words, never a colour alone', () {
    test('the band follows the days the server counted; the thresholds are the system default and can be given', () {
      expect(DeadlineBand.fromDays(-5), DeadlineBand.late);
      expect(DeadlineBand.fromDays(0), DeadlineBand.late, reason: 'today is red: less than one day left');
      expect(DeadlineBand.fromDays(1), DeadlineBand.soon);
      expect(DeadlineBand.fromDays(3), DeadlineBand.soon);
      expect(DeadlineBand.fromDays(4), DeadlineBand.ok);
      expect(DeadlineBand.fromDays(2, lateBelow: 3, soonUpTo: 5), DeadlineBand.late, reason: 'a tenant policy moves the thresholds');
    });

    test('each band has its own icon and its own colours in the light and the dark mode', () {
      for (final MachvonV2 mode in <MachvonV2>[MachvonV2.light, MachvonV2.dark]) {
        final Set<IconData> icons = <IconData>{for (final DeadlineBand band in DeadlineBand.values) band.styleIn(mode).icon};
        expect(icons, hasLength(4), reason: 'octagon, triangle, clock and tick are four different shapes');
        final Set<Color> marks = <Color>{for (final DeadlineBand band in DeadlineBand.values) band.styleIn(mode).mark};
        expect(marks, hasLength(4));
      }
    });

    testWidgets('a label says the band, the words and the day to a screen reader, and shows the shape and the words', (WidgetTester tester) async {
      final SemanticsHandle semantics = tester.ensureSemantics();
      await pumpV2(
        tester,
        gallery(<Widget>[
          DeadlineLabel.days(daysRemaining: -2, dueDay: '2026-11-10'),
          DeadlineLabel.days(daysRemaining: 2),
          DeadlineLabel.days(daysRemaining: 8),
          const DeadlineLabel(band: DeadlineBand.done, text: 'Đã xong'),
        ]),
      );
      expect(find.text('Trễ 2 ngày'), findsOneWidget);
      expect(find.text('Còn 2 ngày'), findsOneWidget);
      expect(find.text('Còn 8 ngày'), findsOneWidget);
      expect(find.byIcon(Icons.report_outlined), findsOneWidget);
      expect(find.byIcon(Icons.warning_amber_rounded), findsOneWidget);
      expect(find.byIcon(Icons.schedule), findsOneWidget);
      expect(find.byIcon(Icons.check_circle_outline), findsOneWidget);
      expect(find.bySemanticsLabel('Quá hạn, Trễ 2 ngày, hạn 10/11/2026'), findsOneWidget);
      expect(find.bySemanticsLabel('Sắp đến hạn, Còn 2 ngày'), findsOneWidget);
      expect(find.bySemanticsLabel('Còn thời gian, Còn 8 ngày'), findsOneWidget);
      expect(find.bySemanticsLabel('Đã xong, Đã xong'), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('English words', (WidgetTester tester) async {
      await pumpV2(tester, gallery(<Widget>[DeadlineLabel.days(daysRemaining: -1), DeadlineLabel.days(daysRemaining: 1)]), locale: const Locale('en'));
      expect(find.text('Late by 1 day'), findsOneWidget);
      expect(find.text('Tomorrow'), findsOneWidget);
    });
  });

  group('WorkRow, the one row of every list', () {
    testWidgets('a deadline row shows the glyph, the title, the context, the label and the short day; the row is one button', (WidgetTester tester) async {
      final SemanticsHandle semantics = tester.ensureSemantics();
      int taps = 0;
      await pumpV2(
        tester,
        gallery(<Widget>[
          WorkRow.deadline(title: 'Duyệt hồ sơ thanh toán đợt 2', subtitle: 'DA-CB-017 · 3/4 chứng từ', daysRemaining: -2, dueDay: '2026-11-10', onTap: () => taps += 1, semanticLabel: 'Duyệt hồ sơ thanh toán đợt 2, quá hạn'),
          WorkRow.deadline(title: 'Nhận việc', daysRemaining: 5, dividerAbove: true),
        ]),
      );
      expect(find.text('Duyệt hồ sơ thanh toán đợt 2'), findsOneWidget);
      expect(find.text('DA-CB-017 · 3/4 chứng từ'), findsOneWidget);
      expect(find.text('hạn 10/11'), findsOneWidget);
      expect(tester.getSize(find.byType(WorkRow).first).height, greaterThanOrEqualTo(MachvonV2Size.rowMinHeight));
      expect(find.bySemanticsLabel('Duyệt hồ sơ thanh toán đợt 2, quá hạn'), findsOneWidget);
      expect(_node(tester, find.bySemanticsLabel('Duyệt hồ sơ thanh toán đợt 2, quá hạn')).getSemanticsData().flagsCollection.isButton, isTrue);
      await tester.tap(find.text('Duyệt hồ sơ thanh toán đợt 2'));
      expect(taps, 1);
      semantics.dispose();
    });

    testWidgets('a row without a tap is not a button and an action in the end column is a separate control', (WidgetTester tester) async {
      int claimed = 0;
      await pumpV2(
        tester,
        gallery(<Widget>[
          WorkRow.deadline(title: 'Cả nhóm: việc chưa có người nhận', daysRemaining: 3, action: TextButton(onPressed: () => claimed += 1, child: const Text('Nhận việc'))),
          const WorkRow(title: 'Chỉ đọc', subtitle: 'Không có quyền nhận', leading: Icon(Icons.lock_outline)),
        ]),
      );
      await tester.tap(find.text('Nhận việc'));
      expect(claimed, 1);
      expect(find.text('Chỉ đọc'), findsOneWidget);
    });

    testWidgets('at 200 percent nothing is cut: the title and the context show whole and the end column drops below them', (WidgetTester tester) async {
      await pumpV2(
        tester,
        gallery(<Widget>[
          WorkRow.deadline(
            title: 'Phê duyệt điều chuyển vốn năm 2026 giữa hai dự án cùng chủ đầu tư và cùng nguồn vốn ngân sách trung ương',
            subtitle: 'DA-CB-017 · 3/4 chứng từ đã có',
            daysRemaining: 1,
            dueDay: '2026-11-13',
            onTap: () {},
          ),
        ]),
        scale: 2.0,
        size: const Size(360, 800),
      );
      expect(tester.takeException(), isNull);
      final Text title = tester.widget<Text>(find.textContaining('Phê duyệt điều chuyển vốn'));
      expect(title.maxLines, isNull, reason: 'the clamp is lifted from 1.5 times');
      expect(tester.getTopLeft(find.text('Ngày mai')).dy, greaterThan(tester.getBottomLeft(find.textContaining('Phê duyệt điều chuyển vốn')).dy - 1), reason: 'the label is under the title');
    });

    testWidgets('the skeleton has the height of a row, shows no text and says nothing', (WidgetTester tester) async {
      final SemanticsHandle semantics = tester.ensureSemantics();
      await pumpV2(tester, gallery(const <Widget>[WorkRowSkeleton()]));
      expect(find.byType(Text), findsNothing);
      expect(tester.getSize(find.byType(WorkRowSkeleton)).height, greaterThanOrEqualTo(MachvonV2Size.rowMinHeight));
      expect(tester.getSemantics(find.byType(WorkRowSkeleton)).label, isEmpty);
      semantics.dispose();
    });

    testWidgets('a group header is a heading with its count', (WidgetTester tester) async {
      final SemanticsHandle semantics = tester.ensureSemantics();
      await pumpV2(tester, gallery(const <Widget>[GroupHeader(title: 'Trễ hạn', count: 3), GroupHeader(title: 'Còn thời gian')]));
      expect(find.text('Trễ hạn'), findsOneWidget);
      expect(find.text('3'), findsOneWidget);
      final SemanticsData data = _node(tester, find.bySemanticsLabel('Trễ hạn, 3')).getSemanticsData();
      expect(data.flagsCollection.isHeader, isTrue);
      semantics.dispose();
    });
  });

  group('the summary widgets: command band, stat strip, stage strip, progress, mini chart', () {
    testWidgets('the command band reads label, figure, unit, the bar and both notes as one node', (WidgetTester tester) async {
      final SemanticsHandle semantics = tester.ensureSemantics();
      await pumpV2(
        tester,
        const CommandBand(
          title: 'Tổng quan',
          subtitle: 'Toàn bộ phạm vi · tháng 11/2026',
          label: 'Giải ngân lũy kế 2026',
          figure: '1.058,3',
          unit: 'tỷ đồng',
          progress: 0.581,
          progressLabel: 'Đã giải ngân 58,1% kế hoạch vốn',
          footStart: '58,1% kế hoạch vốn năm',
          footEnd: 'Kế hoạch 1.820 tỷ đồng',
          showBack: false,
        ),
      );
      expect(find.text('1.058,3'), findsOneWidget);
      expect(find.bySemanticsLabel('Giải ngân lũy kế 2026: 1.058,3 tỷ đồng. Đã giải ngân 58,1% kế hoạch vốn. 58,1% kế hoạch vốn năm. Kế hoạch 1.820 tỷ đồng'), findsOneWidget);
      final ColoredBox header = tester.widgetList<ColoredBox>(find.byType(ColoredBox)).firstWhere((ColoredBox box) => box.color == MachvonV2Colors.light.header);
      expect(header.color, MachvonV2Colors.light.header);
      semantics.dispose();
    });

    test('on a light tenant header the notes and the bar are derived from the tenant pair and stay readable', () {
      for (final Map<String, String> overlay in <Map<String, String>>[
        <String, String>{'menu': '#ffffff', 'menuText': '#000000'},
        <String, String>{'menu': '#f4e9d8', 'menuText': '#2a1a05'},
        <String, String>{'menu': '#0a2540', 'menuText': '#ffffff'},
      ]) {
        final MachvonV2 v2 = buildAppTheme(tenantOverlay: overlay).extension<MachvonV2>()!;
        final MachvonV2Palette p = v2.palette;
        expect(p.header, parseHexColor(overlay['menu']!), reason: 'the overlay is accepted whole, so the band takes it');
        expect(contrastRatio(p.onHeader, p.header), greaterThanOrEqualTo(4.5), reason: '${overlay['menu']}');
        expect(contrastRatio(p.onHeader2, p.header), greaterThanOrEqualTo(4.5), reason: 'the notes on ${overlay['menu']}');
        expect(contrastRatio(p.accentOnDark, p.header), greaterThanOrEqualTo(3), reason: 'the bar on ${overlay['menu']}');
        expect(p.header2, isNot(p.header), reason: 'the track of the bar shows on ${overlay['menu']}');
      }
    });

    test('without a tenant the band keeps the exact tokens of the design', () {
      final MachvonV2Palette p = buildAppTheme().extension<MachvonV2>()!.palette;
      expect(p.header, MachvonV2Colors.light.header);
      expect(p.header2, MachvonV2Colors.light.header2);
      expect(p.onHeader2, MachvonV2Colors.light.onHeader2);
      expect(p.accentOnDark, MachvonV2Colors.light.accentOnDark);
    });

    test('the command band takes the tenant colour and keeps the bands', () {
      final ThemeData theme = buildAppTheme(tenantOverlay: const <String, String>{'menu': '#0a2540', 'menuText': '#ffffff', 'primary': '#0a4d8c'});
      final MachvonV2 v2 = theme.extension<MachvonV2>()!;
      expect(v2.palette.header, const Color(0xFF0A2540));
      expect(v2.palette.primary, const Color(0xFF0A4D8C));
      expect(DeadlineBand.late.styleIn(v2).mark, MachvonV2Colors.light.lateMark, reason: 'a tenant never recolours a deadline band');
      expect(DeadlineBand.ok.styleIn(v2).foreground, MachvonV2Colors.light.okFg);
    });

    testWidgets('a stat strip puts three figures in a row and stacks them at a large text scale; a band under a cell has its shape and words', (WidgetTester tester) async {
      const StatStrip strip = StatStrip(
        cells: <StatCell>[
          StatCell(value: '6', of: '/32', label: 'Dự án chậm giải ngân', band: DeadlineBand.soon, bandText: 'Theo dõi'),
          StatCell(value: '5', label: 'Việc quá hạn', band: DeadlineBand.late, bandText: 'Quá hạn'),
          StatCell(value: '4', label: 'Chờ bạn duyệt'),
        ],
      );
      await pumpV2(tester, gallery(const <Widget>[strip]));
      final double first = tester.getTopLeft(find.text('Dự án chậm giải ngân')).dy;
      expect(tester.getTopLeft(find.text('Việc quá hạn')).dy, first, reason: 'one row');
      expect(find.text('Theo dõi'), findsOneWidget);
      expect(find.byIcon(Icons.report_outlined), findsOneWidget);

      await pumpV2(tester, gallery(const <Widget>[strip]), scale: 2.0, size: const Size(360, 800));
      expect(tester.takeException(), isNull);
      expect(tester.getTopLeft(find.text('Việc quá hạn')).dy, greaterThan(tester.getTopLeft(find.text('Dự án chậm giải ngân')).dy), reason: 'stacked');
    });

    testWidgets('the stage strip draws six segments, fills the finished ones and names the stage in text', (WidgetTester tester) async {
      final SemanticsHandle semantics = tester.ensureSemantics();
      await pumpV2(tester, gallery(const <Widget>[StageStrip(total: 6, current: 4, currentFraction: 0.58, label: 'Giai đoạn 4/6 · Thực hiện', trailing: 'Việc xong 7/12')]));
      expect(find.text('Giai đoạn 4/6 · Thực hiện'), findsOneWidget);
      expect(find.text('Việc xong 7/12'), findsOneWidget);
      expect(find.bySemanticsLabel('Giai đoạn 4/6 · Thực hiện. Việc xong 7/12'), findsOneWidget);
      expect(find.byType(FractionallySizedBox), findsNWidgets(4), reason: 'three finished segments and the half of the fourth');
      semantics.dispose();
    });

    testWidgets('a progress bar says the percent in the language, with its label in front', (WidgetTester tester) async {
      final SemanticsHandle semantics = tester.ensureSemantics();
      await pumpV2(tester, gallery(const <Widget>[ProgressMeter(value: 0.581, label: 'Giải ngân'), ProgressMeter(value: 2)]));
      expect(find.bySemanticsLabel('Giải ngân, 58,1%'), findsOneWidget);
      expect(find.bySemanticsLabel('100,0%'), findsOneWidget, reason: 'a share above 1 is held at the full bar');
      semantics.dispose();
    });

    testWidgets('the fills of a progress bar, a stage strip and a command band have a real size (a fill with no height is not drawn)', (WidgetTester tester) async {
      await pumpV2(
        tester,
        gallery(const <Widget>[
          Padding(padding: EdgeInsets.all(16), child: Align(alignment: Alignment.centerLeft, child: ProgressMeter(value: 0.5, width: 200))),
          StageStrip(total: 6, current: 3, currentFraction: 0.5, label: 'Giai đoạn 3/6'),
          CommandBand(
            title: 'Tổng quan',
            label: 'Giải ngân',
            figure: '1',
            unit: 'tỷ đồng',
            progress: 0.5,
            progressLabel: '50%',
            footStart: 'a',
            footEnd: 'b',
            showBack: false,
          ),
        ]),
      );
      final Finder meterFill = find.descendant(of: find.byType(ProgressMeter), matching: find.byType(FractionallySizedBox));
      expect(tester.getSize(meterFill).width, closeTo(100, 0.01));
      expect(tester.getSize(meterFill).height, MachvonV2Size.barHeight);

      final Finder stageFills = find.descendant(of: find.byType(StageStrip), matching: find.byType(FractionallySizedBox));
      expect(stageFills, findsNWidgets(3), reason: 'two finished segments and the half of the third');
      for (final Element fill in stageFills.evaluate()) {
        expect(tester.getSize(find.byElementPredicate((Element e) => e == fill)).height, MachvonV2Size.stageSegmentHeight);
      }

      final Finder bandFill = find.descendant(of: find.byType(CommandBand), matching: find.byType(FractionallySizedBox));
      expect(tester.getSize(bandFill).height, MachvonV2Size.heroBarHeight);
      expect(tester.getSize(bandFill).width, closeTo((390 - 32) * 0.5, 0.01));
    });

    testWidgets('a mini chart names every bar and carries its value as text', (WidgetTester tester) async {
      final SemanticsHandle semantics = tester.ensureSemantics();
      await pumpV2(
        tester,
        gallery(const <Widget>[
          MiniChart(
            semanticLabel: 'Giải ngân theo nguồn vốn',
            data: <MiniChartDatum>[
              MiniChartDatum(label: 'Ngân sách trung ương', value: 63, valueText: '63 tỷ đồng', max: 100),
              MiniChartDatum(label: 'Ngân sách địa phương', value: 21, valueText: '21 tỷ đồng', max: 100),
              MiniChartDatum(label: 'Không có số liệu', value: 5, valueText: '0 đồng', max: 0),
            ],
          ),
        ]),
      );
      expect(find.text('63 tỷ đồng'), findsOneWidget);
      expect(find.bySemanticsLabel('Ngân sách trung ương: 63 tỷ đồng'), findsOneWidget);
      expect(find.bySemanticsLabel('Không có số liệu: 0 đồng'), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('a timeline reads each entry as title, time and detail, and gives a band entry its shape', (WidgetTester tester) async {
      final SemanticsHandle semantics = tester.ensureSemantics();
      await pumpV2(
        tester,
        gallery(const <Widget>[
          TimelineList(
            entries: <TimelineEntry>[
              TimelineEntry(title: 'Quá hạn nộp báo cáo', when: 'Hôm nay 08:00', band: DeadlineBand.late, detail: 'Trễ 2 ngày'),
              TimelineEntry(title: 'Đã gửi biên bản', when: 'Hôm qua 16:00', icon: Icons.send),
              TimelineEntry(title: 'Tạo việc', when: '10/11 09:30'),
            ],
          ),
        ]),
      );
      expect(find.byIcon(Icons.report_outlined), findsOneWidget);
      expect(find.byIcon(Icons.send), findsOneWidget);
      expect(find.bySemanticsLabel('Quá hạn nộp báo cáo, Hôm nay 08:00, Trễ 2 ngày'), findsOneWidget);
      expect(find.bySemanticsLabel('Tạo việc, 10/11 09:30'), findsOneWidget);
      semantics.dispose();
    });
  });

  group('the controls: filter chips, tabs, info rows', () {
    testWidgets('filter chips are 44 high, say selected, and change on a tap; the chosen one stays', (WidgetTester tester) async {
      final SemanticsHandle semantics = tester.ensureSemantics();
      String chosen = 'all';
      await pumpV2(
        tester,
        StatefulBuilder(
          builder: (BuildContext context, StateSetter set) => FilterChips<String>(
            options: const <ChipOption<String>>[
              ChipOption<String>(value: 'all', label: 'Tất cả'),
              ChipOption<String>(value: 'late', label: 'Chậm tiến độ', count: 6),
            ],
            selected: chosen,
            onChanged: (String value) => set(() => chosen = value),
          ),
        ),
      );
      expect(tester.getSize(find.text('Tất cả').hitTestable()).height, lessThan(44), reason: 'the text is smaller than the chip');
      expect(tester.getSize(find.ancestor(of: find.text('Tất cả'), matching: find.byType(InkWell)).first).height, greaterThanOrEqualTo(44));
      expect(_node(tester, find.bySemanticsLabel('Tất cả')).getSemanticsData().flagsCollection.isSelected, Tristate.isTrue);
      await tester.tap(find.text('Chậm tiến độ 6'));
      await tester.pumpAndSettle();
      expect(chosen, 'late');
      expect(_node(tester, find.bySemanticsLabel('Chậm tiến độ 6')).getSemanticsData().flagsCollection.isSelected, Tristate.isTrue);
      expect(_node(tester, find.bySemanticsLabel('Tất cả')).getSemanticsData().flagsCollection.isSelected, Tristate.isFalse);
      semantics.dispose();
    });

    testWidgets('underline tabs are at least 48 by 48, scroll sideways at 200 percent and change on a tap', (WidgetTester tester) async {
      int index = 0;
      await pumpV2(
        tester,
        StatefulBuilder(
          builder: (BuildContext context, StateSetter set) => UnderlineTabs(
            tabs: const <TabOption>[TabOption(label: 'Của tôi', count: 6), TabOption(label: 'Cả nhóm'), TabOption(label: 'Đã xong')],
            index: index,
            onChanged: (int value) => set(() => index = value),
          ),
        ),
        scale: 2.0,
        size: const Size(360, 800),
      );
      expect(tester.takeException(), isNull);
      for (final Element tab in find.byType(InkWell).evaluate()) {
        final Size size = tester.getSize(find.byElementPredicate((Element e) => e == tab));
        expect(size.height, greaterThanOrEqualTo(48));
        expect(size.width, greaterThanOrEqualTo(48));
      }
      await tester.ensureVisible(find.text('Cả nhóm'));
      await tester.tap(find.text('Cả nhóm'));
      expect(index, 1);
    });

    testWidgets('an info row is hidden when the value is not known, shows a real 0, and reads "label: value"', (WidgetTester tester) async {
      final SemanticsHandle semantics = tester.ensureSemantics();
      await pumpV2(
        tester,
        gallery(const <Widget>[
          InfoRow(label: 'Chủ đầu tư', value: null),
          InfoRow(label: 'Ghi chú', value: ''),
          InfoRow(label: 'Số lần trả lại', value: '0', divider: false),
          InfoRow(label: 'Giá trị', value: '2.350.000.000 đồng'),
        ]),
      );
      expect(find.text('Chủ đầu tư'), findsNothing);
      expect(find.text('Ghi chú'), findsNothing);
      expect(find.text('0'), findsOneWidget);
      expect(find.bySemanticsLabel('Giá trị: 2.350.000.000 đồng'), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('a long value and a large text scale cut nothing in an info row', (WidgetTester tester) async {
      await pumpV2(tester, gallery(const <Widget>[InfoRow(label: 'Nguồn vốn của dự án', value: 'Vốn ngân sách trung ương hỗ trợ có mục tiêu cho địa phương')]), scale: 2.0, size: const Size(360, 800));
      expect(tester.takeException(), isNull);
    });

    testWidgets('a context line is one line that opens on a tap, says stale with an icon, and refreshes', (WidgetTester tester) async {
      int refreshed = 0;
      await pumpV2(
        tester,
        ContextLine(parts: const <String>['Toàn bộ phạm vi', 'Chốt số liệu 06/11/2026', 'Cập nhật 00:08 hôm nay, nguồn Kho bạc Nhà nước và hệ thống đầu tư công'], stale: true, onRefresh: () => refreshed += 1, refreshLabel: 'Làm mới'),
      );
      expect(find.text('Số liệu cũ'), findsOneWidget);
      expect(find.byIcon(Icons.warning_amber_rounded), findsOneWidget);
      final double closed = tester.getSize(find.byType(ContextLine)).height;
      await tester.tap(find.textContaining('Toàn bộ phạm vi'));
      await tester.pumpAndSettle();
      expect(tester.getSize(find.byType(ContextLine)).height, greaterThanOrEqualTo(closed));
      await tester.tap(find.byIcon(Icons.refresh));
      expect(refreshed, 1);
    });
  });

  group('the action bar, the floating button and the sheets', () {
    testWidgets('a locked primary button is explained above it; two buttons share the row and are 48 high', (WidgetTester tester) async {
      int approved = 0;
      await pumpV2(
        tester,
        Column(
          children: <Widget>[
            const Spacer(),
            ActionBar(
              primary: const ActionBarButton(label: 'Phê duyệt', onPressed: null, icon: Icons.check),
              secondary: ActionBarButton(label: 'Trả lại', onPressed: () {}),
              why: 'Phê duyệt cần kết nối mạng',
            ),
          ],
        ),
      );
      expect(find.text('Phê duyệt cần kết nối mạng'), findsOneWidget);
      expect(tester.getSize(find.widgetWithText(FilledButton, 'Phê duyệt')).height, greaterThanOrEqualTo(48));
      expect(tester.getTopLeft(find.widgetWithText(OutlinedButton, 'Trả lại')).dy, tester.getTopLeft(find.widgetWithText(FilledButton, 'Phê duyệt')).dy, reason: 'one row');

      await pumpV2(tester, Column(children: <Widget>[const Spacer(), ActionBar(primary: ActionBarButton(label: 'Phê duyệt', onPressed: () => approved += 1), why: 'không hiện khi mở khóa')]));
      expect(find.text('không hiện khi mở khóa'), findsNothing, reason: 'the reason is shown only while the button is locked');
      await tester.tap(find.text('Phê duyệt'));
      expect(approved, 1);
    });

    testWidgets('at 200 percent the two buttons stack so no word breaks', (WidgetTester tester) async {
      await pumpV2(
        tester,
        Column(
          children: <Widget>[
            const Spacer(),
            ActionBar(primary: ActionBarButton(label: 'Xác nhận phê duyệt', onPressed: () {}), secondary: ActionBarButton(label: 'Xem lại hồ sơ', onPressed: () {})),
          ],
        ),
        scale: 2.0,
        size: const Size(360, 800),
      );
      expect(tester.takeException(), isNull);
      expect(tester.getTopLeft(find.widgetWithText(FilledButton, 'Xác nhận phê duyệt')).dy, lessThan(tester.getTopLeft(find.widgetWithText(OutlinedButton, 'Xem lại hồ sơ')).dy));
    });

    testWidgets('the floating button is a named button of at least 56 by 56', (WidgetTester tester) async {
      final SemanticsHandle semantics = tester.ensureSemantics();
      int taps = 0;
      await pumpV2(tester, Align(alignment: Alignment.bottomRight, child: FloatingPill(icon: Icons.add, label: 'Báo cáo', onPressed: () => taps += 1)));
      expect(tester.getSize(find.byType(FloatingPill)).height, greaterThanOrEqualTo(56));
      expect(_node(tester, find.bySemanticsLabel('Báo cáo')).getSemanticsData().flagsCollection.isButton, isTrue);
      await tester.tap(find.text('Báo cáo'));
      expect(taps, 1);
      semantics.dispose();
    });

    testWidgets('the confirm sheet states the facts, answers true on confirm and false on cancel or dismiss', (WidgetTester tester) async {
      bool? answer;
      await pumpV2(
        tester,
        Builder(
          builder: (BuildContext context) => TextButton(
            onPressed: () async => answer = await showConfirmSheet(
              context,
              title: 'Xác nhận phê duyệt',
              facts: const <String>['Điều chuyển 12 tỷ đồng từ DA-CB-017 sang DA-CB-023', 'Tổng vốn không đổi'],
              confirmLabel: 'Xác nhận phê duyệt',
              cancelLabel: 'Xem lại hồ sơ',
              auditNote: 'Ghi vào nhật ký kiểm toán dưới tên bạn',
            ),
            child: const Text('mở'),
          ),
        ),
      );
      await tester.tap(find.text('mở'));
      await tester.pumpAndSettle();
      expect(find.text('Điều chuyển 12 tỷ đồng từ DA-CB-017 sang DA-CB-023'), findsOneWidget);
      expect(find.text('Ghi vào nhật ký kiểm toán dưới tên bạn'), findsOneWidget);
      expect(tester.getSize(find.widgetWithText(FilledButton, 'Xác nhận phê duyệt')).height, greaterThanOrEqualTo(48));
      await tester.tap(find.widgetWithText(FilledButton, 'Xác nhận phê duyệt'));
      await tester.pumpAndSettle();
      expect(answer, isTrue);

      await tester.tap(find.text('mở'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Xem lại hồ sơ'));
      await tester.pumpAndSettle();
      expect(answer, isFalse);

      await tester.tap(find.text('mở'));
      await tester.pumpAndSettle();
      await tester.tapAt(const Offset(195, 20));
      await tester.pumpAndSettle();
      expect(answer, isFalse, reason: 'closing the sheet any other way is no');
    });

    testWidgets('a sheet keeps its last button clear of a bottom system area', (WidgetTester tester) async {
      tester.view.padding = const FakeViewPadding(bottom: 48);
      tester.view.viewPadding = const FakeViewPadding(bottom: 48);
      addTearDown(tester.view.resetPadding);
      addTearDown(tester.view.resetViewPadding);
      await pumpV2(
        tester,
        Builder(
          builder: (BuildContext context) => TextButton(
            onPressed: () => showConfirmSheet(context, title: 'Xác nhận', facts: const <String>['Một việc'], confirmLabel: 'Đồng ý', cancelLabel: 'Hủy'),
            child: const Text('mở'),
          ),
        ),
      );
      await tester.tap(find.text('mở'));
      await tester.pumpAndSettle();
      expect(tester.getBottomLeft(find.widgetWithText(OutlinedButton, 'Hủy')).dy, lessThanOrEqualTo(844 - 48), reason: 'the quiet button ends above the system area');
    });

    testWidgets('a destructive confirmation uses the late colour for its primary button; a sheet scrolls at 200 percent', (WidgetTester tester) async {
      await pumpV2(
        tester,
        Builder(
          builder: (BuildContext context) => TextButton(
            onPressed: () => showConfirmSheet(
              context,
              title: 'Trả lại hồ sơ',
              facts: const <String>['Hồ sơ trả về người gửi kèm lý do', 'Người gửi nhận thông báo ngay', 'Hạn xử lý mới tính lại từ hôm nay'],
              confirmLabel: 'Trả lại',
              cancelLabel: 'Hủy',
              destructive: true,
            ),
            child: const Text('mở'),
          ),
        ),
        scale: 2.0,
        size: const Size(360, 640),
      );
      await tester.tap(find.text('mở'));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      final FilledButton button = tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Trả lại'));
      expect(button.style!.backgroundColor!.resolve(<WidgetState>{}), MachvonV2Colors.light.lateMark);
    });
  });

  group('states and banners', () {
    testWidgets('each kind of state has its own icon, its own words and an action that works', (WidgetTester tester) async {
      final SemanticsHandle semantics = tester.ensureSemantics();
      final List<String> calls = <String>[];
      final Map<StateKind, (String, IconData)> kinds = <StateKind, (String, IconData)>{
        StateKind.empty: ('Chưa có dữ liệu', Icons.inbox_outlined),
        StateKind.error: ('Chưa thể tải dữ liệu', Icons.report_outlined),
        StateKind.offline: ('Bạn đang ngoại tuyến', Icons.cloud_off_outlined),
        StateKind.denied: ('Bạn chưa có quyền truy cập', Icons.lock_outline),
      };
      for (final MapEntry<StateKind, (String, IconData)> entry in kinds.entries) {
        await pumpV2(tester, StateView(kind: entry.key, actionLabel: 'Thử lại', onAction: () => calls.add(entry.key.name), secondaryLabel: 'Quay lại', onSecondary: () => calls.add('second')));
        expect(find.text(entry.value.$1), findsOneWidget, reason: entry.key.name);
        expect(find.byIcon(entry.value.$2), findsOneWidget, reason: entry.key.name);
        await tester.tap(find.text('Thử lại'));
        await tester.tap(find.text('Quay lại'));
      }
      expect(calls, <String>['empty', 'second', 'error', 'second', 'offline', 'second', 'denied', 'second']);
      semantics.dispose();
    });

    testWidgets('the facts of a state are read by a screen reader as well, apart from the live message', (WidgetTester tester) async {
      final SemanticsHandle semantics = tester.ensureSemantics();
      await pumpV2(tester, const StateView(kind: StateKind.error, details: <Widget>[Text('Mã lỗi INTERNAL_ERROR'), Text('Mã tham chiếu 3f2b')]));
      expect(find.bySemanticsLabel('Mã lỗi INTERNAL_ERROR'), findsOneWidget);
      expect(find.bySemanticsLabel('Mã tham chiếu 3f2b'), findsOneWidget);
      expect(find.bySemanticsLabel('Chưa thể tải dữ liệu. Thông tin đã nhập không bị mất. Vui lòng thử lại.'), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('a state can carry its own words and icon (done for today) and is one live region; without an action it has no button', (WidgetTester tester) async {
      final SemanticsHandle semantics = tester.ensureSemantics();
      await pumpV2(tester, const StateView(kind: StateKind.empty, title: 'Hôm nay bạn đã xong việc', body: 'Việc kế tiếp đến hạn ngày mai.', icon: Icons.check_circle_outline, details: <Widget>[Text('chi tiết')]));
      expect(find.text('Hôm nay bạn đã xong việc'), findsOneWidget);
      expect(find.byType(FilledButton), findsNothing);
      expect(find.text('chi tiết'), findsOneWidget);
      expect(_node(tester, find.bySemanticsLabel('Hôm nay bạn đã xong việc. Việc kế tiếp đến hạn ngày mai.')).getSemanticsData().flagsCollection.isLiveRegion, isTrue);
      semantics.dispose();
    });

    testWidgets('a state at 200 percent on a short screen scrolls and does not overflow', (WidgetTester tester) async {
      await pumpV2(tester, StateView(kind: StateKind.error, actionLabel: 'Thử lại', onAction: () {}, secondaryLabel: 'Sao chép mã tham chiếu', onSecondary: () {}), scale: 2.0, size: const Size(360, 480));
      expect(tester.takeException(), isNull);
    });

    testWidgets('a banner is a live region; with onTap the whole strip is a button, with an action a separate one', (WidgetTester tester) async {
      final SemanticsHandle semantics = tester.ensureSemantics();
      int opened = 0;
      int dismissed = 0;
      await pumpV2(
        tester,
        gallery(<Widget>[
          const StatusBanner(text: 'Bạn đang ngoại tuyến. Phê duyệt cần kết nối.'),
          StatusBanner(text: '2 thay đổi đang chờ gửi', icon: Icons.sync, onTap: () => opened += 1),
          StatusBanner(text: 'Thiết bị có dấu hiệu bị can thiệp', tone: BannerTone.late, actionLabel: 'Đã hiểu', onAction: () => dismissed += 1),
          const StatusBanner(text: 'Số liệu cũ', tone: BannerTone.warning),
        ]),
      );
      expect(_node(tester, find.bySemanticsLabel(RegExp('Bạn đang ngoại tuyến'))).getSemanticsData().flagsCollection.isLiveRegion, isTrue);
      await tester.tap(find.text('2 thay đổi đang chờ gửi'));
      await tester.tap(find.text('Đã hiểu'));
      expect(opened, 1);
      expect(dismissed, 1);
      expect(find.byIcon(Icons.report_outlined), findsOneWidget, reason: 'the late tone has the octagon');
      expect(find.byIcon(Icons.warning_amber_rounded), findsOneWidget, reason: 'the warning tone has the triangle');
      semantics.dispose();
    });
  });

  group('the bottom navigation and the frame of a screen', () {
    const List<NavItem> items = <NavItem>[
      NavItem(icon: Icons.home_outlined, selectedIcon: Icons.home, label: 'Trang chủ'),
      NavItem(icon: Icons.apartment_outlined, selectedIcon: Icons.apartment, label: 'Dự án'),
      NavItem(icon: Icons.fact_check_outlined, selectedIcon: Icons.fact_check, label: 'Phê duyệt', badge: 3, badgeHint: '3 mục cần xử lý'),
      NavItem(icon: Icons.notifications_outlined, selectedIcon: Icons.notifications, label: 'Thông báo', badge: 120, badgeHint: '120 mục cần xử lý'),
      NavItem(icon: Icons.person_outline, selectedIcon: Icons.person, label: 'Cá nhân'),
    ];

    testWidgets('five tabs of at least 64 high, the chosen one marked, the count in a pill and said once after the name', (WidgetTester tester) async {
      final SemanticsHandle semantics = tester.ensureSemantics();
      int selected = 0;
      await pumpV2(
        tester,
        StatefulBuilder(
          builder: (BuildContext context, StateSetter set) => Column(children: <Widget>[const Spacer(), AppBottomNav(items: items, selectedIndex: selected, onSelected: (int i) => set(() => selected = i))]),
        ),
      );
      expect(find.byType(AppBottomNavItem), findsNWidgets(5));
      expect(tester.getSize(find.byType(AppBottomNav)).height, greaterThanOrEqualTo(MachvonV2Size.navBarHeight));
      expect(find.text('3'), findsOneWidget);
      expect(find.text('99+'), findsOneWidget);
      final SemanticsData approval = tester.getSemantics(find.byType(AppBottomNavItem).at(2)).getSemanticsData();
      expect(approval.label, startsWith('Phê duyệt'));
      expect(approval.label, contains('Tab 3 trong tổng số 5'));
      expect(approval.label, isNot(contains('3 mục')));
      expect(approval.hint, '3 mục cần xử lý');
      expect(tester.getSemantics(find.byType(AppBottomNavItem).at(0)).getSemanticsData().hint, isEmpty);
      expect(tester.getSemantics(find.byType(AppBottomNavItem).at(0)).getSemanticsData().flagsCollection.isSelected, Tristate.isTrue);
      await tester.tap(find.text('Dự án'));
      await tester.pumpAndSettle();
      expect(selected, 1);
      expect(tester.getSemantics(find.byType(AppBottomNavItem).at(1)).getSemanticsData().flagsCollection.isSelected, Tristate.isTrue);
      semantics.dispose();
    });

    testWidgets('at 200 percent five labels fit: they stop at 1.3 times and may wrap to two lines', (WidgetTester tester) async {
      await pumpV2(tester, Column(children: <Widget>[const Spacer(), AppBottomNav(items: items, selectedIndex: 2, onSelected: (_) {})]), scale: 2.0, size: const Size(360, 800));
      expect(tester.takeException(), isNull);
      for (final Element tab in find.byType(AppBottomNavItem).evaluate()) {
        final Size size = tester.getSize(find.byElementPredicate((Element e) => e == tab));
        expect(size.width, greaterThanOrEqualTo(48));
        expect(size.height, greaterThanOrEqualTo(48));
      }
    });

    testWidgets('the frame shows the large title of a root screen, the context line, the body and the bottom bar; a pushed screen has a back button', (WidgetTester tester) async {
      await pumpV2(
        tester,
        const AppScaffold(
          largeTitle: 'Việc hôm nay',
          subtitle: 'Thứ Năm, 12/11/2026',
          contextLine: ContextLine(parts: <String>['Của tôi']),
          body: Center(child: Text('nội dung')),
          bottomBar: ActionBar(primary: ActionBarButton(label: 'Báo cáo', onPressed: null)),
          showBack: false,
        ),
      );
      expect(find.text('Việc hôm nay'), findsOneWidget);
      expect(find.text('Thứ Năm, 12/11/2026'), findsOneWidget);
      expect(find.text('nội dung'), findsOneWidget);
      expect(find.byTooltip('Quay lại'), findsNothing);

      await tester.pumpWidget(
        MaterialApp(
          theme: buildAppTheme(),
          home: Builder(
            builder: (BuildContext context) => TextButton(
              onPressed: () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => const AppScaffold(title: 'DA-CB-017', body: SizedBox(), actions: <Widget>[AppBarAction(icon: Icons.more_vert, label: 'Thêm', onPressed: null)]))),
              child: const Text('mở'),
            ),
          ),
        ),
      );
      await tester.tap(find.text('mở'));
      await tester.pumpAndSettle();
      expect(find.text('DA-CB-017'), findsOneWidget);
      expect(find.byTooltip('Back'), findsOneWidget);
      expect(find.byTooltip('Thêm'), findsOneWidget);
      await tester.tap(find.byTooltip('Back'));
      await tester.pumpAndSettle();
      expect(find.text('DA-CB-017'), findsNothing);
    });

    testWidgets('the large title stops at 1.3 times at 200 percent', (WidgetTester tester) async {
      await pumpV2(tester, const LargeTitleHeader(title: 'Việc hôm nay'), scale: 2.0, size: const Size(360, 800));
      final Text title = tester.widget<Text>(find.text('Việc hôm nay'));
      expect(title.textScaler!.scale(MachvonV2Type.display.size), closeTo(MachvonV2Type.display.size * MachvonV2Type.displayScaleCap, 0.01));
    });
  });

  group('the dark mode draws every widget without an error and with the dark palette', () {
    testWidgets('a sample of every widget in the dark mode at 200 percent', (WidgetTester tester) async {
      await pumpV2(
        tester,
        gallery(<Widget>[
          const GroupHeader(title: 'Trễ hạn', count: 1),
          WorkRow.deadline(title: 'Duyệt hồ sơ', subtitle: 'DA-CB-017', daysRemaining: -1, dueDay: '2026-11-11', onTap: () {}),
          const StatStrip(cells: <StatCell>[StatCell(value: '6', label: 'Dự án'), StatCell(value: '5', label: 'Việc', band: DeadlineBand.late, bandText: 'Quá hạn')]),
          const StageStrip(total: 6, current: 2, label: 'Giai đoạn 2/6'),
          const InfoRow(label: 'Giá trị', value: '1 tỷ đồng'),
          FilterChips<int>(options: const <ChipOption<int>>[ChipOption<int>(value: 1, label: 'Tất cả')], selected: 1, onChanged: (_) {}),
          const StatusBanner(text: 'Ngoại tuyến'),
          const TimelineList(entries: <TimelineEntry>[TimelineEntry(title: 'a', when: 'b')]),
        ]),
        brightness: Brightness.dark,
        scale: 2.0,
        size: const Size(360, 800),
      );
      expect(tester.takeException(), isNull);
      final ThemeData theme = Theme.of(tester.element(find.byType(Scaffold)));
      expect(theme.brightness, Brightness.dark);
      expect(theme.extension<MachvonV2>()!.palette.surface, MachvonV2Colors.dark.surface);
      expect(theme.scaffoldBackgroundColor, MachvonV2Colors.dark.bg);
    });
  });
}
