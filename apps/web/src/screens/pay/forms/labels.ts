import type { useTranslation } from '../../../i18n';
import type { FormStatus, Problem, Refusal } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function formStatusLabel(t: Translate, status: FormStatus): string {
  switch (status) {
    case 'REQUESTED':
      return t('pay.forms.status.requested');
    case 'GENERATED':
      return t('pay.forms.status.generated');
    case 'FAILED':
      return t('pay.forms.status.failed');
    case 'SUPERSEDED':
      return t('pay.forms.status.superseded');
  }
}

/** The name of a form as the accountant knows it. */
export function formName(t: Translate, code: string): string {
  switch (code) {
    case '03.a/TT':
      return t('pay.forms.name.f03a');
    case '04.a/TT':
      return t('pay.forms.name.f04a');
    case '04.b/TT':
      return t('pay.forms.name.f04b');
    case '05.a/TT':
      return t('pay.forms.name.f05a');
    default:
      return code;
  }
}

/** What a refusal says: the form it is about and the forms still lacking are named. */
export function refusalMessage(t: Translate, refusal: Refusal): string {
  const names = { form: refusal.formCode ?? '', missing: refusal.missing.join(', ') };
  switch (refusal.problem as Problem) {
    case 'unconfirmed':
      return t('pay.forms.error.unconfirmed', names);
    case 'notEffective':
      return t('pay.forms.error.notEffective', names);
    case 'formsMissing':
      return t('pay.forms.error.formsMissing', names);
    case 'paymentState':
      return t('pay.forms.error.paymentState');
    case 'unavailable':
      return t('pay.forms.error.unavailable');
    case 'versionConflict':
      return t('pay.forms.error.versionConflict');
    case 'validation':
      return t('pay.forms.error.validation');
    case 'notFound':
      return t('pay.forms.error.notFound');
    case 'denied':
      return t('pay.forms.error.denied');
    case 'session':
      return t('pay.forms.error.session');
    case 'general':
      return t('pay.forms.error.general');
  }
}
