import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/widgets/action_bar.dart';
import 'package:machvon_mobile/core/widgets/notice_panel.dart';
import 'package:machvon_mobile/core/widgets/state_view.dart';
import 'package:machvon_mobile/core/widgets/work_row.dart';

import '../../support/harness.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'clearance_rig.dart';
import 'fixtures.dart';

/// The redesigned states of MOB-68 (MUX-3 wave C): the lists as grouped rows with an action in their empty state, the consent that gates a
/// confirmation said inline, and the bar at the foot that is the one action of the moment.
void main() {
  group('MOB-68 the lists', () {
    testWidgets('with no project in the scope the empty state offers to read again, and reading again asks the server again', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      answerClearance(server, projects: <Object?>[]);
      await openClearance(tester, server, kClearanceProjects);
      expect(find.byType(StateView), findsOneWidget);
      expect(find.text('Chưa có dữ liệu'), findsOneWidget);
      expect(server.callsTo('GET', '/resources/project'), hasLength(1));

      answerClearance(server);
      await tester.tap(find.widgetWithText(FilledButton, 'Thử lại'));
      await tester.pumpAndSettle();
      expect(server.callsTo('GET', '/resources/project'), hasLength(2));
      expect(find.text('DA-001'), findsOneWidget, reason: 'the list comes back as rows');
      expect(find.byType(WorkRow), findsOneWidget);
    });

    testWidgets('the households are rows grouped by where their work stands, each group with its count, and the household still has no name on the screen', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      answerClearance(server, households: <Object?>[
        household('h-1', status: 'REGISTERED'),
        household('h-2', code: 'HH-A-002', status: 'INVENTORIED', parcels: <Map<String, Object?>>[parcel('pa-2', 'TH-002')]),
        household('h-3', code: 'HH-A-003', status: 'REGISTERED', parcels: <Map<String, Object?>>[parcel('pa-3', 'TH-003')]),
      ]);
      await openClearance(tester, server, kClearanceHouseholds);
      expect(find.byType(GroupHeader), findsNWidgets(2));
      expect(find.text('Mới đăng ký'), findsOneWidget);
      expect(find.text('Đã kiểm đếm'), findsOneWidget);
      expect(find.byType(WorkRow), findsNWidgets(3));
      expect(find.text('Hộ HH-A-003'), findsOneWidget);
      expect(find.textContaining('Nguyễn'), findsNothing);
    });

    testWidgets('a household with no household in the register is the empty state with the action to read again', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      answerClearance(server, households: <Object?>[]);
      await openClearance(tester, server, kClearanceHouseholds);
      expect(find.text('Chưa có dữ liệu'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Thử lại'), findsOneWidget);
    });
  });

  group('MOB-68 the task of a household', () {
    testWidgets('the bar at the foot keeps or sends the count being typed, and is gone for a household that may not be worked on', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      answerClearance(server);
      await openClearance(tester, server, kClearanceTask);
      expect(find.byType(ActionBar), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Lưu và gửi'), findsOneWidget);
      expect(find.widgetWithText(OutlinedButton, 'Lưu trên máy'), findsOneWidget);
      expect(tester.getTopLeft(find.byType(ActionBar)).dy, greaterThan(tester.getBottomLeft(find.text('Lịch hẹn với hộ')).dy), reason: 'the bar sits at the foot of the screen, under the last block of the form');

      answerClearance(server, households: <Object?>[household('h-1', restricted: true)]);
      await openClearance(tester, server, kClearanceTask);
      expect(find.byType(ActionBar), findsNothing);
      expect(find.byType(NoticePanel), findsWidgets, reason: 'what stops the work is a notice');
    });

    testWidgets('while an answer of the household is open the bar records it and can be closed, and the count comes back with it', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      answerClearance(server);
      await openClearance(tester, server, kClearanceTask);
      await tester.tap(find.widgetWithText(OutlinedButton, 'Ghi ý kiến của hộ'));
      await tester.pumpAndSettle();
      expect(find.widgetWithText(FilledButton, 'Ghi nhận trả lời của hộ'), findsOneWidget);
      expect(find.widgetWithText(OutlinedButton, 'Đóng'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Lưu và gửi'), findsNothing, reason: 'one action at a time in the bar');

      await tester.tap(find.widgetWithText(OutlinedButton, 'Đóng'));
      await tester.pumpAndSettle();
      expect(find.widgetWithText(FilledButton, 'Lưu và gửi'), findsOneWidget);
      expect(find.widgetWithText(OutlinedButton, 'Ghi ý kiến của hộ'), findsOneWidget);
    });

    testWidgets('a household whose basis is its consent, with none on file, is told before the confirmation that the server will not take it; a dispute is not', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      answerClearance(server, households: <Object?>[household('h-1', basis: 'CONSENT')]);
      await openClearance(tester, server, kClearanceTask);
      await tester.tap(find.widgetWithText(OutlinedButton, 'Ghi ý kiến của hộ'));
      await tester.pumpAndSettle();
      const String warning = 'Hộ chưa có biên bản đồng ý được ghi nhận. Máy chủ chưa nhận xác nhận kiểm đếm cho đến khi có biên bản.';
      expect(find.text(warning), findsNothing, reason: 'nothing is said before an outcome is chosen');

      Future<void> choose(String label) async {
        await tester.tap(find.widgetWithText(DropdownButtonFormField<String>, 'Hộ trả lời'));
        await tester.pumpAndSettle();
        await tester.tap(find.text(label).last);
        await tester.pumpAndSettle();
      }

      await choose('Hộ xác nhận kết quả kiểm đếm');
      expect(find.text(warning), findsOneWidget);
      await choose('Hộ phản đối kết quả kiểm đếm');
      expect(find.text(warning), findsNothing);
    });

    testWidgets('with a consent on file there is nothing to warn about', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      answerClearance(server, households: <Object?>[household('h-1', basis: 'CONSENT', consent: 'cr-1')]);
      await openClearance(tester, server, kClearanceTask);
      await tester.tap(find.widgetWithText(OutlinedButton, 'Ghi ý kiến của hộ'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(DropdownButtonFormField<String>, 'Hộ trả lời'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Hộ xác nhận kết quả kiểm đếm').last);
      await tester.pumpAndSettle();
      expect(find.textContaining('Hộ chưa có biên bản đồng ý được ghi nhận'), findsNothing);
    });

    testWidgets('the count form is one column with the quantity and its unit side by side, and stacks them at 200 percent text', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      answerClearance(server);
      await openClearance(tester, server, kClearanceTask);
      final Offset quantity = tester.getTopLeft(find.widgetWithText(TextField, 'Số lượng'));
      final Offset unit = tester.getTopLeft(find.widgetWithText(TextField, 'Đơn vị tính'));
      expect(unit.dy, quantity.dy, reason: 'side by side');

      useDevice(tester, const Size(360, 5200), textScale: 2.0);
      await openClearance(tester, server, kClearanceTask);
      expect(tester.takeException(), isNull);
      final Offset quantityBig = tester.getTopLeft(find.widgetWithText(TextField, 'Số lượng'));
      final Offset unitBig = tester.getTopLeft(find.widgetWithText(TextField, 'Đơn vị tính'));
      expect(unitBig.dy, greaterThan(quantityBig.dy), reason: 'one under the other');
    });
  });
}
