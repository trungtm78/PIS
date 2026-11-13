import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/features/ai_review/ai_review_feature.dart' as ai;

import '../../support/harness.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'fixtures.dart';

/// R39: what the model proposed about a bid is confidential, so nothing of it is kept on the phone. With no connection the findings are not
/// shown from a copy: the screen is the offline state with a retry, and the retry reads again. The question is not asked offline, and the reason
/// is said beside the disabled button.
Future<void> _open(WidgetTester tester, ScriptedServer server, String location) => pumpWithServer(tester, features: <MobileFeature>[ai.feature], server: server, location: location);

void main() {
  group('R39 the AI review offline', () {
    testWidgets('the findings are not shown from a copy: offline names the state with a retry, and the retry reads them again', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer()..offline = true;
      aiServer(server);
      await _open(tester, server, '/projects/mob-38?run=$kRun');

      expect(find.text('Bạn đang ngoại tuyến'), findsWidgets);
      expect(find.text('NETWORK_ERROR'), findsOneWidget);
      expect(find.text('Tiêu chí C-EXP-01'), findsNothing, reason: 'nothing of a confidential bid is kept as a copy');

      server.offline = false;
      await tester.tap(find.text('Thử lại'));
      await tester.pumpAndSettle();
      expect(find.text('Tiêu chí C-EXP-01'), findsOneWidget);
    });

    testWidgets('offline the ask button is off with its reason beside it, and nothing is queued', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server);
      await _open(tester, server, '/projects/mob-37?package=$kPackage');
      server.offline = true;
      await tester.enterText(find.byType(TextField), 'Câu hỏi');
      await tester.tap(find.widgetWithText(FilledButton, 'Hỏi'));
      await tester.pumpAndSettle();

      expect(find.textContaining('Cần có kết nối để hỏi'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Hỏi')).onPressed, isNull);
      expect(server.calls.where((HttpCall call) => call.method != 'GET'), isEmpty);
    });
  });
}
