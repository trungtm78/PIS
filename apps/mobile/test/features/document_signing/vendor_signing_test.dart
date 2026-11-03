import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/features/document_signing/document_fetcher.dart';
import 'package:machvon_mobile/features/document_signing/document_signing_feature.dart' as signing;
import 'package:machvon_mobile/features/document_signing/pdf_engine.dart';
import 'package:machvon_mobile/features/document_signing/signing_models.dart';
import 'package:machvon_mobile/features/document_signing/signing_port.dart';
import 'package:machvon_mobile/features/document_signing/vendor_sdk.dart';
import 'package:machvon_mobile/features/document_signing/vendor_signing_port.dart';
import 'package:machvon_mobile/features/session/auth/biometric_gate.dart';
import 'package:machvon_mobile/features/session/session_providers.dart';

import '../../support/harness.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'support.dart';

const String _detail = '/approval/mob-67?doc=d-1';
const String _holder = 'CN=Lê Lãnh Đạo,O=UBND tỉnh A';
final String _cms = base64.encode(utf8.encode('CMS-DER-bytes'));

/// A provider SDK that is only a script: it says what it holds, signs the digest it is given as it is told to, and records what it was asked.
final class FakeSdk implements VendorSigningSdk {
  FakeSdk({this.holder = _holder});

  SdkAvailability state = SdkAvailability.ready;
  String holder;
  bool enrolled = true;

  /// The SDK cannot say what it holds (the secure element is busy, nothing is enrolled).
  SdkFailureKind? identityFails;
  SdkFailureKind? failWith;

  /// What the SDK reports signing as, when it is not what it was given or who holds the certificate.
  String? signedDigest;
  String? signedAs;
  String? cms;
  final List<String> signed = <String>[];
  final List<String> reasons = <String>[];

  @override
  Future<SdkAvailability> availability() async => state;

  @override
  Future<SdkIdentity?> identity() async {
    if (identityFails != null) throw SdkException(identityFails!);
    return enrolled ? SdkIdentity(subjectDn: holder) : null;
  }

  @override
  Future<SdkSignature> signDigest({required String digestHex, required String reason}) async {
    signed.add(digestHex);
    reasons.add(reason);
    if (failWith != null) throw SdkException(failWith!);
    return SdkSignature(cmsBase64: cms ?? _cms, digestHex: signedDigest ?? digestHex, signer: SdkIdentity(subjectDn: signedAs ?? holder));
  }
}

