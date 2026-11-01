import type { useTranslation } from '../../../i18n';
import type { FormProblem, PreflightFlag, Problem } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function formProblemMessage(t: Translate, problem: FormProblem): string {
  switch (problem) {
    case 'required':
      return t('qms.capture.error.required');
    case 'tooLong':
      return t('qms.capture.error.tooLong');
    case 'notImage':
      return t('qms.capture.error.notImage');
    case 'tooLarge':
      return t('qms.capture.error.tooLarge');
    case 'invalidId':
      return t('qms.capture.error.invalidId');
  }
}

export function preflightMessage(t: Translate, flag: PreflightFlag): string {
  switch (flag) {
    case 'DUPLICATE_SAME_SITE':
      return t('qms.capture.preflight.duplicate');
    case 'PLACE_NOT_KEPT':
      return t('qms.capture.preflight.placeNotKept');
  }
}

export function problemMessage(t: Translate, problem: Problem): string {
  switch (problem) {
    case 'consentRequired':
      return t('qms.capture.refusal.consentRequired');
    case 'fileNotClean':
      return t('qms.capture.refusal.fileNotClean');
    case 'hashMismatch':
      return t('qms.capture.refusal.hashMismatch');
    case 'notFound':
      return t('qms.capture.refusal.notFound');
    case 'validation':
      return t('qms.capture.refusal.validation');
    case 'denied':
      return t('qms.capture.refusal.denied');
    case 'session':
      return t('qms.capture.refusal.session');
    case 'general':
      return t('qms.capture.refusal.general');
  }
}
