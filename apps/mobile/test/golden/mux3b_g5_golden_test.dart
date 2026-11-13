import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/theme/theme_mode.dart';
import 'package:machvon_mobile/features/ai_review/ai_review_feature.dart' as ai;
import 'package:machvon_mobile/features/committee_dashboard/committee_dashboard_feature.dart' as committee;
import 'package:machvon_mobile/features/dashboard/dashboard_feature.dart' as dashboard;
import 'package:machvon_mobile/features/directives/directives_feature.dart' as directives;

import '../features/ai_review/fixtures.dart';
import '../features/dashboard/committee_fixtures.dart';
import '../features/directives/directive_fixtures.dart';
import '../features/support/scripted_server.dart';
import '../support/harness.dart';
import '../support/v2_support.dart';

/// Golden images of the screens of MUX-3 wave B that belong to the directives (DIR-06), the AI review (MOB-38, MOB-37) and the committee
/// dashboard (MOB-72): the light mode, the dark mode, 200 percent text, the empty state and the offline state of each. They are drawn with the
/// test font, so the antialiasing of Windows and Linux may differ a little (the tolerance of the text-heavy goldens); layout and touch targets
/// are proved by the widget tests of the screens.

class _Dark extends ThemeModeNotifier {
  @override
  ThemeMode build() => ThemeMode.dark;
}

const Size _phone = Size(390, 844);

Future<void> _open(
  WidgetTester tester,
  ScriptedServer server, {
  required List<MobileFeature> features,
  required String location,
  bool dark = false,
  double scale = 1.0,
}) async {
  useDevice(tester, _phone, textScale: scale);
  await pumpWithServer(
    tester,
    features: features,
    server: server,
    location: location,
    overrides: <Override>[if (dark) themeModeProvider.overrideWith(_Dark.new)],
  );
}

ScriptedServer _directives({List<Map<String, Object?>>? items}) {
  final ScriptedServer server = ScriptedServer();
  server
    ..on('GET', '/directives', (_) => directivePage(items ?? threeDirectives))
    ..on('GET', '/directives/summary', (_) => directiveSummary())
    ..on('GET', '/directives/d-1', (_) => directiveDetailJson());
  return server;
}

ScriptedServer _ai({bool empty = false}) {
  final ScriptedServer server = ScriptedServer();
  aiServer(server);
  if (empty) server.on('GET', '/analysis-runs/:id/findings', (_) => findingsOf(<Map<String, Object?>>[]));
  return server;
}

ScriptedServer _committee() {
  final ScriptedServer server = ScriptedServer();
  server.on('GET', '/committee/workspace', (_) => committeeWorkspace());
  return server;
}

const String _dirList = '/projects/dir-06';
const String _findings = '/projects/mob-38?run=$kRun';
const String _qa = '/projects/mob-37?package=$kPackage';
const String _committeeScreen = '/home/mob-72';

final List<MobileFeature> _dirFeatures = <MobileFeature>[directives.feature];
final List<MobileFeature> _aiFeatures = <MobileFeature>[ai.feature];
final List<MobileFeature> _committeeFeatures = <MobileFeature>[dashboard.feature, committee.feature];