final class _Gate implements BiometricGate {
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

FakeSession _leader() => FakeSession(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1', membershipId: 'mem-1'));

Future<ProviderContainer> _open(WidgetTester tester, ScriptedServer server, FakeSdk sdk, _Gate gate, {String location = _detail}) {
  return pumpWithServer(
    tester,
    features: <MobileFeature>[signing.feature],
    server: server,
    location: location,
    session: _leader(),
    overrides: [
      pdfEngineProvider.overrideWithValue(FakePdfEngine(<String, List<int>>{'final': <int>[0, 0, 0], 'draft': <int>[0, 0]})),
      documentFetcherProvider.overrideWithValue(FakeFetcher(<String, Uint8List>{})),
      signingPortProvider.overrideWith((Ref ref) => VendorSdkSigningPort(sdk)),
      biometricGateProvider.overrideWithValue(gate),
    ],
  );
}

/// The server of a document that waits for the leader; the commands move its document the way the real one does.
final class _Rig {
  _Rig({String? signature}) : signatureSubject = signature ?? _holder {
    server
      ..on('GET', '/outgoing-documents', (_) => page(<Object?>[document]))
      ..on('GET', '/outgoing-documents/d-1', (_) => document)
      ..answer('POST', '/outgoing-documents/d-1/leader-signing-sessions', (_) {
        starts += 1;
        document = outgoing(version: 8, sessions: <Map<String, Object?>>[session('s-1')]);
        return recorded('s-1', status: 'AWAITING_SIGNER');
      })
      ..answer('POST', '/signing-sessions/s-1/completion', (_) {
        completions += 1;
        final Map<String, Object?> signed = signedOutgoing();
        document = <String, Object?>{
          ...signed,
          'signatures': <Object?>[
            <String, Object?>{'role': 'LEADER', 'status': 'VALID', 'subject_dn': signatureSubject, 'signed_at': '2026-11-03T03:05:00Z', 'incremental_changes_allowed': true, 'findings': <Object?>[]},
          ],
        };
        return recorded('s-1', status: 'EMBEDDED');
      });
  }

  final ScriptedServer server = ScriptedServer();
  final String signatureSubject;
  Map<String, Object?> document = outgoing();
  int starts = 0;
  int completions = 0;
}

Finder _start() => find.widgetWithText(FilledButton, 'Bắt đầu ký');
Finder _confirm() => find.widgetWithText(FilledButton, 'Xác nhận và ký');

List<HttpCall> _posts(ScriptedServer server) => server.calls.where((HttpCall call) => call.method == 'POST').toList();

void main() {
  group('AC-ST-MOB-032-1 UAT-AC430 TK-MOB-032-1 TK-MOB-032-2 a document signed through the provider SDK carries a valid signature of the holder of the certificate', () {
    testWidgets('the SDK signs the digest the server locked, the proof is its CMS signature and that digest, and the result read back is valid with the signer matching the certificate', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final _Rig rig = _Rig();
      final FakeSdk sdk = FakeSdk();
      final _Gate gate = _Gate();
      await _open(tester, rig.server, sdk, gate);
      expect(find.text('Bộ ký số của nhà cung cấp trên điện thoại'), findsOneWidget, reason: 'the method is said');

      await tester.tap(_start());
      await tester.pumpAndSettle();
      final HttpCall started = _posts(rig.server).single;
      expect(started.body, contains('"adapter_code":"LOCAL_AGENT"'));
      expect(started.body, contains('"certificate_id":"cert-1"'));
      expect(find.widgetWithText(TextField, 'Mã xác nhận (OTP)'), findsNothing, reason: 'the SDK signs by itself, no code is typed');

      await tester.tap(_confirm());
      await tester.pumpAndSettle();
      expect(gate.asked, 1, reason: 'the credential is unlocked first');
      expect(sdk.signed, <String>[kDigest], reason: 'only the digest is given to the SDK, never the document');
      expect(sdk.reasons.single, 'Quyết định giao vốn năm 2026', reason: 'the SDK tells the signer what they sign');
      final HttpCall completed = _posts(rig.server).last;
      expect(completed.url.path, endsWith('/signing-sessions/s-1/completion'));
      expect(completed.body, '{"cms_signature":"$_cms","client_digest_hex":"$kDigest"}');
      expect(completed.body, isNot(contains('otp_confirmation')));

      expect(find.text('Kết quả ký'), findsOneWidget);
      expect(find.text('Hợp lệ'), findsOneWidget, reason: 'the verdict is the server\'s verification');
      expect(find.text('Người ký trên chữ ký là chủ chứng thư đã đăng ký cho bạn.'), findsOneWidget);
      expect(find.text(_holder), findsWidgets);
      expect(find.textContaining('KHÔNG phải chủ chứng thư'), findsNothing);
    });

    testWidgets('a signature the server verifies for someone other than the holder of the registered certificate is a warning, never a success', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final _Rig rig = _Rig(signature: 'CN=Người Khác,O=UBND tỉnh A');
      await _open(tester, rig.server, FakeSdk(), _Gate());
      await tester.tap(_start());
      await tester.pumpAndSettle();
      await tester.tap(_confirm());
      await tester.pumpAndSettle();
      expect(find.textContaining('KHÔNG phải chủ chứng thư đã đăng ký'), findsOneWidget);
      expect(find.text('Người ký trên chữ ký là chủ chứng thư đã đăng ký cho bạn.'), findsNothing);
    });

    testWidgets('an SDK that signed as someone other than the registered certificate is not sent: the server never sees the signature', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final _Rig rig = _Rig();
      final FakeSdk sdk = FakeSdk()..signedAs = 'CN=Người Khác,O=UBND tỉnh A';
      await _open(tester, rig.server, sdk, _Gate());
      await tester.tap(_start());
      await tester.pumpAndSettle();
      await tester.tap(_confirm());
      await tester.pumpAndSettle();
      expect(find.textContaining('không phải chứng thư đã đăng ký cho bạn'), findsOneWidget);
      expect(rig.completions, 0);
      expect(find.text('Kết quả ký'), findsNothing);
      expect(find.widgetWithText(OutlinedButton, 'Thử lại'), findsNothing, reason: 'trying again does not change whose certificate it is');
    });

    testWidgets('an SDK that signed other content than the digest the server locked is not sent', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final _Rig rig = _Rig();
      final FakeSdk sdk = FakeSdk()..signedDigest = 'f' * 64;
      await _open(tester, rig.server, sdk, _Gate());
      await tester.tap(_start());
      await tester.pumpAndSettle();
      await tester.tap(_confirm());
      await tester.pumpAndSettle();
      expect(find.textContaining('khác với nội dung máy chủ đã chốt'), findsOneWidget);
      expect(rig.completions, 0);
    });

