import 'package:machvon_api_client/machvon_api_client.dart';

import '../command_support/command_outcome.dart';
import '../read_support/attempts.dart';

/// The words of a return: the server takes 10 to 2000 characters (`DocReason`).
const int kReasonMin = 10;
const int kReasonMax = 2000;

enum ReasonProblem { required, tooShort, tooLong }

/// What the reason lacks before anything is sent; the server judges the same again.
ReasonProblem? checkReason(String reason) {
  final String trimmed = reason.trim();
  if (trimmed.isEmpty) return ReasonProblem.required;
  if (trimmed.runes.length < kReasonMin) return ReasonProblem.tooShort;
  if (trimmed.runes.length > kReasonMax) return ReasonProblem.tooLong;
  return null;
}

/// Gives a document that waits for the leader back to its drafter with a reason (`returnOutgoingDocument`). One request under the version
/// of the document the screen showed and an idempotency key of the person's intention: a retry after a lost answer reuses both, so the
/// server records it once. It is never queued and never sent from a copy kept on the device.
class ReturnCommands {
  ReturnCommands({required this.client, required this.isOnline});

  final MachvonApiClient client;
  final bool Function() isOnline;
  final AttemptRegistry _attempts = AttemptRegistry();

  Future<CommandOutcome> giveBack(String documentId, int version, String reason, {bool retryAfterUnknown = false}) {
    final String words = reason.trim();
    return sendCommand(
      isOnline: isOnline,
      attempts: _attempts,
      intention: '$documentId|$version|$words',
      retryAfterUnknown: retryAfterUnknown,
      call: (CommandAttempt attempt) => client.returnOutgoingDocument(DocReason(reason: words), id: documentId, ifMatchVersion: version, attempt: attempt),
    );
  }
}
