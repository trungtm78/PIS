import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/core/sync/sync_status.dart';
import 'package:machvon_mobile/features/acceptance_handover/acceptance_commands.dart';
import 'package:machvon_mobile/features/acceptance_handover/acceptance_handover_feature.dart' as acceptance;
import 'package:machvon_mobile/features/acceptance_handover/acceptance_models.dart';
import 'package:machvon_mobile/features/acceptance_handover/acceptance_support.dart';
import 'package:machvon_mobile/features/command_support/command_outcome.dart';

import '../../support/harness.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'fixtures.dart';

const String _detail = '/approval/mob-65?acceptance=qa-1';

Future<ProviderContainer> _open(WidgetTester tester, ScriptedServer server, String location, {FakeSession? session, Locale locale = const Locale('vi')}) =>
    pumpWithServer(tester, features: <MobileFeature>[acceptance.feature], server: server, location: location, session: session, locale: locale);

void _reads(ScriptedServer server, {Map<String, Object?>? line}) {
  final Map<String, Object?> one = line ?? minutes();
  server
    ..on('GET', '/quality-acceptances', (_) => minutesPage(<Map<String, Object?>>[one]))
    ..on('GET', '/quality-acceptances/qa-1', (_) => one);
}

List<HttpCall> _posts(ScriptedServer server, String path) => server.callsTo('POST', path);

Finder _approve() => find.widgetWithText(FilledButton, 'Duyệt biên bản');
Finder _reject() => find.widgetWithText(OutlinedButton, 'Từ chối biên bản');
/// Presses a decision or a signature, then confirms it in the sheet that says what it does (nothing is sent before the confirmation).
Future<void> _decideAndConfirm(WidgetTester tester, Finder action, String confirmLabel) async {
  await tester.tap(action);
  await tester.pumpAndSettle();
  await tester.tap(find.widgetWithText(FilledButton, confirmLabel));
  await tester.pumpAndSettle();
}

Finder _opinion() => find.widgetWithText(TextField, 'Ý kiến của bạn (bắt buộc)');

