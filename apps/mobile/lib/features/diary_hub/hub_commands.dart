import 'package:machvon_api_client/machvon_api_client.dart';

import '../command_support/command_outcome.dart';
import '../read_support/attempts.dart';

/// How a copy that a device left is settled on the phone. A merge of the two contents is made on the web (QMS-03); the phone keeps the
/// diary as it is, or takes the copy over the draft, and nothing is overwritten without the person choosing.
enum Resolution {
  keepPrimary('KEEP_PRIMARY'),
  adoptCopy('ADOPT_CONFLICT');

  const Resolution(this.code);

  final String code;
}

/// The words of the reason, as the web checks them: required, at most 2000 characters (`QmsResolveDiaryConflict.note`).
const int kNoteMax = 2000;

enum ResolveProblem { noCopy, noResolution, adoptSigned, noteRequired, noteTooLong }

/// What the settling lacks before anything is sent; the server judges the same again. A signed diary can only be kept as it is.
Map<String, ResolveProblem> checkResolution({required String? copyId, required Iterable<String> copies, required Resolution? resolution, required String note, required bool draft}) {
  final Map<String, ResolveProblem> problems = <String, ResolveProblem>{};
  if (copyId == null || !copies.contains(copyId)) problems['copy'] = ResolveProblem.noCopy;
  if (resolution == null) {
    problems['resolution'] = ResolveProblem.noResolution;
  } else if (resolution == Resolution.adoptCopy && !draft) {
    problems['resolution'] = ResolveProblem.adoptSigned;
  }
  final String trimmed = note.trim();
  if (trimmed.isEmpty) {
    problems['note'] = ResolveProblem.noteRequired;
  } else if (trimmed.runes.length > kNoteMax) {
    problems['note'] = ResolveProblem.noteTooLong;
  }
  return problems;
}

/// Settles one copy of a diary (`resolveDiaryConflict`): one request under the version of the diary the screen showed and an idempotency
/// key of the person's intention, so a retry after a lost answer reuses both and the server records it once. Never queued, never sent
/// from a copy kept on the device.
class ResolveCommands {
  ResolveCommands({required this.client, required this.isOnline});

  final MachvonApiClient client;
  final bool Function() isOnline;
  final AttemptRegistry _attempts = AttemptRegistry();

  Future<CommandOutcome> resolve({
    required String diaryId,
    required int version,
    required String copyId,
    required Resolution resolution,
    required String note,
    bool retryAfterUnknown = false,
  }) {
    final String words = note.trim();
    return sendCommand(
      isOnline: isOnline,
      attempts: _attempts,
      intention: '$diaryId|$version|$copyId|${resolution.code}|$words',
      retryAfterUnknown: retryAfterUnknown,
      call: (CommandAttempt attempt) => client.resolveDiaryConflict(
        QmsResolveDiaryConflict(conflictDiaryId: copyId, resolution: resolution.code, note: words),
        id: diaryId,
        ifMatchVersion: version,
        attempt: attempt,
      ),
    );
  }
}

/// What a refusal means to the person, for the words of the screen (the sentences of the web QMS-03).
enum HubProblem { diaryState, versionConflict, stepUp, licenseExpired, validation, notFound, denied, sessionEnded, general }

HubProblem problemOf(CommandRefused refused) {
  switch (refused.code) {
    case 'DIARY_STATE_INVALID':
      return HubProblem.diaryState;
    case 'VERSION_CONFLICT':
      return HubProblem.versionConflict;
    case 'MFA_REQUIRED':
      return HubProblem.stepUp;
    case 'LICENSE_EXPIRED':
      return HubProblem.licenseExpired;
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return HubProblem.validation;
    case 'RESOURCE_NOT_FOUND':
      return HubProblem.notFound;
    case 'SCOPE_DENIED':
    case 'PERMISSION_DENIED':
    case 'ENTITLEMENT_DENIED':
      return HubProblem.denied;
    case 'SESSION_EXPIRED':
      return HubProblem.sessionEnded;
    default:
      return HubProblem.general;
  }
}

bool isRetryable(HubProblem problem) => problem == HubProblem.general;
