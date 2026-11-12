import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/di/providers.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/features/ai_review/ai_models.dart';
import 'package:machvon_mobile/features/ai_review/ai_review_feature.dart' as ai;
import 'package:machvon_mobile/features/ai_review/screens/findings_screen.dart';
import 'package:machvon_mobile/features/notification_inbox/push_device.dart' show PushPayload;
import 'package:machvon_mobile/features/read_support/read_cache.dart';

import '../../support/harness.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'fixtures.dart';

Future<ProviderContainer> _open(WidgetTester tester, ScriptedServer server, String location) =>
    pumpWithServer(tester, features: <MobileFeature>[ai.feature], server: server, location: location);

Future<void> _openAt(WidgetTester tester, ScriptedServer server, String location) async {
  await _open(tester, server, location);
}

Finder _ask() => find.widgetWithText(FilledButton, 'Hỏi');

Future<void> _type(WidgetTester tester, String question) async {
  await tester.enterText(find.byType(TextField), question);
  await tester.pump();
}

/// The spans that hold text, however deep the text widget nested them.
List<TextSpan> _leaves(InlineSpan span) => span is TextSpan ? <TextSpan>[if (span.text != null) span, for (final InlineSpan child in span.children ?? const <InlineSpan>[]) ..._leaves(child)] : const <TextSpan>[];

List<HttpCall> _writes(ScriptedServer server) => server.calls.where((HttpCall call) => call.method != 'GET').toList();

const String _qa = '/projects/mob-37?package=$kPackage';
const String _findings = '/projects/mob-38?run=$kRun';
const String _source = '/projects/mob-39?run=$kRun&finding=f-1&evidence=ev-f-1';

