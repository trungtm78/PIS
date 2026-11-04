import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

import '../../core/l10n/app_strings.dart';
import '../../core/session/session.dart';
import 'document_fetcher.dart';
import 'pdf_engine.dart';
import 'signing_commands.dart';
import 'signing_models.dart';
import 'signing_port.dart';

export '../read_support/offline.dart' show isOffline;

/// Counts the changes made to the documents that wait for the leader (a signature, a return, or a refusal that shows the document is not
/// as the phone assumed), so that the list, which stays mounted under the document it opened, reads again and does not go on showing
/// a document that was dealt with as awaiting the signature.
class SigningChanged extends Notifier<int> {
  @override
  int build() => 0;

  void bump() => state += 1;
}

final NotifierProvider<SigningChanged, int> signingChangedProvider = NotifierProvider<SigningChanged, int>(SigningChanged.new);

/// Why a signature cannot be started or confirmed now. The reason is always written beside the disabled button. Offline wins over
/// everything: a signature is made on the server, in a session that is online, on a document as the server just gave it, never on a
/// copy kept on the device and never from a queue.
enum SigningGate { open, offline, readOnly, notSubmitted, signed, notSigner }

SigningGate gateOf({required SigningDocument document, required bool offline, required bool fromCopy, required SessionSnapshot session}) {
  if (offline || fromCopy) return SigningGate.offline;
  if (document.isLeaderSigned) return SigningGate.signed;
  if (!document.isSubmitted) return SigningGate.notSubmitted;
  if (session.isReadOnly) return SigningGate.readOnly;
  // The named signer signs: the membership the person chose is the signer the document names.
  final String? membership = session.membershipId;
  if (membership == null || document.signerUserId != membership) return SigningGate.notSigner;
  return SigningGate.open;
}

String gateText(BuildContext context, SigningGate gate) {
  switch (gate) {
    case SigningGate.open:
      return '';
    case SigningGate.offline:
      return context.t('mob.signing.gate.offline');
    case SigningGate.readOnly:
      return context.t('mob.signing.gate.readOnly');
    case SigningGate.notSubmitted:
      return context.t('mob.signing.gate.notSubmitted');
    case SigningGate.signed:
      return context.t('mob.signing.gate.signed');
    case SigningGate.notSigner:
      return context.t('mob.signing.gate.notSigner');
  }
}

String stageLabel(BuildContext context, String stage) {
  switch (stage) {
    case finalStage:
      return context.t('mob.signing.stage.final');
    case leaderSignedStage:
      return context.t('mob.signing.stage.leaderSigned');
    case 'NUMBERED':
      return context.t('mob.signing.stage.numbered');
    case 'ORG_SEALED':
      return context.t('mob.signing.stage.sealed');
    default:
      return context.t('mob.signing.stage.other', <String, Object>{'stage': stage});
  }
}

String adapterLabel(BuildContext context, String adapter) {
  switch (adapter) {
    case 'LOCAL_AGENT':
      return context.t('mob.signing.adapter.localAgent');
    case 'MOCK':
      return context.t('mob.signing.adapter.mock');
    default:
      return context.t('mob.signing.adapter.remoteCa');
  }
}

String verdictLabel(BuildContext context, String status) {
  switch (status) {
    case 'VALID':
      return context.t('mob.signing.verdict.valid');
    case 'INVALID':
      return context.t('mob.signing.verdict.invalid');
    default:
      return context.t('mob.signing.verdict.indeterminate');
  }
}

String otpProblemText(BuildContext context, OtpProblem problem) =>
    problem == OtpProblem.required ? context.t('mob.signing.otp.required') : context.t('mob.signing.otp.tooLong');

String problemText(BuildContext context, SigningProblem problem) {
  switch (problem) {
    case SigningProblem.conflict:
      return context.t('mob.signing.problem.conflict');
    case SigningProblem.selfSign:
      return context.t('mob.signing.problem.selfSign');
    case SigningProblem.notSigner:
      return context.t('mob.signing.problem.notSigner');
    case SigningProblem.certificate:
      return context.t('mob.signing.problem.certificate');
    case SigningProblem.sessionOpen:
      return context.t('mob.signing.problem.sessionOpen');
    case SigningProblem.pending:
      return context.t('mob.signing.problem.pending');
    case SigningProblem.expired:
      return context.t('mob.signing.problem.expired');
    case SigningProblem.adapter:
      return context.t('mob.signing.problem.adapter');
    case SigningProblem.provider:
      return context.t('mob.signing.problem.provider');
    case SigningProblem.digest:
      return context.t('mob.signing.problem.digest');
    case SigningProblem.signature:
      return context.t('mob.signing.problem.signature');
    case SigningProblem.state:
      return context.t('mob.signing.problem.state');
    case SigningProblem.stepUp:
      return context.t('mob.signing.problem.stepUp');
    case SigningProblem.licenseExpired:
      return context.t('mob.signing.problem.licenseExpired');
    case SigningProblem.validation:
      return context.t('mob.signing.problem.validation');
    case SigningProblem.notFound:
      return context.t('mob.signing.problem.notFound');
    case SigningProblem.denied:
      return context.t('mob.signing.problem.denied');
    case SigningProblem.sessionEnded:
      return context.t('mob.signing.problem.sessionEnded');
    case SigningProblem.general:
      return context.t('mob.signing.problem.general');
  }
}

