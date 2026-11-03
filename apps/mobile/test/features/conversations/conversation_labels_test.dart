import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/l10n/string_table.dart';
import 'package:machvon_mobile/features/conversations/conversation_labels.dart';
import 'package:machvon_mobile/features/conversations/conversation_models.dart';
import 'package:machvon_mobile/features/conversations/conversation_rules.dart';
import 'package:machvon_mobile/features/conversations/conversation_strings.dart';

import '../../support/widget_host.dart';
import 'conversation_fixtures.dart';

Future<BuildContext> _context(WidgetTester tester, Locale locale) async {
  late BuildContext captured;
  await tester.pumpWidget(hostWidget(Builder(builder: (BuildContext context) {
    captured = context;
    return const SizedBox();
  }), locale: locale, tables: <StringTable>[conversationStrings]));
  return captured;
}

void _allWords(List<String> words, {bool distinct = true}) {
  for (final String word in words) {
    expect(word, isNotEmpty);
    expect(word.startsWith('mob.'), isFalse, reason: 'a key shows where words should: $word');
  }
  if (distinct) expect(words.toSet(), hasLength(words.length), reason: 'two different cases read the same');
}

void main() {
  for (final Locale locale in const <Locale>[Locale('vi'), Locale('en')]) {
    testWidgets('AC-ST-MOB-026-3 AC-ST-MOB-026-4 UI-MOB-35 UI-MOB-36 every state, channel, direction, delivery, gate and refusal of the two screens is in words (${locale.languageCode})', (WidgetTester tester) async {
      final BuildContext context = await _context(tester, locale);
      _allWords(<String>[for (final ConversationStatus s in ConversationStatus.values) statusLabel(context, s)]);
      _allWords(<String>[for (final Direction d in Direction.values) directionLabel(context, d)]);
      _allWords(<String>[for (final Delivery d in Delivery.values) deliveryLabel(context, d)]);
      _allWords(<String>[for (final String p in purposes) purposeLabel(context, p)]);
      _allWords(<String>[for (final LinkedKind k in LinkedKind.values) linkedKindLabel(context, k)]);
      _allWords(<String>[for (final ExternalGate g in ExternalGate.values.where((ExternalGate g) => g != ExternalGate.open)) gateText(context, g)]);
      expect(gateText(context, ExternalGate.open), isEmpty, reason: 'nothing to explain when the send is offered');
      _allWords(<String>[for (final ConversationProblem p in ConversationProblem.values) problemText(context, p)]);
      _allWords(<String>[for (final String c in <String>['EMAIL', 'SMS', 'ZALO_OA', 'WHATSAPP']) channelLabel(context, c)]);
      expect(channelLabel(context, 'ZALO_ZNS'), channelLabel(context, 'ZALO_OA'), reason: 'both Zalo channels read as Zalo');
      expect(channelLabel(context, 'FAX'), 'FAX', reason: 'a channel the application does not know is shown by its code');
    });
  }

  testWidgets('AC-ST-MOB-026-3 UI-MOB-35 the kind of a conversation reads in one phrase: internal, or external with its channel', (WidgetTester tester) async {
    final BuildContext vi = await _context(tester, const Locale('vi'));
    expect(kindLabel(vi, parseConversation(conversationJson(idInternal, channel: 'INTERNAL'))!), 'Nội bộ');
    expect(kindLabel(vi, parseConversation(conversationJson(idZalo, channel: 'WHATSAPP'))!), 'Bên ngoài · WhatsApp');
    final BuildContext en = await _context(tester, const Locale('en'));
    expect(kindLabel(en, parseConversation(conversationJson(idInternal, channel: 'INTERNAL'))!), 'Internal');
    expect(kindLabel(en, parseConversation(conversationJson(idZalo, channel: 'EMAIL'))!), 'External · E-mail');
  });
}
