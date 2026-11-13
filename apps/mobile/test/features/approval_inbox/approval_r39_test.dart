import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/sync/sync_status.dart';
import 'package:machvon_mobile/features/approval_inbox/approval_inbox_feature.dart' as approval;

import '../../support/harness.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'approval_fixtures.dart';

/// R39 of the approvals: the flows around the widgets, not the widgets. An approval made on a copy or offline is refused by the screen
/// itself, a task that moved while the sheet was open is read again and decided under its new version, and nothing is ever queued.

Future<ProviderContainer> _open(WidgetTester tester, ScriptedServer server, String location) =>
    pumpWithServer(tester, features: <MobileFeature>[approval.feature], server: server, location: location);

void _reads(ScriptedServer server, Map<String, Object?> Function() task) {
  server
    ..on('GET', '/resources/approval_task', (_) => page(<Object?>[task()]))
    ..on('GET', '/resources/organization_unit', (_) => unitsPage())
    ..on('GET', '/resources/approval_task/t-1', (_) => task())
    ..on('GET', '/resources/organization_unit/u-bql1', (_) => <String, Object?>{'id': 'u-bql1', 'name': 'Ban QLDA giao thông'})
    ..on('GET', '/reports/rep-2', (_) => reportRevision('rep-2', 2, secondRevision, supersedes: 'rep-1'))
    ..on('GET', '/reports/rep-1', (_) => reportRevision('rep-1', 1, firstRevision));
}

const String _offlineText = 'Cần kết nối mạng để quyết định. Phê duyệt không bao giờ được xếp hàng đợi hay gửi từ bản lưu trên máy.';

void main() {
  group('R39 approval: a task that moved while the sheet was open', () {
    testWidgets('a version conflict leaves the sheet readable, "open the record again" reads the task, and the next decision goes out under the new version and a new key', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      int version = 4;
      _reads(server, () => approvalTask('t-1', version: version));
      int attempt = 0;
      server.answer('POST', '/approval-tasks/t-1/decision', (HttpCall call) {
        attempt += 1;
        return attempt == 1 ? problem(409, 'VERSION_CONFLICT') : decided();
      });
      await _open(tester, server, '/approval/mob-24/t-1');

      await tester.tap(find.widgetWithText(FilledButton, 'Phê duyệt'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'Đồng ý');
      await tester.tap(find.widgetWithText(FilledButton, 'Xác nhận phê duyệt'));
      await tester.pumpAndSettle();
      expect(find.text('Việc này vừa thay đổi. Hãy mở lại để xem tình trạng hiện tại rồi quyết định.'), findsOneWidget);
      expect(find.text('Đồng ý'), findsOneWidget, reason: 'what the person wrote is still there');
      expect(find.text('Đã ghi nhận quyết định'), findsNothing);

      version = 5;
      await tester.tap(find.widgetWithText(OutlinedButton, 'Mở lại hồ sơ'));
      await tester.pumpAndSettle();
      expect(find.text('Xác nhận phê duyệt'), findsNothing, reason: 'the sheet closed over the record it had left');

      await tester.tap(find.widgetWithText(FilledButton, 'Phê duyệt'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Xác nhận phê duyệt'));
      await tester.pumpAndSettle();
      final List<HttpCall> calls = server.callsTo('POST', '/approval-tasks/t-1/decision');
      expect(calls, hasLength(2));
      expect(calls[0].headers['if-match'], '"4"');
      expect(calls[1].headers['if-match'], '"5"', reason: 'the new decision is judged on the task as it is now');
      expect(calls[1].headers['idempotency-key'], isNot(calls[0].headers['idempotency-key']));
      expect(find.text('Đã ghi nhận quyết định'), findsOneWidget);
    });

    testWidgets('a task decided by someone else while the sheet was open is refused with its words and offers no reopening', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server, () => approvalTask('t-1'));
      server.answer('POST', '/approval-tasks/t-1/decision', (HttpCall call) => problem(409, 'TASK_ALREADY_DECIDED'));
      await _open(tester, server, '/approval/mob-24/t-1');

      await tester.tap(find.widgetWithText(FilledButton, 'Phê duyệt'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Xác nhận phê duyệt'));
      await tester.pumpAndSettle();
      expect(find.text('Việc này đã có quyết định.'), findsOneWidget);
      expect(find.text('TASK_ALREADY_DECIDED'), findsOneWidget);
      expect(find.widgetWithText(OutlinedButton, 'Mở lại hồ sơ'), findsNothing, reason: 'reopening is offered for a conflict of version only');
    });
  });

  group('R39 approval: an offline or stale approval', () {
    testWidgets('the detail read from a copy locks both decisions with the reason and sends nothing', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server, () => approvalTask('t-1'));
      final ProviderContainer container = await _open(tester, server, '/approval/mob-24/t-1');
      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();
      container.read(reachabilityProvider.notifier).report(Reachability.online);
      await tester.pumpAndSettle();

      expect(find.textContaining('Đang hiển thị dữ liệu đã lưu trên máy'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Phê duyệt')).onPressed, isNull);
      expect(tester.widget<OutlinedButton>(find.widgetWithText(OutlinedButton, 'Trả lại để bổ sung')).onPressed, isNull);
      expect(find.text(_offlineText), findsOneWidget);
      expect(container.read(syncStatusProvider).pendingCommands, 0);
      expect(server.calls.where((HttpCall call) => call.method == 'POST'), isEmpty);
    });

    testWidgets('a sheet that was open when the connection dropped locks its button with the reason; nothing is sent or queued', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server, () => approvalTask('t-1'));
      final ProviderContainer container = await _open(tester, server, '/approval/mob-24/t-1');
      await tester.tap(find.widgetWithText(FilledButton, 'Phê duyệt'));
      await tester.pumpAndSettle();
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Xác nhận phê duyệt')).onPressed, isNotNull);

      container.read(reachabilityProvider.notifier).report(Reachability.offline);
      await tester.pumpAndSettle();
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Xác nhận phê duyệt')).onPressed, isNull);
      expect(find.text(_offlineText), findsWidgets);
      expect(container.read(syncStatusProvider).pendingCommands, 0);
      expect(server.callsTo('POST', '/approval-tasks/t-1/decision'), isEmpty);
    });
  });
}
