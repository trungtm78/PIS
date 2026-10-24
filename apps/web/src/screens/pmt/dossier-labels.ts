import type { useTranslation } from '../../i18n';
import type { DossierStatus, FieldProblem, MilestoneStep, PermitProblem, PermitStatus } from './dossier-model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function permitStatusLabel(t: Translate, status: PermitStatus): string {
  switch (status) {
    case 'PLANNED':
      return t('pmt.permit.status.planned.text');
    case 'SUBMITTED':
      return t('pmt.permit.status.submitted.text');
    case 'IN_APPRAISAL':
      return t('pmt.permit.status.inAppraisal.text');
    case 'SUPPLEMENT_REQUESTED':
      return t('pmt.permit.status.supplementRequested.text');
    case 'ISSUED':
      return t('pmt.permit.status.issued.text');
    case 'REJECTED':
      return t('pmt.permit.status.rejected.text');
    case 'EXPIRED':
      return t('pmt.permit.status.expired.text');
    case 'REVOKED':
      return t('pmt.permit.status.revoked.text');
    case 'SUPERSEDED':
      return t('pmt.permit.status.superseded.text');
    case 'EXEMPTED':
      return t('pmt.permit.status.exempted.text');
  }
}

export function dossierStatusLabel(t: Translate, status: DossierStatus): string {
  switch (status) {
    case 'OPEN':
      return t('pmt.dossier.status.open.text');
    case 'COMPLETE':
      return t('pmt.dossier.status.complete.text');
    case 'CLOSED':
      return t('pmt.dossier.status.closed.text');
  }
}

/** A milestone step as a fact in the timeline. */
export function stepLabel(t: Translate, step: MilestoneStep): string {
  switch (step) {
    case 'SUBMITTED':
      return t('pmt.permit.step.submitted.text');
    case 'ACKNOWLEDGED':
      return t('pmt.permit.step.acknowledged.text');
    case 'APPRAISAL_MEETING':
      return t('pmt.permit.step.appraisalMeeting.text');
    case 'SUPPLEMENT_REQUESTED':
      return t('pmt.permit.step.supplementRequested.text');
    case 'SUPPLEMENT_SUBMITTED':
      return t('pmt.permit.step.supplementSubmitted.text');
    case 'DECISION':
      return t('pmt.permit.step.decision.text');
    case 'HANDED_OVER':
      return t('pmt.permit.step.handedOver.text');
  }
}

export function permitFieldMessage(t: Translate, problem: FieldProblem): string {
  switch (problem) {
    case 'required':
      return t('pmt.permit.field.required.error');
    case 'invalidDate':
      return t('pmt.permit.field.invalidDate.error');
    case 'future':
      return t('pmt.permit.field.future.error');
    case 'past':
      return t('pmt.permit.field.past.error');
    case 'tooLong':
      return t('pmt.permit.field.tooLong.error');
    case 'invalidId':
      return t('pmt.permit.field.invalidId.error');
    case 'dateOrder':
      return t('pmt.permit.field.dateOrder.error');
    case 'endOrExpiry':
      return t('pmt.permit.field.endOrExpiry.error');
    case 'scanRequired':
      return t('pmt.permit.field.scanRequired.error');
    case 'notAllowed':
      return t('pmt.permit.field.notAllowed.error');
  }
}

export function permitProblemMessage(t: Translate, problem: PermitProblem): string {
  switch (problem.reason) {
    case 'stateInvalid':
      return t('pmt.permit.problem.stateInvalid.error');
    case 'versionConflict':
      return t('pmt.permit.problem.versionConflict.error');
    case 'numberDuplicate':
      return t('pmt.permit.problem.numberDuplicate.error');
    case 'alreadyCurrent':
      return t('pmt.permit.problem.alreadyCurrent.error');
    case 'documentRequired':
      return t('pmt.permit.problem.documentRequired.error');
    case 'typeNotEffective':
      return t('pmt.permit.problem.typeNotEffective.error');
    case 'dossierExists':
      return t('pmt.permit.problem.dossierExists.error');
    case 'validation':
      return t('pmt.permit.problem.validation.error');
    case 'denied':
      return t('pmt.permit.problem.denied.error');
    case 'notFound':
      return t('pmt.permit.problem.notFound.error');
    case 'general':
      return t('pmt.permit.problem.general.error');
  }
}

/** The time left on a permit in words: days to go, the last day itself, days past, or no end at all. */
export function remainingText(t: Translate, days: number | null): string {
  if (days === null) return t('pmt.dossier.remaining.none.text');
  if (days === 0) return t('pmt.dossier.remaining.today.text');
  return days > 0 ? t('pmt.dossier.remaining.days.text', { days }) : t('pmt.dossier.remaining.over.text', { days: -days });
}
