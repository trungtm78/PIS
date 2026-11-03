import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/core/sync/sync_status.dart';
import 'package:machvon_mobile/features/approval_inbox/approval_inbox_feature.dart' as inbox;
import 'package:machvon_mobile/features/command_support/command_outcome.dart';
import 'package:machvon_mobile/features/doc_approval/doc_approval_feature.dart' as approval;
import 'package:machvon_mobile/features/doc_approval/return_commands.dart';
import 'package:machvon_mobile/features/doc_approval/screens/approval_screen.dart';
import 'package:machvon_mobile/features/doc_incoming/doc_incoming_feature.dart' as incoming;
import 'package:machvon_mobile/features/document_signing/document_fetcher.dart';
import 'package:machvon_mobile/features/document_signing/document_signing_feature.dart' as signing;
import 'package:machvon_mobile/features/document_signing/pdf_engine.dart';
import 'package:machvon_mobile/features/document_signing/signing_port.dart';
import 'package:machvon_mobile/features/session/auth/biometric_gate.dart';
import 'package:machvon_mobile/features/session/session_providers.dart';

import '../../support/harness.dart';
import '../document_signing/support.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';

const String _list = '/approval/doc-22';
const String _detail = '/approval/doc-22?doc=d-1';

FakeSession _leader({SessionMode mode = SessionMode.full, String? membership = 'mem-1'}) =>
    FakeSession(SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1', membershipId: membership, mode: mode));

final class _Gate implements BiometricGate {
  @override
  Future<bool> isAvailable() async => true;

  @override
  Future<bool> authenticate({required String reason}) async => true;
}

Future<ProviderContainer> _open(WidgetTester tester, ScriptedServer server, String location, {FakeSession? session, Locale locale = const Locale('vi')}) {
  return pumpWithServer(
    tester,
    // The words of the signing view are those of the feature document_signing, which the application always carries.
    features: <MobileFeature>[signing.feature, approval.feature],
    server: server,
    location: location,
    session: session ?? _leader(),
    locale: locale,
    overrides: [
      pdfEngineProvider.overrideWithValue(FakePdfEngine(<String, List<int>>{'final': <int>[0, 0, 0], 'draft': <int>[0, 0], 'signed': <int>[0, 0, 0]})),
      documentFetcherProvider.overrideWithValue(FakeFetcher(<String, Uint8List>{
        'https://files.test/final?sig=1': pdfBytes('final'),
        'https://files.test/draft?sig=1': pdfBytes('draft'),
        'https://files.test/signed?sig=1': pdfBytes('signed'),
      })),
      signingPortProvider.overrideWith((Ref ref) => const RemoteCaOtpPort()),
      biometricGateProvider.overrideWithValue(_Gate()),
    ],
  );
}

void _reads(ScriptedServer server, {Map<String, Object?>? document}) {
  final Map<String, Object?> one = document ?? outgoing();
  server
    ..on('GET', '/outgoing-documents', (_) => page(<Object?>[one]))
    ..on('GET', '/outgoing-documents/d-1', (_) => one)
    ..on('GET', '/document-versions/v-1/download', (_) => download('draft'))
    ..on('GET', '/document-versions/v-2/download', (_) => download('final'))
    ..on('GET', '/document-versions/v-3/download', (_) => download('signed'));
}

Finder _open_() => find.widgetWithText(OutlinedButton, 'Trả lại kèm lý do');
Finder _reason() => find.widgetWithText(TextField, 'Lý do trả lại');
Finder _giveBack() => find.widgetWithText(FilledButton, 'Trả lại người soạn');
Finder _start() => find.widgetWithText(FilledButton, 'Bắt đầu ký');

List<HttpCall> _returns(ScriptedServer server) => server.callsTo('POST', '/outgoing-documents/d-1/return');

Future<void> _scrollTo(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder);
  await tester.pumpAndSettle();
}

