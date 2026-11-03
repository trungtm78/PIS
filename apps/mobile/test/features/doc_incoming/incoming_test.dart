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
import 'package:machvon_mobile/features/doc_incoming/doc_incoming_feature.dart' as incoming;
import 'package:machvon_mobile/features/doc_incoming/incoming_commands.dart';
import 'package:machvon_mobile/features/doc_incoming/incoming_models.dart';
import 'package:machvon_mobile/features/doc_incoming/incoming_support.dart';
import 'package:machvon_mobile/features/read_support/read_cache.dart';

import '../../support/harness.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'fixtures.dart';

const String _list = '/approval/doc-23';
const String _detail = '/approval/doc-23?doc=in-1';

Future<ProviderContainer> _open(WidgetTester tester, ScriptedServer server, String location, {FakeSession? session, Locale locale = const Locale('vi')}) =>
    pumpWithServer(tester, features: <MobileFeature>[incoming.feature], server: server, location: location, session: session ?? handlerSession(), locale: locale);

List<HttpCall> _posts(ScriptedServer server, String path) => server.callsTo('POST', path);

Finder _start() => find.widgetWithText(FilledButton, 'Bắt đầu xử lý');
Finder _resolve() => find.widgetWithText(OutlinedButton, 'Giải quyết');
Finder _summary() => find.widgetWithText(TextField, 'Nội dung giải quyết');
Finder _submit() => find.widgetWithText(FilledButton, 'Xác nhận đã giải quyết');

