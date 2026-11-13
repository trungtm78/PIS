import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/theme/theme_mode.dart';
import 'package:machvon_mobile/features/approval_inbox/approval_inbox_feature.dart' as approval;

import '../features/approval_inbox/approval_fixtures.dart';
import '../features/support/scripted_server.dart';
import '../support/harness.dart';
import '../support/v2_support.dart';

/// Golden images of the approvals (MUX-3 wave B): the inbox (grouped by overdue, with chips), the detail with the bar of decisions, the
/// confirmation sheet, each in the light mode, the dark mode and at 200 percent text, plus the empty inbox and the copy kept on the phone
/// (offline, decisions locked). The texts are drawn with the test font; the antialiasing difference between Windows and Linux is accepted up to
/// the tolerance of the text-heavy goldens. Layout and touch targets are proved by the widget tests next to them.

class _Dark extends ThemeModeNotifier {
  @override
  ThemeMode build() => ThemeMode.dark;
}

const Size _phone = Size(390, 844);

void _reads(ScriptedServer server, {List<Map<String, Object?>>? tasks}) {
  final List<Map<String, Object?>> list = tasks ??
      <Map<String, Object?>>[
        approvalTask('t-1', due: '2026-11-01T10:00:00Z', overdue: true),
        approvalTask('t-2', due: '2026-11-14T10:00:00Z', businessType: 'payment.approve', step: 'Kế toán trưởng'),
        approvalTask('t-4', canDecide: false, businessType: 'contract.change', step: 'Xem để biết'),
      ];
  server
    ..on('GET', '/resources/approval_task', (_) => page(list))
    ..on('GET', '/resources/organization_unit', (_) => unitsPage())
    ..on('GET', '/resources/approval_task/t-1', (_) => list.isEmpty ? approvalTask('t-1') : list.first)
    ..on('GET', '/resources/organization_unit/u-bql1', (_) => <String, Object?>{'id': 'u-bql1', 'name': 'Ban QLDA giao thông'})
    ..on('GET', '/reports/rep-2', (_) => reportRevision('rep-2', 2, secondRevision, supersedes: 'rep-1', amendment: 'Điều chỉnh số liệu vốn năm', attachments: <Object?>[attachment()]))
    ..on('GET', '/reports/rep-1', (_) => reportRevision('rep-1', 1, firstRevision));
}

Future<ScriptedServer> _open(WidgetTester tester, String location, {bool dark = false, double scale = 1.0, Size size = _phone, List<Map<String, Object?>>? tasks}) async {
  useDevice(tester, size, textScale: scale);
  final ScriptedServer server = ScriptedServer();
  _reads(server, tasks: tasks);
  await pumpWithServer(
    tester,
    features: <MobileFeature>[approval.feature],
    server: server,
    location: location,
    overrides: <Override>[if (dark) themeModeProvider.overrideWith(_Dark.new)],
  );
  return server;
}

Future<void> _sheet(WidgetTester tester) async {
  await tester.tap(find.widgetWithText(FilledButton, 'Phê duyệt'));
  await tester.pumpAndSettle();
}

void main() {
  useTolerantGoldens('test/golden/approval_golden_test.dart', tolerance: kTextGoldenTolerance);

  group('the inbox', () {
    testWidgets('light', (WidgetTester tester) async {
      await _open(tester, '/approval');
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/approval_inbox_light.png'));
    });

    testWidgets('dark', (WidgetTester tester) async {
      await _open(tester, '/approval', dark: true);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/approval_inbox_dark.png'));
    });

    testWidgets('text 200 percent', (WidgetTester tester) async {
      await _open(tester, '/approval', scale: 2.0);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/approval_inbox_text200.png'));
    });

    testWidgets('empty', (WidgetTester tester) async {
      await _open(tester, '/approval', tasks: <Map<String, Object?>>[]);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/approval_inbox_empty.png'));
    });

    testWidgets('offline, from the copy kept on the phone', (WidgetTester tester) async {
      final ScriptedServer server = await _open(tester, '/approval');
      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/approval_inbox_offline.png'));
    });
  });

  group('the detail', () {
    testWidgets('light', (WidgetTester tester) async {
      await _open(tester, '/approval/mob-24/t-1', size: const Size(390, 1500));
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/approval_detail_light.png'));
    });

    testWidgets('dark', (WidgetTester tester) async {
      await _open(tester, '/approval/mob-24/t-1', dark: true, size: const Size(390, 1500));
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/approval_detail_dark.png'));
    });

    testWidgets('text 200 percent', (WidgetTester tester) async {
      await _open(tester, '/approval/mob-24/t-1', scale: 2.0);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/approval_detail_text200.png'));
    });

    testWidgets('offline: the bar is locked and says why', (WidgetTester tester) async {
      final ScriptedServer server = await _open(tester, '/approval/mob-24/t-1');
      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/approval_detail_offline.png'));
    });
  });

  group('the confirmation sheet', () {
    testWidgets('light', (WidgetTester tester) async {
      await _open(tester, '/approval/mob-24/t-1');
      await _sheet(tester);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/approval_sheet_light.png'));
    });

    testWidgets('dark', (WidgetTester tester) async {
      await _open(tester, '/approval/mob-24/t-1', dark: true);
      await _sheet(tester);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/approval_sheet_dark.png'));
    });

    testWidgets('text 200 percent', (WidgetTester tester) async {
      await _open(tester, '/approval/mob-24/t-1', scale: 2.0, size: const Size(390, 1500));
      await _sheet(tester);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/approval_sheet_text200.png'));
    });
  });
}
