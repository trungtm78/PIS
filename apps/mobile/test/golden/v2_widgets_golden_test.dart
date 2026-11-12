import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
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

import '../support/v2_support.dart';

/// Golden images of the shared widgets of the phone design (MUX-1): every group in the light mode, in the dark mode and at 200 percent text.
/// They are new, so no earlier image changes with them; a later change to a widget changes its images knowingly (the diff is reviewed, never
/// refreshed to pass).
Widget _rows() => gallery(<Widget>[
      const GroupHeader(title: 'Trễ hạn', count: 2),
      WorkRow.deadline(title: 'Duyệt hồ sơ thanh toán đợt 2 gói thầu xây lắp số 3', subtitle: 'DA-CB-017 · 3/4 chứng từ', daysRemaining: -2, dueDay: '2026-11-10', onTap: () {}),
      WorkRow.deadline(title: 'Nộp báo cáo giải ngân tháng 10', subtitle: 'DA-CB-023 · 1/1 chứng từ', daysRemaining: 0, dueDay: '2026-11-12', dividerAbove: true, onTap: () {}),
      const GroupHeader(title: 'Sắp đến hạn', count: 1),
      WorkRow.deadline(title: 'Ký biên bản nghiệm thu', subtitle: 'DA-CB-011', daysRemaining: 2, dueDay: '2026-11-14', action: OutlinedButton(onPressed: () {}, child: const Text('Nhận việc'))),
      const GroupHeader(title: 'Còn thời gian', count: 2),
      WorkRow.deadline(title: 'Cập nhật kế hoạch vốn năm 2027', subtitle: 'DA-CB-005', daysRemaining: 8, dueDay: '2026-11-20', onTap: () {}),
      WorkRow.deadline(title: 'Hồ sơ đã nộp', subtitle: 'DA-CB-001', daysRemaining: 0, band: DeadlineBand.done, dividerAbove: true, onTap: () {}),
      const WorkRowSkeleton(),
    ]);

Widget _summary() => gallery(<Widget>[
      const CommandBand(
        title: 'Tổng quan',
        subtitle: 'Toàn bộ phạm vi · tháng 11/2026',
        label: 'Giải ngân lũy kế 2026 theo Kho bạc Nhà nước',
        figure: '1.058,3',
        unit: 'tỷ đồng',
        progress: 0.581,
        progressLabel: 'Đã giải ngân 58,1% kế hoạch vốn',
        footStart: '58,1% kế hoạch vốn năm',
        footEnd: 'Kế hoạch 1.820 tỷ đồng',
        showBack: false,
      ),
      const StatStrip(
        cells: <StatCell>[
          StatCell(value: '6', of: '/32', label: 'Dự án chậm giải ngân', band: DeadlineBand.soon, bandText: 'Theo dõi'),
          StatCell(value: '5', label: 'Việc quá hạn', band: DeadlineBand.late, bandText: 'Quá hạn'),
          StatCell(value: '4', label: 'Chờ bạn duyệt'),
        ],
      ),
      const ContextLine(parts: <String>['Toàn bộ phạm vi', 'Chốt số liệu 06/11/2026', 'Cập nhật 00:08'], stale: true),
      const SizedBox(height: 16),
      const StageStrip(total: 6, current: 4, currentFraction: 0.58, label: 'Giai đoạn 4/6 · Thực hiện', trailing: 'Việc xong 7/12'),
      const SizedBox(height: 16),
      const InfoRow(label: 'Chủ đầu tư', value: 'Ban quản lý dự án đầu tư xây dựng tỉnh', divider: false),
      const InfoRow(label: 'Giá trị', value: '2.350.000.000 đồng (2,35 tỷ đồng)'),
      const InfoRow(label: 'Chưa có', value: null),
      const Padding(
        padding: EdgeInsets.all(16),
        child: MiniChart(
          data: <MiniChartDatum>[
            MiniChartDatum(label: 'Ngân sách trung ương', value: 63, valueText: '63 tỷ đồng', max: 100),
            MiniChartDatum(label: 'Ngân sách địa phương', value: 21, valueText: '21 tỷ đồng', max: 100),
          ],
        ),
      ),
      const Padding(padding: EdgeInsets.symmetric(horizontal: 16), child: ProgressMeter(value: 0.4)),
    ]);

Widget _controls() {
  return gallery(<Widget>[
    FilterChips<String>(
      options: const <ChipOption<String>>[ChipOption<String>(value: 'all', label: 'Tất cả'), ChipOption<String>(value: 'late', label: 'Chậm tiến độ', count: 6), ChipOption<String>(value: 'run', label: 'Đang thực hiện')],
      selected: 'late',
      onChanged: (_) {},
    ),
    UnderlineTabs(tabs: const <TabOption>[TabOption(label: 'Của tôi', count: 6), TabOption(label: 'Cả nhóm'), TabOption(label: 'Đã xong')], index: 0, onChanged: (_) {}),
    const SizedBox(height: 24),
    ActionBar(primary: const ActionBarButton(label: 'Phê duyệt', onPressed: null), secondary: ActionBarButton(label: 'Trả lại', onPressed: () {}), why: 'Phê duyệt cần kết nối mạng'),
    const SizedBox(height: 24),
    ActionBar(primary: ActionBarButton(label: 'Xác nhận phê duyệt', icon: Icons.check, onPressed: () {})),
  ]);
}

