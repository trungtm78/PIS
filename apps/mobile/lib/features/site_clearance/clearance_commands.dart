import 'package:machvon_api_client/machvon_api_client.dart';

import '../command_support/command_outcome.dart';
import '../read_support/attempts.dart';
import 'inventory_drafts.dart';
import 'inventory_rules.dart';

/// The answer of the household to a record that was counted, recorded by an officer other than the one who counted it.
final class AnswerRequest {
  const AnswerRequest({required this.recordId, required this.version, required this.outcome, required this.answeredOn, this.note = ''});

  final String recordId;
  final int version;
  final String outcome;
  final String answeredOn;
  final String note;
}

/// Sends the two commands of the field work. Recording takes the key from the draft, so the same draft sent again after a lost answer is
/// the same command; the answer of the household is online only (it needs the right, the version and an officer other than the one who
/// counted, all judged by the server) and is never queued. Nothing here reaches the offline queue.
class ClearanceCommands {
  ClearanceCommands({required this.client, required this.isOnline});

  final MachvonApiClient client;
  final bool Function() isOnline;
  final AttemptRegistry _answers = AttemptRegistry();

  /// Records the inventory record of a draft (`recordInventory`) under the key the draft carries.
  Future<CommandOutcome> record(InventoryDraft draft, {bool retryAfterUnknown = false}) {
    final InventoryForm form = draft.form;
    return sendCommand(
      isOnline: isOnline,
      attempts: AttemptRegistry(() => CommandAttempt(draft.attemptKey)),
      intention: draft.id,
      retryAfterUnknown: retryAfterUnknown,
      call: (CommandAttempt attempt) => client.recordInventory(
        LndRecordInventory(
          householdId: draft.householdId,
          parcelId: draft.parcelId,
          itemKind: form.itemKind!,
          description: form.description.trim(),
          quantity: normaliseQuantity(form.quantity),
          unitCode: form.unitCode.trim(),
          unitPriceVnd: form.unitPriceVnd.trim(),
          priceDecisionRef: form.priceDecisionRef.trim(),
          surveyedOn: form.surveyedOn.trim(),
        ),
        attempt: attempt,
      ),
    );
  }

  Future<CommandOutcome> answer(AnswerRequest request, {bool retryAfterUnknown = false}) {
    final String note = request.note.trim();
    return sendCommand(
      isOnline: isOnline,
      attempts: _answers,
      intention: '${request.recordId}|${request.version}|${request.outcome}|${request.answeredOn.trim()}|$note',
      retryAfterUnknown: retryAfterUnknown,
      call: (CommandAttempt attempt) => client.confirmInventory(
        LndConfirmInventory(outcome: request.outcome, householdConfirmedOn: request.answeredOn.trim(), note: note.isEmpty ? null : note),
        id: request.recordId,
        ifMatchVersion: request.version,
        attempt: attempt,
      ),
    );
  }
}

/// What a refusal of the server means to the person, for the words of the screen.
enum ClearanceProblem {
  consentRequired,
  legalBasis,
  priceDecision,
  parcelNotLinked,
  selfApproval,
  stateInvalid,
  versionConflict,
  documentNotClean,
  stepUp,
  licenseExpired,
  validation,
  notFound,
  denied,
  sessionEnded,
  general,
}

ClearanceProblem problemOf(CommandRefused refused) {
  switch (refused.code) {
    case 'CONSENT_REQUIRED':
      return ClearanceProblem.consentRequired;
    case 'LEGAL_BASIS_REQUIRED':
      return ClearanceProblem.legalBasis;
    case 'PRICE_DECISION_NOT_EFFECTIVE':
      return ClearanceProblem.priceDecision;
    case 'HOUSEHOLD_PARCEL_NOT_LINKED':
      return ClearanceProblem.parcelNotLinked;
    case 'SELF_APPROVAL_DENIED':
      return ClearanceProblem.selfApproval;
    case 'INVENTORY_STATE_INVALID':
      return ClearanceProblem.stateInvalid;
    case 'VERSION_CONFLICT':
      return ClearanceProblem.versionConflict;
    case 'DOCUMENT_NOT_CLEAN':
      return ClearanceProblem.documentNotClean;
    case 'MFA_REQUIRED':
      return ClearanceProblem.stepUp;
    case 'LICENSE_EXPIRED':
      return ClearanceProblem.licenseExpired;
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return ClearanceProblem.validation;
    case 'RESOURCE_NOT_FOUND':
      return ClearanceProblem.notFound;
    case 'SCOPE_DENIED':
    case 'PERMISSION_DENIED':
    case 'ENTITLEMENT_DENIED':
      return ClearanceProblem.denied;
    case 'SESSION_EXPIRED':
      return ClearanceProblem.sessionEnded;
    default:
      return ClearanceProblem.general;
  }
}
