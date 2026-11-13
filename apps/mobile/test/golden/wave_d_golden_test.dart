import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/theme/theme_mode.dart';
import 'package:machvon_mobile/features/conversations/conversation_rules.dart';
import 'package:machvon_mobile/features/conversations/conversations_feature.dart' as conversations;
import 'package:machvon_mobile/features/personal_bi/bi_query_service.dart';
import 'package:machvon_mobile/features/personal_bi/personal_bi_feature.dart' as personal_bi;
import 'package:machvon_mobile/features/phone_search/phone_search_feature.dart' as phone_search;
import 'package:machvon_mobile/features/release/app_info.dart';
import 'package:machvon_mobile/features/release/release_feature.dart' as release;

import '../features/conversations/conversation_fixtures.dart';
import '../features/personal_bi/bi_fixtures.dart';
import '../features/support/scripted_server.dart';
import '../support/harness.dart';
import '../support/v2_support.dart';

/// Golden images of the screens of MUX-3 wave D that are not first-impression screens: the search (the recent keywords, the results), the
/// conversations (the inbox and a thread), the library of dashboards and the help screen, each in the light mode and the dark mode, and the
/// ones with the most text also at 200 percent. The texts are drawn with the test font, which Windows and
/// Linux rasterise differently, so each OS compares with goldens of its own (useOsGoldens); layout and touch targets are proved by the widget tests of the screens.

class _Dark extends ThemeModeNotifier {
  @override
  ThemeMode build() => ThemeMode.dark;
}

class _Info implements AppInfoSource {
  @override
  Future<AppInfo> read() async => const AppInfo(version: '1.4.0', build: '27', platform: 'android', osVersion: '14');
}

const Size _phone = Size(390, 844);

Map<String, Object?> _hit(String type, String id, {String? title, String classification = 'INTERNAL', String? snippet}) =>
    <String, Object?>{'entity_type': type, 'entity_id': id, 'title': title, 'classification': classification, 'snippet': snippet};

Future<void> _open(
  WidgetTester tester,
  ScriptedServer server,
  List<MobileFeature> features,
  String location, {
  bool dark = false,
  double scale = 1.0,
  List<Override> overrides = const <Override>[],
}) async {
  useDevice(tester, _phone, textScale: scale);
  await pumpWithServer(
    tester,
    features: features,
    server: server,
    location: location,
    overrides: <Override>[if (dark) themeModeProvider.overrideWith(_Dark.new), ...overrides],
  );
}

ScriptedServer _search() {
  final ScriptedServer server = ScriptedServer();
  server.on(
    'GET',
    '/search',
    (_) => <String, Object?>{
      'items': <Object?>[
        _hit('project', 'a1000000-0000-4000-8000-000000000001', title: 'Cầu Bình An', snippet: 'Gói thầu xây lắp cầu'),
        _hit('conversation', 'a4000000-0000-4000-8000-000000000004', title: 'Hội thoại với hộ dân', classification: 'CONFIDENTIAL'),
        _hit('issue', 'a3000000-0000-4000-8000-000000000003', title: 'Vướng mắc mặt bằng'),
      ],
      'next_cursor': null,
    },
  );
  return server;
}

