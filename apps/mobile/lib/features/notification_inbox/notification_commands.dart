import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

import '../read_support/attempts.dart';

/// How a command ended: recorded, refused with a stable code (nothing changed), or the answer was lost (the server may or may
/// not have recorded it; sending the same intention again reuses its key).
final class CommandResultView {
  const CommandResultView.ok()
      : ok = true,
        lost = false,
        code = null;

  const CommandResultView.refused(String this.code)
      : ok = false,
        lost = false;

  const CommandResultView.lost()
      : ok = false,
        lost = true,
        code = null;

  final bool ok;
  final bool lost;
  final String? code;
}

/// The commands of the notification screens: mark one read, acknowledge one, save the preferences. All of them are online-only
/// (the state of a notification is the server's), each keeps the idempotency key of its intention across a retry, and none
/// reaches the offline queue.
class NotificationCommands {
  NotificationCommands(this.client);

  final MachvonApiClient client;
  final AttemptRegistry _reads = AttemptRegistry();
  final AttemptRegistry _acknowledgements = AttemptRegistry();
  final AttemptRegistry _preferences = AttemptRegistry();

  /// Marks a notification read. [openedVia] is `IN_APP` or `PUSH`: opening a push marks it read, never acknowledged, and a push
  /// that is merely delivered marks nothing (the server never sets read on delivery).
  Future<CommandResultView> markRead(String id, {required String openedVia}) => _run(_reads, '$id|$openedVia', (CommandAttempt attempt) => client.markNotificationRead(ReadReceipt(openedVia: openedVia), notificationId: id, attempt: attempt));

  /// Acknowledges a notification that asks for it; only this act is "acknowledged" in the business sense.
  Future<CommandResultView> acknowledge(String id, String comment) => _run(
        _acknowledgements,
        '$id|$comment',
        (CommandAttempt attempt) => client.acknowledgeNotification(AckRequest(comment: comment.trim().isEmpty ? null : comment.trim()), notificationId: id, attempt: attempt),
      );

  /// Saves the whole set of preferences under the version the person saw.
  Future<CommandResultView> savePreferences(int version, Map<String, Object?> body) => _run(
        _preferences,
        '$version|${body.toString()}',
        (CommandAttempt attempt) => client.execute('updateMyNotificationPreferences', body: body, ifMatchVersion: version, attempt: attempt),
      );

  Future<CommandResultView> _run(AttemptRegistry attempts, String payload, Future<Object?> Function(CommandAttempt attempt) send) async {
    final CommandAttempt attempt = attempts.forPayload(payload);
    try {
      await send(attempt);
      attempts.done();
      return const CommandResultView.ok();
    } on ApiError catch (error) {
      attempts.ended(error);
      return error.code == networkErrorCode ? const CommandResultView.lost() : CommandResultView.refused(error.code);
    }
  }
}

/// Counts the changes made to notifications on this device, so the inbox, which stays mounted under its tab, reads again.
class NotificationsChanged extends Notifier<int> {
  @override
  int build() => 0;

  void bump() => state += 1;
}

final NotifierProvider<NotificationsChanged, int> notificationsChangedProvider = NotifierProvider<NotificationsChanged, int>(NotificationsChanged.new);
