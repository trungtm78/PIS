import 'package:machvon_api_client/machvon_api_client.dart';

import '../command_support/command_outcome.dart';
import '../read_support/attempts.dart';
import 'acceptance_models.dart';

/// The words a form may use, as the web does (QMS-05): the reason of a decision and the serial of a certificate are at most 2000
/// characters.
const int acceptanceTextMax = 2000;

/// One signature, as the person chose it.
final class SignRequest {
  const SignRequest({required this.minutesId, required this.version, required this.role, required this.method, this.certSerial = ''});

  final String minutesId;
  final int version;
  final String role;
  final String method;
  final String certSerial;
}

/// One decision on minutes that are being signed.
final class DecisionRequest {
  const DecisionRequest({required this.minutesId, required this.version, required this.approve, required this.reason});

  final String minutesId;
  final int version;
  final bool approve;
  final String reason;
}

enum FormProblem { roleRequired, serialRequired, serialTooLong, reasonRequired, reasonTooLong }

/// What a signature form lacks before anything is sent: a role, and for a digital certificate its serial. The server judges the
/// same again (`SIGNATURE_METHOD_NOT_ACCEPTED`).
Map<String, FormProblem> checkSign({required String? role, required String method, required String serial}) {
  final Map<String, FormProblem> problems = <String, FormProblem>{};
  if (role == null || !signerRoles.contains(role)) problems['role'] = FormProblem.roleRequired;
  final String trimmed = serial.trim();
  if (method == 'DIGITAL_CERT' && trimmed.isEmpty) {
    problems['serial'] = FormProblem.serialRequired;
  } else if (trimmed.length > acceptanceTextMax) {
    problems['serial'] = FormProblem.serialTooLong;
  }
  return problems;
}

/// A decision needs the reason of the person, as on the web: approving and rejecting both go on record with it.
Map<String, FormProblem> checkDecision(String reason) {
  final String trimmed = reason.trim();
  if (trimmed.isEmpty) return <String, FormProblem>{'reason': FormProblem.reasonRequired};
  if (trimmed.length > acceptanceTextMax) return <String, FormProblem>{'reason': FormProblem.reasonTooLong};
  return const <String, FormProblem>{};
}

/// Sends the commands of one set of minutes. A signature or a decision is never queued, never sent from a copy kept on the
/// device and never sent without the server checking the right, the scope, the version and the licence again: this class has no
/// way to reach the offline queue. It owns the attempts of the intentions the person is on, so the retry after a lost answer keeps
/// the key and the version of the first request.
class AcceptanceCommands {
  AcceptanceCommands({required this.client, required this.isOnline});

  final MachvonApiClient client;
  final bool Function() isOnline;
  final AttemptRegistry _signAttempts = AttemptRegistry();
  final AttemptRegistry _decisionAttempts = AttemptRegistry();

  Future<CommandOutcome> sign(SignRequest request, {bool retryAfterUnknown = false}) {
    final String serial = request.certSerial.trim();
    return sendCommand(
      isOnline: isOnline,
      attempts: _signAttempts,
      intention: '${request.minutesId}|${request.version}|${request.role}|${request.method}|$serial',
      retryAfterUnknown: retryAfterUnknown,
      // The identifier of the signature is the key of the attempt: one signature, one identifier, however often it is sent.
      call: (CommandAttempt attempt) => client.signQualityAcceptance(
        QmsSignQualityAcceptance(
          signerRole: request.role,
          signatureMethod: request.method,
          clientOperationId: attempt.key,
          certSerial: request.method == 'DIGITAL_CERT' && serial.isNotEmpty ? serial : null,
        ),
        id: request.minutesId,
        ifMatchVersion: request.version,
        attempt: attempt,
      ),
    );
  }

  Future<CommandOutcome> decide(DecisionRequest request, {bool retryAfterUnknown = false}) {
    final String reason = request.reason.trim();
    return sendCommand(
      isOnline: isOnline,
      attempts: _decisionAttempts,
      intention: '${request.minutesId}|${request.version}|${request.approve}|$reason',
      retryAfterUnknown: retryAfterUnknown,
      call: (CommandAttempt attempt) => client.decideQualityAcceptance(
        QmsDecideQualityAcceptance(decision: request.approve ? 'approve' : 'reject', reason: reason),
        id: request.minutesId,
        ifMatchVersion: request.version,
        attempt: attempt,
      ),
    );
  }
}

/// What a refusal of the server means to the person, for the words of the screen.
enum AcceptanceProblem {
  openCriticalNcr,
  contractState,
  contentChanged,
  acceptanceState,
  roleNotRequired,
  alreadySigned,
  methodNotAccepted,
  notYourRole,
  signaturesIncomplete,
  selfApproval,
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

/// A refusal in the terms of QMS-05, with the roles that have not signed when the server named them.
final class AcceptanceRefusal {
  const AcceptanceRefusal(this.problem, {this.missingRoles = const <String>[]});

  final AcceptanceProblem problem;
  final List<String> missingRoles;
}

AcceptanceRefusal refusalOf(CommandRefused refused) {
  AcceptanceRefusal one(AcceptanceProblem problem) => AcceptanceRefusal(problem);
  switch (refused.code) {
    case 'OPEN_CRITICAL_NCR':
      return one(AcceptanceProblem.openCriticalNcr);
    case 'CONTRACT_STATE_INVALID':
      return one(AcceptanceProblem.contractState);
    case 'QUALITY_ACCEPTANCE_STATE_INVALID':
      return one(refused.extensions['reason'] == 'CONTENT_CHANGED' ? AcceptanceProblem.contentChanged : AcceptanceProblem.acceptanceState);
    case 'ROLE_NOT_REQUIRED':
      return one(AcceptanceProblem.roleNotRequired);
    case 'ALREADY_SIGNED':
      return one(AcceptanceProblem.alreadySigned);
    case 'SIGNATURE_METHOD_NOT_ACCEPTED':
      return one(AcceptanceProblem.methodNotAccepted);
    case 'SIGNATURES_INCOMPLETE':
      return AcceptanceRefusal(AcceptanceProblem.signaturesIncomplete, missingRoles: _roles(refused.extensions['missing_roles']));
    case 'SELF_APPROVAL_DENIED':
      return one(AcceptanceProblem.selfApproval);
    case 'VERSION_CONFLICT':
      return one(AcceptanceProblem.versionConflict);
    case 'MFA_REQUIRED':
      return one(AcceptanceProblem.stepUp);
    case 'PERIOD_LOCKED':
      return one(AcceptanceProblem.periodLocked);
    case 'LICENSE_EXPIRED':
      return one(AcceptanceProblem.licenseExpired);
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return one(AcceptanceProblem.validation);
    case 'RESOURCE_NOT_FOUND':
      return one(AcceptanceProblem.notFound);
    case 'SCOPE_DENIED':
      // Signing as a role that is not the signer's to sign is refused as outside the scope; the other commands for lack of the right.
      return one(refused.detail == 'signer_role' ? AcceptanceProblem.notYourRole : AcceptanceProblem.denied);
    case 'PERMISSION_DENIED':
    case 'ENTITLEMENT_DENIED':
      return one(AcceptanceProblem.denied);
    case 'SESSION_EXPIRED':
      return one(AcceptanceProblem.sessionEnded);
    default:
      return one(AcceptanceProblem.general);
  }
}

List<String> _roles(Object? value) => <String>[
      if (value is List)
        for (final Object? role in value)
          if (role is String && signerRoles.contains(role)) role,
    ];