    testWidgets('a certificate in the SDK that is not the registered one stops the signature before any session is opened', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final _Rig rig = _Rig();
      await _open(tester, rig.server, FakeSdk(holder: 'CN=Người Khác,O=UBND tỉnh A'), _Gate());
      await tester.tap(_start());
      await tester.pumpAndSettle();
      expect(find.textContaining('không phải chứng thư đã đăng ký cho bạn'), findsOneWidget);
      expect(rig.starts, 0);
      expect(_posts(rig.server), isEmpty);
    });

    testWidgets('an SDK with no certificate enrolled opens no session either', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final _Rig rig = _Rig();
      await _open(tester, rig.server, FakeSdk()..enrolled = false, _Gate());
      await tester.tap(_start());
      await tester.pumpAndSettle();
      expect(find.text('Chưa có chứng thư số nào trong bộ ký số trên điện thoại này.'), findsOneWidget);
      expect(_posts(rig.server), isEmpty);
    });

    testWidgets('closing the confirmation of the SDK (PIN or biometric) signs nothing and sends nothing', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final _Rig rig = _Rig();
      final FakeSdk sdk = FakeSdk()..failWith = SdkFailureKind.cancelled;
      await _open(tester, rig.server, sdk, _Gate());
      await tester.tap(_start());
      await tester.pumpAndSettle();
      await tester.tap(_confirm());
      await tester.pumpAndSettle();
      expect(sdk.signed, hasLength(1));
      expect(rig.completions, 0);
      expect(find.textContaining('Chưa mở khóa được thông tin ký nên chưa gửi gì'), findsOneWidget);
    });
  });

  group('AC-ST-MOB-032-2 UAT-AC406 a revoked or expired certificate creates no session', () {
    testWidgets('the server refuses the start with 422 CERTIFICATE_NOT_ACTIVE: no session is open afterwards, the SDK is never asked to sign and nothing is completed', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final _Rig rig = _Rig();
      rig.server.answer('POST', '/outgoing-documents/d-1/leader-signing-sessions', (_) => problem(422, 'CERTIFICATE_NOT_ACTIVE', detail: 'certificate_id'));
      final FakeSdk sdk = FakeSdk();
      await _open(tester, rig.server, sdk, _Gate());
      await tester.tap(_start());
      await tester.pumpAndSettle();

      expect(find.text('Chứng thư chọn để ký không còn hiệu lực hoặc không thuộc người ký.'), findsOneWidget);
      expect(find.text('CERTIFICATE_NOT_ACTIVE'), findsOneWidget);
      expect(_confirm(), findsNothing, reason: 'there is no session to confirm');
      expect(_start(), findsOneWidget, reason: 'the document still waits for its signature');
      expect(sdk.signed, isEmpty);
      expect(rig.completions, 0);
      expect(find.text('Kết quả ký'), findsNothing);
      expect(find.widgetWithText(OutlinedButton, 'Thử lại'), findsNothing, reason: 'a revoked certificate is not made good by trying again');
    });

    testWidgets('the SDK reporting the certificate revoked, expired or suspended at signing time sends nothing, and the session left open is not completed', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final _Rig rig = _Rig();
      final FakeSdk sdk = FakeSdk()..failWith = SdkFailureKind.certificateNotActive;
      await _open(tester, rig.server, sdk, _Gate());
      await tester.tap(_start());
      await tester.pumpAndSettle();
      await tester.tap(_confirm());
      await tester.pumpAndSettle();
      expect(find.textContaining('đã bị thu hồi, hết hạn hoặc bị tạm dừng'), findsOneWidget);
      expect(rig.completions, 0);
      expect(find.widgetWithText(OutlinedButton, 'Thử lại'), findsNothing);
    });
  });

  group('AC-ST-MOB-032-3 UAT-AC427 TK-MOB-032-4 the SDK unavailable is a retryable state and never a partial signature', () {
    testWidgets('unavailable before the start: no session is created, the state is retryable, and the retry starts it once the SDK is back', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final _Rig rig = _Rig();
      final FakeSdk sdk = FakeSdk()..state = SdkAvailability.unavailable;
      await _open(tester, rig.server, sdk, _Gate());
      await tester.tap(_start());
      await tester.pumpAndSettle();

      expect(find.text('Bộ ký số của nhà cung cấp chưa dùng được lúc này.'), findsOneWidget);
      expect(find.textContaining('chưa có chữ ký nào được ghi và chưa gửi gì tới máy chủ. Bạn có thể thử lại'), findsOneWidget);
      expect(_posts(rig.server), isEmpty, reason: 'no session was created on the server');
      expect(find.text('Kết quả ký'), findsNothing);

      sdk.state = SdkAvailability.ready;
      await tester.tap(find.widgetWithText(OutlinedButton, 'Thử lại'));
      await tester.pumpAndSettle();
      expect(rig.starts, 1);
      expect(find.text('Bộ ký số của nhà cung cấp chưa dùng được lúc này.'), findsNothing);
      expect(_confirm(), findsOneWidget);
    });

    testWidgets('an SDK that is not part of the build is the same state', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final _Rig rig = _Rig();
      await _open(tester, rig.server, FakeSdk()..state = SdkAvailability.notInstalled, _Gate());
      await tester.tap(_start());
      await tester.pumpAndSettle();
      expect(find.text('Bộ ký số của nhà cung cấp chưa dùng được lúc này.'), findsOneWidget);
      expect(_posts(rig.server), isEmpty);
    });

    testWidgets('unavailable at the signature: nothing is completed, the document does not say signed, and the retry completes once, with one signature', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final _Rig rig = _Rig();
      final FakeSdk sdk = FakeSdk()..failWith = SdkFailureKind.unavailable;
      await _open(tester, rig.server, sdk, _Gate());
      await tester.tap(_start());
      await tester.pumpAndSettle();
      await tester.tap(_confirm());
      await tester.pumpAndSettle();

      expect(find.text('Bộ ký số của nhà cung cấp chưa dùng được lúc này.'), findsOneWidget);
      expect(rig.completions, 0, reason: 'no signature, not even a partial one');
      expect(find.text('Kết quả ký'), findsNothing);
      expect(find.textContaining('Lãnh đạo đã ký văn bản'), findsNothing);
      expect(_confirm(), findsOneWidget, reason: 'the session is still open');

      sdk.failWith = null;
      await tester.tap(find.widgetWithText(OutlinedButton, 'Thử lại'));
      await tester.pumpAndSettle();
      expect(rig.completions, 1);
      expect(find.text('Kết quả ký'), findsOneWidget);
      expect(find.text('Bộ ký số của nhà cung cấp chưa dùng được lúc này.'), findsNothing);
    });

    testWidgets('an SDK that fails in a way nobody classified is said once and is also retryable', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final _Rig rig = _Rig();
      final FakeSdk sdk = FakeSdk()..failWith = SdkFailureKind.failed;
      await _open(tester, rig.server, sdk, _Gate());
      await tester.tap(_start());
      await tester.pumpAndSettle();
      await tester.tap(_confirm());
      await tester.pumpAndSettle();
      expect(find.text('Bộ ký số gặp lỗi nên chưa ký được.'), findsOneWidget);
      expect(find.widgetWithText(OutlinedButton, 'Thử lại'), findsOneWidget);
      expect(rig.completions, 0);
    });

    testWidgets('a provider that is down on the server (503 PROVIDER_UNAVAILABLE) is still said as retryable with the SDK port', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final _Rig rig = _Rig();
      rig.server.answer('POST', '/signing-sessions/s-1/completion', (_) => problem(503, 'PROVIDER_UNAVAILABLE'));
      await _open(tester, rig.server, FakeSdk(), _Gate());
      await tester.tap(_start());
      await tester.pumpAndSettle();
      await tester.tap(_confirm());
      await tester.pumpAndSettle();
      expect(find.text('PROVIDER_UNAVAILABLE'), findsOneWidget);
      expect(find.text('Kết quả ký'), findsNothing);
      expect(find.widgetWithText(OutlinedButton, 'Thử lại'), findsOneWidget);
    });
  });

  group('UI-MOB-67 the signing screen with the provider SDK keeps the screen contract', () {
    testWidgets('the contract holds on the screen with an open session, with the SDK unavailable and with the result', (WidgetTester tester) async {
      Future<void> open(WidgetTester t, ScriptedServer s) async {
        await _open(t, s, FakeSdk()..state = SdkAvailability.unavailable, _Gate());
        await t.scrollUntilVisible(_start(), 300, scrollable: find.byType(Scrollable).hitTestable().first);
        await t.tap(_start());
        await t.pumpAndSettle();
      }

      await expectScreenContract(tester, open: open, healthy: (ScriptedServer s) => s.on('GET', '/outgoing-documents/d-1', (_) => outgoing()));
      Future<void> opened(WidgetTester t, ScriptedServer s) async => _open(t, s, FakeSdk(), _Gate());
      await expectScreenContract(tester, open: opened, healthy: (ScriptedServer s) => s.on('GET', '/outgoing-documents/d-1', (_) => signedOutgoing()));
    });
  });

  group('TK-MOB-032-1 the port and the channel to the native module', () {
    test('readiness: ready only with an SDK that can sign and a certificate that is the registered one', () async {
      const SigningCertificate registered = SigningCertificate(id: 'c', kind: 'PERSONAL', subject: _holder, validUntil: '2027-01-01', status: 'Active');
      final FakeSdk sdk = FakeSdk();
      final VendorSdkSigningPort port = VendorSdkSigningPort(sdk);
      expect(await port.readiness(certificate: registered), Readiness.ready);
      expect(await port.readiness(), Readiness.ready, reason: 'with no registered certificate to compare there is nothing to differ');
      sdk.holder = 'o=UBND tỉnh A, cn=Lê Lãnh Đạo';
      expect(await port.readiness(certificate: registered), Readiness.ready, reason: 'the order and the case of the attribute types do not matter');
      sdk.holder = 'CN=Người Khác,O=UBND tỉnh A';
      expect(await port.readiness(certificate: registered), Readiness.identityMismatch);
      sdk.enrolled = false;
      expect(await port.readiness(certificate: registered), Readiness.noCertificate);
      sdk
        ..enrolled = true
        ..state = SdkAvailability.unavailable;
      expect(await port.readiness(certificate: registered), Readiness.unavailable);
    });

    test('readiness: an SDK that cannot say what it holds is "no certificate" when nothing is enrolled and "unavailable" otherwise, and says nothing of the vendor', () async {
      final FakeSdk sdk = FakeSdk()..identityFails = SdkFailureKind.noCertificate;
      final VendorSdkSigningPort port = VendorSdkSigningPort(sdk);
      expect(await port.readiness(), Readiness.noCertificate);
      sdk.identityFails = SdkFailureKind.unavailable;
      expect(await port.readiness(), Readiness.unavailable);
      sdk.identityFails = SdkFailureKind.failed;
      expect(await port.readiness(), Readiness.unavailable);
      expect(const SigningPortException(PortFailureKind.unavailable).toString(), 'SigningPortException(unavailable)');
      expect(const SdkException(SdkFailureKind.cancelled).toString(), 'SdkException(cancelled)');
    });

    test('the port is the agent that signs on the signer\'s own device, with the credential behind a prompt and no code to type', () {
      final VendorSdkSigningPort port = VendorSdkSigningPort(FakeSdk());
      expect(port.adapterCode, 'LOCAL_AGENT');
      expect(port.needsTypedCode, isFalse);
      expect(port.unlocksCredential, isTrue);
    });

    test('prove: a digest that is not 64 hexadecimal digits is never given to the SDK, and a signature that is not base64 is never sent', () async {
      final FakeSdk sdk = FakeSdk();
      final VendorSdkSigningPort port = VendorSdkSigningPort(sdk);
      await expectLater(port.prove(const SigningChallenge(sessionId: 's', digestHex: 'abc')), throwsA(isA<SigningPortException>().having((SigningPortException e) => e.kind, 'kind', PortFailureKind.failed)));
      expect(sdk.signed, isEmpty);
      sdk.cms = 'not base64 !!';
      await expectLater(port.prove(const SigningChallenge(sessionId: 's', digestHex: kDigest)), throwsA(isA<SigningPortException>().having((SigningPortException e) => e.kind, 'kind', PortFailureKind.failed)));
    });

    test('prove: the digest is compared in lower case and the proof carries the SDK\'s signature with that digest', () async {
      final FakeSdk sdk = FakeSdk();
      final VendorSdkSigningPort port = VendorSdkSigningPort(sdk);
      final SigningProof? proof = await port.prove(SigningChallenge(sessionId: 's', digestHex: kDigest.toUpperCase(), expectedSubject: _holder));
      expect(proof!.cmsSignature, _cms);
      expect(proof.clientDigestHex, kDigest);
      expect(proof.otpConfirmation, isNull);
    });

    test('sameSubject: same attributes in any order, any case of the type, escaped commas kept, and anything malformed names nobody', () {
      expect(sameSubject('CN=A,O=B', 'o=B, cn=A'), isTrue);
      expect(sameSubject(r'CN=Lê\, Văn A,O=B', r'O=B,CN=Lê\, Văn A'), isTrue);
      expect(sameSubject('CN=A', 'CN=A,O=B'), isFalse);
      expect(sameSubject('CN=A,O=B', 'CN=A'), isFalse);
      expect(sameSubject('CN=A,O=B', 'CN=A,O=C'), isFalse);
      expect(sameSubject('', ''), isFalse);
      expect(sameSubject('garbage', 'garbage'), isFalse);
      expect(sameSubject('CN=A,,O=B', 'CN=A,,O=B'), isFalse);
    });

    group('the channel to the native module of the SDK', () {
      const MethodChannel channel = MethodChannel(vendorSigningChannelName);
      const MethodChannelVendorSigningSdk sdk = MethodChannelVendorSigningSdk();

      void answer(Future<Object?> Function(MethodCall call) handler) {
        TestWidgetsFlutterBinding.ensureInitialized();
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, handler);
        addTearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null));
      }

      test('a build with no native module is "not installed", and signing with it is unavailable', () async {
        TestWidgetsFlutterBinding.ensureInitialized();
        expect(await sdk.availability(), SdkAvailability.notInstalled);
        await expectLater(sdk.signDigest(digestHex: kDigest, reason: 'r'), throwsA(isA<SdkException>().having((SdkException e) => e.kind, 'kind', SdkFailureKind.unavailable)));
        await expectLater(sdk.identity(), throwsA(isA<SdkException>()));
      });

      test('the three calls carry exactly the arguments of the contract and read its answers', () async {
        final List<MethodCall> calls = <MethodCall>[];
        answer((MethodCall call) async {
          calls.add(call);
          switch (call.method) {
            case 'availability':
              return 'ready';
            case 'identity':
              return <String, Object?>{'subject_dn': _holder, 'fingerprint_sha256': 'AB' * 32};
            default:
              return <String, Object?>{'cms_base64': _cms, 'digest_hex': kDigest.toUpperCase(), 'subject_dn': _holder};
          }
        });
        expect(await sdk.availability(), SdkAvailability.ready);
        final SdkIdentity? identity = await sdk.identity();
        expect(identity!.subjectDn, _holder);
        expect(identity.fingerprintSha256, 'ab' * 32);
        final SdkSignature signature = await sdk.signDigest(digestHex: kDigest, reason: 'Quyết định');
        expect(signature.cmsBase64, _cms);
        expect(signature.digestHex, kDigest, reason: 'lower case');
        expect(signature.signer.subjectDn, _holder);
        expect(calls.map((MethodCall c) => c.method), <String>['availability', 'identity', 'signDigest']);
        expect(calls.last.arguments, <String, Object?>{'digest_hex': kDigest, 'reason': 'Quyết định'});
      });

      test('availability: "unavailable", anything else and a platform error are all "unavailable"; "not_installed" is its own', () async {
        for (final MapEntry<Object?, SdkAvailability> entry in <Object?, SdkAvailability>{'unavailable': SdkAvailability.unavailable, 'who knows': SdkAvailability.unavailable, 'not_installed': SdkAvailability.notInstalled, null: SdkAvailability.unavailable}.entries) {
          answer((MethodCall call) async => entry.key);
          expect(await sdk.availability(), entry.value, reason: '${entry.key}');
        }
        answer((MethodCall call) async => throw PlatformException(code: 'X'));
        expect(await sdk.availability(), SdkAvailability.unavailable);
      });

      test('the codes of the native module become the kinds of failure, and the vendor\'s own text is dropped', () async {
        final Map<String, SdkFailureKind> kinds = <String, SdkFailureKind>{
          'SDK_UNAVAILABLE': SdkFailureKind.unavailable,
          'USER_CANCELLED': SdkFailureKind.cancelled,
          'CERTIFICATE_NOT_ACTIVE': SdkFailureKind.certificateNotActive,
          'NO_CERTIFICATE': SdkFailureKind.noCertificate,
          'ANYTHING_ELSE': SdkFailureKind.failed,
        };
        for (final MapEntry<String, SdkFailureKind> entry in kinds.entries) {
          answer((MethodCall call) async => throw PlatformException(code: entry.key, message: 'vendor text with a PIN 123456'));
          await expectLater(sdk.signDigest(digestHex: kDigest, reason: 'r'), throwsA(isA<SdkException>().having((SdkException e) => e.kind, 'kind', entry.value).having((SdkException e) => e.toString(), 'text', isNot(contains('123456')))), reason: entry.key);
        }
      });

      test('an answer that lacks the signature, the digest or the signer is a failure, never a half signature', () async {
        for (final Object? bad in <Object?>[
          null,
          <String, Object?>{'digest_hex': kDigest, 'subject_dn': _holder},
          <String, Object?>{'cms_base64': '', 'digest_hex': kDigest, 'subject_dn': _holder},
          <String, Object?>{'cms_base64': _cms, 'subject_dn': _holder},
          <String, Object?>{'cms_base64': _cms, 'digest_hex': kDigest},
          <String, Object?>{'cms_base64': _cms, 'digest_hex': kDigest, 'subject_dn': '  '},
        ]) {
          answer((MethodCall call) async => bad);
          await expectLater(sdk.signDigest(digestHex: kDigest, reason: 'r'), throwsA(isA<SdkException>().having((SdkException e) => e.kind, 'kind', SdkFailureKind.failed)), reason: '$bad');
        }
      });

      test('no certificate enrolled is null, and a nameless one too', () async {
        answer((MethodCall call) async => null);
        expect(await sdk.identity(), isNull);
        answer((MethodCall call) async => <String, Object?>{'subject_dn': ''});
        expect(await sdk.identity(), isNull);
      });
    });
  });
}
