import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/core/sync/sync_status.dart';
import 'package:machvon_mobile/features/command_support/command_outcome.dart';
import 'package:machvon_mobile/features/payment_tracking/payment_models.dart';
import 'package:machvon_mobile/features/payment_tracking/payment_support.dart';
import 'package:machvon_mobile/features/payment_tracking/payment_tracking_feature.dart' as payments;
import 'package:machvon_mobile/features/payment_tracking/reconciliation_commands.dart';

import '../../support/harness.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'fixtures.dart';

const String _chain = '/projects/mob-27?project=p-1';
const String _request = '/projects/mob-27?project=p-1&request=pr-1';
const String _board = '/projects/mob-60';
const String _item = '/projects/mob-60?item=i-1';

FakeSession _accountant({SessionMode mode = SessionMode.full}) => FakeSession(SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1', membershipId: 'mem-1', mode: mode));

Future<ProviderContainer> _open(WidgetTester tester, ScriptedServer server, String location, {FakeSession? session, Locale locale = const Locale('vi'), DateTime? now}) =>
    pumpWithServer(tester, features: <MobileFeature>[payments.feature], server: server, location: location, session: session ?? _accountant(), locale: locale, now: now == null ? null : () => now);

void _reads(ScriptedServer server) {
  server
    ..on('GET', '/resources/project', (_) => page(<Object?>[project('p-1', 'DA-001', 'Đường vành đai 1')]))
    ..on('GET', '/payment-chain', (_) => chain())
    ..on('GET', '/resources/payment_request/pr-1', (_) => paymentRequest('pr-1'))
    ..on('GET', '/resources/payment_request/pr-2', (_) => paymentRequest('pr-2', no: 'PR-A-002', status: 'SETTLED', kind: 'ADVANCE', gross: '1000000000', net: '1000000000', paidOn: '2026-10-20'))
    ..on('GET', '/reconciliation-items', (_) => board(<Map<String, Object?>>[item('i-1'), item('i-2', kind: 'MISSING_CONFIRMATION', internal: '500000000', confirmed: null, difference: null, overdue: true, due: '2026-10-01T03:00:00Z'), item('i-3', status: 'RESOLVED')]))
    ..on('GET', '/reconciliation-items/i-1', (_) => item('i-1'));
}

Finder _explain() => find.widgetWithText(FilledButton, 'Ghi nhận');
Finder _note() => find.widgetWithText(TextField, 'Ghi những gì đã tìm ra');

Future<void> _tap(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder);
  await tester.pumpAndSettle();
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

Future<void> _choose(WidgetTester tester, String label) async {
  await _tap(tester, find.widgetWithText(DropdownButtonFormField<String>, 'Việc đã làm'));
  await tester.tap(find.text(label).last);
  await tester.pumpAndSettle();
}

void main() {
  group('UI-MOB-27 AC-ST-MOB-025-1 UAT-PLAN-40 MOB-27 the payment requests of a project on a timeline', () {
    testWidgets('chooses a project, lists its payment requests with status and exact amounts, and opens one', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      final ProviderContainer container = await _open(tester, server, '/projects/mob-27');

      await tester.tap(find.text('DA-001'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), _chain);
      expect(server.callsTo('GET', '/payment-chain').single.url.queryParameters, containsPair('project_id', 'p-1'));
      expect(find.text('2'), findsOneWidget);
      expect(find.text('3.350.000.000 đồng'), findsOneWidget);
      expect(find.text('1.000.000.000 đồng'), findsWidgets);
      expect(find.text('PR-A-001'), findsOneWidget);
      expect(find.text('Đã gửi Kho bạc'), findsOneWidget);
      expect(find.text('Gộp 2.350.000.000 đồng · thực nhận 2.100.000.000 đồng'), findsOneWidget);
      expect(find.text('Đã thanh toán'), findsOneWidget);
      expect(find.text('Bản nháp'), findsOneWidget);
      expect(find.text('Tạm ứng'), findsOneWidget);
      expect(find.text('Lập lúc 05/10/2026 16:00'), findsOneWidget);

      await tester.tap(find.text('PR-A-001'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), _request);
    });

    testWidgets('the contract narrows the list, and all contracts bring it back', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      await _open(tester, server, _chain);
      expect(find.text('PR-B-001'), findsOneWidget);

      await _tap(tester, find.widgetWithText(DropdownButtonFormField<String?>, 'Hợp đồng'));
      await tester.tap(find.text('HD-A-002').last);
      await tester.pumpAndSettle();
      expect(find.text('PR-B-001'), findsOneWidget);
      expect(find.text('PR-A-001'), findsNothing);

      await _tap(tester, find.widgetWithText(DropdownButtonFormField<String?>, 'Hợp đồng'));
      await tester.tap(find.text('Tất cả hợp đồng').last);
      await tester.pumpAndSettle();
      expect(find.text('PR-A-001'), findsOneWidget);
    });

    testWidgets('a chain the server cut short says so, and a project without a request says there is none', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      server.on('GET', '/payment-chain', (_) => <String, Object?>{...chain(truncated: <String>['payment_request']), 'nodes': <Object?>[node('project', 'p-1', 'DA-001', contract: null)]});
      await _open(tester, server, _chain);
      expect(find.text('Chưa có đề nghị thanh toán nào.'), findsOneWidget);
      expect(find.textContaining('Máy chủ còn nhiều bản ghi hơn số hiển thị'), findsOneWidget);
    });

    testWidgets('AC-ST-MOB-025-1 UAT-PLAN-40 the timeline of a request shows its status, its amounts as whole dong and the times the server gave, not the clock of the phone', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      // The phone says it is 2031: nothing on the screen may come from that.
      await _open(tester, server, _request, now: DateTime.utc(2031, 1, 1, 0, 0));

      expect(find.text('PR-A-001'), findsOneWidget);
      expect(find.text('Đã gửi Kho bạc'), findsOneWidget);
      expect(find.text('Thanh toán đợt'), findsOneWidget);
      expect(find.text('2.100.000.000 đồng'), findsOneWidget, reason: 'the net, all its digits, no decimals');
      expect(find.text('2.350.000.000 đồng'), findsWidgets);
      expect(find.text('150.000.000 đồng'), findsOneWidget);
      expect(find.text('100.000.000 đồng'), findsOneWidget);
      expect(find.text('05/10/2026 16:00'), findsWidgets, reason: 'drawn up and last update, in Vietnam time, from the server');
      expect(find.text('Lập đề nghị'), findsOneWidget);
      expect(find.text('Gửi đề nghị'), findsOneWidget);
      expect(find.text('Gửi hồ sơ sang Kho bạc'), findsOneWidget);
      expect(find.text('06/10/2026'), findsOneWidget);
      for (final Text text in tester.widgetList<Text>(find.byType(Text))) {
        expect(text.data, isNot(contains('2031')), reason: 'nothing comes from the clock of the phone');
        expect(text.data, isNot(matches(RegExp(r'[0-9]+[.,][0-9]+ (tỷ|triệu)'))), reason: 'amounts are not rounded');
      }
    });

    testWidgets('the timeline follows the Treasury: its confirmed transaction, the payment, the settlement', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      await _open(tester, server, '/projects/mob-27?project=p-1&request=pr-2');
      expect(find.text('Kho bạc xác nhận giao dịch CT-0201'), findsOneWidget);
      expect(find.text('20/10/2026 10:30'), findsOneWidget);
      expect(find.text('Kho bạc đã thanh toán'), findsOneWidget);
      expect(find.text('20/10/2026'), findsOneWidget);
      expect(find.text('Thuộc quyết toán FINAL 2026'), findsOneWidget);
      expect(find.text('25/10/2026 15:00'), findsWidgets);
    });

    testWidgets('a returned, reversed or cancelled request says why and when', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      server.on('GET', '/resources/payment_request/pr-1', (_) => paymentRequest('pr-1', status: 'REVERSED', reversedAt: '2026-10-28T02:00:00.000000Z', returnReason: 'Thiếu hóa đơn'));
      await _open(tester, server, _request);
      expect(find.text('Đã hoàn trả'), findsOneWidget);
      expect(find.text('Hoàn trả đề nghị'), findsOneWidget);
      expect(find.text('28/10/2026 09:00'), findsWidgets);
      expect(find.text('Lý do trả lại: Thiếu hóa đơn'), findsOneWidget);
    });

    testWidgets('a request outside the scope of the accountant is the not-found state with its code', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      server.refuse('GET', '/payment-chain', 404, 'RESOURCE_NOT_FOUND');
      await _open(tester, server, _chain);
      expect(find.text('RESOURCE_NOT_FOUND'), findsOneWidget);
      expect(find.text('PR-A-001'), findsNothing);
    });

    testWidgets('every state is drawn and the contract of the three views holds', (WidgetTester tester) async {
      for (final (String location, Finder content, bool empty) in <(String, Finder, bool)>[
        ('/projects/mob-27', find.text('DA-001'), true),
        (_chain, find.text('PR-A-001'), false),
        (_request, find.text('Số tiền (đồng nguyên)'), false),
      ]) {
        await expectEveryState(
          tester,
          open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, location),
          script: StateScript(healthy: _reads, content: content, empty: !empty ? null : (ScriptedServer server) => server.on('GET', '/resources/project', (_) => page(<Object?>[]))),
        );
        await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, location), healthy: _reads);
      }
    });
  });

  group('AC-ST-MOB-025-3 UI-MOB-60 an accountant who cannot create a payment is offered no create action, and nobody is offered one on the phone', () {
    testWidgets('the screens hold no create, revise, submit or send action, whatever the server says the caller may do', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      for (final String location in <String>['/projects/mob-27', _chain, _request]) {
        await _open(tester, server, location);
        expect(find.byType(FilledButton), findsNothing, reason: location);
        expect(find.byType(OutlinedButton), findsNothing, reason: location);
        expect(find.byType(FloatingActionButton), findsNothing, reason: location);
        for (final String word in <String>['Tạo', 'Lập đề nghị mới', 'Sửa đề nghị', 'Nộp', 'Gửi Kho bạc', 'Create', 'New payment']) {
          expect(find.textContaining(word), findsNothing, reason: '$location: $word');
        }
      }
      await _open(tester, server, _request);
      expect(find.text('Điện thoại chỉ để theo dõi: không lập, sửa hay gửi đề nghị thanh toán.'), findsOneWidget);
      expect(server.calls.where((HttpCall call) => call.method != 'GET'), isEmpty);
    });

    testWidgets('a read-only session and an english interface offer nothing either', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      await _open(tester, server, _chain, session: _accountant(mode: SessionMode.readOnly), locale: const Locale('en'));
      expect(find.byType(FilledButton), findsNothing);
      expect(find.text('Gross 2.350.000.000 dong · net 2.100.000.000 dong'), findsNothing);
      expect(find.text('Gross 2,350,000,000 dong · net 2,100,000,000 dong'), findsOneWidget);
      expect(find.text('Sent to the Treasury'), findsOneWidget);
    });
  });

  group('UI-MOB-60 AC-ST-MOB-025-2 UAT-AC12 MOB-60 the Treasury reconciliation items', () {
    testWidgets('lists what waits with the count and the sum the server gave, the late ones first, each with its two figures and the difference', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      final ProviderContainer container = await _open(tester, server, _board);

      expect(find.text('Số hạng mục chờ:'), findsOneWidget);
      expect(find.text('2'), findsOneWidget);
      expect(find.text('-10.000.000 đồng'), findsWidgets);
      expect(tester.getTopLeft(find.text('Thiếu xác nhận')).dy, lessThan(tester.getTopLeft(find.text('Lệch số tiền')).dy), reason: 'the late one first');
      expect(find.text('Quá hạn'), findsOneWidget);
      expect(find.text('Số nội bộ 1.000.000.000 đồng · Kho bạc xác nhận 990.000.000 đồng · chênh lệch -10.000.000 đồng'), findsOneWidget);
      expect(find.text('Số nội bộ 500.000.000 đồng · Kho bạc xác nhận chưa có số · chênh lệch chưa có số'), findsOneWidget);
      expect(find.text('DA-001 · PR-A-002 · CT-0201'), findsNWidgets(2));
      expect(find.text('Đã xử lý xong'), findsNothing, reason: 'only what waits, by default');

      await tester.tap(find.text('Chỉ hạng mục đang chờ'));
      await tester.pumpAndSettle();
      expect(find.text('Đã xử lý xong'), findsOneWidget);

      await tester.tap(find.text('Lệch số tiền').first);
      await tester.pumpAndSettle();
      expect(currentLocation(container), _item);
    });

    testWidgets('clearing the filter brings the list back when nothing waits', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      server.on('GET', '/reconciliation-items', (_) => board(<Map<String, Object?>>[item('i-3', status: 'RESOLVED')], waiting: 0, overdue: 0, difference: '0'));
      await _open(tester, server, _board);
      expect(find.text('Chưa có dữ liệu'), findsOneWidget);
      await tester.tap(find.text('Xóa bộ lọc'));
      await tester.pumpAndSettle();
      expect(find.text('Đã xử lý xong'), findsOneWidget);
    });

    testWidgets('AC-ST-MOB-025-2 UAT-AC12 an internal amount that differs from the Treasury-confirmed one is shown with both amounts and the difference, and no figure is chosen', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      await _open(tester, server, _item);

      expect(find.text('Lệch số tiền'), findsOneWidget);
      expect(find.text('Số nội bộ:'), findsOneWidget);
      expect(find.text('1.000.000.000 đồng'), findsOneWidget);
      expect(find.text('Số Kho bạc xác nhận:'), findsOneWidget);
      expect(find.text('990.000.000 đồng'), findsOneWidget);
      expect(find.text('Chênh lệch (xác nhận trừ nội bộ):'), findsOneWidget);
      expect(find.text('-10.000.000 đồng'), findsOneWidget);
      expect(find.text('Kho bạc xác nhận ít hơn số nội bộ.'), findsOneWidget);
      expect(find.text('Điện thoại không chọn số nào và không sửa số nào: cả hai số và chênh lệch giữ nguyên như đã ghi nhận.'), findsOneWidget);
      expect(find.text('DA-001'), findsOneWidget);
      expect(find.text('PR-A-002'), findsOneWidget);
      expect(find.text('CT-0201'), findsOneWidget);
      expect(find.text('Trần Kế Toán Trưởng'), findsOneWidget);
      expect(find.text('10/11/2026 10:00'), findsOneWidget);
      for (final String word in <String>['Dùng', 'Chọn số', 'Lấy số', 'lớn hơn', 'Use ', 'larger']) {
        expect(find.textContaining(word), findsNothing, reason: word);
      }
      expect(find.byType(Radio<String>), findsNothing);
      expect(find.byType(Checkbox), findsNothing);
    });

    testWidgets('an item with only one of the two figures says the other is not there, and gives no difference of its own', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      server.on('GET', '/reconciliation-items/i-1', (_) => item('i-1', kind: 'UNMATCHED_TRANSACTION', internal: null, confirmed: '990000000', difference: null));
      await _open(tester, server, _item);
      expect(find.text('chưa có số'), findsNWidgets(2), reason: 'the internal figure and the difference');
      expect(find.text('Chưa đủ hai số để có chênh lệch.'), findsOneWidget);
      expect(find.text('990.000.000 đồng'), findsOneWidget);
    });

    testWidgets('equal figures and a surplus at the Treasury are worded', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      server.on('GET', '/reconciliation-items/i-1', (_) => item('i-1', internal: '5', confirmed: '5', difference: '0'));
      await _open(tester, server, _item);
      expect(find.text('Hai số bằng nhau.'), findsOneWidget);
      server.on('GET', '/reconciliation-items/i-1', (_) => item('i-1', internal: '5', confirmed: '9', difference: '4'));
      await _open(tester, server, _item);
      expect(find.text('Kho bạc xác nhận nhiều hơn số nội bộ.'), findsOneWidget);
    });

    testWidgets('a closed item shows its note and offers nothing to write', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      server.on('GET', '/reconciliation-items/i-1', (_) => item('i-1', status: 'RESOLVED', note: 'Kho bạc trừ phí 10.000.000 theo thông báo TB-77'));
      await _open(tester, server, _item);
      expect(find.text('Kho bạc trừ phí 10.000.000 theo thông báo TB-77'), findsOneWidget);
      expect(find.text('Ghi giải trình'), findsNothing);
    });

    testWidgets('every state is drawn and the contract of the board and of the item holds', (WidgetTester tester) async {
      for (final (String location, Finder content, bool empty) in <(String, Finder, bool)>[
        (_board, find.text('Lệch số tiền'), true),
        (_item, find.text('Hai con số và chênh lệch'), false),
      ]) {
        await expectEveryState(
          tester,
          open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, location),
          script: StateScript(healthy: _reads, content: content, empty: !empty ? null : (ScriptedServer server) => server.on('GET', '/reconciliation-items', (_) => board(<Map<String, Object?>>[], waiting: 0, overdue: 0, difference: '0'))),
        );
        await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, location), healthy: _reads);
      }
    });
  });

  group('TK-MOB-025-2 explaining a difference: online, under the version of the item, without changing a figure', () {
    testWidgets('a note is required, and the command is one request under the version with the note trimmed; the figures stay', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      server.answer('POST', '/reconciliation-items/i-1/resolve', (_) => recorded('i-1', version: 5, status: 'EXPLAINED'));
      await _open(tester, server, _item);

      await _tap(tester, _explain());
      expect(find.text('Hãy chọn việc đã làm.'), findsOneWidget);
      expect(find.text('Cần ghi những gì đã tìm ra.'), findsOneWidget);
      expect(server.calls.where((HttpCall call) => call.method == 'POST'), isEmpty);

      await _choose(tester, 'Giải trình nguyên nhân chênh lệch');
      await tester.enterText(_note(), '  Kho bạc trừ phí 10.000.000 theo thông báo TB-77  ');
      await _tap(tester, _explain());

      final HttpCall call = server.callsTo('POST', '/reconciliation-items/i-1/resolve').single;
      expect(call.headers['if-match'], '"4"');
      expect(call.headers['idempotency-key'], isNotEmpty);
      expect(call.body, '{"resolution":"EXPLAINED","note":"Kho bạc trừ phí 10.000.000 theo thông báo TB-77"}');
      expect(find.text('Đã ghi nhận'), findsOneWidget);
      expect(find.text('1.000.000.000 đồng'), findsOneWidget);
      expect(find.text('990.000.000 đồng'), findsOneWidget);
      expect(find.text('-10.000.000 đồng'), findsOneWidget);
    });

    testWidgets('only what the server offers is offered: no explain means no explanation, and an item that waits for nothing has no form', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      server.on('GET', '/reconciliation-items/i-1', (_) => item('i-1', explain: false, resolve: false));
      await _open(tester, server, _item);
      expect(find.text('Ghi giải trình'), findsNothing);

      server.on('GET', '/reconciliation-items/i-1', (_) => item('i-1', explain: true, resolve: false));
      await _open(tester, server, _item);
      await _tap(tester, find.widgetWithText(DropdownButtonFormField<String>, 'Việc đã làm'));
      expect(find.text('Giải trình nguyên nhân chênh lệch'), findsWidgets);
      expect(find.text('Đã xử lý xong chênh lệch'), findsNothing);
    });

    testWidgets('offline, on a copy, the button is disabled with the reason, nothing is queued or sent; a read-only organisation says so', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      final ProviderContainer container = await _open(tester, server, _item);
      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();
      expect(container.read(reachabilityProvider), Reachability.offline);
      expect(find.textContaining('Cần kết nối mạng để ghi giải trình'), findsOneWidget);
      expect(tester.widget<FilledButton>(_explain()).onPressed, isNull);
      expect(container.read(syncStatusProvider).pendingCommands, 0);
      server.offline = false;
      expect(server.calls.where((HttpCall call) => call.method == 'POST'), isEmpty);

      final ScriptedServer other = ScriptedServer();
      _reads(other);
      await _open(tester, other, _item, session: _accountant(mode: SessionMode.readOnly));
      expect(find.text('Tổ chức đang ở chế độ chỉ đọc nên chưa ghi được.'), findsOneWidget);
      expect(tester.widget<FilledButton>(_explain()).onPressed, isNull);
    });

    testWidgets('a lost answer is "result unknown": sending it again reuses the key and the version', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      int attempt = 0;
      server.answer('POST', '/reconciliation-items/i-1/resolve', (_) {
        attempt += 1;
        if (attempt == 1) throw const SocketException('lost');
        return recorded('i-1', version: 5, status: 'EXPLAINED');
      });
      await _open(tester, server, _item);
      await _choose(tester, 'Giải trình nguyên nhân chênh lệch');
      await tester.enterText(_note(), 'Phí');
      await _tap(tester, _explain());
      expect(find.text('Chưa xác định kết quả'), findsOneWidget);
      await _tap(tester, find.text('Gửi lại cùng thao tác'));
      final List<HttpCall> calls = server.callsTo('POST', '/reconciliation-items/i-1/resolve');
      expect(calls, hasLength(2));
      expect(calls[1].headers['idempotency-key'], calls[0].headers['idempotency-key']);
      expect(calls[1].headers['if-match'], calls[0].headers['if-match']);
      expect(find.text('Đã ghi nhận'), findsOneWidget);
    });

    testWidgets('the refusals each have their words and the code', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final Map<String, String> expected = <String, String>{
        'RECONCILIATION_STATE_INVALID': 'Hạng mục chênh lệch không còn ở trạng thái cho phép việc này.',
        'APPROVAL_REQUIRED': 'Xóa sổ chênh lệch cần văn bản phê duyệt; việc này chỉ làm trên máy tính.',
        'SELF_APPROVAL_DENIED': 'Chủ xử lý không được tự xóa sổ chênh lệch của mình. Người khác phải làm.',
        'VERSION_CONFLICT': 'Có người đã thay đổi trong lúc đó. Hãy mở lại để đọc lại.',
        'MFA_REQUIRED': 'Cần xác thực lại hai yếu tố. Chưa ghi nhận gì; hãy hoàn tất bước xác thực rồi thử lại.',
        'LICENSE_EXPIRED': 'License đã hết hạn nên chưa ghi được.',
        'VALIDATION_FAILED': 'Có thông tin nhập chưa đúng. Chưa thay đổi gì.',
        'RESOURCE_NOT_FOUND': 'Hạng mục này không còn với bạn.',
        'SCOPE_DENIED': 'Bạn không có quyền làm việc này ở đây.',
        'SESSION_EXPIRED': 'Phiên làm việc đã hết. Hãy đăng nhập lại.',
        'BOOM': 'Đã có lỗi. Chưa thay đổi gì.',
      };
      for (final MapEntry<String, String> entry in expected.entries) {
        final ScriptedServer server = ScriptedServer();
        _reads(server);
        server.answer('POST', '/reconciliation-items/i-1/resolve', (_) => problem(entry.key == 'SESSION_EXPIRED' ? 401 : 409, entry.key));
        await _open(tester, server, _item);
        await _choose(tester, 'Giải trình nguyên nhân chênh lệch');
        await tester.enterText(_note(), 'Phí');
        await _tap(tester, _explain());
        expect(find.text(entry.value), findsOneWidget, reason: entry.key);
        expect(find.text(entry.key), findsOneWidget);
      }
    });
  });

  group('the readers and rules of the payment screens, as pure functions', () {
    test('the chain: nodes, edges and totals; a chain without totals is not one', () {
      final PaymentChain parsed = parseChain(chain())!;
      expect(parsed.countedRequests, 2);
      expect(parsed.requests().map((ChainNode n) => n.label), <String>['PR-A-001', 'PR-A-002', 'PR-B-001']);
      expect(parsed.requests(contractId: 'c-2').single.label, 'PR-B-001');
      expect(parsed.linkedFrom('pr-2', 'PAID_BY').single.label, 'CT-0201');
      expect(parsed.linkedFrom('pr-1', 'PAID_BY'), isEmpty);
      expect(parsed.nodeById('zz'), isNull);
      expect(parseChain(<String, Object?>{...chain(), 'totals': <String, Object?>{'counted_requests': 1}}), isNull);
      expect(parseChain(<String, Object?>{...chain(), 'nodes': 'no'}), isNull);
      expect(parseChainNode(<String, Object?>{'type': 'payment_request'}), isNull);
      expect(parseChainNode(node('payment_request', 'x', 'X', amount: '12.5'))!.amountVnd, isNull, reason: 'money is a string of whole dong');
    });

    test('the timeline keeps the process order, leaves out a moment the server did not record, and takes the latest instant', () {
      final PaymentChain parsed = parseChain(chain())!;
      final PaymentTimeline timeline = timelineOf(parsePaymentRequest(paymentRequest('pr-2', no: 'PR-A-002', status: 'SETTLED', kind: 'ADVANCE', paidOn: '2026-10-20'))!, parsed);
      expect(timeline.events.map((TimelineEvent e) => e.kind), <String>['created', 'submitted', 'sentTreasury', 'transaction', 'paid', 'settlement']);
      expect(timeline.lastEventAt, '2026-10-25T08:00:00.000000Z');
      final PaymentTimeline plain = timelineOf(parsePaymentRequest(<String, Object?>{...paymentRequest('pr-1'), 'created_at': null, 'submitted_at': null, 'treasury_submitted_on': null})!, parsed);
      expect(plain.events, isEmpty);
      expect(plain.lastEventAt, isNull);
      final Map<String, Object?> withRefund = chain(extraNodes: <Map<String, Object?>>[node('treasury_transaction', 't-9', 'CT-9', amount: '5', facts: <String, Object?>{'direction': 'REFUND', 'confirmed_at': 'not a date'})]);
      (withRefund['edges']! as List<Object?>).add(<String, Object?>{'from': 'pr-1', 'to': 't-9', 'relation': 'PAID_BY'});
      final PaymentTimeline refund = timelineOf(parsePaymentRequest(paymentRequest('pr-1'))!, parseChain(withRefund)!);
      expect(refund.events.map((TimelineEvent e) => e.kind), <String>['created', 'submitted', 'sentTreasury', 'refund']);
      expect(refund.lastEventAt, '2026-10-05T10:00:00.000000Z', reason: 'a moment that is not a date is not a moment');
      expect(parsePaymentTimeline(<String, Object?>{'chain': chain(), 'request': <String, Object?>{'id': 'x'}}), isNull);
    });

    test('a payment request needs its status, kind and amounts; a reconciliation item its kind, status, due time and version', () {
      expect(parsePaymentRequest(<String, Object?>{...paymentRequest('pr-1'), 'status': 'WEIRD'}), isNull);
      expect(parsePaymentRequest(<String, Object?>{...paymentRequest('pr-1'), 'gross_vnd': '1.5'}), isNull);
      expect(parsePaymentRequest(paymentRequest('pr-1'))!.netVnd, '2100000000');
      expect(parseReconciliationItem(<String, Object?>{...item('i'), 'kind': 'NOPE'}), isNull);
      expect(parseReconciliationItem(<String, Object?>{...item('i'), 'version': null}), isNull);
      expect(parseReconciliationBoard(<String, Object?>{'items': 'no'}), isNull);
      final ReconciliationBoard? parsed = parseReconciliationBoard(board(<Map<String, Object?>>[item('b', due: '2026-11-12T00:00:00Z'), item('a', due: '2026-11-11T00:00:00Z'), item('c', overdue: true, due: '2026-12-01T00:00:00Z')], next: 'c2'));
      expect(parsed!.items.map((ReconciliationItem i) => i.id), <String>['c', 'a', 'b'], reason: 'the late first, then by due time');
      expect(parsed.more, isTrue);
      expect(parsed.waitingDifferenceVnd, '-10000000');
    });

    test('the difference is the one the server gave; without it, the confirmed figure less the internal one on whole dong', () {
      expect(parseReconciliationItem(item('i', internal: '5', confirmed: '9', difference: null))!.shownDifference, '4');
      expect(parseReconciliationItem(item('i', internal: '9', confirmed: '5', difference: null))!.shownDifference, '-4');
      expect(parseReconciliationItem(item('i', internal: '5', confirmed: '9', difference: '3'))!.shownDifference, '3', reason: 'the server\'s own');
      expect(parseReconciliationItem(item('i', internal: null, confirmed: '9', difference: null))!.shownDifference, isNull);
      expect(parseReconciliationItem(item('i', internal: '123456789012345678901234', confirmed: '123456789012345678901235', difference: null))!.shownDifference, '1');
    });

    test('the note rules and the gate', () {
      expect(checkResolution(resolution: 'EXPLAINED', note: 'Phí'), isEmpty);
      expect(checkResolution(resolution: null, note: 'Phí')['resolution'], ResolveProblem.resolutionRequired);
      expect(checkResolution(resolution: 'WRITTEN_OFF', note: 'Phí')['resolution'], ResolveProblem.resolutionRequired, reason: 'writing off stays on the web');
      expect(checkResolution(resolution: 'RESOLVED', note: '  ')['note'], ResolveProblem.noteRequired);
      expect(checkResolution(resolution: 'RESOLVED', note: 'x' * 2001)['note'], ResolveProblem.noteTooLong);
      expect(checkResolution(resolution: 'RESOLVED', note: 'x' * 2000), isEmpty);
      const SessionSnapshot full = SessionSnapshot(status: SessionStatus.signedIn, tenantId: 't', userId: 'u');
      const SessionSnapshot readOnly = SessionSnapshot(status: SessionStatus.signedIn, tenantId: 't', userId: 'u', mode: SessionMode.readOnly);
      expect(gateOf(offline: false, fromCopy: false, session: full), ReconGate.open);
      expect(gateOf(offline: true, fromCopy: false, session: readOnly), ReconGate.offline);
      expect(gateOf(offline: false, fromCopy: true, session: full), ReconGate.offline);
      expect(gateOf(offline: false, fromCopy: false, session: readOnly), ReconGate.readOnly);
      ReconciliationProblem of(String code) => problemOf(CommandRefused(code));
      expect(of('RECONCILIATION_STATE_INVALID'), ReconciliationProblem.itemState);
      expect(of('INVALID_REQUEST'), ReconciliationProblem.validation);
      expect(of('PERMISSION_DENIED'), ReconciliationProblem.denied);
      expect(of('ENTITLEMENT_DENIED'), ReconciliationProblem.denied);
    });

    test('the command is never sent offline and a lost answer is sent again under the same key', () async {
      final ScriptedServer server = ScriptedServer();
      int attempt = 0;
      server.answer('POST', '/reconciliation-items/i-1/resolve', (_) {
        attempt += 1;
        if (attempt == 1) throw const SocketException('lost');
        return recorded('i-1');
      });
      bool online = false;
      final ReconciliationCommands commands = ReconciliationCommands(client: MachvonApiClient(baseUrl: Uri.parse('https://api.test/v1'), transport: server, token: () async => 't'), isOnline: () => online);
      const ResolveRequest request = ResolveRequest(itemId: 'i-1', version: 4, resolution: 'EXPLAINED', note: ' Phí ');
      expect(await commands.resolve(request), isA<CommandOffline>());
      expect(server.calls, isEmpty);
      online = true;
      expect(await commands.resolve(request), isA<CommandUnknown>());
      expect(await commands.resolve(request, retryAfterUnknown: true), isA<CommandDone>());
      final List<HttpCall> calls = server.callsTo('POST', '/reconciliation-items/i-1/resolve');
      expect(calls[1].headers['idempotency-key'], calls[0].headers['idempotency-key']);

      // An answer is lost under version 4; the item then moves on, and what the person sends under version 5 is another intention.
      server.answer('POST', '/reconciliation-items/i-1/resolve', (_) => throw const SocketException('lost'));
      await commands.resolve(const ResolveRequest(itemId: 'i-1', version: 4, resolution: 'EXPLAINED', note: 'Phí'));
      await commands.resolve(const ResolveRequest(itemId: 'i-1', version: 5, resolution: 'EXPLAINED', note: 'Phí'));
      final List<HttpCall> after = server.callsTo('POST', '/reconciliation-items/i-1/resolve');
      expect(after[after.length - 2].headers['if-match'], '"4"');
      expect(after.last.headers['if-match'], '"5"');
      expect(after.last.headers['idempotency-key'], isNot(after[after.length - 2].headers['idempotency-key']));
    });
  });
}
