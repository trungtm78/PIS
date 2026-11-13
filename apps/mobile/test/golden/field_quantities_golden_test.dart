import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/widgets/app_scaffold.dart';
import 'package:machvon_mobile/core/widgets/state_view.dart';

import '../features/field_quantities/view_fixtures.dart';
import '../features/site_clearance/clearance_rig.dart';
import '../features/support/scripted_server.dart';
import '../support/harness.dart';
import '../support/v2_support.dart';

/// Golden images of the field screens of the phone design (MUX-3 wave C): the quantity entry (MOB-63), the inspection (MOB-64) and the task of a
/// household in the land clearance (MOB-68), each in the light mode, the dark mode, at 200 percent text, empty and offline. They are new, so no
/// earlier image changes with them; a later change changes them knowingly (the diff is reviewed, never refreshed to pass).
///
/// The quantity and the inspection are drawn from their views on sample data: the place field and the photographs, which belong to the evidence
/// feature and need the camera and the position of the phone, stand as one line each. The task of a household is the real screen, on a scripted
/// server and a fixed clock.
const Size _phone = Size(390, 844);
const Size _small = Size(360, 800);

Future<void> _openTask(WidgetTester tester, {required Size size, double scale = 1.0, bool dark = false, List<Object?>? records, bool offline = false}) async {
  useDevice(tester, size, textScale: scale);
  tester.platformDispatcher.platformBrightnessTestValue = dark ? Brightness.dark : Brightness.light;
  addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);
  final ScriptedServer server = ScriptedServer();
  answerClearance(server, records: records);
  await openClearance(tester, server, kClearanceTask);
  if (offline) {
    server.offline = true;
    await tester.tap(find.byTooltip('Làm mới'));
    await tester.pumpAndSettle();
  }
}

void main() {
  useOsGoldens('test/golden/field_quantities_golden_test.dart');

  final Map<String, Widget Function(bool empty, bool offline)> screens = <String, Widget Function(bool empty, bool offline)>{
    'quantity': (bool empty, bool offline) => sampleQuantityScreen(empty: empty, offline: offline),
    'inspection': (bool empty, bool offline) => empty
        ? Builder(builder: (BuildContext context) => AppScaffold(title: 'Kiểm tra chất lượng hiện trường', body: StateView(kind: StateKind.empty, actionLabel: 'Thử lại', onAction: () {})))
        : sampleInspectionScreen(offline: offline, errors: offline ? const <String, String>{} : const <String, String>{'answer:K2': 'Chọn kết quả cho hạng mục này.'}),
  };

  for (final MapEntry<String, Widget Function(bool, bool)> screen in screens.entries) {
    final String name = screen.key;
    testWidgets('golden of the $name screen in the light mode', (WidgetTester tester) async {
      await pumpV2(tester, screen.value(false, false), tables: kFieldViewTables);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/field_${name}_light.png'));
    });

    testWidgets('golden of the $name screen in the dark mode', (WidgetTester tester) async {
      await pumpV2(tester, screen.value(false, false), tables: kFieldViewTables, brightness: Brightness.dark);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/field_${name}_dark.png'));
    });

    testWidgets('golden of the $name screen at 200 percent text', (WidgetTester tester) async {
      await pumpV2(tester, screen.value(false, false), tables: kFieldViewTables, scale: 2.0, size: _small);
      expect(tester.takeException(), isNull, reason: 'the $name screen must not overflow at 200 percent');
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/field_${name}_text200.png'));
    });

    testWidgets('golden of the $name screen empty', (WidgetTester tester) async {
      await pumpV2(tester, screen.value(true, false), tables: kFieldViewTables);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/field_${name}_empty.png'));
    });

    testWidgets('golden of the $name screen offline', (WidgetTester tester) async {
      await pumpV2(tester, screen.value(false, true), tables: kFieldViewTables);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/field_${name}_offline.png'));
    });
  }

  testWidgets('golden of the clearance task in the light mode', (WidgetTester tester) async {
    await _openTask(tester, size: _phone);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/field_clearance_light.png'));
  });

  testWidgets('golden of the clearance task in the dark mode', (WidgetTester tester) async {
    await _openTask(tester, size: _phone, dark: true);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/field_clearance_dark.png'));
  });

  testWidgets('golden of the clearance task at 200 percent text', (WidgetTester tester) async {
    await _openTask(tester, size: _small, scale: 2.0);
    expect(tester.takeException(), isNull, reason: 'the task must not overflow at 200 percent');
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/field_clearance_text200.png'));
  });

  testWidgets('golden of the clearance task with no inventory counted yet', (WidgetTester tester) async {
    await _openTask(tester, size: _phone, records: <Object?>[]);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/field_clearance_empty.png'));
  });

  testWidgets('golden of the clearance task offline, the copy kept on the phone with the send locked and its reason', (WidgetTester tester) async {
    await _openTask(tester, size: _phone, offline: true);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/field_clearance_offline.png'));
  });
}
