import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/l10n/string_table.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/navigation/mobile_routes.generated.dart';
import 'package:machvon_mobile/core/navigation/route_catalogue.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/core/widgets/app_scaffold.dart' show LargeTitleHeader;
import 'package:machvon_mobile/core/widgets/bottom_nav.dart' show AppBottomNav;
import 'package:machvon_mobile/core/widgets/progress.dart' show ProgressMeter;
import 'package:machvon_mobile/core/widgets/sheets.dart' show ActionSheet;
import 'package:machvon_mobile/core/widgets/stage_strip.dart' show StageStrip;
import 'package:machvon_mobile/core/widgets/work_row.dart' show GroupHeader, WorkRow;
import 'package:machvon_mobile/features/project_views/labels.dart';
import 'package:machvon_mobile/features/project_views/map_models.dart';
import 'package:machvon_mobile/features/project_views/project_models.dart';
import 'package:machvon_mobile/features/project_views/project_views_feature.dart' as project_views;
import 'package:machvon_mobile/features/project_views/project_views_strings.dart';
import 'package:machvon_mobile/features/project_views/screens/project_list_screen.dart' show kProjectWorkLinks;
import 'package:machvon_mobile/features/project_views/screens/project_list_screen.dart' show projectFilterProvider;
import 'package:machvon_mobile/features/project_workflow/project_workflow_feature.dart' as pwf;
import 'package:machvon_mobile/features/project_workflow/pwf_progress_section.dart';

import '../../support/harness.dart';
import '../../support/widget_host.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'project_fixtures.dart';

Future<ProviderContainer> _open(WidgetTester tester, ScriptedServer server, String location, {Locale locale = const Locale('vi'), DateTime Function()? now}) =>
    pumpWithServer(tester, features: <MobileFeature>[project_views.feature, pwf.feature], server: server, location: location, locale: locale, now: now);

void _register(ScriptedServer server, [List<Map<String, Object?>>? projects]) => server.on('GET', '/resources/project', (_) => page(projects ?? twoProjects));