void main() {
  group('UI-MOB-65 MOB-65 the minutes waiting for the person', () {
    testWidgets('lists the minutes that wait for signatures or a decision, those the person can act on first, and opens one', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      server.on(
        'GET',
        '/quality-acceptances',
        (_) => minutesPage(<Map<String, Object?>>[
          minutes(id: 'qa-2', recordNo: 'QA-W-002', canApprove: false, canReject: false),
          minutes(id: 'qa-3', recordNo: 'QA-W-003', status: 'APPROVED', missing: const <String>[]),
          minutes(id: 'qa-1', recordNo: 'QA-W-009'),
        ]),
      );
      server.on('GET', '/quality-acceptances/qa-1', (_) => minutes());
      final ProviderContainer container = await _open(tester, server, '/approval/mob-65');

      expect(find.text('QA-W-003'), findsNothing, reason: 'approved minutes no longer wait for anyone');
      expect(tester.getTopLeft(find.text('QA-W-009')).dy, lessThan(tester.getTopLeft(find.text('QA-W-002')).dy), reason: 'the one the person can act on comes first, whatever its number');
      expect(find.text('Chờ bạn xử lý'), findsOneWidget);
      expect(find.text('Còn thiếu chữ ký: Chủ đầu tư'), findsWidgets);

      await tester.tap(find.text('QA-W-009'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), _detail);
      expect(find.text('Duyệt nghiệm thu'), findsWidgets);
      expect(server.calls.where((HttpCall call) => call.method != 'GET'), isEmpty, reason: 'opening a record sends no command');
    });

    testWidgets('shows the minutes, the work they accept and who signed with what each signature is worth', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server, line: minutes(signatures: <Map<String, Object?>>[signature('CONTRACTOR', method: 'DIGITAL_CERT', name: 'Lê Nhà Thầu', serial: 'SN-0099'), signature('SUPERVISOR')]));
      await _open(tester, server, _detail);

      expect(find.text('QA-W-001'), findsOneWidget);
      expect(find.text('HD-A-001'), findsOneWidget);
      expect(find.text('INS-A-001'), findsOneWidget);
      expect(find.text('Phạm Chuyên Viên'), findsOneWidget);
      expect(find.text('B02'), findsOneWidget);
      expect(find.text('Công việc'), findsOneWidget);
      expect(find.text('Nhà thầu: Lê Nhà Thầu đã ký lúc 02/11/2026 10:00, Chứng thư số. Chữ ký số hợp lệ.'), findsOneWidget);
      expect(find.text('Tư vấn giám sát: Trần Giám Sát đã ký lúc 02/11/2026 10:00, Xác nhận OTP. Xác nhận nội bộ (không phải chữ ký số).'), findsOneWidget);
      expect(find.text('Chủ đầu tư: chưa ký.'), findsOneWidget);
      expect(find.text('Còn thiếu chữ ký: Chủ đầu tư.'), findsOneWidget);
      expect(find.text('9a1c3e55'), findsOneWidget, reason: 'the paper is named by the start of its code');
    });

    testWidgets('a signature over other content is void, open serious non-conformances and an unconfirmed regime are said', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server, line: minutes(signatures: <Map<String, Object?>>[signature('SUPERVISOR', valid: false)], ncr: 2, boq: null, note: 'Đề nghị bổ sung nhật ký'));
      await _open(tester, server, _detail);

      expect(find.text('Tư vấn giám sát: chữ ký không còn hiệu lực vì nội dung đã thay đổi.'), findsOneWidget);
      expect(find.text('Nhà thầu: chưa ký.'), findsOneWidget);
      expect(find.text('Còn 2 NCR nghiêm trọng chưa đóng: chưa duyệt được.'), findsOneWidget);
      expect(find.text('Biên bản này không gắn với một hạng mục khối lượng riêng.'), findsOneWidget);
      expect(find.text('Ý kiến đã ghi: Đề nghị bổ sung nhật ký'), findsOneWidget);
    });

    testWidgets('every state is drawn and the contract of both views holds', (WidgetTester tester) async {
      await expectEveryState(
        tester,
        open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, _detail),
        script: StateScript(healthy: _reads, content: find.text('QA-W-001')),
      );
      await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, _detail), healthy: _reads);
      await expectEveryState(
        tester,
        open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/approval/mob-65'),
        script: StateScript(healthy: _reads, content: find.text('QA-W-001'), empty: (ScriptedServer server) => server.on('GET', '/quality-acceptances', (_) => minutesPage(<Map<String, Object?>>[]))),
      );
      await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/approval/mob-65'), healthy: _reads);
    });
  });

  group('AC-ST-MOB-022-1 UAT-PLAN-36 UI-MOB-65 offline the decision is disabled and nothing is queued', () {
    testWidgets('offline, on a copy, the approve and reject buttons are disabled with the reason beside them, nothing is queued and nothing is sent', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      final ProviderContainer container = await _open(tester, server, _detail);
      expect(tester.widget<FilledButton>(_approve()).onPressed, isNotNull, reason: 'online it is offered');

      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();

      expect(container.read(reachabilityProvider), Reachability.offline);
      expect(find.textContaining('Đang hiển thị dữ liệu đã lưu trên máy'), findsOneWidget);
      expect(find.text('Cần kết nối mạng để ký hoặc duyệt. Ký và duyệt không bao giờ được xếp hàng đợi hay gửi từ bản lưu trên máy.'), findsOneWidget);
      expect(tester.widget<FilledButton>(_approve()).onPressed, isNull);
      expect(tester.widget<OutlinedButton>(_reject()).onPressed, isNull);
      await tester.enterText(_opinion(), 'Đồng ý');
      await tester.tap(_approve(), warnIfMissed: false);
      await tester.pumpAndSettle();
      expect(container.read(syncStatusProvider).pendingCommands, 0, reason: 'the offline queue holds no acceptance');
      server.offline = false;
      expect(server.calls.where((HttpCall call) => call.method == 'POST'), isEmpty);
    });

    testWidgets('the gate follows the connection under a live screen, and a copy keeps the buttons off when the connection comes back', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      final ProviderContainer container = await _open(tester, server, _detail);

      container.read(reachabilityProvider.notifier).report(Reachability.offline);
      await tester.pumpAndSettle();
      expect(tester.widget<FilledButton>(_approve()).onPressed, isNull);

      container.read(reachabilityProvider.notifier).report(Reachability.online);
      await tester.pumpAndSettle();
      expect(tester.widget<FilledButton>(_approve()).onPressed, isNotNull);

      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();
      container.read(reachabilityProvider.notifier).report(Reachability.online);
      await tester.pumpAndSettle();
      expect(tester.widget<FilledButton>(_approve()).onPressed, isNull, reason: 'a copy of the minutes never decides');
    });

    testWidgets('a read-only organisation, minutes already decided and a person with nothing to do each say why there is no action', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      ScriptedServer server = ScriptedServer();
      _reads(server);
      await _open(tester, server, _detail, session: FakeSession(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1', mode: SessionMode.readOnly)));
      expect(find.text('Tổ chức đang ở chế độ chỉ đọc nên chưa thể ký hoặc duyệt.'), findsOneWidget);
      expect(tester.widget<FilledButton>(_approve()).onPressed, isNull);

      server = ScriptedServer();
      _reads(server, line: minutes(status: 'APPROVED', missing: const <String>[], canApprove: false, canReject: false));
      await _open(tester, server, _detail);
      expect(find.text('Biên bản này không còn chờ ký hay chờ quyết định.'), findsOneWidget);
      expect(_approve(), findsNothing);
      expect(find.text('Đã duyệt'), findsWidgets);

      server = ScriptedServer();
      _reads(server, line: minutes(canApprove: false, canReject: false));
      await _open(tester, server, _detail);
      expect(find.textContaining('Bạn không có thao tác nào trên biên bản này'), findsOneWidget);
      expect(_approve(), findsNothing);
      expect(_opinion(), findsNothing);
    });

    test('the gate puts offline and copies before everything, then the state, then the read-only mode, then the right', () {
      final Minutes open = parseMinutes(minutes())!;
      final Minutes closed = parseMinutes(minutes(status: 'REVOKED'))!;
      const SessionSnapshot full = SessionSnapshot(status: SessionStatus.signedIn, tenantId: 't', userId: 'u');
      const SessionSnapshot readOnly = SessionSnapshot(status: SessionStatus.signedIn, tenantId: 't', userId: 'u', mode: SessionMode.readOnly);
      AcceptanceGate gate(Minutes m, {bool allowed = true, bool offline = false, bool copy = false, SessionSnapshot session = full}) =>
          gateOf(minutes: m, allowed: allowed, offline: offline, fromCopy: copy, session: session);
      expect(gate(open), AcceptanceGate.open);
      expect(gate(closed, offline: true), AcceptanceGate.offline);
      expect(gate(open, copy: true), AcceptanceGate.offline);
      expect(gate(closed), AcceptanceGate.notOpen);
      expect(gate(open, session: readOnly, allowed: false), AcceptanceGate.readOnly);
      expect(gate(open, allowed: false), AcceptanceGate.notAllowed);
    });
  });

  group('AC-ST-MOB-022-2 UAT-AC360 the server refuses an approval with signers missing and the screen lists the roles', () {
    testWidgets('approving with a role missing is refused, the missing roles are listed, the opinion stays and nothing is recorded', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      server.answer('POST', '/quality-acceptances/qa-1/decision', (_) => problem(422, 'SIGNATURES_INCOMPLETE', extra: <String, Object?>{'missing_roles': <String>['OWNER', 'DESIGNER']}));
      await _open(tester, server, _detail);

      await tester.enterText(_opinion(), 'Đồng ý nghiệm thu');
      await _decideAndConfirm(tester, _approve(), 'Xác nhận duyệt');

      expect(_posts(server, '/quality-acceptances/qa-1/decision'), hasLength(1));
      expect(find.text('Chưa đủ chữ ký, còn thiếu: Chủ đầu tư, Tư vấn thiết kế.'), findsOneWidget);
      expect(find.text('SIGNATURES_INCOMPLETE'), findsOneWidget);
      expect(find.text('Đã ghi nhận'), findsNothing);
      expect(tester.widget<TextField>(_opinion()).controller!.text, 'Đồng ý nghiệm thu', reason: 'what the person wrote is still there');
      expect(_approve(), findsOneWidget);
    });

    testWidgets('a refusal without the roles says the signatures are not complete', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      server.answer('POST', '/quality-acceptances/qa-1/decision', (_) => problem(422, 'SIGNATURES_INCOMPLETE'));
      await _open(tester, server, _detail);
      await tester.enterText(_opinion(), 'Đồng ý');
      await _decideAndConfirm(tester, _approve(), 'Xác nhận duyệt');
      expect(find.text('Chưa đủ chữ ký theo quy chế.'), findsOneWidget);
    });

    testWidgets('an opinion is required before anything is sent, for both decisions', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      await _open(tester, server, _detail);

      await tester.tap(_approve());
      await tester.pumpAndSettle();
      expect(find.text('Hãy nhập ý kiến của bạn.'), findsOneWidget);
      await tester.tap(_reject());
      await tester.pumpAndSettle();
      expect(find.text('Hãy nhập ý kiến của bạn.'), findsOneWidget);
      await tester.enterText(_opinion(), 'x' * 2001);
      await tester.tap(_approve());
      await tester.pumpAndSettle();
      expect(find.text('Ý kiến quá dài (tối đa 2000 ký tự).'), findsOneWidget);
      expect(server.calls.where((HttpCall call) => call.method == 'POST'), isEmpty);
    });

    testWidgets('an approval is one request under the version on the screen, then the minutes are read again and the form is cleared', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      int reads = 0;
      server.on('GET', '/quality-acceptances/qa-1', (_) {
        reads += 1;
        return reads == 1 ? minutes() : minutes(status: 'APPROVED', version: 4, missing: const <String>[], canApprove: false, canReject: false, note: 'Đồng ý nghiệm thu');
      });
      server.answer('POST', '/quality-acceptances/qa-1/decision', (_) => recorded('qa-1'));
      await _open(tester, server, _detail);

      await tester.enterText(_opinion(), '  Đồng ý nghiệm thu  ');
      await _decideAndConfirm(tester, _approve(), 'Xác nhận duyệt');

      final List<HttpCall> calls = _posts(server, '/quality-acceptances/qa-1/decision');
      expect(calls, hasLength(1));
      expect(calls.single.headers['if-match'], '"3"');
      expect(calls.single.headers['idempotency-key'], isNotEmpty);
      expect(calls.single.body, contains('"decision":"approve"'));
      expect(calls.single.body, contains('"reason":"Đồng ý nghiệm thu"'));
      expect(find.text('Đã ghi nhận'), findsOneWidget);
      expect(reads, 2, reason: 'the minutes are read again from the server');
      expect(find.text('Biên bản này không còn chờ ký hay chờ quyết định.'), findsOneWidget);
      expect(find.text('Ý kiến đã ghi: Đồng ý nghiệm thu'), findsOneWidget);
    });

    testWidgets('rejecting sends the rejection with the reason', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      server.answer('POST', '/quality-acceptances/qa-1/decision', (_) => recorded('qa-1', status: 'REJECTED'));
      await _open(tester, server, _detail);
      await tester.enterText(_opinion(), 'Thiếu biên bản thử nghiệm');
      await _decideAndConfirm(tester, _reject(), 'Xác nhận từ chối');
      expect(_posts(server, '/quality-acceptances/qa-1/decision').single.body, contains('"decision":"reject"'));
    });

    testWidgets('the sheet says what the decision does and under whose name it is written; "review again" closes it and sends nothing', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      await _open(tester, server, _detail);
      await tester.enterText(_opinion(), 'Đồng ý nghiệm thu');
      await tester.tap(_approve());
      await tester.pumpAndSettle();

      expect(find.text('Xác nhận duyệt biên bản'), findsOneWidget);
      expect(find.text('Biên bản QA-W-001, hợp đồng HD-A-001'), findsOneWidget);
      expect(find.text('Chữ ký đã có: 2/3'), findsOneWidget);
      expect(find.text('Ý kiến của bạn: Đồng ý nghiệm thu'), findsOneWidget);
      expect(find.text('Biên bản sẽ chuyển sang trạng thái: Đã duyệt'), findsOneWidget);
      expect(find.text('Thao tác được ghi vào nhật ký kiểm toán dưới tên bạn.'), findsOneWidget);
      await tester.tap(find.widgetWithText(OutlinedButton, 'Xem lại'));
      await tester.pumpAndSettle();
      expect(find.text('Xác nhận duyệt biên bản'), findsNothing);
      expect(server.calls.where((HttpCall call) => call.method == 'POST'), isEmpty, reason: 'nothing is sent before the person confirms');
      expect(tester.widget<TextField>(_opinion()).controller!.text, 'Đồng ý nghiệm thu');

      await tester.tap(_reject());
      await tester.pumpAndSettle();
      expect(find.text('Biên bản sẽ chuyển sang trạng thái: Đã từ chối'), findsOneWidget);
    });

    testWidgets('R39 a version conflict is never overwritten: the minutes are read again, the opinion stays, and the new decision is under the new version and a new key', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      int reads = 0;
      server.on('GET', '/quality-acceptances/qa-1', (_) {
        reads += 1;
        return reads == 1 ? minutes() : minutes(version: 4);
      });
      int attempt = 0;
      server.answer('POST', '/quality-acceptances/qa-1/decision', (_) {
        attempt += 1;
        return attempt == 1 ? problem(409, 'VERSION_CONFLICT') : recorded('qa-1');
      });
      await _open(tester, server, _detail);

      await tester.enterText(_opinion(), 'Đồng ý');
      await _decideAndConfirm(tester, _approve(), 'Xác nhận duyệt');
      expect(find.text('Biên bản đã được người khác thay đổi. Hãy mở lại để xem tình trạng hiện tại rồi thao tác.'), findsOneWidget);
      expect(find.text('VERSION_CONFLICT'), findsOneWidget);
      expect(_posts(server, '/quality-acceptances/qa-1/decision'), hasLength(1), reason: 'the refused decision is not replayed behind the person');

      await tester.tap(find.text('Tải lại biên bản'));
      await tester.pumpAndSettle();
      expect(reads, 2, reason: 'the minutes are read again from the server');
      expect(find.text('VERSION_CONFLICT'), findsNothing, reason: 'the old refusal is gone once the minutes are fresh');
      expect(tester.widget<TextField>(_opinion()).controller!.text, 'Đồng ý', reason: 'what the person wrote is still there');

      await _decideAndConfirm(tester, _approve(), 'Xác nhận duyệt');
      final List<HttpCall> calls = _posts(server, '/quality-acceptances/qa-1/decision');
      expect(calls, hasLength(2));
      expect(calls[0].headers['if-match'], '"3"');
      expect(calls[1].headers['if-match'], '"4"', reason: 'the new decision is made on the version that is there now');
      expect(calls[1].headers['idempotency-key'], isNot(calls[0].headers['idempotency-key']), reason: 'another decision on another version is another intention');
    });

    testWidgets('a lost answer is "result unknown": sending the same decision again reuses the key and the version, so it is recorded once', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      int attempt = 0;
      server.answer('POST', '/quality-acceptances/qa-1/decision', (_) {
        attempt += 1;
        if (attempt == 1) throw const SocketException('lost');
        return recorded('qa-1');
      });
      await _open(tester, server, _detail);

      await tester.enterText(_opinion(), 'Đồng ý');
      await _decideAndConfirm(tester, _approve(), 'Xác nhận duyệt');
      expect(find.text('Chưa xác định kết quả'), findsOneWidget);
      expect(_approve(), findsOneWidget, reason: 'the form is still there');

      await tester.tap(find.text('Gửi lại cùng thao tác'));
      await tester.pumpAndSettle();
      final List<HttpCall> calls = _posts(server, '/quality-acceptances/qa-1/decision');
      expect(calls, hasLength(2));
      expect(calls[1].headers['idempotency-key'], calls[0].headers['idempotency-key']);
      expect(calls[1].headers['if-match'], calls[0].headers['if-match']);
      expect(find.text('Đã ghi nhận'), findsOneWidget);
    });

    testWidgets('a refused decision is a new command once the cause is gone (a new key), and a second factor refusal says it was not recorded', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      int attempt = 0;
      server.answer('POST', '/quality-acceptances/qa-1/decision', (_) {
        attempt += 1;
        return attempt == 1 ? problem(403, 'MFA_REQUIRED') : recorded('qa-1');
      });
      await _open(tester, server, _detail);
      await tester.enterText(_opinion(), 'Đồng ý');
      await _decideAndConfirm(tester, _approve(), 'Xác nhận duyệt');
      expect(find.textContaining('Cần xác thực lại hai yếu tố. Thao tác chưa được ghi nhận'), findsOneWidget);
      await _decideAndConfirm(tester, _approve(), 'Xác nhận duyệt');
      final List<HttpCall> calls = _posts(server, '/quality-acceptances/qa-1/decision');
      expect(calls, hasLength(2));
      expect(calls[0].headers['idempotency-key'], isNot(calls[1].headers['idempotency-key']));
      expect(find.text('Đã ghi nhận'), findsOneWidget);
    });

    testWidgets('the other refusals each have their words and the code', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final Map<String, String> expected = <String, String>{
        'SELF_APPROVAL_DENIED': 'Người lập biên bản không được tự duyệt.',
        'OPEN_CRITICAL_NCR': 'Hợp đồng còn NCR nghiêm trọng chưa đóng nên chưa nghiệm thu được.',
        'VERSION_CONFLICT': 'Biên bản đã được người khác thay đổi. Hãy mở lại để xem tình trạng hiện tại rồi thao tác.',
        'CONTRACT_STATE_INVALID': 'Hợp đồng không còn đang thực hiện.',
        'QUALITY_ACCEPTANCE_STATE_INVALID': 'Biên bản không còn ở trạng thái cho phép thao tác này.',
        'PERIOD_LOCKED': 'Kỳ đã khóa nên chưa thể thực hiện thao tác này.',
        'LICENSE_EXPIRED': 'License đã hết hạn nên chưa thể thực hiện thao tác này.',
        'SCOPE_DENIED': 'Bạn không có quyền thực hiện thao tác này trên hợp đồng này.',
        'RESOURCE_NOT_FOUND': 'Không tìm thấy biên bản này.',
        'VALIDATION_FAILED': 'Thông tin chưa hợp lệ. Hãy kiểm tra lại các ô đã nhập.',
        'SESSION_EXPIRED': 'Phiên làm việc đã hết hạn. Đăng nhập lại rồi thao tác.',
        'SOMETHING_ELSE': 'Chưa thực hiện được. Hãy thử lại.',
      };
      for (final MapEntry<String, String> entry in expected.entries) {
        final ScriptedServer server = ScriptedServer();
        _reads(server);
        server.answer('POST', '/quality-acceptances/qa-1/decision', (_) => problem(entry.key == 'SESSION_EXPIRED' ? 401 : 409, entry.key));
        await _open(tester, server, _detail);
        await tester.enterText(_opinion(), 'Đồng ý');
        await _decideAndConfirm(tester, _approve(), 'Xác nhận duyệt');
        expect(find.text(entry.value), findsOneWidget, reason: entry.key);
      }
    });
  });

  group('AC-ST-MOB-022-3 UAT-AC357 a signature method that is not accepted is refused with 422 SIGNATURE_METHOD_NOT_ACCEPTED', () {
    Finder sign() => find.widgetWithText(FilledButton, 'Ký biên bản');
    Finder serial() => find.widgetWithText(TextField, 'Số sê-ri chứng thư số');

    void signable(ScriptedServer server) => _reads(server, line: minutes(signable: const <String>['OWNER'], canSign: true, canApprove: false, canReject: false));

    Future<void> chooseMethod(WidgetTester tester, String label) async {
      await tester.tap(find.byType(DropdownButtonFormField<String>).last);
      await tester.pumpAndSettle();
      await tester.tap(find.text(label).last);
      await tester.pumpAndSettle();
    }

    testWidgets('the server refusal of the method is shown with its code, and the form stays', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      signable(server);
      server.answer('POST', '/quality-acceptances/qa-1/sign', (_) => problem(422, 'SIGNATURE_METHOD_NOT_ACCEPTED'));
      await _open(tester, server, _detail);

      await chooseMethod(tester, 'Chứng thư số');
      await tester.enterText(serial(), 'SN-0099');
      await _decideAndConfirm(tester, sign(), 'Xác nhận ký');

      expect(_posts(server, '/quality-acceptances/qa-1/sign'), hasLength(1));
      expect(find.text('Phương thức ký không được chấp nhận: chứng thư số cần số sê-ri, các phương thức khác không có.'), findsOneWidget);
      expect(find.text('SIGNATURE_METHOD_NOT_ACCEPTED'), findsOneWidget);
      expect(tester.widget<TextField>(serial()).controller!.text, 'SN-0099');
    });

    testWidgets('a certificate without its serial is stopped by the form before it is sent', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      signable(server);
      await _open(tester, server, _detail);
      await chooseMethod(tester, 'Chứng thư số');
      expect(find.text('Chữ ký số hợp lệ'), findsOneWidget, reason: 'a certificate says what it is worth');
      await tester.tap(sign());
      await tester.pumpAndSettle();
      expect(find.text('Chứng thư số cần có số sê-ri.'), findsOneWidget);
      expect(server.calls.where((HttpCall call) => call.method == 'POST'), isEmpty);
    });

    testWidgets('an in-app confirmation is signed as the only role, carries no serial and is called an internal confirmation', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      signable(server);
      server.answer('POST', '/quality-acceptances/qa-1/sign', (_) => recorded('qa-1', status: 'SIGNED'));
      await _open(tester, server, _detail);
      expect(find.text('Xác nhận nội bộ (không phải chữ ký số)'), findsWidgets);

      await _decideAndConfirm(tester, sign(), 'Xác nhận ký');

      final HttpCall call = _posts(server, '/quality-acceptances/qa-1/sign').single;
      expect(call.body, contains('"signer_role":"OWNER"'));
      expect(call.body, contains('"signature_method":"IN_APP_OTP"'));
      expect(call.body, isNot(contains('cert_serial')));
      expect(call.body, contains('"client_operation_id":"${call.headers['idempotency-key']}"'), reason: 'one signature, one identifier');
      expect(call.headers['if-match'], '"3"');
      expect(find.text('Đã ghi nhận'), findsOneWidget);
    });

    testWidgets('a person who may sign as two roles must choose one, and signing as a role that is not theirs is refused in words', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server, line: minutes(signable: const <String>['OWNER', 'DESIGNER'], canSign: true, canApprove: false, canReject: false));
      server.answer('POST', '/quality-acceptances/qa-1/sign', (_) => problem(403, 'SCOPE_DENIED', detail: 'signer_role'));
      await _open(tester, server, _detail);

      await tester.tap(sign());
      await tester.pumpAndSettle();
      expect(find.text('Hãy chọn vai trò ký.'), findsOneWidget);
      expect(server.calls.where((HttpCall call) => call.method == 'POST'), isEmpty);

      await tester.tap(find.byType(DropdownButtonFormField<String>).first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Tư vấn thiết kế').last);
      await tester.pumpAndSettle();
      await _decideAndConfirm(tester, sign(), 'Xác nhận ký');
      expect(_posts(server, '/quality-acceptances/qa-1/sign').single.body, contains('"signer_role":"DESIGNER"'));
      expect(find.text('Bạn không thể ký với vai trò này: nhà thầu ký cho nhà thầu, bên chủ đầu tư ký cho phía mình.'), findsOneWidget);
    });

    testWidgets('offline the signing button is disabled with the reason, and the signing card is not offered to someone who cannot sign', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      signable(server);
      await _open(tester, server, _detail);
      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();
      expect(tester.widget<FilledButton>(sign()).onPressed, isNull);
      expect(find.textContaining('Cần kết nối mạng để ký hoặc duyệt'), findsWidgets);

      final ScriptedServer other = ScriptedServer();
      _reads(other);
      await _open(tester, other, _detail);
      expect(sign(), findsNothing);
    });

    testWidgets('the english interface', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      signable(server);
      await _open(tester, server, _detail, locale: const Locale('en'));
      expect(find.text('Sign the minutes'), findsWidgets);
      expect(find.text('Internal confirmation (not a digital signature)'), findsWidgets);
      expect(find.text('Owner: not signed yet.'), findsOneWidget);
    });
  });

  group('AC-ST-MOB-022-3 the commands never reach the offline queue and never send while offline', () {
    MachvonApiClient client(ScriptedServer server) => MachvonApiClient(baseUrl: Uri.parse('https://api.test/v1'), transport: server, token: () async => 't');
    const DecisionRequest decision = DecisionRequest(minutesId: 'qa-1', version: 3, approve: true, reason: ' Đồng ý ');

    test('offline nothing is sent; after a lost answer the person may send the same decision again from an offline-marked device', () async {
      final ScriptedServer server = ScriptedServer();
      int attempt = 0;
      server.answer('POST', '/quality-acceptances/qa-1/decision', (_) {
        attempt += 1;
        if (attempt == 1) throw const SocketException('lost');
        return recorded('qa-1');
      });
      bool online = false;
      final AcceptanceCommands commands = AcceptanceCommands(client: client(server), isOnline: () => online);

      expect(await commands.decide(decision), isA<CommandOffline>());
      expect(server.calls, isEmpty);
      online = true;
      expect(await commands.decide(decision), isA<CommandUnknown>());
      online = false;
      final CommandOutcome again = await commands.decide(decision, retryAfterUnknown: true);
      expect(again, isA<CommandDone>());
      final List<HttpCall> calls = server.callsTo('POST', '/quality-acceptances/qa-1/decision');
      expect(calls[1].headers['idempotency-key'], calls[0].headers['idempotency-key']);
      expect(calls[0].body, contains('"reason":"Đồng ý"'), reason: 'the opinion is trimmed');
    });

    test('a decision sent again under another version is another intention, and a signature is its own intention', () async {
      final ScriptedServer server = ScriptedServer()
        ..answer('POST', '/quality-acceptances/qa-1/decision', (_) => problem(409, 'VERSION_CONFLICT'))
        ..answer('POST', '/quality-acceptances/qa-1/sign', (_) => recorded('qa-1'));
      final AcceptanceCommands commands = AcceptanceCommands(client: client(server), isOnline: () => true);
      final CommandOutcome refused = await commands.decide(decision);
      expect(refused, isA<CommandRefused>());
      expect(refusalOf(refused as CommandRefused).problem, AcceptanceProblem.versionConflict);
      await commands.decide(const DecisionRequest(minutesId: 'qa-1', version: 4, approve: true, reason: 'Đồng ý'));
      final List<HttpCall> calls = server.callsTo('POST', '/quality-acceptances/qa-1/decision');
      expect(calls[1].headers['idempotency-key'], isNot(calls[0].headers['idempotency-key']));
      expect(calls[1].headers['if-match'], '"4"');

      await commands.sign(const SignRequest(minutesId: 'qa-1', version: 4, role: 'OWNER', method: 'IN_APP_WEBAUTHN', certSerial: 'SN-7'));
      final String body = server.callsTo('POST', '/quality-acceptances/qa-1/sign').single.body!;
      expect(body, contains('IN_APP_WEBAUTHN'));
      expect(body, isNot(contains('cert_serial')), reason: 'only a certificate carries a serial');
      await commands.sign(const SignRequest(minutesId: 'qa-1', version: 4, role: 'OWNER', method: 'DIGITAL_CERT', certSerial: ' SN-7 '));
      expect(server.callsTo('POST', '/quality-acceptances/qa-1/sign').last.body, contains('"cert_serial":"SN-7"'));
    });
  });

  group('the rules of the forms and of the data, as pure functions', () {
    test('a signature needs a role, and a certificate needs its serial', () {
      expect(checkSign(role: 'OWNER', method: 'IN_APP_OTP', serial: ''), isEmpty);
      expect(checkSign(role: null, method: 'IN_APP_OTP', serial: ''), <String, FormProblem>{'role': FormProblem.roleRequired});
      expect(checkSign(role: 'OTHER', method: 'IN_APP_OTP', serial: '')['role'], FormProblem.roleRequired, reason: 'only the four roles of the minutes');
      expect(checkSign(role: 'OWNER', method: 'DIGITAL_CERT', serial: '  ')['serial'], FormProblem.serialRequired);
      expect(checkSign(role: 'OWNER', method: 'DIGITAL_CERT', serial: 'SN-1'), isEmpty);
      expect(checkSign(role: 'OWNER', method: 'IN_APP_OTP', serial: 'x' * 2001)['serial'], FormProblem.serialTooLong);
    });

    test('a decision needs an opinion of at most 2000 characters', () {
      expect(checkDecision('Đồng ý'), isEmpty);
      expect(checkDecision('  '), <String, FormProblem>{'reason': FormProblem.reasonRequired});
      expect(checkDecision('x' * 2000), isEmpty);
      expect(checkDecision('x' * 2001)['reason'], FormProblem.reasonTooLong);
    });

    test('only a certificate is a legal electronic signature', () {
      expect(legalEffectOf('DIGITAL_CERT'), 'LEGAL_E_SIGNATURE');
      expect(legalEffectOf('IN_APP_OTP'), 'INTERNAL_RECORD');
      expect(legalEffectOf('IN_APP_WEBAUTHN'), 'INTERNAL_RECORD');
    });

    test('every refusal code of QMS maps to its problem, the missing roles are kept and unknown roles dropped', () {
      AcceptanceRefusal of(String code, {String? detail, Map<String, Object?> extensions = const <String, Object?>{}}) => refusalOf(CommandRefused(code, detail: detail, extensions: extensions));
      expect(of('SIGNATURE_METHOD_NOT_ACCEPTED').problem, AcceptanceProblem.methodNotAccepted);
      expect(of('SIGNATURES_INCOMPLETE', extensions: <String, Object?>{'missing_roles': <Object?>['OWNER', 'MANAGER', 7]}).missingRoles, <String>['OWNER']);
      expect(of('QUALITY_ACCEPTANCE_STATE_INVALID', extensions: <String, Object?>{'reason': 'CONTENT_CHANGED'}).problem, AcceptanceProblem.contentChanged);
      expect(of('SCOPE_DENIED', detail: 'signer_role').problem, AcceptanceProblem.notYourRole);
      expect(of('SCOPE_DENIED').problem, AcceptanceProblem.denied);
      expect(of('ENTITLEMENT_DENIED').problem, AcceptanceProblem.denied);
      expect(of('ROLE_NOT_REQUIRED').problem, AcceptanceProblem.roleNotRequired);
      expect(of('ALREADY_SIGNED').problem, AcceptanceProblem.alreadySigned);
      expect(of('INVALID_REQUEST').problem, AcceptanceProblem.validation);
      expect(of('MFA_REQUIRED').problem, AcceptanceProblem.stepUp);
      expect(of('nope').problem, AcceptanceProblem.general);
    });

    test('the list keeps minutes that still wait, those the person can act on first, and drops what is not one', () {
      final MinutesList? list = parseMinutesList(<String, Object?>{
        'items': <Object?>[
          minutes(id: 'b', recordNo: 'B', canApprove: false, canReject: false),
          minutes(id: 'a', recordNo: 'A', status: 'DRAFT'),
          minutes(id: 'c', recordNo: 'C', status: 'REJECTED'),
          <String, Object?>{'id': 'broken'},
        ],
        'as_of': '2026-11-03T02:30:00Z',
      });
      expect(list!.items.map((Minutes m) => m.id), <String>['a', 'b']);
      expect(list.asOf, '2026-11-03T02:30:00Z');
      expect(parseMinutesList(<String, Object?>{'items': 'no'}), isNull);
      expect(parseMinutes(<String, Object?>{'id': 'x'}), isNull);
    });
  });
}
