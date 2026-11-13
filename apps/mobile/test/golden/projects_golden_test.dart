import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/theme/theme_mode.dart';
import 'package:machvon_mobile/features/project_views/project_views_feature.dart' as project_views;

import '../features/project_views/project_fixtures.dart';
import '../features/support/scripted_server.dart';
import '../support/harness.dart';
import '../support/v2_support.dart';

/// Goldens of the project list (MOB-09) and the project detail (MOB-10) in the states that matter: light, dark, text at 200 percent, the
/// register that is empty, and a device that is offline (the copy, marked stale, under the one banner of the shell).

final List<Map<String, Object?>> _projects = <Map<String, Object?>>[
  projectLine('p-1', 'DA-001', 'Đường vành đai 1 đoạn từ Km0 đến Km12, giai đoạn 2', national: 'QG-9', group: 'B'),
  projectLine('p-2', 'DA-002', 'Cầu Sông Cầu', status: 'APPRAISAL', leader: null),
  projectLine('p-3', 'DA-003', 'Kè chống sạt lở sông Hồng', status: 'BUDGETED', group: 'C'),
  projectLine('p-4', 'DA-004', 'Trường THPT Lê Quý Đôn', status: 'COMPLETED', group: 'C', leader: 'Trần Thị Bình'),
  projectLine('p-5', 'DA-005', 'Bệnh viện đa khoa tỉnh', status: 'SETTLED', group: 'A'),
];

void _list(ScriptedServer server, {List<Map<String, Object?>>? projects}) => server.on('GET', '/resources/project', (_) => page(projects ?? _projects));

void _detail(ScriptedServer server) {
  server
    ..on('GET', '/resources/project/p-1', (_) => projectView('p-1', 'DA-001', 'Đường vành đai 1 đoạn từ Km0 đến Km12, giai đoạn 2', total: '527000000000'))
    ..on(
      'GET',
      '/projects/p-1/milestones',
      (_) => <String, Object?>{
        'items': <Object?>[
          <String, Object?>{'id': 'ms-1', 'code': 'M1', 'name': 'Khởi công', 'baseline_date': '2026-03-01', 'planned_date': '2026-03-10', 'actual_date': '2026-03-20', 'status': 'DONE', 'delay_days': 10, 'delayed': true},
          <String, Object?>{'id': 'ms-2', 'code': 'M2', 'name': 'Nghiệm thu giai đoạn 1', 'baseline_date': '2026-10-01', 'planned_date': '2026-10-20', 'status': 'PLANNED', 'delay_days': 4, 'delayed': true},
          <String, Object?>{'id': 'ms-3', 'code': 'M3', 'name': 'Bàn giao đưa vào sử dụng', 'baseline_date': '2027-06-01', 'planned_date': '2027-06-01', 'status': 'PLANNED', 'delay_days': 0, 'delayed': false},
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
          <String, Object?>{'id': 'r-2', 'code': 'R2', 'title': 'Giá vật liệu tăng', 'score': 9, 'level': 'MEDIUM', 'overdue': false, 'status': 'OPEN'},
        ],
        'live_count': 2,
        'critical_count': 1,
        'overdue_count': 1,
        'as_of': asOfInstant,
      },
    );
}

Future<ProviderContainer> _open(WidgetTester tester, ScriptedServer server, String location, {bool dark = false, double scale = 1, DateTime Function()? now}) async {
  useDevice(tester, kDeviceSizes[1], textScale: scale);
  final ProviderContainer container = await pumpWithServer(tester, features: <MobileFeature>[project_views.feature], server: server, location: location, now: now);
  if (dark) {
    await container.read(themeModeProvider.notifier).select(ThemeMode.dark);
    await tester.pumpAndSettle();
  }
  return container;
}

Future<void> _matches(WidgetTester tester, String name) => expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/$name.png'));