void main() {
  useTolerantGoldens('test/golden/mux3b_g5_golden_test.dart', tolerance: kTextGoldenTolerance);

  group('MUX-3 wave B directives (DIR-06)', () {
    testWidgets('light', (WidgetTester tester) async {
      await _open(tester, _directives(), features: _dirFeatures, location: _dirList);
      expect(find.text('Chỉ đạo trong phạm vi của bạn'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/directives_list_light.png'));
    });

    testWidgets('dark', (WidgetTester tester) async {
      await _open(tester, _directives(), features: _dirFeatures, location: _dirList, dark: true);
      expect(Theme.of(tester.element(find.text('Chỉ đạo trong phạm vi của bạn'))).brightness, Brightness.dark);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/directives_list_dark.png'));
    });

    testWidgets('text 200 percent', (WidgetTester tester) async {
      await _open(tester, _directives(), features: _dirFeatures, location: _dirList, scale: 2.0);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/directives_list_text200.png'));
    });

    testWidgets('empty', (WidgetTester tester) async {
      await _open(tester, _directives(items: <Map<String, Object?>>[]), features: _dirFeatures, location: _dirList);
      expect(find.text('Xóa bộ lọc'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/directives_list_empty.png'));
    });

    testWidgets('offline: the copy kept on the phone, labelled with its moment', (WidgetTester tester) async {
      final ScriptedServer server = _directives();
      await _open(tester, server, features: _dirFeatures, location: _dirList);
      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Đang hiển thị dữ liệu đã lưu trên máy'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/directives_list_offline.png'));
    });

    testWidgets('the detail sheet', (WidgetTester tester) async {
      await _open(tester, _directives(), features: _dirFeatures, location: _dirList);
      await tester.tap(find.text('GB-2026-014/CD-01'));
      await tester.pumpAndSettle();
      expect(find.text('Dòng thời gian'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/directives_detail_light.png'));
    });
  });

  group('MUX-3 wave B AI review (MOB-38, MOB-37)', () {
    testWidgets('findings: light', (WidgetTester tester) async {
      await _open(tester, _ai(), features: _aiFeatures, location: _findings);
      expect(find.text('Tiêu chí C-EXP-01'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/ai_findings_light.png'));
    });

    testWidgets('findings: dark', (WidgetTester tester) async {
      await _open(tester, _ai(), features: _aiFeatures, location: _findings, dark: true);
      expect(Theme.of(tester.element(find.text('Tiêu chí C-EXP-01'))).brightness, Brightness.dark);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/ai_findings_dark.png'));
    });

    testWidgets('findings: text 200 percent', (WidgetTester tester) async {
      await _open(tester, _ai(), features: _aiFeatures, location: _findings, scale: 2.0);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/ai_findings_text200.png'));
    });

    testWidgets('findings: empty run', (WidgetTester tester) async {
      await _open(tester, _ai(empty: true), features: _aiFeatures, location: _findings);
      expect(find.text('Lượt phân tích này chưa có nhận xét nào.'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/ai_findings_empty.png'));
    });

    testWidgets('findings: offline, nothing of a confidential bid is kept so nothing is shown', (WidgetTester tester) async {
      final ScriptedServer server = _ai()..offline = true;
      await _open(tester, server, features: _aiFeatures, location: _findings);
      expect(find.text('NETWORK_ERROR'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/ai_findings_offline.png'));
    });

    testWidgets('the question thread: light', (WidgetTester tester) async {
      await _open(tester, _ai(), features: _aiFeatures, location: _qa);
      await tester.enterText(find.byType(TextField), 'Kinh nghiệm của nhà thầu?');
      await tester.tap(find.widgetWithText(FilledButton, 'Hỏi'));
      await tester.pumpAndSettle();
      expect(find.textContaining('đoạn gần nhất'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/ai_qa_light.png'));
    });
  });

  group('MUX-3 wave B committee dashboard (MOB-72)', () {
    testWidgets('light', (WidgetTester tester) async {
      await _open(tester, _committee(), features: _committeeFeatures, location: _committeeScreen);
      expect(find.text('Số liệu đến ngày 31/10/2026, năm 2026'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/committee_light.png'));
    });

    testWidgets('dark', (WidgetTester tester) async {
      await _open(tester, _committee(), features: _committeeFeatures, location: _committeeScreen, dark: true);
      expect(Theme.of(tester.element(find.text('Số liệu đến ngày 31/10/2026, năm 2026'))).brightness, Brightness.dark);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/committee_dark.png'));
    });

    testWidgets('text 200 percent', (WidgetTester tester) async {
      await _open(tester, _committee(), features: _committeeFeatures, location: _committeeScreen, scale: 2.0);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/committee_text200.png'));
    });

    testWidgets('offline: no copy of the confidential workspace, the state offers a retry', (WidgetTester tester) async {
      final ScriptedServer server = _committee()..offline = true;
      await _open(tester, server, features: _committeeFeatures, location: _committeeScreen);
      expect(find.text('NETWORK_ERROR'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/committee_offline.png'));
    });
  });
}