Widget _states() => gallery(
      <Widget>[
        const StatusBanner(text: 'Bạn đang ngoại tuyến. Có thể tiếp tục soạn bản nháp. Phê duyệt cần kết nối.'),
        StatusBanner(text: '2 thay đổi đang chờ gửi', icon: Icons.sync, onTap: () {}),
        const StatusBanner(text: 'Số liệu cũ: hãy kết nối mạng để kiểm tra lại.', tone: BannerTone.warning),
        StatusBanner(text: 'Thiết bị này có dấu hiệu đã bị can thiệp.', tone: BannerTone.late, actionLabel: 'Đã hiểu', onAction: () {}),
        SizedBox(height: 560, child: StateView(kind: StateKind.empty, title: 'Hôm nay bạn đã xong việc', body: 'Việc kế tiếp đến hạn ngày mai.', icon: Icons.check_circle_outline, actionLabel: 'Xem việc sắp tới', onAction: () {})),
      ],
    );

Widget _nav() => Column(
      children: <Widget>[
        const Expanded(
          child: Padding(
            padding: EdgeInsets.all(16),
            child: TimelineList(
              entries: <TimelineEntry>[
                TimelineEntry(title: 'Quá hạn nộp báo cáo', when: 'Hôm nay 08:00', band: DeadlineBand.late, detail: 'Trễ 2 ngày'),
                TimelineEntry(title: 'Đã gửi biên bản', when: 'Hôm qua 16:00', icon: Icons.send),
                TimelineEntry(title: 'Tạo việc', when: '10/11 09:30'),
              ],
            ),
          ),
        ),
        Align(alignment: Alignment.centerRight, child: Padding(padding: const EdgeInsets.all(16), child: FloatingPill(icon: Icons.add, label: 'Báo cáo', onPressed: () {}))),
        AppBottomNav(
          selectedIndex: 0,
          onSelected: (_) {},
          items: const <NavItem>[
            NavItem(icon: Icons.home_outlined, selectedIcon: Icons.home, label: 'Trang chủ'),
            NavItem(icon: Icons.apartment_outlined, selectedIcon: Icons.apartment, label: 'Dự án'),
            NavItem(icon: Icons.fact_check_outlined, selectedIcon: Icons.fact_check, label: 'Phê duyệt', badge: 3, badgeHint: '3 mục cần xử lý'),
            NavItem(icon: Icons.notifications_outlined, selectedIcon: Icons.notifications, label: 'Thông báo', badge: 12, badgeHint: '12 mục cần xử lý'),
            NavItem(icon: Icons.person_outline, selectedIcon: Icons.person, label: 'Cá nhân'),
          ],
        ),
      ],
    );

Widget _frame() => const AppScaffold(
      largeTitle: 'Việc hôm nay',
      subtitle: 'Thứ Năm, 12/11/2026 · Nguyễn Văn An',
      contextLine: ContextLine(parts: <String>['Của tôi', 'Cập nhật 08:00']),
      body: SizedBox.shrink(),
      showBack: false,
      bottomBar: ActionBar(primary: ActionBarButton(label: 'Báo cáo', onPressed: null), why: 'Cần kết nối mạng để gửi báo cáo'),
    );

void main() {
  useTolerantGoldens('test/golden/v2_widgets_golden_test.dart', tolerance: kTextGoldenTolerance);

  final Map<String, Widget Function()> groups = <String, Widget Function()>{
    'rows': _rows,
    'summary': _summary,
    'controls': _controls,
    'states': _states,
    'nav': _nav,
    'frame': _frame,
  };

  for (final MapEntry<String, Widget Function()> group in groups.entries) {
    testWidgets('golden ${group.key} in the light mode', (WidgetTester tester) async {
      await pumpV2(tester, group.value());
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/v2_${group.key}_light.png'));
    });

    testWidgets('golden ${group.key} in the dark mode', (WidgetTester tester) async {
      await pumpV2(tester, group.value(), brightness: Brightness.dark);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/v2_${group.key}_dark.png'));
    });

    testWidgets('golden ${group.key} at 200 percent text', (WidgetTester tester) async {
      await pumpV2(tester, group.value(), scale: 2.0, size: const Size(360, 800));
      expect(tester.takeException(), isNull, reason: '${group.key} must not overflow at 200 percent');
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/v2_${group.key}_text200.png'));
    });
  }

  testWidgets('golden of the confirm sheet in the light and the dark mode', (WidgetTester tester) async {
    for (final Brightness brightness in Brightness.values) {
      await pumpV2(
        tester,
        Builder(
          builder: (BuildContext context) => TextButton(
            onPressed: () => showConfirmSheet(
              context,
              title: 'Xác nhận phê duyệt',
              facts: const <String>['Điều chuyển 12 tỷ đồng từ DA-CB-017 sang DA-CB-023', 'Tổng vốn không đổi', 'Chứng từ đủ 4/4'],
              confirmLabel: 'Xác nhận phê duyệt',
              cancelLabel: 'Xem lại hồ sơ',
              auditNote: 'Quyết định được ghi vào nhật ký kiểm toán dưới tên bạn.',
            ),
            child: const Text('mở'),
          ),
        ),
        brightness: brightness,
      );
      await tester.tap(find.text('mở'));
      await tester.pumpAndSettle();
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/v2_sheet_${brightness.name}.png'));
    }
  });
}