void main() {
  group('UI-MOB-09 MOB-09 the way in to the screens that have no other entrance', () {
    const Map<String, String> entrances = <String, String>{
      'Báo cáo tháng': '/projects/mob-13',
      'Theo dõi thanh toán': '/projects/mob-27',
      'Đối soát Kho bạc': '/projects/mob-60',
      'Hợp đồng và nhật ký công trường': '/projects/mob-61',
      'Ghi nhận vướng mắc hiện trường': '/projects/mob-28',
      'Giải phóng mặt bằng hiện trường': '/projects/mob-68',
      'Bàn giao và bảo hành': '/projects/mob-66',
      'Hỏi đáp có nguồn về hồ sơ': '/projects/mob-37',
      'Phân tích nhà thầu': '/projects/mob-38',
      'Chỉ đạo giao ban': '/projects/dir-06',
      'Gói thầu theo công đoạn': '/projects/mob-69',
      'Rủi ro nhà thầu': '/projects/mob-73',
    };
    const Map<String, String> views = <String, String>{
      'Bản đồ hiện trường': '/projects/mob-11',
      'Kế hoạch vốn': '/projects/mob-12',
      'Dự án chưa nộp báo cáo': '/projects/mob-57',
      'Vướng mắc theo tuần': '/projects/mob-59',
    };

    Future<void> openSheet(WidgetTester tester) async {
      await tester.tap(find.byTooltip('Lối tắt'));
      await tester.pumpAndSettle();
    }

    testWidgets('the shortcuts are one button in the top bar: closed, the projects are the first thing on the page; open, every entrance is in the sheet', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _register(server);
      await _open(tester, server, '/projects');

      for (final String label in <String>[...entrances.keys, ...views.keys]) {
        expect(find.text(label), findsNothing, reason: label);
      }
      expect(find.text('DA-001 · Đường vành đai 1'), findsOneWidget);

      await openSheet(tester);
      expect(find.text('Báo cáo và công việc hiện trường'), findsOneWidget);
      for (final String label in <String>[...entrances.keys, ...views.keys]) {
        expect(find.text(label), findsOneWidget, reason: label);
      }
    });

    for (final MapEntry<String, String> entrance in <MapEntry<String, String>>[...entrances.entries, ...views.entries]) {
      testWidgets('"${entrance.key}" opens ${entrance.value} from the sheet and the sheet closes', (WidgetTester tester) async {
        useDevice(tester, kTallDevice);
        final ScriptedServer server = ScriptedServer();
        _register(server);
        final ProviderContainer container = await _open(tester, server, '/projects');

        await openSheet(tester);
        await tester.tap(find.text(entrance.key));
        await tester.pumpAndSettle();

        expect(currentLocation(container), entrance.value);
        expect(find.byType(ActionSheet), findsNothing);
      });
    }

    test('every entrance names a screen of the Projects tab that the catalogue knows', () {
      final Map<String, MobileRoute> byId = <String, MobileRoute>{for (final MobileRoute route in kMobileRoutes) route.id: route};
      for (final MapEntry<String Function(BuildContext), String> link in kProjectWorkLinks) {
        expect(byId[link.value]?.tab, AppTab.projects, reason: link.value);
        expect(entrances.values, contains('/projects/${link.value.toLowerCase()}'));
      }
      expect(kProjectWorkLinks, hasLength(entrances.length));
      for (final String location in views.values) {
        expect(byId[location.split('/').last.toUpperCase()]?.tab, AppTab.projects, reason: location);
      }
    });

    testWidgets('a search that finds nothing keeps the shortcuts reachable, and the sheet does not overflow on the narrowest phone', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes.first);
      final ScriptedServer server = ScriptedServer();
      _register(server);
      await _open(tester, server, '/projects');

      await tester.enterText(find.byType(TextField), 'khong co');
      await tester.pumpAndSettle();
      await openSheet(tester);

      expect(find.text('Báo cáo tháng'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });

  group('AC-ST-MOB-010-1 UI-MOB-09 MOB-09 the project list', () {
    testWidgets('shows only the projects the server returned for the scope; the moment they describe is said once, in the line of context', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _register(server);
      await _open(tester, server, '/projects');

      expect(find.descendant(of: find.byType(LargeTitleHeader), matching: find.text('Dự án')), findsOneWidget);
      expect(find.text('DA-001 · Đường vành đai 1'), findsOneWidget);
      expect(find.text('DA-002 · Cầu Sông Cầu'), findsOneWidget);
      expect(find.textContaining('Số liệu tại 31/10/2026 16:00'), findsOneWidget, reason: 'one line, not one per row');
      expect(find.textContaining('2 dự án'), findsOneWidget);
      expect(find.text('Ban QLDA giao thông · Phụ trách: Nguyễn Văn An'), findsOneWidget);
      expect(find.text('Ban QLDA giao thông'), findsOneWidget, reason: 'a project with no leader shows its unit only');
      expect(find.textContaining('Chưa phân công'), findsNothing, reason: 'a field that is not known is left out');
      expect(find.text('Nhóm B'), findsOneWidget);
      expect(find.byType(ProgressMeter), findsNothing, reason: 'the register gives no progress yet, so no bar is drawn');
    });

    testWidgets('a device offline for three days: one offline notice, the copy named with its moment and marked stale, latest is never said, no money field is editable', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      DateTime now = kNow;
      final ScriptedServer server = ScriptedServer();
      _register(server);
      final ProviderContainer container = await _open(tester, server, '/projects', now: () => now);

      server.offline = true;
      now = kNow.add(const Duration(days: 3));
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();

      expect(container.read(reachabilityProvider), Reachability.offline);
      expect(find.text('Bạn đang ngoại tuyến. Có thể tiếp tục soạn bản nháp. Phê duyệt cần kết nối.'), findsOneWidget, reason: 'the offline banner of the shell');
      expect(find.textContaining('ngoại tuyến'), findsOneWidget, reason: 'one offline notice, not two');
      expect(find.textContaining('Đang hiển thị dữ liệu đã lưu trên máy, số liệu tại 31/10/2026 16:00'), findsOneWidget);
      expect(find.text('Số liệu cũ'), findsOneWidget, reason: 'older than its time to live');
      expect(find.textContaining('Số tiền chỉ để tham khảo, không sửa được.'), findsOneWidget);
      expect(find.text('DA-001 · Đường vành đai 1'), findsOneWidget, reason: 'the rows are those of the copy');
      expect(find.textContaining('mới nhất'), findsNothing);
      expect(find.byType(TextField), findsOneWidget, reason: 'the search box is the only input of the screen');
    });

    testWidgets('the search ignores case and the marks of Vietnamese; a filter that finds nothing says so, names the filter and clearing brings everything back', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _register(server);
      await _open(tester, server, '/projects');

      await tester.enterText(find.byType(TextField), 'duong vanh');
      await tester.pumpAndSettle();
      expect(find.text('DA-001 · Đường vành đai 1'), findsOneWidget);
      expect(find.text('DA-002 · Cầu Sông Cầu'), findsNothing);

      await tester.enterText(find.byType(TextField), 'khong co');
      await tester.pumpAndSettle();
      expect(find.text('Không có dự án khớp'), findsOneWidget);
      expect(find.text('khong co'), findsWidgets);
      await tester.tap(find.text('Xóa bộ lọc'));
      await tester.pumpAndSettle();
      expect(find.text('DA-002 · Cầu Sông Cầu'), findsOneWidget);
      expect(find.text('DA-001 · Đường vành đai 1'), findsOneWidget);
    });

    testWidgets('the stage chips are the stages that are in the register, with their counts, and a chip narrows the list to that stage', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _register(server);
      await _open(tester, server, '/projects');

      expect(find.text('Tất cả 2'), findsOneWidget);
      expect(find.text('Đang thực hiện 1'), findsOneWidget);
      expect(find.text('Thẩm định 1'), findsOneWidget);
      expect(find.textContaining('Đã hủy'), findsNothing, reason: 'a stage nobody is in is not offered');

      await tester.tap(find.text('Thẩm định 1'));
      await tester.pumpAndSettle();
      expect(find.text('DA-002 · Cầu Sông Cầu'), findsOneWidget);
      expect(find.text('DA-001 · Đường vành đai 1'), findsNothing);
      expect(find.textContaining('Hiển thị 1 trên 2 dự án'), findsOneWidget);
    });

    testWidgets('a project opens its detail and back returns to the list with the filter as it was left', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _register(server);
      server.on('GET', '/resources/project/p-1', (_) => projectView('p-1', 'DA-001', 'Đường vành đai 1'));
      server.on('GET', '/projects/p-1/milestones', (_) => <String, Object?>{'items': <Object?>[], 'as_of': '2026-10-31'});
      server.on('GET', '/projects/p-1/risks', (_) => <String, Object?>{'items': <Object?>[], 'live_count': 0, 'critical_count': 0, 'overdue_count': 0, 'as_of': asOfInstant});
      final ProviderContainer container = await _open(tester, server, '/projects');

      await tester.ensureVisible(find.text('Đang thực hiện 1'));
      await tester.tap(find.text('Đang thực hiện 1'));
      await tester.pumpAndSettle();
      expect(container.read(projectFilterProvider).stage, ProjectStage.implementation);
      await tester.tap(find.text('DA-001 · Đường vành đai 1'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/projects/mob-10/p-1');
      expect(find.text('Chi tiết dự án'), findsOneWidget);
      await pressBack(tester);
      expect(currentLocation(container), '/projects');
      expect(find.text('DA-001 · Đường vành đai 1'), findsOneWidget);
      expect(container.read(projectFilterProvider).stage, ProjectStage.implementation);
      expect(find.text('DA-002 · Cầu Sông Cầu'), findsNothing, reason: 'the stage filter is where it was left');
      // The shell keeps the tab: the project list is still the Projects tab.
      expect(find.byType(AppBottomNav), findsOneWidget);
    });

    testWidgets('the filter belongs to the session: another person or organisation starts with none', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _register(server);
      final ProviderContainer container = await _open(tester, server, '/projects');

      await tester.enterText(find.byType(TextField), 'duong vanh');
      await tester.pumpAndSettle();
      expect(container.read(projectFilterProvider).query, 'duong vanh');
      (container.read(sessionProvider.notifier) as FakeSession).change(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-b', userId: 'user-2'));
      await tester.pumpAndSettle();

      expect(container.read(projectFilterProvider).isEmpty, isTrue);
    });

    testWidgets('AC-ST-MOB-010-5 UI-MOB-09 every state is drawn and the contract of the screen holds', (WidgetTester tester) async {
      await expectEveryState(
        tester,
        open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/projects'),
        script: StateScript(healthy: _register, content: find.text('DA-001 · Đường vành đai 1'), empty: (ScriptedServer server) => server.on('GET', '/resources/project', (_) => page(<Object?>[]))),
      );
      await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/projects'), healthy: _register);
    });
  });

  group('the place of a stage on the strip of six, and the milestones of a project', () {
    test('every stage has the place the design gives it; a rejected or cancelled project has none', () {
      final Map<ProjectStage, (int, bool)?> expected = <ProjectStage, (int, bool)?>{
        ProjectStage.concept: (1, false),
        ProjectStage.appraisal: (2, false),
        ProjectStage.pipeline: (3, false),
        ProjectStage.budgeted: (3, false),
        ProjectStage.implementation: (4, false),
        ProjectStage.suspended: (4, false),
        ProjectStage.completed: (5, false),
        ProjectStage.settled: (6, true),
        ProjectStage.closed: (6, true),
        ProjectStage.rejected: null,
        ProjectStage.cancelled: null,
      };
      expect(expected.keys.toSet(), ProjectStage.values.toSet(), reason: 'a stage added later has to be placed here');
      for (final MapEntry<ProjectStage, (int, bool)?> entry in expected.entries) {
        final StripPosition? position = stripPositionOf(entry.key);
        if (entry.value == null) {
          expect(position, isNull, reason: entry.key.name);
        } else {
          expect((position!.current, position.finished), entry.value, reason: entry.key.name);
          expect(position.current, lessThanOrEqualTo(kStageStripSegments));
        }
      }
    });

    test('a milestone that is late and not over needs attention; a done or cancelled one is over; the rest is coming', () {
      Milestone of(String status, {bool delayed = false}) => Milestone(id: status, name: status, plannedDate: '2026-11-01', status: status, delayDays: delayed ? 3 : 0, delayed: delayed);
      expect(milestoneGroupOf(of('PLANNED', delayed: true)), MilestoneGroup.attention);
      expect(milestoneGroupOf(of('DELAYED', delayed: true)), MilestoneGroup.attention);
      expect(milestoneGroupOf(of('DONE', delayed: true)), MilestoneGroup.over, reason: 'done late is done: the delay is not a warning any more');
      expect(milestoneGroupOf(of('CANCELLED', delayed: true)), MilestoneGroup.over);
      expect(milestoneGroupOf(of('PLANNED')), MilestoneGroup.upcoming);
    });

    test('the share done counts the milestones that count: a cancelled one does not, none that count is no share, a missing list is no share', () {
      Milestone of(String status) => Milestone(id: status, name: status, plannedDate: '2026-11-01', status: status, delayDays: 0, delayed: false);
      expect(milestoneFraction(<Milestone>[of('DONE'), of('PLANNED'), of('CANCELLED'), of('DONE')]), closeTo(2 / 3, 1e-9));
      expect(milestoneFraction(<Milestone>[of('CANCELLED')]), isNull);
      expect(milestoneFraction(const <Milestone>[]), isNull);
      expect(milestoneFraction(null), isNull);
    });
  });

  group('AC-ST-MOB-010-7 UI-MOB-10 MOB-10 the project detail', () {
    Map<String, Object?> milestone(String id, String name, {required String status, bool delayed = false, int delay = 0, String planned = '2026-03-10', String? actual}) => <String, Object?>{
          'id': id,
          'code': id,
          'name': name,
          'baseline_date': planned,
          'planned_date': planned,
          'actual_date': actual,
          'status': status,
          'delay_days': delay,
          'delayed': delayed,
        };

    void healthy(ScriptedServer server, {Map<String, Object?>? project}) {
      server
        ..on('GET', '/resources/project/p-1', (_) => project ?? projectView('p-1', 'DA-001', 'Đường vành đai 1'))
        ..on(
          'GET',
          '/projects/p-1/milestones',
          (_) => <String, Object?>{
            'items': <Object?>[
              milestone('ms-1', 'Khởi công', status: 'DONE', delayed: true, delay: 10, actual: '2026-03-20'),
              milestone('ms-2', 'Nghiệm thu giai đoạn 1', status: 'PLANNED', delayed: true, delay: 4, planned: '2026-10-20'),
              milestone('ms-3', 'Bàn giao', status: 'PLANNED', planned: '2027-06-01'),
            ],
            'as_of': '2026-10-31',
          },
        )
        ..on(
          'GET',
          '/projects/p-1/risks',
          (_) => <String, Object?>{
            'items': <Object?>[
              <String, Object?>{'id': 'r-1', 'code': 'R1', 'title': 'Chậm giải phóng mặt bằng', 'score': 20, 'level': 'CRITICAL', 'overdue': true, 'status': 'OPEN'},
            ],
            'live_count': 1,
            'critical_count': 1,
            'overdue_count': 1,
            'as_of': asOfInstant,
          },
        );
    }

    Future<void> tab(WidgetTester tester, String label) async {
      await tester.tap(find.text(label));
      await tester.pumpAndSettle();
    }

    testWidgets('the header names the project and its stage and shows where it stands on the strip of six; the overview gives the facts that are known and the risks', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      healthy(server);
      await _open(tester, server, '/projects/mob-10/p-1');

      expect(find.text('DA-001 · Đường vành đai 1'), findsOneWidget);
      expect(find.text('Đang thực hiện'), findsOneWidget);
      expect(find.byType(StageStrip), findsOneWidget);
      expect(find.text('Giai đoạn 4/6 · Đang thực hiện'), findsOneWidget);
      expect(find.text('Mốc đã xong 1/3'), findsOneWidget);
      for (final String known in <String>['Ban QLDA giao thông', 'Huyện Hòa Bình', 'Giao thông', 'Nguyễn Văn An', '2025 - 2027', '420 triệu đồng']) {
        expect(find.text(known), findsWidgets, reason: known);
      }
      expect(find.text('420 triệu đồng'), findsOneWidget, reason: 'the investment is said once on the page');
      expect(find.textContaining('Chưa có'), findsNothing);
      expect(find.text('1 rủi ro đang mở, 1 nghiêm trọng, 1 quá hạn xử lý'), findsOneWidget);
      expect(find.text('R1 Chậm giải phóng mặt bằng'), findsOneWidget);
      expect(find.text('điểm 20'), findsOneWidget);
      expect(find.text('nghiêm trọng'), findsOneWidget, reason: 'the level has its own word, beside its colour');
      expect(find.byType(TextField), findsNothing);
    });

    testWidgets('a field that is not known is left out of the overview, not shown as "None yet"', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      healthy(server, project: <String, Object?>{...projectView('p-1', 'DA-001', 'Đường vành đai 1', area: null, sector: null), 'leader_in_charge': null, 'project_group': null, 'national_project_code': null});
      await _open(tester, server, '/projects/mob-10/p-1');

      for (final String label in <String>['Địa bàn', 'Lĩnh vực', 'Người phụ trách', 'Nhóm dự án', 'Mã dự án quốc gia']) {
        expect(find.text(label), findsNothing, reason: label);
      }
      expect(find.textContaining('Chưa có'), findsNothing);
      expect(find.text('Đơn vị'), findsOneWidget, reason: 'what is known stays');
      expect(find.text('Giai đoạn thực hiện'), findsOneWidget);
    });

    testWidgets('the amounts follow the one formatter: 38 billion is not 38,000 million, and the capital tab gives the exact figure beside the short one', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      healthy(server, project: projectView('p-1', 'DA-001', 'Đường vành đai 1', total: '38000000000'));
      await _open(tester, server, '/projects/mob-10/p-1');

      expect(find.text('38 tỷ đồng'), findsOneWidget);
      expect(find.textContaining('38.000 triệu'), findsNothing);
      await tab(tester, 'Vốn');
      expect(find.text('38 tỷ đồng'), findsOneWidget);
      expect(find.text('38.000.000.000 đồng'), findsOneWidget);
      expect(find.textContaining('triệu'), findsNothing);
    });

    testWidgets('the progress tab groups the milestones by what needs attention, what is coming and what is over; a milestone done late has no warning', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      healthy(server);
      await _open(tester, server, '/projects/mob-10/p-1');
      await tab(tester, 'Tiến độ');

      Finder header(String title) => find.descendant(of: find.byType(GroupHeader), matching: find.text(title));
      final double attention = tester.getTopLeft(header('Cần chú ý')).dy;
      final double upcoming = tester.getTopLeft(header('Sắp tới')).dy;
      final double over = tester.getTopLeft(header('Đã xong')).dy;
      expect(attention, lessThan(upcoming));
      expect(upcoming, lessThan(over));
      expect(find.text('Nghiệm thu giai đoạn 1'), findsOneWidget);
      expect(find.text('Trễ 4 ngày'), findsOneWidget, reason: 'the delay is told by the late label');
      expect(find.text('Theo kế hoạch'), findsOneWidget);
      expect(find.text('Kế hoạch 10/03/2026, thực tế 20/03/2026, trễ 10 ngày'), findsOneWidget);
      final Finder done = find.ancestor(of: find.text('Khởi công'), matching: find.byType(WorkRow));
      expect(find.descendant(of: done, matching: find.byIcon(Icons.check_circle_outline)), findsWidgets, reason: 'done has its own shape');
      expect(find.descendant(of: done, matching: find.byIcon(Icons.report_outlined)), findsNothing, reason: 'a done milestone is not drawn as late');
      expect(find.descendant(of: done, matching: find.byIcon(Icons.warning_amber_rounded)), findsNothing);
    });

    testWidgets('a project with no workflow draws no task list: the milestones are the content of the tab', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      healthy(server);
      await _open(tester, server, '/projects/mob-10/p-1');
      await tab(tester, 'Tiến độ');
      expect(find.byType(PwfProgressSection), findsOneWidget);
      expect(find.descendant(of: find.byType(PwfProgressSection), matching: find.byType(WorkRow)), findsNothing);
      expect(find.descendant(of: find.byType(PwfProgressSection), matching: find.byType(GroupHeader)), findsNothing);
    });

    testWidgets('the workflow of the project gives the stages and the tasks with the official deadline bands, late first; the milestones stay the ones of the project', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer withTasks = ScriptedServer();
      healthy(withTasks);
      withTasks.on('GET', '/projects/:id/workflow', (_) => _workflow());
      await _open(tester, withTasks, '/projects/mob-10/p-1');
      await tab(tester, 'Tiến độ');
      await tester.pumpAndSettle();
      expect(find.text('Giai đoạn 1/2 · Thực hiện'), findsWidgets);
      expect(find.text('Hoàn thiện hồ sơ thiết kế'), findsOneWidget);
      expect(find.text('Trễ 2 ngày làm việc'), findsOneWidget);
      expect(find.text('Nộp báo cáo khả thi'), findsOneWidget);
      expect(find.text('Còn 8 ngày làm việc'), findsOneWidget);
      expect(tester.getTopLeft(find.text('Hoàn thiện hồ sơ thiết kế')).dy, lessThan(tester.getTopLeft(find.text('Nộp báo cáo khả thi')).dy), reason: 'late first');
      expect(find.text('Mốc chưa xong'), findsNothing, reason: 'the project lists its own milestones; the panel does not list those of the workflow in this tab');
    });

    testWidgets('a project that was rejected has its status and no strip', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      healthy(server, project: projectView('p-1', 'DA-001', 'Đường vành đai 1', status: 'REJECTED'));
      await _open(tester, server, '/projects/mob-10/p-1');

      expect(find.text('Bị từ chối'), findsOneWidget);
      expect(find.byType(StageStrip), findsNothing);
    });

    testWidgets('the capital and files tabs lead to the screens that exist', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      healthy(server);
      final ProviderContainer container = await _open(tester, server, '/projects/mob-10/p-1');

      await tab(tester, 'Vốn');
      expect(find.text('420.000.000 đồng'), findsOneWidget);
      await tester.tap(find.text('Kế hoạch vốn'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/projects/mob-12');
    });

    testWidgets('the files tab says the list of files is not on the phone and leads to the questions about the files', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      healthy(server);
      final ProviderContainer container = await _open(tester, server, '/projects/mob-10/p-1');

      await tab(tester, 'Hồ sơ');
      expect(find.textContaining('chưa có trên điện thoại'), findsOneWidget);
      await tester.tap(find.text('Hỏi đáp có nguồn về hồ sơ'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/projects/mob-37');
    });

    testWidgets('a part the reader may not read says so instead of showing nothing, in the overview and in the progress tab', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      healthy(server);
      server.refuse('GET', '/projects/p-1/risks', 403, 'SCOPE_DENIED');
      server.refuse('GET', '/projects/p-1/milestones', 403, 'SCOPE_DENIED');
      await _open(tester, server, '/projects/mob-10/p-1');

      expect(find.text('Bạn không có quyền xem phần này.'), findsOneWidget);
      expect(find.byType(StageStrip), findsOneWidget);
      expect(find.textContaining('Mốc đã xong'), findsNothing, reason: 'milestones that cannot be read are not counted as none');
      await tab(tester, 'Tiến độ');
      expect(find.text('Bạn không có quyền xem phần này.'), findsOneWidget);
    });

    testWidgets('a device offline for three days shows the copy of the project with its moment, marked stale, under the one offline banner', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      DateTime now = kNow;
      final ScriptedServer server = ScriptedServer();
      healthy(server);
      final ProviderContainer container = await _open(tester, server, '/projects/mob-10/p-1', now: () => now);

      server.offline = true;
      now = kNow.add(const Duration(days: 3));
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();

      expect(container.read(reachabilityProvider), Reachability.offline);
      expect(find.text('DA-001 · Đường vành đai 1'), findsOneWidget);
      expect(find.textContaining('ngoại tuyến'), findsOneWidget, reason: 'one offline notice');
      expect(find.textContaining('Đang hiển thị dữ liệu đã lưu trên máy'), findsOneWidget);
      expect(find.text('Số liệu cũ'), findsOneWidget);
      expect(find.textContaining('mới nhất'), findsNothing);
    });

    testWidgets('every state is drawn and the contract of the screen holds', (WidgetTester tester) async {
      await expectEveryState(
        tester,
        open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/projects/mob-10/p-1'),
        script: StateScript(healthy: healthy, content: find.text('DA-001 · Đường vành đai 1')),
      );
      await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/projects/mob-10/p-1'), healthy: healthy);
    });
  });

  group('AC-ST-MOB-010-8 UI-MOB-11 MOB-11 the field map and its policies', () {
    void healthy(ScriptedServer server) {
      _register(server, <Map<String, Object?>>[projectLine('p-1', 'DA-001', 'Đường vành đai 1'), projectLine('p-2', 'DA-002', 'Cầu Sông Cầu', status: 'APPRAISAL'), projectLine('p-3', 'DA-003', 'Kè sông')]);
      server
        ..on('GET', '/resources/project/p-1', (_) => projectView('p-1', 'DA-001', 'Đường vành đai 1'))
        ..on('GET', '/resources/project/p-2', (_) => projectView('p-2', 'DA-002', 'Cầu Sông Cầu', status: 'APPRAISAL', area: 'Huyện An Phú', areaKey: 'AP'))
        ..on('GET', '/resources/project/p-3', (_) => projectView('p-3', 'DA-003', 'Kè sông', area: null, sector: null));
    }

    testWidgets('projects are placed under the area they pin, those without an area are listed apart, and no tile is fetched or stored', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      healthy(server);
      await _open(tester, server, '/projects/mob-11');

      expect(find.text('Huyện An Phú (1 dự án)'), findsOneWidget);
      expect(find.text('Huyện Hòa Bình (1 dự án)'), findsOneWidget);
      expect(find.text('Chưa chọn địa bàn (1 dự án)'), findsOneWidget);
      expect(find.textContaining('Bản đồ nền chưa được bật'), findsOneWidget);
      expect(find.text('DA-001 · Đường vành đai 1'), findsOneWidget);
      expect(find.textContaining('Theo địa bàn, chưa có tọa độ'), findsNWidgets(3));
      expect(MapTilePolicy.downloadsTiles, isFalse);
      expect(MapTilePolicy.storesTilesOffline, isFalse);
      expect(server.calls.where((call) => !call.url.path.contains('/resources/project')), isEmpty, reason: 'nothing but the register and the projects is requested: no tile');
    });

    testWidgets('a position fixed by hand or by the device says so in words', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      await tester.pumpWidget(
        hostWidget(
          Builder(
            builder: (BuildContext context) => Column(children: <Widget>[for (final LocationSource source in LocationSource.values) Text(locationLabel(context, source))]),
          ),
          tables: <StringTable>[projectViewsStrings],
        ),
      );
      expect(find.text('Theo địa bàn, chưa có tọa độ'), findsOneWidget);
      expect(find.text('Vị trí từ thiết bị'), findsOneWidget);
      expect(find.text('Vị trí nhập tay'), findsOneWidget);
    });

    testWidgets('the stage filter narrows the map to the projects of that stage', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      healthy(server);
      await _open(tester, server, '/projects/mob-11');

      await tester.tap(find.text('Tất cả').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Thẩm định').last);
      await tester.pumpAndSettle();
      expect(find.text('Huyện An Phú (1 dự án)'), findsOneWidget);
      expect(find.text('Huyện Hòa Bình (1 dự án)'), findsNothing);
      expect(find.text('Chưa chọn địa bàn (1 dự án)'), findsNothing);
    });

    testWidgets('every state is drawn and the contract of the screen holds', (WidgetTester tester) async {
      await expectEveryState(
        tester,
        open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/projects/mob-11'),
        script: StateScript(healthy: healthy, content: find.textContaining('Bản đồ nền chưa được bật'), empty: (ScriptedServer server) => server.on('GET', '/resources/project', (_) => page(<Object?>[]))),
      );
      await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/projects/mob-11'), healthy: healthy);
    });
  });
}

