import type { useTranslation } from '../../../i18n';
import type { FormProblem, Problem } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function localeLabel(t: Translate, locale: string): string {
  switch (locale) {
    case 'vi-VN':
      return t('iam.profile.locale.vi');
    case 'en-US':
      return t('iam.profile.locale.en');
    default:
      return locale;
  }
}

export function platformLabel(t: Translate, platform: string | null): string {
  switch (platform) {
    case 'ios':
      return t('iam.sessions.platform.ios');
    case 'android':
      return t('iam.sessions.platform.android');
    case 'web':
      return t('iam.sessions.platform.web');
    case null:
      return t('iam.sessions.platform.none');
    default:
      return platform;
  }
}

export function assuranceLabel(t: Translate, assurance: 'aal1' | 'aal2'): string {
  return assurance === 'aal2' ? t('iam.sessions.assurance.aal2') : t('iam.sessions.assurance.aal1');
}

export function fieldLabel(t: Translate, field: 'displayName' | 'locale' | 'timeZone'): string {
  switch (field) {
    case 'displayName':
      return t('iam.profile.field.name');
    case 'locale':
      return t('iam.profile.field.locale');
    case 'timeZone':
      return t('iam.profile.field.timeZone');
  }
}

export function formProblemMessage(t: Translate, problem: FormProblem): string {
  switch (problem) {
    case 'required':
      return t('iam.profile.problem.required');
    case 'tooShort':
      return t('iam.profile.problem.tooShort');
    case 'tooLong':
      return t('iam.profile.problem.tooLong');
    case 'invalidPhone':
      return t('iam.profile.problem.invalidPhone');
  }
}

export function problemMessage(t: Translate, problem: Problem): string {
  switch (problem) {
    case 'versionConflict':
      return t('iam.self.error.versionConflict');
    case 'currentSession':
      return t('iam.self.error.currentSession');
    case 'validation':
      return t('iam.self.error.validation');
    case 'notFound':
      return t('iam.self.error.notFound');
    case 'denied':
      return t('iam.self.error.denied');
    case 'general':
      return t('iam.self.error.general');
  }
}
