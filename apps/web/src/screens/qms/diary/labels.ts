import type { useTranslation } from '../../../i18n';
import type { DiaryStatus, FormProblem, LegalEffect, Problem, SignatureMethod } from './model';
import { WEATHER_CODES } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function statusLabel(t: Translate, status: DiaryStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('qms.diary.status.draft');
    case 'CONTRACTOR_SIGNED':
      return t('qms.diary.status.contractorSigned');
    case 'SUPERVISED':
      return t('qms.diary.status.supervised');
    case 'OWNER_CONFIRMED':
      return t('qms.diary.status.ownerConfirmed');
    case 'LOCKED':
      return t('qms.diary.status.locked');
    case 'SUPERSEDED':
      return t('qms.diary.status.superseded');
  }
}

export function methodLabel(t: Translate, method: SignatureMethod): string {
  switch (method) {
    case 'IN_APP_OTP':
      return t('qms.diary.method.otp');
    case 'IN_APP_WEBAUTHN':
      return t('qms.diary.method.webauthn');
    case 'DIGITAL_CERT':
      return t('qms.diary.method.cert');
  }
}

/** What a signature is worth, in words that do not claim a digital signature for an in-app confirmation (BR-QMS-03). */
export function effectLabel(t: Translate, effect: LegalEffect): string {
  return effect === 'LEGAL_E_SIGNATURE' ? t('qms.diary.effect.legal') : t('qms.diary.effect.internal');
}

export function weatherLabel(t: Translate, code: string): string {
  switch (code) {
    case 'SUNNY':
      return t('qms.diary.weather.sunny');
    case 'CLOUDY':
      return t('qms.diary.weather.cloudy');
    case 'RAIN':
      return t('qms.diary.weather.rain');
    case 'HEAVY_RAIN':
      return t('qms.diary.weather.heavyRain');
    case 'STORM':
      return t('qms.diary.weather.storm');
    case 'HOT':
      return t('qms.diary.weather.hot');
    case 'COLD':
      return t('qms.diary.weather.cold');
    default:
      return code;
  }
}

export const weatherOptions = WEATHER_CODES;

export function roleLabel(t: Translate, role: 'CONTRACTOR' | 'SUPERVISOR' | 'OWNER'): string {
  switch (role) {
    case 'CONTRACTOR':
      return t('qms.diary.role.contractor');
    case 'SUPERVISOR':
      return t('qms.diary.role.supervisor');
    case 'OWNER':
      return t('qms.diary.role.owner');
  }
}

export function formProblemMessage(t: Translate, problem: FormProblem): string {
  switch (problem) {
    case 'required':
      return t('qms.diary.problem.required');
    case 'tooLong':
      return t('qms.diary.problem.tooLong');
    case 'invalidDate':
      return t('qms.diary.problem.invalidDate');
    case 'futureDate':
      return t('qms.diary.problem.futureDate');
    case 'invalidNumber':
      return t('qms.diary.problem.invalidNumber');
    case 'invalidWeather':
      return t('qms.diary.problem.invalidWeather');
    case 'certSerial':
      return t('qms.diary.problem.certSerial');
  }
}

/** What a refusal of a command says. */
export function problemMessage(t: Translate, problem: Problem): string {
  switch (problem) {
    case 'diaryState':
      return t('qms.diary.error.diaryState');
    case 'correctionOpen':
      return t('qms.diary.error.correctionOpen');
    case 'contentChanged':
      return t('qms.diary.error.contentChanged');
    case 'dayExists':
      return t('qms.diary.error.dayExists');
    case 'syncConflict':
      return t('qms.diary.error.syncConflict');
    case 'alreadySigned':
      return t('qms.diary.error.alreadySigned');
    case 'methodNotAccepted':
      return t('qms.diary.error.methodNotAccepted');
    case 'notYourRole':
      return t('qms.diary.error.notYourRole');
    case 'contractState':
      return t('qms.diary.error.contractState');
    case 'permitGate':
      return t('qms.diary.error.permitGate');
    case 'versionConflict':
      return t('qms.diary.error.versionConflict');
    case 'validation':
      return t('qms.diary.error.validation');
    case 'notFound':
      return t('qms.diary.error.notFound');
    case 'denied':
      return t('qms.diary.error.denied');
    case 'session':
      return t('qms.diary.error.session');
    case 'general':
      return t('qms.diary.error.general');
  }
}