/// The workflow of the project as the server answers it: one stage open, one task late and one coming.
Map<String, Object?> _workflow() {
  Map<String, Object?> band(String kind, int days) => <String, Object?>{'band': kind, 'remaining_days': days, 'unit': 'WORKING', 'overdue': days < 0};
  Map<String, Object?> task(String id, String name, Map<String, Object?> official, String finish) => <String, Object?>{
        'id': id,
        'task_code': id.toUpperCase(),
        'name': name,
        'phase_code': 'P1',
        'kind': 'TASK',
        'required': true,
        'priority': 'NORMAL',
        'status': 'IN_PROGRESS',
        'excluded': false,
        'tracked': true,
        'state': 'SCHEDULED',
        'planned_start': '2026-10-20',
        'planned_finish': finish,
        'baseline_finish': finish,
        'missing_year': null,
        'total_float': 0,
        'critical': false,
        'band': official,
        'assignee': null,
        'return_count': 0,
        'version': 1,
      };
  return <String, Object?>{
    'id': 'w-1',
    'project_id': 'p-1',
    'template_code': 'PUBLIC_INVESTMENT',
    'template_rule_version': 1,
    'template_hash': 'h',
    'unverified': false,
    'status': 'ACTIVE',
    'planned_start_date': '2026-10-01',
    'schedule_version': 1,
    'adopted_on': null,
    'open_phase': 'P1',
    'phases': <Object?>[
      <String, Object?>{'code': 'P1', 'name': 'Thực hiện', 'order': 1, 'gates': <Object?>[], 'required_total': 2, 'required_done': 0, 'open': true},
      <String, Object?>{'code': 'P2', 'name': 'Kết thúc', 'order': 2, 'gates': <Object?>[], 'required_total': 1, 'required_done': 0, 'open': false},
    ],
    'tasks': <Object?>[
      task('t-2', 'Nộp báo cáo khả thi', band('GREEN', 8), '2026-11-12'),
      task('t-1', 'Hoàn thiện hồ sơ thiết kế', band('RED', -2), '2026-11-01'),
    ],
    'gates': <Object?>[],
    'counts_by_band': <String, Object?>{'NONE': 0, 'GREEN': 1, 'YELLOW': 0, 'RED': 1, 'UNKNOWN': 0},
    'can_manage': false,
    'can_propose_reschedule': false,
    'version': 1,
    'as_of': '2026-11-03T03:00:00Z',
  };
}
