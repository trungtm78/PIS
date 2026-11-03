import 'package:flutter/material.dart';

import '../../core/l10n/app_strings.dart';
import '../../core/session/session.dart';
import 'acceptance_commands.dart';
import 'acceptance_models.dart';

export '../read_support/offline.dart' show isOffline;

/// Why a signature or a decision cannot be made now. The reason is always written beside the disabled button, never left to be
/// guessed. Offline wins over everything: a signature or an approval is made on the server, in a session that is online, on minutes
/// as the server just gave them, never on a copy kept on the device and never from the queue.
enum AcceptanceGate { open, offline, readOnly, notOpen, notAllowed }

AcceptanceGate gateOf({required Minutes minutes, required bool allowed, required bool offline, required bool fromCopy, required SessionSnapshot session}) {
  if (offline || fromCopy) return AcceptanceGate.offline;
  if (!minutes.isOpen) return AcceptanceGate.notOpen;
  if (session.isReadOnly) return AcceptanceGate.readOnly;
  if (!allowed) return AcceptanceGate.notAllowed;
  return AcceptanceGate.open;
}

String gateText(BuildContext context, AcceptanceGate gate) {
  switch (gate) {
    case AcceptanceGate.open:
      return '';
    case AcceptanceGate.offline:
      return context.t('mob.acceptance.gate.offline');
    case AcceptanceGate.readOnly:
      return context.t('mob.acceptance.gate.readOnly');
    case AcceptanceGate.notOpen:
      return context.t('mob.acceptance.gate.notOpen');
    case AcceptanceGate.notAllowed:
      return context.t('mob.acceptance.gate.notAllowed');
  }
}

String roleLabel(BuildContext context, String role) {
  switch (role) {
    case 'CONTRACTOR':
      return context.t('mob.acceptance.role.contractor');
    case 'SUPERVISOR':
      return context.t('mob.acceptance.role.supervisor');
    case 'OWNER':
      return context.t('mob.acceptance.role.owner');
    default:
      return context.t('mob.acceptance.role.designer');
  }
}

String rolesLabel(BuildContext context, Iterable<String> roles) => roles.map((String role) => roleLabel(context, role)).join(', ');

String scopeLabel(BuildContext context, String scope) {
  switch (scope) {
    case 'STAGE':
      return context.t('mob.acceptance.scope.stage');
    case 'PART':
      return context.t('mob.acceptance.scope.part');
    case 'COMPLETION':
      return context.t('mob.acceptance.scope.completion');
    default:
      return context.t('mob.acceptance.scope.workItem');
  }
}

String statusLabel(BuildContext context, String status) {
  switch (status) {
    case 'DRAFT':
      return context.t('mob.acceptance.status.draft');
    case 'SIGNING':
      return context.t('mob.acceptance.status.signing');
    case 'APPROVED':
      return context.t('mob.acceptance.status.approved');
    case 'REJECTED':
      return context.t('mob.acceptance.status.rejected');
    default:
      return context.t('mob.acceptance.status.revoked');
  }
}

String methodLabel(BuildContext context, String method) {
  switch (method) {
    case 'IN_APP_WEBAUTHN':
      return context.t('mob.acceptance.method.webauthn');
    case 'DIGITAL_CERT':
      return context.t('mob.acceptance.method.cert');
    default:
      return context.t('mob.acceptance.method.otp');
  }
}

/// What a signature is worth, in words that do not claim a digital signature for an in-app confirmation (BR-QMS-03).
String effectLabel(BuildContext context, String effect) =>
    effect == 'LEGAL_E_SIGNATURE' ? context.t('mob.acceptance.effect.legal') : context.t('mob.acceptance.effect.internal');

String formProblemText(BuildContext context, FormProblem problem) {
  switch (problem) {
    case FormProblem.roleRequired:
      return context.t('mob.acceptance.form.roleRequired');
    case FormProblem.serialRequired:
      return context.t('mob.acceptance.form.serialRequired');
    case FormProblem.serialTooLong:
      return context.t('mob.acceptance.form.serialTooLong');
    case FormProblem.reasonRequired:
      return context.t('mob.acceptance.form.reasonRequired');
    case FormProblem.reasonTooLong:
      return context.t('mob.acceptance.form.reasonTooLong');
  }
}

/// What a refusal says; the one for missing signatures names the roles that have not signed.
String problemText(BuildContext context, AcceptanceRefusal refusal) {
  switch (refusal.problem) {
    case AcceptanceProblem.openCriticalNcr:
      return context.t('mob.acceptance.problem.openCriticalNcr');
    case AcceptanceProblem.contractState:
      return context.t('mob.acceptance.problem.contractState');
    case AcceptanceProblem.contentChanged:
      return context.t('mob.acceptance.problem.contentChanged');
    case AcceptanceProblem.acceptanceState:
      return context.t('mob.acceptance.problem.acceptanceState');
    case AcceptanceProblem.roleNotRequired:
      return context.t('mob.acceptance.problem.roleNotRequired');
    case AcceptanceProblem.alreadySigned:
      return context.t('mob.acceptance.problem.alreadySigned');
    case AcceptanceProblem.methodNotAccepted:
      return context.t('mob.acceptance.problem.methodNotAccepted');
    case AcceptanceProblem.notYourRole:
      return context.t('mob.acceptance.problem.notYourRole');
    case AcceptanceProblem.signaturesIncomplete:
      return refusal.missingRoles.isEmpty
          ? context.t('mob.acceptance.problem.signaturesIncomplete')
          : context.t('mob.acceptance.problem.signaturesMissing', <String, Object>{'roles': rolesLabel(context, refusal.missingRoles)});
    case AcceptanceProblem.selfApproval:
      return context.t('mob.acceptance.problem.selfApproval');
    case AcceptanceProblem.versionConflict:
      return context.t('mob.acceptance.problem.versionConflict');
    case AcceptanceProblem.stepUp:
      return context.t('mob.acceptance.problem.stepUp');
    case AcceptanceProblem.periodLocked:
      return context.t('mob.acceptance.problem.periodLocked');
    case AcceptanceProblem.licenseExpired:
      return context.t('mob.acceptance.problem.licenseExpired');
    case AcceptanceProblem.validation:
      return context.t('mob.acceptance.problem.validation');
    case AcceptanceProblem.notFound:
      return context.t('mob.acceptance.problem.notFound');
    case AcceptanceProblem.denied:
      return context.t('mob.acceptance.problem.denied');
    case AcceptanceProblem.sessionEnded:
      return context.t('mob.acceptance.problem.sessionEnded');
    case AcceptanceProblem.general:
      return context.t('mob.acceptance.problem.general');
  }
}
