import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/theme/colors.dart';
import 'package:machvon_mobile/core/widgets/info_row.dart';
import 'package:machvon_mobile/core/widgets/section_tabs.dart';
import 'package:machvon_mobile/core/widgets/stat_strip.dart';
import 'package:machvon_mobile/core/widgets/work_row.dart';

import '../../support/v2_support.dart';

void main() {
  group('SectionTabs, the tabs of a detail screen', () {
    List<SectionTab> tabs({int legal = 0}) => <SectionTab>[
          const SectionTab(label: 'Cần làm', count: 2, children: <Widget>[Text('Danh mục kiểm')]),
          const SectionTab(label: 'Thông tin', children: <Widget>[Text('Phân công')]),
          SectionTab(label: 'Căn cứ', count: legal, children: const <Widget>[Text('Luật Đầu tư công')]),
        ];

    testWidgets('only the groups of the chosen tab are shown, and a count of zero is left out', (WidgetTester tester) async {
      await pumpV2(tester, ListView(children: <Widget>[SectionTabs(tabs: tabs())]));
      expect(find.text('Danh mục kiểm'), findsOneWidget);
      expect(find.text('Phân công'), findsNothing);
      expect(find.bySemanticsLabel('Cần làm 2'), findsOneWidget);
      expect(find.bySemanticsLabel('Căn cứ'), findsOneWidget, reason: 'zero is not a count worth a number');
      await tester.tap(find.bySemanticsLabel('Thông tin'));
      await tester.pump();
      expect(find.text('Phân công'), findsOneWidget);
      expect(find.text('Danh mục kiểm'), findsNothing);
    });

    testWidgets('the chosen tab is kept when the screen is drawn again with new data', (WidgetTester tester) async {
      await pumpV2(tester, ListView(children: <Widget>[SectionTabs(tabs: tabs())]));
      await tester.tap(find.bySemanticsLabel('Căn cứ'));
      await tester.pump();
      expect(find.text('Luật Đầu tư công'), findsOneWidget);
      await pumpV2(tester, ListView(children: <Widget>[SectionTabs(tabs: tabs(legal: 3))]));
      expect(find.text('Luật Đầu tư công'), findsOneWidget, reason: 'a refresh does not send the reader back to the first tab');
      expect(find.bySemanticsLabel('Căn cứ 3'), findsOneWidget);
    });
  });

  group('SectionTabs, the row of tabs sticks to the top of the list while its groups scroll (owner review of 14/11/2026)', () {
    Widget screen() => ListView(
          children: <Widget>[
            const SizedBox(height: 240, child: Text('Đầu màn')),
            SectionTabs(
              tabs: <SectionTab>[
                SectionTab(label: 'Cần làm', children: <Widget>[for (int row = 0; row < 40; row += 1) SizedBox(height: 60, child: Text('Việc $row'))]),
                SectionTab(label: 'Thông tin', children: <Widget>[for (int row = 0; row < 40; row += 1) SizedBox(height: 60, child: Text('Dòng $row'))]),
              ],
            ),
          ],
        );

    testWidgets('before the list is scrolled the row sits where it is laid out, under the head of the screen', (WidgetTester tester) async {
      await pumpV2(tester, screen());
      final double top = tester.getTopLeft(find.byType(ListView)).dy;
      expect(tester.getTopLeft(find.bySemanticsLabel('Cần làm')).dy, greaterThanOrEqualTo(top + 240));
    });

    testWidgets('scrolled past, the row stays at the top of the list, over the rows, and a tab can be changed without scrolling back', (WidgetTester tester) async {
      await pumpV2(tester, screen());
      final double top = tester.getTopLeft(find.byType(ListView)).dy;
      await tester.drag(find.byType(ListView), const Offset(0, -900));
      await tester.pumpAndSettle();
      expect(find.text('Đầu màn'), findsNothing, reason: 'the head of the screen has scrolled away');
      final Rect row = tester.getRect(find.bySemanticsLabel('Cần làm'));
      expect(row.top, moreOrLessEquals(top, epsilon: 1), reason: 'the row of tabs is pinned to the top of the list');
      // The row is painted over the rows of the tab on an opaque surface, and takes the tap.
      await tester.tap(find.bySemanticsLabel('Thông tin'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Dòng '), findsWidgets);
      expect(find.textContaining('Việc '), findsNothing);
      expect(tester.getRect(find.bySemanticsLabel('Thông tin')).top, moreOrLessEquals(top, epsilon: 1));
    });

    testWidgets('the row never leaves the block of its own tabs: at the end of the list it scrolls away with the last rows', (WidgetTester tester) async {
      await pumpV2(
        tester,
        ListView(
          children: <Widget>[
            SectionTabs(tabs: const <SectionTab>[SectionTab(label: 'Cần làm', children: <Widget>[SizedBox(height: 120, child: Text('Một việc'))])]),
            const SizedBox(height: 2000, child: Text('Phần sau')),
          ],
        ),
      );
      await tester.drag(find.byType(ListView), const Offset(0, -600));
      await tester.pumpAndSettle();
      expect(find.bySemanticsLabel('Cần làm').hitTestable(), findsNothing, reason: 'the tabs do not float over what comes after their block');
    });
  });

  group('rows that carry a deadline line and long names', () {
    testWidgets('a row asked for three lines of title shows a long name whole, and its footer sits under the context across the width of the text', (WidgetTester tester) async {
      await pumpV2(
        tester,
        ListView(
          children: const <Widget>[
            WorkRow(title: 'Thẩm định báo cáo nghiên cứu khả thi (Sở Kế hoạch và Đầu tư)', titleMaxLines: 3, subtitle: 'Nguyễn Văn An', footer: Text('Còn 1 ngày làm việc · hạn 16/11')),
          ],
        ),
      );
      final Text title = tester.widget<Text>(find.text('Thẩm định báo cáo nghiên cứu khả thi (Sở Kế hoạch và Đầu tư)'));
      expect(title.maxLines, 3);
      expect(tester.getTopLeft(find.text('Còn 1 ngày làm việc · hạn 16/11')).dy, greaterThan(tester.getTopLeft(find.text('Nguyễn Văn An')).dy));
      expect(tester.getTopLeft(find.text('Còn 1 ngày làm việc · hạn 16/11')).dx, tester.getTopLeft(find.text('Nguyễn Văn An')).dx);
    });

    testWidgets('the values of a group of facts end on the same edge whatever their length', (WidgetTester tester) async {
      await pumpV2(
        tester,
        ListView(children: const <Widget>[InfoRow(label: 'Bắt đầu dự kiến', value: '03/09/2026'), InfoRow(label: 'Vai thực hiện', value: 'Cán bộ kế hoạch Ban quản lý dự án')]),
      );
      expect(tester.getTopRight(find.text('03/09/2026')).dx, tester.getTopRight(find.text('Cán bộ kế hoạch Ban quản lý dự án')).dx);
    });

    testWidgets('a strip whose cells are the three bands draws the shape of the band beside the figure and says the band once', (WidgetTester tester) async {
      await pumpV2(
        tester,
        const StatStrip(
          cells: <StatCell>[
            StatCell(value: '6', label: 'Quá hạn', band: DeadlineBand.late, bandInline: true),
            StatCell(value: '0', label: 'Sắp đến hạn', band: DeadlineBand.soon, bandInline: true),
            StatCell(value: '1', label: 'Còn thời gian', band: DeadlineBand.ok, bandInline: true),
          ],
        ),
      );
      expect(find.text('Quá hạn'), findsOneWidget, reason: 'the label says the band; no second label under it');
      expect(find.bySemanticsLabel('6 Quá hạn'), findsOneWidget);
      expect(find.byType(Icon), findsNWidgets(3));
    });
  });
}