void main() {
  group('UI-DOC-23 FR-DOC-23 the incoming letters to handle, on the phone', () {
    testWidgets('lists the letters assigned to the handler, the late ones first, with number, subject, directive, deadline and status', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      answerLetters(server, <Map<String, Object?>>[
        letter(1),
        letter(2, overdueDays: 3, due: '2026-10-20', directive: null, number: null),
        letter(4, handler: 'someone-else', act: actions()),
        letter(5, status: 'PROCESSING', handler: null, due: null, act: actions(resolve: true), symbol: null),
        letter(6, due: '2026-10-26', urgency: 'KHAN'),
      ]);
      final ProviderContainer container = await _open(tester, server, _list);

      double top(String text) => tester.getTopLeft(find.text(text)).dy;
      expect(find.text('Công văn số 4'), findsNothing, reason: 'a letter of someone else, with no action for this reader, is not on the list');
      expect(top('Công văn số 2'), lessThan(top('Công văn số 6')), reason: 'the late one first');
      expect(top('Công văn số 6'), lessThan(top('Công văn số 1')), reason: 'then by deadline');
      expect(top('Công văn số 1'), lessThan(top('Công văn số 5')), reason: 'a letter with no deadline last');
      expect(find.text('Số đến 10 · 10/REG-DEN-2026 · Sở Giao thông 1'), findsOneWidget);
      expect(find.text('Bút phê: Chuẩn bị ý kiến.'), findsWidgets);
      expect(find.text('Chưa có bút phê'), findsOneWidget);
      expect(find.text('Chưa có số đến · Sở Giao thông 2'), findsOneWidget);
      expect(find.text('Hạn xử lý: 27/10/2026'), findsOneWidget);
      expect(find.text('Chưa đặt hạn xử lý'), findsOneWidget);
      expect(find.text('Quá hạn 3 ngày (hạn 20/10/2026)'), findsWidgets);
      expect(find.text('Đã giao xử lý'), findsWidgets);
      expect(find.text('Đang xử lý'), findsOneWidget);
      expect(find.text('Khẩn'), findsOneWidget);

      await tester.tap(find.text('Công văn số 6'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/approval/doc-23?doc=in-6');
      expect(server.calls.where((HttpCall call) => call.method != 'GET'), isEmpty, reason: 'opening a letter sends no command');
    });

    testWidgets('reads the assigned and the processing letters one status at a time and says when there are more than were loaded', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      int pages = 0;
      server.on('GET', '/incoming-documents', (HttpCall call) {
        final String? status = call.url.queryParameters['status'];
        pages += 1;
        // The assigned letters never end; the processing ones fit in one page.
        return letterPage(<Map<String, Object?>>[letter(status == 'ASSIGNED' ? 1 : 2, status: status!)], next: status == 'ASSIGNED' ? 'c$pages' : null);
      });
      await _open(tester, server, _list);

      final List<HttpCall> reads = server.callsTo('GET', '/incoming-documents');
      expect(reads.map((HttpCall call) => call.url.queryParameters['status']).toSet(), <String?>{'ASSIGNED', 'PROCESSING'});
      expect(find.text('Còn văn bản chưa tải về hết. Hãy xử lý bớt rồi làm mới danh sách.'), findsOneWidget);
    });

    testWidgets('shows one letter whole: the letter, the history of assignments, the file by its fingerprint, and no copy of the file', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      answerLetters(server, <Map<String, Object?>>[
        letter(1, overdueDays: 2, assignments: <Object?>[
          <String, Object?>{
            'id': 'a-1',
            'assigned_unit': <String, Object?>{'id': 'u-1', 'name': 'Phòng Quản lý dự án'},
            'assignee': <String, Object?>{'user_id': kHandler, 'display_name': 'Lê Chuyên Viên'},
            'leader_directive': 'Chuẩn bị ý kiến.',
            'due_on': '2026-10-27',
            'assigned_at': '2026-10-21T02:00:00Z',
          },
        ]),
      ]);
      await _open(tester, server, _detail);

      expect(find.text('Công văn số 1'), findsOneWidget);
      expect(find.text('Sở Giao thông 1'), findsOneWidget);
      expect(find.text('100/UBND'), findsOneWidget);
      expect(find.text('Phòng Quản lý dự án'), findsOneWidget);
      expect(find.text('Quá hạn 2 ngày (hạn 27/10/2026)'), findsOneWidget);
      expect(find.text('Phòng Quản lý dự án · Lê Chuyên Viên · giao lúc 21/10/2026 09:00'), findsOneWidget);
      expect(find.text('Mã băm của tệp gốc: ab12cd34ef56'), findsOneWidget);
      expect(find.textContaining('Điện thoại không tải tệp của văn bản đến'), findsOneWidget);
      expect(server.calls.where((HttpCall call) => call.url.path.contains('download')), isEmpty, reason: 'the file of a letter is not read on the phone');
    });

    testWidgets('a resolved letter shows its resolution and the days it was late', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      answerLetters(server, <Map<String, Object?>>[letter(1, status: 'RESOLVED', summary: 'Đã trả lời bằng văn bản', act: actions(), fileHash: null)]);
      await _open(tester, server, _detail);

      expect(find.text('Đã giải quyết lúc 28/10/2026 15:00: Đã trả lời bằng văn bản'), findsOneWidget);
      expect(find.text('Giải quyết trễ 1 ngày làm việc.'), findsOneWidget);
      expect(find.text('Văn bản này chưa có tệp.'), findsOneWidget);
      expect(find.text('Văn bản này không còn chờ xử lý.'), findsOneWidget);
      expect(_start(), findsNothing);
      expect(_resolve(), findsNothing);
    });

    testWidgets('speaks English with the sentences of the English web screens', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      answerLetters(server, <Map<String, Object?>>[letter(1, overdueDays: 1)]);
      await _open(tester, server, _list, locale: const Locale('en'));
      expect(find.text('Incoming letters to handle'), findsOneWidget);
      expect(find.text('Overdue by 1 day(s) (due 27/10/2026)'), findsWidgets);
      expect(find.text('Directive: Chuẩn bị ý kiến.'), findsOneWidget);
    });

    testWidgets('every state of the list and of a letter is drawn, and both views keep the screen contract', (WidgetTester tester) async {
      void healthy(ScriptedServer server) => answerLetters(server, <Map<String, Object?>>[letter(1)]);
      await expectEveryState(
        tester,
        open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, _list),
        script: StateScript(healthy: healthy, content: find.text('Công văn số 1'), empty: (ScriptedServer server) => answerLetters(server, <Map<String, Object?>>[])),
      );
      await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, _list), healthy: healthy);
      await expectEveryState(
        tester,
        open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, _detail),
        script: StateScript(healthy: healthy, content: find.text('Công văn số 1')),
      );
      await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, _detail), healthy: healthy);
    });
  });

  group('UAT-AC420 AC-ST-DOC-020-2 an overdue letter says how many days late it is and can still be resolved, under an idempotency key', () {
    testWidgets('the overdue letter is resolved: one request under the version on the screen, a key, the trimmed words; the letter is read again', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      int reads = 0;
      server.on('GET', '/incoming-documents', (_) => letterPage(<Map<String, Object?>>[letter(1, status: 'PROCESSING', overdueDays: 1)]));
      server.on('GET', '/incoming-documents/in-1', (_) {
        reads += 1;
        return reads == 1 ? letter(1, status: 'PROCESSING', overdueDays: 1) : letter(1, status: 'RESOLVED', version: 4, summary: 'Đã trả lời bằng văn bản', act: actions());
      });
      server.answer('POST', '/incoming-documents/in-1/resolution', (_) => recorded('in-1', status: 'RESOLVED', version: 4));
      await _open(tester, server, _detail);

      expect(find.text('Quá hạn 1 ngày (hạn 27/10/2026)'), findsOneWidget);
      expect(find.text('Văn bản đã quá hạn 1 ngày; vẫn giải quyết được và độ trễ sẽ được ghi lại.'), findsOneWidget);
      await tester.tap(_resolve());
      await tester.pumpAndSettle();
      await tester.enterText(_summary(), '  Đã trả lời bằng văn bản  ');
      await tester.tap(_submit());
      await tester.pumpAndSettle();

      final List<HttpCall> calls = _posts(server, '/incoming-documents/in-1/resolution');
      expect(calls, hasLength(1));
      expect(calls.single.headers['idempotency-key'], isNotEmpty, reason: 'a command without a key is refused by the server, so none is sent');
      expect(calls.single.headers['if-match'], '"3"');
      expect(calls.single.body, contains('"resolution_summary":"Đã trả lời bằng văn bản"'));
      expect(find.text('Đã ghi nhận'), findsOneWidget);
      expect(reads, 2, reason: 'the letter is read again from the server');
      expect(find.text('Đã giải quyết lúc 28/10/2026 15:00: Đã trả lời bằng văn bản'), findsOneWidget);
      expect(_resolve(), findsNothing);
    });

    testWidgets('starting is one request under the version on the screen, with a key of its own', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      answerLetters(server, <Map<String, Object?>>[letter(1)]);
      server.answer('POST', '/incoming-documents/in-1/processing', (_) => recorded('in-1', status: 'PROCESSING', version: 4));
      await _open(tester, server, _detail);

      await tester.tap(_start());
      await tester.pumpAndSettle();
      final List<HttpCall> calls = _posts(server, '/incoming-documents/in-1/processing');
      expect(calls, hasLength(1));
      expect(calls.single.headers['idempotency-key'], isNotEmpty);
      expect(calls.single.headers['if-match'], '"3"');
      expect(find.text('Đã ghi nhận'), findsOneWidget);
    });

    testWidgets('a lost answer to a resolution is "result unknown" too: the same words sent again reuse the key and the version, other words are another command', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      answerLetters(server, <Map<String, Object?>>[letter(1, status: 'PROCESSING')]);
      int attempt = 0;
      server.answer('POST', '/incoming-documents/in-1/resolution', (_) {
        attempt += 1;
        if (attempt == 1) throw const SocketException('lost');
        return recorded('in-1', status: 'RESOLVED', version: 4);
      });
      await _open(tester, server, _detail);

      await tester.tap(_resolve());
      await tester.pumpAndSettle();
      await tester.enterText(_summary(), 'Đã giải quyết xong');
      await tester.tap(_submit());
      await tester.pumpAndSettle();
      expect(find.text('Chưa xác định kết quả'), findsOneWidget);
      await tester.tap(find.text('Gửi lại cùng thao tác'));
      await tester.pumpAndSettle();

      final List<HttpCall> calls = _posts(server, '/incoming-documents/in-1/resolution');
      expect(calls, hasLength(2));
      expect(calls[1].headers['idempotency-key'], calls[0].headers['idempotency-key']);
      expect(calls[1].headers['if-match'], calls[0].headers['if-match']);
      expect(calls[1].body, calls[0].body);
      expect(find.text('Đã ghi nhận'), findsOneWidget);
    });

    testWidgets('a lost answer is "result unknown": sending the same command again reuses the key and the version, so it is recorded once', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      answerLetters(server, <Map<String, Object?>>[letter(1)]);
      int attempt = 0;
      server.answer('POST', '/incoming-documents/in-1/processing', (_) {
        attempt += 1;
        if (attempt == 1) throw const SocketException('lost');
        return recorded('in-1', status: 'PROCESSING', version: 4);
      });
      await _open(tester, server, _detail);

      await tester.tap(_start());
      await tester.pumpAndSettle();
      expect(find.text('Chưa xác định kết quả'), findsOneWidget);
      await tester.tap(find.text('Gửi lại cùng thao tác'));
      await tester.pumpAndSettle();

      final List<HttpCall> calls = _posts(server, '/incoming-documents/in-1/processing');
      expect(calls, hasLength(2));
      expect(calls[1].headers['idempotency-key'], calls[0].headers['idempotency-key']);
      expect(calls[1].headers['if-match'], calls[0].headers['if-match']);
      expect(find.text('Đã ghi nhận'), findsOneWidget);
    });

    testWidgets('a final refusal ends the intention: the same request sent again after the cause is gone is a new command with a new key', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      answerLetters(server, <Map<String, Object?>>[letter(1)]);
      int attempt = 0;
      server.answer('POST', '/incoming-documents/in-1/processing', (_) {
        attempt += 1;
        return attempt == 1 ? problem(403, 'MFA_REQUIRED') : recorded('in-1', status: 'PROCESSING', version: 4);
      });
      await _open(tester, server, _detail);

      await tester.tap(_start());
      await tester.pumpAndSettle();
      expect(find.text('Cần xác thực lại hai yếu tố. Thao tác chưa được ghi nhận; hãy xác thực rồi thử lại.'), findsOneWidget);
      expect(find.text('MFA_REQUIRED'), findsOneWidget);
      await tester.tap(_start());
      await tester.pumpAndSettle();

      final List<HttpCall> calls = _posts(server, '/incoming-documents/in-1/processing');
      expect(calls, hasLength(2));
      expect(calls[1].headers['idempotency-key'], isNot(calls[0].headers['idempotency-key']));
    });

    testWidgets('the resolution is checked before anything is sent: required, at least 5 and at most 2000 characters', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      answerLetters(server, <Map<String, Object?>>[letter(1, status: 'PROCESSING')]);
      await _open(tester, server, _detail);

      await tester.tap(_resolve());
      await tester.pumpAndSettle();
      await tester.tap(_submit());
      await tester.pumpAndSettle();
      expect(find.text('Hãy nhập nội dung giải quyết.'), findsOneWidget);
      await tester.enterText(_summary(), ' ab ');
      await tester.tap(_submit());
      await tester.pumpAndSettle();
      expect(find.text('Nội dung giải quyết cần ít nhất 5 ký tự.'), findsOneWidget);
      await tester.enterText(_summary(), 'x' * 2001);
      await tester.tap(_submit());
      await tester.pumpAndSettle();
      expect(find.text('Nội dung giải quyết tối đa 2000 ký tự.'), findsOneWidget);
      expect(server.calls.where((HttpCall call) => call.method == 'POST'), isEmpty);
    });

    testWidgets('a refusal leaves the form with what was written, shows the sentence and the code, and reads the letter again', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      answerLetters(server, <Map<String, Object?>>[letter(1, status: 'PROCESSING')]);
      server.answer('POST', '/incoming-documents/in-1/resolution', (_) => problem(409, 'VERSION_CONFLICT'));
      await _open(tester, server, _detail);

      await tester.tap(_resolve());
      await tester.pumpAndSettle();
      await tester.enterText(_summary(), 'Đã giải quyết xong');
      await tester.tap(_submit());
      await tester.pumpAndSettle();

      expect(find.text('Văn bản đã thay đổi. Hãy mở lại văn bản rồi làm lại.'), findsOneWidget);
      expect(find.text('VERSION_CONFLICT'), findsOneWidget);
      expect(tester.widget<TextField>(_summary()).controller!.text, 'Đã giải quyết xong');
      expect(server.callsTo('GET', '/incoming-documents/in-1'), hasLength(2), reason: 'read again after a refusal');
    });

    testWidgets('each refusal of the server has its own sentence', (WidgetTester tester) async {
      const Map<String, String> sentences = <String, String>{
        'NOT_ASSIGNEE': 'Văn bản này không được giao cho bạn.',
        'DOCUMENT_STATE_INVALID': 'Văn bản không còn ở trạng thái cho phép thao tác này.',
        'LICENSE_EXPIRED': 'License đã hết hạn nên chưa thể xử lý.',
        'PERMISSION_DENIED': 'Bạn không có quyền thực hiện thao tác này.',
        'INTERNAL_ERROR': 'Chưa thực hiện được. Hãy thử lại sau ít phút.',
      };
      for (final MapEntry<String, String> entry in sentences.entries) {
        useDevice(tester, kTallDevice);
        final ScriptedServer server = ScriptedServer();
        answerLetters(server, <Map<String, Object?>>[letter(1)]);
        server.answer('POST', '/incoming-documents/in-1/processing', (_) => problem(entry.key == 'INTERNAL_ERROR' ? 500 : (entry.key == 'PERMISSION_DENIED' ? 403 : 422), entry.key));
        await _open(tester, server, _detail);
        await tester.tap(_start());
        await tester.pumpAndSettle();
        expect(find.text(entry.value), findsOneWidget, reason: entry.key);
        expect(find.text(entry.key), findsOneWidget, reason: '${entry.key}: the stable code is shown');
      }
    });

    test('the refusals of the server map to the sentences of the web', () {
      IncomingProblem of(String code) => problemOf(CommandRefused(code, status: 422));
      expect(of('NOT_ASSIGNEE'), IncomingProblem.notAssignee);
      expect(of('DOCUMENT_STATE_INVALID'), IncomingProblem.wrongState);
      expect(of('RESPONSE_DOCUMENT_NOT_ISSUED'), IncomingProblem.responseNotIssued);
      expect(of('VERSION_CONFLICT'), IncomingProblem.versionConflict);
      expect(of('MFA_REQUIRED'), IncomingProblem.stepUp);
      expect(of('LICENSE_EXPIRED'), IncomingProblem.licenseExpired);
      expect(of('VALIDATION_FAILED'), IncomingProblem.validation);
      expect(of('INVALID_REQUEST'), IncomingProblem.validation);
      expect(of('FIELD_NOT_ALLOWED'), IncomingProblem.validation);
      expect(of('RESOURCE_NOT_FOUND'), IncomingProblem.notFound);
      expect(of('SCOPE_DENIED'), IncomingProblem.denied);
      expect(of('PERMISSION_DENIED'), IncomingProblem.denied);
      expect(of('ENTITLEMENT_DENIED'), IncomingProblem.denied);
      expect(of('SESSION_EXPIRED'), IncomingProblem.sessionEnded);
      expect(of('ANYTHING_ELSE'), IncomingProblem.general);
      expect(isRetryable(IncomingProblem.general), isTrue);
      expect(isRetryable(IncomingProblem.wrongState), isFalse, reason: 'a refusal about the state of the letter is not changed by trying again');
    });

    test('the resolution bounds are those of the server: 5 to 2000 characters, counted in characters not bytes', () {
      expect(checkSummary(''), SummaryProblem.required);
      expect(checkSummary('   '), SummaryProblem.required);
      expect(checkSummary('abcd'), SummaryProblem.tooShort);
      expect(checkSummary('ábcđ'), SummaryProblem.tooShort, reason: 'four characters, more than four bytes');
      expect(checkSummary('abcde'), isNull);
      expect(checkSummary('x' * 2000), isNull);
      expect(checkSummary('x' * 2001), SummaryProblem.tooLong);
    });
  });

  group('AC-ST-DOC-020-2 UI-DOC-23 BR-MOB-01 personal data and the files of letters are not kept on the device and nothing is queued', () {
    testWidgets('a read is never kept as a copy: with the connection gone the list is the offline state, not an old list', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      answerLetters(server, <Map<String, Object?>>[letter(1)]);
      final ProviderContainer container = await _open(tester, server, _list);
      expect(find.text('Công văn số 1'), findsOneWidget);
      expect((container.read(readCacheProvider) as InMemoryReadCache).length, 0, reason: 'nothing of the list was kept');

      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();
      expect(find.text('Công văn số 1'), findsNothing, reason: 'no copy of a letter is shown');
      expect(find.text('Bạn đang ngoại tuyến'), findsWidgets);
      expect(container.read(reachabilityProvider), Reachability.offline);
    });

    testWidgets('a letter opened is not kept either', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      answerLetters(server, <Map<String, Object?>>[letter(1)]);
      final ProviderContainer container = await _open(tester, server, _detail);
      expect(find.text('Công văn số 1'), findsOneWidget);
      expect((container.read(readCacheProvider) as InMemoryReadCache).length, 0);
    });

    testWidgets('offline the buttons are not offered, the reason is beside them, and nothing is sent or queued', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      answerLetters(server, <Map<String, Object?>>[letter(1), letter(2, status: 'PROCESSING')]);
      final ProviderContainer container = await _open(tester, server, _detail);
      expect(tester.widget<FilledButton>(_start()).onPressed, isNotNull, reason: 'online it is offered');

      container.read(reachabilityProvider.notifier).report(Reachability.offline);
      await tester.pumpAndSettle();
      expect(find.text('Cần kết nối mạng để xử lý. Lệnh xử lý không bao giờ được xếp hàng đợi hay gửi từ bản lưu trên máy.'), findsOneWidget);
      expect(tester.widget<FilledButton>(_start()).onPressed, isNull);
      await tester.tap(_start(), warnIfMissed: false);
      await tester.pumpAndSettle();
      expect(container.read(syncStatusProvider).pendingCommands, 0, reason: 'the offline queue holds no letter command');
      expect(server.calls.where((HttpCall call) => call.method == 'POST'), isEmpty);
    });

    test('a command whose send finds the phone offline sends nothing and queues nothing', () async {
      final ScriptedServer server = ScriptedServer();
      final MachvonApiClient client = MachvonApiClient(baseUrl: Uri.parse('https://api.test/v1'), transport: server, token: () async => 't');
      final IncomingCommands commands = IncomingCommands(client: client, isOnline: () => false);
      expect(await commands.start('in-1', 3), isA<CommandOffline>());
      expect(await commands.resolve('in-1', 3, 'Đã giải quyết xong'), isA<CommandOffline>());
      expect(server.calls, isEmpty);
    });

    testWidgets('a read-only organisation, a letter no longer waiting and a reader with nothing to do each say why there is no action', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      ScriptedServer server = ScriptedServer();
      answerLetters(server, <Map<String, Object?>>[letter(1)]);
      await _open(tester, server, _detail, session: handlerSession(mode: SessionMode.readOnly));
      expect(find.text('Tổ chức đang ở chế độ chỉ đọc nên chưa thể xử lý văn bản.'), findsOneWidget);
      expect(tester.widget<FilledButton>(_start()).onPressed, isNull);

      server = ScriptedServer();
      answerLetters(server, <Map<String, Object?>>[letter(1, status: 'RESOLVED', summary: 'Xong rồi nhé', act: actions())]);
      await _open(tester, server, _detail);
      expect(find.text('Văn bản này không còn chờ xử lý.'), findsOneWidget);

      server = ScriptedServer();
      answerLetters(server, <Map<String, Object?>>[letter(1, handler: 'someone-else', act: actions())]);
      await _open(tester, server, _detail);
      expect(find.text('Bạn không có thao tác nào trên văn bản này.'), findsOneWidget);
      expect(_start(), findsNothing, reason: 'a button the server does not offer is not drawn');
      expect(_resolve(), findsNothing);
    });

    test('the gate puts offline before everything, then the state of the letter, then the read-only mode, then what the server offers', () {
      final IncomingLetter open = parseLetter(letter(1))!;
      final IncomingLetter closed = parseLetter(letter(1, status: 'RESOLVED', act: actions()))!;
      final IncomingLetter idle = parseLetter(letter(1, act: actions()))!;
      const SessionSnapshot full = SessionSnapshot(status: SessionStatus.signedIn, tenantId: 't', userId: 'u');
      const SessionSnapshot readOnly = SessionSnapshot(status: SessionStatus.signedIn, tenantId: 't', userId: 'u', mode: SessionMode.readOnly);
      expect(gateOf(letter: open, offline: false, session: full), IncomingGate.open);
      expect(gateOf(letter: closed, offline: true, session: full), IncomingGate.offline);
      expect(gateOf(letter: closed, offline: false, session: full), IncomingGate.notHandling);
      expect(gateOf(letter: open, offline: false, session: readOnly), IncomingGate.readOnly);
      expect(gateOf(letter: idle, offline: false, session: full), IncomingGate.noAction);
    });
  });

  group('UI-DOC-23 the letters of a reader', () {
    test('a letter is the reader\'s when it names the reader as handler or the server offers the reader an action; the late first, then the deadline, then the newest', () {
      final List<IncomingLetter> letters = <IncomingLetter>[
        for (final Map<String, Object?> raw in <Map<String, Object?>>[
          letter(1, due: '2026-10-27'),
          letter(2, overdueDays: 1, due: '2026-10-26'),
          letter(3, overdueDays: 5, due: '2026-10-22'),
          letter(4, handler: 'other', act: actions()),
          letter(5, handler: 'other', act: actions(start: true), due: '2026-10-27', received: '2026-10-25T01:00:00Z'),
          letter(6, status: 'RESOLVED', act: actions()),
          letter(7, due: null),
          // The server counts the days late in working days: more days late with a later deadline still comes first, and a letter not late with an early deadline comes after every late one.
          letter(9, overdueDays: 6, due: '2026-10-24'),
          letter(10, due: '2026-10-01'),
        ])
          parseLetter(raw)!,
      ];
      expect(lettersToHandle(letters, kHandler).map((IncomingLetter l) => l.id), <String>['in-9', 'in-3', 'in-2', 'in-10', 'in-5', 'in-1', 'in-7']);
      final IncomingLetter named = parseLetter(letter(8, act: actions()))!;
      expect(lettersToHandle(<IncomingLetter>[named], kHandler), hasLength(1), reason: 'named as the handler, with no action offered');
      expect(lettersToHandle(<IncomingLetter>[named], 'other-member'), isEmpty, reason: 'the letter of another handler');
      expect(lettersToHandle(<IncomingLetter>[named], null), isEmpty, reason: 'no membership chosen yet, nothing is yet the reader\'s');
    });

    test('an answer without what makes a letter citable is refused as a whole, a letter with an unknown status is left out', () {
      expect(parseIncomingList(<String, Object?>{'nothing': true}), isNull);
      expect(parseLetter(<String, Object?>{'id': 'x', 'status': 'WEIRD', 'received_at': '2026-10-20T01:00:00Z', 'version': 1}), isNull);
      expect(parseLetter(<String, Object?>{'id': 'x', 'status': 'ASSIGNED', 'received_at': '2026-10-20T01:00:00Z'}), isNull, reason: 'no version, no command can be sent');
      final IncomingList list = parseIncomingList(<String, Object?>{'items': <Object?>[letter(1), 'nothing', <String, Object?>{'id': 'broken'}]})!;
      expect(list.letters, hasLength(1));
      expect(list.more, isFalse);
    });
  });
}