void main() {
  group('UI-DOC-22 FR-DOC-22 the leader approves and signs a document on the phone', () {
    testWidgets('lists the documents that wait, those that name the person as signer first, and opens one on DOC-22', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      server
        ..on('GET', '/outgoing-documents', (_) => page(<Object?>[
              <String, Object?>{...outgoing(id: 'd-2', signer: 'mem-7'), 'title': 'Công văn trả lời'},
              outgoing(),
            ]))
        ..on('GET', '/outgoing-documents/d-1', (_) => outgoing());
      final ProviderContainer container = await _open(tester, server, _list);

      expect(find.text('Duyệt và ký văn bản'), findsWidgets);
      expect(tester.getTopLeft(find.text('Quyết định giao vốn năm 2026')).dy, lessThan(tester.getTopLeft(find.text('Công văn trả lời')).dy));
      expect(find.text('Chờ bạn ký'), findsOneWidget);
      expect(server.callsTo('GET', '/outgoing-documents').single.url.queryParameters, containsPair('status', 'SUBMITTED'));

      await tester.tap(find.text('Quyết định giao vốn năm 2026'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), _detail, reason: 'a row opens the document on DOC-22, not on MOB-67');
      expect(server.calls.where((HttpCall call) => call.method != 'GET'), isEmpty, reason: 'opening a document signs nothing and returns nothing');
    });

    testWidgets('a document shows the file to read, the way of signing (the remote certificate authority) and the return with a reason', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      await _open(tester, server, _detail);

      expect(find.text('Quyết định giao vốn năm 2026'), findsWidgets);
      expect(find.text('Xem PDF'), findsOneWidget);
      expect(find.text('Dịch vụ ký từ xa của CA, xác nhận bằng mã dùng một lần'), findsOneWidget, reason: 'the way of signing is the remote certificate authority');
      expect(_start(), findsOneWidget);
      expect(find.text('Trả lại văn bản'), findsOneWidget);
      expect(_open_(), findsOneWidget);
    });

    testWidgets('speaks English', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      await _open(tester, server, _detail, locale: const Locale('en'));
      expect(find.text('Approve and sign a document'), findsOneWidget);
      expect(find.text('Return with a reason'), findsOneWidget);
    });

    testWidgets('every state of the list and of a document is drawn, and both views keep the screen contract', (WidgetTester tester) async {
      await expectEveryState(
        tester,
        open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, _list),
        script: StateScript(healthy: _reads, content: find.text('Quyết định giao vốn năm 2026'), empty: (ScriptedServer server) => server.on('GET', '/outgoing-documents', (_) => page(<Object?>[]))),
      );
      await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, _list), healthy: _reads);
      await expectEveryState(
        tester,
        open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, _detail),
        script: StateScript(healthy: _reads, content: find.text('Quyết định giao vốn năm 2026')),
      );
      await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, _detail), healthy: _reads);
    });
  });

  group('AC-ST-DOC-020-1 UAT-AC426 UI-DOC-22 signing is online only: nothing is queued, and a lapsed session is refused with 409', () {
    testWidgets('offline, the signing button is disabled with the reason beside it, the return is too, and nothing is sent or queued', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      final ProviderContainer container = await _open(tester, server, _detail);
      expect(tester.widget<FilledButton>(_start()).onPressed, isNotNull, reason: 'online it is offered');
      expect(tester.widget<OutlinedButton>(_open_()).onPressed, isNotNull);

      container.read(reachabilityProvider.notifier).report(Reachability.offline);
      await tester.pumpAndSettle();
      expect(find.text('Cần kết nối mạng để ký. Lệnh ký không bao giờ được xếp hàng đợi, gửi từ bản lưu trên máy hay giữ lại để gửi sau.'), findsOneWidget);
      expect(find.text('Cần kết nối mạng để trả lại văn bản. Việc trả lại không bao giờ được xếp hàng đợi hay gửi từ bản lưu trên máy.'), findsOneWidget);
      expect(tester.widget<FilledButton>(_start()).onPressed, isNull);
      expect(tester.widget<OutlinedButton>(_open_()).onPressed, isNull);
      expect(container.read(syncStatusProvider).pendingCommands, 0, reason: 'the offline queue holds no signing command');
      expect(server.calls.where((HttpCall call) => call.method == 'POST'), isEmpty);
    });

    testWidgets('a session that lapsed is refused with 409 SIGNING_SESSION_EXPIRED, the document is read again and a new session is offered', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      int reads = 0;
      server.on('GET', '/outgoing-documents/d-1', (_) {
        reads += 1;
        return reads == 1 ? outgoing(sessions: <Map<String, Object?>>[session('s-1')]) : outgoing(sessions: <Map<String, Object?>>[session('s-1', status: 'EXPIRED')]);
      });
      server.on('GET', '/outgoing-documents', (_) => page(<Object?>[outgoing()]));
      server.answer('POST', '/signing-sessions/s-1/completion', (_) => problem(409, 'SIGNING_SESSION_EXPIRED'));
      await _open(tester, server, _detail);

      await tester.enterText(find.widgetWithText(TextField, 'Mã xác nhận (OTP)'), '123456');
      await tester.tap(find.widgetWithText(FilledButton, 'Xác nhận và ký'));
      await tester.pumpAndSettle();

      expect(server.callsTo('POST', '/signing-sessions/s-1/completion'), hasLength(1));
      expect(find.text('SIGNING_SESSION_EXPIRED'), findsOneWidget);
      expect(reads, 2, reason: 'the document is read again');
      expect(find.widgetWithText(FilledButton, 'Mở phiên ký mới'), findsOneWidget, reason: 'a new session is offered');
      expect(server.calls.where((HttpCall call) => call.url.path.contains('/sync/')), isEmpty, reason: 'no signing command was ever handed to the offline queue');
    });

    test('the return has no way to reach the offline queue: offline it sends nothing', () async {
      final ScriptedServer server = ScriptedServer();
      final MachvonApiClient client = MachvonApiClient(baseUrl: Uri.parse('https://api.test/v1'), transport: server, token: () async => 't');
      final ReturnCommands commands = ReturnCommands(client: client, isOnline: () => false);
      expect(await commands.giveBack('d-1', 7, 'Cần bổ sung căn cứ pháp lý'), isA<CommandOffline>());
      expect(server.calls, isEmpty);
    });
  });

  group('NAV-02 UI-DOC-22 UI-DOC-23 the two screens are reached from the approvals', () {
    testWidgets('the app bar of the approvals opens DOC-22 and DOC-23', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer()
        ..on('GET', '/resources/approval_task', (_) => page(<Object?>[]))
        ..on('GET', '/resources/organization_unit', (_) => page(<Object?>[]));
      final ProviderContainer container = await pumpWithServer(
        tester,
        features: <MobileFeature>[signing.feature, inbox.feature, approval.feature, incoming.feature],
        server: server,
        location: '/approval',
        session: _leader(),
      );
      await tester.tap(find.byTooltip('Duyệt và ký văn bản'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), _list);
      await pressBack(tester);
      await tester.tap(find.byTooltip('Văn bản đến cần xử lý'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/approval/doc-23');
    });
  });

  group('UI-DOC-22 the document is given back to its drafter with a reason', () {
    testWidgets('one request under the version on the screen with a key and the trimmed reason; the document is read again and no longer waits', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      int reads = 0;
      server.on('GET', '/outgoing-documents', (_) => page(<Object?>[outgoing()]));
      server.on('GET', '/outgoing-documents/d-1', (_) {
        reads += 1;
        return reads == 1 ? outgoing() : outgoing(status: 'RETURNED', version: 8);
      });
      server.answer('POST', '/outgoing-documents/d-1/return', (_) => recorded('d-1', status: 'RETURNED', version: 8));
      await _open(tester, server, _detail);

      await _scrollTo(tester, _open_());
      await tester.tap(_open_());
      await tester.pumpAndSettle();
      await tester.enterText(_reason(), '  Cần bổ sung căn cứ pháp lý  ');
      await _scrollTo(tester, _giveBack());
      await tester.tap(_giveBack());
      await tester.pumpAndSettle();

      final List<HttpCall> calls = _returns(server);
      expect(calls, hasLength(1));
      expect(calls.single.headers['idempotency-key'], isNotEmpty);
      expect(calls.single.headers['if-match'], '"7"');
      expect(calls.single.body, contains('"reason":"Cần bổ sung căn cứ pháp lý"'));
      expect(reads, 2);
      expect(find.text('Đã trả lại người soạn'), findsOneWidget);
      expect(_open_(), findsNothing, reason: 'the document no longer waits, so it cannot be returned again');
      expect(find.text('Văn bản không còn chờ lãnh đạo ký.'), findsOneWidget);
    });

    testWidgets('the reason is required, at least 10 and at most 2000 characters, checked before anything is sent', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      await _open(tester, server, _detail);
      await _scrollTo(tester, _open_());
      await tester.tap(_open_());
      await tester.pumpAndSettle();

      await _scrollTo(tester, _giveBack());
      await tester.tap(_giveBack());
      await tester.pumpAndSettle();
      expect(find.text('Hãy nhập lý do trả lại.'), findsOneWidget);
      await tester.enterText(_reason(), 'ngắn quá');
      await tester.tap(_giveBack());
      await tester.pumpAndSettle();
      expect(find.text('Lý do trả lại cần ít nhất 10 ký tự.'), findsOneWidget);
      await tester.enterText(_reason(), 'x' * 2001);
      await tester.tap(_giveBack());
      await tester.pumpAndSettle();
      expect(find.text('Lý do trả lại tối đa 2000 ký tự.'), findsOneWidget);
      expect(_returns(server), isEmpty);
    });

    testWidgets('a lost answer is "result unknown": sending the same return again reuses the key and the version, so it is recorded once', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      int attempt = 0;
      server.answer('POST', '/outgoing-documents/d-1/return', (_) {
        attempt += 1;
        if (attempt == 1) throw const SocketException('lost');
        return recorded('d-1', status: 'RETURNED', version: 8);
      });
      await _open(tester, server, _detail);
      await _scrollTo(tester, _open_());
      await tester.tap(_open_());
      await tester.pumpAndSettle();
      await tester.enterText(_reason(), 'Cần bổ sung căn cứ pháp lý');
      await _scrollTo(tester, _giveBack());
      await tester.tap(_giveBack());
      await tester.pumpAndSettle();

      expect(find.text('Chưa xác định kết quả'), findsOneWidget);
      await tester.tap(find.text('Gửi lại cùng thao tác'));
      await tester.pumpAndSettle();
      final List<HttpCall> calls = _returns(server);
      expect(calls, hasLength(2));
      expect(calls[1].headers['idempotency-key'], calls[0].headers['idempotency-key']);
      expect(calls[1].headers['if-match'], calls[0].headers['if-match']);
      expect(find.text('Đã trả lại người soạn'), findsOneWidget);
    });

    testWidgets('after a lost answer "send again" replays the reason that was sent, even when the field was edited meanwhile: same key, same body', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      int attempt = 0;
      server.answer('POST', '/outgoing-documents/d-1/return', (_) {
        attempt += 1;
        if (attempt == 1) throw const SocketException('lost');
        return recorded('d-1', status: 'RETURNED', version: 8);
      });
      await _open(tester, server, _detail);
      await _scrollTo(tester, _open_());
      await tester.tap(_open_());
      await tester.pumpAndSettle();
      await tester.enterText(_reason(), 'Cần bổ sung căn cứ pháp lý');
      await _scrollTo(tester, _giveBack());
      await tester.tap(_giveBack());
      await tester.pumpAndSettle();
      expect(find.text('Chưa xác định kết quả'), findsOneWidget);

      await tester.enterText(_reason(), 'Một lý do hoàn toàn khác');
      await tester.tap(find.text('Gửi lại cùng thao tác'));
      await tester.pumpAndSettle();
      final List<HttpCall> calls = _returns(server);
      expect(calls, hasLength(2));
      expect(calls[1].headers['idempotency-key'], calls[0].headers['idempotency-key']);
      expect(calls[1].body, calls[0].body);
      expect(calls[1].body, contains('Cần bổ sung căn cứ pháp lý'));
      expect(calls[1].body, isNot(contains('hoàn toàn khác')));
    });

    testWidgets('a refusal keeps the reason in the form and says why, with the stable code; the document is read again',(WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      server.answer('POST', '/outgoing-documents/d-1/return', (_) => problem(403, 'PERMISSION_DENIED'));
      await _open(tester, server, _detail);
      await _scrollTo(tester, _open_());
      await tester.tap(_open_());
      await tester.pumpAndSettle();
      await tester.enterText(_reason(), 'Cần bổ sung căn cứ pháp lý');
      await _scrollTo(tester, _giveBack());
      await tester.tap(_giveBack());
      await tester.pumpAndSettle();

      expect(find.text('Bạn không có quyền với văn bản này hoặc với đơn vị soạn thảo của nó.'), findsOneWidget);
      expect(find.text('PERMISSION_DENIED'), findsOneWidget);
      expect(tester.widget<TextField>(_reason()).controller!.text, 'Cần bổ sung căn cứ pháp lý');
      expect(server.callsTo('GET', '/outgoing-documents/d-1'), hasLength(2));
    });

    testWidgets('a read-only organisation cannot return a document, and a document the leader already signed cannot be returned', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      ScriptedServer server = ScriptedServer();
      _reads(server);
      await _open(tester, server, _detail, session: _leader(mode: SessionMode.readOnly));
      expect(find.text('Tổ chức đang ở chế độ chỉ đọc nên chưa thể trả lại văn bản.'), findsOneWidget);
      expect(tester.widget<OutlinedButton>(_open_()).onPressed, isNull);

      server = ScriptedServer();
      _reads(server, document: signedOutgoing());
      await _open(tester, server, _detail);
      expect(_open_(), findsNothing);
      expect(find.text('Trả lại văn bản'), findsNothing);
    });

    test('the reason bounds are those of the server: 10 to 2000 characters, counted in characters not bytes', () {
      expect(checkReason(''), ReasonProblem.required);
      expect(checkReason('        '), ReasonProblem.required);
      expect(checkReason('ngắn quá'), ReasonProblem.tooShort, reason: 'eight characters, more than eight bytes');
      expect(checkReason('đủ mười ký'), isNull);
      expect(checkReason('x' * 2000), isNull);
      expect(checkReason('x' * 2001), ReasonProblem.tooLong);
    });

    test('the gate puts offline and a copy before the read-only mode', () {
      const SessionSnapshot full = SessionSnapshot(status: SessionStatus.signedIn, tenantId: 't', userId: 'u');
      const SessionSnapshot readOnly = SessionSnapshot(status: SessionStatus.signedIn, tenantId: 't', userId: 'u', mode: SessionMode.readOnly);
      expect(returnGateOf(offline: false, fromCopy: false, session: full), ReturnGate.open);
      expect(returnGateOf(offline: true, fromCopy: false, session: readOnly), ReturnGate.offline);
      expect(returnGateOf(offline: false, fromCopy: true, session: full), ReturnGate.offline);
      expect(returnGateOf(offline: false, fromCopy: false, session: readOnly), ReturnGate.readOnly);
    });
  });
}
