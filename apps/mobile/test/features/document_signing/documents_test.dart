import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/features/command_support/command_outcome.dart';
import 'package:machvon_mobile/features/document_signing/document_fetcher.dart';
import 'package:machvon_mobile/features/document_signing/document_signing_feature.dart' as signing;
import 'package:machvon_mobile/features/document_signing/pdf_engine.dart';
import 'package:machvon_mobile/features/document_signing/pdfx_engine.dart';
import 'package:machvon_mobile/features/document_signing/screens/pdf_pages.dart' show PdfViewerPage;
import 'package:machvon_mobile/features/document_signing/signing_commands.dart';
import 'package:machvon_mobile/features/document_signing/signing_models.dart';
import 'package:machvon_mobile/features/document_signing/signing_port.dart';
import 'package:machvon_mobile/features/document_signing/signing_support.dart';
import 'package:pdfx/pdfx.dart' as pdfx;
// The platform interface of pdfx is not exported; a fake of it is how the adapter is tried on the host.
import 'package:pdfx/src/renderer/interfaces/platform.dart' show PdfxPlatform;

import '../../support/harness.dart';
import '../support/screen_contract.dart' show kTallDevice;
import '../support/scripted_server.dart';
import 'support.dart';

const String _detail = '/approval/mob-67?doc=d-1';

