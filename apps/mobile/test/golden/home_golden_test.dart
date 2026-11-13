import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/theme/theme_mode.dart';
import 'package:machvon_mobile/features/dashboard/dashboard_feature.dart' as dashboard;

import '../features/dashboard/dashboard_fixtures.dart';
import '../features/support/scripted_server.dart';
import '../support/harness.dart';
import '../support/v2_support.dart';

/// Golden images of the home screens of MUX-3 wave A: the home of a leader (the command band, the line of context, the figures that wait, the
/// alerts as rows) in the light mode, the dark mode, at 200 percent text, with no snapshot yet and offline (the copy kept on the phone, one strip), the
/// day list of an officer (the three bands) and its empty state, and the sheet of one alert. The texts are drawn with the test font, which
/// Windows and Linux rasterise differently, so each OS compares with goldens of its own (useOsGoldens); layout and touch
/// targets are proved by the widget tests of the screens.

class _Dark extends ThemeModeNotifier {
  @override
  ThemeMode build() => ThemeMode.dark;
}

const Size _phone = Size(390, 844);

final List<Map<String, Object?>> _alerts = <Map<String, Object?>>[
  alertItem('a-urgent', severity: 'URGENT', source: 'REPORT', title: 'Báo cáo tuần 44: 3 chủ đầu tư quá hạn', dueOn: '2026-10-31', overdue: true, daysLate: 3, consequence: 'Số liệu giải ngân tuần không chốt được'),
  alertItem('a-action', severity: 'ACTION', source: 'ISSUE', title: 'Vướng mắc giải phóng mặt bằng', dueOn: '2026-11-04'),
  alertItem('a-soon', severity: 'ACTION', source: 'ADVANCE', title: 'Tạm ứng quá hạn thanh toán', dueOn: '2026-11-05'),
  alertItem('a-watch', severity: 'WATCH', source: 'PERMIT', title: 'Giấy phép DA-DT205 sắp hết hạn', dueOn: '2026-11-20'),
];

ScriptedServer _server({List<Map<String, Object?>>? alerts, bool center = true}) {
  final ScriptedServer server = ScriptedServer();
  if (center) {
    server.on('GET', '/home/command-center', (_) => commandCenter());
  } else {
    server.refuse('GET', '/home/command-center', 404, 'RESOURCE_NOT_FOUND');
  }
  server
    ..on('GET', '/home/my-work', (_) => alertWork(alerts ?? _alerts))
    ..on('GET', '/home/my-work/counts', (_) => alertCounts(urgent: 1, action: 2, watch: 1));
  return server;
}

Future<void> _open(WidgetTester tester, ScriptedServer server, String location, {bool dark = false, double scale = 1.0}) async {
  useDevice(tester, _phone, textScale: scale);
  await pumpWithServer(
    tester,
    features: <MobileFeature>[dashboard.feature],
    server: server,
    location: location,
    overrides: <Override>[if (dark) themeModeProvider.overrideWith(_Dark.new)],
  );
}

void main() {
  useOsGoldens('test/golden/home_golden_test.dart');

  group('golden images of the home of a leader', () {
    testWidgets('light', (WidgetTester tester) async {
      await _open(tester, _server(), '/home');
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/home_leader_light.png'));
    });

    testWidgets('dark', (WidgetTester tester) async {
      await _open(tester, _server(), '/home', dark: true);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/home_leader_dark.png'));
    });

    testWidgets('200 percent text', (WidgetTester tester) async {
      await _open(tester, _server(), '/home', scale: 2.0);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/home_leader_text200.png'));
    });

    testWidgets('no snapshot yet', (WidgetTester tester) async {
      await _open(tester, _server(center: false, alerts: <Map<String, Object?>>[]), '/home');
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/home_leader_empty.png'));
    });

    testWidgets('offline: the copy kept on the phone, one strip, no act', (WidgetTester tester) async {
      final ScriptedServer server = _server();
      await _open(tester, server, '/home');
      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/home_leader_offline.png'));
    });

    testWidgets('the sheet of one alert', (WidgetTester tester) async {
      await _open(tester, _server(), '/home');
      await tester.tap(find.text('Báo cáo tuần 44: 3 chủ đầu tư quá hạn'));
      await tester.pumpAndSettle();
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/home_alert_sheet.png'));
    });
  });

  group('golden images of the day list of an officer', () {
    testWidgets('light: three bands, each row with its deadline and its action', (WidgetTester tester) async {
      await _open(tester, _server(), '/home/mob-08');
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/home_officer_light.png'));
    });

    testWidgets('dark', (WidgetTester tester) async {
      await _open(tester, _server(), '/home/mob-08', dark: true);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/home_officer_dark.png'));
    });

    testWidgets('200 percent text', (WidgetTester tester) async {
      await _open(tester, _server(), '/home/mob-08', scale: 2.0);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/home_officer_text200.png'));
    });

    testWidgets('empty: the day is done', (WidgetTester tester) async {
      await _open(tester, _server(alerts: <Map<String, Object?>>[]), '/home/mob-08');
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/home_officer_empty.png'));
    });
  });
}
