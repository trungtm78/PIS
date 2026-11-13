import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/core/widgets/filter_chips.dart';
import 'package:machvon_mobile/core/widgets/nav_row.dart' show SwitchRow;
import 'package:machvon_mobile/features/conversations/conversation_models.dart' show ConversationStatus;
import 'package:machvon_mobile/features/conversations/conversation_rules.dart';
import 'package:machvon_mobile/features/conversations/conversations_feature.dart' as conversations;
import 'package:machvon_mobile/features/read_support/read_cache.dart';
import 'package:machvon_mobile/features/read_support/widgets.dart' show TappableRow;

import '../../support/harness.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'conversation_fixtures.dart';

const String _thread = '/inbox/mob-36/$idZalo';

Future<ProviderContainer> _open(
  WidgetTester tester,
  ScriptedServer server,
  String location, {
  bool external = true,
  FakeSession? session,
  Locale locale = const Locale('vi'),
}) {
  return pumpWithServer(
    tester,
    features: <MobileFeature>[conversations.feature, recordsFeature],
    server: server,
    location: location,
    session: session,
    locale: locale,
    overrides: <Override>[externalReplyEnabledProvider.overrideWithValue(external)],
  );
}

Finder _field(String label) => find.widgetWithText(TextField, label);

Future<void> _type(WidgetTester tester, String label, String text) async {
  await tester.enterText(_field(label), text);
  await tester.pump();
}

Future<void> _tapButton(WidgetTester tester, String label) async {
  final Finder button = find.widgetWithText(FilledButton, label);
  await tester.ensureVisible(button);
  await tester.tap(button);
  await tester.pumpAndSettle();
}

HttpResult _json(int status, Object? body) => FakeTransport.json(status, body);

