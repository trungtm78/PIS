import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/theme/theme_mode.dart';
import 'package:machvon_mobile/features/doc_incoming/doc_incoming_feature.dart' as incoming;

import '../features/doc_incoming/fixtures.dart';
import '../features/support/scripted_server.dart';
import '../support/harness.dart';
import '../support/v2_support.dart';

/// Golden images of the incoming letters (DOC-23) of MUX-3 wave B: the list in the light mode, the dark mode, at 200 percent text, empty and
/// offline (a letter is never kept as a copy, so a lost connection is the offline state with its action), a chip that matches nothing, and
/// one letter with its history. They are drawn with the test font; layout and touch targets are proved by the widget tests of the screen.

class _Dark extends ThemeModeNotifier {
  @override
  ThemeMode build() => ThemeMode.dark;
}

const Size _phone = Size(390, 844);

List<Map<String, Object?>> _letters() => <Map<String, Object?>>[
      letter(1, urgency: 'KHAN'),
      letter(2, overdueDays: 3, due: '2026-10-20'),
      letter(5, status: 'PROCESSING', due: '2026-10-30', act: actions(resolve: true)),
      letter(6, due: null),
    ];

Future<ScriptedServer> _open(WidgetTester tester, String location, {List<Map<String, Object?>>? letters, bool dark = false, double scale = 1.0, bool offline = false}) async {
  useDevice(tester, _phone, textScale: scale);
  final ScriptedServer server = ScriptedServer();
  answerLetters(server, letters ?? _letters());
  server.offline = offline;
  await pumpWithServer(
    tester,
    features: <MobileFeature>[incoming.feature],
    server: server,
    location: location,
    session: handlerSession(),
    overrides: <Override>[if (dark) themeModeProvider.overrideWith(_Dark.new)],
  );
  return server;
}

const String _list = '/approval/doc-23';
const String _detail = '/approval/doc-23?doc=in-1';

void main() {
  useOsGoldens('test/golden/incoming_golden_test.dart');

  group('MUX-3 wave B the incoming letters to handle (DOC-23)', () {
    testWidgets('list, light', (WidgetTester tester) async {
      await _open(tester, _list);
      expect(find.text('Tất cả 4'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/incoming_list_light.png'));
    });

    testWidgets('list, dark', (WidgetTester tester) async {
      await _open(tester, _list, dark: true);
      expect(Theme.of(tester.element(find.text('Tất cả 4'))).brightness, Brightness.dark);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/incoming_list_dark.png'));
    });

    testWidgets('list, text 200 percent', (WidgetTester tester) async {
      await _open(tester, _list, scale: 2.0);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/incoming_list_text200.png'));
    });

    testWidgets('list, empty', (WidgetTester tester) async {
      await _open(tester, _list, letters: <Map<String, Object?>>[]);
      expect(find.text('Chưa có dữ liệu'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/incoming_list_empty.png'));
    });

    testWidgets('list, offline: no copy of a letter is kept, the state offers to try again', (WidgetTester tester) async {
      await _open(tester, _list, offline: true);
      expect(find.text('Bạn đang ngoại tuyến'), findsWidgets);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/incoming_list_offline.png'));
    });

    testWidgets('list, a chip that matches nothing', (WidgetTester tester) async {
      await _open(tester, _list, letters: <Map<String, Object?>>[letter(1)]);
      await tester.tap(find.text('Quá hạn 0'));
      await tester.pumpAndSettle();
      expect(find.text('Không có văn bản phù hợp'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/incoming_list_nomatch.png'));
    });

    testWidgets('letter, light', (WidgetTester tester) async {
      await _open(tester, _detail, letters: <Map<String, Object?>>[
        letter(1, overdueDays: 2, assignments: <Object?>[
          <String, Object?>{
            'id': 'a-1',
            'assigned_unit': <String, Object?>{'id': 'u-1', 'name': 'Phòng Quản lý dự án'},
            'assignee': <String, Object?>{'user_id': kHandler, 'display_name': 'Lê Chuyên Viên'},
            'leader_directive': 'Chuẩn bị ý kiến.',
            'due_on': '2026-10-27',
            'assigned_at': '2026-10-21T02:00:00Z',
          },
        ]),
      ]);
      expect(find.text('Công văn số 1'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/incoming_detail_light.png'));
    });

    testWidgets('letter, dark', (WidgetTester tester) async {
      await _open(tester, _detail, letters: <Map<String, Object?>>[letter(1)], dark: true);
      expect(Theme.of(tester.element(find.text('Công văn số 1'))).brightness, Brightness.dark);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/incoming_detail_dark.png'));
    });

    testWidgets('letter, text 200 percent', (WidgetTester tester) async {
      await _open(tester, _detail, letters: <Map<String, Object?>>[letter(1)], scale: 2.0);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/incoming_detail_text200.png'));
    });
  });
}