Future<ProviderContainer> _open(WidgetTester tester, ScriptedServer server, {PdfEngine? engine, FakeFetcher? fetcher}) {
  final PdfEngine renderer = engine ?? FakePdfEngine(<String, List<int>>{'final': <int>[0, 1, 0], 'draft': <int>[0, 0]});
  final FakeFetcher files = fetcher ??
      FakeFetcher(<String, Uint8List>{
        'https://files.test/final?sig=1': pdfBytes('final'),
        'https://files.test/draft?sig=1': pdfBytes('draft'),
      });
  return pumpWithServer(
    tester,
    features: <MobileFeature>[signing.feature],
    server: server,
    location: _detail,
    session: FakeSession(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1', membershipId: 'mem-1')),
    overrides: [pdfEngineProvider.overrideWithValue(renderer), documentFetcherProvider.overrideWithValue(files)],
  );
}

void _reads(ScriptedServer server) {
  server
    ..on('GET', '/outgoing-documents/d-1', (_) => outgoing())
    ..on('GET', '/document-versions/v-1/download', (_) => download('draft'))
    ..on('GET', '/document-versions/v-2/download', (_) => download('final'));
}

/// A renderer that opens a file only when the test says so, to leave a screen while a file is still being opened.
final class _SlowEngine implements PdfEngine {
  _SlowEngine(Map<String, List<int>> pages) : _inner = FakePdfEngine(pages);

  final FakePdfEngine _inner;
  final List<Completer<void>> _gates = <Completer<void>>[];

  List<FakePdfDoc> get opened => _inner.opened;

  @override
  Future<PdfDoc> open(Uint8List bytes) async {
    final Completer<void> gate = Completer<void>();
    _gates.add(gate);
    await gate.future;
    return _inner.open(bytes);
  }

  /// Lets the [index]th file (in the order they were handed over) be opened.
  void finish(int index) => _gates[index].complete();
}

/// Draws frames until the renderer has been handed [count] files.
Future<void> _untilOpening(WidgetTester tester, _SlowEngine engine, int count) async {
  for (int frame = 0; frame < 50 && engine._gates.length < count; frame += 1) {
    await tester.pump(const Duration(milliseconds: 20));
  }
  expect(engine._gates, hasLength(count));
}

void main() {
  group('UI-MOB-67 TK-MOB-023-1 the viewer shows the final PDF page by page', () {
    testWidgets('fetches the file from the address the server signed, checks it, draws its pages and enlarges one on a tap', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      final FakePdfEngine engine = FakePdfEngine(<String, List<int>>{'final': <int>[0, 1, 0], 'draft': <int>[0, 0]});
      final FakeFetcher fetcher = FakeFetcher(<String, Uint8List>{'https://files.test/final?sig=1': pdfBytes('final')});
      await _open(tester, server, engine: engine, fetcher: fetcher);

      await tester.tap(find.text('Xem PDF'));
      await tester.pumpAndSettle();

      expect(server.callsTo('GET', '/document-versions/v-2/download'), hasLength(1));
      expect(fetcher.asked.single.toString(), 'https://files.test/final?sig=1');
      expect(find.text('Quyết định giao vốn năm 2026 · bản 2 · 3 trang'), findsOneWidget);
      expect(find.byType(Image), findsNWidgets(3));
      expect(engine.opened.single.rendered, <int>[0, 1, 2]);
      expect(server.calls.where((HttpCall call) => call.method != 'GET'), isEmpty, reason: 'reading signs nothing');

      await tester.tap(find.descendant(of: find.byType(PdfViewerPage), matching: find.byType(InkWell)).first);
      await tester.pumpAndSettle();
      expect(find.text('Trang 1/3'), findsOneWidget);
      expect(find.byType(InteractiveViewer), findsOneWidget);

      await pressBack(tester);
      await pressBack(tester);
      expect(engine.opened.single.closed, isTrue, reason: 'the document is closed with the screen; its bytes were only ever in memory');
    });

    testWidgets('the file is refused, with the reason, when its hash is not the hash of the version, when it is not a PDF, or its address is not acceptable', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final Map<String, String> expected = <String, String>{
        'checksum': 'Mã băm của tệp tải về không khớp mã băm của phiên bản nên không được mở.',
        'declared': 'Mã băm của tệp tải về không khớp mã băm của phiên bản nên không được mở.',
        'notPdf': 'Tệp tải về không phải là PDF nên không được mở.',
        'address': 'Địa chỉ tải tệp không hợp lệ nên điện thoại không mở tệp.',
        'unreachable': 'Chưa tải được tệp. Hãy kiểm tra kết nối rồi thử lại.',
        'expired': 'Địa chỉ tải tệp đã hết hạn. Hãy thử lại để lấy địa chỉ mới.',
        'tooLarge': 'Tệp quá lớn để mở trên điện thoại.',
        'unreadable': 'Điện thoại chưa đọc được tệp PDF này.',
        'scan': 'Tệp đang được quét, chưa mở được. Hãy thử lại sau ít phút.',
        'blocked': 'Bạn không được mở tệp này hoặc tệp bị chặn.',
        'missing': 'Không tìm thấy văn bản hoặc phiên ký.',
        'offline': 'Chưa tải được tệp. Hãy kiểm tra kết nối rồi thử lại.',
        'other': 'Chưa thực hiện được. Hãy thử lại sau ít phút.',
      };
      for (final String kind in expected.keys) {
        final ScriptedServer server = ScriptedServer();
        _reads(server);
        final FakePdfEngine engine = FakePdfEngine(<String, List<int>>{'final': <int>[0]});
        final FakeFetcher fetcher = FakeFetcher(<String, Uint8List>{'https://files.test/final?sig=1': pdfBytes('final')});
        switch (kind) {
          case 'checksum':
            fetcher.files['https://files.test/final?sig=1'] = pdfBytes('altered');
          case 'declared':
            server.on('GET', '/document-versions/v-2/download', (_) => download('final', checksum: hashOf('altered')));
          case 'notPdf':
            fetcher.files['https://files.test/final?sig=1'] = Uint8List.fromList(<int>[1, 2, 3, 4, 5, 6, 7]);
          case 'address':
            server.on('GET', '/document-versions/v-2/download', (_) => download('final', url: 'mock://documents/final'));
          case 'unreachable':
            fetcher.failure = const DocumentFetchException(FetchFailure.unreachable);
          case 'expired':
            fetcher.failure = const DocumentFetchException(FetchFailure.expired);
          case 'tooLarge':
            fetcher.failure = const DocumentFetchException(FetchFailure.tooLarge);
          case 'unreadable':
            engine.unreadable = true;
          case 'scan':
            server.refuse('GET', '/document-versions/v-2/download', 409, 'SCAN_PENDING');
          case 'blocked':
            server.refuse('GET', '/document-versions/v-2/download', 403, 'SCOPE_DENIED');
          case 'missing':
            server.refuse('GET', '/document-versions/v-2/download', 404, 'RESOURCE_NOT_FOUND');
          case 'offline':
            server.answer('GET', '/document-versions/v-2/download', (_) => throw const SocketException('no network'));
          case 'other':
            server.refuse('GET', '/document-versions/v-2/download', 500, 'INTERNAL_ERROR');
        }
        await _open(tester, server, engine: engine, fetcher: fetcher);
        await tester.tap(find.text('Xem PDF'));
        await tester.pumpAndSettle();
        expect(find.text(expected[kind]!), findsOneWidget, reason: kind);
        expect(find.byType(Image), findsNothing, reason: '$kind: a file that is not trusted is not drawn');
        expect(find.text('Thử lại'), findsOneWidget);
      }
    });

    testWidgets('trying again after a failure opens the file', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      final FakeFetcher fetcher = FakeFetcher(<String, Uint8List>{'https://files.test/final?sig=1': pdfBytes('final')})..failure = const DocumentFetchException(FetchFailure.expired);
      await _open(tester, server, fetcher: fetcher);
      await tester.tap(find.text('Xem PDF'));
      await tester.pumpAndSettle();
      expect(find.byType(Image), findsNothing);

      fetcher.failure = null;
      await tester.tap(find.text('Thử lại'));
      await tester.pumpAndSettle();
      expect(find.byType(Image), findsWidgets);
      expect(server.callsTo('GET', '/document-versions/v-2/download'), hasLength(2), reason: 'a new address each time: the old one lives 300 seconds at most');
    });

    testWidgets('a file that has not been scanned cannot be viewed or compared', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      server.on('GET', '/outgoing-documents/d-1', (_) => outgoing(versions: <Map<String, Object?>>[fileVersion('v-2', 2, 'RENDERED_FINAL', 'final', scan: 'PENDING'), fileVersion('v-1', 1, 'DRAFT', 'draft')]));
      await _open(tester, server);
      expect(find.text('Tệp chưa được quét xong nên chưa xem được.'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Xem PDF')).onPressed, isNull);
      expect(tester.widget<OutlinedButton>(find.widgetWithText(OutlinedButton, 'So sánh với bản 1')).onPressed, isNull);
    });

    testWidgets('a document with a single version has nothing to compare and says so', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      server.on('GET', '/outgoing-documents/d-1', (_) => outgoing(versions: <Map<String, Object?>>[fileVersion('v-2', 2, 'RENDERED_FINAL', 'final')]));
      await _open(tester, server);
      expect(find.text('Đây là bản đầu tiên, chưa có bản trước để so sánh.'), findsOneWidget);
    });

    testWidgets('a document with no file says so and offers no viewer', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      server.on('GET', '/outgoing-documents/d-1', (_) => outgoing(versions: <Map<String, Object?>>[], current: 'none'));
      await _open(tester, server);
      expect(find.text('Chưa có tệp để ký.'), findsOneWidget);
      expect(find.text('Xem PDF'), findsNothing);
    });
  });

  group('UI-MOB-67 TK-MOB-023-1 the comparison of a version with the one before it', () {
    testWidgets('says page by page which pages differ, which are new, and opens a page of either version', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      final FakePdfEngine engine = FakePdfEngine(<String, List<int>>{'final': <int>[0, 1, 0], 'draft': <int>[0, 0]});
      await _open(tester, server, engine: engine);

      await tester.tap(find.text('So sánh với bản 1'));
      await tester.pumpAndSettle();

      expect(find.text('Hai bản có mã băm khác nhau.'), findsOneWidget);
      expect(find.text('2 trong 3 trang khác nhau. Hãy mở các trang đó để đọc.'), findsOneWidget);
      expect(find.text('Trang 1: giống nhau'), findsOneWidget);
      expect(find.text('Trang 2: khác nhau'), findsOneWidget);
      expect(find.text('Trang 3: trang mới ở bản này'), findsOneWidget);
      expect(find.textContaining('Bản trước: bản 1 · '), findsOneWidget);
      expect(find.textContaining('Bản này: bản 2 · PDF cuối chờ ký · 3 trang'), findsOneWidget);
      expect(find.text('Trang 3 bản trước'), findsNothing, reason: 'the page is not in the previous version');
      expect(find.text('Trang 3 bản này'), findsOneWidget);

      await tester.tap(find.text('Trang 2 bản trước'));
      await tester.pumpAndSettle();
      expect(find.text('Trang 2, Bản trước'), findsOneWidget);
      await pressBack(tester);
      await pressBack(tester);
      expect(engine.opened.every((FakePdfDoc doc) => doc.closed), isTrue);
    });

    testWidgets('a page only the previous version has is said removed', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      await _open(tester, server, engine: FakePdfEngine(<String, List<int>>{'final': <int>[0], 'draft': <int>[0, 0]}));
      await tester.tap(find.text('So sánh với bản 1'));
      await tester.pumpAndSettle();
      expect(find.text('Trang 2: trang chỉ có ở bản trước'), findsOneWidget);
      expect(find.text('Trang 2 bản này'), findsNothing);
      expect(find.text('Trang 2 bản trước'), findsOneWidget);
    });

    testWidgets('two versions with the same file say they are identical', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      server
        ..on('GET', '/outgoing-documents/d-1', (_) => outgoing(versions: <Map<String, Object?>>[fileVersion('v-2', 2, 'RENDERED_FINAL', 'final'), fileVersion('v-1', 1, 'DRAFT', 'final')]))
        ..on('GET', '/document-versions/v-1/download', (_) => download('final'))
        ..on('GET', '/document-versions/v-2/download', (_) => download('final'));
      await _open(tester, server, engine: FakePdfEngine(<String, List<int>>{'final': <int>[0, 1]}));
      await tester.tap(find.text('So sánh với bản 1'));
      await tester.pumpAndSettle();
      expect(find.text('Hai bản có cùng mã băm: tệp giống hệt nhau.'), findsOneWidget);
      expect(find.text('Cả 2 trang trông giống nhau.'), findsOneWidget);
    });

    testWidgets('if one of the two files cannot be opened nothing is compared, and the reason is given', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      server.refuse('GET', '/document-versions/v-1/download', 409, 'SCAN_PENDING');
      await _open(tester, server);
      await tester.tap(find.text('So sánh với bản 1'));
      await tester.pumpAndSettle();
      expect(find.text('Tệp đang được quét, chưa mở được. Hãy thử lại sau ít phút.'), findsOneWidget);
      expect(find.textContaining('Từng trang'), findsNothing);
    });
  });

  group('UI-MOB-67 TK-MOB-023-1 a document that finishes opening after the screen was left is closed, not kept', () {
    testWidgets('the viewer left while the renderer is still opening the file: the document that arrives is closed at once', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      final _SlowEngine engine = _SlowEngine(<String, List<int>>{'final': <int>[0, 1, 0]});
      await _open(tester, server, engine: engine);

      await tester.tap(find.text('Xem PDF'));
      await _untilOpening(tester, engine, 1);
      await pressBack(tester);

      engine.finish(0);
      await tester.pump();
      expect(engine.opened.single.closed, isTrue, reason: 'nobody holds the document any more, so the renderer must be told to let go');
    });

    testWidgets('the comparison left while the second file is still opening: both documents end up closed', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      final _SlowEngine engine = _SlowEngine(<String, List<int>>{'final': <int>[0, 1, 0], 'draft': <int>[0, 0]});
      await _open(tester, server, engine: engine);

      await tester.tap(find.text('So sánh với bản 1'));
      await _untilOpening(tester, engine, 1);
      engine.finish(0);
      await _untilOpening(tester, engine, 2);
      await pressBack(tester);

      engine.finish(1);
      await tester.pump();
      expect(engine.opened, hasLength(2));
      expect(engine.opened.every((FakePdfDoc doc) => doc.closed), isTrue);
    });
  });

  group('TK-MOB-023-1 the checks of a file, as pure functions', () {
    final Uri api = Uri.parse('https://api.test/v1');

    test('only an https address, or a path on the API, is requested; mock, file, protocol-relative and loopback http are not', () {
      expect(downloadAddress(api, 'https://files.test/a?sig=1').toString(), 'https://files.test/a?sig=1');
      expect(downloadAddress(api, '/files/a?sig=1').toString(), 'https://api.test/v1/files/a?sig=1');
      expect(downloadAddress(api, '/files/a').toString(), 'https://api.test/v1/files/a');
      expect(downloadAddress(api, 'http://files.test/a'), isNull);
      expect(downloadAddress(api, 'mock://documents/a'), isNull);
      expect(downloadAddress(api, 'file:///etc/passwd'), isNull);
      expect(downloadAddress(api, '//evil.test/a'), isNull);
      expect(downloadAddress(api, 'files/a'), isNull);
      expect(downloadAddress(api, 'https:///a'), isNull);
      expect(downloadAddress(api, 'http://127.0.0.1:8080/a'), isNull);
      expect(downloadAddress(api, 'http://127.0.0.1:8080/a', allowInsecureLoopback: true).toString(), 'http://127.0.0.1:8080/a');
      expect(downloadAddress(api, 'http://files.test/a', allowInsecureLoopback: true), isNull, reason: 'only a loopback host may be plain http');
      expect(downloadAddress(api, 'http://[::1'), isNull);
    });

    test('a PDF is judged by its first bytes and its hash', () {
      expect(looksLikePdf(pdfBytes('x')), isTrue);
      expect(looksLikePdf(Uint8List.fromList(<int>[0x25, 0x50, 0x44, 0x46])), isFalse);
      expect(looksLikePdf(Uint8List.fromList('<html>'.codeUnits)), isFalse);
      expect(verifyDocument(pdfBytes('x'), expectedSha256: hashOf('x').toUpperCase()), pdfBytes('x'));
      expect(() => verifyDocument(pdfBytes('x'), expectedSha256: hashOf('y')), throwsA(isA<DocumentFetchException>().having((DocumentFetchException e) => e.failure, 'failure', FetchFailure.checksumMismatch)));
      expect(() => verifyDocument(Uint8List.fromList(<int>[1, 2, 3, 4, 5, 6]), expectedSha256: hashOf('x')), throwsA(isA<DocumentFetchException>().having((DocumentFetchException e) => e.failure, 'failure', FetchFailure.notPdf)));
      expect(const DocumentFetchException(FetchFailure.expired).toString(), contains('expired'));
    });

    test('two pages differ when enough pixels differ, and are compared page by page', () async {
      expect(pixelDifference(pagePng(0), pagePng(0)), 0);
      expect(pixelDifference(pagePng(0), pagePng(2)), greaterThan(pageTolerance));
      expect(pixelDifference(Uint8List.fromList(<int>[1, 2, 3]), pagePng(0)), 1, reason: 'what is not an image cannot be shown to be the same');

      final VersionComparison comparison = await compareDocuments(FakePdfDoc(<int>[0, 1]), FakePdfDoc(<int>[0, 2, 0]));
      expect(comparison.pages.map((PageComparison p) => p.change), <PageChange>[PageChange.same, PageChange.changed, PageChange.added]);
      expect(comparison.changedPages, 2);
      expect(comparison.identical, isFalse);
      expect((await compareDocuments(FakePdfDoc(<int>[0, 1, 0]), FakePdfDoc(<int>[0, 1]))).pages.last.change, PageChange.removed);
      expect((await compareDocuments(FakePdfDoc(<int>[0]), FakePdfDoc(<int>[0]))).identical, isTrue);
    });

    test('each colour channel counts on its own: a change in red only, in green only or in blue only is a change, a small one in all three is not', () {
      final Uint8List white = solidPng(255, 255, 255);
      expect(pixelDifference(white, solidPng(155, 255, 255)), 1);
      expect(pixelDifference(white, solidPng(255, 155, 255)), 1);
      expect(pixelDifference(white, solidPng(255, 255, 155)), 1);
      expect(pixelDifference(white, solidPng(240, 240, 240)), 0, reason: 'anti-aliasing noise');
      expect(pixelDifference(white, solidPng(255 - channelTolerance, 255, 255)), 0, reason: 'exactly the tolerance is still noise');
      expect(pixelDifference(white, solidPng(255 - channelTolerance - 1, 255, 255)), 1);
    });

    test('a small stray difference within the tolerance is not a change, a block of text is', () {
      // 60x80 = 4800 pixels; the tolerance is 0.2 percent, so nine pixels of difference are noise and ten times that are not.
      final Uint8List white = pagePng(0);
      expect(pixelDifference(white, white), lessThanOrEqualTo(pageTolerance));
      expect(pixelDifference(white, pagePng(1)), greaterThan(pageTolerance));
    });
  });

  group('TK-MOB-023-1 the fetcher of the phone', () {
    // The test binding answers every HttpClient with a fake; these tests talk to a real server on this machine.
    setUp(() {
      final HttpOverrides? previous = HttpOverrides.current;
      HttpOverrides.global = null;
      addTearDown(() => HttpOverrides.global = previous);
    });

    Future<HttpServer> serve(void Function(HttpRequest request) handler) async {
      final HttpServer server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      server.listen(handler);
      addTearDown(() => server.close(force: true));
      return server;
    }

    test('it asks for the bytes with no bearer token and no cookie, and returns them', () async {
      HttpRequest? seen;
      final HttpServer server = await serve((HttpRequest request) async {
        seen = request;
        request.response.add(pdfBytes('final'));
        await request.response.close();
      });
      final Uint8List bytes = await DartIoDocumentFetcher().fetch(Uri.parse('http://127.0.0.1:${server.port}/f?sig=1'));
      expect(bytes, pdfBytes('final'));
      expect(seen!.headers.value('authorization'), isNull);
      expect(seen!.headers.value('cookie'), isNull);
      expect(seen!.headers.value('accept'), 'application/pdf');
    });

    test('it does not follow a redirect (the address would carry the signature somewhere else)', () async {
      int landed = 0;
      final HttpServer target = await serve((HttpRequest request) async {
        landed += 1;
        request.response.add(pdfBytes('final'));
        await request.response.close();
      });
      final HttpServer redirector = await serve((HttpRequest request) async {
        request.response
          ..statusCode = 302
          ..headers.set('location', 'http://127.0.0.1:${target.port}/steal');
        await request.response.close();
      });
      await expectLater(DartIoDocumentFetcher().fetch(Uri.parse('http://127.0.0.1:${redirector.port}/f')), throwsA(isA<DocumentFetchException>().having((DocumentFetchException e) => e.failure, 'failure', FetchFailure.unreachable)));
      expect(landed, 0, reason: 'the place the redirect pointed to was never asked');
    });

    test('an address that is no longer good is "expired", and a server that cannot be reached is "unreachable"', () async {
      final HttpServer server = await serve((HttpRequest request) async {
        request.response.statusCode = 403;
        await request.response.close();
      });
      await expectLater(DartIoDocumentFetcher().fetch(Uri.parse('http://127.0.0.1:${server.port}/f')), throwsA(isA<DocumentFetchException>().having((DocumentFetchException e) => e.failure, 'failure', FetchFailure.expired)));
      final int port = server.port;
      await server.close(force: true);
      await expectLater(DartIoDocumentFetcher().fetch(Uri.parse('http://127.0.0.1:$port/f')), throwsA(isA<DocumentFetchException>().having((DocumentFetchException e) => e.failure, 'failure', FetchFailure.unreachable)));
    });

    test('a file longer than the ceiling is cut off, whether the server said its length or not', () async {
      final HttpServer sized = await serve((HttpRequest request) async {
        request.response
          ..headers.contentLength = 64
          ..add(Uint8List(64));
        await request.response.close();
      });
      await expectLater(DartIoDocumentFetcher().fetch(Uri.parse('http://127.0.0.1:${sized.port}/f'), maxBytes: 32), throwsA(isA<DocumentFetchException>().having((DocumentFetchException e) => e.failure, 'failure', FetchFailure.tooLarge)));
      final HttpServer streamed = await serve((HttpRequest request) async {
        request.response.headers.chunkedTransferEncoding = true;
        request.response.add(Uint8List(20));
        await request.response.flush();
        request.response.add(Uint8List(20));
        await request.response.close();
      });
      await expectLater(DartIoDocumentFetcher().fetch(Uri.parse('http://127.0.0.1:${streamed.port}/f'), maxBytes: 32), throwsA(isA<DocumentFetchException>().having((DocumentFetchException e) => e.failure, 'failure', FetchFailure.tooLarge)));
    });
  });

  group('TK-MOB-023-2 the data and the commands of a signature, as pure functions', () {
    test('the previous version is the newest one before the current; the signing certificate is the personal one in force that ends last', () {
      final SigningDocument document = parseSigningDocument(outgoing(
        versions: <Map<String, Object?>>[fileVersion('v-3', 3, 'RENDERED_FINAL', 'a'), fileVersion('v-1', 1, 'DRAFT', 'b'), fileVersion('v-2', 2, 'DRAFT', 'c')],
        current: 'v-3',
        certificates: <Map<String, Object?>>[
          certificate(),
          <String, Object?>{...certificate(), 'id': 'cert-2', 'valid_until': '2028-01-01T00:00:00Z'},
          <String, Object?>{...certificate(status: 'Revoked'), 'id': 'cert-3', 'valid_until': '2030-01-01T00:00:00Z'},
          <String, Object?>{...certificate(kind: 'ORGANIZATION'), 'id': 'cert-4', 'valid_until': '2031-01-01T00:00:00Z'},
        ],
      ))!;
      expect(document.currentFile!.id, 'v-3');
      expect(document.previousFile!.id, 'v-2');
      expect(document.signingCertificate!.id, 'cert-2');
      expect(parseSigningDocument(outgoing(current: 'none'))!.previousFile, isNull);
      expect(parseSigningDocument(outgoing(certificates: <Map<String, Object?>>[]))!.signingCertificate, isNull);
    });

    test('the content is unchanged only when the signed version rests on the final PDF', () {
      expect(parseSigningDocument(signedOutgoing())!.signedContentUnchanged, isTrue);
      expect(parseSigningDocument(signedOutgoing(prefix: hashOf('other')))!.signedContentUnchanged, isFalse);
      expect(parseSigningDocument(outgoing())!.signedContentUnchanged, isNull, reason: 'nothing is signed yet');
      final Map<String, Object?> noPrefix = signedOutgoing();
      (noPrefix['versions']! as List<Object?>)[0] = fileVersion('v-3', 3, 'LEADER_SIGNED', 'signed');
      expect(parseSigningDocument(noPrefix)!.signedContentUnchanged, isNull, reason: 'the server did not say what the signature was built on');
    });

    test('a session is open until the server says otherwise, the newest of the leader is the one that counts', () {
      final SigningDocument document = parseSigningDocument(outgoing(sessions: <Map<String, Object?>>[session('s-2', status: 'CREATED'), session('s-1', status: 'EXPIRED')]))!;
      expect(document.openLeaderSession!.id, 's-2');
      expect(parseSigningDocument(outgoing(sessions: <Map<String, Object?>>[session('s-2', status: 'EXPIRED')]))!.openLeaderSession, isNull);
      expect(parseSigningDocument(outgoing())!.lastLeaderSession, isNull);
      expect(parseSigningDocument(<String, Object?>{'id': 'x'}), isNull);
      expect(parseWaitingList(<String, Object?>{'items': 'no'}), isNull);
      expect(parseWaitingDocument(<String, Object?>{'title': 'no id'}), isNull);
      expect(parseFileVersion(<String, Object?>{'id': 'x'}), isNull);
      expect(parseSession(<String, Object?>{'id': 'x'}), isNull);
      expect(parseCertificate(<String, Object?>{}), isNull);
      expect(parseVerdict(<String, Object?>{'role': 'LEADER'}), isNull);
    });

    test('the one-time code is checked before it is sent, and the refusals map to their problems', () {
      expect(checkOtp(' 123456 '), isNull);
      expect(checkOtp('  '), OtpProblem.required);
      expect(checkOtp('9' * 65), OtpProblem.tooLong);
      SigningProblem of(String code, {bool completing = false}) => problemOf(CommandRefused(code), completing: completing);
      expect(of('SIGNING_SESSION_OPEN'), SigningProblem.sessionOpen);
      expect(of('SIGNING_SESSION_OPEN', completing: true), SigningProblem.pending);
      expect(of('SIGNER_NOT_AUTHORIZED'), SigningProblem.notSigner);
      expect(of('PROVIDER_UNAVAILABLE'), SigningProblem.provider);
      expect(of('SIGNING_ADAPTER_UNAVAILABLE'), SigningProblem.adapter);
      expect(of('INVALID_REQUEST'), SigningProblem.validation);
      expect(of('PERMISSION_DENIED'), SigningProblem.denied);
      expect(of('something'), SigningProblem.general);
      expect(isRetryable(SigningProblem.provider), isTrue);
      expect(isRetryable(SigningProblem.adapter), isTrue);
      expect(isRetryable(SigningProblem.general), isTrue);
      expect(isRetryable(SigningProblem.notSigner), isFalse);
      expect(isRetryable(SigningProblem.expired), isFalse);
    });

    test('the gate puts offline and copies first, then a signed document, then the state, then the mode, then the signer', () {
      final SigningDocument waiting = parseSigningDocument(outgoing())!;
      final SigningDocument signed = parseSigningDocument(signedOutgoing())!;
      final SigningDocument numbered = parseSigningDocument(outgoing(status: 'NUMBERED'))!;
      SessionSnapshot session({String? membership = 'mem-1', SessionMode mode = SessionMode.full}) => SessionSnapshot(status: SessionStatus.signedIn, tenantId: 't', userId: 'u', membershipId: membership, mode: mode);
      SigningGate gate(SigningDocument d, {bool offline = false, bool copy = false, SessionSnapshot? s}) => gateOf(document: d, offline: offline, fromCopy: copy, session: s ?? session());
      expect(gate(waiting), SigningGate.open);
      expect(gate(signed, offline: true), SigningGate.offline);
      expect(gate(waiting, copy: true), SigningGate.offline);
      expect(gate(signed), SigningGate.signed);
      expect(gate(numbered), SigningGate.notSubmitted);
      expect(gate(waiting, s: session(mode: SessionMode.readOnly)), SigningGate.readOnly);
      expect(gate(waiting, s: session(membership: 'mem-2')), SigningGate.notSigner);
      expect(gate(waiting, s: session(membership: null)), SigningGate.notSigner);
    });

    test('the commands are never sent offline; a lost confirmation is sent again with the same key and never as a second signature', () async {
      final ScriptedServer server = ScriptedServer();
      int attempt = 0;
      server.answer('POST', '/signing-sessions/s-1/completion', (_) {
        attempt += 1;
        if (attempt == 1) throw const SocketException('lost');
        return recorded('s-1', status: 'EMBEDDED');
      });
      bool online = false;
      final SigningCommands commands = SigningCommands(client: MachvonApiClient(baseUrl: Uri.parse('https://api.test/v1'), transport: server, token: () async => 't'), isOnline: () => online);
      const CompleteRequest request = CompleteRequest(sessionId: 's-1', version: 2, proof: SigningProof(otpConfirmation: '123456'));
      expect(await commands.complete(request), isA<CommandOffline>());
      expect(await commands.start(const StartRequest(documentId: 'd-1', version: 7, certificateId: null, adapterCode: 'REMOTE_CA')), isA<CommandOffline>());
      expect(server.calls, isEmpty);
      online = true;
      expect(await commands.complete(request), isA<CommandUnknown>());
      expect(await commands.complete(request, retryAfterUnknown: true), isA<CommandDone>());
      final List<HttpCall> calls = server.callsTo('POST', '/signing-sessions/s-1/completion');
      expect(calls[1].headers['idempotency-key'], calls[0].headers['idempotency-key']);
    });
  });

  group('TK-MOB-023-1 the adapter of the renderer, tried on a fake of the platform of pdfx', () {
    test('it opens the bytes, draws a page at the width asked on a white ground, one page at a time, and closes the document', () async {
      final _Platform platform = _Platform();
      PdfxPlatform.instance = platform;
      final PdfDoc doc = await const PdfxEngine().open(pdfBytes('x'));
      expect(doc.pageCount, 3);

      final List<RenderedPage> pages = await Future.wait(<Future<RenderedPage>>[doc.render(0, width: 300), doc.render(1, width: 300), doc.render(2, width: 150)]);
      expect(pages.map((RenderedPage p) => p.width), <int>[300, 300, 150]);
      expect(pages.first.height, 400, reason: 'the height follows the shape of the page (3:4)');
      expect(platform.document.drawn, <int>[1, 2, 3]);
      expect(platform.document.mostAtOnce, 1, reason: 'the system renderer draws one page at a time');
      expect(platform.document.backgrounds.toSet(), <String?>{'#FFFFFF'});
      expect(platform.document.pagesClosed, 3);

      await doc.close();
      expect(platform.document.isClosed, isTrue);
    });

    test('bytes the renderer cannot read are a PdfOpenException, and a page it cannot draw fails that page only', () async {
      final _Platform platform = _Platform(failOpen: true);
      PdfxPlatform.instance = platform;
      await expectLater(const PdfxEngine().open(pdfBytes('x')), throwsA(isA<PdfOpenException>()));
      expect(const PdfOpenException().toString(), 'PdfOpenException');

      final _Platform blank = _Platform(blankPage: 0);
      PdfxPlatform.instance = blank;
      final PdfDoc doc = await const PdfxEngine().open(pdfBytes('x'));
      await expectLater(doc.render(0, width: 100), throwsA(isA<PdfOpenException>()));
      expect((await doc.render(1, width: 100)).width, 100);
      expect(blank.document.pagesClosed, 2, reason: 'a page is closed even when it could not be drawn');
    });
  });
}

