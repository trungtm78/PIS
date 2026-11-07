import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart' show HttpCall, HttpResult;
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/navigation/route_catalogue.dart';
import 'package:machvon_mobile/core/navigation/tab_badges.dart';
import 'package:machvon_mobile/features/dashboard/alert_badge.dart';
import 'package:machvon_mobile/features/dashboard/alerts.dart';
import 'package:machvon_mobile/features/dashboard/dashboard_feature.dart' as dashboard;
import 'package:machvon_mobile/features/dashboard/widgets/alert_card.dart' show AlertCard;
import 'package:machvon_mobile/features/notification_inbox/push_registration.dart';

import '../../support/harness.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'dashboard_fixtures.dart';

const MobileFeature _approvalStub = MobileFeature(id: 'stub', screens: <ScreenSpec>[ScreenSpec(screenId: 'MOB-24', pathSuffix: '/:taskId', builder: _stub)]);

Widget _stub(BuildContext context, ScreenContext screen) => Text('task ${screen.pathParameters['taskId']}');

Future<ProviderContainer> _open(WidgetTester tester, ScriptedServer server, String location) =>
    pumpWithServer(tester, features: <MobileFeature>[dashboard.feature, _approvalStub], server: server, location: location);

final List<Map<String, Object?>> _alerts = <Map<String, Object?>>[
  alertItem('a-watch', severity: 'WATCH', source: 'PERMIT', title: 'Giấy phép DA-DT205 sắp hết hạn', dueOn: '2026-11-20'),
  alertItem('a-action', severity: 'ACTION', source: 'ADVANCE', title: 'Tạm ứng quá hạn thanh toán', dueOn: '2026-11-05'),
  alertItem('a-urgent', severity: 'URGENT', source: 'REPORT', title: 'Báo cáo tuần 44: 3 chủ đầu tư quá hạn', dueOn: '2026-10-31', overdue: true, daysLate: 3, consequence: 'Số liệu giải ngân tuần không đủ để chốt'),
  alertItem('a-extra', severity: 'ACTION', source: 'ISSUE', title: 'Vướng mắc giải phóng mặt bằng', dueOn: '2026-11-04'),
];

void _healthy(ScriptedServer server, {List<Map<String, Object?>>? alerts}) {
  server
    ..on('GET', '/home/command-center', (_) => commandCenter())
    ..on('GET', '/home/my-work', (_) => alertWork(alerts ?? _alerts))
    ..on('GET', '/home/my-work/counts', (_) => alertCounts(urgent: 1, action: 2, watch: 1))
    ..on('POST', '/home/work-actions/claim', (_) => <String, Object?>{'operation_id': 'o', 'status': 'Claimed'})
    ..on('POST', '/home/work-actions/assign', (_) => <String, Object?>{'operation_id': 'o', 'status': 'Assigned'})
    ..on('GET', '/home/work-clocks/policies', (_) => workClockPolicies())
    ..on('POST', '/home/work-actions/snooze', (_) => <String, Object?>{'operation_id': 'o', 'status': 'Snoozed'});
}

