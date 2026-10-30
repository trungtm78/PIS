import type { Translator } from '../../../i18n';
import type { CaptureMethod, ConsentChannel, ConsentProblem, ConsentPurpose, ConsentStatus, ProblemView } from './model';

type T = Translator['t'];

export function channelLabel(t: T, value: string): string {
  switch (value as ConsentChannel) {
    case 'EMAIL':
      return t('omni.consent.channel.email');
    case 'SMS':
      return t('omni.consent.channel.sms');
    case 'ZALO':
      return t('omni.consent.channel.zalo');
    case 'WHATSAPP':
      return t('omni.consent.channel.whatsapp');
    default:
      return value;
  }
}

export function purposeLabel(t: T, value: string): string {
  switch (value as ConsentPurpose) {
    case 'OPERATIONAL':
      return t('omni.consent.purpose.operational');
    case 'REMINDER':
      return t('omni.consent.purpose.reminder');
    case 'ANNOUNCEMENT':
      return t('omni.consent.purpose.announcement');
    case 'SUPPORT_CONVERSATION':
      return t('omni.consent.purpose.support');
    default:
      return value;
  }
}

export function methodLabel(t: T, value: string): string {
  switch (value as CaptureMethod) {
    case 'IN_APP':
      return t('omni.consent.method.inApp');
    case 'WEB_FORM':
      return t('omni.consent.method.webForm');
    case 'CHANNEL_OPT_IN':
      return t('omni.consent.method.optIn');
    case 'PAPER_SCANNED':
      return t('omni.consent.method.paper');
    default:
      return value;
  }
}

export function statusLabel(t: T, value: ConsentStatus): string {
  switch (value) {
    case 'Granted':
      return t('omni.consent.status.granted');
    case 'Withdrawn':
      return t('omni.consent.status.withdrawn');
    case 'Expired':
      return t('omni.consent.status.expired');
  }
}

export function formProblemMessage(t: T, problem: ConsentProblem): string {
  switch (problem) {
    case 'channel':
      return t('omni.consent.form.channel.invalid');
    case 'textVersion':
      return t('omni.consent.form.version.invalid');
    case 'evidence':
      return t('omni.consent.form.evidence.invalid');
  }
}

export function problemMessage(t: T, problem: ProblemView): string {
  switch (problem.reason) {
    case 'invalid':
      return problem.field === undefined ? t('omni.consent.problem.invalid') : t('omni.consent.problem.invalidAt', { field: problem.field });
    case 'unverified':
      return t('omni.consent.problem.unverified');
    case 'already':
      return t('omni.consent.problem.already');
    case 'state':
      return t('omni.consent.problem.state');
    case 'conflict':
      return t('omni.consent.problem.conflict');
    case 'denied':
      return t('omni.consent.problem.denied');
    case 'notFound':
      return t('omni.consent.problem.notFound');
    case 'session':
      return t('omni.consent.problem.session');
    case 'general':
      return t('omni.consent.problem.general');
  }
}