// ---- a fake of the platform of pdfx -------------------------------------------------------------------------------------------

class _Platform extends PdfxPlatform {
  _Platform({this.failOpen = false, this.blankPage}) : document = _Document();

  final bool failOpen;
  final int? blankPage;
  final _Document document;

  @override
  Future<pdfx.PdfDocument> openData(FutureOr<Uint8List> data, {String? password}) async {
    if (failOpen) throw StateError('not a pdf');
    document.blankPage = blankPage;
    return document;
  }

  @override
  Future<pdfx.PdfDocument> openFile(String filePath, {String? password}) => throw UnimplementedError();

  @override
  Future<pdfx.PdfDocument> openAsset(String name, {String? password}) => throw UnimplementedError();
}

class _Document extends pdfx.PdfDocument {
  _Document() : super(sourceName: 'test', id: 'doc', pagesCount: 3);

  final List<int> drawn = <int>[];
  final List<String?> backgrounds = <String?>[];
  int active = 0;
  int mostAtOnce = 0;
  int pagesClosed = 0;
  int? blankPage;

  @override
  Future<pdfx.PdfPage> getPage(int pageNumber, {bool autoCloseAndroid = false}) async => _Page(this, pageNumber);

  @override
  Future<void> close() async => isClosed = true;

  @override
  bool operator ==(Object other) => identical(this, other);

