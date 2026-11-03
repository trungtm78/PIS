import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/features/command_support/command_outcome.dart';
import 'package:machvon_mobile/features/conversations/conversation_commands.dart';
import 'package:machvon_mobile/features/conversations/conversation_rules.dart';

import '../support/scripted_server.dart';
import 'conversation_fixtures.dart';

MachvonApiClient _client(ScriptedServer server) => MachvonApiClient(baseUrl: Uri.parse('https://api.test/v1'), transport: server, token: () async => 'token');

SendRequest _send({int version = 7, String text = 'Xin chào', bool note = false}) => SendRequest(
      conversationId: idZalo,
      version: version,
      channelAccountId: accountZalo,
      draft: note ? MessageDraft.note(text: text) : MessageDraft.external(text: text, purpose: defaultPurpose),
    );

String _path(String suffix) => '/conversations/$idZalo/$suffix';

void main() {
  group('AC-ST-MOB-026-1 UAT-AC183 an external message without consent', () {
    test('the server refuses with the consent error: the command is refused whole and its key is let go, so the same words sent again are a new decision', () async {
      final ScriptedServer server = ScriptedServer()..refuse('POST', _path('messages'), 422, 'CONSENT_DENIED');
      final ConversationCommands commands = ConversationCommands(client: _client(server), isOnline: () => true);

      final CommandOutcome first = await commands.send(_send());
      expect(first, isA<CommandRefused>().having((CommandRefused r) => r.code, 'code', 'CONSENT_DENIED').having((CommandRefused r) => r.isFinal, 'final', isTrue));
      expect(server.callsTo('POST', _path('messages')), hasLength(1), reason: 'one request, nothing queued behind it');

      await commands.send(_send());
      final List<HttpCall> calls = server.callsTo('POST', _path('messages'));
      expect(calls[1].headers['idempotency-key'], isNot(calls[0].headers['idempotency-key']), reason: 'a final refusal ends the intention');
    });
  });

  group('AC-ST-MOB-026-1 AC-ST-MOB-026-2 a message goes once', () {
    test('the request carries the version the screen saw, a key, and the body of the draft', () async {
      final ScriptedServer server = ScriptedServer()..on('POST', _path('messages'), (_) => accepted(), status: 202);
      final CommandOutcome outcome = await ConversationCommands(client: _client(server), isOnline: () => true).send(_send());

      expect(outcome, isA<CommandDone>().having((CommandDone d) => d.status, 'status', 'QUEUED').having((CommandDone d) => d.version, 'version', 8));
      final HttpCall call = server.callsTo('POST', _path('messages')).single;
      expect(call.headers['if-match'], '"7"');
      expect(call.headers['idempotency-key'], isNotEmpty);
      expect(jsonDecode(call.body!), <String, Object?>{'kind': 'EXTERNAL', 'channel_account_id': accountZalo, 'purpose': 'SUPPORT_CONVERSATION', 'text': 'Xin chào'});
    });

    test('a lost answer is retried under the key AND the version of the first request, even when the thread has moved on', () async {
      final ScriptedServer server = ScriptedServer();
      int attempt = 0;
      server.answer('POST', _path('messages'), (HttpCall call) {
        attempt += 1;
        if (attempt == 1) throw const SocketException('lost');
        return FakeTransportJson.ok(accepted());
      });
      final ConversationCommands commands = ConversationCommands(client: _client(server), isOnline: () => true);

      expect(await commands.send(_send(version: 7)), isA<CommandUnknown>());
      // The first request committed on the server: the thread was read again and its version is now 8.
      final CommandOutcome second = await commands.send(_send(version: 8), retryAfterUnknown: true);

      expect(second, isA<CommandDone>());
      final List<HttpCall> calls = server.callsTo('POST', _path('messages'));
      expect(calls[1].headers['idempotency-key'], calls[0].headers['idempotency-key']);
      expect(calls[1].headers['if-match'], calls[0].headers['if-match'], reason: 'the same request, or the server could not tell it from a new message');
      expect(calls[1].headers['if-match'], '"7"');
    });

    test('after a recorded message the next one has a new key and the version it is given', () async {
      final ScriptedServer server = ScriptedServer()..on('POST', _path('messages'), (_) => accepted(), status: 202);
      final ConversationCommands commands = ConversationCommands(client: _client(server), isOnline: () => true);

      await commands.send(_send(version: 7));
      await commands.send(_send(version: 8));

      final List<HttpCall> calls = server.callsTo('POST', _path('messages'));
      expect(calls[1].headers['idempotency-key'], isNot(calls[0].headers['idempotency-key']));
      expect(calls[1].headers['if-match'], '"8"');
    });

    test('different words are a new intention with their own key', () async {
      final ScriptedServer server = ScriptedServer();
      server.answer('POST', _path('messages'), (_) => throw const SocketException('lost'));
      final ConversationCommands commands = ConversationCommands(client: _client(server), isOnline: () => true);

      await commands.send(_send(text: 'một'));
      await commands.send(_send(text: 'hai', version: 9), retryAfterUnknown: true);

      final List<HttpCall> calls = server.callsTo('POST', _path('messages'));
      expect(calls[1].headers['idempotency-key'], isNot(calls[0].headers['idempotency-key']));
      expect(calls[1].headers['if-match'], '"9"');
    });

    test('a message and a note with the same words are two intentions', () {
      expect(_send().intention, isNot(_send(note: true).intention));
    });

    test('offline nothing is sent, and the version is not pinned to a request that never left', () async {
      final ScriptedServer server = ScriptedServer()..on('POST', _path('messages'), (_) => accepted(), status: 202);
      bool online = false;
      final ConversationCommands commands = ConversationCommands(client: _client(server), isOnline: () => online);

      expect(await commands.send(_send(version: 7)), isA<CommandOffline>());
      expect(server.calls, isEmpty);

      online = true;
      await commands.send(_send(version: 9));
      expect(server.callsTo('POST', _path('messages')).single.headers['if-match'], '"9"');
    });
  });

  group('AC-ST-MOB-026-2 UAT-AC195 the window is closed', () {
    test('the server answers 422 CHANNEL_WINDOW_CLOSED: the refusal carries the code and the stable status', () async {
      final ScriptedServer server = ScriptedServer()..refuse('POST', _path('messages'), 422, 'CHANNEL_WINDOW_CLOSED');
      final CommandOutcome outcome = await ConversationCommands(client: _client(server), isOnline: () => true).send(_send());

      expect(outcome, isA<CommandRefused>().having((CommandRefused r) => r.code, 'code', 'CHANNEL_WINDOW_CLOSED').having((CommandRefused r) => r.status, 'status', 422));
    });
  });

  group('AC-ST-MOB-026-3 the other commands of a conversation', () {
    test('a note is sent as a note without a purpose', () async {
      final ScriptedServer server = ScriptedServer()..on('POST', _path('messages'), (_) => accepted(status: 'RECORDED'), status: 202);
      await ConversationCommands(client: _client(server), isOnline: () => true).send(_send(note: true, text: 'Ghi chú'));

      expect(jsonDecode(server.callsTo('POST', _path('messages')).single.body!), <String, Object?>{'kind': 'INTERNAL_NOTE', 'channel_account_id': accountZalo, 'text': 'Ghi chú'});
    });

    test('resolve and reopen carry the trimmed reason and the version; each has its own endpoint', () async {
      final ScriptedServer server = ScriptedServer()
        ..on('POST', _path('resolve'), (_) => accepted(status: 'RESOLVED'), status: 202)
        ..on('POST', _path('reopen'), (_) => accepted(status: 'INPROGRESS'), status: 202);
      final ConversationCommands commands = ConversationCommands(client: _client(server), isOnline: () => true);

      await commands.move(const MoveRequest(conversationId: idZalo, version: 7, reopen: false, reason: '  Đã trả lời xong  '));
      await commands.move(const MoveRequest(conversationId: idZalo, version: 8, reopen: true, reason: 'Người dân hỏi thêm'));

      final HttpCall resolve = server.callsTo('POST', _path('resolve')).single;
      expect(jsonDecode(resolve.body!), <String, Object?>{'reason': 'Đã trả lời xong'});
      expect(resolve.headers['if-match'], '"7"');
      final HttpCall reopen = server.callsTo('POST', _path('reopen')).single;
      expect(jsonDecode(reopen.body!), <String, Object?>{'reason': 'Người dân hỏi thêm'});
      expect(reopen.headers['if-match'], '"8"');
    });

    test('an assignment names the colleague and leaves the reason out when there is none', () async {
      final ScriptedServer server = ScriptedServer()..on('POST', _path('assign'), (_) => accepted(status: 'ASSIGNED'), status: 202);
      final ConversationCommands commands = ConversationCommands(client: _client(server), isOnline: () => true);

      await commands.assign(const AssignRequest(conversationId: idZalo, version: 7, assigneeId: idColleague));
      await commands.assign(const AssignRequest(conversationId: idZalo, version: 8, assigneeId: idColleague, reason: ' Đi công tác '));

      final List<HttpCall> calls = server.callsTo('POST', _path('assign'));
      expect(jsonDecode(calls[0].body!), <String, Object?>{'assignee_membership_id': idColleague});
      expect(jsonDecode(calls[1].body!), <String, Object?>{'assignee_membership_id': idColleague, 'reason': 'Đi công tác'});
    });

    test('a refusal of a resolve ends its intention: the same reason sent after the cause is removed is a new command', () async {
      final ScriptedServer server = ScriptedServer()..refuse('POST', _path('resolve'), 409, 'VERSION_CONFLICT');
      final ConversationCommands commands = ConversationCommands(client: _client(server), isOnline: () => true);
      const MoveRequest request = MoveRequest(conversationId: idZalo, version: 7, reopen: false, reason: 'Đã trả lời xong');

      await commands.move(request);
      await commands.move(const MoveRequest(conversationId: idZalo, version: 9, reopen: false, reason: 'Đã trả lời xong'));

      final List<HttpCall> calls = server.callsTo('POST', _path('resolve'));
      expect(calls[1].headers['idempotency-key'], isNot(calls[0].headers['idempotency-key']));
      expect(calls[1].headers['if-match'], '"9"');
    });
  });
}

/// A 200 answer with a JSON body, for a route that decides its answer per call.
class FakeTransportJson {
  static HttpResult ok(Object? body) => HttpResult(status: 202, headers: const <String, String>{'content-type': 'application/json'}, body: jsonEncode(body));
}
