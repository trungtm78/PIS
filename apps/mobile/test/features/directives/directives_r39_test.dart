import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/widgets/deadline.dart';
import 'package:machvon_mobile/features/directives/directive_models.dart';
import 'package:machvon_mobile/features/directives/directives_feature.dart' as directives;
import 'package:machvon_mobile/features/directives/labels.dart';

import '../../support/harness.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'directive_fixtures.dart';

/// R39: the directives on a copy kept on the phone. The list says it is a copy, with the moment it describes and, past the hours a copy is trusted,
/// that it is out of date; whatever the state of the copy the screen carries no command (the directive is noted, extended and closed on the
/// computer), and what a row says about its clock is the server's band, never the clock of the phone.
Future<ProviderContainer> _open(WidgetTester tester, ScriptedServer server, {DateTime Function()? now}) =>
    pumpWithServer(tester, features: <MobileFeature>[directives.feature], server: server, location: '/projects/dir-06', now: now);

ScriptedServer _server() {
  final ScriptedServer server = ScriptedServer();
  server
    ..on('GET', '/directives', (_) => directivePage(threeDirectives))
    ..on('GET', '/directives/summary', (_) => directiveSummary());
  return server;
}

void main() {
  group('R39 a copy of the directives', () {
    testWidgets('a fresh copy is labelled as saved and is read only: no button decides, extends or closes', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      DateTime now = kNow;
      final ScriptedServer server = _server();
      await _open(tester, server, now: () => now);

      server.offline = true;
      now = kNow.add(const Duration(hours: 1));
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();

      expect(find.textContaining('Đang hiển thị dữ liệu đã lưu trên máy'), findsOneWidget);
      expect(find.textContaining('Bản lưu đã quá'), findsNothing, reason: 'one hour old is not out of date');
      expect(find.byType(FilledButton), findsNothing);
      expect(find.byType(OutlinedButton), findsNothing);
      expect(find.text('GB-2026-014/CD-01'), findsOneWidget, reason: 'the copy is still read');
    });

    testWidgets('a copy older than the hours it is trusted says it is out of date and asks for a connection', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      DateTime now = kNow;
      final ScriptedServer server = _server();
      await _open(tester, server, now: () => now);

      server.offline = true;
      now = kNow.add(const Duration(days: 2));
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();

      expect(find.textContaining('Bản lưu đã quá 12 giờ'), findsOneWidget);
      expect(find.byType(FilledButton), findsNothing);
    });

    testWidgets('every phase of the server has its band and a shape: past and today are late, the reminder days soon, later ok, ended done', (WidgetTester tester) async {
      expect(directiveBandOf(DirectivePhase.overdue), DeadlineBand.late);
      expect(directiveBandOf(DirectivePhase.escalated), DeadlineBand.late);
      expect(directiveBandOf(DirectivePhase.dueToday), DeadlineBand.late);
      expect(directiveBandOf(DirectivePhase.dueSoon), DeadlineBand.soon);
      expect(directiveBandOf(DirectivePhase.dueLater), DeadlineBand.ok);
      expect(directiveBandOf(DirectivePhase.ended), DeadlineBand.done);
    });

    testWidgets('each row carries the glyph of its band and its clock in words', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      await _open(tester, _server());

      expect(find.byType(DeadlineGlyph), findsNWidgets(3));
      expect(find.byType(DeadlineLabel), findsWidgets);
      expect(find.text('Quá hạn 10 ngày, đã báo lãnh đạo đơn vị'), findsOneWidget);
    });
  });
}
