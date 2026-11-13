import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/navigation/route_catalogue.dart';
import 'package:machvon_mobile/core/navigation/tab_badges.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/core/sync/sync_status.dart';
import 'package:machvon_mobile/features/approval_inbox/approval_commands.dart';
import 'package:machvon_mobile/features/approval_inbox/approval_inbox_feature.dart' as approval;
import 'package:machvon_mobile/features/approval_inbox/approval_support.dart' show approvalsChangedProvider;
import 'package:machvon_mobile/features/approval_inbox/screens/approval_inbox_screen.dart' show ApprovalRow;

import '../../support/harness.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'approval_fixtures.dart';

Future<ProviderContainer> _open(WidgetTester tester, ScriptedServer server, String location, {FakeSession? session, Locale locale = const Locale('vi')}) =>
    pumpWithServer(tester, features: <MobileFeature>[approval.feature], server: server, location: location, session: session, locale: locale);

/// The reads of the approvals: the inbox, the task, its report and the revision before it.
void _reads(ScriptedServer server, {Map<String, Object?>? task, List<Map<String, Object?>>? tasks}) {
  final Map<String, Object?> one = task ?? approvalTask('t-1');
  server
    ..on('GET', '/resources/approval_task', (_) => page(tasks ?? <Object?>[one]))
    ..on('GET', '/resources/organization_unit', (_) => unitsPage())
    ..on('GET', '/resources/approval_task/t-1', (_) => one)
    ..on('GET', '/resources/organization_unit/u-bql1', (_) => <String, Object?>{'id': 'u-bql1', 'name': 'Ban QLDA giao thông'})
    ..on('GET', '/reports/rep-2', (_) => reportRevision('rep-2', 2, secondRevision, supersedes: 'rep-1', amendment: 'Điều chỉnh số liệu vốn năm', attachments: <Object?>[attachment()]))
    ..on('GET', '/reports/rep-1', (_) => reportRevision('rep-1', 1, firstRevision));
}

/// Answers the decisions in order; the function it returns lists the calls made so far.
List<HttpCall> Function() _decisions(ScriptedServer server, List<HttpResult Function()> answers) {
  int next = 0;
  server.answer('POST', '/approval-tasks/t-1/decision', (HttpCall call) {
    if (next >= answers.length) throw StateError('no more decisions expected');
    return answers[next++]();
  });
  return () => server.callsTo('POST', '/approval-tasks/t-1/decision');
}

