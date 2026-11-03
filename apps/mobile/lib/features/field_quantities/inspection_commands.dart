import 'package:machvon_api_client/machvon_api_client.dart';

import '../command_support/command_outcome.dart';
import '../read_support/attempts.dart';
import 'inspection_models.dart';

/// What the form for an acceptance request lacks before anything is sent.
enum RequestProblem { recordRequired, recordTooLong, documentRequired, documentNotAnIdentifier }

final RegExp _uuid = RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', caseSensitive: false);

Map<String, RequestProblem> checkRequest({required String recordNo, required String documentVersionId}) {
  final Map<String, RequestProblem> problems = <String, RequestProblem>{};
  final String record = recordNo.trim();
  if (record.isEmpty) {
    problems['record'] = RequestProblem.recordRequired;
  } else if (record.runes.length > kInspectionTextMax) {
    problems['record'] = RequestProblem.recordTooLong;
  }
  final String document = documentVersionId.trim();
  if (document.isEmpty) {
    problems['document'] = RequestProblem.documentRequired;
  } else if (!_uuid.hasMatch(document)) {
    problems['document'] = RequestProblem.documentNotAnIdentifier;
  }
  return problems;
}

/// Asks for the quality acceptance of an inspection. Made online, on the inspection as the server holds it, and never queued. The
/// server refuses it while a critical non-conformance of the contract is open (`OPEN_CRITICAL_NCR`, UAT-AC361); the screen says so.
/// It owns the attempt of the intention, so a retry after a lost answer keeps the key and the request is made once.
class AcceptanceRequests {
  AcceptanceRequests({required this.client, required this.isOnline});

  final MachvonApiClient client;
  final bool Function() isOnline;
  final AttemptRegistry _attempts = AttemptRegistry();

  Future<CommandOutcome> request(Inspection inspection, {required String recordNo, required String documentVersionId, bool retryAfterUnknown = false}) => sendCommand(
        isOnline: isOnline,
        attempts: _attempts,
        intention: '${inspection.id}|${recordNo.trim()}|${documentVersionId.trim().toLowerCase()}',
        retryAfterUnknown: retryAfterUnknown,
        call: (CommandAttempt attempt) => client.createQualityAcceptance(
          QmsCreateQualityAcceptance(acceptanceScope: inspection.acceptanceScope, recordNo: recordNo.trim(), documentVersionId: documentVersionId.trim().toLowerCase()),
          id: inspection.id,
          attempt: attempt,
        ),
      );
}

/// What a refusal of the server means to the person, for the words of the screen.
enum InspectionRefusal {
  openCriticalNcr,
  notPassed,
  contractState,
  acceptanceState,
  inspectionState,
  checklistIncomplete,
  versionConflict,
  stepUp,
  validation,
  notFound,
  denied,
  sessionEnded,
  general,
}

InspectionRefusal inspectionRefusalOf(String code) {
  switch (code) {
    case 'OPEN_CRITICAL_NCR':
      return InspectionRefusal.openCriticalNcr;
    case 'INSPECTION_NOT_PASSED':
      return InspectionRefusal.notPassed;
    case 'CONTRACT_STATE_INVALID':
      return InspectionRefusal.contractState;
    case 'QUALITY_ACCEPTANCE_STATE_INVALID':
      return InspectionRefusal.acceptanceState;
    case 'INSPECTION_STATE_INVALID':
      return InspectionRefusal.inspectionState;
    case 'CHECKLIST_INCOMPLETE':
      return InspectionRefusal.checklistIncomplete;
    case 'VERSION_CONFLICT':
      return InspectionRefusal.versionConflict;
    case 'MFA_REQUIRED':
      return InspectionRefusal.stepUp;
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return InspectionRefusal.validation;
    case 'RESOURCE_NOT_FOUND':
      return InspectionRefusal.notFound;
    case 'SCOPE_DENIED':
    case 'PERMISSION_DENIED':
    case 'ENTITLEMENT_DENIED':
      return InspectionRefusal.denied;
    case 'SESSION_EXPIRED':
      return InspectionRefusal.sessionEnded;
    default:
      return InspectionRefusal.general;
  }
}
