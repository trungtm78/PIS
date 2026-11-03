import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Counts the changes made to conversations on this device (a message, a note, a resolve, a reopen, an assignment), so that the
/// inbox, which stays mounted under the thread, reads again when the person comes back.
class ConversationsChanged extends Notifier<int> {
  @override
  int build() => 0;

  void bump() => state += 1;
}

final NotifierProvider<ConversationsChanged, int> conversationsChangedProvider = NotifierProvider<ConversationsChanged, int>(ConversationsChanged.new);