void main() {
  group('AC-ST-MOB-030-1 UAT-AC466 MOB-37 answers only with citations in the scope of the person', () {
    testWidgets('retrieval returns nothing in scope: the answer is refused for lack of citation and says nothing else', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server, passages: <Map<String, Object?>>[]);
      await _open(tester, server, _qa);

      await _type(tester, 'Nhà thầu có kinh nghiệm gì?');
      await tester.tap(_ask());
      await tester.pumpAndSettle();

      expect(find.text('Chưa trả lời được: không có dẫn chứng trong phạm vi của bạn'), findsOneWidget);
      expect(find.text('REJECTED_NO_CITATION'), findsOneWidget);
      expect(find.textContaining('đoạn gần nhất'), findsNothing, reason: 'no passage, so no answer');
      expect(find.textContaining('Tệp '), findsNothing, reason: 'no citation chip');
      expect(_writes(server), isEmpty, reason: 'asking changes nothing on the server');
    });

    testWidgets('passages of the files the person may read come with their file and page, ranked by the approved embedding model', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server, passages: <Map<String, Object?>>[
        passage(kDoc, 11, 0, 'Nhà thầu đã thực hiện hợp đồng tương tự tại tỉnh B.'),
        passage(kDoc2, 3, 2, 'Năng lực tài chính được bảo lãnh bởi ngân hàng X.'),
      ]);
      final ProviderContainer container = await _open(tester, server, _qa);

      await _type(tester, '  Kinh nghiệm của nhà thầu?  ');
      await tester.tap(_ask());
      await tester.pumpAndSettle();

      expect(find.text('2 đoạn gần nhất với câu hỏi'), findsOneWidget);
      expect(find.text('Nhà thầu đã thực hiện hợp đồng tương tự tại tỉnh B.'), findsOneWidget);
      expect(find.text('Tệp aaaaaaaa · Trang 12'), findsOneWidget);
      expect(find.text('Tệp bbbbbbbb · Trang 4'), findsOneWidget);
      final HttpCall call = server.callsTo('GET', '/procurement-packages/$kPackage/proposal-passages').single;
      expect(call.url.queryParameters, <String, String>{'embedding_model_id': 'm-1', 'question': 'Kinh nghiệm của nhà thầu?', 'limit': '5'}, reason: 'the newest approved model that embeds, the trimmed question');
      expect(currentLocation(container), _qa, reason: 'the question is not put in a location');
      expect(_writes(server), isEmpty);

      await tester.tap(find.text('Tệp aaaaaaaa · Trang 12'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/projects/mob-39?package=$kPackage&doc=$kDoc&page=11', reason: 'the chip opens the source viewer');
    });

    testWidgets('nothing of the question or the passages is kept on the device', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server);
      final ProviderContainer container = await _open(tester, server, _qa);
      await _type(tester, 'Câu hỏi bí mật');
      await tester.tap(_ask());
      await tester.pumpAndSettle();
      expect((container.read(readCacheProvider) as InMemoryReadCache).length, 0);
    });

    testWidgets('an empty or too long question is not sent', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server);
      await _open(tester, server, _qa);

      await tester.tap(_ask());
      await tester.pumpAndSettle();
      expect(find.text('Hãy nhập câu hỏi.'), findsOneWidget);
      expect(server.callsTo('GET', '/procurement-packages/$kPackage/proposal-passages'), isEmpty);
      expect(server.callsTo('GET', '/ai-models'), isEmpty);
    });

    testWidgets('offline the question is not asked and the screen says why', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server);
      await _open(tester, server, _qa);
      await _type(tester, 'Câu hỏi');
      server.offline = true;
      await tester.tap(_ask());
      await tester.pumpAndSettle();
      expect(find.text('Không có kết nối. Hãy thử lại khi có mạng.'), findsOneWidget);
      expect(find.text('NETWORK_ERROR'), findsOneWidget);

      expect(find.textContaining('Cần có kết nối để hỏi'), findsOneWidget, reason: 'the gate explains the disabled button');
      expect(tester.widget<FilledButton>(_ask()).onPressed, isNull);
    });

    testWidgets('the refusal of the server is shown as a sentence and its code, and a retry asks the same question again', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server);
      int attempts = 0;
      server.answer('GET', '/procurement-packages/:id/proposal-passages', (HttpCall call) {
        attempts += 1;
        return attempts == 1
            ? problem(503, 'DEPENDENCY_UNAVAILABLE')
            : FakeTransport.json(200, <String, Object?>{'items': <Object?>[passage(kDoc, 0, 0, 'Đoạn thứ nhất.')], 'as_of': '2026-11-03T02:00:00Z'});
      });
      await _open(tester, server, _qa);
      await _type(tester, 'Câu hỏi');
      await tester.tap(_ask());
      await tester.pumpAndSettle();
      expect(find.text('DEPENDENCY_UNAVAILABLE'), findsOneWidget);
      expect(find.text('Chưa hỏi được lúc này. Hãy thử lại.'), findsOneWidget);

      await tester.tap(find.widgetWithText(OutlinedButton, 'Hỏi lại'));
      await tester.pumpAndSettle();
      expect(find.text('Đoạn thứ nhất.'), findsOneWidget);
      expect(find.text('DEPENDENCY_UNAVAILABLE'), findsNothing);
      expect(server.callsTo('GET', '/procurement-packages/$kPackage/proposal-passages').map((HttpCall c) => c.url.queryParameters['question']).toSet(), <String>{'Câu hỏi'});
    });

    testWidgets('a person with no right over the package is told so, without a retry that cannot help', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server);
      server.refuse('GET', '/procurement-packages/:id/proposal-passages', 403, 'SCOPE_DENIED');
      await _open(tester, server, _qa);
      await _type(tester, 'Câu hỏi');
      await tester.tap(_ask());
      await tester.pumpAndSettle();
      expect(find.text('Bạn không có quyền hỏi về gói thầu này.'), findsOneWidget);
      expect(find.text('SCOPE_DENIED'), findsOneWidget);
      expect(find.widgetWithText(OutlinedButton, 'Hỏi lại'), findsNothing);
    });

    testWidgets('a package outside the scope is the same 404 as one that does not exist', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server);
      server.refuse('GET', '/procurement-packages/:id/proposal-passages', 404, 'RESOURCE_NOT_FOUND');
      await _open(tester, server, _qa);
      await _type(tester, 'Câu hỏi');
      await tester.tap(_ask());
      await tester.pumpAndSettle();
      expect(find.text('Gói thầu này không có hoặc không còn trong phạm vi của bạn.'), findsOneWidget);
      expect(find.text('RESOURCE_NOT_FOUND'), findsOneWidget);
    });

    testWidgets('no approved embedding model the person can read: no question is asked', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server);
      server.on('GET', '/ai-models', (_) => models(embedding: false, status: 'DRAFT'));
      await _open(tester, server, _qa);
      await _type(tester, 'Câu hỏi');
      await tester.tap(_ask());
      await tester.pumpAndSettle();
      // m-old is still approved and embeds, so it is used; with it taken away there is nothing left.
      expect(server.callsTo('GET', '/procurement-packages/$kPackage/proposal-passages').single.url.queryParameters['embedding_model_id'], 'm-old');

      server.on('GET', '/ai-models', (_) => <String, Object?>{'items': <Object?>[], 'next_cursor': null});
      await _type(tester, 'Câu hỏi khác');
      await tester.tap(_ask());
      await tester.pumpAndSettle();
      expect(find.text('EMBEDDING_MODEL_UNAVAILABLE'), findsOneWidget);
      expect(server.callsTo('GET', '/procurement-packages/$kPackage/proposal-passages'), hasLength(1), reason: 'no model, no question');
    });

    testWidgets('an evaluator who may rank passages but not read the provider register is told no model is available, not that the question is denied', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server);
      server.refuse('GET', '/ai-models', 403, 'PERMISSION_DENIED');
      await _open(tester, server, _qa);
      await _type(tester, 'Câu hỏi');
      await tester.tap(_ask());
      await tester.pumpAndSettle();
      expect(find.text('EMBEDDING_MODEL_UNAVAILABLE'), findsOneWidget);
      expect(find.text('PERMISSION_DENIED'), findsNothing);
      expect(find.text('Bạn không có quyền hỏi về gói thầu này.'), findsNothing, reason: 'the right to ask is not what is missing');
      expect(server.callsTo('GET', '/procurement-packages/$kPackage/proposal-passages'), isEmpty, reason: 'no model, no question');
    });

    testWidgets('a register that cannot be reached is a failure to retry, not a missing model', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server);
      server.refuse('GET', '/ai-models', 503, 'DEPENDENCY_UNAVAILABLE');
      await _open(tester, server, _qa);
      await _type(tester, 'Câu hỏi');
      await tester.tap(_ask());
      await tester.pumpAndSettle();
      expect(find.text('DEPENDENCY_UNAVAILABLE'), findsOneWidget);
      expect(find.text('EMBEDDING_MODEL_UNAVAILABLE'), findsNothing);
    });

    testWidgets('without a package the screen lists the packages of the scope and opens the thread of the one chosen', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server);
      final ProviderContainer container = await _open(tester, server, '/projects/mob-37');
      expect(find.text('GT-2026-07'), findsOneWidget);
      await tester.tap(find.text('GT-2026-07'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), _qa);
      expect(find.widgetWithText(FilledButton, 'Hỏi'), findsOneWidget);
    });
  });

  group('AC-ST-MOB-030-2 UAT-PLAN-42 MOB-38 one finding to a card, awaiting verification, no approval by swipe or push', () {
    testWidgets('each finding is one card with the AI label and, until a person decides, the state "needs verification"', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server);
      await _open(tester, server, _findings);

      expect(find.byType(FindingCard), findsNWidgets(2));
      expect(find.text('Đề xuất của AI — cần chuyên gia thẩm tra'), findsNWidgets(2));
      expect(find.text('Cần kiểm chứng'), findsNWidgets(2));
      expect(find.text('Thiếu nguồn'), findsNWidgets(2), reason: 'the filter and the pill of the finding that claimed without a citation found on its page');
      expect(find.textContaining('Tín hiệu: ước lượng của mô hình'), findsNWidgets(2));
      expect(find.text('Dẫn chứng: 1 trên 1 đã được kiểm là có trên trang'), findsOneWidget);
      expect(find.text('Không thấy trên trang'), findsOneWidget);
      expect(find.textContaining('xác suất đúng'), findsNWidgets(2), reason: 'a signal, never a probability');
    });

    testWidgets('what a person decided is shown apart from what the model said, and the finding no longer awaits verification', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server);
      server.on('GET', '/analysis-runs/:id/findings', (_) => findingsOf(<Map<String, Object?>>[finding('f-1', status: 'SUPPORTED', finalStatus: 'NEEDS_REVIEW')]));
      await _open(tester, server, _findings);
      expect(find.text('AI đề xuất:'), findsOneWidget);
      expect(find.text('Có cơ sở'), findsOneWidget);
      expect(find.text('Chuyên gia đã quyết định:'), findsOneWidget);
      expect(find.text('Cần thẩm tra'), findsOneWidget);
      expect(find.text('Cần kiểm chứng'), findsNothing);
    });

    testWidgets('there is no control that approves, rejects or applies, and a swipe on a card does nothing', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server);
      final ProviderContainer container = await _open(tester, server, _findings);

      for (final Type type in <Type>[FilledButton, ElevatedButton, OutlinedButton, TextButton, Dismissible, Checkbox, Switch]) {
        expect(find.byType(type), findsNothing, reason: '$type');
      }
      for (final String word in <String>['Duyệt', 'Chấp nhận', 'Từ chối', 'Approve', 'Accept', 'Reject']) {
        expect(find.textContaining(word), findsNothing, reason: word);
      }
      await tester.drag(find.byType(FindingCard).first, const Offset(-400, 0));
      await tester.drag(find.byType(FindingCard).first, const Offset(400, 0));
      await tester.longPress(find.byType(FindingCard).first);
      await tester.pumpAndSettle();
      expect(_writes(server), isEmpty, reason: 'nothing is sent by any gesture, the long press included');
      expect(currentLocation(container), _findings);
      expect(find.text('Cần kiểm chứng'), findsNWidgets(2));
    });

    test('a push carries the id of a notification and nothing else: no action, decision or finding in it is read, so no push can approve a finding', () {
      final PushPayload? payload = PushPayload.parse(<String, Object?>{'nid': 'ntf-0123456789abcdef', 'action': 'approve', 'decision': 'APPROVED', 'finding_id': 'f-1'});
      expect(payload?.notificationId, 'ntf-0123456789abcdef');
      expect(payload?.location, '/r/ntf-0123456789abcdef', reason: 'the opaque link opens the notification; the decision is never part of it');
      expect(PushPayload.parse(<String, Object?>{'action': 'approve', 'finding_id': 'f-1'}), isNull, reason: 'without a notification id there is no payload to act on');
    });

    testWidgets('a run that did not reach the experts says why, and a view keeps only the findings that await verification', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server);
      server.on(
        'GET',
        '/analysis-runs/:id/findings',
        (_) => findingsOf(<Map<String, Object?>>[finding('f-1', finalStatus: 'SUPPORTED'), finding('f-2', criterion: 'C-FIN-02')], run_: run(status: 'FAILED', failure: 'REJECTED_NO_CITATION', findings: 2, reviewed: 1)),
      );
      await _open(tester, server, _findings);
      expect(find.text('REJECTED_NO_CITATION'), findsOneWidget);
      expect(find.byType(FindingCard), findsNWidgets(2));

      await tester.tap(find.text('Chờ kiểm chứng'));
      await tester.pumpAndSettle();
      expect(find.byType(FindingCard), findsOneWidget);
      expect(find.text('Tiêu chí C-FIN-02'), findsOneWidget);

      await tester.ensureVisible(find.text('Thiếu nguồn').first);
      await tester.tap(find.text('Thiếu nguồn').first);
      await tester.pumpAndSettle();
      expect(find.byType(FindingCard), findsNothing);
      expect(find.text('Không có nhận xét nào trong mục này.'), findsOneWidget);
    });

    testWidgets('a citation of a card opens its source, and the runs list opens the findings of a run', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server);
      final ProviderContainer container = await _open(tester, server, '/projects/mob-38');
      expect(find.text('Công ty Xây dựng Sông Hồng'), findsOneWidget);
      await tester.tap(find.text('Công ty Xây dựng Sông Hồng'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), _findings);

      await tester.tap(find.text('Tệp aaaaaaaa · Trang 12').first);
      await tester.pumpAndSettle();
      expect(currentLocation(container), _source);
    });

    testWidgets('a figure computed in code is a citation without a page: it is shown and cannot be opened as a source', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server);
      final Map<String, Object?> calc = evidence('ev-calc', kind: 'DETERMINISTIC_CALC', doc: null, page: null, quote: null, calc: <String, Object?>{'id': 'TOTAL_PRICE'});
      server.on('GET', '/analysis-runs/:id/findings', (_) => findingsOf(<Map<String, Object?>>[finding('f-1', evidence_: <Map<String, Object?>>[calc])]));
      final ProviderContainer container = await _open(tester, server, _findings);
      expect(find.text('Số liệu tính bằng mã: TOTAL_PRICE'), findsOneWidget);
      await tester.tap(find.text('Số liệu tính bằng mã: TOTAL_PRICE'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), _findings, reason: 'there is no page to open');

      await _open(tester, server, '/projects/mob-39?run=$kRun&finding=f-1&evidence=ev-calc');
      expect(find.text('Không tìm thấy nội dung'), findsOneWidget);
      expect(server.callsTo('GET', '/proposals/$kProposal/ocr-pages'), isEmpty);
    });

    testWidgets('the findings come from the server every time and nothing is kept on the device', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server);
      final ProviderContainer container = await _open(tester, server, _findings);
      expect((container.read(readCacheProvider) as InMemoryReadCache).length, 0);
    });
  });

  group('AC-ST-MOB-030-2 UAT-PLAN-42 every state the server names has its words', () {
    testWidgets('the runs list says how each run stands, and the findings say what the model said and with what kind of signal', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server);
      const List<String> statuses = <String>['QUEUED', 'RUNNING', 'AWAITING_REVIEW', 'COMPLETED', 'FAILED', 'CANCELLED', 'REJECTED_BY_POLICY'];
      server.on('GET', '/resources/analysis_run', (_) => page(<Object?>[for (final String status in statuses) run(status: status)]));
      await _open(tester, server, '/projects/mob-38');
      for (final String words in <String>['Đang chờ', 'Đang chạy', 'Chờ chuyên gia thẩm tra', 'Hoàn tất', 'Thất bại', 'Đã hủy', 'Bị chính sách từ chối']) {
        expect(find.textContaining(words), findsOneWidget, reason: words);
      }

      server.on('GET', '/analysis-runs/:id/findings', (_) => findingsOf(<Map<String, Object?>>[
            finding('f-a', criterion: 'A', status: 'SUPPORTED', confidence: 'CALIBRATED'),
            finding('f-b', criterion: 'B', status: 'CONTRADICTED', confidence: 'HEURISTIC'),
            finding('f-c', criterion: 'C', status: 'MISSING', confidence: 'NONE'),
          ]));
      await _open(tester, server, _findings);
      for (final String words in <String>['Có cơ sở', 'Mâu thuẫn', 'Không thấy trong hồ sơ', 'đã hiệu chuẩn trên bộ đánh giá', 'ước lượng của mô hình', 'Tín hiệu: không có']) {
        expect(find.textContaining(words), findsOneWidget, reason: words);
      }
    });

    testWidgets('the source viewer says how the page was reviewed by a person', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      for (final MapEntry<String, String> entry in <String, String>{'AUTO_ACCEPTED': 'Tự động chấp nhận', 'CONFIRMED': 'Đã được người xác nhận', 'CORRECTED': 'Đã được người sửa'}.entries) {
        final ScriptedServer server = ScriptedServer();
        aiServer(server);
        server.on('GET', '/proposals/:id/ocr-pages', (_) => ocrPages(<Map<String, Object?>>[ocrPage(kDoc, 11, kPageText, reviewStatus: entry.key)]));
        await _open(tester, server, _source);
        expect(find.text(entry.value), findsOneWidget, reason: entry.key);
        expect(find.textContaining('đang chờ người xác nhận'), findsNothing);
      }
    });
  });

  group('AC-ST-MOB-030-3 UAT-PLAN-43 MOB-39 opens the cited passage after a permission recheck and a revoked user gets 404', () {
    testWidgets('the finding is read first, then the page, and the quotation is marked where it stands in the page', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server);
      await _open(tester, server, _source);

      final List<String> paths = <String>[for (final HttpCall call in server.calls) call.url.path.replaceFirst('/v1', '')];
      expect(paths.indexOf('/analysis-runs/$kRun/findings'), lessThan(paths.indexOf('/proposals/$kProposal/ocr-pages')), reason: 'the access is judged before the page is read');
      expect(server.callsTo('GET', '/proposals/$kProposal/ocr-pages').single.url.queryParameters, containsPair('document_version_id', kDoc));
      expect(find.text('Hồ sơ năng lực'), findsOneWidget);
      expect(find.text('12'), findsOneWidget);
      expect(find.text('Có trên trang (máy chủ đã kiểm)'), findsOneWidget);
      final RichText page = tester.widget<RichText>(find.byWidgetPredicate((Widget w) => w is RichText && w.text.toPlainText() == kPageText));
      final TextSpan marked = _leaves(page.text).singleWhere((TextSpan s) => s.style?.fontWeight == FontWeight.w600);
      expect(marked.text, 'thực hiện hợp đồng tương tự\ntại tỉnh B', reason: 'the line break of the page stands for the space of the quotation');
      expect(_writes(server), isEmpty);
    });

    testWidgets('a revoked user gets 404 and nothing of the page is read or shown', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server);
      server.refuse('GET', '/analysis-runs/:id/findings', 404, 'RESOURCE_NOT_FOUND');
      await _open(tester, server, _source);

      expect(find.text('Không tìm thấy nội dung'), findsOneWidget);
      expect(find.text('RESOURCE_NOT_FOUND'), findsOneWidget);
      expect(server.callsTo('GET', '/proposals/$kProposal/ocr-pages'), isEmpty, reason: 'the page is not even asked for');
      expect(find.textContaining('Nhà thầu đã thực hiện'), findsNothing);
      expect(find.textContaining('thực hiện hợp đồng'), findsNothing);
    });

    testWidgets('the page itself answering 404 is the same not-found, and a retry asks the server again', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server);
      server.refuse('GET', '/proposals/:id/ocr-pages', 404, 'RESOURCE_NOT_FOUND');
      await _open(tester, server, _source);
      expect(find.text('Không tìm thấy nội dung'), findsOneWidget);

      server.on('GET', '/proposals/:id/ocr-pages', (_) => ocrPages(<Map<String, Object?>>[ocrPage(kDoc, 11, kPageText)]));
      await tester.tap(find.widgetWithText(OutlinedButton, 'Thử lại'));
      await tester.pumpAndSettle();
      expect(find.text('Nội dung trang'), findsOneWidget);
    });

    testWidgets('a citation that is not on the person\'s finding names nothing', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server);
      await _open(tester, server, '/projects/mob-39?run=$kRun&finding=f-1&evidence=someone-elses');
      expect(find.text('Không tìm thấy nội dung'), findsOneWidget);
      expect(server.callsTo('GET', '/proposals/$kProposal/ocr-pages'), isEmpty);

      await _open(tester, server, '/projects/mob-39');
      expect(find.text('Không tìm thấy nội dung'), findsOneWidget);
      await _open(tester, server, '/projects/mob-39?package=$kPackage&doc=$kDoc&page=-1');
      expect(find.text('Không tìm thấy nội dung'), findsOneWidget);
    });

    testWidgets('a person who may read the finding but not the page text sees the quotation only', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server);
      server.refuse('GET', '/proposals/:id/ocr-pages', 403, 'SCOPE_DENIED');
      await _open(tester, server, _source);
      expect(find.text('Bạn không được đọc nội dung trang này; chỉ hiển thị đoạn trích.'), findsOneWidget);
      expect(find.text('“$kQuote”'), findsOneWidget);
    });

    testWidgets('a citation the server did not find on the page is shown as not found, and a page that waits for a person is flagged', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server);
      server
        ..on('GET', '/analysis-runs/:id/findings', (_) => findingsOf(<Map<String, Object?>>[finding('f-1', evidence_: <Map<String, Object?>>[evidence('ev-f-1', verified: false, quote: 'những lời không có trên trang')])]))
        ..on('GET', '/proposals/:id/ocr-pages', (_) => ocrPages(<Map<String, Object?>>[ocrPage(kDoc, 11, kPageText, reviewStatus: 'NEEDS_REVIEW')]));
      await _open(tester, server, _source);
      expect(find.text('Không thấy trên trang'), findsOneWidget);
      expect(find.textContaining('đang chờ người xác nhận'), findsOneWidget);
      final RichText page = tester.widget<RichText>(find.byWidgetPredicate((Widget w) => w is RichText && w.text.toPlainText() == kPageText));
      expect(_leaves(page.text).where((TextSpan s) => s.style?.fontWeight == FontWeight.w600), isEmpty, reason: 'words that are not in the text are not marked');
    });

    testWidgets('a passage of a question opens through the proposals of the package the person has the full view of', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server);
      await _open(tester, server, '/projects/mob-39?package=$kPackage&doc=$kDoc&page=11');
      expect(server.callsTo('GET', '/resources/proposal').single.url.queryParameters, containsPair('package_id', kPackage));
      expect(find.text('Nội dung trang'), findsOneWidget);
      expect(find.byWidgetPredicate((Widget w) => w is RichText && w.text.toPlainText() == kPageText), findsOneWidget);
      expect(find.text('Có trên trang (máy chủ đã kiểm)'), findsNothing, reason: 'a passage carries no verdict of a finding');
    });

    testWidgets('a revoked user, a sealed proposal or no proposal at all is a 404 for a passage', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      for (final Map<String, Object?> answer in <Map<String, Object?>>[proposals(access: 'SUMMARY'), proposals(locked: true), page(<Object?>[])]) {
        final ScriptedServer server = ScriptedServer();
        aiServer(server);
        server.on('GET', '/resources/proposal', (_) => answer);
        await _open(tester, server, '/projects/mob-39?package=$kPackage&doc=$kDoc&page=11');
        expect(find.text('Không tìm thấy nội dung'), findsOneWidget);
        expect(server.callsTo('GET', '/proposals/$kProposal/ocr-pages'), isEmpty);
      }
      final ScriptedServer server = ScriptedServer();
      aiServer(server);
      server.refuse('GET', '/proposals/:id/ocr-pages', 404, 'RESOURCE_NOT_FOUND');
      await _open(tester, server, '/projects/mob-39?package=$kPackage&doc=$kDoc&page=11');
      expect(find.text('Không tìm thấy nội dung'), findsOneWidget);
    });
  });

  group('AC-ST-MOB-030-4 UI-MOB-37 the seven states and the screen contract', () {
    ScriptedServer fresh() => ScriptedServer();

    testWidgets('UI-MOB-37 the scope list draws the content, loading, empty, error, denied, expired licence, ended session and offline states', (WidgetTester tester) async {
      await expectEveryState(
        tester,
        open: (WidgetTester t, ScriptedServer s) => _openAt(t, s, '/projects/mob-37'),
        script: StateScript(healthy: aiServer, content: find.text('GT-2026-07'), empty: (ScriptedServer s) => s.on('GET', '/resources/procurement_package', (_) => page(<Object?>[]))),
      );
    });

    testWidgets('UI-MOB-37 the screen contract holds on the scope list and on the thread at three sizes and 200 percent text', (WidgetTester tester) async {
      await expectScreenContract(tester, open: (WidgetTester t, ScriptedServer s) => _openAt(t, s, '/projects/mob-37'), healthy: aiServer);
      await expectScreenContract(tester, open: (WidgetTester t, ScriptedServer s) => _openAt(t, s, _qa), healthy: aiServer);
    });

    testWidgets('UI-MOB-37 the thread with an answer holds the contract at three sizes and 200 percent text', (WidgetTester tester) async {
      await expectScreenContract(
        tester,
        open: (WidgetTester t, ScriptedServer s) async {
          await _openAt(t, s, _qa);
          await t.scrollUntilVisible(find.byType(TextField), 300, scrollable: find.byType(Scrollable).hitTestable().first);
          await _type(t, 'Kinh nghiệm?');
          await t.ensureVisible(_ask());
          await t.tap(_ask());
          await t.pumpAndSettle();
          expect(find.textContaining('đoạn gần nhất', skipOffstage: false), findsOneWidget);
        },
        healthy: aiServer,
      );
    });

    testWidgets('UI-MOB-38 the findings draw the seven states', (WidgetTester tester) async {
      await expectEveryState(tester, open: (WidgetTester t, ScriptedServer s) => _openAt(t, s, _findings), script: StateScript(healthy: aiServer, content: find.text('Lượt phân tích')));
    });

    testWidgets('UI-MOB-38 the runs list draws the seven states', (WidgetTester tester) async {
      await expectEveryState(
        tester,
        open: (WidgetTester t, ScriptedServer s) => _openAt(t, s, '/projects/mob-38'),
        script: StateScript(healthy: aiServer, content: find.text('GT-2026-07'), empty: (ScriptedServer s) => s.on('GET', '/resources/analysis_run', (_) => page(<Object?>[]))),
      );
    });

    testWidgets('UI-MOB-38 the screen contract holds on the findings and on the runs', (WidgetTester tester) async {
      await expectScreenContract(tester, open: (WidgetTester t, ScriptedServer s) => _openAt(t, s, _findings), healthy: aiServer);
      await expectScreenContract(tester, open: (WidgetTester t, ScriptedServer s) => _openAt(t, s, '/projects/mob-38'), healthy: aiServer);
    });

    testWidgets('UI-MOB-39 the source viewer draws the seven states', (WidgetTester tester) async {
      await expectEveryState(tester, open: (WidgetTester t, ScriptedServer s) => _openAt(t, s, _source), script: StateScript(healthy: aiServer, content: find.text('Nội dung trang')));
    });

    testWidgets('UI-MOB-39 the screen contract holds on the source viewer', (WidgetTester tester) async {
      await expectScreenContract(tester, open: (WidgetTester t, ScriptedServer s) => _openAt(t, s, _source), healthy: aiServer);
    });

    testWidgets('the same screens are in English', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = fresh();
      aiServer(server);
      await pumpWithServer(tester, features: <MobileFeature>[ai.feature], server: server, location: _findings, locale: const Locale('en'));
      expect(find.text('AI proposal - expert review required'), findsWidgets);
      expect(find.text('Needs verification'), findsWidgets);
    });
  });

  group('AC-ST-MOB-030-1 AC-ST-MOB-030-3 UAT-PLAN-43 a confidential thread and a fresh read belong to one session and one resource', () {
    const SessionSnapshot tenantB = SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-b', userId: 'user-1');
    final Map<String, SessionSnapshot> changes = <String, SessionSnapshot>{
      'another tenant': tenantB,
      'another person': const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-2'),
      'another membership': const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1', membershipId: 'm-2'),
      'signing out': const SessionSnapshot.signedOut(),
    };

    for (final MapEntry<String, SessionSnapshot> change in changes.entries) {
      testWidgets('MOB-37 the thread and the typed question are dropped when the session turns to ${change.key}', (WidgetTester tester) async {
        useDevice(tester, kTallDevice);
        final ScriptedServer server = ScriptedServer();
        aiServer(server);
        final FakeSession session = FakeSession();
        await pumpWithServer(tester, features: <MobileFeature>[ai.feature], server: server, location: _qa, session: session);
        await _type(tester, 'Câu hỏi bí mật');
        await tester.tap(_ask());
        await tester.pumpAndSettle();
        expect(find.text('Nhà thầu đã thực hiện hợp đồng tương tự tại tỉnh B.'), findsOneWidget);
        await _type(tester, 'Câu hỏi chưa gửi');

        session.change(change.value);
        await tester.pumpAndSettle();

        expect(find.text('Nhà thầu đã thực hiện hợp đồng tương tự tại tỉnh B.'), findsNothing, reason: 'the passages of the other session are gone');
        expect(find.text('Câu hỏi bí mật'), findsNothing);
        expect(find.text('Câu hỏi chưa gửi'), findsNothing, reason: 'the typed question is not carried over either');
      });
    }

    testWidgets('MOB-37 an answer that arrives after the session changed is not shown, and the new session can ask at once', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server);
      final Completer<HttpResult> held = Completer<HttpResult>();
      int asked = 0;
      server.answer('GET', '/procurement-packages/:id/proposal-passages', (HttpCall call) {
        asked += 1;
        return asked == 1
            ? held.future
            : FakeTransport.json(200, <String, Object?>{'items': <Object?>[passage(kDoc2, 3, 0, 'Đoạn của bên B.')], 'as_of': '2026-11-03T02:00:00Z'});
      });
      final FakeSession session = FakeSession();
      await pumpWithServer(tester, features: <MobileFeature>[ai.feature], server: server, location: _qa, session: session);
      await _type(tester, 'Câu hỏi của A');
      await tester.tap(_ask());
      await tester.pump();
      expect(find.text('Đang tìm dẫn chứng trong phạm vi của bạn…'), findsOneWidget);

      session.change(tenantB);
      await tester.pumpAndSettle();
      expect(tester.widget<FilledButton>(_ask()).onPressed, isNotNull, reason: 'nothing of tenant A is still being asked');
      held.complete(FakeTransport.json(200, <String, Object?>{'items': <Object?>[passage(kDoc, 11, 0, 'Đoạn mật của bên A.')], 'as_of': '2026-11-03T02:00:00Z'}));
      await tester.pumpAndSettle();
      expect(find.text('Đoạn mật của bên A.'), findsNothing);
      expect(find.text('Câu hỏi của A'), findsNothing);

      await _type(tester, 'Câu hỏi của B');
      await tester.tap(_ask());
      await tester.pumpAndSettle();
      expect(find.text('Đoạn của bên B.'), findsOneWidget);
      expect(find.text('Đoạn mật của bên A.'), findsNothing);
    });

    testWidgets('MOB-38 the findings of another run on the same route are read again, and the answer of the first run is not shown', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server);
      server.on('GET', '/analysis-runs/:id/findings', (HttpCall call) {
        final bool second = call.url.path.contains('run-2');
        return findingsOf(<Map<String, Object?>>[finding(second ? 'f-run2' : 'f-run1', text: second ? 'Nhận định của lượt hai.' : 'Nhận định của lượt một.')]);
      });
      final ProviderContainer container = await _open(tester, server, _findings);
      expect(find.text('Nhận định của lượt một.'), findsOneWidget);

      container.read(routerProvider).go('/projects/mob-38?run=run-2');
      await tester.pumpAndSettle();

      expect(server.callsTo('GET', '/analysis-runs/run-2/findings'), hasLength(1));
      expect(find.text('Nhận định của lượt hai.'), findsOneWidget);
      expect(find.text('Nhận định của lượt một.'), findsNothing);
    });

    testWidgets('MOB-38 a change of membership reads the findings again: what a person sees depends on the unit and role', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server);
      final FakeSession session = FakeSession();
      await pumpWithServer(tester, features: <MobileFeature>[ai.feature], server: server, location: _findings, session: session);
      expect(server.callsTo('GET', '/analysis-runs/$kRun/findings'), hasLength(1));

      session.change(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1', membershipId: 'm-2'));
      await tester.pumpAndSettle();

      expect(server.callsTo('GET', '/analysis-runs/$kRun/findings'), hasLength(2));
    });

    testWidgets('MOB-39 another citation on the same route is read again', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server);
      final ProviderContainer container = await _open(tester, server, _source);
      final int before = server.callsTo('GET', '/analysis-runs/$kRun/findings').length;
      expect(before, 1);

      container.read(routerProvider).go('/projects/mob-39?run=$kRun&finding=f-2&evidence=ev-x');
      await tester.pumpAndSettle();

      expect(server.callsTo('GET', '/analysis-runs/$kRun/findings'), hasLength(2), reason: 'the new citation is not the one that was read');
    });
  });

  group('AC-ST-MOB-030-1 AC-ST-MOB-030-3 UAT-PLAN-43 a thread belongs to one package and a lookup follows the cursors to the end of the collection', () {
    testWidgets('MOB-37 another package on the same route starts an empty thread: no answer, no pending question, no old question asked again', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server);
      final Completer<HttpResult> held = Completer<HttpResult>();
      int asked = 0;
      server.answer('GET', '/procurement-packages/:id/proposal-passages', (HttpCall call) {
        asked += 1;
        return asked == 1 ? FakeTransport.json(200, <String, Object?>{'items': <Object?>[passage(kDoc, 11, 0, 'Đoạn của gói một.')], 'as_of': '2026-11-03T02:00:00Z'}) : held.future;
      });
      final ProviderContainer container = await _open(tester, server, _qa);
      await _type(tester, 'Câu hỏi gói một');
      await tester.tap(_ask());
      await tester.pumpAndSettle();
      expect(find.text('Đoạn của gói một.'), findsOneWidget);
      await _type(tester, 'Câu hỏi gói hai');
      await tester.tap(_ask());
      await tester.pump();
      expect(find.text('Đang tìm dẫn chứng trong phạm vi của bạn…'), findsOneWidget);
      await _type(tester, 'Câu hỏi chưa gửi');

      container.read(routerProvider).go('/projects/mob-37?package=pk-2');
      await tester.pumpAndSettle();

      expect(find.text('Đoạn của gói một.'), findsNothing, reason: 'the answer of the first package is not shown under the second');
      expect(find.text('Câu hỏi gói một'), findsNothing);
      expect(find.text('Câu hỏi gói hai'), findsNothing, reason: 'a question still waiting for the first package is dropped with it');
      expect(find.text('Câu hỏi chưa gửi'), findsNothing, reason: 'the typed question is not carried over either');
      expect(tester.widget<FilledButton>(_ask()).onPressed, isNotNull, reason: 'nothing is still being asked');
      held.complete(FakeTransport.json(200, <String, Object?>{'items': <Object?>[passage(kDoc2, 3, 0, 'Đoạn muộn của gói một.')], 'as_of': '2026-11-03T02:00:00Z'}));
      await tester.pumpAndSettle();
      expect(find.text('Đoạn muộn của gói một.'), findsNothing, reason: 'the late answer fills a card nobody shows');
    });

    testWidgets('MOB-37 a question asked after the package changed goes to the new package, and its chips name it', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server);
      final ProviderContainer container = await _open(tester, server, _qa);
      container.read(routerProvider).go('/projects/mob-37?package=pk-2');
      await tester.pumpAndSettle();

      await _type(tester, 'Câu hỏi gói hai');
      await tester.tap(_ask());
      await tester.pumpAndSettle();
      expect(server.callsTo('GET', '/procurement-packages/pk-2/proposal-passages'), hasLength(1));
      expect(server.callsTo('GET', '/procurement-packages/$kPackage/proposal-passages'), isEmpty);
      await tester.tap(find.text('Tệp aaaaaaaa · Trang 12'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/projects/mob-39?package=pk-2&doc=$kDoc&page=11');
    });

    int cursorNo(HttpCall call) => int.tryParse((call.url.queryParameters['cursor'] ?? 'c0').substring(1)) ?? 0;
    Map<String, Object?> pageOfRecords(List<Object?> items, String? next) => <String, Object?>{...ocrPages(<Map<String, Object?>>[]), 'items': items, 'next_cursor': next};

    testWidgets('MOB-39 a cited page beyond the first thousand records is found by following the cursors to the end', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server);
      server.on('GET', '/proposals/:id/ocr-pages', (HttpCall call) {
        final int n = cursorNo(call);
        return n < 7 ? pageOfRecords(<Object?>[ocrPage(kDoc, 100 + n, 'Trang khác')], 'c${n + 1}') : pageOfRecords(<Object?>[ocrPage(kDoc, 11, kPageText)], null);
      });
      await _open(tester, server, _source);

      expect(find.textContaining('tại tỉnh B trong năm 2024'), findsOneWidget, reason: 'the cited page is on the eighth page of records');
      expect(find.text('Không đọc được nội dung của trang này.'), findsNothing);
      expect(server.callsTo('GET', '/proposals/$kProposal/ocr-pages'), hasLength(8));
    });

    testWidgets('MOB-39 a page the collection really lacks is called unreadable only after every cursor was followed', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server);
      server.on('GET', '/proposals/:id/ocr-pages', (HttpCall call) {
        final int n = cursorNo(call);
        return pageOfRecords(<Object?>[ocrPage(kDoc, 100 + n, 'Trang khác')], n < 8 ? 'c${n + 1}' : null);
      });
      await _open(tester, server, _source);

      expect(server.callsTo('GET', '/proposals/$kProposal/ocr-pages'), hasLength(9), reason: 'the collection is read to its end before the page is called absent');
      expect(find.text('Không đọc được nội dung của trang này.'), findsOneWidget);
    });

    testWidgets('MOB-39 a cursor that repeats stops the lookup instead of asking for ever', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server);
      server.on('GET', '/proposals/:id/ocr-pages', (_) => pageOfRecords(<Object?>[ocrPage(kDoc, 100, 'Trang khác')], 'same'));
      await _open(tester, server, _source);

      expect(server.callsTo('GET', '/proposals/$kProposal/ocr-pages'), hasLength(2));
    });

    testWidgets('MOB-39 a finding on a late page of the run is found, not called a record that does not exist', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server);
      server.on('GET', '/analysis-runs/:id/findings', (HttpCall call) {
        final int n = cursorNo(call);
        return <String, Object?>{...findingsOf(<Map<String, Object?>>[finding(n < 6 ? 'f-other-$n' : 'f-1')]), 'next_cursor': n < 6 ? 'c${n + 1}' : null};
      });
      await _open(tester, server, _source);

      expect(find.textContaining('tại tỉnh B trong năm 2024'), findsOneWidget);
    });

    testWidgets('MOB-39 the proposal that holds the cited passage is found on a late page of the package proposals', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      aiServer(server);
      server.on('GET', '/resources/proposal', (HttpCall call) {
        final int n = cursorNo(call);
        return <String, Object?>{
          'items': <Object?>[
            <String, Object?>{'id': n < 3 ? 'prop-x$n' : kProposal, 'access': 'FULL', 'locked': false},
          ],
          'next_cursor': n < 3 ? 'c${n + 1}' : null,
          'as_of': '2026-11-02T09:00:00Z',
        };
      });
      server.on('GET', '/proposals/prop-x0/ocr-pages', (_) => ocrPages(<Map<String, Object?>>[]));
      server.refuse('GET', '/proposals/prop-x1/ocr-pages', 404, 'RESOURCE_NOT_FOUND');
      server.refuse('GET', '/proposals/prop-x2/ocr-pages', 403, 'FORBIDDEN');
      await _open(tester, server, '/projects/mob-39?package=$kPackage&doc=$kDoc&page=11');

      expect(find.textContaining('tại tỉnh B trong năm 2024'), findsOneWidget);
    });
  });

  group('the pure rules of the citations', () {
    test('locateQuote finds the words where the page has other white space and refuses words that are not there', () {
      expect(locateQuote('a  b\nc d', 'b c'), (start: 3, end: 6));
      expect(locateQuote('a b c', 'x'), isNull);
      expect(locateQuote('a b c', '   '), isNull);
    });

    test('a finding with no status the contract knows is refused as a whole', () {
      expect(parseFinding(finding('f-1', status: 'APPROVED')), isNull);
      expect(parseFindingList(<String, Object?>{'items': <Object?>[]}), isNull, reason: 'a list with no run');
    });

    test('a page whose text cannot be read gives no text, and a corrected page gives the correction', () {
      final SourcePage? lost = parseSourcePage(ocrPages(<Map<String, Object?>>[ocrPage(kDoc, 1, 'x', textState: 'DIGEST_MISMATCH')]), documentVersionId: kDoc, pageIndex: 1);
      expect(lost, isNotNull);
      expect(lost!.text, isNull);
      final SourcePage? fixed = parseSourcePage(ocrPages(<Map<String, Object?>>[ocrPage(kDoc, 1, 'old', corrected: 'new')]), documentVersionId: kDoc, pageIndex: 1);
      expect(fixed!.text, 'new');
      expect(parseSourcePage(ocrPages(<Map<String, Object?>>[]), documentVersionId: kDoc, pageIndex: 1), isNull);
    });
  });
}