  @override
  int get hashCode => 1;
}

class _Page extends pdfx.PdfPage {
  _Page(this.owner, int number) : super(document: owner, id: 'p$number', pageNumber: number, width: 300, height: 400, autoCloseAndroid: false);

  final _Document owner;

  @override
  Future<pdfx.PdfPageImage?> render({required double width, required double height, pdfx.PdfPageImageFormat format = pdfx.PdfPageImageFormat.jpeg, String? backgroundColor, Rect? cropRect, int quality = 100, bool forPrint = false, bool removeTempFile = true}) async {
    owner.active += 1;
    if (owner.active > owner.mostAtOnce) owner.mostAtOnce = owner.active;
    await Future<void>.delayed(const Duration(milliseconds: 5));
    owner.active -= 1;
    owner.drawn.add(pageNumber);
    owner.backgrounds.add(backgroundColor);
    if (owner.blankPage == pageNumber - 1) return null;
    return _Image(pageNumber, width.round(), height.round());
  }

  @override
  Future<pdfx.PdfPageTexture> createTexture() => throw UnimplementedError();

  @override
  Future<void> close() async {
    owner.pagesClosed += 1;
  }

  @override
  bool operator ==(Object other) => identical(this, other);

  @override
  int get hashCode => pageNumber;
}

class _Image extends pdfx.PdfPageImage {
  _Image(int page, int width, int height) : super(id: 'i$page', pageNumber: page, width: width, height: height, bytes: Uint8List(4), format: pdfx.PdfPageImageFormat.png, quality: 100);

  @override
  bool operator ==(Object other) => identical(this, other);

  @override
  int get hashCode => 2;
}
