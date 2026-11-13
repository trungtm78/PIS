import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/core/theme/theme_mode.dart';
import 'package:machvon_mobile/features/document_signing/document_fetcher.dart';
import 'package:machvon_mobile/features/document_signing/document_signing_feature.dart' as signing;
import 'package:machvon_mobile/features/document_signing/pdf_engine.dart';
import 'package:machvon_mobile/features/document_signing/signing_port.dart';

import '../features/document_signing/support.dart';
import '../features/support/scripted_server.dart';
import '../support/harness.dart';
import '../support/v2_support.dart';

/// Golden images of the signing screens of MUX-3 wave B (MOB-67): the list of the documents that wait, the document with its signature
/// bar, an open session, the signed result, the file that cannot be read, the list offline. They are drawn with the test font, which Windows
/// and Linux rasterise differently, so each OS compares with goldens of its own (useOsGoldens), and layout and touch targets are
/// proved by the widget tests of the screens.

class _Dark extends ThemeModeNotifier {
  @override
  ThemeMode build() => ThemeMode.dark;
}

const Size _phone = Size(390, 844);

FakeSession _leader() => FakeSession(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1', membershipId: 'mem-1', mode: SessionMode.full));

ScriptedServer _server({Map<String, Object?>? document, List<Object?>? list}) {
  final Map<String, Object?> one = document ?? outgoing();
  final ScriptedServer server = ScriptedServer();
  server
    ..on('GET', '/outgoing-documents', (_) => page(list ?? <Object?>[
          one,
          <String, Object?>{...outgoing(id: 'd-2', signer: 'mem-7'), 'title': 'Công văn trả lời kiến nghị cử tri'},
        ]))
    ..on('GET', '/outgoing-documents/d-1', (_) => one)
    ..on('GET', '/document-versions/v-2/download', (_) => download('final'))
    ..on('GET', '/document-versions/v-1/download', (_) => download('draft'));
  return server;
}

Future<void> _open(WidgetTester tester, ScriptedServer server, String location, {bool dark = false, double scale = 1.0}) async {
  useDevice(tester, _phone, textScale: scale);
  await pumpWithServer(
    tester,
    features: <MobileFeature>[signing.feature],
    server: server,
    location: location,
    session: _leader(),
    overrides: <Override>[
      pdfEngineProvider.overrideWithValue(FakePdfEngine(<String, List<int>>{'final': <int>[0, 1, 0], 'draft': <int>[0, 0]})),
      documentFetcherProvider.overrideWithValue(FakeFetcher(<String, Uint8List>{'https://files.test/final?sig=1': pdfBytes('final')})),
      signingPortProvider.overrideWith((Ref ref) => const RemoteCaOtpPort()),
      if (dark) themeModeProvider.overrideWith(_Dark.new),
    ],
  );
}

const String _detail = '/approval/mob-67?doc=d-1';
const String _list = '/approval/mob-67';

void main() {
  useOsGoldens('test/golden/signing_golden_test.dart');

  group('MUX-3 wave B the documents waiting for the signature (MOB-67)', () {
    testWidgets('list, light', (WidgetTester tester) async {
      await _open(tester, _server(), _list);
      expect(find.text('Cần bạn ký'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/sign_list_light.png'));
    });

    testWidgets('list, dark', (WidgetTester tester) async {
      await _open(tester, _server(), _list, dark: true);
      expect(Theme.of(tester.element(find.text('Cần bạn ký'))).brightness, Brightness.dark);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/sign_list_dark.png'));
    });

    testWidgets('list, text 200 percent', (WidgetTester tester) async {
      await _open(tester, _server(), _list, scale: 2.0);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/sign_list_text200.png'));
    });

    testWidgets('list, empty', (WidgetTester tester) async {
      await _open(tester, _server(list: <Object?>[]), _list);
      expect(find.text('Chưa có dữ liệu'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/sign_list_empty.png'));
    });

    testWidgets('list, offline: the copy kept on the phone', (WidgetTester tester) async {
      final ScriptedServer server = _server();
      await _open(tester, server, _list);
      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Bạn đang ngoại tuyến'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/sign_list_offline.png'));
    });

    testWidgets('document, light', (WidgetTester tester) async {
      await _open(tester, _server(), _detail);
      expect(find.text('Quyết định giao vốn năm 2026'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/sign_detail_light.png'));
    });

    testWidgets('document, dark', (WidgetTester tester) async {
      await _open(tester, _server(), _detail, dark: true);
      expect(Theme.of(tester.element(find.text('Quyết định giao vốn năm 2026'))).brightness, Brightness.dark);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/sign_detail_dark.png'));
    });

    testWidgets('document, text 200 percent', (WidgetTester tester) async {
      await _open(tester, _server(), _detail, scale: 2.0);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/sign_detail_text200.png'));
    });

    testWidgets('document, an open session asks for the code', (WidgetTester tester) async {
      await _open(tester, _server(document: outgoing(sessions: <Map<String, Object?>>[session('s-1')])), _detail);
      expect(find.widgetWithText(TextField, 'Mã xác nhận (OTP)'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/sign_detail_session.png'));
    });

    testWidgets('document, offline: the copy kept on the phone locks the signature with the reason', (WidgetTester tester) async {
      final ScriptedServer server = _server();
      await _open(tester, server, _detail);
      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Cần kết nối mạng để ký'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/sign_detail_offline.png'));
    });

    testWidgets('document, signed: the result read back from the server', (WidgetTester tester) async {
      await _open(tester, _server(document: signedOutgoing()), _detail);
      expect(find.text('Kết quả ký'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/sign_detail_signed.png'));
    });
  });
}
