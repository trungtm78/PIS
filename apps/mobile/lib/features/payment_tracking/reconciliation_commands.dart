import 'package:machvon_api_client/machvon_api_client.dart';

import '../command_support/command_outcome.dart';
import '../read_support/attempts.dart';

/// The longest note the server takes (as on the web PAY-06).
const int noteMax = 2000;

/// What the phone resolves: an explanation of a difference (`EXPLAINED`) or its resolution (`RESOLVED`). Writing a difference off needs a
/// document that approves it and somebody other than its owner: that stays on the web (PAY-06).
const List<String> phoneResolutions = <String>['EXPLAINED', 'RESOLVED'];

final class ResolveRequest {
  const ResolveRequest({required this.itemId, required this.version, required this.resolution, required this.note});

  final String itemId;

  /// The version the screen saw: the command is sent under it (`If-Match`).
  final int version;
  final String resolution;
  final String note;
}

enum ResolveProblem { resolutionRequired, noteRequired, noteTooLong }

/// What the form lacks: a resolution, and the note of what was found (required for both, as on the web).
Map<String, ResolveProblem> checkResolution({required String? resolution, required String note}) {
  final Map<String, ResolveProblem> problems = <String, ResolveProblem>{};
  if (resolution == null || !phoneResolutions.contains(resolution)) problems['resolution'] = ResolveProblem.resolutionRequired;
  final String words = note.trim();
  if (words.isEmpty) {
    problems['note'] = ResolveProblem.noteRequired;
  } else if (words.length > noteMax) {
    problems['note'] = ResolveProblem.noteTooLong;
  }
  return problems;
}

/// Explains or resolves a difference. It changes no figure: the two amounts and their difference stay as the Treasury and the accounts
/// recorded them. It is online only, under the version of the item on the screen, and never queued or sent from a copy.
class ReconciliationCommands {
  ReconciliationCommands({required this.client, required this.isOnline});

  final MachvonApiClient client;
  final bool Function() isOnline;
  final AttemptRegistry _attempts = AttemptRegistry();

  Future<CommandOutcome> resolve(ResolveRequest request, {bool retryAfterUnknown = false}) {
    final String note = request.note.trim();
    return sendCommand(
      isOnline: isOnline,
      attempts: _attempts,
      intention: '${request.itemId}|${request.version}|${request.resolution}|$note',
      retryAfterUnknown: retryAfterUnknown,
      call: (CommandAttempt attempt) => client.resolveReconciliationItem(
        PayResolveReconciliationItem(resolution: request.resolution, note: note),
        id: request.itemId,
        ifMatchVersion: request.version,
        attempt: attempt,
      ),
    );
  }
}

/// What a refusal means to the person, for the words of the screen.
enum ReconciliationProblem { itemState, approvalRequired, selfApproval, versionConflict, stepUp, licenseExpired, validation, notFound, denied, sessionEnded, general }

ReconciliationProblem problemOf(CommandRefused refused) {
  switch (refused.code) {
    case 'RECONCILIATION_STATE_INVALID':
      return ReconciliationProblem.itemState;
    case 'APPROVAL_REQUIRED':
      return ReconciliationProblem.approvalRequired;
    case 'SELF_APPROVAL_DENIED':
      return ReconciliationProblem.selfApproval;
    case 'VERSION_CONFLICT':
      return ReconciliationProblem.versionConflict;
    case 'MFA_REQUIRED':
      return ReconciliationProblem.stepUp;
    case 'LICENSE_EXPIRED':
      return ReconciliationProblem.licenseExpired;
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return ReconciliationProblem.validation;
    case 'RESOURCE_NOT_FOUND':
      return ReconciliationProblem.notFound;
    case 'SCOPE_DENIED':
    case 'PERMISSION_DENIED':
    case 'ENTITLEMENT_DENIED':
      return ReconciliationProblem.denied;
    case 'SESSION_EXPIRED':
      return ReconciliationProblem.sessionEnded;
    default:
      return ReconciliationProblem.general;
  }
}
