import 'package:machvon_api_client/machvon_api_client.dart';

import '../command_support/command_outcome.dart';
import '../read_support/attempts.dart';
import 'signing_port.dart';

/// Opens the leader's signing session on a document (`startLeaderSigning`).
final class StartRequest {
  const StartRequest({required this.documentId, required this.version, required this.certificateId, required this.adapterCode});

  final String documentId;

  /// The version of the document the screen showed: the server answers 409 when the document moved on.
  final int version;
  final String? certificateId;
  final String adapterCode;
}

/// Completes a session with the proof of the signer (`completeSigningSession`).
final class CompleteRequest {
  const CompleteRequest({required this.sessionId, required this.version, required this.proof});

  final String sessionId;
  final int version;
  final SigningProof proof;
}

enum OtpProblem { required, tooLong }

/// What the one-time code lacks before anything is sent; the provider judges the code itself.
OtpProblem? checkOtp(String code) {
  final String trimmed = code.trim();
  if (trimmed.isEmpty) return OtpProblem.required;
  if (trimmed.length > otpMaxLength) return OtpProblem.tooLong;
  return null;
}

/// Sends the two commands of a leader signature. They are never queued, never sent from a copy kept on the device and never kept
/// for later: a lost answer is looked at again by the person, with the same key. The class has no way to reach the offline queue.
class SigningCommands {
  SigningCommands({required this.client, required this.isOnline});

  final MachvonApiClient client;
  final bool Function() isOnline;
  final AttemptRegistry _startAttempts = AttemptRegistry();
  final AttemptRegistry _completeAttempts = AttemptRegistry();

  Future<CommandOutcome> start(StartRequest request, {bool retryAfterUnknown = false}) {
    return sendCommand(
      isOnline: isOnline,
      attempts: _startAttempts,
      intention: '${request.documentId}|${request.version}|${request.certificateId}|${request.adapterCode}',
      retryAfterUnknown: retryAfterUnknown,
      call: (CommandAttempt attempt) => client.startLeaderSigning(
        DocSigningStart(certificateId: request.certificateId, adapterCode: request.adapterCode),
        id: request.documentId,
        ifMatchVersion: request.version,
        attempt: attempt,
      ),
    );
  }

  Future<CommandOutcome> complete(CompleteRequest request, {bool retryAfterUnknown = false}) {
    final SigningProof proof = request.proof;
    return sendCommand(
      isOnline: isOnline,
      attempts: _completeAttempts,
      intention: '${request.sessionId}|${request.version}|${proof.otpConfirmation}|${proof.cmsSignature}|${proof.clientDigestHex}',
      retryAfterUnknown: retryAfterUnknown,
      call: (CommandAttempt attempt) => client.completeSigningSession(
        DocSigningCompletion(otpConfirmation: proof.otpConfirmation, cmsSignature: proof.cmsSignature, clientDigestHex: proof.clientDigestHex),
        id: request.sessionId,
        ifMatchVersion: request.version,
        attempt: attempt,
      ),
    );
  }
}

/// What a refusal means to the person, for the words of the screen. The sentences are those of the web DOC-05 and DOC-22.
enum SigningProblem {
  conflict,
  selfSign,
  notSigner,
  certificate,
  sessionOpen,
  pending,
  expired,
  adapter,
  provider,
  digest,
  signature,
  state,
  stepUp,
  licenseExpired,
  validation,
  notFound,
  denied,
  sessionEnded,
  general,
}

/// Whether the same command may be sent again as it is: the provider could not be reached and the document stays as it was.
bool isRetryable(SigningProblem problem) => problem == SigningProblem.provider || problem == SigningProblem.adapter || problem == SigningProblem.general;

/// [completing] says which command failed: an open session means "finish that one" when starting and "the signer has not confirmed
/// yet" when completing.
SigningProblem problemOf(CommandRefused refused, {required bool completing}) {
  switch (refused.code) {
    case 'VERSION_CONFLICT':
      return SigningProblem.conflict;
    case 'SELF_APPROVAL_DENIED':
      return SigningProblem.selfSign;
    case 'SIGNER_NOT_AUTHORIZED':
      return SigningProblem.notSigner;
    case 'CERTIFICATE_NOT_ACTIVE':
      return SigningProblem.certificate;
    case 'SIGNING_SESSION_OPEN':
      return completing ? SigningProblem.pending : SigningProblem.sessionOpen;
    case 'SIGNING_SESSION_EXPIRED':
      return SigningProblem.expired;
    case 'SIGNING_ADAPTER_UNAVAILABLE':
      return SigningProblem.adapter;
    case 'PROVIDER_UNAVAILABLE':
      return SigningProblem.provider;
    case 'DIGEST_MISMATCH':
      return SigningProblem.digest;
    case 'SIGNATURE_INVALID':
      return SigningProblem.signature;
    case 'DOCUMENT_STATE_INVALID':
      return SigningProblem.state;
    case 'MFA_REQUIRED':
      return SigningProblem.stepUp;
    case 'LICENSE_EXPIRED':
      return SigningProblem.licenseExpired;
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return SigningProblem.validation;
    case 'RESOURCE_NOT_FOUND':
      return SigningProblem.notFound;
    case 'SCOPE_DENIED':
    case 'PERMISSION_DENIED':
    case 'ENTITLEMENT_DENIED':
      return SigningProblem.denied;
    case 'SESSION_EXPIRED':
      return SigningProblem.sessionEnded;
    default:
      return SigningProblem.general;
  }
}
