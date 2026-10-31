import type { useTranslation } from '../../../i18n';
import type { FormProblem, FormStatus, Refusal, Stage } from './forms-model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function formStatusLabel(t: Translate, status: FormStatus): string {
  switch (status) {
    case 'REQUESTED':
      return t('pay.sform.status.requested');
    case 'GENERATED':
      return t('pay.sform.status.generated');
    case 'FAILED':
      return t('pay.sform.status.failed');
    case 'SUPERSEDED':
      return t('pay.sform.status.superseded');
  }
}

export function stageLabel(t: Translate, stage: Stage): string {
  switch (stage) {
    case 'OVERDUE':
      return t('pay.sform.stage.overdue');
    case 'T7':
      return t('pay.sform.stage.t7');
    case 'T30':
      return t('pay.sform.stage.t30');
    case 'LATER':
      return t('pay.sform.stage.later');
  }
}

export function formProblemLabel(t: Translate, problem: FormProblem): string {
  switch (problem) {
    case 'codes':
      return t('pay.sform.problem.codes');
    case 'place':
      return t('pay.sform.problem.place');
    case 'placeLong':
      return t('pay.sform.problem.placeLong');
  }
}

/** What a refusal of the server says; the form it names is told with it. */
export function refusalLabel(t: Translate, refusal: Refusal): string {
  const form = refusal.formCode ?? '';
  switch (refusal.problem) {
    case 'templateUnconfirmed':
      return t('pay.sform.error.templateUnconfirmed', { form });
    case 'templateNotEffective':
      return t('pay.sform.error.templateNotEffective', { form });
    case 'stateInvalid':
      return t('pay.sform.error.stateInvalid');
    case 'validation':
      return t('pay.sform.error.validation');
    case 'unavailable':
      return t('pay.sform.error.unavailable');
    case 'notFound':
      return t('pay.sform.error.notFound');
    case 'denied':
      return t('pay.sform.error.denied');
    case 'session':
      return t('pay.sform.error.session');
    case 'general':
      return t('pay.sform.error.general');
  }
}