void main() {
  useOsGoldens('test/golden/wave_d_golden_test.dart');

  final List<MobileFeature> searchFeatures = <MobileFeature>[phone_search.feature];

  group('MUX-3 wave D the search (MOB-51)', () {
    testWidgets('empty: the invitation to type, light', (WidgetTester tester) async {
      await _open(tester, _search(), searchFeatures, '/account/mob-51');
      expect(find.text('Nhập từ khóa để bắt đầu tìm.'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/search_empty_light.png'));
    });

    testWidgets('results, light', (WidgetTester tester) async {
      await _open(tester, _search(), searchFeatures, '/account/mob-51?q=c%E1%BA%A7u');
      expect(find.text('Cầu Bình An'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/search_results_light.png'));
    });

    testWidgets('results, dark', (WidgetTester tester) async {
      await _open(tester, _search(), searchFeatures, '/account/mob-51?q=c%E1%BA%A7u', dark: true);
      expect(Theme.of(tester.element(find.text('Cầu Bình An'))).brightness, Brightness.dark);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/search_results_dark.png'));
    });

    testWidgets('results, text 200 percent', (WidgetTester tester) async {
      await _open(tester, _search(), searchFeatures, '/account/mob-51?q=c%E1%BA%A7u', scale: 2.0);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/search_results_text200.png'));
    });
  });

  group('MUX-3 wave D the conversations (MOB-35, MOB-36)', () {
    final List<MobileFeature> features = <MobileFeature>[conversations.feature, recordsFeature];
    final List<Override> gate = <Override>[externalReplyEnabledProvider.overrideWithValue(true)];

    testWidgets('inbox, light', (WidgetTester tester) async {
      await _open(tester, conversationServer(), features, '/inbox/mob-35', overrides: gate);
      expect(find.text('Nguyễn Văn An'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/conversations_inbox_light.png'));
    });

    testWidgets('inbox, dark', (WidgetTester tester) async {
      await _open(tester, conversationServer(), features, '/inbox/mob-35', dark: true, overrides: gate);
      expect(Theme.of(tester.element(find.text('Nguyễn Văn An'))).brightness, Brightness.dark);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/conversations_inbox_dark.png'));
    });

    testWidgets('inbox, text 200 percent', (WidgetTester tester) async {
      await _open(tester, conversationServer(), features, '/inbox/mob-35', scale: 2.0, overrides: gate);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/conversations_inbox_text200.png'));
    });

    testWidgets('thread, light and dark', (WidgetTester tester) async {
      await _open(tester, conversationServer(), features, '/inbox/mob-36/$idZalo', overrides: gate);
      expect(find.text('Nguyễn Văn An'), findsWidgets);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/conversations_thread_light.png'));
    });

    testWidgets('thread, dark', (WidgetTester tester) async {
      await _open(tester, conversationServer(), features, '/inbox/mob-36/$idZalo', dark: true, overrides: gate);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/conversations_thread_dark.png'));
    });
  });

  group('MUX-3 wave D the library of dashboards (MOB-40) and the help screen (MOB-50)', () {
    final Override instantJobs = jobPollingProvider.overrideWithValue(JobPolling(interval: Duration.zero, attempts: 3, waitBetweenPolls: (Duration d) async {}));

    testWidgets('library, light', (WidgetTester tester) async {
      await _open(tester, biServer(), <MobileFeature>[personal_bi.feature], '/home/mob-40', overrides: <Override>[instantJobs]);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/bi_library_light.png'));
    });

    testWidgets('library, dark', (WidgetTester tester) async {
      await _open(tester, biServer(), <MobileFeature>[personal_bi.feature], '/home/mob-40', dark: true, overrides: <Override>[instantJobs]);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/bi_library_dark.png'));
    });

    testWidgets('a dashboard with its tiles, light', (WidgetTester tester) async {
      await _open(tester, biServer(), <MobileFeature>[personal_bi.feature], '/home/mob-40?dashboard=$dashD1', overrides: <Override>[instantJobs]);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/bi_dashboard_light.png'));
    });

    testWidgets('a dashboard with its tiles, dark', (WidgetTester tester) async {
      await _open(tester, biServer(), <MobileFeature>[personal_bi.feature], '/home/mob-40?dashboard=$dashD1', dark: true, overrides: <Override>[instantJobs]);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/bi_dashboard_dark.png'));
    });

    testWidgets('help, light', (WidgetTester tester) async {
      await _open(tester, ScriptedServer(), <MobileFeature>[release.feature], '/account/mob-50', overrides: <Override>[appInfoSourceProvider.overrideWithValue(_Info())]);
      expect(find.text('Trợ giúp và phản hồi'), findsWidgets);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/help_light.png'));
    });

    testWidgets('help, dark', (WidgetTester tester) async {
      await _open(tester, ScriptedServer(), <MobileFeature>[release.feature], '/account/mob-50', dark: true, overrides: <Override>[appInfoSourceProvider.overrideWithValue(_Info())]);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/help_dark.png'));
    });
  });
}
