import type { Translator } from '../../../i18n';
import type { DecisionProblem, ExtensionStatus, FieldProblem, ProblemView, ReasonCode } from './model';

type T = Translator['t'];

export function statusLabel(t: T, status: ExtensionStatus): string {
  switch (status) {
    case 'REQUESTED':
      return t('cap.extension.status.requested');
    case 'APPROVED':
      return t('cap.extension.status.approved');
    case 'APPLIED':
      return t('cap.extension.status.applied');
    case 'REJECTED':
      return t('cap.extension.status.rejected');
    case 'LAPSED':
      return t('cap.extension.status.lapsed');
  }
}

export function reasonCodeLabel(t: T, code: ReasonCode): string {
  switch (code) {
    case 'GPMB_CHAM':
      return t('cap.extension.reason.gpmb');
    case 'VUONG_MAC_PHAP_LY':
      return t('cap.extension.reason.legal');
    case 'THIEN_TAI_DICH_BENH':
      return t('cap.extension.reason.disaster');
    case 'KHAC':
      return t('cap.extension.reason.other');
  }
}

export function fieldProblemMessage(t: T, problem: FieldProblem, values: { undisbursed?: string; from?: string; to?: string } = {}): string {
  switch (problem) {
    case 'required':
      return t('cap.extension.fieldError.required');
    case 'notWhole':
      return t('cap.extension.fieldError.notWhole');
    case 'exceeds':
      return t('cap.extension.fieldError.exceeds', { undisbursed: values.undisbursed ?? '0' });
    case 'notDate':
      return t('cap.extension.fieldError.notDate');
    case 'tooEarly':
      return t('cap.extension.fieldError.tooEarly', { from: values.from ?? '' });
    case 'tooLate':
      return t('cap.extension.fieldError.tooLate', { to: values.to ?? '' });
    case 'justificationRequired':
      return t('cap.extension.fieldError.justificationRequired');
    case 'justificationLength':
      return t('cap.extension.fieldError.justificationLength');
  }
}

export function decisionProblemMessage(t: T, problem: DecisionProblem): string {
  switch (problem) {
    case 'required':
      return t('cap.extension.fieldError.required');
    case 'invalidId':
      return t('cap.extension.fieldError.invalidId');
    case 'reasonLength':
      return t('cap.extension.fieldError.reasonLength');
  }
}

/** Why a line cannot be carried over, in the words of the refusal (the `reason` extension of EXTENSION_NOT_ALLOWED). */
function notAllowedMessage(t: T, why: string | undefined): string {
  switch (why) {
    case 'LINE_NOT_IN_FORCE':
      return t('cap.extension.problem.notAllowed.inForce');
    case 'ALREADY_EXTENDED':
      return t('cap.extension.problem.notAllowed.extended');
    case 'PLAN_NOT_ANNUAL':
      return t('cap.extension.problem.notAllowed.annual');
    case 'NO_APPROPRIATION':
      return t('cap.extension.problem.notAllowed.appropriation');
    default:
      return t('cap.extension.problem.notAllowed.general');
  }
}

/** Why the server refused, in the words of the screen; a refusal that names a field says which. */
export function problemMessage(t: T, problem: ProblemView, formatted: { undisbursed: string }): string {
  switch (problem.reason) {
    case 'amountExceeds':
      return problem.undisbursedVnd === undefined ? t('cap.extension.problem.amountExceeds') : t('cap.extension.problem.amountExceedsLeft', { undisbursed: formatted.undisbursed });
    case 'notAllowed':
      return notAllowedMessage(t, problem.why);
    case 'documentRequired':
      return t('cap.extension.problem.documentRequired');
    case 'selfApproval':
      return t('cap.extension.problem.selfApproval');
    case 'conflict':
      return t('cap.extension.problem.conflict');
    case 'stageDenied':
      return t('cap.extension.problem.stageDenied');
    case 'yearLocked':
      return t('cap.extension.problem.yearLocked');
    case 'duplicate':
      return t('cap.extension.problem.duplicate');
    case 'invalid':
      return problem.field === undefined ? t('cap.extension.problem.invalid') : t('cap.extension.problem.invalidAt', { field: problem.field });
    case 'denied':
      return t('cap.extension.problem.denied');
    case 'notFound':
      return t('cap.extension.problem.notFound');
    case 'session':
      return t('cap.extension.problem.session');
    case 'general':
      return t('cap.extension.problem.general');
  }
}
