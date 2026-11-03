import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/features/conversations/conversations_feature.dart' as conversations;
import 'package:machvon_mobile/features/dashboard/dashboard_feature.dart' as dashboard;
import 'package:machvon_mobile/features/notification_inbox/notification_inbox_feature.dart' as notifications;
import 'package:machvon_mobile/features/personal_bi/personal_bi_feature.dart' as personal_bi;

import '../../support/harness.dart';
import '../conversations/conversation_fixtures.dart';
import '../dashboard/dashboard_fixtures.dart';
import '../notification_inbox/notification_fixtures.dart';
import '../personal_bi/bi_fixtures.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';

Future<ProviderContainer> _open(WidgetTester tester, ScriptedServer server, List<MobileFeature> features, String location) =>
    pumpWithServer(tester, features: features, server: server, location: location);

void main() {
  group('TK-MOB-026-1 UI-MOB-35 the conversations are reached from the notification inbox', () {
    testWidgets('the inbox of notifications has a button for the conversations, and back returns to it', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = conversationServer();
      server.on('GET', '/me/notifications', (_) => notificationsPage(<Map<String, Object?>>[]));
      final ProviderContainer container = await _open(tester, server, <MobileFeature>[notifications.feature, conversations.feature], '/inbox');

      await tester.tap(find.byTooltip('Hội thoại gắn với hồ sơ'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/inbox/mob-35');
      expect(find.text('Nguyễn Văn An'), findsOneWidget);
      await pressBack(tester);
      expect(currentLocation(container), '/inbox');
    });
  });

  group('TK-MOB-027-1 UI-MOB-40 the dashboards are reached from the home of the leader', () {
    testWidgets('the command center links to the library of dashboards', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = biServer();
      server.on('GET', '/home/command-center', (_) => commandCenter());
      final ProviderContainer container = await _open(tester, server, <MobileFeature>[dashboard.feature, personal_bi.feature], '/home');

      await tester.tap(find.text('Dashboard BI của tôi'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/home/mob-40');
      expect(find.text('Giải ngân của tôi'), findsOneWidget);
    });
  });
}
