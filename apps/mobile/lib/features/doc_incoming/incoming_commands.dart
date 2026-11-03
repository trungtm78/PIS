import 'package:machvon_api_client/machvon_api_client.dart';

import '../command_support/command_outcome.dart';
import '../read_support/attempts.dart';

/// The words of a resolution, as the web checks them (DOC-13, `validateWords(summary, 5, 2000)`): the server takes 5 to 2000 characters.
const int kSummaryMin = 5;
const int kSummaryMax = 2000;

enum SummaryProblem { required, tooShort, tooLong }

/// What the resolution lacks before anything is sent; the server judges the same again.
SummaryProblem? checkSummary(String summary) {
  final String trimmed = summary.trim();
  if (trimmed.isEmpty) return SummaryProblem.required;
  if (trimmed.runes.length < kSummaryMin) return SummaryProblem.tooShort;
  if (trimmed.runes.length > kSummaryMax) return SummaryProblem.tooLong;
  return null;
}

/// Sends the two commands of a letter. Both are one request each, under the version of the letter on the screen and an idempotency key
/// that belongs to the person's intention: a retry after a lost answer reuses the key, so the server records it once. Nothing here
/// reaches the offline queue or a copy kept on the device.
class IncomingCommands {
  IncomingCommands({required this.client, required this.isOnline});

  final MachvonApiClient client;
  final bool Function() isOnline;
  final AttemptRegistry _startAttempts = AttemptRegistry();
  final AttemptRegistry _resolveAttempts = AttemptRegistry();

  Future<CommandOutcome> start(String id, int version, {bool retryAfterUnknown = false}) {
    return sendCommand(
      isOnline: isOnline,
      attempts: _startAttempts,
      intention: '$id|$version',
      retryAfterUnknown: retryAfterUnknown,
      call: (CommandAttempt attempt) => client.startIncomingDocumentProcessing(id: id, ifMatchVersion: version, attempt: attempt),
    );
  }

  Future<CommandOutcome> resolve(String id, int version, String summary, {bool retryAfterUnknown = false}) {
    final String words = summary.trim();
    return sendCommand(
      isOnline: isOnline,
      attempts: _resolveAttempts,
      intention: '$id|$version|$words',
      retryAfterUnknown: retryAfterUnknown,
      call: (CommandAttempt attempt) => client.resolveIncomingDocument(DocIncomingResolve(resolutionSummary: words), id: id, ifMatchVersion: version, attempt: attempt),
    );
  }
}

/// What a refusal of the server means to the person, for the words of the screen (the sentences of the web DOC-11 to DOC-13).
enum IncomingProblem { notAssignee, wrongState, responseNotIssued, versionConflict, stepUp, licenseExpired, validation, notFound, denied, sessionEnded, general }

IncomingProblem problemOf(CommandRefused refused) {
  switch (refused.code) {
    case 'NOT_ASSIGNEE':
      return IncomingProblem.notAssignee;
    case 'DOCUMENT_STATE_INVALID':
      return IncomingProblem.wrongState;
    case 'RESPONSE_DOCUMENT_NOT_ISSUED':
      return IncomingProblem.responseNotIssued;
    case 'VERSION_CONFLICT':
      return IncomingProblem.versionConflict;
    case 'MFA_REQUIRED':
      return IncomingProblem.stepUp;
    case 'LICENSE_EXPIRED':
      return IncomingProblem.licenseExpired;
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return IncomingProblem.validation;
    case 'RESOURCE_NOT_FOUND':
      return IncomingProblem.notFound;
    case 'SCOPE_DENIED':
    case 'PERMISSION_DENIED':
    case 'ENTITLEMENT_DENIED':
      return IncomingProblem.denied;
    case 'SESSION_EXPIRED':
      return IncomingProblem.sessionEnded;
    default:
      return IncomingProblem.general;
  }
}

/// A refusal that leaves the letter as it was and can be tried again as it is: the service did not answer.
bool isRetryable(IncomingProblem problem) => problem == IncomingProblem.general;