void main() {
  group('UI-MOB-23 AC-ST-MOB-013-5 MOB-23 the approval inbox', () {
    testWidgets('lists the tasks waiting for the person, the late ones first, with the unit and the amount; the badge counts them', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server, tasks: <Map<String, Object?>>[
        // Its deadline is EARLIER than the late one's, so only the server's `overdue` flag can put the late one first.
        approvalTask('t-2', due: '2026-10-30T10:00:00Z', businessType: 'payment.approve', step: 'Kế toán trưởng'),
        approvalTask('t-1', due: '2026-11-01T10:00:00Z', overdue: true),
        approvalTask('t-3', status: 'Decided'),
        approvalTask('t-4', canDecide: false, businessType: 'contract.change', step: 'Xem để biết'),
      ]);
      final ProviderContainer container = await _open(tester, server, '/approval');

      expect(find.text('3 việc chờ quyết định, 1 quá hạn'), findsOneWidget);
      final double late = tester.getTopLeft(find.text('Nhận báo cáo')).dy;
      final double payment = tester.getTopLeft(find.text('Duyệt thanh toán')).dy;
      expect(late, lessThan(payment), reason: 'the late one comes first');
      expect(find.text('Quá hạn'), findsOneWidget);
      expect(find.text('Chỉ xem'), findsOneWidget);
      expect(find.textContaining('420 triệu đồng'), findsNWidgets(3), reason: 'the amount is on the row, rounded to one decimal');
      expect(find.textContaining('Ban QLDA giao thông'), findsNWidgets(3));
      expect(find.text('Hạn 01/11'), findsOneWidget, reason: 'the late row says its real day');
      final SemanticsHandle semantics = tester.ensureSemantics();
      expect(find.bySemanticsLabel(RegExp('Hạn 01/11/2026 17:00')), findsOneWidget, reason: 'a screen reader gets the moment in full');
      semantics.dispose();
      expect(container.read(tabBadgeProvider)[AppTab.approval], 3);
      expect(server.callsTo('GET', '/resources/approval_task').single.url.queryParameters, containsPair('mine', 'true'));
    });

    testWidgets('the inbox is the way in to the acceptance of works (MOB-65), the signing of documents and the incoming letters', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      final ProviderContainer container = await _open(tester, server, '/approval');

      await tester.tap(find.byTooltip('Duyệt nghiệm thu'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/approval/mob-65');
    });

    testWidgets('the badge goes to zero when the last task is decided and the inbox reads empty', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      final List<Map<String, Object?>> waiting = <Map<String, Object?>>[approvalTask('t-1')];
      _reads(server, tasks: waiting);
      final ProviderContainer container = await _open(tester, server, '/approval');
      expect(container.read(tabBadgeProvider)[AppTab.approval], 1);

      waiting.clear();
      container.read(approvalsChangedProvider.notifier).bump();
      await tester.pumpAndSettle();

      expect(find.text('Chưa có dữ liệu'), findsOneWidget, reason: 'the inbox is empty');
      expect(container.read(tabBadgeProvider)[AppTab.approval], 0, reason: 'the tab no longer announces a task that was decided');
    });

    testWidgets('an inbox that is empty from the start sets the badge to zero too', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server, tasks: <Map<String, Object?>>[]);
      final ProviderContainer container = await _open(tester, server, '/approval');

      expect(container.read(tabBadgeProvider)[AppTab.approval], 0);
    });

    testWidgets('there is no swipe and no button that approves from the list, and opening a row sends no decision', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      final ProviderContainer container = await _open(tester, server, '/approval');

      expect(find.byType(Dismissible), findsNothing);
      expect(find.widgetWithText(FilledButton, 'Phê duyệt'), findsNothing);
      await tester.drag(find.text('Nhận báo cáo'), const Offset(-300, 0));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Nhận báo cáo'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/approval/mob-24/t-1');
      expect(server.callsTo('POST', '/approval-tasks/t-1/decision'), isEmpty);
      expect(server.calls.where((HttpCall call) => call.method != 'GET'), isEmpty);
    });

    testWidgets('chips narrow the list to the late ones or to a kind of record, an empty result names the filter, and clearing it brings the list back', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server, tasks: <Map<String, Object?>>[approvalTask('t-1', overdue: true), approvalTask('t-2', businessType: 'payment.approve')]);
      await _open(tester, server, '/approval');
      expect(find.text('Quá hạn quyết định'), findsOneWidget, reason: 'the late ones are a group of their own');
      expect(find.text('Chờ quyết định'), findsOneWidget);

      await tester.tap(find.text('Quá hạn 1'));
      await tester.pumpAndSettle();
      expect(find.byType(ApprovalRow), findsOneWidget);
      expect(find.descendant(of: find.byType(ApprovalRow), matching: find.text('Nhận báo cáo')), findsOneWidget);

      await tester.tap(find.text('Tất cả 2'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Duyệt thanh toán 1'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Duyệt thanh toán 1'));
      await tester.pumpAndSettle();
      expect(find.byType(ApprovalRow), findsOneWidget);
      expect(find.descendant(of: find.byType(ApprovalRow), matching: find.text('Duyệt thanh toán')), findsOneWidget);
    });

    testWidgets('a filter with no result says which filter it is and has an action that clears it', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      final List<Map<String, Object?>> waiting = <Map<String, Object?>>[approvalTask('t-1', overdue: true), approvalTask('t-2', businessType: 'payment.approve')];
      _reads(server, tasks: waiting);
      final ProviderContainer container = await _open(tester, server, '/approval');
      // Only a late report is waiting: a kind of record that has none is not offered as a chip, so the empty result comes from the late chip
      // on a list whose late tasks were all decided meanwhile. Here the list is read again without them.
      await tester.tap(find.text('Quá hạn 1'));
      await tester.pumpAndSettle();
      waiting.removeAt(0);
      container.read(approvalsChangedProvider.notifier).bump();
      await tester.pumpAndSettle();
      expect(find.text('Không có hồ sơ khớp bộ lọc'), findsOneWidget);
      expect(find.textContaining('Đang lọc theo: Quá hạn'), findsOneWidget);
      await tester.tap(find.text('Xóa bộ lọc'));
      await tester.pumpAndSettle();
      expect(find.text('Duyệt thanh toán'), findsWidgets);
    });

    testWidgets('every state is drawn and the contract of the screen holds', (WidgetTester tester) async {
      await expectEveryState(
        tester,
        open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/approval'),
        script: StateScript(healthy: _reads, content: find.text('Nhận báo cáo'), empty: (ScriptedServer server) => server.on('GET', '/resources/approval_task', (_) => page(<Object?>[]))),
      );
      await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/approval'), healthy: _reads);
    });
  });

  group('AC-ST-MOB-013-3 UAT-PLAN-36 UI-MOB-24 MOB-24 the detail: comparison, evidence, and no decision offline', () {
    testWidgets('compares the report with the revision before it cell by cell: a fall is negative and CTMTQG is inside the total', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      await _open(tester, server, '/approval/mob-24/t-1');

      final SemanticsHandle semantics = tester.ensureSemantics();
      expect(find.text('Bản 2, so với bản 1'), findsOneWidget);
      // A figure is read as one sentence by a screen reader; the screen shows the same facts as a figure with its previous value and change.
      expect(find.bySemanticsLabel('Vốn năm, ngân sách trung ương: bản trước 100 triệu đồng, bản này 90 triệu đồng, thay đổi -10 triệu đồng'), findsOneWidget);
      expect(find.bySemanticsLabel('Vốn năm, ngân sách địa phương: bản trước 200 triệu đồng, bản này 210 triệu đồng, thay đổi +10 triệu đồng'), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp('Vốn kéo dài, ngân sách trung ương: bản trước 30 triệu đồng, bản này 30 triệu đồng, thay đổi không đổi')), findsOneWidget);
      expect(find.bySemanticsLabel('Tổng lũy kế: bản trước 400 triệu đồng, bản này 420 triệu đồng, thay đổi +20 triệu đồng'), findsOneWidget);
      expect(find.text('bản trước 100 triệu đồng, thay đổi -10 triệu đồng'), findsOneWidget);
      expect(find.byIcon(Icons.arrow_downward), findsOneWidget, reason: 'a fall has a down arrow and a minus: never colour alone');
      expect(find.text('trong đó CTMTQG 40 triệu đồng (đã nằm trong các ô, không cộng thêm)'), findsOneWidget);
      expect(find.textContaining('460'), findsNothing);
      expect(find.text('Lý do chỉnh sửa: Điều chỉnh số liệu vốn năm'), findsOneWidget);
      expect(find.text('bao-cao-tuan-44.pdf'), findsOneWidget);
      expect(find.text('application/pdf, 200 KB'), findsOneWidget);
      expect(find.textContaining('SHA-256: a3f5c2d1e4b69788'), findsOneWidget);
      expect(find.text('Ban QLDA giao thông'), findsOneWidget);
      expect(find.textContaining('420.000.000 đồng'), findsOneWidget, reason: 'the head of the detail states the amount in full');
      semantics.dispose();
    });

    testWidgets('a first revision has nothing to compare, and another kind of record says it has no comparison yet', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      server.on('GET', '/reports/rep-2', (_) => reportRevision('rep-2', 1, firstRevision));
      await _open(tester, server, '/approval/mob-24/t-1');
      expect(find.text('Đây là bản đầu tiên, chưa có bản trước để so sánh.'), findsOneWidget);
      expect(find.text('Hồ sơ không có tệp đính kèm.'), findsOneWidget);

      final ScriptedServer other = ScriptedServer();
      _reads(other, task: approvalTask('t-1', businessType: 'payment.approve'));
      await _open(tester, other, '/approval/mob-24/t-1');
      expect(find.text('Loại hồ sơ này chưa có so sánh với bản trước trên điện thoại.'), findsOneWidget);
      expect(other.callsTo('GET', '/reports/rep-2'), isEmpty);
    });

    testWidgets('online, the person who may decide has both buttons on the bar, and they open the confirmation and the return form as sheets that decide nothing by themselves', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      server.on('GET', '/resources/approval_task/t-1', (_) => approvalTask('t-1'));
      final ProviderContainer container = await _open(tester, server, '/approval/mob-24/t-1');

      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Phê duyệt')).onPressed, isNotNull);
      await tester.tap(find.widgetWithText(FilledButton, 'Phê duyệt'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/approval/mob-24/t-1', reason: 'the confirmation is a sheet over the detail');
      expect(find.text('Xác nhận phê duyệt'), findsWidgets);
      expect(find.textContaining('420.000.000 đồng'), findsWidgets, reason: 'the sheet states what is decided, the amount in full');
      expect(find.textContaining('nhật ký kiểm toán'), findsOneWidget);
      await tester.tap(find.widgetWithText(OutlinedButton, 'Xem lại hồ sơ'));
      await tester.pumpAndSettle();
      expect(find.text('Xác nhận phê duyệt'), findsNothing);
      expect(server.callsTo('POST', '/approval-tasks/t-1/decision'), isEmpty, reason: 'reviewing the record sends nothing');

      await tester.tap(find.widgetWithText(OutlinedButton, 'Trả lại để bổ sung'));
      await tester.pumpAndSettle();
      expect(find.widgetWithText(FilledButton, 'Trả lại hồ sơ'), findsOneWidget);
      expect(currentLocation(container), '/approval/mob-24/t-1');
    });

    testWidgets('offline the decision buttons are disabled with a visible explanation, nothing is queued, and the server holds no decision', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      final ProviderContainer container = await _open(tester, server, '/approval/mob-24/t-1');
      expect(find.text('Cần kết nối mạng để quyết định. Phê duyệt không bao giờ được xếp hàng đợi hay gửi từ bản lưu trên máy.'), findsNothing);

      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();

      expect(container.read(reachabilityProvider), Reachability.offline);
      expect(find.text('Cần kết nối mạng để quyết định. Phê duyệt không bao giờ được xếp hàng đợi hay gửi từ bản lưu trên máy.'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Phê duyệt')).onPressed, isNull);
      expect(tester.widget<OutlinedButton>(find.widgetWithText(OutlinedButton, 'Trả lại để bổ sung')).onPressed, isNull);
      await tester.tap(find.widgetWithText(FilledButton, 'Phê duyệt'), warnIfMissed: false);
      await tester.pumpAndSettle();
      expect(container.read(syncStatusProvider).pendingCommands, 0, reason: 'the offline queue holds no approval');
      server.offline = false;
      expect(server.calls.where((HttpCall call) => call.method == 'POST'), isEmpty);
    });

    testWidgets('the gate follows the connection and the copy separately: a connection that drops under a live screen disables the buttons, and a copy keeps them disabled when the connection comes back', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      final ProviderContainer container = await _open(tester, server, '/approval/mob-24/t-1');
      Finder approve() => find.widgetWithText(FilledButton, 'Phê duyệt');
      expect(tester.widget<FilledButton>(approve()).onPressed, isNotNull);

      container.read(reachabilityProvider.notifier).report(Reachability.offline);
      await tester.pumpAndSettle();
      expect(tester.widget<FilledButton>(approve()).onPressed, isNull, reason: 'offline under a screen that was loaded online');

      container.read(reachabilityProvider.notifier).report(Reachability.online);
      await tester.pumpAndSettle();
      expect(tester.widget<FilledButton>(approve()).onPressed, isNotNull);

      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();
      container.read(reachabilityProvider.notifier).report(Reachability.online);
      await tester.pumpAndSettle();
      expect(find.textContaining('Đang hiển thị dữ liệu đã lưu trên máy'), findsOneWidget);
      expect(tester.widget<FilledButton>(approve()).onPressed, isNull, reason: 'a copy of the task never decides');
    });

    testWidgets('a task the person cannot decide, one already decided, and a read-only organisation each say why the buttons are off', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      ScriptedServer server = ScriptedServer();
      _reads(server, task: approvalTask('t-1', canDecide: false));
      await _open(tester, server, '/approval/mob-24/t-1');
      expect(find.text('Bạn không được giao quyết định việc này, chỉ xem được.'), findsOneWidget);

      server = ScriptedServer();
      _reads(server, task: approvalTask('t-1', status: 'Decided'));
      await _open(tester, server, '/approval/mob-24/t-1');
      expect(find.text('Việc này không còn chờ quyết định.'), findsOneWidget);
      expect(find.text('Đã có quyết định'), findsOneWidget);

      server = ScriptedServer();
      _reads(server);
      await _open(tester, server, '/approval/mob-24/t-1', session: FakeSession(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1', mode: SessionMode.readOnly)));
      expect(find.text('Tổ chức đang ở chế độ chỉ đọc nên chưa thể quyết định.'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Phê duyệt')).onPressed, isNull);
    });

    testWidgets('the screen contract holds on the detail', (WidgetTester tester) async {
      await expectEveryState(
        tester,
        open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/approval/mob-24/t-1'),
        script: StateScript(healthy: _reads, content: find.text('Nội dung')),
      );
      await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/approval/mob-24/t-1'), healthy: _reads);
    });
  });

  group('AC-ST-MOB-013-2 AC-ST-MOB-013-1 UAT-AC121 UAT-AC05 UI-MOB-25 AC-ST-MOB-013-6 MOB-25 the confirmation needs the second factor', () {
    Finder confirm() => find.widgetWithText(FilledButton, 'Xác nhận phê duyệt');

    testWidgets('without a recent second factor the server refuses, nothing is recorded, and the decision is sent only after the person confirms again, under a new key', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      final List<HttpCall> Function() calls = _decisions(server, <HttpResult Function()>[() => problem(403, 'MFA_REQUIRED'), decided]);
      await _open(tester, server, '/approval/mob-25/t-1');

      await tester.enterText(find.byType(TextField), 'Đồng ý');
      await tester.tap(confirm());
      await tester.pumpAndSettle();
      expect(calls(), hasLength(1));
      expect(find.textContaining('Cần xác thực lại hai yếu tố. Quyết định chưa được ghi nhận'), findsOneWidget);
      expect(find.text('Đã ghi nhận quyết định'), findsNothing);
      expect(confirm(), findsOneWidget, reason: 'the form is still there to confirm again');

      await tester.tap(confirm());
      await tester.pumpAndSettle();
      expect(calls(), hasLength(2));
      expect(find.text('Đã ghi nhận quyết định'), findsOneWidget);
      expect(calls()[0].headers['idempotency-key'], isNot(calls()[1].headers['idempotency-key']), reason: 'a refused request is a new command once the cause is gone');
      expect(calls()[1].headers['if-match'], '"4"');
      expect(calls()[1].body, contains('"decision":"approve"'));
      expect(calls()[1].body, contains('Đồng ý'));
      expect(calls()[1].body, isNot(contains('signature_ref')));
    });

    testWidgets('a lost answer is "result unknown": sending the same decision again reuses the key and the version, so it is recorded once', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      int attempt = 0;
      server.answer('POST', '/approval-tasks/t-1/decision', (HttpCall call) {
        attempt += 1;
        if (attempt == 1) throw const SocketException('lost');
        return decided();
      });
      await _open(tester, server, '/approval/mob-25/t-1');

      await tester.tap(confirm());
      await tester.pumpAndSettle();
      expect(find.text('Chưa xác định kết quả'), findsOneWidget);
      expect(confirm(), findsOneWidget);

      await tester.tap(find.text('Gửi lại cùng quyết định'));
      await tester.pumpAndSettle();
      final List<HttpCall> calls = server.callsTo('POST', '/approval-tasks/t-1/decision');
      expect(calls, hasLength(2));
      expect(calls[1].headers['idempotency-key'], calls[0].headers['idempotency-key']);
      expect(calls[1].headers['if-match'], calls[0].headers['if-match']);
      expect(find.text('Đã ghi nhận quyết định'), findsOneWidget);
    });

    testWidgets('the form is editable after a lost answer, but "send again" replays the opinion that was sent: same key, same body', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      int attempt = 0;
      server.answer('POST', '/approval-tasks/t-1/decision', (HttpCall call) {
        attempt += 1;
        if (attempt == 1) throw const SocketException('lost');
        return decided();
      });
      await _open(tester, server, '/approval/mob-25/t-1');

      await tester.enterText(find.byType(TextField), 'Đồng ý');
      await tester.tap(confirm());
      await tester.pumpAndSettle();
      expect(find.text('Chưa xác định kết quả'), findsOneWidget);

      await tester.enterText(find.byType(TextField), 'Đổi ý: không đồng ý');
      await tester.tap(find.text('Gửi lại cùng quyết định'));
      await tester.pumpAndSettle();
      final List<HttpCall> calls = server.callsTo('POST', '/approval-tasks/t-1/decision');
      expect(calls, hasLength(2));
      expect(calls[1].headers['idempotency-key'], calls[0].headers['idempotency-key'], reason: 'the same intention keeps its key');
      expect(calls[1].body, calls[0].body, reason: 'what is replayed is what was sent, not what the field says now');
      expect(calls[1].body, contains('Đồng ý'));
      expect(calls[1].body, isNot(contains('Đổi ý')));
    });

    testWidgets('AC-ST-MOB-013-1 UAT-AC05 a submitter who is the assigned approver is refused,the denial is shown with its code, and the task is still pending', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      final List<HttpCall> Function() calls = _decisions(server, <HttpResult Function()>[() => problem(403, 'SELF_APPROVAL_DENIED', extra: <String, Object?>{'reassigned': true})]);
      await _open(tester, server, '/approval/mob-25/t-1');

      await tester.tap(confirm());
      await tester.pumpAndSettle();
      expect(calls(), hasLength(1));
      expect(find.text('Bạn không thể tự duyệt hồ sơ do chính mình trình. Quyết định không được ghi nhận.'), findsOneWidget);
      expect(find.text('Việc này đã được chuyển cho người duyệt khác.'), findsOneWidget);
      expect(find.text('SELF_APPROVAL_DENIED'), findsOneWidget);
      expect(find.text('Đã ghi nhận quyết định'), findsNothing);
    });

    testWidgets('the other refusals each have their words', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final Map<String, String> expected = <String, String>{
        'TASK_ALREADY_DECIDED': 'Việc này đã có quyết định.',
        'VERSION_CONFLICT': 'Việc này vừa thay đổi. Hãy mở lại để xem tình trạng hiện tại rồi quyết định.',
        'PERIOD_LOCKED': 'Kỳ báo cáo đã khóa nên chưa thể quyết định.',
        'LICENSE_EXPIRED': 'License đã hết hạn nên chưa thể quyết định.',
        'APPROVER_NOT_AUTHORIZED': 'Bạn không phải người được giao quyết định việc này.',
        'SCOPE_DENIED': 'Bạn không có quyền quyết định việc này.',
        'WORKFLOW_STATE_INVALID': 'Quy trình phê duyệt này không còn chạy.',
        'RESOURCE_NOT_FOUND': 'Không tìm thấy việc này.',
        'VALIDATION_FAILED': 'Quyết định không hợp lệ. Hãy kiểm tra lại các ô đã nhập.',
        'SESSION_EXPIRED': 'Phiên làm việc đã hết hạn. Đăng nhập lại rồi quyết định.',
        'SOMETHING_ELSE': 'Chưa gửi được quyết định. Hãy thử lại.',
      };
      for (final MapEntry<String, String> entry in expected.entries) {
        final ScriptedServer server = ScriptedServer();
        _reads(server);
        _decisions(server, <HttpResult Function()>[() => problem(entry.key == 'SESSION_EXPIRED' ? 401 : 409, entry.key)]);
        await _open(tester, server, '/approval/mob-25/t-1');
        await tester.tap(confirm());
        await tester.pumpAndSettle();
        expect(find.text(entry.value), findsOneWidget, reason: entry.key);
      }
    });

    testWidgets('offline, or on a copy of the task, the button is disabled with the reason and nothing is sent', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      await _open(tester, server, '/approval/mob-25/t-1');
      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();

      expect(tester.widget<FilledButton>(confirm()).onPressed, isNull);
      expect(find.textContaining('Cần kết nối mạng để quyết định'), findsOneWidget);
      expect(server.calls.where((HttpCall call) => call.method == 'POST'), isEmpty);
    });

    testWidgets('a push or a deep link that opens the task never decides it: only the button does', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      await _open(tester, server, '/approval/mob-25/t-1');
      expect(server.calls.where((HttpCall call) => call.method == 'POST'), isEmpty, reason: 'opening the confirmation sends nothing');
      expect(find.byType(Dismissible), findsNothing);
    });

    testWidgets('TK-MOB-032-2 the approval carries no digital signature and points to MOB-67, where a document is signed with the provider SDK after the second-factor check', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      final ProviderContainer container = await _open(tester, server, '/approval/mob-25/t-1');
      expect(find.textContaining('Phê duyệt này không kèm chữ ký số'), findsOneWidget);
      expect(find.textContaining('bộ ký số của nhà cung cấp'), findsOneWidget);
      await tester.tap(find.widgetWithText(TextButton, 'Mở văn bản chờ ký'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/approval/mob-67');
      expect(server.calls.where((HttpCall call) => call.method != 'GET'), isEmpty, reason: 'pointing to the signing screen decides and signs nothing');
    });

    testWidgets('the english interface and the contract of the screen', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      await _open(tester, server, '/approval/mob-25/t-1', locale: const Locale('en'));
      expect(find.text('Confirm the approval'), findsWidgets);
      expect(find.textContaining('This approval carries no digital signature'), findsOneWidget);

      await expectEveryState(
        tester,
        open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/approval/mob-25/t-1'),
        script: StateScript(healthy: _reads, content: find.text('Xác nhận phê duyệt')),
      );
      await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/approval/mob-25/t-1'), healthy: _reads);
    });
  });

  group('AC-ST-MOB-013-4 UI-MOB-26 MOB-26 the return needs reasons and the sections to fix', () {
    Finder submit() => find.widgetWithText(FilledButton, 'Trả lại hồ sơ');
    Finder field(String label) => find.widgetWithText(TextField, label);

    testWidgets('the form blocks the send until the reason, a section and the day are given', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      final List<HttpCall> Function() calls = _decisions(server, <HttpResult Function()>[decided]);
      await _open(tester, server, '/approval/mob-26/t-1');

      await tester.tap(submit());
      await tester.pumpAndSettle();
      expect(find.text('Hãy nhập lý do trả lại.'), findsOneWidget);
      expect(find.text('Hãy nêu ít nhất một mục cần sửa.'), findsOneWidget);
      expect(find.text('Hãy nhập hạn bổ sung.'), findsOneWidget);
      expect(calls(), isEmpty);

      await tester.enterText(field('Lý do'), 'Thiếu số liệu kỳ trước');
      await tester.enterText(field('Mục cần sửa (mỗi dòng một mục)'), 'ab');
      await tester.enterText(field('Hạn bổ sung (năm-tháng-ngày, ví dụ 2026-11-20)'), '2026-02-30');
      await tester.tap(submit());
      await tester.pumpAndSettle();
      expect(find.text('Mỗi mục cần sửa có ít nhất 3 ký tự.'), findsOneWidget);
      expect(find.text('Hạn bổ sung không phải một ngày có thật.'), findsOneWidget);
      expect(find.text('Hãy nhập lý do trả lại.'), findsNothing);
      expect(calls(), isEmpty);
    });

    testWidgets('a complete form sends the return: the reasons, the sections and the day in the reason of the decision', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      final List<HttpCall> Function() calls = _decisions(server, <HttpResult Function()>[decided]);
      await _open(tester, server, '/approval/mob-26/t-1');

      await tester.enterText(field('Lý do'), 'Thiếu số liệu kỳ trước');
      await tester.enterText(field('Mục cần sửa (mỗi dòng một mục)'), 'Bảng vốn kéo dài\n\nPhụ lục ảnh');
      await tester.enterText(field('Hạn bổ sung (năm-tháng-ngày, ví dụ 2026-11-20)'), '2026-11-20');
      await tester.tap(submit());
      await tester.pumpAndSettle();

      expect(calls(), hasLength(1));
      expect(calls().single.body, contains('"decision":"return"'));
      expect(calls().single.body, contains(r'Thiếu số liệu kỳ trước\n\nMục cần sửa:\n- Bảng vốn kéo dài\n- Phụ lục ảnh\nHạn bổ sung: 20/11/2026'));
      expect(calls().single.headers['if-match'], '"4"');
      expect(find.text('Đã ghi nhận quyết định'), findsOneWidget);
      expect(find.text('Trả lại hồ sơ'), findsNothing, reason: 'the form leaves once the decision is recorded');
    });

    testWidgets('after a lost answer "send again" replays the return that was sent, whatever the fields say now: same key, same body, no new check', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      int attempt = 0;
      server.answer('POST', '/approval-tasks/t-1/decision', (HttpCall call) {
        attempt += 1;
        if (attempt == 1) throw const SocketException('lost');
        return decided();
      });
      await _open(tester, server, '/approval/mob-26/t-1');

      await tester.enterText(field('Lý do'), 'Thiếu số liệu kỳ trước');
      await tester.enterText(field('Mục cần sửa (mỗi dòng một mục)'), 'Bảng vốn kéo dài');
      await tester.enterText(field('Hạn bổ sung (năm-tháng-ngày, ví dụ 2026-11-20)'), '2026-11-20');
      await tester.tap(submit());
      await tester.pumpAndSettle();
      expect(find.text('Chưa xác định kết quả'), findsOneWidget);

      await tester.enterText(field('Lý do'), 'Lý do khác hẳn');
      await tester.enterText(field('Mục cần sửa (mỗi dòng một mục)'), 'Mục khác');
      await tester.enterText(field('Hạn bổ sung (năm-tháng-ngày, ví dụ 2026-11-20)'), 'không phải ngày');
      await tester.tap(find.text('Gửi lại cùng quyết định'));
      await tester.pumpAndSettle();
      final List<HttpCall> calls = server.callsTo('POST', '/approval-tasks/t-1/decision');
      expect(calls, hasLength(2));
      expect(calls[1].headers['idempotency-key'], calls[0].headers['idempotency-key']);
      expect(calls[1].body, calls[0].body);
      expect(calls[1].body, contains('Bảng vốn kéo dài'));
      expect(calls[1].body, isNot(contains('Lý do khác hẳn')));
    });

    testWidgets('a reason and sections longer than the server allows are refused by the form, and offline the button is disabled',(WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      await _open(tester, server, '/approval/mob-26/t-1');
      await tester.enterText(field('Lý do'), 'x' * 1990);
      await tester.enterText(field('Mục cần sửa (mỗi dòng một mục)'), 'Một mục khá dài');
      await tester.enterText(field('Hạn bổ sung (năm-tháng-ngày, ví dụ 2026-11-20)'), '2026-11-20');
      await tester.tap(submit());
      await tester.pumpAndSettle();
      expect(find.text('Lý do và các mục cần sửa quá dài (tối đa 2000 ký tự).'), findsOneWidget);
      expect(server.calls.where((HttpCall call) => call.method == 'POST'), isEmpty);

      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();
      expect(tester.widget<FilledButton>(submit()).onPressed, isNull);
    });

    testWidgets('every state is drawn and the contract of the screen holds', (WidgetTester tester) async {
      await expectEveryState(
        tester,
        open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/approval/mob-26/t-1'),
        script: StateScript(healthy: _reads, content: find.text('Trả lại hồ sơ')),
      );
      await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/approval/mob-26/t-1'), healthy: _reads);
    });
  });

  group('AC-ST-MOB-013-3 ApprovalCommands never reaches the offline queue and never sends while offline', () {
    MachvonApiClient client(ScriptedServer server) => MachvonApiClient(baseUrl: Uri.parse('https://api.test/v1'), transport: server, token: () async => 't');
    const DecisionRequest request = DecisionRequest(taskId: 't-1', version: 4, kind: DecisionKind.approve, comment: ' Đồng ý ');

    test('offline nothing is sent; after a lost answer the person may send the same decision again and it reuses the key', () async {
      final ScriptedServer server = ScriptedServer();
      int attempt = 0;
      server.answer('POST', '/approval-tasks/t-1/decision', (HttpCall call) {
        attempt += 1;
        if (attempt == 1) throw const SocketException('lost');
        return decided();
      });
      bool online = false;
      final ApprovalCommands commands = ApprovalCommands(client: client(server), isOnline: () => online);

      expect(await commands.send(request, returnText: ''), isA<DeviceOffline>());
      expect(server.calls, isEmpty);

      online = true;
      expect(await commands.send(request, returnText: ''), isA<ResultUnknown>());
      online = false;
      final DecisionOutcome again = await commands.send(request, returnText: '', retryAfterUnknown: true);
      expect(again, isA<Decided>());
      expect((again as Decided).status, 'DECIDED');
      final List<HttpCall> calls = server.callsTo('POST', '/approval-tasks/t-1/decision');
      expect(calls[1].headers['idempotency-key'], calls[0].headers['idempotency-key']);
      expect(calls[0].body, contains('"reason":"Đồng ý"'), reason: 'the opinion is trimmed');
    });

    test('a decision of the task sent again with another version is another intention', () async {
      final ScriptedServer server = ScriptedServer()..answer('POST', '/approval-tasks/t-1/decision', (HttpCall call) => problem(409, 'VERSION_CONFLICT'));
      final ApprovalCommands commands = ApprovalCommands(client: client(server), isOnline: () => true);
      final DecisionOutcome refused = await commands.send(request, returnText: '');
      expect(refused, isA<Refused>());
      expect((refused as Refused).code, 'VERSION_CONFLICT');
      await commands.send(const DecisionRequest(taskId: 't-1', version: 5, kind: DecisionKind.approve), returnText: '');
      final List<HttpCall> calls = server.callsTo('POST', '/approval-tasks/t-1/decision');
      expect(calls[1].headers['idempotency-key'], isNot(calls[0].headers['idempotency-key']));
      expect(calls[1].headers['if-match'], '"5"');
    });
  });

  group('the rules of the return form and of the decision, as pure functions', () {
    test('sections: lines trimmed, empty ones dropped; days: only real calendar days', () {
      expect(sectionsOf(' a b \n\n  \nc d '), <String>['a b', 'c d']);
      expect(isRealDay('2026-11-20'), isTrue);
      expect(isRealDay('2026-02-30'), isFalse);
      expect(isRealDay('2026-2-3'), isFalse);
      expect(isRealDay('nonsense'), isFalse);
    });

    test('the checks of a return', () {
      expect(checkReturn(reason: 'ok', sectionsText: 'abc', dueDay: '2026-11-20', composedLength: 10), isEmpty);
      expect(checkReturn(reason: ' ', sectionsText: '', dueDay: '', composedLength: 0).keys, containsAll(<String>['reason', 'sections', 'due']));
      expect(checkReturn(reason: 'ok', sectionsText: 'abc', dueDay: '2026-11-20', composedLength: 2001)['reason'], ReturnProblem.reasonTooLong);
      expect(checkReturn(reason: 'ok', sectionsText: List<String>.filled(21, 'abc').join('\n'), dueDay: '2026-11-20', composedLength: 5)['sections'], ReturnProblem.tooManySections);
      expect(checkReturn(reason: 'ok', sectionsText: 'x' * 2001, dueDay: '2026-11-20', composedLength: 5)['sections'], ReturnProblem.sectionTooLong);
    });

    test('every error code of the server maps to a problem', () {
      expect(problemOf('SELF_APPROVAL_DENIED'), DecisionProblem.selfApproval);
      expect(problemOf('MFA_REQUIRED'), DecisionProblem.stepUp);
      expect(problemOf('INVALID_REQUEST'), DecisionProblem.validation);
      expect(problemOf('PERMISSION_DENIED'), DecisionProblem.denied);
      expect(problemOf('nope'), DecisionProblem.general);
    });
  });
}
