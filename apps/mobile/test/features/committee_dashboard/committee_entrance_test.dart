import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/features/committee_dashboard/committee_dashboard_feature.dart' as committee;
import 'package:machvon_mobile/features/dashboard/dashboard_feature.dart' as dashboard;

import '../../support/harness.dart';
import '../dashboard/committee_fixtures.dart';
import '../dashboard/dashboard_fixtures.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';

/// The ways into MOB-72: the card on the leader home, and the alert of the committee (the table of targets is tested with the alert sources).

void main() {
  testWidgets('the card on the leader home opens the full dashboard, which reads the workspace again for its own view', (WidgetTester tester) async {
    useDevice(tester, kTallDevice);
    final ScriptedServer server = ScriptedServer()
      ..on('GET', '/home/command-center', (_) => commandCenter())
      ..on('GET', '/home/my-work', (_) => myWork(<Map<String, Object?>>[]))
      ..on('GET', '/committee/workspace', (_) => committeeWorkspace());
    await pumpWithServer(tester, features: <MobileFeature>[dashboard.feature, committee.feature], server: server, location: '/home');

    expect(server.callsTo('GET', '/committee/workspace'), hasLength(1), reason: 'the card reads once');
    final Finder open = find.text('Mở bảng điều hành đầy đủ: theo ngành, huyện, chủ đầu tư, nguồn vốn');
    await tester.ensureVisible(open);
    await tester.tap(open);
    await tester.pumpAndSettle();

    expect(find.textContaining('Chỉ đọc. Mỗi lần mở bảng này'), findsOneWidget);
    expect(server.callsTo('GET', '/committee/workspace'), hasLength(2), reason: 'the dashboard is its own view and its own audit row');
  });

  testWidgets('a feed with nothing loaded has no way into the full dashboard', (WidgetTester tester) async {
    useDevice(tester, kTallDevice);
    final ScriptedServer server = ScriptedServer()
      ..on('GET', '/home/command-center', (_) => commandCenter())
      ..on('GET', '/home/my-work', (_) => myWork(<Map<String, Object?>>[]))
      ..on('GET', '/committee/workspace', (_) => committeeWorkspace(empty: true));
    await pumpWithServer(tester, features: <MobileFeature>[dashboard.feature, committee.feature], server: server, location: '/home');

    expect(find.text('Mở bảng điều hành đầy đủ: theo ngành, huyện, chủ đầu tư, nguồn vốn'), findsNothing);
  });
}