void main() {
  group('AC-ST-MOB-026-3 UI-MOB-35 MOB-35 the conversations of the reader, said to be internal or external', () {
    testWidgets('each row says whether the conversation is with someone outside or internal, its state, who has it and until when the window lasts', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = conversationServer(
        conversations: <Map<String, Object?>>[
          conversationJson(idZalo),
          conversationJson(idInternal, contact: 'Tổ giải phóng mặt bằng', channel: 'INTERNAL', account: accountInternal, status: 'New', assignee: null, unit: null, window: null, messages: 0),
        ],
      );
      await _open(tester, server, '/inbox/mob-35');

      expect(find.text('Nguyễn Văn An'), findsOneWidget);
      expect(find.text('Bên ngoài · Zalo'), findsOneWidget);
      expect(find.text('Tổ giải phóng mặt bằng'), findsOneWidget);
      expect(find.text('Nội bộ'), findsOneWidget, reason: 'the internal conversation is labelled in the list');
      expect(find.descendant(of: find.byType(TappableRow), matching: find.text('Đang xử lý')), findsOneWidget);
      expect(find.descendant(of: find.byType(TappableRow), matching: find.text('Mới')), findsOneWidget);
      expect(find.text('Trần Thị Bình · Ban QLDA giao thông'), findsOneWidget);
      expect(find.text('Chưa giao'), findsOneWidget);
      expect(find.textContaining('Trả lời tự do đến 04/11/2026 09:00'), findsOneWidget, reason: 'the window in Vietnam time, as the server gave it');
      expect(find.text('3 tin'), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp('Nguyễn Văn An, Bên ngoài · Zalo, Đang xử lý')), findsOneWidget);
      expect(find.byType(SwitchRow), findsOneWidget, reason: 'the only switch is the filter');
    });

    testWidgets('the list asks only for what the person chose; the scope is the server\'s: the phone adds no queue of its own', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = conversationServer();
      await _open(tester, server, '/inbox/mob-35');
      final HttpCall first = server.callsTo('GET', '/resources/conversation').single;
      expect(first.url.queryParameters, <String, String>{'limit': '50'});

      await tester.tap(find.byType(SwitchRow));
      await tester.pumpAndSettle();
      expect(server.callsTo('GET', '/resources/conversation').last.url.queryParameters, <String, String>{'limit': '50', 'mine': 'true'});

      final Finder chip = find.descendant(of: find.byType(FilterChips<ConversationStatus?>), matching: find.text('Chờ người liên hệ'));
      await tester.ensureVisible(chip);
      await tester.tap(chip);
      await tester.pumpAndSettle();
      expect(server.callsTo('GET', '/resources/conversation').last.url.queryParameters, <String, String>{'limit': '50', 'mine': 'true', 'status': 'PendingCustomer'});
    });

    testWidgets('a filter that leaves nothing says so and can be cleared', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = conversationServer();
      server.on('GET', '/resources/conversation', (HttpCall call) => call.url.queryParameters.containsKey('mine') ? page(<Map<String, Object?>>[]) : page(<Map<String, Object?>>[conversationJson(idZalo)]));
      await _open(tester, server, '/inbox/mob-35');

      await tester.tap(find.byType(SwitchRow));
      await tester.pumpAndSettle();
      expect(find.text('Chưa có dữ liệu'), findsOneWidget);
      expect(find.text('Chỉ hội thoại giao cho tôi'), findsWidgets);
      await tester.tap(find.text('Xóa bộ lọc'));
      await tester.pumpAndSettle();
      expect(find.text('Nguyễn Văn An'), findsOneWidget);
    });

    testWidgets('a row opens the conversation, and back returns to the list', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = conversationServer();
      final ProviderContainer container = await _open(tester, server, '/inbox/mob-35');

      await tester.tap(find.text('Nguyễn Văn An'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/inbox/mob-36/$idZalo');
      await pressBack(tester);
      expect(currentLocation(container), '/inbox/mob-35');
    });

    testWidgets('a list longer than the pages the phone reads says there is more', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = conversationServer();
      server.on('GET', '/resources/conversation', (HttpCall call) => page(<Map<String, Object?>>[conversationJson(idZalo)], next: 'again-${call.url.queryParameters['cursor'] ?? 0}'));
      await _open(tester, server, '/inbox/mob-35');

      expect(server.callsTo('GET', '/resources/conversation'), hasLength(4));
      expect(find.textContaining('Còn hội thoại chưa hiển thị'), findsOneWidget);
    });

    testWidgets('personal data is not kept: after a good read, a lost connection shows the offline state and no name', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = conversationServer();
      final ProviderContainer container = await _open(tester, server, '/inbox/mob-35');
      expect(find.text('Nguyễn Văn An'), findsOneWidget);
      expect((container.read(readCacheProvider) as InMemoryReadCache).length, 0, reason: 'nothing of the list is written to the device');

      // A copy that is there anyway (planted under the key of the list) is not shown either.
      await container.read(readCacheProvider).write(const CacheScope(tenantId: 'tenant-a', userId: 'user-1'), 'conversations.inbox.all.false', CacheEntry(raw: page(<Map<String, Object?>>[conversationJson(idZalo)]), fetchedAt: kNow));
      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();
      expect(find.text('Bạn đang ngoại tuyến'), findsWidgets);
      expect(find.text('Nguyễn Văn An'), findsNothing, reason: 'no copy of a contact name is shown from the device');
    });

    testWidgets('the screen is read in English as well', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = conversationServer(conversations: <Map<String, Object?>>[conversationJson(idInternal, channel: 'INTERNAL', contact: 'Site team')]);
      await _open(tester, server, '/inbox/mob-35', locale: const Locale('en'));
      expect(find.text('Internal'), findsOneWidget);
      expect(find.text('Conversations'), findsWidgets);
    });

    testWidgets('every state is drawn and the contract of the screen holds', (WidgetTester tester) async {
      await expectEveryState(
        tester,
        open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/inbox/mob-35'),
        script: StateScript(
          healthy: (ScriptedServer server) => server.on('GET', '/resources/conversation', (_) => page(<Map<String, Object?>>[conversationJson(idZalo)])),
          content: find.text('Nguyễn Văn An'),
          empty: (ScriptedServer server) => server.on('GET', '/resources/conversation', (_) => page(<Map<String, Object?>>[])),
        ),
      );
      await expectScreenContract(
        tester,
        open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/inbox/mob-35'),
        healthy: (ScriptedServer server) => server.on('GET', '/resources/conversation', (_) => page(<Map<String, Object?>>[conversationJson(idZalo), conversationJson(idInternal, channel: 'INTERNAL', contact: 'Tổ giải phóng mặt bằng')])),
      );
    });
  });

  group('AC-ST-MOB-026-3 UI-MOB-35 an internal conversation is labelled and offers no external send', () {
    testWidgets('the thread says internal at the top, on the message that is a note, and in the form; there is no switch, no purpose and no send to a person', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = conversationServer(conversation: conversationJson(idInternal, contact: 'Tổ giải phóng mặt bằng', channel: 'INTERNAL', account: accountInternal, window: null));
      await _open(tester, server, '/inbox/mob-36/$idInternal');

      expect(find.text('Nội bộ'), findsOneWidget);
      expect(find.textContaining('Hội thoại nội bộ: chỉ đồng nghiệp trong hệ thống thấy'), findsOneWidget);
      expect(find.textContaining('Ghi chú nội bộ, không gửi ra ngoài'), findsWidgets);
      expect(find.text('Hội thoại nội bộ: chỉ ghi chú cho đồng nghiệp được, không gửi ra ngoài.'), findsOneWidget);
      expect(find.byType(SwitchRow), findsNothing, reason: 'nothing to switch: it is only ever a note');
      expect(find.text('Mục đích'), findsNothing);
      expect(find.textContaining('Gửi cho'), findsNothing);
      expect(find.text('Lưu ghi chú nội bộ'), findsOneWidget);
      expect(find.textContaining('Cửa sổ'), findsNothing);
    });

    testWidgets('a note in an internal conversation is sent as a note, without a purpose, and only the words that were sent are cleared', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = conversationServer(conversation: conversationJson(idInternal, channel: 'INTERNAL', account: accountInternal, window: null));
      server.on('POST', '/conversations/$idInternal/messages', (_) => accepted(status: 'RECORDED'), status: 202);
      await _open(tester, server, '/inbox/mob-36/$idInternal');

      await _type(tester, 'Nội dung', 'Đã gọi cho hộ dân');
      await _tapButton(tester, 'Lưu ghi chú nội bộ');

      final HttpCall call = server.callsTo('POST', '/conversations/$idInternal/messages').single;
      expect(jsonDecode(call.body!), <String, Object?>{'kind': 'INTERNAL_NOTE', 'channel_account_id': accountInternal, 'text': 'Đã gọi cho hộ dân'});
      expect(find.text('Đã lưu ghi chú nội bộ.'), findsOneWidget);
      expect(tester.widget<TextField>(_field('Nội dung')).controller!.text, isEmpty);
      expect(server.callsTo('GET', '/resources/conversation/$idInternal'), hasLength(2), reason: 'the thread is read again after the note');
    });

    testWidgets('an external conversation while the build does not offer external replies: said so, notes only', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      await _open(tester, conversationServer(), _thread, external: false);

      expect(find.text('Bên ngoài · Zalo'), findsWidgets);
      expect(find.textContaining('Ứng dụng chưa bật trả lời ra ngoài'), findsOneWidget);
      expect(find.byType(SwitchRow), findsNothing);
      expect(find.text('Lưu ghi chú nội bộ'), findsOneWidget);
      expect(find.textContaining('Gửi cho'), findsNothing);
    });

    testWidgets('an external conversation nobody has taken up takes notes only, and a closed one nothing', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      await _open(tester, conversationServer(conversation: conversationJson(idZalo, status: 'New', assignee: null)), _thread);
      expect(find.textContaining('chưa có người xử lý hoặc đã giải quyết'), findsOneWidget);
      expect(find.byType(SwitchRow), findsNothing);

      await _open(tester, conversationServer(conversation: conversationJson(idZalo, status: 'Closed')), _thread);
      expect(find.text('Hội thoại đã đóng: không ghi thêm gì được.'), findsOneWidget);
      expect(find.byType(TextField), findsNothing);
      expect(find.text('Lưu ghi chú nội bộ'), findsNothing);
    });
  });

  group('AC-ST-MOB-026-1 UAT-AC183 a reply to a contact without consent', () {
    testWidgets('the server returns the consent error, the screen says nothing was sent, shows the code, and keeps what was written', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = conversationServer();
      server.refuse('POST', '/conversations/$idZalo/messages', 422, 'CONSENT_DENIED');
      await _open(tester, server, _thread);

      await _type(tester, 'Nội dung', 'Tiền bồi thường sẽ được chuyển trong tuần này');
      await _tapButton(tester, 'Gửi cho Nguyễn Văn An qua Zalo');

      expect(find.textContaining('đã rút đồng ý hoặc chưa đồng ý nhận tin này nên không gửi được'), findsOneWidget);
      expect(find.textContaining('Chưa có gì được gửi'), findsOneWidget);
      expect(find.text('CONSENT_DENIED'), findsOneWidget);
      expect(find.text('Tin đã được xếp hàng để gửi.'), findsNothing);
      expect(tester.widget<TextField>(_field('Nội dung')).controller!.text, 'Tiền bồi thường sẽ được chuyển trong tuần này', reason: 'a refusal never makes the person write it again');
      expect(server.callsTo('POST', '/conversations/$idZalo/messages'), hasLength(1));
      expect(server.callsTo('GET', '/resources/conversation/$idZalo'), hasLength(1), reason: 'a consent refusal says nothing about the thread, so it is not read again');
    });

    testWidgets('a WhatsApp contact who has not opted in is told so, with the code', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = conversationServer(conversation: conversationJson(idWhatsapp, channel: 'WHATSAPP', account: accountWhatsapp));
      server.refuse('POST', '/conversations/$idWhatsapp/messages', 422, 'OPT_IN_REQUIRED');
      await _open(tester, server, '/inbox/mob-36/$idWhatsapp');

      await _type(tester, 'Nội dung', 'Xin chào');
      await _tapButton(tester, 'Gửi cho Nguyễn Văn An qua WhatsApp');

      expect(find.textContaining('chưa đồng ý nhận tin chủ động (opt-in)'), findsOneWidget);
      expect(find.text('OPT_IN_REQUIRED'), findsOneWidget);
    });

    testWidgets('a message to a person goes with the purpose chosen, under the version of the conversation, and is cleared when the server queued it', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = conversationServer();
      server.on('POST', '/conversations/$idZalo/messages', (_) => accepted(), status: 202);
      await _open(tester, server, _thread);

      expect(find.text('Trả lời người liên hệ'), findsOneWidget);
      expect(find.textContaining('Tin này sẽ được gửi cho Nguyễn Văn An qua Zalo'), findsOneWidget);
      await tester.tap(find.byType(DropdownButtonFormField<String>));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Nhắc việc').last);
      await tester.pumpAndSettle();
      await _type(tester, 'Nội dung', 'Nhắc: hẹn gặp chiều mai');
      await _tapButton(tester, 'Gửi cho Nguyễn Văn An qua Zalo');

      final HttpCall call = server.callsTo('POST', '/conversations/$idZalo/messages').single;
      expect(jsonDecode(call.body!), <String, Object?>{'kind': 'EXTERNAL', 'channel_account_id': accountZalo, 'purpose': 'REMINDER', 'text': 'Nhắc: hẹn gặp chiều mai'});
      expect(call.headers['if-match'], '"7"');
      expect(find.text('Tin đã được xếp hàng để gửi.'), findsOneWidget);
      expect(tester.widget<TextField>(_field('Nội dung')).controller!.text, isEmpty);
    });

    testWidgets('the switch turns the form into a note: other colour words, no purpose, and the body is a note', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = conversationServer();
      server.on('POST', '/conversations/$idZalo/messages', (_) => accepted(status: 'RECORDED'), status: 202);
      await _open(tester, server, _thread);

      await tester.tap(find.byType(SwitchRow));
      await tester.pumpAndSettle();
      expect(find.text('Mục đích'), findsNothing);
      expect(find.textContaining('không bao giờ được gửi cho người liên hệ'), findsOneWidget);
      await _type(tester, 'Nội dung', 'Cần hỏi lại phòng pháp chế');
      await _tapButton(tester, 'Lưu ghi chú nội bộ');

      expect(jsonDecode(server.callsTo('POST', '/conversations/$idZalo/messages').single.body!), <String, Object?>{'kind': 'INTERNAL_NOTE', 'channel_account_id': accountZalo, 'text': 'Cần hỏi lại phòng pháp chế'});
    });

    testWidgets('empty words are not sent: the form says what is missing and sends nothing', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = conversationServer();
      await _open(tester, server, _thread);

      await _type(tester, 'Nội dung', '   ');
      await _tapButton(tester, 'Gửi cho Nguyễn Văn An qua Zalo');

      expect(find.text('Hãy nhập nội dung (tối đa 4000 ký tự).'), findsOneWidget);
      expect(server.callsTo('POST', '/conversations/$idZalo/messages'), isEmpty);
    });
  });

  group('AC-ST-MOB-026-2 UAT-AC195 a reply outside the channel window', () {
    testWidgets('422 CHANNEL_WINDOW_CLOSED is shown with its code; nothing was sent and the words stay', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = conversationServer(conversation: conversationJson(idZalo, window: '2026-11-02T02:00:00Z'));
      server.refuse('POST', '/conversations/$idZalo/messages', 422, 'CHANNEL_WINDOW_CLOSED');
      await _open(tester, server, _thread);

      await _type(tester, 'Nội dung', 'Trả lời muộn');
      await _tapButton(tester, 'Gửi cho Nguyễn Văn An qua Zalo');

      expect(find.textContaining('Cửa sổ trả lời đã đóng: chỉ gửi được mẫu tin đã được nhà cung cấp duyệt'), findsOneWidget);
      expect(find.text('CHANNEL_WINDOW_CLOSED'), findsOneWidget);
      expect(tester.widget<TextField>(_field('Nội dung')).controller!.text, 'Trả lời muộn');
    });

    testWidgets('the phone shows the window the server gave and does not judge it with its own clock', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      await _open(tester, conversationServer(conversation: conversationJson(idZalo, window: '2020-01-01T00:00:00Z')), _thread);

      expect(find.textContaining('Trả lời tự do đến 01/01/2020 07:00'), findsOneWidget);
      expect(find.textContaining('Máy chủ quyết định cửa sổ còn mở hay đã đóng khi bạn gửi'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Gửi cho Nguyễn Văn An qua Zalo'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Gửi cho Nguyễn Văn An qua Zalo')).onPressed, isNotNull, reason: 'a window in the past does not disable the send: the server judges');
    });

    testWidgets('a channel without a window says so', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      await _open(tester, conversationServer(conversation: conversationJson(idZalo, channel: 'EMAIL', window: null)), _thread);
      expect(find.text('Kênh này không có cửa sổ trả lời.'), findsOneWidget);
    });
  });

  group('AC-ST-MOB-026-4 UI-MOB-36 MOB-36 the thread of a conversation about a record', () {
    testWidgets('the header, the messages with where each came from and stands, the records it points to', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = conversationServer(
        conversation: conversationJson(idZalo, links: <Map<String, Object?>>[link('project', idProject), link('issue', idIssue, converted: true)]),
      );
      await _open(tester, server, _thread);

      expect(find.text('Bên ngoài · Zalo'), findsOneWidget);
      expect(find.textContaining('Hội thoại với bên ngoài qua Zalo: tin trả lời được gửi cho Nguyễn Văn An'), findsOneWidget);
      expect(find.text('Zalo · Zalo OA Ban QLDA'), findsOneWidget);
      expect(find.text('Trần Thị Bình · Ban QLDA giao thông'), findsOneWidget);
      expect(find.text('Từ người liên hệ'), findsOneWidget);
      expect(find.text('Đã gửi cho người liên hệ'), findsOneWidget);
      expect(find.text('Ghi chú nội bộ, không gửi ra ngoài'), findsOneWidget);
      expect(find.text('Đã đến nơi'), findsOneWidget);
      expect(find.byType(TappableRow), findsOneWidget, reason: 'only the project can be opened on the phone');
      expect(find.textContaining('Vướng mắc tạo từ hội thoại này: chưa mở được trên điện thoại'), findsOneWidget);
      expect(find.textContaining('Khiếu nại, tố cáo, kiến nghị'), findsOneWidget);
    });

    testWidgets('the text of a message is personal data: the list holds none, one message is read when asked, shown, and hidden again', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = conversationServer();
      await _open(tester, server, _thread);

      expect(find.text(textIn), findsNothing);
      expect(server.callsTo('GET', '/resources/channel_message/$idMessageIn'), isEmpty);
      expect(find.text('Xem nội dung'), findsNWidgets(3));

      await tester.tap(find.text('Xem nội dung').first);
      await tester.pumpAndSettle();
      expect(find.text(textIn), findsOneWidget);
      expect(find.text(textOut), findsNothing, reason: 'only the message that was asked for');
      expect(server.callsTo('GET', '/resources/channel_message/$idMessageIn'), hasLength(1));
      expect(server.callsTo('GET', '/resources/channel_message/$idMessageOut'), isEmpty);

      await tester.tap(find.text('Ẩn nội dung'));
      await tester.pumpAndSettle();
      expect(find.text(textIn), findsNothing);
    });

    testWidgets('the text is announced as loading while it is read', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = conversationServer();
      final Completer<void> answer = Completer<void>();
      server.answer('GET', '/resources/channel_message/:id', (HttpCall call) async {
        await answer.future;
        return _json(200, <String, Object?>{...standardMessages().first, 'text': textIn});
      });
      await _open(tester, server, _thread);

      await tester.tap(find.text('Xem nội dung').first);
      await tester.pump();
      expect(find.text('Đang tải nội dung…'), findsOneWidget);
      answer.complete();
      await tester.pumpAndSettle();
      expect(find.text(textIn), findsOneWidget);
    });

    testWidgets('a masked message says so, and a text that cannot be read says why with the code and can be asked for again', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = conversationServer();
      server.on('GET', '/resources/channel_message/:id', (HttpCall call) => <String, Object?>{...standardMessages().first, 'text': null});
      await _open(tester, server, _thread);
      await tester.tap(find.text('Xem nội dung').first);
      await tester.pumpAndSettle();
      expect(find.text('Nội dung được che theo mức bảo mật của tin nhắn.'), findsOneWidget);

      server.refuse('GET', '/resources/channel_message/:id', 403, 'SCOPE_DENIED');
      await tester.tap(find.text('Xem nội dung').first);
      await tester.pumpAndSettle();
      expect(find.text('Không tải được nội dung tin nhắn.'), findsOneWidget);
      expect(find.text('SCOPE_DENIED'), findsOneWidget);
      server.on('GET', '/resources/channel_message/:id', (HttpCall call) => <String, Object?>{...standardMessages().first, 'text': textIn});
      await tester.tap(find.text('Thử lại'));
      await tester.pumpAndSettle();
      expect(find.text(textIn), findsOneWidget);
    });

    testWidgets('the page of messages is followed to its end, oldest first', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = conversationServer();
      server.on('GET', '/resources/channel_message', (HttpCall call) {
        final bool second = call.url.queryParameters.containsKey('cursor');
        return page(second ? <Map<String, Object?>>[standardMessages()[2]] : standardMessages().sublist(0, 2), next: second ? null : 'p2');
      });
      await _open(tester, server, _thread);

      expect(server.callsTo('GET', '/resources/channel_message').map((HttpCall c) => c.url.queryParameters['conversation_id']), <String>[idZalo, idZalo]);
      expect(find.text('Xem nội dung'), findsNWidgets(3));
    });

    testWidgets('a conversation without a message says so', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      await _open(tester, conversationServer(messages: <Map<String, Object?>>[]), _thread);
      expect(find.text('Hội thoại chưa có tin nhắn nào.'), findsOneWidget);
    });

    testWidgets('a project the conversation points to opens on the phone; the screen it opens checks the access again', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = conversationServer(conversation: conversationJson(idZalo, links: <Map<String, Object?>>[link('project', idProject)]));
      final ProviderContainer container = await _open(tester, server, _thread);

      await tester.tap(find.byType(TappableRow));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/projects/mob-10/$idProject');
      expect(find.text('project $idProject'), findsOneWidget);
    });

    testWidgets('a conversation outside the scope of the reader is not found, and nothing of it is shown', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer()..refuse('GET', '/resources/conversation/:id', 404, 'RESOURCE_NOT_FOUND');
      server.on('GET', '/resources/channel_message', (_) => page(standardMessages()));
      await _open(tester, server, _thread);

      expect(find.text('RESOURCE_NOT_FOUND'), findsOneWidget);
      expect(find.text('Nguyễn Văn An'), findsNothing);
      expect(find.byType(TextField), findsNothing);
    });

    testWidgets('personal data is not kept: a lost connection shows the offline state and no thread', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = conversationServer();
      final ProviderContainer container = await _open(tester, server, _thread);
      expect(find.text('Nguyễn Văn An'), findsWidgets);
      expect((container.read(readCacheProvider) as InMemoryReadCache).length, 0, reason: 'nothing of the thread is written to the device');
      await container.read(readCacheProvider).write(const CacheScope(tenantId: 'tenant-a', userId: 'user-1'), 'conversations.thread.$idZalo', CacheEntry(raw: <String, Object?>{'conversation': conversationJson(idZalo), 'messages': page(standardMessages())}, fetchedAt: kNow));

      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();
      expect(find.text('Bạn đang ngoại tuyến'), findsWidgets);
      expect(find.text('Nguyễn Văn An'), findsNothing);
    });

    testWidgets('every state is drawn and the contract of the screen holds', (WidgetTester tester) async {
      void healthy(ScriptedServer server) {
        server.on('GET', '/resources/conversation/:id', (_) => conversationJson(idZalo, links: <Map<String, Object?>>[link('project', idProject)]));
        server.on('GET', '/resources/channel_message', (_) => page(standardMessages()));
      }

      await expectEveryState(
        tester,
        open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, _thread),
        script: StateScript(healthy: healthy, content: find.text('Zalo · Zalo OA Ban QLDA')),
      );
      await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, _thread), healthy: healthy);
    });
  });

  group('AC-ST-MOB-026-1 AC-ST-MOB-026-4 UI-MOB-36 sending is online, once, and judged by the server', () {
    testWidgets('offline the send is disabled with the reason beside it, and what was typed stays', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = conversationServer();
      final ProviderContainer container = await _open(tester, server, _thread);
      await _type(tester, 'Nội dung', 'Sẽ gửi khi có mạng');

      container.read(reachabilityProvider.notifier).report(Reachability.offline);
      await tester.pumpAndSettle();

      expect(find.textContaining('Không có kết nối. Tin chỉ gửi được khi có mạng'), findsWidgets);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Gửi cho Nguyễn Văn An qua Zalo')).onPressed, isNull);
      expect(tester.widget<TextField>(_field('Nội dung')).controller!.text, 'Sẽ gửi khi có mạng');
      expect(server.callsTo('POST', '/conversations/$idZalo/messages'), isEmpty);
    });

    testWidgets('a tenant in read-only mode cannot send, and says why', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final FakeSession session = FakeSession(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1', mode: SessionMode.readOnly));
      await _open(tester, conversationServer(), _thread, session: session);

      expect(find.text('Tổ chức đang ở chế độ chỉ đọc nên chưa gửi được.'), findsWidgets);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Gửi cho Nguyễn Văn An qua Zalo')).onPressed, isNull);
    });

    testWidgets('a lost answer is "not known", and "send again" repeats the same request: the same key and version, so the message goes once', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = conversationServer();
      int attempt = 0;
      server.answer('POST', '/conversations/$idZalo/messages', (HttpCall call) {
        attempt += 1;
        if (attempt == 1) throw const SocketException('lost');
        return _json(202, accepted());
      });
      await _open(tester, server, _thread);

      await _type(tester, 'Nội dung', 'Xin chào');
      await _tapButton(tester, 'Gửi cho Nguyễn Văn An qua Zalo');
      expect(find.text('Chưa xác định kết quả'), findsOneWidget);
      expect(find.textContaining('Gửi lại sẽ không tạo thêm một tin thứ hai'), findsOneWidget);
      expect(tester.widget<TextField>(_field('Nội dung')).controller!.text, 'Xin chào');

      await tester.tap(find.widgetWithText(OutlinedButton, 'Gửi lại'));
      await tester.pumpAndSettle();

      final List<HttpCall> calls = server.callsTo('POST', '/conversations/$idZalo/messages');
      expect(calls, hasLength(2));
      expect(calls[1].headers['idempotency-key'], calls[0].headers['idempotency-key']);
      expect(calls[1].headers['if-match'], calls[0].headers['if-match']);
      expect(find.text('Tin đã được xếp hàng để gửi.'), findsOneWidget);
      expect(tester.widget<TextField>(_field('Nội dung')).controller!.text, isEmpty);
    });

    testWidgets('while a message is on its way the form is read-only and cannot send a second one; the message goes once', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = conversationServer();
      final Completer<void> answer = Completer<void>();
      server.answer('POST', '/conversations/$idZalo/messages', (HttpCall call) async {
        await answer.future;
        return _json(202, accepted());
      });
      await _open(tester, server, _thread);

      await _type(tester, 'Nội dung', 'Xin chào');
      final Finder send = find.widgetWithText(FilledButton, 'Gửi cho Nguyễn Văn An qua Zalo');
      await tester.ensureVisible(send);
      await tester.tap(send);
      await tester.pump();
      expect(find.text('Đang gửi…'), findsOneWidget);
      expect(tester.widget<TextField>(_field('Nội dung')).readOnly, isTrue);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Đang gửi…')).onPressed, isNull);

      answer.complete();
      await tester.pumpAndSettle();
      expect(server.callsTo('POST', '/conversations/$idZalo/messages'), hasLength(1));
      expect(find.text('Tin đã được xếp hàng để gửi.'), findsOneWidget);
    });

    testWidgets('what was written after a lost answer stays when the first words are sent again: only the words that were sent are cleared', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = conversationServer();
      int attempt = 0;
      server.answer('POST', '/conversations/$idZalo/messages', (HttpCall call) {
        attempt += 1;
        if (attempt == 1) throw const SocketException('lost');
        return _json(202, accepted());
      });
      await _open(tester, server, _thread);

      await _type(tester, 'Nội dung', 'Xin chào');
      await _tapButton(tester, 'Gửi cho Nguyễn Văn An qua Zalo');
      expect(find.text('Chưa xác định kết quả'), findsOneWidget);
      await _type(tester, 'Nội dung', 'Câu khác, viết sau đó');
      await tester.tap(find.widgetWithText(OutlinedButton, 'Gửi lại'));
      await tester.pumpAndSettle();

      expect((jsonDecode(server.callsTo('POST', '/conversations/$idZalo/messages').last.body!) as Map<String, Object?>)['text'], 'Xin chào', reason: 'the same request, not the new words');
      expect(tester.widget<TextField>(_field('Nội dung')).controller!.text, 'Câu khác, viết sau đó');
    });

    testWidgets('someone else moved the conversation: the conflict is told, the thread is read again and the words stay', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = conversationServer();
      server.refuse('POST', '/conversations/$idZalo/messages', 409, 'VERSION_CONFLICT');
      await _open(tester, server, _thread);

      await _type(tester, 'Nội dung', 'Xin chào');
      await _tapButton(tester, 'Gửi cho Nguyễn Văn An qua Zalo');

      expect(find.textContaining('Hội thoại vừa được người khác thay đổi'), findsOneWidget);
      expect(find.text('VERSION_CONFLICT'), findsOneWidget);
      expect(server.callsTo('GET', '/resources/conversation/$idZalo'), hasLength(2));
      expect(tester.widget<TextField>(_field('Nội dung')).controller!.text, 'Xin chào');
    });
  });

  group('AC-ST-MOB-026-4 UI-MOB-36 resolve, reopen and assign', () {
    testWidgets('resolving needs a reason of 10 characters; it goes under the version and the screen reads the conversation again', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = conversationServer();
      server.on('POST', '/conversations/$idZalo/resolve', (_) => accepted(status: 'RESOLVED'), status: 202);
      await _open(tester, server, _thread);

      await tester.tap(find.widgetWithText(OutlinedButton, 'Đánh dấu đã giải quyết'));
      await tester.pumpAndSettle();
      await _type(tester, 'Lý do (10 đến 2000 ký tự)', 'ngắn');
      await _tapButton(tester, 'Xác nhận: Đánh dấu đã giải quyết');
      expect(find.text('Lý do phải từ 10 đến 2000 ký tự.'), findsOneWidget);
      expect(server.callsTo('POST', '/conversations/$idZalo/resolve'), isEmpty);

      await _type(tester, 'Lý do (10 đến 2000 ký tự)', 'Đã trả lời đầy đủ');
      await _tapButton(tester, 'Xác nhận: Đánh dấu đã giải quyết');

      final HttpCall call = server.callsTo('POST', '/conversations/$idZalo/resolve').single;
      expect(jsonDecode(call.body!), <String, Object?>{'reason': 'Đã trả lời đầy đủ'});
      expect(call.headers['if-match'], '"7"');
      expect(find.text('Đã giải quyết hội thoại.'), findsOneWidget);
      expect(server.callsTo('GET', '/resources/conversation/$idZalo'), hasLength(2));
    });

    testWidgets('a resolved conversation offers reopening instead, and takes notes only', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = conversationServer(conversation: conversationJson(idResolved, status: 'Resolved'));
      server.on('POST', '/conversations/$idResolved/reopen', (_) => accepted(status: 'INPROGRESS'), status: 202);
      await _open(tester, server, '/inbox/mob-36/$idResolved');

      expect(find.widgetWithText(OutlinedButton, 'Đánh dấu đã giải quyết'), findsNothing);
      expect(find.byType(SwitchRow), findsNothing);
      await tester.tap(find.widgetWithText(OutlinedButton, 'Mở lại hội thoại'));
      await tester.pumpAndSettle();
      await _type(tester, 'Lý do (10 đến 2000 ký tự)', 'Người dân hỏi thêm');
      await _tapButton(tester, 'Xác nhận: Mở lại hội thoại');

      expect(server.callsTo('POST', '/conversations/$idResolved/reopen'), hasLength(1));
      expect(find.text('Đã mở lại hội thoại.'), findsOneWidget);
    });

    testWidgets('assigning reads the people who may take the queue, needs a choice, and goes with the version', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = conversationServer();
      server.on('GET', '/conversations/$idZalo/assignees', (_) => <String, Object?>{'items': <Object?>[<String, Object?>{'membership_id': idColleague, 'display_name': 'Lê Văn Cường'}]});
      server.on('POST', '/conversations/$idZalo/assign', (_) => accepted(status: 'ASSIGNED'), status: 202);
      await _open(tester, server, _thread);

      await tester.tap(find.widgetWithText(OutlinedButton, 'Giao cho người khác'));
      await tester.pumpAndSettle();
      await _tapButton(tester, 'Xác nhận giao');
      expect(find.text('Hãy chọn người nhận.'), findsOneWidget);
      expect(server.callsTo('POST', '/conversations/$idZalo/assign'), isEmpty);

      await tester.tap(find.byType(DropdownButtonFormField<String>).last);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Lê Văn Cường').last);
      await tester.pumpAndSettle();
      await _tapButton(tester, 'Xác nhận giao');

      final HttpCall call = server.callsTo('POST', '/conversations/$idZalo/assign').single;
      expect(jsonDecode(call.body!), <String, Object?>{'assignee_membership_id': idColleague});
      expect(call.headers['if-match'], '"7"');
      expect(find.text('Đã giao hội thoại.'), findsOneWidget);
    });

    testWidgets('a person who may not assign is told by the server\'s refusal, and nothing can be chosen', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = conversationServer();
      server.refuse('GET', '/conversations/$idZalo/assignees', 403, 'SCOPE_DENIED');
      await _open(tester, server, _thread);

      await tester.tap(find.widgetWithText(OutlinedButton, 'Giao cho người khác'));
      await tester.pumpAndSettle();
      expect(find.text('Bạn không có quyền thực hiện thao tác này trên hội thoại.'), findsOneWidget);
      expect(find.text('Xác nhận giao'), findsNothing);
    });

    testWidgets('nobody to give it to is said, and an assignment the server refuses is told', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = conversationServer();
      server.on('GET', '/conversations/$idZalo/assignees', (_) => <String, Object?>{'items': <Object?>[]});
      await _open(tester, server, _thread);
      await tester.tap(find.widgetWithText(OutlinedButton, 'Giao cho người khác'));
      await tester.pumpAndSettle();
      expect(find.text('Chưa có ai được trả lời trong hàng đợi này.'), findsOneWidget);

      server.on('GET', '/conversations/$idZalo/assignees', (_) => <String, Object?>{'items': <Object?>[<String, Object?>{'membership_id': idColleague, 'display_name': 'Lê Văn Cường'}]});
      server.refuse('POST', '/conversations/$idZalo/assign', 422, 'ASSIGNEE_NOT_ELIGIBLE');
      await tester.tap(find.text('Hủy'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(OutlinedButton, 'Giao cho người khác'));
      await tester.pumpAndSettle();
      await tester.tap(find.byType(DropdownButtonFormField<String>).last);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Lê Văn Cường').last);
      await tester.pumpAndSettle();
      await _tapButton(tester, 'Xác nhận giao');
      expect(find.text('Người này không được trả lời trong hàng đợi của hội thoại.'), findsOneWidget);
      expect(find.text('ASSIGNEE_NOT_ELIGIBLE'), findsOneWidget);
    });

    testWidgets('the commands are not offered on a conversation that is resolved for assigning, nor on a closed one', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      await _open(tester, conversationServer(conversation: conversationJson(idClosed, status: 'Closed')), '/inbox/mob-36/$idClosed');
      expect(find.widgetWithText(OutlinedButton, 'Giao cho người khác'), findsNothing);
      expect(find.widgetWithText(OutlinedButton, 'Mở lại hội thoại'), findsNothing);
      expect(find.widgetWithText(OutlinedButton, 'Đánh dấu đã giải quyết'), findsNothing);
    });
  });
}
