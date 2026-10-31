import type { Translator } from '../../../i18n';
import type { FormProblem, Reason, Refusal, Step } from './model';

type T = Translator['t'];

export function stepLabel(t: T, step: Step): string {
  switch (step) {
    case 'PERSUASION':
      return t('lnd.enforcement.step.persuasion');
    case 'NOTICE':
      return t('lnd.enforcement.step.notice');
    case 'ORGANIZATION_DECISION':
      return t('lnd.enforcement.step.organization');
    case 'ENFORCEMENT_DECISION':
      return t('lnd.enforcement.step.decision');
    case 'EXECUTING':
      return t('lnd.enforcement.step.executing');
    case 'COMPLETED':
      return t('lnd.enforcement.step.completed');
    case 'SUSPENDED':
      return t('lnd.enforcement.step.suspended');
  }
}

function reasonLabel(t: T, reason: Reason | undefined): string {
  switch (reason) {
    case 'PARCEL_STATUS':
      return t('lnd.enforcement.reason.parcel');
    case 'RECOVERY_DECISION_MISSING':
      return t('lnd.enforcement.reason.decision');
    case 'PLAN_NOT_APPROVED':
      return t('lnd.enforcement.reason.plan');
    case 'HOUSEHOLD_NOT_ON_PARCEL':
      return t('lnd.enforcement.reason.household');
    case 'NO_PLAN_OR_HOUSEHOLD':
      return t('lnd.enforcement.reason.nobody');
    case 'PLAN_DOES_NOT_COVER_PARCEL':
      return t('lnd.enforcement.reason.cover');
    case 'NOT_PAID_OR_DEPOSITED':
      return t('lnd.enforcement.reason.unpaid');
    case undefined:
      return t('lnd.enforcement.reason.unknown');
  }
}

export function refusalLabel(t: T, refusal: Refusal): string {
  switch (refusal.problem) {
    case 'precondition':
      return t('lnd.enforcement.problem.precondition', { reason: reasonLabel(t, refusal.reason) });
    case 'paymentNotOffered':
      return t('lnd.enforcement.problem.paymentNotOffered', { reason: reasonLabel(t, refusal.reason) });
    case 'caseExists':
      return t('lnd.enforcement.problem.caseExists');
    case 'stepInvalid':
      return t('lnd.enforcement.problem.stepInvalid');
    case 'documentRequired':
      return t('lnd.enforcement.problem.documentRequired');
    case 'selfApproval':
      return t('lnd.enforcement.problem.selfApproval');
    case 'versionConflict':
      return t('lnd.enforcement.problem.versionConflict');
    case 'scopeDenied':
      return t('lnd.enforcement.problem.scopeDenied');
    case 'notFound':
      return t('lnd.enforcement.problem.notFound');
    case 'validation':
      return t('lnd.enforcement.problem.validation');
    case 'general':
      return t('lnd.enforcement.problem.general');
  }
}

export function fieldLabel(t: T, problem: FormProblem | undefined): string | undefined {
  switch (problem) {
    case undefined:
      return undefined;
    case 'required':
      return t('lnd.enforcement.field.required.error');
    case 'invalid':
      return t('lnd.enforcement.field.invalid.error');
    case 'future':
      return t('lnd.enforcement.field.future.error');
  }
}
