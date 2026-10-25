import type { useTranslation } from '../../../i18n';
import type { AcceptanceScope, AcceptanceStatus, Decision, FormProblem, LegalEffect, ProblemView, SignatureMethod } from './model';
import { roleLabel } from '../inspection/labels';

type Translate = ReturnType<typeof useTranslation>['t'];

export function scopeLabel(t: Translate, scope: AcceptanceScope): string {
  switch (scope) {
    case 'WORK_ITEM':
      return t('qms.acceptance.scope.workItem');
    case 'STAGE':
      return t('qms.acceptance.scope.stage');
    case 'PART':
      return t('qms.acceptance.scope.part');
    case 'COMPLETION':
      return t('qms.acceptance.scope.completion');
  }
}

export function statusLabel(t: Translate, status: AcceptanceStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('qms.acceptance.status.draft');
    case 'SIGNING':
      return t('qms.acceptance.status.signing');
    case 'APPROVED':
      return t('qms.acceptance.status.approved');
    case 'REJECTED':
      return t('qms.acceptance.status.rejected');
    case 'REVOKED':
      return t('qms.acceptance.status.revoked');
  }
}

export function methodLabel(t: Translate, method: SignatureMethod): string {
  switch (method) {
    case 'IN_APP_OTP':
      return t('qms.acceptance.method.otp');
    case 'IN_APP_WEBAUTHN':
      return t('qms.acceptance.method.webauthn');
    case 'DIGITAL_CERT':
      return t('qms.acceptance.method.cert');
  }
}

/** What a signature is worth, in words that do not claim a digital signature for an in-app confirmation (BR-QMS-03). */
export function effectLabel(t: Translate, effect: LegalEffect): string {
  switch (effect) {
    case 'INTERNAL_RECORD':
      return t('qms.acceptance.effect.internal');
    case 'LEGAL_E_SIGNATURE':
      return t('qms.acceptance.effect.legal');
  }
}

export function decisionLabel(t: Translate, decision: Decision): string {
  switch (decision) {
    case 'approve':
      return t('qms.acceptance.decision.approve');
    case 'reject':
      return t('qms.acceptance.decision.reject');
  }
}

export function formProblemMessage(t: Translate, problem: FormProblem): string {
  switch (problem) {
    case 'required':
      return t('qms.acceptance.problem.required');
    case 'uuid':
      return t('qms.acceptance.problem.uuid');
    case 'tooLong':
      return t('qms.acceptance.problem.tooLong');
    case 'certSerial':
      return t('qms.acceptance.problem.certSerial');
  }
}

/** What a refusal of a command says; the one for missing signatures names the roles that have not signed. */
export function problemMessage(t: Translate, view: ProblemView): string {
  switch (view.problem) {
    case 'inspectionNotPassed':
      return t('qms.acceptance.error.inspectionNotPassed');
    case 'openCriticalNcr':
      return t('qms.acceptance.error.openCriticalNcr');
    case 'contractState':
      return t('qms.acceptance.error.contractState');
    case 'alreadyDrafted':
      return t('qms.acceptance.error.alreadyDrafted');
    case 'recordNoUsed':
      return t('qms.acceptance.error.recordNoUsed');
    case 'contentChanged':
      return t('qms.acceptance.error.contentChanged');
    case 'acceptanceState':
      return t('qms.acceptance.error.acceptanceState');
    case 'roleNotRequired':
      return t('qms.acceptance.error.roleNotRequired');
    case 'alreadySigned':
      return t('qms.acceptance.error.alreadySigned');
    case 'methodNotAccepted':
      return t('qms.acceptance.error.methodNotAccepted');
    case 'notYourRole':
      return t('qms.acceptance.error.notYourRole');
    case 'signaturesIncomplete':
      return view.missingRoles.length === 0 ? t('qms.acceptance.error.signaturesIncomplete') : t('qms.acceptance.error.signaturesMissing', { roles: view.missingRoles.map((role) => roleLabel(t, role)).join(', ') });
    case 'selfApproval':
      return t('qms.acceptance.error.selfApproval');
    case 'alreadyUsed':
      return t('qms.acceptance.error.alreadyUsed');
    case 'versionConflict':
      return t('qms.acceptance.error.versionConflict');
    case 'validation':
      return t('qms.acceptance.error.validation');
    case 'notFound':
      return t('qms.acceptance.error.notFound');
    case 'denied':
      return t('qms.acceptance.error.denied');
    case 'session':
      return t('qms.acceptance.error.session');
    case 'general':
      return t('qms.acceptance.error.general');
  }
}