void main() {
  group('the alert model tolerates a server that has not got the new fields yet', () {
    test('a missing severity is a task to do, an unknown one too, and the lifecycle starts as new', () {
      final AlertFeed feed = parseAlertFeed(<String, Object?>{
        'items': <Object?>[alertItem('a-1', severity: null), alertItem('a-2', severity: 'MYSTERY')],
      })!;
      expect(feed.items.map((AlertItem item) => item.severity), <AlertSeverity>[AlertSeverity.action, AlertSeverity.action]);
      expect(feed.items.first.lifecycle, AlertLifecycle.fresh);
      expect(feed.counts.action, 2, reason: 'the counts are counted from the items when the server gives none');
      expect(feed.unavailableSources, isEmpty);
    });

    test('the most important comes first: level, then late, then the nearest day; resolved ones and ones without a target are left out', () {
      final AlertFeed feed = parseAlertFeed(alertWork(<Map<String, Object?>>[
        ..._alerts,
        alertItem('a-done', severity: 'URGENT', lifecycle: 'RESOLVED'),
        <String, Object?>{'id': 'no-target', 'severity': 'URGENT', 'title': 'x'},
      ]))!;
      expect(feed.items.map((AlertItem item) => item.id), <String>['a-urgent', 'a-extra', 'a-action', 'a-watch']);
      expect(feed.top(3), hasLength(3));
      expect(feed.counts.urgent, 3, reason: 'the counts are the server\'s word about the whole list, whatever the page holds');
    });

    test('a list that is not a list is refused, and the sources that failed are kept by name', () {
      expect(parseAlertFeed(<String, Object?>{'nope': 1}), isNull);
      expect(parseAlertFeed(alertWork(<Map<String, Object?>>[], unavailable: <String>['PERMIT', 'ISSUE']))!.unavailableSources, <String>['PERMIT', 'ISSUE']);
      expect(parseAlertCounts(alertCounts(urgent: 2, action: 3))!.needsDoing, 5);
      expect(parseAlertCounts(<String, Object?>{'counts': <String, Object?>{'total': 4}}), isNull, reason: 'an old server has no levels to count');
    });

    test('the countdown names the time left and the day, or how late; the server decides what is late', () {
      final DateTime now = DateTime.utc(2026, 11, 3, 3, 0);
      AlertDue due(String? dueOn, {bool overdue = false, int late = 0}) => describeDue(
            parseAlertFeed(<String, Object?>{'items': <Object?>[alertItem('x', dueOn: dueOn, overdue: overdue, daysLate: late)]})!.items.single,
            now,
          );
      expect(due('2026-11-05').kind, AlertDueKind.remainingDays);
      expect(due('2026-11-05').amount, 2);
      expect(due('2026-11-05').day, '05/11');
      expect(due('2026-11-03').kind, AlertDueKind.today);
      expect(due('2026-10-31', overdue: true, late: 3).amount, 3);
      expect(due('2026-10-31', overdue: true, late: 3).kind, AlertDueKind.overdueDays);
      expect(due('2026-11-01').kind, AlertDueKind.overdueDays, reason: 'a day that has passed is late even when the server sent no flag');
      expect(due(null).kind, AlertDueKind.none);
      expect(due('2026-11-03T10:00:00Z').kind, AlertDueKind.remainingHours);
      expect(due('2026-11-03T10:00:00Z').amount, 7);
      expect(due('2026-11-03T10:00:00Z').time, '17:00');
      expect(due('2026-11-03T01:00:00Z').kind, AlertDueKind.overdueHours);
      expect(due('2026-11-03T03:30:00Z').amount, 0, reason: 'under an hour');
    });

    test('a record opens only where the phone has a screen: an approval, a project, a screen of the phone without a parameter', () {
      AlertItem item(String screen, String id) => parseAlertFeed(<String, Object?>{
            'items': <Object?>[alertItem('x', screen: screen)..['target'] = <String, Object?>{'screen': screen, 'id': id}],
          })!.items.single;
      bool has(String id) => id == 'MOB-57';
      expect(alertScreenOf(item('ADM-06', 't-1'), has: has), (screenId: 'MOB-24', pathSuffix: '/t-1'));
      expect(alertScreenOf(item('PRJ-03', 'p 1'), has: has), isNull, reason: 'an id that is not a plain token never opens');
      expect(alertScreenOf(item('PRJ-03', 'p-1'), has: has), (screenId: 'MOB-10', pathSuffix: '/p-1'));
      expect(alertScreenOf(item('MOB-57', ''), has: has), (screenId: 'MOB-57', pathSuffix: ''));
      expect(alertScreenOf(item('DIS-03', 'r-1'), has: has), isNull);
      expect(alertScreenOf(item('MOB-99', ''), has: has), isNull);
    });
  });

  group('MOB-07 the leader home: work before figures', () {
    testWidgets('the order is context line, alerts, command block, shortcuts, summary; three alerts at most, the most important first', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthy(server);
      await _open(tester, server, '/home');

      final double context = tester.getTopLeft(find.textContaining('Cập nhật 10:00')).dy;
      final double alerts = tester.getTopLeft(find.text('Cần xử lý ngay')).dy;
      final double command = tester.getTopLeft(find.text('Điều hành')).dy;
      final double shortcuts = tester.getTopLeft(find.text('Lối tắt')).dy;
      final double summary = tester.getTopLeft(find.text('Tóm tắt số liệu')).dy;
      expect(<double>[context, alerts, command, shortcuts, summary], orderedEquals(<double>[context, alerts, command, shortcuts, summary]..sort()));

      expect(find.textContaining('Toàn bộ phạm vi · 2 dự án · Chốt 31/10/2026 · Cập nhật 10:00'), findsOneWidget);
      expect(find.byType(AlertCard), findsNWidgets(3));
      final double first = tester.getTopLeft(find.text('Báo cáo tuần 44: 3 chủ đầu tư quá hạn')).dy;
      final double second = tester.getTopLeft(find.text('Vướng mắc giải phóng mặt bằng')).dy;
      final double third = tester.getTopLeft(find.text('Tạm ứng quá hạn thanh toán')).dy;
      expect(first, lessThan(second));
      expect(second, lessThan(third));
      expect(find.text('Giấy phép DA-DT205 sắp hết hạn'), findsNothing, reason: 'the fourth is not on the home');
      expect(find.textContaining('Còn 1 việc nữa'), findsOneWidget);
      expect(find.text('Khẩn 1'), findsOneWidget);
      expect(find.text('Cần xử lý 2'), findsOneWidget);
      expect(find.text('Theo dõi 1'), findsOneWidget);

      final Uri read = server.callsTo('GET', '/home/my-work').single.url;
      expect(read.queryParameters['view'], 'scope', reason: 'a leader reads the whole scope');
    });

    testWidgets('each alert has the level as icon and word, its source, the countdown with the day, the owner and what follows', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthy(server, alerts: <Map<String, Object?>>[
        alertItem('a-urgent', severity: 'URGENT', source: 'REPORT', title: 'Báo cáo tuần 44', dueOn: '2026-10-31', overdue: true, daysLate: 3, consequence: 'Số liệu tuần không chốt được', escalation: <String, Object?>{'level': 2, 'of': 3, 'next_at': '2026-11-03T09:00:00Z'}),
        alertItem('a-action', source: 'ADVANCE', title: 'Tạm ứng quá hạn', claimedBy: <String, Object?>{'id': 'u-2', 'name': 'Lê Văn B', 'at': '2026-11-03T01:30:00Z'}, lifecycle: 'CLAIMED'),
        alertItem('a-watch', severity: 'WATCH', source: 'PERMIT', title: 'Giấy phép sắp hết hạn', dueOn: '2026-11-20', assignee: <String, Object?>{'id': 'u-3', 'name': 'Trần Thị C', 'due_on': '2026-11-10'}, lifecycle: 'IN_PROGRESS'),
      ]);
      await _open(tester, server, '/home');

      Finder inCards(Finder finder) => find.descendant(of: find.byType(AlertCard), matching: finder);
      expect(inCards(find.byIcon(Icons.error)), findsOneWidget, reason: 'urgent has an icon');
      expect(inCards(find.byIcon(Icons.warning_amber_rounded)), findsOneWidget);
      expect(inCards(find.byIcon(Icons.visibility_outlined)), findsOneWidget);
      expect(inCards(find.text('Khẩn')), findsOneWidget);
      expect(inCards(find.text('Cần xử lý')), findsOneWidget);
      expect(inCards(find.text('Theo dõi')), findsOneWidget);
      expect(find.text('Quá hạn 3 ngày'), findsOneWidget);
      expect(find.text('Còn 2 ngày · 05/11'), findsOneWidget);
      expect(find.text('Còn 17 ngày · 20/11'), findsOneWidget);
      expect(find.text('Nguồn: Báo cáo · Dự án đường vành đai'), findsOneWidget);
      expect(find.text('Nếu không làm: Số liệu tuần không chốt được'), findsOneWidget);
      expect(find.textContaining('Cấp 2/3 · lên cấp lúc 03/11/2026 16:00'), findsOneWidget);
      expect(find.text('Đã nhận bởi Lê Văn B lúc 03/11/2026 08:30'), findsOneWidget);
      expect(find.text('Giao cho Trần Thị C, hạn 10/11/2026'), findsOneWidget);
      expect(find.text('Đã nhận'), findsOneWidget);
      expect(find.text('Đang xử lý'), findsOneWidget);
      expect(find.text('Chưa có người nhận'), findsOneWidget);
    });

    testWidgets('the primary action opens the record when the phone has a screen for it, and every act is also in a menu (no gesture alone)', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthy(server, alerts: <Map<String, Object?>>[alertItem('t-9', title: 'Phê duyệt kế hoạch vốn')]);
      final ProviderContainer container = await _open(tester, server, '/home');

      await tester.tap(find.widgetWithText(FilledButton, 'Xử lý'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/approval/mob-24/t-9');
      expect(find.text('task t-9'), findsOneWidget);
    });

    testWidgets('an alert whose record has no screen on the phone offers to take it instead', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthy(server, alerts: <Map<String, Object?>>[alertItem('x-1', screen: 'DIS-03', title: 'Báo cáo tuần')]);
      await _open(tester, server, '/home');

      expect(find.widgetWithText(FilledButton, 'Xử lý'), findsNothing);
      expect(find.widgetWithText(FilledButton, 'Nhận xử lý'), findsOneWidget);
    });

    testWidgets('Nhắc lại is not offered for an urgent alert, and is for the others; the menu has its own labelled button', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthy(server, alerts: <Map<String, Object?>>[alertItem('a-urgent', severity: 'URGENT', title: 'Khẩn một')]);
      await _open(tester, server, '/home');

      expect(find.byTooltip('Thao tác với việc này'), findsOneWidget);
      await tester.tap(find.byTooltip('Thao tác với việc này'));
      await tester.pumpAndSettle();
      expect(find.text('Nhận xử lý'), findsWidgets);
      expect(find.text('Giao cho'), findsOneWidget);
      expect(find.text('Nhắc lại sau'), findsNothing);

      final ScriptedServer other = ScriptedServer();
      _healthy(other, alerts: <Map<String, Object?>>[alertItem('a-action', severity: 'ACTION', title: 'Cần làm')]);
      await _open(tester, other, '/home');
      await tester.tap(find.byTooltip('Thao tác với việc này'));
      await tester.pumpAndSettle();
      expect(find.text('Nhắc lại sau'), findsOneWidget);
    });

    testWidgets('Nhận xử lý sends the claim once with its idempotency key, says what was done and reads the list again', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthy(server, alerts: <Map<String, Object?>>[alertItem('a-1', source: 'ADVANCE', title: 'Tạm ứng quá hạn')]);
      await _open(tester, server, '/home');
      final int reads = server.callsTo('GET', '/home/my-work').length;

      await tester.tap(find.byTooltip('Thao tác với việc này'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Nhận xử lý').last);
      await tester.pumpAndSettle();

      final List<HttpCall> claims = server.callsTo('POST', '/home/work-actions/claim');
      expect(claims, hasLength(1));
      expect(jsonDecode(claims.single.body!), <String, Object?>{'source': 'ADVANCE', 'source_id': 'a-1'});
      expect(claims.single.headers['idempotency-key'], isNotEmpty);
      expect(find.text('Đã nhận xử lý: Tạm ứng quá hạn'), findsOneWidget);
      expect(server.callsTo('GET', '/home/my-work').length, reads + 1, reason: 'the list follows the act');
    });

    testWidgets('Nhắc lại sau an hour sends the instant an hour on and says the due day and the escalation do not change', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthy(server, alerts: <Map<String, Object?>>[alertItem('a-1', severity: 'WATCH', title: 'Theo dõi giấy phép', source: 'PERMIT')]);
      await _open(tester, server, '/home');

      await tester.tap(find.byTooltip('Thao tác với việc này'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Nhắc lại sau'));
      await tester.pumpAndSettle();
      expect(find.text('Không đổi hạn nghiệp vụ và không dừng việc leo thang.'), findsOneWidget);
      await tester.tap(find.text('Chờ thêm thông tin'));
      await tester.tap(find.text('Sau 1 giờ'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Hoãn việc'));
      await tester.pumpAndSettle();

      final List<HttpCall> snoozes = server.callsTo('POST', '/home/work-actions/snooze');
      expect(snoozes, hasLength(1));
      final Map<String, Object?> body = jsonDecode(snoozes.single.body!) as Map<String, Object?>;
      expect(body['source_id'], 'a-1');
      expect(body['snooze_until'], kNow.add(const Duration(hours: 1)).toIso8601String());
      expect(body['reason_code'], 'WAITING_INFORMATION');
      expect(body.containsKey('reason'), isFalse, reason: 'no note was written');
      expect(find.textContaining('Hạn nghiệp vụ và việc leo thang không đổi'), findsOneWidget);
    });

    testWidgets('Giao cho asks for the person, offers three due days, and sends the day', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthy(server, alerts: <Map<String, Object?>>[alertItem('a-1', source: 'ISSUE', title: 'Vướng mắc')]);
      await _open(tester, server, '/home');

      await tester.tap(find.byTooltip('Thao tác với việc này'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Giao cho'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Giao việc').last);
      await tester.pumpAndSettle();
      expect(find.text('Hãy nhập người nhận'), findsOneWidget);
      expect(server.callsTo('POST', '/home/work-actions/assign'), isEmpty);

      await tester.enterText(find.byType(TextField).first, 'u-77');
      await tester.tap(find.textContaining('7 ngày'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Giao việc').last);
      await tester.pumpAndSettle();

      final List<HttpCall> assigns = server.callsTo('POST', '/home/work-actions/assign');
      expect(assigns, hasLength(1));
      final Map<String, Object?> body = jsonDecode(assigns.single.body!) as Map<String, Object?>;
      expect(body['assignee_id'], 'u-77');
      expect(body['due_on'], '2026-11-10');
      expect(body['source'], 'ISSUE');
      expect(find.text('Đã giao: Vướng mắc. Hạn 10/11/2026.'), findsOneWidget);
    });

    testWidgets('a refusal of the server is said with its code and nothing changes', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthy(server, alerts: <Map<String, Object?>>[alertItem('a-1', title: 'Cần làm')]);
      server.refuse('POST', '/home/work-actions/claim', 403, 'PERMISSION_DENIED');
      await _open(tester, server, '/home');
      final int reads = server.callsTo('GET', '/home/my-work').length;

      await tester.tap(find.byTooltip('Thao tác với việc này'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Nhận xử lý').last);
      await tester.pumpAndSettle();
      expect(find.text('Máy chủ từ chối thao tác (PERMISSION_DENIED).'), findsOneWidget);
      expect(server.callsTo('GET', '/home/my-work').length, reads, reason: 'a refused act changes nothing, so nothing is read again');
    });

    testWidgets('a lost connection while sending says the act can be tried again and is never recorded twice', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthy(server, alerts: <Map<String, Object?>>[alertItem('a-1', title: 'Cần làm')]);
      await _open(tester, server, '/home');

      server.offline = true;
      await tester.tap(find.byTooltip('Thao tác với việc này'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Nhận xử lý').last);
      await tester.pumpAndSettle();
      expect(find.textContaining('Chưa gửi được vì mất kết nối'), findsOneWidget);
      final String firstKey = server.callsTo('POST', '/home/work-actions/claim').single.headers['idempotency-key']!;

      await tester.tap(find.byTooltip('Thao tác với việc này'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Nhận xử lý').last);
      await tester.pumpAndSettle();
      expect(server.callsTo('POST', '/home/work-actions/claim').last.headers['idempotency-key'], firstKey, reason: 'the retry is the same intention');
    });
  });

  group('the states of the alert block', () {
    testWidgets('loading is a skeleton, never a 0', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final Completer<void> never = Completer<void>();
      final ScriptedServer server = ScriptedServer()..answerAll((_) async {
            await never.future;
            throw StateError('never');
          });
      await _open(tester, server, '/home');
      expect(find.textContaining('Khẩn'), findsNothing);
      expect(find.text('0'), findsNothing);
      never.complete();
      await tester.pumpAndSettle();
    });

    testWidgets('no work: one line "Không còn việc khẩn" with the time of the check, not a blank and not a 0', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthy(server, alerts: <Map<String, Object?>>[]);
      await _open(tester, server, '/home');

      expect(find.text('Không còn việc khẩn · đã kiểm tra lúc 10:00'), findsOneWidget);
      expect(find.text('Xem tất cả'), findsNothing);
    });

    testWidgets('a source that failed is named and the screen never says there is no work', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      server
        ..on('GET', '/home/command-center', (_) => commandCenter())
        ..on('GET', '/home/my-work', (_) => alertWork(<Map<String, Object?>>[], unavailable: <String>['PERMIT', 'AUDIT_RECOMMENDATION']));
      await _open(tester, server, '/home');

      expect(find.textContaining('Chưa đọc được nguồn: Giấy phép, Kiến nghị thanh tra, kiểm toán'), findsOneWidget);
      expect(find.textContaining('Không còn việc khẩn'), findsNothing);
    });

    testWidgets('the alerts failing name their source with the code and retry in place, and the command block stays', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      server
        ..on('GET', '/home/command-center', (_) => commandCenter())
        ..refuse('GET', '/home/my-work', 500, 'INTERNAL_ERROR');
      await _open(tester, server, '/home');

      expect(find.text('Chưa tải được việc cần xử lý'), findsOneWidget);
      expect(find.textContaining('Nguồn lỗi: danh sách việc cần xử lý (INTERNAL_ERROR)'), findsOneWidget);
      expect(find.text('Điều hành'), findsOneWidget);
      expect(find.text('14,0000%'), findsOneWidget);

      server.on('GET', '/home/my-work', (_) => alertWork(_alerts));
      await tester.tap(find.widgetWithText(OutlinedButton, 'Thử lại'));
      await tester.pumpAndSettle();
      expect(find.text('Chưa tải được việc cần xử lý'), findsNothing);
      expect(find.text('Báo cáo tuần 44: 3 chủ đầu tư quá hạn'), findsOneWidget);
    });

    testWidgets('the command center failing is named and the alerts stay', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      server
        ..refuse('GET', '/home/command-center', 500, 'INTERNAL_ERROR')
        ..on('GET', '/home/my-work', (_) => alertWork(_alerts));
      await _open(tester, server, '/home');

      expect(find.text('Chưa tải được khối điều hành'), findsOneWidget);
      expect(find.text('Báo cáo tuần 44: 3 chủ đầu tư quá hạn'), findsOneWidget);
    });

    testWidgets('a scope that is refused falls back to the alerts of the person and says so', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      server
        ..on('GET', '/home/command-center', (_) => commandCenter())
        ..answer('GET', '/home/my-work', (HttpCall call) {
          if (call.url.queryParameters['view'] == 'scope') {
            return HttpResult(
              status: 403,
              headers: <String, String>{'content-type': 'application/problem+json'},
              body: jsonEncode(<String, Object?>{'type': 'about:blank', 'title': 'SCOPE_DENIED', 'status': 403, 'code': 'SCOPE_DENIED'}),
            );
          }
          return FakeTransport.json(200, alertWork(_alerts.take(1).toList(), view: 'mine'));
        });
      await _open(tester, server, '/home');

      expect(server.callsTo('GET', '/home/my-work').map((HttpCall call) => call.url.queryParameters['view']), <String?>['scope', 'mine']);
      expect(find.text('Bạn không được xem toàn phạm vi nên đây là việc của riêng bạn.'), findsOneWidget);
      expect(find.text('Thử lại'), findsNothing);
      expect(find.text('Giấy phép DA-DT205 sắp hết hạn'), findsOneWidget);
    });

    testWidgets('offline: the copy is read only, says when it was last synced, offers no act and says the figures are old', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      DateTime now = kNow;
      final ScriptedServer server = ScriptedServer();
      _healthy(server);
      await pumpWithServer(tester, features: <MobileFeature>[dashboard.feature, _approvalStub], server: server, location: '/home', now: () => now);
      expect(find.byTooltip('Thao tác với việc này'), findsWidgets);

      server.offline = true;
      now = kNow.add(const Duration(days: 1));
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();

      expect(find.textContaining('Đang xem bản đã lưu, đồng bộ lần cuối 03/11/2026 10:00. Chỉ đọc'), findsOneWidget);
      expect(find.text('Số liệu cũ: hãy kết nối mạng để kiểm tra lại.'), findsOneWidget);
      expect(find.byTooltip('Thao tác với việc này'), findsNothing, reason: 'a copy cannot take, give or snooze');
      expect(find.widgetWithText(FilledButton, 'Xử lý'), findsNothing);
      expect(find.text('Báo cáo tuần 44: 3 chủ đầu tư quá hạn'), findsOneWidget, reason: 'it can still be read');
    });
  });

  group('the screen contract of the new home', () {
    testWidgets('three devices, 200 percent text: no overflow, tap targets, labels and contrast, with alerts of every level', (WidgetTester tester) async {
      await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/home'), healthy: _healthy);
    });

    testWidgets('every state of the screen is drawn', (WidgetTester tester) async {
      await expectEveryState(
        tester,
        open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/home'),
        script: StateScript(
          healthy: _healthy,
          content: find.text('Cần xử lý ngay'),
          empty: (ScriptedServer server) {
            server
              ..refuse('GET', '/home/command-center', 404, 'RESOURCE_NOT_FOUND')
              ..refuse('GET', '/home/my-work', 404, 'RESOURCE_NOT_FOUND');
          },
        ),
      );
    });
  });

  group('MOB-08 the officer home: what is due first', () {
    testWidgets('the alerts of the person (view mine) are first, then the groups; the empty case says there is no urgent work', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthy(server);
      await _open(tester, server, '/home/mob-08');

      expect(server.callsTo('GET', '/home/my-work').any((HttpCall call) => call.url.queryParameters['view'] == 'mine' && call.url.queryParameters['limit'] == '50'), isTrue, reason: 'the officer reads the alerts of the person');
      expect(find.text('Việc đến hạn'), findsOneWidget);
      expect(find.byType(AlertCard), findsNWidgets(4), reason: 'an officer sees up to five');
      expect(find.byTooltip('Thao tác với việc này'), findsNWidgets(4));

      final ScriptedServer empty = ScriptedServer();
      _healthy(empty, alerts: <Map<String, Object?>>[]);
      await _open(tester, empty, '/home/mob-08');
      expect(find.text('Không còn việc khẩn · đã kiểm tra lúc 10:00'), findsOneWidget);
    });

    testWidgets('three devices, 200 percent text', (WidgetTester tester) async {
      await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/home/mob-08'), healthy: _healthy);
    });
  });

  group('the number on the Thông báo tab follows getMyWorkCounts', () {
    testWidgets('it is the urgent and the to-do alerts; it is nothing, not a 0, until the server has answered', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final Completer<void> slow = Completer<void>();
      final ScriptedServer server = ScriptedServer();
      _healthy(server);
      server.answer('GET', '/home/my-work/counts', (HttpCall call) async {
        await slow.future;
        return FakeTransport.json(200, alertCounts(urgent: 2, action: 3, watch: 4));
      });
      final ProviderContainer container = await _open(tester, server, '/home');
      expect(container.read(tabBadgeProvider)[AppTab.inbox], isNull);
      expect(container.read(alertBadgeProvider), isNull);

      slow.complete();
      await tester.pumpAndSettle();
      expect(container.read(tabBadgeProvider)[AppTab.inbox], 5);
      expect(find.text('5'), findsOneWidget, reason: 'the badge of the tab');
      expect(server.callsTo('GET', '/home/my-work/counts').single.url.queryParameters['view'], 'mine');
    });

    testWidgets('a server that fails keeps the last number and invents none; an old server without levels shows none', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthy(server);
      server.refuse('GET', '/home/my-work/counts', 500, 'INTERNAL_ERROR');
      final ProviderContainer container = await _open(tester, server, '/home');
      expect(container.read(tabBadgeProvider)[AppTab.inbox], isNull);

      server.on('GET', '/home/my-work/counts', (_) => <String, Object?>{'counts': <String, Object?>{'total': 3}});
      container.read(alertsChangedProvider.notifier).bump();
      await tester.pumpAndSettle();
      expect(container.read(tabBadgeProvider)[AppTab.inbox], isNull);
    });

    testWidgets('it is read again when the app comes back, when a push arrives and when an alert was taken', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final StreamController<void> pushes = StreamController<void>.broadcast();
      addTearDown(pushes.close);
      int urgent = 1;
      final ScriptedServer server = ScriptedServer();
      _healthy(server);
      server.on('GET', '/home/my-work/counts', (_) => alertCounts(urgent: urgent));
      final ProviderContainer container = await pumpWithServer(
        tester,
        features: <MobileFeature>[dashboard.feature, _approvalStub],
        server: server,
        location: '/home',
        overrides: <Override>[pushArrivalsProvider.overrideWithValue(pushes.stream)],
      );
      expect(container.read(tabBadgeProvider)[AppTab.inbox], 1);
      expect(server.callsTo('GET', '/home/my-work/counts'), hasLength(1), reason: 'once when the app opens');

      urgent = 2;
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(container.read(tabBadgeProvider)[AppTab.inbox], 2, reason: 'on resume');
      expect(server.callsTo('GET', '/home/my-work/counts'), hasLength(2));

      urgent = 4;
      pushes.add(null);
      await tester.pumpAndSettle();
      expect(container.read(tabBadgeProvider)[AppTab.inbox], 4, reason: 'when a push arrives');
      expect(server.callsTo('GET', '/home/my-work/counts'), hasLength(3));
      expect(server.callsTo('GET', '/home/my-work').length, greaterThan(1), reason: 'the list follows the push too');
    });
  });
}

