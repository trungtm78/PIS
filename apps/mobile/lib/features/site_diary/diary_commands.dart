import 'package:machvon_api_client/machvon_api_client.dart';

import '../command_support/command_outcome.dart';
import '../read_support/attempts.dart';
import 'diary_models.dart';

/// The reason of a correction is written by the person and is at most 2000 characters (the web, QMS-03).
const int kCorrectionReasonMax = 2000;

/// What a signature or a correction form lacks before anything is sent.
enum CorrectionProblem { reasonRequired, reasonTooLong }

CorrectionProblem? checkCorrectionReason(String reason) {
  final String trimmed = reason.trim();
  if (trimmed.isEmpty) return CorrectionProblem.reasonRequired;
  return trimmed.runes.length > kCorrectionReasonMax
      ? CorrectionProblem.reasonTooLong
      : null;
}

/// Sends the commands of one diary that are made online and never queued: the signature of the contractor and the correction. A
/// signature kept for later would be a signature nobody asked for, and a correction needs the diary as the server holds it now. It
/// owns the attempts of the intentions the person is on, so a retry after a lost answer keeps the key of the first request and the
/// diary holds one signature and one correction however often they are sent (UAT-AC358).
class DiaryCommands {
  DiaryCommands({required this.client, required this.isOnline});

  final MachvonApiClient client;
  final bool Function() isOnline;
  final AttemptRegistry _signAttempts = AttemptRegistry();
  final AttemptRegistry _correctAttempts = AttemptRegistry();

  /// The contractor signs the diary as the server holds it ([version]); the content hash is made by the server over that content.
  Future<CommandOutcome> sign(
    DiaryRecord diary, {
    bool retryAfterUnknown = false,
  }) => sendCommand(
    isOnline: isOnline,
    attempts: _signAttempts,
    intention: '${diary.id}|${diary.version}',
    retryAfterUnknown: retryAfterUnknown,
    // The identifier of the signature is the key of the attempt: one signature, one identifier, however often it is sent.
    call: (CommandAttempt attempt) => client.signSiteDiaryByContractor(
      QmsSignSiteDiaryByContractor(
        signatureMethod: 'IN_APP_OTP',
        clientOperationId: attempt.key,
      ),
      id: diary.id,
      ifMatchVersion: diary.version,
      attempt: attempt,
    ),
  );

  /// A correction of a diary is a new revision with the reason; the diary it corrects stays as it was, content and signatures.
  Future<CommandOutcome> correct(
    DiaryRecord diary,
    DiaryForm form,
    String reason, {
    bool retryAfterUnknown = false,
  }) {
    final Map<String, Object?> content = contentOf(form, base: diary.content);
    return sendCommand(
      isOnline: isOnline,
      attempts: _correctAttempts,
      intention: '${diary.id}|${reason.trim()}|${content.toString()}',
      retryAfterUnknown: retryAfterUnknown,
      call: (CommandAttempt attempt) => client.correctSiteDiary(
        QmsCorrectSiteDiary(
          content: content,
          correctionReason: reason.trim(),
          clientOperationId: attempt.key,
        ),
        id: diary.id,
        attempt: attempt,
      ),
    );
  }
}

/// What a refusal of the server means to the person, for the words of the screen.
enum DiaryRefusal {
  diaryState,
  correctionOpen,
  contentChanged,
  dayExists,
  syncConflict,
  alreadySigned,
  methodNotAccepted,
  notYourRole,
  contractState,
  permitGate,
  versionConflict,
  stepUp,
  licenseExpired,
  validation,
  notFound,
  denied,
  sessionEnded,
  general,
}

DiaryRefusal refusalOf(CommandRefused refused) {
  switch (refused.code) {
    case 'DIARY_STATE_INVALID':
      return refused.extensions['reason'] == 'CORRECTION_OPEN'
          ? DiaryRefusal.correctionOpen
          : (refused.extensions['reason'] == 'CONTENT_CHANGED'
                ? DiaryRefusal.contentChanged
                : DiaryRefusal.diaryState);
    case 'DIARY_DAY_EXISTS':
      return DiaryRefusal.dayExists;
    case 'DIARY_SYNC_CONFLICT':
      return DiaryRefusal.syncConflict;
    case 'ALREADY_SIGNED':
      return DiaryRefusal.alreadySigned;
    case 'SIGNATURE_METHOD_NOT_ACCEPTED':
      return DiaryRefusal.methodNotAccepted;
    case 'CONTRACT_STATE_INVALID':
      return DiaryRefusal.contractState;
    case 'PERMIT_GATE_BLOCKED':
      return DiaryRefusal.permitGate;
    case 'VERSION_CONFLICT':
      return DiaryRefusal.versionConflict;
    case 'MFA_REQUIRED':
      return DiaryRefusal.stepUp;
    case 'LICENSE_EXPIRED':
      return DiaryRefusal.licenseExpired;
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return DiaryRefusal.validation;
    case 'RESOURCE_NOT_FOUND':
      return DiaryRefusal.notFound;
    case 'SCOPE_DENIED':
      // Signing as a role that is not the signer's to sign is refused as outside the scope; the other commands for lack of the right.
      return refused.detail == 'signer_role'
          ? DiaryRefusal.notYourRole
          : DiaryRefusal.denied;
    case 'PERMISSION_DENIED':
    case 'ENTITLEMENT_DENIED':
      return DiaryRefusal.denied;
    case 'SESSION_EXPIRED':
      return DiaryRefusal.sessionEnded;
    default:
      return DiaryRefusal.general;
  }
}
