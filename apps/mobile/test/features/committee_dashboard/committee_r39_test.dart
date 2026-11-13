import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/features/committee_dashboard/committee_dashboard_feature.dart' as committee;
import 'package:machvon_mobile/features/dashboard/dashboard_feature.dart' as dashboard;

import '../../support/harness.dart';
import '../dashboard/committee_fixtures.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';

/// R39: the committee dashboard keeps no copy of the confidential workspace. With no connection it shows the offline state with a way to try
/// again (never old figures), the retry reads again once the connection is back, figures the server flags as stale are announced, and the screen
/// carries no command at any time.
Future<void> _open(WidgetTester tester, ScriptedServer server) =>
    pumpWithServer(tester, features: <MobileFeature>[dashboard.feature, committee.feature], server: server, location: '/home/mob-72');

void main() {
  group('R39 the committee dashboard offline and stale', () {
    testWidgets('offline there is no copy to read: the state names the code and offers a retry, and the retry reads the workspace again', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer()..offline = true;
      server.on('GET', '/committee/workspace', (_) => committeeWorkspace());
      await _open(tester, server);

      expect(find.text('Bạn đang ngoại tuyến'), findsWidgets);
      expect(find.text('NETWORK_ERROR'), findsOneWidget);
      expect(find.text('Giao thông'), findsNothing);
      expect(find.text('Số liệu đến ngày 31/10/2026, năm 2026'), findsNothing, reason: 'no figure of a copy is shown');

      server.offline = false;
      await tester.tap(find.text('Thử lại'));
      await tester.pumpAndSettle();
      expect(find.text('Số liệu đến ngày 31/10/2026, năm 2026'), findsOneWidget);
      expect(find.byType(FilledButton), findsNothing, reason: 'the dashboard only reads');
    });

    testWidgets('figures the server flags as stale are announced above the figures', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      server.on('GET', '/committee/workspace', (_) => committeeWorkspace(asOf: '2026-10-10', figures: committeeFigures(flags: <String>['STALE'])));
      await _open(tester, server);

      expect(find.text('Số liệu đã cũ, có thể không còn phản ánh tình hình hiện tại.'), findsOneWidget);
      expect(find.byType(FilledButton), findsNothing);
      expect(find.byType(OutlinedButton), findsNothing);
    });
  });
}