void main() {
  // The screens are full of text, which Windows and Linux draw with different hinting: each OS compares with goldens of its own.
  useOsGoldens('test/golden/projects_golden_test.dart');

  group('golden images of the project list (MOB-09)', () {
    testWidgets('light', (WidgetTester tester) async {
      final ScriptedServer server = ScriptedServer();
      _list(server);
      await _open(tester, server, '/projects');
      await _matches(tester, 'projects_list_light');
    });

    testWidgets('dark', (WidgetTester tester) async {
      final ScriptedServer server = ScriptedServer();
      _list(server);
      await _open(tester, server, '/projects', dark: true);
      await _matches(tester, 'projects_list_dark');
    });

    testWidgets('text at 200 percent', (WidgetTester tester) async {
      final ScriptedServer server = ScriptedServer();
      _list(server);
      await _open(tester, server, '/projects', scale: 2);
      await _matches(tester, 'projects_list_text200');
    });

    testWidgets('empty: the register has no project', (WidgetTester tester) async {
      final ScriptedServer server = ScriptedServer();
      _list(server, projects: <Map<String, Object?>>[]);
      await _open(tester, server, '/projects');
      await _matches(tester, 'projects_list_empty');
    });

    testWidgets('the filter finds nothing', (WidgetTester tester) async {
      final ScriptedServer server = ScriptedServer();
      _list(server);
      await _open(tester, server, '/projects');
      await tester.enterText(find.byType(TextField), 'khong co');
      await tester.pumpAndSettle();
      await _matches(tester, 'projects_list_nomatch');
    });

    testWidgets('offline: the copy with its moment, marked stale, under the one banner', (WidgetTester tester) async {
      DateTime now = kNow;
      final ScriptedServer server = ScriptedServer();
      _list(server);
      await _open(tester, server, '/projects', now: () => now);
      server.offline = true;
      now = kNow.add(const Duration(days: 3));
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();
      await _matches(tester, 'projects_list_offline');
    });

    testWidgets('the shortcut sheet', (WidgetTester tester) async {
      final ScriptedServer server = ScriptedServer();
      _list(server);
      await _open(tester, server, '/projects');
      await tester.tap(find.byTooltip('Lối tắt'));
      await tester.pumpAndSettle();
      await _matches(tester, 'projects_list_shortcuts');
    });
  });

  group('golden images of the project detail (MOB-10)', () {
    testWidgets('overview, light', (WidgetTester tester) async {
      final ScriptedServer server = ScriptedServer();
      _detail(server);
      await _open(tester, server, '/projects/mob-10/p-1');
      await _matches(tester, 'projects_detail_overview_light');
    });

    testWidgets('overview, dark', (WidgetTester tester) async {
      final ScriptedServer server = ScriptedServer();
      _detail(server);
      await _open(tester, server, '/projects/mob-10/p-1', dark: true);
      await _matches(tester, 'projects_detail_overview_dark');
    });

    testWidgets('overview, text at 200 percent', (WidgetTester tester) async {
      final ScriptedServer server = ScriptedServer();
      _detail(server);
      await _open(tester, server, '/projects/mob-10/p-1', scale: 2);
      await _matches(tester, 'projects_detail_overview_text200');
    });

    testWidgets('progress, light', (WidgetTester tester) async {
      final ScriptedServer server = ScriptedServer();
      _detail(server);
      await _open(tester, server, '/projects/mob-10/p-1');
      await tester.ensureVisible(find.text('Tiến độ'));
      await tester.tap(find.text('Tiến độ'));
      await tester.pumpAndSettle();
      await _matches(tester, 'projects_detail_progress_light');
    });

    testWidgets('progress, dark', (WidgetTester tester) async {
      final ScriptedServer server = ScriptedServer();
      _detail(server);
      await _open(tester, server, '/projects/mob-10/p-1', dark: true);
      await tester.ensureVisible(find.text('Tiến độ'));
      await tester.tap(find.text('Tiến độ'));
      await tester.pumpAndSettle();
      await _matches(tester, 'projects_detail_progress_dark');
    });

    testWidgets('progress, text at 200 percent', (WidgetTester tester) async {
      final ScriptedServer server = ScriptedServer();
      _detail(server);
      await _open(tester, server, '/projects/mob-10/p-1', scale: 2);
      await tester.ensureVisible(find.text('Tiến độ'));
      await tester.tap(find.text('Tiến độ'));
      await tester.pumpAndSettle();
      await _matches(tester, 'projects_detail_progress_text200');
    });
  });
}
