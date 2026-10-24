import type { useTranslation } from '../../i18n';
import type { FormProblem, GuaranteeKind, GuaranteeStatus, ProblemView } from './guarantee-model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function kindLabel(t: Translate, kind: GuaranteeKind): string {
  switch (kind) {
    case 'PERFORMANCE':
      return t('ctr.guarantee.kind.performance.label');
    case 'ADVANCE':
      return t('ctr.guarantee.kind.advance.label');
    case 'WARRANTY':
      return t('ctr.guarantee.kind.warranty.label');
    case 'INSURANCE':
      return t('ctr.guarantee.kind.insurance.label');
  }
}

export function statusLabel(t: Translate, status: GuaranteeStatus): string {
  switch (status) {
    case 'PENDING_VERIFICATION':
      return t('ctr.guarantee.status.pending.label');
    case 'ACTIVE':
      return t('ctr.guarantee.status.active.label');
    case 'EXPIRED':
      return t('ctr.guarantee.status.expired.label');
    case 'RELEASED':
      return t('ctr.guarantee.status.released.label');
    case 'CALLED':
      return t('ctr.guarantee.status.called.label');
    case 'SUPERSEDED':
      return t('ctr.guarantee.status.superseded.label');
    case 'REJECTED':
      return t('ctr.guarantee.status.rejected.label');
  }
}

/** The verification of a guarantee with its issuer; a value the screen has no word for is shown as it is. */
export function verificationLabel(t: Translate, status: string): string {
  switch (status) {
    case 'UNVERIFIED':
      return t('ctr.guarantee.verification.unverified.label');
    case 'VERIFIED':
      return t('ctr.guarantee.verification.verified.label');
    case 'FAILED':
      return t('ctr.guarantee.verification.failed.label');
    default:
      return status;
  }
}

/** The last reminder that was sent, as "30/15/7 days" thresholds reached; none yet is a dash. */
export function alertLabel(t: Translate, lastAlertDays: number | null): string {
  switch (lastAlertDays) {
    case 30:
      return t('ctr.guarantee.alert.d30.label');
    case 15:
      return t('ctr.guarantee.alert.d15.label');
    case 7:
      return t('ctr.guarantee.alert.d7.label');
    case 0:
      return t('ctr.guarantee.alert.d0.label');
    default:
      return t('ctr.guarantee.alert.none.label');
  }
}

export function windowLabel(t: Translate, days: number): string {
  switch (days) {
    case 30:
      return t('ctr.guarantee.window.d30.label');
    case 15:
      return t('ctr.guarantee.window.d15.label');
    case 7:
      return t('ctr.guarantee.window.d7.label');
    default:
      return t('ctr.guarantee.window.d0.label');
  }
}

export function formProblemMessage(t: Translate, problem: FormProblem): string {
  switch (problem) {
    case 'required':
      return t('ctr.guarantee.field.required.error');
    case 'tooLong':
      return t('ctr.guarantee.field.tooLong.error');
    case 'invalidAmount':
      return t('ctr.guarantee.field.invalidAmount.error');
    case 'zeroAmount':
      return t('ctr.guarantee.field.zeroAmount.error');
    case 'invalidId':
      return t('ctr.guarantee.field.invalidId.error');
    case 'invalidDate':
      return t('ctr.guarantee.field.invalidDate.error');
    case 'endBeforeStart':
      return t('ctr.guarantee.field.endBeforeStart.error');
    case 'notLater':
      return t('ctr.guarantee.field.notLater.error');
  }
}

/** The sentence for a refusal of a command; `format` groups an amount in VND. */
export function problemMessage(t: Translate, problem: ProblemView, format: (amount: string) => string = (amount) => amount): string {
  switch (problem.reason) {
    case 'duplicate':
      return t('ctr.guarantee.problem.duplicate.error');
    case 'selfApproval':
      return t('ctr.guarantee.problem.selfApproval.error');
    case 'stateInvalid':
      return t('ctr.guarantee.problem.stateInvalid.error');
    case 'contractState':
      return t('ctr.guarantee.problem.contractState.error');
    case 'releaseCondition':
      return problem.advanceOutstanding === undefined
        ? t('ctr.guarantee.problem.releaseConditionUnknown.error')
        : t('ctr.guarantee.problem.releaseCondition.error', { amount: format(problem.advanceOutstanding) });
    case 'versionConflict':
      return t('ctr.guarantee.problem.versionConflict.error');
    case 'validation':
      return problem.field === undefined ? t('ctr.guarantee.problem.validation.error') : t('ctr.guarantee.problem.validationField.error', { field: problem.field });
    case 'notFound':
      return t('ctr.guarantee.problem.notFound.error');
    case 'denied':
      return t('ctr.guarantee.problem.denied.error');
    case 'general':
      return t('ctr.guarantee.problem.general.error');
  }
}
