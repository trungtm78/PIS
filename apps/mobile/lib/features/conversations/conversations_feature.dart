import '../../core/navigation/feature.dart';
import 'conversation_strings.dart';
import 'screens/conversation_inbox_screen.dart';
import 'screens/conversation_thread_screen.dart';

/// ST-MOB-026: conversations tied to records. MOB-35 the inbox of the conversations the reader may see, MOB-36 one conversation with
/// its messages, the records it points to, and the answer, the internal note, resolve, reopen and assign. The conversations are
/// personal data and are never kept on the device; every command is online and judged by the server. Replying to a person outside
/// the system is offered only when the build enables external channels (see `externalReplyEnabledProvider`).
const MobileFeature feature = MobileFeature(
  id: 'conversations',
  strings: conversationStrings,
  screens: <ScreenSpec>[
    ScreenSpec(screenId: 'MOB-35', builder: buildConversationInboxScreen),
    ScreenSpec(screenId: 'MOB-36', pathSuffix: '/:conversationId', builder: buildConversationThreadScreen),
  ],
);
