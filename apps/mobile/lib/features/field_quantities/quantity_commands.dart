import 'package:machvon_api_client/machvon_api_client.dart';

import '../command_support/command_outcome.dart';
import '../read_support/attempts.dart';
import 'quantity_models.dart';

/// Sends a recorded quantity for approval. Submitting is made online, on the quantity as the server holds it (the version that was
/// read), never queued and never from a copy: the maker sends, another person decides. It owns the attempt of the intention the
/// person is on, so a retry after a lost answer keeps the key and the quantity is submitted once.
class QuantityCommands {
  QuantityCommands({required this.client, required this.isOnline});

  final MachvonApiClient client;
  final bool Function() isOnline;
  final AttemptRegistry _attempts = AttemptRegistry();

  Future<CommandOutcome> submit(Measurement measurement, {bool retryAfterUnknown = false}) => sendCommand(
        isOnline: isOnline,
        attempts: _attempts,
        intention: '${measurement.id}|${measurement.version}',
        retryAfterUnknown: retryAfterUnknown,
        call: (CommandAttempt attempt) => client.submitMeasurement(const CtrSubmitMeasurement(), id: measurement.id, ifMatchVersion: measurement.version, attempt: attempt),
      );
}

/// What a refusal of the server means to the person: the codes of CTR-10 first, the rest as the other commands word them.
enum QuantityRefusal {
  exceeds,
  decrease,
  duplicateReference,
  revisionNotEffective,
  permitGate,
  inAcceptance,
  evidenceRequired,
  periodTaken,
  measurementState,
  versionConflict,
  stepUp,
  periodLocked,
  licenseExpired,
  validation,
  notFound,
  denied,
  sessionEnded,
  general,
}

/// A refusal of the server by its code; [reason] is the `reason` member some of them carry. Used for a command that was refused
/// while it waited in the queue and for a submission refused at once.
QuantityRefusal refusalOfCode(String code, {Object? reason}) {
  switch (code) {
    case 'QUANTITY_EXCEEDS_BOQ':
      return QuantityRefusal.exceeds;
    case 'CUMULATIVE_DECREASE_WITHOUT_CORRECTION':
      return QuantityRefusal.decrease;
    case 'MEASUREMENT_REFERENCE_DUPLICATE':
      return QuantityRefusal.duplicateReference;
    case 'REVISION_NOT_EFFECTIVE':
      return QuantityRefusal.revisionNotEffective;
    case 'PERMIT_GATE_BLOCKED':
      return QuantityRefusal.permitGate;
    case 'MEASUREMENT_IN_ACTIVE_ACCEPTANCE':
      return QuantityRefusal.inAcceptance;
    case 'EVIDENCE_REQUIRED':
      return QuantityRefusal.evidenceRequired;
    case 'MEASUREMENT_STATE_INVALID':
      return reason == 'PERIOD_ALREADY_MEASURED' ? QuantityRefusal.periodTaken : QuantityRefusal.measurementState;
    case 'VERSION_CONFLICT':
      return QuantityRefusal.versionConflict;
    case 'MFA_REQUIRED':
      return QuantityRefusal.stepUp;
    case 'PERIOD_LOCKED':
      return QuantityRefusal.periodLocked;
    case 'LICENSE_EXPIRED':
      return QuantityRefusal.licenseExpired;
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return QuantityRefusal.validation;
    case 'RESOURCE_NOT_FOUND':
      return QuantityRefusal.notFound;
    case 'SCOPE_DENIED':
    case 'PERMISSION_DENIED':
    case 'ENTITLEMENT_DENIED':
      return QuantityRefusal.denied;
    case 'SESSION_EXPIRED':
      return QuantityRefusal.sessionEnded;
    default:
      return QuantityRefusal.general;
  }
}