/// Why a file could not be shown: what the fetch or the checks found, or what the server said when asked for the address.
String viewerFailureText(BuildContext context, Object failure) {
  if (failure is DocumentFetchException) {
    switch (failure.failure) {
      case FetchFailure.refusedAddress:
        return context.t('mob.signing.viewer.refusedAddress');
      case FetchFailure.unreachable:
        return context.t('mob.signing.viewer.unreachable');
      case FetchFailure.expired:
        return context.t('mob.signing.viewer.expired');
      case FetchFailure.tooLarge:
        return context.t('mob.signing.viewer.tooLarge');
      case FetchFailure.notPdf:
        return context.t('mob.signing.viewer.notPdf');
      case FetchFailure.checksumMismatch:
        return context.t('mob.signing.viewer.checksum');
    }
  }
  if (failure is PdfOpenException) return context.t('mob.signing.viewer.unreadable');
  if (failure is ApiError) {
    switch (failure.code) {
      case 'SCAN_PENDING':
        return context.t('mob.signing.viewer.scanPending');
      case 'RESOURCE_NOT_FOUND':
        return context.t('mob.signing.problem.notFound');
      case networkErrorCode:
        return context.t('mob.signing.viewer.unreachable');
      default:
        return failure.status == 403 ? context.t('mob.signing.viewer.blocked') : context.t('mob.signing.problem.general');
    }
  }
  return context.t('mob.signing.problem.general');
}

String changeLabel(BuildContext context, PageChange change) {
  switch (change) {
    case PageChange.same:
      return context.t('mob.signing.compare.same');
    case PageChange.changed:
      return context.t('mob.signing.compare.changed');
    case PageChange.added:
      return context.t('mob.signing.compare.added');
    case PageChange.removed:
      return context.t('mob.signing.compare.removed');
  }
}

/// Why the provider's SDK did not make a signature, in the words of the screen. In every one of these nothing was sent to the server:
/// a session that was already open stays open until it lapses, and no signature is partial.
enum PortProblem { unavailable, noCertificate, identityMismatch, certificateNotActive, digestMismatch, failed }

PortProblem? portProblemOfReadiness(Readiness readiness) {
  switch (readiness) {
    case Readiness.ready:
      return null;
    case Readiness.unavailable:
      return PortProblem.unavailable;
    case Readiness.noCertificate:
      return PortProblem.noCertificate;
    case Readiness.identityMismatch:
      return PortProblem.identityMismatch;
  }
}

PortProblem portProblemOf(PortFailureKind kind) {
  switch (kind) {
    case PortFailureKind.unavailable:
      return PortProblem.unavailable;
    case PortFailureKind.certificateNotActive:
      return PortProblem.certificateNotActive;
    case PortFailureKind.identityMismatch:
      return PortProblem.identityMismatch;
    case PortFailureKind.digestMismatch:
      return PortProblem.digestMismatch;
    case PortFailureKind.failed:
      return PortProblem.failed;
  }
}

/// The provider's SDK being down, or failing in a way nobody classified, is worth another try; a certificate that is not the registered one
/// or not in force is not changed by trying again.
bool isPortRetryable(PortProblem problem) => problem == PortProblem.unavailable || problem == PortProblem.failed;

String portProblemText(BuildContext context, PortProblem problem) {
  switch (problem) {
    case PortProblem.unavailable:
      return context.t('mob.signing.port.unavailable');
    case PortProblem.noCertificate:
      return context.t('mob.signing.port.noCertificate');
    case PortProblem.identityMismatch:
      return context.t('mob.signing.port.identity');
    case PortProblem.certificateNotActive:
      return context.t('mob.signing.port.certificate');
    case PortProblem.digestMismatch:
      return context.t('mob.signing.port.digest');
    case PortProblem.failed:
      return context.t('mob.signing.port.failed');
  }
}
