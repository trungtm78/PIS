import type { useTranslation } from '../../i18n';
import type { CommandProblem, FormProblem, LandUseGroup, NoticeState, ParcelStatus, TimerCode } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function landUseLabel(t: Translate, group: LandUseGroup): string {
  switch (group) {
    case 'AGRICULTURAL':
      return t('lnd.landUse.agricultural.label');
    case 'NON_AGRICULTURAL_RESIDENTIAL':
      return t('lnd.landUse.nonAgriculturalResidential.label');
    case 'NON_AGRICULTURAL_OTHER':
      return t('lnd.landUse.nonAgriculturalOther.label');
    case 'PUBLIC':
      return t('lnd.landUse.public.label');
  }
}

export function parcelStatusLabel(t: Translate, status: ParcelStatus): string {
  switch (status) {
    case 'SURVEYED':
      return t('lnd.parcelStatus.surveyed.label');
    case 'INVENTORIED':
      return t('lnd.parcelStatus.inventoried.label');
    case 'PLAN_DRAFTED':
      return t('lnd.parcelStatus.planDrafted.label');
    case 'PLAN_POSTED':
      return t('lnd.parcelStatus.planPosted.label');
    case 'PLAN_APPROVED':
      return t('lnd.parcelStatus.planApproved.label');
    case 'PAID':
      return t('lnd.parcelStatus.paid.label');
    case 'HANDED_OVER':
      return t('lnd.parcelStatus.handedOver.label');
    case 'DISPUTED':
      return t('lnd.parcelStatus.disputed.label');
    case 'ENFORCEMENT':
      return t('lnd.parcelStatus.enforcement.label');
  }
}

export function timerLabel(t: Translate, code: TimerCode): string {
  switch (code) {
    case 'NOTICE_AGRICULTURAL_90':
      return t('lnd.timer.noticeAgricultural90.label');
    case 'NOTICE_NON_AGRICULTURAL_180':
      return t('lnd.timer.noticeNonAgricultural180.label');
    case 'PLAN_POSTING_30':
      return t('lnd.timer.planPosting30.label');
    case 'PAYMENT_30':
      return t('lnd.timer.payment30.label');
    case 'COMPLAINT_RESOLUTION':
      return t('lnd.timer.complaintResolution.label');
  }
}

/** The words for the state of a notice on a day; the days left are said in words and never by colour alone. */
export function noticeStateLabel(t: Translate, state: NoticeState): string {
  switch (state.kind) {
    case 'NONE':
      return t('lnd.notice.none.label');
    case 'RUNNING':
      return t('lnd.notice.running.label', { days: state.daysLeft });
    case 'ELAPSED':
      return t('lnd.notice.elapsed.label');
    case 'SATISFIED':
      return t('lnd.notice.satisfied.label');
    case 'BREACHED':
      return t('lnd.notice.breached.label');
    case 'CANCELLED':
      return t('lnd.notice.cancelled.label');
  }
}

export function formProblemMessage(t: Translate, problem: FormProblem): string {
  switch (problem) {
    case 'required':
      return t('lnd.field.required.error');
    case 'tooLong':
      return t('lnd.field.tooLong.error');
    case 'invalid':
      return t('lnd.field.invalid.error');
    case 'future':
      return t('lnd.field.future.error');
  }
}

/** The sentence for a refusal of a command; a problem the screen has no sentence for is the general one. */
export function commandProblemMessage(t: Translate, problem: CommandProblem): string {
  switch (problem) {
    case 'codeDuplicate':
      return t('lnd.problem.codeDuplicate.error');
    case 'areaInvalid':
      return t('lnd.problem.areaInvalid.error');
    case 'ruleUnconfirmed':
      return t('lnd.problem.ruleUnconfirmed.error');
    case 'stateInvalid':
      return t('lnd.problem.stateInvalid.error');
    case 'documentNotClean':
      return t('lnd.problem.documentNotClean.error');
    case 'masterNotEffective':
      return t('lnd.problem.masterNotEffective.error');
    case 'versionConflict':
      return t('lnd.problem.versionConflict.error');
    case 'validation':
      return t('lnd.problem.validation.error');
    case 'notFound':
      return t('lnd.problem.notFound.error');
    case 'denied':
      return t('lnd.problem.denied.error');
    case 'general':
      return t('lnd.problem.general.error');
  }
}
