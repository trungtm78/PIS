import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/navigation/mobile_routes.generated.dart';
import 'package:machvon_mobile/core/navigation/route_table.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/features/project_workflow/project_workflow_feature.dart' as pwf;

import '../features/project_workflow/pwf_fixtures.dart';
import '../features/support/scripted_server.dart';
import '../support/harness.dart';
import '../support/offline_support.dart';
import '../support/v2_support.dart';

/// Golden images of the workflow screens of the phone (MOB-78 to MOB-82) in the states a person meets: the light and the dark mode, 200 percent text, the
/// empty state and no connection. They are new, so no earlier image changes with them; a later change to a screen changes its images knowingly (the diff is
/// reviewed, never refreshed to pass). Layout, sizes and touch targets are proved by the widget tests next to them, not by the pixels, which a Windows
/// machine and a Linux runner draw a little differently: the text tolerance of the other v2 goldens applies.
String _at(String screenId, [String suffix = '']) => RouteTable(routes: kMobileRoutes, features: <MobileFeature>[pwf.feature]).locationOf(screenId) + suffix;

Future<void> _open(WidgetTester tester, ScriptedServer server, String screenId, {String suffix = '', double scale = 1.0, Brightness brightness = Brightness.light, Size size = const Size(390, 844)}) async {
  useDevice(tester, size, textScale: scale);
  tester.platformDispatcher.platformBrightnessTestValue = brightness;
  addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);
  await pumpWithServer(
    tester,
    features: <MobileFeature>[pwf.feature],
    server: server,
    location: _at(screenId, suffix),
    overrides: <Override>[offlineStorageProvider.overrideWithValue(TestStorage.create().storage)],
  );
  await tester.pump(const Duration(milliseconds: 300));
}

ScriptedServer _workflow() => ScriptedServer()..on('GET', '/projects/:id/workflow', (_) => workflowJson());
ScriptedServer _mine() => ScriptedServer()..on('GET', '/me/project-tasks', (_) => myTasksJson());
ScriptedServer _task() => ScriptedServer()..on('GET', '/project-tasks/:id', (_) => taskDetailJson(TaskState(), blockers: <Map<String, Object?>>[<String, Object?>{'code': 'CHECKLIST_ITEM_OPEN', 'subject': 'C1'}]));
ScriptedServer _score() => ScriptedServer()..on('GET', '/me/staff-scores', (_) => scoresJson(items: <Map<String, Object?>>[scoreItem(adjusted: 85)]));
ScriptedServer _preference() => ScriptedServer()..on('GET', '/me/deadline-preference', (_) => preferenceJson(green: 7, yellow: 3, red: 1, reminders: <int>[5, 2, 0]));

void main() {
  useTolerantGoldens('test/golden/pwf_golden_test.dart', tolerance: kTextGoldenTolerance);

  final Map<String, ({ScriptedServer Function() server, String screen, String suffix})> screens = <String, ({ScriptedServer Function() server, String screen, String suffix})>{
    'workflow': (server: _workflow, screen: 'MOB-78', suffix: '/$kProjectId'),
    'mine': (server: _mine, screen: 'MOB-80', suffix: ''),
    'task': (server: _task, screen: 'MOB-79', suffix: '/$kTaskId'),
    'score': (server: _score, screen: 'MOB-81', suffix: ''),
    'reminders': (server: _preference, screen: 'MOB-82', suffix: ''),
  };

  for (final MapEntry<String, ({ScriptedServer Function() server, String screen, String suffix})> entry in screens.entries) {
    testWidgets('golden ${entry.key} in the light mode', (WidgetTester tester) async {
      await _open(tester, entry.value.server(), entry.value.screen, suffix: entry.value.suffix);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/pwf_${entry.key}_light.png'));
      await _letGo(tester);
    });

    testWidgets('golden ${entry.key} in the dark mode', (WidgetTester tester) async {
      await _open(tester, entry.value.server(), entry.value.screen, suffix: entry.value.suffix, brightness: Brightness.dark);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/pwf_${entry.key}_dark.png'));
      await _letGo(tester);
    });

    testWidgets('golden ${entry.key} at 200 percent text', (WidgetTester tester) async {
      await _open(tester, entry.value.server(), entry.value.screen, suffix: entry.value.suffix, scale: 2.0, size: const Size(360, 800));
      expect(tester.takeException(), isNull, reason: '${entry.key} must not overflow at 200 percent');
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/pwf_${entry.key}_text200.png'));
      await _letGo(tester);
    });
  }

  testWidgets('golden of a project with no workflow (the empty state)', (WidgetTester tester) async {
    await _open(tester, ScriptedServer()..refuse('GET', '/projects/:id/workflow', 404, 'RESOURCE_NOT_FOUND'), 'MOB-78', suffix: '/$kProjectId');
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/pwf_workflow_empty_light.png'));
    await _letGo(tester);
  });

  testWidgets('golden of my tasks when there is nothing to do (the empty state)', (WidgetTester tester) async {
    await _open(tester, ScriptedServer()..on('GET', '/me/project-tasks', (_) => myTasksJson(items: <Map<String, Object?>>[])), 'MOB-80');
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/pwf_mine_empty_light.png'));
    await _letGo(tester);
  });

  testWidgets('golden of my tasks with no connection and no copy (the offline state)', (WidgetTester tester) async {
    await _open(tester, ScriptedServer()..offline = true, 'MOB-80');
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/pwf_mine_offline_light.png'));
    await _letGo(tester);
  });

  testWidgets('golden of my score with no connection: nothing of it is kept, so there is nothing to show (the offline state)', (WidgetTester tester) async {
    await _open(tester, ScriptedServer()..offline = true, 'MOB-81');
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/pwf_score_offline_light.png'));
    await _letGo(tester);
  });
}

/// The screens watch the queue through providers that are let go with the screen: let the tree go before the test ends.
Future<void> _letGo(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump(Duration.zero);
}
