import type { Translator } from '../../../i18n';
import type { OverrideFieldProblem, OverrideProblem, OverrideStatus } from './model';

type T = Translator['t'];

export function overrideStatusLabel(t: T, status: OverrideStatus): string {
  switch (status) {
    case 'PendingApproval':
      return t('sas.overrides.status.pending');
    case 'Active':
      return t('sas.overrides.status.active');
    case 'Revoked':
      return t('sas.overrides.status.revoked');
    case 'Expired':
      return t('sas.overrides.status.expired');
    case 'Rejected':
      return t('sas.overrides.status.rejected');
  }
}

export function overrideStatusTone(status: OverrideStatus): 'ok' | 'warn' | 'red' | 'gray' {
  switch (status) {
    case 'Active':
      return 'ok';
    case 'PendingApproval':
      return 'warn';
    case 'Rejected':
      return 'red';
    case 'Revoked':
    case 'Expired':
      return 'gray';
  }
}

export function overrideFieldMessage(t: T, problem: OverrideFieldProblem | undefined): string {
  switch (problem) {
    case 'required':
      return t('sas.overrides.fieldError.required');
    case 'notDateTime':
      return t('sas.overrides.fieldError.notDateTime');
    case 'notNumber':
      return t('sas.overrides.fieldError.notNumber');
    case 'limitNeedsEnabled':
      return t('sas.overrides.fieldError.limitNeedsEnabled');
    case 'windowInvalid':
      return t('sas.overrides.fieldError.windowInvalid');
    case 'alreadyEnded':
      return t('sas.overrides.fieldError.alreadyEnded');
    case 'tooLong':
      return t('sas.overrides.fieldError.tooLong');
    case 'tooFarAhead':
      return t('sas.overrides.fieldError.tooFarAhead');
    case 'reasonLength':
      return t('sas.overrides.fieldError.reasonLength');
    case undefined:
      return '';
  }
}

/** Why the server refused, in the words of the panel; a refusal that names a field says which. */
export function overrideProblemMessage(t: T, problem: OverrideProblem): string {
  switch (problem.reason) {
    case 'selfApproval':
      return t('sas.overrides.problem.selfApproval');
    case 'featureUnknown':
      return t('sas.overrides.problem.featureUnknown');
    case 'stageDenied':
      return t('sas.overrides.problem.stageDenied');
    case 'conflict':
      return t('sas.overrides.problem.conflict');
    case 'invalid':
      return problem.field === undefined ? t('sas.overrides.problem.invalid') : t('sas.overrides.problem.invalidAt', { field: problem.field });
    case 'denied':
      return t('sas.overrides.problem.denied');
    case 'notFound':
      return t('sas.overrides.problem.notFound');
    case 'session':
      return t('sas.overrides.problem.session');
    case 'general':
      return t('sas.overrides.problem.general');
  }
}

export type OverrideAction = 'approve' | 'reject' | 'revoke';

export function decisionTitle(t: T, action: OverrideAction, feature: string): string {
  switch (action) {
    case 'approve':
      return t('sas.overrides.decision.title.approve', { feature });
    case 'reject':
      return t('sas.overrides.decision.title.reject', { feature });
    case 'revoke':
      return t('sas.overrides.decision.title.revoke', { feature });
  }
}

export function decisionConfirm(t: T, action: OverrideAction): string {
  switch (action) {
    case 'approve':
      return t('sas.overrides.decision.confirm.approve');
    case 'reject':
      return t('sas.overrides.decision.confirm.reject');
    case 'revoke':
      return t('sas.overrides.decision.confirm.revoke');
  }
}

export function doneNotice(t: T, notice: 'requested' | OverrideAction): string {
  switch (notice) {
    case 'requested':
      return t('sas.overrides.done.requested');
    case 'approve':
      return t('sas.overrides.done.approved');
    case 'reject':
      return t('sas.overrides.done.rejected');
    case 'revoke':
      return t('sas.overrides.done.revoked');
  }
}
