import type { useTranslation } from '../../../i18n';
import { problemMessage as baseProblemMessage } from '../change/labels';
import type { Problem } from '../change/model';
import { quantityText } from './model';
import type { Decision, FormProblem, MeasurementProblemView, MeasurementStatus } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function statusLabel(t: Translate, status: MeasurementStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('ctr.measurement.status.draft');
    case 'SUBMITTED':
      return t('ctr.measurement.status.submitted');
    case 'APPROVED':
      return t('ctr.measurement.status.approved');
    case 'REJECTED':
      return t('ctr.measurement.status.rejected');
    case 'SUPERSEDED':
      return t('ctr.measurement.status.superseded');
  }
}

export function decisionLabel(t: Translate, decision: Decision): string {
  switch (decision) {
    case 'approve':
      return t('ctr.measurement.decision.approve');
    case 'return':
      return t('ctr.measurement.decision.return');
    case 'reject':
      return t('ctr.measurement.decision.reject');
  }
}

export function decisionSubmitLabel(t: Translate, decision: Decision): string {
  switch (decision) {
    case 'approve':
      return t('ctr.measurement.submit.approve');
    case 'return':
      return t('ctr.measurement.submit.return');
    case 'reject':
      return t('ctr.measurement.submit.reject');
  }
}

export function formProblemMessage(t: Translate, problem: FormProblem | 'choose'): string {
  switch (problem) {
    case 'required':
      return t('ctr.measurement.problem.required');
    case 'tooLong':
      return t('ctr.measurement.problem.tooLong');
    case 'quantity':
      return t('ctr.measurement.problem.quantity');
    case 'positive':
      return t('ctr.measurement.problem.positive');
    case 'uuid':
      return t('ctr.measurement.problem.uuid');
    case 'tooMany':
      return t('ctr.measurement.problem.tooMany');
    case 'choose':
      return t('ctr.measurement.problem.choose');
  }
}

/** The refusal of the server in words; where it said what is left of the quantity of the item, the sentence says it. */
export function measurementProblemMessage(t: Translate, view: MeasurementProblemView, locale: string): string {
  switch (view.problem) {
    case 'exceeds':
      return view.remaining === undefined ? t('ctr.measurement.error.exceeds') : t('ctr.measurement.error.exceedsLeft', { remaining: quantityText(view.remaining, locale) });
    case 'decrease':
      return t('ctr.measurement.error.decrease');
    case 'duplicateReference':
      return t('ctr.measurement.error.duplicateReference');
    case 'revisionNotEffective':
      return t('ctr.measurement.error.revisionNotEffective');
    case 'permitGate':
      return t('ctr.measurement.error.permitGate');
    case 'inAcceptance':
      return t('ctr.measurement.error.inAcceptance');
    case 'evidenceRequired':
      return t('ctr.measurement.error.evidenceRequired');
    case 'periodTaken':
      return t('ctr.measurement.error.periodTaken');
    case 'measurementState':
      return t('ctr.measurement.error.measurementState');
    default:
      return baseProblemMessage(t, { problem: view.problem as Problem, stage: undefined });
  }
}
