import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/features/command_support/command_outcome.dart';
import 'package:machvon_mobile/features/conversations/conversation_models.dart';
import 'package:machvon_mobile/features/conversations/conversation_rules.dart';

import 'conversation_fixtures.dart';

ConversationItem _conversation({String channel = 'ZALO_OA', String status = 'InProgress'}) => parseConversation(conversationJson(idZalo, channel: channel, status: status))!;

void main() {
  group('AC-ST-MOB-026-3 UI-MOB-35 what is internal and what is external', () {
    test('only a conversation on an outside messaging channel is external; any other channel is internal', () {
      for (final String channel in <String>['EMAIL', 'SMS', 'ZALO_OA', 'ZALO_ZNS', 'WHATSAPP']) {
        expect(_conversation(channel: channel).isExternal, isTrue, reason: channel);
      }
      for (final String channel in <String>['INTERNAL', 'PUSH_FCM', 'PUSH_APNS', '']) {
        expect(_conversation(channel: channel).isExternal, isFalse, reason: channel);
      }
    });

    test('an internal conversation never offers an external send, whatever the state or the setting of the build', () {
      for (final String status in <String>['New', 'Assigned', 'InProgress', 'PendingCustomer', 'Resolved']) {
        for (final bool enabled in <bool>[true, false]) {
          expect(externalGateOf(_conversation(channel: 'INTERNAL', status: status), enabled: enabled), ExternalGate.internalConversation, reason: '$status $enabled');
        }
      }
    });

    test('an external conversation offers it only when the build enables external channels and an agent has the conversation', () {
      expect(externalGateOf(_conversation(), enabled: true), ExternalGate.open);
      expect(externalGateOf(_conversation(), enabled: false), ExternalGate.notEnabled);
      expect(externalGateOf(_conversation(status: 'Assigned'), enabled: true), ExternalGate.open);
      expect(externalGateOf(_conversation(status: 'PendingCustomer'), enabled: true), ExternalGate.open);
      expect(externalGateOf(_conversation(status: 'New'), enabled: true), ExternalGate.notWithAnAgent);
      expect(externalGateOf(_conversation(status: 'Resolved'), enabled: true), ExternalGate.notWithAnAgent);
    });

    test('a closed conversation takes nothing, internal or not', () {
      expect(externalGateOf(_conversation(status: 'Closed'), enabled: true), ExternalGate.closed);
      expect(externalGateOf(_conversation(channel: 'INTERNAL', status: 'Closed'), enabled: true), ExternalGate.closed);
    });
  });

  group('AC-ST-MOB-026-1 AC-ST-MOB-026-2 the body that is sent', () {
    test('a message to the person names the channel account and the purpose; the words are trimmed', () {
      final Map<String, Object?> body = sendBodyOf(const MessageDraft.external(text: '  Xin chào  ', purpose: 'REMINDER'), accountZalo).toJson();
      expect(body, <String, Object?>{'kind': 'EXTERNAL', 'channel_account_id': accountZalo, 'purpose': 'REMINDER', 'text': 'Xin chào'});
    });

    test('a note carries no purpose: the server refuses one', () {
      final Map<String, Object?> body = sendBodyOf(const MessageDraft.note(text: 'Ghi chú'), accountInternal).toJson();
      expect(body, <String, Object?>{'kind': 'INTERNAL_NOTE', 'channel_account_id': accountInternal, 'text': 'Ghi chú'});
    });
  });

  group('AC-ST-MOB-026-1 the text and the reasons are checked as the server checks them', () {
    test('a text of blanks, or longer than 4000 characters, cannot be sent; characters are counted, not code units', () {
      expect(textProblem(''), isTrue);
      expect(textProblem('   \n '), isTrue);
      expect(textProblem('a'), isFalse);
      expect(textProblem('a' * 4000), isFalse);
      expect(textProblem('a' * 4001), isTrue);
      expect(textProblem('😀' * 4000), isFalse, reason: 'an emoji is one character');
      expect(textProblem('😀' * 4001), isTrue);
    });

    test('the reason of a resolve or a reopen is 10 to 2000 characters, the reason of an assignment at most 500', () {
      expect(moveReasonProblem('ngắn'), isTrue);
      expect(moveReasonProblem('a' * 9), isTrue);
      expect(moveReasonProblem('  ${'a' * 9}  '), isTrue, reason: 'blanks around the reason do not count');
      expect(moveReasonProblem('a' * 10), isFalse);
      expect(moveReasonProblem('đủ mười ký tự'), isFalse);
      expect(moveReasonProblem('a' * 2000), isFalse);
      expect(moveReasonProblem('a' * 2001), isTrue);
      expect(assignReasonProblem(''), isFalse);
      expect(assignReasonProblem('a' * 500), isFalse);
      expect(assignReasonProblem('a' * 501), isTrue);
    });
  });

  group('AC-ST-MOB-026-1 AC-ST-MOB-026-2 UAT-AC183 UAT-AC195 what a refusal means', () {
    ConversationProblem problem(String code) => problemOf(CommandRefused(code, status: 422));

    test('the codes of the send are told apart', () {
      expect(problem('CONSENT_DENIED'), ConversationProblem.consent);
      expect(problem('OPT_IN_REQUIRED'), ConversationProblem.optIn);
      expect(problem('CHANNEL_WINDOW_CLOSED'), ConversationProblem.window);
      expect(problem('CHANNEL_ACCOUNT_MISMATCH'), ConversationProblem.account);
      expect(problem('CHANNEL_UNVERIFIED'), ConversationProblem.unverified);
      expect(problem('CONTENT_CLASSIFICATION_BLOCKED'), ConversationProblem.content);
      expect(problem('TEMPLATE_INVALID'), ConversationProblem.template);
      expect(problem('CONVERSATION_STATE_INVALID'), ConversationProblem.state);
      expect(problem('CONTACT_STATE_INVALID'), ConversationProblem.contact);
      expect(problem('VERSION_CONFLICT'), ConversationProblem.conflict);
      expect(problem('ASSIGNEE_NOT_ELIGIBLE'), ConversationProblem.notEligible);
      expect(problem('MFA_REQUIRED'), ConversationProblem.stepUp);
      expect(problem('LICENSE_EXPIRED'), ConversationProblem.licenseExpired);
      expect(problem('VALIDATION_FAILED'), ConversationProblem.invalid);
      expect(problem('SCOPE_DENIED'), ConversationProblem.denied);
      expect(problem('RESOURCE_NOT_FOUND'), ConversationProblem.notFound);
      expect(problem('SESSION_EXPIRED'), ConversationProblem.sessionEnded);
      expect(problem('SOMETHING_NEW'), ConversationProblem.general);
    });

    test('a refusal that says the thread on the screen is not what the server holds makes the screen read it again; the others do not', () {
      expect(refusalChangesThread(const CommandRefused('VERSION_CONFLICT', status: 409)), isTrue);
      expect(refusalChangesThread(const CommandRefused('CONVERSATION_STATE_INVALID', status: 422)), isTrue);
      expect(refusalChangesThread(const CommandRefused('RESOURCE_NOT_FOUND', status: 404)), isTrue);
      expect(refusalChangesThread(const CommandRefused('SCOPE_DENIED', status: 403)), isTrue);
      expect(refusalChangesThread(const CommandRefused('CONSENT_DENIED', status: 422)), isFalse);
      expect(refusalChangesThread(const CommandRefused('CHANNEL_WINDOW_CLOSED', status: 422)), isFalse);
    });
  });

  group('AC-ST-MOB-026-4 UI-MOB-36 the answers are read only as far as the screen can rely on them', () {
    test('a conversation without an id, a known state or a version is dropped, never shown half-filled', () {
      expect(parseConversation(<String, Object?>{'status': 'New', 'version': 1}), isNull);
      expect(parseConversation(<String, Object?>{'id': idZalo, 'status': 'Somewhere', 'version': 1}), isNull);
      expect(parseConversation(<String, Object?>{'id': idZalo, 'status': 'New'}), isNull);
      expect(parseConversation('text'), isNull);
      final ConversationList? list = parseConversationList(page(<Map<String, Object?>>[conversationJson(idZalo), <String, Object?>{'id': 'x'}], next: 'c2'));
      expect(list!.items.map((ConversationItem item) => item.id), <String>[idZalo]);
      expect(list.more, isTrue);
      expect(parseConversationList(<String, Object?>{'next_cursor': null}), isNull, reason: 'an answer without items is a contract mismatch');
    });

    test('a message row never carries the text; a row of an unknown direction is dropped', () {
      final ThreadMessage message = parseThreadMessage(<String, Object?>{...messageJson(idMessageIn, 'INBOUND'), 'text': 'must not be read from a list'})!;
      expect(message.direction, Direction.inbound);
      expect(parseThreadMessage(messageJson(idMessageIn, 'SIDEWAYS')), isNull);
      expect(parseThreadMessage(<String, Object?>{'direction': 'INBOUND'}), isNull);
      expect(parseMessageText(<String, Object?>{'text': 'Xin chào'}), 'Xin chào');
      expect(parseMessageText(<String, Object?>{'text': null}), isNull, reason: 'a masked message has no text');
    });

    test('a thread needs its conversation and its list of messages', () {
      expect(parseThread(<String, Object?>{'conversation': conversationJson(idZalo), 'messages': page(standardMessages())})!.messages, hasLength(3));
      expect(parseThread(<String, Object?>{'conversation': conversationJson(idZalo)}), isNull);
      expect(parseThread(<String, Object?>{'messages': page(standardMessages())}), isNull);
    });

    test('the records a conversation points to are read by kind; an unknown kind is left out', () {
      final ConversationItem item = parseConversation(conversationJson(idZalo, links: <Map<String, Object?>>[link('project', idProject), link('issue', idIssue, converted: true), link('sky', idIssue)]))!;
      expect(item.links.map((RecordLink l) => l.kind), <LinkedKind>[LinkedKind.project, LinkedKind.issue]);
      expect(item.links.last.converted, isTrue);
    });

    test('the people a conversation can be given to', () {
      final List<Assignee> people = parseAssignees(<String, Object?>{
        'items': <Object?>[
          <String, Object?>{'membership_id': idColleague, 'display_name': 'Lê Văn Cường'},
          <String, Object?>{'display_name': 'no id'},
        ],
      });
      expect(people.map((Assignee a) => a.displayName), <String>['Lê Văn Cường']);
      expect(parseAssignees(null), isEmpty);
    });

    test('every status has a wire name that reads back', () {
      for (final ConversationStatus status in ConversationStatus.values) {
        expect(parseConversation(conversationJson(idZalo, status: statusWire(status)))!.status, status);
      }
    });
  });

  group('AC-ST-MOB-026-3 which command the state of a conversation offers', () {
    test('resolve while it is with an agent or waits for the contact, reopen once resolved, assign while open', () {
      expect(mayResolve(ConversationStatus.inProgress), isTrue);
      expect(mayResolve(ConversationStatus.pendingCustomer), isTrue);
      expect(mayResolve(ConversationStatus.assigned), isFalse);
      expect(mayResolve(ConversationStatus.resolved), isFalse);
      expect(mayReopen(ConversationStatus.resolved), isTrue);
      expect(mayReopen(ConversationStatus.closed), isFalse);
      expect(mayAssign(ConversationStatus.newConversation), isTrue);
      expect(mayAssign(ConversationStatus.inProgress), isTrue);
      expect(mayAssign(ConversationStatus.resolved), isFalse);
      expect(mayAssign(ConversationStatus.closed), isFalse);
    });
  });
}
