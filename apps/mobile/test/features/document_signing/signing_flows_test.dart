import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/core/sync/sync_status.dart';
import 'package:machvon_mobile/features/document_signing/document_signing_feature.dart' as signing;
import 'package:machvon_mobile/features/document_signing/signing_port.dart';
import 'package:machvon_mobile/features/session/auth/biometric_gate.dart';
import 'package:machvon_mobile/features/session/session_providers.dart';

import '../../support/harness.dart';
import '../support/screen_contract.dart' show kTallDevice;
import '../support/scripted_server.dart';
import 'support.dart';

/// The flows around the signing screens that a widget test of one component does not reach (MUX-3 wave B, R39): the approval of a document is
/// never made on a copy kept on the phone, whether the phone is offline or the copy is old, and a document that another person changed is read
/// again and compared before anything is sent a second time: the phone never overwrites what it did not read.

const String _detail = '/approval/mob-67?doc=d-1';

FakeSession _leader() => FakeSession(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1', membershipId: 'mem-1', mode: SessionMode.full));

final class _Gate implements BiometricGate {
  int asked = 0;

  @override
  Future<bool> isAvailable() async => true;

  @override
  Future<bool> authenticate({required String reason}) async {
    asked += 1;
    return true;
  }
}

Future<ProviderContainer> _open(WidgetTester tester, ScriptedServer server, {_Gate? gate, DateTime Function()? now}) {
  useDevice(tester, kTallDevice);
  return pumpWithServer(
    tester,
    features: <MobileFeature>[signing.feature],
    server: server,
    location: _detail,
    session: _leader(),
    now: now,
    overrides: [
      signingPortProvider.overrideWith((Ref ref) => const RemoteCaOtpPort()),
      biometricGateProvider.overrideWithValue(gate ?? _Gate()),
    ],
  );
}

Finder _start() => find.widgetWithText(FilledButton, 'Bắt đầu ký');
Finder _confirm() => find.widgetWithText(FilledButton, 'Xác nhận và ký');
Finder _otp() => find.widgetWithText(TextField, 'Mã xác nhận (OTP)');

List<HttpCall> _posts(ScriptedServer server) => server.calls.where((HttpCall call) => call.method == 'POST').toList();

void main() {
  group('R39 a document is never signed on a copy kept on the phone', () {
    testWidgets('an old copy shown after the connection was lost locks the signature with the reason, opens no sheet and sends nothing', (WidgetTester tester) async {
      final ScriptedServer server = ScriptedServer();
      server.on('GET', '/outgoing-documents/d-1', (_) => outgoing(sessions: <Map<String, Object?>>[session('s-1')]));
      DateTime clock = DateTime.utc(2026, 11, 3, 3);
      final ProviderContainer container = await _open(tester, server, now: () => clock);
      expect(tester.widget<FilledButton>(_confirm()).onPressed, isNotNull, reason: 'online, on a read that just came from the server, the signature is offered');

      clock = clock.add(const Duration(hours: 13));
      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();

      expect(find.textContaining('Bản lưu đã quá 12 giờ'), findsOneWidget, reason: 'the copy says how old it is');
      expect(find.textContaining('Cần kết nối mạng để ký'), findsOneWidget, reason: 'the reason is written beside the locked button');
      expect(tester.widget<FilledButton>(_confirm()).onPressed, isNull);
      await tester.tap(_confirm(), warnIfMissed: false);
      await tester.pumpAndSettle();
      expect(find.text('Ký văn bản này?'), findsNothing, reason: 'no sheet opens from a locked button');
      expect(container.read(syncStatusProvider).pendingCommands, 0, reason: 'nothing is queued to be sent later');
      expect(container.read(reachabilityProvider), Reachability.offline);
      server.offline = false;
      expect(_posts(server), isEmpty);
    });

    testWidgets('the copy of a document that was never signed offers no session either: "Bắt đầu ký" is locked and says why', (WidgetTester tester) async {
      final ScriptedServer server = ScriptedServer();
      server.on('GET', '/outgoing-documents/d-1', (_) => outgoing());
      await _open(tester, server);
      expect(tester.widget<FilledButton>(_start()).onPressed, isNotNull);

      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();
      expect(tester.widget<FilledButton>(_start()).onPressed, isNull);
      expect(find.textContaining('Cần kết nối mạng để ký'), findsOneWidget);
      expect(_posts(server), isEmpty);
    });
  });

  group('R39 a document that another person changed is read again before anything is sent a second time', () {
    testWidgets('a version conflict on starting says so with its code, reads the document again and the next start carries the new version', (WidgetTester tester) async {
      final ScriptedServer server = ScriptedServer();
      Map<String, Object?> document = outgoing(version: 7);
      int starts = 0;
      server
        ..on('GET', '/outgoing-documents/d-1', (_) => document)
        ..answer('POST', '/outgoing-documents/d-1/leader-signing-sessions', (_) {
          starts += 1;
          if (starts == 1) return problem(409, 'VERSION_CONFLICT');
          return recorded('s-1', status: 'AWAITING_SIGNER');
        });
      await _open(tester, server);
      expect(server.callsTo('GET', '/outgoing-documents/d-1'), hasLength(1));

      // The other person changes the document (a new version, a new title) after the phone read it and before the phone sends.
      document = <String, Object?>{...outgoing(version: 8), 'title': 'Quyết định giao vốn năm 2026 (đã sửa)'};
      await tester.tap(_start());
      await tester.pumpAndSettle();

      expect(find.text('Văn bản vừa được người khác thay đổi. Hãy mở lại màn hình rồi thử lại.'), findsOneWidget);
      expect(find.text('VERSION_CONFLICT'), findsOneWidget);
      expect(server.callsTo('GET', '/outgoing-documents/d-1'), hasLength(2), reason: 'the document is read again after the refusal');
      expect(find.text('Quyết định giao vốn năm 2026 (đã sửa)'), findsOneWidget, reason: 'what the person now sees is what the server holds');
      expect(_posts(server), hasLength(1), reason: 'nothing was sent twice on its own');

      await tester.tap(_start());
      await tester.pumpAndSettle();
      final List<HttpCall> posts = _posts(server);
      expect(posts, hasLength(2));
      expect(posts[0].headers['if-match'], '"7"');
      expect(posts[1].headers['if-match'], '"8"', reason: 'the second command carries the version that was read, never the old one');
      expect(posts[1].headers['idempotency-key'], isNot(posts[0].headers['idempotency-key']), reason: 'it is a new intention on a new document');
    });

    testWidgets('a conflict on the confirmation leaves the session and the code on the screen, and nothing says signed', (WidgetTester tester) async {
      final ScriptedServer server = ScriptedServer();
      server
        ..on('GET', '/outgoing-documents/d-1', (_) => outgoing(sessions: <Map<String, Object?>>[session('s-1')]))
        ..answer('POST', '/signing-sessions/s-1/completion', (_) => problem(409, 'VERSION_CONFLICT'));
      await _open(tester, server);
      await tester.enterText(_otp(), '482913');
      await tester.tap(_confirm());
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Ký văn bản này'));
      await tester.pumpAndSettle();

      expect(find.text('VERSION_CONFLICT'), findsOneWidget);
      expect(find.text('Kết quả ký'), findsNothing, reason: 'a refused signature is not a signature');
      expect(tester.widget<TextField>(_otp()).controller!.text, '482913', reason: 'what was typed stays to be sent again');
      expect(server.callsTo('GET', '/outgoing-documents/d-1'), hasLength(2), reason: 'read again after the refusal');
    });
  });

  group('R39 the confirmation sheet says what the signature does, and the signature is made only when it is confirmed', () {
    testWidgets('the sheet names the document, the certificate, the effect and the audit log; "Review again" signs nothing', (WidgetTester tester) async {
      final ScriptedServer server = ScriptedServer();
      server.on('GET', '/outgoing-documents/d-1', (_) => outgoing(sessions: <Map<String, Object?>>[session('s-1')]));
      final _Gate gate = _Gate();
      await _open(tester, server, gate: gate);
      await tester.enterText(_otp(), '482913');
      await tester.tap(_confirm());
      await tester.pumpAndSettle();

      expect(find.text('Ký văn bản này?'), findsOneWidget);
      expect(find.textContaining('Quyết định giao vốn năm 2026, bản 2, mã băm'), findsOneWidget);
      expect(find.text('Ký bằng chứng thư số CN=Lê Lãnh Đạo,O=UBND tỉnh A'), findsOneWidget);
      expect(find.text('Chữ ký được thêm vào cuối tệp PDF và không thu hồi được trên điện thoại.'), findsOneWidget);
      expect(find.text('Thao tác được ghi vào nhật ký kiểm toán dưới tên bạn.'), findsOneWidget);

      await tester.tap(find.widgetWithText(OutlinedButton, 'Xem lại'));
      await tester.pumpAndSettle();
      expect(find.text('Ký văn bản này?'), findsNothing);
      expect(_posts(server), isEmpty, reason: 'leaving the sheet signs nothing');
      expect(gate.asked, 0);
      expect(tester.widget<TextField>(_otp()).controller!.text, '482913', reason: 'the code stays');
      expect(_confirm(), findsOneWidget, reason: 'the session is still open to confirm');
    });

    testWidgets('a missing code is refused on the screen before the sheet opens', (WidgetTester tester) async {
      final ScriptedServer server = ScriptedServer();
      server.on('GET', '/outgoing-documents/d-1', (_) => outgoing(sessions: <Map<String, Object?>>[session('s-1')]));
      await _open(tester, server);
      await tester.tap(_confirm());
      await tester.pumpAndSettle();
      expect(find.text('Bắt buộc nhập mã xác nhận.'), findsOneWidget);
      expect(find.text('Ký văn bản này?'), findsNothing);
      expect(_posts(server), isEmpty);
    });
  });
}
