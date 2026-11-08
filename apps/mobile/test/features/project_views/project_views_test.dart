import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/l10n/string_table.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/navigation/mobile_routes.generated.dart';
import 'package:machvon_mobile/core/navigation/route_catalogue.dart';
import 'package:machvon_mobile/features/project_views/labels.dart';
import 'package:machvon_mobile/features/project_views/map_models.dart';
import 'package:machvon_mobile/features/project_views/project_views_feature.dart' as project_views;
import 'package:machvon_mobile/features/project_views/project_views_strings.dart';
import 'package:machvon_mobile/features/project_views/screens/project_list_screen.dart' show kProjectWorkLinks;

import '../../support/harness.dart';
import '../../support/widget_host.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'project_fixtures.dart';

Future<ProviderContainer> _open(WidgetTester tester, ScriptedServer server, String location, {Locale locale = const Locale('vi'), DateTime Function()? now}) =>
    pumpWithServer(tester, features: <MobileFeature>[project_views.feature], server: server, location: location, locale: locale, now: now);

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
    };

    testWidgets('the group is closed until it is opened, and the projects stay the first thing on the page', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _register(server);
      await _open(tester, server, '/projects');

      expect(find.text('Báo cáo và công việc hiện trường'), findsOneWidget);
      for (final String label in entrances.keys) {
        expect(find.text(label), findsNothing, reason: label);
      }
      expect(find.text('DA-001 · Đường vành đai 1'), findsOneWidget);

      await tester.tap(find.text('Báo cáo và công việc hiện trường'));
      await tester.pumpAndSettle();
      for (final String label in entrances.keys) {
        expect(find.text(label), findsOneWidget, reason: label);
      }
    });

    for (final MapEntry<String, String> entrance in entrances.entries) {
      testWidgets('"${entrance.key}" opens ${entrance.value}', (WidgetTester tester) async {
        useDevice(tester, kTallDevice);
        final ScriptedServer server = ScriptedServer();
        _register(server);
        final ProviderContainer container = await _open(tester, server, '/projects');

        await tester.tap(find.text('Báo cáo và công việc hiện trường'));
        await tester.pumpAndSettle();
        await tester.tap(find.text(entrance.key));
        await tester.pumpAndSettle();

        expect(currentLocation(container), entrance.value);
      });
    }

    test('every entrance names a screen of the Projects tab that the catalogue knows', () {
      final Map<String, MobileRoute> byId = <String, MobileRoute>{for (final MobileRoute route in kMobileRoutes) route.id: route};
      for (final MapEntry<String Function(BuildContext), String> link in kProjectWorkLinks) {
        expect(byId[link.value]?.tab, AppTab.projects, reason: link.value);
        expect(entrances.values, contains('/projects/${link.value.toLowerCase()}'));
      }
      expect(kProjectWorkLinks, hasLength(entrances.length));
    });

    testWidgets('a search that finds nothing keeps the group reachable and the page does not overflow with the group open', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes.first);
      final ScriptedServer server = ScriptedServer();
      _register(server);
      await _open(tester, server, '/projects');

      await tester.enterText(find.byType(TextField), 'khong co');
      await tester.pumpAndSettle();
      await tester.tap(find.text('Báo cáo và công việc hiện trường'));
      await tester.pumpAndSettle();

      expect(find.text('Báo cáo tháng'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });

  group('AC-ST-MOB-010-1 UI-MOB-09 MOB-09 the project list', () {
    testWidgets('shows only the projects the server returned for the scope, each row with its as_of', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _register(server);
      await _open(tester, server, '/projects');

      expect(find.text('DA-001 · Đường vành đai 1'), findsOneWidget);
      expect(find.text('DA-002 · Cầu Sông Cầu'), findsOneWidget);
      expect(find.text('Hiển thị 2 trên 2 dự án'), findsOneWidget);
      expect(find.text('Số liệu tại 31/10/2026 16:00'), findsNWidgets(3), reason: 'the bar and the two rows');
      expect(find.text('Mã quốc gia: QG-9'), findsOneWidget);
      expect(find.text('Chưa phân công người phụ trách'), findsOneWidget);
    });

    testWidgets('a device offline for three days: rows keep their as_of, the offline banner shows, latest is never said, no money field is editable', (WidgetTester tester) async {
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
      expect(find.textContaining('Đang hiển thị dữ liệu đã lưu trên máy, số liệu tại 31/10/2026 16:00'), findsOneWidget);
      expect(find.text('Số liệu tại 31/10/2026 16:00'), findsNWidgets(2), reason: 'each row says the moment it describes');
      expect(find.text('Số tiền chỉ để tham khảo, không sửa được.'), findsOneWidget);
      expect(find.textContaining('mới nhất'), findsNothing);
      expect(find.byType(TextField), findsOneWidget, reason: 'the search box is the only input of the screen');
    });

    testWidgets('the search ignores case and the marks of Vietnamese, and the stage filter narrows; clearing brings everything back', (WidgetTester tester) async {
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
      expect(find.text('Chưa có dữ liệu'), findsOneWidget);
      expect(find.text('khong co'), findsWidgets);
      await tester.tap(find.text('Xóa bộ lọc'));
      await tester.pumpAndSettle();
      expect(find.text('DA-002 · Cầu Sông Cầu'), findsOneWidget);

    });

    testWidgets('the stage filter narrows the list to the projects of that stage', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _register(server);
      await _open(tester, server, '/projects');

      await tester.tap(find.text('Tất cả').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Thẩm định').last);
      await tester.pumpAndSettle();
      expect(find.text('DA-002 · Cầu Sông Cầu'), findsOneWidget);
      expect(find.text('DA-001 · Đường vành đai 1'), findsNothing);
      expect(find.text('Hiển thị 1 trên 2 dự án'), findsOneWidget);
    });

    testWidgets('a project opens its detail and back returns to the list', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _register(server);
      server.on('GET', '/resources/project/p-1', (_) => projectView('p-1', 'DA-001', 'Đường vành đai 1'));
      server.on('GET', '/projects/p-1/milestones', (_) => <String, Object?>{'items': <Object?>[], 'as_of': '2026-10-31'});
      server.on('GET', '/projects/p-1/risks', (_) => <String, Object?>{'items': <Object?>[], 'live_count': 0, 'critical_count': 0, 'overdue_count': 0, 'as_of': asOfInstant});
      final ProviderContainer container = await _open(tester, server, '/projects');

      await tester.tap(find.text('DA-001 · Đường vành đai 1'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/projects/mob-10/p-1');
      expect(find.text('Chi tiết dự án'), findsOneWidget);
      await pressBack(tester);
      expect(currentLocation(container), '/projects');
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

  group('AC-ST-MOB-010-7 UI-MOB-10 MOB-10 the project detail', () {
    void healthy(ScriptedServer server) {
      server
        ..on('GET', '/resources/project/p-1', (_) => projectView('p-1', 'DA-001', 'Đường vành đai 1'))
        ..on(
          'GET',
          '/projects/p-1/milestones',
          (_) => <String, Object?>{
            'items': <Object?>[
              <String, Object?>{'id': 'ms-1', 'code': 'M1', 'name': 'Khởi công', 'baseline_date': '2026-03-01', 'planned_date': '2026-03-10', 'actual_date': '2026-03-20', 'status': 'DONE', 'delay_days': 10, 'delayed': true},
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

    testWidgets('shows the stage, the capital as read-only figures, the milestones and the risks', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      healthy(server);
      await _open(tester, server, '/projects/mob-10/p-1');

      expect(find.text('DA-001 · Đường vành đai 1'), findsOneWidget);
      expect(find.text('Đang thực hiện'), findsOneWidget);
      expect(find.text('420 triệu đồng'), findsOneWidget);
      expect(find.text('420.000.000 đồng'), findsOneWidget);
      expect(find.text('2025 - 2027'), findsOneWidget);
      expect(find.text('Khởi công'), findsOneWidget);
      expect(find.text('Kế hoạch 10/03/2026, thực tế 20/03/2026, trễ 10 ngày'), findsOneWidget);
      expect(find.text('1 rủi ro đang mở, 1 nghiêm trọng, 1 quá hạn xử lý'), findsOneWidget);
      expect(find.text('R1 Chậm giải phóng mặt bằng (điểm 20, mức nghiêm trọng)'), findsOneWidget);
      expect(find.byType(TextField), findsNothing);
    });

    testWidgets('a part the reader may not read says so instead of showing nothing', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      healthy(server);
      server.refuse('GET', '/projects/p-1/risks', 403, 'SCOPE_DENIED');
      await _open(tester, server, '/projects/mob-10/p-1');

      expect(find.text('Bạn không có quyền xem phần này.'), findsOneWidget);
      expect(find.text('Khởi công'), findsOneWidget);
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
