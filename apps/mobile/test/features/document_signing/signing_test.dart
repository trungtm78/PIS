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
import 'package:machvon_mobile/features/document_signing/document_fetcher.dart';
import 'package:machvon_mobile/features/document_signing/document_signing_feature.dart' as signing;
import 'package:machvon_mobile/features/document_signing/pdf_engine.dart';
import 'package:machvon_mobile/features/document_signing/signing_models.dart';
import 'package:machvon_mobile/features/document_signing/signing_port.dart';
import 'package:machvon_mobile/features/session/auth/biometric_gate.dart';
import 'package:machvon_mobile/features/session/session_providers.dart';

import '../../support/harness.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'support.dart';

const String _detail = '/approval/mob-67?doc=d-1';

FakeSession _leader({SessionMode mode = SessionMode.full, String? membership = 'mem-1'}) =>
    FakeSession(SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1', membershipId: membership, mode: mode));

final class _Gate implements BiometricGate {
  _Gate();

  bool allow = true;
  int asked = 0;

  @override
  Future<bool> isAvailable() async => true;

  @override
  Future<bool> authenticate({required String reason}) async {
    asked += 1;
    return allow;
  }
}

/// The pieces a test may look at after the screen ran.
final class _Rig {
  _Rig({List<int> final_ = const <int>[0, 0, 0], List<int> draft = const <int>[0, 0]})
      : engine = FakePdfEngine(<String, List<int>>{'final': final_, 'draft': draft, 'signed': final_}),
        fetcher = FakeFetcher(<String, Uint8List>{
          'https://files.test/final?sig=1': pdfBytes('final'),
          'https://files.test/draft?sig=1': pdfBytes('draft'),
          'https://files.test/signed?sig=1': pdfBytes('signed'),
        }),
        gate = _Gate();

  final FakePdfEngine engine;
  final FakeFetcher fetcher;
  final _Gate gate;
  SigningPort port = const RemoteCaOtpPort();
}

Future<ProviderContainer> _open(WidgetTester tester, ScriptedServer server, String location, {_Rig? rig, FakeSession? session, Locale locale = const Locale('vi')}) {
  final _Rig r = rig ?? _Rig();
  return pumpWithServer(
    tester,
    features: <MobileFeature>[signing.feature],
    server: server,
    location: location,
    session: session ?? _leader(),
    locale: locale,
    overrides: [
      pdfEngineProvider.overrideWithValue(r.engine),
      documentFetcherProvider.overrideWithValue(r.fetcher),
      signingPortProvider.overrideWith((Ref ref) => r.port),
      biometricGateProvider.overrideWithValue(r.gate),
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

Finder _start() => find.widgetWithText(FilledButton, 'Bắt đầu ký');
Finder _confirm() => find.widgetWithText(FilledButton, 'Xác nhận và ký');
Finder _otp() => find.widgetWithText(TextField, 'Mã xác nhận (OTP)');

List<HttpCall> _posts(ScriptedServer server) => server.calls.where((HttpCall call) => call.method == 'POST').toList();

void main() {
  group('UI-MOB-67 MOB-67 the documents waiting for the leader', () {
    testWidgets('lists the documents that wait, those that name the person as signer first, and opens one', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      server
        ..on('GET', '/outgoing-documents', (_) => page(<Object?>[
              <String, Object?>{...outgoing(id: 'd-2', signer: 'mem-7'), 'title': 'Công văn trả lời'},
              outgoing(),
            ]))
        ..on('GET', '/outgoing-documents/d-1', (_) => outgoing());
      final ProviderContainer container = await _open(tester, server, '/approval/mob-67');

      expect(tester.getTopLeft(find.text('Quyết định giao vốn năm 2026')).dy, lessThan(tester.getTopLeft(find.text('Công văn trả lời')).dy), reason: 'the one that names the person first');
      expect(find.text('Chờ bạn ký'), findsOneWidget);
      expect(find.text('QD · người ký Phó Chủ tịch'), findsNWidgets(2));
      expect(server.callsTo('GET', '/outgoing-documents').single.url.queryParameters, containsPair('status', 'SUBMITTED'));

      await tester.tap(find.text('Quyết định giao vốn năm 2026'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), _detail);
      expect(server.calls.where((HttpCall call) => call.method != 'GET'), isEmpty, reason: 'opening a document signs nothing');
    });

    testWidgets('says when the list has more documents than the pages read', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      int pages = 0;
      server.on('GET', '/outgoing-documents', (_) {
        pages += 1;
        return <String, Object?>{'items': <Object?>[outgoing(id: 'd-$pages')], 'next_cursor': 'c$pages', 'as_of': '2026-11-03T02:00:00Z'};
      });
      await _open(tester, server, '/approval/mob-67');
      expect(pages, 4, reason: 'a phone follows a few pages of the queue and says there is more');
      expect(find.textContaining('Còn văn bản khác chưa hiển thị'), findsOneWidget);
    });

    testWidgets('shows the document, the versions, who signs and with what, and that numbering and the seal are the clerk\'s', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      await _open(tester, server, _detail);

      expect(find.text('Quyết định giao vốn năm 2026'), findsOneWidget);
      expect(find.text('Phó Chủ tịch'), findsOneWidget);
      expect(find.text('Chờ lãnh đạo ký'), findsOneWidget);
      expect(find.textContaining('Cấp số và đóng dấu cơ quan do văn thư thực hiện'), findsOneWidget);
      expect(find.text('Bản 2 · PDF cuối chờ ký · 3 trang · mã băm ${hashOf('final').substring(0, 12)}'), findsOneWidget);
      expect(find.text('CN=Lê Lãnh Đạo,O=UBND tỉnh A, còn hiệu lực đến 30/06/2027'), findsOneWidget);
      expect(find.text('Dịch vụ ký từ xa của CA, xác nhận bằng mã dùng một lần'), findsOneWidget);
      expect(find.text('So sánh với bản 1'), findsOneWidget);
    });

    testWidgets('every state is drawn and the contract of the list and of the document holds', (WidgetTester tester) async {
      await expectEveryState(
        tester,
        open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, _detail),
        script: StateScript(healthy: _reads, content: find.text('Tệp PDF và các phiên bản')),
      );
      await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, _detail), healthy: _reads);
      await expectEveryState(
        tester,
        open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/approval/mob-67'),
        script: StateScript(healthy: _reads, content: find.text('Chờ bạn ký'), empty: (ScriptedServer server) => server.on('GET', '/outgoing-documents', (_) => page(<Object?>[]))),
      );
      await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/approval/mob-67'), healthy: _reads);
    });

    testWidgets('the contract holds on an open signing session with its code field, and on the result of a signature', (WidgetTester tester) async {
      void open(ScriptedServer server) => _reads(server, document: outgoing(sessions: <Map<String, Object?>>[session('s-1')]));
      await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, _detail), healthy: open);
      await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, _detail), healthy: (ScriptedServer server) => _reads(server, document: signedOutgoing()));
    });
  });

  group('AC-ST-MOB-023-1 UAT-AC403 the leader signs after the confirmation and the signature is added to the same content', () {
    testWidgets('start the session, confirm with the code, and the result is read back from the server: valid, revision added, hash unchanged', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      Map<String, Object?> document = outgoing();
      server
        ..on('GET', '/outgoing-documents', (_) => page(<Object?>[document]))
        ..on('GET', '/outgoing-documents/d-1', (_) => document)
        ..answer('POST', '/outgoing-documents/d-1/leader-signing-sessions', (_) {
          document = outgoing(version: 8, sessions: <Map<String, Object?>>[session('s-1')]);
          return recorded('s-1', status: 'AWAITING_SIGNER');
        })
        ..answer('POST', '/signing-sessions/s-1/completion', (_) {
          document = signedOutgoing();
          return recorded('s-1', status: 'EMBEDDED');
        });
      await _open(tester, server, _detail);
      expect(find.text('Kết quả ký'), findsNothing);

      await tester.tap(_start());
      await tester.pumpAndSettle();
      final HttpCall started = _posts(server).single;
      expect(started.url.path, endsWith('/outgoing-documents/d-1/leader-signing-sessions'));
      expect(started.headers['if-match'], '"7"');
      expect(started.body, contains('"certificate_id":"cert-1"'));
      expect(started.body, contains('"adapter_code":"REMOTE_CA"'));
      expect(_otp(), findsOneWidget, reason: 'the session is open, the code is asked');
      expect(find.textContaining('Phiên ký đang mở, hết hạn lúc 03/11/2026 10:15'), findsOneWidget);

      await tester.tap(_confirm());
      await tester.pumpAndSettle();
      expect(find.text('Bắt buộc nhập mã xác nhận.'), findsOneWidget);
      expect(_posts(server), hasLength(1), reason: 'no code, no completion');

      await tester.enterText(_otp(), ' 482913 ');
      await tester.tap(_confirm());
      await tester.pumpAndSettle();
      final HttpCall completed = _posts(server).last;
      expect(completed.url.path, endsWith('/signing-sessions/s-1/completion'));
      expect(completed.headers['if-match'], '"2"');
      expect(completed.body, '{"otp_confirmation":"482913"}');

      expect(find.text('Kết quả ký'), findsOneWidget);
      expect(find.text('Lãnh đạo đã ký văn bản lúc 03/11/2026 10:05.'), findsOneWidget);
      expect(find.text('Hợp lệ'), findsOneWidget);
      expect(find.text('Bản 3, đã ký lãnh đạo'), findsOneWidget);
      expect(find.textContaining('mã băm không đổi, chữ ký được thêm vào cuối tệp'), findsOneWidget);
      expect(find.textContaining('do văn thư thực hiện trên máy tính'), findsWidgets);
      expect(_confirm(), findsNothing);
      expect(_start(), findsNothing);
      expect(_posts(server).where((HttpCall call) => call.url.path.contains('numbering') || call.url.path.contains('seal')), isEmpty, reason: 'numbering and the seal are the clerk\'s');
    });

    testWidgets('a signed file that does not rest on the final PDF is a warning, not a success', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server, document: signedOutgoing(prefix: hashOf('other')));
      await _open(tester, server, _detail);
      expect(find.textContaining('Cảnh báo: nội dung tệp đã ký không trùng với bản PDF cuối'), findsOneWidget);
      expect(find.textContaining('mã băm không đổi'), findsNothing);
    });

    testWidgets('a signature that the server has not verified yet is not called valid', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server, document: <String, Object?>{...signedOutgoing(), 'signatures': <Object?>[]});
      await _open(tester, server, _detail);
      expect(find.text('Máy chủ chưa có kết quả xác minh chữ ký.'), findsOneWidget);
      expect(find.text('Hợp lệ'), findsNothing);
    });

    testWidgets('the server leaves a session whose time ran out open: after the expiry refusal a new start request is offered, and it is sent (the server expires the old one when it opens the new)', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      Map<String, Object?> document = outgoing(sessions: <Map<String, Object?>>[session('s-1')]);
      server
        ..on('GET', '/outgoing-documents/d-1', (_) => document)
        ..answer('POST', '/signing-sessions/s-1/completion', (_) => problem(409, 'SIGNING_SESSION_EXPIRED'))
        ..answer('POST', '/outgoing-documents/d-1/leader-signing-sessions', (_) {
          document = outgoing(version: 8, sessions: <Map<String, Object?>>[session('s-2'), session('s-1', status: 'EXPIRED')]);
          return recorded('s-2', status: 'AWAITING_SIGNER');
        });
      await _open(tester, server, _detail);
      expect(find.widgetWithText(FilledButton, 'Mở phiên ký mới'), findsNothing, reason: 'while the screen does not know the session ran out it is open');
      await tester.enterText(_otp(), '482913');
      await tester.tap(_confirm());
      await tester.pumpAndSettle();

      expect(find.text('SIGNING_SESSION_EXPIRED'), findsOneWidget);
      expect(find.text('Phiên ký trước đã hết hạn mà chưa xác nhận; hãy mở phiên ký mới.'), findsOneWidget);
      expect(_confirm(), findsNothing, reason: 'the session that the server refused is not offered for confirmation again');
      await tester.tap(find.widgetWithText(FilledButton, 'Mở phiên ký mới'));
      await tester.pumpAndSettle();
      final HttpCall started = _posts(server).last;
      expect(started.url.path, endsWith('/outgoing-documents/d-1/leader-signing-sessions'));
      expect(_otp(), findsOneWidget, reason: 'the new session is open and asks for its code');
      expect(_confirm(), findsOneWidget);
    });

    testWidgets('a lost answer is "result unknown": sending the same confirmation again reuses the key, so the document is signed once', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server, document: outgoing(sessions: <Map<String, Object?>>[session('s-1')]));
      int attempt = 0;
      server.answer('POST', '/signing-sessions/s-1/completion', (_) {
        attempt += 1;
        if (attempt == 1) throw const SocketException('lost');
        return recorded('s-1', status: 'EMBEDDED');
      });
      await _open(tester, server, _detail);
      await tester.enterText(_otp(), '482913');
      await tester.tap(_confirm());
      await tester.pumpAndSettle();
      expect(find.text('Chưa xác định kết quả'), findsOneWidget);

      await tester.tap(find.text('Gửi lại cùng thao tác'));
      await tester.pumpAndSettle();
      final List<HttpCall> calls = _posts(server);
      expect(calls, hasLength(2));
      expect(calls[1].headers['idempotency-key'], calls[0].headers['idempotency-key']);
      expect(calls[1].headers['if-match'], calls[0].headers['if-match']);
      expect(find.text('Đã ghi nhận'), findsOneWidget);
    });

    testWidgets('an expired session is refused and the document, read again, offers a new session; an open session found while starting is said', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      Map<String, Object?> document = outgoing(sessions: <Map<String, Object?>>[session('s-1')]);
      server
        ..on('GET', '/outgoing-documents/d-1', (_) => document)
        ..answer('POST', '/signing-sessions/s-1/completion', (_) {
          document = outgoing(sessions: <Map<String, Object?>>[session('s-1', status: 'EXPIRED')]);
          return problem(409, 'SIGNING_SESSION_EXPIRED');
        })
        ..answer('POST', '/outgoing-documents/d-1/leader-signing-sessions', (_) => problem(409, 'SIGNING_SESSION_OPEN'));
      await _open(tester, server, _detail);
      await tester.enterText(_otp(), '482913');
      await tester.tap(_confirm());
      await tester.pumpAndSettle();

      expect(find.text('Phiên ký đã hết hạn. Hãy mở phiên mới để ký lại.'), findsOneWidget);
      expect(find.text('SIGNING_SESSION_EXPIRED'), findsOneWidget);
      expect(find.text('Phiên ký trước đã hết hạn mà chưa xác nhận; hãy mở phiên ký mới.'), findsOneWidget);
      expect(find.text('Lãnh đạo đã ký'), findsNothing);
      await tester.tap(find.widgetWithText(FilledButton, 'Mở phiên ký mới'));
      await tester.pumpAndSettle();
      expect(find.text('Văn bản đang có một phiên ký chưa kết thúc. Hoàn tất hoặc chờ phiên đó hết hạn.'), findsOneWidget);
    });
  });

  group('AC-ST-MOB-023-2 UAT-AC414 a signer who is not authorised for the document is refused', () {
    testWidgets('422 SIGNER_NOT_AUTHORIZED is shown with its code, and the document is still waiting', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      server.answer('POST', '/outgoing-documents/d-1/leader-signing-sessions', (_) => problem(422, 'SIGNER_NOT_AUTHORIZED', detail: 'signer_user_id'));
      await _open(tester, server, _detail);

      await tester.tap(_start());
      await tester.pumpAndSettle();
      expect(find.text('Chỉ người ký được chỉ định mới ký được văn bản này.'), findsOneWidget);
      expect(find.text('SIGNER_NOT_AUTHORIZED'), findsOneWidget);
      expect(find.text('Kết quả ký'), findsNothing);
      expect(find.text('Chờ lãnh đạo ký'), findsOneWidget);
      expect(find.widgetWithText(OutlinedButton, 'Thử lại'), findsNothing, reason: 'a refusal of the right is not retryable');
    });

    testWidgets('a person who is not the signer named by the document is not offered the signature, and says why', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      await _open(tester, server, _detail, session: _leader(membership: 'mem-2'));
      expect(find.text('Bạn không phải người ký được chỉ định của văn bản này.'), findsOneWidget);
      expect(tester.widget<FilledButton>(_start()).onPressed, isNull);

      await _open(tester, server, _detail, session: _leader(membership: null));
      expect(tester.widget<FilledButton>(_start()).onPressed, isNull);
    });

    testWidgets('the other refusals each have their words and the code', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final Map<String, String> expected = <String, String>{
        'SELF_APPROVAL_DENIED': 'Người soạn thảo không được tự ký lãnh đạo văn bản của mình.',
        'CERTIFICATE_NOT_ACTIVE': 'Chứng thư chọn để ký không còn hiệu lực hoặc không thuộc người ký.',
        'VERSION_CONFLICT': 'Văn bản vừa được người khác thay đổi. Hãy mở lại màn hình rồi thử lại.',
        'DOCUMENT_STATE_INVALID': 'Văn bản không ở trạng thái cho phép bước này.',
        'MFA_REQUIRED': 'Cần xác thực lại hai yếu tố. Việc ký chưa được ghi nhận; hãy hoàn tất bước xác thực rồi ký lại.',
        'LICENSE_EXPIRED': 'License đã hết hạn nên chưa thể ký.',
        'SCOPE_DENIED': 'Bạn không có quyền với văn bản này hoặc với đơn vị soạn thảo của nó.',
        'RESOURCE_NOT_FOUND': 'Không tìm thấy văn bản hoặc phiên ký.',
        'VALIDATION_FAILED': 'Thông tin gửi đi chưa hợp lệ. Hãy kiểm tra lại mã xác nhận.',
        'SESSION_EXPIRED': 'Phiên làm việc đã hết hạn. Đăng nhập lại rồi ký.',
        'DIGEST_MISMATCH': 'Mã băm của tệp không khớp mã băm đã khóa cho phiên ký. Hãy mở phiên mới.',
        'SIGNATURE_INVALID': 'Chữ ký nhận về không hợp lệ với chứng thư đã chọn nên không được nhúng vào tệp.',
      };
      for (final MapEntry<String, String> entry in expected.entries) {
        final ScriptedServer server = ScriptedServer();
        _reads(server);
        server.answer('POST', '/outgoing-documents/d-1/leader-signing-sessions', (_) => problem(entry.key == 'SESSION_EXPIRED' ? 401 : 409, entry.key));
        await _open(tester, server, _detail);
        await tester.tap(_start());
        await tester.pumpAndSettle();
        expect(find.text(entry.value), findsOneWidget, reason: entry.key);
      }
    });

    testWidgets('no personal certificate in force means the signature cannot be started, and says so', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server, document: outgoing(certificates: <Map<String, Object?>>[certificate(status: 'Revoked'), certificate(kind: 'ORGANIZATION')]));
      await _open(tester, server, _detail);
      expect(find.text('Bạn chưa có chứng thư số cá nhân còn hiệu lực nên chưa ký được.'), findsOneWidget);
      expect(tester.widget<FilledButton>(_start()).onPressed, isNull);
    });
  });

  group('AC-ST-MOB-023-3 UAT-AC427 UAT-AC426 the provider is down: a retryable error, the document stays awaiting signature, nothing is shown as signed', () {
    testWidgets('503 PROVIDER_UNAVAILABLE on starting is retryable with the same key, and nothing says signed', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      int attempt = 0;
      server.answer('POST', '/outgoing-documents/d-1/leader-signing-sessions', (_) {
        attempt += 1;
        return attempt == 1 ? problem(503, 'PROVIDER_UNAVAILABLE') : recorded('s-1', status: 'AWAITING_SIGNER');
      });
      await _open(tester, server, _detail);

      await tester.tap(_start());
      await tester.pumpAndSettle();
      expect(find.text('Chưa kết nối được nhà cung cấp chữ ký số. Văn bản giữ nguyên trạng thái, có thể thử lại.'), findsOneWidget);
      expect(find.text('PROVIDER_UNAVAILABLE'), findsOneWidget);
      expect(find.textContaining('chưa có chữ ký nào được ghi'), findsOneWidget);
      expect(find.text('Kết quả ký'), findsNothing);
      expect(find.text('Chờ lãnh đạo ký'), findsOneWidget);
      expect(find.textContaining('Lãnh đạo đã ký'), findsNothing);

      await tester.tap(find.widgetWithText(OutlinedButton, 'Thử lại'));
      await tester.pumpAndSettle();
      final List<HttpCall> calls = _posts(server);
      expect(calls, hasLength(2));
      expect(calls[1].headers['idempotency-key'], calls[0].headers['idempotency-key'], reason: 'the retry is the same command');
      expect(find.text('Đã ghi nhận'), findsOneWidget);
    });

    testWidgets('503 on the confirmation leaves the session and the document as the server holds them, and the retry confirms again', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server, document: outgoing(sessions: <Map<String, Object?>>[session('s-1')]));
      server.answer('POST', '/signing-sessions/s-1/completion', (_) => problem(503, 'PROVIDER_UNAVAILABLE'));
      await _open(tester, server, _detail);
      await tester.enterText(_otp(), '482913');
      await tester.tap(_confirm());
      await tester.pumpAndSettle();

      expect(find.text('Chưa kết nối được nhà cung cấp chữ ký số. Văn bản giữ nguyên trạng thái, có thể thử lại.'), findsOneWidget);
      expect(find.text('Kết quả ký'), findsNothing);
      expect(find.textContaining('Lãnh đạo đã ký văn bản'), findsNothing);
      expect(_confirm(), findsOneWidget, reason: 'the session is still open to confirm');
      expect(server.callsTo('GET', '/outgoing-documents/d-1'), hasLength(2), reason: 'the document is read again after a refusal');
    });

    testWidgets('a signing adapter that is not ready is retryable too', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      server.answer('POST', '/outgoing-documents/d-1/leader-signing-sessions', (_) => problem(503, 'SIGNING_ADAPTER_UNAVAILABLE'));
      await _open(tester, server, _detail);
      await tester.tap(_start());
      await tester.pumpAndSettle();
      expect(find.text('Dịch vụ ký số được chọn chưa sẵn sàng cho tổ chức này. Có thể thử lại sau.'), findsOneWidget);
      expect(find.widgetWithText(OutlinedButton, 'Thử lại'), findsOneWidget);
    });

    testWidgets('offline the signing buttons are disabled with the reason, no command is queued and nothing is sent', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server, document: outgoing(sessions: <Map<String, Object?>>[session('s-1')]));
      final ProviderContainer container = await _open(tester, server, _detail);
      expect(tester.widget<FilledButton>(_confirm()).onPressed, isNotNull);

      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();
      expect(container.read(reachabilityProvider), Reachability.offline);
      expect(find.textContaining('Cần kết nối mạng để ký'), findsOneWidget);
      expect(tester.widget<FilledButton>(_confirm()).onPressed, isNull);
      await tester.tap(_confirm(), warnIfMissed: false);
      await tester.pumpAndSettle();
      expect(container.read(syncStatusProvider).pendingCommands, 0, reason: 'the offline queue holds no signing command');
      server.offline = false;
      expect(_posts(server), isEmpty);
    });

    testWidgets('a read-only organisation and a document that is no longer waiting say why there is no signature', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      ScriptedServer server = ScriptedServer();
      _reads(server);
      await _open(tester, server, _detail, session: _leader(mode: SessionMode.readOnly));
      expect(find.text('Tổ chức đang ở chế độ chỉ đọc nên chưa thể ký.'), findsOneWidget);
      expect(tester.widget<FilledButton>(_start()).onPressed, isNull);

      server = ScriptedServer();
      _reads(server, document: outgoing(status: 'NUMBERED'));
      await _open(tester, server, _detail);
      expect(find.text('Văn bản không còn chờ lãnh đạo ký.'), findsOneWidget);
    });
  });

  group('AC-ST-MOB-023-4 UI-MOB-67 a biometric only unlocks the credential and is never the signature', () {
    testWidgets('with the one-time code of the certificate authority the biometric is never asked and nothing of it is sent', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server, document: outgoing(sessions: <Map<String, Object?>>[session('s-1')]));
      server.answer('POST', '/signing-sessions/s-1/completion', (_) => recorded('s-1', status: 'EMBEDDED'));
      final _Rig rig = _Rig();
      await _open(tester, server, _detail, rig: rig);
      await tester.enterText(_otp(), '482913');
      await tester.tap(_confirm());
      await tester.pumpAndSettle();
      expect(rig.gate.asked, 0);
      expect(_posts(server).single.body, '{"otp_confirmation":"482913"}');
    });

    testWidgets('with a key held on the phone the prompt comes first, then the digest is signed and the proof (not the prompt) is sent', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server, document: outgoing(sessions: <Map<String, Object?>>[session('s-1')]));
      server.answer('POST', '/signing-sessions/s-1/completion', (_) => recorded('s-1', status: 'EMBEDDED'));
      final _Rig rig = _Rig();
      final FakeSdkPort sdk = FakeSdkPort();
      rig.port = sdk;
      await _open(tester, server, _detail, rig: rig);
      expect(_otp(), findsNothing, reason: 'the SDK signs by itself, no code is typed');

      await tester.tap(_confirm());
      await tester.pumpAndSettle();
      expect(rig.gate.asked, 1);
      expect(sdk.challenges.single.sessionId, 's-1');
      expect(sdk.challenges.single.digestHex, kDigest);
      final String body = _posts(server).single.body!;
      expect(body, '{"cms_signature":"Q01TLXNpZ25hdHVyZQ==","client_digest_hex":"$kDigest"}');
      expect(body.toLowerCase(), isNot(contains('biometric')));
      expect(body, isNot(contains('otp_confirmation')));
    });

    testWidgets('a refused prompt sends nothing: the unlock is a condition, never a substitute', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server, document: outgoing(sessions: <Map<String, Object?>>[session('s-1')]));
      final _Rig rig = _Rig();
      rig.gate.allow = false;
      final FakeSdkPort sdk = FakeSdkPort();
      rig.port = sdk;
      await _open(tester, server, _detail, rig: rig);

      await tester.tap(_confirm());
      await tester.pumpAndSettle();
      expect(rig.gate.asked, 1);
      expect(sdk.challenges, isEmpty, reason: 'the key was not used');
      expect(_posts(server), isEmpty);
      expect(find.textContaining('Chưa mở khóa được thông tin ký nên chưa gửi gì'), findsOneWidget);
    });

    testWidgets('an unlocked credential with no proof from the SDK is still not a signature', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server, document: outgoing(sessions: <Map<String, Object?>>[session('s-1')]));
      final _Rig rig = _Rig();
      rig.port = _Cancelled();
      await _open(tester, server, _detail, rig: rig);
      await tester.tap(_confirm());
      await tester.pumpAndSettle();
      expect(rig.gate.asked, 1);
      expect(_posts(server), isEmpty);
    });

    test('the one-time code port gives a proof only for a code that is there and not longer than the server takes', () async {
      const RemoteCaOtpPort port = RemoteCaOtpPort();
      const SigningChallenge challenge = SigningChallenge(sessionId: 's', digestHex: 'd');
      expect((await port.prove(challenge, typedCode: ' 123456 '))!.otpConfirmation, '123456');
      expect(await port.prove(challenge), isNull);
      expect(await port.prove(challenge, typedCode: '   '), isNull);
      expect(await port.prove(challenge, typedCode: 'x' * 65), isNull);
      expect(port.adapterCode, 'REMOTE_CA');
      expect(port.needsTypedCode, isTrue);
      expect(port.unlocksCredential, isFalse);
    });
  });

  group('UI-MOB-67 the english interface', () {
    testWidgets('the screen speaks english', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      await _open(tester, server, _detail, locale: const Locale('en'));
      expect(find.text('Waiting for the leader to sign'), findsOneWidget);
      expect(find.text('Start signing'), findsOneWidget);
      expect(find.text('View the PDF'), findsOneWidget);
    });
  });
}

/// A port whose signer gave nothing (the SDK was cancelled).
final class _Cancelled implements SigningPort {
  @override
  String get adapterCode => 'LOCAL_AGENT';

  @override
  bool get needsTypedCode => false;

  @override
  bool get unlocksCredential => true;

  @override
  Future<Readiness> readiness({SigningCertificate? certificate}) async => Readiness.ready;

  @override
  Future<SigningProof?> prove(SigningChallenge challenge, {String? typedCode}) async => null;
}
